// HarnessChat 成员注册表
// 设计：
//   1. 内置成员 = 声明式适配器：discover() 跨平台探测（PATH → 已知安装位置 → 用户手动路径覆盖），
//      buildSpawn() 产出 {file, args, env}，全部经 safeExec 以参数数组启动（无 shell、无注入面）。
//   2. 自定义成员 = 用户在设置里填 program + 参数模板（{{prompt}}/{{model}}/{{cwd}}），存 config.json。
//   3. 检测不到的成员在 UI 灰显，不影响其他成员。

const path = require('path');
const os = require('os');
const fs = require('fs');
const cp = require('child_process');
const RUN_DISCOVERY = cp.execFileSync; // 仅用于 which/where 探测，本身不经过 shell

const IS_WIN = process.platform === 'win32';

// 应用自带的 Electron 可以以 node 模式（ELECTRON_RUN_AS_NODE）运行 JS 入口；
// 内嵌 Node ≥ 22.5（含 node:sqlite）时 zcode 不再依赖系统 Node。
const [NODE_MAJ, NODE_MIN] = process.versions.node.split('.').map(Number);
const EMBEDDED_NODE_OK = NODE_MAJ > 22 || (NODE_MAJ === 22 && NODE_MIN >= 5);
function nodeRunner() {
  if (EMBEDDED_NODE_OK) return { file: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  const n = findNode();
  return n ? { file: n, env: {} } : null;
}

/**
 * ZCode 的无头 CLI 只在「从打包后的应用目录里启动」时能自己找到内置 provider 配置：
 * 它按 dirname(entrypoint)/provider/zcode-builtin.json 与再上溯 5 级的 config/provider/zcode-builtin.json
 * 两个候选去找，而我们直接跑 resources/glm/zcode.cjs 时两个候选都不存在（真文件在 resources/config/provider/），
 * 于是报「无法定位 CLI ZCode Built-in Provider Config」——跟登录态、订阅、我们的 Node 选择都无关。
 *
 * 它同时留了显式入口：ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 与 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
 * 必须同时给（只给一个会抛「路径必须同时提供」），给了就跳过那段查找。两个路径都是 ZCode 桌面端登录后
 * 自己落盘的，版本号目录与 endpoint-<hash> 目录会变，所以按 mtime 取最新的一份，并缓存 5 分钟。
 */
let zcodeEnvCache = { at: 0, value: null };
function zcodeProviderEnv() {
  const now = Date.now();
  if (now - zcodeEnvCache.at < 5 * 60 * 1000) return zcodeEnvCache.value;
  let out = null;
  try {
    const home = os.homedir();
    const personal = path.join(home, '.zcode', 'v2', 'provider_config.json');
    if (fs.existsSync(personal)) {
      const plat = process.platform === 'win32' ? 'windows' : process.platform;
      const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch;
      const root = path.join(home, '.zcode', 'v2', 'runtime', 'provider', `${plat}-${arch}`);
      let best = null;
      for (const ver of safeReadDirs(root)) {
        for (const ep of safeReadDirs(path.join(root, ver))) {
          const f = path.join(root, ver, ep, 'zcode-builtin.json');
          try {
            const st = fs.statSync(f);
            if (!best || st.mtimeMs > best.mtime) best = { file: f, mtime: st.mtimeMs };
          } catch (e) { /* 该目录下没有这份文件，跳过 */ }
        }
      }
      if (best) {
        out = { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: best.file, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal };
      }
    }
  } catch (e) { out = null; }
  zcodeEnvCache = { at: now, value: out };
  return out;
}

function safeReadDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch (e) { return []; }
}

// ---------- 命令探测 ----------
function whichAll(cmd) {
  try {
    const tool = IS_WIN ? 'where' : 'which';
    const args = IS_WIN ? [cmd] : ['-a', cmd];
    const out = RUN_DISCOVERY(tool, args, { encoding: 'utf8', timeout: 5000 }).trim();
    return out.split(/\r?\n/).filter(Boolean);
  } catch (e) { return []; }
}

