const os = require('os');
const { EventEmitter } = require('events');
const { Ring } = require('./ring');
const { makeSource } = require('./sources');
const { parseLine } = require('./zebra/parse');
const { toEvents, metaFromContinuation } = require('./zebra/events');
const { ZebraRpc } = require('./zebra/rpc');
const metrics = require('./zebra/metrics');
const { Detectors } = require('./detectors');
const { AlertManager } = require('./alerts');
const { buildSinks } = require('./sinks');
const { makeTriage } = require('./triage');
const { Outbox } = require('./outbox');

// log source ─┐
//             ├─> parse ─> events ─> Detectors ─> AlertManager ─> sinks
// RPC poll  ──┘                         │
// metrics  ───────────────────────────────┘
//
// Everything observable hangs off `bus` so the dashboard, the tests and the
// regtest harness all see the same stream without touching internals.
function createPipeline(cfg, { now = Date.now, sinks, source } = {}) {
  const bus = new EventEmitter();
  const logRing = new Ring(cfg.ringSize);
  const eventRing = new Ring(200);
  const counters = { lines: 0, events: 0, polls: 0, pages: 0 };
  const outbox = new Outbox({ url: cfg.sinks.webhookUrl, now });
  outbox.on('failing', (why) => bus.emit('error', new Error(`collector unreachable (${why}); queueing`)));
  outbox.on('recovered', (n) => bus.emit('notice', `collector back after ${n} failed attempts; queue flushed`));
  const detectors = new Detectors(cfg, { now });
  const rpc = new ZebraRpc(cfg.rpc);
  const triage = cfg.triage.apiKey ? makeTriage(cfg.triage) : null;
  const alerts = new AlertManager({
    cfg: { ...cfg.alerts, label: cfg.label },
    sinks: sinks || buildSinks(cfg.sinks, { outbox, label: cfg.label, share: cfg.share }),
    logRing,
    getState: () => detectors.state,
    getSidecar: sidecarInfo,
    now,
    triage,
  });

  function sidecarInfo() {
    return {
      version: require('../package.json').version,
      host: os.hostname(),
      pid: process.pid,
      source: sourceLabel(),
      rpcUrl: cfg.rpc.url,
      thresholds: cfg.thresholds,
      startedAt: detectors.state.startedAt,
    };
  }

  detectors.on('alert', (a) => alerts.raise(a));
  detectors.on('resolve', (r) => alerts.resolve(r));
  for (const ev of ['alert', 'update', 'resolve']) alerts.on(ev, (a) => bus.emit(ev, a));
  alerts.on('alert', () => { counters.pages++; });
  alerts.on('resolve', () => { counters.pages++; });
  alerts.on('error', (err) => bus.emit('error', err));

  let lastEntry = null;
  let lastDetailHeight = null;
  // After a source reattaches (docker logs -f ends when the container
  // restarts; we come back with --tail N) the first lines are ones we have
  // already seen. Skip everything up to the last timestamp we ingested.
  let skipUntil = 0;
  let skippingContinuations = false;

  function ingestLine(raw) {
    if (!raw) return;
    const parsed = parseLine(raw);
    if (parsed.kind === 'continuation') {
      if (skippingContinuations) return;
      if (lastEntry) {
        lastEntry.raw += `\n${parsed.text}`;
        lastEntry.message += `\n${parsed.text}`;
      }
      const meta = metaFromContinuation(parsed.text);
      if (meta) {
        detectors.onMeta(meta);
        bus.emit('state');
      }
      return;
    }
    if (skipUntil && parsed.time <= skipUntil) {
      skippingContinuations = true;
      return;
    }
    skipUntil = 0;
    skippingContinuations = false;
    lastEntry = parsed;
    counters.lines++;
    // Node time vs. our time: a growing gap means the log stream itself is
    // lagging (docker daemon under pressure, slow disk), which is a symptom.
    parsed.receivedAt = now();
    detectors.state.logDelayMs = parsed.receivedAt - parsed.time;
    logRing.push(parsed);
    bus.emit('log', parsed);
    // Old lines (startup backfill, `docker logs --tail`) update state but do
    // not page. Timestamp-based so it works the same for every source.
    const replay = parsed.time < now() - cfg.replayAgeS * 1000;
    detectors.noteLine(replay, parsed.receivedAt);
    for (const ev of toEvents(parsed)) {
      detectors.onEvent(ev, { replay, at: parsed.time });
      const shown = describeEvent(ev, parsed, replay);
      eventRing.push(shown);
      counters.events++;
      bus.emit('event', shown);
      if (ev.type === 'block_committed' && !replay) blockDetail(ev);
    }
    bus.emit('state');
  }

  // One line per semantic event for the dashboard's flow panel: what the
  // parser made of a log line, before the detectors decided anything.
  function describeEvent(ev, entry, replay) {
    const d = { type: ev.type, at: entry.time, receivedAt: entry.receivedAt, replay, text: '' };
    switch (ev.type) {
      case 'block_committed': d.text = `block ${ev.height}${ev.mined ? ' (mined here)' : ''} ${ev.hash ? ev.hash.slice(0, 12) + '…' : ''}`; break;
      case 'sync_progress': d.text = `${ev.state}${ev.percent != null ? ` ${ev.percent}%` : ''}${ev.height != null ? ` @ ${ev.height}` : ''}${ev.remaining ? `, ${ev.remaining} left` : ''}`; break;
      case 'node_started': d.text = 'startup banner'; break;
      case 'end_of_support': d.text = `halts at ${ev.haltHeight}`; break;
      case 'log_warn': case 'log_error': d.text = `${entry.target}: ${entry.message.slice(0, 90)}`; break;
      default: d.text = ev.message || '';
    }
    return d;
  }

  async function blockDetail(ev) {
    if (!cfg.rpc.blockDetail || cfg.rpc.pollMs <= 0 || ev.height == null || ev.height === lastDetailHeight) return;
    lastDetailHeight = ev.height;
    const seenAt = now();
    try {
      const { result } = await rpc.getBlock(ev.hash || ev.height, 1);
      detectors.onBlockDetail(result, seenAt);
      bus.emit('state');
    } catch (err) {
      bus.emit('error', err); // detail is best-effort; the poll loop owns RPC health
    }
  }

  // getblockchaininfo is the liveness/latency probe. The others are extra
  // context and must not flip RPC to "down" if one of them is missing on an
  // older release.
  async function poll() {
    counters.polls++;
    const sample = { ok: false, ms: null, error: null };
    try {
      const { result, ms } = await rpc.getBlockchainInfo();
      sample.ok = true;
      sample.ms = ms;
      sample.blockchain = result;
    } catch (err) {
      sample.error = err;
      sample.ms = err.ms;
      detectors.onPoll(sample);
      bus.emit('state');
      return sample;
    }
    const extras = await Promise.allSettled([rpc.getInfo(), rpc.getPeerInfo(), rpc.getMempoolInfo()]);
    const [info, peers, mempool] = extras.map((r) => (r.status === 'fulfilled' ? r.value.result : null));
    sample.info = info;
    sample.peers = peers;
    sample.mempool = mempool;
    detectors.onPoll(sample);
    bus.emit('state');
    return sample;
  }

  // One small POST per interval to the collector (when there is one). This is
  // what lets a fleet view answer "when did this start" and notice a sidecar
  // that went quiet.
  function heartbeat() {
    if (!cfg.sinks.webhookUrl || !cfg.alerts.heartbeat) return;
    const s = detectors.state;
    const body = {
      phase: 'HEARTBEAT',
      label: cfg.label,
      at: now(),
      sidecar: sidecarInfo(),
      node: s.node,
      tip: s.tip,
      peers: s.peers,
      rpc: { ok: s.rpc.ok, ms: s.rpc.ms, failures: s.rpc.failures },
      gbt: cfg.rpc.gbtPollMs > 0 ? { ok: s.gbt.ok, ms: s.gbt.ms, height: s.gbt.height, txs: s.gbt.txs } : null,
      mempool: s.mempool,
      sync: s.sync,
      logDelayMs: s.logDelayMs,
      activeAlerts: alerts.list().active.map((a) => ({ key: a.key, severity: a.severity, since: a.firstSeen })),
    };
    outbox.push(body);
  }

  async function pollGbt() {
    counters.polls++;
    try {
      const { result, ms } = await rpc.getBlockTemplate();
      detectors.onGbt({ ok: true, ms, result });
    } catch (err) {
      detectors.onGbt({ ok: false, ms: err.ms, error: err });
    }
    bus.emit('state');
  }

  let prevBuckets = null;
  async function pollMetrics() {
    if (!cfg.metrics.url) return;
    try {
      const fam = cfg.metrics.family;
      const families = await metrics.scrape(cfg.metrics.url, new Set([fam]));
      const cur = metrics.buckets(families, fam);
      const delta = metrics.histogramDelta(cur, prevBuckets);
      prevBuckets = cur;
      if (!delta || !delta.all) return;
      detectors.onMetrics({ p99: metrics.quantile(delta.all, 0.99), family: fam });
      bus.emit('state');
    } catch (err) {
      bus.emit('error', err);
    }
  }

  const src = source || makeSource(cfg);
  src.on('line', ingestLine);
  src.on('error', (err) => bus.emit('error', err));
  src.on('exit', (info) => {
    if (lastEntry) skipUntil = lastEntry.time;
    bus.emit('source_exit', info);
  });
  src.on('rotate', (info) => bus.emit('source_rotate', info));

  const timers = [];
  function start() {
    if (typeof src.start === 'function') src.start();
    // pollMs = 0 means logs only: no RPC access, tip/sync/errors still come
    // from the log stream and rpc_* detectors stay silent.
    if (cfg.rpc.pollMs > 0) {
      poll();
      timers.push(setInterval(poll, cfg.rpc.pollMs));
    }
    if (cfg.rpc.gbtPollMs > 0) {
      pollGbt();
      timers.push(setInterval(pollGbt, cfg.rpc.gbtPollMs));
    }
    const beat = cfg.rpc.pollMs > 0 ? cfg.rpc.pollMs : 15000;
    timers.push(setInterval(() => detectors.tick(), Math.min(beat, 10000)));
    timers.push(setInterval(heartbeat, beat));
    if (cfg.metrics.url) {
      pollMetrics();
      timers.push(setInterval(pollMetrics, cfg.metrics.pollMs));
    }
  }

  function stop() {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
    outbox.stop();
    if (typeof src.stop === 'function') src.stop();
  }

  function sourceLabel() {
    switch (cfg.source) {
      case 'file': return `file ${cfg.logFile}`;
      case 'docker': return `docker ${cfg.container}`;
      case 'journald': return `journald ${cfg.unit}`;
      case 'command': return cfg.command;
      default: return 'rpc only';
    }
  }

  function snapshot(logLines = 300) {
    return {
      label: cfg.label,
      source: sourceLabel(),
      rpcUrl: cfg.rpc.url,
      thresholds: cfg.thresholds,
      state: detectors.state,
      alerts: alerts.list(),
      logs: logRing.last(logLines),
      events: eventRing.last(logLines ? 60 : 0),
      counters: { ...counters, delivery: cfg.sinks.webhookUrl ? outbox.stats : null },
      startedAt: detectors.state.startedAt,
    };
  }

  return { cfg, bus, logRing, detectors, alerts, rpc, outbox, source: src, ingestLine, poll, pollGbt, pollMetrics, start, stop, snapshot };
}

module.exports = { createPipeline };
