# 投资者 Copilot（Phase 3 P0 / P1）

2026-10-13：搜索和悬浮助手使用同一套服务器检索与排序。搜索每次创建独立单轮会话以接收风险更新，助手保留多轮偏好；两者不会互相覆盖。WP3.6 主动重排和 WP3.8 确认卡片已完成本地实现与验收，真实 Live 钱包交易仍待用户按实施规划 §16 执行。旧市场搜索接口保留兼容。

可在 Demo 模式依次输入：

1. `铜，预算1000美元`
2. `收益至少8%`
3. `算了，换成铝`
4. `不要铝，避开霍尔木兹`
5. `重新开始`

换货物时，货物条件被替换，针对前一货物的港口条件清空；风险、收益、期限和预算继续保留。追加约束只会收紧风险、最低收益、最长期限、融资规模和保险覆盖；用“改成 / instead”可以替换指定维度。否定条件会移除冲突的选择条件。界面显示当前条件与变化后的结果。

候选取自服务器当前池及报价镜像，不使用目录中的静态风险提示。硬约束包括风险、最低毛收益、期限、货物、地区或港口、避开的航道、投资额、融资规模、保险覆盖和回款速度。缺少期限或保险数据的标的不能通过相应硬约束。已结束、合规阻断或被 Agent HOLD/REJECT 的标的会被排除；暂停、数据过期或合规待复核会扣分并显示告警。BM25 做文本匹配，探索请求用 MMR 增加货物和航线多样性。相同分数按池 ID 稳定排序。

评分显示收益、风险、偏好匹配、抵押覆盖和状态扣分。推荐携带当前 `quote_hash`、相关 `decision_id` 和情报证据；离线风险情报明确标为 fixture，只作解释参考。毛收益未年化，不是收益承诺。服务器当前池是链下镜像，不能据此声称读取了链上持仓或状态。

配置 LLM 后，模型可辅助理解口语和写解释，输出经过 zod 校验。明确数值取自确定性解析，模型不能添加或替换数值限制。无模型、关闭模型、繁忙、超时、无效 JSON 或解释数字无法核对时，使用确定性解析或模板。当前区间约束（如收益 8%–12%）要求澄清为最低收益、最长期限或单一投资额，不会默默丢掉区间的一端。

| 接口 | 行为 |
|---|---|
| `POST /api/copilot/sessions` | `{locale: "zh" 或 "en"}`，创建会话 |
| `GET /api/copilot/sessions/:id` | 读取结构化偏好 |
| `DELETE /api/copilot/sessions/:id` | 删除会话；正在处理的请求不能将它恢复 |
| `POST /api/copilot/sessions/:id/messages` | `{message, locale?, limit?, pool_ids?, service_id?}`，多轮；同一会话串行处理 |
| `POST /api/copilot/query` | 相同输入，无状态单轮 |
| `GET /api/copilot/sessions/:id/stream` | `COPILOT_RERANK`；支持 `Last-Event-ID` 或 `last_event_id` |
| `PUT /api/copilot/sessions/:id/watchlist` | `{pool_ids: [...]}`，最多 30 个已知池 |
| `POST /api/copilot/sessions/:id/actions/:actionId/confirm` | `{confirm:true, wallet_address?}`，重新检查当前卡片；Live/报告返回准备信息 |
| `POST /api/copilot/sessions/:id/actions/:actionId/cancel` | 取消尚未开始的卡片，不执行 |
| `POST /api/pool/subscribe` | Copilot Demo 确认：`{confirm:true, copilot_action:{session_id,action_id}, wallet_address?}`；金额与池子取已保存卡片 |

消息使用 `Accept: text/event-stream` 时按 `result → narrative → done` 返回：先显示结构化卡片，再显示完整、通过数字核对的解释。服务中断、会话过期或模式变化不会当成成功完成。TTL 默认一天，上限默认500个活跃会话；存结构化约束、意图增量、公开候选词汇中的检索词项、排序摘要、最新变更快照和有界动作卡片，不存聊天原文或钱包。切换模式或重置 Demo 会使旧会话失效。

