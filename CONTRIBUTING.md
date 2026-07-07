# Contributing

Thanks for helping improve the Hermes Setup Wizard! This is a small, friendly
project — a desktop wizard that installs and configures the
[NousResearch Hermes Agent](https://github.com/NousResearch/Hermes-Agent).

## Getting set up

```bash
git clone https://github.com/QuietSentinelShadow/hermes-setup-wizard.git
cd hermes-setup-wizard
npm install
npm start                       # run the app against your real machine
HERMES_SETUP_MOCK=1 npm start   # click through the UI without touching anything
```

You need Node.js 20+ (22 is used in CI). Python 3 with Pillow is only needed if
you want to regenerate the app icon (`npm run icon`); the committed
`build/icon.png` is used otherwise.

## Before you open a pull request

Run the full test suite — the same commands CI runs:

```bash
npm test            # unit tests (node:test)
npm run test:e2e    # Playwright end-to-end walk of the whole wizard (mock mode)
```

Both must pass. If you change behaviour, add or update a test for it:

- **`test/unit/`** — pure logic in `lib/` (`.env` handling, the provider
  catalog, command builders, launcher wrapping, update-feed parsing). Fast, no
  Electron.
- **`test/e2e/wizard.spec.js`** — drives the real app in mock mode
  (`HERMES_SETUP_MOCK=1`), so no installer, network, or `~/.hermes` writes
  actually happen. Add `data-testid` hooks to new UI you want to assert on.

## Design guidelines

- **Never spawn a shell string built from user input.** Pass args as an array
  to `spawn`; route the hermes CLI through `hermes.launcherSpawn()` so Windows
  `.cmd`/`.ps1` launchers work.
- **Never surface an API key or bot token** in logs, error messages, or the
  renderer. Redact secrets before they leave the main process.
- **Keep the main/renderer boundary strict.** `contextIsolation` and `sandbox`
  stay on; the renderer only talks to main through the `preload.js` bridge.
- **Mirror the real Hermes contract.** The provider catalog in `lib/hermes.js`
  tracks `hermes_cli/auth.py`; `.env` keys and `hermes config set` calls must
  match what the CLI expects. When in doubt, check against a real Hermes install.
- Match the surrounding vanilla-JS style — no framework, no build step for the
  renderer.

## Adding a model provider

Add an entry to `PROVIDERS` in [`lib/hermes.js`](lib/hermes.js) with its `id`,
`name`, `kind`, `envKey`, `keyUrl`, and a `verify` descriptor (how to list its
models). Add it to the "provider catalog is well-formed" assertions in
`test/unit/hermes.test.js`. The wizard UI picks it up automatically.

## Releasing

Maintainers: bump `version` in `package.json`, add a `## <version> — <date>`
section to `CHANGELOG.md`, then push a `v<version>` tag. CI builds and publishes
the installers. See the "Releasing a new version" section of the README.

## Reporting bugs / requesting features

Open an issue using the templates. For security issues, see
[SECURITY.md](SECURITY.md) — please don't file those publicly.
