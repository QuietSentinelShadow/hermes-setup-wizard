'use strict';
/* Hermes Setup Wizard — renderer. Talks to main via window.wizard (preload). */

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'install', label: 'Install Hermes' },
  { id: 'models', label: 'Models & providers' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'finish', label: 'Finish' },
];

const state = {
  mode: 'wizard',        // 'wizard' | 'migrate'
  step: 0,
  sys: null,
  portFile: null,        // chosen bundle path (import)
  portMeta: null,        // decrypted bundle metadata (import)
  providers: [],
  installDone: false,
  installRunning: false,
  verified: {},          // providerId -> { key, baseUrl, models[] }
  savedKeys: {},         // providerId -> key (persisted to .env)
  defaultProvider: null,
  defaultModel: null,
  modelsSaved: false,
  telegram: null,        // { username }
  whatsappEnabled: false,
  whatsappPaired: false,
  skipped: new Set(),
};

const $ = (sel, el = document) => el.querySelector(sel);
const panel = $('#panel');
const nav = $('#steps-nav');
const btnBack = $('#btn-back');
const btnNext = $('#btn-next');
const btnSkip = $('#btn-skip');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- log routing ---------- */
const termFor = (procId) => document.getElementById(`term-${procId}`);
window.wizard.onLog(({ procId, line }) => {
  const t = termFor(procId);
  if (!t) return;
  t.textContent += line;
  t.scrollTop = t.scrollHeight;
});
window.wizard.onExit(({ procId, code }) => {
  const t = termFor(procId);
  if (t) {
    t.textContent += code === 0 ? '\n— finished —\n' : `\n— exited with code ${code} —\n`;
    t.scrollTop = t.scrollHeight;
  }
  if (procId === 'install') {
    state.installRunning = false;
    if (code === 0) {
      state.installDone = true;
      setStatus('install-status', 'Hermes installed successfully.', 'ok');
    } else {
      setStatus('install-status', 'Installer exited with an error — see the log above.', 'err');
    }
    refreshChrome();
    const b = $('#btn-run-install');
    if (b) { b.disabled = false; b.textContent = code === 0 ? 'Run installer again' : 'Retry install'; }
  }
  if (procId === 'whatsapp' && code === 0) {
    state.whatsappPaired = true;
    refreshChrome();
  }
});

function setStatus(id, msg, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = `status ${cls || ''}`;
}

/* ---------- chrome (sidebar + footer) ---------- */
function refreshChrome() {
  nav.innerHTML = STEPS.map((s, i) => {
    const cls = i === state.step ? 'active' : (i < state.step ? 'done' : '');
    const mark = i < state.step ? '✓' : String(i + 1);
    return `<div class="step-item ${cls}" data-step="${s.id}"><span class="dot">${mark}</span>${s.label}</div>`;
  }).join('');

  const id = STEPS[state.step].id;
  btnBack.style.visibility = state.step === 0 ? 'hidden' : 'visible';
  btnSkip.style.display = ['models', 'telegram', 'whatsapp'].includes(id) ? '' : 'none';
  btnNext.textContent = id === 'finish' ? 'Done' : 'Next';

  let nextOk = true;
  if (id === 'install') nextOk = state.installDone || (state.sys && state.sys.installed);
  // A machine that already has a provider key on file (or a prior Hermes
  // install) has a working model config — don't force a re-save to continue.
  const modelsAlready = state.sys && (state.sys.existing.providerKeys.length > 0 || state.sys.installed);
  if (id === 'models') nextOk = state.modelsSaved || modelsAlready;
  if (id === 'telegram') nextOk = Boolean(state.telegram) || Boolean(state.sys?.existing.telegram);
  if (id === 'whatsapp') nextOk = state.whatsappEnabled;
  btnNext.disabled = !nextOk && id !== 'welcome' && id !== 'finish';

  if (state.sys) {
    $('#sys-badge').innerHTML =
      `${esc(state.sys.platform === 'darwin' ? 'macOS' : state.sys.platform === 'win32' ? 'Windows' : state.sys.platform)} · ${esc(state.sys.arch)}` +
      `<br>Hermes: ${state.sys.installed || state.installDone ? (state.installDone ? 'installed ✓' : 'detected ✓') : 'not installed'}` +
      (state.sys.mock ? '<br><b>MOCK MODE</b>' : '');
  }
}

