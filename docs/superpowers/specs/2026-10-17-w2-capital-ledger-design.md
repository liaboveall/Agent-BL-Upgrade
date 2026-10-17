# W2 资金与账本批次设计文档

日期：2026-10-17，Asia/Singapore。  
代码基线：`cc09644fb652d5a995342a083362e7b95e8dd8b1`（report 基线），本地源码已含 W1/v4 实现。  
来源：`docs/project-blockchain-comprehensive-report-2026-10-17.md` 第 7、9、11、12 部分。  

## 1. 目标

在本地源码中完成 W2 批次：把当前仅记录份额、不移动资金的 v4 协议，扩展为具备**原子认购托管、按池资金隔离、募集失败退款、投资者兑付领取、可恢复融资账本**的本地候选版本。  

本批次关闭 issue register 中的：A09、B01、B02、B03、B12。  

验收底线：在本地真实 EVM + 真实 JS 适配器上跑通完整生命周期；满足不变量 I02–I05、I09、I11；不依赖合成 provider 作为唯一证据。

## 2. 范围

### 2.1 在本批次内

- 新的合约候选版本（v5），新增资金腿，保留 W1/v4 的所有状态机和前置条件。
- 按池 ERC-20 托管：认购时资金进入池子专属余额，mint 份额在同一事务完成。
- 募集规则：`minRaise`、`subscriptionDeadline`、达到条件后放款、未达标/取消/到期时按实际出资退款。
- 投资者兑付：`claim` / `redeem` 幂等领取，按份额比例分配实际回收，扣除费用，处理损失。
- 可恢复融资账本：持久化 Live 认购、放款、回款、领取分录，支持从链事件重建。
- Live 持仓统一视图：链上 `RWAToken` 余额 + 账本成本/可领取/已领取合并展示。
- 正式回归测试：Hardhat 合约测试 + 跨层应用测试 + 账本恢复测试。

### 2.2 不在本批次内

- 真实法币、银行托管、法律执行安排（W3/W4 业务条件）。
- 投资者 KYC/AML/持续合规（B08，W3 决策）。
- 真实单证验签、MLETR 法律安排、资产唯一性跨平台证明（B04–B07，W3）。
- 链上商业信息最小披露重构（B10，W3）。
- 证据 schema 版本化、Merkle 锚定、真实模型/付款提供方评测（B11、C01–C03，W4）。
- 真实网络部署、容量/灾备/异机恢复演练（C04–C05，W5）。

## 3. 高层架构

```text
┌─────────────────────────────────────────────────────────────────┐
│  前端 / Copilot                                                  │
│  · 统一持仓视图（Demo + Live）                                    │
│  · Live 认购确认：条款、价格、版本、截止、资产、权利说明          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  AgentBL 后端 (src/app/server.js)                                │
│  · /api/positions 读模型                                          │
│  · /api/pools/:id/subscribe Live 分支：构造 calldata + 记录意图   │
│  · ownerTxPlan / settlementPipeline 使用 ledger 与 v5 ABI        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  可恢复融资账本 (src/ledger/)                                    │
│  · TransactionIntent：待广播/待确认/已确认/失败                   │
│  · CashEntry：入金、放款、退款、回款、领取、费用、调整            │
│  · Position：每 (协议实例, 池, 投资者) 的份额、成本、可领、已领   │
│  · 启动时从链事件回放重建                                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Hardhat / 本地 EVM                                              │
│  RWAOfferingPoolV5: 托管、认购、放款、退款、兑付、claim          │
│  RWATokenV5: 配合 burn / 领取记账                                │
└─────────────────────────────────────────────────────────────────┘
```

## 4. 合约设计

### 4.1 版本与部署约束

- 新合约命名为 `RWAOfferingPoolV5`（文件可保留 `RWAOfferingPool.sol` 并在源码中升级 `protocolVersion` 到 5，或新建 `RWAOfferingPoolV5.sol`）。
- 已部署的 v3/v4 地址行为不变；本地测试与 ABI 合并不能视为链上已验证。
- `protocolVersion = 5`。
- 编译参数保持 Solidity 0.8.24、viaIR、Paris EVM、优化 200 runs。

### 4.2 新增状态与事件

#### 状态（在现有 `OfferingState` 基础上不变）

保留 W1/v4 全部枚举，不删除已有状态。

#### 新增事件

