/**
 * 用**真实 Cordis 上下文 + 真实 dsh-commands** 验证插件能否真正加载。
 *
 * ## 为什么必须有这个套件
 *
 * 本插件在真实 DSH 上**连续崩了两次**，而当时 289 项断言全绿：
 *
 * 1. `cannot get property "systemPrompt" without inject`
 *    —— 桩 `ctx` 是普通对象，**不做注入校验**；
 * 2. `command "workspace-folders" handler must be a function`
 *    —— 桩 `commands` **接受任何形状**（把 `handler` 误写成了 `run`）。
 *
 * 两次根因相同：**手写桩没有校验**，契约错误就测不出来。
 * 所以本套件挂**真货**：真 `Context` + 真 `CommandRuntime`。
 *
 * @module dsh-workspace-folders/scripts/check-inject
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { loadContext, findDshPackage, mountCommands } from './check-fixtures.js';

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

// ── 定位 DSH，加载真实的 cordis ──────────────────────────────────────
const dshAnchor = findDshPackage();
if (dshAnchor === undefined || !existsSync(dshAnchor)) {
  console.log('跳过：找不到 DSH 安装位置（本套件需要真实 cordis）');
  process.exit(0);
}

const Context = await loadContext();
const plugin = await import('../src/index.js');

console.log('注入与服务契约检查（真实 Cordis + 真实 dsh-commands）');
console.log('='.repeat(68));
console.log(`cordis  : ${dshAnchor}`);
console.log(`inject  : [${plugin.inject.join(', ')}]`);

/**
 * 搭一个最接近真实 loader 的场景：所有服务由**兄弟插件**提供。
 *
 * 关键点：服务**不能**在加载我们的插件之前 provide —— 那样 Cordis 会在
 * 加载时就解析好，反而掩盖 `without inject` 错误（本项目第一版探针就
 * 因此没能复现）。
 * @param {object} [options] - 可选覆盖。
 * @param {Array<string>} [options.skip] - 不提供的服务名。
 * @returns {Promise<{app: object, logs: Array<string>}>} 上下文与日志。
 */
async function buildRealisticContext({ skip = [] } = {}) {
  const app = new Context();
  const logs = [];

  // ★ `commands` 挂**真实实现**（`CommandRuntime`）—— 它会严格校验
  //   `handler` 是否存在。用桩的话，把 handler 写成 run 也能通过，
  //   而那正是线上第二次崩溃的原因。
  let commandsReal = false;
  if (!skip.includes('commands')) {
    const mounted = await mountCommands(app);
    commandsReal = mounted.real;
  }

  // 其余服务没有可独立挂载的真实实现（依赖 agent/session 等重型对象），
  // 用手写桩 —— 但**@see makeCommandsStub 的教训**：桩必须复刻真实校验。
  const providers = {
    tools: { register() {}, define: () => ({}) },
    systemPrompt: { section: () => () => {} },
    workspaceRegistry: {
      archivedSessionIds: [],
      async archiveSession() {},
    },
    sessions: { get: () => undefined, list: () => [] },
    sessionTitle: { get: () => undefined },
    approval: { async request() { return 'allowed-once'; } },
  };
  const provided = Object.keys(providers).filter((k) => !skip.includes(k));

  if (provided.length > 0) {
    app.plugin({
      name: 'providers',
      apply(ctx) {
        for (const key of provided) ctx.provide(key, providers[key]);
      },
    });
  }

  // 我们的插件：真实 apply
  app.plugin({
    name: 'workspace-folders-under-test',
    inject: plugin.inject,
    apply(ctx) {
      try {
        plugin.apply(ctx, { workspaceRoot: process.cwd(), archiveMode: 'manual' });
        logs.push('apply 返回');
      } catch (error) {
        logs.push(`apply 抛错: ${error.message}`);
      }
    },
  });

  await new Promise((r) => setTimeout(r, 250));
  return { app, logs, commandsReal };
}

// ── 1. inject 必须覆盖代码里所有 `ctx.X` 读取 ───────────────────────
console.log('\n【1】静态核对：代码里读的服务是否都已声明');

const { readFileSync, readdirSync } = await import('node:fs');
const srcDir = path.join(import.meta.dirname, '..', 'src');
const serviceNames = [
  'tools', 'systemPrompt', 'commands', 'workspaceRegistry',
  'sessions', 'agents', 'sessionTitle', 'approval', 'fs', 'shell',
];
const declared = new Set(plugin.inject);
const missing = [];

for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
  const text = readFileSync(path.join(srcDir, file), 'utf8');
  for (const svc of serviceNames) {
    // 只找**真正读取**的形态：ctx.X 或 ctx?.X（注释里的不算）
    const re = new RegExp(`ctx\\??\\.${svc}\\b`, 'g');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!re.test(line)) return;
      re.lastIndex = 0;
      const trimmed = line.trim();
      // 跳过注释行
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      if (!declared.has(svc)) {
        missing.push(`${file}:${i + 1}  ctx.${svc}`);
      }
    });
  }
}

