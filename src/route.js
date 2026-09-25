/**
 * 宿主侧只读路由：把「可绑定的项目清单」交给浏览器侧的 UI。
 *
 * ## 为什么需要它
 *
 * 客户端插件要在**空对话页**画出项目按钮，但它跑在浏览器里，
 * 既读不了磁盘，也调不了宿主的工具。所以宿主开一个小路由给它。
 *
 * ## 契约（逐条读自真实源码）
 *
 * - `ctx.webServer.register({ kind, path, handler })`
 *   - `kind`: `'exact' | 'prefix'`（`dsh-host-webserver` 的 `WebRouteKind`）；
 *   - `path`: **绝对路径，不带尾斜杠**；
 *   - `handler(req, res)`: **自己负责整个响应生命周期**，返回值可为 Promise；
 *   - 返回一个 disposer。
 * - `ctx.connection.requestRejection(req)`: 返回 `401 | 403 | undefined`。
 *   这是 DSH 自己的 Host/Origin 信任围栏 + 浏览器登录凭据校验
 *   （`dsh-host-open-in-app` 用的就是同一套，注释明确写了它防 DNS rebinding）。
 *
 * ## 安全设计：fail-closed
 *
 * 拿不到 `connection` 服务时**不注册路由**，而不是「先裸奔着」。
 * 一个会吐本机目录结构的接口，宁可不提供，也不能无保护地开出去。
 *
 * @module dsh-workspace-folders/src/route
 */

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';

import { listBindableProjects, isSafeSegment, normalizeUserFolderName } from './naming.js';

/** 项目清单路由。绝对路径、无尾斜杠。 */
export const PROJECTS_ROUTE = '/workspace-folders/projects';

/** 绑定路由：点一下按钮就绑，不用把指令填进输入框再发送。 */
export const BIND_ROUTE = '/workspace-folders/bind';

/** 请求体上限。这个接口只收一个目录名，超过就是恶意。 */
const MAX_BODY_BYTES = 8 * 1024;

/** 响应上限：只发名字与计数，不需要更多。 */
const MAX_PROJECTS = 200;

/**
 * 读取 connection 服务（用 Reflect 避免未注入时的属性访问报错）。
 * @param {object} ctx - Cordis 上下文。
 * @returns {object|undefined} connection 服务。
 */
function connectionOf(ctx) {
  try {
    return Reflect.get(ctx, 'connection');
  } catch {
    return undefined;
  }
}

/**
 * 发送 JSON 响应。
 *
 * `no-store`：项目清单会随绑定变化，缓存会让 UI 显示过期数据。
 * @param {object} res - `ServerResponse`。
 * @param {number} status - HTTP 状态码。
 * @param {object} payload - 响应体。
 * @returns {void}
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

/**
 * 从请求里取出浏览器带上的会话 id（查询参数 `?sessionId=...`）。
 *
 * 路由拿到的是**裸 Node `req`**（`dsh-host-webserver` 只做
 * `route.handler(req, res)`），没有会话身份 —— 所以只能由浏览器带上。
 * 见 `installBindRoute` 里对「为什么不因此信任它」的说明。
 *
 * @param {object} req - 请求。
 * @returns {string|undefined} 会话 id。
 */
function sessionIdOf(req) {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const value = url.searchParams.get('sessionId');
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读取有上限的请求体。
 *
 * 逐条对齐 `dsh-host-open-in-app` 的做法：超过上限立即停止累积并返回
 * `null`（由调用方回 413），而不是无界地读进内存。
 * @param {object} req - 请求。
 * @returns {Promise<string|null>} 文本，或超限时的 null。
 */
function readBoundedBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 注册「点一下直接绑定」路由。
 *
 * ## 为什么需要它
 *
 * 最早的实现是「点按钮 → 往输入框填一句指令 → 你自己按发送」。
 * 那既多一步，又依赖「能可靠地操作受控输入框」这个很脆的前提
 * （React 受控组件不接受直接改 `value`）。改成浏览器直接 POST，
 * 绑定由宿主自己完成 —— 这条路径不依赖任何 DOM 细节。
 *
 * ## 身份从哪来
 *
 * 路由拿到的是**裸 Node `req`**（`dsh-host-webserver` 只做
 * `route.handler(req, res)`），**没有任何会话身份**。所以会话 id
 * 必须由浏览器在请求体里带上。
 *
 * 因此**不能**因为「带了 id」就信任它。这里只把它当作
 * 「一个字符串键」用于写绑定记录 —— 与工具路径一致：
 * 真正危险的不是伪造自己的身份，而是**越出工作区根**，
 * 而那个由 `binder` 的 target 校验（`isSafeSegment` + 相对路径
 * 包含性双重检查）兜住。换言之：伪造 id 只能污染自己的绑定记录，
 * 拿不到任何额外能力。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} options - 入参。
 * @param {object} options.binder - `FolderBinder` 实例。
 * @param {object} [options.logger] - 日志器。
 * @param {Array} options.disposers - 收集 disposer 的数组。
 * @returns {boolean} 是否成功注册。
 */
