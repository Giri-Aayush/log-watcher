const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, splitFields, heightOf, hashOf, secondsOf } = require('../src/zebra/parse');
const { toEvents, metaFromContinuation } = require('../src/zebra/events');
const { lines } = require('./fixtures');

test('plain target line with trailing fields', () => {
  const e = parseLine(lines.atTip);
  assert.equal(e.kind, 'entry');
  assert.equal(e.level, 'INFO');
  assert.equal(e.target, 'zebrad::components::sync::progress');
  assert.equal(e.message, 'finished initial sync to chain tip, using gossiped blocks');
  assert.equal(e.fields.current_height, 'Height(4345594)');
  assert.equal(e.fields.sync_percent, '100.000%');
  assert.equal(e.time, Date.parse('2026-09-14T11:15:22.990Z'));
});

test('single span before target', () => {
  const e = parseLine(lines.waiting);
  assert.deepEqual(e.spans.map((s) => s.name), ['sync']);
  assert.equal(e.target, 'zebrad::components::sync');
  assert.equal(e.fields.state_tip, 'Some(Height(4345594))');
});

test('span chain with quoted colons and nested parens, empty message', () => {
  const e = parseLine(lines.inbound);
  assert.equal(e.spans.length, 4);
  assert.equal(e.spans[0].fields.peer, 'In("v4redacted:42588")');
  assert.equal(e.spans[3].name, 'download_and_verify');
  assert.equal(e.spans[3].fields.hash, '0000a6a8c81ab5193f4f997029101afb65feecfbbb781ea9e780c64244c3867e');
  assert.equal(e.target, 'zebrad::components::inbound::downloads');
  assert.equal(e.message, '');
});

test('field value containing spaces and a nested quoted string', () => {
  const e = parseLine(lines.committed);
  assert.equal(e.fields.request, 'AdvertiseBlock(block::Hash("00009739deaaad04500e21a619c16b00df13fa986cc2a91955a8e86e349b0082"), None)');
  assert.equal(e.fields.log_msg, 'sending committed block broadcast'); // unquoted
});

test('message containing braces and colons is not mistaken for fields', () => {
  const e = parseLine(lines.regtestWarn);
  assert.equal(e.level, 'WARN');
  assert.equal(e.target, 'zebra_network::peer_set::initialize');
  assert.match(e.message, /^We are configured with address/);
  assert.deepEqual(e.fields, {});
});

test('continuation lines and ANSI colour codes', () => {
  assert.equal(parseLine(lines.bannerVersion).kind, 'continuation');
  assert.deepEqual(metaFromContinuation(lines.bannerVersion), { version: '6.2.0' });
  assert.deepEqual(metaFromContinuation(lines.bannerNetwork), { network: 'Regtest' });
  const e = parseLine(lines.ansi);
  assert.equal(e.kind, 'entry');
  assert.equal(e.target, 'zebrad::components::sync');
  assert.equal(e.fields.timeout, '67s');
});

test('helpers', () => {
  assert.equal(heightOf('Some(Height(4345594))'), 4345594);
  assert.equal(hashOf('block::Hash("00009739deaaad04500e21a619c16b00df13fa986cc2a91955a8e86e349b0082")'), '00009739deaaad04500e21a619c16b00df13fa986cc2a91955a8e86e349b0082');
  assert.equal(secondsOf('12m 3s'), 723);
  assert.equal(secondsOf('0s'), 0);
  assert.equal(secondsOf('nope'), null);
  assert.deepEqual(splitFields('hello a=1 b="two words" c=Some(x y)'), { message: 'hello', fields: { a: '1', b: 'two words', c: 'Some(x y)' } });
});

test('events: block commits from gossip, mined and submitblock', () => {
  assert.deepEqual(toEvents(parseLine(lines.committed))[0], { type: 'block_committed', height: 4345594, hash: '00009739deaaad04500e21a619c16b00df13fa986cc2a91955a8e86e349b0082', mined: false });
  assert.equal(toEvents(parseLine(lines.mined))[0].mined, true);
  const sub = toEvents(parseLine(lines.submitted))[0];
  assert.equal(sub.type, 'block_committed');
  assert.equal(sub.height, 1);
});

test('events: sync states, restart, end of support, warn/error', () => {
  assert.equal(toEvents(parseLine(lines.atTip))[0].state, 'at_tip');
  assert.equal(toEvents(parseLine(lines.verySlow))[0].state, 'very_slow');
  const stalled = toEvents(parseLine(lines.stalled));
  assert.equal(stalled[0].state, 'stalled');
  assert.equal(stalled[0].sinceLastBlockS, 723);
  assert.equal(stalled[1].type, 'log_warn');
  assert.equal(toEvents(parseLine(lines.banner))[0].type, 'node_started');
  assert.deepEqual(toEvents(parseLine(lines.eosUntil))[0], { type: 'end_of_support', haltHeight: 3200000 });
  assert.deepEqual(toEvents(parseLine(lines.eosTestnet)), []);
  const err = toEvents(parseLine(lines.error))[0];
  assert.equal(err.type, 'log_error');
  assert.equal(err.entry.fields.error, 'Disk full');
});
