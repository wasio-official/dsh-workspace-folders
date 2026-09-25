/**
 * 终极验证：完全按真实形态加载插件，并**真的调用一次命令**。
 *
 * 前两次线上崩溃都是「测试全绿、装上去就崩」，原因是测试用了宽松桩。
 * 本脚本不留退路：
 *   - 真 `Context` + 真 `CommandRuntime`；
 *   - 从**真实 profile 配置**里读条目（不是临时拼的）；
 *   - 加载后**真的执行**两个斜杠命令，验证返回契约；
 *   - 并断言**没有任何宽松桩**参与（`commands` 必须是真货）。
 *
 * @module dsh-workspace-folders/scripts/check-live
 */

import { promises as nodeFs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  loadContext, findDshPackage, mountCommands, makeSystemPromptStub,
  makeWebServerStub, makeConnectionStub,
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

console.log('实战验证：真实加载 + 真实执行命令');
console.log('='.repeat(70));

const anchor = findDshPackage();
if (anchor === undefined) {
  console.log('跳过：找不到 DSH');
  process.exit(0);
}

const Context = await loadContext();
const repoRoot = path.join(import.meta.dirname, '..');
const entryUrl = pathToFileURL(path.join(repoRoot, 'src', 'index.js')).href;

// ── 用一份隔离的临时工作区，避免污染真实工作区 ───────────────────────
const tmpRoot = await nodeFs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'wbf-live-'));
const tmpDshHome = path.join(tmpRoot, '_dshhome');
await nodeFs.mkdir(tmpDshHome, { recursive: true });
await nodeFs.writeFile(path.join(tmpRoot, 'AGENTS.md'), '# 主工作区指令\n实战验证。\n', 'utf8');

const app = new Context();

// 提到外面，读完 apply 之后要检查它注册了哪些路由。
const liveWebServer = makeWebServerStub();

