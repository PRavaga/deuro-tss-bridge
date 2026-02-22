# deuro-tss-bridge PoC: Cross-Reference Audit

Cross-referencing the PoC implementation against the formal paper
(arXiv 2506.19730, Alpos et al., June 2025) and the production Go
implementation (`bridgeless/tss-svc`).

## 1. Paper Summary

### Security Model

- **n** validators, at most **t = floor(n/3)** are malicious (Byzantine)
- Requires **n >= 3t + 1** honest majority
- Synchronous network: messages arrive within bounded delay
- Each validator runs an honest chain client on all supported chains
- TSS: Binance TSS (GG19) — threshold signing with dishonest-majority tolerance

### Core Definitions

| Definition | Statement |
|---|---|
| **Def 1 (Bridge Liveness)** | Every bridging request by an honest party completes after at most r rounds |
| **Def 2 (Bridge Safety)** | For every withdrawal on the target chain, a corresponding deposit exists on the source chain |
| **Def 3 (Reliable Broadcast)** | Termination, Validity, Integrity, Agreement — if one honest validator delivers m, all do |
| **Def 4 (TSS)** | Termination, Completeness, Agreement, Unforgeability — all honest signers get the same output |

### Algorithms

| Algorithm | Paper Location | Purpose |
|---|---|---|
| **Algo 1** | Data types | DepositIdentifier{txHash, txNonce, chainID}, DepositData, WithdrawalData, Status states, THRESHOLD = 2t |
| **Algo 2** | Deposit verification | submitWithdrawal() — validate chain, fetch depositData, mark PENDING, propagate to all validators |
| **Algo 3** | Withdrawal generation | runSession(sid) — 3 phases: consensus, signing, finalization |
| **Algo 4** | Consensus (proposer) | propose() — pick oldest PENDING, compute signHash, broadcast PROPOSAL via RB, collect ACCEPTANCEs, select t+1 signers (incl. self), broadcast SIGNSTART via RB |
| **Algo 5** | Consensus (acceptor) | accept() — deliver PROPOSAL, verify deposit independently, verify signHash, send ACCEPTANCE, deliver SIGNSTART, return (depositId, signers, signHash) |
| **Algo 6** | Signing phase | sign(signHash, signers) — if in signers, run TSS; broadcast (result, signHash) via RB; verify on deliver |
| **Algo 7** | Finalization phase | finalize() — submit withdrawal tx to target chain (EVM/Zano/Bitcoin specific) |
| **Algo 8** | EVM deposit contract | depositErc20(), depositNative() — emit events |
| **Algo 9** | EVM deposit client | deposit() — call contract, construct depositIdentifier, send SUBMIT-WITHDRAWAL to validators |
| **Algo 10** | EVM withdrawal contract | withdrawERC20(), withdrawNative() — compute signHash on-chain, verify signatures, transfer/call |
| **Algo 11** | EVM withdrawal client | withdraw() — query validators for withdrawalData, call contract |
| **Algo 12** | EVM ChainClient | getDepositData(), getHashOfWithdrawal(), submitTx() |
| **Algo 13** | Zano ChainClient | getDepositData() (burn detection), getWithdrawalTx() (emit), getHashOfWithdrawal(), submitTx() |
| **Algo 14** | Bitcoin ChainClient | getDepositData(), getWithdrawalTx(), getHashOfWithdrawal(), submitTx() |

### Theorems & Key Lemmas

| Theorem/Lemma | Statement | Proof Relies On |
|---|---|---|
| **Thm 1 (Withdrawal Liveness)** | PENDING request → eventually FINALIZED by all honest validators | Lemmas 7, 10, 13 |
| **Thm 2 (Withdrawal Safety)** | Honest validator marks FINALIZED → at least one honest marked PENDING | Lemmas 9, 12, 15 |
| **Thm 3 (Bridgeless Liveness)** | Satisfies bridge liveness (Def 1) with probability 1-(1-p_h)^r | Lemma 4, Thm 1 |
| **Thm 4 (Bridgeless Safety)** | Satisfies bridge safety (Def 2) with overwhelming probability | Lemma 6, Thm 2 |
| **Lemma 5 (Deposit-verification agreement)** | If one honest marks PENDING, all do; they hold the same depositData | RB agreement |
| **Lemma 8 (Consensus agreement)** | If one honest marks PROCESSING, all do with same signHash and signers | RB agreement |
| **Lemma 9 (Consensus safety)** | PROCESSING → previously PENDING | Algo 5 guards |
| **Lemma 11 (Sig-gen agreement)** | If one honest marks PROCESSED, all do; if reverts to PENDING, all do | TSS agreement |
| **Lemma 12 (Sig-gen safety)** | PROCESSED → at least t+1 honest marked PROCESSING | TSS committee size 2t+1 |
| **Lemma 14 (Finalization agreement)** | If one honest marks FINALIZED, all do | Target ledger safety |

