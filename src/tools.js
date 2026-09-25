/**
 * 模型可见的工具面。
 *
 * 工具设计原则：**少而明确**。每个工具都对应一个模型确实会遇到的决策点，
 * 且描述里写清「什么时候该调用」，因为模型主要靠描述决定用不用。
 *
 * @module dsh-workspace-folders/tools
 */

import { promises as nodeFs } from 'node:fs';
import path from 'node:path';

import { canonicalize, isInside, requestOutsideAccess } from './guard.js';
import { requestArchive } from './archiver.js';
import { sessionTitleOf, listBindableProjects } from './naming.js';

/**
 * 从工具执行上下文里取会话 id。
 * @param {object} exec - `ToolExecution`。
 * @returns {string} 会话 id。
 * @throws {Error} 取不到时。
 */
function requireSessionId(exec) {
  const id = exec?.agent?.session?.id ?? exec?.agent?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('this tool requires an owning agent/session context');
  }
  return id;
}

/**
 * 截断文本到字节上限。
 * @param {string} text - 文本。
 * @param {number} maxBytes - 上限。
 * @returns {string} 结果。
 */
function clampText(text, maxBytes) {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let out = value;
  while (Buffer.byteLength(out, 'utf8') > maxBytes && out.length > 0) {
    out = out.slice(0, Math.floor(out.length * 0.9));
  }
  return `${out}\n…（已截断）`;
}

/**
 * 注册全部工作区文件夹工具。
 * @param {object} options - 入参。
 * @param {object} options.ctx - 插件上下文。
 * @param {object} options.config - 已归一化配置。
 * @param {object} options.binder - `FolderBinder` 实例。
 * @param {Function} options.defineTool - DSH 的 `defineTool`。
 * @returns {Array<Function>} 释放函数列表。
 */
