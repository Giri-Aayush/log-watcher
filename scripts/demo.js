#!/usr/bin/env node
// Fake node + sidecar + collector in one command, with every failure scenario
// firing over ~90 seconds. Open http://localhost:3000 (sidecar) and
// http://localhost:4000 (collector) and watch.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const log = path.join(os.tmpdir(), `lw-demo-${process.pid}.log`);
const env = {
  ...process.env,
  LW_LABEL: 'demo-testnet',
  LW_SOURCE: 'file',
  LW_LOG_FILE: log,
  LW_RPC_URL: 'http://127.0.0.1:18999',
  LW_POLL_MS: '5000',
  LW_TIP_STALL_MIN: '1',
  LW_RPC_FAIL_COUNT: '2',
  LW_RPC_SLOW_MS: '1000',
  LW_ERROR_BURST: '5',
  LW_WEBHOOK_URL: process.env.LW_WEBHOOK_URL || 'http://127.0.0.1:4000/ingest',
  LW_PORT: process.env.LW_PORT || '3000',
};
const run = (name, args, e = process.env) => {
  const child = spawn(process.execPath, args, { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => process.stdout.write(String(d).replace(/^/gm, `${name.padEnd(9)} `)));
  return child;
};
const collector = run('collector', [path.join(__dirname, 'collector.js')]);
const sim = run('sim', [path.join(__dirname, 'simulate.js'), '--log', log, '--port', '18999', '--scenario', process.argv[2] || 'all']);
setTimeout(() => {
  const sidecar = run('sidecar', [path.join(__dirname, '..', 'server.js')], env);
  process.on('SIGINT', () => { sidecar.kill(); sim.kill(); collector.kill(); process.exit(0); });
}, 1500);
