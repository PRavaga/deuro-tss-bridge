# deuro TSS Bridge: Detailed Technical Guide

## Table of contents

1. [Cryptographic foundation](#1-cryptographic-foundation)
2. [Architecture overview](#2-architecture-overview)
3. [Key generation](#3-key-generation)
4. [P2P communication layer](#4-p2p-communication-layer)
5. [Consensus protocol](#5-consensus-protocol)
6. [EVM integration](#6-evm-integration)
7. [Zano integration](#7-zano-integration)
8. [Signing protocol](#8-signing-protocol)
9. [Security](#9-security)
10. [Deployment](#10-deployment)
11. [Test suite](#11-test-suite)
12. [Bridgeless code reference](#12-bridgeless-code-reference)

---

## 1. Cryptographic foundation

### 1.1 Threshold ECDSA (DKLs23)

The bridge uses threshold ECDSA on secp256k1 -- the same curve Ethereum uses, and the one Zano accepts for external asset signatures.

Parameters for 2-of-3:
- `N = 3` (total parties)
- `T = 2` (threshold -- minimum parties to sign)
- `f = N - (T+1) = 0` (max tolerated Byzantine parties for liveness)

The PoC implements DKLs23 via `@silencelaboratories/dkls-wasm-ll-node` v1.2.0 (Rust compiled to WASM, Trail of Bits audited April 2024). The production Bridgeless system uses GG19 via `bnb-chain/tss-lib` (Go). Both produce standard secp256k1 ECDSA signatures.

DKG (5 rounds, all 3 parties):
1. `createFirstMessage()` → broadcast
2. `handleMessages(filter(msg1))` → P2P directed messages
3. `calculateChainCodeCommitment()` + `handleMessages(select(msg2))` → P2P directed
4. `handleMessages(select(msg3), commitments)` → broadcast
5. `handleMessages(filter(msg4))` → finalize, extract keyshare

Signing (6 rounds, 2-of-3 parties):
1. `createFirstMessage()` → broadcast to co-signer
2. `handleMessages(filter(msg1))` → P2P
3. `handleMessages(select(msg2))` → P2P
4. `handleMessages(select(msg3))` → pre-signature computed internally
5. `lastMessage(messageHash)` → broadcast
6. `combine(filter(msg4))` → `[R, S]` (both Uint8Array(32))

Output: standard 32-byte R + 32-byte S. No V -- compute by trial `ecrecover` with v=27 and v=28.

### 1.2 Why TSS, not multisig

| | TSS | Multisig |
|---|---|---|
| On-chain footprint | Single signature, single address | Multiple signatures, contract-based |
| Gas cost | Low (1 ecrecover) | High (N ecrecovers) |
| Zano compatibility | Works via `send_ext_signed_asset_tx` | Not supported natively |
| Privacy | Indistinguishable from normal tx | Reveals threshold scheme |
| Zano security | 2-of-3 cooperative signing | Only leader signs (1-of-1) |

The Zano side is the key motivation: Zano's `send_ext_signed_asset_tx` accepts exactly one ECDSA signature. With multi-sig, only the leader signs -- making the Zano side effectively 1-of-1 (a single rogue party can mint tokens). TSS fixes this by requiring 2-of-3 cooperation for every signature.

### 1.3 WASM memory model

The DKLs23 library uses WASM heap memory:
- `handleMessages()` and `combine()` take ownership of input `Message` objects (free them internally). Do NOT call `.free()` after passing messages to these methods.
- `SignSession` constructor consumes the `Keyshare` -- always reload from bytes.
- Output messages from `handleMessages()` are new allocations -- serialize before the next round.
- `filterMessages(msgs, party)` = `msgs.filter(m => m.from_id !== party).map(m => m.clone())`
- `selectMessages(msgs, party)` = `msgs.filter(m => m.to_id === party).map(m => m.clone())`

### 1.4 Production comparison

| Aspect | PoC (DKLs23) | Production (GG19) |
|--------|-------------|-------------------|
| Library | `@silencelaboratories/dkls-wasm-ll-node` | `bnb-chain/tss-lib` |
| Language | Rust → WASM → Node.js | Go |
| DKG rounds | 5 | 9 |
| Signing rounds | 6 | 9 |
| Pre-parameters | None | Paillier keypair + safe primes |
| Audit | Trail of Bits (April 2024) | Multiple audits |

Both produce identical output: standard secp256k1 ECDSA (R, S) signatures.

---

## 2. Architecture overview

### 2.1 Token: dEURO

The bridge moves dEURO between chains. Both sides use 12 decimal places -- no conversion needed. This eliminates scaling bugs entirely.

| Chain | Representation | Decimals | Control |
|-------|---------------|----------|---------|
| EVM (Sepolia) | DeuroToken.sol (ERC20) | 12 | Bridge has MINTER_ROLE |
| Zano (Testnet) | Custom asset `ff3666...` | 12 | TSS key is asset owner |

### 2.2 Flow diagram

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
└─────────────────────┘                         │
         │         ┌───────────────┐            │
         └─────────│  TSS Network  │────────────┘
                   │               │
                   │  Party A ◄──► Party B   P2P
                   │    ▲              ▲
                   │    └──── Party C ─┘
                   └───────────────┘
```

### 2.3 Component diagram (each party runs this)

```
┌──────────────────────────────────────────────────┐
│                    Party Service                  │
│                                                   │
│  ┌─────────────┐  ┌──────────────┐               │
│  │ EVM Watcher │  │ Zano Watcher │               │
│  │ (events)    │  │ (burns)      │               │
│  └──────┬──────┘  └──────┬───────┘               │
│         │                │                        │
│  ┌──────▼────────────────▼───────┐               │
│  │       Deposit Queue (SQLite)  │               │
│  │  (pending deposits to sign)   │               │
│  └──────────────┬────────────────┘               │
│                 │                                  │
│  ┌──────────────▼────────────────┐               │
│  │     Consensus Engine          │               │
│  │  - Leader election (SHA256)   │               │
│  │  - Propose / Accept           │               │
│  │  - Independent verification   │               │
│  │  - Signer selection           │               │
│  └──────────────┬────────────────┘               │
│                 │                                  │
│  ┌──────────────▼────────────────┐               │
│  │     TSS Signing Engine        │               │
│  │  - DKLs23 via WASM           │               │
│  │  - Multi-round P2P protocol  │               │
│  │  - Single combined signature │               │
│  └──────────────┬────────────────┘               │
│                 │                                  │
│  ┌──────────────▼────────────────┐               │
│  │     Finalizer                 │               │
│  │  - EVM: withdrawERC20()       │               │
│  │  - Zano: send_ext_signed_tx   │               │
│  └──────────────┬────────────────┘               │
│                 │                                  │
│  ┌──────────────▼────────────────┐               │
│  │     P2P Layer (HTTP)          │               │
│  │  - Broadcast messages         │               │
│  │  - Direct send                │               │
│  │  - TSS round messages         │               │
│  └───────────────────────────────┘               │
└──────────────────────────────────────────────────┘
```

### 2.4 Session lifecycle

A signing session goes through these phases:

```
[Session N]
  │
  ├─ 1. Leader Election (deterministic, from session ID)
  │     └─ seed = SHA256(sessionId)[0:4] → leader index
  │
  ├─ 2. Consensus (10 seconds)
  │     ├─ Leader: propose pending deposit
  │     ├─ Acceptors: independently verify on-chain (Paper Algo 5)
  │     ├─ Acceptors: send ACK/NACK
  │     └─ Leader: select 2 signers from acceptors + self
  │
  ├─ 3. TSS Signing (30 seconds)
  │     ├─ Both signers compute hash (deterministic)
  │     ├─ Both run DKLs23 protocol (6 rounds P2P exchange)
  │     └─ Both arrive at identical (R, S) signature
  │
  ├─ 4. Finalization
  │     ├─ Status guard: only PROCESSING/PENDING (Algo 7, L2)
  │     ├─ EVM: leader computes V, formats 65-byte sig, submits on-chain
  │     ├─ Zano: leader encodes R+S as hex, broadcasts via Zano RPC
  │     └─ Error: revert to PENDING for retry (Theorem 1 liveness)
  │
  └─ 5. Next session
```

PoC timing: 60s session interval, 10s consensus, 30s signing.
Go timing: 5s/15s/13s/5s/7s phases.

---

## 3. Key generation

### 3.1 Distributed DKG ceremony

All 3 parties run `keygen.js` simultaneously. Each party participates in a DKLs23 distributed key generation ceremony via P2P message exchange.

```bash
# Run all 3 in separate terminals simultaneously:
PARTY_ID=0 node src/keygen.js
PARTY_ID=1 node src/keygen.js
PARTY_ID=2 node src/keygen.js
```

This creates binary keyshare files:
```
data/keyshare-0.bin
data/keyshare-1.bin
data/keyshare-2.bin
```

Each keyshare file contains the party's secret share. All 3 keyshares encode the same group public key.

The DKG ceremony flow:
1. Each party starts a temporary P2P server
2. Parties wait for all 3 to be online (health checks)
3. `distributedKeygen()` runs the 5-round DKLs23 protocol via P2P
4. Each party saves their keyshare to `data/keyshare-{partyId}.bin`
5. All parties print the same group ETH address
6. Exit

### 3.2 Production keygen (GG19)

Bridgeless uses GG19 (9 rounds) with pre-parameters:
- Two safe primes (p, q where p = 2p'+1, q = 2q'+1)
- A Paillier keypair derived from these primes
- Takes 30-60 seconds per party

Bridgeless ref: `tss-svc/internal/tss/keygener.go`

### 3.3 Output

The group public key determines:
- The Ethereum address of the TSS group: `address = keccak256(pubkey)[12:]`
- The Zano asset owner, registered via `transfer_asset_ownership` with `new_owner_eth_pub_key`

Key share security:
- A single share can't produce signatures -- it's useless on its own
- Shares must never leave the party after keygen
- If one share leaks, the attacker still needs another to sign anything
- If a share is lost, key resharing with the remaining honest parties can recover

---

## 4. P2P communication layer

### 4.1 PoC transport (HTTP)

Parties communicate over HTTP with pre-shared API keys:

```
Party A: http://localhost:4000/message
Party B: http://localhost:4001/message
Party C: http://localhost:4002/message

Headers:
  X-Sender: 0
  X-API-Key: <pre-shared-secret>
```

Implementation: `src/p2p.js`

- `broadcast(msg)` -- send to all other parties
- `sendToParty(partyId, msg)` -- direct send
- `onMessage(type, handler)` -- register handler for message type
- `waitForMessage(type, sessionId, timeout)` -- collect messages

### 4.2 Production transport (gRPC + mTLS)

Bridgeless ref: `tss-svc/internal/p2p/server.go`

Each party runs a gRPC server with mutual TLS:
```
TLS config:
  - ClientAuth: RequireAndVerifyClientCert
  - ClientCAs: [cert_party_A, cert_party_B, cert_party_C]
  - Certificate: this party's cert + key
```

Any incoming connection without a valid client cert gets rejected. The cert's public key maps to a known party identity.

### 4.3 Message types

| Type | Direction | Purpose |
|------|-----------|---------|
| `proposal` | Leader → All | Propose deposit for signing |
| `proposal_response` | Acceptor → Leader | ACK or NACK |
| `signer_set` | Leader → All | Which parties will sign |
| `tss_sign_msg1` | Signer ↔ Signer | TSS signing round 1 (broadcast) |
| `tss_sign_msg2` | Signer ↔ Signer | TSS signing round 2 (P2P) |
| `tss_sign_msg3` | Signer ↔ Signer | TSS signing round 3 (P2P) |
| `tss_sign_last` | Signer ↔ Signer | TSS signing last message (broadcast) |
| `tss_zano_tx_data` | Leader → Co-signer | Unsigned Zano tx for TSS signing |
| `tss_dkg_msg{1-4}` | All ↔ All | DKG ceremony rounds |
| `tss_dkg_commitment` | All ↔ All | DKG chain code commitments |

### 4.4 Reliable broadcast (Dolev-Strong)

Bridgeless uses Dolev-Strong reliable broadcast (Paper Definition 3) for Byzantine fault tolerance. With 2-of-3 and f=0, this reduces to a single broadcast round.

The PoC uses simple HTTP broadcast. Production should implement Dolev-Strong.

Bridgeless ref: `tss-svc/internal/p2p/broadcast/reliable.go`

---

## 5. Consensus protocol

Implementation: `src/consensus.js`

Paper reference: Algorithms 4 & 5 (arXiv 2506.19730)

### 5.1 Leader election

Each session has a deterministic leader. All parties compute it independently.

```javascript
// src/consensus.js
export function determineLeader(sessionId) {
  const hash = createHash('sha256').update(sessionId).digest();
  const seed = hash.readUInt32BE(0);
  return seed % config.totalParties;
}
```

PoC uses first 4 bytes of SHA256. Go uses ChaCha8 PRNG seeded with the full SHA256. Both are deterministic -- same result per session ID.

Bridgeless ref: `tss-svc/internal/tss/session/leader.go`

### 5.2 Proposer flow (Paper Algorithm 4)

```
Paper                                    PoC (consensus.js runAsProposer)
─────                                    ───────────────────────────────
Algo 4, L2: Select pending deposit   →   getPendingDeposits(destChain)[0]
Algo 4, L3: Compute signHash         →   Send raw fields (security-equivalent)
Algo 4, L5: Broadcast PROPOSAL       →   broadcast({type: 'proposal', ...})
Algo 4, L7: Wait for ACK/NACK        →   waitForMessage('proposal_response')
Algo 4, L9: Count threshold          →   acks.length >= config.threshold - 1
Algo 4, L10: Select signers          →   selectSigners(acceptors) + self
Algo 4, L12: Broadcast SIGNSTART     →   broadcast({type: 'signer_set', ...})
```

### 5.3 Acceptor flow (Paper Algorithm 5)

This is the security-critical path. The acceptor never trusts the proposer's data.

```
Paper                                    PoC (consensus.js runAsAcceptor)
─────                                    ───────────────────────────────
Algo 5, L2: proposedId ← ⊥           →   acceptedDepositId = null
Algo 5, L3: Wait for PROPOSAL        →   onMessage('proposal', handler)
Algo 5, L4: Require proposedId == ⊥  →   if (acceptedDepositId !== null) reject
Algo 5, L5: getDepositData(proposal) →   getEvmDepositData() or getZanoDepositData()
Algo 5, L8-10: Verify fields match   →   Compare amount, receiver, tokenAddress
Algo 5, L11: Send ACK or NACK        →   sendToParty(sender, {accepted: true/false})
Algo 5, L16: Wait for SIGNSTART      →   onMessage('signer_set', handler)
Algo 5, L16: Verify deposit matches  →   Check tx_hash against verifiedDeposit
```

### 5.4 Signer selection

From the parties that ACKed, the leader picks 2 signers deterministically:

```javascript
export function selectSigners(candidates, threshold, sessionId) {
  if (candidates.length <= threshold) return candidates;

  // Deterministic shuffle using session ID
  const hash = createHash('sha256').update(sessionId + ':signers').digest();
  const sorted = [...candidates].sort((a, b) => {
    const ha = createHash('sha256').update(hash.toString('hex') + a).digest();
    const hb = createHash('sha256').update(hash.toString('hex') + b).digest();
    return ha.compare(hb);
  });

  return sorted.slice(0, threshold);
}
```

Everyone computes the same set independently. The 2 selected signers then run the TSS protocol.

---

## 6. EVM integration

### 6.1 Smart contracts

**DeuroToken.sol** -- ERC20 token with 12 decimals and bridge mint authority:
```solidity
contract DeuroToken is ERC20, ERC20Burnable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    constructor(uint256 initialSupply) ERC20("dEURO", "dEURO") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
        _mint(msg.sender, initialSupply);
    }

    function decimals() public pure override returns (uint8) { return 12; }

    function mint(address to, uint256 amount) public onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}
```

**DeuroBridge.sol** -- Bridge contract with deposits, withdrawals, and signature verification:

```solidity
contract DeuroBridge is Ownable, ReentrancyGuard, Pausable {
    uint256 public signaturesThreshold;  // 1 for TSS
    address[] public signers;            // [groupAddress]
    mapping(address => bool) public isSigner;
    mapping(bytes32 => bool) public usedHashes;
    // ...
}
```

TSS deployment: the contract is deployed with `signers=[groupAddress]` and `threshold=1`. The 2-of-3 threshold is enforced off-chain by the DKLs23 protocol.

Security features:
- `ReentrancyGuard` on all withdrawal functions
- `Pausable` for emergency circuit breaker
- `Ownable` for admin functions (addSigner, removeSigner, setThreshold)
- Bitmap-based signer deduplication in `_checkSignatures`
- Replay protection via `usedHashes` mapping

### 6.2 Deposit flow (EVM → Zano)

```solidity
function depositERC20(
    address token_,
    uint256 amount_,
    string calldata receiver_,  // Zano address
    bool isWrapped_
) external whenNotPaused {
    if (isWrapped_) {
        IERC20Mintable(token_).burnFrom(msg.sender, amount_);
    } else {
        IERC20(token_).safeTransferFrom(msg.sender, address(this), amount_);
    }
    emit DepositedERC20(token_, amount_, receiver_, "zano", isWrapped_, 0);
}
```

### 6.3 Withdrawal flow (Zano → EVM)

```solidity
function withdrawERC20(
    address token_,
    uint256 amount_,
    address receiver_,
    bytes32 txHash_,      // Zano burn tx hash
    uint256 txNonce_,
    bool isWrapped_,
    bytes[] calldata signatures_   // 1 TSS signature
) external whenNotPaused nonReentrant {
    bytes32 signHash_ = getERC20SignHash(token_, amount_, receiver_, txHash_, txNonce_, block.chainid, isWrapped_);
    _checkAndUpdateHashes(txHash_, txNonce_);  // Replay protection
    _checkSignatures(signHash_, signatures_);   // Verify TSS signature
    _withdrawERC20(token_, amount_, receiver_, isWrapped_);
}
```

### 6.4 Signature verification on-chain

```solidity
function _checkSignatures(bytes32 signHash_, bytes[] calldata signatures_) internal view {
    require(signatures_.length >= signaturesThreshold, "not enough signatures");

    uint256 bitMap;
    for (uint256 i = 0; i < signatures_.length; i++) {
        address recovered = signHash_.toEthSignedMessageHash().recover(signatures_[i]);
        require(isSigner[recovered], "invalid signer");

        // Bitmap deduplication (Bridgeless Signers.sol pattern)
        uint256 bitKey = 2 ** (uint256(uint160(recovered)) >> 152);
        require(bitMap & bitKey == 0, "duplicate signer");
        bitMap |= bitKey;
    }
}
```

With TSS, `signatures_` contains exactly 1 signature. The recovered address is the TSS group address.

### 6.5 Hash computation (off-chain must match on-chain)

```
For ERC-20 withdrawal:
  raw_hash = keccak256(abi.encodePacked(token, amount, receiver, txHash, txNonce, chainId, isWrapped))
  sign_hash = keccak256("\x19Ethereum Signed Message:\n32" || raw_hash)
```

Off-chain (evm-signer.js):
```javascript
export function computeErc20SignHash(token, amount, receiver, txHash, txNonce, chainId, isWrapped) {
  const encoded = ethers.solidityPacked(
    ['address', 'uint256', 'address', 'bytes32', 'uint256', 'uint256', 'bool'],
    [token, amount, receiver, txHash, txNonce, chainId, isWrapped],
  );
  return ethers.keccak256(encoded);
}
```

The EIP-191 prefix is applied before TSS signing:
```javascript
const eip191Hash = ethers.hashMessage(ethers.getBytes(signHash));
const messageHash = ethers.getBytes(eip191Hash);
// TSS signs messageHash
```

### 6.6 Replay protection

```solidity
mapping(bytes32 => bool) public usedHashes;

function _checkAndUpdateHashes(bytes32 txHash_, uint256 txNonce_) internal {
    bytes32 nonceHash_ = keccak256(abi.encodePacked(txHash_, txNonce_));
    require(!usedHashes[nonceHash_], "already processed");
    usedHashes[nonceHash_] = true;
}
```

Each (txHash, txNonce) pair can only be used once on-chain.

---

## 7. Zano integration

### 7.1 How TSS controls Zano assets

Zano has external ECDSA signing for asset operations. You register an asset with an Ethereum-style public key as owner. After that, all operations on that asset (emit, burn, transfer ownership) need a valid ECDSA signature from that key.

The flow:
1. Register asset with TSS group's public key as `new_owner_eth_pub_key`
2. To mint: wallet creates unsigned tx → 2-of-3 TSS signing → `send_ext_signed_asset_tx` broadcasts
3. To burn: user burns directly (no TSS needed)

### 7.2 Minting (EVM → Zano direction)

```
Step 1: Create unsigned emit transaction
  wallet RPC: emit_asset
  params: { asset_id, destinations: [{address, amount}] }
  response: {
    tx_id: "abc123...",
    data_for_external_signing: {
      unsigned_tx: "...",
      finalized_tx: "...",
      outputs_addresses: [...],
      tx_secret_key: "..."
    }
  }

Step 2: Leader shares tx data with co-signer
  P2P message: tss_zano_tx_data { txId, unsignedTx, finalizedTx }

Step 3: Both signers form signing data
  sig_data = hex_decode("0x" + tx_id)   // Raw 32-byte hash of tx ID

Step 4: TSS signing
  Both signers run DKLs23 protocol on sig_data
  Output: (R, S) — identical for both parties

Step 5: Leader encodes and broadcasts
  zanoSig = rHex + sHex (128 chars, no V, no 0x prefix)
  wallet RPC: send_ext_signed_asset_tx
  params: {
    eth_sig: zanoSig,
    expected_tx_id: tx_id,
    finalized_tx: finalized_tx,
    unsigned_tx: unsigned_tx
  }
```

Zano expects raw R+S without a recovery byte:
```javascript
// tss.js
export function formatZanoSignature(r, s) {
  return Buffer.from(r).toString('hex') + Buffer.from(s).toString('hex');
}
```

### 7.3 Deposit detection (Zano → EVM)

Implementation: `src/zano-watcher.js`

```
1. Monitor wallet via search_for_transactions RPC

2. Validate it's an asset burn:
   tx.ado.operation_type == 4  (OPERATION_TYPE_BURN)
   tx.ado.opt_amount != null
   tx.ado.opt_asset_id matches config.zano.assetId

3. Extract deposit memo from service entries:
   entry = tx.service_entries[0]
   memo = JSON.parse(Buffer.from(entry.body, 'hex'))
   // memo = { dst_add: "0x...", dst_net_id: "evm" }

4. Validate:
   - dst_net_id === 'evm'
   - dst_add matches /^0x[0-9a-fA-F]{40}$/

5. Wait for 10 block confirmations

6. Store as pending deposit
```

### 7.4 Independent chain verification (Paper Algorithm 13)

During consensus, each acceptor independently fetches Zano deposit data:

```javascript
// zano-watcher.js getZanoDepositData()
export async function getZanoDepositData(txHash) {
  const txResult = await searchForTransactions(txHash);
  const tx = allTxs.find(t => t.tx_hash === txHash);

  // Algo 13, Line 9: require operationType == BURN
  if (tx.ado.operation_type !== OPERATION_TYPE_BURN) return null;
  // Algo 13, Line 10: require optAssetId and optAmount
  if (!tx.ado.opt_asset_id || !tx.ado.opt_amount) return null;
  // Algo 13, Line 7: confirmations check
  if (tx.height + config.zano.confirmations > currentHeight) return null;
  // Algo 13, Lines 13-14: extract destination from serviceEntries
  const memo = extractDepositMemo(tx);
  // ...return verified deposit data
}
```

### 7.5 Zano RPC methods used

| Method | Type | Purpose |
|--------|------|---------|
| `emit_asset` | wallet | Create unsigned mint transaction |
| `burn_asset` | wallet | Burn tokens (user-initiated) |
| `send_ext_signed_asset_tx` | wallet | Broadcast TSS-signed transaction |
| `search_for_transactions` | wallet | Monitor for deposits |
| `transfer_asset_ownership` | wallet | Transfer asset to new TSS key |
| `get_wallet_info` | wallet | Get bridge wallet address |
| `getheight` | daemon | Get current block height |

### 7.6 Zano address format

CryptoNote-style, base58:
```
Pattern: ^[1-9A-HJ-NP-Za-km-z]{97}$
Base58 encoding, 97 characters
```

---

## 8. Signing protocol

### 8.1 TSS signing flow overview

Both directions (EVM and Zano) use the same DKLs23 signing protocol. The difference is only in what gets signed (EVM hash vs Zano tx_id) and how the signature is formatted afterward.

```
1. Leader selects 2-of-3 signers via consensus
2. Both signers compute the hash to sign (deterministic)
3. Both signers run DKLs23 protocol:
   a. createFirstMessage() → broadcast to co-signer
   b. 3 rounds of handleMessages() with P2P message exchange
   c. lastMessage(hash) → broadcast
   d. combine() → (R, S)
4. Both signers arrive at identical (R, S)
5. Leader formats and submits the signature
```

### 8.2 EVM signing (Zano → EVM)

Implementation: `party.js handleEvmSigning()`

```
1. Both signers compute the withdrawal hash:
   signHash = computeErc20SignHash(token, amount, receiver, txHash, txNonce, chainId, isWrapped)
   eip191Hash = ethers.hashMessage(ethers.getBytes(signHash))
   messageHash = ethers.getBytes(eip191Hash)

2. Both signers run DKLs23 protocol on messageHash → (R, S)

3. Leader formats signature:
   V = trial recovery (try v=27, v=28 against group address)
   signature = "0x" + rHex + sHex + vHex  (65 bytes, v=0x1b or 0x1c)

4. Leader submits withdrawERC20(token, amount, receiver, txHash, txNonce, isWrapped, [signature])
```

The EIP-191 prefix is applied before TSS signing because Bridge.sol verifies: `signHash_.toEthSignedMessageHash().recover(sig)`.

### 8.3 Zano signing (EVM → Zano)

Implementation: `party.js handleZanoSigning()`

```
1. Leader creates unsigned emit tx via Zano RPC
2. Leader sends tx data to co-signer via P2P (tss_zano_tx_data)
3. Both signers compute sigData = formSigningData(txId)  (raw 32-byte hash)
4. Both signers run DKLs23 protocol on sigData → (R, S)
5. Leader encodes: zanoSig = rHex + sHex (128 chars, no V, no 0x prefix)
6. Leader broadcasts via send_ext_signed_asset_tx
```

No EIP-191 prefix for Zano -- Zano expects the raw tx_id to be signed directly.

### 8.4 P2P transport for TSS rounds

During signing, the 2 selected signers exchange messages through the existing P2P layer. A `createTssTransport(sessionId, signers)` function in `party.js` creates `sendMsg`/`waitForMsgs` callbacks that:

- Route TSS messages through the P2P layer with proper session isolation
- Pre-register handlers for all 4 TSS message types
- Include timeout handling (30 seconds per signing session)

### 8.5 Signature output format

For EVM: 65-byte hex string `0x` + R(32) + S(32) + V(1), where V = 0x1b (27) or 0x1c (28)
For Zano: 128-char hex string R(32) + S(32), no V, no 0x prefix

### 8.6 Recovery parameter (V)

DKLs23 only outputs (R, S). The recovery parameter V is computed by trial:

```javascript
export function computeRecoveryParam(r, s, messageHash, expectedAddress) {
  for (const v of [27, 28]) {
    const sig = ethers.Signature.from({ r: rHex, s: sHex, v });
    const recovered = ethers.recoverAddress(hashHex, sig);
    if (recovered.toLowerCase() === expectedAddress.toLowerCase()) {
      return v;
    }
  }
  throw new Error('Could not recover V');
}
```

---

## 9. Security

### 9.1 Paper reference

The bridge was built by referencing the Bridgeless security paper (arXiv 2506.19730). Algorithms and theorems were cross-referenced with the implementation.

| Theorem | Property | Implementation |
|---------|----------|----------------|
| Theorem 1 | Withdrawal liveness: every signed deposit gets finalized | Error recovery reverts to PENDING (party.js) |
| Theorem 2 | Withdrawal safety: every withdrawal has a corresponding deposit | Independent chain verification (consensus.js) |
| Theorem 3 | Bridge liveness: every honest deposit eventually produces a withdrawal | Leader rotation + session retry loop |
| Theorem 4 | Bridge safety: every withdrawal has a corresponding deposit | Acceptors verify on-chain, never trust proposer |

### 9.2 Paper algorithm compliance

| Algorithm | Paper | PoC | Status |
|-----------|-------|-----|--------|
| Algo 4 (Proposer) | Propose signHash, wait ACKs, select signers | Send raw fields, same logic | Compliant (security-equivalent) |
| Algo 5 (Acceptor) | Independent verification, single-proposal guard | getEvmDepositData / getZanoDepositData | Compliant |
| Algo 6 (Signing) | 2-of-3 cooperative signing | DKLs23 TSS (2 signers cooperate) | Compliant |
| Algo 7 (Finalization) | Status guard, submit on-chain | Status check + auto-submit | Compliant |
| Algo 8/10 (EVM chain client) | getDepositData, computeSignHash | evm-watcher.js, evm-signer.js | Compliant |
| Algo 12/13 (Zano chain client) | getDepositData, serviceEntries | zano-watcher.js getZanoDepositData | Compliant |

### 9.3 Threat model

Assumptions:
- At most 1 of 3 parties is compromised
- Network can be unreliable but not permanently partitioned
- Each party runs on independently operated infrastructure

What this gives you:
- A single compromised party can't produce valid signatures (TSS requires 2 shares)
- 2 honest parties can always sign (1 can be offline)
- The full private key never exists anywhere -- not even during signing
- Both EVM and Zano sides are equally protected (unlike multi-sig where Zano was 1-of-1)

### 9.4 Security measures

| Threat | Mitigation | Location |
|--------|-----------|----------|
| Replay attack | `usedHashes` mapping: `keccak256(txHash, txNonce)` | DeuroBridge.sol |
| Duplicate signer on-chain | Bitmap check in `_checkSignatures` | DeuroBridge.sol |
| Threshold bypass | `signatures.length >= threshold` check | DeuroBridge.sol |
| Chain ID confusion | `chainId` included in sign hash | evm-signer.js |
| Reentrancy | `nonReentrant` modifier (OZ ReentrancyGuard) | DeuroBridge.sol |
| Emergency stop | `Pausable` with `whenNotPaused` modifier | DeuroBridge.sol |
| Proposer data forgery | Independent chain verification | consensus.js |
| Byzantine multi-proposal | Single-proposal guard (`acceptedDepositId`) | consensus.js |
| Already-processed deposit | Status check before ACKing | consensus.js |
| Failed signing stalls bridge | Revert to PENDING on error | party.js |
| Token address mismatch | Token mapping with config validation | evm-signer.js |
| Invalid EVM address in memo | Regex validation `/^0x[0-9a-fA-F]{40}$/` | zano-watcher.js |
| Single-party Zano signing | TSS requires 2-of-3 cooperation | tss.js |
| Amount validation | `> 0` checks on-chain | DeuroBridge.sol |
| EIP-191 sig format | `toEthSignedMessageHash` in contract | DeuroBridge.sol |

### 9.5 Confirmation requirements

Match Bridgeless production values:

| Chain | Blocks | Time | Source |
|-------|--------|------|--------|
| Ethereum | 64 | ~13 minutes | Bridgeless API: `rpc-api.node0.mainnet.bridgeless.com/cosmos/bridge/chains` |
| Zano | 10 | ~2 minutes | Bridgeless production config |

### 9.6 Known bridge attacks

| Attack | What happened | How 2-of-3 TSS handles it |
|--------|--------------|--------------------------|
| Key theft (Ronin, 2022) | Attacker stole validator private keys | No single key to steal. Need 2 shares from separate infrastructure |
| Signing collusion (Harmony, 2022) | Multiple validators compromised | Each party on independent infra, different providers |
| Double-spend | Replay a valid withdrawal | On-chain nonce tracking + off-chain DB state machine |
| Deposit forgery | Fake deposit event | Each party verifies on-chain independently |
| Man-in-the-middle | Intercept P2P messages | mTLS with pre-exchanged certificates (production) |
| Proposer manipulation | Leader proposes fraudulent withdrawal | Acceptors verify independently. Need 2 ACKs |
| DoS | One party refuses to sign | Leader rotates each session. 2-of-3 only needs 2 |
| Rogue Zano signer | Single party mints tokens | TSS: no single party can sign (was 1-of-1 with multi-sig) |

### 9.7 Acceptable PoC simplifications

These are documented deviations that don't affect security properties:

| Simplification | Paper/Go | PoC | Security impact |
|----------------|----------|-----|-----------------|
| Broadcast | Dolev-Strong (Def. 3) | Simple HTTP | None for f=0 |
| Proposal content | signHash | Raw deposit fields | Security-equivalent: same fields → same hash |
| Leader PRNG | ChaCha8 seeded with SHA256 | First 4 bytes of SHA256 | Both deterministic, same result per sid |
| Error status | FAILED (Go) | PENDING (Paper Algo 3, L27-30) | PoC follows paper; preserves Theorem 1 liveness |
| Session timing | 5s/15s/13s/5s/7s | 10s consensus / 30s signing | Acceptable for PoC |
| Finalization | Separate relayer-svc | Leader auto-submits | Paper Algo 7 doesn't specify who submits |
| TSS library | GG19 (bnb-chain/tss-lib) | DKLs23 (silence-labs WASM) | Both produce standard ECDSA; DKLs23 fewer rounds |

### 9.8 Operational security (production)

1. Put each party in a different data center / cloud provider
2. Each party runs its own EVM node and Zano daemon (don't share RPC endpoints)
3. Alert on missed sessions, failed proposals, consensus timeouts
4. Plan and rehearse key resharing before going live
5. Each party backs up their key share independently
6. Limit key share access to the service process only
7. Log all proposals, ACKs, and signatures for forensic analysis
8. Cap the maximum withdrawal amount per session/day

---

## 10. Deployment

### 10.1 Prerequisites

- Node.js 18+
- Sepolia testnet ETH (for gas)
- Zano testnet node (daemon + wallet)
- Alchemy or Infura Sepolia RPC key

### 10.2 Initial setup

```bash
cd poc
npm install

# Generate TSS keyshares (run all 3 simultaneously)
PARTY_ID=0 node src/keygen.js
PARTY_ID=1 node src/keygen.js
PARTY_ID=2 node src/keygen.js
# Output: data/keyshare-0.bin, keyshare-1.bin, keyshare-2.bin
# All 3 print the same group ETH address
```

### 10.3 Deploy contracts

```bash
# Deploy DeuroBridge to Sepolia
# Reads group address from data/keyshare-0.bin, deploys with threshold=1
npx hardhat run scripts/deploy.js --network sepolia
# Output: bridge address (save as BRIDGE_ADDRESS)

# Deploy DeuroToken + grant MINTER_ROLE to bridge
BRIDGE_ADDRESS=0x... npx hardhat run scripts/deploy-token.js --network sepolia
# Output: token address (save as DEURO_TOKEN)
```

### 10.4 Zano asset setup

Register the dEURO asset on Zano testnet with the TSS group's Ethereum public key as the asset owner. This allows the bridge to mint dEURO on Zano via `send_ext_signed_asset_tx`.

The group public key can be derived from any keyshare:
```javascript
const keyshareBytes = readFileSync('data/keyshare-0.bin');
const groupAddress = getGroupAddress(keyshareBytes);
```

### 10.5 Configuration

Environment variables:

| Variable | Purpose | Example |
|----------|---------|---------|
| `PARTY_ID` | Which party (0, 1, 2) | `0` |
| `EVM_RPC` | Sepolia RPC URL | `https://eth-sepolia.g.alchemy.com/v2/...` |
| `BRIDGE_ADDRESS` | DeuroBridge contract | `0x72D501f...` |
| `DEURO_TOKEN` | DeuroToken contract | `0xABC123...` |
| `ZANO_ASSET_ID` | Zano dEURO asset ID | `ff3666...` |
| `ZANO_DAEMON_RPC` | Zano daemon RPC | `http://127.0.0.1:11211/json_rpc` |
| `ZANO_WALLET_RPC` | Zano wallet RPC | `http://127.0.0.1:11212/json_rpc` |
| `SUBMITTER_PRIVATE_KEY` | EVM key for gas (submitting txs) | `0x...` |

### 10.6 Running parties

```bash
# Start all 3 parties
./scripts/run-parties.sh start

# Check status
./scripts/run-parties.sh status

# Stop all
./scripts/run-parties.sh stop
```

Each party runs on a separate port (4000, 4001, 4002).

### 10.7 Making deposits

**EVM → Zano** (lock dEURO on Sepolia, mint on Zano):
```bash
DEPOSITOR_KEY=0x... node src/deposit-evm.js <zano-address> <amount>
```
- Approves bridge to spend dEURO
- Calls `depositERC20(token, amount, zanoAddr, isWrapped=false)`
- Parties detect the event, run consensus, TSS sign, mint on Zano

**Zano → EVM** (burn dEURO on Zano, mint on Sepolia):
```bash
node src/deposit-zano.js <evm-address> <amount>
```
- Burns dEURO on Zano with service_entries memo
- Parties detect the burn, run consensus, TSS sign, submit withdrawal on Sepolia

---

## 11. Test suite

102 tests across 7 test files. All tests use Vitest.

```bash
# Run all tests
npm test

# By category
npm run test:unit        # DB, consensus, EVM signer, Zano utils
npm run test:contract    # DeuroBridge.sol (34 tests, Hardhat network)
npm run test:integration # EVM→Zano and Zano→EVM flows
```

### 11.1 Contract tests (34 tests)

`test/contract/bridge.test.js` -- DeuroBridge.sol on Hardhat network:
- Deployment with TSS group address and threshold=1
- ERC20 deposits (lock and burn modes)
- Native ETH deposits
- ERC20 and native withdrawals with real TSS signatures
- Any 2-of-3 signer combination works
- Replay protection (usedHashes)
- Signature threshold enforcement
- Invalid/duplicate signer rejection
- Admin functions (addSigner, removeSigner, setThreshold, pause)

### 11.2 Unit tests (55 tests)

`test/unit/db.test.js` (21 tests):
- Deposit CRUD operations
- Status transitions
- Duplicate detection
- Query by chain, status, tx hash

`test/unit/consensus.test.js` (16 tests):
- Leader election determinism
- Session ID generation
- Signer selection
- Proposer/acceptor flows with mocked P2P

`test/unit/evm-signer.test.js` (9 tests):
- Hash computation matches on-chain
- Token address resolution
- ERC20 vs native hash differentiation

`test/unit/zano-utils.test.js` (9 tests):
- Signature encoding for Zano
- Signing data formation
- Buffer normalization

### 11.3 Integration tests (13 tests)

`test/integration/evm-to-zano.test.js` (7 tests):
- Full EVM → Zano flow with real TSS signing
- Consensus failure when acceptor missing deposit
- Consensus failure when no ACKs
- P2P message routing

`test/integration/zano-to-evm.test.js` (6 tests):
- Full Zano → EVM flow with real TSS signing
- Native ETH withdrawal with TSS
- Any 2-of-3 combination can sign
- Signature recovery verification

### 11.4 Test infrastructure

`test/helpers/`:
- `tss-test-keyshares.js` -- generates real DKLs23 keyshares in-process (cached)
- `in-process-p2p.js` -- in-process message routing (no HTTP)
- `mock-zano-rpc.js` -- configurable fake Zano RPC
- `test-db.js` -- fresh in-memory SQLite per test

`test/fixtures.js`:
- Hardhat account keys and addresses
- Mock transaction hashes
- Test chain ID and token addresses

---

## 12. Bridgeless code reference

### 12.1 Key files

| File | Purpose |
|------|---------|
| `tss-svc/internal/tss/keygener.go` | Keygen party implementation |
| `tss-svc/internal/tss/signer.go` | Signing party implementation |
| `tss-svc/internal/tss/common.go` | Constants (MsgsCapacity=200, OutChannelSize=1000) |
| `tss-svc/internal/p2p/server.go` | P2P gRPC server with mTLS |
| `tss-svc/internal/p2p/mtls.go` | Certificate and auth handling |
| `tss-svc/internal/p2p/broadcast/default.go` | Basic broadcast/send |
| `tss-svc/internal/p2p/broadcast/reliable.go` | Dolev-Strong reliable broadcast |
| `tss-svc/internal/tss/session/keygen/session.go` | Keygen session manager |
| `tss-svc/internal/tss/session/signing/evm/session.go` | EVM signing session |
| `tss-svc/internal/tss/session/signing/zano/session.go` | Zano signing session |
| `tss-svc/internal/tss/session/signing/evm/finalizer.go` | EVM signature conversion |
| `tss-svc/internal/tss/session/signing/zano/finalizer.go` | Zano tx broadcast |
| `tss-svc/internal/tss/session/consensus/consensus.go` | Consensus orchestrator |
| `tss-svc/internal/tss/session/consensus/proposer.go` | Proposal creation + signer selection |
| `tss-svc/internal/tss/session/consensus/acceptor.go` | Proposal verification |
| `tss-svc/internal/tss/session/leader.go` | Leader election (ChaCha8) |
| `tss-svc/internal/tss/session/boundaries.go` | Timeout constants |
| `tss-svc/pkg/zano/main.go` | Zano SDK (emit, burn, transfer) |
| `tss-svc/pkg/zano/client.go` | Zano JSON-RPC client |
| `tss-svc/pkg/zano/utils.go` | Signature encoding for Zano |
| `tss-svc/internal/bridge/chain/evm/operations/` | EVM hash computation |
| `tss-svc/internal/bridge/chain/evm/deposit.go` | EVM deposit detection |
| `tss-svc/internal/bridge/chain/zano/deposit.go` | Zano deposit detection |
| `bridge-contracts/contracts/bridge/Bridge.sol` | Main bridge contract |
| `bridge-contracts/contracts/utils/Signers.sol` | Signature verification |
| `bridge-contracts/contracts/utils/Hashes.sol` | Replay protection |
| `bridge-contracts/contracts/handlers/ERC20Handler.sol` | ERC20 deposit/withdraw |
| `bridge-contracts/contracts/handlers/NativeHandler.sol` | Native ETH handling |

### 12.2 Session timeouts (Go)

| Phase | Timeout | Purpose |
|-------|---------|---------|
| Keygen | 60 seconds | Full DKG ceremony |
| Consensus | 15 seconds | Propose + accept |
| Proposal acceptance | 5 seconds | Wait for ACKs |
| Signing | 13 seconds | TSS signing rounds |
| Signature distribution | 5 seconds | Share result |
| Finalization | 7 seconds | On-chain action |
| Total signing session | ~40 seconds | Full cycle |

Bridgeless ref: `tss-svc/internal/tss/session/boundaries.go`

### 12.3 Security paper

[arXiv 2506.19730](https://arxiv.org/abs/2506.19730) -- "Formalization and security analysis of the Bridgeless protocol"

Key algorithms:
- Algorithm 3: Withdrawal-generation protocol (main loop)
- Algorithm 4: Consensus proposer
- Algorithm 5: Consensus acceptor
- Algorithm 6: Signing protocol
- Algorithm 7: Finalization
- Algorithm 8/10: EVM chain client (getDepositData, computeSignHash)
- Algorithm 12/13: Zano chain client (getDepositData)

Key theorems:
- Theorem 1: Withdrawal liveness
- Theorem 2: Withdrawal safety
- Theorem 3: Bridge liveness
- Theorem 4: Bridge safety
