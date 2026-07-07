'use strict';
/**
 * Update feed logic for the Hermes Setup Wizard.
 *
 * The app checks a release feed and, when a newer version exists, shows its
 * release notes and offers the platform installer. Installers upgrade
 * in place (NSIS on Windows installs over the previous version; on macOS the
 * DMG replaces the app in /Applications).
 *
 * Two feed formats are supported:
 *  1. GitHub Releases API (an array of release objects) — the default.
 *  2. A plain manifest: { "releases": [ { "version", "notes", "date",
 *     "mac": "<url>", "win": "<url>" } ] }
 */

const DEFAULT_FEED = 'https://api.github.com/repos/QuietSentinelShadow/hermes-setup-wizard/releases';

function feedUrl() {
  return process.env.HERMES_WIZARD_UPDATE_FEED || DEFAULT_FEED;
}

/** "v1.2.3-beta" → { parts: [1,2,3], pre: true } */
function parseVersion(v) {
  const s = String(v || '').trim().replace(/^v/i, '');
  const pre = /-/.test(s);
  const parts = s.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return { parts: parts.slice(0, 3), pre };
}

/** semver-ish compare: -1 | 0 | 1 */
function compareVersions(a, b) {
  const pa = parseVersion(a).parts;
  const pb = parseVersion(b).parts;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function pickAsset(assets, platform) {
  const names = assets.map((a) => ({ name: String(a.name || a.url || ''), url: a.url }));
  const find = (re) => names.find((a) => re.test(a.name))?.url || null;
  if (platform === 'darwin') return find(/\.dmg$/i) || find(/mac.*\.zip$/i) || find(/darwin.*\.zip$/i);
  if (platform === 'win32') return find(/\.exe$/i) || find(/win.*\.zip$/i);
  return null;
}

/** Normalize either feed format into [{version, notes, date, assets[], url}] */
function normalizeFeed(json) {
  if (Array.isArray(json)) {
    // GitHub Releases API
    return json
      .filter((r) => r && !r.draft && !r.prerelease && (r.tag_name || r.name))
      .map((r) => ({
        version: String(r.tag_name || r.name).replace(/^v/i, ''),
        notes: r.body || '(no release notes)',
        date: (r.published_at || '').slice(0, 10),
        url: r.html_url || '',
        assets: (r.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url })),
      }));
  }
  if (json && Array.isArray(json.releases)) {
    return json.releases.map((r) => ({
      version: String(r.version || '').replace(/^v/i, ''),
      notes: r.notes || '(no release notes)',
      date: r.date || '',
      url: r.url || '',
      assets: [
        r.mac ? { name: 'mac.dmg', url: r.mac } : null,
        r.win ? { name: 'win.exe', url: r.win } : null,
      ].filter(Boolean),
    }));
  }
  return [];
}

/**
 * Given a fetched feed, decide whether an update is available.
 * Returns null when current is up to date, else
 * { version, notes, date, url, asset } for the newest release.
 */
function pickUpdate(feedJson, currentVersion, platform) {
  const releases = normalizeFeed(feedJson)
    .filter((r) => !parseVersion(r.version).pre)
    .sort((a, b) => compareVersions(b.version, a.version));
  const latest = releases[0];
  if (!latest) return null;
  if (compareVersions(latest.version, currentVersion) <= 0) return null;
  return {
    version: latest.version,
    notes: latest.notes,
    date: latest.date,
    url: latest.url,
    asset: pickAsset(latest.assets, platform),
  };
}

module.exports = { DEFAULT_FEED, feedUrl, parseVersion, compareVersions, normalizeFeed, pickAsset, pickUpdate };
