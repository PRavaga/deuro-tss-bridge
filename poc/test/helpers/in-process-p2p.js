// ============================================================================
// In-Process P2P Bus
// ============================================================================
//
// Replaces the HTTP-based P2P layer (src/p2p.js) with an in-process
// EventEmitter for testing. This gives us:
//
//   1. Determinism -- no network timing, no port conflicts, no race conditions
//      from OS socket scheduling. Messages arrive in the order they're sent.
//
//   2. Speed -- no TCP overhead, no Express server startup/teardown.
//
//   3. Isolation -- each test can create its own bus. No shared global state
//      leaking between tests.
//
// The bus simulates 3 parties. Each party gets its own set of message handlers
// (just like src/p2p.js messageHandlers Map). When party A calls
// bus.sendToParty(1, msg), the bus synchronously invokes party B's registered
// handler for that message type.
//
// Usage:
//   const bus = createP2PBus(3);
//
//   // Party 0 registers a handler
//   bus.onMessage(0, 'proposal', (msg) => { ... });
//
//   // Party 1 broadcasts to all others
//   await bus.broadcast(1, { type: 'proposal', sessionId: 's1', data: {} });
//
//   // Party 0's handler fires with { sender: 1, type: 'proposal', ... }
// ============================================================================

import { EventEmitter } from 'events';

/**
 * Create an in-process P2P bus for `partyCount` parties.
 *
 * Each party has:
 *   - A Map of message handlers (type -> handler function)
 *   - An EventEmitter for waitForMessage-style collection
 *
 * The returned object exposes the same API shape as src/p2p.js, but
 * parameterized by partyId so a single test can drive all 3 parties.
 */
export function createP2PBus(partyCount = 3) {
  // Per-party handler maps, mirroring src/p2p.js's `messageHandlers` Map
  const handlers = Array.from({ length: partyCount }, () => new Map());

  // Per-party EventEmitter for collecting messages (used by waitForMessage)
  const emitters = Array.from({ length: partyCount }, () => new EventEmitter());

  /**
   * Register a message handler for a specific party.
   * Mirrors: p2p.js onMessage(type, handler)
   *
   * @param {number} partyId  Which party is registering
   * @param {string} type     Message type (e.g. 'proposal', 'evm_signature')
   * @param {Function} handler  fn({ sender, sessionId, type, data })
   */
  function onMessage(partyId, type, handler) {
    handlers[partyId].set(type, handler);
  }

  /**
   * Send a message from one party to another.
   * Mirrors: p2p.js sendToParty(partyId, message)
   *
   * The message is delivered synchronously to the target party's handler.
   * This is intentional -- it removes timing uncertainty from tests.
   *
   * @param {number} fromParty  Sender party ID
   * @param {number} toParty    Recipient party ID
   * @param {Object} message    { sessionId, type, data }
   */
  async function sendToParty(fromParty, toParty, message) {
    if (fromParty === toParty) return; // p2p.js skips self

    const fullMsg = { sender: fromParty, ...message };

    // Fire the registered handler (if any)
    const handler = handlers[toParty]?.get(message.type);
    if (handler) {
      await handler(fullMsg);
    }

    // Also emit on the party's EventEmitter so waitForMessage can collect it
    emitters[toParty].emit(`msg:${message.type}`, fullMsg);
  }

  /**
   * Broadcast a message from one party to all others.
   * Mirrors: p2p.js broadcast(message)
   *
   * @param {number} fromParty  Sender party ID
   * @param {Object} message    { sessionId, type, data }
   */
  async function broadcast(fromParty, message) {
    const results = [];
    for (let i = 0; i < partyCount; i++) {
      if (i === fromParty) continue;
      try {
        await sendToParty(fromParty, i, message);
        results.push({ partyId: i, ok: true });
      } catch (err) {
        results.push({ partyId: i, ok: false, error: err.message });
      }
    }
    return results;
  }

  /**
   * Wait for N messages of a given type on a specific party's bus.
   * Mirrors: p2p.js waitForMessage(type, sessionId, timeoutMs)
   *
   * @param {number} partyId    Which party is waiting
   * @param {string} type       Message type to wait for
   * @param {string} sessionId  Filter messages by session
   * @param {number} count      How many messages to collect before resolving
   * @param {number} timeoutMs  Timeout in milliseconds
   */
  function waitForMessage(partyId, type, sessionId, count = 1, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const collected = [];

      const timer = setTimeout(() => {
        emitters[partyId].removeAllListeners(`msg:${type}`);
        reject(new Error(`Timeout waiting for ${count} "${type}" messages in session ${sessionId}`));
      }, timeoutMs);

      const listener = (msg) => {
        if (msg.sessionId === sessionId) {
          collected.push(msg);
          if (collected.length >= count) {
            clearTimeout(timer);
            emitters[partyId].removeListener(`msg:${type}`, listener);
            resolve(collected);
          }
        }
      };

      emitters[partyId].on(`msg:${type}`, listener);
    });
  }

  /**
   * Remove all handlers and listeners. Call in afterEach() for clean teardown.
   */
  function reset() {
    for (let i = 0; i < partyCount; i++) {
      handlers[i].clear();
      emitters[i].removeAllListeners();
    }
  }

  return {
    onMessage,
    sendToParty,
    broadcast,
    waitForMessage,
    reset,
    // Expose internals for advanced assertions
    _handlers: handlers,
    _emitters: emitters,
  };
}
