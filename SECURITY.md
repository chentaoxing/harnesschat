# Security Policy / 安全说明

## What HarnessChat does with your agents

HarnessChat launches AI harness CLIs (Codex, Claude Code, Qoder CLI, …) as **local child processes** inside the group workspace directory. Depending on the permission mode configured per member:

- Agents may **read and write files** in the workspace without confirmation.
- Agents may **execute shell commands** without confirmation (e.g. yolo/bypass modes).
- Task prompts may contain the group conversation history (for thread continuation).

## Built-in mitigations

- The embedded server binds to `127.0.0.1` only, and requires a random per-install token (stored in the app's user-data directory) for its HTTP/WS API.
- Child processes are spawned as an argv array **without a shell**, so chat text cannot inject shell metacharacters into the command line.
- The workspace directory is the intended blast radius. Point it at a dedicated folder, not your home directory.

## What you should do

1. Only add harnesses / custom members you trust.
2. Prefer conservative permission modes; bypass/yolo modes are opt-in per member in Settings.
3. Keep the workspace out of version control and out of any synced folder with sensitive credentials.
4. The token file lives next to the config (`%APPDATA%/harnesschat/token.txt` on Windows). Treat it like a secret.

## Prompt-injection risk

Group messages are concatenated into task prompts. Any agent whose output gets quoted into another agent's task can attempt prompt injection. This is inherent to multi-agent chat tools; review agent output before feeding it forward.

## Reporting

Open a GitHub issue for anything you find. Given this is a local tool, please do not include secrets in reports.
