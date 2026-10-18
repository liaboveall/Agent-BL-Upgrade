// DOM contract of the React dashboard, checked on the markup the real components render
// (built for Node by tests/helpers/web-ssr.js): navigation tabs and their panels, accessible
// dialog names, live regions, the Demo/Live boundary, the Mystery Voyage flow, escaping of server
// data, and an English UI without leftover Chinese.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWebSsr } from './helpers/web-ssr.js';

const ssr = await loadWebSsr();
test.after(() => ssr.cleanup());

const VIEWS = ['finance', 'market', 'mint', 'agent', 'discover'];

function fixtureCase(overrides = {}) {
  return {
    case_id: 'CASE-WEB-1',
    label: 'Copper Cathodes',
    cargo: 'Copper Cathodes',
    order: 1,
    case: {
      case_id: 'CASE-WEB-1',
      bill_of_lading: {
        bl_id: 'EBL-WEB-0001', cargo: 'Copper Cathodes', vessel: 'MV Test Bay', quantity_mt: 500,
        port_of_loading: 'Singapore', port_of_discharge: 'Shanghai', shipped_on_board: '2026-10-10', eta: '2026-10-20',
        declared_value_usd: 5_000_000
      },
      insurance: { insured_value_usd: 5_500_000 },
      market: { data_status: 'live' },
      real_data: { status: 'live' },
      macro_risk_events: [],
      shipment_events: [],
      ...overrides
    }
  };
}

const quote = {
  case_id: 'CASE-WEB-1',
  payout_speed: 'BALANCED', pricing_action: 'OPEN_OFFERING', risk_level: 'LOW', risk_score_bps: 120,
  final_issue_price_usd: 0.981, base_issue_price_usd: 0.995, indicative_issue_price_usd: 0.981, urgency_discount_bps: 8, risk_discount_bps: 6,
  binding_constraint: 'RISK', implied_gross_yield_bps: 190, annualized_yield_bps: 1250, tenor_days: 30,
  expected_cash_to_exporter_usd: 4_000_000, requested_cash_usd: 4_000_000, ai_verified_collateral_value_usd: 4_900_000,
  max_safe_redemption_exposure_usd: 4_400_000, recommended_token_supply: 4_000_000, financing_cost_usd: 40_000,
  exporter_profit_share_bps: 4000, exporter_net_profit_usd: 150_000, risk_factors: [], evidence_graph: [],
  quote_hash: `0x${'ab'.repeat(32)}`, evidence_hash: `0x${'cd'.repeat(32)}`
};

function marketState(overrides = {}) {
  const entry = fixtureCase();
  const comparison = { quotes: [quote], recommended_payout_speed: 'BALANCED' };
  return {
    cases: [entry], caseId: entry.case_id, caseData: entry.case, comparison, speed: 'BALANCED',
    marketComparisons: { [entry.case_id]: { comparison } }, view: 'market', demoMode: true, dealOpen: false, ...overrides
  };
}

const render = (state = {}, mystery = {}) => ssr.renderApp({ state: marketState(state), mystery });
const visibleText = (html) => html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gu, '').replace(/<[^>]+>/gu, '\n')
  .split('\n').map((line) => line.trim()).filter(Boolean);

test('every navigation tab owns a named panel and exactly one is selected', () => {
  for (const view of VIEWS) {
    const html = render({ view });
    for (const name of VIEWS) {
      assert.match(html, new RegExp(`id="tab-${name}"[^>]+role="tab"[^>]+aria-controls="view-${name}"`, 'u'));
      assert.match(html, new RegExp(`id="view-${name}" role="tabpanel" aria-labelledby="tab-${name}"`, 'u'));
    }
    assert.equal((html.match(/role="tab" aria-selected="true"/gu) ?? []).length, 1, `${view}: one selected tab`);
    assert.match(html, new RegExp(`id="tab-${view}"[^>]+aria-selected="true"`, 'u'));
  }
});

test('every dialog has an accessible name that exists in the document', () => {
  const html = render({ view: 'discover', dealOpen: true }, { modal: true, subscribeOpen: true, shareOpen: false });
  const dialogs = [...html.matchAll(/<dialog\b([^>]*)>/gu)].map((match) => match[1]);
  assert.ok(dialogs.length >= 5, `expected the dashboard dialogs, found ${dialogs.length}`);
  for (const attrs of dialogs) {
    const labelled = attrs.match(/aria-labelledby="([^"]+)"/u)?.[1];
    assert.ok(labelled || /aria-label="[^"]+"/u.test(attrs), `dialog without a name: ${attrs}`);
  }
  // The open ones render their heading, so the reference resolves.
  for (const id of ['modal-title', 'mystery-modal-title', 'mystery-subscribe-title']) assert.match(html, new RegExp(`id="${id}"`, 'u'));
});

