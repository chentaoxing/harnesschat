// HarnessChat 群聊服务器：HTTP REST + WebSocket 广播 + headless 任务执行
// 安全模型：
//   - 子进程一律经 safeExec（argv 数组、无 shell、stdin 关闭）
//   - 只绑 127.0.0.1 + 本地随机 token 鉴权（防止本机其他进程未授权派单）
//   - 静态文件做目录白名单校验
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const { safeExec } = require('./safe-spawn');
const { MEMBERS, buildCustomSpawn, resolveCommand, resolveMemberProgram, listModels } = require('./adapters');
const { Store } = require('./store');
const { listSessions } = require('./sessions');
const usage = require('./usage');
const terminalUsage = require('./terminal-usage');
const health = require('./health');
const delivery = require('./delivery');
const { assertNoForeignCredentials } = require('./guard');

const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');

function id() { return crypto.randomBytes(6).toString('hex'); }

// 体检等一扇门的封顶时间：比成员自己的超时短，但要够慢门（hermes 装依赖实测 138s）跑完
const HEALTH_WAIT_MS = 4 * 60 * 1000;

/**
 * 子进程环境变量白名单。
 * 只放两类：(1) 让 Windows 和一个 CLI 进程能正常起跑的系统变量；(2) 让 CLI 找到
 * 自己配置/登录态的家目录与数据目录变量，以及本机必需的代理变量。
 * 任何密钥形状的变量都不在这里 —— 每个成员用自己的登录，看不到别人的 key。
 * 需要额外放行时在设置里配 envExtra（只写变量名），不写值。
 */
const ENV_KEEP = [
  'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR',
  'TEMP', 'TMP', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'USERNAME', 'USERDOMAIN',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'PYTHONIOENCODING', 'TZ', 'NODE_ENV',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'
];
// 第二道网：万一将来有人往白名单里加了 key 形状的名字，这里也拦掉
const SECRET_SHAPED = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|APIKEY|APISECRET)($|_)|^(GH_TOKEN|GITHUB_TOKEN)$/i;

function childEnv(extra, envExtraNames) {
  // Windows 上变量名大小写不稳定（SystemRoot vs SYSTEMROOT），按大写形式比对
  const keep = new Set(ENV_KEEP.concat(Array.isArray(envExtraNames) ? envExtraNames : []).map(s => String(s).toUpperCase()));
  const out = {};
  for (const [name, v] of Object.entries(process.env)) {
    if (typeof v !== 'string' || !v.length) continue;
    if (!keep.has(name.toUpperCase())) continue;
    if (SECRET_SHAPED.test(name.toUpperCase())) continue;
    out[name] = v;
  }
  // 适配器自己注入的（ELECTRON_RUN_AS_NODE、ZCode 的 provider 路径等）优先级最高
  for (const [k, v] of Object.entries(extra || {})) {
    // 显式置 null = 这个变量必须从子环境里消失（实测 CodeBuddy 留着代理会把登录态误报成未登录）
    if (v === null) { delete out[k.toUpperCase()]; delete out[k]; continue; }
    if (typeof v === 'string' && v.length) out[k] = v;
  }
  return out;
}

class GroupServer {
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.staticDir = opts.staticDir;
    this.port = opts.port || 18790;
    this.token = opts.token || '';
    this.store = new Store(this.dataDir);

    const defaultWorkspace = path.join(os.homedir(), 'HarnessChat工作区');
    this.config = this.store.loadConfig({ workspace: defaultWorkspace, members: {}, membersCustom: [], firstRunAck: false, envExtra: [] });
    try { fs.mkdirSync(this.config.workspace, { recursive: true }); } catch (e) {}

    // 成员 = 内置适配器 + 用户设置覆盖（enabled/defaultModel/timeoutMin/modeId/programPath）
    this.members = MEMBERS.map(m => {
      const patch = this.config.members[m.id] || {};
      const merged = { ...m, ...patch };
      merged.modeId = patch.modeId || (m.modes && m.modes[0].id);
      if (merged.enabled === undefined) merged.enabled = null; // null = 跟随探测结果
      return merged;
    });
    // 自定义成员
    for (const cm of (this.config.membersCustom || [])) {
      this.members.push({
        custom: true,
        modelSupport: cm.modelSupport !== false,
        defaultModel: '',
        timeoutMin: 15,
        ...cm
      });
    }

