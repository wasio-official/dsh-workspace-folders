/**
 * 端到端验证：子文件夹会话是否真的保住了主文件夹的 system prompt。
 *
 * 这是本插件**存在的理由**，所以要在**真实文件系统**上跑一遍，
 * 而不是只做纯函数推演。验证方式：
 *
 *   1. 用真实的 `FolderBinder.mirrorInstructions()` 把主文件夹指令同步出去；
 *   2. 复刻 DSH `dsh-agent-instructions` 的发现顺序，算出实际注入清单；
 *   3. 断言主文件夹指令**确实在清单里**。
 *
 * ⚠️ 关键点：全程使用 DSH **默认**的 markers `['.git']` ——
 * 用来证明本方案**不需要改 profile 配置**（免补丁）。
 *
 * 本脚本用**隔离的临时 DSH_HOME**，绝不碰用户真实的 `~/.dsh`。
 *
 * 运行：node scripts/check-e2e.js
 * @module dsh-workspace-folders/scripts/check-e2e
 */

import { promises as nodeFs, existsSync } from 'node:fs';
import path from 'node:path';

import { FolderBinder } from '../src/binder.js';
import { resolveConfig } from '../src/config.js';
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
 * 复刻 DSH `findProjectRoot`。
 * @param {string} cwd - 起始目录。
 * @param {Array<string>} markers - 根标记。
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
 * 复刻 DSH 的指令发现顺序：**先无条件加载全局，再走项目链**。
 * @param {string} cwd - 会话 cwd。
 * @param {Array<string>} markers - 根标记。
 * @param {string} dshHome - DSH home。
 * @returns {{root: string, chain: Array<string>, files: Array<string>}} 结果。
 */
function discoverInstructions(cwd, markers, dshHome) {
  const files = [];
  const seen = new Set();
  const add = (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    files.push(p);
  };

  // ① 无条件加载 $DSH_HOME/AGENTS.md
  const userGlobal = path.join(dshHome, 'AGENTS.md');
  if (existsSync(userGlobal)) add(userGlobal);

  // ② 项目链
  const candidates = ['AGENTS.md', 'CLAUDE.md'];
  const root = findProjectRoot(cwd, markers);
  const chain = ancestorChain(root, cwd);
  for (const dir of chain) {
    for (const name of candidates) {
      const p = path.join(dir, name);
      if (existsSync(p)) add(p);
    }
  }
  return { root, chain, files };
}

/**
 * 判断某来源文件是否「到达」了注入清单（通过清单里的任一文件内容匹配）。
 * 因为实际注入的是 `$DSH_HOME/AGENTS.md` 这个**镜像**，
 * 所以要比对内容而非路径。
 * @param {Array<string>} files - 注入清单。
 * @param {string} sourcePath - 源文件路径。
 * @returns {Promise<boolean>} 是否到达。
 */
async function contentReached(files, sourcePath) {
  const source = await nodeFs.readFile(sourcePath).catch(() => undefined);
  if (source === undefined) return false;
  for (const f of files) {
    const content = await nodeFs.readFile(f).catch(() => undefined);
    if (content !== undefined && Buffer.compare(source, content) === 0) return true;
  }
  return false;
}

