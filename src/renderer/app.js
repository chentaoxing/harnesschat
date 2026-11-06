// HarnessChat 渲染层：群聊 UI（无框架，直接 DOM）
// 鉴权：Electron 通过 ?token= 注入本地 token，所有 API/WS 请求携带
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const BASE = 'http://127.0.0.1:18790';
const authHeaders = () => TOKEN ? { 'Authorization': 'Bearer ' + TOKEN } : {};

const state = {
  members: [],
  membersCustom: [],
  messages: [],
  workspace: '',
  continueThread: null, // { threadId, memberId } 续话模式
  takeover: null,       // { workspace, from } 接手外部会话：这一条派到那个目录去
  mentionOpen: false,
  mentionedMember: null,
  modelCache: {} // memberId -> {source, models}
};

const $ = (sel) => document.querySelector(sel);
// 转义同时覆盖引号：多处 esc() 的结果被放进 title="…" / value="…" 属性里，只转 &<> 会被引号 breakout。
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmtTime = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// ---------- 消息渲染 ----------
function renderMemberList() {
  const box = $('#member-list');
  box.innerHTML = '';
  for (const m of state.members) {
    const working = isWorking(m.id);
    const div = document.createElement('div');
    div.className = 'member' + (m.enabled ? '' : ' disabled');
    div.title = m.note || '';
    div.innerHTML = `
      <div class="avatar" style="background:${m.color}">${esc(m.name[0])}</div>
      <div class="m-info">
        <div class="m-name">${esc(m.name)}${m.custom ? ' <span class="tag">自定义</span>' : ''}</div>
        <div class="m-note">${m.enabled ? esc(m.modelSupport && m.defaultModel ? m.defaultModel : (m.detected ? '' : '未检测到')) : (m.detected ? '未启用' : '未检测到')}</div>
      </div>
      <div class="status-dot ${m.enabled ? (working ? 'working' : 'idle') : 'off'}" title="${working ? '干活中' : (m.enabled ? '空闲' : '不可用')}"></div>
    `;
    div.addEventListener('click', () => {
      const input = $('#input');
      input.value = `@${m.name} ` + input.value.replace(/^@\S+\s*/, '');
      input.focus();
      checkMention();
    });
    box.appendChild(div);
  }
  $('#member-count').textContent = state.members.filter(m => m.enabled).length;
}

function isWorking(memberId) {
  return state.messages.some(m => m.type === 'task' && m.memberId === memberId && m.status === 'running');
}

function statusText(s) {
  return { running: '干活中…', done: '已完成', error: '出错', timeout: '超时中止', interrupted: '已中断（应用重启）' }[s] || s;
}

function taskCardHTML(t) {
  const outEmpty = !t.text || !t.text.trim();
  const foot = t.status === 'done'
    ? `<div class="task-foot" data-task="${t.id}">
         <button data-act="continue">继续对话</button>
         <button data-act="copy">复制结果</button>
       </div>`
    : (t.status === 'running'
        ? `<div class="task-foot" data-task="${t.id}"><button data-act="stop">停止</button></div>`
        : `<div class="task-foot" data-task="${t.id}">
             <button data-act="retry">重试</button>
             <button data-act="copy">复制输出</button>
           </div>`);
  return `
    <div class="task-head">
      <span class="task-who" style="color:${t.color || 'var(--accent)'}">${esc(t.memberName || t.memberId)}</span>
      <span class="task-status ${t.status}" data-role="status">${statusText(t.status)}</span>
      ${t.model ? `<span class="task-model" title="模型">${esc(t.model)}</span>` : ''}
      <span class="task-model">${fmtTime(t.at)}</span>
    </div>
    <div class="task-prompt">${esc(t.prompt)}</div>
    <div class="task-out ${outEmpty ? 'empty' : ''}" data-role="out">${outEmpty ? '（等待输出…）' : esc(t.text)}</div>
    ${foot}
  `;
}

function renderMessage(msg, { append = true } = {}) {
  const box = $('#messages');
  const wrap = document.createElement('div');
  if (msg.type === 'user') {
    wrap.className = 'msg me';
    wrap.innerHTML = `<div class="bubble-me" title="${fmtTime(msg.at)}">${esc(msg.text)}</div>`;
  } else if (msg.type === 'system') {
    wrap.className = 'msg-sys';
    wrap.textContent = msg.text;
  } else if (msg.type === 'task') {
    wrap.className = 'msg';
    wrap.innerHTML = `<div class="task-card" data-task-id="${msg.id}" style="border-left-color:${msg.color || 'var(--accent)'}">${taskCardHTML(msg)}</div>`;
  } else {
    return null;
  }
  wrap.dataset.msgId = msg.id;
  if (append) box.appendChild(wrap);
  return wrap;
}

function scrollToBottom() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

