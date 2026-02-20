// ============================================================================
// Integration Test: Zano → EVM Bridge Flow
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
//   6. Selected signers compute the EVM withdrawal hash
//   7. Each signer signs with EIP-191 (matches Bridge.sol _checkSignatures)
//   8. Leader collects signatures and updates deposit as "signed"
//   9. Anyone can call withdrawNative/withdrawERC20 on Bridge.sol
//
// Steps 1-8 are simulated here. Step 9 is tested in contract/bridge.test.js.
//
// This test uses:
//   - In-process P2P bus for message delivery
//   - In-memory SQLite per party
//   - Real ECDSA signing (Hardhat default accounts)
//   - Real hash computation (must match Bridge.sol)
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { createP2PBus } from '../helpers/in-process-p2p.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  PARTY_KEYS,
  MOCK_ZANO_TX_HASH,
  MOCK_TOKEN_ADDRESS,
  THRESHOLD,
  TOTAL_PARTIES,
  TEST_CHAIN_ID,
} from '../fixtures.js';
import { determineLeader, getSessionId, selectSigners } from '../../src/consensus.js';
import {
  computeErc20SignHash,
  computeNativeSignHash,
  verifySignature,
  formatSignaturesForContract,
} from '../../src/evm-signer.js';

// ---- Per-test state ----
let bus;
let dbs;

beforeEach(() => {
  bus = createP2PBus(TOTAL_PARTIES);
  dbs = Array.from({ length: TOTAL_PARTIES }, () => createTestDb());
});

// ---- Helpers ----

/** Sign an EVM hash with EIP-191 prefix (same as evm-signer.js signHash) */
async function signEvmHash(hash, partyIndex) {
  const wallet = new ethers.Wallet(PARTY_KEYS[partyIndex].privateKey);
  const signature = await wallet.signMessage(ethers.getBytes(hash));
  return { signature, signer: wallet.address };
}

// ============================================================================
// Full Zano → EVM Flow
// ============================================================================

