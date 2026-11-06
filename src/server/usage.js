// 用量与配额账本：把"哪家今天还能用、用了多少、上次怎么死的"从人脑里搬进数据。
//
// 设计取舍：
//   - append-only 的 usage.jsonl，跟群转录同一种存法；崩了不丢历史，重启后从盘上重算。
//   - 时钟可注入（at / now），这样冷却和"今天"的边界能被测试钉住。
//   - 只对限流/配额类失败上冷却闸门：鉴权失败和订阅过期重试没用，假装会自愈只会掩盖问题。
const fs = require('fs');
const path = require('path');

const COOLDOWN_MS = 30 * 60 * 1000;

let filePath = null;
let events = [];

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 失败原因归类。两条纪律来自踩过的坑：
 *   1. 先看"具体成因"再看"状态码"——订阅到期那条消息里同时带着 responseStatus: 429，
 *      按状态码判会把"重试不会自愈"的问题误判成限流并冷却它。
 *   2. 状态码必须带词边界——裸 /429/ 在堆栈的 `zcode.cjs:2103:84294` 上命中过一次。
 * 判定主要看输出头部（错误标题就在那里），只有找限流线索时才回看全文。
 */
const HEADLINE_CHARS = 600;
function rateLimitShaped(s) {
  return /\b429\b|rate.?limit|too many requests|quota|配额/i.test(s);
}
// 网关层：报错来自他自己那台中转（new-api/one-api 的原话形状），
// 意思是"这一家没坏，是路由没配/上游连不上"。修的方向是网关，不是把这扇门冷却 30 分钟。
function gatewayShaped(s) {
  return /no available channel|upstream error|do request failed|\(distributor\)|渠道/i.test(s);
}
function classifyError(ev) {
  if (ev.status === 'done') return null;
  const full = String(ev.output || ev.errorKind || '');
  const head = full.slice(0, HEADLINE_CHARS);
  if (/expired|coding plan|subscription|套餐/i.test(head)) return 'expired';
  if (/invalid token|token is required|unauthorized|authentication failed|api.?key|missing key|missing_credential|no auth type|authentication required|not logged in|please run \/login/i.test(head)) return 'auth';
  // "起不来"和"没装"是两件事，而且都发生在模型之前：CLI 本体拉不起来（npm 拉不到包、
  // 入口模块没落地）归 launch；只有"这台机器上找不到这个应用"才是 not_found。
  // 顺序上 launch 必须在 not_found 之前，否则 MODULE_NOT_FOUND 会被裸 NOT_FOUND 抢走。
  if (/npm error|etarget|notarget|cannot find module|err_module_not_found|module_not_found|command not found|不是内部或外部命令|enoent.*spawn/i.test(head)) return 'launch';
  if (/NOT_FOUND|未检测到|无法定位/i.test(head)) return 'not_found';
  if (/timeout|timed out|ETIMEDOUT|超时|没有新数据/i.test(head)) return 'timeout';
  // 限流放在网关之前：真撞过额度时，绝不能因为消息里顺带出现 upstream 字样
  // 就把它降级成"网关的锅"——那会让冷却失效，用户会一直锤同一扇门。
  if (rateLimitShaped(head) || rateLimitShaped(full)) return 'rate_limit';
  if (gatewayShaped(head) || gatewayShaped(full)) return 'gateway';
  return 'other';
}

function init(dir) {
  filePath = path.join(dir, 'usage.jsonl');
  events = [];
  let raw = '';
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (e) { return; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch (e) { /* 半行，忽略 */ }
  }
}

