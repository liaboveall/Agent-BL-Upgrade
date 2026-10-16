# AgentBL

AgentBL 是一个以电子提单（eBL）为底层资产的贸易融资原型：AI Agent 读取单证、估值、评估航线与世界风险，给出 RWA 份额的折价发行价，并在货物运输过程中持续监控、提出重新定价或暂停等动作；投资者通过 Copilot 按偏好筛选和比较资产。链上部分部署在 Injective EVM 测试网，付费风险报告走 x402。

> 原型项目，不构成投资建议。Demo 模式下的认购、付款和执行都是模拟的；Live 模式只在测试网运行，并且合约没有认购的付款环节（见下文"局限"）。

## 快速开始

```bash
npm install
npm run dev        # 先构建前端，再启动：http://localhost:3000
```

默认是 Demo 模式，不需要钱包或 API Key：

- 案例的市场价和航线风险来自免费公开数据（IMF PortWatch、Polymarket、Open-Meteo、Yahoo Finance、Google News）；
- 联不上网，或设了 `REAL_DATA=off` 时，改用注明采集日期的离线快照，界面会标出"离线"；
- 案例日期随今天平移，任何一天打开都在航行中（见 [docs/real-data.md](docs/real-data.md)）；
- x402 付款仍是本地模拟。

需要 Node.js 20.11+（合约工程需要 22.13+）。

用 Docker 运行：`docker compose up -d --build`。部署到服务器见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 主要功能

| 模块 | 说明 | 文档 |
|---|---|---|
| 定价与风险 | 单证核验、估值、航线/世界风险评分，按回款速度给出三档发行价 | [PRD](docs/PRD.md)、[AI 估值](docs/ai-valuation-tooling.md) |
| 真实数据 | 咽喉通行量、预测市场、海况、期货行情盯市；离线快照与相对日期 | [真实数据](docs/real-data.md) |
| 自主 Agent | 单证接入九步流水线、事件 → 决策 → 策略 → 执行；Live 下所有动作都要人工批准 | [实现规划](docs/agent-implementation-plan.md)、[权限矩阵](docs/agent-security-matrix.md) |
| 单证与合规 | PDF 文本层/可选视觉抽取、人工复核，演示名单的实体/港口/IMO/HS 筛查 | [单证抽取](docs/document-extraction.md)、[合规](docs/compliance-screening.md) |
| Live 开盘与结算 | owner CLI 三步开盘、USDC 回执核验、双证明结算，均需逐笔审批 | [开盘](docs/live-opening.md)、[结算](docs/live-settlement.md) |
| 链上监听 | 只读确认日志、持久游标、池状态对账与紧急停止 | [链上监听](docs/chain-watcher.md) |
| 投资者 Copilot | 多轮偏好、可解释排序、风险变化时重新排序，动作需确认 | [Copilot](docs/copilot.md) |
| Agent 控制台与演示 | 决策时间线、审批队列、追踪与一键全流程 Demo | [控制台](docs/phase4-console-demo.md) |
| 质量与安全 | 红队变异、数据新鲜度、决策重放、审计脱敏与保留 | [评测与重放](docs/phase5-security-replay.md)、[可靠性](docs/agent-reliability.md)、[评测报告](docs/evaluation-report.md) |
| 互操作 | MCP（15 tools + 5 resources）、A2A 1.0、x402 服务发现 | [互操作](docs/phase6-interoperability.md) |
| x402 付费情报 | Demo 本地模拟；Live 走 x402 V2（EIP-3009），付款与报告由 PaymentOracle 绑定 | [x402](docs/x402-integration.md) |
| 决策锚定 | 独立合约 AgentDecisionLog，Merkle 批次承诺 | [决策锚定](docs/phase7-decision-anchoring.md) |

完整文档索引见 [docs/README.md](docs/README.md)。

## 常用命令

