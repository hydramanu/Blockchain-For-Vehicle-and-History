// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract VehicleHistoryAnchor {
    error UnauthorizedWriter();
    error InvalidLink();

    address public immutable writer;
    uint256 public count;
    bytes32 public head;
    mapping(uint256 => bytes32) public anchors;

    event RecordAnchored(uint256 indexed index, bytes32 indexed digest, bytes32 previousHash);

    constructor(address authorizedWriter) {
        writer = authorizedWriter;
    }

    function anchorRecord(uint256 index, bytes32 digest, bytes32 previousHash) external {
        if (msg.sender != writer) revert UnauthorizedWriter();
        if (index != count || previousHash != head || digest == bytes32(0)) revert InvalidLink();

        anchors[index] = digest;
        head = digest;
        count = index + 1;
        emit RecordAnchored(index, digest, previousHash);
    }
}
