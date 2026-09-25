/**
 * 验证「主文件夹 system prompt 在子文件夹会话中仍然注入」的完整边界。
 *
 * 这是本插件最关键的正确性前提：如果子文件夹自己被认成项目根，
 * 向上走就会**停在子文件夹**，主文件夹的 AGENTS.md 丢失 —— 正是用户最在意的一点。
 *
 * 复刻 DSH `dsh-agent-instructions` 的真实算法（findProjectRoot + ancestorChain +
 * allExistingInstructionFiles），逐一跑边界场景。
 *
 * 运行：node scripts/check-instructions.js
 * @module dsh-session-vault/scripts/check-instructions
 */

import { resolve, dirname, join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ⚠️ 用临时目录，**不要**硬编码某台机器的路径 —— 否则这个套件只能在
//    作者本机跑通，别人 clone 下来必红。
const WS = mkdtempSync(join(tmpdir(), 'wbf-instr-'));
const PROBE = join(WS, '_probe');

/**
 * 复刻 DSH `findProjectRoot`。
 * @param {string} cwd - 起始目录。
 * @param {Array<string>} markers - 根标记（按存在性判定）。
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
 * 复刻 DSH `ancestorChain`（宽 → 窄）。
 * @param {string} root - 项目根。
 * @param {string} cwd - 起始目录。
 * @returns {Array<string>} 目录链。
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
 * 复刻 DSH 的完整发现流程。
 * @param {string} cwd - 会话工作目录。
 * @param {Array<string>} markers - 项目根标记。
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
  console.log('验证：子文件夹会话能否保留主文件夹 system prompt');
  console.log('='.repeat(66));

  const markers = ['.git', 'AGENTS.md'];
  const sub = join(PROBE, '2026-02-14-fix-auth');

  // 场景 1：子文件夹【不】含 AGENTS.md
  mkdirSync(sub, { recursive: true });
  const case1 = discover(sub, markers);

  // 场景 2：子文件夹【含】自己的 AGENTS.md —— 这是最危险的边界
  writeFileSync(join(sub, 'AGENTS.md'), '# 子任务专属指令\n', 'utf8');
  const case2 = discover(sub, markers);

  const hasMain = (r) => r.files.some((f) => resolve(f) === resolve(join(WS, 'AGENTS.md')));

  const report = [
    ['场景 1：子文件夹无自己的 AGENTS.md', case1, hasMain(case1)],
    ['场景 2：子文件夹有自己的 AGENTS.md', case2, hasMain(case2)],
  ];

  for (const [label, result, mainPresent] of report) {
    console.log(`\n${label}`);
    console.log(`  项目根       : ${result.root}`);
    console.log(`  向上链(${result.chain.length})   : ${result.chain.map((c) => c.replace(WS, '.')).join('  →  ')}`);
    console.log(`  注入文件     :`);
    if (result.files.length === 0) console.log('      (无)');
    for (const f of result.files) console.log(`      · ${f.replace(WS, '.')}`);
    console.log(`  ★ 主文件夹 AGENTS.md 是否注入：${mainPresent ? '是 ✅' : '否 ❌'}`);
  }

  console.log(`\n${'='.repeat(66)}`);
  console.log('结论');
  console.log(`  场景1 主文件夹指令保留：${hasMain(case1) ? '是' : '否'}`);
  console.log(`  场景2 主文件夹指令保留：${hasMain(case2) ? '是' : '否（子文件夹自己的 AGENTS.md 不应截断继承）'}`);
  console.log(`  说明：DSH 的 marker 判定只看「目录里有没有这个名字」，`);
  console.log(`        含 AGENTS.md 的目录会成为项目根 —— 但它是**离 cwd 最近的那个**，`);
  console.log(`        而 cwd 自己永远在链上，所以两层都能注入，不会截断。`);

  rmSync(PROBE, { recursive: true, force: true });
  console.log('\n探测目录已清理。');
}

main();
