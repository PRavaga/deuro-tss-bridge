// TSS Wrapper Module (DKLs23)
//
// Wraps @silencelaboratories/dkls-wasm-ll-node to provide:
//   - Distributed key generation (DKG): 3 parties produce keyshares, share a group public key
//   - Distributed signing: 2-of-3 parties cooperate to produce a single ECDSA signature
//   - Message serialization for HTTP P2P transport
//
// DKLs23 is a threshold ECDSA protocol (Trail of Bits audited, April 2024).
// No party ever holds the full private key. The output is a standard secp256k1
// ECDSA signature (R: 32 bytes, S: 32 bytes).
//
// WASM memory notes:
//   - handleMessages() and combine() take ownership of input Message objects
//     (they free them internally). Do NOT call .free() on messages after passing
//     them to these methods.
//   - SignSession constructor consumes the Keyshare — always reload from bytes.
//   - Output messages from handleMessages() are new allocations — serialize them
//     before the next round, then let them be GC'd (no explicit free needed).

import { ethers } from 'ethers';

let dkls = null;

/**
 * Initialize the WASM module. Must be awaited once at startup.
 */
export async function initTss() {
  if (dkls) return;
  dkls = await import('@silencelaboratories/dkls-wasm-ll-node');
}

function getDkls() {
  if (!dkls) throw new Error('TSS not initialized. Call initTss() first.');
  return dkls;
}

// ---------------------------------------------------------------------------
// Message serialization for P2P transport
// ---------------------------------------------------------------------------

/**
 * Serialize a WASM Message to a JSON-safe object.
 * Binary payload is base64-encoded for HTTP transport.
 */
export function serializeMessage(msg) {
  const payload = Buffer.from(msg.payload).toString('base64');
  const obj = { from_id: msg.from_id, payload };
  if (msg.to_id !== undefined && msg.to_id !== null) {
    obj.to_id = msg.to_id;
  }
  return obj;
}

/**
 * Deserialize a JSON object back into a WASM Message.
 */
export function deserializeMessage(data) {
  const { Message } = getDkls();
  const payload = new Uint8Array(Buffer.from(data.payload, 'base64'));
  return new Message(payload, data.from_id, data.to_id);
}

/**
 * Serialize an array of WASM Messages.
 */
export function serializeMessages(msgs) {
  return msgs.map(m => serializeMessage(m));
}

/**
 * Deserialize an array of JSON objects back into WASM Messages.
 */
export function deserializeMessages(dataArray) {
  return dataArray.map(d => deserializeMessage(d));
}

// ---------------------------------------------------------------------------
// Keyshare utilities
// ---------------------------------------------------------------------------

/**
 * Derive the Ethereum address from a keyshare's group public key.
 * The publicKey is a 33-byte compressed secp256k1 point.
 */
export function getGroupAddress(keyshareBytes) {
  const { Keyshare } = getDkls();
  const ks = Keyshare.fromBytes(new Uint8Array(keyshareBytes));
  const pubKey = ks.publicKey;
  const address = ethers.computeAddress('0x' + Buffer.from(pubKey).toString('hex'));
  ks.free();
  return address;
}

// ---------------------------------------------------------------------------
// Distributed Key Generation (DKG) — 5 rounds, all 3 parties
// ---------------------------------------------------------------------------
//
// Protocol flow (from library README):
//   msg1 = createFirstMessage()                           // broadcast
//   msg2 = handleMessages(filter(msg1))                   // P2P (directed)
//   commitments = calculateChainCodeCommitment()
//   msg3 = handleMessages(select(msg2))                   // P2P (directed), NO commitments
//   msg4 = handleMessages(select(msg3), commitments)      // broadcast, WITH commitments
//   handleMessages(filter(msg4))                          // finalize
//
// filter = from_id != myId (broadcast msgs from others)
// select = to_id == myId (directed msgs addressed to me)
// All messages are cloned before passing to handleMessages (it consumes them).

/**
 * Run the full DKG ceremony for one party.
 *
 * @param {number} partyId   This party's index (0, 1, or 2)
 * @param {number} n         Total participants (3)
 * @param {number} t         Threshold (2)
 * @param {Function} sendMsg     async (msgType, serializedMsgs) => void
 * @param {Function} waitForMsgs async (msgType) => serializedMsgs[]
 * @returns {Uint8Array} The keyshare bytes
 */
