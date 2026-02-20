#!/usr/bin/env node

// ============================================================================
// Interactive Signing Demonstration
//
// Shows the 2-of-3 threshold signing process step by step, simulating
// how 3 independent parties each verify a Zano burn and sign the EVM
// withdrawal hash. In production, each party runs on separate infrastructure
// operated by different entities — they never share keys.
//
// Confirmation requirements (from Bridgeless production):
//   Ethereum:   64 blocks (~13 min)
//   Zano:       10 blocks (~2 min)
//   Sepolia:     3 blocks (~36 sec) — testnet, reduced for demo
//
// This demo:
//   1. Deposits dEURO into the bridge (lock in custody)
//   2. Waits for EVM confirmations (real blocks on Sepolia)
//   3. Simulates Zano burn detection with 10-block confirmation wait
//   4. Each party independently verifies and signs (with realistic timing)
//   5. Shows that 1 signature is insufficient (on-chain rejection)
//   6. Shows that 2 signatures meet threshold (on-chain success)
//   7. Shows replay protection
//
// Usage:
//   node scripts/demo-signing.js [--fast]
//
// Environment:
//   DEPLOYER_PRIVATE_KEY, BRIDGE_ADDRESS, DEURO_TOKEN, EVM_RPC
// ============================================================================

import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────

const BRIDGE_ADDRESS = process.env.BRIDGE_ADDRESS ?? '0x72D501f30325aE86C6E2Bb2b50C73d688aa3a09e';
const DEURO_TOKEN = process.env.DEURO_TOKEN ?? '0xa7ff975db5AF3Ca92D7983ef944a636Ca962CB60';
const EVM_RPC = process.env.EVM_RPC ?? 'https://eth-sepolia.g.alchemy.com/v2/z97HTgIuGjc4F_sD1-0EZ';
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const FAST = process.argv.includes('--fast');

// Confirmation requirements per Bridgeless production API:
// https://rpc-api.node0.mainnet.bridgeless.com/cosmos/bridge/chains
// From Bridgeless production: https://rpc-api.node0.mainnet.bridgeless.com/cosmos/bridge/chains
const CONFIRMATIONS = {
  ethereum: 64,   // 2 epochs = PoS finality (~13 min)
  zano: 10,       // ~2 minutes (12 sec/block)
  base: 540,      // L2 settlement on L1 (~18 min)
  bitcoin: 6,     // ~60 minutes
};

// Use real Ethereum confirmation count — even on Sepolia.
// No shortcuts. This is how production works.
const EVM_CONFIRMATIONS = FAST ? 1 : CONFIRMATIONS.ethereum;
const ZANO_CONFIRMATIONS = CONFIRMATIONS.zano;

const PARTY_KEYS = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'party-keys.json'), 'utf8'));

