/**
 * 插件配置：默认值与归一化。
 *
 * 刻意不引入 schemastery 依赖 —— 本插件要能以「源码目录直接挂载」的方式
 * 使用，保持零运行时依赖。校验用手写夹逼（clamp），并对每个被修正的字段
 * 留下可读的理由，便于用户看懂配置到底生效成了什么。
 *
 * @module dsh-workspace-folders/config
 */

/**
 * 默认配置。
 * @type {object}
 */
export const DEFAULTS = Object.freeze({
  /**
   * 主工作区根：**保留 system prompt 的那一层**。
   *
   * 该目录下的 AGENTS.md / CLAUDE.md 会被注入到每个子文件夹会话里，
   * 这正是用户要求「主文件夹系统 prompt 要保留」的落点。
   * 留空表示取 DSH 进程的启动目录（`process.cwd()`）。
   */
  workspaceRoot: '',

  /**
   * 是否在会话首次活动时自动创建并绑定子文件夹。
   *
   * 设为 `false` 时插件只提供工具，由模型/用户显式调用。
   */
  autoBind: true,

  /**
   * 是否把主文件夹的指令镜像到 `$DSH_HOME/AGENTS.md`。
   *
   * 这是**免补丁**保住主文件夹 system prompt 的机制：该全局文件是 DSH
   * 指令发现里**唯一无条件加载**的，不依赖项目根标记、不依赖 cwd、
   * 也不会被子文件夹的同名文件截断。
   * 关掉它，子文件夹会话就会丢失主文件夹的 AGENTS.md / CLAUDE.md。
   */
  mirrorInstructions: true,

  /**
   * 当 `$DSH_HOME/AGENTS.md` 已存在、且**不是本插件写的**时，是否覆盖。
   *
   * 默认 `false`：宁可不同步，也不擅自覆盖用户自己维护的全局指令。
   * 此时插件会在状态里明确报告，由用户决定。
   */
  overwriteGlobalInstructions: false,

  /** 显式指定 DSH home（留空则按 `DSH_HOME` 环境变量或 `~/.dsh` 解析）。 */
  dshHome: '',

  /**
   * 子文件夹命名模板可用变量：`{date}` `{slug}` `{session}`。
   * 目录名由 `src/naming.js` 生成，此模板只控制前缀/后缀形态。
   */
  folderPrefix: '',

  /**
   * 目录名是否带 `YYYY-MM-DD-` 日期前缀。**默认关闭**。
   *
   * ## 为什么默认关（用户明确要求）
   *
   * 用户对比了工作区里的实际风格之后否掉了日期前缀：
   *
   * ```
   * MinerU   PhO   Books   qq-bot   dsh-config    ← 真正的项目/文件夹长这样
   * 2026-09-25-fix-auth                           ← 带日期的，风格突兀
   * ```
   *
   * 目录本来就按修改时间可排，名字里塞日期是**噪声**，
   * 还让「这个对话是干什么的」更难一眼看出。
   *
   * 需要按日期归档的人可以打开它（`folderDated: true`）。
   */
  folderDated: false,

  /** 子文件夹里是否写入继承说明（`INHERITED.md`），便于人查看这一段对话的来历。 */
  writeInheritedNote: true,

  /**
   * 是否在每轮对话结束后，把会话内容投影成完整 log 写进该对话的子文件夹
   * （`<子文件夹>/log/NNNN-<sessionId>.md`）。
   *
   * 投影会丢掉逐 token 增量与失败尝试这两类高噪声事件，但保留正文、
   * 工具调用、压缩标记与被中断的消息 —— 所以是「去重复」而非「丢证据」。
   */
  writeJournal: true,

  /**
   * 写 log 的去抖时长（毫秒）。密集轮次只在静默这么久之后写一次盘。
   * 调大减少写盘频率，但崩溃时丢失的未写入内容更多。
   */
  journalDebounceMs: 4000,

  /** 单份 log 的字节上限。 */
  maxJournalBytes: 2000000,

  /**
   * 会话归档的触发方式。
   *
   * `'confirm'`（默认）—— 判断「这段对话可以收了」时，弹**带按钮的卡片**
   *     征求确认（`ctx.approval`），你点「允许一次」才归档。零打字。
   * `'manual'`  —— 不主动弹卡片，只有你敲 `/workspace-archive` 才执行。
   * `'off'`     —— 整个归档功能关闭（`workspace_archive` 工具也不注册）。
   *
   * ⚠️ 归档**永不自动执行**：无论哪一档，都必须经过你的确认。
   * 因为「工作完了」是语义判断，无法用事件可靠表达。
   */
  archiveMode: 'confirm',

  /**
   * 是否在绑定时执行 ④⑤ 分流。
   *
   * `true`（默认）—— 绑定时检查子文件夹里有没有别的会话：
   *   - **已停止**的老对话 → 归档它，并把它的 log 提炼成交接摘要（需求④）
   *   - **还活着**的老对话 → 报告给上层，由客户端插件跳转后归档自己（需求⑤）
   *
   * 关掉则只做纯绑定，不碰任何历史会话。
   */
  inheritOnBind: true,

  /**
   * 交接摘要（写进子文件夹 `AGENTS.md`）最多保留多少条要点。
   *
   * 这份摘要会**进入新对话的系统提示**，所以要克制 ——
   * 太长会挤占上下文，违背「精简继承」的初衷。
   */
  handoffMaxBullets: 24,

  /**
   * 出界访问策略。
   *
   * `'ask'`  —— 每次出界都走 `ctx.approval` 弹窗（用户要求的默认行为）。
   * `'deny'` —— 一律拒绝，不打扰用户。
   */
  outsideAccess: 'ask',

  /**
   * 界内是否免审批。默认 `true`：子文件夹内是自己的地盘。
   * 主工作区根**不**在界内（用户的明确要求：出界一律审批）。
   */
  allowInsideWithoutAsk: true,

  /** 单次工具返回给模型的文本上限。 */
  maxToolResultBytes: 8000,
});

