// 自研更新器（方案沿用 ai-novel-ide 的 updater.ts，那套是真机踩过坑的）：
// 1. 一切网络走 Electron net.request —— 自动跟随系统代理。
//    Node 的 global fetch(undici) 不读系统代理也不读 HTTPS_PROXY，在这台机器的网络环境里直连 GitHub 会挂。
// 2. 检查双路线：GitHub API（本仓 public，匿名即可；有 token 更好）→ 失败/限流回退 releases.atom。
//    api.github.com 匿名配额是按出口 IP 算的，走代理时很容易吃 403 rate limit，atom 走 github.com 不占配额。
// 3. 下载：.part 临时文件 + rename 原子落盘、45s 无数据看门狗、总时长硬顶、host 白名单、路径边界校验。
const { app, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const OWNER_REPO = 'chentaoxing/harnesschat';
const CHECK_TIMEOUT_MS = 25000;          // 检查请求硬超时（挂死的检查会永久占住锁）
const DOWNLOAD_IDLE_MS = 45000;          // 下载 45s 收不到新字节就掐断
const DOWNLOAD_TOTAL_MS = 10 * 60 * 1000; // 下载总时长硬顶
const DOWNLOAD_STALE_MS = 5 * 60 * 1000;  // 忙锁过期：陈旧锁强制接管
const MIN_INSTALLER_BYTES = 1024 * 1024;
const ALLOWED_HOSTS = /^(api\.github\.com|codeload\.github\.com|([a-z0-9-]+\.)*githubusercontent\.com|github\.com)$/i;

let downloadLockAt = 0;

// ---------- 基础工具 ----------
function versionTuple(v) {
  const n = String(v || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  return [n[0] || 0, n[1] || 0, n[2] || 0];
}
function isNewer(a, b) {
  const A = versionTuple(a), B = versionTuple(b);
  return A[0] !== B[0] ? A[0] > B[0] : A[1] !== B[1] ? A[1] > B[1] : A[2] > B[2];
}

// token 只从显式位置读（环境变量 / 本应用自己的数据目录），绝不去翻别的工具的凭据
function readToken() {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env && env.trim()) return env.trim();
  try {
    const p = path.join(app.getPath('userData'), 'github-token.txt');
    if (fs.existsSync(p)) {
      const first = fs.readFileSync(p, 'utf8').split(/\r?\n/)[0];
      if (first && first.trim()) return first.trim();
    }
  } catch (e) { /* 忽略 */ }
  return null;
}

// ---------- net.request 封装 ----------
/** GET 一个 URL，返回 {status, body}；非 2xx 不抛错（调用方要按 403/404 分流）。硬超时必掐。 */
function netGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url, headers: { 'User-Agent': 'harnesschat-updater', ...(headers || {}) } });
    let settled = false;
    let body = '';
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(to); fn(); };
    const to = setTimeout(() => {
      try { req.abort(); } catch (e) { /* 已断 */ }
      finish(() => reject(new Error(`超时(${Math.round(CHECK_TIMEOUT_MS / 1000)}s)：${new URL(url).host}`)));
    }, CHECK_TIMEOUT_MS);
    req.on('redirect', () => { /* net.request 自行跟随，重定向不视为异常 */ });
    req.on('response', (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => finish(() => resolve({ status: res.statusCode, body })));
      res.on('error', (e) => finish(() => reject(e)));
    });
    req.on('error', (e) => finish(() => reject(e)));
    req.end();
  });
}

// ---------- 版本源 ----------
/** API 路线：releases/latest。公开仓匿名可用；403 限流 / 404 无发布都交给调用方兜。 */
async function checkViaApi() {
  const headers = { Accept: 'application/vnd.github+json' };
  const token = readToken();
  if (token) headers.Authorization = 'token ' + token;
  const r = await netGet(`https://api.github.com/repos/${OWNER_REPO}/releases/latest`, headers);
  if (r.status === 404) return { none: true };
  if (r.status === 403) throw new Error(`GitHub API 限流(HTTP 403${/rate limit/i.test(r.body) ? '，配额按出口 IP 计' : ''})`);
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 80)}`);
  let j;
  try { j = JSON.parse(r.body); } catch (e) { throw new Error('API 响应不是 JSON：' + r.body.slice(0, 60)); }
  if (j.draft) return { none: true };
  const assets = j.assets || [];
  const asset = assets.find((a) => /setup.*\.exe$/i.test(a.name || '')) || assets[0];
  return {
    version: String(j.tag_name || '').replace(/^v/i, ''),
    notes: j.body || '',
    htmlUrl: j.html_url,
    assetUrl: asset ? asset.browser_download_url : null,
    assetName: asset ? asset.name : null,
    source: 'api'
  };
}

/** Atom 兜底路线：github.com/releases.atom 不占 API 配额，只有 tag 页链接，没有资产直链。 */
async function checkViaAtom() {
  const r = await netGet(`https://github.com/${OWNER_REPO}/releases.atom`);
  if (r.status !== 200) throw new Error(`atom HTTP ${r.status}`);
  const entry = r.body.slice(r.body.indexOf('<entry>'));
  const link = /<link[^>]*href="(https:\/\/github\.com\/[^"]*\/releases\/tag\/[^"]+)"/.exec(entry);
  if (!link) return { none: true }; // 还没有任何 release
  const tag = decodeURIComponent(link[1].split('/releases/tag/')[1] || '');
  return {
    version: tag.replace(/^v/i, ''),
    tag,
    notes: '',
    htmlUrl: link[1],
    assetUrl: null,
    assetName: null,
    source: 'atom'
  };
}

