/**
 * 「项目选择器」组件的行为验证。
 *
 * ## 关键设计：直接驱动 client.js 里的**真组件**
 *
 * 早期版本 import 的是 `client/picker.js`（一份镜像实现），
 * 于是「测试测的」与「浏览器跑的」是**两份代码**，漂移了也不会被发现。
 * 现在改为**执行 `client.js`**，从 `__test.createPickerComponent`
 * 取出真正会被注册进插槽的那个组件工厂。
 *
 * 用**可驱动的假 React**（能手动触发 setState 与 effect），
 * 而不是渲染成字符串 —— 后者只能证明「没抛错」，证明不了交互对不对。
 *
 * ## 验证重点
 *
 *   1. 挂载后去拉项目清单；
 *   2. 点某个项目 → **直接调用绑定接口**（不再填输入框）；
 *   3. 绑定中禁用按钮（防重复点击）；
 *   4. 绑定成功 → 显示「已绑定」而不是继续显示按钮；
 *   5. 绑定失败 / 拉清单失败 → **显示错误**，不静默；
 *   6. 拿不到 sessionId → 拒绝绑定并报错（**宁可不绑，也不能绑错会话**）；
 *   7. 清单为空 → 不渲染（不占地方）。
 *
 * @module dsh-workspace-folders/scripts/check-picker
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    console.log(`[FAIL] ${label}${detail === undefined ? '' : `  <- ${detail}`}`);
  }
}

/**
 * 造一个可驱动的假 React。
 * @returns {object} 假 React 与驱动接口。
 */
function makeFakeReact() {
  let states = [];
  let cursor = 0;
  let pendingEffects = [];
  let rendered = null;
  // 当前挂载的组件与 props —— 状态变更时需要拿它们重渲染。
  let currentComponent = null;
  let currentProps = {};

  /**
   * 状态变更后同步重渲染一次（模拟 React 的重渲染 + 新闭包）。
   * @returns {void}
   */
  function scheduleRerender() {
    if (currentComponent === null) return;
    // ⚠️ 不能顺手 flush effects：`useEffect(fn, [])` 只在挂载时跑一次，
    //    重渲染时再跑会重复发请求，反而不像真实行为。
    const saved = cursor;
    cursor = 0;
    rendered = currentComponent(currentProps);
    cursor = saved;
  }

  const react = {
    useState(init) {
      const idx = cursor++;
      if (states[idx] === undefined) states[idx] = init;
      return [states[idx], (next) => {
        states[idx] = typeof next === 'function' ? next(states[idx]) : next;
        // ★ 真实 React 会在状态变更后**重新渲染**，于是下一次事件处理函数
        //   闭包里拿到的是**新**值。早期假实现不重渲染，导致
        //   `pick()` 里的 `if (busy !== null) return;` 永远看到旧的 `null` ——
        //   「连点不会重复发起绑定」这条断言因此假失败。
        //   这里同步重渲染，让闭包行为贴近真实。
        scheduleRerender();
      }];
    },
    // ⚠️ 必须实现 `useCallback`（以及 `useMemo`/`useRef`）。
    //    早期假 React 只实现了 useState/useEffect，而组件后来加了
    //    `react.useCallback(...) ?? (() => {})` —— 于是 `load` 直接变成
    //    空函数，**31 条断言集体失败**。
    //    这正是「假实现必须如实复刻签名」那条教训的第二次复现。
    useCallback(fn) { return fn; },
    useMemo(fn) { return fn(); },
    useRef(init) { return { current: init }; },
    useEffect(fn) {
      pendingEffects.push(fn);
    },
    // 真实 `React.createElement(type, props, ...children)`。
    createElement: (type, props, ...kids) => ({
      type,
      props: { ...props, children: kids.length <= 1 ? kids[0] : kids },
    }),
  };

  return {
    React: react,
    render(Component, props = {}) {
      cursor = 0;
      pendingEffects = [];
      // 记住当前挂载，供状态变更后的自动重渲染使用。
      currentComponent = Component;
      currentProps = props;
      rendered = Component(props);
      return rendered;
    },
    flushEffects() {
      const fns = pendingEffects;
      pendingEffects = [];
      fns.forEach((fn) => fn());
    },
    state(i) { return states[i]; },
    reset() {
      states = []; cursor = 0; pendingEffects = []; rendered = null;
      currentComponent = null; currentProps = {};
    },
    last() { return rendered; },
  };
}

/**
 * 让出事件循环直到条件成立（避免固定 setTimeout 的间歇性失败）。
 * @param {Function} predicate - 条件。
 * @param {number} [maxTicks] - 上限。
 * @returns {Promise<boolean>} 是否成立。
 */
