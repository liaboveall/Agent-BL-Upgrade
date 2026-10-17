// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Owned} from "./Owned.sol";

interface IRWAOfferingPoolActions {
    function applyPricingAction(
        uint256 poolId,
        uint256 newIssuePrice,
        uint8 action,
        bytes32 evidenceHash,
        bytes32 quoteHash
    ) external;

    function quoteVersion(uint256 poolId) external view returns (uint256);
}

/// @title RiskPricingOracle (WEB3-4 / WEB3-7 / WEB3-9)
/// @notice Records AI pricing + risk signals on-chain and forwards the action to the pool.
/// @dev Aligns with docs/contracts.md §6. evidence/quote hashes are persisted and emitted.
contract RiskPricingOracle is Owned {
    uint8 public constant MAX_RISK_LEVEL = 3; // 0 LOW / 1 MEDIUM / 2 WARNING / 3 CRITICAL

    IRWAOfferingPoolActions public pool;

    /// @notice Upper bound on how far ahead a quote may claim to be valid. A far-future quote
    ///         could otherwise be replayed after newer decisions.
    uint256 public constant MAX_QUOTE_VALIDITY = 30 days;

    mapping(address => bool) private _updaters;
    mapping(uint256 => bytes32) private _latestQuoteHash;
    mapping(uint256 => bytes32) private _latestEvidenceHash;
    mapping(bytes32 => bool) private _processedDecision;
    mapping(uint256 => uint256) private _lastDecisionSeq;
    mapping(uint256 => uint256) private _latestQuoteVersion;

    event PricingUpdated(
        uint256 indexed poolId,
        uint256 issuePrice,
        uint8 riskLevel,
        uint8 action,
        bytes32 evidenceHash,
        bytes32 quoteHash,
        address indexed updater
    );
    /// @notice Emitted alongside PricingUpdated so consumers can audit ordering and freshness.
    event PricingDecision(
        uint256 indexed poolId,
        uint256 expectedQuoteVersion,
        uint256 resultingQuoteVersion,
        uint256 decisionSeq,
        uint256 validUntil
    );
    event UpdaterSet(address indexed updater, bool allowed);

    constructor(address pool_) {
        require(pool_ != address(0), "pool=0");
        pool = IRWAOfferingPoolActions(pool_);
        _updaters[msg.sender] = true;
        emit UpdaterSet(msg.sender, true);
    }

    function setUpdater(address updater, bool allowed) external onlyOwner {
        require(updater != address(0), "updater=0");
        _updaters[updater] = allowed;
        emit UpdaterSet(updater, allowed);
    }

    /// @dev The owner is an updater from deployment; that role moves with ownership.
    function _afterOwnershipTransferred(address previousOwner, address newOwner) internal override {
        if (_updaters[previousOwner]) {
            _updaters[previousOwner] = false;
            emit UpdaterSet(previousOwner, false);
        }
        _updaters[newOwner] = true;
        emit UpdaterSet(newOwner, true);
    }

    function isUpdater(address updater) external view returns (bool) {
        return _updaters[updater];
    }

    /// @notice Push an AI pricing/risk result with the preconditions the updater saw (A07).
    /// @param expectedQuoteVersion pool quote version the decision was priced against
    /// @param validUntil last instant at which this quote may be applied
    /// @param decisionSeq strictly increasing per pool; blocks replayed or reordered quotes
    function updatePricing(
        uint256 poolId,
        uint256 issuePrice,
        uint8 riskLevel,
        uint8 action,
        bytes32 evidenceHash,
        bytes32 quoteHash,
        uint256 expectedQuoteVersion,
        uint256 validUntil,
        uint256 decisionSeq
    ) external {
        require(_updaters[msg.sender], "not updater");
        require(issuePrice > 0, "issuePrice=0");
        require(riskLevel <= MAX_RISK_LEVEL, "riskLevel>3");
        require(evidenceHash != bytes32(0), "evidenceHash=0");
        require(quoteHash != bytes32(0), "quoteHash=0");
        require(validUntil >= block.timestamp, "quote expired");
        require(validUntil <= block.timestamp + MAX_QUOTE_VALIDITY, "quote validity too long");

        // Bind the decision to this oracle, pool and ordering so it cannot be replayed on
        // another deployment or after a newer decision (A07).
        bytes32 decisionId = keccak256(abi.encode(
            block.chainid, address(this), poolId, issuePrice, action, evidenceHash, quoteHash,
            expectedQuoteVersion, decisionSeq
        ));
        require(!_processedDecision[decisionId], "decision replay");
        require(decisionSeq > _lastDecisionSeq[poolId], "quote out of order");
        uint256 currentVersion = pool.quoteVersion(poolId);
        require(expectedQuoteVersion == currentVersion, "quote version changed");

        _processedDecision[decisionId] = true;
        _lastDecisionSeq[poolId] = decisionSeq;

        _latestQuoteHash[poolId] = quoteHash;
        _latestEvidenceHash[poolId] = evidenceHash;

        pool.applyPricingAction(poolId, issuePrice, action, evidenceHash, quoteHash);
        uint256 resultingVersion = pool.quoteVersion(poolId);
        _latestQuoteVersion[poolId] = resultingVersion;

        emit PricingUpdated(poolId, issuePrice, riskLevel, action, evidenceHash, quoteHash, msg.sender);
        emit PricingDecision(poolId, expectedQuoteVersion, resultingVersion, decisionSeq, validUntil);
    }

    function latestQuoteHash(uint256 poolId) external view returns (bytes32) {
        return _latestQuoteHash[poolId];
    }

    function latestEvidenceHash(uint256 poolId) external view returns (bytes32) {
        return _latestEvidenceHash[poolId];
    }

    function lastDecisionSeq(uint256 poolId) external view returns (uint256) {
        return _lastDecisionSeq[poolId];
    }

    function latestQuoteVersion(uint256 poolId) external view returns (uint256) {
        return _latestQuoteVersion[poolId];
    }

    function isDecisionProcessed(bytes32 decisionId) external view returns (bool) {
        return _processedDecision[decisionId];
    }
}
