const test = require('node:test');
const assert = require('node:assert/strict');
const { AlertManager } = require('../src/alerts');
const { Ring } = require('../src/ring');

function harness() {
  let t = 1_000_000;
  const sent = [];
  const sink = { name: 'test', send: async (m) => sent.push({ phase: m.phase, key: m.alert.key, text: m.text }) };
  const ring = new Ring(10);
  for (let i = 0; i < 3; i++) ring.push({ raw: `line ${i}` });
  const am = new AlertManager({
    cfg: { cooldownMin: 30, transientCooldownS: 60, bundleDir: null, bundleLogLines: 2, label: 'test' },
    sinks: [sink],
    logRing: ring,
    getState: () => ({ node: { build: 'v6.3.0', network: 'Testnet' }, tip: { height: 5 }, peers: 4, rpc: { ok: true, ms: 12 }, mempool: { size: 1 } }),
    now: () => t,
  });
  return { am, sent, advance: (ms) => { t += ms; } };
}

const stall = { key: 'tip_stalled', severity: 'critical', title: 'No new block for 12m', detail: 'd', evidence: { height: 5 }, suggest: 'look' };

test('same key is deduped; re-notifies after cooldown; resolve notifies once', async () => {
  const h = harness();
  await h.am.raise(stall);
  await h.am.raise(stall);
  await h.am.raise(stall);
  assert.equal(h.sent.length, 1);
  assert.equal(h.am.list().active[0].count, 3);
  h.advance(31 * 60000);
  await h.am.raise(stall);
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].phase, 'STILL ACTIVE');
  await h.am.resolve({ key: 'tip_stalled', detail: 'block 6 arrived' });
  assert.equal(h.sent[2].phase, 'RESOLVED');
  assert.match(h.sent[2].text, /block 6 arrived/);
  assert.equal(h.am.list().active.length, 0);
  assert.equal(await h.am.resolve({ key: 'tip_stalled' }), null); // already gone
});

test('severity change notifies immediately as an escalation', async () => {
  const h = harness();
  await h.am.raise({ ...stall, severity: 'warning' });
  await h.am.raise({ ...stall, severity: 'critical' });
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].phase, 'ESCALATED');
});

test('transient alerts are rate limited per key and never become active', async () => {
  const h = harness();
  const restart = { key: 'node_restarted', severity: 'info', title: 'restarted', transient: true };
  await h.am.raise(restart);
  await h.am.raise(restart);
  h.advance(61000);
  await h.am.raise(restart);
  assert.equal(h.sent.length, 2);
  assert.equal(h.am.list().active.length, 0);
  assert.equal(h.am.list().history.length, 2);
});

test('bundle and page text carry the context', async () => {
  const h = harness();
  const a = await h.am.raise(stall);
  assert.deepEqual(a.bundle.logs, ['line 1', 'line 2']);
  assert.equal(a.bundle.node.build, 'v6.3.0');
  assert.equal(a.bundle.evidence.height, 5);
  const text = h.sent[0].text;
  assert.match(text, /^\[test\] CRITICAL tip_stalled\nNo new block for 12m/);
  assert.match(text, /zebrad v6.3.0 Testnet · tip 5 · peers 4 · rpc 12ms · mempool 1/);
  assert.match(text, /next: look/);
});

test('a failing sink does not break the others', async () => {
  const h = harness();
  const errors = [];
  h.am.on('error', (e) => errors.push(e.message));
  h.am.sinks.unshift({ name: 'broken', send: async () => { throw new Error('boom'); } });
  await h.am.raise(stall);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(errors, ['sink broken: boom']);
});