function rerenderAll() {
  const box = $('#messages');
  box.innerHTML = '';
  for (const m of state.messages) renderMessage(m);
  renderMemberList();
  scrollToBottom();
}

function updateTaskInPlace(task) {
  const idx = state.messages.findIndex(m => m.id === task.id);
  if (idx >= 0) state.messages[idx] = { ...state.messages[idx], ...task };
  const el = document.querySelector(`[data-task-id="${task.id}"]`);
  if (el) el.innerHTML = taskCardHTML({ ...state.messages[idx] });
  renderMemberList();
}

function applyDelta(taskId, delta) {
  const t = state.messages.find(m => m.id === taskId);
  if (!t) return;
  t.text = (t.text || '') + delta;
  const out = document.querySelector(`[data-task-id="${taskId}"] [data-role="out"]`);
  if (out) {
    if (out.classList.contains('empty')) { out.classList.remove('empty'); out.textContent = ''; }
    out.textContent += delta;
    out.scrollTop = out.scrollHeight;
  }
}

// ---------- WebSocket ----------
let ws = null;
let wsTimer = null;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://127.0.0.1:18790/ws?token=${encodeURIComponent(TOKEN)}`);
  ws.onopen = () => { $('#conn-status').textContent = '已连接'; $('#conn-status').className = 'conn on'; };
  ws.onclose = () => {
    $('#conn-status').textContent = '断线重连中…'; $('#conn-status').className = 'conn off';
    wsTimer = setTimeout(connectWS, 2000);
  };
  ws.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch (e) { return; }
    if (data.event === 'message') {
      if (data.msg.type === 'task') {
        const exist = state.messages.find(m => m.id === data.msg.id);
        if (exist) updateTaskInPlace(data.msg);
        else { state.messages.push(data.msg); renderMessage(data.msg); renderMemberList(); scrollToBottom(); }
      } else {
        state.messages.push(data.msg);
        renderMessage(data.msg);
        scrollToBottom();
      }
    } else if (data.event === 'task_delta') {
      applyDelta(data.taskId, data.text);
      scrollToBottom();
    }
  };
}

// ---------- 发送 ----------
async function send() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  hideMention();
  const model = $('#model-input').value.trim();
  const payload = { text };
  const kindSel = $('#task-kind');
  if (kindSel && kindSel.value && kindSel.value !== 'unclassified') payload.taskKind = kindSel.value;
  if (model) payload.model = model;
  if (state.takeover) {
    // 接手：派到那条会话自己的工作区去，而不是群工作区
    payload.cwd = state.takeover.workspace;
    state.takeover = null;
    updateComposerPlaceholder();
  }
  if (state.continueThread) {
    payload.threadId = state.continueThread.threadId;
    payload.memberId = state.continueThread.memberId;
    // 续话：把该串最后一条任务的输出尾部拼进 prompt，模拟上下文延续
    const threadTasks = state.messages.filter(m => m.type === 'task' && m.threadId === state.continueThread.threadId);
    const last = threadTasks[threadTasks.length - 1];
    if (last && last.text) {
      const tail = last.text.length > 6000 ? '…' + last.text.slice(-6000) : last.text;
      payload.prompt = `【任务接续】\n你之前收到的任务：\n${last.prompt}\n\n你之前的输出（末尾节选）：\n${tail}\n\n用户追加指令：\n${text}`;
    }
    state.continueThread = null;
    updateComposerPlaceholder();
  }
  input.disabled = true; $('#btn-send').disabled = true;
  try {
    const r = await fetch(BASE + '/api/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (!j.ok) alert('发送失败: ' + (j.error || ''));
  } catch (e) {
    alert('服务器未响应: ' + e.message);
  } finally {
    input.disabled = false; $('#btn-send').disabled = false; input.focus();
  }
}

// ---------- @ 浮层 ----------
function showMention() {
  const pop = $('#mention-pop');
  pop.innerHTML = '';
  for (const m of state.members) {
    const div = document.createElement('div');
    div.className = 'mention-item' + (m.enabled ? '' : ' disabled');
    div.innerHTML = `<div class="avatar" style="background:${m.color}">${esc(m.name[0])}</div>${esc(m.name)}${m.enabled ? '' : '（不可用）'}`;
    div.addEventListener('click', () => {
      const input = $('#input');
      input.value = input.value.replace(/@$/, `@${m.name} `);
      input.focus();
      hideMention();
      checkMention();
    });
    pop.appendChild(div);
  }
  pop.classList.remove('hidden');
  state.mentionOpen = true;
}
function hideMention() { $('#mention-pop').classList.add('hidden'); state.mentionOpen = false; }

async function fetchMemberModels(memberId) {
  if (state.modelCache[memberId]) return state.modelCache[memberId];
  try {
    const r = await fetch(BASE + '/api/models?member=' + encodeURIComponent(memberId), { headers: authHeaders() });
    const j = await r.json();
    state.modelCache[memberId] = j;
    return j;
  } catch (e) { return { source: '', models: [] }; }
}

