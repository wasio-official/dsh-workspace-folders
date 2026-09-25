/**
 * 校验 README 里的事实性声明是否与代码一致。
 *
 * README 会公开发布，**里面的数字和默认值错了就是误导用户**。
 * 这个脚本把 README 的声明逐条对着代码核一遍。
 */

import { promises as nodeFs } from 'node:fs';
import { DEFAULTS } from '../src/config.js';

const readme = await nodeFs.readFile('README.md', 'utf8');
const pkg = JSON.parse(await nodeFs.readFile('package.json', 'utf8'));

let bad = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}${detail ? `  ← ${detail}` : ''}`); bad += 1; }
};

console.log('README 事实校验\n');

// ── 1. 配置默认值 ────────────────────────────────────────────────
console.log('【配置表默认值】');
// 逐个从 DEFAULTS 生成期望值，避免手写表与代码漂移。
const shownInReadme = (key) => {
  const re = new RegExp(`^\\| \\\`${key}\\\` \\| (\\\`[^\\\`]*\\\`|\\S+) \\|`, 'm');
  return readme.match(re)?.[1] ?? undefined;
};
const render = (v) => (typeof v === 'string' ? `\`'${v}'\`` : `\`${String(v)}\``);

for (const [key, actual] of Object.entries(DEFAULTS)) {
  const shown = shownInReadme(key);
  ok(`${key} = ${render(actual)}`, shown === render(actual), `README 写的是 ${shown}`);
}

// 只统计「配置」那一节的表格，避免把工具表/状态表误当配置表。
const configSection = readme.split('## 配置')[1]?.split('\n## ')[0] ?? '';
const configKeys = [...configSection.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]);
const missing = Object.keys(DEFAULTS).filter((k) => !configKeys.includes(k));
const extra = configKeys.filter((k) => !(k in DEFAULTS));
ok('配置表覆盖全部 DEFAULTS 键', missing.length === 0, `漏掉: ${missing.join(', ')}`);
ok('配置表没有多余的键', extra.length === 0, `多余: ${extra.join(', ')}`);

// ── 2. 断言总数（以**实际运行**为准）─────────────────────────────
//
// ⚠️ 不用 `child_process` 抓子进程输出 —— 在受限沙箱下 piped stdio
// 会因命名管道限制失败（EPERM）。
//
// 因此改为两层：
//   ① 从 `scripts/check-counts.json` 读**实跑**结果（由 `npm run count` 生成）；
//   ② 若该文件不存在，退回静态计数（并提示会偏小）。
// 静态计数对「循环里断言」的套件会**少算**，所以只作退路。
console.log('\n【测试断言数】');

const countAssertions = (source) => {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const calls = code.match(/(?<!function\s)\bcheck\(/g) ?? [];
  const defs = code.match(/function check\(/g) ?? [];
  return calls.length - defs.length;
};

const staticCounts = {};
for (const f of (await nodeFs.readdir('scripts')).filter((n) => n.startsWith('check-'))) {
  const source = await nodeFs.readFile(`scripts/${f}`, 'utf8');
  staticCounts[f] = countAssertions(source);
}
const staticTotal = Object.values(staticCounts).reduce((a, b) => a + b, 0);

// 优先读实跑结果
let runtimeTotal;
let runtimeCounts;
let countSource;
try {
  const raw = await nodeFs.readFile('scripts/check-counts.json', 'utf8');
  const parsed = JSON.parse(raw);
  runtimeTotal = parsed.total;
  runtimeCounts = parsed.counts;
  countSource = '实跑';
} catch {
  runtimeTotal = staticTotal;
  countSource = '静态（偏小，建议先跑 npm run count）';
}

const claimed = Number(readme.match(/\*\*(\d+) 项断言\*\*/)?.[1]);
ok(`README 断言总数 ${claimed} 与实际一致（${countSource}）`,
  claimed === runtimeTotal, `实际 ${runtimeTotal}，README 声称 ${claimed}`);

for (const [f, n] of Object.entries(runtimeCounts ?? staticCounts)) {
  const claimedInTable = readme.match(new RegExp(`\\\`${f}\\\` \\| (\\d+) \\|`))?.[1];
  if (claimedInTable !== undefined) {
    ok(`${f} 声称 ${claimedInTable} 项`,
      Number(claimedInTable) >= n, `静态 ${n}，README 声称 ${claimedInTable}`);
  }
}

// ── 3. 工具名 ────────────────────────────────────────────────────
console.log('\n【工具名】');
const toolsSrc = await nodeFs.readFile('src/tools.js', 'utf8');
const toolNames = [...toolsSrc.matchAll(/name: '(workspace_\w+)'/g)].map((m) => m[1]);
for (const name of toolNames) {
  ok(`README 提到 ${name}`, readme.includes(`\`${name}\``));
}

// ── 4. 免补丁声明 ────────────────────────────────────────────────
console.log('\n【关键声明】');
ok('README 未声称需要改 DSH 源码', !/修改\s*DSH\s*源码/.test(readme));
ok('README 提到免补丁', readme.includes('免补丁'));
ok('README 声明 npm 未发布', readme.includes('尚未发布到 npm'));
// ⚠️ 这条断言的语义**变过**：早期它断言 `private === true`，
//    因为那时包只在本地用、防误发。现在要发布到 GitHub 供人 clone，
//    `private: true` 反而会让 `npm publish` 与部分工具拒绝处理。
//    真正要守的不变量是「**别误发到 npm**」，而这由 README 明说
//    + 没有 npm 发布流程来保证，不是靠 `private` 字段。
ok('package.json 可被分享（private 不为 true）', pkg.private !== true);

// ── 5. 无个人路径与占位符 ────────────────────────────────────────
//
// 不写死具体用户名 —— 那本身就是一种个人信息泄漏，而且对别的维护者
// 毫无意义。改为匹配**通用形态**：任何绝对用户目录、以及未替换的占位符。
console.log('\n【隐私】');

/** 需要检查的公开文档。 */
const publicDocs = {
  'README.md': readme,
  ...Object.fromEntries(
    await Promise.all(
      (await nodeFs.readdir('docs')).filter((f) => f.endsWith('.md')).map(async (f) => [
        `docs/${f}`,
        await nodeFs.readFile(`docs/${f}`, 'utf8'),
      ]),
    ),
  ),
};

for (const [name, text] of Object.entries(publicDocs)) {
  // Windows 用户目录（C:\Users\xxx）与 Unix 家目录（/home/xxx、/Users/xxx）
  const homePath = /[A-Z]:\\Users\\[^\\\s]+|\/home\/[^/\s]+|\/Users\/[^/\s]+/.test(text);
  const placeholder = /<your-name>|<YOUR_|CHANGEME|TODO:/.test(text);
  ok(`${name} 无硬编码用户目录`, !homePath);
  ok(`${name} 无未替换的占位符`, !placeholder);
}

console.log(`\n${bad === 0 ? '全部一致 ✓' : `发现 ${bad} 处不一致 ✗`}`);
if (bad > 0) process.exitCode = 1;
