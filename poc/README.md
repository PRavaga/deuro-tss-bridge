# deuro TSS Bridge PoC

2-of-3 threshold signature bridge between EVM (Sepolia) and Zano testnet.
Built by referencing the [Bridgeless security paper](https://arxiv.org/abs/2506.19730) and the production Go implementation.

## Architecture

The PoC uses individual ECDSA keys with on-chain 2-of-3 multi-sig verification. In production, swap for real GG19 threshold ECDSA (bnb-chain/tss-lib) — everything else stays the same.

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

**EVM → Zano**: User approves bridge → `depositERC20()` locks dEURO → parties detect `DepositedERC20` → consensus → sign Zano emit tx → broadcast → dEURO minted on Zano

**Zano → EVM**: User burns dEURO with service_entries memo `{dst_add, dst_net_id}` → parties detect burn → consensus → sign EVM withdrawal hash → leader submits `withdrawERC20()` → dEURO minted on Sepolia

## Setup

```bash
npm install

# Generate 3 party keys
node src/keygen.js

# Deploy bridge to Sepolia
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
# All 114 tests (unit + integration + contract)
npm test

# By category
npm run test:unit        # DB, consensus, EVM signer, Zano utils
npm run test:contract    # DeuroBridge.sol (39 tests, Hardhat)
npm run test:integration # EVM→Zano and Zano→EVM flows
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

Requires `DEPOSITOR_KEY` in `.env` — a Sepolia private key with ETH (from any faucet) and dEURO tokens (ask the contract deployer to send you some).

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
  party.js              Main service: watcher + consensus + signer + finalizer
  consensus.js          Propose-accept consensus (Paper Algorithms 4 & 5)
  evm-watcher.js        Monitor bridge for DepositedERC20/Native events
  zano-watcher.js       Monitor Zano wallet for asset burn transactions
  evm-signer.js         EVM withdrawal hash computation + ECDSA signing
  zano-signer.js        Zano tx signing + broadcast
  p2p.js                HTTP-based P2P messaging between parties
  db.js                 SQLite database for deposit tracking
  config.js             Configuration (parties, RPC, contracts, confirmations)
  keygen.js             Generate 3 ECDSA keypairs
  zano-rpc.js           Zano daemon/wallet JSON-RPC client
  deposit-evm.js        CLI: make an EVM deposit (approve + depositERC20)
  deposit-zano.js       CLI: make a Zano deposit (burn + service_entries memo)

scripts/
  deploy.js             Deploy DeuroBridge to Sepolia
  deploy-token.js       Deploy DeuroToken + grant MINTER_ROLE to bridge
  demo-signing.js       Interactive signing demo (step-by-step 2-of-3)
  withdraw-evm.js       Manual EVM withdrawal submission (fallback)
  run-parties.sh        Start/stop/status for all 3 parties
  setup-zano-testnet.sh Download + start Zano testnet (daemon + wallet)
  e2e-test.sh           End-to-end bridge test (both directions)

test/
  contract/bridge.test.js        39 contract tests (Hardhat + Vitest)
  unit/db.test.js                21 database tests
  unit/consensus.test.js         16 consensus tests
  unit/evm-signer.test.js        16 EVM signer tests
  unit/zano-utils.test.js         9 Zano utility tests
  integration/evm-to-zano.test.js 7 EVM→Zano flow tests
  integration/zano-to-evm.test.js 6 Zano→EVM flow tests
  helpers/                        Test infrastructure (mock P2P, mock Zano, test DB)
```

## Security

Audited line-by-line against:
- **Paper**: [arXiv 2506.19730](https://arxiv.org/abs/2506.19730) — Algorithms 4-7 (consensus, signing, finalization), Algorithms 8/10/12/13 (chain clients)
- **Go implementation**: Bridgeless `tss-svc` (consensus, signing, finalization, chain operations)

Key security measures:
- Independent chain verification — acceptors never trust proposer's data (Theorem 4)
- Signature verification before collection (Algorithm 6, Lines 9-10)
- Signer deduplication — rejects relayed/duplicate signatures
- Single-proposal guard — prevents Byzantine multi-proposal (Algorithm 5, Line 4)
- Duplicate signing guard — rejects already-processed deposits
- Status guard before finalization (Algorithm 7, Line 2)
- Failed signing reverts to PENDING for retry (Theorem 1 liveness)
- On-chain: replay protection, bitmap signer dedup, ReentrancyGuard, Pausable

Confirmation requirements (match Bridgeless production):
- Ethereum: 64 blocks (~13 min)
- Zano: 10 blocks (~2 min)

## Upgrading to real TSS

1. Compile `bnb-chain/tss-lib` to a Go binary
2. Call from Node.js as subprocess for keygen and signing
3. Bridge.sol threshold=1 (TSS produces 1 combined signature)
4. Zano uses `send_ext_signed_asset_tx` with the TSS signature
5. P2P, consensus, watchers, finalization — unchanged
