# 重启流程（dsh-workspace-folders 已安装）

> 插件已在 2026-09-24 安装到 `~/.dsh/profiles/web/cordis.patch.yml`。
> 本文件记录**正确的重启顺序**，避免踩 AGENTS.md 里的「不死之源」坑。

## 当前进程

| 端口 | PID | 说明 |
|---|---|---|
| 3080 | **3504** | `dsh web` —— **承载当前会话，别手动杀** |
| 3090 | — | `dsh_proxy.py` 反代 |
| 8090 | — | `file_server.py` |

调度器是 `start_serve.py`（`restart_on_exit=True`），**会拿旧参数自动复原**
你刚杀掉的 `dsh web` —— 所以必须**先停调度器**。

## 正确顺序

### 1. 停调度器 + 子进程（一条命令搞定）

```powershell
cd D:\Wasio\Workspace\dsh-ops
python start_serve.py --stop
```

`stop_children()` 会先把 `_shutting_down` 置位（**禁止自动重启**），
再依次杀子进程。这一步之后，3080 才会真的空出来。

### 2. 确认端口已释放

```powershell
netstat -ano | findstr ":3080"
```

**应该有输出但不再是 LISTENING**；若仍显示 `LISTENING`，再等几秒或重跑一次 `--stop`。

### 3. 重新拉起

```powershell
cd D:\Wasio\Workspace\dsh-ops
python start_serve.py
```

Token 会写到 `dsh-ops\.dsh_web_token`。

### 4. 验证插件加载

浏览器打开（或刷新）`http://127.0.0.1:3080`，在对话里输入：

```
/workspace-folders
```

看到状态表 = 成功。

## 如果启动失败（白屏 / 一堆报错）

错误在 `dsh-ops\ops.log`（UTF-8）。查这几类关键词：

```
cannot get property "X" without inject     ← inject 漏声明
command "X" handler must be a function     ← 命令字段名写错
prompt section "X" ... must be ...         ← systemPrompt.section 字段名写错
```

**报告前先跑本地验收**（用真实 profile 配置 + 真实 DSH 服务重放一次）：

```powershell
cd D:\Wasio\Workspace\dsh-workspace-folders
node scripts\check-installed.js
```

## 卸载

```powershell
# 恢复安装前的备份（干净基线，3818 字节）
$P = "$env:USERPROFILE\.dsh\profiles\web"
Copy-Item "D:\Wasio\Workspace\dsh-workspace-folders\cordis.patch.yml.backup-before-install-20260924" "$P\cordis.patch.yml" -Force
```

然后按上面 1-3 步重启。
