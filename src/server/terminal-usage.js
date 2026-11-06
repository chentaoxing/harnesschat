// 终端用量扫描器：把"他在各家自己的终端里手敲掉的那部分"从各家转录里读出来。
//
// 为什么需要：账本原来只记我从群里派出去的调用。他不在群里派的活我看不见，
// 于是面板上"今天 cline 只用了 2 次"是假象，闸门和路由就建在假数据上。
//
// 两条硬规矩（都来自这个仓库踩过的坑）：
//   1. 只统计能逐条归因到某个模型的记录。归因不了的（Codex 存成 .zst、Claude 的
//      <synthetic> 消息）宁可标"未统计"，也不许当成 0 次——把"看不见"报成
//      "没用过"是最坏的一种假绿。
//   2. 有界。转录目录能长到几百 MB，扫描要带时间窗、文件数和字节上限，
//      触顶时必须置 truncated，让下游显示"至少 N 次"而不是一个精确的假数。
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 7;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 400;

function defaultHomes() {
  const h = os.homedir();
  return { zcode: h, claude: h };
}

function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function walk(dir, pattern, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, pattern, out);
    else if (ent.isFile() && pattern.test(ent.name)) out.push(p);
  }
  return out;
}

// 只留时间窗内改过的文件——转录目录里九成是几年前的死文件，逐字节读它们是浪费。
function withSize(files, mtimeAfter) {
  const res = [];
  for (const p of files) {
    try {
      const s = fs.statSync(p);
      if (mtimeAfter && s.mtimeMs < mtimeAfter) continue;
      res.push({ p: p, size: s.size });
    } catch (e) { /* 权限或竞态：跳过 */ }
  }
  return res;
}

function parseTs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// 一次模型往返的记账：key 是"成员 + 它自己写明的模型 id"。
// 归因不到模型就不产行——宁可少一条，也不产一条假的。
function addCall(buckets, memberId, model, at, ok, ms, ctx) {
  if (!model) return;
  const key = memberId + ' ' + model;
  let b = buckets.get(key);
  if (!b) {
    b = { memberId: memberId, model: model, source: 'terminal', total: 0, today: 0, ok: 0, fail: 0, ms: [] };
    buckets.set(key, b);
  }
  b.total++;
  if (dayKey(at) === ctx.todayKey) b.today++;
  if (ok) b.ok++; else b.fail++;
  if (ms > 0) b.ms.push(ms);
}

// 逐行读，不把整个文件读成一个字符串：这些转录的每一行都塞着完整请求/响应体，
// 单行能到 600KB、单文件到 47MB，一次性 readFileSync 会把主进程内存顶起来。
function forEachLine(file, cb) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return false; }
  const buf = Buffer.alloc(1024 * 1024);
  let rest = '';
  try {
    for (;;) {
      let n;
      try { n = fs.readSync(fd, buf, 0, buf.length, null); } catch (e) { return false; }
      if (!n) break;
      rest += buf.toString('utf8', 0, n);
      let nl;
      while ((nl = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        if (line.trim()) cb(line);
      }
    }
    if (rest.trim()) cb(rest); // 末行没有换行符（转录被截断时就是这样）
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* 已关闭 */ }
  }
  return true;
}

// 有界读取：文件数或字节数触顶就停，并把 ctx.truncated 置上。
// 触顶后给的数只能是"至少"，绝不能当精确值往外报。
// 上限按本机实测放宽到能一次装下当前这批转录（ZCode 三家文件合计 ~58MB）；
// 之前用 24MB 时 91 次往返只数到 17 次——那不是"保守"，那是把数报小。
function consume(files, ctx, onRecord) {
  let n = 0;
  for (const f of files) {
    if (n >= ctx.maxFiles) { ctx.truncated = true; break; }
    if (ctx.bytes + f.size > ctx.maxBytes) { ctx.truncated = true; break; }
    ctx.bytes += f.size;
    n++;
    forEachLine(f.p, line => {
      let j;
      try { j = JSON.parse(line); } catch (e) { return; } // 半行/坏行：跳过，不抛
      onRecord(j, ctx);
    });
  }
}

