// 用量与配额账本的检查（跑法：node scripts/usage-checks.cjs）
//
// 为什么要这张账：用户现在的状态里有一件事是他自己记着的——"哪家今天还免费、还剩多少、
// 上次是不是被限流了"。不把它变成数据，路由和闸门就永远是拍脑袋。
// 这里先断言行为，再实现；每条只验一件事。

const fs = require('fs');
const os = require('os');
const path = require('path');
const usage = require('../src/server/usage');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const fails = [];
const oks = [];
function check(name, pass, detail) {
  (pass ? oks : fails).push(pass ? name : `${name}${detail ? ' — ' + detail : ''}`);
}
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-usage-'));
  usage.init(dir);
  return dir;
}
const NOW = Date.UTC(2026, 9, 8, 4, 0, 0); // 固定时钟，避免用例随真实时间漂移

// ---------- 1. 计数 ----------
fresh();
usage.record({ memberId: 'cline', model: 'cline-free/kimi-k3', status: 'done', ms: 1000, at: NOW });
usage.record({ memberId: 'cline', model: 'cline-free/kimi-k3', status: 'error', ms: 2000, output: '429 Too Many Requests', at: NOW });
let rows = usage.snapshot(NOW).rows;
let cline = rows.find(r => r.memberId === 'cline');
check('同一成员同一模型的今日次数被累计', cline && cline.today === 2, cline && `today=${cline.today}`);
check('成功与失败分开计数', cline && cline.ok === 1 && cline.fail === 1, cline && JSON.stringify({ ok: cline && cline.ok, fail: cline && cline.fail }));

// ---------- 2. 跨天不计入今天 ----------
fresh();
usage.record({ memberId: 'codex', model: 'gpt-5.6', status: 'done', ms: 500, at: NOW - 30 * HOUR });
rows = usage.snapshot(NOW).rows;
const codex = rows.find(r => r.memberId === 'codex');
check('昨天的调用不计入今日', codex && codex.today === 0 && codex.total === 1, codex && JSON.stringify({ today: codex.today, total: codex.total }));

// ---------- 3. 错误分类 ----------
fresh();
const CASES = [
  ['429 Too Many Requests', 'rate_limit'],
  ['TerminalStreamChunkError: exceed quota limit', 'rate_limit'],
  ['API rate limit exceeded for 1.2.3.4', 'rate_limit'],
  ['APICallError: Invalid token (request id: x)', 'auth'],
  ['401 token is required', 'auth'],
  ['[1309] Your GLM Coding Plan package has expired', 'expired'],
  ['NOT_FOUND', 'not_found'],
  ['下载中断：45s 没有新数据', 'timeout'],
  ['Something weird happened', 'other']
];
for (const [output, kind] of CASES) {
  usage.record({ memberId: 'probe', model: 'm1', status: 'error', ms: 10, output, at: NOW });
}
const probe = usage.snapshot(NOW).rows.find(r => r.memberId === 'probe');
for (const [, kind] of CASES) {
  check(`错误分类记为 ${kind}`, probe && probe.byKind[kind] >= 1, probe && JSON.stringify(probe.byKind));
}
check('rate_limit 只由限流/配额类文本触发', probe && probe.byKind.rate_limit === 3, probe && `rate_limit=${probe.byKind.rate_limit}`);

// ---------- 3b. 真实堆栈不能误判（裸词在行列号上命中过一次，别再犯） ----------
fresh();
const REAL_AUTH_STACK = [
  'APICallError [AI_APICallError]: Invalid token (request id: 202611061825501674076098268d9d6IHYsY5RK)',
  '    at D:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs:2103:84294',
  '    at async postToApi (D:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs:2031:22319)',
  '  statusCode: 401,',
  "  url: 'http://127.0.0.1:8080/v1/responses',"
].join('\n');
usage.record({ memberId: 'zcode', model: 'mimo-v2.5', status: 'error', ms: 100, output: REAL_AUTH_STACK, at: NOW });
let realRow = usage.snapshot(NOW).rows.find(r => r.memberId === 'zcode');
check('堆栈里的 84294 不被当成 HTTP 429', realRow && !realRow.byKind.rate_limit, realRow && JSON.stringify(realRow.byKind));
check('这类输出归为鉴权失败', realRow && realRow.byKind.auth === 1, realRow && JSON.stringify(realRow.byKind));
check('鉴权失败不进冷却', usage.isBlocked('zcode', 'mimo-v2.5', NOW + 60 * 1000).blocked === false);

fresh();
const REAL_EXPIRED_WITH_429 = [
  'ProviderBusinessError: [1309][Your GLM Coding Plan package has expired and is temporarily unavailable.]',
  '  responseStatus: 429,',
  "    error: { code: '1309', type: 'rate_limit_error' }"
].join('\n');
usage.record({ memberId: 'zcode', model: 'glm', status: 'error', ms: 100, output: REAL_EXPIRED_WITH_429, at: NOW });
realRow = usage.snapshot(NOW).rows.find(r => r.memberId === 'zcode');
check('订阅到期优先于响应码 429', realRow && realRow.byKind.expired === 1 && !realRow.byKind.rate_limit, realRow && JSON.stringify(realRow.byKind));
check('订阅到期不进冷却（重试不会自愈）', usage.isBlocked('zcode', 'glm', NOW + 60 * 1000).blocked === false);

