// Customer-facing incident report, built from the incident record and the
// page-time bundle. Markdown, because it goes into an email or a Signal
// message as-is. Nothing in it is written by hand except the engineer's own
// notes, and those are quoted as notes.

function fmt(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
const ts = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');
const nice = (key) => key.replace(/_/g, ' ');

function incidentReport(inc, { bundle = null, members = [], now = Date.now() } = {}) {
  // sidecar-clock times mapped onto the collector clock so the timeline reads in one order
  const offset = inc.receivedAt - inc.pagedAt;
  const onset = inc.onsetAt + offset;
  const paged = inc.receivedAt;
  const resolved = inc.resolvedAt ? inc.resolvedAt + offset : null;
  const status = resolved ? (inc.closedBy ? `closed by ${inc.closedBy}` : 'resolved') : inc.respondedAt ? 'responded, still open' : inc.ackedAt ? 'acknowledged, still open' : 'open';
  const isNetwork = String(inc.label).startsWith('network:');

  const lines = [];
  lines.push(`# Incident report: ${inc.title}`);
  lines.push('');
  lines.push(`**Node:** ${inc.label}  `);
  lines.push(`**Detector:** \`${inc.key}\` (${inc.severity})  `);
  lines.push(`**Status:** ${status}  `);
  lines.push(`**Incident id:** \`${inc.id}\`  `);
  lines.push(`**Prepared:** ${ts(now)} by Zero (Shielded Labs)`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  const detectMs = inc.pagedAt - inc.onsetAt;
  lines.push(`${inc.detail || inc.title}`);
  lines.push('');
  lines.push(`The condition began at about ${ts(onset)} and was detected ${fmt(detectMs)} later, at ${ts(paged)}.` +
    (inc.ackedAt ? ` It was acknowledged by ${inc.ackedBy} ${fmt(inc.ackedAt - inc.receivedAt)} after the page.` : ' It has not been acknowledged yet.') +
    (inc.respondedAt ? ` The operator was contacted ${fmt(inc.respondedAt - inc.receivedAt)} after the page.` : '') +
    (resolved ? ` It cleared at ${ts(resolved)}${inc.resolvedDetail ? ` (${inc.resolvedDetail})` : ''}, ${fmt(resolved - onset)} after onset.` : ' It is still open.'));
  lines.push('');

  lines.push('## Timeline (UTC)');
  lines.push('');
  const events = [];
  events.push([onset, `Condition began (${inc.key})`]);
  events.push([paged, `Detected and paged by the sidecar`]);
  for (const u of inc.updates || []) {
    if (u.phase === 'ESCALATED') events.push([u.at, `Escalated to ${u.severity}`]);
    if (u.phase === 'STILL ACTIVE') events.push([u.at, `Still active, re-notified (×${u.count})`]);
    if (u.phase === 'SUPPRESSED') events.push([u.at, 'Folded into a network-wide incident']);
  }
  for (const n of inc.notes || []) {
    if (n.action === 'ack') events.push([n.at, `Acknowledged by ${n.by}`]);
    else if (n.action === 'respond') events.push([n.at, `Operator contacted by ${n.by}${n.text ? `: "${n.text}"` : ''}`]);
    else if (n.action === 'note') events.push([n.at, `Note by ${n.by}${n.text ? `: "${n.text}"` : ''}`]);
    else if (n.action === 'close') events.push([n.at, `Closed by ${n.by}${n.text ? `: "${n.text}"` : ''}`]);
    else if (n.action === 'report') events.push([n.at, `Report sent by ${n.by}`]);
    else if (n.action === 'improvement') events.push([n.at, `Improvement recorded by ${n.by}: "${n.text}"`]);
  }
  if (resolved && !inc.closedBy) events.push([resolved, `Cleared${inc.resolvedDetail ? `: ${inc.resolvedDetail}` : ''}`]);
  events.sort((a, b) => a[0] - b[0]);
  for (const [t, text] of events) lines.push(`- ${ts(t)} — ${text}`);
  lines.push('');

  lines.push('## Response times');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Time to detect | ${fmt(detectMs)} |`);
  lines.push(`| Time to acknowledge | ${inc.ackedAt ? fmt(inc.ackedAt - inc.receivedAt) : '—'} |`);
  lines.push(`| Time to contact operator | ${inc.respondedAt ? fmt(inc.respondedAt - inc.receivedAt) : '—'} |`);
  lines.push(`| Time to resolve (from onset) | ${resolved ? fmt(resolved - onset) : 'still open'} |`);
  lines.push(`| Duration (from page) | ${resolved ? fmt(resolved - paged) : fmt(now - paged) + ' so far'} |`);
  lines.push('');

  const ev = Object.entries(inc.evidence || {}).filter(([, v]) => v != null && typeof v !== 'object');
  if (ev.length) {
    lines.push('## What the sidecar saw');
    lines.push('');
    for (const [k, v] of ev) lines.push(`- ${k}: \`${v}\``);
    lines.push('');
  }
  if (isNetwork) {
    lines.push('## Affected nodes');
    lines.push('');
    for (const n of (inc.evidence && inc.evidence.nodes) || []) lines.push(`- ${n}`);
    if (members.length) {
      lines.push('');
      lines.push(`Per-node incidents folded into this one: ${members.map((m) => `\`${m.id}\``).join(', ')}.`);
    }
    lines.push('');
  }

  if (bundle && bundle.node) {
    lines.push('## Node at the time of the page');
    lines.push('');
    const n = bundle.node || {};
    lines.push(`- zebrad: ${n.build || n.version || '—'}${n.network ? ` (${n.network})` : ''}`);
    if (bundle.tip && bundle.tip.height != null) lines.push(`- tip: ${bundle.tip.height}${bundle.tip.at ? `, last block ${fmt(bundle.pagedAt - bundle.tip.at)} before the page` : ''}`);
    if (bundle.peers != null) lines.push(`- peers: ${bundle.peers}`);
    if (bundle.rpc) lines.push(`- rpc: ${bundle.rpc.ok === false ? 'unreachable' : `${bundle.rpc.ms} ms`}`);
    if (bundle.mempool) lines.push(`- mempool: ${bundle.mempool.size} transactions`);
    if (bundle.lastBlock) lines.push(`- last block: ${bundle.lastBlock.height}, ${bundle.lastBlock.txs} txs, ${Math.round(bundle.lastBlock.size / 1024)} KiB`);
    if (bundle.gbt && bundle.gbt.at) lines.push(`- getblocktemplate: ${bundle.gbt.ok === false ? 'failing' : `${bundle.gbt.ms} ms`}`);
    lines.push('');
  }

  const analysis = (inc.notes || []).filter((n) => n.action === 'note' && n.text);
  if (analysis.length) {
    lines.push('## Analysis');
    lines.push('');
    for (const n of analysis) lines.push(`${n.text}  \n— ${n.by}, ${ts(n.at)}`);
    lines.push('');
  }

  if (inc.improvements && inc.improvements.length) {
    lines.push('## What changed in Zero as a result');
    lines.push('');
    for (const im of inc.improvements) lines.push(`- ${im.text}  \n  — ${im.by}, ${ts(im.at)}`);
    lines.push('');
  }

  if (inc.suggest) {
    lines.push('## Recommendations');
    lines.push('');
    lines.push(inc.suggest);
    lines.push('');
  }

  lines.push('---');
  lines.push(`Generated from the Zero incident record. Log excerpts are held on your node and were ${bundle && bundle.share ? `shared as "${bundle.share.logs}"` : 'not included'}; the full bundle is available on request.`);
  return lines.join('\n');
}

module.exports = { incidentReport };
