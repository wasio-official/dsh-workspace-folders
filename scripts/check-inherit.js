/**
 * 继承（④）验证：归档老对话 + 对接 log。
 *
 * 覆盖：
 *   1. **状态判定** —— live / stopped / gone / unknown 四态；
 *   2. **④ 主流程** —— 已停止的老对话被归档、log 被移入 archive、交接文件生成；
 *   3. **安全检查** —— 没有 log 就不动手、活跃的走 ⑤、幂等；
 *   4. **「对接 log」** —— 交接内容真的被写进 AGENTS.md（新对话读得到）；
 *   5. **degrade 提炼** —— 去重复、去空转、去自我回退。
 *
 * 运行：node scripts/check-inherit.js
 * @module dsh-workspace-folders/scripts/check-inherit
 */

import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  probeSessionState, findSessionLog, archiveLogFile, inheritStoppedSessions,
  findLiveSiblings, listLogFiles, resolveSessionsRoot, describeDisposition,
} from '../src/inherit.js';
import { condenseLog, renderInheritNote } from '../src/degrade.js';
import { readBinding, findSession, writeBinding } from '../src/naming.js';

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
 * 造一个假 ctx。
 * @param {object} [options] - 入参。
 * @param {Array<string>} [options.live] - 内存中活着的会话 id。
 * @returns {object} 假 ctx。
 */
function makeCtx({ live = [] } = {}) {
  return {
    sessions: {
      get: (id) => (live.includes(id) ? { id } : undefined),
    },
  };
}

