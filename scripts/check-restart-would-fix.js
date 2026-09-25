/**
 * 「重启后是否真的会注册 /bind」的装配验证。
 *
 * ## 为什么需要
 *
 * 真实 3080 进程上实测：
 * ```
 * POST /workspace-folders/bind  -> 405   （没有 Allow 头）
 * GET  /workspace-folders/bind  -> 404
 * POST /workspace-folders/projects -> 401 （我的旧路由命中，被信任围栏挡住）
 * ```
 *
 * 那个裸 405 来自 `dsh-host-frontend-static` 的 **fallback**：
 * ```js
 * ctx.webServer.registerFallback(async (req, res) => {
 *   if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); ... }
 * ```
 * fallback **只在没有任何路由命中时**才跑。也就是说：
 * 那个进程里 `/bind` **根本没注册** —— 它跑的是我加 `/bind` 之前的代码
 * （进程 11:06 启动，route.js 11:12 才改）。
 *
 * 本脚本在**当前源码**上重放一次真实的 Cordis 装配，确认两条路由都会注册。
 * 这样「重启后就好」不是推测，而是被验证过的。
 *
 * @module dsh-workspace-folders/scripts/check-restart-would-fix
 */

import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installBindRoute, installProjectRoute, BIND_ROUTE, PROJECTS_ROUTE } from '../src/route.js';
import { FolderBinder } from '../src/binder.js';
import { resolveConfig } from '../src/config.js';
import { makeWebServerStub, makeConnectionStub } from './check-fixtures.js';

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

console.log('重启装配验证：当前源码会不会注册两条路由');
console.log('='.repeat(70));

const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-restart-'));

try {
  const webServer = makeWebServerStub();
  const ctx = { logger, webServer, connection: makeConnectionStub() };
  const binder = new FolderBinder({ ctx, config: resolveConfig({ workspaceRoot: root }) });
  const disposers = [];

  const okProjects = installProjectRoute(ctx, { binder, logger, disposers });
  const okBind = installBindRoute(ctx, { binder, logger, disposers });

  const paths = webServer.routes.map((r) => r.path);

  check('★ 项目清单路由注册成功', okProjects === true);
  check('★★ 绑定路由注册成功', okBind === true, String(okBind));
  check(`★★ 路由表里有 ${PROJECTS_ROUTE}`, paths.includes(PROJECTS_ROUTE), paths.join(', '));
  check(`★★ 路由表里有 ${BIND_ROUTE}`, paths.includes(BIND_ROUTE), paths.join(', '));

  // kind 必须是 exact —— prefix 会吞掉同前缀的其它路径。
  const bindRoute = webServer.routes.find((r) => r.path === BIND_ROUTE);
  check('★ /bind 的 kind 是 exact', bindRoute?.kind === 'exact', String(bindRoute?.kind));

  // ★ 这是关键：handler 必须以「405 带 Allow: POST」回应非 POST，
  //   而不是像 SPA fallback 那样回一个**裸 405**（没有 Allow）。
  //   所以「有没有 Allow 头」正好能区分「我的路由在答」与「fallback 在答」。
  const getRes = (() => {
    const res = {
      statusCode: 0, headers: {}, body: undefined,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) { this.body = b; },
    };
    const req = {
      method: 'GET', url: BIND_ROUTE, headers: {},
      on() { return req; }, destroy() {},
    };
    bindRoute.handler(req, res);
    return res;
  })();
  check('★★ 非 POST 时回 405', getRes.statusCode === 405, String(getRes.statusCode));
  check('★★ 且带 Allow: POST（SPA fallback 的裸 405 没有这个头）',
    getRes.headers.allow === 'POST', String(getRes.headers.allow));

  // ★ 反向确认：这个 Allow 头就是「新代码已生效」的指纹。
  check('★★ 因此重启后 Allow 头会取代裸 405 —— 可直接用于线上判定',
    getRes.headers.allow !== undefined);
} finally {
  await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${'='.repeat(70)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
