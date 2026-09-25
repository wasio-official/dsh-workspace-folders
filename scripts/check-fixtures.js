/**
 * 测试共享工具：定位主工作区，以及**按真实契约**搭 Cordis 上下文。
 *
 * ## 第一部分：定位主工作区
 *
 * 这些测试需要在**真实文件系统**上验证「子文件夹会话能否继承主文件夹指令」，
 * 所以需要一个真实存在、且带指令文件的目录充当主工作区。
 *
 * ⚠️ **不要写死路径** —— 硬编码某台机器的 `D:\Wasio\Workspace` 会让
 * 所有测试在别人机器上直接失败。这里按优先级探测：
 *
 *   1. 环境变量 `DSH_WORKSPACE_ROOT`（CI / 自定义场景显式指定）
 *   2. 从本文件向上找到的第一个带指令文件的目录（正常开发场景）
 *   3. 仓库自身所在目录（兜底，总有指令文件）
 *
 * ## 第二部分：为什么必须用**真实服务**而不是手写桩
 *
 * 本项目连续两次「289 项断言全绿，装上去就崩」：
 *
 * 1. `cannot get property "systemPrompt" without inject`
 *    —— 桩 `ctx` 是普通对象，**不做注入校验**；
 * 2. `command "workspace-folders" handler must be a function`
 *    —— 桩 `commands` 是 `{ register: () => () => {} }`，**接受任何形状**。
 *
 * 两次根因相同：**手写桩没有校验，契约错误就测不出来**。
 * 所以这里提供两件东西：
 *
 * - `mountCommands()` —— 挂**真实的** `@deepseek-ai/dsh-commands`；
 * - `makeCommandsStub()` —— 退路桩，但**复刻真实校验**。
 *
 * @module dsh-workspace-folders/scripts/check-fixtures
 */

