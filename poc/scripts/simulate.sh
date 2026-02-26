#!/bin/bash
# Activity Simulation — long-running multi-round bridge testing
#
# Designed for real confirmation counts (64 EVM / 10 Zano). Each deposit
# takes 10-20 min under normal block production. The script handles chain
# stalls gracefully — if either chain stops producing blocks, deposits
# sit in "waiting for confirmations" until blocks resume, then finalize
# normally. The script will wait as long as needed (no per-deposit timeout
# by default).
#
# Usage:
#   ./scripts/simulate.sh                        # 3 rounds, fixed 1 dEURO
#   ./scripts/simulate.sh --rounds 10 --random   # 10 rounds, random amounts/delays
#   ./scripts/simulate.sh --no-start             # use already-running parties
#   ./scripts/simulate.sh --fast                 # 2/2 confirmations (testing)
#
# Prerequisites:
#   - Zano testnet daemon + wallet running
#   - TSS keyshares in data/keyshare-{0,1,2}.bin
#   - DEPOSITOR_KEY and DEPLOYER_PRIVATE_KEY in env or .env

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# --- Load .env ---
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# --- Defaults (mainnet parameters) ---
ROUNDS=3
AMOUNT="1000000000000"       # 1 dEURO (12 decimals)
START_PARTIES=true
EVM_TO_ZANO=true
ZANO_TO_EVM=true
RANDOMIZE=false
FAST=false
RAND_AMT_MIN=100000000000    # 0.1 dEURO
RAND_AMT_MAX=2000000000000   # 2.0 dEURO
RAND_DELAY_MIN=10
RAND_DELAY_MAX=120           # up to 2 min between deposits
DEPOSIT_TIMEOUT=0            # 0 = wait forever (chain may stall)
INTER_DELAY=30               # seconds between directions in same round
ROUND_DELAY=60               # seconds between rounds

# Mainnet-like confirmations (overridable via env)
CONF_EVM="${EVM_CONFIRMATIONS:-64}"
CONF_ZANO="${ZANO_CONFIRMATIONS:-10}"
CONSENSUS_TIMEOUT="${CONSENSUS_TIMEOUT_MS:-30000}"

SIM_LOG="/tmp/sim-$(date +%Y%m%d-%H%M%S).log"

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rounds)     ROUNDS="$2"; shift 2 ;;
    --amount)     AMOUNT="$2"; shift 2 ;;
    --no-start)   START_PARTIES=false; shift ;;
    --evm-only)   ZANO_TO_EVM=false; shift ;;
    --zano-only)  EVM_TO_ZANO=false; shift ;;
    --random)     RANDOMIZE=true; shift ;;
    --fast)       FAST=true; shift ;;
    --timeout)    DEPOSIT_TIMEOUT="$2"; shift 2 ;;
    --delay)      ROUND_DELAY="$2"; shift 2 ;;
    *)            echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [ "$FAST" = true ]; then
  CONF_EVM=2
  CONF_ZANO=2
  CONSENSUS_TIMEOUT=10000
  DEPOSIT_TIMEOUT=300
  ROUND_DELAY=10
  INTER_DELAY=10
  RAND_DELAY_MIN=5
  RAND_DELAY_MAX=30
fi

# Export for party processes
export EVM_CONFIRMATIONS="$CONF_EVM"
export ZANO_CONFIRMATIONS="$CONF_ZANO"
export CONSENSUS_TIMEOUT_MS="$CONSENSUS_TIMEOUT"

# --- Env vars ---
export EVM_RPC="${EVM_RPC:-https://eth-sepolia.g.alchemy.com/v2/z97HTgIuGjc4F_sD1-0EZ}"
export BRIDGE_ADDRESS="${BRIDGE_ADDRESS:-0x7a40738f7914F6Cc8d283e117b00fFE5e19250B5}"
export DEURO_TOKEN="${DEURO_TOKEN:-0x90e4bEE191fD540954D9843a21C11C9f74a16776}"
export ZANO_DAEMON_RPC="${ZANO_DAEMON_RPC:-http://127.0.0.1:12111/json_rpc}"
export ZANO_WALLET_RPC="${ZANO_WALLET_RPC:-http://127.0.0.1:12212/json_rpc}"
export ZANO_ASSET_ID="${ZANO_ASSET_ID:-15c077f777a99ab1af8c28eaee8532185ad005af16ada32a668f94ce06c6d0d7}"
export P2P_API_KEY="${P2P_API_KEY:-deuro-poc-key-change-me}"
export DEPLOYER_PRIVATE_KEY="${DEPLOYER_PRIVATE_KEY:-}"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# --- Logging ---