export async function distributedKeygen(partyId, n, t, sendMsg, waitForMsgs) {
  const { KeygenSession } = getDkls();
  const session = new KeygenSession(n, t, partyId);

  // Round 1: createFirstMessage → broadcast to all others
  const msg1 = session.createFirstMessage();
  await sendMsg('tss_dkg_msg1', [serializeMessage(msg1)]);

  // Collect round 1 broadcast messages from other parties (filter: from_id != me)
  const r1Data = await waitForMsgs('tss_dkg_msg1');
  const r1Msgs = deserializeMessages(r1Data);

  // Round 2: handleMessages(filter(msg1)) → P2P directed messages
  // handleMessages takes ownership of r1Msgs
  const msg2s = session.handleMessages(r1Msgs);
  await sendMsg('tss_dkg_msg2', serializeMessages(msg2s));

  // Calculate chain code commitment after round 2
  const ownCommitment = session.calculateChainCodeCommitment();
  await sendMsg('tss_dkg_commitment', [{
    from_id: partyId,
    payload: Buffer.from(ownCommitment).toString('base64'),
  }]);

  // Collect round 2 P2P messages (select: to_id == me) and ALL commitments
  const r2Data = await waitForMsgs('tss_dkg_msg2');
  const r2Msgs = deserializeMessages(r2Data);
  const commitmentData = await waitForMsgs('tss_dkg_commitment');

  // Build full commitments array: all n parties' commitments, sorted by from_id.
  // The library expects all n commitments (including own), not just n-1.
  const allCommitmentData = [
    { from_id: partyId, payload: Buffer.from(ownCommitment).toString('base64') },
    ...commitmentData,
  ].sort((a, b) => a.from_id - b.from_id);
  const commitments = allCommitmentData.map(c =>
    new Uint8Array(Buffer.from(c.payload, 'base64'))
  );

  // Round 3: handleMessages(select(msg2)) → P2P directed messages, NO commitments
  const msg3s = session.handleMessages(r2Msgs);
  await sendMsg('tss_dkg_msg3', serializeMessages(msg3s));

  // Collect round 3 P2P messages (select: to_id == me)
  const r3Data = await waitForMsgs('tss_dkg_msg3');
  const r3Msgs = deserializeMessages(r3Data);

  // Round 4: handleMessages(select(msg3), commitments) → broadcast messages
  const msg4s = session.handleMessages(r3Msgs, commitments);
  await sendMsg('tss_dkg_msg4', serializeMessages(msg4s));

  // Collect round 4 broadcast messages (filter: from_id != me)
  const r4Data = await waitForMsgs('tss_dkg_msg4');
  const r4Msgs = deserializeMessages(r4Data);

  // Round 5: handleMessages(filter(msg4)) → finalize
  session.handleMessages(r4Msgs);

  // Extract keyshare (consumes session)
  const keyshare = session.keyshare();
  const keyshareBytes = keyshare.toBytes();
  keyshare.free();

  return keyshareBytes;
}

// ---------------------------------------------------------------------------
// Distributed Signing — 5 rounds, 2-of-3 parties
// ---------------------------------------------------------------------------
//
// Protocol flow (from library README):
//   msg1 = createFirstMessage()                     // broadcast to co-signer
//   msg2 = handleMessages(filter(msg1))             // P2P
//   msg3 = handleMessages(select(msg2))             // P2P
//   handleMessages(select(msg3))                    // pre-sig computed (no output)
//   msg4 = lastMessage(messageHash)                 // broadcast
//   combine(filter(msg4))                           // → [R, S]
//
// For 2-party signing, filter = msgs from the other party, select = msgs to me.
// All messages are cloned before passing to handleMessages (it consumes them).

/**
 * Run the full TSS signing protocol for one party.
 *
 * @param {Uint8Array} keyshareBytes  This party's keyshare (from DKG)
 * @param {Uint8Array} messageHash    32-byte hash to sign
 * @param {Function} sendMsg          async (msgType, serializedMsgs) => void
 * @param {Function} waitForMsgs      async (msgType) => serializedMsgs[]
 * @returns {{ r: Uint8Array, s: Uint8Array }} The ECDSA signature components
 */