/** 双路线取最新版本：API 优先，限流/异常回退 atom；两条都失败才报错。 */
async function fetchLatest() {
  const errors = [];
  try {
    const viaApi = await checkViaApi();
    if (viaApi && !viaApi.none) return viaApi;
    if (viaApi && viaApi.none) {
      // API 明确说"还没有 release"：这就是答案，不用 atom 再猜
      const err = new Error('GitHub 上还没有发布版本');
      err.noReleaseYet = true;
      throw err;
    }
  } catch (e) {
    if (e.noReleaseYet) throw e;
    errors.push('API: ' + String((e && e.message) || e));
  }
  try {
    const viaAtom = await checkViaAtom();
    if (viaAtom && !viaAtom.none) return viaAtom;
    const err = new Error('GitHub 上还没有发布版本');
    err.noReleaseYet = true;
    throw err;
  } catch (e) {
    if (e.noReleaseYet && errors.length) {
      // 匿名配额耗尽时 atom 也拿不到东西：把两条一起说清楚，别只报限流
      e.message = 'GitHub 上还没有发布版本（API: ' + errors[0] + '）';
    }
    throw e;
  }
}

/** atom 路线补资产直链：抓 release 页的 expanded_assets 片段（同样不占 API 配额）。 */
async function resolveAssetUrl(release) {
  if (release.assetUrl) return release.assetUrl;
  const tag = release.tag || release.version;
  if (!tag) return null;
  try {
    const r = await netGet(`https://github.com/${OWNER_REPO}/releases/expanded_assets/${encodeURIComponent(tag)}`);
    if (r.status !== 200) return null;
    const hrefs = Array.from(r.body.matchAll(/href="(\/[^"]*\/releases\/download\/[^"]+)"/g)).map((m) => m[1]);
    if (!hrefs.length) return null;
    const pick = hrefs.find((h) => /setup.*\.exe$/i.test(h)) || hrefs[0];
    return 'https://github.com' + pick;
  } catch (e) {
    return null;
  }
}

// ---------- 下载与安装 ----------
function assertDownloadUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error('非法下载 URL：' + String(raw).slice(0, 80)); }
  if (u.protocol !== 'https:') throw new Error('仅允许 https 下载：' + u.protocol);
  if (!ALLOWED_HOSTS.test(u.hostname.toLowerCase())) throw new Error('下载源不在白名单：' + u.hostname);
  return u;
}

