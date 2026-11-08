// 完成通知的断言。跑法：node scripts/notify-checks.cjs
//
// 为什么要有这一块：这台控制台的出发点是"他不在每个终端前盯着，活也能派出去、跑完、看得见"。
// 0.8.0 之前全仓库没有一处 Notification / flashFrame / 托盘气泡——关窗即隐藏到托盘，
// 一单跑完他在桌面上得不到任何信号。派得出去、跑完了，但"看得见"这一段是断的。
//
// 两条纪律写死在断言里：
//   1. 通知文案不许比卡片更乐观。卡片说"只说了没动手"，通知就不能写"任务完成"——
//      那等于把假绿推到桌面上，比界面里的假绿更难发现。
//   2. 他正看着窗口时不打扰；体检探针（quiet）永不通知，否则每天 11 条桌面噪音。
const fails = [];
const oks = [];
const check = (name, pass, detail) => { (pass ? oks : fails).push(pass ? name : `${name}${detail ? ' — ' + detail : ''}`); };

const notify = require('../src/notify');

// ---------- 1. 什么时候该响 ----------
check('默认开（这是产品的目的，不默认替他关掉）', notify.enabled({}) === true, String(notify.enabled({})));
check('设置里关得掉', notify.enabled({ notify: { onFinish: false } }) === false);
check('设置里显式开也算开', notify.enabled({ notify: { onFinish: true } }) === true);
check('config 为 null 不炸', notify.enabled(null) === true);

const base = { enabled: true, quiet: false, taskKind: 'execute', visible: false, focused: false };
check('窗口隐藏着 → 必须通知', notify.shouldNotify(base) === true);
check('窗口可见但没聚焦（他在别的软件里）→ 必须通知', notify.shouldNotify({ ...base, visible: true, focused: false }) === true);
check('窗口可见且正聚焦（他就看着）→ 不打扰', notify.shouldNotify({ ...base, visible: true, focused: true }) === false);
check('可见性未知但聚焦 → 不打扰', notify.shouldNotify({ ...base, visible: undefined, focused: true }) === false);
check('体检探针永不通知', notify.shouldNotify({ ...base, quiet: true }) === false);
check('taskKind=health 永不通知（哪怕没标 quiet）', notify.shouldNotify({ ...base, taskKind: 'health' }) === false);
check('开关关掉就不通知', notify.shouldNotify({ ...base, enabled: false }) === false);
check('失败也要通知（无人值守时失败比成功更需要知道）', notify.shouldNotify({ ...base, status: 'error' }) === true);
check('空入参不炸且不通知', notify.shouldNotify(null) === false);

// ---------- 2. 文案必须与卡片同源，不许更乐观 ----------
const mk = (over) => Object.assign({
  id: 'abc123', memberId: 'qoderclicn', memberName: 'Qoder CLI', status: 'done',
  prompt: '把这段整理成一份文档', text: '好的，我已经整理完了。', taskKind: 'produce', at: Date.now()
}, over || {});

let n = notify.build(mk({ delivery: { verdict: 'talked_only', headline: '文件没变化（0 个）', changed: 0 } }));
check('通知带 taskId（点击要能回到那张卡片）', n && n.taskId === 'abc123', JSON.stringify(n));
check('通知带成员名', /Qoder CLI/.test(n.title + n.body), JSON.stringify(n));
check('只说了没动手 → 标题不许出现"完成/成功"', !/完成|成功/.test(n.title), n.title);
check('只说了没动手 → 标题要说清没动手', /没动手|只说了|零变化|没变化/.test(n.title), n.title);
check('只说了没动手 → tone 不是 ok', n.tone !== 'ok', JSON.stringify(n));

n = notify.build(mk({ delivery: { verdict: 'produced', headline: '文件 新增 2 · 改动 0 · 删除 0', changed: 2 } }));
check('真产出 → 标题说交付', /交付|产出|新增/.test(n.title), n.title);
check('真产出 → tone=ok', n.tone === 'ok', JSON.stringify(n));
check('真产出 → 正文带称出来的 headline', /新增 2/.test(n.body), n.body);

n = notify.build(mk({ status: 'error', delivery: { verdict: 'failed', headline: '没跑成，没有交付物可称' } }));
check('失败 → 标题说失败', /失败|没跑成|出错/.test(n.title), n.title);
check('失败 → tone=bad', n.tone === 'bad', JSON.stringify(n));
check('失败 → 不许出现"完成"', !/完成|成功/.test(n.title), n.title);

n = notify.build(mk({ status: 'timeout', delivery: { verdict: 'failed', headline: '没跑成，没有交付物可称' } }));
check('超时 → 标题说超时', /超时/.test(n.title), n.title);

n = notify.build(mk({ delivery: { verdict: 'blocked_by_permission', headline: '文件没变化（0 个）· 正文提到权限', changed: 0 } }));
check('疑似被权限档拦住 → 标题带"可能"，不装作确定', /可能/.test(n.title), n.title);

