// 门状态标签：把"门体检"的结论送到他派单时看得见的地方（@ 浮层 + 成员列表）。
//
// 为什么要单独一个文件：断言脚本 require 的就是这一份（UMD 尾），
// 不是测试自己搭的 stub —— 0.8.0 的 UI 验收吃过"测了自己的假 handler"的亏。
//
// 两条轴不许混：
//   detected/enabled = 这台机器上有没有这个 exe（检测轴）
//   level            = 它到底能不能替我把活干完（能力轴，canary 判据）
// 本机 11 扇门里 10 扇 detected=true 却红在 auth/launch；只显示"（不可用）"等于什么都没说。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DoorLabel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // 与 health.greenDoors 的 24h 口径一致：过绿不等于现在绿
  var STALE_MS = 24 * 3600 * 1000;

  var LAYER_WORD = {
    auth: '鉴权不通',
    gateway: '网关不通',
    rate_limit: '撞了限流',
    expired: '订阅到期',
    launch: 'CLI 起不来',
    not_found: '没检测到',
    timeout: '超时没回',
    other: '失败未归类'
  };

  function ageText(at, now) {
    var ref = Number(now) || Date.now();
    var t = Number(at);
    if (!isFinite(t) || t <= 0) return '不知道多久前';
    var d = ref - t;
    if (d < 0) d = 0; // 时钟漂移不许造出"负小时"
    if (d < 60 * 1000) return '刚刚';
    if (d < 3600 * 1000) return Math.max(1, Math.round(d / 60000)) + ' 分钟前';
    if (d < 86400000) return Math.max(1, Math.round(d / 3600000)) + ' 小时前';
    return Math.max(1, Math.round(d / 86400000)) + ' 天前';
  }

  /**
   * row = health.latest() 里那一条；null = 这扇门从没体检过。
   * 返回 {short, detail, cls, stale}：short 上徽章，detail 上 title/提醒。
   */
  function label(row, now) {
    var ref = Number(now) || Date.now();
    if (!row || typeof row !== 'object') {
      return { short: '未体检', detail: '还没体检过这扇门：不知道它能不能干活（不是"不可用"）', cls: 'none', stale: false };
    }
    var age = ageText(row.at, ref);
    var stale = ref - (Number(row.at) || 0) > STALE_MS;
    var reason = String(row.reason || '');
    var level = String(row.level || '');

    if (level === 'pending') {
      return { short: '体检中', detail: '探针还在跑，不猜结论', cls: 'pending', stale: false };
    }
    if (level === 'green') {
      if (stale) {
        return {
          short: '绿过·久了没复核', cls: 'stale', stale: true,
          detail: '上次体检能干活（canary 命中），但已经 ' + age + '没复核了。' + (reason ? ' ' + reason : '')
        };
      }
      return { short: '能干活', detail: '上次体检 ' + age + '：' + (reason || '把随机文件名独立成行回出来了'), cls: 'green', stale: false };
    }
    if (level === 'chatter') {
      return {
        short: '只会聊天', cls: 'chatter', stale: stale,
        detail: '上次体检 ' + age + '：答完了但没回出文件名，没证明它调用过文件工具。' + (reason ? ' ' + reason : '')
      };
    }
    if (level === 'red') {
      var word = LAYER_WORD[String(row.layer || '')] || LAYER_WORD.other;
      return { short: word, cls: 'red', stale: stale, detail: '上次体检 ' + age + '：' + (reason || word) };
    }
    return { short: '结论未知', cls: 'none', stale: stale, detail: '体检记录里没有认得出的级别（' + level + '）' };
  }

  /**
   * 派单前的一句提醒。只说不拦——开哪扇门、派给谁是他的控制权。
   * 返回 null = 没什么可提醒的（没体检过 / 新鲜绿）。
   */
  function hint(row, now) {
    var ref = Number(now) || Date.now();
    if (!row || typeof row !== 'object') return null;
    var L = label(row, ref);
    if (L.cls === 'green' || L.cls === 'none' || L.cls === 'pending') return null;
    var age = ageText(row.at, ref);
    var s;
    if (L.cls === 'stale') {
      s = '这扇门上次的结论是绿的，但已经 ' + age + ' 没复核了，现在不一定还能用。';
    } else if (L.cls === 'chatter') {
      s = '上次体检（' + age + '）它答完了却没证明调用过文件工具：只要一个回答的活可以派，要它改文件大概率落空。';
    } else {
      s = '上次体检（' + age + '）红在「' + L.short + '」：这单很可能等满超时才回来。';
    }
    return s.length > 160 ? s.slice(0, 159) + '…' : s;
  }

  return { label: label, hint: hint, ageText: ageText, LAYER_WORD: LAYER_WORD, STALE_MS: STALE_MS };
});