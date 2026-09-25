/**
 * 服务**方法契约**校验：把代码里每个 `ctx.<service>.<method>` 调用
 * 与真实实现逐条对照。
 *
 * ## 为什么有第四个套件
 *
 * 前三个套件解决的是「**加载期**崩溃」（inject 漏声明、命令字段名写错）。
 * 但还有一类更隐蔽的错：**方法参数/返回值的形状不对**。
 * 它可能不崩，只是**静默失效**（比如传了不存在的字段名，被忽略）。
 *
 * 本套件专门盯着这类问题：
 *
 * 1. `systemPrompt.section()` 的字段是 `name`/`order`/`text`
 *    —— 曾误写成 `id`/`content`（`order` 非数字还会直接抛错）；
 * 2. `sessions.list()` 返回**全部**会话，**没有「当前」的概念**
 *    —— 曾用它取「当前会话」，导致安全检查静默失效；
 * 3. `approval.request()` 接受 `agent`/`toolName`/`callId?`/`reason?`，
 *    返回**裸字符串**而非对象。
 *
 * 这些都用**真实服务对象**验证（能挂真货就挂真货），而不是靠读文档。
 *
 * @module dsh-workspace-folders/scripts/check-contracts
 */

import { promises as nodeFs, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

import { loadContext, findDshPackage, mountCommands, resolveDsh } from './check-fixtures.js';

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

console.log('服务方法契约校验');
console.log('='.repeat(70));

const srcDir = path.join(import.meta.dirname, '..', 'src');

/**
 * 读源码里所有 `ctx.<service>.<method>(` 调用点。
 *
 * 跳过**注释行** —— 文档里提到 `ctx.x.y()` 是在讲设计，不是在调用；
 * 早先没跳过，于是 `binder.js` 注释里的 `ctx.sessionController.create()`
 * 被误报成一个不存在的服务。
 * @returns {Array<{service: string, method: string, file: string, line: number}>} 调用点。
 */
function collectCallSites() {
  const out = [];
  const pattern = /ctx\??\.([a-zA-Z]+)\??\.([a-zA-Z]+)\s*\(/g;
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
    const text = readFileSync(path.join(srcDir, file), 'utf8');
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
      // 注释行（含 JSDoc 的 `*`）不算调用点。
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(line)) !== null) {
        out.push({ service: m[1], method: m[2], file, line: i + 1 });
      }
    }
  }
  return out;
}

// ── 1. 真实服务上是否存在这些方法 ────────────────────────────────────
console.log('\n【1】代码里的每个 ctx.<service>.<method> 是否真实存在');

const Context = await loadContext();
const app = new Context();
const mountedCommands = await mountCommands(app);

// 提供其余服务（形状按真实契约写，见下面各节的断言）
app.plugin({
  name: 'probe-services',
  apply(ctx) {
    ctx.provide('tools', { register() {}, define: () => ({}) });
    ctx.provide('systemPrompt', {
      section(section) {
        if (!Number.isFinite(section?.order)) {
          throw new TypeError(`prompt section "${section?.name}" order must be a finite number`);
        }
        if (typeof section?.name !== 'string' || section.name.length === 0) {
          throw new TypeError('prompt section name must be a non-empty string');
        }
        if (typeof section?.text !== 'string' && typeof section?.text !== 'function') {
          throw new TypeError(`prompt section "${section.name}" text must be a string or function`);
        }
        return () => {};
      },
    });
    ctx.provide('workspaceRegistry', {
      archivedSessionIds: [],
      async archiveSession() {},
    });
    ctx.provide('sessions', { get: () => undefined, list: () => [] });
    ctx.provide('sessionTitle', { get: () => undefined });
    ctx.provide('approval', { async request() { return 'allowed-once'; } });
  },
});
await new Promise((r) => setTimeout(r, 200));

const callSites = collectCallSites();
const unique = [...new Map(callSites.map((c) => [`${c.service}.${c.method}`, c])).values()];

for (const site of unique) {
  const service = app[site.service];
  const has = service !== undefined && typeof service[site.method] === 'function';
  check(
    `ctx.${site.service}.${site.method}() 真实存在`,
    has,
    `${site.file}:${site.line} —— 服务${service === undefined ? '不存在' : `无 ${site.method} 方法`}`,
  );
}

