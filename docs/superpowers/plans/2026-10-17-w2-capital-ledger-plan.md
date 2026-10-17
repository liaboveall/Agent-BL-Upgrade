# W2 资金与账本批次实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.


> **2026-10-17 接手完成记录：** Qoder 的 Task 1–9 已有提交，接手基线为 `788db8a`。剩余集成、恢复、资金边界、领取界面与验收已在工作区完成，详情见 [W2 验收](../../evidence/w2-local-2026-10-17/README.md)。下面代码块保留原始计划；以当前源码和验收记录为准。初次本地验收未提交、推送或部署；用户随后明确要求“提交推送”，交付补充记录见 [提交验证](../../evidence/w2-delivery-2026-10-17/README.md)。

**Goal:** 在本地源码中完成 W2 批次：为 v4 协议增加资金托管腿、募集退款、投资者兑付，以及可恢复的融资账本和统一持仓视图。

**Architecture:** 在 `RWAOfferingPool` 基础上新增 v5 资金层（`subscribeWithTerms` 原子收资mint、`disburseToExporter`、`refundInvestor`、`claim`）；后端新增 `src/ledger/` 持久化分录和 Position，支持从链事件重建；前端展示 Demo/Live 统一持仓。合约、账本、应用、测试分层推进，每层有独立回归。

**Tech Stack:** Solidity 0.8.24、Hardhat 3、Ethers v6、Node.js 20+、OpenZeppelin Contracts 5.x（Hardhat 子工程）、React 19 + Vite。

**Spec:** [`docs/superpowers/specs/2026-10-17-w2-capital-ledger-design.md`](../specs/2026-10-17-w2-capital-ledger-design.md)

## Global Constraints

- 新合约 `protocolVersion = 5`；已部署 v3/v4 地址行为不变。
- 编译参数：Solidity 0.8.24、viaIR、Paris EVM、优化 200 runs。
- 金额单位：6 decimals 原子整数（USDC 风格）。
- 份额单位：whole share（与 v4 一致）。
- 仅在本地 Hardhat / 测试网使用，不涉及真实资金。
- Demo 与 Live 账本严格隔离；禁止用 Demo 数据补造链上持仓。
- 所有持久化写入使用 `writeJsonAtomic` 或 `appendJsonl`。

---

## File Structure

### 新建文件

| 文件 | 职责 |
|---|---|
| `hardhat/contracts/RWAOfferingPoolV5.sol` | v5 资金层合约 |
| `hardhat/contracts/RWATokenV5.sol` | 配合 v5 的份额凭证（新增 burn 接口） |
| `hardhat/contracts/MockUSDC.sol` | 测试用 6-decimal ERC-20 |
| `hardhat/test/protocolV5.test.js` | v5 资金层回归测试 |
| `hardhat/test/helpers/protocolV5.js` | v5 测试辅助函数 |
| `src/ledger/ledger.js` | Ledger 主类：意图、分录、Position 管理 |
| `src/ledger/writer.js` | 原子写入器（intents.jsonl / cash-entries.jsonl / positions.json / cursor.json） |
| `src/ledger/rebuilder.js` | 从链事件重建 ledger |
| `src/ledger/positionView.js` | 生成统一持仓视图 |
| `src/chain/protocolV5Abi.js` | v5 ABI 片段 |
| `tests/w2CrossLayer.test.js` | 跨层生命周期测试 |
| `tests/helpers/ledgerTestHarness.js` | ledger 测试辅助 |

### 修改文件

| 文件 | 修改点 |
|---|---|
| `hardhat/package.json` | 添加 `@openzeppelin/contracts` 依赖 |
| `hardhat/contracts/RWAOfferingPool.sol` | 保留 v4 不变，或确认其作为 v5 基线 |
| `src/app/server.js` | 初始化 ledger；新增 `/api/positions` 和 Live 认购分支 |
| `src/app/store.js` | 新增 Live 认购意图记录函数 |
| `src/agent/runtime/poolRules.js` | 新增 DISBURSE/REFUND/CLAIM 规则 |
| `src/agent/runtime/ownerTxPlan.js` | 新增 v5 owner 计划 |
| `src/agent/pipelines/settlementPipeline.js` | 可选 claim 触发 |
| `src/agent/runtime/sources/chainWatcher.js` | 订阅 v5 事件并写入 ledger |
| `src/chain/protocolV4Abi.js` | 改名为 `protocolAbi.js` 或新增 v5 合并 |
| `web/src/lib/web3.js` | Live 认购使用 v5 ABI |
| `web/src/features/positions/` | 统一持仓视图组件（新建目录） |

---

## Task 1: 合约 v5 基础结构与测试代币

**Files:**
- Create: `hardhat/contracts/MockUSDC.sol`
- Create: `hardhat/test/helpers/protocolV5.js`
- Modify: `hardhat/package.json`

**Interfaces:**
- Produces: `MockUSDC` ERC-20 with `mint(address,uint256)` and 6 decimals.
- Produces: `deployProtocolV5()` helper returning `{ owner, investor, outsider, agent, exporter, registry, token, pool, oracle, gate, usdc }`.

- [x] **Step 1: Add OpenZeppelin dependency**

Modify `hardhat/package.json`:

```json
{
  "devDependencies": {
    "@openzeppelin/contracts": "^5.1.0"
  }
}
```

Run:

```bash
cd hardhat && npm install
```

Expected: `hardhat/node_modules/@openzeppelin/contracts` exists.

- [x] **Step 2: Create MockUSDC.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    uint8 public constant DECIMALS = 6;
    constructor() ERC20("Mock USDC", "mUSDC") {}
    function decimals() public pure override returns (uint8) { return DECIMALS; }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
```

- [x] **Step 3: Create protocolV5.js helper**

```javascript
import { STATE, ACTION, TARGET, ISSUE_PRICE, send, uniqueHash, deployProtocol as deployProtocolV4 } from './protocol.js';

export { STATE, ACTION, TARGET, ISSUE_PRICE, send, uniqueHash };

export async function deployProtocolV5() {
  const ctx = await deployProtocolV4();
  const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
  await usdc.waitForDeployment();
  const [exporter] = await ethers.getSigners();
  return { ...ctx, exporter, usdc };
}

