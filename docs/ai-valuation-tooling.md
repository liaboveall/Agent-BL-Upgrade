# AI 估值 Tool Calling（铜货市场估值 + 历史同类成交价）

本文档说明 AgentBL 的 **AI 估值工具调用**：让一个 LLM 通过 tool calling，拉取一批货物的**实时市场估值**和**历史同类成交价**，再用本地确定性工具算出 RWA 折价发行的抵押地基（`ai_verified_collateral_value`）。

默认对**铜阴极板**那组数据（`data/cases/copper-sg-shanghai.case.json`）跑。

> 一句话：AI 不是凭空给估值，而是**调用工具**拉真实价格 + 历史成交价，再交给一个确定性策略工具算出保守抵押价值。LLM 只负责"决定调哪些工具、给多少 haircut、写解释"，硬数字由本地工具产出。

## 1. 怎么跑

```bash
# 无 LLM key：deterministic fallback；实时价来自免费公开行情（REAL_DATA=off 时用离线快照）
npm run agent:value

# 指定另一组数据（原油）
node scripts/agent-valuation.mjs data/cases/crude-fuj-sin.case.json
```

把 key 填进 `.env`（见仓库根 `.env.example`），就会切换成"真 LLM 驱动"。实时价不需要 key：

- 默认用 Yahoo Finance 的期货行情（非官方接口），拿不到时用注明日期的离线快照（见 `docs/real-data.md`）；
- 其余没有免费源的数据（区域升水、历史成交价）用 mock，保证 demo 永远能跑。

## 2. 架构

```
data/cases/*.case.json
  → src/agent/valuationAgent.js        # 编排：LLM 工具调用循环 / 或 deterministic fallback
      ├─ src/agent/llm/openaiCompatClient.js   # OpenAI 兼容客户端 (DeepSeek/Qwen/...)
      └─ src/agent/tools/copperValuationTools.js  # 4 个工具：spec + executor + mock fallback
  → scripts/agent-valuation.mjs        # CLI，打印结构化估值报告
```

两条执行路径，**输出结构完全一致**：

1. **LLM 路径**（有 key）：模型读 case，自己决定按顺序调用工具，最后写解释。
2. **Deterministic fallback**（无 key / LLM 报错）：按固定顺序调同样的工具，模板化解释。

## 3. 四个工具（tool calling）

| 工具 | 作用 | 数据源（有 key） | 无 key 时 |
|---|---|---|---|
| `get_live_commodity_price` | 实时铜价 (USD/MT)；原油、铝、大豆同理 | metalpriceapi.com 或 Alpha Vantage | 免费公开期货行情（COMEX HG=F 等）或其离线快照；都没有时用 mock 14,450（2026-10-16 校准） |
| `get_regional_physical_premium` | CIF 上海/洋山 区域升水 (USD/MT) | `REGION_PREMIUM_USD_PER_MT`（手填） | mock：70 |
| `get_historical_comparable_trades` | 历史同类成交价（按 HS 编码的进出口单价） | UN Comtrade | mock：China HS740311 进口单价 9,850→14,100（2025-Q3 至 2026-Q3） |
| `compute_cargo_valuation` | 本地确定性估值（取最小 + haircut） | 纯本地，无 API | 纯本地 |

`compute_cargo_valuation` 是定价的"硬约束"工具（PRD 要求"final price 由 deterministic policy 校验，LLM 只解释"）：

```
landed_price        = market_price + regional_premium
market_value        = quantity_mt × landed_price
raw_verified        = min(declared_invoice, market_value, insured_value)
ai_verified_collateral = raw_verified × (1 − volatility_haircut)      # 高位+战争溢价 → haircut
max_safe_redemption = ai_verified_collateral × redemption_coverage_limit   # 默认 0.9
```

铜组实跑结果（`REAL_DATA=off` 离线快照，确定性路径）：

- 发票 $7,267,500 是三者中的最小值（市场价值约 $7.33M，保险 $7.99M）；
- 航线没有战争或波动事件，所以 haircut 为 0，AI 核定抵押 **$7,267,500**；
- 安全兑付上限 **$6,540,750**，大于请求融资 $5,000,000，可以发行。

接上 LLM 后，模型可能自行加一点 haircut（例如铜价接近历史高位时加 3%）。最终数字仍由确定性工具算出。

## 4. ⭐ 需要你补充的 API（这是你问的"需要什么 api"）

全部**可选**：不填则用 mock。要做"真 AI + 真数据"的 demo，按下表补 key 到 `.env`。

### 4.1 LLM（任选其一，必填一个才算"真 AI 驱动"）

| 提供方 | 用途 | env 变量 | 费用 | 申请地址 | 模型 |
|---|---|---|---|---|---|
| **DeepSeek** | OpenAI 兼容入口 | `DEEPSEEK_API_KEY` | 另行核实 | platform.deepseek.com | `x-test-2` |
| **Qwen 通义千问** | DashScope OpenAI 兼容入口 | `DASHSCOPE_API_KEY` | 另行核实 | dashscope.console.aliyun.com | `x-test-2` |
| 自定义 | 任何 OpenAI 兼容端点 | `LLM_BASE_URL` + `LLM_API_KEY` | — | — | `LLM_MODEL` |

> 2026-10-15 全项目 API 默认模型为 `x-test-2`，由 `LLM_MODEL` 共用控制；上表仅列兼容入口。实际端点是否提供该模型、工具/视觉能力、费用和额度尚未验证，优先沿用已配置的兼容端点。