/** 下载到 temp（.part + rename 原子写），进度回调 0-100，返回落盘路径。 */
function downloadFile(url, dest, onProgress) {
  assertDownloadUrl(url);
  return new Promise((resolve, reject) => {
    const part = dest + '.part';
    const req = net.request({ method: 'GET', url, headers: { 'User-Agent': 'harnesschat-updater' } });
    let settled = false, idleAbort = false, done = 0, total = 0, lastPct = -1;
    let idleTimer = null;
    const capTimer = setTimeout(() => { try { req.abort(); } catch (e) { /* 已断 */ } }, DOWNLOAD_TOTAL_MS);
    const clearTimers = () => { if (idleTimer) clearTimeout(idleTimer); clearTimeout(capTimer); };
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idleAbort = true; try { req.abort(); } catch (e) { /* 已断 */ } }, DOWNLOAD_IDLE_MS);
    };
    const out = fs.createWriteStream(part);
    const fail = (msg) => {
      if (settled) return;
      settled = true; clearTimers();
      out.destroy();
      try { if (fs.existsSync(part)) fs.unlinkSync(part); } catch (e) { /* 占用就留给下次 */ }
      reject(new Error(msg));
    };
    req.on('redirect', resetIdle);
    req.on('response', (res) => {
      if (res.statusCode !== 200) return fail(`下载失败：HTTP ${res.statusCode}`);
      resetIdle();
      total = Number(res.headers['content-length'] || 0);
      if (total && total < MIN_INSTALLER_BYTES) return fail(`安装包尺寸异常（${total} B），已放弃`);
      res.on('data', (chunk) => {
        resetIdle();
        out.write(chunk);
        done += chunk.length;
        if (total > 0) {
          const pct = Math.min(99, Math.round((done / total) * 100));
          if (pct !== lastPct) { lastPct = pct; if (onProgress) onProgress(pct + '%'); }
        } else if (onProgress) {
          onProgress((done / 1048576).toFixed(1) + ' MB');
        }
      });
      res.on('end', () => {
        if (settled) return;
        clearTimers();
        out.end(() => {
          if (settled) return;
          settled = true;
          let size = 0;
          try { size = fs.statSync(part).size; } catch (e) { return reject(new Error('下载文件丢失：' + e.message)); }
          if (size < MIN_INSTALLER_BYTES) { try { fs.unlinkSync(part); } catch (e) { /* noop */ } return reject(new Error(`安装包过小（${size} B），已丢弃`)); }
          if (total && size !== total) { try { fs.unlinkSync(part); } catch (e) { /* noop */ } return reject(new Error(`下载不完整（${size}/${total} B），请重试`)); }
          try { fs.renameSync(part, dest); } catch (e) { return reject(new Error('落盘失败：' + e.message)); }
          if (onProgress) onProgress('100%');
          resolve(dest);
        });
      });
      res.on('error', (e) => fail(String((e && e.message) || e)));
    });
    req.on('error', (e) => fail(idleAbort
      ? `下载中断：${Math.round(DOWNLOAD_IDLE_MS / 1000)}s 没有新数据（可重试）`
      : String((e && e.message) || e)));
    req.end();
  });
}

// ---------- IPC 面 ----------
function friendlyError(e) {
  const msg = String((e && e.message) || e || '');
  if (/timeout|超时/i.test(msg)) return '网络超时，请检查代理/网络后重试';
  if (/403|rate limit|限流/i.test(msg)) return 'GitHub 匿名配额已用完（走代理时常见）；在数据目录放 github-token.txt 可解决';
  return msg;
}

async function check() {
  const current = app.getVersion();
  try {
    const latest = await fetchLatest();
    return {
      ok: true, current, latest: latest.version,
      updateAvailable: isNewer(latest.version, current),
      htmlUrl: latest.htmlUrl, assetName: latest.assetName, source: latest.source
    };
  } catch (e) {
    return { ok: false, current, error: friendlyError(e), noReleaseYet: !!e.noReleaseYet, htmlUrl: null };
  }
}

async function downloadAndRun(progressCb) {
  const busyFor = Date.now() - downloadLockAt;
  if (downloadLockAt && busyFor < DOWNLOAD_STALE_MS) {
    return { ok: false, error: `已有下载在进行中（${Math.round(busyFor / 1000)}s），请等它完成` };
  }
  downloadLockAt = Date.now();
  try {
    const latest = await fetchLatest();
    const url = await resolveAssetUrl(latest);
    if (!url) {
      // 拿不到直链也要有用：把发布页交出去，用户自己点两下就装上了
      if (latest.htmlUrl) { await shell.openExternal(latest.htmlUrl); return { ok: false, openedReleasePage: true, error: '没找到安装包直链，已在浏览器打开发布页' }; }
      return { ok: false, error: '最新版本没有安装包' };
    }
    // 外部输入：只取 basename + 字符白名单 + temp 根目录边界校验，杜绝路径穿越
    const tempRoot = path.resolve(app.getPath('temp'));
    const safeName = path.basename(new URL(url).pathname.split('/').pop() || 'HarnessChat-Setup.exe').replace(/[^\w.\-]/g, '_');
    const dest = path.resolve(tempRoot, safeName);
    if (dest === tempRoot || !dest.startsWith(tempRoot + path.sep)) throw new Error('invalid download path');
    await downloadFile(url, dest, progressCb);
    const openErr = await shell.openPath(dest); // 拉起 NSIS 安装器
    if (openErr) throw new Error('安装器启动失败：' + openErr);
    return { ok: true, path: dest, version: latest.version };
  } catch (e) {
    return { ok: false, error: friendlyError(e) };
  } finally {
    downloadLockAt = 0;
  }
}

module.exports = { check, downloadAndRun, isNewer, fetchLatest, resolveAssetUrl, readToken, OWNER_REPO };
