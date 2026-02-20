import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // better-sqlite3 uses native bindings that are NOT thread-safe.
    // The default "threads" pool uses worker_threads which share memory,
    // causing SIGSEGV when multiple tests touch SQLite concurrently.
    // "forks" spawns child processes instead -- each gets its own memory space.
    pool: 'forks',

    // 30s default is tight for Hardhat compilation on first run
    testTimeout: 60_000,
  },
});
