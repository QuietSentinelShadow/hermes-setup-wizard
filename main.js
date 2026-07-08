'use strict';

const { app, BrowserWindow, ipcMain, shell, net, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hermes = require('./lib/hermes');
const updates = require('./lib/updates');
const portability = require('./lib/portability');
const portio = require('./lib/portio');

const MOCK = process.env.HERMES_SETUP_MOCK === '1';

let win = null;
const children = new Map(); // procId -> ChildProcess
let lastMockExport = null;   // remembers the export path so mock pickFile can find it

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 860,
    minHeight: 600,
    title: 'Hermes Setup Wizard',
    backgroundColor: '#101418',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu?.();

  // Harden against navigation away from the bundled UI. A dropped file or an
  // in-page link must never replace our page (that new page would inherit the
  // privileged preload bridge). External links open in the real browser.
  const APP_URL = new URL('file://' + path.join(__dirname, 'renderer', 'index.html')).href;
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== APP_URL) e.preventDefault();
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  for (const child of children.values()) {
    try { child.kill(); } catch { /* already gone */ }
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\r(?!\n)/g;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Spawn a command, stream cleaned output lines to the renderer. */
function runStreaming(procId, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb', ...opts.env },
        cwd: opts.cwd || os.homedir(),
        windowsHide: true,
        ...(opts.shell ? { shell: opts.shell } : {}),
      });
    } catch (err) {
      send('proc:log', { procId, line: `✖ failed to start: ${err.message}` });
      resolve({ code: -1, error: err.message });
      return;
    }
    children.set(procId, child);
    const onData = (buf) => {
      const text = buf.toString('utf8').replace(ANSI_RE, '');
      if (text) send('proc:log', { procId, line: text });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin?.end?.();
    child.on('error', (err) => {
      children.delete(procId);
      send('proc:log', { procId, line: `✖ ${err.message}` });
      send('proc:exit', { procId, code: -1 });
      resolve({ code: -1, error: err.message });
    });
    child.on('close', (code) => {
      children.delete(procId);
      send('proc:exit', { procId, code });
      resolve({ code });
    });
  });
}

/** Run the hermes CLI once, capture combined output (no streaming). */
function runHermes(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const bin = hermes.findHermesBin();
    if (!bin) { resolve({ code: -1, out: 'hermes CLI not found' }); return; }
    let out = '';
    const s = hermes.launcherSpawn(bin, args);
    const child = spawn(s.cmd, s.args, {
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
      windowsHide: true,
      ...s.options,
    });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.stdin?.end?.();
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: String(err.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.replace(ANSI_RE, '') }); });
  });
}

