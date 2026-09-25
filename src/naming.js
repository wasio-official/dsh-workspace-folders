/**
 * 会话专属子文件夹的命名与创建。
 *
 * 命名目标（按优先级）：
 *   1. **可读** —— 用户要在资源管理器里一眼认出这是哪个对话；
 *   2. **稳定** —— 同一个会话重复调用必须得到同一个目录（幂等）；
 *   3. **安全** —— 绝不因会话标题里的字符逃出工作区根（路径穿越）；
 *   4. **可排序** —— 前缀带日期，目录列表自然按时间排。
 *
 * @module dsh-workspace-folders/naming
 */

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 单段文件名的长度上限（留出日期前缀与去重后缀的余量）。 */
const MAX_SLUG_LENGTH = 48;

/**
 * 把任意文本转成适合做目录名的 slug。
 *
 * 取舍：**保留 CJK 等「可读」字符，只编码真正危险的字符**。
 * 早期版本把所有非 ASCII 码点编码成 `u<hex>`，虽然唯一但完全不可读
 * （「端到端验证」→ `u7aefu5230u7aefu9a8cu8bc1`），而目录名的首要用途
 * 就是让人在资源管理器里一眼认出这是哪个对话。
 *
 * Windows 文件名禁止 `< > : " / \ | ? *` 与控制字符；其余 Unicode 均合法。
 * 因此策略是：字母数字保留，CJK 保留，空白与分隔符折叠为 `-`，
 * 仅对**禁止字符**做码点编码兜底。
 * @param {string} text - 原始文本（会话标题等）。
 * @param {number} [maxLength] - 结果长度上限（按码点计）。
 * @returns {string} slug；文本无有效内容时返回空串。
 */
/**
 * 把文本转成**纯 ASCII** 的目录名片段。
 *
 * ## ★ 为什么强制 ASCII（真实用户反馈）
 *
 * 用户看到自动生成的目录名 `2026-09-25-你是一名-dshdeepseek-harness`
 * 之后直接问「**能把这个文件夹的名字改为纯英文字符吗**」。
 *
 * 早期实现是**刻意保留 CJK** 的（`/[\p{L}\p{N}]/u` 放行所有字母，
 * 含中日韩），理由是「中文标题更可读」。实际后果：
 *
 * - 目录名里中英混杂，**看着像乱码**（标题被截断在半个词上）；
 * - 在终端、git、日志、跨工具脚本里**编码经常出问题**；
 * - 与工作区里既有的英文项目目录（`MinerU`、`PhO`）**风格不一致**。
 *
 * 所以改成：**只保留 ASCII 字母数字**，其余非 ASCII 一律丢弃，
 * 丢空后用 `sessionId` 兜底（见 `baseFolderName`），保证**永不生成空名**。
 *
 * 中文标题的信息不会丢 —— `INHERITED.md` 里记着完整标题，
 * 会话本身的标题也在 DSH 里。
 *
 * @param {string} text - 原始文本。
 * @param {number} [maxLength] - 最大长度。
 * @returns {string} 纯 ASCII 片段（可能为空字符串）。
 */
