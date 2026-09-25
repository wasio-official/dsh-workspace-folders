/**
 * 会话日志（journal）的生成 —— 对应需求「每段对话结束后在该对话的工作子
 * 文件夹内生成一个完整的 log」。
 *
 * ## 什么时候写
 *
 * 订阅 `turn/end`。DSH 在 agent-loop 的 `finally` 里**无条件**追加这个事件，
 * 因此它是唯一可靠的「这一轮真的结束了」信号。写盘做去抖，避免密集轮次
 * 反复写同一个文件。
 *
 * ## 写什么
 *
 * 用 `projectLedger` 做**语义投影**，而不是 dump 原始事件。原始日志里
 * 体积最大、噪声最多的两类会被丢掉：
 *   - `assistant/message.stream` —— 逐 token 增量，与 `message.content` 高度重复；
 *   - `assistant/attempt`        —— 未提交为消息的失败尝试。
 *
 * 这一刀是「去除重复输出」最有效的地方，且**证据不丢**：正文、工具调用、
 * 压缩标记、被中断的消息都保留在 ledger 里。
 *
 * ## 写在哪
 *
 * `<子文件夹>/log/NNNN-<sessionId>.md`。世代号从 1 递增，同一会话重复
 * 封存会**覆盖**同一份文件（而非追加一堆副本）—— 因为投影的输入是
 * 完整的会话事件快照，所以覆盖得到的是完整且最新的 log。
 *
 * @module dsh-workspace-folders/journal
 */

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';

import { projectLedger, renderLedger } from './ledger.js';

/** log 子目录名。 */
export const LOG_DIR = 'log';

/**
 * 写日志的结果。
 * @typedef {object} JournalResult
 * @property {boolean} written - 是否真的写了盘。
 * @property {string} file - 目标文件路径（未写时为空）。
 * @property {number} bytes - 写入字节数。
 * @property {object} [stats] - 投影统计。
 * @property {string} [reason] - 未写时的原因。
 */

/**
 * 会话日志写入器。
 */
export class Journal {
  /**
   * @param {object} options - 入参。
   * @param {object} options.binder - `FolderBinder` 实例。
   * @param {object} options.config - 已归一化配置。
   * @param {object} [options.logger] - 日志接口。
   */
  constructor({ binder, config, logger }) {
    this.binder = binder;
    this.config = config;
    this.logger = logger;
    /**
     * sessionId → 去抖定时器。
     * @type {Map<string, NodeJS.Timeout>}
     */
    this.timers = new Map();
    /**
     * sessionId → 该会话已写过的世代号，保证同一会话稳定覆盖同一文件。
     * @type {Map<string, number>}
     */
    this.generations = new Map();
    /** 串行化写盘，避免同一会话并发写。 */
    this.writeChain = Promise.resolve();
  }

  /**
   * 安排一次去抖写盘。
   *
   * 密集的 `turn/end`（例如模型连续多轮）只会在静默 `debounceMs` 之后
   * 触发一次真正的投影与写盘。
   * @param {object} options - 入参。
   * @param {string} options.sessionId - 会话 id。
   * @param {() => ReadonlyArray<object>} options.readEvents - 取当前事件快照。
   * @param {string} [options.title] - 会话标题（用于首次绑定目录名）。
   * @returns {void}
   */
  schedule({ sessionId, readEvents, title }) {
    if (!this.config.writeJournal) return;

    const existing = this.timers.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      void this.writeNow({ sessionId, readEvents, title }).catch((error) => {
        this.logger?.warn?.(
          `workspace-folders: journal write failed for ${sessionId}: ${String(error?.message ?? error)}`,
        );
      });
    }, this.config.journalDebounceMs);

    // Node 的 timer 会阻止进程退出；这里不需要它保活。
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  /**
   * 立即写一次日志。
   * @param {object} options - 入参。
   * @param {string} options.sessionId - 会话 id。
   * @param {() => ReadonlyArray<object>} options.readEvents - 取事件快照。
   * @param {string} [options.title] - 会话标题。
   * @returns {Promise<JournalResult>} 结果。
   */
  async writeNow({ sessionId, readEvents, title }) {
    if (!this.config.writeJournal) return { written: false, file: '', bytes: 0, reason: 'disabled' };

    const events = readEvents();
    if (!Array.isArray(events) || events.length === 0) {
      return { written: false, file: '', bytes: 0, reason: 'no-events' };
    }

    // 绑定（必要时创建）子文件夹 —— log 必须写在对话自己的工作文件夹里。
    //
    // `autoBind: false` 时**只复用已有绑定，不新建**：这样插件退化成
    // 「只给显式调用 workspace_bind 的会话写 log」，符合该开关的语义。
    const bound = await this.binder.bind({
      sessionId,
      title,
      create: this.config.autoBind !== false,
    });
    if (bound.unbound === true || bound.dir === '') {
      return { written: false, file: '', bytes: 0, reason: 'unbound' };
    }

    return this.enqueue(async () => {
      const projection = projectLedger({
        sessionId,
        events,
        options: { maxLedgerBytes: this.config.maxJournalBytes },
      });

      const generation = this.generations.get(sessionId) ?? 1;
      this.generations.set(sessionId, generation);

      const logDir = path.join(bound.dir, LOG_DIR);
      await nodeFs.mkdir(logDir, { recursive: true });

      const fileName = `${String(generation).padStart(4, '0')}-${safeSegment(sessionId)}.md`;
      const target = path.join(logDir, fileName);

      const text = renderLedger(projection, {
        generation,
        charter: title,
        sessionId,
      });

      await writeAtomic(target, text);
      return {
        written: true,
        file: target,
        bytes: Buffer.byteLength(text, 'utf8'),
        stats: projection.stats,
      };
    });
  }

  /**
   * 把写盘串起来，避免同一会话并发写同一个文件。
   * @param {() => Promise<any>} fn - 待执行操作。
   * @returns {Promise<any>} 结果。
   */
  async enqueue(fn) {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 清掉所有待触发的定时器（卸载时调用）。
   * @returns {void}
   */
  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * 列出某会话已生成的 log 文件。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<Array<string>>} 文件路径列表。
   */
  async listLogs(sessionId) {
    const bound = await this.binder.lookup(sessionId);
    if (bound === undefined) return [];
    const logDir = path.join(bound.dir, LOG_DIR);
    try {
      const names = await nodeFs.readdir(logDir);
      return names
        .filter((n) => n.endsWith('.md'))
        .sort()
        .map((n) => path.join(logDir, n));
    } catch {
      return [];
    }
  }
}

/**
 * 把任意 id 变成安全的文件名片段。
 * @param {string} value - 原始值。
 * @returns {string} 安全片段。
 */
function safeSegment(value) {
  return String(value ?? 'session')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[.]+/, '_')
    .slice(0, 80) || 'session';
}

/**
 * 原子写文件。
 * @param {string} target - 目标。
 * @param {string} text - 内容。
 * @returns {Promise<void>} 完成后兑现。
 */
async function writeAtomic(target, text) {
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await nodeFs.writeFile(temp, text, 'utf8');
  try {
    await nodeFs.rename(temp, target);
  } catch (error) {
    await nodeFs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
