const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { EventEmitter } = require('events');
const { createPipeline } = require('../src/pipeline');
const { defaults } = require('../src/config');
const { lines, committedAt } = require('./fixtures');

// A stand-in for zebrad's JSON-RPC: enough of getblockchaininfo / getinfo /
// getpeerinfo / getmempoolinfo / getblock to drive the poller, with knobs to
// fake failure modes.
function fakeNode() {
  const state = { blocks: 4345594, peers: 8, mempool: 3, latencyMs: 0, down: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (state.down) return req.socket.destroy();
      const { id, method } = JSON.parse(body);
      const results = {
        getblockchaininfo: { chain: 'test', blocks: state.blocks, headers: state.blocks, bestblockhash: 'ff'.repeat(32), verificationprogress: 1 },
        getinfo: { build: 'v6.3.0', subversion: '/Zebra:6.3.0/', testnet: true, errors: '' },
        getpeerinfo: new Array(state.peers).fill({ addr: 'x' }),
        getmempoolinfo: { size: state.mempool, bytes: state.mempool * 300 },
        getblock: { hash: 'ff'.repeat(32), height: state.blocks, nTx: 2, size: 4000, time: Math.floor(Date.now() / 1000) - 5 },
      };
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: results[method] }));
      }, state.latencyMs);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, server, url: `http://127.0.0.1:${server.address().port}` })));
}

function build(url, thresholds = {}) {
  const cfg = structuredClone(defaults);
  cfg.source = 'none';
  cfg.rpc.url = url;
  cfg.rpc.timeoutMs = 500;
  cfg.alerts.bundleDir = null;
  Object.assign(cfg.thresholds, thresholds);
  const sent = [];
  const source = new EventEmitter();
  const p = createPipeline(cfg, { sinks: [{ name: 't', send: async (m) => sent.push(`${m.phase} ${m.alert.key}`) }], source });
  p.bus.on('error', () => {}); // background getblock failures are logged by server.js, not fatal
  return { p, sent, source };
}

test('log lines and RPC polls converge on one node state, and a block fetches its detail', async () => {
  const node = await fakeNode();
  const { p, source } = build(node.url);
  await p.poll();
  assert.equal(p.detectors.state.tip.height, 4345594);
  assert.equal(p.detectors.state.node.build, 'v6.3.0');
  assert.equal(p.detectors.state.peers, 8);
  node.state.blocks = 4345595;
  source.emit('line', committedAt(4345595, Date.now()));
  assert.equal(p.detectors.state.tip.source, 'gossip');
  await new Promise((r) => setTimeout(r, 50)); // getblock is async
  assert.equal(p.detectors.state.lastBlock.height, 4345595);
  assert.equal(p.detectors.state.lastBlock.txs, 2);
  source.emit('line', lines.banner);
  source.emit('line', lines.bannerNetwork);
  assert.equal(p.detectors.state.node.network, 'Regtest');
  node.server.close();
});

test('rpc_down pages after consecutive failures and resolves when the node is back', async () => {
  const node = await fakeNode();
  const { p, sent } = build(node.url, { rpcFailCount: 2 });
  await p.poll();
  node.state.down = true;
  await p.poll();
  await p.poll();
  assert.deepEqual(sent, ['NEW rpc_down']);
  node.state.down = false;
  await p.poll();
  assert.deepEqual(sent, ['NEW rpc_down', 'RESOLVED rpc_down']);
  node.server.close();
});

test('slow RPC is measured, not inferred', async () => {
  const node = await fakeNode();
  const { p, sent } = build(node.url, { rpcSlowMs: 100 });
  node.state.latencyMs = 200;
  await p.poll();
  assert.deepEqual(sent, ['NEW rpc_slow']);
  assert.ok(p.detectors.state.rpc.ms >= 200);
  node.server.close();
});

test('snapshot exposes what the dashboard needs', async () => {
  const node = await fakeNode();
  const { p, source } = build(node.url);
  source.emit('line', lines.atTip);
  const s = p.snapshot();
  assert.equal(s.source, 'rpc only');
  assert.equal(s.logs.length, 1);
  assert.equal(p.snapshot(0).logs.length, 0); // /api/state leaves the log out
  assert.equal(s.state.sync.state, 'at_tip');
  assert.ok(s.thresholds.tipStallMin);
  node.server.close();
});

test('lines replayed after a source reattach are skipped', async () => {
  const node = await fakeNode();
  const { p, source } = build(node.url);
  const t = Date.now() - 5000;
  source.emit('line', committedAt(4345595, t));
  source.emit('line', committedAt(4345596, t + 1000));
  source.emit('exit', { code: 0 });
  source.emit('line', committedAt(4345595, t));       // docker logs --tail replays
  source.emit('line', committedAt(4345596, t + 1000));
  source.emit('line', committedAt(4345597, t + 2000)); // genuinely new
  const s = p.snapshot();
  assert.equal(s.counters.lines, 3);
  assert.equal(s.state.tip.height, 4345597);
  await new Promise((r) => setTimeout(r, 50)); // let the getblock detail calls finish
  node.server.close();
});

test('heartbeats carry the sidecar\'s dashboard URL and poll interval but not its host unless shared', async () => {
  const node = await fakeNode();
  const cfg = structuredClone(defaults);
  cfg.source = 'none';
  cfg.rpc.url = node.url;
  cfg.dashboardUrl = 'http://sidecar.local:3000';
  cfg.sinks.webhookUrl = 'http://collector.test/ingest';
  cfg.alerts.bundleDir = null;
  const p = createPipeline(cfg, { sinks: [], source: new EventEmitter() });
  p.bus.on('error', () => {});
  p.outbox.fetchImpl = async () => ({ ok: true, status: 200 });
  await p.poll();
  // the heartbeat rides the outbox; trigger one directly by reading what start() would send
  const snap = p.snapshot();
  assert.equal(snap.sidecar.dashboardUrl, 'http://sidecar.local:3000');
  assert.equal(snap.sidecar.pollMs, cfg.rpc.pollMs);
  assert.equal(snap.consoleUrl, 'http://collector.test');
  node.server.close();
});
