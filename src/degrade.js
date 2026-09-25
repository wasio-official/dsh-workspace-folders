/**
 * 退化检测：识别「重复输出」与「上下文枯竭误输出」。
 *
 * 这是纯函数式的**确定性启发式**，不依赖模型、可重放、可审计。
 *
 * ## 两套 API（注意阅读顺序）
 *
 * | API | 输入 | 用途 | 现状 |
 * |---|---|---|---|
 * | `condenseLog` / `renderInheritNote` | **log 的 Markdown 文本** | 需求④ 交接摘要 | ✅ **在用** |
 * | `analyzeDegradation` / `keepConfident` | **Ledger 投影对象** | 原 session-vault 的 Digest | ⚠️ **当前未接线** |
 *
 * 前者是后者的**轻量替代**：交接发生在「log 已经落盘」之后，
 * 这时手里只有 Markdown 文本，没有 Ledger 投影对象，所以
 * `analyzeDegradation` 用不上。保留它是为了不丢掉已经验证过的启发式
 * （句子级重复度算法 `maxJaccard` 被 `condenseLog` 复用）。
 *
 * ⚠️ **诚实说明**：`analyzeDegradation` / `keepConfident` 目前没有任何
 * 调用方。如果将来不需要「按段落打置信度」这条路径，可以安全删除
 * （连同其专属的 `isIdle` / `hasRepeatedLines`）。
 *
 * @module dsh-workspace-folders/degrade
 */

/** 表示「模型在自我回退/推翻前文」的标记短语。 */
const RETRACTION_MARKERS = [
  '忽略上面', '忽略之前', '忽略以上', '我错了', '我搞错了', '让我重新', '重新开始',
  '抱歉，我', '前面的回答有误', '更正一下', '收回刚才', '不对，',
  'ignore the above', 'ignore previous', 'i was wrong', 'let me start over',
  'disregard', 'actually, no', 'correction:',
];

/** 表示内容空洞、没有信息量的短语（整段几乎只有这些时判为空转）。 */
const EMPTY_PHRASES = [
  '好的', '明白了', '收到', '继续', '让我想想', '稍等', '正在处理',
  'ok', 'okay', 'sure', 'got it', 'let me think',
];

/**
 * 对投影结果做退化分析，为每个助手/用户段落附加 `confidence` 与 `flags`。
 *
 * @param {import('./ledger.js').LedgerProjection} projection - 投影结果。
 * @param {object} [options] - 配置。
 * @param {boolean} [options.enabled] - 是否启用；false 时全部段落置高置信度。
 * @param {number} [options.repeatThreshold] - 句子级 Jaccard 相似度阈值。
 * @param {number} [options.minConfidence] - 低于此值的段落不进 Digest。
 * @returns {{segments: Array<object>, report: object}} 附加了分析结果的段落与汇总报告。
 */