```solidity
event FundEscrowed(
    uint256 indexed poolId,
    address indexed asset,
    address indexed investor,
    uint256 amountAtomic,
    uint256 shares
);

event DisbursedToExporter(
    uint256 indexed poolId,
    address indexed asset,
    uint256 amountAtomic,
    bytes32 evidenceHash
);

event InvestorRefunded(
    uint256 indexed poolId,
    address indexed investor,
    address indexed asset,
    uint256 amountAtomic
);

event Claimed(
    uint256 indexed poolId,
    address indexed investor,
    address indexed asset,
    uint256 amountAtomic,
    uint256 sharesBurned
);

event FeeDeducted(
    uint256 indexed poolId,
    address indexed asset,
    uint256 feeAtomic,
    bytes32 feeEvidenceHash
);

event PoolFundingTermsSet(
    uint256 indexed poolId,
    address settlementAsset,
    uint256 minRaise,
    uint256 maxRaise
);
```

### 4.3 存储扩展

```solidity
struct Offering {
    uint256 eblId;
    uint256 tokenSupply;
    uint256 issuePrice;
    uint256 targetRedemptionValue;
    uint256 subscribed;
    uint256 repaymentAmount;
    bytes32 paymentProof;
    bytes32 arrivalProof;
    OfferingState state;
    bool exists;
    // W2 additions
    address settlementAsset;
    uint256 minRaise;
    uint256 raisedAtomic;
}

// 每池、每资产、每投资者的托管与领取
mapping(uint256 => mapping(address => uint256)) public escrowed;          // pool => asset => balance
mapping(uint256 => mapping(address => mapping(address => uint256))) public investorPaid; // pool => asset => investor => cost basis
mapping(uint256 => mapping(address => mapping(address => uint256))) public investorClaimed;
mapping(uint256 => uint256) public totalClaimed;
mapping(uint256 => uint256) public feesDeducted;
```

### 4.4 关键函数

#### 创建：`createOfferingWithTermsV5`

```solidity
function createOfferingWithTerms(
    uint256 eblId,
    uint256 tokenSupply,
    uint256 issuePrice,
    uint256 targetRedemptionValue,
    uint256 maturity,
    uint256 subscribeUntil,
    address settlementAsset,
    uint256 minRaise
) external onlyOwner whenOperational returns (uint256 poolId);
```

- `settlementAsset` 必须是合约地址且非零。
- `minRaise <= tokenSupply * issuePrice`。
- `minRaise > 0` 为必须；`0` 仅在测试网明确标记为“无最低募集”时允许（默认拒绝）。
- 原子写入 `maturity`、`subscribeUntil`、`settlementAsset`、`minRaise`。
- 发出 `OfferingCreated`、`OfferingTermsSet`、`PoolFundingTermsSet`。

#### 认购：`subscribeWithTerms`

```solidity
function subscribeWithTerms(
    uint256 poolId,
    uint256 amount,        // 份额数量
    uint256 maxUnitPrice,
    uint256 expectedQuoteVersion,
    uint256 deadline
) external whenOperational;
```

行为：

1. 复用 W1/v4 的全部前置条件：状态、截止、资格、版本、价格、用户 deadline。
2. 计算 `cost = amount * issuePrice`。
3. `safeTransferFrom(msg.sender, address(this), cost)`（使用 OpenZeppelin `SafeERC20`）。
4. 若转账失败或返回 false，整笔事务回滚。
5. 更新 `escrowed[poolId][asset] += cost`、`investorPaid[poolId][asset][msg.sender] += cost`、`raisedAtomic += cost`。
6. `rwaToken.mint(poolId, msg.sender, amount)`。
7. 发出 `Subscribed`、`FundEscrowed`。
8. 状态迁移：认购满 `tokenSupply` 为 `Funded`；否则 `Subscribed`。

边界：

- 重入：先更新状态/余额再 external call；使用 `SafeERC20` 的 `safeTransferFrom`。
- 异常资产：非 ERC-20 或带转账税的 token 需先在创建时通过白名单校验；本批次默认使用标准 6-decimal 测试 token。
- 并发：依赖 `subscribed + amount <= tokenSupply` 保证不超供给。

#### 放款：`disburseToExporter`

```solidity
function disburseToExporter(
    uint256 poolId,
    uint256 amountAtomic,
    bytes32 evidenceHash
) external onlyOwner whenOperational;
```

- 仅当 `state == Funded || state == InTransit`。
- `amountAtomic <= escrowed[poolId][asset] - alreadyDisbursed`。
- 默认放款金额为 `raisedAtomic`（全额放款），也支持部分放款。
- 转账给 exporter（由创建参数或 owner 提供地址；本批次在 params 中显式传入）。
- 发出 `DisbursedToExporter`。
- 不烧份额、不解押。

#### 退款：`refundInvestor` / `refundAllOnFailure`

