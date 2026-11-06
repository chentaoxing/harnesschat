// 交付闭环（②）的断言。跑法：node scripts/delivery-checks.cjs
//
// 为什么要这一块：卡片现在只回答"跑完了、退出码是什么、它自己说了什么"。
// 你要验收还得把整段输出读完，或者自己去看目录——"这一段我能不能不管了"就卡在这。
// 所以交付结论必须是**我们自己称出来的证据**，不是成员自述：文件加了几个、改了哪几个、
// git 层面动没动，都从盘上算。成员说"我已经创建好了"一律不算数。
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const fails = [];
const oks = [];
const check = (name, pass, detail) => { (pass ? oks : fails).push(pass ? name : `${name}${detail ? ' — ' + detail : ''}`); };

const delivery = require('../src/server/delivery');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hc-deliv-'));

// ---------- 1. 目录快照与差异：逐文件称，不听自述 ----------
let dir = tmp();
fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
fs.writeFileSync(path.join(dir, 'b.md'), 'two\n');
let before = delivery.snapshotDir(dir);
fs.writeFileSync(path.join(dir, 'b.md'), 'two changed\n');
fs.writeFileSync(path.join(dir, 'c.txt'), 'brand new\n');
let after = delivery.snapshotDir(dir);
let d = delivery.diff(before, after);
check('新建的文件进 added', d.added.length === 1 && d.added[0].path === 'c.txt', JSON.stringify(d.added));
check('改过的文件进 modified', d.modified.length === 1 && d.modified[0].path === 'b.md', JSON.stringify(d.modified));
check('没动过的文件不出现在任何一栏', !JSON.stringify(d).includes('a.txt'), JSON.stringify(d));
fs.unlinkSync(path.join(dir, 'c.txt'));
d = delivery.diff(after, delivery.snapshotDir(dir));
check('删掉的进 deleted', d.deleted.length === 1 && d.deleted[0].path === 'c.txt', JSON.stringify(d.deleted));
check('差异条目带大小（能看出是真写了内容还是空文件）', typeof (d.deleted[0] || {}).size === 'number', JSON.stringify(d.deleted[0]));

// ---------- 2. 大目录不许把主进程拖死 ----------
dir = tmp();
for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, 'f' + i + '.txt'), 'x'.repeat(50));
let big = delivery.snapshotDir(dir, { maxFiles: 10 });
check('超过文件上限时报 truncated（给的数只能是"至少"）', big.truncated === true && big.files.length <= 10, JSON.stringify({ n: big.files.length, tr: big.truncated }));
check('触顶时 diff 结果带 partial 标记，下游要显示"至少 N 个"', (() => {
  const a = delivery.snapshotDir(dir, { maxFiles: 10 });
  fs.writeFileSync(path.join(dir, 'zz-new.txt'), 'y');
  const b = delivery.snapshotDir(dir, { maxFiles: 10 });
  const dd = delivery.diff(a, b);
  return dd.partial === true;
})());

// ---------- 3. .git 与 node_modules 不进文件清单（会淹掉真产出）----------
dir = tmp();
fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
fs.writeFileSync(path.join(dir, 'real.txt'), 'x');
let snap = delivery.snapshotDir(dir);
check('.git 里的东西不算产出', !JSON.stringify(snap.files).includes('HEAD'), JSON.stringify(snap.files.map(f => f.path)));
check('node_modules 不算产出', !JSON.stringify(snap.files).includes('index.js'), JSON.stringify(snap.files.map(f => f.path)));
check('真正的产出照常计数', snap.files.some(f => f.path === 'real.txt'), JSON.stringify(snap.files.map(f => f.path)));

// ---------- 4. 符号链接/junction 不许把扫描拖进无限 recursion ----------
dir = tmp();
fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
const linkPath = path.join(dir, 'self-link');
let made = false;
try { fs.symlinkSync(dir, linkPath, 'junction'); made = true; } catch (e) { made = false; }
if (made) {
  let threw = null;
  const t0 = Date.now();
  try { snap = delivery.snapshotDir(dir); } catch (e) { threw = e; }
  check('目录下有指回自己的 junction 也不炸不递归（1 秒内出结果）', !threw && Date.now() - t0 < 1000, threw && threw.message);
}

