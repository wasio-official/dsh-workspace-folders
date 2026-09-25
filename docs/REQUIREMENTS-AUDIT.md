# 设计说明

本文记录本插件的设计依据与关键决策，重点说明**为什么这样设计**，
以及每条决策背后的 DSH 行为事实。

图例：✅ 已实现并有验证 ｜ ⚠️ 部分实现 ｜ ❌ 未实现

---

## 一、七个需求与实现状态

| # | 需求 | 实现方式 | 状态 |
|---|---|---|---|
| ① | 每段对话一个专属子文件夹 | `workspace_bind` 创建 `日期-标题/` 并登记 | ✅ |
| ①b | **绑到已有项目目录**（如 `MinerU`、`PhO`） | `workspace_bind({ target })` + `workspace_projects` | ✅ |
| ② | 对话结束后生成完整 log | `journal.js` 监听 `turn/end`，写 `log/NNNN-<id>.md` | ✅ |
| ③ | 任务完成后「清除」自身 | 归档（非删除）+ 审批卡片 | ✅ |
| ④ | 同文件夹有**已停止**的老对话 → 归档并继承精简内容 | `inherit.js` | ✅ |
| ⑤ | 同文件夹有**活跃**的老对话 → 让位并跳转 | `client/client.js` | ✅ |
| ⑥ | 创建并记忆子文件夹 | `.dsh-workspace-folders.json` + `.dsh-session.json` | ✅ |
| ⑦ | 做成插件 | Cordis 插件，宿主 + 客户端两半 | ✅ |

### ①b 为什么是必需的（原设计的偏差）

最初把需求① 理解成「每个对话新建一个专属文件夹」。但在真实工作区里
（`D:\Wasio\Workspace` 下有 31 个子目录：`MinerU`、`PhO`、`Arcaea`、
`Books`、`qq-bot`…），用户要的是**「这个对话负责那个项目」**，
而不是每次多出一个空的 `日期-标题/` 目录 —— 那样反而让产物散落、更难找。

所以 `workspace_bind` 增加 `target` 参数，`binder.bind()` 接受它。

**关键设计决策：指定 target 时不做同名去重。**

| | 自动命名（不传 `target`） | 指定目标（传 `target`） |
|---|---|---|
| 目录已存在 | 追加 `-2`、`-3`… 避开 | **直接用** |
| 理由 | 两个同名的一次性任务不该互相踩 | 「绑到 MinerU」变成「MinerU-2」就失去意义 |

同一个项目被多个对话先后使用是**正常**的，那正是 ④⑤ 处理的情况。
`check-target.js` 里有一条**对照断言**专门固定这个差异：
同样的占用状态下，自动命名路径**必须**换名字，指定目标路径**必须不换**
—— 证明差异是刻意的，不是漏改。

### ①c 界面入口：为什么不挂在「选择工作区」那里

用户要求「新建对话时给一个和创建工作区差不多的 UI」。DSH 空对话页确实有
这样一个插槽 `conversation.hero.workspace`，正是原生「选择工作区」所在位置。

但它的声明是：

```ts
'conversation.hero.workspace': { kind: 'single', scope: 'root', owner: EmptyWorkspaceOwnerProps };
```

`kind: 'single'` 意味着**只能有一个占用者** —— 往里注册会**挤掉 DSH 原生的
工作区选择器**。那是个很糟的副作用，且用户多半会以为是 DSH 坏了。

因此改挂：

```ts
'conversation.input.dock': { kind: 'list', scope: 'session', owner: InputZone };
```

`kind: 'list'` 允许多个占用者，与内置 UI **并存**。
`check-client-load.js` 里有一条断言专门守住「不得占用 hero.workspace」。

### ①d ★ 客户端半边从未被加载过（本轮发现的真缺陷）

在实现这个 UI 之前，我先核对「客户端插件是怎么被加载的」，结果发现：

`dsh-client-modules` 扫描宿主的 Loader 条目，**只对声明了 `dsh.client`
的包**做客户端半边装配：

```js
const decl = parseDshClient(packageName, dsh?.client);
if (decl === undefined || decl.platform !== 'web') { this.pkgMeta.set(sourceKey, null); return null; }
const clientRel = clientExportOf(packageName, pkg.exports);
if (clientRel === undefined) throw new Error(`... declares dsh.client but exports no "./client" bundle`);
```

而本插件的 `package.json` **没有 `dsh.client` 声明**。

**后果**：`client/client.js` 从来没有被浏览器加载过一行 ——
需求 ⑤（自动让位跳转）自始至终没有生效，而**当时全量测试是全绿的**。
原因是没有任何一个套件去验证「这个包会不会被加载」。

**修复与防回归**：

1. `package.json` 补上 `"dsh": { "client": { "platform": "web" } }`；
2. `check-client-discovery.js` **复刻 `nearestPackage` + `dsh.client` 校验**，
   把这个盲区固定成断言；
3. `check-client-load.js` **真的执行 `client/client.js`**（假
   `window.__ModuleLoader__`），验证 `apply` 确实注册了插槽。

### ①e 新增宿主只读路由

浏览器侧读不了磁盘，所以宿主开一个只读路由供 UI 取项目清单：

| 项 | 值 |
|---|---|
| 路径 | `GET /workspace-folders/projects` |
| 契约 | `ctx.webServer.register({ kind: 'exact', path, handler })` |
| 安全 | `ctx.connection.requestRejection(req)` —— 与 `dsh-host-open-in-app` 同一套信任围栏 |
| 失败策略 | **fail-closed**：拿不到 `connection` 就**不注册**，而不是无保护地开出去 |

### ①②b 需求状态汇总

| # | 需求 | 实现方式 | 状态 |
|---|---|---|---|
| A | 主文件夹 system prompt 必须保留 | `$DSH_HOME` 镜像 | ✅ |
| B | 跨目录访问需审批 | `ctx.approval.request` | ✅ |
| C | 免补丁（不改 DSH 源码/profile） | 全部走官方插件接口 | ✅ |

---

## 二、③ 的语义澄清

### 为什么「归档」而不是「删除」

**事实 1：会话记录是磁盘上的一个目录，且 DSH 没有删除 API**

