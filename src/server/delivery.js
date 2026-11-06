// 交付闭环：一单跑完之后，"到底交付了什么"由我们自己称，不听成员自述。
//
// 为什么需要：卡片只回答"跑完了 / 退出码 / 它说了什么"。你要验收还得把整段输出读完，
// 或者自己去翻目录——"这一段我能不能不管了"正卡在这一步。
// 所以结论的三个来源都是盘上事实：文件层（快照差异）、git 层（它自己 status 的话）、
// 外加一条明确判词：成员说"我已经创建好了"而盘上零变化，判"只动了嘴"。
//
// 两条纪律：
//   1. 只取路径与大小，**绝不读文件正文**——正文既可能含隐私，也能把结论撑爆。
//   2. 一切有界。目录能长到几百万文件，触顶就标 partial，报出来的数是"至少"。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__']);
const DEFAULT_MAX_FILES = 4000;

function toRel(root, full) {
  return path.relative(root, full).split(path.sep).join('/');
}

// 点目录是各家 harness 自己的运行时痕迹（.qoder-credits、.claude、.next…），
// 不是这一单的产出——2026-11-07 就是把 `.qoder-credits/report.json` 当成了"有交付"，
// 而成员其实回的是"需要您授权写入权限才能创建该文件"。
// 顶层点文件（.gitignore、.env.example）保留：那常常就是真产出。
function isToolInternal(relPath) {
  const segs = String(relPath || '').split('/');
  return segs.slice(0, -1).some(seg => seg.startsWith('.'));
}

/**
 * 目录快照：只记路径 + 大小 + mtime，不碰正文。
 * visited 按 realpath 去重——E 盘上大量 junction 会指回上层，不挡就无限递归。
 */
function snapshotDir(dir, opts) {
  const o = opts || {};
  const maxFiles = Number(o.maxFiles) || DEFAULT_MAX_FILES;
  const files = [];
  const visited = new Set();
  let truncated = false;
  let rootReal = dir;
  try { rootReal = fs.realpathSync(dir); } catch (e) { /* 目录读不到时按原样走 */ }
  visited.add(rootReal);

  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of ents) {
      if (files.length >= maxFiles) { truncated = true; break; }
      const name = ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name) || name === '.git') continue;
        const p = path.join(cur, name);
        let real = p;
        try { real = fs.realpathSync(p); } catch (e) { /* 断链就跳过 */ }
        if (visited.has(real)) continue; // junction/符号链接指回已走过的地方
        visited.add(real);
        stack.push(p);
        continue;
      }
      if (!ent.isFile()) continue;
      const p = path.join(cur, name);
      const rel = toRel(dir, p);
      if (isToolInternal(rel)) continue; // 成员自己的运行时痕迹不算交付
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      files.push({ path: rel, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { dir, files, truncated };
}

function index(files) {
  const m = new Map();
  for (const f of files) m.set(f.path, f);
  return m;
}

/** 两次快照的差异。changed 只看大小或 mtime，不看内容（内容我们根本不再读）。 */
function diff(before, after) {
  const a = index(before.files);
  const b = index(after.files);
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [p, f] of b) {
    const old = a.get(p);
    if (!old) added.push({ path: p, size: f.size });
    else if (old.size !== f.size || Math.abs(old.mtimeMs - f.mtimeMs) > 1500) modified.push({ path: p, size: f.size });
  }
  for (const [p, f] of a) if (!b.has(p)) deleted.push({ path: p, size: f.size });
  const cmp = (x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0);
  return {
    added: added.sort(cmp),
    modified: modified.sort(cmp),
    deleted: deleted.sort(cmp),
    partial: !!(before.truncated || after.truncated)
  };
}

function count(d) {
  return (d && ((d.added || []).length + (d.modified || []).length + (d.deleted || []).length)) || 0;
}

/**
 * git 层：问 git 自己"工作区动没动"。用 execFileSync + 参数数组，绝不经过 shell。
 * git 不存在 / 不是仓库 / 目录不可读，都如实返回 isRepo=false 并带一句原因。
 */
function gitInfo(dir) {
  const out = { isRepo: false, head: '', status: [], count: 0, error: '' };
  const run = args => cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 10000 });
  try {
    out.head = String(run(['rev-parse', 'HEAD'])).trim();
  } catch (e) {
    out.error = e && e.code === 'ENOENT' ? '这台机器上没有 git，文件层结论未经 git 交叉验证' : '这个目录不是 git 仓库';
    return out;
  }
  out.isRepo = true;
  try {
    const por = String(run(['status', '--porcelain'])).split(/\r?\n/).filter(Boolean);
    out.status = por.map(line => ({
      xy: line.slice(0, 2).trim() || '?',
      path: line.slice(3).trim()
    }));
    out.count = out.status.length;
  } catch (e) {
    out.error = 'git status 失败：' + (e && e.message ? e.message.slice(0, 80) : String(e));
  }
  return out;
}

