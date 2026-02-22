// P2P Communication Layer
//
// Simple HTTP-based P2P messaging between 3 parties.
// In production, replace with gRPC + mTLS (see bridgeless tss-svc/internal/p2p/).
//
// Each party runs an Express server and sends requests to peers.
// Messages include a party ID and API key for basic authentication.
//
// Bridgeless ref: tss-svc/internal/p2p/server.go (gRPC server)
//                 tss-svc/internal/p2p/broadcast/default.go (broadcast)

import express from 'express';
import { config } from './config.js';

const messageHandlers = new Map();  // sessionType -> handler function
const pendingMessages = new Map();  // type -> [msg, ...] (buffered until handler registers)
const app = express();
app.use(express.json({ limit: '10mb' })); // TSS messages contain large WASM binary payloads

// API key for basic auth (in production: mTLS with pre-exchanged certs)
const API_KEY = process.env.P2P_API_KEY ?? 'deuro-poc-key-change-me';

/**
 * Start the P2P server for this party.
 */
export function startP2PServer() {
  const port = parseInt(process.env.P2P_BASE_PORT ?? '4000') + config.partyId;

  // Health check (no auth — used by checkPartyHealth for discovery)
  app.get('/p2p/health', (_req, res) => {
    res.json({ partyId: config.partyId, status: 'ok' });
  });

  // Authentication middleware (applied to all other /p2p routes)
  app.use('/p2p', (req, res, next) => {
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

  // Message receiving endpoint
  app.post('/p2p/message', (req, res) => {
    const { sender, sessionId, type, data } = req.body;

    if (sender === config.partyId) {
      return res.status(400).json({ error: 'cannot send to self' });
    }

    const msg = { sender, sessionId, type, data };
    const handler = messageHandlers.get(type);
    if (!handler) {
      // Buffer message for later delivery when handler registers
      if (!pendingMessages.has(type)) pendingMessages.set(type, []);
      pendingMessages.get(type).push(msg);
      return res.json({ ok: true, handled: false, buffered: true });
    }

    try {
      handler(msg);
      res.json({ ok: true, handled: true });
    } catch (err) {
      console.error(`[P2P] Handler error for ${type}:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(port, () => {
    console.log(`[P2P] Party ${config.partyId} listening on port ${port}`);
  });
}

/**
 * Register a handler for a message type.
 * Handler receives: { sender: number, sessionId: string, type: string, data: any }
 */
export function onMessage(type, handler) {
  messageHandlers.set(type, handler);
  // Deliver any buffered messages for this type
  const buffered = pendingMessages.get(type);
  if (buffered && buffered.length > 0) {
    pendingMessages.delete(type);
    for (const msg of buffered) {
      try { handler(msg); } catch (err) {
        console.error(`[P2P] Buffered handler error for ${type}:`, err.message);
      }
    }
  }
}

/**
 * Send a message to a specific party.
 *
 * Bridgeless ref: tss-svc/internal/p2p/broadcast/default.go Send()
 */
export async function sendToParty(partyId, message) {
  if (partyId === config.partyId) return;

  const party = config.parties[partyId];
  if (!party) throw new Error(`Unknown party: ${partyId}`);

  try {
    const resp = await fetch(`${party.host}/p2p/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
      body: JSON.stringify({
        sender: config.partyId,
        ...message,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${body}`);
    }

    return await resp.json();
  } catch (err) {
    console.error(`[P2P] Failed to send to party ${partyId}:`, err.message);
    throw err;
  }
}

/**
 * Broadcast a message to all other parties.
 *
 * Bridgeless ref: tss-svc/internal/p2p/broadcast/default.go Broadcast()
 */
export async function broadcast(message) {
  const results = [];
  for (const party of config.parties) {
    if (party.id === config.partyId) continue;
    try {
      const result = await sendToParty(party.id, message);
      results.push({ partyId: party.id, ok: true, result });
    } catch (err) {
      results.push({ partyId: party.id, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * Check which parties are online.
 */
export async function checkPartyHealth() {
  const statuses = [];
  for (const party of config.parties) {
    if (party.id === config.partyId) {
      statuses.push({ id: party.id, online: true });
      continue;
    }
    try {
      const resp = await fetch(`${party.host}/p2p/health`, {
        signal: AbortSignal.timeout(3000),
      });
      statuses.push({ id: party.id, online: resp.ok });
    } catch {
      statuses.push({ id: party.id, online: false });
    }
  }
  return statuses;
}

/**
 * Wait for a specific message from a specific session.
 * Returns a promise that resolves when the message is received or timeout.
 */
export function waitForMessage(type, sessionId, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      messageHandlers.delete(waitKey);
      reject(new Error(`Timeout waiting for ${type} in session ${sessionId}`));
    }, timeoutMs);

    const waitKey = `${type}:${sessionId}`;
    const collected = [];

    const originalHandler = messageHandlers.get(type);

    // Wrap handler to collect session-specific messages
    messageHandlers.set(type, (msg) => {
      if (msg.sessionId === sessionId) {
        collected.push(msg);
        // Resolve when we have enough responses (threshold - 1, since we have our own)
        if (collected.length >= config.threshold - 1) {
          clearTimeout(timer);
          if (originalHandler) messageHandlers.set(type, originalHandler);
          else messageHandlers.delete(type);
          resolve(collected);
        }
      }
      // Also call original handler if it exists
      if (originalHandler) originalHandler(msg);
    });
  });
}
