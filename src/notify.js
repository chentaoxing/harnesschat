// 完成通知：判据与文案都在这里，且不 require('electron')——
// 这样断言脚本量的就是产品真正用的那把尺子，不是测试自己搭的 stub。
// （0.8.0 的 UI 验收就是因为测试进程没注册 handler 而挂死，见 scripts/ui-landing-check.cjs）
//
// 为什么要有：关窗即隐藏到托盘，一单跑完他在桌面上得不到任何信号。
// "派得出去、跑完、看得见"这三段里，前两段 0.7.x 已经闭上，第三段一直是断的。
//
// 一条纪律：**通知不许比卡片更乐观**。卡片说"只说了没动手"，通知就不能写"任务完成"。
// 桌面上的假绿比界面里的更难发现——他根本不会点开去看。

const FOCUS_EVENT = 'task:focus';

const MAX_TITLE = 80;
const MAX_BODY = 400;
const MAX_TIP = 120;
const MAX_PROMPT_EXCERPT = 80;

// 默认开：这正是这台控制台存在的理由。要关在设置里关，控制权归他。
function enabled(config) {
  const n = config && config.notify;
  if (!n || typeof n !== 'object') return true;
  return n.onFinish !== false;
}

/**
 * 什么时候该响。
 * 他正看着窗口（可见且聚焦）就别打扰；体检探针永远不响，否则每天 11 条桌面噪音。
 * 失败照样响——无人值守时，失败比成功更需要他知道。
 */
function shouldNotify(o) {
  if (!o || typeof o !== 'object') return false;
  if (o.enabled === false) return false;
  if (o.quiet) return false;
  if (o.taskKind === 'health') return false;
  if (o.focused && o.visible !== false) return false;
  return true;
}

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// 判词 → 人话。这张表就是"不许更乐观"那条纪律的落点。
const VERDICT_WORD = {
  produced: '交付了文件',
  talked_only: '只说了没动手',
  blocked_by_permission: '可能被权限档拦住',
  failed: '没跑成',
  unknown: '交付没称出来'
};

function verdictOf(task) {
  const d = task && task.delivery;
  if (d && VERDICT_WORD[d.verdict]) return d.verdict;
  if (task && task.status === 'timeout') return 'failed';
  if (task && task.status === 'error') return 'failed';
  return null; // 没有交付结论：不编一个
}

function toneOf(verdict, status, stopped) {
  if (stopped) return 'warn'; // 他自己按的停止，不是成员坏了
  if (status === 'error' || status === 'timeout') return 'bad';
  if (verdict === 'produced') return 'ok';
  if (verdict === 'failed') return 'bad';
  return 'warn';
}

function titleWord(verdict, status, hasDelivery, stopped) {
  if (stopped) return '你停掉了这单';
  if (status === 'timeout') return '超时：没跑成';
  if (status === 'error') return '失败：没跑成';
  if (verdict) return VERDICT_WORD[verdict];
  if (status === 'done') return hasDelivery ? '跑完了' : '答完了（没有交付结论）';
  return '结束了';
}

/**
 * 造一条通知。返回 null = 这条任务不值得造（入参为空）。
 * 正文顺序有讲究：先判词 headline，再落点说明，最后才是任务摘要——
 * 400 字截断时先砍掉的是任务摘要，绝不能把"不是它自己写的"那句 honesty 砍掉。
 */
function build(task) {
  if (!task || typeof task !== 'object') return null;
  const name = clip(task.memberName || task.memberId || '成员', 24);
  const verdict = verdictOf(task);
  const status = String(task.status || '');
  const stopped = !!task.stopped;
  const d = task.delivery || null;
  const title = clip(`${name} · ${titleWord(verdict, status, !!d, stopped)}`, MAX_TITLE);

  const parts = [];
  if (stopped) parts.push('你在卡片上点了停止，进程树已经杀干净');
  else if (d && d.headline) parts.push(clip(d.headline, 120));
  else if (status === 'timeout') parts.push('跑满超时被停掉');
  else if (status === 'error') parts.push('这一单没跑成');
  else parts.push('没有交付结论可称');

  const L = d && d.landing;
  if (L) {
    // note 由 landing.describe 生成，本身就带着"不是它自己写的文件"这句；
    // 这里不重写，免得两处措辞漂移。
    parts.push(clip(L.note || (L.ok ? '控制台落了回答原文' : '落点没写成'), 160));
  }
  if (task.prompt) parts.push('任务：' + clip(task.prompt, MAX_PROMPT_EXCERPT));

  return { taskId: String(task.id || ''), title, body: clip(parts.join(' · '), MAX_BODY), tone: toneOf(verdict, status, stopped) };
}

/** OS 层面把通知关掉时，托盘提示仍留一条痕迹。措辞与通知同源。 */
function trayTip(task) {
  if (!task || typeof task !== 'object') return 'HarnessChat — harness 群聊';
  const name = clip(task.memberName || task.memberId || '成员', 24);
  const verdict = verdictOf(task);
  const status = String(task.status || '');
  return clip(`HarnessChat · ${name} · ${titleWord(verdict, status, !!task.delivery, !!task.stopped)}`, MAX_TIP);
}

module.exports = { FOCUS_EVENT, enabled, shouldNotify, build, trayTip, VERDICT_WORD, MAX_TITLE, MAX_BODY };