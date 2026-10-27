// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {AssetIdentityHub} from "./AssetIdentityHub.sol";

interface IRightsReleasePolicy {
    function onCollateralReleased(uint256 eblId) external returns (bool riskLocked);
    function capitalPool() external view returns (address);
    function canWithdrawPledge(uint256 eblId, bytes32 termsHash) external view returns (bool);
}

/// @notice No commercial document fields or public document URLs are accepted on chain.
contract CommittedEBLRegistry is EIP712 {
    struct Title {
        bytes32 assetKey;
        bytes32 documentHash;
        bytes32 issuerOrg;
        address issuer;
        address holder;
        uint64 revision;
        bool surrendered;
        bool riskLocked;
    }
    struct Issuance {
        bytes32 assetKey;
        bytes32 documentHash;
        bytes32 issuerOrg;
        address holder;
        uint64 revision;
        bytes32 previousHash;
        uint64 validUntil;
        uint256 nonce;
    }
    bytes32 public constant ISSUE_TYPEHASH = keccak256("Issuance(bytes32 assetKey,bytes32 documentHash,bytes32 issuerOrg,address holder,uint64 revision,bytes32 previousHash,uint64 validUntil,uint256 nonce)");
    bytes32 public constant PLEDGE_TYPEHASH = keccak256("Pledge(uint256 eblId,address pool,bytes32 termsHash,uint256 nonce,uint64 validUntil)");
    address public immutable governance;
    AssetIdentityHub public immutable hub;
    address public controller;
    uint256 public nextEblId = 1;
    mapping(uint256 => Title) public titles;
    mapping(bytes32 => address) public issuerForOrg;
    mapping(bytes32 => uint256) public eblForAsset;
    mapping(address => mapping(uint256 => bool)) public usedNonce;
    mapping(uint256 => uint256) public holderNonce;
    mapping(uint256 => address) public pledgedTo;
    mapping(uint256 => bytes32) public pledgeTerms;
    mapping(uint256 => bool) public invalidated;
    mapping(bytes32 => mapping(address => bool)) public revokedIssuer;

    event IssuerSet(bytes32 indexed organization, address indexed issuer);
    event IssuerRevoked(bytes32 indexed organization, address indexed issuer, bytes32 evidenceHash);
    event ControllerBound(address indexed controller);
    event TitleRegistered(uint256 indexed eblId, bytes32 indexed assetKey, bytes32 documentHash, address holder, uint64 revision);
    event TitleAmended(uint256 indexed eblId, bytes32 previousHash, bytes32 documentHash, uint64 revision);
    event TitleEndorsed(uint256 indexed eblId, address indexed from, address indexed to, bytes32 evidenceHash);
    event TitleSurrendered(uint256 indexed eblId, bytes32 evidenceHash);
    event TitleInvalidated(uint256 indexed eblId, bytes32 evidenceHash);
    event EBLPledged(uint256 indexed eblId, address indexed pool, address indexed holder);
    event EBLPledgeReleased(uint256 indexed eblId, address indexed pool, address indexed holder);
    event RiskLockChanged(uint256 indexed eblId, bool locked, bytes32 evidenceHash);

    constructor(address governance_, address hub_) EIP712("AgentBL Title", "1") {
        require(governance_.code.length > 0 && hub_.code.length > 0, "dependencies missing");
        governance = governance_; hub = AssetIdentityHub(hub_);
    }
    /// @notice Rotation: the new signer issues from now on; titles signed by earlier keys stay active.
    function setIssuer(bytes32 organization, address signer) external {
        require(msg.sender == governance && organization != bytes32(0), "not governance");
        require(!revokedIssuer[organization][signer], "issuer revoked");
        issuerForOrg[organization] = signer;
        emit IssuerSet(organization, signer);
    }
    /// @notice Revocation: every title this key signed for the organization becomes inactive, permanently.
    function revokeIssuer(bytes32 organization, address signer, bytes32 evidenceHash) external {
        require(msg.sender == governance && signer != address(0) && evidenceHash != bytes32(0), "not governance");
        require(!revokedIssuer[organization][signer], "issuer revoked");
        revokedIssuer[organization][signer] = true;
        if (issuerForOrg[organization] == signer) {
            issuerForOrg[organization] = address(0);
            emit IssuerSet(organization, address(0));
        }
        emit IssuerRevoked(organization, signer, evidenceHash);
    }
    function bindController(address account) external {
        require(msg.sender == governance && controller == address(0) && account.code.length > 0, "controller binding locked");
        controller = account;
        emit ControllerBound(account);
    }
    function issuanceDigest(Issuance calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ISSUE_TYPEHASH, a)));
    }
    function _verify(Issuance calldata a, bytes calldata signature) internal returns (address signer) {
        signer = issuerForOrg[a.issuerOrg];
        require(signer != address(0) && a.assetKey != bytes32(0) && a.documentHash != bytes32(0)
            && a.holder != address(0) && a.validUntil >= block.timestamp, "invalid issuance");
        require(!usedNonce[signer][a.nonce] && SignatureChecker.isValidSignatureNow(signer, issuanceDigest(a), signature), "invalid issuer signature");
        usedNonce[signer][a.nonce] = true;
    }
    function registerTitle(Issuance calldata a, bytes calldata signature) external returns (uint256 eblId) {
        address signer = _verify(a, signature);
        require(a.revision == 1 && a.previousHash == bytes32(0), "invalid initial revision");
        hub.reserve(a.assetKey);
        eblId = nextEblId++;
        titles[eblId] = Title(a.assetKey, a.documentHash, a.issuerOrg, signer, a.holder, 1, false, false);
        eblForAsset[a.assetKey] = eblId;
        emit TitleRegistered(eblId, a.assetKey, a.documentHash, a.holder, 1);
    }
    function amendTitle(uint256 eblId, Issuance calldata a, bytes calldata issuerSignature, bytes calldata holderSignature) external {
        Title storage t = titles[eblId];
        require(!t.surrendered && !t.riskLocked && !invalidated[eblId] && pledgedTo[eblId] == address(0), "title locked");
        require(a.assetKey == t.assetKey && a.issuerOrg == t.issuerOrg && a.holder == t.holder
            && a.revision == t.revision + 1 && a.previousHash == t.documentHash, "revision mismatch");
        require(SignatureChecker.isValidSignatureNow(t.holder, issuanceDigest(a), holderSignature), "holder consent missing");
        t.issuer = _verify(a, issuerSignature);
        t.documentHash = a.documentHash; t.revision = a.revision;
        holderNonce[eblId]++;
        emit TitleAmended(eblId, a.previousHash, a.documentHash, a.revision);
    }
    function endorse(uint256 eblId, address to, bytes32 evidenceHash) external {
        Title storage t = titles[eblId];
        require(msg.sender == t.holder && to != address(0) && to != msg.sender && evidenceHash != bytes32(0), "invalid endorsement");
        require(!t.surrendered && !t.riskLocked && !invalidated[eblId] && pledgedTo[eblId] == address(0), "title locked");
        t.holder = to; holderNonce[eblId]++;
        emit TitleEndorsed(eblId, msg.sender, to, evidenceHash);
    }
    function surrender(uint256 eblId, bytes32 evidenceHash) external {
        Title storage t = titles[eblId];
        require(msg.sender == t.holder && evidenceHash != bytes32(0) && !t.surrendered && !t.riskLocked && !invalidated[eblId] && pledgedTo[eblId] == address(0), "title locked");
        t.surrendered = true; holderNonce[eblId]++;
        emit TitleSurrendered(eblId, evidenceHash);
    }
    function pledgeDigest(uint256 eblId, address pool, bytes32 termsHash, uint64 validUntil) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(PLEDGE_TYPEHASH, eblId, pool, termsHash, holderNonce[eblId], validUntil)));
    }
    function invalidateTitle(uint256 eblId, bytes32 evidenceHash) external {
        Title storage t = titles[eblId];
        require(t.holder != address(0) && (msg.sender == governance || msg.sender == issuerForOrg[t.issuerOrg])
            && evidenceHash != bytes32(0) && !invalidated[eblId], "not issuer or already invalidated");
        invalidated[eblId] = true; holderNonce[eblId]++;
        emit TitleInvalidated(eblId, evidenceHash);
    }
    function pledge(uint256 eblId, address pool, bytes32 termsHash, uint64 validUntil, bytes calldata signature) external {
        Title storage t = titles[eblId];
        require(isActive(eblId) && !t.riskLocked && pledgedTo[eblId] == address(0), "title locked");
        require(controller != address(0) && pool == IRightsReleasePolicy(controller).capitalPool()
            && termsHash != bytes32(0) && validUntil >= block.timestamp, "invalid pledge");
        require(msg.sender == t.holder || SignatureChecker.isValidSignatureNow(t.holder, pledgeDigest(eblId, pool, termsHash, validUntil), signature), "holder consent missing");
        holderNonce[eblId]++;
        pledgedTo[eblId] = pool; pledgeTerms[eblId] = termsHash;
        emit EBLPledged(eblId, pool, t.holder);
    }
    function withdrawUnopenedPledge(uint256 eblId) external {
        require(msg.sender == titles[eblId].holder && pledgedTo[eblId] != address(0), "not holder or pledged");
        require(IRightsReleasePolicy(controller).canWithdrawPledge(eblId, pledgeTerms[eblId]), "offering exists");
        address pool = pledgedTo[eblId];
        delete pledgedTo[eblId]; delete pledgeTerms[eblId]; holderNonce[eblId]++;
        emit EBLPledgeReleased(eblId, pool, msg.sender);
    }
    function releasePledge(uint256 eblId) external {
        require(msg.sender == pledgedTo[eblId] && controller != address(0), "not pledgee");
        bool locked = IRightsReleasePolicy(controller).onCollateralReleased(eblId);
        pledgedTo[eblId] = address(0); delete pledgeTerms[eblId];
        titles[eblId].riskLocked = locked;
        emit EBLPledgeReleased(eblId, msg.sender, titles[eblId].holder);
        if (locked) emit RiskLockChanged(eblId, true, bytes32(0));
    }
    function clearRiskLock(uint256 eblId, bytes32 evidenceHash) external {
        require(msg.sender == controller && evidenceHash != bytes32(0) && titles[eblId].riskLocked, "not controller or locked");
        titles[eblId].riskLocked = false;
        emit RiskLockChanged(eblId, false, evidenceHash);
    }
    function isActive(uint256 eblId) public view returns (bool) {
        Title storage t = titles[eblId];
        return t.holder != address(0) && !t.surrendered && !invalidated[eblId] && !revokedIssuer[t.issuerOrg][t.issuer] && hub.registry(address(this));
    }
    function holderOf(uint256 eblId) external view returns (address) { return titles[eblId].holder; }
    function cargoHashOf(uint256 eblId) external view returns (bytes32) { return titles[eblId].assetKey; }
    function metadataHashOf(uint256 eblId) external view returns (bytes32) { return titles[eblId].documentHash; }
}