check('★ 代码里没有「未声明就 ctx.X 读取」', missing.length === 0,
  missing.length === 0 ? undefined : `\n      ${missing.join('\n      ')}`);
check('inject 是数组', Array.isArray(plugin.inject));

// ── 2. 真实上下文：全服务齐备时能加载 ───────────────────────────────
console.log('\n【2】真实 Cordis 上下文：服务齐备');

{
  const { logs } = await buildRealisticContext();
  const threw = logs.find((l) => l.startsWith('apply 抛错'));
  check('★ 服务齐备时 apply 不抛错（真实 cordis）', threw === undefined, threw);
  check('★ 没有 "without inject" 报错',
    !logs.some((l) => l.includes('without inject')),
    logs.join(' | '));
}

// ── 3. 真实上下文：可选服务缺席时仍能加载（降级） ────────────────────
console.log('\n【3】真实 Cordis 上下文：可选服务缺席（降级不崩）');

{
  const { logs } = await buildRealisticContext({ skip: ['approval', 'sessionTitle'] });
  const threw = logs.find((l) => l.startsWith('apply 抛错'));
  check('★ approval/sessionTitle 缺席时 apply 仍不抛错', threw === undefined, threw);
}

// ── 4. 每个必需服务单独缺席时，Cordis 应「等待」而非报 without inject ──
console.log('\n【4】必需服务缺席：应是等待，不是崩溃');

{
  const { logs } = await buildRealisticContext({ skip: ['systemPrompt'] });
  check('★ systemPrompt 缺席时不出现 without inject',
    !logs.some((l) => l.includes('without inject')), logs.join(' | '));
}

// ── 5. 反例：证明「不声明就读取」确实会炸 ────────────────────────────
//
// 这组断言是**回归护栏**：如果哪天有人把 inject 里的条目删掉，
// 这里会证明后果（抛错），而不是让失败悄悄逃到运行期。
console.log('\n【5】反例：不声明就读取的后果');

{
  const app = new Context();
  app.plugin({
    name: 'provider',
    apply(ctx) { ctx.provide('approval', { request: async () => 'allowed-once' }); },
  });
  let err;
  app.plugin({
    name: 'bad-consumer',
    inject: ['tools'],
    apply(ctx) {
      try { void ctx.approval; } catch (e) { err = e.message; }
    },
  });
  app.provide('tools', {});
  await new Promise((r) => setTimeout(r, 200));

  check('★ 未声明就 ctx.X 会抛错（这就是本次线上事故）',
    typeof err === 'string' && err.includes('without inject'), err);
}

{
  const app = new Context();
  app.plugin({
    name: 'provider2',
    apply(ctx) { ctx.provide('approval', { request: async () => 'allowed-once' }); },
  });
  let viaGet;
  let err;
  app.plugin({
    name: 'get-consumer',
    inject: ['tools'],
    apply(ctx) {
      try { viaGet = ctx.get('approval'); } catch (e) { err = e.message; }
    },
  });
  app.provide('tools', {});
  await new Promise((r) => setTimeout(r, 200));

  check('★ 未声明用 ctx.get() 会**静默**返回 undefined（更隐蔽的坑）',
    viaGet === undefined && err === undefined, `got=${String(viaGet)} err=${err}`);
}

{
  const app = new Context();
  app.plugin({
    name: 'provider3',
    apply(ctx) { ctx.provide('approval', { request: async () => 'allowed-once' }); },
  });
  let got;
  let err;
  app.plugin({
    name: 'good-consumer',
    inject: ['tools', 'approval'],
    apply(ctx) {
      try { got = ctx.approval?.request; } catch (e) { err = e.message; }
    },
  });
  app.provide('tools', {});
  await new Promise((r) => setTimeout(r, 200));

  check('★ 声明后就能正常读到（正确做法）',
    typeof got === 'function' && err === undefined, `got=${typeof got} err=${err}`);
}

{
  // 可选链也挡不住 —— 这是最容易误以为「写了 ?. 就安全」的地方
  const app = new Context();
  app.plugin({
    name: 'provider4',
    apply(ctx) { ctx.provide('approval', { request: async () => 'x' }); },
  });
  let err;
  app.plugin({
    name: 'optional-chain-consumer',
    inject: ['tools'],
    apply(ctx) {
      try { void ctx?.approval?.request; } catch (e) { err = e.message; }
    },
  });
  app.provide('tools', {});
  await new Promise((r) => setTimeout(r, 200));

  check('★ 可选链 `ctx?.X?.y` 同样挡不住（抛错在 getter 内）',
    typeof err === 'string' && err.includes('without inject'), err);
}

console.log(`\n${'='.repeat(68)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
