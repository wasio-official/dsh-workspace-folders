/**
 * 事件日志 → Ledger Markdown 的语义投影。
 *
 * 设计原则：**不 dump 原始事件**。原始日志里体积最大、噪声最多的两类是
 * `assistant/message.stream`（逐 token 增量，与 `message.content` 高度重复）
 * 和 `assistant/attempt`（未提交为消息的失败尝试）。把它们丢掉，
 * 是「去除重复输出」最有效的一刀。
 * @module dsh-session-vault/ledger
 */

/** 一次投影产出的结构。 */
export class LedgerProjection {
  /**
   * @param {object} init - 各字段初值。
   */
  constructor(init) {
    /** 会话 id。 */
    this.sessionId = init.sessionId;
    /** 会话开始时间（ISO）。 */
    this.startedAt = init.startedAt;
    /** 会话结束时间（ISO）。 */
    this.endedAt = init.endedAt;
    /** 按顺序排列的段落。 */
    this.segments = init.segments;
    /** 元事件时间线（todo/hook/goal 等）。 */
    this.metaEvents = init.metaEvents;
    /** 统计信息。 */
    this.stats = init.stats;
  }
}

/**
 * 把一段会话事件投影为结构化段落。
 *
 * @param {object} params - 入参。
 * @param {string} params.sessionId - 会话 id。
 * @param {ReadonlyArray<object>} params.events - `session.snapshotEvents()` 的结果。
 * @param {object} [params.options] - 投影选项。
 * @param {number} [params.options.maxLedgerBytes] - ledger 文本的字节上限。
 * @returns {LedgerProjection} 投影结果。
 */
export function projectLedger({ sessionId, events, options = {} }) {
  const segments = [];
  const metaEvents = [];
  const stats = {
    totalEvents: events.length,
    userMessages: 0,
    assistantMessages: 0,
    interruptedMessages: 0,
    toolCalls: 0,
    toolFailures: 0,
    compactions: 0,
    turns: 0,
    syntheticUserMessages: 0,
  };

  /** callId → 工具调用信息，用于把 tool/result 配回它的 call。 */
  const pendingCalls = new Map();
  /** 当前所处的轮次与步骤，用于给段落打标。 */
  let currentTurn = 0;
  let currentStep = 0;

  const first = events[0];
  const last = events.at(-1);
  const startedAt = isoOf(first?.time);
  const endedAt = isoOf(last?.time);

  for (const event of events) {
    switch (event.type) {
      case 'turn/start': {
        currentTurn = event.data.turn;
        stats.turns = Math.max(stats.turns, currentTurn);
        break;
      }

      case 'step/start': {
        currentStep = event.data.step;
        break;
      }

      case 'user/message': {
        const message = event.data;
        const source = message.source?.kind ?? 'user';
        // 插件注入的「用户消息」（文件变更通知、AGENTS.md、skill 内容…）是噪声，
        // 不进入主阅读流，只在附录里留一行。
        if (source !== 'user') {
          stats.syntheticUserMessages += 1;
          metaEvents.push({
            at: isoOf(event.time),
            type: `user/message(${source})`,
            summary: truncate(extractText(message), 120),
          });
          break;
        }
        stats.userMessages += 1;
        segments.push({
          kind: 'user',
          turn: currentTurn,
          step: currentStep,
          at: isoOf(event.time),
          text: extractText(message),
        });
        break;
      }

      case 'assistant/message': {
        stats.assistantMessages += 1;
        if (event.data.interrupted === true) stats.interruptedMessages += 1;
        const text = extractText(event.data.message);
        // 注意：刻意**不**读取 event.data.stream —— 那是逐 token 增量，
        // 与 message.content 内容重复，是体积与「重复输出」的主要来源。
        if (text.trim().length === 0) break;
        segments.push({
          kind: 'assistant',
          turn: event.data.turn,
          step: event.data.step,
          at: isoOf(event.time),
          text,
          interrupted: event.data.interrupted === true,
          usage: event.data.usage,
        });
        break;
      }

      case 'tool/call': {
        stats.toolCalls += 1;
        pendingCalls.set(event.data.callId, {
          name: event.data.name,
          arguments: event.data.arguments,
          turn: event.data.turn,
          step: event.data.step,
        });
        break;
      }

      case 'tool/result': {
        const callId = event.data.message?.source?.callId ?? event.data.callId;
        const call = pendingCalls.get(callId);
        if (call) pendingCalls.delete(callId);
        const isError = event.data.error !== undefined;
        if (isError) stats.toolFailures += 1;
        segments.push({
          kind: 'tool',
          turn: event.data.turn,
          step: event.data.step,
          at: isoOf(event.time),
          toolName: call?.name ?? event.data.message?.source?.toolName ?? 'unknown',
          arguments: call?.arguments,
          output: extractText(event.data.message),
          isError,
        });
        break;
      }

      case 'compaction/start':
      case 'compaction/end':
      case 'compaction/summary':
      case 'compaction/prune': {
        if (event.type === 'compaction/start') stats.compactions += 1;
        metaEvents.push({
          at: isoOf(event.time),
          type: event.type,
          summary: `turn ${currentTurn}`,
        });
        // 压缩边界进主阅读流 —— 这是判断「上下文枯竭」的锚点。
        segments.push({
          kind: 'marker',
          turn: currentTurn,
          at: isoOf(event.time),
          text: event.type === 'compaction/start'
            ? `📦 上下文压缩开始（第 ${currentTurn} 轮）——其后内容可能因上下文枯竭而退化`
            : `📦 ${event.type}`,
        });
        break;
      }

      case 'assistant/attempt': {
        // 未提交为消息的失败/重试尝试：纯噪声，只计数。
        break;
      }

      case 'session/end-seed': {
        segments.push({
          kind: 'marker',
          turn: currentTurn,
          at: isoOf(event.time),
          text: '🧬 继承自上一代会话的种子历史到此为止',
        });
        break;
      }

      default: {
        // 其余元事件（todo/write、hook/*、goal/change、model/selection…）
        // 只留时间戳 + 类型 + 一行摘要，不占主阅读流。
        metaEvents.push({
          at: isoOf(event.time),
          type: event.type,
          summary: summarizeMetaEvent(event),
        });
        break;
      }
    }
  }

  const projection = new LedgerProjection({
    sessionId,
    startedAt,
    endedAt,
    segments,
    metaEvents,
    stats,
  });

  if (options.maxLedgerBytes !== undefined) {
    projection.segments = capSegments(segments, options.maxLedgerBytes);
  }
  return projection;
}

