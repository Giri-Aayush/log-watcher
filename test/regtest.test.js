// Integration test against a real zebrad in regtest mode. Runs only with
// LW_REGTEST=1 and zebrad on PATH (or ZEBRAD=/path): npm run test:regtest
//
// It mines real blocks and then kills the node, so every layer from the log
// file to the alert text is exercised by the actual binary.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPipeline } = require('../src/pipeline');
const { defaults } = require('../src/config');
const { ZebraRpc } = require('../src/zebra/rpc');

const ZEBRAD = process.env.ZEBRAD || 'zebrad';
const enabled = process.env.LW_REGTEST === '1' && spawnSync('which', [ZEBRAD]).status === 0;
const RPC_PORT = 18944;
const P2P_PORT = 18945;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, { timeoutMs = 30000, everyMs = 250 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

test('regtest: mine blocks, then kill the node', { skip: !enabled && 'set LW_REGTEST=1 with zebrad on PATH' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-regtest-'));
  const addr = 'tmHbxKkoHUTQptTtBj5cBXgLbMNjXg3NaJb'; // any valid regtest t-addr; coins are worthless
  fs.writeFileSync(path.join(dir, 'zebrad.toml'), `
[network]
network = "Regtest"
listen_addr = "127.0.0.1:${P2P_PORT}"
cache_dir = "${dir}/cache"
initial_mainnet_peers = []
initial_testnet_peers = []
[state]
cache_dir = "${dir}/cache"
[rpc]
listen_addr = "127.0.0.1:${RPC_PORT}"
enable_cookie_auth = true
cookie_dir = "${dir}"
[mining]
miner_address = "${addr}"
[tracing]
log_file = "${dir}/zebrad.log"
use_color = false
`);
  const node = spawn(ZEBRAD, ['-c', path.join(dir, 'zebrad.toml'), 'start'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  node.stderr.on('data', (d) => { stderr += d; });
  t.after(() => { if (node.exitCode === null) node.kill('SIGKILL'); });

  const cfg = structuredClone(defaults);
  Object.assign(cfg, { source: 'file', logFile: path.join(dir, 'zebrad.log'), label: 'regtest' });
  Object.assign(cfg.rpc, { url: `http://127.0.0.1:${RPC_PORT}`, cookieFile: path.join(dir, '.cookie'), timeoutMs: 5000 });
  Object.assign(cfg.thresholds, { tipStallMin: 0, minPeers: 0, blockLagS: 0, rpcFailCount: 2 });
  cfg.alerts.bundleDir = path.join(dir, 'bundles');
  const pages = [];
  const p = createPipeline(cfg, { sinks: [{ name: 't', send: async (m) => pages.push(m) }] });

  // wait for the node: cookie + log file appear, then RPC answers. Panics go
  // to stderr, so an early exit is reported with it.
  const exited = () => node.exitCode !== null || node.signalCode !== null;
  await until(() => exited() || (fs.existsSync(cfg.logFile) && fs.existsSync(cfg.rpc.cookieFile)), 'zebrad files');
  const rpc = new ZebraRpc(cfg.rpc);
  await until(async () => { if (exited()) return true; try { await rpc.call('getblockcount'); return true; } catch { return false; } }, 'zebrad rpc');
  if (exited()) throw new Error(`zebrad exited early:\n${stderr.slice(-2000)}`);

  p.source.start();
  await p.poll();
  assert.equal(p.detectors.state.rpc.ok, true);
  assert.match(p.detectors.state.node.build, /^v\d+\.\d+/);
  assert.equal(p.detectors.state.blockchain.blocks, 0);
  await until(() => p.detectors.state.node.network === 'Regtest', 'banner'); // from the startup banner
  assert.ok(pages.some((m) => m.alert.key === 'node_restarted'), 'startup banner pages once as node_restarted');

  const { result: hashes } = await rpc.call('generate', [3]);
  assert.equal(hashes.length, 3);
  await until(() => p.detectors.state.tip.height === 3, 'tip 3');
  assert.equal(p.detectors.state.tip.source, 'mined');
  assert.equal(p.detectors.state.tip.hash, hashes[2]);
  await until(() => p.detectors.state.lastBlock && p.detectors.state.lastBlock.height === 3, 'block detail');
  assert.equal(p.detectors.state.lastBlock.txs, 1); // coinbase only
  await p.poll();
  assert.equal(p.detectors.state.blockchain.blocks, 3);

  node.kill('SIGKILL');
  await until(exited, 'zebrad exit');
  await p.poll();
  await p.poll();
  await until(() => pages.some((m) => m.alert.key === 'rpc_down'), 'rpc_down page', { timeoutMs: 10000 });
  const down = pages.find((m) => m.alert.key === 'rpc_down');
  assert.match(down.text, /RPC unreachable/);
  assert.equal(JSON.parse(fs.readFileSync(down.alert.bundleFile, 'utf8')).tip.height, 3);
  p.stop();
});
