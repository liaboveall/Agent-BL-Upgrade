// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Owned} from "./Owned.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IEBLRegistry {
    function holderOf(uint256 eblId) external view returns (address);
    function pledgedTo(uint256 eblId) external view returns (address);
    function releasePledge(uint256 eblId) external;
}

interface IRWATokenV5Mintable {
    function mint(uint256 poolId, address investor, uint256 amount) external;
    function burn(uint256 poolId, address investor, uint256 amount) external;
    function balanceOf(uint256 poolId, address investor) external view returns (uint256);
    function totalSupply(uint256 poolId) external view returns (uint256);
}

interface IInvestorComplianceGate {
    function isEligible(address investor, uint256 poolId) external view returns (bool);
}

/// @title RWAOfferingPoolV5
/// @notice v5 capital-layer extension of the v4 offering state machine. It escrows
///         investor settlement assets, disburses to the exporter, supports refunds on
///         failed raises, and lets investors claim pro-rata repayments.
/// @dev    Built on top of the v4 state machine; the v4 contract remains unchanged.
contract RWAOfferingPoolV5 is Owned {
    using SafeERC20 for IERC20;

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
        Cancelled,
        Defaulted,
        LossSettled
    }

    enum AccessMode {
        Permissionless,
        ComplianceGated
    }

    uint8 public constant OPEN_OFFERING = 0;
    uint8 public constant OPEN_WITH_WARNING = 1;
    uint8 public constant REPRICE_DOWN = 2;
    uint8 public constant PAUSE_OFFERING = 3;
    uint8 public constant FREEZE_POOL = 4;
    uint8 public constant TRIGGER_LIQUIDATION = 5;
    uint8 public constant RESUME_OFFERING = 6;
    uint8 public constant SETTLE_OFFERING = 7;
    uint8 public constant EMERGENCY_PAUSE = 8;
    uint8 public constant CANCEL_OFFERING = 9;

    address public oracle;
    IEBLRegistry public eblRegistry;
    IRWATokenV5Mintable public rwaToken;
    IInvestorComplianceGate public complianceGate;
    AccessMode public accessMode = AccessMode.Permissionless;
    bool public emergencyStopped;
    uint256 public nextPoolId = 1;
    uint256 public constant protocolVersion = 5;
    mapping(uint256 => uint256) public quoteVersion;
    mapping(uint256 => uint256) public maturityAt;
    mapping(uint256 => uint256) public subscriptionDeadline;
    mapping(uint256 => uint256) public realizedLoss;
    mapping(bytes32 => bool) public usedPaymentProof;
    mapping(uint256 => OfferingState) private _stateBeforeFreeze;

    struct Offering {
        uint256 eblId;
        uint256 tokenSupply;
        uint256 issuePrice;
        uint256 targetRedemptionValue;
        uint256 subscribed;
        uint256 repaymentAmount;
        bytes32 paymentProof;
        bytes32 arrivalProof;
        address settlementAsset;
        uint256 minRaise;
        uint256 raisedAtomic;
        OfferingState state;
        bool exists;
    }

    mapping(uint256 => Offering) public offerings;
    mapping(uint256 => OfferingState) private _stateBeforePause;
    mapping(address => bool) public agentExecutor;
    mapping(uint256 => uint256) public poolOfEbl;

    // Capital-layer accounting (pool => asset => balance).
    mapping(uint256 => mapping(address => uint256)) public escrowed;
    // pool => asset => investor => cost basis.
    mapping(uint256 => mapping(address => mapping(address => uint256))) public investorPaid;
    // pool => asset => investor => claimed amount.
    mapping(uint256 => mapping(address => mapping(address => uint256))) public investorClaimed;
    mapping(uint256 => uint256) public totalClaimed;
    mapping(uint256 => uint256) public feesDeducted;
    mapping(uint256 => uint256) public disbursedAtomic;

    // Track pool investors so refundAllOnFailure can refund every subscriber.
    mapping(uint256 => address[]) private _investors;
    mapping(uint256 => mapping(address => bool)) private _isInvestor;

    /// @dev Maximum number of investors processed in a single `refundAllOnFailure`
    ///      batch. If a failed pool has more investors, the owner must continue from
    ///      the next offset or refund the remaining investors individually via
    ///      `refundInvestor`.
    uint256 public constant MAX_REFUND_BATCH = 100;

    event OfferingCreated(
        uint256 indexed poolId,
        uint256 indexed eblId,
        uint256 tokenSupply,
        uint256 issuePrice,
        uint256 targetRedemptionValue
    );
    event Subscribed(uint256 indexed poolId, address indexed investor, uint256 amount, uint256 paidAmount);
    event OfferingRepriced(
        uint256 indexed poolId,
        uint256 oldIssuePrice,
        uint256 newIssuePrice,
        bytes32 evidenceHash,
        bytes32 quoteHash
    );
    event OfferingPaused(uint256 indexed poolId, bytes32 evidenceHash);
    event OfferingResumed(uint256 indexed poolId, OfferingState restoredState, bytes32 evidenceHash);
    event OfferingStateChanged(uint256 indexed poolId, OfferingState oldState, OfferingState newState, uint8 action);
    event DepartureRecorded(uint256 indexed poolId, bytes32 departureProof);
    event SettlementProofRecorded(uint256 indexed poolId, bytes32 paymentProof, bytes32 arrivalProof);
    event ImporterPaymentCorrected(
        uint256 indexed poolId,
        bytes32 oldPaymentProof,
        bytes32 newPaymentProof,
        uint256 oldRepaymentAmount,
        uint256 newRepaymentAmount
    );
    event OfferingSettled(uint256 indexed poolId, uint256 repaymentAmount, bytes32 paymentProof, bytes32 arrivalProof);
    event OfferingCancelled(uint256 indexed poolId, bytes32 reasonHash);
    event CollateralReleased(uint256 indexed poolId, uint256 indexed eblId);
    event CollateralReleaseFailed(uint256 indexed poolId, uint256 indexed eblId);
    event OracleSet(address indexed oracle);
    event AgentExecutorSet(address indexed executor, bool allowed);
    event EmergencyStopSet(bool stopped, address indexed operator, bytes32 reasonHash);
    event AccessModeSet(AccessMode mode);
    event ComplianceGateSet(address indexed gate);
    event OfferingDefaulted(uint256 indexed poolId, uint256 outstandingAmount);
    event LossSettlementRecorded(uint256 indexed poolId, uint256 recoveredAmount, uint256 lossAmount, bytes32 resolutionHash);
    event AdditionalPaymentRecorded(uint256 indexed poolId, bytes32 paymentProof, uint256 amount, uint256 totalRecovered);
    event OfferingTermsSet(uint256 indexed poolId, uint256 maturityAt, uint256 subscriptionDeadline);
    event SubscriptionDeadlineSet(uint256 indexed poolId, uint256 subscriptionDeadline);
    event OfferingFrozen(uint256 indexed poolId, bytes32 evidenceHash);
    event OfferingUnfrozen(uint256 indexed poolId, OfferingState restoredState, bytes32 evidenceHash);
    event LiquidationRecoveryRecorded(uint256 indexed poolId, bytes32 paymentProof, uint256 amount, uint256 totalRecovered);
    event LiquidationResolved(
        uint256 indexed poolId,
        OfferingState outcome,
        uint256 recoveredAmount,
        uint256 lossAmount,
        bytes32 resolutionHash
    );

    // v5 capital-layer events.
    event PoolFundingTermsSet(
        uint256 indexed poolId,
        address settlementAsset,
        uint256 minRaise,
        uint256 maxRaise
    );
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

    modifier onlyExecutor() {
        require(msg.sender == owner || agentExecutor[msg.sender], "not executor");
        _;
    }

    modifier whenOperational() {
        require(!emergencyStopped, "emergency stopped");
        _;
    }

    constructor(address eblRegistry_, address rwaToken_) {
        require(eblRegistry_ != address(0) && rwaToken_ != address(0), "dependency=0");
        require(eblRegistry_.code.length > 0 && rwaToken_.code.length > 0, "dependency not a contract");
        eblRegistry = IEBLRegistry(eblRegistry_);
        rwaToken = IRWATokenV5Mintable(rwaToken_);
    }

    function setOracle(address oracle_) external onlyOwner {
        require(oracle_ != address(0), "oracle=0");
        oracle = oracle_;
        emit OracleSet(oracle_);
    }

    function setAgentExecutor(address executor, bool allowed) external onlyOwner {
        require(executor != address(0), "executor=0");
        agentExecutor[executor] = allowed;
        emit AgentExecutorSet(executor, allowed);
    }

    function setEmergencyStop(bool stopped, bytes32 reasonHash) external onlyOwner {
        require(emergencyStopped != stopped, "unchanged");
        emergencyStopped = stopped;
        emit EmergencyStopSet(stopped, msg.sender, reasonHash);
    }

    function emergencyPause(uint256 poolId, bytes32 reasonHash) external onlyOwner {
        _pause(poolId, reasonHash, EMERGENCY_PAUSE);
    }

    function setComplianceGate(address gate) external onlyOwner {
        require(gate != address(0) && gate.code.length > 0, "invalid gate");
        complianceGate = IInvestorComplianceGate(gate);
        emit ComplianceGateSet(gate);
    }

    function setAccessMode(AccessMode mode) external onlyOwner {
        if (mode == AccessMode.ComplianceGated) require(address(complianceGate) != address(0), "gate missing");
        accessMode = mode;
        emit AccessModeSet(mode);
    }

    function isInvestorEligible(address investor, uint256 poolId) public view returns (bool) {
        if (accessMode == AccessMode.Permissionless) return investor != address(0);
        return address(complianceGate) != address(0) && complianceGate.isEligible(investor, poolId);
    }

    /// @notice Legacy creation entry point. Kept for API compatibility; it does not bind
    ///         funding terms, so subscriptions on legacy offerings will revert.
    function createOffering(
        uint256 eblId,
        uint256 tokenSupply,
        uint256 issuePrice,
        uint256 targetRedemptionValue
    ) external onlyOwner whenOperational returns (uint256 poolId) {
        uint256 maturity = block.timestamp + 60 days;
        return _createOffering(eblId, tokenSupply, issuePrice, targetRedemptionValue, maturity, maturity);
    }

    /// @notice Create an offering with the approved maturity, subscription deadline and
    ///         funding terms (settlement asset + minimum raise) in one transaction.
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

    function _createOffering(
        uint256 eblId,
        uint256 tokenSupply,
        uint256 issuePrice,
        uint256 targetRedemptionValue,
        uint256 maturity,
        uint256 subscribeUntil
    ) internal returns (uint256 poolId) {
        require(issuePrice > 0, "issuePrice=0");
        require(tokenSupply > 0, "supply=0");
        require(targetRedemptionValue >= issuePrice, "redemption<price");
        require(eblRegistry.holderOf(eblId) != address(0), "ebl missing");
        require(eblRegistry.pledgedTo(eblId) == address(this), "ebl not pledged to pool");
        require(poolOfEbl[eblId] == 0, "ebl already offered");

        poolId = nextPoolId++;
        poolOfEbl[eblId] = poolId;
        offerings[poolId] = Offering({
            eblId: eblId,
            tokenSupply: tokenSupply,
            issuePrice: issuePrice,
            targetRedemptionValue: targetRedemptionValue,
            subscribed: 0,
            repaymentAmount: 0,
            paymentProof: bytes32(0),
            arrivalProof: bytes32(0),
            settlementAsset: address(0),
            minRaise: 0,
            raisedAtomic: 0,
            state: OfferingState.Open,
            exists: true
        });
        quoteVersion[poolId] = 1;
        maturityAt[poolId] = maturity;
        subscriptionDeadline[poolId] = subscribeUntil;

        emit OfferingCreated(poolId, eblId, tokenSupply, issuePrice, targetRedemptionValue);
        emit OfferingTermsSet(poolId, maturity, subscribeUntil);
        emit OfferingStateChanged(poolId, OfferingState.Created, OfferingState.Open, OPEN_OFFERING);
    }

    function subscribe(uint256 poolId, uint256 amount) external whenOperational {
        _subscribe(poolId, amount);
    }

    function subscribeWithTerms(
        uint256 poolId,
        uint256 amount,
        uint256 maxUnitPrice,
        uint256 expectedQuoteVersion,
        uint256 deadline
    ) external whenOperational {
        Offering storage o = offerings[poolId];
        require(o.exists, "pool missing");
        require(maxUnitPrice > 0, "maxUnitPrice=0");
        require(o.issuePrice <= maxUnitPrice, "price above user limit");
        require(quoteVersion[poolId] == expectedQuoteVersion, "quote version changed");
        require(block.timestamp <= deadline, "user deadline elapsed");
        _subscribe(poolId, amount);
    }

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

        if (!_isInvestor[poolId][msg.sender]) {
            _isInvestor[poolId][msg.sender] = true;
            _investors[poolId].push(msg.sender);
        }

        rwaToken.mint(poolId, msg.sender, amount);
        emit Subscribed(poolId, msg.sender, amount, cost);
        emit FundEscrowed(poolId, o.settlementAsset, msg.sender, cost, amount);

        OfferingState next = o.subscribed == o.tokenSupply ? OfferingState.Funded : OfferingState.Subscribed;
        if (o.state != next) _changeState(poolId, next, OPEN_OFFERING);
    }

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
        uint256 shares = rwaToken.balanceOf(poolId, investor);
        if (shares > 0) {
            rwaToken.burn(poolId, investor, shares);
        }
        IERC20(o.settlementAsset).safeTransfer(investor, paid);
        emit InvestorRefunded(poolId, investor, o.settlementAsset, paid);
        _maybeCancelAndRelease(o, poolId);
    }

    /// @notice Refund up to `MAX_REFUND_BATCH` investors in a failed or cancelled pool.
    /// @dev    Because the investor list is unbounded, this call is gas-capped. If a
    ///         pool has more than `MAX_REFUND_BATCH` investors, call
    ///         `refundAllOnFailure(poolId, start, limit)` with `limit <= MAX_REFUND_BATCH`
    ///         or refund the remaining investors individually with `refundInvestor`.
    function refundAllOnFailure(uint256 poolId) external onlyOwner whenOperational {
        _refundAllOnFailure(poolId, 0, MAX_REFUND_BATCH);
    }

    /// @notice Refund a bounded slice of investors in a failed or cancelled pool.
    /// @param  start Index into the pool's investor list to begin processing.
    /// @param  limit Maximum number of investors to process in this call; capped at
    ///         `MAX_REFUND_BATCH` to preserve liveness.
    function refundAllOnFailure(uint256 poolId, uint256 start, uint256 limit) external onlyOwner whenOperational {
        require(limit <= MAX_REFUND_BATCH, "limit>max");
        _refundAllOnFailure(poolId, start, limit);
    }

    function _refundAllOnFailure(uint256 poolId, uint256 start, uint256 limit) internal {
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

        address asset = o.settlementAsset;
        address[] storage invs = _investors[poolId];
        uint256 end = start + limit;
        if (end > invs.length) end = invs.length;
        for (uint256 i = start; i < end; i++) {
            address investor = invs[i];
            uint256 paid = investorPaid[poolId][asset][investor];
            if (paid > 0) {
                investorPaid[poolId][asset][investor] = 0;
                o.raisedAtomic -= paid;
                escrowed[poolId][asset] -= paid;
                uint256 shares = rwaToken.balanceOf(poolId, investor);
                if (shares > 0) {
                    rwaToken.burn(poolId, investor, shares);
                }
                IERC20(asset).safeTransfer(investor, paid);
                emit InvestorRefunded(poolId, investor, asset, paid);
            }
        }
        _maybeCancelAndRelease(o, poolId);
    }

    function claim(uint256 poolId) external whenOperational {
        Offering storage o = offerings[poolId];
        require(o.exists, "pool missing");
        require(o.state == OfferingState.Repaid || o.state == OfferingState.LossSettled, "not claimable");
        uint256 balance = rwaToken.balanceOf(poolId, msg.sender);
        require(balance > 0, "no shares");
        uint256 total = rwaToken.totalSupply(poolId);
        uint256 distributable = o.repaymentAmount - feesDeducted[poolId] - totalClaimed[poolId];
        require(distributable > 0, "nothing to distribute");
        uint256 already = investorClaimed[poolId][o.settlementAsset][msg.sender];
        uint256 owed = (distributable * balance) / total;
        require(owed > 0, "claim too small");
        investorClaimed[poolId][o.settlementAsset][msg.sender] = already + owed;
        totalClaimed[poolId] += owed;
        escrowed[poolId][o.settlementAsset] -= owed;
        rwaToken.burn(poolId, msg.sender, balance);
        IERC20(o.settlementAsset).safeTransfer(msg.sender, owed);
        emit Claimed(poolId, msg.sender, o.settlementAsset, owed, balance);
    }

    function deductFee(uint256 poolId, uint256 amountAtomic, address feeRecipient, bytes32 feeEvidenceHash)
        external onlyOwner whenOperational {
        require(feeRecipient != address(0), "recipient=0");
        require(feeEvidenceHash != bytes32(0), "evidence=0");
        Offering storage o = offerings[poolId];
        require(o.exists, "pool missing");
        require(o.state == OfferingState.Repaid || _isActive(o.state) || o.state == OfferingState.Defaulted, "bad state");
        require(o.repaymentAmount > 0, "no recovery");
        require(feesDeducted[poolId] + amountAtomic <= o.repaymentAmount, "fee>recovery");
        require(feesDeducted[poolId] + amountAtomic <= escrowed[poolId][o.settlementAsset], "fee>escrow");
        feesDeducted[poolId] += amountAtomic;
        escrowed[poolId][o.settlementAsset] -= amountAtomic;
        IERC20(o.settlementAsset).safeTransfer(feeRecipient, amountAtomic);
        emit FeeDeducted(poolId, o.settlementAsset, amountAtomic, feeEvidenceHash);
    }

    function _maybeCancelAndRelease(Offering storage o, uint256 poolId) internal {
        if (o.raisedAtomic == 0 && o.state != OfferingState.Cancelled) {
            _changeState(poolId, OfferingState.Cancelled, CANCEL_OFFERING);
            emit OfferingCancelled(poolId, bytes32(0));
            _releaseCollateral(poolId, o.eblId);
        }
    }

    function markInTransit(uint256 poolId, bytes32 departureProof) external onlyExecutor whenOperational {
        require(departureProof != bytes32(0), "departureProof=0");
        Offering storage o = offerings[poolId];
        require(o.state == OfferingState.Funded || o.state == OfferingState.Subscribed, "not funded");
        _changeState(poolId, OfferingState.InTransit, OPEN_OFFERING);
        emit DepartureRecorded(poolId, departureProof);
    }

    function pauseOffering(uint256 poolId, bytes32 evidenceHash) external whenOperational {
        require(msg.sender == owner || msg.sender == oracle || agentExecutor[msg.sender], "not authorized");
        _pause(poolId, evidenceHash, PAUSE_OFFERING);
    }

    function resumeOffering(uint256 poolId, bytes32 evidenceHash) external onlyExecutor whenOperational {
        _resume(poolId, evidenceHash);
    }

    function cancelOffering(uint256 poolId, bytes32 reasonHash) external onlyOwner {
        Offering storage o = offerings[poolId];
        require(o.exists, "pool missing");
        require(o.subscribed == 0, "has subscribers");
        require(
            o.state == OfferingState.Open || o.state == OfferingState.Repriced || o.state == OfferingState.Paused
                || o.state == OfferingState.Frozen || o.state == OfferingState.Liquidation,
            "illegal transition"
        );
        _changeState(poolId, OfferingState.Cancelled, CANCEL_OFFERING);
        emit OfferingCancelled(poolId, reasonHash);
        _releaseCollateral(poolId, o.eblId);
    }

    function recordImporterPayment(
        uint256 poolId,
        bytes32 paymentProof,
        uint256 repaymentAmount
    ) external onlyExecutor whenOperational {
        Offering storage o = offerings[poolId];
        _requireSettleable(o);
        require(paymentProof != bytes32(0), "paymentProof=0");
        require(repaymentAmount > 0, "repayment=0");
        require(o.paymentProof == bytes32(0), "payment already recorded");
        require(!usedPaymentProof[paymentProof], "payment proof reused");
        usedPaymentProof[paymentProof] = true;
        o.paymentProof = paymentProof;
        o.repaymentAmount = repaymentAmount;
        emit SettlementProofRecorded(poolId, o.paymentProof, o.arrivalProof);
    }

    function correctImporterPayment(
        uint256 poolId,
        bytes32 paymentProof,
        uint256 repaymentAmount
    ) external onlyOwner whenOperational {
        Offering storage o = offerings[poolId];
        _requireSettleable(o);
        require(o.paymentProof != bytes32(0), "payment not recorded");
        require(paymentProof != bytes32(0), "paymentProof=0");
        require(repaymentAmount > 0, "repayment=0");
        require(paymentProof == o.paymentProof || !usedPaymentProof[paymentProof], "payment proof reused");
        usedPaymentProof[paymentProof] = true;
        emit ImporterPaymentCorrected(poolId, o.paymentProof, paymentProof, o.repaymentAmount, repaymentAmount);
        o.paymentProof = paymentProof;
        o.repaymentAmount = repaymentAmount;
        emit SettlementProofRecorded(poolId, o.paymentProof, o.arrivalProof);
    }

    function recordCargoArrival(uint256 poolId, bytes32 arrivalProof) external onlyExecutor whenOperational {
        Offering storage o = offerings[poolId];
        _requireSettleable(o);
        require(arrivalProof != bytes32(0), "arrivalProof=0");
        require(o.arrivalProof == bytes32(0), "arrival already recorded");
        o.arrivalProof = arrivalProof;
        emit SettlementProofRecorded(poolId, o.paymentProof, o.arrivalProof);
    }

    function settle(uint256 poolId, uint256 repaymentAmount) external onlyExecutor whenOperational {
        Offering storage o = offerings[poolId];
        _requireSettleable(o);
        require(o.paymentProof != bytes32(0) && o.arrivalProof != bytes32(0), "settlement proof missing");
        require(repaymentAmount > 0 && repaymentAmount == o.repaymentAmount, "repayment mismatch");
        require(repaymentAmount >= o.subscribed * o.targetRedemptionValue, "outstanding debt");
        _changeState(poolId, OfferingState.Repaid, SETTLE_OFFERING);
        emit OfferingSettled(poolId, repaymentAmount, o.paymentProof, o.arrivalProof);
        _releaseCollateral(poolId, o.eblId);
    }

    function setMaturity(uint256 poolId, uint256 timestamp) external onlyOwner whenOperational {
        Offering storage o = offerings[poolId];
        require(o.exists && o.subscribed == 0 && o.state == OfferingState.Open, "terms locked");
        require(timestamp > block.timestamp, "maturity elapsed");
        maturityAt[poolId] = timestamp;
        if (subscriptionDeadline[poolId] > timestamp) {
            subscriptionDeadline[poolId] = timestamp;
            emit SubscriptionDeadlineSet(poolId, timestamp);
        }
        emit OfferingTermsSet(poolId, timestamp, subscriptionDeadline[poolId]);
    }

    function setSubscriptionDeadline(uint256 poolId, uint256 timestamp) external onlyOwner whenOperational {
        Offering storage o = offerings[poolId];
        require(o.exists && o.subscribed == 0 && o.state == OfferingState.Open, "terms locked");
        require(timestamp > block.timestamp, "deadline elapsed");
        require(timestamp <= maturityAt[poolId], "deadline>maturity");
        subscriptionDeadline[poolId] = timestamp;
        emit SubscriptionDeadlineSet(poolId, timestamp);
    }

    function unfreezeOffering(uint256 poolId, bytes32 evidenceHash) external onlyOwner whenOperational {
        Offering storage o = offerings[poolId];
        require(o.state == OfferingState.Frozen, "not frozen");
        require(evidenceHash != bytes32(0), "evidenceHash=0");
        OfferingState restored = _stateBeforeFreeze[poolId];
        require(restored == OfferingState.Paused || _isActive(restored), "unfreeze state invalid");
        _changeState(poolId, restored, RESUME_OFFERING);
        emit OfferingUnfrozen(poolId, restored, evidenceHash);
    }

    function outstandingDebt(uint256 poolId) public view returns (uint256) {
        Offering storage o = offerings[poolId];
        uint256 due = o.subscribed * o.targetRedemptionValue;
        return o.repaymentAmount >= due ? 0 : due - o.repaymentAmount;
    }

    function recordAdditionalPayment(uint256 poolId, bytes32 proof, uint256 amount) external onlyExecutor whenOperational {
        Offering storage o = offerings[poolId];
        _requireSettleable(o);
        require(o.paymentProof != bytes32(0), "payment not recorded");
        require(proof != bytes32(0) && !usedPaymentProof[proof], "payment proof reused");
        require(amount > 0, "repayment=0");
        usedPaymentProof[proof] = true;
        o.repaymentAmount += amount;
        emit AdditionalPaymentRecorded(poolId, proof, amount, o.repaymentAmount);
    }

    function markDefault(uint256 poolId) external onlyOwner whenOperational {
        Offering storage o = offerings[poolId];
        require(_isActive(o.state) || o.state == OfferingState.Paused || o.state == OfferingState.Frozen, "illegal transition");
        require(o.subscribed > 0 && block.timestamp >= maturityAt[poolId] && outstandingDebt(poolId) > 0, "not overdue");
        _changeState(poolId, OfferingState.Defaulted, TRIGGER_LIQUIDATION);
        emit OfferingDefaulted(poolId, outstandingDebt(poolId));
    }

    function settleLoss(uint256 poolId, bytes32 resolutionHash) external onlyOwner whenOperational {
        Offering storage o = offerings[poolId];
        require(o.state == OfferingState.Defaulted, "not defaulted");
        require(resolutionHash != bytes32(0) && outstandingDebt(poolId) > 0, "loss evidence required");
        realizedLoss[poolId] = outstandingDebt(poolId);
        _changeState(poolId, OfferingState.LossSettled, SETTLE_OFFERING);
        emit LossSettlementRecorded(poolId, o.repaymentAmount, realizedLoss[poolId], resolutionHash);
        _releaseCollateral(poolId, o.eblId);
    }

    function recordLiquidationRecovery(
        uint256 poolId,
        bytes32 paymentProof,
        uint256 amount
    ) external onlyExecutor whenOperational {
        Offering storage o = offerings[poolId];
        require(o.state == OfferingState.Liquidation, "not liquidating");
        require(o.subscribed > 0, "no subscribers");
        require(paymentProof != bytes32(0) && !usedPaymentProof[paymentProof], "payment proof reused");
        require(amount > 0, "repayment=0");
        usedPaymentProof[paymentProof] = true;
        o.repaymentAmount += amount;
        emit LiquidationRecoveryRecorded(poolId, paymentProof, amount, o.repaymentAmount);
    }

    function resolveLiquidation(uint256 poolId, bytes32 resolutionHash) external onlyOwner whenOperational {
        Offering storage o = offerings[poolId];
        require(o.state == OfferingState.Liquidation, "not liquidating");
        require(resolutionHash != bytes32(0), "resolution required");

        if (o.subscribed == 0) {
            _changeState(poolId, OfferingState.Cancelled, CANCEL_OFFERING);
            emit OfferingCancelled(poolId, resolutionHash);
            emit LiquidationResolved(poolId, OfferingState.Cancelled, 0, 0, resolutionHash);
            _releaseCollateral(poolId, o.eblId);
            return;
        }

        uint256 due = o.subscribed * o.targetRedemptionValue;
        uint256 recovered = o.repaymentAmount;
        if (recovered >= due) {
            _changeState(poolId, OfferingState.Repaid, SETTLE_OFFERING);
            emit LiquidationResolved(poolId, OfferingState.Repaid, recovered, 0, resolutionHash);
        } else {
            realizedLoss[poolId] = due - recovered;
            _changeState(poolId, OfferingState.LossSettled, SETTLE_OFFERING);
            emit LossSettlementRecorded(poolId, recovered, realizedLoss[poolId], resolutionHash);
            emit LiquidationResolved(poolId, OfferingState.LossSettled, recovered, realizedLoss[poolId], resolutionHash);
        }
        _releaseCollateral(poolId, o.eblId);
    }

    function applyPricingAction(
        uint256 poolId,
        uint256 newIssuePrice,
        uint8 action,
        bytes32 evidenceHash,
        bytes32 quoteHash
    ) external whenOperational {
        require(msg.sender == oracle || msg.sender == owner, "not authorized");
        Offering storage o = offerings[poolId];
        require(o.exists, "pool missing");
        require(evidenceHash != bytes32(0), "evidenceHash=0");

        if (action == RESUME_OFFERING) {
            _resume(poolId, evidenceHash);
            return;
        }
        if (action == PAUSE_OFFERING) {
            _pause(poolId, evidenceHash, action);
            return;
        }
        if (action == FREEZE_POOL) {
            require(_isActive(o.state) || o.state == OfferingState.Paused, "illegal transition");
            _stateBeforeFreeze[poolId] = o.state;
            _changeState(poolId, OfferingState.Frozen, action);
            emit OfferingFrozen(poolId, evidenceHash);
            return;
        }
        if (action == TRIGGER_LIQUIDATION) {
            require(_isActive(o.state) || o.state == OfferingState.Paused || o.state == OfferingState.Frozen, "illegal transition");
            _changeState(poolId, OfferingState.Liquidation, action);
            return;
        }
        require(action == OPEN_OFFERING || action == OPEN_WITH_WARNING || action == REPRICE_DOWN, "bad action");
        require(_isActive(o.state), "illegal transition");

        if (newIssuePrice > 0 && newIssuePrice != o.issuePrice) {
            require(newIssuePrice <= o.targetRedemptionValue, "price>target");
            require(action != REPRICE_DOWN || newIssuePrice < o.issuePrice, "reprice not down");
            uint256 oldPrice = o.issuePrice;
            o.issuePrice = newIssuePrice;
            quoteVersion[poolId] += 1;
            emit OfferingRepriced(poolId, oldPrice, newIssuePrice, evidenceHash, quoteHash);
        }
    }

    function stateOf(uint256 poolId) external view returns (OfferingState) {
        return offerings[poolId].state;
    }

    function issuePriceOf(uint256 poolId) external view returns (uint256) {
        return offerings[poolId].issuePrice;
    }

    function settlementProofs(uint256 poolId) external view returns (bytes32 paymentProof, bytes32 arrivalProof) {
        Offering storage o = offerings[poolId];
        require(o.exists, "pool missing");
        return (o.paymentProof, o.arrivalProof);
    }

    function _pause(uint256 poolId, bytes32 evidenceHash, uint8 action) internal {
        Offering storage o = offerings[poolId];
        require(o.exists, "pool missing");
        require(_isActive(o.state), "illegal transition");
        _stateBeforePause[poolId] = o.state;
        _changeState(poolId, OfferingState.Paused, action);
        emit OfferingPaused(poolId, evidenceHash);
    }

    function _resume(uint256 poolId, bytes32 evidenceHash) internal {
        Offering storage o = offerings[poolId];
        require(o.exists, "pool missing");
        require(o.state == OfferingState.Paused, "not paused");
        OfferingState restored = _stateBeforePause[poolId];
        require(_isActive(restored), "resume state invalid");
        _changeState(poolId, restored, RESUME_OFFERING);
        emit OfferingResumed(poolId, restored, evidenceHash);
    }

    function _changeState(uint256 poolId, OfferingState newState, uint8 action) internal {
        Offering storage o = offerings[poolId];
        require(o.exists, "pool missing");
        OfferingState oldState = o.state;
        require(oldState != newState, "duplicate state");
        o.state = newState;
        emit OfferingStateChanged(poolId, oldState, newState, action);
    }

    function _releaseCollateral(uint256 poolId, uint256 eblId) internal {
        if (poolOfEbl[eblId] == poolId) delete poolOfEbl[eblId];
        try eblRegistry.releasePledge(eblId) {
            emit CollateralReleased(poolId, eblId);
        } catch {
            emit CollateralReleaseFailed(poolId, eblId);
        }
    }

    function _isActive(OfferingState state) internal pure returns (bool) {
        return state == OfferingState.Open
            || state == OfferingState.Subscribed
            || state == OfferingState.Funded
            || state == OfferingState.InTransit
            || state == OfferingState.Repriced;
    }

    function _requireSettleable(Offering storage o) internal view {
        require(
            _isActive(o.state) || o.state == OfferingState.Defaulted || o.state == OfferingState.Frozen,
            "bad settlement state"
        );
        require(o.subscribed > 0, "no subscribers");
    }
}