btnBack.addEventListener('click', () => { if (state.step > 0) go(state.step - 1); });
btnSkip.addEventListener('click', () => {
  state.skipped.add(STEPS[state.step].id);
  go(state.step + 1);
});
btnNext.addEventListener('click', () => {
  if (STEPS[state.step].id === 'finish') { window.close(); return; }
  go(state.step + 1);
});

function go(i) {
  state.step = Math.max(0, Math.min(STEPS.length - 1, i));
  render();
}

/* ---------- step renderers ---------- */
const footer = $('#footer');
function render() {
  if (state.mode === 'migrate') {
    footer.style.display = 'none';
    panel.innerHTML = '';
    renderMigrate();
    return;
  }
  footer.style.display = '';
  const id = STEPS[state.step].id;
  const fn = {
    welcome: renderWelcome, install: renderInstall, models: renderModels,
    telegram: renderTelegram, whatsapp: renderWhatsapp, finish: renderFinish,
  }[id];
  panel.innerHTML = '';
  fn();
  refreshChrome();
}

function enterMigrate() { state.mode = 'migrate'; render(); }
function exitMigrate() { state.mode = 'wizard'; render(); }

/* ----- 1. welcome ----- */
function renderWelcome() {
  const s = state.sys;
  panel.innerHTML = `
    <h1>Welcome ☤</h1>
    <p class="lead">This wizard installs the <b>NousResearch Hermes Agent</b> on this computer and
    connects it to <b>Telegram</b>, <b>WhatsApp</b> and the AI model provider of your choice.
    In about five minutes you'll have your own AI agent you can message from your phone.</p>
    <div class="card">
      <h2 style="margin-top:0">This computer</h2>
      <div class="kv" data-testid="sys-info">
        <span class="k">Operating system</span><span>${s ? esc(s.platform === 'darwin' ? 'macOS' : s.platform === 'win32' ? 'Windows' : s.platform) + ' (' + esc(s.arch) + ')' : '…'}</span>
        <span class="k">Hermes install</span><span>${s ? (s.installed ? `already installed ${s.version ? '— ' + esc(s.version) : ''} <span class="badge ok">FOUND</span>` : 'not installed yet') : '…'}</span>
        <span class="k">Install location</span><span><code>${s ? esc(s.home) : '…'}</code></span>
        ${s && s.existing.providerKeys.length ? `<span class="k">Existing provider keys</span><span>${esc(s.existing.providerKeys.join(', '))}</span>` : ''}
        ${s && s.existing.telegram ? '<span class="k">Telegram</span><span>already configured <span class="badge ok">SET</span></span>' : ''}
        ${s && s.existing.whatsapp ? '<span class="k">WhatsApp</span><span>already enabled <span class="badge ok">SET</span></span>' : ''}
      </div>
    </div>
    <p class="lead" style="margin-top:8px">You will need: an internet connection, and (optionally) a
    Telegram account and/or WhatsApp on your phone. Everything can be changed later with
    <code>hermes setup</code>.</p>
    <div class="card" style="border-color:var(--gold-dim)">
      <h2 style="margin-top:0">Already have Hermes on another machine?</h2>
      <p style="margin-bottom:12px">Move a complete agent — its config, secret keys, memories and
      pairings — between computers as one encrypted file.</p>
      <button class="btn" id="btn-migrate" data-testid="btn-migrate">Migrate / clone an agent →</button>
    </div>`;
  $('#btn-migrate').addEventListener('click', enterMigrate);
}

/* ----- migration (export / import a whole instance) ----- */
function fmtBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

const CATEGORY_LABEL = {
  secrets: 'Secret keys & tokens', config: 'Configuration', identity: 'Identity (SOUL)',
  memory: 'Memories', sessions: 'Chat history', cron: 'Scheduled jobs',
  skills: 'Skills', pairing: 'Device pairings', shared: 'Shared files', other: 'Other data',
};