function fetchJson(url, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    net.fetch(url, { headers, signal: ctrl.signal })
      .then(async (res) => {
        clearTimeout(timer);
        if (!res.ok) {
          reject(new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' — key rejected' : ''}`));
          return;
        }
        resolve(await res.json());
      })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

/** Open the platform terminal running a hermes command (for interactive flows). */
function openInTerminal(hermesArgs) {
  const bin = hermes.findHermesBin() || 'hermes';
  if (process.platform === 'darwin') {
    const cmd = `${bin} ${hermesArgs}`.replace(/"/g, '\\"');
    const script = `tell application "Terminal"
  activate
  do script "${cmd}"
end tell`;
    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', 'powershell.exe', '-NoExit', '-Command', `& '${bin}' ${hermesArgs}`],
      { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// mock implementations (HERMES_SETUP_MOCK=1) — used by e2e tests
// ---------------------------------------------------------------------------

async function mockStream(procId, lines, delayMs = 60) {
  for (const line of lines) {
    await new Promise((r) => setTimeout(r, delayMs));
    send('proc:log', { procId, line: line + '\n' });
  }
  send('proc:exit', { procId, code: 0 });
  return { code: 0 };
}

const MOCK_MODELS = {
  openrouter: ['nousresearch/hermes-4-405b', 'anthropic/claude-sonnet-5', 'openai/gpt-4o'],
  'openai-api': ['gpt-4o', 'gpt-4o-mini', 'o3'],
  ollama: ['hermes3:latest', 'qwen3:32b'],
};

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('sys:detect', async () => {
  const env = hermes.readEnvFile();
  const installed = MOCK ? fs.existsSync(path.join(hermes.hermesHome(), 'hermes-agent')) : hermes.isInstalled();
  let version = null;
  if (installed && !MOCK) {
    const r = await runHermes(['--version'], 15000);
    if (r.code === 0) version = r.out.trim().split('\n')[0];
  } else if (installed && MOCK) {
    version = 'hermes 9.9.9 (mock)';
  }
  return {
    platform: process.platform,
    arch: process.arch,
    osVersion: os.release(),
    appVersion: app.getVersion(),
    home: hermes.hermesHome(),
    installed,
    version,
    hermesBin: MOCK ? '(mock)' : hermes.findHermesBin(),
    mock: MOCK,
    existing: {
      telegram: Boolean(env.TELEGRAM_BOT_TOKEN),
      whatsapp: (env.WHATSAPP_ENABLED || '').toLowerCase() === 'true',
      providerKeys: hermes.PROVIDERS.filter((p) => p.envKey && env[p.envKey]).map((p) => p.id),
    },
  };
});

ipcMain.handle('sys:providers', () => hermes.PROVIDERS);

ipcMain.handle('sys:openExternal', (_e, url) => {
  if (/^https:\/\//.test(String(url))) shell.openExternal(url);
});

ipcMain.handle('install:run', async () => {
  if (MOCK) {
    const home = hermes.hermesHome();
    fs.mkdirSync(path.join(home, 'hermes-agent'), { recursive: true });
    return mockStream('install', [
      '⚕ Hermes Agent installer (mock)',
      'Downloading uv… done',
      'Installing Python 3.11… done',
      'Installing hermes-agent… done',
      '✅ Hermes installed. Run: hermes',
    ]);
  }
  const { cmd, args } = hermes.installCommand();
  send('proc:log', { procId: 'install', line: `$ ${hermes.installCommand().shellLine}\n` });
  return runStreaming('install', cmd, args);
});

// Verify a provider key / local endpoint; returns { ok, models[] }
ipcMain.handle('models:verify', async (_e, { providerId, apiKey, baseUrl }) => {
  const p = hermes.getProvider(providerId);
  if (!p) return { ok: false, error: 'unknown provider' };
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 150));
    if (apiKey === 'bad-key') return { ok: false, error: 'HTTP 401 — key rejected' };
    return { ok: true, models: MOCK_MODELS[providerId] || ['mock-model-a', 'mock-model-b'] };
  }
  if (!p.verify) return { ok: true, models: p.defaultModel ? [p.defaultModel] : [], unverified: true };
  const style = p.verify.style;
  const base = (baseUrl || p.verify.base || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'base URL required' };
  try {
    let models = [];
    if (style === 'openai') {
      const j = await fetchJson(`${base}/models`, apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
      models = (j.data || []).map((m) => m.id);
    } else if (style === 'anthropic') {
      const j = await fetchJson(`${base}/v1/models?limit=100`, {
        'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
      });
      models = (j.data || []).map((m) => m.id);
    } else if (style === 'gemini') {
      const j = await fetchJson(`${base}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`);
      models = (j.models || []).map((m) => String(m.name || '').replace(/^models\//, ''));
    } else if (style === 'ollama') {
      const j = await fetchJson(`${base}/api/tags`);
      models = (j.models || []).map((m) => m.name);
    }
    return { ok: true, models: models.sort() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Save provider API keys to ~/.hermes/.env and set the default model.
ipcMain.handle('models:save', async (_e, { keys, defaultProviderId, defaultModel, defaultBaseUrl, defaultApiKey }) => {
  try {
    const values = {};
    for (const [providerId, key] of Object.entries(keys || {})) {
      const p = hermes.getProvider(providerId);
      if (p && p.envKey && key) values[p.envKey] = key;
      if (p && p.envBaseKey && p.baseUrl) values[p.envBaseKey] = p.baseUrl;
    }
    if (Object.keys(values).length) hermes.writeEnvValues(values);

    const results = [];
    if (defaultProviderId) {
      const cmds = hermes.modelConfigCommands(defaultProviderId, defaultModel,
        { baseUrl: defaultBaseUrl, apiKey: defaultApiKey });
      // never surface a raw api_key in logs or error text sent to the renderer
      const secrets = [defaultApiKey, ...Object.values(keys || {})].filter((s) => s && String(s).length >= 6);
      const redact = (s) => {
        let out = String(s == null ? '' : s);
        for (const sec of secrets) out = out.split(sec).join('••••••');
        return out;
      };
      const redactArgs = (args) => args.map((a) => (a.startsWith('model.') ? a : redact(a)));
      for (const args of cmds) {
        if (MOCK) { results.push({ args: redactArgs(args), code: 0 }); continue; }
        const r = await runHermes(args, 90000);
        results.push({ args: redactArgs(args), code: r.code, out: redact(r.out.slice(-400)) });
        if (r.code !== 0) {
          const label = args[2] || args.join(' ');       // e.g. "model.api_key"
          return { ok: false, error: `hermes config set ${label} failed:\n${redact(r.out.slice(-800))}`, results };
        }
      }
    }
    return { ok: true, results, envPath: hermes.envPath() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('telegram:verify', async (_e, token) => {
  const t = String(token || '').trim();
  if (!hermes.validateTelegramToken(t)) {
    return { ok: false, error: 'That does not look like a bot token (expected 123456789:AA…, 30+ chars after the colon).' };
  }
  if (MOCK) return { ok: true, bot: { username: 'mock_bot', name: 'Mock Bot' } };
  try {
    const j = await fetchJson(`https://api.telegram.org/bot${t}/getMe`);
    // A 401/403 comes back through the catch below (fetchJson rejects on !ok);
    // reaching here means Telegram accepted the request.
    if (!j.ok) return { ok: false, rejected: true, error: 'Telegram rejected the token.' };
    return { ok: true, bot: { username: j.result.username, name: j.result.first_name } };
  } catch (err) {
    const rejected = /key rejected|HTTP 40[13]|HTTP 404/.test(err.message);
    return {
      ok: false,
      rejected,
      // format is valid and this was a network problem, not a bad token
      unreachable: !rejected,
      error: rejected ? 'Telegram rejected the token.' : `Could not reach Telegram (${err.message}).`,
    };
  }
});

ipcMain.handle('telegram:save', async (_e, token) => {
  const t = String(token || '').trim();
  if (!hermes.validateTelegramToken(t)) return { ok: false, error: 'invalid token format' };
  try {
    hermes.writeEnvValues({ TELEGRAM_BOT_TOKEN: t });
    return { ok: true, envPath: hermes.envPath() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('whatsapp:enable', async (_e, enabled) => {
  try {
    hermes.writeEnvValues({ WHATSAPP_ENABLED: enabled ? 'true' : 'false' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Start WhatsApp pairing (QR) streamed into the app.
ipcMain.handle('whatsapp:pair', async () => {
  if (MOCK) {
    return mockStream('whatsapp', [
      'Starting WhatsApp pairing…',
      '█▀▀▀▀▀█ ▀▄█ ▄▀ █▀▀▀▀▀█',
      '█ ███ █ ▄▀▀▄▄▀ █ ███ █',
      '█ ▀▀▀ █ █▄ ▀▄  █ ▀▀▀ █',
      'Scan this QR code with WhatsApp → Linked devices.',
      '✅ Paired (mock).',
    ], 100);
  }
  const bin = hermes.findHermesBin();
  if (!bin) {
    send('proc:log', { procId: 'whatsapp', line: 'hermes CLI not found — install Hermes first.\n' });
    send('proc:exit', { procId: 'whatsapp', code: -1 });
    return { code: -1 };
  }
  const s = hermes.launcherSpawn(bin, ['whatsapp']);
  return runStreaming('whatsapp', s.cmd, s.args, s.options);
});

ipcMain.handle('proc:stop', (_e, procId) => {
  const child = children.get(procId);
  if (child) { try { child.kill(); } catch { /* gone */ } }
  return true;
});

ipcMain.handle('finish:doctor', async () => {
  if (MOCK) {
    return mockStream('doctor', ['⚕ hermes doctor (mock)', 'model: ok', 'telegram: ok', 'whatsapp: ok', 'All checks passed.']);
  }
  const bin = hermes.findHermesBin();
  if (!bin) {
    send('proc:log', { procId: 'doctor', line: 'hermes CLI not found — is Hermes installed? Go back to the Install step.\n' });
    send('proc:exit', { procId: 'doctor', code: -1 });
    return { code: -1 };
  }
  const s = hermes.launcherSpawn(bin, ['doctor']);
  return runStreaming('doctor', s.cmd, s.args, s.options);
});

ipcMain.handle('finish:gateway', async (_e, mode) => {
  if (MOCK) {
    if (mode === 'service') {
      const r = await mockStream('gateway', ['Installing gateway service (mock)…', 'Started. ✅']);
      return { ok: r.code === 0 };
    }
    return { ok: true, opened: true };
  }
  const bin = hermes.findHermesBin();
  if (!bin) return { ok: false, error: 'hermes CLI not found' };
  if (mode === 'service') {
    send('proc:log', { procId: 'gateway', line: '$ hermes gateway install\n' });
    const si = hermes.launcherSpawn(bin, ['gateway', 'install']);
    const r1 = await runStreaming('gateway', si.cmd, si.args, si.options);
    if (r1.code !== 0) return { ok: false, error: 'gateway install failed' };
    send('proc:log', { procId: 'gateway', line: '$ hermes gateway start\n' });
    const ss = hermes.launcherSpawn(bin, ['gateway', 'start']);
    const r2 = await runStreaming('gateway', ss.cmd, ss.args, ss.options);
    return { ok: r2.code === 0 };
  }
  const opened = openInTerminal('gateway run');
  return { ok: opened, opened };
});

ipcMain.handle('finish:openTerminal', (_e, argsLine) => {
  const safe = String(argsLine || '').replace(/[^a-zA-Z0-9 ._-]/g, '');
  return openInTerminal(safe);
});

// ---------------------------------------------------------------------------
// updates
// ---------------------------------------------------------------------------

ipcMain.handle('updates:check', async () => {
  const current = app.getVersion();
  if (MOCK) {
    return {
      ok: true, current,
      update: {
        version: '9.9.9', date: '2099-01-01',
        notes: '• Mock feature one\n• Mock fix two',
        url: 'https://example.com/releases',
        asset: 'https://example.com/mock-installer',
      },
    };
  }
  try {
    const json = await fetchJson(updates.feedUrl(), {
      'User-Agent': `hermes-setup-wizard/${current}`,
      Accept: 'application/vnd.github+json',
    });
    return { ok: true, current, update: updates.pickUpdate(json, current, process.platform) };
  } catch (err) {
    return { ok: false, current, error: err.message };
  }
});

ipcMain.handle('updates:changelog', () => {
  try {
    return fs.readFileSync(path.join(app.getAppPath(), 'CHANGELOG.md'), 'utf8');
  } catch {
    return '(changelog not found)';
  }
});

// ---------------------------------------------------------------------------
// port / migrate a whole Hermes instance between machines
// ---------------------------------------------------------------------------

// Preview what an export from this machine would contain.
ipcMain.handle('port:plan', (_e, { includeSessions } = {}) => {
  try {
    const home = hermes.hermesHome();
    const plan = portability.planExport(home, { includeSessions: includeSessions !== false });
    return { ok: true, home, ...plan };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Create the encrypted bundle. In MOCK/test mode an explicit outFile is passed
// so no native save dialog is needed; otherwise we prompt for a destination.
ipcMain.handle('port:export', async (_e, { passphrase, includeSessions, outFile } = {}) => {
  try {
    const home = hermes.hermesHome();
    let dest = outFile;
    if (!dest && MOCK) {
      dest = path.join(os.tmpdir(), `hermes-e2e-export-${process.pid}.hermesport`);
    }
    if (!dest) {
      const stamp = new Date().toISOString().slice(0, 10);
      const r = await dialog.showSaveDialog(win, {
        title: 'Export Hermes agent',
        defaultPath: path.join(os.homedir(), `hermes-agent-${stamp}.hermesport`),
        filters: [{ name: 'Hermes port bundle', extensions: ['hermesport'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      dest = r.filePath;
    }
    const res = await portio.exportBundle({
      home, outFile: dest, passphrase,
      includeSessions: includeSessions !== false,
      extraMeta: {
        createdAt: new Date().toISOString(),
        appVersion: app.getVersion(),
        sourcePlatform: process.platform,
        sourceArch: process.arch,
        sourceHome: os.homedir(),
      },
    });
    lastMockExport = dest;
    return { ok: true, outFile: dest, bytesWritten: res.bytesWritten, entries: res.entries, totalBytes: res.totalBytes };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Pick a bundle file (returns the chosen path).
ipcMain.handle('port:pickFile', async () => {
  if (MOCK) return { ok: true, filePath: lastMockExport || '' };
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a Hermes agent bundle',
    properties: ['openFile'],
    filters: [{ name: 'Hermes port bundle', extensions: ['hermesport'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, filePath: r.filePaths[0] };
});

// Decrypt just the metadata to validate the passphrase and preview contents.
ipcMain.handle('port:inspect', (_e, { file, passphrase } = {}) => {
  try {
    const { meta, fileSize } = portio.inspectBundle({ file, passphrase });
    return { ok: true, meta, fileSize };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Restore a bundle into this machine's Hermes home.
ipcMain.handle('port:import', async (_e, { file, passphrase, rewrite } = {}) => {
  try {
    const targetHome = hermes.hermesHome();
    const res = await portio.importBundle({
      file, passphrase, targetHome, targetHomeDir: os.homedir(),
      rewrite: rewrite !== false,
    });
    return {
      ok: true,
      restoredEntries: res.restoredEntries,
      rewritten: res.rewritten,
      backedUp: res.backedUp,
      backupDir: res.backupDir,
      sourcePlatform: res.meta.sourcePlatform,
      crossPlatform: res.meta.sourcePlatform !== process.platform,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
