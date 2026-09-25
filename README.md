# dsh-workspace-folders

> 给每个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 对话一个**专属工作子文件夹**，
> 同时**保住主文件夹的 system prompt 注入**，跨目录访问**逐次申请审批**，
> 并在会话结束后**归档**、把上下文**交接**给下一个对话。

[![tests](https://img.shields.io/badge/tests-781%20assertions-brightgreen)](#测试)
[![node](https://img.shields.io/badge/node-%3E%3D20-blue)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**免补丁**：不改 DSH 源码、不改 profile 配置，全部通过官方插件接口实现。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [四个核心机制](#四个核心机制)
- [安装](#安装)
- [配置](#配置)
- [工具与命令](#工具与命令)
- [工作原理](#工作原理)
- [诚实的边界](#诚实的边界)
- [测试](#测试)
- [开发](#开发)
- [故障排查](#故障排查)

---

## 它解决什么问题

长对话会退化：上下文逐渐枯竭，模型开始重复自己、自相矛盾，输出变得不可靠。
「开个新对话」是最有效的解法，但直接开新对话会丢掉两样东西：

1. **主文件夹的 system prompt**（工作区指令 `AGENTS.md` / `CLAUDE.md`）
2. **上一段对话干了什么**

同时，新对话的产物散落在工作区根目录，几次之后就分不清哪个文件属于哪次任务。

本插件把这些问题一起处理：

| 问题 | 做法 |
|---|---|
| 新对话没有自己的工作目录 | 绑定一个 `日期-标题/` 子文件夹，产物与 log 都放里面 |
| 子文件夹会话丢失主文件夹指令 | 把主文件夹指令镜像到 `$DSH_HOME/AGENTS.md`（免补丁） |
| 跨目录访问不设防 | `workspace_access` 走 DSH 原生审批，一次一授权 |
| 旧对话堆积、上下文丢失 | 归档旧对话 + 提炼 log，写成新对话能读到的交接摘要 |
| 同目录还有活跃对话 | 客户端插件自动跳转过去并归档自己 |

---

## 四个核心机制

### ① 工作目录：绑到已有项目，或新建一个

模型在开工前先判断**这个任务属于哪个项目**：

- 属于现成项目（`MinerU`、`PhO`、`Arcaea`…）→
  `workspace_bind({ target: "MinerU" })`，直接绑到那个目录，
  **不会**多出一个空文件夹；
- 一次性任务 → `workspace_bind()`，自动建 `2026-09-24-fix-auth/` 这样的目录。

不确定有哪些项目可绑时，先调 `workspace_projects` 列出来。

### ①c 会话里的项目选择条

除了模型自己判断，**输入框上方会出现一行项目按钮**：

```
绑定到项目：  [MinerU ·3] [PhO] [Arcaea] [Books] … [+8 更多]
```

**点一下就直接绑定** —— 不填输入框、不需要你再按发送：

```
绑定到项目：  [MinerU ·3] [PhO] …
        ↓ 点 MinerU
✓ 已绑定到 MinerU —— 直接开始说你的需求即可。
```

绑定由宿主自己完成（浏览器 `POST /workspace-folders/bind`），
所以不依赖任何 DOM 细节。绑定中按钮会禁用（防连点），
失败会显示原因并给「重试」。

**★ 位置是 DSH 硬约束决定的，不是随便选的**

`conversation.input.dock` 声明为 `scope: 'session'`，源码里是：

```js
const zone = session === void 0 || inputState === void 0 ? void 0 : { session, input: inputState };
zone !== void 0 && renderSlot("conversation.input.dock", zone)
```

**只有会话存在时才渲染**。所以：

| 场景 | 表现 |
|---|---|
| 会话内 | ✅ 正常显示在输入框上方 |
| 空白新对话页 | ❌ 不显示 —— 那里 `session === undefined` |

而空白页所在的 hero 区只有 3 个插槽
（`conversation.hero.workspace` / `.brand.mark` / `.agentPreset`），
**全是 `kind: 'single'` 且已被原生 UI 占满** —— 没有任何空位可以加东西。
往里注册只会**挤掉**原生工作区选择器，那是更糟的结果。

**为什么不挂 `conversation.hero.workspace`**：它是 `kind: 'single'`，
往里注册会把 DSH 原生的「选择工作区」**挤掉**。
`check-client-load.js` 有断言专门守住「不得占用它」。

**★ 为什么组件要自带 `width` / `max-width` / `margin:0 auto`**

插槽出口是**布局透明**的（渲染器用 `ANCHOR_STYLE = { display: "contents" }`
包条目），所以我们的元素是 `.composerStack` 的**直接 flex 子项** ——
而那个容器**没有宽度上限、也没有居中**。不自己写几何，就会
**撑满整行、贴到左边缘**（就是曾经「左边凸出来一块」的原因）。

同插槽的原生「队列」条看起来正常，是因为它**自带** CSS module 约束几何。
本插件把这套几何抄进内联样式，用的是**同一组宿主 CSS 变量**
（`--dsh-composer-side-clearance` / `--dsh-composer-dock-inset` /
`--dsh-composer-card-max-width` / `--dsh-composer-stack-gap`，都带兜底值），
所以会随主题与宽度设置一起变。

`check-picker.js` 的【8】组断言守住这一点，并由
`scripts/reverse-verify-layout.js` 做**变异测试**（逐条拆掉几何字段，
确认断言真的会变红 —— 而不是永远为真）。

> ⚠️ 两个真实缺陷，都是**装上、重启后才暴露**的：
>
> 1. 客户端半边**从未被浏览器加载过** —— `package.json` 缺 `dsh.client`
>    声明，`dsh-client-modules` 判定「不是客户端包」直接跳过。需求 ⑤
>    与选择器**一行代码都没跑过**，而当时全量测试全绿。
>    现在 `check-client-discovery.js` 复刻了那条包扫描规则。
> 2. 加载器还要求注册 id **精确等于包名**（`factories.has(id)` 校验），
>    写成 `...-client` 会抛错并**拒绝装配整个客户端半边**。
>
> 另外：客户端的 `require` **不是文件系统解析**，相对路径必然抛
> `missed the module table` —— 所以客户端半边必须是**自包含单文件**。

### ② ★ 保住主文件夹的 system prompt（本插件的主要理由）

这是最容易做错的地方。DSH 的指令加载器 `dsh-agent-instructions` 这样找指令：

```
1. 无条件加载 $DSH_HOME/AGENTS.md
2. findProjectRoot(cwd, ['.git'])   ← 默认标记是 .git
3. 沿 ancestorChain(root → cwd) 逐级加载 AGENTS.md / CLAUDE.md
```

问题出在第 2 步：**会话的 cwd 是子文件夹时，项目根会塌陷到子文件夹本身**，
于是第 3 步的链只剩子文件夹那一层，**主文件夹的指令静默丢失**。

```
主工作区 D:\Workspace          ← 会话跑在 D:\Workspace\2026-09-24-fix-auth
├── AGENTS.md   ← 想加载这个
└── 2026-09-24-fix-auth/       ← cwd
    └── (无 .git)
```

`findProjectRoot` 从 cwd 向上找 `.git`，一路到盘根都没找到，
最后**回退到 cwd 自己**。链长 = 1，主文件夹的 `AGENTS.md` 不在链上。

**解法**：把主文件夹的指令**镜像**到 `$DSH_HOME/AGENTS.md`。
第 1 步是**无条件加载**的，不依赖项目根标记、不依赖 cwd，
也不会被子文件夹的同名文件截断 —— 这是唯一**免补丁**就能生效的位置。

镜像逻辑有三条安全约束：

- **不覆盖你自己维护的全局 `AGENTS.md`**：检出「不是本插件写的」就跳过，
  并在 `workspace_status` 里如实报告；
- **原子写**（临时文件 + rename），DSH 不会读到半截文件；
- **内容一致时不写盘**，不搅动 mtime、不触发无谓的指令对账。

> 为什么不用「改项目根标记」这条路：把 `AGENTS.md` 当标记会让
> `findProjectRoot` 停在**最近**的那个 `AGENTS.md` —— 子文件夹一旦自带
> 指令文件，主文件夹的照样丢。这条路已被实测否决。

### ③ 跨目录访问要审批

会话被限制在自己的子文件夹内。任何越界访问都走 DSH 原生审批通道：

```js
ctx.approval.request({ agent, toolName, reason })
// → 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
```

弹的是 DSH **原生的可点击卡片**，不是让你打字。
只有 `allowed-once` 才放行；其余一律**失败关闭**（fail closed）。

### ④⑤ 会话归档与继承

新对话绑定子文件夹时，若发现该文件夹里**已有别的会话**，按它的死活分流：

| 老对话状态 | 处理 |
|---|---|
| **已停止**（有记录、不在内存） | 归档它，并把它的 log 提炼成交接摘要 |
| **还活着**（在内存里） | 客户端插件跳转过去，并归档自己 |

「对接 log」是三件事，第三件才是关键：

1. 旧 log 移到 `log/archive/`，标注「已被继承」，**不删**
2. 用启发式提炼要点（去重复输出、去上下文枯竭产生的空转）
3. **写进子文件夹的 `AGENTS.md`** ← 新对话开局就读得到

第 3 点让继承真正生效：否则 log 只是躺在磁盘上，新对话读不到。

---

## 安装

> **尚未发布到 npm**，因此 **`dsh plugin add dsh-workspace-folders` 不可用**
> —— 只能用源码挂载。
> 完整步骤、排错与卸载见 **[`docs/INSTALL.md`](docs/INSTALL.md)**。

### 前置条件

- DSH `0.1.5-rc.1` 或更高
- Node.js `>= 20`
- 审批策略为 `ask`（即 `workspace-write` 模式）—— 归档卡片需要它才能弹出。
  `danger-full-access` 会把策略强制为 `never`，卡片不会出现。

### ★ DSH 版本适配（升级 DSH 后请跑一次）

DSH 发新版后，**本插件是否还能用**需要重新确认。为此提供了
一条命令：

```bash
python scripts/dsh_update.py            # 检测 + 验证（不改任何东西）
python scripts/dsh_update.py --apply    # 验证通过 → 更新 README/package.json 并提交
python scripts/dsh_update.py --release  # 额外打 tag 发 GitHub Release
```

它做三件事：

| 步 | 做什么 | 说明 |
|---|---|---|
| ① **检测** | 对比本机 DSH 与 npm 上的 `latest` / `next` / `alpha` | **只检测，不自动升级** |
| ② **验证** | 见下表的三层 | 无论有没有更新**都会跑** |
| ③ **更新** | 版本要求写进 README 与 `package.json` | 可用→提交；不可用→发 prerelease 记录问题 |

**三层验证**（`python scripts/verify_plugin.py`）：

| 层 | 验什么 | 为什么必须有 |
|---|---|---|
| ① 服务存在性 | 插件 `inject` 的 9 个 Cordis 服务是否仍有插件提供 | 服务没了，Cordis 会让插件**永远等待** —— "装上了但什么都不干"，最隐蔽的坏法 |
| ② 真实装配 | 在**真 Cordis Context** 里 `apply()` 一次 | 契约错了这里必炸（历史上崩过两次，都发生在这一层） |
| ③ 全量断言 | 767 项 | 业务逻辑回归 |

> **为什么本插件通常能跨版本活下来**：它**不 import 任何
> `@deepseek-ai/*` 包**，只依赖 Cordis 的**服务名与调用约定**。
> 所以"依赖版本不匹配"这类问题不存在 —— 唯一的风险是服务契约变了，
> 而那正是上面①②两层在盯的东西。

**绝不自动升级 DSH。** 升级时机是用户的决定（可能正在跑长任务），
而且本工作区里记过「DSH 升级打断 Tailscale 代理链路」的具体坑。
脚本只负责**告诉你事实**。

`DSH-VERIFIED.json` 记录最后一次真实验证的目标版本与时戳。

### 步骤

```bash
git clone https://github.com/wasio-official/dsh-workspace-folders.git
cd dsh-workspace-folders
npm run check          # 可选：跑一遍自检，应全部通过
```

然后在 profile 的 `cordis.patch.yml`（通常位于
`~/.dsh/profiles/web/cordis.patch.yml`）**末尾追加**一条：

```yaml
- insert:
    - id: workspace-folders
      name: 'file:///D:/path/to/dsh-workspace-folders/src/index.js'
      config:
        workspaceRoot: 'D:/你的主工作区'
```

> ### ⚠️ `name` 必须是 `file://` URL
>
> **不能**写包名，也**不能**写裸路径：
>
> | 写法 | 结果 |
> |---|---|
> | `dsh-workspace-folders` | loader 去 npm 找 → 404 → **整个插件树加载失败** |
> | `D:/x/src/index.js` | 非 `.` 开头 → 同样走 `import()` → 失败 |
> | `./dsh-workspace-folders/...` | 跨盘时 `path.relative` 返回绝对路径 → 失败 |
> | **`file:///D:/x/src/index.js`** | ✅ **唯一可靠** |
>
> 三个斜杠：协议两个 + 根一个；盘符后用**正斜杠**。

重启 DSH 后，输入 `/workspace-folders` 确认已生效。

### 客户端插件（⑤ 需要）

⑤ 的自动跳转由 `client/client.js` 提供，由 `dsh-client-modules` 经
`/plugins/<id>/client.js` 直接伺服给浏览器，**不需要重建 DSH 前端**。
声明已写在 `client/package.json` 的 `dsh.client` 字段里。

> ⚠️ 这是**新增的部署面**。DSH 升级时若 `uiWorkspace` / `sessions.list`
> 的接口变动，需要复验 `client/client.js`。

---

## 配置

| 选项 | 默认 | 说明 |
|---|---|---|
| `workspaceRoot` | `''` | 主工作区根（**必填**）。子文件夹建在它下面 |
| `autoBind` | `true` | 是否在会话首次活动时自动创建并绑定子文件夹 |
| `mirrorInstructions` | `true` | 镜像主文件夹指令到 `$DSH_HOME/AGENTS.md`。**关掉会丢 prompt** |
| `overwriteGlobalInstructions` | `false` | 全局 `AGENTS.md` 已存在且非本插件所写时，是否覆盖 |
| `dshHome` | `''` | 显式指定 DSH home；留空按 `DSH_HOME` 或 `~/.dsh` 解析 |
| `folderPrefix` | `''` | 子文件夹名前缀（会过 slugify 净化） |
| `folderDated` | `false` | 目录名是否带 `YYYY-MM-DD-` 日期前缀。**默认关** —— 对齐工作区既有风格（`MinerU` / `PhO` / `qq-bot`） |
| `writeInheritedNote` | `true` | 是否写 `log/archive/INHERITED-FROM.md` |
| `writeJournal` | `true` | 是否在每轮结束时写 log |
| `journalDebounceMs` | `4000` | log 写入去抖 |
| `maxJournalBytes` | `2000000` | 单个 log 的体积上限 |
| `archiveMode` | `'confirm'` | `'confirm'` 弹卡片确认 / `'manual'` 仅手动 / `'off'` 关闭 |
| `inheritOnBind` | `true` | 绑定时是否执行 ④⑤ 分流 |
| `handoffMaxBullets` | `24` | 交接摘要最多保留多少条要点（它会进系统提示，要克制） |
| `outsideAccess` | `'ask'` | 跨目录访问策略 |
| `allowInsideWithoutAsk` | `true` | 子文件夹内部是否免审批 |
| `maxToolResultBytes` | `8000` | 工具返回的最大字节数 |

---

## 工具与命令

| 名称 | 类型 | 作用 |
|---|---|---|
| `workspace_status` | 工具 | 查看当前绑定、镜像状态、归档能力 |
| `workspace_projects` | 工具 | **列出主工作区下可绑定的项目目录**及其绑定情况 |
| `workspace_bind` | 工具 | 绑定工作目录：**绑到已有项目**（`target: "MinerU"`）或新建 |
| `workspace_access` | 工具 | 申请访问工作目录之外的路径（弹原生卡片） |
| `workspace_archive` | 工具 | 归档当前对话（**弹原生卡片**，零打字） |
| `/workspace-folders` | 命令 | 查看工作文件夹状态（只读） |
| `/workspace-archive` | 命令 | 同上，供你手动触发（同样要过审批，防手滑） |

### 绑定到已有项目 vs 新建文件夹

`workspace_bind` 有**两种用法**，对应两类任务：

```js
// ① 任务属于某个现成项目 → 绑到那个目录
workspace_bind({ target: "MinerU" })   // → D:\Wasio\Workspace\MinerU

// ② 一次性任务、没有对应项目 → 自动建一个
workspace_bind()                        // → D:\Wasio\Workspace\2026-09-25-fix-auth
workspace_bind({ target: "Solid" })     // → D:\Wasio\Workspace\Solid（显式指定新名字）
```

关键区别在**同名冲突**时的行为：

| | 自动命名（不传 `target`） | 指定目标（传 `target`） |
|---|---|---|
| 目录已存在 | 追加 `-2`、`-3`… 避开 | **直接用**，不换名 |
| 目录不存在 | 创建 | 创建 |
| 典型场景 | 两个同名的一次性任务 | 多个对话先后负责同一个项目 |

> **为什么指定目标时不去重**：「绑到 `MinerU`」如果变成「绑到 `MinerU-2`」，
> 这个功能就失去意义了。同一个项目被多个对话先后使用是**正常**的 ——
> 那正是 ④⑤（归档老对话 + 交接摘要）要处理的情况，不需要靠改名字来回避。

### 归档为什么一定要你点按钮

「工作做完了」是**语义判断**，没有办法用事件可靠表达。
所以本插件不猜 —— 用 DSH 原生的审批卡片问你：

```
┌────────────────────────────────────────────┐
│ ● 等待确认                                  │
│  对话「修复登录」已告一段落，是否归档？      │
│  归档后它会从侧边栏隐藏，但日志与内容        │
│  全部保留，不会丢失任何东西。                │
│                      [ 拒绝 ]  [ 允许一次 ] │
└────────────────────────────────────────────┘
```

**「你点了按钮」这件事本身，就是「工作完了」的权威定义。**

对比之下 ④⑤ 的判定是**客观事实**（有没有老对话、它是死是活，可查询），
所以能自动，不需要卡片。

---

## 工作原理

### 目录结构

```
主工作区/
├── 2026-09-24-fix-auth/          ← 会话 A 的子文件夹
│   ├── AGENTS.md                 ← 交接摘要（新对话开局读到）
│   ├── .dsh-session.json         ← 哪些会话住在这里
│   └── log/
│       ├── 0001-<sessionId>.md
│       └── archive/
│           ├── inherited-0001-<老sessionId>.md
│           └── INHERITED-FROM.md
└── .dsh-workspace-folders.json   ← 全局登记表：会话 → 子文件夹
```

### 会话存储格式（`.dsh-session.json`）

```jsonc
{
  "folder": "2026-09-24-fix-auth",
  "sessions": [
    { "id": "old-uuid", "state": "inherited",
      "log": "log/archive/inherited-0001-old-uuid.md",
      "archivedAt": "2026-09-24T10:00:00Z",
      "inheritedFrom": "new-uuid" },
    { "id": "new-uuid", "state": "active" }
  ]
}
```

旧的 `{ "sessionId": "..." }` 单会话格式**仍可读**，读取时自动归一化，
写回时升级为新格式（有回归断言覆盖）。

### 「老对话是死是活」怎么判

不自己造租约机制（那会和 DSH 自己的生命周期打架），用 DSH 现成的事实：

| 判定 | 依据 |
|---|---|
| `live` | `ctx.sessions.get(id)` 拿得到 |
| `stopped` | 拿不到，**但**磁盘上有 `sessions/<id>/` 目录 |
| `gone` | 目录也不存在 |
| `unknown` | 拿不到 sessions root（**不猜，跳过**） |

### 归档用的是 DSH 官方 API

```ts
ctx.workspaceRegistry.archiveSession(sessionId)   // 隐藏会话
ctx.workspaceRegistry.archivedSessionIds          // 已归档集合
```

它把会话从所有分组视图里隐藏，**但不碰日志与附件** —— 内容完好，
比直接删目录安全得多（DSH 也没有提供删除会话的 API）。

### ⑤ 的跳转顺序：先归档自己，再跳

`dsh-client-ui-workspace` 的 `clearArchivedCurrent()` 是响应式的：
一旦发现「当前选中项已在归档集里」就 `sessions.clear()`。
所以**先归档自己再跳**是最干净的顺序 —— 清空选择后 `openSession`
立刻接管，不会留下「跳过去了但自己还在列表里」的中间态。

---

## 诚实的边界

这一节是刻意保留的，请务必读完再决定是否使用。

- **`workspace_bind` 由模型发起。** DSH 的 Web UI 新建对话时**不传 `cwd`**，
  所以「每个新对话自动建子文件夹」需要模型先调一次绑定工具
  （插件会注入常驻指引提醒它）。真正的「全自动」需要在会话创建入口做改动，
  超出插件能力范围。

- **宿主插件做不到跳转。** 导航是 UI 状态，只有浏览器侧能调。
  所以 ⑤ 必须依赖客户端插件 —— 这是本仓库唯一「新增部署面」的部分。

- **DSH 没有「取消归档」API。** 归档本身是安全的（内容都在），
  但本插件给不了「取消归档」按钮。

- **归档卡片依赖 `approval.policy = 'ask'`。** 在 `danger-full-access` 下
  策略被硬编码为 `never`，卡片不会弹出，归档请求会被静默拒绝。

- **`SessionSummary.cwd` 不能用来判断子文件夹。** 它是**工作区根** ——
  实测同一个工作区下 352 个会话的 `cwd` **完全相同**。
  ⑤ 因此消费宿主提供的 `workspaceFolders` 归属表，且拿不到就**不判定**。

- **客户端插件未在真实 DSH 会话中完整验证。** ④⑤ 通过集成探针
  （走真实 `apply()`）验证，但**尚未在装好插件后开两个真实对话试过**。

- **仅在中英混排的 Windows 环境实测。** 路径处理已做跨平台归一化，
  但 Linux/macOS 上未实测。

---

## 测试

```bash
npm run check
```

**781 项断言**，覆盖 28 个套件：

| 套件 | 断言数 | 覆盖 |
|---|---|---|
| `check-core.js` | 61 | 路径安全、目录命名、绑定格式兼容、`folderPrefix` |
| `check-inherit.js` | 51 | 状态判定、④ 主流程、log 提炼、安全跳过 |
| `check-load.js` | 44 | 真实 Cordis 加载、工具注册、`workspaceFolders` 服务 |
| `check-archiver.js` | 43 | 归档三态分流、安全检查、配置开关 |
| `check-route.js` | 63 | **宿主只读路由 + 信任围栏 + fail-closed + 当前会话绑定状态 + 新建名字规范化** |
| `check-target.js` | 33 | **`target` 解析：复用/新建/不去重/拒绝逃逸** |
| `check-client.js` | 33 | 客户端插件让位顺序、归属判定、降级容错 |
| `check-contracts.js` | 33 | **逐个核对服务方法契约（参数/返回值/字段名）** |
| `check-bind-e2e.js` | 29 | **端到端绑定到已有项目**（含改绑、幂等、原文件不受损） |
| `check-journal.js` | 27 | log 写入、去抖、注入转义、`autoBind` |
| `check-tools-target.js` | 26 | **从工具注册表真的调用 `workspace_bind({target})`** |
| `check-client-load.js` | 32 | **真的执行 client.js，验证插槽注册与模块 id** |
| `check-bind-route.js` | 34 | **写路由：路径逃逸、体上限、围栏、fail-closed、绑定已存在目录不改名** |
| `check-picker.js` | 80 | **直接驱动 client.js 的真组件：点击、防连点、占用态视觉、新建工作文件夹、重开对话不追问、布局几何** |
| `check-install.js` | 15 | **按真实 loader 路径重放一次安装** |
| `check-dsh-update.js` | 46 | **DSH 版本适配脚本：版本比较语义、README 正则、Release notes 两种形态、token 不泄漏** |
| `check-live.js` | 15 | **真实加载后真的执行两个斜杠命令 + 两条路由** |
| `check-restart-would-fix.js` | 8 | **装配验证：重启后 /bind 真的会注册** |
| `check-rebind.js` | 25 | **改绑：严格单一归属、不自建重复目录、隐藏插件自身** |
| `check-persistence.js` | 23 | **绑定持久性：登记表丢失/重启/反复切换后仍记得** |
| `check-naming-ascii.js` | 29 | **目录名永远是纯 ASCII、无日期前缀（含丢弃中文后仍可区分）** |
| `check-inject.js` | 10 | **在真实 Cordis 上下文里验证注入声明完整** |
| `check-client-discovery.js` | 8 | **复刻 dsh-client-modules 的包发现（dsh.client + 模块 id）** |
| `check-e2e.js` | 7 | 真实文件系统上的指令继承 |
| `check-nopatch.js` | 6 | 免补丁机制：复现问题 → 镜像修复 → 字节级一致 |
| `check-instructions.js`、`check-marker-strategy.js` | — | 指令发现边界、项目根标记方案（探测型） |
| `check-readme.js` | — | **校验本文档的配置表与断言数与代码一致** |

> ### 三个「测试全绿、装上就崩」换来的四个套件
>
> 本插件在真实 DSH 上**崩了三次**，而每次当时测试都是全绿的：
>
> ```
> cannot get property "systemPrompt" without inject
> command "workspace-folders" handler must be a function
> ```
>
> 三次根因**完全相同**：**测试用的桩没有校验**。
>
> | 桩 | 问题 |
> |---|---|
> | `ctx` 传普通对象 | 普通对象**不做注入校验** → 漏声明测不出来 |
> | `commands: { register: () => () => {} }` | **接受任何形状** → `handler` 写成 `run` 也放行 |
> | `systemPrompt: { section: () => () => {} }` | **接受任何字段** → `name`/`text` 写成 `id`/`content` 也放行 |
>
> 修法不是「多写几个断言」，而是**换掉桩**：
>
> - `check-inject.js` —— 真 `Context`，服务由**兄弟插件**提供；
> - `check-install.js` —— 按**真实 loader 路径**重放一次安装；
> - `check-live.js` —— 真 `CommandRuntime`，且**真的执行**两个命令；
> - `check-contracts.js` —— 把代码里每个 `ctx.<service>.<method>` 调用点
>   与**真实实现**逐条对照（参数名、返回值形状、必需字段）。
>
> 四者都带**反向验证**：把代码改回出错形态，必须能复现事故。
> 已实测：改回 `run` 或 `id`/`content`，对应套件立刻报错。
> **测试抓不到的 bug，等于没有测试。**

### 环境被改动怎么办

后两轮又踩到一类新问题：**代码没问题，但环境变了**。

```bash
npm run profile:check   # 检查真实 profile 里插件段是否与仓库副本一致
npm run profile:apply   # 不一致就（备份后）重新合并进去
```

**为什么要专门做这个**：2026-09-25 发现真实 profile 被**静默还原**成旧备份，
插件条目整段消失 —— 而当时进程早就启动了，插件在内存里活着，
`workspace_status` 照样能用，**表面上一切正常，直到重启才会暴露**。

`scripts/apply-profile.js` 以仓库副本为**唯一事实来源**，合并后**回读校验**
（含中文抽样），并提供幂等的 `--check`。

> ⚠️ 改这个文件**不要**用 PowerShell 的 `Get-Content` 再写回：
> 它默认按系统 ANSI（中文 Windows 是 GBK）解码 UTF-8，读出来就已经是乱码，
> 写回就把乱码**固化**进去了（本会话真实踩过）。一律用显式 UTF-8 并回读验证。


> `check-readme.js` 会逐条核对**本文档**里的配置默认值与断言数量。
> 断言总数取自**实跑**结果（`npm run count` 生成的
> `scripts/check-counts.json`）而非静态计数 —— 循环里的断言静态数会少算。
> 文档一旦与代码漂移，`npm run check` 就会失败 —— 防止 README 说谎。

### 「工作文件夹 405」—— 怎么一秒判定该不该重启

改完代码后点按钮报 405，先跑：

```bash
npm run diagnose          # 探测活着的那台 DSH 在跑哪一版
```

**判据是 `Allow` 头在不在**，因为两种 405 长得像、含义完全相反：

| 谁在答 | 非 POST 时的响应 | 含义 |
|---|---|---|
| **本插件的绑定路由** | `405` + **`Allow: POST`** | 路由已注册，代码是新的 |
| `dsh-host-frontend-static` 的 SPA fallback | `405`，**没有任何 `Allow` 头** | 路由没注册，**还在跑旧代码** |

fallback 只在**没有任何路由命中**时才执行：

```js
ctx.webServer.registerFallback(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); }
```

所以**裸 405 = 该重启了**，不是代码缺陷。

```bash
cd D:\Wasio\Workspace\dsh-ops
python start_serve.py --stop     # 先切断自愈调度器
python start_serve.py
```

> ⚠️ **不要直接杀 3080 进程** —— 当前对话就跑在上面。
>
> 另外：`401`/`403` 出现在探测结果里是**好消息**，那是信任围栏在正常工作
> （命令行没有浏览器凭据），说明路由**已经注册**了。

**根因**：宿主进程启动早于代码改动。客户端半边同理 —— 若重启后仍报错，
强制刷新（`Ctrl+Shift+R`）清掉浏览器里的旧 bundle。

`scripts/check-restart-would-fix.js` 会在当前源码上重放一次真实装配，
确认两条路由**都会注册**，所以「重启后就好」是被验证过的结论而非推测。

部分测试需要真实文件系统。主工作区**自动探测**：

1. 环境变量 `DSH_WORKSPACE_ROOT`
2. 从仓库向上找到的第一个含 `AGENTS.md` / `CLAUDE.md` 的目录
3. 仓库自身目录

所有测试使用**隔离的临时 `DSH_HOME`**，绝不触碰你真实的 `~/.dsh`。

---

## 开发

```
src/
├── index.js     插件入口：注册工具、命令、服务
├── binder.js    子文件夹绑定 + 指令镜像 + ④⑤ 分流
├── naming.js    目录命名、登记表、会话绑定格式
├── roots.js     主文件夹指令镜像（免补丁保住 prompt）
├── guard.js     路径边界检查 + 审批申请
├── journal.js   log 写入
├── ledger.js    事件 → log 投影
├── degrade.js   启发式提炼（去重复 / 去空转）
├── inherit.js   ④ 继承：状态判定、log 归档、交接包
├── archiver.js  ③ 归档（审批 + 官方 API）
├── config.js    配置解析
└── tools.js     工具定义
client/
└── client.js    ⑤ 浏览器侧：读会话列表 → 归档自己 → 跳转
```

### 踩过的坑（都已修 + 加断言）

1. **★ 用到的服务必须全部写进 `inject`，没有例外。**
   Cordis 对服务读取有三种行为，**只有一种是对的**：

   | 写法 | 兄弟插件提供的服务 | 结果 |
   |---|---|---|
   | `inject` 里声明，`ctx.X` | ✅ 拿得到 | **唯一正确** |
   | 不声明，`ctx.X` | ❌ **抛错** | `cannot get property "X" without inject` |
   | 不声明，`ctx.get('X')` | ❌ **静默 `undefined`** | 功能悄悄失效 |

   两个反直觉点：**`?.` 挡不住**（抛错在 getter 内部，可选链还没轮到执行），
   以及**服务在场也没用**（校验看的是「有没有声明」）。
   放进 `inject` 不会因服务缺席而报废 —— Cordis 会**等待**它出现再 apply。

   本插件曾因此**整个加载失败**，而当时 265 项断言全绿（教训见「测试」一节）。

2. **★ 服务的方法契约要对着源码写，别照着直觉写。**
   `ctx.commands.register()` 要的字段是 **`handler`**，不是 `run`；
   handler 要返回 **`{ kind: 'success'|'error', text }`**，不是工具那套
   `{ content: [...] }`；`register` 是**同步**返回 disposer。
   写错会抛 `command "x" handler must be a function` —— **同样整个插件树崩**。

   这条和上一条是**同一个病根**：测试用的是「接受任何形状」的宽松桩，
   于是契约错误一路绿灯到线上。**问题不在断言数量，在测试替身的保真度。**

3. **Cordis 插件必须具名导出** `name`/`inject`/`apply`。
   `export default` 会让 `unwrapExports` 优先取 `.default`，**丢掉 `inject`**。
4. **服务名有单复数之分**：`ctx.sessions`/`ctx.agents` 是复数，
   `ctx.fs`/`ctx.shell` 是单数。`ctx.session`/`ctx.agent` **不存在**。
5. **`defineTool` 不接受 `required: false`**。写 `false` 会抛
   `UNSUPPORTED_SCHEMA`，且 `loadDefineTool` 的 catch 只写日志 ——
   表现为工具**静默注册失败**。可选参数必须**直接省略** `required` 键。
6. **`existing` 的复用条件不能要求「记录里已有本会话」**。
   新会话加入已有文件夹时它当然还不在记录里，于是每次都新建 `-2`
   兄弟目录，**继承功能整体失效**。
   **教训：单测全绿 ≠ 功能可用，必须有走真实 `apply()` 的集成验证。**
7. **配置项「声明了但没人读」是最隐蔽的缺陷** —— 它在
   `describeConfig` 里显示得好好的，改了却毫无效果。
8. **跨盘的 profile 无法用相对路径挂载插件**。loader 只对 `.` 开头的
   `name` 走相对解析，而 profile 在 `C:`、仓库在 `D:` 时
   `path.relative` 返回绝对路径 —— 必须用 `file://` URL。
9. **客户端插件测试要每次重新求值模块**：插件内部有「只让位一次」的
   `Set`，复用实例会让后续用例被静默跳过，表现为**假失败**。
10. **轮询退路必须能 dispose**：否则 `setInterval` 让进程永不退出，
    测试表现为**超时而非失败** —— 挂起比报错更难查。
11. **★ `systemPrompt.section()` 的字段是 `name`/`order`/`text`**，
    不是 `id`/`content`。`order` 非有限数字会**直接抛 TypeError**，
    而它跑在 `apply` 早期 —— 一崩，后面**所有命令与工具注册全部不发生**。
12. **★ `sessions.list()` 返回「全部」会话，没有「当前」的概念**。
    用 `list()[0]` 当「当前会话」不会崩，但会让依赖它的安全检查
    **静默失效**。要判断「我是谁」，只能**由调用方显式传入**。
    这类「不崩但失效」的错，比崩溃危险得多。
13. **`sessionTitle.get()` 要的是 Session 对象**（内部读
    `session.snapshotEvents()`），不是 session id。传错会静默返回空标题。

> **一条贯穿始终的经验**：本插件崩过三次，每次测试都是全绿的。
> 病根不在断言数量，而在**测试替身太宽松**（接受任何形状的桩）
> 和**没跟真实源码对过契约**。所以现在的每个关键套件都带**反向验证**：
> 把代码改回出错形态，必须能复现 —— 否则测试等于没写。

### 设计说明

设计依据、关键决策的理由、以及 DSH 行为事实的核对过程，见
[`docs/REQUIREMENTS-AUDIT.md`](docs/REQUIREMENTS-AUDIT.md)。

其中值得一提的是：**「为什么用归档而不是删除」**和
**「为什么 cwd 不能用来判断同文件夹」**这两节，都是先推翻了看起来
合理的方案才定下来的 —— 过程也记录在里面。

---

## 故障排查

| 症状 | 原因与处理 |
|---|---|
| 子文件夹会话丢了主文件夹指令 | 检查 `workspace_status` 的镜像状态。若报告 `skipped-foreign`，说明 `$DSH_HOME/AGENTS.md` 是你自己维护的，需要设 `overwriteGlobalInstructions: true` 或手动合并 |
| 归档卡片不弹 | 审批策略不是 `ask`。`danger-full-access` 会强制为 `never` |
| ⑤ 不自动跳转 | 确认客户端插件已加载，且 `workspaceFolders` 有该会话的归属记录 |
| 子文件夹名变成 `xxx-2` | 同名目录已被别的会话占用。这是**自动命名**的去重行为，正常 |
| 测试报「找不到可用作测试主工作区的目录」 | 设 `DSH_WORKSPACE_ROOT` 指向一个含 `AGENTS.md` 的目录 |

---

## 许可

[MIT](LICENSE)