function renderMigrate() {
  const tab = state.migrateTab || 'export';
  panel.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:center">
      <h1 style="margin:0">Migrate an agent</h1>
      <button class="btn ghost small" id="btn-migrate-back" data-testid="btn-migrate-back">← Back to setup</button>
    </div>
    <p class="lead">Move a complete Hermes instance between machines. The bundle is a single
    <code>.hermesport</code> file, encrypted with a passphrase you choose — it holds everything that
    makes this agent <i>itself</i>, and leaves out the reinstallable program files.</p>
    <div class="choice-row" style="margin-top:0">
      <div class="choice ${tab === 'export' ? '' : ''}" id="tab-export" data-testid="tab-export"
           style="${tab === 'export' ? 'border-color:var(--gold)' : ''}">
        <div class="t">⬆ Export from this machine</div>
        <div class="d">Package this agent into an encrypted file to carry to another computer.</div>
      </div>
      <div class="choice" id="tab-import" data-testid="tab-import"
           style="${tab === 'import' ? 'border-color:var(--gold)' : ''}">
        <div class="t">⬇ Import to this machine</div>
        <div class="d">Restore an agent from a <code>.hermesport</code> file made on another computer.</div>
      </div>
    </div>
    <div id="migrate-body"></div>`;
  $('#btn-migrate-back').addEventListener('click', exitMigrate);
  $('#tab-export').addEventListener('click', () => { state.migrateTab = 'export'; render(); });
  $('#tab-import').addEventListener('click', () => { state.migrateTab = 'import'; render(); });
  if (tab === 'export') renderExport(); else renderImport();
}

async function renderExport() {
  const body = $('#migrate-body');
  body.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">What will be included</h2>
      <div id="export-plan" class="status busy">Scanning ~/.hermes…</div>
    </div>
    <div class="card">
      <label class="field">Encryption passphrase (remember it — it can't be recovered)</label>
      <input type="password" id="exp-pass" data-testid="exp-pass" placeholder="at least 8 characters">
      <label class="field">Confirm passphrase</label>
      <input type="password" id="exp-pass2" data-testid="exp-pass2" placeholder="type it again">
      <label style="display:flex;align-items:center;gap:8px;margin-top:12px;color:var(--muted);font-size:13.5px">
        <input type="checkbox" id="exp-sessions" data-testid="exp-sessions" checked style="width:auto"> Include full chat/session history
      </label>
      <div class="row" style="margin-top:14px">
        <button class="btn primary" id="btn-do-export" data-testid="btn-do-export">Export encrypted bundle…</button>
        <div class="status" id="export-status" style="margin-top:0"></div>
      </div>
    </div>`;

  async function loadPlan() {
    const includeSessions = $('#exp-sessions').checked;
    const plan = await window.wizard.portPlan({ includeSessions });
    const el = $('#export-plan');
    if (!plan.ok) { el.textContent = `✖ ${plan.error}`; el.className = 'status err'; return; }
    const byCat = {};
    for (const e of plan.entries) byCat[e.category] = (byCat[e.category] || 0) + e.bytes;
    const rows = Object.entries(byCat).map(([c, b]) =>
      `<li><span class="ok">✓</span>${esc(CATEGORY_LABEL[c] || c)} — ${fmtBytes(b)}</li>`).join('');
    el.className = '';
    el.innerHTML = `<ul class="summary-list">${rows}</ul>
      <p style="color:var(--muted);font-size:13px;margin-top:8px">Total: ${fmtBytes(plan.totalBytes)} across ${plan.fileCount} files.
      Left out: program files and caches (reinstalled on the other machine).</p>`;
  }
  $('#exp-sessions').addEventListener('change', loadPlan);
  await loadPlan();

  $('#btn-do-export').addEventListener('click', async () => {
    const btn = $('#btn-do-export');
    const p1 = $('#exp-pass').value, p2 = $('#exp-pass2').value;
    if (p1.length < 8) { setStatus('export-status', 'Passphrase must be at least 8 characters.', 'err'); return; }
    if (p1 !== p2) { setStatus('export-status', 'Passphrases do not match.', 'err'); return; }
    btn.disabled = true;
    setStatus('export-status', 'Encrypting & writing bundle…', 'busy');
    try {
      const res = await window.wizard.portExport({ passphrase: p1, includeSessions: $('#exp-sessions').checked });
      if (res.canceled) { setStatus('export-status', 'Cancelled.', ''); return; }
      if (!res.ok) { setStatus('export-status', `✖ ${res.error}`, 'err'); return; }
      setStatus('export-status', `✓ Saved ${fmtBytes(res.bytesWritten)} → ${res.outFile}`, 'ok');
    } finally {
      btn.disabled = false;
    }
  });
}

