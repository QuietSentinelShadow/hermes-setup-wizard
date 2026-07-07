'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hermes = require('../../lib/hermes');

test('parseEnv handles plain, quoted and export lines', () => {
  const env = hermes.parseEnv([
    'FOO=bar',
    'QUOTED="hello world"',
    "SINGLE='a b'",
    'export EXPORTED=yes',
    '# COMMENT=nope',
    'INVALID LINE',
    'EMPTY=',
  ].join('\n'));
  assert.deepStrictEqual(env, {
    FOO: 'bar', QUOTED: 'hello world', SINGLE: 'a b', EXPORTED: 'yes', EMPTY: '',
  });
});

test('upsertEnvText updates in place and preserves other lines', () => {
  const original = '# my env\nKEEP=1\nTELEGRAM_BOT_TOKEN=old\n\n# trailing comment\n';
  const next = hermes.upsertEnvText(original, { TELEGRAM_BOT_TOKEN: '123:abc', NEW_KEY: 'v' });
  assert.match(next, /# my env\n/);
  assert.match(next, /KEEP=1\n/);
  assert.match(next, /# trailing comment/);
  assert.match(next, /TELEGRAM_BOT_TOKEN=123:abc\n/);
  assert.match(next, /NEW_KEY=v\n/);
  assert.strictEqual((next.match(/TELEGRAM_BOT_TOKEN=/g) || []).length, 1);
});

test('upsertEnvText quotes values with special characters', () => {
  const next = hermes.upsertEnvText('', { K: 'has spaces & $pecial "quotes"' });
  assert.strictEqual(next, 'K="has spaces & $pecial \\"quotes\\""\n');
  // and it round-trips
  assert.strictEqual(hermes.parseEnv(next).K, 'has spaces & $pecial "quotes"');
});

test('upsertEnvText is idempotent', () => {
  const a = hermes.upsertEnvText('', { A: '1', B: '2' });
  const b = hermes.upsertEnvText(a, { A: '1', B: '2' });
  assert.strictEqual(a, b);
});

test('writeEnvValues creates the file under HERMES_SETUP_HOME', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-test-'));
  process.env.HERMES_SETUP_HOME = tmp;
  try {
    hermes.writeEnvValues({ TELEGRAM_BOT_TOKEN: '1:x'.padEnd(40, 'y') });
    const text = fs.readFileSync(path.join(tmp, '.env'), 'utf8');
    assert.match(text, /TELEGRAM_BOT_TOKEN=/);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(tmp, '.env')).mode & 0o777;
      assert.strictEqual(mode, 0o600);
    }
  } finally {
    delete process.env.HERMES_SETUP_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('hermesHome respects HERMES_SETUP_HOME override', () => {
  process.env.HERMES_SETUP_HOME = '/tmp/xyz';
  try {
    assert.strictEqual(hermes.hermesHome(), '/tmp/xyz');
  } finally {
    delete process.env.HERMES_SETUP_HOME;
  }
  assert.notStrictEqual(hermes.hermesHome(), '/tmp/xyz');
});

test('validateTelegramToken matches the Hermes CLI rule', () => {
  assert.ok(hermes.validateTelegramToken('123456789:' + 'A'.repeat(35)));
  assert.ok(hermes.validateTelegramToken('1:' + 'a-b_c'.repeat(6)));      // 30 chars
  assert.ok(!hermes.validateTelegramToken('no-colon'));
  assert.ok(!hermes.validateTelegramToken('123:short'));
  assert.ok(!hermes.validateTelegramToken('abc:' + 'A'.repeat(35)));      // non-numeric id
  assert.ok(!hermes.validateTelegramToken(''));
  assert.ok(!hermes.validateTelegramToken(null));
});

test('installCommand uses the official NousResearch installer', () => {
  const c = hermes.installCommand();
  assert.match(c.shellLine, /hermes-agent\.nousresearch\.com\/install\.(sh|ps1)/);
  if (process.platform === 'win32') {
    assert.strictEqual(c.cmd, 'powershell.exe');
  } else {
    assert.strictEqual(c.cmd, '/bin/bash');
    assert.match(c.args[1], /curl -fsSL/);
  }
});

test('modelConfigCommands for an API-key provider', () => {
  const cmds = hermes.modelConfigCommands('openrouter', 'nousresearch/hermes-4-405b');
  assert.deepStrictEqual(cmds, [
    ['config', 'set', 'model.provider', 'openrouter'],
    ['config', 'set', 'model.default', 'nousresearch/hermes-4-405b'],
  ]);
});

test('modelConfigCommands maps local Ollama onto the custom provider', () => {
  const cmds = hermes.modelConfigCommands('ollama', 'hermes3:latest');
  assert.deepStrictEqual(cmds, [
    ['config', 'set', 'model.provider', 'custom'],
    ['config', 'set', 'model.default', 'hermes3:latest'],
    ['config', 'set', 'model.base_url', 'http://localhost:11434/v1'],
    ['config', 'set', 'model.api_key', 'ollama'],
  ]);
});

test('modelConfigCommands honours base URL / key overrides for custom endpoints', () => {
  const cmds = hermes.modelConfigCommands('custom', 'my-model',
    { baseUrl: 'http://10.0.0.5:8080/v1', apiKey: 'secret' });
  assert.deepStrictEqual(cmds, [
    ['config', 'set', 'model.provider', 'custom'],
    ['config', 'set', 'model.default', 'my-model'],
    ['config', 'set', 'model.base_url', 'http://10.0.0.5:8080/v1'],
    ['config', 'set', 'model.api_key', 'secret'],
  ]);
});

test('modelConfigCommands throws for unknown providers', () => {
  assert.throws(() => hermes.modelConfigCommands('nope', 'x'), /unknown provider/);
});

test('launcherSpawn passes .exe / POSIX launchers through unchanged', () => {
  const s = hermes.launcherSpawn('/home/u/.local/bin/hermes', ['doctor']);
  assert.strictEqual(s.cmd, '/home/u/.local/bin/hermes');
  assert.deepStrictEqual(s.args, ['doctor']);
  assert.deepStrictEqual(s.options, {});

  const exe = hermes.launcherSpawn('C:\\hermes\\bin\\hermes.exe', ['gateway', 'start']);
  assert.strictEqual(exe.cmd, 'C:\\hermes\\bin\\hermes.exe');
  assert.deepStrictEqual(exe.options, {}); // .exe never needs a shell
});

test('launcherSpawn wraps Windows .cmd/.bat and .ps1 launchers', () => {
  // Force the Windows branch regardless of host OS by checking the intent:
  // the function keys off IS_WIN, so only assert here when actually on win32,
  // and always assert the .exe/POSIX pass-through above (host-independent).
  if (hermes.IS_WIN) {
    const cmd = hermes.launcherSpawn('C:\\hermes\\bin\\hermes.cmd', ['whatsapp']);
    assert.strictEqual(cmd.options.shell, true);
    const ps1 = hermes.launcherSpawn('C:\\hermes\\bin\\hermes.ps1', ['doctor']);
    assert.strictEqual(ps1.cmd, 'powershell.exe');
    assert.ok(ps1.args.includes('-File'));
    assert.ok(ps1.args.includes('C:\\hermes\\bin\\hermes.ps1'));
    assert.strictEqual(ps1.args[ps1.args.length - 1], 'doctor');
  }
});

test('provider catalog is well-formed', () => {
  assert.ok(hermes.PROVIDERS.length >= 12, 'expected a broad provider catalog');
  for (const p of hermes.PROVIDERS) {
    assert.ok(p.id && p.name && p.kind, `provider ${p.id} incomplete`);
    assert.ok(['api_key', 'oauth', 'local'].includes(p.kind));
    if (p.kind === 'api_key') assert.ok(p.envKey, `${p.id} missing envKey`);
  }
  // the ones the Hermes README calls out
  for (const id of ['nous', 'openrouter', 'openai-api', 'anthropic', 'huggingface', 'nvidia', 'zai', 'kimi-coding', 'minimax', 'ollama', 'lmstudio', 'custom']) {
    assert.ok(hermes.getProvider(id), `missing provider ${id}`);
  }
});
