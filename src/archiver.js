/**
 * 会话归档 —— 对应需求 ③「工作完该任务后自动清除自身」。
 *
 * ## 为什么是「归档」而不是「删除」
 *
 * 我查过 DSH 的可用能力：
 *
 * - **没有** `deleteSession` / `removeSession`。唯一的 `session/delete` 在
 *   `@agentclientprotocol/sdk`（ACP 协议层），DSH 自己没实装。
 *   所以「删除会话」只能绕过 DSH 直接删 `~/.dsh/sessions/<uuid>/`，
 *   而且会撞上两个坑：
 *     1. `sessionQuery.listSessions()` 会把**内存中活着的会话**并进列表，
 *        删了目录仍会显示 → 留下删不掉的幽灵条目；
 *     2. 标题、附件等元数据在别处 → 留下孤儿数据。
 * - **有** `ctx.workspaceRegistry.archiveSession(id)`。
 *   语义（源码注释）：从所有分组界面隐藏，但**保留 `sessionIds` 槽位**，
 *   **完全不碰会话日志与附件**。
 *
 * 所以归档 = 「让它不再碍事」，且内容零损失。这比删除更贴合 ③ 的真实意图。
 *
 * ## 为什么由你点按钮而不是自动执行
 *
 * 「工作完该任务后」里的「工作完了」是个**语义判断**，没有事件能可靠表达。
 * 若自动执行，最坏情况是你还在用的对话被自己藏起来。
 *
 * 所以本模块**不自动归档**：它调 `ctx.approval.request()` 弹一个**带按钮的
 * 卡片**（DSH 的审批弹窗本来就是可点按钮，文案已中文化：
 * `allowOnce: "允许一次"` / `reject: "拒绝"`）。你点一下即可，零打字 ——
 * 而「你点了按钮」这件事本身，就是「工作完了」的权威定义。
 *
 * @module dsh-workspace-folders/archiver
 */

import { APPROVAL_OUTCOMES } from './guard.js';

/**
 * 归档操作的结果。
 * @typedef {object} ArchiveResult
 * @property {boolean} archived - 是否真的归档了。
 * @property {string} outcome - 审批结果（或跳过原因）。
 * @property {string} message - 给模型/用户看的说明。
 */

/** 跳过归档的原因词表。 */
export const SKIP_REASONS = Object.freeze([
  'disabled',
  'current-session',
  'not-found',
  'no-registry',
  'already-archived',
]);

/**
 * 判断某会话是否已在归档集里。
 * @param {object} registry - `ctx.workspaceRegistry`。
 * @param {string} sessionId - 会话 id。
 * @returns {boolean} 是否已归档。
 */
export function isArchived(registry, sessionId) {
  try {
    const ids = registry?.archivedSessionIds;
    return Array.isArray(ids) && ids.includes(sessionId);
  } catch {
    return false;
  }
}

/**
 * 定位归档服务并做能力检查。
 *
 * `workspaceRegistry` 刻意**不放进 `inject`**：那样会在服务缺席时让整个插件
 * 不加载，而本插件的其它功能（子文件夹、log、指令镜像）应当照常工作。
 * 所以这里做运行期探测，缺席时明确报错而非静默失败。
 * @param {object} ctx - 插件上下文。
 * @returns {{ok: boolean, registry?: object, message: string}} 探测结果。
 */
export function resolveRegistry(ctx) {
  // `workspaceRegistry` 已在 inject 里声明，直读即可。
  const registry = ctx?.workspaceRegistry;
  if (registry === undefined || registry === null) {
    return {
      ok: false,
      message: '本部署未挂载 workspaceRegistry（@deepseek-ai/dsh-workspace），无法归档。',
    };
  }
  if (typeof registry.archiveSession !== 'function') {
    return {
      ok: false,
      message: 'workspaceRegistry 没有 archiveSession 方法，DSH 版本可能不匹配。',
    };
  }
  return { ok: true, registry, message: 'ok' };
}

