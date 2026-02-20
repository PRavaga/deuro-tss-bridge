// ============================================================================
// In-Memory SQLite Test Database
// ============================================================================
//
// Creates a fresh in-memory SQLite database with the same schema as db.js,
// but without touching the filesystem. Each call to createTestDb() returns
// an isolated database -- perfect for parallel tests that must not share state.
//
// The real db.js uses a singleton pattern tied to config.dataDir, which makes
// it awkward to test in isolation. Instead of mocking it, we replicate the
// schema here and export thin CRUD wrappers with the same signatures.
//
// Usage in tests:
//   const { db, addDeposit, getPendingDeposits, ... } = createTestDb();
//   // ... run assertions ...
//   db.close();  // optional -- GC handles it, but good practice
// ============================================================================

import Database from 'better-sqlite3';

/**
 * Create a fresh in-memory SQLite database with the bridge schema.
 *
 * Returns an object with the raw db handle plus the same CRUD functions
 * exported by src/db.js, but bound to this specific in-memory instance.
 */
export function createTestDb() {
  // ':memory:' tells SQLite to keep everything in RAM.
  // Each call creates a completely independent database.
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Exact same schema as src/db.js -- if the schema changes there,
  // update it here too.
  db.exec(`
    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_chain TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      tx_nonce INTEGER NOT NULL DEFAULT 0,
      token_address TEXT,
      amount TEXT NOT NULL,
      sender TEXT,
      receiver TEXT NOT NULL,
      dest_chain TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      signatures TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(source_chain, tx_hash, tx_nonce)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      leader_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      deposit_id INTEGER REFERENCES deposits(id),
      created_at INTEGER DEFAULT (unixepoch())
    );
  `);

  // ---- CRUD functions (same signatures as src/db.js) ----

  function addDeposit(deposit) {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO deposits
        (source_chain, tx_hash, tx_nonce, token_address, amount, sender, receiver, dest_chain)
      VALUES
        (@sourceChain, @txHash, @txNonce, @tokenAddress, @amount, @sender, @receiver, @destChain)
    `);
    return stmt.run(deposit);
  }

  function getPendingDeposits(destChain) {
    return db.prepare(`
      SELECT * FROM deposits
      WHERE dest_chain = ? AND status = 'pending'
      ORDER BY id ASC
      LIMIT 1
    `).all(destChain);
  }

  function updateDepositStatus(id, status, signatures = null) {
    const stmt = db.prepare(`
      UPDATE deposits
      SET status = ?, signatures = ?, updated_at = unixepoch()
      WHERE id = ?
    `);
    return stmt.run(status, signatures ? JSON.stringify(signatures) : null, id);
  }

  function getDepositByTxHash(sourceChain, txHash, txNonce) {
    return db.prepare(`
      SELECT * FROM deposits
      WHERE source_chain = ? AND tx_hash = ? AND tx_nonce = ?
    `).get(sourceChain, txHash, txNonce);
  }

  function getAllDeposits() {
    return db.prepare('SELECT * FROM deposits ORDER BY id ASC').all();
  }

  return {
    db,
    addDeposit,
    getPendingDeposits,
    updateDepositStatus,
    getDepositByTxHash,
    getAllDeposits,
  };
}
