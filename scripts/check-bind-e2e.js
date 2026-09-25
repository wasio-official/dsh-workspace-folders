/**
 * 端到端：真的调用 `workspace_bind({ target })`，看它是否绑到已有项目。
 *
 * `check-target.js` 测的是 `naming.js` 的纯函数；本套件测的是
 * **从工具入口到磁盘落地**的完整链路 —— 也就是模型真正会走的那条路。
 *
 * 重点验证：
 *   1. `workspace_bind({ target: 'MinerU' })` 在已有 MinerU 目录上生效；
 *   2. 真的在那里写 `.dsh-session.json`；
 *   3. `workspace_bind({ target: 'Brand-New' })` 新建；
 *   4. `workspace_projects` 的输出里能看到它们；
 *   5. **改绑**：同一个会话再传不同 target，必须真的切过去。
 *
 * @module dsh-workspace-folders/scripts/check-bind-e2e
 */

import { promises as nodeFs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FolderBinder } from '../src/binder.js';
import { resolveConfig } from '../src/config.js';
import { readBinding } from '../src/naming.js';

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

console.log('端到端：绑定到已有项目');
console.log('='.repeat(70));

const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-bind-e2e-'));
const dshHome = path.join(root, '_dshhome');
await nodeFs.mkdir(dshHome, { recursive: true });
await nodeFs.writeFile(path.join(root, 'AGENTS.md'), '# 主工作区指令\n端到端测试。\n', 'utf8');

// 造几个「已有项目」，模拟用户真实的工作区
for (const name of ['MinerU', 'PhO']) {
  await nodeFs.mkdir(path.join(root, name), { recursive: true });
  await nodeFs.writeFile(path.join(root, name, 'README.md'), `# ${name}\n`, 'utf8');
}

const config = resolveConfig({
  workspaceRoot: root,
  dshHome,
  mirrorInstructions: true,
  autoBind: true,
  writeInheritedNote: true,
  inheritOnBind: false,     // 本套件只验证绑定，不牵扯 ④⑤
  archiveMode: 'off',
});

/**
 * 造一个最小可用的 ctx（binder 只需要 logger 与几个服务）。
 * @returns {object} 假上下文。
 */
