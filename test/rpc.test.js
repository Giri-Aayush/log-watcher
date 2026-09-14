const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ZebraRpc } = require('../src/zebra/rpc');

// Zebra does not answer a bad cookie with 401: it closes the connection.
// This server does the same, and the test rotates the cookie file the way a
// node restart does.
function cookieServer(getCookie) {
  const server = http.createServer((req, res) => {
    const expected = 'Basic ' + Buffer.from(getCookie()).toString('base64');
    if (req.headers.authorization !== expected) return req.socket.destroy();
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: 7 })));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

test('re-reads a rotated cookie after the node closes the connection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-rpc-'));
  const cookieFile = path.join(dir, '.cookie');
  let cookie = '__cookie__:one';
  fs.writeFileSync(cookieFile, cookie);
  const { server, url } = await cookieServer(() => cookie);
  const rpc = new ZebraRpc({ url, cookieFile, timeoutMs: 1000 });

  assert.equal((await rpc.call('getblockcount')).result, 7);

  // node restarts: new cookie on disk, old one now gets the socket closed
  cookie = '__cookie__:two';
  await new Promise((r) => setTimeout(r, 20)); // distinct mtime
  fs.writeFileSync(cookieFile, cookie);
  assert.equal((await rpc.call('getblockcount')).result, 7, 'picks up the new cookie from the file mtime');

  // stale credential in memory (mtime unchanged) -> one failed call, then recovery
  rpc.auth = '__cookie__:stale';
  await assert.rejects(rpc.call('getblockcount'), (e) => e.kind === 'network');
  assert.equal((await rpc.call('getblockcount')).result, 7, 'a network error forces a re-read');
  server.close();
});

test('errors carry the cause, the method and the elapsed time', async () => {
  // a port that was just listening and is now closed: a dead node, not an invalid URL
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${probe.address().port}`;
  await new Promise((r) => probe.close(r));
  const rpc = new ZebraRpc({ url, timeoutMs: 1000 });
  await assert.rejects(rpc.call('getinfo'), (e) => e.kind === 'network' && e.method === 'getinfo' && /ECONNREFUSED/.test(e.message) && typeof e.ms === 'number');
});