slog() {
  local ts level msg
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  level="$1"; shift
  msg="$*"
  printf '{"ts":"%s","level":"%s","msg":"%s"}\n' "$ts" "$level" "$msg" >> "$SIM_LOG"
}

log()  { echo -e "${CYAN}[sim $(date +%H:%M:%S)]${NC} $*"; slog INFO "$*"; }
ok()   { echo -e "${GREEN}[OK  $(date +%H:%M:%S)]${NC} $*"; slog OK "$*"; }
warn() { echo -e "${YELLOW}[WARN $(date +%H:%M:%S)]${NC} $*"; slog WARN "$*"; }
err()  { echo -e "${RED}[ERR $(date +%H:%M:%S)]${NC} $*" >&2; slog ERR "$*"; }

# --- Random helpers ---
rand_range() { echo $(( $1 + RANDOM % ($2 - $1 + 1) )); }

# Random amount in smallest units. Uses node for safe big-number math.
# Generates between 0.10 and 2.00 dEURO (12 decimals).
rand_amount() {
  if [ "$RANDOMIZE" = true ]; then
    # Random cents: 10-200 (= 0.10 to 2.00 dEURO)
    local cents=$(( 10 + RANDOM % 191 ))
    # cents * 10^10 = amount in 12-decimal units
    node -e "process.stdout.write(String(BigInt($cents) * 10000000000n))"
  else
    echo "$AMOUNT"
  fi
}
rand_delay() {
  if [ "$RANDOMIZE" = true ]; then
    rand_range "$RAND_DELAY_MIN" "$RAND_DELAY_MAX"
  else
    echo "$ROUND_DELAY"
  fi
}
rand_bool() { echo $((RANDOM % 2)); }
fmt_amount() { node -e "console.log(($1/1e12).toFixed(2))"; }
fmt_duration() {
  local s=$1
  if [ "$s" -ge 3600 ]; then
    printf '%dh%02dm%02ds' $((s/3600)) $(((s%3600)/60)) $((s%60))
  elif [ "$s" -ge 60 ]; then
    printf '%dm%02ds' $((s/60)) $((s%60))
  else
    printf '%ds' "$s"
  fi
}

# --- Track results ---
declare -a RESULTS=()
declare -a DURATIONS=()
TOTAL_PASS=0
TOTAL_FAIL=0
SIM_START=$(date +%s)

PARTY_PIDS=()
INTERRUPTED=false

# Log file prefix
LOG_PREFIX="/tmp/sim-party"
if [ "$START_PARTIES" = false ]; then
  LOG_PREFIX="/tmp/party"
fi

# --- Cleanup (runs on EXIT and INT) ---