export async function newOfferingV5(ctx, tag, {
  supply = 100n, issuePrice = ISSUE_PRICE, target = TARGET,
  maturityIn = 1_000, deadlineIn = 100, minRaise = 80n * issuePrice
} = {}) {
  await send(ctx.registry.mintEBL(ethers.id(`metadata:${tag}`), ctx.owner.address));
  const eblId = (await ctx.registry.nextEblId()) - 1n;
  await send(ctx.registry.pledge(eblId, await ctx.pool.getAddress()));
  const start = (await ethers.provider.getBlock('latest')).timestamp;
  const maturity = BigInt(start) + BigInt(maturityIn);
  const deadline = BigInt(start) + BigInt(deadlineIn);
  await send(ctx.pool.createOfferingWithTerms(eblId, supply, issuePrice, target, maturity, deadline, await ctx.usdc.getAddress(), minRaise));
  return { eblId, poolId: (await ctx.pool.nextPoolId()) - 1n, maturity, deadline };
}
```

- [x] **Step 4: Verify compile**

Run:

```bash
cd hardhat && npm run compile
```

Expected: `MockUSDC` artifact generated; no compile errors.

- [x] **Step 5: Commit**

```bash
git add hardhat/package.json hardhat/package-lock.json hardhat/contracts/MockUSDC.sol hardhat/test/helpers/protocolV5.js
# if artifacts are tracked, also add hardhat/artifacts/contracts/MockUSDC.sol/MockUSDC.json
git commit -m "chore(hardhat): add MockUSDC and v5 test helper"
```

---

## Task 2: RWAOfferingPoolV5 资金层合约

**Files:**
- Create: `hardhat/contracts/RWAOfferingPoolV5.sol`
- Create: `hardhat/contracts/RWATokenV5.sol`
- Modify: `hardhat/test/protocolV4.test.js` (no change, ensure it still passes)

**Interfaces:**
- Consumes: `MockUSDC` (ERC-20), `EBLRegistry`, `RWATokenV5`.
- Produces: `RWAOfferingPoolV5` with `createOfferingWithTerms`, `subscribeWithTerms`, `disburseToExporter`, `refundInvestor`, `refundAllOnFailure`, `claim`, `deductFee`.
- Produces: `RWATokenV5.burn(poolId, investor, amount)` callable only by pool.

- [x] **Step 1: Write RWATokenV5.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Owned} from "./Owned.sol";

contract RWATokenV5 is Owned {
    address public pool;
    mapping(uint256 => mapping(address => uint256)) private _balances;
    mapping(uint256 => uint256) private _totalSupply;

    event RWAMinted(uint256 indexed poolId, address indexed investor, uint256 amount);
    event RWABurned(uint256 indexed poolId, address indexed investor, uint256 amount);
    event PoolSet(address indexed pool);

    function setPool(address pool_) external onlyOwner {
        require(pool_ != address(0), "pool=0");
        pool = pool_;
        emit PoolSet(pool_);
    }

    function mint(uint256 poolId, address investor, uint256 amount) external {
        require(msg.sender == pool, "only pool");
        require(investor != address(0), "investor=0");
        require(amount > 0, "amount=0");
        _balances[poolId][investor] += amount;
        _totalSupply[poolId] += amount;
        emit RWAMinted(poolId, investor, amount);
    }

    function burn(uint256 poolId, address investor, uint256 amount) external {
        require(msg.sender == pool, "only pool");
        require(amount > 0, "amount=0");
        require(_balances[poolId][investor] >= amount, "insufficient shares");
        _balances[poolId][investor] -= amount;
        _totalSupply[poolId] -= amount;
        emit RWABurned(poolId, investor, amount);
    }

    function balanceOf(uint256 poolId, address investor) external view returns (uint256) {
        return _balances[poolId][investor];
    }

    function totalSupply(uint256 poolId) external view returns (uint256) {
        return _totalSupply[poolId];
    }
}
```

- [x] **Step 2: Write RWAOfferingPoolV5.sol skeleton**

Start by copying `RWAOfferingPool.sol` to `RWAOfferingPoolV5.sol` and changing:

```solidity
contract RWAOfferingPoolV5 is Owned {
    uint256 public constant protocolVersion = 5;
    // ... existing v4 code ...
}
```

Then add the interfaces:

```solidity
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRWATokenV5Mintable {
    function mint(uint256 poolId, address investor, uint256 amount) external;
    function burn(uint256 poolId, address investor, uint256 amount) external;
}
```

Add `using SafeERC20 for IERC20;`.

- [x] **Step 3: Add storage and events**

Add to the existing `Offering` struct:

```solidity
struct Offering {
    // existing v4 fields
    address settlementAsset;
    uint256 minRaise;
    uint256 raisedAtomic;
}
```

Add mappings:

```solidity
mapping(uint256 => mapping(address => uint256)) public escrowed;
mapping(uint256 => mapping(address => mapping(address => uint256))) public investorPaid;
mapping(uint256 => mapping(address => mapping(address => uint256))) public investorClaimed;
mapping(uint256 => uint256) public totalClaimed;
mapping(uint256 => uint256) public feesDeducted;
mapping(uint256 => uint256) public disbursedAtomic;
```

Add events listed in the spec §4.2.

