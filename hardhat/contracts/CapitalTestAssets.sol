// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockUSDC} from "./MockUSDC.sol";

/// @dev Adversarial assets used only by the local W2 regression suite.
contract CallbackUSDC is MockUSDC {
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackOnSend;
    bool public callbackSucceeded;
    bytes public callbackResult;
    function configure(address target, bytes calldata data, bool onSend) external {
        callbackTarget = target;
        callbackData = data;
        callbackOnSend = onSend;
    }
    function _callback() internal {
        if (callbackTarget != address(0)) {
            (callbackSucceeded, callbackResult) = callbackTarget.call(callbackData);
        }
    }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (!callbackOnSend) _callback();
        return super.transferFrom(from, to, amount);
    }
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (callbackOnSend) _callback();
        return super.transfer(to, amount);
    }
}

contract TaxUSDC is MockUSDC {
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0) && amount > 0) {
            super._update(from, address(0), 1);
            super._update(from, to, amount - 1);
        } else super._update(from, to, amount);
    }
}

contract NoReturnUSDC {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external { allowance[msg.sender][spender] = amount; }
    function transfer(address to, uint256 amount) external { _transfer(msg.sender, to, amount); }
    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
    }
    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount; balanceOf[to] += amount;
    }
}

contract EighteenDecimalAsset { function decimals() external pure returns (uint8) { return 18; } }

contract FailingShares {
    function mint(uint256, address, uint256) external pure { revert("mint failed"); }
    function burn(uint256, address, uint256) external pure { revert("burn failed"); }
    function balanceOf(uint256, address) external pure returns (uint256) { return 0; }
    function totalSupply(uint256) external pure returns (uint256) { return 0; }
}

contract SwitchableUSDC is MockUSDC {
    bool public returnFalse;
    mapping(address => bool) public blocked;
    function setReturnFalse(bool value) external { returnFalse = value; }
    function setBlocked(address recipient, bool value) external { blocked[recipient] = value; }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (returnFalse) return false;
        return super.transferFrom(from, to, amount);
    }
    function transfer(address to, uint256 amount) public override returns (bool) {
        require(!blocked[to], "recipient blocked");
        return super.transfer(to, amount);
    }
}