const MAX_ARTIFACTS = 30;

// 拒绝写盘的信号。2026-11-07 一晚上被同一件事的三种措辞打过：
//   「需要您授权写入权限才能创建该文件」/「等待您的权限批准来创建该文件」/
//   「写入被权限阻止，需要确认是否允许写入该路径」——短语枚举必然一直漏，
//   因为这句话是模型自由生成的。所以判据改成结构性的：
//   **零变化 + 正文里出现权限类词**，并且判词只说"可能"，把依据词带出来，不装作确定。
//   误判代价很低：blocked_by_permission 与 talked_only 都说"这一单没交付东西"，
//   区别只在于要不要顺手给去路。
const PERMISSION_WORDS = /(权限|授权|批准|许可|允许|permission|approval|authorize|denied)/i;

/**
 * 把两层证据合成一句人话 + 一句有据可查的下一步。
 * verdict：produced（盘上真变了）/ talked_only（它说了，但盘上没变）/ failed（没跑成）
 */
function summarize(ev) {
  const d = ev.diff || { added: [], modified: [], deleted: [] };
  const gb = ev.gitBefore || {};
  const ga = ev.gitAfter || {};
  const n = count(d);
  const artifacts = []
    .concat((d.added || []).map(x => ({ ...x, what: '新增' })))
    .concat((d.modified || []).map(x => ({ ...x, what: '改动' })))
    .concat((d.deleted || []).map(x => ({ ...x, what: '删除' })));

  const grew = (ga.count || 0) > (gb.count || 0);
  if (ev.status !== 'done') {
    return {
      verdict: 'failed', changed: n, partial: !!d.partial, artifacts: [],
      headline: '没跑成，没有交付物可称',
      reason: '这一单不是完成态，文件层的差异只在"跑完"时才有意义。',
      next: '换一扇绿的门重派，或者点开这张卡片看它的报错原文。'
    };
  }
  if (n === 0 && !grew) {
    if (PERMISSION_WORDS.test(String(ev.output || ''))) {
      return {
        verdict: 'blocked_by_permission', changed: 0, partial: !!d.partial, artifacts: [],
        headline: '文件没变化（0 个）· 正文提到权限',
        reason: '可能是被权限档拦住了（这一单零变化，而它的回答里出现了权限/授权类的词）。无头模式没有审批通道，保守档就是这个表现。如果你本来就只想要一个回答，这条可以忽略。',
        next: '要它真动手：设置里给这扇门切到 acceptEdits/auto-edit 一档（风险自担），或者把任务改成只读产出（只回答、不写文件）。'
      };
    }
    return {
      verdict: 'talked_only', changed: 0, partial: !!d.partial, artifacts: [],
      headline: '文件没变化（0 个）' + (ga.isRepo ? ' · git 也没动' : ''),
      reason: '它自述做了事，但盘上零变化：要么这一单本来就只是回答问题，要么它的写入被权限模式拦住了。',
      next: '盘上没有任何变化 —— 这段其实什么都没发生。要它真动手，就在设置里给这扇门开更宽的权限档，风险自担。'
    };
  }
  const list = artifacts.slice(0, MAX_ARTIFACTS);
  const gitNote = ga.isRepo ? ` · git 未提交改动 ${gb.count || 0} → ${ga.count || 0} 条` : '';
  const headline = `文件${d.partial ? '（至少）' : ''} 新增 ${(d.added || []).length} · 改动 ${(d.modified || []).length} · 删除 ${(d.deleted || []).length}` + gitNote;
  let next = '先看这几个：' + list.slice(0, 3).map(x => x.what + ' ' + x.path).join('、');
  if (ga.isRepo && (ga.count || 0) > 0) next += `；有 ${ga.count} 条未提交改动（git status 说的），要留就 commit，别让它悬在工作区里。`;
  else if (artifacts.length > list.length) next += `；还有 ${artifacts.length - list.length} 个文件没列出来。`;
  return {
    verdict: 'produced', changed: n, partial: !!d.partial, artifacts: list,
    headline, next,
    reason: d.partial
      ? '目录超过扫描上限，这里的数是"至少"，实际变化可能更多。'
      : `盘上称出来 ${n} 个文件变化${grew ? `，git 侧也从 ${gb.count || 0} 条涨到 ${ga.count || 0} 条` : ''}——两个来源都指向同一件事。`
  };
}

// 体检探针是只读的，不该产生交付结论（否则每天 11 条"零产出"噪音）。
function shouldAttach(task) {
  if (!task) return false;
  if (task.quiet) return false;
  if (task.taskKind === 'health') return false;
  return true;
}

module.exports = { snapshotDir, diff, gitInfo, summarize, shouldAttach, count, SKIP_DIRS, DEFAULT_MAX_FILES, MAX_ARTIFACTS };
