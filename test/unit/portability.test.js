'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../../lib/portability');
const portio = require('../../lib/portio');

// Build a fake ~/.hermes with the mix of keep/skip entries a real one has.
function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-src-'));
  fs.writeFileSync(path.join(home, '.env'), 'TELEGRAM_BOT_TOKEN=1:secret\nOPENROUTER_API_KEY=sk-or-abc\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'config.yaml'), `model:\n  provider: custom\n  base_url: "http://localhost:11434/v1"\nlog_path: ${home}/logs/app.log\n`);
  fs.writeFileSync(path.join(home, 'auth.json'), '{"nous":{"token":"xyz"}}', { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'SOUL.md'), '# Who I am\n');
  fs.mkdirSync(path.join(home, 'memories'));
  fs.writeFileSync(path.join(home, 'memories', 'note.md'), 'remember this');
  fs.mkdirSync(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(home, 'sessions', 'chat1.json'), '{"msgs":[]}');
  fs.mkdirSync(path.join(home, 'cron'));
  fs.writeFileSync(path.join(home, 'cron', 'daily.json'), '{}');
  // things that must NOT travel
  fs.mkdirSync(path.join(home, 'node'));
  fs.writeFileSync(path.join(home, 'node', 'bin'), 'BINARY');
  fs.mkdirSync(path.join(home, 'hermes-agent'));
  fs.writeFileSync(path.join(home, 'hermes-agent', 'cli.py'), 'code');
  fs.mkdirSync(path.join(home, 'logs'));
  fs.writeFileSync(path.join(home, 'logs', 'run.log'), 'noise');
  fs.writeFileSync(path.join(home, 'models_dev_cache.json'), '{}');
  fs.writeFileSync(path.join(home, 'auth.lock'), '');
  return home;
}

test('planExport keeps identity/secrets and drops binaries, caches, logs', () => {
  const home = fakeHome();
  try {
    const plan = P.planExport(home, { includeSessions: true });
    const names = plan.entries.map((e) => e.name);
    for (const keep of ['.env', 'config.yaml', 'auth.json', 'SOUL.md', 'memories', 'sessions', 'cron']) {
      assert.ok(names.includes(keep), `should keep ${keep}`);
    }
    for (const drop of ['node', 'hermes-agent', 'logs', 'models_dev_cache.json', 'auth.lock']) {
      assert.ok(!names.includes(drop), `should drop ${drop}`);
    }
    assert.strictEqual(P.categoryOf('.env'), 'secrets');
    assert.strictEqual(P.categoryOf('SOUL.md'), 'identity');
    assert.strictEqual(P.categoryOf('sessions'), 'sessions');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('planExport can exclude session history', () => {
  const home = fakeHome();
  try {
    const plan = P.planExport(home, { includeSessions: false });
    const names = plan.entries.map((e) => e.name);
    assert.ok(!names.includes('sessions'));
    assert.ok(plan.excluded.some((x) => x.name === 'sessions'));
    assert.ok(names.includes('memories')); // memories still travel
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('full export → import round-trip restores files, modes and contents', async () => {
  const home = fakeHome();
  const outFile = path.join(os.tmpdir(), `rt-${Date.now()}.hermesport`);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dst-'));
  try {
    await portio.exportBundle({ home, outFile, passphrase: 'correct horse battery', includeSessions: true });
    assert.ok(fs.statSync(outFile).size > 0);

    const res = await portio.importBundle({
      file: outFile, passphrase: 'correct horse battery',
      targetHome: target, targetHomeDir: os.homedir(),
    });

    assert.deepStrictEqual(
      fs.readFileSync(path.join(target, '.env'), 'utf8'),
      fs.readFileSync(path.join(home, '.env'), 'utf8'),
    );
    assert.strictEqual(fs.readFileSync(path.join(target, 'memories', 'note.md'), 'utf8'), 'remember this');
    assert.strictEqual(fs.readFileSync(path.join(target, 'sessions', 'chat1.json'), 'utf8'), '{"msgs":[]}');
    // binaries did not travel
    assert.ok(!fs.existsSync(path.join(target, 'node')));
    assert.ok(!fs.existsSync(path.join(target, 'hermes-agent')));
    // secret file mode preserved on POSIX
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(path.join(target, '.env')).mode & 0o777, 0o600);
    }
    assert.strictEqual(res.meta.sourceHermesHome, home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(outFile, { force: true });
  }
});

test('import rewrites the source home path inside config.yaml', async () => {
  const home = fakeHome();
  const outFile = path.join(os.tmpdir(), `rw-${Date.now()}.hermesport`);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dst2-'));
  try {
    await portio.exportBundle({ home, outFile, passphrase: 'passphrase123' });
    await portio.importBundle({ file: outFile, passphrase: 'passphrase123', targetHome: target, targetHomeDir: os.homedir() });
    const cfg = fs.readFileSync(path.join(target, 'config.yaml'), 'utf8');
    assert.ok(cfg.includes(`${target}/logs/app.log`), 'source hermes home should be rewritten to target');
    assert.ok(!cfg.includes(`${home}/logs/app.log`), 'old source path should be gone');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(outFile, { force: true });
  }
});

test('wrong passphrase is rejected on inspect and import', async () => {
  const home = fakeHome();
  const outFile = path.join(os.tmpdir(), `wp-${Date.now()}.hermesport`);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dst3-'));
  try {
    await portio.exportBundle({ home, outFile, passphrase: 'the-right-one' });
    assert.throws(() => portio.inspectBundle({ file: outFile, passphrase: 'the-wrong-one' }), /bad passphrase|corrupt/);
    await assert.rejects(
      portio.importBundle({ file: outFile, passphrase: 'the-wrong-one', targetHome: target, targetHomeDir: os.homedir() }),
      /bad passphrase|corrupt/,
    );
    // and the right one still inspects
    const info = portio.inspectBundle({ file: outFile, passphrase: 'the-right-one' });
    assert.strictEqual(info.meta.format, 'hermesport');
    assert.ok(info.meta.entries.length > 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(outFile, { force: true });
  }
});

test('a tampered payload fails authentication', async () => {
  const home = fakeHome();
  const outFile = path.join(os.tmpdir(), `tp-${Date.now()}.hermesport`);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dst4-'));
  try {
    await portio.exportBundle({ home, outFile, passphrase: 'tamper-check-pass' });
    // flip a byte in the middle of the encrypted payload
    const fd = fs.openSync(outFile, 'r+');
    const size = fs.statSync(outFile).size;
    const at = Math.floor(size / 2);
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, at);
    b[0] ^= 0xff;
    fs.writeSync(fd, b, 0, 1, at);
    fs.closeSync(fd);
    await assert.rejects(
      portio.importBundle({ file: outFile, passphrase: 'tamper-check-pass', targetHome: target, targetHomeDir: os.homedir() }),
      /bad passphrase|corrupt/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(outFile, { force: true });
  }
});

test('rewritePaths applies longest match first and leaves unrelated text alone', () => {
  const out = P.rewritePaths('a=/home/old/.hermes/x b=/home/old/y', {
    sourceHermesHome: '/home/old/.hermes', targetHermesHome: '/Users/new/.hermes',
    sourceHome: '/home/old', targetHome: '/Users/new',
  });
  assert.strictEqual(out, 'a=/Users/new/.hermes/x b=/Users/new/y');
});
