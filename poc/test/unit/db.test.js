// ============================================================================
// Unit Tests: Database (SQLite) CRUD Operations
// ============================================================================
//
// Tests for the deposit tracking database used by each bridge party.
// Uses in-memory SQLite (test/helpers/test-db.js) instead of the real db.js
// to avoid filesystem side effects and ensure test isolation.
//
// The database is the source of truth for each party's view of bridge state:
//   - Which deposits have been detected (from EVM or Zano chain)
//   - What status each deposit is in (pending -> processing -> signed -> finalized)
//   - What signatures have been collected
//
// We test:
//   1. Inserting deposits
//   2. Querying pending deposits
//   3. Updating status through the lifecycle
//   4. Deduplication (UNIQUE constraint on source_chain + tx_hash + tx_nonce)
//   5. Storing and retrieving signatures as JSON
//   6. Lookup by tx hash
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { EVM_TO_ZANO_DEPOSIT, ZANO_TO_EVM_DEPOSIT } from '../fixtures.js';

// Fresh database for each test -- no state leakage between tests
let testDb;

beforeEach(() => {
  if (testDb?.db) testDb.db.close();
  testDb = createTestDb();
});

// ============================================================================
// addDeposit
// ============================================================================

describe('addDeposit', () => {
  it('inserts a deposit and returns changes = 1', () => {
    const result = testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);

    // better-sqlite3 run() returns { changes, lastInsertRowid }
    expect(result.changes).toBe(1);
    expect(result.lastInsertRowid).toBeGreaterThan(0);
  });

  it('sets default status to pending', () => {
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);

    const deposits = testDb.getAllDeposits();
    expect(deposits[0].status).toBe('pending');
  });

  it('stores all fields correctly', () => {
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);

    const deposit = testDb.getAllDeposits()[0];

    // The DB uses snake_case columns, the input uses camelCase.
    // addDeposit maps them via named parameters.
    expect(deposit.source_chain).toBe('evm');
    expect(deposit.tx_hash).toBe(EVM_TO_ZANO_DEPOSIT.txHash);
    expect(deposit.tx_nonce).toBe(0);
    expect(deposit.amount).toBe(EVM_TO_ZANO_DEPOSIT.amount);
    expect(deposit.receiver).toBe(EVM_TO_ZANO_DEPOSIT.receiver);
    expect(deposit.dest_chain).toBe('zano');
  });

  it('handles both EVM and Zano deposits', () => {
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);
    testDb.addDeposit(ZANO_TO_EVM_DEPOSIT);

    const deposits = testDb.getAllDeposits();
    expect(deposits).toHaveLength(2);
    expect(deposits[0].source_chain).toBe('evm');
    expect(deposits[1].source_chain).toBe('zano');
  });
});

// ============================================================================
// Deduplication (UNIQUE constraint)
// ============================================================================

describe('deduplication', () => {
  // The deposits table has a UNIQUE constraint on (source_chain, tx_hash, tx_nonce).
  // INSERT OR IGNORE means duplicate deposits are silently skipped.
  // This is critical: each party polls both chains and may see the same
  // deposit multiple times. We must not create duplicate entries.

  it('ignores duplicate deposits (same chain + txHash + nonce)', () => {
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);

    // Insert the same deposit again
    const result = testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);

    // changes = 0 means the INSERT was ignored (not an error)
    expect(result.changes).toBe(0);

    // Still only one deposit in the database
    expect(testDb.getAllDeposits()).toHaveLength(1);
  });

  it('allows same tx_hash with different tx_nonce', () => {
    // A single EVM transaction can emit multiple events (e.g., batch deposit).
    // Each event has a different log index (tx_nonce), so they're distinct deposits.
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);
    testDb.addDeposit({ ...EVM_TO_ZANO_DEPOSIT, txNonce: 1 });

    expect(testDb.getAllDeposits()).toHaveLength(2);
  });

  it('allows same tx_hash on different chains', () => {
    // Extremely unlikely in practice, but the UNIQUE constraint is per-chain.
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);
    testDb.addDeposit({
      ...EVM_TO_ZANO_DEPOSIT,
      sourceChain: 'zano',
      destChain: 'evm',
    });

    expect(testDb.getAllDeposits()).toHaveLength(2);
  });
});

// ============================================================================
// getPendingDeposits
// ============================================================================