// 根据输入里的 @ 提及联动模型提示（datalist 填充）
async function checkMention() {
  const text = $('#input').value;
  const m = state.members.find(mm => new RegExp(`@${mm.name}`, 'i').test(text) || new RegExp(`@${mm.id}`, 'i').test(text));
  state.mentionedMember = m || null;
  const dl = $('#model-list');
  dl.innerHTML = '';
  if (m && m.modelSupport) {
    const { models } = await fetchMemberModels(m.id);
    for (const c of models) {
      const opt = document.createElement('option');
      opt.value = c;
      dl.appendChild(opt);
    }
    if (!models.length && m.modelHint) {
      for (const c of m.modelHint.split('/').map(s => s.trim()).filter(s => s && !s.endsWith('…'))) {
        const opt = document.createElement('option');
        opt.value = c;
        dl.appendChild(opt);
      }
    }
  }
  $('#model-input').placeholder = m && m.modelSupport ? `模型（默认：${m.defaultModel || '成员默认'}）` : '模型（该成员不支持指定）';
}

function updateComposerPlaceholder() {
  const el = $('#input');
  if (state.takeover) {
    el.placeholder = `接手模式：这条会派到 ${state.takeover.workspace}（来自 ${state.takeover.from}）。发完自动退出。`;
    return;
  }
  el.placeholder = state.continueThread
    ? `续话模式：接着 ${state.continueThread.memberName} 的任务串继续说…`
    : '输入消息，@成员 派任务（如：@Codex 把 README 翻成英文）';
}

// ---------- 用量账本 ----------
const KIND_LABEL = { rate_limit: '限流', auth: '鉴权', expired: '订阅到期', not_found: '没检测到', timeout: '超时', gateway: '网关侧', other: '其它' };
// 结论的措辞刻意区分"实测"和"自称"：上一版我只凭模型 id 里带 free 就写"免费档"，
// 那是把我的猜测当成事实报给他。
const EV_LABEL = {
  'ok-observed': '实测可用',
  'quota-capped': '实测有额度上限',
  'gateway-down': '网关侧不通',
  'auth-fail': '鉴权不通',
  expired: '订阅到期',
  'id-only': '仅 id 自称'
};
let usageRows = [];
let usageTerminal = [];
let usageCoverage = [];
let usageTruncated = false;
let healthRows = [];
let healthGreen = [];
let healthAuto = false;
let healthEvery = 24;
let healthPoll = null;
let usageTimer = null;

function renderUsage() {
  const box = $('#usage-list');
  if (!box) return;
  box.innerHTML = '';
  if (!usageRows.length && !usageTerminal.length) {
    box.innerHTML = '<div class="sess-empty">还没有派单记录。派一单之后这里会按成员×模型累计：今天几次、成没成、失败卡在哪一层、是否在冷却。</div>';
    return;
  }
  for (const r of usageRows) {
    const div = document.createElement('div');
    div.className = 'usage-row' + (r.blocked ? ' cooling' : '');
    const kinds = Object.entries(r.byKind || {}).map(([k, n]) => `<span class="u-kind ${k}">${KIND_LABEL[k] || k} ${n}</span>`).join('');
    const tasks = Object.entries(r.byTask || {}).map(([k, v]) => `<span class="u-task">${k} ${v.ok}/${v.ok + v.fail}</span>`).join('');
    const ev = r.freeEvidence || {};
    const term = (r.terminalTotal ? ` · 终端里另观察到 <b>${r.terminalToday}</b> 次今天（累计 ${r.terminalTotal}${r.terminalPartial ? '，至少' : ''}）` : '');
    div.innerHTML = `
      <div class="u-head">
        <b>${esc(r.memberName)}</b>
        <span class="u-model">${esc(r.model || '成员默认模型')}</span>
        ${EV_LABEL[ev.verdict] ? `<span class="u-free ${esc(ev.verdict)}" title="${esc(ev.note || '')}">${EV_LABEL[ev.verdict]}</span>` : ''}
        ${r.blocked ? '<span class="u-cool" data-until="' + r.cooldownUntil + '">冷却中</span>' : ''}
      </div>
      <div class="u-nums">
        我派的 今天 <b>${r.today}</b> 次 · 累计 ${r.total} · 成 ${r.ok} / 败 ${r.fail}${term}
        ${r.medianMs ? ' · 中位 ' + Math.round(r.medianMs / 1000) + 's' : ''}
      </div>
      ${ev.note ? `<div class="u-ev">${esc(ev.note)}${ev.idClaimsFree ? '（模型 id 自称免费）' : ''}</div>` : ''}
      ${kinds ? `<div class="u-kinds">${kinds}</div>` : ''}
      ${tasks ? `<div class="u-kinds">${tasks}</div>` : ''}`;
    box.appendChild(div);
  }
  renderTerminalBlock();
  tickCooldowns();
}

