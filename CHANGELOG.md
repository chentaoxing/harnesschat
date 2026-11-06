# Changelog

## 0.7.0 (2026-11-07)

交付闭环：一单跑完，卡片自己说清"到底交付了什么"，而且**结论是我们从盘上称的，不是成员自述的**。

- **起跑前取证据，跑完后再称一遍**（`src/server/delivery.js`）。文件层 = 两次目录快照的差异（新增/改动/删除，带大小）；git 层 = 起跑前后各问一次 `git status --porcelain` + `rev-parse HEAD`。两个来源独立，谁也不引用成员说了什么。
- **`只动了嘴` 这一判词是核心**。成员自述"三份报告都创建好了"而盘上零变化、git 也没动 → 判 `talked_only`，并把矛盾写出来（"它自述做了事，但盘上零变化：要么本来就只是回答问题，要么写入被权限模式拦住了"）。这是"界面说的和实际做的不一致"这一类缺陷第一次被产品自己抓住。
- **绝不读文件正文**。交付结论只有路径 + 大小 + git 计数，正文一行都不进（隐私 + 体积，而且正文对"交付了什么"没有判别力）。有断言直接往文件里写一句"不想外传的句子"来验证结论里不出现它。
- **有界且带"至少"**。快照上限 4000 个文件，触顶就 `partial`，结论标"至少"。`.git` / `node_modules` / `__pycache__` 不进清单（否则真产出被淹）。junction 指回上层不递归——E 盘上这是常态，靠 realpath 去重。
- **下一步建议只能说有据可查的话**：点出真实路径；仓库里有未提交改动就明说"有 N 条未提交，要留就 commit，别让它悬在工作区"。零产出时不编建议。
- **体检探针不附交付结论**（`shouldAttach`：quiet 或 `taskKind==='health'` 都跳过），否则每天 11 条"零产出"噪音；也不会为探针白扫两遍全工作区。
- 交付结论随卡片落 `messages.jsonl`（`task_delivery` 事件在回放时折叠回卡片），**重启后这张卡片仍然说得出当时改了哪些文件**；它不作为独立消息塞进群聊。
- `runTask` 在子进程起跑前拿 `task._pre`（快照 + git），`finishTask` 里称完差异后删掉，不外泄到 API。
- 断言 232 → **269 项**（`scripts/delivery-checks.cjs` 37 项：快照/差异/大目录截断/junction 防递归/git 两栏/五档判词/正文不外泄/真服务端两扇自定义成员走端到端 + 重启回放）。


## 0.6.0 (2026-11-07)

门体检进产品。起因是一次全机实测：11 扇门里**只有 1 扇真的调用过文件工具**，其余要么卡 key，要么答得漂亮但一次工具没用。账本能告诉你"成功/失败"，回答不了"这扇门到底能不能替我把一段活干完"——而接下来要做的自动选人必须建立在这个答案上。

- **侧栏新增「🩺 门体检」**（`src/server/health.js` + `runHealthCheck`）：逐扇派一次只读探针，判据是它能不能把**现造的随机 canary 文件名**独立成行回出来。答得出来 = `能干完活`；跑完了但没回出来 = `只会聊天`（不进选人池）；失败 = 红并带归因层。模型猜不出那个随机名字，所以这不是"它说它会"，是可反驳的证据。
- **探针禁止自己造文件**：提示词明写"不得创建/修改/删除/重命名任何文件，包括不许新建一个文件来配合这次检查"，并且没有可用工具时只准回 `NO_TOOL`。同时 canary 必须**独立成行**才算命中——"我会创建 CANARY-x.txt 给你"这种句子判 chatter，不判 green。
- **体检不污染群转录**：`runTask` 增加 quiet 通道（不 push 卡片、不广播 delta、不落转录），结果只写 `health.jsonl`。否则每天 11 张探针卡片会把群刷成日志。这一单仍然记账本，但任务类型记成 `health`，**不混进五类路由样本**。
- **绿门池 `greenDoors(now, maxAgeHours, usage)`**：最后一次体检是绿、且在 24 小时内、且此刻不在限流冷却，才进池。过绿不等于现在绿（key 会过期、上游会下线）。这是第 ③ 步自动选人的候选池接口。
- **自动体检默认关**：每次全机体检都真花额度，这个开关归陈韬行；打开后可设间隔，**下限 6 小时**（不许配成每 1 分钟刷额度），并且只在没有活人在派单时才插队跑。
- **失败分层补两类**（都来自本轮实测原文）：`not logged in / please run /login` → `auth`；`npm error / ETARGET / notarget / Cannot find module / MODULE_NOT_FOUND` → 新层 `launch`（"CLI 本体起不来"和"这台机器没装"是两件事，都发生在模型之前，也都**不进冷却**）。`launch` 判定放在 `not_found` 之前，否则 `MODULE_NOT_FOUND` 会被裸 `NOT_FOUND` 抢走。
- 实测记录（本机 11 扇）：`qoderclicn` 44s **green**（canary 命中）；`zcode`/`gemini`/`hermes`/`codebuddy`/`dsh`/`qwenwork` 红在 `auth`；`claude` 红在未登录；`cline` 红在 `launch`（`npx cline` 撞 `ETARGET: @ai-sdk/gateway@4.0.137` 不存在）；`codex` 等满超时红在 `timeout`；`minimax` 未检测到。
- 断言 196 → **232 项**（新增 `scripts/health-checks.cjs` 29 项，含"假读卡器/假吹牛"两扇自定义成员走真服务端端到端；`usage-checks` 52→59）。UI 验证脚本 `scripts/ui-health-check.cjs`。


