/**
 * 会话继承 —— 对应需求 ④（归档老对话 + 对接 log）与 ⑤（跳转后归档）。
 *
 * ## ④ 与 ⑤ 的分工
 *
 * 新对话绑定子文件夹时，若发现该文件夹里**已有别的会话记录**，
 * 按那个会话的**死活**分流：
 *
 * | 老对话状态 | 走哪条 | 对谁动手 | 要用户确认吗 |
 * |---|---|---|---|
 * | **已停止**（有记录、不在内存） | ④ | **归档那个老对话** | 不要（客观事实） |
 * | **还活着**（在内存里） | ⑤ | **归档自己 + 跳过去** | 要（影响大） |
 *
 * 这两条都**不弹卡片就能判定**，因为「老对话是死是活」是可查询的客观事实。
 * 这与 ③ 形成对比：③ 判「任务做完了」是主观语义，必须用户点按钮。
 *
 * ## 「对接 log」是什么
 *
 * ④ 不只是把老对话归档就完事，还要让新对话**能读到上一段干了什么**。
 * 三件事：
 *
 * 1. **旧 log 归档留存** —— 移到 `log/archive/`，标注「已被继承」，不删
 * 2. **生成交接摘要** —— 复用 `degrade.js` 精简，剔除重复输出与
 *    「上下文枯竭导致的误输出」（这是用户原话里明确要求的）
 * 3. **写进子文件夹的 `AGENTS.md`** —— 新对话开局即可读到 ← 这才是「对接」
 *
 * 第 3 点最关键：否则 log 只是躺在磁盘上，谈不上「继承」。
 *
 * @module dsh-workspace-folders/inherit
 */

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';

import { findSession, otherSessions, readBinding, upsertSession, writeBinding } from './naming.js';
import { LOG_DIR } from './journal.js';
import { renderInheritNote, condenseLog } from './degrade.js';
import { isArchived } from './archiver.js';

/** 归档 log 的子目录（相对 `log/`）。 */
export const ARCHIVE_LOG_DIR = 'archive';

/** 交接说明文件名（人可读）。 */
export const INHERIT_NOTE_FILE = 'INHERITED-FROM.md';

/** 交接摘要要写进去的指令文件名。 */
export const HANDOFF_INSTRUCTION_FILE = 'AGENTS.md';

/** 单个老会话的处置结论。 */
export const DISPOSITIONS = Object.freeze([
  'archived-stopped',
  'yield-to-live',
  'skipped-no-log',
  'skipped-unknown',
  'skipped-already',
]);

/**
 * 判定一个会话当前是死是活。
 *
 * **不自己造租约机制**（上一版 `dsh-session-vault` 那套 pid+bootId 会和 DSH
 * 自己的生命周期打架）。这里只用 DSH 现成的事实：
 *
 * | 结论 | 依据 |
 * |---|---|
 * | `live` | `ctx.sessions.get(id)` 拿得到 |
 * | `stopped` | 拿不到，**但**磁盘上有 `sessions/<id>/` 目录 |
 * | `gone` | 目录也不存在 |
 *
 * @param {object} options - 入参。
 * @param {object} options.ctx - 插件上下文。
 * @param {string} options.sessionId - 会话 id。
 * @param {string} [options.sessionsRoot] - 会话存储根（默认从 ctx 推断）。
 * @returns {Promise<'live'|'stopped'|'gone'|'unknown'>} 状态。
 */
export async function probeSessionState({ ctx, sessionId, sessionsRoot }) {
  // ① 内存里活着？
  try {
    // `sessions` 已在 inject 里声明。
    // ⚠️ 这里若读不到，会走进磁盘判定并把**活着的会话误判成 stopped**，
    //    而 ④ 会据此归档它 —— 所以 inject 声明是安全前提，不要删。
    const live = ctx?.sessions?.get?.(sessionId);
    if (live !== undefined && live !== null) return 'live';
  } catch {
    // get 可能不存在或抛错 —— 继续走磁盘判定，不要因此误判为 gone。
  }

  // ② 磁盘上有记录？（有记录但不在内存 = 已停止）
  if (typeof sessionsRoot !== 'string' || sessionsRoot.length === 0) return 'unknown';
  const dir = path.join(sessionsRoot, sessionId);
  const stat = await nodeFs.stat(dir).catch(() => undefined);
  if (stat?.isDirectory() === true) return 'stopped';
  return 'gone';
}

