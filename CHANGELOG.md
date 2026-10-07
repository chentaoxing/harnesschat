# Changelog

## 0.3.0 (2026-10-07)

- **Self-updating**: GitHub Releases check on startup and every 30 min, in-app "Check for updates" in Settings plus a chat-header banner, download to `%TEMP%` and launch the installer.
  - Two routes so a shared proxy can't break updates: `api.github.com` first, automatic fallback to `releases.atom` + the release page asset link when the anonymous per-IP quota is exhausted. Optional token via `GH_TOKEN` or `%APPDATA%\HarnessChat\github-token.txt` (own data dir only).
  - All traffic uses Electron's network stack, so the system proxy is honoured (plain `fetch` would bypass it). Hard timeouts on every request, 45 s idle watchdog on downloads, `.part` + atomic rename, size verification, download host whitelist, 5-minute stale-lock takeover.
- **Bundled Node for `.js`/`.cjs` members**: upgraded Electron 33 → 44 (embedded Node 24.21 with `node:sqlite`), so ZCode and Cline-via-npx no longer need a system Node ≥ 22.5; falls back to system Node when the embedded one is too old.
- **Preload bridge**: renderer is fully sandboxed from Node; only `version` / `checkUpdate` / `downloadAndRun` / `onUpdateProgress` are exposed.

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
