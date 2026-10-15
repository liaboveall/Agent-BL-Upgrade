# Phase 5：评测、安全、可靠性与决策重放

2026-10-15。Phase 5 本阶段范围全量完成：补齐 WP5.2 / 5.3 / 5.5 / 5.6 / 5.7，复验 WP5.1 / 5.4 / 5.8，并按用户本次授权完成 WP5.9 的三笔真实测试网定价交易。[完成清单](evidence/phase5-completion.json)、[本地证据](evidence/phase5-local.json) 与 [实链证据](evidence/agent-live-smoke.json) 分别记录范围、检查与回执。真实模型和用户人工验收仍有独立状态。

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

## 验证记录

preflight 扩为 65 项：红队、新鲜度/重放、隐私/保留、冒烟安全边界加入现有运行时、全量测试、故障矩阵、三故事、质量和禁止伪造检查。Demo 的 Live 专属检查仍为 SKIP。MCP 保持 9 tools + 3 resources，Phase 6 更新时再同步数量。

两项旧测试适配了新契约：重启测试通过认证存储构造合法的 PROCESSING 检查点，直接篡改加密文件仍拒绝；确定性流水线测试复用同一份完整事件，包括观察/到期时间。首轮回归暴露过度脱敏交易引用/浏览器链接的缺陷，已修复；原失败输出保留在 evidence 的 attempt 记录中。

中英、1440/390px 自动化浏览器检查覆盖键盘重放、PASS/FAIL、过期徽标和审批拒绝、无横向溢出。浏览器运行在隔离临时目录，屏蔽外部请求，链上交易和真实提供方调用均为零。截图及结果见本地证据；不声称实体设备、内置窗格控制或人工试用已通过。

最终冻结代码本地结果：**1,158/1,158 测试通过**（新增 32 项），覆盖率 **94.26% 行 / 84.20% 分支 / 92.37% 函数**；20/20 质量闸门、17/17 生成变异检测、26 个注入样本攻击成功数 0。浏览器新流程 41/41、全站回归 256/256；preflight **60 PASS / 0 WARN / 5 Live SKIP / 0 FAIL**，另有 75 项本地合约测试。评测和 preflight 的源摘要均为 `d0bc0a0bc15597d549bb26e45737804019ac21f0467f4b665a663ff383ca8bb1`；完整记录见 [phase5-local.json](evidence/phase5-local.json)。

WP5.9 的三笔交易已按用户明确授权完成。执行前复核 chain 1439 / pool #2 为 Open / 0.80，专用定价账户的链上权限及余额通过预检；隔离运行从真实部署区块 143331433 补齐完整监听历史后才开始广播。

初版只读预检把 PAUSE 的风险报价 0.7836 当成池价，且错误预测 RESUME 回到 Open。实际合约的 PAUSE/RESUME 只切换状态，池价保持 0.7910，RESUME 恢复暂停前的 Repriced。首轮在两笔成功交易后因错误断言停止；对照合约与真实回执修正核验/预览后，复用同一个运行编号和日志，只补执行了第三笔 RESUME。独立核验包装器也曾保留同类错误断言，其失败报告与后续只读复核报告均保留，没有重复广播。

最终三笔均核对网络、签名账户、Oracle 目标、精确 calldata、成功回执与规范区块、PricingUpdated 参数、历史池价/状态及防重放标记；三份持久决策重放均 PASS，待审批为零。最终为 **Repriced（可认购）/ 0.7910**。未做第四笔价格恢复、owner 或生命周期交易。

| 动作 | 区块 | Oracle 报价 | 实际池价 | 历史状态 | 交易 |
|---|---|---|---|---|---|
| REPRICE | 143794168 | 0.7910 | 0.7910 | Repriced | [0xad1110be0b…](https://testnet.blockscout.injective.network/tx/0xad1110be0b676640aaa7a634e553e7d4200884fa584bfbd640ed19c18891c703) |
| PAUSE | 143794185 | 0.7836 | 0.7910 | Paused | [0x627ac1186b…](https://testnet.blockscout.injective.network/tx/0x627ac1186be1b3789cccaf4c28201b71ac17446ecdb086af916e1589df154cee) |
| RESUME | 143795077 | 0.7910 | 0.7910 | Repriced | [0x94047bd679…](https://testnet.blockscout.injective.network/tx/0x94047bd679a3736b3bd5e492f6e6a131d02cb509454ff3ed13e995122250d247) |

运行时日志、认证加密快照、审批与游标保留在 `data/runtime/phase5-live-1792027678667`。见 [实链报告](evidence/agent-live-smoke.json)、[独立只读核验](evidence/phase5-live-verification-final-1792029472229.json) 和 [尝试历史](evidence/phase5-attempt-history.json)。发布 preflight 的 5 个 Demo 下 Live SKIP 保留原状，本次三笔定价的真实链上结果由独立证据补充。

修正后新增六项 Node 回归和一项本地真实合约回归。已完成的运行不可直接重跑：当前价格若缺少匹配的结构化报价及更低的新报价，只读预检会拒绝，不会修改报价字段凑步骤。真实 LLM、可选 owner 生命周期、内置窗格操作和人工/实体设备试用均未运行。下一入口 **Phase 6 WP6.1 MCP**。未提交、未推送，既有 dirty 改动与失败历史保留。
