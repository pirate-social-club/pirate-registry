// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SLDRegistry} from "../src/SLDRegistry.sol";
import {RecordKeys} from "../src/RecordKeys.sol";
import {RegistryTestBase} from "./RegistryTestBase.sol";

/// SPEC section 6.2 sale policy: length tiers, premium prices and
/// reservations, ported from the model of HNS.ID's DefaultRegistrationStrategy.
contract SalePolicyTest is RegistryTestBase {
    uint256 internal constant NFS = type(uint256).max;

    function _one(string memory label) internal pure returns (string[] memory labels) {
        labels = new string[](1);
        labels[0] = label;
    }

    function _oneUint(uint256 value) internal pure returns (uint256[] memory values) {
        values = new uint256[](1);
        values[0] = value;
    }

    function _oneAddress(address value) internal pure returns (address[] memory values) {
        values = new address[](1);
        values[0] = value;
    }

    /// Lengths 1 to 7 closed, 8 and longer at `price`: the current app's
    /// open sale band.
    function _eightPlus(uint256 price) internal pure returns (uint256[] memory prices) {
        prices = new uint256[](8);
        for (uint256 i; i < 7; ++i) {
            prices[i] = NFS;
        }
        prices[7] = price;
    }

    function _setTable(uint256[] memory prices) internal {
        vm.prank(operator);
        registry.setLengthPrices(prices);
    }

    function _setPremium(string memory label, uint256 price) internal {
        vm.prank(operator);
        registry.setPremiumPrices(_one(label), _oneUint(price));
    }

    function _reserve(string memory label, address claimant) internal {
        vm.prank(operator);
        registry.setReservations(_one(label), _oneAddress(claimant));
    }

    // ------------------------------------------------------------------
    // Length tiers
    // ------------------------------------------------------------------

    function test_InitialTableIsOneFlatPrice() public view {
        assertEq(registry.priceOf("a"), PRICE);
        assertEq(registry.priceOf("a-sixty-three-character-label-is-still-priced-by-the-last-tier"), PRICE);
    }

    function test_TiersPriceByLengthAndLastTierCoversLongerLabels() public {
        uint256[] memory prices = new uint256[](3);
        prices[0] = 100e6;
        prices[1] = 50e6;
        prices[2] = 20e6;
        _setTable(prices);

        assertEq(registry.priceOf("a"), 100e6);
        assertEq(registry.priceOf("ab"), 50e6);
        assertEq(registry.priceOf("abc"), 20e6);
        assertEq(registry.priceOf("abcdefgh"), 20e6);

        uint256 before = usdc.balanceOf(holderA);
        uint256 tokenId = _register(holderA, "ab", 2, holderA);
        assertEq(registry.lockedPrice(tokenId), 50e6);
        assertEq(before - usdc.balanceOf(holderA), 100e6);
    }

    function test_EightCharacterMinimumClosesShorterLabels() public {
        _setTable(_eightPlus(PRICE));

        vm.prank(holderA);
        vm.expectRevert(SLDRegistry.NotForSale.selector);
        registry.register("seven77", 1, holderA, type(uint256).max, block.timestamp);
        assertEq(registry.priceOf("seven77"), NFS);

        uint256 tokenId = _register(holderA, "eightchr", 1, holderA);
        assertEq(registry.lockedPrice(tokenId), PRICE);
        _register(holderB, "a-sixty-three-character-label-is-still-priced-by-the-last-tier");
    }

    function test_SetLengthPricesValidation() public {
        vm.startPrank(operator);
        vm.expectRevert(SLDRegistry.InvalidPrices.selector);
        registry.setLengthPrices(new uint256[](0));
        vm.expectRevert(SLDRegistry.InvalidPrices.selector);
        registry.setLengthPrices(new uint256[](11));

        uint256[] memory rising = new uint256[](2);
        rising[0] = 1;
        rising[1] = 2;
        vm.expectRevert(SLDRegistry.InvalidPrices.selector);
        registry.setLengthPrices(rising);

        uint256[] memory ten = new uint256[](10);
        for (uint256 i; i < 10; ++i) {
            ten[i] = 10 - i;
        }
        registry.setLengthPrices(ten);
        vm.stopPrank();

        uint256[] memory stored = registry.lengthPrices();
        assertEq(stored.length, 10);
        assertEq(stored[9], 1);
        assertEq(registry.priceOf("eleven-char"), 1);
    }

    function test_SetPriceReplacesTheTableWithOneTier() public {
        _setTable(_eightPlus(PRICE));
        vm.prank(operator);
        registry.setPrice(7e6);
        uint256[] memory stored = registry.lengthPrices();
        assertEq(stored.length, 1);
        assertEq(registry.priceOf("a"), 7e6);
    }

    function test_ClosedRegistryStillRenewsTransfersAndEditsRecords() public {
        uint256 tokenId = _register(holderA, LABEL);
        vm.prank(operator);
        registry.setPrice(NFS);

        vm.prank(holderB);
        vm.expectRevert(SLDRegistry.NotForSale.selector);
        registry.register("other", 1, holderB, type(uint256).max, block.timestamp);

        _renew(payer, tokenId, 1);
        vm.startPrank(holderA);
        registry.setRecord(tokenId, RecordKeys.text("url"), hex"01");
        registry.transferFrom(holderA, holderB, tokenId);
        vm.stopPrank();
        assertEq(registry.ownerOf(tokenId), holderB);
    }

    function testFuzz_TierLookup(uint8 lengthSeed, uint8 tiersSeed, uint64 base) public {
        uint256 tiers = bound(tiersSeed, 1, 10);
        uint256 length = bound(lengthSeed, 1, 63);
        uint256[] memory prices = new uint256[](tiers);
        for (uint256 i; i < tiers; ++i) {
            prices[i] = uint256(base) + (tiers - i);
        }
        _setTable(prices);
        bytes memory label = new bytes(length);
        for (uint256 i; i < length; ++i) {
            label[i] = "a";
        }
        uint256 expected = prices[length < tiers ? length - 1 : tiers - 1];
        assertEq(registry.priceOf(string(label)), expected);
    }

    // ------------------------------------------------------------------
    // Premium prices
    // ------------------------------------------------------------------

    function test_PremiumOpensAClosedLabelAndOverridesItsTier() public {
        _setTable(_eightPlus(PRICE));
        _setPremium("ceo", 100e6);
        assertEq(registry.priceOf("ceo"), 100e6);

        uint256 before = usdc.balanceOf(holderA);
        uint256 tokenId = _register(holderA, "ceo", 1, holderA);
        assertEq(registry.lockedPrice(tokenId), 100e6);
        assertEq(before - usdc.balanceOf(holderA), 100e6);

        _setPremium("brandname", 30e6);
        assertEq(registry.priceOf("brandname"), 30e6);
    }

    function test_PremiumZeroIsFreeAndNotForSaleClosesALongLabel() public {
        _setTable(_eightPlus(PRICE));
        _setPremium("dao", 0);
        uint256 tokenId = _register(holderA, "dao", 1, holderA);
        assertEq(registry.lockedPrice(tokenId), 0);

        _setPremium("official-support", NFS);
        vm.prank(holderB);
        vm.expectRevert(SLDRegistry.NotForSale.selector);
        registry.register("official-support", 1, holderB, type(uint256).max, block.timestamp);
    }

    function test_ClearPremiumRestoresTheTier() public {
        _setPremium("studio", 1);
        (bool set, uint256 price) = registry.premiumPriceOf("studio");
        assertTrue(set);
        assertEq(price, 1);

        vm.prank(operator);
        registry.clearPremiumPrices(_one("studio"));
        (set, price) = registry.premiumPriceOf("studio");
        assertFalse(set);
        assertEq(price, 0);
        assertEq(registry.priceOf("studio"), PRICE);
    }

    // ------------------------------------------------------------------
    // Reservations
    // ------------------------------------------------------------------

    function test_ReservedLabelGoesOnlyToItsClaimantButAnyoneMayPay() public {
        _reserve("ceo", holderB);
        assertEq(registry.reservedFor("ceo"), holderB);
        assertTrue(registry.available("ceo"));

        vm.prank(holderA);
        vm.expectRevert(abi.encodeWithSelector(SLDRegistry.Reserved.selector, holderB));
        registry.register("ceo", 1, holderA, type(uint256).max, block.timestamp);

        uint256 before = usdc.balanceOf(payer);
        uint256 tokenId = _register(payer, "ceo", 1, holderB);
        assertEq(registry.ownerOf(tokenId), holderB);
        assertEq(before - usdc.balanceOf(payer), PRICE);
    }

    function test_ReservedShortLabelNeedsAPrice() public {
        _setTable(_eightPlus(PRICE));
        _reserve("ceo", holderB);
        vm.prank(holderB);
        vm.expectRevert(SLDRegistry.NotForSale.selector);
        registry.register("ceo", 1, holderB, type(uint256).max, block.timestamp);

        _setPremium("ceo", 0);
        uint256 tokenId = _register(holderB, "ceo", 1, holderB);
        assertEq(registry.lockedPrice(tokenId), 0);
    }

    function test_ReservationNeverAffectsTheCurrentNameOnlyTheNextRegistration() public {
        uint256 tokenId = _register(holderA, LABEL);
        _reserve(LABEL, holderB);

        _renew(holderA, tokenId, 1);
        vm.prank(holderA);
        registry.setRecord(tokenId, RecordKeys.text("url"), hex"01");

        vm.warp(registry.expiresAt(tokenId) + 1 days); // Grace
        _renew(payer, tokenId, 1);
        assertEq(uint8(registry.status(tokenId)), uint8(SLDRegistry.Status.Active));

        vm.warp(registry.expiresAt(tokenId) + registry.GRACE()); // Released
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SLDRegistry.Reserved.selector, holderB));
        registry.register(LABEL, 1, stranger, type(uint256).max, block.timestamp);
        uint256 next = _register(holderB, LABEL, 1, holderB);
        assertEq(registry.generationOf(next), 2);

        _reserve(LABEL, address(0));
        assertEq(registry.reservedFor(LABEL), address(0));
    }

    // ------------------------------------------------------------------
    // Existing names are outside policy (D2)
    // ------------------------------------------------------------------

    function test_PolicyChangesNeverTouchAnExistingGeneration() public {
        uint256 tokenId = _register(holderA, LABEL, 2, holderA);
        uint64 expiry = registry.expiresAt(tokenId);

        _setTable(_eightPlus(90e6));
        _setPremium(LABEL, 1_000e6);
        _reserve(LABEL, holderB);

        assertEq(registry.lockedPrice(tokenId), PRICE);
        assertEq(registry.expiresAt(tokenId), expiry);
        assertEq(registry.ownerOf(tokenId), holderA);

        uint256 before = usdc.balanceOf(holderA);
        _renew(holderA, tokenId, 1);
        assertEq(before - usdc.balanceOf(holderA), PRICE);
    }

    // ------------------------------------------------------------------
    // Access, input checks and events
    // ------------------------------------------------------------------

    function test_PolicySettersRejectNonAdmin() public {
        vm.startPrank(stranger);
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.setLengthPrices(_oneUint(1));
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.setPremiumPrices(_one("a"), _oneUint(1));
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.clearPremiumPrices(_one("a"));
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.setReservations(_one("a"), _oneAddress(stranger));
        vm.stopPrank();
    }

    function test_PolicySettersRejectBadInput() public {
        vm.startPrank(operator);
        vm.expectRevert(SLDRegistry.LengthMismatch.selector);
        registry.setPremiumPrices(_one("a"), new uint256[](2));
        vm.expectRevert(SLDRegistry.LengthMismatch.selector);
        registry.setReservations(_one("a"), new address[](0));
        vm.expectRevert(SLDRegistry.InvalidLabel.selector);
        registry.setPremiumPrices(_one("Bad"), _oneUint(1));
        vm.expectRevert(SLDRegistry.InvalidLabel.selector);
        registry.clearPremiumPrices(_one("-x"));
        vm.expectRevert(SLDRegistry.InvalidLabel.selector);
        registry.setReservations(_one("xn--abc"), _oneAddress(holderA));
        vm.stopPrank();

        vm.expectRevert(SLDRegistry.InvalidLabel.selector);
        registry.priceOf("UPPER");
    }

    function test_PolicyEvents() public {
        uint256[] memory prices = _eightPlus(PRICE);
        vm.expectEmit(address(registry));
        emit SLDRegistry.LengthPricesChanged(prices);
        _setTable(prices);

        vm.expectEmit(address(registry));
        emit SLDRegistry.PremiumPriceSet(keccak256("ceo"), "ceo", 9);
        _setPremium("ceo", 9);

        vm.expectEmit(address(registry));
        emit SLDRegistry.PremiumPriceCleared(keccak256("ceo"), "ceo");
        vm.prank(operator);
        registry.clearPremiumPrices(_one("ceo"));

        vm.expectEmit(address(registry));
        emit SLDRegistry.ReservationSet(keccak256("ceo"), "ceo", holderB);
        _reserve("ceo", holderB);
    }
}