// Windows .cmd 垫片解析 → { file, prefix, env } | null
function parseCmdShim(cmdPath, cmdDir) {
  let text;
  try { text = fs.readFileSync(cmdPath, 'utf8'); } catch (e) { return null; }
  let m = text.match(/"%_prog%"\s+"([^"]+\.js)"/); // npm 经典模板
  if (m) return { file: m[1].replace(/%dp0%/gi, cmdDir), prefix: [], env: {} };
  m = text.match(/SET\s+"[A-Z_]*CLI_JS=%~dp0\\?([^"]+\.js)"/i); // npm 新版垫片
  if (m) return { file: path.join(cmdDir, m[1]), prefix: [], env: {} };
  m = text.match(/"([^"]+\.exe)"\s+(-I)\s+(-c)\s+"([^"]+)"/); // python 风格（hermes）
  if (m) return { file: m[1], prefix: ['-I', '-c', m[4]], env: {} };
  m = text.match(/"(%dp0%\\[^"]+\.exe)"\s+%*/); // 直启 exe（%dp0% 相对垫片目录，如 claude）
  if (m) return { file: m[1].replace(/%dp0%/gi, cmdDir), prefix: [], env: {} };
  m = text.match(/"%_prog%"\s+"([^"]+\.exe)"/); // 直启 exe
  if (m) return { file: m[1], prefix: [], env: {} };
  return null;
}

const shimCache = new Map();
// 解析命令名/路径 → { file, prefix, env } | null
// 优先级：显式路径覆盖 > PATH 上的 .cmd（解析出真实入口）> PATH 上的可执行（unix shebang 脚本可直接启动）
function resolveCommand(nameOrPath) {
  const key = nameOrPath;
  if (shimCache.has(key)) return shimCache.get(key);
  let resolved = null;
  const isPath = /[\\/]/.test(nameOrPath);
  const candidates = isPath ? [nameOrPath] : whichAll(nameOrPath);
  for (const hit of candidates) {
    if (IS_WIN && /\.cmd$/i.test(hit)) {
      resolved = parseCmdShim(hit, path.dirname(hit));
      if (resolved) break;
    } else if (IS_WIN && /\.(exe|com)$/i.test(hit)) {
      resolved = { file: hit, prefix: [], env: {} }; break;
    } else if (!IS_WIN && !/\.(sh|ps1)$/i.test(hit)) {
      // unix：npm 全局 bin 是带 shebang 的可执行脚本/符号链接，可直接启动
      try { fs.accessSync(hit, fs.constants.X_OK); resolved = { file: hit, prefix: [], env: {} }; break; } catch (e) {}
    }
  }
  // Windows：解析出/直接给出的 .js/.cjs 入口用 node 跑（优先应用内置 Node，回退系统 Node）
  if (!resolved && isPath && /\.(c?js)$/i.test(nameOrPath)) {
    try { fs.accessSync(nameOrPath); resolved = { file: nameOrPath, prefix: [], env: {} }; } catch (e) {}
  }
  if (resolved && /\.c?js$/i.test(resolved.file)) {
    const runner = nodeRunner();
    if (runner) resolved = { file: runner.file, prefix: [resolved.file, ...resolved.prefix], env: { ...resolved.env, ...runner.env } };
  }
  shimCache.set(key, resolved);
  return resolved;
}

function findNode() {
  // 顺序：PATH 上的 node > 常见安装位置。需要 Node≥22.5 的成员见各自 note。
  const hits = whichAll('node');
  for (const h of hits) if (/\.(exe)?$|^node$/i.test(path.basename(h))) return h;
  const guesses = IS_WIN
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
       'D:\\Program Files\\nodejs\\node.exe']
    : ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'];
  for (const g of guesses) { try { fs.accessSync(g); return g; } catch (e) {} }
  return null;
}

// 已知安装位置（各平台猜测，找不到就靠 PATH 或用户手动指定）
const KNOWN_PATHS = {
  zcode: IS_WIN ? [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    'D:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs'
  ] : [
    '/Applications/ZCode.app/Contents/Resources/resources/glm/zcode.cjs'
  ]
};

