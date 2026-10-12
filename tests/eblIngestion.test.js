import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { handleRequest } from '../src/app/server.js';
import { resetStore } from '../src/app/store.js';

function request(method, path, body = null) {
  return new Promise((resolve) => {
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port: 8083,
      path,
      headers: body ? { 'Content-Type': 'application/json' } : {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

test('BE-14: eBL Document Ingestion Tests', async (t) => {
  const server = http.createServer(handleRequest);
  await new Promise(res => server.listen(8083, res));

  try {
    resetStore();

    await t.test('POST /api/ebl/upload accepts valid PDF document', async () => {
      const res = await request('POST', '/api/ebl/upload', {
        file: {
          name: 'bill_of_lading.pdf',
          type: 'application/pdf',
          size: 102400,
          content: 'mock-pdf-content'
        },
        case_id: 'CASE-EBL-2026-TEST'
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.ok, true);
      assert.ok(res.data.document.documentId);
      assert.ok(res.data.document.documentHash);
      // The mock ENI only acknowledges receipt; it verifies nothing.
      assert.strictEqual(res.data.document.status, 'received');
      assert.strictEqual(res.data.document.mode, 'mock');
      assert.strictEqual(res.data.document.eniNetwork, 'mock');
      assert.strictEqual(res.data.document.content_hashed, true);
      assert.strictEqual(res.data.eni_mode, 'mock');
    });

    await t.test('POST /api/ebl/upload rejects invalid file type', async () => {
      const res = await request('POST', '/api/ebl/upload', {
        file: {
          name: 'document.exe',
          type: 'application/x-msdownload',
          size: 1024
        }
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.data.ok, false);
      assert.ok(res.data.error.includes('Invalid file type'));
    });

    await t.test('POST /api/ebl/upload rejects oversized file', async () => {
      const res = await request('POST', '/api/ebl/upload', {
        file: {
          name: 'large.pdf',
          type: 'application/pdf',
          size: 11 * 1024 * 1024 // 11MB
        }
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.data.ok, false);
      assert.ok(res.data.error.includes('exceeds 10MB limit'));
    });

    await t.test('POST /api/ebl/upload is idempotent for same file', async () => {
      const file = {
        name: 'invoice.pdf',
        type: 'application/pdf',
        size: 50000,
        content: 'identical-content'
      };

      const res1 = await request('POST', '/api/ebl/upload', { file });
      const res2 = await request('POST', '/api/ebl/upload', { file });

      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res2.status, 200);
      assert.strictEqual(res1.data.document.documentHash, res2.data.document.documentHash);
    });

    await t.test('metadata-only uploads are hashed deterministically and flagged as not content-hashed', async () => {
      const file = { name: 'bl.pdf', type: 'application/pdf', size: 1234 };
      const a = await request('POST', '/api/ebl/upload', { file });
      const b = await request('POST', '/api/ebl/upload', { file });
      assert.strictEqual(a.data.document.content_hashed, false);
      assert.strictEqual(a.data.document.documentHash, b.data.document.documentHash, 'no Date.now() in the hash');
      assert.match(a.data.document.documentHash, /^[0-9a-f]{64}$/u);
      const other = await request('POST', '/api/ebl/upload', { file: { ...file, size: 1235 } });
      assert.notStrictEqual(a.data.document.documentHash, other.data.document.documentHash);
    });

    await t.test('GET /api/ebl/document-status reports receipt, not verification', async () => {
      const uploadRes = await request('POST', '/api/ebl/upload', {
        file: {
          name: 'insurance.pdf',
          type: 'application/pdf',
          size: 30000
        }
      });

      const docId = uploadRes.data.document.documentId;
      const statusRes = await request('GET', `/api/ebl/document-status?document_id=${docId}`);

      assert.strictEqual(statusRes.status, 200);
      assert.strictEqual(statusRes.data.ok, true);
      assert.strictEqual(statusRes.data.status, 'received');
      assert.strictEqual(statusRes.data.mode, 'mock');
      assert.ok(statusRes.data.receivedAt);
      assert.strictEqual(statusRes.data.verifiedAt, undefined);
    });

    await t.test('POST /api/ebl/upload validates the file envelope', async () => {
      const cases = {
        'file is a string': { file: 'a.pdf' },
        'file is an array': { file: [] },
        'name missing': { file: { type: 'application/pdf', size: 10 } },
        'name only control characters': { file: { name: '\u0000\u0007', type: 'application/pdf', size: 10 } },
        'size missing': { file: { name: 'a.pdf', type: 'application/pdf' } },
        'size is a string': { file: { name: 'a.pdf', type: 'application/pdf', size: '10' } },
        'size negative': { file: { name: 'a.pdf', type: 'application/pdf', size: -1 } },
        'content is an object': { file: { name: 'a.pdf', type: 'application/pdf', size: 1, content: {} } }
      };
      for (const [label, body] of Object.entries(cases)) {
        const res = await request('POST', '/api/ebl/upload', body);
        assert.strictEqual(res.status, 400, label);
        assert.strictEqual(res.data.ok, false, label);
        assert.strictEqual(res.data.code, 'invalid_document', label);
      }
    });

    await t.test('uploaded file names are reduced to a safe base name', async () => {
      const res = await request('POST', '/api/ebl/upload', {
        file: { name: 'C:\\Users\\x\\..\\..\\secret\u0000.pdf', type: 'application/pdf', size: 10 }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.document.fileName, 'secret.pdf');
    });

    await t.test('GET /api/ebl/document-status only knows documents it issued', async () => {
      const unknown = await request('GET', '/api/ebl/document-status?document_id=ENI-DOC-0-doesnotexist');
      assert.strictEqual(unknown.status, 404);
      assert.strictEqual(unknown.data.code, 'document_not_found');

      const missing = await request('GET', '/api/ebl/document-status');
      assert.strictEqual(missing.status, 400);
    });

    // The orchestrator is not wired to uploads yet (plan WP2.1/WP2.4). Until then this only
    // records the document-to-case link, and must not claim anything more.
    await t.test('POST /api/ebl/upload records the case link without claiming orchestration', async () => {
      const res = await request('POST', '/api/ebl/upload', {
        file: {
          name: 'complete_ebl.pdf',
          type: 'application/pdf',
          size: 75000
        },
        case_id: 'CASE-EBL-2026-ORCHESTRATE'
      });

      assert.strictEqual(res.status, 200);
      assert.ok(res.data.document.documentId);
      const { storeState } = await import('../src/app/store.js');
      const link = storeState.eblDocuments.get(res.data.document.documentId);
      assert.strictEqual(link.caseId, 'CASE-EBL-2026-ORCHESTRATE');
      assert.strictEqual('orchestrationTriggered' in link, false);
    });

  } finally {
    server.close();
  }
});
