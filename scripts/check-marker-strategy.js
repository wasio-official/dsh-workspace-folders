/**
 * 选定「项目根标记」的安全方案。
 *
 * 背景（已实测）：把 AGENTS.md 当 marker 有个致命边界 ——
 * 子文件夹若自带 AGENTS.md，`findProjectRoot` 会**停在子文件夹**（就近优先），
 * 主文件夹的 AGENTS.md 随之丢失。用户明确要求主文件夹 prompt 必须保留，
 * 所以不能依赖 AGENTS.md 当 marker。
 *
 * 本脚本对候选方案逐一实测，选出既不破坏继承、又不依赖用户改主文件夹的方案。
 *
 * 运行：node scripts/check-marker-strategy.js
 * @module dsh-session-vault/scripts/check-marker-strategy
 */

import { resolve, dirname, join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ⚠️ 用临时目录，**不要**硬编码某台机器的路径（同上）。
const WS = mkdtempSync(join(tmpdir(), 'wbf-marker-'));
const PROBE = join(WS, '_probe');
const SUB = join(PROBE, 'fix-auth');

/**
 * 复刻 DSH `findProjectRoot`。
 * @param {string} cwd - 起始目录。
 * @param {Array<string>} markers - 根标记。
 * @returns {string} 项目根。
 */
function findProjectRoot(cwd, markers) {
  let current = resolve(cwd);
  for (;;) {
    for (const marker of markers) {
      if (existsSync(join(current, marker))) return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

/**
 * 复刻 DSH `ancestorChain`。
 * @param {string} root - 项目根。
 * @param {string} cwd - 起始目录。
 * @returns {Array<string>} 宽→窄目录链。
 */
function ancestorChain(root, cwd) {
  const chain = [];
  let current = resolve(cwd);
  const resolvedRoot = resolve(root);
  while (current !== resolvedRoot) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  chain.push(resolvedRoot);
  return chain.reverse();
}

/**
 * 跑一次发现。
 * @param {string} cwd - 工作目录。
 * @param {Array<string>} markers - 根标记。
 * @returns {{root: string, chain: Array<string>, files: Array<string>}} 结果。
 */
function discover(cwd, markers) {
  const candidates = ['AGENTS.md', 'CLAUDE.md'];
  const root = findProjectRoot(cwd, markers);
  const chain = ancestorChain(root, cwd);
  const files = [];
  for (const dir of chain) {
    for (const name of candidates) {
      const p = join(dir, name);
      if (existsSync(p)) files.push(p);
    }
  }
  return { root, chain, files };
}

/** 主流程。 */
function main() {
  console.log('选定项目根标记：确保主文件夹 prompt 永不丢失');
  console.log('='.repeat(66));

  mkdirSync(SUB, { recursive: true });
  // 最刁钻的情形：子文件夹自带 AGENTS.md（用户很可能这么用）
  writeFileSync(join(SUB, 'AGENTS.md'), '# 子任务专属指令\n', 'utf8');

  const mainAgents = resolve(join(WS, 'AGENTS.md'));
  const strategies = [
    {
      name: '① markers=[".git"]（DSH 默认）',
      markers: ['.git'],
      note: '子文件夹下 root 塌陷，主文件夹指令全丢',
    },
    {
      name: '② markers=[".git","AGENTS.md"]（我上一版方案）',
      markers: ['.git', 'AGENTS.md'],
      note: '子文件夹自带 AGENTS.md 时被截断',
    },
    {
      name: '③ markers=[".git",".dsh-workspace-root"]（本方案）',
      markers: ['.git', '.dsh-workspace-root'],
      note: '用专用标记；要求主文件夹放一个该标记文件',
    },
    {
      name: '④ markers=[".git","CLAUDE.md"]',
      markers: ['.git', 'CLAUDE.md'],
      note: '同样有被同名文件截断的风险',
    },
  ];

  const results = [];
  for (const strategy of strategies) {
    const result = discover(SUB, strategy.markers);
    const keepsMain = result.files.some((f) => resolve(f) === mainAgents);
    const keepsSub = result.files.some((f) => resolve(f) === resolve(join(SUB, 'AGENTS.md')));
    results.push({ ...strategy, result, keepsMain, keepsSub });
  }

  for (const r of results) {
    console.log(`\n${r.name}`);
    console.log(`  项目根   : ${r.result.root.replace(WS, '.')}`);
    console.log(`  链(${r.result.chain.length})     : ${r.result.chain.map((c) => c.replace(WS, '.')).join(' → ')}`);
    console.log(`  主文件夹 : ${r.keepsMain ? '✅ 保留' : '❌ 丢失'}`);
    console.log(`  子文件夹 : ${r.keepsSub ? '✅ 注入' : '— 无'}`);
    console.log(`  备注     : ${r.note}`);
  }

  // 方案③要求主文件夹放专用标记，这里验证它确实有效。
  writeFileSync(join(WS, '.dsh-workspace-root'), '', 'utf8');
  const fixed = discover(SUB, ['.git', '.dsh-workspace-root']);
  const fixedKeepsMain = fixed.files.some((f) => resolve(f) === mainAgents);
  const fixedKeepsSub = fixed.files.some((f) => resolve(f) === resolve(join(SUB, 'AGENTS.md')));

  console.log(`\n${'='.repeat(66)}`);
  console.log('方案③ 放置专用标记后的实测');
  console.log(`  项目根   : ${fixed.root.replace(WS, '.')}`);
  console.log(`  链(${fixed.chain.length})     : ${fixed.chain.map((c) => c.replace(WS, '.')).join(' → ')}`);
  console.log(`  主文件夹 : ${fixedKeepsMain ? '✅ 保留' : '❌ 丢失'}`);
  console.log(`  子文件夹 : ${fixedKeepsSub ? '✅ 同时注入' : '❌ 未注入'}`);
  console.log(`\n判定：${fixedKeepsMain && fixedKeepsSub ? '方案③ 成立 —— 两层叠加且不受子文件夹同名文件影响' : '方案③ 不成立'}`);

  rmSync(PROBE, { recursive: true, force: true });
  rmSync(join(WS, '.dsh-workspace-root'), { force: true });
  console.log('\n探测残留已清理（含临时标记文件）。');
}

main();