print_summary() {
  local sim_end sim_dur
  sim_end=$(date +%s)
  sim_dur=$((sim_end - SIM_START))

  # Post-simulation balances (best effort)
  local bal_evm_after bal_zano_after
  bal_evm_after=$(get_evm_deuro_balance "$EVM_ADDR" 2>/dev/null || echo "$BAL_EVM_BEFORE")
  bal_zano_after=$(get_zano_deuro_balance 2>/dev/null || echo "$BAL_ZANO_BEFORE")

  echo ""
  echo -e "${BOLD}╔═══════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║              Simulation Results                    ║${NC}"
  echo -e "${BOLD}╚═══════════════════════════════════════════════════╝${NC}"
  echo ""

  if [ ${#RESULTS[@]} -gt 0 ]; then
    echo -e "${BOLD}Deposits:${NC}"
    for r in "${RESULTS[@]}"; do
      if [[ "$r" == *"PASS"* ]]; then
        echo -e "  ${GREEN}✓${NC} $r"
      else
        echo -e "  ${RED}✗${NC} $r"
      fi
    done
  else
    echo -e "  ${DIM}No deposits completed${NC}"
  fi

  echo ""
  echo -e "${BOLD}Balances:${NC}"
  echo -e "  EVM  dEURO: $(fmt_amount "$BAL_EVM_BEFORE") -> $(fmt_amount "$bal_evm_after") (delta $(node -e "console.log((($bal_evm_after-$BAL_EVM_BEFORE)/1e12).toFixed(2))"))"
  echo -e "  Zano dEURO: $(fmt_amount "$BAL_ZANO_BEFORE") -> $(fmt_amount "$bal_zano_after") (delta $(node -e "console.log((($bal_zano_after-$BAL_ZANO_BEFORE)/1e12).toFixed(2))"))"

  echo ""
  echo -e "${BOLD}Stats:${NC}"
  echo -e "  Passed: ${GREEN}$TOTAL_PASS${NC}  Failed: ${RED}$TOTAL_FAIL${NC}  Total: $((TOTAL_PASS + TOTAL_FAIL))"
  echo -e "  Duration: $(fmt_duration "$sim_dur")"
  if [ ${#DURATIONS[@]} -gt 0 ]; then
    local sum=0 min=999999 max=0
    for d in "${DURATIONS[@]}"; do
      sum=$((sum + d))
      [ "$d" -lt "$min" ] && min=$d
      [ "$d" -gt "$max" ] && max=$d
    done
    local avg=$((sum / ${#DURATIONS[@]}))
    echo -e "  Per-deposit: min=$(fmt_duration $min) avg=$(fmt_duration $avg) max=$(fmt_duration $max)"
  fi
  echo -e "  Confirmations: EVM=$CONF_EVM Zano=$CONF_ZANO"
  echo -e "  Log: $SIM_LOG"
  echo -e "  Party logs: ${LOG_PREFIX}-{0,1,2}.log"

  if [ "$INTERRUPTED" = true ]; then
    echo ""
    warn "Simulation was interrupted (Ctrl+C). Partial results above."
  fi

  if [ "$TOTAL_FAIL" -eq 0 ] && [ "$TOTAL_PASS" -gt 0 ]; then
    echo ""
    ok "All deposits finalized successfully."
  elif [ "$TOTAL_FAIL" -gt 0 ]; then
    echo ""
    err "Some deposits failed. Check party logs for details."
  fi
}

cleanup() {
  if [ "$START_PARTIES" = true ] && [ ${#PARTY_PIDS[@]} -gt 0 ]; then
    log "Stopping parties..."
    for pid in "${PARTY_PIDS[@]}"; do
      kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
  fi
  print_summary
}

handle_interrupt() {
  INTERRUPTED=true
  cleanup
  exit 130
}

trap handle_interrupt INT TERM
trap cleanup EXIT

# --- Prereqs ---

check_prereqs() {
  local fail=false

  if [ -z "${DEPOSITOR_KEY:-}" ]; then
    err "DEPOSITOR_KEY not set"; fail=true
  fi
  if [ -z "${DEPLOYER_PRIVATE_KEY:-}" ]; then
    err "DEPLOYER_PRIVATE_KEY not set"; fail=true
  fi
  for i in 0 1 2; do
    if [ ! -f "$DIR/data/keyshare-$i.bin" ]; then
      err "Missing keyshare: data/keyshare-$i.bin"; fail=true
    fi
  done
  if ! curl -s "$ZANO_DAEMON_RPC" -d '{"jsonrpc":"2.0","id":"0","method":"getinfo"}' >/dev/null 2>&1; then
    err "Zano daemon not reachable"; fail=true
  fi
  if ! curl -s "$ZANO_WALLET_RPC" -d '{"jsonrpc":"2.0","id":"0","method":"getaddress"}' >/dev/null 2>&1; then
    err "Zano wallet not reachable"; fail=true
  fi
  if [ "$fail" = true ]; then exit 1; fi
}

# --- Chain helpers ---

get_zano_height() {
  curl -s "$ZANO_DAEMON_RPC" -d '{"jsonrpc":"2.0","id":"0","method":"getinfo"}' \
    | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).result.height))"
}

get_evm_block() {
  curl -s "$EVM_RPC" -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    | node -e "process.stdout.write(String(parseInt(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).result,16)))"
}

get_zano_address() {
  curl -s "$ZANO_WALLET_RPC" \
    -d '{"jsonrpc":"2.0","id":"0","method":"getaddress"}' \
    | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).result.address)"
}

get_evm_address() {
  node -e "
    import { ethers } from 'ethers';
    process.stdout.write(new ethers.Wallet(process.env.DEPOSITOR_KEY).address);
  " 2>/dev/null
}

get_evm_deuro_balance() {
  node -e "
    import { ethers } from 'ethers';
    const p = new ethers.JsonRpcProvider(process.env.EVM_RPC);
    const t = new ethers.Contract(process.env.DEURO_TOKEN, ['function balanceOf(address) view returns (uint256)'], p);
    const b = await t.balanceOf('$1');
    process.stdout.write(b.toString());
  " 2>/dev/null
}

get_zano_deuro_balance() {
  curl -s "$ZANO_WALLET_RPC" -d '{"jsonrpc":"2.0","id":"0","method":"getbalance"}' \
    | node -e "
      const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const b=(j.result.balances||[]).find(x=>x.asset_info?.asset_id==='$ZANO_ASSET_ID');
      process.stdout.write(String(b?.unlocked||b?.total||0));
    "
}

# --- Chain health (for stall detection) ---

check_chain_health() {
  local zano_h evm_b zano_peers
  zano_h=$(get_zano_height 2>/dev/null || echo "?")
  evm_b=$(get_evm_block 2>/dev/null || echo "?")
  zano_peers=$(curl -s "$ZANO_DAEMON_RPC" -d '{"jsonrpc":"2.0","id":"0","method":"getinfo"}' \
    | node -e "const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).result;process.stdout.write(String((j.outgoing_connections_count||0)+(j.incoming_connections_count||0)))" 2>/dev/null || echo "?")
  echo -e "${DIM}  chains: Zano h=$zano_h peers=$zano_peers | EVM block=$evm_b${NC}"
}

# --- Start/check parties ---

clean_dbs() {
  log "Cleaning party databases..."
  rm -f "$DIR"/data/party-*.db*
}

start_parties_fn() {
  local zano_h evm_b
  zano_h=$(get_zano_height)
  evm_b=$(get_evm_block)

  export EVM_START_BLOCK="$((evm_b - 2))"
  export ZANO_START_HEIGHT="$((zano_h - 2))"

  log "Starting parties (EVM from $EVM_START_BLOCK, Zano from $ZANO_START_HEIGHT)"
  log "  EVM confirmations: $CONF_EVM (~$(( CONF_EVM * 12 / 60 )) min)"
  log "  Zano confirmations: $CONF_ZANO (~$(( CONF_ZANO )) min)"
  log "  Consensus timeout: ${CONSENSUS_TIMEOUT}ms"

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
      CONSENSUS_TIMEOUT_MS="$CONSENSUS_TIMEOUT" \
      EVM_START_BLOCK="$EVM_START_BLOCK" \
      ZANO_START_HEIGHT="$ZANO_START_HEIGHT" \
      DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
      node src/party.js > "${LOG_PREFIX}-$i.log" 2>&1 &
    PARTY_PIDS+=($!)
    log "  Party $i (PID $!) -> ${LOG_PREFIX}-$i.log"
  done
}

wait_for_healthy() {
  log "Waiting for parties to be healthy..."
  local max=30 elapsed=0
  while [ "$elapsed" -lt "$max" ]; do
    local up=true
    for i in 0 1 2; do
      if ! curl -s -o /dev/null "http://localhost:$((4000+i))/p2p/health" 2>/dev/null; then
        up=false; break
      fi
    done
    if [ "$up" = true ]; then
      ok "All 3 parties healthy"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed+1))
  done
  err "Parties not healthy after ${max}s"
  for i in 0 1 2; do
    echo "--- Party $i (last 10 lines) ---"
    tail -10 "${LOG_PREFIX}-$i.log" 2>/dev/null || true
  done
  exit 1
}

# --- Log position tracking ---
declare -A LOG_POS

snapshot_log_positions() {
  for i in 0 1 2; do
    LOG_POS[$i]=$(wc -c < "${LOG_PREFIX}-$i.log" 2>/dev/null || echo 0)
  done
}

# --- Wait for finalization ---
# Polls party logs for the tx hash + "finalized" in new lines since snapshot.
# If DEPOSIT_TIMEOUT=0, waits indefinitely (chain may stall for hours).
# Prints chain health every 5 min while waiting.

LAST_DURATION=0

wait_for_finalization() {
  local label="$1" marker="$2"
  local start_ts elapsed last_health_check
  start_ts=$(date +%s)
  elapsed=0
  last_health_check=0

  if [ "$DEPOSIT_TIMEOUT" -gt 0 ]; then
    log "  Waiting for '$label' (marker: ${marker:0:12}..., timeout: $(fmt_duration $DEPOSIT_TIMEOUT))..."
  else
    log "  Waiting for '$label' (marker: ${marker:0:12}..., no timeout — will wait for chain)..."
  fi

  while true; do
    # Check if any party logged finalization with our marker
    for i in 0 1 2; do
      local pos="${LOG_POS[$i]:-0}"
      local new_lines
      new_lines=$(tail -c "+$((pos + 1))" "${LOG_PREFIX}-$i.log" 2>/dev/null || echo "")
      if [ -n "$new_lines" ]; then
        if echo "$new_lines" | grep -q "$marker"; then
          if echo "$new_lines" | grep "$marker" | grep -qi "finalized"; then
            local end_ts
            end_ts=$(date +%s)
            LAST_DURATION=$((end_ts - start_ts))
            ok "  $label finalized in $(fmt_duration $LAST_DURATION) (party $i)"
            return 0
          fi
        fi
      fi
    done

    sleep 10
    elapsed=$(( $(date +%s) - start_ts ))

    # Timeout check (0 = infinite)
    if [ "$DEPOSIT_TIMEOUT" -gt 0 ] && [ "$elapsed" -ge "$DEPOSIT_TIMEOUT" ]; then
      err "  $label timed out after $(fmt_duration $elapsed)"
      return 1
    fi

    # Progress every 2 min
    if [ $((elapsed % 120)) -lt 10 ] && [ "$elapsed" -ge 120 ]; then
      log "  Still waiting... ($(fmt_duration $elapsed))"
    fi

    # Chain health every 5 min
    if [ $((elapsed - last_health_check)) -ge 300 ]; then
      check_chain_health
      last_health_check=$elapsed
    fi
  done
}

# --- Deposit functions ---

do_evm_to_zano() {
  local round=$1 zano_addr=$2
  local amt
  amt=$(rand_amount)
  snapshot_log_positions
  log "[R$round] EVM -> Zano: $(fmt_amount "$amt") dEURO"

  local output tx_hash
  output=$(DEPOSITOR_KEY="$DEPOSITOR_KEY" node src/deposit-evm.js "$zano_addr" "$amt" 2>&1)
  tx_hash=$(echo "$output" | grep -oP 'Tx hash:\s+\K0x[0-9a-fA-F]+' || echo "")

  if [ -z "$tx_hash" ]; then
    err "  Failed to submit EVM deposit"
    echo "$output" | tail -5
    RESULTS+=("EVM->Zano R${round}: FAIL (submit)")
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    return 1
  fi

  log "  tx: $tx_hash"
  slog DATA "evm_deposit round=$round amount=$amt tx=$tx_hash"

  local marker="${tx_hash: -10}"
  if wait_for_finalization "EVM->Zano R${round}" "$marker"; then
    RESULTS+=("EVM->Zano R${round}: PASS $(fmt_duration $LAST_DURATION) $(fmt_amount "$amt") dEURO")
    DURATIONS+=("$LAST_DURATION")
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    RESULTS+=("EVM->Zano R${round}: FAIL (timeout)")
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    return 1
  fi
}

do_zano_to_evm() {
  local round=$1 evm_addr=$2
  local amt
  amt=$(rand_amount)
  snapshot_log_positions
  log "[R$round] Zano -> EVM: $(fmt_amount "$amt") dEURO"

  local output tx_hash
  output=$(node src/deposit-zano.js "$evm_addr" "$amt" 2>&1)
  tx_hash=$(echo "$output" | grep -oP '"tx_hash"\s*:\s*"\K[0-9a-fA-F]+' || echo "")

  if [ -z "$tx_hash" ]; then
    err "  Failed to submit Zano burn"
    echo "$output" | tail -5
    RESULTS+=("Zano->EVM R${round}: FAIL (submit)")
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    return 1
  fi

  log "  tx: $tx_hash"
  slog DATA "zano_burn round=$round amount=$amt tx=$tx_hash"

  local marker="${tx_hash:0:10}"
  if wait_for_finalization "Zano->EVM R${round}" "$marker"; then
    RESULTS+=("Zano->EVM R${round}: PASS $(fmt_duration $LAST_DURATION) $(fmt_amount "$amt") dEURO")
    DURATIONS+=("$LAST_DURATION")
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    RESULTS+=("Zano->EVM R${round}: FAIL (timeout)")
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    return 1
  fi
}

# ============================
# MAIN
# ============================

echo ""
echo -e "${BOLD}╔═══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     deuro TSS Bridge — Activity Simulation        ║${NC}"
echo -e "${BOLD}╚═══════════════════════════════════════════════════╝${NC}"
echo ""

if [ "$RANDOMIZE" = true ]; then
  log "Rounds: $ROUNDS | Amounts: $(fmt_amount $RAND_AMT_MIN)-$(fmt_amount $RAND_AMT_MAX) dEURO (random)"
  log "Delays: ${RAND_DELAY_MIN}-${RAND_DELAY_MAX}s (random)"
else
  log "Rounds: $ROUNDS | Amount: $(fmt_amount $AMOUNT) dEURO | Delay: ${ROUND_DELAY}s"
fi
log "Confirmations: EVM=$CONF_EVM (~$((CONF_EVM * 12 / 60))min) Zano=$CONF_ZANO (~${CONF_ZANO}min)"
log "Consensus timeout: ${CONSENSUS_TIMEOUT}ms"
if [ "$DEPOSIT_TIMEOUT" -eq 0 ]; then
  log "Per-deposit timeout: none (waits for chain)"
else
  log "Per-deposit timeout: $(fmt_duration $DEPOSIT_TIMEOUT)"
fi
log "Directions: EVM->Zano=$EVM_TO_ZANO  Zano->EVM=$ZANO_TO_EVM"
log "Log: $SIM_LOG"
echo ""

check_prereqs

ZANO_ADDR=$(get_zano_address)
EVM_ADDR=$(get_evm_address)

log "Zano address: $ZANO_ADDR"
log "EVM address:  $EVM_ADDR"

BAL_EVM_BEFORE=$(get_evm_deuro_balance "$EVM_ADDR")
BAL_ZANO_BEFORE=$(get_zano_deuro_balance)
log "Balances: EVM=$(fmt_amount "$BAL_EVM_BEFORE") dEURO | Zano=$(fmt_amount "$BAL_ZANO_BEFORE") dEURO"
check_chain_health
echo ""

if [ "$START_PARTIES" = true ]; then
  clean_dbs
  start_parties_fn
  wait_for_healthy
  sleep 5
else
  log "Using existing parties (--no-start)"
  all_up=true
  for i in 0 1 2; do
    if ! curl -s -o /dev/null "http://localhost:$((4000+i))/p2p/health" 2>/dev/null; then
      all_up=false; break
    fi
  done
  if [ "$all_up" = true ]; then
    ok "All 3 parties healthy"
  else
    err "Parties not healthy. Start them or remove --no-start."
    exit 1
  fi
fi

echo ""

# --- Main loop ---

for round in $(seq 1 "$ROUNDS"); do
  echo -e "${BOLD}━━━ Round $round / $ROUNDS ━━━${NC}"

  # Randomize direction order
  if [ "$RANDOMIZE" = true ] && [ "$EVM_TO_ZANO" = true ] && [ "$ZANO_TO_EVM" = true ]; then
    if [ "$(rand_bool)" -eq 0 ]; then
      FIRST="zano" SECOND="evm"
    else
      FIRST="evm" SECOND="zano"
    fi
  elif [ "$ZANO_TO_EVM" = true ]; then
    FIRST="zano" SECOND=""
  elif [ "$EVM_TO_ZANO" = true ]; then
    FIRST="evm" SECOND=""
  else
    FIRST="" SECOND=""
  fi

  run_dir() {
    case "$1" in
      zano) do_zano_to_evm "$round" "$EVM_ADDR" || true ;;
      evm)  do_evm_to_zano "$round" "$ZANO_ADDR" || true ;;
    esac
  }

  [ -n "$FIRST" ] && run_dir "$FIRST"

  if [ -n "$FIRST" ] && [ -n "$SECOND" ]; then
    mid_delay=$(rand_delay)
    mid_delay=$((mid_delay < INTER_DELAY ? INTER_DELAY : mid_delay))
    log "Waiting $(fmt_duration $mid_delay) between directions..."
    sleep "$mid_delay"
  fi

  [ -n "${SECOND:-}" ] && run_dir "$SECOND"

  if [ "$round" -lt "$ROUNDS" ]; then
    rnd_delay=$(rand_delay)
    log "Waiting $(fmt_duration $rnd_delay) before round $((round+1))..."
    sleep "$rnd_delay"
  fi

  echo ""
done

# print_summary runs via EXIT trap
exit $((TOTAL_FAIL > 0 ? 1 : 0))
