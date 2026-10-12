# AgentBL x402 Integration

> **AI pays for premium risk intelligence — on-chain audit trail included.**

## What is x402?

x402 is the HTTP 402 Payment Required protocol for Web3 APIs. Instead of subscription keys or API tokens, x402 lets AI agents pay for API access **per-request** using on-chain USDC settlement. The flow:

1. Client requests a protected endpoint → server returns **HTTP 402** with payment instructions
2. Client signs an **EIP-3009 TransferWithAuthorization** (gasless for the signer)
3. The **x402 facilitator** settles the payment on-chain
4. Server returns the unlocked data + a **PAYMENT-RESPONSE** header with the settlement txHash

Every payment is auditable — the chain records who paid, for what, and how much.

## Why x402 for AgentBL?

AgentBL's AI pricing engine needs the best possible risk intelligence to set accurate RWA issue prices. Free intel sources (offline RAG, cached prices) are good enough for a demo, but in production the AI should be able to **buy premium data** when the situation calls for it:

| Intel tier | Source | Cost | When to use |
|---|---|---|---|
| Free | Offline RAG corpus, cached data | $0 | Routine pricing |
| x402 Premium | Live xAPI + deep analysis + volatility forecasts | 0.001–0.002 USDC | Elevated risk, war scenarios, unusual routes |

The x402 integration gives AgentBL:
- **A new differentiator vs projects that only have free intel** — "our AI pays for better data"
- **On-chain payment evidence** — every verified Live purchase is bound to its report in PaymentOracle; Demo receipts never claim an on-chain event
- **Pricing impact tracking** — show how paid intel changed the AI's risk assessment
- **EIP-3009 gasless payments** — the White Agent wallet signs, the facilitator relays

## Architecture

```
                    ┌──────────────────────────────┐
                    │   Frontend (x402 Intel Market) │
                    │   Service catalog · Payment   │
                    │   flow viz · Smoke test       │
                    └──────────────▲───────────────┘
                                   │
            ┌──────────────────────┴──────────────────────────┐
            │              API Server (src/app/server.js)      │
            │                                                  │
            │  GET /api/x402/config           — service catalog│
            │  *   /api/x402/intel/premium-risk   — HTTP 402   │
            │  *   /api/x402/valuation/premium    — HTTP 402   │
            │  *   /api/x402/documents/fraud-review — HTTP 402 │
            │  POST /api/x402/smoke            — E2E test      │
            └──▲──────────────────────────────────▲───────────┘
               │                                  │
    ┌──────────┴──────────┐          ┌────────────┴──────────────┐
    │  src/x402/server.js │          │  src/x402/client.js       │
    │  createX402Route()  │          │  createPaidFetch()        │
    │  buildPremiumRisk*  │          │  fetchPaidIntel()         │
    └─────────────────────┘          └────────────┬──────────────┘
                                                  │
                                   ┌──────────────┴──────────────┐
                                   │  src/x402/settlement.js     │
                                   │  recordPaymentEvidence()    │
                                   │  generatePaymentReceipt()   │
                                   └──────────────┬──────────────┘
                                                  │
                          ┌───────────────────────┴────────────────┐
                          │         Injective Testnet              │
                          │                                        │
                          │  PaymentOracle.sol                     │
                          │  · PaymentAttested                     │
                          │  · attestor ACL · replay protection    │
                          └────────────────────────────────────────┘
```

## Available x402 Services

| serviceId | Endpoint | Price | Description |
|---|---|---|---|
| `premium-risk` | `/api/x402/intel/premium-risk` | 0.001 USDC | Live xAPI world-risk signals + RAG deep analysis with full source citations |
| `premium-valuation` | `/api/x402/valuation/premium` | 0.002 USDC | Real-time commodity prices + historical comparables + volatility forecast |
| `fraud-review` | `/api/x402/documents/fraud-review` | 0.0015 USDC | Five-dimension eBL / invoice / insurance consistency review, scenario action and pricing impact |
| `mystery-voyage` | `/api/x402/mystery/voyage` | 0.001 USDC | Commit-reveal voyage discovery with a verifiable AI risk passport |

Prices are fixed in `src/x402/config.js` (`X402_SERVICES`); `GET /api/x402/config` returns the live catalog.

## Two transports: Demo and Live (x402 V2)

