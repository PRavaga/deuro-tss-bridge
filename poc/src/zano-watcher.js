// Zano Deposit Watcher
//
// Monitors the Zano wallet for asset burn transactions.
// A burn on Zano means the user wants to bridge tokens back to EVM.
//
// The user includes a "deposit memo" in the transaction's service entries:
//   { dst_add: "0xReceiver...", dst_net_id: "evm" }
//
// Bridgeless ref: tss-svc/internal/bridge/chain/zano/deposit.go

import { config } from './config.js';
import { addDeposit, getDepositByTxHash } from './db.js';
import { searchForTransactions, getHeight } from './zano-rpc.js';

const OPERATION_TYPE_BURN = 4;

let lastCheckedHeight = 0;

/**
 * Initialize the Zano watcher.
 */
export async function initZanoWatcher() {
  if (!config.zano.assetId) {
    console.log('[Zano Watcher] No asset ID configured, skipping');
    return;
  }

  try {
    const height = await getHeight();
    lastCheckedHeight = height;
    console.log(`[Zano Watcher] Started at height ${height}`);
    console.log(`[Zano Watcher] Monitoring asset: ${config.zano.assetId}`);
  } catch (err) {
    console.error('[Zano Watcher] Init failed:', err.message);
  }
}

/**
 * Poll for new Zano burn transactions.
 *
 * Bridgeless ref: tss-svc/internal/bridge/chain/zano/deposit.go GetDepositData()
 */
export async function pollZanoDeposits() {
  if (!config.zano.assetId) return [];

  try {
    const currentHeight = await getHeight();
    const confirmedHeight = currentHeight - config.zano.confirmations;

    if (confirmedHeight <= lastCheckedHeight) return [];

    // Search for all recent transactions
    const txResult = await searchForTransactions('');
    if (!txResult) return [];

    const newDeposits = [];

    // Check incoming transactions
    const allTxs = [
      ...(txResult.in || []),
      ...(txResult.out || []),
    ];

    for (const tx of allTxs) {
      const deposit = processBurnTransaction(tx, confirmedHeight);
      if (deposit) newDeposits.push(deposit);
    }

    lastCheckedHeight = confirmedHeight;

    if (newDeposits.length > 0) {
      console.log(`[Zano Watcher] Found ${newDeposits.length} new burn(s)`);
    }

    return newDeposits;
  } catch (err) {
    console.error('[Zano Watcher] Poll error:', err.message);
    return [];
  }
}

/**
 * Process a single Zano transaction, checking if it's an asset burn
 * with a valid deposit memo.
 *
 * Bridgeless ref: tss-svc/internal/bridge/chain/zano/deposit.go
 *   - Checks ado.operation_type == 4 (burn)
 *   - Extracts deposit memo from service_entries
 *   - Validates confirmations
 */
function processBurnTransaction(tx, confirmedHeight) {
  // Must be an asset burn operation
  if (!tx.ado || tx.ado.operation_type !== OPERATION_TYPE_BURN) return null;
  if (!tx.ado.opt_amount || !tx.ado.opt_asset_id) return null;

  // Must be for our asset
  if (tx.ado.opt_asset_id !== config.zano.assetId) return null;

  // Must be confirmed
  if (!tx.height || tx.height > confirmedHeight) return null;

  // Already processed?
  if (getDepositByTxHash('zano', tx.tx_hash, 0)) return null;

  // Extract deposit memo from service entries
  const memo = extractDepositMemo(tx);
  if (!memo) {
    console.log(`[Zano Watcher] Burn tx ${tx.tx_hash} has no valid deposit memo, skipping`);
    return null;
  }

  // Validate destination is EVM
  if (memo.dst_net_id !== 'evm') return null;

  // Validate EVM address format
  if (!/^0x[0-9a-fA-F]{40}$/.test(memo.dst_add)) {
    console.log(`[Zano Watcher] Invalid EVM address in memo: ${memo.dst_add}`);
    return null;
  }

  const deposit = {
    sourceChain: 'zano',
    txHash: tx.tx_hash,
    txNonce: 0,
    tokenAddress: tx.ado.opt_asset_id,
    amount: String(tx.ado.opt_amount),
    sender: tx.remote_addresses?.[0] ?? '',
    receiver: memo.dst_add,
    destChain: 'evm',
  };

  addDeposit(deposit);
  console.log(`[Zano Watcher] New burn: ${tx.ado.opt_amount} -> ${memo.dst_add} (EVM)`);

  return deposit;
}

