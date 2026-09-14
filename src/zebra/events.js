const { heightOf, hashOf, secondsOf } = require('./parse');

// Turns parsed log entries into the handful of things the detectors care
// about. Every pattern here was taken from a running node or from zebrad's
// source (zebrad/src/components/sync/progress.rs, end_of_support.rs), not
// guessed; if Zebra changes wording these are the strings to update.

const T = {
  gossip: 'zebrad::components::sync::gossip',
  progress: 'zebrad::components::sync::progress',
  application: 'zebrad::application',
  rpc: 'zebra_rpc::methods',
  eos: 'zebrad::components::sync::end_of_support',
};

function toEvents(entry) {
  const out = [];
  const { target, message, fields, level } = entry;

  if (target === T.gossip && /sending (committed|mined) block broadcast/.test(fields.log_msg || '')) {
    out.push({
      type: 'block_committed',
      height: heightOf(fields.height),
      hash: hashOf(fields.request),
      mined: fields.log_msg.includes('mined'),
    });
  } else if (target === T.rpc && message.startsWith('submit block accepted')) {
    out.push({ type: 'block_committed', height: heightOf(fields.height), hash: hashOf(fields.hash), mined: true });
  }

  if (target === T.progress) {
    const ev = {
      type: 'sync_progress',
      percent: fields.sync_percent ? parseFloat(fields.sync_percent) : null,
      height: heightOf(fields.current_height),
      remaining: fields.remaining_sync_blocks != null ? Number(fields.remaining_sync_blocks) : null,
      sinceLastBlockS: secondsOf(fields.time_since_last_state_block),
      state: 'syncing',
    };
    if (message.startsWith('finished initial sync')) ev.state = 'at_tip';
    else if (message.startsWith('chain updates have stalled')) ev.state = 'stalled';
    else if (message.includes('sync is very slow')) ev.state = 'very_slow';
    else if (message.includes('genesis block')) ev.state = 'genesis';
    else if (message.startsWith('estimated progress')) ev.state = 'syncing';
    out.push(ev);
  }

  if (target === T.application && message.startsWith('Diagnostic metadata')) {
    out.push({ type: 'node_started' });
  }

  if (target === T.eos) {
    const m = /supported until block (\d+)/.exec(message);
    if (m) out.push({ type: 'end_of_support', haltHeight: Number(m[1]) });
    if (message.startsWith('Your Zebra release is too old')) out.push({ type: 'end_of_support_imminent', message });
  }

  if (level === 'WARN' || level === 'ERROR') {
    const rpcSpan = entry.spans.find((s) => s.name === 'rpc_request');
    out.push({
      type: level === 'ERROR' ? 'log_error' : 'log_warn',
      entry,
      rpcMethod: rpcSpan ? rpcSpan.fields['rpc.method'] : null,
    });
  }

  return out;
}

// The startup banner is a multi-line entry; the interesting bits arrive as
// continuation lines ("version: 6.2.0", "Zcash network: Testnet").
function metaFromContinuation(text) {
  let m = /^version:\s*(\S+)/.exec(text);
  if (m) return { version: m[1] };
  m = /^Zcash network:\s*(\S+)/.exec(text);
  if (m) return { network: m[1] };
  return null;
}

module.exports = { toEvents, metaFromContinuation, TARGETS: T };
