// The sidecar's own page, served by server.js next to zebrad: the operator's
// view of one node. Everything on it comes from the sidecar's Socket.IO
// stream — the init snapshot, then state / log / event / alert / resolve —
// except the wall clock. Plain DOM, no framework; layout follows
// design/Zero Sidecar.dc.html.
(() => {
  'use strict';

  const LOG_KEEP = 2000; // entries kept in memory
  const LOG_SHOW = 400; // rows rendered
  const EVENTS_KEEP = 200;
  const PAGES_KEEP = 200;
  const FEED_SHOW = 40;
  const SPARK_N = 40; // RPC polls in the sparkline
  const LIVE_MS = 30000; // a log line within this long means "live"
  const RANK = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4 };
  const MIN_RANK = { all: 0, info: 2, warn: 3, error: 4 };
  const SEV = { critical: 0, warning: 1, info: 2 };
  // feed label and color per event type; an unknown type shows its raw name
  const FEED_TYPES = {
    block_committed: ['block', 'ok'],
    sync_progress: ['sync', 'info'],
    node_started: ['node', 'accent'],
    end_of_support: ['support', 'accent'],
    end_of_support_imminent: ['support', 'crit'],
    log_warn: ['warn', 'warn'],
    log_error: ['error', 'crit'],
    page: ['page', 'crit'],
    resolved: ['resolved', 'ok'],
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked; the choice lasts for this page load */ } },
  };

  const s = {
    connected: false,
    label: '', source: '', rpcUrl: '', consoleUrl: null, sidecar: {}, thresholds: {},
    state: null,
    counters: {},
    active: [], // non-transient, unresolved alerts
    seen: new Map(), // alert id -> severity, to tell a new page from an update
    logs: [], // parsed entries, oldest first
    events: [], // parser events, oldest first
    pages: [], // feed entries made from alert / resolve messages
    level: MIN_RANK[store.get('lw-log-level')] != null ? store.get('lw-log-level') : 'all',
    shown: 0, // log rows on screen
    lastLogAt: null, // sidecar clock
    clockOffset: 0, // sidecar clock minus browser clock, from log receive stamps
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
  const nowC = () => Date.now() + s.clockOffset;
  const valid = (t) => t != null && !Number.isNaN(new Date(t).getTime());
  const hms = (t) => (valid(t) ? new Date(t).toISOString().slice(11, 19) : '—');
  const hmsMs = (t) => (valid(t) ? new Date(t).toISOString().slice(11, 23) : '—');
  const int = (x) => (x == null ? '—' : String(x));
  const count = (x) => (x == null ? '—' : Number(x).toLocaleString('en-US'));
  const kB = (b) => (b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e3).toFixed(1) + ' kB');
  const kiB = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MiB' : (b / 1024).toFixed(1) + ' KiB');
  const stripScheme = (u) => String(u).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');

  function setText(id, text) {
    const el = $(id);
    if (el && el.textContent !== text) el.textContent = text;
  }
  // tile sub-lines are one line with an ellipsis; the title holds the rest
  function setSub(id, text) {
    const el = $(id);
    if (el.textContent === text) return;
    el.textContent = text;
    el.title = text;
  }
  function setHTML(region, el, html) {
    if (s.rendered[region] === html) return;
    s.rendered[region] = html;
    el.innerHTML = html;
  }
  // crit / warn on a value; the flash class, if any, is left alone
  function setTone(id, tone) {
    const el = $(id);
    el.classList.toggle('crit', tone === 'crit');
    el.classList.toggle('warn', tone === 'warn');
  }
  // A counter that changed pulses once; while it keeps changing the pulse
  // restarts only after it has finished, so a busy stream is a slow blink.
  function setCounter(id, text) {
    const el = $(id);
    if (el.textContent === text) return;
    const first = el.textContent === '—';
    el.textContent = text;
    if (!first && !el.classList.contains('flash')) el.classList.add('flash');
  }
  document.addEventListener('animationend', (e) => { if (e.animationName === 'flash') e.target.classList.remove('flash'); });

  // ---- render ----------------------------------------------------------------

  function renderAll() {
    renderTopbar();
    renderHead();
    renderTiles();
    renderAlerts();
    renderBlock();
    renderFeed();
    renderLog();
    tick();
  }

  function renderTopbar() {
    const sc = s.sidecar || {};
    setText('brand-meta', [sc.version, sc.host].filter(Boolean).join(' · '));
    const d = s.counters.delivery;
    let cls = '', text;
    if (!s.connected) text = s.state ? 'sidecar unreachable · reconnecting' : 'connecting to sidecar';
    else if (!s.consoleUrl) text = 'standalone · no collector configured';
    else if (d && d.consecutiveFailures > 0) { cls = 'down'; text = 'Zero unreachable · ' + count(d.queued) + ' queued, retrying'; }
    else if (d && d.lastDeliveredAt) { cls = 'ok'; text = 'connected to Zero · heartbeat acked ' + fmt((nowC() - d.lastDeliveredAt) / 1000) + ' ago'; }
    else text = 'Zero configured · nothing delivered yet';
    $('link').className = 'link' + (cls ? ' ' + cls : '');
    setText('link-text', text);
    const a = $('console-link');
    a.hidden = !s.consoleUrl;
    if (s.consoleUrl && a.getAttribute('href') !== s.consoleUrl) a.href = s.consoleUrl;
  }

  function renderHead() {
    const st = s.state || {};
    setText('label', s.label);

    let state, cls;
    if (!s.connected) { state = s.state ? 'disconnected' : 'connecting'; cls = 'quiet'; }
    else if (s.active.some((a) => a.severity === 'critical')) { state = 'critical'; cls = 'critical'; }
    else if (s.active.length) { state = 'degraded'; cls = 'degraded'; }
    else if (st.rpc && st.rpc.ok === false) { state = 'rpc down'; cls = 'critical'; }
    else { state = 'ok'; cls = 'ok'; }
    $('state').className = 'state ' + cls;
    setText('state-text', state);

    const n = st.node || {};
    const facts = [
      n.network,
      (n.build || n.version) ? 'zebrad ' + (n.build || n.version) : null,
      s.source,
      s.rpcUrl ? 'rpc ' + stripScheme(s.rpcUrl) : null,
    ].filter(Boolean);
    setHTML('facts', $('facts'), facts.map((f) => '<span title="' + esc(f) + '">' + esc(f) + '</span>').join(''));

    const c = s.counters;
    if (c.lines != null) for (const k of ['lines', 'events', 'polls', 'pages']) setCounter('c-' + k, count(c[k] || 0));
    const d = c.delivery;
    $('pipe-delivery').hidden = !d;
    if (d) {
      setCounter('c-delivered', count(d.delivered));
      const q = $('c-queued');
      q.hidden = !d.queued;
      if (d.queued) { setText('c-queued', '+' + count(d.queued) + ' queued'); q.classList.toggle('down', d.consecutiveFailures > 0); }
    }
  }

  function renderTiles() {
    const st = s.state || {};
    const t = s.thresholds || {};
    const sc = s.sidecar || {};

    const tip = st.tip || {};
    setText('tip-v', int(tip.height));
    setSub('tip-s', tip.hash ? tip.hash.slice(0, 12) + '…' : tip.height != null && tip.source ? 'via ' + tip.source : 'no block seen yet');
    renderTipAge();

    const ps = st.peerSummary;
    setText('peers-v', int(st.peers));
    setSub('peers-s', (ps ? int(ps.inbound) + ' in · ' + int(ps.outbound) + ' out · ' : '') + 'min ' + int(t.minPeers));
    setTone('peers-v', st.peers == null ? '' : st.peers === 0 && t.minPeers > 0 ? 'crit' : st.peers < t.minPeers ? 'warn' : '');

    const r = st.rpc || {};
    setText('rpc-v', r.ok === false ? 'down' : r.ms != null ? r.ms + ' ms' : '—');
    setTone('rpc-v', r.ok === false ? 'crit' : r.ms > t.rpcSlowMs ? 'warn' : '');
    setSub('rpc-s', r.ok === false && r.lastError ? String(r.lastError.message || '') : sc.pollMs > 0 ? 'getblockchaininfo · ' + sc.pollMs / 1000 + 's' : 'rpc polling off');
    setHTML('spark', $('rpc-spark'), sparkline(r.history || []));

    const m = st.mempool;
    setText('mem-v', m ? int(m.size) : '—');
    setSub('mem-s', m && m.bytes != null ? kB(m.bytes) : '');

    const sy = st.sync || {};
    const bc = st.blockchain;
    setText('sync-v', sy.percent != null ? Number(sy.percent).toFixed(3) + '%' : sy.state ? sy.state.replace('_', ' ') : '—');
    setTone('sync-v', sy.state === 'stalled' ? 'crit' : sy.state === 'very_slow' ? 'warn' : '');
    let sub = '';
    if (bc && bc.estimatedheight != null && bc.blocks != null) {
      const delta = bc.blocks - bc.estimatedheight;
      const signed = delta < 0 ? '−' + (-delta) : '+' + delta;
      sub = 'est. height ' + esc(bc.estimatedheight) + ' · <span' + (delta < 0 ? ' class="warn"' : '') + '>' + signed + '</span>';
    } else if (sy.remaining) sub = esc(sy.remaining) + ' blocks left';
    setHTML('sync-s', $('sync-s'), sub);
    $('sync-s').title = $('sync-s').textContent;

    const g = st.gbt;
    const gbt = !!(g && g.at);
    $('gbt-tile').hidden = !gbt;
    if (gbt) {
      setText('gbt-v', g.ok === false ? 'FAILING' : g.ms != null ? g.ms + ' ms' : '—');
      setTone('gbt-v', g.ok === false ? 'crit' : g.ms > t.gbtSlowMs ? 'warn' : '');
      setSub('gbt-s', g.ok === false ? String(g.error || '') : 'template h' + int(g.height) + ' · ' + int(g.txs) + ' txs');
    }
  }

  function renderTipAge() {
    const tip = (s.state && s.state.tip) || {};
    const min = (s.thresholds || {}).tipStallMin;
    const age = tip.at ? (nowC() - tip.at) / 1000 : null;
    setText('age-v', age == null ? '—' : fmt(age));
    setTone('age-v', age != null && min > 0 && age >= min * 60 ? 'crit' : '');
    setSub('age-s', min > 0 ? 'stall threshold ' + min * 60 + 's' : 'stall detection off');
  }

  // Last SPARK_N polls, newest at the right edge, one slot per poll so a
  // fresh sidecar draws a short line rather than a stretched one. Failed
  // polls are red ticks and break the line.
  function sparkline(history) {
    const pts = history.slice(-SPARK_N);
    if (!pts.length) return '';
    const step = 200 / (SPARK_N - 1);
    const ok = pts.filter((p) => p.ok && p.ms != null).map((p) => p.ms);
    const max = Math.max(10, ...ok);
    let d = '', run = 0, ticks = '';
    pts.forEach((p, i) => {
      const x = (200 - (pts.length - 1 - i) * step).toFixed(1);
      if (p.ok && p.ms != null) {
        const y = (28 - (p.ms / max) * 26).toFixed(1);
        d += (run ? 'L' : 'M') + x + ' ' + y + (run ? '' : 'l0.01 0');
        run++;
      } else {
        run = 0;
        ticks += '<line class="fail" x1="' + x + '" y1="4" x2="' + x + '" y2="28"></line>';
      }
    });
    return (d ? '<path class="series" d="' + d + '"></path>' : '') + ticks;
  }

  function alertHtml(a) {
    const meta = ['paged ' + hms(a.firstSeen)];
    if (a.deliveredAt) meta.push('delivered to Zero');
    else if (s.consoleUrl) meta.push('queued');
    if (a.count > 1) meta.push('×' + a.count);
    const next = a.suggest ? '<span class="lbl">next:</span> ' + esc(a.suggest) : esc(a.detail || '');
    return '<div class="alert ' + esc(a.severity) + '">'
      + '<div class="alert-head">'
      + '<span class="tag ' + esc(a.severity) + '">' + esc(a.severity) + '</span>'
      + '<span class="key">' + esc(a.key) + '</span>'
      + '<span class="title" title="' + esc(a.title) + '">' + esc(a.title) + '</span>'
      + '<span class="meta">' + esc(meta.join(' · ')) + ' · <a href="/api/alerts/' + encodeURIComponent(a.id) + '" target="_blank" rel="noopener">bundle</a></span>'
      + '</div>'
      + (next ? '<div class="next">' + next + '</div>' : '')
      + (a.triage ? '<details class="triage"><summary>triage draft (' + esc(a.triage.model) + ') — for a human to approve</summary><pre>' + esc(a.triage.text) + '</pre></details>' : '')
      + '</div>';
  }

  function renderAlerts() {
    const list = [...s.active].sort((a, b) => ((SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9)) || (a.firstSeen - b.firstSeen));
    setText('alerts-n', list.length ? String(list.length) : '');
    setHTML('alerts', $('alerts'), list.length ? list.map(alertHtml).join('') : '<div class="empty">nothing active</div>');
  }

  // Hidden until getblock has answered for a committed block. The header
  // shows when this sidecar saw the commit (tip.at, while the tip is still
  // that block); otherwise only the block header's own timestamp is known.
  function renderBlock() {
    const st = s.state || {};
    const b = st.lastBlock;
    $('block-card').hidden = !b;
    if (!b) return;
    const tip = st.tip || {};
    const seen = tip.at && tip.height === b.height;
    setText('block-when', seen ? 'seen ' + hms(tip.at) : b.time ? 'header time ' + hms(b.time * 1000) : '');
    setText('block-height', int(b.height));
    setText('block-size', b.size != null ? kiB(b.size) : '—');
    setText('block-txs', int(b.txs));
    setText('block-lag', st.logDelayMs != null ? st.logDelayMs + ' ms' : '—');
  }

  const pageEntry = (a) => ({ at: a.firstSeen, type: 'page', text: a.key + ' ' + a.severity + ' — ' + a.title });
  const escalationEntry = (a) => ({ at: a.notifiedAt || a.lastSeen, type: 'page', text: a.key + ' escalated to ' + a.severity + ' — ' + a.title });
  const resolvedEntry = (a) => ({ at: a.resolved.at, type: 'resolved', text: a.key + (a.resolved.detail ? ' — ' + a.resolved.detail : '') });
  function notePage(entry) {
    s.pages.push(entry);
    if (s.pages.length > PAGES_KEEP) s.pages.shift();
  }

  function feedHtml(f) {
    const [label, cls] = FEED_TYPES[f.type] || [f.type, ''];
    return '<div class="ev' + (f.replay ? ' replay' : '') + '">'
      + '<span class="t">' + hms(f.at) + '</span>'
      + '<span class="ty' + (cls ? ' ' + cls : '') + '">' + esc(label) + '</span>'
      + '<span class="x" title="' + esc(f.text) + '">' + esc(f.text) + '</span>'
      + (f.replay ? '<span class="hist">history</span>' : '')
      + '</div>';
  }

  // Parser events and pages / resolves in one list, newest first.
  function renderFeed() {
    const all = s.events.concat(s.pages).map((e, i) => [e, i])
      .sort((a, b) => (b[0].at - a[0].at) || (b[1] - a[1])) // same millisecond: later arrival first
      .slice(0, FEED_SHOW).map(([e]) => e);
    setHTML('feed', $('feed'), all.length ? all.map(feedHtml).join('') : '<div class="empty">waiting for the first log line</div>');
  }

  function renderLive() {
    const live = s.lastLogAt != null && nowC() - s.lastLogAt < LIVE_MS;
    $('live').classList.toggle('on', live);
    setText('live-text', live ? 'live' : 'quiet');
  }

  const passes = (e) => (RANK[e.level] ?? 0) >= MIN_RANK[s.level];

  function lineHtml(e) {
    const fields = Object.entries(e.fields || {}).map(([k, v]) => esc(k) + '=' + esc(v)).join(' ');
    return '<div class="line ' + esc(e.level) + '" title="' + esc(e.raw) + '">'
      + '<span class="t">' + (valid(e.time) ? hmsMs(e.time) : esc(String(e.ts || '').slice(11, 23))) + '</span>'
      + '<span class="lv">' + esc(e.level) + '</span>'
      + '<span class="m">' + (e.target ? '<span class="tg">' + esc(e.target) + ':</span> ' : '') + esc(e.message) + (fields ? ' <span class="f">' + fields + '</span>' : '') + '</span>'
      + '</div>';
  }

  function renderLogHead() {
    for (const b of $('levels').children) b.classList.toggle('active', b.dataset.level === s.level);
    setText('log-n', s.shown + ' lines · ' + s.source);
  }

  function renderLog() {
    const rows = s.logs.filter(passes).slice(-LOG_SHOW).reverse();
    s.shown = rows.length;
    $('log').innerHTML = rows.length ? rows.map(lineHtml).join('') : '<div class="empty">no lines yet</div>';
    renderLogHead();
  }

  // Once a second: the clock and everything that ages.
  function tick() {
    setText('clock', new Date().toISOString().slice(11, 19) + ' UTC');
    renderTopbar();
    renderTipAge();
    renderLive();
  }

  // ---- socket ------------------------------------------------------------------

  const socket = io();

  socket.on('init', (snap) => {
    s.connected = true;
    s.label = snap.label || '';
    s.source = snap.source || '';
    s.rpcUrl = snap.rpcUrl || '';
    s.consoleUrl = snap.consoleUrl || null;
    s.sidecar = snap.sidecar || {};
    s.thresholds = snap.thresholds || {};
    s.state = snap.state || {};
    s.counters = snap.counters || {};
    s.active = ((snap.alerts && snap.alerts.active) || []).filter((a) => !a.transient && !a.resolved);
    s.logs = (snap.logs || []).slice(-LOG_KEEP);
    s.events = (snap.events || []).slice(-EVENTS_KEEP);
    s.pages = [];
    s.seen = new Map();
    for (const a of ((snap.alerts && snap.alerts.history) || []).slice().reverse()) {
      s.seen.set(a.id, a.severity);
      notePage(pageEntry(a));
      if (a.resolved) notePage(resolvedEntry(a));
    }
    const stream = s.state.stream;
    s.lastLogAt = stream && stream.lastReceivedAt ? stream.lastReceivedAt : null;
    document.title = (s.label ? s.label + ' · ' : '') + 'zero-sidecar';
    renderAll();
  });

  socket.on('state', (m) => {
    s.state = m.state || m;
    if (m.counters) s.counters = m.counters;
    renderHead();
    renderTiles();
    renderBlock();
    renderTopbar();
  });

  socket.on('log', (e) => {
    s.logs.push(e);
    if (s.logs.length > LOG_KEEP) s.logs.shift();
    if (e.receivedAt) { s.clockOffset = e.receivedAt - Date.now(); s.lastLogAt = e.receivedAt; }
    if (passes(e)) {
      const el = $('log');
      if (!s.shown) el.innerHTML = '';
      el.insertAdjacentHTML('afterbegin', lineHtml(e));
      while (el.children.length > LOG_SHOW) el.lastChild.remove();
      s.shown = el.children.length;
      renderLogHead();
    }
    renderLive();
  });

  socket.on('event', (e) => {
    s.events.push(e);
    if (s.events.length > EVENTS_KEEP) s.events.shift();
    renderFeed();
    if (e.type === 'block_committed' && !e.replay) $('tip-v').classList.add('flash');
  });

  // 'alert' carries new pages and updates to known ones (count, escalation,
  // triage draft, delivery); only a new id or a new severity is a page event.
  socket.on('alert', (a) => {
    const prev = s.seen.get(a.id);
    if (prev === undefined) notePage(pageEntry(a));
    else if (prev !== a.severity) notePage(escalationEntry(a));
    s.seen.set(a.id, a.severity);
    if (!a.transient && !a.resolved) {
      const i = s.active.findIndex((x) => x.id === a.id);
      if (i === -1) s.active.push(a); else s.active[i] = a;
    }
    renderAlerts();
    renderHead();
    renderFeed();
  });

  socket.on('resolve', (a) => {
    s.active = s.active.filter((x) => x.key !== a.key);
    if (a.resolved) notePage(resolvedEntry(a));
    renderAlerts();
    renderHead();
    renderFeed();
  });

  socket.on('disconnect', () => {
    s.connected = false;
    renderHead();
    renderTopbar();
  });

  $('levels').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-level]');
    if (!b || b.dataset.level === s.level) return;
    s.level = b.dataset.level;
    store.set('lw-log-level', s.level);
    renderLog();
  });

  renderLogHead();
  tick();
  setInterval(tick, 1000);
})();
