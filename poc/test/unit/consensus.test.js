// ============================================================================
// Unit Tests: Consensus Module
// ============================================================================
//
// Tests for the pure/deterministic functions in src/consensus.js:
//   - determineLeader(sessionId)
//   - getSessionId(chain, counter)
//   - selectSigners(candidates, threshold, sessionId)
//
// These functions are the core of the bridge's agreement protocol. Every party
// must compute the EXACT same leader and signer set from the same inputs.
// A single bit of disagreement means the signing session fails.
//
// We do NOT test runAsProposer/runAsAcceptor here -- those depend on the P2P
// layer and database, so they belong in integration tests.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { determineLeader, getSessionId, selectSigners } from '../../src/consensus.js';

// ============================================================================
// getSessionId
// ============================================================================

describe('getSessionId', () => {
  // The session ID is a simple string concatenation. It encodes the chain
  // direction and a monotonic counter so each signing round gets a unique ID.
  // Format: "SIGN_{chain}_{counter}"

  it('produces expected format for EVM chain', () => {
    const id = getSessionId('evm', 0);

    // The exact string matters because it's hashed to determine the leader.
    // If this format ever changes, leader election breaks.
    expect(id).toBe('SIGN_evm_0');
  });

  it('produces expected format for Zano chain', () => {
    expect(getSessionId('zano', 42)).toBe('SIGN_zano_42');
  });

  it('increments counter correctly', () => {
    // Consecutive sessions must produce different IDs, otherwise the same
    // leader gets picked every time.
    const id1 = getSessionId('evm', 0);
    const id2 = getSessionId('evm', 1);
    expect(id1).not.toBe(id2);
  });
});

// ============================================================================
// determineLeader
// ============================================================================