/**
 * 把配置值夹到闭区间。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 默认值。
 * @param {number} min - 下界。
 * @param {number} max - 上界。
 * @returns {number} 归一化结果。
 */
function clampNumber(value, fallback, min, max) {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, num));
}

/**
 * 取字符串，非字符串或空白则退回默认。
 * @param {unknown} value - 原始值。
 * @param {string} fallback - 默认值。
 * @returns {string} 归一化结果。
 */
function asString(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * 取布尔，严格判定（避免 `'false'` 被当成真）。
 * @param {unknown} value - 原始值。
 * @param {boolean} fallback - 默认值。
 * @returns {boolean} 归一化结果。
 */
function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 归一化插件配置。
 * @param {object} [raw] - 用户提供的配置。
 * @returns {object} 完整配置。
 */
export function resolveConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};

  const outsideAccess = asString(source.outsideAccess, DEFAULTS.outsideAccess).toLowerCase();
  const normalizedOutside = outsideAccess === 'deny' ? 'deny' : 'ask';
  const archiveMode = source.archiveMode;
  const normalizedArchive = archiveMode === 'manual' || archiveMode === 'off'
    ? archiveMode
    : 'confirm';

  return {
    workspaceRoot: asString(source.workspaceRoot, DEFAULTS.workspaceRoot),
    autoBind: asBoolean(source.autoBind, DEFAULTS.autoBind),
    mirrorInstructions: asBoolean(source.mirrorInstructions, DEFAULTS.mirrorInstructions),
    overwriteGlobalInstructions: asBoolean(
      source.overwriteGlobalInstructions,
      DEFAULTS.overwriteGlobalInstructions,
    ),
    dshHome: typeof source.dshHome === 'string' ? source.dshHome.trim() : DEFAULTS.dshHome,
    folderPrefix: typeof source.folderPrefix === 'string' ? source.folderPrefix : DEFAULTS.folderPrefix,
    folderDated: asBoolean(source.folderDated, DEFAULTS.folderDated),
    writeInheritedNote: asBoolean(source.writeInheritedNote, DEFAULTS.writeInheritedNote),
    writeJournal: asBoolean(source.writeJournal, DEFAULTS.writeJournal),
    journalDebounceMs: clampNumber(source.journalDebounceMs, DEFAULTS.journalDebounceMs, 0, 600000),
    maxJournalBytes: clampNumber(source.maxJournalBytes, DEFAULTS.maxJournalBytes, 4096, 100000000),
    archiveMode: normalizedArchive,
    inheritOnBind: asBoolean(source.inheritOnBind, DEFAULTS.inheritOnBind),
    handoffMaxBullets: clampNumber(source.handoffMaxBullets, DEFAULTS.handoffMaxBullets, 1, 200),
    outsideAccess: normalizedOutside,
    allowInsideWithoutAsk: asBoolean(source.allowInsideWithoutAsk, DEFAULTS.allowInsideWithoutAsk),
    maxToolResultBytes: clampNumber(source.maxToolResultBytes, DEFAULTS.maxToolResultBytes, 256, 200000),
  };
}

/**
 * 渲染生效配置的摘要（供 `/workspace-folders` 命令与工具返回）。
 * @param {object} config - 已归一化配置。
 * @param {string} resolvedRoot - 实际生效的工作区根。
 * @returns {string} 多行摘要。
 */
export function describeConfig(config, resolvedRoot) {
  return [
    `主工作区根（保留 system prompt）: ${resolvedRoot}`,
    `自动绑定子文件夹              : ${config.autoBind ? '开' : '关'}`,
    `镜像主文件夹指令到 $DSH_HOME   : ${config.mirrorInstructions ? '开' : '关'}`,
    `出界访问策略                  : ${config.outsideAccess === 'ask' ? '每次弹窗申请' : '一律拒绝'}`,
    `界内免审批                    : ${config.allowInsideWithoutAsk ? '是' : '否'}`,
    `对话归档                      : ${describeArchiveMode(config.archiveMode)}`,
  ].join('\n');
}

/**
 * 把归档模式翻译成人话。
 * @param {string} mode - 归档模式。
 * @returns {string} 说明。
 */
function describeArchiveMode(mode) {
  switch (mode) {
    case 'confirm': return '弹卡片确认（零打字）';
    case 'manual': return '仅斜杠命令';
    case 'off': return '关闭';
    default: return mode;
  }
}