export function installBindRoute(ctx, { binder, logger, disposers }) {
  const webServer = (() => {
    try {
      return Reflect.get(ctx, 'webServer');
    } catch {
      return undefined;
    }
  })();
  if (webServer === undefined || typeof webServer.register !== 'function') return false;

  const connection = connectionOf(ctx);
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    logger?.warn?.('workspace-folders: connection 不可用，出于安全不注册绑定路由。');
    return false;
  }

  const rejected = (req, res) => {
    let rejection;
    try {
      rejection = connection.requestRejection(req);
    } catch {
      rejection = 403;
    }
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  try {
    const dispose = webServer.register({
      kind: 'exact',
      path: BIND_ROUTE,
      handler: async (req, res) => {
        if (rejected(req, res)) return;

        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('Allow', 'POST');
          res.end();
          return;
        }

        const mediaType = String(req.headers['content-type'] ?? '')
          .split(';', 1)[0].trim().toLowerCase();
        if (mediaType !== 'application/json') {
          sendJson(res, 415, { error: 'content-type must be application/json' });
          return;
        }

        let text;
        try {
          text = await readBoundedBody(req);
        } catch {
          sendJson(res, 400, { error: 'request body unreadable' });
          return;
        }
        if (text === null) {
          sendJson(res, 413, { error: 'request body too large' });
          return;
        }

        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          sendJson(res, 400, { error: 'body must be JSON' });
          return;
        }

        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
        const rawTarget = typeof payload?.target === 'string' ? payload.target.trim() : '';
        if (sessionId === '' || rawTarget === '') {
          sendJson(res, 400, { error: 'sessionId and target are required' });
          return;
        }

        // ★★★ 两条通道，两种语义 —— 必须先分清是哪一种。
        //
        // 【A】绑定**已存在**的目录（点项目胶囊）：
        //     名字必须**原样使用**。已有的项目叫 `MinerU`，
        //     绝不能因为 slugify 会小写化就把它变成 `mineru` ——
        //     那会去建一个**新**目录，而用户的意图是绑到既有的那个上。
        //     （实测踩过：绑定 MinerU 返回 `folder:"mineru"`。）
        //
        // 【B】**新建**目录（输入新名字）：走 `normalizeUserFolderName`。
        //     ⚠️ 这里不能直接 `slugify`：它会把 `../evil` 洗成合法的
        //     `evil`、把 `../../Windows/Temp` 洗成 `windows-temp`，
        //     于是危险输入**静默变成一次成功的创建**，而且建出来的
        //     不是用户输入的名字。工具路径对同样输入是**报错拒绝**的。
        //
        // 判据：目标目录**是否已存在**（用 binder 的同一个根，别另算一套）。
        //
        // ⚠️ 这里要**容错**：测试里会传入只实现 `bind()` 的替身 binder，
        //    没有 `resolveWorkspaceRoot`。查不到根就当作"不存在"，
        //    继续走净化路径 —— 净化路径本身是安全的（更严格），
        //    所以降级不会放宽任何校验。
        const root = typeof binder.resolveWorkspaceRoot === 'function'
          ? await binder.resolveWorkspaceRoot()
          : undefined;
        const existing = root === undefined
          ? false
          : await nodeFs.stat(path.join(root, rawTarget)).then((s) => s.isDirectory(), () => false);

        let target = rawTarget;
        let renamed = false;
        if (!existing) {
          const normalized = normalizeUserFolderName(rawTarget);
          if (normalized.ok !== true) {
            sendJson(res, 400, { error: normalized.error });
            return;
          }
          target = normalized.name;
          renamed = normalized.changed;
        }

        // 目标名必须是一个安全目录段 —— 与工具路径同一把尺子。
        // ⚠️ 已存在的目录**也要过这一关**：名字来自浏览器，不能因为是
        //    "已存在"就免检（`isSafeSegment` 同时挡住 Windows 保留名）。
        if (!isSafeSegment(target)) {
          sendJson(res, 400, { error: 'target is not a valid folder name' });
          return;
        }

        try {
          const result = await binder.bind({ sessionId, title: '', create: true, target });
          sendJson(res, 200, {
            ok: true,
            folder: result.folder,
            created: result.created === true,
            // 回传净化后的名字：输入 `我的 project` → 实际建出 `project`
            // 时，UI 要能如实告诉用户**到底建了什么**。
            target,
            renamed,
          });
        } catch (error) {
          logger?.warn?.(`workspace-folders: 浏览器绑定失败：${String(error?.message ?? error)}`);
          sendJson(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      },
    });

    if (typeof dispose === 'function') disposers.push(dispose);
    logger?.debug?.(`workspace-folders: 已注册路由 POST ${BIND_ROUTE}`);
    return true;
  } catch (error) {
    logger?.warn?.(`workspace-folders: 注册绑定路由失败：${String(error?.message ?? error)}`);
    return false;
  }
}