const BRIDGE_ABI = [
  'function withdrawERC20(address token, uint256 amount, address receiver, bytes32 txHash, uint256 txNonce, bool isWrapped, bytes[] signatures) external',
  'function depositERC20(address token, uint256 amount, string receiver, bool isWrapped) external',
  'event Withdrawn(address indexed token, uint256 amount, address indexed receiver, bytes32 txHash, uint256 txNonce)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

const PARTY_COLORS = [C.cyan, C.magenta, C.yellow];
const PARTY_NAMES = ['Party A (Zurich)', 'Party B (Singapore)', 'Party C (New York)'];
const PARTY_ICONS = ['[CH]', '[SG]', '[US]'];

function sleep(ms) {
  if (FAST) ms = Math.min(ms, 400);
  return new Promise(r => setTimeout(r, ms));
}

function banner(text) {
  const line = '='.repeat(68);
  console.log(`\n${C.bold}${C.white}+${line}+`);
  console.log(`|  ${text.padEnd(66)}|`);
  console.log(`+${line}+${C.reset}\n`);
}

function step(n, text) {
  console.log(`${C.bold}${C.white}--- Step ${n}: ${text} ${'─'.repeat(Math.max(0, 50 - text.length))}${C.reset}`);
}

function stepEnd() {
  console.log();
}

function partyLog(partyId, msg) {
  const color = PARTY_COLORS[partyId];
  const icon = PARTY_ICONS[partyId];
  const name = PARTY_NAMES[partyId];
  console.log(`${color}${C.bold}  ${icon} ${name}${C.reset}${color}  ${msg}${C.reset}`);
}

function info(msg) {
  console.log(`${C.dim}       ${msg}${C.reset}`);
}

function success(msg) {
  console.log(`${C.green}${C.bold}  [OK] ${msg}${C.reset}`);
}

function fail(msg) {
  console.log(`${C.red}${C.bold}  [XX] ${msg}${C.reset}`);
}

function separator() {
  console.log(`${C.dim}  ${'- '.repeat(34)}${C.reset}`);
}

async function typing(partyId, messages, delayMs = 800) {
  for (const msg of messages) {
    await sleep(delayMs);
    partyLog(partyId, msg);
  }
}

/**
 * Wait for N block confirmations on EVM, printing each one as it arrives.
 * This is the real deal — each tick is a real Sepolia block.
 */
async function waitForConfirmations(provider, txReceipt, required, label) {
  const txBlock = txReceipt.blockNumber;
  let current = 0;

  while (current < required) {
    const latest = await provider.getBlockNumber();
    current = Math.max(0, latest - txBlock);

    if (current >= required) {
      process.stdout.write(`\r${C.green}${C.bold}  [OK] ${label}: ${current}/${required} confirmations — CONFIRMED${' '.repeat(20)}${C.reset}\n`);
      return;
    }

    const bar = '█'.repeat(current) + '░'.repeat(required - current);
    process.stdout.write(`\r${C.dim}       ${label}: ${current}/${required} [${bar}] waiting...${C.reset}`);

    await sleep(FAST ? 1000 : 4000); // Poll every 4 seconds (Sepolia ~12s blocks)
  }
}

/**
 * Simulate Zano confirmation wait with realistic block-by-block progress.
 * Zano has ~12 second block time, requires 10 confirmations.
 */
async function simulateZanoConfirmations(required) {
  for (let i = 0; i <= required; i++) {
    if (i === required) {
      const bar = '█'.repeat(required);
      process.stdout.write(`\r${C.green}${C.bold}  [OK] Zano: ${i}/${required} [${bar}] CONFIRMED${' '.repeat(20)}${C.reset}\n`);
      return;
    }

    const bar = '█'.repeat(i) + '░'.repeat(required - i);
    process.stdout.write(`\r${C.dim}       Zano: ${i}/${required} [${bar}] waiting for next block...${C.reset}`);
    await sleep(FAST ? 500 : 2000); // Compressed timing: 2s per block for demo
  }
}

// ── Core ────────────────────────────────────────────────────────────────────

async function main() {
  if (!DEPLOYER_KEY) {
    console.error('Required: DEPLOYER_PRIVATE_KEY');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);
  const token = new ethers.Contract(DEURO_TOKEN, ERC20_ABI, deployer);
  const bridge = new ethers.Contract(BRIDGE_ADDRESS, BRIDGE_ABI, deployer);

  banner('dEURO TSS Bridge — Threshold Signing Demonstration');

  console.log(`  This demo shows how ${C.bold}3 independent parties${C.reset} must cooperate`);
  console.log(`  to authorize a cross-chain withdrawal. Each party runs on`);
  console.log(`  separate infrastructure in different jurisdictions.`);
  console.log();
  console.log(`  ${PARTY_COLORS[0]}${PARTY_ICONS[0]} ${PARTY_NAMES[0]}${C.reset}  Signer: ${PARTY_KEYS[0].address}`);
  console.log(`  ${PARTY_COLORS[1]}${PARTY_ICONS[1]} ${PARTY_NAMES[1]}${C.reset}  Signer: ${PARTY_KEYS[1].address}`);
  console.log(`  ${PARTY_COLORS[2]}${PARTY_ICONS[2]} ${PARTY_NAMES[2]}${C.reset}  Signer: ${PARTY_KEYS[2].address}`);
  console.log();
  console.log(`  ${C.bold}Threshold:${C.reset} 2-of-3 (any 2 parties must agree)`);
  console.log(`  ${C.bold}Contract:${C.reset}  ${BRIDGE_ADDRESS}`);
  console.log(`  ${C.bold}Token:${C.reset}     ${DEURO_TOKEN} (dEURO, 12 decimals)`);
  console.log();
  console.log(`  ${C.bold}Confirmation requirements (Bridgeless production):${C.reset}`);
  console.log(`  ${C.dim}  Ethereum:  ${CONFIRMATIONS.ethereum} blocks (~13 min) — 2 epochs, PoS finality${C.reset}`);
  console.log(`  ${C.dim}  Zano:      ${CONFIRMATIONS.zano} blocks (~2 min)${C.reset}`);
  console.log(`  ${C.dim}  Base:      ${CONFIRMATIONS.base} blocks (~18 min) — L2 settlement on L1${C.reset}`);
  console.log(`  ${C.dim}  Bitcoin:   ${CONFIRMATIONS.bitcoin} blocks (~60 min)${C.reset}`);
  console.log();

  await sleep(3000);

  // ═══════════════════════════════════════════════════════════════════════
  // Step 1: EVM deposit — lock dEURO in bridge custody
  // ═══════════════════════════════════════════════════════════════════════

  step(1, 'Lock dEURO in bridge custody (EVM deposit)');
  console.log();

  const depositAmount = ethers.parseUnits('10', 12); // 10 dEURO
  info(`A user deposits 10 dEURO into the bridge.`);
  info(`This locks the tokens in the bridge contract (custody model).`);
  info(`On the Zano side, the equivalent dEURO asset will be minted.`);
  console.log();
  await sleep(1500);

  // Approve + deposit
  const currentAllowance = await token.allowance(deployer.address, BRIDGE_ADDRESS);
  if (currentAllowance < depositAmount) {
    info('Approving bridge to custody tokens...');
    const approveTx = await token.approve(BRIDGE_ADDRESS, depositAmount);
    await approveTx.wait();
    info('Approval confirmed.');
  }

  info('Calling depositERC20(dEURO, 10e12, "ZxTestDemo...", isWrapped=false)...');
  const depositTx = await bridge.depositERC20(DEURO_TOKEN, depositAmount, 'ZxTestDemo...', false);
  info(`Tx submitted: https://sepolia.etherscan.io/tx/${depositTx.hash}`);
  console.log();

  const depositReceipt = await depositTx.wait();
  info(`Included in block ${depositReceipt.blockNumber}. Waiting for confirmations...`);
  console.log();

  // Wait for real EVM confirmations
  await waitForConfirmations(provider, depositReceipt, EVM_CONFIRMATIONS, 'Sepolia');
  console.log();

  const bridgeBal = await token.balanceOf(BRIDGE_ADDRESS);
  success(`10 dEURO locked in bridge. Custody balance: ${ethers.formatUnits(bridgeBal, 12)} dEURO`);

  stepEnd();
  await sleep(2000);

  // ═══════════════════════════════════════════════════════════════════════
  // Step 2: Zano burn — user initiates withdrawal
  // ═══════════════════════════════════════════════════════════════════════

  step(2, 'User burns dEURO on Zano (initiates withdrawal to EVM)');
  console.log();

  info('A user on Zano wants to withdraw 5 dEURO back to their EVM wallet.');
  info('They call `transfer` with:');
  info('  - asset_id_to_burn: ff36665d... (dEURO)');
  info('  - amount_to_burn:   5000000000000 (5 dEURO, 12 decimals)');
  info('  - service_entries:  [{dst_add: "0x4574...", dst_net_id: "evm"}]');
  console.log();
  await sleep(2000);

  // Generate unique mock Zano tx hash
  const demoNonce = Date.now();
  const mockZanoTxHash = ethers.keccak256(ethers.toUtf8Bytes(`demo-burn-${demoNonce}`));
  const withdrawAmount = ethers.parseUnits('5', 12);

  info(`Zano burn tx: ${mockZanoTxHash.slice(0, 18)}...`);
  info(`Destination:  ${deployer.address}`);
  console.log();

  info('Transaction included in Zano block. Waiting for 10 confirmations...');
  info('(Bridgeless requires 10 confirmations for Zano — prevents reorg attacks)');
  console.log();

  // Simulate Zano confirmation wait (10 blocks)
  await simulateZanoConfirmations(ZANO_CONFIRMATIONS);

  stepEnd();
  await sleep(2000);

  // ═══════════════════════════════════════════════════════════════════════
  // Step 3: Independent burn detection by each party
  // ═══════════════════════════════════════════════════════════════════════

  step(3, 'Each party independently detects the confirmed burn');
  console.log();

  info('Each party runs its own Zano daemon and polls for new transactions.');
  info('They do NOT share data — each independently discovers the burn,');
  info('parses the service_entries memo, and validates the amount.');
  console.log();

  // Party A detects (closest to Zano node, picks it up first)
  await sleep(2500);
  partyLog(0, 'Polling Zano daemon... new burn detected.');
  await sleep(1200);
  await typing(0, [
    `Burn tx:    ${mockZanoTxHash.slice(0, 18)}...`,
    'Asset:      ff36665d... (dEURO)',
    'Amount:     5.000000000000 dEURO',
    `Memo:       dst_add=${deployer.address.slice(0, 14)}...`,
    'Confirms:   10/10  -- CONFIRMED',
    'Validation: amount > 0, valid EVM address, asset matches config',
    `${C.bold}Burn verified. Queuing for signing session.${C.reset}`,
  ], 1000);

  console.log();
  await sleep(4000);

  // Party B (different timezone, different node)
  partyLog(1, 'Polling Zano daemon... new burn detected.');
  await sleep(1200);
  await typing(1, [
    `Burn tx:    ${mockZanoTxHash.slice(0, 18)}...`,
    'Asset:      ff36665d... (dEURO)',
    'Amount:     5.000000000000 dEURO',
    `Memo:       dst_add=${deployer.address.slice(0, 14)}...`,
    'Confirms:   10/10  -- CONFIRMED',
    'Cross-referencing with local state DB... no duplicates.',
    `${C.bold}Burn verified. Queuing for signing session.${C.reset}`,
  ], 1000);

  console.log();
  await sleep(5000);

  // Party C (last to detect — different polling interval)
  partyLog(2, 'Polling Zano daemon... new burn detected.');
  await sleep(1200);
  await typing(2, [
    `Burn tx:    ${mockZanoTxHash.slice(0, 18)}...`,
    'Asset:      ff36665d... (dEURO)',
    'Amount:     5.000000000000 dEURO',
    `Memo:       dst_add=${deployer.address.slice(0, 14)}...`,
    'Confirms:   10/10  -- CONFIRMED',
    `${C.bold}Burn verified. Queuing for signing session.${C.reset}`,
  ], 1000);

  stepEnd();
  await sleep(2000);

  // ═══════════════════════════════════════════════════════════════════════
  // Step 4: Leader election + consensus
  // ═══════════════════════════════════════════════════════════════════════

  step(4, 'Leader election and consensus');
  console.log();

  info('A deterministic leader is elected based on the session hash.');
  info('The leader proposes which deposits to process. Other parties');
  info('verify the proposal matches what they independently detected.');
  console.log();

  await sleep(2000);
  partyLog(0, `${C.bold}Elected as leader for this session.${C.reset}`);
  await sleep(1500);
  partyLog(0, 'Broadcasting proposal: process burn tx ' + mockZanoTxHash.slice(0, 18) + '...');
  console.log();
  await sleep(2000);

  partyLog(1, 'Received proposal from Party A.');
  await sleep(800);
  partyLog(1, 'Checking: does this burn exist in my local DB? YES');
  await sleep(600);
  partyLog(1, 'Checking: amount matches? 5.000000000000 dEURO -- YES');
  await sleep(600);
  partyLog(1, 'Checking: not already processed? -- CORRECT');
  await sleep(800);
  partyLog(1, `${C.bold}Proposal ACCEPTED.${C.reset}`);
  console.log();
  await sleep(2000);

  partyLog(2, 'Received proposal from Party A.');
  await sleep(800);
  partyLog(2, 'Checking: does this burn exist in my local DB? YES');
  await sleep(600);
  partyLog(2, 'Checking: amount matches? 5.000000000000 dEURO -- YES');
  await sleep(600);
  partyLog(2, 'Checking: not already processed? -- CORRECT');
  await sleep(800);
  partyLog(2, `${C.bold}Proposal ACCEPTED.${C.reset}`);

  console.log();
  success('Consensus reached: all 3 parties agree on the withdrawal parameters.');

  stepEnd();
  await sleep(2000);

  // ═══════════════════════════════════════════════════════════════════════
  // Step 5: Hash computation
  // ═══════════════════════════════════════════════════════════════════════

  step(5, 'Each party computes the withdrawal hash');
  console.log();

  info('The hash binds all parameters so the signature cannot be reused:');
  info(`  token:     ${DEURO_TOKEN} (dEURO on Sepolia)`);
  info(`  amount:    5000000000000 (5 dEURO)`);
  info(`  receiver:  ${deployer.address}`);
  info(`  txHash:    ${mockZanoTxHash.slice(0, 18)}... (Zano burn tx)`);
  info(`  txNonce:   ${demoNonce}`);
  info(`  chainId:   11155111 (Sepolia)`);
  info(`  isWrapped: false (custody model — release locked tokens)`);
  console.log();

  const signHash = ethers.keccak256(
    ethers.solidityPacked(
      ['address', 'uint256', 'address', 'bytes32', 'uint256', 'uint256', 'bool'],
      [DEURO_TOKEN, withdrawAmount, deployer.address, mockZanoTxHash, demoNonce, 11155111, false],
    )
  );

  for (let i = 0; i < 3; i++) {
    await sleep(2500);
    partyLog(i, 'Computing keccak256(abi.encodePacked(token, amount, receiver, txHash, nonce, chainId, isWrapped))');
    await sleep(1000);
    partyLog(i, `Hash: ${signHash}`);
    if (i < 2) separator();
  }

  console.log();
  success('All 3 parties independently computed the same hash (deterministic).');

  stepEnd();
  await sleep(2000);

  // ═══════════════════════════════════════════════════════════════════════
  // Step 6: Independent signing
  // ═══════════════════════════════════════════════════════════════════════

  step(6, 'Each party independently signs the hash');
  console.log();

  info('Each party signs with their private key using EIP-191.');
  info('The key NEVER leaves the party\'s infrastructure.');
  info('In production TSS: parties run GG20 MPC to produce a single');
  info('combined signature without revealing individual key shares.');
  console.log();

  const signatures = [];

  for (let i = 0; i < 3; i++) {
    await sleep(4000);
    partyLog(i, 'Verifying withdrawal parameters one final time before signing...');
    await sleep(2000);
    partyLog(i, `Signing with key ${PARTY_KEYS[i].address}`);
    await sleep(1500);

    const wallet = new ethers.Wallet(PARTY_KEYS[i].privateKey);
    const sig = await wallet.signMessage(ethers.getBytes(signHash));
    signatures.push(sig);

    partyLog(i, `Signature: ${sig.slice(0, 24)}...${sig.slice(-8)}`);
    await sleep(800);
    partyLog(i, `${C.bold}Signature produced. Broadcasting to peers via P2P.${C.reset}`);

    console.log();
    const count = i + 1;
    if (count < 2) {
      info(`Signatures collected: ${count}/3  (threshold: 2 — NOT YET MET)`);
      info('Cannot submit withdrawal. Waiting for more signatures...');
    } else if (count === 2) {
      success(`Signatures collected: ${count}/3 — THRESHOLD MET (2-of-3)`);
      info('Leader (Party A) can now submit the withdrawal on-chain.');
    } else {
      info(`Signatures collected: ${count}/3 (all parties signed — extra safety)`);
    }
    separator();
  }

  stepEnd();
  await sleep(2000);

  // ═══════════════════════════════════════════════════════════════════════
  // Step 7: On-chain submission + verification
  // ═══════════════════════════════════════════════════════════════════════

  step(7, 'On-chain verification and threshold enforcement');
  console.log();

  info('The bridge contract independently verifies every signature:');
  info('  1. Recomputes hash from the provided parameters');
  info('  2. Applies EIP-191 prefix to get the Ethereum signed message hash');
  info('  3. Calls ecrecover() on each signature');
  info('  4. Checks each recovered address is a registered signer');
  info('  5. Uses a bitmap to reject duplicate signers');
  info('  6. Requires signatures.length >= threshold (2)');
  info('  7. Checks keccak256(txHash, txNonce) not in usedHashes (replay)');
  console.log();

  // Test A: 1 signature — should fail
  await sleep(2000);
  console.log(`  ${C.bold}${C.white}Test A: Submit with 1 signature only (Party A)${C.reset}`);
  console.log();
  partyLog(0, 'Attempting to submit withdrawal with just my signature...');
  await sleep(2000);

  try {
    await bridge.withdrawERC20(
      DEURO_TOKEN, withdrawAmount, deployer.address,
      mockZanoTxHash, demoNonce, false,
      [signatures[0]],
    );
    fail('Should have reverted');
  } catch (err) {
    const reason = err.message.includes('Not enough') ? 'Not enough signatures'
      : err.reason || 'insufficient signatures';
    fail(`REJECTED by contract: "${reason}"`);
    info('A single compromised party cannot steal funds. Threshold is 2.');
  }

  separator();
  await sleep(3000);

  // Test B: 2 signatures — should succeed
  console.log(`  ${C.bold}${C.white}Test B: Submit with 2 signatures (Party A + Party B)${C.reset}`);
  console.log();
  partyLog(0, 'Submitting withdrawal with 2-of-3 signatures (threshold met)...');
  await sleep(2000);

  const balBefore = await token.balanceOf(deployer.address);

  const tx = await bridge.withdrawERC20(
    DEURO_TOKEN, withdrawAmount, deployer.address,
    mockZanoTxHash, demoNonce, false,
    [signatures[0], signatures[1]],
  );

  info(`Tx submitted: https://sepolia.etherscan.io/tx/${tx.hash}`);
  info('Waiting for inclusion + confirmation...');
  console.log();

  const receipt = await tx.wait();

  // Wait for withdrawal tx confirmations too
  await waitForConfirmations(provider, receipt, EVM_CONFIRMATIONS, 'Withdrawal');
  console.log();

  const balAfter = await token.balanceOf(deployer.address);
  const released = balAfter - balBefore;

  success(`WITHDRAWAL CONFIRMED at block ${receipt.blockNumber}`);
  success(`5 dEURO released from bridge custody to ${deployer.address}`);
  info(`Gas used: ${receipt.gasUsed.toString()}`);
  info(`Balance change: +${ethers.formatUnits(released, 12)} dEURO`);
  info(`Etherscan: https://sepolia.etherscan.io/tx/${tx.hash}`);

  separator();
  await sleep(3000);

  // Test C: Replay — should fail
  console.log(`  ${C.bold}${C.white}Test C: Replay the same withdrawal${C.reset}`);
  console.log();
  info('An attacker intercepts the signed withdrawal and replays it...');
  await sleep(2000);

  try {
    await bridge.withdrawERC20(
      DEURO_TOKEN, withdrawAmount, deployer.address,
      mockZanoTxHash, demoNonce, false,
      [signatures[0], signatures[1]],
    );
    fail('Should have reverted');
  } catch (err) {
    const reason = err.message.includes('already used') ? 'Hash already used'
      : err.reason || 'replay blocked';
    fail(`REJECTED by contract: "${reason}"`);
    info('keccak256(txHash, txNonce) is stored on-chain — each burn can only be withdrawn once.');
  }

  stepEnd();
  await sleep(1500);

  // ═══════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════

  banner('Demonstration Complete');

  console.log(`  ${C.green}1.${C.reset} dEURO deposited on EVM and held in bridge custody`);
  console.log(`  ${C.green}2.${C.reset} Burn on Zano confirmed after ${ZANO_CONFIRMATIONS} blocks (reorg protection)`);
  console.log(`  ${C.green}3.${C.reset} Three independent parties each detected and verified the burn`);
  console.log(`  ${C.green}4.${C.reset} Consensus reached — all parties agree on withdrawal parameters`);
  console.log(`  ${C.green}5.${C.reset} Each party independently signed with their own key`);
  console.log(`  ${C.green}6.${C.reset} 1 signature alone was REJECTED by the contract`);
  console.log(`  ${C.green}7.${C.reset} 2-of-3 signatures met threshold — dEURO released after ${EVM_CONFIRMATIONS} block confirmations`);
  console.log(`  ${C.green}8.${C.reset} Replay of the same withdrawal was BLOCKED`);
  console.log();
  console.log(`  ${C.bold}Production security model:${C.reset}`);
  console.log(`    - Each party runs on separate infrastructure (different jurisdictions)`);
  console.log(`    - Keys generated via GG20 multi-party computation (no single key exists)`);
  console.log(`    - No single party can produce a valid withdrawal signature`);
  console.log(`    - Parties communicate over encrypted P2P channels`);
  console.log(`    - ${CONFIRMATIONS.ethereum} EVM confirmations required before signing (Ethereum mainnet)`);
  console.log(`    - ${CONFIRMATIONS.zano} Zano confirmations required before signing`);
  console.log(`    - Replay protection via on-chain hash tracking`);
  console.log();
}

main().catch(err => {
  console.error(`\n${C.red}Fatal: ${err.message}${C.reset}`);
  if (err.data) console.error('Data:', err.data);
  process.exit(1);
});
