// ============================================================================
// TSS Test Keyshares Generator
// ============================================================================
//
// Generates real DKLs23 keyshares for 3 parties by running an in-process
// DKG ceremony. The keyshares are cached in memory so the DKG only runs once
// per test suite.
//
// For tests, we run DKG and signing directly using the library's API
// (exactly like the README), bypassing the P2P transport layer in src/tss.js.
// This isolates cryptographic correctness from network transport.
//
// Usage:
//   const { getTestKeyshares, getGroupAddress } = await import('./tss-test-keyshares.js');
//   const keyshares = await getTestKeyshares(); // [Uint8Array, Uint8Array, Uint8Array]
//   const groupAddr = await getTestGroupAddress(); // ETH address
// ============================================================================

import { initTss, getGroupAddress } from '../../src/tss.js';

let cachedKeyshares = null;
let cachedGroupAddress = null;

// Helper functions from the library README
function filterMessages(msgs, party) {
  return msgs.filter(m => m.from_id !== party).map(m => m.clone());
}

function selectMessages(msgs, party) {
  return msgs.filter(m => m.to_id === party).map(m => m.clone());
}

/**
 * Run an in-process DKG ceremony and return 3 keyshares.
 * Results are cached — subsequent calls return the same keyshares.
 *
 * Follows the exact protocol from the library README.
 *
 * @returns {Promise<Uint8Array[]>} Array of 3 keyshare byte arrays
 */
export async function getTestKeyshares() {
  if (cachedKeyshares) return cachedKeyshares;

  await initTss();

  const dkls = await import('@silencelaboratories/dkls-wasm-ll-node');
  const { KeygenSession } = dkls;

  const n = 3;
  const t = 2;

  // Create sessions for all parties
  const parties = [];
  for (let i = 0; i < n; i++) {
    parties.push(new KeygenSession(n, t, i));
  }

  // Round 1: createFirstMessage (broadcast)
  const msg1 = parties.map(p => p.createFirstMessage());

  // Round 2: handleMessages(filter(msg1)) → P2P messages
  const msg2 = parties.flatMap((p, pid) =>
    p.handleMessages(filterMessages(msg1, pid))
  );

  // Calculate chain code commitments (all n parties)
  const commitments = parties.map(p => p.calculateChainCodeCommitment());

  // Round 3: handleMessages(select(msg2)) → P2P messages, NO commitments
  const msg3 = parties.flatMap((p, pid) =>
    p.handleMessages(selectMessages(msg2, pid))
  );

  // Round 4: handleMessages(select(msg3), commitments) → broadcast, WITH commitments
  const msg4 = parties.flatMap((p, pid) =>
    p.handleMessages(selectMessages(msg3, pid), commitments)
  );

  // Round 5: handleMessages(filter(msg4)) → finalize
  parties.forEach((p, pid) =>
    p.handleMessages(filterMessages(msg4, pid))
  );

  // Extract keyshares
  const keyshares = parties.map(p => {
    const ks = p.keyshare();
    const bytes = ks.toBytes();
    ks.free();
    return bytes;
  });

  cachedKeyshares = keyshares;
  cachedGroupAddress = getGroupAddress(keyshares[0]);

  return cachedKeyshares;
}

/**
 * Get the group ETH address from the test keyshares.
 *
 * @returns {Promise<string>} Checksummed ETH address
 */
export async function getTestGroupAddress() {
  if (cachedGroupAddress) return cachedGroupAddress;
  await getTestKeyshares();
  return cachedGroupAddress;
}

/**
 * Run TSS signing between two parties using in-process message passing.
 * Follows the exact protocol from the library README.
 *
 * Important: keyshares contain actual party IDs (0, 1, or 2 from DKG).
 * Messages use these actual IDs in from_id/to_id, not array indices.
 * We discover actual IDs from createFirstMessage().from_id.
 *
 * @param {Uint8Array} keyshare0 First party's keyshare bytes
 * @param {Uint8Array} keyshare1 Second party's keyshare bytes
 * @param {Uint8Array} messageHash 32-byte hash to sign
 * @returns {Promise<{ r: Uint8Array, s: Uint8Array }>}
 */
export async function testTssSign(keyshare0, keyshare1, messageHash) {
  const dkls = await import('@silencelaboratories/dkls-wasm-ll-node');
  const { Keyshare, SignSession } = dkls;

  // Create sign sessions (consumes keyshares — always reload from bytes)
  const ks0 = Keyshare.fromBytes(new Uint8Array(keyshare0));
  const ks1 = Keyshare.fromBytes(new Uint8Array(keyshare1));
  const parties = [
    new SignSession(ks0, 'm'),
    new SignSession(ks1, 'm'),
  ];

  // Round 1: createFirstMessage (broadcast)
  const msg1 = parties.map(p => p.createFirstMessage());

  // Discover actual party IDs from msg1.from_id
  const partyIds = msg1.map(m => m.from_id);

  // Filter/select using actual party IDs instead of array indices
  function filter(msgs, idx) {
    return msgs.filter(m => m.from_id !== partyIds[idx]).map(m => m.clone());
  }
  function select(msgs, idx) {
    return msgs.filter(m => m.to_id === partyIds[idx]).map(m => m.clone());
  }

  // Round 2: handleMessages(filter(msg1)) → P2P
  const msg2 = parties.flatMap((p, idx) =>
    p.handleMessages(filter(msg1, idx))
  );

  // Round 3: handleMessages(select(msg2)) → P2P
  const msg3 = parties.flatMap((p, idx) =>
    p.handleMessages(select(msg2, idx))
  );

  // Round 4: handleMessages(select(msg3)) → pre-signature computed
  parties.forEach((p, idx) =>
    p.handleMessages(select(msg3, idx))
  );

  // Round 5: lastMessage(messageHash) → broadcast
  const msg4 = parties.map(p => p.lastMessage(new Uint8Array(messageHash)));

  // Round 6: combine(filter(msg4)) → [R, S]
  const signs = parties.map((p, idx) => p.combine(filter(msg4, idx)));

  // Both parties produce the same signature
  const [R, S] = signs[0];
  return { r: new Uint8Array(R), s: new Uint8Array(S) };
}
