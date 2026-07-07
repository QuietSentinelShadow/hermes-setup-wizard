# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Instead, use GitHub's private reporting:
**Security → Report a vulnerability** on this repository
(<https://github.com/QuietSentinelShadow/hermes-setup-wizard/security/advisories/new>).

We aim to acknowledge reports within a few days.

## Scope

This app configures the Hermes Agent on the user's own machine. Areas we care
about most:

- **Secret handling** — API keys and bot tokens must never appear in logs,
  error messages, the renderer, or crash reports. They are written only to
  `~/.hermes/.env` (mode `600`) and to `hermes config`.
- **Command execution** — the app spawns the official NousResearch installer
  and the local `hermes` CLI. Arguments are passed as arrays (never shell
  strings built from user input). Reports of injection via provider keys,
  tokens, model names, or terminal-launch paths are in scope.
- **Electron hardening** — `contextIsolation` and `sandbox` are on,
  `nodeIntegration` is off, navigation away from the bundled UI is blocked, and
  external links open in the system browser. Regressions here are in scope.
- **Update feed** — the app reads a GitHub Releases feed and opens installer
  URLs in the browser; it does not auto-execute downloads. Reports of the feed
  being used to run untrusted content are in scope.

## Out of scope

- The app runs the official Hermes installer (`curl | bash` / `irm | iex`) from
  `hermes-agent.nousresearch.com`. That is an intentional, documented design
  choice, not a vulnerability in this app.
- The installers are unsigned; OS "unidentified developer" warnings are
  expected and documented.