    this.messages = this.store.loadMessages();
    usage.init(this.dataDir);   // 用量账本与转录同目录，重启后从盘上重算
    health.init(this.dataDir);  // 门体检结果同理
    this.wsClients = new Set();
    this.running = new Map(); // taskId -> child

    this.server = http.createServer((req, res) => this.onHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (this.token && url.searchParams.get('token') !== this.token) { ws.close(); return; }
      this.wsClients.add(ws);
      ws.on('close', () => this.wsClients.delete(ws));
    });
  }

  listen() {
    this.reconcileInterruptedTasks();
    this.scheduleHealth(); // 默认关；他在设置里开了才排定时器
    return new Promise(resolve => this.server.listen(this.port, '127.0.0.1', resolve));
  }

  /**
   * 应用被杀/崩溃/升级重启后，上次还在跑的任务不会再有人写终态：
   * 启动时统一标成 interrupted，否则界面上永远挂着「干活中…」的假卡片，
   * 而「停止」按钮只能杀活着的子进程，对这种僵尸卡片无能为力。
   */
  reconcileInterruptedTasks() {
    let n = 0;
    for (const m of this.messages) {
      if (m.type === 'task' && m.status === 'running') {
        m.status = 'interrupted';
        this.store.appendMessage({ type: 'task_status', taskId: m.id, status: 'interrupted', code: null, at: Date.now() });
        n++;
      }
    }
    if (n) console.log(`[harnesschat] ${n} 个任务因应用重启被中断，已标记为 interrupted`);
  }

  authed(req) {
    if (!this.token) return true;
    const h = req.headers.authorization || '';
    return h === 'Bearer ' + this.token;
  }

  broadcast(event) {
    const data = JSON.stringify(event);
    for (const ws of this.wsClients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  push(msg) {
    this.messages.push(msg);
    this.store.appendMessage(msg);
    this.broadcast({ event: 'message', msg });
    return msg;
  }

  memberById(idv) { return this.members.find(m => m.id === idv); }

  onHttp(req, res) {
    const json = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    };
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/') && !this.authed(req)) {
      return json(401, { error: 'unauthorized' });
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      // 门体检：每扇门最后一次"到底能不能干活"的结论
      return json(200, {
        now: Date.now(),
        rows: health.latest(Date.now()),
        green: health.greenDoors(Date.now(), 24, usage),
        auto: health.autoEnabled(this.config),
        everyHours: health.everyHours(this.config)
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/health/run') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 64 * 1024) req.destroy(); });
      req.on('end', () => {
        let ids = null;
        try { const j = JSON.parse(body || '{}'); if (Array.isArray(j.memberIds)) ids = j.memberIds.filter(x => typeof x === 'string'); } catch (e) { /* 空 body = 全部门 */ }
        this.runHealthCheck(ids).catch(() => {});
        return json(202, { started: true, note: '体检在跑：每扇门一次只读探针，结果逐扇落盘' });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/usage') {
      // 用量账本：哪家今天用了多少、成功失败分类、是否在限流冷却里、免费档的结论从哪来；
      // 另外并一份"他在各家自己终端里敲掉的"观测数（和派单数分两笔记，不相加冒充）。
      const now = Date.now();
      const terminal = terminalUsage.scanCached({ now, days: 7 });
      const snap = usage.snapshot(now, terminal);
      const names = {};
      for (const m of this.members) names[m.id] = m.name;
      return json(200, {
        now: snap.now, cooldownMs: snap.cooldownMs,
        rows: snap.rows.map(r => ({ ...r, memberName: names[r.memberId] || r.memberId })),
        terminalRows: snap.terminalRows.map(t => ({ ...t, memberName: names[t.memberId] || t.memberId })),
        terminalCoverage: snap.terminalCoverage.map(c => ({ ...c, memberName: names[c.memberId] || c.memberId })),
        terminalTruncated: snap.terminalTruncated
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      // 外部会话雷达：读各家 harness 自己落在盘上的会话，供"接手"用
      const n = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '12', 10) || 12, 1), 50);
      try {
        return json(200, listSessions({ limitPerHarness: n, harness: url.searchParams.get('harness') || null }));
      } catch (e) {
        return json(500, { error: String((e && e.message) || e) });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/models') {
      const member = this.memberById(url.searchParams.get('member') || '');
      const r = listModels(member);
      return json(200, r);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(200, {
        workspace: this.config.workspace,
        firstRun: !this.config.firstRunAck,
        members: this.members.map(m => {
          const detected = m.custom ? true : !!resolveMemberProgram(m);
          const modeId = m.modeId || (m.modes && m.modes[0] && m.modes[0].id);
          return {
            id: m.id, name: m.name, color: m.color,
            enabled: m.custom ? m.enabled !== false : (m.enabled === null ? detected : m.enabled),
            custom: !!m.custom, detected,
            modelSupport: m.modelSupport, modelNote: m.modelNote || '', modelHint: m.modelHint || '',
            defaultModel: m.defaultModel || '', note: (m.noteZh || '') + (m.noteEn ? ' | ' + m.noteEn : ''),
            modes: (m.modes || []).map(x => x.id), modeId,
            programPath: (this.config.members[m.id] || {}).programPath || '',
            working: this.isWorking(m.id)
          };
        }),
        membersCustom: this.config.membersCustom || [],
        messages: this.messages
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 512 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const { text, prompt, memberId, threadId, model, cwd, taskKind } = JSON.parse(body);
          return json(200, this.handleSend(String(text || ''), String(prompt || '') || String(text || ''), memberId || null, threadId || null, model || null, cwd || null, taskKind || null));
        } catch (e) { return json(400, { error: String(e.message || e) }); }
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 512 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const s = JSON.parse(body);
          if (s.workspace && !s.workspace.includes('..')) {
            this.config.workspace = s.workspace;
            fs.mkdirSync(s.workspace, { recursive: true });
          }
          if (typeof s.firstRunAck === 'boolean') this.config.firstRunAck = s.firstRunAck;
          if (s.members) {
            for (const [mid, patch] of Object.entries(s.members)) {
              if (!this.memberById(mid)) continue;
              this.config.members[mid] = { ...(this.config.members[mid] || {}), ...patch };
            }
          }
          if (Array.isArray(s.membersCustom)) {
            this.config.membersCustom = s.membersCustom.filter(cm => cm && cm.name && cm.program);
          }
          // 自动体检：默认关；开了才排定时器，改完立刻重排
          if (s.health && typeof s.health === 'object') {
            this.config.health = { auto: s.health.auto === true, everyHours: Number(s.health.everyHours) || 24 };
            this.scheduleHealth();
          }
          // 重载成员表
          this.members = MEMBERS.map(m => {
            const patch = this.config.members[m.id] || {};
            const merged = { ...m, ...patch };
            merged.modeId = patch.modeId || (m.modes && m.modes[0].id);
            if (merged.enabled === undefined) merged.enabled = null;
            return merged;
          });
          for (const cm of (this.config.membersCustom || [])) {
            this.members.push({ custom: true, modelSupport: cm.modelSupport !== false, defaultModel: '', timeoutMin: 15, ...cm });
          }
          this.store.saveConfig(this.config);
          return json(200, { ok: true, workspace: this.config.workspace });
        } catch (e) { return json(400, { error: String(e.message || e) }); }
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { taskId } = JSON.parse(body);
          const child = this.running.get(taskId);
          if (child) { try { child.kill(); } catch (e) {} }
          return json(200, { ok: !!child });
        } catch (e) { return json(400, { error: String(e.message || e) }); }
      });
      return;
    }
    this.serveStatic(url.pathname, res);
  }

  serveStatic(p, res) {
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(this.staticDir, path.normalize(file).replace(/^([.][.][\\/])+/, ''));
    if (!full.startsWith(this.staticDir) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const ext = path.extname(full);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime + (mime.startsWith('text') ? '; charset=utf-8' : '') });
    fs.createReadStream(full).pipe(res);
  }

  isWorking(memberId) {
    for (const m of this.messages) {
      if (m.type === 'task' && m.memberId === memberId && m.status === 'running' && this.running.has(m.id)) {
        return true;
      }
    }
    return false;
  }

  // @提及解析：消息里出现 @名字 或 @id 即视为派单给该成员
  parseMention(text) {
    for (const m of this.members) {
      const re = new RegExp(`@${m.name}(?![\\w\\u4e00-\\u9fff])|@${m.id}(?![\\w\\u4e00-\\u9fff])`, 'i');
      if (re.test(text)) return m;
    }
    return null;
  }

  handleSend(text, prompt, memberId, threadId, modelOverride, cwd, taskKind) {
    const now = Date.now();
    this.push({ id: id(), type: 'user', text, at: now, threadId: threadId || null });

    const member = (memberId && this.memberById(memberId)) || this.parseMention(text);
    if (!member) return { ok: true, dispatched: false };
    const detected = member.custom ? true : !!resolveMemberProgram(member);
    const enabled = member.custom ? member.enabled !== false : (member.enabled === null ? detected : member.enabled);
    if (!enabled) {
      const why = member.custom ? '未启用' : (!detected ? '未检测到，请在群设置里指定路径' : '未启用');
      this.push({ id: id(), type: 'system', text: `「${member.name}」当前不可用：${why}`, at: Date.now() });
      return { ok: true, dispatched: false, reason: 'disabled' };
    }
    const cleanPrompt = prompt
      .replace(new RegExp(`@${member.name}`, 'gi'), '')
      .replace(new RegExp(`@${member.id}`, 'gi'), '')
      .trim() || prompt;
    const tid = threadId || id();
    return { ok: true, dispatched: true, threadId: tid, task: this.runTask(member, cleanPrompt, tid, modelOverride, cwd, taskKind) };
  }

  /**
   * 接手外部死掉的会话时，活必须干在那个会话自己的目录里——
   * 否则"接手"只是把别人的问题在别处重答一遍。只接受已存在的绝对目录，其余一律回落到群工作区。
   */
  static resolveWorkDir(maybeDir, fallback) {
    try {
      const p = String(maybeDir || '').trim();
      if (!p || !path.isAbsolute(p)) return fallback;
      return fs.statSync(p).isDirectory() ? p : fallback;
    } catch (e) {
      return fallback;
    }
  }

  runTask(member, prompt, threadId, modelOverride, cwdOverride, taskKindOverride, opts) {
    const quiet = !!(opts && opts.quiet);
    const model = modelOverride || member.defaultModel || '';
    const workDir = GroupServer.resolveWorkDir(cwdOverride, this.config.workspace);
    const taskKind = String(taskKindOverride || 'unclassified');
    const task = {
      id: id(), type: 'task', threadId, memberId: member.id, memberName: member.name,
      color: member.color, prompt, text: '', status: 'running', at: Date.now(), model,
      cwd: workDir, taskKind, quiet: !!quiet
    };

    // 闸门：刚撞过限流的成员×模型先歇 30 分钟，别拿重试把配额打穿
    const gate = usage.isBlocked(member.id, model);
    if (gate.blocked) {
      task.status = 'error';
      task.text = gate.reason + '（要立刻换一家，直接在群里 @ 别的成员）';
      if (!quiet) this.push(task);
      usage.record({ memberId: member.id, model, taskKind, status: 'blocked', ms: 0 });
      return task;
    }
    if (!quiet) this.push(task);

    const built = member.custom
      ? buildCustomSpawn(member, { prompt, model, cwd: workDir }, resolveCommand)
      : member.buildSpawn({ prompt, model, cwd: workDir }, resolveMemberProgram(member), this.modeArgs(member));
    if (built && built.error) {
      task.status = 'error';
      task.text = built.error === 'NOT_FOUND'
        ? `未检测到 ${member.name}：请确认已安装并在 PATH 上，或在群设置里手动指定可执行文件路径`
        : built.error;
      if (!quiet) { this.store.appendMessage({ type: 'task_status', taskId: task.id, status: 'error', at: Date.now() }); this.broadcast({ event: 'message', msg: { ...task } }); }
      return task;
    }

    // 凭证守卫：别家的凭据文件路径出现在参数或环境里，宁可不派
    try {
      assertNoForeignCredentials(member.id, { args: built.args, env: built.env });
    } catch (e) {
      task.status = 'error';
      task.text = String((e && e.message) || e);
      if (!quiet) { this.store.appendMessage({ type: 'task_status', taskId: task.id, status: 'error', at: Date.now() }); this.broadcast({ event: 'message', msg: { ...task } }); }
      usage.record({ memberId: member.id, model, taskKind, status: 'error', ms: Date.now() - task.at, errorKind: 'blocked by guard' });
      return task;
    }

    // 子进程环境按白名单构造：默认丢弃，而不是默认继承。
    // 原因：这台机器上每个 harness 的 key 都可能在 process.env 里，而成员 CLI 一律靠
    // 自己的登录态/配置目录鉴权（~/.codex、~/.gemini、~/.zcode…），不需要也不该拿到别人的密钥。
    const env = childEnv(built.env || {}, this.config.envExtra);
    // 交付闭环的"起跑前"证据：文件层快照 + git 状态，都在子进程动任何东西之前取。
    // 只有真派单才取（体检探针是只读的，取它等于每天白扫两遍全工作区）。
    if (delivery.shouldAttach(task)) {
      try {
        task._pre = { snap: delivery.snapshotDir(workDir), git: delivery.gitInfo(workDir) };
      } catch (e) {
        task._pre = { error: String((e && e.message) || e).slice(0, 120) };
      }
    }
    let child;
    try {
      child = safeExec(built.file, built.args, { cwd: workDir, env });
    } catch (e) {
      task.status = 'error';
      task.text = '启动失败: ' + e.message;
      if (!quiet) { this.store.appendMessage({ type: 'task_status', taskId: task.id, status: 'error', at: Date.now() }); this.broadcast({ event: 'message', msg: { ...task } }); }
      return task;
    }
    this.running.set(task.id, child);

    const timeoutMs = (member.timeoutMin || 15) * 60 * 1000;
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      this.finishTask(task, 'timeout', child);
    }, timeoutMs);

    let pending = '';
    let flushTimer = null;
    const flush = () => {
      flushTimer = null;
      if (!pending) return;
      const delta = pending; pending = '';
      task.text += delta;
      if (!task.quiet) this.broadcast({ event: 'task_delta', taskId: task.id, text: delta });
      if (!task.quiet) this.store.appendMessage({ type: 'task_delta', taskId: task.id, text: delta, at: Date.now() });
    };
    const onData = (buf) => {
      pending += stripAnsi(buf.toString('utf8'));
      if (!flushTimer) flushTimer = setTimeout(flush, 250);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      clearTimeout(timer);
      pending += '\n[启动错误] ' + e.message + '\n';
      flush();
      this.finishTask(task, 'error', child);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      flush();
      this.finishTask(task, code === 0 ? 'done' : 'error', child, code);
    });
    return task;
  }

  modeArgs(member) {
    const modeId = member.modeId || (member.modes && member.modes[0] && member.modes[0].id);
    const mode = (member.modes || []).find(x => x.id === modeId);
    return mode ? mode.args : [];
  }

  /**
   * 门体检：逐扇派一单"只许列目录"的任务，判据是它能不能把一次性工作区里
   * 那个随机 canary 文件名回出来。跑完只写体检账，不进群转录——
   * 否则每天 11 张探针卡片会把群刷成日志。
   */
  async runHealthCheck(memberIds) {
    const targets = this.members.filter(m => (!memberIds || !memberIds.length || memberIds.includes(m.id)));
    const out = [];
    for (const member of targets) {
      // 探测口径要和真正派单的口径一致：自定义成员走 program 解析，内置成员走适配器
      const reachable = member.custom ? !!resolveCommand(member.program) : !!resolveMemberProgram(member);
      if (!reachable) {
        const j = { memberId: member.id, level: 'red', layer: 'not_found', reason: '这台机器上没检测到它', ms: 0, canaryHit: false, at: Date.now() };
        health.record(j); out.push(j); continue;
      }
      const canary = 'CANARY-' + crypto.randomBytes(6).toString('hex') + '.txt';
      const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-probe-'));
      try { fs.writeFileSync(path.join(probeDir, canary), 'probe marker\n', 'utf8'); } catch (e) { /* 造不出标记就跳过这扇 */ }
      const task = this.runTask(member, health.probePrompt(), null, null, probeDir, 'health', { quiet: true });
      const started = Date.now();
      const budgetMs = Math.min((member.timeoutMin || 15) * 60 * 1000, HEALTH_WAIT_MS);
      while (task.status === 'running' && Date.now() - started < budgetMs) await new Promise(r => setTimeout(r, 1500));
      const judged = task.status === 'running'
        ? { memberId: member.id, level: 'red', layer: 'timeout', reason: `体检等满 ${Math.round(budgetMs / 1000)} 秒还没回，按红处理`, ms: Date.now() - started, canaryHit: false, at: Date.now() }
        : health.judge({ memberId: member.id, status: task.status, output: task.text, canary, ms: Date.now() - started, at: Date.now() });
      health.record(judged);
      out.push(judged);
      try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch (e) { /* 临时目录让系统清 */ }
    }
    this.broadcast({ event: 'health_updated', rows: health.latest(Date.now()) });
    return out;
  }

  scheduleHealth() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (!health.autoEnabled(this.config)) return;
    const everyMs = health.everyHours(this.config) * 3600 * 1000;
    this.healthTimer = setInterval(() => {
      if (this.running.size) return; // 有活人在派单时不插队抢额度
      this.runHealthCheck(null).catch(() => {});
    }, everyMs);
    if (this.healthTimer.unref) this.healthTimer.unref();
  }

  finishTask(task, status, child, code) {
    if (!this.running.has(task.id)) return;
    this.running.delete(task.id);
    if (code !== undefined && code !== 0 && code !== null) {
      task.text += `\n[进程退出码 ${code}]`;
    }
    // 退出码 0 不代表成功：有的成员把上游报错直接打在 stdout 上退 0（实测 CodeBuddy 就是这样）。
    // 卡片和账本都用同一个判据，免得"界面显示成功、账本显示成功"一起错。
    const finalStatus = status === 'timeout' ? 'timeout' : usage.deriveStatus(status === 'done', task.text);
    if (finalStatus === 'error' && status === 'done') {
      task.text += '\n[判为失败：这段输出是错误行而不是结果]';
    }
    task.status = finalStatus;
    // 交付结论：起跑前的快照 vs 现在的快照 + git 两侧对比，全部由我们称，不引用成员的自述。
    if (delivery.shouldAttach(task) && task._pre && task._pre.snap) {
      try {
        const afterSnap = delivery.snapshotDir(task.cwd);
        const afterGit = delivery.gitInfo(task.cwd);
        const d = delivery.diff(task._pre.snap, afterSnap);
        task.delivery = delivery.summarize({
          status: finalStatus, output: task.text, diff: d,
          gitBefore: task._pre.git, gitAfter: afterGit
        });
        task.delivery.cwd = task.cwd;
      } catch (e) {
        task.delivery = { verdict: 'unknown', headline: '交付差异没称出来', next: '扫描失败：' + String((e && e.message) || e).slice(0, 120), artifacts: [] };
      }
    }
    delete task._pre;
    // 交付结论单独落一条，重启后回放卡片时还能看见"当时到底交付了什么"
    if (task.delivery && !task.quiet) {
      this.store.appendMessage({ type: 'task_delivery', taskId: task.id, delivery: task.delivery, at: Date.now() });
    }
    usage.record({
      memberId: task.memberId, model: task.model || '', taskKind: task.taskKind || 'unclassified',
      status: finalStatus, ms: Date.now() - task.at, output: task.text
    });
    // 这一笔同时会出现在那家的转录里：作废终端观测缓存，让面板下一眼就能看到新账
    terminalUsage.invalidate();
    if (!task.quiet) {
      this.store.appendMessage({ type: 'task_status', taskId: task.id, status: finalStatus, code: code ?? null, at: Date.now() });
      this.broadcast({ event: 'message', msg: { ...task } });
    }
  }
}

module.exports = { GroupServer, id, childEnv, ENV_KEEP };
