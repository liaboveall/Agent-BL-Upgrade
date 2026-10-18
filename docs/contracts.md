# AgentBL Web3 Contract Interface

> **W5 受控测试网交付**：W3 控制层及独立 v5 资金池以 `public/rights-instance.json` 和 [W5 实际核验](evidence/w5-2026-10-18/testnet/) 为准。新实例的治理、资格与资金运行状态必须实际核对；下方 W3 本地候选段落保留其 2026-10-17 历史语义。

> **W3 本地候选（2026-10-17）**：新增 `RightsGovernance` / `AssetIdentityHub` / `CommittedEBLRegistry` / `RightsController` / `ControlledRWAToken`。控制器独占新 v5 pool owner / oracle，永久固定 minter 和资格 gate，发行需来源与 holder 同意、估值和条款；损失处置需通知、争议和独立审核。尚未部署，不改变下方历史地址。完整接口、权限与真实业务待验边界见 [W3 权利与控制](w3-rights-control.md)。

状态：WEB3-1 ~ WEB3-4 设计冻结  
命名来源：以 `docs/PRD.md` v0.2 为准  
范围：先定义可被 JS contract mock、Hardhat 合约和前端共同复用的最小接口，不做公开募资、不做 AMM、不承诺保本收益。

> 2026-10-17 更新：**协议 v3 已部署并初始化**，4 个新核心合约、3 笔连接/角色交易，共 7 笔实链回执与 7 份当前合约字节码核验通过，见 [部署证据](evidence/protocol-v3-deployment-2026-10-17/README.md)。v3 调价保留生命周期，以已售份额原始目标债务核对清偿；支持追加回收、Defaulted/LossSettled，只有质押池能解押。新状态追加在旧枚举之后。旧 v2 资产、持仓、质押和回执留在原地址，未迁移或重铸；当前 v3 是空 Registry/Pool。下方历史 v2 接口表不能覆盖 v3 的状态规则。
>
> **本地候选已推进到协议 v5（尚未部署）。** W1/v4 状态机保留在 `RWAOfferingPool.sol`；独立的 `RWAOfferingPoolV5.sol` / `RWATokenV5.sol` 增加 W2 的资金托管、放款、退款和领取，并接入可恢复账本与统一持仓。详见 §0.8 和 [W2 本地验收](evidence/w2-local-2026-10-17/README.md)。本轮没有改变现有链配置或部署地址，也没有重新核验远端部署。

## 0. 当前 v3 部署与历史 v2 接口

> **以源码为准。** 下面 §1–§7 是 WEB3-1 ~ WEB3-4 冻结时的最小接口设计，仍可当作接口说明阅读。合约之后演进到了 v2：数字编码（状态序号、动作码）以 `hardhat/contracts/*.sol` 为唯一事实来源，`tests/contractParity.test.js` 会校验 JS 常量与它一致，`hardhat/test/offeringModel.test.js` 用随机序列对照参考模型来验证状态机。

### 0.1 部署状态

| 项目 | 状态 |
|---|---|
| 链上（Injective EVM 测试网，chainId 1439） | Registry、Token、Pool、Oracle 为 2026-10-17 v3 核心部署；另外 3 份辅助合约沿用旧地址。7 份字节码均匹配。owner 仍为 `0x9da22292D85e2A584ace6bb347D7054486b5ed6B`，现有专用 updater `0xEB43623667f1Add616D0FbdEBbbE067a0F195F79` 已获新 Oracle 授权 |
| 本仓库源码 | v4/W1 状态机与独立 v5/W2 资金候选均存在；v5 已完成本地 EVM、账本、HTTP 和钱包适配验证，尚未部署 |
| 部署工具 | `scripts/deploy-protocol-v3.mjs` 默认只生成计划，真实发送须指定步骤；`scripts/verify-protocol-v3.mjs` 只读核验后才允许本地配置切换。旧 `deploy:all` 含历史 smoke，不用于 v3 升级 |
| 对比链上与源码 | `npm run verify:bytecode`（只读，调用 `eth_getCode`）；加 `-- --strict` 可在两者不一致时返回非零退出码 |

重新部署之后需要的运维动作：

1. `PaymentOracle.setAttestor(<后端归证密钥地址>, true)`，并在 `.env` 里设置 `PAYMENT_ATTESTOR_PRIVATE_KEY`；
2. `RiskPricingOracle.setUpdater(<定价更新密钥地址>, true)`，并设置 `PRICING_UPDATER_PRIVATE_KEY`；
3. 如需把合约交给多签或新钱包：`transferOwnership(新地址)`，再由新地址 `acceptOwnership()`（两步，写错地址不会锁死合约）。

### 0.2 合约与权限

