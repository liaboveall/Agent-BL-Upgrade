# Agent 可靠性与评测（Phase 5 P0）

2026-10-13：WP5.4、WP5.1、WP5.8 已完成本地确定性验收。真实 LLM、真实链上冒烟、用户人工试用和远端 CI 分别需要自己的证据。

## 故障矩阵

`tests/agentReliability.test.js` 的 15 个测试使用可注入时钟、假 RPC/合约和内存或临时持久化目录，不读取开发者密钥、不向真实提供方发请求。

| 情况 | 必须观察到的行为 |
|---|---|
| 风险事件乱序 | WORLD_RISK_UPDATED 与 RISK_CLEARED 共用时间高水位；迟到的解除不会撤销较新的暂停。旧索引自动合并高水位；付款、到港等独立事件保持独立顺序 |
| 重复事件、并发批准 | 同一事件只有一个决策/审批；同一审批只有一次执行 |
| 执行中重启 | 已保存哈希的 EXECUTING 决策在 tick 时只查回执；重启及并发 tick 都不能重发 |
| RPC 在发送前超时 | 有上限地重试；持续不可用会明确 FAILED，不会模拟成成功 |
| RPC 在发送后超时 | 保留 EXECUTING、哈希和 pending；回执查询暂时不可用也保留待对账状态 |
| 缺少广播哈希 | 定价动作只读查询该命令的精确 oracle 防重放 ID；已处理才恢复。仍无法确认时保留 reconciliation_required，禁止自动重发 |
| LLM / xAPI 不可用 | 意图与显式数值使用确定性解析；世界风险使用明确标注的 fixture。夹具仍不作为实时定价证据 |
| 交易 revert | 已知失败回执使决策和审批 FAILED，保留错误，不重试资金或状态动作 |
| nonce 冲突 | 仅已确认 NONCE_EXPIRED 的发送错误允许重新读取 nonce 后有上限地重试；未知发送结果不自动重发 |
| 审批过期 | 注入时钟驱动审批 EXPIRED 和决策 SKIPPED；即使 approve 先发现过期，下一 tick 也同步决策 |
| 模式及世代切换 | 排队事件和旧审批失效；发送前再次校验。已经广播的 Live 事实可以记入原 Live 决策，不能改变新 Demo 的池子 |

周期性恢复在 `tick` 中执行；控制台“立即 tick”也走同一路径。APPROVED 已落盘、EXECUTING 尚未落盘的动作可以在下一 tick 继续；owner 路线恢复到等待本机签名，服务器不会替 owner 签名。

已确认的决策如果遇到独立审批存储写入中断，会保持已确认事实，下一 tick 从决策修复审批检查点，不发第二笔交易。防重放事件回读还核对池 ID、价格、动作和两份证据哈希，避免把相似事件的交易归给当前决策。

`reconciliation_required` 表示广播结果无法确认，不能据此重新批准、重放或改账。应由运维核对部署网络、oracle 防重放记录及签名钱包交易记录。没有足够链上证据时保持未确认；本阶段没有新增绕过校验的“强制成功”入口。非定价动作缺少哈希时仍需人工对账。

Demo 池与认购仍是内存状态，重启会清空；本次重启测试证明的是决策、审批和 Live 交易恢复协议，并未证明 Demo 池持久化或真实 RPC 可用。

## 真实组件评测

```bash
npm run eval:agent                 # 重新测量并写入报告与 JSON
npm run eval:agent -- --check       # 只测量和检查阈值，不覆盖报告
npm run eval:agent -- --live-llm    # 人工调用可选提供方路径；LLM 指标不阻断 CI
node --test tests/agentReliability.test.js
npm run preflight -- --report docs/evidence/agent-phase5-preflight.json
```

确定性评测调用实际的单证解析、一致性、合规、定价、Copilot、九步接入流水线及 Demo 场景运行时。金标不会传给组件；输入经深拷贝、标签键检查和冻结。测试会篡改金标、替换为空解析器和拒绝所有单证的组件，验证输出不会跟着答案改变，质量闸门也不能因此全绿。

评测包含 19 份文本/空白扰动单证（82 个标注字段）、10 个一致性样例、20 个三态合规样例（WP2.3 新版，旧版记录保留）、固定种子 150 个定价案例的 1,350 次检查、三个完整自主循环、44 段中英文多轮对话（100 轮）、六个分级相关度排序查询、16 个注入样本和一个干净对照。44 段对话来自 22 个情境的双语配对，空白扰动也与原文相关；它们不是独立的泛化样本。

冻结阈值在 `src/agent/evaluation/dataset.js`，所有 19 个确定性阈值由 `npm test` 强制执行。抽取只评人工标注字段，不为未标注字段虚构准确率；一致性按问题 ID 算 P/R；推荐约束使用独立判定器；NDCG 使用人工相关度，重复候选不能重复得分。报告包含日期、Git 基线、dirty 状态、实际工作区文件摘要、数据集摘要、分母、失败样例和局限。

实际输出见 [evaluation-report.md](evaluation-report.md) 与 [evidence/agent-eval.json](evidence/agent-eval.json)。首轮评测暴露英文日期在新加坡时区提前一天、`Miranda` 被子串 `iran` 误阻断；[修复前证据](evidence/agent-eval-before-fixes.json) 保留原测量，当前金标和跨时区/关键词回归测试保留原来的正确标签。修复没有改成回抄答案，也没有降低阈值。

这些结果不证明 OCR/视觉、正式制裁筛查、真实行情、任意注入攻击的安全、生产投资适合性或官方 Amazon 检索基准。可选 LLM 路径调用现有兼容客户端，显示模型路径/确定性回退计数；本阶段未运行它。

