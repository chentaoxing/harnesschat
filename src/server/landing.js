// 产出落点：成员只负责答，控制台负责把它答出来的东西落成盘上的文件。
//
// 为什么需要：本机 11 扇门里唯一绿的那扇（qoderclicn）在保守权限档下写不了文件——
// 4 次实测 0 产出。于是"派出去 → 走开 → 回来验收"这条链永远断在最后一步。
// 但很多活本来只要一段文字/一段代码/一份新文件，不需要它去改仓库。
// 那种活不该因为成员没有写权限就什么都没有。
//
// 三条纪律：
//   1. 落点 = 它的回答**原文**，不是"它写的文件"。所以绝不参与交付判定，
//      也绝不进交付快照（否则并发的另一单会把我的落点当成它的产出 → 假绿）。
//   2. 文件名来自模型的自由输出，等于不可信输入：穿越、绝对路径、非法字符、
//      保留设备名、重名覆盖，全部要有界，且写盘层再兜一道。
//   3. 一切有上限：块数、单文件体积。触顶就标 truncated，不装作完整。
const fs = require('fs');
const path = require('path');
const { LANDING_DIRNAME } = require('./delivery');

const MAX_BLOCKS = 20;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_NAME_LEN = 120;
const MAX_SEG_LEN = 80;

const EXT_BY_LANG = {
  javascript: 'js', js: 'js', jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx',
  python: 'py', py: 'py', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  json: 'json', yaml: 'yml', yml: 'yml', sql: 'sql', html: 'html', css: 'css', scss: 'scss',
  markdown: 'md', md: 'md', text: 'txt', txt: 'txt', powershell: 'ps1', ps1: 'ps1',
  c: 'c', cpp: 'cpp', 'c++': 'cpp', go: 'go', rust: 'rs', rs: 'rs', java: 'java',
  kotlin: 'kt', swift: 'swift', php: 'php', ruby: 'rb', rb: 'rb', xml: 'xml', toml: 'toml',
  ini: 'ini', diff: 'diff', dockerfile: 'dockerfile'
};

const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const ILLEGAL = /[<>:"|?*\u0000-\u001f]/g;

/**
 * 围栏代码块。判据刻意宽一点：模型经常写到一半被截断，围栏没收口，
 * 那剩下的正文仍然是它答出来的东西，不该整段丢掉。
 */
function extractBlocks(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  // split 会在"文本以换行结尾"时多吐一个空串。那不是内容，留着会让没收口的块
  // 末尾凭空多一行空白（断言里就是这一条红的）。
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out = [];
  let open = null; // { char, len, lang, hint, buf }
  for (const line of lines) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!open) {
      if (m) {
        const info = String(m[2] || '').trim();
        open = { char: m[1][0], len: m[1].length, ...parseInfo(info), buf: [] };
      }
      continue;
    }
    // 收口围栏：同种字符、长度不短于开口、后面除了空白没别的
    if (m && m[1][0] === open.char && m[1].length >= open.len && !String(m[2] || '').trim()) {
      out.push({ lang: open.lang, hint: open.hint, code: open.buf.join('\n') + (open.buf.length ? '\n' : '') });
      open = null;
      continue;
    }
    open.buf.push(line);
  }
  if (open) out.push({ lang: open.lang, hint: open.hint, code: open.buf.join('\n') + (open.buf.length ? '\n' : '') });
  return out;
}

/** 信息串：`python app.py` / `json filename="package.json"` / `python title=src/main.py` */
function parseInfo(info) {
  const s = String(info || '').trim();
  if (!s) return { lang: '', hint: '' };
  const kv = s.match(/(?:filename|file|title|path)\s*=\s*["']?([^\s"']+)["']?/i);
  if (kv) {
    const lang = s.slice(0, kv.index).trim().split(/\s+/)[0] || '';
    return { lang: lang.toLowerCase(), hint: kv[1] };
  }
  const parts = s.split(/\s+/);
  const lang = (parts[0] || '').toLowerCase();
  // 裸文件名：带扩展名、不像语言标注（不是 { } 或 . 开头的装饰）
  const bare = parts.slice(1).find(p => /^[^\s{}<>]+\.[A-Za-z0-9]{1,10}$/.test(p) && !p.startsWith('{'));
  return { lang, hint: bare || '' };
}

/**
 * 模型给的路径一律当不可信输入处理。返回 null = 不采纳，回落到序号名。
 * 允许相对子目录（src/util/x.js 这种是真需求），其余一律挡。
 */
function safeName(hint) {
  let s = String(hint || '').trim().replace(/\\/g, '/');
  if (!s) return null;
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.startsWith('//')) return null;
  const segs = [];
  for (let seg of s.split('/')) {
    if (!seg || seg === '.' || seg === '..') continue;
    seg = seg.replace(ILLEGAL, '').replace(/[\s.]+$/, '').trim();
    if (!seg) continue;
    if (RESERVED.test(seg.split('.')[0])) return null;
    if (seg.length > MAX_SEG_LEN) {
      const dot = seg.lastIndexOf('.');
      const ext = dot > 0 && seg.length - dot <= 11 ? seg.slice(dot) : '';
      seg = seg.slice(0, MAX_SEG_LEN - ext.length) + ext;
    }
    segs.push(seg);
  }
  if (!segs.length) return null;
  let name = segs.join('/');
  if (name.length > MAX_NAME_LEN) name = name.slice(name.length - MAX_NAME_LEN).replace(/^[^/]*\//, '');
  return name || null;
}

function extFor(lang) {
  return EXT_BY_LANG[String(lang || '').toLowerCase()] || 'txt';
}

