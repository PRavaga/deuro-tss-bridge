#!/usr/bin/env node

// CLI helper: Submit EVM withdrawal on-chain using signatures from party DB
//
// Usage:
//   node scripts/withdraw-evm.js <deposit-id> [--party <id>]
//
// Reads the deposit and its signatures from a party's local database,
// then calls withdrawERC20() on the bridge contract.
//
// This is a fallback for manual withdrawal submission when the leader's
// auto-submit fails. Normally, the leader party submits automatically.
//
// Environment:
//   DEPLOYER_PRIVATE_KEY - Key to submit the withdrawal tx (needs gas)
//   BRIDGE_ADDRESS       - DeuroBridge contract address
//   DEURO_TOKEN          - DeuroToken contract address
//   EVM_RPC              - Sepolia RPC endpoint

import { ethers } from 'ethers';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

const BRIDGE_ABI = [
  'function withdrawERC20(address token, uint256 amount, address receiver, bytes32 txHash, uint256 txNonce, bool isWrapped, bytes[] signatures) external',
  'event Withdrawn(address indexed token, uint256 amount, address indexed receiver, bytes32 txHash, uint256 txNonce)',
];

async function main() {
  const depositId = process.argv[2];
  const partyId = process.argv.includes('--party')
    ? process.argv[process.argv.indexOf('--party') + 1]
    : '0';

  if (!depositId) {
    console.log('Usage: node scripts/withdraw-evm.js <deposit-id> [--party <id>]');
    console.log('Example: node scripts/withdraw-evm.js 1 --party 0');
    process.exit(1);
  }

  const bridgeAddress = process.env.BRIDGE_ADDRESS;
  const deuroToken = process.env.DEURO_TOKEN;
  const evmRpc = process.env.EVM_RPC ?? 'https://rpc.sepolia.org';
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;

  if (!bridgeAddress || !deuroToken || !privateKey) {
    console.error('Required: BRIDGE_ADDRESS, DEURO_TOKEN, DEPLOYER_PRIVATE_KEY');
    process.exit(1);
  }

  // Read deposit from party DB
  const dbPath = join(DATA_DIR, `party-${partyId}.db`);
  const db = new Database(dbPath, { readonly: true });

  const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(parseInt(depositId));
  if (!deposit) {
    console.error(`Deposit ${depositId} not found in party-${partyId}.db`);
    process.exit(1);
  }

  if (!deposit.signatures) {
    console.error(`Deposit ${depositId} has no signatures. Status: ${deposit.status}`);
    process.exit(1);
  }

  const signatures = JSON.parse(deposit.signatures);
  console.log(`Deposit #${deposit.id}:`);
  console.log(`  Source:     ${deposit.source_chain}`);
  console.log(`  Tx hash:   ${deposit.tx_hash}`);
  console.log(`  Amount:    ${deposit.amount}`);
  console.log(`  Receiver:  ${deposit.receiver}`);
  console.log(`  Status:    ${deposit.status}`);
  console.log(`  Signatures: ${signatures.length}`);

  // Resolve token address (deposit.token_address may be Zano asset ID)
  const zanoAssetId = process.env.ZANO_ASSET_ID;
  let tokenAddress = deposit.token_address;
  if (zanoAssetId && tokenAddress === zanoAssetId) {
    tokenAddress = deuroToken;
    console.log(`  Token mapped: ${deposit.token_address} -> ${tokenAddress}`);
  }

  // Submit withdrawal
  const provider = new ethers.JsonRpcProvider(evmRpc);
  const wallet = new ethers.Wallet(privateKey, provider);
  const bridge = new ethers.Contract(bridgeAddress, BRIDGE_ABI, wallet);

  const txHash = ethers.zeroPadBytes(deposit.tx_hash, 32);
  const sigs = signatures.map(s => s.signature);

  console.log(`\nSubmitting withdrawERC20...`);
  console.log(`  Token:    ${tokenAddress}`);
  console.log(`  Amount:   ${deposit.amount}`);
  console.log(`  Receiver: ${deposit.receiver}`);

  const tx = await bridge.withdrawERC20(
    tokenAddress,
    deposit.amount,
    deposit.receiver,
    txHash,
    deposit.tx_nonce,
    false, // Custody model: release locked dEURO from bridge
    sigs,
  );

  console.log(`  Tx hash:  ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`  Confirmed in block ${receipt.blockNumber}`);
  console.log(`  Gas used: ${receipt.gasUsed}`);
  console.log('\nWithdrawal successful!');

  db.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