### Phase Boundaries (Paper Section 4.2)

| Boundary | Duration | Purpose |
|---|---|---|
| CONSENSUSBOUNDARY | 10 sec | Full consensus phase |
| ACCEPTANCEBOUNDARY | 5 sec | Proposer waits for ACCEPTANCEs |
| SIGNBOUNDARY | 10 sec | Signing phase |
| FINALIZATIONBOUNDARY | 10 sec | Submit to target chain |
| SESSIONDURATION | 30 sec total | = CONSENSUS + SIGN + FINALIZATION |

---

## 2. PoC-to-Paper Algorithm Mapping

### Algorithm 1 (Data Types) → `src/db.js`

| Paper | PoC | Match |
|---|---|---|
| DepositIdentifier{txHash, txNonce, chainID} | deposits table: source_chain + tx_hash + tx_nonce (UNIQUE) | Yes |
| DepositData{tokenAddr, amount, sourceAddr, targetAddr, targetChain} | deposits table columns | Yes |
| WithdrawalData{signHash, signers, signature} | Not a separate table; signatures stored in deposits.signatures column | Partial |
| Status{INVALID, PENDING, PROCESSING, PROCESSED, FINALIZED} | deposits.status: pending, processing, signed, finalized, failed | Similar — "signed" ≈ PROCESSED, no INVALID |
| THRESHOLD = 2t | config.threshold = 2 | Yes (n=3, t=1, threshold=2) |
| requests: DepositIdentifier → RequestData | deposits table with source_chain + tx_hash + tx_nonce unique key | Yes |

**Gap**: Paper's INVALID state (request received but not yet verified) is skipped — PoC only stores deposits after verification.

### Algorithm 2 (Deposit Verification) → `src/evm-watcher.js`, `src/zano-watcher.js`

| Paper Step | PoC Implementation | Match |
|---|---|---|
| Line 8: ignore duplicate deposits | `getDepositByTxHash()` check before `addDeposit()` | Yes |
| Line 11: require supported chain | Hardcoded EVM + Zano support | Yes |
| Line 13: sourceClient.getDepositData() | `pollEvmDeposits()` / `pollZanoDeposits()` query chain directly | Yes |
| Line 14: require depositData != ERROR | Null checks on event parsing results | Yes |
| Lines 17-18: addressValid, amountValid | EVM: implicit via event parsing; Zano: regex address validation | Partial |
| Line 19: status ← PENDING | `addDeposit()` defaults status = 'pending' | Yes |
| Lines 23-25: propagate to all validators | NOT implemented — each party discovers deposits independently | Deviation |

**Key deviation**: Paper has validators relay `SUBMIT-WITHDRAWAL` messages to each other (Lines 23-25). PoC relies on each party independently discovering deposits through chain polling. This is acceptable because all parties watch the same chains, but it means a deposit could be seen at slightly different times, potentially causing consensus mismatches if a proposer tries to sign a deposit that an acceptor hasn't seen yet.

**Mitigation**: The acceptor's `getEvmDepositData()` / `getZanoDepositData()` independently fetches from chain during consensus, so even if it wasn't pre-stored, the acceptor can still verify.

### Algorithm 3 (Withdrawal Generation) → `src/party.js:runSigningSession()`

