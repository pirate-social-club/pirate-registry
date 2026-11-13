// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {Test} from "forge-std/Test.sol";
import {SharedNameKeys} from "../../src/SharedNameKeys.sol";

contract SharedKeyProbe {
    function namespace(string calldata tld) external pure returns (bytes32) { return SharedNameKeys.namespaceIdFor(tld); }
    function name(bytes32 ns, string calldata label) external pure returns (bytes32) { return SharedNameKeys.nameKeyFor(ns, label); }
    function token(bytes32 key, uint64 gen) external pure returns (uint256) { return SharedNameKeys.tokenIdFor(key, gen); }
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
