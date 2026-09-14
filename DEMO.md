# Demo runbook

A real `zebrad` (regtest), the sidecar attached to it, and the collector — all on
the laptop. You make things happen; the dashboard shows the flow as it happens.
About eight minutes end to end.

## Before the call

Two terminals, so the node is visibly a real process:

```bash
# terminal 1 — the node. Prints the exact zebrad command; run it and leave it scrolling.
scripts/demo-live.sh down; rm -rf .regtest
scripts/demo-live.sh node
zebrad -c .regtest/zebrad.toml start 2>&1 | tee .regtest/zebrad.log

# terminal 2 — attach the sidecar and the collector to it; opens both tabs.
scripts/demo-live.sh attach
```

(`scripts/demo-live.sh up` does all of it in one terminal if you prefer.) With a
node you started yourself, "kill" is `kill -9 $(pgrep -f 'zebrad -c')` in terminal 2
(unclean, so the non-finalized blocks are lost and `tip_rewound` shows) or Ctrl-C in
terminal 1 (clean), and "revive" is running the zebrad command again in terminal 1.

Tabs: **sidecar** <http://localhost:3000> and **collector** <http://localhost:4000>.
Check once that `scripts/demo-live.sh mine 1` moves the tip. Then leave it — a
minute later `tip_stalled` will fire on its own, which is a fine opening state.

Keep a terminal visible at the repo root for the commands below.

## The walk-through

**1. What is attached (30 s).** Header: label, `file .regtest/zebrad.log`, `rpc
http://127.0.0.1:18932`. Node card says `v6.2.0 Regtest` — that came from the
multi-line startup banner in the log, not from RPC. Point at the counters:
lines → events → polls → pages. That is the pipeline.

**2. A block arrives (1 min).**
```bash
scripts/demo-live.sh mine 3
```
Watch, in order: three `block_committed` rows in *Events*; the *tip* card flashes
1 → 2 → 3; *last block* fills in (1 tx, 1.6 KiB). Say: the log told us a block
was committed, so we called `getblock` for its size and transaction count —
that is where a 7,000-input block would show up before anyone complained.

**3. The tip goes stale (wait ~60 s, talk over it).** `tip_stalled` CRITICAL
appears in *Active alerts* and the console. Open the `bundle` link: node,
tip, RPC latency series, peers, the last 200 log lines, and `next:` — the first
things the on-call engineer checks. Say: this is what would otherwise be three
Signal messages asking the operator for logs. Switch to the collector tab: same
alert, same bundle, on the Zero side, delivered outbound-only.

Threshold is 1 minute here for the demo; the real default is 10 (at 75 s spacing,
P(no block in 10 min) ≈ e⁻⁸ — it cannot page faster without paging falsely).

On the collector tab, click **ack** on the incident, then **responded** and type
what you told the operator. Those two clicks are what make the response metrics
real: the tiles at the top (time to detect / acknowledge / respond / resolve, p50
and p95) are computed from exactly these timestamps. "Oldest unacked" is the
number an on-call lead watches.

```bash
scripts/demo-live.sh mine 1      # -> RESOLVED tip_stalled, new block in the events feed
```

**4. The node dies (30 s).**
```bash
scripts/demo-live.sh kill
```
Within ~6 s: `rpc_down` CRITICAL. Say: nothing appeared in the log — zebrad
writes panics to stderr, so a dead node is silence in the log file and a refused
connection on RPC. Liveness is judged from RPC on purpose.

**5. It comes back (30 s).**
```bash
scripts/demo-live.sh revive
```
Events: startup banner → `node_restarted`; then `RESOLVED rpc_down`; then
`tip_rewound` 3 → 1. Say: SIGKILL lost the non-finalized blocks (Zebra backs them
up only on a clean shutdown), so the node came back on a shorter chain — a miner
on this node just mined on a stale tip and would never know. Also: the RPC cookie
rotated on restart and the sidecar picked it up (Zebra closes the socket on a
stale cookie rather than answering 401 — learned that the hard way today).

**5b. The collector goes down (optional, 1 min).** Kill it:
`kill $(cat .regtest/collector.pid)`. Then `scripts/demo-live.sh kill` and
`revive` again. The sidecar's header shows `delivered N (+4 queued)` in red;
the console says `collector unreachable; queueing`. Bring it back
(`COLLECTOR_PORT=4000 COLLECTOR_DIR=.regtest/collected node scripts/collector.js &`)
and watch the queue flush in order — NEW, node_restarted, RESOLVED — with no
duplicates on the fleet page. Say: pages are never lost because Zero's side was
restarting; delivery is ordered, retried with backoff, and deduplicated.

**5c. Network, not customer (optional, 2 min).** `scripts/demo-live.sh twin`
starts a second sidecar (label `regtest-b`) on the same node. Stop mining for a
minute: both page `tip_stalled`, and the collector shows **one** open incident,
`tip stalled on 2 of 2 Regtest nodes`, with the two per-node ones suppressed
under it. Say: three exchanges stalling together is the chain, not three
customers; the on-call gets one page and a different message to send. `mine 1`
resolves it.

The `getblocktemplate` card on the sidecar dashboard is on in the demo
(`LW_GBT_POLL_MS=10000`): that is the call a pool makes, so its latency is the
pool's experience rather than a proxy for it.

**5d. Close the loop with the customer (1 min).** On the incident page (or
`GET /api/incidents/<id>/report`), open the **incident report**: a Markdown
write-up generated from the record — what happened, when we detected it and how
fast we acknowledged, what we told the operator, when it cleared, what we
recommend. Add a note first ("two outbound peers dropped; node was partitioned")
and it appears under *Analysis*. Click **Report sent**: that lands in the audit
trail with your name. Say: this is the artefact the customer actually receives,
and it is generated, not typed, so it is never missing the timeline.

**6. Real network (optional, 1 min).**
```bash
scripts/demo-live.sh testnet     # second sidecar on :3001, Linode testnet node over SSH
```
Zebra 6.3.0, real peers, blocks every ~75 s, `logDelayMs` ~15 ms over SSH. Logs
only unless `~/.lw-testnet.cookie` exists (`ssh root@box docker exec
z3-testnet-zebra-1 cat /run/auth/.cookie > ~/.lw-testnet.cookie`).

## If asked

- *How would you find out why this node fell behind?* Bundle first: RPC latency
  series vs. the last block's size; `logDelayMs`; peer count. Then reproduce:
  `getblock <hash> 0` from a healthy node, feed it to a regtest node or Zero's
  verification benchmark, read the per-check timers Zero v29 added
  (`zebra_consensus_transaction_check_duration_seconds`), which `verify_slow`
  scrapes when the metrics endpoint is on.
- *Why not Prometheus + Grafana?* Those answer "what is the p99"; this answers
  "who do I call and what do I tell them", and it runs where no one will give us
  a Grafana login. It scrapes Zebra's Prometheus endpoint when it exists.
- *What about missed blocks for miners?* Not detectable from the node alone — you
  need the pool's view of which template it was working on. That is a small
  hook on the pool side; proposed, not faked.
- *What's the agent doing?* Optional. With an API key each alert gets a triage
  draft (cause, what to check, regtest repro, message to the operator) shown in
  the dashboard for a human to approve. Nothing is sent by it.
- *Regtest says "initial sync is very slow" — is that a bug?* No: Zebra estimates
  the tip from the wall clock, so on regtest it always believes it is behind. It
  is a real Zebra warning and the sidecar reports it as `sync_stalled` (warning).

## After

```bash
scripts/demo-live.sh down
```
