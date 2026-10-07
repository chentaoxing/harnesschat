# Changelog

## 0.2.0 (2026-10-07)

Open-source preparation release. Renamed to **HarnessChat**.

- Member system pluginized: cross-platform detection (PATH → known locations → manual path override), undetected members greyed out
- Custom members via command template (`{{prompt}}` / `{{model}}` / `{{cwd}}`), configurable in Settings
- Built-in members now include Claude Code and Gemini CLI; all hardcoded personal paths removed
- Per-member permission modes (conservative default, bypass opt-in); first-run security notice
- Local API token authentication (random per install)
- Per-message model override in the composer
- New app icon (Qwen-Image generated, reproducible packaging script)
- Repo infrastructure: LICENSE (MIT), bilingual README, SECURITY.md

## 0.1.0 (2026-10-07)

First working version (personal build, not published).

- WeChat-style group chat UI, tray-resident Electron app with embedded server
- @-mention dispatch to headless harnesses with live streamed output (JSONL persistence + replay)
- Task threads with continuation, per-member default model
- Six built-in adapters verified on Windows: ZCode, Codex, Qoder CLI, Cline, Hermes, MiniMax Code (experimental)