| 合约 | 作用 | 谁能写 |
|---|---|---|
| `EBLRegistry` | eBL 登记（货物唯一性、结构化元数据）、背书/转让历史、质押 | owner：`mintEBL` / `mintEBLV2`；持有人：`transfer` / `endorse`；持有人或 owner：`pledge`；v3 仅被质押的池：`releasePledge`（v2 历史上也允许 owner） |
| `RWAToken` | 每个池的份额凭证（不可转让） | 仅池可 `mint`；owner：`setPool` / `setTransferPermission` |
| `RWAOfferingPool` | 发行状态机与审计轨迹 | 见下表 |
| `RiskPricingOracle` | 记录 AI 定价与风险并转发给池 | updater：`updatePricing`；owner：`setUpdater` |
| `InvestorComplianceGate` | 可替换的合规准入模块 | owner |
| `PaymentOracle` | 把 x402 支付与付费报告绑定的链上证明 | attestor：`attestPayment`；owner：`setAttestor` |
| `AgentBLRWA` | 浏览器演示合约（任何钱包一笔交易即可 tokenize） | 任何钱包可 `tokenize`；**只有 creator** 能 `reprice` |

`RWAOfferingPool` 的调用方：

| 函数 | 调用方 | 备注 |
|---|---|---|
| `createOffering`、`cancelOffering`、`correctImporterPayment`、`setOracle`、`setAgentExecutor`、`setEmergencyStop`、`emergencyPause`、`setComplianceGate`、`setAccessMode` | owner | 只有 `cancelOffering` 和 `emergencyPause` 在全局紧急停止期间仍可用 |
| `markInTransit`、`resumeOffering`、`recordImporterPayment`、`recordCargoArrival`、`settle` | owner 或授权 executor | 紧急停止期间不可用 |
| `pauseOffering` | owner、oracle 或 executor | 紧急停止期间不可用 |
| `applyPricingAction` | oracle 或 owner | 由 `RiskPricingOracle.updatePricing` 转发 |
| `subscribe` | 满足准入条件的任何地址 | 紧急停止期间不可用 |

五个核心合约（`EBLRegistry`、`RWAToken`、`RWAOfferingPool`、`RiskPricingOracle`、`InvestorComplianceGate`）共用 `Owned`：两步所有权转移，`owner()` 和 revert 字符串 `"not owner"` 保持不变。`PaymentOracle` 使用自定义错误，自带同样的两步转移，并且 **attestor 角色随 owner 转移**：旧 owner 的 attestor 权限被撤销，新 owner 自动成为 attestor（`RiskPricingOracle` 的 updater 角色同理）。

### 0.3 v2 相对 v1 的变化

| # | v1 的问题 | v2 的行为 | 回归测试（`hardhat/test/contractHardening.test.js`） |
|---|---|---|---|
| 1 | 同一张已质押的 eBL 可以支撑多个在售 offering | `poolOfEbl` 保证一张 eBL 同时只支撑一个 offering；`Repaid` / `Cancelled` 时释放 | collateral |
| 2 | oracle 能把发行价设到目标赎回价之上；`REPRICE_DOWN` 能涨价 | 新价必须 ≤ `targetRedemptionValue`；`REPRICE_DOWN` 必须严格降价；`riskLevel ≤ 3` | pricing bounds |
| 3 | 没有人认购的 offering 也能记录回款并 `settle` | 回款证明与结算要求 `subscribed > 0`（`no subscribers`） | settlement |
| 4 | 结算后 eBL 仍被质押、无法流转 | `settle` 和 `cancelOffering` 释放质押（尽力而为：已被 registry owner 释放时记录 `CollateralReleaseFailed`，不阻塞结算） | collateral |
| 5 | 录错一次回款证明就永久无法结算 | owner 可 `correctImporterPayment`，旧值保留在 `ImporterPaymentCorrected` 事件里；executor 不能改自己的证明 | settlement |
| 6 | `Cancelled` 状态不可达 | `cancelOffering`：仅 owner、仅无认购者的 `Open` / `Repriced` / `Paused` | cancelOffering |
| 7 | 质押被 registry owner 释放后仍可继续认购 | `subscribe` 要求 eBL 仍质押给该池 | collateral |
| 8 | `mintEBL`（V1）每次生成新的 cargoHash，同一张提单可重复铸造 | cargoHash 只由 `metadataHash` 派生，重复铸造会 revert | EBLRegistry hardening |
| 9 | `PaymentOracle.transferOwnership` 让旧 owner 继续是 attestor | 两步转移，attestor 角色随 owner 转移 | PaymentOracle ownership |
| 10 | `AgentBLRWA.reprice` 任何地址都能覆盖别人的价格、风险、证据 | 仅 creator；`action ≤ 5`、`riskLevel ≤ 3`、`riskScoreBps ≤ 10000` | AgentBLRWA hardening |
| 11 | 单 owner，无法更换密钥 | 两步所有权转移（见 0.2） | two-step ownership |
| 12 | `markInTransit` 的离港证明被丢弃；`setOracle` / `setPool` 没有事件 | 新事件 `DepartureRecorded`、`OracleSet`、`PoolSet` | settlement |

