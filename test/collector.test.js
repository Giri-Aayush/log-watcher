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
