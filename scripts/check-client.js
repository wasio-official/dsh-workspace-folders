/**
 * 需求 ⑤ 的客户端插件验证。
 *
 * 这个测试用**假浏览器环境**（造 `window.__ModuleLoader__`）加载
 * `client/client.js`，因此验的是**真实文件**，而不是重写一份逻辑。
 *
 * 覆盖：
 *   1. 模块约定 —— 正确的 `__ModuleLoader__.load` 形状与具名导出；
 *   2. 同文件夹判定 —— cwd 归一化、running、排除子代理；
 *   3. ★ 让位顺序 —— **先归档自己、再跳转**；
 *   4. 安全检查 —— 无 cwd 不动手、只让位一次、归档失败仍跳转；
 *   5. 降级 —— 服务缺失时安静待命，不抛错。
 *
 * 运行：node scripts/check-client.js
 * @module dsh-workspace-folders/scripts/check-client
 */

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    console.log(`[FAIL] ${label}${detail === undefined ? '' : `  ← ${detail}`}`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const clientFile = path.join(here, '..', 'client', 'client.js');

/**
 * 在假浏览器环境里加载客户端插件。
 *
 * ⚠️ 每次都读源码重新求值，**不复用同一个模块实例** —— 插件内部有
 * 「只让位一次」的 `yielded` 集合，复用实例会让后续用例被静默跳过，
 * 表现为「调用记录为空」的假失败。
 * @returns {Promise<object>} 插件导出对象（含 `__test`）。
 */
async function loadClientPlugin() {
  const source = await nodeFs.readFile(clientFile, 'utf8');
  let captured;

  // 造出最小可用的浏览器环境。
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec;
      },
    },
  };

  const prevWarn = console.warn;
  console.warn = () => {};
  try {
    // eslint-disable-next-line no-new-func
    const run = new Function('window', 'globalThis', `${source}\nreturn window.__ModuleLoader__;`);
    run(fakeWindow, fakeWindow);
  } finally {
    console.warn = prevWarn;
  }

  if (captured === undefined) throw new Error('客户端插件未调用 __ModuleLoader__.load');
  return { spec: captured, exports: captured.factory(() => { throw new Error('不应 require'); }) };
}

/**
 * 造一个假的 `sessions.list` 快照。
 * @param {object} rows - `{ id: { cwd, running, ... } }`。
 * @param {string} current - 当前会话 id。
 * @returns {object} 快照。
 */
function makeListState(rows, current) {
  const byId = {};
  const ids = [];
  let t = 1000;
  for (const [id, row] of Object.entries(rows)) {
    byId[id] = {
      sessionId: id,
      updatedAt: row.updatedAt ?? (t += 10),
      running: row.running ?? false,
      blank: false,
      ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
      ...(row.origin === undefined ? {} : { origin: row.origin }),
      ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
    };
    ids.push(id);
  }
  return { ids, byId, current };
}

/**
 * 造一个记录调用的假 ctx。
 * @param {object} options - 入参。
 * @param {object} options.listState - 会话列表快照。
 * @param {object} [options.folderSessions] - `会话 id → 子文件夹` 归属表。
 * @param {boolean} [options.noUiWorkspace] - 是否不提供 uiWorkspace。
 * @param {boolean} [options.noFolderStore] - 是否不提供 workspaceFolders。
 * @param {Error} [options.archiveThrows] - 归档要抛的错。
 * @param {boolean} [options.noSubscribe] - 是否不提供 subscribe。
 * @returns {object} 假 ctx 与调用记录。
 */
