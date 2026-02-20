#!/usr/bin/env node

// Main Party Service
//
// Implements the withdrawal-generation protocol (Paper Algorithm 3, arXiv 2506.19730).
// Each of the 3 parties runs this service. It coordinates:
// 1. Watching both chains for deposits (Paper Sec. 6 — deposit creation)
// 2. Running consensus to agree on what to sign (Algorithms 4 & 5)
// 3. Signing with individual ECDSA keys (Algorithm 6, PoC: multi-sig instead of TSS)
// 4. Finalizing: submit withdrawal on-chain (Algorithm 7)
//
// PoC vs Production/Paper differences (intentional simplifications):
// 1. Signing: individual ECDSA per party (not GG19 TSS from bnb-chain/tss-lib).
//    Bridge contract verifies 2-of-3 individual sigs; TSS would produce 1 combined sig.
// 2. No signature distribution phase (Go distribution.go): TSS-specific — the combined
//    sig is broadcast via reliable broadcast for all validators to verify. In multi-sig,
//    each party broadcasts their own sig directly.
// 3. EVM finalization: leader auto-submits withdrawERC20 on-chain (Go uses separate
//    relayer-svc). Paper Algorithm 7 doesn't specify who submits.
// 4. Error handling: reverts to PENDING on failure (Paper Algorithm 3 Lines 27-30).
//    Go uses FAILED status — we follow the paper for liveness (Theorem 1).
// 5. Session timing: 10s consensus / 15s signing (Go: 5s/15s/13s/5s/7s phases).
//
// Usage:
//   PARTY_ID=0 node src/party.js
//   PARTY_ID=1 node src/party.js
//   PARTY_ID=2 node src/party.js
//
// Bridgeless ref: tss-svc/cmd/service/run/sign.go (signing service entry point)

import { config } from './config.js';
import { getDb } from './db.js';
import { startP2PServer, broadcast, onMessage } from './p2p.js';
import { initEvmWatcher, pollEvmDeposits } from './evm-watcher.js';
import { initZanoWatcher, pollZanoDeposits } from './zano-watcher.js';
import { determineLeader, getSessionId, runAsProposer, runAsAcceptor } from './consensus.js';
import { signEvmWithdrawal, signHash, computeErc20SignHash, formatSignaturesForContract, resolveEvmTokenAddress, verifySignature } from './evm-signer.js';
import { processZanoWithdrawal, signZanoTxHash, broadcastSignedZanoTx } from './zano-signer.js';
import { updateDepositStatus } from './db.js';
import { ethers } from 'ethers';

let sessionCounter = 0;

async function main() {
  console.log('='.repeat(60));
  console.log(`  deuro TSS Bridge PoC - ${config.parties[config.partyId].name}`);
  console.log(`  Party ID: ${config.partyId}`);
  console.log(`  Threshold: ${config.threshold} of ${config.totalParties}`);
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

  // Register P2P message handlers for signing
  registerSigningHandlers();

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
    await sleep(config.session.intervalMs);
  }
}

/**
 * Run a single signing session.
 * Handles both directions: EVM->Zano and Zano->EVM.
 *
 * Bridgeless ref: tss-svc/internal/tss/session/signing/evm/session.go Run()
 */
async function runSigningSession() {
  sessionCounter++;

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

    // Signing phase
    const amISigner = result.signers.includes(config.partyId);
    if (!amISigner) {
      console.log('[Session] Not selected as signer, waiting for result');
      continue;
    }

    console.log('[Session] Selected as signer, running signing phase');

    if (destChain === 'zano') {
      await handleZanoSigning(sessionId, result);
    } else {
      await handleEvmSigning(sessionId, result);
    }
  }
}

/**
 * Handle signing for EVM -> Zano direction.
 * Creates unsigned Zano tx, signs it, broadcasts (if leader).
 *
 * Bridgeless ref: tss-svc/internal/tss/session/signing/zano/session.go runSession()
 */
