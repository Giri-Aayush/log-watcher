const fs = require('fs');
const path = require('path');
const express = require('express');
const { incidentReport } = require('./report');
const { makeIncidentTriage, makeCliTriage, triageBackend } = require('./triage');
const kb = require('./knowledge');

// The Zero-side end of the sidecar's webhook, and the incident record.
//
// Sidecars POST heartbeats (every poll) and alerts (with bundles). This keeps
// an incident per stateful alert with the timestamps the response metrics
// are built from:
//
//   onsetAt     the condition began (detector's best estimate, sidecar clock)
//   pagedAt     the sidecar paged                       -> MTTD = pagedAt - onsetAt
//   ackedAt     an engineer acknowledged, here          -> MTTA = ackedAt - pagedAt
//   respondedAt the operator was told something         -> MTTResp = respondedAt - pagedAt
//   resolvedAt  the condition cleared (or closed by hand) -> MTTR = resolvedAt - onsetAt
//
// Heartbeats become a 24h series per node (tip, peers, RPC latency, mempool,
// log lag), which is what the charts and the availability number read from.
// Everything is JSON on disk under `dir`; a restart reloads it.

const WINDOWS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
const SERIES_KEEP_MS = 7 * 86400e3;
const SERIES_MAX = 60000;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

function stats(values) {
  const v = values.filter((x) => typeof x === 'number' && x >= 0).sort((a, b) => a - b);
  if (!v.length) return { count: 0, mean: null, p50: null, p95: null, max: null };
  return { count: v.length, mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length), p50: percentile(v, 0.5), p95: percentile(v, 0.95), max: v[v.length - 1] };
}

class Store {
  constructor(dir, { now = Date.now, quietMs = 60000 } = {}) {
    this.dir = dir;
    this.now = now;
    this.quietMs = quietMs;
    this.nodes = new Map();
    this.incidents = new Map();
    this.series = new Map();
    this.knownIssues = new Map();
    this.listeners = new Set();
    fs.mkdirSync(path.join(dir, 'bundles'), { recursive: true });
    this.load();
  }

  load() {
    try {
      for (const n of JSON.parse(fs.readFileSync(path.join(this.dir, 'nodes.json'), 'utf8'))) this.nodes.set(n.label, { ...n, heartbeat: null, quiet: false });
    } catch { /* first run */ }
    try {
      for (const inc of JSON.parse(fs.readFileSync(path.join(this.dir, 'incidents.json'), 'utf8'))) this.incidents.set(inc.id, inc);
    } catch { /* first run */ }
    try {
      for (const ki of JSON.parse(fs.readFileSync(path.join(this.dir, 'known-issues.json'), 'utf8'))) this.knownIssues.set(ki.id, ki);
    } catch { /* first run */ }
    try {
      for (const [label, samples] of Object.entries(JSON.parse(fs.readFileSync(path.join(this.dir, 'series.json'), 'utf8')))) this.series.set(label, samples);
    } catch { /* first run */ }
  }

