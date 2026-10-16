# WP2.7 链上监听

2026-10-15：只读监听、确认游标、事件接入、池发现、镜像对账和紧急停止已实现；40 项新增行为测试，全量 1061/1061，覆盖率 lines 94.50% / branches 83.89% / functions 91.95%，lint/check 通过；中英 × 1440/390px 的 91/91 项浏览器检查通过。本批的工程及浏览器检查记录于 evidence/chain-watcher-local.json。这些检查使用真实合约 ABI 编码的内存日志，不代表真实 Injective RPC 长时间运行、链上写入或用户人工验收。

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

### 轮询进行中的状态（2026-10-16 修复）

**问题：** 以前每一轮轮询一开始就把链状态设为"未知"，到结束才清除。Live 提案的 policy 如果恰好在一轮例行轮询期间运行，就会被 `CHAIN_OBSERVATION_UNAVAILABLE` 和 `EMERGENCY_STOP` 拒绝，尽管监听器在这一轮之前是健康的。`AGENT_CHAIN_POLL_SEC=2` 时几乎每个提案都被拒，15 秒时偶尔被拒。

**现在的规则：**

- 已追上链头的健康监听器，在下一轮例行轮询进行期间保持"已确认"。这一轮提交前，上一次确认和两轮之间时一样新。
- 下列情况仍然失败关闭（拒绝所有 Live 状态变更提案，包括 PAUSE）：
  - 启动后第一轮成功之前；
  - 切换到 Live 或代次变化之后；
  - 本轮发现落后超过一批（5000 块）而需要追赶，在重放日志前就标为未知；
  - RPC 失败、超时、网络不符、重组、游标冲突，或需要人工对账。
- 链头出现紧急停止时，轮询中途立即生效；解除要等这一轮完整提交。
- **陈旧上限：** 最近一次"已追上"的确认超过 `2 × AGENT_CHAIN_POLL_SEC + 20 秒`（默认 50 秒）就视为未知。这覆盖调度器停了、或某一步（例如写盘）卡住的情况。状态接口的 `chain_watcher` 里有 `confirmed_at`、`max_stale_sec` 和 `stale` 三个字段。

**取舍：** 轮询期间新出现的链上变化（例如有人刚在链上暂停了池子），要到这一轮提交时才进入镜像。这个延迟和两轮轮询之间本来就有的延迟相同，并且受陈旧上限约束。另外，执行前还有三道检查：

- 审批时，以及每笔交易广播前，都会再检查链状态是否已知、是否处于紧急停止；
- policy 运行时会直接读取一次链上 `emergencyStopped`。

启动与每批轮询都先读取当前及确认区块的 `emergencyStopped`。当前停止立即生效；解除必须同时得到当前及确认状态为 false，并且要等这一轮轮询完整提交后才生效。历史停止日志只作观察，不覆盖当前开关；本地停止与链上停止独立。链状态未知或仍追赶时，所有 Live 状态变更提案（包括 PAUSE）暂停，已有审批保留等待恢复；正常紧急停止仍沿用允许安全 PAUSE 的策略。CLI 读取的状态也不能通过控制台开关解除链上停止。

已提交区块改变、配置与游标冲突或抵押映射冲突时，保存 `reconciliation_required`，暂停并保留原游标，不自动回退、重发交易或清空证据。恢复需要运维核对分叉、部署和已有审批：先停止 Agent，备份运行时游标/事件/决策/审批记录，确认规范链与曾观察的交易，再使用独立目录从部署区块重建观察记录。不要在未对账时删除原证据或复用旧审批；真实交易仍须按实施规划 §16 单独授权。

## 测试

```text
node --test tests/agentChainWatcher.test.js
```