新增事件：`DepartureRecorded`、`ImporterPaymentCorrected`、`OfferingCancelled`、`CollateralReleased`、`CollateralReleaseFailed`、`OracleSet`（池）；`PoolSet`（`RWAToken`）；`OwnershipTransferStarted` / `OwnershipTransferred`（`Owned` 合约和 `PaymentOracle`）。新增函数：`cancelOffering`、`correctImporterPayment`、`poolOfEbl`、`transferOwnership` / `acceptOwnership` / `pendingOwner`。原有函数签名和事件签名保持不变，旧客户端和 ABI 继续可用。

### 0.4 offering 状态机（当前实现）

| 从 | 调用 | 到 | 条件 |
|---|---|---|---|
| （新建） | `createOffering` | `Open` | eBL 已质押给本池且当前没有在售 offering；价格 ≤ 目标赎回价 |
| `Open` / `Repriced` / `Subscribed` | `subscribe` | `Subscribed`，认购满时 `Funded` | 准入、数量、不超过供给、eBL 仍质押给本池 |
| `Funded` / `Subscribed` | `markInTransit` | `InTransit` | 离港证明非零 |
| 任一活跃状态 | `pauseOffering` / oracle `PAUSE_OFFERING` / `emergencyPause` | `Paused` | 记住暂停前的状态 |
| `Paused` | `resumeOffering` / oracle `RESUME_OFFERING` | 暂停前的状态 | |
| 任一活跃状态 | oracle `REPRICE_DOWN` | `Repriced` | 新价严格低于现价且 ≤ 目标；价格不变时只改状态 |
| 任一活跃状态 | oracle `OPEN_OFFERING` / `OPEN_WITH_WARNING` | 状态不变 | 可调价（升降都可以），但 ≤ 目标赎回价 |
| 活跃 / `Paused` | oracle `FREEZE_POOL` | `Frozen` | |
| 活跃 / `Paused` / `Frozen` | oracle `TRIGGER_LIQUIDATION` | `Liquidation` | |
| 任一活跃状态 | `settle` | `Repaid` | 有认购者；付款证明和到港证明齐全；金额一致；同时释放质押 |
| `Open` / `Repriced` / `Paused` | `cancelOffering` | `Cancelled` | 无认购者；仅 owner；同时释放质押 |

- 活跃状态 = `Open`、`Subscribed`、`Funded`、`InTransit`、`Repriced`。
- `Created`、`Priced`、`Redeemed` 是保留的枚举值，目前不可达（offering 创建即为 `Open`；没有赎回支付腿，见 0.6）。
- `Frozen`、`Liquidation` 是需要人工或链下处理的终点，质押不会自动释放。PRD 里的 `Defaulted` 只存在于链下模拟（`src/core/offeringSimulator.js`），不在链上枚举里，所以链下状态列表与链上枚举的序号并不一一对应：**链上以枚举序号为准**。

动作码（`uint8 action`，`RWAOfferingPool` 的常量）：0 `OPEN_OFFERING`、1 `OPEN_WITH_WARNING`、2 `REPRICE_DOWN`、3 `PAUSE_OFFERING`、4 `FREEZE_POOL`、5 `TRIGGER_LIQUIDATION`、6 `RESUME_OFFERING`、7 `SETTLE_OFFERING`、8 `EMERGENCY_PAUSE`、9 `CANCEL_OFFERING`。0–5 可以由 AI 的 `PricingQuote` 携带；6 可以由 oracle 触发；7–9 是池自己在 `OfferingStateChanged` 里报告的生命周期动作（oracle 传入会以 `bad action` revert）。

### 0.5 本地协议 v4：W1 状态与前置条件（尚未部署）

`protocolVersion = 4`。以下规则只在本地源码和回归中存在；部署前必须先完成独立审查、干净重建与新地址部署计划。

