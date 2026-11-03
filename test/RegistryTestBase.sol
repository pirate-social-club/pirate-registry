// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SLDRegistry} from "../src/SLDRegistry.sol";
import {RegistryFactory} from "../src/RegistryFactory.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

abstract contract RegistryTestBase is Test {
    uint256 internal constant PRICE = 5e6; // 5 USDC per year
    string internal constant TLD = "testtld";
    string internal constant LABEL = "studio";

    MockUSDC internal usdc;
    RegistryFactory internal factory;
    SLDRegistry internal registry;

    address internal operator = makeAddr("operator");
    address internal treasury = makeAddr("treasury");
    address internal holderA = makeAddr("holder-a");
    address internal holderB = makeAddr("holder-b");
    address internal payer = makeAddr("payer");
    address internal stranger = makeAddr("stranger");
    address internal manager = makeAddr("record-manager");

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        factory = new RegistryFactory(address(usdc));
        registry = SLDRegistry(factory.deployRegistry(TLD, operator, treasury, PRICE));
        _fund(holderA);
        _fund(holderB);
        _fund(payer);
        _fund(stranger);
    }

    function _fund(address account) internal {
        usdc.mint(account, 1_000e6);
        vm.prank(account);
        usdc.approve(address(registry), type(uint256).max);
    }

    function _register(address buyer, string memory label, uint8 years_, address recipient)
        internal
        returns (uint256 tokenId)
    {
        vm.prank(buyer);
        tokenId = registry.register(label, years_, recipient, type(uint256).max, block.timestamp);
    }

    function _register(address buyer, string memory label) internal returns (uint256) {
        return _register(buyer, label, 1, buyer);
    }

    function _renew(address buyer, uint256 tokenId, uint8 years_) internal {
        vm.prank(buyer);
        registry.renew(tokenId, years_, type(uint256).max, block.timestamp);
    }

    function _notActive(uint256 tokenId) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SLDRegistry.NotActive.selector, tokenId);
    }
}