function renderImport() {
  const body = $('#migrate-body');
  body.innerHTML = `
    <div class="card">
      <div class="row">
        <button class="btn" id="btn-pick" data-testid="btn-pick">Choose .hermesport file…</button>
        <div class="status" id="pick-status" style="margin-top:0">${state.portFile ? '✓ ' + esc(state.portFile) : 'No file chosen'}</div>
      </div>
      <label class="field">Passphrase</label>
      <div class="row">
        <input type="password" id="imp-pass" data-testid="imp-pass" placeholder="the passphrase used when exporting">
        <button class="btn small" id="btn-unlock" data-testid="btn-unlock">Unlock &amp; preview</button>
      </div>
      <div class="status" id="unlock-status"></div>
    </div>
    <div id="import-detail"></div>`;

  $('#btn-pick').addEventListener('click', async () => {
    const r = await window.wizard.portPickFile();
    if (r.canceled || !r.ok || !r.filePath) return;
    state.portFile = r.filePath;
    state.portMeta = null;
    setStatus('pick-status', `✓ ${r.filePath}`, 'ok');
  });

  $('#btn-unlock').addEventListener('click', async () => {
    if (!state.portFile) { setStatus('unlock-status', 'Choose a file first.', 'err'); return; }
    const pass = $('#imp-pass').value;
    setStatus('unlock-status', 'Decrypting metadata…', 'busy');
    const r = await window.wizard.portInspect({ file: state.portFile, passphrase: pass });
    if (!r.ok) { setStatus('unlock-status', `✖ ${r.error}`, 'err'); return; }
    state.portMeta = r.meta;
    state.portPass = pass;
    setStatus('unlock-status', '✓ Unlocked.', 'ok');
    showImportDetail(r.meta);
  });

  if (state.portMeta) showImportDetail(state.portMeta);
}

