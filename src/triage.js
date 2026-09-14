const Anthropic = require('@anthropic-ai/sdk');

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

const INCIDENT_SYSTEM = `You are the first responder on the Zero support rotation at Shielded Labs. Zero supports exchanges, mining pools and wallet providers that run Zcash Zebra nodes. A sidecar next to each node detects problems and pages; you are looking at one incident with its context.

You are given: the incident (detector key, severity, timestamps, evidence, the detector's own suggested next steps), the bundle the sidecar captured when it paged (node version, network, tip, peers, RPC latency, last block, recent log lines), the state of the other nodes on the same network right now, this node's recent incident history, and a summary of the last hour of heartbeats.

Reason from the evidence only. If the other nodes on the network show the same thing, say it is the network (or Zero's view of it), not this customer. If the network is Regtest or a test network, say what is expected behaviour there (for example, Zebra's "initial sync is very slow" warning fires on every regtest node forever because it estimates the tip from the wall clock). Do not speculate beyond what is shown; say what you would need to see next.

Answer in exactly these sections, plain text, no markdown headings, each label on its own line followed by its content:
Assessment: two or three sentences, high level — what is happening, whether it is node-local, network-wide, or expected on this network, and how urgent it is.
Probable cause: one or two sentences.
Check next: 3-5 specific commands or log lines to look at, in order.
Regtest repro: how to reproduce on a zebrad regtest node, or "not reproducible on regtest" and why.
Draft to operator: 2-4 sentences the engineer could send the operator now, factual, no promises. If the incident is network-wide or expected behaviour, say that instead of asking them to act.
Confidence: low, medium or high, and the one thing that would change it.`;

function makeIncidentTriage({ model = 'claude-opus-5', client = null } = {}) {
  const api = client || new Anthropic(); // resolves ANTHROPIC_API_KEY / an `ant auth login` profile itself
  return async function triageIncident(context) {
    const response = await api.beta.messages.create({
      model,
      max_tokens: 4096, // a triage note, not an essay
      system: INCIDENT_SYSTEM,
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

function triageAvailable(env = process.env) {
  return !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

module.exports = { makeTriage, makeIncidentTriage, triageAvailable };