async function waitFor(predicate, maxTicks = 50) {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 1));
  }
  return predicate();
}

/**
 * 展平元素树，收集能作为按钮文本的字符串。
 * @param {unknown} node - 元素。
 * @param {Array} [out] - 累加器。
 * @returns {Array} 文本数组。
 */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((n) => texts(n, out)); return out; }
  if (typeof node === 'object' && 'props' in node) texts(node.props?.children, out);
  return out;
}

/**
 * 找到指定类型的元素（如 `input`）。
 * @param {unknown} node - 元素。
 * @param {string} type - 元素类型。
 * @returns {object|undefined} 元素。
 */
function findElement(node, type) {
  if (node === null || node === undefined) return undefined;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findElement(n, type); if (r) return r; }
    return undefined;
  }
  if (typeof node !== 'object' || !('props' in node)) return undefined;
  if (node.type === type) return node;
  return findElement(node.props?.children, type);
}

/**
 * 收集树里所有元素的 `key` 与 `type`（失败时打印用）。
 * @param {unknown} node - 元素。
 * @param {Array} [out] - 累加器。
 * @returns {Array<string>} 形如 `['div','button']`。
 */
function flattenKeys(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { node.forEach((n) => flattenKeys(n, out)); return out; }
  if (typeof node !== 'object' || !('props' in node)) return out;
  out.push(typeof node.type === 'string' ? node.type : String(node.type));
  flattenKeys(node.props?.children, out);
  return out;
}

/**
 * 找到文本匹配的 button 元素。
 * @param {unknown} node - 元素。
 * @param {string} label - 按钮文本。
 * @returns {object|undefined} 元素。
 */
function findButton(node, label) {
  if (node === null || node === undefined) return undefined;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findButton(n, label); if (r) return r; }
    return undefined;
  }
  if (typeof node !== 'object' || !('props' in node)) return undefined;
  if (node.type === 'button' && texts(node).join('') === label) return node;
  return findButton(node.props?.children, label);
}

/** 列出所有 button 的文本。 */
function buttonLabels(node) {
  const out = [];
  const walk = (n) => {
    if (n === null || n === undefined) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n !== 'object' || !('props' in n)) return;
    if (n.type === 'button') out.push(texts(n).join(''));
    walk(n.props?.children);
  };
  walk(node);
  return out;
}

// ── 载入 client.js 里的真组件 ────────────────────────────────────────
console.log('项目选择器组件行为（直接驱动 client.js 的真组件）');
console.log('='.repeat(70));

const source = readFileSync(path.join(ROOT, 'client', 'client.js'), 'utf8');
let captured;
const fakeRequire = (spec) => {
  if (spec === 'react') return { createElement: () => ({}) };
  throw new Error(`unexpected require: ${spec}`);
};
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };
// eslint-disable-next-line no-new-func
new Function('require', 'globalThis', source)(fakeRequire, globalThis);

const { createPickerComponent } = captured?.factory?.(fakeRequire)?.__test ?? {};
check('★★ 从 client.js 取到真组件工厂（不是镜像实现）',
  typeof createPickerComponent === 'function');

