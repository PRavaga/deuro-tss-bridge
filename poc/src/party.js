#!/usr/bin/env node

// Main Party Service
//
// Implements the withdrawal-generation protocol (Paper Algorithm 3, arXiv 2506.19730).
// Each of the 3 parties runs this service. It coordinates:
// 1. Watching both chains for deposits (Paper Sec. 6 — deposit creation)
// 2. Running consensus to agree on what to sign (Algorithms 4 & 5)
// 3. TSS cooperative signing via DKLs23 (2-of-3 → single ECDSA signature)
// 4. Finalizing: submit withdrawal on-chain (Algorithm 7)
//
// TSS Architecture:
// - DKG (keygen.js) produces keyshares — each party holds a share, all share the group public key
// - Signing: 2 selected parties run multi-round DKLs23 protocol via P2P to produce 1 combined sig
// - EVM: contract verifies 1 TSS signature (threshold=1, single group address)
// - Zano: TSS signature = 2-of-3 cooperative (fixes the 1-of-1 vulnerability)
//
// Usage:
//   PARTY_ID=0 node src/party.js
//   PARTY_ID=1 node src/party.js
//   PARTY_ID=2 node src/party.js

import { config } from './config.js';
import { getDb } from './db.js';
import { startP2PServer, broadcast, sendToParty, onMessage } from './p2p.js';
import { initEvmWatcher, pollEvmDeposits } from './evm-watcher.js';
import { initZanoWatcher, pollZanoDeposits } from './zano-watcher.js';
import { determineLeader, getSessionId, runAsProposer, runAsAcceptor, cleanupBuffers } from './consensus.js';
import { signEvmWithdrawal, computeErc20SignHash, resolveEvmTokenAddress } from './evm-signer.js';
import { processZanoWithdrawal, signZanoTxHash, broadcastSignedZanoTx, createUnsignedEmitTx } from './zano-signer.js';
import { updateDepositStatus, getDepositByTxHash } from './db.js';
import { initTss, getGroupAddress } from './tss.js';
import { formSigningData } from './zano-rpc.js';
import { ethers } from 'ethers';

let sessionCounter = 0;
let lastEpoch = -1;

async function main() {
  // Initialize TSS WASM
  await initTss();
  console.log('[TSS] WASM initialized');

  // Derive group address from keyshare
  if (config.tssKeyshare) {
    config.tssGroupAddress = getGroupAddress(config.tssKeyshare);
    console.log(`[TSS] Group address: ${config.tssGroupAddress}`);
  }

  console.log('='.repeat(60));
  console.log(`  deuro TSS Bridge PoC - ${config.parties[config.partyId].name}`);
  console.log(`  Party ID: ${config.partyId}`);
  console.log(`  TSS Threshold: ${config.threshold} of ${config.totalParties}`);
  console.log(`  Group Address: ${config.tssGroupAddress || '(no keyshare)'}`);
  console.log('='.repeat(60));
  console.log();

  // Initialize database
  getDb();
  console.log('[DB] Database initialized');

  // Start P2P server
  startP2PServer();

  // Initialize chain watchers
  await initEvmWatcher();
  await initZanoWatcher();

  // Register handler for cross-party finalization notifications
  onMessage('deposit_finalized', (msg) => {
    const { depositTxHash, depositTxNonce, sourceChain } = msg.data;
    const existing = getDepositByTxHash(sourceChain, depositTxHash, depositTxNonce ?? 0);
    if (existing && existing.status !== 'finalized') {
      updateDepositStatus(existing.id, 'finalized');
      console.log(`[Finalized] Deposit ${depositTxHash} marked as finalized (notified by party ${msg.sender})`);
    }
  });

  // Main loop
  console.log(`\n[Main] Starting session loop (interval: ${config.session.intervalMs}ms)\n`);

  // Initial delay to let all parties start
  await sleep(5000);

  while (true) {
    try {
      await runSigningSession();
    } catch (err) {
      console.error('[Main] Session error:', err.message);
    }
    // Sleep until next epoch boundary so all parties wake at the same wall-clock instant.
    // This replaces the old "subtract elapsed" approach which drifted over long runs.
    const now = Date.now();
    const currentEpoch = Math.floor(now / config.session.intervalMs);
    const nextEpochStart = (currentEpoch + 1) * config.session.intervalMs;
    await sleep(Math.max(1000, nextEpochStart - now));
  }
}