/**
 * 就「归档本对话」向用户申请确认 —— 弹卡片，你点按钮。
 *
 * 复用 DSH 原生审批通道，因此自动获得：审计事件（`approval/asked` +
 * `approval/decided`）、路由到正确的 UI、以及 `'ask'` 策略下的 fail-closed。
 *
 * ## 这里为什么**不**启用「不许归档当前会话」护栏
 *
 * 本函数的语义就是「用户显式要求归档**当前**这段对话」，而且路径上**必然**
 * 经过审批卡片（`allowed-once` 才继续）。用户点过「允许一次」之后再拿
 * `current-session` 拒绝，属于自相矛盾。
 *
 * 那道护栏是给 `performArchive` 的**另一个**调用方用的 —— ④ 继承时归档
 * **别人**，那种场景下才需要「目标恰好是自己」的保护。
 *
 * @param {object} options - 入参。
 * @param {object} options.ctx - 插件上下文，需含 `approval` 服务。
 * @param {object} options.agent - 发起归档的 agent（决定弹窗路由与审计落点）。
 * @param {string} options.sessionId - 待归档的会话 id。
 * @param {string} [options.title] - 会话标题（显示在卡片上，便于你确认是哪一段）。
 * @param {string} [options.callId] - 工具调用 id，让 UI 把卡片挂到该次调用上。
 * @param {string} [options.reason] - 额外理由。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @returns {Promise<ArchiveResult>} 申请结果。
 */
export async function requestArchive({
  ctx, agent, sessionId, title, callId, reason, signal,
}) {
  const approval = ctx?.approval;
  if (approval === undefined || typeof approval.request !== 'function') {
    // 没有审批服务 → **不归档**。宁可什么都不做，也不在无法征求你同意时动手。
    return {
      archived: false,
      outcome: 'unavailable',
      message: '未归档：本部署未挂载审批服务，无法征求你的确认。',
    };
  }

  const label = typeof title === 'string' && title.trim().length > 0
    ? `「${title.trim()}」`
    : `\`${sessionId}\``;

  const lines = [
    `对话 ${label} 已告一段落，是否归档？`,
    '',
    '归档后它会从侧边栏隐藏，但**日志与内容全部保留**，不会丢失任何东西。',
  ];
  if (typeof reason === 'string' && reason.trim().length > 0) {
    lines.push('', `理由：${reason.trim()}`);
  }

  let outcome;
  try {
    outcome = await approval.request({
      agent,
      toolName: 'workspace_archive',
      callId,
      reason: lines.join('\n'),
      signal,
    });
  } catch (error) {
    // 审批通道自身抛错（例如没有打开的 turn）→ 视为不可用，不归档。
    return {
      archived: false,
      outcome: 'unavailable',
      message: `未归档：审批请求失败（${String(error?.message ?? error)}）。`,
    };
  }

  if (!APPROVAL_OUTCOMES.includes(outcome)) {
    return {
      archived: false,
      outcome: 'unavailable',
      message: `未归档：审批返回了未知结果 ${JSON.stringify(outcome)}，按失败关闭处理。`,
    };
  }

  if (outcome !== 'allowed-once') {
    return {
      archived: false,
      outcome,
      message: outcome === 'rejected'
        ? '你拒绝了归档，本对话保持原样。不要重试。'
        : `未归档（审批结果：${outcome}）。`,
    };
  }

  // 本函数的语义就是「申请归档**当前**对话」，所以不该在这里被
  // 「不许归档当前会话」拦住 —— 那道护栏是给 `performArchive` 的**其他**调用方
  // （即 ④ 归档别人的场景）用的。这里不传 `callerSessionId`，
  // 表示「调用方已确认这是一次用户显式同意的自我归档」。
  return performArchive({ ctx, sessionId, title });
}

/**
 * 真正执行归档（**已经拿到用户许可之后**）。
 *
 * 这个函数不做确认，只做动作 + 安全检查。调用方必须先取得许可。
 *
 * @param {object} options - 入参。
 * @param {object} options.ctx - 插件上下文。
 * @param {string} options.sessionId - 待归档的会话 id。
 * @param {string} [options.title] - 会话标题（仅用于文案）。
 * @param {string} [options.callerSessionId] - **调用方自己**的会话 id。
 *   只有它在场时「不许归档当前会话」的护栏才生效；缺省则该护栏不启用。
 * @returns {Promise<ArchiveResult>} 归档结果。
 */