/**
 * 注册「可绑定项目清单」路由。
 *
 * 失败一律**不抛出** —— 路由只是给 UI 用的增值能力，
 * 它注册不上不该影响插件的主体功能（工具、日志、指令镜像）。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} options - 入参。
 * @param {object} options.binder - `FolderBinder` 实例。
 * @param {object} [options.logger] - 日志器。
 * @param {Array} options.disposers - 收集 disposer 的数组。
 * @returns {boolean} 是否成功注册。
 */
export function installProjectRoute(ctx, { binder, logger, disposers }) {
  const webServer = (() => {
    try {
      return Reflect.get(ctx, 'webServer');
    } catch {
      return undefined;
    }
  })();

  if (webServer === undefined || typeof webServer.register !== 'function') {
    logger?.debug?.('workspace-folders: webServer 不可用，跳过项目清单路由');
    return false;
  }

  // fail-closed：没有信任围栏就不开这个接口。
  const connection = connectionOf(ctx);
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    logger?.warn?.(
      'workspace-folders: connection 服务不可用，出于安全**不注册**项目清单路由 '
      + '（该接口会暴露本机目录结构）。客户端选择器将不可用，其余功能不受影响。',
    );
    return false;
  }

  /**
   * 对不受信来源回一个空响应。
   * @param {object} req - 请求。
   * @param {object} res - 响应。
   * @returns {boolean} 是否已被拒绝（调用方应直接 return）。
   */
  const rejected = (req, res) => {
    let rejection;
    try {
      rejection = connection.requestRejection(req);
    } catch (error) {
      // 判定本身出错 → 按拒绝处理（fail-closed）。
      logger?.warn?.(`workspace-folders: 信任判定异常，按拒绝处理：${String(error?.message ?? error)}`);
      rejection = 403;
    }
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  try {
    const dispose = webServer.register({
      kind: 'exact',
      path: PROJECTS_ROUTE,
      handler: async (req, res) => {
        if (rejected(req, res)) return;

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.setHeader('Allow', 'GET, HEAD');
          res.end();
          return;
        }

        try {
          const root = await binder.resolveWorkspaceRoot();
          const projects = await listBindableProjects({ parentDir: root, limit: MAX_PROJECTS });

          // ★ 告诉 UI「**这个**会话已经绑到哪了」。
          //
          // 之前只回 `{ root, projects }`，于是选择条**永远**只显示
          // 「绑定到项目：…」按钮：它根本无从知道当前会话是否已绑定，
          // 所以每次重新打开对话都会再弹一次，点了之后也不知道该收起。
          // 用户报的「重新打开对话还是会弹出绑定到项目」正是这个。
          //
          // 会话 id 由浏览器用查询参数带上（路由拿到的是裸 `req`，
          // 没有会话身份，详见 `installBindRoute` 的说明）。
          const sessionId = sessionIdOf(req);
          let current;
          if (sessionId !== undefined) {
            try {
              const bound = await binder.lookup(sessionId);
              if (bound !== undefined) {
                // 标记哪个项目是当前绑定的，UI 好高亮而不是再问一遍。
                current = { folder: bound.folder, bound: true };
                for (const p of projects) {
                  if (p.name === bound.folder) p.current = true;
                }
              }
            } catch (error) {
              // 查绑定失败不该让整个清单失败 —— 退化成「未绑定」，
              // 用户最多多看见一次选择条。
              logger?.debug?.(
                `workspace-folders: 查询会话绑定失败（按未绑定处理）：${String(error?.message ?? error)}`,
              );
            }
          }

          sendJson(res, 200, { root, projects, current: current ?? null });
        } catch (error) {
          logger?.warn?.(
            `workspace-folders: 项目清单路由失败：${String(error?.message ?? error)}`,
          );
          sendJson(res, 500, { error: 'cannot list projects' });
        }
      },
    });

    if (typeof dispose === 'function') disposers.push(dispose);
    logger?.debug?.(`workspace-folders: 已注册路由 GET ${PROJECTS_ROUTE}`);
    return true;
  } catch (error) {
    logger?.warn?.(
      `workspace-folders: 注册项目清单路由失败（不影响其它功能）：${String(error?.message ?? error)}`,
    );
    return false;
  }
}