```solidity
function refundInvestor(uint256 poolId, address investor) external whenOperational;
function refundAllOnFailure(uint256 poolId) external onlyOwner whenOperational;
```

触发条件：

- 募集截止后 `raisedAtomic < minRaise`。
- `cancelOffering`（无认购者时原路径；有认购者时不允许 cancel）。
- `resolveLiquidation` 无认购者分支已覆盖。

行为：

- 仅当 `state` 为 `Open`、`Subscribed`、`Repriced`、`Paused`、`Frozen` 且满足失败条件；或已进入 `Cancelled`。
- 按 `investorPaid[poolId][asset][investor]` 退回实际出资，不扣费。
- 更新余额、发出 `InvestorRefunded`。
- 全部退完后可进入 `Cancelled` 并解押（`refundAllOnFailure` 最后一条执行）。

#### 投资者领取：`claim`

```solidity
function claim(uint256 poolId) external whenOperational;
```

行为：

- 仅当 `state == Repaid || state == LossSettled`。
- 计算可分配回收：`distributable = repaymentAmount - feesDeducted - totalClaimed`。
- 投资者份额 `balance = rwaToken.balanceOf(poolId, msg.sender)`。
- 可领金额 = `distributable * balance / totalSupply`。
- 更新 `investorClaimed`、`totalClaimed`，转账，可选项 burn 份额。
- 发出 `Claimed`。
- 幂等：已领取过的投资者再次调用返回 0 或 revert `nothing to claim`。

损失处理：

- `LossSettled` 时 `repaymentAmount` 为实际回收，`realizedLoss` 记录缺口；按实际回收比例分配。
- 不得向未持有份额者发放。

#### 费用扣除：`deductFee`

```solidity
function deductFee(
    uint256 poolId,
    uint256 amountAtomic,
    bytes32 feeEvidenceHash
) external onlyOwner whenOperational;
```

- 仅在 `Repaid` 之前或 `Repaid` 状态下可扣。
- `feesDeducted + amountAtomic <= repaymentAmount`。
- 转账给费用接收方（参数传入或配置）。
- 发出 `FeeDeducted`。

### 4.5 不变量

- I02：资金失败无份额，份额失败无扣款；同一事务完成。
- I03：每池资金独立；`escrowed` 按 `(poolId, asset)` 记账，禁止跨池读取。
- I04：已售份额目标债务不变；新价只影响未售份额。
- I05：每笔 `CashEntry` 通过 `(txHash, logIndex)` 去重；链上 `usedPaymentProof` 继续生效。
- I09：`totalClaimed + 当前可领 <= repaymentAmount - feesDeducted`。

## 5. 可恢复融资账本

### 5.1 目录与存储

```
data/runtime/ledger/
  intents.jsonl          # TransactionIntent 追加写
  cash-entries.jsonl     # CashEntry 追加写
  positions.json         # 当前 Position 快照，按协议实例聚合
  cursor.json            # 每个协议实例的最后处理块号
```

所有写入使用原子文件替换（`writeJsonAtomic` 或等效实现）。`jsonl` 文件只追加，不修改历史行。

### 5.2 数据模型

#### TransactionIntent

```ts
{
  intent_id: string,          // uuid
  protocol_instance: { chain_id, pool_address, protocol_version },
  chain_pool_id: number,
  operation: 'SUBSCRIBE' | 'DISBURSE' | 'REFUND' | 'CLAIM' | 'DEDUCT_FEE',
  investor?: string,
  asset: string,
  amount_atomic: string,
  shares?: string,
  calldata?: string,
  tx_hash?: string,
  status: 'draft' | 'broadcast' | 'confirmed' | 'failed',
  created_at: ISO8601,
  broadcast_at?: ISO8601,
  confirmed_at?: ISO8601,
  block_number?: number,
  error?: string
}
```

#### CashEntry

```ts
{
  entry_id: string,
  intent_id: string,
  protocol_instance: { chain_id, pool_address, protocol_version },
  chain_pool_id: number,
  kind: 'INVESTOR_DEPOSIT' | 'DISBURSEMENT' | 'REFUND' | 'RECOVERY' | 'CLAIM' | 'FEE',
  asset: string,
  from?: string,
  to?: string,
  amount_atomic: string,
  // 唯一占用键，防止同一链事实被重复记账
  source?: { tx_hash: string, log_index: number },
  evidence_hash?: string,
  occurred_at: ISO8601,
  block_number?: number
}
```

#### Position

