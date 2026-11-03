// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {SLDRegistry} from "../../src/SLDRegistry.sol";

/// @notice A contract with no ERC-721 receiver hook.
contract NonReceiver {}

/// @notice Receiver that probes the registry from inside `onERC721Received`.
contract ProbingReceiver is IERC721Receiver {
    bytes4 private constant REENTRANT = bytes4(keccak256("ReentrancyGuardReentrantCall()"));

    SLDRegistry public immutable registry;
    address public immutable sink;

    bool public stateInitialized;
    bool public registerBlocked;
    bool public renewBlocked;
    bool public sweepBlocked;
    bool public setRecordSucceeded;
    bool public transferSucceeded;

    constructor(SLDRegistry registry_, address sink_) {
        registry = registry_;
        sink = sink_;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        stateInitialized = registry.status(tokenId) == SLDRegistry.Status.Active
            && registry.expiresAt(tokenId) > block.timestamp && registry.effectiveOwner(tokenId) == address(this);

        try registry.register("reenter", 1, address(this), type(uint256).max, block.timestamp) {}
        catch (bytes memory reason) {
            registerBlocked = bytes4(reason) == REENTRANT;
        }
        try registry.renew(tokenId, 1, type(uint256).max, block.timestamp) {}
        catch (bytes memory reason) {
            renewBlocked = bytes4(reason) == REENTRANT;
        }
        try registry.sweep() {}
        catch (bytes memory reason) {
            sweepBlocked = bytes4(reason) == REENTRANT;
        }
        try registry.setRecord(tokenId, bytes32(uint256(1)), hex"01") {
            setRecordSucceeded = true;
        } catch {}
        if (sink != address(0)) {
            try registry.transferFrom(address(this), sink, tokenId) {
                transferSucceeded = true;
            } catch {}
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}
