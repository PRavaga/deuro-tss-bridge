// ============================================================================
// Unit Tests: EVM Signer Module
// ============================================================================
//
// Tests for the functions in src/evm-signer.js:
//   - computeErc20SignHash(token, amount, receiver, txHash, txNonce, chainId, isWrapped)
//   - computeNativeSignHash(amount, receiver, txHash, txNonce, chainId)
//   - resolveEvmTokenAddress(tokenAddress)
//
// The hash functions are the most critical part of the bridge. They MUST
// produce byte-for-byte identical output to Bridge.sol's getERC20SignHash()
// and getNativeSignHash(). If there's any mismatch, the on-chain signature
// verification will reject valid signatures and funds get stuck.
//
// TSS-specific signing tests (signHash, signEvmWithdrawal) are in the
// integration tests where the full DKLs23 protocol can run with real keyshares.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  computeErc20SignHash,
  computeNativeSignHash,
  resolveEvmTokenAddress,
} from '../../src/evm-signer.js';
import { PARTY_KEYS, MOCK_EVM_TX_HASH, MOCK_TOKEN_ADDRESS, TEST_CHAIN_ID } from '../fixtures.js';

// ============================================================================
// computeErc20SignHash
// ============================================================================

describe('computeErc20SignHash', () => {
  // This function computes:
  //   keccak256(abi.encodePacked(token, amount, receiver, txHash, txNonce, chainId, isWrapped))
  //
  // It must match Bridge.sol's getERC20SignHash() exactly.
  // The types in solidityPacked are:
  //   [address, uint256, address, bytes32, uint256, uint256, bool]

  const token = MOCK_TOKEN_ADDRESS;
  const amount = ethers.parseEther('1.0');
  const receiver = PARTY_KEYS[1].address;
  const txHash = MOCK_EVM_TX_HASH;
  const txNonce = 0;
  const chainId = TEST_CHAIN_ID;
  const isWrapped = true;

  it('returns a bytes32 hex string', () => {
    const hash = computeErc20SignHash(token, amount, receiver, txHash, txNonce, chainId, isWrapped);

    // bytes32 = 32 bytes = 64 hex chars + "0x" prefix = 66 chars total
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const hash1 = computeErc20SignHash(token, amount, receiver, txHash, txNonce, chainId, isWrapped);
    const hash2 = computeErc20SignHash(token, amount, receiver, txHash, txNonce, chainId, isWrapped);

    expect(hash1).toBe(hash2);
  });

  it('matches manual solidityPacked computation', () => {
    // Reproduce the hash manually to verify the function isn't doing
    // anything unexpected (like wrong type ordering).
    const manualEncoded = ethers.solidityPacked(
      ['address', 'uint256', 'address', 'bytes32', 'uint256', 'uint256', 'bool'],
      [token, amount, receiver, txHash, txNonce, chainId, isWrapped],
    );
    const manualHash = ethers.keccak256(manualEncoded);

    const fnHash = computeErc20SignHash(token, amount, receiver, txHash, txNonce, chainId, isWrapped);

    expect(fnHash).toBe(manualHash);
  });

  it('changes when any parameter changes', () => {
    const baseHash = computeErc20SignHash(token, amount, receiver, txHash, txNonce, chainId, isWrapped);

    // Different amount
    const diffAmount = computeErc20SignHash(token, ethers.parseEther('2.0'), receiver, txHash, txNonce, chainId, isWrapped);
    expect(diffAmount).not.toBe(baseHash);

    // Different receiver
    const diffReceiver = computeErc20SignHash(token, amount, PARTY_KEYS[2].address, txHash, txNonce, chainId, isWrapped);
    expect(diffReceiver).not.toBe(baseHash);

    // Different txNonce
    const diffNonce = computeErc20SignHash(token, amount, receiver, txHash, 1, chainId, isWrapped);
    expect(diffNonce).not.toBe(baseHash);

    // Different isWrapped
    const diffWrapped = computeErc20SignHash(token, amount, receiver, txHash, txNonce, chainId, false);
    expect(diffWrapped).not.toBe(baseHash);

    // Different chainId
    const diffChain = computeErc20SignHash(token, amount, receiver, txHash, txNonce, 1, isWrapped);
    expect(diffChain).not.toBe(baseHash);
  });
});

// ============================================================================
// computeNativeSignHash
// ============================================================================

describe('computeNativeSignHash', () => {
  // This function computes:
  //   keccak256(abi.encodePacked(amount, receiver, txHash, txNonce, chainId))
  //
  // No token address or isWrapped -- native ETH has a simpler hash.

  const amount = ethers.parseEther('0.5');
  const receiver = PARTY_KEYS[0].address;
  const txHash = MOCK_EVM_TX_HASH;
  const txNonce = 0;
  const chainId = TEST_CHAIN_ID;

  it('returns a bytes32 hex string', () => {
    const hash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('differs from ERC20 hash with same params', () => {
    // Native and ERC20 hashes must be different even with overlapping params,
    // because they encode different types (no token/isWrapped for native).
    const nativeHash = computeNativeSignHash(amount, receiver, txHash, txNonce, chainId);
    const erc20Hash = computeErc20SignHash(
      ethers.ZeroAddress, amount, receiver, txHash, txNonce, chainId, false,
    );

    expect(nativeHash).not.toBe(erc20Hash);
  });

  it('matches manual computation', () => {
    const manualEncoded = ethers.solidityPacked(
      ['uint256', 'address', 'bytes32', 'uint256', 'uint256'],
      [amount, receiver, txHash, txNonce, chainId],
    );
    const manualHash = ethers.keccak256(manualEncoded);

    expect(computeNativeSignHash(amount, receiver, txHash, txNonce, chainId)).toBe(manualHash);
  });
});

// ============================================================================
// resolveEvmTokenAddress (token mapping)
// ============================================================================

describe('resolveEvmTokenAddress', () => {
  // This function maps Zano asset IDs to EVM token addresses.
  // For Zano->EVM deposits, the token_address field is the Zano asset ID,
  // which needs to be resolved to the EVM token address for signing.

  it('returns the token address unchanged if no mapping exists', () => {
    const unknownToken = '0xdeadbeef1234567890deadbeef1234567890dead';
    expect(resolveEvmTokenAddress(unknownToken)).toBe(unknownToken);
  });

  it('returns the token address unchanged for EVM addresses', () => {
    // EVM token addresses pass through as-is
    const evmToken = MOCK_TOKEN_ADDRESS;
    expect(resolveEvmTokenAddress(evmToken)).toBe(evmToken);
  });
});