| Paper Step | PoC Implementation | Match |
|---|---|---|
| Line 2: proposer ← determineProposer(sid) | `determineLeader(sessionId)` | Yes |
| Lines 3-17: Consensus phase | `runAsProposer()` / `runAsAcceptor()` | Yes |
| Lines 18-31: Signing phase | `handleEvmSigning()` / `handleZanoSigning()` | Yes |
| Lines 32-41: Finalization phase | `submitEvmWithdrawal()` / `broadcastSignedZanoTx()` | Partial |
| Line 28: status ← PENDING on sign failure | `updateDepositStatus(id, 'pending')` in catch blocks | Yes |
| Line 38: status ← FINALIZED | `updateDepositStatus(id, 'finalized')` | Yes |
| Line 40: status ← PENDING on finalization failure | `updateDepositStatus(id, 'pending')` in catch block | Yes |

### Algorithm 4 (Proposer) → `src/consensus.js:runAsProposer()`

| Paper Step | PoC Implementation | Match |
|---|---|---|
| Line 2: oldest PENDING request | `getPendingDeposits(destChain)[0]` (ORDER BY id ASC LIMIT 1) | Yes |
| Line 4: signHash ← targetClient.getHashOfWithdrawal() | `computeErc20SignHash()` for EVM direction; null for Zano (depends on unsigned tx) | Yes (EVM) / N/A (Zano) |
| Line 5: proposalMsg ← (depositIdentifier, signHash) | Proposal includes raw deposit fields AND signHash | Yes |
| Line 6: RB[PROPOSAL].broadcast() | `broadcast({type: 'proposal', ...})` via HTTP | Partial (no RB) |
| Lines 9-13: collect ACCEPTANCEs | `waitForMessage('proposal_response', ...)` | Yes |
| Line 15: signersCount ← len(possibleSigners) + 1 | `acks.length + 1` (proposer included) | Yes |
| Line 16: require signersCount > THRESHOLD | `acks.length < config.threshold - 1` check | Yes |
| Line 17: pick THRESHOLD from possibleSigners | `selectSigners(acceptorIds, config.threshold, sessionId)` | Close — see below |
| Line 18: signers.insert(proposer) | `selectedSigners = [...selectedAcceptors, config.partyId]` | Yes |
| Line 20: RB[SIGNSTART].broadcast() | `broadcast({type: 'signer_set', ...})` | Partial (no RB) |

**Paper Remark 2 (Signer selection)**: The proposer uses a PRG seeded with sid, sorts acceptors by address, generates a 64-bit number mod m, picks that acceptor, decrements m, repeats until m=t. The PoC uses cascading SHA256 hashes to sort candidates, then takes the first `threshold` entries. Both are deterministic given the same inputs, but the algorithms differ. In PoC with n=3, t=1, the proposer always gets exactly 1 ACK (from the one other honest party), so `selectSigners` always returns that single party. The difference only matters with n>3.

**Note**: The proposal now includes both raw deposit fields AND signHash (for EVM direction). The acceptor verifies both: field-by-field comparison against on-chain data, plus independent signHash computation and comparison (Paper Algo 5, Line 11). For Zano direction, signHash is null at consensus time because it depends on the unsigned tx created during the signing phase.

### Algorithm 5 (Acceptor) → `src/consensus.js:runAsAcceptor()`

| Paper Step | PoC Implementation | Match |
|---|---|---|
| Line 4: require proposedId == null | `deliveredProposals` Map — rejects duplicate proposals per session | Yes |
| Line 5: request ← requests(proposalMsg.depositId) | Fetches from chain, not local DB | Deviation |
| Lines 7-9: while status == INVALID, submitWithdrawal() | Skipped — PoC has no INVALID state | Simplification |
| Line 10-11: verify signHash matches | Verifies deposit fields AND independently computes/compares signHash (EVM direction) | Yes |
| Line 12: send ACCEPTANCE | `sendToParty(proposalMsg.sender, {type: 'proposal_response', accepted: true})` | Yes |
| Line 15-17: deliver SIGNSTART, validate depositId match | `waitForSignerSet()`, checks `deposit.tx_hash` match | Yes |

**Fixed**: The `deliveredProposals` Map tracks which session has received a proposal from which sender. Duplicate proposals for the same session are rejected with a warning log, matching Paper Algorithm 5, Line 4.

### Algorithm 6 (Signing) → `src/party.js:handleEvmSigning()` / `handleZanoSigning()`