import { existsSync, promises as nodeFs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 认作「工作区指令文件」的名字。 */
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 判断目录里是否有工作区指令文件。
 * @param {string} dir - 目录。
 * @returns {boolean} 是否有。
 */
function hasInstructions(dir) {
  return INSTRUCTION_FILES.some((name) => existsSync(path.join(dir, name)));
}

/**
 * 定位一个真实存在、且带指令文件的主工作区目录。
 * @returns {string} 绝对路径。
 * @throws {Error} 三级探测都失败时抛出。
 */
export function findWorkspaceRoot() {
  const fromEnv = process.env.DSH_WORKSPACE_ROOT;
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && hasInstructions(fromEnv)) {
    return path.resolve(fromEnv);
  }

  // 从 scripts/ 逐级向上找带指令文件的目录（跳过仓库自身的子目录层）。
  let current = path.resolve(here, '..', '..');
  for (let i = 0; i < 6; i += 1) {
    if (hasInstructions(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(
    '找不到可用作测试主工作区的目录（需要含 AGENTS.md 或 CLAUDE.md）。'
    + '请设置环境变量 DSH_WORKSPACE_ROOT 指向一个真实目录。',
  );
}

/**
 * 造一个**临时**的隔离 DSH_HOME，避免碰用户真实的 `~/.dsh`。
 * @param {string} [prefix] - 临时目录前缀。
 * @returns {Promise<string>} 临时目录绝对路径。
 */
export async function makeTempDshHome(prefix = 'dsh-workspace-folders-test-') {
  return nodeFs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * 造一个临时的假工作区（带指令文件），用于不依赖真实工作区的测试。
 * @param {string} [agentsContent] - `AGENTS.md` 内容。
 * @returns {Promise<string>} 临时工作区路径。
 */
export async function makeTempWorkspace(agentsContent = '# 主工作区指令\n') {
  const dir = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-ws-'));
  await nodeFs.writeFile(path.join(dir, 'AGENTS.md'), agentsContent, 'utf8');
  return dir;
}

// ══════════════════════════════════════════════════════════════════════
// 第二部分：真实 Cordis / dsh-commands（含按真实契约校验的桩）
// ══════════════════════════════════════════════════════════════════════

/**
 * 找 DSH 的安装位置（多锚点，避免写死某个用户名）。
 * @returns {string|undefined} `package.json` 绝对路径。
 */
export function findDshPackage() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return [
    path.join(home, 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json'),
    path.join(home, 'AppData/Local/npm/node_modules/@deepseek-ai/dsh/package.json'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/usr/lib/node_modules/@deepseek-ai/dsh/package.json',
  ].find(existsSync);
}

/**
 * 解析 DSH 内部包为可 import 的 file URL。
 * @param {string} spec - 包名（如 `@deepseek-ai/cordis`）。
 * @returns {string|undefined} file URL。
 */
export function resolveDsh(spec) {
  const anchor = findDshPackage();
  if (anchor === undefined) return undefined;
  try {
    return pathToFileURL(createRequire(anchor).resolve(spec)).href;
  } catch {
    return undefined;
  }
}

/**
 * 加载真实的 Cordis `Context`。
 * @returns {Promise<object|undefined>} Context 构造器。
 */
export async function loadContext() {
  const url = resolveDsh('@deepseek-ai/cordis');
  if (url === undefined) return undefined;
  const mod = await import(url);
  return mod.Context;
}

/**
 * 造一个**按真实契约校验**的 `commands` 桩。
 *
 * 真实契约（读自 `dsh-commands/lib/index.js` 的 `normalizeDefinition`）：
 * - `name` 必须匹配命令名正则；
 * - `description` 必须是非空字符串；
 * - **`handler` 必须是函数** —— 写 `run` 会抛
 *   `command "x" handler must be a function`，且**整个插件树加载失败**；
 * - `input.hint` 若存在必须是非空字符串。
 *
 * 本桩**故意复刻这些校验**：契约写错时测试会失败，而不是静默通过。
 * @returns {{register: Function, registered: Array<object>}} 桩服务。
 */
export function makeCommandsStub() {
  const registered = [];
  return {
    registered,
    register(definition) {
      if (definition === null || typeof definition !== 'object') {
        throw new TypeError('command definition must be an object');
      }
      if (typeof definition.name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(definition.name)) {
        throw new TypeError(`command name "${String(definition.name)}" is invalid`);
      }
      if (typeof definition.description !== 'string' || definition.description.trim().length === 0) {
        throw new TypeError(`command "${definition.name}" description must be a non-empty string`);
      }
      // ★ 关键校验：字段名必须是 handler（这是线上事故的直接原因）
      if (typeof definition.handler !== 'function') {
        throw new TypeError(`command "${definition.name}" handler must be a function`);
      }
      if (definition.input !== undefined) {
        const hint = definition.input?.hint;
        if (typeof hint !== 'string' || hint.trim().length === 0) {
          throw new TypeError(`command "${definition.name}" input hint must be a non-empty string`);
        }
      }
      registered.push(definition);
      // 真实 register 是**同步**返回 disposer
      return () => {
        const i = registered.indexOf(definition);
        if (i >= 0) registered.splice(i, 1);
      };
    },
  };
}

/**
 * 把 `commands` 服务挂到上下文上 —— **优先挂真实实现**，退回契约桩。
 * @param {object} app - Cordis Context。
 * @returns {Promise<{service: object, real: boolean}>} 挂载结果。
 */
export async function mountCommands(app) {
  const url = resolveDsh('@deepseek-ai/dsh-commands');
  if (url === undefined) {
    const stub = makeCommandsStub();
    app.provide('commands', stub);
    return { service: stub, real: false };
  }
  const plugin = await import(url);
  app.plugin(plugin.default ?? plugin.CommandRuntime);
  await new Promise((r) => setTimeout(r, 150));
  return { service: app.commands, real: true };
}

/**
 * 造一个**按真实契约校验**的 `systemPrompt` 桩。
 *
 * 真实 `SystemPrompt.section()`（`dsh-system-prompt/lib/index.js`）第一件事是：
 *
 * ```js
 * section(section) {
 *   if (!Number.isFinite(section.order)) throw new TypeError(...);
 *   ...
 * }
 * ```
 *
 * 字段名必须是 **`name` / `order` / `text`**（见 `PromptSection` 类型）。
 * 本项目曾误写成 **`id` / `content`** —— 用宽松桩
 * （`{ section: () => () => {} }`）完全测不出来，因为宽松桩
 * **接受任何字段**，缺 `order` 也不报错。
 *
 * 本桩复刻真实校验：字段名写错、`order` 非有限数字，都会抛。
 * @returns {object} 桩服务，含 `sections` 数组便于断言。
 */
export function makeSystemPromptStub() {
  const sections = [];
  return {
    sections,
    section(section) {
      if (!Number.isFinite(section?.order)) {
        throw new TypeError(`prompt section "${section?.name}" order must be a finite number`);
      }
      if (typeof section?.name !== 'string' || section.name.length === 0) {
        throw new TypeError('prompt section name must be a non-empty string');
      }
      if (typeof section?.text !== 'string' && typeof section?.text !== 'function') {
        throw new TypeError(`prompt section "${section.name}" text must be a string or function`);
      }
      sections.push(section);
      return () => {
        const i = sections.indexOf(section);
        if (i >= 0) sections.splice(i, 1);
      };
    },
  };
}

/**
 * 造一个**按真实契约校验**的 `approval` 桩。
 *
 * 真实 `request(req)` 第一行是 `req.agent.session`，且**要求 turn 打开**，
 * 否则抛错。返回**裸字符串** outcome，不是对象。
 * @param {string} [answer] - 固定返回的 outcome。
 * @returns {object} 桩服务，含 `calls` 数组便于断言。
 */
export function makeApprovalStub(answer = 'allowed-once') {
  const calls = [];
  return {
    calls,
    async request(req) {
      if (req === null || typeof req !== 'object') {
        throw new TypeError('approval.request(req) requires a request object');
      }
      // 真实实现无条件读 req.agent.session —— 缺 agent 会抛 TypeError
      if (req.agent === undefined || req.agent === null) {
        throw new TypeError("Cannot read properties of undefined (reading 'session')");
      }
      if (typeof req.toolName !== 'string' || req.toolName.length === 0) {
        throw new TypeError('approval request toolName must be a non-empty string');
      }
      calls.push(req);
      return answer;
    },
  };
}

/**
 * 造一个按真实契约校验的 `webServer` 桩。
 *
 * 契约来源：`dsh-host-webserver` 的 `WebRoute`：
 * ```ts
 * export type WebRouteKind = 'exact' | 'prefix';
 * export interface WebRoute {
 *   kind: WebRouteKind;
 *   path: string;              // 绝对路径，无尾斜杠
 *   handler: (req, res) => void | Promise<void>;
 * }
 * register(route: WebRoute): () => void;
 * ```
 *
 * 校验点（宽松桩会让真实的注册错误溜过去）：
 *   - `kind` 必须是 `'exact'` / `'prefix'`；
 *   - `path` 必须以 `/` 开头且**不以 `/` 结尾**；
 *   - `handler` 必须是函数；
 *   - 返回值必须是函数（disposer）。
 * @returns {object} 桩服务，含 `routes` 数组便于断言。
 */
export function makeWebServerStub() {
  const routes = [];
  return {
    routes,
    register(route) {
      if (route === null || typeof route !== 'object') {
        throw new TypeError('webServer.register(route) requires a route object');
      }
      if (route.kind !== 'exact' && route.kind !== 'prefix') {
        throw new TypeError(`webServer route kind must be 'exact' or 'prefix', got ${JSON.stringify(route.kind)}`);
      }
      if (typeof route.path !== 'string' || !route.path.startsWith('/')) {
        throw new TypeError(`webServer route path must be absolute, got ${JSON.stringify(route.path)}`);
      }
      if (route.path.length > 1 && route.path.endsWith('/')) {
        throw new TypeError(`webServer route path must not end with a slash, got ${JSON.stringify(route.path)}`);
      }
      if (typeof route.handler !== 'function') {
        throw new TypeError('webServer route handler must be a function');
      }
      routes.push(route);
      return () => {
        const i = routes.indexOf(route);
        if (i >= 0) routes.splice(i, 1);
      };
    },
  };
}

/**
 * 造一个按真实契约校验的 `connection` 桩。
 *
 * 契约来源：`dsh-client-connection` 的 `HostConnectionService`：
 * ```ts
 * requestRejection(req): ConnectionRequestRejection  // 401 | 403 | undefined
 * ```
 * 返回 `undefined` 表示「可以继续」，`401/403` 表示拒绝。
 * @param {'allow'|'deny'} [mode] - 固定行为。
 * @returns {object} 桩服务，含 `calls` 数组便于断言。
 */
export function makeConnectionStub(mode = 'allow') {
  const calls = [];
  return {
    calls,
    requestRejection(req) {
      calls.push(req);
      return mode === 'deny' ? 403 : undefined;
    },
  };
}

/**
 * 造一个最小的 HTTP 响应替身，用于直接驱动路由 handler。
 *
 * 只实现路由代码真正用到的那几个成员：`statusCode`、`setHeader`、`end`。
 * @returns {object} 响应替身，含 `statusCode` / `headers` / `body`。
 */
export function makeResponseStub() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(chunk) {
      this.ended = true;
      if (chunk !== undefined) this.body = String(chunk);
    },
  };
  return res;
}