/**
 * 推断会话存储根目录。
 *
 * DSH 的布局是 `~/.dsh/sessions/<encoded-cwd>/<session-uuid>/`。
 * 这里从 `ctx` 或 `$DSH_HOME` 推断到 `sessions` 这一层。
 * @param {object} options - 入参。
 * @param {object} [options.ctx] - 插件上下文。
 * @param {string} [options.dshHome] - DSH home 覆盖。
 * @returns {string|undefined} 路径或 undefined。
 */
export function resolveSessionsRoot({ ctx, dshHome }) {
  const home = dshHome
    ?? process.env.DSH_HOME
    ?? tryCtxDshHome(ctx);
  if (typeof home !== 'string' || home.length === 0) return undefined;
  return path.join(home, 'sessions');
}

/**
 * 试着从 ctx 里问出 DSH home。
 * @param {object} [ctx] - 插件上下文。
 * @returns {string|undefined} 路径或 undefined。
 */
function tryCtxDshHome(ctx) {
  const candidates = [
    ctx?.dshHome,
    ctx?.config?.dshHome,
    ctx?.paths?.dshHome,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * 列出子文件夹里已有的 log 文件（按名排序）。
 * @param {string} dir - 子文件夹。
 * @returns {Promise<Array<string>>} 绝对路径列表。
 */
export async function listLogFiles(dir) {
  const logDir = path.join(dir, LOG_DIR);
  let entries;
  try {
    entries = await nodeFs.readdir(logDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => path.join(logDir, e.name))
    .sort();
}

/**
 * 找某个会话对应的 log 文件。
 *
 * journal 的命名是 `<NNNN>-<sessionId>.md`，所以按 id 后缀匹配。
 * @param {string} dir - 子文件夹。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<string|undefined>} 绝对路径或 undefined。
 */
export async function findSessionLog(dir, sessionId) {
  const files = await listLogFiles(dir);
  return files.find((file) => path.basename(file).endsWith(`-${safeSegment(sessionId)}.md`));
}

/**
 * 把某个会话的 log 移入 `log/archive/`，并标注「已被继承」。
 *
 * **移动而非删除** —— 这是用户明确的要求（「log 另存为历史」）。
 * 文件名会加上 `inherited-` 前缀，避免与归档目录里已有的重名。
 * @param {object} options - 入参。
 * @param {string} options.dir - 子文件夹。
 * @param {string} options.sessionId - 老会话 id。
 * @param {string} [options.successorId] - 接手的新会话 id（写进标注）。
 * @returns {Promise<{moved: boolean, from?: string, to?: string, reason?: string}>} 结果。
 */
export async function archiveLogFile({ dir, sessionId, successorId }) {
  const source = await findSessionLog(dir, sessionId);
  if (source === undefined) return { moved: false, reason: 'no-log' };

  const archiveDir = path.join(dir, LOG_DIR, ARCHIVE_LOG_DIR);
  await nodeFs.mkdir(archiveDir, { recursive: true });

  const base = path.basename(source);
  const target = path.join(archiveDir, `inherited-${base}`);

  // 先读原文，在头部插入标注，再原子写入目标，最后删源。
  // 顺序是刻意的：**先确保目标写好才删源**，任何一步失败都不会丢 log。
  let text;
  try {
    text = await nodeFs.readFile(source, 'utf8');
  } catch (error) {
    return { moved: false, reason: `read-failed:${String(error?.message ?? error)}` };
  }

  const banner = [
    '<!-- 此 log 已被后续对话继承，移入 archive/ 留存作为历史。 -->',
    `<!-- 原会话：${sessionId} -->`,
    successorId === undefined ? '' : `<!-- 接手会话：${successorId} -->`,
    `<!-- 归档时间：${new Date().toISOString()} -->`,
    '',
  ].filter((line) => line.length > 0 || line === '').join('\n');

  try {
    await writeAtomic(target, `${banner}${text}`);
  } catch (error) {
    return { moved: false, reason: `write-failed:${String(error?.message ?? error)}` };
  }

  // 目标已就绪，可以安全删源。
  await nodeFs.rm(source, { force: true });
  return { moved: true, from: source, to: target };
}

/**
 * 生成交接摘要并写进子文件夹的 `AGENTS.md` —— 这是「对接 log」的实质。
 *
 * 新对话开局会读到这个文件（dsh-agent-instructions 会加载子文件夹里的
 * `AGENTS.md`），因此它**立刻就知道上一段对话做了什么、结论是什么**。
 *
 * @param {object} options - 入参。
 * @param {string} options.dir - 子文件夹。
 * @param {Array<object>} options.entries - 已处置的老会话（含 id/摘要）。
 * @param {string} [options.folderTitle] - 文件夹标题。
 * @returns {Promise<{written: boolean, file: string}>} 结果。
 */
export async function writeHandoffInstruction({ dir, entries, folderTitle }) {
  const target = path.join(dir, HANDOFF_INSTRUCTION_FILE);
  const text = renderInheritNote({ entries, folderTitle });
  await writeAtomic(target, text);
  return { written: true, file: target };
}

/**
 * 生成人可读的交接说明 `log/archive/INHERITED-FROM.md`。
 * @param {object} options - 入参。
 * @param {string} options.dir - 子文件夹。
 * @param {Array<object>} options.entries - 已处置的老会话。
 * @param {string} [options.folderTitle] - 文件夹标题。
 * @returns {Promise<{written: boolean, file: string}>} 结果。
 */
export async function writeInheritNoteFile({ dir, entries, folderTitle }) {
  const archiveDir = path.join(dir, LOG_DIR, ARCHIVE_LOG_DIR);
  await nodeFs.mkdir(archiveDir, { recursive: true });
  const target = path.join(archiveDir, INHERIT_NOTE_FILE);

  const lines = [
    '# 继承记录',
    '',
    folderTitle === undefined ? '' : `工作文件夹：${folderTitle}`,
    `生成时间：${new Date().toISOString()}`,
    '',
    '本文件夹经历过以下对话。它们已被归档，log 留存于本目录。',
    '',
    '| 原会话 | 处置 | log |',
    '|---|---|---|',
  ].filter((line) => line.length > 0);

  for (const entry of entries) {
    const logCell = entry.archivedLog === undefined
      ? '（无）'
      : `\`${path.basename(entry.archivedLog)}\``;
    lines.push(`| \`${entry.id}\` | ${describeDisposition(entry.disposition)} | ${logCell} |`);
  }
  lines.push('');

  await writeAtomic(target, `${lines.join('\n')}\n`);
  return { written: true, file: target };
}

/**
 * 把处置结论翻译成人话。
 * @param {string} disposition - 处置码。
 * @returns {string} 说明。
 */
export function describeDisposition(disposition) {
  switch (disposition) {
    case 'archived-stopped': return '已归档（老对话已停止）';
    case 'yield-to-live': return '让位（老对话仍活跃）';
    case 'skipped-no-log': return '跳过（没有 log，不敢归档）';
    case 'skipped-unknown': return '跳过（状态无法判定）';
    case 'skipped-already': return '跳过（已归档过）';
    default: return disposition;
  }
}

/**
 * ④ 的主流程：处理子文件夹里**已停止**的老对话。
 *
 * 对每个老会话：
 *   1. 找它的 log；**找不到就不动手**（「保留 log」的承诺不能是空的）
 *   2. log 移入 `log/archive/` 并标注
 *   3. 用 degrade 出交接摘要
 *   4. 归档那个老会话
 *   5. 更新绑定记录
 *
 * @param {object} options - 入参。
 * @param {object} options.ctx - 插件上下文。
 * @param {string} options.dir - 子文件夹。
 * @param {string} options.sessionId - 当前（新）会话 id。
 * @param {string} [options.folderTitle] - 文件夹标题。
 * @param {string} [options.sessionsRoot] - 会话存储根。
 * @param {Function} [options.archive] - 归档函数（注入便于测试）。
 * @param {number} [options.maxBullets] - 交接摘要最多保留多少条要点。
 * @returns {Promise<{entries: Array<object>, handoff?: object, note?: object}>} 结果。
 */
export async function inheritStoppedSessions({
  ctx, dir, sessionId, folderTitle, sessionsRoot, archive, maxBullets,
}) {
  const binding = await readBinding(dir);
  const others = otherSessions(binding, sessionId);
  const entries = [];

  for (const other of others) {
    // 已经处置过的跳过（幂等）。
    if (other.state === 'archived' || other.state === 'inherited') {
      entries.push({ id: other.id, disposition: 'skipped-already', archivedLog: other.log });
      continue;
    }

    const state = await probeSessionState({ ctx, sessionId: other.id, sessionsRoot });
    if (state === 'live') {
      // ⑤ 的场景 —— 交给调用方处理，这里只标记。
      entries.push({ id: other.id, disposition: 'yield-to-live' });
      continue;
    }
    if (state === 'unknown') {
      entries.push({ id: other.id, disposition: 'skipped-unknown' });
      continue;
    }

    // ★ 安全检查：没有 log 就**不动手**。否则「保留 log」是句空话。
    const logFile = await findSessionLog(dir, other.id);
    if (logFile === undefined) {
      entries.push({ id: other.id, disposition: 'skipped-no-log' });
      continue;
    }

    // ① log 归档留存
    const moved = await archiveLogFile({ dir, sessionId: other.id, successorId: sessionId });

    // ② 从 log 提炼要点（需求原话：去重复输出、去上下文枯竭误输出）
    let bullets = [];
    let condenseStats;
    const logToRead = moved.moved ? moved.to : logFile;
    try {
      const logText = await nodeFs.readFile(logToRead, 'utf8');
      const condensed = condenseLog(logText, {
        maxBullets: Number.isInteger(maxBullets) ? maxBullets : 24,
      });
      bullets = condensed.bullets;
      condenseStats = {
        droppedRepeats: condensed.droppedRepeats,
        droppedIdle: condensed.droppedIdle,
        droppedRetractions: condensed.droppedRetractions,
      };
    } catch {
      // 读不出 log 不影响归档 —— 摘要为空，但 log 文件本身还在。
      bullets = [];
    }

    // ③ 归档老会话（已停止 → 不弹卡片，客观事实）
    let archivedOk = false;
    if (typeof archive === 'function') {
      const result = await archive({ sessionId: other.id, title: other.title });
      archivedOk = result?.archived === true;
    }

    // ④ 更新绑定记录，把处置结论落盘
    const entry = {
      id: other.id,
      disposition: archivedOk ? 'archived-stopped' : 'skipped-unknown',
      archivedLog: moved.moved ? moved.to : logFile,
      bullets,
      ...(condenseStats === undefined ? {} : { condenseStats }),
    };
    entries.push(entry);

    const current = await readBinding(dir);
    await writeBinding(dir, upsertSession(current, {
      id: other.id,
      state: archivedOk ? 'inherited' : other.state,
      ...(moved.moved ? { log: relativeTo(dir, moved.to) } : {}),
      archivedAt: new Date().toISOString(),
      inheritedFrom: sessionId,
    }));
  }

  // ④ 交接摘要 + 人可读说明（只在真有处置动作时写）
  const acted = entries.filter((e) => e.disposition === 'archived-stopped');
  let handoff;
  let note;
  if (acted.length > 0) {
    handoff = await writeHandoffInstruction({ dir, entries: acted, folderTitle });
    note = await writeInheritNoteFile({ dir, entries, folderTitle });
  }

  return { entries, handoff, note };
}

/**
 * 找子文件夹里**仍然活跃**的老会话（⑤ 的判定）。
 * @param {object} options - 入参。
 * @param {object} options.ctx - 插件上下文。
 * @param {string} options.dir - 子文件夹。
 * @param {string} options.sessionId - 当前会话 id。
 * @param {string} [options.sessionsRoot] - 会话存储根。
 * @returns {Promise<Array<object>>} 活跃的老会话（可能为空）。
 */
export async function findLiveSiblings({ ctx, dir, sessionId, sessionsRoot }) {
  const binding = await readBinding(dir);
  const others = otherSessions(binding, sessionId);
  const live = [];

  for (const other of others) {
    const state = await probeSessionState({ ctx, sessionId: other.id, sessionsRoot });
    if (state === 'live') live.push({ ...other, title: other.title });
  }
  return live;
}

/**
 * 把绝对路径转成相对子文件夹的路径（统一用正斜杠，便于跨平台阅读）。
 * @param {string} dir - 基准目录。
 * @param {string} target - 目标路径。
 * @returns {string} 相对路径。
 */
function relativeTo(dir, target) {
  return path.relative(dir, target).split(path.sep).join('/');
}

/**
 * 原子写文件（临时文件 + rename）。
 * @param {string} target - 目标路径。
 * @param {string} text - 内容。
 * @returns {Promise<void>} 完成后兑现。
 */
async function writeAtomic(target, text) {
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await nodeFs.writeFile(temp, text, 'utf8');
  await nodeFs.rename(temp, target);
}

/**
 * 把会话 id 变成安全文件名片段（与 journal 的命名保持一致）。
 * @param {string} value - 原始值。
 * @returns {string} 安全片段。
 */
function safeSegment(value) {
  return String(value ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
}

export { isArchived, findSession };
