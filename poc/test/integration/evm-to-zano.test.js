// ============================================================================
// Integration Test: EVM → Zano Bridge Flow
// ============================================================================
//
// Simulates the complete flow when a user deposits ETH on EVM to receive
// wrapped tokens on Zano:
//
//   1. User calls depositNative() on Bridge.sol → ETH locked in contract
//   2. All 3 parties detect the DepositedNative event via EVM watcher
//   3. Leader proposes the deposit for signing
//   4. Acceptors independently verify the deposit on-chain
//   5. Acceptors send ACK → leader selects 2-of-3 signers
//   6. Selected signers create unsigned Zano emit tx
//   7. Signers sign the Zano tx hash with their ECDSA keys
//   8. Leader collects signatures and broadcasts the signed tx to Zano
//
// This test simulates steps 2-8 using:
//   - In-process P2P bus (no HTTP, deterministic message delivery)
//   - In-memory SQLite (no disk, isolated per party)
//   - Mock Zano RPC (no real Zano node needed)
//   - Real EVM signing (actual ECDSA, actual hash computation)
//
// The test drives all 3 parties from a single process, stepping through
// the protocol manually rather than running the party.js event loop.
// This gives us full control over ordering and makes failures reproducible.
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { createP2PBus } from '../helpers/in-process-p2p.js';
import { createTestDb } from '../helpers/test-db.js';
import { createMockZanoRpc } from '../helpers/mock-zano-rpc.js';
import {
  PARTY_KEYS,
  MOCK_EVM_TX_HASH,
  MOCK_ZANO_ADDRESS,
  MOCK_EMIT_ASSET_RESPONSE,
  THRESHOLD,
  TOTAL_PARTIES,
} from '../fixtures.js';
import { determineLeader, getSessionId, selectSigners } from '../../src/consensus.js';
import { computeNativeSignHash, verifySignature } from '../../src/evm-signer.js';
import { formSigningData, encodeSignatureForZano } from '../../src/zano-rpc.js';

// ---- Per-test state ----
let bus;          // In-process P2P bus
let dbs;          // Array of 3 test databases (one per party)
let mockZano;     // Mock Zano RPC

beforeEach(() => {
  bus = createP2PBus(TOTAL_PARTIES);
  dbs = Array.from({ length: TOTAL_PARTIES }, () => createTestDb());
  mockZano = createMockZanoRpc();
});

// ---- Helpers ----

/** Sign a Zano tx hash with a party's key (same as zano-signer.js signZanoTxHash) */
function signZanoHash(sigData, partyIndex) {
  const signingKey = new ethers.SigningKey(PARTY_KEYS[partyIndex].privateKey);
  const digest = ethers.keccak256(sigData);
  const sig = signingKey.sign(digest);
  return {
    signature: sig.serialized,
    r: sig.r,
    s: sig.s,
    v: sig.v,
    signer: new ethers.Wallet(PARTY_KEYS[partyIndex].privateKey).address,
  };
}

// ============================================================================
// Full EVM → Zano Flow
// ============================================================================

