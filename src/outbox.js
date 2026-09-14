const { EventEmitter } = require('events');

// Ordered, at-least-once delivery from the sidecar to the collector.
//
// One request in flight at a time, so RESOLVED can never overtake NEW. A
// failed send is retried with backoff and the queue holds until it works;
// every message carries a sequence number so the collector can drop the
// duplicate when a retry follows a request that did land. Heartbeats are
// state, not events: only the newest unsent one is kept, so a collector that
// is down for an hour costs a few alerts of memory, not thousands of beats.
class Outbox extends EventEmitter {
  constructor({ url, maxQueue = 1000, baseDelayMs = 1000, maxDelayMs = 30000, timeoutMs = 10000, now = Date.now, fetchImpl = fetch, setTimeoutImpl = setTimeout } = {}) {
    super();
    this.url = url;
    this.maxQueue = maxQueue;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.setTimeoutImpl = setTimeoutImpl;
    this.queue = [];
    this.seq = 0;
    this.sending = false;
    this.stopped = false;
    this.stats = { queued: 0, delivered: 0, dropped: 0, retries: 0, lastError: null, lastDeliveredAt: null, consecutiveFailures: 0 };
  }

  push(msg) {
    if (!this.url) return null;
    if (msg.phase === 'HEARTBEAT') {
      const i = this.queue.findIndex((m) => m.phase === 'HEARTBEAT');
      if (i !== -1) this.queue.splice(i, 1);
    }
    const entry = { ...msg, seq: ++this.seq, queuedAt: this.now(), inFlight: false };
    this.queue.push(entry);
    while (this.queue.length > this.maxQueue) {
      // drop the oldest heartbeat first; an alert is worth more than a beat.
      // An in-flight message may be dropped too: if its send lands anyway,
      // completion removes it by identity, not by position.
      const i = this.queue.findIndex((m) => m.phase === 'HEARTBEAT');
      this.queue.splice(i !== -1 ? i : 0, 1);
      this.stats.dropped++;
    }
    this.stats.queued = this.queue.length;
    if (!this.retryTimer) this.pump(); // during backoff, new messages wait their turn
    return entry.seq;
  }

  async pump() {
    this.retryTimer = null;
    if (this.sending || this.stopped || this.queue.length === 0) return;
    this.sending = true;
    const msg = this.queue[0];
    msg.inFlight = true;
    const { inFlight, queuedAt, ...body } = msg;
    body.sentAt = this.now();
    let ok = false;
    try {
      const ctrl = new AbortController();
      const timer = this.setTimeoutImpl(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        ok = true;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.stats.lastError = err.name === 'AbortError' ? 'timeout' : (err.cause && err.cause.message) || err.message;
    }
    if (ok) {
      const i = this.queue.indexOf(msg);
      if (i !== -1) this.queue.splice(i, 1);
      this.stats.delivered++;
      this.stats.lastDeliveredAt = this.now();
      if (this.stats.consecutiveFailures) this.emit('recovered', this.stats.consecutiveFailures);
      this.stats.consecutiveFailures = 0;
      this.stats.queued = this.queue.length;
      this.sending = false;
      this.emit('delivered', msg.seq);
      this.pump();
    } else {
      msg.inFlight = false;
      this.stats.retries++;
      this.stats.consecutiveFailures++;
      this.stats.queued = this.queue.length;
      if (this.stats.consecutiveFailures === 1) this.emit('failing', this.stats.lastError);
      const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(10, this.stats.consecutiveFailures - 1));
      this.sending = false;
      this.retryTimer = this.setTimeoutImpl(() => this.pump(), delay);
      if (this.retryTimer && this.retryTimer.unref) this.retryTimer.unref();
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
  }
}

module.exports = { Outbox };
