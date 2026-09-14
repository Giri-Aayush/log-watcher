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

module.exports = { makeTriage };
