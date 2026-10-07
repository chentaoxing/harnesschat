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
  mentionOpen: false,
  mentionedMember: null,
  modelCache: {} // memberId -> {source, models}
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  return { running: '干活中…', done: '已完成', error: '出错', timeout: '超时中止' }[s] || s;
}

function taskCardHTML(t) {
  const outEmpty = !t.text || !t.text.trim();
  const foot = t.status === 'done'
    ? `<div class="task-foot" data-task="${t.id}">
         <button data-act="continue">继续对话</button>
         <button data-act="copy">复制结果</button>
       </div>`
    : (t.status === 'running'
        ? `<div class="task-foot" data-task="${t.id}"><button data-act="stop">停止</button></div>` : '');
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
  if (model) payload.model = model;
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
  $('#input').placeholder = state.continueThread
    ? `续话模式：接着 ${state.continueThread.memberName} 的任务串继续说…`
    : '输入消息，@成员 派任务（如：@Codex 把 README 翻成英文）';
}

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
    navigator.clipboard.writeText(task.text || '').then(() => {
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制结果'; }, 1200);
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
});