The paid services are the same in both modes (`src/app/x402Services.js`); only the way the
buyer pays differs.

| | **Demo** (default) | **Live** (`DEMO_MODE=false`, `X402_MODE=live`) |
|---|---|---|
| Request | `GET` or `POST` the endpoint | `POST` the endpoint (other methods answer a JSON `405`) |
| Challenge | `402` with `{ challenge, nonce }` | `402` with an x402 V2 payment requirement (`accepts[]`, EIP-3009 `exact` scheme) |
| Buyer proves payment with | `personal_sign` over the challenge → `X402-Signature` + `X402-Signer` headers | EIP-3009 `transferWithAuthorization` signed with `eth_signTypedData_v4` → `PAYMENT-SIGNATURE` header |
| Settlement | Simulated locally; the receipt is `demo://receipt/...` and never an explorer link | The facilitator verifies and settles the USDC transfer on-chain |
| Evidence | None on-chain | The server writes `PaymentOracle.PaymentAttested` (fail-closed: no attestation, no report) |
| Code | `createX402Route` (`src/x402/server.js`) | `createLiveGateway` (`src/x402/liveGateway.js`: Express sub-app with the official `createX402PaymentMiddleware`) |

Both transports share the delivery pipeline (`src/x402/delivery.js`: report → `PaidReportEnvelope` → attestation →
re-readable cache). Notes on the Live flow:

1. **Validation happens before payment.** A request the server cannot serve (a malformed case, an unknown Mystery
   reveal, ...) is rejected with a `4xx` *before* the buyer is charged (`preflight`).
2. **Settlement is idempotent per signed authorization.** If delivery fails after the payment settled, the response
   says `payment.status: "settled"` with a retry hint; re-sending the *same* `PAYMENT-SIGNATURE` re-runs delivery and
   never charges twice.
3. **The browser pays with the connected wallet** (`public/x402-v2.js`): it reads the token's on-chain `name()` for the
   EIP-712 domain (never a server hint), refuses any requirement whose network, asset, payee, timeout or amount is not
   the one the UI displayed, and only then asks the wallet to sign. The official `@injectivelabs/x402` client (CLI,
   agents) produces the same payload; `tests/x402LiveGateway.test.js` runs both against the real server with a mock
   facilitator.
4. **A client-supplied transaction hash is never trusted** (not as proof of payment, and not in the Demo route either).
5. **The facilitator must support your network.** `GET <X402_FACILITATOR_URL>/supported` has to list scheme `exact`
   for `X402_NETWORK`, otherwise live start-up fails closed. On 2026-10-12 `x402-facilitator.molandak.org` listed only
   Monad networks and `x402.injective.network` did not answer; the staging relay recorded in
   `docs/evidence/x402-live-smoke.json` lists `eip155:1439` with the canonical USDC. It is plain HTTP, so it also needs
   `X402_ALLOW_INSECURE_TESTNET=true` (testnet only).
6. **Prerequisites:** `X402_MODE=live`, `X402_FACILITATOR_URL` (HTTPS), `X402_PAY_TO`, a funded buyer wallet, and the
   attestor key authorised on `PaymentOracle` (`PAYMENT_ATTESTOR_PRIVATE_KEY`, see `docs/DEPLOYMENT.md`). If the live
   gateway cannot start, paid routes answer `503 x402_v2_live_transport_required` instead of falling back to Demo.
   Switching the runtime mode into or out of Live needs `AGENTBL_ADMIN_TOKEN`.

## API Reference

### GET /api/x402/config

Returns the x402 service catalog and runtime configuration.

```json
{
  "ok": true,
  "services": [...],
  "network": "eip155:1439",
  "facilitatorUrl": "https://x402-facilitator.molandak.org",
  "configured": false
}
```

### GET /api/x402/intel/premium-risk

**Without payment:** Returns HTTP 402 with `PAYMENT-REQUIRED` header.

```bash
curl -s -i http://localhost:3000/api/x402/intel/premium-risk
# HTTP/1.1 402 Payment Required
# PAYMENT-REQUIRED: true
# X-Price-USDC: 0.001
# X-Network: eip155:1439
```

**With payment:** the Demo compatibility client retries with `X402-Signature` /
`X402-Signer`; the production Express middleware uses the standard V2
`PAYMENT-SIGNATURE` header. Both return a validated report envelope.

