/**
 * 归档（archiver）验证：对应需求 ③「工作完该任务后自动清除自身」。
 *
 * 覆盖四类断言：
 *   1. **审批三态分流** —— 批准才归档、拒绝不归档、不可用时失败关闭；
 *   2. **安全检查** —— 不归档当前会话、幂等、未知会话明确报错、无 registry 时降级；
 *   3. **工具面** —— `workspace_archive` 注册与描述（必须说明「会弹卡片」）；
 *   4. **配置** —— `archiveMode: 'off'` 时不注册工具。
 *
 * 用假 registry（记录调用）而非真实 DSH，避免测试污染真实归档集。
 *
 * 运行：node scripts/check-archiver.js
 * @module dsh-workspace-folders/scripts/check-archiver
 */

import {
  isArchived, performArchive, requestArchive, resolveRegistry, describeArchiveCapability,
} from '../src/archiver.js';

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

/**
 * 造一个假 registry。
 * @param {object} [options] - 入参。
 * @param {Array<string>} [options.archived] - 初始归档集。
 * @param {Error} [options.throws] - archiveSession 要抛的错。
 * @returns {object} 假 registry。
 */
function makeRegistry({ archived = [], throws } = {}) {
  const calls = [];
  return {
    calls,
    archivedSessionIds: [...archived],
    async archiveSession(sessionId) {
      calls.push(sessionId);
      if (throws !== undefined) throw throws;
      this.archivedSessionIds = [...this.archivedSessionIds, sessionId];
    },
  };
}

/**
 * 造一个假 ctx。
 * @param {object} [options] - 入参。
 * @param {object} [options.registry] - registry。
 * @param {string} [options.outcome] - 审批结果。
 * @param {Error} [options.approvalThrows] - 审批要抛的错。
 * @param {boolean} [options.noApproval] - 是否不挂审批服务。
 * @returns {object} 假 ctx。
 */
function makeCtx({ registry, outcome = 'allowed-once', approvalThrows, noApproval = false } = {}) {
  const asked = [];
  const ctx = {
    workspaceRegistry: registry,
    // 注意：**不提供** `sessions`。真实 `sessions.list()` 返回全部会话，
    // 没有「当前」的概念，因此归档逻辑**不应该**从它推断当前会话
    // —— 早先这里挂了个 `list: () => [{ id: 'current-session' }]` 的桩，
    // 把「靠 list()[0] 猜当前会话」这个错误设计固化了下来。
  };
  if (!noApproval) {
    ctx.approval = {
      async request(req) {
        asked.push(req);
        if (approvalThrows !== undefined) throw approvalThrows;
        return outcome;
      },
    };
  }
  ctx.__asked = asked;
  return ctx;
}

