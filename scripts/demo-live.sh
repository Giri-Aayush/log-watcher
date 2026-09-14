#!/usr/bin/env bash
# Live demo on a real zebrad: regtest node + sidecar + collector, and the
# levers to make things happen while people watch.
#
#   scripts/demo-live.sh up        # start all three, open the dashboards
#   scripts/demo-live.sh mine 3    # three blocks -> block_committed x3, tip moves, block detail fills in
#   (wait ~60s)                    # -> tip_stalled CRITICAL (LW_TIP_STALL_MIN=1 for the demo)
#   scripts/demo-live.sh mine 1    # -> RESOLVED tip_stalled
#   scripts/demo-live.sh kill      # SIGKILL zebrad -> rpc_down within ~6s; the log goes silent, RPC does not
#   scripts/demo-live.sh revive    # zebrad back -> startup banner -> node_restarted, RESOLVED rpc_down
#   scripts/demo-live.sh testnet   # second sidecar on :3001 against the Linode testnet node over SSH
#   scripts/demo-live.sh status | logs | down
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$PWD/.regtest"
RPC_PORT="${RPC_PORT:-18932}"
SIDECAR_PORT="${SIDECAR_PORT:-3000}"
COLLECTOR_PORT="${COLLECTOR_PORT:-4000}"
TESTNET_HOST="${TESTNET_HOST:-root@172.235.26.235}"
TESTNET_CONTAINER="${TESTNET_CONTAINER:-z3-testnet-zebra-1}"
TESTNET_COOKIE="${TESTNET_COOKIE:-$HOME/.lw-testnet.cookie}"
mkdir -p "$DIR"

say() { printf '\033[1;36m%s\033[0m\n' "$*"; }
port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
alive() { [ -f "$DIR/$1.pid" ] && kill -0 "$(cat "$DIR/$1.pid")" 2>/dev/null; }

preflight() {
  local ok=1
  command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "need node >= 20"; ok=0; }
  command -v zebrad >/dev/null || { echo "zebrad not on PATH (cargo install zebrad)"; ok=0; }
  [ -d node_modules ] || { say "installing dependencies"; npm install --no-audit --no-fund >/dev/null; }
  for p in "$SIDECAR_PORT" "$COLLECTOR_PORT" "$RPC_PORT" 18344; do
    port_free "$p" || { echo "port $p is in use: $(lsof -nP -iTCP:$p -sTCP:LISTEN | tail -1 | awk '{print $1, $2}')"; ok=0; }
  done
  [ "$ok" = 1 ] || { echo "fix the above, then run again"; exit 1; }
}

start_sidecar() {
  alive sidecar && return 0
  LW_LABEL="${LW_LABEL:-regtest-$(hostname -s)}" LW_SOURCE=file LW_LOG_FILE="$DIR/zebrad.log" \
  LW_RPC_URL="http://127.0.0.1:$RPC_PORT" LW_RPC_COOKIE="$DIR/.cookie" \
  LW_POLL_MS=3000 LW_RPC_FAIL_COUNT=2 LW_TIP_STALL_MIN=1 LW_MIN_PEERS=0 LW_BLOCK_LAG_S=0 LW_TRANSIENT_COOLDOWN_S=15 \
  LW_WEBHOOK_URL="http://127.0.0.1:$COLLECTOR_PORT/ingest" LW_BUNDLE_DIR="$DIR/bundles" LW_PORT="$SIDECAR_PORT" \
  nohup node server.js > "$DIR/sidecar.out" 2>&1 &
  echo $! > "$DIR/sidecar.pid"
}

case "${1:-}" in
  up)
    preflight
    say "1/3 zebrad regtest"; scripts/regtest.sh start
    say "2/3 collector on :$COLLECTOR_PORT"
    alive collector || { COLLECTOR_PORT="$COLLECTOR_PORT" COLLECTOR_DIR="$DIR/collected" nohup node scripts/collector.js > "$DIR/collector.out" 2>&1 & echo $! > "$DIR/collector.pid"; }
    say "3/3 sidecar on :$SIDECAR_PORT"; start_sidecar
    sleep 2
    say "dashboard  http://localhost:$SIDECAR_PORT/"
    say "collector  http://localhost:$COLLECTOR_PORT/"
    command -v open >/dev/null && open "http://localhost:$SIDECAR_PORT/" "http://localhost:$COLLECTOR_PORT/" || true
    echo; sed -n '4,12p' "$0" | sed 's/^# \{0,3\}//'
    ;;
  mine)     scripts/regtest.sh mine "${2:-1}" ;;
  kill)     kill -9 "$(cat "$DIR/zebrad.pid")" && rm -f "$DIR/zebrad.pid" && say "zebrad killed with SIGKILL — watch rpc_down" ;;
  revive)   scripts/regtest.sh start && say "zebrad back — watch the startup banner, node_restarted and RESOLVED rpc_down" ;;
  testnet)
    port_free 18232 && { say "opening ssh tunnel to $TESTNET_HOST:18232"; ssh -f -N -L 18232:127.0.0.1:18232 "$TESTNET_HOST"; }
    if [ -f "$TESTNET_COOKIE" ]; then rpc_env="LW_RPC_URL=http://127.0.0.1:18232 LW_RPC_COOKIE=$TESTNET_COOKIE LW_POLL_MS=15000";
    else rpc_env="LW_POLL_MS=0"; say "no $TESTNET_COOKIE — running logs-only. For RPC too: ssh $TESTNET_HOST docker exec $TESTNET_CONTAINER cat /run/auth/.cookie > $TESTNET_COOKIE"; fi
    alive testnet || { env LW_LABEL=linode-testnet LW_SOURCE=command LW_COMMAND="ssh $TESTNET_HOST docker logs -f --tail 2000 $TESTNET_CONTAINER 2>&1" \
      $rpc_env LW_WEBHOOK_URL="http://127.0.0.1:$COLLECTOR_PORT/ingest" LW_BUNDLE_DIR="$DIR/bundles-testnet" LW_PORT=3001 \
      nohup node server.js > "$DIR/testnet.out" 2>&1 & echo $! > "$DIR/testnet.pid"; }
    sleep 2; say "testnet sidecar  http://localhost:3001/"; command -v open >/dev/null && open "http://localhost:3001/" || true ;;
  status)
    for p in zebrad collector sidecar testnet; do alive "$p" && echo "$p: up (pid $(cat "$DIR/$p.pid"))" || echo "$p: down"; done
    curl -s "http://localhost:$SIDECAR_PORT/health" | head -c 400; echo ;;
  logs)     tail -n 40 -f "$DIR/sidecar.out" ;;
  down)
    for p in testnet sidecar collector; do alive "$p" && kill "$(cat "$DIR/$p.pid")" && rm -f "$DIR/$p.pid" && echo "$p stopped"; done
    scripts/regtest.sh stop ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
