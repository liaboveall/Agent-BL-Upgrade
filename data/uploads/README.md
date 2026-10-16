# 拟真上传单据（Simulated User Uploads）

这里是**模拟用户上传**的贸易单据，供 AgentBL 的审单、估值、定价主链路使用（Agent 控制台上传、单证接入流水线、文档解析测试）。

> ⚠️ 全部为**虚构数据**：公司、银行、人名、船名、单号、地址都是编造的，不指向任何真实实体或真实货运。
> 价格量级参考 2026-10-16 的公开行情（见 `docs/real-data.md`）。日期都写在这一天前后，Demo 加载时会整体平移到"今天"前后（`src/core/caseDates.js`）。

## 目录

| 目录 | 货物 | 航线 | 单据 | 结构化案例 |
|---|---|---|---|---|
| `copper-sg-shanghai/` | 铜阴极板 500 MT（HS 7403.11） | Singapore → Shanghai (Yangshan)，集装箱 | 电子提单、商业发票、保险单 | `../cases/copper-sg-shanghai.case.json` |
| `crude-fuj-sin/` | Murban 原油 700,000 bbl（≈ 92,105 MT，HS 2709.00） | Fujairah → Jurong Island, Singapore，油轮 | 电子提单、商业发票、保险单 | `../cases/crude-fuj-sin.case.json` |
| `soybean-ssz-dlc/` | 巴西大豆 66,000 MT（HS 1201.90） | Santos → Dalian，绕好望角，散货 | 电子提单、商业发票、保险单 | `../cases/soybean-ssz-dlc.case.json` |
| `alu-fs-wh-00013/`、`00014/`、`00015/` | 铝锭 AL99.70（HS 7601.10） | 佛山南海指定仓库，库内交货 | 电子仓单、商业发票（人民币） | `../cases/alu-fs-wh-000xx.case.json` |
| `archive/copper-sg-shanghai-2026-06/` | 旧铜案例（2026-06） | Singapore → Shanghai | 电子提单、商业发票、保险单 | `../cases/archive/copper-sg-shanghai-2026-06.case.json` |

`archive/` 只为测试网 pool #2（历史演示池）保留：它的 cargoHash 已写在链上，Live 链接校验要用。这些单据**不平移日期**。

## 三组海运单据的差异点

- **计价单位**：
  - 铜和大豆按吨；
  - 原油按桶，发票同时写明吨数，解析时直接读这个吨数，不按桶数换算。
- **计价基准**：
  - 铜：LME 现金价 + 洋山溢价；
  - 原油：Brent + Murban 升贴水；
  - 大豆：CBOT + Santos FOB 升水 + 运费（CFR）。
- **提单形态**：
  - 铜：集装箱提单（箱数、件数）；
  - 原油：油轮提单（API 度、含硫量、桶数）；
  - 大豆：散货提单（舱数、水尺计重）。
- **风险来源**：
  - 原油的装货港紧邻霍尔木兹海峡但不经过它，所以航线风险按"邻近"计、降一级；
  - 大豆绕好望角，海况风险来自 Open-Meteo 的实时浪高。

## 怎么用

- 默认对**铜**这组跑 AI 估值 tool calling：`npm run agent:value`（见 `docs/ai-valuation-tooling.md`）。
- 文档里的日期全部写成 `YYYY-MM-DD`，这样平移时能整体移动；如需测试"15 May 2026"这类手写日期的解析，请在测试里内联构造文本。
