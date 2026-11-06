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
function classifyError(ev) {
  if (ev.status === 'done') return null;
  const full = String(ev.output || ev.errorKind || '');
  const head = full.slice(0, HEADLINE_CHARS);
  if (/expired|coding plan|subscription|套餐/i.test(head)) return 'expired';
  if (/invalid token|token is required|unauthorized|authentication failed|api.?key|missing key/i.test(head)) return 'auth';
  if (/NOT_FOUND|未检测到|无法定位/i.test(head)) return 'not_found';
  if (/timeout|timed out|ETIMEDOUT|超时|没有新数据/i.test(head)) return 'timeout';
  if (rateLimitShaped(head) || rateLimitShaped(full)) return 'rate_limit';
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

function snapshot(now) {
  const ref = now || Date.now();
  const today = dayKey(ref);
  const map = new Map();
  for (const e of events) {
    const key = e.memberId + '\u0000' + e.model;
    if (!map.has(key)) {
      map.set(key, {
        memberId: e.memberId, model: e.model,
        free: /free/i.test(e.model),
        today: 0, total: 0, ok: 0, fail: 0,
        byKind: {}, byTask: {}, _ms: [], _lastRateLimit: 0
      });
    }
    const r = map.get(key);
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
    return {
      memberId: r.memberId, model: r.model, free: r.free,
      today: r.today, total: r.total, ok: r.ok, fail: r.fail,
      byKind: r.byKind, byTask: r.byTask,
      medianMs: median(r._ms.filter(x => x > 0)),
      cooldownUntil,
      blocked: !!cooldownUntil
    };
  });
  rows.sort((a, b) => b.total - a.total);
  return { now: ref, rows, cooldownMs: COOLDOWN_MS };
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

module.exports = { init, record, snapshot, isBlocked, classifyError, COOLDOWN_MS };
