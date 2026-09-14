const test = require('node:test');
const assert = require('node:assert/strict');
const { Detectors } = require('../src/detectors');
const { defaults } = require('../src/config');
const { parseLine } = require('../src/zebra/parse');
const { toEvents } = require('../src/zebra/events');
const { lines, committedAt } = require('./fixtures');

const T0 = Date.parse('2026-09-14T12:00:00Z');
const MIN = 60000;

function harness(overrides = {}) {
  let t = T0;
  const cfg = structuredClone(defaults);
  Object.assign(cfg.thresholds, overrides);
  const d = new Detectors(cfg, { now: () => t });
  const raised = [];
  const resolved = [];
  d.on('alert', (a) => raised.push(a));
  d.on('resolve', (r) => resolved.push(r));
  const feed = (line, ctx) => { for (const ev of toEvents(parseLine(line))) d.onEvent(ev, ctx); };
  const ok = (extra = {}) => d.onPoll({ ok: true, ms: 20, blockchain: { blocks: 100, bestblockhash: 'ab', chain: 'test' }, peers: new Array(8).fill({}), mempool: { size: 3, bytes: 900 }, info: { build: 'v6.3.0', testnet: true }, ...extra });
  return { d, raised, resolved, feed, ok, advance: (ms) => { t += ms; }, keys: () => raised.map((a) => a.key) };
}

test('tip stall raises after the threshold and resolves on the next block', () => {
  const h = harness({ tipStallMin: 10 });
  h.feed(committedAt(100, T0));
  h.advance(9 * MIN); h.d.tick();
  assert.deepEqual(h.keys(), []);
  h.advance(2 * MIN); h.d.tick();
  assert.deepEqual(h.keys(), ['tip_stalled']);
  assert.equal(h.raised[0].severity, 'critical');
  assert.equal(h.raised[0].evidence.height, 100);
  h.feed(committedAt(101, T0 + 11 * MIN));
  assert.equal(h.resolved[0].key, 'tip_stalled');
  assert.equal(h.d.state.tip.height, 101);
});

test('stall clock starts from the replayed block timestamp, not from startup', () => {
  const h = harness({ tipStallMin: 10 });
  h.feed(committedAt(100, T0 - 15 * MIN), { replay: true, at: T0 - 15 * MIN });
  h.d.tick();
  assert.deepEqual(h.keys(), ['tip_stalled']); // already 15 minutes stale when we attached
});

test('replayed history updates state but never pages', () => {
  const h = harness();
  const replay = { replay: true, at: T0 - 3600000 };
  h.feed(lines.banner, replay);
  h.feed(lines.stalled, replay);
  h.feed(lines.error, replay);
  h.feed(lines.eosUntil, replay);
  assert.deepEqual(h.keys(), []);
  assert.equal(h.d.state.sync.state, 'stalled');
  assert.equal(h.d.state.log.errorCount, 1);
  assert.equal(h.d.state.haltHeight, 3200000);
});

test('rpc: down after N consecutive failures, resolves on recovery; slow raises and resolves', () => {
  const h = harness({ rpcFailCount: 3, rpcSlowMs: 500 });
  const fail = () => h.d.onPoll({ ok: false, ms: 10000, error: { message: 'timed out', kind: 'timeout' } });
  fail(); fail();
  assert.deepEqual(h.keys(), []);
  fail();
  assert.deepEqual(h.keys(), ['rpc_down']);
  h.ok();
  assert.equal(h.resolved[0].key, 'rpc_down');
  h.ok({ ms: 800 });
  assert.deepEqual(h.keys(), ['rpc_down', 'rpc_slow']);
  h.ok({ ms: 30 });
  assert.equal(h.resolved.at(-1).key, 'rpc_slow');
});

