/**
 * 绑定持久性的回归测试 —— 「切换对话就会炸」。
 *
 * ## 真实事故
 *
 * 用户报告：**「这个绑定不是恒久的，切换对话就会炸。」**
 *
 * 根因是**权威来源搞错了**。持久记录有两处：
 *
 * | 位置 | 角色 |
 * |---|---|
 * | 工作区根 `.dsh-workspace-folders.json` | 登记表（**缓存**） |
 * | 各子文件夹 `.dsh-session.json` | 绑定文件（**真正的持久记录**） |
 *
 * 但 `bind()` 不带 `target` 时**只看登记表**（`existing: recorded?.folder`）。
 * 登记表少一条 → 直接**另建一个带日期的新文件夹**，把老文件夹丢在一边。
 * 而登记表会在这些情况下「少一条」：进程重启后没有、被还原、被人工删、
 * 或本插件自己此前有过 bug。
 *
 * 修法是加一条**兜底恢复**：登记表查不到就去磁盘上扫
 * （`findSessionFolderOnDisk`），找到后把登记表补回去（自愈）。
 *
 * @module dsh-workspace-folders/scripts/check-persistence
 */

import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FolderBinder } from '../src/binder.js';
import { resolveConfig } from '../src/config.js';
import {
  readRegistry, writeRegistry, writeBinding, readBinding, findSessionFolderOnDisk,
} from '../src/naming.js';

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

/** 静默 logger（记录下来供断言）。 */
function makeLogger() {
  const infos = [];
  return {
    infos, debug() {}, warn() {}, error() {},
    info(m) { infos.push(String(m)); },
  };
}

/**
 * 造 binder。
 * @param {string} root - 根。
 * @param {object} [logger] - 日志器。
 * @returns {object} binder。
 */
function mk(root, logger = makeLogger()) {
  return new FolderBinder({
    ctx: { logger },
    config: resolveConfig({ workspaceRoot: root, inheritOnBind: false }),
    logger,
  });
}

/** 造一个含某会话的文件夹。 */
async function seedFolder(root, folder, sid, boundAt = '2026-01-01T00:00:00.000Z') {
  await nodeFs.mkdir(path.join(root, folder), { recursive: true });
  await writeBinding(path.join(root, folder), {
    sessions: [{ id: sid, state: 'active', folder, boundAt }],
  });
}

console.log('绑定持久性：切换对话 / 重启后是否还记得');
console.log('='.repeat(70));