function resolveMemberProgram(member) {
  if (member.programPath) return resolveCommand(member.programPath);
  for (const kp of (KNOWN_PATHS[member.id] || [])) {
    try { fs.accessSync(kp); return resolveCommand(kp); } catch (e) {}
  }
  const r = resolveCommand(member.command);
  if (r) return r;
  // 探测兜底：cline 等本身不在 PATH、但通过 npx 运行的成员
  if (member.detectCommand) return resolveCommand(member.detectCommand);
  return null;
}

// ---------- 内置成员 ----------
// 权限模式：modes 数组 = [{id, args}]，默认用 modes[0]；headless 没有审批通道，
// 保守模式可能导致任务卡在等确认——设置里可自行调整，风险自担（README 有说明）。
const MEMBERS = [
  {
    id: 'zcode',
    name: 'ZCode',
    color: '#7c5cff',
    command: 'zcode',
    modelSupport: false,
    modelNote: '模型由 ZCode 登录账号决定，不支持在此指定',
    defaultModel: '',
    timeoutMin: 15,
    modes: [
      { id: 'auto', args: ['--mode', 'yolo'] },
      { id: 'edit', args: ['--mode', 'edit'] }
    ],
    noteZh: 'zcode -p 无头模式；用应用内置 Node 跑，并显式注入 ZCode 桌面端落盘的 provider 配置路径（没注入=没找到 ~/.zcode/v2，请先用桌面端登录一次）',
    noteEn: 'zcode headless on the bundled Node; the provider config paths written by the ZCode desktop app are injected explicitly (missing means no ~/.zcode/v2 — log in once with the desktop app)',
    buildSpawn(task, shim, modeArgs) {
      if (!shim) return { error: 'NOT_FOUND' };
      const prov = zcodeProviderEnv();
      return {
        file: shim.file,
        args: [...shim.prefix, '-p', task.prompt, ...modeArgs, '--no-color', '--cwd', task.cwd],
        env: { ...shim.env, ...(prov || {}) }
      };
    }
  },
  {
    id: 'claude',
    name: 'Claude Code',
    color: '#d97757',
    command: 'claude',
    modelSupport: true,
    modelHint: 'sonnet / opus / haiku / 完整模型 id',
    defaultModel: '',
    timeoutMin: 15,
    modes: [
      { id: 'acceptEdits', args: ['--permission-mode', 'acceptEdits'] },
      { id: 'bypass', args: ['--permission-mode', 'bypassPermissions'] }
    ],
    noteZh: 'claude -p 无头模式',
    noteEn: 'claude headless mode',
    buildSpawn(task, shim, modeArgs) {
      if (!shim) return { error: 'NOT_FOUND' };
      const args = [...shim.prefix, '-p', task.prompt, ...modeArgs];
      if (task.model) args.push('--model', task.model);
      return { file: shim.file, args, env: shim.env };
    }
  },
  {
    id: 'codex',
    name: 'Codex',
    color: '#10a37f',
    command: 'codex',
    modelSupport: true,
    modelHint: '留空用 codex config.toml 的默认模型',
    defaultModel: '',
    timeoutMin: 15,
    modes: [
      { id: 'default', args: [] },
      { id: 'bypass', args: ['--dangerously-bypass-approvals-and-sandbox'] }
    ],
    noteZh: 'codex exec；模型走其自身配置的 provider（本地中转型配置需中转在线）',
    noteEn: 'codex exec; uses its own configured provider (local relays must be running)',
    buildSpawn(task, shim, modeArgs) {
      if (!shim) return { error: 'NOT_FOUND' };
      const args = [...shim.prefix, 'exec', ...modeArgs, '--skip-git-repo-check', '-C', task.cwd];
      if (task.model) args.push('-m', task.model);
      args.push(task.prompt);
      return { file: shim.file, args, env: shim.env };
    }
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    color: '#4285f4',
    command: 'gemini',
    modelSupport: true,
    modelHint: 'gemini-2.5-pro / gemini-2.5-flash …',
    defaultModel: '',
    timeoutMin: 15,
    modes: [
      { id: 'auto', args: ['-y'] },
      { id: 'default', args: [] }
    ],
    noteZh: 'gemini -p 无头模式',
    noteEn: 'gemini headless mode',
    buildSpawn(task, shim, modeArgs) {
      if (!shim) return { error: 'NOT_FOUND' };
      const args = [...shim.prefix, '-p', task.prompt, ...modeArgs];
      if (task.model) args.push('-m', task.model);
      return { file: shim.file, args, env: shim.env };
    }
  },
  {
    id: 'qoderclicn',
    name: 'Qoder CLI',
    color: '#ff7a45',
    command: 'qoderclicn',
    modelSupport: true,
    modelHint: '留空用其默认模型',
    defaultModel: '',
    timeoutMin: 15,
    modes: [
      { id: 'bypass', args: ['--permission-mode', 'bypass_permissions'] },
      { id: 'default', args: [] }
    ],
    noteZh: 'qoderclicn -p；bypass 模式下仅在群工作区运行',
    noteEn: 'qoderclicn -p; bypass mode runs inside the group workspace only',
    buildSpawn(task, shim, modeArgs) {
      if (!shim) return { error: 'NOT_FOUND' };
      const args = [...shim.prefix, '-p', task.prompt, ...modeArgs];
      if (task.model) args.push('-m', task.model);
      return { file: shim.file, args, env: shim.env };
    }
  },
  {
    id: 'cline',
    name: 'Cline',
    color: '#2f80ed',
    command: 'cline',
    detectCommand: 'npx',
    modelSupport: true,
    defaultModel: 'cline-free/deepseek-v4.1-flash',
    modelHint: 'cline-free/deepseek-v4.1-flash / cline-free/gemini-3.8-flash / cline-free/kimi-k3 …',
    timeoutMin: 20,
    modes: [{ id: 'default', args: [] }],
    noteZh: 'cline CLI；cline-free/* 模型零成本',
    noteEn: 'cline CLI; cline-free/* models are free',
    buildSpawn(task, shim) {
      const s = shim || resolveCommand('npx');
      if (!s) return { error: 'NOT_FOUND' };
      const model = task.model || 'cline-free/deepseek-v4.1-flash';
      return { file: s.file, args: [...s.prefix, task.command || 'cline', task.prompt, '-m', model], env: s.env };
    }
  },
  {
    id: 'hermes',
    name: 'Hermes',
    color: '#e6a23c',
    command: 'hermes',
    modelSupport: true,
    modelHint: '留空用其默认模型，或填 -m 支持的名字',
    defaultModel: '',
    timeoutMin: 15,
    modes: [
      { id: 'yolo', args: ['--yolo'] },
      { id: 'default', args: [] }
    ],
    noteZh: 'hermes -z 无头模式',
    noteEn: 'hermes headless mode',
    buildSpawn(task, shim, modeArgs) {
      if (!shim) return { error: 'NOT_FOUND' };
      const args = [...shim.prefix, '-z', task.prompt, ...modeArgs];
      if (task.model) args.push('-m', task.model);
      return { file: shim.file, args, env: shim.env };
    }
  },
  {
    id: 'minimax',
    name: 'MiniMax Code',
    color: '#c23531',
    command: 'minimax',
    modelSupport: true,
    defaultModel: 'MiniMax-M3.1-Flash-Preview',
    modelHint: 'MiniMax-M3.1-Flash-Preview / MiniMax-M3 / MiniMax-M2.7-highspeed',
    timeoutMin: 15,
    modes: [{ id: 'default', args: [] }],
    noteZh: '【实验】官方 CLI 的无头通道依赖 MiniMax 内部 auth-broker，当前版本可能不可用',
    noteEn: '[experimental] headless path depends on MiniMax internal auth broker; may not work',
    buildSpawn(task, shim) {
      if (!shim) return { error: 'NOT_FOUND' };
      const args = [...shim.prefix, '-p', task.prompt, '--no-session', '--mode', 'text'];
      if (task.model) args.push('--model', task.model);
      return { file: shim.file, args, env: shim.env };
    }
  }
];