```ts
{
  position_id: string,        // uuid
  protocol_instance: { chain_id, pool_address, protocol_version },
  chain_pool_id: number,
  investor: string,
  asset: string,
  shares: string,
  cost_atomic: string,        // 实际出资
  claimed_atomic: string,
  claimable_atomic: string,   // 根据链状态实时计算
  status: 'active' | 'refunded' | 'fully_claimed'
}
```

### 5.3 单写者纪律

- 只有 `LedgerWriter`（后端进程内单例）写入 `intents.jsonl` 和 `cash-entries.jsonl`。
- Position 快照可由重建任务写入，但必须以 `cash-entries.jsonl` 为唯一事实来源。
- 链事件回放与本地意图匹配：以 `(txHash, logIndex)` 或 `intent_id` 关联，不依赖内存状态。

### 5.4 重建流程

启动时：

1. 读取 `cursor.json` 获取每个协议实例的最后处理块。
2. 从该块扫描 `RWAOfferingPoolV5` 和 `RWATokenV5` 事件：
   - `Subscribed` → `INVESTOR_DEPOSIT`
   - `DisbursedToExporter` → `DISBURSEMENT`
   - `InvestorRefunded` → `REFUND`
   - `LiquidationRecoveryRecorded` / `AdditionalPaymentRecorded` → `RECOVERY`
   - `Claimed` → `CLAIM`
   - `FeeDeducted` → `FEE`
3. 对每笔事件检查 `source` 是否已在 `cash-entries.jsonl` 存在；存在则跳过。
4. 重算所有 `Position` 并写入 `positions.json`。
5. 更新 `cursor.json`。

### 5.5 与 Demo 的隔离

- Demo 继续使用 `storeState.investments`，不写入 ledger。
- Live 持仓视图同时查询 ledger Position 和 Demo investments，按 `mode` 字段区分。
- 禁止用 Demo 记录补造链上持仓。

## 6. 应用层改动

### 6.1 新增模块

- `src/ledger/`：ledger.js、writer.js、rebuilder.js、positionView.js
- `src/chain/protocolV5Abi.js`：v5 ABI 片段，合并到 `protocolAbi()`。

### 6.2 修改模块

- `src/app/server.js`：
  - 初始化 `Ledger`。
  - `/api/positions`：返回统一视图。
  - `/api/pools/:id/subscribe`：Live 模式构造 `subscribeWithTerms` calldata，先写 `TransactionIntent`，再等待用户签名广播或后端代为广播（本批次先支持后端托管广播，用于本地测试）。
- `src/app/store.js`：
  - `subscribeToPool` 保持 Demo 路径不变。
  - 新增 `recordLiveSubscriptionIntent` / `confirmLiveSubscription` 与 ledger 交互。
- `src/agent/runtime/poolRules.js`：
  - 新增 `DISBURSE`、`REFUND`、`CLAIM` 的允许状态检查。
- `src/agent/runtime/ownerTxPlan.js`：
  - 新增 `DISBURSE_TO_EXPORTER`、`REFUND_INVESTOR`、`DEDUCT_FEE` 的 plan builder。
- `src/agent/pipelines/settlementPipeline.js`：
  - `SETTLE` 成功后可选触发 `claim` 计划；保持与 v5 兼容。
- `src/agent/runtime/sources/chainWatcher.js`：
  - 订阅 v5 新增事件并生成 ledger entries。

### 6.3 统一持仓视图 API

`GET /api/positions?wallet=0x...`

```json
{
  "wallet": "0x...",
  "positions": [
    {
      "mode": "live",
      "protocol_instance": { "chain_id": 1439, "pool_address": "0x...", "protocol_version": 5 },
      "pool_id": "off-chain-pool-id",
      "chain_pool_id": 1,
      "asset": "0x...",
      "shares": "100",
      "cost_usd": "80.00",
      "claimable_usd": "95.00",
      "claimed_usd": "0.00",
      "status": "active"
    },
    {
      "mode": "demo",
      "pool_id": "demo-pool-id",
      "shares": "50",
      "cost_usd": "40.00",
      "status": "active"
    }
  ]
}
```

## 7. 前端改动

### 7.1 统一持仓页面

- 列表展示 Demo 与 Live 持仓，用标签区分。
- Live 持仓显示：协议实例、链上 pool id、结算资产、份额、成本、可领取、已领取、状态。
- 未知余额来源（链上余额与 ledger 不一致）显示“对账中”，不自动归为已付款融资。

### 7.2 Live 认购流程

- 确认弹窗明确说明：
  - 购买的是何种权利（份额、目标兑付值、损失分担方式）。
  - 需要支付的资产和金额。
  - 款项进入托管，不是直接到出口商。
  - 募集失败时的退款权利。
