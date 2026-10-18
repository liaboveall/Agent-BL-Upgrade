// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Shared reservation domain for explicitly enrolled research registries.
///         Reservations survive amendments, surrender and loss. This is not global title proof.
contract AssetIdentityHub {
    address public immutable governance;
    mapping(address => bool) public registry;
    mapping(bytes32 => address) public reservedBy;
    mapping(bytes32 => bytes32) public legacyEvidence;
    event RegistryEnabled(address indexed registry, bool enabled);
    event AssetReserved(bytes32 indexed assetKey, address indexed registry);
    event LegacyReserved(bytes32 indexed assetKey, bytes32 evidenceHash);

    constructor(address governance_) { require(governance_.code.length > 0, "governance missing"); governance = governance_; }
    function setRegistry(address account, bool enabled) external {
        require(msg.sender == governance && account.code.length > 0, "not governance or registry");
        registry[account] = enabled;
        emit RegistryEnabled(account, enabled);
    }
    function reserve(bytes32 assetKey) external {
        require(registry[msg.sender] && assetKey != bytes32(0), "not registry");
        require(reservedBy[assetKey] == address(0), "asset already reserved");
        reservedBy[assetKey] = msg.sender;
        emit AssetReserved(assetKey, msg.sender);
    }
    function reserveLegacy(bytes32 assetKey, bytes32 evidenceHash) external {
        require(msg.sender == governance && assetKey != bytes32(0) && evidenceHash != bytes32(0), "invalid legacy reservation");
        require(reservedBy[assetKey] == address(0), "asset already reserved");
        reservedBy[assetKey] = address(this);
        legacyEvidence[assetKey] = evidenceHash;
        emit LegacyReserved(assetKey, evidenceHash);
    }
}