| 主题 | v4 行为 | 事件 |
|---|---|---|
| 创建条款 | `createOfferingWithTerms(eblId, supply, price, target, maturityAt, subscribeUntil)` 原子写入；要求 `maturityAt > now`、`subscribeUntil > now`、`subscribeUntil <= maturityAt`。旧的 4 参数 `createOffering` 仍绑定默认 60 天 | `OfferingCreated`、`OfferingTermsSet` |
| 认购截止 | 每次 `subscribe` / `subscribeWithTerms` 都检查 `block.timestamp <= subscriptionDeadline`；`setSubscriptionDeadline` 只能在无认购者时缩短或调整 | `SubscriptionDeadlineSet` |
| 认购条款绑定 | `subscribeWithTerms(poolId, amount, maxUnitPrice, expectedQuoteVersion, deadline)` 要求现价不高于用户上限、`quoteVersion` 未变化、用户与协议截止日均未过；任一不满足整体回滚 | `Subscribed` |
| 报价前置条件 | `updatePricing(..., expectedQuoteVersion, validUntil, decisionSeq)`：有效期最长 30 天，`expectedQuoteVersion` 必须等于池当前版本，`decisionSeq` 必须严格递增；decision id 绑定 `chainId + oracle + pool` | `PricingUpdated`、`PricingDecision` |
| 冻结退出 | 无认购者可 `cancelOffering`；有认购者可继续录入已核验回款/到港并 `settle`；到期欠款可 `markDefault`；有审批依据可 `unfreezeOffering` 恢复冻结前状态 | `OfferingFrozen`、`OfferingUnfrozen` |
| 清算退出 | `recordLiquidationRecovery` 逐笔记录回收；`resolveLiquidation` 是唯一收尾：足额→`Repaid`，不足→`LossSettled`，无认购者→`Cancelled`；收尾前不释放质押 | `LiquidationRecoveryRecorded`、`LiquidationResolved` |
| 违约后回收 | `Record_PAYMENT` / `RECORD_ADDITIONAL_PAYMENT` / `RECORD_ARRIVAL` / `SETTLE` 在 `Defaulted` 和 `Frozen` 仍可用；`settleLoss` 只从 `Defaulted` 进入 | `AdditionalPaymentRecorded`、`SettlementProofRecorded`、`OfferingSettled` |
| 事件语义 | 冻结不再伪装成 `OfferingPaused`；`setMaturity` 写 `OfferingTermsSet`；追加回收、违约、损失、清算和抵押释放都有独立事件 | 见左 |

`FREEZE_POOL` 记录冻结前状态；`unfreezeOffering` 不会释放质押或抹掉债务。`Liquidation` 不再是“无出口终态”；`TERMINAL_STATES` 只包含 `Repaid`、`Redeemed`、`Cancelled`、`LossSettled`。这些语义变化需要与 `src/agent/runtime/poolRules.js`、`src/agent/runtime/ownerTxPlan.js`、结算管线、watcher 和前端一致；`hardhat/test/protocolV4.test.js` 与 `tests/w1CrossLayer.test.js` 固定本表。

### 0.6 测试覆盖

`cd hardhat && npm test`（或在仓库根目录运行 `npm run test:contracts`）：

- `contractHardening.test.js`：上表每一项的回归测试；
- `protocolV4.test.js`：W1 的 A01/A02/A05/A06/A07/A08 正式回归（清算与冻结退出、条款原子绑定、截止、报价时效与顺序、认购条款绑定）；
- `offeringModel.test.js`：参考模型对照。用固定种子的随机序列同时驱动模型和真实合约，逐步比对“该不该成功”和结果状态，并检查全局不变量（价格不超过目标、认购不超供给、`Repaid` 必有认购者和两份证明、终态不再占用 eBL 槽位等）。把合约里任一关键检查删掉（变异测试）都会让它失败；
- `deploySmoke.test.js`：在本地重放 `deploy-protocol.js` 的链上冒烟序列，避免合约规则改动让真实部署的冒烟失败；
- 其余是原有的单元测试。

仓库根目录的 `tests/contractParity.test.js` 校验 JS harness 的动作码、风险等级与 Solidity 源码一致。

### 0.7 历史 v2 已知限制（后续版本见 §0.5、§0.8）

这是演示级别的协议，**不要在其上放真实资金**：

1. **没有支付腿。** `subscribe` 只铸造份额凭证，并在事件里记录应付金额（`paidAmount`），不托管任何稳定币；`settle` 只记录进口商回款证明，不向投资者分配。上线前需要加入 ERC-20 托管与按比例赎回（并因此启用 `Redeemed`）。`contractHardening` 里有一条测试把这个限制固定下来，补上支付腿时需要有意识地更新它。
2. **质押由 registry owner 说了算。** `EBLRegistry.releasePledge` 允许 registry owner 随时解除质押；v2 只保证解除之后不会继续**新增**认购，并且结算时能容错。
3. **单 owner 信任模型。** owner 能暂停、取消（无认购者时）、更正回款证明、更换 oracle。生产环境应换成多签，并把 executor、updater、attestor 的密钥分开（后端已按最小权限分角色，见 `.env.example`）。
4. **oracle 是受信角色。** 价格只有上下界（≤ 目标赎回价，`REPRICE_DOWN` 必须降价），链上没有风险模型校验；可信度来自 updater 密钥以及事件里的 `evidenceHash` / `quoteHash` 审计线索。
5. **`RWAToken` 不可转让**，没有二级市场；`setTransferPermission` 只是预留的白名单记录。
6. **`AgentBLRWA` 是演示合约**：`tokenize` 对任何钱包开放，所有数据由调用方提供，链上不验证其真实性。

