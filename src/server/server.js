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

const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');

function id() { return crypto.randomBytes(6).toString('hex'); }

class GroupServer {
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.staticDir = opts.staticDir;
    this.port = opts.port || 18790;
    this.token = opts.token || '';
    this.store = new Store(this.dataDir);

    const defaultWorkspace = path.join(os.homedir(), 'HarnessChat工作区');
    this.config = this.store.loadConfig({ workspace: defaultWorkspace, members: {}, membersCustom: [], firstRunAck: false });
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
          const { text, prompt, memberId, threadId, model, cwd } = JSON.parse(body);
          return json(200, this.handleSend(String(text || ''), String(prompt || '') || String(text || ''), memberId || null, threadId || null, model || null, cwd || null));
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

  handleSend(text, prompt, memberId, threadId, modelOverride, cwd) {
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
    return { ok: true, dispatched: true, threadId: tid, task: this.runTask(member, cleanPrompt, tid, modelOverride, cwd) };
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

  runTask(member, prompt, threadId, modelOverride, cwdOverride) {
    const model = modelOverride || member.defaultModel || '';
    const workDir = GroupServer.resolveWorkDir(cwdOverride, this.config.workspace);
    const task = {
      id: id(), type: 'task', threadId, memberId: member.id, memberName: member.name,
      color: member.color, prompt, text: '', status: 'running', at: Date.now(), model, cwd: workDir
    };
    this.push(task);

    const built = member.custom
      ? buildCustomSpawn(member, { prompt, model, cwd: workDir }, resolveCommand)
      : member.buildSpawn({ prompt, model, cwd: workDir }, resolveMemberProgram(member), this.modeArgs(member));
    if (built && built.error) {
      task.status = 'error';
      task.text = built.error === 'NOT_FOUND'
        ? `未检测到 ${member.name}：请确认已安装并在 PATH 上，或在群设置里手动指定可执行文件路径`
        : built.error;
      this.store.appendMessage({ type: 'task_status', taskId: task.id, status: 'error', at: Date.now() });
      this.broadcast({ event: 'message', msg: { ...task } });
      return task;
    }

    const env = { ...process.env, ...(built.env || {}) };
    let child;
    try {
      child = safeExec(built.file, built.args, { cwd: workDir, env });
    } catch (e) {
      task.status = 'error';
      task.text = '启动失败: ' + e.message;
      this.store.appendMessage({ type: 'task_status', taskId: task.id, status: 'error', at: Date.now() });
      this.broadcast({ event: 'message', msg: { ...task } });
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
      this.broadcast({ event: 'task_delta', taskId: task.id, text: delta });
      this.store.appendMessage({ type: 'task_delta', taskId: task.id, text: delta, at: Date.now() });
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

  finishTask(task, status, child, code) {
    if (!this.running.has(task.id)) return;
    this.running.delete(task.id);
    task.status = status;
    if (code !== undefined && code !== 0 && code !== null) {
      task.text += `\n[进程退出码 ${code}]`;
    }
    this.store.appendMessage({ type: 'task_status', taskId: task.id, status, code: code ?? null, at: Date.now() });
    this.broadcast({ event: 'message', msg: { ...task } });
  }
}

module.exports = { GroupServer, id };
