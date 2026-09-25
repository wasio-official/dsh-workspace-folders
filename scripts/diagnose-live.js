/**
 * 活着的那台 DSH 到底在跑哪一版代码？
 *
 * ## 起因
 *
 * 用户点按钮报 **「工作文件夹405」**。查下来不是新代码的 bug，而是
 * **浏览器/宿主还跑着旧版** —— 而「405」这个信号本身有歧义，
 * 单看状态码分不清是谁在答：
 *
 * | 谁在答 | 非 POST 时的响应 |
 * |---|---|
 * | **本插件的新路由** | `405` + **`Allow: POST`** |
 * | `dsh-host-frontend-static` 的 SPA fallback | `405`，**没有任何 Allow 头** |
 *
 * 判据就是 **`Allow` 头在不在**。fallback 只在**没有任何路由命中**时才跑，
 * 所以裸 405 = 路由没注册 = 旧代码还在跑。
 *
 * ## 用法
 *
 * ```
 * node scripts/diagnose-live.js [--port 3080]
 * ```
 *
 * 会依次探测两条路由，并给出「该重启」还是「代码有问题」的结论。
 *
 * ⚠️ 本脚本**不 spawn 子进程**：本机沙箱禁止管道捕获子进程输出
 * （`stdio:'pipe'` 一律 EPERM），所以用 `fetch` 直接发请求。
 *
 * @module dsh-workspace-folders/scripts/diagnose-live
 */

import { PROJECTS_ROUTE, BIND_ROUTE } from '../src/route.js';

const portArg = process.argv.indexOf('--port');
const PORT = portArg >= 0 ? process.argv[portArg + 1] : '3080';
const BASE = `http://127.0.0.1:${PORT}`;

console.log(`存活诊断：${BASE}`);
console.log('='.repeat(70));

/**
 * 发一个请求，返回状态码与 Allow 头。
 * @param {string} route - 路径。
 * @param {string} method - 方法。
 * @returns {Promise<{status: number, allow: string|undefined, error?: string}>} 结果。
 */
async function probe(route, method) {
  try {
    const res = await fetch(`${BASE}${route}`, {
      method,
      headers: method === 'POST'
        ? { 'content-type': 'application/json' }
        : undefined,
      body: method === 'POST' ? JSON.stringify({ sessionId: 'probe', target: 'probe' }) : undefined,
    });
    return { status: res.status, allow: res.headers.get('allow') ?? undefined };
  } catch (error) {
    return { status: 0, allow: undefined, error: String(error?.message ?? error) };
  }
}

/** 把探测结果写成一行结论。 */
function line(label, r) {
  const allow = r.allow === undefined ? '(无 Allow 头)' : `Allow: ${r.allow}`;
  const err = r.error === undefined ? '' : `  错误: ${r.error}`;
  console.log(`  ${label.padEnd(34)} → ${String(r.status).padStart(3)}  ${allow}${err}`);
  return r;
}

// ── 探测 ────────────────────────────────────────────────────────────
const projectsGet = line(`GET  ${PROJECTS_ROUTE}`, await probe(PROJECTS_ROUTE, 'GET'));
const bindGet = line(`GET  ${BIND_ROUTE}`, await probe(BIND_ROUTE, 'GET'));
const bindPost = line(`POST ${BIND_ROUTE}`, await probe(BIND_ROUTE, 'POST'));

console.log(`\n${'='.repeat(70)}`);

// ── 判定 ────────────────────────────────────────────────────────────
//
// 注意 401/403：那是**信任围栏**在正常工作（curl/fetch 没有浏览器凭据），
// 说明**路由已经注册**了 —— 这反而是好消息。
const fenced = (s) => s === 401 || s === 403;

const bindRegistered = fenced(bindPost.status)
  || (bindPost.status === 400 || bindPost.status === 200 || bindPost.status === 415);

if (bindPost.error !== undefined && bindPost.status === 0) {
  console.log('❌ 连不上 —— 那台 DSH 没在跑，或端口不对。');
  console.log('   按你自己的方式重启 DSH 后重试。');
  process.exitCode = 1;
} else if (bindRegistered) {
  console.log('✅ 绑定路由**已注册**（状态码来自信任围栏或参数校验，说明代码是新的）。');
  console.log(`   POST ${BIND_ROUTE} → ${bindPost.status}${bindPost.allow ? ` (Allow: ${bindPost.allow})` : ''}`);
  console.log('   若浏览器里仍报 405，那是**浏览器缓存的旧客户端**：强制刷新（Ctrl+Shift+R）。');
} else if (bindPost.status === 405 && bindPost.allow === undefined) {
  console.log('⛔ 绑定路由**没有注册** —— 这是「裸 405」，来自 SPA fallback。');
  console.log('   也就是说：宿主进程还在跑**加 /bind 之前**的代码。');
  console.log('');
  console.log('   👉 重启 DSH 即可（当前源码已通过装配验证，重启后会注册）：');
  console.log('      停止后重新启动 dsh web，然后强制刷新浏览器。');
  console.log('');
  console.log('   ⚠️ 不要直接杀承载当前对话的 3080 进程。');
  process.exitCode = 2;
} else if (bindGet.status === 404) {
  console.log('⛔ 绑定路由不存在（GET 404）。宿主是旧代码 —— 同上，重启。');
  process.exitCode = 2;
} else {
  console.log(`⚠️ 情况不明：POST ${BIND_ROUTE} → ${bindPost.status}。`);
  console.log('   请把上面三行贴出来。');
  process.exitCode = 3;
}

console.log('');
console.log(`参考：GET ${PROJECTS_ROUTE} → ${projectsGet.status}` +
  (fenced(projectsGet.status) ? '（信任围栏生效，说明路由在）' : ''));