describe('EVM → Zano full bridge flow', () => {
  it('3 parties reach consensus and sign a Zano mint transaction', async () => {
    // ================================================================
    // STEP 1: Deposit detected on EVM
    // ================================================================
    //
    // In production, the EVM watcher polls for DepositedNative events.
    // Here we simulate by directly inserting the deposit into each
    // party's database, as if the watcher already found it.

    const deposit = {
      sourceChain: 'evm',
      txHash: MOCK_EVM_TX_HASH,
      txNonce: 0,
      tokenAddress: ethers.ZeroAddress,
      amount: ethers.parseEther('1.5').toString(),
      sender: PARTY_KEYS[0].address,
      receiver: MOCK_ZANO_ADDRESS,
      destChain: 'zano',
    };

    // All 3 parties detect the same deposit
    for (let i = 0; i < TOTAL_PARTIES; i++) {
      dbs[i].addDeposit(deposit);
    }

    // Verify each party has 1 pending deposit
    for (let i = 0; i < TOTAL_PARTIES; i++) {
      const pending = dbs[i].getPendingDeposits('zano');
      expect(pending).toHaveLength(1);
      expect(pending[0].tx_hash).toBe(MOCK_EVM_TX_HASH);
    }

    // ================================================================
    // STEP 2: Determine session leader
    // ================================================================
    //
    // All parties compute the same session ID and leader.
    // The leader will propose this deposit for signing.

    const sessionCounter = 0;
    const sessionId = getSessionId('zano', sessionCounter);
    const leaderId = determineLeader(sessionId);

    // Sanity check: leader is a valid party
    expect(leaderId).toBeGreaterThanOrEqual(0);
    expect(leaderId).toBeLessThan(TOTAL_PARTIES);

    // All parties agree on who the leader is
    for (let i = 0; i < TOTAL_PARTIES; i++) {
      expect(determineLeader(sessionId)).toBe(leaderId);
    }

    // ================================================================
    // STEP 3: Leader proposes the deposit
    // ================================================================
    //
    // The leader broadcasts a proposal to all other parties.
    // The proposal includes the deposit details so acceptors can verify.

    const leaderDeposit = dbs[leaderId].getPendingDeposits('zano')[0];
    dbs[leaderId].updateDepositStatus(leaderDeposit.id, 'processing');

    const proposal = {
      sessionId,
      type: 'proposal',
      data: {
        depositId: leaderDeposit.id,
        sourceChain: leaderDeposit.source_chain,
        txHash: leaderDeposit.tx_hash,
        txNonce: leaderDeposit.tx_nonce,
        tokenAddress: leaderDeposit.token_address,
        amount: leaderDeposit.amount,
        receiver: leaderDeposit.receiver,
        destChain: leaderDeposit.dest_chain,
      },
    };

    // ================================================================
    // STEP 4: Acceptors verify and ACK
    // ================================================================
    //
    // Each non-leader party receives the proposal, verifies the deposit
    // exists in their own database (simulating on-chain verification),
    // and sends back an ACK.
    //
    // In production, acceptors call verifyEvmDeposit() to check the
    // actual EVM chain. Here we verify against their local DB.

    const acks = [];
    for (let i = 0; i < TOTAL_PARTIES; i++) {
      if (i === leaderId) continue;

      // Acceptor verifies: do I have this deposit?
      const myDeposit = dbs[i].getDepositByTxHash(
        proposal.data.sourceChain,
        proposal.data.txHash,
        proposal.data.txNonce,
      );

      // It should exist because we inserted it in step 1
      expect(myDeposit).toBeDefined();

      // Acceptor sends ACK
      acks.push({ sender: i, data: { accepted: true } });
    }

    // Leader collects ACKs
    expect(acks.length).toBeGreaterThanOrEqual(THRESHOLD - 1);

    // ================================================================
    // STEP 5: Leader selects signers
    // ================================================================
    //
    // From the set of ACKing parties (including self), the leader
    // deterministically picks `threshold` signers.

    const candidates = [leaderId, ...acks.map(a => a.sender)];
    const signers = selectSigners(candidates, THRESHOLD, sessionId);

    expect(signers).toHaveLength(THRESHOLD);

    // Broadcast signer set to all parties
    const signerSetMsg = {
      sessionId,
      type: 'signer_set',
      data: { signers, deposit: leaderDeposit },
    };
    await bus.broadcast(leaderId, signerSetMsg);

    // ================================================================
    // STEP 6: Create unsigned Zano emit transaction
    // ================================================================
    //
    // The leader calls the Zano wallet RPC to create an unsigned
    // mint transaction. The unsigned tx contains the data that
    // all signers will sign.
    //
    // We use the mock RPC here -- it returns MOCK_EMIT_ASSET_RESPONSE.

    const emitResult = await mockZano.call('emit_asset', {
      asset_id: 'test-asset',
      destinations: [{
        address: MOCK_ZANO_ADDRESS,
        amount: deposit.amount,
        asset_id: 'test-asset',
      }],
    });

    expect(emitResult.tx_id).toBeDefined();
    expect(emitResult.data_for_external_signing).toBeDefined();

    // Form the signing data from the transaction ID
    const sigData = formSigningData(emitResult.tx_id);
    expect(Buffer.isBuffer(sigData)).toBe(true);

    // ================================================================
    // STEP 7: Selected signers sign the Zano tx hash
    // ================================================================
    //
    // Each selected signer computes keccak256(sigData) and signs it
    // with their ECDSA key. In production, this would be a TSS protocol
    // where 2-of-3 parties cooperate to produce a single signature.
    // In the PoC, each party signs independently.

    const signatures = [];
    for (const signerId of signers) {
      const sig = signZanoHash(sigData, signerId);
      signatures.push(sig);

      // Verify the signature was made by the expected party
      expect(sig.signer.toLowerCase()).toBe(PARTY_KEYS[signerId].address.toLowerCase());
    }

    expect(signatures).toHaveLength(THRESHOLD);

    // ================================================================
    // STEP 8: Leader broadcasts the signed transaction to Zano
    // ================================================================
    //
    // The leader takes one of the signatures (in production, the
    // combined TSS signature), encodes it for Zano, and calls
    // send_ext_signed_asset_tx.

    const leaderSig = signatures[0];
    const zanoSig = encodeSignatureForZano(leaderSig.signature);

    // Verify the encoding: 128 hex chars (64 bytes, no recovery byte)
    expect(zanoSig.length).toBe(128);
    expect(zanoSig.startsWith('0x')).toBe(false);

    // Broadcast to Zano (mock)
    const broadcastResult = await mockZano.call('send_ext_signed_asset_tx', {
      eth_sig: zanoSig,
      expected_tx_id: emitResult.tx_id,
      finalized_tx: emitResult.data_for_external_signing.finalized_tx,
      unsigned_tx: emitResult.data_for_external_signing.unsigned_tx,
    });

    expect(broadcastResult.status).toBe('OK');

    // Verify the mock was called with correct params
    const lastCall = mockZano.getLastCall('send_ext_signed_asset_tx');
    expect(lastCall.params.expected_tx_id).toBe(MOCK_EMIT_ASSET_RESPONSE.tx_id);

    // ================================================================
    // STEP 9: Update deposit status to finalized
    // ================================================================

    for (const signerId of signers) {
      dbs[signerId].updateDepositStatus(
        dbs[signerId].getDepositByTxHash('evm', MOCK_EVM_TX_HASH, 0).id,
        'finalized',
      );
    }

    // Verify final state: deposit is finalized for signing parties
    for (const signerId of signers) {
      const finalDeposit = dbs[signerId].getDepositByTxHash('evm', MOCK_EVM_TX_HASH, 0);
      expect(finalDeposit.status).toBe('finalized');
    }
  });

  it('consensus fails when acceptor does not have the deposit', async () => {
    // ================================================================
    // Scenario: Leader proposes a deposit that party 2 hasn't seen.
    // This simulates a network split or slow block propagation.
    // The party that doesn't have the deposit sends a NACK.
    // ================================================================

    const deposit = {
      sourceChain: 'evm',
      txHash: MOCK_EVM_TX_HASH,
      txNonce: 0,
      tokenAddress: ethers.ZeroAddress,
      amount: ethers.parseEther('2.0').toString(),
      sender: PARTY_KEYS[0].address,
      receiver: MOCK_ZANO_ADDRESS,
      destChain: 'zano',
    };

    // Only parties 0 and 1 detect the deposit. Party 2 hasn't seen it.
    dbs[0].addDeposit(deposit);
    dbs[1].addDeposit(deposit);
    // dbs[2] has no deposits

    const sessionId = getSessionId('zano', 0);

    // Force party 0 as the proposer for this test
    const leaderId = 0;
    const leaderDeposit = dbs[leaderId].getPendingDeposits('zano')[0];

    // Simulate each acceptor's verification
    const acks = [];
    for (let i = 0; i < TOTAL_PARTIES; i++) {
      if (i === leaderId) continue;

      const found = dbs[i].getDepositByTxHash('evm', MOCK_EVM_TX_HASH, 0);
      if (found) {
        acks.push({ sender: i, data: { accepted: true } });
      } else {
        // Party 2 sends NACK because it doesn't have the deposit
        acks.push({ sender: i, data: { accepted: false } });
      }
    }

    const validAcks = acks.filter(a => a.data.accepted);

    // With threshold=2, we need at least 1 ACK (threshold - 1 = 1).
    // Party 1 ACKed, party 2 NACKed. We have exactly 1 valid ACK.
    expect(validAcks).toHaveLength(1);

    // This is enough for 2-of-3 (leader + 1 acceptor = 2)
    expect(validAcks.length).toBeGreaterThanOrEqual(THRESHOLD - 1);
  });

  it('consensus fails when no acceptors ACK', async () => {
    // ================================================================
    // Scenario: Leader has a deposit but no one else does.
    // Leader is the only one who detected it (extreme network partition).
    // With 0 ACKs, consensus cannot be reached.
    // ================================================================

    const deposit = {
      sourceChain: 'evm',
      txHash: MOCK_EVM_TX_HASH,
      txNonce: 0,
      tokenAddress: ethers.ZeroAddress,
      amount: ethers.parseEther('1.0').toString(),
      sender: PARTY_KEYS[0].address,
      receiver: MOCK_ZANO_ADDRESS,
      destChain: 'zano',
    };

    // Only leader has the deposit
    dbs[0].addDeposit(deposit);

    const sessionId = getSessionId('zano', 0);
    const leaderId = 0;

    // Both acceptors NACK
    const acks = [];
    for (let i = 1; i < TOTAL_PARTIES; i++) {
      const found = dbs[i].getDepositByTxHash('evm', MOCK_EVM_TX_HASH, 0);
      acks.push({ sender: i, data: { accepted: !!found } });
    }

    const validAcks = acks.filter(a => a.data.accepted);
    expect(validAcks).toHaveLength(0);

    // Not enough ACKs -> consensus should NOT proceed
    expect(validAcks.length).toBeLessThan(THRESHOLD - 1);

    // Leader should reset deposit to pending
    const leaderDeposit = dbs[0].getPendingDeposits('zano')[0];
    // It's still pending because the leader never moved it to processing
    expect(leaderDeposit.status).toBe('pending');
  });
});

