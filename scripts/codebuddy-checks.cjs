// CodeBuddy（cbc / WorkBuddy 自带无头 CLI）成员的断言（跑法：node scripts/codebuddy-checks.cjs）
//
// 为什么先写这些：我把 cbc 判死过一次（"MODULE_NOT_FOUND，跑不起来"），
// 真实原因是两个我实测出来的开关没给对——lite-wb 产物入口 和 代理环境变量。
// 这两条如果不焊进断言，下一个人（或下一个我）还会再判死一次。
//
// 纪律沿用：modes[0] 不许带绕过 flag；不读别家存的密钥；失败要能分清是谁的锅。

const fs = require('fs');
const os = require('os');
const path = require('path');

const fails = [];
const oks = [];
function check(name, pass, detail) {
  (pass ? oks : fails).push(pass ? name : `${name}${detail ? ' — ' + detail : ''}`);
}

const adapters = require('../src/server/adapters');
const { MEMBERS, resolveMemberProgram, findCodebuddyCli, nodeRunner } = adapters;

// ---------- 1. 成员在册 ----------
const cbc = MEMBERS.find(m => m.id === 'codebuddy');
check('成员表里有 CodeBuddy（cbc）', !!cbc, cbc ? '' : 'MEMBERS 里没有 id=codebuddy');
check('显示名是可认的中文名而不是文件路径', cbc && /CodeBuddy|WorkBuddy/.test(cbc.name), cbc && cbc.name);

// ---------- 2. 默认档不带绕过 flag ----------
const BYPASS = /-y$|dangerously-skip|bypassPermissions|bypass_permissions|--yolo/i;
check('modes[0] 不带任何绕过 flag', cbc && !cbc.modes[0].args.some(a => BYPASS.test(a)), cbc && JSON.stringify(cbc.modes[0].args));
check('带绕过 flag 的那一档打了 bypass 标记', cbc && cbc.modes.every(m => !m.args.some(a => BYPASS.test(a)) || m.bypass === true), cbc && JSON.stringify(cbc.modes.map(m => [m.id, m.bypass])));

