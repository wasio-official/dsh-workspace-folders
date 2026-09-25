/**
 * 目录命名：**纯 ASCII** 保证。
 *
 * ## 为什么有这套件
 *
 * 用户看到插件自动建出的目录名后直接问：
 *
 * > 「你能把这个文件夹的名字改为纯英文字符吗？」
 *
 * 当时那个目录叫 `2026-09-25-你是一名-dshdeepseek-harness` ——
 * 中文标题被截断在半个词上，中英混杂，看着像乱码。
 *
 * 根因是 `slugify` **刻意保留 CJK**（`/[\p{L}\p{N}]/u` 放行所有字母），
 * 理由是「中文更可读」。实际后果是终端/git/跨工具脚本里编码经常出问题，
 * 而且与工作区里既有的英文项目目录（`MinerU`、`PhO`）风格不一致。
 *
 * 本套件把「**永远只生成 ASCII 目录名**」钉死，并守住两个副作用：
 *   ① 非 ASCII 被丢弃后**不能生成空名** → 退化为会话 id；
 *   ② slug 过短时（`dsh插件…` → `dsh`）**必须仍可区分** → 补会话 id 前缀。
 *
 * @module dsh-workspace-folders/scripts/check-naming-ascii
 */

import { slugify, baseFolderName, isSafeSegment } from '../src/naming.js';

let passed = 0;
let failed = 0;

/**
 * 断言并记录。
 * @param {string} label - 断言名。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 详情。
 * @returns {void}
 */
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log(`[PASS] ${label}`); }
  else { failed += 1; console.log(`[FAIL] ${label}${detail === undefined ? '' : `  <- ${detail}`}`); }
}

/** 是否纯 ASCII 可打印字符。 */
const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

/** 固定会话 id，便于断言。 */
const SID = 'session-abcdef12-3456-7890-abcd-ef1234567890';
const NOW = new Date('2026-09-25T12:00:00Z');

/**
 * 生成目录名（固定日期与会话）。
 * @param {string} title - 标题。
 * @returns {string} 目录名。
 */
const name = (title) => baseFolderName({ title, sessionId: SID, now: NOW });

console.log('目录命名：纯 ASCII 保证');
console.log('='.repeat(70));

// ── 1. ★★ 真实事故里的那个标题 ─────────────────────────────────────
console.log('\n【1】用户实际遇到的那个标题');
{
  const actual = '你是一名 DSH（DeepSeek Harness）';
  const slug = slugify(actual);
  const folder = name(actual);

  check('★★ slug 不再含 CJK', isAscii(slug) && !/[\u4e00-\u9fff]/.test(slug), slug);
  check('★★ 目录名不含 CJK', !/[\u4e00-\u9fff]/.test(folder), folder);
  check('★ 目录名是纯 ASCII', isAscii(folder), folder);
  check('★ 保留了可读的英文部分', folder.includes('dshdeepseek-harness'), folder);
}

// ── 2. ★★ 全量：各种标题都必须是纯 ASCII ───────────────────────────
console.log('\n【2】各种标题 → 一律纯 ASCII');
{
  const titles = [
    '你是一名 DSH（DeepSeek Harness）',
    'dsh插件对话子文件夹架构方案',
    '纯中文标题没有任何英文',
    'MinerU 项目使用方法',
    '重构认证模块',
    '你好 world 混合 test',
    'Fix the auth bug',
    '修复 bug 并部署',
    '日本語のタイトル',
    '한국어 제목',
    'αβγ ελληνικά',
    'fix 🐛 bug 🚀',
    '',
    '   ',
    '!!!???',
    '---',
    'AB',
    'a',
    '2026-09-25 已经带日期',
    '../escape 试图逃逸',
    'CON',
    'NUL',
  ];

  let allAscii = true;
  let allSafe = true;
  const seen = new Map();

  // ⚠️ 每个标题配**不同的会话 id** —— 这才是真实场景（一个会话一个标题）。
  //    早期这里全用一个固定 id，于是多个「纯中文标题」都退化到
  //    同一个 `2026-09-25-abcdef12`，把「不可区分」误报成缺陷。
  for (const [i, t] of titles.entries()) {
    const sid = `session-${String(i).padStart(2, '0')}abcdef12-3456-7890-abcd-ef1234567890`;
    const f = baseFolderName({ title: t, sessionId: sid, now: NOW });
    if (!isAscii(f)) { allAscii = false; console.log(`       非 ASCII: ${JSON.stringify(t)} → ${f}`); }
    if (!isSafeSegment(f)) { allSafe = false; console.log(`       不安全: ${JSON.stringify(t)} → ${f}`); }
    const again = baseFolderName({ title: t, sessionId: sid, now: NOW });
    if (again !== f) console.log(`       不稳定: ${JSON.stringify(t)}`);
    seen.set(`${t}#${i}`, f);
  }

  check('★★ 全部标题生成的目录名都是纯 ASCII', allAscii);
  check('★★ 全部都是合法的目录名（isSafeSegment）', allSafe);

  // ★ 不同标题不能撞名 —— 这正是「丢弃中文」带来的风险。
  const values = [...seen.values()];
  const unique = new Set(values);
  check('★★ 不同标题生成的名字**互不重复**（丢弃中文后仍可区分）',
    unique.size === values.length,
    values.join(' | '));
}

