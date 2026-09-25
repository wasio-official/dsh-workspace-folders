/**
 * 真实工具层验证：通过 `ctx.tools` 注册表**真的调用** `workspace_bind({target})`。
 *
 * 前两套件分别测了纯函数（`naming.js`）与 binder 类。
 * 本套件补上最后一环：**从工具注册表取出 handler 并执行** ——
 * 也就是模型在真实会话里走的那条路。
 *
 * @module dsh-workspace-folders/scripts/check-tools-target
 */

import { promises as nodeFs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerFolderTools } from '../src/tools.js';
import { FolderBinder } from '../src/binder.js';
import { Journal } from '../src/journal.js';
import { resolveConfig } from '../src/config.js';

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

console.log('真实工具层：workspace_bind({ target })');
console.log('='.repeat(70));

const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-tools-'));
const dshHome = path.join(root, '_dshhome');
await nodeFs.mkdir(dshHome, { recursive: true });
await nodeFs.writeFile(path.join(root, 'AGENTS.md'), '# 主工作区指令\n工具层测试。\n', 'utf8');
for (const name of ['MinerU', 'PhO']) {
  await nodeFs.mkdir(path.join(root, name), { recursive: true });
}

const config = resolveConfig({
  workspaceRoot: root,
  dshHome,
  mirrorInstructions: true,
  inheritOnBind: false,
  archiveMode: 'off',
});

const ctx = {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};

const binder = new FolderBinder({ ctx, config });
const journal = new Journal({ binder, config, logger: ctx.logger });

// 收集注册的工具
const registered = new Map();
const toolsStub = {
  register(tool) {
    registered.set(tool.name, tool);
    return () => registered.delete(tool.name);
  },
  define: () => ({}),
};

/** 假的 defineTool：原样返回，保留 execute。 */
const defineTool = (spec) => spec;

try {
  registerFolderTools({
    ctx: { ...ctx, tools: toolsStub },
    config,
    binder,
    journal,
    defineTool,
  });

  // `archiveMode: 'off'` 时不注册 workspace_archive —— 所以这里只应有 4 个。
  check('archiveMode=off 时注册了 4 个工具（不含 archive）', registered.size === 4,
    [...registered.keys()].join(', '));
  check('★ archiveMode=off 时确实没有 workspace_archive',
    !registered.has('workspace_archive'));

  const exec = { agent: { session: { id: 'tool-sess-1', cwd: root } } };

  // ── 1. workspace_bind({ target: 'MinerU' }) ───────────────────────
  console.log('\n【1】workspace_bind({ target: "MinerU" })');
  {
    const tool = registered.get('workspace_bind');
    check('workspace_bind 已注册', tool !== undefined);

    const out = await tool.execute({ target: 'MinerU' }, exec);
    console.log(`  返回 folder: ${out.folder}`);
    console.log(`  返回 workingDir: ${out.workingDir}`);

    check('★ 绑到了 MinerU', out.folder === 'MinerU', out.folder);
    check('★ workingDir 指向项目目录',
      path.resolve(out.workingDir) === path.resolve(root, 'MinerU'), out.workingDir);
    check('★ 摘要里提到了路径', out.summary.includes('MinerU'));
    check('★ 没有新建日期前缀目录',
      !(await nodeFs.readdir(root)).some((n) => /^\d{4}-\d{2}-\d{2}-/.test(n)),
      (await nodeFs.readdir(root)).join(', '));

    check('★ 项目目录里写了绑定记录',
      existsSync(path.join(root, 'MinerU', '.dsh-session.json')));
  }

  // ── 2. 第二个会话绑同一个项目 ────────────────────────────────────
  console.log('\n【2】另一个会话也绑 MinerU');
  {
    const tool = registered.get('workspace_bind');
    const exec2 = { agent: { session: { id: 'tool-sess-2', cwd: root } } };
    const out = await tool.execute({ target: 'MinerU' }, exec2);

    check('★★ 仍绑到 MinerU（不是 MinerU-2）', out.folder === 'MinerU', out.folder);
    check('★ 没有 MinerU-2 目录', !existsSync(path.join(root, 'MinerU-2')));

    const binding = JSON.parse(
      await nodeFs.readFile(path.join(root, 'MinerU', '.dsh-session.json'), 'utf8'),
    );
    const ids = binding.sessions.map((s) => s.id).sort();
    check('★ 两个会话都在绑定记录里',
      JSON.stringify(ids) === JSON.stringify(['tool-sess-1', 'tool-sess-2']),
      JSON.stringify(ids));
  }

  // ── 3. workspace_projects ────────────────────────────────────────
  console.log('\n【3】workspace_projects');
  {
    const tool = registered.get('workspace_projects');
    check('workspace_projects 已注册', tool !== undefined);

    const out = await tool.execute({}, exec);
    console.log('  ---- 真实输出 ----');
    for (const line of out.summary.split('\n')) console.log(`  | ${line}`);
    console.log('  ------------------');

    check('★ 列出了 MinerU', out.summary.includes('MinerU'));
    check('★ 列出了 PhO', out.summary.includes('PhO'));
    check('★ 标出 MinerU 已被 2 个对话绑定',
      out.summary.includes('MinerU') && out.summary.includes('2 个对话'), out.summary);
    check('★ count 是数字', typeof out.count === 'number', typeof out.count);
  }

  // ── 4. 不传 target 仍走自动命名 ──────────────────────────────────
  console.log('\n【4】不传 target（自动命名）');
  {
    const tool = registered.get('workspace_bind');
    const exec3 = { agent: { session: { id: 'tool-sess-3', cwd: root } } };
    const out = await tool.execute({ title: 'quick fix' }, exec3);

    // ★ 默认不带日期前缀（用户要求对齐工作区风格）。
    check('★★ 自动命名用标题 slug，无日期前缀', out.folder === 'quick-fix', out.folder);
    check('★ 目录被创建', existsSync(out.workingDir));
  }

  // ── 5. 非法 target 报错但不炸 ────────────────────────────────────
  console.log('\n【5】非法 target');
  {
    const tool = registered.get('workspace_bind');
    const exec4 = { agent: { session: { id: 'tool-sess-4', cwd: root } } };
    let threw = false;
    let message = '';
    try {
      await tool.execute({ target: '../evil' }, exec4);
    } catch (e) { threw = true; message = e.message; }
    check('★★ 拒绝逃逸 target', threw, message);
    check('★ 没有创建逃逸目录', !existsSync(path.resolve(root, '..', 'evil')));
  }

  // ── 6. 工具描述包含关键指引 ──────────────────────────────────────
  console.log('\n【6】工具描述');
  {
    const bind = registered.get('workspace_bind');
    const proj = registered.get('workspace_projects');

    check('★ bind 描述提到 target 用法', /target/.test(bind.description));
    check('★ bind 描述提到可以绑到已有项目',
      /已有项目|项目/.test(bind.description), bind.description.slice(0, 60));
    check('★ bind 描述指向 workspace_projects',
      bind.description.includes('workspace_projects'));
    check('★ projects 描述说明用途',
      /列出/.test(proj.description) && /绑定/.test(proj.description),
      proj.description.slice(0, 80));

    // schema 里确实声明了 target（否则模型传了也会被丢掉）
    check('★★ bind 的 parameters 里有 target',
      bind.parameters?.target !== undefined,
      JSON.stringify(Object.keys(bind.parameters ?? {})));
    check('★ target 是可选的（没写 required: true）',
      bind.parameters?.target?.required !== true);
  }
} finally {
  await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${'='.repeat(70)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
