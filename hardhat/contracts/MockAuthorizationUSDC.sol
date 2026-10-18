// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Isolated test token for W4. It is never added to a production asset allowlist.
contract MockAuthorizationUSDC is ERC20, EIP712 {
    bytes32 private constant TYPEHASH = keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    constructor() ERC20("USDC", "TEST_USDC") EIP712("USDC", "2") {}
    function version() external pure returns (string memory) { return "2"; }
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 value) external { _mint(to, value); }
    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "invalid window");
        require(!authorizationState[from][nonce], "authorization used");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(TYPEHASH, from, to, value, validAfter, validBefore, nonce)));
        require(from != address(0) && ECDSA.recover(digest, v, r, s) == from, "invalid signer");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }
}
