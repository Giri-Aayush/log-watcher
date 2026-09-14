// Parser for zebrad's log lines. Zebra logs through tracing_subscriber's
// default "full" formatter (there is no JSON option in 6.x), which looks like:
//
//   <rfc3339>  <LEVEL> [span[{fields}]:]* <target>: <message> [key=value]*
//
// Real examples from a 6.3.0 node:
//
//   2026-09-14T11:15:22.990083Z  INFO zebrad::components::sync::progress: finished initial sync to chain tip, using gossiped blocks sync_percent=100.000% current_height=Height(4345594) network_upgrade=Nu6_3 remaining_sync_blocks=0 time_since_last_state_block=0s
//   2026-09-14T11:16:02.733823Z  INFO sync: zebrad::components::sync: waiting to restart sync timeout=67s state_tip=Some(Height(4345594))
//   2026-09-14T11:15:00.230552Z  INFO {peer=In("v4redacted:42588")}:msg_as_req{msg="inv"}:inbound:download_and_verify{advertiser=Some(v4redacted:42588) hash=0000a6a8...}: zebrad::components::inbound::downloads:
//
// Field values are Rust Debug output, so they contain spaces, parens and
// quotes (request=AdvertiseBlock(block::Hash("..."), None)). Splitting on
// whitespace would be wrong; instead we scan with a depth counter and only
// recognise "key=" at depth zero.
//
// Some events span several lines (the startup "Diagnostic metadata:" block).
// Lines that don't start with a timestamp are continuations of the previous
// entry and are returned as { kind: 'continuation' }.

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];
const HEAD_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(.*)$/;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const IDENT = /[A-Za-z0-9_.]/;

// Index of the first ": " that is not inside quotes, (), [] or {}; -1 if none.
function findSeparator(s, from = 0) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === ':' && s[i + 1] === ' ') return i;
  }
  return -1;
}

// "message key=value key2=value2" -> { message, fields }. A field starts at
// a depth-zero "key=" preceded by a space (or the start of the string) and runs
// to the next such key or the end.
function splitFields(s) {
  const starts = [];
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === '=' && i > 0) {
      let j = i - 1;
      while (j >= 0 && IDENT.test(s[j])) j--;
      if (j < i - 1 && (j < 0 || s[j] === ' ')) starts.push({ key: s.slice(j + 1, i), at: j + 1, valueAt: i + 1 });
    }
  }
  if (starts.length === 0) return { message: s.trim(), fields: {} };
  const message = s.slice(0, starts[0].at).trim();
  const fields = {};
  starts.forEach((f, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].at : s.length;
    let value = s.slice(f.valueAt, end).trim();
    if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) value = value.slice(1, -1);
    fields[f.key] = value;
  });
  return { message, fields };
}

// A span chain is "name{fields}:name:name{fields}" — single colons, braces,
// or a name without "::". A target is a Rust module path ("zebrad::a::b").
function looksLikeSpans(head) {
  if (head.includes('{')) return true;
  if (head.includes('::')) return false;
  return true;
}

function parseSpans(chain) {
  const spans = [];
  let i = 0;
  while (i < chain.length) {
    let j = i;
    while (j < chain.length && IDENT.test(chain[j])) j++;
    const name = chain.slice(i, j);
    let fields = {};
    if (chain[j] === '{') {
      let depth = 0;
      let quote = null;
      let k = j;
      for (; k < chain.length; k++) {
        const c = chain[k];
        if (quote) {
          if (c === '\\') k++;
          else if (c === quote) quote = null;
          continue;
        }
        if (c === '"') quote = c;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
      }
      fields = splitFields(chain.slice(j + 1, k)).fields;
      j = k + 1;
    }
    spans.push({ name, fields });
    if (chain[j] === ':') j++;
    i = j;
    if (j === i && !IDENT.test(chain[i] || '') && chain[i] !== '{') break; // safety: no progress
  }
  return spans;
}

function parseLine(raw) {
  const line = raw.replace(ANSI_RE, '');
  const m = HEAD_RE.exec(line);
  if (!m) return { kind: 'continuation', text: line, raw };
  const [, ts, level, rest] = m;

  let spans = [];
  let target = '';
  let body = rest;
  const sep = findSeparator(rest);
  if (sep !== -1) {
    const head = rest.slice(0, sep);
    if (looksLikeSpans(head)) {
      spans = parseSpans(head);
      const after = rest.slice(sep + 2);
      const sep2 = findSeparator(after);
      if (sep2 !== -1 && !/\s/.test(after.slice(0, sep2))) {
        target = after.slice(0, sep2);
        body = after.slice(sep2 + 2);
      } else {
        body = after;
      }
    } else {
      target = head;
      body = rest.slice(sep + 2);
    }
  }
  const { message, fields } = splitFields(body);
  return {
    kind: 'entry',
    ts,
    time: Date.parse(ts),
    level,
    levelNo: LEVELS.indexOf(level),
    spans,
    target,
    message,
    fields,
    raw: line,
  };
}

// "Height(4345594)" | "Some(Height(4345594))" | "4345594" -> 4345594
function heightOf(value) {
  if (value == null) return null;
  const m = /(\d+)/.exec(String(value));
  return m ? Number(m[1]) : null;
}

// 'block::Hash("00009739...")' | '00009739...' -> "00009739..."
function hashOf(value) {
  if (value == null) return null;
  const m = /([0-9a-f]{64})/.exec(String(value));
  return m ? m[1] : null;
}

// "67s" | "12m" | "1h 2m 3s" | "0s" -> seconds
function secondsOf(value) {
  if (value == null) return null;
  let total = 0;
  let matched = false;
  for (const m of String(value).matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s|ms)\b/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : m[2] === 's' ? n : n / 1000;
  }
  return matched ? total : null;
}

module.exports = { parseLine, splitFields, heightOf, hashOf, secondsOf, LEVELS };