## 0.5.3 (2026-11-07)

把本机 17 家 harness 全部盘了一遍，接入实测真有无头入口的两家：**DeepSeek Harness（dsh）** 和 **QwenWork 内嵌的 Qwen Code（阿里办公）**。顺带修掉一个凭证守卫的真漏洞。

- **dsh 进门**：`dsh headless "<任务>"` 是它官方的一次性问答（答案走 stdout、诊断走 stderr），垫片形状是 `exe --expose-internals <asar 里的 cli.js> %*`，`parseCmdShim` 以前只认 npm/python/直启 exe 四形状，现在会拆这一种，并把垫片自己 `set` 的 `ELECTRON_RUN_AS_NODE` 一起带出来。dsh **只有一个模式档**：它的 `--help` 全文没有任何审批/绕过开关，所以这里不凭空造"绕过档"（`--json` 是输出格式，不是权限模式，不进 modes）。`where dsh` 找不到它，入口写进 `KNOWN_PATHS.dsh`。
- **QwenWork 进门**：本体 Electron 无 CLI（`QwenWorkCN.exe --help` 直接开 GUI），但它把一份 Qwen Code 运行时随产品带进来了：`<安装版本目录>\resources\agent-sdk\components\qwencode\<版本>\runtime\qwen-code\cli.js`，用同目录的 `QwenWorkCN.exe` 当 node 跑。版本目录会随升级换号，`findQwenCodeCli()` 按版本名从新到旧找，新版没落地 `cli.js` 就回落到有的那版。默认档 `--approval-mode default`，并强制带 `--max-wall-time`（无人值守不许无限跑）；`--yolo` 单独一档且打 bypass 标记。
- **两门都实弹验证过，但都还没通**：派单能起进程、能归层——dsh 回 `MISSING_CREDENTIAL … export DEEPSEEK_API_KEY in the launching environment`，Qwen Code 回 `No auth type is selected …`。账本两次都记成 `auth` 层、结论 `鉴权不通`（**不是"实测可用"**）。缺的都是它自己的 key/login，我不会去取应用内存的凭据。
- **修掉一个凭证守卫的真漏洞**：自家目录判定原来是子串匹配，`.qwen` 会把 `.qwenworkcn`（QwenWork 应用自己的凭据目录，里面就是 `engine-maas-key.dat`）也认成自家，等于给这门开了一条合法指过去的路。现在按**路径段**匹配；`CRED_SHAPED` 补上"名字里带 key 的数据文件"（`engine-maas-key.dat`、`master-key.bin`），同时用反向用例保证 `cache-index.dat` / `sessions.dat` 不误伤。这条漏洞是断言抓出来的，不是读代码看出来的。
- **补两类失败样本进尺子**：`MISSING_CREDENTIAL`、`No auth type is selected` 归 `auth`（缺 key 不会自己长出来，所以不进冷却）。
- **17 家全表**（README 新增，逐家实测）：能接并已接 9 家 + 这次的 2 家 = **11 家**；其余 6 家给了明确的不接理由——Trae / Antigravity 的 `chat` 子命令只把 prompt 送进已开的 GUI 窗口、stdout 不回内容；Doubao 无 CLI（`command_helper.exe` 要父进程 pid）；OpenCode 本机只有桌面版、没有 `opencode` 命令；AutoClaw 的本体目录已不在机器上（只剩配置与日志）；Xiaomi MiMo 的 `mimocode` 数据目录齐全但可执行体没落地；SkillClaw 与 TDAI 是代理/记忆层，没有"传一个 prompt 拿回答"的入口。
- 断言 162 → **196 项**（新增 `scripts/newdoors-checks.cjs` 30 项；`security-checks` 48→52）。实弹脚本 `scripts/live-member-check.cjs` 可对任意成员跑一单并把正文写进 UTF-8 日志。


