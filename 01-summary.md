# deuro TSS Bridge: EVM ↔ Zano

## Summary

A decentralized bridge between EVM chains (Sepolia testnet) and Zano using threshold ECDSA (DKLs23). Three independent parties each run a service on their own infrastructure. No central coordinator or blockchain needed.

Built by referencing the [Bridgeless security paper](https://arxiv.org/abs/2506.19730) (arXiv 2506.19730) -- algorithms, security theorems, and the production Go implementation.

## How it works

Threshold ECDSA (2-of-3) via DKLs23: a single ECDSA private key gets split into 3 shares via distributed key generation. Any 2 of 3 parties can cooperate to produce a valid signature without ever reconstructing the full key. The output is a standard secp256k1 ECDSA signature -- indistinguishable from one produced by a regular wallet.

The protocol uses `@silencelaboratories/dkls-wasm-ll-node` (Rust compiled to WASM, Trail of Bits audited April 2024):
- **DKG**: 5 rounds, all 3 parties → each gets a keyshare, all share the same group public key
- **Signing**: 6 rounds, 2-of-3 parties → single combined (R, S) ECDSA signature
- **No V output**: DKLs23 only produces (R, S). The recovery parameter V is computed by trial `ecrecover`

Why this works for both chains:
- **EVM**: The bridge contract stores the TSS group address as the sole registered signer (threshold=1). Withdrawals need one valid ECDSA signature verified via `ecrecover`. The 2-of-3 threshold is enforced off-chain by the TSS protocol.
- **Zano**: Has external ECDSA signing for asset operations via `send_ext_signed_asset_tx`. The TSS group controls a Zano asset (dEURO). Minting requires an Ethereum-style signature from the asset owner key -- which is the TSS key.

## Architecture

```
     EVM (Sepolia)                              Zano (Testnet)
    ┌──────────────────┐                   ┌──────────────────┐
    │ DeuroToken (ERC20)│                   │ dEURO asset      │
    │  12 decimals      │                   │  12 decimals     │
    │  bridge can mint  │                   │  TSS key = owner │
    └────────┬─────────┘                   └────────┬─────────┘
             │                                       │
    ┌────────▼─────────┐                             │
    │ DeuroBridge.sol   │                             │
    │  depositERC20()   │──── 3 parties detect ──────►│ emit_asset
    │  withdrawERC20()  │◄─── 3 parties sign ────────│ burn + memo
    └──────────────────┘                             │
             │         ┌───────────────┐             │
             └─────────│  TSS Network  │─────────────┘
                       │               │
                       │  Party A ◄──► Party B    P2P
                       │    ▲              ▲
                       │    └──── Party C ─┘
                       └───────────────┘
```

## Token: dEURO

The bridge moves dEURO between chains. Both sides use 12 decimal places -- no conversion needed.

| Chain | Representation | Decimals |
|-------|---------------|----------|
| EVM (Sepolia) | DeuroToken.sol (ERC20) | 12 |
| Zano (Testnet) | Custom asset `ff3666...` | 12 |

## Flow: EVM → Zano

1. User approves bridge to spend dEURO, calls `depositERC20()`
2. Bridge locks tokens, emits `DepositedERC20` event
3. All 3 parties detect the event (64-block confirmation wait)
4. Session leader proposes: "mint X dEURO to Zano address Y"
5. Other parties independently verify the deposit on-chain (Paper Algorithm 5)
6. Leader selects 2-of-3 signers, creates unsigned Zano emit tx
7. Both signers run DKLs23 TSS protocol (6 rounds P2P exchange) → single (R, S) signature
8. Leader encodes R+S as hex and broadcasts signed tx to Zano via `send_ext_signed_asset_tx`
9. Zano mints dEURO to the user's address

## Flow: Zano → EVM

1. User burns dEURO on Zano with service_entries memo: `{dst_add: "0x...", dst_net_id: "evm"}`
2. All 3 parties detect the burn transaction (10-block confirmation wait)
3. Session leader proposes: "mint X dEURO to EVM address Y"
4. Other parties independently verify the burn on-chain (Paper Algorithm 5)
5. Both signers compute the EVM withdrawal hash (deterministic, matches Bridge.sol)
6. Both apply EIP-191 prefix, run DKLs23 TSS protocol → single (R, S) signature
7. Leader computes V by trial recovery, formats 65-byte signature, submits `withdrawERC20()` on-chain
8. Bridge contract verifies the signature and mints dEURO to the user

## What each party runs

A single Node.js service with these components:

- **Chain watchers** -- monitors Bridge.sol events + Zano burn transactions
- **Consensus engine** -- propose-accept protocol before signing (Algorithms 4 & 5)
- **TSS engine** -- DKLs23 threshold ECDSA via WASM (keygen + signing)
- **Finalizer** -- submits withdrawal on target chain (Algorithm 7)
- **P2P layer** -- HTTP messaging between parties (production: gRPC + mTLS)
- **Database** -- SQLite to track deposits and their processing status

## Security model

Security properties from the paper (arXiv 2506.19730):

- **Theorem 1 (Liveness)**: Every honest deposit eventually produces a withdrawal
- **Theorem 4 (Safety)**: Every withdrawal has a corresponding deposit
- **Independent verification**: Each party verifies deposits on-chain before signing -- nobody trusts the proposer
- **Replay protection**: On-chain `usedHashes` mapping prevents double-spending
- **Confirmation requirements**: 64 blocks for Ethereum, 10 blocks for Zano (match Bridgeless production)

Threat model:
- At most 1 of 3 parties can be compromised
- A single compromised party can't produce valid signatures (TSS requires 2 shares)
- 2 honest parties can always sign (1 can be offline)
- The full private key never exists anywhere -- not even during signing

## PoC vs Production

| Aspect | PoC (this repo) | Production (Bridgeless) |
|--------|-----------------|------------------------|
| Signing | DKLs23 TSS (2-of-3, WASM) | GG19 TSS (bnb-chain/tss-lib, Go) |
| On-chain threshold | 1 (TSS produces 1 combined sig) | 1 (same) |
| P2P | HTTP + API key | gRPC + mutual TLS |
| Broadcast | Simple HTTP | Dolev-Strong reliable broadcast |
| Finalization | Leader auto-submits | Separate relayer service |
| Key storage | Binary keyshare files | HashiCorp Vault |

The consensus, watchers, chain clients, and security logic are identical. The signing protocol differs (DKLs23 vs GG19) but both produce a single standard ECDSA signature.

## Reference

- **Security paper**: [arXiv 2506.19730](https://arxiv.org/abs/2506.19730) -- "Formalization and security analysis of the Bridgeless protocol"
- **TSS library**: [@silencelaboratories/dkls-wasm-ll-node](https://www.npmjs.com/package/@silencelaboratories/dkls-wasm-ll-node) v1.2.0 (Trail of Bits audited)
- **Go implementation**: Bridgeless `tss-svc` (signing, consensus, chain clients)
- **Solidity contracts**: Bridgeless `bridge-contracts` (Bridge.sol, Signers.sol, Hashes.sol)
