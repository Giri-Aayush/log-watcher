const fs = require('fs');
const { EventEmitter } = require('events');

// tail -F for one file: reads only the bytes appended since the last read,
// so a busy log costs one small read per poll instead of re-reading the end
// of the file. Rotation (size shrinks, or the inode changes because logrotate
// renamed the file and the writer created a new one) resets to offset 0.
//
// Polling stat() rather than fs.watch: fs.watch follows the inode, so after a
// rename it keeps watching the old file forever. A 500ms stat is cheap and
// behaves the same on macOS, Linux and inside a container.
class FileTailer extends EventEmitter {
  constructor(path, { pollMs = 500, backfillBytes = 64 * 1024 } = {}) {
    super();
    this.path = path;
    this.pollMs = pollMs;
    this.backfillBytes = backfillBytes;
    this.pos = 0;
    this.ino = null;
    this.remainder = '';
    this.timer = null;
    this.reading = false;
  }

  start() {
    let st = null;
    try {
      st = fs.statSync(this.path);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (st) {
      this.ino = st.ino;
      // Start a little way back so the first screen has context. If that lands
      // mid-line (the byte before it is not a newline) the first "line" would
      // be a fragment, so drop it.
      this.pos = Math.max(0, st.size - this.backfillBytes);
      if (this.pos > 0) {
        const fd = fs.openSync(this.path, 'r');
        try {
          const b = Buffer.alloc(1);
          fs.readSync(fd, b, 0, 1, this.pos - 1);
          this.skipPartialLine = b[0] !== 0x0a;
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.poll();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  poll() {
    if (this.reading) return;
    let st;
    try {
      st = fs.statSync(this.path);
    } catch (err) {
      if (err.code === 'ENOENT') return; // rotated away, wait for the new file
      return this.emit('error', err);
    }
    if (this.ino !== null && st.ino !== this.ino) {
      this.emit('rotate', { reason: 'inode' });
      this.pos = 0;
      this.remainder = '';
    } else if (st.size < this.pos) {
      this.emit('rotate', { reason: 'truncate' });
      this.pos = 0;
      this.remainder = '';
    }
    this.ino = st.ino;
    if (st.size === this.pos) return;

    this.reading = true;
    const fd = fs.openSync(this.path, 'r');
    try {
      const buf = Buffer.alloc(st.size - this.pos);
      const n = fs.readSync(fd, buf, 0, buf.length, this.pos);
      this.pos += n;
      this.consume(buf.toString('utf8', 0, n));
    } finally {
      fs.closeSync(fd);
      this.reading = false;
    }
  }

  consume(chunk) {
    const text = this.remainder + chunk;
    const lines = text.split('\n');
    this.remainder = lines.pop(); // '' when the chunk ended on a newline
    for (let line of lines) {
      if (this.skipPartialLine) {
        this.skipPartialLine = false;
        continue;
      }
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.emit('line', line);
    }
  }
}

module.exports = { FileTailer };
