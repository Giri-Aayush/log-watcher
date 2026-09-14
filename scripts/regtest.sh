#!/usr/bin/env bash
# Throwaway zebrad regtest node for developing and demoing the sidecar.
# No peers, no sync: blocks exist when you mine them.
#
#   scripts/regtest.sh start          # zebrad regtest in .regtest/, RPC on :18932 with cookie auth
#   scripts/regtest.sh mine 3         # mine 3 blocks (the sidecar sees "sending mined block broadcast")
#   scripts/regtest.sh env            # print the LW_* exports for `npm start`
#   scripts/regtest.sh stop
#
# Regtest quirks worth knowing: block timestamps are fixed near genesis, so set
# LW_BLOCK_LAG_S=0; there are no peers, so LW_MIN_PEERS=0; and Zebra logs
# "initial sync is very slow" forever because it estimates the tip from the
# wall clock. That last one is a real Zebra message and the sidecar reports it.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$PWD/.regtest"
RPC_PORT="${RPC_PORT:-18932}"
P2P_PORT="${P2P_PORT:-18344}"
ZEBRAD="${ZEBRAD:-zebrad}"

rpc() {
  curl -s -m 60 -u "$(cat "$DIR/.cookie")" -H 'content-type: application/json' \
    --data-binary "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" "http://127.0.0.1:$RPC_PORT/"
}

miner_address() {
  # Any valid testnet/regtest P2PKH address will do; the coins are worthless.
  node -e '
    const c = require("crypto"); const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const payload = Buffer.concat([Buffer.from([0x1d, 0x25]), c.randomBytes(20)]);
    const chk = c.createHash("sha256").update(c.createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
    let n = BigInt("0x" + Buffer.concat([payload, chk]).toString("hex")), s = "";
    while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } console.log(s)'
}

case "${1:-}" in
  start)
    command -v "$ZEBRAD" >/dev/null || { echo "zebrad not found (cargo install zebrad, or ZEBRAD=/path)"; exit 1; }
    mkdir -p "$DIR"
    if [ -f "$DIR/zebrad.pid" ] && kill -0 "$(cat "$DIR/zebrad.pid")" 2>/dev/null; then echo "already running (pid $(cat "$DIR/zebrad.pid"))"; exit 0; fi
    cat > "$DIR/zebrad.toml" <<TOML
[network]
network = "Regtest"
listen_addr = "127.0.0.1:$P2P_PORT"
cache_dir = "$DIR/cache"
initial_mainnet_peers = []
initial_testnet_peers = []

[state]
cache_dir = "$DIR/cache"

[rpc]
listen_addr = "127.0.0.1:$RPC_PORT"
enable_cookie_auth = true
cookie_dir = "$DIR"

[mining]
miner_address = "$(miner_address)"

[tracing]
log_file = "$DIR/zebrad.log"
use_color = false
TOML
    nohup "$ZEBRAD" -c "$DIR/zebrad.toml" start > "$DIR/zebrad.stdout" 2>&1 &
    echo $! > "$DIR/zebrad.pid"
    for _ in $(seq 1 30); do
      if [ -f "$DIR/.cookie" ] && rpc getblockcount 2>/dev/null | grep -q result; then
        echo "zebrad regtest up: rpc http://127.0.0.1:$RPC_PORT  log $DIR/zebrad.log  height $(rpc getblockcount | sed 's/.*"result":\([0-9]*\).*/\1/')"
        exit 0
      fi
      sleep 0.5
    done
    echo "zebrad did not come up; see $DIR/zebrad.stdout (panics land there, not in the log file)"; exit 1 ;;
  mine)
    rpc generate "[${2:-1}]"; echo ;;
  env)
    cat <<ENV
export LW_LABEL=regtest LW_SOURCE=file LW_LOG_FILE=$DIR/zebrad.log
export LW_RPC_URL=http://127.0.0.1:$RPC_PORT LW_RPC_COOKIE=$DIR/.cookie
export LW_TIP_STALL_MIN=1 LW_MIN_PEERS=0 LW_BLOCK_LAG_S=0 LW_POLL_MS=3000
ENV
    ;;
  stop)
    [ -f "$DIR/zebrad.pid" ] && kill "$(cat "$DIR/zebrad.pid")" 2>/dev/null && rm -f "$DIR/zebrad.pid" && echo stopped || echo "not running" ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