// 终端观测明细 + 覆盖面：这一段的作用是让他知道"哪些数我没看见"，
// 而不是给一个看起来完整的合计。
function renderTerminalBlock() {
  const box = $('#usage-list');
  if (!box || !box.parentNode) return;
  const old = document.getElementById('terminal-block');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = 'terminal-block';
  const cov = (usageCoverage || []).filter(c => c.status !== 'counted');
  const rowsByMember = {};
  for (const t of usageTerminal) (rowsByMember[t.memberName || t.memberId] = rowsByMember[t.memberName || t.memberId] || []).push(t);
  const parts = [];
  for (const name of Object.keys(rowsByMember)) {
    for (const t of rowsByMember[name]) {
      parts.push(`<div class="u-row2">${esc(name)} · ${esc(t.model)}：今天 <b>${t.today}</b> / 累计 ${t.total}${t.partial ? '（至少）' : ''} · 败 ${t.fail}</div>`);
    }
  }
  wrap.innerHTML = `
    <div class="u-sect">他在各家自己终端里跑掉的（从各家转录读，不是我派的）${usageTruncated ? ' · 已到扫描上限，下面是"至少"' : ''}</div>
    ${parts.length ? parts.join('') : '<div class="u-row2 dim">最近 7 天没有可归因的模型往返记录</div>'}
    ${cov.length ? `<div class="u-sect">未统计的家（认不出转录布局就不猜）</div><div class="u-row2 dim">${cov.map(c => esc(c.memberName || c.memberId)).join(' · ')}</div>` : ''}`;
  box.appendChild(wrap);
}

function tickCooldowns() {
  const now = Date.now();
  for (const el of document.querySelectorAll('.u-cool[data-until]')) {
    const until = Number(el.dataset.until) || 0;
    const left = Math.max(0, Math.ceil((until - now) / 60000));
    el.textContent = left > 0 ? `冷却中（剩 ${left} 分钟）` : '冷却结束';
  }
}

async function loadUsage(silent) {
  try {
    const r = await fetch(BASE + '/api/usage', { headers: authHeaders() });
    const d = await r.json();
    usageRows = d.rows || [];
    usageTerminal = d.terminalRows || [];
    usageCoverage = d.terminalCoverage || [];
    usageTruncated = !!d.terminalTruncated;
    const cooling = usageRows.filter(x => x.blocked).length;
    const badge = $('#usage-badge');
    if (badge) { badge.textContent = cooling ? String(cooling) : ''; badge.classList.toggle('hidden', !cooling); }
    if (!silent) {
      const uncounted = usageCoverage.filter(c => c.status !== 'counted').length;
      $('#usage-status').textContent = `${usageRows.length} 条门×模型记录 · 终端观测 ${usageTerminal.length} 组${uncounted ? ' · ' + uncounted + ' 家未统计' : ''} · 限流后自动冷却 ${Math.round((d.cooldownMs || 0) / 60000)} 分钟`;
      renderUsage();
    } else {
      renderUsage();
    }
  } catch (e) {
    if (!silent) $('#usage-status').textContent = '读取失败: ' + String((e && e.message) || e);
  }
}

$('#btn-usage').addEventListener('click', () => {
  $('#usage-mask').classList.remove('hidden');
  renderUsage();
  loadUsage(false);
  if (!usageTimer) usageTimer = setInterval(() => { if (!$('#usage-mask').classList.contains('hidden')) loadUsage(false); }, 60000);
});

// ---------- 门体检 ----------
const HEALTH_LABEL = { green: '能干完活', chatter: '只会聊天', red: '红', pending: '待跑' };

function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return m + ' 分钟前';
  if (m < 60 * 24) return Math.round(m / 60) + ' 小时前';
  return Math.round(m / 1440) + ' 天前';
}

