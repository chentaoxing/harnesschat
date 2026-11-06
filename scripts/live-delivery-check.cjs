const fs = require('fs');
const path = require('path');
const tok = fs.readFileSync(path.join(process.env.APPDATA, 'HarnessChat', 'token.txt'), 'utf8').trim();
const H = { authorization: 'Bearer ' + tok, 'content-type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const B = 'http://127.0.0.1:18790';

(async () => {
  const st = await (await fetch(B + '/api/state', { headers: H })).json();
  const marker = 'DELIVERY-PROBE-' + Date.now() + '.md';
  const prompt = '只做一个动作：在当前工作区根目录新建文件 ' + marker + '，内容写一行 hi。做完只回一句 DONE，不要做别的事。';
  const r = await (await fetch(B + '/api/send', { method: 'POST', headers: H, body: JSON.stringify({ text: '@Qoder CLI 交付验收', prompt, memberId: 'qoderclicn', taskKind: 'execute' }) })).json();
  const task = r.task;
  let cur = null;
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const s2 = await (await fetch(B + '/api/state', { headers: H })).json();
    cur = (s2.messages || []).find(m => m.type === 'task' && m.id === task.id);
    if (cur && cur.status !== 'running') break;
  }
  const dv = cur && cur.delivery;
  console.log('FINAL=' + (cur && cur.status));
  console.log('OUTPUT=' + JSON.stringify(String((cur && cur.text) || '').slice(0, 200)));
  console.log('VERDICT=' + (dv && dv.verdict));
  console.log('HEADLINE=' + (dv && dv.headline));
  console.log('ARTIFACTS=' + JSON.stringify((dv && dv.artifacts) || []));
  const exists = fs.existsSync(path.join(st.workspace, marker));
  console.log('FILE_ON_DISK=' + exists);
  const leaked = JSON.stringify(dv || {}).includes('qoder-credits');
  console.log('TOOL_INTERNAL_LEAKED=' + leaked);
  // 两种都算自洽：真建了文件→produced；被权限档拦住→blocked_by_permission。
  // 不自洽的是"它没建成而我说有交付"（0.7.0 就是这个假绿）。
  const ok = dv && (dv.verdict === 'produced' ? exists : dv.verdict === 'blocked_by_permission');
  console.log('VERDICT_SELF_CONSISTENT=' + (ok ? 'yes' : 'no'));
  console.log(ok && !leaked ? 'DELIVERY_UAT2_OK' : 'DELIVERY_UAT2_BAD');
})().catch(e => console.log('ERR ' + e.message));