export function analyzeDegradation(projection, options = {}) {
  const enabled = options.enabled !== false;
  const repeatThreshold = clamp01(options.repeatThreshold ?? 0.75);
  const minConfidence = clamp01(options.minConfidence ?? 0.4);

  const segments = projection.segments;
  const report = {
    analyzed: 0,
    lowConfidence: 0,
    flags: {},
    compactedAt: [],
  };

  if (!enabled) {
    for (const segment of segments) {
      segment.confidence = 1;
      segment.flags = [];
    }
    return { segments, report };
  }

  // 记录压缩标记出现的位置，其后的段落要额外警惕。
  const compactionIndices = [];
  segments.forEach((segment, index) => {
    if (segment.kind === 'marker' && typeof segment.text === 'string' && segment.text.includes('上下文压缩')) {
      compactionIndices.push(index);
      report.compactedAt.push(segment.turn);
    }
  });

  /** 已处理过的助手段落文本，用于跨段比较。 */
  const seenAssistant = [];
  /** 统计同一工具 + 相似参数连续失败的次数。 */
  let lastFailureSignature;
  let consecutiveFailures = 0;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const flags = [];
    let confidence = 1;

    if (segment.kind === 'tool') {
      if (segment.isError) {
        const signature = `${segment.toolName}::${normalizeForCompare(segment.arguments ?? '')}`;
        consecutiveFailures = signature === lastFailureSignature ? consecutiveFailures + 1 : 1;
        lastFailureSignature = signature;
        if (consecutiveFailures >= 3) {
          flags.push('tool-failure-loop');
          confidence -= 0.25;
        }
      } else {
        consecutiveFailures = 0;
        lastFailureSignature = undefined;
      }
      segment.confidence = clamp01(confidence);
      segment.flags = flags;
      continue;
    }

    if (segment.kind !== 'assistant') {
      segment.confidence = 1;
      segment.flags = flags;
      continue;
    }

    report.analyzed += 1;
    const text = segment.text ?? '';

    // ① 重复：与前面某个助手段落高度相似。
    const maxSimilarity = maxJaccard(text, seenAssistant);
    if (maxSimilarity >= repeatThreshold) {
      flags.push('repeat');
      confidence -= 0.4;
    } else if (maxSimilarity >= repeatThreshold * 0.85) {
      flags.push('near-repeat');
      confidence -= 0.35;
    }
    seenAssistant.push(text);

    // ② 自我回退 / 推翻前文。
    const lowered = text.toLowerCase();
    if (RETRACTION_MARKERS.some((marker) => lowered.includes(marker))) {
      flags.push('retraction');
      confidence -= 0.3;
    }

    // ③ 空转：段落很短且没有实质信息。
    if (isIdle(text)) {
      flags.push('idle');
      confidence -= 0.6;
    }

    // ④ 单段内重复枚举：同一行出现 3 次以上。
    if (hasRepeatedLines(text)) {
      flags.push('repeated-enumeration');
      confidence -= 0.3;
    }

    // ⑤ 被中断的半截输出。
    if (segment.interrupted === true) {
      flags.push('interrupted');
      confidence -= 0.25;
    }

    // ⑥ 压缩之后：以上任何命中的惩罚再叠加一档（上下文枯竭会放大退化）。
    const afterCompaction = compactionIndices.some((markerIndex) => markerIndex < index);
    if (afterCompaction && flags.length > 0) {
      flags.push('post-compaction');
      confidence -= 0.3;
    }

    // ⑦ 硬判定：`repeat` 与 `idle` 是「这一段没有新信息」的确定性证据。
    //    仅靠惩罚累加时，一段内容可能恰好停在阈值之上而漏网，
    //    因此这里直接把它们压到阈值之下 —— 这才是「去除重复输出」的可靠保证。
    if (flags.includes('repeat') || flags.includes('idle')) {
      confidence = Math.min(confidence, minConfidence - 0.01);
    }

    segment.confidence = clamp01(confidence);
    segment.flags = flags;

    if (segment.confidence < minConfidence) report.lowConfidence += 1;
    for (const flag of flags) report.flags[flag] = (report.flags[flag] ?? 0) + 1;
  }

  return { segments, report };
}

/**
 * 挑出「可以进入 Digest」的段落。
 * @param {Array<object>} segments - 已分析的段落。
 * @param {number} minConfidence - 置信度下限。
 * @returns {Array<object>} 通过筛选的段落。
 */
export function keepConfident(segments, minConfidence) {
  return segments.filter((segment) => {
    if (segment.kind === 'marker') return true;
    // 用户消息永远保留：它是意图的权威，不应被启发式判掉。
    if (segment.kind === 'user') return true;
    return (segment.confidence ?? 1) >= minConfidence;
  });
}

/**
 * 计算一个文本与一组候选文本的最大「句子级重复度」。
 *
 * 同时看两个指标并取较大者：
 *   - **Jaccard**（交集/并集）：对等长度的近似重复敏感；
 *   - **Overlap / 包含系数**（交集/较小集合）：对「复述其中一部分」敏感。
 *
 * 只用 Jaccard 会漏掉最常见的一类重复 —— 模型把前面 3 句里的 2 句
 * 原样重述一遍（并集变大，Jaccard 被稀释到阈值以下），
 * 但内容上它就是重复输出。
 * @param {string} text - 目标文本。
 * @param {Array<string>} candidates - 候选文本集合。
 * @returns {number} 最大重复度（0..1）。
 */
function maxJaccard(text, candidates) {
  const target = sentenceSet(text);
  if (target.size === 0) return 0;
  let best = 0;
  for (const candidate of candidates) {
    const other = sentenceSet(candidate);
    if (other.size === 0) continue;
    let intersection = 0;
    for (const item of target) if (other.has(item)) intersection += 1;
    if (intersection === 0) continue;

    const union = target.size + other.size - intersection;
    const jaccard = union === 0 ? 0 : intersection / union;
    const overlap = intersection / Math.min(target.size, other.size);
    const score = Math.max(jaccard, overlap);
    if (score > best) best = score;
  }
  return best;
}