describe('Zano → EVM full bridge flow', () => {
  it('3 parties sign an EVM withdrawal from a Zano burn', async () => {
    // ================================================================
    // STEP 1: Burn detected on Zano
    // ================================================================
    //
    // The Zano watcher polls for burn transactions via search_for_transactions.
    // When it finds a burn with operation_type = 4 and a valid memo
    // containing the destination EVM address, it creates a deposit record.

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

    // All parties detect the burn
    for (let i = 0; i < TOTAL_PARTIES; i++) {
      dbs[i].addDeposit(deposit);
    }

    // ================================================================
    // STEP 2: Determine leader and run consensus
    // ================================================================

    const sessionId = getSessionId('evm', 0);
    const leaderId = determineLeader(sessionId);

    // All parties agree on leader
    for (let i = 0; i < TOTAL_PARTIES; i++) {
      expect(determineLeader(sessionId)).toBe(leaderId);
    }

    // ================================================================
    // STEP 3: Leader proposes, acceptors verify and ACK
    // ================================================================

    const leaderDeposit = dbs[leaderId].getPendingDeposits('evm')[0];
    dbs[leaderId].updateDepositStatus(leaderDeposit.id, 'processing');

    // Simulate acceptor verification
    const acks = [];
    for (let i = 0; i < TOTAL_PARTIES; i++) {
      if (i === leaderId) continue;

      // Each acceptor checks their own DB (simulating verifyZanoBurn)
      const found = dbs[i].getDepositByTxHash('zano', MOCK_ZANO_TX_HASH, 0);
      expect(found).toBeDefined(); // All parties have it

      acks.push({ sender: i, data: { accepted: true } });
    }

    expect(acks.filter(a => a.data.accepted).length).toBeGreaterThanOrEqual(THRESHOLD - 1);

    // ================================================================
    // STEP 4: Select signers
    // ================================================================

    const candidates = [leaderId, ...acks.map(a => a.sender)];
    const signers = selectSigners(candidates, THRESHOLD, sessionId);
    expect(signers).toHaveLength(THRESHOLD);

    // ================================================================
    // STEP 5: Compute EVM withdrawal hash
    // ================================================================
    //
    // The hash encodes all withdrawal parameters. It must match what
    // Bridge.sol's getERC20SignHash() computes internally during
    // withdrawERC20(). Any mismatch = invalid signatures = stuck funds.
    //
    // For this test, we need to pad the Zano tx hash to bytes32.
    // Real Zano tx hashes are 32 bytes (64 hex chars), but without 0x prefix.

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

    // Hash should be a valid bytes32
    expect(signHash).toMatch(/^0x[0-9a-f]{64}$/);

    // ================================================================
    // STEP 6: Each signer signs the hash
    // ================================================================
    //
    // Uses EIP-191 personal sign: "\x19Ethereum Signed Message:\n32" + hash.
    // This matches how Bridge.sol's _checkSignatures verifies:
    //   signHash_.toEthSignedMessageHash().recover(signatures_[i])

    const collectedSigs = [];

    for (const signerId of signers) {
      const sig = await signEvmHash(signHash, signerId);

      // Verify each signature locally before sending
      const valid = verifySignature(signHash, sig.signature, sig.signer);
      expect(valid).toBe(true);

      collectedSigs.push(sig);
    }

    expect(collectedSigs).toHaveLength(THRESHOLD);

    // ================================================================
    // STEP 7: Exchange signatures via P2P
    // ================================================================
    //
    // Each signer broadcasts their signature. The leader (or any party)
    // collects threshold signatures.

    // Signer 0 broadcasts to signer 1 (and vice versa)
    for (const sig of collectedSigs) {
      await bus.broadcast(
        PARTY_KEYS.findIndex(p => p.address === sig.signer),
        {
          type: 'evm_signature',
          sessionId,
          data: { signature: sig.signature, signer: sig.signer },
        },
      );
    }

    // ================================================================
    // STEP 8: Update deposit status with collected signatures
    // ================================================================

    for (const signerId of signers) {
      const myDeposit = dbs[signerId].getDepositByTxHash('zano', MOCK_ZANO_TX_HASH, 0);
      dbs[signerId].updateDepositStatus(myDeposit.id, 'signed', collectedSigs);
    }

    // Verify final state
    for (const signerId of signers) {
      const finalDeposit = dbs[signerId].getDepositByTxHash('zano', MOCK_ZANO_TX_HASH, 0);
      expect(finalDeposit.status).toBe('signed');

      const storedSigs = JSON.parse(finalDeposit.signatures);
      expect(storedSigs).toHaveLength(THRESHOLD);
    }

    // ================================================================
    // STEP 9: Format signatures for on-chain withdrawal
    // ================================================================
    //
    // The signatures are now ready to be passed to Bridge.sol's
    // withdrawERC20(). This step would happen when someone submits
    // the withdrawal transaction.

    const contractSigs = formatSignaturesForContract(collectedSigs);
    expect(contractSigs).toHaveLength(THRESHOLD);

    // Each signature should be a 65-byte hex string (130 hex chars + 0x)
    for (const sig of contractSigs) {
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    }
  });

  it('handles native ETH withdrawal (no token address)', async () => {
    // ================================================================
    // Same flow but for native ETH instead of ERC20.
    // The hash computation is different (no token, no isWrapped).
    // ================================================================

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
    const signers = selectSigners([0, 1, 2], THRESHOLD, sessionId);

    // Native ETH uses computeNativeSignHash (no token, no isWrapped)
    const txHashBytes32 = ethers.zeroPadBytes('0x' + MOCK_ZANO_TX_HASH, 32);
    const signHash = computeNativeSignHash(
      deposit.amount,
      deposit.receiver,
      txHashBytes32,
      deposit.txNonce,
      TEST_CHAIN_ID,
    );

    // Collect signatures from selected signers
    const sigs = [];
    for (const signerId of signers) {
      const sig = await signEvmHash(signHash, signerId);
      expect(verifySignature(signHash, sig.signature, sig.signer)).toBe(true);
      sigs.push(sig);
    }

    // Verify we have enough signatures for the contract
    expect(sigs).toHaveLength(THRESHOLD);

    // Format for contract
    const contractSigs = formatSignaturesForContract(sigs);
    for (const sig of contractSigs) {
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    }
  });
});

