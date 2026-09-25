/**
 * dsh-workspace-folders —— 让每个对话拥有专属工作子文件夹，并保住主文件夹的系统指令。
 *
 * ## 它解决的三个问题
 *
 * 1. **新建对话时不能选子文件夹** —— 本插件提供 `workspace_bind`，
 *    自动为该对话创建并登记一个子文件夹。
 * 2. **主文件夹的 system prompt 会丢** —— 这是最关键的一点。DSH 的指令加载器
 *    从 cwd **向上**读 AGENTS.md；cwd 一旦进子文件夹，默认 marker (`'.git'`)
 *    会让向上走一直走到盘根都找不到，于是**根塌陷成子文件夹自己**，
 *    主文件夹的 AGENTS.md / CLAUDE.md 全部消失。本插件在主工作区根放置
 *    专用标记 `.dsh-workspace-root`，让向上走**停在主文件夹**，指令得以继承。
 * 3. **跨目录访问不会弹窗** —— 提供 `workspace_access`，出界一律走
 *    DSH 原生 `ctx.approval`，一次性授权。
 *
 * ## 插件约定（踩过的坑）
 *
 * - 必须**具名导出** `name` / `inject` / `apply`；`export default` 会让
 *   Cordis 的 `unwrapExports` 丢掉 `inject` 元数据。
 * - `ctx.sessions` / `ctx.agents` 是**复数**。
 * - `defineTool` 用动态导入获取，并带多级回退：插件既可能被正式安装
 *   （裸包名可解析），也可能以源码目录挂载（解析不到）。
 *
 * @module dsh-workspace-folders
 */

import { resolveConfig, describeConfig } from './config.js';
import { FolderBinder } from './binder.js';
import { Journal } from './journal.js';
import { requestArchive } from './archiver.js';
import { sessionTitleOf } from './naming.js';
import { registerFolderTools } from './tools.js';
import { installProjectRoute, installBindRoute } from './route.js';

/** 插件名。 */
export const name = 'workspace-folders';

/**
 * 依赖的服务。
 *
 * ## ⚠️ 为什么必须把用到的服务**全部**列进来
 *
 * Cordis 对服务读取有三种行为，**只有一种是对的**：
 *
 * | 写法 | 兄弟插件提供的服务 | 结果 |
 * |---|---|---|
 * | `inject` 里声明，然后 `ctx.X` | ✅ 拿得到 | **唯一正确** |
 * | 不声明，`ctx.X` | ❌ **抛错** | `cannot get property "X" without inject` |
 * | 不声明，`ctx.get('X')` | ❌ **静默 undefined** | 功能悄悄失效，最难查 |
 *
 * 三条都已用真实 cordis 实测确认（`scripts/check-inject.js`）。
 *
 * 还有两个反直觉点：
 *
 * 1. **`?.` 挡不住** —— 抛错发生在属性 getter 内部，可选链还没轮到执行。
 *    `ctx?.approval` 与 `ctx.approval?.request` 都照样抛。
 * 2. **服务在场也没用** —— 校验看的是「有没有声明」，不是「有没有服务」。
 *
 * 放进 `inject` **不会**让插件因服务缺席而报废：Cordis 会**等待**该服务
 * 出现再 apply（实测：服务稍后提供，插件随后加载）。所以「必需」的语义是
 * 「等到齐」，不是「缺了就崩」—— 这正好是我们想要的降级行为。
 *
 * ## 本插件的声明
 *
 * 全部必列。曾经想把 `approval` / `sessionTitle` 当「可选依赖」用
 * `ctx.get()` 读以图降级，但实测证明那样**永远读不到**（静默 undefined），
 * 反而会让审批、归档、标题命名悄悄失效。进 `inject` 后，Cordis 会等它们
 * 就位；DSH 本体始终提供这些服务，所以实际不会有等待。
 */
