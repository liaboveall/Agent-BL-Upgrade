# 真实数据与相对日期

> 2026-10-17：`live` 同时要求成功取回和底层观测处于来源的时效窗口。`observed_at` / `expires_at` / `fetched_at` 分开保存；价格为空、海况全空、关键来源缺失或过期会触发 review，不能计入 Live 风险解除。离线快照保留实际源日期；确定性 Demo 的单证分析时钟与源观测时钟分开记录。来源时效策略与局限见 [整改记录](project-remediation-2026-10-17.md)。

记录日期：2026-10-16。对应 `docs/next-steps.md` 的改动一。

本文说明三件事：

1. 案例的市场价和航线风险从哪里来；
2. 拿不到实时数据时，界面怎样标明"离线"；
3. 演示日期怎样随"今天"移动。

代码在 `src/realdata/`、`src/core/caseDates.js` 和 `src/core/curatedCases.js`。

## 数据源（全部免费、不需要 key）

| 数据 | 来源 | 用在哪里 | 缓存 |
|---|---|---|---|
| 咽喉要道每日通行船数 | [IMF PortWatch](https://portwatch.imf.org/pages/chokepoints)（ArcGIS 公开服务） | 航线风险 `chokepoint_disruption` | 6 小时 |
| 预测市场赔率 | [Polymarket](https://polymarket.com) gamma API | 航线风险 `war_risk`（例如"霍尔木兹何时恢复正常"） | 30 分钟 |
| 航线海况（未来 3 天最大浪高） | [Open-Meteo Marine](https://open-meteo.com/en/docs/marine-weather-api) | 航线风险 `severe_weather` | 1 小时 |
| 期货行情 | Yahoo Finance chart 接口（非官方）：铜 HG=F、铝 ALI=F、Brent BZ=F、柴油 HO=F（作为 gasoil 代理）、大豆 ZS=F | 盯市估值、`commodity_volatility` | 30 分钟 |
| 新闻标题 | Google News RSS | 世界风险面板里的证据；只有人点"用实时情报重新定价"才会并入价格 | 30 分钟 |

- Yahoo 是非官方接口，可能随时失效。失效时自动回退到离线快照，界面会标出来。
- 铁矿石、天然橡胶、佛山铝锭（人民币现货）没有免费实时源，用**注明日期的参考价**（`market.data_status = "reference"`）。
- xAPI、metalpriceapi、Alpha Vantage、UN Comtrade 仍是可选项。key 由你自己填进 `.env`。填了 `XAPI_KEY` 后，世界风险面板改走 xAPI。
- 开关：
  - `REAL_DATA=off` 关闭全部实时请求，只用离线快照；
  - `REAL_DATA_TIMEOUT_MS` 设置单次请求超时，默认 6000 毫秒；
  - 在 `node --test` 下默认关闭，除非显式设 `REAL_DATA=on`。

## 数据状态与界面标注

每个数字都带有来源和状态，界面（市场卡片、交易详情、世界风险面板）会照着显示：

| 状态 | 含义 | 界面文字 |
|---|---|---|
| `live` | 缓存有效，且底层观测仍在来源时效窗口 | 有效公开观测，保留源日期 |
| `stale` | 取回失败或观测已过期；不能作为当前决策证据 | 观测滞后或刷新失败 |
| `mixed` | 来源状态不一致，包括滞后、缺失和快照 | 部分来源不可用于当前决策 |
| `offline` | 离线快照 | 离线快照 · 采集于 {日期}（非实时） |
| `reference` | 没有免费实时源的参考价 | 参考价 · {日期}（无免费实时行情） |

离线快照是 `data/real-data/snapshot.json`。它是同一批数据源的**真实值**，带各自的原始日期，用下面的命令重新采集：

```bash
npm run realdata:snapshot
```

这个命令同时会重写 `data/world-intel/feed.json`，也就是 xAPI 调用失败时用的离线数据。新的 feed 只有真实新闻标题和 Polymarket 赔率，不再有虚构的推文或账号。

## 数据怎样变成风险（确定性规则，不经过大模型）

| 信号 | 规则 | 计入定价 |
|---|---|---|
| 咽喉通行量 | 近 7 天日均对比去年同期 7 天：低于 35% 记 critical，低于 70% 记 warning | `chokepoint_disruption`：warning 200 bps、critical 450 bps |
| 装货港**邻近**的咽喉（`nearby_chokepoints`） | 同上，但降一级 | 同上 |
| 预测市场 | 选"在货物 ETA 之后最先结算"的那个盘口，得出扰动仍持续的概率：≥40% 记 critical，≥20% 记 warning；邻近时降一级 | `war_risk` |
| 海况 | 最大浪高 ≥6 米记 critical，≥4 米记 warning | `severe_weather` |
| 月度价格变动 | 绝对值 ≥25% 记 critical，≥12% 记 warning | `commodity_volatility` |
| 新闻标题 | 只看提到本航线地点或本货种的标题，最高只记 warning；同一类风险已有量化来源时不再重复计 | 只在人点击确认后计入 |

同一类风险、同一地区只计一次（`mergeWorldRiskIntoCase` 会去重并保留更高的等级），所以世界风险面板里的"重新定价"不会把案例上已有的航线数据再加一遍。

## 相对日期

- 案例、单证、Agent 演示场景和 RAG 知识库都写在**锚定日** `2026-10-16` 前后，JSON 里有 `date_anchor` 字段。
- 加载时，所有 ISO 日期整体平移"今天 − 锚定日"天：
  - 航程长度、ETA 之后的保险余量、融资期限都不变；
  - 任何一天打开 Demo，船都在航行中，保单也都在有效期内。
- 不平移的有：
  - `price_reference_date`：参考价的观测日；
  - 没有 `date_anchor` 的数据，例如用户上传的单证和归档的历史案例。
- `AGENTBL_DEMO_TODAY=YYYY-MM-DD` 可以把"今天"固定下来，用于截图或复现。
- 测试和 `npm run eval:agent` 默认使用锚定日，结果可以复现。

## 案例集（2026-10-16 起）

价格量级参考锚定日的公开行情。公司、银行、船名和单号都是虚构的。

| 案例 | 航线 | 当天的数据给出的结果 |
|---|---|---|
| 铜阴极 `CASE-EBL-CU-SIN-SHA` | Singapore → Shanghai | 低风险，按 30 天期限定价 |
| 柴油 `CASE-EBL-GASOIL-SIN-JKT` | Singapore → Jakarta | 柴油月跌约 13%，`commodity_volatility` 记 warning |
| 天然橡胶 `CASE-EBL-RUBBER-LCB-TAO` | Laem Chabang → Qingdao | 参考价，低风险 |
| 铜（保险缺口）`CASE-EBL-2026-0001` | Shanghai → Hamburg，绕好望角 | 延误使到港时间逼近保单到期，WARNING |
| 原油 `CASE-EBL-OIL-FUJ-SIN` | Fujairah → Singapore | 富查伊拉在海峡外、紧邻霍尔木兹，降一级后 WARNING |
| 铁矿石 `CASE-EBL-IRONORE-PHE-TSN` | Port Hedland → Tianjin | 参考价，L/C 90 天 |
| 大豆 `CASE-EBL-SOY-SSZ-DLC` | Santos → Dalian | 巴西对华主流航线 |
| 铜精矿 `CASE-EBL-CUCONC-ANF-LYG` | Antofagasta → Lianyungang | 按应付铜量盯市，TC/RC 按 2026 年基准价 0 计 |
| 原铝 `CASE-EBL-ALU-JEA-RTM` | Jebel Ali → Rotterdam | 必须经过霍尔木兹：通行量比去年同期少 94%，Polymarket 赔率显示扰动持续，CRITICAL，暂停发行 |
| 佛山铝锭仓单 3 个 | 库内交货 | 人民币参考价（2026-05 观测），宏观事件标为"情景假设" |

**修掉的数据错误：**

- 成品油案例的发票总额对不上，现在是 30,000 吨 × 1,385 = 41,550,000；
- 铜精矿案例毛利约为 0，现在毛利约 3.8%；
- 佛山仓单的入库、过户、交付是例行节点，原来每个被算成 +60 bps 风险，现在记 0；
- 提单和发票上的 Incoterms 写法不一致，已统一。

## 测试网 pool #2：历史演示池

- **为什么保留：** pool #2（eBL #2）是 2026-06 用旧铜案例开的，链上价格 0.7910 来自旧定价模型。案例文件归档在 `data/cases/archive/copper-sg-shanghai-2026-06.case.json`，因为它的 cargoHash 已写在链上，Live 链接校验和 Wave B 复验都要用。
- **它不会被改动：** 这个归档案例不平移日期。
- **界面上怎样显示：** 市场中排在最后，标为"历史演示池"。
- **不对投资者开放：**
  - 认购被服务端拒绝（`409 pool_historical`）；
  - 不进入 Copilot 推荐和市场搜索。
- **新池（2026-10-16 已开）：** 新铜案例 `CASE-EBL-CU-SIN-SHA` 现在对应测试网 **eBL #3 / pool #3**。
  - 链上状态：Open，发行价 0.9893，供应 5,054,078 份，未认购。
  - 开盘方式：按 `docs/live-opening.md` 走 owner CLI 三步（mintEBLV2、pledge、createOffering），每一笔都在用户同意后才发送，共花费约 0.00014 INJ。
  - 交易哈希与核验记录见 `docs/evidence/live-opening-pool3.json`。
  - 已加入 `KNOWN_LIVE_POOLS`（`src/agent/runtime/poolRegistry.js`）。在新的运行目录（例如服务器部署）上启动 Live 时，它和 pool #2 一样自动链接，不再依赖 `AGENTBL_RUNTIME_DIR/agent-pools.json`。
  - 不是受保护池：policy 不会因为保护规则拒绝它的结算类动作。

## 已知测试网池怎样自动链接

`KNOWN_LIVE_POOLS` 里每个池子各自带三样东西：

| 池子 | 案例 | 身份文件（cargoHash 由它算出） | 受保护 | 历史池 |
|---|---|---|---|---|
| pool #2 / eBL #2 | `CASE-EBL-2026-CU-SG-SHA` | `data/cases/archive/copper-sg-shanghai-2026-06.case.json` | 是 | 是 |
| pool #3 / eBL #3 | `CASE-EBL-CU-SIN-SHA` | `data/chain-identities/copper-sg-shanghai-ebl3.case.json` | 否 | 否 |

- **为什么 pool #3 要单独的身份文件：**
  - 链上的 cargoHash `0xe23d…d032` 是从上传单证（`data/uploads/copper-sg-shanghai/`）解析出的承运人、船名、货名算出来的；
  - 目录里的案例 `data/cases/copper-sg-shanghai.case.json` 用的是简写，算出来的哈希不同；
  - 身份文件只保存当时上链的提单字段，由开盘计划读取，服务端目录不加载它。不要改这个文件，改了哈希就对不上。
- **启动 Live 时（`bootstrapLive`）：** 逐个读链上状态，下面三项都核对通过才写入 PoolRegistry，不发任何交易：
  - 池子存在、处于活跃或暂停状态；
  - 抵押品是预期的 eBL；
  - 这个 eBL 登记的 cargoHash 等于预期值。

  任一项不符就跳过这个池子，并记一条 `POOL_LINK_SKIPPED`。
- **再次上传同一批单证时（开盘计划）：**
  - 每个已知池子只和自己的身份文件比对，pool #3 的案例不会再拿归档的 2026-06 铜案例去比；
  - 单证与身份文件一致，就只提议链接到已有的池子，不会再铸造一张 eBL；
  - 不一致（例如换了船名，或用目录里的简写案例）就转人工复核；
  - 链上查不到这个身份时，也拒绝重新铸造（`known_cargo_not_registered`）。
