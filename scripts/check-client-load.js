/**
 * 客户端半边的**加载与注册**验证。
 *
 * ## 为什么必须有这套件
 *
 * 前三次「测试全绿、装上就崩」都出在**宿主半边**，根因是测试替身太宽松。
 * 这一轮我发现了一个同类问题、但更致命：客户端半边**从来没有被浏览器加载过** ——
 * `package.json` 缺 `dsh.client` 声明，`dsh-client-modules` 扫描时直接
 * 判定「不是客户端包」，于是**需求⑤（自动让位跳转）与新增的「项目选择器」
 * 一行代码都没跑过**。
 *
 * 而当时全量测试是通过的 —— 因为没有一个套件去验证「这个包会不会被加载」。
 * 本套件就是补这一课：它**真的执行** `client/client.js`，
 * 用假的 `window.__ModuleLoader__` 捕获注册结果，再检查：
 *
 * 1. 模块能被加载、导出了 `name` / `inject` / `apply`；
 * 2. `apply` 真的往插槽注册了组件；
 * 3. **注册的插槽不是 `conversation.hero.workspace`**（那是 single，会挤掉原生 UI）；
 * 4. 插槽名与宿主路由常量**两边一致**（最容易写错又最难发现的地方）。
 *
 * @module dsh-workspace-folders/scripts/check-client-load
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

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

const ROOT = path.join(import.meta.dirname, '..');

console.log('客户端半边：加载与插槽注册');
console.log('='.repeat(70));

// ── 1. 用假的模块加载器执行 client.js ──────────────────────────────
let captured;
const fakeRequire = (spec) => {
  if (spec === 'react') {
    return {
      useState: (init) => [init, () => {}],
      useEffect: () => {},
      memo: (c) => c,
      createElement: () => ({}),
    };
  }
  if (spec === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}) };
  // ⚠️ 真实加载器的 `require` **不接受相对路径**：
  //    `stripClientSuffix(spec)` 得到的是**包名**，三处查找都匹配不上就抛错。
  //    这里刻意复刻该行为，让「偷偷 require 本地文件」在测试里就炸掉，
  //    而不是等到浏览器里报 "missed the module table"。
  if (/^\.\.?\//.test(spec)) {
    throw new Error(`client-modules: require("${spec}") missed the module table`);
  }
  throw new Error(`unexpected require: ${spec}`);
};

globalThis.window = {
  __ModuleLoader__: {
    load(spec) { captured = spec; },
  },
};

const source = readFileSync(path.join(ROOT, 'client', 'client.js'), 'utf8');

// ── ★ 客户端 bundle 必须自包含 ─────────────────────────────────────
//
// 客户端的 `require` 只在「平台种子 / 已物化模块 / 已注册的**包**工厂」
// 三处查找（见 dsh-client-modules 的 `makeRequire`），
// `id` 由 `stripClientSuffix(spec)` 得到 —— 那是包名。
// **相对路径必然抛 `missed the module table`**。
//
// ⚠️ 扫描前必须**去掉注释**：本文件的注释里就引用了 `require('./picker.js')`
//    作为反例，线上代码里也有 `ctx.workspaceFolders` 的说明文字。
//    不剔注释会产生**假阳性** —— 这个坑在 check-contracts.js 里踩过一次。
/**
 * 去掉块注释与行注释，只留可执行代码。
 *
 * 会先把字符串字面量抠出来占位，避免 `//` 出现在字符串里被误删。
 * @param {string} text - 源码。
 * @returns {string} 去掉注释的源码。
 */
function stripComments(text) {
  const strings = [];
  // 先把 '...' "..." `...` 换成占位符。
  const withoutStrings = text.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, (m) => {
    strings.push(m);
    return `\u0000${strings.length - 1}\u0000`;
  });
  const stripped = withoutStrings
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  // 还原字符串。
  return stripped.replace(/\u0000(\d+)\u0000/g, (_m, i) => strings[Number(i)]);
}

const code = stripComments(source);