---

### 0.8 本地协议 v5：W2 资金与账本（尚未部署）

v5 使用独立合约，`protocolVersion = 5`；v3 配置及 v4 基线合约不因 ABI 合并而获得资金能力。编译继续使用 Solidity 0.8.24、viaIR、Paris、优化 200 runs。金额为六位小数原子整数字符串，份额为整数；v5 使用自定义错误控制字节码大小。

| 路径 | v5 规则 |
|---|---|
| 创建 | `createOfferingWithTerms(eblId,supply,price,target,maturity,deadline,asset,minRaise)` 同时绑定期限与六位小数 ERC-20；拒绝无效资产、期限和最低募集额 |
| 原子认购 | `subscribeWithTerms` 绑定价格上限、报价版本、用户截止时间；`SafeERC20` 收资且余额差额吻合后铸份额。转账或 mint 失败整体回滚；资金入口有重入保护 |
| 募集成功 | 售罄且达到最低额时进入 Funded；未售罄但已达标时，截止后调用 `finalizeFunding`。降价导致售罄仍未达标时保留退款路径 |
| 放款 | owner 的 `disburseToExporter` 只用该池实际募集余额，允许分批；必须有非零收款人和证据。尚未成功募集不能提前标记 InTransit |
| 募集失败 | 截止后未达标可按每位投资者实际支付退款并烧份额；Paused/Frozen 仍保留该权利。全局 emergency stop 暂停所有资金操作，须先解除。批量退款每次至多 100 人，失败收款人可以单独重试 |
| 募集期清算 | 未完成募集的 Liquidation 经 owner 处置后进入 Cancelled，按原出资退款；全部退款后才解押 |
| 回收 | `repay` 实际 transferFrom 到该池并记 `recoveredAtomic`；付款证明仅描述已经收到的回收，不能凭空生成可领款。结算会合并从未放给出口商的剩余本金 |
| 结算/领取 | Repaid / LossSettled 的持有人调用 `claim`；以剩余可分配金额和剩余份额按比例领取，最后领取者取得舍入尾差。零回收也可烧份额结束持仓；失败转账回滚，重复领取不多付 |
| 费用/超额/迟到 | 费用只在终态、首次领取前扣除；首笔领取后锁定费用。超额实际回收一并按份额分配；终态之后 `repay` 拒绝新回款，不自动重开已结清债权 |

链上现金事实由 `FundEscrowed`、`DisbursedToExporter`、`RepaymentReceived`、`InvestorRefunded`、`Claimed`、`FeeDeducted` 产生。`SettlementProofRecorded` / `AdditionalPaymentRecorded` / `LiquidationRecoveryRecorded` 是归证事件，不再次计入现金，避免把同一笔 `repay` 记两遍。

`src/ledger/` 在运行目录的 `ledger/` 下保存意图、现金 JSONL、Position 快照和按协议实例保存的 cursor。意图在钱包签名前落盘，广播后绑定唯一交易；恢复时按合约、发送人、calldata、事件和确认深度匹配。分录按链、合约、协议版本、交易和日志序号去重。单进程队列与跨进程文件锁覆盖读写事务；JSONL 不旋转丢历史，写入执行 fsync，损坏尾行先保留审计副本再修复，内部损坏直接报错。Position 始终可由保存的现金事实重建。

重放器检查网络、协议版本、块哈希和确认深度，并将每池现金分录合计与同一确认块的 `escrowed` 核对；不完整现金事实不能推进 cursor。重组时追加失效标记并从部署点重放，不删除原事件。cursor 的分录计数能发现日志缺失并触发完整重放。`forceReplay: true` 支持显式完整链重建。该机制不代表已经完成生产异机灾备或物理断电演练。

应用接口：

- `GET /api/positions?wallet=0x...`：Demo 与 Live 显式分开，Live 显示协议实例、资产、份额、实际出资、已退款、可领和已领。没有可信链快照或余额不符时显示“对账中”，不补造成本或可领资金。
- `POST /api/positions/subscription-intents`：校验当前价格、报价版本、期限、准入和容量，持久化钱包认购意图。
- `POST /api/positions/claim-intents`：为投资者自己的可领取份额保存意图。
- `POST /api/positions/subscription-intents/:id/transaction`：只读核对交易与已保存意图，达到确认深度后确认。

