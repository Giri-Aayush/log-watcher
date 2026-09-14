// Overview page for the collector. Reads /api/analytics, /api/fleet and
// /api/incidents every 3 s, ticks the clock and every age once a second, and
// posts ack / respond / close. Plain DOM, no framework. Everything on the
// page comes from those responses except the engineer's name (localStorage)
// and the wall clock.
(() => {
  'use strict';

  const REFRESH_MS = 3000;
  const LATE_S = 10 * 60; // unacknowledged past this is red (the mock's redAfterMin)
  const AXIS = {
    '1h': ['−60m', '−45m', '−30m', '−15m', 'now'],
    '6h': ['−6h', '−4h', '−2h', 'now'],
    '24h': ['−24h', '−18h', '−12h', '−6h', 'now'],
    '7d': ['−7d', '−6d', '−5d', '−4d', '−3d', '−2d', '−1d', 'now'],
    '30d': ['−30d', '−20d', '−10d', 'now'],
  };
  const STATE_ORDER = { quiet: 0, critical: 1, degraded: 2, ok: 3 };
  // Which fleet-table cell an open incident is about, so that cell takes the
  // incident's color (the mock's red tip age and amber peer count).
  const CELL_KEYS = {
    tipAge: ['tip_stalled', 'tip_rewound', 'sync_stalled', 'block_lag'],
    peers: ['peers_low'],
    rpc: ['rpc_down', 'rpc_slow'],
    mempool: ['mempool_high'],
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked; the name lasts for this page load */ } },
  };

  const state = {
    win: '24h',
    filter: 'all', // 'all' | 'state:<state>' | 'net:<network>'
    by: (store.get('lw-by') || '').trim(),
    analytics: null,
    fleet: [],
    incidents: [], // open, non-transient, not suppressed
    fetchedAt: 0, // browser clock at the last successful fetch
    clockOffset: 0, // collector clock minus browser clock
    failed: false,
    oldestSince: null, // receivedAt of the oldest unacknowledged incident, collector clock
    rendered: {}, // last HTML per region, so an unchanged region is not rebuilt
  };

  // ---- formatting ----------------------------------------------------------

  // The mock's fmt(): "1h 05m", "2m 10s", "3s".
  function fmt(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    if (m) return m + 'm ' + String(sec).padStart(2, '0') + 's';
    return sec + 's';
  }
  const fmtMs = (ms) => (ms == null ? '—' : fmt(ms / 1000));
  const nowC = () => Date.now() + state.clockOffset;
  const ageS = (t) => (nowC() - t) / 1000;
  const pct = (x) => (x == null ? '—' : (x * 100).toFixed(1) + '%');
  const int = (n) => (n == null ? '—' : String(n));
  const netOf = (n) => n.network || (n.node && n.node.network) || null;

  // "12:41:07 UTC" today, "2026-09-13 12:41 UTC" otherwise
  function stamp(t) {
    const iso = new Date(t).toISOString();
    const today = new Date(nowC()).toISOString().slice(0, 10);
    return (iso.slice(0, 10) === today ? iso.slice(11, 19) : iso.slice(0, 10) + ' ' + iso.slice(11, 16)) + ' UTC';
  }

  function setText(id, text) {
    const el = $(id);
    if (el && el.textContent !== text) el.textContent = text;
  }
  function setHTML(region, el, html) {
    if (state.rendered[region] === html) return;
    state.rendered[region] = html;
    el.innerHTML = html;
  }

  // ---- data ------------------------------------------------------------------

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(url + ' -> ' + r.status);
    return r.json();
  }

  async function load() {
    const win = state.win;
    const t0 = Date.now();
    try {
      const [analytics, fleet, incidents] = await Promise.all([
        getJSON('/api/analytics?window=' + win),
        getJSON('/api/fleet'),
        getJSON('/api/incidents?state=open'),
      ]);
      if (win !== state.win) return; // the window changed while this was in flight
      state.analytics = analytics;
      state.fleet = Array.isArray(fleet) ? fleet : [];
      state.incidents = (Array.isArray(incidents) ? incidents : []).filter((i) => !i.transient && !i.resolvedAt && !i.suppressedBy);
      state.clockOffset = analytics.at - Math.round((t0 + Date.now()) / 2);
      state.fetchedAt = Date.now();
      state.failed = false;
      render();
    } catch (err) {
      console.error('refresh failed', err);
      state.failed = true;
      tick();
    }
  }

  let loadSeq = 0;
  let timer = null;
  async function refresh() {
    const seq = ++loadSeq;
    clearTimeout(timer);
    await load();
    if (seq !== loadSeq) return; // a newer refresh() owns the schedule now
    timer = setTimeout(refresh, REFRESH_MS);
  }

  // ---- render ----------------------------------------------------------------

  function render() {
    renderTopbar();
    renderHead();
    renderKpis();
    renderChart();
    renderFleet();
    renderIncidents();
    tick();
  }

  function renderOncall() {
    setText('oncall', state.by || '—');
  }

  function renderTopbar() {
    const crit = state.incidents.filter((i) => i.severity === 'critical').length;
    $('crit-pill').hidden = crit === 0;
    setText('crit-n', String(crit));
  }

  function renderHead() {
    const t = state.analytics.totals;
    for (const b of $('windows').children) b.classList.toggle('active', b.dataset.win === state.win);
    setText('t-nodes', int(t.nodes));
    setText('t-incidents', int(t.incidents));
    setText('t-open', int(t.open));
    setText('t-unacked', int(t.unacked));
    $('t-unacked').classList.toggle('crit', t.unacked > 0);
  }

  function renderKpis() {
    const a = state.analytics;
    for (const k of ['detect', 'ack', 'respond', 'resolve']) {
      const s = (a.latency && a.latency[k]) || { count: 0 };
      setText('k-' + k, s.count ? fmtMs(s.p50) : '—');
      setText('k-' + k + '-95', s.count ? '/ ' + fmtMs(s.p95) : '');
      setText('k-' + k + '-n', 'p50 / p95 · n=' + (s.count || 0));
    }
    state.oldestSince = a.oldestUnackedS == null ? null : a.at - a.oldestUnackedS * 1000;
    setText('k-avail', pct(a.availability));
    setText('k-avail-note', 'no critical open · ' + state.win);
    const top = (a.noisiest || [])[0];
    setText('k-noisy', top ? top.key : '—');
    setText('k-noisy-note', top ? top.count + ' of ' + a.totals.incidents + ' incidents' : 'no incidents · ' + state.win);
  }

  // One SVG path per severity, stacked: `below` lists the severities drawn
  // under this one. 960 wide, baseline at y=89, as in the mock.
  function bars(buckets, key, below, unit) {
    const n = buckets.length, w = 960 / n;
    const bw = Math.min(w - 12, 48), x0 = (w - bw) / 2; // the mock's 28-wide bar at 24 buckets; capped so 2 or 8 buckets do not become slabs
    let d = '';
    buckets.forEach((b, i) => {
      const v = b[key] || 0;
      if (!v) return;
      const base = below.reduce((s, k) => s + (b[k] || 0), 0) * unit;
      const h = v * unit;
      d += 'M' + (i * w + x0).toFixed(1) + ' ' + (89 - base - h).toFixed(1) + 'h' + bw.toFixed(1) + 'v' + h.toFixed(1) + 'h-' + bw.toFixed(1) + 'z';
    });
    return d;
  }

  function renderChart() {
    const a = state.analytics;
    const buckets = (a.timeline && a.timeline.buckets) || [];
    const daily = !!(a.timeline && a.timeline.bucketMs >= 86400e3);
    setText('chart-title', daily ? 'incidents per day' : 'incidents per hour');
    setText('lg-crit', int((a.bySeverity && a.bySeverity.critical) || 0));
    setText('lg-warn', int((a.bySeverity && a.bySeverity.warning) || 0));
    setText('lg-info', int(a.totals.events || 0));
    const max = buckets.reduce((m, b) => Math.max(m, (b.critical || 0) + (b.warning || 0) + (b.info || 0)), 0);
    const unit = max > 3 ? 84 / max : 28; // 28 per incident up to 3 (the mock); taller stacks scale to fit the 89px plot
    $('bars-info').setAttribute('d', buckets.length ? bars(buckets, 'info', [], unit) : '');
    $('bars-warn').setAttribute('d', buckets.length ? bars(buckets, 'warning', ['info'], unit) : '');
    $('bars-crit').setAttribute('d', buckets.length ? bars(buckets, 'critical', ['info', 'warning'], unit) : '');
    setHTML('axis', $('axis-labels'), (AXIS[state.win] || AXIS['24h']).map((l) => '<span>' + l + '</span>').join(''));
  }

  // color class for a metric cell: the most severe open incident about it
  function cellClass(keys, names, forceCrit) {
    if (forceCrit) return 'crit';
    let cls = '';
    for (const k of names) {
      const sev = keys.get(k);
      if (sev === 'critical') return 'crit';
      if (sev === 'warning') cls = 'warn';
    }
    return cls;
  }

  function renderFleet() {
    const fleet = state.fleet;
    const netTitles = new Map(state.incidents.map((i) => [i.id, i.title]));
    const count = (pred) => fleet.filter(pred).length;
    const networks = [...new Set(fleet.map(netOf).filter(Boolean))].sort();
    const chips = [
      ['all', 'all', fleet.length],
      ['state:critical', 'critical', count((n) => n.state === 'critical')],
      ['state:degraded', 'degraded', count((n) => n.state === 'degraded')],
      ['state:quiet', 'quiet', count((n) => n.state === 'quiet')],
      ...networks.map((net) => ['net:' + net, net, count((n) => netOf(n) === net)]),
    ];
    if (!chips.some(([id]) => id === state.filter)) state.filter = 'all';
    setHTML('chips', $('node-filters'), chips.map(([id, label, n]) =>
      '<button type="button" class="chip-f' + (id === state.filter ? ' active' : '') + '" data-filter="' + esc(id) + '">' + esc(label) + ' <span class="num">' + n + '</span></button>').join(''));

    const sep = state.filter.indexOf(':');
    const kind = sep < 0 ? 'all' : state.filter.slice(0, sep), value = sep < 0 ? '' : state.filter.slice(sep + 1);
    const rows = fleet
      .filter((n) => kind === 'all' || (kind === 'state' ? n.state === value : netOf(n) === value))
      .sort((a, b) => ((STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9)) || ((b.tipAgeS ?? -1) - (a.tipAgeS ?? -1)) || String(a.label).localeCompare(String(b.label)));

    let html;
    if (!rows.length) {
      html = '<tr class="empty-row"><td class="empty" colspan="12">' + (fleet.length ? 'No ' + esc(value) + ' nodes.' : 'No heartbeats yet.') + '</td></tr>';
    } else {
      html = rows.map((n) => {
        const quiet = n.state === 'quiet';
        const open = Array.isArray(n.open) ? n.open : [];
        const keys = new Map(open.map((o) => [o.key, o.severity])); // suppressed ones included: the tip is still stalled, the chip is what dims
        // live metrics are shown only while the heartbeat is current; a quiet node keeps its static facts
        const num = (v, cls) => (!quiet && v != null ? '<td class="r' + (cls ? ' ' + cls : '') + '">' + esc(v) + '</td>' : '<td class="r none">—</td>');
        const tags = open.map((o) => {
          const sup = o.suppressedBy ? (netTitles.get(o.suppressedBy) || o.suppressedBy) : null;
          return '<span class="tag ' + esc(o.severity) + (sup ? ' suppressed" title="suppressed: part of ' + esc(sup) : '') + '">' + esc(o.key) + (o.acked ? ' <span class="ack">✓</span>' : '') + '</span>';
        }).join('');
        return '<tr class="' + (quiet ? 'quiet' : '') + '" data-label="' + esc(n.label) + '" title="open node detail">'
          + '<td class="node">' + esc(n.label) + '</td>'
          + '<td><span class="state ' + esc(n.state) + '"><span class="dot"></span>' + esc(n.state) + '</span></td>'
          + (n.lastSeen ? '<td class="r seen" data-since="' + Number(n.lastSeen) + '"' + (quiet ? ' data-post=" ago"' : '') + '></td>' : '<td class="r seen none">—</td>')
          + '<td>' + esc((n.node && (n.node.build || n.node.version)) || '—') + '</td>'
          + '<td class="net">' + esc(netOf(n) || '—') + '</td>'
          + num(n.tip ? n.tip.height : null)
          + num(n.tipAgeS != null ? fmt(n.tipAgeS) : null, cellClass(keys, CELL_KEYS.tipAge))
          + num(n.peers, cellClass(keys, CELL_KEYS.peers))
          + num(n.rpc ? (n.rpc.ok === false ? 'down' : n.rpc.ms + ' ms') : null, cellClass(keys, CELL_KEYS.rpc, n.rpc && n.rpc.ok === false))
          + num(n.mempool ? n.mempool.size : null, cellClass(keys, CELL_KEYS.mempool))
          + num(n.logDelayMs != null ? n.logDelayMs + ' ms' : null)
          + (tags ? '<td><span class="tags">' + tags + '</span></td>' : '<td class="none">—</td>')
          + '</tr>';
      }).join('');
    }
    setHTML('fleet', $('fleet-body'), html);
  }

  function renderIncidents() {
    const list = [...state.incidents].sort((x, y) => ((x.ackedAt ? 1 : 0) - (y.ackedAt ? 1 : 0)) || (x.receivedAt - y.receivedAt));
    let html;
    if (!list.length) {
      const last = state.analytics.lastResolvedAt;
      html = '<div class="inc-empty">No open incidents.' + (last ? ' Last cleared ' + esc(stamp(last)) + '.' : '') + '</div>';
    } else {
      html = list.map((i) => {
        const acked = !!i.ackedAt, responded = !!i.respondedAt;
        const network = String(i.label).startsWith('network:');
        const status = responded ? 'responded · ' + (i.respondedBy || i.ackedBy || '?') : acked ? 'acked · ' + (i.ackedBy || '?') : 'unacknowledged';
        return '<div class="inc-row' + (acked ? '' : ' unacked') + '" data-id="' + esc(i.id) + '">'
          + '<span class="tag ' + esc(i.severity) + '">' + esc(i.severity) + '</span>'
          + '<span class="det" title="' + esc(i.key) + '">' + esc(i.key) + '</span>'
          + (network ? '<span class="node network">' + esc(i.label) + '</span>' : '<a class="node" href="/node.html?label=' + encodeURIComponent(i.label) + '">' + esc(i.label) + '</a>')
          + '<span class="title" title="' + esc(i.title) + '">' + esc(i.title) + '</span>'
          + '<span class="age' + (acked ? ' acked' : '') + '" data-since="' + Number(i.receivedAt) + '" data-pre="paged " data-post=" ago"' + (acked ? '' : ' data-late="1"') + '></span>'
          + '<span class="status' + (acked ? ' acked' : '') + '">' + esc(status) + '</span>'
          + '<div class="actions">'
          + '<button type="button" class="btn" data-act="ack"' + (acked ? ' disabled' : '') + '>Ack</button>'
          + '<button type="button" class="btn" data-act="respond"' + (responded ? ' disabled' : '') + '>Responded</button>'
          + '<button type="button" class="btn close" data-act="close">Close</button>'
          + '<a href="/incident.html?id=' + encodeURIComponent(i.id) + '">open →</a>'
          + '</div></div>';
      }).join('');
    }
    setHTML('incidents', $('inc-rows'), html);
  }

  // Once a second: the clock, "updated Ns ago", every age, and the oldest-unacknowledged tile.
  function tick() {
    setText('clock', new Date().toISOString().slice(11, 19) + ' UTC');
    $('live').classList.toggle('down', state.failed);
    setText('live-text', state.failed ? 'reconnecting' : state.fetchedAt ? 'live · updated ' + fmt((Date.now() - state.fetchedAt) / 1000) + ' ago' : 'connecting');

    for (const el of document.querySelectorAll('[data-since]')) {
      const age = ageS(Number(el.dataset.since));
      const text = (el.dataset.pre || '') + fmt(age) + (el.dataset.post || '');
      if (el.textContent !== text) el.textContent = text;
      if (el.dataset.late) el.classList.toggle('late', age > LATE_S);
    }

    const tile = $('k-oldest-tile');
    if (state.oldestSince == null) {
      tile.className = 'kpi ring-ok';
      setText('k-oldest', '—');
      setText('k-oldest-note', state.analytics ? 'all acknowledged' : '');
    } else {
      const age = ageS(state.oldestSince), late = age > LATE_S;
      tile.className = 'kpi ' + (late ? 'ring-crit' : 'ring-warn');
      setText('k-oldest', fmt(age));
      setText('k-oldest-note', late ? 'past ' + (LATE_S / 60) + 'm threshold' : 'red past ' + (LATE_S / 60) + 'm');
    }
  }

  // ---- actions ---------------------------------------------------------------

  function askName(current) {
    const by = prompt('Your name. It shows as "on call" and is recorded on the incidents you act on; remembered in this browser.', current || '');
    if (by == null) return null;
    state.by = by.trim();
    store.set('lw-by', state.by);
    renderOncall();
    return state.by;
  }

  async function act(id, action, btn) {
    const by = state.by || askName('');
    if (!by) return;
    let text = null;
    if (action === 'respond') { text = prompt('What did you tell the operator?'); if (text == null) return; }
    if (action === 'close') { text = prompt('Why is this being closed?'); if (text == null) return; }
    btn.disabled = true;
    try {
      const r = await fetch('/api/incidents/' + encodeURIComponent(id) + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ by, text: text && text.trim() ? text.trim() : null }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    } catch (err) {
      console.error(action + ' failed', err);
      alert('Could not ' + action + ' ' + id + ': ' + err.message);
      btn.disabled = false;
    }
    refresh();
  }

  $('inc-rows').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.inc-row');
    if (row) act(row.dataset.id, btn.dataset.act, btn);
  });

  $('windows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-win]');
    if (!b || b.dataset.win === state.win) return;
    state.win = b.dataset.win;
    for (const x of $('windows').children) x.classList.toggle('active', x === b);
    refresh();
  });

  $('fleet-body').addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    const row = e.target.closest('tr[data-label]');
    if (row) window.location.href = '/node.html?label=' + encodeURIComponent(row.dataset.label);
  });

  $('node-filters').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    state.filter = b.dataset.filter;
    if (state.analytics) renderFleet();
  });

  $('oncall').addEventListener('click', () => askName(state.by));

  renderOncall();
  tick();
  setInterval(tick, 1000);
  refresh();
})();
