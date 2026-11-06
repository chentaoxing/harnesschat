// 产出落点的断言。跑法：node scripts/landing-checks.cjs
//
// 为什么要有这一块：11 扇门里唯一绿的那扇在保守权限档下写不了文件（4 次实测 0 产出），
// 于是整条闭环永远停在"被权限档拦住"。但很多活本来就只要一个回答/一段代码/一份文档——
// 那种活不该因为成员不能写盘就什么都没有。所以：**成员只负责答，控制台负责落**。
//
// 两条纪律，写死在断言里：
//   1. 落点是"它的回答原文"，不是"它写的文件"。所以它绝不能把交付判定染成 produced，
//      也绝不能进交付快照（否则并发的另一单会把我的落点当成它的产出 → 假绿）。
//   2. 落点路径由模型自由生成，等于不可信输入：穿越、绝对路径、非法字符、重名覆盖，全部要有界。
const fs = require('fs');
const os = require('os');
const path = require('path');

const fails = [];
const oks = [];
const check = (name, pass, detail) => { (pass ? oks : fails).push(pass ? name : `${name}${detail ? ' — ' + detail : ''}`); };

const landing = require('../src/server/landing');
const delivery = require('../src/server/delivery');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hc-land-'));

// ---------- 1. 落点目录名：两边必须是同一个常量，且快照要跳过它 ----------
check('落点目录名由 delivery 导出，landing 用同一个（别两处各写一个字面量）',
  typeof delivery.LANDING_DIRNAME === 'string' && delivery.LANDING_DIRNAME === landing.LANDING_DIRNAME,
  JSON.stringify({ d: delivery.LANDING_DIRNAME, l: landing.LANDING_DIRNAME }));

let dir = tmp();
fs.mkdirSync(path.join(dir, landing.LANDING_DIRNAME, 'sometask'), { recursive: true });
fs.writeFileSync(path.join(dir, landing.LANDING_DIRNAME, 'sometask', '回答.md'), 'x');
fs.writeFileSync(path.join(dir, 'real.txt'), 'y');
let snap = delivery.snapshotDir(dir);
check('落点目录里的文件不进交付快照（并发时不能冒充别人的产出）',
  !JSON.stringify(snap.files).includes('回答.md'), JSON.stringify(snap.files.map(f => f.path)));
check('同目录下真正的产出照常计数', snap.files.some(f => f.path === 'real.txt'), JSON.stringify(snap.files.map(f => f.path)));

// ---------- 2. 围栏块提取 ----------
let blocks = landing.extractBlocks('前言\n```python\nprint(1)\n```\n后语');
check('一个围栏块被取出来', blocks.length === 1, JSON.stringify(blocks));
check('块语言被记住', blocks[0] && blocks[0].lang === 'python', JSON.stringify(blocks[0]));
check('块正文逐字保留（不含围栏行）', blocks[0] && blocks[0].code === 'print(1)\n', JSON.stringify(blocks[0] && blocks[0].code));

blocks = landing.extractBlocks('```js app.js\nconst a=1;\n```\n');
check('信息串里的文件名被认出来', blocks[0] && blocks[0].hint === 'app.js', JSON.stringify(blocks[0]));
blocks = landing.extractBlocks('```json filename="package.json"\n{}\n```');
check('filename= 形式也认', blocks[0] && blocks[0].hint === 'package.json', JSON.stringify(blocks[0]));
blocks = landing.extractBlocks('```python title=src/main.py\nx\n```');
check('title= 形式也认，且保留相对子目录', blocks[0] && blocks[0].hint === 'src/main.py', JSON.stringify(blocks[0]));
blocks = landing.extractBlocks('```bash\nls -la\n```');
check('只有语言没有文件名时 hint 为空', blocks[0] && !blocks[0].hint, JSON.stringify(blocks[0]));
blocks = landing.extractBlocks('这是 `inline` 代码，不是块。');
check('行内反引号不算块', blocks.length === 0, JSON.stringify(blocks));
blocks = landing.extractBlocks('~~~txt\nhello\n~~~');
check('波浪线围栏也认', blocks.length === 1 && blocks[0].code === 'hello\n', JSON.stringify(blocks));
blocks = landing.extractBlocks('```js\nlet a=1;\n');
check('模型被截断、围栏没收口：剩下的全当块正文', blocks.length === 1 && blocks[0].code === 'let a=1;\n', JSON.stringify(blocks));
blocks = landing.extractBlocks('  ```js\n  indented\n  ```');
check('最多 3 空格缩进的围栏仍认（列表里的代码块）', blocks.length === 1, JSON.stringify(blocks));
blocks = landing.extractBlocks('````md\n```\ninner\n```\n````');
check('外层四引号包住内层三引号时，按外层收口', blocks.length === 1 && /inner/.test(blocks[0].code) && blocks[0].code.includes('```'), JSON.stringify(blocks));

