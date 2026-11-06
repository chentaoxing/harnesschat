// 闸门集成检查：不是单测函数，而是把真的 GroupServer 起来，走真的 handleSend，
// 证明"撞过限流的那扇门在派单时真的被拦下、而且没有真的拉起子进程"。
// 用法：node scripts/gate-integration.cjs   （退出码 0 = 通过）
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { GroupServer } = require('../src/server/server');
const usage = require('../src/server/usage');

const fails = [];
const oks = [];
const check = (name, pass, detail) => { (pass ? oks : fails).push(pass ? name : `${name}${detail ? ' — ' + detail : ''}`); };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-gate-'));
usage.init(dataDir);

// 记录一次真实的限流失败（词表来自生产输出）
usage.record({ memberId: 'zcode', model: '', taskKind: 'review', status: 'error', ms: 30000, output: 'TerminalStreamChunkError: exceed quota limit' });

// 数一数这一秒有没有新起的子进程：闸门生效时不该有任何 spawn
const spawned = [];
const realSpawn = cp.execFile;
cp.execFile = function (trackedFile, trackedArgs, trackedOpts) {
  spawned.push(String(trackedFile));
  return realSpawn.apply(this, arguments);
};

const server = new GroupServer({ dataDir, staticDir: path.join(__dirname, '..', 'src', 'renderer'), port: 18799, token: 'test-token' });

const t = Date.now();
const before = usage.isBlocked('zcode', '', t);
const res = server.handleSend('@ZCode 测试闸门', '测试闸门', 'zcode', null, '', dataDir, 'review');
const task = res && res.task;
check('派单被闸门拦下（status=error）', task && task.status === 'error', task && `status=${task.status}`);
check('拦下时给出一行可读原因（含"限流"）', task && /限流/.test(task.text || ''), task && JSON.stringify((task.text || '').slice(0, 80)));
check('拦下时给出剩余分钟数', task && /剩 \d+ 分钟/.test(task.text || ''), task && JSON.stringify((task.text || '').slice(0, 120)));
check('闸门拦下时没有拉起任何子进程', spawned.length === 0, JSON.stringify(spawned));
// 被拦下的这次没有真的打到厂商，不该把冷却往后推（否则反复点会永远出不去冷却），也不该混进失败分类
const after = usage.isBlocked('zcode', '', t);
check('被拦下的派单不延长冷却截止时间', before.until === after.until, JSON.stringify({ before: before.until, after: after.until }));
const snapRow = usage.snapshot(Date.now()).rows.find(r => r.memberId === 'zcode');
check('被拦下的次数单独记账', snapRow && snapRow.blockedAttempts >= 1, snapRow && JSON.stringify({ blockedAttempts: snapRow.blockedAttempts }));
check('被拦下的不计入失败分类', snapRow && !snapRow.byKind.other && snapRow.byKind.rate_limit === 1, snapRow && JSON.stringify(snapRow.byKind));

// 对照：冷却到期后同一扇门应该放行（这里只验证不再被拦，不真的等 30 分钟）
const future = Date.now() + 31 * 60 * 1000;
check('31 分钟后闸门放行', usage.isBlocked('zcode', '', future).blocked === false);

// 鉴权类失败不应该被闸门拦（重试没用，但不该拦掉整扇门）
usage.init(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-gate2-')));
usage.record({ memberId: 'cline', model: 'cline-free/kimi-k3', status: 'error', ms: 100, output: 'APICallError: Invalid token' });
check('鉴权失败不拦门', usage.isBlocked('cline', 'cline-free/kimi-k3', Date.now()).blocked === false);

// ---------- 退出码 0 但输出是裸错误行：卡片和账本都不能说成功 ----------
// 这是本机真实形态：cbc 遇到网关报错时把 "503 No available channel …" 打在 stdout 上退 0。
// 用一条自定义成员复现它（node -e 打印同样的行），不依赖真的装了什么 CLI。
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeFakeServer(id, printExpr) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-gate-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    workspace: dir,
    members: {},
    membersCustom: [{
      id: id, name: '假成员 ' + id, color: '#999', custom: true,
      program: process.execPath,
      argsTemplate: ['-e', printExpr, '{{prompt}}'],
      modelSupport: false, timeoutMin: 1
    }],
    firstRunAck: true
  }), 'utf8');
  return new GroupServer({ dataDir: dir, staticDir: path.join(__dirname, '..', 'src', 'renderer'), port: 18801, token: 'test-token' });
}

async function waitTask(task, limitMs) {
  let waited = 0;
  while (task && task.status === 'running' && waited < limitMs) { await sleep(300); waited += 300; }
  return task;
}

async function bareErrorChecks() {
  usage.init(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-gate3-')));
  const errLine = '503 No available channel for model x under group default (distributor) (request id: 202611061919429587521238268d9d6mK2W58pS)';
  const s2 = makeFakeServer('fakegateway', 'console.log(' + JSON.stringify(errLine) + ')');
  const r2 = s2.handleSend('@假成员 fakegateway 测试', '测试裸错误', 'fakegateway', null, null, s2.config.workspace, 'execute');
  const t2 = await waitTask(r2 && r2.task, 20000);
  check('成员退 0 但只回了一行网关错误 → 卡片判失败', t2 && t2.status === 'error', t2 && `status=${t2.status} text=${JSON.stringify(String(t2.text).slice(0, 90))}`);
  const row2 = usage.snapshot(Date.now()).rows.find(x => x.memberId === 'fakegateway');
  check('同一笔在账本里记成失败', row2 && row2.fail === 1 && row2.ok === 0, row2 && JSON.stringify({ ok: row2 && row2.ok, fail: row2 && row2.fail }));
  check('并归到网关层（该去找网关，不是冷却这扇门）', row2 && row2.byKind.gateway === 1, row2 && JSON.stringify(row2 && row2.byKind));
  check('这种情况不进冷却（网关修好就能立刻再派）', usage.isBlocked('fakegateway', '', Date.now() + 60000).blocked === false);

  // 正常回答不误判：内容里就在讲 401 也算成功
  const s3 = makeFakeServer('fakeok', 'console.log("401 一般是未授权，先核对 key。已完成，没改任何文件。")');
  const r3 = s3.handleSend('@假成员 fakeok 测试', '测试误伤', 'fakeok', null, null, s3.config.workspace, 'execute');
  const t3 = await waitTask(r3 && r3.task, 20000);
  check('成员正常回答时不误判成失败', t3 && t3.status === 'done', t3 && `status=${t3.status} text=${JSON.stringify(String(t3.text).slice(0, 90))}`);
}

bareErrorChecks().then(() => {
  console.log(`\n通过 ${oks.length} 项`);
  if (fails.length) {
    console.log(`失败 ${fails.length} 项：`);
    for (const f of fails) console.log('  ✗ ' + f);
    console.log('\nGATE_INTEGRATION_FAILED');
    process.exit(1);
  }
  console.log('ALL_GATE_INTEGRATION_OK');
  process.exit(0);
});
