// 真机验收：往装机版派一单"只回答、不写盘"的活，验产出落点这条链真的闭合。
// 用法：node scripts/live-landing-check.cjs [memberId]
// 默认派给 qoderclicn（本机唯一实测绿的门）。不放宽任何权限档。
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:18790';
const token = fs.readFileSync(path.join(process.env.APPDATA, 'HarnessChat', 'token.txt'), 'utf8').trim();
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
const memberId = process.argv[2] || 'qoderclicn';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const fails = [];
const oks = [];
const check = (name, pass, detail) => { (pass ? oks : fails).push(pass ? name : `${name}${detail ? ' — ' + detail : ''}`); };

async function api(p, opts) {
  const r = await fetch(BASE + p, opts);
  return r.json();
}

(async () => {
  const state0 = await api('/api/state', { headers: H });
  const ws = state0.workspace;
  const member = state0.members.find(m => m.id === memberId);
  check('目标门在成员表里且可用', !!member && member.enabled, JSON.stringify(member && { id: member.id, enabled: member.enabled, detected: member.detected, modeId: member.modeId }));
  if (!member || !member.enabled) { report(); return; }

  const prompt = '只回答，不要创建、修改、删除任何文件：写一段 Python 函数，统计一个目录里每种扩展名各有多少个文件，并用一个 fenced code block 给出代码。';
  const sent = await api('/api/send', { method: 'POST', headers: H, body: JSON.stringify({ text: '@' + member.name + ' ' + prompt, prompt, memberId, cwd: ws, taskKind: 'produce' }) });
  check('派单成功', sent && sent.dispatched === true && !!sent.task, JSON.stringify(sent).slice(0, 200));
  const tid = sent && sent.task && sent.task.id;
  if (!tid) { report(); return; }

  let task = null;
  for (let i = 0; i < 120; i++) {
    await sleep(3000);
    const s = await api('/api/state', { headers: H });
    task = s.messages.find(m => m.type === 'task' && m.id === tid);
    if (task && task.status !== 'running') break;
  }
  check('任务跑到了终态', !!task && task.status !== 'running', task && task.status);
  console.log('TASK_STATUS=' + (task && task.status));
  console.log('TASK_TEXT_HEAD=' + JSON.stringify(String((task && task.text) || '').slice(0, 200)));
  if (!task) { report(); return; }

  const d = task.delivery || {};
  const L = d.landing;
  console.log('DELIVERY_VERDICT=' + d.verdict + ' CHANGED=' + d.changed);
  console.log('LANDING=' + JSON.stringify(L, null, 1));

  if (task.status !== 'done') {
    check('门没跑成时如实不落点（不是产品坏了）', !L, JSON.stringify(L));
    report();
    return;
  }

  if ((d.changed || 0) > 0) {
    check('成员自己动了盘 → 判 produced 且不多落一份回答', d.verdict === 'produced' && !L, JSON.stringify({ verdict: d.verdict, landing: !!L }));
    report();
    return;
  }

  check('成员零产出时控制台落了点', !!L && L.ok === true, JSON.stringify(L));
  check('落点在群工作区里', !!L && String(L.dir).startsWith(ws), L && L.dir);
  const ans = L && (L.files || []).find(f => f.kind === 'answer');
  check('回答文件真在盘上', !!ans && fs.existsSync(ans.abs), ans && ans.abs);
  check('回答文件与成员输出逐字相等', !!ans && fs.readFileSync(ans.abs, 'utf8') === task.text, ans && JSON.stringify({ fileBytes: fs.existsSync(ans.abs) ? fs.statSync(ans.abs).size : -1, textLen: task.text.length }));
  check('代码块被单独落成文件（这一单明确要求了 fenced block）', !!L && (L.files || []).some(f => f.kind === 'block'), JSON.stringify(L && L.files));
  check('落点说明写清了"不是成员自己写的文件"', !!L && /不是它自己写的文件/.test(L.note || ''), L && L.note);
  check('交付判定没有被落点染绿', d.verdict !== 'produced' && (d.changed || 0) === 0, JSON.stringify({ verdict: d.verdict, changed: d.changed }));

  // 落点目录不许污染下一单的交付判定
  const files = fs.readdirSync(path.join(ws, '_落点'));
  check('落点按任务号分目录（互不覆盖）', files.includes(tid), JSON.stringify(files));

  report();
})().catch(e => { console.log('LIVE_LANDING_ERROR=' + String((e && e.stack) || e)); process.exit(1); });

function report() {
  console.log(`\n真机落点验收：${oks.length} 通过 / ${fails.length} 失败`);
  for (const f of fails) console.log('  FAIL ' + f);
  if (fails.length) { console.log('LIVE_LANDING_FAILED'); process.exit(1); }
  console.log('ALL_LIVE_LANDING_OK');
  process.exit(0);
}