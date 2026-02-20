#!/usr/bin/env node

// Distributed Key Generation for deuro TSS Bridge PoC
//
// Runs a DKLs23 DKG ceremony across 3 parties. Each party runs this script
// simultaneously with their own PARTY_ID. After the ceremony:
//   - Each party saves their keyshare to data/keyshare-{partyId}.bin
//   - All parties derive the same group ETH address from the shared public key
//   - No party ever sees the full private key
//
// Usage (run all 3 in separate terminals simultaneously):
//   PARTY_ID=0 node src/keygen.js
//   PARTY_ID=1 node src/keygen.js
//   PARTY_ID=2 node src/keygen.js
//
// Output: data/keyshare-0.bin, data/keyshare-1.bin, data/keyshare-2.bin

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initTss, distributedKeygen, getGroupAddress } from './tss.js';
import { config } from './config.js';
import { startP2PServer, broadcast, sendToParty, onMessage, checkPartyHealth } from './p2p.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

async function main() {
  const partyId = config.partyId;
  const n = config.totalParties;
  const t = config.threshold;

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  const outputPath = join(DATA_DIR, `keyshare-${partyId}.bin`);

  if (existsSync(outputPath)) {
    console.log('Keyshare already exists at:', outputPath);
    console.log('Delete the file to regenerate.');
    process.exit(0);
  }

  console.log(`\nStarting DKG ceremony — Party ${partyId} (${n} parties, threshold ${t})\n`);

  // Initialize WASM
  await initTss();
  console.log('[DKG] WASM initialized');

  // Start P2P server for message exchange
  startP2PServer();
  console.log('[DKG] P2P server started');

  // Wait for all parties to be online
  console.log('[DKG] Waiting for all parties to come online...');
  await waitForAllParties();
  console.log('[DKG] All parties online, starting DKG ceremony\n');

  // Message collection buffers (keyed by type)
  const messageBuffers = new Map();
  const messageWaiters = new Map();

  // Register handler for all TSS DKG message types
  for (const type of ['tss_dkg_msg1', 'tss_dkg_msg2', 'tss_dkg_msg3', 'tss_dkg_msg4', 'tss_dkg_commitment']) {
    messageBuffers.set(type, []);
    onMessage(type, (msg) => {
      // Collect individual serialized messages from the sender's batch
      for (const serializedMsg of msg.data.messages) {
        // Only collect messages addressed to us or broadcast (no to_id)
        if (serializedMsg.to_id === undefined || serializedMsg.to_id === null || serializedMsg.to_id === partyId) {
          messageBuffers.get(type).push(serializedMsg);
        }
      }
      // Resolve any pending waiter
      const waiter = messageWaiters.get(type);
      if (waiter && messageBuffers.get(type).length >= waiter.count) {
        waiter.resolve(messageBuffers.get(type).splice(0, waiter.count));
        messageWaiters.delete(type);
      }
    });
  }

  /**
   * Send TSS messages to other parties via P2P.
   * Directed messages (with to_id) go to the specific party.
   * Broadcast messages (no to_id) go to all others.
   */
  async function sendMsg(type, serializedMsgs) {
    // Group messages by destination
    const directed = new Map(); // to_id -> [msgs]
    const broadcastMsgs = [];

    for (const msg of serializedMsgs) {
      if (msg.to_id !== undefined && msg.to_id !== null) {
        if (!directed.has(msg.to_id)) directed.set(msg.to_id, []);
        directed.get(msg.to_id).push(msg);
      } else {
        broadcastMsgs.push(msg);
      }
    }

    // Send directed messages
    for (const [toId, msgs] of directed) {
      await sendToParty(toId, {
        type,
        sessionId: 'dkg',
        data: { messages: msgs },
      });
    }

    // Broadcast messages
    if (broadcastMsgs.length > 0) {
      await broadcast({
        type,
        sessionId: 'dkg',
        data: { messages: broadcastMsgs },
      });
    }
  }

  /**
   * Wait for messages from other parties for a given round.
   * For broadcast rounds, expects n-1 messages (one from each other party).
   * For directed rounds, expects messages addressed to us from each other party.
   */
  function waitForMsgs(type) {
    const expected = n - 1; // Messages from other parties
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for ${type} messages (got ${messageBuffers.get(type).length}/${expected})`));
      }, 60_000);

      const buf = messageBuffers.get(type);
      if (buf.length >= expected) {
        clearTimeout(timeout);
        resolve(buf.splice(0, expected));
        return;
      }

      messageWaiters.set(type, {
        count: expected,
        resolve: (msgs) => {
          clearTimeout(timeout);
          resolve(msgs);
        },
      });
    });
  }

  // Run DKG
  const keyshareBytes = await distributedKeygen(partyId, n, t, sendMsg, waitForMsgs);

  // Save keyshare
  writeFileSync(outputPath, Buffer.from(keyshareBytes));
  console.log(`\n[DKG] Keyshare saved to: ${outputPath}`);

  // Derive and print group address
  const groupAddress = getGroupAddress(keyshareBytes);
  console.log(`[DKG] Group ETH address: ${groupAddress}`);
  console.log('\nFor Bridge.sol deployment, use:');
  console.log(`  Signer:    ${groupAddress}`);
  console.log(`  Threshold: 1 (TSS enforces 2-of-3 off-chain)`);

  process.exit(0);
}

async function waitForAllParties() {
  const maxWait = 60_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const statuses = await checkPartyHealth();
    const allOnline = statuses.every(s => s.online);
    if (allOnline) return;

    const onlineCount = statuses.filter(s => s.online).length;
    console.log(`[DKG] ${onlineCount}/${config.totalParties} parties online...`);
    await new Promise(r => setTimeout(r, 2000));
  }

  throw new Error('Timeout waiting for all parties to come online');
}

main().catch(err => {
  console.error('DKG failed:', err);
  process.exit(1);
});
