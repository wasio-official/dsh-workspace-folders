/**
 * 把仓库里的 `cordis.patch.yml` 的插件段（`- insert:` 起）合并进真实 profile。
 *
 * ## 为什么需要这个脚本
 *
 * 2026-09-25 发现：真实 profile 在 10:08:42 被**还原成了备份**，
 * 插件条目整段消失。原因未查明（可能是 DSH 的 GUI 设置页写回过）。
 * 而当时进程还没重启，插件仍在内存里跑着，所以表面一切正常 ——
 * **直到重启才会暴露**。
 *
 * ## 为什么不用 PowerShell 直接拼
 *
 * `Get-Content` 默认按系统 ANSI（中文 Windows 是 GBK）解码 UTF-8 文件，
 * 读出来就已经是乱码；再 `WriteAllText` 写回，乱码就被**固化**进去了。
 * 本脚本全程显式指定 UTF-8，并做**回读校验**。
 *
 * 用法：
 *   node scripts/apply-profile.js            # 应用
 *   node scripts/apply-profile.js --check    # 只检查是否已一致
 *
 * @module dsh-workspace-folders/scripts/apply-profile
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'cordis.patch.yml');
const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml');

/** 插件段的起始标记。 */
const MARKER = '- insert:';

/**
 * 取出从 `- insert:` 开始的插件段。
 * @param {string} text - 文件全文。
 * @returns {string|undefined} 插件段（不含尾随换行）。
 */
function pluginBlock(text) {
  const i = text.indexOf(MARKER);
  return i < 0 ? undefined : text.slice(i).trimEnd();
}

/** 把 CRLF 归一成 LF，便于比较。 */
const norm = (s) => s.replace(/\r\n/g, '\n');

const checkOnly = process.argv.includes('--check');

const repoRaw = await fs.readFile(SOURCE, 'utf8');
const block = pluginBlock(repoRaw);
if (block === undefined) {
  console.error(`✗ 仓库副本里没有 "${MARKER}" —— 源文件被破坏？`);
  process.exit(1);
}

let profileRaw;
try {
  profileRaw = await fs.readFile(PROFILE, 'utf8');
} catch (error) {
  console.error(`✗ 读不到 profile：${PROFILE}\n  ${error?.message ?? error}`);
  process.exit(1);
}

const existing = pluginBlock(profileRaw);

if (checkOnly) {
  if (existing === undefined) {
    console.error('✗ profile 里没有插件段 —— 重启后插件不会加载。');
    process.exit(1);
  }
  if (norm(existing) !== norm(block)) {
    console.error('✗ profile 里的插件段与仓库副本不一致。');
    process.exit(1);
  }
  console.log('✓ profile 里的插件段与仓库副本一致。');
  process.exit(0);
}

// ── 备份 ──────────────────────────────────────────────────────────
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const backup = `${PROFILE}.backup-apply-${stamp}`;
await fs.writeFile(backup, profileRaw, 'utf8');
console.log(`已备份 → ${path.basename(backup)}`);

// ── 合并：保留 profile 里插件段**之前**的内容，加上仓库的插件段 ──
const head = existing === undefined
  ? profileRaw.trimEnd()
  : profileRaw.slice(0, profileRaw.indexOf(MARKER)).trimEnd();

const merged = `${head}\n\n${block}\n`;
await fs.writeFile(PROFILE, merged, 'utf8');

// ── 回读校验（关键：确认没写坏中文）──────────────────────────────
const back = await fs.readFile(PROFILE, 'utf8');
const backBlock = pluginBlock(back);

if (backBlock === undefined) {
  console.error('✗ 写入后回读不到插件段 —— 写坏了。');
  process.exit(1);
}

// CRLF 归一后逐字比较。
if (norm(backBlock) !== norm(block)) {
  console.error('✗ 写入后回读的内容与源不一致 —— 可能发生了编码转换。');
  process.exit(1);
}

// 中文字面量抽样校验：防止「看起来写进去了，其实是乱码」。
for (const probe of ['主工作区根', '免补丁', '归档', '出界访问策略']) {
  if (!back.includes(probe)) {
    console.error(`✗ 回读内容里找不到「${probe}」—— 中文很可能被转码损坏了。`);
    process.exit(1);
  }
}

const configKeys = (backBlock.match(/^\s{8}\w+:/gm) ?? []).length;
console.log(`✓ 已写入并回读校验通过：${configKeys} 个配置项，中文完好。`);
console.log(`  文件：${PROFILE}`);
