// 产出落点的集成断言：起真的 GroupServer、走真的 handleSend、拉真的子进程。
// 用法：node scripts/landing-integration.cjs   （退出码 0 = 通过）
//
// 要证明的不是"函数能跑"，而是这条链真的闭合了：
//   派一单只回答的活 → 成员写不了盘 → 工作区里仍然出现一个能打开的文件 →
//   卡片上有落点结论 → 重启回放后还在 → 而且交付判定没有因此谎称成员产出了东西。
const fs = require('fs');
const os = require('os');
const path = require('path');

const { GroupServer } = require('../src/server/server');
const { Store } = require('../src/server/store');
const usage = require('../src/server/usage');
const landing = require('../src/server/landing');

const fails = [];
const oks = [];
const check = (name, pass, detail) => { (pass ? oks : fails).push(pass ? name : `${name}${detail ? ' — ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeServer(members) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-landint-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    workspace: dir, members: {}, membersCustom: members, firstRunAck: true
  }), 'utf8');
  return new GroupServer({ dataDir: dir, staticDir: path.join(__dirname, '..', 'src', 'renderer'), port: 18803, token: 'test-token' });
}

function fake(id, printExpr, extraArgs) {
  return {
    id, name: '假成员 ' + id, color: '#999', custom: true,
    program: process.execPath,
    argsTemplate: (extraArgs || []).concat(['-e', printExpr, '{{prompt}}']),
    modelSupport: false, timeoutMin: 1
  };
}

async function waitTask(task, limitMs) {
  let waited = 0;
  while (task && task.status === 'running' && waited < limitMs) { await sleep(200); waited += 200; }
  return task;
}

(async () => {
  usage.init(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-landint-u-')));

  // ---------- 1. 只回答、不写盘的成员：工作区里仍然要出现文件 ----------
  const answer = '这是方案正文。\n```python calc.py\nprint(42)\n```\n';
  const s1 = makeServer([fake('talker', 'console.log(' + JSON.stringify(answer) + ')')]);
  const r1 = s1.handleSend('@假成员 talker 干活', '给我一个方案', 'talker', null, null, s1.config.workspace, 'execute');
  const t1 = await waitTask(r1 && r1.task, 20000);
  check('假成员跑完成功态', t1 && t1.status === 'done', t1 && `status=${t1.status} text=${JSON.stringify(String(t1.text).slice(0, 80))}`);
  const L1 = t1 && t1.delivery && t1.delivery.landing;
  check('卡片上挂了落点结论', !!L1 && L1.ok === true, JSON.stringify(t1 && t1.delivery));
  check('落点真的写在群工作区里', !!L1 && L1.dir.startsWith(s1.config.workspace), L1 && L1.dir);
  check('落点目录名就是约定的那个', !!L1 && L1.dir.includes(landing.LANDING_DIRNAME), L1 && L1.dir);
  const ansPath = L1 && (L1.files || []).find(f => f.kind === 'answer');
  check('回答文件在盘上且内容与成员输出逐字相等', !!ansPath && fs.existsSync(ansPath.abs) && fs.readFileSync(ansPath.abs, 'utf8') === t1.text, ansPath && JSON.stringify({ abs: ansPath.abs, len: t1.text.length }));
  check('代码块也落成了独立文件', !!L1 && (L1.files || []).some(f => f.name === 'calc.py' && fs.readFileSync(f.abs, 'utf8') === 'print(42)\n'), JSON.stringify(L1 && L1.files));
  check('落点带一句人话说明', typeof (L1 && L1.note) === 'string' && /回答/.test(L1.note), L1 && L1.note);

  // 关键：落点不许把交付判定染绿
  check('成员自己零产出 → 交付判定仍然不是 produced', t1.delivery.verdict !== 'produced', t1.delivery.verdict);
  check('交付称出来的变化数仍然是 0（落点不算成员的产出）', t1.delivery.changed === 0, JSON.stringify({ changed: t1.delivery.changed, arts: t1.delivery.artifacts }));

  // ---------- 2. 落盘与回放：重启后卡片还说得出落点在哪 ----------
  const lines = fs.readFileSync(path.join(s1.dataDir, 'messages.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const dvLine = lines.find(m => m.type === 'task_delivery' && m.taskId === t1.id);
  check('落点随交付结论一起落了盘', !!dvLine && !!dvLine.delivery.landing && dvLine.delivery.landing.ok === true, JSON.stringify(dvLine && Object.keys(dvLine.delivery)));
  const replayed = new Store(s1.dataDir).loadMessages().find(m => m.type === 'task' && m.id === t1.id);
  check('回放后卡片上仍有落点（文件链接不会重启就丢）', !!replayed && !!replayed.delivery && !!replayed.delivery.landing && replayed.delivery.landing.dir === L1.dir, JSON.stringify(replayed && replayed.delivery && replayed.delivery.landing && replayed.delivery.landing.dir));

  // ---------- 3. 并发/后续单不许把上一单的落点当成自己的产出 ----------
  const r1again = s1.handleSend('@假成员 talker 再来', '再答一次', 'talker', null, null, s1.config.workspace, 'execute');
  const t1again = await waitTask(r1again && r1again.task, 20000);
  check('工作区里已有上一单的落点时，新的一单仍称出 0 变化', t1again && t1again.delivery && t1again.delivery.changed === 0, t1again && JSON.stringify(t1again.delivery && { changed: t1again.delivery.changed, arts: t1again.delivery.artifacts }));
  check('两次落点互不覆盖', !!t1again.delivery.landing && t1again.delivery.landing.dir !== L1.dir && fs.existsSync(ansPath.abs), JSON.stringify({ a: L1.dir, b: (t1again.delivery.landing || {}).dir }));

  // ---------- 4. 成员自己写了文件 → 不该再多落一份回答 ----------
  const writerExpr = 'require("fs").writeFileSync(require("path").join(process.cwd(),"真的产出.txt"),"done");console.log("我已经写好了 真的产出.txt");';
  const s2 = makeServer([fake('writer', writerExpr)]);
  const r2 = s2.handleSend('@假成员 writer 干活', '写个文件', 'writer', null, null, s2.config.workspace, 'execute');
  const t2 = await waitTask(r2 && r2.task, 20000);
  check('成员真写了文件 → 判 produced', t2 && t2.delivery && t2.delivery.verdict === 'produced', t2 && JSON.stringify(t2.delivery));
  check('成员自己有产出时不落点（不堆冗余回答）', !t2.delivery.landing, JSON.stringify(t2 && t2.delivery && t2.delivery.landing));
  check('工作区里没有落点目录', !fs.existsSync(path.join(s2.config.workspace, landing.LANDING_DIRNAME)), fs.readdirSync(s2.config.workspace).join(','));

  // ---------- 5. 没跑成 / 静默 / 体检：都不落 ----------
  const s3 = makeServer([fake('boom', 'console.error("炸了");process.exit(3)')]);
  const r3 = s3.handleSend('@假成员 boom 干活', '失败一次', 'boom', null, null, s3.config.workspace, 'execute');
  const t3 = await waitTask(r3 && r3.task, 20000);
  check('失败的一单不落点', t3 && t3.status === 'error' && !(t3.delivery && t3.delivery.landing), t3 && JSON.stringify({ status: t3.status, landing: t3.delivery && t3.delivery.landing }));

  const s4 = makeServer([fake('quiet', 'console.log("体检回答")')]);
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-landprobe-'));
  const qt = s4.runTask(s4.memberById('quiet'), '只读探针', null, null, probeDir, 'health', { quiet: true });
  await waitTask(qt, 20000);
  check('体检探针不落点（否则每天 11 份垃圾）', !fs.existsSync(path.join(probeDir, landing.LANDING_DIRNAME)), fs.readdirSync(probeDir).join(','));

  console.log(`\n产出落点集成：${oks.length} 通过 / ${fails.length} 失败`);
  for (const f of fails) console.log('  FAIL ' + f);
  if (fails.length) { console.log('LANDING_INTEGRATION_FAILED'); process.exit(1); }
  console.log('ALL_LANDING_INTEGRATION_OK');
  process.exit(0);
})();