  // Writes are coalesced: one heartbeat per node per poll would otherwise
  // rewrite the file several times a second on a busy fleet.
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 500);
    this.saveTimer.unref?.();
  }

  flush() {
    clearTimeout(this.saveTimer);
    const nodes = [...this.nodes.values()].map(({ heartbeat, quiet, ...rest }) => rest); // heartbeat is transient
    fs.writeFileSync(path.join(this.dir, 'nodes.json'), JSON.stringify(nodes));
    fs.writeFileSync(path.join(this.dir, 'incidents.json'), JSON.stringify([...this.incidents.values()]));
    fs.writeFileSync(path.join(this.dir, 'known-issues.json'), JSON.stringify([...this.knownIssues.values()]));
    fs.writeFileSync(path.join(this.dir, 'series.json'), JSON.stringify(Object.fromEntries(this.series)));
  }

  emit(type, payload) {
    for (const fn of this.listeners) fn(type, payload);
  }

  node(label) {
    let n = this.nodes.get(label);
    if (!n) {
      n = { label, firstSeen: this.now(), lastSeen: 0, lastSeq: 0, sidecarStartedAt: null, skewMs: null, network: null, heartbeat: null, quiet: false };
      this.nodes.set(label, n);
    }
    return n;
  }

  // Messages carry a per-sidecar-process sequence number. A retry after a
  // request that did land arrives with the same seq and is dropped; a
  // restarted sidecar starts again from 1, recognisable by its startedAt.
  ingest(msg) {
    const now = this.now();
    const label = msg.label || (msg.bundle && msg.bundle.label) || 'unknown';
    const n = this.node(label);
    const startedAt = msg.sidecar ? msg.sidecar.startedAt : (msg.bundle && msg.bundle.sidecar ? msg.bundle.sidecar.startedAt : null);
    if (typeof msg.seq === 'number') {
      if (startedAt && startedAt !== n.sidecarStartedAt) {
        n.sidecarStartedAt = startedAt;
        n.lastSeq = 0;
      }
      if (msg.seq <= n.lastSeq) return { duplicate: true, seq: msg.seq };
      n.lastSeq = msg.seq;
    }
    if (typeof msg.sentAt === 'number') n.skewMs = now - msg.sentAt; // includes network latency; large values mean clocks
    n.lastSeen = now;
    if (n.quiet) {
      n.quiet = false;
      this.emit('node', { label, event: 'recovered' });
    }
    if (msg.phase === 'HEARTBEAT') return this.heartbeat(n, msg);
    if (msg.alert) return this.alertMessage(n, msg, now);
    return null;
  }

  heartbeat(n, msg) {
    n.heartbeat = msg;
    if (msg.node && msg.node.network) n.network = msg.node.network;
    this.reconcileAfterRestart(n, msg);
    const sample = {
      at: this.now(),
      tip: msg.tip ? msg.tip.height : null,
      tipAgeS: msg.tip && msg.tip.at ? Math.round((msg.at - msg.tip.at) / 1000) : null,
      peers: msg.peers ?? null,
      rpcMs: msg.rpc ? msg.rpc.ms : null,
      rpcOk: msg.rpc ? msg.rpc.ok : null,
      mempool: msg.mempool ? msg.mempool.size : null,
      logDelayMs: msg.logDelayMs ?? null,
      critical: (msg.activeAlerts || []).filter((a) => a.severity === 'critical').length,
      warning: (msg.activeAlerts || []).filter((a) => a.severity === 'warning').length,
    };
    const arr = this.series.get(n.label) || [];
    arr.push(sample);
    const cutoff = sample.at - SERIES_KEEP_MS;
    while (arr.length > SERIES_MAX || (arr.length && arr[0].at < cutoff)) arr.shift();
    this.series.set(n.label, arr);
    this.save();
    this.emit('heartbeat', { label: n.label, sample });
    return sample;
  }

  alertMessage(n, msg, now) {
    const a = msg.alert;
    let inc = this.incidents.get(a.id);
    if (!inc) {
      inc = {
        id: a.id, label: n.label, key: a.key, severity: a.severity, title: a.title, detail: a.detail,
        evidence: a.evidence || {}, suggest: a.suggest || null, transient: !!a.transient,
        onsetAt: a.onsetAt || a.firstSeen, pagedAt: a.firstSeen, receivedAt: now,
        ackedAt: null, ackedBy: null, respondedAt: null, respondedBy: null,
        resolvedAt: null, resolvedDetail: null, closedBy: null,
        escalations: 0, renotified: 0, notes: [], updates: [],
        bundleFile: null,
        sidecarStartedAt: (msg.bundle && msg.bundle.sidecar && msg.bundle.sidecar.startedAt) || n.sidecarStartedAt || null,
      };
      // moments (a restart, one big block) are recorded but are not open incidents
      if (inc.transient) inc.resolvedAt = inc.pagedAt;
      this.incidents.set(inc.id, inc);
    }
    // A NEW for an incident we already have is the same condition re-raised
    // by a restarted sidecar (ids are stable across restarts); reopen if a
    // reconcile had closed it meanwhile.
    const reraised = msg.phase === 'NEW' && inc.updates.length > 0;
    if (reraised && inc.resolvedAt && !inc.closedBy) { inc.resolvedAt = null; inc.resolvedDetail = null; }
    inc.updates.push({ phase: reraised ? 'RE-RAISED' : msg.phase, at: now, severity: a.severity, count: a.count });
    if (reraised) inc.sidecarStartedAt = (msg.bundle && msg.bundle.sidecar && msg.bundle.sidecar.startedAt) || n.sidecarStartedAt || inc.sidecarStartedAt;
    if (msg.phase === 'ESCALATED') inc.escalations++;
    if (msg.phase === 'STILL ACTIVE') inc.renotified++;
    inc.severity = a.severity;
    inc.title = a.title;
    inc.detail = a.detail;
    inc.evidence = a.evidence || inc.evidence;
    if (msg.phase === 'RESOLVED' && a.resolved) {
      inc.resolvedAt = a.resolved.at;
      inc.resolvedDetail = a.resolved.detail || null;
    }
    if (msg.bundle) {
      const dir = path.join(this.dir, 'bundles', n.label.replace(/[^\w.-]/g, '_'));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${a.id}.${msg.phase.toLowerCase().replace(/\s+/g, '-')}.json`);
      fs.writeFileSync(file, JSON.stringify(msg.bundle, null, 2));
      if (msg.phase === 'NEW' || !inc.bundleFile) inc.bundleFile = path.relative(this.dir, file);
      inc.latestBundleFile = path.relative(this.dir, file);
    }
    if (msg.bundle && msg.bundle.node && msg.bundle.node.network) n.network = msg.bundle.node.network;
    if (msg.phase === 'NEW') this.matchKnownIssues(inc, msg.bundle);
    this.correlate(inc.key, n.network);
    this.save();
    this.emit('incident', inc);
    return inc;
  }

  // A sidecar that restarted does not remember the incidents its previous
  // process raised. Its heartbeat says what is active now; anything this node
  // has open from before the restart that the new process has not re-raised
  // is closed as unconfirmed — the condition may well be gone, and if it is
  // not, the new process will raise it again on the same id.
  reconcileAfterRestart(n, msg) {
    const startedAt = msg.sidecar && msg.sidecar.startedAt;
    if (!startedAt || !Array.isArray(msg.activeAlerts)) return;
    const activeKeys = new Set(msg.activeAlerts.map((a) => a.key));
    const mine = [...this.incidents.values()].filter((i) => i.label === n.label && !i.transient && !i.resolvedAt);
    let changed = false;
    for (const inc of mine) {
      const raisedBy = inc.sidecarStartedAt || 0;
      if (raisedBy >= startedAt) continue; // raised by the current process
      let why = null;
      if (!activeKeys.has(inc.key)) why = 'sidecar restarted and did not re-raise this';
      else if (mine.some((o) => o !== inc && o.key === inc.key && (o.sidecarStartedAt || 0) >= startedAt)) why = 'superseded by the same condition re-raised after a sidecar restart';
      if (!why) continue;
      inc.resolvedAt = this.now();
      inc.resolvedDetail = why;
      inc.updates.push({ phase: 'RESOLVED', at: this.now(), by: 'reconcile' });
      this.correlate(inc.key, n.network);
      changed = true;
      this.emit('incident', inc);
    }
    if (changed) this.save();
  }

  // ---- fleet correlation -------------------------------------------------
  //
  // If most nodes on a network report the same thing at the same time, it is
  // the network, not the customers. The per-node incidents stay on record but
  // are marked suppressed (not open, not unacknowledged, not paged again),
  // and one incident for the network is opened in their place. When enough
  // of them clear, the network incident resolves and any still-open members
  // become ordinary incidents again.

  static get CORRELATED_KEYS() { return ['tip_stalled', 'sync_stalled']; }

  correlate(key, network) {
    if (!Store.CORRELATED_KEYS.includes(key) || !network) return;
    const nodes = [...this.nodes.values()].filter((n) => n.network === network);
    // Only critical per-node stalls are evidence of a network event. Zebra's
    // "initial sync is very slow" warning, for one, fires on every regtest
    // node forever and says nothing about the network.
    const affected = [...this.incidents.values()].filter((i) => i.key === key && i.severity === 'critical' && !i.resolvedAt && !i.transient && this.nodes.get(i.label) && this.nodes.get(i.label).network === network);
    const affectedLabels = new Set(affected.map((i) => i.label));
    const netId = `network-${network}-${key}`;
    let net = [...this.incidents.values()].find((i) => i.correlationId === netId && !i.resolvedAt);
    const enough = nodes.length >= 2 && affectedLabels.size >= 2 && affectedLabels.size / nodes.length >= 0.5;
    const now = this.now();

    if (enough) {
      if (!net) {
        net = {
          id: `${netId}-${now}`, correlationId: netId, label: `network:${network}`, key: `network_${key}`, severity: 'critical',
          title: '', detail: '', evidence: { key, network, nodes: [] }, suggest: 'Check a public explorer and the other Zero nodes before contacting any customer: if the chain itself has stopped, the message to operators is different.',
          transient: false, onsetAt: Math.min(...affected.map((i) => i.onsetAt)), pagedAt: now, receivedAt: now,
          ackedAt: null, ackedBy: null, respondedAt: null, respondedBy: null, resolvedAt: null, resolvedDetail: null, closedBy: null,
          escalations: 0, renotified: 0, notes: [], updates: [{ phase: 'NEW', at: now }], bundleFile: null, members: [],
        };
        this.incidents.set(net.id, net);
      }
      net.members = affected.map((i) => i.id);
      net.evidence = { key, network, nodes: [...affectedLabels].sort(), of: nodes.length };
      net.title = `${key.replace('_', ' ')} on ${affectedLabels.size} of ${nodes.length} ${network} nodes`;
      net.detail = `${[...affectedLabels].sort().join(', ')} report ${key} together. That is the network (or Zero's view of it), not ${affectedLabels.size} separate customer problems.`;
      for (const i of affected) {
        if (!i.suppressedBy) { i.suppressedBy = net.id; i.updates.push({ phase: 'SUPPRESSED', at: now, by: net.id }); }
      }
      this.emit('incident', net);
    } else if (net) {
      net.resolvedAt = now;
      net.resolvedDetail = `${affectedLabels.size} of ${nodes.length} nodes still affected; below the correlation threshold`;
      net.updates.push({ phase: 'RESOLVED', at: now });
      for (const id of net.members) {
        const i = this.incidents.get(id);
        if (i && i.suppressedBy === net.id) { i.suppressedBy = null; i.updates.push({ phase: 'UNSUPPRESSED', at: now }); }
      }
      this.emit('incident', net);
    }
  }

  // Everything the analysis should see, trimmed: the incident, the page-time
  // bundle (logs already filtered by the sidecar's share policy), the other
  // nodes on the same network right now, this node's recent history, and the
  // last hour of heartbeats summarised.
  triageContext(inc) {
    const now = this.now();
    let bundle = null;
    try { bundle = JSON.parse(fs.readFileSync(path.join(this.dir, inc.bundleFile), 'utf8')); } catch { /* network incident */ }
    const node = this.nodes.get(inc.label);
    const network = node && node.network;
    const fleet = this.fleet().filter((n) => n.label !== inc.label && (!network || n.network === network)).map((n) => ({
      label: n.label, state: n.state, tip: n.tip && n.tip.height, tipAgeS: n.tipAgeS, peers: n.peers,
      rpcMs: n.rpc && n.rpc.ms, rpcOk: n.rpc && n.rpc.ok, open: n.open.map((o) => o.key),
    }));
    const history = [...this.incidents.values()]
      .filter((i) => i.label === inc.label && i.id !== inc.id && !i.transient)
      .sort((a, b) => b.pagedAt - a.pagedAt).slice(0, 10)
      .map((i) => ({ key: i.key, severity: i.severity, pagedAt: new Date(i.pagedAt).toISOString(), resolved: !!i.resolvedAt, resolvedDetail: i.resolvedDetail, closedBy: i.closedBy }));
    const hour = this.seriesFor(inc.label, { windowMs: 3600e3 });
    const ms = hour.map((s) => s.rpcMs).filter((x) => typeof x === 'number').sort((a, b) => a - b);
    const series = hour.length ? {
      samples: hour.length,
      rpcP95Ms: ms.length ? ms[Math.min(ms.length - 1, Math.ceil(0.95 * ms.length) - 1)] : null,
      rpcFailures: hour.filter((s) => s.rpcOk === false).length,
      tipAgeMaxS: Math.max(...hour.map((s) => s.tipAgeS ?? 0)),
      peersMin: Math.min(...hour.map((s) => s.peers ?? Infinity)),
      mempoolMax: Math.max(...hour.map((s) => s.mempool ?? 0)),
    } : null;
    const { notes, updates, ...rest } = inc;
    return {
      now: new Date(now).toISOString(),
      incident: { ...rest, onsetAt: new Date(inc.onsetAt).toISOString(), pagedAt: new Date(inc.pagedAt).toISOString(), ackedAt: inc.ackedAt && new Date(inc.ackedAt).toISOString(), resolvedAt: inc.resolvedAt && new Date(inc.resolvedAt).toISOString(), engineerNotes: notes.filter((n) => n.text).map((n) => `${n.action} by ${n.by}: ${n.text}`) },
      bundle: bundle && {
        node: bundle.node, tip: bundle.tip, sync: bundle.sync, peers: bundle.peers, peerSummary: bundle.peerSummary, mempool: bundle.mempool,
        rpc: bundle.rpc && { ok: bundle.rpc.ok, ms: bundle.rpc.ms, failures: bundle.rpc.failures, lastError: bundle.rpc.lastError },
        gbt: bundle.gbt, lastBlock: bundle.lastBlock, logDelayMs: bundle.logDelayMs, sidecar: bundle.sidecar && { version: bundle.sidecar.version, source: bundle.sidecar.source, thresholds: bundle.sidecar.thresholds },
        share: bundle.share, logs: (bundle.logs || []).slice(-25),
      },
      network, otherNodesOnNetwork: fleet, recentHistory: history, lastHour: series,
      knownIssues: (inc.knownIssues || []).map((id) => this.knownIssues.get(id)).filter(Boolean).map((ki) => ({ title: ki.title, cause: ki.cause, fix: ki.fix, workaround: ki.workaround, status: ki.status, seen: ki.occurrences.length })),
    };
  }

  // ---- knowledge base ------------------------------------------------------

  readBundle(inc) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, inc.bundleFile), 'utf8')); } catch { return null; }
  }

  matchKnownIssues(inc, bundle = undefined) {
    const b = bundle === undefined ? this.readBundle(inc) : bundle;
    const hits = [...this.knownIssues.values()].filter((ki) => ki.status !== 'retired' && kb.matches(ki, inc, b));
    inc.knownIssues = hits.map((ki) => ki.id);
    for (const ki of hits) {
      if (!ki.occurrences.some((o) => o.incidentId === inc.id)) {
        ki.occurrences.push({ incidentId: inc.id, label: inc.label, at: inc.pagedAt, resolvedAt: inc.resolvedAt || null });
        ki.updatedAt = this.now();
      }
    }
    return hits;
  }

  promoteToKnownIssue(inc, { by = 'unknown' } = {}) {
    const issue = kb.draftFromIncident(inc, this.readBundle(inc), { by, now: this.now() });
    this.knownIssues.set(issue.id, issue);
    inc.knownIssues = [...new Set([...(inc.knownIssues || []), issue.id])];
    inc.notes.push({ at: this.now(), by, action: 'promote', text: issue.id });
    this.save();
    this.emit('incident', inc);
    return issue;
  }

  updateKnownIssue(id, patch, { by = 'unknown' } = {}) {
    const issue = this.knownIssues.get(id);
    if (!issue) return null;
    for (const k of kb.EDITABLE) if (patch[k] !== undefined) issue[k] = patch[k];
    issue.updatedAt = this.now();
    issue.updatedBy = by;
    // the signature may have changed: re-match open incidents
    for (const inc of this.incidents.values()) if (!inc.resolvedAt && !inc.transient) this.matchKnownIssues(inc);
    this.save();
    return issue;
  }

  listKnownIssues({ q = '' } = {}) {
    const needle = q.trim().toLowerCase();
    return [...this.knownIssues.values()]
      .filter((ki) => !needle || [ki.title, ki.key, ki.cause, ki.fix, ki.network, ...(ki.versions || [])].join(' ').toLowerCase().includes(needle))
      .map((ki) => ({ ...ki, seen: ki.occurrences.length, nodes: new Set(ki.occurrences.map((o) => o.label)).size, lastSeen: Math.max(0, ...ki.occurrences.map((o) => o.at)) }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  // which zebrad versions the fleet runs, and where — the upgrade-outreach list
  versions() {
    const out = {};
    for (const n of this.nodes.values()) {
      const h = n.heartbeat;
      const build = h && h.node && (h.node.build || h.node.version);
      if (!build) continue;
      (out[build] ||= []).push({ label: n.label, network: n.network, quiet: n.quiet });
    }
    return Object.entries(out).sort((a, b) => b[1].length - a[1].length).map(([build, nodes]) => ({ build, count: nodes.length, nodes }));
  }

  act(id, action, { by = 'unknown', text = null } = {}) {
    const inc = this.incidents.get(id);
    if (!inc) return null;
    const now = this.now();
    switch (action) {
      case 'ack':
        if (!inc.ackedAt) { inc.ackedAt = now; inc.ackedBy = by; }
        break;
      case 'respond':
        if (!inc.ackedAt) { inc.ackedAt = now; inc.ackedBy = by; }
        if (!inc.respondedAt) { inc.respondedAt = now; inc.respondedBy = by; }
        break;
      case 'close':
        if (!inc.resolvedAt) { inc.resolvedAt = now; inc.closedBy = by; inc.resolvedDetail = text || 'closed by hand'; }
        break;
      case 'note':
        break;
      case 'report':
        inc.reportSentAt = now;
        inc.reportSentBy = by;
        break;
      case 'triage':
        break;
      // The JD's third bullet, as a field: what changed in Zero because of this
      // incident — a detector, a threshold, a runbook line, an upstream PR.
      case 'improvement':
        if (!text) throw new Error('an improvement needs text');
        inc.improvements = inc.improvements || [];
        inc.improvements.push({ at: now, by, text });
        break;
      case 'promote':
        break;
      default:
        throw new Error(`unknown action ${action}`);
    }
    if (text) inc.notes.push({ at: now, by, action, text });
    else inc.notes.push({ at: now, by, action });
    this.save();
    this.emit('incident', inc);
    return inc;
  }

  // Dead man's switch: no heartbeat is the one thing a sidecar cannot report.
  sweepQuiet() {
    const now = this.now();
    for (const n of this.nodes.values()) {
      if (!n.quiet && n.lastSeen && now - n.lastSeen > this.quietMs) {
        n.quiet = true;
        this.emit('node', { label: n.label, event: 'quiet', silentMs: now - n.lastSeen });
      }
    }
  }

  fleet() {
    const now = this.now();
    return [...this.nodes.values()].map((n) => {
      const open = [...this.incidents.values()].filter((i) => !i.resolvedAt && !i.transient && i.label === n.label);
      const h = n.heartbeat || {};
      const own = open.filter((i) => !i.suppressedBy);
      const state = n.quiet ? 'quiet' : own.some((i) => i.severity === 'critical') ? 'critical' : own.length ? 'degraded' : open.length ? 'degraded' : 'ok';
      return {
        label: n.label, state, quiet: n.quiet, lastSeen: n.lastSeen, silentS: n.lastSeen ? Math.round((now - n.lastSeen) / 1000) : null, skewMs: n.skewMs,
        node: h.node || null, tip: h.tip || null, tipAgeS: h.tip && h.tip.at ? Math.round((h.at - h.tip.at) / 1000) : null,
        peers: h.peers ?? null, rpc: h.rpc || null, mempool: h.mempool || null, sync: h.sync || null, logDelayMs: h.logDelayMs ?? null,
        network: n.network, sidecar: h.sidecar || null,
        open: open.map((i) => ({ id: i.id, key: i.key, severity: i.severity, since: i.pagedAt, acked: !!i.ackedAt, suppressedBy: i.suppressedBy || null })),
      };
    });
  }

  openIncidents() {
    return [...this.incidents.values()].filter((i) => !i.resolvedAt && !i.suppressedBy).sort((a, b) => a.pagedAt - b.pagedAt);
  }

  listIncidents({ windowMs = WINDOWS['24h'], label = null, state = 'all' } = {}) {
    const since = this.now() - windowMs;
    return [...this.incidents.values()]
      .filter((i) => (i.pagedAt >= since || !i.resolvedAt) && (!label || i.label === label))
      .filter((i) => state === 'all' || (state === 'open' ? !i.resolvedAt && !i.suppressedBy : state === 'suppressed' ? !i.resolvedAt && !!i.suppressedBy : !!i.resolvedAt))
      .sort((a, b) => b.pagedAt - a.pagedAt);
  }

  analytics({ windowMs = WINDOWS['24h'] } = {}) {
    const now = this.now();
    const since = now - windowMs;
    const all = [...this.incidents.values()].filter((i) => i.pagedAt >= since);
    const incidents = all.filter((i) => !i.transient);
    const events = all.filter((i) => i.transient);
    const open = incidents.filter((i) => !i.resolvedAt && !i.suppressedBy);
    const suppressed = incidents.filter((i) => !i.resolvedAt && i.suppressedBy);
    const count = (arr, key) => arr.reduce((m, i) => { m[i[key]] = (m[i[key]] || 0) + 1; return m; }, {});

    // detect and resolve are sidecar-clock to sidecar-clock; ack and respond
    // are collector-clock to collector-clock (receivedAt). No gap mixes clocks.
    const detect = stats(incidents.map((i) => i.pagedAt - i.onsetAt));
    const ack = stats(incidents.filter((i) => i.ackedAt).map((i) => i.ackedAt - i.receivedAt));
    const respond = stats(incidents.filter((i) => i.respondedAt).map((i) => i.respondedAt - i.receivedAt));
    const resolve = stats(incidents.filter((i) => i.resolvedAt).map((i) => i.resolvedAt - i.onsetAt));
    const duration = stats(incidents.filter((i) => i.resolvedAt).map((i) => i.resolvedAt - i.pagedAt));

    // hourly buckets (daily for windows over 3 days) of new incidents by severity
    const bucketMs = windowMs > 3 * 86400e3 ? 86400e3 : 3600e3;
    const buckets = [];
    for (let t = Math.floor(since / bucketMs) * bucketMs; t <= now; t += bucketMs) buckets.push({ at: t, critical: 0, warning: 0, info: 0 });
    for (const i of all) {
      const b = buckets[Math.floor((i.pagedAt - buckets[0].at) / bucketMs)];
      if (b) b[i.severity] = (b[i.severity] || 0) + 1;
    }

    // per node: incidents and the share of the window with a critical open
    const perNode = [...this.nodes.values()].map((n) => {
      const mine = incidents.filter((i) => i.label === n.label);
      const known = Math.min(windowMs, now - n.firstSeen);
      let criticalMs = 0;
      for (const i of mine.filter((x) => x.severity === 'critical' && !x.suppressedBy)) {
        criticalMs += Math.max(0, (i.resolvedAt || now) - Math.max(i.pagedAt, since));
      }
      return {
        label: n.label, incidents: mine.length, open: mine.filter((i) => !i.resolvedAt).length,
        criticalMs, availability: known > 0 ? Math.max(0, 1 - criticalMs / known) : null, quiet: n.quiet,
      };
    });

    const unacked = open.filter((i) => !i.ackedAt);
    const closed = incidents.filter((i) => i.resolvedAt);
    const withImprovement = closed.filter((i) => i.improvements && i.improvements.length);
    // fleet availability: share of node-time in the window with no critical open
    const knownMs = perNode.reduce((a, n) => a + Math.min(windowMs, now - (this.nodes.get(n.label).firstSeen)), 0);
    const criticalMs = perNode.reduce((a, n) => a + n.criticalMs, 0);
    return {
      window: windowMs, at: now,
      quietMs: this.quietMs, // how long without a heartbeat before a node is quiet; the node page shows it beside the sidecar's thresholds
      availability: knownMs > 0 ? Math.max(0, 1 - criticalMs / knownMs) : null,
      delivery: stats(all.map((i) => i.receivedAt - i.pagedAt)), // page -> here, includes skew
      totals: { incidents: incidents.length, events: events.length, open: open.length, unacked: unacked.length, suppressed: suppressed.length, nodes: this.nodes.size, quietNodes: [...this.nodes.values()].filter((n) => n.quiet).length },
      // how many closed incidents left Zero better than they found it
      improvements: { closed: closed.length, withImprovement: withImprovement.length, rate: closed.length ? withImprovement.length / closed.length : null },
      // the knowledge base doing its job: incidents that arrived with a known answer
      knownIssues: { entries: this.knownIssues.size, matchedIncidents: incidents.filter((i) => i.knownIssues && i.knownIssues.length).length, matchRate: incidents.length ? incidents.filter((i) => i.knownIssues && i.knownIssues.length).length / incidents.length : null },
      bySeverity: count(incidents, 'severity'), byKey: count(incidents, 'key'), byNode: count(incidents, 'label'),
      latency: { detect, ack, respond, resolve, duration },
      oldestUnackedS: unacked.length ? Math.round((now - unacked[0].receivedAt) / 1000) : null,
      // when the record last went clean; not window-scoped, so the Overview can say "last cleared" for any window
      lastResolvedAt: [...this.incidents.values()].reduce((m, i) => (!i.transient && i.resolvedAt && i.resolvedAt > m ? i.resolvedAt : m), 0) || null,
      timeline: { bucketMs, buckets },
      perNode,
      noisiest: Object.entries(count(incidents, 'key')).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, n]) => ({ key, count: n })),
    };
  }

  seriesFor(label, { windowMs = WINDOWS['24h'] } = {}) {
    const since = this.now() - windowMs;
    return (this.series.get(label) || []).filter((s) => s.at >= since);
  }
}