function record(ev) {
  const at = ev.at || Date.now();
  // 被闸门拦下的这次根本没打到厂商：单独记一笔，不计入次数、不写失败分类、
  // 更不能再把冷却往后推（否则用户反复点，这扇门就永远开不了）。
  if (ev.status === 'blocked') {
    const blocked = { at, memberId: String(ev.memberId || ''), model: String(ev.model || ''), taskKind: String(ev.taskKind || 'unclassified'), status: 'blocked', ms: 0, kind: null };
    events.push(blocked);
    if (filePath) { try { fs.appendFileSync(filePath, JSON.stringify(blocked) + '\n'); } catch (e) { /* noop */ } }
    return blocked;
  }
  const row = {
    at,
    memberId: String(ev.memberId || ''),
    model: String(ev.model || ''),
    taskKind: String(ev.taskKind || 'unclassified'),
    status: ev.status === 'done' ? 'done' : 'fail',
    ms: Number(ev.ms) || 0,
    kind: classifyError({ status: ev.status, output: ev.output, errorKind: ev.errorKind })
  };
  events.push(row);
  if (filePath) {
    try { fs.appendFileSync(filePath, JSON.stringify(row) + '\n'); } catch (e) { /* 盘写失败不该拖垮派单 */ }
  }
  return row;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// 免费档的结论必须说清证据从哪来。"模型 id 里带 free"只是它自己自称，
// 真免费是有额度上限的，上限只有实测才知道；所以 verdict 只由实测事件推出。
function evidenceOf(r) {
  const idClaimsFree = /free/i.test(r.model);
  const rateLimit = r.byKind.rate_limit || 0;
  const gateway = r.byKind.gateway || 0;
  const auth = r.byKind.auth || 0;
  const expired = r.byKind.expired || 0;
  let verdict, note;
  if (rateLimit > 0) { verdict = 'quota-capped'; note = `实测撞过 ${rateLimit} 次限流：有额度上限`; }
  else if (expired > 0) { verdict = 'expired'; note = '实测到订阅/套餐到期：不是限流，重试不会自愈'; }
  else if (auth > 0 && r.ok === 0) { verdict = 'auth-fail'; note = '实测到鉴权失败：要么没登录，要么 key 不对'; }
  else if (gateway > 0 && r.ok === 0) { verdict = 'gateway-down'; note = '实测到网关侧不通：去本机网关加/启渠道，不是这家的门坏了'; }
  else if (r.ok > 0) { verdict = 'ok-observed'; note = '实测成功过'; }
  else { verdict = 'id-only'; note = '还没真打到过厂商，只有模型 id 自称'; }
  return { verdict, note, idClaimsFree, rateLimit, gateway, auth, expired, ok: r.ok, fail: r.fail };
}

function snapshot(now, terminal) {
  const ref = now || Date.now();
  const today = dayKey(ref);
  // 终端观测（他在各家自己终端里敲的）按成员聚合，供下面贴到对应行上；
  // 它和"我派出去的"永远分两笔记，不相加——加在一起就等于把看不见说成看得见。
  const termByMember = new Map();
  const termRows = (terminal && terminal.rows) || [];
  for (const t of termRows) {
    const cur = termByMember.get(t.memberId) || { today: 0, total: 0, ok: 0, fail: 0, partial: false };
    cur.today += t.today || 0; cur.total += t.total || 0; cur.ok += t.ok || 0; cur.fail += t.fail || 0;
    if (t.partial) cur.partial = true;
    termByMember.set(t.memberId, cur);
  }
  const map = new Map();
  for (const e of events) {
    const key = e.memberId + '\u0000' + e.model;
    if (!map.has(key)) {
      map.set(key, {
        memberId: e.memberId, model: e.model,
        free: /free/i.test(e.model),
        today: 0, total: 0, ok: 0, fail: 0, blockedAttempts: 0,
        byKind: {}, byTask: {}, _ms: [], _lastRateLimit: 0
      });
    }
    const r = map.get(key);
    if (e.status === 'blocked') { r.blockedAttempts = (r.blockedAttempts || 0) + 1; continue; }
    r.total++;
    if (dayKey(e.at) === today) r.today++;
    if (e.status === 'done') r.ok++; else r.fail++;
    if (e.kind) {
      r.byKind[e.kind] = (r.byKind[e.kind] || 0) + 1;
      if (e.kind === 'rate_limit' && e.at > r._lastRateLimit) r._lastRateLimit = e.at;
    }
    const t = r.byTask[e.taskKind] || (r.byTask[e.taskKind] = { ok: 0, fail: 0 });
    t[e.status === 'done' ? 'ok' : 'fail']++;
    r._ms.push(e.ms);
  }
  const rows = [...map.values()].map(r => {
    const lastRate = r._lastRateLimit;
    const cooldownUntil = lastRate && ref < lastRate + COOLDOWN_MS ? lastRate + COOLDOWN_MS : 0;
    const tm = termByMember.get(r.memberId) || { today: 0, total: 0, ok: 0, fail: 0, partial: false };
    return {
      memberId: r.memberId, model: r.model, free: r.free,
      today: r.today, total: r.total, ok: r.ok, fail: r.fail, blockedAttempts: r.blockedAttempts,
      byKind: r.byKind, byTask: r.byTask,
      medianMs: median(r._ms.filter(x => x > 0)),
      cooldownUntil,
      blocked: !!cooldownUntil,
      freeEvidence: evidenceOf(r),
      terminalToday: tm.today, terminalTotal: tm.total, terminalPartial: tm.partial
    };
  });
  rows.sort((a, b) => b.total - a.total);
  return {
    now: ref, rows, cooldownMs: COOLDOWN_MS,
    terminalRows: termRows,
    terminalCoverage: (terminal && terminal.coverage) || [],
    terminalTruncated: !!(terminal && terminal.truncated)
  };
}

/** 派单前的闸门：只有限流冷却期内的成员×模型会被拦下。 */
function isBlocked(memberId, model, now) {
  const ref = now || Date.now();
  let last = 0;
  for (const e of events) {
    if (e.memberId === memberId && e.model === model && e.kind === 'rate_limit' && e.at > last) last = e.at;
  }
  if (!last || ref >= last + COOLDOWN_MS) return { blocked: false, until: 0, reason: '' };
  const until = last + COOLDOWN_MS;
  const mins = Math.max(1, Math.ceil((until - ref) / 60000));
  return { blocked: true, until, reason: `${memberId} 的 ${model || '默认模型'} 刚撞上限流，冷却中（剩 ${mins} 分钟）` };
}

/**
 * 一单到底成没成——不能只看退出码。
 *
 * 本机实测的假绿：CodeBuddy 撞到网关报错时把 "503 No available channel …(request id: …)"
 * 打在 stdout 上**退 0**；只看 exit code 的账本于是记成"成功"，结论写成"实测可用"。
 * 判定只认它自己那种"裸错误行"的形状：行首是 4xx/5xx，紧跟一段 ASCII，再出现
 * request id: / (distributor) / No available channel / upstream error 这类字面标记。
 * 这样正文里正常讨论"401 是什么"不会被误杀（中文一断，后面的标记就接不上了）。
 */
const BARE_ERROR_HEAD = /^(?:[45]\d{2}[ \t]+[\x20-\x7E]{0,80}?(?:request id:|\(distributor\)|no available channel|upstream error|too many requests|rate.?limit)|authentication required|api\s*error[:：]|panic:|traceback \(most recent call last\))/i;
function deriveStatus(exitOk, output) {
  if (!exitOk) return 'error';
  const s = String(output == null ? '' : output).replace(/^\uFEFF/, '').trim();
  if (!s) return 'done';
  return BARE_ERROR_HEAD.test(s) ? 'error' : 'done';
}

module.exports = { init, record, snapshot, isBlocked, classifyError, deriveStatus, COOLDOWN_MS };
