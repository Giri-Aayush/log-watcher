#!/usr/bin/env bash
# Live demo on a real zebrad: regtest node + sidecar + collector, and the
# levers to make things happen while people watch.
#
#   scripts/demo-live.sh up        # start all three, open the dashboards
#   -- or, node in your own terminal so people can watch it --
#   scripts/demo-live.sh node      # write the config, print the zebrad command for terminal 1
#   scripts/demo-live.sh attach    # terminal 2: collector + sidecar onto that node, open the dashboards
#   scripts/demo-live.sh mine 3    # three blocks -> block_committed x3, tip moves, block detail fills in
#   (wait ~60s)                    # -> tip_stalled CRITICAL (LW_TIP_STALL_MIN=1 for the demo)
#   scripts/demo-live.sh mine 1    # -> RESOLVED tip_stalled
#   scripts/demo-live.sh kill      # SIGKILL zebrad -> rpc_down within ~6s; the log goes silent, RPC does not
#   scripts/demo-live.sh revive    # zebrad back -> startup banner -> node_restarted, RESOLVED rpc_down
#   scripts/demo-live.sh twin      # second sidecar (:3002, label regtest-b) on the same node -> when both stall, the
#                                  #   collector opens ONE network incident and suppresses the two per-node ones
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

# start_sidecar <name> <label> <port>
start_sidecar() {
  alive "$1" && return 0
  LW_LABEL="$2" LW_SOURCE=file LW_LOG_FILE="$DIR/zebrad.log" \
  LW_RPC_URL="http://127.0.0.1:$RPC_PORT" LW_RPC_COOKIE="$DIR/.cookie" \
  LW_POLL_MS=3000 LW_GBT_POLL_MS=10000 LW_RPC_FAIL_COUNT=2 LW_TIP_STALL_MIN=1 LW_MIN_PEERS=0 LW_BLOCK_LAG_S=0 LW_TRANSIENT_COOLDOWN_S=15 \
  LW_WEBHOOK_URL="http://127.0.0.1:$COLLECTOR_PORT/ingest" LW_BUNDLE_DIR="$DIR/bundles-$1" LW_PORT="$3" LW_DASHBOARD_URL="http://localhost:$3" LW_SHARE_HOST=true \
  nohup node server.js > "$DIR/$1.out" 2>&1 &
  echo $! > "$DIR/$1.pid"
}

