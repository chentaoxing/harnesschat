// 无人值守闭环的集成断言：起真的 GroupServer、拉真的子进程、真的杀进程树。
// 用法：node scripts/unattended-integration.cjs   （退出码 0 = 通过）
//
// 证明三件事：
//   1. 一单跑完，服务器真的把"完成事件"交出去了（主进程据此弹桌面通知）；体检探针不交。
//   2. 停止/超时之后，成员起的**后台孙子进程**也真的死了。
//      实测前提（2026-11-08 本机探针，带正对照）：child.kill() 能带走普通孙子，
//      但 detached:true 的孙子活下来并继续写盘 —— 那就是"停了却还在烧额度"的形状。
//   3. 手动停止在卡片上说得清是你停的，而不是含糊地记一笔"失败"。
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { GroupServer } = require('../src/server/server');
const usage = require('../src/server/usage');
const { safeExec, stopTree } = require('../src/server/safe-spawn');

const fails = [];
const oks = [];
const check = (name, pass, detail) => { (pass ? oks : fails).push(pass ? name : `${name}${detail ? ' — ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeServer(members, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-unatt-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    workspace: dir, members: {}, membersCustom: members, firstRunAck: true
  }), 'utf8');
  return new GroupServer(Object.assign({ dataDir: dir, staticDir: path.join(__dirname, '..', 'src', 'renderer'), port: 18805, token: 'test-token' }, opts || {}));
}

function fake(id, printExpr) {
  return {
    id, name: '假成员 ' + id, color: '#999', custom: true,
    program: process.execPath, argsTemplate: ['-e', printExpr, '{{prompt}}'],
    modelSupport: false, timeoutMin: 1
  };
}

async function waitTask(task, limitMs) {
  let waited = 0;
  while (task && task.status === 'running' && waited < limitMs) { await sleep(150); waited += 150; }
  return task;
}

// 造一个"父进程 + detached 孙子"的真实进程树。孙子 8s 后才写标记，证明它活过停止。
// 8s 不是随便定的：本机 tasklist 一次要 ~880ms、taskkill /T 要 ~1.2s（2026-11-08 实测），
// 标记若定在 1.5s，"杀之前它已经写了"会让断言恒红——那是尺子的竞态，不是产品的 bug。
const MARKER_DELAY_MS = 8000;
function makeTree(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-tree-' + tag + '-'));
  const marker = path.join(dir, 'grandchild-alive.txt');
  const pidFile = path.join(dir, 'gcpid.txt');
  const gc = path.join(dir, 'gc.cjs');
  const parent = path.join(dir, 'p.cjs');
  fs.writeFileSync(gc, `setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'alive');},${MARKER_DELAY_MS});setTimeout(()=>{},40000);`);
  fs.writeFileSync(parent, [
    `const c=require('child_process').spawn(process.execPath,[${JSON.stringify(gc)}],{stdio:'ignore',detached:true});`,
    `c.unref();`,
    `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`,
    `setTimeout(()=>{},90000);`
  ].join('\n'));
  return { dir, marker, pidFile, parent };
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    return cp.execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 8000 }).includes('"' + pid + '"');
  } catch (e) { return false; }
}

(async () => {
  usage.init(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-unatt-u-')));

  // ---------- 1. 完成事件真的交出去了 ----------
  const seen = [];
  const s1 = makeServer([fake('talker', 'console.log("方案正文")')], { onTaskFinished: (info) => seen.push(info) });
  const r1 = s1.handleSend('@假成员 talker 干活', '给我一个方案', 'talker', null, null, s1.config.workspace, 'produce');
  const t1 = await waitTask(r1 && r1.task, 20000);
  check('假成员跑完成功态', t1 && t1.status === 'done', t1 && `status=${t1.status}`);
  check('完成事件交出去了一次', seen.length === 1, JSON.stringify(seen.map(x => x && x.id)));
  const ev = seen[0] || {};
  check('事件里带 taskId（点击通知要能回到卡片）', ev.id === t1.id, JSON.stringify(ev.id));
  check('事件里带成员名', ev.memberName === '假成员 talker', JSON.stringify(ev.memberName));
  check('事件里带交付结论（通知文案要与卡片同源）', !!ev.delivery && typeof ev.delivery.verdict === 'string', JSON.stringify(ev.delivery && ev.delivery.verdict));
  check('事件里带落点（只回答的活也有能打开的东西）', !!(ev.delivery && ev.delivery.landing && ev.delivery.landing.ok), JSON.stringify(ev.delivery && ev.delivery.landing));
  check('事件里不带成员输出全文（通知不是转录倾倒场）', !('text' in ev) || String(ev.text).length <= 400, JSON.stringify(Object.keys(ev)));

  // 体检探针：quiet，绝不许弹通知
  seen.length = 0;
  const probe = s1.runTask(s1.members.find(m => m.id === 'talker'), '只读探针', null, null, s1.config.workspace, 'health', { quiet: true });
  await waitTask(probe, 20000);
  check('体检探针跑完了', probe.status !== 'running', probe.status);
  check('体检探针不交完成事件（否则每天 11 条桌面噪音）', seen.length === 0, JSON.stringify(seen.map(x => x && x.taskKind)));

  // ---------- 2. 正对照：不停止，孙子必须活下来写得出标记 ----------
  // 没有这一条，下面"孙子死了"就可能是尺子恒 false 造出来的假绿。
  // 注意：杀之前绝不查 tasklist——它一次 ~880ms，会把停止时刻推过标记时刻，造出假红。
  const ctl = makeTree('ctl');
  const ctlChild = safeExec(process.execPath, [ctl.parent], { cwd: ctl.dir, env: process.env });
  await sleep(1200);
  let ctlPid = ''; try { ctlPid = fs.readFileSync(ctl.pidFile, 'utf8').trim(); } catch (e) {}
  check('正对照：父进程报出了孙子 pid', /^\d+$/.test(ctlPid), 'pid=' + ctlPid);
  await sleep(MARKER_DELAY_MS + 2000);
  check('正对照：不停止时孙子写得出标记（尺子不是恒 false）', fs.existsSync(ctl.marker), ctl.marker);
  check('正对照：孙子确实还活着', pidAlive(ctlPid), 'pid=' + ctlPid);
  try { cp.execFileSync('taskkill', ['/PID', ctlPid, '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
  try { ctlChild.kill(); } catch (e) {}

  // ---------- 3. stopTree：detached 孙子也要死 ----------
  check('safe-spawn 导出 stopTree', typeof stopTree === 'function', typeof stopTree);
  const kill = makeTree('kill');
  const killChild = safeExec(process.execPath, [kill.parent], { cwd: kill.dir, env: process.env });
  await sleep(1200);
  let killPid = ''; try { killPid = fs.readFileSync(kill.pidFile, 'utf8').trim(); } catch (e) {}
  check('被试：父进程报出了孙子 pid', /^\d+$/.test(killPid), 'pid=' + killPid);
  check('被试：停止之前孙子还没写标记（否则这条断言没有意义）', !fs.existsSync(kill.marker), kill.marker);
  const killRet = typeof stopTree === 'function' ? stopTree(killChild) : false;
  check('stopTree 报告杀掉了', killRet === true, JSON.stringify(killRet));
  await sleep(MARKER_DELAY_MS + 2000);
  check('stopTree 之后孙子写不出标记（它真死了，不是只死了父进程）', !fs.existsSync(kill.marker), kill.marker);
  check('stopTree 之后 tasklist 里也找不到孙子', !pidAlive(killPid), 'pid=' + killPid);
  check('stopTree 之后父进程也不在了', !pidAlive(String(killChild.pid)), 'pid=' + killChild.pid);
  try { cp.execFileSync('taskkill', ['/PID', killPid, '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}

  // ---------- 4. 手动停止：卡片要说清是你停的 ----------
  const seen2 = [];
  const s2 = makeServer([fake('slow', 'setTimeout(()=>console.log("终于答完"),8000)')], { onTaskFinished: i => seen2.push(i) });
  const r2 = s2.handleSend('@假成员 slow 慢慢干', '跑久一点', 'slow', null, null, s2.config.workspace, 'execute');
  const t2 = r2 && r2.task;
  await sleep(600);
  check('慢成员还在跑', t2 && t2.status === 'running', t2 && t2.status);
  check('GroupServer 有 stopTask（停止走统一出口，不再裸 kill）', typeof s2.stopTask === 'function', typeof s2.stopTask);
  const stopped = typeof s2.stopTask === 'function' ? s2.stopTask(t2.id) : false;
  check('stopTask 报告找到了这单', stopped === true, JSON.stringify(stopped));
  await waitTask(t2, 15000);
  check('停止后卡片不再是 running', t2 && t2.status !== 'running', t2 && t2.status);
  check('卡片正文说明是手动停的', /手动停|你停的|手动停止/.test(String(t2 && t2.text)), JSON.stringify(String(t2 && t2.text).slice(-120)));
  check('停止也交完成事件（他要知道这单结束了）', seen2.length === 1, JSON.stringify(seen2.length));
  check('不存在的 taskId 停下来返回 false', typeof s2.stopTask === 'function' && s2.stopTask('no-such-task') === false);

  console.log(oks.map(x => '  ok  ' + x).join('\n'));
  if (fails.length) {
    console.error('\n' + fails.map(x => 'FAIL  ' + x).join('\n'));
    console.error(`\nUNATTENDED_INTEGRATION_FAIL ${fails.length}/${oks.length + fails.length}`);
    process.exit(1);
  }
  console.log(`\nUNATTENDED_INTEGRATION_OK ${oks.length}/${oks.length}`);
  process.exit(0);
})().catch(e => { console.error('UNATTENDED_INTEGRATION_ERROR', e && e.stack || e); process.exit(1); });