import assert from 'node:assert/strict';
import test from 'node:test';
import { CliError, parseArgs, run } from '../scripts/lib/agent-approve.mjs';

const TX = `0x${'ef'.repeat(32)}`;
const OWNER = '0x1111111111111111111111111111111111111111';
const SECRET = 'deadbeef'.repeat(8);

const plan = (overrides = {}) => ({
  network: 'injective_testnet',
  chain_id: 1439,
  steps: [{
    index: 0, contract: 'RWAOfferingPool', address: '0x38c52c33FEC5cc430f19F573768671c47E63b310', method: 'markInTransit',
    args: ['5', `0x${'11'.repeat(32)}`], description: 'Record the departure proof and move the offering to InTransit', expected_events: ['DepartureRecorded']
  }],
  ...overrides
});

const approval = (overrides = {}) => ({
  approval_id: 'appr_abc', decision_id: 'decision_x', case_id: 'CASE-1', pool_id: 'CASE-1', action: 'MARK_IN_TRANSIT',
  status: 'AWAITING_OWNER_SIGNATURE', plan: plan(), steps_done: [], expires_at: '2026-10-13T00:00:00Z', summary: 'depart', ...overrides
});

/** A fake server: records calls, answers like the real routes. */
function fakeServer({ approvals = [approval()], attachReply = { ok: true, complete: true }, attachStatus = 200, getStatus = 200 } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    calls.push({ method: init.method ?? 'GET', path: pathname + search, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.authorization });
    const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (pathname === '/api/agent/approvals') return respond(200, { ok: true, approvals });
    if (pathname.endsWith('/attach-tx')) return respond(attachStatus, attachStatus === 200 ? attachReply : { ok: false, code: 'tx_verification_failed', error: 'argument 1 is wrong' });
    const found = approvals.find((a) => pathname.endsWith(a.approval_id));
    if (getStatus !== 200 || !found) return respond(getStatus === 200 ? 404 : getStatus, { ok: false, code: 'approval_not_found', error: 'Unknown approval' });
    return respond(200, { ok: true, approval: found, decision: { decision_id: found.decision_id } });
  };
  return { fetchFn, calls };
}

function fakeSigner({ owner = OWNER, address = OWNER, revert = null, mined = 1 } = {}) {
  const sent = [];
  const staticCalls = [];
  const contract = {
    owner: async () => owner,
    markInTransit: Object.assign(async (...args) => {
      sent.push(args);
      return { hash: TX, wait: async () => ({ status: mined }) };
    }, { staticCall: async (...args) => { staticCalls.push(args); if (revert) throw Object.assign(new Error('x'), { reason: revert }); } }),
    settle: Object.assign(async () => { throw new Error('must never be sent'); }, { staticCall: async () => {} })
  };
  return { signer: { address, contractFor: () => contract }, sent, staticCalls };
}

function harness({ env = {}, server = fakeServer(), signer = fakeSigner(), noKey = false } = {}) {
  const lines = [];
  const options = {
    env: { AGENTBL_URL: 'http://server.test', AGENTBL_ADMIN_TOKEN: 'admin-token-admin-token', DEPLOYER_PRIVATE_KEY: SECRET, ...env },
    fetchFn: server.fetchFn,
    createSigner: async () => (noKey ? null : signer.signer),
    log: (line) => lines.push(String(line))
  };
  return { options, lines, server, signer, text: () => lines.join('\n') };
}

test('cli: argument parsing', () => {
  assert.deepEqual(parseArgs(['--list']), { list: true, confirm: false, help: false, id: null, server: null });
  assert.deepEqual(parseArgs(['--id', 'appr_1', '--confirm']), { list: false, confirm: true, help: false, id: 'appr_1', server: null });
  assert.equal(parseArgs(['--id=appr_2', '--server=http://x']).id, 'appr_2');
  assert.equal(parseArgs(['--server', 'http://y']).server, 'http://y');
  assert.throws(() => parseArgs(['--yolo']), (error) => error instanceof CliError && error.exitCode === 2);
});