### 4.2 实时铜价（可选；不填用免费公开行情）

| 提供方 | 用途 | env 变量 | 费用 | 申请地址 | 备注 |
|---|---|---|---|---|---|
| **Alpha Vantage** | `COPPER` 全球月度铜价 (USD/MT) | `ALPHAVANTAGE_API_KEY` | 免费 | alphavantage.co/support/#api-key | 免费、好接；是月度全球价，非 LME 实时 |
| **metalpriceapi.com** | LME 铜近实时 (USD/MT) | `METALPRICE_API_KEY` | 免费额度 | metalpriceapi.com | 更接近 LME 现货；符号/单位需对照其文档确认 |
| 备选 | commodities-api.com / metals-api.com | 同上 | 免费额度 | — | 同系产品 |

> 区域升水（洋山/CIF 上海 premium）没有干净的免费 API（SMM、Fastmarkets 是付费）。用 `REGION_PREMIUM_USD_PER_MT` 手填当前值即可。

### 4.3 历史同类成交价（强烈推荐，免费）

| 提供方 | 用途 | env 变量 | 费用 | 申请地址 |
|---|---|---|---|---|
| **UN Comtrade** | 按 HS 编码的各国进出口**成交单价**（trade value ÷ net weight） | `COMTRADE_PRIMARY_KEY` | 免费（需注册订阅） | comtradedeveloper.un.org |

UN Comtrade 是"历史同类成交价"的最佳免费来源：查 **HS 740311（精炼铜阴极）**、reporter=156（中国）、flow=import，就能拿到各期进口单价，校准你这批货的定价是否合理。原油用 **HS 270900**。

### 4.4 之后可扩展（暂用 mock / 未接）

- 船舶/到港（AIS）：MarineTraffic、Datalastic、Spire —— 验证运输事件、ETA。
- 天气/海况：已接 Open-Meteo Marine（免费，见 `docs/real-data.md`）；OpenWeather、Stormglass 可作为备选。
- 战争/地缘：已接 IMF PortWatch 咽喉通行量、Polymarket 赔率、Google News 标题；制裁名单仍是演示数据。
- 港口拥堵：港务/AIS 衍生数据。

这些接进来后，就能把 `risk_discount` 也做成工具调用驱动，而不只是估值。

## 5. tool calling 流程（OpenAI 兼容）

```
system: 你是 AgentBL 估值分析师，用工具给货物估值...
user:   case CASE-EBL-CU-SIN-SHA：铜 500MT，HS740311，发票$7.2675M，保险$7.99425M，宏观：无
  → assistant.tool_calls: get_live_commodity_price(copper)
  ← tool: {price_usd_per_mt:14582.48, source:"Yahoo Finance · COMEX copper futures (HG=F) (live)"}
  → assistant.tool_calls: get_regional_physical_premium(Shanghai)
  ← tool: {premium_usd_per_mt:70}
  → assistant.tool_calls: get_historical_comparable_trades(740311, 156)
  ← tool: {comparables:[...9850→14100...]}
  → assistant.tool_calls: compute_cargo_valuation(qty,price,premium,declared,insured,haircut=0.03)
  ← tool: {ai_verified_collateral_value_usd:7049475, max_safe_redemption_exposure_usd:6344527.5}
  → assistant: "Verified collateral USD 7,049,475... 3% haircut with copper near record highs..."（投资者可读解释）
```

代码在 `src/agent/valuationAgent.js` 的 `runWithLlm()`：循环执行 `tool_calls` → 回填 `role:"tool"` 结果 → 直到模型不再调用工具，输出解释。

## 6. 输出结构

`runValuationAgent(caseData)` 返回（也是 CLI 打印的内容）：

```jsonc
{
  "case_id": "CASE-EBL-CU-SIN-SHA",
  "commodity": "Copper Cathode", "hs_code": "740311", "quantity_mt": 500,
  "live_market": {
    "price_usd_per_mt": 14582.48, "regional_premium_usd_per_mt": 70,
    "landed_price_usd_per_mt": 14652.48, "as_of": "2026-10-16T02:42:19.000Z", "sources": [...]
  },
  "historical_comparables": [ {"period":"2026-Q3","unit_value_usd_per_mt":14100,...} ],
  "valuation": {
    "market_value_usd": 7326240, "ai_verified_collateral_value_usd": 7049475,
    "max_safe_redemption_exposure_usd": 6344527.5, "valuation_basis": "..."
  },
  "ai_explanation": "...", "provider": "deepseek|qwen|deterministic-fallback", "tool_trace": [...]
}
```

这个 `ai_verified_collateral_value_usd` / `max_safe_redemption_exposure_usd` 正是 PRD §8.4 `PricingQuote` 的输入：定价引擎据此算 `recommended_token_supply` 和 `final_issue_price`。

## 7. 接到主链路 / 接到合约

- 主链路：把本报告喂给（待实现的）定价引擎 → `PricingQuote` → `/api/pricing/quote`。
- 合约：`max_safe_redemption_exposure_usd` 约束 `RWAOfferingPool.createOffering`；估值证据 hash 写入 `RiskPricingOracle`。
- 验证：`npm run agent:value`（离线）/ `npm run test`（含 `tests/valuationAgent.test.js` 不变量）。
