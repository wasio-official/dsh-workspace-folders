/**
 * 宿主只读路由（`/workspace-folders/projects`）的验证。
 *
 * 这条路由是「新建对话时在界面上选项目」的数据来源。它同时是一个
 * **会暴露本机目录结构**的接口，所以安全行为必须被固定住：
 *
 * 1. 路径与 kind 符合 `dsh-host-webserver` 的 `WebRoute` 契约；
 * 2. **信任围栏生效**：`connection.requestRejection` 返回 401/403 时不吐数据；
 * 3. **fail-closed**：拿不到 connection 服务时**根本不注册**，而不是裸奔；
 * 4. 非 GET/HEAD 方法返回 405；
 * 5. 正常请求返回项目清单，且**带 no-store**（清单会变）。
 *
 * @module dsh-workspace-folders/scripts/check-route
 */

import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installProjectRoute, installBindRoute, PROJECTS_ROUTE, BIND_ROUTE } from '../src/route.js';
import { FolderBinder } from '../src/binder.js';
import { resolveConfig } from '../src/config.js';
import { makeWebServerStub, makeConnectionStub, makeResponseStub } from './check-fixtures.js';

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

/** 收集警告的 logger。 */
function makeLogger() {
  const warns = [];
  const infos = [];
  return {
    warns,
    infos,
    debug() {},
    info(m) { infos.push(String(m)); },
    warn(m) { warns.push(String(m)); },
    error() {},
  };
}

console.log('宿主只读路由：项目清单');
console.log('='.repeat(70));

const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-route-'));
const dshHome = path.join(root, '_dshhome');
await nodeFs.mkdir(dshHome, { recursive: true });
await nodeFs.writeFile(path.join(root, 'AGENTS.md'), '# x\n', 'utf8');
for (const name of ['MinerU', 'PhO']) {
  await nodeFs.mkdir(path.join(root, name), { recursive: true });
}

const config = resolveConfig({ workspaceRoot: root, dshHome, inheritOnBind: false });

/**
 * 造一个 ctx。
 * @param {object} [extra] - 额外提供的服务。
 * @returns {object} ctx。
 */
function makeCtx(extra = {}) {
  return {
    logger: makeLogger(),
    webServer: makeWebServerStub(),
    connection: makeConnectionStub(),
    ...extra,
  };
}

/**
 * 造请求对象。
 * @param {string} [method] - HTTP 方法。
 * @param {string} [url] - 请求 URL（可带 `?sessionId=`）。
 * @returns {object} 请求替身。
 */
function makeRequest(method = 'GET', url = PROJECTS_ROUTE) {
  return { method, headers: {}, url };
}