| Paper Step | PoC Implementation | Match |
|---|---|---|
| Line 2: if v in signers | `result.signers.includes(config.partyId)` | Yes |
| Line 3: result ← run TSS with message signHash | `distributedSign(keyshare, messageHash, sendMsg, waitForMsgs)` | Yes |
| Line 4: RB[SIGNATURE].broadcast(result, signHash) | `broadcast({type: 'tss_signature_result', ...})` after TSS completes | Yes (HTTP, not RB) |
| Lines 6-10: upon RB deliver, verify signature | `handleSignatureBroadcast()` — non-signers verify signer matches group address and deposit hash matches | Yes |

**Fixed**: After TSS signing completes, signers broadcast the result via `tss_signature_result` message. Non-signers in `handleSignatureBroadcast()` verify the signer matches `config.tssGroupAddress` and the deposit tx hash matches, then mark the deposit as PROCESSED. This satisfies Lemma 11 (Signature-generation agreement) — all honest validators mark PROCESSED.

### Algorithm 7 (Finalization) → `src/party.js:submitEvmWithdrawal()` / `broadcastSignedZanoTx()`

| Paper Step | PoC Implementation | Match |
|---|---|---|
| Line 2: require status == PROCESSED | Deposit marked 'signed' (≈ PROCESSED) before finalization attempt | Yes |
| Lines 6-7: EVM target → submitTx() | `bridge.withdrawERC20(...)` call — attempted by ALL validators | Yes |
| Lines 8-10: Zano target → getWithdrawalTx() + submitTx(sig) | `broadcastSignedZanoTx(unsignedTxData, zanoSig)` — leader only (requires unsigned tx data) | Partial |
| Return TRUE / ERROR | Status updated to 'finalized' on success, 'pending' on failure | Yes |

**Fixed**: For EVM direction, ALL validators (both signers and non-signers via `handleSignatureBroadcast()`) attempt `submitEvmWithdrawal()`. First success wins — the contract's nonce/replay protection prevents double-withdrawal. For Zano direction, only the leader can submit because `sendExtSignedAssetTx()` requires the unsigned tx data that only the leader created. On finalization failure, status resets to 'pending' for retry (Paper Algo 3, Line 40).

### Algorithm 12 (EVM ChainClient) → `src/evm-watcher.js`

| Paper Function | PoC Implementation | Match |
|---|---|---|
| getDepositData() | `getEvmDepositData(txHash, txNonce)` | Yes |
| Line 4-5: getTransactionByHash + getReceipt | `provider.getTransaction()` + `provider.getTransactionReceipt()` | Yes |
| Line 7-8: confirmation check | `receipt.blockNumber + config.evm.confirmations > currentBlock` | Yes |
| Line 9: receipt.logs[txNonce] as DepositedERC20 | Scans all logs by contract address, counts bridge events | Equivalent |
| getHashOfWithdrawal() | `computeErc20SignHash()` / `computeNativeSignHash()` | Yes |
| submitTx() | `bridge.withdrawERC20(...)` via ethers.js | Yes |

**Note**: Paper's Algorithm 12 Line 9 uses `receipt.logs[depositIdentifier.txNonce]` as a direct index. PoC scans all logs by contract address because ERC20 Transfer events precede the bridge event (discovered during E2E testing). This is a correctness fix over the paper's approach.

### Algorithm 13 (Zano ChainClient) → `src/zano-watcher.js`, `src/zano-signer.js`

| Paper Function | PoC Implementation | Match |
|---|---|---|
| getDepositData() | `getZanoDepositData(txHash)` | Yes |
| Line 4: getTransaction() | `searchForTransactions(txHash)` | Yes |
| Line 7: confirmations check | `tx.height + config.zano.confirmations > currentHeight` | Yes |
| Line 9: operationType == BURN | Two paths: ado-based (op_type=4) + service-entry-based (X:D marker) | Extended |
| Lines 13-14: serviceEntries[txNonce] | `extractDepositMemo(tx)` — parses first service entry body | Yes |
| getWithdrawalTx() | `createUnsignedEmitTx()` via `emitAsset()` RPC | Yes |
| getHashOfWithdrawal() | `formSigningData(txId)` — raw tx_id bytes (32-byte hash) | Yes |
| submitTx(tx, sig) | `sendExtSignedAssetTx(sig, txId, finalizedTx, unsignedTx)` | Yes |

