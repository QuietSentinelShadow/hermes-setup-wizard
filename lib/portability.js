'use strict';
/**
 * Port a complete Hermes instance between machines.
 *
 * Export: bundle the Hermes *identity* (config, secret keys, OAuth/auth
 * tokens, SOUL, memories, cron, skills, WhatsApp pairing, and optionally
 * session history) into a single passphrase-encrypted `.hermesport` file.
 * Reinstallable binaries and throwaway caches are left out.
 *
 * Import: decrypt on the target box, restore into ~/.hermes, and rewrite
 * machine-specific paths so the moved config points at the new home.
 *
 * File format (`.hermesport`):
 *   magic "HERMESPORT\0" (12) | version (1)
 *   salt (16) | metaIv (12) | metaLen (4, BE) | metaCiphertext | metaTag (16)
 *   dataIv (12) | dataCiphertext … | dataTag (16, trailing)
 * Both sections are AES-256-GCM under a scrypt-derived key. Metadata is a
 * separate small section so the app can validate the passphrase and preview
 * contents without decrypting the (potentially large) data payload.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAGIC = Buffer.from('HERMESPORT\0', 'binary'); // 11 bytes
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// ---------------------------------------------------------------------------
// What travels and what doesn't
// ---------------------------------------------------------------------------

// Top-level entries in ~/.hermes that are reinstalled or purely ephemeral.
const EXCLUDE_NAMES = new Set([
  'bin', 'node', 'hermes-agent', 'hermes-setup',   // reinstalled by the installer
  'logs',                                           // machine-local logs
  'audio_cache', 'image_cache', 'bootstrap-cache', 'cache', // caches
  'models_dev_cache.json', 'ollama_cloud_models_cache.json', 'provider_models_cache.json',
  'desktop-build-stamp.json',                       // install artifact
  'auth.lock', '.update_check', '.update_exit_code', // locks / run state
  '__pycache__', '.DS_Store',
]);

// Human-friendly grouping for the UI. First match wins.
const CATEGORIES = [
  { category: 'secrets', match: (n) => n === '.env' || n === 'auth.json' },
  { category: 'config', match: (n) => n === 'config.yaml' },
  { category: 'identity', match: (n) => n === 'SOUL.md' },
  { category: 'memory', match: (n) => n === 'memories' },
  { category: 'sessions', match: (n) => n === 'sessions' },
  { category: 'cron', match: (n) => n === 'cron' },
  { category: 'skills', match: (n) => n === '.skills_prompt_snapshot.json' || n === 'skills' },
  { category: 'pairing', match: (n) => n === 'pairing' || n === 'whatsapp' },
  { category: 'shared', match: (n) => n === 'shared' },
];

function categoryOf(name) {
  for (const c of CATEGORIES) if (c.match(name)) return c.category;
  return 'other';
}

function isExcluded(name, { includeSessions } = {}) {
  if (EXCLUDE_NAMES.has(name)) return true;
  if (!includeSessions && name === 'sessions') return true;
  if (/(^|[._-])cache([._-]|$)/i.test(name)) return true;   // any *cache* entry
  if (/\.(lock|log|tmp)$/i.test(name)) return true;
  return false;
}

function dirSize(p) {
  let bytes = 0;
  let files = 0;
  const walk = (cur) => {
    let st;
    try { st = fs.lstatSync(cur); } catch { return; }
    if (st.isSymbolicLink()) { files += 1; return; }
    if (st.isDirectory()) {
      let entries = [];
      try { entries = fs.readdirSync(cur); } catch { return; }
      for (const e of entries) walk(path.join(cur, e));
    } else {
      bytes += st.size;
      files += 1;
    }
  };
  walk(p);
  return { bytes, files };
}

/**
 * Scan a Hermes home and decide what would be exported.
 * Returns { entries, excluded, totalBytes, fileCount }.
 */
