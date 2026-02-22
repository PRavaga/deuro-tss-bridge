// EVM Deposit Watcher
//
// Monitors Bridge.sol for DepositedERC20 and DepositedNative events.
// When a deposit is detected, it's added to the local database for processing.
//
// Bridgeless ref: tss-svc/internal/bridge/chain/evm/deposit.go

import { ethers } from 'ethers';
import { config } from './config.js';
import { addDeposit, getDepositByTxHash } from './db.js';

// Bridge contract ABI (deposit events only)
const BRIDGE_ABI = [
  'event DepositedERC20(address indexed token, uint256 amount, string receiver, string network, bool isWrapped, uint16 referralId)',
  'event DepositedNative(uint256 amount, string receiver, string network, uint16 referralId)',
];

let provider;
let bridgeContract;
// Start from near-current block to avoid scanning millions of blocks.
// Set EVM_START_BLOCK env var to override (e.g., contract deployment block).
let lastProcessedBlock = 0;

/**
 * Initialize the EVM watcher.
 */
export async function initEvmWatcher() {
  if (!config.evm.bridgeAddress) {
    console.log('[EVM Watcher] No bridge address configured, skipping');
    return;
  }

  provider = new ethers.JsonRpcProvider(config.evm.rpc);
  bridgeContract = new ethers.Contract(config.evm.bridgeAddress, BRIDGE_ABI, provider);

  // Start from a recent block to avoid scanning millions of irrelevant blocks
  if (process.env.EVM_START_BLOCK) {
    lastProcessedBlock = parseInt(process.env.EVM_START_BLOCK);
  } else {
    // Default: start from 100 blocks ago
    try {
      const current = await provider.getBlockNumber();
      lastProcessedBlock = Math.max(0, current - 100);
    } catch { /* will start from 0 */ }
  }

  console.log(`[EVM Watcher] Monitoring bridge at ${config.evm.bridgeAddress}`);
  if (config.evm.deuroToken) {
    console.log(`[EVM Watcher] Filtering ERC20 deposits for token: ${config.evm.deuroToken}`);
  }
  console.log(`[EVM Watcher] Starting from block ${lastProcessedBlock}`);
  console.log(`[EVM Watcher] Required confirmations: ${config.evm.confirmations}`);
}

/**
 * Poll for new deposit events.
 * Called periodically by the main loop.
 *
 * Bridgeless ref: tss-svc/internal/bridge/chain/evm/deposit.go GetDepositData()
 */
export async function pollEvmDeposits() {
  if (!provider || !bridgeContract) return [];

  try {
    const currentBlock = await provider.getBlockNumber();
    const confirmedBlock = currentBlock - config.evm.confirmations;

    if (confirmedBlock <= lastProcessedBlock) return [];

    const fromBlock = lastProcessedBlock + 1;
    const toBlock = confirmedBlock;

    console.log(`[EVM Watcher] Scanning blocks ${fromBlock} - ${toBlock}`);

    // Query ERC20 deposit events
    const erc20Events = await bridgeContract.queryFilter(
      bridgeContract.filters.DepositedERC20(),
      fromBlock,
      toBlock,
    );

    // Query native deposit events
    const nativeEvents = await bridgeContract.queryFilter(
      bridgeContract.filters.DepositedNative(),
      fromBlock,
      toBlock,
    );

    const newDeposits = [];

    for (const event of erc20Events) {
      const deposit = processErc20Event(event);
      if (deposit) newDeposits.push(deposit);
    }

    for (const event of nativeEvents) {
      const deposit = processNativeEvent(event);
      if (deposit) newDeposits.push(deposit);
    }

    lastProcessedBlock = toBlock;

    if (newDeposits.length > 0) {
      console.log(`[EVM Watcher] Found ${newDeposits.length} new deposit(s)`);
    }

    return newDeposits;
  } catch (err) {
    console.error('[EVM Watcher] Poll error:', err.message);
    return [];
  }
}

/**
 * Process a DepositedERC20 event.
 *
 * Bridgeless ref: tss-svc/internal/bridge/chain/evm/deposit.go (ERC20 handling)
 */
function processErc20Event(event) {
  const { token, amount, receiver, network, isWrapped } = event.args;

  // Only process deposits targeting Zano
  if (network.toLowerCase() !== 'zano') return null;

  // Filter by dEURO token address if configured
  if (config.evm.deuroToken && token.toLowerCase() !== config.evm.deuroToken.toLowerCase()) {
    console.log(`[EVM Watcher] Ignoring ERC20 deposit for unknown token: ${token}`);
    return null;
  }

  const txHash = event.transactionHash;
  // event.index is the log index within the BLOCK, not the transaction.
  // For verification we need the index within receipt.logs (per-tx).
  // Each deposit call emits exactly one event, so tx-relative index is 0.
  const txNonce = 0;

  // Check if already processed
  if (getDepositByTxHash('evm', txHash, txNonce)) return null;

  const deposit = {
    sourceChain: 'evm',
    txHash,
    txNonce,
    tokenAddress: token,
    amount: amount.toString(),
    sender: '', // Would need to fetch tx.from
    receiver,   // Zano address
    destChain: 'zano',
  };

  addDeposit(deposit);
  console.log(`[EVM Watcher] New ERC20 deposit: ${amount} tokens -> ${receiver} (Zano)`);

  return deposit;
}

