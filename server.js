const path = require('path');
const express = require('express');
const { loadConfig } = require('./src/config');
const { createPipeline } = require('./src/pipeline');

const cfg = loadConfig();
const pipeline = createPipeline(cfg);

const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  const s = pipeline.detectors.state;
  const active = pipeline.alerts.list().active;
  const critical = active.some((a) => a.severity === 'critical');
  res.status(critical ? 503 : 200).json({
    status: critical ? 'critical' : active.length ? 'degraded' : 'ok',
    label: cfg.label,
    tip: s.tip,
    peers: s.peers,
    rpc: s.rpc,
    node: s.node,
    activeAlerts: active.map((a) => ({ key: a.key, severity: a.severity, title: a.title, since: a.firstSeen })),
  });
});

app.get('/api/state', (req, res) => res.json(pipeline.snapshot(0)));
app.get('/api/logs', (req, res) => res.json(pipeline.logRing.last(Number(req.query.n) || 300)));
app.get('/api/alerts', (req, res) => res.json(pipeline.alerts.list()));
app.get('/api/alerts/:id', (req, res) => {
  const alert = pipeline.alerts.history.find((a) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'not found' });
  res.json({ ...alert.bundle, triage: alert.triage || null });
});
app.get(['/log', '/logs'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// One broadcast per event. Listeners live on the pipeline bus, not inside
// the connection handler, so a client that disconnects leaves nothing behind.
io.on('connection', (socket) => socket.emit('init', pipeline.snapshot()));
pipeline.bus.on('log', (entry) => io.emit('log', entry));
pipeline.bus.on('state', () => io.emit('state', pipeline.detectors.state));
pipeline.bus.on('alert', (a) => io.emit('alert', a));
pipeline.bus.on('update', (a) => io.emit('alert', a));
pipeline.bus.on('resolve', (a) => io.emit('resolve', a));
pipeline.bus.on('error', (err) => console.error(`[log-watcher] ${err.message}`));
pipeline.bus.on('source_exit', ({ code, signal }) => console.error(`[log-watcher] log source exited (code=${code} signal=${signal}); reattaching`));
pipeline.bus.on('source_rotate', ({ reason }) => console.error(`[log-watcher] log file rotated (${reason})`));

pipeline.start();
http.listen(cfg.port, () => {
  console.log(`[log-watcher] ${cfg.label}: watching ${pipeline.snapshot(0).source}, rpc ${cfg.rpc.url}, dashboard http://localhost:${cfg.port}/`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    pipeline.stop();
    io.close();
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