function renderHealth() {
  const box = $('#health-list');
  if (!box) return;
  box.innerHTML = '';
  const byId = {};
  for (const r of healthRows) byId[r.memberId] = r;
  for (const m of state.members || []) {
    const r = byId[m.id];
    const div = document.createElement('div');
    div.className = 'health-row ' + (r ? r.level : 'none');
    div.innerHTML = `
      <div class="u-head">
        <b>${esc(m.name)}</b>
        <span class="h-level ${r ? r.level : 'none'}">${r ? (HEALTH_LABEL[r.level] || r.level) : '没体检过'}</span>
        ${r && r.level === 'green' ? '<span class="h-green-mark">在选人池里</span>' : ''}
      </div>
      <div class="h-why">${r ? esc(r.reason || (r.layer || '') + '') : '跑一次体检才知道这扇门能不能替你干活'}</div>
      <div class="h-meta">${r ? ago(r.at) + ' · ' + Math.round((r.ms || 0) / 1000) + 's' : ''}</div>`;
    box.appendChild(div);
  }
  const st = $('#health-status');
  if (st) st.textContent = `${healthGreen.length} 扇绿 / ${(state.members || []).length} 扇 · 自动体检${healthAuto ? '开，每 ' + healthEvery + ' 小时' : '关（每次都要花你的额度，默认不替你开）'}`;
  const cb = $('#health-auto');
  if (cb) cb.checked = !!healthAuto;
  const badge = $('#health-badge');
  if (badge) { badge.textContent = healthGreen.length ? '' : '!'; badge.classList.toggle('hidden', healthGreen.length > 0); }
}

async function loadHealth() {
  try {
    const d = await (await fetch(BASE + '/api/health', { headers: authHeaders() })).json();
    healthRows = d.rows || [];
    healthGreen = d.green || [];
    healthAuto = !!d.auto;
    healthEvery = d.everyHours || 24;
    renderHealth();
  } catch (e) {
    const st = $('#health-status');
    if (st) st.textContent = '读取失败: ' + String((e && e.message) || e);
  }
}

async function runHealthAll() {
  try {
    await fetch(BASE + '/api/health/run', { method: 'POST', headers: authHeaders(), body: '{}' });
    const st = $('#health-status');
    if (st) st.textContent = '体检在跑：逐扇一次只读探针，慢门（比如要先装依赖的）会多等一会儿…';
    if (healthPoll) clearInterval(healthPoll);
    healthPoll = setInterval(async () => {
      await loadHealth();
      const running = healthRows.some(r => r.level === 'pending');
      if (!running && Date.now() - (healthRows[0] ? healthRows[0].at : 0) < 90000 && healthRows.length) { clearInterval(healthPoll); healthPoll = null; }
    }, 8000);
  } catch (e) { /* 状态行已经给了 */ }
}

$('#btn-health').addEventListener('click', () => {
  $('#health-mask').classList.remove('hidden');
  loadHealth();
});
$('#btn-health-close').addEventListener('click', () => $('#health-mask').classList.add('hidden'));
$('#btn-health-refresh').addEventListener('click', () => loadHealth());
$('#btn-health-run').addEventListener('click', () => runHealthAll());
$('#health-auto').addEventListener('change', async ev => {
  const on = ev.target.checked;
  try {
    await fetch(BASE + '/api/settings', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ health: { auto: on, everyHours: healthEvery } })
    });
    healthAuto = on;
    renderHealth();
  } catch (e) { ev.target.checked = !on; }
});
$('#btn-usage-close').addEventListener('click', () => {
  $('#usage-mask').classList.add('hidden');
  if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
});
$('#btn-usage-refresh').addEventListener('click', () => loadUsage(false));
$('#usage-mask').addEventListener('click', (e) => { if (e.target.id === 'usage-mask') $('#usage-mask').classList.add('hidden'); });

// ---------- 外部会话雷达 ----------
const STATE_LABEL = { dead: '半路死了', active: '在跑', idle: '静默', ended: '已结束' };
let sessionsCache = [];

function setSessionsStatus(t) { const el = $('#sessions-status'); if (el) el.textContent = t; }

async function loadSessions(silent) {
  if (!silent) setSessionsStatus('扫描中…');
  try {
    const r = await fetch(BASE + '/api/sessions?limit=12', { headers: authHeaders() });
    const d = await r.json();
    sessionsCache = d.rows || [];
    const dead = sessionsCache.filter(s => s.state === 'dead').length;
    const badge = $('#sessions-badge');
    if (badge) { badge.textContent = dead ? String(dead) : ''; badge.classList.toggle('hidden', !dead); }
    const src = (d.scanned || []).filter(s => s.found).map(s => `${s.label} ${s.found}`);
    setSessionsStatus(`${sessionsCache.length} 条 · ${src.join(' / ') || '没读到任何 harness 的会话目录'}`);
    if (!silent) renderSessions();
  } catch (e) {
    setSessionsStatus('扫描失败: ' + String((e && e.message) || e));
  }
}

