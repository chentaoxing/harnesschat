// 门状态标签的断言。跑法：node scripts/door-label-checks.cjs
//
// 为什么要有这一块：0.8.0 之前 @ 浮层只显示"（不可用）"，那是**检测轴**（这台机器上有没有这个 exe），
// 不是**能力轴**（它到底能不能替我把活干完）。本机 11 扇门里 10 扇 detected=true 但体检红在 auth/launch，
// 他 @ 下去要等满 15 分钟超时才知道派错了。门体检的数据早就在盘上，只是没送到他眼前。
//
// 纪律：
//   1. 断言脚本 require 的就是渲染层加载的那一份文件（UMD 尾），不是测试自己搭的 stub。
//   2. 没体检过就说"未体检"，不许说成"不可用"；绿得太久要说"久了没复核"，不许装作现在绿。
//   3. 只提醒，不拦派单——开哪扇门、派给谁是他的控制权。
const fs = require('fs');
const path = require('path');

const fails = [];
const oks = [];
const check = (name, pass, detail) => { (pass ? oks : fails).push(pass ? name : `${name}${detail ? ' — ' + detail : ''}`); };

const labelPath = path.join(__dirname, '..', 'src', 'renderer', 'door-label.js');
check('渲染层门标签模块存在', fs.existsSync(labelPath), labelPath);
const DoorLabel = fs.existsSync(labelPath) ? require(labelPath) : {};
const NOW = Date.parse('2026-11-08T12:00:00Z');
const row = (over) => Object.assign({ memberId: 'x', level: 'green', layer: null, reason: '', at: NOW - 3600 * 1000, canaryHit: true }, over || {});

// ---------- 1. 它真的被界面用上了，不是写完没人调用 ----------
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
check('index.html 引了 door-label.js', /door-label\.js/.test(html));
check('door-label.js 在 app.js 之前加载（否则 app.js 取不到 DoorLabel）',
  html.indexOf('door-label.js') >= 0 && html.indexOf('door-label.js') < html.indexOf('app.js'));
check('@ 浮层用了门标签', /DoorLabel\.label/.test(appjs.slice(appjs.indexOf('function showMention'), appjs.indexOf('function hideMention'))));
check('成员列表用了门标签', /DoorLabel\.label/.test(appjs.slice(appjs.indexOf('function renderMemberList'), appjs.indexOf('function isWorking'))));
check('启动时就 loadHealth（不等他先点开体检面板）',
  /loadHealth\(\)/.test(appjs.slice(appjs.lastIndexOf('loadState().then'))), appjs.slice(appjs.lastIndexOf('loadState().then')).slice(0, 400));

// ---------- 2. 判级矩阵 ----------
check('导出 label / hint', typeof DoorLabel.label === 'function' && typeof DoorLabel.hint === 'function');
if (typeof DoorLabel.label !== 'function' || typeof DoorLabel.hint !== 'function' || typeof DoorLabel.ageText !== 'function') {
  console.error(fails.map(x => 'FAIL  ' + x).join('\n'));
  console.error(`\nDOOR_LABEL_CHECKS_FAIL ${fails.length}/${oks.length + fails.length}`);
  process.exit(1);
}
let L = DoorLabel.label(row({ level: 'green' }), NOW);
check('新鲜绿 → 说能干活', /能干活/.test(L.short), JSON.stringify(L));
check('新鲜绿 → cls=green', L.cls === 'green', JSON.stringify(L));
check('新鲜绿 → 不提醒', DoorLabel.hint(row({ level: 'green' }), NOW) === null, JSON.stringify(DoorLabel.hint(row({ level: 'green' }), NOW)));

L = DoorLabel.label(row({ level: 'green', at: NOW - 30 * 3600 * 1000 }), NOW);
check('绿但超过 24h → 标为久了没复核', L.stale === true && /久|复核/.test(L.short), JSON.stringify(L));
check('绿但太久 → cls 不是 green（别装作现在绿）', L.cls !== 'green', JSON.stringify(L));
check('绿但太久 → 提醒里说"没复核"，不说"现在能用"', /没复核|久了/.test(DoorLabel.hint(row({ level: 'green', at: NOW - 30 * 3600 * 1000 }), NOW) || ''), JSON.stringify(DoorLabel.hint(row({ level: 'green', at: NOW - 30 * 3600 * 1000 }), NOW)));

