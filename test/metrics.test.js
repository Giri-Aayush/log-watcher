const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePrometheus, buckets, histogramDelta, quantile } = require('../src/zebra/metrics');

const text = `# HELP zebra_consensus_transaction_duration_seconds x
# TYPE zebra_consensus_transaction_duration_seconds histogram
zebra_consensus_transaction_duration_seconds_bucket{phase="checks",le="0.1"} 90
zebra_consensus_transaction_duration_seconds_bucket{phase="checks",le="1"} 99
zebra_consensus_transaction_duration_seconds_bucket{phase="checks",le="5"} 100
zebra_consensus_transaction_duration_seconds_bucket{phase="checks",le="+Inf"} 100
zebra_consensus_transaction_duration_seconds_sum{phase="checks"} 12.5
zebra_consensus_transaction_duration_seconds_count{phase="checks"} 100
other_metric 42
`;

test('parses only wanted families and computes an interpolated p99', () => {
  const fam = parsePrometheus(text, new Set(['zebra_consensus_transaction_duration_seconds']));
  assert.equal(fam.other_metric, undefined);
  const b = buckets(fam, 'zebra_consensus_transaction_duration_seconds').all;
  assert.equal(b.length, 4);
  // rank 99 sits exactly at the top of the le=1 bucket
  assert.equal(quantile(b, 0.99), 1);
  assert.ok(quantile(b, 0.995) > 1 && quantile(b, 0.995) < 5);
});

test('delta between scrapes isolates recent samples', () => {
  const prev = { all: [{ le: 1, count: 10 }, { le: Infinity, count: 10 }] };
  const cur = { all: [{ le: 1, count: 10 }, { le: Infinity, count: 12 }] };
  const d = histogramDelta(cur, prev);
  assert.deepEqual(d.all, [{ le: 1, count: 0 }, { le: Infinity, count: 2 }]);
  assert.equal(quantile(d.all, 0.99), 1); // everything new landed above 1s
  assert.equal(quantile([{ le: 1, count: 0 }, { le: Infinity, count: 0 }], 0.5), null);
});
