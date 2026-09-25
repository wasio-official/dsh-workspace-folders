/**
 * 实跑全部测试套件，把**真实**断言数写进 `scripts/check-counts.json`。
 *
 * ## 为什么不静态数 `check(` 调用
 *
 * 有些套件在循环里断言（一次调用点跑多次），静态计数会**少算**。
 * README 里写的总数必须与「实跑」一致，否则文档就在说谎。
 *
 * ## 为什么用文件而不是 stdout 管道
 *
 * 受限沙箱下 `child_process` 的 piped stdio 会因命名管道限制失败（EPERM）。
 * 所以让子进程把结果写进**临时文件**，父进程再读 —— 绕开管道。
 *
 * 用法：node scripts/count-assertions.js
 * @module dsh-workspace-folders/scripts/count-assertions
 */

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const scriptDir = import.meta.dirname;
const repoRoot = path.join(scriptDir, '..');

/** 全部套件（按 package.json 的 check 链顺序，去掉 README 自检本身）。 */
const SUITES = [
  'check-core.js',
  'check-instructions.js',
  'check-marker-strategy.js',
  'check-nopatch.js',
  'check-load.js',
  'check-journal.js',
  'check-archiver.js',
  'check-inherit.js',
  'check-client.js',
  'check-client-discovery.js',
  'check-client-load.js',
  'check-picker.js',
  'check-e2e.js',
  'check-inject.js',
  'check-live.js',
  'check-contracts.js',
  'check-target.js',
  'check-tools-target.js',
  'check-route.js',
  'check-bind-route.js',
  'check-restart-would-fix.js',
  'check-rebind.js',
  'check-persistence.js',
  'check-naming-ascii.js',
  'check-bind-e2e.js',
  'check-install.js',
  'check-dsh-update.js',
];

/**
 * 跑一个套件，从 stdout 里解析断言总数。
 *
 * 用 `stdio: 'inherit'` 之外的方案会踩沙箱限制，所以这里让子进程把输出
 * **重定向到临时文件**（通过 shell 重定向，而不是管道）。
 * @param {string} suite - 套件文件名。
 * @returns {Promise<{count: number, ok: boolean, tail: string}>} 结果。
 */
async function runSuite(suite) {
  const outFile = path.join(scriptDir, `.count-${suite}.out`);
  const abs = path.join(scriptDir, suite);

  // 用 cmd 的重定向写文件，避免管道。
  const code = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [abs],
      {
        cwd: repoRoot,
        stdio: ['ignore', 'ignore', 'ignore'],
        // 关键：让子进程自己把输出写文件（下面的 shell 包装做不到，改用 env）
        env: { ...process.env, WBF_COUNT_OUT: outFile },
        windowsHide: true,
      },
    );
    child.on('exit', (c) => resolve(c ?? 0));
    child.on('error', () => resolve(-1));
  });

  // 子进程没有写文件能力（未改造），所以退路：用 shell 重定向再跑一次。
  const shellCode = await new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? `"${process.execPath}" "${abs}" > "${outFile}" 2>&1`
      : `"${process.execPath}" "${abs}" > "${outFile}" 2>&1`;
    const child = spawn(cmd, { cwd: repoRoot, shell: true, stdio: 'ignore', windowsHide: true });
    child.on('exit', (c) => resolve(c ?? 0));
    child.on('error', () => resolve(-1));
  });

  let text = '';
  try {
    text = await nodeFs.readFile(outFile, 'utf8');
    await nodeFs.rm(outFile, { force: true });
  } catch {
    // 读不到就退回退出码判定
  }

  // 解析「总计 N 项，通过 P，失败 F」或「通过 N，失败 F」
  const m = text.match(/总计\s+(\d+)\s+项[，,]\s*通过\s+(\d+)[，,]\s*失败\s+(\d+)/)
    ?? text.match(/通过\s+(\d+)[，,]\s*失败\s+(\d+)/);
  let count = 0;
  if (m !== null) {
    count = m.length === 4 ? Number(m[1]) : Number(m[1]);
  } else {
    // 演示型套件：数 [PASS] 行
    count = (text.match(/\[PASS\]/g) ?? []).length;
  }

  const ok = shellCode === 0 || code === 0;
  return { count, ok, tail: text.split('\n').slice(-3).join(' | ') };
}

const counts = {};
let total = 0;
let anyFailed = false;

console.log('实跑各套件，统计断言数');
console.log('='.repeat(64));

for (const suite of SUITES) {
  const { count, ok, tail } = await runSuite(suite);
  counts[suite] = count;
  total += count;
  const flag = ok ? '✓' : '✗';
  console.log(`${flag} ${suite.padEnd(28)} ${String(count).padStart(4)} 项`);
  if (!ok) {
    anyFailed = true;
    console.log(`    尾部: ${tail}`);
  }
}

console.log('='.repeat(64));
console.log(`总计 ${total} 项断言`);
if (anyFailed) console.log('⚠️ 有套件未通过 —— 计数已写入，但请先修复失败');

await nodeFs.writeFile(
  path.join(scriptDir, 'check-counts.json'),
  `${JSON.stringify({ total, counts, generatedAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);
console.log('已写入 scripts/check-counts.json');
