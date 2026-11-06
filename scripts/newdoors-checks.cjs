// 新门（DeepSeek Harness 的 dsh headless / QwenWork 内嵌的 Qwen Code）的断言
// 跑法：node scripts/newdoors-checks.cjs
//
// 为什么先写这些：这两家是我扫完 17 个 harness 后**实测到确实有无头入口**的，
// 其余（Trae/Antigravity 的 chat 只开窗口不回 stdout、Doubao 无 CLI、OpenCode 只装了桌面版、
// AutoClaw 本体已不在机器上、SkillClaw/TDAI 是代理/记忆层不是可派单模型）不该被塞进群。
// 边界照旧：只用那家自己的 CLI + 它自己的登录，不翻它存的密钥。

const fs = require('fs');
const os = require('os');
const path = require('path');

const fails = [];
const oks = [];
const check = (name, pass, detail) => { (pass ? oks : fails).push(pass ? name : `${name}${detail ? ' — ' + detail : ''}`); };

const adapters = require('../src/server/adapters');
const { MEMBERS, nodeRunner } = adapters;
const parseCmdShim = adapters.parseCmdShim || (() => null);
const findQwenCodeCli = adapters.findQwenCodeCli || (() => null);
const usage = require('../src/server/usage');
const guard = require('../src/server/guard');

const BYPASS = /-y$|--yolo|dangerously-skip|bypassPermissions|bypass_permissions|--yolo=true/i;

// ---------- 1. 两门在册 ----------
const dsh = MEMBERS.find(m => m.id === 'dsh');
const qwen = MEMBERS.find(m => m.id === 'qwenwork');
check('DeepSeek Harness（dsh）进了成员表', !!dsh);
check('QwenWork（阿里办公，内嵌 Qwen Code）进了成员表', !!qwen);
check('两门的默认档都不带绕过 flag', dsh && qwen && !dsh.modes[0].args.some(a => BYPASS.test(a)) && !qwen.modes[0].args.some(a => BYPASS.test(a)),
  JSON.stringify([dsh && dsh.modes[0].args, qwen && qwen.modes[0].args]));
check('绕过档（如果有）都打了 bypass 标记', [dsh, qwen].every(m => !m || m.modes.every(x => !x.args.some(a => BYPASS.test(a)) || x.bypass === true)));

// ---------- 2. dsh 的 .cmd 垫片要能拆开（它不是 npm 模板） ----------
// 真实形状："%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\...\cli.js" %*
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-dsh-'));
const binDir = path.join(tmp, 'resources', 'runtime', 'cli', 'bin');
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(tmp, 'DeepSeek Harness.exe'), 'x');
const asarJs = path.join(tmp, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
fs.mkdirSync(path.dirname(asarJs), { recursive: true });
fs.writeFileSync(asarJs, '//');
fs.writeFileSync(path.join(binDir, 'dsh.cmd'),
  '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*\r\nexit /b %errorlevel%\r\n');
const shim = parseCmdShim(path.join(binDir, 'dsh.cmd'), binDir);
check('能拆开 dsh 这种"exe + 前置 flag + asar 内 js + %*"的垫片', shim && /DeepSeek Harness\.exe$/.test(shim.file), shim && JSON.stringify(shim));
check('拆出来的入口顺序是 exe → --expose-internals → cli.js（prompt 只能排在后面）', shim && shim.prefix[0] === '--expose-internals' && /cli\.js$/.test(shim.prefix[1]), shim && JSON.stringify(shim && shim.prefix));
check('垫片里 set 的 ELECTRON_RUN_AS_NODE 要跟着带出来', shim && shim.env && shim.env.ELECTRON_RUN_AS_NODE === '1', shim && JSON.stringify(shim && shim.env));

// ---------- 3. 两门的派单 argv ----------
const fakeShim = shim ? { file: shim.file, prefix: shim.prefix, env: shim.env } : { file: 'x', prefix: [], env: {} };
const dtask = { prompt: '把这一单跑完', cwd: tmp, model: '' };
const dsp = dsh && dsh.buildSpawn(dtask, fakeShim, dsh.modes[0].args);
check('dsh 走 headless 一次性问答（答案进 stdout）', dsp && dsp.args.includes('headless'), JSON.stringify(dsp && dsp.args));
check('dsh 的 prompt 是单个 argv（不拼 shell、不走 stdin）', dsp && dsp.args.includes(dtask.prompt), JSON.stringify(dsp && dsp.args));
check('dsh 没有绕过 flag', dsp && !dsp.args.some(a => BYPASS.test(a)), JSON.stringify(dsp && dsp.args));
check('dsh 只有 headless 一档（它 CLI 里没有审批开关，不许凭空造绕过档）', dsh && dsh.modes.length === 1, dsh && JSON.stringify(dsh.modes.map(x => x.id)));
check('dsh 默认不混进 --json（那是输出格式，不是权限模式）', dsp && !dsp.args.includes('--json'));

const qwCli = path.join(tmp, 'qwencode', 'runtime', 'qwen-code', 'cli.js');
// 测试自己造一个"由内置 Node 跑 cli.js"的形状，不去借生产里的私有函数
const qshim = { file: process.execPath, prefix: [qwCli], env: {} };
const qtask = { prompt: '把这一单跑完', cwd: tmp, model: '' };
const qsp = qwen && qwen.buildSpawn(qtask, qshim, qwen.modes[0].args);
check('Qwen Code 用 --approval-mode 的保守档（default/plan），不是 yolo', qsp && qsp.args.includes('--approval-mode') && qsp.args[qsp.args.indexOf('--approval-mode') + 1] === 'default', JSON.stringify(qsp && qsp.args));
check('Qwen Code 输出显式 text', qsp && qsp.args.includes('-o') && qsp.args[qsp.args.indexOf('-o') + 1] === 'text', JSON.stringify(qsp && qsp.args));
check('Qwen Code 必须带 wall-clock 上限（无人值守不许无限跑）', qsp && qsp.args.includes('--max-wall-time') && Number(qsp.args[qsp.args.indexOf('--max-wall-time') + 1]) > 0, JSON.stringify(qsp && qsp.args));
check('Qwen Code 的 prompt 单独成 token', qsp && qsp.args.includes(qtask.prompt));

// ---------- 4. QwenWork 的入口要按版本目录取最新（它会随应用升级换号） ----------
function fakeQwenRoot(withCli) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-qw-'));
  const comp = path.join(root, 'resources', 'agent-sdk', 'components', 'qwencode');
  for (const v of ['0.0.1-26101501', '0.0.2-26110301']) {
    const dir = path.join(comp, v, 'runtime', 'qwen-code');
    fs.mkdirSync(dir, { recursive: true });
    if (withCli || v !== '0.0.2-26110301') fs.writeFileSync(path.join(dir, 'cli.js'), '//');
  }
  fs.writeFileSync(path.join(root, 'QwenWorkCN.exe'), 'x');
  return root;
}
const qr = fakeQwenRoot(true);
const found = findQwenCodeCli({ roots: [qr] });
check('能定位 QwenWork 里那份 qwen-code/cli.js', found && /cli\.js$/.test(found), found);
check('版本目录多个时取最新那份（不是取第一个）', found && found.includes(path.join('0.0.2-26110301', 'runtime')), found);
const qr2 = fakeQwenRoot(false);
check('新版没落地 cli.js 时回落到有的那版而不是返回 null', !!findQwenCodeCli({ roots: [qr2] }));
check('完全没装 QwenWork 时返回 null', findQwenCodeCli({ roots: [path.join(os.tmpdir(), 'hc-qw-nope-' + Date.now())] }) === null);