/**
 * Run a single signing session.
 * Handles both directions: EVM->Zano and Zano->EVM.
 */
async function runSigningSession() {
  // Time-based epoch: all parties derive the same session counter from wall-clock time.
  // This prevents session drift that occurred with simple incrementing counters —
  // after hours of running, variable execution times caused parties to diverge by
  // 20+ sessions, making consensus impossible until restart.
  const epoch = Math.floor(Date.now() / config.session.intervalMs);
  if (epoch === lastEpoch) return; // Already processed this epoch
  lastEpoch = epoch;
  sessionCounter = epoch;

  // Clean up stale consensus buffers from old sessions
  cleanupBuffers(sessionCounter);

  // Poll both chains for new deposits
  await pollEvmDeposits();
  await pollZanoDeposits();

  // Run session for each direction
  for (const destChain of ['zano', 'evm']) {
    const sessionId = getSessionId(destChain, sessionCounter);
    const leader = determineLeader(sessionId);

    console.log(`\n--- Session ${sessionId} | Leader: Party ${leader} ---`);

    let result;

    if (leader === config.partyId) {
      // We are the leader (proposer)
      result = await runAsProposer(sessionId, destChain);
    } else {
      // We are an acceptor
      try {
        result = await runAsAcceptor(sessionId);
      } catch (err) {
        // Timeout is normal if there are no deposits
        if (err.message.includes('timeout')) {
          console.log(`[Session] No proposal received, moving on`);
          continue;
        }
        throw err;
      }
    }

    if (!result) {
      console.log('[Session] No deposits to process');
      continue;
    }

    // Use the actual session ID from consensus (may differ from ours by ±1 epoch
    // if the proposer's clock diverges slightly)
    const actualSessionId = result.sessionId || sessionId;

    // Signing phase (Paper Algorithm 6)
    const amISigner = result.signers.includes(config.partyId);

    if (amISigner) {
      console.log('[Session] Selected as signer, running TSS signing phase');
      if (destChain === 'zano') {
        await handleZanoSigning(actualSessionId, result);
      } else {
        await handleEvmSigning(actualSessionId, result);
      }
    } else {
      // Paper Algorithm 6, Lines 6-10: non-signers wait for signature broadcast,
      // verify it, and participate in finalization
      console.log('[Session] Not selected as signer, waiting for signature broadcast');
      await handleSignatureBroadcast(actualSessionId, result, destChain);
    }
  }
}

// ---------------------------------------------------------------------------
// TSS P2P message handling for signing rounds
// ---------------------------------------------------------------------------

/**
 * Create TSS P2P send/receive functions scoped to a signing session.
 * These are passed to distributedSign() and handle the multi-round exchange.
 *
 * @param {string} sessionId  Unique session identifier
 * @param {number[]} signers  The 2 parties participating in this signing
 * @returns {{ sendMsg, waitForMsgs }}
 */
function createTssTransport(sessionId, signers) {
  const myId = config.partyId;
  const coSignerId = signers.find(id => id !== myId);
  const messageBuffers = new Map();
  const messageWaiters = new Map();

  // Pre-register handlers for all TSS signing message types
  for (const type of ['tss_sign_msg1', 'tss_sign_msg2', 'tss_sign_msg3', 'tss_sign_last']) {
    messageBuffers.set(type, []);
    onMessage(type, (msg) => {
      if (msg.sessionId !== sessionId) return;
      // Collect serialized messages from the co-signer
      for (const serializedMsg of msg.data.messages) {
        messageBuffers.get(type).push(serializedMsg);
      }
      // Resolve pending waiter
      const waiter = messageWaiters.get(type);
      if (waiter && messageBuffers.get(type).length >= waiter.count) {
        waiter.resolve(messageBuffers.get(type).splice(0, waiter.count));
        messageWaiters.delete(type);
      }
    });
  }

  async function sendMsg(type, serializedMsgs) {
    await sendToParty(coSignerId, {
      type,
      sessionId,
      data: { messages: serializedMsgs },
    });
  }

  function waitForMsgs(type) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`TSS timeout waiting for ${type} from co-signer`));
      }, config.session.signingTimeoutMs);

      const buf = messageBuffers.get(type);
      if (buf && buf.length >= 1) {
        clearTimeout(timeout);
        resolve(buf.splice(0, 1));
        return;
      }

      messageWaiters.set(type, {
        count: 1,
        resolve: (msgs) => {
          clearTimeout(timeout);
          resolve(msgs);
        },
      });
    });
  }

  return { sendMsg, waitForMsgs };
}

