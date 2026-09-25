/**
 * 探针：复刻 dsh-client-modules 的 `nearestPackage` 解析，验证我们的
 * `file:///D:/.../src/index.js` 条目能否被识别为一个**客户端插件包**。
 *
 * 依据源码（`@deepseek-ai/dsh-client-modules/lib/index.js`）：
 *
 * ```js
 * locatePkgJson(loaderName, baseUrl) {
 *   if (loaderName.startsWith("cordis:")) return undefined;
 *   const pathLike = loaderName.startsWith(".") || loaderName.startsWith("file:") || isAbsolute(loaderName);
 *   const expectedPackageName = pathLike ? undefined : exactPackageSpecifier(loaderName);
 *   ...
 * }
 * nearestPackage(moduleUrl, expectedPackageName) {
 *   let dir = dirname(fileURLToPath(moduleUrl));
 *   while (true) {
 *     const candidate = join(dir, "package.json");
 *     if (existsSync(candidate)) { ... }
 *     ...
 *   }
 * }
 * ```
 *
 * 关键点：`file:` 开头时 `expectedPackageName === undefined`，
 * 于是 `nearestPackage` **接受任意** package.json —— 只要它声明了
 * `dsh.client.platform === 'web'` 且 `exports` 里有 `./client`。
 *
 * @module dsh-workspace-folders/scripts/check-client-discovery
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const ENTRY = 'file:///D:/Wasio/Workspace/dsh-workspace-folders/src/index.js';
const CLIENT_EXPORT_KEY = './client';

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

/**
 * 复刻 `nearestPackage`：从模块 URL 向上找最近的 package.json。
 * @param {string} moduleUrl - `file:` URL。
 * @returns {string|undefined} package.json 路径。
 */
function nearestPackage(moduleUrl) {
  if (!moduleUrl.startsWith('file:')) return undefined;
  let dir = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * 复刻 `clientExportOf`：读 `exports['./client']` 的实际相对路径。
 * @param {string} pkgName - 包名。
 * @param {unknown} exportsField - `exports` 字段。
 * @returns {string|undefined} 相对路径。
 */
function clientExportOf(pkgName, exportsField) {
  if (exportsField === null || typeof exportsField !== 'object') return undefined;
  const entry = exportsField[CLIENT_EXPORT_KEY];
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object') {
    const d = entry.default;
    if (typeof d === 'string') return d;
  }
  return undefined;
}

console.log('客户端插件发现链路（复刻 dsh-client-modules）');
console.log('='.repeat(70));

const pkgPath = nearestPackage(ENTRY);
check('★ 能从入口 URL 向上找到 package.json', pkgPath !== undefined, String(pkgPath));

if (pkgPath !== undefined) {
  console.log(`  发现: ${pkgPath}`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  check('★ 包名是 dsh-workspace-folders', pkg.name === 'dsh-workspace-folders', pkg.name);

  const decl = pkg.dsh?.client;
  check('★★ 声明了 dsh.client', decl !== undefined,
    '没有 dsh.client → 浏览器不会加载客户端半边');

  if (decl !== undefined) {
    check('★★ dsh.client.platform === "web"', decl.platform === 'web', String(decl.platform));
    check('★ 没有非法字段（inject 必须是字符串数组或省略）',
      decl.inject === undefined || Array.isArray(decl.inject),
      JSON.stringify(decl.inject));
  }

  const rel = clientExportOf(pkg.name, pkg.exports);
  check('★★ exports 里有 "./client"', rel !== undefined,
    JSON.stringify(pkg.exports));

  // ★ 模块加载器要求注册的 id **精确等于包名**。
  //   `dsh-client-modules` 装载后校验 `factories.has(id)`，id 取自清单行的包名；
  //   不匹配会抛 "loaded without registering" 并拒绝装配整个客户端半边。
  if (rel !== undefined) {
    const clientSrc = readFileSync(join(dirname(pkgPath), rel), 'utf8');
    // 注意 `load({` 与 `id:` 之间可能有注释，所以不能假设它们相邻。
    const loadIdx = clientSrc.indexOf('__ModuleLoader__.load(');
    const idMatch = loadIdx < 0
      ? null
      : clientSrc.slice(loadIdx, loadIdx + 800).match(/\bid:\s*'([^']+)'/);
    check('★★ __ModuleLoader__ 注册的 id 等于包名',
      idMatch?.[1] === pkg.name,
      `注册 id=${idMatch?.[1]}，包名=${pkg.name}`);
  }

  if (rel !== undefined) {
    const abs = join(dirname(pkgPath), rel);
    check('★ "./client" 指向的文件真实存在', existsSync(abs), abs);
    console.log(`  客户端入口: ${abs}`);
  }
}

console.log(`\n${'='.repeat(70)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
