// 一次性实弹验证：真派一单给指定成员，看卡片落的文本、账本落的层。
// 跑法：node scripts/live-member-check.cjs dsh qwenwork
// 判定只认写进 UTF-8 日志文件的哨兵串与正文，不认 shell 的 exit code。
const os = require('os');
const fs = require('fs');
const path = require('path');
const { GroupServer } = require('../src/server/server');
const usage = require('../src/server/usage');

const ids = process.argv.slice(2).filter(x => /^[a-z]+$/.test(x));
if (!ids.length) { console.log('usage: node scripts/live-member-check.cjs <memberId...>'); process.exit(2); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-live-'));
const server = new GroupServer({ dataDir: dir, staticDir: path.join(__dirname, '..', 'src', 'renderer'), port: 18996, token: 'live' });
server.listen();

const LOG = path.join(os.tmpdir(), 'hc-live-members.log');
const lines = [];
function say(s) { lines.push(s); try { fs.writeFileSync(LOG, lines.join('\n') + '\n', 'utf8'); } catch (e) { /* noop */ } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function one(id) {
  const res = server.handleSend('@' + id + ' 只回四个字：DOOR-OK', '只回四个字：DOOR-OK', id, null, null, null, 'research');
  const task = res && res.task;
  if (!task) { say(id + ': NO_TASK'); return; }
  say(id + ': DISPATCH=' + task.status);
  if (task.status === 'error') { say(id + ': REASON=' + JSON.stringify(String(task.text).slice(0, 200))); return; }
  const t0 = Date.now();
  while (task.status === 'running' && Date.now() - t0 < 150000) await sleep(2000);
  const row = usage.snapshot(Date.now()).rows.find(r => r.memberId === id);
  say(id + ': STATUS=' + task.status + ' ms=' + (Date.now() - t0));
  say(id + ': OUTPUT=' + JSON.stringify(String(task.text).slice(0, 300)));
  say(id + ': LAYER=' + JSON.stringify(row && row.byKind) + ' verdict=' + (row && row.freeEvidence && row.freeEvidence.verdict));
}

async function main() {
  await sleep(600);
  for (const id of ids) { try { await one(id); } catch (e) { say(id + ': ERROR ' + (e && e.message)); } }
  say('LIVE_MEMBER_CHECK_DONE');
}

main().then(() => process.exit(0)).catch(e => { say('FATAL ' + (e && e.message)); process.exit(1); });