{
  const relativeRequires = [...code.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)]
    .map((m) => m[1]);
  check('★★ client.js 里没有相对路径 require（bundle 必须自包含）',
    relativeRequires.length === 0,
    `发现：${relativeRequires.join(', ')}`);

  const bareRequires = [...code.matchAll(/require\(\s*['"]([^'".][^'"]*)['"]\s*\)/g)]
    .map((m) => m[1]);
  check('★ 只 require 平台种子（react 系列）',
    bareRequires.every((s) => s === 'react' || s === 'react/jsx-runtime'),
    JSON.stringify([...new Set(bareRequires)]));
}

// ── ★ 客户端服务名必须真实存在（不能写宿主服务）────────────────────
//
// `workspaceFolders` 是**宿主半自造**的服务，浏览器侧不存在。
// 写进 inject 会让 Cordis 永远等待：
//   dsh-workspace-folders: pending (waiting for service: workspaceFolders)
// 从而整个客户端半边不激活、Web 启动报「1 entry did not activate」。
{
  check('★★ inject 里没有 workspaceFolders（宿主服务，客户端不存在）',
    !/inject\s*=\s*\[[^\]]*workspaceFolders/.test(code),
    '客户端 inject 里出现了 workspaceFolders');

  check('★★ 代码里没有裸的 ctx.workspaceFolders 访问',
    !/ctx\.workspaceFolders/.test(code),
    '出现了 ctx.workspaceFolders（Cordis 会抛 without inject 并打断 apply）');
}
// 用一个函数包住源码执行，避免污染全局。
// eslint-disable-next-line no-new-func
new Function('require', 'globalThis', source)(fakeRequire, globalThis);

check('★ client.js 调用了 __ModuleLoader__.load', captured !== undefined);

// ⚠️ id 必须精确等于包名。
//   `dsh-client-modules` 装载后校验 `factories.has(id)`，其中 id 取自清单行的
//   包名；不匹配会抛 "bundle ... loaded without registering ..." 并拒绝装配。
{
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('★★ __ModuleLoader__ 的 id 精确等于包名',
    captured?.id === pkg.name,
    `注册 id=${captured?.id}，包名=${pkg.name}`);
}

const mod = captured?.factory?.(fakeRequire);
check('★ factory 返回了 module.exports', mod !== undefined);
check('★ 导出了 inject 数组', Array.isArray(mod?.inject), typeof mod?.inject);
check('★ 导出了 apply 函数', typeof mod?.apply === 'function', typeof mod?.apply);
check('★ 没有用 export default（会丢 inject）', mod?.default === undefined);

// ── 2. inject 里包含 slots ─────────────────────────────────────────
console.log('\n【2】服务注入声明');
{
  const inject = mod?.inject ?? [];
  check('★ 声明了 uiWorkspace', inject.includes('uiWorkspace'), JSON.stringify(inject));
  check('★ 声明了 sessions', inject.includes('sessions'));
  check('★ 声明了 slots（选择器要用）', inject.includes('slots'), JSON.stringify(inject));
}

// ── 3. apply 真的注册插槽 ──────────────────────────────────────────
console.log('\n【3】apply 的插槽注册');
const registrations = [];
const injected = [];
const effects = [];

const ctx = {
  uiWorkspace: {
    openSession() {},
    archiveSession: async () => {},
    clearArchivedCurrent() {},
  },
  sessions: { list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined }) } },
  // ⚠️ 刻意**不提供** `workspaceFolders` —— 那是宿主半自造的服务，
  //    浏览器侧不存在。提供它会让测试假装这条路径可用。
  slots: {
    inject(name, cb) { injected.push(name); return cb(); },
    register(entry, Component) {
      registrations.push({ entry, Component });
      return () => {};
    },
  },
  effect(fn, label) { effects.push(label); return fn(); },
};

try {
  mod.apply(ctx);
} catch (error) {
  check('apply 不抛错', false, String(error?.stack ?? error));
}

check('★ apply 往某个插槽注入了', injected.length > 0, JSON.stringify(injected));
check('★ 注册了组件', registrations.length > 0,
  `实际 ${registrations.length} 个注册`);

