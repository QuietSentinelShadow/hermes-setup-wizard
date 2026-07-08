'use strict';
/**
 * End-to-end walk of the migrate (export → import) flow in mock mode.
 * A temp HERMES_SETUP_HOME is pre-populated so there is a real agent to
 * export; the export writes a real encrypted bundle and the import restores
 * it (mock dialogs are bypassed — see main.js port:export / port:pickFile).
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

test.describe.configure({ mode: 'serial' });

let app, page, home;

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mig-'));
  fs.writeFileSync(path.join(home, '.env'), 'OPENROUTER_API_KEY=sk-or-secret\nTELEGRAM_BOT_TOKEN=1:tok\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'config.yaml'), 'model:\n  provider: openrouter\n');
  fs.writeFileSync(path.join(home, 'SOUL.md'), '# me\n');
  fs.mkdirSync(path.join(home, 'memories'));
  fs.writeFileSync(path.join(home, 'memories', 'a.md'), 'note');
  fs.mkdirSync(path.join(home, 'hermes-agent')); // must be excluded
  fs.writeFileSync(path.join(home, 'hermes-agent', 'cli.py'), 'code');

  app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, HERMES_SETUP_MOCK: '1', HERMES_SETUP_HOME: home },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function shot(name) {
  await page.screenshot({ path: path.join('test-results', 'screens', `${name}.png`) });
}

test('open migrate from welcome', async () => {
  await page.click('[data-testid="btn-migrate"]');
  await expect(page.locator('h1')).toContainText('Migrate an agent');
  await expect(page.locator('[data-testid="tab-export"]')).toBeVisible();
});

test('export shows plan (secrets/config/identity/memory, no binaries) and writes a bundle', async () => {
  const plan = page.locator('#export-plan');
  await expect(plan).toContainText('Secret keys');
  await expect(plan).toContainText('Memories');
  await expect(plan).not.toContainText('hermes-agent');

  await page.fill('[data-testid="exp-pass"]', 'short');
  await page.click('[data-testid="btn-do-export"]');
  await expect(page.locator('#export-status')).toContainText('at least 8', { timeout: 5000 });

  await page.fill('[data-testid="exp-pass"]', 'clone-passphrase');
  await page.fill('[data-testid="exp-pass2"]', 'mismatch-xxxxxx');
  await page.click('[data-testid="btn-do-export"]');
  await expect(page.locator('#export-status')).toContainText('do not match');

  await page.fill('[data-testid="exp-pass2"]', 'clone-passphrase');
  await page.click('[data-testid="btn-do-export"]');
  await expect(page.locator('#export-status')).toContainText('Saved', { timeout: 15000 });
  await shot('08-migrate-export');
});

test('import rejects wrong passphrase, then unlocks + restores with the right one', async () => {
  await page.click('[data-testid="tab-import"]');
  await page.click('[data-testid="btn-pick"]');
  await expect(page.locator('#pick-status')).toContainText('.hermesport', { timeout: 5000 });

  await page.fill('[data-testid="imp-pass"]', 'wrong-passphrase');
  await page.click('[data-testid="btn-unlock"]');
  await expect(page.locator('#unlock-status')).toContainText('bad passphrase', { timeout: 10000 });

  await page.fill('[data-testid="imp-pass"]', 'clone-passphrase');
  await page.click('[data-testid="btn-unlock"]');
  await expect(page.locator('#unlock-status')).toContainText('Unlocked');
  await expect(page.locator('#import-detail')).toContainText('Secret keys');
  await shot('09-migrate-import');

  await page.click('[data-testid="btn-do-import"]');
  await expect(page.locator('#import-status')).toContainText('Restored', { timeout: 15000 });
});

test('back to setup returns to the wizard', async () => {
  await page.click('[data-testid="btn-migrate-back"]');
  await expect(page.locator('h1')).toContainText('Welcome');
});
