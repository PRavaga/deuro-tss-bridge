#!/bin/bash
# Download and start Zano testnet daemon + wallet for E2E testing.
# Binaries are cached in ./zano-testnet/ so subsequent runs skip the download.
#
# Usage:
#   ./scripts/setup-zano-testnet.sh          # download, start daemon, create wallet
#   ./scripts/setup-zano-testnet.sh stop      # stop daemon + wallet
#   ./scripts/setup-zano-testnet.sh status    # check if running
#
# Linux x64 only. Data stored in poc/zano-testnet/ (gitignored).

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
ZANO_DIR="$DIR/zano-testnet"
BIN_DIR="$ZANO_DIR/bin"
DATA_DIR="$ZANO_DIR/data"
WALLET_DIR="$ZANO_DIR/wallet"
WALLET_FILE="$WALLET_DIR/e2e-wallet"
PID_DIR="$ZANO_DIR/pids"

APPIMAGE_URL="https://build.zano.org/builds/zano-linux-x64-develop-testnet-devtools-v2.2.0.451%5B651fb6c%5D.AppImage"
APPIMAGE_FILE="$ZANO_DIR/zano-testnet.AppImage"

DAEMON_PORT=12111
WALLET_PORT=12212

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*"; }
err()  { echo -e "${RED}[setup]${NC} $*" >&2; }

# --- Helpers ---

daemon_pid() { cat "$PID_DIR/zanod.pid" 2>/dev/null || echo ""; }
wallet_pid() { cat "$PID_DIR/simplewallet.pid" 2>/dev/null || echo ""; }

is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

wait_for_port() {
  local port="$1" max_wait="${2:-60}" elapsed=0
  while ! curl -s "http://127.0.0.1:$port/json_rpc" -d '{"jsonrpc":"2.0","id":"0","method":"getinfo"}' >/dev/null 2>&1; do
    sleep 2
    elapsed=$((elapsed + 2))
    if [ "$elapsed" -ge "$max_wait" ]; then
      return 1
    fi
  done
  return 0
}

get_height() {
  curl -s "http://127.0.0.1:$DAEMON_PORT/json_rpc" \
    -d '{"jsonrpc":"2.0","id":"0","method":"getinfo"}' 2>/dev/null \
    | grep -oP '"height"\s*:\s*\K[0-9]+' || echo "0"
}

# --- Commands ---

do_download() {
  if [ -f "$BIN_DIR/zanod" ] && [ -f "$BIN_DIR/simplewallet" ]; then
    log "Binaries already exist in $BIN_DIR"
    return 0
  fi

  mkdir -p "$ZANO_DIR"

  if [ ! -f "$APPIMAGE_FILE" ]; then
    log "Downloading Zano testnet AppImage..."
    curl -L -o "$APPIMAGE_FILE" "$APPIMAGE_URL"
    chmod +x "$APPIMAGE_FILE"
  fi

  log "Extracting AppImage..."
  cd "$ZANO_DIR"
  "$APPIMAGE_FILE" --appimage-extract >/dev/null 2>&1

  mkdir -p "$BIN_DIR"
  cp squashfs-root/usr/bin/zanod "$BIN_DIR/zanod"
  cp squashfs-root/usr/bin/simplewallet "$BIN_DIR/simplewallet"
  chmod +x "$BIN_DIR/zanod" "$BIN_DIR/simplewallet"

  # Cleanup extracted AppImage contents
  rm -rf squashfs-root

  log "Binaries installed to $BIN_DIR"
  cd "$DIR"
}

