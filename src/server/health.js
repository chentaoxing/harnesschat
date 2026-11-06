// 门体检：回答"这扇门到底能不能替我把一段活干完"，而不是"它能不能回话"。
//
// 为什么需要：账本记的是成败，闸门记的是限流，但这些都建立在"派单跑完了"上。
// 2026-11-07 全机 11 扇门实测，只有 1 扇真的调用了文件工具——其余的要么卡 key，
// 要么答得漂亮但一次工具没用。没有这张表，"按任务类型自动选人"就是拿空数据排序。
//
// 判据刻意做成可反驳的：体检脚本在一次性工作区里造一个随机文件名，
// 只有真的读了目录的门才可能把它回出来；模型记忆里不存在这个名字，猜不出来。
const fs = require('fs');
const path = require('path');
const usage = require('./usage');

let filePath = null;
let rows = [];

function init(dir) {
  filePath = path.join(dir, 'health.jsonl');
  rows = [];
  let raw = '';
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (e) { return; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (e) { /* 半行忽略 */ }
  }
}

function record(ev) {
  const row = {
    at: ev.at || Date.now(),
    memberId: String(ev.memberId || ''),
    level: String(ev.level || 'red'),
    layer: ev.layer || null,
    reason: String(ev.reason || ''),
    ms: Number(ev.ms) || 0,
    canaryHit: !!ev.canaryHit
  };
  rows.push(row);
  if (filePath) { try { fs.appendFileSync(filePath, JSON.stringify(row) + '\n'); } catch (e) { /* 盘写不拖垮体检 */ } }
  return row;
}

// canary 必须**独立成行**才算证据。写在句子中间（"我会创建 CANARY-x.txt 给你"）不算——
// 那一句话既没证明它读了目录，也正好是它自己造一个文件来骗过判据的说法。
function canaryLinePresent(output, canary) {
  const needle = String(canary || '').trim().toLowerCase();
  if (!needle) return false;
  return String(output || '').split(/\r?\n/).some(raw => {
    const line = raw.replace(/^[\s>*\-+•·]*/, '').replace(/[|`"'，,。;；:：].*$/, '').trim().toLowerCase();
    return line === needle || line.startsWith(needle + ' ');
  });
}

const LAYER_REASON = {
  auth: '鉴权不通：没登录或缺 key',
  gateway: '网关侧不通：本机路由没启用或上游连不上',
  rate_limit: '撞了限流：有额度上限',
  expired: '订阅/套餐到期',
  launch: 'CLI 本体起不来：依赖或入口没落地（不是 key 的问题）',
  not_found: '这台机器上没检测到这个应用',
  timeout: '跑到超时也没回',
  other: '失败原因未归类'
};

/**
 * 一次体检的判级。level：
 *   green    —— 跑完了，且把随机 canary 的文件名独立成行回了出来（真的用了工具）
 *   chatter  —— 跑完了，但没回出 canary：只会聊天，不能算能干活的门
 *   red      —— 失败，带归因层
 *   pending  —— 还没跑完，不猜
 */
function judge(ev) {
  const at = ev.at || Date.now();
  const hit = canaryLinePresent(ev.output, ev.canary);
  if (ev.status === 'running') return { memberId: ev.memberId, level: 'pending', layer: null, reason: '还在跑', at, ms: 0, canaryHit: false };
  if (ev.status !== 'done') {
    const layer = usage.classifyError({ status: 'error', output: ev.output });
    return { memberId: ev.memberId, level: 'red', layer, reason: LAYER_REASON[layer] || LAYER_REASON.other, at, ms: ev.ms || 0, canaryHit: false };
  }
  if (hit) return { memberId: ev.memberId, level: 'green', layer: null, reason: '实测会用工具（canary 命中）', at, ms: ev.ms || 0, canaryHit: true };
  return {
    memberId: ev.memberId, level: 'chatter', layer: null, at, ms: ev.ms || 0, canaryHit: false,
    reason: '答完了但没回出文件名：没证明它调用过文件工具，不能算能干活的门'
  };
}

// 提示词里绝不出现 canary 名字（否则等于把答案念给它听）；并且明确禁止它自己造文件。
function probePrompt() {
  return [
    '只做一件事，不要做任何其它操作：',
    '1. 用你的文件工具**列出当前工作区根目录下的所有文件和文件夹名**；',
    '2. 把它们逐行原样回给我，一行一个名字，不要解释、不要加前后缀。',
    '严格禁止：创建、修改、删除、重命名任何文件（包括禁止你自己新建一个文件来"配合"这次检查）。',
    '如果你没有可用的文件工具，就只回一句 NO_TOOL，不要伪造列表。'
  ].join('\n');
}

function latest(now) {
  const byMember = new Map();
  for (const r of rows) if (!byMember.has(r.memberId) || r.at > byMember.get(r.memberId).at) byMember.set(r.memberId, r);
  return [...byMember.values()].sort((a, b) => b.at - a.at);
}

/**
 * 路由用的候选池：最后一次体检是绿、且足够新，并且此刻不在限流冷却里。
 * maxAgeHours 是必须的——门会坏（key 过期、上游下线），过绿不等于现在绿。
 */
function greenDoors(now, maxAgeHours, usageMod) {
  const ref = now || Date.now();
  const ageMs = Math.max(1, Number(maxAgeHours) || 24) * 3600 * 1000;
  const u = usageMod || usage;
  return latest(ref)
    .filter(r => r.level === 'green' && ref - r.at <= ageMs)
    .filter(r => {
      try { return !(u.isBlocked(r.memberId, '', ref) || {}).blocked; } catch (e) { return true; }
    })
    .map(r => r.memberId);
}

// 自动体检默认关：每次全机体检都要真实消耗他的额度，这事的控制权归他，不默认替他决定。
function autoEnabled(config) {
  return !!(config && config.health && config.health.auto === true);
}
function everyHours(config) {
  const raw = Number(config && config.health && config.health.everyHours);
  if (!Number.isFinite(raw)) return 24;
  return Math.min(168, Math.max(6, raw)); // 下限 6 小时：不许把全机额度刷成秒表
}

module.exports = { init, record, judge, latest, greenDoors, probePrompt, canaryLinePresent, autoEnabled, everyHours, LAYER_REASON };
