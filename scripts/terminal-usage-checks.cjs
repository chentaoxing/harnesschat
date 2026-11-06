// 终端会话用量并入账本的断言（跑法：node scripts/terminal-usage-checks.cjs）
//
// 为什么要这一块：账本原来只记"我从群里派出去的"。但他大部分活是在各家自己的终端里
// 手敲的，那部分我看不见，于是"哪家今天很闲"是假的——闸门和路由都建立在假数据上。
// 原则：只统计能逐条归因到某个模型的转录；认不出布局的家，标"未统计"，绝不猜成 0。

const fs = require('fs');
const os = require('os');
const path = require('path');

const fails = [];
const oks = [];
function check(name, pass, detail) {
  (pass ? oks : fails).push(pass ? name : `${name}${detail ? ' — ' + detail : ''}`);
}

const term = require('../src/server/terminal-usage');
const usage = require('../src/server/usage');

const NOW = Date.UTC(2026, 9, 8, 4, 0, 0);
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const iso = ts => new Date(ts).toISOString();

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hc-term-')); }

// 造一份 ZCode rollout 布局：一条 model_io = 一次模型往返
function zcodeHome(records) {
  const home = tmpHome();
  const dir = path.join(home, '.zcode', 'cli', 'rollout');
  fs.mkdirSync(dir, { recursive: true });
  const lines = records.map(r => JSON.stringify({
    type: 'model_io', startedAt: iso(r.at), completedAt: iso(r.at + (r.ms || 1000)),
    durationMs: r.ms || 1000, attempt: 1, turnId: 't',
    model: { modelId: r.model || 'GLM-5.3-Flash', providerId: 'account:zai-start-plan' },
    ...(r.error ? { error: { name: 'Error', message: r.error } } : {})
  }));
  fs.writeFileSync(path.join(dir, 'model-io-sess_aaaa.jsonl'), lines.join('\n') + '\n');
  return home;
}

// 造一份 Claude projects 布局：目录名就是工作区，assistant 记录带 message.model
function claudeHome(records) {
  const home = tmpHome();
  const dir = path.join(home, '.claude', 'projects', 'C--work-demo');
  fs.mkdirSync(dir, { recursive: true });
  const lines = records.map(r => JSON.stringify({
    type: 'assistant', timestamp: iso(r.at),
    message: { model: r.model || 'claude-sonnet-4-5', content: [{ type: 'text', text: 'ok' }] },
    ...(r.error ? { isApiError: true } : {})
  }));
  fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), lines.join('\n') + '\n');
  return home;
}

// ---------- 1. ZCode：逐条归因 ----------
let h = zcodeHome([{ at: NOW - HOUR, model: 'GLM-5.3-Flash', ms: 2000 }, { at: NOW - 2 * HOUR, model: 'GLM-5.3-Flash', ms: 4000 }]);
let res = term.scan({ now: NOW, days: 7, homes: { zcode: h } });
let zrow = res.rows.find(r => r.memberId === 'zcode');
check('ZCode 转录里的模型往返被计数', zrow && zrow.total === 2, zrow && JSON.stringify(zrow));
check('按它自己写的模型 id 归组（不是我猜的）', zrow && zrow.model === 'GLM-5.3-Flash', zrow && zrow.model);
check('耗时中位数来自转录的 durationMs', zrow && zrow.medianMs >= 2000 && zrow.medianMs <= 4000, zrow && zrow.medianMs);
check('终端来源要打标记（不能和派单混成一个数）', zrow && zrow.source === 'terminal', zrow && zrow.source);

// ---------- 2. 失败归因 ----------
h = zcodeHome([{ at: NOW - HOUR, error: 'aborted' }, { at: NOW - 2 * HOUR }]);
res = term.scan({ now: NOW, days: 7, homes: { zcode: h } });
zrow = res.rows.find(r => r.memberId === 'zcode');
check('带 error 的那次算失败', zrow && zrow.fail === 1 && zrow.ok === 1, zrow && JSON.stringify({ ok: zrow.ok, fail: zrow.fail }));

