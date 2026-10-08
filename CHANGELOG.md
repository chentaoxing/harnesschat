# Changelog

## 0.4.0 (2026-10-08)

- **外部会话雷达 + 一键接手**（`src/server/sessions.js`）：读各家 harness 自己落在盘上的转录，列出「哪个会话、在哪个工作区、最后要它做什么、多久没动、是不是半路死了、死在哪」。侧栏「🛰 外部会话」，死掉的会话数量直接标成角标。目前认得 ZCode（`~/.zcode/cli/rollout`）、Claude Code（`~/.claude/projects/<目录名即工作区>`）、Codex（`~/.codex/sessions/YYYY/MM/DD`）。
- **接手会把活派到那条会话自己的工作区**，不是群工作区：`/api/send` 新增 `cwd`（只接受已存在的绝对目录，否则回落群工作区），任务卡片记录 `cwd`。理由：接手一个死掉的会话，如果换了目录做，那只是把别人的问题在别处重答一遍。
- 大会话（单条记录就是整段上下文、文件几十 MB）不再读空：工作区与死因走文件头尾原始文本兜底，并处理 JSON 转义过的 Windows 路径。
- `esc()` 补上引号转义（多处结果被放进 `title=` / `value=` 属性）。

## 0.3.2 (2026-10-08)

- **修好 ZCode 成员**：无头 `zcode -p` 之前必报「无法定位 CLI ZCode Built-in Provider Config」。根因是 ZCode CLI 只按「从打包后的应用目录启动」这一种布局找它的 provider 配置（`dirname(entrypoint)/provider/…` 与上溯 5 级的 `config/provider/…`），我们直接跑 `resources/glm/zcode.cjs` 时两个候选都不存在；与登录态、订阅、以及我们选哪个 Node 运行时无关。现在按它自己留的显式入口注入 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` + `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`（两者必须同时给，只给一个它会抛「路径必须同时提供」），路径从 `~/.zcode/v2` 里按 mtime 取最新、缓存 5 分钟。
- 注入不了（没有 `~/.zcode/v2`，即从没登录过 ZCode 桌面端）时，成员说明会直接讲清楚原因。

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
