# Phase 5：评测、安全、可靠性与决策重放

2026-10-15。Phase 5 本阶段范围全量完成：补齐 WP5.2 / 5.3 / 5.5 / 5.6 / 5.7，复验 WP5.1 / 5.4 / 5.8，并按用户本次授权完成 WP5.9 的三笔真实测试网定价交易。完成清单、本地证据 与 [实链证据](evidence/agent-live-smoke.json) 分别记录范围、检查与回执。真实模型和用户人工验收仍有独立状态。

## 红队与评测

`src/agent/redteam/generator.js` 以明确的 seed、案例、单证和时间生成确定性变异：一货多单、金额/数量冲突、保险到期/覆盖不足、演示名单港口、十种中英文/混淆字符注入和过期数据。17 个变异由实际组件检测，金标只留在评分端。生成的注入进入原有隔离金标评测，完整变异另计检测率；阈值保持先冻结再测量。

```bash
npm run agent:redteam
npm run scenarios
npm run eval:agent -- --check
```

当前评测含 26 个注入样本和 17 个生成变异；44 段双语对话、100 轮、1,350 次定价检查仍保留。20 个确定性闸门要求注入攻击成功率为零、生成变异检测率为 1。有限合成样本不能证明任意攻击安全，演示合规不能冒充官方制裁筛查。真实 LLM 评测仍需单独人工运行 `--live-llm`，本批没有向提供方请求。

## 新鲜度与恢复

逐份上传、事件及风险证据保留 `observed_at` / `expires_at` / `source_status`。来源为 live / fixture，过期、非法/未来时间和不可用来源在决策中显示 stale。Live 评估使用源信号的发布时间；重复拉取旧新闻不能刷新观察时间。夹具回退不允许推进 Live 的风险解除滞回。单证接入不把过期实时情报计入价格，转人工复核。

过期证据不会自动改价、暂停或恢复；已有提案在批准和执行前再次检查。审批到期、模式世代变化、未知广播和 nonce/RPC 故障保持原有恢复协议。Demo 场景使用明确的虚拟证据时钟；人工等待时间仍会消耗有效期。

## 决策重放

```bash
npm run agent:replay -- --decision decision_...
npm run agent:replay -- --decision decision_... --file /absolute/path/agent-decisions.json
```

HTTP：`GET /api/agent/decisions/:id/replay`。Demo 可读，Live 需要管理员。控制台决策详情的“重放校验 / Replay decision”支持键盘，展示 PASS/FAIL 和逐项结果。

重放使用保存的事件、池状态、结构化单证字段、定价选项和组件结论重新执行确定性决策/定价，比较输入承诺、动作、决策 ID、证据哈希、报价哈希及历史报价内容。不访问当前池、模型或 RPC，不排事件、不创建审批、不执行交易。篡改已保存的字段或哈希会 FAIL。旧记录没有完整快照时明确 `snapshot_unavailable`；不使用当前状态补造历史。重放不重新运行原文/OCR/模型抽取，也不是链上防篡改锚定（WP7.1）。

## 隐私和保留

决策/活动/追踪字段递归脱敏：密钥、认证字段、自由文本中的 `sk-` 与私钥形态、完整钱包和源文档内容。真实证据哈希、交易哈希、事件引用和交易浏览器链接仍可验证。必要的完整操作输入仅保存在经认证的 AES-256-GCM 快照中；没有 key 或认证不一致会拒绝加载。运行时队列和审批的操作快照也加密；公开详情里的审批信息脱敏。

tick 按 `AGENT_MAX_DECISIONS` / `AGENT_RETENTION_DAYS` 清理终态决策、完成事件、终态审批、活动和轮转追踪。未决/待对账记录与死信保留，SSE 序号有独立检查点。原始上传保存在私有 `uploads/` 目录用于重跑；本批不把日志保留时间误作上传删除授权。权限与部署边界见 [权限矩阵](agent-security-matrix.md)。

## 测试网冒烟

```bash
node scripts/agent-smoke-plan.mjs      # 真实 RPC 只读预检，无私钥和交易
npm run agent:smoke -- --help
npm run agent:smoke -- --server http://127.0.0.1:3000
# 用户明确批准本次交易后，服务器需处于 Live/propose，并设置 AGENT_LIVE_SMOKE_ENABLED=true：
npm run agent:smoke -- --server http://127.0.0.1:3000 --run-id phase5-attempt-001 --confirm
npm run agent:smoke -- --server http://127.0.0.1:3000 --lifecycle
```

默认只读；CLI 不加载 `.env`、不读取私钥，不在本机建立签名钱包。`--confirm` 才通过管理员 API 依次提出并批准 REPRICE → PAUSE → RESUME，服务器用专用定价密钥执行；每步独立核对真实 `PricingUpdated`、交易目标、两份承诺、价格和 `stateOf`。稳定的 run ID 支持查到既有决策，未知广播、失败或不匹配立即停止，禁止自动重发。当前价格无法由确定性引擎形成更低的 REPRICE 时停止，不能为了凑步骤伪造报价。受保护 pool #2 不会进入冻结、清算、结算或取消。默认不做可选恢复价格的第四笔交易。`PricingUpdated.issuePrice` 是提交给 Oracle 的风险报价；PAUSE/RESUME 不改池子的实际发行价，RESUME 恢复暂停前的活动状态。核验器分别核对报价承诺与实际池价/状态。恢复运行按回执区块验证已完成步骤，跳过既有审批，只补剩余动作；不会拿最新状态否定历史步骤后重发。

`--lifecycle` 提供原油新池的 owner / 钱包逐步清单，明确停在 `OWNER_ACTION_REQUIRED`；每笔 owner 交易由既有 `agent:approve --step N --confirm` 单独授权。它不把清单返回冒充生命周期通过，也不自动支付 USDC 或签 owner 交易。输出按 attempt 命名的 JSON，不覆盖历史证据；只有真实步骤全部核验才会 `live_acceptance=true`。

## 测试

```text
node --test tests/agentPhase5.test.js
npm run agent:redteam
```