export function slugify(text, maxLength = MAX_SLUG_LENGTH) {
  const raw = String(text ?? '').trim();
  if (raw.length === 0) return '';

  const parts = [];
  for (const char of raw) {
    if (/[A-Za-z0-9]/.test(char)) {
      // ASCII 字母数字：保留。字母统一小写。
      parts.push(/[A-Z]/.test(char) ? char.toLowerCase() : char);
    } else if (/[\s\-_./\\]/.test(char)) {
      parts.push('-');
    } else if (WINDOWS_FORBIDDEN.test(char) || char.codePointAt(0) < 0x20) {
      // 真正会破坏文件名的字符：编码而非丢弃，保证可区分。
      parts.push(`x${char.codePointAt(0).toString(16)}`);
    }
    // ★ 其余（含全部 CJK、emoji、标点）一律**丢弃** —— 见上方说明。
  }

  const codePoints = [...parts.join('').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')];
  const trimmed = codePoints.length > maxLength
    ? [...codePoints.slice(0, maxLength).join('').replace(/-+$/, '')]
    : codePoints;

  return trimmed.join('');
}

/** Windows 文件名禁止字符。 */
const WINDOWS_FORBIDDEN = /[<>:"|?*]/;

/**
 * Windows 保留设备名。
 *
 * ⚠️ 这些名字**在任何扩展名下**都被系统当作设备，不能做目录名：
 * `CON`、`CON.txt`、`NUL`、`COM1`… 建目录会失败或行为诡异。
 * 早期漏了这条 —— 由 `check-bind-route.js` 的逃逸用例抓出来。
 */
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

/**
 * 校验一个目录名是否安全（不含路径分隔符、不是 . / .. 、不是设备名）。
 * @param {string} name - 待校验的目录名。
 * @returns {boolean} 是否安全。
 */
export function isSafeSegment(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (WINDOWS_RESERVED.test(name)) return false;
  if (/[\\/]/.test(name)) return false;
  if (/[\u0000-\u001f]/.test(name)) return false;
  // Windows 保留字符与结尾的点/空格。
  if (/[<>:"|?*]/.test(name)) return false;
  if (/[. ]$/.test(name)) return false;
  return true;
}

/**
 * 生成会话子文件夹的**基础名**（不含去重后缀）。
 *
 * ## ★ 默认不加日期前缀（用户明确要求）
 *
 * 早期**无条件**加日期，生成 `2026-09-25-fix-auth` 这种名字。
 * 用户对比了工作区里的实际风格后否掉了：
 *
 * ```
 * MinerU   PhO   Books   qq-bot   dsh-config     ← 真正的项目/文件夹长这样
 * 2026-09-25-fix-auth                            ← 插件加的日期前缀，风格突兀
 * ```
 *
 * 日期前缀在这个工作区里是**噪声**：目录本来就按修改时间可排，
 * 而名字里塞日期让「这个对话是干什么的」更难一眼看出。
 * 所以默认 `dated: false`；需要的人显式打开 `folderDated: true`。
 *
 * ⚠️ 去掉日期后**重名概率上升**，由 `resolveSessionFolder` 的
 * `-2`、`-3`… 循环兜底（它本来就在处理这件事）。
 *
 * @param {object} options - 入参。
 * @param {string} [options.title] - 会话标题。
 * @param {string} options.sessionId - 会话 id。
 * @param {Date} [options.now] - 当前时间（可注入以便测试）。
 * @param {string} [options.prefix] - 用户指定的前缀（配置项 `folderPrefix`）。
 * @param {boolean} [options.dated] - 是否加 `YYYY-MM-DD-` 前缀（默认否）。
 * @returns {string} 形如 `fix-auth` 的基础名。
 */
export function baseFolderName({ title, sessionId, now = new Date(), prefix, dated = false }) {
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  /** 按需拼上日期前缀。 */
  const withDate = (name) => (dated ? `${date}-${name}` : name);

  const slug = slugify(title);
  // ★ 太短的 slug 不可用：`dsh插件对话子文件夹架构方案` 会缩成 `dsh`，
  //   `MinerU 项目使用方法` 会缩成 `mineru` —— 这类名字无法区分不同对话，
  //   而且很容易撞上工作区里既有的项目目录名。
  //   低于 4 个字符时补上会话 id 短前缀，保证**可区分**。
  const MIN_USEFUL_SLUG = 4;
  const sessionSlug = slugify(String(sessionId ?? '').replace(/^session-/, ''), 8);

  let base;
  if (slug.length >= MIN_USEFUL_SLUG) {
    base = withDate(slug);
  } else if (slug.length > 0 && sessionSlug.length > 0) {
    // 短 slug + 会话前缀：既保留可读性，又能区分。
    base = withDate(`${slug}-${sessionSlug}`);
  } else if (sessionSlug.length > 0) {
    // 标题全是非 ASCII（如纯中文）→ 退化为会话 id。
    base = withDate(sessionSlug);
  } else {
    base = withDate('session');
  }

  if (typeof prefix !== 'string' || prefix.length === 0) return base;

  // 前缀也过一遍 slugify —— 防止用户填了 `../` 之类把目录名弄坏。
  // 若前缀整段都是非法字符，就退化为不加前缀，而不是生成坏名字。
  const safePrefix = slugify(prefix);
  return safePrefix.length > 0 ? `${safePrefix}-${base}` : base;
}

/**
 * 在 `parentDir` 下为会话解析一个专属子文件夹，必要时创建。
 *
 * 查找顺序：
 *   1. 已登记的绑定（`.binding.json` 里的 folder 名）且目录仍在 → 直接用；
 *   2. 基础名目录不存在 → 创建；
 *   3. 基础名被别的会话占用 → 追加 `-2`、`-3`… 直到空闲。
 *
 * 第 3 步是本函数与「直接 mkdir」的关键区别：它保证两个标题相同的会话
 * 不会互相踩踏。占用判定读该目录里的 `.binding.json`。
 * @param {object} options - 入参。
 * @param {string} options.parentDir - 工作区根。
 * @param {string} options.sessionId - 会话 id。
 * @param {string} [options.title] - 会话标题。
 * @param {string} [options.existing] - 已登记的目录名（若有）。
 * @param {Date} [options.now] - 当前时间。
 * @returns {Promise<{folder: string, dir: string, created: boolean}>} 解析结果。
 * @throws {Error} 工作区根不存在或名称不安全时。
 */
export async function resolveSessionFolder({
  parentDir, sessionId, title, existing, now = new Date(), prefix, dated = false,
}) {
  if (!isSafeSegment(path.basename(parentDir))) {
    throw new Error(`workspace root has an unsafe name: ${parentDir}`);
  }
  const parentStat = await nodeFs.stat(parentDir).catch(() => undefined);
  if (parentStat === undefined) throw new Error(`workspace root does not exist: ${parentDir}`);
  if (!parentStat.isDirectory()) throw new Error(`workspace root is not a directory: ${parentDir}`);

  // ① 已登记的绑定优先 —— 保证幂等，且尊重用户手动改名后的结果。
  //
  // `existing` 是**登记表显式指定**的目录名（`.dsh-workspace-folders.json`
  // 里记着「这个会话属于哪个文件夹」），所以只要目录还在就直接复用，
  // **不再检查里面住着谁**。
  //
  // ⚠️ 这里曾经要求「绑定记录里必须已有本会话」才复用 —— 那是个 bug：
  // 新会话（④⑤ 的场景：要**加入**已有文件夹）永远匹配不上，会被迫
  // 新建一个 `-2` 兄弟目录，正是需求要避免的行为。
  //
  // 「不让两个互不相关的会话踩同一个名字」由下面的**自动命名**循环负责
  // （命中占用就 `continue` 换后缀）。两条路径职责不同，别混。
  if (typeof existing === 'string' && isSafeSegment(existing)) {
    const existingDir = path.join(parentDir, existing);
    if (await isDirectory(existingDir)) {
      return { folder: existing, dir: existingDir, created: false };
    }
  }

  const base = baseFolderName({ title, sessionId, now, prefix, dated });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const folder = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (!isSafeSegment(folder)) throw new Error(`unsafe folder name generated: ${folder}`);
    const dir = path.join(parentDir, folder);

    if (await isDirectory(dir)) {
      const binding = await readBinding(dir);
      if (binding === undefined) {
        // 目录存在但无绑定记录：可能是用户手建的。视为可用并接管登记。
        await writeBinding(dir, { sessions: [{ id: sessionId, state: 'active' }], claimedAt: new Date().toISOString() });
        return { folder, dir, created: false };
      }
      if (findSession(binding, sessionId) !== undefined) return { folder, dir, created: false };
      continue; // 被别的会话占用 → 换下一个后缀
    }

    await nodeFs.mkdir(dir, { recursive: true });
    await writeBinding(dir, { sessions: [{ id: sessionId, state: 'active' }], claimedAt: new Date().toISOString() });
    return { folder, dir, created: true };
  }

  throw new Error(`could not allocate a unique folder for session ${sessionId} under ${parentDir}`);
}

/**
 * 判断路径是否为存在的目录。
 * @param {string} target - 绝对路径。
 * @returns {Promise<boolean>} 是否为目录。
 */
async function isDirectory(target) {
  const stat = await nodeFs.stat(target).catch(() => undefined);
  return stat?.isDirectory() === true;
}

/**
 * 把「用户/模型给出的目标」解析成一个**确定的**目录，不自动去重。
 *
 * ## 与 `resolveSessionFolder` 的分工
 *
 * | | 用途 | 同名冲突时 |
 * |---|---|---|
 * | `resolveSessionFolder` | **自动命名**（`日期-标题`） | 追加 `-2`、`-3`… |
 * | `resolveTargetFolder` | **指定目标**（已有项目 / 指定名字） | **直接用**，不换名 |
 *
 * 这里刻意**不做**占用去重：用户说「绑到 `MinerU`」时，
 * 建一个 `MinerU-2` 是**错误行为**，不是安全行为。
 * 同一个项目本来就会被多个对话先后使用 —— 那是 ④⑤ 要处理的正常情况。
 *
 * ## 安全约束
 *
 * - `target` 必须是**单段**目录名（不含 `/` `\`），杜绝 `../../` 之类逃逸；
 * - 解析结果必须仍然落在 `parentDir` **之内**（双保险，防止符号链接等）；
 * - 已存在但不是目录（比如同名文件）→ 报错而不是覆盖。
 * @param {object} options - 入参。
 * @param {string} options.parentDir - 工作区根（界内）。
 * @param {string} options.target - 目标目录名（单段）。
 * @param {boolean} [options.createIfMissing] - 不存在时是否创建。
 * @returns {Promise<{folder: string, dir: string, created: boolean}>} 解析结果。
 * @throws {Error} 目标非法、越界、或类型不对时。
 */
export async function resolveTargetFolder({ parentDir, target, createIfMissing = true }) {
  if (!isSafeSegment(target)) {
    throw new Error(
      `unsafe target folder name: ${JSON.stringify(target)}。`
      + '只允许单段目录名（不能含 / \\ .. 或 Windows 保留字符）。',
    );
  }

  const parent = path.resolve(parentDir);
  const dir = path.resolve(parent, target);

  // 双保险：即便 isSafeSegment 已经挡掉分隔符，也再确认一次没跑出界。
  // 用相对路径判定，避免 `D:\a` 与 `D:\a-b` 这种前缀误判。
  const rel = path.relative(parent, dir);
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`target escapes the workspace root: ${target}`);
  }

  const stat = await nodeFs.stat(dir).catch(() => undefined);
  if (stat !== undefined) {
    if (!stat.isDirectory()) {
      throw new Error(`target exists but is not a directory: ${dir}`);
    }
    return { folder: target, dir, created: false };
  }

  if (!createIfMissing) {
    throw new Error(`target folder does not exist: ${dir}`);
  }

  await nodeFs.mkdir(dir, { recursive: true });
  return { folder: target, dir, created: true };
}

/**
 * 列出工作区根下**可以作为绑定目标**的目录。
 *
 * 用于让模型（或用户）先看清有哪些项目可绑，而不是凭空猜名字。
 * 跳过点开头的目录，以及**插件自己所在的目录**（见 `hideSelf`）。
 * @param {object} options - 入参。
 * @param {string} options.parentDir - 工作区根。
 * @param {number} [options.limit] - 最多返回多少个。
 * @param {boolean} [options.hideSelf] - 是否隐藏插件自己所在的目录（默认隐藏）。
 * @param {string} [options.selfDir] - **覆盖**「插件自己在哪」（仅测试用）。
 *   省略时会从本模块位置自动推断。
 * @returns {Promise<Array<{name: string, bound: boolean, sessions: number}>>} 目录清单。
 */
export async function listBindableProjects({ parentDir, limit = 200, hideSelf = true, selfDir }) {
  const parent = path.resolve(parentDir);
  let entries;
  try {
    entries = await nodeFs.readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }

  // ★ 隐藏插件自己的目录。
  //
  // 本插件源码就在主工作区下（`dsh-workspace-folders/`），于是它会被
  // 列成一个「可绑定的项目」—— 而它根本不是项目，是**实现细节**。
  // 实测中用户就点中了它，把对话绑到了自己的源码上。
  //
  // 不硬编码包名，而是找**真正装了本包的那个目录**：从本模块位置
  // 向上找第一个含 `package.json` 的目录。仓库改名也认得出来。
  //
  // `selfDir` 是给测试用的注入口 —— 否则这个机制在临时目录里
  // **永远无法被验证**（真实包根必然不在临时根下面）。
  const resolvedSelf = hideSelf
    ? (selfDir !== undefined ? path.resolve(selfDir) : await findPackageRoot())
    : undefined;

  const out = [];
  for (const entry of entries) {
    if (out.length >= limit) break;
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('_')) continue;

    const dir = path.join(parent, entry.name);
    if (resolvedSelf !== undefined && path.resolve(dir) === resolvedSelf) continue;

    const binding = await readBinding(dir);
    const sessions = Array.isArray(binding?.sessions) ? binding.sessions : [];
    out.push({
      name: entry.name,
      bound: sessions.length > 0,
      sessions: sessions.length,
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * 把**用户手输的目录名**规范成合法的单段目录名。
 *
 * ## ★ 为什么不能直接 `slugify` 了事（真实发现）
 *
 * 浏览器新建目录时，用户输入要过一遍净化。但如果只调 `slugify`：
 *
 * ```js
 * slugify('../evil')      // → 'evil'      ← 危险输入被"洗白"成合法名
 * slugify('../../Windows/Temp/pwn')  // → 'windows-temp-pwn'
 * ```
 *
 * `..` 和 `/` 被当普通分隔符**吃掉**，结果是一个**看起来完全合法**的名字。
 * 危害不在于越界（`resolveTargetFolder` 仍会把目录建在根内，
 * 实测确认没有逃逸），而在于：
 *
 * 1. **两条路径行为不一致**：同样是 `../evil`，
 *    工具路径（`workspace_bind`）**报错拒绝**，浏览器路径却**默默建了
 *    一个叫 `evil` 的目录**。用户以为输入非法会失败，结果"成功"了，
 *    而且建出来的东西**不是他输入的那个名字**。
 * 2. **静默**。危险输入理应**显式报错**，而不是被悄悄改写后照常执行 ——
 *    这是"净化 ≠ 校验"的经典坑。
 *
 * 所以这里**先判危险模式、再净化**：
 * 含路径分隔符或 `..` 的一律**拒绝**（提示要具体），其余才走 `slugify`。
 *
 * ⚠️ 注意与 `slugify` 的分工：
 *   - `slugify` 是**底层清洗**，对任何字符串尽力产出合法片段；
 *   - 本函数是**用户输入入口**，对恶意/误输入**显式报错**。
 *   两者不能互相替代。
 *
 * @param {string} raw - 用户原始输入。
 * @returns {{ok: true, name: string, changed: boolean}|{ok: false, error: string}} 结果。
 */
export function normalizeUserFolderName(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { ok: false, error: '名称不能为空' };

  // ① 危险模式：路径分隔符 / 上跳 —— **拒绝**，不要静默改写。
  if (/[/\\]/.test(text)) {
    return { ok: false, error: '名称不能包含路径分隔符（/ 或 \\）' };
  }
  if (text === '.' || text === '..' || text.includes('..')) {
    return { ok: false, error: '名称不能包含 ..' };
  }

  // ② 净化。
  const name = slugify(text);
  if (name === '') {
    return {
      ok: false,
      error: '名称里没有可用的字符（目录名只支持英文字母、数字和连字符）',
    };
  }

  // ③ 净化结果仍要过安全校验（双保险：slugify 若有 bug 也不能放行）。
  if (!isSafeSegment(name)) return { ok: false, error: '名称不合法' };

  return { ok: true, name, changed: name !== text };
}

/**
 * 在磁盘上**扫出**某个会话所属的文件夹。
 *
 * ## 为什么必须有这个函数（真实事故）
 *
 * 权威记录有**两处**：
 *   - 工作区根：`REGISTRY_FILE`（登记表，相当于缓存）
 *   - 每个子文件夹：`BINDING_FILE`（绑定文件，**真正的持久记录**）
 *
 * 但早期 `bind()` 不带 `target` 时**只看登记表**：
 *
 * ```js
 * existing: recorded?.folder     // ← 只信登记表
 * ```
 *
 * 于是只要登记表里少一条（进程重启后没有、被还原、被人工删过），
 * 插件就会**重新建一个带日期的新文件夹**，而磁盘上属于这个会话的老
 * 文件夹明明还在。表现就是用户报的「**绑定不是恒久的，切换对话就会炸**」：
 * 同一个会话攒出好几个文件夹，log 写到别处去了。
 * 已由 `scripts/repro-switch.js` 复现。
 *
 * 所以补上这条**兜底恢复**路径：登记表查不到时，去磁盘上找。
 * 这是一种**自愈**：找到后调用方会把登记表补回去。
 *
 * ## 为什么扫全部目录是安全的
 *
 * 只读每个目录下的 `.dsh-session.json`，且**要求会话 id 精确匹配**；
 * 不写任何东西（补登记表由调用方决定）。目录数量是「项目数」量级，
 * 只在登记表**查不到**时才走这条路，不在热路径上。
 *
 * @param {object} options - 入参。
 * @param {string} options.parentDir - 工作区根。
 * @param {string} options.sessionId - 会话 id。
 * @returns {Promise<string|undefined>} 目录名（非绝对路径），找不到则 undefined。
 */
export async function findSessionFolderOnDisk({ parentDir, sessionId }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  const parent = path.resolve(parentDir);

  let entries;
  try {
    entries = await nodeFs.readdir(parent, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const binding = await readBinding(path.join(parent, entry.name));
    if (binding === undefined) continue;
    if (findSession(binding, sessionId) === undefined) continue;
    matches.push(entry.name);
  }

  if (matches.length === 0) return undefined;

  // 理论上严格单一归属下只有一个。若因历史遗留出现多个，
  // **不猜** —— 取名字最小的那个只为给出确定结果，并让调用方能看见。
  // （真正的冲突应当人工处理，静默挑一个更危险。）
  matches.sort((a, b) => a.localeCompare(b));
  return matches[0];
}

/**
 * 找到**本插件自己**所在的包根目录。
 *
 * 从本模块的文件位置向上找第一个含 `package.json` 的目录。
 * 用于把插件源码目录从「可绑定项目」列表里排除掉。
 *
 * 认不出来时返回 `undefined`（**不抛错**）—— 宁可多列一个目录，
 * 也不能因为认不出自己就让整个项目列表空掉。
 * @returns {Promise<string|undefined>} 绝对路径，找不到则 undefined。
 */
export async function findPackageRoot() {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 12; i += 1) {
      try {
        await nodeFs.access(path.join(dir, 'package.json'));
        return dir;
      } catch { /* 继续向上 */ }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch { /* 认不出来就不隐藏 */ }
  return undefined;
}

/** 绑定文件名。放在子文件夹内，随文件夹一起移动。 */
export const BINDING_FILE = '.dsh-session.json';

/** 会话在绑定记录里的状态词表。 */
export const SESSION_STATES = Object.freeze(['active', 'archived', 'inherited']);

/**
 * 读取某目录的会话绑定，**并归一化成多会话结构**。
 *
 * 历史格式只有单个 `sessionId`；为了不破坏已有文件夹，这里做兼容归一化：
 *
 * ```jsonc
 * // 旧（仍能读）
 * { "sessionId": "abc", "claimedAt": "..." }
 * // 新
 * { "folder": "...", "sessions": [ { "id": "abc", "state": "active", ... } ] }
 * ```
 *
 * 返回的对象**总是**含 `sessions` 数组，方便调用方统一处理。
 * @param {string} dir - 子文件夹。
 * @returns {Promise<object|undefined>} 归一化后的绑定，或 undefined。
 */
export async function readBinding(dir) {
  let parsed;
  try {
    const text = await nodeFs.readFile(path.join(dir, BINDING_FILE), 'utf8');
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;

  // 新格式：sessions 数组。
  if (Array.isArray(parsed.sessions)) {
    const sessions = parsed.sessions
      .filter((s) => s !== null && typeof s === 'object' && typeof s.id === 'string')
      .map((s) => ({
        // ★ 保留原条目里的**全部**字段，只把 `state` 归一化。
        //
        // 早期这里是个白名单：只挑出 id/state/log/archivedAt/inheritedFrom，
        // 其余一律**静默丢弃** —— 包括我们自己写的 `folder` 与 `boundAt`。
        // 结果是：写进文件的 `boundAt` 一读就没（实测确认），
        // 而「读-改-写」的操作（改绑清理、归档标记）会**顺手抹掉**这些字段。
        // 用「展开原条目再覆盖」而不是白名单，新增字段就不会再被吃掉。
        ...s,
        id: s.id,
        state: SESSION_STATES.includes(s.state) ? s.state : 'active',
      }));
    return { ...parsed, sessions };
  }

  // 旧格式：单个 sessionId → 归一化为单元素数组。
  if (typeof parsed.sessionId === 'string') {
    return {
      ...parsed,
      sessions: [{ id: parsed.sessionId, state: 'active' }],
    };
  }
  return undefined;
}

/**
 * 写入会话绑定（原子替换，避免半截文件）。
 *
 * 写之前会归一化：若传入的是旧式 `{sessionId}`，自动转成 `sessions` 数组，
 * 这样**新旧格式不会混写**成两个并存的文件。
 * @param {string} dir - 子文件夹。
 * @param {object} binding - 绑定内容。
 * @returns {Promise<void>} 完成后兑现。
 */
export async function writeBinding(dir, binding) {
  const normalized = normalizeBindingForWrite(binding);
  const target = path.join(dir, BINDING_FILE);
  const temp = `${target}.tmp-${process.pid}`;
  await nodeFs.writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await nodeFs.rename(temp, target);
}

/**
 * 把任意入参归一化成新格式（纯函数，便于单测）。
 * @param {object} binding - 入参。
 * @returns {object} 新格式绑定。
 */
export function normalizeBindingForWrite(binding) {
  const source = binding !== null && typeof binding === 'object' ? binding : {};
  const { sessionId, ...rest } = source;

  if (Array.isArray(source.sessions)) {
    return { ...rest, sessions: source.sessions };
  }
  if (typeof sessionId === 'string') {
    return {
      ...rest,
      sessions: [{ id: sessionId, state: 'active' }],
    };
  }
  return { ...rest, sessions: [] };
}

/**
 * 找绑定记录里某个会话的条目。
 * @param {object|undefined} binding - 归一化后的绑定。
 * @param {string} sessionId - 会话 id。
 * @returns {object|undefined} 条目或 undefined。
 */
export function findSession(binding, sessionId) {
  if (!Array.isArray(binding?.sessions)) return undefined;
  return binding.sessions.find((s) => s.id === sessionId);
}

/**
 * 列出绑定记录里**除自己以外**的会话。
 * @param {object|undefined} binding - 归一化后的绑定。
 * @param {string} [exceptId] - 要排除的会话 id。
 * @returns {Array<object>} 其他会话。
 */
export function otherSessions(binding, exceptId) {
  if (!Array.isArray(binding?.sessions)) return [];
  return binding.sessions.filter((s) => s.id !== exceptId);
}

/**
 * 把一个会话加入绑定记录（幂等：已存在则只更新缺失字段）。
 * @param {object|undefined} binding - 归一化后的绑定。
 * @param {object} entry - 要加入的条目（至少含 `id`）。
 * @returns {object} 新的绑定对象。
 */
export function upsertSession(binding, entry) {
  const source = binding !== null && typeof binding === 'object' ? binding : {};
  const sessions = Array.isArray(source.sessions) ? [...source.sessions] : [];
  const index = sessions.findIndex((s) => s.id === entry.id);
  if (index === -1) {
    sessions.push(entry);
  } else {
    sessions[index] = { ...sessions[index], ...entry };
  }
  return { ...source, sessions };
}

/**
 * 把一个会话从绑定记录里**彻底移除**（改绑时清理旧文件夹用）。
 *
 * ## 为什么需要它
 *
 * 改绑（把对话从 A 项目移到 B 项目）时，A 的 `.dsh-session.json` 里
 * 会**留下这个会话的 `state: "active"` 记录** —— 幽灵记录。
 * 后果是插件认为同一个会话同时属于两个文件夹：
 *
 *   - `workspace_status` 报错或报错的那个；
 *   - 下一次往 A 绑定时，会把**当前自己**当成「A 里的老会话」去归档；
 *   - ④ 继承逻辑会认错「这是我上一段对话」。
 *
 * 早期实现只写了新文件夹、没清旧的，实测确认过
 * （见 `scripts/repro-rebind.js`）。
 *
 * ## 为什么不只标记成 `moved`
 *
 * 试过「保留迁移痕迹」的方案，但那让「这个文件夹当前归谁」需要额外判断，
 * `findSession` / `otherSessions` / ④ 继承全都要跟着改，收益不抵复杂度。
 * 与用户确认后采用**严格单一归属**：一个会话永远只在一个文件夹的记录里。
 * 文件夹自身的 `INHERITED.md` 与 `log/` 仍然保留历史，信息没丢。
 *
 * @param {object|undefined} binding - 归一化后的绑定。
 * @param {string} sessionId - 要移除的会话 id。
 * @returns {object} 新的绑定对象。
 */
export function removeSession(binding, sessionId) {
  const source = binding !== null && typeof binding === 'object' ? binding : {};
  const sessions = Array.isArray(source.sessions) ? source.sessions : [];
  return { ...source, sessions: sessions.filter((s) => s.id !== sessionId) };
}

/**
 * 工作区根的配置文件。记录工作区根与登记过的会话，供重启后恢复。
 * @type {string}
 */
export const REGISTRY_FILE = '.dsh-workspace-folders.json';

/**
 * 取会话标题（用于目录命名）。
 *
 * 容忍两种调用形态：工具侧传 `exec`（内部取 `exec.agent.session`），
 * 事件侧直接传 `session`。任何一种失败都退回空串，由调用方用会话 id 兜底。
 * @param {object} ctx - 插件上下文。
 * @param {object} source - `exec` 或 `session`。
 * @returns {string} 标题或空串。
 */
export function sessionTitleOf(ctx, source) {
  try {
    const session = source?.session ?? source;
    if (session === undefined || session === null) return '';
    // `sessionTitle` 已在 inject 里声明，直读即可。
    const snapshot = ctx?.sessionTitle?.get?.(session);
    return typeof snapshot?.title === 'string' ? snapshot.title : '';
  } catch {
    return '';
  }
}

/**
 * 读取工作区登记表。
 * @param {string} rootDir - 工作区根。
 * @returns {Promise<{sessions: Record<string, {folder: string, boundAt: string}>}>} 登记表。
 */
export async function readRegistry(rootDir) {
  try {
    const text = await nodeFs.readFile(path.join(rootDir, REGISTRY_FILE), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.sessions === 'object') {
      return { sessions: parsed.sessions ?? {} };
    }
  } catch {
    // 缺失或损坏都退回空表；登记表只是缓存，权威是各子文件夹内的绑定文件。
  }
  return { sessions: {} };
}

/**
 * 写工作区登记表（原子替换）。
 * @param {string} rootDir - 工作区根。
 * @param {object} registry - 登记表。
 * @returns {Promise<void>} 完成后兑现。
 */
export async function writeRegistry(rootDir, registry) {
  const target = path.join(rootDir, REGISTRY_FILE);
  const temp = `${target}.tmp-${process.pid}`;
  await nodeFs.writeFile(temp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await nodeFs.rename(temp, target);
}
