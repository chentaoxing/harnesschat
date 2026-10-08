// 外部会话雷达：读各家 harness 自己落在盘上的会话记录，把"哪个会话在哪个目录、
// 最后要它做什么、多久没动、是不是半路死了"摊成一个列表。
//
// 为什么要有这个文件：这个软件存在的理由是"你不在每个终端前盯着，活也能派出去、跑完、看得见"。
// 但它原来只看得见自己派出去的任务——你在终端里跑的会话、跑到一半配额耗尽死掉的会话，它一概不知道，
// 于是"接手一个死掉的会话"只能人肉做：找 session id → 翻 rollout 日志 → 猜它干到哪 → 换一家重讲一遍。
// 这里把那几步变成数据。
//
// 原则：只读，不写别人的目录；每个 harness 一个扫描器，认不出来就不显示，绝不猜。

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const ACTIVE_MS = 3 * 60 * 1000;      // 3 分钟内动过 = 还在跑
const IDLE_MS = 120 * 60 * 1000;      // 2 小时内 = 静默；再久 = 已结束
const HEAD_BYTES = 400 * 1024;        // 只读文件头尾，rollout 单文件能到几十 MB
const TAIL_BYTES = 600 * 1024;
const RAW_WINDOW = 3 * 1024 * 1024;   // 原始文本兜底窗口（关键字正则用，不做 JSON 解析）

function exists(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }

/** 读文件头一行（含首条请求 = 系统提示 + 第一句诉求）。 */
function headLine(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.indexOf(0x0a);
    const one = nl < 0 ? buf : buf.slice(0, nl);
    if (nl < 0 && size > HEAD_BYTES) return null;   // 首行比预算还长，不猜
    return JSON.parse(one.toString('utf8'));
  } catch (e) {
    return null;
  } finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* noop */ } }
}

/** 读文件头若干条可解析记录（找第一条用户诉求用）。 */
function headLines(file, n) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(HEAD_BYTES, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
    if (lines.length && size > len) lines.pop();   // 最后一行可能被预算截断
    const out = [];
    for (const l of lines) {
      try { out.push(JSON.parse(l)); } catch (e) { /* 跳过坏行 */ }
      if (out.length >= n) break;
    }
    return out;
  } catch (e) {
    return [];
  } finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* noop */ } }
}

/** 读文件尾若干行（倒着找第一条能解析的 = 最后几次请求/响应，死因在这里）。 */
function tailLines(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(TAIL_BYTES, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < 8; i--) {
      try { out.push(JSON.parse(lines[i])); } catch (e) { /* 半行或被截断的记录，跳过 */ }
    }
    return out;
  } catch (e) {
    return [];
  } finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* noop */ } }
}

/** 从尾部若干条记录里找"它是怎么停下的"。 */
function endReasonOf(tails) {
  for (const t of tails) {
    const err = t && t.error;
    if (err) return clip(err.message || err.name || JSON.stringify(err), 140);
  }
  return '';
}

/**
 * 系统提示文本。ZCode 的 rollout 里同时存在两种请求体：
 * Anthropic 风格 request.body.system，和 Responses 风格 request.body.input[{role:'system'}]。
 * 只认一种就会把一半会话的工作区读成空。
 */
function systemTextOf(rec) {
  const req = (rec && rec.request) || {};
  const body = req.body || {};
  const chunks = [];
  if (typeof body.system === 'string') chunks.push(body.system);
  else if (Array.isArray(body.system)) chunks.push(...body.system.map(x => (x && x.text) || ''));
  const list = Array.isArray(body.input) ? body.input : (Array.isArray(req.messages) ? req.messages : []);
  for (const m of list) {
    if (m && m.role === 'system') chunks.push(typeof m.content === 'string' ? m.content : textOf(m.content));
  }
  return chunks.join('\n');
}

