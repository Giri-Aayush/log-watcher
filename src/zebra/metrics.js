// Prometheus text-format scraper for zebrad's [metrics] endpoint. Only the
// families the detectors ask for are kept; the full exposition is large.
//
// Histograms are cumulative since process start, so a p99 over the whole
// lifetime says nothing about the last minute. `histogramDelta` subtracts the
// previous scrape's buckets first, then `quantile` interpolates inside the
// bucket the way Prometheus' histogram_quantile() does.

function parsePrometheus(text, wanted) {
  const families = {};
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const m = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const [, name, labelText, valueText] = m;
    const base = name.replace(/_(bucket|sum|count)$/, '');
    if (wanted && !wanted.has(base)) continue;
    const labels = {};
    if (labelText) {
      for (const lm of labelText.slice(1, -1).matchAll(/([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
        labels[lm[1]] = lm[2];
      }
    }
    (families[name] ||= []).push({ labels, value: Number(valueText) });
  }
  return families;
}

// Buckets for one histogram family collapsed across every label set except
// the ones in `groupBy`; returns { key -> [{le, count}] } sorted by le.
function buckets(families, family, groupBy = []) {
  const out = {};
  for (const s of families[`${family}_bucket`] || []) {
    const key = groupBy.map((k) => `${k}=${s.labels[k]}`).join(',') || 'all';
    const le = s.labels.le === '+Inf' ? Infinity : Number(s.labels.le);
    const arr = (out[key] ||= []);
    const existing = arr.find((b) => b.le === le);
    if (existing) existing.count += s.value;
    else arr.push({ le, count: s.value });
  }
  for (const arr of Object.values(out)) arr.sort((a, b) => a.le - b.le);
  return out;
}

function histogramDelta(current, previous) {
  if (!previous) return null;
  const out = {};
  for (const [key, arr] of Object.entries(current)) {
    const prev = previous[key];
    if (!prev) continue;
    out[key] = arr.map((b) => {
      const p = prev.find((x) => x.le === b.le);
      return { le: b.le, count: Math.max(0, b.count - (p ? p.count : 0)) };
    });
  }
  return out;
}

function quantile(bucketsAsc, q) {
  if (!bucketsAsc || bucketsAsc.length === 0) return null;
  const total = bucketsAsc[bucketsAsc.length - 1].count;
  if (total === 0) return null;
  const rank = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const b of bucketsAsc) {
    if (b.count >= rank) {
      if (b.le === Infinity) return prevLe;
      const span = b.count - prevCount;
      return span === 0 ? b.le : prevLe + (b.le - prevLe) * ((rank - prevCount) / span);
    }
    prevLe = b.le;
    prevCount = b.count;
  }
  return prevLe;
}

async function scrape(url, wanted, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`metrics: HTTP ${res.status}`);
    return parsePrometheus(await res.text(), wanted);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { parsePrometheus, buckets, histogramDelta, quantile, scrape };
