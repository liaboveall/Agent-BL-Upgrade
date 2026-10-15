// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./Owned.sol";

/// @notice Append-only commitments to off-chain terminal decisions. No control over trade assets.
contract AgentDecisionLog is Owned {
    struct AgentVersion {
        bytes32 policyHash;
        bytes32 codeCommit;
        string modelId;
        uint256 registeredAt;
    }
    struct Batch {
        bytes32 merkleRoot;
        uint256 fromSeq;
        uint256 toSeq;
        uint256 count;
        bytes32 versionId;
        address anchorer;
        uint256 anchoredAt;
    }

    mapping(bytes32 => AgentVersion) public versions;
    mapping(address => bool) public anchorers;
    mapping(uint256 => Batch) public batches;
    uint256 public batchCount;
    uint256 public lastSeq;

    event AgentVersionRegistered(bytes32 indexed versionId, bytes32 policyHash, bytes32 codeCommit, string modelId);
    event AnchorerSet(address indexed anchorer, bool allowed);
    event DecisionBatchAnchored(uint256 indexed batchId, bytes32 indexed merkleRoot,
        uint256 fromSeq, uint256 toSeq, uint256 count, bytes32 indexed versionId, address anchorer);

    function registerAgentVersion(bytes32 versionId, bytes32 policyHash, bytes32 codeCommit, string calldata modelId) external onlyOwner {
        require(versionId != bytes32(0) && policyHash != bytes32(0) && codeCommit != bytes32(0), "empty commitment");
        require(bytes(modelId).length > 0 && bytes(modelId).length <= 128, "invalid model");
        require(versions[versionId].registeredAt == 0, "version exists");
        versions[versionId] = AgentVersion(policyHash, codeCommit, modelId, block.timestamp);
        emit AgentVersionRegistered(versionId, policyHash, codeCommit, modelId);
    }

    function setAnchorer(address anchorer, bool allowed) external onlyOwner {
        require(anchorer != address(0), "anchorer=0");
        anchorers[anchorer] = allowed;
        emit AnchorerSet(anchorer, allowed);
    }

    function anchorBatch(bytes32 merkleRoot, uint256 fromSeq, uint256 toSeq, uint256 count, bytes32 versionId) external {
        require(anchorers[msg.sender], "not anchorer");
        require(versions[versionId].registeredAt != 0, "unknown version");
        require(merkleRoot != bytes32(0), "empty root");
        require(fromSeq == lastSeq + 1, "sequence gap");
        require(toSeq >= fromSeq && count == toSeq - fromSeq + 1 && count <= 256, "invalid range");
        uint256 batchId = ++batchCount;
        batches[batchId] = Batch(merkleRoot, fromSeq, toSeq, count, versionId, msg.sender, block.timestamp);
        lastSeq = toSeq;
        emit DecisionBatchAnchored(batchId, merkleRoot, fromSeq, toSeq, count, versionId, msg.sender);
    }

    /// @dev Sorted-pair Keccak tree; odd nodes are promoted, leaves use a separate domain.
    function verifyInclusion(uint256 batchId, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        if (batchId == 0 || batchId > batchCount || proof.length > 8) return false;
        bytes32 computed = leaf;
        for (uint256 i; i < proof.length; ++i) {
            computed = computed < proof[i]
                ? keccak256(abi.encodePacked(computed, proof[i]))
                : keccak256(abi.encodePacked(proof[i], computed));
        }
        return computed == batches[batchId].merkleRoot;
    }
}
