#!/bin/bash
# End-to-end bridge test: EVM → Zano and Zano → EVM
#
# Starts 3 parties, makes deposits in both directions, waits for finalization.
# Uses reduced confirmations (2/2) for speed (~2 min per direction).
#
# Prerequisites:
#   - node, npm install done
#   - Zano testnet running (./scripts/setup-zano-testnet.sh)
#   - DEPOSITOR_KEY env var (funded Sepolia wallet with dEURO)
#   - party-keys.json (auto-generated if missing)
#
# Usage:
#   ./scripts/e2e-test.sh              # run full E2E
#   SKIP_ZANO=1 ./scripts/e2e-test.sh  # EVM→Zano only

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Load .env if present
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Override confirmations for fast testing
export EVM_CONFIRMATIONS="${EVM_CONFIRMATIONS:-2}"
export ZANO_CONFIRMATIONS="${ZANO_CONFIRMATIONS:-2}"

# Use defaults from .env.example if not set
export EVM_RPC="${EVM_RPC:-https://eth-sepolia.g.alchemy.com/v2/z97HTgIuGjc4F_sD1-0EZ}"
export BRIDGE_ADDRESS="${BRIDGE_ADDRESS:-0x7a40738f7914F6Cc8d283e117b00fFE5e19250B5}"
export DEURO_TOKEN="${DEURO_TOKEN:-0x90e4bEE191fD540954D9843a21C11C9f74a16776}"
export ZANO_DAEMON_RPC="${ZANO_DAEMON_RPC:-http://127.0.0.1:12111/json_rpc}"
export ZANO_WALLET_RPC="${ZANO_WALLET_RPC:-http://127.0.0.1:12212/json_rpc}"
export ZANO_ASSET_ID="${ZANO_ASSET_ID:-15c077f777a99ab1af8c28eaee8532185ad005af16ada32a668f94ce06c6d0d7}"
export P2P_API_KEY="${P2P_API_KEY:-deuro-poc-key-change-me}"
export DEPLOYER_PRIVATE_KEY="${DEPLOYER_PRIVATE_KEY:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[e2e]${NC} $*"; }
warn() { echo -e "${YELLOW}[e2e]${NC} $*"; }
err()  { echo -e "${RED}[e2e]${NC} $*" >&2; }
pass() { echo -e "${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }

PARTY_PIDS=()

cleanup() {
  log "Cleaning up..."
  for pid in "${PARTY_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  log "Done"
}
trap cleanup EXIT

# --- Prerequisite checks ---

check_prereqs() {
  local ok=true

  if ! command -v node &>/dev/null; then
    err "node not found"
    ok=false
  fi

  if [ -z "${DEPOSITOR_KEY:-}" ]; then
    err "DEPOSITOR_KEY not set (need a funded Sepolia wallet with dEURO)"
    ok=false
  fi

  if [ -z "$BRIDGE_ADDRESS" ]; then
    err "BRIDGE_ADDRESS not set"
    ok=false
  fi

  # Check Zano daemon
  if ! curl -s "$ZANO_DAEMON_RPC" -d '{"jsonrpc":"2.0","id":"0","method":"getinfo"}' >/dev/null 2>&1; then
    err "Zano daemon not reachable at $ZANO_DAEMON_RPC"
    err "Run: ./scripts/setup-zano-testnet.sh"
    ok=false
  fi

  # Check Zano wallet
  if ! curl -s "$ZANO_WALLET_RPC" -d '{"jsonrpc":"2.0","id":"0","method":"getaddress"}' >/dev/null 2>&1; then
    err "Zano wallet not reachable at $ZANO_WALLET_RPC"
    err "Run: ./scripts/setup-zano-testnet.sh"
    ok=false
  fi

  if [ "$ok" = false ]; then
    exit 1
  fi
}

# --- Check TSS keyshares exist ---

ensure_keys() {
  for i in 0 1 2; do
    if [ ! -f "$DIR/data/keyshare-$i.bin" ]; then
      err "Missing keyshare: data/keyshare-$i.bin"
      err "Run DKG first: for i in 0 1 2; do PARTY_ID=\$i node src/keygen.js & done"
      exit 1
    fi
  done
  log "TSS keyshares found for all 3 parties"
}

# --- Start parties ---

start_parties() {
  log "Starting 3 parties..."
  for i in 0 1 2; do
    PARTY_ID=$i \
      BRIDGE_ADDRESS="$BRIDGE_ADDRESS" \
      EVM_RPC="$EVM_RPC" \
      DEURO_TOKEN="$DEURO_TOKEN" \
      ZANO_DAEMON_RPC="$ZANO_DAEMON_RPC" \
      ZANO_WALLET_RPC="$ZANO_WALLET_RPC" \
      ZANO_ASSET_ID="$ZANO_ASSET_ID" \
      P2P_API_KEY="$P2P_API_KEY" \
      EVM_CONFIRMATIONS="$EVM_CONFIRMATIONS" \
      ZANO_CONFIRMATIONS="$ZANO_CONFIRMATIONS" \
      DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
      node src/party.js > "/tmp/e2e-party-$i.log" 2>&1 &
    PARTY_PIDS+=($!)
    log "  Party $i started (PID $!) -> /tmp/e2e-party-$i.log"
  done
}

# --- Wait for parties to be healthy ---

wait_for_parties() {
  log "Waiting for parties to be healthy..."
  local max_wait=30 elapsed=0
  while [ "$elapsed" -lt "$max_wait" ]; do
    local all_up=true
    for i in 0 1 2; do
      local port=$((4000 + i))
      if ! curl -s -o /dev/null -w "" "http://localhost:$port/p2p/health" 2>/dev/null; then
        all_up=false
        break
      fi
    done
    if [ "$all_up" = true ]; then
      log "All 3 parties healthy"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  err "Parties did not become healthy within ${max_wait}s"
  for i in 0 1 2; do
    echo "--- Party $i log (last 20 lines) ---"
    tail -20 "/tmp/e2e-party-$i.log" 2>/dev/null || true
  done
  exit 1
}

# --- Wait for finalization ---

wait_for_finalized() {
  local direction="$1" timeout="${2:-300}"
  log "Waiting for '$direction' finalization (timeout: ${timeout}s)..."
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    for i in 0 1 2; do
      if grep -q "finalized" "/tmp/e2e-party-$i.log" 2>/dev/null; then
        log "Finalization detected in party $i log"
        return 0
      fi
    done
    sleep 5
    elapsed=$((elapsed + 5))
    if [ $((elapsed % 30)) -eq 0 ]; then
      log "  Still waiting... (${elapsed}s elapsed)"
    fi
  done
  return 1
}

# --- Get Zano wallet address ---

get_zano_address() {
  curl -s "$ZANO_WALLET_RPC" \
    -d '{"jsonrpc":"2.0","id":"0","method":"getaddress"}' \
    | grep -oP '"address"\s*:\s*"\K[^"]+' || echo ""
}

# --- Main ---

log "=== deuro TSS Bridge E2E Test ==="
log "EVM_CONFIRMATIONS=$EVM_CONFIRMATIONS  ZANO_CONFIRMATIONS=$ZANO_CONFIRMATIONS"
echo ""

check_prereqs
ensure_keys
start_parties
wait_for_parties

RESULT=0

# --- Test 1: EVM → Zano ---
log ""
log "=== Test 1: EVM → Zano ==="

ZANO_ADDR=$(get_zano_address)
if [ -z "$ZANO_ADDR" ]; then
  err "Could not get Zano wallet address"
  exit 1
fi
log "Zano address: $ZANO_ADDR"

# Clear logs for fresh finalization detection
for i in 0 1 2; do
  : > "/tmp/e2e-party-$i.log"
done

log "Making EVM deposit (1 dEURO)..."
if DEPOSITOR_KEY="$DEPOSITOR_KEY" node src/deposit-evm.js "$ZANO_ADDR" 1000000000000; then
  log "Deposit tx submitted, waiting for parties to process..."
  if wait_for_finalized "EVM→Zano" 300; then
    pass "EVM → Zano bridge completed"
  else
    fail "EVM → Zano: timed out waiting for finalization"
    RESULT=1
  fi
else
  fail "EVM → Zano: deposit tx failed"
  RESULT=1
fi

# --- Test 2: Zano → EVM ---
if [ -z "${SKIP_ZANO:-}" ]; then
  log ""
  log "=== Test 2: Zano → EVM ==="

  # Use the depositor's EVM address as the destination
  EVM_DEST=$(node -e "
    import { ethers } from 'ethers';
    const w = new ethers.Wallet(process.env.DEPOSITOR_KEY);
    console.log(w.address);
  " 2>/dev/null || echo "")

  if [ -z "$EVM_DEST" ]; then
    err "Could not derive EVM address from DEPOSITOR_KEY"
    RESULT=1
  else
    log "EVM destination: $EVM_DEST"

    # Clear logs for fresh finalization detection
    for i in 0 1 2; do
      : > "/tmp/e2e-party-$i.log"
    done

    log "Making Zano deposit (1 dEURO)..."
    if node src/deposit-zano.js "$EVM_DEST" 1000000000000; then
      log "Burn tx submitted, waiting for parties to process..."
      if wait_for_finalized "Zano→EVM" 300; then
        pass "Zano → EVM bridge completed"
      else
        fail "Zano → EVM: timed out waiting for finalization"
        RESULT=1
      fi
    else
      fail "Zano → EVM: burn tx failed"
      RESULT=1
    fi
  fi
else
  warn "Skipping Zano → EVM (SKIP_ZANO=1)"
fi

# --- Summary ---
echo ""
log "=== Summary ==="
if [ "$RESULT" -eq 0 ]; then
  pass "All E2E tests passed"
else
  fail "Some E2E tests failed — check /tmp/e2e-party-*.log for details"
fi

exit $RESULT