export const inject = [
  'tools',             // 注册工具
  'systemPrompt',      // 注入常驻指引
  'commands',          // 注册 /workspace-folders、/workspace-archive
  'workspaceRegistry', // 归档会话（③④）
  'sessions',          // 判定会话死活（④⑤）
  'approval',          // 出界审批与归档确认（卡片）
  'sessionTitle',      // 取对话标题给子文件夹命名
  // ── 下面两个只服务于浏览器侧「项目选择器」的只读路由 ──────────────
  //
  // ⚠️ 必须声明。Cordis 的规则（实测）：**未声明的服务用 `ctx.X` 访问会抛错**。
  //    声明之后，Cordis 会在该服务**缺失时让插件等待**，而不是崩掉。
  //    这与前三次「装上就崩」的根因属于同一类问题，别再漏。
  //
  // 注意 `route.js` 里仍然用 `Reflect.get` 兜底 —— 那是为了兼容
  // 「服务存在但方法缺失」以及测试替身，不是用来绕过注入声明的。
  'webServer',
  'connection',
];

/**
 * 解析并加载 `defineTool`，带多级回退。
 * @returns {Promise<Function>} `defineTool` 函数。
 * @throws {Error} 所有途径都失败时。
 */
async function loadDefineTool() {
  const attempts = [];

  // ① 裸包名（正式安装进 profile 的情形）。
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (typeof mod.defineTool === 'function') return mod.defineTool;
    attempts.push('bare specifier resolved but had no defineTool export');
  } catch (error) {
    attempts.push(`bare specifier: ${String(error?.code ?? error?.message ?? error)}`);
  }

  // ② 从 DSH 自身安装位置解析（源码目录 / --patch 挂载的情形）。
  const anchors = [
    process.env.APPDATA
      ? `${process.env.APPDATA}/npm/node_modules/@deepseek-ai/dsh/package.json`
      : undefined,
    process.env.DSH_HOME ? `${process.env.DSH_HOME}/profiles/web/package.json` : undefined,
  ].filter((value) => typeof value === 'string');

  for (const anchor of anchors) {
    try {
      const { createRequire } = await import('node:module');
      const { pathToFileURL } = await import('node:url');
      const require = createRequire(anchor);
      const resolved = require.resolve('@deepseek-ai/dsh-tools');
      const mod = await import(pathToFileURL(resolved).href);
      if (typeof mod.defineTool === 'function') return mod.defineTool;
      attempts.push(`${anchor}: resolved but had no defineTool export`);
    } catch (error) {
      attempts.push(`${anchor}: ${String(error?.code ?? error?.message ?? error)}`);
    }
  }

  throw new Error(`could not load defineTool:\n  ${attempts.join('\n  ')}`);
}

/**
 * 注入给模型的常驻指引。
 *
 * 放在系统提示里而不是只靠工具描述，因为「先申请再出界」是一条**纪律**，
 * 需要在整段对话里持续可见，而不只在模型恰好想起某个工具时才可见。
 * @param {string} root - 主工作区根。
 * @returns {string} 指引文本。
 */
