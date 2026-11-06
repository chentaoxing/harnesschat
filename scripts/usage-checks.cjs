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

// ---------- 9. 免费档的"证据来源"：id 自称 ≠ 实测 ----------
// 起因：我一度把模型名里带 free 就当"免费、放心派"，但真正的免费档是有额度上限的，
// 而上限这件事只有实测才知道。面板必须说清这条结论是从哪来的。
fresh();
usage.record({ memberId: 'cline', model: 'cline-free/kimi-k3', status: 'done', ms: 10, at: NOW });
let evRow = usage.snapshot(NOW).rows.find(r => r.model === 'cline-free/kimi-k3');
check('只跑成功过一次的免费档：结论是"实测可用"，不是只凭 id', evRow && (evRow && evRow.freeEvidence || {}).verdict === 'ok-observed', evRow && JSON.stringify((evRow && evRow.freeEvidence || {})));
check('证据里保留"id 自称免费"这一层（它只是标签，不是结论）', evRow && (evRow && evRow.freeEvidence || {}).idClaimsFree === true, evRow && JSON.stringify((evRow && evRow.freeEvidence || {})));

fresh();
usage.record({ memberId: 'cline', model: 'cline-free/kimi-k3', status: 'error', ms: 10, output: '429 Too Many Requests', at: NOW });
evRow = usage.snapshot(NOW).rows.find(r => r.model === 'cline-free/kimi-k3');
check('撞过限流的免费档：结论改成"实测有额度上限"', evRow && (evRow && evRow.freeEvidence || {}).verdict === 'quota-capped', evRow && JSON.stringify((evRow && evRow.freeEvidence || {})));
check('结论带上第几次撞的（今天第 N 次才有意义）', evRow && (evRow && evRow.freeEvidence || {}).rateLimit === 1, evRow && JSON.stringify((evRow && evRow.freeEvidence || {})));

fresh();
usage.record({ memberId: 'codebuddy', model: 'custom-local:deepseek-v4-flash-free', status: 'done', ms: 10, at: NOW });
usage.record({ memberId: 'codebuddy', model: 'custom-local:kimi-k3', status: 'done', ms: 10, at: NOW });
rows = usage.snapshot(NOW).rows;
check('模型名不带 free 但实测成功过 → 结论仍是实测来的，并标它没自称免费',
  ((rows.find(r => r.model === 'custom-local:kimi-k3') || {}).freeEvidence || {}).verdict === 'ok-observed' &&
  ((rows.find(r => r.model === 'custom-local:kimi-k3') || {}).freeEvidence || {}).idClaimsFree === false,
  JSON.stringify(((rows.find(r => r.model === 'custom-local:kimi-k3') || {}).freeEvidence || {})));

fresh();
usage.record({ memberId: 'cline', model: 'cline-free/mimo-v2.6-flash', status: 'blocked', ms: 0, at: NOW });
evRow = usage.snapshot(NOW).rows.find(r => r.model === 'cline-free/mimo-v2.6-flash');
check('一次都没真打到厂商（全被闸门拦下）→ 结论只能说"仅 id 自称免费"',
  (evRow && (evRow && evRow.freeEvidence || {}).verdict) === 'id-only', JSON.stringify(evRow && evRow.freeEvidence));

// ---------- 10. 网关侧失败不是这一家的锅（实测来自 cbc→new-api） ----------
check('能识别"没有可用渠道"是网关层，不是成员坏了', usage.classifyError({ status: 'error', output: '503 No available channel for model x under group default (distributor)' }) === 'gateway');
check('能识别"上游请求发不出去"是网关层', usage.classifyError({ status: 'error', output: '500 upstream error: do request failed (request id: 2026...)' }) === 'gateway');
fresh();
usage.record({ memberId: 'codebuddy', model: 'custom-local:grok-4.5', status: 'error', ms: 10, output: '503 No available channel for model grok-4.5 under group default (distributor)', at: NOW });
evRow = usage.snapshot(NOW).rows.find(r => r.memberId === 'codebuddy');
check('网关不通不进冷却（重试要改的是网关，不是把这扇门关 30 分钟）', usage.isBlocked('codebuddy', 'custom-local:grok-4.5', NOW + 60 * 1000).blocked === false);
check('结论标成"网关侧不通"并给出该找谁', evRow && (evRow && evRow.freeEvidence || {}).verdict === 'gateway-down' && /网关/.test((evRow && evRow.freeEvidence || {}).note), evRow && JSON.stringify((evRow && evRow.freeEvidence || {})));
check('鉴权失败优先于网关（有 key 形状字样时不能盖成网关问题）', usage.classifyError({ status: 'error', output: 'Invalid token for api_key while calling upstream' }) === 'auth');

// ---------- 11. 退出码 0 不等于成功（本机实测：cbc 把网关报错打在 stdout 上退 0） ----------
// 这一条是假绿：账本只看 exit code，于是"401 Invalid token"被记成 ok、结论写成"实测成功过"。
check('退出 0 但输出是厂商/网关的裸错误行 → 判失败', usage.deriveStatus(true, '401 Invalid token (request id: 202611061919255986347348268d9d6WvdV75L3)\n') === 'error');
check('503 无可用渠道同样判失败', usage.deriveStatus(true, '503 No available channel for model x under group default (distributor) (request id: 2026...)\n') === 'error');
check('500 上游发不出去同样判失败', usage.deriveStatus(true, '500 upstream error: do request failed (request id: 2026...)\n') === 'error');
check('未登录回 Authentication required 判失败', usage.deriveStatus(true, 'Authentication required. Please use /login command to sign in to your account\n') === 'error');
check('正常回答不误判（哪怕内容里就在讲 401）', usage.deriveStatus(true, '401 一般表示未授权，先检查 key 是否正确。\n\n补充一句：你的报错里带了 request id: 说明请求已经到网关。') === 'done');
check('空输出不误判成失败（有的成员只写文件不回话）', usage.deriveStatus(true, '') === 'done');
check('退出码非 0 时不管输出是什么都算失败', usage.deriveStatus(false, '看起来一切正常') === 'error');
check('判出来的失败还能落到正确的层', usage.classifyError({ status: 'error', output: '401 Invalid token (request id: 2026...)' }) === 'auth');
fresh();
usage.record({ memberId: 'codebuddy', model: 'custom-local:deepseek-v4-flash-free', status: usage.deriveStatus(true, '503 No available channel for model x under group default (distributor) (request id: 2026...)'), ms: 5000, output: '503 No available channel for model x under group default (distributor) (request id: 2026...)', at: NOW });
evRow = usage.snapshot(NOW).rows.find(r => r.memberId === 'codebuddy');
check('这种失败进账后结论不能再是"实测成功过"', (evRow && (evRow && evRow.freeEvidence || {}).verdict) === 'gateway-down', JSON.stringify(evRow && evRow.freeEvidence));
check('这种失败计入 fail 而不是 ok', evRow && evRow.fail === 1 && evRow.ok === 0, evRow && JSON.stringify({ ok: evRow.ok, fail: evRow.fail }));

// ---------- 结果 ----------
console.log(`\n通过 ${oks.length} 项`);
if (fails.length) {
  console.log(`\n失败 ${fails.length} 项：`);
  for (const f of fails) console.log('  ✗ ' + f);
  console.log('\nUSAGE_CHECKS_FAILED');
  process.exit(1);
}
console.log('ALL_USAGE_CHECKS_OK');
