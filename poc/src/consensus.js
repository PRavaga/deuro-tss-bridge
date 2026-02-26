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
import { ethers } from 'ethers';
import { config } from './config.js';
import { getPendingDeposits, updateDepositStatus, getDepositByTxHash } from './db.js';
import { broadcast, onMessage, waitForMessage } from './p2p.js';
import { verifyEvmDeposit, getEvmDepositData } from './evm-watcher.js';
import { verifyZanoBurn, getZanoDepositData } from './zano-watcher.js';
import { computeErc20SignHash, resolveEvmTokenAddress } from './evm-signer.js';

// Per-session message buffers.
// Proposals and signer sets that arrive before the acceptor registers its handler
// are stored here so they aren't lost when a subsequent session overwrites the handler.
const proposalBuffer = new Map();   // sessionId -> msg
const signerSetBuffer = new Map();  // sessionId -> msg

// Track which sessions have already received a proposal (Paper Algo 5, Line 4).
// Prevents a Byzantine proposer from sending multiple proposals in the same session.
const deliveredProposals = new Map(); // sessionId -> sender

// Install persistent handlers (once) that buffer messages by sessionId.
// Session-specific resolve functions are stored and called when messages arrive.
const proposalResolvers = new Map();   // sessionId -> (msg) => void
const signerSetResolvers = new Map();  // sessionId -> (msg) => void

let handlersInstalled = false;
function installBufferingHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  onMessage('proposal', (msg) => {
    const sid = msg.sessionId;

    // Paper Algorithm 5, Line 4: require proposedId == null
    // Reject duplicate proposals for the same session (Byzantine equivocation guard)
    if (deliveredProposals.has(sid)) {
      console.warn(`[Consensus] Rejecting duplicate proposal for session ${sid} from party ${msg.sender} (already received from ${deliveredProposals.get(sid)})`);
      return;
    }
    deliveredProposals.set(sid, msg.sender);

    const resolver = proposalResolvers.get(sid);
    if (resolver) {
      proposalResolvers.delete(sid);
      resolver(msg);
    } else {
      // Buffer for later
      proposalBuffer.set(sid, msg);
    }
  });

  onMessage('signer_set', (msg) => {
    const sid = msg.sessionId;
    const resolver = signerSetResolvers.get(sid);
    if (resolver) {
      signerSetResolvers.delete(sid);
      resolver(msg);
    } else {
      signerSetBuffer.set(sid, msg);
    }
  });
}

/**
 * Compute adjacent session IDs (±1 epoch) for clock-drift tolerance.
 * If server clocks diverge, the proposer's epoch may differ from ours by 1.
 * Checking adjacent epochs prevents missed proposals due to NTP drift or
 * epoch-boundary timing.
 */
function getAdjacentSessionIds(sessionId) {
  const parts = sessionId.split('_');
  const counter = parseInt(parts[parts.length - 1]);
  const prefix = parts.slice(0, -1).join('_');
  return [
    sessionId,
    `${prefix}_${counter - 1}`,
    `${prefix}_${counter + 1}`,
  ];
}

/**
 * Wait for a proposal for a specific session (or adjacent epoch ±1).
 * Checks the buffer first, then waits for the message to arrive.
 * Returns the proposal with the proposer's actual session ID.
 */
function waitForProposal(sessionId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const candidates = getAdjacentSessionIds(sessionId);

    // Check buffer for exact match first, then adjacent
    for (const sid of candidates) {
      const buffered = proposalBuffer.get(sid);
      if (buffered) {
        proposalBuffer.delete(sid);
        resolve(buffered);
        return;
      }
    }

    const timer = setTimeout(() => {
      for (const sid of candidates) proposalResolvers.delete(sid);
      reject(new Error('Consensus timeout'));
    }, timeoutMs);

    // Register resolvers for all candidate sessions
    const onResolved = (msg) => {
      clearTimeout(timer);
      for (const sid of candidates) proposalResolvers.delete(sid);
      resolve(msg);
    };
    for (const sid of candidates) {
      proposalResolvers.set(sid, onResolved);
    }
  });
}

/**
 * Wait for a signer set for a specific session (or adjacent epoch ±1).
 */
