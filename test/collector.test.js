const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, stats } = require('../src/collector');

const T0 = Date.parse('2026-09-14T12:00:00Z');
const MIN = 60000;

function harness() {
  let t = T0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-collector-'));
  const store = new Store(dir, { now: () => t, quietMs: 60000 });
  const advance = (ms) => { t += ms; };
  const alert = (phase, a, extra = {}) => store.ingest({ phase, label: 'pool-1', alert: a, bundle: { label: 'pool-1', logs: [] }, ...extra });
  const heartbeat = (fields = {}) => store.ingest({ phase: 'HEARTBEAT', label: 'pool-1', at: t, tip: { height: 100, at: t - 30000 }, peers: 8, rpc: { ok: true, ms: 12 }, mempool: { size: 3 }, activeAlerts: [], ...fields });
  return { store, dir, advance, alert, heartbeat, now: () => t };
}

const stall = (id = 'inc-1') => ({ id, key: 'tip_stalled', severity: 'critical', title: 'No new block for 10m', detail: 'd', evidence: { height: 100 }, onsetAt: T0 - 10 * MIN, firstSeen: T0, count: 1 });

test('an alert becomes an incident with the response timestamps filled in as things happen', () => {
  const h = harness();
  const inc = h.alert('NEW', stall());
  assert.equal(inc.onsetAt, T0 - 10 * MIN);
  assert.equal(inc.pagedAt, T0);
  assert.equal(h.store.openIncidents().length, 1);
  assert.match(inc.bundleFile, /bundles\/pool-1\/inc-1\.new\.json$/);

  h.advance(3 * MIN); h.store.act('inc-1', 'ack', { by: 'aayush' });
  h.advance(4 * MIN); h.store.act('inc-1', 'respond', { by: 'aayush', text: 'told Foundry we are looking' });
  h.advance(5 * MIN); h.alert('RESOLVED', { ...stall(), resolved: { at: h.now(), detail: 'block 101 arrived' } });

  const done = h.store.incidents.get('inc-1');
  assert.equal(done.ackedAt - done.pagedAt, 3 * MIN);
  assert.equal(done.respondedAt - done.pagedAt, 7 * MIN);
  assert.equal(done.resolvedAt - done.onsetAt, 22 * MIN);
  assert.equal(done.notes.length, 2);
  assert.equal(h.store.openIncidents().length, 0);

  const a = h.store.analytics();
  assert.equal(a.totals.incidents, 1);
  assert.equal(a.latency.detect.p50, 10 * MIN);
  assert.equal(a.latency.ack.p50, 3 * MIN);
  assert.equal(a.latency.respond.p50, 7 * MIN);
  assert.equal(a.latency.resolve.p50, 22 * MIN);
  assert.equal(a.latency.duration.p50, 12 * MIN);
  assert.equal(a.lastResolvedAt, done.resolvedAt);
});

test('escalations and re-notifications update one incident; transient alerts are events, not incidents', () => {
  const h = harness();
  h.alert('NEW', { ...stall(), severity: 'warning' });
  h.alert('ESCALATED', { ...stall(), severity: 'critical', count: 3 });
  h.alert('STILL ACTIVE', { ...stall(), severity: 'critical', count: 9 });
  const inc = h.store.incidents.get('inc-1');
  assert.equal(inc.severity, 'critical');
  assert.equal(inc.escalations, 1);
  assert.equal(inc.renotified, 1);
  assert.equal(h.store.incidents.size, 1);

  h.alert('NEW', { id: 'ev-1', key: 'node_restarted', severity: 'info', title: 'restarted', transient: true, firstSeen: h.now(), count: 1 });
  const a = h.store.analytics();
  assert.equal(a.totals.incidents, 1);
  assert.equal(a.totals.events, 1);
  assert.equal(a.totals.open, 1);
  assert.equal(a.totals.unacked, 1);
  assert.equal(a.lastResolvedAt, null, 'an event is not a cleared incident');
});