test('the Demo / Live boundary is always visible with its controls', () => {
  const demo = render({ demoMode: true });
  assert.match(demo, /id="demo-banner" class="mode-strip is-demo"/u);
  assert.match(demo, /id="mode-toggle-btn"/u);
  assert.match(demo, /id="demo-reset-btn"/u);
  assert.match(demo, />DEMO</u);
  const live = render({ demoMode: false });
  assert.match(live, /class="mode-strip is-live"/u);
  assert.match(live, />LIVE</u);
  assert.match(live, /id="demo-reset-btn"[^>]*disabled=""/u, 'a Live runtime cannot be reset');
  assert.match(live, /id="market-subscribe-btn"[^>]*disabled=""/u, 'Demo subscriptions are not offered in Live');
});

test('the Agent console announces decision changes in a polite live region', () => {
  const html = render({ view: 'agent' });
  assert.match(html, /id="ac-announcement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"/u);
  assert.match(html, /id="agent-logs-container"[^>]+role="log"/u);
});

test('server data is rendered as text, never as markup', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const entry = fixtureCase();
  entry.case.bill_of_lading.cargo = evil;
  entry.case.bill_of_lading.port_of_loading = `"><script>alert(2)</script>`;
  const html = ssr.renderApp({ state: { ...marketState(), cases: [entry], caseData: entry.case } });
  assert.doesNotMatch(html, /<img src=x/u);
  assert.doesNotMatch(html, /<script>alert/u);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
});

test('MBOX-FE-1~6: the Mystery Voyage flow keeps its tiers, five steps, reveal, verifier and guarded subscribe', () => {
  const report = {
    reveal_id: 'reveal_web', selected_pool_id: 'CASE-WEB-1', reveal_proof_hash: `0x${'11'.repeat(32)}`,
    cargo: { category: 'Copper', port_of_loading: 'Singapore', port_of_discharge: 'Shanghai' },
    risk: { level: 'LOW', score_bps: 120, factors: [], stress_loss_pct: 0.2 }, pricing: { issue_price_usd: 0.98 },
    suitability: { matched: true, reasons: [] }, payment: { live: false, txHash: 'demo:receipt' }
  };
  const html = render({ view: 'discover' }, {
    modal: true, subscribeOpen: true, preview: { candidate_count: 3, server_commitment: '0x1', candidate_set_hash: '0x2' },
    report, reveal: 'opening', canonicalProof: { reveal_id: 'reveal_web' }, proofText: '{}', proofValid: true
  });
  assert.equal((html.match(/name="mystery-tier"/gu) ?? []).length, 3);
  for (const id of ['mystery-step-commit', 'mystery-step-challenge', 'mystery-step-settlement', 'mystery-step-reveal', 'mystery-step-verify',
    'mystery-cargo-image', 'mystery-proof-json', 'mystery-view-report-btn', 'mystery-subscribe-btn', 'mystery-risk-ack',
    'passport-collection', 'passport-collection-grid', 'mystery-claim-discovery-btn', 'mystery-claim-journey-btn']) {
    assert.match(html, new RegExp(`id="${id}"`, 'u'), id);
  }
  for (const visual of ['mystery-entry-box', 'mystery-box-stage', 'mystery-blind-box', 'mystery-reveal-burst']) {
    assert.match(html, new RegExp(`class="[^"]*${visual}`, 'u'), visual);
  }
  assert.match(html, /id="mystery-confirm-subscribe"[^>]*disabled=""/u, 'subscribing waits for the explicit acknowledgement');
  assert.match(html, /id="mystery-claim-journey-btn"[^>]*hidden=""/u, 'the journey stamp appears only after a subscription');

  const share = render({ view: 'discover' }, {
    modal: false, subscribeOpen: false, shareOpen: true,
    selectedPassport: { credential_id: 'vp_1', experience_mode: 'DEMO' }, shareCard: null
  });
  for (const id of ['passport-share-modal', 'passport-advanced-share', 'passport-advanced-confirm', 'passport-export-json', 'passport-export-png', 'passport-print']) {
    assert.match(share, new RegExp(`id="${id}"`, 'u'), id);
  }
  assert.match(share, /id="passport-advanced-share"[^>]*disabled=""/u, 'a Demo stamp can never disclose a public transaction');
});

test('the English UI has no leftover Chinese on any page', () => {
  ssr.setLang('en');
  try {
    for (const view of VIEWS) {
      const lines = visibleText(render({ view, dealOpen: view === 'market' }, { modal: false, subscribeOpen: false, shareOpen: false }));
      const mixed = lines.filter((line) => /[㐀-鿿]/u.test(line) && line !== '中文');
      assert.deepEqual(mixed, [], `${view}: ${mixed.join(' | ')}`);
    }
  } finally {
    ssr.setLang('zh');
  }
});
