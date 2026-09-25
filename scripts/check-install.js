/**
 * 安装回归测试：把插件**真的装进一份临时 profile**，按真实 loader 路径重放。
 *
 * ## 为什么需要这一层
 *
 * 线上事故（`cannot get property "systemPrompt" without inject`）发生在
 * **真实 loader** 里，而不是任何单元测试里。既有套件全绿却线上崩溃，
 * 说明缺的是「按真实配置重放」的验证。
 *
 * 本脚本构造一份**临时的 profile patch 文件**（内容与要安装的一模一样），
 * 然后完全按 loader 的行为走一遍：读 YAML → 取 insert → import(name)
 * → 在真实 Context 里 apply（服务由兄弟插件提供）。
 *
 * 这样即使不在本机真正安装，也能确定「装上去会不会炸」。
 *
 * @module dsh-workspace-folders/scripts/check-install
 */

import { promises as nodeFs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import {
  mountCommands, makeSystemPromptStub, makeApprovalStub,
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

console.log('安装回归：把插件装进临时 profile 并按真实 loader 重放');
console.log('='.repeat(72));

// ── 定位 DSH ────────────────────────────────────────────────────────
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const anchors = [
  path.join(home, 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json'),
  path.join(home, 'AppData/Local/npm/node_modules/@deepseek-ai/dsh/package.json'),
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
].filter(existsSync);

if (anchors.length === 0) {
  console.log('跳过：找不到 DSH 安装');
  process.exit(0);
}
const require = createRequire(anchors[0]);
const yaml = await import(pathToFileURL(require.resolve('js-yaml')).href);
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);

const repoRoot = path.join(import.meta.dirname, '..');
const entryUrl = pathToFileURL(path.join(repoRoot, 'src', 'index.js')).href;

// ── 1. 仓库自带的安装模板必须结构正确 ───────────────────────────────
console.log('\n【1】安装模板结构');

const tpl = yaml.load(readFileSync(path.join(repoRoot, 'cordis.patch.yml'), 'utf8'));
check('模板顶层是数组', Array.isArray(tpl));

const tplEntries = (Array.isArray(tpl) ? tpl : []).flatMap((e) => e?.insert ?? []);
const tplOurs = tplEntries.find((e) => e.id === 'workspace-folders');
check('模板含 workspace-folders 条目', tplOurs !== undefined);

if (tplOurs !== undefined) {
  check('模板条目有 name', typeof tplOurs.name === 'string', String(tplOurs.name));
  check('模板条目有 config 对象',
    tplOurs.config !== null && typeof tplOurs.config === 'object');

  // 模板里的配置键必须都是真实存在的配置项
  const { DEFAULTS } = await import('../src/config.js');
  const unknown = Object.keys(tplOurs.config ?? {}).filter((k) => !(k in DEFAULTS));
  check('★ 模板配置键都真实存在（防止模板/代码漂移）',
    unknown.length === 0, `未知键: ${unknown.join(', ')}`);
}

// ── 2. 构造「真实安装形态」的配置并重放 ─────────────────────────────
console.log('\n【2】按真实 loader 路径重放（模拟已安装）');

const installedConfig = {
  workspaceRoot: process.cwd(),
  mirrorInstructions: true,
  autoBind: true,
  writeJournal: true,
  archiveMode: 'confirm',
  inheritOnBind: true,
  outsideAccess: 'ask',
};

const fakeProfile = [
  { id: 'llm-pi-ai', config: { providers: {} } },
  { insert: [{ id: 'workspace-folders', name: entryUrl, config: installedConfig }] },
];

const tmpProfile = path.join(
  process.env.TEMP ?? '/tmp',
  `wbf-profile-${Date.now()}.yml`,
);

try {
  await nodeFs.writeFile(tmpProfile, yaml.dump(fakeProfile), 'utf8');

  // —— 完全按 loader 行为读取 ——
  const doc = yaml.load(readFileSync(tmpProfile, 'utf8'));
  check('临时 profile 可被解析为数组', Array.isArray(doc));

  const inserted = doc.flatMap((e) => e?.insert ?? []);
  const ours = inserted.find((e) => e.id === 'workspace-folders');
  check('能从 insert 里取出我们的条目', ours !== undefined);

  // —— loader 的 import 分支 ——
  let mod;
  let importErr;
  try {
    mod = await import(ours.name);
  } catch (e) {
    importErr = e.message;
  }
  check('★ name 可被 loader import', mod !== undefined, importErr);

  if (mod !== undefined) {
    check('★ 导出 name / inject / apply 三件套',
      typeof mod.name === 'string' && Array.isArray(mod.inject) && typeof mod.apply === 'function');
    check('★ 无 default 导出（否则丢 inject 元数据）', mod.default === undefined);

    // —— 真实 Context，服务由兄弟插件提供 ——
    const app = new Context();

    // ★ `commands` 挂**真实实现**，它严格校验 `handler` 是否存在。
    //   用桩的话，把 handler 写成 run 也会通过 —— 而那正是第二次线上崩溃。
    const commandsMounted = await mountCommands(app);

    const services = {
      tools: { register() {}, define: () => ({}) },
      // ★ 用**按真实契约校验**的樁，而不是 `() => () => {}` 那种宽松樁。
      //   宽松樁放过过真实的崩溃（第一次/第三次事故都是这么漏掉的）。
      systemPrompt: makeSystemPromptStub(),
      workspaceRegistry: { archivedSessionIds: [], async archiveSession() {} },
      sessions: { get: () => undefined, list: () => [] },
      sessionTitle: { get: () => undefined },
      approval: makeApprovalStub(),
      // `inject` 声明了这两个（客户端项目选择器的只读路由要用）。
      // 不提供的话 Cordis 会让插件**一直等待**，于是下面的断言全部落空 ——
      // 那是测试环境不完整，不是产品缺陷。
      webServer: makeWebServerStub(),
      connection: makeConnectionStub(),
    };

    app.plugin({
      name: 'dsh-services',
      apply(ctx) { for (const [k, v] of Object.entries(services)) ctx.provide(k, v); },
    });

    let applyErr;
    app.plugin({
      name: 'workspace-folders',
      inject: mod.inject,
      apply(ctx) {
        try { mod.apply(ctx, ours.config); } catch (e) { applyErr = e; }
      },
    });

    await new Promise((r) => setTimeout(r, 300));

    check('★ commands 用的是真实实现（不是宽松桩）', commandsMounted.real === true,
      '退回契约桩了 —— 校验强度下降');
    check('★★ 按真实形态安装后 apply 不抛错（这就是线上崩过的那一步）',
      applyErr === undefined, applyErr?.message);
    check('★★ 不出现 "without inject"',
      applyErr === undefined || !String(applyErr.message).includes('without inject'),
      applyErr?.message);

    // —— 反向验证 1：只声明 tools 应复现 inject 事故 ——
    const app2 = new Context();
    app2.plugin({
      name: 'dsh-services-2',
      apply(ctx) { for (const [k, v] of Object.entries(services)) ctx.provide(k, v); },
    });
    let reproduced;
    app2.plugin({
      name: 'broken',
      inject: ['tools'],
      apply(ctx) {
        try { mod.apply(ctx, ours.config); } catch (e) { reproduced = e.message; }
      },
    });
    await new Promise((r) => setTimeout(r, 300));

    check('★ 反向验证：只声明 tools 会复现事故（证明本套件有效）',
      typeof reproduced === 'string' && reproduced.includes('without inject'), reproduced);

    // —— 反向验证 2：把 handler 改回 run 应复现第二次事故 ——
    //
    // 这一条针对的是「服务契约」类错误：`commands.register` 要求字段名是
    // `handler`，写成 `run` 会抛 `handler must be a function`。
    // 只有当 commands 是**真实实现**时才验得出来（宽松桩会放行）。
    if (commandsMounted.real) {
      const app3 = new Context();
      await mountCommands(app3);
      app3.plugin({
        name: 'dsh-services-3',
        apply(ctx) { for (const [k, v] of Object.entries(services)) ctx.provide(k, v); },
      });

      let contractErr;
      app3.plugin({
        name: 'wrong-contract',
        inject: mod.inject,
        apply(ctx) {
          try {
            ctx.commands.register({
              name: 'probe-bad',
              description: '故意用错误字段名',
              run: async () => ({ kind: 'success' }),
            });
          } catch (e) { contractErr = e.message; }
        },
      });
      await new Promise((r) => setTimeout(r, 250));

      check('★ 真实 commands 会拒绝 `run` 字段（handler 契约守得住）',
        typeof contractErr === 'string' && contractErr.includes('handler must be a function'),
        contractErr);
    }
  }
} finally {
  await nodeFs.rm(tmpProfile, { force: true }).catch(() => {});
}

console.log(`\n${'='.repeat(72)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
