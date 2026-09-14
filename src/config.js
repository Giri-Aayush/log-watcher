const fs = require('fs');

// Configuration comes from defaults < JSON file (--config / LW_CONFIG) < LW_*
// environment variables. Env wins because that is what docker-compose and
// systemd EnvironmentFile= hand you.

const defaults = {
  label: 'zebra',
  port: 3000,
  dashboardUrl: null, // how Zero can reach this sidecar's own page, if at all (LW_DASHBOARD_URL); sent in heartbeats
  source: 'file', // file | docker | journald | command | none
  logFile: null,
  container: 'zebra',
  unit: 'zebrad',
  command: null,
  backfillBytes: 64 * 1024,
  backfillLines: 500,
  ringSize: 2000,
  replayAgeS: 60, // log lines older than this on arrival are history, not incidents
  rpc: {
    url: 'http://127.0.0.1:8232',
    cookieFile: null,
    user: null,
    pass: null,
    timeoutMs: 10000,
    pollMs: 15000,
    blockDetail: true, // getblock for every committed block (size / tx count / lag)
    gbtPollMs: 0, // >0 polls getblocktemplate: the call a mining pool actually makes
  },
  share: {
    logs: 'full', // what leaves the box in a page: full | summary (WARN/ERROR + last 5 lines) | none
    host: false, // include the sidecar's hostname
  },
  metrics: {
    url: null, // e.g. http://127.0.0.1:9999 when [metrics] endpoint_addr is set
    pollMs: 30000,
    family: 'zebra_consensus_transaction_duration_seconds',
    p99WarnS: 2,
  },
  thresholds: {
    tipStallMin: 10,
    minPeers: 3,
    rpcSlowMs: 2000,
    rpcFailCount: 3,
    gbtSlowMs: 2000,
    errorBurst: 10,
    errorWindowS: 60,
    mempoolMax: 5000,
    bigBlockTxs: 1000,
    bigBlockBytes: 1500000,
    blockLagS: 90,
    eosWarnBlocks: 32256, // ~4 weeks at 75s
  },
  alerts: {
    cooldownMin: 30,
    transientCooldownS: 60,
    bundleDir: 'bundles',
    bundleLogLines: 200,
    heartbeat: true, // POST a state summary to sinks.webhookUrl on every poll
  },
  sinks: {
    webhookUrl: null,
    discordWebhook: null,
    telegramToken: null,
    telegramChat: null,
    signalUrl: null,
    signalNumber: null,
    signalRecipient: null,
  },
  triage: {
    apiKey: null,
    model: 'claude-opus-5',
  },
};

// LW_RPC_URL -> rpc.url, LW_TIP_STALL_MIN -> thresholds.tipStallMin, etc.
const envMap = {
  LW_LABEL: 'label', LW_PORT: 'port', LW_DASHBOARD_URL: 'dashboardUrl', LW_SOURCE: 'source', LW_LOG_FILE: 'logFile',
  LW_CONTAINER: 'container', LW_UNIT: 'unit', LW_COMMAND: 'command', LW_REPLAY_AGE_S: 'replayAgeS',
  LW_RPC_URL: 'rpc.url', LW_RPC_COOKIE: 'rpc.cookieFile', LW_RPC_USER: 'rpc.user', LW_RPC_PASS: 'rpc.pass',
  LW_RPC_TIMEOUT_MS: 'rpc.timeoutMs', LW_POLL_MS: 'rpc.pollMs', LW_BLOCK_DETAIL: 'rpc.blockDetail', LW_GBT_POLL_MS: 'rpc.gbtPollMs',
  LW_SHARE_LOGS: 'share.logs', LW_SHARE_HOST: 'share.host',
  LW_METRICS_URL: 'metrics.url', LW_METRICS_POLL_MS: 'metrics.pollMs', LW_METRICS_FAMILY: 'metrics.family', LW_VERIFY_P99_S: 'metrics.p99WarnS',
  LW_TIP_STALL_MIN: 'thresholds.tipStallMin', LW_MIN_PEERS: 'thresholds.minPeers', LW_RPC_SLOW_MS: 'thresholds.rpcSlowMs',
  LW_RPC_FAIL_COUNT: 'thresholds.rpcFailCount', LW_GBT_SLOW_MS: 'thresholds.gbtSlowMs', LW_ERROR_BURST: 'thresholds.errorBurst', LW_ERROR_WINDOW_S: 'thresholds.errorWindowS',
  LW_MEMPOOL_MAX: 'thresholds.mempoolMax', LW_BIG_BLOCK_TXS: 'thresholds.bigBlockTxs', LW_BIG_BLOCK_BYTES: 'thresholds.bigBlockBytes',
  LW_BLOCK_LAG_S: 'thresholds.blockLagS', LW_EOS_WARN_BLOCKS: 'thresholds.eosWarnBlocks',
  LW_COOLDOWN_MIN: 'alerts.cooldownMin', LW_BUNDLE_DIR: 'alerts.bundleDir', LW_BUNDLE_LOG_LINES: 'alerts.bundleLogLines', LW_HEARTBEAT: 'alerts.heartbeat', LW_TRANSIENT_COOLDOWN_S: 'alerts.transientCooldownS',
  LW_WEBHOOK_URL: 'sinks.webhookUrl', LW_DISCORD_WEBHOOK: 'sinks.discordWebhook',
  LW_TELEGRAM_TOKEN: 'sinks.telegramToken', LW_TELEGRAM_CHAT: 'sinks.telegramChat',
  LW_SIGNAL_URL: 'sinks.signalUrl', LW_SIGNAL_NUMBER: 'sinks.signalNumber', LW_SIGNAL_RECIPIENT: 'sinks.signalRecipient',
  ANTHROPIC_API_KEY: 'triage.apiKey', LW_TRIAGE_MODEL: 'triage.model',
};

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = cur[k] ||= {};
  cur[keys[keys.length - 1]] = value;
}

function coerce(existing, raw) {
  if (typeof existing === 'number') return Number(raw);
  if (typeof existing === 'boolean') return raw === '1' || raw === 'true';
  return raw;
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k] || {}, v) : v;
  }
  return out;
}

function loadConfig({ env = process.env, argv = process.argv } = {}) {
  let cfg = structuredClone(defaults);
  const idx = argv.indexOf('--config');
  const file = idx !== -1 ? argv[idx + 1] : env.LW_CONFIG;
  if (file) cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
  for (const [name, dotted] of Object.entries(envMap)) {
    if (env[name] != null && env[name] !== '') setPath(cfg, dotted, coerce(getPath(defaults, dotted), env[name]));
  }
  if (cfg.source === 'file' && !cfg.logFile) cfg.source = 'none';
  return cfg;
}

module.exports = { loadConfig, defaults };