do_start() {
  mkdir -p "$DATA_DIR" "$WALLET_DIR" "$PID_DIR"

  # --- Start daemon ---
  local dpid
  dpid=$(daemon_pid)
  if is_running "$dpid"; then
    log "Daemon already running (PID $dpid)"
  else
    log "Starting zanod on port $DAEMON_PORT..."
    "$BIN_DIR/zanod" \
      --testnet \
      --rpc-bind-port "$DAEMON_PORT" \
      --data-dir "$DATA_DIR" \
      --log-level 0 \
      > "$ZANO_DIR/zanod.log" 2>&1 &
    echo $! > "$PID_DIR/zanod.pid"
    log "Daemon started (PID $!)"
  fi

  # Wait for daemon RPC
  log "Waiting for daemon RPC on port $DAEMON_PORT..."
  if ! wait_for_port "$DAEMON_PORT" 120; then
    err "Daemon failed to start. Check $ZANO_DIR/zanod.log"
    exit 1
  fi
  log "Daemon RPC ready"

  # Wait for sync (poll until height stabilizes)
  log "Waiting for sync..."
  local prev_height=0 stable_count=0
  while [ "$stable_count" -lt 3 ]; do
    sleep 5
    local h
    h=$(get_height)
    if [ "$h" -gt 0 ]; then
      if [ "$h" -eq "$prev_height" ]; then
        stable_count=$((stable_count + 1))
      else
        stable_count=0
      fi
      prev_height="$h"
      log "  Height: $h (stable checks: $stable_count/3)"
    fi
  done
  log "Sync complete at height $prev_height"

  # --- Start wallet ---
  local wpid
  wpid=$(wallet_pid)
  if is_running "$wpid"; then
    log "Wallet already running (PID $wpid)"
  else
    log "Starting simplewallet on port $WALLET_PORT..."

    if [ -f "${WALLET_FILE}.keys" ]; then
      log "Opening existing wallet: $WALLET_FILE"
      "$BIN_DIR/simplewallet" \
        --testnet \
        --wallet-file "$WALLET_FILE" \
        --password "" \
        --rpc-bind-port "$WALLET_PORT" \
        --daemon-address "127.0.0.1:$DAEMON_PORT" \
        --log-level 0 \
        > "$ZANO_DIR/simplewallet.log" 2>&1 &
    else
      log "Creating new wallet: $WALLET_FILE"
      "$BIN_DIR/simplewallet" \
        --testnet \
        --generate-new-wallet "$WALLET_FILE" \
        --password "" \
        --rpc-bind-port "$WALLET_PORT" \
        --daemon-address "127.0.0.1:$DAEMON_PORT" \
        --log-level 0 \
        > "$ZANO_DIR/simplewallet.log" 2>&1 &
    fi
    echo $! > "$PID_DIR/simplewallet.pid"
    log "Wallet started (PID $!)"
  fi

  # Wait for wallet RPC
  log "Waiting for wallet RPC on port $WALLET_PORT..."
  if ! wait_for_port "$WALLET_PORT" 60; then
    err "Wallet failed to start. Check $ZANO_DIR/simplewallet.log"
    exit 1
  fi

  # Get wallet address
  local address
  address=$(curl -s "http://127.0.0.1:$WALLET_PORT/json_rpc" \
    -d '{"jsonrpc":"2.0","id":"0","method":"getaddress"}' \
    | grep -oP '"address"\s*:\s*"\K[^"]+' || echo "unknown")

  echo ""
  log "=== Zano testnet ready ==="
  log "  Daemon RPC:  http://127.0.0.1:$DAEMON_PORT/json_rpc"
  log "  Wallet RPC:  http://127.0.0.1:$WALLET_PORT/json_rpc"
  log "  Height:      $(get_height)"
  log "  Wallet:      $address"
  echo ""
}

do_stop() {
  local dpid wpid
  wpid=$(wallet_pid)
  dpid=$(daemon_pid)

  if is_running "$wpid"; then
    log "Stopping wallet (PID $wpid)..."
    kill "$wpid" 2>/dev/null
    rm -f "$PID_DIR/simplewallet.pid"
  else
    log "Wallet not running"
  fi

  if is_running "$dpid"; then
    log "Stopping daemon (PID $dpid)..."
    kill "$dpid" 2>/dev/null
    rm -f "$PID_DIR/zanod.pid"
  else
    log "Daemon not running"
  fi

  log "Stopped"
}

do_status() {
  local dpid wpid
  dpid=$(daemon_pid)
  wpid=$(wallet_pid)

  echo "Zano testnet status:"
  if is_running "$dpid"; then
    echo "  Daemon:  RUNNING (PID $dpid, height $(get_height))"
  else
    echo "  Daemon:  STOPPED"
  fi

  if is_running "$wpid"; then
    local address
    address=$(curl -s "http://127.0.0.1:$WALLET_PORT/json_rpc" \
      -d '{"jsonrpc":"2.0","id":"0","method":"getaddress"}' \
      | grep -oP '"address"\s*:\s*"\K[^"]+' 2>/dev/null || echo "unknown")
    echo "  Wallet:  RUNNING (PID $wpid, address $address)"
  else
    echo "  Wallet:  STOPPED"
  fi
}

# --- Main ---

case "${1:-start}" in
  start)
    do_download
    do_start
    ;;
  stop)   do_stop ;;
  status) do_status ;;
  *)
    echo "Usage: $0 [start|stop|status]"
    exit 1
    ;;
esac
