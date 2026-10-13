# 📚 AgentBL 文档索引

仓库根目录的 [`README.md`](../README.md) 是总览和快速开始。这里按用途列出 `docs/` 里的文档，并标出哪些是**现行的参考**，哪些是**某一阶段的记录**（写的时候是对的，之后代码继续演进，不再更新）。

## 现行参考（会随代码更新）

| 文档 | 内容 |
|---|---|
| [DEPLOYMENT.md](./DEPLOYMENT.md) | 部署指南：Docker / PM2 + Nginx / Railway、环境变量、安全与上线检查、合约重新部署 |
| [contracts.md](./contracts.md) | 合约：**§0 是当前 v2 实现**（权限、状态机、动作码、测试、已知限制、部署状态）；§1–§7 是最初冻结的接口设计 |
| [x402-integration.md](./x402-integration.md) | x402 付费情报：Demo 与 Live（x402 V2）两种传输、服务目录、环境变量、威胁模型 |
| [acceptance.md](./acceptance.md) | 验收标准和对应的 harness 命令 |
| [PRD.md](./PRD.md) | 产品需求文档（v0.2） |
| [tasks.md](./tasks.md) | 任务清单与状态（Agent 相关的 Done 标记以下一行的审计为准） |
| [agent-implementation-plan.md](./agent-implementation-plan.md) | Agent 全量实现规划：现状审计、目标架构、分阶段工作包与验收标准（开发中随时更新状态表） |
| [copilot.md](./copilot.md) | Phase 3 P0/P1：多轮偏好、检索排序、主动重排、确认动作、会话 API、验收和 Live 边界 |
| [document-extraction.md](./document-extraction.md) | WP2.2：PDF 文本层、可选视觉/文本模型、中文仓单、人工复核、安全和本地证据 |
| [frontend-acceptance.md](./frontend-acceptance.md) | WP4.6：全站中英/1440px/390px、键盘与焦点、通知播报、复现脚本和 40 个页面/弹窗组合的本地证据 |
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
