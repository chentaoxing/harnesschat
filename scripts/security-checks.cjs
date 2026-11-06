// 派单安全护栏的回归检查（跑法：node scripts/security-checks.cjs）
//
// 为什么要有这个文件：这些性质一旦靠"记得这么做"维持，迟早会在某次加成员时破掉。
// 社区里同类桥接工具的通病就是把绕过审批的 flag 焊死在默认 argv 里，
// 所以这里把它变成断言：任何 bypass flag 出现在某个成员的默认模式里，直接失败。
//
// 退出码 0 = 全部通过；非 0 = 有破口，别发版。

const path = require('path');
const { MEMBERS } = require('../src/server/adapters');
const { childEnv, ENV_KEEP } = require('../src/server/server');

// 各家 CLI 里"跳过审批/沙箱"的 flag 黑名单
const BYPASS_FLAGS = [
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--permission-mode', // 配合下面的取值判断：只有 bypass 类取值才算绕过
  '--yolo',
  '-y',
  '--mode', // zcode：--mode yolo 才是绕过
  'bypass_permissions',
  'bypassPermissions'
];
const BYPASS_MODE_VALUES = ['yolo', 'bypass_permissions', 'bypassPermissions', 'dontAsk'];

const fails = [];
const oks = [];
function check(name, pass, detail) {
  (pass ? oks : fails).push(pass ? `${name}` : `${name}${detail ? ' — ' + detail : ''}`);
}

// ---------- 1. 每个成员的默认模式不得携带绕过 flag ----------
for (const m of MEMBERS) {
  const modes = m.modes || [];
  const def = modes[0];
  if (!def) { check(`${m.id} 有默认模式`, false, 'modes 为空'); continue; }
  const args = def.args || [];
  const offenders = args.filter((a, i) => {
    if (a === '--yolo' || a === '-y' || a === '--dangerously-skip-permissions' || a === '--dangerously-bypass-approvals-and-sandbox') return true;
    if (a === '--permission-mode' || a === '--mode') return BYPASS_MODE_VALUES.includes(args[i + 1]);
    return BYPASS_MODE_VALUES.includes(a);
  });
  check(`${m.id} 默认模式(${def.id})不绕过审批`, offenders.length === 0 && def.bypass !== true,
    offenders.length ? 'argv 含 ' + JSON.stringify(offenders) : (def.bypass ? '标了 bypass' : ''));
  // 绕过档必须存在且排在后面（用户自己开），不能消失
  check(`${m.id} 仍提供可选的绕过档`, modes.some(x => x.bypass === true) || modes.length === 1);
}

// ---------- 2. 子进程环境：默认丢弃，密钥形状一律不外泄 ----------
const FAKE_SECRETS = {
  ANTHROPIC_API_KEY: 'sk-ant-leak',
  OPENAI_API_KEY: 'sk-leak',
  GH_TOKEN: 'gho_leak',
  GITHUB_TOKEN: 'gho_leak',
  AWS_SECRET_ACCESS_KEY: 'leak',
  MINIMAX_API_KEY: 'leak',
  CUSTOM_SERVICE_TOKEN: 'leak',
  DATABASE_PASSWORD: 'leak'
};
const before = { ...process.env };
for (const [k, v] of Object.entries(FAKE_SECRETS)) process.env[k] = v;
process.env.PATH = process.env.PATH || 'C:\\Windows\\system32';
// 代理与"非白名单变量"各造一个，用来验它们各自的命运
process.env.HTTPS_PROXY = 'http://127.0.0.1:10808';
process.env.SOME_TOOL_NOT_ON_THE_LIST = 'should-be-dropped';
process.env.EXTRA_KEPT = 'yes-from-extra';

const env = childEnv({ FOO_FROM_ADAPTER: '1' }, ['EXTRA_KEPT']);

const gotKeys = new Set(Object.keys(env).map(k => k.toUpperCase()));
const got = (n) => gotKeys.has(n.toUpperCase());
for (const k of Object.keys(FAKE_SECRETS)) {
  check(`密钥类变量不进子进程：${k}`, !gotKeys.has(k.toUpperCase()));
}
for (const need of ['PATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) {
  check(`CLI 起跑必需变量保留：${need}`, got(need));
}
check('代理变量保留（本机联网必需）', got('HTTPS_PROXY'));
check('不在白名单里的变量默认被丢弃', !got('SOME_TOOL_NOT_ON_THE_LIST'));
check('envExtra 显式点名的变量被放行', got('EXTRA_KEPT'));
check('适配器注入的变量优先级最高', env.FOO_FROM_ADAPTER === '1');
check('白名单里没有密钥形状的名字', !ENV_KEEP.some(n => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(n)));

// ---------- 3. safe-spawn 的结构性保证 ----------
const { safeExec } = require('../src/server/safe-spawn');
let shellRejected = false;
try { safeExec('node', ['-e', '1'], { shell: true }); } catch (e) { shellRejected = /禁止 shell/.test(String(e.message)); }
check('safeExec 拒绝 shell 模式', shellRejected);
let argvRejected = false;
try { safeExec('node', ['ok', 123], {}); } catch (e) { argvRejected = true; }
check('safeExec 拒绝非字符串 argv', argvRejected);

// ---------- 4. 别家凭证路径不得进入 spawn ----------
// 规则来自这次调研的边界：只用"那家自己的 CLI + 那家自己的登录"，绝不读别家存的凭据。
// 所以守卫要拦的是：形如路径的字符串里出现了别家的凭证文件位置。
const { assertNoForeignCredentials } = require('../src/server/guard');
const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };

check('env 里出现别家凭证路径被拦', throws(() => assertNoForeignCredentials('cline',
  { args: [], env: { OPENAI_AUTH: 'C:\\Users\\x\\.codex\\auth.json' } })));
check('argv 里出现别家凭证路径被拦', throws(() => assertNoForeignCredentials('zcode',
  { args: ['--settings', 'C:\\Users\\x\\.workbuddy\\app\\connector-keys\\a.key'], env: {} })));
check('成员用自家的 provider 配置不被误伤', !throws(() => assertNoForeignCredentials('zcode',
  { args: [], env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: 'C:\\Users\\x\\.zcode\\v2\\runtime\\provider\\windows-x86_64\\3.14.3\\endpoint-abc\\zcode-builtin.json', ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: 'C:\\Users\\x\\.zcode\\v2\\provider_config.json' } })));
check('普通 prompt 文本里带 auth.json 字样不误伤', !throws(() => assertNoForeignCredentials('codex',
  { args: ['-p', '帮我把 auth.json 的读取逻辑改掉'], env: {} })));
check('自定义成员同样受保护', throws(() => assertNoForeignCredentials('mytool',
  { args: ['--config', '/home/x/.claude/credentials.json'], env: {} })));
check('群工作区路径不被误伤', !throws(() => assertNoForeignCredentials('codex',
  { args: ['exec', '--cwd', 'C:\\Users\\x\\HarnessChat工作区'], env: {} })));
check('成员引用自家的 auth.json 不被误伤', !throws(() => assertNoForeignCredentials('codex',
  { args: ['--config', 'C:\\Users\\x\\.codex\\auth.json'], env: {} })));

// ---------- 结果 ----------
console.log(`\n通过 ${oks.length} 项：`);
for (const o of oks) console.log('  ✓ ' + o);
if (fails.length) {
  console.log(`\n失败 ${fails.length} 项：`);
  for (const f of fails) console.log('  ✗ ' + f);
  console.log('\nSECURITY_CHECKS_FAILED');
  process.exit(1);
}
console.log('\nALL_SECURITY_CHECKS_OK');