function planExport(home, { includeSessions = true } = {}) {
  let names = [];
  try { names = fs.readdirSync(home); } catch (err) {
    return { entries: [], excluded: [], totalBytes: 0, fileCount: 0, error: err.message };
  }
  const entries = [];
  const excluded = [];
  let totalBytes = 0;
  let fileCount = 0;
  for (const name of names.sort()) {
    if (isExcluded(name, { includeSessions })) {
      excluded.push({ name, reason: name === 'sessions' ? 'session history excluded' : 'reinstalled or cache/log' });
      continue;
    }
    const full = path.join(home, name);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    const kind = st.isDirectory() ? 'dir' : 'file';
    const { bytes, files } = kind === 'dir' ? dirSize(full) : { bytes: st.size, files: 1 };
    entries.push({ name, kind, bytes, files, category: categoryOf(name) });
    totalBytes += bytes;
    fileCount += files;
  }
  return { entries, excluded, totalBytes, fileCount };
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(Buffer.from(String(passphrase), 'utf8'), salt, KEY_LEN, SCRYPT_PARAMS);
}

/** Encrypt a small buffer; returns { iv, ciphertext, tag }. */
function encryptBlock(key, plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

function decryptBlock(key, iv, ciphertext, tag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Assemble the fixed-size header + encrypted-metadata prefix of the file. */
function buildHeader(salt, meta, key) {
  const metaPlain = Buffer.from(JSON.stringify(meta), 'utf8');
  const m = encryptBlock(key, metaPlain);
  const metaLen = Buffer.alloc(4);
  metaLen.writeUInt32BE(m.ciphertext.length, 0);
  return Buffer.concat([
    MAGIC, Buffer.from([VERSION]),
    salt, m.iv, metaLen, m.ciphertext, m.tag,
  ]);
}

/**
 * Parse the header/metadata region from the front of a `.hermesport` file.
 * `passphrase` is required to decrypt (and thereby validate) the metadata.
 * Returns { meta, dataOffset } — dataOffset is where the encrypted payload
 * (dataIv + ciphertext + trailing tag) begins.
 * Throws 'bad passphrase or corrupt file' on any mismatch.
 */
function parseHeader(buf, passphrase) {
  if (buf.length < MAGIC.length + 1 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not a .hermesport file');
  }
  let off = MAGIC.length;
  const version = buf[off]; off += 1;
  if (version !== VERSION) throw new Error(`unsupported .hermesport version ${version}`);
  const salt = buf.subarray(off, off + SALT_LEN); off += SALT_LEN;
  const metaIv = buf.subarray(off, off + IV_LEN); off += IV_LEN;
  const metaLen = buf.readUInt32BE(off); off += 4;
  const metaCiphertext = buf.subarray(off, off + metaLen); off += metaLen;
  const metaTag = buf.subarray(off, off + TAG_LEN); off += TAG_LEN;

  const key = deriveKey(passphrase, salt);
  let meta;
  try {
    meta = JSON.parse(decryptBlock(key, metaIv, metaCiphertext, metaTag).toString('utf8'));
  } catch {
    throw new Error('bad passphrase or corrupt file');
  }
  return { meta, dataOffset: off, key, salt };
}

// ---------------------------------------------------------------------------
// Path rewriting (portability across machines / users)
// ---------------------------------------------------------------------------

/**
 * Rewrite absolute paths that embed the source machine's home dirs so the
 * restored config points at the target. Longest paths first to avoid partial
 * overlaps. Returns the rewritten string (unchanged if nothing matched).
 */
function rewritePaths(text, { sourceHermesHome, targetHermesHome, sourceHome, targetHome }) {
  let out = String(text);
  const subs = [];
  if (sourceHermesHome && targetHermesHome && sourceHermesHome !== targetHermesHome) {
    subs.push([sourceHermesHome, targetHermesHome]);
  }
  if (sourceHome && targetHome && sourceHome !== targetHome) {
    subs.push([sourceHome, targetHome]);
  }
  // apply longest source first
  subs.sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of subs) out = out.split(from).join(to);
  return out;
}

/** Config files whose contents get path-rewritten on import. */
const PATH_REWRITE_FILES = ['config.yaml', '.env'];

module.exports = {
  MAGIC,
  VERSION,
  EXCLUDE_NAMES,
  PATH_REWRITE_FILES,
  categoryOf,
  isExcluded,
  planExport,
  deriveKey,
  encryptBlock,
  decryptBlock,
  buildHeader,
  parseHeader,
  rewritePaths,
  // low-level constants for the streaming layer in main.js
  IV_LEN,
  TAG_LEN,
  SALT_LEN,
};
