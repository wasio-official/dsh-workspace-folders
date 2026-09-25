/**
 * 主文件夹 system prompt 的保障 —— **零补丁**方案。
 *
 * ## 问题
 *
 * DSH 的 `dsh-agent-instructions` 按这个顺序找指令：
 *
 * ```js
 * // ① 无条件加载 user-global
 * const userGlobal = join(config.dshHome, 'AGENTS.md');   // $DSH_HOME/AGENTS.md
 * if (present) addFile(userGlobal);
 *
 * // ② 再按「项目根 → cwd」的链加载
 * const projectRoot = findProjectRoot(cwd, config.projectRootMarkers); // 默认 ['.git']
 * for (const dir of ancestorChain(projectRoot, cwd)) addFile(...);
 * ```
 *
 * `findProjectRoot` 是**就近优先**：从 cwd 向上，遇到第一个含 marker 的目录即停；
 * 一路找不到就**塌陷成 cwd 自己**（链只剩 1 层）。
 *
 * 于是把会话 cwd 挪进子文件夹后：
 *
 * | markers | 项目根 | 链长 | 主文件夹指令 |
 * |---|---|---|---|
 * | `['.git']`（默认） | 子文件夹 | 1 | ❌ 丢失（Workspace 没有 .git） |
 * | `['.git','AGENTS.md']` | 子文件夹 | 1 | ❌ 丢失（子文件夹自带 AGENTS.md 时截断） |
 * | `['.git','CLAUDE.md']` | Workspace | 3 | ✅ |
 *
 * 前两行都被 `scripts/check-*` 实测确认。
 *
 * ## 为什么不用 marker 方案
 *
 * marker 方案要求用户改 profile 里 `agent-instructions` 的
 * `projectRootMarkers` —— 那是一条**额外补丁**。而且该插件的 config 在
 * `apply` 时被 `resolveConfig` 读一次并闭包捕获，**别的插件无法在运行期改写**。
 * 用户明确要求免补丁，所以必须走 ① 这条路。
 *
 * ## 本模块的做法
 *
 * 把主文件夹的指令文件**镜像**到 `$DSH_HOME/AGENTS.md`。该文件是整条发现
 * 流程里**唯一无条件加载**的，不依赖 marker、不依赖 cwd、也不会被子文件夹
 * 的同名文件截断。
 *
 * 三个必须处理好的细节：
 *   1. **不能覆盖用户已有的全局文件** —— 若已存在且不是本插件写的，
 *      默认拒绝写入并明确报告（用户可能自己维护了全局指令）。
 *   2. **必须字节级一致** —— 写入用「临时文件 + rename」原子替换，
 *      避免 DSH 读到半截文件。
 *   3. **要能识别「是不是我写的」** —— 用一个单独的 state 文件记录
 *      源路径与内容哈希，而不是往 AGENTS.md 里塞标记（那会污染提示词）。
 *
 * @module dsh-workspace-folders/roots
 */