export async function performArchive({ ctx, sessionId, title, callerSessionId }) {
  const probe = resolveRegistry(ctx);
  if (!probe.ok) {
    return { archived: false, outcome: 'no-registry', message: `未归档：${probe.message}` };
  }
  const { registry } = probe;

  // 检查 1：不许归档当前会话。
  // 源码注释明确：归档当前会话会「clears the selection into the New Session
  // view state」—— 界面会突然跳回空白态，看起来像崩溃。所以拒绝。
  const current = currentSessionId(ctx, callerSessionId);
  if (current !== undefined && current === sessionId) {
    return {
      archived: false,
      outcome: 'current-session',
      message: '未归档：这是当前正在使用的对话。归档它会让界面跳回新会话页，'
        + '因此需要从侧边栏手动操作。',
    };
  }

  // 检查 2：幂等 —— 已在归档集里就直接返回。
  if (isArchived(registry, sessionId)) {
    return {
      archived: false,
      outcome: 'already-archived',
      message: '该对话已经处于归档状态，无需重复操作。',
    };
  }

  try {
    await registry.archiveSession(sessionId);
  } catch (error) {
    // `WorkspaceUnknownSessionError` 是「这个 id 既不在内存也不在持久化里」，
    // 与存储故障要区分开 —— 后者应原样抛出语义，不该谎报成「找不到」。
    const name = error?.name;
    if (name === 'WorkspaceUnknownSessionError') {
      return {
        archived: false,
        outcome: 'not-found',
        message: `未归档：DSH 找不到会话 \`${sessionId}\`（既不在内存也不在持久化中）。`,
      };
    }
    return {
      archived: false,
      outcome: 'error',
      message: `归档失败：${String(error?.message ?? error)}`,
    };
  }

  const label = typeof title === 'string' && title.trim().length > 0
    ? `「${title.trim()}」`
    : `\`${sessionId}\``;
  return {
    archived: true,
    outcome: 'allowed-once',
    message: `已归档对话 ${label}。它会从侧边栏隐藏；日志与内容都还在。`,
  };
}

/**
 * 取「当前会话」的 id，取不到返回 undefined。
 *
 * ## 为什么不再用 `ctx.sessions.list()[0]`
 *
 * `SessionStore.list()` 的签名是 `list(): Session[]` —— 返回的是**全部会话**，
 * 且**没有「当前」这个概念**（会话是并发存在的，一个进程里可以有多个）。
 * 早先这里取 `list()[0]`，等于「随便挑一个会话」。
 *
 * 后果不是崩溃，而是**静默失效的安全检查**：
 * `performArchive` 用它来拦「别归档当前会话」，而 `applyInheritance` 归档的
 * 恰恰是**别人**。若 `list()[0]` 正好等于目标会话，就会**误拒**；
 * 若是别的会话，这道护栏等于不存在。
 *
 * 现在改为：**由调用方显式传入自己的 sessionId**（那是唯一可靠的来源），
 * 拿不到就返回 undefined —— 此时宁可**不拦**，也不能拦错。
 *
 * @param {object} ctx - 插件上下文。
 * @param {string} [explicit] - 调用方已知的当前会话 id。
 * @returns {string|undefined} 会话 id。
 */
function currentSessionId(ctx, explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return undefined;
}

/**
 * 生成给用户/模型看的归档能力说明（用于状态工具与斜杠命令）。
 * @param {object} ctx - 插件上下文。
 * @returns {string} 说明文本。
 */
export function describeArchiveCapability(ctx) {
  const probe = resolveRegistry(ctx);
  if (!probe.ok) return `归档不可用：${probe.message}`;
  let count = 0;
  try {
    count = probe.registry.archivedSessionIds?.length ?? 0;
  } catch {
    count = 0;
  }
  return `归档可用（当前已归档 ${count} 个对话）。`;
}
