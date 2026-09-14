const Anthropic = require('@anthropic-ai/sdk');
const { spawn, spawnSync } = require('child_process');

// Optional first-pass triage of an alert bundle. Enabled only when
// ANTHROPIC_API_KEY is set. The output is a draft for the on-call engineer:
// probable cause, what to check, a regtest repro sketch, and a message they
// could send the operator. It is attached to the alert and shown in the
// dashboard; nothing here sends anything anywhere. The human decides.

const SYSTEM = `You are the first responder on the Zero support rotation at Shielded Labs, triaging an alert from a sidecar that watches a zebrad (Zcash Zebra) node for an exchange, mining pool or wallet operator.

You are given the alert and its context bundle: node version, network, tip, peers, RPC latency, mempool, and the last log lines. Be concrete and short. Do not speculate beyond the evidence; say what you would need to see next.

Answer in exactly these sections, plain text, no markdown headings:
Probable cause: one or two sentences.
Check next: 3-5 specific commands or log lines to look at, in order.
Regtest repro: how to reproduce this on a zebrad regtest node, or "not reproducible on regtest" and why.
Draft to operator: 2-4 sentences the engineer could send the operator right now, factual, no promises.`;

function makeTriage({ apiKey, model }) {
  const client = new Anthropic({ apiKey });
  return async function triage(alert) {
    const bundle = { ...alert.bundle };
    bundle.logs = bundle.logs.slice(-25);
    const response = await client.beta.messages.create({
      model,
      max_tokens: 4096, // a triage note, not an essay
      system: SYSTEM,
      // Server-side fallback: if the model declines the request for safety
      // reasons, the API re-runs it on a fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: `Alert:\n${JSON.stringify(bundle, null, 2)}` }],
    });
    if (response.stop_reason === 'refusal') return null;
    return {
      model: response.model,
      at: Date.now(),
      text: response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
    };
  };
}

// ---- collector-side triage --------------------------------------------------
//
// The better place for the analysis is Zero's side, not the customer's box:
// the collector knows the fleet (do the other nodes on this network say the
// same?), this node's history, and the series around the page. Credentials
// stay with Zero. Same rule as above: it produces a draft for a human.

const INCIDENT_SYSTEM = `You are the senior SRE on the Zero support rotation at Shielded Labs — ten-plus years on call for production systems, now supporting exchanges, mining pools and wallet providers that run Zcash Zebra nodes. You are handing off one incident to a peer.

Write like a handoff, not a report: short declarative sentences, the number before the noun, no preamble, no hedging, no restating the input, no explaining what a field means. If something is expected behaviour on this network (Regtest has no peers and Zebra estimates the tip from the wall clock, so "initial sync is very slow" is permanent there), say so in the first sentence and stop analysing it. If the other nodes on the network show the same thing, it is the network, not the customer. Reason from the evidence only; when you need more, name the one thing.

Hard limits. Total under 160 words. Exactly these sections, plain text, each label on its own line, nothing else:
Assessment: one or two sentences — what it is, node-local / network-wide / expected here, urgency.
Probable cause: one sentence.
Check next: at most three lines, each one command or one thing to look at, most decisive first.
Regtest repro: one sentence, or "not reproducible on regtest" with the reason.
Draft to operator: at most three sentences, factual, no promises, no jargon they would not know.
Confidence: low / medium / high — and the single fact that would change it.`;

function makeIncidentTriage({ model = 'claude-opus-5', client = null } = {}) {
  const api = client || new Anthropic(); // resolves ANTHROPIC_API_KEY / an `ant auth login` profile itself
  return async function triageIncident(context) {
    const response = await api.beta.messages.create({
      model,
      max_tokens: 1024, // 160 words, by instruction
      system: INCIDENT_SYSTEM,
      output_config: { effort: 'medium' }, // a handoff note; the page is waiting on it
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: `Incident context:\n${JSON.stringify(context, null, 2)}` }],
    });
    if (response.stop_reason === 'refusal') return null;
    return {
      model: response.model,
      at: Date.now(),
      text: response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
    };
  };
}

// The same analysis through the `claude` CLI in print mode, using whoever is
// logged in on this machine. No tools, one turn, no session left behind.
// Slower than the API (the CLI boots a full session per call) but it needs
// no key, which is what a laptop demo has.
function makeCliTriage({ bin = 'claude', model = 'opus', timeoutMs = 180000, spawnImpl = spawn } = {}) {
  return function triageIncident(context) {
    return new Promise((resolve, reject) => {
      const args = ['-p', '--output-format', 'text', '--model', model, '--max-turns', '1', '--no-session-persistence',
        '--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Agent,Task,NotebookEdit',
        '--append-system-prompt', INCIDENT_SYSTEM];
      const child = spawnImpl(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`claude CLI timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; }); // permission-rule warnings land here; not part of the answer
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`claude CLI exited ${code}: ${err.trim().split('\n').pop() || 'no output'}`));
        resolve({ model: `claude-cli/${model}`, at: Date.now(), text: out.trim() });
      });
      child.stdin.end(`Incident context:\n${JSON.stringify(context, null, 2)}`);
    });
  };
}

// api when Zero's key is in the environment; the logged-in CLI otherwise;
// LW_TRIAGE=api|cli|off overrides.
function triageBackend(env = process.env, { hasCli = () => spawnSync('which', ['claude']).status === 0 } = {}) {
  const forced = (env.LW_TRIAGE || '').toLowerCase();
  if (forced === 'off') return null;
  if (forced === 'api') return 'api';
  if (forced === 'cli') return hasCli() ? 'cli' : null;
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return 'api';
  return hasCli() ? 'cli' : null;
}

function triageAvailable(env = process.env) {
  return triageBackend(env) !== null;
}

module.exports = { makeTriage, makeIncidentTriage, makeCliTriage, triageBackend, triageAvailable, INCIDENT_SYSTEM };
