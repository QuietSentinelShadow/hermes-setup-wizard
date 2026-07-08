# Changelog

All notable changes to the Hermes Setup Wizard.

## 1.1.0 — 2026-07-08

- **Migrate / clone an agent between machines.** New "Migrate an agent" flow
  (from the Welcome screen) that packages a complete Hermes instance — config,
  secret keys, OAuth/auth tokens, SOUL, memories, scheduled jobs, skills,
  device pairings and (optionally) full chat history — into a single
  passphrase-encrypted `.hermesport` file.
  - AES-256-GCM encryption with a scrypt-derived key; contents are
    authenticated (tampering is detected on import).
  - Reinstallable program files and caches are deliberately left out.
  - Import previews the bundle before restoring, backs up existing config,
    rewrites machine-specific paths for the new home, and warns on cross-OS
    moves.

## 1.0.0 — 2026-07-07

First release. 🎉

- Guided wizard that installs the official NousResearch Hermes Agent on
  macOS and Windows (runs the official installer — no admin rights needed).
- Model & provider setup: OpenRouter, OpenAI, Anthropic, Google AI Studio,
  xAI, DeepSeek, NVIDIA NIM, Hugging Face, Z.AI/GLM, Kimi/Moonshot, MiniMax,
  Nous Portal (OAuth), local Ollama / LM Studio, and any custom
  OpenAI-compatible endpoint. Keys are verified live and models listed.
- Telegram setup with live token verification (@BotFather instructions built in).
- WhatsApp pairing with the QR code shown right in the app.
- One-click gateway start: background service (launchd / Windows) or terminal.
- Built-in health check (`hermes doctor`).
- In-app update check with release notes; installers upgrade in place.