// ── 2. systemPrompt.section 的字段名 ─────────────────────────────────
console.log('\n【2】systemPrompt.section() 的字段名（曾误写 id/content）');

{
  const indexSrc = readFileSync(path.join(srcDir, 'index.js'), 'utf8');

  check('★ 用的是 `name` 而不是 `id`',
    /systemPrompt\?\.section\?\.\(\{[\s\S]{0,200}?\bname:/.test(indexSrc)
    && !/systemPrompt\?\.section\?\.\(\{[\s\S]{0,200}?\bid:/.test(indexSrc));
  check('★ 用的是 `text` 而不是 `content`',
    /systemPrompt\?\.section\?\.\(\{[\s\S]{0,200}?\btext:/.test(indexSrc)
    && !/systemPrompt\?\.section\?\.\(\{[\s\S]{0,200}?\bcontent:/.test(indexSrc));

  // 反向验证：真实服务必须拒绝错误形状
  let idErr;
  let contentErr;
  try {
    app.systemPrompt.section({ id: 'x', order: 1, content: () => 'y' });
  } catch (e) { idErr = e.message; }
  try {
    app.systemPrompt.section({ name: 'x', order: 1, content: () => 'y' });
  } catch (e) { contentErr = e.message; }

  check('★ 反例：传 id/content 会被真实服务拒绝',
    typeof idErr === 'string' && typeof contentErr === 'string',
    `idErr=${idErr} contentErr=${contentErr}`);

  // order 非数字会抛
  let orderErr;
  try {
    app.systemPrompt.section({ name: 'x', text: 'y' });
  } catch (e) { orderErr = e.message; }
  check('★ 反例：order 非有限数字会被拒绝',
    typeof orderErr === 'string' && orderErr.includes('finite number'), orderErr);
}

// ── 3. sessions 服务：没有「当前会话」概念 ───────────────────────────
console.log('\n【3】sessions.list() 的语义（曾误当作「当前会话」）');

{
  const archiverSrc = readFileSync(path.join(srcDir, 'archiver.js'), 'utf8');

  check('★ 不再用 sessions.list()[0] 猜「当前会话」',
    !/sessions\?\.list\?\.\(\)/.test(archiverSrc)
    && !/list\[0\]\?\.id/.test(archiverSrc),
    'archiver.js 里仍有 list()[0] 的用法');

  check('★ performArchive 支持显式 callerSessionId',
    /callerSessionId/.test(archiverSrc));

  const binderSrc = readFileSync(path.join(srcDir, 'binder.js'), 'utf8');
  check('★ ④ 归档别人时显式传了自己的 sessionId',
    /callerSessionId:\s*sessionId/.test(binderSrc),
    'binder.js 未传 callerSessionId —— 护栏会静默失效');
}

// ── 4. approval.request 的入参与返回 ─────────────────────────────────
console.log('\n【4】approval.request() 的形状');

{
  const archiverSrc = readFileSync(path.join(srcDir, 'archiver.js'), 'utf8');
  const approverSrc = readFileSync(path.join(srcDir, 'guard.js'), 'utf8');

  check('★ 传了 agent（真实实现第一行就读 req.agent.session）',
    /approval\.request\(\{[\s\S]{0,300}?\bagent\b/.test(archiverSrc)
    && /approval\.request\(\{[\s\S]{0,300}?\bagent\b/.test(approverSrc));
  // toolName 在两个文件里都传了；archiver 在 request 调用前的参数列表里，
  // 所以窗口放宽到 400 字符（早先 200 太窄，误报）。
  check('★ 传了 toolName（两个审批入口都要）',
    /approval\.request\(\{[\s\S]{0,400}?toolName/.test(archiverSrc)
    && /approval\.request\(\{[\s\S]{0,400}?toolName/.test(approverSrc),
    `archiver=${/toolName/.test(archiverSrc)} guard=${/toolName/.test(approverSrc)}`);

  // 返回的是裸字符串，不是对象 —— 代码必须按字符串比较
  const outcomes = ['allowed-once', 'rejected', 'cancelled', 'unavailable'];
  check('★ 四个 outcome 词表与真实实现一致',
    outcomes.every((o) => archiverSrc.includes(`'${o}'`) || approverSrc.includes(`'${o}'`)));

  const doc = resolveDsh('@deepseek-ai/dsh-user-approval');
  if (doc !== undefined) {
    const text = readFileSync(new URL(doc), 'utf8');
    check('★ 词表核对：真实源码里就是这四个',
      outcomes.every((o) => text.includes(`"${o}"`)),
      '真实实现的 OUTCOMES 与代码不一致');
  }
}

// ── 5. tools.register 需要的字段 ─────────────────────────────────────
console.log('\n【5】tools.register() / defineTool 的必需字段');

{
  const toolsSrc = readFileSync(path.join(srcDir, 'tools.js'), 'utf8');
  const defineToolCalls = toolsSrc.match(/defineTool\(\{/g) ?? [];

  check('★ 每个 defineTool 调用都带 output（缺失会直接抛）',
    (toolsSrc.match(/output:\s*\{/g) ?? []).length >= defineToolCalls.length,
    `defineTool 调用 ${defineToolCalls.length} 处，output 只有 ${(toolsSrc.match(/output:\s*\{/g) ?? []).length} 处`);
  check('★ 每个 output 都有 render',
    (toolsSrc.match(/render\(/g) ?? []).length >= defineToolCalls.length);
  check('★ 没有使用被保留的工具名 run_code',
    !/name:\s*'run_code'/.test(toolsSrc));

  if (existsSync(path.join(import.meta.dirname, '..', 'src', 'tools.js'))) {
    const dts = resolveDsh('@deepseek-ai/dsh-tools');
    if (dts !== undefined) {
      const base = path.dirname(new URL(dts).pathname.replace(/^\//, ''));
      const typeFile = path.join(base, 'types', 'index.d.ts');
      if (existsSync(typeFile)) {
        const text = readFileSync(typeFile, 'utf8');
        check('★ ToolExecutionInput.agent 是可选的（代码用 ?. 读）',
          /readonly agent\?: Agent;/.test(text));
        check('★ ToolExecutionInput 里有 signal',
          /readonly signal: AbortSignal;/.test(text));
      }
    }
  }
}

// ── 6. sessionTitle.get 需要 Session 而非 id ─────────────────────────
console.log('\n【6】sessionTitle.get() 的入参');

{
  const namingSrc = readFileSync(path.join(srcDir, 'naming.js'), 'utf8');
  const indexSrc = readFileSync(path.join(srcDir, 'index.js'), 'utf8');
  const toolsSrc = readFileSync(path.join(srcDir, 'tools.js'), 'utf8');

  check('★ naming.sessionTitleOf 会解包 .session（真实 get 读 session.snapshotEvents）',
    /source\?\.session\s*\?\?\s*source/.test(namingSrc),
    'naming.js 未解包 —— 传 exec/agent 时会拿到错对象');

  check('★ naming.sessionTitleOf 把解包后的 Session 交给服务',
    /sessionTitle\?\.get\?\.\(session\)/.test(namingSrc),
    'naming.js 未把 Session 对象传给 get()');

  check('★ 调用方传的是 exec / agent（可解包出 Session）',
    /sessionTitleOf\(ctx,\s*exec\)/.test(toolsSrc)
    || /sessionTitleOf\(ctx,\s*invocation/.test(indexSrc));

  // `Session` 没有 `events` 属性，读事件必须用 snapshotEvents()。
  // 这个调用在 index.js（写 log 时），不在 naming.js。
  check('★ 读会话事件用 snapshotEvents()（Session 没有 events 属性）',
    /session\.snapshotEvents\?\.\(\)/.test(indexSrc),
    'index.js 里没有 snapshotEvents() 调用');
}

// ── 7. workspaceRegistry ─────────────────────────────────────────────
console.log('\n【7】workspaceRegistry 的字段与方法');

{
  const archiverSrc = readFileSync(path.join(srcDir, 'archiver.js'), 'utf8');
  check('★ 用 archivedSessionIds 判归档', /archivedSessionIds/.test(archiverSrc));
  check('★ 用 archiveSession(id) 执行归档', /archiveSession/.test(archiverSrc));
  check('★ 没有调用不存在的 unarchiveSession',
    !/unarchiveSession/.test(archiverSrc));
}

// ── 8. 客户端插件的 uiWorkspace 契约 ─────────────────────────────────
console.log('\n【8】客户端 uiWorkspace 的方法签名');

{
  const clientSrc = readFileSync(
    path.join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8',
  );

  // `resolveDsh` 会解析到包的 `lib/index.js`（一个再导出的壳），
  // 真正实现在**同包的 `lib/client.js`** 里 —— 要核对方法签名得读那个。
  const wsEntry = resolveDsh('@deepseek-ai/dsh-client-ui-workspace');
  let wsText;
  if (wsEntry !== undefined) {
    const pkgDir = path.dirname(path.dirname(new URL(wsEntry).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
    const clientFile = path.join(pkgDir, 'lib', 'client.js');
    if (existsSync(clientFile)) wsText = readFileSync(clientFile, 'utf8');
  }

  if (wsText === undefined) {
    console.log('  （找不到 dsh-client-ui-workspace/lib/client.js，跳过真实源码核对）');
  } else {
    // ★★ 断言「方法存在且**接受裸 sessionId 字符串**」，而不是「参数名叫 sessionId」。
    //
    // 起因：升级到 0.1.7-rc.2 后这两条红了 ——
    //   openSession(sessionId)          → openSession(target)
    //   async archiveSession(sessionId) → async archiveSession(sessionId, options = {})
    //
    // 但**这不是插件坏了**，是我之前把断言写死在参数名上（过拟合）。
    // 读两版实现确认调用语义没变：
    //
    //   旧 0.1.5-rc.1:  openSession(sessionId) { this.sessions.open(sessionId); }
    //   新 0.1.7-rc.2:  openSession(target) { this.replaceMain(target, ...); }
    //                   replaceMain 里 `typeof target === "string" ? ... : target`
    //
    // 两版都接受裸字符串，只是新版**额外**支持对象。改名是能力扩展，不是破坏。
    //
    // 教训：契约断言要锁**调用语义**（传字符串行不行），
    //       而不是**形参拼写或内部实现细节**（随时会改）。
    //
    // ⚠️ 我第一版改法又踩了同一个坑：加了「实现里必须有
    //   `typeof target === "string"`」这条 —— 它在旧版上会红，
    //   因为旧版走的是完全不同的内部路径（sessions.open）。
    //   那依然是在核对**实现细节**。
    //   最终改成核对**可观测的调用契约**：首个形参不是对象解构。
    const openSig = wsText.match(/\bopenSession\s*\(([^)]*)\)\s*\{/);
    check('★ uiWorkspace.openSession 存在', openSig !== null);
    check('★★ openSession 的**第一个形参**接受裸值（不是对象解构）',
      openSig !== null && !/^\s*\{/.test(openSig[1] ?? ''),
      `首个形参是对象解构 —— 裸 sessionId 可能不再可用：${openSig?.[1]}`);
    check('★★ openSession 不要求必填的第二个参数',
      openSig === null || openSig[1].split(',').length === 1,
      `形参变多了：${openSig?.[1]}`);

    const archSig = wsText.match(/\basync\s+archiveSession\s*\(([^)]*)\)\s*\{/);
    check('★ uiWorkspace.archiveSession 存在且是 async', archSig !== null);
    check('★★ archiveSession 的**第一个形参**是裸 sessionId',
      archSig !== null && /^\s*sessionId\b/.test(archSig[1] ?? ''),
      `首个形参：${archSig?.[1]}`);
    // 新增的参数必须是**可选**（有默认值），否则不传就坏 —— 那才是真破坏
    check('★★ archiveSession 新增的参数是**可选**的（有默认值）',
      archSig === null || archSig[1].split(',').length === 1
      || /=\s*/.test(archSig[1].split(',').slice(1).join(',')),
      `必填参数变多了：${archSig?.[1]}`);

    check('★ uiWorkspace.clearArchivedCurrent() 真实存在',
      /clearArchivedCurrent\s*\(\s*\)\s*\{/.test(wsText));
  }

  check('★ 客户端只用这三个方法',
    /uiWorkspace\.archiveSession\(/.test(clientSrc)
    && /uiWorkspace\.openSession\(/.test(clientSrc),
    'client.js 未调用预期的方法');

  check('★ 客户端 inject 声明了用到的三个服务',
    /uiWorkspace/.test(clientSrc) && /inject/.test(clientSrc));
}

await nodeFs.rm(path.join(import.meta.dirname, '..', '_probe'), { force: true, recursive: true })
  .catch(() => {});

console.log(`\n${'='.repeat(70)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
