# deuro TSS Bridge PoC

2-of-3 threshold ECDSA bridge between EVM (Sepolia) and Zano testnet using DKLs23.
Built by referencing the [Bridgeless security paper](https://arxiv.org/abs/2506.19730) and the production Go implementation.

## Architecture

Uses DKLs23 threshold ECDSA (`@silencelaboratories/dkls-wasm-ll-node`, Trail of Bits audited). Three parties run a distributed key generation ceremony to create keyshares. Any 2-of-3 can cooperate to produce a single standard ECDSA signature. No party ever holds the full private key.

The bridge contract is deployed with the TSS group address as the sole signer and threshold=1. The 2-of-3 requirement is enforced off-chain by the DKLs23 protocol.

```
EVM (Sepolia)                          Zano (Testnet)
┌─────────────────────┐                ┌─────────────────────┐
│  DeuroToken (ERC20) │                │  dEURO asset        │
│  - 12 decimals      │                │  - 12 decimals      │
│  - bridge can mint  │                │  - TSS key is owner │
└────────┬────────────┘                └────────┬────────────┘
         │                                      │
┌────────▼────────────┐                         │
│  DeuroBridge.sol    │                         │
│  - depositERC20     │  ──── parties ────►  emit_asset
│    (locks dEURO)    │      detect+sign        │
│                     │                         │
│  - withdrawERC20    │  ◄─── parties ────  burn + memo
│    (mints dEURO)    │      detect+sign     (service_entries)
└─────────────────────┘
```

**EVM → Zano**: User approves bridge → `depositERC20()` locks dEURO → parties detect `DepositedERC20` → consensus → 2-of-3 TSS sign Zano emit tx → broadcast → dEURO minted on Zano

**Zano → EVM**: User burns dEURO with service_entries memo `{dst_add, dst_net_id}` → parties detect burn → consensus → 2-of-3 TSS sign EVM withdrawal hash → leader submits `withdrawERC20()` → dEURO minted on Sepolia

## Setup

```bash
npm install

# Generate TSS keyshares (run all 3 simultaneously in separate terminals)
PARTY_ID=0 node src/keygen.js
PARTY_ID=1 node src/keygen.js
PARTY_ID=2 node src/keygen.js
# Output: data/keyshare-0.bin, keyshare-1.bin, keyshare-2.bin

# Deploy bridge to Sepolia (reads group address from keyshare-0.bin)
npx hardhat run scripts/deploy.js --network sepolia

# Deploy dEURO token + grant bridge mint role
BRIDGE_ADDRESS=0x... npx hardhat run scripts/deploy-token.js --network sepolia

# Start all 3 parties
./scripts/run-parties.sh start

# Check status
./scripts/run-parties.sh status
```

## Testing

```bash
# All 102 tests (unit + integration + contract)
npm test

# By category
npm run test:unit        # DB, consensus, EVM signer, Zano utils (55 tests)
npm run test:contract    # DeuroBridge.sol with real TSS signing (34 tests)
npm run test:integration # EVM→Zano and Zano→EVM flows with TSS (13 tests)
```

## Live Testing

Run the full bridge against live testnets (Sepolia + Zano testnet).

### 1. Set up environment

```bash
cp .env.example .env
# Edit .env: add DEPOSITOR_KEY (funded Sepolia wallet with dEURO)
```

### 2. Start Zano testnet

Downloads official binaries from build.zano.org, syncs, and opens a wallet.

```bash
./scripts/setup-zano-testnet.sh         # download + start (first run takes ~5 min)
./scripts/setup-zano-testnet.sh status   # check daemon + wallet
./scripts/setup-zano-testnet.sh stop     # stop everything
```

Linux x64 only. Data stored in `zano-testnet/` (gitignored).

### 3. Run E2E test

Starts 3 parties, deposits in both directions, waits for finalization.

```bash
./scripts/e2e-test.sh                   # full test (EVM→Zano + Zano→EVM)
SKIP_ZANO=1 ./scripts/e2e-test.sh       # EVM→Zano only
```

Uses `EVM_CONFIRMATIONS=2 ZANO_CONFIRMATIONS=2` by default for speed (~2 min per direction instead of ~15 min).

Requires `DEPOSITOR_KEY` in `.env` -- a Sepolia private key with ETH (from any faucet) and dEURO tokens (ask the contract deployer to send you some).

## Making a deposit

```bash
# EVM → Zano (lock dEURO on Sepolia, mint on Zano)
DEPOSITOR_KEY=0x... node src/deposit-evm.js <zano-address> <amount>

# Zano → EVM (burn dEURO on Zano, mint on Sepolia)
node src/deposit-zano.js <evm-address> <amount>
```

## Files

```
contracts/
  DeuroBridge.sol       Bridge contract (deposits, withdrawals, sig verification)
  DeuroToken.sol        ERC20 dEURO with bridge mint authority (12 decimals)

src/
  tss.js                TSS wrapper: DKLs23 WASM init, keygen, signing, message serialization
  party.js              Main service: watcher + consensus + TSS signing + finalizer
  consensus.js          Propose-accept consensus (Paper Algorithms 4 & 5)
  evm-watcher.js        Monitor bridge for DepositedERC20/Native events
  zano-watcher.js       Monitor Zano wallet for asset burn transactions
  evm-signer.js         EVM withdrawal hash computation + TSS signing orchestration
  zano-signer.js        Zano tx signing via TSS + broadcast
  p2p.js                HTTP-based P2P messaging between parties
  db.js                 SQLite database for deposit tracking
  config.js             Configuration (parties, RPC, contracts, keyshare loading)
  keygen.js             Distributed DKG ceremony (3 parties, P2P)
  zano-rpc.js           Zano daemon/wallet JSON-RPC client
  deposit-evm.js        CLI: make an EVM deposit (approve + depositERC20)
  deposit-zano.js       CLI: make a Zano deposit (burn + service_entries memo)

scripts/
  deploy.js             Deploy DeuroBridge (reads group address from keyshare, threshold=1)
  deploy-token.js       Deploy DeuroToken + grant MINTER_ROLE to bridge
  run-parties.sh        Start/stop/status for all 3 parties
  setup-zano-testnet.sh Download + start Zano testnet (daemon + wallet)
  e2e-test.sh           End-to-end bridge test (both directions)

test/
  contract/bridge.test.js        34 contract tests (Hardhat + real TSS signing)
  unit/db.test.js                21 database tests
  unit/consensus.test.js         16 consensus tests
  unit/evm-signer.test.js         9 EVM signer tests
  unit/zano-utils.test.js         9 Zano utility tests
  integration/evm-to-zano.test.js 7 EVM→Zano flow tests (real TSS)
  integration/zano-to-evm.test.js 6 Zano→EVM flow tests (real TSS)
  helpers/
    tss-test-keyshares.js  Real DKLs23 keyshares (in-process DKG, cached)
    in-process-p2p.js      EventEmitter P2P bus (no HTTP)
    mock-zano-rpc.js       Configurable fake Zano RPC
    test-db.js             In-memory SQLite per test
  fixtures.js              Shared test data (Hardhat accounts, mock hashes)
```

## Security

Audited line-by-line against:
- **Paper**: [arXiv 2506.19730](https://arxiv.org/abs/2506.19730) -- Algorithms 4-7 (consensus, signing, finalization), Algorithms 8/10/12/13 (chain clients)
- **Go implementation**: Bridgeless `tss-svc` (consensus, signing, finalization, chain operations)

Key security measures:
- Independent chain verification -- acceptors never trust proposer's data (Theorem 4)
- 2-of-3 TSS for both EVM and Zano signing (no single party can sign alone)
- Single-proposal guard -- prevents Byzantine multi-proposal (Algorithm 5, Line 4)
- Duplicate signing guard -- rejects already-processed deposits
- Status guard before finalization (Algorithm 7, Line 2)
- Failed signing reverts to PENDING for retry (Theorem 1 liveness)
- On-chain: replay protection, bitmap signer dedup, ReentrancyGuard, Pausable

Confirmation requirements (match Bridgeless production):
- Ethereum: 64 blocks (~13 min)
- Zano: 10 blocks (~2 min)

## Deployed Infrastructure

### EVM (Sepolia)
- **Bridge contract**: `0x72D501f30325aE86C6E2Bb2b50C73d688aa3a09e`
- **DeuroToken (ERC20)**: `0xa7ff975db5AF3Ca92D7983ef944a636Ca962CB60` (12 decimals, bridge has MINTER_ROLE)
- **RPC**: `https://eth-sepolia.g.alchemy.com/v2/z97HTgIuGjc4F_sD1-0EZ`
- **Deployer**: `0x45743661201502702Cd6a28AD12BD0f826B61eB3`

### Zano (Testnet)
- **dEURO asset ID**: `ff36665da627f7f09a1fd8e9450d37ed19f92b2021d84a74a76e1c347c52603c`
- **Daemon RPC**: `http://127.0.0.1:12111/json_rpc`
- **Wallet RPC**: `http://127.0.0.1:12212/json_rpc`
- **Wallet address**: `ZxDAcbaxXkyWRgYbeARBpngfmFat5TjDjjQA5NAbouB9eytwGWJqA5shAVYeCAHWPo254DF2o2X1td79PNvRr2Yc1b9Ep67ff`
- **Public node**: `37.27.100.59:10505` (nginx proxy, whitelisted endpoints)

## Running Parties

```bash
# Terminal 1-3 (each party)
PARTY_ID=0 BRIDGE_ADDRESS=0x72D501f30325aE86C6E2Bb2b50C73d688aa3a09e \
  EVM_RPC=https://eth-sepolia.g.alchemy.com/v2/z97HTgIuGjc4F_sD1-0EZ \
  ZANO_DAEMON_RPC=http://127.0.0.1:12111/json_rpc \
  ZANO_WALLET_RPC=http://127.0.0.1:12212/json_rpc \
  ZANO_ASSET_ID=ff36665da627f7f09a1fd8e9450d37ed19f92b2021d84a74a76e1c347c52603c \
  node src/party.js
```
