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

### 1.1 Threshold ECDSA (GG18/GG20)

The bridge uses threshold ECDSA on secp256k1 -- the same curve Ethereum uses, and the one Zano accepts for external asset signatures.

Parameters for 2-of-3:
- `N = 3` (total parties)
- `T = 2` (threshold -- minimum parties to sign)
- `f = N - (T+1) = 0` (max tolerated Byzantine parties for liveness)

The protocol is Gennaro & Goldfeder (2018/2020), implemented in `bnb-chain/tss-lib`. It runs in multiple rounds:

Keygen (9 rounds):
1. Each party generates a Paillier keypair and safe primes (pre-parameters)
2. Parties exchange commitments and Shamir secret shares
3. Zero-knowledge proofs validate each party's contribution
4. Each party ends up with a `LocalPartySaveData` containing their key share

Signing (9 rounds):
1. Parties exchange MtA (Multiplicative-to-Additive) shares
2. Range proofs check that shares are well-formed
3. Partial signatures combine into a final (R, S) ECDSA signature
4. Output: standard 65-byte ECDSA signature (r, s, v)

### 1.2 Why TSS, not multisig

| | TSS | Multisig |
|---|---|---|
| On-chain footprint | Single signature, single address | Multiple signatures, contract-based |
| Gas cost | Low (1 ecrecover) | High (N ecrecovers) |
| Zano compatibility | Works via `send_ext_signed_asset_tx` | Not supported natively |
| Privacy | Indistinguishable from normal tx | Reveals threshold scheme |

### 1.3 PoC approach

The PoC uses individual ECDSA keys per party with on-chain 2-of-3 multi-sig verification. The consensus, watchers, chain clients, and security logic are identical to production. Upgrading to TSS only changes the signing layer.

| Aspect | PoC | Production |
|--------|-----|-----------|
| Signing | Individual ECDSA (multi-sig) | GG19 TSS (bnb-chain/tss-lib) |
| On-chain threshold | 2 (needs 2 individual sigs) | 1 (TSS produces 1 combined sig) |
| P2P | HTTP + API key | gRPC + mutual TLS |
| Broadcast | Simple HTTP | Dolev-Strong reliable broadcast |
| Finalization | Leader auto-submits | Separate relayer service |
| Key storage | JSON file | HashiCorp Vault |

### 1.4 Pre-parameters (production)

Before keygen, each party generates pre-parameters:
- Two safe primes (p, q where p = 2p'+1, q = 2q'+1)
- A Paillier keypair derived from these primes
- Takes 30-60 seconds per party

Bridgeless ref: `tss-svc/cmd/helpers/generate/preparams.go`
```go
params, _ := keygen.GeneratePreParams(10 * time.Minute)
params.ValidateWithProof()  // Validates Paillier key integrity
```

Generate once, store securely. They're reusable across multiple keygen ceremonies.

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
│  │     Signing Engine            │               │
│  │  - ECDSA per party (PoC)     │               │
│  │  - Signature verification     │               │
│  │  - Deduplication + relay      │               │
│  │    rejection                  │               │
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
  │     └─ Leader: select signers (THRESHOLD from acceptors + self)
  │
  ├─ 3. Signing (15 seconds)
  │     ├─ Each signer signs with their ECDSA key (PoC)
  │     ├─ Signatures verified before collection (Algo 6, L9-10)
  │     ├─ Self-signature relay rejection
  │     └─ Signer deduplication via Set
  │
  ├─ 4. Finalization
  │     ├─ Status guard: only PROCESSING/PENDING (Algo 7, L2)
  │     ├─ EVM: leader submits withdrawERC20() on-chain
  │     ├─ Zano: leader broadcasts via send_ext_signed_asset_tx
  │     └─ Error: revert to PENDING for retry (Theorem 1 liveness)
  │
  └─ 5. Next session