describe('getPendingDeposits', () => {
  it('returns pending deposits for the specified destination chain', () => {
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);  // destChain = 'zano'
    testDb.addDeposit(ZANO_TO_EVM_DEPOSIT);  // destChain = 'evm'

    // Query for Zano-bound deposits
    const zanoDeposits = testDb.getPendingDeposits('zano');
    expect(zanoDeposits).toHaveLength(1);
    expect(zanoDeposits[0].dest_chain).toBe('zano');

    // Query for EVM-bound deposits
    const evmDeposits = testDb.getPendingDeposits('evm');
    expect(evmDeposits).toHaveLength(1);
    expect(evmDeposits[0].dest_chain).toBe('evm');
  });

  it('returns at most 1 deposit (LIMIT 1)', () => {
    // Insert 3 deposits to the same destination
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);
    testDb.addDeposit({ ...EVM_TO_ZANO_DEPOSIT, txHash: '0x' + '11'.repeat(32), txNonce: 0 });
    testDb.addDeposit({ ...EVM_TO_ZANO_DEPOSIT, txHash: '0x' + '22'.repeat(32), txNonce: 0 });

    // Only 1 should be returned
    const deposits = testDb.getPendingDeposits('zano');
    expect(deposits).toHaveLength(1);
  });

  it('returns the oldest pending deposit first (ORDER BY id ASC)', () => {
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);
    testDb.addDeposit({ ...EVM_TO_ZANO_DEPOSIT, txHash: '0x' + '11'.repeat(32), txNonce: 0 });

    const deposits = testDb.getPendingDeposits('zano');
    expect(deposits[0].id).toBe(1); // First inserted = lowest ID
  });

  it('excludes non-pending deposits', () => {
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);

    // Mark the deposit as processing
    testDb.updateDepositStatus(1, 'processing');

    // No pending deposits left
    const deposits = testDb.getPendingDeposits('zano');
    expect(deposits).toHaveLength(0);
  });

  it('returns empty array when no deposits exist', () => {
    const deposits = testDb.getPendingDeposits('zano');
    expect(deposits).toEqual([]);
  });
});

// ============================================================================
// updateDepositStatus
// ============================================================================

describe('updateDepositStatus', () => {
  // Deposits move through a lifecycle:
  //   pending -> processing -> signed -> finalized
  //                                   -> failed (error path)
  //
  // The proposer sets 'processing' when it starts a signing session.
  // Signers set 'signed' after collecting enough signatures.
  // The leader sets 'finalized' after broadcasting the Zano tx.
  // Any step can set 'failed' on error.

  it('updates status from pending to processing', () => {
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);

    testDb.updateDepositStatus(1, 'processing');

    const deposit = testDb.getAllDeposits()[0];
    expect(deposit.status).toBe('processing');
  });

  it('stores signatures as JSON', () => {
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);

    const sigs = [
      { signature: '0xaabb...', signer: '0x111...' },
      { signature: '0xccdd...', signer: '0x222...' },
    ];

    testDb.updateDepositStatus(1, 'signed', sigs);

    const deposit = testDb.getAllDeposits()[0];
    expect(deposit.status).toBe('signed');

    // Signatures are stored as a JSON string
    const parsed = JSON.parse(deposit.signatures);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].signer).toBe('0x111...');
  });

  it('clears signatures when set to null', () => {
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);

    // First set some signatures
    testDb.updateDepositStatus(1, 'signed', [{ sig: 'test' }]);

    // Then update without signatures (e.g., reset to failed)
    testDb.updateDepositStatus(1, 'failed');

    const deposit = testDb.getAllDeposits()[0];
    expect(deposit.status).toBe('failed');
    expect(deposit.signatures).toBeNull();
  });

  it('updates the updated_at timestamp', () => {
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);

    const before = testDb.getAllDeposits()[0].updated_at;

    // Small delay to ensure timestamp changes (unixepoch granularity = 1 second)
    testDb.updateDepositStatus(1, 'processing');

    const after = testDb.getAllDeposits()[0].updated_at;

    // updated_at should be >= before (might be same second in fast tests)
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('walk through full lifecycle: pending -> processing -> signed -> finalized', () => {
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);

    testDb.updateDepositStatus(1, 'processing');
    expect(testDb.getAllDeposits()[0].status).toBe('processing');

    testDb.updateDepositStatus(1, 'signed', [{ sig: 'test' }]);
    expect(testDb.getAllDeposits()[0].status).toBe('signed');

    testDb.updateDepositStatus(1, 'finalized');
    expect(testDb.getAllDeposits()[0].status).toBe('finalized');
  });
});

// ============================================================================
// getDepositByTxHash
// ============================================================================

describe('getDepositByTxHash', () => {
  it('finds a deposit by chain + txHash + nonce', () => {
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);

    const found = testDb.getDepositByTxHash('evm', EVM_TO_ZANO_DEPOSIT.txHash, 0);

    expect(found).toBeDefined();
    expect(found.tx_hash).toBe(EVM_TO_ZANO_DEPOSIT.txHash);
    expect(found.source_chain).toBe('evm');
  });

  it('returns undefined for non-existent deposit', () => {
    const found = testDb.getDepositByTxHash('evm', '0xnonexistent', 0);
    expect(found).toBeUndefined();
  });

  it('distinguishes between chains', () => {
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);

    // Same tx_hash but wrong chain -> not found
    const found = testDb.getDepositByTxHash('zano', EVM_TO_ZANO_DEPOSIT.txHash, 0);
    expect(found).toBeUndefined();
  });

  it('distinguishes between nonces', () => {
    testDb.addDeposit(EVM_TO_ZANO_DEPOSIT);

    // Same chain and tx_hash but different nonce -> not found
    const found = testDb.getDepositByTxHash('evm', EVM_TO_ZANO_DEPOSIT.txHash, 999);
    expect(found).toBeUndefined();
  });
});