test('rpc_down resolves after a restart even though the banner arrives before the first good poll', () => {
  const h = harness({ rpcFailCount: 2 });
  const fail = () => h.d.onPoll({ ok: false, ms: 5, error: { message: 'ECONNREFUSED', kind: 'network' } });
  fail(); fail();
  assert.deepEqual(h.keys(), ['rpc_down']);
  h.feed(lines.banner); // node came back; its log is read before RPC is polled again
  h.ok();
  assert.equal(h.resolved[0].key, 'rpc_down');
  assert.match(h.resolved[0].detail, /after 2 failures/);
});

test('peers: warning after two low polls, critical at zero, resolves when back', () => {
  const h = harness({ minPeers: 3 });
  h.ok({ peers: [{}] });
  assert.deepEqual(h.keys(), []);
  h.ok({ peers: [{}] });
  assert.deepEqual(h.keys(), ['peers_low']);
  assert.equal(h.raised[0].severity, 'warning');
  h.ok({ peers: [] });
  assert.equal(h.raised[1].severity, 'critical');
  h.ok();
  assert.equal(h.resolved[0].key, 'peers_low');
});

test('tip going backwards over RPC is reported', () => {
  const h = harness();
  h.ok({ blockchain: { blocks: 100, bestblockhash: 'a', chain: 'test' } });
  h.ok({ blockchain: { blocks: 98, bestblockhash: 'b', chain: 'test' } });
  assert.deepEqual(h.keys(), ['tip_rewound']);
  assert.deepEqual(h.raised[0].evidence, { from: 100, to: 98, hash: 'b' });
  assert.equal(h.d.state.tip.height, 98);
});

test('node restart, version change and getinfo.errors are transient notifications', () => {
  const h = harness();
  h.feed(lines.banner);
  assert.equal(h.raised[0].key, 'node_restarted');
  assert.equal(h.raised[0].transient, true);
  h.ok({ info: { build: 'v6.2.0', testnet: true } });
  h.ok({ info: { build: 'v6.3.0', testnet: true, errors: 'peer set: no peers', errorstimestamp: 1 } });
  assert.deepEqual(h.keys().slice(1), ['version_changed', 'node_reported_error']);
});

test('error burst over a sliding window', () => {
  const h = harness({ errorBurst: 3, errorWindowS: 60 });
  h.feed(lines.regtestWarn);
  h.feed(lines.regtestWarn);
  assert.deepEqual(h.keys(), []);
  h.feed(lines.regtestWarn);
  assert.deepEqual(h.keys(), ['error_burst']);
  h.advance(120000);
  h.d.tick(); // quiet for two minutes: the window drained on its own
  assert.equal(h.resolved[0].key, 'error_burst');
});

test('big block and commit lag from block detail; disabled when threshold is 0', () => {
  const h = harness({ bigBlockTxs: 1000, blockLagS: 90 });
  h.d.onBlockDetail({ height: 5, hash: 'x', nTx: 7000, size: 1900000, time: T0 / 1000 - 300 }, T0);
  assert.deepEqual(h.keys(), ['large_block', 'block_lag']);
  const off = harness({ bigBlockTxs: 0, blockLagS: 0 });
  off.d.onBlockDetail({ height: 5, hash: 'x', nTx: 7000, size: 1900000, time: T0 / 1000 - 300 }, T0);
  assert.deepEqual(off.keys(), []);
});

test('end of support warns as the halt height approaches', () => {
  const h = harness({ eosWarnBlocks: 1000 });
  h.feed(lines.eosUntil); // halts at 3200000
  h.feed(committedAt(3198000, T0));
  assert.deepEqual(h.keys(), []);
  h.feed(committedAt(3199500, T0));
  assert.equal(h.raised[0].key, 'end_of_support');
  assert.equal(h.raised[0].evidence.blocksLeft, 500);
});

test('zebra stall warning maps to sync_stalled and clears on at_tip', () => {
  const h = harness();
  h.feed(lines.stalled);
  assert.equal(h.raised[0].key, 'sync_stalled');
  assert.equal(h.raised[0].severity, 'critical');
  h.feed(lines.atTip);
  assert.equal(h.resolved[0].key, 'sync_stalled');
});