function guidance(root) {
  return [
    '## 工作文件夹约定',
    '',
    `主工作区根是 \`${root}\`。开始实质工作前，先给本对话确定一个工作目录：`,
    '',
    '1. **判断这个任务属于哪个项目**，然后绑定到那个项目目录：',
    '   - 属于已有项目（如 `MinerU`、`PhO`、`Arcaea`）→',
    '     `workspace_bind({ target: "项目名" })`，直接绑到该目录。',
    '     不确定有哪些项目就先调 `workspace_projects` 看一眼。',
    '   - 是一次性任务、没有对应项目 → 不传 `target`，让插件自动建',
    '     `日期-标题` 目录；也可以用 `target` 指定一个新名字。',
    '   **只有在确实拿不准时**才问用户，不要默认新建空文件夹。',
    '2. 该工作目录**之外**的任何路径，在读写之前必须先调用 `workspace_access`',
    '   申请；用户会看到弹窗。批准是一次性的，被拒后不要重试。',
    '3. 主工作区的 `AGENTS.md` / `CLAUDE.md` 依然生效 —— 插件会把它们同步到',
    '   DSH 的全局指令位，因此工作目录里的会话照样读得到。',
    '   如需只对本对话生效的附加指令，在工作目录里放一个 `AGENTS.md` 即可，会叠加。',
    '4. 同一个项目目录会有多个对话先后使用，这是**正常**的：',
    '   新对话绑进去时，插件会自动归档已停止的老对话并把要点写成交接摘要。',
    '   所以不要为了「避免冲突」而给项目名加后缀。',
    '5. 任务确实交付完毕、短期内不会再继续时，可以调用 `workspace_archive`',
    '   征询是否归档本对话。用户会看到**带按钮的卡片**，点一下即可。',
    '   被拒绝后就不要再问。**任务进行中不要调用。**',
  ].join('\n');
}

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [rawConfig] - 用户配置。
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger;
  const binder = new FolderBinder({ ctx, config, logger });
  const journal = new Journal({ binder, config, logger });

  const disposers = [];
  let toolsReady;

  // ── 1. 工具面 ────────────────────────────────────────────────────
  toolsReady = loadDefineTool()
    .then((defineTool) => {
      disposers.push(...registerFolderTools({ ctx, config, binder, journal, defineTool }));
      logger?.debug?.('workspace-folders: tools registered');
    })
    .catch((error) => {
      logger?.error?.(`workspace-folders: failed to register tools: ${String(error?.message ?? error)}`);
    });

  // ── 2. 日志：每轮结束后写入本对话的子文件夹 ──────────────────────
  //
  // 只订阅 `turn/end`：DSH 在 agent-loop 的 finally 里**无条件**追加它，
  // 是唯一可靠的「这一轮真的结束了」信号（正常结束 / aborted / error
  // 三种收尾路径都会走到）。
  //
  // 签名 `(session, event)` 已对源码核实；`session/event` 在 dsh-scope 里
  // 的作用域键是 `null`（即全局事件），因此**不需要**也不应传 opt-in 选项 ——
  // DSH 所有内置插件都是裸调用 `ctx.on("session/event", (session, event) => …)`。
  const disposeEvents = ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return;
    try {
      const sessionId = session?.id;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;

      journal.schedule({
        sessionId,
        title: sessionTitleOf(ctx, session),
        readEvents: () => {
          // `Session` 没有 `events` 属性；必须用 `snapshotEvents()`。
          const snapshot = session.snapshotEvents?.();
          return Array.isArray(snapshot) ? snapshot : [];
        },
      });
    } catch (error) {
      // session/event 的监听器抛错会中断其它监听器；这里自己吞掉，
      // 保证不影响宿主的其它订阅者。
      logger?.warn?.(`workspace-folders: journal schedule failed: ${String(error?.message ?? error)}`);
    }
  });
  if (disposeEvents !== undefined) disposers.push(disposeEvents);

  // ── 3. 系统提示指引 ──────────────────────────────────────────────
  // 工作区根要异步解析，所以先占位、解析完再替换内容。
  //
  // ⚠️ 契约（读自 `dsh-system-prompt`）：字段是 **`name` / `order` / `text`**，
  //    不是 `id` / `content`。
  //    - `text` 可以是字符串，也可以是 `(context) => string` 的函数；
  //    - `order` 必须是**有限数字**，否则 `section()` 抛 TypeError；
  //    - `name` 重复会**抛错**（同 scope 内唯一）。
  let guidanceText = '';
  const promptDisposer = ctx.systemPrompt?.section?.({
    name: 'workspace-folders-guidance',
    order: 60,
    text: () => guidanceText,
  });
  if (promptDisposer !== undefined) disposers.push(promptDisposer);

  // ── 3b. 宿主路由：给浏览器侧的「项目选择器」供数据 ───────────────
  //
  // 客户端插件要在空对话页列出可绑定的项目，但它**不能直接调工具**，
  // 所以宿主这里开一个只读 GET 路由。
  //
  // ⚠️ 契约（读自 `dsh-host-webserver` + `dsh-host-open-in-app`）：
  //    - `ctx.webServer.register({ kind, path, handler })`，`kind` 是
  //      `'exact' | 'prefix'`，`path` 是**绝对路径且不带尾斜杠**；
  //    - 返回 disposer，必须挂到 `ctx.effect()` 或手动 dispose；
  //    - handler **自己负责整个响应生命周期**（含状态码与 end）。
  //
  // 安全性：复用 DSH 的 connection 信任围栏 —— 与内置插件同一套判定，
  // 非受信来源（Host/Origin 不匹配）直接拒绝，不泄露本机路径。
  installProjectRoute(ctx, { binder, logger, disposers });
  // 「点一下直接绑定」—— 浏览器 POST，宿主自己 bind，
  // 不依赖「能不能可靠操作受控输入框」。
  installBindRoute(ctx, { binder, logger, disposers });

  void binder.resolveWorkspaceRoot()
    .then(async (root) => {
      guidanceText = guidance(root);
      // 尽早同步指令 —— 这是子文件夹会话仍能读到主文件夹 prompt 的前提。
      const result = await binder.syncInstructions();
      if (result.status === 'mirrored') {
        logger?.info?.(`workspace-folders: ${result.detail}`);
      } else if (result.status === 'skipped-foreign' || result.status === 'error') {
        logger?.warn?.(`workspace-folders: instruction sync not applied: ${result.detail}`);
      }
    })
    .catch((error) => {
      logger?.error?.(`workspace-folders: cannot resolve workspace root: ${String(error?.message ?? error)}`);
    });

  // ── 3. 斜杠命令 ──────────────────────────────────────────────────
  //
  // ⚠️ DSH 的 `commands.register` 契约（读自 `dsh-commands` 源码）：
  //    - 字段是 **`handler`**，不是 `run`。写错会抛
  //      `command "x" handler must be a function`，**整个插件树加载失败**。
  //    - handler 返回 **`{ kind: 'success'|'error', text }`**，
  //      不是工具那套 `{ content: [...] }`。
  //    - `register` 是**同步**的，直接返回 disposer（不是 Promise）。
  //    - `description` 非空，`name` 需匹配 COMMAND_NAME 正则。
  const commandDisposers = [];
  commandDisposers.push(ctx.commands?.register?.({
    name: 'workspace-folders',
    description: '查看/管理当前对话的工作文件夹',
    async handler() {
      const root = await binder.resolveWorkspaceRoot();
      const inheritance = await binder.instructionInheritance();
      const rows = await binder.list();
      const lines = [
        '## 工作文件夹状态',
        '',
        '```',
        describeConfig(config, root),
        '```',
        '',
        inheritance.inherits
          ? '✓ 主文件夹的系统指令会被子文件夹会话继承。'
          : `⚠ 主文件夹指令**未**被子文件夹继承：\n${inheritance.detail}`,
        '',
        `已登记的对话文件夹（${rows.length} 个）：`,
        '',
      ];
      if (rows.length === 0) lines.push('（暂无）');
      for (const row of rows) lines.push(`- \`${row.folder}\`  ←  ${row.sessionId}`);
      return { kind: 'success', text: lines.join('\n') };
    },
  }));

  // `/workspace-archive` —— 主动归档当前对话的**可选**入口。
  //
  // 默认路径其实是「模型判断可以收了 → 弹带按钮的卡片 → 你点一下」，
  // 不需要打字。这条命令是给「我想现在就归档」的情形用的。
  //
  // 注意：这里**也要走审批**。不能因为是你主动敲的命令就免确认 ——
  // 敲错命令是常有的事，而归档当前对话会让界面跳回新会话页。
  if (config.archiveMode !== 'off') {
    commandDisposers.push(ctx.commands?.register?.({
      name: 'workspace-archive',
      description: '归档当前对话（从侧边栏隐藏，日志与内容全部保留）',
      async handler(invocation) {
        const sessionId = sessionIdOf(invocation);
        if (sessionId === undefined) {
          return {
            kind: 'error',
            text: '无法确定当前会话 id，归档命令只能在对话内的会话上下文中使用。',
          };
        }

        const result = await requestArchive({
          ctx,
          agent: invocation?.agent,
          sessionId,
          title: sessionTitleOf(ctx, invocation?.agent?.session),
          reason: '用户主动执行了 /workspace-archive。',
        });

        return { kind: result.archived ? 'success' : 'error', text: result.message };
      },
    }));
  }

  // ── 4. 暴露「会话 → 子文件夹」归属表，供客户端 ⑤ 使用 ────────────
  //
  // 客户端**不能**靠 cwd 判定同文件夹：cwd 是工作区根，本工作区 352 个
  // 会话的 cwd 完全相同。只有宿主知道每个会话绑在哪个子文件夹里，
  // 所以这里把登记表做成一个快照源交给客户端。
  const folderStore = createFolderStore(binder);
  try {
    ctx.provide('workspaceFolders', folderStore);
  } catch (error) {
    // 服务名被占用等情况：⑤ 会退化为「不判定」，不影响其它功能。
    logger.warn(`暴露 workspaceFolders 服务失败，⑤ 将不生效：${error?.message ?? error}`);
  }

  // ── 5. 卸载清理 ──────────────────────────────────────────────────
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose?.();
    for (const dispose of commandDisposers) dispose?.();
    binder.invalidate();
    void toolsReady;
  }, 'workspace-folders lifecycle');
}