/** 主流程。 */
async function main() {
  console.log('端到端验证：子文件夹会话是否保住主文件夹 system prompt');
  console.log('='.repeat(72));

  // 隔离的 DSH home（真实 ~/.dsh 在工作区外，且不该被测线碰）。
  const dshHome = await nodeFs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'wbf-e2e-home-'));
  const sourceAgents = path.join(WS, 'AGENTS.md');

  const binder = new FolderBinder({
    ctx: {},
    logger: {},
    // ⚠️ 用 resolveConfig 而不是手写对象 —— 手写会漏掉新增的配置项，
    // 让 e2e 在「配置没接线」时仍然通过（曾经就这样漏掉了 inheritOnBind）。
    config: resolveConfig({
      workspaceRoot: WS,
      mirrorInstructions: true,
      overwriteGlobalInstructions: false,
      dshHome,
      writeInheritedNote: true,
      autoBind: true,
      outsideAccess: 'ask',
      allowInsideWithoutAsk: true,
      folderPrefix: '',
      maxToolResultBytes: 8000,
      // 本测试只验「指令继承」，不碰任何历史会话。
      inheritOnBind: false,
    }),
  });

  // ① 同步指令
  const root = await binder.resolveWorkspaceRoot();
  const inheritance = await binder.instructionInheritance();
  const mirrorTarget = path.join(dshHome, 'AGENTS.md');
  console.log(`\n① 主工作区根：${root}`);
  console.log(`   隔离 DSH_HOME：${dshHome}`);
  console.log(`   同步结果：${inheritance.inherits ? '成功' : '失败'}`);
  console.log(`   落点：${inheritance.target || '(无)'}`);

  check('★ 主文件夹指令已镜像到隔离的 $DSH_HOME', inheritance.inherits === true,
    JSON.stringify(inheritance));
  check('镜像落点就是 $DSH_HOME/AGENTS.md',
    path.resolve(inheritance.target ?? '') === path.resolve(mirrorTarget), inheritance.target);
  // 内容必须与主文件夹的 AGENTS.md 逐字节一致（这才是「继承到了」的实证）。
  {
    const source = await nodeFs.readFile(sourceAgents).catch(() => undefined);
    const written = await nodeFs.readFile(mirrorTarget).catch(() => undefined);
    check('★ 镜像内容与主文件夹 AGENTS.md 字节一致',
      source !== undefined && written !== undefined && Buffer.compare(source, written) === 0);
  }

  // ② 建一个真实子文件夹并写 log（模拟会话工作目录）
  const folderName = '2026-09-24-端到端验证';
  const subDir = path.join(WS, folderName);
  await nodeFs.mkdir(path.join(subDir, 'log'), { recursive: true });
  console.log(`\n② 子文件夹：${subDir}`);

  // ③ 用 DSH 默认 markers 发现 —— 证明无需改 profile
  console.log('\n③ 用 DSH **默认** markers=[".git"] 发现（证明无需改 profile）');

  let caseA;
  let caseB;
  try {
    // 【情形 A】普通子文件夹
    caseA = discoverInstructions(subDir, ['.git'], dshHome);
    const reachedA = await contentReached(caseA.files, sourceAgents);
    console.log('\n【情形 A】普通子文件夹');
    console.log(`   cwd      : ${subDir}`);
    console.log(`   项目根   : ${caseA.root}`);
    console.log(`   链长     : ${caseA.chain.length}`);
    console.log('   注入清单 :');
    for (const f of caseA.files) {
      console.log(`      · ${f === path.join(dshHome, 'AGENTS.md') ? '<DSH_HOME>\\AGENTS.md   <- 全局镜像（无条件加载）' : f}`);
    }
    console.log(`   ★ 主文件夹指令到达：${reachedA ? '是 OK' : '否'}`);

    // 【情形 B】子文件夹自带 AGENTS.md（会截断项目链）
    await nodeFs.writeFile(path.join(subDir, 'AGENTS.md'), '# 子任务专属指令\n', 'utf8');
    caseB = discoverInstructions(subDir, ['.git'], dshHome);
    const reachedB = await contentReached(caseB.files, sourceAgents);
    console.log('\n【情形 B】子文件夹自带 AGENTS.md（会截断项目链）');
    console.log(`   cwd      : ${subDir}`);
    console.log(`   项目根   : ${caseB.root}`);
    console.log(`   链长     : ${caseB.chain.length}`);
    console.log('   注入清单 :');
    for (const f of caseB.files) {
      console.log(`      · ${f === path.join(dshHome, 'AGENTS.md') ? '<DSH_HOME>\\AGENTS.md   <- 全局镜像（无条件加载）' : f}`);
    }
    console.log(`   ★ 主文件夹指令到达：${reachedB ? '是 OK' : '否'}`);

    console.log(`\n${'='.repeat(72)}`);
    console.log('断言');
    check('★ 情形 A（普通子文件夹）：主文件夹指令保留', reachedA === true);
    check('★ 情形 B（子文件夹自带 AGENTS.md）：主文件夹指令保留', reachedB === true);
    check('★ 情形 B 的项目根确实塌陷到了子文件夹（复现了原始问题）',
      path.resolve(caseB.root) === path.resolve(subDir), caseB.root);
    check('全程使用 DSH 默认 markers（未依赖 profile 补丁）', true);
  } finally {
    // 清理验证残留
    await nodeFs.rm(subDir, { recursive: true, force: true }).catch(() => {});
    await nodeFs.rm(dshHome, { recursive: true, force: true }).catch(() => {});
    console.log('\n  已清理验证残留。');
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

await main();
