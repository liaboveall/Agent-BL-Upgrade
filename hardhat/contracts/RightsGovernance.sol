// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Two distinct members approve the exact call, then a visible delay starts.
///         Cancelling an approved call takes two members as well, so one member cannot veto the
///         others; a proposal still short of its second approval can be withdrawn by its approver.
///         Rotation invalidates every queued operation from the former membership epoch.
contract RightsGovernance is ReentrancyGuard {
    struct Operation { address target; bytes32 dataHash; uint64 eta; uint64 epoch; uint8 approvals; bool done; }
    mapping(address => bool) public member;
    mapping(bytes32 => Operation) public operations;
    mapping(bytes32 => mapping(address => bool)) public approved;
    mapping(bytes32 => mapping(address => bool)) public cancelVoted;
    mapping(bytes32 => uint8) public cancelVotes;
    uint256 public memberCount;
    uint64 public epoch = 1;
    uint64 public immutable delay;
    uint64 public constant GRACE = 7 days;

    event Proposed(bytes32 indexed id, address indexed target, bytes32 dataHash, uint64 epoch);
    event Approved(bytes32 indexed id, address indexed member, uint64 eta);
    event Executed(bytes32 indexed id);
    event Cancelled(bytes32 indexed id);
    event CancelVoted(bytes32 indexed id, address indexed member);
    event MemberChanged(address indexed member, bool enabled, uint64 epoch);

    constructor(address[] memory members, uint64 delay_) {
        require(delay_ >= 1 hours, "delay too short");
        delay = delay_;
        for (uint256 i; i < members.length; ++i) {
            require(members[i] != address(0) && !member[members[i]], "invalid member");
            member[members[i]] = true;
        }
        require(members.length >= 3, "need three members");
        memberCount = members.length;
    }

    function propose(address target, bytes calldata data, bytes32 salt) external returns (bytes32 id) {
        require(member[msg.sender] && target.code.length > 0 && data.length >= 4, "invalid proposal");
        id = keccak256(abi.encode(block.chainid, address(this), epoch, target, keccak256(data), salt));
        require(operations[id].target == address(0), "already proposed");
        operations[id] = Operation(target, keccak256(data), 0, epoch, 1, false);
        approved[id][msg.sender] = true;
        emit Proposed(id, target, keccak256(data), epoch);
        emit Approved(id, msg.sender, 0);
    }

    function approve(bytes32 id) external {
        Operation storage op = operations[id];
        require(member[msg.sender] && op.target != address(0) && op.epoch == epoch && !op.done, "invalid operation");
        require(!approved[id][msg.sender] && op.approvals < 2, "already approved");
        approved[id][msg.sender] = true;
        op.approvals++;
        op.eta = uint64(block.timestamp) + delay;
        emit Approved(id, msg.sender, op.eta);
    }

    function cancel(bytes32 id) external {
        Operation storage op = operations[id];
        require(member[msg.sender] && op.target != address(0) && op.epoch == epoch && !op.done && !cancelVoted[id][msg.sender], "cannot cancel");
        cancelVoted[id][msg.sender] = true;
        emit CancelVoted(id, msg.sender);
        if (++cancelVotes[id] < 2 && !(op.approvals < 2 && approved[id][msg.sender])) return;
        op.done = true;
        emit Cancelled(id);
    }

    function execute(bytes32 id, bytes calldata data) external nonReentrant returns (bytes memory result) {
        Operation storage op = operations[id];
        require(op.epoch == epoch && op.approvals == 2 && !op.done, "not approved");
        require(block.timestamp >= op.eta && block.timestamp <= op.eta + GRACE, "outside execution window");
        require(keccak256(data) == op.dataHash, "payload changed");
        op.done = true;
        bool ok;
        (ok, result) = op.target.call(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        emit Executed(id);
    }

    function setMember(address account, bool enabled) external {
        require(msg.sender == address(this), "only governance");
        require(account != address(0) && member[account] != enabled, "invalid member");
        memberCount = enabled ? memberCount + 1 : memberCount - 1;
        require(memberCount >= 3, "need three members");
        member[account] = enabled;
        epoch++;
        emit MemberChanged(account, enabled, epoch);
    }
}
