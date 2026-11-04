// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet-only payment token for pirate-registry rehearsals: six
/// decimals, open minting up to a per-call cap, no pause and no blacklist.
/// It has no value and deploys only on MegaETH testnet or local anvil.
contract PirateTestUSD is ERC20 {
    uint256 public constant MAX_MINT = 10_000e6;

    error UnsupportedChain(uint256 chainId);
    error MintCapExceeded(uint256 amount);

    constructor() ERC20("Pirate Registry Test USD (testnet, no value)", "ptUSD") {
        if (block.chainid != 6343 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintCapExceeded(amount);
        _mint(to, amount);
    }
}
