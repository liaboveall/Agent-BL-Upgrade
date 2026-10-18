// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Non-transferable whole shares. The minter is bound exactly once, for life.
contract ControlledRWAToken {
    address private immutable _initializer = msg.sender;
    address public pool;
    mapping(uint256 => mapping(address => uint256)) private _balances;
    mapping(uint256 => uint256) private _supply;
    event PoolBound(address indexed pool);
    event RWAMinted(uint256 indexed poolId, address indexed investor, uint256 amount);
    event RWABurned(uint256 indexed poolId, address indexed investor, uint256 amount);
    function bindPool(address account) external {
        require(msg.sender == _initializer && pool == address(0) && account.code.length > 0, "pool binding locked");
        pool = account;
        emit PoolBound(account);
    }
    function mint(uint256 poolId, address investor, uint256 amount) external {
        require(msg.sender == pool && investor != address(0) && amount > 0, "invalid mint");
        _balances[poolId][investor] += amount;
        _supply[poolId] += amount;
        emit RWAMinted(poolId, investor, amount);
    }
    function burn(uint256 poolId, address investor, uint256 amount) external {
        require(msg.sender == pool && amount > 0 && _balances[poolId][investor] >= amount, "invalid burn");
        _balances[poolId][investor] -= amount;
        _supply[poolId] -= amount;
        emit RWABurned(poolId, investor, amount);
    }
    function balanceOf(uint256 poolId, address investor) external view returns (uint256) { return _balances[poolId][investor]; }
    function totalSupply(uint256 poolId) external view returns (uint256) { return _supply[poolId]; }
}