/** 主流程。 */
async function main() {
  console.log('归档验证（需求③）');
  console.log('='.repeat(72));

  // ── 1. 服务探测 ──────────────────────────────────────────────────
  console.log('\n【服务探测】');
  check('无 registry 时明确报告不可用', resolveRegistry({}).ok === false);
  check('registry 缺 archiveSession 时报告不可用',
    resolveRegistry({ workspaceRegistry: {} }).ok === false);
  check('正常 registry 探测通过', resolveRegistry(makeCtx({ registry: makeRegistry() })).ok === true);
  check('能力说明含已归档数量',
    describeArchiveCapability(makeCtx({ registry: makeRegistry({ archived: ['a', 'b'] }) }))
      .includes('2'));

  // ── 2. 审批三态：批准 ────────────────────────────────────────────
  console.log('\n【审批：批准】');
  {
    const registry = makeRegistry();
    const ctx = makeCtx({ registry, outcome: 'allowed-once' });
    const result = await requestArchive({ ctx, agent: {}, sessionId: 'sess-new', title: '修复登录' });

    check('★ 批准后真的归档了', result.archived === true, JSON.stringify(result));
    check('★ registry.archiveSession 被调用一次', registry.calls.length === 1,
      JSON.stringify(registry.calls));
    check('归档的是目标会话', registry.calls[0] === 'sess-new');
    check('★ 确实弹了审批（ctx.approval.request 被调用）', ctx.__asked.length === 1);
    check('审批带上 toolName', ctx.__asked[0]?.toolName === 'workspace_archive');
    check('★ 审批带上 agent（决定弹窗路由）', 'agent' in (ctx.__asked[0] ?? {}));
    check('★ 卡片文案含对话标题（便于用户辨认）',
      ctx.__asked[0]?.reason?.includes('修复登录'), ctx.__asked[0]?.reason);
    check('★ 卡片文案说明「内容会保留」（消除用户顾虑）',
      ctx.__asked[0]?.reason?.includes('保留'), ctx.__asked[0]?.reason);
    check('结果说明提到「已归档」', result.message.includes('已归档'));
  }

  // ── 3. 审批三态：拒绝 ────────────────────────────────────────────
  console.log('\n【审批：拒绝】');
  {
    const registry = makeRegistry();
    const ctx = makeCtx({ registry, outcome: 'rejected' });
    const result = await requestArchive({ ctx, agent: {}, sessionId: 'sess-new' });

    check('★ 拒绝后**没有**归档', result.archived === false);
    check('★ 拒绝后 registry 未被调用', registry.calls.length === 0,
      JSON.stringify(registry.calls));
    check('拒绝的 outcome 正确', result.outcome === 'rejected');
    check('★ 拒绝的提示要求停止重试', result.message.includes('不要重试'), result.message);
  }

  // ── 4. 审批三态：取消 / 不可用 / 未知 ────────────────────────────
  console.log('\n【审批：取消 / 不可用 / 未知结果】');
  for (const outcome of ['cancelled', 'unavailable']) {
    const registry = makeRegistry();
    const ctx = makeCtx({ registry, outcome });
    const result = await requestArchive({ ctx, agent: {}, sessionId: 'sess-new' });
    check(`★ outcome=${outcome} 时不归档（失败关闭）`,
      result.archived === false && registry.calls.length === 0);
  }
  {
    const registry = makeRegistry();
    const ctx = makeCtx({ registry, outcome: 'something-weird' });
    const result = await requestArchive({ ctx, agent: {}, sessionId: 'sess-new' });
    check('★ 未知审批结果按失败关闭处理',
      result.archived === false && registry.calls.length === 0);
  }
  {
    const registry = makeRegistry();
    const ctx = makeCtx({ registry, noApproval: true });
    const result = await requestArchive({ ctx, agent: {}, sessionId: 'sess-new' });
    check('★ 无审批服务时不归档（不能未经同意动手）',
      result.archived === false && registry.calls.length === 0);
    check('无审批服务时 outcome=unavailable', result.outcome === 'unavailable');
  }
  {
    const registry = makeRegistry();
    const ctx = makeCtx({ registry, approvalThrows: new Error('no open turn') });
    const result = await requestArchive({ ctx, agent: {}, sessionId: 'sess-new' });
    check('★ 审批通道抛错时失败关闭', result.archived === false && registry.calls.length === 0);
    check('抛错信息被带进提示', result.message.includes('no open turn'), result.message);
  }

  // ── 5. 安全检查 ──────────────────────────────────────────────────
  console.log('\n【安全检查】');
  {
    // 护栏必须由**调用方显式告知**「自己是谁」才生效。
    // 早先靠 `ctx.sessions.list()[0]` 去猜「当前会话」，而 `list()` 返回的是
    // **全部**会话、没有「当前」的概念 —— 那是静默失效的假护栏。
    const registry = makeRegistry();
    const ctx = makeCtx({ registry });
    const result = await performArchive({
      ctx,
      sessionId: 'current-session',
      callerSessionId: 'current-session',
    });
    check('★ 不归档当前会话（会导致界面跳回新会话页）',
      result.archived === false && registry.calls.length === 0, JSON.stringify(result));
    check('当前会话的 outcome 正确', result.outcome === 'current-session');
  }
  {
    // 反向：**没告知** callerSessionId 时，护栏不启用（不能靠猜，也不能拦错）。
    // 这正是 ④「归档别人」的场景：此时目标不是自己，必须放行。
    const registry = makeRegistry();
    const ctx = makeCtx({ registry });
    const result = await performArchive({ ctx, sessionId: 'other-session' });
    check('★ 未告知 callerSessionId 时不误拦（④ 归档别人的场景）',
      result.archived === true && registry.calls.length === 1, JSON.stringify(result));
  }
  {
    // 反向：callerSessionId 与目标**不同**时必须放行。
    const registry = makeRegistry();
    const ctx = makeCtx({ registry });
    const result = await performArchive({
      ctx,
      sessionId: 'other-session',
      callerSessionId: 'me',
    });
    check('★ callerSessionId 与目标不同时正常归档',
      result.archived === true && registry.calls.length === 1, JSON.stringify(result));
  }
  {
    const registry = makeRegistry({ archived: ['already'] });
    const ctx = makeCtx({ registry });
    const result = await performArchive({ ctx, sessionId: 'already' });
    check('★ 幂等：已归档的不重复归档',
      result.archived === false && registry.calls.length === 0);
    check('已归档的 outcome 正确', result.outcome === 'already-archived');
  }
  {
    const err = new Error('cannot archive');
    err.name = 'WorkspaceUnknownSessionError';
    const registry = makeRegistry({ throws: err });
    const ctx = makeCtx({ registry });
    const result = await performArchive({ ctx, sessionId: 'ghost' });
    check('★ 未知会话被识别为 not-found（与存储故障区分）',
      result.outcome === 'not-found', JSON.stringify(result));
  }
  {
    const registry = makeRegistry({ throws: new Error('disk on fire') });
    const ctx = makeCtx({ registry });
    const result = await performArchive({ ctx, sessionId: 'x' });
    check('存储故障原样上报，不谎报为 not-found',
      result.outcome === 'error' && result.message.includes('disk on fire'));
  }
  {
    const ctx = makeCtx({});
    const result = await performArchive({ ctx, sessionId: 'x' });
    check('无 registry 时 performArchive 明确报错', result.outcome === 'no-registry');
  }

  // ── 6. isArchived 健壮性 ────────────────────────────────────────
  console.log('\n【isArchived 健壮性】');
  check('正常判定', isArchived({ archivedSessionIds: ['a'] }, 'a') === true);
  check('不存在则 false', isArchived({ archivedSessionIds: ['a'] }, 'b') === false);
  check('缺字段不抛错', isArchived({}, 'a') === false);
  check('undefined registry 不抛错', isArchived(undefined, 'a') === false);

  // ── 7. 工具与配置接入 ───────────────────────────────────────────
  console.log('\n【工具面与配置】');
  {
    const { promises: nodeFs } = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    const mod = await import('../src/index.js');

    // DSH 内部包不在本项目的 node_modules 里，需从 DSH 安装位置解析。
    // 多锚点回退，避免把某个人的绝对路径写死。
    const anchors = [
      path.join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/package.json'),
      path.join(process.env.USERPROFILE ?? '', 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json'),
      path.join(process.env.DSH_HOME ?? '', 'profiles/web/package.json'),
    ].filter((p) => p.length > 0);

    /**
     * 解析 DSH 内部包。
     * @param {string} specifier - 包名。
     * @returns {string} file URL。
     */
    const resolveDsh = (specifier) => {
      for (const anchor of anchors) {
        try {
          return pathToFileURL(createRequire(anchor).resolve(specifier)).href;
        } catch { /* 换下一个锚点 */ }
      }
      throw new Error(`无法解析 ${specifier}，尝试过：${anchors.join(' | ')}`);
    };

    const { Context } = await import(resolveDsh('@deepseek-ai/cordis'));

    const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-arch-'));
    const app = new Context();
    const registered = [];
    app.provide('tools', {
      register: (tool) => {
        registered.push(tool);
        return () => {};
      },
    });
    app.provide('sessions', { list: () => [] });
    app.provide('sessionTitle', { get: () => ({ title: 'T' }) });
    app.provide('commands', { register: () => () => {} });

    mod.apply(app, {
      workspaceRoot: root,
      mirrorInstructions: false,
      writeJournal: false,
      dshHome: path.join(root, '_h'),
    });
    await new Promise((r) => setTimeout(r, 60));

    const names = registered.map((t) => t.name).sort();
    check('★ archiveMode 默认时注册了 workspace_archive',
      names.includes('workspace_archive'), JSON.stringify(names));
    check('工具总数变为 5', registered.length === 5, `实际 ${registered.length}: ${names.join(', ')}`);

    const archiveTool = registered.find((t) => t.name === 'workspace_archive');
    check('★ 描述明确说明「会弹卡片、点按钮才归档」',
      archiveTool.description.includes('按钮'), archiveTool.description);
    check('★ 描述警告不要在任务进行中调用',
      archiveTool.description.includes('进行中'), archiveTool.description);
    check('描述要求被拒后不要再问',
      archiveTool.description.includes('不要再问'), archiveTool.description);

    // archiveMode: 'off' → 不注册
    const app2 = new Context();
    const registered2 = [];
    app2.provide('tools', { register: (t) => { registered2.push(t); return () => {}; } });
    app2.provide('sessions', { list: () => [] });
    app2.provide('sessionTitle', { get: () => ({ title: 'T' }) });
    app2.provide('commands', { register: () => () => {} });
    mod.apply(app2, {
      workspaceRoot: root,
      mirrorInstructions: false,
      writeJournal: false,
      archiveMode: 'off',
      dshHome: path.join(root, '_h'),
    });
    await new Promise((r) => setTimeout(r, 60));
    check('★ archiveMode=off 时不注册 workspace_archive',
      !registered2.map((t) => t.name).includes('workspace_archive'),
      JSON.stringify(registered2.map((t) => t.name)));

    await nodeFs.rm(root, { recursive: true, force: true });
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

await main();
