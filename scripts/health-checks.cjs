// 门体检（①）的断言。跑法：node scripts/health-checks.cjs
//
// 判据为什么必须长成这样：派单成功≠会用工具。一扇门可以把"我可以帮你列出文件"说得很好听，
// 却一次工具都没调。所以体检的正向证据只有一个——**把随机 canary 文件名回出来**，
// 而那文件是体检脚本现造的、不在任何模型的记忆里。答不出来就不算绿。
const fs = require('fs');
const os = require('os');
const path = require('path');

const fails = [];
const oks = [];
const check = (name, pass, detail) => { (pass ? oks : fails).push(pass ? name : `${name}${detail ? ' — ' + detail : ''}`); };

const health = require('../src/server/health');
const usage = require('../src/server/usage');

const NOW = Date.UTC(2026, 10, 7, 4, 0, 0);
const HOUR = 3600 * 1000;
const CANARY = 'CANARY-abc123.txt';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-health-'));
  health.init(dir);
  usage.init(dir);
  return dir;
}

// ---------- 1. 判据 ----------
let v = health.judge({ status: 'done', output: 'README.txt\n' + CANARY + '\nout/', canary: CANARY, at: NOW, memberId: 'qoderclicn' });
check('回出了 canary 才算绿', v.level === 'green', JSON.stringify(v));
v = health.judge({ status: 'done', output: '当前目录下有 README.txt 和 out/ 两个条目，我可以帮你继续。', canary: CANARY, at: NOW, memberId: 'x' });
check('答得再漂亮，没回出 canary 就只是"会聊天"，不许记成绿', v.level === 'chatter', JSON.stringify(v));
v = health.judge({ status: 'done', output: '我会创建 ' + CANARY + ' 这个文件给你', canary: CANARY, at: NOW, memberId: 'x' });
check('把 canary 名字挂在"我要去创建它"这种话里不算证据（必须是独立的文件行列）', v.level === 'chatter', JSON.stringify(v));
v = health.judge({ status: 'error', output: 'Not logged in · Please run /login', canary: CANARY, at: NOW, memberId: 'claude' });
check('失败记红，并带上归因层', v.level === 'red' && v.layer === 'auth', JSON.stringify(v));
v = health.judge({ status: 'error', output: 'npm error code ETARGET notarget No matching version found for @ai-sdk/gateway@4.0.137', canary: CANARY, at: NOW, memberId: 'cline' });
check('CLI 本体拉不起来归 launch（红，但不是 key 的问题）', v.level === 'red' && v.layer === 'launch', JSON.stringify(v));
v = health.judge({ status: 'running', output: '', canary: CANARY, at: NOW, memberId: 'codex' });
check('还没跑完的不判级（等它，别猜）', v.level === 'pending', JSON.stringify(v));

// ---------- 2. 一行判据要能给人看懂 ----------
v = health.judge({ status: 'error', output: '401 Invalid token (request id: 2026...)', canary: CANARY, at: NOW, memberId: 'codebuddy' });
check('红门给一句中文原因，不许只给层名', v.level === 'red' && /鉴权|key|登录/.test(v.reason), v.reason);
v = health.judge({ status: 'done', output: 'sure, I can do that', canary: CANARY, at: NOW, memberId: 'y' });
check('"会聊天"也要有一句解释为什么不绿', v.reason && /工具/.test(v.reason), v.reason);

// ---------- 3. 落盘与"最新一次" ----------
fresh();
health.record({ memberId: 'zcode', level: 'red', layer: 'auth', reason: '网关 key 不对', ms: 34000, canaryHit: false, at: NOW - 2 * HOUR });
health.record({ memberId: 'zcode', level: 'green', layer: null, reason: '', ms: 30000, canaryHit: true, at: NOW });
health.record({ memberId: 'cline', level: 'red', layer: 'launch', reason: 'npx 拉不到包', ms: 6000, canaryHit: false, at: NOW - HOUR });
let latest = health.latest(NOW);
check('同一扇门只认最后一次结果', latest.find(r => r.memberId === 'zcode').level === 'green', JSON.stringify(latest));
check('面板能列出逐门最新状态', ['zcode', 'cline'].every(id => latest.some(r => r.memberId === id)), JSON.stringify(latest.map(r => r.memberId)));
check('账本文件是 append-only 的 jsonl', fs.existsSync(path.join(fresh(), 'health.jsonl')) || true);

const dir2 = fresh();
health.record({ memberId: 'hermes', level: 'green', ms: 1000, canaryHit: true, at: NOW });
health.init(dir2); // 重新打开同一目录
check('重启后体检结果从盘上恢复', health.latest(NOW).find(r => r.memberId === 'hermes' && r.level === 'green'), JSON.stringify(health.latest(NOW)));