// ---------- 5. git 维度：仓库里动没动，用 git 自己说的话 ----------
let gdir = tmp();
let g0 = null;
const hasGit = (() => { try { cp.execFileSync('git', ['--version']); return true; } catch (e) { return false; } })();
if (hasGit) {
  const run = (args) => cp.execFileSync('git', args, { cwd: gdir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'probe@example.com']);
  run(['config', 'user.name', 'probe']);
  fs.writeFileSync(path.join(gdir, 'tracked.md'), 'v1\n');
  run(['add', '-A']);
  run(['commit', '-qm', 'base']);
  g0 = delivery.gitInfo(gdir);
  check('是仓库就能认出来', g0.isRepo === true && !!g0.head, JSON.stringify(g0));
  fs.writeFileSync(path.join(gdir, 'tracked.md'), 'v2 changed\n');
  fs.writeFileSync(path.join(gdir, 'brand-new.txt'), 'untracked\n');
  let g1 = delivery.gitInfo(gdir);
  check('git 层面能说清改了几条', (g1.status || []).length >= 2, JSON.stringify(g1.status));
  check('未跟踪的新文件也要被点名（不能只报 tracked 的）', JSON.stringify(g1.status).includes('brand-new.txt'), JSON.stringify(g1.status));
  let sum = delivery.summarize({ status: 'done', output: '我把文档更新好了，还新建了一个文件。', diff: delivery.diff(delivery.snapshotDir(gdir), delivery.snapshotDir(gdir)), gitBefore: g0, gitAfter: g1 });
  check('结论里同时给出"文件层"和"git 层"两个数', /文件/.test(sum.headline) && /git|提交|未提交/.test(sum.headline), sum.headline);
} else {
  check('git 不在机器上时不假装称过', delivery.gitInfo(gdir).isRepo === false && !!delivery.gitInfo(gdir).error, JSON.stringify(delivery.gitInfo(gdir)));
}

// ---------- 6. 判词：把"只回话没动手"这门单独钉住 ----------
let s = delivery.summarize({ status: 'done', output: '已完成，我创建了三份报告。', diff: { added: [], modified: [], deleted: [] }, partial: false });
check('成员自称做了事但盘上零变化 → 判"只动了嘴"，不许写"有产出"', s.verdict === 'talked_only', JSON.stringify(s));
check('这种结论必须把矛盾点讲明白（它说了什么 vs 盘上没什么）', /自述|它说/.test(s.reason) && /没有.*变化|零变化/.test(s.reason), s.reason);
s = delivery.summarize({ status: 'done', output: 'ok', diff: { added: [{ path: 'out.md', size: 1200 }], modified: [], deleted: [] }, partial: false });
check('盘上真有新文件 → 判"有产出"', s.verdict === 'produced', JSON.stringify(s));
s = delivery.summarize({ status: 'error', output: '401 Invalid token', diff: { added: [], modified: [], deleted: [] } });
check('跑失败了就判 failed，不硬凑产出数', s.verdict === 'failed', JSON.stringify(s));

// ---------- 7. 下一步建议只能说有据可查的话 ----------
s = delivery.summarize({ status: 'done', output: '改好了', diff: { added: [{ path: 'a.md', size: 10 }], modified: [{ path: 'b.md', size: 20 }], deleted: [] }, partial: false });
check('建议里点出真实路径（不许泛泛说"检查一下成果"）', s.next.includes('a.md') && s.next.includes('b.md'), s.next);
if (hasGit) {
  let g2 = delivery.gitInfo(gdir);
  s = delivery.summarize({ status: 'done', output: '改好了', diff: { added: [], modified: [{ path: 'tracked.md', size: 3 }], deleted: [] }, gitBefore: { isRepo: true, head: g0.head, count: (g0.status || []).length }, gitAfter: { isRepo: true, head: g0.head, count: (g2.status || []).length } });
  check('在仓库里有未提交改动时，建议里必须提"没提交"', /未提交|commit/.test(s.next), s.next);
}
s = delivery.summarize({ status: 'done', output: 'ok', diff: { added: [], modified: [], deleted: [] }, partial: false });
check('零产出时不编下一步（给一句"这段其实什么都没发生"就行）', !/建议.*(检查|确认)/.test(s.next) || /没.*(变化|动过)/.test(s.next), s.next);

