/**
 * 宿主**写**路由（`POST /workspace-folders/bind`）的验证。
 *
 * 这是本插件唯一一个**有副作用**的 HTTP 接口：点一下按钮就真的在磁盘上
 * 建目录/写绑定记录。所以它比只读路由需要更严的边界检查。
 *
 * 验证重点：
 *
 * 1. 路径、kind、方法符合 `dsh-host-webserver` 契约；
 * 2. **信任围栏**：`requestRejection` 拒绝时**不产生任何副作用**；
 * 3. **fail-closed**：拿不到 connection 服务就根本不注册；
 * 4. 方法限制（非 POST → 405 + Allow）；
 * 5. **Content-Type 强制** `application/json`（否则 415）；
 * 6. **请求体上限**（超过 → 413，不无界读内存）；
 * 7. **入参校验**：缺字段 400、非法 JSON 400、危险目录名 400；
 * 8. **★ 路径逃逸必须被挡**：`../../` 之类的 target 绝不能建到根外面；
 * 9. 绑定结果如实回给浏览器（含失败原因）。
 *
 * @module dsh-workspace-folders/scripts/check-bind-route
 */

import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installBindRoute, BIND_ROUTE } from '../src/route.js';
import { FolderBinder } from '../src/binder.js';
import { resolveConfig } from '../src/config.js';
import {
  makeWebServerStub, makeConnectionStub, makeResponseStub,
} from './check-fixtures.js';

let passed = 0;
let failed = 0;

/**
 * 断言并记录。
 * @param {string} label - 断言名。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 失败详情。
 * @returns {void}
 */
function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`[PASS] ${label}`);
  } else {
    failed += 1;
    console.log(`[FAIL] ${label}${detail === undefined ? '' : `  <- ${detail}`}`);
  }
}

/** 收集日志的 logger。 */
function makeLogger() {
  const warns = [];
  return {
    warns,
    debug() {}, info() {},
    warn(m) { warns.push(String(m)); },
    error(m) { warns.push(String(m)); },
  };
}

/**
 * 造一个最小的可读请求体流。
 *
 * 路由用 `req.on('data')`/`req.on('end')` 读体，所以桩要实现这两个事件。
 * @param {string} body - 请求体文本。
 * @returns {object} 可被 `on` 读取的桩。
 */
function makeRequest(body, { method = 'POST', contentType = 'application/json' } = {}) {
  const handlers = {};
  const req = {
    method,
    url: BIND_ROUTE,
    headers: { 'content-type': contentType },
    on(event, fn) { (handlers[event] ??= []).push(fn); return req; },
    destroy() {},
  };
  // 异步派发，模拟真实流。
  setImmediate(() => {
    if (body !== undefined) (handlers.data ?? []).forEach((fn) => fn(Buffer.from(body, 'utf8')));
    (handlers.end ?? []).forEach((fn) => fn());
  });
  return req;
}

/**
 * 造一个超限的请求体（会分块灌入）。
 * @returns {object} 请求桩。
 */
function makeOversizedRequest() {
  const handlers = {};
  const req = {
    method: 'POST',
    url: BIND_ROUTE,
    headers: { 'content-type': 'application/json' },
    on(event, fn) { (handlers[event] ??= []).push(fn); return req; },
    destroy() {},
  };
  setImmediate(() => {
    // 连续灌 100 个 1KiB 块 —— 远超 8KiB 上限。
    for (let i = 0; i < 100; i += 1) {
      (handlers.data ?? []).forEach((fn) => fn(Buffer.alloc(1024, 0x61)));
    }
    (handlers.end ?? []).forEach((fn) => fn());
  });
  return req;
}

console.log('宿主写路由：POST ' + BIND_ROUTE);
console.log('='.repeat(70));

const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-bindroute-'));
await nodeFs.mkdir(path.join(root, 'MinerU'), { recursive: true });
await nodeFs.mkdir(path.join(root, 'PhO'), { recursive: true });

const config = resolveConfig({ workspaceRoot: root, inheritOnBind: false });

/**
 * 装一次路由并返回驱动接口。
 * @param {object} [opts] - 覆盖项。
 * @returns {object} 路由与记录。
 */
async function mount(opts = {}) {
  const logger = opts.logger ?? makeLogger();
  const ctx = {
    logger,
    webServer: makeWebServerStub(),
    connection: opts.connection ?? makeConnectionStub(),
  };
  if (opts.omitConnection) delete ctx.connection;
  if (opts.omitWebServer) delete ctx.webServer;

  const binder = opts.binder ?? new FolderBinder({ ctx, config });
  const disposers = [];
  const registered = installBindRoute(ctx, { binder, logger, disposers });
  return { ctx, logger, binder, disposers, registered, route: ctx.webServer?.routes?.[0] };
}

