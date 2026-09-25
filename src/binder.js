/**
 * 会话 ↔ 子文件夹的绑定与保障。
 *
 * 这是插件的核心编排层，负责把三件事串起来：
 *   1. 解析主工作区根，并**确保它带根标记**（否则子文件夹会丢主文件夹 prompt）；
 *   2. 为会话解析/创建专属子文件夹，并登记；
 *   3. 提供界内/出界判定所需的会话根。
 *
 * ## 为什么不能「改 cwd」
 *
 * DSH 的会话 cwd 是**创建时的不可变元数据**（`session.header` 深冻结），
 * 运行中无法修改。因此本插件对**已存在**的会话采取「登记 + 围栏」策略：
 * cwd 仍是主工作区根，但插件把该会话的读写**收敛到它的子文件夹**，
 * 并在越界时走审批。只有由插件自己创建的会话才能真正把 cwd 设进子文件夹
 * （通过 `ctx.sessionController.create({ cwd })`，见 `src/tools.js`）。
 *
 * @module dsh-workspace-folders/binder
 */

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';

import { mirrorInstructions, describeMirror } from './roots.js';
import {
  readRegistry, resolveSessionFolder, resolveTargetFolder, writeRegistry, writeBinding,
  readBinding, upsertSession, removeSession, findSession, findSessionFolderOnDisk,
} from './naming.js';
import { performArchive } from './archiver.js';
import { inheritStoppedSessions, findLiveSiblings, resolveSessionsRoot } from './inherit.js';

/**
 * 把一个会话从某个文件夹的绑定记录里清掉（改绑时的清理动作）。
 *
 * **失败不抛错**：清旧记录是收尾动作，不该让绑定本身失败。
 * 清不掉最多留个幽灵记录，而绑定失败会让用户完全没法用。
 * @param {string} dir - 旧文件夹绝对路径。
 * @param {string} sessionId - 会话 id。
 * @param {object} [logger] - 日志接口。
 * @returns {Promise<void>} 完成。
 */
async function removeSessionFromFolder(dir, sessionId, logger) {
  try {
    const binding = await readBinding(dir);
    if (binding === undefined || binding === null) return;
    if (!Array.isArray(binding.sessions)) return;
    if (!binding.sessions.some((s) => s.id === sessionId)) return;

    const cleaned = removeSession(binding, sessionId);
    if (cleaned.sessions.length === 0) {
      // 这个文件夹已经没有归属会话了 → 删掉绑定文件，别留空壳。
      // 目录本身与 log/INHERITED.md 都保留（历史不丢）。
      await nodeFs.rm(path.join(dir, '.dsh-session.json'), { force: true });
      logger?.debug?.(`workspace-folders: 改绑后清空并移除 ${dir} 的绑定文件`);
      return;
    }
    await writeBinding(dir, cleaned);
    logger?.debug?.(`workspace-folders: 改绑后已从 ${dir} 移除会话 ${sessionId}`);
  } catch (error) {
    logger?.warn?.(
      `workspace-folders: 清理旧文件夹绑定失败（不影响本次绑定）：`
      + String(error?.message ?? error),
    );
  }
}

/**
 * 会话文件夹绑定器。
 */
export class FolderBinder {
  /**
   * @param {object} options - 入参。
   * @param {object} options.ctx - 插件上下文。
   * @param {object} options.config - 已归一化配置。
   * @param {object} [options.logger] - 日志接口。
   */
  constructor({ ctx, config, logger }) {
    this.ctx = ctx;
    this.config = config;
    this.logger = logger;
    /** @type {string|undefined} 惰性解析的工作区根。 */
    this.rootCache = undefined;
    /** @type {Map<string, {folder: string, dir: string}>} 进程内缓存。 */
    this.cache = new Map();
    /**
     * 串行化队列：同一会话的并发绑定请求必须排队，
     * 否则两次 `resolveSessionFolder` 可能都判定「目录不存在」而重复创建。
     * @type {Map<string, Promise<unknown>>}
     */
    this.locks = new Map();
  }

