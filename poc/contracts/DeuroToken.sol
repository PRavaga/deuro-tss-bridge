// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title DeuroToken
 * @notice ERC20 token representing dEURO on Sepolia. Bridge can mint/burn.
 *
 * - 12 decimals (matches Zano's 12-decimal dEURO asset — no scaling needed)
 * - MINTER_ROLE granted to bridge contract for mint on withdrawal
 * - burnFrom inherited from ERC20Burnable for burn on deposit (user approves bridge)
 * - Initial supply minted to deployer for testing
 */
contract DeuroToken is ERC20, ERC20Burnable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    constructor(uint256 initialSupply_) ERC20("dEURO", "DEURO") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _mint(msg.sender, initialSupply_);
    }

    function decimals() public pure override returns (uint8) {
        return 12;
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}
