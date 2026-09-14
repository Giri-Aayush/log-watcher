const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { makeCliTriage, triageBackend, INCIDENT_SYSTEM } = require('../src/triage');

// a fake `claude` process: records its argv and stdin, answers on stdout
function fakeSpawn(answer, { code = 0, stderr = '' } = {}) {
  const calls = [];
  const impl = (bin, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let input = '';
    child.stdin = { end: (s) => { input = s; setImmediate(() => { if (stderr) child.stderr.emit('data', stderr); child.stdout.emit('data', answer); child.emit('close', code); }); } };
    child.kill = () => {};
    calls.push({ bin, args, get input() { return input; } });
    return child;
  };
  return { impl, calls };
}

test('the CLI backend runs claude in print mode with no tools and feeds it the context', async () => {
  const f = fakeSpawn('Assessment: expected on regtest.\nConfidence: high — none.\n', { stderr: 'Permission allow rule warning\n' });
  const triage = makeCliTriage({ model: 'opus', spawnImpl: f.impl });
  const out = await triage({ incident: { key: 'sync_stalled' } });
  assert.equal(out.model, 'claude-cli/opus');
  assert.match(out.text, /^Assessment: expected on regtest\./);
  const [call] = f.calls;
  assert.equal(call.bin, 'claude');
  assert.ok(call.args.includes('-p') && call.args.includes('--max-turns') && call.args.includes('--no-session-persistence'));
  assert.ok(call.args[call.args.indexOf('--disallowedTools') + 1].includes('Bash'));
  assert.equal(call.args[call.args.indexOf('--append-system-prompt') + 1], INCIDENT_SYSTEM);
  assert.match(call.input, /"key": "sync_stalled"/);
});

test('a failing CLI surfaces its last stderr line', async () => {
  const f = fakeSpawn('', { code: 1, stderr: 'boot\nNot logged in\n' });
  await assert.rejects(makeCliTriage({ spawnImpl: f.impl })({}), /exited 1: Not logged in/);
});

test('backend selection: key wins, then the CLI, then nothing; LW_TRIAGE overrides', () => {
  const cli = () => true, noCli = () => false;
  assert.equal(triageBackend({ ANTHROPIC_API_KEY: 'k' }, { hasCli: cli }), 'api');
  assert.equal(triageBackend({}, { hasCli: cli }), 'cli');
  assert.equal(triageBackend({}, { hasCli: noCli }), null);
  assert.equal(triageBackend({ ANTHROPIC_API_KEY: 'k', LW_TRIAGE: 'off' }, { hasCli: cli }), null);
  assert.equal(triageBackend({ ANTHROPIC_API_KEY: 'k', LW_TRIAGE: 'cli' }, { hasCli: cli }), 'cli');
  assert.equal(triageBackend({ LW_TRIAGE: 'api' }, { hasCli: noCli }), 'api');
});

test('the system prompt enforces the voice and the limits', () => {
  assert.match(INCIDENT_SYSTEM, /ten-plus years/);
  assert.match(INCIDENT_SYSTEM, /under 160 words/);
  assert.match(INCIDENT_SYSTEM, /Regtest has no peers/);
});
