# AgentBL Web3 Contract Interface

状态：WEB3-1 ~ WEB3-4 设计冻结  
命名来源：以 `docs/PRD.md` v0.2 为准  
范围：先定义可被 JS contract mock、Hardhat 合约和前端共同复用的最小接口，不做公开募资、不做 AMM、不承诺保本收益。

> 2026-10-17 更新：**协议 v3 已部署并初始化**，4 个新核心合约、3 笔连接/角色交易，共 7 笔实链回执与 7 份当前合约字节码核验通过，见 [部署证据](evidence/protocol-v3-deployment-2026-10-17/README.md)。v3 调价保留生命周期，以已售份额原始目标债务核对清偿；支持追加回收、Defaulted/LossSettled，只有质押池能解押。新状态追加在旧枚举之后。旧 v2 资产、持仓、质押和回执留在原地址，未迁移或重铸；当前 v3 是空 Registry/Pool。下方历史 v2 接口表不能覆盖 v3 的状态规则。

## 0. 当前 v3 部署与历史 v2 接口

> **以源码为准。** 下面 §1–§7 是 WEB3-1 ~ WEB3-4 冻结时的最小接口设计，仍可当作接口说明阅读。合约之后演进到了 v2：数字编码（状态序号、动作码）以 `hardhat/contracts/*.sol` 为唯一事实来源，`tests/contractParity.test.js` 会校验 JS 常量与它一致，`hardhat/test/offeringModel.test.js` 用随机序列对照参考模型来验证状态机。

### 0.1 部署状态

| 项目 | 状态 |
|---|---|
| 链上（Injective EVM 测试网，chainId 1439） | Registry、Token、Pool、Oracle 为 2026-10-17 v3 核心部署；另外 3 份辅助合约沿用旧地址。7 份字节码均匹配。owner 仍为 `0x9da22292D85e2A584ace6bb347D7054486b5ed6B`，现有专用 updater `0xEB43623667f1Add616D0FbdEBbbE067a0F195F79` 已获新 Oracle 授权 |
| 本仓库源码 | v3 的定价阶段、全额清偿和解押权限已部署；托管、放款和投资者兑付仍未实现 |
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

### 0.5 测试覆盖

`cd hardhat && npm test`（或在仓库根目录运行 `npm run test:contracts`）：

- `contractHardening.test.js`：上表每一项的回归测试；
- `offeringModel.test.js`：参考模型对照。用固定种子的随机序列同时驱动模型和真实合约，逐步比对“该不该成功”和结果状态，并检查全局不变量（价格不超过目标、认购不超供给、`Repaid` 必有认购者和两份证明、终态不再占用 eBL 槽位等）。把合约里任一关键检查删掉（变异测试）都会让它失败；
- `deploySmoke.test.js`：在本地重放 `deploy-protocol.js` 的链上冒烟序列，避免合约规则改动让真实部署的冒烟失败；
- 其余是原有的单元测试。

仓库根目录的 `tests/contractParity.test.js` 校验 JS harness 的动作码、风险等级与 Solidity 源码一致。

### 0.6 已知限制

这是演示级别的协议，**不要在其上放真实资金**：

1. **没有支付腿。** `subscribe` 只铸造份额凭证，并在事件里记录应付金额（`paidAmount`），不托管任何稳定币；`settle` 只记录进口商回款证明，不向投资者分配。上线前需要加入 ERC-20 托管与按比例赎回（并因此启用 `Redeemed`）。`contractHardening` 里有一条测试把这个限制固定下来，补上支付腿时需要有意识地更新它。
2. **质押由 registry owner 说了算。** `EBLRegistry.releasePledge` 允许 registry owner 随时解除质押；v2 只保证解除之后不会继续**新增**认购，并且结算时能容错。
3. **单 owner 信任模型。** owner 能暂停、取消（无认购者时）、更正回款证明、更换 oracle。生产环境应换成多签，并把 executor、updater、attestor 的密钥分开（后端已按最小权限分角色，见 `.env.example`）。
4. **oracle 是受信角色。** 价格只有上下界（≤ 目标赎回价，`REPRICE_DOWN` 必须降价），链上没有风险模型校验；可信度来自 updater 密钥以及事件里的 `evidenceHash` / `quoteHash` 审计线索。
5. **`RWAToken` 不可转让**，没有二级市场；`setTransferPermission` 只是预留的白名单记录。
6. **`AgentBLRWA` 是演示合约**：`tokenize` 对任何钱包开放，所有数据由调用方提供，链上不验证其真实性。

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