function renderSessions() {
  const box = $('#sessions-list');
  box.innerHTML = '';
  if (!sessionsCache.length) {
    box.innerHTML = '<div class="sess-empty">没读到任何 harness 的会话记录。目前认得 ZCode、Claude Code、Codex 三家落在自己目录里的转录。</div>';
    return;
  }
  for (const s of sessionsCache) {
    const div = document.createElement('div');
    div.className = 'sess-row ' + s.state;
    const when = s.minutesAgo < 60 ? `${s.minutesAgo} 分钟前` : `${Math.round(s.minutesAgo / 60)} 小时前`;
    div.innerHTML = `
      <div class="sess-head">
        <b>${esc(s.harnessName)}</b>
        <span class="sess-state ${s.state}">${STATE_LABEL[s.state] || esc(s.state)}</span>
        <span class="sm-hint">${when} · ${s.sizeMb} MB${s.model ? ' · ' + esc(s.model) : ''}</span>
      </div>
      <div class="sess-wd" title="${esc(s.file || '')}">${esc(s.workspace || '工作区未知')}</div>
      ${s.endReason ? `<div class="sess-why">停在：${esc(s.endReason)}</div>` : ''}
      ${s.lastAsk || s.firstAsk ? `<div class="sess-ask">${esc(s.lastAsk || s.firstAsk)}</div>` : ''}
      <div class="sess-acts"><button class="chip" data-act="take" ${s.workspace ? '' : 'disabled'}>接手到群聊</button></div>`;
    const btn = div.querySelector('[data-act="take"]');
    if (btn && s.workspace) btn.addEventListener('click', () => startTakeover(s));
    box.appendChild(div);
  }
}

function startTakeover(s) {
  state.takeover = { workspace: s.workspace, from: `${s.harnessName} ${s.id}` };
  state.continueThread = null;
  $('#sessions-mask').classList.add('hidden');
  $('#input').value = s.brief;
  updateComposerPlaceholder();
  $('#input').focus();
}

$('#btn-sessions').addEventListener('click', () => {
  $('#sessions-mask').classList.remove('hidden');
  renderSessions();
  loadSessions(true);
});
$('#btn-sessions-close').addEventListener('click', () => $('#sessions-mask').classList.add('hidden'));
$('#btn-sessions-refresh').addEventListener('click', () => loadSessions(false));
$('#sessions-mask').addEventListener('click', (e) => { if (e.target.id === 'sessions-mask') $('#sessions-mask').classList.add('hidden'); });

// ---------- 设置 ----------
function openSettings() {
  $('#set-workspace').value = state.workspace;
  const box = $('#set-members');
  box.innerHTML = '';
  for (const m of state.members) {
    const div = document.createElement('div');
    div.className = 'set-member';
    const detectedBadge = m.detected ? '' : ' <span class="tag warn">未检测到</span>';
    div.innerHTML = `
      <div class="sm-head">
        <div class="avatar" style="background:${m.color}">${esc(m.name[0])}</div>
        <div class="sm-name">${esc(m.name)}${detectedBadge}</div>
        <div class="sm-note">${esc(m.note || '')}</div>
      </div>
      <div class="sm-row">
        <label><input type="checkbox" data-role="enabled" ${m.enabled ? 'checked' : ''}> 启用</label>
        ${m.modelSupport ? `<label>默认模型</label><input type="text" data-role="model" value="${esc(m.defaultModel || '')}" placeholder="${esc(m.modelHint || '')}">` : `<span class="sm-hint">${esc(m.modelNote || '不支持指定模型')}</span>`}
      </div>
      ${(m.modes && m.modes.length > 1) ? `
      <div class="sm-row">
        <label>权限模式</label>
        <select data-role="mode">${m.modes.map(id => `<option value="${id}" ${id === m.modeId ? 'selected' : ''}>${id}</option>`).join('')}</select>
      </div>` : ''}
      ${!m.detected ? `
      <div class="sm-row">
        <label>可执行路径</label>
        <input type="text" data-role="programPath" value="${esc((state.programPaths || {})[m.id] || '')}" placeholder="C:\\path\\to\\cli.cmd 或 /usr/local/bin/cli">
      </div>` : ''}
      ${m.modelSupport ? `<div class="model-chips" data-role="chips" data-member="${m.id}"><span class="sm-hint">读取模型列表…</span></div>` : ''}
    `;
    box.appendChild(div);
    if (m.modelSupport) {
      // 异步填模型列表（点击即设为默认模型）
      fetchMemberModels(m.id).then(({ source, models }) => {
        const chips = div.querySelector('[data-role="chips"]');
        if (!chips) return;
        chips.innerHTML = '';
        const modelInput = div.querySelector('[data-role="model"]');
        if (!models.length) {
          chips.innerHTML = `<span class="sm-hint">${source === 'manual' ? '自定义成员请直接输入模型名' : '未在本地配置中发现模型列表，可直接输入'}</span>`;
          return;
        }
        chips.innerHTML = `<span class="sm-hint">从 ${esc(source)} 读取到 ${models.length} 个模型，点击设为默认：</span>`;
        const row = document.createElement('div');
        row.className = 'chip-row';
        for (const mo of models) {
          const b = document.createElement('button');
          b.className = 'chip';
          b.textContent = mo;
          b.addEventListener('click', () => { if (modelInput) modelInput.value = mo; });
          row.appendChild(b);
        }
        chips.appendChild(row);
      });
    }
  }
  // 自定义成员
  const cl = $('#custom-list');
  cl.innerHTML = '';
  for (const cm of state.membersCustom) {
    cl.appendChild(customMemberForm(cm));
  }
  $('#settings-mask').classList.remove('hidden');
}

