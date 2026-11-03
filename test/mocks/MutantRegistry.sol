// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {SLDRegistry} from "../../src/SLDRegistry.sol";

/// @notice Deliberately broken registry used only to prove the invariant
/// handler detects a missing lifecycle guard: transfers skip the Active check
/// (and the record-manager reset) by calling OpenZeppelin's `_update` directly.
contract MutantRegistryNoTransferGuard is SLDRegistry {
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        return ERC721Upgradeable._update(to, tokenId, auth);
    }
}
