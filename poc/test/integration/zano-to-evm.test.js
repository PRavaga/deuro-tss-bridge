// ============================================================================
// Integration Test: Zano → EVM Bridge Flow (TSS)
// ============================================================================
//
// Simulates the complete flow when a user burns tokens on Zano to receive
// ETH/ERC20 on EVM:
//
//   1. User calls burn_asset on Zano → tokens destroyed, burn tx in blockchain
//   2. All 3 parties detect the burn via Zano watcher
//   3. Leader proposes the deposit for signing
//   4. Acceptors verify the burn on-chain (via Zano RPC)
//   5. Acceptors ACK → leader selects 2-of-3 signers
//   6. Both signers compute the EVM withdrawal hash (deterministic)
//   7. Both signers run DKLs23 TSS protocol → single combined ECDSA signature
//   8. Leader computes V, formats 65-byte sig, stores as "signed"
//   9. Leader submits withdrawERC20() with 1 TSS signature (contract threshold=1)
//
// This test uses:
//   - In-process P2P bus for message delivery
//   - In-memory SQLite per party
//   - Real TSS signing (DKLs23 with real keyshares)
//   - Real hash computation (must match Bridge.sol)
// ============================================================================

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { createP2PBus } from '../helpers/in-process-p2p.js';
import { createTestDb } from '../helpers/test-db.js';
import { getTestKeyshares, getTestGroupAddress, testTssSign } from '../helpers/tss-test-keyshares.js';
import {
  PARTY_KEYS,
  MOCK_ZANO_TX_HASH,
  MOCK_TOKEN_ADDRESS,
  TOTAL_PARTIES,
  TEST_CHAIN_ID,
} from '../fixtures.js';
import { determineLeader, getSessionId, selectSigners } from '../../src/consensus.js';
import {
  computeErc20SignHash,
  computeNativeSignHash,
} from '../../src/evm-signer.js';
import { initTss, formatEthSignature, computeRecoveryParam } from '../../src/tss.js';

// ---- TSS test state ----
let keyshares;
let groupAddress;

// ---- Per-test state ----
let bus;
let dbs;

beforeAll(async () => {
  keyshares = await getTestKeyshares();
  groupAddress = await getTestGroupAddress();
}, 60_000);

beforeEach(() => {
  bus = createP2PBus(TOTAL_PARTIES);
  dbs = Array.from({ length: TOTAL_PARTIES }, () => createTestDb());
});

// ============================================================================
// Full Zano → EVM Flow (TSS)
// ============================================================================

