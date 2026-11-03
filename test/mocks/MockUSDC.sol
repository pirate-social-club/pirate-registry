// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test stand-in for Circle's FiatToken: 6 decimals, a global pause,
/// and a blacklist checked against the caller, the sender and the recipient,
/// matching FiatTokenV1 `transferFrom` and `transfer`.
contract MockUSDC is ERC20 {
    mapping(address account => bool) public blacklisted;
    bool public paused;

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlacklisted(address account, bool value) external {
        blacklisted[account] = value;
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        require(!blacklisted[msg.sender], "Blacklistable: account is blacklisted");
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        require(!blacklisted[msg.sender], "Blacklistable: account is blacklisted");
        return super.transferFrom(from, to, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!paused, "Pausable: paused");
        require(!blacklisted[from] && !blacklisted[to], "Blacklistable: account is blacklisted");
        super._update(from, to, value);
    }
}
