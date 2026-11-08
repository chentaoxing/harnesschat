// 唯一的进程启动出口。
// 安全属性（实现即保证）：
//   1. execFile 语义：从不经过 shell，argv 逐元素传递，无任何元字符解释面；
//   2. opts.shell 被显式拒绝，调用方无法降级为 shell 模式；
//   3. file/argv 做类型白名单校验，非字符串元素直接抛错。
// 成员适配器（adapters.js）负责把 CLI 垫片静态解析为真实 exe + JS 入口，
// 用户 prompt 永远只是 argv 中的一个普通字符串元素。
const cp = require('child_process');
const LAUNCH_PROC = cp.execFile;

function safeExec(file, argv, opts = {}) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new Error('safeExec: file 必须是非空字符串路径');
  }
  if (!Array.isArray(argv) || argv.some(a => typeof a !== 'string')) {
    throw new Error('safeExec: argv 必须是字符串数组');
  }
  if (opts.shell) throw new Error('safeExec: 禁止 shell 模式');
  // stdin 一律 ignore（立即关闭）：部分 CLI（codex exec 等）会在 stdin 管道常开时挂起等输入
  return LAUNCH_PROC(file, argv, { ...opts, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * 停止要杀干净一整棵进程树，不能只杀直接子进程。
 *
 * 本机实测（2026-11-08，带正对照）：child.kill() 能带走普通孙子，但成员用
 * detached:true 起的后台孙子会活下来并继续写盘——那就是"卡片显示停了、额度还在烧"。
 * 无人值守的控制台不能靠这种平台 incidental 行为兜底。
 *
 * 安全属性不变：taskkill 是固定系统 exe，argv 逐元素传，pid 只来自 OS 给的数字，
 * 不经过 shell，没有任何字符串拼接面。taskkill 不可用时回落到 child.kill()。
 */
function stopTree(child) {
  if (!child || typeof child !== 'object') return false;
  // 已经退出的别再杀一遍（也避免 close 事件还没到时的重复调用报错）
  if (child.exitCode !== null || child.signalCode !== null) return false;
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    try { return child.kill(); } catch (e) { return false; }
  }
  if (process.platform === 'win32') {
    try {
      cp.execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore', timeout: 8000, windowsHide: true, shell: false
      });
      return true;
    } catch (e) { /* 进程已退或 taskkill 拒绝：下面回落 */ }
  }
  try { return child.kill(process.platform === 'win32' ? undefined : 'SIGTERM'); } catch (e) { return false; }
}

module.exports = { safeExec, stopTree };
