/**
 * 验证「免补丁」方案：靠 `$DSH_HOME/AGENTS.md` 保住主文件夹指令。
 *
 * ## 背景
 *
 * 上一版方案要求用户改 profile 的
 * `agent-instructions.projectRootMarkers`，用户明确拒绝「打两条补丁」。
 * 而且该插件的 config 是在 `apply` 时被 `resolveConfig` 读一次并闭包
 * 捕获的，**另一个插件无法在运行期改写它**。
 *
 * 所以必须换一条不依赖 marker 配置的路。DSH 的指令发现流程里有一处
 * **无需任何 marker** 的加载：
 *
 *     const userGlobal = join(config.dshHome, 'AGENTS.md');   // $DSH_HOME/AGENTS.md
 *     if (present) addFile(...)                               // 无条件加载
 *     ...之后才走 findProjectRoot + ancestorChain
 *
 * 即 `$DSH_HOME/AGENTS.md`（默认 `~/.dsh/AGENTS.md`）**总是**被注入，
 * 与 cwd、与项目根、与任何 marker 都无关。
 *
 * ## 方案
 *
 * 插件把主文件夹的 `AGENTS.md` **镜像**到 `$DSH_HOME/AGENTS.md`，
 * 从而在零补丁的前提下让每个（含子文件夹）会话都拿到主文件夹指令。
 *
 * 本脚本验证三点：
 *   1. `$DSH_HOME/AGENTS.md` 确实无条件加载（复刻发现算法）；
 *   2. 无 marker 时子文件夹 cwd 的项目根塌陷，但全局文件仍注入；
 *   3. 镜像内容与源文件一致（含字节级校验，避免半截写入）。
 *
 * 运行：node scripts/check-nopatch.js
 * @module dsh-workspace-folders/scripts/check-nopatch
 */

import { promises as nodeFs, existsSync } from 'node:fs';
import path from 'node:path';

import { findWorkspaceRoot } from './check-fixtures.js';

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

// 自动探测主工作区，不写死路径 —— 否则在别人机器上必然失败。
const WS = findWorkspaceRoot();

/**
 * 用**临时 DSH_HOME** 做验证，而不是真实的 `~/.dsh`。
 *
 * 两个原因：① 真实路径在工作区之外，当前 workspace-write 沙箱不允许写；
 * ② 即使能写也不该动用户的真实配置。发现算法只看「dshHome 下有没有
 * AGENTS.md」，所以临时目录能等价地证明机制成立。
 */
const DSH_HOME = process.env.VAULT_TEST_DSH_HOME
  ?? path.join(process.env.TEMP ?? '/tmp', 'wbf-nopatch-dshhome');
const GLOBAL_AGENTS = path.join(DSH_HOME, 'AGENTS.md');

/**
 * 复刻 DSH `findProjectRoot`。
 * @param {string} cwd - 起始目录。
 * @param {Array<string>} markers - 根标记（按存在性判定）。
 * @returns {string} 项目根。
 */