import { promises as nodeFs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * 主文件夹里被视为「需要继承的指令文件」，按优先级排序。
 *
 * 只取**第一个存在的**作为镜像源：多个文件同时镜像会互相覆盖，
 * 而 DSH 本身对同目录多候选也有「先到先得」的去重语义。
 * @type {ReadonlyArray<string>}
 */
export const INSTRUCTION_CANDIDATES = Object.freeze(['AGENTS.md', 'CLAUDE.md']);

/** 镜像状态文件名（放在 DSH home 下，与 AGENTS.md 同级）。 */
export const MIRROR_STATE_FILE = '.dsh-workspace-folders-mirror.json';

/**
 * 解析 DSH home。
 * @param {string} [override] - 显式覆盖（测试用）。
 * @returns {string} DSH home 绝对路径。
 */
export function resolveDshHome(override) {
  if (typeof override === 'string' && override.trim().length > 0) return path.resolve(override);
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0) {
    return path.resolve(process.env.DSH_HOME);
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
  return path.resolve(home, '.dsh');
}

/**
 * 计算内容哈希（识别「这个文件是不是我写的、内容有没有变」）。
 * @param {Buffer|string} content - 内容。
 * @returns {string} sha256 十六进制。
 */
export function contentHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 读文件，不存在返回 undefined。
 * @param {string} target - 路径。
 * @returns {Promise<Buffer|undefined>} 内容。
 */
async function readIfExists(target) {
  try {
    return await nodeFs.readFile(target);
  } catch {
    return undefined;
  }
}

/**
 * 原子写文件：先写临时文件再 rename，避免读到半截内容。
 * @param {string} target - 目标路径。
 * @param {Buffer|string} content - 内容。
 * @returns {Promise<void>} 完成后兑现。
 */
async function writeAtomic(target, content) {
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await nodeFs.writeFile(temp, content);
  try {
    await nodeFs.rename(temp, target);
  } catch (error) {
    await nodeFs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * 读取镜像状态。
 * @param {string} dshHome - DSH home。
 * @returns {Promise<object|undefined>} 状态或 undefined。
 */
export async function readMirrorState(dshHome) {
  const raw = await readIfExists(path.join(dshHome, MIRROR_STATE_FILE));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 在主文件夹里挑出镜像源（第一个存在的候选）。
 * @param {string} workspaceRoot - 主工作区根。
 * @returns {Promise<{path: string, content: Buffer}|undefined>} 源文件或 undefined。
 */
export async function pickSource(workspaceRoot) {
  for (const name of INSTRUCTION_CANDIDATES) {
    const candidate = path.join(workspaceRoot, name);
    const content = await readIfExists(candidate);
    if (content !== undefined) return { path: candidate, content };
  }
  return undefined;
}

/**
 * 把主文件夹指令镜像到 `$DSH_HOME/AGENTS.md`。
 *
 * 幂等：内容与源一致时**不写盘**（避免无谓搅动 mtime，也避免触发
 * DSH 的指令变更对账）。
 *
 * @param {object} options - 入参。
 * @param {string} options.workspaceRoot - 主工作区根。
 * @param {string} [options.dshHome] - DSH home（默认自动解析）。
 * @param {boolean} [options.overwriteForeign] - 已存在「非本插件写的」全局文件时是否覆盖。
 * @returns {Promise<{
 *   status: 'mirrored'|'unchanged'|'no-source'|'skipped-foreign'|'error',
 *   source?: string, target: string, detail: string, hash?: string
 * }>} 结果。
 */
export async function mirrorInstructions({ workspaceRoot, dshHome, overwriteForeign = false }) {
  const home = resolveDshHome(dshHome);
  const target = path.join(home, 'AGENTS.md');

  const source = await pickSource(workspaceRoot);
  if (source === undefined) {
    return {
      status: 'no-source',
      target,
      detail: `主工作区根 ${workspaceRoot} 下没有 ${INSTRUCTION_CANDIDATES.join(' / ')}，无需镜像。`,
    };
  }

  const sourceHash = contentHash(source.content);
  const state = await readMirrorState(home);
  const existing = await readIfExists(target);

  // 已存在且内容一致 → 什么都不做。
  if (existing !== undefined && contentHash(existing) === sourceHash) {
    return {
      status: 'unchanged',
      source: source.path,
      target,
      hash: sourceHash,
      detail: `全局文件已与主文件夹指令一致，未改动。`,
    };
  }

  // 已存在但内容不同：判断是不是本插件此前写的。
  if (existing !== undefined) {
    const weWroteIt = state?.sourceHash !== undefined
      && contentHash(existing) === state.sourceHash;
    if (!weWroteIt && !overwriteForeign) {
      return {
        status: 'skipped-foreign',
        source: source.path,
        target,
        detail: [
          `${target} 已存在，且不是本插件写入的（可能是你手写的全局指令）。`,
          '为避免覆盖你的内容，本次**未写入**。',
          '若确实希望用主文件夹的指令覆盖它，请把插件配置 overwriteGlobalInstructions 设为 true，',
          '或先自行备份/移走该文件。',
        ].join(''),
      };
    }
  }

  try {
    await nodeFs.mkdir(home, { recursive: true });
    await writeAtomic(target, source.content);
    await writeAtomic(path.join(home, MIRROR_STATE_FILE), `${JSON.stringify({
      source: source.path,
      sourceHash,
      mirroredAt: new Date().toISOString(),
      plugin: 'dsh-workspace-folders',
    }, null, 2)}\n`);
  } catch (error) {
    return {
      status: 'error',
      source: source.path,
      target,
      detail: `写入失败：${String(error?.message ?? error)}`,
    };
  }

  return {
    status: 'mirrored',
    source: source.path,
    target,
    hash: sourceHash,
    detail: `已把 ${source.path} 镜像到 ${target}。`,
  };
}

/**
 * 撤回镜像：仅当全局文件确实是本插件写的才删除，并清掉状态文件。
 * @param {object} [options] - 入参。
 * @param {string} [options.dshHome] - DSH home。
 * @returns {Promise<{removed: boolean, detail: string}>} 结果。
 */
export async function unmirrorInstructions(options = {}) {
  const home = resolveDshHome(options.dshHome);
  const target = path.join(home, 'AGENTS.md');
  const state = await readMirrorState(home);
  const existing = await readIfExists(target);

  if (existing === undefined) {
    return { removed: false, detail: `${target} 不存在，无需撤回。` };
  }
  const weWroteIt = state?.sourceHash !== undefined && contentHash(existing) === state.sourceHash;
  if (!weWroteIt) {
    return {
      removed: false,
      detail: `${target} 不是本插件写入的，未删除（保护你自己的内容）。`,
    };
  }
  await nodeFs.rm(target, { force: true });
  await nodeFs.rm(path.join(home, MIRROR_STATE_FILE), { force: true });
  return { removed: true, detail: `已删除镜像 ${target}。` };
}

/**
 * 生成给用户看的「怎么做到免补丁」的说明文本。
 * @param {object} result - `mirrorInstructions` 的结果。
 * @param {string} workspaceRoot - 主工作区根。
 * @returns {string} 说明。
 */
export function describeMirror(result, workspaceRoot) {
  const lines = [];
  switch (result.status) {
    case 'mirrored':
      lines.push('✓ 主文件夹的系统指令已同步，子文件夹会话会继续读到它。');
      lines.push(`  来源：${result.source}`);
      lines.push(`  落点：${result.target}`);
      break;
    case 'unchanged':
      lines.push('✓ 主文件夹的系统指令已在位（内容一致，无需改动）。');
      lines.push(`  全局文件：${result.target}`);
      break;
    case 'no-source':
      lines.push(`主工作区根 ${workspaceRoot} 下没有 AGENTS.md / CLAUDE.md，无需同步。`);
      break;
    case 'skipped-foreign':
      lines.push('⚠ 检测到你自己维护的全局指令文件，未覆盖。');
      lines.push(`  ${result.detail}`);
      break;
    default:
      lines.push(`⚠ 指令同步未完成：${result.detail}`);
      break;
  }
  return lines.join('\n');
}