```bash
npm run dev               # 构建前端并启动服务
npm run dev:web           # 前端热更新开发（:5173，/api 转发到 :3000 的服务）
npm run build             # 只构建前端（Vite → dist/）
npm test                  # 应用测试
npm run test:coverage     # 带覆盖率门槛的测试
npm run lint              # ESLint
npm run check             # 仓库完整性（文件、数据结构、前端依赖哈希）
npm run preflight         # 发布前全部检查；Demo 下 Live 专属项为 SKIP
npm run eval:agent        # 实测 Agent 并写入评测报告（-- --check 只检查不覆盖）
npm run scenarios         # 风险/定价场景回归
npm run price             # 命令行给案例定价
npm run intel             # 世界风险情报（默认免费公开数据，REAL_DATA=off 时用离线快照）
npm run realdata:snapshot # 重新采集离线快照（data/real-data/snapshot.json）
npm run agent:replay -- --decision <id>   # 只读重放一条历史决策
npm run agent:redteam     # 红队变异检查
npm run smoke:x402        # Demo x402：402 → 签名 → 结算 → 解锁
npm run x402:intel        # 命令行购买付费报告（Live 下会真实付款）
npm run mcp:stdio         # stdio 方式的 MCP 服务
npm run interop:demo -- --url http://127.0.0.1:3000   # 只读的 MCP SDK + A2A 示例
```

合约（Hardhat 3，先执行一次 `npm --prefix hardhat install`）：

```bash
npm run test:contracts    # 合约测试
npm run compile:contracts
npm run verify:bytecode   # 只读：对比链上字节码与本地源码
npm run deploy:protocol   # 部署协议合约，需要 DEPLOYER_PRIVATE_KEY 和测试网 INJ
```

会发送测试网交易的命令（`smoke:x402:live`、`verify:wave-b -- --confirm`、`agent:smoke`、`agent:approve` 的写操作）默认都是只读或 dry-run，必须显式确认才会签名。

## 配置与 Live 模式

所有配置都是可选的，[.env.example](.env.example) 列出了全部变量。最常用的：

| 变量 | 用途 |
|---|---|
| `AGENTBL_ADMIN_TOKEN` | 管理员令牌（≥ 16 位）。配置后，切换模式、审批和控制 Agent 都需要它；Live 下必须配置 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI 兼容的模型服务，也支持 `DEEPSEEK_API_KEY` 等；key 只留在服务器 |
| `LLM_MAX_TOKENS_CAP` / `LLM_REASONING_EFFORT` | 推理模型的输出上限与思考强度 |
| `X402_MODE=live`、`X402_FACILITATOR_URL`、`X402_PAY_TO` | Live x402 必需的三项 |
| `PAYMENT_ATTESTOR_PRIVATE_KEY`、`PRICING_UPDATER_PRIVATE_KEY` | 服务器专用签名密钥，需在链上分别授权；`SIGNER_KEYS_STRICT=true` 禁止回退到 owner 密钥 |
| `TRUST_PROXY`、`HOST`、`PORT` | 反向代理与监听设置 |
| `AGENTBL_RUNTIME_DIR` | 持久化目录（x402 收据、报告缓存、决策日志、Copilot 偏好） |
| `REAL_DATA` / `REAL_DATA_TIMEOUT_MS` | 免费公开数据开关（默认开，`off` 只用离线快照）与单次请求超时 |
| `AGENTBL_DEMO_TODAY` | 把演示用的"今天"固定为某一天（截图、复现） |

切换到 Live：配置上面的 x402 变量和管理员令牌，确保收款方和买方有测试网 USDC/INJ，然后在页面上切换（会要求输入令牌），或用 `DEMO_MODE=false` 启动。

## 已部署合约（Injective EVM 测试网，Chain ID 1439）