/** 主流程。 */
async function main() {
  console.log('继承验证（需求④）');
  console.log('='.repeat(72));

  const tmp = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-inherit-'));
  const sessionsRoot = path.join(tmp, 'sessions');
  const dir = path.join(tmp, '2026-09-23-fix-auth');
  const logDir = path.join(dir, 'log');

  /** 重建一个干净的子文件夹 fixture。 */
  const reset = async () => {
    await nodeFs.rm(dir, { recursive: true, force: true });
    await nodeFs.rm(sessionsRoot, { recursive: true, force: true });
    await nodeFs.mkdir(logDir, { recursive: true });
    await nodeFs.mkdir(sessionsRoot, { recursive: true });
  };

  // ── 1. 状态判定 ─────────────────────────────────────────────────
  console.log('\n【状态判定 live / stopped / gone】');
  await reset();
  {
    const ctx = makeCtx({ live: ['alive'] });
    check('★ 内存中有 → live',
      await probeSessionState({ ctx, sessionId: 'alive', sessionsRoot }) === 'live');

    await nodeFs.mkdir(path.join(sessionsRoot, 'dead'), { recursive: true });
    check('★ 磁盘有目录、内存没有 → stopped',
      await probeSessionState({ ctx, sessionId: 'dead', sessionsRoot }) === 'stopped');

    check('★ 都没有 → gone',
      await probeSessionState({ ctx, sessionId: 'ghost', sessionsRoot }) === 'gone');

    check('拿不到 sessionsRoot → unknown',
      await probeSessionState({ ctx, sessionId: 'x', sessionsRoot: undefined }) === 'unknown');
  }

  // ── 2. ④ 主流程 ─────────────────────────────────────────────────
  console.log('\n【④ 主流程：归档已停止的老对话】');
  await reset();
  {
    const oldId = 'old-session';
    const newId = 'new-session';
    await nodeFs.mkdir(path.join(sessionsRoot, oldId), { recursive: true });
    await nodeFs.writeFile(
      path.join(logDir, `0001-${oldId}.md`),
      [
        '# 修复登录 bug',
        '',
        '## 结论',
        '- 问题出在 token 过期判断，已改为提前 60 秒刷新',
        '- 新增了两条回归测试，覆盖边界情况',
        '- 好的',
        '- 明白了',
        '- 我错了，让我重新说一遍这个问题',
        '- 问题出在 token 过期判断，已改为提前 60 秒刷新',
      ].join('\n'),
      'utf8',
    );
    await writeBinding(dir, { sessions: [{ id: oldId, state: 'active' }] });

    const archivedCalls = [];
    const result = await inheritStoppedSessions({
      ctx: makeCtx(),
      dir,
      sessionId: newId,
      folderTitle: '2026-09-23-fix-auth',
      sessionsRoot,
      archive: async ({ sessionId }) => {
        archivedCalls.push(sessionId);
        return { archived: true, outcome: 'allowed-once', message: 'ok' };
      },
    });

    check('★ 老对话被归档', archivedCalls.includes(oldId), JSON.stringify(archivedCalls));
    check('处置结论为 archived-stopped',
      result.entries[0]?.disposition === 'archived-stopped', JSON.stringify(result.entries));

    // log 被移入 archive
    const archivedLog = path.join(logDir, 'archive', `inherited-0001-${oldId}.md`);
    const archivedLogExists = (await nodeFs.stat(archivedLog).catch(() => undefined))?.isFile() === true;
    check('★ 旧 log 被移入 log/archive/', archivedLogExists);
    check('★ 原位置的 log 已不在（是移动而非复制）',
      (await nodeFs.stat(path.join(logDir, `0001-${oldId}.md`)).catch(() => undefined)) === undefined);
    check('归档的 log 带「已被继承」标注',
      (await nodeFs.readFile(archivedLog, 'utf8')).includes('已被后续对话继承'));

    // 交接文件
    check('★ 生成了交接说明 INHERITED-FROM.md',
      (await nodeFs.stat(path.join(logDir, 'archive', 'INHERITED-FROM.md')).catch(() => undefined))?.isFile() === true);
    const handoffFile = path.join(dir, 'AGENTS.md');
    const handoffExists = (await nodeFs.stat(handoffFile).catch(() => undefined))?.isFile() === true;
    check('★ 交接内容写进了子文件夹的 AGENTS.md（新对话读得到）', handoffExists);

    const handoff = handoffExists ? await nodeFs.readFile(handoffFile, 'utf8') : '';
    check('★ 交接内容含上一段的关键结论',
      handoff.includes('token 过期判断'), handoff.slice(0, 300));
    check('★ 交接内容明确警告「不要当成当前指令」',
      handoff.includes('不要') && handoff.includes('当前任务'), handoff.slice(0, 300));
    check('交接内容不含空转段落「明白了」', !handoff.includes('明白了'));
    check('交接内容不含自我回退段落', !handoff.includes('我错了'));

    // 绑定记录更新
    const binding = await readBinding(dir);
    check('★ 绑定记录里老会话被标为 inherited',
      findSession(binding, oldId)?.state === 'inherited',
      JSON.stringify(binding));
    check('绑定记录里记了 log 相对路径',
      findSession(binding, oldId)?.log?.includes('archive/'),
      JSON.stringify(findSession(binding, oldId)));
  }

  // ── 3. 安全检查 ─────────────────────────────────────────────────
  console.log('\n【安全检查】');
  await reset();
  {
    // 没有 log → 不动手
    const oldId = 'no-log-session';
    await nodeFs.mkdir(path.join(sessionsRoot, oldId), { recursive: true });
    await writeBinding(dir, { sessions: [{ id: oldId, state: 'active' }] });

    const archivedCalls = [];
    const result = await inheritStoppedSessions({
      ctx: makeCtx(),
      dir,
      sessionId: 'new-session',
      sessionsRoot,
      archive: async ({ sessionId }) => { archivedCalls.push(sessionId); return { archived: true }; },
    });

    check('★ 没有 log 时**不归档**（保留 log 的承诺不能是空的）',
      archivedCalls.length === 0, JSON.stringify(archivedCalls));
    check('处置结论为 skipped-no-log',
      result.entries[0]?.disposition === 'skipped-no-log', JSON.stringify(result.entries));
    check('没有 log 时不生成交接文件',
      (await nodeFs.stat(path.join(dir, 'AGENTS.md')).catch(() => undefined)) === undefined);
  }
  {
    // 活跃的老对话 → 走 ⑤，不在 ④ 里归档
    const liveId = 'live-session';
    await nodeFs.writeFile(path.join(logDir, `0001-${liveId}.md`), '# 活跃对话\n- 还在跑', 'utf8');
    await writeBinding(dir, { sessions: [{ id: liveId, state: 'active' }] });

    const archivedCalls = [];
    const result = await inheritStoppedSessions({
      ctx: makeCtx({ live: [liveId] }),
      dir,
      sessionId: 'new-session',
      sessionsRoot,
      archive: async ({ sessionId }) => { archivedCalls.push(sessionId); return { archived: true }; },
    });

    check('★ 活跃的老对话不被 ④ 归档（那是 ⑤ 的事）',
      archivedCalls.length === 0, JSON.stringify(archivedCalls));
    check('处置结论为 yield-to-live',
      result.entries[0]?.disposition === 'yield-to-live', JSON.stringify(result.entries));

    // ⑤ 的判定函数
    const live = await findLiveSiblings({
      ctx: makeCtx({ live: [liveId] }), dir, sessionId: 'new-session', sessionsRoot,
    });
    check('★ findLiveSiblings 能找到活跃的老对话',
      live.length === 1 && live[0].id === liveId, JSON.stringify(live));
  }
  {
    // 幂等：已处置过的不重复处理
    const oldId = 'done-session';
    await writeBinding(dir, { sessions: [{ id: oldId, state: 'inherited' }] });
    const archivedCalls = [];
    const result = await inheritStoppedSessions({
      ctx: makeCtx(),
      dir,
      sessionId: 'new-session',
      sessionsRoot,
      archive: async ({ sessionId }) => { archivedCalls.push(sessionId); return { archived: true }; },
    });
    check('★ 已 inherited 的不重复归档',
      archivedCalls.length === 0, JSON.stringify(archivedCalls));
    check('处置结论为 skipped-already',
      result.entries[0]?.disposition === 'skipped-already', JSON.stringify(result.entries));
  }
  {
    // 归档失败时不应谎报成功
    await reset();
    const oldId = 'fail-session';
    await nodeFs.mkdir(path.join(sessionsRoot, oldId), { recursive: true });
    await nodeFs.writeFile(path.join(logDir, `0001-${oldId}.md`), '# x\n- 内容够长的一条记录', 'utf8');
    await writeBinding(dir, { sessions: [{ id: oldId, state: 'active' }] });

    const result = await inheritStoppedSessions({
      ctx: makeCtx(),
      dir,
      sessionId: 'new-session',
      sessionsRoot,
      archive: async () => ({ archived: false, outcome: 'error', message: 'boom' }),
    });
    check('★ 归档失败时不标记为 inherited',
      result.entries[0]?.disposition !== 'archived-stopped', JSON.stringify(result.entries));
    const binding = await readBinding(dir);
    check('归档失败时绑定记录未被改成 inherited',
      findSession(binding, oldId)?.state === 'active', JSON.stringify(binding));
  }
  {
    // 自己不在 others 里
    await reset();
    await writeBinding(dir, { sessions: [{ id: 'me', state: 'active' }] });
    const result = await inheritStoppedSessions({
      ctx: makeCtx(), dir, sessionId: 'me', sessionsRoot,
      archive: async () => ({ archived: true }),
    });
    check('★ 不会把自己当成老对话处理', result.entries.length === 0, JSON.stringify(result.entries));
  }

  // ── 4. degrade 提炼 ─────────────────────────────────────────────
  console.log('\n【degrade 提炼（去重复 / 去空转 / 去自我回退）】');
  {
    const text = [
      '# 标题',
      '- 第一条有信息量的结论，足够长',
      '- 第一条有信息量的结论，足够长',
      '- 好的',
      '- 我错了，让我重新开始',
      '- 第二条不同的结论，也足够长',
      '---',
      '<!-- 注释应被丢掉 -->',
    ].join('\n');
    const condensed = condenseLog(text);

    check('★ 重复条目被剔除', condensed.droppedRepeats >= 1, JSON.stringify(condensed));
    check('★ 空转条目被剔除', condensed.droppedIdle >= 1, JSON.stringify(condensed));
    check('★ 自我回退条目被剔除', condensed.droppedRetractions >= 1, JSON.stringify(condensed));
    check('保留了两条有效结论', condensed.bullets.length === 2, JSON.stringify(condensed.bullets));
    check('注释行未被收入', !condensed.bullets.some((b) => b.includes('注释')));
    check('分隔线未被收入', !condensed.bullets.some((b) => /^[-=*_]{3,}$/.test(b)));

    const bounded = condenseLog(text, { maxBullets: 1 });
    check('maxBullets 生效', bounded.bullets.length === 1, JSON.stringify(bounded.bullets));

    const empty = condenseLog('');
    check('空输入不抛错且产出空', empty.bullets.length === 0);

    // 回归：短而有效的条目**不能**被空转判定误杀。
    // （曾经的 bug：isIdle 的门槛是「剩余 ≥15 字符」，把这类条目全吃掉。）
    const short = condenseLog('- 已修复 token 判断');
    check('★ 短而有效的条目被保留（不被误判为空转）',
      short.bullets.length === 1, JSON.stringify(short));

    // 回归：空转优先于长度门槛计数，否则 droppedIdle 会漏计。
    const counters = condenseLog(['- 好的', '- 嗯', '- 有效内容够长的一条'].join('\n'));
    check('★ 空转计数不因长度门槛而漏计',
      counters.droppedIdle === 2, JSON.stringify(counters));
  }

  // ── 5. 交接指令渲染 ─────────────────────────────────────────────
  console.log('\n【交接指令渲染】');
  {
    const text = renderInheritNote({
      entries: [{ id: 'abc', archivedLog: 'log/archive/x.md', bullets: ['要点一'] }],
      folderTitle: 'fix-auth',
      now: '2026-09-23T00:00:00Z',
    });
    check('含来源会话 id', text.includes('abc'));
    check('含要点', text.includes('要点一'));
    check('含完整 log 路径', text.includes('log/archive/x.md'));
    check('含「不是当前任务」的警告', text.includes('不是当前任务') || text.includes('不要'));
    check('含 folderTitle', text.includes('fix-auth'));

    const noBullets = renderInheritNote({ entries: [{ id: 'x', bullets: [] }] });
    check('无要点时给出查阅提示', noBullets.includes('完整 log'), noBullets);
  }

  // ── 6. 杂项 ─────────────────────────────────────────────────────
  console.log('\n【辅助函数】');
  await reset();
  {
    check('listLogFiles 空目录返回空数组', (await listLogFiles(dir)).length === 0);
    await nodeFs.writeFile(path.join(logDir, `0001-target.md`), '# x', 'utf8');
    check('★ findSessionLog 能按 id 找到 log',
      (await findSessionLog(dir, 'target'))?.endsWith('0001-target.md'),
      String(await findSessionLog(dir, 'target')));
    check('findSessionLog 找不到时返回 undefined',
      (await findSessionLog(dir, 'nope')) === undefined);

    const miss = await archiveLogFile({ dir, sessionId: 'nope' });
    check('archiveLogFile 找不到 log 时 moved=false', miss.moved === false);

    check('resolveSessionsRoot 拼出 sessions 目录',
      resolveSessionsRoot({ dshHome: '/x/.dsh' })?.endsWith('sessions') === true
      || resolveSessionsRoot({ dshHome: 'C:/x/.dsh' })?.endsWith('sessions') === true,
      String(resolveSessionsRoot({ dshHome: '/x/.dsh' })));

    check('describeDisposition 有中文说明',
      describeDisposition('archived-stopped').includes('归档'));
    check('describeDisposition 对未知码原样返回',
      describeDisposition('weird') === 'weird');
  }

  await nodeFs.rm(tmp, { recursive: true, force: true });

  console.log(`\n${'='.repeat(72)}`);
  console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

await main();