// 落点：通知必须说清那是控制台落的回答原文，不是成员自己写的文件
n = notify.build(mk({
  delivery: {
    verdict: 'talked_only', headline: '文件没变化（0 个）', changed: 0,
    landing: { ok: true, dir: 'C:\\ws\\_落点\\abc123', files: [{ name: '回答.md', abs: 'C:\\ws\\_落点\\abc123\\回答.md', size: 12, kind: 'answer' }], note: '控制台把它的回答原文落成了 1 个文件（不是它自己写的文件，别当成它动了手）：回答.md' }
  }
}));
check('有落点 → 正文提到落点', /落点|回答原文/.test(n.body), n.body);
check('有落点 → 正文保留"不是它自己写的"这句 honesty', /不是它自己写的/.test(n.body), n.body);
check('有落点 → 标题仍不许说完成', !/完成|成功/.test(n.title), n.title);

n = notify.build(mk({ delivery: { verdict: 'talked_only', headline: '文件没变化（0 个）', landing: { ok: false, error: '目录不可写', note: '落点没写成：目录不可写' } } }));
check('落点失败 → 正文说落点没写成', /没写成|不可写/.test(n.body), n.body);

// 没有交付结论（旧卡片/异常）时不许编一个
n = notify.build(mk({ delivery: null }));
check('没有交付结论 → 不许自称产出', !/交付了|产出了/.test(n.title + n.body), JSON.stringify(n));
check('没有交付结论 → 标题只说跑完了', /跑完|结束|答完/.test(n.title), n.title);

// ---------- 3. 有界：通知不是转录倾倒场 ----------
const longPrompt = 'X'.repeat(5000);
n = notify.build(mk({ prompt: longPrompt, text: 'Y'.repeat(20000), delivery: { verdict: 'produced', headline: '文件 新增 1', changed: 1 } }));
check('标题有界（≤80 字）', n.title.length <= 80, String(n.title.length));
check('正文有界（≤400 字）', n.body.length <= 400, String(n.body.length));
check('正文不整段倾倒成员输出', !/Y{500}/.test(n.body), n.body.slice(0, 120));
check('task 为 null 不炸', !!notify.build(null) === false || typeof notify.build(null) === 'object');

// ---------- 4. 托盘提示：OS 层面关掉通知时仍留一条痕迹 ----------
const tip = notify.trayTip(mk({ delivery: { verdict: 'talked_only', headline: '文件没变化（0 个）' } }));
check('托盘提示是字符串', typeof tip === 'string' && tip.length > 0, JSON.stringify(tip));
check('托盘提示带成员名', /Qoder CLI/.test(tip), tip);
check('托盘提示也不许把没动手说成完成', !/成功|完成/.test(tip), tip);
check('托盘提示有界（≤120 字）', tip.length <= 120, String(tip.length));

// ---------- 5. 点击要回到那张卡片 ----------
check('导出 focusEvent（主进程→渲染进程的事件名，两边共用一个常量）',
  typeof notify.FOCUS_EVENT === 'string' && notify.FOCUS_EVENT.length > 0, JSON.stringify(notify.FOCUS_EVENT));

// ---------- 6. 手动停止不许被说成"成员失败" ----------
// 反向的乐观/悲观都要防：他自己按的停止，通知说"失败：没跑成"等于诬赖成员，
// 也会把账本里的失败归因带偏。
n = notify.build(mk({ stopped: true, status: 'error', delivery: { verdict: 'failed', headline: '没跑成，没有交付物可称' } }));
check('手动停止 → 标题说是你停的', /你停|手动停/.test(n.title), n.title);
check('手动停止 → 标题不许说失败', !/失败|没跑成/.test(n.title), n.title);
check('手动停止 → tone 不是 bad', n.tone !== 'bad', JSON.stringify(n.tone));
const tipStopped = notify.trayTip(mk({ stopped: true, status: 'error' }));
check('手动停止 → 托盘提示也说是你停的', /你停|手动停/.test(tipStopped), tipStopped);

// ---------- 7. preload 必须留在沙箱里 ----------
// 2026-11-08 界面验收实测：preload 里写 require('./notify') → preload-error
// "module not found: ./notify" → 整个 contextBridge 没暴露 → window.harnesschat 是 undefined。
// 那不只是回跳坏了：更新器、落点"打开文件"全跟着死。沙箱 preload 只认 electron 等少数模块，
// 不认仓库里的相对路径。所以事件名在 preload 里只能是字面量，再用这条断言防它与常量漂移。
const fs = require('fs');
const path = require('path');
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
// 量的是代码不是注释：上面那段说明里就写着反例，按全文匹配会把注释判成违规（假红）。
const preloadCode = preloadSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const localRequires = preloadCode.match(/require\(\s*['"]\.[^'"]*['"]\s*\)/g) || [];
check('preload 不许 require 仓库里的相对模块（沙箱会整份失败）', localRequires.length === 0, localRequires.join(', '));
check('preload 里的事件名字面量与 notify.FOCUS_EVENT 一致',
  preloadSrc.includes(`'${notify.FOCUS_EVENT}'`) || preloadSrc.includes(`"${notify.FOCUS_EVENT}"`),
  notify.FOCUS_EVENT);
check('preload 仍然暴露回跳与落点那几面', /onTaskFocus/.test(preloadSrc) && /openPath/.test(preloadSrc) && /showItem/.test(preloadSrc));

console.log(oks.map(x => '  ok  ' + x).join('\n'));
if (fails.length) {
  console.error('\n' + fails.map(x => 'FAIL  ' + x).join('\n'));
  console.error(`\nNOTIFY_CHECKS_FAIL ${fails.length}/${oks.length + fails.length}`);
  process.exit(1);
}
console.log(`\nNOTIFY_CHECKS_OK ${oks.length}/${oks.length}`);