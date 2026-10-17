// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Owned} from "./Owned.sol";

contract RWATokenV5 is Owned {
    address public pool;
    mapping(uint256 => mapping(address => uint256)) private _balances;
    mapping(uint256 => uint256) private _totalSupply;

    event RWAMinted(uint256 indexed poolId, address indexed investor, uint256 amount);
    event RWABurned(uint256 indexed poolId, address indexed investor, uint256 amount);
    event PoolSet(address indexed pool);

    function setPool(address pool_) external onlyOwner {
        require(pool_ != address(0), "pool=0");
        pool = pool_;
        emit PoolSet(pool_);
    }

    function mint(uint256 poolId, address investor, uint256 amount) external {
        require(msg.sender == pool, "only pool");
        require(investor != address(0), "investor=0");
        require(amount > 0, "amount=0");
        _balances[poolId][investor] += amount;
        _totalSupply[poolId] += amount;
        emit RWAMinted(poolId, investor, amount);
    }

    function burn(uint256 poolId, address investor, uint256 amount) external {
        require(msg.sender == pool, "only pool");
        require(amount > 0, "amount=0");
        require(_balances[poolId][investor] >= amount, "insufficient shares");
        _balances[poolId][investor] -= amount;
        _totalSupply[poolId] -= amount;
        emit RWABurned(poolId, investor, amount);
    }

    function balanceOf(uint256 poolId, address investor) external view returns (uint256) {
        return _balances[poolId][investor];
    }

    function totalSupply(uint256 poolId) external view returns (uint256) {
        return _totalSupply[poolId];
    }
}