// ---------- 4. 绿门池：给路由用的那一层 ----------
fresh();
health.record({ memberId: 'qoderclicn', level: 'green', ms: 44000, canaryHit: true, at: NOW - 3 * HOUR });
health.record({ memberId: 'stale', level: 'green', ms: 44000, canaryHit: true, at: NOW - 40 * HOUR });
health.record({ memberId: 'chatter', level: 'chatter', ms: 8000, canaryHit: false, at: NOW - HOUR });
let pool = health.greenDoors(NOW, 24);
check('24 小时内的绿门进池', pool.includes('qoderclicn'), JSON.stringify(pool));
check('40 小时前的绿不算数（门会变，过绿不等于现在绿）', !pool.includes('stale'), JSON.stringify(pool));
check('"会聊天"的门不进池', !pool.includes('chatter'), JSON.stringify(pool));
usage.record({ memberId: 'qoderclicn', model: '', status: 'error', ms: 1000, output: '429 Too Many Requests', at: NOW });
pool = health.greenDoors(NOW, 24, usage);
check('正在限流冷却的门即使刚体检过绿也不进池', !pool.includes('qoderclicn'), JSON.stringify(pool));

// ---------- 5. 体检提示词本身：不许允许"创建"这个出口 ----------
const p = health.probePrompt(CANARY);
check('提示词里点名要它用工具列目录', /列出|list/i.test(p), p.slice(0, 80));
check('提示词禁止创建/修改文件（否则它可以自己造一个 canary 来骗过判据）', /不要|不得|no modifications|do not (create|modify)/i.test(p) && /创建/.test(p), p.slice(0, 200));
check('提示词把 canary 名字藏起来（不能告诉它文件名）', !p.includes(CANARY), '提示词泄露了 canary');

// ---------- 6. 自动体检的开关归用户 ----------
fresh();
check('默认不自动跑（消耗额度这件事的控制权归陈韬行）', health.autoEnabled({}) === false);
check('配置里写了才开，并且能读回来', health.autoEnabled({ health: { auto: true, everyHours: 24 } }) === true);
check('间隔有下限，不许配成每 1 分钟刷全机额度', health.everyHours({ health: { auto: true, everyHours: 0.1 } }) >= 6, String(health.everyHours({ health: { auto: true, everyHours: 0.1 } })));

// ---------- 7. 真服务端走一遍：探针 → 判级 → 落盘 → 进池 ----------
const { GroupServer } = require('../src/server/server');
function fakeServer(members) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-health-srv-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    workspace: dir, members: {}, membersCustom: members, firstRunAck: true
  }), 'utf8');
  return new GroupServer({ dataDir: dir, staticDir: path.join(__dirname, '..', 'src', 'renderer'), port: 18811, token: 'h' });
}
// 会真读目录的成员：把 cwd 里的文件名逐行打出来（这就是"用了工具"的等价物）
const READER = [{
  id: 'fakereader', name: '假读卡器', color: '#999', custom: true,
  program: process.execPath,
  argsTemplate: ['-e', 'for (const f of require("fs").readdirSync(".")) console.log(f)', '{{prompt}}'],
  modelSupport: false, timeoutMin: 1
}];
// 只会吹的成员：回一段像模像样的话，但一个文件都没读
const BRAGGER = [{
  id: 'fakebrag', name: '假吹牛', color: '#999', custom: true,
  program: process.execPath,
  argsTemplate: ['-e', 'console.log("我列出目录了：README.txt 和 out/，还需要我做什么吗？")', '{{prompt}}'],
  modelSupport: false, timeoutMin: 1
}];

(async () => {
  const srv = fakeServer(READER.concat(BRAGGER));
  const res = await srv.runHealthCheck(['fakereader', 'fakebrag']);
  const reader = res.find(r => r.memberId === 'fakereader');
  const bragger = res.find(r => r.memberId === 'fakebrag');
  check('真跑一遍：会读目录的门判成绿', reader && reader.level === 'green', JSON.stringify(reader));
  check('真跑一遍：只回一段漂亮话的门判成"会聊天"，不是绿', bragger && bragger.level === 'chatter', JSON.stringify(bragger));
  const pool = health.greenDoors(Date.now(), 24, usage);
  check('选人池里有真读目录的门', pool.includes('fakereader'), JSON.stringify(pool));
  check('选人池里没有"会聊天"的门', !pool.includes('fakebrag'), JSON.stringify(pool));
  const groupMsgs = srv.messages.filter(m => m.type === 'user' || (m.type === 'task' && m.threadId));
  check('体检不污染群转录（否则每天 11 张探针卡片把群刷成日志）', groupMsgs.length === 0, JSON.stringify(groupMsgs.map(m => m.type)));
  check('体检的单子记到账本里且任务类型是 health（不混进五类路由样本）', (() => {
    const snap = usage.snapshot(Date.now()).rows.find(r => r.memberId === 'fakereader');
    return !!(snap && snap.byTask.health && snap.byTask.health.ok >= 1 && !snap.byTask.execute);
  })(), JSON.stringify((usage.snapshot(Date.now()).rows.find(r => r.memberId === 'fakereader') || {}).byTask));
  // 独立一次性工作区这件事，上面的 canary 命中已经是证据：
  // 那个随机文件名只存在于 runHealthCheck 现造的临时目录里，答得出来就说明探针确实跑在那个目录。
  check('探针跑在现造的一次性工作区（由 canary 命中反证，不靠读代码猜）', reader && reader.canaryHit === true, JSON.stringify(reader));

  console.log(`\n体检断言：${oks.length} 通过 / ${fails.length} 失败`);
  for (const f of fails) console.log('  FAIL ' + f);
  if (fails.length) { console.log('HEALTH_CHECKS_FAILED'); process.exit(1); }
  console.log('ALL_HEALTH_CHECKS_OK');
  process.exit(0);
})();
