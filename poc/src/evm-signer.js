// EVM Signing Module
//
// Produces ECDSA signatures for EVM bridge withdrawals using TSS.
// Two parties cooperate via DKLs23 protocol to produce a single threshold
// signature. No party ever holds the full private key.
//
// The contract verifies 1 signature from the TSS group address (threshold=1).
// The 2-of-3 threshold is enforced off-chain by the TSS protocol.
//
// Bridgeless ref:
//   tss-svc/internal/bridge/chain/evm/operations/ (hash computation)
//   tss-svc/internal/tss/session/signing/evm/finalizer.go (signature conversion)

import { ethers } from 'ethers';
import { config } from './config.js';
import { distributedSign, formatEthSignature } from './tss.js';

/**
 * Compute the ERC20 withdrawal sign hash.
 * Must match the on-chain computation in Bridge.sol / ERC20Handler.sol.
 *
 * Bridgeless ref: bridge-contracts/contracts/handlers/ERC20Handler.sol getERC20SignHash()
 *
 * On-chain:
 *   keccak256(abi.encodePacked(token, amount, receiver, txHash, txNonce, chainId, isWrapped))
 */
export function computeErc20SignHash(token, amount, receiver, txHash, txNonce, chainId, isWrapped) {
  const encoded = ethers.solidityPacked(
    ['address', 'uint256', 'address', 'bytes32', 'uint256', 'uint256', 'bool'],
    [token, amount, receiver, txHash, txNonce, chainId, isWrapped],
  );
  return ethers.keccak256(encoded);
}

/**
 * Compute the native ETH withdrawal sign hash.
 *
 * Bridgeless ref: bridge-contracts/contracts/handlers/NativeHandler.sol getNativeSignHash()
 *
 * On-chain:
 *   keccak256(abi.encodePacked(amount, receiver, txHash, txNonce, chainId))
 */
export function computeNativeSignHash(amount, receiver, txHash, txNonce, chainId) {
  const encoded = ethers.solidityPacked(
    ['uint256', 'address', 'bytes32', 'uint256', 'uint256'],
    [amount, receiver, txHash, txNonce, chainId],
  );
  return ethers.keccak256(encoded);
}

/**
 * Sign a hash using TSS cooperative signing.
 * Returns the combined signature as a 65-byte EVM-compatible hex string.
 *
 * The hash goes through EIP-191 prefix before TSS signing, matching how
 * Bridge.sol verifies: signHash_.toEthSignedMessageHash().recover(sig)
 *
 * @param {string} hash          The sign hash (0x-prefixed keccak256)
 * @param {Function} sendMsg     P2P send function for TSS rounds
 * @param {Function} waitForMsgs P2P receive function for TSS rounds
 * @returns {{ signature: string, signer: string }}
 */
export async function signHash(hash, sendMsg, waitForMsgs) {
  if (!config.tssKeyshare) {
    throw new Error('TSS keyshare not loaded. Run keygen.js first.');
  }
  if (!config.tssGroupAddress) {
    throw new Error('TSS group address not set. Initialize TSS first.');
  }

  // EIP-191 prefix: \x19Ethereum Signed Message:\n32 + hash
  // This matches what Bridge.sol's _checkSignatures() expects:
  //   signHash_.toEthSignedMessageHash().recover(signatures_[i])
  const eip191Hash = ethers.hashMessage(ethers.getBytes(hash));
  const messageHash = ethers.getBytes(eip191Hash);

  // Run TSS signing protocol (6 rounds with co-signer)
  const { r, s } = await distributedSign(config.tssKeyshare, messageHash, sendMsg, waitForMsgs);

  // Compute V by trial recovery and format as 65-byte signature
  const signature = formatEthSignature(r, s, messageHash, config.tssGroupAddress);

  return {
    signature,
    signer: config.tssGroupAddress,
  };
}

/**
 * Resolve the EVM token address for a deposit.
 * For Zano->EVM deposits, token_address is the Zano asset ID which
 * needs to be mapped to the corresponding EVM token address.
 */
export function resolveEvmTokenAddress(tokenAddress) {
  return config.tokenMapping[tokenAddress] || tokenAddress;
}

/**
 * Sign a deposit for EVM withdrawal (Zano -> EVM direction).
 * Computes the hash and signs it via TSS.
 *
 * @param {Object} deposit    The deposit record
 * @param {Function} sendMsg  P2P send function for TSS rounds
 * @param {Function} waitForMsgs P2P receive function for TSS rounds
 */
export async function signEvmWithdrawal(deposit, sendMsg, waitForMsgs) {
  const isWrapped = true; // Mint model: bridge mints dEURO on withdrawal (has MINTER_ROLE)

  // Map Zano asset ID to EVM token address
  const evmTokenAddress = resolveEvmTokenAddress(deposit.token_address);

  const hash = computeErc20SignHash(
    evmTokenAddress,
    deposit.amount,
    deposit.receiver,
    ethers.zeroPadBytes(deposit.tx_hash.startsWith('0x') ? deposit.tx_hash : '0x' + deposit.tx_hash, 32),
    deposit.tx_nonce,
    config.evm.chainId,
    isWrapped,
  );

  console.log(`[EVM Signer] Signing hash: ${hash}`);
  console.log(`[EVM Signer] Token: ${evmTokenAddress} (mapped from ${deposit.token_address})`);

  return signHash(hash, sendMsg, waitForMsgs);
}