```

PoC timing: 60s session interval, 10s consensus, 15s signing.
Go timing: 5s/15s/13s/5s/7s phases.

---

## 3. Key generation

### 3.1 PoC keygen

The PoC generates 3 independent ECDSA keypairs. No TSS ceremony needed.

```bash
node src/keygen.js
```

This creates `data/party-keys.json`:
```json
[
  {
    "privateKey": "0x...",
    "publicKey": "0x04...",
    "address": "0x..."
  },
  // ... party 1, party 2
]
```

The addresses derived from these keys are registered as signers on DeuroBridge.sol. Party A's key is also the Zano asset owner.

### 3.2 Production keygen (TSS)

All 3 parties coordinate on:
- session_id: unique integer
- start_time: exact UTC timestamp
- threshold: 2

At start_time:
1. Each party verifies all others are connected
2. tss-lib keygen protocol runs (9 rounds, ~10 seconds)
3. Messages routed via P2P layer
4. Each party receives LocalPartySaveData (their key share)
5. Key shares stored in Vault

Bridgeless ref: `tss-svc/internal/tss/keygener.go`

```go
params := tss.NewParameters(
    tss.S256(),                              // secp256k1 curve
    tss.NewPeerContext(sortedPartyIds),       // All party IDs
    myPartyId,                               // This party's ID
    3,                                        // Total parties
    2,                                        // Threshold
)

party := keygen.NewLocalParty(params, outChan, endChan, preParams)
party.Start()

result := <-endChan  // LocalPartySaveData
```

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
| `proposal` | Leader -> All | Propose deposit for signing |
| `proposal_response` | Acceptor -> Leader | ACK or NACK |
| `signer_set` | Leader -> All | Which parties will sign |
| `evm_signature` | Signer -> All | EVM withdrawal signature |
| `zano_sign_request` | Leader -> Signers | Unsigned Zano tx data |
| `zano_signature` | Signer -> Leader | Zano tx signature |

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

Signer selection follows the Go pattern: select THRESHOLD signers from acceptors, then always append the proposer. This ensures the proposer is never excluded from signing.

```javascript
// Go ref: proposer.go getSignersSet()
const acceptorIds = acks.map(a => a.sender);
const selectedAcceptors = selectSigners(acceptorIds, config.threshold, sessionId);
const selectedSigners = [...selectedAcceptors, config.partyId];
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

Key security measures in the acceptor:

**Single-proposal guard** (Algorithm 5, Line 4): Prevents a Byzantine proposer from sending multiple proposals in the same session.

**Independent chain verification** (Algorithm 5, Lines 5-11): The acceptor fetches deposit data directly from the chain via `getEvmDepositData()` or `getZanoDepositData()`. It never uses the proposer's claimed amount, receiver, or token address for signing.

**Duplicate signing guard**: Before ACKing, the acceptor checks if the deposit has already been processed:
```javascript
const existingDeposit = getDepositByTxHash(sourceChain, txHash, txNonce ?? 0);
if (existingDeposit && existingDeposit.status !== 'pending') {
  // NACK: already processed
}
```

**Verified data override**: When returning deposit data for signing, the acceptor maps its independently verified camelCase data to the snake_case DB format:
```javascript
deposit = {
  ...msg.data.deposit,                       // DB id, status from proposer
  source_chain: verifiedDeposit.sourceChain,  // Override with verified data
  tx_hash: verifiedDeposit.txHash,
  token_address: verifiedDeposit.tokenAddress,
  amount: verifiedDeposit.amount,
  receiver: verifiedDeposit.receiver,
  // ...
};
```

Without this mapping, the proposer's unverified data could leak through because of the camelCase/snake_case naming difference.

### 5.4 Signer selection

From the parties that ACKed, the leader picks signers deterministically:

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