try {
  const binder = new FolderBinder({ ctx: makeCtx(), config });

  // ── 1. 正常注册与响应 ────────────────────────────────────────────
  console.log('\n【1】注册与正常响应');
  {
    const ctx = makeCtx();
    const disposers = [];
    const ok = installProjectRoute(ctx, { binder, logger: ctx.logger, disposers });

    check('★ 注册成功', ok === true);
    check('★ 注册了 1 条路由', ctx.webServer.routes.length === 1,
      String(ctx.webServer.routes.length));
    check('★ 收集到了 disposer', disposers.length === 1, String(disposers.length));

    const route = ctx.webServer.routes[0];
    check('★ kind 是 exact', route.kind === 'exact', route.kind);
    check('★★ path 正确', route.path === '/workspace-folders/projects', route.path);
    check('★ path 不带尾斜杠', !route.path.endsWith('/'));
    check('★ path 是绝对路径', route.path.startsWith('/'));

    const res = makeResponseStub();
    await route.handler(makeRequest('GET'), res);

    check('★ 状态码 200', res.statusCode === 200, String(res.statusCode));
    check('★ 内容类型是 JSON',
      String(res.headers['content-type'] ?? '').includes('application/json'),
      String(res.headers['content-type']));
    check('★★ 带 no-store（清单会变，不能缓存）',
      res.headers['cache-control'] === 'no-store', String(res.headers['cache-control']));

    const payload = JSON.parse(res.body);
    check('★ 返回了 root', typeof payload.root === 'string', JSON.stringify(payload.root));
    check('★ 返回了项目数组', Array.isArray(payload.projects), typeof payload.projects);
    const names = payload.projects.map((p) => p.name);
    check('★ 含 MinerU', names.includes('MinerU'), names.join(','));
    check('★ 含 PhO', names.includes('PhO'), names.join(','));
    check('★ 隐藏了内部目录（_dshhome）', !names.includes('_dshhome'), names.join(','));

    // ★ 新增字段：不带 sessionId 时 `current` 必须是 null（不能瞎猜）。
    check('★★ 不带 sessionId 时 current 为 null（不猜）',
      payload.current === null, JSON.stringify(payload.current));

    // disposer 要真的能摘掉路由
    disposers[0]();
    check('★ disposer 摘除了路由', ctx.webServer.routes.length === 0,
      String(ctx.webServer.routes.length));
  }

  // ── 1b. ★★★ 当前会话的绑定状态（「重开对话又弹选择条」的修复）─────
  console.log('\n【1b】返回当前会话的绑定状态');
  {
    const ctx = makeCtx();
    installProjectRoute(ctx, { binder, logger: ctx.logger, disposers: [] });
    const route = ctx.webServer.routes[0];

    // 先真绑一个会话。
    await binder.bind({ sessionId: 'sess-cur', title: 'x', create: true, target: 'MinerU' });

    const res = makeResponseStub();
    await route.handler(makeRequest('GET', `${PROJECTS_ROUTE}?sessionId=sess-cur`), res);
    const payload = JSON.parse(res.body);

    check('★★★ 带 sessionId 时返回 current', payload.current !== null,
      JSON.stringify(payload.current));
    check('★★★ current.folder 是那个会话真正绑到的目录',
      payload.current?.folder === 'MinerU', JSON.stringify(payload.current));
    check('★★ 对应项目被标记 current:true（UI 好高亮）',
      payload.projects.find((p) => p.name === 'MinerU')?.current === true,
      JSON.stringify(payload.projects.find((p) => p.name === 'MinerU')));
    check('★ 其它项目没有 current 标记',
      payload.projects.filter((p) => p.name !== 'MinerU').every((p) => p.current === undefined));

    // 没绑过的会话 → null。
    const res2 = makeResponseStub();
    await route.handler(makeRequest('GET', `${PROJECTS_ROUTE}?sessionId=sess-none`), res2);
    check('★★ 未绑定的会话返回 current:null',
      JSON.parse(res2.body).current === null, res2.body);

    // 空 / 缺参数都不能炸，也不能瞎认。
    for (const q of ['?sessionId=', '?sessionId=%20', '?other=1', '']) {
      const r = makeResponseStub();
      await route.handler(makeRequest('GET', `${PROJECTS_ROUTE}${q}`), r);
      check(`★★ 参数「${q}」不误判（current 仍为 null）`,
        r.statusCode === 200 && JSON.parse(r.body).current === null,
        `${r.statusCode} ${r.body}`);
    }
  }

  // ── 2. ★ 信任围栏 ──────────────────────────────────────────────
  console.log('\n【2】信任围栏（不受信来源不给数据）');
  {
    const ctx = makeCtx({ connection: makeConnectionStub('deny') });
    installProjectRoute(ctx, { binder, logger: ctx.logger, disposers: [] });

    const route = ctx.webServer.routes[0];
    const res = makeResponseStub();
    await route.handler(makeRequest('GET'), res);

    check('★★ 被拒时返回 403', res.statusCode === 403, String(res.statusCode));
    check('★★ 被拒时**不返回任何数据**', res.body === undefined, String(res.body));
    check('★ 确实调用了围栏判定', ctx.connection.calls.length === 1,
      String(ctx.connection.calls.length));
  }

  // ── 3. ★ fail-closed ───────────────────────────────────────────
  console.log('\n【3】fail-closed：没有围栏就不开接口');
  {
    const ctx = makeCtx();
    delete ctx.connection;
    const ok = installProjectRoute(ctx, { binder, logger: ctx.logger, disposers: [] });

    check('★★ 没有 connection 服务时**不注册**路由', ok === false);
    check('★★ 确实一条路由都没注册', ctx.webServer.routes.length === 0,
      String(ctx.webServer.routes.length));
    check('★ 打了警告说明原因', ctx.logger.warns.some((w) => /connection/.test(w)),
      JSON.stringify(ctx.logger.warns));

    // 围栏方法缺失也算不安全
    const ctx2 = makeCtx({ connection: {} });
    const ok2 = installProjectRoute(ctx2, { binder, logger: ctx2.logger, disposers: [] });
    check('★ connection 缺 requestRejection 时也不注册', ok2 === false);
  }

  // ── 4. 方法限制 ────────────────────────────────────────────────
  // ── 3b. ★★★ 新建目录时的名字规范化 ────────────────────────────────
  //
  // 真实发现：浏览器新建入口最初直接调 `slugify`，于是
  //   `../evil`      → `evil`        ← 危险输入被"洗白"成合法名，还建了出来
  //   `../../Windows/Temp/pwn` → `windows-temp-pwn`
  // 而**工具路径**对同样输入是**报错拒绝**的。两条路径行为不一致，
  // 且危险输入理应显式报错而不是被静默改写。
  console.log('\n【3b】新建目录：危险名字必须**显式拒绝**（不能洗白）');
  {
    const ctx = makeCtx();
    const disposers = [];
    installBindRoute(ctx, { binder, logger: ctx.logger, disposers });
    const route = ctx.webServer.routes[0];

    /** 发一个 POST /bind 请求。 */
    const bind = async (payload) => {
      const req = {
        method: 'POST',
        url: BIND_ROUTE,
        headers: { 'content-type': 'application/json' },
        on(event, fn) { (this._h ??= {})[event] = fn; return this; },
        destroy() {},
      };
      const res = makeResponseStub();
      const p = route.handler(req, res);
      // 手动喂 body。
      req._h.data?.(Buffer.from(JSON.stringify(payload)));
      req._h.end?.();
      await p;
      return { code: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
    };

    // ★ 路径分隔符 / 上跳：**必须 400 拒绝**，且不能建出任何目录。
    for (const bad of ['../evil', '../../Windows/Temp/pwn', '..\\..\\pwn', '/etc/passwd', 'a/b']) {
      const r = await bind({ sessionId: 's-esc', target: bad });
      check(`★★★ 危险名字被拒绝：${JSON.stringify(bad)}`,
        r.code === 400, `code=${r.code} json=${JSON.stringify(r.json)}`);
      check(`★★ 报的是**具体原因**（不是泛泛的失败）：${JSON.stringify(bad)}`,
        typeof r.json?.error === 'string' && r.json.error.length > 0, JSON.stringify(r.json));
    }

    // ★ 关键：**没有**建出 `evil` 这种被洗白的目录。
    const root = config.workspaceRoot;
    const entries = await nodeFs.readdir(root).catch(() => []);
    check('★★★ 没有建出被洗白的 `evil` 目录',
      !entries.includes('evil'), entries.join(', '));
    check('★★ 也没有 `windows-temp-pwn` 之类',
      !entries.some((e) => e.includes('windows-temp') || e.includes('passwd')),
      entries.join(', '));

    // 纯中文：无可净化字符 → 拒绝，且提示说明支持什么字符。
    const cn = await bind({ sessionId: 's-cn', target: '纯中文标题' });
    check('★★ 纯中文被拒绝并说明原因',
      cn.code === 400 && String(cn.json?.error ?? '').includes('英文字母'),
      JSON.stringify(cn.json));

    // 中英混合：净化后可用 → 成功，且回传实际建出的名字。
    const mixed = await bind({ sessionId: 's-mix', target: '我的 project 项目' });
    check('★★ 中英混合净化成功', mixed.code === 200 && mixed.json?.ok === true,
      JSON.stringify(mixed.json));
    check('★★ 回传被净化后的真实名字', mixed.json?.target === 'project',
      JSON.stringify(mixed.json));
    check('★★ 并标记 renamed=true（用户能看到名字被改过）',
      mixed.json?.renamed === true, JSON.stringify(mixed.json));

    // 正常英文名：原样通过，renamed=false。
    const plain = await bind({ sessionId: 's-plain', target: 'my-new-project' });
    check('★ 普通英文名原样通过', plain.code === 200 && plain.json?.target === 'my-new-project',
      JSON.stringify(plain.json));
    check('★ 未被改名的 renamed=false', plain.json?.renamed === false,
      JSON.stringify(plain.json));
    check('★★ 目录真的被创建了', plain.json?.created === true, JSON.stringify(plain.json));
  }

  console.log('\n【4】HTTP 方法');  {
    const ctx = makeCtx();
    installProjectRoute(ctx, { binder, logger: ctx.logger, disposers: [] });
    const route = ctx.webServer.routes[0];

    const post = makeResponseStub();
    await route.handler(makeRequest('POST'), post);
    check('★ POST 返回 405', post.statusCode === 405, String(post.statusCode));
    check('★ 带 Allow 头', String(post.headers.allow ?? '').includes('GET'),
      String(post.headers.allow));
    check('★ 不返回数据', post.body === undefined);

    const del = makeResponseStub();
    await route.handler(makeRequest('DELETE'), del);
    check('★ DELETE 也是 405', del.statusCode === 405, String(del.statusCode));

    // HEAD 允许（无 body 语义，但状态码要正常）
    const head = makeResponseStub();
    await route.handler(makeRequest('HEAD'), head);
    check('★ HEAD 不被拒（200）', head.statusCode === 200, String(head.statusCode));
  }

  // ── 5. 围栏本身抛错 → 按拒绝处理 ───────────────────────────────
  console.log('\n【5】围栏异常');
  {
    const ctx = makeCtx({
      connection: {
        requestRejection() { throw new Error('fence broken'); },
      },
    });
    installProjectRoute(ctx, { binder, logger: ctx.logger, disposers: [] });
    const route = ctx.webServer.routes[0];
    const res = makeResponseStub();
    await route.handler(makeRequest('GET'), res);

    check('★★ 围栏抛错时按拒绝处理（403）', res.statusCode === 403, String(res.statusCode));
    check('★ 不返回数据', res.body === undefined);
  }

  // ── 6. 没有 webServer 也要能活 ─────────────────────────────────
  console.log('\n【6】没有 webServer');
  {
    const ctx = makeCtx();
    delete ctx.webServer;
    let threw = false;
    try {
      installProjectRoute(ctx, { binder, logger: ctx.logger, disposers: [] });
    } catch { threw = true; }
    check('★ 没有 webServer 时不抛错（静默跳过）', !threw);
  }

  // ── 7. 工作区根不存在 → 500 而不是崩 ───────────────────────────
  console.log('\n【7】内部错误');
  {
    const badBinder = {
      async resolveWorkspaceRoot() { throw new Error('root gone'); },
    };
    const ctx = makeCtx();
    installProjectRoute(ctx, { binder: badBinder, logger: ctx.logger, disposers: [] });
    const route = ctx.webServer.routes[0];
    const res = makeResponseStub();

    let threw = false;
    try { await route.handler(makeRequest('GET'), res); } catch { threw = true; }

    check('★ 解析失败时不把异常抛给服务器', !threw);
    check('★ 返回 500', res.statusCode === 500, String(res.statusCode));
    check('★ 错误响应不含本机路径', !String(res.body ?? '').includes(root), String(res.body));
  }
} finally {
  await nodeFs.rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${'='.repeat(70)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