// ---------- 3. 计划落哪些文件 ----------
let plan = landing.planFiles('就是一个回答，没有代码。');
check('没有围栏块时只落一个回答文件', plan.files.length === 1 && plan.files[0].kind === 'answer', JSON.stringify(plan.files.map(f => f.name)));
check('回答文件名固定', plan.files[0].name === '回答.md', plan.files[0].name);
check('回答文件内容与输出逐字相等', plan.files[0].content === '就是一个回答，没有代码。', JSON.stringify(plan.files[0].content));

plan = landing.planFiles('说明文字\n```python app.py\nprint(1)\n```\n');
check('有块时：回答原文 + 每个块各一个文件', plan.files.length === 2, JSON.stringify(plan.files.map(f => f.name)));
check('块文件用模型给的名字', plan.files.some(f => f.name === 'app.py' && f.kind === 'block'), JSON.stringify(plan.files.map(f => f.name)));
check('块文件内容就是块正文', (plan.files.find(f => f.name === 'app.py') || {}).content === 'print(1)\n', JSON.stringify(plan.files.find(f => f.name === 'app.py')));
check('回答原文仍然完整保留（不因为有块就丢掉上下文）', (plan.files.find(f => f.kind === 'answer') || {}).content === '说明文字\n```python app.py\nprint(1)\n```\n');

plan = landing.planFiles('```\nplain\n```\n```\nplain2\n```');
check('无名块按语言/序号命名且互不覆盖', new Set(plan.files.map(f => f.name)).size === plan.files.length, JSON.stringify(plan.files.map(f => f.name)));
plan = landing.planFiles('```javascript\nx\n```\n```python\ny\n```\n```sql\nz\n```');
check('语言映射到扩展名', plan.files.some(f => /\.js$/.test(f.name)) && plan.files.some(f => /\.py$/.test(f.name)) && plan.files.some(f => /\.sql$/.test(f.name)), JSON.stringify(plan.files.map(f => f.name)));