/**
 * 把投影渲染成 Markdown。
 * @param {LedgerProjection} projection - 投影结果。
 * @param {object} [context] - 渲染上下文。
 * @param {number} [context.generation] - 世代号。
 * @param {string} [context.charter] - 任务章程路径或摘要。
 * @returns {string} Markdown 文本。
 */
export function renderLedger(projection, context = {}) {
  const lines = [];
  const { stats } = projection;

  lines.push(`# Ledger · 第 ${context.generation ?? '?'} 代会话`);
  lines.push('');
  lines.push(`- 会话 ID：\`${projection.sessionId}\``);
  lines.push(`- 起始：${projection.startedAt ?? '—'}`);
  lines.push(`- 结束：${projection.endedAt ?? '—'}`);
  if (context.charter !== undefined) lines.push(`- 章程：${context.charter}`);
  lines.push('');
  lines.push('## 统计');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 事件总数 | ${stats.totalEvents} |`);
  lines.push(`| 轮数 | ${stats.turns} |`);
  lines.push(`| 用户消息 | ${stats.userMessages} |`);
  lines.push(`| 助手消息 | ${stats.assistantMessages} |`);
  lines.push(`| 被中断的助手消息 | ${stats.interruptedMessages} |`);
  lines.push(`| 工具调用 | ${stats.toolCalls} |`);
  lines.push(`| 工具失败 | ${stats.toolFailures} |`);
  lines.push(`| 上下文压缩次数 | ${stats.compactions} |`);
  lines.push(`| 系统注入消息（已折叠） | ${stats.syntheticUserMessages} |`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 对话正文');
  lines.push('');

  let toolIndex = 0;
  for (const segment of projection.segments) {
    switch (segment.kind) {
      case 'user': {
        lines.push(`### 👤 用户 · 第 ${segment.turn} 轮`);
        lines.push('');
        lines.push(blockquote(segment.text));
        lines.push('');
        break;
      }
      case 'assistant': {
        const flag = segment.interrupted ? ' ⚠️ 被中断' : '';
        lines.push(`### 🤖 助手 · 第 ${segment.turn} 轮${flag}`);
        lines.push('');
        lines.push(segment.text.trim());
        lines.push('');
        break;
      }
      case 'tool': {
        toolIndex += 1;
        const flag = segment.isError ? ' ❌ 失败' : '';
        lines.push('<details>');
        lines.push(`<summary>🔧 工具调用 #${toolIndex}：<code>${escapeHtml(segment.toolName)}</code>${flag}</summary>`);
        lines.push('');
        if (segment.arguments !== undefined) {
          lines.push('**参数**');
          lines.push('');
          lines.push('```json');
          lines.push(truncate(prettyJson(segment.arguments), 4000));
          lines.push('```');
          lines.push('');
        }
        lines.push('**结果**');
        lines.push('');
        lines.push('```');
        lines.push(truncate(segment.output, 8000));
        lines.push('```');
        lines.push('');
        lines.push('</details>');
        lines.push('');
        break;
      }
      case 'marker': {
        lines.push(`> ${segment.text}`);
        lines.push('');
        break;
      }
      default: {
        break;
      }
    }
  }

  if (projection.metaEvents.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## 附录：元事件时间线');
    lines.push('');
    lines.push('| 时间 | 类型 | 摘要 |');
    lines.push('|---|---|---|');
    for (const meta of projection.metaEvents) {
      lines.push(`| ${meta.at ?? '—'} | \`${meta.type}\` | ${escapePipe(truncate(meta.summary ?? '', 160))} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 从 DSH 的 Message 结构中抽取纯文本。
 *
 * Message.content 是 `ContentBlock[]`；只保留 text 块，其余（图片、文件引用）
 * 折叠为一行占位说明，避免 ledger 里出现无意义的 base64。
 * @param {object|undefined} message - DSH 消息对象。
 * @returns {string} 纯文本。
 */
export function extractText(message) {
  if (message === undefined || message === null) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push(`[图片${block.mediaType ? ` ${block.mediaType}` : ''}]`);
    else if (block.type === 'file') parts.push(`[文件 ${block.name ?? block.path ?? ''}]`.trim());
    else if (typeof block.text === 'string') parts.push(block.text);
    else parts.push(`[${block.type ?? 'unknown'}]`);
  }
  return parts.join('\n');
}

/**
 * 为未知类型的元事件生成一行摘要。
 * @param {object} event - 会话事件。
 * @returns {string} 一行摘要。
 */
function summarizeMetaEvent(event) {
  const data = event.data;
  if (data === undefined || data === null) return '';
  if (typeof data !== 'object') return String(data);
  const keys = Object.keys(data);
  if (keys.length === 0) return '';
  // 只挑几个短标量字段做摘要，避免把大对象序列化进表格。
  const picked = [];
  for (const key of keys.slice(0, 4)) {
    const value = data[key];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      picked.push(`${key}=${truncate(String(value), 40)}`);
    }
  }
  return picked.join(' ');
}

/**
 * 按字节上限截断段落列表，并在末尾留一条说明。
 * @param {Array<object>} segments - 原段落。
 * @param {number} maxBytes - 上限。
 * @returns {Array<object>} 截断后的段落。
 */
function capSegments(segments, maxBytes) {
  const out = [];
  let used = 0;
  for (const segment of segments) {
    const size = approximateBytes(segment.text ?? segment.output ?? '');
    if (used + size > maxBytes) {
      out.push({
        kind: 'marker',
        turn: segment.turn,
        at: segment.at,
        text: `✂️ 已达 ledger 体积上限（${maxBytes} 字节），其余 ${segments.length - out.length} 个段落未收录。`
          + ' 完整内容见 DSH 原生会话日志。',
      });
      break;
    }
    used += size;
    out.push(segment);
  }
  return out;
}

/**
 * 粗略估算 UTF-8 字节数（中文约 3 字节/字符）。
 * @param {string} text - 输入文本。
 * @returns {number} 估算字节数。
 */
export function approximateBytes(text) {
  if (typeof text !== 'string') return 0;
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * 把文本渲染为 Markdown 引用块。
 * @param {string} text - 输入文本。
 * @returns {string} 引用块文本。
 */
function blockquote(text) {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * 安全地 pretty-print 工具参数。
 *
 * 入参可能是**对象**（`tool/call` 的 `data.arguments` 实际就是对象），
 * 也可能是 JSON **字符串**。早期版本只处理字符串：对一个对象调
 * `JSON.parse` 会抛错，兜底 `String(obj)` 就渲染成 `[object Object]` ——
 * 工具参数在 log 里全部丢失。这里两种都处理。
 * @param {unknown} raw - 参数值。
 * @returns {string} 格式化后的文本。
 */
function prettyJson(raw) {
  if (typeof raw === 'string') {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  try {
    return JSON.stringify(raw, null, 2) ?? String(raw);
  } catch {
    // 循环引用等极端情形：退回可读的浅层表示。
    return String(raw);
  }
}

/**
 * 截断文本并加省略标记。
 * @param {string} text - 输入。
 * @param {number} max - 最大字符数。
 * @returns {string} 截断后的文本。
 */
export function truncate(text, max) {
  const str = typeof text === 'string' ? text : String(text ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, max)}…（已截断 ${str.length - max} 字符）`;
}

/**
 * 转义 HTML 特殊字符，用于 `<summary>` 内。
 * @param {string} text - 输入。
 * @returns {string} 转义后的文本。
 */
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 转义 Markdown 表格中的竖线。
 * @param {string} text - 输入。
 * @returns {string} 转义后的文本。
 */
function escapePipe(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * 把毫秒时间戳转成 ISO 字符串。
 * @param {number|undefined} time - 毫秒时间戳。
 * @returns {string|undefined} ISO 字符串或 undefined。
 */
function isoOf(time) {
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString();
}
