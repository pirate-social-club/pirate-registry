// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {SLDRegistry} from "./SLDRegistry.sol";

/// @title RegistryFactory
/// @notice Ownerless factory. Deploys EIP-1167 clones of one fixed
/// implementation and initializes each in the same call. It keeps no list of
/// official registries per TLD: deploying confers no authority.
contract RegistryFactory {
    address public immutable implementation;
    address public immutable paymentToken;

    mapping(address registry => bool) public isRegistry;

    event RegistryDeployed(address indexed registry, string tld, address indexed admin, address indexed deployer);

    error ZeroAddress();

    constructor(address paymentToken_) {
        if (paymentToken_ == address(0)) revert ZeroAddress();
        paymentToken = paymentToken_;
        implementation = address(new SLDRegistry());
    }

    function deployRegistry(string calldata tld, address admin, address treasury, uint256 annualPrice)
        external
        returns (address registry)
    {
        registry = Clones.clone(implementation);
        SLDRegistry(registry).initialize(tld, paymentToken, admin, treasury, annualPrice);
        isRegistry[registry] = true;
        emit RegistryDeployed(registry, tld, admin, msg.sender);
    }
}