async function handleZanoSigning(sessionId, result) {
  const { deposit, signers } = result;
  const isLeader = determineLeader(sessionId) === config.partyId;

  // Paper Algorithm 7, Line 2: require status == PROCESSED before finalization.
  // Guard against signing a deposit that was already finalized or reverted.
  if (deposit.status && deposit.status !== 'processing' && deposit.status !== 'pending') {
    console.log(`[Zano Signing] Skipping deposit ${deposit.id}: status is '${deposit.status}'`);
    return;
  }

  try {
    // Leader creates the unsigned transaction and signs
    if (isLeader) {
      const zanoResult = await processZanoWithdrawal(deposit);

      // Broadcast unsigned tx data + our signature to other signers
      await broadcast({
        sessionId,
        type: 'zano_sign_request',
        data: {
          unsignedTxData: zanoResult.unsignedTxData,
          leaderSignature: zanoResult.signature,
        },
      });

      // Wait for other signer's signature
      const otherSigs = await waitForSignatures(sessionId, 'zano_signature', 1);

      // In TSS: the combined signature is produced cooperatively.
      // In PoC: the leader collects signatures. For Zano, only ONE signature
      // is needed (the TSS group signature). In PoC, we use the leader's signature.
      //
      // This is where TSS vs PoC diverges:
      // - TSS: 2 parties cooperate to produce 1 combined ECDSA signature
      // - PoC: leader signs alone (for simplicity), but we demonstrate the flow

      await broadcastSignedZanoTx(zanoResult.unsignedTxData, zanoResult.signature.signature);
      updateDepositStatus(deposit.id, 'finalized');
      console.log('[Zano Signing] Transaction finalized!');
    } else {
      // Non-leader: wait for signing request, sign, return
      // This would be handled by the message handler
      console.log('[Zano Signing] Waiting for leader signing request...');
    }
  } catch (err) {
    console.error('[Zano Signing] Error:', err.message);
    // Paper Algorithm 3, Lines 27-30: revert to PENDING on failure so the
    // deposit gets retried in the next session. Marking as 'failed' would
    // permanently block the deposit, violating bridge liveness (Theorem 1).
    updateDepositStatus(deposit.id, 'pending');
  }
}

/**
 * Handle signing for Zano -> EVM direction.
 * Computes EVM hash, signs it, collects threshold signatures,
 * then the leader auto-submits the withdrawal on-chain.
 *
 * Bridgeless ref: tss-svc/internal/tss/session/signing/evm/session.go runSession()
 */
async function handleEvmSigning(sessionId, result) {
  const { deposit, signers } = result;
  const isLeader = determineLeader(sessionId) === config.partyId;

  // Paper Algorithm 7, Line 2: require status == PROCESSED before finalization.
  // Guard against signing a deposit that was already finalized or reverted.
  if (deposit.status && deposit.status !== 'processing' && deposit.status !== 'pending') {
    console.log(`[EVM Signing] Skipping deposit ${deposit.id}: status is '${deposit.status}'`);
    return;
  }

  try {
    // Sign the EVM withdrawal hash
    const sigResult = await signEvmWithdrawal(deposit);
    console.log(`[EVM Signing] Signed by ${sigResult.signer}`);

    // Broadcast our signature to other parties
    await broadcast({
      sessionId,
      type: 'evm_signature',
      data: {
        depositId: deposit.id,
        signature: sigResult.signature,
        signer: sigResult.signer,
      },
    });

    // Collect signatures from other signers, verifying each one
    // Paper Algorithm 6, Lines 9-10: verify(pk, signHash, signature) before accepting
    const hash = computeErc20SignHash(
      resolveEvmTokenAddress(deposit.token_address),
      deposit.amount,
      deposit.receiver,
      ethers.zeroPadBytes(deposit.tx_hash, 32),
      deposit.tx_nonce,
      config.evm.chainId,
      false, // isWrapped
    );
    const otherSigs = await waitForSignatures(sessionId, 'evm_signature', config.threshold - 1, hash);
    const allSigs = [sigResult, ...otherSigs.map(s => s.data)];

    console.log(`[EVM Signing] Collected ${allSigs.length} signatures`);

    // Store signatures
    updateDepositStatus(
      deposit.id,
      'signed',
      allSigs.map(s => ({ signature: s.signature, signer: s.signer })),
    );

    // Leader auto-submits the withdrawal on-chain
    if (isLeader) {
      console.log('[EVM Signing] Leader submitting withdrawal on-chain...');
      await submitEvmWithdrawal(deposit, allSigs);
    } else {
      console.log('[EVM Signing] Signatures stored. Leader will submit on-chain.');
    }
  } catch (err) {
    console.error('[EVM Signing] Error:', err.message);
    // Paper Algorithm 3, Lines 27-30: revert to PENDING on failure so the
    // deposit gets retried in the next session. Marking as 'failed' would
    // permanently block the deposit, violating bridge liveness (Theorem 1).
    updateDepositStatus(deposit.id, 'pending');
  }
}

/**
 * Submit the EVM withdrawal transaction on-chain.
 * Called by the leader after collecting threshold signatures.
 */
