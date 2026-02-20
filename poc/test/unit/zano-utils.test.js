// ============================================================================
// Unit Tests: Zano Utility Functions
// ============================================================================
//
// Tests for the pure utility functions in src/zano-rpc.js:
//   - formSigningData(txId)
//   - encodeSignatureForZano(signatureHex)
//
// These two functions handle the encoding boundary between the Ethereum
// signing world (0x-prefixed hex, 65-byte signatures with recovery byte)
// and Zano's transaction signing (raw bytes, 64-byte signatures without
// the recovery byte).
//
// Getting this encoding wrong means:
//   - formSigningData: TSS parties sign the wrong data -> invalid Zano tx
//   - encodeSignatureForZano: valid signature gets mangled -> Zano rejects it
// ============================================================================

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { formSigningData, encodeSignatureForZano } from '../../src/zano-rpc.js';

// ============================================================================
// formSigningData
// ============================================================================

describe('formSigningData', () => {
  // Converts a hex transaction ID string into a Buffer of raw bytes.
  // The TSS group signs these raw bytes (after keccak256 hashing).
  //
  // Bridgeless ref: tss-svc/pkg/zano/utils.go FormSigningData()
  //   Go version: hex.DecodeString(txId) -> []byte

  it('converts a hex string to a Buffer', () => {
    const txId = 'deadbeef00000000deadbeef00000000deadbeef00000000deadbeef00000000';
    const result = formSigningData(txId);

    expect(Buffer.isBuffer(result)).toBe(true);
  });

  it('produces correct byte length for a 32-byte tx ID', () => {
    // Zano transaction IDs are 32 bytes (64 hex chars)
    const txId = 'deadbeef00000000deadbeef00000000deadbeef00000000deadbeef00000000';
    const result = formSigningData(txId);

    // 64 hex chars = 32 bytes
    expect(result.length).toBe(32);
  });

  it('produces correct bytes for a known input', () => {
    // Simple known value: "aabbccdd" -> [0xaa, 0xbb, 0xcc, 0xdd]
    const result = formSigningData('aabbccdd');

    expect(result[0]).toBe(0xaa);
    expect(result[1]).toBe(0xbb);
    expect(result[2]).toBe(0xcc);
    expect(result[3]).toBe(0xdd);
    expect(result.length).toBe(4);
  });

  it('produces bytes that keccak256 can hash', () => {
    // This is the actual usage: formSigningData -> keccak256 -> sign
    const txId = 'deadbeef00000000deadbeef00000000deadbeef00000000deadbeef00000000';
    const sigData = formSigningData(txId);

    // Should not throw
    const digest = ethers.keccak256(sigData);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('different tx IDs produce different signing data', () => {
    const data1 = formSigningData('1111111111111111111111111111111111111111111111111111111111111111');
    const data2 = formSigningData('2222222222222222222222222222222222222222222222222222222222222222');

    expect(data1.equals(data2)).toBe(false);
  });
});

// ============================================================================
// encodeSignatureForZano
// ============================================================================

describe('encodeSignatureForZano', () => {
  // Ethereum ECDSA signatures are 65 bytes: r (32) + s (32) + v (1).
  // Zano only needs r + s (64 bytes). This function strips the 0x prefix
  // and the last byte (v / recovery parameter).
  //
  // Input:  "0x" + 128 hex chars (r+s) + 2 hex chars (v) = 132 chars total
  // Output: 128 hex chars (r+s only), no prefix
  //
  // Bridgeless ref: tss-svc/pkg/zano/utils.go EncodeSignature()

  it('removes the 0x prefix', () => {
    // 65 bytes = 130 hex chars. With 0x prefix = 132 chars.
    const sig = '0x' + 'aa'.repeat(64) + '1b'; // r(32) + s(32) + v(1)
    const encoded = encodeSignatureForZano(sig);

    expect(encoded.startsWith('0x')).toBe(false);
  });

  it('removes the recovery byte (last byte)', () => {
    // Build a fake 65-byte signature
    const r = 'aa'.repeat(32);  // 32 bytes of 0xaa
    const s = 'bb'.repeat(32);  // 32 bytes of 0xbb
    const v = '1c';              // 1 byte recovery

    const sig = '0x' + r + s + v;
    const encoded = encodeSignatureForZano(sig);

    // Should be r + s without v
    expect(encoded).toBe(r + s);
    expect(encoded.length).toBe(128); // 64 bytes * 2 hex chars
  });

  it('works without 0x prefix', () => {
    // The function handles both with and without prefix
    const r = 'aa'.repeat(32);
    const s = 'bb'.repeat(32);
    const v = '1b';

    const sigNoPrefix = r + s + v;
    const encoded = encodeSignatureForZano(sigNoPrefix);

    expect(encoded).toBe(r + s);
  });

  it('handles a real ethers.js signature', async () => {
    // Generate an actual signature and verify the encoding is correct
    const wallet = new ethers.Wallet(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    );
    const signingKey = new ethers.SigningKey(wallet.privateKey);

    // Sign some data (simulating what signZanoTxHash does)
    const message = Buffer.from('deadbeef'.repeat(8), 'hex');
    const digest = ethers.keccak256(message);
    const sig = signingKey.sign(digest);

    // sig.serialized is the 65-byte hex string
    const encoded = encodeSignatureForZano(sig.serialized);

    // Should be 128 hex chars (64 bytes = r + s, no v)
    expect(encoded.length).toBe(128);

    // Verify it matches the r+s components
    const expectedR = sig.r.slice(2); // remove 0x
    const expectedS = sig.s.slice(2); // remove 0x
    expect(encoded).toBe(expectedR + expectedS);
  });
});