/**
 * 发一个请求给路由。
 * @param {object} route - 路由对象。
 * @param {object} req - 请求桩。
 * @returns {Promise<object>} 响应桩。
 */
async function send(route, req) {
  const res = makeResponseStub();
  await route.handler(req, res);
  return res;
}

/**
 * 解析响应 JSON。
 * @param {object} res - 响应桩。
 * @returns {object|undefined} 解析结果。
 */
function jsonOf(res) {
  try {
    return JSON.parse(res.body);
  } catch {
    return undefined;
  }
}

try {
  // ── 1. 注册契约 ─────────────────────────────────────────────────
  console.log('\n【1】注册契约');
  {
    const m = await mount();
    check('★ 注册成功', m.registered === true);
    check('★ path 与客户端常量一致', m.route?.path === BIND_ROUTE, String(m.route?.path));
    check('★ kind 是 exact（不是 prefix）', m.route?.kind === 'exact', String(m.route?.kind));
    check('★ handler 是函数', typeof m.route?.handler === 'function');
    check('★ 返回了 disposer', m.disposers.length === 1, String(m.disposers.length));
  }

  // ── 2. 正常绑定 ─────────────────────────────────────────────────
  console.log('\n【2】正常绑定');
  {
    const m = await mount();
    const res = await send(m.route, makeRequest(JSON.stringify({
      sessionId: 'sess-web-1', target: 'MinerU',
    })));

    check('★ 返回 200', res.statusCode === 200, String(res.statusCode));
    const body = jsonOf(res);
    check('★★ 结果 ok:true', body?.ok === true, JSON.stringify(body));
    check('★ 回报绑定的目录名', body?.folder === 'MinerU', JSON.stringify(body));
    // ★★★ 回归：绑定**已存在**的目录时，名字必须**原样使用**。
    //
    // 真实踩过：我给新建入口加 slugify 净化后，"绑定 MinerU" 也走了
    // 同一条净化 —— `MinerU` 被小写化成 `mineru`，于是它去建了个**新**
    // 目录，而不是绑到既有那个上。`renamed` 还报 `true`。
    //
    // 判据必须是「目录是否已存在」，而不是「有没有做净化」。
    check('★★★ 绑定已存在目录时**不改写**名字（MinerU ≠ mineru）',
      body?.folder === 'MinerU' && body?.target === 'MinerU', JSON.stringify(body));
    check('★★★ 绑定已存在目录时 renamed=false', body?.renamed === false,
      JSON.stringify(body));
    check('★★ 没有建出小写的 `mineru` 幽灵目录',
      !(await nodeFs.readdir(root)).includes('mineru'),
      (await nodeFs.readdir(root)).join(','));    check('★★ 真的写进了磁盘',
      await nodeFs.readFile(path.join(root, 'MinerU', '.dsh-session.json'), 'utf8')
        .then((t) => t.includes('sess-web-1')).catch(() => false));
    check('★★ 没有多建日期目录（是绑定而非新建）',
      !(await nodeFs.readdir(root)).some((n) => /^\d{4}-\d{2}-\d{2}-/.test(n)),
      (await nodeFs.readdir(root)).join(','));
  }

  // ── 3. ★ 路径逃逸必须被挡 ───────────────────────────────────────
  console.log('\n【3】路径逃逸（关键）');
  {
    const m = await mount();
    const evils = [
      '../escape', '..', '../../etc', 'a/b', 'a\\b', '.', '..', 'CON', '',
      '   ', 'MinerU/../PhO',
    ];
    let allBlocked = true;
    const leaked = [];
    for (const target of evils) {
      const res = await send(m.route, makeRequest(JSON.stringify({
        sessionId: 'sess-evil', target,
      })));
      const ok = jsonOf(res)?.ok === true;
      if (ok) { allBlocked = false; leaked.push(target); }
    }
    check('★★ 所有非法 target 都被拒绝（没有一个是 ok:true）',
      allBlocked, `漏了：${leaked.join(', ')}`);

    // 关键：根外面绝不能出现新目录。
    const outside = path.join(root, '..');
    const before = await nodeFs.readdir(outside);
    await send(m.route, makeRequest(JSON.stringify({
      sessionId: 's2', target: '../../pwned-by-route',
    })));
    const after = await nodeFs.readdir(outside);
    check('★★ 根外面没有新建任何东西',
      after.length === before.length && !after.includes('pwned-by-route'),
      after.filter((n) => !before.includes(n)).join(','));
  }

  // ── 4. 入参校验 ─────────────────────────────────────────────────
  console.log('\n【4】入参校验');
  {
    const m = await mount();

    const noSession = await send(m.route, makeRequest(JSON.stringify({ target: 'MinerU' })));
    check('★ 缺 sessionId → 400', noSession.statusCode === 400, String(noSession.statusCode));

    const noTarget = await send(m.route, makeRequest(JSON.stringify({ sessionId: 's' })));
    check('★ 缺 target → 400', noTarget.statusCode === 400, String(noTarget.statusCode));

    const badJson = await send(m.route, makeRequest('{not json'));
    check('★ 非法 JSON → 400', badJson.statusCode === 400, String(badJson.statusCode));

    const notObject = await send(m.route, makeRequest('"just a string"'));
    check('★ 非对象 JSON → 400', notObject.statusCode === 400, String(notObject.statusCode));
  }

  // ── 5. 方法 / Content-Type / 体上限 ─────────────────────────────
  console.log('\n【5】方法、媒体类型、体上限');
  {
    const m = await mount();

    const get = await send(m.route, makeRequest(undefined, { method: 'GET' }));
    check('★ GET → 405', get.statusCode === 405, String(get.statusCode));
    check('★ 405 带 Allow: POST', get.headers?.allow === 'POST', String(get.headers?.allow));

    const wrongType = await send(m.route, makeRequest(
      JSON.stringify({ sessionId: 's', target: 'MinerU' }),
      { contentType: 'text/plain' },
    ));
    check('★★ 非 application/json → 415', wrongType.statusCode === 415,
      String(wrongType.statusCode));

    const okType = await send(m.route, makeRequest(
      JSON.stringify({ sessionId: 's-ct', target: 'PhO' }),
      { contentType: 'application/json; charset=utf-8' },
    ));
    check('★ 带 charset 的 JSON 仍接受', okType.statusCode === 200, String(okType.statusCode));

    const big = await send(m.route, makeOversizedRequest());
    check('★★ 超大请求体 → 413（不无界读内存）', big.statusCode === 413,
      String(big.statusCode));
  }

  // ── 6. 信任围栏 ─────────────────────────────────────────────────
  console.log('\n【6】信任围栏');
  {
    const m = await mount({ connection: makeConnectionStub('deny') });
    const res = await send(m.route, makeRequest(JSON.stringify({
      sessionId: 'sess-fence', target: 'PhO',
    })));
    check('★★ 不受信来源 → 403', res.statusCode === 403, String(res.statusCode));
    check('★★ 403 不吐任何内容', res.body === undefined, String(res.body));
    check('★★ 403 时**没有产生副作用**',
      !(await nodeFs.readFile(path.join(root, 'PhO', '.dsh-session.json'), 'utf8')
        .then((t) => t.includes('sess-fence')).catch(() => false)));
  }

  // ── 7. fail-closed ──────────────────────────────────────────────
  console.log('\n【7】fail-closed');
  {
    const m = await mount({ omitConnection: true });
    check('★★ 没有 connection → **不注册**（而不是无保护地开出去）',
      m.registered === false, String(m.registered));
    check('★ 且没有注册任何路由', m.ctx.webServer.routes.length === 0,
      String(m.ctx.webServer.routes.length));
    check('★ 留下了告警日志', m.logger.warns.some((w) => w.includes('connection')),
      m.logger.warns.join('|'));
  }
  {
    const m = await mount({ omitWebServer: true });
    check('★ 没有 webServer → 不注册也不抛错', m.registered === false, String(m.registered));
  }
  {
    // 围栏判定本身抛错 → 按拒绝处理
    const m = await mount({
      connection: { requestRejection() { throw new Error('boom'); } },
    });
    const res = await send(m.route, makeRequest(JSON.stringify({
      sessionId: 'sess-throw', target: 'PhO',
    })));
    check('★★ 围栏判定抛错 → 按 403 拒绝（fail-closed）',
      res.statusCode === 403, String(res.statusCode));
  }

  // ── 8. 绑定失败要如实回报 ───────────────────────────────────────
  console.log('\n【8】失败如实回报');
  {
    const binder = {
      async bind() { throw new Error('磁盘只读'); },
    };
    const m = await mount({ binder });
    const res = await send(m.route, makeRequest(JSON.stringify({
      sessionId: 's', target: 'MinerU',
    })));
    check('★ binder 抛错时仍回 200（让 UI 能显示原因）',
      res.statusCode === 200, String(res.statusCode));
    const body = jsonOf(res);
    check('★★ 结果 ok:false 且带原因', body?.ok === false && body?.error === '磁盘只读',
      JSON.stringify(body));
  }
} finally {
  await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${'='.repeat(70)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