test('heartbeats build a per-node series, a fleet row, and availability; silence flips the node to quiet', () => {
  const h = harness();
  for (let i = 0; i < 5; i++) { h.heartbeat({ rpc: { ok: true, ms: 10 + i } }); h.advance(10000); }
  assert.equal(h.store.seriesFor('pool-1').length, 5);
  assert.equal(h.store.seriesFor('pool-1')[4].rpcMs, 14);
  const [row] = h.store.fleet();
  assert.equal(row.state, 'ok');
  assert.equal(row.tip.height, 100);

  h.alert('NEW', { ...stall(), firstSeen: h.now() }); // paged 50s into the node's known life
  assert.equal(h.store.fleet()[0].state, 'critical');
  h.advance(30 * MIN);
  const a = h.store.analytics({ windowMs: 3600e3 });
  const node = a.perNode.find((n) => n.label === 'pool-1');
  assert.equal(node.open, 1);
  assert.ok(node.availability < 1 && node.availability > 0);
  assert.equal(a.availability, node.availability); // one node: fleet == node
  assert.equal(a.quietMs, 60000); // the quiet threshold the node page lists with the sidecar's own

  h.advance(2 * MIN);
  h.store.sweepQuiet();
  assert.equal(h.store.fleet()[0].state, 'quiet');
  h.heartbeat();
  assert.equal(h.store.fleet()[0].quiet, false);
});

test('closing by hand and reloading from disk', () => {
  const h = harness();
  h.alert('NEW', stall());
  h.advance(MIN);
  h.store.act('inc-1', 'close', { by: 'aayush', text: 'false positive: explorer was behind too' });
  h.store.flush();
  const again = new Store(h.dir, { now: h.now });
  const inc = again.incidents.get('inc-1');
  assert.equal(inc.closedBy, 'aayush');
  assert.equal(inc.resolvedAt - inc.pagedAt, MIN);
  assert.equal(again.openIncidents().length, 0);
});

test('retries with the same seq are dropped; a restarted sidecar starts a new sequence; nodes survive a reload', () => {
  const h = harness();
  const sidecar = { startedAt: 1, host: 'a' };
  h.store.ingest({ phase: 'HEARTBEAT', label: 'pool-1', seq: 1, sentAt: h.now() - 40, sidecar, at: h.now(), tip: { height: 1, at: h.now() }, rpc: { ok: true, ms: 1 }, activeAlerts: [] });
  assert.equal(h.store.fleet()[0].skewMs, 40);
  const first = h.store.ingest({ phase: 'NEW', label: 'pool-1', seq: 2, sentAt: h.now(), sidecar, alert: stall(), bundle: { label: 'pool-1', logs: [], sidecar } });
  const dup = h.store.ingest({ phase: 'NEW', label: 'pool-1', seq: 2, sentAt: h.now(), sidecar, alert: stall(), bundle: { label: 'pool-1', logs: [], sidecar } });
  assert.equal(dup.duplicate, true);
  assert.equal(first.updates.length, 1);

  // sidecar restarted: seq starts over and must not be treated as a duplicate
  const sidecar2 = { startedAt: 2, host: 'a' };
  const hb = h.store.ingest({ phase: 'HEARTBEAT', label: 'pool-1', seq: 1, sentAt: h.now(), sidecar: sidecar2, at: h.now(), tip: { height: 2, at: h.now() }, rpc: { ok: true, ms: 1 }, activeAlerts: [] });
  assert.equal(hb.tip, 2);

  h.store.flush();
  const again = new Store(h.dir, { now: h.now });
  assert.equal(again.nodes.get('pool-1').firstSeen, T0);
  assert.equal(again.nodes.get('pool-1').lastSeq, 1);
  h.advance(2 * MIN);
  again.sweepQuiet();
  assert.equal(again.fleet()[0].state, 'quiet'); // it was last seen before the restart
});

test('stats: percentiles over an empty and a small set', () => {
  assert.deepEqual(stats([]), { count: 0, mean: null, p50: null, p95: null, max: null });
  assert.deepEqual(stats([5, 1, 3]), { count: 3, mean: 3, p50: 3, p95: 5, max: 5 });
});

