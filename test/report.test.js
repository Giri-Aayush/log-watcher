const test = require('node:test');
const assert = require('node:assert/strict');
const { incidentReport } = require('../src/report');

const T0 = Date.parse('2026-09-14T12:00:00Z');
const MIN = 60000;
const inc = {
  id: 'inc-1', label: 'foundry-pool-1', key: 'tip_stalled', severity: 'critical', title: 'No new block for 10m',
  detail: 'Tip is still 100.', evidence: { height: 100, ageS: 600, peers: 2 }, suggest: 'Compare height with a public explorer.',
  onsetAt: T0 - 10 * MIN, pagedAt: T0, receivedAt: T0 + 2000,
  ackedAt: T0 + 3 * MIN, ackedBy: 'aayush', respondedAt: T0 + 7 * MIN, respondedBy: 'aayush',
  resolvedAt: T0 + 12 * MIN, resolvedDetail: 'new block 101', closedBy: null,
  updates: [{ phase: 'NEW', at: T0 + 2000 }, { phase: 'RESOLVED', at: T0 + 12 * MIN + 2000 }],
  notes: [{ at: T0 + 3 * MIN, by: 'aayush', action: 'ack' }, { at: T0 + 7 * MIN, by: 'aayush', action: 'respond', text: 'asked Foundry to check peers' }, { at: T0 + 9 * MIN, by: 'aayush', action: 'note', text: 'Two outbound peers dropped; node was partitioned.' }],
};
const bundle = { node: { build: 'v6.3.0', network: 'Mainnet' }, tip: { height: 100, at: T0 - 10 * MIN }, pagedAt: T0, peers: 2, rpc: { ok: true, ms: 41 }, mempool: { size: 3 }, lastBlock: { height: 100, txs: 41, size: 1900000 }, share: { logs: 'summary' } };

test('a resolved incident reads as a complete customer report', () => {
  const md = incidentReport(inc, { bundle, now: T0 + 20 * MIN });
  assert.match(md, /^# Incident report: No new block for 10m/);
  assert.match(md, /\*\*Status:\*\* resolved/);
  assert.match(md, /detected 10m 00s later/);
  assert.match(md, /acknowledged by aayush 2m 58s after the page/);
  assert.match(md, /cleared at 2026-09-14 12:12:02 UTC \(new block 101\), 22m 00s after onset/);
  assert.match(md, /- 2026-09-14 11:50:02 UTC — Condition began \(tip_stalled\)/);
  assert.match(md, /Operator contacted by aayush: "asked Foundry to check peers"/);
  assert.match(md, /\| Time to detect \| 10m 00s \|/);
  assert.match(md, /\| Time to acknowledge \| 2m 58s \|/);
  assert.match(md, /- ageS: `600`/);
  assert.match(md, /zebrad: v6.3.0 \(Mainnet\)/);
  assert.match(md, /last block: 100, 41 txs, 1855 KiB/);
  assert.match(md, /## Analysis\n\nTwo outbound peers dropped/);
  assert.match(md, /## Recommendations\n\nCompare height/);
  assert.match(md, /shared as "summary"/);
});

test('an open, unacknowledged incident says so instead of inventing times', () => {
  const md = incidentReport({ ...inc, ackedAt: null, ackedBy: null, respondedAt: null, resolvedAt: null, notes: [], updates: [{ phase: 'NEW', at: T0 + 2000 }] }, { now: T0 + 5 * MIN });
  assert.match(md, /\*\*Status:\*\* open/);
  assert.match(md, /has not been acknowledged yet/);
  assert.match(md, /\| Time to acknowledge \| — \|/);
  assert.match(md, /\| Duration \(from page\) \| 4m 58s so far \|/);
  assert.doesNotMatch(md, /## Node at the time/);
});

test('a network incident lists the affected nodes and its members', () => {
  const net = { ...inc, id: 'net-1', label: 'network:Mainnet', key: 'network_tip_stalled', evidence: { key: 'tip_stalled', network: 'Mainnet', nodes: ['a', 'b'], of: 3 }, members: ['a-1', 'b-1'], notes: [], updates: [] };
  const md = incidentReport(net, { members: [{ id: 'a-1' }, { id: 'b-1' }], now: T0 + 20 * MIN });
  assert.match(md, /## Affected nodes\n\n- a\n- b/);
  assert.match(md, /folded into this one: `a-1`, `b-1`/);
});
