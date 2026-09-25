/**
 * 出界访问的审批闸门。
 *
 * ## 设计要点
 *
 * DSH 原生已有跨工作区升降级机制（`dsh-tool-fs` 的 `FsSandboxController`
 * → `ctx.approval`），但它的可授予值只有 `'allowed-once'`（**一次性**），
 * 且只在挂了 confining backend 时才有 `sandbox_permissions` 字段。
 * 用户明确要求「每次都要经我申请」，与原生一次性语义一致，因此本模块
 * **委托** `ctx.approval.request()`，而不是自建一套询问通道：
 *   - 审计事件（`approval/asked` + `approval/decided`）由服务统一落日志；
 *   - Web UI 的审批弹窗由现有 answerer 链路渲染，无需前端改动；
 *   - fail-closed 语义（`unavailable` 必须拒绝）由服务保证。
 *
 * ## 一个必须说清的约束
 *
 * `ctx.approval.request()` **要求当前有打开的 turn**（idle 时抛错）。
 * 所以申请只能由**工具调用**发起，不能由后台定时器发起。
 * 本模块因此只暴露「在工具执行中调用」的一个函数。
 *
 * @module dsh-workspace-folders/guard
 */

import path from 'node:path';

/**
 * 判断目标路径是否落在会话子文件夹之内（含自身）。
 *
 * 用 `path.relative` 而不是字符串 `startsWith` —— 后者会把
 * `/a/bc` 误判为在 `/a/b` 之内。同时要求解析后的相对路径不以 `..` 开头。
 * @param {string} target - 目标绝对路径（应已规范化）。
 * @param {string} root - 会话子文件夹绝对路径。
 * @returns {boolean} 是否在界内。
 */
export function isInside(target, root) {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  if (resolvedTarget === resolvedRoot) return true;

  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.length === 0) return true;
  // 出界：以 .. 开头，或（Windows）跨盘时 path.relative 返回绝对路径。
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * 把路径规范化到「真实」形态，用于比较。
 *
 * 先 realpath 再比较，才能挡住 symlink 逃逸；但目标可能尚不存在
 * （例如要新建文件），此时退回逐级向上找最近的存在祖先做 realpath。
 * @param {string} target - 目标路径。
 * @param {object} fsApi - 提供 `realpath` 的接口（node:fs/promises 或等价物）。
 * @returns {Promise<string>} 规范化路径。
 */
export async function canonicalize(target, fsApi) {
  let current = path.resolve(target);
  const tail = [];

  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = await fsApi.realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target); // 走到盘根仍不存在
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(target);
}

/** 审批结果的封闭词表（与 DSH `ApprovalOutcome` 一致）。 */
export const APPROVAL_OUTCOMES = Object.freeze([
  'allowed-once',
  'rejected',
  'cancelled',
  'unavailable',
]);

/**
 * 就一次出界访问向用户申请许可。
 *
 * @param {object} options - 入参。
 * @param {object} options.ctx - 插件上下文，需含 `approval` 服务。
 * @param {object} options.agent - 发起访问的 agent（决定弹窗路由与审计落点）。
 * @param {string} options.toolName - 发起访问的工具名（审计用）。
 * @param {string} [options.callId] - 工具调用 id，让 UI 把弹窗挂到该次调用上。
 * @param {string} options.targetPath - 想访问的路径。
 * @param {string} options.sessionRoot - 会话子文件夹（界内基准）。
 * @param {string} [options.reason] - 申请理由（会显示给用户，务必具体）。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @returns {Promise<{outcome: string, allowed: boolean, message: string}>} 申请结果。
 */
export async function requestOutsideAccess({
  ctx, agent, toolName, callId, targetPath, sessionRoot, reason, signal,
}) {
  // `approval` 已在插件 inject 里声明，所以这里可以安全直读。
  // ⚠️ 不要改成 `ctx?.approval` —— 未声明服务的抛错发生在 getter 内部，
  //    `?.` 挡不住；也不要用 `ctx.get()`，它对兄弟提供的服务会静默返回
  //    undefined（三种写法的实测对比见 src/index.js 的 inject 注释）。
  const approval = ctx?.approval;
  if (approval === undefined || typeof approval.request !== 'function') {
    // 没有审批服务时**失败关闭**，绝不放行。
    return {
      outcome: 'unavailable',
      allowed: false,
      message: '拒绝：本部署未挂载审批服务（approval），出界访问一律不放行。',
    };
  }

  const detail = typeof reason === 'string' && reason.trim().length > 0
    ? reason.trim()
    : '（模型未给出理由）';

  const fullReason = [
    `请求访问会话工作文件夹之外的路径。`,
    `  目标：${targetPath}`,
    `  界内：${sessionRoot}`,
    `  理由：${detail}`,
  ].join('\n');

  let outcome;
  try {
    outcome = await approval.request({
      agent,
      toolName,
      ...(callId === undefined ? {} : { callId }),
      reason: fullReason,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    // 典型原因：当前没有打开的 turn（如后台触发），或审计写入失败。
    return {
      outcome: 'unavailable',
      allowed: false,
      message: `拒绝：审批请求无法送达（${String(error?.message ?? error)}）。`,
    };
  }

  if (outcome === 'allowed-once') {
    return {
      outcome,
      allowed: true,
      message: '用户已批准本次访问（仅此一次，下次需重新申请）。',
    };
  }

  const explanation = {
    rejected: '用户拒绝了本次访问，请停止对该路径的操作，不要重试。',
    cancelled: '审批被取消（可能是用户中断或请求超时）。',
    unavailable: '没有可用的审批应答者，按失败关闭处理。',
  }[outcome] ?? `未知结果 ${outcome}，按拒绝处理。`;

  return { outcome, allowed: false, message: `拒绝：${explanation}` };
}
