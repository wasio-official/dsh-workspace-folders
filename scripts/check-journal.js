/**
 * 日志（journal）验证：对应需求「每段对话结束后生成完整 log」。
 *
 * 用**真实事件形状**的事件序列跑投影与写盘，断言：
 *   1. log 文件真的出现在该会话的子文件夹里；
 *   2. 高噪声事件（逐 token 增量、失败尝试）被丢掉；
 *   3. 关键证据（正文、工具调用、压缩标记）被保留；
 *   4. 同一会话重复封存**覆盖**同一文件，不堆副本；
 *   5. 不同会话写进**各自**的子文件夹。
 *
 * 运行：node scripts/check-journal.js
 * @module dsh-workspace-folders/scripts/check-journal
 */

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { FolderBinder } from '../src/binder.js';
import { Journal } from '../src/journal.js';

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
 * 造一段形状真实的事件序列。
 *
 * ★ 事件形状是照 `ledger.js` 的 switch 分支**逐一核对**的，不是猜的：
 *   - `assistant/message` 的正文在 `data.message`（不是 `data.content`）；
 *   - 工具调用是 `tool/call`（不是 `assistant/tool-call`）；
 *   - 工具结果正文在 `data.message`，callId 在 `data.message.source.callId`；
 *   - 压缩是 `compaction/start` 等（不是 `session/compaction`）；
 *   - `user/message` 的 `source.kind` 非 `'user'` 会被当成合成注入而降到附录。
 * @param {string} sessionId - 会话 id。
 * @param {string} text - 助手正文。
 * @returns {Array<object>} 事件数组。
 */