// ---------- 自定义成员（命令模板） ----------
// config.json 里的 membersCustom 数组：
//   { id, name, color, program, argsTemplate: ['exec','--cwd','{{cwd}}','{{prompt}}'],
//     modelSupport, defaultModel, timeoutMin }
// 模板规则：{{prompt}}/{{model}}/{{cwd}} 整参数替换；模型为空时含 {{model}} 的参数整体移除；
// argsTemplate 里没有 {{prompt}} 时 prompt 自动追加到末尾。program 支持 PATH 名或绝对路径。
function buildCustomSpawn(cm, task, resolveCmd) {
  const shim = resolveCmd(cm.program);
  if (!shim) return { error: 'NOT_FOUND' };
  let args = (cm.argsTemplate || []).map(a => {
    if (a === '{{model}}' && !task.model) return null;
    return a.replace('{{model}}', task.model || '')
            .replace('{{prompt}}', task.prompt)
            .replace('{{cwd}}', task.cwd);
  }).filter(a => a !== null);
  if (!cm.argsTemplate || !cm.argsTemplate.includes('{{prompt}}')) args.push(task.prompt);
  return { file: shim.file, args: [...shim.prefix, ...args], env: shim.env };
}

// ---------- 模型列表发现 ----------
// 原则：只读各 harness 自己配置里的"模型名"，绝不读取/输出任何密钥；
// 读不到就返回空数组，UI 回退为自由输入。
function listZcodeModels() {
  // ~/.zcode/v2/provider_config.json：providerRules[].config.modelOrder/personalModelIds
  // 订阅渠道（zai-start-plan）和自建网关渠道（如 NewAPI）的模型都在这里
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json'), 'utf8'));
    const rules = (j.config && j.config.providerConfigRules && j.config.providerConfigRules.providerRules) || [];
    const models = [];
    for (const r of rules) {
      if (r.enabled === false) continue;
      const cfg = r.config || {};
      for (const m of (cfg.modelOrder || cfg.personalModelIds || [])) {
        if (m && !models.includes(m)) models.push(m);
      }
    }
    return models;
  } catch (e) { return []; }
}

