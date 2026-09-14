// Incident detail page for the collector. Reads /api/incidents/:id (plus the
// page-time bundle, the node's heartbeat series and the open-incident count)
// every 3 s, ticks the clock and the open stage's duration once a second, and
// posts ack / respond / note / close / report. Plain DOM, no framework.
// Everything on the page comes from those responses except the engineer's
// name (localStorage) and the wall clock.
(() => {
  'use strict';

  const REFRESH_MS = 3000;
  const COLLAPSED_LINES = 11; // the mock's "showing 11 of 200"
  const CHART_MS = 3600e3; // "RPC latency · last hour"
  const AFTER_PAGE_MS = 30 * 60e3; // the hour shown ends 30 min after the page
  const MIN_SEG_SHARE = 0.15; // no lifecycle segment narrower than this share of the known durations, so its label stays readable

  // caption under the onset dot: what the detector's onsetAt actually is
  const ONSET_CAPTION = { tip_stalled: 'last block time', rpc_down: 'first failed poll', peers_low: 'first low poll', sync_stalled: 'per zebrad', error_burst: 'first warning' };
  // the evidence field the detector tripped on; it takes the severity color
  const PRIMARY_EVIDENCE = { tip_stalled: 'ageS', sync_stalled: 'sinceLastBlockS', rpc_down: 'failures', rpc_slow: 'ms', peers_low: 'peers', mempool_high: 'size', gbt_error: 'error', gbt_slow: 'ms', gbt_stale: 'templateHeight', error_burst: 'count', end_of_support: 'haltHeight', verify_slow: 'p99' };
  const LEVEL_CLASS = { INFO: 'ok', WARN: 'warn', ERROR: 'crit', DEBUG: 'fg-2', TRACE: 'fg-2' };
  const LINE_RE = /^(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(.*)$/;
  const ANSI_RE = /\x1b\[[0-9;]*m/g;
  const NOTE_MODES = {
    note: { placeholder: 'Add a note to the audit trail', submit: 'Save note' },
    respond: { placeholder: 'What did you tell the operator?', submit: 'Mark responded' },
    close: { placeholder: 'Reason for closing', submit: 'Close incident' },
  };
  const TRIAGE_SECTIONS = [
    ['Probable cause', 'probable cause', ''],
    ['Check next', 'what to check', ''],
    ['Regtest repro', 'regtest repro', 'mono'],
    ['Draft to operator', 'draft to operator', 'quote'],
  ];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked; the name lasts for this page load */ } },
  };
  const incidentHref = (id) => '/incident.html?id=' + encodeURIComponent(id);
  const bundleHref = (file) => '/bundles/' + String(file).replace(/^bundles\//, '').split('/').map(encodeURIComponent).join('/');

  const state = {
    id: (new URLSearchParams(location.search).get('id') || '').trim(),
    by: (store.get('lw-by') || '').trim(),
    inc: null,
    series: [], // heartbeat samples for the node, collector clock
    critOpen: 0, // open critical incidents fleet-wide, for the top bar
    members: new Map(), // id -> incident, for a network incident's member list
    pageBundle: null, // the bundle stored with the NEW message
    pageBundleFile: null, // which file pageBundle came from, so it is fetched once
    fetchedAt: 0, // browser clock at the last successful fetch
    clockOffset: 0, // collector clock minus browser clock
    failed: false,
    note: { open: false, mode: 'note' }, // the input's text lives in the DOM and survives refreshes
    logsExpanded: false,
    triageHidden: false, // "Discard" hides the draft for this page load
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
  const today = () => new Date(nowC()).toISOString().slice(0, 10);
  const hms = (t) => new Date(t).toISOString().slice(11, 19);
  const hm = (t) => new Date(t).toISOString().slice(11, 16);
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  // "12:41:07" today, "2026-09-13 12:41:07" otherwise
  const stamp = (t) => (day(t) === today() ? hms(t) : day(t) + ' ' + hms(t));
  const isoTitle = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const bytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
  const lagText = (ms) => (Math.abs(ms) >= 10000 ? (ms < 0 ? '−' : '+') + (Math.abs(ms) / 1000).toFixed(1) + 's' : (ms < 0 ? '−' : '+') + Math.abs(Math.round(ms)) + 'ms');
  const isNetwork = (inc) => String(inc.label).startsWith('network:');
  const sysName = (inc) => (isNetwork(inc) ? 'collector' : 'sidecar');

  function setText(id, text) {
    const el = $(id);
    if (el && el.textContent !== text) el.textContent = text;
  }
  function setHTML(region, el, html) {
    if (state.rendered[region] === html) return;
    state.rendered[region] = html;
    el.innerHTML = html;
  }
  function setHref(id, href) {
    const el = $(id);
    if (el.getAttribute('href') !== href) el.setAttribute('href', href);
  }

  // ---- data ------------------------------------------------------------------

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) { const e = new Error(url + ' -> ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }

  // The heartbeat series is windowed from now; pick the smallest window that
  // still reaches back to the start of the chart's hour.
  function seriesWindow(inc) {
    const back = nowC() - (inc.receivedAt - AFTER_PAGE_MS);
    return back <= 3600e3 ? '1h' : back <= 6 * 3600e3 ? '6h' : back <= 86400e3 ? '24h' : '7d';
  }

  async function load() {
    const t0 = Date.now();
    let inc;
    try {
      inc = await getJSON('/api/incidents/' + encodeURIComponent(state.id));
    } catch (err) {
      if (err.status === 404) { showProblem('No incident ' + state.id, 'The collector has no record with that id. It may have been recorded under a different collector, or the link is stale.'); return; }
      console.error('refresh failed', err);
      state.failed = true;
      return;
    }
    state.clockOffset = inc.at - Math.round((t0 + Date.now()) / 2);
    const network = isNetwork(inc);
    const [series, open, all, page] = await Promise.all([
      network ? [] : getJSON('/api/series/' + encodeURIComponent(inc.label) + '?window=' + seriesWindow(inc)).catch((err) => { console.error('series failed', err); return state.series; }),
      getJSON('/api/incidents?state=open').catch((err) => { console.error('open incidents failed', err); return null; }),
      network && inc.members && inc.members.length ? getJSON('/api/incidents?window=30d').catch(() => null) : null,
      inc.bundleFile && inc.bundleFile !== state.pageBundleFile ? getJSON(bundleHref(inc.bundleFile)).catch((err) => { console.error('page-time bundle failed', err); return null; }) : undefined,
    ]);
    state.inc = inc;
    state.series = Array.isArray(series) ? series : [];
    if (Array.isArray(open)) state.critOpen = open.filter((i) => !i.transient && !i.resolvedAt && !i.suppressedBy && i.severity === 'critical').length;
    if (Array.isArray(all)) state.members = new Map(all.map((i) => [i.id, i]));
    if (page !== undefined) {
      state.pageBundleFile = inc.bundleFile;
      // the page-time file is the latest one until a later message stores another, so its content is the same object
      state.pageBundle = page || (inc.latestBundleFile === inc.bundleFile ? inc.bundle : null);
    } else if (!inc.bundleFile) {
      state.pageBundle = null;
    }
    state.fetchedAt = Date.now();
    state.failed = false;
    render();
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

  function showProblem(title, why) {
    clearTimeout(timer);
    loadSeq++;
    $('main').hidden = true;
    $('problem').hidden = false;
    setText('problem-title', title);
    setText('problem-why', why);
    document.title = 'Zero · Incident';
    // the top bar still says how many critical incidents are open
    getJSON('/api/incidents?state=open').then((open) => {
      state.critOpen = (Array.isArray(open) ? open : []).filter((i) => !i.transient && !i.resolvedAt && !i.suppressedBy && i.severity === 'critical').length;
      renderTopbar();
    }).catch(() => {});
  }

  // ---- render ----------------------------------------------------------------

  function render() {
    const inc = state.inc;
    $('problem').hidden = true;
    $('main').hidden = false;
    document.title = 'Zero · ' + inc.id;
    renderTopbar();
    renderHead(inc);
    renderLifecycle(inc);
    renderActions(inc);
    renderEvidence(inc);
    renderMembers(inc);
    if (isNetwork(inc)) {
      for (const id of ['rpc-card', 'log-card', 'triage', 'snap-card']) $(id).hidden = true;
      $('no-bundle').hidden = false;
    } else {
      $('no-bundle').hidden = true;
      $('rpc-card').hidden = false; $('log-card').hidden = false; $('snap-card').hidden = false;
      renderChart(inc);
      renderLogs(inc);
      renderTriage(inc);
      renderSnapshot(inc);
    }
    renderTrail(inc);
    renderRaw(inc);
    tick();
  }

  function renderOncall() {
    setText('oncall', state.by || '—');
  }

  function renderTopbar() {
    $('crit-pill').hidden = state.critOpen === 0;
    setText('crit-n', String(state.critOpen));
  }

  // status word, and the class that colors it
  function statusOf(inc) {
    if (inc.resolvedAt) return [inc.closedBy ? 'closed' : 'resolved', 'resolved'];
    if (inc.suppressedBy) return ['suppressed', 'suppressed'];
    if (inc.respondedAt) return ['responded', 'responded'];
    if (inc.ackedAt) return ['acked', 'acked'];
    return ['unacknowledged', 'unacked'];
  }

  function renderHead(inc) {
    const network = isNetwork(inc);
    setText('crumb-node', inc.label);
    $('crumb-node').title = network ? '' : 'node detail: coming';
    setText('crumb-id', inc.id);
    setText('h-sev', inc.severity);
    $('h-sev').className = 'tag ' + esc(inc.severity);
    setText('h-key', inc.key);
    setText('h-title', inc.title || '—');
    setText('h-node', inc.label);
    $('h-node').className = 'node' + (network ? ' network' : '');
    $('h-node').title = network ? '' : 'node detail: coming';
    setText('h-esc', String(inc.escalations || 0));
    const [word, cls] = statusOf(inc);
    const html = cls === 'suppressed'
      ? '<a href="' + esc(incidentHref(inc.suppressedBy)) + '" title="under ' + esc(inc.suppressedBy) + '">' + word + '</a>'
      : esc(word);
    setHTML('status', $('h-status'), html);
    $('h-status').className = 'status ' + cls;
  }

  // The five stages on one clock. onsetAt / pagedAt / resolvedAt are sidecar
  // clock; ackedAt / respondedAt / receivedAt are collector clock. Sidecar
  // times are mapped with offset = receivedAt - pagedAt (as the report does),
  // so no displayed time or duration mixes the two.
  function lifecycle(inc) {
    const offset = inc.receivedAt - inc.pagedAt;
    const open = !inc.resolvedAt;
    const paged = inc.receivedAt;
    const acked = inc.ackedAt || null;
    const responded = inc.respondedAt || null;
    const resolved = inc.resolvedAt ? inc.resolvedAt + offset : null;
    const last = responded || acked || paged; // the stage the resolve segment starts from
    const seg = (from, to, lit, name) => ({
      name, lit: lit && from != null,
      ms: lit && from != null && to != null ? to - from : null, // fixed duration
      since: lit && from != null && to == null ? from : null, // still running: ticks every second
    });
    return {
      onset: inc.onsetAt + offset, paged, acked, responded, resolved,
      segs: [
        { name: 'onset → paged', lit: true, crit: true, ms: inc.pagedAt - inc.onsetAt, since: null },
        seg(paged, acked, !!acked || open, 'paged → acked'),
        seg(acked, responded, !!responded || (!!acked && open), 'acked → responded'),
        seg(last, resolved, !!resolved || (!!responded && open), (responded ? 'responded' : acked ? 'acked' : 'paged') + ' → resolved'),
      ],
    };
  }

  function stageHTML(name, cls, at, caption, capTitle) {
    return '<div class="stage ' + cls + '"><span class="pt"></span><span class="nm">' + name + '</span>'
      + (at != null
        ? '<span class="at" title="' + esc(isoTitle(at)) + '">' + esc(hms(at)) + '</span>' + (day(at) === today() ? '' : '<span class="day">' + esc(day(at)) + '</span>')
        : '<span class="at">—</span>')
      + '<span class="cap" title="' + esc(capTitle || caption) + '">' + esc(caption) + '</span></div>';
  }

  function segHTML(s, weight) {
    const label = s.since != null ? '<span class="d" data-since="' + s.since + '" title="' + esc(s.name) + '"></span>'
      : s.ms != null ? '<span class="d" title="' + esc(s.name) + '">' + esc(fmtMs(s.ms)) + '</span>'
        : '<span class="d"></span>';
    return '<div class="segm' + (s.lit ? ' lit' : '') + (s.crit ? ' crit' : '') + '" style="flex-grow:' + weight.toFixed(2) + '"><span class="ln"></span>' + label + '</div>';
  }

  function renderLifecycle(inc) {
    const L = lifecycle(inc);
    const network = isNetwork(inc);
    // header line: the Overview's KPI definitions
    const parts = ['time to detect ' + fmtMs(inc.pagedAt - inc.onsetAt)];
    parts.push(inc.ackedAt ? 'time to acknowledge ' + fmtMs(inc.ackedAt - inc.receivedAt) : 'unacknowledged');
    if (inc.respondedAt) parts.push('time to respond ' + fmtMs(inc.respondedAt - inc.receivedAt));
    parts.push(inc.resolvedAt ? 'time to resolve ' + fmtMs(inc.resolvedAt - inc.onsetAt) + ' · duration ' + fmtMs(inc.resolvedAt - inc.pagedAt) : 'unresolved');
    setText('life-metrics', parts.join(' · '));

    // flex weights proportional to the durations, with a floor so the labels stay readable
    const known = L.segs.map((s) => (s.ms != null ? s.ms / 1000 : s.since != null ? ageS(s.since) : null));
    const total = known.reduce((a, d) => a + (d || 0), 0);
    const floor = Math.max(1, total * MIN_SEG_SHARE);
    const weights = known.map((d) => Math.max(d == null ? 0 : d, floor));

    const onsetCap = ONSET_CAPTION[inc.key] || (inc.key.startsWith('gbt_') ? 'first failed template' : network ? 'earliest member onset' : 'condition began');
    const respondNote = (inc.notes || []).some((n) => n.action === 'respond' && n.text);
    const resolvedCap = inc.resolvedAt ? (inc.closedBy ? 'closed by ' + inc.closedBy : inc.resolvedDetail || 'resolved') : 'open';
    const html = stageHTML('onset', 'crit', L.onset, onsetCap, network ? onsetCap : onsetCap + ' · sidecar ' + isoTitle(inc.onsetAt))
      + segHTML(L.segs[0], weights[0])
      + stageHTML('paged', 'crit', L.paged, network ? 'by collector' : inc.label, network ? 'opened by the collector from the member incidents' : 'paged by the sidecar on ' + inc.label + ' · sidecar ' + isoTitle(inc.pagedAt))
      + segHTML(L.segs[1], weights[1])
      + stageHTML('acked', L.acked ? 'done' : '', L.acked, L.acked ? inc.ackedBy || '—' : inc.resolvedAt ? '—' : 'waiting')
      + segHTML(L.segs[2], weights[2])
      + stageHTML('responded', L.responded ? 'done' : '', L.responded, L.responded ? (inc.respondedBy || '—') + (respondNote ? ' · note' : '') : '')
      + segHTML(L.segs[3], weights[3])
      + stageHTML('resolved', L.resolved ? 'ok' : '', L.resolved, resolvedCap, inc.closedBy && inc.resolvedDetail ? 'closed by ' + inc.closedBy + ': ' + inc.resolvedDetail : resolvedCap);
    // the running segment's weight grows with every refresh; only rebuild the strip when something else changed
    const key = html.replace(/flex-grow:[\d.]+/g, '');
    if (state.rendered.strip !== key) {
      state.rendered.strip = key;
      $('strip').innerHTML = html;
    } else {
      $('strip').querySelectorAll('.segm').forEach((el, i) => { el.style.flexGrow = weights[i].toFixed(2); });
    }
  }

  function renderActions(inc) {
    const acked = !!inc.ackedAt, responded = !!inc.respondedAt, resolved = !!inc.resolvedAt;
    const set = (id, disabled, label) => { const b = $(id); b.disabled = disabled; if (b.textContent !== label) b.textContent = label; };
    set('b-ack', acked, acked ? 'Acknowledged' : 'Acknowledge');
    set('b-respond', responded, responded ? 'Responded' : 'Mark responded');
    set('b-close', resolved, resolved ? (inc.closedBy ? 'Closed' : 'Resolved') : 'Close');
    set('b-report', !!inc.reportSentAt, inc.reportSentAt ? 'Report sent · ' + (inc.reportSentBy || '?') : 'Report sent');
    $('b-report').title = inc.reportSentAt ? isoTitle(inc.reportSentAt) : 'record that the incident report went to the customer';
    setHref('a-report', '/api/incidents/' + encodeURIComponent(inc.id) + '/report');
    $('a-raw').hidden = !inc.bundleFile;
    if (inc.bundleFile) setHref('a-raw', bundleHref(inc.bundleFile));
    renderNoteBox();
  }

  function renderNoteBox() {
    const m = NOTE_MODES[state.note.mode];
    $('note-row').hidden = !state.note.open;
    if ($('note-text').placeholder !== m.placeholder) $('note-text').placeholder = m.placeholder;
    setText('note-submit', m.submit);
  }

  function openNote(mode, text) {
    state.note = { open: true, mode };
    if (text != null) $('note-text').value = text;
    renderNoteBox();
    $('note-text').focus();
  }

  function closeNote() {
    state.note = { open: false, mode: 'note' };
    $('note-text').value = '';
    renderNoteBox();
  }

  // ---- RPC latency chart ------------------------------------------------------

  function nearestRank(sorted, p) {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  }

  function renderChart(inc) {
    const end = Math.min(inc.receivedAt + AFTER_PAGE_MS, nowC());
    const start = end - CHART_MS;
    const inRange = (s) => s.at >= start && s.at <= end && (s.rpcMs != null || s.rpcOk === false);
    let samples = state.series.filter(inRange);
    if (!samples.length && state.pageBundle && state.pageBundle.rpc && Array.isArray(state.pageBundle.rpc.history)) {
      // sidecar-clock history mapped onto the collector clock
      const offset = inc.receivedAt - inc.pagedAt;
      samples = state.pageBundle.rpc.history.map((h) => ({ at: h.at + offset, rpcMs: h.ms, rpcOk: h.ok })).filter(inRange);
    }
    samples.sort((a, b) => a.at - b.at);
    const x = (t) => ((t - start) / CHART_MS) * 600;
    const ok = samples.filter((s) => s.rpcOk !== false && s.rpcMs != null);
    const max = ok.reduce((m, s) => Math.max(m, s.rpcMs), 0) || 1;
    const y = (ms) => 78 - (ms / max) * 72;

    if (!samples.length) {
      $('rpc-svg').hidden = true;
      $('rpc-empty').hidden = false;
      setText('rpc-empty', 'no samples');
      setText('rpc-stats', '');
    } else {
      $('rpc-svg').hidden = false;
      $('rpc-empty').hidden = true;
      let d = '';
      const runs = [];
      let run = [];
      for (const s of samples) {
        if (s.rpcOk === false || s.rpcMs == null) {
          if (run.length) runs.push(run);
          run = [];
          d += '<line class="fail" x1="' + x(s.at).toFixed(1) + '" y1="70" x2="' + x(s.at).toFixed(1) + '" y2="79.5"></line>';
        } else {
          run.push(x(s.at).toFixed(1) + ',' + y(s.rpcMs).toFixed(1));
        }
      }
      if (run.length) runs.push(run);
      for (const r of runs) d += r.length > 1 ? '<polyline class="line" points="' + r.join(' ') + '"></polyline>' : '<circle class="line" r="1.2" cx="' + r[0].split(',')[0] + '" cy="' + r[0].split(',')[1] + '"></circle>';
      d += '<line class="paged" x1="' + x(inc.receivedAt).toFixed(1) + '" y1="0" x2="' + x(inc.receivedAt).toFixed(1) + '" y2="80"></line>';
      setHTML('plot', $('rpc-plot'), d);
      const lastS = samples[samples.length - 1];
      const p95 = nearestRank(ok.map((s) => s.rpcMs).sort((a, b) => a - b), 0.95);
      const nowWord = end >= nowC() - 60e3 ? 'now' : 'last';
      setText('rpc-stats', nowWord + ' ' + (lastS.rpcOk === false || lastS.rpcMs == null ? 'down' : lastS.rpcMs + ' ms') + ' · p95 ' + (p95 == null ? '—' : p95 + ' ms'));
    }

    // five labels over the hour; the one nearest the page reads "paged HH:MM:SS" in red
    const pagedFrac = Math.min(1, Math.max(0, (inc.receivedAt - start) / CHART_MS));
    const pagedIdx = Math.round(pagedFrac * 4);
    const labels = [0, 1, 2, 3, 4].map((i) => (i === pagedIdx
      ? '<span class="paged">paged ' + esc(hms(inc.receivedAt)) + '</span>'
      : '<span>' + esc(hm(start + (i / 4) * CHART_MS)) + '</span>'));
    setHTML('axis', $('rpc-axis'), labels.join(''));
  }

  // ---- log excerpt --------------------------------------------------------------

  function parseLine(raw, receivedAt) {
    const line = String(raw).replace(ANSI_RE, '');
    const m = LINE_RE.exec(line);
    if (!m) return { cont: true, msg: line };
    const at = Date.parse(m[1]);
    return {
      t: m[2] + '.' + ((m[3] || '') + '000').slice(0, 3),
      lag: typeof receivedAt === 'number' && !Number.isNaN(at) ? lagText(receivedAt - at) : '',
      level: m[4],
      msg: m[5],
    };
  }

  function renderLogs(inc) {
    const b = state.pageBundle;
    const logs = b && Array.isArray(b.logs) ? b.logs : [];
    const recv = b && Array.isArray(b.logsReceivedAt) ? b.logsReceivedAt : [];
    const policy = b && b.share ? b.share.logs : null;
    if (!b) {
      setText('log-title', 'log excerpt');
      $('log-body').hidden = true; $('log-foot').hidden = true;
      $('log-empty').hidden = false; setText('log-empty', 'no bundle stored for this incident');
      return;
    }
    if (!logs.length || policy === 'none') {
      setText('log-title', 'log excerpt · at page time');
      $('log-body').hidden = true; $('log-foot').hidden = true;
      $('log-empty').hidden = false; setText('log-empty', 'no log lines shared by this sidecar');
      return;
    }
    $('log-empty').hidden = true;
    $('log-body').hidden = false;
    $('log-foot').hidden = false;
    setText('log-title', 'log excerpt · ' + (policy === 'summary' ? logs.length + ' lines at page time · summary (WARN/ERROR and the last 5)' : 'last ' + logs.length + ' lines at page time'));
    const from = state.logsExpanded ? 0 : Math.max(0, logs.length - COLLAPSED_LINES);
    let html = '';
    for (let i = from; i < logs.length; i++) {
      const p = parseLine(logs[i], recv[i]);
      html += p.cont
        ? '<span class="t"></span><span class="lag"></span><span class="lv"></span><span class="msg cont" title="' + esc(p.msg) + '">' + esc(p.msg) + '</span>'
        : '<span class="t">' + esc(p.t) + '</span><span class="lag">' + esc(p.lag) + '</span><span class="lv ' + (LEVEL_CLASS[p.level] || 'fg-2') + '">' + esc(p.level) + '</span><span class="msg" title="' + esc(p.msg) + '">' + esc(p.msg) + '</span>';
    }
    setHTML('log', $('log-body'), html);
    const shown = logs.length - from;
    const foot = 'showing ' + shown + ' of ' + logs.length
      + (logs.length > COLLAPSED_LINES ? ' · <a href="#log" id="log-toggle">' + (state.logsExpanded ? 'collapse' : 'expand') + '</a>' : '');
    setHTML('log-foot', $('log-foot'), foot);
  }

  // ---- triage draft -----------------------------------------------------------

  // "Probable cause: … Check next: … Regtest repro: … Draft to operator: …"
  // -> { 'Probable cause': text, … }, or null when fewer than two labels parse.
  function parseTriage(text) {
    const re = /^[ \t]*\**[ \t]*(Probable cause|Check next|Regtest repro|Draft to operator)[ \t]*\**[ \t]*:[ \t]*\**[ \t]*/gim;
    const hits = [];
    let m;
    while ((m = re.exec(text))) hits.push({ label: m[1].toLowerCase(), start: m.index, end: m.index + m[0].length });
    if (hits.length < 2) return null;
    const out = {};
    hits.forEach((h, i) => { out[h.label] = text.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : text.length).trim(); });
    return out;
  }

  function draftToOperator(triage) {
    const parsed = triage && triage.text ? parseTriage(triage.text) : null;
    return parsed && parsed['draft to operator'] ? parsed['draft to operator'] : triage && triage.text ? triage.text.trim() : '';
  }

  function renderTriage(inc) {
    const triage = state.pageBundle && state.pageBundle.triage;
    const show = !!(triage && triage.text) && !state.triageHidden;
    $('triage').hidden = !show;
    if (!show) return;
    const model = triage.model ? esc(triage.model) : 'the model';
    const when = triage.at ? 'at ' + stamp(triage.at) : 'at page time';
    setText('triage-note', 'Triage draft — written by ' + model + ' ' + when + '. Nothing here is sent until a human approves it.');
    const parsed = parseTriage(triage.text);
    if (parsed) {
      $('triage-grid').hidden = false; $('triage-raw').hidden = true;
      setHTML('triage', $('triage-grid'), TRIAGE_SECTIONS.filter(([label]) => parsed[label.toLowerCase()]).map(([label, shown, cls]) =>
        '<span class="k">' + shown + '</span><span class="v ' + cls + '">' + (cls === 'quote' ? '"' + esc(parsed[label.toLowerCase()]) + '"' : esc(parsed[label.toLowerCase()])) + '</span>').join(''));
    } else {
      $('triage-grid').hidden = true; $('triage-raw').hidden = false;
      setText('triage-raw', triage.text.trim());
    }
    $('b-use-draft').hidden = !!inc.respondedAt;
  }

  // ---- notes & audit trail ----------------------------------------------------

  // "ageS=749 peers=2": the scalar (and list) evidence fields, as recorded
  function evidenceSummary(ev) {
    return Object.entries(ev || {})
      .filter(([, v]) => v != null && (typeof v !== 'object' || Array.isArray(v)))
      .map(([k, v]) => { const s = Array.isArray(v) ? v.join(',') : String(v); return k + '=' + (s.length > 24 ? s.slice(0, 16) + '…' : s); })
      .join(' ');
  }

  function renderTrail(inc) {
    const sys = sysName(inc);
    const q = (t) => (t ? '"' + esc(t) + '"' : '');
    const rows = [];
    for (const u of inc.updates || []) {
      const row = { at: u.at, who: sys, sys: true, verb: '', text: '' };
      switch (u.phase) {
        case 'NEW': row.verb = 'paged'; row.text = esc((inc.key + ' ' + evidenceSummary(inc.evidence)).trim()); break;
        case 'ESCALATED': row.verb = 'escalated'; row.text = 'to ' + esc(u.severity || inc.severity); break;
        case 'STILL ACTIVE': row.verb = 're-notified'; row.text = u.count != null ? '(x' + esc(u.count) + ')' : ''; break;
        case 'SUPPRESSED': row.verb = 'suppressed'; row.text = 'under network incident' + (u.by ? ' <a href="' + esc(incidentHref(u.by)) + '">' + esc(u.by) + '</a>' : ''); break;
        case 'UNSUPPRESSED': row.verb = 'unsuppressed'; break;
        case 'RESOLVED': row.verb = 'resolved'; row.text = esc(inc.resolvedDetail || '') + (inc.resolvedAt ? (inc.resolvedDetail ? ' · ' : '') + 'duration ' + esc(fmtMs(inc.resolvedAt - inc.pagedAt)) : ''); break;
        default: row.verb = esc(String(u.phase).toLowerCase());
      }
      rows.push(row);
    }
    for (const n of inc.notes || []) {
      const row = { at: n.at, who: n.by || '?', sys: false, verb: '', text: '' };
      switch (n.action) {
        case 'ack': row.verb = 'acknowledged'; break;
        case 'respond': row.verb = 'responded'; row.text = q(n.text); break;
        case 'close': row.verb = 'closed by hand'; row.text = q(n.text); break;
        case 'note': row.verb = 'noted'; row.text = q(n.text); break;
        case 'report': row.verb = 'sent the incident report'; break;
        default: row.verb = esc(n.action); row.text = q(n.text);
      }
      rows.push(row);
    }
    rows.sort((a, b) => a.at - b.at);
    const html = rows.length ? rows.map((r) =>
      '<div class="trail-row"><span class="t" title="' + esc(isoTitle(r.at)) + '">' + esc(hms(r.at)) + '</span>'
      + '<span class="who' + (r.sys ? ' sys' : '') + '" title="' + esc(r.who) + '">' + esc(r.who) + '</span>'
      + '<span class="what"><span class="verb">' + r.verb + '</span>' + (r.text ? ' ' + r.text : '') + '</span></div>').join('')
      : '<div class="empty">nothing recorded yet</div>';
    setHTML('trail', $('trail'), html);
  }

  // ---- evidence, members, snapshot, raw links ---------------------------------

  function kvValue(v, cls) {
    if (v == null) return '<span class="v nil">null</span>';
    if (typeof v === 'object') { const s = JSON.stringify(v); return '<span class="v obj" title="' + esc(s) + '">' + esc(s) + '</span>'; }
    const s = String(v);
    return '<span class="v' + (cls ? ' ' + cls : '') + '" title="' + esc(s) + '">' + esc(s) + '</span>';
  }

  function renderEvidence(inc) {
    const primary = isNetwork(inc) ? 'nodes' : PRIMARY_EVIDENCE[inc.key];
    const entries = Object.entries(inc.evidence || {});
    const html = entries.length
      ? entries.map(([k, v]) => '<span class="k">' + esc(k) + '</span>' + kvValue(Array.isArray(v) ? v.join(', ') : v, k === primary ? inc.severity : '')).join('')
      : '<span class="k muted">no evidence recorded</span><span class="v"></span>';
    setHTML('evidence', $('evidence'), html);
    $('next').hidden = !inc.suggest;
    setText('next-text', inc.suggest || '');
  }

  function renderMembers(inc) {
    const card = $('members-card');
    if (!isNetwork(inc)) { card.hidden = true; return; }
    card.hidden = false;
    const ids = inc.members || [];
    setText('members-title', 'members · ' + ids.length + (inc.evidence && inc.evidence.of ? ' of ' + inc.evidence.of + ' nodes' : ''));
    const html = ids.length ? ids.map((id) => {
      const m = state.members.get(id);
      const [word, cls] = m ? statusOf(m) : ['', ''];
      return '<a class="member" href="' + esc(incidentHref(id)) + '">'
        + '<span class="lbl">' + (m ? esc(m.label) + '<span class="id">' + esc(id) + '</span>' : '<span class="id">' + esc(id) + '</span>') + '</span>'
        + '<span class="st ' + cls + '">' + esc(word) + '</span></a>';
    }).join('') : '<div class="empty">no members</div>';
    setHTML('members', $('members'), html);
  }

  function renderSnapshot(inc) {
    const b = state.pageBundle;
    setText('snap-title', 'node snapshot · at page time ' + stamp(inc.receivedAt));
    if (!b) {
      $('snapshot').hidden = true; $('snap-empty').hidden = false;
      setText('snap-empty', 'no bundle stored for this incident');
      return;
    }
    $('snapshot').hidden = false; $('snap-empty').hidden = true;
    const rows = [];
    const row = (k, v) => rows.push('<span class="k">' + k + '</span>' + kvValue(v));
    const node = b.node || {};
    row('zebrad', node.build || node.version || null);
    row('network', node.network || null);
    row('tip', b.tip && b.tip.height != null ? b.tip.height + (b.tip.at && b.pagedAt ? ' · ' + fmtMs(b.pagedAt - b.tip.at) : '') : null);
    if (b.sync && b.sync.state) row('sync', b.sync.state + (b.sync.percent != null ? ' · ' + b.sync.percent + '%' : ''));
    row('peers', b.peers ?? null);
    row('rpc', b.rpc ? (b.rpc.ok === false ? 'down' + (b.rpc.lastError && b.rpc.lastError.message ? ' · ' + b.rpc.lastError.message : '') : b.rpc.ms != null ? b.rpc.ms + ' ms' : null) : null);
    if (b.gbt) row('gbt', b.gbt.ok === false ? 'failing' : b.gbt.ms != null ? b.gbt.ms + ' ms' : null);
    row('mempool', b.mempool ? b.mempool.size : null);
    const lb = b.lastBlock;
    row('last block', lb ? [lb.size != null ? bytes(lb.size) : null, lb.txs != null ? lb.txs + ' txs' : null, lb.lagS != null ? 'lag ' + lb.lagS + 's' : null].filter(Boolean).join(' · ') || lb.height : null);
    row('log lag', b.logDelayMs != null ? b.logDelayMs + ' ms' : null);
    const sc = b.sidecar || {};
    row('sidecar', [sc.version ? 'log-watcher ' + sc.version : null, sc.host || null].filter(Boolean).join(' · ') || null);
    setHTML('snapshot', $('snapshot'), rows.join(''));
  }

  function renderRaw(inc) {
    const page = $('raw-page'), res = $('raw-resolved');
    page.hidden = !inc.bundleFile;
    if (inc.bundleFile) { setHref('raw-page', bundleHref(inc.bundleFile)); setText('raw-page', inc.bundleFile + ' ↗'); }
    const second = inc.latestBundleFile && inc.latestBundleFile !== inc.bundleFile ? inc.latestBundleFile : null;
    res.hidden = !second;
    if (second) { setHref('raw-resolved', bundleHref(second)); setText('raw-resolved', second + (inc.resolvedAt ? ' ↗ (resolve-time)' : ' ↗ (latest)')); }
  }

  // Once a second: the clock and the running lifecycle segment.
  function tick() {
    setText('clock', new Date().toISOString().slice(11, 19) + ' UTC');
    for (const el of document.querySelectorAll('[data-since]')) {
      const text = fmt(ageS(Number(el.dataset.since)));
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

  async function act(action, text, btn) {
    const by = state.by || askName('');
    if (!by) return false;
    if (btn) btn.disabled = true;
    try {
      const r = await fetch('/api/incidents/' + encodeURIComponent(state.id) + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ by, text: text && text.trim() ? text.trim() : null }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return true;
    } catch (err) {
      console.error(action + ' failed', err);
      alert('Could not ' + action + ' ' + state.id + ': ' + err.message);
      if (btn) btn.disabled = false;
      return false;
    } finally {
      refresh();
    }
  }

  $('b-ack').addEventListener('click', (e) => act('ack', null, e.currentTarget));
  $('b-report').addEventListener('click', (e) => act('report', null, e.currentTarget));
  $('b-respond').addEventListener('click', () => openNote('respond'));
  $('b-close').addEventListener('click', () => openNote('close'));
  $('b-note').addEventListener('click', () => (state.note.open && state.note.mode === 'note' ? closeNote() : openNote('note')));
  $('note-cancel').addEventListener('click', closeNote);
  $('note-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('note-row').requestSubmit(); }
    if (e.key === 'Escape') closeNote();
  });
  $('note-row').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = state.note.mode;
    const text = $('note-text').value;
    if (mode === 'note' && !text.trim()) { $('note-text').focus(); return; }
    const ok = await act(mode, text, $('note-submit'));
    $('note-submit').disabled = false;
    if (ok) closeNote();
  });
  $('b-use-draft').addEventListener('click', () => openNote('respond', draftToOperator(state.pageBundle && state.pageBundle.triage)));
  $('b-discard').addEventListener('click', () => { state.triageHidden = true; $('triage').hidden = true; });
  $('log-foot').addEventListener('click', (e) => {
    const a = e.target.closest('#log-toggle');
    if (!a) return;
    e.preventDefault();
    state.logsExpanded = !state.logsExpanded;
    if (state.inc) renderLogs(state.inc);
  });
  $('oncall').addEventListener('click', () => askName(state.by));

  renderOncall();
  tick();
  setInterval(tick, 1000);
  if (!state.id) showProblem('No incident id', 'Open this page as /incident.html?id=<incident id>, or pick an incident from the Fleet page.');
  else refresh();
})();