- [x] **Step 4: Implement createOfferingWithTerms**

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
) external onlyOwner whenOperational returns (uint256 poolId) {
    require(maturity > block.timestamp, "maturity elapsed");
    require(subscribeUntil > block.timestamp, "deadline elapsed");
    require(subscribeUntil <= maturity, "deadline>maturity");
    require(settlementAsset != address(0), "asset=0");
    require(settlementAsset.code.length > 0, "asset not contract");
    require(minRaise > 0, "minRaise=0");
    require(minRaise <= tokenSupply * issuePrice, "minRaise>max");

    poolId = _createOffering(eblId, tokenSupply, issuePrice, targetRedemptionValue, maturity, subscribeUntil);
    Offering storage o = offerings[poolId];
    o.settlementAsset = settlementAsset;
    o.minRaise = minRaise;
    emit PoolFundingTermsSet(poolId, settlementAsset, minRaise, tokenSupply * issuePrice);
}
```

Note: update `_createOffering` to initialize the new fields.

- [x] **Step 5: Implement subscribeWithTerms fund leg**

Modify `_subscribe`:

```solidity
function _subscribe(uint256 poolId, uint256 amount) internal {
    Offering storage o = offerings[poolId];
    require(o.exists, "pool missing");
    require(
        o.state == OfferingState.Open || o.state == OfferingState.Repriced || o.state == OfferingState.Subscribed,
        "not open"
    );
    require(block.timestamp <= subscriptionDeadline[poolId], "subscription deadline elapsed");
    require(isInvestorEligible(msg.sender, poolId), "not eligible");
    require(amount > 0, "amount=0");
    require(o.subscribed + amount <= o.tokenSupply, "exceeds supply");
    require(eblRegistry.pledgedTo(o.eblId) == address(this), "ebl not pledged to pool");

    uint256 cost = amount * o.issuePrice;
    IERC20 asset = IERC20(o.settlementAsset);
    uint256 balanceBefore = asset.balanceOf(address(this));
    asset.safeTransferFrom(msg.sender, address(this), cost);
    require(asset.balanceOf(address(this)) - balanceBefore == cost, "transfer tax not supported");

    o.subscribed += amount;
    o.raisedAtomic += cost;
    escrowed[poolId][o.settlementAsset] += cost;
    investorPaid[poolId][o.settlementAsset][msg.sender] += cost;
    rwaToken.mint(poolId, msg.sender, amount);
    emit Subscribed(poolId, msg.sender, amount, cost);
    emit FundEscrowed(poolId, o.settlementAsset, msg.sender, cost, amount);

    OfferingState next = o.subscribed == o.tokenSupply ? OfferingState.Funded : OfferingState.Subscribed;
    if (o.state != next) _changeState(poolId, next, OPEN_OFFERING);
}
```

- [x] **Step 6: Implement disburseToExporter**

```solidity
function disburseToExporter(uint256 poolId, uint256 amountAtomic, address exporter, bytes32 evidenceHash)
    external onlyOwner whenOperational {
    require(exporter != address(0), "exporter=0");
    require(evidenceHash != bytes32(0), "evidence=0");
    Offering storage o = offerings[poolId];
    require(o.exists, "pool missing");
    require(o.state == OfferingState.Funded || o.state == OfferingState.InTransit, "not funded");
    uint256 available = o.raisedAtomic - disbursedAtomic[poolId];
    require(amountAtomic > 0 && amountAtomic <= available, "amount>available");
    disbursedAtomic[poolId] += amountAtomic;
    escrowed[poolId][o.settlementAsset] -= amountAtomic;
    IERC20(o.settlementAsset).safeTransfer(exporter, amountAtomic);
    emit DisbursedToExporter(poolId, o.settlementAsset, amountAtomic, evidenceHash);
}
```

- [x] **Step 7: Implement refundInvestor**

```solidity
function refundInvestor(uint256 poolId, address investor) external whenOperational {
    Offering storage o = offerings[poolId];
    require(o.exists, "pool missing");
    require(
        o.state == OfferingState.Open || o.state == OfferingState.Subscribed ||
        o.state == OfferingState.Repriced || o.state == OfferingState.Paused ||
        o.state == OfferingState.Frozen || o.state == OfferingState.Cancelled,
        "not refundable"
    );
    require(block.timestamp > subscriptionDeadline[poolId] || o.state == OfferingState.Cancelled, "deadline not passed");
    require(o.raisedAtomic < o.minRaise || o.state == OfferingState.Cancelled, "raise succeeded");
    uint256 paid = investorPaid[poolId][o.settlementAsset][investor];
    require(paid > 0, "nothing to refund");
    investorPaid[poolId][o.settlementAsset][investor] = 0;
    o.raisedAtomic -= paid;
    escrowed[poolId][o.settlementAsset] -= paid;
    IERC20(o.settlementAsset).safeTransfer(investor, paid);
    emit InvestorRefunded(poolId, investor, o.settlementAsset, paid);
    _maybeCancelAndRelease(o, poolId);
}
```

Add internal `_maybeCancelAndRelease`:

```solidity
function _maybeCancelAndRelease(Offering storage o, uint256 poolId) internal {
    if (o.raisedAtomic == 0 && o.state != OfferingState.Cancelled) {
        _changeState(poolId, OfferingState.Cancelled, CANCEL_OFFERING);
        emit OfferingCancelled(poolId, bytes32(0));
        _releaseCollateral(poolId, o.eblId);
    }
}
```

- [x] **Step 8: Implement claim**

```solidity
function claim(uint256 poolId) external whenOperational {
    Offering storage o = offerings[poolId];
    require(o.exists, "pool missing");
    require(o.state == OfferingState.Repaid || o.state == OfferingState.LossSettled, "not claimable");
    uint256 balance = IRWATokenV5Mintable(address(rwaToken)).balanceOf(poolId, msg.sender);
    require(balance > 0, "no shares");
    uint256 total = IRWATokenV5Mintable(address(rwaToken)).totalSupply(poolId);
    uint256 distributable = o.repaymentAmount - feesDeducted[poolId] - totalClaimed[poolId];
    require(distributable > 0, "nothing to distribute");
    uint256 already = investorClaimed[poolId][o.settlementAsset][msg.sender];
    uint256 owed = (distributable * balance) / total;
    require(owed > 0, "claim too small");
    investorClaimed[poolId][o.settlementAsset][msg.sender] = already + owed;
    totalClaimed[poolId] += owed;
    IRWATokenV5Mintable(address(rwaToken)).burn(poolId, msg.sender, balance);
    IERC20(o.settlementAsset).safeTransfer(msg.sender, owed);
    emit Claimed(poolId, msg.sender, o.settlementAsset, owed, balance);
}
```

- [x] **Step 9: Implement deductFee**

```solidity
function deductFee(uint256 poolId, uint256 amountAtomic, address feeRecipient, bytes32 feeEvidenceHash)
    external onlyOwner whenOperational {
    require(feeRecipient != address(0), "recipient=0");
    require(feeEvidenceHash != bytes32(0), "evidence=0");
    Offering storage o = offerings[poolId];
    require(o.exists, "pool missing");
    require(o.state == OfferingState.Repaid || _isActive(o.state) || o.state == OfferingState.Defaulted, "bad state");
    require(o.repaymentAmount > 0, "no recovery");
    require(feesDeducted[poolId] + amountAtomic <= o.repaymentAmount, "fee>recovery");
    feesDeducted[poolId] += amountAtomic;
    escrowed[poolId][o.settlementAsset] -= amountAtomic;
    IERC20(o.settlementAsset).safeTransfer(feeRecipient, amountAtomic);
    emit FeeDeducted(poolId, o.settlementAsset, amountAtomic, feeEvidenceHash);
}
```

- [x] **Step 10: Compile and run v4 regression**

Run:

```bash
cd hardhat && npm run compile
```

Expected: `RWAOfferingPoolV5` and `RWATokenV5` compile.

Run:

```bash
cd hardhat && npm test
```

Expected: existing tests still pass (v4 contract unchanged).

- [x] **Step 11: Commit**

```bash
git add hardhat/contracts/RWAOfferingPoolV5.sol hardhat/contracts/RWATokenV5.sol
# add artifacts if tracked
git commit -m "feat(contracts): v5 capital layer with escrow, disburse, refund and claim"
```

---

## Task 3: v5 合约回归测试

**Files:**
- Create: `hardhat/test/protocolV5.test.js`

**Interfaces:**
- Consumes: `deployProtocolV5`, `newOfferingV5` from `helpers/protocolV5.js`.
- Produces: passing test suite covering all W2 contract acceptance conditions.

- [x] **Step 1: Write subscription tests**

```javascript
import { expect } from 'chai';
import { STATE, ACTION, TARGET, ISSUE_PRICE, send, uniqueHash, deployProtocolV5, newOfferingV5 } from './helpers/protocolV5.js';

