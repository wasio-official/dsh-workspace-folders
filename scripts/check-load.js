/**
 * 真实 Cordis 运行时的加载验证。
 *
 * 与 check-core 的分工：那个验纯逻辑，这个验「插件能不能被真实加载、
 * 工具能不能注册、端到端能不能跑通」，包括：
 *   - 模块形状（具名导出，绝不能有 default）；
 *   - `apply` 不抛错；
 *   - 三个工具真的注册进 `ctx.tools`；
 *   - `workspace_bind` 真能建目录；
 *   - **出界申请真的会调用 `ctx.approval`，且被拒时不放行**。
 *
 * 运行：node scripts/check-load.js
 * @module dsh-workspace-folders/scripts/check-load
 */

import { promises as nodeFs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { makeCommandsStub } from './check-fixtures.js';

const results = [];
/**
 * 记录断言。
 * @param {string} label - 用例名。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 详情。
 */
function check(label, ok, detail) {
  results.push({ label, ok: Boolean(ok), detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok || detail === undefined ? '' : `\n       ${detail}`}`);
}

/**
 * 解析 DSH 内部包为 ESM 可用 URL。
 *
 * 不写死路径 —— 从常见安装位置逐个尝试，任一个能解析出 `@deepseek-ai/dsh`
 * 就用它作为解析锚点。这样在任何机器上都能跑。
 * @param {string} specifier - 包名。
 * @returns {string} file URL。
 * @throws {Error} 找不到 DSH 安装位置时抛出。
 */
function resolveDshPackage(specifier) {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const anchors = [
    // 全局 npm 安装
    path.join(home, 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json'),
    path.join(home, 'AppData/Local/npm/node_modules/@deepseek-ai/dsh/package.json'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/usr/lib/node_modules/@deepseek-ai/dsh/package.json',
    // 本仓库同级（开发时可能是本地 link）
    path.resolve('node_modules/@deepseek-ai/dsh/package.json'),
    path.resolve('../node_modules/@deepseek-ai/dsh/package.json'),
  ];

  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue;
    try {
      return pathToFileURL(createRequire(anchor).resolve(specifier)).href;
    } catch {
      // 换下一个锚点
    }
  }
  throw new Error(
    `找不到 DSH 安装位置，无法解析 ${specifier}。`
    + '请确认已全局安装 @deepseek-ai/dsh，或设置 DSH_HOME。',
  );
}

async function main() {
  console.log('dsh-workspace-folders 加载验证（真实 Cordis）');
  console.log('='.repeat(62));

  // ── 1. 模块形状 ──────────────────────────────────────────────────
  const mod = await import('../src/index.js');
  check('具名导出 name', mod.name === 'workspace-folders', String(mod.name));
  check('具名导出 inject（数组）', Array.isArray(mod.inject), JSON.stringify(mod.inject));
  check('具名导出 apply（函数）', typeof mod.apply === 'function');
  check('没有 default 导出（否则会丢 inject 元数据）', mod.default === undefined);
  // ⚠️ 曾经这里断言的是「inject 只声明 tools（approval/sessionTitle 可降级）」
  //    —— 那条断言把**线上事故的成因**当成了正确行为固定下来。
  //    真相：`ctx.get()` 对兄弟插件提供的服务**静默返回 undefined**，
  //    所以「可选服务」在设计上就不存在，凡是代码读到的服务都必须声明。
  //    详见 scripts/check-inject.js 与 src/index.js 的 inject 注释。
  // 用**集合相等**而不是「长度相等」：长度相等在「声明错了一个服务」时
  // 依然会通过 —— 而那正是会引发线上崩溃的情形。
  const EXPECTED_INJECT = [
    'tools', 'systemPrompt', 'commands', 'workspaceRegistry', 'sessions',
    'approval', 'sessionTitle',
    // 客户端「项目选择器」的只读路由要用：
    'webServer', 'connection',
  ];
  check('inject 覆盖全部用到的服务（不允许漏声明）',
    EXPECTED_INJECT.every((s) => mod.inject.includes(s)),
    JSON.stringify(mod.inject));
  check('inject 无多余条目（集合精确相等）',
    mod.inject.length === EXPECTED_INJECT.length
      && mod.inject.every((s) => EXPECTED_INJECT.includes(s)),
    JSON.stringify(mod.inject));

  // ── 2. 真实 Cordis ───────────────────────────────────────────────
  const { Context } = await import(resolveDshPackage('@deepseek-ai/cordis'));
  const { defineTool } = await import(resolveDshPackage('@deepseek-ai/dsh-tools'));
  check('能解析 @deepseek-ai/cordis', Context !== undefined);
  check('能解析 defineTool', typeof defineTool === 'function');

  // ── 3. 用真实 Cordis 起应用并挂载 ────────────────────────────────
  const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-load-'));
  const registered = [];
  const app = new Context();

  const approvalCalls = [];
  /** 可切换的审批应答，用来分别验证「批准」与「拒绝」两条路径。 */
  let approvalAnswer = () => 'allowed-once';

  app.provide('tools', {
    register(definition) {
      registered.push(definition);
      return () => {
        const index = registered.indexOf(definition);
        if (index !== -1) registered.splice(index, 1);
      };
    },
  });
  app.provide('approval', {
    async request(req) {
      approvalCalls.push(req);
      return approvalAnswer();
    },
  });
  app.provide('sessionTitle', { get: () => ({ title: 'Fix Auth' }) });
  // ★ 用**按真实契约校验**的 commands 桩（不是 `() => () => {}` 那种宽松桩）。
  //   宽松桩会放行 `run` 字段，而真实实现要求 `handler` —— 正是第二次
  //   线上崩溃的原因。桩复刻校验后，契约写错在这里就会失败。
  const commandsStub = makeCommandsStub();
  app.provide('commands', commandsStub);

  // 隔离的 DSH home，避免测试碰到用户真实的 ~/.dsh/AGENTS.md。
  const dshHome = path.join(root, '_dshhome');
  await nodeFs.mkdir(dshHome, { recursive: true });
  await nodeFs.writeFile(path.join(root, 'AGENTS.md'), '# 主文件夹指令\n测试用。\n', 'utf8');

  let applied = true;
  let applyError;
  try {
    mod.apply(app, { workspaceRoot: root, dshHome });
  } catch (error) {
    applied = false;
    applyError = error;
  }
  check('apply 不抛错', applied, applyError ? String(applyError.stack ?? applyError) : undefined);

  await new Promise((r) => setTimeout(r, 80));

  check('注册了 5 个工具', registered.length === 5,
    `实际 ${registered.length}：${registered.map((r) => r.name).join(', ')}`);
  const names = registered.map((r) => r.name).sort();
  check('工具名齐全',
    JSON.stringify(names) === JSON.stringify([
      'workspace_access', 'workspace_archive', 'workspace_bind',
      'workspace_projects', 'workspace_status',
    ]),
    JSON.stringify(names));

  const byName = new Map(registered.map((r) => [r.name, r]));
  const bindTool = byName.get('workspace_bind');
  const statusTool = byName.get('workspace_status');
  const accessTool = byName.get('workspace_access');

  // ── 3b. workspaceFolders 服务（⑤ 的判定依据）────────────────────
  const folderStore = app.get('workspaceFolders');
  check('★ 暴露了 workspaceFolders 服务（客户端 ⑤ 依赖它）', folderStore !== undefined);
  check('workspaceFolders 有 getSnapshot', typeof folderStore?.getSnapshot === 'function');
  check('workspaceFolders 有 subscribe', typeof folderStore?.subscribe === 'function');
  {
    // 首次调用触发异步构建 → 返回空表；等一拍后应拿到真数据。
    folderStore?.getSnapshot();
    await new Promise((r) => setTimeout(r, 120));
    const snap = folderStore?.getSnapshot();
    check('★ getSnapshot 返回 { sessions } 形状',
      JSON.stringify(Object.keys(snap ?? {})) === JSON.stringify(['sessions']),
      JSON.stringify(snap));
    check('★ 映射值是子文件夹名，不是工作区根路径',
      Object.values(snap?.sessions ?? {}).every((v) => typeof v === 'string' && !v.includes(':\\')));
  }
  {
    let notified = 0;
    const stop = folderStore.subscribe(() => { notified += 1; });
    await folderStore.refresh();
    check('★ refresh 会通知订阅者（客户端能及时看到新归属）', notified > 0, `notified=${notified}`);
    stop();
  }

  // ── 4. 结构合法性 ────────────────────────────────────────────────
  check('workspace_bind 有足够详细的 description',
    typeof bindTool?.description === 'string' && bindTool.description.length > 100);
  check('required 被编译为顶层数组',
    Array.isArray(accessTool?.parameters?.required)
    && accessTool.parameters.required.includes('target_path')
    && accessTool.parameters.required.includes('reason'),
    JSON.stringify(accessTool?.parameters?.required));
  check('workspace_access 有 execute', typeof accessTool?.execute === 'function');
  check('workspace_status 无必填参数', (statusTool?.parameters?.required ?? []).length === 0);

  // ── 5. 主文件夹 prompt 的关键保障：镜像到 $DSH_HOME ─────────────
  const mirrored = path.join(dshHome, 'AGENTS.md');
  const mirrorExists = await nodeFs.stat(mirrored).then(() => true, () => false);
  check('★ 主文件夹指令被镜像到 $DSH_HOME/AGENTS.md（免补丁保住 prompt）', mirrorExists,
    `期望 ${mirrored} 存在`);
  if (mirrorExists) {
    const src = await nodeFs.readFile(path.join(root, 'AGENTS.md'));
    const dst = await nodeFs.readFile(mirrored);
    check('★ 镜像内容与主文件夹源文件字节一致', Buffer.compare(src, dst) === 0);
  }
  const stateExists = await nodeFs
    .stat(path.join(dshHome, '.dsh-workspace-folders-mirror.json'))
    .then(() => true, () => false);
  check('镜像状态文件已写入（用于识别「是不是我写的」）', stateExists);

  // ── 6. 端到端：bind ──────────────────────────────────────────────
  const fakeAgent = {
    id: 'load-sess-1',
    session: { id: 'load-sess-1', header: { cwd: root } },
  };
  const mkExec = (name, args = {}) => ({
    callId: `c-${name}`, rootCallId: `c-${name}`, name, arguments: args,
    signal: new AbortController().signal, agent: fakeAgent,
  });

  const bindResult = await bindTool.execute({}, mkExec('workspace_bind'));
  check('workspace_bind 返回 created=true', bindResult.created === true, JSON.stringify(bindResult));
  check('★ 子文件夹被真实创建',
    (await nodeFs.stat(bindResult.workingDir).catch(() => undefined))?.isDirectory() === true,
    bindResult.workingDir);
  // ★ 默认**不带**日期前缀 —— 用户要求对齐工作区既有风格
  //   （`MinerU` / `PhO` / `Books` / `qq-bot` / `dsh-config` 全都没有日期）。
  check('★★ 子文件夹名是标题 slug（无日期前缀）',
    bindResult.folder === 'fix-auth', bindResult.folder);
  check('返回 inheritsMainPrompt=true', bindResult.inheritsMainPrompt === true);
  check('INHERITED.md 已写入',
    await nodeFs.stat(path.join(bindResult.workingDir, 'INHERITED.md')).then(() => true, () => false));

  const bindAgain = await bindTool.execute({}, mkExec('workspace_bind'));
  check('workspace_bind 幂等（同目录、created=false）',
    bindAgain.workingDir === bindResult.workingDir && bindAgain.created === false);

  // ── 7. 端到端：界内不申请 ────────────────────────────────────────
  approvalCalls.length = 0;
  const insideResult = await accessTool.execute(
    { target_path: path.join(bindResult.workingDir, 'notes.md'), reason: '写笔记' },
    mkExec('workspace_access'),
  );
  check('界内路径直接放行', insideResult.allowed === true && insideResult.outcome === 'inside',
    JSON.stringify(insideResult));
  check('界内不触发审批弹窗', approvalCalls.length === 0);

  // ── 8. 端到端：出界 → 审批批准 ───────────────────────────────────
  approvalCalls.length = 0;
  approvalAnswer = () => 'allowed-once';
  const outsideTarget = path.join(root, 'other-project');
  const allowedResult = await accessTool.execute(
    { target_path: outsideTarget, reason: '复用其接口定义' },
    mkExec('workspace_access'),
  );
  check('★ 出界触发了 ctx.approval（弹窗）', approvalCalls.length === 1);
  check('审批请求带上目标路径与理由',
    approvalCalls[0]?.reason?.includes(outsideTarget) && approvalCalls[0]?.reason?.includes('复用其接口定义'),
    approvalCalls[0]?.reason);
  check('审批请求带上 agent（决定弹窗路由）', approvalCalls[0]?.agent === fakeAgent);
  check('★ 批准后放行', allowedResult.allowed === true && allowedResult.outcome === 'allowed-once',
    JSON.stringify(allowedResult));
  check('放行提示说明是一次性', allowedResult.message.includes('一次'));

  // ── 9. 端到端：出界 → 拒绝 ───────────────────────────────────────
  approvalAnswer = () => 'rejected';
  const rejectedResult = await accessTool.execute(
    { target_path: outsideTarget, reason: '再试一次' },
    mkExec('workspace_access'),
  );
  check('★ 被拒后不放行', rejectedResult.allowed === false && rejectedResult.outcome === 'rejected',
    JSON.stringify(rejectedResult));
  check('拒绝提示要求停止重试', rejectedResult.message.includes('不要重试') || rejectedResult.message.includes('停止'));

  // ── 10. fail-closed：审批服务不可用 ──────────────────────────────
  approvalAnswer = () => 'unavailable';
  const unavailableResult = await accessTool.execute(
    { target_path: outsideTarget, reason: 'x' },
    mkExec('workspace_access'),
  );
  check('★ unavailable 时失败关闭（不放行）', unavailableResult.allowed === false);

  // ── 11. 策略：一律拒绝 ───────────────────────────────────────────
  const denyRoot = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-deny-'));
  const denyRegistered = [];
  const denyApp = new Context();
  denyApp.provide('tools', {
    register(definition) {
      denyRegistered.push(definition);
      return () => {};
    },
  });
  denyApp.provide('approval', { request: async () => 'allowed-once' });
  denyApp.provide('commands', makeCommandsStub());
  mod.apply(denyApp, { workspaceRoot: denyRoot, outsideAccess: 'deny' });
  await new Promise((r) => setTimeout(r, 80));

  const denyAccess = denyRegistered.find((r) => r.name === 'workspace_access');
  const denyBind = denyRegistered.find((r) => r.name === 'workspace_bind');
  const denyExec = { ...mkExec('x'), agent: { id: 'd1', session: { id: 'd1' } } };
  const denyBound = await denyBind.execute({}, denyExec);
  const denyResult = await denyAccess.execute(
    { target_path: path.join(denyRoot, 'elsewhere'), reason: 'x' },
    denyExec,
  );
  check("outsideAccess='deny' 时不弹窗直接拒绝",
    denyResult.allowed === false && denyResult.outcome === 'denied-by-policy',
    JSON.stringify({ outcome: denyResult.outcome, bound: denyBound.folder }));

  // ── 12. 安全：路径穿越在工具层被挡住 ─────────────────────────────
  approvalCalls.length = 0;
  approvalAnswer = () => 'allowed-once';
  const traversal = await accessTool.execute(
    { target_path: path.join(bindResult.workingDir, '..', '..', 'evil'), reason: 'x' },
    mkExec('workspace_access'),
  );
  check('★ .. 穿越被判为出界并触发审批', approvalCalls.length === 1,
    `allowed=${traversal.allowed} outcome=${traversal.outcome}`);
  check('穿越目标被规范化（不再含 ..）', !traversal.targetPath.includes('..'), traversal.targetPath);

  // ── 13. 缺少 agent 时明确报错 ────────────────────────────────────
  let noAgentError;
  try {
    await bindTool.execute({}, { ...mkExec('workspace_bind'), agent: undefined });
  } catch (error) {
    noAgentError = error;
  }
  check('缺少 agent 时明确报错',
    noAgentError !== undefined && String(noAgentError.message).includes('owning agent'),
    noAgentError ? String(noAgentError.message) : '未抛错');

  await nodeFs.rm(root, { recursive: true, force: true });
  await nodeFs.rm(denyRoot, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(62)}`);
  console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length > 0) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
    process.exitCode = 1;
  }
}

await main();
