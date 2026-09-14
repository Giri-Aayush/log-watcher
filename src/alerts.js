const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// Owns the lifecycle of alerts: dedupe by key, cooldown for re-notification,
// resolution, and the context bundle that travels with every notification.
//
// The bundle is the point. A page that says "tip stalled" starts a
// conversation; a page that carries the height, peer count, RPC latency,
// node version and the last 40 log lines lets the engineer start reproducing
// instead of asking the operator for logs.
class AlertManager extends EventEmitter {
  constructor({ cfg, sinks, logRing, getState, getSidecar = () => null, now = Date.now, triage = null }) {
    super();
    this.cfg = cfg;
    this.sinks = sinks;
    this.logRing = logRing;
    this.getState = getState;
    this.getSidecar = getSidecar;
    this.now = now;
    this.triage = triage;
    this.active = new Map();
    this.history = [];
    this.lastNotified = new Map();
    this.seq = 0;
    if (cfg.bundleDir) fs.mkdirSync(cfg.bundleDir, { recursive: true });
  }

  async raise(a) {
    const now = this.now();
    if (!a.transient) {
      const existing = this.active.get(a.key);
      if (existing) {
        existing.count++;
        existing.lastSeen = now;
        existing.title = a.title;
        existing.detail = a.detail;
        existing.evidence = a.evidence;
        if (a.severity !== existing.severity) {
          existing.severity = a.severity;
          return this.notify(existing, 'ESCALATED');
        }
        if (now - existing.notifiedAt >= this.cfg.cooldownMin * 60000) return this.notify(existing, 'STILL ACTIVE');
        this.emit('update', existing);
        return existing;
      }
    } else {
      // Transient alerts (a restart, one big block) still get a cooldown so a
      // flapping node cannot page every 5 seconds.
      const last = this.lastNotified.get(a.key) || 0;
      if (now - last < this.cfg.transientCooldownS * 1000) return null;
    }

    // A stateful alert is identified by what it is about, not by when this
    // process noticed it: the same stall re-raised after a sidecar restart
    // must land on the same incident at the collector. Onset is rounded to
    // the minute because detectors estimate it (now - "12m 3s").
    const onset = a.onsetAt || now;
    const id = a.transient
      ? `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${a.key}-${++this.seq}`
      : `${String(this.cfg.label).replace(/[^\w.-]/g, '_')}-${a.key}-${new Date(Math.floor(onset / 60000) * 60000).toISOString().slice(0, 16).replace(':', '-')}`;
    const alert = {
      id,
      key: a.key,
      severity: a.severity,
      title: a.title,
      detail: a.detail,
      evidence: a.evidence || {},
      suggest: a.suggest || null,
      transient: !!a.transient,
      // when the condition began, as best the detector knows; firstSeen - onsetAt
      // is our detection latency and is what the collector's MTTD is built from
      onsetAt: a.onsetAt || now,
      firstSeen: now,
      lastSeen: now,
      notifiedAt: now,
      count: 1,
      resolved: null,
      bundle: null,
    };
    if (!alert.transient) this.active.set(alert.key, alert);
    this.history.unshift(alert);
    if (this.history.length > 500) this.history.pop();
    return this.notify(alert, 'NEW');
  }

  async resolve({ key, detail }) {
    const alert = this.active.get(key);
    if (!alert) return null;
    this.active.delete(key);
    alert.resolved = { at: this.now(), detail };
    alert.resolvedBundle = this.makeBundle(alert); // what the node looked like when it cleared
    this.emit('resolve', alert);
    await this.fanout({ alert, phase: 'RESOLVED', text: this.formatText(alert, 'RESOLVED') });
    return alert;
  }

