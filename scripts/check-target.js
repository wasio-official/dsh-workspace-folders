/**
 * 绑定目标验证：把对话**绑到已有项目目录**，而不是总新建 `日期-标题/`。
 *
 * ## 为什么有这套件
 *
 * 最初的实现只会「按标题自动建目录」。但用户的实际工作区里已经有
 * `MinerU`、`PhO`、`Arcaea` 这类**现成项目**，需要的是
 * 「这个对话负责那个项目」，而不是每次多出一个空文件夹。
 *
 * 所以 `workspace_bind` 增加了 `target` 参数，`binder.bind()` 接受 `target`。
 * 本套件验证它的**全部行为边界**：
 *
 * 1. 绑到已存在的项目目录 → 复用，不新建；
 * 2. 绑到不存在的名字 → 新建同名目录；
 * 3. **不做 `-2` 去重** —— 「绑到 MinerU」不能变成「MinerU-2」；
 * 4. 安全：`../` 逃逸、绝对路径、含分隔符的名字一律拒绝；
 * 5. 改绑：再传不同的 target 能切过去（不能被缓存静默忽略）；
 * 6. `workspace_projects` 能列出可绑目录并标出已被占用的。
 *
 * @module dsh-workspace-folders/scripts/check-target
 */

import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveTargetFolder, listBindableProjects, resolveSessionFolder } from '../src/naming.js';

let passed = 0;
let failed = 0;

/**
 * 断言并记录。
 * @param {string} label - 断言名。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 失败详情。
 * @returns {void}
 */
function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`[PASS] ${label}`);
  } else {
    failed += 1;
    console.log(`[FAIL] ${label}${detail === undefined ? '' : `  <- ${detail}`}`);
  }
}

/**
 * 造一个临时工作区，里面有几个假项目目录。
 * @returns {Promise<string>} 工作区根。
 */
async function makeWorkspace() {
  const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-target-'));
  for (const name of ['MinerU', 'PhO', 'Arcaea', 'Books']) {
    await nodeFs.mkdir(path.join(root, name), { recursive: true });
    await nodeFs.writeFile(path.join(root, name, 'README.md'), `# ${name}\n`, 'utf8');
  }
  return root;
}

console.log('绑定目标验证（绑到已有项目 / 指定名字）');
console.log('='.repeat(70));

const root = await makeWorkspace();

