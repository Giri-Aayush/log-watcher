#!/usr/bin/env node
// Reference collector: the Zero-side end of the sidecar's webhook.
//
// Sidecars POST heartbeats (every poll) and alerts (with bundles) here. It
// keeps a fleet table in memory, writes every bundle to disk, and pages when a
// sidecar goes quiet — the one failure the sidecar cannot report itself.
//
// Deliberately small: one process, JSON files on disk, no auth. It exists to
// show the shape of the two-tier design (edge detects and pages; the collector
// remembers and correlates), not to be the production service.
//
//   node scripts/collector.js            # listens on :4000
//   LW_WEBHOOK_URL=http://collector:4000/ingest node server.js   # on each node

const fs = require('fs');
const path = require('path');
const express = require('express');

const PORT = Number(process.env.COLLECTOR_PORT || 4000);
const DIR = process.env.COLLECTOR_DIR || 'collected';
const QUIET_MS = Number(process.env.COLLECTOR_QUIET_MS || 60000);

const fleet = new Map(); // label -> { lastSeen, heartbeat, alerts: [] }
const app = express();
app.use(express.json({ limit: '10mb' }));

app.post('/ingest', (req, res) => {
  const msg = req.body || {};
  const label = msg.label || (msg.alert && msg.bundle && msg.bundle.label) || 'unknown';
  const node = fleet.get(label) || { label, lastSeen: 0, heartbeat: null, alerts: [], quiet: false };
  node.lastSeen = Date.now();
  if (node.quiet) {
    node.quiet = false;
    console.log(`${new Date().toISOString()} RECOVERED ${label}: sidecar reporting again`);
  }
  if (msg.phase === 'HEARTBEAT') {
    node.heartbeat = msg;
  } else if (msg.alert) {
    node.alerts.unshift({ phase: msg.phase, key: msg.alert.key, severity: msg.alert.severity, title: msg.alert.title, at: Date.now(), id: msg.alert.id });
    node.alerts = node.alerts.slice(0, 50);
    const dir = path.join(DIR, label.replace(/[^\w.-]/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${msg.alert.id}.${msg.phase.toLowerCase().replace(/\s+/g, '-')}.json`), JSON.stringify(msg, null, 2));
    console.log(`${new Date().toISOString()} ${msg.phase} ${label} ${msg.alert.severity} ${msg.alert.key}: ${msg.alert.title}`);
  }
  fleet.set(label, node);
  res.json({ ok: true });
});

app.get('/fleet', (req, res) => res.json([...fleet.values()]));

app.get('/', (req, res) => {
  const now = Date.now();
  const rows = [...fleet.values()].map((n) => {
    const h = n.heartbeat || {};
    const active = (h.activeAlerts || []).map((a) => `${a.severity[0].toUpperCase()}:${a.key}`).join(' ') || '-';
    return [
      n.label.padEnd(18),
      (n.quiet ? 'QUIET' : 'ok').padEnd(6),
      `${Math.round((now - n.lastSeen) / 1000)}s`.padStart(5),
      String(h.node ? h.node.build || h.node.version || '?' : '?').padEnd(9),
      String(h.node ? h.node.network || '' : '').padEnd(8),
      String(h.tip ? h.tip.height : '-').padStart(9),
      String(h.peers ?? '-').padStart(5),
      (h.rpc ? (h.rpc.ok === false ? 'DOWN' : `${h.rpc.ms}ms`) : '-').padStart(7),
      String(h.mempool ? h.mempool.size : '-').padStart(7),
      active,
    ].join('  ');
  });
  const text = [
    '',
    ['node'.padEnd(18), 'state'.padEnd(6), ' seen', 'zebrad'.padEnd(9), 'network'.padEnd(8), '      tip', 'peers', '    rpc', 'mempool', 'active alerts'].join('  '),
    ...rows,
    '',
    ...[...fleet.values()].flatMap((n) => n.alerts.slice(0, 8).map((a) => `${new Date(a.at).toISOString()}  ${n.label}  ${a.phase.padEnd(12)} ${a.severity.padEnd(8)} ${a.key}: ${a.title}`)),
  ].join('\n');
  res.type('text/html').send(`<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>zero collector</title>
<style>body{margin:0;background:#0f1115;color:#d7dae0;font:13px/1.5 ui-monospace,Menlo,monospace;padding:18px}pre{margin:0;white-space:pre}h1{font-size:14px;margin:0 0 10px;color:#58a6ff}</style>
<h1>zero collector · fleet · ${new Date(now).toISOString()} · quiet after ${QUIET_MS / 1000}s</h1><pre>${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`);
});

// Dead man's switch: a sidecar that stops reporting is either dead or the
// box is. Either way someone should know.
setInterval(() => {
  const now = Date.now();
  for (const n of fleet.values()) {
    if (!n.quiet && now - n.lastSeen > QUIET_MS) {
      n.quiet = true;
      console.log(`${new Date().toISOString()} QUIET ${n.label}: no heartbeat for ${Math.round((now - n.lastSeen) / 1000)}s — sidecar or host is down`);
    }
  }
}, 5000).unref();

app.listen(PORT, () => console.log(`[collector] listening on :${PORT} — fleet view at http://localhost:${PORT}/, bundles in ${DIR}/`));
