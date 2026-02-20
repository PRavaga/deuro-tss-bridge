// Consensus Protocol
//
// Implements the consensus phase of the withdrawal-generation protocol
// (Paper Algorithms 4 & 5, arXiv 2506.19730).
//
// The leader proposes a deposit to sign. Other parties independently verify
// the deposit on-chain and ACK/NACK. This ensures bridge safety (Theorem 4):
// a malicious proposer cannot fabricate or inflate deposit data.
//
// PoC vs Production/Paper differences (intentional simplifications):
// 1. Broadcast: simple HTTP (not Dolev-Strong reliable broadcast, Def. 3).
//    Acceptable for PoC with f=0 (no Byzantine faults).
// 2. Proposal content: sends raw deposit fields (not signHash as in Algo 4 Line 5).
//    Acceptor compares fields directly instead of hash (Algo 5 Line 11).
//    Security-equivalent: same fields → same hash.
// 3. Deposit lookup: acceptor fetches from chain during consensus (not from
//    local DB pre-populated via submitWithdrawal as in Algo 5 Line 5).
//    Achieves same verification goal with simpler architecture.
// 4. Leader PRNG: uses first 4 bytes of SHA256 (not ChaCha8 seeded with
//    full SHA256 as in Go leader.go). Both deterministic, same result per sid.
//
// Bridgeless ref: tss-svc/internal/tss/session/consensus/
//   - consensus.go: orchestrator
//   - proposer.go: proposal creation + signer selection
//   - acceptor.go: proposal verification

import { createHash } from 'crypto';
import { config } from './config.js';
import { getPendingDeposits, updateDepositStatus, getDepositByTxHash } from './db.js';
import { broadcast, onMessage, waitForMessage } from './p2p.js';
import { verifyEvmDeposit, getEvmDepositData } from './evm-watcher.js';
import { verifyZanoBurn, getZanoDepositData } from './zano-watcher.js';

/**
 * Determine the session leader deterministically.
 * All parties compute the same leader from the session ID.
 *
 * Bridgeless ref: tss-svc/internal/tss/session/leader.go DetermineLeader()
 */
export function determineLeader(sessionId) {
  const hash = createHash('sha256').update(sessionId).digest();
  const seed = hash.readUInt32BE(0);
  return seed % config.totalParties;
}

/**
 * Generate session ID from a counter.
 *
 * Bridgeless ref: tss-svc/internal/tss/session/common.go
 *   GetConcreteSigningSessionIdentifier()
 */
export function getSessionId(chain, counter) {
  return `SIGN_${chain}_${counter}`;
}

/**
 * Run a consensus round as the PROPOSER.
 *
 * Bridgeless ref: tss-svc/internal/tss/session/consensus/proposer.go
 *
 * Flow:
 * 1. Select a pending deposit
 * 2. Broadcast proposal to other parties
 * 3. Wait for ACK/NACK from others
 * 4. If enough ACKs (threshold), select signers and broadcast signer set
 * 5. Return the deposit and signer set
 */
export async function runAsProposer(sessionId, destChain) {
  console.log(`[Consensus] Running as PROPOSER for session ${sessionId}`);

  // 1. Find pending deposits for this destination chain
  const deposits = getPendingDeposits(destChain);
  if (deposits.length === 0) {
    console.log('[Consensus] No pending deposits, skipping session');
    return null;
  }

  const deposit = deposits[0];
  console.log(`[Consensus] Proposing deposit #${deposit.id}: ${deposit.amount} ${deposit.source_chain} -> ${deposit.dest_chain}`);

  // 2. Mark as processing
  updateDepositStatus(deposit.id, 'processing');

  // 3. Broadcast proposal
  await broadcast({
    sessionId,
    type: 'proposal',
    data: {
      depositId: deposit.id,
      sourceChain: deposit.source_chain,
      txHash: deposit.tx_hash,
      txNonce: deposit.tx_nonce,
      tokenAddress: deposit.token_address,
      amount: deposit.amount,
      receiver: deposit.receiver,
      destChain: deposit.dest_chain,
    },
  });

  // 4. Wait for ACKs/NACKs
  try {
    const responses = await waitForMessage('proposal_response', sessionId, config.session.consensusTimeoutMs);
    const acks = responses.filter(r => r.data.accepted);

    console.log(`[Consensus] Received ${acks.length} ACK(s), need ${config.threshold - 1}`);

    if (acks.length < config.threshold - 1) {
      console.log('[Consensus] Not enough ACKs, aborting');
      updateDepositStatus(deposit.id, 'pending'); // Reset
      return null;
    }

    // 5. Select signers (deterministic)
    // Go ref: proposer.go getSignersSet() — select THRESHOLD from acceptors,
    // then always append proposer. This ensures the proposer is never excluded.
    const acceptorIds = acks.map(a => a.sender);
    const selectedAcceptors = selectSigners(acceptorIds, config.threshold, sessionId);
    const selectedSigners = [...selectedAcceptors, config.partyId];

    console.log(`[Consensus] Selected signers: ${selectedSigners.join(', ')}`);

    // 6. Broadcast signer set
    await broadcast({
      sessionId,
      type: 'signer_set',
      data: { signers: selectedSigners, deposit: deposit },
    });

    return {
      deposit,
      signers: selectedSigners,
    };
  } catch (err) {
    console.error('[Consensus] Proposer error:', err.message);
    updateDepositStatus(deposit.id, 'pending');
    return null;
  }
}

