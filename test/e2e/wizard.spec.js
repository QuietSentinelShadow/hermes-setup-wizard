'use strict';
/**
 * End-to-end walk through the whole wizard in mock mode
 * (HERMES_SETUP_MOCK=1 — no real installer, network or ~/.hermes writes;
 * everything lands in a temp HERMES_SETUP_HOME).
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VALID_TG_TOKEN = '123456789:' + 'A'.repeat(35);

// The tests walk one wizard session start to finish — run them as a unit.
test.describe.configure({ mode: 'serial' });

let app, page, tmpHome;

test.beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-e2e-'));
  app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: {
      ...process.env,
      HERMES_SETUP_MOCK: '1',
      HERMES_SETUP_HOME: tmpHome,
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function shot(name) {
  await page.screenshot({ path: path.join('test-results', 'screens', `${name}.png`) });
}

test('step 1 — welcome shows system info and no install', async () => {
  await expect(page.locator('h1')).toContainText('Welcome');
  await expect(page.locator('[data-testid="sys-info"]')).toContainText('not installed yet');
  await expect(page.locator('#sys-badge')).toContainText('MOCK MODE');
  await shot('01-welcome');
  await page.click('[data-testid="btn-next"]');
});

test('step 2 — install runs and completes', async () => {
  await expect(page.locator('h1')).toContainText('Install Hermes Agent');
  // Next is gated until the install finishes
  await expect(page.locator('[data-testid="btn-next"]')).toBeDisabled();
  await page.click('[data-testid="btn-run-install"]');
  await expect(page.locator('[data-testid="term-install"]')).toContainText('Hermes installed', { timeout: 15000 });
  await expect(page.locator('#install-status')).toContainText('installed successfully');
  await expect(page.locator('[data-testid="btn-next"]')).toBeEnabled();
  await shot('02-install');
  await page.click('[data-testid="btn-next"]');
});

test('step 3 — provider verify, bad key error, default model save', async () => {
  await expect(page.locator('h1')).toContainText('Models');

  // a bad key surfaces the error
  const openai = page.locator('[data-provider="openai-api"]');
  await openai.locator('.provider-head').click();
  await openai.locator('[data-testid="key-openai-api"]').fill('bad-key');
  await openai.locator('[data-testid="verify-openai-api"]').click();
  await expect(openai.locator('[data-status]')).toContainText('key rejected');

  // a good key verifies and lists models
  const or = page.locator('[data-provider="openrouter"]');
  await or.locator('.provider-head').click();
  await or.locator('[data-testid="key-openrouter"]').fill('sk-or-test-123');
  await or.locator('[data-testid="verify-openrouter"]').click();
  await expect(or.locator('[data-status]')).toContainText('3 models');

  // default box appears; save
  await expect(page.locator('#default-box')).toBeVisible();
  await expect(page.locator('[data-testid="default-model"]')).toHaveValue('nousresearch/hermes-4-405b');
  await shot('03-models');
  await page.click('[data-testid="btn-save-models"]');
  await expect(page.locator('#models-status')).toContainText('Saved');
  await expect(page.locator('[data-testid="btn-next"]')).toBeEnabled();
  await page.click('[data-testid="btn-next"]');
});

test('step 4 — telegram rejects bad token, accepts valid one', async () => {
  await expect(page.locator('h1')).toContainText('Telegram');
  await page.fill('[data-testid="tg-token"]', 'not-a-token');
  await page.click('[data-testid="btn-tg-save"]');
  await expect(page.locator('[data-testid="tg-status"]')).toContainText('does not look like a bot token');

  await page.fill('[data-testid="tg-token"]', VALID_TG_TOKEN);
  await page.click('[data-testid="btn-tg-save"]');
  await expect(page.locator('[data-testid="tg-status"]')).toContainText('@mock_bot');
  await shot('04-telegram');
  await page.click('[data-testid="btn-next"]');
});

test('step 5 — whatsapp pairing shows QR and completes', async () => {
  await expect(page.locator('h1')).toContainText('WhatsApp');
  await page.click('[data-testid="btn-wa-pair"]');
  await expect(page.locator('[data-testid="term-whatsapp"]')).toContainText('Scan this QR code', { timeout: 15000 });
  await expect(page.locator('[data-testid="term-whatsapp"]')).toContainText('Paired (mock)');
  await expect(page.locator('[data-testid="wa-status"]')).toContainText('WhatsApp linked');
  await shot('05-whatsapp');
  await page.click('[data-testid="btn-next"]');
});

test('step 6 — finish: summary, doctor and gateway service', async () => {
  await expect(page.locator('h1')).toContainText('Almost done');
  const summary = page.locator('[data-testid="summary"]');
  await expect(summary).toContainText('Hermes Agent');
  await expect(summary).toContainText('nousresearch/hermes-4-405b');
  await expect(summary).toContainText('@mock_bot');
  await expect(summary).toContainText('WhatsApp');
  await expect(summary.locator('.ok')).toHaveCount(4); // nothing skipped

  await page.click('[data-testid="btn-doctor"]');
  await expect(page.locator('[data-testid="term-doctor"]')).toContainText('All checks passed', { timeout: 15000 });

  await page.click('[data-testid="ch-service"]');
  await expect(page.locator('[data-testid="gw-status"]')).toContainText('running in the background', { timeout: 15000 });
  await shot('06-finish');
});

test('config was written to the (temp) Hermes home', async () => {
  const env = fs.readFileSync(path.join(tmpHome, '.env'), 'utf8');
  expect(env).toContain('OPENROUTER_API_KEY=sk-or-test-123');
  expect(env).toContain(`TELEGRAM_BOT_TOKEN=${VALID_TG_TOKEN}`);
  expect(env).toContain('WHATSAPP_ENABLED=true');
  // the bad OpenAI key was never persisted
  expect(env).not.toContain('bad-key');
});

test('update check shows release notes for a newer version', async () => {
  await page.click('[data-testid="lnk-updates"]');
  await expect(page.locator('#modal-title')).toContainText('Version 9.9.9 is available');
  await expect(page.locator('[data-testid="modal-body"]')).toContainText('Mock feature one');
  await expect(page.locator('#modal-action')).toContainText('Download update');
  await shot('07-updates');
  await page.click('[data-testid="modal-close"]');
});

test('whats-new shows the bundled changelog', async () => {
  await page.click('#lnk-whatsnew');
  await expect(page.locator('[data-testid="modal-body"]')).toContainText('1.0.0');
  await page.click('[data-testid="modal-close"]');
});

test('back navigation and skip flow work', async () => {
  // back to WhatsApp step
  await page.click('[data-testid="btn-back"]');
  await expect(page.locator('h1')).toContainText('WhatsApp');
  // skip forward again
  await page.click('[data-testid="btn-skip"]');
  await expect(page.locator('h1')).toContainText('Almost done');
});