```json
{
  "ok": true,
  "service": "premium-risk",
  "events": [...],
  "deepIntel": [...],
  "before_quote": { "final_issue_price_usd": 0.80, ... },
  "after_quote": { "final_issue_price_usd": 0.76, ... },
  "delta": { "issue_price_delta_usd": -0.04 },
  "report_envelope": {
    "report_id": "rpt_...",
    "kind": "risk-intelligence",
    "payment_tx": "demo://receipt/...",
    "report_hash": "0x...",
    "expires_at": "2026-06-29T08:05:00.000Z"
  },
  "payment": { "status": "settled", "txHash": "0x...", ... }
}
```

### PaidReportEnvelope

Every unlocked report contains the 15-field `PaidReportEnvelope` defined in
`src/x402/paidReport.js`: `report_id`, `kind`, `case_id`, `payer`, `payee`,
`network`, `asset`, atomic `amount`, `payment_tx`, `settled_at`, sanitized
`data_snapshot`, `model_provider`, `evidence_hash`, `report_hash`, and
`expires_at`.

`report_hash` is SHA-256 over canonical JSON excluding only the hash field, so
any party can recompute it. The schema rejects tampering, expired/invalid time
ranges, malformed payment identities, raw chain-of-thought, private keys,
binary/base64 documents, and oversized snapshots. Demo receipts always use a
`demo://receipt/...` identifier and cannot be confused with an on-chain tx.

### PricingQuote evidence injection

`src/x402/reportEvidence.js` validates the canonical report hash, expiry and
`case_id` before adding a `paid_report_provenance` node. The node changes only
the evidence graph/evidence hash. It never changes `risk_score_bps`, discounts,
issue price, action, yield, token supply, or `quote_hash`. Tampered, expired and
cross-case envelopes fail closed; `tests/x402PricingEvidence.test.js` locks
these invariants.

### GET /api/x402/valuation/premium

Same HTTP 402 flow as premium-risk. Price: 0.002 USDC.

### GET /api/x402/report/:reportId

Re-read a report you **already paid for**, within its TTL, with **no second
charge**. After a successful purchase the server caches the delivered report
keyed by its `report_id` until `expires_at`; this endpoint re-serves it so a page
refresh (or a returning buyer) does not pay twice.

```bash
curl -s http://localhost:3000/api/x402/report/rpt_3e5f...3334
# 200 → { "ok": true, "cached": true, ...report..., "expires_at": "..." }
# 404 → { "ok": false, "code": "paid_report_not_cached" }   (unknown or expired → pay again)
```

A miss is intentional: an unknown id or an expired TTL returns **404**, signalling
the caller must pay again. The cache never extends a TTL and never mints a
receipt — settlement remains the source of truth. The frontend remembers
purchased `report_id`s in `localStorage` and re-reads non-expired reports into the
"Your purchased reports" card when the Intel Market view opens.

### POST /api/x402/smoke

End-to-end test of the full x402 flow. Returns step-by-step results with payment evidence.

```bash
curl -s -X POST http://localhost:3000/api/x402/smoke \
  -H "Content-Type: application/json" \
  -d '{"locale":"en"}'
```

## CLI Tools

### x402 Smoke Test

```bash
npm run smoke:x402
# → 402 challenge → payment → settlement → intel unlocked → config ✓
```

### Paid Intel Query

```bash
npm run x402:intel
npm run x402:intel -- --kind valuation
npm run x402:intel -- --kind fraud --case CASE-EBL-2026-0001
npm run x402:intel -- --kind risk --live  # requires WHITE_AGENT_PRIVATE_KEY
```

Demo Mode is the default and uses an ephemeral local signer. It prints a demo
receipt identifier, never labels it as an on-chain settlement. Live Mode fails
closed when signer, facilitator, payee, RPC, or PaymentOracle configuration is
missing; private keys never leave the local CLI process.

## On-Chain: PaymentOracle.sol

Deployed on Injective Testnet alongside `AgentBLRWA` and `RiskPricingOracle`.

**Injective Testnet deployment** (`public/chain-config.json` is the source of truth):