// ---------- 3. 入口探测：真实安装布局才认 ----------
function fakeTree(rel) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-cbc-'));
  const bin = path.join(root, ...rel.split('/'));
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codebuddy'), '#!/usr/bin/env node\n');
  fs.mkdirSync(path.join(bin, '..', 'dist', 'lazy-lite-wb'), { recursive: true });
  fs.writeFileSync(path.join(bin, '..', 'dist', 'codebuddy-lite-wb.mjs'), 'export {};\n');
  return root;
}
const goodRoot = fakeTree('resources/app.asar.unpacked/cli/bin');
const cliPath = path.join(goodRoot, 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy');
check('有 lite-wb 产物时能认出 CLI 入口', findCodebuddyCli({ roots: [goodRoot] }) === cliPath, findCodebuddyCli({ roots: [goodRoot] }));
check('lite-wb 产物缺失时不认（避免又跑一次 MODULE_NOT_FOUND）',
  (() => { const r = fakeTree('resources/app.asar.unpacked/cli/bin'); fs.unlinkSync(path.join(r, 'resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-lite-wb.mjs')); return findCodebuddyCli({ roots: [r] }) === null; })());
check('完全没装 WorkBuddy 时返回 null 而不是抛', findCodebuddyCli({ roots: [path.join(os.tmpdir(), 'hc-cbc-nope-' + Date.now())] }) === null);

// ---------- 4. 派单参数：走 lite-wb 入口 + 显式模型 + 不给绕过 ----------
const shim = { file: process.execPath, prefix: [cliPath], env: {} };
const task = { prompt: '把 README 的第一段改成两句', cwd: goodRoot, model: '' };
const sp = cbc && cbc.buildSpawn ? cbc.buildSpawn(task, shim, cbc.modes[0].args) : { error: 'NO_BUILD' };
check('没 shim 时报 NOT_FOUND（而不是抛异常）', cbc.buildSpawn(task, null, []) .error === 'NOT_FOUND');
check('argv 里没有 shell 拼接：prompt 独占一个 token', Array.isArray(sp.args) && sp.args.includes(task.prompt), JSON.stringify(sp.args));
check('带 -p 无头一次性输出', sp.args && sp.args.includes('-p'));
check('输出格式显式给 text', sp.args && sp.args.includes('--output-format') && sp.args[sp.args.indexOf('--output-format') + 1] === 'text');
check('默认档用的是它自己公开列出的免费模型', sp.args && sp.args[sp.args.indexOf('--model') + 1] === 'custom-local:deepseek-v4-flash-free', JSON.stringify(sp.args && sp.args.slice(sp.args.indexOf('--model'), sp.args.indexOf('--model') + 2)));
check('指定模型时听指定的（不写死免费档）', /--model[\s\S]*kimi-k3/.test(JSON.stringify(cbc.buildSpawn({ ...task, model: 'custom-local:kimi-k3' }, shim, cbc.modes[0].args).args)));
check('argv 里没有任何绕过 flag', !sp.args.some(a => BYPASS.test(a)), JSON.stringify(sp.args));

// ---------- 5. 环境：lite-wb 开关 + 代理必须摘掉（实测原因） ----------
check('注入了 lite-wb 产物开关', sp.env && sp.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE === '1', JSON.stringify(sp.env));
check('注入了剔掉代理 env 的信号（代理会让它的 setProxy 抛 TypeError 并误报未登录）',
  sp.env && sp.env.HTTP_PROXY === null && sp.env.http_proxy === null && sp.env.ALL_PROXY === null, JSON.stringify(sp.env));

// ---------- 6. childEnv 支持"置 null = 删掉这个变量" ----------
const { childEnv } = require('../src/server/server');
process.env.HTTP_PROXY = 'http://127.0.0.1:10808';
process.env.NO_PROXY = 'localhost';
const out = childEnv({ HTTP_PROXY: null, CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1' }, []);
check('适配器把变量置 null 时子环境里它必须消失', !('HTTP_PROXY' in out), JSON.stringify(Object.keys(out)));
check('白名单里别的代理变量不受影响（只删点名的那个）', out.NO_PROXY === 'localhost', JSON.stringify(out.NO_PROXY));
check('置 null 不影响正常注入字符串变量', out.CODEBUDDY_FORCE_LITE_WB_BUNDLE === '1');

// ---------- 7. 凭证守卫：它自己的家目录算"自家的" ----------
const guard = require('../src/server/guard');
check('读自己 ~/.codebuddy 下的登录文件不算外泄', (() => { try { guard.assertNoForeignCredentials('codebuddy', { args: ['--settings', path.join(os.homedir(), '.codebuddy', 'auth.json')], env: {} }); return true; } catch (e) { return false; } })());
check('读 WorkBuddy 桌面端存的 connector-keys 要拦（不翻别家密钥）', (() => { try { guard.assertNoForeignCredentials('codebuddy', { args: [path.join(os.homedir(), '.workbuddy', 'app', 'connector-keys', 'x.key')], env: {} }); return false; } catch (e) { return /凭证|credential/i.test(e.message); } })());
check('读 gh 的凭据一样要拦', (() => { try { guard.assertNoForeignCredentials('codebuddy', { args: ['C:\\Users\\x\\.config\\gh\\hosts.yml'], env: {} }); return false; } catch (e) { return true; } })());

// ---------- 8. 版本可辨识（发版前后行为对得上） ----------
check('成员说明里写清了"未登录时会回 Authentication required"这一步归谁', cbc && /登录/.test(cbc.noteZh || ''), cbc && cbc.noteZh);

// ---------- 结果 ----------
console.log(`\ncbc 成员断言：${oks.length} 通过 / ${fails.length} 失败`);
for (const f of fails) console.log('  FAIL ' + f);
if (fails.length) { console.log('CODEBUDDY_CHECKS_FAILED'); process.exit(1); }
console.log('ALL_CODEBUDDY_CHECKS_OK');
