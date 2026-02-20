// EVM Signing Module
//
// Produces ECDSA signatures for EVM bridge withdrawals.
// In the PoC, each party signs with their own key (multi-sig).
// In production, this would use TSS to produce a single threshold signature.
//
// Bridgeless ref:
//   tss-svc/internal/bridge/chain/evm/operations/ (hash computation)
//   tss-svc/internal/tss/session/signing/evm/finalizer.go (signature conversion)

import { ethers } from 'ethers';
import { config } from './config.js';

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
 * Sign a hash with this party's key.
 * Returns the signature in Ethereum format (65 bytes: r + s + v).
 *
 * In the PoC: each party signs with their own ECDSA key.
 * In production (TSS): 2-of-3 parties run the GG18/GG20 signing protocol
 * and produce a single combined signature.
 *
 * Bridgeless ref: tss-svc/internal/tss/signer.go Run()
 */
export async function signHash(hash) {
  if (!config.partyKeys) {
    throw new Error('Party keys not loaded. Run keygen.js first.');
  }

  const myKey = config.partyKeys[config.partyId];
  if (!myKey) {
    throw new Error(`No key found for party ${config.partyId}`);
  }

  const wallet = new ethers.Wallet(myKey.privateKey);

  // Sign with EIP-191 prefix (\x19Ethereum Signed Message:\n32)
  // This matches how Signers.sol verifies:
  //   signHash_.toEthSignedMessageHash().recover(signatures_[i])
  //
  // Bridgeless ref: bridge-contracts/contracts/utils/Signers.sol _checkSignatures()
  const signature = await wallet.signMessage(ethers.getBytes(hash));

  return {
    signature,
    signer: wallet.address,
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
 * Computes the hash and signs it.
 */
export async function signEvmWithdrawal(deposit) {
  const isWrapped = false; // Custody model: bridge releases locked dEURO

  // Map Zano asset ID to EVM token address
  const evmTokenAddress = resolveEvmTokenAddress(deposit.token_address);

  const hash = computeErc20SignHash(
    evmTokenAddress,
    deposit.amount,
    deposit.receiver,
    ethers.zeroPadBytes(deposit.tx_hash, 32), // Pad Zano tx hash to bytes32
    deposit.tx_nonce,
    config.evm.chainId,
    isWrapped,
  );

  console.log(`[EVM Signer] Signing hash: ${hash}`);
  console.log(`[EVM Signer] Token: ${evmTokenAddress} (mapped from ${deposit.token_address})`);

  return signHash(hash);
}

/**
 * Verify a signature from another party.
 */
export function verifySignature(hash, signature, expectedSigner) {
  const messageHash = ethers.hashMessage(ethers.getBytes(hash));
  const recovered = ethers.recoverAddress(messageHash, signature);
  return recovered.toLowerCase() === expectedSigner.toLowerCase();
}

/**
 * Format signatures for the Bridge.sol withdrawERC20 call.
 * The contract expects an array of 65-byte signatures.
 */
export function formatSignaturesForContract(signatures) {
  return signatures.map(s => s.signature);
}