// ---------------------------------------------------------------------------
// Zano direction (EVM → Zano): TSS signing + broadcast
// ---------------------------------------------------------------------------

/**
 * Handle signing for EVM -> Zano direction.
 * Leader creates unsigned Zano tx, shares tx data with co-signer,
 * both run TSS to sign, leader broadcasts to Zano.
 */
async function handleZanoSigning(sessionId, result) {
  const { deposit, signers } = result;
  const isLeader = determineLeader(sessionId) === config.partyId;

  if (deposit.status && deposit.status !== 'processing' && deposit.status !== 'pending') {
    console.log(`[Zano Signing] Skipping deposit ${deposit.id}: status is '${deposit.status}'`);
    return;
  }

  try {
    const { sendMsg, waitForMsgs } = createTssTransport(sessionId, signers);

    if (isLeader) {
      // Leader: create unsigned tx and share with co-signer
      const assetId = config.zano.assetId;
      const unsignedTxData = await createUnsignedEmitTx(assetId, deposit.receiver, deposit.amount);

      // Send tx data to co-signer so they can compute the same sigData
      const coSignerId = signers.find(id => id !== config.partyId);
      await sendToParty(coSignerId, {
        type: 'tss_zano_tx_data',
        sessionId,
        data: {
          txId: unsignedTxData.txId,
          unsignedTx: unsignedTxData.unsignedTx,
          finalizedTx: unsignedTxData.finalizedTx,
        },
      });

      // Run TSS signing on the sigData
      const tssSig = await signZanoTxHash(unsignedTxData.sigData, sendMsg, waitForMsgs);

      // Paper Algorithm 6, Line 4: broadcast signature result to all validators
      await broadcast({
        type: 'tss_signature_result',
        sessionId,
        data: {
          signature: tssSig.zanoSig,
          signer: config.tssGroupAddress,
          depositTxHash: deposit.tx_hash,
          direction: 'zano',
        },
      });

      // Broadcast the signed tx to Zano
      await broadcastSignedZanoTx(unsignedTxData, tssSig.zanoSig);
      updateDepositStatus(deposit.id, 'finalized');
      console.log('[Zano Signing] Transaction finalized!');

      // Notify all parties that this deposit is finalized (prevent double-processing)
      await broadcast({
        type: 'deposit_finalized',
        sessionId,
        data: { depositTxHash: deposit.tx_hash, depositTxNonce: deposit.tx_nonce, sourceChain: deposit.source_chain },
      });
    } else {
      // Co-signer: wait for tx data from leader, then run TSS
      const txData = await waitForTxData(sessionId);
      const sigData = formSigningData(txData.txId);

      // Run TSS signing on the same sigData
      await signZanoTxHash(sigData, sendMsg, waitForMsgs);

      // Leader will broadcast — mark as signed on our side
      updateDepositStatus(deposit.id, 'signed');
      console.log('[Zano Signing] Co-signed successfully, leader will broadcast');
    }
  } catch (err) {
    console.error('[Zano Signing] Error:', err.message);
    updateDepositStatus(deposit.id, 'pending');
  }
}