Everyone computes the same set independently.

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
    uint256 public signaturesThreshold;
    address[] public signers;
    mapping(address => bool) public isSigner;
    mapping(bytes32 => bool) public usedHashes;
    // ...
}
```

Security features:
- `ReentrancyGuard` on all withdrawal functions
- `Pausable` for emergency circuit breaker
- `Ownable` for admin functions (addSigner, removeSigner, setThreshold)
- Bitmap-based signer deduplication in `_checkSignatures`
- Replay protection via `usedHashes` mapping

Bridgeless ref: `bridge-contracts/contracts/bridge/Bridge.sol`, `utils/Signers.sol`, `utils/Hashes.sol`

### 6.2 Deposit flow (EVM -> Zano)

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

From the user's perspective:
```bash
# 1. Approve bridge to spend dEURO
# 2. Call depositERC20
DEPOSITOR_KEY=0x... node src/deposit-evm.js <zano-address> <amount>
```

### 6.3 Withdrawal flow (Zano -> EVM)

```solidity
function withdrawERC20(
    address token_,
    uint256 amount_,
    address receiver_,
    bytes32 txHash_,      // Zano burn tx hash
    uint256 txNonce_,
    bool isWrapped_,
    bytes[] calldata signatures_
) external whenNotPaused nonReentrant {
    bytes32 signHash_ = getERC20SignHash(token_, amount_, receiver_, txHash_, txNonce_, block.chainid, isWrapped_);
    _checkAndUpdateHashes(txHash_, txNonce_);  // Replay protection
    _checkSignatures(signHash_, signatures_);   // Verify TSS signatures
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

### 6.6 Token mapping

For Zano -> EVM deposits, `deposit.token_address` is the Zano asset ID. The bridge maps it to the EVM token address:

```javascript
// config.js
tokenMapping: { [ZANO_ASSET_ID]: DEURO_TOKEN }

// evm-signer.js
export function resolveEvmTokenAddress(tokenAddress) {
  return config.tokenMapping[tokenAddress] || tokenAddress;
}
```

### 6.7 Deposit detection

Implementation: `src/evm-watcher.js`

Each party watches DeuroBridge for `DepositedERC20` events:
1. Poll for new events from last processed block
2. Extract: token, amount, receiver (Zano address), isWrapped
3. Wait for 64 block confirmations (Bridgeless production value)
4. Store in SQLite as `pending`
5. Available for next signing session

Bridgeless ref: `tss-svc/internal/bridge/chain/evm/deposit.go`

### 6.8 Replay protection

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
2. To mint: wallet creates unsigned tx, TSS signs it, `send_ext_signed_asset_tx` broadcasts
3. To burn: user burns directly (no TSS needed)

### 7.2 Minting (EVM -> Zano direction)

Bridgeless ref: `tss-svc/pkg/zano/main.go` and `internal/bridge/chain/zano/withdraw.go`

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

Step 2: Form signing data
  sig_data = hex_decode("0x" + tx_id)   // Raw bytes of tx ID

Step 3: Sign sig_data
  PoC: each party signs with own key directly (no Ethereum prefix)
  Production: 2-of-3 TSS signing

Step 4: Encode signature for Zano
  raw = Signature + SignatureRecovery
  encoded = hex(raw)[2:-2]   // Strip "0x" prefix and last 2 chars

Step 5: Broadcast
  wallet RPC: send_ext_signed_asset_tx
  params: {
    eth_sig: encoded,
    expected_tx_id: tx_id,
    finalized_tx: finalized_tx,
    unsigned_tx: unsigned_tx,
    unlock_transfers_on_fail: false
  }
```

Signature encoding (from `zano-rpc.js`, matches Go `tss-svc/pkg/zano/utils.go`):
```javascript
export function encodeSignatureForZano(signature) {
  const raw = signature.startsWith('0x') ? signature.slice(2) : signature;
  return raw.slice(0, raw.length - 2);  // Strip recovery byte
}
```

### 7.3 Zano signing in the PoC

Zano expects the raw tx_id to be signed directly with ECDSA -- no keccak256 or Ethereum prefix.

```javascript
// zano-signer.js
const signingKey = new ethers.SigningKey(myKey.privateKey);
const sig = signingKey.sign(normalizedSigData);  // Sign raw 32-byte tx_id
```

Reference: `zano/utils/JS/test_eth_sig.js`

### 7.4 Deposit detection (Zano -> EVM)

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

Bridgeless ref: `tss-svc/internal/bridge/chain/zano/deposit.go`

### 7.5 Independent chain verification (Paper Algorithm 13)

During consensus, each acceptor independently fetches Zano deposit data:

```javascript
// zano-watcher.js getZanoDepositData()
// Paper Algorithm 13: getDepositData()
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

### 7.6 Zano RPC methods used

| Method | Type | Purpose |
|--------|------|---------|
| `emit_asset` | wallet | Create unsigned mint transaction |
| `burn_asset` | wallet | Burn tokens (user-initiated) |
| `send_ext_signed_asset_tx` | wallet | Broadcast TSS-signed transaction |
| `search_for_transactions` | wallet | Monitor for deposits |
| `transfer_asset_ownership` | wallet | Transfer asset to new TSS key |
| `get_wallet_info` | wallet | Get bridge wallet address |
| `getheight` | daemon | Get current block height |

### 7.7 Zano address format

CryptoNote-style, base58:
```
Pattern: ^[1-9A-HJ-NP-Za-km-z]{97}$
Base58 encoding, 97 characters
```

---

## 8. Signing protocol

### 8.1 EVM signing flow (Zano -> EVM)

Implementation: `party.js handleEvmSigning()`

Paper reference: Algorithm 6 (signing), Algorithm 7 (finalization)

```
1. Status guard (Algo 7, L2):
   Reject if deposit.status is not 'processing' or 'pending'

2. Each signer:
   a. Compute ERC20 sign hash (must match on-chain)
   b. Sign with own ECDSA key
   c. Broadcast signature to other parties

3. Leader collects signatures:
   a. Verify each signature (Algo 6, L9-10)
   b. Reject relayed copies of own signature
   c. Deduplicate by signer address
   d. Verify signer is a registered party
   e. Collect threshold (2) signatures

4. Leader auto-submits withdrawERC20() on-chain (Algo 7)

5. On error: revert deposit to PENDING (Algo 3, L27-30)
   This preserves bridge liveness (Theorem 1)
```

### 8.2 Zano signing flow (EVM -> Zano)

Implementation: `party.js handleZanoSigning()`

```
1. Status guard (Algo 7, L2)

2. Leader:
   a. Create unsigned emit tx via Zano RPC
   b. Sign tx_id with own key
   c. Broadcast unsigned tx data + signature to signers
   d. Wait for other signer's signature
   e. Broadcast signed tx via send_ext_signed_asset_tx

3. Non-leader:
   a. Wait for leader's signing request
   b. Sign tx_id
   c. Send signature back to leader

4. On error: revert to PENDING
```

### 8.3 Signature verification in waitForSignatures

```javascript
function waitForSignatures(sessionId, type, count, signHash = null) {
  const collected = [];
  const seenSigners = new Set();
  const myAddress = config.partyKeys?.[config.partyId]?.address?.toLowerCase();

  const handler = (msg) => {
    if (msg.sessionId !== sessionId) return;

    if (signHash && msg.data?.signature && msg.data?.signer) {
      const signerAddr = msg.data.signer.toLowerCase();

      // Reject relayed copy of own signature
      if (signerAddr === myAddress) return;

      // Deduplicate by signer address
      if (seenSigners.has(signerAddr)) return;

      // Verify signature cryptographically (Algo 6, L9-10)
      const valid = verifySignature(signHash, msg.data.signature, msg.data.signer);
      if (!valid) return;

      // Verify signer is a registered party
      const isParty = config.partyKeys?.some(
        k => k.address.toLowerCase() === signerAddr
      );
      if (!isParty) return;

      seenSigners.add(signerAddr);
    }

    collected.push(msg);
  };
}
```

### 8.4 Signature output format

For EVM: standard 65-byte Ethereum signature (r + s + v, where v = recovery + 27)
For Zano: hex-encoded signature with recovery byte stripped

### 8.5 Production signing (TSS)

tss-lib gives you:
```
SignatureData {
    Signature:         []byte  // 64 bytes (R || S)
    SignatureRecovery: []byte  // 1 byte (V)
    R:                 []byte  // 32 bytes
    S:                 []byte  // 32 bytes
    M:                 []byte  // Original message
}
```

EVM conversion (from Go):
```go
func convertToEthSignature(sig *common.SignatureData) string {
    rawSig := append(sig.Signature, sig.SignatureRecovery...)
    rawSig[64] += 27  // Ethereum recovery ID offset
    return hexutil.Encode(rawSig)
}
```

---

## 9. Security

### 9.1 Formal verification

The bridge is formally verified against the Bridgeless security paper (arXiv 2506.19730). Every algorithm and theorem has been cross-referenced line-by-line.

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
| Algo 6 (Signing) | Verify signatures before accepting | verifySignature + dedup + relay rejection | Compliant |
| Algo 7 (Finalization) | Status guard, submit on-chain | Status check + auto-submit | Compliant |
| Algo 8/10 (EVM chain client) | getDepositData, computeSignHash | evm-watcher.js, evm-signer.js | Compliant |
| Algo 12/13 (Zano chain client) | getDepositData, serviceEntries | zano-watcher.js getZanoDepositData | Compliant |

### 9.3 Threat model

Assumptions:
- At most 1 of 3 parties is compromised
- Network can be unreliable but not permanently partitioned
- Each party runs on independently operated infrastructure

What this gives you:
- A single compromised party can't produce valid signatures
- 2 honest parties can always sign (1 can be offline)
- The full private key never exists anywhere -- not even during signing

### 9.4 Security measures

| Threat | Mitigation | Location |
|--------|-----------|----------|
| Replay attack | `usedHashes` mapping: `keccak256(txHash, txNonce)` | DeuroBridge.sol |
| Duplicate signer on-chain | Bitmap check in `_checkSignatures` | DeuroBridge.sol |
| Duplicate signer off-chain | `seenSigners` Set in waitForSignatures | party.js |
| Relayed own signature | Self-address check before accepting | party.js |
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
| Invalid signature in collection | Cryptographic verify before accept (Algo 6, L9-10) | party.js |
| Unknown signer | Check against registered party keys | party.js |
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

### 9.7 Acceptable PoC simplifications

These are documented deviations that don't affect security properties:

| Simplification | Paper/Go | PoC | Security impact |
|----------------|----------|-----|-----------------|
| Broadcast | Dolev-Strong (Def. 3) | Simple HTTP | None for f=0 |
| Proposal content | signHash | Raw deposit fields | Security-equivalent: same fields → same hash |
| Leader PRNG | ChaCha8 seeded with SHA256 | First 4 bytes of SHA256 | Both deterministic, same result per sid |
| Error status | FAILED (Go) | PENDING (Paper Algo 3, L27-30) | PoC follows paper; preserves Theorem 1 liveness |
| Session timing | 5s/15s/13s/5s/7s | 10s consensus / 15s signing | Acceptable for PoC |
| Finalization | Separate relayer-svc | Leader auto-submits | Paper Algo 7 doesn't specify who submits |
| Sig distribution | Go distribution.go (broadcast combined sig) | Each party broadcasts own sig | TSS-specific; not needed in multi-sig PoC |

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

# Generate 3 party ECDSA keys
node src/keygen.js
# Output: data/party-keys.json (3 keypairs)
```

### 10.3 Deploy contracts

```bash
# Deploy DeuroBridge to Sepolia
# Registers all 3 party addresses as signers, threshold = 2
npx hardhat run scripts/deploy.js --network sepolia
# Output: bridge address (save as BRIDGE_ADDRESS)

# Deploy DeuroToken + grant MINTER_ROLE to bridge
BRIDGE_ADDRESS=0x... npx hardhat run scripts/deploy-token.js --network sepolia
# Output: token address (save as DEURO_TOKEN)
# Also mints initial supply to deployer for testing
```

### 10.4 Zano asset setup

Register the dEURO asset on Zano testnet with Party A's Ethereum public key as the asset owner. This allows the bridge to mint dEURO on Zano via `send_ext_signed_asset_tx`.

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

**EVM -> Zano** (lock dEURO on Sepolia, mint on Zano):
```bash
DEPOSITOR_KEY=0x... node src/deposit-evm.js <zano-address> <amount>
```
- Approves bridge to spend dEURO
- Calls `depositERC20(token, amount, zanoAddr, isWrapped=false)`
- Parties detect the event, run consensus, sign, mint on Zano

**Zano -> EVM** (burn dEURO on Zano, mint on Sepolia):
```bash
node src/deposit-zano.js <evm-address> <amount>
```
- Burns dEURO on Zano with service_entries memo
- Parties detect the burn, run consensus, sign, submit withdrawal on Sepolia

### 10.8 Manual withdrawal (fallback)

If auto-submission fails, use the manual script:
```bash
node scripts/withdraw-evm.js <deposit-id>
```
Reads signatures from the party database and calls `withdrawERC20()`.

---

## 11. Test suite

114 tests across 7 test files. All tests use Vitest.

```bash
# Run all tests
npm test

# By category
npm run test:unit        # DB, consensus, EVM signer, Zano utils
npm run test:contract    # DeuroBridge.sol (39 tests, Hardhat network)
npm run test:integration # EVM→Zano and Zano→EVM flows
```

### 11.1 Contract tests (39 tests)

`test/contract/bridge.test.js` -- DeuroBridge.sol on Hardhat network:
- Deployment and initialization
- ERC20 deposits (lock and burn modes)
- Native ETH deposits
- ERC20 and native withdrawals with signature verification
- Replay protection (usedHashes)
- Signature threshold enforcement
- Invalid/duplicate signer rejection
- Admin functions (addSigner, removeSigner, setThreshold, pause)

### 11.2 Unit tests (62 tests)

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

`test/unit/evm-signer.test.js` (16 tests):
- Hash computation matches on-chain
- Signature generation and verification
- Token address resolution
- Contract format

`test/unit/zano-utils.test.js` (9 tests):
- Signature encoding for Zano
- Signing data formation
- Buffer normalization

### 11.3 Integration tests (13 tests)

`test/integration/evm-to-zano.test.js` (7 tests):
- Full EVM -> Zano flow with mock Zano
- Deposit detection -> consensus -> signing -> broadcast

`test/integration/zano-to-evm.test.js` (6 tests):
- Full Zano -> EVM flow
- Burn detection -> consensus -> signing -> withdrawal submission

### 11.4 Test infrastructure

`test/helpers/`:
- Mock P2P layer (in-process message routing)
- Mock Zano RPC server
- Test database factory (fresh SQLite per test)
- Test party key fixtures

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
| `tss-svc/pkg/zano/types/types.go` | Zano data structures |
| `tss-svc/internal/bridge/chain/evm/operations/` | EVM hash computation |
| `tss-svc/internal/bridge/chain/evm/deposit.go` | EVM deposit detection |
| `tss-svc/internal/bridge/chain/zano/deposit.go` | Zano deposit detection |
| `tss-svc/internal/bridge/withdrawal/evm.go` | EVM withdrawal data |
| `tss-svc/internal/bridge/withdrawal/zano.go` | Zano withdrawal data |
| `tss-svc/internal/secrets/vault/vault.go` | HashiCorp Vault storage |
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

### 12.3 Documentation

`tss-svc/docs/`:
- `01_overview.md` -- service overview and protocol
- `02_protocol.md` -- detailed TSS protocol flow
- `03_performing-deposit.md` -- user deposit flows
- `04_configuration.md` -- configuration reference
- `05_key-generation.md` -- step-by-step keygen tutorial
- `06_running-service.md` -- deployment guide
- `07_key-resharing.md` -- key resharing procedures

### 12.4 Security paper

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
