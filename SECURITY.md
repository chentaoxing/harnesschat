# Security Policy / 安全说明

## What HarnessChat does with your agents

HarnessChat launches AI harness CLIs (Codex, Claude Code, Qoder CLI, …) as **local child processes** inside the group workspace directory. Depending on the permission mode configured per member:

- Agents may **read and write files** in the workspace without confirmation.
- Agents may **execute shell commands** without confirmation (e.g. yolo/bypass modes).
- Task prompts may contain the group conversation history (for thread continuation).

## Built-in mitigations

- The embedded server binds to `127.0.0.1` only, and requires a random per-install token (stored in the app's user-data directory) for its HTTP/WS API.
- Child processes are spawned as an argv array **without a shell**, so chat text cannot inject shell metacharacters into the command line. `stdin` is closed on every spawn (a CLI that waits on a pipe would otherwise hang a headless dispatch).
- **Child environment is allow-listed, not inherited.** A member gets the OS essentials, its own home/app-data locations, and the proxy variables — and nothing else. API keys and other `*_KEY` / `*_TOKEN` / `*_SECRET` variables that happen to live in your environment are never passed down, so one member cannot read another vendor's credentials. Each harness authenticates with its own login on disk. If a member genuinely needs an extra variable, add its **name** to `envExtra` in the app config (names only, never values).
- **The default permission mode of every built-in member never carries a bypass flag.** yolo / `-y` / `--dangerously-skip-permissions` / `bypassPermissions` exist only as an explicit, per-member opt-in in Settings.
- **Credential paths are refused before a dispatch starts.** If an argument or an passed environment value points at another tool's stored secrets (`auth.json`, `credentials.json`, `connector-keys`, `*.key`, `token.txt`, `.aws/credentials`, gh's `hosts.yml` / `.config/gh`, `.env`, cookies, secrets), the task fails immediately instead of launching. A member naming a file inside *its own* home directory is allowed; CodeBuddy is deliberately scoped to `~/.codebuddy`, so pointing a dispatch at `~/.workbuddy/**/connector-keys/*.key` is blocked even though both belong to the same vendor's product line.
- **Success is judged from output, not only from the exit code.** Several CLIs print the upstream error to stdout and exit 0 (`503 No available channel …(request id: …)`, `401 Invalid token …`, `Authentication required`). Treating exit 0 as success would put a *false green* into the ledger, and the cooldown gate and any future routing would then trust a door that never worked. The detector is anchored on those literal error shapes and is pinned by tests, including the negative case (a reply that *discusses* a 401 is not an error).
- Both properties above are enforced by an executable check, not by documentation: `node scripts/security-checks.cjs` fails the build if a bypass flag reappears in a default argv or a secret-shaped variable survives the environment filter.
- The workspace directory is the intended blast radius. Point it at a dedicated folder, not your home directory. Note that a *takeover* dispatch (from the session radar) runs in the dead session's own directory by design — that is a deliberate widening of the blast radius, so review the brief before sending.

## What you should do

1. Only add harnesses / custom members you trust.
2. Prefer conservative permission modes; bypass/yolo modes are opt-in per member in Settings.
3. Keep the workspace out of version control and out of any synced folder with sensitive credentials.
4. The token file lives next to the config (`%APPDATA%/harnesschat/token.txt` on Windows). Treat it like a secret.

## Prompt-injection risk

Group messages are concatenated into task prompts. Any agent whose output gets quoted into another agent's task can attempt prompt injection. This is inherent to multi-agent chat tools; review agent output before feeding it forward.

## Reporting

Open a GitHub issue for anything you find. Given this is a local tool, please do not include secrets in reports.