if (typeof createPickerComponent !== 'function') {
  console.log(`\n总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
  process.exit(1);
}

const PROJECTS = [
  { name: 'MinerU', bound: true, sessions: 3 },
  { name: 'PhO', bound: false, sessions: 0 },
];

/**
 * 造一份「拉清单 + 绑定」都记录调用的桩。
 *
 * ⚠️ `listProjects` 现在接收 `sessionId`，并返回
 * `{ projects, current }` —— 与宿主路由的真实响应形状一致。
 * `current` 是「**这个**会话已绑到哪」。
 * @param {object} [opts] - 覆盖项。
 * @returns {object} 桩与调用记录。
 */
function makeStubs(opts = {}) {
  const calls = { list: 0, bind: [], listedSessions: [] };
  // 让桩记得「谁绑到哪了」，模拟宿主的持久状态。
  const boundFolders = new Map(Object.entries(opts.bound ?? {}));
  return {
    calls,
    listProjects: async (sessionId) => {
      calls.list += 1;
      calls.listedSessions.push(sessionId);
      if (opts.listError) throw new Error(opts.listError);
      const folder = boundFolders.get(sessionId);
      return {
        projects: opts.projects ?? PROJECTS,
        current: folder === undefined ? null : { folder, bound: true },
      };
    },
    bindProject: async (arg) => {
      calls.bind.push(arg);
      if (opts.bindError) throw new Error(opts.bindError);
      if (opts.bindResult) return opts.bindResult;
      // 绑定成功后宿主会记住 —— 桩也照做，好在重新挂载时体现出来。
      boundFolders.set(arg.sessionId, arg.target);
      return { ok: true, folder: arg.target, created: false };
    },
  };
}

// ── 1. 加载与渲染 ───────────────────────────────────────────────────
console.log('\n【1】加载与渲染');
{
  const fake = makeFakeReact();
  const stubs = makeStubs();
  const C = createPickerComponent(fake.React, stubs.listProjects, stubs.bindProject);

  check('★ 组件是具名函数（React DevTools 里看得见）',
    C.name === 'WorkspacePickerDock', C.name);

  check('首帧（idle）为 null', fake.render(C, { sessionId: 's1' }) === null);

  fake.flushEffects();
  const ready = await waitFor(() => {
    const t = fake.render(C, { sessionId: 's1' });
    return t !== null;
  });
  check('★ 拉完清单后有内容', ready === true);

  const labels = buttonLabels(fake.render(C, { sessionId: 's1' }));
  check('★ 渲染出 MinerU', labels.includes('MinerU'), labels.join('|'));
  check('★ 渲染出 PhO', labels.includes('PhO'), labels.join('|'));
  check('★ 有「绑定到项目：」提示', texts(fake.render(C, { sessionId: 's1' })).includes('绑定到项目：'));
}

// ── 1b. ★★★ 占用状态用视觉表达，不拼数字后缀 ───────────────────────
console.log('\n【1b】占用状态的视觉表达（不再有丑丑的 `·1`）');
{
  const fake = makeFakeReact();
  const stubs = makeStubs();
  const C = createPickerComponent(fake.React, stubs.listProjects, stubs.bindProject);

  fake.render(C, { sessionId: 's1' });
  fake.flushEffects();
  await waitFor(() => fake.state(0)?.status === 'ready');
  const tree = fake.render(C, { sessionId: 's1' });

  const labels = buttonLabels(tree);
  // ★ 用户原话：「现在这个 **1 太丑了**」。
  //   `MinerU ·1` 里的数字几乎恒为 1（绑定的目录必然 ≥1 个会话），
  //   没有信息量，还把按钮文字弄脏。
  check('★★★ 按钮文字里**没有** `·数字` 后缀',
    !labels.some((l) => /·\s*\d/.test(l)), labels.join('|'));
  check('★★ 已占用的按钮显示的就是干净的项目名', labels.includes('MinerU'), labels.join('|'));
  check('★ 未占用的也是干净项目名', labels.includes('PhO'), labels.join('|'));

  // 视觉区分：已占用 → 实心底色 + 圆点；未占用 → 描边。
  const used = findButton(tree, 'MinerU');
  const free = findButton(tree, 'PhO');
  check('★★★ 已占用按钮有**实心底色**（视觉上更深）',
    typeof used?.props?.style?.background === 'string'
      && used.props.style.background !== 'transparent',
    String(used?.props?.style?.background));
  check('★★★ 未占用按钮是**透明**底（空心描边）',
    free?.props?.style?.background === 'transparent',
    String(free?.props?.style?.background));
  check('★★ 两个按钮底色**不同**（确实做出了区分）',
    used?.props?.style?.background !== free?.props?.style?.background);

  // 结构必须一致，否则一行里按钮高度参差。
  const keys = ['border', 'borderRadius', 'padding', 'fontSize', 'display', 'gap'];
  check('★★ 两种按钮结构一致（不会参差不齐）',
    keys.every((k) => used?.props?.style?.[k] === free?.props?.style?.[k]),
    keys.map((k) => `${k}: ${used?.props?.style?.[k]} vs ${free?.props?.style?.[k]}`).join(' ; '));

  // 已占用的按钮里有个小圆点。
  const dot = (used?.props?.children ?? []);
  const hasDot = Array.isArray(dot)
    && dot.some((c) => c?.props?.style?.borderRadius === '50%');
  check('★★ 已占用按钮带一个圆点标记', hasDot, labels.join('|'));
  const freeChildren = free?.props?.children ?? [];
  check('★★★ 未占用按钮**没有**圆点',
    !(Array.isArray(freeChildren) && freeChildren.some((c) => c?.props?.style?.borderRadius === '50%')));

  // 具体数字挪进了 tooltip —— 想细看的人仍然拿得到。
  check('★★ 具体会话数在 tooltip 里（信息没丢）',
    String(used?.props?.title ?? '').includes('3'), String(used?.props?.title));
  check('★ 未占用的 tooltip 说明"尚未使用"',
    String(free?.props?.title ?? '').includes('尚未使用'), String(free?.props?.title));
  // 无障碍：圆点是纯视觉的，必须有无障碍文本兜底。
  check('★★ 有无障碍标签说明占用情况',
    String(used?.props?.['aria-label'] ?? '').includes('已有'), String(used?.props?.['aria-label']));
}

// ── 2. 点击 → 直接绑定 ──────────────────────────────────────────────
console.log('\n【2】点击直接绑定');
{
  const fake = makeFakeReact();
  const stubs = makeStubs();
  const C = createPickerComponent(fake.React, stubs.listProjects, stubs.bindProject);

  fake.render(C, { sessionId: 'sess-abc' });
  fake.flushEffects();
  await waitFor(() => fake.render(C, { sessionId: 'sess-abc' }) !== null);

  const btn = findButton(fake.render(C, { sessionId: 'sess-abc' }), 'MinerU');
  check('★ 找到了 MinerU 按钮', btn !== undefined);
  check('★ 按钮带 onClick（这是「点不动」的最小前提）',
    typeof btn?.props?.onClick === 'function');
  check('★ 按钮 type=button（不会意外提交表单）', btn?.props?.type === 'button');

  btn?.props?.onClick?.();
  await waitFor(() => stubs.calls.bind.length > 0);

  check('★★ 点击调用了绑定接口', stubs.calls.bind.length === 1,
    JSON.stringify(stubs.calls.bind));
  check('★★ 传的是当前会话 id', stubs.calls.bind[0]?.sessionId === 'sess-abc',
    JSON.stringify(stubs.calls.bind[0]));
  check('★★ 传的是被点的项目名', stubs.calls.bind[0]?.target === 'MinerU',
    JSON.stringify(stubs.calls.bind[0]));

  // ★ 取消 `status: 'bound'` 这个状态：绑定信息现在与宿主同源，
  //   统一用 `state.boundTo` 表示，避免出现「本地记得、宿主不记得」的分裂。
  await waitFor(() => fake.state(0)?.boundTo === 'MinerU');
  check('★ 绑定成功后记下已绑到哪', fake.state(0)?.boundTo === 'MinerU',
    JSON.stringify(fake.state(0)));

  const after = fake.render(C, { sessionId: 'sess-abc' });
  const label = texts(after).join('');
  check('★ 显示「已绑定到 MinerU」', label.includes('已绑定到 MinerU'), label);

  // ★ 已绑定后**收起成一行**：只剩一个「换绑」按钮，
  //   不再列出一堆项目按钮追问。这直接对应用户报的
  //   「绑定成功会一直留存直到切出」。
  const afterLabels = buttonLabels(after);
  check('★★ 绑定后收起：不再列出项目按钮',
    !afterLabels.includes('MinerU') && !afterLabels.includes('PhO'),
    afterLabels.join('|'));
  check('★★ 只留一个「换绑」入口', afterLabels.length === 1 && afterLabels[0] === '换绑',
    afterLabels.join('|'));
}

// ── 2b. ★★★ 重新挂载（= 重新打开对话）后不再追问 ──────────────────
console.log('\n【2b】重新打开对话（重新挂载）后的表现');
{
  const fake = makeFakeReact();
  const stubs = makeStubs();

  // 第一次挂载：绑定到 MinerU。
  const C1 = createPickerComponent(fake.React, stubs.listProjects, stubs.bindProject);
  fake.render(C1, { sessionId: 'sess-reopen' });
  fake.flushEffects();
  await waitFor(() => fake.render(C1, { sessionId: 'sess-reopen' }) !== null);
  findButton(fake.render(C1, { sessionId: 'sess-reopen' }), 'MinerU')?.props?.onClick?.();
  await waitFor(() => fake.state(0)?.boundTo === 'MinerU');
  check('★ 第一次绑定成功', fake.state(0)?.boundTo === 'MinerU');

  // ★ 模拟「切出再切回」：**全新的假 React 与全新组件实例**，
  //   本地状态必然清空 —— 只有宿主记得。
  const fake2 = makeFakeReact();
  const C2 = createPickerComponent(fake2.React, stubs.listProjects, stubs.bindProject);
  fake2.render(C2, { sessionId: 'sess-reopen' });
  fake2.flushEffects();
  await waitFor(() => fake2.state(0)?.status === 'ready');

  const reopened = fake2.render(C2, { sessionId: 'sess-reopen' });
  const reopenedText = texts(reopened).join('');
  const reopenedBtns = buttonLabels(reopened);

  check('★★★ 重新打开后**仍然知道**已绑定到 MinerU',
    reopenedText.includes('已绑定到 MinerU'), reopenedText);
  check('★★★ 重新打开后**不再弹出**「绑定到项目」',
    !reopenedText.includes('绑定到项目：'), reopenedText);
  check('★★ 重新打开后也不列项目按钮（只有换绑）',
    !reopenedBtns.includes('MinerU') && reopenedBtns.length === 1,
    reopenedBtns.join('|'));
  check('★★ 挂载时把 sessionId 带给了宿主（否则宿主无从回答）',
    stubs.calls.listedSessions.includes('sess-reopen'),
    JSON.stringify(stubs.calls.listedSessions));

  // 换绑仍然可用。
  findButton(reopened, '换绑')?.props?.onClick?.();
  const expand2 = fake2.render(C2, { sessionId: 'sess-reopen' });
  check('★ 点「换绑」后重新列出项目',
    buttonLabels(expand2).includes('PhO'), buttonLabels(expand2).join('|'));
  check('★ 换绑态标签变成「换绑到：」',
    texts(expand2).includes('换绑到：'), texts(expand2).join('|'));
  check('★ 换绑态提供「取消」退路',
    buttonLabels(expand2).includes('取消'), buttonLabels(expand2).join('|'));
}

// ── 3. 绑定中禁用（防连点）──────────────────────────────────────────
console.log('\n【3】绑定中防连点');
{
  const fake = makeFakeReact();
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const C = createPickerComponent(
    fake.React,
    // ⚠️ 桩必须返回 `{ projects, current }` —— 与宿主路由一致。
    //    早期这里返回裸数组，组件读 `data.projects` 得到 undefined，
    //    于是渲染成空白，三条断言假失败。
    async () => ({ projects: PROJECTS, current: null }),
    async (arg) => { calls.push(arg); await gate; return { ok: true, folder: arg.target }; },
  );

  fake.render(C, { sessionId: 's1' });
  fake.flushEffects();
  await waitFor(() => fake.render(C, { sessionId: 's1' }) !== null);

  findButton(fake.render(C, { sessionId: 's1' }), 'MinerU')?.props?.onClick?.();
  // 绑定还没回来，此时再点一次
  const mid = fake.render(C, { sessionId: 's1' });
  const busyBtn = findButton(mid, 'MinerU …');
  check('★ 绑定中按钮变为进行态', busyBtn !== undefined, buttonLabels(mid).join('|'));
  check('★ 绑定中按钮被 disabled', busyBtn?.props?.disabled === true);

  busyBtn?.props?.onClick?.();
  await waitFor(() => calls.length > 0);
  check('★★ 连点不会重复发起绑定', calls.length === 1, String(calls.length));
  release();
}

// ── 4. 失败要可见 ───────────────────────────────────────────────────
console.log('\n【4】失败可见（不静默消失）');
{
  const fake = makeFakeReact();
  const stubs = makeStubs({ bindResult: { ok: false, error: '目录已存在同名文件' } });
  const C = createPickerComponent(fake.React, stubs.listProjects, stubs.bindProject);

  fake.render(C, { sessionId: 's1' });
  fake.flushEffects();
  await waitFor(() => fake.render(C, { sessionId: 's1' }) !== null);
  findButton(fake.render(C, { sessionId: 's1' }), 'MinerU')?.props?.onClick?.();
  await waitFor(() => fake.state(0)?.status === 'error');

  const t = texts(fake.render(C, { sessionId: 's1' })).join('');
  check('★★ 绑定失败时显示错误', t.includes('目录已存在同名文件'), t);
  check('★ 提供了重试按钮', buttonLabels(fake.render(C, { sessionId: 's1' })).includes('重试'));
}
{
  const fake = makeFakeReact();
  const stubs = makeStubs({ listError: 'HTTP 403' });
  const C = createPickerComponent(fake.React, stubs.listProjects, stubs.bindProject);

  fake.render(C, { sessionId: 's1' });
  fake.flushEffects();
  await waitFor(() => fake.state(0)?.status === 'error');
  const t = texts(fake.render(C, { sessionId: 's1' })).join('');
  check('★★ 拉清单失败时显示原因（不是空白）', t.includes('HTTP 403'), t);
}

// ── 4b. ★★★ 新建工作文件夹（本轮补上的需求）───────────────────────
//
// 用户原始需求里就有「**仍然可新建指定名字的子文件夹**」，
// 但 UI 一直只列**已存在**的目录（`listBindableProjects` 扫磁盘得来），
// 所以这条通道**只有模型侧的工具能用**，浏览器里点不出来。
// 本组守住新补的 UI 入口。
console.log('\n【4b】新建工作文件夹');
{
  const fake = makeFakeReact();
  const stubs = makeStubs();
  const C = createPickerComponent(fake.React, stubs.listProjects, stubs.bindProject);

  fake.render(C, { sessionId: 'sess-new' });
  fake.flushEffects();
  await waitFor(() => fake.state(0)?.status === 'ready');

  // ① 默认折叠：只有一个入口按钮。
  const collapsed = fake.render(C, { sessionId: 'sess-new' });
  const entry = findButton(collapsed, '＋ 新建工作文件夹');
  check('★★ 有「＋ 新建工作文件夹」入口', entry !== undefined,
    buttonLabels(collapsed).join('|'));

  // ★ 用户要求：「不要跟其他的放一起」+「ui 要做出区别」。
  //   入口按钮的形状必须与项目胶囊**明显不同**（方形圆角 + 虚线）。
  const projectChip = findButton(collapsed, 'MinerU');
  check('★★★ 新建入口与项目按钮**形状不同**（不是胶囊）',
    entry?.props?.style?.borderRadius !== projectChip?.props?.style?.borderRadius,
    `新建=${entry?.props?.style?.borderRadius} 项目=${projectChip?.props?.style?.borderRadius}`);
  check('★★★ 新建入口用**虚线**边框（视觉上明确区分）',
    String(entry?.props?.style?.border ?? '').includes('dashed'),
    String(entry?.props?.style?.border));

  // ★ 用户要求：「另起一行」。
  const bar = collapsed;
  const kids = bar?.props?.children ?? [];
  const sep = (Array.isArray(kids) ? kids : []).find((c) => c?.props?.style?.flexBasis === '100%');
  check('★★★ 新建入口**另起一行**（有强制换行的分隔元素）',
    sep !== undefined, JSON.stringify(kids.map?.((k) => k?.key)));

  // ② 点击后展开：出现**大**输入框。
  entry?.props?.onClick?.();
  const expandedTree = fake.render(C, { sessionId: 'sess-new' });
  const input = findElement(expandedTree, 'input');
  check('★★ 点击后出现输入框', input !== undefined,
    JSON.stringify(flattenKeys(expandedTree)));

  // ★ 用户要求：「输入框不要像原来那么小」。
  check('★★★ 输入框**占满整行**（width:100%）',
    input?.props?.style?.width === '100%', String(input?.props?.style?.width));
  check('★★★ 输入框字号不小于 14px（好打字）',
    Number.parseFloat(String(input?.props?.style?.fontSize)) >= 14,
    String(input?.props?.style?.fontSize));
  check('★★ 输入框有像样的内边距',
    Number.parseFloat(String(input?.props?.style?.padding)) >= 8
      || String(input?.props?.style?.padding ?? '').includes('8px'),
    String(input?.props?.style?.padding));
  check('★ 输入框 boxSizing 正确（100% 不会溢出）',
    input?.props?.style?.boxSizing === 'border-box');

  // ③ 输入后回车 → 走同一个绑定接口，target 是用户输入的名字。
  input?.props?.onChange?.({ target: { value: 'my-new-project' } });
  const withText = fake.render(C, { sessionId: 'sess-new' });
  const input2 = findElement(withText, 'input');
  check('★ 输入内容被记录下来', input2?.props?.value === 'my-new-project',
    String(input2?.props?.value));

  input2?.props?.onKeyDown?.({ key: 'Enter', preventDefault() {} });
  await waitFor(() => stubs.calls.bind.length > 0);
  check('★★ 回车即提交（不用去点按钮）', stubs.calls.bind.length === 1,
    JSON.stringify(stubs.calls.bind));
  check('★★ 提交的是用户输入的名字', stubs.calls.bind[0]?.target === 'my-new-project',
    JSON.stringify(stubs.calls.bind[0]));
  check('★ 用的是当前会话 id', stubs.calls.bind[0]?.sessionId === 'sess-new',
    JSON.stringify(stubs.calls.bind[0]));

  await waitFor(() => fake.state(0)?.boundTo === 'my-new-project');
  check('★★ 创建成功后进入已绑定态', fake.state(0)?.boundTo === 'my-new-project',
    JSON.stringify(fake.state(0)));
  const afterCreate = fake.render(C, { sessionId: 'sess-new' });
  check('★★ 创建后收起（不再显示输入框）',
    findElement(afterCreate, 'input') === undefined);
}

// ── 4c. ★ 新建的边界 ────────────────────────────────────────────────
console.log('\n【4c】新建的边界情况');
{
  // Esc 取消。
  const fake = makeFakeReact();
  const stubs = makeStubs();
  const C = createPickerComponent(fake.React, stubs.listProjects, stubs.bindProject);
  fake.render(C, { sessionId: 's1' });
  fake.flushEffects();
  await waitFor(() => fake.state(0)?.status === 'ready');

  findButton(fake.render(C, { sessionId: 's1' }), '＋ 新建工作文件夹')?.props?.onClick?.();
  check('★ 展开后确有序输入框', findElement(fake.render(C, { sessionId: 's1' }), 'input') !== undefined);

  findElement(fake.render(C, { sessionId: 's1' }), 'input')
    ?.props?.onKeyDown?.({ key: 'Escape', preventDefault() {} });
  check('★★ Esc 可以取消', findElement(fake.render(C, { sessionId: 's1' }), 'input') === undefined);
  check('★ 取消没有发起任何绑定', stubs.calls.bind.length === 0);

  // 空白名字不能提交。
  findButton(fake.render(C, { sessionId: 's1' }), '＋ 新建工作文件夹')?.props?.onClick?.();
  findElement(fake.render(C, { sessionId: 's1' }), 'input')
    ?.props?.onChange?.({ target: { value: '   ' } });
  const go = findButton(fake.render(C, { sessionId: 's1' }), '创建');
  check('★★ 名字为空白时「创建」被禁用', go?.props?.disabled === true);

  // 纯中文 → 宿主会净化或拒绝，UI 要能把原因显示出来。
  const fake2 = makeFakeReact();
  const stubs2 = makeStubs({
    bindResult: { ok: false, error: '名称里没有可用的字符（目录名只支持英文字母、数字和连字符）' },
  });
  const C2 = createPickerComponent(fake2.React, stubs2.listProjects, stubs2.bindProject);
  fake2.render(C2, { sessionId: 's1' });
  fake2.flushEffects();
  await waitFor(() => fake2.state(0)?.status === 'ready');
  findButton(fake2.render(C2, { sessionId: 's1' }), '＋ 新建工作文件夹')?.props?.onClick?.();
  findElement(fake2.render(C2, { sessionId: 's1' }), 'input')
    ?.props?.onChange?.({ target: { value: '纯中文' } });
  findButton(fake2.render(C2, { sessionId: 's1' }), '创建')?.props?.onClick?.();
  await waitFor(() => fake2.state(0)?.status === 'error');
  const msg = texts(fake2.render(C2, { sessionId: 's1' })).join('');
  check('★★★ 名字无法净化时报出**具体原因**（不是静默失败）',
    msg.includes('没有可用的字符'), msg);
}

// ── 5. ★ 拿不到 sessionId 必须拒绝 ──────────────────────────────────
console.log('\n【5】拿不到 sessionId 时不猜');{
  const fake = makeFakeReact();
  const stubs = makeStubs();
  const C = createPickerComponent(fake.React, stubs.listProjects, stubs.bindProject);

  // 不传任何 sessionId，且环境里也没有全局兜底
  delete globalThis.__DSH_SESSION_ID__;
  fake.render(C, {});
  fake.flushEffects();
  await waitFor(() => fake.render(C, {}) !== null);
  findButton(fake.render(C, {}), 'MinerU')?.props?.onClick?.();
  await waitFor(() => fake.state(0)?.status === 'error');

  check('★★ 拿不到会话 id 时**不发起绑定**（宁可不绑，不能绑错）',
    stubs.calls.bind.length === 0, JSON.stringify(stubs.calls.bind));
  const t = texts(fake.render(C, {})).join('');
  check('★★ 并明确报出原因', t.includes('拿不到当前会话 id'), t);
}

// ── 6. 空清单不占地方 ───────────────────────────────────────────────
console.log('\n【6】空清单');
{
  const fake = makeFakeReact();
  const stubs = makeStubs({ projects: [] });
  const C = createPickerComponent(fake.React, stubs.listProjects, stubs.bindProject);
  fake.render(C, { sessionId: 's1' });
  fake.flushEffects();
  await waitFor(() => fake.state(0)?.status === 'ready');
  check('★ 没有项目时返回 null（不占地方）',
    fake.render(C, { sessionId: 's1' }) === null);
}

// ── 7. 折叠 ─────────────────────────────────────────────────────────
console.log('\n【7】折叠与展开');
{
  const fake = makeFakeReact();
  const many = Array.from({ length: 10 }, (_, i) => ({ name: `P${i}`, bound: false, sessions: 0 }));
  const stubs = makeStubs({ projects: many });
  const C = createPickerComponent(fake.React, stubs.listProjects, stubs.bindProject);

  fake.render(C, { sessionId: 's1' });
  fake.flushEffects();
  await waitFor(() => fake.render(C, { sessionId: 's1' }) !== null);

  const collapsed = buttonLabels(fake.render(C, { sessionId: 's1' }));
  check('★ 默认只显示 6 个', collapsed.filter((s) => /^P\d+$/.test(s)).length === 6,
    collapsed.join('|'));
  check('★ 有「+4 更多」', collapsed.includes('+4 更多'), collapsed.join('|'));

  findButton(fake.render(C, { sessionId: 's1' }), '+4 更多')?.props?.onClick?.();
  const expandedLabels = buttonLabels(fake.render(C, { sessionId: 's1' }));
  check('★ 展开后显示全部 10 个',
    expandedLabels.filter((s) => /^P\d+$/.test(s)).length === 10,
    expandedLabels.join('|'));
}

// ── 8. ★★ 布局几何（「左边凸出来一块」的回归测试）────────────────────
//
// 这是**唯一一类**早期全套件都测不到的缺陷：逻辑全对、渲染也没抛错，
// 但元素的 CSS 盒子是错的。当时用户看到的是「UI 和整个页面左对齐，
// 左边凸出来一块」。
//
// 根因：插槽出口是 `display:contents`（布局透明），我们的元素直接成为
// `.composerStack`（flex column，**无宽度上限、无居中**）的子项。
// 同插槽的原生 QueueDock 之所以正常，是因为它自带 CSS module 自己约束几何。
//
// 所以必须断言：我们的根元素**自己**带上了那套几何。
console.log('\n【8】布局几何（左凸回归）');
{
  const fake = makeFakeReact();
  const stubs = makeStubs();
  const C = createPickerComponent(fake.React, stubs.listProjects, stubs.bindProject);

  fake.render(C, { sessionId: 's1' });
  fake.flushEffects();
  await waitFor(() => fake.render(C, { sessionId: 's1' }) !== null);
  const el = fake.render(C, { sessionId: 's1' });
  const style = el?.props?.style ?? {};

  check('★ 根元素有内联 style', el?.props?.style !== undefined);

  // 关键三条：宽度约束 + 居中 + 不伸缩。
  check('★★ 设了 width（否则撑满整行）',
    typeof style.width === 'string' && style.width.includes('100%'), String(style.width));
  check('★★ 设了 maxWidth（与输入框同宽上限）',
    typeof style.maxWidth === 'string' && style.maxWidth.includes('--dsh-composer-card-max-width'),
    String(style.maxWidth));
  check('★★ margin 是 auto 居中（「左凸」的直接解药）',
    typeof style.margin === 'string' && style.margin.includes('auto'), String(style.margin));
  check('★ flex:none（不被 flex 容器拉伸）', style.flex === 'none', String(style.flex));
  check('★ boxSizing:border-box（padding 不额外撑宽）',
    style.boxSizing === 'border-box', String(style.boxSizing));

  // 用的是宿主的变量，不是硬编码像素 —— 换主题/改宽度设置时能跟着走。
  check('★★ 宽度用的是宿主 CSS 变量（不是硬编码 px）',
    String(style.width).includes('--dsh-composer-side-clearance')
      && String(style.width).includes('--dsh-composer-dock-inset'),
    String(style.width));
  check('★ 每个变量都有兜底值（变量缺失时不会算出 NaN）',
    !String(style.width).includes('NaN')
      && /var\(--[\w-]+,\s*[^)]+\)/.test(String(style.width)),
    String(style.width));

  // ⚠️ 一旦有人加了 pointer-events:none，按钮就会「点不动」。
  check('★★ 没有 pointerEvents:none（那会让按钮点不动）',
    style.pointerEvents === undefined, String(style.pointerEvents));
  check('★ 也没有 visibility:hidden / display:none 之类的隐藏',
    style.visibility === undefined && style.display !== 'none', String(style.display));

  // 错误态与已绑定态用的是同一套几何（否则状态一变又凸出来）。
  const errFake = makeFakeReact();
  const errStubs = makeStubs({ listError: 'HTTP 403' });
  const CE = createPickerComponent(errFake.React, errStubs.listProjects, errStubs.bindProject);
  errFake.render(CE, { sessionId: 's1' });
  errFake.flushEffects();
  await waitFor(() => errFake.state(0)?.status === 'error');
  const errStyle = errFake.render(CE, { sessionId: 's1' })?.props?.style ?? {};
  check('★★ 错误态的几何与正常态一致（状态切换不会又凸出来）',
    errStyle.margin === style.margin && errStyle.width === style.width,
    `err.margin=${errStyle.margin}`);
}

console.log(`\n${'='.repeat(70)}`);
console.log(`总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;