  /**
   * 解析主工作区根。
   *
   * 优先级：配置的 `workspaceRoot` → DSH 进程启动目录。
   * 不再向上推断 —— 明确优于聪明。
   * @returns {Promise<string>} 工作区根绝对路径。
   * @throws {Error} 目录不存在时。
   */
  async resolveWorkspaceRoot() {
    if (this.rootCache !== undefined) return this.rootCache;

    const configured = this.config.workspaceRoot;
    const candidate = configured.length > 0 ? path.resolve(configured) : process.cwd();

    const stat = await nodeFs.stat(candidate).catch(() => undefined);
    if (stat === undefined) {
      throw new Error(
        `workspace root does not exist: ${candidate}. 请检查插件配置 workspaceRoot，`
        + '或让它留空以使用 DSH 的启动目录。',
      );
    }
    if (!stat.isDirectory()) throw new Error(`workspace root is not a directory: ${candidate}`);

    this.rootCache = candidate;
    return candidate;
  }

  /**
   * 同步主文件夹的系统指令，使子文件夹会话仍能读到它 —— **免补丁方案的核心**。
   *
   * 做法是把主文件夹的 `AGENTS.md` / `CLAUDE.md` 镜像到 `$DSH_HOME/AGENTS.md`。
   * 该全局文件是 DSH 指令发现里唯一**无条件加载**的，不依赖项目根标记，
   * 因此不需要用户改任何 profile 配置。
   *
   * 幂等：内容一致时不写盘。不覆盖用户自己维护的全局文件（除非显式允许）。
   * @returns {Promise<object>} `mirrorInstructions` 的结果。
   */
  async syncInstructions() {
    const root = await this.resolveWorkspaceRoot();
    if (!this.config.mirrorInstructions) {
      return {
        status: 'disabled',
        target: '',
        detail: '指令镜像已在配置中关闭（mirrorInstructions: false）。',
      };
    }
    return mirrorInstructions({
      workspaceRoot: root,
      dshHome: this.config.dshHome,
      overwriteForeign: this.config.overwriteGlobalInstructions,
    });
  }

  /**
   * 判断子文件夹会话当前是否真的能拿到主文件夹指令。
   * @returns {Promise<{inherits: boolean, detail: string, target: string}>} 判定结果。
   */
  async instructionInheritance() {
    const root = await this.resolveWorkspaceRoot();
    if (!this.config.mirrorInstructions) {
      return {
        inherits: false,
        target: '',
        detail: '指令镜像已关闭，子文件夹会话不会继承主文件夹的指令。',
      };
    }
    const result = await this.syncInstructions();
    const inherits = result.status === 'mirrored' || result.status === 'unchanged';
    return {
      inherits,
      target: result.target,
      detail: describeMirror(result, root),
    };
  }

