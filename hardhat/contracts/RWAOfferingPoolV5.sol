// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Owned} from "./Owned.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {RecoveryEntitlements} from "./RecoveryEntitlements.sol";

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
contract RWAOfferingPoolV5 is Owned, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error NotExecutor();
    error EmergencyStopped();
    error DependencyIsZero();
    error DependencyNotAContract();
    error OracleIsZero();
    error ExecutorIsZero();
    error Unchanged();
    error InvalidGate();
    error GateMissing();
    error MaturityElapsed();
    error DeadlineElapsed();
    error DeadlineAboveMaturity();
    error AssetIsZero();
    error AssetNotContract();
    error AssetDecimalsNot6();
    error MinRaiseIsZero();
    error MinRaiseAboveMax();
    error IssuePriceIsZero();
    error SupplyIsZero();
    error RedemptionBelowPrice();
    error EblMissing();
    error EblNotPledgedToPool();
    error EblAlreadyOffered();
    error PoolMissing();
    error MaxUnitPriceIsZero();
    error PriceAboveUserLimit();
    error QuoteVersionChanged();
    error UserDeadlineElapsed();
    error NotOpen();
    error SubscriptionDeadlineElapsed();
    error NotEligible();
    error AmountIsZero();
    error ExceedsSupply();
    error TransferTaxNotSupported();
    error DeadlineNotPassed();
    error MinimumNotRaised();
    error ExporterIsZero();
    error EvidenceIsZero();
    error NotFunded();
    error AmountAboveAvailable();
    error NotRepayable();
    error NotRefundable();
    error RaiseSucceeded();
    error FundingAlreadyFinalized();
    error NothingToRefund();
    error LimitAboveMax();
    error NotClaimable();
    error NoShares();
    error InsufficientEscrow();
    error RecipientIsZero();
    error BadState();
    error ClaimsStarted();
    error NoRecovery();
    error FeeAboveRecovery();
    error FeeAboveEscrow();
    error DepartureProofIsZero();
    error NotAuthorized();
    error HasSubscribers();
    error IllegalTransition();
    error PaymentProofIsZero();
    error RepaymentIsZero();
    error RecoveryNotReceived();
    error PaymentAlreadyRecorded();
    error PaymentProofReused();
    error PaymentNotRecorded();
    error ArrivalProofIsZero();
    error ArrivalAlreadyRecorded();
    error SettlementProofMissing();
    error RepaymentMismatch();
    error OutstandingDebt();
    error TermsLocked();
    error NotFrozen();
    error EvidenceHashIsZero();
    error UnfreezeStateInvalid();
    error FundingNotFinalized();
    error NotOverdue();
    error NotDefaulted();
    error LossEvidenceRequired();
    error NotLiquidating();
    error NoSubscribers();
    error ResolutionRequired();
    error BadAction();
    error PriceAboveTarget();
    error RepriceNotDown();
    error NotPaused();
    error ResumeStateInvalid();
    error DuplicateState();
    error RecoveryMismatch();
    error BadSettlementState();

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
    mapping(uint256 => uint256) public recoveredAtomic;
    mapping(uint256 => bool) public fundingFinalized;
    mapping(uint256 => bool) public claimsStarted;
    bool public cumulativeClaims;
    uint256 public executorCount;
    mapping(uint256 => uint256) public disbursementDeadline;
    RecoveryEntitlements public immutable recoveryRights;

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
    event RepaymentReceived(
        uint256 indexed poolId,
        address indexed asset,
        address indexed payer,
        uint256 amountAtomic
    );
    event FundingFinalized(uint256 indexed poolId, uint256 raisedAtomic);

    modifier onlyExecutor() {
        if (!(msg.sender == owner || agentExecutor[msg.sender])) revert NotExecutor();
        _;
    }

    modifier whenOperational() {
        if (!(!emergencyStopped)) revert EmergencyStopped();
        _;
    }

    constructor(address eblRegistry_, address rwaToken_) {
        if (!(eblRegistry_ != address(0) && rwaToken_ != address(0))) revert DependencyIsZero();
        if (!(eblRegistry_.code.length > 0 && rwaToken_.code.length > 0)) revert DependencyNotAContract();
        eblRegistry = IEBLRegistry(eblRegistry_);
        rwaToken = IRWATokenV5Mintable(rwaToken_);
        recoveryRights = new RecoveryEntitlements();
    }

    function setOracle(address oracle_) external onlyOwner {
        if (!(oracle_ != address(0))) revert OracleIsZero();
        oracle = oracle_;
        emit OracleSet(oracle_);
    }

    function setAgentExecutor(address executor, bool allowed) external onlyOwner {
        if (!(executor != address(0))) revert ExecutorIsZero();
        if (agentExecutor[executor] != allowed) { if (allowed) executorCount++; else executorCount--; }
        agentExecutor[executor] = allowed;
        emit AgentExecutorSet(executor, allowed);
    }

    function enableCumulativeClaims() external onlyOwner {
        if (nextPoolId != 1 || cumulativeClaims || executorCount != 0) revert TermsLocked();
        cumulativeClaims = true;
    }
    function setDisbursementDeadline(uint256 poolId, uint256 timestamp) external onlyOwner {
        if (offerings[poolId].subscribed != 0 || timestamp <= subscriptionDeadline[poolId] || timestamp >= maturityAt[poolId]) revert TermsLocked();
        disbursementDeadline[poolId] = timestamp;
    }

    function setEmergencyStop(bool stopped, bytes32 reasonHash) external onlyOwner {
        if (!(emergencyStopped != stopped)) revert Unchanged();
        emergencyStopped = stopped;
        emit EmergencyStopSet(stopped, msg.sender, reasonHash);
    }

    function setComplianceGate(address gate) external onlyOwner {
        if (!(gate != address(0) && gate.code.length > 0)) revert InvalidGate();
        complianceGate = IInvestorComplianceGate(gate);
        emit ComplianceGateSet(gate);
    }

    function setAccessMode(AccessMode mode) external onlyOwner {
        if (mode == AccessMode.ComplianceGated) if (!(address(complianceGate) != address(0))) revert GateMissing();
        accessMode = mode;
        emit AccessModeSet(mode);
    }

    function isInvestorEligible(address investor, uint256 poolId) public view returns (bool) {
        if (accessMode == AccessMode.Permissionless) return investor != address(0);
        return address(complianceGate) != address(0) && complianceGate.isEligible(investor, poolId);
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
        if (!(maturity > block.timestamp)) revert MaturityElapsed();
        if (!(subscribeUntil > block.timestamp)) revert DeadlineElapsed();
        if (!(subscribeUntil <= maturity)) revert DeadlineAboveMaturity();
        if (!(settlementAsset != address(0))) revert AssetIsZero();
        if (!(settlementAsset.code.length > 0)) revert AssetNotContract();
        if (!(IERC20Metadata(settlementAsset).decimals() == 6)) revert AssetDecimalsNot6();
        if (!(minRaise > 0)) revert MinRaiseIsZero();
        if (!(minRaise <= tokenSupply * issuePrice)) revert MinRaiseAboveMax();

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
        if (!(issuePrice > 0)) revert IssuePriceIsZero();
        if (!(tokenSupply > 0)) revert SupplyIsZero();
        if (!(targetRedemptionValue >= issuePrice)) revert RedemptionBelowPrice();
        if (!(eblRegistry.holderOf(eblId) != address(0))) revert EblMissing();
        if (!(eblRegistry.pledgedTo(eblId) == address(this))) revert EblNotPledgedToPool();
        if (!(poolOfEbl[eblId] == 0)) revert EblAlreadyOffered();

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
        disbursementDeadline[poolId] = maturity;

        emit OfferingCreated(poolId, eblId, tokenSupply, issuePrice, targetRedemptionValue);
        emit OfferingTermsSet(poolId, maturity, subscribeUntil);
        emit OfferingStateChanged(poolId, OfferingState.Created, OfferingState.Open, OPEN_OFFERING);
    }

    function subscribe(uint256 poolId, uint256 amount) external whenOperational nonReentrant {
        _subscribe(poolId, amount);
    }

    function subscribeWithTerms(
        uint256 poolId,
        uint256 amount,
        uint256 maxUnitPrice,
        uint256 expectedQuoteVersion,
        uint256 deadline
    ) external whenOperational nonReentrant {
        Offering storage o = offerings[poolId];
        if (!(o.exists)) revert PoolMissing();
        if (!(maxUnitPrice > 0)) revert MaxUnitPriceIsZero();
        if (!(o.issuePrice <= maxUnitPrice)) revert PriceAboveUserLimit();
        if (!(quoteVersion[poolId] == expectedQuoteVersion)) revert QuoteVersionChanged();
        if (!(block.timestamp <= deadline)) revert UserDeadlineElapsed();
        _subscribe(poolId, amount);
    }

    function _subscribe(uint256 poolId, uint256 amount) internal {
        Offering storage o = offerings[poolId];
        if (!(o.exists)) revert PoolMissing();
        if (!(o.state == OfferingState.Open || o.state == OfferingState.Repriced || o.state == OfferingState.Subscribed)) revert NotOpen();
        if (!(block.timestamp <= subscriptionDeadline[poolId])) revert SubscriptionDeadlineElapsed();
        if (!(isInvestorEligible(msg.sender, poolId))) revert NotEligible();
        if (!(amount > 0)) revert AmountIsZero();
        if (!(o.subscribed + amount <= o.tokenSupply)) revert ExceedsSupply();
        if (!(eblRegistry.pledgedTo(o.eblId) == address(this))) revert EblNotPledgedToPool();

        uint256 cost = amount * o.issuePrice;
        IERC20 asset = IERC20(o.settlementAsset);
        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), cost);
        if (!(asset.balanceOf(address(this)) - balanceBefore == cost)) revert TransferTaxNotSupported();

        if (cumulativeClaims) {
            recoveryRights.record(poolId, msg.sender, o.subscribed, amount);
        }
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

        OfferingState next = o.subscribed == o.tokenSupply && o.raisedAtomic >= o.minRaise
            ? OfferingState.Funded : OfferingState.Subscribed;
        if (next == OfferingState.Funded) {
            fundingFinalized[poolId] = true;
            emit FundingFinalized(poolId, o.raisedAtomic);
        }
        if (o.state != next) _changeState(poolId, next, OPEN_OFFERING);
    }

    /// @notice Close a successful partial raise once the subscription window ends.
    function finalizeFunding(uint256 poolId) external whenOperational {
        Offering storage o = offerings[poolId];
        if (!(o.exists)) revert PoolMissing();
        if (!(o.state == OfferingState.Open || o.state == OfferingState.Subscribed || o.state == OfferingState.Repriced)) revert NotOpen();
        if (!(block.timestamp > subscriptionDeadline[poolId])) revert DeadlineNotPassed();
        if (!(o.raisedAtomic >= o.minRaise && o.subscribed > 0)) revert MinimumNotRaised();
        fundingFinalized[poolId] = true;
        _changeState(poolId, OfferingState.Funded, OPEN_OFFERING);
        emit FundingFinalized(poolId, o.raisedAtomic);
    }

    function disburseToExporter(uint256 poolId, uint256 amountAtomic, address exporter, bytes32 evidenceHash)
        external onlyOwner whenOperational nonReentrant {
        if (!(exporter != address(0))) revert ExporterIsZero();
        if (!(evidenceHash != bytes32(0))) revert EvidenceIsZero();
        Offering storage o = offerings[poolId];
        if (!(o.exists)) revert PoolMissing();
        if (!(o.state == OfferingState.Funded || o.state == OfferingState.InTransit)) revert NotFunded();
        if (block.timestamp >= maturityAt[poolId] || block.timestamp >= disbursementDeadline[poolId]) revert DeadlineElapsed();
        uint256 available = o.raisedAtomic - disbursedAtomic[poolId];
        if (!(amountAtomic > 0 && amountAtomic <= available)) revert AmountAboveAvailable();
        disbursedAtomic[poolId] += amountAtomic;
        escrowed[poolId][o.settlementAsset] -= amountAtomic;
        IERC20(o.settlementAsset).safeTransfer(exporter, amountAtomic);
        emit DisbursedToExporter(poolId, o.settlementAsset, amountAtomic, evidenceHash);
    }

    /// @notice Move repayment assets into the on-chain escrow so investors can claim.
    /// @dev    Recovery is accounted separately from subscription principal and proof metadata.
    function repay(uint256 poolId, uint256 amountAtomic) external whenOperational nonReentrant {
        Offering storage o = offerings[poolId];
        if (!(o.exists)) revert PoolMissing();
        if (!(amountAtomic > 0)) revert AmountIsZero();
        if (!(fundingFinalized[poolId] && (o.state == OfferingState.Funded || o.state == OfferingState.InTransit
                || o.state == OfferingState.Defaulted || o.state == OfferingState.Paused
                || o.state == OfferingState.Frozen || o.state == OfferingState.Liquidation
                || (cumulativeClaims && (o.state == OfferingState.Repaid || o.state == OfferingState.LossSettled))))) revert NotRepayable();
        IERC20 asset = IERC20(o.settlementAsset);
        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amountAtomic);
        if (!(asset.balanceOf(address(this)) - balanceBefore == amountAtomic)) revert TransferTaxNotSupported();
        escrowed[poolId][o.settlementAsset] += amountAtomic;
        recoveredAtomic[poolId] += amountAtomic;
        if (cumulativeClaims && (o.state == OfferingState.Repaid || o.state == OfferingState.LossSettled)) {
            o.repaymentAmount += amountAtomic;
            uint256 due = targetDistribution(poolId);
            realizedLoss[poolId] = due > o.repaymentAmount ? due - o.repaymentAmount : 0;
        }
        emit RepaymentReceived(poolId, o.settlementAsset, msg.sender, amountAtomic);
    }

    function refundInvestor(uint256 poolId, address investor) external whenOperational nonReentrant {
        Offering storage o = offerings[poolId];
        if (!(o.exists)) revert PoolMissing();
        if (!(o.state == OfferingState.Open || o.state == OfferingState.Subscribed ||
            o.state == OfferingState.Repriced || o.state == OfferingState.Paused ||
            o.state == OfferingState.Frozen || o.state == OfferingState.Cancelled || o.state == OfferingState.Liquidation)) revert NotRefundable();
        if (!(block.timestamp > subscriptionDeadline[poolId] || o.state == OfferingState.Cancelled)) revert DeadlineNotPassed();
        if (!(o.raisedAtomic < o.minRaise || o.state == OfferingState.Cancelled)) revert RaiseSucceeded();
        if (!(!fundingFinalized[poolId])) revert FundingAlreadyFinalized();
        uint256 paid = investorPaid[poolId][o.settlementAsset][investor];
        if (!(paid > 0)) revert NothingToRefund();
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
    function refundAllOnFailure(uint256 poolId) external onlyOwner whenOperational nonReentrant {
        _refundAllOnFailure(poolId, 0, MAX_REFUND_BATCH);
    }

    /// @notice Refund a bounded slice of investors in a failed or cancelled pool.
    /// @param  start Index into the pool's investor list to begin processing.
    /// @param  limit Maximum number of investors to process in this call; capped at
    ///         `MAX_REFUND_BATCH` to preserve liveness.
    function refundAllOnFailure(uint256 poolId, uint256 start, uint256 limit) external onlyOwner whenOperational nonReentrant {
        if (!(limit <= MAX_REFUND_BATCH)) revert LimitAboveMax();
        _refundAllOnFailure(poolId, start, limit);
    }

    function _refundAllOnFailure(uint256 poolId, uint256 start, uint256 limit) internal {
        Offering storage o = offerings[poolId];
        if (!(o.exists)) revert PoolMissing();
        if (!(o.state == OfferingState.Open || o.state == OfferingState.Subscribed ||
            o.state == OfferingState.Repriced || o.state == OfferingState.Paused ||
            o.state == OfferingState.Frozen || o.state == OfferingState.Cancelled || o.state == OfferingState.Liquidation)) revert NotRefundable();
        if (!(block.timestamp > subscriptionDeadline[poolId] || o.state == OfferingState.Cancelled)) revert DeadlineNotPassed();
        if (!(o.raisedAtomic < o.minRaise || o.state == OfferingState.Cancelled)) revert RaiseSucceeded();
        if (!(!fundingFinalized[poolId])) revert FundingAlreadyFinalized();

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

    function claimable(uint256 poolId, address investor) public view returns (uint256) {
        Offering storage o = offerings[poolId];
        if (o.state != OfferingState.Repaid && o.state != OfferingState.LossSettled) return 0;
        if (cumulativeClaims) {
            // Atomic units traverse immutable subscription slots in round-robin order.
            // Every prefix is monotonic; the sum is exact and independent of claim order.
            uint256 entitlement = recoveryRights.entitlement(poolId, investor, o.repaymentAmount, o.subscribed);
            return entitlement - investorClaimed[poolId][o.settlementAsset][investor];
        }
        uint256 balance = rwaToken.balanceOf(poolId, investor);
        if (balance == 0) return 0;
        return Math.mulDiv(o.repaymentAmount - feesDeducted[poolId] - totalClaimed[poolId], balance, rwaToken.totalSupply(poolId));
    }

    function claim(uint256 poolId) external whenOperational nonReentrant {
        Offering storage o = offerings[poolId];
        if (!(o.exists)) revert PoolMissing();
        if (!(o.state == OfferingState.Repaid || o.state == OfferingState.LossSettled)) revert NotClaimable();
        uint256 balance = rwaToken.balanceOf(poolId, msg.sender);
        uint256 already = investorClaimed[poolId][o.settlementAsset][msg.sender];
        uint256 owed = claimable(poolId, msg.sender);
        if (!(balance > 0 || (cumulativeClaims && owed > 0))) revert NoShares();
        if (!(escrowed[poolId][o.settlementAsset] >= owed)) revert InsufficientEscrow();
        claimsStarted[poolId] = true;
        investorClaimed[poolId][o.settlementAsset][msg.sender] = already + owed;
        totalClaimed[poolId] += owed;
        escrowed[poolId][o.settlementAsset] -= owed;
        if (balance > 0) rwaToken.burn(poolId, msg.sender, balance);
        if (owed > 0) IERC20(o.settlementAsset).safeTransfer(msg.sender, owed);
        emit Claimed(poolId, msg.sender, o.settlementAsset, owed, balance);
    }

    function deductFee(uint256 poolId, uint256 amountAtomic, address feeRecipient, bytes32 feeEvidenceHash)
        external onlyOwner whenOperational nonReentrant {
        if (cumulativeClaims) revert TermsLocked();
        if (!(feeRecipient != address(0))) revert RecipientIsZero();
        if (!(feeEvidenceHash != bytes32(0))) revert EvidenceIsZero();
        Offering storage o = offerings[poolId];
        if (!(o.exists)) revert PoolMissing();
        if (!(o.state == OfferingState.Repaid || o.state == OfferingState.LossSettled)) revert BadState();
        if (!(!claimsStarted[poolId])) revert ClaimsStarted();
        if (!(amountAtomic > 0)) revert AmountIsZero();
        if (!(o.repaymentAmount > 0)) revert NoRecovery();
        if (!(feesDeducted[poolId] + amountAtomic <= o.repaymentAmount)) revert FeeAboveRecovery();
        if (!(amountAtomic <= escrowed[poolId][o.settlementAsset])) revert FeeAboveEscrow();
        feesDeducted[poolId] += amountAtomic;
        escrowed[poolId][o.settlementAsset] -= amountAtomic;
        IERC20(o.settlementAsset).safeTransfer(feeRecipient, amountAtomic);
        emit FeeDeducted(poolId, o.settlementAsset, amountAtomic, feeEvidenceHash);
    }

    function _maybeCancelAndRelease(Offering storage o, uint256 poolId) internal {
        if (o.raisedAtomic == 0) {
            if (o.state != OfferingState.Cancelled) {
                _changeState(poolId, OfferingState.Cancelled, CANCEL_OFFERING);
                emit OfferingCancelled(poolId, bytes32(0));
            }
            if (eblRegistry.pledgedTo(o.eblId) == address(this)) _releaseCollateral(poolId, o.eblId);
        }
    }

    function markInTransit(uint256 poolId, bytes32 departureProof) external onlyExecutor whenOperational {
        if (!(departureProof != bytes32(0))) revert DepartureProofIsZero();
        Offering storage o = offerings[poolId];
        if (!(o.state == OfferingState.Funded && fundingFinalized[poolId])) revert NotFunded();
        _changeState(poolId, OfferingState.InTransit, OPEN_OFFERING);
        emit DepartureRecorded(poolId, departureProof);
    }

    function cancelOffering(uint256 poolId, bytes32 reasonHash) external onlyOwner {
        Offering storage o = offerings[poolId];
        if (!(o.exists)) revert PoolMissing();
        if (!(o.subscribed == 0)) revert HasSubscribers();
        if (!(o.state == OfferingState.Open || o.state == OfferingState.Repriced || o.state == OfferingState.Paused
                || o.state == OfferingState.Frozen || o.state == OfferingState.Liquidation)) revert IllegalTransition();
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
        if (!(paymentProof != bytes32(0))) revert PaymentProofIsZero();
        if (!(repaymentAmount > 0)) revert RepaymentIsZero();
        if (!(repaymentAmount <= recoveredAtomic[poolId])) revert RecoveryNotReceived();
        if (!(o.paymentProof == bytes32(0))) revert PaymentAlreadyRecorded();
        if (!(!usedPaymentProof[paymentProof])) revert PaymentProofReused();
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
        if (!(o.paymentProof != bytes32(0))) revert PaymentNotRecorded();
        if (!(paymentProof != bytes32(0))) revert PaymentProofIsZero();
        if (!(repaymentAmount > 0)) revert RepaymentIsZero();
        if (!(repaymentAmount <= recoveredAtomic[poolId])) revert RecoveryNotReceived();
        if (!(paymentProof == o.paymentProof || !usedPaymentProof[paymentProof])) revert PaymentProofReused();
        usedPaymentProof[paymentProof] = true;
        emit ImporterPaymentCorrected(poolId, o.paymentProof, paymentProof, o.repaymentAmount, repaymentAmount);
        o.paymentProof = paymentProof;
        o.repaymentAmount = repaymentAmount;
        emit SettlementProofRecorded(poolId, o.paymentProof, o.arrivalProof);
    }

    function recordCargoArrival(uint256 poolId, bytes32 arrivalProof) external onlyExecutor whenOperational {
        Offering storage o = offerings[poolId];
        _requireSettleable(o);
        if (!(arrivalProof != bytes32(0))) revert ArrivalProofIsZero();
        if (!(o.arrivalProof == bytes32(0))) revert ArrivalAlreadyRecorded();
        o.arrivalProof = arrivalProof;
        emit SettlementProofRecorded(poolId, o.paymentProof, o.arrivalProof);
    }

    function settle(uint256 poolId, uint256 repaymentAmount) external onlyExecutor whenOperational {
        Offering storage o = offerings[poolId];
        _requireSettleable(o);
        if (!(o.paymentProof != bytes32(0) && o.arrivalProof != bytes32(0))) revert SettlementProofMissing();
        if (!(repaymentAmount > 0 && repaymentAmount == o.repaymentAmount)) revert RepaymentMismatch();
        _sealRecovery(poolId, o);
        if (!(o.repaymentAmount >= targetDistribution(poolId))) revert OutstandingDebt();
        _changeState(poolId, OfferingState.Repaid, SETTLE_OFFERING);
        emit OfferingSettled(poolId, o.repaymentAmount, o.paymentProof, o.arrivalProof);
        _releaseCollateral(poolId, o.eblId);
    }

    function unfreezeOffering(uint256 poolId, bytes32 evidenceHash) external onlyOwner whenOperational {
        Offering storage o = offerings[poolId];
        if (!(o.state == OfferingState.Frozen)) revert NotFrozen();
        if (!(evidenceHash != bytes32(0))) revert EvidenceHashIsZero();
        OfferingState restored = _stateBeforeFreeze[poolId];
        if (!(restored == OfferingState.Paused || _isActive(restored))) revert UnfreezeStateInvalid();
        _changeState(poolId, restored, RESUME_OFFERING);
        emit OfferingUnfrozen(poolId, restored, evidenceHash);
    }

    function outstandingDebt(uint256 poolId) public view returns (uint256) {
        Offering storage o = offerings[poolId];
        uint256 due = targetDistribution(poolId);
        uint256 recovered = cumulativeClaims ? recoveredAtomic[poolId] + o.raisedAtomic - disbursedAtomic[poolId] : o.repaymentAmount;
        if (!cumulativeClaims && o.state != OfferingState.Repaid && o.state != OfferingState.LossSettled) recovered += o.raisedAtomic - disbursedAtomic[poolId];
        return recovered >= due ? 0 : due - recovered;
    }

    function targetDistribution(uint256 poolId) public view returns (uint256) {
        Offering storage o = offerings[poolId];
        uint256 gross = o.subscribed * o.targetRedemptionValue;
        if (!cumulativeClaims || o.raisedAtomic == 0) return gross;
        return o.raisedAtomic + Math.mulDiv(gross - o.raisedAtomic, disbursedAtomic[poolId], o.raisedAtomic, Math.Rounding.Ceil);
    }
    function closeUndisbursed(uint256 poolId) external nonReentrant {
        Offering storage o = offerings[poolId];
        if (!cumulativeClaims || !o.exists || o.subscribed == 0 || disbursedAtomic[poolId] != 0
            || block.timestamp < disbursementDeadline[poolId] || o.raisedAtomic < o.minRaise
            || o.state == OfferingState.Repaid || o.state == OfferingState.LossSettled || o.state == OfferingState.Cancelled) revert BadState();
        fundingFinalized[poolId] = true;
        _sealRecovery(poolId, o);
        _changeState(poolId, OfferingState.Repaid, SETTLE_OFFERING);
        _releaseCollateral(poolId, o.eblId);
    }

    function recordAdditionalPayment(uint256 poolId, bytes32 proof, uint256 amount) external onlyExecutor whenOperational {
        Offering storage o = offerings[poolId];
        _requireSettleable(o);
        if (!(o.paymentProof != bytes32(0))) revert PaymentNotRecorded();
        if (!(proof != bytes32(0) && !usedPaymentProof[proof])) revert PaymentProofReused();
        if (!(amount > 0)) revert RepaymentIsZero();
        if (!(o.repaymentAmount + amount <= recoveredAtomic[poolId])) revert RecoveryNotReceived();
        usedPaymentProof[proof] = true;
        o.repaymentAmount += amount;
        emit AdditionalPaymentRecorded(poolId, proof, amount, o.repaymentAmount);
    }

    function markDefault(uint256 poolId) external onlyOwner whenOperational {
        Offering storage o = offerings[poolId];
        if (!(_isActive(o.state) || o.state == OfferingState.Paused || o.state == OfferingState.Frozen)) revert IllegalTransition();
        if (!(fundingFinalized[poolId])) revert FundingNotFinalized();
        if (!(o.subscribed > 0 && block.timestamp >= maturityAt[poolId] && (cumulativeClaims || outstandingDebt(poolId) > 0))) revert NotOverdue();
        _changeState(poolId, OfferingState.Defaulted, TRIGGER_LIQUIDATION);
        emit OfferingDefaulted(poolId, outstandingDebt(poolId));
    }

    function settleLoss(uint256 poolId, bytes32 resolutionHash) external onlyOwner whenOperational {
        Offering storage o = offerings[poolId];
        if (!(o.state == OfferingState.Defaulted)) revert NotDefaulted();
        if (!(resolutionHash != bytes32(0) && outstandingDebt(poolId) > 0)) revert LossEvidenceRequired();
        _sealRecovery(poolId, o);
        uint256 due = targetDistribution(poolId);
        realizedLoss[poolId] = due > o.repaymentAmount ? due - o.repaymentAmount : 0;
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
        if (!(o.state == OfferingState.Liquidation || (cumulativeClaims && o.state == OfferingState.Defaulted))) revert NotLiquidating();
        if (!(o.subscribed > 0)) revert NoSubscribers();
        if (!(fundingFinalized[poolId])) revert FundingNotFinalized();
        if (!(paymentProof != bytes32(0) && !usedPaymentProof[paymentProof])) revert PaymentProofReused();
        if (!(amount > 0)) revert RepaymentIsZero();
        if (!(o.repaymentAmount + amount <= recoveredAtomic[poolId])) revert RecoveryNotReceived();
        usedPaymentProof[paymentProof] = true;
        o.repaymentAmount += amount;
        emit LiquidationRecoveryRecorded(poolId, paymentProof, amount, o.repaymentAmount);
    }

    function resolveLiquidation(uint256 poolId, bytes32 resolutionHash) external onlyOwner whenOperational {
        Offering storage o = offerings[poolId];
        if (!(o.state == OfferingState.Liquidation || (cumulativeClaims && o.state == OfferingState.Defaulted))) revert NotLiquidating();
        if (!(resolutionHash != bytes32(0))) revert ResolutionRequired();

        if (o.subscribed == 0) {
            _changeState(poolId, OfferingState.Cancelled, CANCEL_OFFERING);
            emit OfferingCancelled(poolId, resolutionHash);
            emit LiquidationResolved(poolId, OfferingState.Cancelled, 0, 0, resolutionHash);
            _releaseCollateral(poolId, o.eblId);
            return;
        }

        if (!fundingFinalized[poolId]) {
            _changeState(poolId, OfferingState.Cancelled, CANCEL_OFFERING);
            emit OfferingCancelled(poolId, resolutionHash);
            emit LiquidationResolved(poolId, OfferingState.Cancelled, 0, 0, resolutionHash);
            // Pending subscribers recover their exact deposits before collateral is released.
            return;
        }

        _sealRecovery(poolId, o);
        uint256 due = targetDistribution(poolId);
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
        if (!(msg.sender == oracle || msg.sender == owner)) revert NotAuthorized();
        Offering storage o = offerings[poolId];
        if (!(o.exists)) revert PoolMissing();
        if (!(evidenceHash != bytes32(0))) revert EvidenceHashIsZero();

        if (action == RESUME_OFFERING) {
            _resume(poolId, evidenceHash);
            return;
        }
        if (action == PAUSE_OFFERING) {
            _pause(poolId, evidenceHash, action);
            return;
        }
        if (action == FREEZE_POOL) {
            if (!(_isActive(o.state) || o.state == OfferingState.Paused)) revert IllegalTransition();
            _stateBeforeFreeze[poolId] = o.state;
            _changeState(poolId, OfferingState.Frozen, action);
            emit OfferingFrozen(poolId, evidenceHash);
            return;
        }
        if (action == TRIGGER_LIQUIDATION) {
            if (!(_isActive(o.state) || o.state == OfferingState.Paused || o.state == OfferingState.Frozen)) revert IllegalTransition();
            _changeState(poolId, OfferingState.Liquidation, action);
            return;
        }
        if (!(action == OPEN_OFFERING || action == OPEN_WITH_WARNING || action == REPRICE_DOWN)) revert BadAction();
        if (!(_isActive(o.state))) revert IllegalTransition();

        if (newIssuePrice > 0 && newIssuePrice != o.issuePrice) {
            if (!(newIssuePrice <= o.targetRedemptionValue)) revert PriceAboveTarget();
            if (!(action != REPRICE_DOWN || newIssuePrice < o.issuePrice)) revert RepriceNotDown();
            // Every share carries the same claim, so the price is fixed once anyone has paid it,
            // and a full raise at the new price must still reach the minimum.
            if (o.subscribed != 0) revert HasSubscribers();
            if (o.tokenSupply * newIssuePrice < o.minRaise) revert MinRaiseAboveMax();
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
        if (!(o.exists)) revert PoolMissing();
        return (o.paymentProof, o.arrivalProof);
    }

    function _pause(uint256 poolId, bytes32 evidenceHash, uint8 action) internal {
        Offering storage o = offerings[poolId];
        if (!(o.exists)) revert PoolMissing();
        if (!(_isActive(o.state))) revert IllegalTransition();
        _stateBeforePause[poolId] = o.state;
        _changeState(poolId, OfferingState.Paused, action);
        emit OfferingPaused(poolId, evidenceHash);
    }

    function _resume(uint256 poolId, bytes32 evidenceHash) internal {
        Offering storage o = offerings[poolId];
        if (!(o.exists)) revert PoolMissing();
        if (!(o.state == OfferingState.Paused)) revert NotPaused();
        OfferingState restored = _stateBeforePause[poolId];
        if (!(_isActive(restored))) revert ResumeStateInvalid();
        _changeState(poolId, restored, RESUME_OFFERING);
        emit OfferingResumed(poolId, restored, evidenceHash);
    }

    function _changeState(uint256 poolId, OfferingState newState, uint8 action) internal {
        Offering storage o = offerings[poolId];
        if (!(o.exists)) revert PoolMissing();
        OfferingState oldState = o.state;
        if (!(oldState != newState)) revert DuplicateState();
        o.state = newState;
        emit OfferingStateChanged(poolId, oldState, newState, action);
    }

    /// @notice Anyone may retry a terminal pool's collateral release after the in-line attempt failed.
    ///         Returns false, without changes, once the title is no longer pledged for this pool.
    function retryCollateralRelease(uint256 poolId) external nonReentrant returns (bool) {
        Offering storage o = offerings[poolId];
        if (!(o.state == OfferingState.Repaid || o.state == OfferingState.LossSettled
            || (o.state == OfferingState.Cancelled && o.raisedAtomic == 0))) revert BadState();
        uint256 current = poolOfEbl[o.eblId];
        if ((current != 0 && current != poolId) || eblRegistry.pledgedTo(o.eblId) != address(this)) return false;
        if (current == poolId) delete poolOfEbl[o.eblId];
        eblRegistry.releasePledge(o.eblId);
        emit CollateralReleased(poolId, o.eblId);
        return true;
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

    /// @dev Seal the actual recovery and return any principal never disbursed to the exporter.
    ///      Proof metadata alone cannot release collateral or create claimable money.
    function _sealRecovery(uint256 poolId, Offering storage o) internal {
        if (!(fundingFinalized[poolId])) revert FundingNotFinalized();
        if (!cumulativeClaims && o.repaymentAmount != recoveredAtomic[poolId]) revert RecoveryMismatch();
        o.repaymentAmount = recoveredAtomic[poolId] + o.raisedAtomic - disbursedAtomic[poolId];
        if (!(o.repaymentAmount <= escrowed[poolId][o.settlementAsset])) revert InsufficientEscrow();
    }

    function _requireSettleable(Offering storage o) internal view {
        if (!(_isActive(o.state) || o.state == OfferingState.Defaulted || o.state == OfferingState.Frozen)) revert BadSettlementState();
        if (!(o.subscribed > 0)) revert NoSubscribers();
        if (!(o.raisedAtomic >= o.minRaise)) revert MinimumNotRaised();
    }
}
