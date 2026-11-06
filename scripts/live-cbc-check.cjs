// 一次性实弹验证：真派一单给 CodeBuddy（cbc），看群转录里到底落了什么、账本记的是哪一层。
// 跑法：node scripts/live-cbc-check.cjs   （真的起子进程，约 1-2 分钟）
// 判定只认写进 UTF-8 日志文件的哨兵串，不认 shell 的 exit code。
const os = require('os');
const fs = require('fs');
const path = require('path');
const { GroupServer } = require('../src/server/server');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-live-cbc-'));
const server = new GroupServer({ dataDir: dir, staticDir: path.join(__dirname, '..', 'src', 'renderer'), port: 18997, token: 'live' });
server.listen();

const LOG = path.join(os.tmpdir(), 'hc-live-cbc.log');
const lines = [];
function say(s) { lines.push(s); try { fs.writeFileSync(LOG, lines.join('\n') + '\n', 'utf8'); } catch (e) { /* noop */ } }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// task 就是服务端 running 表里的那个对象引用：finishTask 直接在它身上改 status/text。
// 上一版我拿 this.messages 的形状去猜，猜空了——判状态要看对象本身，不看日志形状。
function snapshot(task) {
  return { status: task.status, text: task.text || '' };
}

async function main() {
  await sleep(600);
  const res = server.handleSend('@CodeBuddy 只回四个字：CBC 在线', '只回四个字：CBC 在线', 'codebuddy', null, null, null, 'research');
  const task = res && res.task;
  say('DISPATCH_STATUS=' + (task && task.status));
  if (!task || task.status === 'error') {
    say('BLOCKED_OR_FAILED=' + JSON.stringify(String(task && task.text || '').slice(0, 300)));
    say('LIVE_CBC_NOT_DONE');
    return;
  }
  const t0 = Date.now();
  let snap = { status: 'running' };
  while (Date.now() - t0 < 150000) {
    await sleep(2000);
    snap = snapshot(task);
    if (snap.status !== 'running') break;
  }
  say('ELAPSED_MS=' + (Date.now() - t0));
  say('FINAL_STATUS=' + snap.status);
  say('OUTPUT=' + JSON.stringify(String(snap.text).slice(0, 600)));
  const usage = require('../src/server/usage');
  const u = usage.snapshot(Date.now()).rows.find(r => r.memberId === 'codebuddy');
  say('LEDGER=' + JSON.stringify(u));
  say(snap.status === 'done' ? 'LIVE_CBC_OK' : 'LIVE_CBC_NOT_DONE');
}

main().catch(e => { say('LIVE_CBC_ERROR ' + (e && e.message)); say('LIVE_CBC_NOT_DONE'); })
  .then(() => process.exit(0));