fresh();
for (const s of ['429 Too Many Requests', 'HTTP 429', 'upstream returned status 429']) {
  usage.record({ memberId: 'gate', model: 'm', status: 'error', ms: 10, output: s, at: NOW });
}
check('独立的 429 状态码仍归限流', usage.snapshot(NOW).rows.find(r => r.memberId === 'gate').byKind.rate_limit === 3);

// ---------- 4. 冷却规则 ----------
fresh();
usage.record({ memberId: 'zcode', model: 'mimo-v2.5', status: 'error', ms: 100, output: 'exceed quota limit', at: NOW });
let g = usage.isBlocked('zcode', 'mimo-v2.5', NOW + 60 * 1000);
check('撞限流后进入冷却并拦下派单', g.blocked === true, JSON.stringify(g));
check('冷却时长为 30 分钟', g.until === NOW + 30 * 60 * 1000, JSON.stringify({ deltaMin: Math.round((g.until - NOW) / 60000) }));
check('冷却未到期仍然拦着', usage.isBlocked('zcode', 'mimo-v2.5', NOW + 29 * 60 * 1000).blocked === true);
check('冷却到期后放行', usage.isBlocked('zcode', 'mimo-v2.5', NOW + 31 * 60 * 1000).blocked === false);
check('拦下时给出一行可读原因', typeof usage.isBlocked('zcode', 'mimo-v2.5', NOW + 1000).reason === 'string' && usage.isBlocked('zcode', 'mimo-v2.5', NOW + 1000).reason.length > 4);

fresh();
usage.record({ memberId: 'zcode', model: 'mimo-v2.5', status: 'error', ms: 100, output: 'Invalid token', at: NOW });
check('鉴权失败不进入冷却（重试没用，不该假装会自愈）', usage.isBlocked('zcode', 'mimo-v2.5', NOW + HOUR).blocked === false);

// ---------- 5. 免费档标记 ----------
fresh();
usage.record({ memberId: 'cline', model: 'cline-free/deepseek-v4.1-flash', status: 'done', ms: 10, at: NOW });
usage.record({ memberId: 'claude', model: 'sonnet', status: 'done', ms: 10, at: NOW });
rows = usage.snapshot(NOW).rows;
check('模型 id 含 free 的记为免费档', rows.find(r => r.model === 'cline-free/deepseek-v4.1-flash').free === true);
check('普通模型不标免费', rows.find(r => r.model === 'sonnet').free === false);

// ---------- 6. 耗时 ----------
fresh();
[1000, 9000, 2000].forEach(ms => usage.record({ memberId: 'gemini', model: 'g', status: 'done', ms, at: NOW }));
const gem = usage.snapshot(NOW).rows.find(r => r.memberId === 'gemini');
check('中位耗时不受极端值影响', gem && gem.medianMs === 2000, gem && `median=${gem.medianMs}`);

// ---------- 7. 落盘与重载 ----------
const dir = fresh();
usage.record({ memberId: 'hermes', model: 'h', status: 'done', ms: 10, at: NOW });
usage.record({ memberId: 'hermes', model: 'h', status: 'done', ms: 20, at: NOW });
usage.init(dir); // 重新打开同一目录，状态必须从盘上恢复
const hermes = usage.snapshot(NOW).rows.find(r => r.memberId === 'hermes');
check('重载后今日计数从盘上恢复', hermes && hermes.today === 2, hermes && `today=${hermes.today}`);
check('账本文件是 append-only 的 jsonl', fs.existsSync(path.join(dir, 'usage.jsonl')));

// ---------- 8. 按任务类型统计 ----------
fresh();
usage.record({ memberId: 'cline', model: 'x', taskKind: 'review', status: 'done', ms: 10, at: NOW });
usage.record({ memberId: 'cline', model: 'x', taskKind: 'review', status: 'done', ms: 10, at: NOW });
usage.record({ memberId: 'cline', model: 'x', taskKind: 'execute', status: 'error', ms: 10, at: NOW });
const byKindRow = usage.snapshot(NOW).rows.find(r => r.memberId === 'cline');
check('按任务类型能看出谁干这类活更稳', byKindRow && byKindRow.byTask.review.ok === 2 && byKindRow.byTask.execute.fail === 1,
  byKindRow && JSON.stringify(byKindRow.byTask));

// ---------- 结果 ----------
console.log(`\n通过 ${oks.length} 项`);
if (fails.length) {
  console.log(`\n失败 ${fails.length} 项：`);
  for (const f of fails) console.log('  ✗ ' + f);
  console.log('\nUSAGE_CHECKS_FAILED');
  process.exit(1);
}
console.log('ALL_USAGE_CHECKS_OK');
