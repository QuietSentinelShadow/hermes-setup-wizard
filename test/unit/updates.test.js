'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const updates = require('../../lib/updates');

test('compareVersions', () => {
  assert.strictEqual(updates.compareVersions('1.0.0', '1.0.0'), 0);
  assert.strictEqual(updates.compareVersions('1.0.0', '1.0.1'), -1);
  assert.strictEqual(updates.compareVersions('1.2.0', '1.10.0'), -1);
  assert.strictEqual(updates.compareVersions('2.0.0', '1.9.9'), 1);
  assert.strictEqual(updates.compareVersions('v1.1.0', '1.1'), 0);
});

const GH_FEED = [
  { tag_name: 'v1.2.0', draft: true, body: 'draft', assets: [] },
  { tag_name: 'v1.2.0-beta', prerelease: true, body: 'beta', assets: [] },
  {
    tag_name: 'v1.1.0', body: '- Adds things\n- Fixes things', published_at: '2026-08-01T00:00:00Z',
    html_url: 'https://github.com/x/y/releases/v1.1.0',
    assets: [
      { name: 'Hermes Setup Wizard-1.1.0-mac-universal.dmg', browser_download_url: 'https://dl/mac.dmg' },
      { name: 'Hermes Setup Wizard-1.1.0-win-x64.exe', browser_download_url: 'https://dl/win.exe' },
    ],
  },
  { tag_name: 'v1.0.0', body: 'first', assets: [] },
];

test('pickUpdate finds the newest stable GitHub release with platform asset', () => {
  const mac = updates.pickUpdate(GH_FEED, '1.0.0', 'darwin');
  assert.strictEqual(mac.version, '1.1.0');
  assert.strictEqual(mac.asset, 'https://dl/mac.dmg');
  assert.match(mac.notes, /Adds things/);
  assert.strictEqual(mac.date, '2026-08-01');

  const win = updates.pickUpdate(GH_FEED, '1.0.0', 'win32');
  assert.strictEqual(win.asset, 'https://dl/win.exe');
});

test('pickUpdate skips drafts and prereleases', () => {
  const u = updates.pickUpdate(GH_FEED, '1.1.0', 'darwin');
  assert.strictEqual(u, null); // 1.2.0 is draft, 1.2.0-beta is prerelease
});

test('pickUpdate returns null when up to date or feed empty', () => {
  assert.strictEqual(updates.pickUpdate(GH_FEED, '9.9.9', 'darwin'), null);
  assert.strictEqual(updates.pickUpdate([], '1.0.0', 'darwin'), null);
  assert.strictEqual(updates.pickUpdate({ nonsense: true }, '1.0.0', 'darwin'), null);
});

test('pickUpdate supports the plain manifest format', () => {
  const manifest = {
    releases: [
      { version: '1.0.0', notes: 'first', mac: 'https://dl/1.0.dmg', win: 'https://dl/1.0.exe' },
      { version: '1.3.0', notes: 'newest', date: '2026-09-01', mac: 'https://dl/1.3.dmg', win: 'https://dl/1.3.exe' },
    ],
  };
  const u = updates.pickUpdate(manifest, '1.0.0', 'win32');
  assert.strictEqual(u.version, '1.3.0');
  assert.strictEqual(u.asset, 'https://dl/1.3.exe');
  assert.strictEqual(u.notes, 'newest');
});

test('feedUrl can be overridden by env', () => {
  process.env.HERMES_WIZARD_UPDATE_FEED = 'https://example.com/updates.json';
  try {
    assert.strictEqual(updates.feedUrl(), 'https://example.com/updates.json');
  } finally {
    delete process.env.HERMES_WIZARD_UPDATE_FEED;
  }
  assert.strictEqual(updates.feedUrl(), updates.DEFAULT_FEED);
});