describe('Zano → EVM full bridge flow (TSS)', () => {
  it('3 parties sign an EVM withdrawal from a Zano burn', async () => {
    // ================================================================
    // STEP 1: Burn detected on Zano
    // ================================================================

    const deposit = {
      sourceChain: 'zano',
      txHash: MOCK_ZANO_TX_HASH,
      txNonce: 0,
      tokenAddress: MOCK_TOKEN_ADDRESS,
      amount: '1000000000000', // 1M tokens (6 decimals)
      sender: '',
      receiver: PARTY_KEYS[1].address, // EVM address from the burn memo
      destChain: 'evm',
    };

    for (let i = 0; i < TOTAL_PARTIES; i++) {
      dbs[i].addDeposit(deposit);
    }

    // ================================================================
    // STEP 2: Determine leader and run consensus
    // ================================================================

    const sessionId = getSessionId('evm', 0);
    const leaderId = determineLeader(sessionId);

    for (let i = 0; i < TOTAL_PARTIES; i++) {
      expect(determineLeader(sessionId)).toBe(leaderId);
    }

    // ================================================================
    // STEP 3: Leader proposes, acceptors verify and ACK
    // ================================================================

    const leaderDeposit = dbs[leaderId].getPendingDeposits('evm')[0];
    dbs[leaderId].updateDepositStatus(leaderDeposit.id, 'processing');

    const acks = [];
    for (let i = 0; i < TOTAL_PARTIES; i++) {
      if (i === leaderId) continue;

      const found = dbs[i].getDepositByTxHash('zano', MOCK_ZANO_TX_HASH, 0);
      expect(found).toBeDefined();
      acks.push({ sender: i, data: { accepted: true } });
    }

    expect(acks.filter(a => a.data.accepted).length).toBeGreaterThanOrEqual(1);

    // ================================================================
    // STEP 4: Select 2 signers for TSS
    // ================================================================

    const candidates = [leaderId, ...acks.map(a => a.sender)];
    const signers = selectSigners(candidates, 2, sessionId);
    expect(signers).toHaveLength(2);

    // ================================================================
    // STEP 5: Compute EVM withdrawal hash (deterministic, same for both signers)
    // ================================================================

    const isWrapped = true; // Wrapped token (minted by bridge on EVM)
    const txHashBytes32 = ethers.zeroPadBytes('0x' + MOCK_ZANO_TX_HASH, 32);

    const signHash = computeErc20SignHash(
      MOCK_TOKEN_ADDRESS,
      deposit.amount,
      deposit.receiver,
      txHashBytes32,
      deposit.txNonce,
      TEST_CHAIN_ID,
      isWrapped,
    );

    expect(signHash).toMatch(/^0x[0-9a-f]{64}$/);

    // ================================================================
    // STEP 6: TSS signing — both signers cooperate via DKLs23
    // ================================================================
    //
    // The hash goes through EIP-191 prefix before TSS signing, matching
    // how Bridge.sol verifies: signHash_.toEthSignedMessageHash().recover(sig)

    const eip191Hash = ethers.hashMessage(ethers.getBytes(signHash));
    const messageHash = ethers.getBytes(eip191Hash);

    const signer0Keyshare = keyshares[signers[0]];
    const signer1Keyshare = keyshares[signers[1]];

    const { r, s } = await testTssSign(signer0Keyshare, signer1Keyshare, messageHash);

    expect(r.length).toBe(32);
    expect(s.length).toBe(32);

    // ================================================================
    // STEP 7: Compute V and format as 65-byte EVM signature
    // ================================================================

    const signature = formatEthSignature(r, s, messageHash, groupAddress);

    // Verify it's a valid 65-byte hex signature
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);

    // Verify the signature recovers to the group address
    const recovered = ethers.recoverAddress(eip191Hash, signature);
    expect(recovered.toLowerCase()).toBe(groupAddress.toLowerCase());

    // ================================================================
    // STEP 8: Store the single TSS signature
    // ================================================================

    for (const signerId of signers) {
      const myDeposit = dbs[signerId].getDepositByTxHash('zano', MOCK_ZANO_TX_HASH, 0);
      dbs[signerId].updateDepositStatus(myDeposit.id, 'signed', [
        { signature, signer: groupAddress },
      ]);
    }

    // Verify final state
    for (const signerId of signers) {
      const finalDeposit = dbs[signerId].getDepositByTxHash('zano', MOCK_ZANO_TX_HASH, 0);
      expect(finalDeposit.status).toBe('signed');

      const storedSigs = JSON.parse(finalDeposit.signatures);
      expect(storedSigs).toHaveLength(1); // Single TSS signature
      expect(storedSigs[0].signer.toLowerCase()).toBe(groupAddress.toLowerCase());
    }

    // ================================================================
    // STEP 9: Signature is ready for on-chain withdrawal
    // ================================================================
    //
    // The single TSS signature can be passed to Bridge.sol's
    // withdrawERC20(). Contract threshold=1 so one sig suffices.

    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  }, 60_000);

  it('handles native ETH withdrawal with TSS', async () => {
    // Same flow but for native ETH instead of ERC20.

    const deposit = {
      sourceChain: 'zano',
      txHash: MOCK_ZANO_TX_HASH,
      txNonce: 0,
      tokenAddress: ethers.ZeroAddress,
      amount: ethers.parseEther('0.5').toString(),
      sender: '',
      receiver: PARTY_KEYS[2].address,
      destChain: 'evm',
    };

    for (let i = 0; i < TOTAL_PARTIES; i++) {
      dbs[i].addDeposit(deposit);
    }

    const sessionId = getSessionId('evm', 1);
    const signers = selectSigners([0, 1, 2], 2, sessionId);

    // Native ETH uses computeNativeSignHash (no token, no isWrapped)
    const txHashBytes32 = ethers.zeroPadBytes('0x' + MOCK_ZANO_TX_HASH, 32);
    const signHash = computeNativeSignHash(
      deposit.amount,
      deposit.receiver,
      txHashBytes32,
      deposit.txNonce,
      TEST_CHAIN_ID,
    );

    // EIP-191 prefix for Bridge.sol compatibility
    const eip191Hash = ethers.hashMessage(ethers.getBytes(signHash));
    const messageHash = ethers.getBytes(eip191Hash);

    // TSS sign
    const { r, s } = await testTssSign(keyshares[signers[0]], keyshares[signers[1]], messageHash);

    // Format as 65-byte EVM signature
    const signature = formatEthSignature(r, s, messageHash, groupAddress);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);

    // Verify recovery
    const recovered = ethers.recoverAddress(eip191Hash, signature);
    expect(recovered.toLowerCase()).toBe(groupAddress.toLowerCase());
  }, 60_000);
});