// ---------- 4. 不可信文件名：穿越 / 绝对路径 / 非法字符 / 重名 ----------
plan = landing.planFiles('```js ../../evil.js\nx\n```');
check('相对穿越被消掉，落到任务目录内', plan.files.some(f => f.kind === 'block') && !plan.files.some(f => f.name.includes('..')), JSON.stringify(plan.files.map(f => f.name)));
plan = landing.planFiles('```js C:\\Windows\\evil.js\nx\n```');
check('Windows 绝对路径不采纳', !plan.files.some(f => /^[A-Za-z]:/.test(f.name)) && !plan.files.some(f => f.name.includes('Windows')), JSON.stringify(plan.files.map(f => f.name)));
plan = landing.planFiles('```js /etc/passwd\nx\n```');
check('POSIX 绝对路径不采纳', !plan.files.some(f => f.name.startsWith('/')), JSON.stringify(plan.files.map(f => f.name)));
plan = landing.planFiles('```js a<b>c|.js\nx\n```');
check('非法字符的文件名回落到安全名', !plan.files.some(f => /[<>|"]/.test(f.name)), JSON.stringify(plan.files.map(f => f.name)));
plan = landing.planFiles('```js same.js\na\n```\n```js same.js\nb\n```');
check('同名块不互相覆盖（第二个带序号）', plan.files.filter(f => f.kind === 'block').length === 2 && new Set(plan.files.map(f => f.name)).size === plan.files.length, JSON.stringify(plan.files.map(f => f.name)));
plan = landing.planFiles('```js CON.js\nx\n```');
check('Windows 保留设备名不采纳', !plan.files.some(f => /^CON\./i.test(f.name)), JSON.stringify(plan.files.map(f => f.name)));
plan = landing.planFiles('```js ' + 'a'.repeat(300) + '.js\nx\n```');
check('超长文件名被截断到可用长度', plan.files.every(f => f.name.length <= 120), JSON.stringify(plan.files.map(f => f.name.length)));

// ---------- 5. 上限：块数与体积都要有界 ----------
let many = '';
for (let i = 0; i < 40; i++) many += '```js f' + i + '.js\nx\n```\n';
plan = landing.planFiles(many);
check('块数触顶时标 truncated', plan.truncated === true, JSON.stringify({ n: plan.files.length, t: plan.truncated }));
check('块文件数不超过上限', plan.files.filter(f => f.kind === 'block').length <= landing.MAX_BLOCKS, JSON.stringify(plan.files.length));
plan = landing.planFiles('```js big.js\n' + 'x'.repeat(3 * 1024 * 1024) + '\n```');
check('单块超过体积上限时截断并标记', plan.truncated === true && plan.files.every(f => Buffer.byteLength(f.content, 'utf8') <= landing.MAX_FILE_BYTES), JSON.stringify({ t: plan.truncated, sizes: plan.files.map(f => Buffer.byteLength(f.content, 'utf8')) }));

// ---------- 6. 真的写盘 ----------
dir = tmp();
let w = landing.write({ dir, taskId: 'abc123', text: '答案正文\n```python calc.py\nprint(2)\n```\n', now: Date.now() });
check('write 返回 ok', w && w.ok === true, JSON.stringify(w));
check('落点写在约定的任务目录里', typeof w.dir === 'string' && w.dir.includes(landing.LANDING_DIRNAME) && w.dir.includes('abc123'), w && w.dir);
check('回答文件真的在盘上', fs.existsSync(path.join(w.dir, '回答.md')), JSON.stringify(w.files));
check('回答文件内容逐字相等', fs.readFileSync(path.join(w.dir, '回答.md'), 'utf8') === '答案正文\n```python calc.py\nprint(2)\n```\n');
check('代码块也落成独立文件', fs.existsSync(path.join(w.dir, 'calc.py')) && fs.readFileSync(path.join(w.dir, 'calc.py'), 'utf8') === 'print(2)\n');
check('返回条目带绝对路径与大小（界面要能直接打开）', w.files.every(f => path.isAbsolute(f.abs) && typeof f.size === 'number' && f.size > 0), JSON.stringify(w.files));
check('返回的相对路径不含落点根（卡片显示要短）', w.files.every(f => !f.name.includes(landing.LANDING_DIRNAME)), JSON.stringify(w.files.map(f => f.name)));

// 同一单重跑不覆盖上一次
const firstAnswer = path.join(w.dir, '回答.md');
fs.writeFileSync(firstAnswer, '上一次的东西', 'utf8');
const w2 = landing.write({ dir, taskId: 'abc123', text: '第二次', now: Date.now() });
check('同一 taskId 再落一次不覆盖已有文件', fs.readFileSync(firstAnswer, 'utf8') === '上一次的东西' && w2.ok === true, JSON.stringify(w2.files.map(f => f.name)));
check('第二次落到不重名的新文件', w2.files.some(f => fs.existsSync(f.abs) && fs.readFileSync(f.abs, 'utf8') === '第二次'), JSON.stringify(w2.files.map(f => f.name)));

// 带子目录的块名
dir = tmp();
w = landing.write({ dir, taskId: 't2', text: '```js src/util/helper.js\nx\n```', now: Date.now() });
check('块名里的子目录被真的建出来', fs.existsSync(path.join(w.dir, 'src', 'util', 'helper.js')), JSON.stringify(w.files.map(f => f.name)));

// 穿越在写盘这一层也必须挡住（plan 之外再来一道）
dir = tmp();
w = landing.write({ dir, taskId: 't3', text: '```js ../逃逸.js\nx\n```', now: Date.now() });
check('写盘层兜底：任何落点文件都在任务目录内', w.files.every(f => path.resolve(f.abs).startsWith(path.resolve(w.dir) + path.sep)), JSON.stringify(w.files.map(f => f.abs)));
check('任务目录外没有多出文件', fs.readdirSync(dir).filter(n => n !== landing.LANDING_DIRNAME).length === 0, JSON.stringify(fs.readdirSync(dir)));

// 写不进去要如实报错，不能装作落了
dir = tmp();
fs.writeFileSync(path.join(dir, landing.LANDING_DIRNAME), '我是个文件不是目录');
w = landing.write({ dir, taskId: 't4', text: 'x', now: Date.now() });
check('落点根被占用时返回 ok=false 并带原因', w.ok === false && typeof w.error === 'string' && w.error.length > 0, JSON.stringify(w));

// ---------- 7. 什么时候该落：只在成员自己没产出时兜底 ----------
const base = { status: 'done', changed: 0, grew: false, text: '一个回答', quiet: false, taskKind: 'execute' };
check('成员没动盘 + 有回答 → 落', landing.shouldLand(base) === true);
check('成员自己产出了文件 → 不落（别把它的产出旁边再堆一份回答）', landing.shouldLand({ ...base, changed: 2 }) === false);
check('git 侧涨了 → 也算它自己产出了', landing.shouldLand({ ...base, grew: true }) === false);
check('没跑成 → 不落（报错原文不该被当成交付物）', landing.shouldLand({ ...base, status: 'error' }) === false);
check('超时 → 不落', landing.shouldLand({ ...base, status: 'timeout' }) === false);
check('空回答 → 不落', landing.shouldLand({ ...base, text: '   \n  ' }) === false);
check('体检探针 → 不落（否则每天 11 份垃圾）', landing.shouldLand({ ...base, taskKind: 'health' }) === false);
check('静默任务 → 不落', landing.shouldLand({ ...base, quiet: true }) === false);
check('被权限档拦住的拒绝话术也照落（它确实是这一单的回答），但判定不许改成 produced', landing.shouldLand({ ...base, text: '需要您授权才能创建该文件。' }) === true);

// ---------- 8. 打开守卫：只允许落点目录内的路径 ----------
const good = path.join(tmp(), landing.LANDING_DIRNAME, 'tid', '回答.md');
check('落点目录内的绝对路径可打开', landing.isOpenable(good) === true, good);
check('相对路径不可打开', landing.isOpenable('_落点/tid/回答.md') === false);
check('落点目录外的路径不可打开', landing.isOpenable(path.join(os.homedir(), '.ssh', 'id_rsa')) === false);
check('带 .. 的路径不可打开', landing.isOpenable(tmp() + path.sep + landing.LANDING_DIRNAME + path.sep + '..' + path.sep + 'evil.txt') === false);
check('空值不炸', landing.isOpenable('') === false && landing.isOpenable(null) === false);

// ---------- 9. 落点结论要说人话，且不许冒充成员的产出 ----------
dir = tmp();
w = landing.write({ dir, taskId: 't5', text: '一份方案正文', now: Date.now() });
const note = landing.describe(w);
check('落点说明里点明这是回答原文、不是成员写的文件', /回答/.test(note) && /不是/.test(note), note);
check('落点说明不宣称成员干了活', !/成员.*(创建|写好|已完成)/.test(note), note);

// ---------- 10. 打开 IPC 的守卫：产品与验收脚本共用同一份 ----------
const ipc = require('../src/landing-ipc');
dir = tmp();
const okDir = path.join(dir, landing.LANDING_DIRNAME, 'tid');
fs.mkdirSync(okDir, { recursive: true });
const okFile = path.join(okDir, '回答.md');
fs.writeFileSync(okFile, 'x', 'utf8');
check('落点内已存在的文件放行', ipc.landingTarget(okFile).path === okFile, JSON.stringify(ipc.landingTarget(okFile)));
check('落点外的文件拒掉并给人话', /只允许/.test(ipc.landingTarget(path.join(dir, '别处.md')).error || ''), JSON.stringify(ipc.landingTarget(path.join(dir, '别处.md'))));
check('落点内但已被删掉的文件：如实说"不在了"', /不在/.test(ipc.landingTarget(path.join(okDir, '没了.md')).error || ''), JSON.stringify(ipc.landingTarget(path.join(okDir, '没了.md'))));
check('非字符串输入不炸', !!ipc.landingTarget(null).error && !!ipc.landingTarget({}).error);

console.log(`\n产出落点断言：${oks.length} 通过 / ${fails.length} 失败`);
for (const f of fails) console.log('  FAIL ' + f);
if (fails.length) { console.log('LANDING_CHECKS_FAILED'); process.exit(1); }
console.log('ALL_LANDING_CHECKS_OK');
process.exit(0);