// 派单前的凭证守卫。
//
// 边界来自这次调研：HarnessChat 只走"那家自己的 CLI + 那家自己的登录"，
// 绝不去读别家存的凭据。所以任何形如路径的参数或环境变量，只要指向别家的凭证文件位置，
// 就在起跑前拦下——宁可派单失败，也不让一个 agent 顺手拿到另一家的 key。
//
// 判定故意保守：只看"像路径的字符串"，普通提示词里出现 auth.json 字样不误伤；
// 成员引用自家目录下的登录文件是正常用法，放行。

const CRED_SHAPED = /(auth\.json|credentials?\.json|connector-keys|\.key$|token\.txt|id_rsa|\.env$|cookies|secrets?$|\.aws[\\/]credentials)/i;
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
  minimax: ['.minimax']
};

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
    if (homes.some(h => lower.includes(h))) continue;
    throw new Error(`别家凭证路径被拦下（成员 ${memberId}）：${s.slice(0, 140)}`);
  }
  return true;
}

module.exports = { assertNoForeignCredentials, OWN_HOME };
