# xAPI Live World-Risk Integration

> How AgentBL turns **real-world signals** — international situation, officials'
> statements, and prediction-market odds — into the AI's risk judgment on a specific
> cargo, using **xAPI** (`xapi.to`). This makes *"the AI prices real-world risk"* literal.

---

## 1. What xAPI is

[xAPI](https://xapi.to) is an **Agent-friendly unified API platform**: one API key calls
Twitter/X, Google Search, prediction markets, crypto quotes and ~20 other services, with output
normalized to JSON. (It also offers an LLM gateway at `ai.xapi.to`, which we do **not** use here —
AgentBL keeps its own OpenAI-compatible LLM client.)

We integrate **programmatically over HTTP** (no CLI subprocess), mirroring the open-source CLI
(`github.com/xapi-labs/xapi-cli`):

| | |
|---|---|
| **Execute an action** | `POST https://action.xapi.to/v1/actions/execute` |
| **Header** | `XAPI-Key: sk-...` |
| **Body** | `{ "action_id": "twitter.search_timeline", "input": { ... } }` |
| **Response** | `{ "success": true, "data": { ... } }` (success:false + `data.statusCode` 401/403 ⇒ auth/OAuth) |
| **Discover** | `GET /v1/actions/search?q=…`, `/v1/actions/{id}` |
| **Key** | env `XAPI_KEY` (or `XAPI_API_KEY`) |

Actions we use:

| Signal | xAPI action | Input |
|---|---|---|
| International situation / war | `twitter.search_timeline` | `{ raw_query, count }` |
| Officials' / institutions' statements | `twitter.user_by_screen_name` → `twitter.user_tweets` | `{ screen_name }` → `{ user_id, count }` |
| Breaking news | `web.search.news` | `{ q, tbs }` |
| Prediction-market odds (Polymarket-style) | `web.search.realtime` | `{ q: "Polymarket … odds", timeRange }` |

> xAPI has **no dedicated Polymarket action**, so live odds are retrieved by searching the web
> *through xAPI* (`web.search.realtime`) and parsing the implied probability from the result snippets.

---

## 2. The data flow

```text
TradeCase (commodity, route, ports, counterparties, chokepoint exposure)
   │  buildQueryProfile()  → queries + official handles (data/world-intel/watchlist.json)
   ▼
xAPI actions (Twitter/X · Google News · prediction markets)        ← src/agent/tools/worldRiskTools.js
   │  normalize → { tweets, officials, news, prediction_markets }
   ▼
scoreWorldSignals()  → structured macro_risk_events                ← src/agent/worldRiskAgent.js
   │  (deterministic keyword → {type, severity}; prob → severity)
   ▼
scoreRisk()  → risk_score_bps                                      ← src/core/pricingEngine.js (UNCHANGED)
   ▼
quoteFromCase(case + live events)  → issue price moves / PAUSE     ← src/core/worldRiskPricing.js
```

The agent is **deterministic-first**, exactly like `src/agent/valuationAgent.js`: xAPI provides the
*data*, but the mapping from signals to risk basis points is pure and testable code — an LLM never
sets the numbers. (An optional LLM summary may be added later; it would only write prose.)

The derived events use the **exact vocabulary** the pricing engine already understands
(`scoreRisk` / `MACRO_RISK_BPS`), so they drop straight in with no engine change.

### Signal → risk mapping

| Keywords in the signal | macro_risk_event.type | Severity |
|---|---|---|
| war, missile, attack, blockade, **closure**, strait, naval | `war_risk` | critical if "closure/attack/war"; else warning |
| sanction, embargo, OFAC, export ban | `sanction_risk` | by intensity |
| price, **record**, surge, volatility, supply shock *(commodity-gated)* | `commodity_volatility` | critical if "record"; else warning |
| port, berth, congestion, backlog, dwell | `port_congestion` | by intensity |
| typhoon, hurricane, storm, flood | `severe_weather` | by intensity |
| currency, devaluation, FX, won/yuan/rupee | `fx_volatility` | by intensity |
| default, bankrupt, insolvency, nonpayment | `buyer_country_risk` | by intensity |
| **prediction market** implied probability | mapped by question | ≥40% → critical · ≥20% → warning · else info |

---

## 3. Enable live mode

Without a key the agent uses the **free public sources** in `src/realdata` (IMF PortWatch, Polymarket,
Open-Meteo Marine, Yahoo Finance, Google News; see `docs/real-data.md`), or their dated offline snapshot
when `REAL_DATA=off` or a source is down. xAPI is an optional alternative for social and news signals:

1. Register and get a key (from the xAPI tutorial):
   ```bash
   npx xapi-to register          # invite code: xapito  (free $1 credit)
   npx xapi-to oauth bind --provider twitter
   ```
2. Put the key in `.env` at the project root:
   ```bash
   XAPI_KEY=sk-...
   ```
3. Run it:
   ```bash
   npm run intel                                 # default: aluminium Jebel Ali → Rotterdam (Hormuz transit)
   node scripts/world-intel.mjs data/cases/copper-sg-shanghai.case.json
   ```
   With a key set, the output shows `provider: xapi-live` and `live: true`, real tweets/news/odds, and
   the re-priced quote. Without a key it shows `public-live` (or `public-snapshot` offline).

---

## 4. API

```bash
curl -s -X POST http://localhost:3000/api/intel/world-risk \
  -H 'Content-Type: application/json' \
  -d '{ "case": { /* a case from /api/cases */ } }'
```

Returns:

```jsonc
{
  "ok": true,
  "live": false,                 // true when live xAPI or live public data drove the result
  "provider": "public-snapshot", // xapi-live | public-live | public-snapshot | xapi-empty->fixtures
  "queried": { "war_route": "...", "commodity_vol": "...", "prediction": "..." },
  "events": [ { "type": "war_risk", "severity": "critical", "region": "...", "evidence": [ ... ] } ],
  "signals": { "tweets": [...], "officials": [...], "news": [...], "prediction_markets": [...] },
  "summary": "Live xAPI signals for Copper on Middle East / Strait of Hormuz: ...",
  "evidence_hash": "0x...",
  "before_quote": { "final_issue_price_usd": 0.80, "risk_score_bps": 350, "pricing_action": "OPEN_OFFERING" },
  "after_quote":  { "final_issue_price_usd": 0.74, "risk_score_bps": 980, "pricing_action": "PAUSE_OFFERING" },
  "delta": { "issue_price_usd": -0.06, "risk_score_bps": 630, "action_changed": true }
}
```

Empty body ⇒ the demo case. A bare case or `{ "case": {...} }` wrapper both work (same convention as
`/api/pricing/quote`).

---

## 5. Files

| File | Role |
|---|---|
| `src/agent/xapi/xapiClient.js` | HTTP client: `executeAction` / `searchActions` / `isXapiConfigured` (injectable `execute` seam) |
| `src/agent/tools/worldRiskTools.js` | `searchTweets` / `getOfficialTweets` / `searchNews` / `getPredictionMarket` — normalize + offline fallback |
| `src/agent/worldRiskAgent.js` | `assessWorldRisk` / `scoreWorldSignals` / `buildQueryProfile` |
| `src/core/worldRiskPricing.js` | `mergeWorldRiskIntoCase` / `repriceWithWorldRisk` (before/after quote) |
| `data/world-intel/feed.json` | offline snapshot used when an xAPI call fails: real headlines and Polymarket odds, no posts (regenerated by `npm run realdata:snapshot`) |
| `src/realdata/` | free public sources, their offline snapshot and the route-risk mapping (`docs/real-data.md`) |
| `data/world-intel/watchlist.json` | official handles + query templates + region keyword sets |
| `scripts/world-intel.mjs` | `npm run intel` CLI |
| `tests/worldRiskAgent.test.js` | offline + injected-executor + reprice tests |

---

## 6. Safety & compliance notes

- **Offline-safe invariant:** no `XAPI_KEY` ⇒ free public sources; any failure ⇒ their dated offline
  snapshot, labelled as such in the API (`provider`, `data_status`) and the UI. The demo never breaks.
- **No invented posts:** the offline feed holds real headlines and market odds only; the official
  handles in `watchlist.json` are placeholders to replace before using xAPI for real.
- **Deterministic risk numbers:** xAPI supplies *evidence*; the basis-point scoring is pure code, so
  pricing stays explainable and auditable (the `evidence_hash` anchors what was used).
- **Keys are secrets:** `XAPI_KEY` lives only in `.env` (gitignored) — never commit it.
