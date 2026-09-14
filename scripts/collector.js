#!/usr/bin/env node
// Runs the collector (src/collector.js): the Zero-side end of the sidecar's
// webhook — incident record, response-time analytics, fleet view.
//
//   node scripts/collector.js                                    # :4000, data in ./collected
//   LW_WEBHOOK_URL=http://collector:4000/ingest node server.js   # on each node
const { createCollector } = require('../src/collector');

const PORT = Number(process.env.COLLECTOR_PORT || 4000);
const { app, store } = createCollector({
  dir: process.env.COLLECTOR_DIR || 'collected',
  quietMs: Number(process.env.COLLECTOR_QUIET_MS || 60000),
});

store.listeners.add((type, p) => {
  const ts = new Date().toISOString();
  if (type === 'incident') {
    const lastNote = p.notes[p.notes.length - 1];
    const lastUpdate = p.updates[p.updates.length - 1];
    const what = lastNote && (!lastUpdate || lastNote.at >= lastUpdate.at) ? `${lastNote.action.toUpperCase()} by ${lastNote.by}` : lastUpdate.phase;
    console.log(`${ts} ${what.padEnd(12)} ${p.label}  ${p.severity.padEnd(8)} ${p.key}: ${p.title}`);
  } else if (type === 'node') {
    console.log(`${ts} ${p.event === 'quiet' ? 'QUIET' : 'RECOVERED'} ${p.label}${p.silentMs ? ` — no heartbeat for ${Math.round(p.silentMs / 1000)}s` : ''}`);
  }
});

app.listen(PORT, () => console.log(`[collector] :${PORT} — fleet http://localhost:${PORT}/  data ${store.dir}/`));
