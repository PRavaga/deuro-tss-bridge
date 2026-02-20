// ============================================================================
// Test Fixtures
// ============================================================================
//
// Shared test data used across unit, contract, and integration tests.
//
// The 3 Hardhat default accounts serve as our TSS parties:
//   - Party 0: Account #0 (deployer + signer)
//   - Party 1: Account #1
//   - Party 2: Account #2
//
// We use Hardhat's deterministic accounts so tests are reproducible
// without generating random keys. These are the same accounts you'd get
// from `npx hardhat node`.
// ============================================================================

import { ethers } from 'ethers';

// ---------------------------------------------------------------------------
// Hardhat default accounts (mnemonic: "test test test test test test test test
// test test test junk"). These are pre-funded with 10,000 ETH on the local
// Hardhat network.
// ---------------------------------------------------------------------------

export const PARTY_KEYS = [
  {
    id: 0,
    name: 'Party A',
    // Hardhat account #0
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  },
  {
    id: 1,
    name: 'Party B',
    // Hardhat account #1
    privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  },
  {
    id: 2,
    name: 'Party C',
    // Hardhat account #2
    privateKey: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  },
];

// ---------------------------------------------------------------------------
// Fake transaction hashes and Zano addresses for deposit simulation.
// These don't correspond to real transactions -- they're just deterministic
// hex strings that let us test hashing, signing, and DB operations without
// hitting a real chain.
// ---------------------------------------------------------------------------

export const MOCK_EVM_TX_HASH =
  '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

// A second unique tx hash for testing replay protection / multiple deposits
export const MOCK_EVM_TX_HASH_2 =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

// Fake Zano tx hashes (64 hex chars, no 0x prefix -- Zano style)
export const MOCK_ZANO_TX_HASH =
  'deadbeef00000000deadbeef00000000deadbeef00000000deadbeef00000000';

export const MOCK_ZANO_TX_HASH_2 =
  'cafebabe11111111cafebabe11111111cafebabe11111111cafebabe11111111';

// Fake Zano address (standard base58 style, just needs to be a plausible string)
export const MOCK_ZANO_ADDRESS =
  'ZxBvJDhNafYkEdQrLqeMQnTkBQjL3hMGaHbYRQneKQcFG9TQ3prfNJBK3mYN3RDP2dGeg76JhMn3xnGLMXH6RE381Cu7jhU7t';

// Fake ERC20 token address (checksum format, used as dEURO token on EVM)
export const MOCK_TOKEN_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

// Fake Zano asset ID (64 hex chars, no 0x prefix)
export const MOCK_ZANO_ASSET_ID = 'ff36665da627f7f09a1fd8e9450d37ed19f92b2021d84a74a76e1c347c52603c';

// A zeroed-out token address (used for native ETH deposits)
export const ZERO_ADDRESS = ethers.ZeroAddress;

// ---------------------------------------------------------------------------
// Pre-built deposit objects matching the db.js addDeposit() schema.
// These are the JS-property-name versions (camelCase) that addDeposit expects.
// After insertion, SQLite returns snake_case columns.
// ---------------------------------------------------------------------------

/** EVM -> Zano deposit: user sent ETH on EVM, wants tokens minted on Zano */
export const EVM_TO_ZANO_DEPOSIT = {
  sourceChain: 'evm',
  txHash: MOCK_EVM_TX_HASH,
  txNonce: 0,
  tokenAddress: ZERO_ADDRESS,
  amount: ethers.parseEther('1.5').toString(), // "1500000000000000000"
  sender: PARTY_KEYS[0].address,
  receiver: MOCK_ZANO_ADDRESS,
  destChain: 'zano',
};

/** Zano -> EVM deposit: user burned tokens on Zano, wants ETH released on EVM */
export const ZANO_TO_EVM_DEPOSIT = {
  sourceChain: 'zano',
  txHash: MOCK_ZANO_TX_HASH,
  txNonce: 0,
  tokenAddress: MOCK_TOKEN_ADDRESS,
  amount: '1000000000000', // 1M tokens with 6 decimals
  sender: '',
  receiver: PARTY_KEYS[1].address, // Destination EVM address
  destChain: 'evm',
};

// ---------------------------------------------------------------------------
// Mock Zano RPC responses.
// These mirror the JSON-RPC result shapes returned by the real Zano daemon
// and wallet. See zano-rpc.js for the methods that consume these.
// ---------------------------------------------------------------------------

/** Response from `emit_asset` -- the unsigned mint transaction data */
export const MOCK_EMIT_ASSET_RESPONSE = {
  tx_id: MOCK_ZANO_TX_HASH,
  data_for_external_signing: {
    unsigned_tx: 'aabbccdd',     // Hex blob (abbreviated for tests)
    finalized_tx: 'eeff0011',    // Hex blob
    outputs_addresses: [MOCK_ZANO_ADDRESS],
    tx_secret_key: '22334455',   // Hex
  },
};

/** Response from `send_ext_signed_asset_tx` -- broadcast result */
export const MOCK_BROADCAST_RESPONSE = {
  status: 'OK',
};

/** Response from `search_for_transactions` with a burn tx */
export const MOCK_SEARCH_TX_RESPONSE = {
  in: [],
  out: [
    {
      tx_hash: MOCK_ZANO_TX_HASH,
      height: 100,
      ado: {
        operation_type: 4, // BURN
        opt_asset_id: MOCK_TOKEN_ADDRESS,
        opt_amount: 1000000000000,
      },
      remote_addresses: [],
      service_entries: [
        {
          body: Buffer.from(
            JSON.stringify({
              dst_add: PARTY_KEYS[1].address,
              dst_net_id: 'evm',
              referral_id: 0,
            })
          ).toString('hex'),
        },
      ],
    },
  ],
  pool: [],
};

/** Response from `getheight` daemon endpoint */
export const MOCK_HEIGHT_RESPONSE = {
  height: 500,
  status: 'OK',
};

// ---------------------------------------------------------------------------
// Bridge contract config for tests -- matches Hardhat's local chain ID.
// ---------------------------------------------------------------------------

export const TEST_CHAIN_ID = 31337; // Hardhat default chain ID
export const THRESHOLD = 2;
export const TOTAL_PARTIES = 3;