function customMemberForm(cm = {}) {
  const div = document.createElement('div');
  div.className = 'custom-member';
  div.innerHTML = `
    <div class="sm-row">
      <label>名称</label><input type="text" data-role="name" value="${esc(cm.name || '')}" placeholder="MyAgent">
      <label>命令</label><input type="text" data-role="program" value="${esc(cm.program || '')}" placeholder="myagent 或绝对路径">
      <button class="ghost-btn btn-del" title="删除">✕</button>
    </div>
    <div class="sm-row">
      <label>参数模板</label>
      <textarea data-role="argsTemplate" rows="3" placeholder="exec&#10;--cwd&#10;{{cwd}}&#10;{{prompt}}">${esc((cm.argsTemplate || []).join('\n'))}</textarea>
      <label>默认模型</label><input type="text" data-role="defaultModel" value="${esc(cm.defaultModel || '')}">
    </div>
  `;
  div.querySelector('.btn-del').addEventListener('click', () => div.remove());
  return div;
}

async function saveSettings() {
  const members = {};
  for (const div of document.querySelectorAll('#set-members .set-member')) {
    const idx = [...div.parentElement.children].indexOf(div);
    const m = state.members[idx];
    if (!m) continue;
    members[m.id] = {
      enabled: div.querySelector('[data-role="enabled"]').checked,
      defaultModel: (div.querySelector('[data-role="model"]') || { value: m.defaultModel }).value.trim()
    };
    const modeSel = div.querySelector('[data-role="mode"]');
    if (modeSel) members[m.id].modeId = modeSel.value;
    const pp = div.querySelector('[data-role="programPath"]');
    if (pp && pp.value.trim()) members[m.id].programPath = pp.value.trim();
  }
  const membersCustom = [];
  for (const div of document.querySelectorAll('#custom-list .custom-member')) {
    const name = div.querySelector('[data-role="name"]').value.trim();
    const program = div.querySelector('[data-role="program"]').value.trim();
    if (!name || !program) continue;
    membersCustom.push({
      id: 'custom-' + name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'custom-' + Date.now(),
      name, program,
      argsTemplate: div.querySelector('[data-role="argsTemplate"]').value.split('\n').map(s => s.trim()).filter(Boolean),
      defaultModel: div.querySelector('[data-role="defaultModel"]').value.trim()
    });
  }
  const workspace = $('#set-workspace').value.trim();
  await fetch(BASE + '/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ workspace, members, membersCustom })
  });
  $('#settings-mask').classList.add('hidden');
  await loadState();
}

// ---------- 任务卡按钮 ----------
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.task-foot button');
  if (!btn) return;
  const foot = btn.closest('.task-foot');
  const taskId = foot.dataset.task;
  const task = state.messages.find(m => m.id === taskId);
  if (!task) return;
  const act = btn.dataset.act;
  if (act === 'stop') {
    await fetch(BASE + '/api/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ taskId })
    });
  } else if (act === 'copy') {
    const label = btn.textContent;
    navigator.clipboard.writeText(task.text || '').then(() => {
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = label; }, 1200);
    });
  } else if (act === 'retry') {
    btn.disabled = true;
    btn.textContent = '已重新派单';
    await fetch(BASE + '/api/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        text: '@' + (task.memberName || task.memberId) + ' ' + task.prompt,
        prompt: task.prompt,
        memberId: task.memberId,
        threadId: task.threadId,
        model: task.model || null
      })
    });
  } else if (act === 'continue') {
    state.continueThread = { threadId: task.threadId, memberId: task.memberId, memberName: task.memberName };
    updateComposerPlaceholder();
    $('#input').focus();
  }
});

// ---------- 初始化 ----------
async function loadState() {
  const r = await fetch(BASE + '/api/state', { headers: authHeaders() });
  if (r.status === 401) {
    $('#conn-status').textContent = '鉴权失败，请重启应用';
    return;
  }
  const j = await r.json();
  state.members = j.members;
  state.membersCustom = j.membersCustom || [];
  state.messages = j.messages;
  state.workspace = j.workspace;
  state.programPaths = {};
  for (const m of j.members) if (m.programPath) state.programPaths[m.id] = m.programPath;
  $('#workspace-label').textContent = '工作区: ' + j.workspace;
  $('#workspace-label').title = j.workspace;
  rerenderAll();
  if (j.firstRun) $('#firstrun-mask').classList.remove('hidden');
}