/**
 * 把文本切成句子的规范化集合。
 * @param {string} text - 输入文本。
 * @returns {Set<string>} 规范化句子集合。
 */
function sentenceSet(text) {
  const set = new Set();
  for (const raw of String(text).split(/[。！？!?\n；;]+/)) {
    const normalized = normalizeForCompare(raw);
    // 太短的片段信息量低，纳入比较会虚高相似度。
    if (normalized.length >= 6) set.add(normalized);
  }
  return set;
}

/**
 * 规范化文本用于比较：去掉空白、标点与大小写差异。
 * @param {string} text - 输入。
 * @returns {string} 规范化结果。
 */
function normalizeForCompare(text) {
  return String(text)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[`*_#>|\-—–.,:;!?'"()[\]{}]/g, '');
}

/**
 * 判断一个**短行**是否属于空转（几乎只由客套话构成）。
 *
 * 与 `isIdle` 的区别：`isIdle` 面向长段落（要求剩余内容 ≥ 15 字符），
 * 直接用在 log 的短条目上会把有效内容全部误杀。这里只看
 * 「剥掉空转短语与标点后还剩什么」：
 *
 *   「好的」            → 剩 0 字   → 空转
 *   「明白了」          → 剩 0 字   → 空转
 *   「好的，我明白了」   → 剩 0 字   → 空转
 *   「已修复 token 判断」→ 剩很多字 → 有效
 *
 * @param {string} text - 单行文本。
 * @returns {boolean} 空转时为 true。
 */
function isIdleLine(text) {
  const stripped = String(text).trim();
  if (stripped.length === 0) return true;

  let residue = stripped.toLowerCase();
  for (const phrase of EMPTY_PHRASES) residue = residue.split(phrase).join('');
  residue = residue.replace(/[\s\u3000.,!?。，！？~…:：;；、]+/g, '');

  // 剥完客套话后不留实质内容 → 空转。
  // 门槛取 2：单字回复（「嗯」「哦」）算空转，但「已修复」这类要留下。
  return residue.length < 2;
}

/**
 * 判断一个助手段落是否属于「空转」（几乎不含实质内容）。
 * @param {string} text - 段落文本。
 * @returns {boolean} 空转时为 true。
 */
function isIdle(text) {
  const stripped = String(text).trim();
  if (stripped.length === 0) return true;
  // 去掉所有空转短语后，看还剩多少内容。
  let residue = stripped.toLowerCase();
  for (const phrase of EMPTY_PHRASES) residue = residue.split(phrase).join('');
  residue = residue.replace(/[\s\u3000.,!?。，！？~…]+/g, '');
  // 剩余内容不足 15 字符且原段本身很短 → 空转。
  return residue.length < 15 && stripped.length < 80;
}

/**
 * 判断段落内是否有同一行重复 3 次以上。
 * @param {string} text - 段落文本。
 * @returns {boolean} 存在重复枚举时为 true。
 */
function hasRepeatedLines(text) {
  const counts = new Map();
  for (const raw of String(text).split('\n')) {
    const line = normalizeForCompare(raw);
    if (line.length < 8) continue;
    const next = (counts.get(line) ?? 0) + 1;
    if (next >= 3) return true;
    counts.set(line, next);
  }
  return false;
}

/**
 * 把数值夹到 0..1。
 * @param {number} value - 输入。
 * @returns {number} 夹紧后的值。
 */
function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

/**
 * 从一份 log 文本里提炼要点，剔除重复输出与空洞段落。
 *
 * 这是需求 ④ 里「继承精简后的对话内容」的实现 —— 用户原话要求
 * 「去除可能的重复输出和由于上下文枯竭导致的其他误输出现象」。
 *
 * **纯文本启发式**，不需要模型，因此可重放、可审计，
 * 且在 log 已经落盘的情况下**不会因为模型不可用而失败**。
 *
 * @param {string} text - log 原文。
 * @param {object} [options] - 配置。
 * @param {number} [options.maxBullets] - 最多保留多少条要点。
 * @param {number} [options.maxChars] - 总字符上限。
 * @returns {{bullets: string[], droppedRepeats: number, droppedIdle: number, droppedRetractions: number}} 提炼结果。
 */
export function condenseLog(text, options = {}) {
  const maxBullets = Number.isInteger(options.maxBullets) ? options.maxBullets : 24;
  const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : 4000;

  const result = { bullets: [], droppedRepeats: 0, droppedIdle: 0, droppedRetractions: 0 };
  const seen = [];
  let budget = maxChars;

  // 逐行扫描：Markdown log 的要点基本落在标题、列表项与短段落上。
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // ① 丢掉 log 自己插入的 HTML 注释（归档标注等）。
    if (line.startsWith('<!--')) continue;
    // ② 丢掉纯分隔线。
    if (/^[-=*_]{3,}$/.test(line)) continue;

    const body = line.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim();

    // ③ 空转段落（「好的」「明白了」这类）
    //
    // ⚠️ 顺序很重要：**先判空转，再判长度**。反过来会先被长度门槛吃掉，
    // 导致 droppedIdle 漏计 —— 统计数字说谎比不统计更糟。
    //
    // 另外这里**不能**直接用 `isIdle` —— 它是给「长助手段落」设计的，
    // 门槛是「剩余内容 ≥ 15 字符」，会把 log 里短而有效的条目
    // （例如「已修复 token 判断」）整片误杀。所以用面向短行的 `isIdleLine`。
    if (isIdleLine(body)) {
      result.droppedIdle += 1;
      continue;
    }

    // 太短的片段没有信息量，不作为要点（例如「嗯」「ok」之外的零碎）。
    if (body.length < 4) continue;

    // ④ 自我回退/推翻前文的段落 —— 这是「上下文枯竭误输出」的典型形态
    const lowered = body.toLowerCase();
    if (RETRACTION_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()))) {
      result.droppedRetractions += 1;
      continue;
    }

    // ⑤ 重复输出（与已收录内容高度重合）
    if (maxJaccard(body, seen) >= 0.75) {
      result.droppedRepeats += 1;
      continue;
    }

    // ⑥ 预算控制
    if (budget - body.length < 0) break;

    const isHeading = /^#{1,6}\s/.test(line);
    result.bullets.push(isHeading ? `**${body}**` : body);
    seen.push(body);
    budget -= body.length;

    if (result.bullets.length >= maxBullets) break;
  }

  return result;
}

/**
 * 渲染写进子文件夹 `AGENTS.md` 的**交接指令** —— 这是「对接 log」的实质。
 *
 * 新对话开局会读到这个文件（DSH 会加载子文件夹里的 `AGENTS.md`），
 * 因此它立刻就知道上一段对话做了什么。
 *
 * ⚠️ 生成的内容会**进入模型的系统提示**，所以：
 *   - 明确标注这是历史交接，不是当前指令，避免模型把旧任务当新任务执行；
 *   - 用 `condenseLog` 过滤，降低把旧对话里的注入内容带进来的风险。
 *
 * @param {object} options - 入参。
 * @param {Array<object>} options.entries - 已处置的老会话。
 * @param {string} [options.folderTitle] - 文件夹标题。
 * @param {string} [options.now] - 时间戳（可注入便于测试）。
 * @returns {string} Markdown 文本。
 */
export function renderInheritNote({ entries, folderTitle, now = new Date().toISOString() }) {
  const list = Array.isArray(entries) ? entries : [];
  const lines = [
    '# 上一段对话的交接记录',
    '',
    '> ⚠️ 这是**历史交接**，不是当前任务。下面内容来自本工作文件夹里',
    '> 已经结束的对话，仅供你了解背景。**不要**把其中的待办当成现在的指令，',
    '> 除非用户明确要求继续。',
    '',
    `工作文件夹：${folderTitle ?? '（未命名）'}`,
    `交接时间：${now}`,
    '',
  ];

  for (const entry of list) {
    lines.push(`## 来源会话 \`${entry.id}\``);
    if (typeof entry.archivedLog === 'string') {
      lines.push('', `完整 log：\`${entry.archivedLog}\``);
    }
    const bullets = Array.isArray(entry.bullets) ? entry.bullets : [];
    if (bullets.length === 0) {
      lines.push('', '（未能从 log 中提炼出要点，请查阅上面的完整 log。）');
    } else {
      lines.push('', '要点：', '');
      for (const bullet of bullets) lines.push(`- ${bullet}`);
    }
    lines.push('');
  }

  lines.push('---', '', '（此文件由 dsh-workspace-folders 自动生成，可安全编辑或删除。）', '');
  return lines.join('\n');
}