async function submitEvmWithdrawal(deposit, allSigs) {
  const BRIDGE_ABI = [
    'function withdrawERC20(address token, uint256 amount, address receiver, bytes32 txHash, uint256 txNonce, bool isWrapped, bytes[] signatures) external',
  ];

  try {
    const provider = new ethers.JsonRpcProvider(config.evm.rpc);
    const myKey = config.partyKeys[config.partyId];
    const wallet = new ethers.Wallet(myKey.privateKey, provider);
    const bridge = new ethers.Contract(config.evm.bridgeAddress, BRIDGE_ABI, wallet);

    const evmTokenAddress = resolveEvmTokenAddress(deposit.token_address);
    const txHash = ethers.zeroPadBytes(deposit.tx_hash, 32);
    const signatures = formatSignaturesForContract(allSigs);

    console.log(`[EVM Submit] Token: ${evmTokenAddress}`);
    console.log(`[EVM Submit] Amount: ${deposit.amount}`);
    console.log(`[EVM Submit] Receiver: ${deposit.receiver}`);
    console.log(`[EVM Submit] Signatures: ${signatures.length}`);

    const tx = await bridge.withdrawERC20(
      evmTokenAddress,
      deposit.amount,
      deposit.receiver,
      txHash,
      deposit.tx_nonce,
      false, // Custody model: release locked dEURO from bridge
      signatures,
    );

    console.log(`[EVM Submit] Tx hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[EVM Submit] Confirmed in block ${receipt.blockNumber}`);

    updateDepositStatus(deposit.id, 'finalized');
    console.log('[EVM Submit] Withdrawal finalized!');
  } catch (err) {
    console.error('[EVM Submit] Failed:', err.message);
    // Keep status as 'signed' so it can be retried or manually submitted
  }
}

/**
 * Register handlers for signing-related P2P messages.
 */
function registerSigningHandlers() {
  // Handle Zano signing requests from leader
  onMessage('zano_sign_request', async (msg) => {
    console.log(`[P2P] Received Zano sign request from party ${msg.sender}`);

    const { unsignedTxData } = msg.data;
    const mySig = await signZanoTxHash(unsignedTxData.sigData);

    // Send signature back
    const { sendToParty } = await import('./p2p.js');
    await sendToParty(msg.sender, {
      sessionId: msg.sessionId,
      type: 'zano_signature',
      data: { signature: mySig },
    });
  });

  // Handle EVM signature broadcasts (for collection)
  onMessage('evm_signature', (msg) => {
    console.log(`[P2P] Received EVM signature from party ${msg.sender}`);
    // Stored via waitForSignatures collector
  });
}

/**
 * Wait for N signatures from other parties.
 * If signHash is provided, each signature is verified before acceptance.
 *
 * Paper ref: Algorithm 6, Lines 9-10 — validators verify received signatures
 * before accepting them: if binance-TSS.verify(pk, signHash, signature) then return
 *
 * Without verification, a malicious party could send garbage signatures,
 * causing the leader to waste gas on a reverting on-chain transaction.
 */
function waitForSignatures(sessionId, type, count, signHash = null) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const seenSigners = new Set(); // Deduplicate by signer address
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${count} signatures`));
    }, config.session.signingTimeoutMs);

    // Our own address — reject relayed copies of our own signature
    const myAddress = config.partyKeys?.[config.partyId]?.address?.toLowerCase();

    const handler = (msg) => {
      if (msg.sessionId !== sessionId) return;

      // Verify signature if signHash provided (Paper Algorithm 6, Lines 9-10)
      if (signHash && msg.data?.signature && msg.data?.signer) {
        const signerAddr = msg.data.signer.toLowerCase();

        // Paper Algorithm 6, Line 6: only accept from parties in signers set.
        // Reject our own signature relayed back by a malicious party.
        if (signerAddr === myAddress) {
          console.error(`[Signing] Rejected relayed copy of own signature`);
          return;
        }

        // Deduplicate by signer address — prevent counting same signer twice.
        // On-chain bitmap would catch this (Signers.sol), but reject early to
        // avoid wasting gas on a reverting transaction.
        if (seenSigners.has(signerAddr)) {
          console.error(`[Signing] Rejected duplicate signature from ${signerAddr}`);
          return;
        }

        const valid = verifySignature(signHash, msg.data.signature, msg.data.signer);
        if (!valid) {
          console.error(`[Signing] Rejected invalid signature from party ${msg.sender}`);
          return;
        }

        // Verify the signer is a registered party
        const isParty = config.partyKeys?.some(k => k.address.toLowerCase() === signerAddr);
        if (!isParty) {
          console.error(`[Signing] Rejected signature from unknown signer: ${msg.data.signer}`);
          return;
        }

        seenSigners.add(signerAddr);
      }

      collected.push(msg);
      if (collected.length >= count) {
        clearTimeout(timeout);
        resolve(collected);
      }
    };

    onMessage(type, handler);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
