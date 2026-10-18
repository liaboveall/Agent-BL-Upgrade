// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Test-only ERC-1271 signer; never used by deployment manifests.
contract RightsTestSigner {
    address public immutable signer;
    bool public enabled = true;
    constructor(address account) { signer = account; }
    function setEnabled(bool value) external { require(msg.sender == signer); enabled = value; }
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(hash, signature);
        return enabled && error == ECDSA.RecoverError.NoError && recovered == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
