'use strict';
/**
 * Pure logic for the Hermes Setup Wizard: paths, .env handling,
 * provider catalog, validation and command builders.
 * No Electron imports — unit-testable with plain Node.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Hermes home: ~/.hermes on macOS/Linux, %LOCALAPPDATA%\hermes on Windows.
 *  HERMES_SETUP_HOME overrides (used by tests / mock mode). */
function hermesHome() {
  if (process.env.HERMES_SETUP_HOME) return process.env.HERMES_SETUP_HOME;
  if (IS_WIN) {
    const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(lad, 'hermes');
  }
  return path.join(os.homedir(), '.hermes');
}

/** Candidate locations of the `hermes` CLI launcher. */
function hermesBinCandidates() {
  const home = os.homedir();
  if (IS_WIN) {
    const lad = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(lad, 'hermes', 'bin', 'hermes.exe'),
      path.join(lad, 'hermes', 'bin', 'hermes.cmd'),
      path.join(lad, 'hermes', 'bin', 'hermes.ps1'),
    ];
  }
  return [
    path.join(home, '.local', 'bin', 'hermes'),
    path.join(hermesHome(), 'bin', 'hermes'),
    '/usr/local/bin/hermes',
    '/opt/homebrew/bin/hermes',
  ];
}

/** Resolve the hermes CLI binary, or null if not found. */
function findHermesBin() {
  if (process.env.HERMES_SETUP_BIN) return process.env.HERMES_SETUP_BIN;
  for (const p of hermesBinCandidates()) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  // PATH lookup
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const names = IS_WIN ? ['hermes.exe', 'hermes.cmd', 'hermes.bat'] : ['hermes'];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

/** True when a Hermes install is present (agent checkout or CLI launcher). */
function isInstalled() {
  const home = hermesHome();
  if (fs.existsSync(path.join(home, 'hermes-agent'))) return true;
  return findHermesBin() !== null;
}

// ---------------------------------------------------------------------------
// .env handling (~/.hermes/.env) — preserve unknown lines and comments
// ---------------------------------------------------------------------------

function envPath() {
  return path.join(hermesHome(), '.env');
}

/** Parse KEY=VALUE lines into an object. Quoted values are unquoted. */
function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      v = v.slice(1, -1).replace(/\\(["\\])/g, '$1');
    } else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function quoteEnvValue(value) {
  const v = String(value);
  if (/^[A-Za-z0-9_@:./+-]*$/.test(v)) return v;      // safe bare value
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Return `text` with the given keys set, updating lines in place and
 *  appending missing keys. All other lines are preserved verbatim. */
function upsertEnvText(text, values) {
  const lines = String(text || '').split(/\r?\n/);
  const pending = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && pending.has(m[1])) {
      const k = m[1];
      const v = pending.get(k);
      pending.delete(k);
      return `${k}=${quoteEnvValue(v)}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of pending) out.push(`${k}=${quoteEnvValue(v)}`);
  return out.join('\n') + '\n';
}

function readEnvFile() {
  try { return parseEnv(fs.readFileSync(envPath(), 'utf8')); } catch { return {}; }
}

function writeEnvValues(values) {
  const p = envPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch { /* new file */ }
  const next = upsertEnvText(text, values);
  fs.writeFileSync(p, next, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* windows */ }
  return p;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Same rule the Hermes CLI uses (hermes_cli/setup.py).
const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;

function validateTelegramToken(token) {
  return TELEGRAM_TOKEN_RE.test(String(token || '').trim());
}

// ---------------------------------------------------------------------------
// Provider catalog — mirrors hermes_cli/auth.py PROVIDER_REGISTRY
// ---------------------------------------------------------------------------

/**
 * kind: 'api_key' | 'oauth' | 'local'
 * verify: how the wizard checks the key and lists models
 *   style 'openai'    → GET {base}/models, Authorization: Bearer
 *   style 'anthropic' → GET {base}/v1/models, x-api-key + anthropic-version
 *   style 'gemini'    → GET {base}/models?key=KEY
 *   style 'ollama'    → GET {base}/api/tags (no auth)
 */
const PROVIDERS = [
  {
    id: 'nous', name: 'Nous Portal', kind: 'oauth',
    keyUrl: 'https://portal.nousresearch.com',
    note: 'One subscription for 300+ models plus web search, image gen, TTS and cloud browser. Signs in via browser (OAuth).',
    oauthCommand: 'setup --portal',
    defaultModel: 'Hermes-4-405B',
  },
  {
    id: 'openrouter', name: 'OpenRouter', kind: 'api_key',
    envKey: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/keys',
    verify: { style: 'openai', base: 'https://openrouter.ai/api/v1' },
    note: '200+ models from every major lab with one key.',
    defaultModel: 'nousresearch/hermes-4-405b',
  },
  {
    id: 'openai-api', name: 'OpenAI', kind: 'api_key',
    envKey: 'OPENAI_API_KEY', keyUrl: 'https://platform.openai.com/api-keys',
    verify: { style: 'openai', base: 'https://api.openai.com/v1' },
    defaultModel: 'gpt-4o',
  },
  {
    id: 'anthropic', name: 'Anthropic', kind: 'api_key',
    envKey: 'ANTHROPIC_API_KEY', keyUrl: 'https://console.anthropic.com/settings/keys',
    verify: { style: 'anthropic', base: 'https://api.anthropic.com' },
    defaultModel: 'claude-sonnet-5',
  },
  {
    id: 'gemini', name: 'Google AI Studio', kind: 'api_key',
    envKey: 'GOOGLE_API_KEY', keyUrl: 'https://aistudio.google.com/apikey',
    verify: { style: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta' },
    defaultModel: 'gemini-3-flash-preview',
  },
  {
    id: 'xai', name: 'xAI (Grok)', kind: 'api_key',
    envKey: 'XAI_API_KEY', keyUrl: 'https://console.x.ai',
    verify: { style: 'openai', base: 'https://api.x.ai/v1' },
    defaultModel: 'grok-4',
  },
  {
    id: 'deepseek', name: 'DeepSeek', kind: 'api_key',
    envKey: 'DEEPSEEK_API_KEY', keyUrl: 'https://platform.deepseek.com/api_keys',
    verify: { style: 'openai', base: 'https://api.deepseek.com/v1' },
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'nvidia', name: 'NVIDIA NIM', kind: 'api_key',
    envKey: 'NVIDIA_API_KEY', keyUrl: 'https://build.nvidia.com',
    verify: { style: 'openai', base: 'https://integrate.api.nvidia.com/v1' },
    defaultModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
  },
  {
    id: 'huggingface', name: 'Hugging Face', kind: 'api_key',
    envKey: 'HF_TOKEN', keyUrl: 'https://huggingface.co/settings/tokens',
    verify: { style: 'openai', base: 'https://router.huggingface.co/v1' },
    defaultModel: 'Qwen/Qwen3.5-397B-A17B',
  },
  {
    id: 'zai', name: 'Z.AI / GLM', kind: 'api_key',
    envKey: 'GLM_API_KEY', keyUrl: 'https://z.ai/model-api',
    verify: { style: 'openai', base: 'https://api.z.ai/api/paas/v4' },
    defaultModel: 'glm-5',
  },
  {
    id: 'kimi-coding', name: 'Kimi / Moonshot', kind: 'api_key',
    envKey: 'KIMI_API_KEY', keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    verify: { style: 'openai', base: 'https://api.moonshot.ai/v1' },
    defaultModel: 'kimi-k2.5',
  },
  {
    id: 'minimax', name: 'MiniMax', kind: 'api_key',
    envKey: 'MINIMAX_API_KEY', keyUrl: 'https://www.minimax.io/platform',
    verify: null, // Anthropic-style gateway; no public /models listing
    defaultModel: 'MiniMax-M2.7',
  },
  {
    id: 'ollama', name: 'Ollama (local)', kind: 'local',
    configProvider: 'custom',
    baseUrl: 'http://localhost:11434/v1', apiKeyValue: 'ollama',
    verify: { style: 'ollama', base: 'http://localhost:11434' },
    note: 'Free, private, runs on this machine. Requires the Ollama app with at least one pulled model.',
    defaultModel: 'hermes3',
  },
  {
    id: 'lmstudio', name: 'LM Studio (local)', kind: 'local',
    configProvider: 'lmstudio',
    baseUrl: 'http://localhost:1234/v1', apiKeyValue: 'lm-studio',
    envBaseKey: 'LM_BASE_URL',
    verify: { style: 'openai', base: 'http://localhost:1234/v1' },
    note: 'Free, private, runs on this machine. Requires LM Studio with its local server enabled.',
    defaultModel: '',
  },
  {
    id: 'custom', name: 'Custom endpoint', kind: 'local',
    configProvider: 'custom',
    baseUrl: '', apiKeyValue: '',
    verify: { style: 'openai', base: '' },
    note: 'Any OpenAI-compatible endpoint (vLLM, llama.cpp, a company gateway, …).',
    defaultModel: '',
  },
];

function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

/**
 * Turn a resolved hermes launcher path + args into a spawn-safe
 * (cmd, args, options) tuple. On Windows, node's child_process.spawn cannot
 * execute a .cmd/.bat directly (throws EINVAL) and cannot run a .ps1 at all,
 * so those are wrapped. .exe and POSIX launchers spawn as-is.
 */
function launcherSpawn(bin, args = []) {
  if (IS_WIN && /\.ps1$/i.test(bin)) {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, ...args],
      options: {},
    };
  }
  if (IS_WIN && /\.(cmd|bat)$/i.test(bin)) {
    // shell:true lets cmd.exe resolve the batch launcher; node quotes args.
    return { cmd: bin, args, options: { shell: true } };
  }
  return { cmd: bin, args, options: {} };
}

/** The official NousResearch installer, per platform. */
function installCommand() {
  if (IS_WIN) {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        'iex (irm https://hermes-agent.nousresearch.com/install.ps1)'],
      shellLine: 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)',
    };
  }
  return {
    cmd: '/bin/bash',
    args: ['-lc', 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash'],
    shellLine: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
  };
}

/** Build the `hermes config set` calls for a chosen default provider/model.
 *  opts.baseUrl / opts.apiKey override the catalog values (custom endpoints). */
function modelConfigCommands(provider, model, opts = {}) {
  const p = typeof provider === 'string' ? getProvider(provider) : provider;
  if (!p) throw new Error(`unknown provider: ${provider}`);
  const providerId = p.configProvider || p.id;
  const cmds = [['config', 'set', 'model.provider', providerId]];
  if (model) cmds.push(['config', 'set', 'model.default', model]);
  if (p.kind === 'local') {
    const baseUrl = opts.baseUrl || p.baseUrl;
    const apiKey = opts.apiKey || p.apiKeyValue;
    if (baseUrl) cmds.push(['config', 'set', 'model.base_url', baseUrl]);
    if (apiKey) cmds.push(['config', 'set', 'model.api_key', apiKey]);
  }
  return cmds;
}

module.exports = {
  IS_WIN,
  PROVIDERS,
  getProvider,
  hermesHome,
  hermesBinCandidates,
  findHermesBin,
  launcherSpawn,
  isInstalled,
  envPath,
  parseEnv,
  quoteEnvValue,
  upsertEnvText,
  readEnvFile,
  writeEnvValues,
  validateTelegramToken,
  installCommand,
  modelConfigCommands,
};
