# WP2.7 链上监听

2026-10-15：只读监听、确认游标、事件接入、池发现、镜像对账和紧急停止已实现；40 项新增行为测试，全量 1061/1061，覆盖率 lines 94.50% / branches 83.89% / functions 91.95%，lint/check 通过；中英 × 1440/390px 的 91/91 项浏览器检查通过。本批的工程及浏览器检查记录于 [evidence/chain-watcher-local.json](evidence/chain-watcher-local.json)。这些检查使用真实合约 ABI 编码的内存日志，不代表真实 Injective RPC 长时间运行、链上写入或用户人工验收。

最终 Demo preflight：56 PASS / 0 WARN / 5 Live SKIP / 0 FAIL。记录绑定本批组件及运行时依赖的 44 个文件摘要；preflight 自带的 source_sha256 属于确定性评测组件，范围与本批摘要不同。没有当前改动的提交 SHA 或远端 CI 声明。

## 运行方式

持久化服务器入口在 Live 模式每 `AGENT_CHAIN_POLL_SEC` 秒调用一次独立的只读连接。它使用 `eth_getLogs`，不创建钱包、不解析签名密钥，也不调用合约写方法。普通 `createServer()` 和测试工厂默认不启用监听；Demo 模式不访问 RPC。

| 配置 | 默认 | 行为 |
|---|---|---|
| `AGENT_CHAIN_WATCHER_ENABLED` | `true` | 持久化运行时启用；显式 `false` 可关闭 |
| `AGENT_CHAIN_POLL_SEC` | `15` | 独立于世界风险监控，范围 1–3600 秒 |
| `AGENT_CHAIN_CONFIRMATIONS` | `1` | 处理到 `head - confirmations + 1` |
| `AGENT_CHAIN_START_BLOCK` | 空 | 最早的已部署监听合约区块；显式值只可向前扩展历史，不能跳过部署历史 |

部署区块来自 `public/chain-config.json`。如某个合约只有部署交易哈希，读取其成功回执，核对合约地址、交易及规范区块；无法核对时进入 degraded，不猜起点。每次最多读取 5000 个区块，追赶期间展示积压并暂停 Live 状态变更提案。

## 事件与对账

- `RWAOfferingPool`：OfferingCreated、Subscribed、OfferingStateChanged、OfferingRepriced、OfferingPaused、OfferingResumed、SettlementProofRecorded、OfferingSettled、EmergencyStopSet；额外覆盖 DepartureRecorded、ImporterPaymentCorrected、OfferingCancelled。
- `RiskPricingOracle`：PricingUpdated。
- `AgentBLRWA`：Tokenized、Repriced。
- `PaymentOracle`：PaymentAttested。

按区块、交易位置和日志位置排序；校验地址、主题、区块哈希、位置及解码结果。重复的相同日志只接入一次；同一位置出现冲突、removed 日志或不可解码的监听事件时，整批不推进。事件标为 `source: chain-watcher` / `source_mode: live`，保存真实交易哈希和解码参数，原子金额保持十进制字符串。

`OfferingCreated` 注册到 PoolRegistry；CLI 已登记的池按合约和池号复用，保留映射来源与保护标记。终态池保留为历史。通过已核对的链上 cargoHash 关联已知案例；无法关联时登记为 chain-only，只监听链状态，不臆造风险、合规、保险或融资结论，不进入投资推荐。

`AgentBLRWA` 与 `RWAOfferingPool` 的池编号独立；前者不进入后者的执行映射。PaymentAttested 的 caseIdHash 采用已有的 SHA-256 规则，只关联报告存证观察，不冒充贸易还款、不创建 USDC 消费记录或 SETTLE 审批。

池状态、eBL、订阅数、金额和还款/到港证明统一在本批确认区块读取。差异写入 `RECONCILE_MISMATCH` 活动，再更新 Live 镜像；金额以 `chainSnapshot` 中的原子字符串为准。既有完整报价及哈希保留，链价另存 `chainIssuePriceUsd`；报价不一致时禁止 Copilot 给出基于旧报价的投资动作。仅看到合约证明不能产生 `payment_verification`。

## 持久化与故障恢复

