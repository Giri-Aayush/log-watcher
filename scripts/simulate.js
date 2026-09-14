#!/usr/bin/env node
// A fake zebrad for demos and tests: writes Zebra-format log lines to a file
// and answers the RPC calls the sidecar makes, with scenarios that inject the
// failure modes we care about. No node required.
//
//   node scripts/simulate.js --log /tmp/sim.log --port 18999 --scenario stall
//
// Scenarios (--scenario a,b,c or "all"):
//   stall     blocks stop after 45s (tip_stalled; needs LW_TIP_STALL_MIN=1)
//   peers     peer count drops to 0 at 30s, back at 90s (peers_low)
//   rpc-slow  RPC latency jumps to 3s at 40s (rpc_slow), back at 80s
//   rpc-down  RPC refuses connections 50s..90s (rpc_down + resolve)
//   errors    a burst of WARN/ERROR lines at 35s (log_error, error_burst)
//   restart   startup banner at 60s (node_restarted)
//   bigblock  a 7,000-tx block at 70s (large_block)
//   mempool   mempool climbs past 5000 at 50s (mempool_high)
//   zebra-stall  Zebra's own "chain updates have stalled" warning at 55s

const fs = require('fs');
const http = require('http');

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : [])).filter(Boolean));
const LOG = args.log || 'sim-zebrad.log';
const PORT = Number(args.port || 18999);
const BLOCK_MS = Number(args['block-ms'] || 15000);
const scenarios = new Set(args.scenario === 'all' ? ['stall', 'peers', 'rpc-slow', 'rpc-down', 'errors', 'restart', 'bigblock', 'mempool', 'zebra-stall'] : String(args.scenario || '').split(',').filter(Boolean));

const state = { height: 4345594, peers: 8, mempool: 12, latencyMs: 0, down: false, mining: true, bigNext: false };
const startedAt = Date.now();
const hashes = new Map();
const hashOf = (h) => hashes.get(h) || (hashes.set(h, '0000' + require('crypto').createHash('sha256').update(String(h)).digest('hex').slice(4)), hashes.get(h));
const ts = () => new Date().toISOString().replace('Z', '000Z');
const write = (line) => fs.appendFileSync(LOG, line + '\n');

function banner() {
  write(`${ts()}  INFO zebrad::application: Diagnostic metadata:`);
  write('version: 6.3.0');
  write('Zcash network: Testnet');
  write('running state version: 28.0.0');
  write(`${ts()}  INFO zebrad::commands::start: spawning block gossip task`);
  write(`${ts()}  INFO zebrad::components::sync::end_of_support: Release always valid in Testnet`);
}

function commitBlock() {
  state.height++;
  const h = hashOf(state.height);
  write(`${ts()}  INFO {peer=In("v4redacted:42588")}:msg_as_req{msg="inv"}:inbound:download_and_verify{advertiser=Some(v4redacted:42588) hash=${h}}: zebrad::components::inbound::downloads: `);
  write(`${ts()}  INFO zebrad::components::sync::gossip: height=Height(${state.height}) request=AdvertiseBlock(block::Hash("${h}"), None) log_msg="sending committed block broadcast"`);
  if (state.height % 4 === 0) {
    write(`${ts()}  INFO zebrad::components::sync::progress: finished initial sync to chain tip, using gossiped blocks sync_percent=100.000% current_height=Height(${state.height}) network_upgrade=Nu6_3 remaining_sync_blocks=0 time_since_last_state_block=0s`);
  }
}

fs.writeFileSync(LOG, '');
banner();
commitBlock();
setInterval(() => { if (state.mining) commitBlock(); }, BLOCK_MS);
setInterval(() => write(`${ts()}  INFO sync: zebrad::components::sync: waiting to restart sync timeout=67s state_tip=Some(Height(${state.height}))`), 20000);

const at = (s, fn) => setTimeout(fn, s * 1000);
if (scenarios.has('stall')) at(45, () => { state.mining = false; console.log('[sim] blocks stopped'); });
if (scenarios.has('peers')) { at(30, () => { state.peers = 0; console.log('[sim] peers -> 0'); }); at(90, () => { state.peers = 8; console.log('[sim] peers -> 8'); }); }
if (scenarios.has('rpc-slow')) { at(40, () => { state.latencyMs = 3000; console.log('[sim] rpc latency 3s'); }); at(80, () => { state.latencyMs = 0; }); }
if (scenarios.has('rpc-down')) { at(50, () => { state.down = true; console.log('[sim] rpc down'); }); at(90, () => { state.down = false; console.log('[sim] rpc up'); }); }
if (scenarios.has('errors')) at(35, () => {
  console.log('[sim] error burst');
  for (let i = 0; i < 12; i++) write(`${ts()}  WARN {peer=Out("v4redacted:18233")}:msg_as_req{msg="getdata"}: zebra_network::peer::connection: peer error: connection reset by peer error=Io(Os { code: 54, kind: ConnectionReset })`);
  write(`${ts()} ERROR zebra_state::service::finalized_state::disk_db: failed to write block to database error=IO error: No space left on device height=Height(${state.height})`);
});
if (scenarios.has('restart')) at(60, () => { console.log('[sim] restart'); banner(); });
if (scenarios.has('bigblock')) at(70, () => { state.bigNext = true; commitBlock(); console.log('[sim] big block'); });
if (scenarios.has('mempool')) at(50, () => { state.mempool = 7400; console.log('[sim] mempool 7400'); });
if (scenarios.has('zebra-stall')) at(55, () => write(`${ts()}  WARN zebrad::components::sync::progress: chain updates have stalled, state height has not increased for 12 minutes. Hint: check your network connection, and your computer clock and time zone sync_percent=100.000% current_height=Height(${state.height}) network_upgrade=Nu6_3 time_since_last_state_block=12m 3s target_block_spacing=75s max_block_spacing=8m 45s is_syncer_stopped=true`));

http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (state.down) return req.socket.destroy();
    let id = null;
    let method = null;
    let params = [];
    try { ({ id, method, params = [] } = JSON.parse(body)); } catch { /* not json */ }
    const big = state.bigNext && String(params[0]) === hashOf(state.height);
    const results = {
      getblockchaininfo: { chain: 'test', blocks: state.height, headers: state.height, bestblockhash: hashOf(state.height), estimatedheight: state.height, verificationprogress: 1.0, size_on_disk: 11542780305 },
      getinfo: { version: 6030000, build: 'v6.3.0', subversion: '/Zebra:6.3.0/', protocolversion: 170160, blocks: state.height, connections: state.peers, testnet: true, errors: '', errorstimestamp: 0 },
      getpeerinfo: new Array(state.peers).fill(0).map((_, i) => ({ addr: `v4redacted:${18233 + i}`, inbound: i % 3 === 0 })),
      getmempoolinfo: { size: state.mempool, bytes: state.mempool * 320, usage: state.mempool * 900 },
      getblock: { hash: String(params[0]), height: state.height, nTx: big ? 7000 : 3, size: big ? 1980000 : 4800, time: Math.floor(Date.now() / 1000) - 4, tx: [] },
    };
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      if (!results[method]) return res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: results[method] }));
    }, state.latencyMs);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[sim] fake zebrad: rpc http://127.0.0.1:${PORT}  log ${LOG}  scenarios: ${[...scenarios].join(',') || 'none'}`);
  console.log(`[sim] run: LW_SOURCE=file LW_LOG_FILE=${LOG} LW_RPC_URL=http://127.0.0.1:${PORT} LW_TIP_STALL_MIN=1 LW_POLL_MS=5000 npm start`);
});