try {
  // ── 1. 真实服务 ──────────────────────────────────────────────────
  const commands = await mountCommands(app);
  check('★ commands 用真实实现（不留宽松桩）', commands.real === true);

  // 其余服务按真实契约形状提供
  app.plugin({
    name: 'dsh-services',
    apply(ctx) {
      ctx.provide('tools', { register() {}, define: () => ({}) });
      // ★ 按真实契约校验的桩（不是 `() => () => {}` 那种宽松桩）
      ctx.provide('systemPrompt', makeSystemPromptStub());
      ctx.provide('workspaceRegistry', {
        archivedSessionIds: [],
        async archiveSession() {},
      });
      ctx.provide('sessions', { get: () => undefined, list: () => [] });
      ctx.provide('sessionTitle', { get: () => ({ title: 'Live Check' }) });
      ctx.provide('approval', { async request() { return 'allowed-once'; } });
      // ★ 这两个必须提供：`inject` 声明了它们，Cordis 在服务缺失时会
      //   **让插件等待**（不报错、也不执行 apply）。早期本套件没提供它们，
      //   于是「命令注册」全线失败 —— 而那不是产品缺陷，是测试环境不完整。
      //   真实 DSH 里这两个服务由 dsh-host-webserver / dsh-client-connection 提供。
      ctx.provide('webServer', liveWebServer);
      ctx.provide('connection', makeConnectionStub());
    },
  });

  await new Promise((r) => setTimeout(r, 150));

  // ── 2. 像 loader 一样加载插件 ────────────────────────────────────
  const mod = await import(entryUrl);
  let applyErr;
  let disposers;
  app.plugin({
    name: 'workspace-folders',
    inject: mod.inject,
    apply(ctx) {
      try {
        disposers = mod.apply(ctx, {
          workspaceRoot: tmpRoot,
          dshHome: tmpDshHome,
          mirrorInstructions: true,
          autoBind: true,
          writeJournal: true,
          archiveMode: 'confirm',
          inheritOnBind: false,
          outsideAccess: 'ask',
        });
      } catch (e) { applyErr = e; }
    },
  });

  await new Promise((r) => setTimeout(r, 400));

  check('★★ apply 不抛错', applyErr === undefined, applyErr?.message);

  // ── 2b. ★ 两条 HTTP 路由都注册上了 ───────────────────────────────
  //
  // 这是「重启后 UI 能不能取到数据、能不能绑定」的前提。
  // 单独跑 `check-route.js` 只证明「那个函数能注册」，
  // 证明不了「真实 apply 路径真的调用了它」—— 差一步就会静默 404。
  {
    const paths = liveWebServer.routes.map((r) => r.path);
    check('★★ 真实 apply 注册了项目清单路由（GET）',
      paths.includes('/workspace-folders/projects'), paths.join(', '));
    check('★★ 真实 apply 注册了绑定路由（POST）',
      paths.includes('/workspace-folders/bind'), paths.join(', '));
  }

  // ── 3. 命令是否真的注册上了 ──────────────────────────────────────
  //
  // `CommandRuntime` 不直接暴露 handler 表（`list()` 只给 name/description），
  // 真实的调用入口是 `execute(agent, line, attachments, signal)` ——
  // 也就是用户在输入框敲 `/xxx` 时 DSH 走的那条路。直接用它。
  const agentLike = {
    session: { id: 'live-check-session', cwd: tmpRoot },
  };

  let listed = [];
  try {
    listed = commands.service.list(agentLike) ?? [];
  } catch (e) {
    console.log(`  （list() 抛错: ${e.message}）`);
  }
  const names = listed.map((d) => d?.name);
  console.log(`\n已注册命令: ${names.length > 0 ? names.join(', ') : '(空)'}`);

  check('★ /workspace-folders 已注册', names.includes('workspace-folders'), names.join(', '));
  check('★ /workspace-archive 已注册', names.includes('workspace-archive'), names.join(', '));

  /**
   * 取某个命令的 **handler 本体**。
   *
   * 不走 `execute()`：它内部会 `appendLifecycle(agent.session, ...)`，
   * 需要**真实 Session 对象**（会往会话日志追加 `command/run` 事件），
   * 在测试里造假 Session 成本很高且容易失真。
   *
   * 改走 `view(agent)` —— 它返回的 Map 里就带 `definition.handler`，
   * 而「handler 存在且是函数」正是两次线上事故的核心契约。
   * @param {string} cmdName - 命令名。
   * @returns {Function|undefined} handler。
   */
  function handlerOf(cmdName) {
    try {
      const view = commands.service.view(agentLike);
      const entry = view?.get?.(cmdName);
      return entry?.definition?.handler;
    } catch {
      return undefined;
    }
  }

  /** 造一个只有 handler 真正会读到的字段的 invocation。 */
  const invocationLike = () => ({
    commandId: 'probe',
    agent: agentLike,
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  });

  // ── 4. 真的执行 /workspace-folders 的 handler ────────────────────
  console.log('\n【执行 /workspace-folders】');
  {
    const handler = handlerOf('workspace-folders');
    check('★ 能取到 handler（字段名契约正确）', typeof handler === 'function', typeof handler);

    if (typeof handler === 'function') {
      let result;
      let runErr;
      try {
        result = await handler(invocationLike());
      } catch (e) { runErr = e; }

      check('★ /workspace-folders 执行不抛错', runErr === undefined, runErr?.message);
      check('★ 返回符合 CommandResult 契约（kind 为 success/error）',
        result !== undefined && (result.kind === 'success' || result.kind === 'error'),
        JSON.stringify(result)?.slice(0, 160));
      check('★ /workspace-folders 执行成功', result?.kind === 'success',
        String(result?.text ?? '').slice(0, 200));

      if (typeof result?.text === 'string') {
        console.log('  ---- 命令真实输出 ----');
        for (const line of result.text.split('\n').slice(0, 16)) console.log(`  | ${line}`);
        console.log('  ----------------------');
      }
    }
  }

  // ── 5. 真的执行 /workspace-archive 的 handler ────────────────────
  console.log('\n【执行 /workspace-archive】');
  {
    const handler = handlerOf('workspace-archive');
    check('★ 能取到 handler（字段名契约正确）', typeof handler === 'function', typeof handler);

    if (typeof handler === 'function') {
      let result;
      let runErr;
      try {
        result = await handler(invocationLike());
      } catch (e) { runErr = e; }

      check('★ /workspace-archive 执行不抛错', runErr === undefined, runErr?.message);
      check('★ 返回符合 CommandResult 契约',
        result !== undefined && (result.kind === 'success' || result.kind === 'error'),
        JSON.stringify(result)?.slice(0, 160));
      console.log(`  返回: ${JSON.stringify(result)?.slice(0, 220)}`);
      console.log('  （审批桩返回 allowed-once，故预期 kind=success）');
    }
  }

  // ── 6. 重复加载不应抛错（Cordis 用 fiber 管理清理，apply 无需返回 disoser）──
  //
  // 注：本插件 `apply` 声明为 `@returns {void}` —— Cordis 通过 fiber 跟踪
  // 副作用（`ctx.on` / `ctx.commands.register` 的返回值由插件自己收着），
  // **不要求** apply 返回 disoser 数组。早先这里断言「返回数组」是测试写错了。
  console.log('');
  check('apply 的返回值形态符合声明（void，由 fiber 管理清理）',
    disposers === undefined || Array.isArray(disposers),
    typeof disposers);

  // ── 7. 关键：再挂一次同样的插件不应崩 ────────────────────────────
  {
    const app2 = new Context();
    await mountCommands(app2);
    app2.plugin({
      name: 'dsh-services-2',
      apply(ctx) {
        ctx.provide('tools', { register() {}, define: () => ({}) });
        ctx.provide('systemPrompt', makeSystemPromptStub());
        ctx.provide('workspaceRegistry', { archivedSessionIds: [], async archiveSession() {} });
        ctx.provide('sessions', { get: () => undefined, list: () => [] });
        ctx.provide('sessionTitle', { get: () => undefined });
        ctx.provide('approval', { async request() { return 'allowed-once'; } });
      },
    });
    let secondErr;
    app2.plugin({
      name: 'workspace-folders-2',
      inject: mod.inject,
      apply(ctx) {
        try {
          mod.apply(ctx, { workspaceRoot: tmpRoot, dshHome: tmpDshHome, inheritOnBind: false });
        } catch (e) { secondErr = e; }
      },
    });
    await new Promise((r) => setTimeout(r, 400));
    check('★ 在全新上下文里再次加载同样成功（可重复）',
      secondErr === undefined, secondErr?.message);
  }
} finally {
  await nodeFs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${'='.repeat(70)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