## 发布闸门与浏览器证据

preflight 固定 **61** 项：增加运行时启停、故障矩阵、三个 Demo 故事、实测质量阈值和禁止伪造检查；MCP 仍为 9 tools + 3 resources。Demo 的 Live 专属检查记 **SKIP**。子测试进程清除提供方设置，并由 Node 自己设置测试 worker 标记；全量测试必须实际执行、全部通过且零跳过/取消，不能只看 exit 0。

Windows 下直接执行包含空格路径的 `node.exe`，仅 npm.cmd 后备启动才使用 shell。四个旧 API 测试已从固定 8081–8084 端口迁移到 `listenOnUsablePort`，避免两个验证进程相互冲突。

第一轮内部 preflight 因程序路径启动失败而未通过，且当时子测试环境标记导致 Node 跳过了测试；其历史 [JSON](evidence/agent-phase5-preflight-before-fix.json) **不能作为通过证据**。当前实现显式拒绝没有实际测试计数的执行。最终结果 **56 PASS / 0 WARN / 5 SKIP / 0 FAIL** 见 [当前 preflight JSON](evidence/agent-phase5-preflight.json)。

浏览器使用本机 Edge 的独立 Playwright 会话，验证真实服务器上的铜场景、付款/结算分别批准、七条 Demo 决策、详情及 Escape、中英切换、390px 无横向溢出和启停；Windows curl 同时验证本机入口。Codex 的浏览器面板打开请求返回 queued，因此不声称完成面板控制或用户人工试用。页面脚本错误为零；初次导航有 favicon.ico 404。全站国际化、浮动终端遮挡、无障碍与移动端完整审计仍由 WP4.6 承担。

完整验收记录见 [evidence/agent-phase5-local.json](evidence/agent-phase5-local.json)，截图见 [桌面](evidence/agent-phase5-desktop.png)、[英文窄屏](evidence/agent-phase5-mobile-en.png) 和 [中文窄屏](evidence/agent-phase5-mobile-zh.png)。这些截图是自动化浏览器的本地证据。

## 后续入口与提交建议

WP4.6 和后续 P1 WP3.6/WP3.8/WP0.6 均已于 2026-10-13 完成本地验收，见 [frontend-acceptance.md](frontend-acceptance.md)、[copilot.md](copilot.md) 和 [wave-b.md](wave-b.md)。WP0.6 另有只读实链复核，后续 WP2.2 已完成 PDF/可选视觉/仓单本地验收，见 [document-extraction.md](document-extraction.md)；WP2.3 的版本化演示合规已完成本地验收，见 [compliance-screening.md](compliance-screening.md)；WP2.4 Live 开盘提案与 owner CLI 已完成本地链桩验收，见 [live-opening.md](live-opening.md)；WP2.6 的规范 USDC 回执、持久防复用、链上双证明及结算恢复已完成本地验收，见 [live-settlement.md](live-settlement.md)；WP2.7 的确认日志、游标和状态/紧急停止对账已于 2026-10-15 完成本地自动化验证，见 [chain-watcher.md](chain-watcher.md)。WP2.9 五个无状态 PRD API 已于 2026-10-15 完成本地实现：54 项新增行为测试、全量覆盖率执行 1115/1115、54 项浏览器检查；全项目 API 模型统一为 `x-test-2`，真实提供方未复验，详见 [agent-api.md](agent-api.md)。下一入口为 WP4.4 ID 贯通。真实 RPC 长时间运行、Live 钱包、付款与 owner 路径仍有独立验收边界；真实链上写入逐笔遵守实施规划 §16。

本地验收记录在提交前生成，保留当时的未提交快照。用户已于 2026-10-13 授权提交并推送；按依赖分为：① `feat(agent): harden event ordering and execution recovery`；② `feat(eval): measure Agent components against isolated gold fixtures`（含评测发现的解析/合规修复）；③ `test(release): gate agent reliability and measured quality`（含文档与验收证据）。具体提交、远端一致性与 CI 结果以本次 Git 操作和对应提交的 Actions 运行记录为准；部署不包含在该授权内。

## 2026-10-15 Phase 5 P1 增量

红队变异、新鲜度、只读决策重放、递归脱敏/认证加密、保留与权限矩阵已落地，preflight 扩为 65 项。原文的 61 项和 19 个评测阈值描述历史 P0；当前生成变异检测率加入第 20 个闸门。完整实现、验证、真实链上冒烟的授权入口和证据边界见 [Phase 5 指南](phase5-security-replay.md)。

2026-10-15 Phase 6 再扩为 **69 项**：MCP 表面更新为 **15 tools + 5 resources**，增加共享运行时与事件 dry-run、A2A 1.0 卡片、Bazaar 模式边界和三入口报价一致性。旧的 61/65 项记录保留为历史。外部 Agent 不启动第二份运行时；事件令牌与决策/链上审批是分开的权限，见 [Phase 6 指南](phase6-interoperability.md)。
2026-10-15 Phase 7 发布闸门为 **71 项**，加入终态决策锚定/审批/连续序号/重启恢复与链上回执/共用签名队列/部署默认 dry-run 两组行为套件。定稿归档失败不会改写已经确认的执行，清理原日志前先补齐归档；未知广播只读恢复。实际部署和首批锚定另行授权，见 [Phase 7 指南](phase7-decision-anchoring.md)。

Phase 7 验收固定 Node 测试并发为 4，参数放在文件列表之前；coverage 的 88/72/86 门槛不变。完整 coverage、评测和 preflight 串行运行，避免资源竞争造成假超时。preflight 中完整 Node 套件的进程上限为 10 分钟，其余命令仍为 3 分钟；断言及完整执行检查不变。
