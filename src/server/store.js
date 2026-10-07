// 持久化：config.json（配置，原子写）+ messages.jsonl（消息，追加写）
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.configPath = path.join(dataDir, 'config.json');
    this.msgPath = path.join(dataDir, 'messages.jsonl');
    fs.mkdirSync(dataDir, { recursive: true });
  }

  loadConfig(fallback) {
    try {
      return { ...fallback, ...JSON.parse(fs.readFileSync(this.configPath, 'utf8')) };
    } catch (e) {
      return fallback;
    }
  }

  saveConfig(cfg) {
    const tmp = this.configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, this.configPath);
  }

  appendMessage(msg) {
    fs.appendFileSync(this.msgPath, JSON.stringify(msg) + '\n', 'utf8');
  }

  // 启动时回放：任务流中间态折叠为最终态
  loadMessages(limit = 1000) {
    if (!fs.existsSync(this.msgPath)) return [];
    const lines = fs.readFileSync(this.msgPath, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-limit * 3); // 粗略多读，delta 事件很多
    const out = [];
    for (const line of tail) {
      let m;
      try { m = JSON.parse(line); } catch (e) { continue; }
      if (m.type === 'task_delta') {
        // 折叠到对应任务的累计文本
        const t = out.findLast
          ? [...out].reverse().find(x => x.type === 'task' && x.id === m.taskId)
          : null;
        if (t) { t.text = (t.text || '') + m.text; continue; }
      }
      if (m.type === 'task_status') {
        const t = [...out].reverse().find(x => x.type === 'task' && x.id === m.taskId);
        if (t) { t.status = m.status; t.code = m.code; continue; }
      }
      out.push(m);
    }
    // 只保留结构化消息（user/task/system），数量截断
    const msgs = out.filter(m => ['user', 'task', 'system'].includes(m.type));
    return msgs.slice(-limit);
  }
}

module.exports = { Store };
