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

module.exports = { safeExec };