function clip(content) {
  const s = String(content == null ? '' : content);
  if (Buffer.byteLength(s, 'utf8') <= MAX_FILE_BYTES) return { content: s, clipped: false };
  // 按字节截，别把多字节字符切成半个：截完去掉尾部替换符
  let buf = Buffer.from(s, 'utf8').subarray(0, MAX_FILE_BYTES);
  let out = buf.toString('utf8').replace(/\uFFFD+$/, '');
  return { content: out, clipped: true };
}

function uniqueName(name, used) {
  if (!used.has(name)) { used.add(name); return name; }
  const slash = name.lastIndexOf('/');
  const dirPart = slash >= 0 ? name.slice(0, slash + 1) : '';
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let i = 2; i < 1000; i++) {
    const cand = `${dirPart}${stem}-${i}${ext}`;
    if (!used.has(cand)) { used.add(cand); return cand; }
  }
  const cand = `${dirPart}${stem}-${Date.now()}${ext}`;
  used.add(cand);
  return cand;
}

/**
 * 计划落哪些文件。回答原文永远落一份（有块时也不丢上下文），每个块再各落一份。
 * 这一步纯函数，不碰盘，方便断言。
 */
function planFiles(text) {
  const raw = String(text == null ? '' : text);
  const files = [];
  const used = new Set();
  let truncated = false;

  const ans = clip(raw);
  truncated = truncated || ans.clipped;
  files.push({ name: uniqueName('回答.md', used), content: ans.content, kind: 'answer' });

  const blocks = extractBlocks(raw);
  for (let i = 0; i < blocks.length; i++) {
    if (files.filter(f => f.kind === 'block').length >= MAX_BLOCKS) { truncated = true; break; }
    const b = blocks[i];
    const c = clip(b.code);
    truncated = truncated || c.clipped;
    const named = safeName(b.hint);
    const name = uniqueName(named || `片段-${i + 1}.${extFor(b.lang)}`, used);
    files.push({ name, content: c.content, kind: 'block', lang: b.lang || '' });
  }
  return { files, truncated };
}

function inside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

/** 真的写盘。任何一步失败都如实回 ok=false，不装作落了。 */
function write(opts) {
  const o = opts || {};
  const dir = String(o.dir || '');
  const taskId = String(o.taskId || 'task').replace(ILLEGAL, '').replace(/[.\s/\\]/g, '') || 'task';
  if (!dir || !path.isAbsolute(dir)) return { ok: false, error: '落点需要一个绝对目录', files: [] };
  const taskDir = path.join(dir, LANDING_DIRNAME, taskId);
  try {
    fs.mkdirSync(taskDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: '落点目录建不出来：' + String((e && e.message) || e).slice(0, 160), files: [] };
  }
  const plan = planFiles(o.text);
  const written = [];
  let truncated = plan.truncated;
  for (const f of plan.files) {
    let target = path.join(taskDir, f.name);
    // 写盘层再兜一道：plan 已经消毒过，这里只认"必须在任务目录内"
    if (!inside(taskDir, target)) { truncated = true; continue; }
    let n = 1;
    while (fs.existsSync(target)) {
      const dot = f.name.lastIndexOf('.');
      const stem = dot > 0 ? f.name.slice(0, dot) : f.name;
      const ext = dot > 0 ? f.name.slice(dot) : '';
      const alt = path.join(taskDir, `${stem}-${++n}${ext}`);
      if (!inside(taskDir, alt)) break;
      target = alt;
      if (n > 999) break;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content, 'utf8');
      const st = fs.statSync(target);
      written.push({
        name: path.relative(taskDir, target).split(path.sep).join('/'),
        abs: target, size: st.size, kind: f.kind
      });
    } catch (e) {
      truncated = true;
    }
  }
  if (!written.length) return { ok: false, error: '一个文件都没落下来（目录不可写或全部被挡）', files: [], dir: taskDir };
  return { ok: true, dir: taskDir, files: written, truncated, at: Number(o.now) || Date.now() };
}

/**
 * 什么时候该落：只在"成员自己没产出"时兜底。
 * 它自己写了文件，就别在旁边再堆一份回答；没跑成，报错原文不该被当成交付物；
 * 体检探针和静默任务不落，否则每天 11 份垃圾。
 */
function shouldLand(ev) {
  const e = ev || {};
  if (e.quiet) return false;
  if (e.taskKind === 'health') return false;
  if (e.status !== 'done') return false;
  if (Number(e.changed) > 0 || e.grew) return false;
  return String(e.text == null ? '' : e.text).trim().length > 0;
}

/** 界面"打开"按钮的守卫：只允许落点目录内的绝对路径，别让它变成任意文件打开器。 */
function isOpenable(p) {
  const s = String(p == null ? '' : p);
  if (!s || !path.isAbsolute(s)) return false;
  const segs = s.split(/[\\/]/);
  if (segs.includes('..')) return false;
  return segs.includes(LANDING_DIRNAME);
}

/** 一句人话。必须说清"这是回答原文，不是成员自己写的文件"，否则又变成假绿。 */
function describe(w) {
  if (!w || !w.ok) return '落点没写成：' + String((w && w.error) || '未知原因');
  const n = (w.files || []).length;
  const names = (w.files || []).slice(0, 3).map(f => f.name).join('、');
  return `控制台把它的回答原文落成了 ${n} 个文件（不是它自己写的文件，别当成它动了手）：${names}${n > 3 ? ' 等' : ''}${w.truncated ? '；有内容触顶被截断' : ''}`;
}

module.exports = {
  LANDING_DIRNAME, MAX_BLOCKS, MAX_FILE_BYTES,
  extractBlocks, parseInfo, safeName, planFiles, write, shouldLand, isOpenable, describe
};