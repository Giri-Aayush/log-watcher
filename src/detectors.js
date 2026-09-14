const { EventEmitter } = require('events');

// Stateful checks over the log events and RPC samples. Each detector owns one
// alert key: it raises when the condition starts and resolves when it ends, so
// the alert manager can dedupe and the operator gets one page, not fifty.
// Some conditions are moments rather than states (a restart, one big block);
// those are raised with transient=true and never resolved.
//
// Thresholds are in cfg.thresholds; defaults are tuned for a node at tip on
// mainnet/testnet (75s target spacing). On regtest set tipStallMin=0 and
// minPeers=0 or those two will fire immediately, correctly.

const MS = { s: 1000, m: 60000 };

function fmtAge(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 90 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

class Detectors extends EventEmitter {
  constructor(cfg, { now = Date.now } = {}) {
    super();
    this.t = cfg.thresholds;
    this.cfg = cfg;
    this.now = now;
    this.state = {
      tip: { height: null, hash: null, at: null, source: null },
      sync: { state: null, percent: null, remaining: null, at: null },
      peers: null,
      peersLowPolls: 0,
      mempool: null,
      rpc: { ok: null, ms: null, failures: 0, lastError: null, at: null, history: [] },
      peerSummary: null,
      logDelayMs: null,
      node: { version: null, network: null, build: null, subversion: null, errors: null },
      haltHeight: null,
      verify: { p99: null, at: null },
      log: { warnTimes: [], warnCount: 0, errorCount: 0, lastWarnError: null },
      stream: { lastReceivedAt: null, replay: false },
      startedAt: now(),
    };
    this.activeKeys = new Set();
  }

  // Only conditions that were actually raised get resolved, so listeners see
  // one raise and one resolve per incident rather than a resolve on every
  // healthy poll.
  raise(key, severity, title, detail, evidence = {}, extra = {}) {
    if (!extra.transient) this.activeKeys.add(key);
    this.emit('alert', { key, severity, title, detail, evidence, ...extra });
  }

  resolve(key, detail) {
    if (!this.activeKeys.delete(key)) return;
    this.emit('resolve', { key, detail });
  }

  // ---- log-driven ---------------------------------------------------------

  // ctx.replay marks lines older than cfg.replayAgeS (log backfill on startup,
  // `docker logs --tail`): they bring state up to date but must not page —
  // a restart that happened an hour ago is history, not an incident.
  onEvent(ev, ctx = {}) {
    const live = !ctx.replay;
    const now = ctx.replay ? ctx.at : this.now();
    switch (ev.type) {
      case 'block_committed':
        // Zebra re-gossips its restored blocks on startup; those are not new tips.
        if (this.state.tip.height == null || ev.height > this.state.tip.height) {
          this.newTip(ev.height, ev.hash, now, ev.mined ? 'mined' : 'gossip');
        }
        break;

      case 'sync_progress':
        this.state.sync = { state: ev.state, percent: ev.percent, remaining: ev.remaining, at: now };
        if (ev.height != null && (this.state.tip.height == null || ev.height > this.state.tip.height)) {
          this.newTip(ev.height, null, now, 'progress');
        }
        if (!live) break;
        if (ev.state === 'stalled') {
          this.raise('sync_stalled', 'critical', 'Zebra reports chain updates have stalled',
            `zebrad has not committed a block for ${ev.sinceLastBlockS != null ? fmtAge(ev.sinceLastBlockS * 1000) : 'a while'} at height ${ev.height}. Zebra's own hint: check network connectivity and the machine clock.`,
            { height: ev.height, sinceLastBlockS: ev.sinceLastBlockS, syncPercent: ev.percent },
            { suggest: 'getpeerinfo (are there peers?), compare tip with another node/explorer, `date` on the host, then check the log for the peer_set warnings that precede a stall.' });
        } else if (ev.state === 'very_slow') {
          this.raise('sync_stalled', 'warning', 'Initial sync is very slow or the estimated tip is wrong',
            `sync at ${ev.percent}% height ${ev.height}, ${ev.remaining} blocks remaining.`,
            { height: ev.height, remaining: ev.remaining, syncPercent: ev.percent });
        } else if (ev.state === 'at_tip' || ev.state === 'syncing') {
          this.resolve('sync_stalled', `sync progressing: ${ev.state} at height ${ev.height}`);
        }
        break;

      case 'node_started':
        this.state.node.startedAt = now;
        if (!live) break;
        this.raise('node_restarted', 'info', 'zebrad (re)started',
          'The startup banner appeared in the log. Version and network follow in the next lines.',
          {}, { transient: true });
        this.state.rpc.failures = 0;
        break;

      case 'end_of_support':
        this.state.haltHeight = ev.haltHeight;
        if (live) this.checkEndOfSupport();
        break;

      case 'end_of_support_imminent':
        if (!live) break;
        this.raise('end_of_support', 'critical', 'This Zebra release is about to stop running',
          ev.message, { haltHeight: this.state.haltHeight },
          { suggest: 'Upgrade zebrad before the halt height. Zebra refuses to start past it.' });
        break;

      case 'log_warn':
      case 'log_error':
        this.onWarnOrError(ev, now, live);
        break;
    }
  }

  noteLine(replay, receivedAt) {
    this.state.stream = { lastReceivedAt: receivedAt, replay };
  }

  onMeta(meta) {
    Object.assign(this.state.node, meta);
  }

  onWarnOrError(ev, now, live) {
    const { entry } = ev;
    const s = this.state.log;
    s.lastWarnError = { ts: entry.ts, level: entry.level, target: entry.target, message: entry.message, fields: entry.fields };
    if (entry.level === 'ERROR') s.errorCount++; else s.warnCount++;
    if (!live) return;
    s.warnTimes.push(now);
    this.pruneWarnWindow(now);

    if (entry.level === 'ERROR') {
      this.raise('log_error', 'warning', `ERROR in ${entry.target || 'zebrad'}`,
        `${entry.message}${ev.rpcMethod ? ` (during rpc ${ev.rpcMethod})` : ''}`,
        { target: entry.target, fields: entry.fields, rpcMethod: ev.rpcMethod }, { transient: true });
    }
    if (s.warnTimes.length >= this.t.errorBurst) {
      this.raise('error_burst', 'warning', `${s.warnTimes.length} warnings/errors in ${this.t.errorWindowS}s`,
        `Most recent: [${entry.level}] ${entry.target}: ${entry.message}`,
        { count: s.warnTimes.length, windowS: this.t.errorWindowS, last: s.lastWarnError });
    }
  }

  // The window shrinks with time, not only with new input, so a burst that
  // simply stops gets resolved instead of staying active until the next warning.
  pruneWarnWindow(now) {
    const s = this.state.log;
    const windowMs = this.t.errorWindowS * MS.s;
    while (s.warnTimes.length && s.warnTimes[0] < now - windowMs) s.warnTimes.shift();
    if (s.warnTimes.length <= Math.floor(this.t.errorBurst / 2)) this.resolve('error_burst', 'warning rate back to normal');
  }

  // ---- RPC-driven ---------------------------------------------------------

  // sample: { ok, ms, error, blockchain, info, peers, mempool }
  onPoll(sample) {
    const now = this.now();
    const r = this.state.rpc;
    // Last hour at 15s polls. The series is what turns "RPC is slow" into
    // "RPC got slow at 11:42, right after that 1.9 MB block".
    r.history.push({ at: now, ms: sample.ms, ok: sample.ok });
    if (r.history.length > 240) r.history.shift();
    if (!sample.ok) {
      r.ok = false;
      r.failures++;
      r.lastError = { message: sample.error.message, kind: sample.error.kind }; // Error.message is not enumerable
      r.ms = sample.ms;
      r.at = now;
      if (r.failures >= this.t.rpcFailCount) {
        this.raise('rpc_down', 'critical', `RPC unreachable (${r.failures} consecutive failures)`,
          `${sample.error.message}. Panics go to stderr, not the log file, so a dead node looks like silence in the log and a refused connection here.`,
          { failures: r.failures, lastError: sample.error.message, kind: sample.error.kind },
          { suggest: 'Is the process up? `docker ps` / `systemctl status zebrad`; then check stderr / journal for a panic; then rpc.listen_addr and the cookie.' });
      }
      return;
    }

    if (r.ok === false) this.resolve('rpc_down', `RPC back after ${r.failures} failures (${sample.ms}ms)`);
    r.ok = true;
    r.failures = 0;
    r.lastError = null;
    r.ms = sample.ms;
    r.at = now;

    if (sample.ms > this.t.rpcSlowMs) {
      this.raise('rpc_slow', 'warning', `RPC slow: ${sample.ms}ms`,
        `getblockchaininfo took ${sample.ms}ms (threshold ${this.t.rpcSlowMs}ms). Miners see this as getblocktemplate timeouts.`,
        { ms: sample.ms, thresholdMs: this.t.rpcSlowMs });
    } else {
      this.resolve('rpc_slow', `RPC latency ${sample.ms}ms`);
    }

    const bc = sample.blockchain;
    if (bc) {
      // RPC is authoritative in both directions (a restart can come back on a
      // shorter chain); log events only ever move the tip forward.
      const prevHeight = this.state.tip.height;
      if (prevHeight == null || bc.blocks !== prevHeight) {
        this.newTip(bc.blocks, bc.bestblockhash, now, 'rpc');
        if (prevHeight != null && bc.blocks < prevHeight) {
          // Non-finalized blocks live in memory; a SIGKILL or OOM-kill loses
          // them and the node comes back on a shorter chain. A miner on this
          // node just mined on a stale tip.
          this.raise('tip_rewound', 'warning', `Tip went backwards: ${prevHeight} → ${bc.blocks}`,
            `The node reports height ${bc.blocks}; it was ${prevHeight}. After a restart this means the non-finalized state was not backed up (unclean shutdown).`,
            { from: prevHeight, to: bc.blocks, hash: bc.bestblockhash },
            { transient: true, suggest: 'Check how the node stopped (OOM-kill? SIGKILL?) and state.should_backup_non_finalized_state in zebrad.toml.' });
        }
      } else if (!this.state.tip.hash && bc.bestblockhash) {
        this.state.tip.hash = bc.bestblockhash;
      }
      this.state.blockchain = {
        chain: bc.chain, blocks: bc.blocks, headers: bc.headers, estimatedheight: bc.estimatedheight,
        verificationprogress: bc.verificationprogress, sizeOnDisk: bc.size_on_disk,
      };
    }

    if (sample.info) {
      const n = this.state.node;
      const prevBuild = n.build;
      n.build = sample.info.build;
      n.subversion = sample.info.subversion;
      n.network = n.network || (sample.info.testnet ? 'Testnet' : 'Mainnet');
      if (prevBuild && sample.info.build !== prevBuild) {
        this.raise('version_changed', 'info', `zebrad version changed: ${prevBuild} → ${sample.info.build}`, '',
          { from: prevBuild, to: sample.info.build }, { transient: true });
      }
      // getinfo.errors carries the last WARN/ERROR the node logged — a way to
      // see problems even when we have no log access at all.
      if (sample.info.errors && sample.info.errors !== n.errors) {
        n.errors = sample.info.errors;
        if (!/chain tip metrics channel closed/.test(sample.info.errors)) { // benign startup noise
          this.raise('node_reported_error', 'info', 'Node reports a new last error', sample.info.errors,
            { errors: sample.info.errors, at: sample.info.errorstimestamp }, { transient: true });
        }
      }
    }

    if (Array.isArray(sample.peers)) {
      this.state.peers = sample.peers.length;
      this.state.peerSummary = summarizePeers(sample.peers);
      if (sample.peers.length < this.t.minPeers) {
        this.state.peersLowPolls++;
        if (this.state.peersLowPolls >= 2) {
          const sev = sample.peers.length === 0 ? 'critical' : 'warning';
          this.raise('peers_low', sev, `${sample.peers.length} peers (minimum ${this.t.minPeers})`,
            sample.peers.length === 0
              ? 'No peers at all: the node cannot receive blocks. A miner on this node is mining on a stale tip.'
              : 'Few peers means slow block propagation and a higher chance of mining on a stale tip.',
            { peers: sample.peers.length, minPeers: this.t.minPeers },
            { suggest: 'Check outbound connectivity to the DNS seeders, the P2P port (8233/18233) and whether the address book cache is stale.' });
        }
      } else {
        this.state.peersLowPolls = 0;
        this.resolve('peers_low', `${sample.peers.length} peers`);
      }
    }

    if (sample.mempool) {
      this.state.mempool = { size: sample.mempool.size, bytes: sample.mempool.bytes };
      if (this.t.mempoolMax > 0 && sample.mempool.size > this.t.mempoolMax) {
        this.raise('mempool_high', 'warning', `Mempool has ${sample.mempool.size} transactions`,
          `${sample.mempool.size} txs / ${sample.mempool.bytes} bytes (threshold ${this.t.mempoolMax}). Expect bigger, slower-to-verify blocks.`,
          { size: sample.mempool.size, bytes: sample.mempool.bytes });
      } else if (sample.mempool.size < this.t.mempoolMax / 2) {
        this.resolve('mempool_high', `mempool ${sample.mempool.size} txs`);
      }
    }

    this.checkEndOfSupport();
  }

  // Result of getblock(hash, 1) for a block we just saw committed.
  onBlockDetail(block, seenAt) {
    const lagS = block.time ? Math.round(seenAt / 1000 - block.time) : null;
    const txs = block.nTx != null ? block.nTx : Array.isArray(block.tx) ? block.tx.length : null;
    this.state.lastBlock = { height: block.height, hash: block.hash, txs, size: block.size, time: block.time, lagS };
    if (this.t.bigBlockTxs > 0 && (txs > this.t.bigBlockTxs || block.size > this.t.bigBlockBytes)) {
      this.raise('large_block', 'warning', `Large block ${block.height}: ${txs} txs, ${block.size} bytes`,
        'Blocks like this are where verification time blows up (the 7,000-input case). Watch RPC latency on the next few polls.',
        { height: block.height, hash: block.hash, txs, size: block.size }, { transient: true });
    }
    if (this.t.blockLagS > 0 && lagS != null && lagS > this.t.blockLagS) {
      this.raise('block_lag', 'warning', `Block ${block.height} committed ${fmtAge(lagS * 1000)} after its timestamp`,
        'Time between the block header timestamp and this node committing it. Sustained lag means slow propagation or slow verification on this node (or a skewed clock).',
        { height: block.height, lagS, txs, size: block.size }, { transient: true });
    }
  }

  onMetrics({ p99, family }) {
    this.state.verify = { p99, at: this.now(), family };
    if (p99 != null && p99 > this.cfg.metrics.p99WarnS) {
      this.raise('verify_slow', 'warning', `Verification p99 ${p99.toFixed(2)}s`,
        `${family} p99 over the last scrape interval is above ${this.cfg.metrics.p99WarnS}s.`,
        { p99, family });
    } else if (p99 != null) {
      this.resolve('verify_slow', `verification p99 ${p99.toFixed(2)}s`);
    }
  }

  // ---- time-driven --------------------------------------------------------

  tick() {
    const now = this.now();
    this.pruneWarnWindow(now);
    const tip = this.state.tip;
    if (tip.at == null || this.t.tipStallMin <= 0) return;
    const syncing = this.state.sync.state === 'syncing' && this.state.sync.remaining > 0;
    if (syncing) return; // initial sync has its own detector
    // Old lines still arriving means we are mid-backfill: the tip we hold is
    // stale because we have not read up to the present yet, not because the
    // node stopped. Judge staleness once the stream has caught up.
    const st = this.state.stream;
    if (st.replay && st.lastReceivedAt != null && now - st.lastReceivedAt < 3000) return;
    const age = now - tip.at;
    if (age > this.t.tipStallMin * MS.m) {
      this.raise('tip_stalled', 'critical', `No new block for ${fmtAge(age)}`,
        `Tip is still ${tip.height} (last seen via ${tip.source}). Target spacing is 75s; ${this.t.tipStallMin}m without a block means this node stopped receiving them, or the network did.`,
        { height: tip.height, hash: tip.hash, ageS: Math.round(age / 1000), peers: this.state.peers },
        { suggest: 'Compare height with a public explorer or a second node. If they moved on, this node is partitioned (peers?) or stuck verifying; if not, it is the network.' });
    }
  }

  newTip(height, hash, now, source) {
    const prev = this.state.tip;
    const stalled = prev.at != null && now - prev.at > this.t.tipStallMin * MS.m && this.t.tipStallMin > 0;
    this.state.tip = { height, hash: hash || (height === prev.height ? prev.hash : null), at: now, source };
    if (stalled) this.resolve('tip_stalled', `new block ${height} after ${fmtAge(now - prev.at)}`);
    this.checkEndOfSupport();
  }

  checkEndOfSupport() {
    const { haltHeight, tip } = this.state;
    if (!haltHeight || tip.height == null) return;
    const left = haltHeight - tip.height;
    if (left <= this.t.eosWarnBlocks) {
      const days = (left * 75) / 86400;
      this.raise('end_of_support', left <= 0 ? 'critical' : 'warning',
        `zebrad end-of-support in ${left} blocks (~${days.toFixed(1)} days)`,
        `This release halts at height ${haltHeight}; tip is ${tip.height}.`,
        { haltHeight, height: tip.height, blocksLeft: left },
        { suggest: 'Schedule the upgrade now. Zebra panics at the halt height and will not restart.' });
    }
  }
}

// getpeerinfo entries are { addr, inbound } on Zebra; keep whatever is there.
function summarizePeers(peers) {
  const out = { total: peers.length, inbound: 0, outbound: 0 };
  for (const p of peers) {
    if (p.inbound === true) out.inbound++;
    else if (p.inbound === false) out.outbound++;
  }
  return out;
}

module.exports = { Detectors, fmtAge, summarizePeers };
