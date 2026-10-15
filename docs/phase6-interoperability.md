# Phase 6：MCP、A2A 与付费服务发现

2026-10-15。本阶段实现 WP6.1–WP6.4；最终检查与证据由 [完成清单](evidence/phase6-completion.json) 记录。当前接口为 **15 tools + 5 resources**，A2A **1.0 JSONRPC 同步消息**，以及四个付费服务的 Bazaar HTTP 声明。外部 Agent 可获得确定性的指示性报价，附加服务器已经交付的 x402 报告来源；支付本身不改变风险、价格或执行权限。

## 使用现有运行时

先启动应用，再连接 stdio。stdio 新工具通过固定后端接口调用同一个 AgentService/Copilot，不创建另一份运行时、不启动监听任务、不打开私有运行文件、不加载 `.env` 或签名账户。原有九个离线工具仍可单独使用；新增六个工具及两个运行时资源需要后端可达。后端不可用时明确失败。新增工具与运行时资源把未预期的存储/提供方异常映射为通用错误，不向客户端暴露主机路径或内部消息；已知输入、审批和付款证据错误保留可用的错误码。

```bash
npm run dev
# 另一终端；只读 SDK 示例，不提交事件，不购买报告
npm run interop:demo -- --url http://127.0.0.1:3000 --case CASE-EBL-2026-CU-SG-SHA
# 已交付且未过期的报告可按 id 附加；不会再次收费
npm run interop:demo -- --url http://127.0.0.1:3000 --case CASE-EBL-2026-CU-SG-SHA --report-id rpt_<64位十六进制>
```

外部 MCP 主机的示例配置（按本机仓库位置修改 `args`）：

```json
{
  "mcpServers": {
    "agentbl": {
      "command": "node",
      "args": ["E:/NUS/BlockChain/Project/Agent-BL-Upgrade/src/mcp/standalone-server.js"],
      "env": { "AGENTBL_MCP_API_URL": "http://127.0.0.1:3000" }
    }
  }
}
```

`AGENTBL_MCP_API_URL` 默认 `http://127.0.0.1:3000`。远程连接要求 HTTPS；拒绝 URL 用户名、密码、路径、查询串、片段和重定向。后端调用有 15 秒超时、4 MiB 流式响应上限；输入在递归校验前限制为 1 MiB、20 层、20,000 项。对外列表最多每页 200 条，recent 资源固定最多 20 条。

## MCP 表面与审批

原有工具：`get_trade_case`、`generate_pricing_quote`、`simulate_offering`、`push_pricing_to_oracle`、`search_knowledge_base`、`verify_trade_documents`、`purchase_premium_analysis`、`preview_mystery_voyage`、`verify_mystery_reveal`。

| 新工具 | 行为与边界 |
|---|---|
| `get_agent_status` | 当前运行状态、模式、队列、自主级别和签名角色是否配置；不启动运行时 |
| `list_agent_decisions` | case/pool/status/action 过滤、分页、引用；剔除私有重放快照 |
| `explain_decision` | 读取已记录的策略、证据、引用和可用追踪；不重跑模型或执行 |
| `submit_agent_event` | 默认 dry-run，仅规范化与验证，不入队；真正提交须 `dry_run=false`、`approved=true` 和正确的带外 `MCP_HUMAN_APPROVAL_TOKEN` |
| `recommend_trade_assets` | 复用现有 Copilot 的硬约束、排序、澄清和解释；不持久化会话、不认购或付款 |
| `delegate_pricing` | 根据 `case_id` 或 `case_data` 二选一返回报价；可附 `paid_report_ids`；无 LLM、付款或链上动作 |

新增资源 `agentbl://agent/policy` 和 `agentbl://agent/decisions/recent`，连同原有 cases/catalog、risk/methodology、contracts/deployments 共五个。策略资源还可通过公开的 `GET /api/agent/policy` 读取。

事件来源被服务器固定为操作员。带外令牌只授权提交事件，不授权审批决策、调用 owner CLI 或广播交易；Live 继续使用 `LIVE_ADMIN_EVENT_TYPES` 限制和原有证据核验、模式检查、策略/人工审批。Demo 入队后则可能依其自主级别执行模拟动作。不要把令牌写在模型提示、单证或公开配置里。

`recommend_trade_assets` 继承后端 Copilot 的模型配置；本次验收关闭真实提供方。输入 `session_id`、自动购买或其他未声明字段会被拒绝。报价委托始终使用确定性计算。

