// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {Test} from "forge-std/Test.sol";
import {SharedNameKeys} from "../../src/SharedNameKeys.sol";

contract SharedKeyProbe {
    function namespace(string calldata tld) external pure returns (bytes32) {
        return SharedNameKeys.namespaceIdFor(tld);
    }

    function name(bytes32 ns, string calldata label) external pure returns (bytes32) {
        return SharedNameKeys.nameKeyFor(ns, label);
    }

    function token(bytes32 key, uint64 gen) external pure returns (uint256) {
        return SharedNameKeys.tokenIdFor(key, gen);
    }
}

contract SharedNameKeysTest is Test {
    SharedKeyProbe private probe = new SharedKeyProbe();

    function testNamespacesAndGenerationsAreIndependent() public view {
        bytes32 first = probe.namespace("testtld");
        bytes32 second = probe.namespace("othertld");
        bytes32 name = probe.name(first, "member001");
        assertNotEq(name, probe.name(second, "member001"));
        assertNotEq(probe.token(name, 1), probe.token(name, 2));
        assertEq(first, keccak256(abi.encode(keccak256("pirate.namespace/1"), keccak256("testtld"))));
        assertEq(name, keccak256(abi.encode(keccak256("pirate.name/1"), first, keccak256("member001"))));
        assertEq(
            probe.token(name, 1), uint256(keccak256(abi.encode(keccak256("pirate.name-token/1"), name, uint64(1))))
        );
    }

    function _assertLiteralVector(
        string memory tld,
        string memory label,
        uint64 generation,
        bytes32 namespaceId,
        bytes32 nameKey,
        uint256 tokenId
    ) private view {
        assertEq(probe.namespace(tld), namespaceId);
        assertEq(probe.name(namespaceId, label), nameKey);
        assertEq(probe.token(nameKey, generation), tokenId);
    }

    // BEGIN ALLOCATED IDENTITY VECTORS
    function testAllocatedLiteralIdentityVectors() public view {
        _assertLiteralVector(
            "testtld",
            "member001",
            1,
            0x171a7715833c41caa33d3304096ea3f330e94e2b58eac1b29fc2fee99dd14f3d,
            0x6d73822225a283039c5509f97306783e3479a0e37a5044f5cb52038f8b160856,
            95165702007452585980891729623512171902651103434603173062025220274514321273488
        );
        _assertLiteralVector(
            "othertld",
            "member001",
            1,
            0xad1ddae470c5a78c4606195fc22c2052fc09d7e2961c8be5d63c353df8bfad9f,
            0x17c1a7656712aeca2b7313821b02344431c180a32094aeb82e5984413fda1bb3,
            106965765079036890316365061902104356189341292721360854213475389451124177547303
        );
        _assertLiteralVector(
            "testtld",
            "member001",
            2,
            0x171a7715833c41caa33d3304096ea3f330e94e2b58eac1b29fc2fee99dd14f3d,
            0x6d73822225a283039c5509f97306783e3479a0e37a5044f5cb52038f8b160856,
            108434146224625834091005199361104751209326105825392306275063521700134099266268
        );
    }

    // END ALLOCATED IDENTITY VECTORS

    function testRejectsTrailingLineTerminators() public {
        bytes[4] memory suffixes = [bytes(hex"0a"), bytes(hex"0d0a"), bytes(hex"e280a8"), bytes(hex"e280a9")];
        for (uint256 i; i < suffixes.length; ++i) {
            vm.expectRevert(SharedNameKeys.NonCanonicalLabel.selector);
            probe.namespace(string(bytes.concat(bytes("testtld"), suffixes[i])));
            vm.expectRevert(SharedNameKeys.NonCanonicalLabel.selector);
            probe.name(bytes32(uint256(1)), string(bytes.concat(bytes("member001"), suffixes[i])));
        }
    }

    function testRejectsNonCanonicalLabelsAndZeroIdentities() public {
        string[8] memory invalid = ["Testtld", "testtld.", "xn--name", "ab--cd", "-name", "name-", "", "two.parts"];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(SharedNameKeys.NonCanonicalLabel.selector);
            probe.namespace(invalid[i]);
        }
        vm.expectRevert(SharedNameKeys.InvalidIdentity.selector);
        probe.name(bytes32(0), "member001");
        vm.expectRevert(SharedNameKeys.InvalidIdentity.selector);
        probe.token(bytes32(uint256(1)), 0);
    }

    function testFuzzGenerationChangesToken(uint64 generation) public view {
        if (generation == 0 || generation == type(uint64).max) return;
        bytes32 key = probe.name(probe.namespace("testtld"), "member001");
        assertNotEq(probe.token(key, generation), probe.token(key, generation + 1));
    }
}