// ============================================================================
// Signature Collection via P2P Bus
// ============================================================================

describe('signature collection via P2P', () => {
  it('leader collects signatures from all signers', async () => {
    // ================================================================
    // Simulate the signature exchange step where each signer sends
    // their signature to the leader, and the leader waits until
    // it has collected enough (threshold - 1, since leader has its own).
    // ================================================================

    const leaderId = 0;
    const sessionId = 'SIGN_evm_test';

    // Leader starts waiting for 2 signatures from other parties
    // (In real flow, leader already has its own signature, so it
    //  waits for threshold - 1 from others. Here we collect from
    //  all parties to test the bus.)
    const waitPromise = bus.waitForMessage(leaderId, 'evm_signature', sessionId, 2);

    // Party 1 sends their signature
    await bus.sendToParty(1, leaderId, {
      type: 'evm_signature',
      sessionId,
      data: { signature: '0xsig1', signer: PARTY_KEYS[1].address },
    });

    // Party 2 sends their signature
    await bus.sendToParty(2, leaderId, {
      type: 'evm_signature',
      sessionId,
      data: { signature: '0xsig2', signer: PARTY_KEYS[2].address },
    });

    const collected = await waitPromise;

    expect(collected).toHaveLength(2);
    expect(collected[0].data.signer).toBe(PARTY_KEYS[1].address);
    expect(collected[1].data.signer).toBe(PARTY_KEYS[2].address);
  });

  it('cross-verification: all parties can verify each other\'s signatures', async () => {
    // ================================================================
    // Each party signs the same hash. Then every other party verifies.
    // This ensures the signing scheme is consistent across parties.
    // ================================================================

    const hash = computeNativeSignHash(
      ethers.parseEther('1.0'),
      PARTY_KEYS[0].address,
      '0x' + 'ab'.repeat(32),
      0,
      TEST_CHAIN_ID,
    );

    // All 3 parties sign
    const sigs = [];
    for (let i = 0; i < TOTAL_PARTIES; i++) {
      sigs.push(await signEvmHash(hash, i));
    }

    // Every party verifies every other party's signature
    for (let verifier = 0; verifier < TOTAL_PARTIES; verifier++) {
      for (let signer = 0; signer < TOTAL_PARTIES; signer++) {
        const valid = verifySignature(hash, sigs[signer].signature, PARTY_KEYS[signer].address);
        expect(valid).toBe(true);

        // Also check that cross-verification fails (signer A's sig != signer B)
        if (signer !== verifier) {
          const wrongValid = verifySignature(hash, sigs[signer].signature, PARTY_KEYS[verifier].address);
          expect(wrongValid).toBe(false);
        }
      }
    }
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('edge cases', () => {
  it('multiple deposits in queue are processed one at a time', () => {
    // ================================================================
    // When multiple burns happen on Zano before the bridge processes
    // any, getPendingDeposits returns LIMIT 1 (oldest first).
    // This ensures deposits are processed in order.
    // ================================================================

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

    // First query returns only deposit 1
    const first = dbs[0].getPendingDeposits('evm');
    expect(first).toHaveLength(1);
    expect(first[0].amount).toBe('1000');

    // Process deposit 1
    dbs[0].updateDepositStatus(first[0].id, 'processing');

    // Next query returns deposit 2
    const second = dbs[0].getPendingDeposits('evm');
    expect(second).toHaveLength(1);
    expect(second[0].amount).toBe('2000');
  });

  it('deposit status reset on consensus failure', () => {
    // ================================================================
    // If consensus fails (not enough ACKs), the leader resets the
    // deposit from 'processing' back to 'pending' so it can be
    // retried in the next session.
    // ================================================================

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

    // Leader moves to processing
    const d = dbs[0].getPendingDeposits('evm')[0];
    dbs[0].updateDepositStatus(d.id, 'processing');

    // No pending deposits now
    expect(dbs[0].getPendingDeposits('evm')).toHaveLength(0);

    // Consensus fails -> reset to pending
    dbs[0].updateDepositStatus(d.id, 'pending');

    // Deposit is available again
    expect(dbs[0].getPendingDeposits('evm')).toHaveLength(1);
  });
});
