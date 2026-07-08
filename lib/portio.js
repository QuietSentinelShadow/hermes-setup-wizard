'use strict';
/**
 * File-level orchestration for Hermes instance porting: create/read/restore
 * the encrypted `.hermesport` bundle. No Electron imports, so this is
 * exercised directly by the unit tests (full encrypt → decrypt round-trip).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');

const P = require('./portability');

function tmpFile(suffix) {
  return path.join(os.tmpdir(), `hermesport-${crypto.randomBytes(8).toString('hex')}${suffix || ''}`);
}

/**
 * Build an encrypted bundle from `home` into `outFile`.
 * meta is embedded (encrypted) so import can preview without unpacking.
 * Returns { entries, totalBytes, outFile, bytesWritten }.
 */
async function exportBundle({ home, outFile, passphrase, includeSessions = true, extraMeta = {} }) {
  if (!passphrase || String(passphrase).length < 8) {
    throw new Error('passphrase must be at least 8 characters');
  }
  const plan = P.planExport(home, { includeSessions });
  if (!plan.entries.length) throw new Error('nothing to export — is this a Hermes home?');

  const salt = crypto.randomBytes(P.SALT_LEN);
  const key = P.deriveKey(passphrase, salt);
  const meta = {
    format: 'hermesport',
    version: P.VERSION,
    createdAt: extraMeta.createdAt || null,
    sourcePlatform: extraMeta.sourcePlatform || process.platform,
    sourceArch: extraMeta.sourceArch || process.arch,
    sourceHome: extraMeta.sourceHome || os.homedir(),
    sourceHermesHome: home,
    hermesVersion: extraMeta.hermesVersion || null,
    appVersion: extraMeta.appVersion || null,
    includeSessions,
    entries: plan.entries,
    totalBytes: plan.totalBytes,
    fileCount: plan.fileCount,
  };

  const header = P.buildHeader(salt, meta, key);

  // 1) tar+gzip the planned entries into a temp file (preserves file modes).
  const tarTmp = tmpFile('.tgz');
  try {
    await tar.create(
      { gzip: true, file: tarTmp, cwd: home, follow: false },
      plan.entries.map((e) => e.name),
    );

    // 2) stream-encrypt the tarball into outFile: header | dataIv | ct | tag
    const dataIv = crypto.randomBytes(P.IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, dataIv);
    const out = fs.createWriteStream(outFile);

    await new Promise((resolve, reject) => {
      out.on('error', reject);
      out.write(header);
      out.write(dataIv);
      const src = fs.createReadStream(tarTmp);
      src.on('error', reject);
      cipher.on('data', (chunk) => out.write(chunk));
      cipher.on('error', reject);
      cipher.on('end', () => {
        out.write(cipher.getAuthTag());
        out.end();
      });
      out.on('finish', resolve);
      src.pipe(cipher);
    });

    const bytesWritten = fs.statSync(outFile).size;
    return { entries: plan.entries, totalBytes: plan.totalBytes, fileCount: plan.fileCount, outFile, bytesWritten };
  } finally {
    fs.rmSync(tarTmp, { force: true });
  }
}

/** Read + validate the metadata of a bundle (needs the passphrase). */
function inspectBundle({ file, passphrase }) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(size, 1 << 20)); // 1 MiB covers the meta
    fs.readSync(fd, head, 0, head.length, 0);
    const { meta, dataOffset } = P.parseHeader(head, passphrase);
    return { meta, dataOffset, fileSize: size };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Restore a bundle into `targetHome`. Backs up any config files that would be
 * overwritten, extracts, then rewrites machine-specific paths.
 * Returns { meta, backupDir, rewritten, restoredEntries }.
 */
async function importBundle({ file, passphrase, targetHome, targetHomeDir, rewrite = true }) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  let header;
  try {
    const head = Buffer.alloc(Math.min(size, 1 << 20));
    fs.readSync(fd, head, 0, head.length, 0);
    header = P.parseHeader(head, passphrase);
  } finally {
    fs.closeSync(fd);
  }
  const { meta, dataOffset, key } = header;

  // read trailing tag + data iv
  const tag = Buffer.alloc(P.TAG_LEN);
  const ivBuf = Buffer.alloc(P.IV_LEN);
  const fd2 = fs.openSync(file, 'r');
  try {
    fs.readSync(fd2, ivBuf, 0, P.IV_LEN, dataOffset);
    fs.readSync(fd2, tag, 0, P.TAG_LEN, size - P.TAG_LEN);
  } finally {
    fs.closeSync(fd2);
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuf);
  decipher.setAuthTag(tag);

  const ctStart = dataOffset + P.IV_LEN;
  const ctEnd = size - P.TAG_LEN - 1; // inclusive
  const tarTmp = tmpFile('.tgz');
  try {
    await new Promise((resolve, reject) => {
      const src = fs.createReadStream(file, { start: ctStart, end: ctEnd });
      const out = fs.createWriteStream(tarTmp);
      src.on('error', reject);
      out.on('error', reject);
      decipher.on('error', (e) => reject(new Error('bad passphrase or corrupt file')));
      out.on('finish', resolve);
      src.pipe(decipher).pipe(out);
    });

    fs.mkdirSync(targetHome, { recursive: true });

    // back up config files that would be overwritten
    const backupDir = path.join(targetHome, `.import-backup-${meta.createdAt ? meta.createdAt.replace(/[:.]/g, '-') : 'prev'}`);
    let backedUp = 0;
    for (const name of ['config.yaml', '.env', 'auth.json', 'SOUL.md']) {
      const cur = path.join(targetHome, name);
      if (fs.existsSync(cur)) {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(cur, path.join(backupDir, name));
        backedUp += 1;
      }
    }

    // extract (restores modes, merges/overwrites)
    await tar.extract({ file: tarTmp, cwd: targetHome, preservePaths: false });

    // rewrite machine-specific paths in text configs
    let rewritten = [];
    if (rewrite) {
      const map = {
        sourceHermesHome: meta.sourceHermesHome,
        targetHermesHome: targetHome,
        sourceHome: meta.sourceHome,
        targetHome: targetHomeDir || os.homedir(),
      };
      for (const name of P.PATH_REWRITE_FILES) {
        const p = path.join(targetHome, name);
        if (!fs.existsSync(p)) continue;
        const before = fs.readFileSync(p, 'utf8');
        const after = P.rewritePaths(before, map);
        if (after !== before) {
          const mode = fs.statSync(p).mode;
          fs.writeFileSync(p, after);
          fs.chmodSync(p, mode);
          rewritten.push(name);
        }
      }
    }

    return {
      meta,
      backupDir: backedUp ? backupDir : null,
      backedUp,
      rewritten,
      restoredEntries: (meta.entries || []).map((e) => e.name),
    };
  } finally {
    fs.rmSync(tarTmp, { force: true });
  }
}

module.exports = { exportBundle, inspectBundle, importBundle };
