const { spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');
const { FileTailer } = require('./tail');

// Operators run Zebra three ways and the sidecar has to meet them there:
// a log_file on disk, a Docker container, or a systemd unit. Each source is an
// EventEmitter that emits 'line' and 'exit'; the pipeline never knows which.

// Any command whose stdout/stderr is the log stream. Docker writes the
// container's stderr to our stderr, so both are read. When the command exits
// (docker logs -f ends when the container restarts) we reattach after a delay,
// because a stream that quietly stopped is the failure this tool exists to catch.
class CommandSource extends EventEmitter {
  constructor(argv, { restartMs = 5000, label } = {}) {
    super();
    this.argv = argv;
    this.restartMs = restartMs;
    this.label = label || argv.join(' ');
    this.child = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.spawn();
    return this;
  }

  spawn() {
    const [cmd, ...args] = this.argv;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream }).on('line', (line) => this.emit('line', line));
    }
    child.on('error', (err) => this.emit('error', err));
    child.on('exit', (code, signal) => {
      this.child = null;
      this.emit('exit', { code, signal });
      if (!this.stopped) this.timer = setTimeout(() => this.spawn(), this.restartMs);
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.child) this.child.kill();
  }
}

function makeSource(cfg) {
  switch (cfg.source) {
    case 'file':
      return new FileTailer(cfg.logFile, { backfillBytes: cfg.backfillBytes });
    case 'docker':
      return new CommandSource(
        ['docker', 'logs', '-f', '--tail', String(cfg.backfillLines), cfg.container],
        { label: `docker:${cfg.container}` },
      );
    case 'journald':
      return new CommandSource(
        ['journalctl', '-f', '-o', 'cat', '-n', String(cfg.backfillLines), '-u', cfg.unit],
        { label: `journald:${cfg.unit}` },
      );
    case 'command':
      return new CommandSource(['sh', '-c', cfg.command], { label: cfg.command });
    case 'none':
      return new EventEmitter(); // RPC-only mode: nothing to tail
    default:
      throw new Error(`unknown log source "${cfg.source}"`);
  }
}

module.exports = { CommandSource, makeSource };