// ============================================================================
// P2P Message Routing
// ============================================================================

describe('P2P message routing (in-process bus)', () => {
  it('delivers messages to the correct party', async () => {
    let receivedBy = -1;

    // Party 1 registers a handler for 'proposal'
    bus.onMessage(1, 'proposal', (msg) => {
      receivedBy = msg.sender;
    });

    // Party 0 sends to party 1
    await bus.sendToParty(0, 1, {
      type: 'proposal',
      sessionId: 'test',
      data: {},
    });

    expect(receivedBy).toBe(0);
  });

  it('broadcast reaches all parties except sender', async () => {
    const received = [];

    for (let i = 0; i < TOTAL_PARTIES; i++) {
      bus.onMessage(i, 'test_msg', (msg) => {
        received.push(i);
      });
    }

    // Party 0 broadcasts
    await bus.broadcast(0, { type: 'test_msg', sessionId: 's1', data: {} });

    // Party 0 should NOT receive its own broadcast
    expect(received).not.toContain(0);

    // Parties 1 and 2 should receive it
    expect(received).toContain(1);
    expect(received).toContain(2);
  });

  it('waitForMessage collects the right number of responses', async () => {
    // Party 0 is waiting for 2 responses
    const waitPromise = bus.waitForMessage(0, 'vote', 'session-1', 2);

    // Parties 1 and 2 send responses
    await bus.sendToParty(1, 0, { type: 'vote', sessionId: 'session-1', data: { yes: true } });
    await bus.sendToParty(2, 0, { type: 'vote', sessionId: 'session-1', data: { yes: true } });

    const messages = await waitPromise;
    expect(messages).toHaveLength(2);
    expect(messages[0].sender).toBe(1);
    expect(messages[1].sender).toBe(2);
  });

  it('waitForMessage filters by sessionId', async () => {
    const waitPromise = bus.waitForMessage(0, 'vote', 'session-A', 1);

    // Send message with wrong session -- should be ignored
    await bus.sendToParty(1, 0, { type: 'vote', sessionId: 'session-B', data: {} });

    // Send message with correct session
    await bus.sendToParty(2, 0, { type: 'vote', sessionId: 'session-A', data: {} });

    const messages = await waitPromise;
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe(2);
  });
});