**Extension**: PoC supports two burn detection paths (ado-based and service-entry-based), discovered during E2E testing. The paper only describes ado-based (operationType == BURN). The service-entry path handles burns made via `transfer` with `asset_id_to_burn`, which is how the Zano wallet CLI actually works.

---

## 3. PoC vs Go Reference Implementation

### Leader Election

| Aspect | Paper/Go | PoC |
|---|---|---|
| Algorithm | ChaCha8 PRNG seeded with SHA256(sessionId) | SHA256(sessionId).readUInt32BE(0) % n |
| Determinism | Yes | Yes |
| Distribution | Uniform (ChaCha8) | Biased for non-power-of-2 n (modulo bias) |
| Reference | `tss-svc/internal/tss/session/leader.go` | `src/consensus.js:determineLeader()` |

For n=3, modulo bias from uint32 % 3 is negligible (2^32 mod 3 = 1, so party 0 has probability 1431655766/4294967296 vs 1431655765/4294967296 for others). Not a practical concern.

### Signer Selection

| Aspect | Go | PoC |
|---|---|---|
| Algorithm | Sort acceptors by address, PRG(sid) to pick t entries mod m (Fisher-Yates variant) | Cascading SHA256 sort, take first t entries |
| Proposer inclusion | Always appended after selection | Always appended after selection |
| Reference | `tss-svc/internal/tss/session/consensus/proposer.go getSignersSet()` | `src/consensus.js:selectSigners()` |

Both deterministic given the same inputs. Results may differ for the same session ID because the selection algorithm is different, but this doesn't affect security — the important property is that all parties compute the same result.

### TSS Library

| Aspect | Go | PoC |
|---|---|---|
| Library | `bnb-chain/tss-lib` v2.0.2 (GG19) | `@silencelaboratories/dkls-wasm-ll-node` v1.2.0 (DKLs23) |
| Protocol | GG19 (Gennaro-Goldfeder 2019) | DKLs23 (Doerner-Kondi-Lee-shelat 2023) |
| Audit | Not specified | Trail of Bits (April 2024) |
| DKG rounds | Not counted | 5 |
| Signing rounds | Not counted | 6 (4 pre-sig + lastMessage + combine) |
| Output | Standard ECDSA (R, S) | Standard ECDSA (R, S) |
| V recovery | Handled by library | Trial ecrecover (27 or 28) |

Both produce standard secp256k1 ECDSA signatures. The choice of DKLs23 vs GG19 doesn't affect the protocol's security properties — the paper's Definition 4 (TSS) is satisfied by both.

### P2P Transport

| Aspect | Go | PoC |
|---|---|---|
| Transport | gRPC + mTLS | Express HTTP + JSON + shared API key |
| Authentication | Mutual TLS certificates | Static API key (`deuro-poc-key-change-me`) |
| Reliable broadcast | Dolev-Strong implementation (`internal/p2p/broadcast/reliable.go`) | Simple HTTP broadcast (no reliability guarantees) |
| Message format | Protobuf | JSON with base64-encoded payloads |

**Critical difference**: Go implements Dolev-Strong reliable broadcast (Definition 3). PoC uses simple HTTP. This means the PoC does NOT satisfy the RB properties that underpin Lemmas 5, 8, 11, 14. Acceptable for f=0, but would break safety proofs with any Byzantine validators.

### Deposit Verification

| Aspect | Go | PoC |
|---|---|---|
| EVM confirmations | 64 blocks | 2 blocks (configurable) |
| Zano confirmations | Not checked in code snippets | 10 blocks (configurable) |
| Deposit relay | Validators relay SUBMIT-WITHDRAWAL to each other | Each party discovers independently via polling |
| Reference | `tss-svc/internal/bridge/chain/evm/deposit.go` | `src/evm-watcher.js`, `src/zano-watcher.js` |

### Session Structure

| Aspect | Go | PoC |
|---|---|---|
| Session boundaries | Strict timer-based phases (CONSENSUS → SIGN → FINALIZE) | Sequential execution with timeouts |
| CONSENSUSBOUNDARY | 10 sec (paper) | 30 sec × 2 for acceptor wait |
| SIGNBOUNDARY | 10 sec (paper) | 30 sec signing timeout |
| FINALIZATIONBOUNDARY | 10 sec (paper) | No explicit boundary — immediate after signing |
| Non-overlapping sessions | Enforced | Enforced (sequential loop) |