/** 用户诉求（同样两种形状都吃）。 */
function userTextsOf(rec) {
  const req = (rec && rec.request) || {};
  const body = req.body || {};
  const list = Array.isArray(body.input) ? body.input : (Array.isArray(req.messages) ? req.messages : []);
  const out = [];
  for (const m of list) {
    if (!m || m.role !== 'user') continue;
    const t = (typeof m.content === 'string' ? m.content : textOf(m.content)).trim();
    if (t && !t.startsWith('<')) out.push(t);
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) {
    if (p && typeof p === 'object' && typeof p.text === 'string') parts.push(p.text);
    else if (typeof p === 'string') parts.push(p);
  }
  return parts.join('\n');
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function classify(rec, now) {
  const age = now - rec.lastAt;
  if (rec.endReason) return 'dead';            // 半路死掉：最该被看见
  if (age < ACTIVE_MS) return 'active';
  if (age < IDLE_MS) return 'idle';
  return 'ended';
}

// ---------- ZCode ----------
// ~/.zcode/cli/rollout/model-io-sess_<uuid>.jsonl
// 每条记录是一次模型往返：request.body.system 里有 "Primary working directory: …"，
// 记录上带 error（配额耗尽、连接中断等），这就是"它是怎么死的"的权威来源。
function scanZcode(now, limit) {
  const dir = path.join(HOME, '.zcode', 'cli', 'rollout');
  if (!exists(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(f => /^model-io-sess_.+\.jsonl$/.test(f))
    .map(f => path.join(dir, f))
    .map(f => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch (e) { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.m - a.m)
    .slice(0, limit);

  const out = [];
  for (const { f, m } of files) {
    const head = headLine(f);
    const tails = tailLines(f);
    const last = tails[0] || null;
    // 大会话里"一条记录=整段上下文"，单行能涨到几十 MB，逐行解析必然读不到；
    // 工作区和死因都是明文关键字，直接对文件头尾原始字节做正则兜底。
    const headRaw = readSlice(f, 0, RAW_WINDOW);
    const tailRaw = readSlice(f, -RAW_WINDOW, RAW_WINDOW);
    // 原始文本里的路径是 JSON 转义过的（E:\\Agent\\…），所以捕获要允许反斜杠，之后再统一去转义。
    const wd = /Primary working directory:\s*([^"\r\n]+)/i.exec(systemTextOf(head) + '\n' + systemTextOf(last) + '\n' + headRaw);
    const headAsks = userTextsOf(head);
    const lastAsks = userTextsOf(last);
    let sizeMb = 0;
    try { sizeMb = Math.round(fs.statSync(f).size / 1048576 * 10) / 10; } catch (e) { /* noop */ }
    out.push({
      harness: 'zcode',
      harnessName: 'ZCode',
      id: (head && head.sessionId) || (last && last.sessionId) || path.basename(f).replace(/^model-io-|\.jsonl$/g, ''),
      workspace: wd ? cleanWorkspace(wd[1]) : '',
      lastAt: m,
      minutesAgo: Math.round((now - m) / 60000),
      firstAsk: clip(headAsks[0] || '', 160),
      lastAsk: clip(lastAsks.length ? lastAsks[lastAsks.length - 1] : (headAsks[0] || ''), 160),
      endReason: endReasonOf(tails) || rawErrorOf(tailRaw),
      model: modelOf(last || head),
      file: f,
      sizeMb
    });
  }
  return out;
}

/**
 * 工作区来自模型看到的提示词，可能是 JSON 原文（路径分隔符写成 \\，换行写成 \n）。
 * 先在第一个"行尾 \n"处截断（前面不是反斜杠的那个，避免把 \\node_modules 误伤），再去转义。
 */
function cleanWorkspace(raw) {
  let s = String(raw || '');
  const cut = s.search(/(?<!\\)\\n/);
  if (cut >= 0) s = s.slice(0, cut);
  return s.replace(/\\\\/g, '\\').replace(/[\s"']+$/, '').trim();
}

/** 原始文本里的 error 形状："error":{"name":"X","message":"Y"} —— 取最后一次出现。 */
function rawErrorOf(text) {
  const re = /"error":\{"name":"([^"]*)","message":"([^"]{0,200})"/g;
  let out = '';
  let mm;
  while ((mm = re.exec(text)) !== null) out = `${mm[1]}: ${mm[2]}`;
  return clip(out, 140);
}

/** 读文件的一段（from 为负 = 从尾部倒数）。 */
function readSlice(file, from, len) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = from < 0 ? Math.max(0, size + from) : from;
    const n = Math.min(len, size - start);
    if (n <= 0) return '';
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, start);
    return buf.toString('utf8');
  } catch (e) {
    return '';
  } finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* noop */ } }
}

/** 模型字段在不同形状里分别是字符串和 {modelId, providerId}。 */
function modelOf(rec) {
  const m = rec && (rec.model || (rec.request && rec.request.body && rec.request.body.model));
  if (!m) return '';
  if (typeof m === 'string') return m;
  return [m.providerId, m.modelId].filter(Boolean).join(' / ');
}

// ---------- Claude Code ----------
// ~/.claude/projects/<把路径里的分隔符换成 ->/<uuid>.jsonl：目录名本身就是工作区。
function decodeClaudeDir(name) {
  const m = /^([A-Za-z])--(.*)$/.exec(name);
  if (m) return m[1] + ':' + path.sep + m[2].replace(/--/g, path.sep).replace(/-/g, path.sep);
  return name.replace(/^-/, path.sep).replace(/-/g, path.sep);
}
function scanClaude(now, limit) {
  const root = path.join(HOME, '.claude', 'projects');
  if (!exists(root)) return [];
  const dirs = fs.readdirSync(root).filter(d => exists(path.join(root, d)));
  const files = [];
  for (const d of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, d)); } catch (e) { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(root, d, f);
      try { const st = fs.statSync(full); files.push({ full, workspace: decodeClaudeDir(d), m: st.mtimeMs, size: st.size }); } catch (e) { /* noop */ }
    }
  }
  files.sort((a, b) => b.m - a.m);
  const claudeAsk = (rec) => {
    if (!rec) return '';
    if (rec.type === 'user' && rec.message) return textOf(rec.message.content);
    if (rec.role === 'user') return textOf(rec.content);
    return '';
  };
  return files.slice(0, limit).map(({ full, workspace, m, size }) => {
    const head = headLine(full);
    const tails = tailLines(full);
    const last = tails[0] || null;
    let lastAsk = '';
    for (const t of tails) { const a = claudeAsk(t); if (a) { lastAsk = a; break; } }
    return {
      harness: 'claude',
      harnessName: 'Claude Code',
      id: path.basename(full, '.jsonl'),
      workspace,
      lastAt: m,
      minutesAgo: Math.round((now - m) / 60000),
      firstAsk: clip(claudeAsk(head), 160),
      lastAsk: clip(lastAsk || claudeAsk(head), 160),
      endReason: endReasonOf(tails),
      model: (last && last.model) || (head && head.model) || '',
      file: full,
      sizeMb: Math.round(size / 1048576 * 10) / 10
    };
  });
}

// ---------- Codex ----------
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl：第一条 session_meta.payload 带 cwd，
// 用户诉求在 event_msg/user_message 里。
function scanCodex(now, limit) {
  const root = path.join(HOME, '.codex', 'sessions');
  if (!exists(root)) return [];
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) {
        try { const st = fs.statSync(full); files.push({ full, m: st.mtimeMs, size: st.size }); } catch (err) { /* noop */ }
      }
    }
  };
  walk(root, 0);
  files.sort((a, b) => b.m - a.m);
  const codexAsk = (recs) => {
    for (const r of recs) {
      const p = r && r.payload;
      if (!p) continue;
      if (p.type === 'user_message' && p.message) return String(p.message);
      if (p.type === 'message' && p.role === 'user') return textOf(p.content);
    }
    return '';
  };
  return files.slice(0, limit).map(({ full, m, size }) => {
    const heads = headLines(full, 12);
    const tails = tailLines(full);
    const meta = (heads.find(r => r && r.type === 'session_meta') || {}).payload || {};
    const lastAsk = codexAsk(tails);
    const errRec = tails.find(r => r && (r.type === 'error' || (r.payload && r.payload.type === 'error')));
    return {
      harness: 'codex',
      harnessName: 'Codex',
      id: path.basename(full, '.jsonl'),
      workspace: meta.cwd || '',
      lastAt: m,
      minutesAgo: Math.round((now - m) / 60000),
      firstAsk: clip(codexAsk(heads), 160),
      lastAsk: clip(lastAsk || codexAsk(heads), 160),
      endReason: errRec ? clip(JSON.stringify(errRec.payload || errRec), 140) : '',
      model: meta.model || '',
      file: full,
      sizeMb: Math.round(size / 1048576 * 10) / 10
    };
  });
}