## 0.5.2 (2026-11-07)

把"没做的"做完：账本从"只记我派的"扩到"看得见它在终端里干的"，免费档的结论改成有证据的结论，CodeBuddy 接成成员——以及一个真机逼出来的假绿修复。

- **退出码 0 不再等于成功**（`usage.deriveStatus()`，`finishTask` 统一用它）。实测形态：CodeBuddy 撞到网关报错时把 `503 No available channel …(request id: …)` / `401 Invalid token …` 打在 stdout 上**退 0**，只看退出码的账本把它记成"成功"，面板结论写着"实测可用"——这是最坏的一种假绿：闸门和路由会据此把活派给它。现在卡片与账本用同一判据，只认它自己那种"裸错误行"的形状（行首 4xx/5xx + ASCII + `request id:`/`(distributor)`/`no available channel`），正文里正常讨论"401 是什么"不误杀。`scripts/gate-integration.cjs` 用假成员把两种情况都钉住了。
- **新增失败层 `gateway`（网关侧）**：`No available channel` / `upstream error: do request failed` / `(distributor)` 归到本机网关，不冷却那一扇门——该修的是路由，不是等 30 分钟。
- **免费档改成"证据 + 结论"**（`freeEvidence`）：以前模型 id 里带 `free` 就标"免费档"，那是把自称当事实。现在每个 成员×模型 给一个结论：`实测可用` / `实测有额度上限`（真撞过限流）/ `鉴权不通` / `网关侧不通` / `订阅到期` / `仅 id 自称`（一次都没真打到厂商），并在下一行写明依据。
- **终端会话用量并入账本**（`src/server/terminal-usage.js`）：他在各家自己终端里手敲的那部分，以前我完全看不见，"今天谁还闲着"就是假的。现在从转录里逐条归因：ZCode 一条 `model_io` 记录 = 一次模型往返（带它自己写下的模型 id 与耗时），Claude Code 一条 `assistant` 记录 = 一次往返（`<synthetic>` 不算）。面板上「我派的」和「终端里另观察到」分两笔记，**不相加**——因为我分不出某一条是不是我自己派的，相加就是把猜测报成精确。认不出布局的家（Codex 存 `.jsonl.zst`，且一轮里几次往返分不开）在面板上明写"未统计"。
- 扫描是有界的：只读时间窗内改过的文件、按 64 MB / 400 个文件封顶，**触顶就把该行标成"至少 N 次"**。此前用 24 MB 时，本机 91 次往返只数到 17 次——那不是保守，那是把数报小。逐行流式读，不把 47 MB 的文件整块读进主进程。与独立全量核对：91 = 91。
- **新内置成员 CodeBuddy（cbc）**：WorkBuddy 桌面端自带的无头 CLI。我先前把它判死过一次（`MODULE_NOT_FOUND`），真实原因两条都实测了：① 这个包的 `cli/dist` 只有 `codebuddy-lite-wb.mjs`，不给 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` 它就一路 require 不存在的 headless/full 产物；② 代理环境变量会让它自己的 `axios setProxy` 抛 `TypeError`，配置拉不到后被误报成 `Authentication required`。于是派单时显式注入 lite-wb 开关、并把代理变量逐个置空删除（`childEnv` 新增"值为 null = 从子环境里删掉这个变量"的语义）。默认档不带任何绕过 flag；它家目录只认 `~/.codebuddy`，指到 `~/.workbuddy/.../connector-keys/*.key` 会被凭证守卫拦下。
- **成员模型清单多一个来源**：CodeBuddy 的 `custom-local:*` 列自它自己读的 `~/.workbuddy/models.json`（配置，不是凭据）。实测结论也写进了成员说明：那批模型要 `${NEWAPI_KEY}` 这类环境变量，WorkBuddy 界面外取不到——要么在系统环境里设好并把变量名写进设置的「额外透传变量」（只写名字），要么在 WorkBuddy 里登录一次改用它的自带模型；我不会去翻它存的密钥。
- `esc()` 属性转义沿用；凭证守卫补上 `hosts.yml` / `.config/gh`（gh 的凭据也是别家凭据，原来漏在形状表之外）。
- 断言从 82 项增至 **162 项**：`security-checks` 48 · `usage-checks` 52 · `gate-integration` 14 · `codebuddy-checks` 23（新）· `terminal-usage-checks` 25（新）。


## 0.5.1 (2026-11-07)

用量账本 + 凭证守卫。这一版是给"哪家今天免费、还剩多少"这件事装上数据，顺带把调研定下的边界焊进代码。

- **用量账本**（`src/server/usage.js` + 侧栏「📊 用量」）：按 成员×模型 累计今天/总次数、成/败、失败原因分类、中位耗时、按任务类型的成功率；append-only `usage.jsonl`，重启从盘上重算。输入框新增「任务类型」（写代码/调研/评审/总结/救卡住的活），账本按它统计——将来"该派给谁"就按这张表说话，不按感觉。
- **限流冷却闸门**：只有 `rate_limit` 类失败让该 成员×模型 冷却 30 分钟，期间派单被拦下并给一行原因。鉴权失败与订阅到期**不冷却**——重试不会自愈，假装会自愈只会掩盖问题。
- **判据踩到并已修掉的误判**：`/429/` 在真实堆栈 `zcode.cjs:2103:84294` 的行列号上命中，把一次网关鉴权失败误判成限流并冷却了 30 分钟。现在：具体成因优先于状态码、状态码必须带词边界、判定主要看输出头部。这条由 `scripts/usage-checks.cjs` 用真实样本钉住（31 项）。
- **凭证守卫**（`src/server/guard.js`）：任何形如路径的参数或环境变量，只要指向别家的凭证文件（`auth.json` / `credentials.json` / `connector-keys` / `*.key` …）且不在该成员自家目录下，起跑前直接拦下。边界来自调研结论：只走"那家自己的 CLI + 那家自己的登录"，不做订阅复用与多账号轮询。
- `scripts/security-checks.cjs` 增至 42 项；`scripts/ui-usage-check.cjs` 在真实渲染层里读回面板 DOM，验证账本确实在界面里看得见。

## 0.5.0 (2026-10-08)

派单安全收紧。两条都是社区同类工具的通病（调研见 README 引的 SECURITY.md），此前我们也有：

- **子进程环境改为白名单**：以前是 `{ ...process.env, ...built.env }`，也就是每次派单，那个 CLI 都能看到本机环境变量里所有别的家的 key。现在只放行 OS 起跑必需项 + 各家自己的家目录/配置目录 + 代理变量，密钥形状的名字一律不过（第二道网）。真机实测：子进程可见变量 29 个，塞进去的 canary `ANTHROPIC_API_KEY` / `GH_TOKEN` 都没过去，ZCode 仍正常起跑到它自己的网关。确实需要多放行一个变量时，在配置里写 `envExtra: ["VAR_NAME"]`（只写名字，不写值）。
- **8 个内置成员的默认权限模式全部改为不绕过**：此前 zcode(`--mode yolo`)、gemini(`-y`)、qoder(`bypass_permissions`)、hermes(`--yolo`) 的**默认档**就是绕过 flag，README 里"conservative default, bypass opt-in"那句是不准的。现在绕过档仍在，但要你在设置里显式选。
- 新增 `scripts/security-checks.cjs`：把上面两条变成断言（35 项），bypass flag 一旦回到某个默认 argv、或密钥形状的变量一旦穿过环境过滤，就直接失败退出，别发版。
- 代价说清楚：无头模式没有审批通道，保守档下成员可能**拒绝写文件**而不是报错卡住。想让它放开的，按成员逐个开绕过档，风险自担（SECURITY.md 有说明）。

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
