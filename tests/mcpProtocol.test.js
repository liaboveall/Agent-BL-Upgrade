import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assertPaidReportEnvelope } from '../src/x402/paidReport.js';
import { createRevealProof } from '../src/mystery/fairness.js';
import { createServer, setAgentService, closeActivityStreams, copilotService } from '../src/app/server.js';
import { listen } from './helpers/http.js';
import { phase5Runtime, copper, riskDecision } from './helpers/phase5.js';
import { assertPricingQuote } from '../src/core/pricingSchema.js';
import { fetchPaidIntel } from '../src/x402/client.js';
import fs from 'node:fs/promises';
import os from 'node:os';

function parseTool(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content.find((item) => item.type === 'text').text);
}

test('MCP/WP6: official SDK stdio lifecycle executes 14 tools + reads 5 resources against the shared backend', async (t) => {
  const { service } = await phase5Runtime(t);
  setAgentService(service);
  const decision = await riskDecision(service);
  const previousToken = process.env.MCP_HUMAN_APPROVAL_TOKEN;
  const previousRuntime = process.env.AGENTBL_RUNTIME_DIR;
  const previousLlm = process.env.LLM_PROXY_ENABLED;
  const temporaryRuntime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-phase6-sdk-'));
  process.env.AGENTBL_RUNTIME_DIR = temporaryRuntime;
  process.env.LLM_PROXY_ENABLED = 'false';
  process.env.MCP_HUMAN_APPROVAL_TOKEN = 'test-only-operator-approval';
  t.after(async () => {
    if (previousToken === undefined) delete process.env.MCP_HUMAN_APPROVAL_TOKEN;
    else process.env.MCP_HUMAN_APPROVAL_TOKEN = previousToken;
    if (previousRuntime === undefined) delete process.env.AGENTBL_RUNTIME_DIR;
    else process.env.AGENTBL_RUNTIME_DIR = previousRuntime;
    if (previousLlm === undefined) delete process.env.LLM_PROXY_ENABLED;
    else process.env.LLM_PROXY_ENABLED = previousLlm;
    closeActivityStreams(); copilotService.closeStreams(); setAgentService(null);
    await fs.rm(temporaryRuntime, { recursive: true, force: true });
  });
  const app = await listen(createServer());
  t.after(() => app.close());
  const client = new Client({ name: 'agentbl-protocol-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('src/mcp/standalone-server.js')],
    cwd: process.cwd(),
    env: { NODE_TEST_CONTEXT: 'mcp-offline-test', DEMO_MODE: 'true', X402_MODE: 'demo', LLM_PROXY_ENABLED: 'false', SIGNER_KEYS_STRICT: 'true', AGENTBL_MCP_API_URL: app.base },
    stderr: 'pipe'
  });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 14);
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'delegate_pricing',
      'explain_decision',
      'generate_pricing_quote',
      'get_agent_status',
      'get_trade_case',
      'list_agent_decisions',
      'preview_mystery_voyage',
      'purchase_premium_analysis',
      'recommend_trade_assets',
      'search_knowledge_base',
      'simulate_offering',
      'submit_agent_event',
      'verify_mystery_reveal',
      'verify_trade_documents'
    ]);
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.description);
    }

    const caseId = 'CASE-EBL-2026-0001';
    const tradeCase = parseTool(await client.callTool({ name: 'get_trade_case', arguments: { case_id: caseId } }));
    assert.equal(tradeCase.result.case_id, caseId);
    const quote = parseTool(await client.callTool({ name: 'generate_pricing_quote', arguments: { case_id: caseId } }));
    assert.ok(quote.result.final_issue_price_usd > 0);
    const simulation = parseTool(await client.callTool({ name: 'simulate_offering', arguments: { case_id: caseId } }));
    assert.ok(simulation.result.steps.length > 0);
    const search = parseTool(await client.callTool({
      name: 'search_knowledge_base',
      arguments: { query: 'copper shipping risk', limit: 2 }
    }));
    assert.ok(search.result.matches.length > 0);
    const documents = parseTool(await client.callTool({ name: 'verify_trade_documents', arguments: { case_id: caseId } }));
    assert.ok(Array.isArray(documents.result.checks));
    const purchase = parseTool(await client.callTool({
      name: 'purchase_premium_analysis',
      arguments: { case_id: caseId, kind: 'fraud-review', mode: 'demo' }
    }));
    assert.equal(purchase.result.payment.challenged, true);
    assertPaidReportEnvelope(purchase.result.report);
    const preview = parseTool(await client.callTool({
      name: 'preview_mystery_voyage',
      arguments: { wallet_address: '0x1111111111111111111111111111111111111111', case_id: 'CASE-EBL-2026-0001', budget_usdc: 0.001 }
    }));
    assert.equal(preview.result.authorization.payment_authorized, false);
    const proof = createRevealProof({
      reveal_id: 'stdio-mcp-reveal',
      round_id: 'stdio-mcp-round',
      risk_passport_hash: `0x${'11'.repeat(32)}`,
      candidates: [{ pool_id: 'pool-a', quote_hash: `0x${'22'.repeat(32)}`, weight: 1 }],
      server_secret: `0x${'33'.repeat(32)}`,
      user_nonce: `0x${'44'.repeat(32)}`,
      payment_tx_hash: `0x${'55'.repeat(32)}`,
      wallet_address: '0x1111111111111111111111111111111111111111',
      created_at: '2026-07-23T08:00:00.000Z',
      expires_at: '2026-07-23T08:10:00.000Z'
    });
    const verified = parseTool(await client.callTool({
      name: 'verify_mystery_reveal',
      arguments: { proof }
    }));
    assert.equal(verified.result.valid, true);

    const status = parseTool(await client.callTool({ name: 'get_agent_status' }));
    assert.equal(status.result.running, true);
    assert.equal(status.result.mode, 'demo');
    const decisions = parseTool(await client.callTool({ name: 'list_agent_decisions', arguments: { case_id: copper.case_id, limit: 1 } }));
    assert.equal(decisions.result.decisions[0].decision_id, decision.decision_id);
    const explained = parseTool(await client.callTool({ name: 'explain_decision', arguments: { decision_id: decision.decision_id } }));
    assert.equal(explained.result.decision.action, decision.action);
    assert.equal(explained.result.recomputed, false);
    const eventsBefore = service.bus.status().counts;
    const operatorEvent = { type: 'CARGO_DEPARTED', case_id: copper.case_id, event_id: 'phase6-sdk-event', data: {} };
    const dryRun = parseTool(await client.callTool({ name: 'submit_agent_event', arguments: { event: operatorEvent } }));
    assert.equal(dryRun.result.submitted, false);
    assert.deepEqual(service.bus.status().counts, eventsBefore);
    const denied = await client.callTool({ name: 'submit_agent_event', arguments: { event: operatorEvent, dry_run: false, approved: true, approval_token: 'wrong' } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /invalid_human_approval/u);
    const submitted = parseTool(await client.callTool({ name: 'submit_agent_event', arguments: {
      event: operatorEvent, dry_run: false, approved: true, approval_token: 'test-only-operator-approval' } }));
    assert.equal(submitted.result.submitted, true);
    await service.waitFor(submitted.result.idempotency_key);
    const duplicate = parseTool(await client.callTool({ name: 'submit_agent_event', arguments: {
      event: operatorEvent, dry_run: false, approved: true, approval_token: 'test-only-operator-approval' } }));
    assert.equal(duplicate.result.duplicate, true);
    const recommendations = parseTool(await client.callTool({ name: 'recommend_trade_assets', arguments: { message: '低风险', locale: 'zh', limit: 2 } }));
    assert.equal(recommendations.result.stateless, true);
    assert.equal(recommendations.result.action_executed, false);
    assert.ok(recommendations.result.recommendations.every((item) => item.risk_level === 'LOW'));
    const delegated = parseTool(await client.callTool({ name: 'delegate_pricing', arguments: { case_id: copper.case_id, request_id: 'sdk-quote', payout_speed: 'FAST' } }));
    assertPricingQuote(delegated.result.quote);
    assert.equal(delegated.result.request_id, 'sdk-quote');
    assert.equal(delegated.result.quote.payout_speed, 'FAST');
    assert.equal(delegated.result.authorization.chain_action_executed, false);
    const paid = await fetchPaidIntel(app.base, '/api/x402/documents/fraud-review', {
      demoMode: true, budgetUSDC: 0.0015, caseData: copper
    });
    assert.ok(paid.paid?.report_envelope, JSON.stringify(paid.error));
    const evidenceQuote = parseTool(await client.callTool({ name: 'delegate_pricing', arguments: {
      case_id: copper.case_id, payout_speed: 'FAST', paid_report_ids: [paid.paid.report_envelope.report_id]
    } }));
    assert.equal(evidenceQuote.result.quote.quote_hash, delegated.result.quote.quote_hash);
    assert.equal(evidenceQuote.result.quote.final_issue_price_usd, delegated.result.quote.final_issue_price_usd);
    assert.equal(evidenceQuote.result.payment_evidence[0].mode, 'demo');
    assert.equal(evidenceQuote.result.payment_evidence[0].payment_tx, paid.paid.report_envelope.payment_tx);
    assert.notEqual(evidenceQuote.result.quote.evidence_hash, delegated.result.quote.evidence_hash);

    const resources = await client.listResources();
    assert.equal(resources.resources.length, 5);
    assert.deepEqual(resources.resources.map((item) => item.uri).sort(), [
      'agentbl://agent/decisions/recent',
      'agentbl://agent/policy',
      'agentbl://cases/catalog',
      'agentbl://contracts/deployments',
      'agentbl://risk/methodology'
    ]);
    for (const resource of resources.resources) {
      const read = await client.readResource({ uri: resource.uri });
      assert.equal(read.contents.length, 1);
      assert.equal(read.contents[0].mimeType, 'application/json');
      assert.doesNotThrow(() => JSON.parse(read.contents[0].text));
    }
    await assert.rejects(() => client.readResource({ uri: 'agentbl://unknown' }));
  } finally {
    await client.close();
  }
});
