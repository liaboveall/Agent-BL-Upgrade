// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {RWAOfferingPoolV5} from "./RWAOfferingPoolV5.sol";
import {CommittedEBLRegistry} from "./CommittedEBLRegistry.sol";
import {ControlledRWAToken} from "./ControlledRWAToken.sol";
import {RightsGovernance} from "./RightsGovernance.sol";

/// @notice W3 research/test-asset control plane. Owns a fresh V5 capital pool for life.
///         No arbitrary-call, gate replacement, ownership escape or raw executor grant exists.
contract RightsController is EIP712 {
    error InvalidSetup();
    error InvalidOperation();
    error GovernanceRequired();
    struct OfferingTerms {
        uint256 eblId;
        bytes32 assetKey;
        bytes32 documentHash;
        address settlementAsset;
        address exporter;
        address feeRecipient;
        uint256 supply;
        uint256 issuePrice;
        uint256 target;
        uint256 minRaise;
        uint64 maturity;
        uint64 subscribeUntil;
        uint64 disburseUntil;
        uint256 maxFee;
        bytes32 policyHash;
        bytes32 disclosureHash;
        uint256 nonce;
    }
    struct Valuation {
        bytes32 termsHash;
        bytes32 assetKey;
        address settlementAsset;
        uint256 netValue;
        uint32 coverageBps;
        uint64 valuedAt;
        uint64 validUntil;
        uint256 nonce;
    }
    struct Eligibility { bytes32 subjectHash; bytes32 evidenceHash; address attestor; uint64 validUntil; }
    struct Acceptance { bytes32 termsHash; uint256 quoteVersion; uint64 validUntil; }
    struct Resolution {
        bytes32 evidenceHash;
        bytes32 distributionHash;
        uint256 expectedRecovery;
        uint64 noticeUntil;
        address proposer;
        address reviewer;
        bool disputed;
        bool finalized;
        bool disputeUsed;
        uint64 hardDeadline;
    }
    bytes32 public constant TERMS_TYPEHASH = keccak256("OfferingTerms(uint256 eblId,bytes32 assetKey,bytes32 documentHash,address settlementAsset,address exporter,address feeRecipient,uint256 supply,uint256 issuePrice,uint256 target,uint256 minRaise,uint64 maturity,uint64 subscribeUntil,uint64 disburseUntil,uint256 maxFee,bytes32 policyHash,bytes32 disclosureHash,uint256 nonce)");
    bytes32 public constant VALUATION_TYPEHASH = keccak256("Valuation(bytes32 termsHash,bytes32 assetKey,address settlementAsset,uint256 netValue,uint32 coverageBps,uint64 valuedAt,uint64 validUntil,uint256 nonce)");
    bytes32 public constant ISSUER = keccak256("ISSUER");
    bytes32 public constant VALUER = keccak256("VALUER");
    bytes32 public constant OPERATOR = keccak256("OPERATOR");
    bytes32 public constant ATTESTOR = keccak256("ATTESTOR");
    bytes32 public constant COMPLIANCE = keccak256("COMPLIANCE");
    bytes32 public constant DISPOSER = keccak256("DISPOSER");
    bytes32 public constant REVIEWER = keccak256("REVIEWER");
    bytes32 public constant GUARDIAN = keccak256("GUARDIAN");
    uint64 public constant NOTICE_PERIOD = 1 days;
    uint64 public constant MAX_RESOLUTION_PERIOD = 3 days;
    uint256 public constant controlVersion = 4;
    bytes32 public constant scope = keccak256("RESEARCH_TEST_ASSETS_ONLY");
    address public immutable governance;
    CommittedEBLRegistry public immutable registry;
    ControlledRWAToken public immutable token;
    RWAOfferingPoolV5 public immutable pool;
    mapping(bytes32 => mapping(address => bool)) public roles;
    mapping(address => bool) public testAsset;
    mapping(uint256 => OfferingTerms) public terms;
    mapping(uint256 => bytes32) public termsHash;
    mapping(uint256 => Valuation) public valuations;
    mapping(uint256 => address) public valuer;
    mapping(address => mapping(uint256 => bool)) public usedValuationNonce;
    mapping(uint256 => uint256) public latestPoolForEbl;
    /// @notice The registry pledge each offering was created on; only that pledge can be released for it.
    mapping(uint256 => uint256) public pledgeOf;
    mapping(address => Eligibility) public eligibility;
    mapping(uint256 => mapping(address => Acceptance)) public acceptances;
    mapping(uint256 => Resolution) public resolutions;
    bool public intakeStopped = true;
    bool public activated;
    uint64 public screeningValidUntil;
    bytes32 public screeningEvidence;
    address private _screeningAttestor;

    event RoleSet(bytes32 indexed role, address indexed account, bool enabled);
    event TestAssetSet(address indexed asset, bool enabled);
    event IntakeStopped(bool stopped, bytes32 evidenceHash);
    event TermsCommitted(uint256 indexed poolId, bytes32 indexed termsHash, bytes32 policyHash, bytes32 disclosureHash);
    event ValuationAccepted(uint256 indexed poolId, address indexed valuer, uint256 netValue, uint32 coverageBps, uint64 validUntil);
    event EligibilitySet(address indexed wallet, bytes32 subjectHash, bytes32 evidenceHash, uint64 validUntil);
    event ScreeningRefreshed(uint64 validUntil, bytes32 evidenceHash);
    event TermsAccepted(uint256 indexed poolId, address indexed investor, bytes32 termsHash, uint256 quoteVersion, uint64 validUntil);
    event ResolutionNotified(uint256 indexed poolId, bytes32 evidenceHash, bytes32 distributionHash, uint256 expectedRecovery, uint64 noticeUntil);
    event ResolutionDisputed(uint256 indexed poolId, address indexed participant, bytes32 evidenceHash, bytes32 disputeId);
    event ResolutionVersioned(uint256 indexed poolId, bytes32 indexed resolutionId, uint64 hardDeadline);
    event ResolutionReviewed(uint256 indexed poolId, address indexed reviewer, bytes32 evidenceHash);
    event DisputeResolved(uint256 indexed poolId, bytes32 evidenceHash);
    event LifecycleExecuted(bytes4 indexed selector, uint256 indexed poolId, address indexed operator);

    modifier onlyGovernance() { require(msg.sender == governance, "not governance"); _; }
    modifier onlyRole(bytes32 role) { require(roles[role][msg.sender], "role required"); _; }

    constructor(address governance_, address registry_, address token_, address pool_) EIP712("AgentBL Rights", "4") {
        if (governance_.code.length == 0 || registry_.code.length == 0) revert InvalidSetup();
        if (RightsGovernance(governance_).delay() < 1 hours || RightsGovernance(governance_).memberCount() < 3
            || CommittedEBLRegistry(registry_).governance() != governance_) revert InvalidSetup();
        governance = governance_; registry = CommittedEBLRegistry(registry_);
        if (token_.code.length == 0 || pool_.code.length == 0) revert InvalidSetup();
        token = ControlledRWAToken(token_); pool = RWAOfferingPoolV5(pool_);
    }
    /// @dev The controller has runtime code only after its constructor returns.
    ///      Activation is one-time and permissionless, with no caller-selected values.
    function activate() external {
        require(!activated, "already activated"); activated = true;
        require(pool.nextPoolId() == 1 && pool.executorCount() == 0 && !pool.emergencyStopped()
            && address(pool.eblRegistry()) == address(registry) && address(pool.rwaToken()) == address(token)
            && token.pool() == address(pool), "capital binding invalid");
        pool.acceptOwnership();
        pool.setOracle(address(this));
        pool.enableCumulativeClaims();
        pool.setComplianceGate(address(this));
        pool.setAccessMode(RWAOfferingPoolV5.AccessMode.ComplianceGated);
    }
    function capitalPool() external view returns (address) { return address(pool); }
    function setRole(bytes32 role, address account, bool enabled) external onlyGovernance {
        require(account != address(0) && (role == ISSUER || role == VALUER || role == OPERATOR || role == ATTESTOR
            || role == COMPLIANCE || role == DISPOSER || role == REVIEWER || role == GUARDIAN), "invalid role");
        roles[role][account] = enabled;
        emit RoleSet(role, account, enabled);
    }
    function setTestAsset(address asset, bool enabled) external onlyGovernance {
        require(asset.code.length > 0, "asset missing"); testAsset[asset] = enabled;
        emit TestAssetSet(asset, enabled);
    }
    function setIntakeStopped(bool stopped, bytes32 evidenceHash) external {
        require(msg.sender == governance || (stopped && roles[GUARDIAN][msg.sender]), "not authorized");
        require(evidenceHash != bytes32(0), "evidence missing"); intakeStopped = stopped;
        emit IntakeStopped(stopped, evidenceHash);
    }
    function hashTerms(OfferingTerms calldata t) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(TERMS_TYPEHASH, t)));
    }
    function valuationDigest(Valuation calldata v) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VALUATION_TYPEHASH, v)));
    }
    function createControlledOffering(OfferingTerms calldata t, Valuation calldata v, address signer, bytes calldata signature)
        external onlyRole(ISSUER) returns (uint256 poolId) {
        require(activated && !intakeStopped && registry.controller() == address(this) && registry.isActive(t.eblId), "intake unavailable");
        bytes32 hash = hashTerms(t);
        // A pledge backs one offering: after that offering ends the holder consents again for the next one.
        uint256 pledge = registry.pledgeId(t.eblId);
        require(registry.pledgedTo(t.eblId) == address(pool) && registry.pledgeTerms(t.eblId) == hash
            && pledgeOf[latestPoolForEbl[t.eblId]] != pledge, "holder terms not approved");
        require(t.assetKey == registry.cargoHashOf(t.eblId) && t.documentHash == registry.metadataHashOf(t.eblId), "asset mismatch");
        require(testAsset[t.settlementAsset] && t.exporter != address(0) && t.feeRecipient != address(0), "invalid asset or recipient");
        require(t.policyHash != bytes32(0) && t.disclosureHash != bytes32(0), "policy missing");
        require(t.supply > 0 && t.supply <= 1e6 && t.issuePrice > 0 && t.issuePrice <= t.target && t.target <= 1e24, "economic bounds");
        require(t.maxFee == 0 && t.maturity <= block.timestamp + 366 days, "fee or maturity bounds");
        require(t.subscribeUntil < t.disburseUntil && t.disburseUntil < t.maturity, "draw deadline invalid");
        require(v.termsHash == hash && v.assetKey == t.assetKey && v.settlementAsset == t.settlementAsset, "valuation domain mismatch");
        require(roles[VALUER][signer] && signer != msg.sender && !usedValuationNonce[signer][v.nonce], "valuer unavailable");
        require(v.valuedAt <= block.timestamp && v.validUntil >= block.timestamp && v.validUntil <= v.valuedAt + 30 days, "valuation expired or future");
        require(v.netValue > 0 && v.netValue <= 1e42 && v.coverageBps >= 10_000 && v.coverageBps <= 50_000, "valuation bounds");
        require(Math.mulDiv(t.supply * t.target, v.coverageBps, 10_000, Math.Rounding.Ceil) <= v.netValue, "under collateralized");
        require(SignatureChecker.isValidSignatureNow(signer, valuationDigest(v), signature), "invalid valuation signature");
        usedValuationNonce[signer][v.nonce] = true;
        poolId = pool.createOfferingWithTerms(t.eblId, t.supply, t.issuePrice, t.target, t.maturity, t.subscribeUntil, t.settlementAsset, t.minRaise);
        pool.setDisbursementDeadline(poolId, t.disburseUntil);
        terms[poolId] = t; termsHash[poolId] = hash; valuations[poolId] = v; valuer[poolId] = signer;
        latestPoolForEbl[t.eblId] = poolId; pledgeOf[poolId] = pledge;
        emit TermsCommitted(poolId, hash, t.policyHash, t.disclosureHash);
        emit ValuationAccepted(poolId, signer, v.netValue, v.coverageBps, v.validUntil);
    }
    function setEligibility(address wallet, bytes32 subjectHash, bytes32 evidenceHash, uint64 validUntil) external onlyRole(COMPLIANCE) {
        require(wallet != address(0) && subjectHash != bytes32(0) && evidenceHash != bytes32(0), "identity missing");
        require(validUntil == 0 || (validUntil > block.timestamp && validUntil <= block.timestamp + 365 days), "invalid expiry");
        eligibility[wallet] = Eligibility(subjectHash, evidenceHash, msg.sender, validUntil);
        emit EligibilitySet(wallet, subjectHash, evidenceHash, validUntil);
    }
    function refreshScreening(uint64 validUntil, bytes32 evidenceHash) external onlyRole(COMPLIANCE) {
        require(validUntil >= block.timestamp && validUntil <= block.timestamp + 1 days && evidenceHash != bytes32(0), "invalid screening");
        screeningValidUntil = validUntil; screeningEvidence = evidenceHash;
        _screeningAttestor = msg.sender;
        emit ScreeningRefreshed(validUntil, evidenceHash);
    }
    function acknowledgeTerms(uint256 poolId, bytes32 hash, uint256 quote, uint64 validUntil) external {
        require(termsHash[poolId] != bytes32(0) && hash == termsHash[poolId] && quote == pool.quoteVersion(poolId), "terms changed");
        require(validUntil >= block.timestamp && validUntil <= pool.subscriptionDeadline(poolId), "invalid acceptance expiry");
        acceptances[poolId][msg.sender] = Acceptance(hash, quote, validUntil);
        emit TermsAccepted(poolId, msg.sender, hash, quote, validUntil);
    }
    function isEligible(address wallet, uint256 poolId) external view returns (bool) {
        OfferingTerms storage t = terms[poolId];
        Eligibility storage e = eligibility[wallet];
        Acceptance storage a = acceptances[poolId][wallet];
        return !intakeStopped && termsHash[poolId] != bytes32(0) && testAsset[t.settlementAsset]
            && screeningValidUntil >= block.timestamp && roles[COMPLIANCE][_screeningAttestor]
            && e.validUntil >= block.timestamp && roles[COMPLIANCE][e.attestor]
            && a.termsHash == termsHash[poolId] && a.validUntil >= block.timestamp && a.quoteVersion == pool.quoteVersion(poolId)
            && valuations[poolId].validUntil >= block.timestamp && roles[VALUER][valuer[poolId]] && registry.isActive(t.eblId);
    }
    function disburse(uint256 poolId, uint256 amount, bytes32 evidenceHash) external onlyRole(OPERATOR) {
        require(!intakeStopped && registry.isActive(terms[poolId].eblId), "intake unavailable");
        require(testAsset[terms[poolId].settlementAsset] && roles[VALUER][valuer[poolId]]
            && block.timestamp < valuations[poolId].validUntil && screeningValidUntil >= block.timestamp
            && roles[COMPLIANCE][_screeningAttestor], "draw sources unavailable");
        pool.disburseToExporter(poolId, amount, terms[poolId].exporter, evidenceHash);
    }
    /// @notice Typed allowlist: executors cannot mint, amend terms, redirect funds or replace controls.
    function executeLifecycle(bytes calldata data) external {
        if (data.length < 36) revert InvalidOperation();
        bytes4 selector = bytes4(data[:4]);
        uint256 poolId = abi.decode(data[4:36], (uint256));
        if (termsHash[poolId] == bytes32(0)) revert InvalidOperation();
        bool proof = selector == pool.recordImporterPayment.selector || selector == pool.correctImporterPayment.selector
            || selector == pool.recordAdditionalPayment.selector || selector == pool.recordLiquidationRecovery.selector
            || selector == pool.recordCargoArrival.selector;
        bool operation = selector == pool.markInTransit.selector || selector == pool.settle.selector
            || selector == pool.markDefault.selector || selector == pool.cancelOffering.selector;
        require((proof && roles[ATTESTOR][msg.sender]) || (operation && roles[OPERATOR][msg.sender])
            || (selector == pool.unfreezeOffering.selector && msg.sender == governance), "call not authorized");
        (bool ok, bytes memory result) = address(pool).call(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        emit LifecycleExecuted(selector, poolId, msg.sender);
    }
    /// @notice An operator may pause, freeze or resume. Before maturity only delayed governance may
    ///         start liquidation; an operator's emergency brake is FREEZE_POOL. The price is never
    ///         changed here: it is part of the terms the holder pledged and the valuer signed, so a
    ///         new price is a new offering on newly approved terms.
    function applyPricingAction(uint256 poolId, uint256, uint8 action, bytes32 evidenceHash, bytes32 quoteHash) external {
        require(roles[OPERATOR][msg.sender] || msg.sender == governance, "role required");
        if (termsHash[poolId] == bytes32(0) || action < 3 || action > 6) revert InvalidOperation();
        if (action == 5 && msg.sender != governance && block.timestamp < pool.maturityAt(poolId)) revert GovernanceRequired();
        pool.applyPricingAction(poolId, 0, action, evidenceHash, quoteHash);
    }
    function notifyResolution(uint256 poolId, bytes32 evidenceHash, bytes32 distributionHash, uint256 expectedRecovery) external onlyRole(DISPOSER) {
        require(evidenceHash != bytes32(0) && distributionHash != bytes32(0), "resolution missing");
        RWAOfferingPoolV5.OfferingState state = pool.stateOf(poolId);
        require(state == RWAOfferingPoolV5.OfferingState.Defaulted || state == RWAOfferingPoolV5.OfferingState.Liquidation, "not in resolution");
        require(resolutions[poolId].proposer == address(0), "resolution locked");
        require(expectedRecovery == _actualRecovery(poolId), "recovery mismatch");
        _notify(poolId, evidenceHash, distributionHash, expectedRecovery, msg.sender);
    }
    function _notify(uint256 poolId, bytes32 evidenceHash, bytes32 distributionHash, uint256 expectedRecovery, address proposer) internal {
        resolutions[poolId] = Resolution(evidenceHash, distributionHash, expectedRecovery, uint64(block.timestamp) + NOTICE_PERIOD,
            proposer, address(0), false, false, false, uint64(block.timestamp) + MAX_RESOLUTION_PERIOD);
        emit ResolutionNotified(poolId, evidenceHash, distributionHash, expectedRecovery, uint64(block.timestamp) + NOTICE_PERIOD);
        emit ResolutionVersioned(poolId, resolutionId(poolId), resolutions[poolId].hardDeadline);
    }
    function resolutionId(uint256 poolId) public view returns (bytes32) {
        Resolution storage r = resolutions[poolId];
        return keccak256(abi.encode(block.chainid, address(this), poolId, r.evidenceHash, r.distributionHash, r.expectedRecovery));
    }
    /// @notice Deterministic exits anyone may start if business operators are unavailable:
    ///         an offering nobody subscribed is cancelled once its window closes (unless frozen),
    ///         undisbursed principal or cash that already covers every claim closes as repaid,
    ///         and only a real shortfall after maturity becomes a default with a cash-only resolution.
    function startExit(uint256 poolId) external {
        require(termsHash[poolId] != bytes32(0), "offering missing");
        RWAOfferingPoolV5.OfferingState state = pool.stateOf(poolId);
        (,,,, uint256 subscribed,,,,,,,,) = pool.offerings(poolId);
        if (subscribed == 0) {
            require(block.timestamp > terms[poolId].subscribeUntil && state != RWAOfferingPoolV5.OfferingState.Frozen, "offering still open");
            pool.cancelOffering(poolId, keccak256(abi.encode(termsHash[poolId], "UNSUBSCRIBED_EXIT")));
            return;
        }
        if (pool.disbursedAtomic(poolId) == 0) { pool.closeUndisbursed(poolId); return; }
        if (state != RWAOfferingPoolV5.OfferingState.Liquidation && state != RWAOfferingPoolV5.OfferingState.Defaulted) {
            if (pool.outstandingDebt(poolId) == 0) { pool.closeUndisbursed(poolId); return; }
            require(block.timestamp >= terms[poolId].maturity, "not overdue");
            pool.markDefault(poolId);
        }
        require(resolutions[poolId].proposer == address(0), "resolution locked");
        bytes32 hash = keccak256(abi.encode(termsHash[poolId], "CASH_ONLY_EXIT"));
        _notify(poolId, hash, hash, _actualRecovery(poolId), address(this));
    }
    function disputeResolution(uint256 poolId, bytes32 evidenceHash) external {
        require(resolutions[poolId].proposer != address(0) && !resolutions[poolId].finalized && evidenceHash != bytes32(0), "no resolution");
        require(token.balanceOf(poolId, msg.sender) > 0 || msg.sender == registry.holderOf(terms[poolId].eblId) || roles[REVIEWER][msg.sender], "not participant");
        require(block.timestamp < resolutions[poolId].noticeUntil && !resolutions[poolId].disputeUsed, "dispute window closed");
        resolutions[poolId].disputeUsed = true;
        resolutions[poolId].disputed = true; resolutions[poolId].reviewer = address(0);
        emit ResolutionDisputed(poolId, msg.sender, evidenceHash, keccak256(abi.encode(resolutionId(poolId), msg.sender, evidenceHash)));
    }
    function resolveDispute(uint256 poolId, bytes32 evidenceHash) external onlyGovernance {
        require(resolutions[poolId].disputed && block.timestamp < resolutions[poolId].hardDeadline && evidenceHash != bytes32(0), "no dispute");
        resolutions[poolId].disputed = false;
        uint64 until = uint64(block.timestamp) + NOTICE_PERIOD;
        resolutions[poolId].noticeUntil = until < resolutions[poolId].hardDeadline ? until : resolutions[poolId].hardDeadline;
        emit DisputeResolved(poolId, evidenceHash);
    }
    function reviewResolution(uint256 poolId, bytes32 evidenceHash) external onlyRole(REVIEWER) {
        Resolution storage r = resolutions[poolId];
        require(r.proposer != address(0) && r.proposer != msg.sender && !r.finalized && !r.disputed && evidenceHash != bytes32(0), "review unavailable");
        r.reviewer = msg.sender;
        emit ResolutionReviewed(poolId, msg.sender, evidenceHash);
    }
    function finalizeResolution(uint256 poolId) external {
        Resolution storage r = resolutions[poolId];
        require(r.proposer != address(0) && !r.finalized && (block.timestamp >= r.hardDeadline
            || (roles[DISPOSER][r.proposer] && roles[REVIEWER][r.reviewer] && !r.disputed && block.timestamp >= r.noticeUntil)), "resolution not approved");
        r.finalized = true;
        bytes32 hash = keccak256(abi.encode(r.evidenceHash, r.distributionHash, r.expectedRecovery));
        pool.resolveLiquidation(poolId, hash);
    }
    function _actualRecovery(uint256 poolId) internal view returns (uint256) {
        (,,,,,,,,,, uint256 raised,,) = pool.offerings(poolId);
        return pool.recoveredAtomic(poolId) + raised - pool.disbursedAtomic(poolId);
    }
    /// @dev A retry by an earlier terminal pool cannot end a later pledge: the pledge being released
    ///      must be the one the latest offering was created on.
    function onCollateralReleased(uint256 eblId) external view returns (bool) {
        require(msg.sender == address(registry) && registry.pledgedTo(eblId) == address(pool), "not registry");
        uint256 poolId = latestPoolForEbl[eblId];
        require(poolId != 0 && pledgeOf[poolId] == registry.pledgeId(eblId), "offering missing");
        RWAOfferingPoolV5.OfferingState state = pool.stateOf(poolId);
        require(state == RWAOfferingPoolV5.OfferingState.Repaid || state == RWAOfferingPoolV5.OfferingState.Cancelled
            || (state == RWAOfferingPoolV5.OfferingState.LossSettled && resolutions[poolId].finalized), "release not approved");
        return state == RWAOfferingPoolV5.OfferingState.LossSettled;
    }
    /// @notice A holder may withdraw a pledge no offering was ever created on.
    function canWithdrawPledge(uint256 eblId, uint256 pledge) external view returns (bool) {
        return pool.poolOfEbl(eblId) == 0 && pledgeOf[latestPoolForEbl[eblId]] != pledge;
    }
    function clearRiskLock(uint256 eblId, bytes32 evidenceHash) external onlyGovernance {
        uint256 poolId = latestPoolForEbl[eblId];
        require(resolutions[poolId].finalized && token.totalSupply(poolId) == 0
            && pool.escrowed(poolId, terms[poolId].settlementAsset) == 0, "distribution incomplete");
        registry.clearRiskLock(eblId, evidenceHash);
    }
}