test('the same stall on most nodes of a network becomes one network incident; members are suppressed until it clears', () => {
  const h = harness();
  const beat = (label, seq) => h.store.ingest({ phase: 'HEARTBEAT', label, seq, sentAt: h.now(), sidecar: { startedAt: 1 }, at: h.now(), node: { build: 'v6.3.0', network: 'Mainnet' }, tip: { height: 100, at: h.now() }, rpc: { ok: true, ms: 5 }, activeAlerts: [] });
  const stallOn = (label, seq, id) => h.store.ingest({ phase: 'NEW', label, seq, sentAt: h.now(), sidecar: { startedAt: 1 }, alert: { ...stall(id), firstSeen: h.now() }, bundle: { label, logs: [] } });
  const clearOn = (label, seq, id) => h.store.ingest({ phase: 'RESOLVED', label, seq, sentAt: h.now(), sidecar: { startedAt: 1 }, alert: { ...stall(id), resolved: { at: h.now(), detail: 'block' } }, bundle: { label, logs: [] } });
  beat('a', 1); beat('b', 1); beat('c', 1);

  stallOn('a', 2, 'a-1');
  assert.equal(h.store.analytics().totals.open, 1); // one node: an ordinary incident
  stallOn('b', 2, 'b-1');
  const a = h.store.analytics();
  assert.equal(a.totals.open, 1, 'two of three stalled: one network incident, not two');
  assert.equal(a.totals.suppressed, 2);
  const net = h.store.openIncidents()[0];
  assert.equal(net.key, 'network_tip_stalled');
  assert.equal(net.label, 'network:Mainnet');
  assert.deepEqual(net.evidence.nodes, ['a', 'b']);
  assert.equal(net.onsetAt, T0 - 10 * 60000); // earliest member onset
  assert.equal(h.store.incidents.get('a-1').suppressedBy, net.id);
  assert.equal(h.store.fleet().find((n) => n.label === 'a').state, 'degraded'); // not critical: the network is the problem
  assert.equal(h.store.listIncidents({ state: 'suppressed' }).length, 2);

  h.advance(60000);
  clearOn('b', 3, 'b-1');
  assert.equal(h.store.incidents.get(net.id).resolvedAt, h.now(), 'one of three left: below threshold, network incident resolves');
  assert.equal(h.store.incidents.get('a-1').suppressedBy, null, 'the remaining member is an ordinary incident again');
  assert.equal(h.store.analytics().totals.open, 1);
  assert.equal(h.store.openIncidents()[0].id, 'a-1');
});

test('correlation ignores other keys and other networks', () => {
  const h = harness();
  const beat = (label, seq, network) => h.store.ingest({ phase: 'HEARTBEAT', label, seq, sentAt: h.now(), sidecar: { startedAt: 1 }, at: h.now(), node: { network }, tip: { height: 1, at: h.now() }, rpc: { ok: true, ms: 5 }, activeAlerts: [] });
  beat('m1', 1, 'Mainnet'); beat('m2', 1, 'Mainnet'); beat('t1', 1, 'Testnet');
  const on = (label, seq, id, key) => h.store.ingest({ phase: 'NEW', label, seq, sentAt: h.now(), sidecar: { startedAt: 1 }, alert: { ...stall(id), key, firstSeen: h.now() }, bundle: { label, logs: [] } });
  on('m1', 2, 'm1-1', 'tip_stalled');
  on('t1', 2, 't1-1', 'tip_stalled'); // different network
  on('m2', 2, 'm2-1', 'peers_low');   // different key
  assert.equal(h.store.analytics().totals.open, 3);
  assert.equal(h.store.analytics().totals.suppressed, 0);
  // warnings never correlate: regtest's "initial sync is very slow" is not a network event
  const warn = (label, seq, id) => h.store.ingest({ phase: 'NEW', label, seq, sentAt: h.now(), sidecar: { startedAt: 1 }, alert: { ...stall(id), key: 'sync_stalled', severity: 'warning', firstSeen: h.now() }, bundle: { label, logs: [] } });
  warn('m1', 3, 'm1-2'); warn('m2', 3, 'm2-2');
  assert.equal(h.store.analytics().totals.suppressed, 0);
});

test('report endpoint data: marking a report sent lands in the record', () => {
  const h = harness();
  h.alert('NEW', stall());
  h.advance(MIN);
  const inc = h.store.act('inc-1', 'report', { by: 'aayush' });
  assert.equal(inc.reportSentBy, 'aayush');
  assert.equal(inc.reportSentAt, h.now());
  assert.equal(inc.notes[0].action, 'report');
});