// ---------- 3. 时间窗：只扫最近 N 天，跨天不计入今天 ----------
h = zcodeHome([{ at: NOW - HOUR }, { at: NOW - 3 * DAY }, { at: NOW - 30 * DAY }]);
res = term.scan({ now: NOW, days: 7, homes: { zcode: h } });
zrow = res.rows.find(r => r.memberId === 'zcode');
check('超出时间窗的记录不混进来', zrow && zrow.total === 2, zrow && zrow.total);
check('今天与总计分得开', zrow && zrow.today === 1 && zrow.total === 2, zrow && JSON.stringify({ today: zrow.today, total: zrow.total }));

// ---------- 4. Claude：<synthetic> 不是模型往返 ----------
h = claudeHome([{ at: NOW - HOUR, model: '<synthetic>' }, { at: NOW - 2 * HOUR, model: 'claude-sonnet-4-5' }]);
res = term.scan({ now: NOW, days: 7, homes: { claude: h } });
const crow = res.rows.find(r => r.memberId === 'claude');
check('Claude 转录里的模型往返被计数', crow && crow.total === 1, crow && JSON.stringify(crow));
check('<synthetic> 那条被排除（它没打模型）', crow && crow.model === 'claude-sonnet-4-5', crow && crow.model);

// ---------- 5. 认不出布局 = 未统计，不是 0 ----------
res = term.scan({ now: NOW, days: 7, homes: { zcode: tmpHome(), claude: tmpHome() } });
check('空目录时不产出行（而不是造一条 0 次）', res.rows.length === 0, JSON.stringify(res.rows));
const cov = term.coverage({ homes: { zcode: tmpHome(), codex: tmpHome() } });
const codexCov = cov.find(c => c.memberId === 'codex');
check('没接扫描器的家明确标未统计', codexCov && codexCov.status === 'uncovered' && /未统计/.test(cov.length ? codexCov.note : ''), JSON.stringify(cov));

// ---------- 6. 有界：文件数/字节数超了就报 truncated，不能悄悄少算 ----------
h = tmpHome();
const dir = path.join(h, '.zcode', 'cli', 'rollout');
fs.mkdirSync(dir, { recursive: true });
const one = JSON.stringify({ type: 'model_io', startedAt: iso(NOW - HOUR), durationMs: 1000, model: { modelId: 'M' } });
for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, `model-io-sess_${i}.jsonl`), (one + '\n').repeat(200));
res = term.scan({ now: NOW, days: 7, homes: { zcode: h }, maxBytes: 4000 });
check('超过字节上限时明确报 truncated（而不是给个偏小的数当真相）', res.truncated === true, JSON.stringify({ truncated: res.truncated }));
check('truncated 时把标记带进对应行（下游能显示"至少 N 次"）', res.rows.every(r => r.partial === true), JSON.stringify(res.rows.map(r => r.partial)));

// ---------- 7. 坏行/半行不许把扫描搞崩 ----------
fs.writeFileSync(path.join(dir, 'model-io-sess_bad.jsonl'), '{不是 json\n' + one + '\n');
let threw = null;
try { res = term.scan({ now: NOW, days: 7, homes: { zcode: h } }); } catch (e) { threw = e; }
check('坏 JSON 行被跳过而不是抛', !threw, threw && threw.message);

// ---------- 8. 合并进快照：两笔账各自成立，不相加冒充 ----------
usage.init(tmpHome());
usage.record({ memberId: 'zcode', model: '', status: 'done', ms: 9000, at: NOW, taskKind: 'execute' });
const scanned = term.scan({ now: NOW, days: 7, homes: { zcode: zcodeHome([{ at: NOW - HOUR, model: 'GLM-5.3-Flash' }]) } });
const snap = usage.snapshot(NOW, scanned);
const disp = snap.rows.find(r => r.memberId === 'zcode');
check('派单那行的 today 仍只是派单数（终端数没被塞进来冒充）', disp && disp.today === 1, disp && JSON.stringify({ today: disp.today, terminalToday: disp.terminalToday }));
check('同一行能读到该成员的终端观测数', disp && disp.terminalToday === 1 && disp.terminalTotal === 1, disp && JSON.stringify({ tT: disp.terminalToday, tAll: disp.terminalTotal }));
check('快照顶层带出终端明细与覆盖情况', Array.isArray(snap.terminalRows) && Array.isArray(snap.terminalCoverage), JSON.stringify(snap.terminalRows));
const snapNoTerm = usage.snapshot(NOW);
check('不传终端数据时老字段一个不少（向后兼容）', snapNoTerm.rows.length === 1 && snapNoTerm.rows[0].terminalToday === 0, JSON.stringify(snapNoTerm.rows[0]));