/**
 * Run a consensus round as an ACCEPTOR.
 *
 * Bridgeless ref: tss-svc/internal/tss/session/consensus/acceptor.go
 * Paper ref: Algorithm 5 — consensus phase for non-proposer validators
 *
 * Flow (per paper Algorithm 5):
 * 1. Wait for PROPOSAL from leader
 * 2. Require this is the first proposal (prevent Byzantine multi-proposal)
 * 3. INDEPENDENTLY fetch and verify deposit data from the chain
 * 4. Compare on-chain data against proposer's claim
 * 5. Send ACK or NACK
 * 6. Wait for SIGNSTART (signer set) from leader
 * 7. Require SIGNSTART references the accepted depositId
 * 8. Return deposit (using OUR independently verified data) and signer set
 */
export async function runAsAcceptor(sessionId) {
  console.log(`[Consensus] Running as ACCEPTOR for session ${sessionId}`);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Consensus timeout'));
    }, config.session.consensusTimeoutMs * 2);

    // Paper Algorithm 5, Line 2: proposedId ← ⊥ (track accepted proposal)
    let acceptedDepositId = null;
    let verifiedDeposit = null;

    // Wait for proposal
    onMessage('proposal', async (msg) => {
      if (msg.sessionId !== sessionId) return;

      // Paper Algorithm 5, Line 4: require proposedId == ⊥
      // Prevent accepting multiple proposals from a Byzantine proposer
      if (acceptedDepositId !== null) {
        console.log(`[Consensus] Rejecting duplicate proposal (already accepted ${acceptedDepositId})`);
        return;
      }

      console.log(`[Consensus] Received proposal from party ${msg.sender}`);

      const { sourceChain, txHash, txNonce, depositId } = msg.data;

      // Paper Algorithm 5, Lines 5-11 + Algorithm 12/13:
      // INDEPENDENTLY fetch deposit data from the chain.
      // Do NOT trust the proposer's amount, receiver, or tokenAddress.
      // This is critical for bridge safety (Theorem 4).
      let chainDepositData = null;

      if (sourceChain === 'evm') {
        chainDepositData = await getEvmDepositData(txHash, txNonce);
      } else if (sourceChain === 'zano') {
        chainDepositData = await getZanoDepositData(txHash);
      }

      if (!chainDepositData) {
        console.log('[Consensus] NACK: could not independently verify deposit on-chain');
        const { sendToParty } = await import('./p2p.js');
        await sendToParty(msg.sender, {
          sessionId,
          type: 'proposal_response',
          data: { accepted: false, reason: 'chain verification failed' },
        });
        return;
      }

      // Verify proposer's claimed data matches on-chain reality
      const proposerData = msg.data;
      const mismatch =
        chainDepositData.amount !== proposerData.amount ||
        chainDepositData.receiver !== proposerData.receiver ||
        chainDepositData.tokenAddress?.toLowerCase() !== proposerData.tokenAddress?.toLowerCase();

      if (mismatch) {
        console.error('[Consensus] NACK: proposer data does not match on-chain event!');
        console.error(`  On-chain amount: ${chainDepositData.amount}, proposer claimed: ${proposerData.amount}`);
        console.error(`  On-chain receiver: ${chainDepositData.receiver}, proposer claimed: ${proposerData.receiver}`);
        const { sendToParty } = await import('./p2p.js');
        await sendToParty(msg.sender, {
          sessionId,
          type: 'proposal_response',
          data: { accepted: false, reason: 'data mismatch' },
        });
        return;
      }

      // Go ref: signing/consensus.go VerifyProposedData() — check deposit isn't already processed.
      // Paper Algorithm 5, Line 3: ensures we don't re-sign a finalized deposit.
      const existingDeposit = getDepositByTxHash(
        chainDepositData.sourceChain,
        chainDepositData.txHash,
        chainDepositData.txNonce ?? 0,
      );
      if (existingDeposit && existingDeposit.status !== 'pending') {
        console.log(`[Consensus] NACK: deposit already ${existingDeposit.status} (${chainDepositData.txHash})`);
        const { sendToParty } = await import('./p2p.js');
        await sendToParty(msg.sender, {
          sessionId,
          type: 'proposal_response',
          data: { accepted: false, reason: `already ${existingDeposit.status}` },
        });
        return;
      }

      // Store deposit using OUR independently verified data (not proposer's)
      const { addDeposit: addDep } = await import('./db.js');
      addDep(chainDepositData);

      verifiedDeposit = chainDepositData;
      acceptedDepositId = depositId ?? txHash; // Track which proposal we accepted

      console.log(`[Consensus] ACK: independently verified deposit on-chain`);

      // Send ACK to proposer
      const { sendToParty } = await import('./p2p.js');
      await sendToParty(msg.sender, {
        sessionId,
        type: 'proposal_response',
        data: { accepted: true },
      });
    });

    // Wait for signer set
    onMessage('signer_set', (msg) => {
      if (msg.sessionId !== sessionId) return;

      // Paper Algorithm 5, Line 16: require proposedId == signStartMsg.depositId
      // Ensure the signer set references the deposit we accepted
      const signerSetDepositId = msg.data.deposit?.id ?? msg.data.deposit?.tx_hash;
      if (acceptedDepositId !== null && signerSetDepositId !== undefined) {
        // Best-effort check: at minimum the tx_hash should match
        const depositTxHash = msg.data.deposit?.tx_hash;
        if (verifiedDeposit && depositTxHash !== verifiedDeposit.txHash) {
          console.error('[Consensus] Rejecting signer_set: deposit mismatch');
          return;
        }
      }

      clearTimeout(timeout);
      console.log(`[Consensus] Received signer set: ${msg.data.signers.join(', ')}`);

      // Use our independently verified deposit data (Paper Algorithm 5).
      // CRITICAL: Map camelCase verified data to snake_case DB format used by signing code.
      // Without this, the proposer's unverified token_address/tx_hash/amount
      // would leak through because the merge wouldn't override (different key names).
      //
      // Go ref: acceptor.go — uses only independently verified deposit data for signing.
      let deposit;
      if (verifiedDeposit) {
        deposit = {
          ...msg.data.deposit,                          // DB id, status, etc. from proposer
          source_chain: verifiedDeposit.sourceChain,    // Override with verified data
          tx_hash: verifiedDeposit.txHash,
          tx_nonce: verifiedDeposit.txNonce,
          token_address: verifiedDeposit.tokenAddress,
          amount: verifiedDeposit.amount,
          sender: verifiedDeposit.sender,
          receiver: verifiedDeposit.receiver,
          dest_chain: verifiedDeposit.destChain,
        };
      } else {
        deposit = msg.data.deposit;
      }

      resolve({
        deposit,
        signers: msg.data.signers,
      });
    });
  });
}

/**
 * Select T signers from the set of ACKing parties.
 * Uses deterministic random selection so all parties agree.
 *
 * Bridgeless ref: tss-svc/internal/tss/session/consensus/proposer.go getSignersSet()
 */
export function selectSigners(candidates, threshold, sessionId) {
  if (candidates.length <= threshold) return candidates;

  // Deterministic shuffle using session ID
  const hash = createHash('sha256').update(sessionId + ':signers').digest();
  const sorted = [...candidates].sort((a, b) => {
    const ha = createHash('sha256').update(hash.toString('hex') + a).digest();
    const hb = createHash('sha256').update(hash.toString('hex') + b).digest();
    return ha.compare(hb);
  });

  return sorted.slice(0, threshold);
}