function makeCtx({
  listState, folderSessions = {}, noUiWorkspace = false, noFolderStore = false,
  archiveThrows, noSubscribe = false,
}) {
  const calls = [];
  const cleanups = [];
  let listener;
  const store = {
    getSnapshot: () => listState,
    ...(noSubscribe ? {} : { subscribe: (fn) => { listener = fn; return () => { listener = undefined; }; } }),
  };
  const ctx = {
    sessions: { list: store },
    effect: (fn) => {
      const cleanup = fn();
      cleanups.push(typeof cleanup === 'function' ? cleanup : () => {});
      return () => {};
    },
  };
  if (!noFolderStore) {
    ctx.workspaceFolders = { getSnapshot: () => ({ sessions: folderSessions }) };
  }
  if (!noUiWorkspace) {
    ctx.uiWorkspace = {
      async archiveSession(id) {
        calls.push(['archive', id]);
        if (archiveThrows !== undefined) throw archiveThrows;
      },
      openSession(id) {
        calls.push(['open', id]);
      },
    };
  }
  return {
    ctx,
    calls,
    poke: () => listener?.(),
    dispose: () => { for (const fn of cleanups) fn(); },
  };
}

/** 主流程。 */
async function main() {
  console.log('需求⑤ 客户端插件验证');
  console.log('='.repeat(72));

  const loaded = await loadClientPlugin();

  // ── 1. 模块约定 ─────────────────────────────────────────────────
  console.log('\n【模块约定】');
  check('★ 调用 window.__ModuleLoader__.load', loaded.spec !== undefined);
  // ⚠️ id 必须精确等于 package.json 的 name —— `dsh-client-modules` 会校验
  //    `factories.has(id)`，不匹配就抛错并拒绝装配客户端半边。
  check('★★ 插件 id 等于包名（模块加载器要求）',
    loaded.spec.id === 'dsh-workspace-folders', loaded.spec.id);
  check('factory 是函数', typeof loaded.spec.factory === 'function');
  check('★ 具名导出 apply', typeof loaded.exports.apply === 'function');
  check('★ 具名导出 inject（数组）', Array.isArray(loaded.exports.inject), JSON.stringify(loaded.exports.inject));
  check('★ inject 含 uiWorkspace（跳转能力）',
    loaded.exports.inject.includes('uiWorkspace'), JSON.stringify(loaded.exports.inject));
  check('★ inject 含 sessions（读列表能力）',
    loaded.exports.inject.includes('sessions'), JSON.stringify(loaded.exports.inject));
  // ⚠️ 这里**必须不含** `workspaceFolders`。
  //    那是**宿主半自造**的服务（DSH 全树检索：`workspaceFolders` 出现 0 次），
  //    浏览器侧不存在。写进客户端 inject 会让 Cordis **永远等待**：
  //      dsh-workspace-folders: pending (waiting for service: workspaceFolders)
  //    整个客户端半边因此不激活，Web 启动报「1 entry did not activate」。
  //    早期这条断言写反了（要求含它），等于把线上事故固定成了期望行为。
  check('★★ inject 不含 workspaceFolders（那是宿主服务，客户端不存在）',
    !loaded.exports.inject.includes('workspaceFolders'),
    JSON.stringify(loaded.exports.inject));
  check('★ inject 含 slots（挂 UI 的能力）',
    loaded.exports.inject.includes('slots'), JSON.stringify(loaded.exports.inject));

  const { findLiveSiblings, normalizePath } = loaded.exports.__test;

  // ── 2. 路径归一化 ───────────────────────────────────────────────
  console.log('\n【路径归一化】');
  check('反斜杠统一成正斜杠', normalizePath('D:\\Wasio\\Work') === 'd:/wasio/work', normalizePath('D:\\Wasio\\Work'));
  check('★ Windows 路径忽略大小写',
    normalizePath('D:\\Wasio\\Work') === normalizePath('d:/wasio/work'));
  check('去掉尾部斜杠', normalizePath('/a/b/') === '/a/b');
  check('非字符串返回空串', normalizePath(undefined) === '' && normalizePath(42) === '');

  // ── 3. 同文件夹判定（依据是子文件夹归属，**不是** cwd）─────────────
  console.log('\n【同文件夹活跃会话判定】');
  {
    const state = makeListState({
      me: { cwd: 'D:\\Wasio\\Workspace', running: true },
      sibling: { cwd: 'D:\\Wasio\\Workspace', running: true },
      stopped: { cwd: 'D:\\Wasio\\Workspace', running: false },
      elsewhere: { cwd: 'D:\\Wasio\\Workspace', running: true },
      sub: { cwd: 'D:\\Wasio\\Workspace', running: true, origin: 'subagent' },
    }, 'me');
    const folders = { me: '2026-09-24-fix-auth', sibling: '2026-09-24-fix-auth', stopped: '2026-09-24-fix-auth', sub: '2026-09-24-fix-auth', elsewhere: '2026-09-24-other-task' };

    const live = findLiveSiblings(state, 'me', folders);
    check('★ 找到同子文件夹且 running 的兄弟',
      live.length === 1 && live[0].sessionId === 'sibling', JSON.stringify(live.map((r) => r.sessionId)));
    check('★ 同文件夹但已停止的被排除', !live.some((r) => r.sessionId === 'stopped'));
    check('★ 同工作区但不同子文件夹的被排除（关键）',
      !live.some((r) => r.sessionId === 'elsewhere'));
    check('★ 子代理被排除', !live.some((r) => r.sessionId === 'sub'));
  }
  {
    // ★ 回归：cwd 是**工作区根**，352 个会话全都一样。
    // 曾经拿 cwd 当兄弟判据 → 会把整个工作区当成一个文件夹，误跳到无关对话。
    const state = makeListState({
      me: { cwd: 'D:\\Wasio\\Workspace', running: true },
      a: { cwd: 'D:\\Wasio\\Workspace', running: true },
      b: { cwd: 'D:\\Wasio\\Workspace', running: true },
    }, 'me');
    check('★ cwd 相同**不足以**判定为兄弟（防同工作区误跳）',
      findLiveSiblings(state, 'me', { me: 'task-A', a: 'task-B', b: 'task-C' }).length === 0);
    check('★ 归属表完全缺失时不判定（宁可不做也不乱跳）',
      findLiveSiblings(state, 'me', undefined).length === 0);
    check('★ 自己在归属表里没有记录时不判定',
      findLiveSiblings(state, 'me', { a: 'task-B' }).length === 0);
  }
  {
    const state = makeListState({ me: { running: true }, other: { running: true } }, 'me');
    check('自己不在会话列表时返回空',
      findLiveSiblings(state, 'me', { me: 'f' }).length === 0);
    check('找不到 current 的未知 id 返回空',
      findLiveSiblings(state, 'nope', { nope: 'f' }).length === 0);
  }
  {
    const state = makeListState({
      me: { running: true },
      a: { running: true, updatedAt: 100 },
      b: { running: true, updatedAt: 900 },
    }, 'me');
    const folders = { me: 'same', a: 'same', b: 'same' };
    const live = findLiveSiblings(state, 'me', folders);
    check('★ 多个兄弟时按 updatedAt 降序（优先跳最近的）',
      live[0].sessionId === 'b', JSON.stringify(live.map((r) => [r.sessionId, r.updatedAt])));
  }

  // ── 4. ★ 让位顺序（最关键） ──────────────────────────────────────
  console.log('\n【让位顺序：先归档自己，再跳转】');
  {
    const state = makeListState({
      me: { cwd: 'D:\\X', running: true },
      target: { cwd: 'D:\\X', running: true },
    }, 'me');
    const { ctx, calls } = makeCtx({ listState: state, folderSessions: { me: 'same', target: 'same' } }); const fresh = await loadClientPlugin();
    fresh.exports.apply(ctx);
    await new Promise((r) => setTimeout(r, 30));

    check('★ 发生了两次动作', calls.length === 2, JSON.stringify(calls));
    check('★ 第一个动作是归档**自己**',
      calls[0]?.[0] === 'archive' && calls[0]?.[1] === 'me', JSON.stringify(calls));
    check('★ 第二个动作是跳转到目标',
      calls[1]?.[0] === 'open' && calls[1]?.[1] === 'target', JSON.stringify(calls));
    check('★ 顺序正确（先 archive 后 open）—— DSH 会先清空选择再交接受',
      calls[0][0] === 'archive' && calls[1][0] === 'open');
  }
  {
    // 没有兄弟 → 不该有任何动作
    const state = makeListState({ me: { cwd: 'D:\\X', running: true } }, 'me');
    const { ctx, calls } = makeCtx({ listState: state, folderSessions: { me: 'same', target: 'same' } }); const fresh = await loadClientPlugin();
    fresh.exports.apply(ctx);
    await new Promise((r) => setTimeout(r, 30));
    check('★ 没有活跃兄弟时什么都不做', calls.length === 0, JSON.stringify(calls));
  }
  {
    // 兄弟已停止 → 不该跳（那是 ④ 的活）
    const state = makeListState({
      me: { cwd: 'D:\\X', running: true },
      dead: { cwd: 'D:\\X', running: false },
    }, 'me');
    const { ctx, calls } = makeCtx({ listState: state, folderSessions: { me: 'same', target: 'same' } }); const fresh = await loadClientPlugin();
    fresh.exports.apply(ctx);
    await new Promise((r) => setTimeout(r, 30));
    check('★ 兄弟已停止时不跳转（交给宿主侧④处理）', calls.length === 0, JSON.stringify(calls));
  }

  // ── 5. 容错 ─────────────────────────────────────────────────────
  console.log('\n【容错】');
  {
    const state = makeListState({
      me: { cwd: 'D:\\X', running: true },
      target: { cwd: 'D:\\X', running: true },
    }, 'me');
    const { ctx, calls } = makeCtx({
      listState: state, folderSessions: { me: 'same', target: 'same' }, archiveThrows: new Error('archive boom'),
    }); const fresh = await loadClientPlugin();
    fresh.exports.apply(ctx);
    await new Promise((r) => setTimeout(r, 30));
    check('★ 归档失败时**仍然跳转**（用户至少被带到正确对话）',
      calls.some((c) => c[0] === 'open' && c[1] === 'target'), JSON.stringify(calls));
  }
  {
    const state = makeListState({
      me: { cwd: 'D:\\X', running: true },
      target: { cwd: 'D:\\X', running: true },
    }, 'me');
    const { ctx, calls, poke, dispose } = makeCtx({ listState: state, folderSessions: { me: 'same', target: 'same' } }); const fresh = await loadClientPlugin();
    fresh.exports.apply(ctx);
    await new Promise((r) => setTimeout(r, 30));
    const afterFirst = calls.length;
    // 反复触发订阅 → 不应重复让位
    poke(); poke();
    await new Promise((r) => setTimeout(r, 30));
    check('★ 只让位一次（订阅重复触发不会反复跳转）',
      calls.length === afterFirst, `${afterFirst} → ${calls.length}`);
  }
  {
    const state = makeListState({ me: { cwd: 'D:\\X', running: true } }, 'me');
    const { ctx, calls } = makeCtx({ listState: state, noUiWorkspace: true });
    let threw = false;
    try { const fresh = await loadClientPlugin();
    fresh.exports.apply(ctx);
      await new Promise((r) => setTimeout(r, 20));
    } catch { threw = true; }
    check('★ 缺 uiWorkspace 时安静待命、不抛错', threw === false && calls.length === 0);
  }
  {
    // 没有 subscribe 能力时走轮询退路，仍能工作
    const state = makeListState({
      me: { cwd: 'D:\\X', running: true },
      target: { cwd: 'D:\\X', running: true },
    }, 'me');
    const { ctx, calls, dispose } = makeCtx({
      listState: state,
      folderSessions: { me: 'same', target: 'same' },
      noSubscribe: true,
    });
    const fresh = await loadClientPlugin();
    fresh.exports.apply(ctx);
    await new Promise((r) => setTimeout(r, 30));
    check('★ 无 subscribe 时退化为轮询并仍能工作',
      calls.some((c) => c[0] === 'open'), JSON.stringify(calls));
    // 必须清掉 interval，否则 Node 进程不会退出。
    dispose();
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

await main();
