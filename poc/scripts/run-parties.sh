#!/bin/bash
# Start all 3 bridge parties in background, logs to /tmp/party-*.log
# Usage: ./scripts/run-parties.sh [start|stop|status|logs]

BRIDGE_ADDRESS="0x72D501f30325aE86C6E2Bb2b50C73d688aa3a09e"
EVM_RPC="https://eth-sepolia.g.alchemy.com/v2/z97HTgIuGjc4F_sD1-0EZ"
ZANO_DAEMON_RPC="http://127.0.0.1:12111/json_rpc"
ZANO_WALLET_RPC="http://127.0.0.1:12212/json_rpc"
ZANO_ASSET_ID="ff36665da627f7f09a1fd8e9450d37ed19f92b2021d84a74a76e1c347c52603c"
DEURO_TOKEN="${DEURO_TOKEN:-0xa7ff975db5AF3Ca92D7983ef944a636Ca962CB60}"

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
