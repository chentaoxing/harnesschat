# Changelog

## 0.3.1 (2026-10-08)

- 启动时把上次遗留的 `running` 任务标为 `interrupted`（「已中断（应用重启）」）：应用被杀/崩溃/升级重启后，界面不再永远挂着「干活中…」的假卡片，而「停止」对这种僵尸卡片本来也无效。
- 失败/超时/中断的任务卡片新增「重试」按钮（原样重新派单给同一成员、同一串、同一模型）与「复制输出」；复制按钮恢复各自原文案。
- 维护脚本 `scripts/e2e-updater.cjs`：在真实 Electron 主进程里跑更新器（`HC_INSTALL=1` 时才下载安装包并拉起安装器）。

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