// ── 3. ★★ 丢弃中文后不能生成空名 ──────────────────────────────────
console.log('\n【3】非 ASCII 被丢弃后不生成空名');
{
  check('★ 纯中文标题 → slug 为空', slugify('纯中文标题') === '');
  const folder = name('纯中文标题');
  check('★★ 但仍生成**非空**目录名（有会话 id 兜底）', folder.length > 0, folder);
  check('★★ 兜底用的是会话 id 短前缀', folder.includes('abcdef12'), folder);
  // ★ 默认**不带**日期前缀（用户要求对齐工作区风格）。
  check('★ 默认不带日期前缀', !/^\d{4}-\d{2}-\d{2}/.test(folder), folder);
  check('★ dated:true 时才带',
    /^\d{4}-\d{2}-\d{2}-/.test(baseFolderName({
      title: '纯中文标题', sessionId: SID, now: NOW, dated: true,
    })));

  // 两个不同的纯中文标题必须能区分开。
  const a = baseFolderName({ title: '重构认证', sessionId: 'session-aaaa1111', now: NOW });
  const b = baseFolderName({ title: '修复登录', sessionId: 'session-bbbb2222', now: NOW });
  check('★★ 两个纯中文标题 + 不同会话 → 名字不同', a !== b, `${a} vs ${b}`);

  // 同一个会话、纯中文标题 → 稳定。
  const c = baseFolderName({ title: '重构认证', sessionId: 'session-aaaa1111', now: NOW });
  check('★ 同会话同标题 → 稳定（幂等）', a === c, `${a} vs ${c}`);
}

// ── 4. ★ 短 slug 补会话前缀 ───────────────────────────────────────
console.log('\n【4】过短的 slug 会补会话前缀');
{
  // `dsh插件对话子文件夹架构方案` 只留下 `dsh`（3 字符）—— 太容易撞名。
  const folder = name('dsh插件对话子文件夹架构方案');
  check('★★ 短 slug 被补上会话前缀', folder.includes('abcdef12'), folder);
  check('★ 仍保留可读部分', folder.includes('dsh'), folder);
  check('★ 纯 ASCII', isAscii(folder), folder);

  // 足够长的 slug 不该被加前缀（保持简洁）。
  const long = name('fix the authentication bug');
  check('★ 足够长的 slug **不**加前缀（保持简洁）',
    !long.includes('abcdef12'), long);
  check('★ 长 slug 名字正确',
    long === 'fix-the-authentication-bug', long);
}

// ── 5. 常规英文标题不受影响 ───────────────────────────────────────
console.log('\n【5】英文标题行为不变（没有回归）');
{
  check('★ Fix Auth Bug', name('Fix Auth Bug') === 'fix-auth-bug',
    name('Fix Auth Bug'));
  check('★ 已带日期的标题保留原样', name('2026-09-25 x') === '2026-09-25-x',
    name('2026-09-25 x'));
  check('★ 剥离路径分隔符', !name('../etc/passwd').includes('/'), name('../etc/passwd'));
  check('★ 剥离反斜杠', !name('..\\..\\windows').includes('\\'), name('..\\..\\windows'));
  check('★ 不含首尾连字符', !/^-|-$/.test(slugify('--hello--')), slugify('--hello--'));
  check('★ 超长被截断', slugify('a'.repeat(200)).length <= 48);
}

// ── 6. ★ prefix（配置项）也必须纯 ASCII ───────────────────────────
console.log('\n【6】配置前缀 folderPrefix 同样纯 ASCII');
{
  const withCn = baseFolderName({
    title: 'fix bug', sessionId: SID, now: NOW, prefix: '工作区',
  });
  check('★★ 中文前缀被丢弃，不污染目录名', isAscii(withCn), withCn);
  check('★ 丢弃后仍保留标题部分', withCn.includes('fix-bug'), withCn);

  const withEn = baseFolderName({
    title: 'fix bug', sessionId: SID, now: NOW, prefix: 'ws',
  });
  check('★ 英文前缀正常拼接', withEn === 'ws-fix-bug', withEn);

  const evil = baseFolderName({
    title: 'x', sessionId: SID, now: NOW, prefix: '../../evil',
  });
  check('★ 恶意前缀不会逃逸', !evil.includes('/') && !evil.includes('..'), evil);
}

console.log(`\n${'='.repeat(70)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