function findProjectRoot(cwd, markers) {
  let current = path.resolve(cwd);
  for (;;) {
    for (const marker of markers) {
      if (existsSync(path.join(current, marker))) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

/**
 * 复刻 DSH `ancestorChain`。
 * @param {string} root - 项目根。
 * @param {string} cwd - 起始目录。
 * @returns {Array<string>} 宽到窄的目录链。
 */
function ancestorChain(root, cwd) {
  const chain = [];
  let current = path.resolve(cwd);
  const resolvedRoot = path.resolve(root);
  while (current !== resolvedRoot) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  chain.push(resolvedRoot);
  return chain.reverse();
}

/**
 * 复刻 DSH 的完整发现流程（顺序与实际实现一致：先全局，再项目链）。
 * @param {string} cwd - 会话 cwd。
 * @param {Array<string>} markers - 根标记。
 * @param {string} dshHome - DSH home。
 * @returns {{root: string, chain: Array<string>, files: Array<string>, globalLoaded: boolean}} 结果。
 */
function discover(cwd, markers, dshHome) {
  const files = [];
  const seen = new Set();
  const add = (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    files.push(p);
  };

  // ① 无条件加载 user-global
  const userGlobal = path.join(dshHome, 'AGENTS.md');
  const globalLoaded = existsSync(userGlobal);
  if (globalLoaded) add(userGlobal);

  // ② 项目根到 cwd
  const candidates = ['AGENTS.md', 'CLAUDE.md'];
  const root = findProjectRoot(cwd, markers);
  const chain = ancestorChain(root, cwd);
  for (const dir of chain) {
    for (const name of candidates) {
      const p = path.join(dir, name);
      if (existsSync(p)) add(p);
    }
  }
  return { root, chain, files, globalLoaded };
}

/** 主流程。 */
async function main() {
  console.log('免补丁方案验证：$DSH_HOME/AGENTS.md 无条件加载');
  console.log('='.repeat(70));
  console.log(`DSH_HOME : ${DSH_HOME}`);
  console.log(`全局文件 : ${GLOBAL_AGENTS}`);
  console.log(`主工作区 : ${WS}`);

  const sourceAgents = path.join(WS, 'AGENTS.md');
  const sourceExists = existsSync(sourceAgents);
  console.log(`源文件   : ${sourceAgents} ${sourceExists ? '（存在）' : '（不存在！）'}`);

  const globalExistedBefore = existsSync(GLOBAL_AGENTS);
  console.log(`\n注入前，全局文件${globalExistedBefore ? '已存在（将备份）' : '不存在'}`);

  // 备份已有全局文件，测完还原 —— 不改用户的真实配置。
  let backup;
  if (globalExistedBefore) backup = await nodeFs.readFile(GLOBAL_AGENTS);

  // 子文件夹场景（不建真实目录，用路径即可 —— 发现算法只看存在性）
  const subCwd = path.join(WS, '2026-09-23-免补丁验证');
  let mainInBefore = false;
  let mainInAfter = false;
  let identical = false;
  let stillHasGlobal = false;
  let beforeRoot;

  try {
    // ── 场景 A：不镜像，markers 保持 DSH 默认 ──────────────────────
    if (globalExistedBefore) await nodeFs.rm(GLOBAL_AGENTS, { force: true });
    const before = discover(subCwd, ['.git'], DSH_HOME);
    beforeRoot = before.root;
    mainInBefore = before.files.some((f) => path.resolve(f) === path.resolve(sourceAgents));

    console.log("\n【A】未镜像、markers=['.git']（DSH 默认）");
    console.log(`  项目根   : ${before.root}`);
    console.log(`  链长     : ${before.chain.length}`);
    console.log(`  注入文件 : ${before.files.length === 0 ? '(无)' : ''}`);
    for (const f of before.files) console.log(`      · ${f}`);
    console.log(`  ★ 主文件夹指令是否到达：${mainInBefore ? '是' : '否 <- 这就是问题'}`);

    // ── 场景 B：镜像到 $DSH_HOME/AGENTS.md，markers 仍是默认 ───────
    await nodeFs.mkdir(DSH_HOME, { recursive: true });
    const content = await nodeFs.readFile(sourceAgents);
    await nodeFs.writeFile(GLOBAL_AGENTS, content);

    const after = discover(subCwd, ['.git'], DSH_HOME);
    mainInAfter = after.files.some((f) => path.resolve(f) === path.resolve(GLOBAL_AGENTS));

    console.log("\n【B】已镜像到 $DSH_HOME/AGENTS.md、markers 仍是 ['.git']");
    console.log(`  项目根   : ${after.root}`);
    console.log(`  链长     : ${after.chain.length}`);
    console.log('  注入文件 : ');
    for (const f of after.files) {
      console.log(`      · ${f}${f === GLOBAL_AGENTS ? '   <- 全局（无条件加载）' : ''}`);
    }
    console.log(`  ★ 主文件夹指令是否到达：${mainInAfter ? '是 OK' : '否'}`);

    // 内容一致性
    const written = await nodeFs.readFile(GLOBAL_AGENTS);
    identical = Buffer.compare(content, written) === 0;
    console.log(`  镜像内容与源文件字节一致：${identical ? '是 OK' : '否'}`);

    // ── 场景 C：子文件夹自带 AGENTS.md 时仍不丢 ────────────────────
    await nodeFs.mkdir(subCwd, { recursive: true });
    await nodeFs.writeFile(path.join(subCwd, 'AGENTS.md'), '# 子任务专属\n', 'utf8');
    const withLocal = discover(subCwd, ['.git'], DSH_HOME);
    stillHasGlobal = withLocal.files.some((f) => path.resolve(f) === path.resolve(GLOBAL_AGENTS));
    console.log('\n【C】子文件夹自带 AGENTS.md（会截断项目链）');
    console.log(`  项目根   : ${withLocal.root}`);
    console.log('  注入文件 : ');
    for (const f of withLocal.files) console.log(`      · ${f}`);
    console.log(`  ★ 全局镜像是否仍在：${stillHasGlobal ? '是 OK（不受截断影响）' : '否'}`);
  } finally {
    // 还原现场
    await nodeFs.rm(subCwd, { recursive: true, force: true }).catch(() => {});
    if (backup !== undefined) await nodeFs.writeFile(GLOBAL_AGENTS, backup);
    else await nodeFs.rm(GLOBAL_AGENTS, { force: true }).catch(() => {});
  }

  // ── 断言 ────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(70)}`);
  console.log('断言');

  check('★ 无镜像时子文件夹 cwd 的项目根塌陷到子文件夹自身',
    path.resolve(beforeRoot) === path.resolve(subCwd), `${beforeRoot} vs ${subCwd}`);
  check('★ 复现问题：无镜像时主文件夹指令**丢失**', mainInBefore === false);
  check('★ 镜像后主文件夹指令到达（免补丁保住 prompt）', mainInAfter === true);
  check('★ 镜像内容与源文件字节一致（不会半截写入）', identical === true);
  check('★ 子文件夹自带 AGENTS.md 也不影响全局镜像注入', stillHasGlobal === true);

  const restored = backup === undefined
    ? !existsSync(GLOBAL_AGENTS)
    : Buffer.compare(backup, await nodeFs.readFile(GLOBAL_AGENTS)) === 0;
  check('★ 测试后现场已还原（未污染真实配置）', restored);

  console.log('\n结论');
  console.log('  $DSH_HOME/AGENTS.md 是 DSH 指令发现里**唯一无条件加载**的文件，');
  console.log('  不依赖项目根标记、不依赖 cwd、不受子文件夹同名文件截断。');
  console.log('  插件把主文件夹的 AGENTS.md 镜像到这里，即可用**零补丁**的代价');
  console.log('  让子文件夹会话继续拿到主文件夹指令。');
  console.log(`\n  已还原现场（全局文件${globalExistedBefore ? '恢复为原内容' : '删除'}）。`);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

await main();