/**
 * 造一个可被客户端读取的「会话 → 子文件夹」快照源。
 *
 * 形态刻意做得像 `SnapshotStore`（`getSnapshot()` + `subscribe()`），
 * 与 DSH 客户端既有的 `sessions.list` 一致，客户端无需特判。
 *
 * @param {object} binder - `FolderBinder` 实例。
 * @returns {object} 快照源。
 */
function createFolderStore(binder) {
  const listeners = new Set();
  let cache;

  const build = async () => {
    const registry = await binder.loadRegistry().catch(() => ({ sessions: {} }));
    const sessions = {};
    for (const [id, entry] of Object.entries(registry.sessions ?? {})) {
      if (typeof entry?.folder === 'string' && entry.folder.length > 0) {
        sessions[id] = entry.folder;
      }
    }
    return { sessions };
  };

  return {
    getSnapshot() {
      // 首次同步调用时缓存还没建好，返回空表 —— 客户端会走「不判定」分支，
      // 下次订阅回调时就有真数据了。宁可晚一拍，也不要返回错数据。
      if (cache === undefined) {
        void build().then((next) => {
          cache = next;
          for (const fn of listeners) fn();
        });
        return { sessions: {} };
      }
      return cache;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 绑定时由宿主主动刷新，让客户端立刻看到新归属。 */
    async refresh() {
      cache = await build();
      for (const fn of listeners) fn();
    },
  };
}

/**
 * 从斜杠命令的调用上下文里取会话 id。
 *
 * 容忍几种可能的挂载形态（`invocation.agent.session.id` /
 * `invocation.session.id` / `invocation.sessionId`），取不到返回 undefined。
 * 宁可明确失败，也不要猜错 id 去归档别的对话。
 * @param {object} invocation - 命令调用上下文。
 * @returns {string|undefined} 会话 id。
 */
function sessionIdOf(invocation) {
  const candidates = [
    invocation?.agent?.session?.id,
    invocation?.session?.id,
    invocation?.sessionId,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
