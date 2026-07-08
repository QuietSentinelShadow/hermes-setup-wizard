# Hermes Setup Wizard

[![CI](https://github.com/QuietSentinelShadow/hermes-setup-wizard/actions/workflows/ci.yml/badge.svg)](https://github.com/QuietSentinelShadow/hermes-setup-wizard/actions/workflows/ci.yml)
[![Release](https://github.com/QuietSentinelShadow/hermes-setup-wizard/actions/workflows/release.yml/badge.svg)](https://github.com/QuietSentinelShadow/hermes-setup-wizard/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A Mac/Windows desktop app that installs and configures the
[NousResearch Hermes Agent](https://github.com/NousResearch/Hermes-Agent)
through a friendly step-by-step wizard — made for sharing with friends who
don't live in a terminal.

**Download:** grab the latest `.dmg` (macOS) or `.exe` (Windows) from the
[**Releases**](https://github.com/QuietSentinelShadow/hermes-setup-wizard/releases)
page.

**What it sets up**

1. **Hermes Agent** — runs the official NousResearch installer
   (`install.sh` / `install.ps1`), no admin rights needed.
2. **Models & providers** — add API keys for any of: OpenRouter, OpenAI,
   Anthropic, Google AI Studio, xAI, DeepSeek, NVIDIA NIM, Hugging Face,
   Z.AI/GLM, Kimi/Moonshot, MiniMax, Nous Portal (OAuth), local **Ollama** /
   **LM Studio**, or any custom OpenAI-compatible endpoint. Keys are verified
   live, available models listed, and a default model chosen.
3. **Telegram** — guided @BotFather bot creation, token verified against the
   Telegram API and saved.
4. **WhatsApp** — QR pairing (like WhatsApp Web) shown right in the app.
5. **Gateway** — one click to run Hermes as a background service
   (launchd / Windows) or in a terminal, plus a `hermes doctor` health check.

Everything the wizard writes goes to the standard Hermes locations
(`~/.hermes/.env`, `hermes config set …`), so `hermes setup` and the wizard
can be mixed freely.

## For friends installing it

- **macOS**: open the `.dmg`, drag the app to Applications. The app is not
  code-signed, so the first launch needs: **right-click the app → Open →
  Open**. (Or: System Settings → Privacy & Security → "Open Anyway".)
- **Windows**: run the `.exe` installer. If SmartScreen appears, click
  **More info → Run anyway** (unsigned app).

Then just follow the wizard.

## Migrate / clone an agent to another machine

From the Welcome screen, **Migrate / clone an agent** packages a complete
Hermes instance into a single **passphrase-encrypted `.hermesport` file** you
can move to another computer (USB, AirDrop, scp, cloud — anything).

- **Export** bundles the agent's *identity*: `config.yaml`, `.env` (all secret
  keys), `auth.json` (OAuth tokens), `SOUL.md`, `memories/`, `cron/`, skills,
  WhatsApp/device pairings, and — optionally — full `sessions/` chat history.
  Reinstallable program files (`hermes-agent/`, `node/`, `bin/`) and caches are
  left out. The file is encrypted with **AES-256-GCM** under a **scrypt**-derived
  key and authenticated, so a wrong passphrase or any tampering is detected.
- **Import** on the target machine (after installing Hermes) previews the
  bundle, backs up any existing config, restores the files, and rewrites
  machine-specific paths for the new home. Cross-OS moves are flagged with a
  warning (secrets/memories transfer; some paths and the WhatsApp pairing may
  need redoing).

The format is documented at the top of [`lib/portability.js`](lib/portability.js).

## Updates

The app checks for new versions (sidebar → **Check for updates**) and shows
the release notes of what changed. Downloading the new installer and running
it upgrades the app **in place** — Hermes Agent settings are untouched.
**What's new** in the sidebar shows the bundled changelog.

The update feed defaults to this repo's GitHub Releases; override it with the
`HERMES_WIZARD_UPDATE_FEED` environment variable (GitHub Releases API JSON or
a plain `{"releases":[{"version","notes","mac","win"}]}` manifest).

## Development

```bash
npm install
npm start                # run the app
HERMES_SETUP_MOCK=1 npm start   # UI walkthrough without touching anything

npm test                 # unit tests (node:test)
npm run test:e2e         # Playwright end-to-end (mock mode, full wizard walk)

npm run icon             # regenerate build/icon.png (needs Pillow)
npm run dist:mac         # dist/: universal .dmg + .zip
npm run dist:win         # dist/: NSIS installer .exe + .zip (cross-built on macOS)
```

Useful env vars: `HERMES_SETUP_MOCK=1` (simulate installer/pairing),
`HERMES_SETUP_HOME` (redirect the Hermes home directory),
`HERMES_SETUP_BIN` (path to the hermes CLI).

## Releasing a new version

Releases are automated. The [`release` workflow](.github/workflows/release.yml)
builds the Mac and Windows installers and publishes them to a GitHub Release
whenever you push a `v*` tag.

1. Bump `version` in `package.json`.
2. Add a section to `CHANGELOG.md` headed `## <version> — <date>` — this is
   what users read under **What's new**, and what the release job extracts into
   the GitHub Release body (which the in-app updater shows).
3. Commit, then tag and push:
   ```bash
   git commit -am "Release v1.0.1"
   git tag v1.0.1
   git push origin main --tags
   ```
4. CI builds `…-mac-universal.dmg` + `…-win-x64.exe`, creates the
   `v1.0.1` Release, and attaches them. Installed apps offer the update with
   those notes on their next check; the installers upgrade in place.

To cut a release by hand instead: `npm test && npm run test:e2e && npm run dist`,
then `gh release create v1.0.1 dist/*.dmg dist/*.exe --notes-file <notes>`.

> Note: fully silent auto-update (electron-updater) needs code-signing
> certificates on macOS. The current flow — notify, show notes, download,
> run installer — works unsigned.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Every PR runs the [CI workflow](.github/workflows/ci.yml) (unit + end-to-end
tests on Linux, macOS and Windows). Licensed under [MIT](LICENSE).

## Architecture

- `main.js` — Electron main process: spawns the official installer and
  `hermes` CLI with streamed output, verifies provider keys / Telegram tokens
  over HTTPS, writes `.env` values, checks the update feed.
- `preload.js` — the only bridge (contextIsolation on, sandbox on).
- `renderer/` — the wizard UI (vanilla JS, no framework).
- `lib/hermes.js` — pure logic: paths, `.env` upserts, provider catalog
  (mirrors `hermes_cli/auth.py` PROVIDER_REGISTRY), command builders.
- `lib/updates.js` — release feed parsing / version comparison.
- `lib/portability.js` — what to include/exclude when porting an instance, the
  `.hermesport` crypto format, and path rewriting (pure, unit-tested).
- `lib/portio.js` — builds/reads/restores the encrypted bundle (tar + streaming
  AES-256-GCM).