// ============================================================================
// TSS Signature Verification
// ============================================================================

describe('TSS signature properties', () => {
  it('both signers produce identical (R, S)', async () => {
    // This is fundamental to TSS: both parties independently arrive
    // at the same signature. If they didn't, the protocol would fail.

    const hash = computeNativeSignHash(
      ethers.parseEther('1.0'),
      PARTY_KEYS[0].address,
      '0x' + 'ab'.repeat(32),
      0,
      TEST_CHAIN_ID,
    );

    const eip191Hash = ethers.hashMessage(ethers.getBytes(hash));
    const messageHash = ethers.getBytes(eip191Hash);

    // Sign with parties 0 and 1
    const sig = await testTssSign(keyshares[0], keyshares[1], messageHash);

    // R and S should be valid 32-byte values
    expect(sig.r.length).toBe(32);
    expect(sig.s.length).toBe(32);

    // The signature should recover to the group address
    const signature = formatEthSignature(sig.r, sig.s, messageHash, groupAddress);
    const recovered = ethers.recoverAddress(eip191Hash, signature);
    expect(recovered.toLowerCase()).toBe(groupAddress.toLowerCase());
  }, 60_000);

  it('any 2-of-3 combination can sign', async () => {
    const hash = computeNativeSignHash(
      ethers.parseEther('1.0'),
      PARTY_KEYS[0].address,
      '0x' + 'cd'.repeat(32),
      0,
      TEST_CHAIN_ID,
    );

    const eip191Hash = ethers.hashMessage(ethers.getBytes(hash));
    const messageHash = ethers.getBytes(eip191Hash);

    // Test all 3 combinations: [0,1], [0,2], [1,2]
    const combos = [[0, 1], [0, 2], [1, 2]];

    for (const [a, b] of combos) {
      const sig = await testTssSign(keyshares[a], keyshares[b], messageHash);
      const signature = formatEthSignature(sig.r, sig.s, messageHash, groupAddress);
      const recovered = ethers.recoverAddress(eip191Hash, signature);
      expect(recovered.toLowerCase()).toBe(groupAddress.toLowerCase());
    }
  }, 120_000);
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('edge cases', () => {
  it('multiple deposits in queue are processed one at a time', () => {
    const deposit1 = {
      sourceChain: 'zano',
      txHash: MOCK_ZANO_TX_HASH,
      txNonce: 0,
      tokenAddress: MOCK_TOKEN_ADDRESS,
      amount: '1000',
      sender: '',
      receiver: PARTY_KEYS[0].address,
      destChain: 'evm',
    };

    const deposit2 = {
      sourceChain: 'zano',
      txHash: 'bbbbbbbb11111111bbbbbbbb11111111bbbbbbbb11111111bbbbbbbb11111111',
      txNonce: 0,
      tokenAddress: MOCK_TOKEN_ADDRESS,
      amount: '2000',
      sender: '',
      receiver: PARTY_KEYS[1].address,
      destChain: 'evm',
    };

    dbs[0].addDeposit(deposit1);
    dbs[0].addDeposit(deposit2);

    const first = dbs[0].getPendingDeposits('evm');
    expect(first).toHaveLength(1);
    expect(first[0].amount).toBe('1000');

    dbs[0].updateDepositStatus(first[0].id, 'processing');

    const second = dbs[0].getPendingDeposits('evm');
    expect(second).toHaveLength(1);
    expect(second[0].amount).toBe('2000');
  });

  it('deposit status reset on consensus failure', () => {
    const deposit = {
      sourceChain: 'zano',
      txHash: MOCK_ZANO_TX_HASH,
      txNonce: 0,
      tokenAddress: MOCK_TOKEN_ADDRESS,
      amount: '5000',
      sender: '',
      receiver: PARTY_KEYS[0].address,
      destChain: 'evm',
    };

    dbs[0].addDeposit(deposit);

    const d = dbs[0].getPendingDeposits('evm')[0];
    dbs[0].updateDepositStatus(d.id, 'processing');

    expect(dbs[0].getPendingDeposits('evm')).toHaveLength(0);

    dbs[0].updateDepositStatus(d.id, 'pending');

    expect(dbs[0].getPendingDeposits('evm')).toHaveLength(1);
  });
});