// ZCode：一条 type=model_io 记录 = 它自己发的一次模型请求，模型 id 是它写下的。
function scanZcode(home, ctx) {
  const dir = path.join(home, '.zcode', 'cli', 'rollout');
  const files = withSize(walk(dir, /^model-io-.*\.jsonl$/, []), ctx.after);
  consume(files, ctx, (j, c) => {
    if (j.type !== 'model_io') return;
    const at = parseTs(j.startedAt || j.completedAt);
    if (!at || at < c.after) return;
    const model = j.model && j.model.modelId;
    addCall(c.buckets, 'zcode', model, at, !j.error, Number(j.durationMs) || 0, c);
  });
}

// Claude Code：assistant 记录带 message.model；<synthetic> 是没打模型的占位，不算往返。
function scanClaude(home, ctx) {
  const dir = path.join(home, '.claude', 'projects');
  const files = withSize(walk(dir, /\.jsonl$/, []), ctx.after);
  consume(files, ctx, (j, c) => {
    if (j.type !== 'assistant') return;
    const model = j.message && j.message.model;
    if (!model || model === '<synthetic>') return;
    const at = parseTs(j.timestamp);
    if (!at || at < c.after) return;
    addCall(c.buckets, 'claude', model, at, !j.isApiError, Number(j.durationMs) || 0, c);
  });
}

// 只有逐条能归因到模型的转录才进来。Codex 目前存 .jsonl.zst，且一轮里几次往返
// 分不开，所以它出现在 coverage 里标"未统计"，而不是被我猜一个数。
const SCANNERS = { zcode: scanZcode, claude: scanClaude };

function coverage(opts) {
  const o = opts || {};
  const homes = Object.assign({}, defaultHomes(), o.homes || {});
  const ids = Array.from(new Set(Object.keys(homes).concat(Object.keys(SCANNERS)).concat(o.memberIds || []))).sort();
  return ids.map(id => (SCANNERS[id]
    ? { memberId: id, status: 'counted', note: '逐条归因：一条模型往返记录算一次' }
    : { memberId: id, status: 'uncovered', note: '终端用量未统计：认不出它的转录布局，不猜' }));
}

function scan(opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const days = o.days || DEFAULT_DAYS;
  const homes = Object.assign({}, defaultHomes(), o.homes || {});
  const ctx = {
    now: now, after: now - days * DAY, todayKey: dayKey(now),
    buckets: new Map(), bytes: 0,
    maxBytes: o.maxBytes || DEFAULT_MAX_BYTES,
    maxFiles: o.maxFiles || DEFAULT_MAX_FILES,
    truncated: false
  };
  for (const id of Object.keys(SCANNERS)) {
    try { SCANNERS[id](homes[id], ctx); } catch (e) { /* 一家读不动不能带走整块 */ }
  }
  const partial = ctx.truncated;
  const rows = Array.from(ctx.buckets.values()).map(b => ({
    memberId: b.memberId, model: b.model, source: 'terminal',
    total: b.total, today: b.today, ok: b.ok, fail: b.fail,
    medianMs: median(b.ms), partial: partial
  }));
  rows.sort((a, b) => b.total - a.total);
  return {
    rows: rows,
    coverage: coverage({ homes: homes, memberIds: o.memberIds }),
    truncated: partial,
    days: days,
    scannedAt: now,
    bytes: ctx.bytes
  };
}

// 面板会反复刷，盘上的转录不该跟着被反复读。默认 60 秒内复用同一份结果；
// 派完单一笔要立刻看得见，所以另外提供 invalidate()（finishTask 之后调用）。
// 缓存按自然日分键：跨天了"今天"的口径变了，必须重扫。
const CACHE_TTL_MS = 60 * 1000;
let cache = null;
function scanCached(opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const key = dayKey(now);
  if (!o.force && cache && cache.key === key && now - cache.at < CACHE_TTL_MS) return cache.value;
  const value = scan(Object.assign({}, o, { now }));
  cache = { key, at: now, value };
  return value;
}
function invalidate() { cache = null; }

module.exports = { scan, scanCached, invalidate, coverage, defaultHomes, SCANNERS, DEFAULT_DAYS, DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES };