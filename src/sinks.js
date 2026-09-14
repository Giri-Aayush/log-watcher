const { applySharePolicy } = require('./share');

// Where alerts go. Every sink takes { alert, phase, text } and posts the
// pre-formatted text; sinks never decide what to say, only where.
//
// Signal is the one operators actually read at 3am, and it has no webhooks.
// signal-cli-rest-api (bbernhard/signal-cli-rest-api) exposes POST /v2/send
// on a loopback port; that container is what the Signal sink talks to.

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

const consoleSink = {
  name: 'console',
  async send({ text }) {
    console.log(`\n${text}\n`);
  },
};

// The collector gets its messages through the outbox (ordered, retried),
// not a bare POST: a page must not be lost because the collector was
// restarting at the wrong moment.
function outboxSink(outbox, label, share) {
  return {
    name: 'collector',
    send: async ({ alert, phase, text }) => {
      const bundle = phase === 'RESOLVED' && alert.resolvedBundle ? alert.resolvedBundle : alert.bundle;
      outbox.push({
        phase,
        label,
        text,
        alert: { ...alert, bundle: undefined, resolvedBundle: undefined },
        bundle: bundle ? applySharePolicy(bundle, share) : null,
      });
    },
  };
}

function discordSink(url) {
  return { name: 'discord', send: ({ text }) => post(url, { content: '```\n' + text.slice(0, 1900) + '\n```' }) };
}

function telegramSink(token, chatId) {
  return {
    name: 'telegram',
    send: ({ text }) => post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: text.slice(0, 4000) }),
  };
}

function signalSink(url, number, recipient) {
  return {
    name: 'signal',
    send: ({ text }) => post(url, { message: text, number, recipients: [recipient || number] }),
  };
}

function buildSinks(cfg, { outbox, label, share } = {}) {
  const sinks = [consoleSink];
  if (cfg.webhookUrl && outbox) sinks.push(outboxSink(outbox, label, share));
  if (cfg.discordWebhook) sinks.push(discordSink(cfg.discordWebhook));
  if (cfg.telegramToken && cfg.telegramChat) sinks.push(telegramSink(cfg.telegramToken, cfg.telegramChat));
  if (cfg.signalUrl && cfg.signalNumber) sinks.push(signalSink(cfg.signalUrl, cfg.signalNumber, cfg.signalRecipient));
  return sinks;
}

module.exports = { buildSinks, consoleSink, outboxSink, discordSink, telegramSink, signalSink };