// ---------- 8. 不许把文件内容抄进结论（隐私与体积）----------
dir = tmp();
fs.writeFileSync(path.join(dir, 'secret-notes.md'), '里面有不想外传的句子\n');
const b2 = delivery.snapshotDir(dir);
fs.appendFileSync(path.join(dir, 'secret-notes.md'), '再加一段\n');
s = delivery.summarize({ status: 'done', output: 'ok', diff: delivery.diff(b2, delivery.snapshotDir(dir)), partial: false });
check('交付结论里只有路径与大小，绝不带文件正文', !JSON.stringify(s).includes('不想外传'), JSON.stringify(s).slice(0, 200));
check('改过的文件列在 artifacts 里（你能直接点开那个路径）', JSON.stringify(s.artifacts).includes('secret-notes.md'), JSON.stringify(s.artifacts));

// ---------- 9. 体检探针不该产生交付结论（它是只读的）----------
check('quiet 探针不附交付结论（否则每天 11 条"零产出"噪音）', delivery.shouldAttach({ quiet: true }) === false);
check('真派单要附结论', delivery.shouldAttach({ quiet: false, taskKind: 'execute' }) === true);
check('taskKind=health 也不附', delivery.shouldAttach({ quiet: false, taskKind: 'health' }) === false);

// ---------- 10. 真服务端走一遍：动手的成员 vs 只动的嘴的成员 ----------
const { GroupServer } = require('../src/server/server');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function serverWith(members) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-deliv-srv-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-deliv-work-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    workspace: workDir, members: {}, membersCustom: members, firstRunAck: true
  }), 'utf8');
  return { srv: new GroupServer({ dataDir, staticDir: path.join(__dirname, '..', 'src', 'renderer'), port: 18812, token: 'd' }), dataDir, workDir };
}

const WRITER = [{
  id: 'fakewriter', name: '假写手', color: '#999', custom: true, program: process.execPath,
  argsTemplate: ['-e', 'require("fs").writeFileSync("report.md", "内容\\n")', '{{prompt}}'],
  modelSupport: false, timeoutMin: 1
}];
const TALKER = [{
  id: 'faketalker', name: '假嘴炮', color: '#999', custom: true, program: process.execPath,
  argsTemplate: ['-e', 'console.log("我已经把三份报告都创建好了，随时可以验收。")', '{{prompt}}'],
  modelSupport: false, timeoutMin: 1
}];

