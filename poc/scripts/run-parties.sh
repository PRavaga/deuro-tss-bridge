#!/bin/bash
# Start all 3 bridge parties in background, logs to /tmp/party-*.log
# Usage: ./scripts/run-parties.sh [start|stop|status|logs]

BRIDGE_ADDRESS="0x7a40738f7914F6Cc8d283e117b00fFE5e19250B5"
EVM_RPC="https://eth-sepolia.g.alchemy.com/v2/z97HTgIuGjc4F_sD1-0EZ"
ZANO_DAEMON_RPC="http://127.0.0.1:12111/json_rpc"
ZANO_WALLET_RPC="http://127.0.0.1:12212/json_rpc"
ZANO_ASSET_ID="15c077f777a99ab1af8c28eaee8532185ad005af16ada32a668f94ce06c6d0d7"
DEURO_TOKEN="${DEURO_TOKEN:-0x90e4bEE191fD540954D9843a21C11C9f74a16776}"
DEPLOYER_PRIVATE_KEY="${DEPLOYER_PRIVATE_KEY:-}"

DIR="$(cd "$(dirname "$0")/.." && pwd)"

start() {
  for i in 0 1 2; do
    echo "Starting Party $i..."
    PARTY_ID=$i \
      BRIDGE_ADDRESS=$BRIDGE_ADDRESS \
      EVM_RPC=$EVM_RPC \
      ZANO_DAEMON_RPC=$ZANO_DAEMON_RPC \
      ZANO_WALLET_RPC=$ZANO_WALLET_RPC \
      ZANO_ASSET_ID=$ZANO_ASSET_ID \
      DEURO_TOKEN=$DEURO_TOKEN \
      DEPLOYER_PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY \
      node "$DIR/src/party.js" > "/tmp/party-$i.log" 2>&1 &
    echo "  PID: $! -> /tmp/party-$i.log"
  done
  echo "All parties started. Use '$0 logs' to tail output."
}

stop() {
  echo "Stopping parties..."
  pkill -f "node.*party.js" 2>/dev/null && echo "Stopped" || echo "No parties running"
}

status() {
  echo "Party processes:"
  pgrep -fa "node.*party.js" || echo "  No parties running"
  echo ""
  echo "P2P health:"
  for i in 0 1 2; do
    port=$((4000 + i))
    resp=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/p2p/health" 2>/dev/null)
    if [ "$resp" = "200" ]; then
      echo "  Party $i (port $port): UP"
    else
      echo "  Party $i (port $port): DOWN"
    fi
  done
}

logs() {
  tail -f /tmp/party-0.log /tmp/party-1.log /tmp/party-2.log
}

case "${1:-start}" in
  start)  start ;;
  stop)   stop ;;
  status) status ;;
  logs)   logs ;;
  *)      echo "Usage: $0 [start|stop|status|logs]" ;;
esac