L = DoorLabel.label(row({ level: 'chatter', canaryHit: false, reason: '答完了但没回出文件名' }), NOW);
check('只会聊天 → 短标签说清', /只会聊天|只聊天/.test(L.short), JSON.stringify(L));
check('只会聊天 → cls=chatter', L.cls === 'chatter', JSON.stringify(L));
check('只会聊天 → 提醒区分"只要回答"和"要它改文件"', /回答/.test(DoorLabel.hint(row({ level: 'chatter' }), NOW) || ''), JSON.stringify(DoorLabel.hint(row({ level: 'chatter' }), NOW)));

for (const [layer, word] of [['auth', '鉴权'], ['gateway', '网关'], ['rate_limit', '限流'], ['expired', '到期'], ['launch', '起不来'], ['not_found', '没检测到'], ['timeout', '超时']]) {
  L = DoorLabel.label(row({ level: 'red', layer, canaryHit: false, reason: 'x' }), NOW);
  check(`红在 ${layer} → 短标签点名那一层`, new RegExp(word).test(L.short), JSON.stringify(L));
  check(`红在 ${layer} → cls=red`, L.cls === 'red', JSON.stringify(L));
}
L = DoorLabel.label(row({ level: 'red', layer: ' nonsense', canaryHit: false }), NOW);
check('未知层不炸且不瞎猜', typeof L.short === 'string' && L.short.length > 0, JSON.stringify(L));

L = DoorLabel.label(row({ level: 'pending' }), NOW);
check('体检中 → 说体检中', /体检中|在跑/.test(L.short), JSON.stringify(L));

L = DoorLabel.label(null, NOW);
check('没体检过 → 说未体检', /未体检/.test(L.short), JSON.stringify(L));
check('没体检过 → 不许说成不可用（那是检测轴，不是能力轴）', !/不可用|未检测到/.test(L.short), JSON.stringify(L));
check('没体检过 → cls=none', L.cls === 'none', JSON.stringify(L));
check('没体检过 → 不提醒（别对没测过的门 nag）', DoorLabel.hint(null, NOW) === null);

// ---------- 3. 多久前：人话，且有界 ----------
check('1 小时前', /1\s*小时/.test(DoorLabel.ageText(NOW - 3600 * 1000, NOW)), DoorLabel.ageText(NOW - 3600 * 1000, NOW));
check('3 天前', /3\s*天/.test(DoorLabel.ageText(NOW - 3 * 86400000, NOW)), DoorLabel.ageText(NOW - 3 * 86400000, NOW));
check('刚刚', /刚/.test(DoorLabel.ageText(NOW - 5000, NOW)), DoorLabel.ageText(NOW - 5000, NOW));
check('未来时间戳不炸（时钟漂移）', typeof DoorLabel.ageText(NOW + 99999, NOW) === 'string', DoorLabel.ageText(NOW + 99999, NOW));
check('at 缺失不炸', typeof DoorLabel.ageText(undefined, NOW) === 'string');

// ---------- 4. 提醒只说不拦 ----------
const h = DoorLabel.hint(row({ level: 'red', layer: 'auth' }), NOW);
check('红门提醒带归因层', /鉴权/.test(h || ''), JSON.stringify(h));
check('红门提醒带多久前', /小时|天|刚/.test(h || ''), JSON.stringify(h));
check('红门提醒不含"禁止/已拦/不能派"（派单权归他）', !/禁止|已拦|不能派|拒绝派/.test(h || ''), JSON.stringify(h));
check('提醒有界（≤160 字）', String(h || '').length <= 160, String((h || '').length));
check('label 的 detail 带原因与时间', /小时|天|刚/.test(DoorLabel.label(row({ level: 'red', layer: 'auth', reason: '没登录或缺 key' }), NOW).detail), JSON.stringify(DoorLabel.label(row({ level: 'red', layer: 'auth', reason: '没登录或缺 key' }), NOW)));

console.log(oks.map(x => '  ok  ' + x).join('\n'));
if (fails.length) {
  console.error('\n' + fails.map(x => 'FAIL  ' + x).join('\n'));
  console.error(`\nDOOR_LABEL_CHECKS_FAIL ${fails.length}/${oks.length + fails.length}`);
  process.exit(1);
}
console.log(`\nDOOR_LABEL_CHECKS_OK ${oks.length}/${oks.length}`);