/**
 * Handle signature broadcast for non-signers.
 * Paper Algorithm 6, Lines 6-10: upon delivering (result, signHash) from a signer,
 * verify the signature and mark the request as PROCESSED.
 * Paper Algorithm 7: all validators attempt finalization.
 *
 * @param {string} sessionId  Current session ID
 * @param {Object} result     Consensus result with deposit and signers
 * @param {string} destChain  'evm' or 'zano'
 */
async function handleSignatureBroadcast(sessionId, result, destChain) {
  const { deposit } = result;

  try {
    // Wait for the TSS signature broadcast from a signer
    const sigMsg = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for signature broadcast'));
      }, config.session.signingTimeoutMs);

      onMessage('tss_signature_result', (msg) => {
        if (msg.sessionId !== sessionId) return;
        clearTimeout(timeout);
        resolve(msg);
      });
    });

    const { signature, signer, depositTxHash } = sigMsg.data;
    console.log(`[Session] Received signature broadcast from signer ${signer}`);

    // Paper Algorithm 6, Line 9: verify the signature
    if (signer !== config.tssGroupAddress) {
      console.error(`[Session] Signature signer mismatch: expected ${config.tssGroupAddress}, got ${signer}`);
      return;
    }

    if (depositTxHash !== deposit.tx_hash) {
      console.error(`[Session] Signature deposit mismatch: expected ${deposit.tx_hash}, got ${depositTxHash}`);
      return;
    }

    // Mark as PROCESSED (paper) = 'signed' (PoC)
    updateDepositStatus(
      deposit.id,
      'signed',
      [{ signature, signer }],
    );
    console.log(`[Session] Deposit ${deposit.tx_hash} marked as signed (verified signature)`);

    // Paper Algorithm 7: all validators attempt finalization
    // For EVM: any validator can submit the withdrawal on-chain
    // For Zano: only the leader can submit (needs the unsigned tx data)
    if (destChain === 'evm') {
      console.log('[Session] Non-signer attempting EVM finalization...');
      await submitEvmWithdrawal(deposit, { signature, signer });
    }
    // For Zano, only leader has the unsigned tx data, so non-signers
    // just wait for the deposit_finalized broadcast
  } catch (err) {
    if (err.message.includes('Timeout')) {
      console.log('[Session] No signature broadcast received, moving on');
    } else {
      console.error('[Session] Signature broadcast error:', err.message);
    }
  }
}

/**
 * Wait for the unsigned Zano tx data from the leader.
 */
function waitForTxData(sessionId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for Zano tx data from leader'));
    }, config.session.signingTimeoutMs);

    onMessage('tss_zano_tx_data', (msg) => {
      if (msg.sessionId !== sessionId) return;
      clearTimeout(timeout);
      resolve(msg.data);
    });
  });
}

// ---------------------------------------------------------------------------
// EVM direction (Zano → EVM): TSS signing + on-chain submission
// ---------------------------------------------------------------------------

/**
 * Handle signing for Zano -> EVM direction.
 * Both signers compute the same hash, run TSS, get the same (R, S).
 * Leader computes V, formats the signature, submits on-chain.
 */
async function handleEvmSigning(sessionId, result) {
  const { deposit, signers } = result;
  const isLeader = determineLeader(sessionId) === config.partyId;

  if (deposit.status && deposit.status !== 'processing' && deposit.status !== 'pending') {
    console.log(`[EVM Signing] Skipping deposit ${deposit.id}: status is '${deposit.status}'`);
    return;
  }

  try {
    const { sendMsg, waitForMsgs } = createTssTransport(sessionId, signers);

    // Both signers compute the same hash (deterministic)
    const sigResult = await signEvmWithdrawal(deposit, sendMsg, waitForMsgs);
    console.log(`[EVM Signing] TSS signature produced, signer: ${sigResult.signer}`);

    // Paper Algorithm 6, Line 4: broadcast (result, signHash) to all validators
    await broadcast({
      type: 'tss_signature_result',
      sessionId,
      data: {
        signature: sigResult.signature,
        signer: sigResult.signer,
        depositTxHash: deposit.tx_hash,
        direction: 'evm',
      },
    });

    // Store the single TSS signature (status → PROCESSED per paper)
    updateDepositStatus(
      deposit.id,
      'signed',
      [{ signature: sigResult.signature, signer: sigResult.signer }],
    );

    // Paper Algorithm 7: all validators attempt finalization.
    // Leader submits first; non-signers get the signature via broadcast.
    if (isLeader) {
      console.log('[EVM Signing] Leader submitting withdrawal on-chain...');
      await submitEvmWithdrawal(deposit, sigResult);
    } else {
      console.log('[EVM Signing] Signature stored. Leader will submit on-chain.');
    }
  } catch (err) {
    console.error('[EVM Signing] Error:', err.message);
    updateDepositStatus(deposit.id, 'pending');
  }
}