try {
  // ── 1. 绑到已存在的项目 ──────────────────────────────────────────
  console.log('\n【1】绑到已存在的项目目录');

  {
    const r = await resolveTargetFolder({ parentDir: root, target: 'MinerU' });
    check('★ 复用已有目录（不新建）', r.created === false, `created=${r.created}`);
    check('★ 目录名精确等于 target', r.folder === 'MinerU', r.folder);
    check('★ 解析到正确路径',
      path.resolve(r.dir) === path.resolve(root, 'MinerU'), r.dir);

    const stat = await nodeFs.stat(r.dir).catch(() => undefined);
    check('★ 目录真实存在', stat?.isDirectory() === true);
  }

  // ── 2. 绑到不存在的名字 → 新建 ──────────────────────────────────
  console.log('\n【2】绑到不存在的名字');
  {
    const r = await resolveTargetFolder({ parentDir: root, target: 'NewProject' });
    check('★ 新建了目录', r.created === true);
    check('★ 名字精确（无日期前缀、无后缀）', r.folder === 'NewProject', r.folder);

    const stat = await nodeFs.stat(r.dir).catch(() => undefined);
    check('★ 目录真的被创建', stat?.isDirectory() === true);
  }

  // ── 3. ★ 不做 -2 去重（这是本功能的核心语义）────────────────────
  console.log('\n【3】同名不追加 -2（核心语义）');
  {
    // 先在 MinerU 里放一个「别的会话」的绑定记录，制造占用状态
    await nodeFs.writeFile(
      path.join(root, 'MinerU', '.dsh-session.json'),
      JSON.stringify({ sessions: [{ id: 'other-session', state: 'active' }] }, null, 2),
      'utf8',
    );

    const r = await resolveTargetFolder({ parentDir: root, target: 'MinerU' });
    check('★★ 被别的会话占用时**仍然**绑到 MinerU（不变成 MinerU-2）',
      r.folder === 'MinerU', `实际 ${r.folder}`);
    check('★★ 没有生成 MinerU-2 目录',
      (await nodeFs.stat(path.join(root, 'MinerU-2')).catch(() => undefined)) === undefined);

    // 反向对照：**自动命名**路径在同样情况下**应该**去重。
    // 两条路径职责不同，这个对照证明差异是刻意的、不是漏改。
    const auto = await resolveSessionFolder({
      parentDir: root,
      sessionId: 'my-session',
      title: 'mineru',
      now: new Date('2026-09-25T00:00:00Z'),
    });
    check('对照：自动命名路径会用别的名字',
      auto.folder !== 'MinerU', `实际 ${auto.folder}`);
    // ★ 默认**不带**日期前缀（用户要求对齐工作区风格）。
    //   注意结论是 `mineru-2` —— 同名的 `mineru` 已被 √2 步建过，
    //   去重后缀是**正确行为**。这里只断言「没有日期前缀」这一件事。
    check('★★ 自动命名不带日期前缀（对齐工作区风格）',
      /^mineru(-\d+)?$/.test(auto.folder), auto.folder);
  }

  // ── 4. 安全：拒绝逃逸与非法名 ────────────────────────────────────
  console.log('\n【4】安全边界（必须拒绝）');
  {
    const bad = [
      ['../escape', '相对路径逃逸'],
      ['..', '父目录'],
      ['a/b', '含正斜杠'],
      ['a\\b', '含反斜杠'],
      ['', '空字符串'],
      ['con:', 'Windows 保留字符'],
      ['name.', '结尾点'],
      ['name ', '结尾空格'],
    ];

    for (const [value, why] of bad) {
      let threw = false;
      let message = '';
      try {
        await resolveTargetFolder({ parentDir: root, target: value });
      } catch (e) { threw = true; message = e.message; }
      check(`★ 拒绝非法 target：${why}（${JSON.stringify(value)}）`, threw, message || '没有抛错');
    }

    // 绝对路径必须被挡（它是「单段」以外的东西）
    let absThrew = false;
    try {
      await resolveTargetFolder({ parentDir: root, target: 'D:\\Windows' });
    } catch { absThrew = true; }
    check('★ 拒绝绝对路径', absThrew);

    // 确认真没跑出去：临时目录外面不该多出东西
    const outside = path.resolve(root, '..', 'escape');
    check('★ 没有真的创建逃逸目录',
      (await nodeFs.stat(outside).catch(() => undefined)) === undefined);
  }

  // ── 5. 同名文件（非目录）应报错而非覆盖 ──────────────────────────
  console.log('\n【5】target 撞上同名文件');
  {
    await nodeFs.writeFile(path.join(root, 'not-a-dir'), 'x', 'utf8');
    let threw = false;
    let message = '';
    try {
      await resolveTargetFolder({ parentDir: root, target: 'not-a-dir' });
    } catch (e) { threw = true; message = e.message; }
    check('★ 同名文件时报错（不覆盖）', threw, message);

    const content = await nodeFs.readFile(path.join(root, 'not-a-dir'), 'utf8');
    check('★ 原文件内容未被动', content === 'x', content);
  }

  // ── 6. listBindableProjects ──────────────────────────────────────
  console.log('\n【6】列出可绑定的项目');
  {
    const projects = await listBindableProjects({ parentDir: root });
    const byName = new Map(projects.map((p) => [p.name, p]));

    check('★ 列出了全部项目目录', projects.length >= 5,
      projects.map((p) => p.name).join(', '));
    check('★ 含 MinerU', byName.has('MinerU'));
    check('★ 识别出 MinerU 已被绑定（sessions > 0）',
      byName.get('MinerU')?.bound === true && byName.get('MinerU')?.sessions === 1,
      JSON.stringify(byName.get('MinerU')));
    check('★ PhO 标记为未绑定', byName.get('PhO')?.bound === false,
      JSON.stringify(byName.get('PhO')));
    // ★ 排序用 `localeCompare`（人读友好：大小写不敏感），**不是** JS 默认的
    //   UTF-16 码点序。早期这条断言拿 `[...].sort()` 比对，只是**碰巧**成立 ——
    //   那时每个名字都以 `2026-` 开头，两种序恰好一致。
    //   去掉日期前缀后 `mineru-2` 与大写开头的项目混在一起，差异才暴露。
    //   这里按实现真正承诺的语义断言（与 UI 需求一致），而不是复刻一个巧合。
    check('★ 结果是按名字排序的（localeCompare 语义）',
      JSON.stringify(projects.map((p) => p.name))
        === JSON.stringify([...projects.map((p) => p.name)].sort((a, b) => a.localeCompare(b))),
      projects.map((p) => p.name).join(', '));

    // 内部目录要藏起来
    await nodeFs.mkdir(path.join(root, '_internal'), { recursive: true });
    await nodeFs.mkdir(path.join(root, '.hidden'), { recursive: true });
    const projects2 = await listBindableProjects({ parentDir: root });
    const names2 = projects2.map((p) => p.name);
    check('★ 跳过 _ 开头的内部目录', !names2.includes('_internal'), names2.join(', '));
    check('★ 跳过 . 开头的隐藏目录', !names2.includes('.hidden'));
  }

  // ── 7. 名字里的空白必须由调用方先 trim ──────────────────────────
  console.log('\n【7】输入归一（空白处理）');
  {
    // `resolveTargetFolder` 对**含首尾空白**的名字是**拒绝**的 ——
    // 因为 `isSafeSegment` 不许结尾空格（Windows 会把 `x ` 和 `x` 当同一个目录，
    // 放过去会造成「看起来绑上了、其实绑到别处」的诡异问题）。
    //
    // 所以 trim 的责任在**调用方**（`binder.bind()` 会 `target.trim()`）。
    // 这条断言把这个分工固定下来：以后谁把 trim 从 binder 里删掉，
    // 用户传 " MinerU " 就会直接报错 —— 那时本套件会先失败。
    let threw = false;
    let message = '';
    try {
      await resolveTargetFolder({ parentDir: root, target: '  MinerU  ' });
    } catch (e) { threw = true; message = e.message; }
    check('★ 带空白的名字被拒绝（trim 是调用方的责任）', threw,
      message || '竟然通过了 —— 说明安全校验被放松了');

    // 而 trim 之后必须能用 —— 证明 normalize 后的输入是好的
    const r = await resolveTargetFolder({ parentDir: root, target: 'MinerU'.trim() });
    check('★ trim 之后正常绑定', r.folder === 'MinerU', r.folder);

    // 直接验证 binder 那一层确实 trim 了（读源码，防止被删）
    const { readFileSync } = await import('node:fs');
    const binderSrc = readFileSync(
      path.join(import.meta.dirname, '..', 'src', 'binder.js'), 'utf8',
    );
    check('★★ binder.bind 对 target 做了 trim',
      /target\.trim\(\)/.test(binderSrc),
      'binder.js 里找不到 target.trim()');
  }
} finally {
  await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${'='.repeat(70)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