单证页面已改为上传真实内容，并展示作业步骤、抽取字段、来源行号、方法、置信度和相关决策。HOLD 作业的“提交修正单证”会创建新作业和 `REVIEW_RESOLVED` 事件，再跑全部检查，保留原 HOLD 证据；恢复以前用过的正确内容也会创建独立复核作业，相同补件重复提交则返回同一作业。WP2.2 已接入 PDF 文本层/来源页码与可选图片视觉抽取；扫描 PDF 的 OCR 仍未实现，图片结果始终人工复核，详见 [document-extraction.md](document-extraction.md)。市场的“模拟认购”在 Demo 下向服务器记录持仓并显示服务器实际价格/份额；市场和助手的持仓都读取 `/api/investors/portfolio`，显示原始成本、来源、当前池状态/价格/风险和关联决策。这些 Demo 持仓在重启后清空。

### 主动重排与确认动作（WP3.6 / WP3.8）

影响上次推荐或关注池的决策会用原条件重新检索排序，推送原/新排名、报价、原因和 `decision_id`。被硬约束移出列表的池仍被跟踪，后续恢复能重新进入。重排不调用 LLM、不改偏好，也不延长 TTL。前端显示更新和决策链接并保留键盘焦点。搜索和助手同时订阅时保留同一决策的首次变化基线，确认通知不会把排名下降覆盖成空变化。

流按会话隔离；Copilot 流数量使用现有 `AGENTBL_MAX_SSE_CLIENTS`，默认 200。删除、过期、Demo 重置关闭流；慢客户端关闭连接后续接。续接只发最新已持久化快照及其序号，合并中间变化，不提供逐条历史通知。快照的 `at` 是当时计算时间；它不恢复已清空的 Demo 持仓，也不替代链上镜像监听（WP2.7）。

先输入 `铜，预算1000美元`，再输入 `认购1000美元`。标的不唯一时需先选择池子，金额缺失时需填写。卡片列出金额、单价、份额和风险披露，五分钟有效；用户确认才执行，取消不创建持仓。认购仅生成份额凭证，现有合约不收取认购款、不托管资金，也不分配兑付款；Live 钱包交易仍消耗 gas。预算是单次动作上限，不是跨动作/跨会话累计支出额度。

确认重新检查会话、模式、报价哈希/价格、容量、预算、合规及单证 HOLD。新消息取代旧卡片，旧 ID 不能执行；Demo 重复确认返回同一收据，持仓来源为 Copilot。Demo 的 `Open`、`Repriced`、`Subscribed` 可认购，与合约一致。

Live 卡片只用于已映射池：先读链上报价、状态和剩余份额，整数份额向下取整。钱包检查部署、网络、账户、资格与停机状态，模拟调用后才广播；匹配合约、池、投资者、份额和价格的 `Subscribed` 回执才显示确认。现有 `subscribe` 无价格上限参数，读取与挖矿之间的价格变化不能在合约内原子拒绝；不匹配回执需对账，不自动重发或回落 Demo。Live 持仓 API 没有因此完成。

`买估值报告` / `buy a valuation report`，以及风险、反欺诈报告取服务目录价格；确认后走现有 Demo smoke 或 Live V2 钱包路径。Demo 显示 `demo:x402:` 收据并移除旧接口合成交易哈希；报告与完成状态支持语言切换。Live/report 确认置为 `CONFIRMING`，阻止重复准备；服务器此状态本身不证明支付或链上完成。V2 仍核对 challenge 数额、网络和签名账户。

### 测试

```text
node --test tests/copilotService.test.js tests/copilotApi.test.js tests/copilotRerank.test.js tests/copilotActions.test.js tests/copilotFrontend.test.js
```
