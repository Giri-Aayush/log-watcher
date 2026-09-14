// Node detail page for the collector. Reads /api/fleet, /api/series/:label,
// /api/incidents and /api/analytics every 3 s, ticks the clock and every age
// once a second. Plain DOM, no framework, inline SVG for the charts.
// Everything on the page comes from those responses for the node named in
// ?label=; the only exceptions are the engineer's name (localStorage) and the
// wall clock.
(() => {
  'use strict';

  const REFRESH_MS = 3000;
  const WINDOW_MS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
  const AXIS_START = { '1h': '−1h', '6h': '−6h', '24h': '−24h', '7d': '−7d', '30d': '−30d' };
  // Which chart an open incident is about, so its header value takes the
  // incident's color (the same mapping the Overview uses for its cells).
  const CELL_KEYS = {
    tipAge: ['tip_stalled', 'tip_rewound', 'sync_stalled', 'block_lag'],
    peers: ['peers_low'],
    rpc: ['rpc_down', 'rpc_slow'],
    mempool: ['mempool_high'],
  };
  const W = 300, H = 70; // chart viewBox; values plot between y=68 (0) and y=6 (top), as in the mock
  const LAG_W = 600, LAG_H = 24;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked; the name lasts for this page load */ } },
  };

  const label = (new URLSearchParams(location.search).get('label') || '').trim();

  const state = {
    win: '6h',
    by: (store.get('lw-by') || '').trim(),
    node: null, // this node's /api/fleet row, or null when the collector does not know the label
    series: [],
    incidents: [], // this node's history in the window, non-transient
    openCritical: 0, // fleet-wide, for the top bar's pill
    analytics: null,
    fetchedAt: 0, // browser clock at the last successful fetch
    clockOffset: 0, // collector clock minus browser clock
    failed: false,
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
  // Uptime: "11d 04h" past a day, fmt() below that.
  function fmtLong(s) {
    const d = Math.floor(s / 86400);
    return d ? d + 'd ' + String(Math.floor((s % 86400) / 3600)).padStart(2, '0') + 'h' : fmt(s);
  }
  const fmtMs = (ms) => (ms == null ? '—' : fmt(ms / 1000));
  const fmtBytes = (n) => (n >= 1e6 ? +(n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? +(n / 1e3).toFixed(1) + ' kB' : n + ' B');
  const nowC = () => Date.now() + state.clockOffset;
  const ageS = (t) => (nowC() - t) / 1000;
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const netOf = (n) => n.network || (n.node && n.node.network) || null;

  // "12:41:07" today, "2026-09-13 12:41:07" otherwise (collector clock decides "today")
  function stamp(t) {
    const iso = new Date(t).toISOString();
    const today = new Date(nowC()).toISOString().slice(0, 10);
    return iso.slice(0, 10) === today ? iso.slice(11, 19) : iso.slice(0, 10) + ' ' + iso.slice(11, 19);
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
      const q = encodeURIComponent(label);
      const [fleet, series, history, open, analytics] = await Promise.all([
        getJSON('/api/fleet'),
        label ? getJSON('/api/series/' + q + '?window=' + win) : [], // no label: the top bar still gets its pill and clock
        label ? getJSON('/api/incidents?label=' + q + '&window=' + win + '&state=all') : [],
        getJSON('/api/incidents?state=open'),
        getJSON('/api/analytics?window=' + win),
      ]);
      if (win !== state.win) return; // the window changed while this was in flight
      state.node = (Array.isArray(fleet) ? fleet : []).find((n) => n.label === label) || null;
      state.series = Array.isArray(series) ? series : [];
      state.incidents = (Array.isArray(history) ? history : []).filter((i) => !i.transient);
      state.openCritical = (Array.isArray(open) ? open : []).filter((i) => !i.transient && !i.resolvedAt && !i.suppressedBy && i.severity === 'critical').length;
      state.analytics = analytics;
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
    const n = state.node;
    $('gone').hidden = !!n;
    $('node').hidden = !n;
    if (!n) {
      setHTML('gone', $('gone'), (label
        ? '<span>No node named <span class="mono">' + esc(label) + '</span> — the collector has not heard from it.</span>'
        : '<span>No node in the URL: open this page as <span class="mono">/node.html?label=&lt;node&gt;</span>, or pick one from the fleet.</span>')
        + '<span><a href="/">← Fleet</a></span>');
      tick();
      return;
    }
    renderHead();
    renderCharts();
    renderLag();
    renderHistory();
    renderSidecar();
    renderThresholds();
    tick();
  }

  function renderOncall() {
    setText('oncall', state.by || '—');
  }

  function renderTopbar() {
    $('crit-pill').hidden = state.openCritical === 0;
    setText('crit-n', String(state.openCritical));
    // Sidecar in the nav is a real link once the sidecar has said where its page is.
    const url = state.node && state.node.sidecar && state.node.sidecar.dashboardUrl;
    const html = url
      ? '<a id="nav-sidecar" href="' + esc(url) + '" target="_blank" rel="noopener">Sidecar ↗</a>'
      : '<span id="nav-sidecar" class="soon" title="coming">Sidecar</span>';
    if (state.rendered.navSidecar !== html) {
      state.rendered.navSidecar = html;
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      $('nav-sidecar').replaceWith(tpl.content.firstChild);
    }
  }

  function renderHead() {
    const n = state.node;
    const quiet = n.state === 'quiet';
    for (const b of $('windows').children) b.classList.toggle('active', b.dataset.win === state.win);
    setText('title', n.label);
    setHTML('state', $('head-state'), '<span class="state ' + esc(n.state) + '"><span class="dot"></span>' + esc(n.state) + '</span>');
    const parts = [];
    if (netOf(n)) parts.push('<span>' + esc(netOf(n)) + '</span>');
    if (n.node && (n.node.build || n.node.version)) parts.push('<span>zebrad ' + esc(n.node.build || n.node.version) + '</span>');
    if (n.sidecar && n.sidecar.host) parts.push('<span>' + esc(n.sidecar.host) + '</span>');
    parts.push(n.lastSeen ? '<span>seen <b' + (quiet ? ' class="quiet"' : '') + ' data-since="' + Number(n.lastSeen) + '"></b></span>' : '<span>never seen</span>');
    setHTML('meta', $('meta'), parts.join(''));
  }

  // color class for a chart's header value: the most severe open incident about it
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

  // ---- series geometry -----------------------------------------------------
  //
  // x is time: the window's start is x=0 and the collector's now is x=W, so a
  // node heard for five minutes draws five minutes' worth at the right edge.

  const num = (x) => (Math.round(x * 10) / 10).toString();

  function xOf(t, winMs) {
    return Math.min(W, Math.max(0, ((t - (nowC() - winMs)) / winMs) * W));
  }

  // Runs of consecutive samples that have a value. A null breaks the line, and
  // so does silence: two samples further apart than the collector's quiet
  // threshold are not joined, so a node that was quiet shows a gap, not a
  // straight line across it.
  function runs(samples, value, winMs, width = W) {
    const gapMs = (state.analytics && state.analytics.quietMs) || 60000;
    const out = [];
    let run = [], prevAt = null;
    for (const s of samples) {
      const v = value(s);
      if (v == null || (prevAt != null && s.at - prevAt > gapMs)) { if (run.length) out.push(run); run = []; }
      prevAt = s.at;
      if (v == null) continue;
      run.push({ x: (xOf(s.at, winMs) * width) / W, v });
    }
    if (run.length) out.push(run);
    return out;
  }

  // Path data for the runs; a lone sample becomes a round-capped dot.
  function paths(runList, yOf, cls) {
    let line = '', dots = '';
    for (const run of runList) {
      if (run.length === 1) { dots += 'M' + num(run[0].x) + ' ' + num(yOf(run[0].v)) + 'h0.01'; continue; }
      line += run.map((p, i) => (i ? 'L' : 'M') + num(p.x) + ' ' + num(yOf(p.v))).join('');
    }
    return (line ? '<path class="line' + (cls ? ' ' + cls : '') + '" d="' + line + '"></path>' : '')
      + (dots ? '<path class="pt' + (cls ? ' ' + cls : '') + '" d="' + dots + '"></path>' : '');
  }

  // The part of each run above `thresh`, cut exactly at the crossings: this
  // is the mock's red tail on the tip-age chart.
  function above(runList, thresh) {
    const out = [];
    for (const run of runList) {
      let cur = [];
      const flush = () => { if (cur.length) out.push(cur); cur = []; };
      for (let i = 0; i < run.length; i++) {
        const b = run[i], a = run[i - 1];
        if (a) {
          const aUp = a.v > thresh, bUp = b.v > thresh;
          if (aUp !== bUp) {
            const t = (thresh - a.v) / (b.v - a.v);
            const cross = { x: a.x + t * (b.x - a.x), v: thresh };
            if (aUp) { cur.push(cross); flush(); } else cur.push(cross);
          }
        }
        if (b.v > thresh) cur.push(b);
      }
      flush();
    }
    return out.filter((r) => r.length > 1 || r[0].v > thresh);
  }

  function chart(id, title, value, cls, body, foot) {
    return '<div class="ct" id="ct-' + id + '">'
      + '<div class="ct-head"><span class="k">' + title + '</span><span class="v' + (cls ? ' ' + cls : '') + '">' + esc(value) + '</span></div>'
      + body
      + '<div class="ct-foot"><span>' + AXIS_START[state.win] + '</span><span>' + foot + '</span><span>now</span></div>'
      + '</div>';
  }

  function renderCharts() {
    const n = state.node, s = state.series, winMs = WINDOW_MS[state.win];
    const t = (n.sidecar && n.sidecar.thresholds) || null;
    const keys = new Map((n.open || []).map((o) => [o.key, o.severity]));
    const last = s[s.length - 1] || {};
    const empty = '<div class="empty">no samples in this window</div>';
    const base = '<line class="base" x1="0" y1="69.5" x2="' + W + '" y2="69.5"></line>';
    const svg = (inner) => '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' + base + inner + '</svg>';
    const scale = (top) => (v) => H - 2 - Math.min(1, v / top) * (H - 8);
    const maxOf = (value) => s.reduce((m, x) => (value(x) != null && value(x) > m ? value(x) : m), 0);
    const guide = (y, cls) => '<line class="thresh ' + cls + '" x1="0" y1="' + num(y) + '" x2="' + W + '" y2="' + num(y) + '"></line>';
    const none = (v) => (v == null ? 'none' : '');

    // tip age: dashed stall line, the line above it in crit
    const stallS = t && t.tipStallMin > 0 ? t.tipStallMin * 60 : null;
    let body;
    if (!s.length) body = empty;
    else {
      const top = Math.max(1, Math.max(maxOf((x) => x.tipAgeS), stallS || 0) * 1.08), y = scale(top);
      const r = runs(s, (x) => x.tipAgeS, winMs);
      body = svg((stallS ? guide(y(stallS), 'crit') : '') + paths(r, y) + (stallS ? paths(above(r, stallS), y, 'tail') : ''));
    }
    const tipAge = last.tipAgeS;
    let html = chart('tip', 'tip age', tipAge == null ? '—' : fmt(tipAge), cellClass(keys, CELL_KEYS.tipAge) || none(tipAge), body, stallS ? 'stall ≥ ' + stallS + 's' : '');

    // RPC latency: failed polls are red ticks and break the line
    const fails = s.filter((x) => x.rpcOk === false);
    if (!s.length) body = empty;
    else {
      const ok = (x) => (x.rpcOk === false ? null : x.rpcMs);
      const top = Math.max(1, maxOf(ok) * 1.08), y = scale(top);
      const ticks = fails.map((x) => 'M' + num(xOf(x.at, winMs)) + ' 6V' + (H - 2)).join('');
      body = svg(paths(runs(s, ok, winMs), y) + (ticks ? '<path class="fail" d="' + ticks + '"></path>' : ''));
    }
    const down = last.rpcOk === false;
    html += chart('rpc', 'RPC latency', down ? 'down' : last.rpcMs == null ? '—' : last.rpcMs + ' ms', cellClass(keys, CELL_KEYS.rpc, down) || none(down ? 0 : last.rpcMs), body,
      fails.length ? '<span class="mark">|</span> ' + plural(fails.length, 'failure') : s.length ? 'no failures' : '');

    // peers: dashed minimum line
    const minPeers = t ? t.minPeers : null;
    if (!s.length) body = empty;
    else {
      const top = Math.max(1, Math.max(maxOf((x) => x.peers), minPeers || 0) * 1.08), y = scale(top);
      body = svg((minPeers > 0 ? guide(y(minPeers), 'warn') : '') + paths(runs(s, (x) => x.peers, winMs), y));
    }
    html += chart('peers', 'peers', last.peers == null ? '—' : String(last.peers), cellClass(keys, CELL_KEYS.peers) || none(last.peers), body, minPeers != null ? 'min ' + minPeers : '');

    // mempool
    const memMax = s.some((x) => x.mempool != null) ? maxOf((x) => x.mempool) : null;
    if (!s.length) body = empty;
    else {
      const top = Math.max(1, (memMax || 0) * 1.08), y = scale(top);
      body = svg(paths(runs(s, (x) => x.mempool, winMs), y));
    }
    html += chart('mempool', 'mempool', last.mempool == null ? '—' : last.mempool + ' txs', cellClass(keys, CELL_KEYS.mempool) || none(last.mempool), body, memMax != null ? 'max ' + memMax : '');

    setHTML('charts', $('charts'), html);
  }

  // Log lag sparkline; the card is hidden when nothing in the window has a
  // log delay (a sidecar in rpc-only mode never reports one).
  function renderLag() {
    const s = state.series, winMs = WINDOW_MS[state.win];
    const vals = s.map((x) => x.logDelayMs).filter((v) => v != null);
    $('lag').hidden = !vals.length;
    if (!vals.length) return;
    const top = Math.max(1, Math.max(...vals));
    const y = (v) => LAG_H - 2 - Math.min(1, v / top) * (LAG_H - 4);
    const sorted = [...vals].sort((a, b) => a - b);
    const p95 = sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]; // nearest rank
    const latest = vals[vals.length - 1];
    setHTML('lag', $('lag'), '<span class="k">log lag</span>'
      + '<svg viewBox="0 0 ' + LAG_W + ' ' + LAG_H + '" preserveAspectRatio="none" aria-hidden="true">' + paths(runs(s, (x) => x.logDelayMs, winMs, LAG_W), y) + '</svg>'
      + '<span class="v">' + latest + ' ms <span>· p95 ' + p95 + ' ms</span></span>');
  }

  function renderHistory() {
    const list = state.incidents;
    const open = list.filter((i) => !i.resolvedAt).length;
    setText('hist-title', 'incident history · ' + state.win);
    setText('hist-count', list.length ? plural(list.length, 'incident') + ' · ' + open + ' open' : '');
    let html;
    if (!list.length) {
      html = '<tr><td class="empty" colspan="9">No incidents in this window.</td></tr>';
    } else {
      html = list.map((i) => {
        const done = !!i.resolvedAt, sup = !done && !!i.suppressedBy, acked = !!i.ackedAt;
        const unacked = !done && !sup && !acked;
        let status, statusCls = '';
        if (sup) { status = 'suppressed'; statusCls = 'sup'; }
        else if (!done) { status = acked ? 'open · acknowledged' : 'open · unacknowledged'; statusCls = acked ? 'acked' : 'open'; }
        else if (i.closedBy) status = 'closed by hand' + (i.resolvedDetail && i.resolvedDetail !== 'closed by hand' ? ' · "' + i.resolvedDetail + '"' : '');
        else status = 'resolved' + (i.escalations ? ' · escalated ×' + i.escalations : '');
        const by = i.closedBy || i.respondedBy || i.ackedBy || null;
        const gap = (ms) => (ms == null ? '<td class="r none">—</td>' : '<td class="r">' + esc(fmtMs(ms)) + '</td>');
        return '<tr class="' + (unacked ? 'unacked' : done ? 'done' : '') + '" data-id="' + esc(i.id) + '">'
          + '<td><span class="tag ' + (done ? 'muted' : esc(i.severity)) + '">' + esc(i.severity) + '</span></td>'
          + '<td class="det"><a href="/incident.html?id=' + encodeURIComponent(i.id) + '">' + esc(i.key) + '</a></td>'
          + '<td class="onset">' + esc(stamp(i.onsetAt)) + '</td>'
          + gap(i.pagedAt - i.onsetAt)
          + (acked ? gap(i.ackedAt - i.receivedAt) : unacked ? '<td class="r crit" data-since="' + Number(i.receivedAt) + '" data-post=" …"></td>' : '<td class="r none">—</td>')
          + gap(i.respondedAt ? i.respondedAt - i.receivedAt : null)
          + gap(done ? i.resolvedAt - i.onsetAt : null)
          + (by ? '<td class="by">' + esc(by) + '</td>' : '<td class="by none">—</td>')
          + '<td class="status' + (statusCls ? ' ' + statusCls : '') + '"' + (sup ? ' title="part of ' + esc(i.suppressedBy) + '"' : '') + '>' + esc(status) + '</td>'
          + '</tr>';
      }).join('');
    }
    setHTML('history', $('hist-body'), html);
  }

  function renderSidecar() {
    const n = state.node, sc = n.sidecar;
    if (!sc) {
      setHTML('sidecar', $('sidecar'), '<div class="note">No sidecar details yet — they arrive with its next heartbeat.</div>');
      return;
    }
    const row = (k, v) => '<span class="k">' + k + '</span><span class="v">' + v + '</span>';
    const rows = [];
    rows.push(row('version', sc.version ? esc(sc.version) : '<span class="dim">—</span>'));
    if (sc.host) rows.push(row('host', esc(sc.host)));
    if (sc.source) {
      const m = /^(file|docker|journald)\s+(.+)$/.exec(sc.source); // "docker zebra" -> docker · zebra
      rows.push(row('source', m ? esc(m[1]) + ' <span class="dim">· ' + esc(m[2]) + '</span>' : esc(sc.source)));
    }
    if (sc.rpcUrl) rows.push(row('rpc', esc(String(sc.rpcUrl).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, ''))));
    rows.push(row('heartbeat', (sc.pollMs > 0 ? 'every ' + esc(sc.pollMs / 1000) + 's · ' : '') + 'last ' + (n.lastSeen ? '<span data-since="' + Number(n.lastSeen) + '"></span>' : '—')));
    if (sc.startedAt) rows.push(row('uptime', '<span data-since="' + Number(sc.startedAt) + '" data-long="1"></span>'));
    if (sc.dashboardUrl) rows.push('<span class="k"></span><span class="v"><a href="' + esc(sc.dashboardUrl) + '" target="_blank" rel="noopener">open sidecar dashboard ↗</a></span>');
    setHTML('sidecar', $('sidecar'), '<div class="facts">' + rows.join('') + '</div>');
  }

  // One row per detector, from the thresholds the sidecar reports. Names,
  // severities and the shape of each rule are the detectors' (src/detectors.js);
  // the numbers are the node's configuration.
  function renderThresholds() {
    const n = state.node, t = n.sidecar && n.sidecar.thresholds;
    $('thresholds-card').hidden = !t;
    if (!t) return;
    const quietMs = state.analytics && state.analytics.quietMs;
    const has = (...ks) => ks.every((k) => typeof t[k] === 'number'); // an older sidecar may not send every threshold
    const rows = [
      has('tipStallMin') && ['tip_stalled', 'no block ≥ ' + t.tipStallMin + 'm', 'critical', t.tipStallMin > 0],
      ['tip_rewound', 'height decreases', 'warning', true],
      has('rpcFailCount') && ['rpc_down', t.rpcFailCount + ' fails in a row', 'critical', true],
      has('rpcSlowMs') && ['rpc_slow', 'rpc > ' + t.rpcSlowMs + ' ms', 'warning', true],
      n.sidecar.gbtPollMs > 0 && has('gbtSlowMs') && ['gbt_slow', 'gbt > ' + t.gbtSlowMs + ' ms', 'warning', true],
      has('minPeers') && ['peers_low', '< ' + t.minPeers + ' for 2 polls<small>critical at 0</small>', 'warning', t.minPeers > 0],
      ['sync_stalled', 'zebrad reports it', 'critical', true],
      has('errorBurst', 'errorWindowS') && ['error_burst', '≥ ' + t.errorBurst + ' warn+err/' + t.errorWindowS + 's', 'warning', true],
      has('mempoolMax') && ['mempool_high', '> ' + t.mempoolMax + ' txs', 'warning', t.mempoolMax > 0],
      has('bigBlockTxs', 'bigBlockBytes') && ['large_block', '> ' + t.bigBlockTxs + ' txs<small>or > ' + fmtBytes(t.bigBlockBytes) + '</small>', 'warning', t.bigBlockTxs > 0],
      has('blockLagS') && ['block_lag', '> ' + t.blockLagS + 's past header', 'warning', t.blockLagS > 0],
      has('eosWarnBlocks') && ['end_of_support', t.eosWarnBlocks + ' blocks left', 'warning', true],
      quietMs > 0 && ['quiet', 'no heartbeat ' + Math.round(quietMs / 1000) + 's', 'quiet', true],
    ].filter(Boolean);
    setHTML('thresholds', $('thresholds'), rows.map(([key, desc, sev, on]) =>
      '<span class="' + (on ? '' : 'off') + '">' + key + '</span><span class="d' + (on ? '' : ' off') + '">' + desc + '</span><span class="s ' + (on ? sev : 'off') + '">' + (on ? sev : 'off') + '</span>').join(''));
  }

  // Once a second: the clock, the live indicator, and every age.
  function tick() {
    setText('clock', new Date().toISOString().slice(11, 19) + ' UTC');
    $('live').classList.toggle('down', state.failed);
    setText('live-text', state.failed ? 'reconnecting' : state.fetchedAt ? 'live · updated ' + fmt((Date.now() - state.fetchedAt) / 1000) + ' ago' : 'connecting');
    for (const el of document.querySelectorAll('[data-since]')) {
      const age = ageS(Number(el.dataset.since));
      const text = (el.dataset.pre || '') + (el.dataset.long ? fmtLong(age) : fmt(age)) + (el.dataset.post || '');
      if (el.textContent !== text) el.textContent = text;
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

  $('windows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-win]');
    if (!b || b.dataset.win === state.win) return;
    state.win = b.dataset.win;
    for (const x of $('windows').children) x.classList.toggle('active', x === b);
    refresh();
  });

  $('oncall').addEventListener('click', () => askName(state.by));

  document.title = 'Zero · ' + (label || 'Node');
  setText('crumb', label || '—');
  renderOncall();
  tick();
  setInterval(tick, 1000);
  refresh();
})();