---

## 4. Security Properties Analysis

### Bridge Safety (Theorem 4 / Definition 2)

**Requirement**: For every withdrawal on the target chain, a corresponding deposit exists on the source chain.

**PoC status**: **Satisfied** (for f=0).

The critical chain is:
1. Acceptor independently fetches deposit from chain (`getEvmDepositData` / `getZanoDepositData`) -- **implemented**
2. Acceptor compares on-chain data against proposer's claim -- **implemented** (amount, receiver, tokenAddress comparison)
3. If mismatch, NACK -- **implemented**
4. Only PENDING deposits are proposed -- **implemented** (getPendingDeposits)
5. Duplicate protection via UNIQUE(source_chain, tx_hash, tx_nonce) -- **implemented**
6. EVM contract's signHash includes txHash+txNonce+chainId -- **implemented** (prevents cross-chain replay)
7. Zano burn detection validates asset_id -- **implemented**

**What could break safety**: A malicious proposer could send different proposals to different acceptors (equivocation). Without reliable broadcast, the PoC can't detect this. However, with n=3 and t=0, this can't happen because the proposer is assumed honest.

### Bridge Liveness (Theorem 3 / Definition 1)

**Requirement**: Every honest deposit is eventually processed.

**PoC status**: **Satisfied** (for f=0).

The liveness chain requires:
1. Honest deposit → eventually marked PENDING by all validators -- **Yes** (each party polls independently)
2. Honest proposer picks oldest PENDING request -- **Yes** (`ORDER BY id ASC LIMIT 1`)
3. Enough ACKs received -- **Yes** (for f=0, always gets threshold ACKs)
4. TSS signing succeeds if all signers honest -- **Yes** (DKLs23 terminates)
5. Finalization succeeds -- **Yes** (all validators attempt for EVM; retry via 'pending' reset on failure; stale 'signed' deposits retried after 60s)

### Status State Machine (Paper Figure 2)

```
Paper:   INVALID → PENDING → PROCESSING → PROCESSED → FINALIZED
                                    ↓                       ↓
                                  PENDING ←←←←←←←←←←←←←← PENDING
                              (TSS error)           (finalization error)

PoC:     (none) → pending → processing → signed → finalized
                                 ↓                    ↓
                               pending ←←←←←←←←←← pending
                            (consensus/TSS error) (finalization error
                                                   or stale >60s)
```

Differences:
- No INVALID state (deposits stored only after verification)
- 'signed' ≈ PROCESSED (has signature but not yet submitted)
- 'signed' → 'pending' reset on finalization failure (Paper Algo 3 Line 40)
- Stale 'signed' deposits (>60s) are retried automatically
- 'failed' status exists in schema but never used

---

## 5. Intentional Simplifications vs Gaps

### Intentional Simplifications (acceptable for PoC)

| # | Simplification | Paper Requirement | Impact |
|---|---|---|---|
| 1 | HTTP broadcast instead of Dolev-Strong RB | Def 3 | OK for f=0; breaks safety for f>0 |
| 2 | SHA256 leader election instead of ChaCha8 | Remark 2 | Same security properties, different output |
| 3 | 2 EVM confirmations instead of 64 | Algo 12 Line 8 | Faster testing; would need tuning for production |
| 4 | Polling-based deposit discovery instead of relay | Algo 2 Lines 23-25 | Works because all parties watch same chains |
| 5 | No INVALID state | Algo 5 Lines 7-9 | Simplified flow; acceptor fetches from chain on demand |
| 6 | DKLs23 instead of GG19 | Remark 3 | Both satisfy Def 4 (TSS properties) |
| 7 | Static API key instead of mTLS | Go impl | OK for PoC; unacceptable for production |

### Gaps (all fixed)

