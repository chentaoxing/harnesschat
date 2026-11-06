// 全门体检：一次派单只能证明"进程起得来"，证明不了"这扇门能干完一段活"。
// 判据做成可反驳的形式：在工作区放一个随机 canary 文件名，只有一扇真的用了工具的门
// 才可能把它的名字回出来；答不出来就是"只会聊天"或"根本没跑起来"，不算通。
// 跑法：node scripts/door-health.cjs [memberId...]   （默认所有内置成员）
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GroupServer } = require('../src/server/server');
const usage = require('../src/server/usage');
const { MEMBERS } = require('../src/server/adapters');

const ids = process.argv.slice(2).filter(x => /^[a-z]+$/.test(x));
const targets = (ids.length ? MEMBERS.filter(m => ids.includes(m.id)) : MEMBERS).map(m => m.id);
if (!targets.length) { console.log('no targets'); process.exit(2); }

// 独立的一次性工作区：不碰任何真项目
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-door-probe-'));
const canary = 'CANARY-' + crypto.randomBytes(6).toString('hex') + '.txt';
fs.writeFileSync(path.join(probeDir, canary), 'read-only probe marker\n', 'utf8');
fs.writeFileSync(path.join(probeDir, 'README.txt'), 'probe workspace\n', 'utf8');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-door-data-'));
const server = new GroupServer({ dataDir, staticDir: path.join(__dirname, '..', 'src', 'renderer'), port: 18995, token: 'probe' });
server.listen();

const LOG = path.join(os.tmpdir(), 'hc-door-health.log');
const lines = [];
function say(s) { lines.push(s); try { fs.writeFileSync(LOG, lines.join('\n') + '\n', 'utf8'); } catch (e) { /* noop */ } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PROMPT = '只做一件事：用你的文件工具列出当前工作区根目录下的所有文件名，然后把这些文件名原样回给我，每行一个。不要修改、不要创建任何文件，不要解释。';

async function probe(id) {
  const res = server.handleSend('@' + id + ' 体检', PROMPT, id, null, null, probeDir, 'research');
  const task = res && res.task;
  if (!task) return say(`${id}\tNO_TASK\t` + JSON.stringify(String((res && res.error) || '').slice(0, 600)));
  if (task.status === 'error') {
    return say(`${id}\tBLOCKED_OR_NOTFOUND\tms=0\tcanary=false\t-\t` + JSON.stringify(String(task.text).slice(0, 600)));
  }
  const t0 = Date.now();
  while (task.status === 'running' && Date.now() - t0 < 170000) await sleep(2000);
  const row = usage.snapshot(Date.now()).rows.find(r => r.memberId === id);
  const out = String(task.text || '');
  const hit = out.includes(canary);
  const label = task.status === 'done' ? (hit ? 'WORKS' : 'CHATTED_NO_TOOLS') : 'FAIL_' + ((row && Object.keys(row.byKind || {})[0]) || task.status);
  say(`${id}\t${label}\tms=${Date.now() - t0}\tcanary=${hit}\tlayer=${JSON.stringify(row && row.byKind)}\tout=${JSON.stringify(out.slice(0, 600))}`);
}

async function main() {
  say('CANARY=' + canary);
  say('PROBE_DIR=' + probeDir);
  for (const id of targets) {
    try { await probe(id); } catch (e) { say(id + '\tERROR\t' + (e && e.message)); }
  }
  say('DOOR_HEALTH_DONE');
}

main().then(() => process.exit(0)).catch(e => { say('FATAL ' + (e && e.message)); process.exit(1); });
