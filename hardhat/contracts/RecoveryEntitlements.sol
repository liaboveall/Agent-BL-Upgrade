// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Permanent, non-transferable rights to every subsequent cash distribution.
/// @dev Created by the capital pool. No administrator, transfer or deletion path.
contract RecoveryEntitlements {
    error Unauthorized();
    error LotLimit();
    address public immutable pool = msg.sender;
    /// @notice Separate subscription segments one investor may hold in one pool; disclosed at issuance.
    uint256 public constant MAX_LOTS = 32;
    struct Lot { uint128 start; uint128 shares; }
    mapping(uint256 => mapping(address => Lot[])) private _lots;

    function record(uint256 id, address investor, uint256 start, uint256 shares) external {
        if (msg.sender != pool) revert Unauthorized();
        if (start + shares > 1e6) revert LotLimit();
        Lot[] storage lots = _lots[id][investor];
        if (lots.length > 0 && uint256(lots[lots.length - 1].start) + lots[lots.length - 1].shares == start) {
            lots[lots.length - 1].shares += uint128(shares);
        } else {
            if (lots.length >= MAX_LOTS) revert LotLimit();
            lots.push(Lot(uint128(start), uint128(shares)));
        }
    }
    function lotCount(uint256 id, address investor) external view returns (uint256) { return _lots[id][investor].length; }
    function entitlement(uint256 id, address investor, uint256 cash, uint256 supply) external view returns (uint256 amount) {
        if (supply == 0) return 0;
        uint256 quotient = cash / supply;
        uint256 remainder = cash % supply;
        Lot[] storage lots = _lots[id][investor];
        for (uint256 i; i < lots.length; i++) {
            Lot storage lot = lots[i];
            amount += quotient * lot.shares;
            if (remainder > lot.start) {
                uint256 extra = remainder - lot.start;
                amount += extra < lot.shares ? extra : lot.shares;
            }
        }
    }
}
