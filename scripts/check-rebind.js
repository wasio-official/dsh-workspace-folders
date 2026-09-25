/**
 * 改绑语义的回归测试（严格单一归属）。
 *
 * ## 覆盖的是一组真实事故
 *
 * 用户在按钮列表里点中了插件自己的源码目录，暴露出三个缺陷：
 *
 *   1. **幽灵记录** —— 改绑只写新文件夹，**不清旧的**。
 *      旧文件夹里留着 `state: "active"` 的记录，插件于是认为同一个会话
 *      同时属于两个文件夹。后果：下次往旧文件夹绑定时，会把
 *      **正在运行的自己**当成「老会话」归类处理。
 *   2. **`boundAt` 复用旧值** —— 写的是 `recorded?.boundAt ?? new Date()`，
 *      改绑时沿用旧时间戳，从数据上分不清哪个是新的。
 *   3. **老注册表没有 `dir` 字段** —— 只清 `recorded.dir` 对历史数据失效，
 *      必须能从 `folder` 回推绝对路径。
 *
 * @module dsh-workspace-folders/scripts/check-rebind
 */

import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FolderBinder } from '../src/binder.js';
import { resolveConfig } from '../src/config.js';
import { readBinding, readRegistry, removeSession } from '../src/naming.js';

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

/** 静默 logger。 */
const logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * 造一个隔离的测试工作区。
 * @returns {Promise<string>} 根目录。
 */
async function makeRoot() {
  const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-rebind-'));
  await nodeFs.mkdir(path.join(root, 'ProjA'), { recursive: true });
  await nodeFs.mkdir(path.join(root, 'ProjB'), { recursive: true });
  return root;
}

/**
 * 造一个 binder。
 * @param {string} root - 工作区根。
 * @returns {object} binder。
 */
function makeBinder(root) {
  const ctx = { logger };
  return new FolderBinder({
    ctx,
    config: resolveConfig({ workspaceRoot: root, inheritOnBind: false }),
    logger,
  });
}

/** 读某文件夹里某会话的记录。 */
async function sessOf(root, folder, sid) {
  const b = await readBinding(path.join(root, folder));
  return (b?.sessions ?? []).find((s) => s.id === sid);
}

console.log('改绑语义：严格单一归属');
console.log('='.repeat(70));