- Contract: [`0x064AF06C9fFD7c2Bd2bB2B5e4CA4f36019a39Ff8`](https://testnet.blockscout.injective.network/address/0x064AF06C9fFD7c2Bd2bB2B5e4CA4f36019a39Ff8)
- Deployment tx: [`0xddaabf1c…9b2faf8`](https://testnet.blockscout.injective.network/tx/0xddaabf1ce27f129966f9d69f75c758ee0d25f1f3c858a93f2f2fd7c689b2faf8)
- This is the v2 build (redeployed 2026-10-12), which has two-step ownership that moves the attestor role with the owner
  (see `docs/contracts.md` §0); `npm run verify:bytecode` shows whether the deployment is current.

**Event:**

- `PaymentAttested(bytes32 indexed receiptId, bytes32 indexed reportHash, bytes32 indexed caseIdHash, bytes32 paymentTxHash, address payer, address asset, uint256 amount, address attestor, uint256 timestamp)`

**Functions and safety:**

- `attestPayment(...)` — only an allowlisted attestor can bind a settlement to a report
- `getAttestation(receiptId)` / `hasAttestation(receiptId)` — browser/backend readback
- `setAttestor(address, allowed)` — owner-managed attestor ACL. The server signs with a dedicated key
  (`PAYMENT_ATTESTOR_PRIVATE_KEY`) authorised here, not with the owner key
- Both `receiptId` and the original `paymentTxHash` are replay protected; zero
  hashes, zero addresses and zero amounts revert.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `X402_MODE` | No | `demo` | `demo` or `live`; Live also needs the facilitator and payee below |
| `X402_NETWORK` | No | `eip155:1439` | CAIP-2 network identifier (`eip155:1776` is mainnet) |
| `X402_FACILITATOR_URL` | Live only | — | Settlement relay URL (HTTPS) |
| `X402_PUBLIC_BASE_URL` | No | request origin | Public origin used in payment requirements behind a proxy |
| `X402_ASSET` | No | canonical Injective Testnet USDC | Must equal the canonical USDC of the network |
| `X402_TTL_SECONDS` | No | `60` | Validity window of a payment authorization (10-300) |
| `X402_REQUEST_TIMEOUT_MS` / `X402_MAX_ATTEMPTS` | No | `10000` / `3` | Facilitator timeout and bounded retries |
| `X402_GATEWAY_RETRY_MS` | No | `5000` | Back-off before retrying a failed live-gateway start-up |
| `X402_RPC_URL` | No | `INJECTIVE_RPC_URL`, then the public node | RPC for balances and settlement checks |
| `X402_REPORT_TTL_SECONDS` | No | `300` | Paid report envelope/cache TTL |
| `X402_REPORT_CACHE_PATH` | No | `<AGENTBL_RUNTIME_DIR>/x402-reports.json` | Re-read cache file for already-paid reports |
| `X402_RECEIPT_STORE_PATH` | No | `<AGENTBL_RUNTIME_DIR>/x402-receipts.json` | Settlement receipts (survive restarts without re-settling) |
| `PAYMENT_ATTESTOR_PRIVATE_KEY` | Live | — | Server key that writes `PaymentAttested` (authorise with `PaymentOracle.setAttestor`) |
| `WHITE_AGENT_PRIVATE_KEY` | No | — | Wallet that signs EIP-3009 payments for the CLI/agent client |
| `X402_PAY_TO` | Live only | demo payee | Address receiving payments |
| `X402_LIVE_CONFIRM` | Live smoke only | — | Must equal `injective-testnet`; prevents accidental spend |
| `X402_LIVE_AMOUNT_ATOMIC` | No | `1000` | Live smoke price in atomic USDC (0.001 USDC) |
| `X402_ALLOW_SELF_PAYMENT` | No | `false` | Explicit test-only self-transfer opt-in |
| `X402_RECOVER_PAYMENT_TX` | No | — | Resume from an already-confirmed payment tx without paying again |

**Without x402 keys,** the endpoints still return HTTP 402; Demo Mode completes
the signed retry with an ephemeral local signer and an explicitly non-chain
receipt. It never returns premium data directly and never invents an explorer URL.

## Verification

```bash
# Full x402 end-to-end verification
npm run check && npm run test && npm run smoke:x402

# Real testnet proof (never falls back to Demo)
npm run smoke:x402:live

# Individual checks
npm run smoke:x402       # 402 challenge → payment → intel
npm run x402:intel       # CLI paid intel query
npm run dev              # → open http://localhost:3000 → "x402 Intel Market" tab
```

`smoke:x402:live` revalidates facilitator `/supported`, RPC chain id, INJ/USDC
balances and hardened Oracle bytecode; purchases one report through the official
V2 client/middleware; verifies the USDC `Transfer`; writes `PaymentAttested`; and
saves explorer evidence to `docs/evidence/x402-live-smoke.json`.

X402-15 passed on 2026-06-29 and was re-run on 2026-10-12 on `eip155:1439` against the redeployed v2 contracts, this
time as a real transfer between two wallets (buyer `0x8c59…a0E9` pays payee `0x9da2…ed6B`, no self-payment). The
official V2 flow through the staging facilitator settled
[0.001 USDC](https://testnet.blockscout.injective.network/tx/0xb8968f4803c3a68525e183bd70596715004e5b498c44a172d7fbb0423a41ae90),
unlocked report `rpt_e2e20c…626c` (`report_hash=0xa2fe04…b659`), and emitted
[`PaymentAttested`](https://testnet.blockscout.injective.network/tx/0x61e0ce548607636a95bd04136d5b9b5fcc1f49a92c06412b62d2e9487cd97a31).
The full machine-readable proof is committed at `docs/evidence/x402-live-smoke.json`. The harness has the buyer
wallet write the attestation, so the buyer was an authorised attestor for that run only (revoked afterwards).

The production path was exercised too: a second purchase through the running Live server
(`npm run x402:intel -- --kind risk --live`) settled in
[`0x9df522…a7ed`](https://testnet.blockscout.injective.network/tx/0x9df522ccb6e9f265b99f5f7937a21e08313fc255645415404ccfb41735f0a7ed)
and was attested by the dedicated `PAYMENT_ATTESTOR_PRIVATE_KEY` (not the owner, not the buyer) in
[`0x20f13f…bd11`](https://testnet.blockscout.injective.network/tx/0x20f13fc5bb43bcacabb2ba64d50b8730f71c7483ce5760c34931c148fa6fbd11).

## Two different businesses: x402 report payment vs RWA subscription

The single most important thing to get right when explaining AgentBL: **the AI is
not buying anything.** A human, an institution, or another agent pays AgentBL's AI
for an analysis. x402 (buying a report) and RWA subscription (investing in the
trade-finance asset) are two separate transactions with different actors, assets,
amounts and settlement paths.

| | **x402 — buy an AI report** | **RWA — subscribe to the offering** |
|---|---|---|
| Who pays | Investor / bank / insurer / another agent | Investor |
| What they get | An AI due-diligence report (risk / valuation / fraud) | RWA tokens representing a share of the financing |
| Amount | Cents (0.001–0.002 USDC) per report | The subscription capital (thousands+) |
| Settlement | HTTP 402 + EIP-3009 → facilitator → `PaymentOracle.PaymentAttested` | `RWAOfferingPool.subscribe` |
| Purpose | Price the risk *before* you invest | Take on the priced risk for a discounted issue price |
| On-chain proof | report hash ↔ payment tx binding | subscription + pool state |

```text
x402:  request report → 402 → sign USDC → settle → unlock report → PaymentOracle binds report hash
RWA:   read report   → accept risk     → subscribe RWA          → RWAOfferingPool settles
```

A verified paid report is injected into pricing **only** as a provenance/evidence
node (`src/x402/reportEvidence.js`): it can change *which evidence backs* a quote,
but paying **never** changes the risk score, the discount, the issue price, the
action, or `quote_hash`. **Paying does not make a report more trustworthy** — the
report must still pass schema, evidence-integrity and freshness checks before any
of its data is allowed near the pricing engine.

## Threat model & security invariants

x402 turns an AI analysis into an independently purchasable, machine-callable
service, so the payment path is adversarial by design. The invariants below are
enforced in code (`src/x402/server.js`, `settlement.js`, `client.js`,
`paidReport.js`, `reportEvidence.js`, `PaymentOracle.sol`) and locked by tests.

| # | Invariant | Where enforced |
|---|---|---|
| 1 | `verified && settled` is required to unlock — a visible tx hash alone is **not** proof of payment | `server.js` middleware only calls `next()` after `settlementService.process` succeeds |
| 2 | `network + asset + amount + payTo + resource + nonce/authorization` all enter the signature/validation domain; any mismatch is rejected before the facilitator | `assertPaymentMatches` |
| 3 | A payment receipt binds 1:1 to one `report_hash`; a report for a different case/report cannot be reused | `paidReport.js` hash recompute + `reportEvidence.js` `case_id` check |
| 4 | Replay, concurrency and retry produce **at most one** settlement and one `PaymentAttested` attestation | settlement idempotency key + single-flight; `PaymentOracle` replay-protects both `receiptId` and original `paymentTxHash` |
| 5 | If report generation fails, the buyer is not charged (or a verifiable retry/refund path exists) | route only settles before handler success; failures fall through to a 402/5xx receipt with `success:false` |
| 6 | Demo receipts use a `demo://` identifier and never fabricate an explorer URL or claim an on-chain event | `settlement.js` demo path + UI labelling |
| 7 | Private keys are used locally and never sent to the server — only the signature + signer address travel | `client.js` `resolveSigner`; covered by `tests/x402Client.test.js` |
| 8 | Untrusted report content (data snapshots, document text) cannot change tool permissions, payTo, network, price or system rules | `paidReport.js` rejects raw chain-of-thought / keys / binary; pricing injection is provenance-only |

Client-side failures are mapped to recoverable `X402ClientError` codes so a buyer
always gets an actionable hint rather than a raw error:
`X402_BUDGET_EXCEEDED`, `X402_WRONG_NETWORK`, `X402_INSUFFICIENT_BALANCE`,
`X402_SIGNATURE_CANCELLED`, `X402_NETWORK_ERROR`, `X402_TIMEOUT`,
`X402_SETTLEMENT_FAILED`.

## FAQ (judge Q&A)

**Who pays, and for what?** A human, bank, insurer, logistics platform or another
agent pays cents over x402 to unlock one AI due-diligence report. The AI is the
*seller* of analysis, not a shopper.

**Why does this need to be on-chain?** So the payment and the exact report it paid
for are bound together and auditable: `PaymentOracle.PaymentAttested` ties the
`report_hash` to the settlement tx, payer, asset and amount. Anyone can recompute
`report_hash` and verify the binding — the report that drove a financing decision
cannot be silently swapped afterwards.

**How is this different from the RWA investment?** See the table above: buying a
report (cents, x402) and subscribing to the RWA offering (capital, `RWAOfferingPool`)
are two separate transactions. The report *prices* the risk; the subscription
*takes on* the priced risk.

**Can a report be forged or "bought into" a better score?** No. Paying only unlocks
access; it adds a provenance node and never changes the risk score or price. A
report must pass schema, hash-integrity, freshness (`expires_at`) and `case_id`
checks before any data reaches the engine; tampered, expired or cross-case
envelopes fail closed.

**What if payment fails?** The handler is never released without a verified
settlement, so a failed/cancelled/underfunded payment does not unlock the report
and does not silently charge — the client surfaces a recoverable error code and
the buyer can retry.

**Why Injective?** Native USDC + EIP-3009 gasless authorization, an official
`@injectivelabs/x402` facilitator path, and a low-cost EVM for the `PaymentOracle`
attestation — the payment, settlement and on-chain evidence all live in one
sponsor-native stack.

## Comparison: AgentBL vs RugRumble x402

| Feature | AgentBL | RugRumble |
|---|---|---|
| x402 protocol | ✅ HTTP 402 + EIP-3009 | ✅ HTTP 402 + EIP-3009 |
| Paid endpoints | 3 (risk + valuation + fraud-review) + TTL re-read | 3 (reputation + approve + copy) |
| On-chain evidence | PaymentOracle (Injective) | RugRumbleArena (Monad) |
| Payment evidence fields | report/case/payment tx/payer/asset/amount + attestor/time | 5 fields |
| Duplicate protection | receipt id + original payment tx | ❌ |
| Paid intel pricing impact | Provenance-only evidence node; score unchanged | Risk delta only |
| Offline demo mode | ✅ Deterministic mock signatures | ❌ Requires config |
| npm script | `smoke:x402` + `smoke:x402:live` + `x402:intel` | `smoke:x402` |