describe('determineLeader', () => {
  // Leader selection uses SHA-256 to hash the session ID, reads the first
  // 4 bytes as a uint32 big-endian, then takes modulo totalParties (3).
  //
  // This is deterministic: all 3 parties compute the same leader from the
  // same session ID. No communication needed for leader election.

  it('returns a valid party ID (0, 1, or 2)', () => {
    // Test across many session IDs to catch edge cases
    for (let i = 0; i < 100; i++) {
      const sessionId = `SIGN_evm_${i}`;
      const leader = determineLeader(sessionId);

      expect(leader).toBeGreaterThanOrEqual(0);
      expect(leader).toBeLessThan(3);
      expect(Number.isInteger(leader)).toBe(true);
    }
  });

  it('is deterministic -- same input always gives same output', () => {
    const sessionId = 'SIGN_evm_5';

    // Call it 10 times with the same input
    const results = Array.from({ length: 10 }, () => determineLeader(sessionId));

    // All results must be identical
    expect(new Set(results).size).toBe(1);
  });

  it('matches manual SHA-256 computation', () => {
    // Verify the implementation against a known hash.
    // This catches subtle bugs like wrong endianness or hash truncation.
    const sessionId = 'SIGN_evm_0';

    // Step 1: SHA-256 of the session ID string
    const hash = createHash('sha256').update(sessionId).digest();

    // Step 2: Read first 4 bytes as uint32 big-endian
    const seed = hash.readUInt32BE(0);

    // Step 3: Modulo 3 (totalParties)
    const expectedLeader = seed % 3;

    expect(determineLeader(sessionId)).toBe(expectedLeader);
  });

  it('distributes leaders roughly evenly across parties', () => {
    // Over many sessions, each party should be leader roughly 1/3 of the time.
    // A broken hash function might always pick the same leader.
    const counts = [0, 0, 0];

    for (let i = 0; i < 300; i++) {
      const leader = determineLeader(`SIGN_evm_${i}`);
      counts[leader]++;
    }

    // Each party should be leader at least 50 times out of 300 (expect ~100).
    // Exact distribution depends on SHA-256 output, but it shouldn't be
    // wildly skewed.
    for (const count of counts) {
      expect(count).toBeGreaterThan(50);
    }
  });

  it('different session IDs produce different leaders', () => {
    // Not ALL will be different (pigeonhole with 3 slots), but across
    // many sessions we should see variation.
    const leaders = new Set();
    for (let i = 0; i < 30; i++) {
      leaders.add(determineLeader(`SIGN_evm_${i}`));
    }

    // We should see at least 2 distinct leaders across 30 sessions
    expect(leaders.size).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// selectSigners
// ============================================================================

describe('selectSigners', () => {
  // Signer selection picks T (threshold) parties from the set of candidates
  // who ACK'd the proposal. It uses deterministic shuffling based on the
  // session ID so all parties independently compute the same signer set.
  //
  // Algorithm:
  //   1. Hash sessionId + ':signers' with SHA-256 to get a shuffle seed
  //   2. For each candidate, hash seed + candidateId
  //   3. Sort candidates by their hash
  //   4. Take the first T candidates

  it('returns exactly threshold signers when candidates > threshold', () => {
    // 3 candidates, threshold 2 -> should pick exactly 2
    const signers = selectSigners([0, 1, 2], 2, 'SIGN_evm_0');
    expect(signers).toHaveLength(2);
  });

  it('returns all candidates when candidates <= threshold', () => {
    // If we only have exactly threshold candidates, we must use all of them.
    // No selection needed.
    const signers = selectSigners([0, 1], 2, 'SIGN_evm_0');
    expect(signers).toHaveLength(2);
    expect(signers).toContain(0);
    expect(signers).toContain(1);
  });

  it('returns the single candidate when candidates = 1 and threshold = 1', () => {
    const signers = selectSigners([2], 1, 'SIGN_evm_0');
    expect(signers).toEqual([2]);
  });

  it('is deterministic -- same inputs always produce same output', () => {
    const sessionId = 'SIGN_zano_10';
    const candidates = [0, 1, 2];
    const threshold = 2;

    const result1 = selectSigners(candidates, threshold, sessionId);
    const result2 = selectSigners(candidates, threshold, sessionId);

    expect(result1).toEqual(result2);
  });

  it('all parties compute the same signer set', () => {
    // This is the critical property. In the real system, the proposer
    // selects signers and broadcasts the set. But the acceptors must
    // independently verify it matches what they'd compute.
    const sessionId = 'SIGN_evm_7';
    const candidates = [0, 1, 2];
    const threshold = 2;

    // Simulate 3 parties computing independently
    const party0Result = selectSigners([...candidates], threshold, sessionId);
    const party1Result = selectSigners([...candidates], threshold, sessionId);
    const party2Result = selectSigners([...candidates], threshold, sessionId);

    expect(party0Result).toEqual(party1Result);
    expect(party1Result).toEqual(party2Result);
  });

  it('different session IDs can produce different signer sets', () => {
    // Over many sessions, the signer selection should vary.
    // Otherwise the same 2 parties always sign and the 3rd is never used.
    const signerSets = new Set();

    for (let i = 0; i < 30; i++) {
      const signers = selectSigners([0, 1, 2], 2, `SIGN_evm_${i}`);
      signerSets.add(JSON.stringify(signers.sort()));
    }

    // With 3 candidates choose 2, there are 3 possible pairs: [0,1], [0,2], [1,2].
    // Over 30 sessions we should see at least 2 distinct pairs.
    expect(signerSets.size).toBeGreaterThanOrEqual(2);
  });

  it('only includes candidates from the input set', () => {
    // The function must never "invent" signers that weren't in the candidate list
    const candidates = [1, 2]; // Party 0 is not a candidate
    const signers = selectSigners(candidates, 2, 'SIGN_evm_0');

    for (const s of signers) {
      expect(candidates).toContain(s);
    }
  });

  it('does not mutate the input array', () => {
    const candidates = [0, 1, 2];
    const originalCopy = [...candidates];

    selectSigners(candidates, 2, 'SIGN_evm_0');

    // The input array should be unchanged
    expect(candidates).toEqual(originalCopy);
  });
});