function showImportDetail(meta) {
  const el = $('#import-detail');
  const cross = meta.sourcePlatform && meta.sourcePlatform !== state.sys.platform;
  const plat = (p) => (p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : p);
  const rows = (meta.entries || []).map((e) =>
    `<li><span class="ok">✓</span>${esc(CATEGORY_LABEL[e.category] || e.category)} — ${fmtBytes(e.bytes)}</li>`).join('');
  el.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">This bundle</h2>
      <div class="kv">
        <span class="k">Created</span><span>${esc((meta.createdAt || '').replace('T', ' ').slice(0, 16) || 'unknown')}</span>
        <span class="k">From</span><span>${esc(plat(meta.sourcePlatform))} · Hermes ${esc(meta.hermesVersion || '?')}</span>
        <span class="k">Contents</span><span>${fmtBytes(meta.totalBytes)}, ${meta.fileCount} files</span>
      </div>
      <ul class="summary-list" style="margin-top:10px">${rows}</ul>
      ${cross ? `<p class="status err" style="margin-top:8px">⚠ This bundle came from ${esc(plat(meta.sourcePlatform))} and you're on
        ${esc(plat(state.sys.platform))}. Secrets and memories will transfer, but some machine-specific paths and the
        WhatsApp pairing may need redoing.</p>` : ''}
      <label style="display:flex;align-items:center;gap:8px;margin-top:12px;color:var(--muted);font-size:13.5px">
        <input type="checkbox" id="imp-rewrite" data-testid="imp-rewrite" checked style="width:auto">
        Adjust file paths inside the config for this machine (recommended)
      </label>
      <p style="color:var(--muted);font-size:13px;margin-top:10px">Restoring merges into this machine's
      <code>~/.hermes</code> and overwrites matching files; your current <code>config.yaml</code>,
      <code>.env</code>, <code>auth.json</code> and <code>SOUL.md</code> are backed up first.</p>
      <div class="row" style="margin-top:6px">
        <button class="btn primary" id="btn-do-import" data-testid="btn-do-import">Restore to this machine</button>
        <div class="status" id="import-status" style="margin-top:0"></div>
      </div>
    </div>`;

  $('#btn-do-import').addEventListener('click', async () => {
    const btn = $('#btn-do-import');
    btn.disabled = true;
    setStatus('import-status', 'Restoring…', 'busy');
    try {
      const r = await window.wizard.portImport({
        file: state.portFile, passphrase: state.portPass, rewrite: $('#imp-rewrite').checked,
      });
      if (!r.ok) { setStatus('import-status', `✖ ${r.error}`, 'err'); return; }
      const parts = [`✓ Restored ${r.restoredEntries.length} items`];
      if (r.rewritten.length) parts.push(`paths adjusted in ${r.rewritten.join(', ')}`);
      if (r.backedUp) parts.push(`previous config backed up`);
      setStatus('import-status', parts.join(' · '), 'ok');
    } finally {
      btn.disabled = false;
    }
  });
}

/* ----- 2. install ----- */
function renderInstall() {
  const already = state.sys && state.sys.installed;
  panel.innerHTML = `
    <h1>Install Hermes Agent</h1>
    <p class="lead">${already
      ? 'Hermes is already installed on this computer. You can run the official installer again to update it, or just press <b>Next</b>.'
      : 'This runs the official NousResearch installer. It sets up Python, Node.js and the Hermes Agent in your user folder — no administrator rights needed.'}</p>
    <div class="row" style="margin-bottom:12px">
      <button class="btn primary" id="btn-run-install" data-testid="btn-run-install">
        ${already ? 'Reinstall / update Hermes' : 'Install Hermes now'}
      </button>
      <div class="status" id="install-status" style="margin-top:0"></div>
    </div>
    <div class="term" id="term-install" data-testid="term-install"></div>`;

  $('#btn-run-install').addEventListener('click', async () => {
    const b = $('#btn-run-install');
    b.disabled = true;
    state.installRunning = true;
    setStatus('install-status', 'Installing… this can take a few minutes.', 'busy');
    termFor('install').textContent = '';
    await window.wizard.runInstall();
  });
}

/* ----- 3. models ----- */
function renderModels() {
  const cards = state.providers.map((p) => {
    const v = state.verified[p.id];
    const badge = v ? `<span class="badge ok">VERIFIED · ${v.models.length || '?'} models</span>`
      : (state.sys?.existing.providerKeys.includes(p.id) ? '<span class="badge ok">KEY ON FILE</span>' : '');
    let body = '';
    if (p.kind === 'oauth') {
      body = `
        <div class="note">${esc(p.note || '')}</div>
        <p style="font-size:13.5px">Nous Portal signs in through your browser. Finish this wizard first,
        then run <code>hermes setup --portal</code> in a terminal — or click below to open one now.</p>
        <button class="btn small" data-act="portal" style="margin-top:8px">Open terminal with hermes setup --portal</button>`;
    } else {
      const needsBase = p.id === 'custom';
      const showKey = p.kind === 'api_key' || p.id === 'custom';
      body = `
        ${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}
        ${p.keyUrl ? `<div class="note">Get a key: <a data-url="${esc(p.keyUrl)}">${esc(p.keyUrl)}</a></div>` : ''}
        ${needsBase ? '<label class="field">Base URL (OpenAI-compatible)</label><input type="text" data-base placeholder="http://localhost:8080/v1">' : ''}
        ${showKey ? `<label class="field">API key${p.id === 'custom' ? ' (optional)' : ''}</label>` : ''}
        <div class="row">
          ${showKey ? `<input type="password" data-key placeholder="${esc(p.envKey || 'API key')}" data-testid="key-${p.id}">` : ''}
          <button class="btn small" data-act="verify" data-testid="verify-${p.id}">${p.kind === 'local' ? 'Detect' : 'Verify key'}</button>
        </div>
        <div class="status" data-status></div>
        <div class="model-pick" data-models style="display:none">
          <label class="field">Model</label>
          <select data-model></select>
        </div>`;
    }
    return `
      <div class="provider" data-provider="${p.id}">
        <div class="provider-head"><span class="name">${esc(p.name)}</span>${badge}<span class="chev">▾</span></div>
        <div class="provider-body">${body}</div>
      </div>`;
  }).join('');

  panel.innerHTML = `
    <h1>Models &amp; providers</h1>
    <p class="lead">Hermes can use <b>any</b> of these model providers — add keys for as many as you like
    (all of them become available to the agent), then pick which one it should use by default.
    Free local options (Ollama / LM Studio) work too.</p>
    ${cards}
    <div class="default-box" id="default-box" style="display:none">
      <h2 style="margin-top:0">Default model</h2>
      <div class="row">
        <select id="default-provider" style="max-width:260px"></select>
        <select id="default-model" data-testid="default-model"></select>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="btn-save-models" data-testid="btn-save-models">Save configuration</button>
        <div class="status" id="models-status" style="margin-top:0"></div>
      </div>
    </div>`;

  panel.querySelectorAll('.provider-head').forEach((h) => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('open'));
  });
  panel.querySelectorAll('a[data-url]').forEach((a) => {
    a.addEventListener('click', (e) => { e.stopPropagation(); window.wizard.openExternal(a.dataset.url); });
  });
  panel.querySelectorAll('[data-act="portal"]').forEach((b) => {
    b.addEventListener('click', () => window.wizard.openTerminal('setup --portal'));
  });
  panel.querySelectorAll('[data-act="verify"]').forEach((b) => {
    b.addEventListener('click', () => verifyProvider(b.closest('.provider')));
  });

  refreshDefaultBox();
}

async function verifyProvider(card) {
  const pid = card.dataset.provider;
  const p = state.providers.find((x) => x.id === pid);
  const key = card.querySelector('[data-key]')?.value?.trim() || '';
  const baseUrl = card.querySelector('[data-base]')?.value?.trim() || '';
  const status = card.querySelector('[data-status]');
  if (p.kind === 'api_key' && !key) { status.textContent = 'Enter an API key first.'; status.className = 'status err'; return; }
  if (p.id === 'custom' && !baseUrl) { status.textContent = 'Enter the base URL first.'; status.className = 'status err'; return; }
  status.textContent = 'Checking…'; status.className = 'status busy';
  const res = await window.wizard.verifyProvider({ providerId: pid, apiKey: key, baseUrl });
  if (!res.ok) {
    status.textContent = `✖ ${res.error}`;
    status.className = 'status err';
    return;
  }
  state.verified[pid] = { key, baseUrl, models: res.models || [] };
  if (key) state.savedKeys[pid] = key;
  status.textContent = res.unverified
    ? '✓ Key stored (this provider has no public model list to check against).'
    : `✓ Working — ${res.models.length} models available.`;
  status.className = 'status ok';
  const pickWrap = card.querySelector('[data-models]');
  if (pickWrap && res.models?.length) {
    const sel = pickWrap.querySelector('[data-model]');
    sel.innerHTML = res.models.map((m) => `<option ${m === p.defaultModel ? 'selected' : ''}>${esc(m)}</option>`).join('');
    pickWrap.style.display = '';
  }
  refreshDefaultBox();
}

function refreshDefaultBox() {
  const ids = Object.keys(state.verified);
  const box = $('#default-box');
  if (!box) return;
  if (!ids.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  const provSel = $('#default-provider');
  const prevProv = state.defaultProvider && ids.includes(state.defaultProvider) ? state.defaultProvider : ids[0];
  provSel.innerHTML = ids.map((id) => {
    const p = state.providers.find((x) => x.id === id);
    return `<option value="${id}" ${id === prevProv ? 'selected' : ''}>${esc(p.name)}</option>`;
  }).join('');
  const fillModels = () => {
    const pid = provSel.value;
    const p = state.providers.find((x) => x.id === pid);
    const models = state.verified[pid].models;
    const modelSel = $('#default-model');
    modelSel.innerHTML = (models.length ? models : [p.defaultModel || '']).map((m) =>
      `<option ${m === p.defaultModel ? 'selected' : ''}>${esc(m)}</option>`).join('');
  };
  provSel.onchange = fillModels;
  fillModels();

  $('#btn-save-models').onclick = async () => {
    const pid = provSel.value;
    const model = $('#default-model').value;
    setStatus('models-status', 'Saving…', 'busy');
    const v = state.verified[pid] || {};
    const res = await window.wizard.saveModels({
      keys: state.savedKeys, defaultProviderId: pid, defaultModel: model,
      defaultBaseUrl: v.baseUrl || undefined, defaultApiKey: v.key || undefined,
    });
    if (res.ok) {
      state.defaultProvider = pid;
      state.defaultModel = model;
      state.modelsSaved = true;
      setStatus('models-status', `✓ Saved — default is ${model}`, 'ok');
      refreshChrome();
    } else {
      setStatus('models-status', `✖ ${res.error}`, 'err');
    }
  };
}

/* ----- 4. telegram ----- */
function renderTelegram() {
  panel.innerHTML = `
    <h1>Telegram</h1>
    <p class="lead">Telegram is the easiest way to talk to your agent from your phone.
    You create your own private bot (takes ~1 minute), then paste its token here.</p>
    <div class="card">
      <h2 style="margin-top:0">Create your bot</h2>
      <ol class="instructions">
        <li>Open Telegram and message <a data-url="https://t.me/BotFather">@BotFather</a>.</li>
        <li>Send <code>/newbot</code> and follow the prompts (pick any name and username).</li>
        <li>BotFather replies with a token like <code>123456789:AAF…</code> — copy it.</li>
      </ol>
      <label class="field">Bot token</label>
      <div class="row">
        <input type="password" id="tg-token" data-testid="tg-token" placeholder="123456789:AAF…" />
        <button class="btn primary small" id="btn-tg-save" data-testid="btn-tg-save">Verify &amp; save</button>
      </div>
      <div class="status" id="tg-status" data-testid="tg-status"></div>
    </div>
    ${state.sys?.existing.telegram ? '<p class="lead">A Telegram token is already configured — saving a new one replaces it, or just press <b>Next</b>.</p>' : ''}`;

  if (state.sys?.existing.telegram && !state.telegram) {
    state.telegram = { username: '(already configured)' };
  }

  panel.querySelectorAll('a[data-url]').forEach((a) => {
    a.addEventListener('click', () => window.wizard.openExternal(a.dataset.url));
  });
  $('#btn-tg-save').addEventListener('click', async () => {
    const btn = $('#btn-tg-save');
    if (btn.disabled) return;
    const token = $('#tg-token').value;
    btn.disabled = true;
    setStatus('tg-status', 'Checking with Telegram…', 'busy');
    try {
      const v = await window.wizard.verifyTelegram(token);
      // A confirmed-bad token (rejected or wrong format) blocks saving.
      if (!v.ok && v.rejected !== false && !v.unreachable) {
        setStatus('tg-status', `✖ ${v.error}`, 'err');
        return;
      }
      const s = await window.wizard.saveTelegram(token);
      if (!s.ok) { setStatus('tg-status', `✖ ${s.error}`, 'err'); return; }
      if (v.ok) {
        state.telegram = v.bot;
        setStatus('tg-status', `✓ Connected to @${v.bot.username} and saved.`, 'ok');
      } else {
        // valid format, couldn't reach Telegram to confirm — saved regardless
        state.telegram = { username: '(saved, not yet confirmed)' };
        setStatus('tg-status', `✓ Token saved. ${v.error} It'll be used once you're online.`, 'ok');
      }
      refreshChrome();
    } finally {
      btn.disabled = false;
    }
  });
  refreshChrome();
}

/* ----- 5. whatsapp ----- */
function renderWhatsapp() {
  panel.innerHTML = `
    <h1>WhatsApp</h1>
    <p class="lead">Hermes links to WhatsApp the same way WhatsApp Web does: it shows a QR code,
    and you scan it from your phone (<b>WhatsApp → Settings → Linked devices → Link a device</b>).</p>
    <div class="row" style="margin-bottom:12px">
      <button class="btn primary" id="btn-wa-pair" data-testid="btn-wa-pair">Enable WhatsApp &amp; show QR code</button>
      <button class="btn small" id="btn-wa-stop" style="display:none">Stop</button>
      <div class="status" id="wa-status" style="margin-top:0" data-testid="wa-status"></div>
    </div>
    <div class="term qr" id="term-whatsapp" data-testid="term-whatsapp"></div>
    <p class="lead" style="margin-top:12px">If the QR code looks garbled here, you can also pair from a
    normal terminal later with <code>hermes whatsapp</code>.
    ${state.sys?.existing.whatsapp ? '<br>WhatsApp is <b>already enabled</b> on this machine — press Next to keep it.' : ''}</p>`;

  if (state.sys?.existing.whatsapp) state.whatsappEnabled = true;

  $('#btn-wa-pair').addEventListener('click', async () => {
    const btn = $('#btn-wa-pair');
    if (btn.disabled) return;             // guard against a second pairing process
    btn.disabled = true;
    try {
      const en = await window.wizard.enableWhatsapp(true);
      if (!en.ok) { setStatus('wa-status', `✖ ${en.error}`, 'err'); return; }
      state.whatsappEnabled = true;
      refreshChrome();
      setStatus('wa-status', 'Waiting for QR / pairing…', 'busy');
      $('#btn-wa-stop').style.display = '';
      termFor('whatsapp').textContent = '';
      const r = await window.wizard.pairWhatsapp();
      $('#btn-wa-stop').style.display = 'none';
      setStatus('wa-status', r.code === 0 ? '✓ WhatsApp linked.' : 'Pairing ended — you can retry or pair later from a terminal.', r.code === 0 ? 'ok' : 'busy');
    } finally {
      btn.disabled = false;
    }
  });
  $('#btn-wa-stop').addEventListener('click', () => window.wizard.stopProc('whatsapp'));
  refreshChrome();
}

/* ----- 6. finish ----- */
function renderFinish() {
  const items = [
    ['Hermes Agent', state.installDone || state.sys?.installed],
    [`Default model${state.defaultModel ? ' — ' + state.defaultModel : ''}`, state.modelsSaved],
    [`Telegram${state.telegram?.username ? ' — @' + state.telegram.username : ''}`, Boolean(state.telegram)],
    ['WhatsApp', state.whatsappEnabled],
  ];
  panel.innerHTML = `
    <h1>Almost done 🎉</h1>
    <p class="lead">Last step: start the <b>gateway</b> — the background service that listens for your
    Telegram / WhatsApp messages and wakes the agent.</p>
    <div class="card">
      <h2 style="margin-top:0">What you set up</h2>
      <ul class="summary-list" data-testid="summary">
        ${items.map(([label, ok]) => `<li><span class="${ok ? 'ok' : 'skip'}">${ok ? '✓' : '—'}</span>${esc(label)}${ok ? '' : ' (skipped)'}</li>`).join('')}
      </ul>
    </div>
    <div class="choice-row">
      <div class="choice" id="ch-service" data-testid="ch-service">
        <div class="t">Run in the background (recommended)</div>
        <div class="d">Installs the gateway as a system service that starts automatically when you log in.</div>
      </div>
      <div class="choice" id="ch-terminal">
        <div class="t">Run in a terminal window</div>
        <div class="d">Opens a terminal running <code>hermes gateway run</code> — good for a first test, stops when closed.</div>
      </div>
    </div>
    <div class="status" id="gw-status" data-testid="gw-status"></div>
    <div class="term" id="term-gateway" style="height:150px"></div>
    <h2>Health check</h2>
    <div class="row" style="margin-bottom:10px">
      <button class="btn small" id="btn-doctor" data-testid="btn-doctor">Run hermes doctor</button>
    </div>
    <div class="term" id="term-doctor" style="height:150px" data-testid="term-doctor"></div>
    <p class="lead" style="margin-top:14px">That's it — send your bot a message from Telegram or WhatsApp
    and say hi. Useful commands later: <code>hermes</code> (chat in terminal), <code>hermes model</code>
    (switch models), <code>hermes gateway status</code>, <code>hermes doctor</code>.</p>`;

  $('#ch-service').addEventListener('click', async () => {
    setStatus('gw-status', 'Installing gateway service…', 'busy');
    const r = await window.wizard.startGateway('service');
    setStatus('gw-status', r.ok ? '✓ Gateway is running in the background.' : `✖ ${r.error || 'failed — see log'}`, r.ok ? 'ok' : 'err');
  });
  $('#ch-terminal').addEventListener('click', async () => {
    const r = await window.wizard.startGateway('terminal');
    setStatus('gw-status', r.ok ? '✓ Opened a terminal running the gateway.' : `✖ ${r.error || 'could not open a terminal'}`, r.ok ? 'ok' : 'err');
  });
  $('#btn-doctor').addEventListener('click', async () => {
    termFor('doctor').textContent = '';
    await window.wizard.runDoctor();
  });
}

/* ---------- updates & changelog ---------- */
const modal = $('#modal');
function showModal(title, body, actionLabel, onAction) {
  $('#modal-title').textContent = title;
  $('#modal-body').textContent = body;
  const act = $('#modal-action');
  if (actionLabel) {
    act.style.display = '';
    act.textContent = actionLabel;
    act.onclick = onAction;
  } else {
    act.style.display = 'none';
  }
  modal.hidden = false;
}
$('#modal-close').addEventListener('click', () => { modal.hidden = true; });
modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });

$('#lnk-updates').addEventListener('click', async () => {
  showModal('Checking for updates…', '', null);
  const r = await window.wizard.checkUpdates();
  if (!r.ok) {
    showModal('Update check failed',
      `Could not reach the release feed.\n\n${r.error}\n\nYou are on version ${r.current}. ` +
      'You can also ask whoever shared this app with you for the latest installer.', null);
    return;
  }
  if (!r.update) {
    showModal('You are up to date', `Hermes Setup Wizard ${r.current} is the latest version.`, null);
    return;
  }
  const u = r.update;
  showModal(
    `Version ${u.version} is available` + (u.date ? ` (${u.date})` : ''),
    `You have ${r.current}.\n\nWhat's new:\n${u.notes}\n\n` +
    'The download is a normal installer — running it upgrades this app in place. ' +
    'Your Hermes Agent settings are not touched.',
    'Download update',
    () => window.wizard.openExternal(u.asset || u.url),
  );
});

$('#lnk-whatsnew').addEventListener('click', async () => {
  const log = await window.wizard.getChangelog();
  showModal("What's new", log, null);
});

/* ---------- boot ---------- */
(async function boot() {
  state.providers = await window.wizard.providers();
  state.sys = await window.wizard.detect();
  $('#ver-num').textContent = `Hermes Setup Wizard v${state.sys.appVersion || '?'}`;
  render();
})();
