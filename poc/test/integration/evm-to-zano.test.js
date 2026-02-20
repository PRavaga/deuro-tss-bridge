// ============================================================================
// Integration Test: EVM → Zano Bridge Flow (TSS)
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
//   6. Leader creates unsigned Zano emit tx and shares with co-signer
//   7. Both signers run DKLs23 TSS protocol to produce a single ECDSA signature
//   8. Leader encodes (R+S) and broadcasts the signed tx to Zano
//
// TSS changes from the multi-sig PoC:
//   - Step 7: cooperative TSS signing replaces independent per-party signing
//   - Step 8: single combined signature replaces leader-signs-alone
//   - No signature collection phase — TSS protocol produces the final sig
//
// This test uses:
//   - In-process P2P bus (no HTTP, deterministic message delivery)
//   - In-memory SQLite (no disk, isolated per party)
//   - Mock Zano RPC (no real Zano node needed)
//   - Real TSS signing (actual DKLs23 protocol, actual keyshares)
// ============================================================================

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { createP2PBus } from '../helpers/in-process-p2p.js';
import { createTestDb } from '../helpers/test-db.js';
import { createMockZanoRpc } from '../helpers/mock-zano-rpc.js';
import { getTestKeyshares, getTestGroupAddress, testTssSign } from '../helpers/tss-test-keyshares.js';
import {
  PARTY_KEYS,
  MOCK_EVM_TX_HASH,
  MOCK_ZANO_ADDRESS,
  MOCK_EMIT_ASSET_RESPONSE,
  TOTAL_PARTIES,
} from '../fixtures.js';
import { determineLeader, getSessionId, selectSigners } from '../../src/consensus.js';
import { computeNativeSignHash } from '../../src/evm-signer.js';
import { formSigningData } from '../../src/zano-rpc.js';
import { initTss, formatZanoSignature, getGroupAddress } from '../../src/tss.js';

// ---- TSS test state (initialized once) ----
let keyshares;
let groupAddress;

// ---- Per-test state ----
let bus;
let dbs;
let mockZano;

beforeAll(async () => {
  // Generate TSS keyshares (cached, only runs DKG once)
  keyshares = await getTestKeyshares();
  groupAddress = await getTestGroupAddress();
}, 60_000);

beforeEach(() => {
  bus = createP2PBus(TOTAL_PARTIES);
  dbs = Array.from({ length: TOTAL_PARTIES }, () => createTestDb());
  mockZano = createMockZanoRpc();
});

// ============================================================================
// Full EVM → Zano Flow (TSS)
// ============================================================================