test('triage context carries the fleet, the history and the last hour, not the whole record', () => {
  const h = harness();
  const beat = (label, seq, extra = {}) => h.store.ingest({ phase: 'HEARTBEAT', label, seq, sentAt: h.now(), sidecar: { startedAt: 1 }, at: h.now(), node: { build: 'v6.3.0', network: 'Mainnet' }, tip: { height: 100, at: h.now() - 30000 }, peers: 8, rpc: { ok: true, ms: 12 }, mempool: { size: 3 }, activeAlerts: [], ...extra });
  beat('pool-1', 1); beat('pool-2', 1, { peers: 9 }); beat('t-1', 1, { node: { network: 'Testnet' } });
  h.alert('NEW', { ...stall('old-1'), key: 'peers_low', firstSeen: h.now() - 3600e3 * 5 });
  h.alert('NEW', stall());
  h.store.act('inc-1', 'note', { by: 'aayush', text: 'checked the explorer, network is fine' });
  const ctx = h.store.triageContext(h.store.incidents.get('inc-1'));
  assert.equal(ctx.network, 'Mainnet');
  assert.deepEqual(ctx.otherNodesOnNetwork.map((n) => n.label), ['pool-2']); // not itself, not the testnet node
  assert.equal(ctx.recentHistory.length, 1);
  assert.equal(ctx.recentHistory[0].key, 'peers_low');
  assert.deepEqual(ctx.incident.engineerNotes, ['note by aayush: checked the explorer, network is fine']);
  assert.equal(ctx.incident.notes, undefined);
  assert.equal(ctx.lastHour.samples, 1);
  assert.equal(ctx.lastHour.rpcP95Ms, 12);
});

test('triage endpoint: stores the draft and records who asked; 503 without credentials', async () => {
  const { createCollector } = require('../src/collector');
  const http = require('http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-triage-'));
  const seen = [];
  const withModel = createCollector({ dir, triage: async (ctx) => { seen.push(ctx); return { model: 'stub', at: 1, text: 'Assessment: fine.' }; } });
  const without = createCollector({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lw-triage2-')), triage: null });
  const listen = (app) => new Promise((r) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => r(s)); });
  const a = await listen(withModel.app), b = await listen(without.app);
  const url = (s, p) => `http://127.0.0.1:${s.address().port}${p}`;
  const post = (u, body) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post(url(a, '/ingest'), { phase: 'NEW', label: 'pool-1', alert: stall(), bundle: { label: 'pool-1', logs: ['l1'], node: { network: 'Mainnet' } } });
  assert.deepEqual(await (await fetch(url(a, '/api/triage/status'))).json(), { available: true });
  const r = await post(url(a, '/api/incidents/inc-1/triage'), { by: 'aayush' });
  assert.equal(r.status, 200);
  const inc = await r.json();
  assert.equal(inc.triage.text, 'Assessment: fine.');
  assert.equal(inc.triage.by, 'aayush');
  assert.equal(inc.notes.at(-1).action, 'triage');
  assert.equal(seen[0].bundle.logs[0], 'l1');
  process.env.ANTHROPIC_API_KEY = ''; // make sure the fallback path is the honest 503
  await post(url(b, '/ingest'), { phase: 'NEW', label: 'pool-1', alert: stall(), bundle: { label: 'pool-1', logs: [] } });
  const r2 = await post(url(b, '/api/incidents/inc-1/triage'), { by: 'aayush' });
  assert.equal(r2.status, 503);
  assert.match((await r2.json()).error, /ANTHROPIC_API_KEY/);
  withModel.stop(); without.stop(); a.close(); b.close();
});

test('an improvement is recorded on the incident and counted once it is closed', () => {
  const h = harness();
  h.alert('NEW', stall());
  assert.throws(() => h.store.act('inc-1', 'improvement', { by: 'aayush' }), /needs text/);
  h.store.act('inc-1', 'improvement', { by: 'aayush', text: 'tip_stalled now checks a second node before paging; upstream zebra#1234' });
  assert.equal(h.store.analytics().improvements.withImprovement, 0, 'still open: not counted yet');
  h.store.act('inc-1', 'close', { by: 'aayush', text: 'done' });
  const a = h.store.analytics();
  assert.deepEqual(a.improvements, { closed: 1, withImprovement: 1, rate: 1 });
  assert.equal(h.store.incidents.get('inc-1').improvements[0].by, 'aayush');
});
