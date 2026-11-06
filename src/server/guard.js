// 派单前的凭证守卫。
//
// 边界来自这次调研：HarnessChat 只走"那家自己的 CLI + 那家自己的登录"，
// 绝不去读别家存的凭据。所以任何形如路径的参数或环境变量，只要指向别家的凭证文件位置，
// 就在起跑前拦下——宁可派单失败，也不让一个 agent 顺手拿到另一家的 key。
//
// 判定故意保守：只看"像路径的字符串"，普通提示词里出现 auth.json 字样不误伤；
// 成员引用自家目录下的登录文件是正常用法，放行。

// 凭据形状：除了常见的文件名，还认"名字里带 key 的数据文件"（engine-maas-key.dat、master-key.bin 这类
// 是各家应用自存的密钥，扩展名不是 .key）。普通 .dat（cache-index.dat / sessions.dat）不误伤。
const CRED_SHAPED = /(auth\.json|credentials?\.json|connector-keys|\.key$|token\.txt|id_rsa|\.env$|cookies|secrets?$|\.aws[\\/]credentials|hosts\.yml|\.config[\\/]gh|[\\/][\w.-]*key[\w.-]*\.(dat|bin|pem|json|txt))/i;
const PATH_SHAPED = /^(?:[a-zA-Z]:[\\/]|~?[\\/])/;

// 每个内置成员"自己家"的目录名；路径落在自家目录里就不算外借
const OWN_HOME = {
  zcode: ['.zcode'],
  claude: ['.claude'],
  codex: ['.codex'],
  gemini: ['.gemini'],
  qoderclicn: ['.qoder'],
  cline: ['.cline'],
  hermes: ['.hermes'],
  minimax: ['.minimax'],
  // CodeBuddy 的自家只有 .codebuddy：它的桌面端把 connector-keys 存在 .workbuddy 里，
  // 那是"它自己的密钥"，不是"我们可以指过去的文件"——所以 .workbuddy 故意不放进来。
  codebuddy: ['.codebuddy'],
  dsh: ['.dsh'],
  // 同理：QwenWork 应用自己的凭据（.qwenworkcn/engine-maas-key.dat 那类）不算 Qwen Code 的自家
  qwenwork: ['.qwen']
};

function inOwnHome(lower, homes) {
  // 必须是**路径段**，不能是子串：否则自家 `.qwen` 会把 `.qwenworkcn`（应用自己的凭据目录）
  // 也当成自家，QwenWork 那门就能合法指到 engine-maas-key.dat 上去了。这个错是断言抓出来的。
  return homes.some(h => lower.includes(h + '\\') || lower.includes(h + '/') || lower.endsWith(h));
}

function assertNoForeignCredentials(memberId, spawn) {
  const items = []
    .concat((spawn && spawn.args) || [])
    .concat(Object.values((spawn && spawn.env) || {}));
  const homes = (OWN_HOME[memberId] || []).map(h => h.toLowerCase());
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!PATH_SHAPED.test(s)) continue;
    if (!CRED_SHAPED.test(s)) continue;
    const lower = s.toLowerCase();
    if (inOwnHome(lower, homes)) continue;
    throw new Error(`别家凭证路径被拦下（成员 ${memberId}）：${s.slice(0, 140)}`);
  }
  return true;
}

module.exports = { assertNoForeignCredentials, OWN_HOME, CRED_SHAPED, inOwnHome };