| 合约 | 地址 | 用途 |
|---|---|---|
| AgentBLRWA | [`0xEcD538011b889a7f79566d80A835C74cab2b4e0e`](https://testnet.blockscout.injective.network/address/0xEcD538011b889a7f79566d80A835C74cab2b4e0e) | 浏览器演示合约，一笔交易把 eBL 代币化 |
| EBLRegistry | [`0x8152FE274497C84850Ce79822feA3B885295cf53`](https://testnet.blockscout.injective.network/address/0x8152FE274497C84850Ce79822feA3B885295cf53) | eBL 登记、货物防重复、质押 |
| RWAOfferingPool | [`0x38c52c33FEC5cc430f19F573768671c47E63b310`](https://testnet.blockscout.injective.network/address/0x38c52c33FEC5cc430f19F573768671c47E63b310) | 发行生命周期状态机 |
| RiskPricingOracle | [`0x5A37286cfb95a0Fc12CDa83d58473E9EC32a6DDC`](https://testnet.blockscout.injective.network/address/0x5A37286cfb95a0Fc12CDa83d58473E9EC32a6DDC) | AI 定价动作上链 |
| RWAToken | [`0x9CD61A8A18b22Ea9a6c4A3C36ba465c1488aC11C`](https://testnet.blockscout.injective.network/address/0x9CD61A8A18b22Ea9a6c4A3C36ba465c1488aC11C) | 每池不可转让的份额凭证（不是 ERC-20） |
| PaymentOracle | [`0x064AF06C9fFD7c2Bd2bB2B5e4CA4f36019a39Ff8`](https://testnet.blockscout.injective.network/address/0x064AF06C9fFD7c2Bd2bB2B5e4CA4f36019a39Ff8) | 把 x402 付款与付费报告绑定 |
| AgentDecisionLog | [`0x6AC3bDDbBc5ab082b7c0dF0C78C2d377578BE6Ec`](https://testnet.blockscout.injective.network/address/0x6AC3bDDbBc5ab082b7c0dF0C78C2d377578BE6Ec) | 决策与版本承诺（已初始化，尚无批次） |

地址以 [public/chain-config.json](public/chain-config.json) 为准（有测试保证本表与它一致）。

测试网上的两个池：

- **pool #3**（eBL #3）：当前的 Live 演示池。2026-10-16 用新铜案例 `CASE-EBL-CU-SIN-SHA` 开出，发行价 0.9893，证据见 [docs/evidence/live-opening-pool3.json](docs/evidence/live-opening-pool3.json)。
- **pool #2**：**历史演示池**。2026-06 的铜案例，链上价格 0.7910 来自旧定价模型，只为链上记录保留，不对认购开放。

详见 [docs/real-data.md](docs/real-data.md)。前六个是 2026-10-12 重新部署的 v2 版本，AgentDecisionLog 于 2026-10-15 部署。合约设计、权限和已知限制见 [docs/contracts.md](docs/contracts.md)；链上付费定价闭环的证据见 [docs/wave-b.md](docs/wave-b.md)，可用 `npm run verify:wave-b -- --dry-run` 只读复验。

## 目录结构

```text
src/          服务端：app（HTTP）、core（定价/风险）、agent（运行时、流水线、监控）、copilot、x402、mcp、rag
web/          前端：Vite + React 源码（web/src），构建到 dist/ 由服务器托管
public/       原样发布的静态文件：chain-config.json、自托管依赖 public/vendor、货物图片
hardhat/      合约源码、测试与部署脚本
data/         演示案例、上传样例、场景、情报与合规数据
scripts/      CLI 工具、preflight、x402/链上冒烟与 owner 审批 CLI
tests/        Node 测试
docs/         文档；docs/evidence 只保留链上交易与评测的关键证据
```

## 安全要点

- 浏览器不加载第三方 CDN 代码，依赖自托管并校验 SHA-256，严格 CSP。
- LLM key 只在服务器；涉及资金和模式切换的路径失败即关闭，不信任客户端提交的交易哈希。
- 服务器使用按角色单独授权的签名密钥，Agent 在 Live 下只提出方案，由人批准后执行。
- 不要提交 `.env`、私钥或 API Key。

## 局限

- 合约没有认购的付款环节：`subscribe` 只铸造份额凭证并记录应付金额，不托管稳定币；`settle` 也不向投资者分配回款。
- 测试网合约的 owner 是单个部署者密钥，没有多签。
- 池子与认购状态保存在服务器内存，重启后清空（收据、报告缓存、决策日志和偏好会持久化）。
- 案例里的公司、船名、单证和合规名单都是虚构的。
- 市场价和航线风险来自免费公开数据或其离线快照。Yahoo 行情是非官方接口；铁矿石、橡胶和人民币铝锭只有参考价。
- 真实的物流跟踪、保险和交易所行情仍需要正式数据源。
- AI 风险评估用于真实金融场景前，需要人工与机构层面的控制。

许可证：MIT（见 `package.json`）。
