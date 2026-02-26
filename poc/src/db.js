// SQLite database for deposit/withdrawal tracking
//
// Each party maintains their own local database.
// Tracks deposits detected on both chains and their processing status.

import Database from 'better-sqlite3';
import { join } from 'path';
import { config } from './config.js';

const DB_PATH = join(config.dataDir, `party-${config.partyId}.db`);

let db;

export function getDb() {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_chain TEXT NOT NULL,         -- 'evm' or 'zano'
      tx_hash TEXT NOT NULL,
      tx_nonce INTEGER NOT NULL DEFAULT 0,
      token_address TEXT,
      amount TEXT NOT NULL,
      sender TEXT,
      receiver TEXT NOT NULL,              -- Destination address
      dest_chain TEXT NOT NULL,            -- 'evm' or 'zano'
      status TEXT NOT NULL DEFAULT 'pending',
        -- pending, processing, signed, finalized, failed
      signatures TEXT,                     -- JSON array of collected signatures
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(source_chain, tx_hash, tx_nonce)
    );

  `);

  return db;
}

export function addDeposit(deposit) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO deposits
      (source_chain, tx_hash, tx_nonce, token_address, amount, sender, receiver, dest_chain)
    VALUES
      (@sourceChain, @txHash, @txNonce, @tokenAddress, @amount, @sender, @receiver, @destChain)
  `);
  return stmt.run(deposit);
}

export function getPendingDeposits(destChain) {
  const db = getDb();
  // Paper Algorithm 4, Line 2: pick oldest PENDING request.
  // Also include 'signed' deposits that are stale (>60s old) — these represent
  // deposits where finalization failed and were not reset (Paper Algo 3, Line 40).
  return db.prepare(`
    SELECT * FROM deposits
    WHERE dest_chain = ? AND (
      status = 'pending'
      OR (status = 'signed' AND updated_at < unixepoch() - 60)
    )
    ORDER BY id ASC
    LIMIT 1
  `).all(destChain);
}

export function updateDepositStatus(id, status, signatures = null) {
  const db = getDb();
  // Never downgrade from 'finalized' — prevents race where a concurrent
  // finalization notification gets overwritten by a proposer timeout reset.
  const stmt = db.prepare(`
    UPDATE deposits
    SET status = ?, signatures = ?, updated_at = unixepoch()
    WHERE id = ? AND status != 'finalized'
  `);
  return stmt.run(status, signatures ? JSON.stringify(signatures) : null, id);
}

export function getDepositByTxHash(sourceChain, txHash, txNonce) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM deposits
    WHERE source_chain = ? AND tx_hash = ? AND tx_nonce = ?
  `).get(sourceChain, txHash, txNonce);
}
