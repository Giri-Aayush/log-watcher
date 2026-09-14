const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FileTailer } = require('../src/tail');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lw-')), 'zebrad.log');
}

test('emits only appended lines, keeps partial lines until the newline arrives', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'old1\nold2\n');
  const t = new FileTailer(file, { backfillBytes: 0 });
  const got = [];
  t.on('line', (l) => got.push(l));
  t.start();
  t.stop();
  assert.deepEqual(got, []); // started at end
  fs.appendFileSync(file, 'new1\nnew2\npart');
  t.poll();
  assert.deepEqual(got, ['new1', 'new2']);
  fs.appendFileSync(file, 'ial\n');
  t.poll();
  assert.deepEqual(got, ['new1', 'new2', 'partial']);
});

test('backfill cuts the leading partial line', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'aaaa\nbbbb\ncccc\n');
  const t = new FileTailer(file, { backfillBytes: 7 }); // lands mid-"bbbb"
  const got = [];
  t.on('line', (l) => got.push(l));
  t.start();
  t.stop();
  assert.deepEqual(got, ['cccc']);
});

test('truncation and rename rotation restart from offset 0', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'x\n');
  const t = new FileTailer(file, { backfillBytes: 0 });
  const got = [];
  const rotations = [];
  t.on('line', (l) => got.push(l));
  t.on('rotate', (r) => rotations.push(r.reason));
  t.start();
  t.stop();
  fs.appendFileSync(file, 'one\n');
  t.poll();
  fs.writeFileSync(file, 'a\n'); // truncate + rewrite (copytruncate style)
  t.poll();
  fs.renameSync(file, `${file}.1`); // logrotate style: new inode
  fs.writeFileSync(file, 'b\n');
  t.poll();
  assert.deepEqual(got, ['one', 'a', 'b']);
  assert.deepEqual(rotations, ['truncate', 'inode']);
});
