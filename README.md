# deuro TSS Bridge

Decentralized bridge between EVM (Sepolia) and Zano using 2-of-3 threshold signatures. Three independent parties run a Node.js service — no central coordinator needed.

Built by referencing the [Bridgeless security paper](https://arxiv.org/abs/2506.19730) and the production Go implementation.

## How it works

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

**EVM → Zano**: User deposits dEURO into bridge contract → parties detect event → consensus → sign Zano mint tx → dEURO appears on Zano

**Zano → EVM**: User burns dEURO with destination memo → parties detect burn → consensus → sign EVM withdrawal → dEURO minted on Sepolia

## Repository structure

```
01-summary.md          High-level architecture and security model
02-detailed-guide.md   Deep technical guide (crypto, consensus, signing, deployment)

poc/                   Working implementation
  contracts/           DeuroBridge.sol, DeuroToken.sol (Solidity)
  src/                 Party service, consensus, watchers, signers, P2P
  scripts/             Deploy, run parties, Zano testnet setup, E2E test
  test/                114 tests (contract, unit, integration)
```

## Quick start

```bash
cd poc
npm install

# Run tests (no external deps needed)
npm test

# Generate party keys
node src/keygen.js

# Start all 3 parties
./scripts/run-parties.sh start
```

See [`poc/README.md`](poc/README.md) for full setup, deployment, live testing, and deposit instructions.

## Security

Key properties (from the [Bridgeless paper](https://arxiv.org/abs/2506.19730)):
- Independent chain verification — each party checks deposits on-chain before signing
- Replay protection via on-chain `usedHashes`
- 64-block confirmation for Ethereum, 10 blocks for Zano
- At most 1 of 3 parties can be compromised; 2 honest parties can always sign

## PoC vs Production

| Aspect | PoC | Production |
|--------|-----|-----------|
| Signing | Individual ECDSA (multi-sig) | GG19 TSS (bnb-chain/tss-lib) |
| On-chain threshold | 2 (needs 2 sigs) | 1 (TSS combined sig) |
| P2P | HTTP + API key | gRPC + mutual TLS |
| Key storage | JSON file | HashiCorp Vault |

Consensus, watchers, chain clients, and security logic are identical. Upgrading to TSS only changes the signing layer.

## License

MIT