  /**
   * 在串行锁内执行操作，避免同一会话并发创建多个目录。
   *
   * 实现要点：链尾必须是**永不 reject** 的 promise，否则一次失败会让
   * 后续 `await previous` 直接抛出，锁就永久卡死。清理时只在「自己仍是
   * 链尾」时删除，避免把后来者的锁误删。
   * @param {string} key - 锁键（通常是 sessionId）。
   * @param {() => Promise<any>} fn - 待执行操作。
   * @returns {Promise<any>} 操作结果。
   */
  async withLock(key, fn) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      // 只有当链尾仍是我们放进去的那个时，才清理。
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  /**
   * 解析会话的子文件夹（已绑定则复用，未绑定则创建或绑定到指定目标）。
   * @param {object} options - 入参。
   * @param {string} options.sessionId - 会话 id。
   * @param {string} [options.title] - 会话标题（仅用于**自动命名**）。
   * @param {boolean} [options.create] - 是否允许创建（false 时只查已有绑定）。
   * @param {string} [options.target] - **指定目标目录名**（单段）。
   *   给了就绑到它（已存在则直接用，不存在则新建），
   *   **不做 `-2` 去重** —— 「绑到 MinerU」不该变成「MinerU-2」。
   *   典型用途：把对话绑到主工作区下已有的项目目录。
   * @returns {Promise<{folder: string, dir: string, created: boolean, root: string}>} 绑定结果。
   */
  async bind({ sessionId, title, create = true, target }) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('sessionId is required to bind a working folder');
    }

    const cached = this.cache.get(sessionId);
    if (cached !== undefined) {
      // 缓存只在「没指定新目标」时短路。
      // 若这次显式给了 target 而缓存指向别处，必须继续走下去执行改绑 ——
      // 否则「把本对话改绑到另一个项目」会被静默忽略。
      const wantsOther = typeof target === 'string'
        && target.trim().length > 0
        && path.basename(cached.dir) !== target.trim();
      if (!wantsOther) {
        return { ...cached, created: false, root: await this.resolveWorkspaceRoot() };
      }
    }

    return this.withLock(sessionId, async () => {
      // 双重检查：排队期间可能已被前一个请求绑定。
      // 与上面的缓存短路同理 —— 有显式新目标时不短路。
      const recheck = this.cache.get(sessionId);
      if (recheck !== undefined) {
        const wantsOther = typeof target === 'string'
          && target.trim().length > 0
          && path.basename(recheck.dir) !== target.trim();
        if (!wantsOther) {
          return { ...recheck, created: false, root: await this.resolveWorkspaceRoot() };
        }
      }

      const root = await this.resolveWorkspaceRoot();
      await this.syncInstructions();

      const registry = await readRegistry(root);
      const recorded = registry.sessions[sessionId];

      // ★ 指定了 target 就必须生效 —— 哪怕登记表里记着别的文件夹。
      //   否则「改绑到另一个项目」会被静默忽略，看起来像没生效。
      const explicitTarget = typeof target === 'string' && target.trim().length > 0
        ? target.trim()
        : undefined;
      if (explicitTarget === undefined && recorded === undefined && !create) {
        return { folder: '', dir: '', created: false, root, unbound: true };
      }

      // ── ★ 兜底恢复：登记表查不到就去磁盘上找 ────────────────────
      //
      // 这是「**绑定不是恒久的，切换对话就会炸**」的修复点。
      //
      // 登记表（`.dsh-workspace-folders.json`）只是缓存；真正的持久记录
      // 是每个子文件夹里的 `.dsh-session.json`。早期只信登记表，
      // 于是登记表少一条就会**另建一个新文件夹**，把老文件夹丢在一边
      // （实测复现见 `scripts/repro-switch.js`）。
      //
      // 只在「没指定 target」且「登记表里没有」时才扫盘：
      //   - 指定了 target 时用户意图明确，不该被旧记录覆盖；
      //   - 登记表里有记录时走原路，不付扫盘代价。
      let recoveredFrom;
      if (explicitTarget === undefined && recorded === undefined) {
        recoveredFrom = await findSessionFolderOnDisk({ parentDir: root, sessionId });
        if (recoveredFrom !== undefined) {
          this.logger?.info?.(
            `workspace-folders: 登记表里没有 ${sessionId}，`
            + `但从磁盘恢复到 ${recoveredFrom}（自愈）`,
          );
        }
      }

      const effectiveExisting = recorded?.folder ?? recoveredFrom;

      const resolved = explicitTarget !== undefined
        ? await resolveTargetFolder({ parentDir: root, target: explicitTarget })
        : await resolveSessionFolder({
          parentDir: root,
          sessionId,
          title,
          existing: effectiveExisting,
          prefix: this.config.folderPrefix,
          dated: this.config.folderDated,
        });

      // ── ★ 改绑：先把会话从**旧**文件夹的记录里清掉 ──────────────
      //
      // 不清理的后果（实测确认，见 `scripts/repro-rebind.js`）：
      // 旧文件夹的 `.dsh-session.json` 里留着 `state: "active"` 的
      // 幽灵记录，插件于是认为同一个会话属于两个文件夹 ——
      // 下次往旧文件夹绑定时会把这个**正在运行的自己**当成「老会话」归档。
      //
      // 严格单一归属：一个会话永远只在一个文件夹的记录里。
      // 历史不会丢 —— 文件夹自己的 `INHERITED.md` 与 `log/` 都还在。
      //
      // ⚠️ `recorded.dir` 是后加的字段；**老注册表只有 `folder`**。
      //    所以必须能从 `folder` 回推绝对路径，否则对老数据永远不清理
      //    （实测：本机注册表两条记录都没有 `dir`）。
      //
      // ⚠️ 用 `recorded` 而不是 `effectiveExisting`：**自愈恢复不算改绑** ——
      //    恢复到的目录就是当前目录，不清理任何东西。
      //
      // ⚠️ 但登记表查不到时**不能就此放弃清理**：那会留下幽灵记录
      //    （实测：登记表空 + 显式 target 改绑，旧文件夹没被清）。
      //    所以这里也走一次磁盘扫描兜底 —— 只在需要清理时才付这个代价。
      let previousDir = typeof recorded?.dir === 'string' && recorded.dir.length > 0
        ? recorded.dir
        : (typeof recorded?.folder === 'string' && recorded.folder.length > 0
          ? path.join(root, recorded.folder)
          : undefined);
      if (previousDir === undefined) {
        const onDisk = await findSessionFolderOnDisk({ parentDir: root, sessionId });
        if (onDisk !== undefined) previousDir = path.join(root, onDisk);
      }
      const rebinding = typeof previousDir === 'string'
        && previousDir.length > 0
        && path.resolve(previousDir) !== path.resolve(resolved.dir);
      if (rebinding) {
        await removeSessionFromFolder(previousDir, sessionId, this.logger);
      }

      // 登记表是缓存；权威是子文件夹内的绑定文件。两者都写，便于恢复与人工排查。
      //
      // ⚠️ 改绑时**必须盖新时间戳**：早期沿用 `recorded?.boundAt`，
      //    导致新记录的时间跟旧的一模一样，从数据上分不清哪个是新的
      //    （实测确认）。新建时才没有历史值可用。
      //
      // ⚠️ 自愈恢复时要**沿用磁盘上原有的 `boundAt`** —— 恢复不是改绑，
      //    盖新时间会把「这个故事什么时候开始的」抹掉。
      const priorBinding = await readBinding(resolved.dir);
      const priorBoundAt = findSession(priorBinding, sessionId)?.boundAt;
      const boundAt = rebinding
        ? new Date().toISOString()
        : (recorded?.boundAt ?? priorBoundAt ?? new Date().toISOString());
      registry.sessions[sessionId] = {
        folder: resolved.folder,
        dir: resolved.dir,
        boundAt,
      };
      await writeRegistry(root, registry);

      // ⚠️ 必须**合并**而非覆盖：同一个子文件夹可能已记录了历史会话
      // （④ 继承、⑤ 让位都会留下记录）。直接覆盖会把它们抹掉，
      // 导致下次绑定认不出「这是我上一段对话」。
      await writeBinding(resolved.dir, upsertSession(priorBinding, {
        id: sessionId,
        state: 'active',
        folder: resolved.folder,
        boundAt,
      }));

      if (this.config.writeInheritedNote) {
        await this.writeInheritedNote(resolved.dir, { root, title });
      }

      // ── ④⑤ 分流：这个文件夹里有没有别的会话？──────────────────
      //
      // ④ 已停止的老对话 → 归档它 + 对接 log（客观事实，不需要确认）
      // ⑤ 还活着的老对话 → 报告给调用方，由客户端插件跳转后归档自己
      //
      // 失败**不得影响绑定本身** —— 绑定是主流程，继承是增值动作。
      // 所以这里 catch 住，只记警告。
      let inheritance;
      if (this.config.inheritOnBind) {
        try {
          inheritance = await this.applyInheritance({
            sessionId, dir: resolved.dir, title,
          });
        } catch (error) {
          this.logger?.warn?.(
            `workspace-folders: inheritance skipped for ${sessionId}: `
            + String(error?.message ?? error),
          );
        }
      }

      const entry = { folder: resolved.folder, dir: resolved.dir };
      this.cache.set(sessionId, entry);
      return { ...entry, created: resolved.created, root, inheritance };
    });
  }

  /**
   * 执行 ④⑤ 的分流处理。
   * @param {object} options - 入参。
   * @param {string} options.sessionId - 当前会话 id。
   * @param {string} options.dir - 子文件夹。
   * @param {string} [options.title] - 会话标题。
   * @returns {Promise<object>} 继承结果。
   */
  async applyInheritance({ sessionId, dir, title }) {
    const sessionsRoot = resolveSessionsRoot({ ctx: this.ctx, dshHome: this.config.dshHome });

    // ④：处置已停止的老对话。
    //   归档走 archiver 的 performArchive。这里归档的是**别人**，
    //   所以必须把「自己是谁」显式传下去 —— `performArchive` 才能判断
    //   「目标恰好是当前会话」并拦下。**不能靠它自己去猜**
    //   （`sessions.list()` 返回全部会话，没有「当前」的概念）。
    const result = await inheritStoppedSessions({
      ctx: this.ctx,
      dir,
      sessionId,
      folderTitle: title,
      sessionsRoot,
      maxBullets: this.config.handoffMaxBullets,
      archive: async ({ sessionId: targetId, title: targetTitle }) => {
        return performArchive({
          ctx: this.ctx,
          sessionId: targetId,
          title: targetTitle,
          callerSessionId: sessionId,
        });
      },
    });

    // ⑤：报告仍然活跃的老对话，交给上层决定要不要跳转。
    const live = await findLiveSiblings({ ctx: this.ctx, dir, sessionId, sessionsRoot });

    return { entries: result.entries, handoff: result.handoff, note: result.note, live };
  }

  /**
   * 查会话已绑定的子文件夹（不创建）。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<{folder: string, dir: string, root: string}|undefined>} 绑定或 undefined。
   */
  async lookup(sessionId) {
    const cached = this.cache.get(sessionId);
    if (cached !== undefined) {
      return { ...cached, root: await this.resolveWorkspaceRoot() };
    }
    const root = await this.resolveWorkspaceRoot();
    const registry = await readRegistry(root);
    const recorded = registry.sessions[sessionId];

    // ★ 与 `bind()` 保持一致：登记表查不到时去磁盘上找。
    //
    // 这条路径早期只看登记表，于是 `lookup()` 说「没绑定」而
    // `bind()` 会去新建一个文件夹 —— 同一个会话两个答案（实测复现）。
    const folder = recorded?.folder
      ?? await findSessionFolderOnDisk({ parentDir: root, sessionId });
    if (folder === undefined) return undefined;

    const dir = path.join(root, folder);
    if (!(await isDirectory(dir))) return undefined;

    // 自愈：顺手把登记表补回去，下次不用再扫盘。
    if (recorded === undefined) {
      this.logger?.info?.(`workspace-folders: lookup 从磁盘恢复 ${sessionId} → ${folder}`);
      const binding = await readBinding(dir);
      registry.sessions[sessionId] = {
        folder,
        dir,
        boundAt: findSession(binding, sessionId)?.boundAt ?? new Date().toISOString(),
      };
      await writeRegistry(root, registry).catch(() => {});
    }

    this.cache.set(sessionId, { folder, dir });
    return { folder, dir, root };
  }

  /**
   * 列出所有已登记的会话文件夹。
   * @returns {Promise<Array<{sessionId: string, folder: string, dir: string, boundAt: string, hasBindingFile: boolean}>>} 列表。
   */
  async list() {
    const root = await this.resolveWorkspaceRoot();
    const registry = await readRegistry(root);
    const rows = [];
    for (const [sessionId, entry] of Object.entries(registry.sessions)) {
      const dir = path.join(root, entry.folder);
      const binding = await readBinding(dir);
      rows.push({
        sessionId,
        folder: entry.folder,
        dir,
        boundAt: entry.boundAt,
        hasBindingFile: binding !== undefined,
      });
    }
    return rows.sort((a, b) => a.folder.localeCompare(b.folder));
  }

  /**
   * 子文件夹里写一份人可读的来历说明（幂等，不覆盖已有内容）。
   * @param {string} dir - 子文件夹。
   * @param {object} info - 信息。
   * @param {string} info.root - 主工作区根。
   * @param {string} [info.title] - 会话标题。
   * @returns {Promise<void>} 完成后兑现。
   */
  async writeInheritedNote(dir, info) {
    const target = path.join(dir, 'INHERITED.md');
    try {
      await nodeFs.stat(target);
      return; // 已存在，尊重用户可能的编辑
    } catch {
      // 不存在，继续写
    }
    const body = [
      '# 本工作文件夹',
      '',
      '本目录由 `dsh-workspace-folders` 插件为一个对话自动创建。',
      '',
      '## 系统指令继承',
      '',
      `会话的工作目录是本文件夹。DSH 的指令加载器会从 cwd **向上**读取`,
      `\`AGENTS.md\` / \`CLAUDE.md\`，因此主工作区`,
      '',
      `    ${info.root}`,
      '',
      '下的这份指令**仍然生效**（靠该目录里的 `.dsh-workspace-root` 标记让向上走停在那里）。',
      '如需只对本次对话生效的指令，直接在本目录放一个 `AGENTS.md` 即可 ——',
      '它会与主文件夹的指令**叠加**，而不是替换。',
      '',
      '## 出界访问',
      '',
      '读写本文件夹之外的路径需要用户逐次批准。',
      '',
      '## 文件说明',
      '',
      '| 文件 | 作用 | 可否删除 |',
      '|---|---|---|',
      '| `.dsh-session.json` | 会话与本目录的绑定记录 | 可删（会退化为无主目录） |',
      '| `INHERITED.md` | 本说明 | 可删 |',
      '',
      info.title ? `对话标题：${info.title}` : '',
      '',
    ].filter((line) => line !== undefined).join('\n');
    await nodeFs.writeFile(target, body, 'utf8');
  }

  /**
   * 读取登记表（`会话 id → 子文件夹`）。供客户端 ⑤ 的归属判定使用。
   *
   * ⚠️ 故意**不叫** `readRegistry` —— 那个名字被模块级导入的纯函数占着，
   * 同名会让「方法体里调的到底是谁」变得难以判断（虽然 JS 里类方法体内
   * 裸写 `readRegistry` 解析到的是模块作用域，但那是隐晦的巧合）。
   *
   * 工作区根解析失败时返回空表而不是抛错 —— 调用方（`workspaceFolders`
   * 快照源）宁可不判定，也不该因为读不到表就崩掉。
   * @returns {Promise<{sessions: object}>} 登记表。
   */
  async loadRegistry() {
    try {
      const root = await this.resolveWorkspaceRoot();
      return await readRegistry(root);
    } catch {
      return { sessions: {} };
    }
  }

  /**
   * 清除某会话的进程内缓存（用于测试或重新绑定）。
   * @param {string} [sessionId] - 会话 id；省略则清空全部。
   * @returns {void}
   */
  invalidate(sessionId) {
    if (sessionId === undefined) this.cache.clear();
    else this.cache.delete(sessionId);
  }
}

/**
 * 判断路径是否为存在的目录。
 * @param {string} target - 绝对路径。
 * @returns {Promise<boolean>} 是否为目录。
 */
async function isDirectory(target) {
  const stat = await nodeFs.stat(target).catch(() => undefined);
  return stat?.isDirectory() === true;
}
