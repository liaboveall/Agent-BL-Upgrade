# 文档索引

仓库根目录的 [README.md](../README.md) 是总览和快速开始。

## 产品与设计

| 文档 | 内容 |
|---|---|
| [PRD.md](./PRD.md) | 产品需求（v0.2：AI 动态定价的 eBL-backed RWA 折价发行） |
| [background.md](./background.md) | 贸易金融、电子提单与 RWA 的背景入门 |
| [agent-implementation-plan.md](./agent-implementation-plan.md) | Agent 的架构、设计原则与决策记录（已实施完成；代码注释中的 § 编号指向这里） |
| [agent-security-matrix.md](./agent-security-matrix.md) | 自主级别 × 签名角色 × 动作的权限矩阵与人工兜底 |
| [next-steps.md](./next-steps.md) | 接下来的两项改动：真实数据与新案例、前端 UI 重构 |
| [real-data.md](./real-data.md) | 免费公开数据源、离线快照、相对日期、当前案例集与历史 pool #2 |

## 功能说明

| 文档 | 内容 |
|---|---|
| [document-extraction.md](./document-extraction.md) | 单证抽取：PDF 文本层、可选视觉/文本模型、人工复核 |
| [compliance-screening.md](./compliance-screening.md) | 合规筛查：演示名单、模糊匹配、港口/IMO/HS、三态证据 |
| [ai-valuation-tooling.md](./ai-valuation-tooling.md) | AI 估值的 tool calling（行情与历史成交价） |
| [xapi-integration.md](./xapi-integration.md) | xAPI 世界风险信号接入 |
| [copilot.md](./copilot.md) | 投资者 Copilot：多轮偏好、检索排序、主动重排、确认动作 |
| [phase4-console-demo.md](./phase4-console-demo.md) | Agent 控制台、证据联动与一键全流程演示 |
| [live-opening.md](./live-opening.md) | Live 开盘提案与 owner CLI |
| [live-settlement.md](./live-settlement.md) | Live USDC 回执核验与结算 |
| [chain-watcher.md](./chain-watcher.md) | 链上只读监听与对账 |
| [phase5-security-replay.md](./phase5-security-replay.md) | 红队、数据新鲜度、决策重放、隐私与保留 |
| [agent-reliability.md](./agent-reliability.md) | 故障矩阵与恢复边界 |
| [evaluation-report.md](./evaluation-report.md) | 可复现的确定性评测报告 |
| [agent-api.md](./agent-api.md) | 五个无状态分析接口 |
| [phase6-interoperability.md](./phase6-interoperability.md) | MCP、A2A 与 x402 服务发现 |
| [phase7-decision-anchoring.md](./phase7-decision-anchoring.md) | 决策锚定合约与 Merkle 批次 |
| [x402-integration.md](./x402-integration.md) | x402 付费情报：Demo 与 Live 两种传输、威胁模型 |

## 合约与链

| 文档 | 内容 |
|---|---|
| [contracts.md](./contracts.md) | 合约接口；§0 是当前 v2 实现、权限、状态机与已知限制 |
| [wave-b.md](./wave-b.md) | 链上付费定价闭环与 MCP 的验证记录 |
| [injective-runbook.md](./injective-runbook.md) | Injective 工程手册 |
| [injective-precompile-integration.md](./injective-precompile-integration.md) | Bank / Exchange precompile 的集成决策 |

## 运维

| 文档 | 内容 |
|---|---|
| [DEPLOYMENT.md](./DEPLOYMENT.md) | 部署：Docker / PM2 + Nginx、环境变量、上线检查、合约重新部署 |

## 证据文件

[evidence/](./evidence/) 只保留真实链上交易和评测的关键记录，部分被 `npm run check` / `npm run preflight` 读取：

| 文件 | 内容 |
|---|---|
| `wave-b-gate.json`、`wave-b-protocol.json`、`x402-live-smoke.json` | 测试网付费定价闭环、协议部署与 x402 实链付款 |
| `injective-mcp-smoke.json` | 官方 Injective MCP 适配的冒烟记录 |
| `agent-live-smoke.json` | 三笔经授权的 Agent 定价交易（REPRICE / PAUSE / RESUME） |
| `phase7-live-deployment-verification.json`、`phase7-live-bytecode.json` | AgentDecisionLog 部署与字节码核验 |
| `injective-bank-precompile.json`、`injective-exchange-precompile.json` | precompile 实链探测 |
| `agent-eval.json` | `npm run eval:agent` 的最新评测结果 |

历史阶段报告、路演稿和中间验收记录已于 2026-10-15 从仓库删除，需要时可在 git 历史中查看。