export function registerFolderTools({ ctx, config, binder, defineTool }) {
  const disposers = [];

  // ── workspace_status ──────────────────────────────────────────
  disposers.push(ctx.tools.register(defineTool({
    name: 'workspace_status',
    description: [
      '查看当前对话的「工作文件夹」状态：它绑定在哪个子目录、主工作区根在哪、',
      '以及主文件夹的系统指令（AGENTS.md 等）是否会被继承。',
      '',
      '在以下情形调用：需要知道自己的读写边界在哪；准备访问某个路径前想确认它在不在界内；',
      '用户问「你现在在哪个目录工作」。这个工具是只读的，随时可安全调用。',
    ].join('\n'),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bound: { type: 'boolean', required: true },
          folder: { type: 'string' },
          workingDir: { type: 'string' },
          workspaceRoot: { type: 'string', required: true },
          instructionsFile: { type: 'string', required: true },
          inheritsMainPrompt: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.summary }];
      },
    },
    async execute(_args, exec) {
      const sessionId = requireSessionId(exec);
      const root = await binder.resolveWorkspaceRoot();
      const bound = await binder.bind({ sessionId, create: false });
      const inheritance = await binder.instructionInheritance();

      const workingDir = bound.unbound === true ? root : bound.dir;

      const lines = [
        `主工作区根（保留 system prompt 的层）：${root}`,
        bound.unbound === true
          ? '当前对话尚未绑定子文件夹。调用 workspace_bind 创建一个。'
          : `当前对话的工作文件夹：${bound.dir}`,
        '',
        inheritance.inherits
          ? '✓ 主文件夹的系统指令会传递给子文件夹会话。'
          : '⚠ 主文件夹的系统指令**不会**传递到子文件夹会话：',
      ];
      if (!inheritance.inherits) {
        lines.push(...inheritance.detail.split('\n').map((line) => `  ${line}`));
      } else if (inheritance.target.length > 0) {
        lines.push(`  （同步位置：${inheritance.target}）`);
      }
      if (bound.unbound !== true) {
        lines.push(`  如需只对本对话生效的指令，可在 ${bound.dir} 放一个 AGENTS.md，会叠加而非替换。`);
      }

      return {
        bound: bound.unbound !== true,
        folder: bound.folder ?? '',
        workingDir,
        workspaceRoot: root,
        instructionsFile: inheritance.target,
        inheritsMainPrompt: inheritance.inherits,
        summary: lines.join('\n'),
      };
    },
  })));

  // ── workspace_bind ────────────────────────────────────────────
  disposers.push(ctx.tools.register(defineTool({
    name: 'workspace_bind',
    description: [
      '为当前对话绑定一个工作目录，之后本对话的产出都应放在里面。',
      '',
      '**两种用法**：',
      '',
      '1. **绑到已有项目**（推荐，当任务属于某个现成项目时）：',
      '   传 `target: "MinerU"`，直接绑定到主工作区下的那个项目目录。',
      '   目录已存在就用它，不存在就新建同名目录。',
      '   先用 `workspace_projects` 看看有哪些项目可绑。',
      '',
      '2. **新建一个工作文件夹**：传一个尚不存在的 `target` 即会创建，',
      '   例如 `target: "my-new-task"`。不传 `target` 时按对话标题自动命名。',
      '   ⚠️ 目录名只保留英文字母、数字和连字符（纯中文标题会退化为会话 id 短前缀）。',
      '',
      '幂等：同一对话重复调用只会返回同一个目录。',
      '改绑：再次调用时传不同的 `target` 即可切换到另一个目录。',
    ].join('\n'),
    parameters: {
      target: {
        type: 'string',
        description: '要绑定的目标目录名，单段，**相对于主工作区根**。'
          + '例如 "MinerU"、"PhO"、"Arcaea"。'
          + '省略则按对话标题自动生成 `日期-标题` 形式的新目录。',
      },
      title: {
        type: 'string',
        description: '仅在不传 target（自动命名）时用作目录名里的标题。省略则用对话标题。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          folder: { type: 'string', required: true },
          workingDir: { type: 'string', required: true },
          created: { type: 'boolean', required: true },
          inheritsMainPrompt: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.summary }];
      },
    },
    async execute(args, exec) {
      const sessionId = requireSessionId(exec);
      const provided = typeof args?.title === 'string' ? args.title.trim() : '';
      const target = typeof args?.target === 'string' ? args.target.trim() : '';
      const title = provided.length > 0 ? provided : sessionTitleOf(ctx, exec);

      const bound = await binder.bind({
        sessionId,
        title,
        create: true,
        ...(target.length > 0 ? { target } : {}),
      });
      const inheritance = await binder.instructionInheritance();

      const lines = [
        bound.created
          ? `已为本次对话创建工作文件夹：${bound.dir}`
          : `本次对话的工作文件夹（已存在）：${bound.dir}`,
        '',
        `主工作区根：${bound.root}`,
        inheritance.inherits
          ? '✓ 主文件夹的系统指令已同步，本对话仍能读到它。'
          : `⚠ 主文件夹的系统指令未能同步：\n${inheritance.detail}`,
        '',
        '后续读写与产出请放在这个文件夹内；需要访问界外路径时，用 workspace_access 申请。',
      ];

      return {
        folder: bound.folder,
        workingDir: bound.dir,
        created: bound.created,
        inheritsMainPrompt: inheritance.inherits,
        summary: lines.join('\n'),
      };
    },
  })));

  // ── workspace_projects ────────────────────────────────────────
  disposers.push(ctx.tools.register(defineTool({
    name: 'workspace_projects',
    description: [
      '列出主工作区下**可以绑定的项目目录**，以及每个目录当前的对话绑定情况。',
      '',
      '在以下情形调用：',
      '  - 用户让你做某个项目的活，但不确定目录叫什么名字；',
      '  - 准备调用 workspace_bind 之前，想先看看有哪些项目；',
      '  - 想知道某个项目里已经绑过几个对话。',
      '',
      '只读，随时可安全调用。返回值里 `sessions > 0` 表示该目录已被别的对话用过。',
    ].join('\n'),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          count: { type: 'number', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.summary }];
      },
    },
    async execute() {
      const root = await binder.resolveWorkspaceRoot();
      const projects = await listBindableProjects({ parentDir: root });

      const lines = [
        `## 主工作区下的项目目录`,
        '',
        `根目录：${root}`,
        `共 ${projects.length} 个可绑定目录。`,
        '',
      ];

      if (projects.length === 0) {
        lines.push('（没有找到子目录）');
      } else {
        const used = projects.filter((p) => p.bound);
        if (used.length > 0) {
          lines.push('**已有对话绑定过的**：');
          for (const p of used) lines.push(`  - \`${p.name}\`（${p.sessions} 个对话）`);
          lines.push('');
        }
        const fresh = projects.filter((p) => !p.bound);
        if (fresh.length > 0) {
          lines.push('**尚未绑定过的**：');
          lines.push(`  ${fresh.map((p) => `\`${p.name}\``).join('、')}`);
          lines.push('');
        }
        lines.push('用 `workspace_bind({ target: "<名字>" })` 绑定到其中任意一个。');
      }

      return { root, count: projects.length, summary: lines.join('\n') };
    },
  })));

  // ── workspace_access ──────────────────────────────────────────
  disposers.push(ctx.tools.register(defineTool({
    name: 'workspace_access',
    description: [
      '申请访问当前工作文件夹**之外**的某个路径（例如另一个项目目录）。',
      '',
      '在以下情形调用：需要读取或修改界外路径之前。**必须先申请并获批，再去访问**。',
      '用户会看到一个审批弹窗，包含目标路径与你给出的理由。',
      '',
      '审批是**一次性的**：批准只对这一次调用有效，下次访问同一路径需要重新申请。',
      '若返回 denied，请停止对该路径的操作，不要反复重试。',
      '界内（本对话的工作文件夹内）的路径不需要申请。',
    ].join('\n'),
    parameters: {
      target_path: {
        type: 'string',
        required: true,
        description: '想访问的绝对路径。',
      },
      reason: {
        type: 'string',
        required: true,
        description: '为什么要访问它 —— 会直接显示给用户，请写具体（例如「读取 MinerU 的接口定义以复用解析逻辑」）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowed: { type: 'boolean', required: true },
          outcome: { type: 'string', required: true },
          targetPath: { type: 'string', required: true },
          inside: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.message }];
      },
    },
    async execute(args, exec) {
      const sessionId = requireSessionId(exec);
      const rawTarget = typeof args?.target_path === 'string' ? args.target_path.trim() : '';
      if (rawTarget.length === 0) throw new Error('target_path is required');

      const reason = typeof args?.reason === 'string' ? args.reason.trim() : '';
      const bound = await binder.bind({ sessionId, create: true });
      const sessionRoot = bound.dir;

      // 先按真实路径判定界内，挡住 symlink / .. 逃逸。
      const target = await canonicalize(path.resolve(bound.root, rawTarget), nodeFs);
      const realRoot = await canonicalize(sessionRoot, nodeFs);
      const inside = isInside(target, realRoot);

      if (inside && config.allowInsideWithoutAsk) {
        return {
          allowed: true,
          outcome: 'inside',
          targetPath: target,
          inside: true,
          message: `允许：${target} 在本次对话的工作文件夹内，无需申请。`,
        };
      }

      if (config.outsideAccess === 'deny') {
        return {
          allowed: false,
          outcome: 'denied-by-policy',
          targetPath: target,
          inside,
          message: `拒绝：本部署的出界访问策略为「一律拒绝」。目标 ${target} 不在工作文件夹 ${sessionRoot} 内。`,
        };
      }

      const verdict = await requestOutsideAccess({
        ctx,
        agent: exec?.agent,
        toolName: 'workspace_access',
        callId: exec?.callId,
        targetPath: target,
        sessionRoot,
        reason,
        signal: exec?.signal,
      });

      return {
        allowed: verdict.allowed,
        outcome: verdict.outcome,
        targetPath: target,
        inside,
        message: clampText(
          [
            verdict.message,
            '',
            `目标：${target}`,
            `界内：${sessionRoot}`,
          ].join('\n'),
          config.maxToolResultBytes,
        ),
      };
    },
  })));

  // ── workspace_archive ─────────────────────────────────────────
  //
  // 注意这不是「归档工具」，而是「**征询是否归档**」的工具：它内部会弹
  // 带按钮的卡片，只有用户点了「允许一次」才真的归档。工具描述必须把这点
  // 说清楚，否则模型会以为调用即归档、从而不去征询。
  if (config.archiveMode !== 'off') {
    disposers.push(ctx.tools.register(defineTool({
      name: 'workspace_archive',
      description: [
        '征询用户是否归档当前对话（从侧边栏隐藏，日志与内容全部保留）。',
        '',
        '调用后会在用户的界面上弹出**带按钮的卡片**，用户点「允许一次」才会归档，',
        '点「拒绝」则什么都不发生。所以这个工具本身不会造成任何破坏。',
        '',
        '在以下情形调用：一个任务已经交付完毕、用户表示满意或转向别的话题，',
        '且你判断这段对话短期内不会再继续。**不要**在任务进行中调用。',
        '每个对话最多征询一次；被拒后不要再问。',
      ].join('\n'),
      parameters: {
        // 注意：可选参数**不能写 `required: false`** —— `defineTool` 的
        // 作者侧编译器只在 `required: true` 时接受该键，写 false 会抛
        // `UNSUPPORTED_SCHEMA: parameters.title.required must be true when present`。
        // 可选参数直接省略 `required` 键。
        title: {
          type: 'string',
          description: '这段对话的简短标题，显示在确认卡片上，便于用户辨认。省略则用会话标题。',
        },
        reason: {
          type: 'string',
          description: '为什么判断这段对话可以结束了（会显示给用户）。写具体，例如「三项修复已交付并验证通过」。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            archived: { type: 'boolean', required: true },
            outcome: { type: 'string', required: true },
            summary: { type: 'string', required: true },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.summary }];
        },
      },
      async execute(args, exec) {
        const sessionId = requireSessionId(exec);
        const provided = typeof args?.title === 'string' ? args.title.trim() : '';
        const title = provided.length > 0 ? provided : sessionTitleOf(ctx, exec);

        if (config.archiveMode === 'manual') {
          return {
            archived: false,
            outcome: 'manual-only',
            summary: '本部署的归档配置为「仅斜杠命令」，未弹确认卡片。'
              + '如需归档，请用户自行执行 /workspace-archive。',
          };
        }

        const result = await requestArchive({
          ctx,
          agent: exec?.agent,
          sessionId,
          title,
          callId: exec?.callId,
          reason: typeof args?.reason === 'string' ? args.reason : undefined,
          signal: exec?.signal,
        });

        return {
          archived: result.archived,
          outcome: result.outcome,
          summary: result.message,
        };
      },
    })));
  }

  return disposers;
}
