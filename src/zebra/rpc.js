const fs = require('fs');

// Minimal JSON-RPC client for zebrad. Every call reports how long it took,
// because RPC latency is itself a signal: the miner who "missed a block" saw
// it first as a getblocktemplate call that timed out.
//
// Auth is Zebra's cookie file (rpc.enable_cookie_auth, on by default since
// 2.x): the file holds "__cookie__:<token>" and is sent as HTTP Basic. The
// cookie is regenerated on every node start, so a 401 re-reads it once and
// retries rather than failing until the sidecar restarts.
class RpcError extends Error {
  constructor(message, { kind, code, ms, method }) {
    super(message);
    this.kind = kind; // 'timeout' | 'network' | 'http' | 'rpc'
    this.code = code;
    this.ms = ms;
    this.method = method;
  }
}

class ZebraRpc {
  constructor({ url, cookieFile, user, pass, timeoutMs = 10000 }) {
    this.url = url;
    this.cookieFile = cookieFile;
    this.timeoutMs = timeoutMs;
    this.auth = user ? `${user}:${pass || ''}` : null;
    this.id = 0;
  }

  readCookie() {
    if (!this.cookieFile) return;
    this.auth = fs.readFileSync(this.cookieFile, 'utf8').trim();
  }

  headers() {
    const h = { 'content-type': 'application/json' };
    if (this.auth === null && this.cookieFile) this.readCookie();
    if (this.auth) h.authorization = `Basic ${Buffer.from(this.auth).toString('base64')}`;
    return h;
  }

  async call(method, params = [], { retryAuth = true } = {}) {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: ctrl.signal,
      });
    } catch (err) {
      const ms = Date.now() - started;
      const kind = err.name === 'AbortError' ? 'timeout' : 'network';
      throw new RpcError(`${method}: ${kind === 'timeout' ? `timed out after ${ms}ms` : err.message}`, { kind, ms, method });
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - started;
    if (res.status === 401 && this.cookieFile && retryAuth) {
      this.readCookie();
      return this.call(method, params, { retryAuth: false });
    }
    if (!res.ok) throw new RpcError(`${method}: HTTP ${res.status}`, { kind: 'http', code: res.status, ms, method });
    const body = await res.json();
    if (body.error) throw new RpcError(`${method}: ${body.error.message}`, { kind: 'rpc', code: body.error.code, ms, method });
    return { result: body.result, ms };
  }

  getBlockchainInfo() { return this.call('getblockchaininfo'); }
  getInfo() { return this.call('getinfo'); }
  getPeerInfo() { return this.call('getpeerinfo'); }
  getMempoolInfo() { return this.call('getmempoolinfo'); }
  getBlock(hashOrHeight, verbosity = 1) { return this.call('getblock', [String(hashOrHeight), verbosity]); }
}

module.exports = { ZebraRpc, RpcError };
