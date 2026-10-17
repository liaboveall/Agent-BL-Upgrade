// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Owned} from "./Owned.sol";

interface IEBLRegistry {
    function holderOf(uint256 eblId) external view returns (address);
    function pledgedTo(uint256 eblId) external view returns (address);
    function releasePledge(uint256 eblId) external;
}

interface IRWATokenMintable {
    function mint(uint256 poolId, address investor, uint256 amount) external;
}

interface IInvestorComplianceGate {
    function isEligible(address investor, uint256 poolId) external view returns (bool);
}

/// @title RWAOfferingPool (WEB3-3/8/15/16)
/// @notice eBL-backed RWA offering state machine with autonomous executors,
///         emergency human stop and a testnet/production investor access switch.
/// @dev    Scope: this contract is the on-chain *state machine and audit trail* of an
///         offering. It does NOT custody investor funds: `subscribe` mints a
///         non-transferable share receipt and records the amount owed (`paidAmount`),
///         but no stablecoin is escrowed and `settle` records the importer's repayment
///         proof without distributing it. A production deployment must add a payment
///         leg (e.g. an ERC-20 escrow with pro-rata redemption) before real money
///         depends on it. See docs/contracts.md "Known limitations".
contract RWAOfferingPool is Owned {
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
    IRWATokenMintable public rwaToken;
    IInvestorComplianceGate public complianceGate;
    AccessMode public accessMode = AccessMode.Permissionless;
    bool public emergencyStopped;
    uint256 public nextPoolId = 1;
    uint256 public constant protocolVersion = 3;
    mapping(uint256 => uint256) public quoteVersion;
    mapping(uint256 => uint256) public maturityAt;
    mapping(uint256 => uint256) public realizedLoss;
    mapping(bytes32 => bool) public usedPaymentProof;

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
    }

    mapping(uint256 => Offering) public offerings;
    mapping(uint256 => OfferingState) private _stateBeforePause;
    mapping(address => bool) public agentExecutor;
    /// @notice The live offering (poolId, 0 = none) an eBL currently backs. One eBL can
    ///         back at most one offering at a time; the slot is freed when the offering
    ///         is repaid or cancelled.
    mapping(uint256 => uint256) public poolOfEbl;

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
        rwaToken = IRWATokenMintable(rwaToken_);
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

    /// @notice Human-only pool pause that remains available during a global stop.
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

    function createOffering(
        uint256 eblId,
        uint256 tokenSupply,
        uint256 issuePrice,
        uint256 targetRedemptionValue
    ) external onlyOwner whenOperational returns (uint256 poolId) {
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
            state: OfferingState.Open,
            exists: true
        });
        quoteVersion[poolId] = 1;
        maturityAt[poolId] = block.timestamp + 60 days;

        emit OfferingCreated(poolId, eblId, tokenSupply, issuePrice, targetRedemptionValue);
        emit OfferingStateChanged(poolId, OfferingState.Created, OfferingState.Open, OPEN_OFFERING);
    }

    function subscribe(uint256 poolId, uint256 amount) external whenOperational {
        Offering storage o = offerings[poolId];
        require(o.exists, "pool missing");
        require(
            o.state == OfferingState.Open || o.state == OfferingState.Repriced || o.state == OfferingState.Subscribed,
            "not open"
        );
        require(isInvestorEligible(msg.sender, poolId), "not eligible");
        require(amount > 0, "amount=0");
        require(o.subscribed + amount <= o.tokenSupply, "exceeds supply");
        // The collateral must still be locked to this pool when new shares are sold: the
        // registry owner can release a pledge, and shares must never be issued against an
        // eBL that can already be transferred away.
        require(eblRegistry.pledgedTo(o.eblId) == address(this), "ebl not pledged to pool");

        o.subscribed += amount;
        uint256 paidAmount = amount * o.issuePrice;
        rwaToken.mint(poolId, msg.sender, amount);
        emit Subscribed(poolId, msg.sender, amount, paidAmount);

        OfferingState next = o.subscribed == o.tokenSupply ? OfferingState.Funded : OfferingState.Subscribed;
        if (o.state != next) _changeState(poolId, next, OPEN_OFFERING);
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

    /// @notice Withdraw an offering that never attracted a subscriber. The pledge is released
    ///         so the eBL can be transferred or offered again. Offerings that already have
    ///         investors cannot be cancelled: use the FREEZE_POOL / TRIGGER_LIQUIDATION
    ///         pricing actions for those. Human-only, and (like `emergencyPause`) available
    ///         during a global stop because it only ever reduces risk.
    function cancelOffering(uint256 poolId, bytes32 reasonHash) external onlyOwner {
        Offering storage o = offerings[poolId];
        require(o.exists, "pool missing");
        require(o.subscribed == 0, "has subscribers");
        require(
            o.state == OfferingState.Open || o.state == OfferingState.Repriced || o.state == OfferingState.Paused,
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

    /// @notice Replace a mistaken importer-payment record (wrong proof or amount) before the
    ///         offering is settled. Human-only: an autonomous executor must not be able to
    ///         rewrite its own proofs. The previous values stay in the event log.
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

    /// @notice Terms may be set before investors subscribe; existing rights cannot be extended.
    function setMaturity(uint256 poolId, uint256 timestamp) external onlyOwner whenOperational {
        Offering storage o = offerings[poolId];
        require(o.exists && o.subscribed == 0 && o.state == OfferingState.Open, "terms locked");
        require(timestamp > block.timestamp, "maturity elapsed");
        maturityAt[poolId] = timestamp;
    }

    function outstandingDebt(uint256 poolId) public view returns (uint256) {
        Offering storage o = offerings[poolId];
        uint256 due = o.subscribed * o.targetRedemptionValue;
        return o.repaymentAmount >= due ? 0 : due - o.repaymentAmount;
    }

    /// @notice Partial recovery retains the collateral and the original debt obligation.
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

    /// @notice Explicit human loss resolution, never represented as successful full repayment.
    ///         The resolution commits to off-chain recovery/allocation evidence; this is not a payout.
    function settleLoss(uint256 poolId, bytes32 resolutionHash) external onlyOwner whenOperational {
        Offering storage o = offerings[poolId];
        require(o.state == OfferingState.Defaulted, "not defaulted");
        require(resolutionHash != bytes32(0) && outstandingDebt(poolId) > 0, "loss evidence required");
        realizedLoss[poolId] = outstandingDebt(poolId);
        _changeState(poolId, OfferingState.LossSettled, SETTLE_OFFERING);
        emit LossSettlementRecorded(poolId, o.repaymentAmount, realizedLoss[poolId], resolutionHash);
        _releaseCollateral(poolId, o.eblId);
    }

    /// @notice Apply an AI pricing action coming from RiskPricingOracle.
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
            _changeState(poolId, OfferingState.Frozen, action);
            emit OfferingPaused(poolId, evidenceHash);
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
            // The AI may move the price in either direction (a risk that subsides can lift
            // it again) but never above what the offering redeems for, and REPRICE_DOWN
            // must actually lower it.
            require(newIssuePrice <= o.targetRedemptionValue, "price>target");
            require(action != REPRICE_DOWN || newIssuePrice < o.issuePrice, "reprice not down");
            uint256 oldPrice = o.issuePrice;
            o.issuePrice = newIssuePrice;
            quoteVersion[poolId] += 1;
            emit OfferingRepriced(poolId, oldPrice, newIssuePrice, evidenceHash, quoteHash);
        }
        // Price changes apply to unsold shares. Logistics and already-issued claims keep their stage.
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

    /// @dev Free the eBL for other uses once an offering ends in a terminal state.
    ///      Releasing the pledge is best effort: if the registry owner already released it,
    ///      settlement must still go through, so a failure is reported as an event instead.
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

    /// @dev Settlement is only meaningful for a live offering that has investors: an
    ///      offering nobody subscribed to has nothing to repay.
    function _requireSettleable(Offering storage o) internal view {
        require(_isActive(o.state) || o.state == OfferingState.Defaulted, "bad settlement state");
        require(o.subscribed > 0, "no subscribers");
    }
}