后端不持有投资者或 owner 私钥。钱包在授权前保存意图，approve 完成后重新核对账户、网络和认购静态调用；广播结果不明确时保留交易哈希并要求对账。owner 的 DISBURSE / REFUND / DEDUCT_FEE / FINALIZE_FUNDING 计划具有参数检查、合约静态预检和具体事件参数校验。投资者领取留在自己的钱包流程。

前端持仓弹窗同时展示 Demo 和 Live，金额按资产原子精度格式化，只有已核对的终态持仓在 Live 模式允许领取；钱包变化立即清空旧持仓。中英文持仓弹窗通过 390px 自动化检查。整站仍采用既有桌面布局，不能将这项检查扩展为整站移动端适配结论。

本地证据、运行命令、失败尝试和源文件摘要见 [W2 验收目录](evidence/w2-local-2026-10-17/README.md)。适用资产是本地测试 ERC-20；真实资金、真实钱包人工试用、正式部署及远端 CI 不在本轮证据内。

---

## 1. 设计目标

Web3 / Contract 层只解决一件事：

```text
AI Pricing & Risk Agent 输出 PricingQuote / RiskReport
→ RiskPricingOracle 记录价格、风险动作和证据哈希
→ RWAOfferingPool 根据动作开放认购、改价、暂停、冻结或清算
→ 前端和测试能验证链上事件与状态变化
```

MVP 不追求复杂金融合约，优先保证：

1. eBL 质押关系可记录；
2. RWA 份额凭证可 mint；
3. RWA offering 状态机可跑通；
4. AI 定价与风险证据可通过 event 审计；
5. 所有接口能被现有 Harness 和后续 Hardhat 测试验证。

## 2. 共同约定

### 2.1 金额与价格单位

Solidity 实现中避免浮点数：

| 字段 | 建议单位 |
|---|---|
| `issuePrice` | 6 decimals，例如 `0.80 USD` 记为 `800000` |
| `targetRedemptionValue` | 6 decimals，例如 `1.00 USD` 记为 `1000000` |
| `tokenSupply` / `amount` | RWA token 最小单位，MVP 可按 whole token 处理 |

JS mock 可以保留人类可读的 `0.8` / `1`，但 Hardhat 合约测试应使用整数单位。

### 2.2 风险等级枚举

链上用 `uint8 riskLevel`，JS 层负责把字符串映射为数字。

| uint8 | Risk level |
|---:|---|
| 0 | LOW |
| 1 | MEDIUM |
| 2 | WARNING |
| 3 | CRITICAL |

### 2.3 定价动作枚举

链上用 `uint8 action`，JS 层维护 `contract_action` / `pricing_action` 映射。

| uint8 | PRD `pricing_action` | Harness `contract_action` | 链上语义 |
|---:|---|---|---|
| 0 | OPEN_OFFERING | APPROVE_FINANCING | 开放认购 |
| 1 | OPEN_WITH_WARNING | CONTINUE_WITH_WARNING | 带警告继续 |
| 2 | REPRICE_DOWN | TRIGGER_MARGIN_CALL | 降价 / 追加保证金 |
| 3 | PAUSE_OFFERING | FREEZE_POOL | 暂停发行 |
| 4 | FREEZE_POOL | FREEZE_POOL | 冻结池子 |
| 5 | TRIGGER_LIQUIDATION | TRIGGER_LIQUIDATION | 进入清算 |
| 6 | RESUME_OFFERING | — | 恢复暂停前的状态（v2 新增，可由 oracle 触发） |
| 7 | SETTLE_OFFERING | — | 池结算时自己报告的动作，不是 AI 动作（v2 新增） |
| 8 | EMERGENCY_PAUSE | — | owner 紧急暂停时池自己报告的动作（v2 新增） |
| 9 | CANCEL_OFFERING | — | owner 取消无认购者的 offering 时池自己报告的动作（v2 新增） |

### 2.4 哈希字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `evidenceHash` | `bytes32` | AI 定价 / 风险证据包哈希 |
| `quoteHash` | `bytes32` | `PricingQuote` 结构化输出哈希 |
| `metadataHash` | `bytes32` | eBL 元数据 / 文件摘要 |

所有哈希在 JS 中应表现为 `0x` + 64 位 hex。

## 3. WEB3-1：EBLRegistry

### 3.1 目的

`EBLRegistry` 记录电子提单凭证和质押关系。它不是 NFT 市场，也不处理真实 eBL 平台法律转让；MVP 只做可验证的登记、质押和解除质押状态。

### 3.2 Interface

