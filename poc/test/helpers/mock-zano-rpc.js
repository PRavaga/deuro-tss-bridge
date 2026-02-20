// ============================================================================
// Mock Zano RPC Server
// ============================================================================
//
// Configurable fake for the Zano daemon and wallet JSON-RPC endpoints.
// Instead of running a real Zano node, tests configure canned responses
// for each RPC method and get predictable results.
//
// Design:
//   - NOT an HTTP server. It's a function registry that intercepts calls
//     at the application layer. Integration tests inject it into the
//     signing flow where zano-rpc.js would normally make HTTP requests.
//   - Responses are configurable per-method, so tests can simulate
//     success, errors, and edge cases (e.g. transaction not found).
//   - Tracks call history for assertions ("was emitAsset called with X?").
//
// Usage:
//   const mock = createMockZanoRpc();
//   mock.setResponse('emit_asset', MOCK_EMIT_ASSET_RESPONSE);
//   const result = await mock.call('emit_asset', { asset_id: '...' });
//   expect(mock.getCalls('emit_asset')).toHaveLength(1);
// ============================================================================

import {
  MOCK_EMIT_ASSET_RESPONSE,
  MOCK_BROADCAST_RESPONSE,
  MOCK_SEARCH_TX_RESPONSE,
  MOCK_HEIGHT_RESPONSE,
} from '../fixtures.js';

/**
 * Create a mock Zano RPC instance with sensible defaults.
 *
 * Pre-loaded responses cover the happy path for all methods used in the
 * bridge flow. Override individual methods with setResponse() to test
 * error paths.
 */
export function createMockZanoRpc() {
  // method name -> response value (or function that returns response)
  const responses = new Map();

  // method name -> array of { params } objects (call history)
  const callHistory = new Map();

  // ---- Pre-load defaults for the happy path ----
  responses.set('emit_asset', MOCK_EMIT_ASSET_RESPONSE);
  responses.set('send_ext_signed_asset_tx', MOCK_BROADCAST_RESPONSE);
  responses.set('search_for_transactions', MOCK_SEARCH_TX_RESPONSE);
  responses.set('get_wallet_info', { address: 'ZxTestWalletAddress' });
  responses.set('burn_asset', { tx_hash: 'abc123' });
  responses.set('transfer_asset_ownership', { status: 'OK' });

  /**
   * Set the response for a specific RPC method.
   *
   * @param {string} method   JSON-RPC method name (e.g. 'emit_asset')
   * @param {any} response    Static value or function(params) => value.
   *                          If a function, it receives the call params and
   *                          can return different results per invocation.
   */
  function setResponse(method, response) {
    responses.set(method, response);
  }

  /**
   * Set a method to throw an error when called.
   * Simulates Zano RPC errors (node down, invalid params, etc.)
   *
   * @param {string} method   JSON-RPC method name
   * @param {string} message  Error message
   * @param {number} code     JSON-RPC error code (default: -32000)
   */
  function setError(method, message, code = -32000) {
    responses.set(method, () => {
      throw new Error(`Zano RPC error (${method}): ${message} (code: ${code})`);
    });
  }

  /**
   * Simulate a JSON-RPC call to the Zano node.
   * Returns the pre-configured response for the method.
   *
   * @param {string} method  JSON-RPC method name
   * @param {Object} params  Method parameters
   * @returns {any}          The configured response
   */
  async function call(method, params = {}) {
    // Track the call
    if (!callHistory.has(method)) callHistory.set(method, []);
    callHistory.get(method).push({ params, timestamp: Date.now() });

    const response = responses.get(method);

    if (response === undefined) {
      throw new Error(`Mock Zano RPC: no response configured for method "${method}"`);
    }

    // If response is a function, call it with the params (allows dynamic responses)
    if (typeof response === 'function') {
      return response(params);
    }

    // Return a deep copy to prevent tests from mutating shared fixtures
    return JSON.parse(JSON.stringify(response));
  }

  /**
   * Get the call history for a specific method.
   *
   * @param {string} method  JSON-RPC method name
   * @returns {Array<{ params: Object, timestamp: number }>}
   */
  function getCalls(method) {
    return callHistory.get(method) ?? [];
  }

  /**
   * Get the most recent call for a method (convenience).
   *
   * @param {string} method  JSON-RPC method name
   * @returns {{ params: Object, timestamp: number } | undefined}
   */
  function getLastCall(method) {
    const calls = getCalls(method);
    return calls[calls.length - 1];
  }

  /**
   * Reset all call history. Does NOT reset configured responses.
   */
  function resetHistory() {
    callHistory.clear();
  }

  /**
   * Reset everything -- responses back to defaults and clear history.
   */
  function reset() {
    callHistory.clear();
    responses.clear();
    responses.set('emit_asset', MOCK_EMIT_ASSET_RESPONSE);
    responses.set('send_ext_signed_asset_tx', MOCK_BROADCAST_RESPONSE);
    responses.set('search_for_transactions', MOCK_SEARCH_TX_RESPONSE);
    responses.set('get_wallet_info', { address: 'ZxTestWalletAddress' });
    responses.set('burn_asset', { tx_hash: 'abc123' });
    responses.set('transfer_asset_ownership', { status: 'OK' });
  }

  /**
   * Helper to simulate the getheight daemon endpoint.
   * This is special because the real implementation uses a plain HTTP GET
   * instead of JSON-RPC. We model it as just another callable method.
   *
   * @param {number} height  The height to return
   */
  function setHeight(height) {
    responses.set('getheight', { height, status: 'OK' });
  }

  // Default height
  setHeight(MOCK_HEIGHT_RESPONSE.height);

  return {
    call,
    setResponse,
    setError,
    setHeight,
    getCalls,
    getLastCall,
    resetHistory,
    reset,
  };
}
