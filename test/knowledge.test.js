const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/collector');
const kb = require('../src/knowledge');

const T0 = Date.parse('2026-09-14T12:00:00Z');

function harness() {
  let t = T0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-kb-'));
  const store = new Store(dir, { now: () => t });
  const alert = (label, id, key, { build = 'v6.2.3', logs = [], evidence = { height: 100 }, network = 'Mainnet' } = {}) => store.ingest({
    phase: 'NEW', label, alert: { id, key, severity: 'critical', title: `${key} on ${label}`, detail: 'd', evidence, onsetAt: t - 60000, firstSeen: t, count: 1 },
    bundle: { label, node: { build, network }, logs },
  });
  return { store, dir, alert, advance: (ms) => { t += ms; }, now: () => t };
}

test('version prefix matching', () => {
  assert.ok(kb.versionMatches('v6.2.3', ['6.2']));
  assert.ok(kb.versionMatches('v6.2.3', ['6.2.3']));
  assert.ok(!kb.versionMatches('v6.3.0', ['6.2']));
  assert.ok(kb.versionMatches('v6.3.0', []));
  assert.ok(!kb.versionMatches(null, ['6.2']));
});

test('an incident is promoted to a known issue; the next incident with the same signature is matched and counted', () => {
  const h = harness();
  const first = h.alert('foundry-pool-1', 'inc-1', 'rpc_down', { logs: ['2026-09-14T11:00:00Z ERROR zebra_state: database corrupted'] });
  h.store.act('inc-1', 'note', { by: 'aayush', text: 'RocksDB corrupted after an unclean shutdown.' });
  h.store.act('inc-1', 'improvement', { by: 'aayush', text: 'Documented: delete the state cache and resync; runbook §4.' });
  const ki = h.store.promoteToKnownIssue(first, { by: 'aayush' });
  assert.equal(ki.key, 'rpc_down');
  assert.deepEqual(ki.versions, ['6.2.3']);
  assert.match(ki.cause, /RocksDB corrupted/);
  assert.match(ki.fix, /delete the state cache/);
  assert.equal(ki.status, 'draft');
  assert.deepEqual(first.knownIssues, [ki.id]);

  // sharpen the signature by hand
  h.store.updateKnownIssue(ki.id, { match: { logIncludes: ['database corrupted'] }, versions: ['6.2'], status: 'confirmed', title: 'RocksDB corruption after unclean shutdown on 6.2.x' }, { by: 'aayush' });

  h.advance(3600e3);
  const second = h.alert('bitgo-hot-2', 'inc-2', 'rpc_down', { build: 'v6.2.1', logs: ['x', '2026-09-14T13:00:00Z ERROR zebra_state: database corrupted'] });
  assert.deepEqual(second.knownIssues, [ki.id], 'same key, 6.2.x, the log line: matched on arrival');
  const different = h.alert('pool-eu-3', 'inc-3', 'rpc_down', { build: 'v6.3.0', logs: ['2026-09-14T13:00:00Z ERROR zebra_state: database corrupted'] });
  assert.deepEqual(different.knownIssues, [], '6.3.0 is outside the affected versions');
  const noLog = h.alert('pool-eu-4', 'inc-4', 'rpc_down', { build: 'v6.2.0', logs: ['nothing relevant'] });
  assert.deepEqual(noLog.knownIssues, [], 'the log signature is required');

  const [listed] = h.store.listKnownIssues();
  assert.equal(listed.seen, 2);
  assert.equal(listed.nodes, 2);
  const a = h.store.analytics({ windowMs: 7 * 86400e3 });
  assert.deepEqual(a.knownIssues, { entries: 1, matchedIncidents: 2, matchRate: 0.5 });
  const ctx = h.store.triageContext(second);
  assert.equal(ctx.knownIssues[0].fix, 'Documented: delete the state cache and resync; runbook §4.');

  const md = kb.issueMarkdown(h.store.knownIssues.get(ki.id));
  assert.match(md, /^# RocksDB corruption after unclean shutdown on 6.2.x/);
  assert.match(md, /\*\*Affected zebrad:\*\* 6.2/);
  assert.match(md, /## Fix\n\nDocumented: delete the state cache/);
  assert.match(md, /- log contains `database corrupted`/);
  assert.doesNotMatch(md, /foundry-pool-1/, 'public export carries no customer labels');
  assert.match(kb.issueMarkdown(h.store.knownIssues.get(ki.id), { internal: true }), /foundry-pool-1/);
});

test('known issues and their occurrences survive a reload; search works', () => {
  const h = harness();
  const inc = h.alert('a', 'inc-1', 'peers_low');
  const ki = h.store.promoteToKnownIssue(inc, { by: 'aayush' });
  h.store.updateKnownIssue(ki.id, { cause: 'outbound 8233 blocked by a firewall change' });
  h.store.flush();
  const again = new Store(h.dir, { now: h.now });
  assert.equal(again.knownIssues.get(ki.id).cause, 'outbound 8233 blocked by a firewall change');
  assert.equal(again.listKnownIssues({ q: 'firewall' }).length, 1);
  assert.equal(again.listKnownIssues({ q: 'rocksdb' }).length, 0);
});

test('the version registry says who runs what', () => {
  const h = harness();
  const beat = (label, seq, build, network) => h.store.ingest({ phase: 'HEARTBEAT', label, seq, sentAt: h.now(), sidecar: { startedAt: 1 }, at: h.now(), node: { build, network }, tip: { height: 1, at: h.now() }, rpc: { ok: true, ms: 1 }, activeAlerts: [] });
  beat('a', 1, 'v6.3.0', 'Mainnet'); beat('b', 1, 'v6.3.0', 'Mainnet'); beat('c', 1, 'v6.2.3', 'Mainnet');
  const v = h.store.versions();
  assert.deepEqual(v.map((x) => [x.build, x.count]), [['v6.3.0', 2], ['v6.2.3', 1]]);
  assert.deepEqual(v[1].nodes[0], { label: 'c', network: 'Mainnet', quiet: false });
});