case "${1:-}" in
  up)
    preflight
    say "1/3 zebrad regtest"; scripts/regtest.sh start
    say "2/3 collector on :$COLLECTOR_PORT"
    alive collector || { COLLECTOR_PORT="$COLLECTOR_PORT" COLLECTOR_DIR="$DIR/collected" nohup node scripts/collector.js > "$DIR/collector.out" 2>&1 & echo $! > "$DIR/collector.pid"; }
    say "3/3 sidecar on :$SIDECAR_PORT"; start_sidecar sidecar "${LW_LABEL:-regtest-$(hostname -s)}" "$SIDECAR_PORT"
    sleep 2
    say "dashboard  http://localhost:$SIDECAR_PORT/"
    say "collector  http://localhost:$COLLECTOR_PORT/"
    command -v open >/dev/null && open "http://localhost:$SIDECAR_PORT/" "http://localhost:$COLLECTOR_PORT/" || true
    echo; sed -n '4,12p' "$0" | sed 's/^# \{0,3\}//'
    ;;
  node)
    scripts/regtest.sh config stdout
    echo; say "then, in another terminal: scripts/demo-live.sh attach" ;;
  attach)
    preflight_attach() {
      command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "need node >= 20"; exit 1; }
      [ -d node_modules ] || { say "installing dependencies"; npm install --no-audit --no-fund >/dev/null; }
      alive sidecar || port_free "$SIDECAR_PORT" || { echo "port $SIDECAR_PORT is in use: $(lsof -nP -iTCP:$SIDECAR_PORT -sTCP:LISTEN | tail -1 | awk '{print $1, $2}')"; exit 1; }
      alive collector || port_free "$COLLECTOR_PORT" || { echo "port $COLLECTOR_PORT is in use: $(lsof -nP -iTCP:$COLLECTOR_PORT -sTCP:LISTEN | tail -1 | awk '{print $1, $2}')"; exit 1; }
      [ -f "$DIR/zebrad.log" ] || { echo "no $DIR/zebrad.log yet — start the node first (scripts/demo-live.sh node)"; exit 1; }
      for _ in $(seq 1 20); do [ -f "$DIR/.cookie" ] && curl -s -m 3 -u "$(cat "$DIR/.cookie")" -H 'content-type: application/json' --data-binary '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' "http://127.0.0.1:$RPC_PORT/" | grep -q result && return 0; sleep 0.5; done
      echo "zebrad RPC not answering on :$RPC_PORT — is the node running?"; exit 1
    }
    preflight_attach
    say "1/2 collector on :$COLLECTOR_PORT"
    alive collector || { COLLECTOR_PORT="$COLLECTOR_PORT" COLLECTOR_DIR="$DIR/collected" nohup node scripts/collector.js > "$DIR/collector.out" 2>&1 & echo $! > "$DIR/collector.pid"; }
    say "2/2 sidecar on :$SIDECAR_PORT"; start_sidecar sidecar "${LW_LABEL:-regtest-$(hostname -s)}" "$SIDECAR_PORT"
    sleep 2
    say "dashboard  http://localhost:$SIDECAR_PORT/"
    say "collector  http://localhost:$COLLECTOR_PORT/"
    command -v open >/dev/null && open "http://localhost:$SIDECAR_PORT/" "http://localhost:$COLLECTOR_PORT/" || true
    echo; echo "mine / kill / revive: for a node you started yourself, kill it with Ctrl-C (clean) or"
    echo "  kill -9 \$(pgrep -f 'zebrad -c $DIR/zebrad.toml')   (unclean: loses non-finalized blocks -> tip_rewound)"
    echo "and revive it by running the same zebrad command again in that terminal." ;;
  mine)     scripts/regtest.sh mine "${2:-1}" ;;
  kill)
    if [ -f "$DIR/zebrad.pid" ]; then kill -9 "$(cat "$DIR/zebrad.pid")" && rm -f "$DIR/zebrad.pid";
    else pkill -9 -f "zebrad -c $DIR/zebrad.toml" || { echo "no zebrad found"; exit 1; }; fi
    say "zebrad killed with SIGKILL — watch rpc_down" ;;
  revive)
    if grep -q '^log_file' "$DIR/zebrad.toml" 2>/dev/null; then scripts/regtest.sh start && say "zebrad back — watch the startup banner, node_restarted and RESOLVED rpc_down";
    else say "the node runs in your terminal: run the zebrad command there again"; scripts/regtest.sh config stdout | tail -1; fi ;;
  twin)
    start_sidecar twin "regtest-b" 3002; sleep 1
    say "second sidecar on http://localhost:3002/ (label regtest-b). Stop mining for a minute: both page tip_stalled, the collector shows one network_tip_stalled." ;;
  testnet)
    port_free 18232 && { say "opening ssh tunnel to $TESTNET_HOST:18232"; ssh -f -N -L 18232:127.0.0.1:18232 "$TESTNET_HOST"; }
    if [ -f "$TESTNET_COOKIE" ]; then rpc_env="LW_RPC_URL=http://127.0.0.1:18232 LW_RPC_COOKIE=$TESTNET_COOKIE LW_POLL_MS=15000";
    else rpc_env="LW_POLL_MS=0"; say "no $TESTNET_COOKIE — running logs-only. For RPC too: ssh $TESTNET_HOST docker exec $TESTNET_CONTAINER cat /run/auth/.cookie > $TESTNET_COOKIE"; fi
    alive testnet || { env LW_LABEL=linode-testnet LW_SOURCE=command LW_COMMAND="ssh $TESTNET_HOST docker logs -f --tail 2000 $TESTNET_CONTAINER 2>&1" \
      $rpc_env LW_WEBHOOK_URL="http://127.0.0.1:$COLLECTOR_PORT/ingest" LW_BUNDLE_DIR="$DIR/bundles-testnet" LW_PORT=3001 \
      nohup node server.js > "$DIR/testnet.out" 2>&1 & echo $! > "$DIR/testnet.pid"; }
    sleep 2; say "testnet sidecar  http://localhost:3001/"; command -v open >/dev/null && open "http://localhost:3001/" || true ;;
  status)
    for p in zebrad collector sidecar twin testnet; do alive "$p" && echo "$p: up (pid $(cat "$DIR/$p.pid"))" || echo "$p: down"; done
    curl -s "http://localhost:$SIDECAR_PORT/health" | head -c 400; echo ;;
  logs)     tail -n 40 -f "$DIR/sidecar.out" ;;
  down)
    for p in testnet twin sidecar collector; do alive "$p" && kill "$(cat "$DIR/$p.pid")" && rm -f "$DIR/$p.pid" && echo "$p stopped"; done
    scripts/regtest.sh stop ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
