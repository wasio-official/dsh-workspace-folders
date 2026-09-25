# 自己安装 dsh-workspace-folders

> 本插件**没有发布到 npm**（`package.json` 里是 `private: true`），
> 所以不能用 `dsh plugin add dsh-workspace-folders`。
> 只有一条可行路径：**把源码目录用 `file://` URL 挂进 profile**。

---

## 为什么必须是 `file://`

DSH 的 loader（`cordis-plugin-loader`）解析 profile 里的 `name` 时：

| `name` 的形态 | loader 的行为 |
|---|---|
| `cordis:xxx` | 内置插件 |
| 以 `.` 开头 | 相对 profile 目录解析 |
| **其他一切** | 直接 `import(name)` |

`import('dsh-workspace-folders')` 会去 npm 找 —— 找不到就**整个插件树加载失败**。

而「相对路径」也不行：你的 profile 在 `C:`、这个仓库在 `D:`，
跨盘时 `path.relative` 返回的是绝对路径（形如 `D:\...`），不是相对路径。
**只有 `file://` URL 是可靠的。**

---

## 安装（3 步）

### 1. 备份 profile 配置

```powershell
$P = "$env:USERPROFILE\.dsh\profiles\web"
Copy-Item "$P\cordis.patch.yml" "$P\cordis.patch.yml.bak" -Force
```

仓库里已有一份干净基线：`cordis.patch.yml.backup-20260924`（3816 字节）。

### 2. 追加插件条目

编辑 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`，
在**文件末尾**追加下面这段（**注意顶格写 `- insert:`，它是顶层数组的一个元素**）：

```yaml

- insert:
    - id: workspace-folders
      name: 'file:///D:/Wasio/Workspace/dsh-workspace-folders/src/index.js'
      config:
        workspaceRoot: 'D:/Wasio/Workspace'
        autoBind: true
        mirrorInstructions: true
        overwriteGlobalInstructions: false
        dshHome: ''
        writeInheritedNote: true
        writeJournal: true
        journalDebounceMs: 4000
        maxJournalBytes: 2000000
        archiveMode: 'confirm'
        inheritOnBind: true
        handoffMaxBullets: 24
        outsideAccess: 'ask'
        allowInsideWithoutAsk: true
        maxToolResultBytes: 8000
```

> **路径注意**：`file:///D:/...` 是**三个斜杠** —— 前两个是协议，
> 第三个是根。盘符后是**正斜杠** `/`，不是反斜杠。
> 完整说明见 `cordis.patch.yml` 里的注释。

这一条是**唯一的补丁**。本插件不需要改 DSH 任何自带插件。

### 3. 重启 DSH

⚠️ 按本工作区 `AGENTS.md` 记录的坑，**顺序很重要**：

1. **先杀调度器** —— `start_serve.py` 带自动重启，会拿**旧参数**把你刚改的覆盖掉；
2. 再清掉旧的 `dsh web` 子进程；
3. 最后 `cd D:\Wasio\Workspace\dsh-ops; python start_serve.py` 用新代码拉起。

**不要直接杀承载当前会话的 3080 进程** —— 那会把你正在用的对话一起干掉。

---

## 验证是否装上了

重启后，在对话里输入：

```
/workspace-folders
```

正常的话会打印一张状态表（主工作区根、是否镜像指令、出界策略等）。
**看不到这个命令 = 插件没加载成功。**

也可以直接问模型「调用 workspace_status 看看」。

---

## 卸载

把上面那段 `- insert:` 整块删掉，重启即可。

⚠️ **别只删一部分** —— 上一轮卸载时就因为删得不干净，
在文件里留下一段 4746 字节的注释残骸（干净基线是 3816 字节）。
建议直接恢复备份：

```powershell
$P = "$env:USERPROFILE\.dsh\profiles\web"
Copy-Item "$P\cordis.patch.yml.bak" "$P\cordis.patch.yml" -Force
```

---

## 排查：加载失败怎么读错误

插件加载失败时，**整个插件树会挂**，DSH 界面可能只是白屏或报一堆错。
真正的错误在启动日志里，关键词是：

```
cannot get property "X" without inject     ← 服务没在 inject 里声明
command "X" handler must be a function     ← 命令字段名写错（应为 handler）
prompt section "X" ... must be ...         ← systemPrompt.section 字段名写错
```

查 `dsh-ops\ops.log`（UTF-8）。

**在报告问题前，先跑一遍本地检查** —— 它会用**真实 DSH 源码**验证契约：

```powershell
cd D:\Wasio\Workspace\dsh-workspace-folders
npm run check
```

---

## 安装前务必知道的两件事

### 1. `archiveMode: 'confirm'` 需要 `approval.policy = 'ask'`

在 `danger-full-access` 模式下 DSH 把 policy 硬编码为 `never`，
**归档卡片不会弹出，归档会被静默拒绝**。当前你的策略是 `ask`，可用。

### 2. 归档 ≠ 删除

归档只是从侧边栏隐藏，**日志与内容全部保留**。
DSH 没有删除会话的 API —— 这是刻意设计，不是功能缺失。

---

## 需要重新验证的边界

以下内容**只在集成测试里验证过，尚未在真实 DSH 会话中跑通**：

- ④「继承已停止的老对话」的完整流程；
- ⑤「跳转到活跃的老对话」的完整流程；
- 客户端插件（侧边栏跳转）的端到端行为。

这些依赖真实的会话生命周期与 Web UI，测试替身无法完全模拟。
**建议首次安装后，先只做只读操作（`/workspace-folders`、`workspace_status`），
确认插件稳定运行，再试用归档与继承。**

详见 [`README.md`](../README.md) 的「诚实的边界」一节。