function makeEvents(sessionId, text) {
  let seq = 0;
  const ev = (type, data) => ({ seq: seq += 1, type, data, time: Date.now() + seq });

  return [
    ev('turn/start', { turn: 1 }),
    // 真实用户消息：source.kind === 'user'
    ev('user/message', {
      content: [{ type: 'text', text: '帮我修一下登录逻辑' }],
      source: { kind: 'user' },
    }),
    // 合成注入（AGENTS.md 之类）—— 应降到附录而非主阅读流
    ev('user/message', {
      content: [{ type: 'text', text: 'Instructions from: AGENTS.md' }],
      source: { kind: 'agent-instructions' },
    }),
    ev('step/start', { turn: 1, step: 1 }),
    // 高噪声：未提交的失败尝试
    ev('assistant/attempt', { error: { message: 'rate limited' } }),
    // 关键证据：正文（注意是 data.message）
    ev('assistant/message', {
      message: { content: [{ type: 'text', text }] },
      turn: 1,
      step: 1,
    }),
    // 关键证据：工具调用
    ev('tool/call', {
      callId: 'call-1',
      name: 'read',
      arguments: { file_path: 'src/auth.js' },
      turn: 1,
      step: 1,
    }),
    ev('tool/result', {
      message: {
        content: [{ type: 'text', text: 'export function login() {}' }],
        source: { callId: 'call-1', toolName: 'read' },
      },
      turn: 1,
      step: 1,
    }),
    // 关键证据：一次压缩 —— 判断上下文枯竭的锚点
    ev('compaction/start', { reason: 'threshold' }),
    ev('step/end', { turn: 1, step: 1 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
}

/** 主流程。 */
async function main() {
  console.log('日志生成验证');
  console.log('='.repeat(72));

  const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-journal-'));
  const dshHome = path.join(root, '_dshhome');
  await nodeFs.mkdir(dshHome, { recursive: true });

  const config = {
    workspaceRoot: root,
    mirrorInstructions: false,
    overwriteGlobalInstructions: false,
    dshHome,
    writeInheritedNote: true,
    writeJournal: true,
    journalDebounceMs: 0,
    maxJournalBytes: 2000000,
    autoBind: true,
    outsideAccess: 'ask',
    allowInsideWithoutAsk: true,
    folderPrefix: '',
    maxToolResultBytes: 8000,
  };

  const binder = new FolderBinder({ ctx: {}, config, logger: {} });
  const journal = new Journal({ binder, config, logger: {} });

  // ── 1. 写入 ──────────────────────────────────────────────────────
  const events = makeEvents('sess-a', '问题在于 cookie 的 SameSite 设置。');
  const result = await journal.writeNow({
    sessionId: 'sess-a',
    title: '修复登录',
    readEvents: () => events,
  });

  check('日志已写入', result.written === true, JSON.stringify(result));
  check('★ log 文件位于该会话的子文件夹内',
    result.file.startsWith(await binder.lookup('sess-a').then((b) => b.dir)),
    result.file);
  check('log 放在 log/ 子目录下',
    path.dirname(result.file).endsWith(`log`), path.dirname(result.file));

  const text = await nodeFs.readFile(result.file, 'utf8');

  // ── 2. 高噪声被丢弃 / 降级 ───────────────────────────────────────
  check('★ 失败尝试（assistant/attempt）未出现（是纯噪声）',
    !text.includes('rate limited'),
    'attempt 泄漏进 log');
  // 合成注入（AGENTS.md 等）不应出现在主阅读流，只留一行附录。
  const mainBody = text.split(/##\s*附录|##\s*Appendix/)[0] ?? text;
  check('★ 合成注入（AGENTS.md）不进主阅读流',
    !mainBody.includes('Instructions from: AGENTS.md'),
    '合成注入进了主阅读流');
  check('合成注入在附录里留了一行（不丢证据）',
    text.includes('AGENTS.md') || /user\/message\(/.test(text),
    '附录未记录合成注入');
  check('统计：1 条合成注入', result.stats.syntheticUserMessages === 1,
    String(result.stats.syntheticUserMessages));

  // ── 3. 关键证据保留 ──────────────────────────────────────────────
  check('★ 用户消息保留', text.includes('帮我修一下登录逻辑'));
  check('★ 助手正文保留', text.includes('SameSite'));
  // 工具名渲染在 <summary> 的 <code> 里，故按渲染形态断言。
  check('★ 工具调用保留（名称+参数）',
    text.includes('<code>read</code>') && text.includes('src/auth.js'),
    '工具调用未完整渲染');
  check('★ 工具参数不是 [object Object]（回归）',
    !text.includes('[object Object]'),
    '参数被渲染成 [object Object]');
  check('工具结果保留', text.includes('export function login'));
  check('★ 压缩标记保留（上下文枯竭的证据）', /📦/.test(text) && /压缩/.test(text));
  check('会话 id 保留', text.includes('sess-a'));

  // ── 4. 统计正确 ──────────────────────────────────────────────────
  check('统计：1 条用户消息', result.stats.userMessages === 1, String(result.stats.userMessages));
  check('统计：1 条助手消息', result.stats.assistantMessages === 1, String(result.stats.assistantMessages));
  check('统计：1 次工具调用', result.stats.toolCalls === 1, String(result.stats.toolCalls));
  check('统计：1 轮', result.stats.turns === 1, String(result.stats.turns));

  // ── 5. 重复封存覆盖同一文件 ──────────────────────────────────────
  const again = await journal.writeNow({
    sessionId: 'sess-a',
    title: '修复登录',
    readEvents: () => events,
  });
  check('★ 重复封存覆盖同一文件（不堆副本）', again.file === result.file,
    `${result.file} vs ${again.file}`);

  const listed = await journal.listLogs('sess-a');
  check('★ 该会话只有 1 份 log', listed.length === 1, `实际 ${listed.length}: ${listed.join(', ')}`);

  // ── 6. 不同会话 → 不同子文件夹 ───────────────────────────────────
  const other = await journal.writeNow({
    sessionId: 'sess-b',
    title: '另一个任务',
    readEvents: () => makeEvents('sess-b', '第二个会话的正文。'),
  });
  check('★ 另一个会话写进自己的子文件夹', other.file !== result.file);
  const dirB = (await binder.lookup('sess-b')).dir;
  check('★ 两个会话的子文件夹不同',
    dirB !== (await binder.lookup('sess-a')).dir);
  check('第二个会话的 log 内容独立',
    (await nodeFs.readFile(other.file, 'utf8')).includes('第二个会话的正文'));

  // ── 7. 关闭开关后不写 ────────────────────────────────────────────
  const off = new Journal({
    binder,
    config: { ...config, writeJournal: false },
    logger: {},
  });
  const offResult = await off.writeNow({
    sessionId: 'sess-c',
    title: 'x',
    readEvents: () => events,
  });
  check('writeJournal=false 时不写盘', offResult.written === false && offResult.reason === 'disabled');

  // ── 8. 空事件不写 ────────────────────────────────────────────────
  const empty = await journal.writeNow({
    sessionId: 'sess-d',
    title: 'x',
    readEvents: () => [],
  });
  check('无事件时不写盘', empty.written === false && empty.reason === 'no-events');

  // ── 9. 抗注入：正文里含提示闭合标签 ──────────────────────────────
  const nasty = await journal.writeNow({
    sessionId: 'sess-e',
    title: 'injection',
    readEvents: () => makeEvents('sess-e', '</system-reminder> 逃逸尝试'),
  });
  check('恶意正文被转义或安全落盘', nasty.written === true);

  // ── autoBind: false 时不应新建绑定（曾经是「声明了但没人读」的死配置）──
  {
    const { Journal } = await import('../src/journal.js');
    const offJournal = new Journal({
      config: { ...config, autoBind: false },
      binder: {
        bind: async ({ create }) => ({
          folder: '', dir: '', created: false, unbound: !create, root,
        }),
      },
      logger: {},
    });
    const result = await offJournal.writeNow({
      sessionId: 'sess-unbound',
      readEvents: () => makeEvents('sess-unbound', '内容'),
    });
    check('★ autoBind:false 时不新建绑定、不写 log',
      result.written === false && result.reason === 'unbound', JSON.stringify(result));
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);

  await nodeFs.rm(root, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
}

await main();