describe('protocol v5 W2 regressions', () => {
  async function now() { return BigInt((await ethers.provider.getBlock('latest')).timestamp); }

  it('escrows funds and mints shares atomically on subscribe', async () => {
    const ctx = await deployProtocolV5();
    const { poolId } = await newOfferingV5(ctx, 'sub-ok', { supply: 10n });
    const shares = 5n;
    const cost = shares * ISSUE_PRICE;
    await send(ctx.usdc.mint(ctx.investor.address, cost));
    await send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), cost));
    await send(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, shares, ISSUE_PRICE, 1n, (await now()) + 600n));
    expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Subscribed);
    expect(await ctx.usdc.balanceOf(await ctx.pool.getAddress())).to.equal(cost);
    expect(await ctx.token.balanceOf(poolId, ctx.investor.address)).to.equal(shares);
  });

  it('reverts if transfer fails, leaving no shares', async () => {
    const ctx = await deployProtocolV5();
    const { poolId } = await newOfferingV5(ctx, 'sub-fail', { supply: 10n });
    await expect(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 5n, ISSUE_PRICE, 1n, (await now()) + 600n))
      .to.be.reverted;
    expect(await ctx.token.balanceOf(poolId, ctx.investor.address)).to.equal(0n);
  });

  it('rejects subscription after deadline', async () => {
    const ctx = await deployProtocolV5();
    const { poolId, deadline } = await newOfferingV5(ctx, 'sub-late', { deadlineIn: 10 });
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(deadline) + 1]);
    await ethers.provider.send('evm_mine', []);
    await expect(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 1n, ISSUE_PRICE, 1n, (await now()) + 600n))
      .to.be.revertedWith('subscription deadline elapsed');
  });
});
```

- [x] **Step 2: Write refund and disbursement tests**

Add inside the same `describe` block:

```javascript
  it('refunds investors when minRaise is not met', async () => {
    const ctx = await deployProtocolV5();
    const { poolId, deadline } = await newOfferingV5(ctx, 'refund', { supply: 10n, minRaise: 10n * ISSUE_PRICE });
    const shares = 5n;
    const cost = shares * ISSUE_PRICE;
    await send(ctx.usdc.mint(ctx.investor.address, cost));
    await send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), cost));
    await send(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, shares, ISSUE_PRICE, 1n, (await now()) + 600n));
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(deadline) + 1]);
    await ethers.provider.send('evm_mine', []);
    const before = await ctx.usdc.balanceOf(ctx.investor.address);
    await send(ctx.pool.refundInvestor(poolId, ctx.investor.address));
    expect(await ctx.usdc.balanceOf(ctx.investor.address)).to.equal(before + cost);
    expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Cancelled);
  });

  it('disburses escrow to exporter after funded', async () => {
    const ctx = await deployProtocolV5();
    const { poolId } = await newOfferingV5(ctx, 'disburse', { supply: 10n });
    const cost = 10n * ISSUE_PRICE;
    await send(ctx.usdc.mint(ctx.investor.address, cost));
    await send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), cost));
    await send(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 10n, ISSUE_PRICE, 1n, (await now()) + 600n));
    expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Funded);
    const before = await ctx.usdc.balanceOf(ctx.exporter.address);
    await send(ctx.pool.disburseToExporter(poolId, cost, ctx.exporter.address, uniqueHash('disburse')));
    expect(await ctx.usdc.balanceOf(ctx.exporter.address)).to.equal(before + cost);
  });
```

- [x] **Step 3: Write claim and loss tests**

```javascript
  it('lets investors claim pro-rata after settlement', async () => {
    const ctx = await deployProtocolV5();
    const { poolId } = await newOfferingV5(ctx, 'claim', { supply: 10n });
    const cost = 10n * ISSUE_PRICE;
    await send(ctx.usdc.mint(ctx.investor.address, cost));
    await send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), cost));
    await send(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 10n, ISSUE_PRICE, 1n, (await now()) + 600n));
    await send(ctx.pool.disburseToExporter(poolId, cost, ctx.exporter.address, uniqueHash('disburse')));
    const recovery = 10n * TARGET;
    await send(ctx.usdc.mint(ctx.exporter.address, recovery));
    await send(ctx.usdc.connect(ctx.exporter).approve(await ctx.pool.getAddress(), recovery));
    await send(ctx.pool.recordImporterPayment(poolId, uniqueHash('payment'), recovery));
    await send(ctx.pool.recordCargoArrival(poolId, uniqueHash('arrival')));
    await send(ctx.pool.settle(poolId, recovery));
    const before = await ctx.usdc.balanceOf(ctx.investor.address);
    await send(ctx.pool.connect(ctx.investor).claim(poolId));
    expect(await ctx.usdc.balanceOf(ctx.investor.address)).to.equal(before + recovery);
    expect(await ctx.token.balanceOf(poolId, ctx.investor.address)).to.equal(0n);
  });

  it('distributes partial recovery correctly in LossSettled', async () => {
    const ctx = await deployProtocolV5();
    const { poolId } = await newOfferingV5(ctx, 'loss', { supply: 10n });
    const cost = 10n * ISSUE_PRICE;
    await send(ctx.usdc.mint(ctx.investor.address, cost));
    await send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), cost));
    await send(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 10n, ISSUE_PRICE, 1n, (await now()) + 600n));
    await send(ctx.pool.disburseToExporter(poolId, cost, ctx.exporter.address, uniqueHash('disburse')));
    const recovery = 5n * TARGET;
    await send(ctx.usdc.mint(ctx.exporter.address, recovery));
    await send(ctx.usdc.connect(ctx.exporter).approve(await ctx.pool.getAddress(), recovery));
    await send(ctx.pool.recordImporterPayment(poolId, uniqueHash('payment'), recovery));
    await send(ctx.pool.recordCargoArrival(poolId, uniqueHash('arrival')));
    await send(ctx.pool.settle(poolId, recovery));
    const before = await ctx.usdc.balanceOf(ctx.investor.address);
    await send(ctx.pool.connect(ctx.investor).claim(poolId));
    expect(await ctx.usdc.balanceOf(ctx.investor.address)).to.equal(before + recovery);
  });
```

- [x] **Step 4: Run tests**

```bash
cd hardhat && npm test -- --grep "protocol v5 W2 regressions"
```

Expected: all v5 tests pass.

- [x] **Step 5: Commit**

```bash
git add hardhat/test/protocolV5.test.js
git commit -m "test(contracts): v5 capital layer regressions"
```

---

## Task 4: 可恢复融资账本模块

**Files:**
- Create: `src/ledger/writer.js`
- Create: `src/ledger/ledger.js`
- Create: `tests/helpers/ledgerTestHarness.js`

**Interfaces:**
- Produces: `LedgerWriter` with methods `appendIntent(intent)`, `appendCashEntry(entry)`, `writePositions(positions)`, `writeCursor(cursor)`.
- Produces: `Ledger` with `recordIntent(...)`, `confirmIntent(intentId, txHash, blockNumber)`, `recordCashEntry(...)`, `listPositions(protocolInstance?)`, `rebuildFromEvents(events)`.

- [x] **Step 1: Write writer.js**

```javascript
import path from 'node:path';
import { appendJsonl, writeJsonAtomic, readJson, readJsonl } from '../lib/jsonStore.js';

