// Zano JSON-RPC client
//
// Wraps the Zano daemon and wallet RPC APIs.
// Mirrors the Go implementation in bridgeless tss-svc/pkg/zano/client.go
//
// Key methods:
//   - emitAsset: Create unsigned mint transaction (wallet)
//   - sendExtSignedAssetTx: Broadcast TSS-signed transaction (wallet)
//   - searchForTransactions: Find deposits (wallet)
//   - decryptTxDetails: Verify transaction outputs (daemon)
//   - getHeight: Current blockchain height (daemon)

import { config } from './config.js';

let idCounter = 0;

async function rpcCall(url, method, params = {}) {
  const body = {
    jsonrpc: '2.0',
    id: String(++idCounter),
    method,
    params,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await resp.json();

  if (data.error) {
    throw new Error(`Zano RPC error (${method}): ${data.error.message} (code: ${data.error.code})`);
  }

  return data.result;
}

// --- Wallet RPC methods ---

/**
 * Create an unsigned asset emit (mint) transaction.
 * The returned data includes unsigned_tx, finalized_tx, and tx_id
 * which need to be signed by the TSS group.
 *
 * Bridgeless ref: tss-svc/pkg/zano/main.go EmitAsset()
 */
export async function emitAsset(assetId, address, amount) {
  return rpcCall(config.zano.walletRpc, 'emit_asset', {
    asset_id: assetId,
    destinations: [{
      address,
      amount: String(amount),
      asset_id: '', // empty — asset is specified at top level
    }],
    do_not_split_destinations: false,
  });
}

/**
 * Broadcast a TSS-signed asset transaction.
 * The eth_sig is the ECDSA signature from the TSS group (or individual key in PoC).
 *
 * Bridgeless ref: tss-svc/pkg/zano/main.go SendExtSignedAssetTX()
 */
export async function sendExtSignedAssetTx(ethSig, expectedTxId, finalizedTx, unsignedTx) {
  return rpcCall(config.zano.walletRpc, 'send_ext_signed_asset_tx', {
    eth_sig: ethSig,
    expected_tx_id: expectedTxId,
    finalized_tx: finalizedTx,
    unsigned_tx: unsignedTx,
    unlock_transfers_on_fail: false,
  });
}

/**
 * Search for transactions in the wallet.
 * Used to detect incoming burn transactions (deposits from Zano side).
 *
 * Bridgeless ref: tss-svc/pkg/zano/main.go GetTransactions()
 */
export async function searchForTransactions(txId = '') {
  return rpcCall(config.zano.walletRpc, 'search_for_transactions', {
    filter_by_height: false,
    in: true,
    out: true,
    pool: true,
    tx_id: txId,
    min_height: 0,
    max_height: 0,
  });
}

/**
 * Get wallet info including address.
 *
 * Bridgeless ref: tss-svc/pkg/zano/main.go GetWalletInfo()
 */
export async function getWalletInfo() {
  return rpcCall(config.zano.walletRpc, 'get_wallet_info', {});
}

/**
 * Transfer asset ownership to a new key (used during setup or key resharing).
 * The new owner can be a Zano public key or an Ethereum public key.
 *
 * Bridgeless ref: tss-svc/pkg/zano/main.go TransferAssetOwnership()
 */
export async function transferAssetOwnership(assetId, newOwnerPubKey, isEthKey = true) {
  const params = { asset_id: assetId };
  if (isEthKey) {
    params.new_owner_eth_pub_key = newOwnerPubKey;
  } else {
    params.new_owner = newOwnerPubKey;
  }
  return rpcCall(config.zano.walletRpc, 'transfer_asset_ownership', params);
}

/**
 * Burn asset tokens (user-initiated, for Zano -> EVM bridge direction).
 *
 * Bridgeless ref: tss-svc/pkg/zano/main.go BurnAsset()
 */
export async function burnAsset(assetId, amount) {
  return rpcCall(config.zano.walletRpc, 'burn_asset', {
    asset_id: assetId,
    burn_amount: String(amount),
  });
}

/**
 * Transfer asset with burn + service_entries memo.
 * Uses the `transfer` RPC method which supports service_entries,
 * unlike `burn_asset` which has no memo capability.
 *
 * The service entry contains the deposit memo (EVM destination address)
 * so the bridge parties can detect where to release tokens.
 *
 * Bridgeless ref: tss-svc/internal/bridge/chain/zano/deposit.go
 *
 * @param {string} assetId - Zano asset ID to burn
 * @param {string|number} amount - Amount in atomic units
 * @param {string} evmAddress - Destination EVM address (0x...)
 */
export async function transferWithBurn(assetId, amount, evmAddress) {
  const memo = JSON.stringify({
    dst_add: evmAddress,
    dst_net_id: 'evm',
    amt: String(amount),
    asset_id: assetId,
  });
  const memoHex = Buffer.from(memo, 'utf8').toString('hex');

  return rpcCall(config.zano.walletRpc, 'transfer', {
    destinations: [],
    fee: 10000000000, // 0.01 ZANO default fee
    mixin: 10,
    service_entries_permanent: true,
    do_not_split_destinations: true,
    asset_id_to_burn: assetId,
    amount_to_burn: String(amount),
    service_entries: [
      {
        service_id: 'X',        // Bridge service marker
        instruction: 'D',       // Deposit instruction
        body: memoHex,
        flags: 0,
      },
    ],
  });
}

// --- Daemon RPC methods ---

/**
 * Decrypt transaction details to verify outputs.
 * Must be used with your own local daemon for security.
 *
 * Bridgeless ref: tss-svc/pkg/zano/main.go TxDetails()
 */
export async function decryptTxDetails(outputsAddresses, txBlob, txId, txSecretKey) {
  return rpcCall(config.zano.daemonRpc, 'decrypt_tx_details', {
    outputs_addresses: outputsAddresses,
    tx_blob: txBlob,
    tx_id: txId,
    tx_secret_key: txSecretKey,
  });
}

/**
 * Get current blockchain height.
 *
 * Bridgeless ref: tss-svc/pkg/zano/main.go CurrentHeight()
 */
export async function getHeight() {
  const resp = await fetch(
    config.zano.daemonRpc.replace('/json_rpc', '') + '/getheight'
  );
  const data = await resp.json();
  if (data.status !== 'OK') {
    throw new Error(`Zano getheight error: ${data.status}`);
  }
  return data.height;
}

// --- Utility functions ---

/**
 * Form signing data from a transaction ID.
 * This is the message that the TSS group signs.
 *
 * Bridgeless ref: tss-svc/pkg/zano/utils.go FormSigningData()
 */
export function formSigningData(txId) {
  // Convert hex tx ID to raw bytes
  return Buffer.from(txId, 'hex');
}

/**
 * Encode a signature for Zano's send_ext_signed_asset_tx.
 * Takes raw signature bytes (r + s + v) and formats for Zano.
 *
 * Bridgeless ref: tss-svc/pkg/zano/utils.go EncodeSignature()
 */
export function encodeSignatureForZano(signatureHex) {
  // Input: "0x" + 64 bytes (r+s) + 1 byte (v) = 130 hex chars + "0x"
  // Zano wants: just the r+s portion as hex, no prefix, no recovery byte
  let sig = signatureHex;
  if (sig.startsWith('0x')) sig = sig.slice(2);
  // Remove last 2 hex chars (1 byte recovery) from the combined sig
  return sig.slice(0, sig.length - 2);
}