/**
 * Process a DepositedNative event.
 */
function processNativeEvent(event) {
  const { amount, receiver, network } = event.args;

  if (network.toLowerCase() !== 'zano') return null;

  const txHash = event.transactionHash;
  const txNonce = 0; // tx-relative log index (one event per deposit call)

  if (getDepositByTxHash('evm', txHash, txNonce)) return null;

  const deposit = {
    sourceChain: 'evm',
    txHash,
    txNonce,
    tokenAddress: ethers.ZeroAddress,
    amount: amount.toString(),
    sender: '',
    receiver,
    destChain: 'zano',
  };

  addDeposit(deposit);
  console.log(`[EVM Watcher] New native deposit: ${ethers.formatEther(amount)} ETH -> ${receiver} (Zano)`);

  return deposit;
}

/**
 * Verify a deposit exists on-chain with enough confirmations.
 * Used during consensus to independently validate a proposal.
 *
 * Bridgeless ref: tss-svc/internal/bridge/chain/evm/deposit.go GetDepositData()
 */
export async function verifyEvmDeposit(txHash, txNonce) {
  if (!provider) return false;

  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) return false;

    // Check confirmations
    const currentBlock = await provider.getBlockNumber();
    if (receipt.blockNumber + config.evm.confirmations > currentBlock) return false;

    // Verify at least one log is from the bridge contract
    let bridgeEventCount = 0;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === config.evm.bridgeAddress.toLowerCase()) {
        if (bridgeEventCount === txNonce) return true;
        bridgeEventCount++;
      }
    }

    return false;
  } catch (err) {
    console.error('[EVM Watcher] Verify error:', err.message);
    return false;
  }
}

/**
 * Independently fetch deposit data from the chain.
 * Returns the full deposit details by parsing the on-chain event,
 * NOT trusting any data from the proposer.
 *
 * Paper ref: Algorithm 12 getDepositData() — returns DepositData{tokenAddr, amount, sourceAddr, targetAddr, targetChain}
 * Paper ref: Algorithm 5 Line 11 — acceptor verifies signHash == targetClient.getHashOfWithdrawal(request.depositData)
 *
 * This is critical for bridge safety (Theorem 4): a malicious proposer
 * cannot lie about the deposit amount because each acceptor independently
 * reads the actual event from the blockchain.
 */
export async function getEvmDepositData(txHash, txNonce) {
  if (!provider || !bridgeContract) return null;

  try {
    const tx = await provider.getTransaction(txHash);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) return null;

    // Confirmations check (Algorithm 12, Line 8)
    const currentBlock = await provider.getBlockNumber();
    if (receipt.blockNumber + config.evm.confirmations > currentBlock) return null;

    // Scan all logs in the receipt for bridge events.
    // A deposit tx may contain multiple logs (e.g. ERC20 Transfer + bridge DepositedERC20),
    // so we search by contract address rather than using txNonce as a direct index.
    const iface = bridgeContract.interface;
    let bridgeEventCount = 0;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== config.evm.bridgeAddress.toLowerCase()) continue;

      let parsed;
      try {
        parsed = iface.parseLog({ topics: log.topics, data: log.data });
      } catch {
        continue;
      }

      // Match the Nth bridge event (txNonce = bridge-event-relative index)
      if (bridgeEventCount !== txNonce) {
        bridgeEventCount++;
        continue;
      }

      if (parsed.name === 'DepositedERC20') {
        return {
          sourceChain: 'evm',
          txHash,
          txNonce,
          tokenAddress: parsed.args.token,
          amount: parsed.args.amount.toString(),
          sender: tx?.from ?? '',
          receiver: parsed.args.receiver,
          destChain: parsed.args.network?.toLowerCase() ?? 'zano',
        };
      } else if (parsed.name === 'DepositedNative') {
        return {
          sourceChain: 'evm',
          txHash,
          txNonce,
          tokenAddress: ethers.ZeroAddress,
          amount: parsed.args.amount.toString(),
          sender: tx?.from ?? '',
          receiver: parsed.args.receiver,
          destChain: parsed.args.network?.toLowerCase() ?? 'zano',
        };
      }
    }

    return null;
  } catch (err) {
    console.error('[EVM Watcher] getEvmDepositData error:', err.message);
    return null;
  }
}