// ---------- 9. 两笔账不许相加冒充精确（我分不出"这条是不是我从群里派的"） ----------
const merged = usage.snapshot(NOW, scanned);
const mrow = merged.rows.find(r => r.memberId === 'zcode');
check('派单的 total 不因终端观测而变大（不许造一个"合计次数"冒充精确）', mrow && mrow.total === 1, mrow && JSON.stringify({ total: mrow.total, terminalTotal: mrow.terminalTotal }));
check('终端观测自己带 source 标记（下游要合也得显式合）', (merged.terminalRows[0] || {}).source === 'terminal', JSON.stringify(merged.terminalRows[0]));

// ---------- 10. 面板会反复刷，扫描要有缓存（但缓存不能把新账挡住） ----------
h = zcodeHome([{ at: NOW - HOUR }]);
term.invalidate();
const a = term.scanCached({ now: NOW, days: 7, homes: { zcode: h } });
const b = term.scanCached({ now: NOW, days: 7, homes: { zcode: h } });
check('同一时间窗内重复请求走缓存（不再重扫盘）', a === b);
fs.appendFileSync(path.join(h, '.zcode', 'cli', 'rollout', 'model-io-sess_aaaa.jsonl'),
  JSON.stringify({ type: 'model_io', startedAt: iso(NOW - 60000), durationMs: 1000, model: { modelId: 'GLM-5.3-Flash' } }) + '\n');
term.invalidate();
const c = term.scanCached({ now: NOW, days: 7, homes: { zcode: h } });
const cz = c.rows.find(r => r.memberId === 'zcode');
check('显式作废后能重扫到新的一笔（派完单立刻看得见面板变化）', cz && cz.total === 2, cz && cz.total);

// ---------- 11. 大 payload 不许把计数挤掉（本机实测：单行 600KB、单文件 47MB） ----------
h = tmpHome();
const bigDir = path.join(h, '.zcode', 'cli', 'rollout');
fs.mkdirSync(bigDir, { recursive: true });
const fat = 'x'.repeat(400 * 1024);
const lines = [];
for (let i = 0; i < 12; i++) {
  lines.push(JSON.stringify({ type: 'model_io', startedAt: iso(NOW - i * 60000), durationMs: 1000 + i, model: { modelId: 'GLM-5.3-Flash' }, request: { payload: fat }, response: { payload: fat } }));
}
fs.writeFileSync(path.join(bigDir, 'model-io-sess_fat.jsonl'), lines.join('\n') + '\n');
res = term.scan({ now: NOW, days: 7, homes: { zcode: h } });
const frow = res.rows.find(r => r.memberId === 'zcode');
check('塞满请求体的转录也逐条数得到（不因行太大而少算）', frow && frow.total === 12, frow && JSON.stringify({ total: frow.total, partial: frow.partial }));
check('没触顶时不许乱标"至少"', frow && frow.partial === false, frow && String(frow.partial));

// ---------- 12. 时间窗按记录自身的时间，不按文件改过的时间 ----------
h = zcodeHome([{ at: NOW - 30 * DAY }, { at: NOW - HOUR }]);
// 文件本身是"刚写的"，但里面一条记录是 30 天前的
res = term.scan({ now: NOW, days: 7, homes: { zcode: h } });
zrow = res.rows.find(r => r.memberId === 'zcode');
check('文件是新的不代表记录是新的（30 天前那次不塞进今天）', zrow && zrow.total === 1 && zrow.today === 1, zrow && JSON.stringify({ total: zrow.total, today: zrow.today }));

console.log(`\n终端用量断言：${oks.length} 通过 / ${fails.length} 失败`);
for (const f of fails) console.log('  FAIL ' + f);
if (fails.length) { console.log('TERMINAL_USAGE_CHECKS_FAILED'); process.exit(1); }
console.log('ALL_TERMINAL_USAGE_OK');
