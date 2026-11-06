# HarnessChat

**English** | [中文](#中文)

A group-chat desktop app for AI coding harnesses. Pull your agents — Codex, Claude Code, Gemini CLI, Qoder CLI, Cline, Hermes, ZCode, or anything with a CLI — into one WeChat-style group chat, `@`-mention a member to dispatch a task, and watch its output stream back into the room in real time.

> Think of it as a WeChat/QQ group where the members are AI agents running on your own machine.

![icon](assets/icon.png)

## Why

Most agent orchestrators in 2026 are worktree/diff/PR centric — they treat agents as code-producing workers. HarnessChat treats them as **chat members**: dispatch work by talking, see everything in one timeline, and keep the transcript searchable in one place.

## Features

- **@-mention dispatch** — `@Codex refactor the README` spawns the harness headlessly in the group workspace; stdout/stderr streams into the task card live.
- **Threads with continuation** — every dispatched task opens a thread; "继续对话" stitches the previous prompt + output tail into the next prompt as working memory.
- **Per-member default model** — each harness has different models with different prices; set the default per member, and override the model on any single message.
- **Custom members via command template** — any CLI agent works: fill in `program` + argument template with `{{prompt}}` / `{{model}}` / `{{cwd}}` placeholders. No code needed.
- **Permission modes per member** — the default mode of every built-in member is a non-bypassing one; yolo/bypass is always a separate, explicit opt-in in Settings.
- **Scrubbed child environment** — members are launched with an allow-listed environment (OS essentials + their own config dirs + proxy), never your whole `process.env`. One harness cannot read another vendor's API key.
- **Workspace as security boundary** — headless members run inside the group workspace directory (a takeover dispatch runs in the dead session's own directory, by design).
- **Local-only + token auth** — the embedded server binds to 127.0.0.1 with a random per-install token; nothing phones home.
- **Session radar & takeover** — reads the transcripts each harness already writes to disk (ZCode, Claude Code, Codex), shows which sessions are still running, gone quiet, or **died mid-task and why** (quota exhausted, auth failure, dropped connection), and hands any of them to another member — *in that session's own working directory*, so the work continues instead of being re-explained.
- **Usage ledger & rate-limit cooldown** — Settings-free bookkeeping per member × model: calls today, success/failure split, failure *layer* (rate limit / auth / expired subscription / not detected / timeout / **gateway**), median duration, and per-task-type success. Hitting a rate limit puts that member on a 30-minute cooldown instead of hammering it; auth, expiry and gateway failures are never "cooled", because retrying them doesn't heal anything. Success is judged from the output, not just the exit code — several CLIs print `401 Invalid token …` / `503 No available channel …` on stdout and still exit 0.
- **Terminal activity in the ledger** — what you run by hand inside each harness is read back from the transcripts it already writes (one `model_io` record in ZCode = one model round-trip; one `assistant` record in Claude Code = one), shown as a *separate* number from what this app dispatched. They are never added together, because a dispatch also lands in that transcript and I cannot tell the two apart — summing them would report a guess as a measurement. Harnesses whose layout isn't recognised are listed as **not counted**.
- **Free-tier claims carry their evidence** — a model id containing `free` no longer prints as "free tier". Each door shows a verdict derived from what actually happened to it: `observed working`, `quota-capped` (a real 429 happened), `auth failure`, `gateway down`, `subscription expired`, or `id claims it only` (never actually reached the vendor), with the reason on the next line.
- **Door health check** — the ledger says success/failure; it does not say whether a door can actually *do the work*. One click (or a daily opt-in run) dispatches a read-only probe into a throwaway workspace containing a randomly-named marker file, and grades each member on whether it can return that name on its own line: `can do work` / `only talks` / `red` + failure layer. A model cannot guess a name that exists only in the probe directory, so this is falsifiable evidence rather than a claim of capability. The probe prompt explicitly forbids creating or renaming files (otherwise a member could manufacture its own marker), and a marker name mentioned inside a sentence does not count. Probes never enter the group transcript, but they are counted in the ledger under task kind `health`, separate from the five routing kinds. Only doors that were green within the last 24 h *and* are not currently cooling down enter the candidate pool used by routing.
- **Delivery report per task** — when a task finishes, the card states what was actually delivered, measured by us rather than quoted from the agent: files added / changed / deleted (path + size only, never contents, and `.git` / `node_modules` are excluded), plus what `git status` says before vs after. If an agent claims "I created three reports" while the workspace is unchanged, the verdict is `only talked`, with the contradiction spelled out — this is the one case a transcript can never show you. Snapshots are bounded (4 000 files) and anything beyond that is labelled "at least". The report survives restarts by folding into the task card, health probes deliberately produce none, and follow-up hints only name real paths and uncommitted changes.
  Two verdicts exist because real runs produced both traps: **dot-directories the harness itself writes** (`.qoder-credits`, `.claude`, `.next`) are its own runtime bookkeeping and never count as delivery — a measured case turned a refusal into a false `produced` until that was fixed; and a task that changed nothing while its answer mentions permissions (`权限/授权/批准/许可/允许`, `permission`, `approval`, `denied`) is reported as `maybe blocked by the permission mode`, with the way out named (widen that member's permission mode, or restate the task as read-only). The wording is deliberately hedged: agents phrase the same refusal differently on every run — three different sentences were observed within one evening — so this is a structural signal (zero changes + permission vocabulary), not an enumeration of phrasings, and it never claims certainty. Any delivery still counts when files actually changed.
- **Tray-resident** — closing the window keeps the group working; quit from the tray menu.
- **Bundled Node runtime** — members whose CLI ships as a `.js`/`.cjs` entry (ZCode, Cline via npx) run on the Node embedded in Electron, so a system Node is no longer required.
- **Self-updating** — checks this repo's GitHub Releases on startup and every 30 minutes, then downloads and launches the installer from inside the app.

## Built-in members

| Member | Headless invocation | Notes |
|---|---|---|
| ZCode | `zcode -p` | runs on the app's bundled Node; HarnessChat injects the provider-config paths the ZCode desktop app writes under `~/.zcode/v2` (its own lookup only resolves when launched from the packaged app dir) |
| Claude Code | `claude -p` | |
| Codex | `codex exec` | model comes from its own configured provider (local relays must be running) |
| Gemini CLI | `gemini -p` | |
| Qoder CLI | `qoderclicn -p` | |
| Cline | `cline` via npx | `cline-free/*` models are free |
| Hermes | `hermes -z` | |
| MiniMax Code | `minimax -p` | experimental; the mavis LLM endpoint needs an internal auth-broker lease — see SECURITY of their design |
| CodeBuddy (cbc) | `codebuddy -p --output-format text --model custom-local:…` | the headless CLI shipped inside the WorkBuddy app. Two measured quirks are handled by the adapter: it must be told to load the `lite-wb` bundle (`CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`), and proxy variables must be removed or its own config fetch throws and reports "not logged in". Its `custom-local:*` models come from `~/.workbuddy/models.json` and need e.g. `${NEWAPI_KEY}` in the environment — set it in your system environment and list the **name** under Settings → extra passed variables. Logging into WorkBuddy is the other route; HarnessChat never reads the keys that app stores. |
| DeepSeek Harness | `dsh headless "<task>"` | official one-shot answer mode: the answer goes to stdout, diagnostics to stderr. Found via the app's own `.cmd` shim (it is not on `PATH`). Its CLI exposes **no** approval/bypass flag at all, so this member has exactly one mode. Measured blocker: `MISSING_CREDENTIAL` until `DEEPSEEK_API_KEY` is stored via its own Models page or exported in the launching environment. |
| QwenWork / Qwen Code | `QwenWorkCN.exe <bundled qwen-code/cli.js> --approval-mode default -o text --max-wall-time N "<prompt>"` | QwenWork (the Alibaba office app) ships no CLI, but it bundles a Qwen Code runtime under `resources\agent-sdk\components\qwencode\<ver>\runtime\qwen-code\cli.js`; the adapter picks the newest version dir that actually contains the file. Measured blocker: `No auth type is selected` — the *app* login is not Qwen Code auth; give Qwen Code its own `--auth-type`/key or log it in under `~/.qwen`. |

### The other harnesses on this machine, and why they are not members

Every candidate below was checked by running its own `--help` / inspecting its install, not by guessing.

| Harness | Headless entry | Verdict |
|---|---|---|
| ZCode, Claude Code, Codex, Gemini CLI, Qoder CLI, Cline, Hermes, MiniMax Code, WorkBuddy (cbc), DeepSeek Harness, QwenWork | yes | members (11) |
| Trae CN / TRAE SOLO | `trae-cn chat "<prompt>"` exists, but every option is window control (`-m --mode`, `-r`, `-n`) — the prompt is delivered into an already-open GUI and nothing comes back on stdout | not a dispatch door |
| Antigravity | same shape as Trae: `antigravity-ide chat` only opens a window; its `language_server` is a daemon with OAuth, not a one-shot prompt entry | not a dispatch door |
| Doubao | no CLI; `command_helper.exe` refuses to run without a parent PID | not a dispatch door |
| OpenCode | only the desktop app is installed here — `where opencode` finds nothing and there is no CLI inside the app dir | needs its own CLI installed first |
| Xiaomi MiMo | the `mimocode` data/config/storage layout is present (OpenCode-style sessions) but the executable never landed (`.cache\mimocode\bin` is empty) | needs the CLI installed first |
| AutoClaw | its install directory is gone from this machine; only `~/.openclaw-autoclaw` config and old gateway logs remain | not installed |
| SkillClaw | a local OpenAI-compatible proxy + skill-injection daemon (`config: claw_type: hermes`, port 30000); its command surface is service lifecycle only | a layer, not a harness |
| TDAI | TencentDB Agent Memory — a memory core + proxy that other harnesses point their base URL at | a layer, not a harness |


Detection order: PATH → well-known install locations → manual path override in Settings. Members that aren't found are greyed out, and you can always add your own via the command template.

## Install

```bash
npm install
npm start          # dev
npm run dist       # build Windows installer (NSIS)
```

Requires Node.js ≥ 20 to build. The shipped app carries its own Node (embedded in Electron, currently 24.x), so end users need no Node installation at all.

## Updates

Settings → *Version & updates* shows the running version and a **Check for updates** button; a newer release also raises a banner in the chat header. Downloading writes the installer to `%TEMP%` and launches it, so upgrading is two clicks.

How it decides what is newest:

1. `GET https://api.github.com/repos/chentaoxing/harnesschat/releases/latest` — the repo is public, so no credential is needed.
2. If that call is refused (the anonymous quota is counted per source IP and shared proxies burn it fast), it falls back to `https://github.com/chentaoxing/harnesschat/releases.atom` and resolves the asset link from the release page. Neither route needs a token.
3. Optionally put a token in `%APPDATA%\HarnessChat\github-token.txt` (or set `GH_TOKEN`) to lift the quota. HarnessChat only reads its own data directory and environment variables — it never goes looking for other tools' credentials.

All requests go through Electron's network stack, so a system proxy is honoured automatically; every request has a hard timeout, and a stale download lock is taken over after 5 minutes.

## When one of the harnesses updates

Nothing to do on your side: member commands are re-resolved on every launch (PATH → known install locations → your override in Settings), and per-member model lists are read from each harness's own config at run time. The two exceptions worth knowing:

- The **Cline** member runs through `npx`, so it follows whatever version npx resolves; pin it by editing `cline` in `src/server/adapters.js` (e.g. `cline@3.0.69`) if you want a fixed build.
- **MiniMax Code** is experimental and stays off by default: its `mavis` LLM endpoint requires a lease token issued over the desktop app's internal auth broker, which external callers cannot obtain. Refreshing the OAuth token by opening MiniMax Code is not enough.

## Security

Read [SECURITY.md](SECURITY.md) before daily use. Short version: depending on the permission mode you choose per member, harnesses can read/write files and execute commands **without confirmation** inside the workspace. Only add harnesses you trust.

## Known limitations

- The session radar reads transcript files where each harness puts them; it never writes to another tool's directory, and it only shows harnesses whose layout it recognises (ZCode, Claude Code, Codex today). It reconstructs a session's working directory, its last request and the error it stopped on — enough to hand the work over, not a live re-attach into that harness's own session tree (still on the roadmap).
- The terminal part of the ledger counts only round-trips that name their own model. ZCode (`model_io` records) and Claude Code (`assistant` records) qualify; **Codex does not** — its transcripts are stored as `.jsonl.zst` and a turn contains an unknowable number of round-trips, so it is reported as *not counted* instead of guessed. The scan is bounded (7-day window, 64 MB / 400 files); when it hits the bound every affected row is labelled "at least N", never a bare number.
- A dispatched task also lands in that harness's own transcript, and the two records cannot be told apart. That is why "what I dispatched" and "what the terminal shows" stay as two separate numbers.
- Windows is the primary tested platform; macOS/Linux work via `which`-based detection but are less battle-tested. Issues welcome.
- The icon is generated with a Qwen-Image workflow; the build script (`build-icon.js`) packages it reproducibly.

## License

MIT — see [LICENSE](LICENSE).

---

<a id="中文"></a>
# 中文说明

把你的 AI coding harness（Codex / Claude Code / Gemini CLI / Qoder CLI / Cline / Hermes / ZCode，或任何有命令行的 agent）拉进一个**微信风格的群聊**：`@成员` 派任务，输出实时流回群里。

- **@派单**：在群工作区目录里以无头模式拉起对应 harness，stdout/stderr 实时流入任务卡片
- **任务串**：每条派单自动开串，"继续对话"把上文 prompt + 输出尾部拼进下一次任务当工作记忆
- **按成员设默认模型**：各家模型价格不同，逐个设默认值，单条消息也可临时换模型
- **自定义成员**：任意 CLI agent 填 `program` + 参数模板（`{{prompt}}`/`{{model}}`/`{{cwd}}`）即可入群，无需写代码
- **权限模式逐成员可配**，群工作区即安全边界；本地 127.0.0.1 + 随机 token，不上传任何数据
- **托盘常驻**：关窗群继续干活
- **用量账本与限流冷却**：侧栏「📊 用量」按 成员×模型 记今天用了多少、成/败、失败卡在哪一层（限流/鉴权/订阅到期/没检测到/超时）、中位耗时，以及按任务类型的成功率；撞限流自动冷却 30 分钟，鉴权和到期类失败不冷却（重试不会自愈）
- **自带 Node 运行时**：ZCode、Cline(npx) 这类 `.js/.cjs` 入口的成员用 Electron 内嵌的 Node 跑，用户机器不装 Node 也能用
- **自动更新**：启动时与每 30 分钟查一次本仓 GitHub Releases，设置里「检查更新」或顶部横幅一键下载安装包

安装：`npm install && npm start`（开发）或 `npm run dist`（打 Windows 安装包）。安全须知见 [SECURITY.md](SECURITY.md)。协议 MIT。

更新与配额：公开仓匿名即可查版本；走共享代理时匿名配额容易耗尽，此时自动回退 `releases.atom`（同样不需要 token）。想彻底摆脱配额，把 token 放进 `%APPDATA%\HarnessChat\github-token.txt` 或设 `GH_TOKEN`——本程序只读自己的数据目录和环境变量，不会去翻别的工具的凭据。
