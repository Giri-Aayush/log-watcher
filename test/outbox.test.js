const test = require('node:test');
const assert = require('node:assert/strict');
const { Outbox } = require('../src/outbox');

// A fake collector that can be switched off; records what arrived, in order.
function fakeCollector() {
  const received = [];
  const state = { down: false };
  const fetchImpl = async (url, { body }) => {
    if (state.down) throw Object.assign(new Error('fetch failed'), { cause: new Error('ECONNREFUSED') });
    received.push(JSON.parse(body));
    return { ok: true, status: 200 };
  };
  return { received, state, fetchImpl };
}

// setTimeout stand-in we can drive by hand
function clock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    setTimeoutImpl: (fn, ms) => { const id = { fn, at: t + ms }; timers.push(id); return id; },
    async run(ms) {
      const end = t + ms;
      while (true) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers.find((x) => x.at <= end);
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        t = next.at;
        next.fn();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test('delivers in order with sequence numbers', async () => {
  const c = fakeCollector();
  const ob = new Outbox({ url: 'http://c/ingest', fetchImpl: c.fetchImpl });
  ob.push({ phase: 'NEW', alert: { key: 'a' } });
  ob.push({ phase: 'RESOLVED', alert: { key: 'a' } });
  ob.push({ phase: 'HEARTBEAT' });
  await tick(); await tick(); await tick(); await tick();
  assert.deepEqual(c.received.map((m) => [m.seq, m.phase]), [[1, 'NEW'], [2, 'RESOLVED'], [3, 'HEARTBEAT']]);
  assert.equal(ob.stats.delivered, 3);
  assert.equal(ob.stats.queued, 0);
  assert.ok(typeof c.received[0].sentAt === 'number');
});

test('holds the queue while the collector is down, retries with backoff, then flushes in order', async () => {
  const c = fakeCollector();
  const k = clock();
  const ob = new Outbox({ url: 'http://c/ingest', fetchImpl: c.fetchImpl, now: k.now, setTimeoutImpl: k.setTimeoutImpl, baseDelayMs: 1000, maxDelayMs: 8000 });
  c.state.down = true;
  ob.push({ phase: 'NEW', alert: { key: 'tip_stalled' } });
  await tick(); await tick();
  assert.equal(ob.stats.consecutiveFailures, 1);
  assert.equal(ob.stats.lastError, 'ECONNREFUSED');
  ob.push({ phase: 'RESOLVED', alert: { key: 'tip_stalled' } });
  ob.push({ phase: 'HEARTBEAT' });
  await tick();
  assert.equal(ob.stats.retries, 1, 'pushes during backoff do not trigger sends');
  await k.run(1000); // first retry -> still down
  assert.equal(ob.stats.retries, 2);
  await k.run(2000); // second retry (2s backoff) -> still down
  assert.equal(ob.stats.retries, 3);
  assert.equal(ob.stats.queued, 3);
  c.state.down = false;
  await k.run(4000);
  await k.run(100);
  assert.deepEqual(c.received.map((m) => [m.seq, m.phase]), [[1, 'NEW'], [2, 'RESOLVED'], [3, 'HEARTBEAT']]);
  assert.equal(ob.stats.consecutiveFailures, 0);
});

test('only the newest unsent heartbeat is kept; alerts are never coalesced', async () => {
  const c = fakeCollector();
  const k = clock();
  const ob = new Outbox({ url: 'http://c/ingest', fetchImpl: c.fetchImpl, now: k.now, setTimeoutImpl: k.setTimeoutImpl });
  c.state.down = true;
  for (let i = 0; i < 5; i++) ob.push({ phase: 'HEARTBEAT', tip: { height: i } });
  ob.push({ phase: 'NEW', alert: { key: 'a' } });
  ob.push({ phase: 'NEW', alert: { key: 'b' } });
  await tick();
  // five heartbeats collapsed into the newest one (even the one mid-send)
  assert.equal(ob.queue.length, 3);
  assert.deepEqual(ob.queue.map((m) => m.phase), ['HEARTBEAT', 'NEW', 'NEW']);
  assert.equal(ob.queue[0].tip.height, 4);
});

test('a bounded queue drops old heartbeats before it drops an alert', async () => {
  const c = fakeCollector();
  const k = clock();
  const ob = new Outbox({ url: 'http://c/ingest', fetchImpl: c.fetchImpl, now: k.now, setTimeoutImpl: k.setTimeoutImpl, maxQueue: 3 });
  c.state.down = true;
  ob.push({ phase: 'HEARTBEAT' });
  await tick();
  ob.push({ phase: 'NEW', alert: { key: 'a' } });
  ob.push({ phase: 'NEW', alert: { key: 'b' } });
  ob.push({ phase: 'NEW', alert: { key: 'c' } });
  ob.push({ phase: 'NEW', alert: { key: 'd' } });
  assert.equal(ob.stats.dropped, 2);
  assert.deepEqual(ob.queue.map((m) => m.phase === 'NEW' ? m.alert.key : 'hb'), ['b', 'c', 'd']); // heartbeat first, then the oldest alert
});

test('no url means a no-op', () => {
  const ob = new Outbox({ url: null });
  assert.equal(ob.push({ phase: 'NEW' }), null);
  assert.equal(ob.queue.length, 0);
});