export async function distributedSign(keyshareBytes, messageHash, sendMsg, waitForMsgs) {
  const { Keyshare, SignSession } = getDkls();

  // SignSession constructor consumes the Keyshare, so always create from bytes
  const keyshare = Keyshare.fromBytes(new Uint8Array(keyshareBytes));
  const session = new SignSession(keyshare, 'm');
  // keyshare is consumed by SignSession — do not free it

  // Round 1: createFirstMessage → broadcast to co-signer
  const msg1 = session.createFirstMessage();
  await sendMsg('tss_sign_msg1', [serializeMessage(msg1)]);

  // Collect round 1 from co-signer (filter: from_id != me)
  const r1Data = await waitForMsgs('tss_sign_msg1');
  const r1Msgs = deserializeMessages(r1Data);

  // Round 2: handleMessages(filter(msg1)) → P2P messages
  const msg2s = session.handleMessages(r1Msgs);
  await sendMsg('tss_sign_msg2', serializeMessages(msg2s));

  // Collect round 2 (select: to_id == me)
  const r2Data = await waitForMsgs('tss_sign_msg2');
  const r2Msgs = deserializeMessages(r2Data);

  // Round 3: handleMessages(select(msg2)) → P2P messages
  const msg3s = session.handleMessages(r2Msgs);
  await sendMsg('tss_sign_msg3', serializeMessages(msg3s));

  // Collect round 3 (select: to_id == me)
  const r3Data = await waitForMsgs('tss_sign_msg3');
  const r3Msgs = deserializeMessages(r3Data);

  // Round 4: handleMessages(select(msg3)) → pre-signature computed internally
  session.handleMessages(r3Msgs);

  // Round 5: lastMessage(messageHash) → broadcast to co-signer
  const lastMsg = session.lastMessage(new Uint8Array(messageHash));
  await sendMsg('tss_sign_last', [serializeMessage(lastMsg)]);

  // Collect round 5 (lastMessage from co-signer, filter: from_id != me)
  const r5Data = await waitForMsgs('tss_sign_last');
  const r5Msgs = deserializeMessages(r5Data);

  // Round 6: combine(filter(msg4)) → [R, S]
  // combine takes ownership of r5Msgs and consumes the session
  const [R, S] = session.combine(r5Msgs);

  return { r: new Uint8Array(R), s: new Uint8Array(S) };
}

/**
 * Compute the Ethereum V value (recovery id) for a TSS signature.
 * Since DKLs23 only outputs (R, S), we compute V by trial recovery.
 *
 * @param {Uint8Array} r           32-byte R component
 * @param {Uint8Array} s           32-byte S component
 * @param {Uint8Array} messageHash 32-byte hash that was signed
 * @param {string} expectedAddress The group ETH address to recover to
 * @returns {number} The recovery parameter V (27 or 28)
 */
export function computeRecoveryParam(r, s, messageHash, expectedAddress) {
  const rHex = '0x' + Buffer.from(r).toString('hex');
  const sHex = '0x' + Buffer.from(s).toString('hex');
  const hashHex = '0x' + Buffer.from(messageHash).toString('hex');

  for (const v of [27, 28]) {
    const sig = ethers.Signature.from({ r: rHex, s: sHex, v });
    const recovered = ethers.recoverAddress(hashHex, sig);
    if (recovered.toLowerCase() === expectedAddress.toLowerCase()) {
      return v;
    }
  }

  throw new Error('Could not recover V: signature does not match expected address');
}

/**
 * Format a TSS signature (R, S) into a 65-byte Ethereum signature hex string.
 *
 * @param {Uint8Array} r           32-byte R
 * @param {Uint8Array} s           32-byte S
 * @param {Uint8Array} messageHash 32-byte hash (for V recovery)
 * @param {string} expectedAddress Group ETH address
 * @returns {string} 0x-prefixed 130-char hex string (65 bytes: r + s + v)
 */
export function formatEthSignature(r, s, messageHash, expectedAddress) {
  const v = computeRecoveryParam(r, s, messageHash, expectedAddress);
  const rHex = Buffer.from(r).toString('hex');
  const sHex = Buffer.from(s).toString('hex');
  const vHex = v.toString(16).padStart(2, '0'); // 1b or 1c (27 or 28)
  return '0x' + rHex + sHex + vHex;
}

/**
 * Format a TSS signature (R, S) for Zano's send_ext_signed_asset_tx.
 * Zano expects: r + s as hex (128 chars, no V, no 0x prefix).
 *
 * @param {Uint8Array} r 32-byte R
 * @param {Uint8Array} s 32-byte S
 * @returns {string} 128-char hex string
 */
export function formatZanoSignature(r, s) {
  return Buffer.from(r).toString('hex') + Buffer.from(s).toString('hex');
}
