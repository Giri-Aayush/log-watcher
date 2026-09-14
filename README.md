# log-watcher

A sidecar for a [Zebra](https://github.com/ZcashFoundation/zebra) node. It tails
the node's log, polls its RPC, and pages the moment something an operator would
care about happens — with the evidence attached, so the engineer who picks up the
page starts reproducing instead of asking for logs.

Built for the way [Zero](https://github.com/ShieldedLabs/zero) supports exchanges,
mining pools and wallets: the operator runs the sidecar next to `zebrad`, the
sidecar pages Zero (and the operator) directly, and every page carries a bundle —
node version, network, tip, peers, RPC latency series, mempool, the last block,
and the last 200 log lines.

This started life in 2023 as a `tail -f` in a browser. After talking to Shielded
Labs about what Zero actually needs, it became this.

```
zebrad ──log (file / docker / journald)──▶ parse ──▶ events ──▶ detectors ──▶ alerts ──▶ Signal / Telegram / Discord / webhook
   └──── JSON-RPC (cookie auth) ───────▶ poll  ──▶ state  ──┘       │                 └──▶ bundles/<id>.json
   └──── Prometheus (optional) ────────▶ p99  ──┘                   └──▶ dashboard :3000
```

## What it pages on

| key | source | fires when | default |
|---|---|---|---|
| `tip_stalled` | log + RPC | no new block committed for N minutes | 10 min |
| `sync_stalled` | log | Zebra's own `chain updates have stalled` / `initial sync is very slow` | — |
| `rpc_down` | RPC | N consecutive `getblockchaininfo` failures | 3 |
| `rpc_slow` | RPC | `getblockchaininfo` round-trip above threshold | 2000 ms |
| `gbt_slow` | RPC | `getblocktemplate` — the call a pool makes — above threshold (`LW_GBT_POLL_MS` > 0) | 2000 ms |
| `gbt_error` | RPC | `getblocktemplate` failing (not synced, no miner address) | — |
| `gbt_stale` | RPC | the template's height is not ahead of the tip: miners get work for a block already mined | — |
| `peers_low` | RPC | fewer than N peers on two polls (critical at zero) | 3 |
| `mempool_high` | RPC | mempool above N transactions | 5000 |
| `large_block` | RPC | a committed block above N txs or bytes | 1000 / 1.5 MB |
| `block_lag` | RPC | block committed long after its header timestamp | 90 s |
| `verify_slow` | metrics | p99 of `zebra_consensus_transaction_duration_seconds` over the last scrape | 2 s |
| `error_burst` | log | N WARN/ERROR lines inside a sliding window | 10 / 60 s |
| `log_error` | log | any ERROR line | — |
| `end_of_support` | log + RPC | this release's halt height is within N blocks of the tip | 32256 (~4 weeks) |
| `tip_rewound` | RPC | the node reports a lower height than before (unclean restart lost non-finalized blocks) | — |
| `node_restarted` | log | the startup banner appeared | — |
| `version_changed` | RPC | `getinfo.build` changed | — |
| `node_reported_error` | RPC | `getinfo.errors` changed (works with no log access at all) | — |

On the collector, a critical `tip_stalled` / `sync_stalled` on at least half the
nodes of one network (minimum two) becomes a single `network_<key>` incident;
the per-node ones are kept but suppressed until the fleet drops below the
threshold. Three exchanges stalling together is the chain, not three customers.

Stateful alerts raise once, re-notify after a cooldown (30 min) or on escalation,
and send a RESOLVED message when the condition clears. Moments (a restart, one big
block) are transient and rate-limited per key.

Every pattern comes from a running node or from `zebrad`'s source
(`components/sync/progress.rs`, `end_of_support.rs`); `test/fixtures.js` holds
the verbatim lines.

## The knowledge base

The part that compounds. Any incident can be promoted to a **known issue**
(`POST /api/incidents/<id>/promote`): a symptom signature — detector key,
network, affected zebrad versions (prefix match), log substrings, evidence
values — plus cause, fix, workaround, references, and a status (draft →
confirmed → retired). Every new incident is matched against the signatures on
arrival and carries its matches (`knownIssueDetails`), the analysis prompt
gets them, and the analytics report the match rate: the share of incidents
that arrived with a known answer. Each entry exports as Markdown
(`/api/known-issues/<id>/export`, `?internal=1` to include which nodes), so the
public knowledge base is a by-product of doing the support. `GET /api/versions`
lists which nodes run which zebrad build — the upgrade-outreach list.

## Latency budget

Detection happens on the node's box and the page goes straight to the sink — there
is no pipeline between the two. What bounds each signal:

| signal | path | time to detect |
|---|---|---|
| new block, Zebra stall warning, ERROR line | log push (tail / `docker logs -f`) | < 1 s |
| RPC down | `rpcFailCount × pollMs` | 45 s default, 10 s with `LW_POLL_MS=5000 LW_RPC_FAIL_COUNT=2` |
| RPC slow, peers, mempool | poll | ≤ `pollMs` (peers: 2 polls) |
| tip stalled | timer | `tipStallMin` — a statistical floor: at 75 s spacing, P(no block in 10 min) ≈ e⁻⁸, so it cannot page faster without paging falsely |
| sidecar or host dead | collector heartbeat gap | `COLLECTOR_QUIET_MS` (60 s) |

The page itself is one HTTP POST to a loopback Signal bridge: sub-second.

## Debuggability decisions

- **The bundle is the unit of debugging.** Every page names a `bundles/<id>.json`
  with the node's identity, the tip and its age, the RPC latency *series* (last
  hour, so "RPC got slow at 11:42 right after that 1.9 MB block" is visible), the
  peer breakdown, the last block's size/tx count/commit lag, and the last 200 log
  lines. That is the set of things you would otherwise ask the operator for over
  three Signal messages.
- **Two clocks on every log line.** The node's timestamp and the sidecar's receive
  time. A growing gap is the log stream lagging — a symptom in its own right.
- **Panics are not in the log file.** `zebrad` writes them to stderr. A dead node
  looks like silence in the log and a refused connection on RPC, so liveness is
  judged from RPC, never from the log going quiet.
- **A stale cookie closes the socket.** Zebra regenerates the RPC cookie on every
  start and answers an old one by dropping the connection, not with a 401. The
  client re-reads the file when its mtime changes and after any network error.
- **Old lines are history.** On startup (and `docker logs --tail`) the sidecar reads
  back to build state, but anything older than `replayAgeS` (60 s) cannot page. A
  restart that happened an hour ago is context, not an incident.
- **Outbound only.** The sidecar reaches the node over loopback and reaches Zero
  by POSTing outward. Nothing connects in; no operator has to open a port.
- **Delivery is ordered and retried, not fire-and-forget.** Messages to the
  collector go through an outbox: one in flight at a time (so RESOLVED cannot
  overtake NEW), exponential backoff while the collector is unreachable, every
  message numbered so a retry that lands twice is dropped once. Heartbeats
  collapse to the newest while queued; alerts are never dropped until the queue
  hits its bound (1000). The dashboard's `delivered` counter shows the queue.
- **No gap mixes clocks.** Time to detect and time to resolve are sidecar-clock
  to sidecar-clock; time to acknowledge and respond are collector-clock to
  collector-clock. Each node's skew is shown on the fleet page.
- **Each alert carries a `next:` line** — the first three things to check, written
  for the engineer on the rotation, not for the operator.
- **What leaves the box is a setting.** The local bundle file always has
  everything; the page that goes to the collector is filtered at the export
  boundary: `LW_SHARE_LOGS=full|summary|none` (summary = WARN/ERROR lines plus
  the last five), and the hostname is not sent unless `LW_SHARE_HOST=true`. Zebra
  itself already redacts peer addresses in its log. Every exported bundle states
  the policy it was produced under.
- **A human sends every message to an operator.** On the collector, "Ask Claude
  for an analysis" on an incident runs the model over the incident, the
  page-time bundle, the other nodes on the same network, this node's history
  and the last hour of heartbeats, and attaches a draft: assessment (node-local,
  network-wide, or expected on this network), probable cause, what to check, a
  regtest repro, a message to the operator, confidence. Credentials are Zero's
  (`ANTHROPIC_API_KEY` in the collector's environment), never the customer's.
  The sidecar can do a bundle-only version on the box if it is given a key. In
  both cases it is a draft. Nothing is sent from it.

## Run it

### Live demo on a real node

```bash
scripts/demo-live.sh up          # regtest zebrad + sidecar + collector, opens both dashboards
scripts/demo-live.sh mine 3      # blocks arrive
scripts/demo-live.sh kill        # rpc_down
scripts/demo-live.sh revive      # node_restarted, RESOLVED, tip_rewound
```

[DEMO.md](DEMO.md) is the runbook: what to run, what appears, what to say.

### Demo, no node needed

```bash
npm install
npm run demo          # fake zebrad + sidecar + collector; every scenario fires over ~90 s
```

Open <http://localhost:3000> (sidecar) and <http://localhost:4000> (collector fleet
view). Scenarios: `stall peers rpc-slow rpc-down errors restart bigblock mempool zebra-stall`
(`node scripts/demo.js stall,peers` for a subset).

### Against a real node

Zebra in Docker (the Zero `z3-stack` layout — container `zebra`, RPC on 8232):

```bash
LW_SOURCE=docker LW_CONTAINER=zebra LW_RPC_URL=http://127.0.0.1:8232 npm start
```

Zebra as a systemd unit with cookie auth (the default since Zebra 2.x):

```bash
LW_SOURCE=journald LW_UNIT=zebrad \
LW_RPC_URL=http://127.0.0.1:8232 LW_RPC_COOKIE=/home/zebra/.cache/zebra/.cookie npm start
```

Zebra writing to a file (`[tracing] log_file = "..."` in `zebrad.toml`):

```bash
LW_SOURCE=file LW_LOG_FILE=/var/log/zebrad.log LW_RPC_URL=http://127.0.0.1:8232 npm start
```

A node you can only reach over SSH, logs only:

```bash
LW_SOURCE=command LW_COMMAND="ssh root@node docker logs -f --tail 500 zebra 2>&1" LW_POLL_MS=0 npm start
```

As a container next to the node: `docker compose up -d log-watcher` (see
[docker-compose.yml](docker-compose.yml)).

### Paging

| sink | env |
|---|---|
| Signal via [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) | `LW_SIGNAL_URL=http://127.0.0.1:8081/v2/send LW_SIGNAL_NUMBER=+1555… [LW_SIGNAL_RECIPIENT]` |
| Telegram | `LW_TELEGRAM_TOKEN LW_TELEGRAM_CHAT` |
| Discord | `LW_DISCORD_WEBHOOK` |
| Generic webhook / the collector | `LW_WEBHOOK_URL` — receives alerts with bundles, and a heartbeat every poll |

The console always gets everything.

A page looks like this:

```
[foundry-pool-1] CRITICAL tip_stalled
No new block for 12m 30s
Tip is still 3011882 (last seen via gossip). Target spacing is 75s; 10m without a block means this node stopped receiving them, or the network did.
zebrad v6.3.0 Mainnet · tip 3011882 · peers 2 · rpc 41ms · mempool 3
last log: 2026-09-14T11:16:02.733823Z  INFO sync: zebrad::components::sync: waiting to restart sync timeout=67s state_tip=Some(Height(3011882))
next: Compare height with a public explorer or a second node. If they moved on, this node is partitioned (peers?) or stuck verifying; if not, it is the network.
bundle: bundles/2026-09-14T11-28-33-120Z-tip_stalled-7.json
```

### The collector (Zero side)

`scripts/collector.js` is the other end of `LW_WEBHOOK_URL`. It keeps an
incident per stateful alert with the timestamps the response metrics are built
from — onset, paged, acknowledged, responded (told the operator), resolved — and
serves the Overview at `/` (built from the mock in [design/](design/)): p50/p95
of each gap over a window, oldest unacknowledged, availability, incidents per
hour, the fleet table, and the open incidents with Ack / Responded / Close.
Every value on it comes from `/api/analytics`, `/api/fleet` and
`/api/incidents`. Each incident can record what changed in Zero because of it (`POST
…/improvement`: a detector, a threshold, a runbook line, an upstream PR); the
analytics report how many closed incidents left one behind, which is the JD's
"each engagement ends as a permanent improvement" as a number.
`GET /api/incidents/<id>/report` renders the customer-facing
incident report (Markdown: summary, timeline, response times, evidence, node at
page time, the engineer's notes as analysis, recommendations) from the same
record; `POST …/report` marks it sent. Every
bundle is stored under `collected/bundles/<label>/`; heartbeats become a per-node
series (`/api/series/<label>`). A node that stops sending heartbeats is marked
quiet after 60 s. One process, JSON on disk, no auth: the shape of the design,
not the production service.

### Configuration

Defaults → `--config file.json` ([config.example.json](config.example.json)) →
`LW_*` environment. Every threshold in the table above has an env var
(`LW_TIP_STALL_MIN`, `LW_MIN_PEERS`, `LW_RPC_SLOW_MS`, …); see
[src/config.js](src/config.js) for the full list. `LW_METRICS_URL` enables the
Prometheus scrape when `[metrics] endpoint_addr` is set in `zebrad.toml`.
`LW_GBT_POLL_MS=30000` turns on the `getblocktemplate` probe for pool nodes (the
node needs `mining.miner_address` set, as a pool's does).

## Tests

```bash
npm test                # unit + pipeline against a fake RPC server (~0.6 s)
npm run test:regtest    # real zebrad in regtest: mine 3 blocks, kill it, expect the page (~1.5 s)
scripts/regtest.sh start && eval "$(scripts/regtest.sh env)" && npm start   # poke at it by hand
scripts/regtest.sh mine 3
```

The regtest test needs `zebrad` on `PATH` and is skipped otherwise.

## Not done, on purpose

- Missed-block detection for miners needs the pool's own view (which template it
  was working on); the sidecar sees `submitblock` results in the log but cannot
  know a block was *expected*. That wants a small hook on the pool side.
- `verify_slow` reads Zero's per-check verification histograms; upstream Zebra
  does not expose them and the endpoint is off by default.
- The dashboard is a live view, not a history. The collector holds the history.
- No auth on the dashboard or the collector: bind them to loopback or put them
  behind whatever you already use.
