/**
 * dsh-workspace-folders-client —— 需求 ⑤ 的浏览器侧实现。
 *
 * ## 它解决什么
 *
 * 需求 ⑤：新对话发现同一工作文件夹里还有**未停止**的老对话时，
 * 应当**跳转到那一个，并归档自己**。
 *
 * 「归档自己」宿主侧就能做，但**跳转**只有浏览器侧能做 —— 导航是 UI 状态。
 *
 * ## 为什么客户端自己判定，而不是等宿主通知
 *
 * 我查过宿主→客户端的传递通道：官方机制是 `host.call(method, args)` +
 * 宿主半的 `harness.handle(...)`。但那是**沙箱插件**的路径，
 * 与本项目的静态插件不是同一套，硬套容易踩坑。
 *
 * 而客户端**本来就能自己判定** —— `SessionListState` 的每一行
 * （`SessionSummary`）都带 `cwd` 与 `running`：
 *
 * ```ts
 * export interface SessionSummary {
 *   readonly sessionId: SessionId;
 *   readonly updatedAt: number;
 *   readonly running: boolean;
 *   readonly blank: boolean;
 *   readonly cwd?: string;
 * }
 * ```
 *
 * 于是「同一个工作文件夹里、还活着的其他会话」在浏览器侧就能算出来，
 * 一个 API 都不用猜。
 *
 * ## 为什么「先归档自己再跳」是安全顺序（已核对源码）
 *
 * `dsh-client-ui-workspace` 的 `UiWorkspaceService` 有 `clearArchivedCurrent()`，
 * 类型注释写着：
 *
 * > Archive a Session **and clear it when it is the current selection**.
 *
 * 它是**响应式**的：发现「当前选中项已在归档集里」就 `sessions.clear()`。
 * 所以归档自己只会清空选择，随后 `openSession` 立刻接管；
 * 反而**先跳后归档**才会留下「跳过去了但自己还在列表里」的中间态。
 *
 * ## 怎么被加载
 *
 * 这个文件是**预构建的普通 JS**，由 `dsh-client-modules` 经
 * `/plugins/<id>/client.js` 直接伺服给浏览器，不需要重建 DSH 前端。
 * 外层 `window.__ModuleLoader__.load({...})` 是浏览器侧模块表的约定，
 * 照抄自 DSH 内置客户端插件（如 `dsh-client-ui-open-in-app`）。
 *
 * @module dsh-workspace-folders/client
 */

