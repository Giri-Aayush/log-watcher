// Known issues: the part of Zero that compounds. Every resolved incident can
// become a known issue — a symptom signature, a cause, a fix — and every new
// incident is matched against them, so the second customer with the same
// problem gets the first customer's answer.
//
// A signature is deliberately simple: the detector key, optionally the
// network, optionally affected zebrad versions (prefix match: "6.2" matches
// v6.2.3), optionally substrings that must appear in the page-time log lines,
// optionally evidence fields that must equal. Simple enough to write by hand
// from an incident page; specific enough not to match everything.

function versionMatches(build, affected) {
  if (!affected || !affected.length) return true;
  if (!build) return false;
  const v = String(build).replace(/^v/, '');
  return affected.some((a) => v === String(a).replace(/^v/, '') || v.startsWith(String(a).replace(/^v/, '') + '.'));
}

function matches(issue, inc, bundle) {
  if (issue.key !== inc.key) return false;
  if (issue.network && bundle && bundle.node && bundle.node.network && issue.network !== bundle.node.network) return false;
  if (!versionMatches(bundle && bundle.node && (bundle.node.build || bundle.node.version), issue.versions)) return false;
  const m = issue.match || {};
  if (m.logIncludes && m.logIncludes.length) {
    const logs = (bundle && bundle.logs) || [];
    if (!m.logIncludes.some((needle) => logs.some((line) => line.includes(needle)))) return false;
  }
  if (m.evidence) {
    for (const [k, v] of Object.entries(m.evidence)) {
      if (String((inc.evidence || {})[k]) !== String(v)) return false;
    }
  }
  return true;
}

// A known issue drafted from an incident: the engineer edits cause/fix; the
// signature starts as key + network + the version seen.
function draftFromIncident(inc, bundle, { by, now }) {
  const build = bundle && bundle.node && (bundle.node.build || bundle.node.version);
  const improvements = (inc.improvements || []).map((i) => i.text);
  const notes = (inc.notes || []).filter((n) => n.action === 'note' && n.text).map((n) => n.text);
  return {
    id: `ki-${now}`,
    title: inc.title,
    key: inc.key,
    network: (bundle && bundle.node && bundle.node.network) || null,
    versions: build ? [String(build).replace(/^v/, '')] : [],
    match: { logIncludes: [], evidence: {} },
    cause: notes.join(' ') || '',
    fix: improvements.join(' ') || inc.resolvedDetail || '',
    workaround: '',
    references: [],
    status: 'draft',
    createdBy: by,
    createdAt: now,
    updatedAt: now,
    sourceIncidents: [inc.id],
    occurrences: [{ incidentId: inc.id, label: inc.label, at: inc.pagedAt, resolvedAt: inc.resolvedAt || null }],
  };
}

const EDITABLE = ['title', 'key', 'network', 'versions', 'fixedIn', 'match', 'cause', 'fix', 'workaround', 'references', 'status'];

// Markdown for the knowledge base entry. `internal` includes customer labels;
// the default is safe to publish.
function issueMarkdown(issue, { internal = false } = {}) {
  const lines = [];
  lines.push(`# ${issue.title}`);
  lines.push('');
  lines.push(`**Detector:** \`${issue.key}\`  `);
  if (issue.network) lines.push(`**Network:** ${issue.network}  `);
  if (issue.versions && issue.versions.length) lines.push(`**Affected zebrad:** ${issue.versions.join(', ')}  `);
  if (issue.fixedIn) lines.push(`**Fixed in:** ${issue.fixedIn}  `);
  lines.push(`**Status:** ${issue.status}  `);
  lines.push(`**Seen:** ${issue.occurrences.length} time${issue.occurrences.length === 1 ? '' : 's'}${internal ? ` on ${new Set(issue.occurrences.map((o) => o.label)).size} node(s)` : ''}`);
  lines.push('');
  if (issue.cause) { lines.push('## Cause'); lines.push(''); lines.push(issue.cause); lines.push(''); }
  if (issue.fix) { lines.push('## Fix'); lines.push(''); lines.push(issue.fix); lines.push(''); }
  if (issue.workaround) { lines.push('## Workaround'); lines.push(''); lines.push(issue.workaround); lines.push(''); }
  const m = issue.match || {};
  if ((m.logIncludes && m.logIncludes.length) || (m.evidence && Object.keys(m.evidence).length)) {
    lines.push('## How to recognise it');
    lines.push('');
    for (const s of m.logIncludes || []) lines.push(`- log contains \`${s}\``);
    for (const [k, v] of Object.entries(m.evidence || {})) lines.push(`- ${k} = \`${v}\``);
    lines.push('');
  }
  if (issue.references && issue.references.length) {
    lines.push('## References');
    lines.push('');
    for (const r of issue.references) lines.push(`- ${r}`);
    lines.push('');
  }
  if (internal) {
    lines.push('## Occurrences');
    lines.push('');
    for (const o of issue.occurrences) lines.push(`- ${new Date(o.at).toISOString()} — ${o.label} (${o.incidentId})${o.resolvedAt ? ' — resolved' : ''}`);
    lines.push('');
  }
  lines.push('---');
  lines.push(`Zero knowledge base · Shielded Labs · entry ${issue.id}`);
  return lines.join('\n');
}

module.exports = { matches, versionMatches, draftFromIncident, issueMarkdown, EDITABLE };