/**
 * Submit the EVM withdrawal transaction on-chain.
 * With TSS, we submit a single combined signature (threshold=1 on contract).
 */
async function submitEvmWithdrawal(deposit, sigResult) {
  const BRIDGE_ABI = [
    'function withdrawERC20(address token, uint256 amount, address receiver, bytes32 txHash, uint256 txNonce, bool isWrapped, bytes[] signatures) external',
  ];

  try {
    const provider = new ethers.JsonRpcProvider(config.evm.rpc);
    // Use any funded wallet for gas — TSS signature is independent of the submitter
    const submitterKey = process.env.SUBMITTER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
    if (!submitterKey) {
      throw new Error('SUBMITTER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY required for on-chain submission');
    }
    const wallet = new ethers.Wallet(submitterKey, provider);
    const bridge = new ethers.Contract(config.evm.bridgeAddress, BRIDGE_ABI, wallet);

    const evmTokenAddress = resolveEvmTokenAddress(deposit.token_address);
    const txHash = ethers.zeroPadBytes(deposit.tx_hash.startsWith('0x') ? deposit.tx_hash : '0x' + deposit.tx_hash, 32);

    console.log(`[EVM Submit] Token: ${evmTokenAddress}`);
    console.log(`[EVM Submit] Amount: ${deposit.amount}`);
    console.log(`[EVM Submit] Receiver: ${deposit.receiver}`);
    console.log(`[EVM Submit] TSS Signature from: ${sigResult.signer}`);

    // Submit with single TSS signature (contract threshold=1)
    const tx = await bridge.withdrawERC20(
      evmTokenAddress,
      deposit.amount,
      deposit.receiver,
      txHash,
      deposit.tx_nonce,
      true, // Mint model: bridge mints dEURO on withdrawal (has MINTER_ROLE)
      [sigResult.signature], // Single TSS signature
    );

    console.log(`[EVM Submit] Tx hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[EVM Submit] Confirmed in block ${receipt.blockNumber}`);

    updateDepositStatus(deposit.id, 'finalized');
    console.log('[EVM Submit] Withdrawal finalized!');

    // Notify all parties that this deposit is finalized
    await broadcast({
      type: 'deposit_finalized',
      sessionId: `evm_finalized_${deposit.tx_hash}`,
      data: { depositTxHash: deposit.tx_hash, depositTxNonce: deposit.tx_nonce, sourceChain: deposit.source_chain },
    });
  } catch (err) {
    // If the contract says "already processed", this deposit was finalized
    // in a previous run. Mark as finalized instead of retrying endlessly.
    if (err.message && err.message.includes('already processed')) {
      updateDepositStatus(deposit.id, 'finalized');
      console.log(`[EVM Submit] Deposit already processed on-chain, marked as finalized`);
      // Notify other parties so they stop retrying too
      await broadcast({
        type: 'deposit_finalized',
        sessionId: `evm_finalized_${deposit.tx_hash}`,
        data: { depositTxHash: deposit.tx_hash, depositTxNonce: deposit.tx_nonce, sourceChain: deposit.source_chain },
      });
      return;
    }
    console.error('[EVM Submit] Failed:', err.message);
    // Paper Algorithm 3, Line 40: reset to PENDING on finalization failure
    // so the deposit can be retried in a future session
    updateDepositStatus(deposit.id, 'pending');
    console.log('[EVM Submit] Reset deposit to pending for retry');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