window.__ModuleLoader__.load({
  // ⚠️ 这个 id **必须精确等于 package.json 的 `name`**。
  //
  // `dsh-client-modules` 在装载 bundle 后会校验：
  // ```js
  // if (!this.factories.has(id)) throw new Error(
  //   `client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`);
  // ```
  // 其中 `id` 来自清单行的包名。写成别的名字（例如加 `-client` 后缀），
  // 浏览器就会**抛错并且拒绝装配**整个客户端半边。
  id: 'dsh-workspace-folders',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    /** 轮询间隔（毫秒）。只在检测到候选时才动作。 */
    const POLL_MS = 1500;

    /** 每次会话只让位一次，避免反复跳转。 */
    const yielded = new Set();

    /**
     * 归一化路径用于比较：统一分隔符、去掉尾部斜杠、Windows 下忽略大小写。
     * @param {string} value - 路径。
     * @returns {string} 归一化结果。
     */
    function normalizePath(value) {
      if (typeof value !== 'string') return '';
      let out = value.replace(/\\/g, '/').replace(/\/+$/, '');
      // Windows 路径大小写不敏感；其它平台保持原样。
      if (/^[a-zA-Z]:/.test(out)) out = out.toLowerCase();
      return out;
    }

    /**
     * 找出「同一工作子文件夹里、仍然活跃的其它会话」。
     *
     * ## ⚠️ 为什么不能只看 cwd
     *
     * `SessionSummary.cwd` 是**工作区根**（`D:\Wasio\Workspace`），
     * **不是**会话自己的子文件夹。实测：本工作区 352 个会话的 cwd
     * **完全相同**。所以「cwd 相同」只说明大家在同一个工作区，
     * 不说明在同一段任务里 —— 拿它当兄弟判定会一口气匹配 352 个，
     * 然后跳到其中一个毫不相关的对话，属于**危险误跳**。
     *
     * ## 真正的依据：宿主给出的子文件夹分组
     *
     * 宿主半（`src/binder.js` + `src/inherit.js`）本来就知道每个会话
     * 绑定在哪个子文件夹 —— 那份信息通过 `folderSessions` 传进来
     * （由宿主在启动/绑定时推给客户端）。
     *
     * @param {object} listState - `sessions.list` 快照。
     * @param {string} currentId - 当前会话 id。
     * @param {object} folderSessions - `{ [sessionId]: folderKey }` 映射。
     * @returns {Array<object>} 活跃的同文件夹会话（按 updatedAt 降序）。
     */
    function findLiveSiblings(listState, currentId, folderSessions) {
      const byId = listState?.byId ?? {};
      if (byId[currentId] === undefined) return [];

      // 没有子文件夹归属信息就**不判定** —— 宁可不动，也不误跳。
      // 这正是上一版只看 cwd 时踩的坑：匹配到一堆无关会话。
      const myFolder = folderSessions?.[currentId];
      if (typeof myFolder !== 'string' || myFolder.length === 0) return [];

      const others = [];
      for (const id of listState?.ids ?? []) {
        if (id === currentId) continue;
        const row = byId[id];
        if (row === undefined) continue;
        if (folderSessions[id] !== myFolder) continue;
        if (row.running !== true) continue;
        // 子代理不算「主对话」。
        if (row.origin === 'subagent' || row.parentSessionId !== undefined) continue;
        others.push(row);
      }
      return others.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    }

    /**
     * 执行一次让位：归档自己 → 跳到目标对话。
     *
     * @param {object} uiWorkspace - `uiWorkspace` 服务。
     * @param {string} selfId - 自己。
     * @param {string} targetId - 要跳过去的活跃对话。
     * @returns {Promise<boolean>} 是否完成跳转。
     */
    async function performYield(uiWorkspace, selfId, targetId) {
      try {
        // ★ 先归档自己：DSH 会自动清空当前选择，随后 openSession 接管。
        await uiWorkspace.archiveSession(selfId);
      } catch (error) {
        // 归档失败**不阻断跳转** —— 用户至少应被带到正确的对话。
        warn(`归档自身失败：${describeError(error)}`);
      }
      try {
        uiWorkspace.openSession(targetId);
        return true;
      } catch (error) {
        warn(`跳转失败：${describeError(error)}`);
        return false;
      }
    }

    /**
     * 把错误转成可读文本。
     * @param {unknown} error - 错误。
     * @returns {string} 文本。
     */
    function describeError(error) {
      if (error === null || error === undefined) return '未知错误';
      return String(error.message ?? error);
    }

    /**
     * 输出警告。刻意不弹窗 —— 这是后台自动动作，弹窗会打断用户。
     * @param {string} message - 消息。
     * @returns {void}
     */
    function warn(message) {
      // eslint-disable-next-line no-console
      console.warn(`[workspace-folders] ${message}`);
    }

    // ⚠️ 这里是**客户端 Cordis 的服务名**，不是包名。
    //
    // 两个 inject 是**两回事**，别再搞混（这是一次真实线上事故的根因）：
    //
    // | 位置 | 含义 | 取值 |
    // |---|---|---|
    // | `package.json` 的 `dsh.client.inject` | **模块依赖**（`require()` 能加载谁） | 包名 |
    // | 本模块的 `exports.inject` | **客户端服务依赖** | 客户端服务名 |
    //
    // 之前把 `workspaceFolders` 写进了这里 —— 那是**宿主半边自造的服务**，
    // 浏览器侧根本不存在（全树检索：DSH 里 `workspaceFolders` 出现 0 次）。
    // 后果是 Cordis 让插件**永远等待**该服务：
    //
    //     dsh-workspace-folders: pending (waiting for service: workspaceFolders)
    //
    // 整个客户端半边因此不激活，Web 启动还报
    // 「1 entry did not activate / Failed to load plugins」。
    //
    // 另外注意：声明了不存在的服务**不会**优雅降级 —— Cordis 是等待，
    // 不是跳过。所以这里只列真实存在的客户端服务。
    const inject = ['uiWorkspace', 'sessions', 'slots'];

    /**
     * 客户端插件主体。
     * @param {object} ctx - 客户端根上下文。
     * @returns {void}
     */
    function apply(ctx) {
      // ① 先挂 UI —— 它与让位逻辑彼此独立，UI 失败不该拖累 ⑤。
      //    （早期版本没有 `dsh.client` 声明，浏览器根本不加载本文件，
      //      所以「选择器」和「自动让位」从来都没生效过。）
      try {
        registerPicker(ctx);
      } catch (error) {
        warn(`注册项目选择器失败（不影响其它功能）：${describeError(error)}`);
      }

      const uiWorkspace = ctx.uiWorkspace;
      const sessions = ctx.sessions;

      // ⚠️ `workspaceFolders` **不是客户端服务**（宿主半自造，浏览器侧不存在）。
      //    所以**绝不能**写 `ctx.workspaceFolders` —— Cordis 对未声明的属性访问
      //    会直接抛 `cannot get property "workspaceFolders" without inject`，
      //    而那会把整个 apply 打断，连 ⑤ 一起废掉。
      //
      //    这里用 try + Reflect 兜底：拿不到就退化为 undefined，
      //    `findLiveSiblings` 见到 undefined 会**放弃判定**（宁可不动也不误跳）。
      //    将来若宿主真的把归属表接到了客户端，这条路会自动生效。
      const folders = (() => {
        try {
          return Reflect.get(ctx, 'workspaceFolders');
        } catch {
          return undefined;
        }
      })();

      // 拿不到任一服务就静默待命（例如某些只读页面没有导航能力）。
      if (uiWorkspace === undefined || sessions === undefined) return;
      if (typeof uiWorkspace.openSession !== 'function'
        || typeof uiWorkspace.archiveSession !== 'function') return;

      /**
       * 取「会话 → 子文件夹」归属表。
       *
       * 这是 ⑤ 判定的**唯一可靠依据**（cwd 是工作区根，区分不出子文件夹）。
       * 拿不到就返回 undefined，让 `findLiveSiblings` 直接放弃判定。
       * @returns {object|undefined} 映射表。
       */
      const folderMap = () => {
        try {
          return folders?.getSnapshot?.()?.sessions;
        } catch (error) {
          warn(`读取子文件夹归属失败：${describeError(error)}`);
          return undefined;
        }
      };

      /**
       * 一次检查：自己所在文件夹里有没有活跃的老对话？
       * @returns {void}
       */
      const tick = () => {
        try {
          const state = sessions.list?.getSnapshot?.();
          const selfId = state?.current;
          if (typeof selfId !== 'string') return;
          if (yielded.has(selfId)) return;

          const live = findLiveSiblings(state, selfId, folderMap());
          if (live.length === 0) return;
          // 只在这里标记，避免 await 期间重复触发。
          yielded.add(selfId);
          void performYield(uiWorkspace, selfId, live[0].sessionId);
        } catch (error) {
          warn(`检查失败：${describeError(error)}`);
        }
      };

      // 用 requestAnimationFrame 链而非 setInterval：DSH 的沙箱会拦截
      // 定时器全局（见 cordis-client-runner 的 closureTraps），
      // 但静态插件不受此限。这里仍倾向用 effect + 订阅，最省资源。
      const subscribe = resolveSubscribe(sessions);
      if (subscribe !== undefined) {
        ctx.effect(
          () => subscribe(() => tick()),
          'workspace-folders: yield watcher',
        );
      } else {
        // 退路：没有订阅能力时用 interval，仍在 effect 里以便卸载时清理。
        ctx.effect(() => {
          const timer = setInterval(tick, POLL_MS);
          return () => clearInterval(timer);
        }, 'workspace-folders: yield poller');
      }

      // 立即跑一次：会话可能是带着已存在的活跃兄弟恢复的。
      tick();

      // 手动入口，便于排查：控制台调 __workspaceFoldersYieldCheck()
      try {
        globalThis.__workspaceFoldersYieldCheck = () => tick();
        globalThis.__workspaceFoldersYieldState = () => {
          const state = sessions.list?.getSnapshot?.();
          return {
            current: state?.current,
            live: findLiveSiblings(state, state?.current),
            yielded: [...yielded],
          };
        };
      } catch {
        // 全局被冻结等情形 —— 手动入口只是便利，失败不影响主功能。
      }
    }

    /**
     * 订阅会话列表变化。
     *
     * 用法与 DSH 内置客户端插件完全一致（已核对其源码）：
     * ```js
     * const state = scope.sessions.list.getSnapshot();
     * const stop = scope.sessions.list.subscribe(() => { ... });
     * ```
     * 拿不到 `subscribe` 就返回 undefined，让调用方走轮询退路。
     * @param {object} sessions - 客户端 sessions 服务。
     * @returns {Function|undefined} 订阅函数（返回取消订阅函数）。
     */
    function resolveSubscribe(sessions) {
      const store = sessions?.list;
      if (typeof store?.subscribe !== 'function') return undefined;
      return (listener) => store.subscribe(listener);
    }

    // ── 新建对话时的「项目选择器」────────────────────────────────
    //
    // 组件实现就在本文件的 `createPickerComponent`。这里只负责挂进插槽。
    //
    // ⚠️ 挂载位置经过刻意选择：
    //    `conversation.hero.workspace` 是 DSH 自己「选择工作区」所在的插槽，
    //    而它 `kind: 'single'` —— **往里注册会把原生选择器挤掉**。
    //    所以改挂 `conversation.input.dock`（输入框上方的整行插槽），
    //    与内置 UI 并存而不是取代它。

    /** 项目清单路由（与宿主半 `src/route.js` 的 PROJECTS_ROUTE 必须一致）。 */
    const PROJECTS_ROUTE = '/workspace-folders/projects';

    /**
     * 拉取可绑定项目清单**以及本会话当前的绑定状态**。
     *
     * ★ 必须带上 `sessionId`。不带的话宿主无从知道「**这个**会话绑到哪了」，
     *   于是 UI 永远只显示「绑定到项目：…」按钮 —— 这正是用户报的
     *   「重新打开对话还是会弹出绑定到项目」。
     *
     * @param {string} [sessionId] - 当前会话 id。
     * @returns {Promise<{projects: Array<object>, current: object|null}>} 清单与当前绑定。
     */
    async function fetchProjects(sessionId) {
      const url = typeof sessionId === 'string' && sessionId.length > 0
        ? `${PROJECTS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`
        : PROJECTS_ROUTE;
      const res = await globalThis.fetch(url, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return {
        projects: Array.isArray(data?.projects) ? data.projects : [],
        current: data?.current ?? null,
      };
    }

    /** 直接绑定路由（与宿主半 `src/route.js` 的 BIND_ROUTE 必须一致）。 */
    const BIND_ROUTE = '/workspace-folders/bind';

    /**
     * 直接让宿主完成绑定（不经过输入框）。
     * @param {object} params - 入参。
     * @param {string} params.sessionId - 当前会话 id。
     * @param {string} params.target - 项目目录名。
     * @returns {Promise<{ok: boolean, folder?: string, error?: string}>} 结果。
     */
    async function bindProject({ sessionId, target }) {
      const res = await globalThis.fetch(BIND_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sessionId, target }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    /**
     * 从 sessions 服务里取当前会话 id。
     *
     * 这是**回退路径**：正常应当从插槽 props 拿到 `sessionId`。
     * 拿不到就返回 undefined，让调用方报错而不是猜 —— 绑错会话比不绑更糟。
     * @returns {string|undefined} 会话 id。
     */
    function currentSessionId() {
      try {
        return globalThis.__DSH_SESSION_ID__ ?? undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * 造「项目选择条」组件。
     *
     * ## 为什么内联在这里，而不是 `require('./picker.js')`
     *
     * 客户端的 `require` **不是文件系统解析**。它只在三处找：
     *
     * ```js
     * makeRequire() {
     *   return (spec) => {
     *     if (this.seed.has(spec)) return this.seed.get(spec);       // ① 平台种子
     *     const record = this.loadCache.get(id); if (record) ...      // ② 已物化
     *     if (this.factories.has(id)) ...                            // ③ 已注册的**包**工厂
     *     throw new Error(`require("${spec}") missed the module table ...`);
     *   };
     * }
     * ```
     *
     * `id` 由 `stripClientSuffix(spec)` 得到 —— 那是**包名**。
     * 相对路径 `./picker.js` 三者都不是，**必然抛错**。
     * 所以客户端半边必须是**自包含的单文件 bundle**，
     * 共享代码靠构建期内联，不能靠运行时 require。
     *
     * @param {object} react - React 实现。
     * @param {Function} listProjects - 取项目清单。
     * @param {Function} bindProject - 直接绑定（POST 给宿主）。
     * @returns {Function} React 组件。
     */
    function createPickerComponent(react, listProjects, bindProject) {
      /**
       * 「正在新建」的占位标记。
       *
       * `busy` 状态复用了「正在绑定的项目名」，但新建时还**没有**项目名，
       * 所以需要一个不可能与真实目录名冲突的标记（目录名过 slugify，
       * 不可能含 `+`）。
       */
      const NEW_MARKER = '+new+';

      return function WorkspacePickerDock(props) {
        // status: idle | loading | ready | error
        // `boundTo` 为字符串时表示**已绑定** —— 它来自宿主的回答，
        // 不是本地记忆，所以重新打开对话也认得出来。
        const [state, setState] = react.useState({
          status: 'idle', projects: [], boundTo: null,
        });
        const [expanded, setExpanded] = react.useState(false);
        // 正在绑定的项目名（防重复点击 + 禁用态）。
        const [busy, setBusy] = react.useState(null);
        // 「换绑」时才展开；已绑定时默认收起成一行。
        const [rebinding, setRebinding] = react.useState(false);
        // 「新建工作文件夹」的展开态与输入内容。
        const [creating, setCreating] = react.useState(false);
        const [draft, setDraft] = react.useState('');

        // ★ 会话 id 从插槽 props 里拿。
        //
        // `conversation.input.dock` 是 `scope: 'session'`，渲染器会把
        // 作用域 key（会话 id）作为标准 props 传下来。先试常见字段名，
        // 拿不到就回退到 sessions 服务的 current —— **绝不猜**：
        // 绑错会话比不绑更糟。
        const sessionId = props?.sessionId
          ?? props?.session?.id
          ?? props?.scopeKey
          ?? currentSessionId();

        /**
         * 拉一次状态（清单 + 当前绑定）。
         *
         * ★ 每次挂载都重新问宿主。**不能缓存到本地状态里当权威** ——
         *   那样「重新打开对话」就会丢掉绑定信息，又弹一次选择条。
         * @returns {void}
         */
        const load = react.useCallback?.(() => {
          let cancelled = false;
          setState((prev) => ({ ...prev, status: 'loading' }));
          Promise.resolve()
            .then(() => listProjects(sessionId))
            .then((data) => {
              if (cancelled) return;
              setState({
                status: 'ready',
                projects: Array.isArray(data?.projects) ? data.projects : [],
                boundTo: data?.current?.folder ?? null,
              });
            })
            .catch((error) => {
              if (cancelled) return;
              setState({
                status: 'error', projects: [], boundTo: null, error: describeError(error),
              });
            });
          return () => { cancelled = true; };
        }, [sessionId]) ?? (() => {});

        react.useEffect(() => {
          const cancel = load();
          return typeof cancel === 'function' ? cancel : undefined;
        }, []);

        /**
         * 点某个项目 → **直接绑定**。
         *
         * 不再往输入框填指令：那既多一步，又依赖「能可靠操作
         * React 受控输入框」这个很脆的前提。现在直接 POST 给宿主。
         * @param {string} name - 项目目录名。
         * @returns {void}
         */
        const pick = (name) => {
          if (busy !== null) return;
          if (typeof sessionId !== 'string' || sessionId === '') {
            setState((prev) => ({ ...prev, status: 'error', error: '拿不到当前会话 id' }));
            return;
          }
          setBusy(name);
          Promise.resolve()
            .then(() => bindProject({ sessionId, target: name }))
            .then((result) => {
              setBusy(null);
              if (result?.ok !== true) {
                setState((prev) => ({
                  ...prev, status: 'error', error: String(result?.error ?? '绑定失败'),
                }));
                return;
              }
              // 绑定成功 → 记下「已绑到哪」，并**收起选择条**。
              // 这个状态现在与宿主的回答同源，所以重开对话也一致。
              setRebinding(false);
              setState((prev) => ({
                ...prev, status: 'ready', boundTo: result.folder ?? name,
              }));
            })
            .catch((error) => {
              setBusy(null);
              setState((prev) => ({ ...prev, status: 'error', error: describeError(error) }));
            });
        };

        /** 打开「新建」输入框。 */
        const openCreator = () => { setCreating(true); setDraft(''); };
        /** 收起「新建」输入框（丢弃已输入内容）。 */
        const closeCreator = () => { setCreating(false); setDraft(''); };

        /**
         * 提交「新建并绑定」。
         *
         * 与点项目按钮走**同一个接口** —— 宿主的 `/bind` 在目标目录不存在时
         * 会直接创建（返回 `created: true`）。所以这里不需要新的路由，
         * 只是把「用户输入的名字」当作 target 传过去。
         * @returns {void}
         */
        const submitNew = () => {
          const name = draft.trim();
          if (busy !== null || name === '') return;
          if (typeof sessionId !== 'string' || sessionId === '') {
            setState((prev) => ({ ...prev, status: 'error', error: '拿不到当前会话 id' }));
            return;
          }
          // 用一个不会与真实项目名冲突的占位符表示"正在创建"。
          setBusy(NEW_MARKER);
          Promise.resolve()
            .then(() => bindProject({ sessionId, target: name }))
            .then((result) => {
              setBusy(null);
              if (result?.ok !== true) {
                setState((prev) => ({
                  ...prev, status: 'error', error: String(result?.error ?? '创建失败'),
                }));
                return;
              }
              setCreating(false);
              setDraft('');
              setRebinding(false);
              setState((prev) => ({
                ...prev, status: 'ready', boundTo: result.folder ?? name,
              }));
            })
            .catch((error) => {
              setBusy(null);
              setState((prev) => ({ ...prev, status: 'error', error: describeError(error) }));
            });
        };

        if (state.status === 'idle' || state.status === 'loading') return null;

        if (state.status === 'error') {
          return react.createElement('div', { style: PICKER_STYLE.bar },
            react.createElement('span', { style: PICKER_STYLE.error },
              `工作文件夹：${state.error ?? '未知错误'}`),
            react.createElement('button', {
              type: 'button',
              style: PICKER_STYLE.more,
              // 重试要**重新问宿主**（顺带把 sessionId 再取一次），
              // 而不是仅把状态倒回 idle —— 那会丢掉当前绑定信息。
              onClick: () => load(),
            }, '重试'));
        }

        const projects = state.projects;
        if (projects.length === 0) return null;

        // ── ★ 已绑定 → 默认**收起成一行**，不再追问 ────────────────
        //
        // 用户报的两个症状都出在这里：
        //   「重新打开对话还是会弹出绑定到项目」
        //   「绑定成功会一直留存直到切出」
        //
        // 现在 `boundTo` 来自**宿主的回答**（每次挂载都重新问），
        // 所以重开对话照样认得；并且绑好后立刻收起，只留一行状态 +
        // 一个「换绑」按钮，不再占地方。
        if (state.boundTo !== null && !rebinding) {
          return react.createElement('div', { style: PICKER_STYLE.bar },
            react.createElement('span', { style: PICKER_STYLE.ok },
              `✓ 已绑定到 ${state.boundTo}`),
            react.createElement('button', {
              type: 'button',
              style: PICKER_STYLE.more,
              onClick: () => setRebinding(true),
            }, '换绑'));
        }

        // 折叠时只显示前 6 个，其余收进「更多」。
        const LIMIT = 6;
        const shown = expanded ? projects : projects.slice(0, LIMIT);
        const hidden = projects.length - shown.length;

        const children = [
          react.createElement('span', { key: '__label', style: PICKER_STYLE.label },
            state.boundTo !== null ? '换绑到：' : '绑定到项目：'),
          // ── ★ 每个项目一个按钮：占用状态用**视觉**表达，不再拼 `·1` ──
          //
          // 早期是 `${p.name} ·${p.sessions}` → `MinerU ·1`。
          // 用户评价：「现在这个 **1 太丑了**」。确实：
          //   - 绑定的目录**必然** ≥1 个会话，数字几乎恒为 1，没有信息量；
          //   - 真正该一眼看出的「**有人占着**」，文字后缀反而弱。
          // 现在改成：小圆点标记 + 实心底色，数字挪进 tooltip。
          ...shown.map((p) => {
            const busyHere = busy === p.name;
            const style = busyHere
              ? PICKER_STYLE.chipBusy
              : (p.bound ? PICKER_STYLE.chipUsed : PICKER_STYLE.chip);
            const label = busyHere ? `${p.name} …` : p.name;
            return react.createElement('button', {
              key: p.name,
              type: 'button',
              style,
              disabled: busy !== null,
              // 具体数字放在 tooltip —— 想细看的人能拿到，
              // 不想看的人不会被数字干扰。
              title: p.bound
                ? `${p.name}：已有 ${p.sessions} 个对话在用`
                : `${p.name}：尚未使用`,
              'aria-label': p.bound
                ? `${p.name}（已有 ${p.sessions} 个对话在用）`
                : p.name,
              onClick: () => pick(p.name),
            },
            // 占用标记：小圆点。`busy` 时不画（它在转圈态里是噪声）。
            p.bound && !busyHere
              ? react.createElement('span', { key: '__dot', style: PICKER_STYLE.dot })
              : null,
            label);
          }),
          hidden > 0
            ? react.createElement('button', {
              key: '__more',
              type: 'button',
              style: PICKER_STYLE.more,
              disabled: busy !== null,
              onClick: () => setExpanded(true),
            }, `+${hidden} 更多`)
            : null,
          // 换绑时给一条退路，免得展开后收不回去。
          state.boundTo !== null
            ? react.createElement('button', {
              key: '__cancel',
              type: 'button',
              style: PICKER_STYLE.more,
              disabled: busy !== null,
              onClick: () => setRebinding(false),
            }, '取消')
            : null,
        ];

        // ── ★★★ 「新建工作文件夹」：**单独一行**，与项目按钮明显区分 ──
        //
        // 用户三点要求，逐条落实：
        //   ① 「不要跟其他的放一起」 → 独立成一个 `div`，**另起一行**；
        //   ② 「ui 要做出区别」 → 虚线边框 + 强调色 + `＋` 图标，
        //      与项目按钮的"胶囊"形状**完全不同**；
        //   ③ 「输入框不要像原来那么小」 → 展开后**占满整行**的大输入框
        //      （14px 字号、8px 内边距），而不是塞在胶囊里的小框。
        const creatorRow = react.createElement('div', { key: '__creator', style: PICKER_STYLE.creatorRow },
          creating
            ? [
              react.createElement('input', {
                key: '__input',
                type: 'text',
                value: draft,
                placeholder: '新文件夹名称（只保留英文字母、数字、连字符）',
                'aria-label': '新文件夹名称',
                autoFocus: true,
                disabled: busy !== null,
                style: PICKER_STYLE.creatorInput,
                onChange: (e) => setDraft(e.target.value),
                // 回车即提交，不用去点按钮。
                onKeyDown: (e) => {
                  if (e.key === 'Enter') { e.preventDefault(); submitNew(); }
                  if (e.key === 'Escape') { e.preventDefault(); closeCreator(); }
                },
              }),
              react.createElement('div', { key: '__btns', style: PICKER_STYLE.creatorButtons },
                react.createElement('button', {
                  key: '__go',
                  type: 'button',
                  style: busy === NEW_MARKER ? PICKER_STYLE.creatorGoBusy : PICKER_STYLE.creatorGo,
                  disabled: busy !== null || draft.trim() === '',
                  onClick: () => submitNew(),
                }, busy === NEW_MARKER ? '创建中…' : '创建'),
                react.createElement('button', {
                  key: '__cancel2',
                  type: 'button',
                  style: PICKER_STYLE.more,
                  disabled: busy !== null,
                  onClick: () => closeCreator(),
                }, '取消')),
            ]
            : react.createElement('button', {
              key: '__open',
              type: 'button',
              style: PICKER_STYLE.creatorOpen,
              disabled: busy !== null,
              title: '在当前工作区下新建一个文件夹，并把这个对话绑到那里',
              onClick: () => openCreator(),
            }, '＋ 新建工作文件夹'));

        // 用 `display:contents` 让这一行**自成一行**，
        // 同时仍然依附于父级 flex 布局（`bar` 是 `flex-wrap: wrap`）。
        return react.createElement('div', { style: PICKER_STYLE.bar }, ...[
          ...children,
          react.createElement('div', { key: '__sep', style: PICKER_STYLE.creatorSep }),
          creatorRow,
        ]);
      };
    }

    /**
     * 选择器内联样式：不依赖宿主主题变量名（那些不是公开契约）。
     *
     * ## ★ 为什么必须自己写 `width` / `max-width` / `margin:0 auto`
     *
     * `conversation.input.dock` 的**插槽出口是布局透明的** ——
     * 渲染器这样包条目：
     *
     * ```js
     * const ANCHOR_STYLE = { display: "contents" };
     * <div data-slot={slotKey} style={ANCHOR_STYLE}>{...entries}</div>
     * ```
     *
     * `display: contents` 意味着**外层 div 不参与布局**，我们的元素
     * 变成 `.composerStack`（`display:flex; flex-direction:column`）的
     * **直接 flex 子项**。而那个容器只有 `gap` 和方向，**没有宽度上限、
     * 也没有水平居中**。
     *
     * 同插槽里的原生「队列」条（QueueDock）看起来正常，是因为它**自带**
     * 一个 CSS module 类自己约束几何：
     * ```css
     * ._7yHdaG_dock{
     *   width:calc(100% - 2*var(--dsh-composer-side-clearance) - 2*var(--dsh-composer-dock-inset));
     *   max-width:calc(var(--dsh-composer-card-max-width) - 2*var(--dsh-composer-dock-inset));
     *   margin:0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px);
     *   padding:0 var(--dsh-composer-dock-inset);
     * }
     * ```
     *
     * 我早先没写这些，于是元素**撑满整行并贴到左边缘** ——
     * 也就是用户看到的「左边凸出来一块」。修法就是把这套几何抄过来
     * （用同一组变量，所以会随宿主的主题/宽度设置一起变）。
     *
     * ⚠️ 刻意**不设** `pointerEvents`：任何 `pointer-events:none`
     *    都会让按钮「画得出来但点不动」。
     */
    const PICKER_STYLE = Object.freeze({
      bar: {
        // ↓ 这套几何与原生 QueueDock 对齐，保证左边不再凸出。
        boxSizing: 'border-box',
        width: 'calc(100% - var(--dsh-composer-side-clearance, 16px)'
          + ' - var(--dsh-composer-side-clearance, 16px)'
          + ' - var(--dsh-composer-dock-inset, 8px)'
          + ' - var(--dsh-composer-dock-inset, 8px))',
        maxWidth: 'calc(var(--dsh-composer-card-max-width, 100%)'
          + ' - var(--dsh-composer-dock-inset, 8px)'
          + ' - var(--dsh-composer-dock-inset, 8px))',
        margin: '0 auto calc(0px - var(--dsh-composer-stack-gap, 6px) - 3px)',
        // 横向内缩交给 padding；纵向留一点，让按钮不贴着队列条。
        padding: '4px var(--dsh-composer-dock-inset, 8px)',
        flex: 'none',
        // ↓ 内部仍是横向换行的一行按钮。
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px',
        fontSize: '12px',
        lineHeight: '1.6',
      },
      label: { opacity: 0.65, marginRight: '2px' },

      /**
       * 未使用的项目：**描边**（空心）。
       *
       * ★ 用「空心 / 实心」这一对视觉差异表达「已被占用」，
       *   而不是在文字后面拼一个 `·1`。
       *
       *   用户原话：「那些已被占用的目录按钮显示个颜色啥的，或者更深一点，
       *   现在这个 **1 太丑了**」——
       *   `MinerU ·1` 里的 `1` 既丑又没信息量：
       *   绑定的目录**必然**至少 1 个会话，这个数字几乎恒为 1，
       *   而真正需要一眼看出的「**有人占着**」它反而没表达出来。
       *
       *   ⚠️ 两个样式除颜色深浅外**必须结构一致**（同样的
       *   `border` 宽度、`padding`、`borderRadius`），否则两种按钮
       *   高度不同，一行里会**参差不齐**。
       */
      chip: {
        border: '1px solid rgba(127,127,127,0.35)',
        borderRadius: '999px',
        background: 'transparent',
        color: 'inherit',
        padding: '2px 10px',
        fontSize: '12px',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
      },

      /**
       * 已被占用的项目：**实心 + 更深的底色**。
       *
       * ## ★ 为什么不用 `color-mix()`
       *
       * `color-mix(in srgb, currentColor 14%, transparent)` 是最直观的写法，
       * 但它**较新**（Chrome 111+）。一旦宿主浏览器不支持，整条声明会被
       * **静默丢弃** —— 已占用和未占用就长得**一模一样**，
       * 这个功能等于没做，而且**不报错**。
       *
       * 改用 `linear-gradient` 叠 `currentColor` 的低透明度：
       * 所有浏览器都支持，效果等价，且同样**自动跟随主题前景色**
       * （浅色主题下压深、深色主题下提亮），不必猜宿主的主题变量名 ——
       * 那些不是公开契约。
       */
      chipUsed: {
        // ⚠️ `border` 必须与 `chip` **逐字一致** —— 只有底色不同。
        //    否则边框宽度/颜色一变，两种按钮的视觉重量就不一致了。
        border: '1px solid rgba(127,127,127,0.35)',
        borderRadius: '999px',
        // 已占用 = **实心**：中性灰底。
        //
        // ⚠️ 这里刻意**不用** `color-mix(in srgb, currentColor …)`，
        //    尽管它是最"正确"的写法：它较新（Chrome 111+），一旦不被支持
        //    整条声明会被**静默丢弃**，已占用与未占用长得**一模一样** ——
        //    功能等于没做，而且不报错。
        //
        // 改用中性灰 + 透明度：所有浏览器都支持，且因为宿主 UI 本身就是
        // 中性色系，浅色主题下它是"更深的灰"、深色主题下是"更亮的灰"，
        // 两种主题下都表现为**与背景不同的实心块**。
        background: 'rgba(127,127,127,0.22)',
        color: 'inherit',
        padding: '2px 10px',
        fontSize: '12px',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
      },

      /** 占用标记：一个小实心圆点。比 `·1` 干净，而且一眼能看出"有人"。 */
      dot: {
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        // 半透明的 currentColor：既不抢眼，又比纯描边明显。
        background: 'currentColor',
        opacity: 0.55,
        flex: 'none',
      },
      chipBusy: {
        border: '1px solid rgba(127,127,127,0.35)',
        borderRadius: '999px',
        background: 'rgba(127,127,127,0.15)',
        color: 'inherit',
        padding: '2px 10px',
        fontSize: '12px',
        cursor: 'progress',
        opacity: 0.7,
        // ⚠️ 必须和 chip / chipUsed 同结构，否则点击瞬间按钮会**跳高**。
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
      },
      more: {
        border: '1px dashed rgba(127,127,127,0.45)',
        borderRadius: '999px',
        background: 'transparent',
        color: 'inherit',
        padding: '2px 10px',
        fontSize: '12px',
        cursor: 'pointer',
        opacity: 0.8,
      },
      ok: { color: 'inherit', opacity: 0.85 },
      error: { color: '#d9534f' },

      // ── 「新建工作文件夹」的样式 ──────────────────────────────────
      //
      // 用户三点要求：①「不要跟其他的放一起」②「ui 要做出区别」
      // ③「输入框不要像原来那么小」。对应下面四组样式。

      /** 分隔线：`flex-basis:100%` 强制换行，让新建入口**自成一行**。 */
      creatorSep: {
        flexBasis: '100%',
        height: '1px',
        margin: '4px 0 2px',
        background: 'rgba(127,127,127,0.25)',
      },

      /** 新建入口所在行：**占满一行**。 */
      creatorRow: {
        flexBasis: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },

      /**
       * 折叠态的「＋ 新建工作文件夹」按钮。
       *
       * ★ 与项目按钮的"胶囊"形状**刻意不同**：方形圆角 + 虚线边框 +
       *   `＋` 前缀。用户要求「ui 要做出区别」—— 形状差异比颜色差异
       *   更能一眼分辨，而且不依赖主题色。
       */
      creatorOpen: {
        border: '1px dashed rgba(127,127,127,0.55)',
        borderRadius: '8px',
        background: 'transparent',
        color: 'inherit',
        padding: '5px 12px',
        fontSize: '12px',
        cursor: 'pointer',
        textAlign: 'left',
        opacity: 0.9,
      },

      /**
       * 展开后的输入框 —— **占满整行**。
       *
       * 用户原话：「输入框不要像原来那么小」。
       * 所以：宽度 100%、14px 字号、8px 内边距，是真的能舒服打字的框，
       * 而不是塞在胶囊里的小格子。
       */
      creatorInput: {
        boxSizing: 'border-box',
        width: '100%',
        border: '1px solid rgba(127,127,127,0.5)',
        borderRadius: '8px',
        background: 'rgba(127,127,127,0.08)',
        color: 'inherit',
        padding: '8px 12px',
        fontSize: '14px',
        fontFamily: 'inherit',
        outline: 'none',
      },

      /** 输入框下方的按钮排。 */
      creatorButtons: {
        display: 'flex',
        gap: '6px',
      },

      /** 「创建」主按钮：**实心强调**，与取消区分主次。 */
      creatorGo: {
        border: '1px solid rgba(127,127,127,0.5)',
        borderRadius: '8px',
        background: 'rgba(127,127,127,0.28)',
        color: 'inherit',
        padding: '5px 16px',
        fontSize: '12px',
        cursor: 'pointer',
      },

      creatorGoBusy: {
        border: '1px solid rgba(127,127,127,0.4)',
        borderRadius: '8px',
        background: 'rgba(127,127,127,0.18)',
        color: 'inherit',
        padding: '5px 16px',
        fontSize: '12px',
        cursor: 'progress',
        opacity: 0.7,
      },
    });

    /**
     * 注册项目选择器到插槽。
     * @param {object} ctx - 客户端上下文。
     * @returns {boolean} 是否注册成功。
     */
    function registerPicker(ctx) {
      const slots = ctx?.slots;
      if (slots === undefined || typeof slots.inject !== 'function') return false;

      let react;
      try {
        // `react` 是平台种子（seed word），可安全 require。
        react = require('react');
      } catch {
        return false; // 没有 React 就不画 UI，主功能不受影响。
      }

      const Component = createPickerComponent(react, fetchProjects, bindProject);

      const COMPONENT_NAME = 'conversation.input.dock';

      // ⚠️ 直接调用 `slots.inject`，**不要**再包一层 `ctx.effect`。
      //
      // `SlotRegistry.prototype.register` 内部已经是
      // `return this.ctx.effect(() => this._register(...), "slots.register()")`
      // —— 注册本身自带 fiber 生命周期。外面再包一层不仅多余，
      // 还让「eager 注册」推迟到 effect 真正执行时，而
      // `slots.inject` 在插槽**已声明**时是**同步**跑回调的，
      // 时机会因此错开。内置插件（goal / queue / workspace）
      // 一律是直接调用的写法。
      slots.inject(COMPONENT_NAME, () => slots.register({
        name: COMPONENT_NAME,
        id: 'workspace-folders-picker',
        order: 50,
        // 不需要额外 props。返回空对象即可（内置插件也用这个形状）。
        // ⚠️ 这里**不要**写 `locale` —— 那会要求 locale 面存在，
        //    且我们没有用到 `t`。
      }, Component));

      return true;
    }

    exports.apply = apply;
    exports.inject = inject;
    // 暴露给测试：纯函数部分可独立验证，不需要真实浏览器。
    exports.__test = {
      findLiveSiblings,
      normalizePath,
      fetchProjects,
      bindProject,
      currentSessionId,
      registerPicker,
      createPickerComponent,
      PROJECTS_ROUTE,
      BIND_ROUTE,
    };
    return module.exports;
  },
});