  async notify(alert, phase) {
    alert.notifiedAt = this.now();
    this.lastNotified.set(alert.key, alert.notifiedAt);
    alert.bundle = this.makeBundle(alert);
    await this.persist(alert); // the page names the file, so it must exist first
    this.emit(phase === 'NEW' ? 'alert' : 'update', alert);
    if (this.triage && phase === 'NEW' && alert.severity !== 'info') {
      // Fire and forget: the page must not wait on a model call. The draft is
      // attached to the alert when it lands and shown in the dashboard as a
      // proposal for a human to approve; nothing is ever sent from it.
      this.triage(alert).then((draft) => {
        if (!draft) return;
        alert.triage = draft;
        this.persist(alert);
        this.emit('update', alert);
      }).catch((err) => this.emit('error', err));
    }
    await this.fanout({ alert, phase, text: this.formatText(alert, phase) });
    return alert;
  }

  makeBundle(alert) {
    const state = this.getState();
    return {
      id: alert.id,
      key: alert.key,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      suggest: alert.suggest,
      onsetAt: alert.onsetAt,
      pagedAt: alert.firstSeen,
      at: new Date(alert.lastSeen).toISOString(),
      label: this.cfg.label,
      sidecar: this.getSidecar(),
      node: state.node,
      tip: state.tip,
      sync: state.sync,
      peers: state.peers,
      peerSummary: state.peerSummary || null,
      mempool: state.mempool,
      rpc: state.rpc,
      gbt: state.gbt && state.gbt.at ? state.gbt : null,
      lastBlock: state.lastBlock || null,
      logDelayMs: state.logDelayMs ?? null,
      evidence: alert.evidence,
      // node timestamp, our receive timestamp, raw line — two clocks on purpose
      logs: this.logRing.last(this.cfg.bundleLogLines).map((e) => e.raw),
      logsReceivedAt: this.logRing.last(this.cfg.bundleLogLines).map((e) => e.receivedAt || null),
    };
  }

  async persist(alert) {
    if (!this.cfg.bundleDir) return;
    const file = path.join(this.cfg.bundleDir, `${alert.id}.json`);
    alert.bundleFile = file;
    try {
      await fs.promises.writeFile(file, JSON.stringify({ ...alert.bundle, triage: alert.triage || null }, null, 2));
    } catch (err) {
      this.emit('error', err);
    }
  }

  formatText(alert, phase) {
    const s = this.getState();
    const b = alert.bundle || this.makeBundle(alert);
    const head = `[${this.cfg.label}] ${phase === 'RESOLVED' ? 'RESOLVED' : alert.severity.toUpperCase()} ${alert.key}${phase !== 'NEW' && phase !== 'RESOLVED' ? ` (${phase}, x${alert.count})` : ''}`;
    const lines = [head, alert.title];
    if (phase === 'RESOLVED' && alert.resolved) lines.push(alert.resolved.detail);
    else if (alert.detail) lines.push(alert.detail);
    const ctx = [];
    if (s.node && (s.node.build || s.node.version)) ctx.push(`zebrad ${s.node.build || s.node.version} ${s.node.network || ''}`.trim());
    if (s.tip && s.tip.height != null) ctx.push(`tip ${s.tip.height}`);
    if (s.peers != null) ctx.push(`peers ${s.peers}`);
    if (s.rpc && s.rpc.ms != null) ctx.push(`rpc ${s.rpc.ok ? `${s.rpc.ms}ms` : 'DOWN'}`);
    if (s.mempool) ctx.push(`mempool ${s.mempool.size}`);
    if (ctx.length) lines.push(ctx.join(' · '));
    const lastLog = b.logs[b.logs.length - 1];
    if (lastLog && phase !== 'RESOLVED') lines.push(`last log: ${lastLog.slice(0, 200)}`);
    if (alert.suggest && phase === 'NEW') lines.push(`next: ${alert.suggest}`);
    if (alert.bundleFile) lines.push(`bundle: ${alert.bundleFile}`);
    return lines.join('\n');
  }

  async fanout(msg) {
    await Promise.all(this.sinks.map((sink) => sink.send(msg).catch((err) => {
      this.emit('error', new Error(`sink ${sink.name}: ${err.message}`));
    })));
  }

  list() {
    return { active: [...this.active.values()], history: this.history.slice(0, 100) };
  }
}

module.exports = { AlertManager };