- 会话存储：`~/.dsh/sessions/<编码后的cwd>/<会话uuid>/session.jsonl.zstd`
- 编码规则：cwd 里的 `\` `/` `:` 都换成 `-`，两端再包 `--`
  （例如 `D:\Wasio\Workspace` → `--D-Wasio-Workspace--`）
- 全树检索确认：DSH 没有 `deleteSession` / `removeSession`。唯一的
  `session/delete` 在 `@agentclientprotocol/sdk`（ACP 协议层），DSH 未实装。

**事实 2：直接删目录有两个坑**

1. **幽灵条目** —— `ctx.sessionQuery.listSessions()` 是
   `listPersisted()` + `ctx.sessions.list()` 的合并结果。
   **内存里活着的会话，删了目录仍会显示**，留下删不掉的条目。
2. **孤儿数据** —— 标题、附件等元数据在别处，删主目录会留下残渣。

**事实 3：DSH 已有正规的归档 API，且比删除更合适**

注意区分两类同名的 `archive`：

- `dsh-session-log-export` 的 `archive` 是**导出 ZIP**（日志+附件下载包），
  **不是**「归档会话」；
- **`dsh-workspace` 的 `archiveSession` 才是**：

```ts
// ctx.workspaceRegistry
get archivedSessionIds(): readonly SessionId[]
archiveSession(sessionId: SessionId): Promise<void>
```

源码注释原文：

> The registry-global archive set: sessions **hidden from every grouping
> surface**. Archiving **never touches workspace accounting** — an archived
> session keeps its `sessionIds` slot so **unarchiving restores its position**.

前端也确实消费它：`deriveGroups` / `deriveFlat` / `deriveSearchResults`
都把归档集排除在外。

**对比：**

| | 直接删目录 | `archiveSession` |
|---|---|---|
| 内容 | **永久消失** | ✅ 完好 |
| 可恢复 | ❌ | ✅ |
| 官方 API | ❌ 绕过 DSH 动它的数据 | ✅ |
| 幽灵条目 | ❌ 会有 | ✅ 无 |
| 工作量 | 6 项检查 + 回收站（约 500 行） | 一次调用（约 350 行） |

**归档反而更省事** —— 不用自己实现回收站与安全删除。

⚠️ **没有 `unarchiveSession`** —— 全树检索确认 `unarchive` 只有注释提到
设计意图、无实现。因此本插件不提供「取消归档」能力。

### 「清除」是删除还是归档？

| 解释 | 后果 | 选择 |
|---|---|---|
| A. 删除会话记录 | 内容**永久消失**，不可逆 | ❌ |
| B. 归档会话 | 从侧栏隐藏，内容全在 | ✅ **已采用** |

**③ 与 ④⑤ 的关系**

③ 是通用规则，④⑤ 是它的两个特例：

| | 场景 | 清除对象 | 决定方式 |
|---|---|---|---|
| **③** | 一般情况：任务做完了 | 本对话自己 | **用户点按钮** |
| **④** | 同文件夹有已停止的老对话 | 那个老对话 | 自动 |
| **⑤** | 同文件夹有活跃的老对话 | 本对话自己 | 自动 |

**为什么 ③ 必须由用户确认，而 ④⑤ 可以自动**

③ 的判定「工作做完了」是**语义判断** —— 没有任何事件能可靠表达它。
若自动执行，最坏情况是用户还在使用的对话被自己藏起来。

而 ④⑤ 的判定是**客观事实**（同文件夹有没有别的会话、它是死是活，
都可以查询），所以可以自动，且不会误判。

**审批卡片 = 零打字机制**

DSH 的审批弹窗本身就是带按钮的卡片（`dsh-client-ui-approval` 用
`dsh-client-ui-primitives` 的 `Button` 渲染）：

```
┌────────────────────────────────────────────┐
│ ● 等待确认                                  │
│  对话「修复登录」已告一段落，是否归档？      │
│  归档后它会从侧边栏隐藏，但日志与内容        │
│  全部保留，不会丢失任何东西。                │
│                      [ 拒绝 ]  [ 允许一次 ] │
└────────────────────────────────────────────┘
```

**「用户点了按钮」这件事本身，就是「工作完了」的权威定义。**

⚠️ 该机制要求 `approval.policy = 'ask'`（即 `workspace-write` 模式）。
在 `danger-full-access` 下策略被硬编码为 `never`，卡片不会弹出，
归档请求会被静默拒绝。

---

## 三、约束 A：主文件夹 system prompt 必须保留

### 问题

DSH 的指令加载器 `dsh-agent-instructions` 的发现顺序：

```
1. 无条件加载 $DSH_HOME/AGENTS.md
2. findProjectRoot(cwd, ['.git'])      ← 默认标记是 .git
3. 沿 ancestorChain(root → cwd) 逐级加载 AGENTS.md / CLAUDE.md
```

会话 cwd 位于子文件夹时，第 2 步会**塌陷到子文件夹本身**（因为从 cwd
向上找不到 `.git`，最终回退到 cwd），于是第 3 步的链只剩子文件夹那一层，
**主文件夹指令静默丢失**。

### 方案：镜像到 `$DSH_HOME/AGENTS.md`

第 1 步是**无条件加载**的 —— 不依赖项目根标记、不依赖 cwd、
也不会被子文件夹的同名文件截断。这是唯一**免补丁**就能生效的位置。

三条安全约束：

- **不覆盖用户自维护的全局 `AGENTS.md`**：检出「不是本插件写的」就跳过，
  并在 `workspace_status` 里报告（状态 `skipped-foreign`）；
- **原子写**（临时文件 + rename），DSH 不会读到半截文件；
- **内容一致时不写盘**，不搅动 mtime、不触发无谓的指令对账。

### 被否决的替代方案

**改 `projectRootMarkers` 配置** —— 属于「打补丁」，且该插件的 config 在
`apply` 时被 `resolveConfig` 读一次并闭包捕获，**另一个插件无法在运行期改写它**。

**把 `AGENTS.md` 当项目根标记** —— `findProjectRoot` 会停在**最近**的那个
`AGENTS.md`，子文件夹一旦自带指令文件，主文件夹的照样丢。已实测否决。

---

## 四、约束 B：跨目录访问需审批

会话被限制在自己的子文件夹内，越界访问走 DSH 原生审批：

```js
ctx.approval.request({ agent, toolName, reason })
// → 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
```

- 授权粒度是**一次性**（`allowed-once`），不提供「永久允许」；
- 只有 `allowed-once` 放行，其余一律**失败关闭**（fail closed）：
  审批服务缺失、通道抛错、返回未知结果，都不动手。

---

## 五、④⑤ 的判定依据

### 「老对话是死是活」怎么判

**不自己造租约机制**（pid + bootId 那套会和 DSH 自身的会话生命周期打架），
改用 DSH 现成的事实：

| 判定 | 依据 |
|---|---|
| `live` | `ctx.sessions.get(id)` 拿得到 |
| `stopped` | 拿不到，但磁盘上有 `sessions/<id>/` 目录 |
| `gone` | 目录也不存在 |
| `unknown` | 拿不到 sessions root → **不猜，跳过** |

### ⚠️ `SessionSummary.cwd` 判不出子文件夹

客户端能拿到 `SessionSummary.cwd`，看起来正适合判「同文件夹」。**实测推翻**：

```
工作区会话数：352
含 cwd 的会话：352 / 352
cwd 样本：["D:\\Wasio\\Workspace", "D:\\Wasio\\Workspace", ...]
```

`cwd` 是**工作区根**，不是子文件夹 —— 同一工作区下所有会话的 `cwd`
完全相同。拿它当兄弟判据会一口气匹配 352 个会话，然后跳到其中一个
毫不相关的对话，属于**危险的误跳**。

**正确做法**：宿主新增 `workspaceFolders` 服务，暴露
`{ [sessionId]: folderName }` 归属表；客户端据此判定，
**拿不到归属表就完全不判定**。

### ⑤ 的顺序：先归档自己，再跳转

`dsh-client-ui-workspace` 的 `clearArchivedCurrent()` 是响应式的：

```js
clearArchivedCurrent() {
  const current = this.sessions.list.getSnapshot().current;
  if (!this.workspaces.list.getSnapshot().archivedSessionIds.includes(current))
    return false;
  this.sessions.clear();      // ← 归档了当前选中项 → 自动清空选择
  return true;
}
```

所以**先归档自己再跳**最干净：清空选择后 `openSession` 立刻接管，
不会留下「跳过去了但自己还在列表里」的中间态。

---

## 六、需求 ⑥：创建并记忆子文件夹

两级登记：

| 文件 | 位置 | 作用 |
|---|---|---|
| `.dsh-workspace-folders.json` | 工作区根 | 全局登记表：`会话 id → 子文件夹` |
| `.dsh-session.json` | 子文件夹内 | 反向登记：哪些会话住在这里 |

子文件夹内的格式支持多会话（④⑤ 都会留下记录）：

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
写回时升级为新格式。

---

## 七、验证策略

**265 项断言**，覆盖 10 个套件，其中：

- `check-load.js` 在**真实 Cordis 上下文**里跑 `apply()`，验证接线；
- `check-nopatch.js` / `check-e2e.js` 在**真实文件系统**上验证指令继承；
- `check-client.js` 在**假浏览器环境**里加载**真实** `client/client.js`；
- `check-readme.js` 校验 README 的配置表与断言数与代码一致。

所有测试使用**隔离的临时 `DSH_HOME`**，不触碰用户真实的 `~/.dsh`。

---

## 八、已知边界

- **`workspace_bind` 由模型发起**：DSH 的 Web UI 新建对话时不传 `cwd`，
  所以「每个新对话自动建子文件夹」需要模型先调一次绑定工具。
  真正的全自动需要在会话创建入口做改动，超出插件能力范围。
- **宿主插件做不到跳转**：导航是 UI 状态，只有浏览器侧能调，
  因此 ⑤ 必须依赖客户端插件 —— 这是唯一的「新增部署面」。
- **DSH 没有取消归档 API**：归档本身安全（内容都在），但给不了撤销按钮。
- **客户端插件未在真实 DSH 会话中完整验证**：④⑤ 通过走真实 `apply()`
  的集成探针验证，但尚未在装好插件后开两个真实对话试过。
- **仅在 Windows 实测**：路径处理已做跨平台归一化，但 Linux/macOS 未实测。

---

## 九、实施中发现的缺陷（全部已修 + 加回归断言）

这一节记录开发过程中真实踩到并修正的问题。**单测全绿 ≠ 功能可用** ——
下面第 4 条就是典型：单元测试全部通过，但功能整体失效。

1. **Cordis 插件必须具名导出** `name`/`inject`/`apply`。
   `export default` 会让 `unwrapExports` 优先取 `.default`，**丢掉 `inject`**。

2. **服务名有单复数之分**：`ctx.sessions`/`ctx.agents` 是复数，
   `ctx.fs`/`ctx.shell` 是单数。`ctx.session`/`ctx.agent` **不存在**。

3. **`defineTool` 不接受 `required: false`**。写 `false` 会抛
   `UNSUPPORTED_SCHEMA: parameters.title.required must be true when present`，
   且 `loadDefineTool` 的 catch 只写日志 —— 表现为工具**静默注册失败**。
   可选参数必须**直接省略** `required` 键。

4. **★ `existing` 的复用条件写错，导致 ④⑤ 整体失效**。
   `resolveSessionFolder` 曾要求「绑定记录里已有本会话」才复用 `existing`。
   但新会话要**加入**已有文件夹时，它当然还不在记录里 —— 于是每次都新建
   `-2` 兄弟目录，继承功能从未真正跑起来。
   由**集成探针**（走真实 `apply()`）发现：单元测试直接调函数，绕过了这条路径。
   **教训：必须有走真实入口的集成验证。**

5. **★ `SessionSummary.cwd` 判不出子文件夹**。它是工作区根，实测 352 个
   会话 cwd 完全相同。拿它当兄弟判据会误跳无关对话（详见第五节）。

6. **配置项「声明了但没人读」是最隐蔽的缺陷**。`autoBind` /
   `folderPrefix` / `allowArchiveOthers` 只在 `config.js` 里解析，
   没有任何模块读它们 —— 用户改了不会有任何效果，而 `describeConfig`
   还显示得好好的。前两个已接线；`allowArchiveOthers` 与硬编码的
   「当前会话永不归档」重复，直接删除。
   `check-e2e` 用手写 config 对象也掩盖了这类问题，已改为 `resolveConfig`。

7. **`isIdle` 不能用于短行**。它的门槛是「剥掉客套话后剩余 ≥ 15 字符」，
   直接拿来做 log 提要会把「已修复 token 判断」这类短而有效的条目
   **全部误杀**。改用面向短行的 `isIdleLine`；且空转判定必须排在长度
   门槛之前，否则统计会漏计（**数字说谎比不统计更糟**）。

8. **`writeBinding` 必须合并而非覆盖**。同一个子文件夹会累积多个会话
   （④⑤ 都留下记录），直接覆盖会抹掉历史。

9. **客户端插件测试要每次重新求值模块**。插件内部有「只让位一次」的
   `Set`，复用实例会让后续用例被静默跳过，表现为「调用记录为空」的**假失败**。

10. **轮询退路必须能 dispose**。否则 `setInterval` 让 Node 进程永不退出，
    测试表现为**超时而非失败** —— 挂起比报错更难查。

11. **测试不要写死绝对路径**。硬编码某个用户目录会让所有测试在别的
    机器上直接失败。已抽出 `scripts/check-fixtures.js` 做三级探测
    （环境变量 → 向上查找 → 仓库自身）。

12. **★ 用到的服务必须全部写进 `inject` —— 一次线上事故。**

    首次真实安装时，插件**整个加载失败**，DSH 启动即中断：

    ```
    Error: cannot get property "systemPrompt" without inject
        at new apply (.../src/index.js:177:30)
    ```

    而当时 **265 项断言全绿**。

    **成因**：`src/index.js` 第 177 行读了 `ctx.systemPrompt`，
    但 `inject` 只声明了 `['tools']`。

    **为什么会漏**：对 Cordis 服务读取的三种行为理解错了。当时的代码注释
    甚至写着「`approval` / `sessionTitle` 刻意不放进来，放进 `inject` 会在
    服务缺席时整个插件不加载」。**这句话是错的** —— Cordis 会**等待**
    服务出现再 apply，不是缺了就崩。

    实测确认的三条规则（`scripts/check-inject.js`）：

    | 写法 | 兄弟插件提供的服务 | 结果 |
    |---|---|---|
    | `inject` 里声明，`ctx.X` | ✅ 拿得到 | **唯一正确** |
    | 不声明，`ctx.X` | ❌ **抛错** | `without inject` |
    | 不声明，`ctx.get('X')` | ❌ **静默 undefined** | 功能悄悄失效 |

    两个反直觉点：
    - **`?.` 挡不住** —— 抛错发生在属性 getter 内部，可选链还没轮到执行。
      `ctx?.approval` 与 `ctx.approval?.request` 都照样抛。
    - **服务在场也没用** —— 校验看的是「有没有声明」，不是「有没有服务」。

    修复过程中还发现：「可选服务用 `ctx.get()` 读」这个补救方案**本身也是错的**
    —— `ctx.get()` 对兄弟插件提供的服务**永远返回 `undefined`**，
    会让审批、归档、标题命名全部静默失效。最终把 7 个服务全部声明。

    **若不修的危险后果**：`inherit.js` 的 `probeSessionState` 读不到
    `ctx.sessions` 会抛错并被 catch 吞掉，随后走进磁盘判定，把**活着的
    会话误判成 `stopped`** —— 而 ④ 会据此归档一个正在使用的对话。

    **为什么测试没抓到**（两个盲区）：
    1. 所有套件都把 `ctx` 传成**普通对象** —— 普通对象不做注入校验，
       于是「没声明就读取」完全测不出来；
    2. 没有任何测试走**真实 loader 路径**（读 patch 文件 → `import(name)`
       → 在兄弟服务就位的 Context 里 apply）。

    **补救**：新增两个套件，都带**反向验证**（把 `inject` 改回出错形态
    必须能复现事故，否则测试本身没有意义）：
    - `check-inject.js` —— 用**真实 Cordis 上下文**；
    - `check-install.js` —— 按**真实 loader 路径重放一次安装**。

    同时删掉了一条把事故成因当正确行为固定下来的断言
    （`check-load.js` 里的「inject 只声明 tools」），
    以及一个基于错误前提写出的模块（`src/services.js` 的 `optionalService`）。

13. **★ 服务的方法契约必须核对着源码写 —— 第二次线上事故。**

    修完 12 之后重新安装，**又崩了**，但换了个错：

    ```
    TypeError: command "workspace-folders" handler must be a function
        at new apply (.../src/index.js:233:49)
    ```

    **成因**：往 `ctx.commands.register()` 传的是 `{ name, description, run }`，
    而 DSH 的契约要求字段名是 **`handler`**。

    核对 `dsh-commands/lib/index.js` 的 `normalizeDefinition` 后确认完整契约：

    | 项 | 要求 |
    |---|---|
    | 字段名 | **`handler`**（不是 `run`） |
    | 返回值 | `{ kind: 'success' \| 'error', text? }`（不是工具的 `{ content: [...] }`） |
    | `register` 返回值 | **同步**返回 disposer（不是 Promise） |
    | `description` | 非空字符串 |
    | `input.hint` | 若存在必须非空 |

    **为什么第一轮测试没抓到**：所有套件都把 `commands` 传成
    `{ register: () => () => {} }` —— 一个**接受任何形状**的桩。
    这与 12 的成因**完全相同**：**桩没有校验，契约错误就测不出来**。

    两次事故的共同教训：**问题不在断言数量，而在测试替身的保真度。**
    单测全绿只证明「在桩的世界里是对的」。

    **补救**（换桩，而不是加断言）：
    - `check-fixtures.js` 新增 `mountCommands()` —— 挂**真实的**
      `CommandRuntime`；退回桩时，桩也**复刻 `normalizeDefinition` 的全部校验**；
    - `check-live.js` —— 真 `CommandRuntime` + **真的执行**两个斜杠命令，
      验证返回契约（能实际打印出命令输出）；
    - `check-install.js` 增加反向验证：真实 `commands` 必须**拒绝** `run` 字段。


最后一条最关键：**没有反向验证的测试，不知道自己是不是瞎的。**
本项目已实测过的反向验证：`inject` 漏声明、`handler`→`run`、
`name`/`text`→`id`/`content` —— 三者都能被对应套件抓出。

---

14. **★ 方法契约的「字段名」与「返回形状」要逐个核对 —— 第三次同类问题。**

    按「再检查一遍类似逻辑」的要求，新增 `check-contracts.js`，把代码里每个
    `ctx.<service>.<method>` 调用点与**真实实现**逐条对照，又查出三处问题
    （其中一处是**静默失效**）：

    | 位置 | 问题 | 真实契约 |
    |---|---|---|
    | `systemPrompt.section()` | 用了 `id` / `content` | **`name` / `order` / `text`** |
    | `sessions.list()` | 当作「当前会话」用 | 返回**全部**会话，**无「当前」概念** |
    | `sessionTitle.get()` | 传 id 也能跑 | 需要 **Session 对象**（内部读 `snapshotEvents()`） |

    **`systemPrompt.section()` 的错会直接崩**：`order` 非有限数字即抛
    `TypeError`，而它在 `apply` 早期执行 —— 一旦抛错，**后面所有注册
    （命令、工具）全部不会发生**，表现就是又「整个插件树加载失败」。

    **`sessions.list()[0]` 的错更阴**：它不崩，只让「不许归档当前会话」
    这道护栏**静默失效** —— `list()` 返回全部会话，`[0]` 是谁全看运气。
    而 `performArchive` 的主要用途恰恰是 ④「归档**别人**的老对话」，
    用 `[0]` 猜「自己是谁」在语义上就是错的。
    修法：**由调用方显式传入自己的 sessionId**（唯一可靠来源），
    拿不到就不拦 —— 宁可放宽，也不能拦错。

    **这一类（参数/返回形状错）比前两类更值得警惕**：前两类会崩，
    崩了就知道；这一类**可能完全静默**，测试和运行时都看不出来。


---

15. **★★ 客户端半边从未被加载过 —— 第四类盲区：「没有任何套件验证装配」**

    做「新建对话时的项目选择 UI」之前，先去核对「客户端插件是怎么被加载的」，
    结果发现 `client/client.js` **从来没有被浏览器执行过一行**。

    **成因**：`dsh-client-modules` 扫描宿主 Loader 条目时，**只装配声明了
    `dsh.client` 的包**：

    ```js
    const decl = parseDshClient(packageName, dsh?.client);
    if (decl === undefined || decl.platform !== 'web') {
      this.pkgMeta.set(sourceKey, null);   // 判定「不是客户端包」，直接跳过
      return null;
    }
    ```

    而 `package.json` 里根本没有 `dsh.client` 字段。

    **为什么测试没抓到**：所有套件都是**直接 import / 执行 `client.js`**，
    绕过了「DSH 会不会加载这个包」这一步。于是：

    | 事实 | 状态 |
    |---|---|
    | 需求 ⑤（自动让位跳转）从未生效 | 而 **421 项断言全绿** |
    | 选择的插槽从未注册 | 而客户端套件逐个通过 |

    **补救**（新增两个套件，都冲着「装配」这一层）：
    - `check-client-discovery.js` —— **复刻** `nearestPackage` + `dsh.client`
      校验 + `exports['./client']` 解析，把「会不会被加载」变成断言；
    - `check-client-load.js` —— 用假的 `window.__ModuleLoader__` **真的执行**
      `client.js`，验证 `apply` 确实注册了插槽。

16. **★★ 模块 id 必须精确等于包名 —— 同一事故的第二层**

    修好 `dsh.client` 之后，UI 仍然一行代码都不跑。加载器里有这道校验：

    ```js
    if (!this.factories.has(id)) throw new Error(
      `client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`);
    ```

    其中 `id` 取自清单行的**包名**。我原本写的是 `dsh-workspace-folders-client`
    （加了 `-client` 后缀），于是**抛错并拒绝装配整个客户端半边** ——
    症状与「没加载」一模一样。

    已把 id 改为精确等于包名，并在 `check-client-load.js` 与
    `check-client-discovery.js` **两处**都加了断言。

17. **★★ 客户端的 `require` 不是文件系统解析 —— 必须自包含**

    加载器的 `require` 只在三处查找：

    ```js
    if (this.seed.has(spec)) return this.seed.get(spec);   // ① 平台种子（react…）
    const record = this.loadCache.get(id); ...             // ② 已物化
    if (this.factories.has(id)) ...                        // ③ 已注册的**包**
    throw new Error(`require("${spec}") missed the module table ...`);
    ```

    `id` 由 `stripClientSuffix(spec)` 得到 —— 那是**包名**。
    相对路径 `require('./picker.js')` 三个分支都不匹配，**必然抛错**。

    所以客户端半边必须是**自包含单文件 bundle**。已把选择器组件内联进
    `client.js`；`check-client-load.js` 里加了「不许出现相对路径 require」的断言，
    并把假 `require` 改成**复刻真实行为**（遇相对路径就抛）——
    这样「偷偷 require 本地文件」在测试里就炸，而不是等到浏览器。

18. **★ 两个 `inject` 是两回事 —— 第五次线上事故**

    真实重启后 DSH 报：

    ```
    Failed to load plugins
    web boot: 1 entry did not activate
    dsh-workspace-folders: pending (waiting for service: workspaceFolders)
    ```

    **成因**：把 `workspaceFolders` 写进了**客户端**的 `exports.inject`。
    那是**宿主半自造**的服务 —— 全树检索确认 `workspaceFolders` 在 DSH 里
    **出现 0 次**。浏览器侧不存在该服务，Cordis 于是**永远等待**。

    | 位置 | 含义 | 取值 |
    |---|---|---|
    | `package.json` 的 `dsh.client.inject` | **模块依赖**（`require()` 能加载谁） | **包名** |
    | 模块的 `exports.inject` | **客户端服务依赖** | **客户端服务名**（`slots`/`sessions`/`uiWorkspace`） |

    已核对：这三个都是真实存在的客户端服务（分别在 `dsh-client-ui-renderer`、
    `dsh-api-session-controller`、`dsh-client-ui-workspace` 的 `.d.ts` 中声明）。

    **连带修的**：`apply` 里还有一处裸的 `ctx.workspaceFolders` 读取 ——
    未声明属性访问会抛 `without inject` 并**打断整个 apply**（连 ⑤ 一起废掉）。
    已改为 `Reflect.get` + try 兜底，拿不到就退化，让 `findLiveSiblings`
    放弃判定（**宁可不跳，也不能误跳**）。

    **为什么测试没抓到**：客户端套件把 `ctx` 传成**普通对象**，
    普通对象不校验注入 —— 与第 12 条的盲区**完全相同**。
    更糟的是，`check-client.js` 里原本有一条断言**要求** `inject` 含
    `workspaceFolders`，等于把事故成因固定成了期望行为。已改为断言**不含**。

19. **★★ 真实 profile 被静默还原 —— 第六次，且只有重启才会暴露**

    修完 18 之后核对安装状态，发现 `check-installed.js` 从 15 项掉到 2 项：
    真实 profile 在 **10:08:42 被还原成了 `backup-20260924`**
    （SHA256 完全相同），插件条目**整段消失**。

    | 事实 | 说明 |
    |---|---|
    | 当时进程仍在跑 | 09:30 启动，早于 10:08 的还原，插件在内存里活着 |
    | `workspace_status` 仍可用 | 所以**表面一切正常** |
    | 一旦重启 | 插件不会加载，且没有任何提示 |

    **还原者未查明**（可能是 DSH 的 GUI 设置页写回）。所以加了
    `scripts/apply-profile.js`：仓库副本是**唯一事实来源**，
    合并进 profile 并**回读校验**（含中文抽样），另给 `--check` 做幂等检查。

    **顺带记一个坑**：第一次用 PowerShell 的 `Get-Content` 读 profile 再写回，
    结果是**乱码** —— `Get-Content` 默认按系统 ANSI（中文 Windows 是 GBK）
    解码 UTF-8 文件，读出来就已经坏了，写回就把乱码**固化**进去。
    改文件一律用显式 UTF-8（`fs.readFile(path, 'utf8')`），并**回读验证**。

    **教训**：`check-installed.js` 这类「读真实环境」的套件价值极高 ——
    它守的正是「代码没问题但环境被改了」这一类，而单测永远看不到。

20. **★★ 插槽选对了类型，却选错了 scope —— 界面根本不出现**

    插件终于加载成功后，用户反馈：**按钮点不了，UI 位置也很怪**。

    根因在读 `dsh-client-ui-conversation` 的渲染代码时定位到：

    ```js
    const zone = session === void 0 || inputState === void 0 ? void 0 : { session, input: inputState };
    // …
    zone !== void 0 && renderSlot("conversation.input.dock", zone)
    ```

    `conversation.input.dock` 声明为 `scope: 'session'` —— **只有会话存在时才渲染**。
    所以「空白新对话页」上它不出现；而在会话里它渲染在输入框上方，
    与「新对话时选择项目」这个意图对不上。

    **我曾以为可以改挂 hero 区**，但查完声明后确认**没有空位**：

    | 插槽 | kind | 状态 |
    |---|---|---|
    | `conversation.hero.workspace` | `single` | 被原生工作区选择器占用 |
    | `conversation.hero.brand.mark` | `single` | 被原生品牌标占用 |
    | `conversation.hero.agentPreset` | `single` | 被原生 Agent 预设占用 |

    三个全是 `single` 且已被占满。往里注册**不是并存，是挤掉原生 UI** ——
    用户很可能以为是 DSH 坏了。

    **结论与处理**：与用户确认后，位置**保持** `conversation.input.dock`，
    并把这个约束**如实写进 README**，而不是假装它出现在新对话页。

    **教训**：选插槽要同时看 `kind` 与 `scope`。`kind: 'list'` 只保证
    「不会挤掉别人」，`scope` 才决定「什么时候渲染」。

21. **★★ 「点不动」的排查：一个写路由换掉整条脆链路**

    原设计是「点按钮 → 把指令填进输入框 → 用户再按发送」。这条链路上
    每一环都可能断：受控输入框不接受直接改 `value`、选择器选错元素、
    React 不感知 `input` 事件。

    与其去修 DOM hack，不如**取消这条链路**：新增
    `POST /workspace-folders/bind`，浏览器直接请求，宿主自己 `binder.bind()`。
    这同时消掉了 `fillComposerWith` 这一整段 DOM 操作代码。

    写路由比只读路由危险，所以对齐 `dsh-host-open-in-app` 的做法全部补齐：

    | 防护 | 实现 |
    |---|---|
    | 信任围栏 | `connection.requestRejection(req)` |
    | fail-closed | 拿不到 `connection` **根本不注册** |
    | 方法限制 | 非 POST → 405 + `Allow` |
    | 媒体类型 | 非 `application/json` → 415 |
    | 体上限 | > 8 KiB → 413（分块累积时即停，不无界读内存） |
    | 入参校验 | 缺字段/非法 JSON → 400 |
    | 路径逃逸 | `isSafeSegment(target)` → 400 |

    **★ 顺带查出一个真漏洞**：`isSafeSegment` 漏了 **Windows 保留设备名**。
    `CON`、`NUL`、`COM1` 这类名字**在任何扩展名下**都被系统当设备，
    建目录会失败或行为诡异。由 `check-bind-route.js` 的逃逸用例抓出并修掉。

22. **★★ 测试测的是「镜像实现」，不是真代码**

    `check-picker.js` 原本 `import` 的是 `client/picker.js` ——
    一份为测试保留的**等价实现**。而 `client.js` 里的是**内联副本**。
    两份代码，测试永远不会发现漂移。

    这是我在 17 条（客户端必须自包含）之后留下的**已知重复**，
    当时只在注释里写了「已知局限」。本轮把它消掉了：
    `check-picker.js` 现在**执行 `client.js`**，从
    `__test.createPickerComponent` 取**真正会被注册进插槽的那个组件**。

    **教训**：「已知重复」如果留在代码里，早晚会变成真 bug。
    要么消除它，要么让测试去测那份真的。

    **另**：本轮的 `check-picker` 全部用**假 React**。假实现必须
    **如实复刻签名** —— 早期 `createElement: () => ({})` 返回空对象、
    丢掉全部 children，导致 17 条断言集体失败（测的是假货，不是组件）。

23. **★★ 「左边凸出来一块」—— 逻辑全对，CSS 盒子错了**

    用户反馈：UI 与整个页面左对齐，**左边凸出一块**。

    这不是前面任何一类缺陷。逻辑全对、渲染也没抛错、点击也正常 ——
    **元素的 CSS 盒子**是错的。而当时全部 577 项断言都测不到这类问题。

    **根因**（读源码确认，非猜测）：插槽出口是**布局透明**的：

    ```js
    const ANCHOR_STYLE = { display: "contents" };   // dsh-client-ui-renderer
    <div data-slot={slotKey} style={ANCHOR_STYLE}>{/* 条目 */}</div>
    ```

    `display: contents` 让外层 div **不参与布局**，我们的元素于是成为
    `.composerStack`（`display:flex; flex-direction:column`）的**直接子项**：

    ```css
    .wSkVaW_composerStack{--dsh-composer-stack-gap:6px;gap:var(--dsh-composer-stack-gap);
                          flex-direction:column;display:flex}
    ```

    这个容器**没有宽度上限、也没有水平居中**。所以一个不写宽度的 `div`
    会撑满整行并贴到左边缘。

    **同插槽的原生「队列」条为什么正常**：它**自带**一个 CSS module 类
    自己约束几何：

    ```css
    ._7yHdaG_dock{
      width:calc(100% - 2*var(--dsh-composer-side-clearance) - 2*var(--dsh-composer-dock-inset));
      max-width:calc(var(--dsh-composer-card-max-width) - 2*var(--dsh-composer-dock-inset));
      margin:0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px);
      padding:0 var(--dsh-composer-dock-inset);
    }
    ```

    我早先只写了 `display:flex` 之类，**没有这套几何**，于是左凸。

    **修法**：把这套几何抄到内联样式里，并用**同一组 CSS 变量**
    （`--dsh-composer-side-clearance` / `--dsh-composer-dock-inset` /
    `--dsh-composer-card-max-width` / `--dsh-composer-stack-gap`，
    每个都带兜底值），这样它会随宿主主题与宽度设置一起变。

    **教训 —— 这是第七类「测试全绿、装上就错」**：
    前六类是加载、契约、脚手架、装配、环境层面的，这一类是**视觉几何**层面。

24. **★★ 反向验证脚本自己先撒了谎 —— 以及沙箱 EPERM**

    补完【8】布局断言后全绿。但「全绿」有两种可能：断言在守，
    或者断言**永远为真**。于是写 `reverse-verify-layout.js`
    做变异测试（把几何字段逐条拆掉，确认断言真的会红）—— 结果踩了三个连环坑：

    **坑 1：`execFileSync` + `try/catch` 会把「读不到」误当成「失败 0」。**
    退出码非 0 时 `execFileSync` **抛错**，我读 `e.stdout` 读不到内容，
    解析出的「失败数」是 0，脚本**谎报所有断言都是摆设**。
    改用 `spawnSync`（不抛错，自己判 `status`），并对「读不到」单独报错。

    **坑 2：本机沙箱不允许管道捕获子进程输出。**
    换 `spawnSync` 后仍然全空，实测：

    ```
    spawnSync node EPERM   （status=null, stdout 长度=0）
    ```

    这正是沙箱的既定边界：**程序不能打开命名管道**，
    所以 `stdio:'pipe'`（两者的默认）一律 EPERM。
    **对策**：不 spawn，改成**在本进程内直接读源码文本**做字段检查 ——
    更快、更可靠，也不再受沙箱限制。

    **坑 3：负向断言会被注释骗过。**
    `geometryOf` 最初用 `/pointerEvents/` 搜源码，而注释里恰好写着
    「刻意**不设** `pointerEvents`」—— 于是这条「不该有 pointerEvents」
    的断言**因为一句注释而永远通过**。改成匹配**真的赋值**且值不是 `undefined`。

    **教训**：反向验证本身也要被验证。「断言全绿」与「断言真的在守」
    是两件事；**负向断言尤其容易变成永真式**。
    `geometryOf` 现在会先自检基线字段齐全，再逐条变异确认变红。

25. **★★★ 改绑不清旧文件夹 —— 一个会话属于两个地方**

    用户在按钮列表里点中了 `dsh-workspace-folders`（**插件自己的源码目录**），
    暴露出三个缺陷，其中第一个是本项目**最严重的一类**：

    **① 幽灵记录。** 改绑只写新文件夹，**不清旧的**。旧文件夹的
    `.dsh-session.json` 里留着 `state: "active"` 的记录，于是插件认为
    同一个会话同时属于两个文件夹。后果不只是显示错乱 ——
    **下次往旧文件夹绑定时，会把正在运行的自己当成「老会话」去归档。**

    **② `boundAt` 复用旧值。** 写的是 `recorded?.boundAt ?? new Date()`，
    改绑时沿用旧时间戳，从数据上分不清哪个是新的。

    **③ 老注册表没有 `dir` 字段。** 只清 `recorded.dir` 对历史数据失效，
    必须能从 `folder` 回推绝对路径。

    **根因（④，也是这类问题的通病）**：`readBinding` 用了**字段白名单**，
    只挑 `id/state/log/archivedAt/inheritedFrom`，其余**静默丢弃** ——
    包括我们自己刚写进去的 `folder` 与 `boundAt`。于是每次
    「读-改-写」都在**顺手抹掉字段**。改成「展开原条目再覆盖 `state`」。

    **处理**：与用户确认后采用**严格单一归属**（一个会话只在一个文件夹的
    记录里），并**隐藏插件自己的目录**（按真实包根判定，不硬编码包名）。
    同时写了一次性脚本把本会话从源码目录挪回它自己的文件夹，
    `log/`（2.5 MB）与 `INHERITED.md` 完好无损。

    **另一个教训**：`check-bind-e2e.js` 里有一条断言写着
    「MinerU 显示有 **2** 个会话」—— 而那个 **2 正是幽灵记录本身**。
    **测试把 bug 编码成了期望行为**，所以它绿着。已改成 1。

26. **★★★ 「绑定不是恒久的，切换对话就会炸」—— 权威来源搞错了**

    用户报告：**「这个绑定不是恒久的，切换对话就会炸。」**

    这条最关键，因为它不是显示问题，而是**会丢数据**：
    同一个会话会攒出多个文件夹，log 写到别处去。

    **根因**：持久记录有**两处**，而代码只信了错的那个。

    | 位置 | 角色 | 代码当它是 |
    |---|---|---|
    | 根目录 `.dsh-workspace-folders.json` | 登记表，**缓存** | ★ 唯一权威 |
    | 各子文件夹 `.dsh-session.json` | 绑定文件，**真正的持久记录** | 只写不读 |

    `bind()` 不带 `target` 时只看登记表：

    ```js
    existing: recorded?.folder     // ← 只信登记表
    ```

    于是只要登记表**少一条**（进程重启后没有、被还原、被人工删过、
    或本插件自己此前的 bug 清掉了），它就**另建一个带日期的新文件夹**，
    把磁盘上明明还在的老文件夹丢在一边。

    **为什么「切换对话」会触发**：`journal.js` 每次写 log 都调
    `bind({ sessionId, title })` —— **不带 target**，正好走这条只信登记表的路径。

    **修法**：补一条**兜底恢复**（自愈）。
    新函数 `findSessionFolderOnDisk()` 在登记表查不到时扫磁盘
    （只读 `.dsh-session.json`，要求会话 id 精确匹配），找到就复用
    并把登记表**补回去**。`lookup()` 也走同一条路 ——
    否则 `lookup()` 说「没绑定」而 `bind()` 会去新建，**同一个会话两个答案**。

    **两个必须注意的边界**（都由回归测试钉住）：

    - **自愈恢复不算改绑** → 沿用磁盘上的原 `boundAt`，
      否则「这个故事什么时候开始的」会被抹掉；
    - **但显式 `target` 改绑时，登记表为空也要清理旧文件夹** ——
      否则又留幽灵记录（这条起初漏了，被 `check-persistence.js` 抓到）。

    **验证方式**：`scripts/check-persistence.js` 里有一项
    **二十轮反复切换 + 每轮清空登记表**，断言绑定始终不变、
    且磁盘上不攒垃圾文件夹。

    **教训**：「缓存」与「权威」必须分清，而且**降级路径要和主路径
    给同一个答案**。只写不读的那份数据是**死数据** —— 它迟早会与
    缓存不一致，而这时唯一正确的动作是**信死数据、修缓存**。

27. **★★ 自己写的复现脚本也会过时**

    `repro-switch.js` 修好后仍打印「★ 同一个会话产生了多个文件夹」——
    因为它用「目录个数 > 1」当判据，而其中一个目录是**场景 B 故意
    制造的正确回退**（登记表指向的目录被删了）。修好之后，正确的
    行为反而触发了这个假警报。

    **教训**：临时的复现脚本写完就该转成**正式断言**
    （`repro-*.js` → `check-*.js`），否则它会以过时的判据继续误导。

28. **★★★ 选择条问完不闭嘴 —— UI 状态是「本地记忆」而不是「问宿主」**

    用户报告两个症状：
    > 「这里显示已绑定，但是每次重新打开对话还是会弹出绑定到项目，
    >  同时点击绑定后绑定成功会一直留存直到切出」

    两句话是**同一个根因**的两面：

    **根因**：选择条**从来没问过宿主「这个会话绑到哪了」**。
    它挂载时只做一件事 —— 拉项目清单，然后渲染一排按钮：

    ```js
    .then((projects) => setState({ status: 'ready', projects }))
    ```

    数据流里**根本没有「当前绑定」这个信息**，所以：

    - 「重新打开对话又弹选择条」—— 它不知道你已经绑过了，**只能再问一遍**；
    - 「绑定成功会一直留存直到切出」—— 绑定后的「已绑定」只是
      `setState` 的**本地记忆**，组件一卸载就没了。

    **为什么 `GET /projects` 答不了**：它只回 `{ root, projects }`，
    没有「**这个**会话绑到哪」。而路由拿到的是**裸 Node `req`**，
    `dsh-host-webserver` 只做 `route.handler(req, res)` —— **没有会话身份**。

    **修法**（三层一起改，缺一层都不成立）：

    1. **协议**：`GET /projects?sessionId=...` 现在回
       `{ root, projects, current }`，`current` 是
       `{ folder, bound: true }` 或 `null`；命中项目标上 `current: true`。
       会话 id 只能由浏览器带上 —— 与 `/bind` 一样**只当字符串键用**，
       伪造的最多污染自己的绑定记录。
    2. **组件**：`boundTo` 一律来自宿主的回答，**每次挂载都重新问**；
       本地状态不再是权威，所以重开对话照样认得。
    3. **交互**：已绑定 → **收起成一行**「✓ 已绑定到 X」+「换绑」按钮
       （换绑态有「取消」退路），不再占地方。

    **⚠️ 反直觉的一点**：修好之后用户**仍然应该**看得到选择条 ——
    未绑定的会话需要它。区别在于**已绑定就闭嘴**。所以验收标准不是
    「选择条消失」，而是「**绑过之后不再追问**」。

29. **★★ 假 React 漏实现 `useCallback`，一次性打挂 31 条断言**

    给组件加上 `react.useCallback(...) ?? (() => {})` 之后，
    `check-picker.js` **31 条断言集体失败**。不是组件坏了，而是
    **假 React 只实现了 `useState`/`useEffect`**：
    `react.useCallback` 是 `undefined`，整个表达式被 `??` 兜成空函数，
    于是 `load()` 什么都不做。

    这是「假实现必须如实复刻签名」那条教训的**第二次复现**
    （第一次是 `createElement` 丢掉 children）。

    **连带发现的两处同类问题**：

    - 桩 `listProjects` 还返回**裸数组**，而组件已改成读 `data.projects`
      → 渲染成空白，又 3 条假失败；
    - 假 `useState` 更新后**不重渲染**，于是 `pick()` 里的
      `if (busy !== null) return;` 永远看到旧的 `null`，
      「连点不重复绑定」因此**假失败**。

    三处都补成贴近真实的行为（含状态变更后同步重渲染）。

    **教训**：**测试替身的保真度是有代价的，而代价总在组件演进时一次性付出。**
    每当组件引入新的 React API 或改变与桩的数据契约，
    都要先问一句「我的假实现支持这个吗」——
    否则会看到一片红色，然后**误以为组件坏了**。

30. **★★ 复现脚本的判据过时（与 27 同类，独立复发）**

    同 27：判据写成了「目录个数 > 1」，而修好之后**正确行为**触发了假警报。
    说明这类问题会反复出现，不是一次性的疏漏。

    **对策已固化为流程**：`repro-*.js` 只用于**确认缺陷存在**，
    修完必须转成 `check-*.js` 里的正式断言，并删掉过时判据。

31. **★★★ 目录名混进中文 —— 「能改成纯英文字符吗」**

    用户看到自动生成的目录后直接问：

    > 「你能把这个文件夹的名字改为纯英文字符吗？」

    当时那个目录叫 `2026-09-25-你是一名-dshdeepseek-harness` ——
    中文标题被截断在半个词上，中英混杂，**看着像乱码**。

    **根因是一行"善意"的代码**。`slugify` 用的是
    `/[\p{L}\p{N}]/u` 并以注释写明「**含 CJK**」：

    ```js
    if (/[\p{L}\p{N}]/u.test(char)) {
      // 字母/数字：直接保留（含 CJK）。ASCII 统一小写，CJK 不受影响。
      parts.push(/[A-Za-z]/.test(char) ? char.toLowerCase() : char);
    }
    ```

    初衷是「中文标题更可读」，实际后果全反了：

    - 标题常被 `MAX_SLUG_LENGTH` **截断在半个词上** → 反而更难读；
    - 终端 / git / 跨工具脚本里**编码经常出问题**；
    - 与工作区既有英文项目目录（`MinerU`、`PhO`）**风格不一致**。

    **修法**：只保留 ASCII 字母数字，其余非 ASCII 一律丢弃。

    **⚠️ 但"丢弃"引入了两个必须同时处理的副作用**，
    它们才是这轮真正的难点：

    1. **不能生成空名。** 纯中文标题 slug 会变成空串
       （`重构认证` → `''`）。→ 退化为**会话 id 短前缀**。
    2. **不能失去可区分性。** 这是最隐蔽的一条 ——
       丢弃中文后 `dsh插件对话子文件夹架构方案` 只剩 `dsh`（3 字符），
       `MinerU 项目使用方法` 只剩 `mineru`，**很容易撞名**，
       更糟的是可能撞上工作区里**既有的项目目录**。
       → slug 短于 4 字符时**补会话 id 前缀**。

    两条都由 `check-naming-ascii.js` 钉死，并且——
    这条测试自己先错了一次：我给 22 个标题用了**同一个会话 id**，
    于是多个纯中文标题都退化到同一个名字，把「不可区分」**误报成缺陷**。
    真实场景是「一个会话一个标题」，改成每例不同 id 才通过。

    **已存在的目录**不能只靠修代码 —— 写了
    `scripts/rename-folder.js`：默认 dry-run、目标存在则拒绝、
    先整体备份、改完**逐项读回验证**。
    因为一个会话的归属有**三处**记录（目录名、根登记表、文件夹内
    `.dsh-session.json`），只改目录名会退化成 25/26 号那类「幽灵记录」。

    **顺带发现**：工作区里还有个 `2026-09-25-api-模型识图能力查询`，
    是**另一个会话改绑后留下的历史存档**（log 154.8 KB）。
    改绑清理旧记录是**对的**（严格单一归属），但目录本身是历史，不该删 ——
    已改名保留。判断依据是 `INHERITED.md` 里的「本目录由插件自动创建」
    与 log 文件名里的会话 id。

    **教训**：**「对用户友好」的默认值要经得起真实环境检验。**
    「保留中文更可读」在没有截断、单一语言、纯 GUI 的理想世界里成立；
    一旦进入终端、git、跨工具、混合语言的真实工作区，
    它就变成了一种**噪声**。默认值应当选**最大兼容**的那个，
    可读性交给用户显式配置（`folderPrefix`）。

32. **★★★ 修对了「字符集」，却修错了「风格」—— 只改一半的默认值**

    31 号把中文去掉了，我以为事情完了。用户立刻回：

    > 「nonono，我不想这样，**其他的风格你也看到了**，
    >  把你改的那两个变成正常风格」

    他指的是这个对比：

    ```
    MinerU   PhO   Books   qq-bot   dsh-config     ← 工作区里真实的文件夹
    2026-09-25-api-vision-capability-probe          ← 我刚生成的
    2026-09-25-dsh-workspace-folders-plugin         ← 我刚生成的
    ```

    **我把「字符集」修对了，却没看「风格」。**
    日期前缀从一开始就存在（`2026-02-14-fix-auth` 是我自己写在文档里的
    示例），31 号只换了字符，**没动这个更显眼的问题**。

    **根因**：判断"什么叫正常"时，我参照的是**自己代码里的既有示例**，
    而不是**用户工作区里的事实**。工作区里 30+ 个目录**没有一个**带日期前缀 ——
    这个证据就在眼前，我却没去看。

    **修法**：`folderDated` 配置项，**默认 `false`**。
    需要按日期归档的人可以显式打开。

    **⚠️ 去掉日期前缀暴露了三处"靠巧合成立"的断言**：

    - `check-target.js` 用 `[...].sort()`（UTF-16 码点序）比对排序，
      而实现用的是 `localeCompare`（人读友好）。以前每个名字都以
      `2026-` 开头，两种序**恰好一致**；去掉日期后 `mineru-2`
      与大写开头的项目混排，差异才暴露。已按实现真正承诺的语义断言。
    - 4 个套件断言"自动命名带日期前缀" —— 全是把旧默认值
      写成了期望行为。
    - 我新写的 `check-naming-ascii.js` 里也有两条同样的问题。

    **教训（两条，比 31 号更值钱）**：

    1. **改默认值要看事实，不要看自己的代码。**
       "什么叫正常风格"的答案在**用户的工作区里**，不在我的示例字符串里。
    2. **默认值改动是一次"全局契约变更"**，会同时掀开一批
       「以前恰好为真」的断言。改之前先问：
       哪些测试是**真的在测语义**，哪些只是**碰巧通过**？
       后者必须按语义重写，而不是把新值填进去让它变绿 ——
       否则就是把巧合又固化一遍。

33. **★★ 改完还得管住老进程**

    改名后我核验过"三处记录自洽"，却漏了一件事：
    **还在跑的进程内存里缓存着旧路径**。它随后又往中文路径写了一次 log，
    把刚删掉的目录**重新创建**了出来，里面的 log 甚至比新目录的更新
    （2886.7 KB / 53 轮 vs 2823.5 KB / 52 轮）。

    `journal.js` 是**整份重写** ledger 的，所以两份 log 不是"接续"，
    而是同一个 ledger 的**两次快照** —— 共同前缀只有 124 字符，
    但后者是前者的超集（轮数 52 → 53）。

    **教训**：**改磁盘布局时，进程内的缓存路径就是一颗定时炸弹。**
    热改文件布局要么先停进程，要么改完立刻重启；
    "改完检查一遍"不够 —— 得**在进程下一次写入之后再检查一遍**。

---

34. **★★ 「现在这个 1 太丑了」—— 用数字表达状态是偷懒**

    用户看到按钮上的 `MinerU ·1` 之后说：

    > 「其实我更希望那些已被占用的目录按钮显示个颜色啥的，或者更深一点，
    >  **现在这个 1 太丑了**」

    **`·1` 的问题不只是丑，是它根本没在表达信息**：

    - 绑定的目录**必然**至少 1 个会话 → 这个数字**几乎恒为 1**；
    - 真正该一眼看出的「**有人占着**」，用一个数字后缀反而**最弱**；
    - `0` 的那一档更糟 —— 未使用的项目干脆不显示数字，
      于是「有后缀 = 已占用」这个约定**要靠用户自己猜**。

    也就是说：这不是配色问题，是**信息设计问题**。
    数字放在那里是为了「省事」，而不是为了「说清楚」。

    **修法**：把状态交给**视觉**，把细节交给 **tooltip**。

    | | 未占用 | 已占用 |
    |---|---|---|
    | 底色 | `transparent`（空心描边） | `rgba(127,127,127,0.22)`（实心） |
    | 标记 | 无 | 6px 圆点 |
    | 文字 | `PhO` | `MinerU`（**干净的项目名**） |
    | tooltip | 「尚未使用」 | 「已有 N 个对话在用」 |
    | `aria-label` | `PhO` | `MinerU（已有 N 个对话在用）` |

    **两个必须守住的细节**（都由断言钉死）：

    1. **两种按钮除底色外结构必须逐字一致**（`border` / `padding` /
       `borderRadius` / `display` / `gap`）—— 否则一行里按钮**高度参差**。
    2. **圆点是纯视觉的**，必须配 `aria-label` 兜底，
       否则读屏用户**完全丢失**占用信息。

    **⚠️ 一个被否掉的写法**：`background: color-mix(in srgb, currentColor 14%, transparent)`
    是最"优雅"的方案（自动跟随主题），但它**较新**（Chrome 111+）——
    一旦不被支持，整条声明被**静默丢弃**，已占用与未占用长得**一模一样**，
    **功能等于没做且不报错**。改用中性灰 + 透明度。

    **教训**：**状态要"看得见"，不要"读出来"。**
    能用颜色/形状表达的，不要用文字后缀 —— 后者既要用户先学会你的约定，
    又往往在信息量上是**最弱**的那一档。

35. **★★★ 需求漏做：UI 上根本没有「新建工作文件夹」**

    用户问：「还有一个创建工作区是不是还没实现」。

    **确实没实现。** 原始需求里就有「**仍然可新建指定名字的子文件夹**」，
    但实现时只做了「绑定已有项目」—— 选择条的按钮由
    `listBindableProjects()` **扫磁盘**得来，**磁盘上有什么就只列什么**，
    没有输入框，所以**没有"新建"这个动作**。

    讽刺的是**宿主侧的接口一直都支持**：
    `POST /workspace-folders/bind` 收到不存在的 `target` 时会直接建目录
    并返回 `created: true`。缺的**只是一个 UI 入口**。

    也就是说：这条需求在**模型侧可用**（`workspace_bind({target})` 一直能新建），
    在**浏览器侧缺失**。我一直拿模型侧的自测当"需求已满足"，
    而用户的入口是浏览器。

    **教训**：**"功能存在" ≠ "用户够得着"。**
    同一个能力有两条通道时，要**逐条**核对 —— 自测走的那条通了，
    不代表用户走的那条也通。

36. **★★★ 净化把危险输入"洗白"成了合法输入**

    给新建入口加名字净化时，我先写成了直接调 `slugify`：

    ```js
    const target = slugify(rawTarget);   // ✗
    slugify('../evil')                 // → 'evil'
    slugify('../../Windows/Temp/pwn')  // → 'windows-temp-pwn'
    ```

    `..` 和 `/` 被当普通分隔符**吃掉**，产出一个**看起来完全合法**的名字。

    **危害不是越界**（`resolveTargetFolder` 仍把目录建在根内，实测无逃逸），
    而是两条：

    1. **两条路径行为不一致**：同样输入 `../evil`，工具路径**报错拒绝**，
       浏览器路径却**默默建了个叫 `evil` 的目录**；
    2. **静默**：危险输入理应**显式报错**，而不是被悄悄改写后照常执行。

    修法是**先判危险模式、再净化**（`normalizeUserFolderName`）。

    **教训**：**净化 ≠ 校验，且净化会摧毁校验。**
    任何"先清洗再检查"的管线，都要问一句：
    **清洗会不会把本该被拒绝的输入变成可接受的？**
    如果是，检查必须发生在清洗**之前**。

37. **★★★ 修 A 需求踩坏 B 需求：绑定已有目录被当成新建**

    加完净化后，`npm run check` 立刻红了一条：

    ```
    [FAIL] ★ 回报绑定的目录名  <- {"folder":"mineru",...}   ← 期望 MinerU
    ```

    **绑定 `MinerU` 返回了 `mineru`** —— 净化把大写字母小写化了，
    于是它去建了个**新**目录，而不是绑到既有的那个上，
    还理直气壮地报了 `renamed: true`。

    根因：我把「**绑定已有**」和「**新建**」两条语义**当成了一条**，
    统一套上了净化。正确的判据是「**目标是否已存在**」：

    - 已存在 → 名字**原样使用**（这是"绑到那个目录"，不是"造一个名字"）；
    - 不存在 → 才走净化（这是"造一个名字"）。

    **教训**：**一个接口承担两种语义时，必须先分流再处理。**
    加校验/净化时尤其危险 —— 它对某一条路径是改进，对另一条可能是破坏。
    这次是**旧的断言**（`check-bind-route.js` 一直在断言 `folder === 'MinerU'`）
    把它抓住的。

    ⚠️ 顺带一提：这条断言**从写下的第一天就在看着这件事**，
    我改净化时并没有想到它 —— 是它自己红给我看的。
    **测试的价值往往不在"验证我想到的"，而在"拦住我没想到的"。**

---

### 贯穿十次事故的方法论（更新）

| 层次 | 做法 | 抓得到什么 | 本轮新增 |
|---|---|---|---|
| 断言数量 | 多加断言 | 业务逻辑回归 | |
| 替身保真度 | 桩**复刻真实校验** | 加载期契约错（会崩的） | 假 `require` 复刻「拒绝相对路径」 |
| 契约对照 | 与**真实源码**逐条比对 | 参数/返回形状错（会静默的） | 两个 `inject` 的语义区分 |
| 反向验证 | 把代码改回错形态，必须复现 | **证明测试不是瞎的** | |
| **装配验证** | **验证「框架会不会加载这段代码」** | **整半边从未运行过** | 复刻包发现 + 真执行 client.js |
| **环境验证** | **读真实 profile/配置做验收** | **环境被外部改动** | `check-installed.js` / `apply-profile.js` |

**最后两行是本轮新增的盲区**，也是代价最大的：
前四层都假设「代码会被执行」，而这次客户端半边
**一行都没跑过**。旁证是：需求 ⑤ 自始至终没生效，
而当时 421 项断言全绿。

⚠️ 另需注意：37 条里有多条是**在真实 DSH 里重启后才暴露**的
（15/16/18/19/20/22/23/26/28/31/32/33 全部如此）。这说明
**`npm run check` 通过 ≠ 插件可用** —— 它只能证明
「在测试替身与仓库副本的世界里是对的」。

最后一条最关键：**没有反向验证的测试，不知道自己是不是瞎的。**
本项目已实测过的反向验证：`inject` 漏声明、`handler`→`run`、
`name`/`text`→`id`/`content` —— 三者都能被对应套件抓出。