## A2A 1.0 Agent Card 与消息

实现前核对 [A2A 官方规范](https://a2a-protocol.org/latest/specification/) 和 [1.0.0 发布源码](https://github.com/a2aproject/A2A/tree/v1.0.0/specification)。规范来源与摘要见 [phase6-spec-sources.json](evidence/phase6-spec-sources.json)。

标准发现地址为 `GET /.well-known/agent-card.json`；计划中的 `GET /.well-known/agent.json` 返回同一对象。卡片使用 `supportedInterfaces[].url/protocolBinding/protocolVersion`，而不是旧版顶层 `url`、`protocolVersion` 或 `preferredTransport`。仅声明已实现的 `delegate_pricing` A2A 技能、JSON 输入/输出与 JSONRPC 接口；`streaming`、`pushNotifications`、`extendedAgentCard` 均为 false。MCP 工具、接口、安全边界与 x402 服务价格放在显式的 `urn:agentbl:interop:v1` 扩展中。

`AGENTBL_PUBLIC_BASE_URL` 配置公开 HTTPS origin；本地开发默认使用监听端口的 localhost。兼容已有 `X402_PUBLIC_BASE_URL`，同时配置时前者优先。卡片和发现目录不信任请求的 Host 或转发头。反向代理部署必须设置公开 origin，否则卡片会保留本地开发地址。

```http
POST /api/a2a
Content-Type: application/json
A2A-Version: 1.0

{
  "jsonrpc": "2.0",
  "id": "quote-1",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "external-message-1",
      "role": "ROLE_USER",
      "parts": [{ "mediaType": "application/json", "data": {
        "case_id": "CASE-EBL-2026-CU-SG-SHA", "payout_speed": "FAST"
      } }]
    }
  }
}
```

响应为 JSON-RPC `result.message`：`ROLE_AGENT`、唯一 messageId/contextId 和一个 JSON data part。同步直接消息不创建 Task；没有任务存储、流式任务、多轮历史、推送通知或远程文件抓取。只接收一个结构化 data part，不接收 URL、文件或自然语言执行指令。缺失版本头按规范视为旧 0.3，本接口返回 `-32009`，客户端必须发 1.0。错误分别覆盖解析 `-32700`、请求 `-32600`、方法 `-32601`、参数 `-32602`、输出类型 `-32005` 和内部错误 `-32603`；内部异常不泄露具体消息。

同一报价也可通过 `POST /api/agent/delegate-pricing` 或 MCP `delegate_pricing` 获取。三种入口共用实现、输入 schema 和结果承诺。公开输入 JSON Schema 为 `GET /api/interop/schemas/delegate-pricing`。仅指示性计算，不能以返回的 OPEN/PAUSE 等定价动作字段作为执行授权。

## x402 Bazaar discovery

实现前核对 [官方 Bazaar 文档](https://docs.x402.org/extensions/bazaar) 和 [x402 Foundation 扩展源码](https://github.com/x402-foundation/x402/tree/main/typescript/packages/extensions/src/bazaar)。

`GET /api/x402/discovery` 与 `GET /discovery/resources` 提供同一资源服务器目录，支持 `type=http|mcp`、`limit=1..100`、非负 `offset`。当前只发布 HTTP 资源，查询 MCP 类型返回空列表。它不是 facilitator，也不声称已被任何外部 Bazaar 收录。

四个目录项使用 `extensions.bazaar.info.input` 的 `type=http`、`method=POST`、`bodyType=json`、`body`，以及 Draft 2020-12 schema。前三项接收 `{ "case": <完整 TradeCase> }`，省略则使用 demo fixture；单独提供 `case_id` 不会选择案例。Mystery 需要先取得 preview 的 reveal_id，再生成 user_nonce；目录只描述这一输入，不生成虚假 preview 或结果。

Live 目录的 `accepts` 与真实 V2 402 body/header 使用同一函数生成：network、asset、原子金额、payTo、超时和 EIP-3009 extra 一致；四个服务分别为 0.001 / 0.002 / 0.0015 / 0.001 USDC。V2 402 响应也携带 Bazaar 声明。Demo 仍使用现有 personal_sign 模拟流程；目录明确 `mode=demo`、`paymentProtocol=agentbl-demo-personal-sign` 且 `accepts=[]`，不会让客户端把模拟流程识别成可支付的 Live V2。目录结构的 `x402Version=2` 不表示 Demo 已有真实结算。

没有调用 facilitator 注册接口、真实支付、真实行情/合规提供方或链上写入。提供方与集市是否实际索引这些描述需要部署后的独立证据。

## 委托报价与购买证据

委托接口仅接收 `request_id`、`case_id`/`case_data`、`payout_speed`、`min_acceptable_issue_price`、最多三个 `paid_report_ids`。未知字段、缺少/同时提供两个来源、非法数值、过深输入和不存在案例都会拒绝。接口与 A2A 使用 `AGENT_API_RATE_LIMIT_PER_MIN`；报价共用 `AGENT_API_MAX_CONCURRENCY` 限制，包括经 MCP 到达的报价。

报价复用 WP2.9 `price-rwa` 的输入/单证一致性/演示合规评估和唯一的 pricingEngine。保持 HOLD_FOR_REVIEW / REJECT、caller-supplied / registry_verified=false、indicative_only=true。返回原始输入承诺 `input_hash`，以及覆盖报价和评估的规范 JSON `result_hash`。不推断汇率、不授予开盘或链上权限。

购买报告由独立 x402 流程完成。`paid_report_ids` 只从当前服务器的交付缓存读到实际 envelope，再核对 schema、报告承诺、案例和有效期；不接受任意外部 envelope 作为付款证明。重复 id 合并，过期、未缓存、跨案例或篡改均拒绝。报告加入 evidence_graph/evidence_hash，但 quote_hash、风险、折扣和价格保持不变。

`payment_evidence` 明示 `source=server-delivery-cache`、Demo/Live 和 `onchain_reverified=false`。这证明服务器曾交付该报告，不等同于本次重新读取实链回执；缓存未承诺同一案例的所有字段与本次输入完全相同。委托会返回 payment/chain execution 均为 false。

## 验证与交付

`tests/agentInterop.test.js` 覆盖规范字段、三入口数值与哈希一致性、真实不一致/合规阻断、付费证据中立与拒绝路径、事件权限/Live 限制、输入/并发/限流、后端丢失和错误隐私。`tests/mcpProtocol.test.js` 使用官方 SDK 的独立 stdio 子进程连接同一个隔离后端，逐一调用 15 个工具、读取 5 个资源，并走实际 Demo 402 → 签名 → 交付 → 带证据委托报价。

完整 SDK 付费路径暴露 fraud-review 对新版融资案例仍调用旧 LTV 校验的问题。报告已按融资模型选择既有 pricing-v2/legacy 工作流，保留实际模拟步骤；新版无旧合约动作时明确 null，单独返回 pricing_action。首轮交付失败记录保留，不把模拟付款冒充真实交易。

发布总闸门还检出 `scripts/smoke.mjs` 遗漏的 9 工具断言，已同步为 15；首轮 63 PASS / 5 SKIP / 1 FAIL 的原始日志保留。

旧 manifest 测试从“每个工具必须有参数”改为检查 schema 的 required 字段确实被声明；无参数 `get_agent_status` 明确接受空对象并拒绝额外字段。原有未知工具检查也拒绝对象原型成员。覆盖率阈值不变。

preflight 扩为 **69 项**，新增运行时 MCP dry-run、A2A 卡片、Bazaar 目录和跨接口委托一致性四项。最终测试/覆盖率、SDK 例程、浏览器观察与工具限制分项保存在阶段证据中；未提交、未推送，原有 dirty 改动和所有失败尝试保留。下一入口是 Phase 7 WP7.1 的设计与本地实现，合约部署仍按原计划逐笔确认。

最终冻结验证：**1179/1179 Node**、**75/75 本地合约测试**、**20/20 质量闸门**、**261 项浏览器检查**；覆盖率 **94.42% 行 / 84.70% 分支 / 92.40% 函数**，preflight **64 PASS / 0 WARN / 5 Live SKIP / 0 FAIL**。最后增加 MCP 未预期异常的错误脱敏及专项回归后，完整 Node、覆盖率和总闸门再次通过。源码摘要 `9e0555b2a588ffe490fbcbe1e389174521cbc12669144410bfd076c28926a5ac`，2389 个源文件逐一复核。浏览器成功路径在错误脱敏前验证，前端文件未编辑；内部窗格控制与人工验收仍未确认。首轮浏览器失败及所有旧检查保留，见 [尝试历史](evidence/phase6-attempt-history.json)。