function waitForSignerSet(sessionId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const candidates = getAdjacentSessionIds(sessionId);

    for (const sid of candidates) {
      const buffered = signerSetBuffer.get(sid);
      if (buffered) {
        signerSetBuffer.delete(sid);
        resolve(buffered);
        return;
      }
    }

    const timer = setTimeout(() => {
      for (const sid of candidates) signerSetResolvers.delete(sid);
      reject(new Error('Consensus timeout'));
    }, timeoutMs);

    const onResolved = (msg) => {
      clearTimeout(timer);
      for (const sid of candidates) signerSetResolvers.delete(sid);
      resolve(msg);
    };
    for (const sid of candidates) {
      signerSetResolvers.set(sid, onResolved);
    }
  });
}

/**
 * Clean up stale buffer entries from previous sessions.
 * Called at the start of each session to prevent unbounded memory growth.
 * Keeps only entries from the last `keepCount` sessions.
 *
 * @param {number} currentCounter  The current session counter
 * @param {number} keepCount       Number of recent sessions to keep (default 5)
 */
export function cleanupBuffers(currentCounter, keepCount = 5) {
  const threshold = currentCounter - keepCount;
  for (const map of [proposalBuffer, signerSetBuffer, deliveredProposals, proposalResolvers, signerSetResolvers]) {
    for (const key of map.keys()) {
      // Session IDs are formatted as SIGN_{chain}_{counter}
      const parts = key.split('_');
      const counter = parseInt(parts[parts.length - 1]);
      if (!isNaN(counter) && counter < threshold) {
        map.delete(key);
      }
    }
  }
}

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

  // 2. Mark as processing (update both DB and in-memory object)
  updateDepositStatus(deposit.id, 'processing');
  deposit.status = 'processing';

  // Paper Algorithm 4, Line 4: compute signHash = targetClient.getHashOfWithdrawal()
  // For EVM target chain, this is deterministic. For Zano, it depends on the unsigned tx
  // which hasn't been created yet, so signHash is null for Zano direction.
  let signHash = null;
  if (destChain === 'evm') {
    const evmTokenAddress = resolveEvmTokenAddress(deposit.token_address);
    const txHash = ethers.zeroPadBytes(
      deposit.tx_hash.startsWith('0x') ? deposit.tx_hash : '0x' + deposit.tx_hash, 32);
    signHash = computeErc20SignHash(
      evmTokenAddress, deposit.amount, deposit.receiver,
      txHash, deposit.tx_nonce, config.evm.chainId, true);
  }

  // 3. Broadcast proposal (Paper Algorithm 4, Line 5-6)
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
      signHash, // Paper Algo 4, Line 5: include signHash in proposal
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

  installBufferingHandlers();

  // 1. Wait for proposal (with buffer check)
  let proposalMsg;
  try {
    proposalMsg = await waitForProposal(sessionId, config.session.consensusTimeoutMs * 2);
  } catch {
    throw new Error('Consensus timeout');
  }

  // Use the proposer's session ID for all subsequent messages.
  // With time-based epochs, the proposer may be ±1 epoch from us (clock drift).
  // We must reply on the proposer's session so it receives our ACK/NACK.
  const proposerSessionId = proposalMsg.sessionId || sessionId;
  if (proposerSessionId !== sessionId) {
    console.log(`[Consensus] Accepted proposal from adjacent epoch: ${proposerSessionId} (ours: ${sessionId})`);
  }
  console.log(`[Consensus] Received proposal from party ${proposalMsg.sender}`);

  const { sourceChain, txHash, txNonce, depositId } = proposalMsg.data;

  // Paper Algorithm 5, Lines 5-11 + Algorithm 12/13:
  // INDEPENDENTLY fetch deposit data from the chain.
  let chainDepositData = null;
  if (sourceChain === 'evm') {
    chainDepositData = await getEvmDepositData(txHash, txNonce);
  } else if (sourceChain === 'zano') {
    chainDepositData = await getZanoDepositData(txHash);
  }

  const { sendToParty } = await import('./p2p.js');

  if (!chainDepositData) {
    console.log('[Consensus] NACK: could not independently verify deposit on-chain');
    await sendToParty(proposalMsg.sender, {
      sessionId: proposerSessionId,
      type: 'proposal_response',
      data: { accepted: false, reason: 'chain verification failed' },
    });
    return null;
  }

  // Verify proposer's claimed data matches on-chain reality
  const proposerData = proposalMsg.data;
  const mismatch =
    chainDepositData.amount !== proposerData.amount ||
    chainDepositData.receiver !== proposerData.receiver ||
    chainDepositData.tokenAddress?.toLowerCase() !== proposerData.tokenAddress?.toLowerCase();

  if (mismatch) {
    console.error('[Consensus] NACK: proposer data does not match on-chain event!');
    console.error(`  On-chain amount: ${chainDepositData.amount}, proposer claimed: ${proposerData.amount}`);
    console.error(`  On-chain receiver: ${chainDepositData.receiver}, proposer claimed: ${proposerData.receiver}`);
    await sendToParty(proposalMsg.sender, {
      sessionId: proposerSessionId,
      type: 'proposal_response',
      data: { accepted: false, reason: 'data mismatch' },
    });
    return null;
  }

  // Paper Algorithm 5, Line 11: verify signHash matches independently computed value.
  // For EVM target chain, signHash is deterministic from deposit fields — acceptor
  // recomputes from its own chain data and compares against proposer's claim.
  // For Zano direction, signHash is null (depends on unsigned tx created during signing).
  if (proposerData.signHash && chainDepositData.destChain === 'evm') {
    const evmTokenAddress = resolveEvmTokenAddress(chainDepositData.tokenAddress);
    const paddedTxHash = ethers.zeroPadBytes(
      chainDepositData.txHash.startsWith('0x') ? chainDepositData.txHash : '0x' + chainDepositData.txHash, 32);
    const acceptorSignHash = computeErc20SignHash(
      evmTokenAddress, chainDepositData.amount, chainDepositData.receiver,
      paddedTxHash, chainDepositData.txNonce ?? 0, config.evm.chainId, true);

    if (acceptorSignHash !== proposerData.signHash) {
      console.error('[Consensus] NACK: signHash mismatch!');
      console.error(`  Acceptor computed: ${acceptorSignHash}`);
      console.error(`  Proposer claimed:  ${proposerData.signHash}`);
      await sendToParty(proposalMsg.sender, {
        sessionId: proposerSessionId,
        type: 'proposal_response',
        data: { accepted: false, reason: 'signHash mismatch' },
      });
      return null;
    }
    console.log(`[Consensus] signHash verified: ${acceptorSignHash.slice(0, 18)}...`);
  }

  // Check deposit isn't already processed
  const existingDeposit = getDepositByTxHash(
    chainDepositData.sourceChain,
    chainDepositData.txHash,
    chainDepositData.txNonce ?? 0,
  );
  if (existingDeposit && existingDeposit.status !== 'pending') {
    console.log(`[Consensus] NACK: deposit already ${existingDeposit.status} (${chainDepositData.txHash})`);
    await sendToParty(proposalMsg.sender, {
      sessionId: proposerSessionId,
      type: 'proposal_response',
      data: { accepted: false, reason: `already ${existingDeposit.status}` },
    });
    return null;
  }

  // Store deposit using OUR independently verified data (not proposer's)
  const { addDeposit: addDep } = await import('./db.js');
  addDep(chainDepositData);

  console.log(`[Consensus] ACK: independently verified deposit on-chain`);

  // Send ACK to proposer (using proposer's session ID)
  await sendToParty(proposalMsg.sender, {
    sessionId: proposerSessionId,
    type: 'proposal_response',
    data: { accepted: true },
  });

  // 2. Wait for signer set (using proposer's session ID)
  let signerSetMsg;
  try {
    signerSetMsg = await waitForSignerSet(proposerSessionId, config.session.consensusTimeoutMs * 2);
  } catch {
    throw new Error('Consensus timeout waiting for signer set');
  }

  // Paper Algorithm 5, Line 16: validate signer set references our accepted deposit
  const depositTxHash = signerSetMsg.data.deposit?.tx_hash;
  if (depositTxHash && depositTxHash !== chainDepositData.txHash) {
    console.error('[Consensus] Rejecting signer_set: deposit mismatch');
    return null;
  }

  console.log(`[Consensus] Received signer set: ${signerSetMsg.data.signers.join(', ')}`);

  // Use our independently verified deposit data (Paper Algorithm 5).
  // Map camelCase verified data to snake_case DB format used by signing code.
  const deposit = {
    ...signerSetMsg.data.deposit,
    source_chain: chainDepositData.sourceChain,
    tx_hash: chainDepositData.txHash,
    tx_nonce: chainDepositData.txNonce,
    token_address: chainDepositData.tokenAddress,
    amount: chainDepositData.amount,
    sender: chainDepositData.sender,
    receiver: chainDepositData.receiver,
    dest_chain: chainDepositData.destChain,
  };

  return {
    deposit,
    signers: signerSetMsg.data.signers,
    sessionId: proposerSessionId, // Actual session ID (may differ from ours by ±1 epoch)
  };
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