$('#btn-send').addEventListener('click', send);
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === 'Escape') { hideMention(); }
});
$('#input').addEventListener('input', () => {
  const v = $('#input').value;
  if (/@$/.test(v)) showMention();
  else if (state.mentionOpen) hideMention();
  checkMention();
});
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-settings-cancel').addEventListener('click', () => $('#settings-mask').classList.add('hidden'));
$('#btn-settings-save').addEventListener('click', saveSettings);
$('#btn-custom-add').addEventListener('click', () => $('#custom-list').appendChild(customMemberForm()));
$('#btn-firstrun-ok').addEventListener('click', async () => {
  $('#firstrun-mask').classList.add('hidden');
  await fetch(BASE + '/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ firstRunAck: true })
  });
});

// ---------- 更新器 ----------
const HAS_BRIDGE = typeof window.harnesschat !== 'undefined';
let updateBusy = false;

function setUpdateStatus(text) {
  const el = $('#update-status');
  if (el) el.textContent = text;
}

function setSettingsBtn(label, act, enabled) {
  const btn = $('#btn-check-update');
  if (!btn) return;
  btn.textContent = label;
  btn.dataset.act = act;
  btn.disabled = !enabled;
}

async function showAppVersion() {
  const el = $('#app-version');
  if (!el) return;
  if (!HAS_BRIDGE) { el.textContent = '（浏览器模式）'; return; }
  try { el.textContent = 'v' + (await window.harnesschat.version()); } catch (e) { el.textContent = ''; }
}

async function downloadAndRunUpdate(btn) {
  if (updateBusy) return;
  updateBusy = true;
  const label = btn ? btn.textContent : '';
  if (btn) btn.disabled = true;
  setUpdateStatus('下载中…');
  try {
    const r = await window.harnesschat.downloadAndRun();
    if (r.ok) {
      setUpdateStatus(`v${r.version || ''} 安装包已下载并启动，按提示完成安装`);
      setSettingsBtn('已启动安装器', 'done', false);
      if (btn) btn.textContent = '安装器已启动';
    } else {
      setUpdateStatus(r.error || '下载失败');
      setSettingsBtn(label || '下载并安装', 'download', true);
      if (btn) { btn.disabled = false; btn.textContent = '重试下载'; }
    }
  } catch (e) {
    setUpdateStatus('失败: ' + String((e && e.message) || e));
    setSettingsBtn('下载并安装', 'download', true);
    if (btn) { btn.disabled = false; btn.textContent = label; }
  } finally {
    updateBusy = false;
  }
}

// 下载进度由主进程单向推送（避免渲染层轮询）
if (HAS_BRIDGE && window.harnesschat.onUpdateProgress) {
  window.harnesschat.onUpdateProgress((text) => setUpdateStatus('下载中 ' + text));
}

async function checkUpdateInteractive() {
  if (!HAS_BRIDGE) { setUpdateStatus('（浏览器模式无更新器，请用 npm start 或安装包运行）'); return; }
  if (updateBusy) return;
  setUpdateStatus('检查中…');
  const r = await window.harnesschat.checkUpdate();
  const src = r.source === 'atom' ? '，走 releases.atom' : '';
  if (!r.ok) {
    setUpdateStatus(r.noReleaseYet ? 'GitHub 上还没有发布版本' : ('检查失败: ' + r.error));
    setSettingsBtn('检查更新', 'check', true);
    return;
  }
  if (!r.updateAvailable) { setUpdateStatus(`已是最新（v${r.current}${src}）`); setSettingsBtn('检查更新', 'check', true); return; }
  setUpdateStatus(`发现新版本 v${r.latest}${src}，点右侧按钮下载`);
  setSettingsBtn('下载并安装', 'download', true);
  showUpdateBanner(r.latest);
}

function showUpdateBanner(version) {
  const banner = $('#update-banner');
  if (!banner) return;
  $('#update-version').textContent = 'v' + version;
  banner.classList.remove('hidden');
}

async function autoCheckUpdate() {
  if (!HAS_BRIDGE) return;
  try {
    const r = await window.harnesschat.checkUpdate();
    if (r.ok && r.updateAvailable) showUpdateBanner(r.latest);
  } catch (e) { /* 静默：更新检查绝不打扰主流程 */ }
}

$('#btn-check-update').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  if (btn.dataset.act === 'download') downloadAndRunUpdate(btn);
  else checkUpdateInteractive();
});
$('#btn-update').addEventListener('click', (e) => downloadAndRunUpdate(e.currentTarget));
$('#btn-update').title = '下载最新版本安装包并启动安装';

loadState().then(() => {
  connectWS();
  showAppVersion();
  autoCheckUpdate();
  setInterval(autoCheckUpdate, 30 * 60 * 1000); // 开久了也能主动发现新版本
  setTimeout(() => loadSessions(true), 1200);   // 静默扫一次外部会话，死了的在侧栏亮个数字
});