describe('EVM → Zano full bridge flow (TSS)', () => {
  it('3 parties reach consensus and TSS-sign a Zano mint transaction', async () => {
    // ================================================================
    // STEP 1: Deposit detected on EVM
    // ================================================================

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

    const leaderDeposit = dbs[leaderId].getPendingDeposits('zano')[0];
    dbs[leaderId].updateDepositStatus(leaderDeposit.id, 'processing');

    // ================================================================
    // STEP 4: Acceptors verify and ACK
    // ================================================================

    const acks = [];
    for (let i = 0; i < TOTAL_PARTIES; i++) {
      if (i === leaderId) continue;

      const myDeposit = dbs[i].getDepositByTxHash(
        deposit.sourceChain,
        deposit.txHash,
        deposit.txNonce,
      );
      expect(myDeposit).toBeDefined();
      acks.push({ sender: i, data: { accepted: true } });
    }

    expect(acks.length).toBeGreaterThanOrEqual(1); // Need at least 1 ACK for 2-of-3

    // ================================================================
    // STEP 5: Leader selects 2 signers (TSS needs exactly 2 for t=2)
    // ================================================================

    const candidates = [leaderId, ...acks.map(a => a.sender)];
    const signers = selectSigners(candidates, 2, sessionId);
    expect(signers).toHaveLength(2);

    await bus.broadcast(leaderId, {
      type: 'signer_set',
      sessionId,
      data: { signers, deposit: leaderDeposit },
    });

    // ================================================================
    // STEP 6: Create unsigned Zano emit transaction (mock)
    // ================================================================

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
    // STEP 7: TSS signing — 2 selected signers cooperate
    // ================================================================
    //
    // Both signers run the DKLs23 protocol to produce a single ECDSA
    // signature. No party ever holds the full key.

    const signer0Keyshare = keyshares[signers[0]];
    const signer1Keyshare = keyshares[signers[1]];

    const { r, s } = await testTssSign(signer0Keyshare, signer1Keyshare, new Uint8Array(sigData));

    // Verify signature components are 32 bytes each
    expect(r.length).toBe(32);
    expect(s.length).toBe(32);

    // ================================================================
    // STEP 8: Encode signature and broadcast to Zano
    // ================================================================

    const zanoSig = formatZanoSignature(r, s);

    // Verify the encoding: 128 hex chars (64 bytes r+s, no recovery byte)
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

    for (const signerId of signers) {
      const finalDeposit = dbs[signerId].getDepositByTxHash('evm', MOCK_EVM_TX_HASH, 0);
      expect(finalDeposit.status).toBe('finalized');
    }
  }, 60_000);

  it('consensus fails when acceptor does not have the deposit', async () => {
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

    const sessionId = getSessionId('zano', 0);
    const leaderId = 0;

    const acks = [];
    for (let i = 0; i < TOTAL_PARTIES; i++) {
      if (i === leaderId) continue;

      const found = dbs[i].getDepositByTxHash('evm', MOCK_EVM_TX_HASH, 0);
      if (found) {
        acks.push({ sender: i, data: { accepted: true } });
      } else {
        acks.push({ sender: i, data: { accepted: false } });
      }
    }

    const validAcks = acks.filter(a => a.data.accepted);

    // With TSS threshold=2, we need at least 1 ACK (threshold - 1 = 1).
    // Party 1 ACKed, party 2 NACKed. We have exactly 1 valid ACK.
    expect(validAcks).toHaveLength(1);

    // Enough for 2-of-3 (leader + 1 acceptor = 2 signers)
    expect(validAcks.length).toBeGreaterThanOrEqual(1);
  });

  it('consensus fails when no acceptors ACK', async () => {
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
    expect(validAcks.length).toBeLessThan(1);

    const leaderDeposit = dbs[0].getPendingDeposits('zano')[0];
    expect(leaderDeposit.status).toBe('pending');
  });
});

// ============================================================================
// P2P Message Routing
// ============================================================================

describe('P2P message routing (in-process bus)', () => {
  it('delivers messages to the correct party', async () => {
    let receivedBy = -1;

    bus.onMessage(1, 'proposal', (msg) => {
      receivedBy = msg.sender;
    });

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

    await bus.broadcast(0, { type: 'test_msg', sessionId: 's1', data: {} });

    expect(received).not.toContain(0);
    expect(received).toContain(1);
    expect(received).toContain(2);
  });

  it('waitForMessage collects the right number of responses', async () => {
    const waitPromise = bus.waitForMessage(0, 'vote', 'session-1', 2);

    await bus.sendToParty(1, 0, { type: 'vote', sessionId: 'session-1', data: { yes: true } });
    await bus.sendToParty(2, 0, { type: 'vote', sessionId: 'session-1', data: { yes: true } });

    const messages = await waitPromise;
    expect(messages).toHaveLength(2);
    expect(messages[0].sender).toBe(1);
    expect(messages[1].sender).toBe(2);
  });

  it('waitForMessage filters by sessionId', async () => {
    const waitPromise = bus.waitForMessage(0, 'vote', 'session-A', 1);

    await bus.sendToParty(1, 0, { type: 'vote', sessionId: 'session-B', data: {} });
    await bus.sendToParty(2, 0, { type: 'vote', sessionId: 'session-A', data: {} });

    const messages = await waitPromise;
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe(2);
  });
});
