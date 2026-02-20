#!/usr/bin/env node

// Helper: Make a deposit on EVM side (bridge dEURO to Zano)
//
// Usage:
//   node src/deposit-evm.js <zano-address> <amount>
//
// This approves the bridge to custody dEURO tokens, then calls
// depositERC20(token, amount, receiver, isWrapped=false) which locks
// the tokens in the bridge and emits DepositedERC20. Parties detect
// this and mint dEURO on Zano via emit_asset.
//
// Environment:
//   DEPOSITOR_KEY   - Private key of the depositor (must hold dEURO)
//   DEURO_TOKEN     - Address of the DeuroToken ERC20 contract
//   BRIDGE_ADDRESS  - Address of the DeuroBridge contract

import { ethers } from 'ethers';
import { config } from './config.js';

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
];

const BRIDGE_ABI = [
  'function depositERC20(address token, uint256 amount, string receiver, bool isWrapped) external',
];

async function main() {
  const receiver = process.argv[2];
  const amount = process.argv[3] ?? '1000000000000'; // 1 dEURO (12 decimals)

  if (!receiver) {
    console.log('Usage: node src/deposit-evm.js <zano-address> [amount]');
    console.log('Example: node src/deposit-evm.js ZxBvJDaBLMvCe... 1000000000000');
    process.exit(1);
  }

  if (!config.evm.bridgeAddress) {
    console.error('BRIDGE_ADDRESS not set. Deploy the contract first.');
    process.exit(1);
  }

  const tokenAddress = config.evm.deuroToken;
  if (!tokenAddress) {
    console.error('DEURO_TOKEN not set. Deploy DeuroToken first.');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(config.evm.rpc);
  const wallet = new ethers.Wallet(process.env.DEPOSITOR_KEY, provider);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const bridge = new ethers.Contract(config.evm.bridgeAddress, BRIDGE_ABI, wallet);

  const balance = await token.balanceOf(wallet.address);
  const decimals = await token.decimals();

  console.log(`Depositing ${ethers.formatUnits(amount, decimals)} dEURO to bridge`);
  console.log(`  From:     ${wallet.address}`);
  console.log(`  Balance:  ${ethers.formatUnits(balance, decimals)} dEURO`);
  console.log(`  To:       ${receiver} (Zano)`);
  console.log(`  Token:    ${tokenAddress}`);
  console.log(`  Bridge:   ${config.evm.bridgeAddress}`);

  if (balance < BigInt(amount)) {
    console.error(`Insufficient balance: have ${balance}, need ${amount}`);
    process.exit(1);
  }

  // Step 1: Approve bridge to transfer our tokens into custody
  const currentAllowance = await token.allowance(wallet.address, config.evm.bridgeAddress);
  if (currentAllowance < BigInt(amount)) {
    console.log(`  Approving bridge to spend ${amount}...`);
    const approveTx = await token.approve(config.evm.bridgeAddress, amount);
    await approveTx.wait();
    console.log(`  Approved.`);
  }

  // Step 2: Call depositERC20 with isWrapped=false (locks tokens in bridge custody)
  // dEURO is a real ERC20 — bridge holds it, Zano side mints/burns the wrapped asset
  const tx = await bridge.depositERC20(tokenAddress, amount, receiver, false);
  console.log(`  Tx hash:  ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`  Confirmed in block ${receipt.blockNumber}`);
  console.log(`  Gas used: ${receipt.gasUsed}`);
  console.log();
  console.log('Deposit successful. Parties will detect this and mint dEURO on Zano.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