```solidity
interface IEBLRegistry {
    event EBLMinted(
        uint256 indexed eblId,
        bytes32 indexed metadataHash,
        address indexed holder
    );

    event EBLPledged(
        uint256 indexed eblId,
        address indexed pool,
        address indexed holder
    );

    event EBLPledgeReleased(
        uint256 indexed eblId,
        address indexed pool,
        address indexed holder
    );

    function mintEBL(bytes32 metadataHash, address holder)
        external
        returns (uint256 eblId);

    function pledge(uint256 eblId, address pool) external;

    function releasePledge(uint256 eblId) external;

    function holderOf(uint256 eblId) external view returns (address);

    function pledgedTo(uint256 eblId) external view returns (address);

    function metadataHashOf(uint256 eblId) external view returns (bytes32);
}
```

### 3.3 权限和约束

| 操作 | 权限 | 约束 |
|---|---|---|
| `mintEBL` | registry owner / authorized issuer | `metadataHash != 0`, `holder != address(0)` |
| `pledge` | eBL holder 或授权 pool factory | eBL 必须存在，不能重复质押 |
| `releasePledge` | 当前 pledgee pool 或 registry owner | eBL 必须已质押 |

## 4. WEB3-2：RWAToken

### 4.1 目的

`RWAToken` 表示投资者认购某个 RWA offering 后获得的份额凭证。它不是公开交易代币；MVP 中只允许 `RWAOfferingPool` mint，并保留 permissioned transfer 的扩展口。

### 4.2 Interface

```solidity
interface IRWAToken {
    event RWAMinted(
        uint256 indexed poolId,
        address indexed investor,
        uint256 amount
    );

    event TransferPermissionSet(
        address indexed account,
        bool allowed
    );

    function mint(uint256 poolId, address investor, uint256 amount) external;

    function balanceOf(uint256 poolId, address investor)
        external
        view
        returns (uint256);

    function totalSupply(uint256 poolId) external view returns (uint256);

    function setTransferPermission(address account, bool allowed) external;

    function isTransferAllowed(address account) external view returns (bool);
}
```

### 4.3 权限和约束

| 操作 | 权限 | 约束 |
|---|---|---|
| `mint` | only `RWAOfferingPool` | investor 必须是 permissioned，amount > 0 |
| `setTransferPermission` | owner / compliance operator | MVP 可只记录，不开放二级市场 |

## 5. WEB3-3：RWAOfferingPool

### 5.1 目的

`RWAOfferingPool` 管理 eBL-backed RWA 的发行、认购、改价、暂停和结算状态。它消费 AI 定价结果，但不自己计算风险。

### 5.2 状态机

```text
Created
→ Priced
→ Open
→ Subscribed
→ Funded
→ InTransit
→ Repriced / Paused / Frozen
→ Repaid / Redeemed / Liquidation / Cancelled
```

### 5.3 Interface

```solidity
interface IRWAOfferingPool {
    enum OfferingState {
        Created,
        Priced,
        Open,
        Subscribed,
        Funded,
        InTransit,
        Repriced,
        Paused,
        Frozen,
        Repaid,
        Redeemed,
        Liquidation,
        Cancelled
    }

    event OfferingCreated(
        uint256 indexed poolId,
        uint256 indexed eblId,
        uint256 tokenSupply,
        uint256 issuePrice,
        uint256 targetRedemptionValue
    );

    event Subscribed(
        uint256 indexed poolId,
        address indexed investor,
        uint256 amount,
        uint256 paidAmount
    );

    event OfferingRepriced(
        uint256 indexed poolId,
        uint256 oldIssuePrice,
        uint256 newIssuePrice,
        bytes32 evidenceHash,
        bytes32 quoteHash
    );

    event OfferingPaused(uint256 indexed poolId, bytes32 evidenceHash);

    event OfferingStateChanged(
        uint256 indexed poolId,
        OfferingState oldState,
        OfferingState newState,
        uint8 action
    );

    event OfferingSettled(uint256 indexed poolId, uint256 repaymentAmount);

    function createOffering(
        uint256 eblId,
        uint256 tokenSupply,
        uint256 issuePrice,
        uint256 targetRedemptionValue
    ) external returns (uint256 poolId);

    function subscribe(uint256 poolId, uint256 amount) external;

    function pauseOffering(uint256 poolId) external;

    function applyPricingAction(
        uint256 poolId,
        uint256 newIssuePrice,
        uint8 action,
        bytes32 evidenceHash,
        bytes32 quoteHash
    ) external;

    function settle(uint256 poolId, uint256 repaymentAmount) external;

    function stateOf(uint256 poolId) external view returns (OfferingState);
}
```

### 5.4 权限和约束

| 操作 | 权限 | 约束 |
|---|---|---|
| `createOffering` | pool factory / exporter operator | eBL 必须已登记，issuePrice > 0 |
| `subscribe` | permissioned investor | pool 必须 Open / Repriced，amount > 0 |
| `pauseOffering` | owner / oracle / risk operator | pool 不能已结算 |
| `applyPricingAction` | only `RiskPricingOracle` 或 risk operator | action 必须合法，hash 必须非空 |
| `settle` | pool operator | pool 必须是有认购者的活跃状态，付款证明与到港证明齐全且金额一致（v2，见 §0.4） |