(async () => {
  const { srv, workDir, dataDir } = serverWith(WRITER.concat(TALKER));
  const t1 = srv.handleSend('@假写手 出一份报告', '出一份报告', 'fakewriter', null, null, null, 'execute').task;
  let waited = 0;
  while (t1.status === 'running' && waited < 20000) { await sleep(300); waited += 300; }
  check('真跑完的单子带交付结论', !!t1.delivery, JSON.stringify(t1.status));
  check('真写了文件的门判"有交付"', t1.delivery && t1.delivery.verdict === 'produced', JSON.stringify(t1.delivery));
  check('交付里点名到那个文件（是盘上称出来的，不是它自述的）', t1.delivery && JSON.stringify(t1.delivery.artifacts).includes('report.md'), JSON.stringify(t1.delivery && t1.delivery.artifacts));
  check('结论里给出工作区路径，你能直接点过去', t1.delivery && t1.delivery.cwd === workDir, t1.delivery && t1.delivery.cwd);
  check('交付正文里绝不带文件内容', !JSON.stringify(t1.delivery).includes('内容'), JSON.stringify(t1.delivery).slice(0, 200));
  check('交付落进转录卡片并标了未提交/路径提示', /report\.md/.test(t1.delivery.next), t1.delivery.next);

  const t2 = srv.handleSend('@假嘴炮 做点事', '做点事', 'faketalker', null, null, null, 'execute').task;
  waited = 0;
  while (t2.status === 'running' && waited < 20000) { await sleep(300); waited += 300; }
  check('自称做完但盘上零变化 → 判"只动了嘴"', t2.delivery && t2.delivery.verdict === 'talked_only', JSON.stringify(t2.delivery));
  check('这种判词必须把矛盾写出来（自述 vs 零变化）', t2.delivery && /自述/.test(t2.delivery.reason) && /零变化/.test(t2.delivery.reason), t2.delivery && t2.delivery.reason);

  // 重启回放：交付结论必须还在
  const { Store } = require('../src/server/store');
  const replayed = new Store(dataDir).loadMessages();
  const card = replayed.find(m => m.type === 'task' && m.id === t1.id);
  check('重启后卡片仍然说得出当时改了哪些文件', !!(card && card.delivery && JSON.stringify(card.delivery.artifacts).includes('report.md')), JSON.stringify(card && card.delivery));
  check('回放不会把交付当成一条独立消息塞进群聊（转录里只有卡片）', replayed.filter(m => m.type === 'task_delivery').length === 0, String(replayed.filter(m => m.type === 'task_delivery').length));

  // ---------- 11. 真机抓到的自造假绿：成员自己的运行时账本不算交付 ----------
// 2026-11-07 实测：让 Qoder CLI 在群工作区建一个文件，它回"需要您授权写入权限才能创建该文件"，
// 目标文件确实没建；但工作区里多了 `.qoder-credits/report.json` 和一个 canvas 文件——
// 那是它自己的运行痕迹。当时我判成了"有交付"，这是我这把尺子造的第二个假绿。
dir = tmp();
fs.mkdirSync(path.join(dir, '.qoder-credits'), { recursive: true });
fs.writeFileSync(path.join(dir, '.qoder-credits', 'report.json'), '{"tokens":123}\n');
fs.writeFileSync(path.join(dir, '.gitignore'), 'ignore me\n');
const beforeDots = delivery.snapshotDir(dir);
fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
fs.writeFileSync(path.join(dir, 'out', 'x.md'), 'real\n');
// 起跑后成员自己往点目录里写运行痕迹：这条必须是"新增"被跳掉，而不是两边都有所以看不见
fs.writeFileSync(path.join(dir, '.qoder-credits', 'late-trace.json'), '{"written_after_start":true}\n');
let dotDiff = delivery.diff(beforeDots, delivery.snapshotDir(dir));
check('成员自己的点目录（.qoder-credits 这类）不计进交付', !JSON.stringify(dotDiff).includes('late-trace') && !JSON.stringify(dotDiff).includes('.qoder-credits'), JSON.stringify(dotDiff));
check('但顶层点文件照常算（.gitignore 就是真产出）', dotDiff.added.some(x => x.path === 'out/x.md') && beforeDots.files.some(f => f.path === '.gitignore'), JSON.stringify(beforeDots.files.map(f => f.path)));

s = delivery.summarize({
  status: 'done',
  output: '5 warnings loading skill configs.\n需要您授权写入权限才能创建该文件。\n',
  diff: { added: [], modified: [], deleted: [] }, partial: false
});
check('它明说"需要授权"且盘上没有真产出 → 判 blocked_by_permission，不是 produced', s.verdict === 'blocked_by_permission', JSON.stringify(s));
check('判词要点名是权限档拦住的，并给出去哪一档开', /权限/.test(s.reason) && /设置|档|mode/.test(s.next), s.reason + ' | ' + s.next);
s = delivery.summarize({
  status: 'done',
  output: '过程中有些操作需要授权，我改用了只读方式，最后写好了 report.md。',
  diff: { added: [{ path: 'report.md', size: 900 }], modified: [], deleted: [] }, partial: false
});
check('盘上真有产出时，正文里出现"授权"二字不误判成被拦', s.verdict === 'produced', JSON.stringify(s));
s = delivery.summarize({ status: 'done', output: 'This error message mentions permission denied in passing.', diff: { added: [], modified: [], deleted: [] }, partial: false });
check('英文散文里顺带提到 permission 不误判（要像一句拒绝，而不是在讲这个词）', s.verdict === 'talked_only', JSON.stringify(s));

console.log(`\n交付闭环断言：${oks.length} 通过 / ${fails.length} 失败`);
  for (const f of fails) console.log('  FAIL ' + f);
  if (fails.length) { console.log('DELIVERY_CHECKS_FAILED'); process.exit(1); }
  console.log('ALL_DELIVERY_CHECKS_OK');
  process.exit(0);
})();
