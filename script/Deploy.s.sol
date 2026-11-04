// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {RegistryFactory} from "../src/RegistryFactory.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";
import {PirateTestUSD} from "./testnet/PirateTestUSD.sol";

/// @notice Pinned payment token per chain (SPEC section 6.7). The registry's
/// chain is MegaETH testnet (6343), paid in the clearly named, valueless
/// PirateTestUSD; the mainnet chain and asset are not chosen. Local anvil
/// (31337) gets a mock. Base and Base Sepolia are no longer supported.
library PaymentTokens {
    uint256 internal constant MEGAETH_TESTNET_CHAIN_ID = 6343;
    /// Pinned after `DeployTestToken`; zero until then.
    address internal constant MEGAETH_TESTNET = address(0);

    function forChain(uint256 chainId) internal pure returns (address) {
        if (chainId == MEGAETH_TESTNET_CHAIN_ID) return MEGAETH_TESTNET;
        return address(0);
    }
}

/// forge script script/Deploy.s.sol:DeployTestToken --rpc-url <url> --broadcast --skip-simulation <signer flags>
/// MegaETH testnet only. Pin the printed address in PaymentTokens before
/// deploying the factory.
contract DeployTestToken is Script {
    function run() external returns (PirateTestUSD token) {
        require(block.chainid == PaymentTokens.MEGAETH_TESTNET_CHAIN_ID, "DeployTestToken: MegaETH testnet only");
        vm.startBroadcast();
        token = new PirateTestUSD();
        vm.stopBroadcast();
        console.log("paymentToken", address(token));
    }
}

/// forge script script/Deploy.s.sol:DeployFactory --rpc-url <url> --broadcast --skip-simulation <signer flags>
/// On MegaETH, `--skip-simulation` takes gas estimates from the RPC; local
/// EVM estimates do not include MegaETH storage gas.
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