test('cli: no action prints usage; unknown flags exit 2; --help exits 0', async () => {
  const h = harness();
  assert.equal(await run({ ...h.options, argv: [] }), 2);
  assert.match(h.text(), /Usage:/u);
  assert.equal(await run({ ...harness().options, argv: ['--help'] }), 0);
  const bad = harness();
  assert.equal(await run({ ...bad.options, argv: ['--wat'] }), 2);
  assert.match(bad.text(), /Unknown argument: --wat/u);
});

test('cli: --list shows what waits for a signature, with the admin token', async () => {
  const h = harness();
  assert.equal(await run({ ...h.options, argv: ['--list'] }), 0);
  assert.match(h.text(), /appr_abc {2}MARK_IN_TRANSIT {2}pool CASE-1/u);
  assert.equal(h.server.calls[0].path, '/api/agent/approvals?status=AWAITING_OWNER_SIGNATURE');
  assert.equal(h.server.calls[0].auth, 'Bearer admin-token-admin-token');
  const empty = harness({ server: fakeServer({ approvals: [] }) });
  assert.equal(await run({ ...empty.options, argv: ['--list'] }), 0);
  assert.match(empty.text(), /No approvals are waiting/u);
});

test('cli: the default is a dry run that preflights and sends nothing', async () => {
  const h = harness();
  assert.equal(await run({ ...h.options, argv: ['--id', 'appr_abc'] }), 0);
  assert.match(h.text(), /RWAOfferingPool\.markInTransit\(5, 0x1111/u);
  assert.match(h.text(), /preflight OK/u);
  assert.match(h.text(), /Dry run only/u);
  assert.equal(h.signer.staticCalls.length, 1);
  assert.equal(h.signer.sent.length, 0, 'nothing is sent without --confirm');
  assert.equal(h.server.calls.filter((c) => c.path.includes('attach-tx')).length, 0);
});

test('cli: --confirm signs, waits, and reports the hash for the server to verify', async () => {
  const h = harness();
  assert.equal(await run({ ...h.options, argv: ['--id', 'appr_abc', '--confirm'] }), 0);
  assert.equal(h.signer.sent.length, 1);
  assert.deepEqual(h.signer.sent[0], ['5', `0x${'11'.repeat(32)}`]);
  const attach = h.server.calls.find((c) => c.path.endsWith('/attach-tx'));
  assert.deepEqual(attach.body, { tx_hash: TX, step_index: 0 });
  assert.match(h.text(), /server verified step 0: approval complete/u);
  assert.match(h.text(), /Done\./u);
});

test('cli: the private key never appears in any output', async () => {
  const h = harness();
  await run({ ...h.options, argv: ['--id', 'appr_abc', '--confirm'] });
  assert.ok(!h.text().includes(SECRET));
  const failing = harness({ signer: fakeSigner({ revert: 'boom' }) });
  await run({ ...failing.options, argv: ['--id', 'appr_abc'] });
  assert.ok(!failing.text().includes(SECRET));
});

test('cli: a step the contract would reject stops everything before sending', async () => {
  const h = harness({ signer: fakeSigner({ revert: 'not funded' }) });
  assert.equal(await run({ ...h.options, argv: ['--id', 'appr_abc', '--confirm'] }), 1);
  assert.match(h.text(), /Preflight failed for step 0.*not funded/su);
  assert.equal(h.signer.sent.length, 0);
});

test('cli: a key that is not the contract owner is refused', async () => {
  const h = harness({ signer: fakeSigner({ address: '0x2222222222222222222222222222222222222222' }) });
  assert.equal(await run({ ...h.options, argv: ['--id', 'appr_abc', '--confirm'] }), 1);
  assert.match(h.text(), /not the contract owner/u);
  assert.equal(h.signer.sent.length, 0);
});

test('cli: without a local owner key it explains instead of failing silently', async () => {
  const dry = harness({ noKey: true });
  assert.equal(await run({ ...dry.options, argv: ['--id', 'appr_abc'] }), 0);
  assert.match(dry.text(), /DEPLOYER_PRIVATE_KEY is not set/u);
  const confirm = harness({ noKey: true });
  assert.equal(await run({ ...confirm.options, argv: ['--id', 'appr_abc', '--confirm'] }), 1);
});

test('cli: only approvals waiting for an owner signature can be signed', async () => {
  for (const status of ['PENDING', 'EXECUTED', 'EXPIRED', 'REJECTED']) {
    const h = harness({ server: fakeServer({ approvals: [approval({ status })] }) });
    assert.equal(await run({ ...h.options, argv: ['--id', 'appr_abc', '--confirm'] }), 1, status);
    assert.match(h.text(), new RegExp(`is ${status}`, 'u'));
    assert.equal(h.signer.sent.length, 0);
  }
  const noPlan = harness({ server: fakeServer({ approvals: [approval({ plan: null })] }) });
  assert.equal(await run({ ...noPlan.options, argv: ['--id', 'appr_abc', '--confirm'] }), 1);
  assert.match(noPlan.text(), /no transactions to sign/u);
});

test('cli: a terminal action on a protected pool is refused even with --confirm', async () => {
  const settle = approval({ plan: plan({ steps: [{ index: 0, contract: 'RWAOfferingPool', address: '0x1', method: 'settle', args: ['2', '100'], description: 'Settle', expected_events: ['OfferingSettled'] }] }) });
  const h = harness({ server: fakeServer({ approvals: [settle] }) });
  assert.equal(await run({ ...h.options, argv: ['--id', 'appr_abc', '--confirm'] }), 1);
  assert.match(h.text(), /Refusing settle on protected pool #2/u);
  assert.equal(h.signer.sent.length, 0);
  // a different pool is fine; an operator can change the protected list
  const other = approval({ plan: plan({ steps: [{ ...settle.plan.steps[0], args: ['3', '100'] }] }) });
  const ok = harness({ server: fakeServer({ approvals: [other] }) });
  assert.equal(await run({ ...ok.options, argv: ['--id', 'appr_abc'] }), 0);
  const unprotected = harness({ env: { AGENT_PROTECTED_CHAIN_POOLS: '' }, server: fakeServer({ approvals: [settle] }) });
  assert.equal(await run({ ...unprotected.options, argv: ['--id', 'appr_abc'] }), 0);
});

test('cli: a server rejection of the reported transaction is surfaced and exits non-zero', async () => {
  const h = harness({ server: fakeServer({ attachStatus: 422 }) });
  assert.equal(await run({ ...h.options, argv: ['--id', 'appr_abc', '--confirm'] }), 1);
  assert.match(h.text(), /422 tx_verification_failed argument 1 is wrong/u);
  assert.equal(h.signer.sent.length, 1, 'the transaction was sent; the server did not accept it');
});

test('cli: an unknown approval and a mined-but-reverted step are reported', async () => {
  const missing = harness({ server: fakeServer({ approvals: [] }) });
  assert.equal(await run({ ...missing.options, argv: ['--id', 'appr_nope'] }), 1);
  assert.match(missing.text(), /404 approval_not_found/u);
  const reverted = harness({ signer: fakeSigner({ mined: 0 }) });
  assert.equal(await run({ ...reverted.options, argv: ['--id', 'appr_abc', '--confirm'] }), 1);
  assert.match(reverted.text(), /mined but reverted/u);
  assert.equal(reverted.server.calls.filter((c) => c.path.endsWith('/attach-tx')).length, 0, 'a reverted tx is never reported as done');
});

test('cli: steps the server already recorded are skipped when resuming', async () => {
  const two = approval({
    plan: plan({ steps: [plan().steps[0], { ...plan().steps[0], index: 1 }] }),
    steps_done: [{ index: 0, tx_hash: TX }]
  });
  const h = harness({ server: fakeServer({ approvals: [two] }) });
  assert.equal(await run({ ...h.options, argv: ['--id', 'appr_abc', '--confirm'] }), 0);
  assert.equal(h.signer.sent.length, 1, 'only the missing step is sent');
  assert.deepEqual(h.server.calls.find((c) => c.path.endsWith('/attach-tx')).body, { tx_hash: TX, step_index: 1 });
});