function parseWindow(q) {
  return WINDOWS[q] || WINDOWS['24h'];
}

function createCollector({ dir, quietMs = 60000, now = Date.now, publicDir = path.join(__dirname, '..', 'public'), triage = null } = {}) {
  const store = new Store(dir, { now, quietMs });
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  // Analysis on Zero's side: needs Zero's Anthropic credentials in this
  // process, never the customer's. Off, with an honest message, otherwise.
  const backend = triage ? 'custom' : triageBackend();
  const model = process.env.LW_TRIAGE_MODEL || (backend === 'cli' ? 'opus' : 'claude-opus-5');
  const runTriage = triage || (backend === 'api' ? makeIncidentTriage({ model }) : backend === 'cli' ? makeCliTriage({ model }) : null);
  const triageInFlight = new Set();

  app.get('/api/triage/status', (req, res) => res.json({ available: !!runTriage, backend: runTriage ? backend : null, model: runTriage ? model : null }));
  app.post('/api/incidents/:id/triage', async (req, res) => {
    const inc = store.incidents.get(req.params.id);
    if (!inc) return res.status(404).json({ error: 'not found' });
    if (!runTriage) return res.status(503).json({ error: 'analysis unavailable: the collector has no ANTHROPIC_API_KEY and no `claude` CLI on its PATH' });
    if (triageInFlight.has(inc.id)) return res.status(409).json({ error: 'analysis already running' });
    triageInFlight.add(inc.id);
    try {
      const draft = await runTriage(store.triageContext(inc));
      if (!draft) return res.status(502).json({ error: 'the model declined to analyse this incident' });
      inc.triage = { ...draft, by: (req.body && req.body.by) || 'unknown' };
      store.act(inc.id, 'triage', { by: inc.triage.by });
      res.json(inc);
    } catch (err) {
      res.status(502).json({ error: `analysis failed: ${err.message}` });
    } finally {
      triageInFlight.delete(inc.id);
    }
  });

  app.post('/ingest', (req, res) => {
    store.ingest(req.body || {});
    res.json({ ok: true });
  });

  app.get('/api/fleet', (req, res) => res.json(store.fleet()));
  app.get('/api/analytics', (req, res) => res.json(store.analytics({ windowMs: parseWindow(req.query.window) })));
  app.get('/api/incidents', (req, res) => res.json(store.listIncidents({ windowMs: parseWindow(req.query.window), label: req.query.label || null, state: req.query.state || 'all' })));
  app.get('/api/incidents/:id', (req, res) => {
    const inc = store.incidents.get(req.params.id);
    if (!inc) return res.status(404).json({ error: 'not found' });
    let bundle = null;
    try { bundle = JSON.parse(fs.readFileSync(path.join(store.dir, inc.latestBundleFile || inc.bundleFile), 'utf8')); } catch { /* no bundle */ }
    const knownIssueDetails = (inc.knownIssues || []).map((id) => store.knownIssues.get(id)).filter(Boolean)
      .map((ki) => ({ id: ki.id, title: ki.title, status: ki.status, cause: ki.cause, fix: ki.fix, workaround: ki.workaround, seen: ki.occurrences.length, nodes: new Set(ki.occurrences.map((o) => o.label)).size, fixedIn: ki.fixedIn || null }));
    // `at` is the collector clock now, so the page can tick an open stage's
    // duration against the same clock ackedAt/receivedAt are on
    res.json({ ...inc, bundle, knownIssueDetails, at: store.now() });
  });
  app.get('/api/incidents/:id/report', (req, res) => {
    const inc = store.incidents.get(req.params.id);
    if (!inc) return res.status(404).json({ error: 'not found' });
    let bundle = null;
    try { bundle = JSON.parse(fs.readFileSync(path.join(store.dir, inc.bundleFile), 'utf8')); } catch { /* network incidents have none */ }
    const members = (inc.members || []).map((id) => store.incidents.get(id)).filter(Boolean);
    res.type('text/markdown').send(incidentReport(inc, { bundle, members, now: store.now() }));
  });
  // promote and match must be registered before the generic :action route,
  // or Express hands them to act(), which does not know them
  app.post('/api/incidents/:id/promote', (req, res) => {
    const inc = store.incidents.get(req.params.id);
    if (!inc) return res.status(404).json({ error: 'not found' });
    res.json(store.promoteToKnownIssue(inc, { by: (req.body && req.body.by) || 'unknown' }));
  });
  app.post('/api/incidents/:id/match', (req, res) => {
    const inc = store.incidents.get(req.params.id);
    if (!inc) return res.status(404).json({ error: 'not found' });
    res.json(store.matchKnownIssues(inc));
  });
  app.post('/api/incidents/:id/:action', (req, res) => {
    try {
      const inc = store.act(req.params.id, req.params.action, req.body || {});
      if (!inc) return res.status(404).json({ error: 'not found' });
      res.json(inc);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.get('/api/series/:label', (req, res) => res.json(store.seriesFor(req.params.label, { windowMs: parseWindow(req.query.window) })));

  app.get('/api/known-issues', (req, res) => res.json(store.listKnownIssues({ q: req.query.q || '' })));
  app.get('/api/known-issues/:id', (req, res) => {
    const ki = store.knownIssues.get(req.params.id);
    if (!ki) return res.status(404).json({ error: 'not found' });
    res.json(ki);
  });
  app.get('/api/known-issues/:id/export', (req, res) => {
    const ki = store.knownIssues.get(req.params.id);
    if (!ki) return res.status(404).json({ error: 'not found' });
    res.type('text/markdown').send(kb.issueMarkdown(ki, { internal: req.query.internal === '1' }));
  });
  app.patch('/api/known-issues/:id', (req, res) => {
    const ki = store.updateKnownIssue(req.params.id, req.body || {}, { by: (req.body && req.body.by) || 'unknown' });
    if (!ki) return res.status(404).json({ error: 'not found' });
    res.json(ki);
  });
  app.get('/api/versions', (req, res) => res.json(store.versions()));
  app.get('/bundles/*', (req, res) => {
    // sendFile needs an absolute path, and a stored bundle path must stay inside the bundle dir
    const root = path.resolve(store.dir, 'bundles');
    const file = path.resolve(root, req.params[0]);
    if (!file.startsWith(root + path.sep)) return res.status(400).json({ error: 'bad path' });
    res.sendFile(file, (err) => { if (err) res.status(err.statusCode || 404).json({ error: 'not found' }); });
  });

  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'fleet.html')));
  app.use(express.static(publicDir, { index: false })); // index.html is the sidecar's page

  const sweeper = setInterval(() => store.sweepQuiet(), 5000);
  sweeper.unref?.();
  return { app, store, stop: () => { clearInterval(sweeper); store.flush(); } };
}

module.exports = { createCollector, Store, stats, WINDOWS };