// ---------- 5. 鉴权类缺口的分类要落对（都是这两家实测撞出来的原话） ----------
check('dsh 的 MISSING_CREDENTIAL 归鉴权层', usage.classifyError({ status: 'error', output: '{"type":"final","text":""}\ndsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; export DEEPSEEK_API_KEY in the launching environment' }) === 'auth');
check('Qwen Code 的 No auth type is selected 归鉴权层', usage.classifyError({ status: 'error', output: 'No auth type is selected. Please configure an auth type (e.g. via settings or `--auth-type`) before running in non-interactive mode.' }) === 'auth');
check('这两种都不进冷却（缺 key 不会自己长出来）', (() => {
  usage.init(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-nd-')));
  usage.record({ memberId: 'dsh', model: '', status: 'error', ms: 1000, output: 'dsh: MISSING_CREDENTIAL: no API key for provider route' , at: Date.now() });
  usage.record({ memberId: 'qwenwork', model: '', status: 'error', ms: 1000, output: 'No auth type is selected. Please configure an auth type' , at: Date.now() });
  return usage.isBlocked('dsh', '', Date.now() + 60000).blocked === false && usage.isBlocked('qwenwork', '', Date.now() + 60000).blocked === false;
})());

// ---------- 6. 凭证守卫：自家目录认自家 ----------
check('dsh 的自家是 .dsh', guard.OWN_HOME.dsh && guard.OWN_HOME.dsh.includes('.dsh'), JSON.stringify(guard.OWN_HOME.dsh));
check('QwenWork 这门的自家只有 .qwen（Qwen Code 自己的家），不含应用目录 .qwenworkcn',
  guard.OWN_HOME.qwenwork && guard.OWN_HOME.qwenwork.length === 1 && guard.OWN_HOME.qwenwork[0] === '.qwen', JSON.stringify(guard.OWN_HOME.qwenwork));
check('指到 QwenWork 存的 engine-maas-key.dat 要拦下（那是应用自己的凭据，不是我们可以传的）', (() => {
  try { guard.assertNoForeignCredentials('qwenwork', { args: [path.join(os.homedir(), '.qwenworkcn', 'engine-maas-key.dat')], env: {} }); return false; }
  catch (e) { return /凭证|credential/i.test(e.message); }
})());
check('文件名里带 key 的数据文件（*.dat/*.bin）也算凭据形状',
  guard.CRED_SHAPED.test('C:\\Users\\x\\.app\\engine-maas-key.dat') && guard.CRED_SHAPED.test('/home/x/.app/master-key.bin'),
  String(guard.CRED_SHAPED));
check('但普通的 .dat 数据文件不误伤（不是所有数据都是凭据）',
  !guard.CRED_SHAPED.test('C:\\Users\\x\\.app\\cache-index.dat') && !guard.CRED_SHAPED.test('C:\\Users\\x\\.app\\sessions.dat'));

// ---------- 7. 成员说明必须把"缺什么"写清楚（不能让人以为已经通了） ----------
check('dsh 的说明写清缺 DEEPSEEK_API_KEY 以及两种补法', dsh && /DEEPSEEK_API_KEY/.test(dsh.noteZh || ''), dsh && dsh.noteZh);
check('QwenWork 的说明写清它自己的登录不等于 Qwen Code 的 auth', qwen && /auth/i.test(qwen.noteZh || '') && /登录/.test(qwen.noteZh || ''), qwen && qwen.noteZh);

console.log(`\n新门断言：${oks.length} 通过 / ${fails.length} 失败`);
for (const f of fails) console.log('  FAIL ' + f);
if (fails.length) { console.log('NEWDOORS_CHECKS_FAILED'); process.exit(1); }
console.log('ALL_NEWDOORS_CHECKS_OK');
