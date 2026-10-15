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

实际输出见 [evaluation-report.md](evaluation-report.md) 与 [evidence/agent-eval.json](evidence/agent-eval.json)。首轮评测暴露英文日期在新加坡时区提前一天、`Miranda` 被子串 `iran` 误阻断；修复前证据 保留原测量，当前金标和跨时区/关键词回归测试保留原来的正确标签。修复没有改成回抄答案，也没有降低阈值。

这些结果不证明 OCR/视觉、正式制裁筛查、真实行情、任意注入攻击的安全、生产投资适合性或官方 Amazon 检索基准。可选 LLM 路径调用现有兼容客户端，显示模型路径/确定性回退计数；本阶段未运行它。

## 测试

```text
node --test tests/agentReliability.test.js
npm run eval:agent -- --check
```
