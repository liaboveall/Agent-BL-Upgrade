# 📚 AgentBL 文档索引

仓库根目录的 [`README.md`](../README.md) 是总览和快速开始。这里按用途列出 `docs/` 里的文档，并标出哪些是**现行的参考**，哪些是**某一阶段的记录**（写的时候是对的，之后代码继续演进，不再更新）。

## 现行参考（会随代码更新）

| 文档 | 内容 |
|---|---|
| [DEPLOYMENT.md](./DEPLOYMENT.md) | 部署指南：Docker / PM2 + Nginx / Railway、环境变量、安全与上线检查、合约重新部署 |
| [contracts.md](./contracts.md) | 合约：**§0 是当前 v2 实现**（权限、状态机、动作码、测试、已知限制、部署状态）；§1–§7 是最初冻结的接口设计 |
| [x402-integration.md](./x402-integration.md) | x402 付费情报：Demo 与 Live（x402 V2）两种传输、服务目录、环境变量、威胁模型 |
| [acceptance.md](./acceptance.md) | 验收标准和对应的 harness 命令 |
| [final-acceptance-20261015.md](./final-acceptance-20261015.md) | 2026-10-15 开发交付验收、审查修复、最终检查及实链/人工边界 |
| [PRD.md](./PRD.md) | 产品需求文档（v0.2） |
| [tasks.md](./tasks.md) | 任务清单与状态（Agent 相关的 Done 标记以下一行的审计为准） |
| [agent-implementation-plan.md](./agent-implementation-plan.md) | Agent 全量实现规划：现状审计、目标架构、分阶段工作包与验收标准（开发中随时更新状态表） |
| [copilot.md](./copilot.md) | Phase 3 P0/P1：多轮偏好、检索排序、主动重排、确认动作、会话 API、验收和 Live 边界 |
| [document-extraction.md](./document-extraction.md) | WP2.2：PDF 文本层、可选视觉/文本模型、中文仓单、人工复核、安全和本地证据 |
| [compliance-screening.md](./compliance-screening.md) | WP2.3：版本化演示名单、模糊匹配、逐份单证/港口/IMO/HS 筛查、三态证据、复核与外部接口边界 |
| [live-opening.md](./live-opening.md) | WP2.4：Live 三步开盘提案、既有货物关联、owner CLI、逐步回执核验和中断恢复；实链交易未验收 |
| [live-settlement.md](./live-settlement.md) | WP2.6：USDC 规范链回执、精确金额、双证明与独立结算审批、持久防复用和 CLI/重启恢复；真实付款/owner 交易未验收 |
| [chain-watcher.md](./chain-watcher.md) | WP2.7：只读确认日志、持久游标、池发现/状态对账、独立紧急停止与 RPC/重组恢复；真实 RPC 长时间运行另需验收 |
| [agent-api.md](./agent-api.md) | WP2.9：五个无状态 PRD API、单证/定价/简报/图哈希、输入与资源限制；全项目 API 模型 x-test-2 |
| [frontend-acceptance.md](./frontend-acceptance.md) | WP4.6：全站中英/1440px/390px、键盘与焦点、通知播报、复现脚本和 40 个页面/弹窗组合的本地证据 |
| [phase4-console-demo.md](./phase4-console-demo.md) | Phase 4：五处证据 ID/历史报价联动、后台完整单证演示、停止与独立审批、模型用量、中英/窄屏及本地证据 |
| [phase5-security-replay.md](./phase5-security-replay.md) | Phase 5：红队、新鲜度、重放、隐私保留、65 项闸门及三笔测试网回执/重放验收 |
| [phase6-interoperability.md](./phase6-interoperability.md) | Phase 6：15 工具/5 资源、A2A 1.0 卡片与同步消息、Bazaar 声明、带交付证据的委托定价与 69 项闸门 |
| [phase7-decision-anchoring.md](./phase7-decision-anchoring.md) | Phase 7：独立合约、终态序号/Merkle 证明、审批承诺、恢复、只读校验；授权测试网部署初始化已核验，首批待授权，当前 71 项发布闸门 |
| [agent-security-matrix.md](./agent-security-matrix.md) | 自主级别、签名角色、动作、接口权限及人工恢复矩阵 |
| [agent-reliability.md](./agent-reliability.md) | Phase 5 P0：故障矩阵、重启/对账边界、真实组件评测、61 项发布闸门与后续入口 |
| [evaluation-report.md](./evaluation-report.md) | 可复现的本地确定性评测；代码与金标摘要、分母、失败样例及局限 |
| [Instruction.md](./Instruction.md) | 团队协作手册（原根目录 README） |
| [evidence/](./evidence/) | 链上证据（JSON）：Wave B 协议部署与冒烟、x402 实链冒烟、MCP 冒烟、precompile 探测。`npm run preflight` 会校验其中一部分 |

## 背景与设计

| 文档 | 内容 |
|---|---|
| [background.md](./background.md) | 给非贸易金融背景同学的入门材料 |
| [project.md](./project.md) | 项目一页纸介绍 |
| [ebl-marketplace-design.md](./ebl-marketplace-design.md) | eBL 市场与 AI 智能推荐的设计 |
| [enhancement-physical-ai-trust-insurance-zk(2).md](./enhancement-physical-ai-trust-insurance-zk(2).md) | 增强方案：物理 AI、信任网络、保险、零知识担保 |
| [ai-valuation-tooling.md](./ai-valuation-tooling.md) | AI 估值的 tool calling（铜货行情 + 历史成交价） |
| [xapi-integration.md](./xapi-integration.md) | xAPI 实时世界风险信号接入 |

## Injective 相关

| 文档 | 内容 |
|---|---|
| [wave-b.md](./wave-b.md) | Wave B：链上可信与 Agent 可组合（Gate B 的达成记录） |
| [injective-runbook.md](./injective-runbook.md) | Injective 工程手册（SP-4） |
| [injective-precompile-integration.md](./injective-precompile-integration.md) | Precompile 集成决策（SP-5 / SP-6） |
| [x402-spike.md](./x402-spike.md) | x402 兼容性 Spike（X402-1） |
| [injective-hackathon-gap-analysis.md](./injective-hackathon-gap-analysis.md)、[…analysis2.md](./injective-hackathon-gap-analysis2.md) | 新星计划的差距分析 |

## 路演与视频（面向评委）

[pitch-chinese.md](./pitch-chinese.md)、[pitch-script.md](./pitch-script.md)、[pitch-deck-outline.md](./pitch-deck-outline.md)、[pitch-deck-story-first-tob.md](./pitch-deck-story-first-tob.md)、[pitch-deck-story-first-tob-mystery-highlight.md](./pitch-deck-story-first-tob-mystery-highlight.md)、[demo-script.md](./demo-script.md)、[video-script.md](./video-script.md)、[video-script-final.md](./video-script-final.md)、[injective-video-script.md](./injective-video-script.md)、[award-roadmap.md](./award-roadmap.md)

## 阶段记录（历史，不再更新）

这些文档记录了某个时间点的完成情况，数字（测试数量、合约地址、状态）可能已经过时；以代码、`public/chain-config.json` 和上面的现行参考为准。

[Notes.md](./Notes.md)、[Improvements-Summary.md](./Improvements-Summary.md)、[BE-FE-11-15-Review.md](./BE-FE-11-15-Review.md)、[SP-8-9-10-Summary.md](./SP-8-9-10-Summary.md)、[Wave-C-Summary.md](./Wave-C-Summary.md)、[Wave-ABC-Complete.md](./Wave-ABC-Complete.md)
