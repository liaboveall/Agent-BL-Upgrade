// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Local test fixture for isolated capital-layer tests. Production uses CommittedEBLRegistry.
contract MockCapitalRegistry {
    uint256 public nextEblId = 1;
    mapping(uint256 => address) public holderOf;
    mapping(uint256 => address) public pledgedTo;
    bool public failRelease;
    function setFailRelease(bool value) external { failRelease = value; }
    function mintEBL(bytes32, address holder) external {
        require(holder != address(0), "holder missing");
        holderOf[nextEblId++] = holder;
    }
    function pledge(uint256 id, address pool) external {
        require(holderOf[id] == msg.sender && pledgedTo[id] == address(0), "invalid pledge");
        pledgedTo[id] = pool;
    }
    function releasePledge(uint256 id) external {
        require(pledgedTo[id] == msg.sender && !failRelease, "not pledged pool");
        pledgedTo[id] = address(0);
    }
}
