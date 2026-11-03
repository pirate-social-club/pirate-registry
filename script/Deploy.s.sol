// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {RegistryFactory} from "../src/RegistryFactory.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @notice Native USDC per chain (SPEC section 6.7), checked against Circle's
/// published list on 2026-11-03. Local anvil (31337) gets a mock.
library PaymentTokens {
    address internal constant BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function forChain(uint256 chainId) internal pure returns (address) {
        if (chainId == 8453) return BASE;
        if (chainId == 84532) return BASE_SEPOLIA;
        return address(0);
    }
}

/// forge script script/Deploy.s.sol:DeployFactory --rpc-url <url> --broadcast <signer flags>
contract DeployFactory is Script {
    function run() external returns (RegistryFactory factory, address paymentToken) {
        paymentToken = PaymentTokens.forChain(block.chainid);
        vm.startBroadcast();
        if (paymentToken == address(0)) {
            require(block.chainid == 31337, "DeployFactory: no pinned payment token for this chain");
            paymentToken = address(new MockUSDC());
        }
        factory = new RegistryFactory(paymentToken);
        vm.stopBroadcast();

        console.log("chainId", block.chainid);
        console.log("paymentToken", paymentToken);
        console.log("factory", address(factory));
        console.log("implementation", factory.implementation());
        console.log("implementationCodeHash");
        console.logBytes32(factory.implementation().codehash);
        console.log("factoryCodeHash");
        console.logBytes32(address(factory).codehash);
    }
}

/// forge script script/Deploy.s.sol:DeployRegistry --sig "run(address,string,address,address,uint256)" \
///   <factory> <tld> <admin> <treasury> <annualPrice> --rpc-url <url> --broadcast <signer flags>
contract DeployRegistry is Script {
    function run(address factory, string calldata tld, address admin, address treasury, uint256 annualPrice)
        external
        returns (address registry)
    {
        vm.startBroadcast();
        registry = RegistryFactory(factory).deployRegistry(tld, admin, treasury, annualPrice);
        vm.stopBroadcast();

        console.log("registry", registry);
        console.log("delegation record (publish on the TLD in Bob):");
        console.log(string.concat(vm.toLowercase(vm.toString(registry)), ".", vm.toString(block.chainid), "._evm."));
    }
}