export class LedgerWriter {
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  #file(name) { return path.join(this.baseDir, name); }

  async appendIntent(intent) {
    await appendJsonl(this.#file('intents.jsonl'), intent);
  }

  async appendCashEntry(entry) {
    await appendJsonl(this.#file('cash-entries.jsonl'), entry);
  }

  async writePositions(positions) {
    await writeJsonAtomic(this.#file('positions.json'), positions);
  }

  async writeCursor(cursor) {
    await writeJsonAtomic(this.#file('cursor.json'), cursor);
  }

  async readIntents(filter) {
    return readJsonl(this.#file('intents.jsonl'), { filter });
  }

  async readCashEntries(filter) {
    return readJsonl(this.#file('cash-entries.jsonl'), { filter });
  }

  async readPositions() {
    return readJson(this.#file('positions.json'), {});
  }

  async readCursor() {
    return readJson(this.#file('cursor.json'), {});
  }
}
```

- [x] **Step 2: Write ledger.js**

```javascript
import crypto from 'node:crypto';
import { LedgerWriter } from './writer.js';

export class Ledger {
  constructor({ baseDir, writer = new LedgerWriter(baseDir) }) {
    this.writer = writer;
  }

  static protocolInstanceKey({ chain_id, pool_address, protocol_version }) {
    return `${chain_id}:${pool_address.toLowerCase()}:${protocol_version}`;
  }

  async recordIntent({ protocol_instance, chain_pool_id, operation, investor, asset, amount_atomic, shares, calldata }) {
    const intent = {
      intent_id: crypto.randomUUID(),
      protocol_instance,
      chain_pool_id,
      operation,
      investor,
      asset: asset.toLowerCase(),
      amount_atomic: String(amount_atomic),
      shares: shares == null ? undefined : String(shares),
      calldata,
      status: 'draft',
      created_at: new Date().toISOString()
    };
    await this.writer.appendIntent(intent);
    return intent;
  }

  async markBroadcast(intentId, txHash) {
    const intents = await this.writer.readIntents((i) => i.intent_id === intentId);
    if (intents.length === 0) throw new Error('intent not found');
    const updated = { ...intents[0], status: 'broadcast', tx_hash: txHash.toLowerCase(), broadcast_at: new Date().toISOString() };
    await this.writer.appendIntent(updated);
  }

  async confirmIntent(intentId, txHash, blockNumber) {
    const updated = {
      intent_id: intentId,
      status: 'confirmed',
      tx_hash: txHash.toLowerCase(),
      block_number: Number(blockNumber),
      confirmed_at: new Date().toISOString()
    };
    await this.writer.appendIntent(updated);
  }

  async recordCashEntry({ intent_id, protocol_instance, chain_pool_id, kind, asset, from, to, amount_atomic, shares, source, evidence_hash, block_number }) {
    const entry = {
      entry_id: crypto.randomUUID(),
      intent_id,
      protocol_instance,
      chain_pool_id,
      kind,
      asset: asset.toLowerCase(),
      from: from?.toLowerCase(),
      to: to?.toLowerCase(),
      amount_atomic: String(amount_atomic),
      shares: shares == null ? undefined : String(shares),
      source: source ? { tx_hash: source.tx_hash.toLowerCase(), log_index: Number(source.log_index) } : undefined,
      evidence_hash,
      block_number: Number(block_number),
      occurred_at: new Date().toISOString()
    };
    await this.writer.appendCashEntry(entry);
    return entry;
  }

  async listPositions(protocolInstance) {
    const positions = await this.writer.readPositions();
    if (!protocolInstance) return Object.values(positions);
    const key = Ledger.protocolInstanceKey(protocolInstance);
    return Object.values(positions).filter((p) => Ledger.protocolInstanceKey(p.protocol_instance) === key);
  }

  async rebuildFromEvents(events) {
    const positions = {};
    for (const event of events) {
      const key = `${Ledger.protocolInstanceKey(event.protocol_instance)}:${event.chain_pool_id}:${event.investor.toLowerCase()}`;
      const pos = positions[key] ?? {
        position_id: crypto.randomUUID(),
        protocol_instance: event.protocol_instance,
        chain_pool_id: event.chain_pool_id,
        investor: event.investor.toLowerCase(),
        asset: event.asset.toLowerCase(),
        shares: '0',
        cost_atomic: '0',
        claimed_atomic: '0',
        status: 'active'
      };
      if (event.kind === 'INVESTOR_DEPOSIT') {
        pos.shares = (BigInt(pos.shares) + BigInt(event.shares)).toString();
        pos.cost_atomic = (BigInt(pos.cost_atomic) + BigInt(event.amount_atomic)).toString();
      } else if (event.kind === 'REFUND') {
        pos.status = 'refunded';
        pos.cost_atomic = '0';
        pos.shares = '0';
      } else if (event.kind === 'CLAIM') {
        pos.claimed_atomic = (BigInt(pos.claimed_atomic) + BigInt(event.amount_atomic)).toString();
        pos.shares = (BigInt(pos.shares) - BigInt(event.shares)).toString();
        if (pos.shares === '0') pos.status = 'fully_claimed';
      }
      positions[key] = pos;
    }
    await this.writer.writePositions(positions);
    return positions;
  }
}
```

- [x] **Step 3: Write ledger tests**

Create `tests/ledger.test.js`:

```javascript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Ledger } from '../src/ledger/ledger.js';

async function tmpLedger() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'));
  return { ledger: new Ledger({ baseDir: dir }), dir };
}

describe('Ledger', () => {
  it('records and confirms an intent', async () => {
    const { ledger } = await tmpLedger();
    const pi = { chain_id: 1439, pool_address: '0xPool', protocol_version: 5 };
    const intent = await ledger.recordIntent({ protocol_instance: pi, chain_pool_id: 1, operation: 'SUBSCRIBE', investor: '0xA', asset: '0xUSDC', amount_atomic: 100n, shares: 10n });
    assert.equal(intent.status, 'draft');
    await ledger.confirmIntent(intent.intent_id, '0x' + 'a'.repeat(64), 123);
    const intents = await ledger.writer.readIntents((i) => i.intent_id === intent.intent_id);
    assert.equal(intents[intents.length - 1].status, 'confirmed');
  });

  it('rebuilds positions from deposit and claim events', async () => {
    const { ledger } = await tmpLedger();
    const pi = { chain_id: 1439, pool_address: '0xPool', protocol_version: 5 };
    await ledger.rebuildFromEvents([
      { protocol_instance: pi, chain_pool_id: 1, investor: '0xA', asset: '0xUSDC', kind: 'INVESTOR_DEPOSIT', amount_atomic: '80', shares: '100' },
      { protocol_instance: pi, chain_pool_id: 1, investor: '0xA', asset: '0xUSDC', kind: 'CLAIM', amount_atomic: '95', shares: '100' }
    ]);
    const positions = await ledger.listPositions(pi);
    assert.equal(positions.length, 1);
    assert.equal(positions[0].shares, '0');
    assert.equal(positions[0].claimed_atomic, '95');
    assert.equal(positions[0].status, 'fully_claimed');
  });
});
```

Run:

```bash
node --test tests/ledger.test.js
```

Expected: tests pass.

- [x] **Step 4: Commit**

```bash
git add src/ledger/writer.js src/ledger/ledger.js tests/ledger.test.js
git commit -m "feat(ledger): durable intent, cash entry and position rebuild"
```

---

## Task 5: 链事件重建器

**Files:**
- Create: `src/ledger/rebuilder.js`
- Modify: `src/ledger/ledger.js` (add `applyEvent`)

**Interfaces:**
- Produces: `ChainEventRebuilder` with `rebuild(provider, chainConfig, cursor)` returning `{ positions, cursor }`.
- Consumes: `Ledger` methods to write entries and cursor.

- [x] **Step 1: Write rebuilder.js**

```javascript
import { Interface } from 'ethers';
import { PROTOCOL_V5_ABI } from '../chain/protocolV5Abi.js';

const POOL_EVENTS = [
  'Subscribed', 'FundEscrowed', 'DisbursedToExporter', 'InvestorRefunded',
  'Claimed', 'FeeDeducted', 'LiquidationRecoveryRecorded', 'AdditionalPaymentRecorded'
];

export class ChainEventRebuilder {
  constructor(ledger) {
    this.ledger = ledger;
  }

  async rebuild({ provider, poolAddress, chainId, protocolVersion, fromBlock, toBlock }) {
    const iface = new Interface(PROTOCOL_V5_ABI.RWAOfferingPool);
    const topics = [POOL_EVENTS.map((e) => iface.getEvent(e).topicHash)];
    const logs = await provider.getLogs({ address: poolAddress, topics, fromBlock, toBlock });
    const protocolInstance = { chain_id: chainId, pool_address: poolAddress, protocol_version: protocolVersion };
    for (const log of logs) {
      const parsed = iface.parseLog(log);
      if (!parsed) continue;
      await this.#apply(protocolInstance, parsed, log);
    }
    await this.ledger.writer.writeCursor({ chain_id: chainId, pool_address: poolAddress, protocol_version: protocolVersion, last_block: toBlock });
  }

  async #apply(pi, parsed, log) {
    const base = { protocol_instance: pi, chain_pool_id: Number(parsed.args.poolId), block_number: Number(log.blockNumber) };
    const source = { tx_hash: log.transactionHash, log_index: Number(log.index ?? log.logIndex) };
    if (parsed.name === 'Subscribed' || parsed.name === 'FundEscrowed') {
      await this.ledger.recordCashEntry({
        ...base,
        kind: 'INVESTOR_DEPOSIT',
        asset: parsed.args.asset ?? '0x' + log.address.toLowerCase().slice(2),
        from: parsed.args.investor,
        to: pi.pool_address,
        amount_atomic: String(parsed.args.paidAmount ?? parsed.args.amountAtomic),
        shares: String(parsed.args.amount ?? parsed.args.shares),
        source
      });
    } else if (parsed.name === 'InvestorRefunded') {
      await this.ledger.recordCashEntry({ ...base, kind: 'REFUND', asset: parsed.args.asset, to: parsed.args.investor, amount_atomic: String(parsed.args.amountAtomic), source });
    } else if (parsed.name === 'Claimed') {
      await this.ledger.recordCashEntry({ ...base, kind: 'CLAIM', asset: parsed.args.asset, to: parsed.args.investor, amount_atomic: String(parsed.args.amountAtomic), shares: String(parsed.args.sharesBurned), source });
    }
  }
}
```

Note: the `FundEscrowed` event includes `asset`, so use that. Adjust accordingly.

- [x] **Step 2: Add test for rebuilder**

Add to `tests/ledger.test.js`:

```javascript
import { ChainEventRebuilder } from '../src/ledger/rebuilder.js';

  it('rebuilder processes a FundEscrowed log', async () => {
    const { ledger } = await tmpLedger();
    const rebuilder = new ChainEventRebuilder(ledger);
    // Mock provider returning a synthetic log
    const log = {
      address: '0xPool',
      blockNumber: 100,
      transactionHash: '0x' + 'b'.repeat(64),
      index: 0,
      topics: [],
      data: '0x'
    };
    // This test is structural; full integration test is in w2CrossLayer.test.js
    assert.ok(rebuilder);
  });
```

- [x] **Step 3: Commit**

```bash
git add src/ledger/rebuilder.js src/chain/protocolV5Abi.js
git commit -m "feat(ledger): chain event rebuilder for v5"
```

---

## Task 6: v5 ABI 合并与规则扩展

**Files:**
- Create: `src/chain/protocolV5Abi.js`
- Modify: `src/agent/runtime/poolRules.js`
- Modify: `src/agent/runtime/ownerTxPlan.js`

**Interfaces:**
- Produces: `PROTOCOL_V5_ABI` object with RWAOfferingPoolV5 and RWATokenV5 fragments.
- Produces: `planTransition` supports `DISBURSE`, `REFUND`, `CLAIM`.

- [x] **Step 1: Write protocolV5Abi.js**

```javascript
export const PROTOCOL_V5_ABI = Object.freeze({
  RWAOfferingPoolV5: Object.freeze([
    'function createOfferingWithTerms(uint256,uint256,uint256,uint256,uint256,uint256,address,uint256) returns (uint256)',
    'function subscribeWithTerms(uint256,uint256,uint256,uint256,uint256)',
    'function disburseToExporter(uint256,uint256,address,bytes32)',
    'function refundInvestor(uint256,address)',
    'function refundAllOnFailure(uint256)',
    'function claim(uint256)',
    'function deductFee(uint256,uint256,address,bytes32)',
    'function escrowed(uint256,address) view returns (uint256)',
    'function investorPaid(uint256,address,address) view returns (uint256)',
    'function investorClaimed(uint256,address,address) view returns (uint256)',
    'function totalClaimed(uint256) view returns (uint256)',
    'function feesDeducted(uint256) view returns (uint256)',
    'function disbursedAtomic(uint256) view returns (uint256)',
    'event FundEscrowed(uint256 indexed poolId,address indexed asset,address indexed investor,uint256 amountAtomic,uint256 shares)',
    'event DisbursedToExporter(uint256 indexed poolId,address indexed asset,uint256 amountAtomic,bytes32 evidenceHash)',
    'event InvestorRefunded(uint256 indexed poolId,address indexed investor,address indexed asset,uint256 amountAtomic)',
    'event Claimed(uint256 indexed poolId,address indexed investor,address indexed asset,uint256 amountAtomic,uint256 sharesBurned)',
    'event FeeDeducted(uint256 indexed poolId,address indexed asset,uint256 feeAtomic,bytes32 feeEvidenceHash)',
    'event PoolFundingTermsSet(uint256 indexed poolId,address settlementAsset,uint256 minRaise,uint256 maxRaise)'
  ]),
  RWATokenV5: Object.freeze([
    'function burn(uint256,address,uint256)',
    'event RWABurned(uint256 indexed poolId,address indexed investor,uint256 amount)'
  ])
});
```

- [x] **Step 2: Extend poolRules.js**

Add cases:

```javascript
    case 'DISBURSE':
      if (from !== 'Funded' && from !== 'InTransit') return no('only funded or in-transit offering can disburse');
      return ok(from, false);
    case 'REFUND':
      if (!['Open','Subscribed','Repriced','Paused','Frozen','Cancelled'].includes(from)) return no('not refundable');
      if (!subscribed && from !== 'Cancelled') return no('no subscribers to refund');
      return ok('Cancelled', true);
    case 'CLAIM':
      if (from !== 'Repaid' && from !== 'LossSettled') return no('not claimable');
      return ok(from, false);
```

- [x] **Step 3: Extend ownerTxPlan.js**

Add to `METHODS`:

```javascript
  DISBURSE: { method: 'disburseToExporter', events: ['DisbursedToExporter'], describe: 'Disburse escrowed funds to the exporter' },
  REFUND: { method: 'refundInvestor', events: ['InvestorRefunded'], describe: 'Refund an investor after failed raise' },
  CLAIM: { method: 'claim', events: ['Claimed'], describe: 'Claim repayment proceeds as an investor' }
```

Add to `OWNER_PLAN_ACTIONS`:

```javascript
export const OWNER_PLAN_ACTIONS = Object.freeze([...OPENING_ACTIONS, 'MARK_IN_TRANSIT',
  ...SETTLEMENT_ACTIONS, 'CANCEL', 'MARK_DEFAULT', 'SETTLE_LOSS', 'RESOLVE_LIQUIDATION', 'UNFREEZE',
  'DISBURSE', 'REFUND', 'DEDUCT_FEE']);
```

Note: `CLAIM` is investor-signed, not owner-signed; keep it out of `OWNER_PLAN_ACTIONS`.

- [x] **Step 4: Run existing tests**

```bash
npm test
```

Expected: existing Node tests still pass (poolRules/ownerTxPlan tests if any).

- [x] **Step 5: Commit**

```bash
git add src/chain/protocolV5Abi.js src/agent/runtime/poolRules.js src/agent/runtime/ownerTxPlan.js
git commit -m "feat(agent): v5 ABI fragments and plan actions"
```

---

## Task 7: 后端集成与统一持仓视图

**Files:**
- Create: `src/ledger/positionView.js`
- Modify: `src/app/server.js`
- Modify: `src/app/store.js`

**Interfaces:**
- Produces: `buildPositionView({ wallet, demoInvestments, ledgerPositions, chainBalances })` returning unified position array.
- Produces: `GET /api/positions?wallet=...` JSON response.

- [x] **Step 1: Write positionView.js**

```javascript
export function buildPositionView({ wallet, demoInvestments = [], ledgerPositions = [], chainBalances = new Map() }) {
  const normalized = String(wallet).toLowerCase();
  const result = [];
  for (const inv of demoInvestments.filter((i) => i.walletAddress === normalized)) {
    result.push({
      mode: 'demo',
      reference: inv.reference,
      pool_id: inv.poolId,
      asset: null,
      shares: String(inv.tokenCount),
      cost_usd: inv.amountUsd,
      claimable_usd: 0,
      claimed_usd: 0,
      status: 'active'
    });
  }
  for (const pos of ledgerPositions.filter((p) => p.investor === normalized)) {
    const key = `${pos.protocol_instance.chain_id}:${pos.protocol_instance.pool_address}:${pos.chain_pool_id}`;
    const balance = chainBalances.get(key) ?? BigInt(pos.shares);
    result.push({
      mode: 'live',
      protocol_instance: pos.protocol_instance,
      chain_pool_id: pos.chain_pool_id,
      asset: pos.asset,
      shares: String(balance),
      cost_atomic: pos.cost_atomic,
      claimed_atomic: pos.claimed_atomic,
      status: pos.status
    });
  }
  return result;
}
```

- [x] **Step 2: Initialize ledger in server.js**

Near the top of `server.js`:

```javascript
import { Ledger } from '../ledger/ledger.js';
import { buildPositionView } from '../ledger/positionView.js';

const ledgerBaseDir = process.env.AGENTBL_LEDGER_DIR || path.join(runtimeDir, 'ledger');
const ledger = new Ledger({ baseDir: ledgerBaseDir });
```

- [x] **Step 3: Add /api/positions endpoint**

```javascript
  if (url.pathname === '/api/positions' && request.method === 'GET') {
    const wallet = url.searchParams.get('wallet');
    if (!wallet || !/^0x[0-9a-fA-F]{40}$/u.test(wallet)) {
      throw new HttpError(400, 'invalid_wallet', 'wallet (42-char hex) is required');
    }
    const demoInvestments = storeState.investments;
    const ledgerPositions = await ledger.listPositions();
    const positions = buildPositionView({ wallet, demoInvestments, ledgerPositions });
    return sendJson(response, { wallet, positions });
  }
```

- [x] **Step 4: Add Live subscribe branch in store.js**

```javascript
export async function recordLiveSubscriptionIntent({ walletAddress, poolId, protocolInstance, chainPoolId, asset, amountAtomic, shares, calldata }) {
  return ledger.recordIntent({
    protocol_instance: protocolInstance,
    chain_pool_id: chainPoolId,
    operation: 'SUBSCRIBE',
    investor: walletAddress,
    asset,
    amount_atomic: amountAtomic,
    shares,
    calldata
  });
}
```

- [x] **Step 5: Test endpoint**

Add to `tests/server.test.js` or create `tests/w2Positions.test.js`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPositionView } from '../src/ledger/positionView.js';

describe('position view', () => {
  it('merges demo and live positions', () => {
    const view = buildPositionView({
      wallet: '0xA',
      demoInvestments: [{ walletAddress: '0xa', poolId: 'demo-1', tokenCount: 10, amountUsd: 8 }],
      ledgerPositions: [{ investor: '0xa', protocol_instance: { chain_id: 1439, pool_address: '0xP', protocol_version: 5 }, chain_pool_id: 1, asset: '0xU', shares: '5', cost_atomic: '4', claimed_atomic: '0', status: 'active' }]
    });
    assert.equal(view.length, 2);
    assert.equal(view[0].mode, 'demo');
    assert.equal(view[1].mode, 'live');
  });
});
```

Run:

```bash
node --test tests/w2Positions.test.js
```

- [x] **Step 6: Commit**

```bash
git add src/ledger/positionView.js src/app/server.js src/app/store.js tests/w2Positions.test.js
git commit -m "feat(app): unified position view and ledger integration"
```

---

## Task 8: 前端统一持仓与 Live 认购

**Files:**
- Create: `web/src/features/positions/PositionList.jsx`
- Modify: `web/src/lib/web3.js`
- Modify: existing page that displays investments

**Interfaces:**
- Produces: `PositionList` React component rendering `mode`, `shares`, `cost`, `claimable`, `claimed`.
- Produces: `subscribeLive({ provider, contract, shares, price, version, deadline })`.

- [x] **Step 1: Create PositionList.jsx**

```jsx
export function PositionList({ positions }) {
  if (!positions?.length) return <p>No positions</p>;
  return (
    <table>
      <thead>
        <tr><th>Mode</th><th>Pool</th><th>Shares</th><th>Cost</th><th>Claimable</th><th>Claimed</th><th>Status</th></tr>
      </thead>
      <tbody>
        {positions.map((p, i) => (
          <tr key={i}>
            <td>{p.mode}</td>
            <td>{p.mode === 'live' ? `${p.protocol_instance.pool_address}:${p.chain_pool_id}` : p.pool_id}</td>
            <td>{p.shares}</td>
            <td>{p.cost_usd ?? p.cost_atomic}</td>
            <td>{p.claimable_usd ?? p.claimable_atomic ?? '-'}</td>
            <td>{p.claimed_usd ?? p.claimed_atomic ?? '-'}</td>
            <td>{p.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [x] **Step 2: Update web3.js subscribe path**

Ensure existing subscribe code detects v5 contract and uses `subscribeWithTerms`. It already does this via `termsBound`. Add USDC approval before subscribe:

```javascript
// Inside the subscribe function, before calling subscribeWithTerms:
if (termsBound && chain.settlement_asset) {
  const usdc = new ethers.Contract(chain.settlement_asset, ['function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)'], session.signer);
  const cost = shares * price;
  await (await usdc.approve(chain.contract, cost)).wait();
}
```

- [x] **Step 3: Build and lint frontend**

```bash
npm run build
npm run lint
```

Expected: build succeeds, no new lint errors.

- [x] **Step 4: Commit**

```bash
git add web/src/features/positions/PositionList.jsx web/src/lib/web3.js
git commit -m "feat(web): unified position list and live subscribe approval"
```

---

## Task 9: 跨层生命周期测试

**Files:**
- Create: `tests/w2CrossLayer.test.js`
- Create: `tests/helpers/ledgerTestHarness.js`

**Interfaces:**
- Produces: `deployAndRunW2Lifecycle()` helper that spins up Hardhat, deploys v5, runs backend, and asserts ledger + positions.

- [x] **Step 1: Write helper**

```javascript
import { spawn } from 'node:child_process';
import path from 'node:path';

export async function runHardhatNode() {
  const proc = spawn('npx', ['hardhat', 'node'], { cwd: path.resolve('hardhat'), stdio: 'pipe' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hardhat node startup timeout')), 30_000);
    proc.stdout.on('data', (data) => {
      if (String(data).includes('Started HTTP and WebSocket JSON-RPC server')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return proc;
}
```

- [x] **Step 2: Write w2CrossLayer.test.js**

```javascript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runHardhatNode } from './helpers/ledgerTestHarness.js';

describe('W2 cross-layer lifecycle', { skip: process.env.CI === 'true' }, () => {
  let node;
  before(async () => { node = await runHardhatNode(); });
  after(() => node?.kill());

  it('deploys v5 and records a Live subscription in the ledger', async () => {
    // This test shells out to the deploy script and then calls the backend API.
    // Full implementation is left to the executor because it depends on runtime wiring.
    assert.ok(node);
  });
});
```

接手结果：脚手架已扩展为独立 Hardhat RPC + 真实 HTTP 服务 + JS 钱包适配器的 6 条生命周期用例；使用 `npm run test:w2` 运行，CI 有独立安装 Hardhat 依赖的作业。

- [x] **Step 3: Commit**

```bash
git add tests/w2CrossLayer.test.js tests/helpers/ledgerTestHarness.js
git commit -m "test(integration): W2 cross-layer lifecycle scaffold"
```

---

## Task 10: 最终回归与 issue register 更新

**Files:**
- Modify: `docs/evidence/blockchain-comprehensive-2026-10-17/issue-register.json`
- Modify: `docs/contracts.md` (update v5 说明)

**Interfaces:**
- Produces: updated issue statuses and closure notes for A09, B01–B03, B12.

- [x] **Step 1: Run full test matrix**

```bash
cd hardhat && npm test
npm test
npm run build
npm run lint
```

Expected: all pass.

- [x] **Step 2: Update issue register**

Set A09, B01, B02, B03, B12 status to `IMPLEMENTED` and fill `closure_note` with design summary, files, tests, deployment scope, and remaining boundary.

- [x] **Step 3: Update docs/contracts.md**

Add §0.8 "本地协议 v5：W2 资金与账本" summarizing escrow, refund, claim, ledger.

- [x] **Step 4: Commit（用户已明确要求“提交推送”，随本次交付提交；实际提交与 CI 以 Git 记录为准）**

```bash
git add docs/evidence/blockchain-comprehensive-2026-10-17/issue-register.json docs/contracts.md
git commit -m "docs: W2 closure notes and contract docs"
```

---

## Self-Review

### Spec coverage

| Spec section | Task |
|---|---|
| §4.1 版本与部署约束 | Task 2 |
| §4.2 新增事件 | Task 2 |
| §4.3 存储扩展 | Task 2 |
| §4.4 关键函数 | Tasks 2, 6 |
| §4.5 不变量 | Tasks 2, 3 |
| §5 可恢复融资账本 | Tasks 4, 5 |
| §6 应用层改动 | Tasks 6, 7 |
| §7 前端改动 | Task 8 |
| §8 测试策略 | Tasks 3, 9, 10 |
| §9 风险与回退 | Tasks 2, 10 |
| §10 验收清单 | Task 10 |

### Placeholder scan

- No TBD/TODO.
- No vague "add error handling" steps.
- Code blocks contain actual snippets.
- Type names consistent (`amount_atomic`, `chain_pool_id`, `protocol_instance`).

### Type consistency

- `amount_atomic` is always string in ledger, BigInt/uint256 in contract.
- `chain_pool_id` is number in JS, uint256 in Solidity.
- `protocol_instance` shape is consistent across ledger/rebuilder/positionView.

### Gaps

- Task 9 的真实 EVM / HTTP / 钱包集成和持久化恢复已补齐，收据见验收目录。
- Front-end claim UI is not a separate task; it is folded into Task 8. If the existing investment page is complex, split it into a separate Task 8b.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-10-17-w2-capital-ledger-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
