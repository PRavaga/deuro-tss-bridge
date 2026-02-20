# deuro TSS Bridge

Decentralized bridge between EVM (Sepolia) and Zano using DKLs23 threshold ECDSA (2-of-3). Three independent parties run a Node.js service that cooperatively signs transactions -- no party ever holds the full private key.

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

**EVM → Zano**: User deposits dEURO into bridge contract → parties detect event → consensus → 2-of-3 TSS signing → dEURO appears on Zano

**Zano → EVM**: User burns dEURO with destination memo → parties detect burn → consensus → 2-of-3 TSS signing → dEURO minted on Sepolia

## Signing

DKLs23 threshold ECDSA via `@silencelaboratories/dkls-wasm-ll-node` (Trail of Bits audited, April 2024):
- **Keygen**: distributed DKG ceremony (5 rounds) → each party saves a keyshare, all share one group public key
- **Signing**: 2-of-3 parties run a multi-round protocol → single standard secp256k1 ECDSA signature
- The full private key never exists anywhere -- not during keygen, not during signing

## Repository structure

```
01-summary.md          High-level architecture and security model
02-detailed-guide.md   Deep technical guide (crypto, consensus, signing, deployment)

poc/                   Working implementation
  contracts/           DeuroBridge.sol, DeuroToken.sol (Solidity)
  src/                 Party service, TSS, consensus, watchers, signers, P2P
  scripts/             Deploy, run parties, Zano testnet setup, E2E test
  test/                102 tests (contract, unit, integration)
```

## Quick start

```bash
cd poc
npm install

# Run tests (no external deps needed)
npm test

# Generate TSS keyshares (run all 3 simultaneously)
PARTY_ID=0 node src/keygen.js
PARTY_ID=1 node src/keygen.js
PARTY_ID=2 node src/keygen.js

# Start all 3 parties
./scripts/run-parties.sh start
```

See [`poc/README.md`](poc/README.md) for full setup, deployment, live testing, and deposit instructions.

## Security

Key properties (from the [Bridgeless paper](https://arxiv.org/abs/2506.19730)):
- Independent chain verification -- each party checks deposits on-chain before signing
- Replay protection via on-chain `usedHashes`
- 64-block confirmation for Ethereum, 10 blocks for Zano
- At most 1 of 3 parties can be compromised; 2 honest parties can always sign
- No party ever holds the full key -- a single compromised party learns nothing about the private key

## License

MIT