游标在 `AGENTBL_RUNTIME_DIR/agent-chain-cursor.json`，包含配置摘要、起点、下一块、最后区块及哈希和确认镜像。v2 摘要绑定链、实际监听合约/主题、抵押登记合约、对应部署配置、起点和确认深度；新增不参与监听的 `AgentDecisionLog` 部署记录不会使游标失效。每个真实日志进入持久事件队列，队列落盘后才原子提交游标。部分处理后崩溃会从原批重读，由事件幂等键去重；已完成事件的完整内容仍保存在事件 JSONL 日志。

最终验收修复（2026-10-15）：v1 仅在精确匹配当前旧摘要、或仅移除新增 `AgentDecisionLog` 部署记录的旧摘要时原子迁移为 v2；先复验网络、已提交块的规范哈希及当前确认深度。迁移保留起点、位置和镜像；无法证明的配置变化、重组、写失败或已记录的 `reconciliation_required` 仍失败关闭，不自动清除历史冲突。

重启继续读取下一块；没有新块时恢复已保存的 Live 镜像。重叠 tick 共用一次轮询；模式或代次变化后不向新模式接入旧轮询结果。切回 Demo 立即恢复独立的 Demo 池；Demo reset 丢弃旧备份，保留 Live 游标和历史。

RPC 失败/超时标记 degraded，不推进游标、不编造事件；错误输出不包含 RPC 原文或带凭据 URL。RPC 调用共享每批 20 秒的截止时间，失败退避从轮询周期翻倍，上限 300 秒。一次完整成功的规范链读取才恢复可执行状态。状态接口和控制台显示同步进度、确认数、重试时间与需人工对账的状态。

启动与每批轮询都先读取当前及确认区块的 `emergencyStopped`。当前停止立即生效；解除必须同时得到当前及确认状态为 false。历史停止日志只作观察，不覆盖当前开关；本地停止与链上停止独立。链状态未知或仍追赶时，所有 Live 状态变更提案（包括 PAUSE）暂停，已有审批保留等待恢复；正常紧急停止仍沿用允许安全 PAUSE 的策略。CLI 读取的状态也不能通过控制台开关解除链上停止。

已提交区块改变、配置与游标冲突或抵押映射冲突时，保存 `reconciliation_required`，暂停并保留原游标，不自动回退、重发交易或清空证据。恢复需要运维核对分叉、部署和已有审批：先停止 Agent，备份运行时游标/事件/决策/审批记录，确认规范链与曾观察的交易，再使用独立目录从部署区块重建观察记录。不要在未对账时删除原证据或复用旧审批；真实交易仍须按实施规划 §16 单独授权。

## 本地验证

行为测试：

```bash
node --test tests/agentChainWatcher.test.js
npm run lint
npm test -- --test-concurrency=4
npm run check
npm run test:coverage -- --test-concurrency=4
```

隔离浏览器服务与复现入口：

```bash
node scripts/chain-watcher-acceptance-server.mjs
node scripts/chain-watcher-acceptance-runner.mjs --url http://127.0.0.1:<printed-port> --playwright-module <installed-playwright/index.mjs> --browser-executable <installed-chromium>
```

服务默认不读开发者 `.env`，删除签名角色配置，使用专属临时目录和明确的测试管理员令牌。`/__acceptance__/` 操作只存在于该脚本，不在产品服务器开放。浏览器覆盖中英 × 1440/390px、只读事件、价格差异、未知货物、键盘控制、本地与合约停止、失败/重试、Demo 隔离及重组审查。此前失败报告另存 attempt 文件，页面截图明确标出内存链和零真实交易。

内置浏览器打开请求返回 queued；Node REPL 浏览器连接因 `sandboxCwd is not a local file URI`（WSL 路径）未能初始化。本批浏览器证据来自原生 Playwright/Chromium，Windows curl 另行核对服务可访问性；不将它们称为内置窗格操作、实体设备或人工验收。

接口依据：[ethers v6 Provider / Interface](https://docs.ethers.org/v6/single-page/)、[Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/)。实际解码使用仓库部署 ABI，现有合约保持不变。

下一入口：**WP2.9 PRD Agent API**。本批不提交、不推送，也不执行真实签名、付款、部署或管理员交易。

建议提交分组：① `feat(agent): persist confirmed read-only chain observations`；② `feat(frontend): show chain monitoring and independent emergency stops`；③ `test(agent): record chain watcher recovery acceptance`。先前 WP2.3 / WP2.4 / WP2.6 的未提交改动保留，不由本批自动提交。
