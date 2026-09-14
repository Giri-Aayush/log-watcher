// What leaves the customer's box. The local bundle file always has everything;
// this is applied at the export boundary, before a page goes to the collector.
//
//   logs: full     every buffered line (default)
//         summary  WARN/ERROR lines plus the last five lines, for context
//         none     no log lines at all
//   host: false    the sidecar's hostname is not sent (pid and version are)

const LEVEL_RE = /^\S+\s+(WARN|ERROR)\b/;

function applySharePolicy(bundle, policy = {}) {
  const out = { ...bundle, share: { logs: policy.logs || 'full', host: !!policy.host } };
  if (policy.logs === 'none') {
    out.logs = [];
    out.logsReceivedAt = [];
  } else if (policy.logs === 'summary') {
    const keep = new Set();
    bundle.logs.forEach((line, i) => { if (LEVEL_RE.test(line)) keep.add(i); });
    for (let i = Math.max(0, bundle.logs.length - 5); i < bundle.logs.length; i++) keep.add(i);
    const idx = [...keep].sort((a, b) => a - b);
    out.logs = idx.map((i) => bundle.logs[i]);
    out.logsReceivedAt = idx.map((i) => (bundle.logsReceivedAt || [])[i] ?? null);
  }
  if (!policy.host && out.sidecar) out.sidecar = { ...out.sidecar, host: undefined };
  return out;
}

module.exports = { applySharePolicy };