- 调用 `subscribeWithTerms` 并绑定 `maxUnitPrice`、`expectedQuoteVersion`、`deadline`。

### 7.3 兑付/领取

- `Repaid` 或 `LossSettled` 状态显示“领取”按钮。
- 调用 `claim`，展示领取结果和交易回执。

## 8. 测试策略

### 8.1 Hardhat 合约测试（`hardhat/test/protocolV5.test.js`）

覆盖：

- 创建：无效资产、minRaise > maxRaise、过期条款被拒绝。
- 认购：
  - 资金成功 + 份额正确。
  - 资金失败（approve 不足、余额不足）回滚，无份额。
  - 重入尝试失败。
  - 截止后、版本变化后、价格漂移后回滚。
  - 并发认购不超供给。
- 募集失败退款：
  - 截止后未达 minRaise，投资者可退款。
  - 退款金额 = 实际出资。
  - 重复退款 revert。
- 放款：
  - Funded 后 owner 可放款。
  - 超额放款 revert。
- 兑付：
  - Repaid 后投资者按份额 claim。
  - 重复 claim 返回 0。
  - LossSettled 后按实际回收比例 claim。
  - 费用扣除后 claim 减少。
- 资金隔离：
  - 两个池使用不同资产，余额互不挪用。
  - 同一投资者在不同池成本独立。

### 8.2 跨层测试（`tests/w2CrossLayer.test.js`）

覆盖：

- 本地部署 v5 → AgentBL 后端识别 v5 ABI。
- 创建带条款的 offering → 后端读取 `maturityAt` / `subscriptionDeadline`。
- Live 认购 → ledger 写入意图 → 广播 → 确认 → 持仓视图更新。
- 募集失败 → 退款计划 →  ledger 更新 → 持仓状态变为 `refunded`。
- 回款 + settle → claim → 领取到账。
- 崩溃重建：
  - 在广播后 kill 进程，重启后从链事件重建 Position，不重复发放。

### 8.3 不变量检查

在随机模型中加入：

- 按池资金守恒：`escrowed = sum(投资者存款) - 放款 - 退款 - 领取 - 费用`。
- 份额守恒：`totalSupply = sum(投资者余额)`。
- 领取上限：`totalClaimed + 可领 <= repaymentAmount - feesDeducted`。

## 9. 风险与回退

| 风险 | 缓解 |
|---|---|
| 新合约 ABI 与现有 v4 测试冲突 | 保留 `protocolV4.test.js` 不变；v5 使用新文件和新 helper，ABI 通过 `protocolAbi()` 合并而非替换。 |
| 资金腿引入重入或 approve 滥用 | 使用 `SafeERC20`，先更新内部账再 external call；所有转账函数通过重入测试。 |
| Ledger 重建遗漏事件 | cursor 持久化，启动时从 cursor 前一块重放；重复事件用 `(txHash, logIndex)` 去重。 |
| Demo 与 Live 数据混淆 | ledger Position 与 Demo investments 两个独立集合，统一视图 API 显式标注 mode。 |
| 真实资金误用 | v5 仅在本地/测试网使用；`createOfferingWithTerms` 不默认启用，部署计划明确标识为测试候选。 |

## 10. 验收清单

2026-10-17：下列项目按本地 v5 候选实现验收，详见 [证据](../../evidence/w2-local-2026-10-17/README.md)。issue register 使用 `IMPLEMENTED`，不将本地测试等同于部署或真实资金验收。终态后的迟到回款明确拒绝；剩余未放款本金随结算返还。付款归证事件不重复生成现金分录。

对应 issue register 关闭条件：

- [x] A09：Live 认购进入统一持仓视图；钱包、追加、重启、不同地址、回执重组后持仓正确。
- [x] B01：原子认购 + 按池资金隔离；错误资产、重入、并发、无返回值 token 处理。
- [x] B02：募集目标、截止、放款、退款全路径可验证；退款按实际出资。
- [x] B03：兑付、费用、损失分配、防双领；足额/部分/零回收均有确定结果。
- [x] B12：可恢复融资账本；断电/崩溃/重启后不重复付款、不丢份额；独立进程竞争不双占。
- [x] I02–I05、I09、I11：通过随机模型和正式回归。

## 11. 后续批次接口

W2 完成后，W3/W4/W5 可继续：

- W3：权利与控制（B04–B10）。
- W4：证据与来源（B11、C01–C03）。
- W5：交付与运营（C04–C07）。

本设计文档批准后，将使用 `superpowers:writing-plans` 编写具体实现计划。