const SCANNERS = [
  { harness: 'zcode', label: 'ZCode', fn: scanZcode },
  { harness: 'claude', label: 'Claude Code', fn: scanClaude },
  { harness: 'codex', label: 'Codex', fn: scanCodex }
];

/**
 * 汇总外部会话。
 * @param {{limitPerHarness?: number, harness?: string}} opts
 */
function listSessions(opts) {
  const o = opts || {};
  const limit = Math.min(Math.max(o.limitPerHarness || 12, 1), 50);
  const now = Date.now();
  const rows = [];
  const scanned = [];
  for (const s of SCANNERS) {
    if (o.harness && o.harness !== s.harness) continue;
    let part = [];
    try { part = s.fn(now, limit) || []; } catch (e) { part = []; }
    scanned.push({ harness: s.harness, label: s.label, found: part.length });
    rows.push(...part);
  }
  for (const r of rows) {
    r.state = classify(r, now);
    r.brief = takeoverBrief(r);   // 接手任务书随列表一起给，渲染层不再复制这套措辞
  }
  rows.sort((a, b) => b.lastAt - a.lastAt);
  return { now, rows, scanned };
}

/**
 * 把一条死掉的会话拼成可以直接派给某个成员的接手任务书。
 * 目的：接手的人（或 agent）不必再去翻日志——工作区、原诉求、它卡在哪、文件都在这儿。
 */
function takeoverBrief(rec) {
  const stateText = { dead: '异常中断', active: '仍在进行', idle: '静默中', ended: '已结束' }[rec.state] || rec.state;
  const lines = [
    `接手一个${stateText}的 ${rec.harnessName} 会话（${rec.id}）。`,
    `它的工作区是 ${rec.workspace || '未知'}，所有改动都应落在这个目录里，不要另起目录。`,
    rec.firstAsk ? `它最初被要求做：${rec.firstAsk}` : '',
    rec.lastAsk && rec.lastAsk !== rec.firstAsk ? `它最后收到的诉求：${rec.lastAsk}` : '',
    rec.endReason ? `它停在这里：${rec.endReason}` : `最后活动：${rec.minutesAgo} 分钟前`,
    '请先用 git status / git diff 看清它已经做到哪一步，再从未完成的部分继续，不要重做已完成的事。',
    `原始转录（只读，需要细节再查）：${rec.file}`
  ].filter(Boolean);
  return lines.join('\n');
}

module.exports = { listSessions, takeoverBrief, SCANNERS, decodeClaudeDir };