// ── 4. ★ 插槽选择：不能挤掉原生「选择工作区」──────────────────────
console.log('\n【4】插槽选择（关键）');
{
  const names = injected.slice();
  check('★★ 没有占用 conversation.hero.workspace（那是 single，会挤掉原生 UI）',
    !names.includes('conversation.hero.workspace'), JSON.stringify(names));
  check('★ 用的是 conversation.input.dock',
    names.includes('conversation.input.dock'), JSON.stringify(names));

  const reg = registrations[0];
  check('★ 注册项的 name 与注入的插槽一致',
    reg?.entry?.name === 'conversation.input.dock', JSON.stringify(reg?.entry?.name));
  check('★ 注册项有 id', typeof reg?.entry?.id === 'string' && reg.entry.id.length > 0,
    JSON.stringify(reg?.entry?.id));
  check('★ 注册项 order 是有限数字', Number.isFinite(reg?.entry?.order),
    JSON.stringify(reg?.entry?.order));
  // 不再断言「有 inject 工厂」：我们现在不传 inject（不需要额外 props）。
  // 内置插件里不需要 props 的条目同样是省略它的。
  check('★ 没有多余的 inject 工厂（不需要额外 props）',
    reg?.entry?.inject === undefined, String(reg?.entry?.inject));
  check('★ 传入了组件', reg?.Component !== undefined);
  check('★★ 注册是直接调用 slots.inject（不额外包 ctx.effect）',
    !effects.some((l) => String(l).includes('workspace-folders: project picker')),
    JSON.stringify(effects));
}

// ── 5. ★ 路由常量两边一致 ──────────────────────────────────────────
console.log('\n【5】宿主/客户端路由常量一致');
{
  const hostRoute = readFileSync(path.join(ROOT, 'src', 'route.js'), 'utf8');
  const m = hostRoute.match(/PROJECTS_ROUTE\s*=\s*'([^']+)'/);
  const hostValue = m?.[1];
  const clientValue = mod?.__test?.PROJECTS_ROUTE;

  check('★ 宿主侧定义了 PROJECTS_ROUTE', typeof hostValue === 'string', String(hostValue));
  check('★★ 客户端与宿主的路径**完全一致**', hostValue === clientValue,
    `宿主 ${hostValue} vs 客户端 ${clientValue}`);

  // 绑定路由同理 —— 两边不一致会静默 404。
  const bm = hostRoute.match(/BIND_ROUTE\s*=\s*'([^']+)'/);
  check('★ 宿主侧定义了 BIND_ROUTE', typeof bm?.[1] === 'string', String(bm?.[1]));
  check('★★ 绑定路由两边**完全一致**', bm?.[1] === mod?.__test?.BIND_ROUTE,
    `宿主 ${bm?.[1]} vs 客户端 ${mod?.__test?.BIND_ROUTE}`);
}

// ── 6. ★ 降级：没有 slots 也不能抛错 ───────────────────────────────
console.log('\n【6】降级容错');
{
  let threw = false;
  let message = '';
  try {
    mod.apply({
      uiWorkspace: { openSession() {}, archiveSession: async () => {} },
      sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
      workspaceFolders: { getSnapshot: () => ({ sessions: {} }) },
      // 故意不给 slots
      effect(fn) { return fn(); },
    });
  } catch (error) { threw = true; message = String(error?.message ?? error); }
  check('★ 没有 slots 服务时不抛错（UI 静默缺席）', !threw, message);
}

// ── 7. package.json 必须声明 dsh.client ────────────────────────────
console.log('\n【7】包声明');
{
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('★★ package.json 声明了 dsh.client', pkg.dsh?.client !== undefined,
    '缺了它浏览器不会加载客户端半边 —— 这是需求⑤长期失效的根因');
  check('★ platform 是 web', pkg.dsh?.client?.platform === 'web');
  check('★ exports 有 ./client', pkg.exports?.['./client'] !== undefined);
  check('★ files 里包含 client 目录',
    Array.isArray(pkg.files) && pkg.files.includes('client'), JSON.stringify(pkg.files));
}

console.log(`\n${'='.repeat(70)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;

// `apply` 会为「让位监视」注册 interval（或订阅），在真实环境里由 Cordis
// 的 fiber 在卸载时清理。这里是裸调用，所以必须**显式退出**，
// 否则进程会挂着不退 —— 看起来像卡死，其实是还有活动句柄。
process.exit(failed > 0 ? 1 : 0);
