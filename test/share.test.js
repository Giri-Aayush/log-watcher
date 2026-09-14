const test = require('node:test');
const assert = require('node:assert/strict');
const { applySharePolicy } = require('../src/share');

const bundle = {
  sidecar: { host: 'exchange-node-7', pid: 1, version: '2.0.0' },
  logs: [
    '2026-09-14T11:00:00Z  INFO a: one',
    '2026-09-14T11:00:01Z  WARN b: two',
    '2026-09-14T11:00:02Z  INFO c: three',
    '2026-09-14T11:00:03Z ERROR d: four',
    '2026-09-14T11:00:04Z  INFO e: five',
    '2026-09-14T11:00:05Z  INFO f: six',
    '2026-09-14T11:00:06Z  INFO g: seven',
    '2026-09-14T11:00:07Z  INFO h: eight',
    '2026-09-14T11:00:08Z  INFO i: nine',
  ],
  logsReceivedAt: [1, 2, 3, 4, 5, 6, 7, 8, 9],
};

test('full keeps the lines but drops the hostname by default', () => {
  const out = applySharePolicy(bundle, { logs: 'full' });
  assert.equal(out.logs.length, 9);
  assert.equal(out.sidecar.host, undefined);
  assert.equal(out.sidecar.pid, 1);
  assert.deepEqual(out.share, { logs: 'full', host: false });
  assert.equal(applySharePolicy(bundle, { logs: 'full', host: true }).sidecar.host, 'exchange-node-7');
});

test('summary keeps WARN/ERROR plus the last five, in order, with their receive times', () => {
  const out = applySharePolicy(bundle, { logs: 'summary' });
  assert.deepEqual(out.logs.map((l) => l.split(': ')[1]), ['two', 'four', 'five', 'six', 'seven', 'eight', 'nine']);
  assert.deepEqual(out.logsReceivedAt, [2, 4, 5, 6, 7, 8, 9]);
});

test('none sends no lines; the original bundle is untouched', () => {
  const out = applySharePolicy(bundle, { logs: 'none' });
  assert.deepEqual(out.logs, []);
  assert.equal(bundle.logs.length, 9);
  assert.equal(bundle.sidecar.host, 'exchange-node-7');
});