// ── 1. ★ 幽灵记录 ──────────────────────────────────────────────────
console.log('\n【1】改绑不留幽灵记录');
{
  const root = await makeRoot();
  const SID = 'session-solo';
  try {
    const binder = makeBinder(root);
    await binder.bind({ sessionId: SID, title: 'x', create: true, target: 'ProjA' });
    check('★ 初次绑定写进 ProjA', (await sessOf(root, 'ProjA', SID)) !== undefined);

    // 等一下，让新时间戳可与旧值区分。
    await new Promise((r) => setTimeout(r, 15));
    const before = (await sessOf(root, 'ProjA', SID))?.boundAt;

    await binder.bind({ sessionId: SID, title: 'x', create: true, target: 'ProjB' });

    check('★★ 改绑后 ProjB 里有记录', (await sessOf(root, 'ProjB', SID)) !== undefined);
    check('★★ 改绑后 ProjA 里**没有**记录（幽灵记录已消除）',
      (await sessOf(root, 'ProjA', SID)) === undefined,
      JSON.stringify(await readBinding(path.join(root, 'ProjA'))));

    // 无其它会话时应删掉绑定文件，不留空壳。
    const aLeft = await nodeFs.readFile(path.join(root, 'ProjA', '.dsh-session.json'), 'utf8')
      .catch(() => undefined);
    check('★ ProjA 已无归属会话 → 绑定文件被移除（不留空壳）',
      aLeft === undefined, String(aLeft));

    // ── 2. boundAt 必须是新时间戳 ────────────────────────────────
    const after = (await sessOf(root, 'ProjB', SID))?.boundAt;
    check('★★ 改绑盖上**新**时间戳（不是沿用旧值）',
      typeof after === 'string' && after !== before, `${before} → ${after}`);

    // ── 3. 注册表要跟着走 ────────────────────────────────────────
    const reg = await readRegistry(root);
    check('★★ 注册表指向新文件夹', reg.sessions[SID]?.folder === 'ProjB',
      JSON.stringify(reg.sessions[SID]));
    check('★★ 注册表带上 dir（供下次改绑清理）',
      typeof reg.sessions[SID]?.dir === 'string'
        && reg.sessions[SID].dir.includes('ProjB'), String(reg.sessions[SID]?.dir));
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ── 4. ★ 多会话文件夹：只移除自己，别清空别人 ──────────────────────
console.log('\n【4】多会话文件夹只移除自己');
{
  const root = await makeRoot();
  const MINE = 'session-mine';
  const OTHER = 'session-other';
  try {
    const binder = makeBinder(root);
    // OTHER 先在 ProjA 里留下记录（模拟历史会话）。
    const { writeBinding } = await import('../src/naming.js');
    await writeBinding(path.join(root, 'ProjA'), {
      sessions: [{ id: OTHER, state: 'archived', folder: 'ProjA', boundAt: '2020-01-01T00:00:00.000Z' }],
    });

    await binder.bind({ sessionId: MINE, title: 'x', create: true, target: 'ProjA' });
    await binder.bind({ sessionId: MINE, title: 'x', create: true, target: 'ProjB' });

    const a = await readBinding(path.join(root, 'ProjA'));
    check('★★ 自己已移出 ProjA', (a?.sessions ?? []).every((s) => s.id !== MINE),
      JSON.stringify(a?.sessions));
    check('★★ 别人的记录**原样保留**（没被误删）',
      (a?.sessions ?? []).some((s) => s.id === OTHER && s.state === 'archived'),
      JSON.stringify(a?.sessions));
    check('★ ProjA 绑定文件仍在（还有归属会话）',
      (a?.sessions ?? []).length === 1);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ── 5. ★ 老注册表（只有 folder，没有 dir）也要能清理 ───────────────
console.log('\n【5】老注册表格式兼容');
{
  const root = await makeRoot();
  const SID = 'session-legacy';
  try {
    const binder = makeBinder(root);
    await binder.bind({ sessionId: SID, title: 'x', create: true, target: 'ProjA' });

    // 手工把注册表降级成老格式：去掉 dir。
    const { writeRegistry } = await import('../src/naming.js');
    await writeRegistry(root, { sessions: { [SID]: { folder: 'ProjA' } } });

    // 用**新实例**（避开缓存）改绑 —— 必须仍能清掉 ProjA。
    const binder2 = makeBinder(root);
    await binder2.bind({ sessionId: SID, title: 'x', create: true, target: 'ProjB' });

    check('★★ 老格式（无 dir）也能从 folder 回推并清理旧记录',
      (await sessOf(root, 'ProjA', SID)) === undefined,
      JSON.stringify(await readBinding(path.join(root, 'ProjA'))));
    check('★ 新记录在 ProjB', (await sessOf(root, 'ProjB', SID)) !== undefined);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ── 6. 绑到同一处不该误清理 ────────────────────────────────────────
console.log('\n【6】重复绑同一处不误清理');
{
  const root = await makeRoot();
  const SID = 'session-same';
  try {
    const binder = makeBinder(root);
    await binder.bind({ sessionId: SID, title: 'x', create: true, target: 'ProjA' });
    const t1 = (await sessOf(root, 'ProjA', SID))?.boundAt;

    const binder2 = makeBinder(root);
    await binder2.bind({ sessionId: SID, title: 'x', create: true, target: 'ProjA' });

    check('★★ 重复绑同一处，记录仍在（没被自己清掉）',
      (await sessOf(root, 'ProjA', SID)) !== undefined,
      JSON.stringify(await readBinding(path.join(root, 'ProjA'))));
    check('★ boundAt 未被无谓刷新（同目录不算改绑）',
      (await sessOf(root, 'ProjA', SID))?.boundAt === t1);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ── 7. removeSession 是纯函数 ──────────────────────────────────────
console.log('\n【7】removeSession 纯函数语义');
{
  const b = { sessions: [{ id: 'a' }, { id: 'b' }], claimedAt: 'x' };
  const out = removeSession(b, 'a');
  check('★ 移除指定会话', out.sessions.length === 1 && out.sessions[0].id === 'b');
  check('★ 其它字段保留', out.claimedAt === 'x');
  check('★ **不修改入参**（纯函数）', b.sessions.length === 2);
  check('★ 处理 undefined 不抛错', removeSession(undefined, 'a').sessions.length === 0);
  check('★ 移除不存在的 id 是 no-op',
    removeSession({ sessions: [{ id: 'a' }] }, 'zz').sessions.length === 1);
}

// ── 8. ★ 插件自己的目录不出现在可绑定列表里 ────────────────────────
console.log('\n【8】隐藏插件自身目录');
{
  const { listBindableProjects, findPackageRoot } = await import('../src/naming.js');
  const root = await makeRoot();
  try {
    // 造一个「像插件自己」的目录。
    const selfLike = path.join(root, 'dsh-workspace-folders');
    await nodeFs.mkdir(selfLike, { recursive: true });
    await nodeFs.writeFile(path.join(selfLike, 'package.json'), '{}', 'utf8');

    // ★ `findPackageRoot` 找的是**真实**包根（本仓库），必然不在临时目录下 ——
    //   所以这里必须用 `selfDir` 注入口，否则这个机制永远无法被验证。
    const hidden = await listBindableProjects({ parentDir: root, selfDir: selfLike });
    const names = hidden.map((p) => p.name);
    check('★★ 指定 selfDir 时该目录被隐藏',
      !names.includes('dsh-workspace-folders'), names.join(','));
    check('★ 其它目录不受影响', names.includes('ProjA') && names.includes('ProjB'),
      names.join(','));

    // 关掉开关则应出现 —— 证明隐藏是**这个选项**在起作用，而非别的巧合。
    const shown = await listBindableProjects({ parentDir: root, hideSelf: false });
    check('★ hideSelf:false 时列得出来（证明是该选项在起作用）',
      shown.map((p) => p.name).includes('dsh-workspace-folders'),
      shown.map((p) => p.name).join(','));

    check('★ 仍会跳过点开头与下划线开头的目录',
      (await listBindableProjects({ parentDir: root }))
        .every((p) => !p.name.startsWith('.') && !p.name.startsWith('_')),
      names.join(','));

    // 真实推断路径也必须可用（在生产里它是唯一路径）。
    const real = await findPackageRoot();
    check('★★ 真实环境下能推断出包根', typeof real === 'string' && real.length > 0,
      String(real));
    check('★ 推断出的包根里确实有 package.json',
      real !== undefined
        && await nodeFs.access(path.join(real, 'package.json')).then(() => true, () => false));
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

console.log(`\n${'='.repeat(70)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