// ── 1. ★★ 登记表丢失，磁盘上文件夹还在 ─────────────────────────────
console.log('\n【1】登记表丢失（模拟重启后没有 / 被还原）');
{
  const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-persist-'));
  const SID = 'session-persist';
  const FOLDER = '2026-01-01-my-project';
  try {
    await seedFolder(root, FOLDER, SID);
    await writeRegistry(root, { sessions: {} });   // ← 登记表空了

    const binder = mk(root);
    const r = await binder.bind({ sessionId: SID, title: 'my project', create: true });

    check('★★ 复用磁盘上的老文件夹（没有另建新的）', r.folder === FOLDER, r.folder);
    check('★ created=false（不是新建的）', r.created === false, String(r.created));

    const dirs = (await nodeFs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
    check('★★ 磁盘上**没有**多出第二个文件夹', dirs.length === 1, dirs.join(','));

    // 自愈：登记表被补回去了。
    const reg = await readRegistry(root);
    check('★★ 登记表被**自愈**补回（下次不用再扫盘）',
      reg.sessions[SID]?.folder === FOLDER, JSON.stringify(reg.sessions[SID]));
    check('★ boundAt 沿用磁盘上的原值（恢复不是改绑）',
      reg.sessions[SID]?.boundAt === '2026-01-01T00:00:00.000Z',
      String(reg.sessions[SID]?.boundAt));
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ── 2. ★★ 模拟重启：全新 binder 实例 ──────────────────────────────
console.log('\n【2】模拟重启（新进程实例、内存缓存为空）');
{
  const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-persist-'));
  const SID = 'session-restart';
  try {
    const first = mk(root);
    const r1 = await first.bind({ sessionId: SID, title: 'proj', create: true });
    const created = r1.folder;

    // 全新实例 = 新进程（缓存必然为空）。
    const second = mk(root);
    const r2 = await second.bind({ sessionId: SID, title: 'proj', create: true });

    check('★★ 重启后仍绑到同一个文件夹', r2.folder === created, `${created} → ${r2.folder}`);
    check('★ 没有新建第二个', r2.created === false, String(r2.created));

    const dirs = (await nodeFs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
    check('★★ 磁盘上只有一个文件夹', dirs.length === 1, dirs.join(','));
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ── 3. ★★ lookup 与 bind 必须给同一个答案 ─────────────────────────
console.log('\n【3】lookup() 与 bind() 一致性');
{
  const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-persist-'));
  const SID = 'session-consistent';
  const FOLDER = '2026-02-02-consistent';
  try {
    await seedFolder(root, FOLDER, SID);
    await writeRegistry(root, { sessions: {} });

    const binder = mk(root);
    const looked = await binder.lookup(SID);
    const bound = await binder.bind({ sessionId: SID, title: 'x', create: true });

    check('★★ lookup() 与 bind() 指向同一文件夹（同一个会话不能两个答案）',
      looked?.folder === bound.folder, `${looked?.folder} vs ${bound.folder}`);
    check('★ 且都是磁盘上那个', bound.folder === FOLDER, bound.folder);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ── 4. lookup 也会自愈 + 不创建 ────────────────────────────────────
console.log('\n【4】lookup 的自愈与只读语义');
{
  const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-persist-'));
  const SID = 'session-lookup';
  const FOLDER = '2026-03-03-look';
  try {
    await seedFolder(root, FOLDER, SID);
    await writeRegistry(root, { sessions: {} });

    const binder = mk(root);
    const r = await binder.lookup(SID);
    check('★★ lookup 能从磁盘恢复', r?.folder === FOLDER, String(r?.folder));
    check('★ lookup 顺带补回登记表',
      (await readRegistry(root)).sessions[SID]?.folder === FOLDER);

    const binder2 = mk(root);
    check('★ 查不存在的会话返回 undefined（不抛错）',
      (await binder2.lookup('session-nope')) === undefined);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ── 5. ★ 扫描函数本身的边界 ───────────────────────────────────────
console.log('\n【5】findSessionFolderOnDisk 边界');
{
  const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-persist-'));
  try {
    await seedFolder(root, 'ProjA', 'sid-A');
    await seedFolder(root, 'ProjB', 'sid-B');

    check('★ 找到 A', (await findSessionFolderOnDisk({ parentDir: root, sessionId: 'sid-A' })) === 'ProjA');
    check('★ 找到 B', (await findSessionFolderOnDisk({ parentDir: root, sessionId: 'sid-B' })) === 'ProjB');
    check('★ 找不到就 undefined',
      (await findSessionFolderOnDisk({ parentDir: root, sessionId: 'nope' })) === undefined);
    check('★ 空 id 返回 undefined（不误匹配）',
      (await findSessionFolderOnDisk({ parentDir: root, sessionId: '' })) === undefined);
    check('★ 根不存在时不抛错',
      (await findSessionFolderOnDisk({ parentDir: path.join(root, 'zzz'), sessionId: 'x' })) === undefined);

    // 只读：扫描不能改动任何文件。
    const before = await nodeFs.readFile(path.join(root, 'ProjA', '.dsh-session.json'), 'utf8');
    await findSessionFolderOnDisk({ parentDir: root, sessionId: 'sid-A' });
    const after = await nodeFs.readFile(path.join(root, 'ProjA', '.dsh-session.json'), 'utf8');
    check('★★ 扫描是**只读**的（不改文件）', before === after);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ── 6. ★ 显式 target 仍然优先，不被磁盘记录覆盖 ───────────────────
console.log('\n【6】显式 target 优先于磁盘记录');
{
  const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-persist-'));
  const SID = 'session-explicit';
  try {
    await seedFolder(root, 'OldProj', SID);
    await nodeFs.mkdir(path.join(root, 'NewProj'), { recursive: true });
    await writeRegistry(root, { sessions: {} });

    const binder = mk(root);
    const r = await binder.bind({ sessionId: SID, target: 'NewProj' });

    check('★★ 显式 target 生效（用户的明确意图不被旧记录压过）',
      r.folder === 'NewProj', r.folder);
    check('★★ 改绑后旧文件夹已清理（严格单一归属）',
      (await readBinding(path.join(root, 'OldProj'))) === undefined
        || (await readBinding(path.join(root, 'OldProj')))?.sessions?.length === 0,
      JSON.stringify(await readBinding(path.join(root, 'OldProj'))));
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ── 7. ★ 反复切换（真实使用形态）─────────────────────────────────
console.log('\n【7】反复「切换对话」二十轮');
{
  const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-persist-'));
  const SIDS = ['s1', 's2', 's3'];
  try {
    // 三个会话各自绑一次。
    const first = {};
    for (const sid of SIDS) {
      const binder = mk(root);
      first[sid] = (await binder.bind({ sessionId: sid, title: sid, create: true })).folder;
    }

    // 模拟「反复切换」：每次都用**全新实例**（等价于每次都是新进程/新上下文），
    // 并且中途把登记表清空 —— 最恶劣的情况。
    let stable = true;
    for (let round = 0; round < 20; round += 1) {
      await writeRegistry(root, { sessions: {} });
      for (const sid of SIDS) {
        const binder = mk(root);
        const r = await binder.bind({ sessionId: sid, title: sid, create: true });
        if (r.folder !== first[sid]) { stable = false; }
      }
    }
    check('★★ 二十轮反复切换 + 登记表清空，绑定始终不变', stable,
      JSON.stringify(first));

    const dirs = (await nodeFs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
    check('★★ 没有攒出一堆垃圾文件夹', dirs.length === SIDS.length, dirs.join(','));
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

console.log(`\n${'='.repeat(70)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
