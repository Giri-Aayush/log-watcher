const fs = require('fs');

// Minimal JSON-RPC client for zebrad. Every call reports how long it took,
// because RPC latency is itself a signal: the miner who "missed a block" saw
// it first as a getblocktemplate call that timed out.
//
// Auth is Zebra's cookie file (rpc.enable_cookie_auth, on by default since
// 2.x): the file holds "__cookie__:<token>" and is sent as HTTP Basic. The
// cookie is regenerated on every node start, and Zebra answers a stale one by
// closing the connection rather than with a 401, so the file is re-read
// whenever its mtime changes and after any network error.
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
    this.cookieMtime = null;
    this.id = 0;
  }

  readCookie() {
    if (!this.cookieFile) return;
    const st = fs.statSync(this.cookieFile);
    if (st.mtimeMs === this.cookieMtime) return;
    this.auth = fs.readFileSync(this.cookieFile, 'utf8').trim();
    this.cookieMtime = st.mtimeMs;
  }

  headers() {
    const h = { 'content-type': 'application/json' };
    if (this.cookieFile) {
      try {
        this.readCookie();
      } catch {
        // the node is (re)starting and has not written it yet; send what we have
      }
    }
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
      this.cookieMtime = null; // a closed connection may be a stale cookie: re-read next time
      // fetch() says "fetch failed"; the useful part (ECONNREFUSED, ECONNRESET) is in cause.
      const why = kind === 'timeout' ? `timed out after ${ms}ms` : (err.cause && err.cause.message) || err.message;
      throw new RpcError(`${method}: ${why}`, { kind, ms, method });
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - started;
    if (res.status === 401 && this.cookieFile && retryAuth) {
      this.cookieMtime = null;
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