### 5.5 Action 到状态转换

| action | 目标状态 |
|---|---|
| OPEN_OFFERING | Open |
| OPEN_WITH_WARNING | Open 或 Repriced |
| REPRICE_DOWN | Repriced |
| PAUSE_OFFERING | Paused |
| FREEZE_POOL | Frozen |
| TRIGGER_LIQUIDATION | Liquidation |

## 6. WEB3-4：RiskPricingOracle

### 6.1 目的

`RiskPricingOracle` 把 AI 的 `PricingQuote` 和风险动作写成链上事件，并把动作转发给 `RWAOfferingPool`。它不负责生成 AI 结果，只负责记录、鉴权和触发状态变化。

### 6.2 Interface

```solidity
interface IRiskPricingOracle {
    event PricingUpdated(
        uint256 indexed poolId,
        uint256 issuePrice,
        uint8 riskLevel,
        uint8 action,
        bytes32 evidenceHash,
        bytes32 quoteHash,
        address indexed updater
    );

    event UpdaterSet(address indexed updater, bool allowed);

    function updatePricing(
        uint256 poolId,
        uint256 issuePrice,
        uint8 riskLevel,
        uint8 action,
        bytes32 evidenceHash,
        bytes32 quoteHash
    ) external;

    function setUpdater(address updater, bool allowed) external;

    function isUpdater(address updater) external view returns (bool);

    function latestQuoteHash(uint256 poolId) external view returns (bytes32);

    function latestEvidenceHash(uint256 poolId) external view returns (bytes32);
}
```

### 6.3 权限和约束

| 操作 | 权限 | 约束 |
|---|---|---|
| `updatePricing` | authorized AI pricing updater | poolId 必须存在，issuePrice > 0，hash 非空 |
| `setUpdater` | owner / governance | updater != address(0) |

### 6.4 与 RWAOfferingPool 的关系

`updatePricing` 应做两件事：

1. emit `PricingUpdated`，把 `issuePrice`、`riskLevel`、`action`、`evidenceHash`、`quoteHash` 留痕；
2. 调用或允许后续调用 `RWAOfferingPool.applyPricingAction(...)`，让 offering 状态变化。

MVP 可以先把第 2 步放在 JS mock 或测试脚本中完成；Solidity 最小版本优先保证 event 可测。

## 7. WEB3-1 ~ WEB3-4 完成定义

| ID | 完成定义 | Evidence |
|---|---|---|
| WEB3-1 | `EBLRegistry` interface、事件、权限、约束明确 | `docs/contracts.md` §3 |
| WEB3-2 | `RWAToken` interface、mint 权限、permissioned 约束明确 | `docs/contracts.md` §4 |
| WEB3-3 | `RWAOfferingPool` interface、状态机、action 转换明确 | `docs/contracts.md` §5 |
| WEB3-4 | `RiskPricingOracle` interface、`PricingUpdated` event、updater 权限明确 | `docs/contracts.md` §6 |

后续 WEB3-5 的 JS contract mock 和 WEB3-6 ~ WEB3-9 的 Hardhat 合约必须对齐本文件。

## Phase 7 独立扩展：AgentDecisionLog（已部署并初始化）

新合约继承 `Owned`，不会改变原有六份协议合约的源码、地址或资产权限。owner 只能登记不可覆盖的 Agent 版本及显式授权/撤销 anchorer；已有专用 pricing 地址可提交最多 256 条、无空隙和重叠的决策 Merkle 批次。公开 `verifyInclusion` 核对包含证明，合约无转账或池操作。

`AgentVersionRegistered` 固定策略/源码承诺与模型标识；`DecisionBatchAnchored` 记录批次、根、序号范围、条数、版本和发送者。owner 自己也需显式 anchorer 授权。JS 与 Solidity 已在本地互验；2026-10-15 按用户授权在 chain 1439 部署至 [`0x6AC3bDDbBc5ab082b7c0dF0C78C2d377578BE6Ec`](https://testnet.blockscout.injective.network/address/0x6AC3bDDbBc5ab082b7c0dF0C78C2d377578BE6Ec)，完成审阅版本注册及现有专用 pricing 地址的 anchorer 授权。三笔精确交易、回执、事件及字节码均通过独立只读核验，见 [实链证据](evidence/phase7-live-deployment-verification.json)。当前 `batchCount=lastSeq=0`；后台启用及首次批次仍需单独授权。完整接口、叶子算法、部署恢复和证据局限见 [Phase 7 指南](phase7-decision-anchoring.md)。