/**
 * Extract the deposit memo from transaction service entries.
 * The memo contains the destination chain and address.
 *
 * Bridgeless ref: tss-svc/internal/bridge/chain/zano/deposit.go (ParseDepositMemo)
 *
 * Service entry body is hex-encoded JSON:
 *   { "dst_add": "0x...", "dst_net_id": "evm", "referral_id": 0 }
 */
function extractDepositMemo(tx) {
  if (!tx.service_entries || tx.service_entries.length === 0) return null;

  // Take first service entry (in bridgeless, index comes from tx_nonce)
  const entry = tx.service_entries[0];
  if (!entry.body) return null;

  try {
    // Body is hex-encoded JSON
    const decoded = Buffer.from(entry.body, 'hex').toString('utf8');
    const memo = JSON.parse(decoded);
    return memo;
  } catch {
    return null;
  }
}

/**
 * Verify a Zano burn transaction exists with enough confirmations.
 * Used during consensus.
 */
export async function verifyZanoBurn(txHash) {
  try {
    const txResult = await searchForTransactions(txHash);
    if (!txResult) return false;

    const allTxs = [...(txResult.in || []), ...(txResult.out || [])];
    const tx = allTxs.find(t => t.tx_hash === txHash);
    if (!tx) return false;

    if (!tx.ado || tx.ado.operation_type !== OPERATION_TYPE_BURN) return false;

    const currentHeight = await getHeight();
    if (tx.height + config.zano.confirmations > currentHeight) return false;

    return true;
  } catch (err) {
    console.error('[Zano Watcher] Verify error:', err.message);
    return false;
  }
}

/**
 * Independently fetch Zano deposit data from the chain.
 * Returns the full deposit details by querying the Zano node directly,
 * NOT trusting any data from the proposer.
 *
 * Paper ref: Algorithm 13 getDepositData() — reads burn tx, serviceEntries, returns DepositData
 *
 * Critical for bridge safety: prevents a malicious proposer from lying
 * about the burn amount or destination address.
 */
export async function getZanoDepositData(txHash) {
  try {
    const txResult = await searchForTransactions(txHash);
    if (!txResult) return null;

    const allTxs = [...(txResult.in || []), ...(txResult.out || [])];
    const tx = allTxs.find(t => t.tx_hash === txHash);
    if (!tx) return null;

    // Algorithm 13, Line 9: require operationType == BURN
    if (!tx.ado || tx.ado.operation_type !== OPERATION_TYPE_BURN) return null;
    // Algorithm 13, Line 10: require optAssetId != null and optAmount != null
    if (!tx.ado.opt_asset_id || !tx.ado.opt_amount) return null;

    // Algorithm 13, Line 7: confirmations check
    const currentHeight = await getHeight();
    if (tx.height + config.zano.confirmations > currentHeight) return null;

    // Algorithm 13, Lines 13-14: extract destination from serviceEntries
    const memo = extractDepositMemo(tx);
    if (!memo || memo.dst_net_id !== 'evm') return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(memo.dst_add)) return null;

    return {
      sourceChain: 'zano',
      txHash: tx.tx_hash,
      txNonce: 0,
      tokenAddress: tx.ado.opt_asset_id,
      amount: String(tx.ado.opt_amount),
      sender: tx.remote_addresses?.[0] ?? '',
      receiver: memo.dst_add,
      destChain: 'evm',
    };
  } catch (err) {
    console.error('[Zano Watcher] getZanoDepositData error:', err.message);
    return null;
  }
}