function listCodexModels() {
  // ~/.codex/config.toml 顶层 model = "..."（留空时 codex 即用此默认）
  try {
    const cfg = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    const m = cfg.match(/^model\s*=\s*"([^"]+)"/m);
    return m ? [m[1]] : [];
  } catch (e) { return []; }
}

function listMinimaxModels() {
  // ~/.minimax/config.yaml whitelist 列表
  try {
    const cfg = fs.readFileSync(path.join(os.homedir(), '.minimax', 'config.yaml'), 'utf8');
    const lines = cfg.split(/\r?\n/);
    const idx = lines.findIndex(l => /^\s*whitelist:\s*$/.test(l));
    if (idx < 0) return [];
    const models = [];
    for (let i = idx + 1; i < lines.length; i++) {
      const m = lines[i].match(/^\s+-\s*(\S+)/);
      if (!m) break;
      models.push(m[1].replace(/['"]/g, ''));
    }
    return models;
  } catch (e) { return []; }
}

const STATIC_MODELS = {
  claude: ['sonnet', 'opus', 'haiku'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  cline: ['cline-free/deepseek-v4.1-flash', 'cline-free/gemini-3.8-flash', 'cline-free/mimo-v2.6-flash', 'cline-free/kimi-k3']
};

function listModels(member) {
  if (!member || member.custom) return { source: 'manual', models: [] };
  switch (member.id) {
    case 'zcode': return { source: "config: ~/.zcode/v2/provider_config.json", models: listZcodeModels() };
    case 'codex': return { source: 'config: ~/.codex/config.toml', models: listCodexModels() };
    case 'minimax': return { source: 'config: ~/.minimax/config.yaml', models: listMinimaxModels() };
    default: return { source: 'static', models: STATIC_MODELS[member.id] || [] };
  }
}

module.exports = { MEMBERS, buildCustomSpawn, resolveCommand, resolveMemberProgram, findNode, listModels };