| # | Gap | Paper Requirement | Fix Applied |
|---|---|---|---|
| 1 | No multi-proposal guard | Algo 5 Line 4 | `deliveredProposals` Map in `consensus.js` — rejects duplicate proposals per session |
| 2 | No finalization retry | Algo 3 Lines 39-40 | `submitEvmWithdrawal()` catch block resets to 'pending' in `party.js` |
| 3 | No signature broadcast to non-signers | Algo 6 Lines 4, 6-10 | `tss_signature_result` broadcast + `handleSignatureBroadcast()` in `party.js` |
| 4 | Only leader finalizes | Algo 7 (all validators) | Non-signers attempt `submitEvmWithdrawal()` after receiving signature broadcast |
| 5 | 'signed' status never reset | Algo 3 Line 40 | `getPendingDeposits()` includes stale 'signed' deposits (>60s) in `db.js` |
| 6 | No signHash in proposal | Algo 4 Line 5 | Proposer computes and includes signHash; acceptor independently verifies (EVM direction) |
| 7 | Unbounded message buffers | Memory management | `cleanupBuffers()` in `consensus.js`, called at session start |
| 8 | sessions table never used | Algo 1 Line 6 | Removed from `db.js` and `test/helpers/test-db.js` |

---

## 6. Test Coverage vs Security Properties

### Properties Tested

| Property | Test | Coverage |
|---|---|---|
| Leader determinism | `consensus.test.js` | All parties compute same leader |
| Signer selection determinism | `consensus.test.js` | Same inputs → same output |
| ERC20 hash computation | `evm-signer.test.js` | Matches contract's on-chain hash |
| Zano signature format | `zano-utils.test.js` | 128 hex chars, no V |
| EIP-191 prefix | `evm-signer.test.js` | Matches `toEthSignedMessageHash()` |
| Deposit deduplication | `db.test.js` | UNIQUE constraint prevents double-insert |
| TSS signing correctness | `bridge.test.js` | Real DKLs23 signatures verify on-chain |
| Full EVM→Zano flow | `evm-to-zano.test.js` | 3-party consensus + TSS + mock Zano |
| Full Zano→EVM flow | `zano-to-evm.test.js` | 3-party consensus + TSS + on-chain verify |
| Contract signature verification | `bridge.test.js` | 34 tests including reverts |

### Properties NOT Tested

| Property | Paper Reference | Risk |
|---|---|---|
| Byzantine proposer (equivocation) | Algo 5 Line 4 | No test for multi-proposal attack |
| Byzantine acceptor (false ACK) | Algo 4 Line 16 | No test for accepting without verification |
| Network partition / message loss | Def 3 (RB) | No test for split-brain scenarios |
| Chain reorg (deposit disappears) | Lemma 3 | No test for reduced confirmations |
| TSS abort (malicious signer) | Def 4 Termination | No test for signing failure recovery |
| Finalization failure retry | Algo 3 Lines 39-40 | Feature implemented but not tested |
| Concurrent deposit processing | Remark 4 | No test for race conditions between sessions |
| Deposit amount overflow | Algo 2 Line 18 | No test for extremely large amounts |

---

## 7. Conclusion

The PoC correctly implements the core protocol flow from the paper. All 8 identified gaps have been fixed. Both **bridge safety** (Theorem 4) and **bridge liveness** (Theorem 3) are satisfied for the f=0 PoC configuration.

### What works well
- Algorithm 3's three-phase structure is faithfully implemented
- Independent deposit verification (Algorithms 12/13) is thorough
- TSS integration produces valid signatures for both EVM and Zano
- Consensus flow matches Algorithms 4/5 including multi-proposal guard and signHash verification
- Signature broadcast to non-signers (Algo 6) and all-validator finalization (Algo 7)
- Finalization retry with status reset (Algo 3, Lines 39-40) and stale deposit retry
- Test suite covers the critical cryptographic paths with real TSS (102 tests)

### Remaining intentional simplifications (acceptable for PoC)
1. **Reliable broadcast** (Def 3) — HTTP instead of Dolev-Strong; OK for f=0
2. **mTLS authentication** — static API key instead of mutual TLS
3. **Higher confirmation thresholds** — 2 EVM blocks instead of 64 (faster testing)
4. **DKLs23 vs GG19** — both satisfy TSS Definition 4
5. **Polling vs relay** — independent chain discovery instead of SUBMIT-WITHDRAWAL relay
6. **No INVALID state** — acceptor fetches from chain on demand instead of INVALID→PENDING transition