function makeCtx() {
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

try {
  const binder = new FolderBinder({ ctx: makeCtx(), config });

  // ── 1. 绑到已有项目 ──────────────────────────────────────────────
  console.log('\n【1】绑到已有项目 MinerU');
  {
    const r = await binder.bind({ sessionId: 'sess-A', target: 'MinerU' });
    check('★ 绑到了 MinerU', r.folder === 'MinerU', r.folder);
    check('★ 没有新建日期目录', !r.created || r.folder === 'MinerU', `created=${r.created}`);
    check('★ 路径正确', path.resolve(r.dir) === path.resolve(root, 'MinerU'), r.dir);

    const binding = await readBinding(r.dir);
    check('★ 在项目目录里写了绑定记录', binding !== undefined);
    check('★ 绑定记录里有本会话',
      binding?.sessions?.some((s) => s.id === 'sess-A') === true,
      JSON.stringify(binding?.sessions));

    check('★ 项目原有文件没被动',
      existsSync(path.join(root, 'MinerU', 'README.md')));
    check('★ 原 README 内容完好',
      await nodeFs.readFile(path.join(root, 'MinerU', 'README.md'), 'utf8') === '# MinerU\n');
  }

  // ── 2. 绑到不存在的名字 → 新建 ──────────────────────────────────
  console.log('\n【2】绑到不存在的名字 Solid');
  {
    const r = await binder.bind({ sessionId: 'sess-B', target: 'Solid' });
    check('★ 绑到了 Solid', r.folder === 'Solid', r.folder);
    check('★ 目录被创建了', r.created === true, `created=${r.created}`);
    check('★ 目录真的在磁盘上', existsSync(r.dir));

    const binding = await readBinding(r.dir);
    check('★ 绑定记录里有 sess-B',
      binding?.sessions?.some((s) => s.id === 'sess-B') === true);
  }

  // ── 3. 两个会话共用一个项目（这是正常情况，不是冲突）───────────
  console.log('\n【3】第二个会话也绑到 MinerU');
  {
    const r = await binder.bind({ sessionId: 'sess-C', target: 'MinerU' });
    check('★ 仍然绑到 MinerU（不是 MinerU-2）', r.folder === 'MinerU', r.folder);
    check('★ 没有生成 MinerU-2 目录', !existsSync(path.join(root, 'MinerU-2')));

    const binding = await readBinding(r.dir);
    const ids = (binding?.sessions ?? []).map((s) => s.id).sort();
    check('★ 绑定记录里两个会话都在',
      JSON.stringify(ids) === JSON.stringify(['sess-A', 'sess-C']),
      JSON.stringify(ids));
  }

  // ── 4. 幂等 ─────────────────────────────────────────────────────
  console.log('\n【4】幂等');
  {
    const again = await binder.bind({ sessionId: 'sess-A', target: 'MinerU' });
    check('★ 重复绑定返回同一个目录', again.folder === 'MinerU');
    check('★ created 为 false', again.created === false);

    const binding = await readBinding(again.dir);
    const aCount = (binding?.sessions ?? []).filter((s) => s.id === 'sess-A').length;
    check('★ 没有重复写入 sess-A', aCount === 1, `出现 ${aCount} 次`);
  }

  // ── 5. ★ 改绑（缓存不能吞掉新 target）───────────────────────────
  console.log('\n【5】改绑到另一个项目');
  {
    // sess-A 原先在 MinerU，现在改绑到 PhO
    const r = await binder.bind({ sessionId: 'sess-A', target: 'PhO' });
    check('★★ 真的切到了 PhO（缓存没把改绑吞掉）', r.folder === 'PhO', r.folder);

    const pho = await readBinding(path.join(root, 'PhO'));
    check('★★ PhO 的绑定记录里有 sess-A',
      pho?.sessions?.some((s) => s.id === 'sess-A') === true,
      JSON.stringify(pho?.sessions));

    // ★ 改绑必须**清掉** MinerU 里的旧记录（严格单一归属）。
    //   早期只写新文件夹、不清旧的，于是同一个会话同时属于两个文件夹。
    const mineru = await readBinding(path.join(root, 'MinerU'));
    check('★★ MinerU 里已移除 sess-A（改绑不留幽灵记录）',
      mineru?.sessions?.every((s) => s.id !== 'sess-A') === true,
      JSON.stringify(mineru?.sessions));
    check('★ MinerU 里的 sess-C 不受影响',
      mineru?.sessions?.some((s) => s.id === 'sess-C') === true,
      JSON.stringify(mineru?.sessions));
  }

  // ── 6. 自动命名路径仍然可用（不传 target）──────────────────────
  console.log('\n【6】不传 target 时仍是自动命名');
  {
    const r = await binder.bind({ sessionId: 'sess-D', title: 'fix auth' });
    // ★ 默认不带日期前缀（用户要求对齐工作区风格）。
    check('★★ 自动命名用标题 slug，无日期前缀', r.folder === 'fix-auth', r.folder);
    check('★ 目录被创建', r.created === true);
    check('★ 目录真实存在', existsSync(r.dir));
  }

  // ── 7. 非法 target 必须抛错且不留痕 ─────────────────────────────
  console.log('\n【7】非法 target');
  {
    let threw = false;
    let message = '';
    try {
      await binder.bind({ sessionId: 'sess-E', target: '../evil' });
    } catch (e) { threw = true; message = e.message; }
    check('★★ 拒绝逃逸 target', threw, message);
    check('★ 没有创建逃逸目录', !existsSync(path.resolve(root, '..', 'evil')));
  }

  // ── 8. 项目清单 ─────────────────────────────────────────────────
  console.log('\n【8】项目清单');
  {
    const { listBindableProjects } = await import('../src/naming.js');
    const projects = await listBindableProjects({ parentDir: root });
    const byName = new Map(projects.map((p) => [p.name, p]));

    check('★ 列出 MinerU / PhO / 自动命名目录',
      byName.has('MinerU') && byName.has('PhO'));
    // ★ 这里曾经断言 `sessions === 2`，而那**正是幽灵记录本身**：
    //   `sess-A` 在第 5 步已改绑到 PhO，MinerU 里只该剩 `sess-C`。
    //   旧实现改绑时不清旧文件夹，于是 MinerU 仍算着 `sess-A`，
    //   把「同一个会话属于两个文件夹」这个 bug **写成了期望行为**。
    //   改成正确值 1，并由 `check-rebind.js` 单独守住这条语义。
    check('★★ MinerU 只剩 1 个会话（sess-A 已改绑走，不留幽灵记录）',
      byName.get('MinerU')?.sessions === 1, JSON.stringify(byName.get('MinerU')));
    check('★ PhO 显示有 1 个会话（改绑过去的）', byName.get('PhO')?.sessions === 1,
      JSON.stringify(byName.get('PhO')));
  }
} finally {
  await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${'='.repeat(70)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
