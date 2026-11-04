// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SLDRegistry} from "../src/SLDRegistry.sol";
import {RegistryFactory} from "../src/RegistryFactory.sol";
import {RecordKeys} from "../src/RecordKeys.sol";
import {RegistryTestBase} from "./RegistryTestBase.sol";
import {NonReceiver, ProbingReceiver} from "./mocks/Receivers.sol";

contract FactoryTest is RegistryTestBase {
    function test_DeployedRegistryIsInitializedClone() public view {
        assertTrue(factory.isRegistry(address(registry)));
        assertEq(registry.factory(), address(factory));
        assertEq(registry.paymentToken(), address(usdc));
        assertEq(registry.tld(), TLD);
        assertEq(registry.admin(), operator);
        assertEq(registry.treasury(), treasury);
        uint256[] memory prices = registry.lengthPrices();
        assertEq(prices.length, 1);
        assertEq(prices[0], PRICE);
        assertEq(registry.PROTOCOL_VERSION(), 2);
        assertEq(registry.name(), ".testtld");

        // Exact EIP-1167 runtime pointing at the factory's implementation.
        bytes memory expected =
            abi.encodePacked(hex"363d3d373d3d3d363d73", factory.implementation(), hex"5af43d82803e903d91602b57fd5bf3");
        assertEq(address(registry).code, expected);
    }

    function test_InitializeIsSingleUse() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        registry.initialize(TLD, address(usdc), stranger, stranger, 0);

        SLDRegistry implementation = SLDRegistry(factory.implementation());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        implementation.initialize(TLD, address(usdc), stranger, stranger, 0);
    }

    function test_FactoryRejectsBadConfiguration() public {
        vm.expectRevert(SLDRegistry.InvalidLabel.selector);
        factory.deployRegistry("Bad_TLD", operator, treasury, PRICE);
        vm.expectRevert(SLDRegistry.ZeroAddress.selector);
        factory.deployRegistry("ok", address(0), treasury, PRICE);
        vm.expectRevert(SLDRegistry.InvalidTreasury.selector);
        factory.deployRegistry("ok", operator, address(0), PRICE);
        vm.expectRevert(RegistryFactory.ZeroAddress.selector);
        new RegistryFactory(address(0));
    }

    function test_SameTldMayHaveManyRegistries() public {
        address second = factory.deployRegistry(TLD, stranger, stranger, 1);
        assertTrue(second != address(registry));
        assertTrue(factory.isRegistry(second));
        assertEq(SLDRegistry(second).tld(), TLD);
    }

    // ------------------------------------------------------------------
    // Receiver callbacks (SPEC 6.6, 10)
    // ------------------------------------------------------------------

    function test_ReentrancyFromReceiverIsBlockedAndStateIsInitialized() public {
        address sink = makeAddr("sink");
        ProbingReceiver receiver = new ProbingReceiver(registry, sink);
        uint256 tokenId = _register(holderA, LABEL, 1, address(receiver));

        assertTrue(receiver.stateInitialized());
        assertTrue(receiver.registerBlocked());
        assertTrue(receiver.renewBlocked());
        assertTrue(receiver.sweepBlocked());
        assertTrue(receiver.setRecordSucceeded());
        assertTrue(receiver.transferSucceeded());
        assertEq(registry.ownerOf(tokenId), sink);
        assertTrue(registry.available("reenter"));
        assertEq(usdc.balanceOf(address(registry)), PRICE);
    }

    function test_NonReceiverContractRevertsWholePurchase() public {
        NonReceiver target = new NonReceiver();
        uint256 before = usdc.balanceOf(holderA);
        vm.prank(holderA);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(target)));
        registry.register(LABEL, 1, address(target), type(uint256).max, block.timestamp);
        assertEq(usdc.balanceOf(holderA), before);
        assertTrue(registry.available(LABEL));
    }

    // ------------------------------------------------------------------
    // Encoding vectors (SPEC 6.9), computed independently with viem.
    // ------------------------------------------------------------------

    function test_EncodingVectors() public view {
        bytes32 labelhash = keccak256(bytes("studio"));
        assertEq(labelhash, 0xdd292fbefea3905e7bcdbbf6b1b71e43455ffc2baf812c3f209b907c2002b33f);
        assertEq(registry.tokenIdFor(labelhash, 1), 0x4275474407e1edb473bf05f2c2b128427959989ca62308b76b8fea2e16e1dc79);
        assertEq(registry.tokenIdFor(labelhash, 2), 0x696caabed877cd84b076736f07be1903028a162cca18ce89a79bd3b2894417fe);
        assertEq(RecordKeys.dns("", 1), 0x868407eceda9379178752546a3cbf720eec2a28dd24895d6472c1c3e5a789f2d);
        assertEq(RecordKeys.dns("www", 1), 0x3d0a36e80e3d0fd5cacdea6ed18096458be8598eabead84e9be8e161a4040cea);
        assertEq(RecordKeys.dns("", 28), 0x2aaebcdd820b403c0bdeab8581b7bb7748995d4af0e62bb44a652699bb42f0d8);
        assertEq(RecordKeys.dns("", 16), 0x8e349ea58a59204bb26cde0b4dbfcfff1733d3f5bf6b2c8a60fd843c8573e0ef);
        assertEq(RecordKeys.addr(60), 0x16883e5e203b40982d5268a3d2640cd0f5e76abee54a43d0960297260cfd7d06);
        assertEq(RecordKeys.text("url"), 0x42eb28c344b8fb7b73f411db72dd268d347114a8ab737b15344b7378069e5cf6);
        assertEq(RecordKeys.contenthash(), 0xf2b1a06537f8716332f700b7ec22ba2b412a859bc77c6a2d36acf68a3cab1e0f);
    }
}
