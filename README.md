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
- **Permission modes per member** — pick how aggressive each harness runs (e.g. yolo / acceptEdits / default flags).
- **Workspace as security boundary** — headless members run inside the group workspace directory.
- **Local-only + token auth** — the embedded server binds to 127.0.0.1 with a random per-install token; nothing phones home.
- **Tray-resident** — closing the window keeps the group working; quit from the tray menu.

## Built-in members

| Member | Headless invocation | Notes |
|---|---|---|
| ZCode | `zcode -p` | needs system Node ≥ 22.5 (`node:sqlite`) |
| Claude Code | `claude -p` | |
| Codex | `codex exec` | model comes from its own configured provider (local relays must be running) |
| Gemini CLI | `gemini -p` | |
| Qoder CLI | `qoderclicn -p` | |
| Cline | `cline` via npx | `cline-free/*` models are free |
| Hermes | `hermes -z` | |
| MiniMax Code | `minimax -p` | experimental; headless path may not work on current versions |

Detection order: PATH → well-known install locations → manual path override in Settings. Members that aren't found are greyed out, and you can always add your own via the command template.

## Install

```bash
npm install
npm start          # dev
npm run dist       # build Windows installer (NSIS)
```

Requires Node.js ≥ 20 for building. The app itself embeds its own Node via Electron; some members (ZCode) need a system Node ≥ 22.5.

## Security

Read [SECURITY.md](SECURITY.md) before daily use. Short version: depending on the permission mode you choose per member, harnesses can read/write files and execute commands **without confirmation** inside the workspace. Only add harnesses you trust.

## Known limitations

- This is one-shot headless dispatch: the stitched context of a "continue" lives in the prompt we send, not in the harness's own session tree, and HarnessChat does not read your existing TUI sessions. Attaching to the harness's own live session (so both sides share one thread) is on the roadmap.
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

安装：`npm install && npm start`（开发）或 `npm run dist`（打 Windows 安装包）。安全须知见 [SECURITY.md](SECURITY.md)。协议 MIT。
