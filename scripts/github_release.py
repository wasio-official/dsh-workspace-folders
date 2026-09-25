#!/usr/bin/env python3
"""把「提交 / 打 tag / 发 GitHub Release」从编排里拆出来，单独可测。

## 为什么单独一个文件

这几步都要**网络 + 凭据**，是最容易出错、也最不该和"验证"混在一起的部分。
混在一起的后果：验证明明通过了，却因为网络问题整条链失败，
让人误以为插件坏了。拆开之后：

- `dsh_update.py` 负责**判断**（能不能用）；
- 本文件负责**发布**（把结论送出去）。

## ★ 本机环境的两个坑（实测）

1. **schannel 不可用**：`curl` 和 git 默认的 schannel 后端都报
   `SEC_E_NO_CREDENTIALS`。必须给 git 加 `-c http.sslBackend=openssl`。
2. **凭据弹窗被沙箱拦截**：Git Credential Manager 会调 `askpass.sh`，
   而沙箱不允许创建信号管道（`couldn't create signal pipe, Win32 error 5`）。
   所以推送**必须**把 token 直接放进 URL，不能走凭据管理器。

## 用法

    python github_release.py --check-token                 # 只探权限
    python github_release.py --push                        # 推 main
    python github_release.py --tag v0.1.1 --notes-file x.md # 打 tag + 发 Release
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parent

REPO = "wasio-official/dsh-workspace-folders"
API = "https://api.github.com"
DEFAULT_PROXY = "http://127.0.0.1:9910"


def read_token() -> str | None:
    """从环境变量取 token。

    ⚠️ 刻意**不从命令行参数**取 —— 那会让 token 出现在进程列表和历史里。

    @returns: token 或 None。
    """
    for name in ("GITHUB_TOKEN", "GH_TOKEN"):
        v = os.environ.get(name)
        if v and v.strip():
            return v.strip()
    return None


def build_opener(proxy: str | None):
    """构造带代理的 opener。

    @param proxy: 代理。
    @returns: opener。
    """
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"https": proxy, "http": proxy}))
    return urllib.request.build_opener(*handlers)


def api_call(method: str, path: str, token: str, proxy: str | None,
             payload: dict | None = None, timeout: int = 60):
    """调 GitHub API。

    @param method: HTTP 方法。
    @param path: 以 `/` 开头的路径。
    @param token: PAT。
    @param proxy: 代理。
    @param payload: JSON body。
    @param timeout: 超时。
    @returns: `(状态码, 解析后的 JSON 或原始文本)`。
    """
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "dsh-workspace-folders/release",
        "Content-Type": "application/json",
    }
    # ★ 空 token 时**不要**发 `Authorization: Bearer `（空值）——
    #   GitHub 会因此返回 401，而不是按匿名请求处理。
    #   实测踩过：这会让"只想探连通性"的调用看起来像认证失败。
    if token and token.strip():
        headers["Authorization"] = f"Bearer {token.strip()}"

    req = urllib.request.Request(API + path, data=body, method=method, headers=headers)
    try:
        with build_opener(proxy).open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        return 0, f"{type(exc).__name__}: {exc}"


def check_token(token: str, proxy: str | None) -> dict:
    """确认 token 身份与对本仓库的写权限。

    ★ 必须**真的测一次写**。只看 `permissions.push == true` 会骗人：
      fine-grained token 即使 `push: true`，若缺 `Contents: write`
      仍然会 403（实测踩过）。

    @param token: PAT。
    @param proxy: 代理。
    @returns: `{ok, login, canWrite, ...}`。
    """
    st, user = api_call("GET", "/user", token, proxy)
    if st != 200:
        return {"ok": False, "error": f"token 无效（HTTP {st}）", "detail": user}

    login = user.get("login") if isinstance(user, dict) else "?"
    st2, repo = api_call("GET", f"/repos/{REPO}", token, proxy)
    if st2 != 200:
        return {"ok": False, "login": login,
                "error": f"访问仓库失败（HTTP {st2}）", "detail": repo}

    perms = repo.get("permissions", {}) if isinstance(repo, dict) else {}

    # 真写测试：往一个临时 ref 上打，立刻删掉。
    # 用 refs 而不是 contents —— 更贴近"推代码"这个真实动作。
    probe_ref = "refs/tags/__dsh_write_probe"
    head_st, head = api_call("GET", f"/repos/{REPO}/git/ref/heads/main", token, proxy)
    if head_st == 200 and isinstance(head, dict):
        sha = head.get("object", {}).get("sha")
        wr_st, wr = api_call("POST", f"/repos/{REPO}/git/refs", token, proxy,
                             {"ref": probe_ref, "sha": sha})
        if wr_st == 201:
            api_call("DELETE", f"/repos/{REPO}/git/refs/tags/__dsh_write_probe",
                     token, proxy)
            can_write = True
            write_detail = "写入测试通过"
        else:
            can_write = False
            write_detail = json.dumps(wr, ensure_ascii=False)[:200]
    else:
        # 仓库还没有 main 分支（空仓库）：无法做 ref 测试，退回看权限位。
        can_write = bool(perms.get("push"))
        write_detail = "仓库为空，无法做写入测试，按 permissions 判断"

    return {
        "ok": can_write,
        "login": login,
        "canWrite": can_write,
        "writeDetail": write_detail,
        "permissions": perms,
        "repoExists": True,
        "private": repo.get("private") if isinstance(repo, dict) else None,
    }


def git_push(token: str, branch: str = "main", proxy: str | None = None) -> dict:
    """推送分支。

    ★ 两个必须的 workaround（见模块头注释）：
      - `-c http.sslBackend=openssl`
      - 禁用凭据管理器，token 直接进 URL

    @param token: PAT。
    @param branch: 分支名。
    @param proxy: 代理。
    @returns: `{ok, output}`。
    """
    env = dict(os.environ)
    if proxy:
        env["HTTP_PROXY"] = proxy
        env["HTTPS_PROXY"] = proxy

    url = f"https://x-access-token:{token}@github.com/{REPO}.git"
    cmd = [
        "git",
        "-c", "http.sslBackend=openssl",
        "-c", "credential.helper=",
        "push", url, f"{branch}:{branch}",
    ]
    try:
        p = subprocess.run(cmd, cwd=str(PLUGIN_ROOT), capture_output=True,
                           text=True, timeout=300, env=env,
                           encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return {"ok": False, "output": "推送超时（300s）"}

    out = ((p.stdout or "") + (p.stderr or ""))
    # ★ 绝不能让 token 出现在日志里。
    out = out.replace(token, "***")
    return {"ok": p.returncode == 0, "output": out.strip()}


def make_release(token: str, tag: str, name: str, notes: str,
                 proxy: str | None, prerelease: bool = False) -> dict:
    """创建 GitHub Release（会自动建 tag）。

    @param token: PAT。
    @param tag: 形如 `v0.1.1`。
    @param name: Release 标题。
    @param notes: 正文（Markdown）。
    @param proxy: 代理。
    @param prerelease: 是否标为预发布。
    @returns: `{ok, url, detail}`。
    """
    st, data = api_call("POST", f"/repos/{REPO}/releases", token, proxy, {
        "tag_name": tag,
        "name": name,
        "body": notes,
        "draft": False,
        "prerelease": prerelease,
    })
    if st == 201:
        return {"ok": True, "url": data.get("html_url"), "tag": tag}
    # 已存在 → 更新而不是失败（让脚本可重复运行）。
    if st == 422 and isinstance(data, dict):
        for e in data.get("errors", []):
            if e.get("field") == "tag_name" and "already_exists" in str(e.get("code")):
                st2, rel = api_call("GET", f"/repos/{REPO}/releases/tags/{tag}",
                                    token, proxy)
                if st2 == 200:
                    rid = rel.get("id")
                    st3, upd = api_call("PATCH", f"/repos/{REPO}/releases/{rid}",
                                        token, proxy, {"name": name, "body": notes})
                    if st3 == 200:
                        return {"ok": True, "url": upd.get("html_url"),
                                "tag": tag, "updated": True}
    return {"ok": False, "detail": json.dumps(data, ensure_ascii=False)[:400]}


def next_tag(current: str) -> str:
    """由当前版本推出下一个 patch 版本号。

    @param current: 形如 `0.1.0`。
    @returns: 形如 `v0.1.1`。
    """
    m = re.match(r"^v?(\d+)\.(\d+)\.(\d+)", current.strip())
    if not m:
        return "v0.1.1"
    a, b, c = (int(x) for x in m.groups())
    return f"v{a}.{b}.{c + 1}"


def main(argv: list[str] | None = None) -> int:
    """入口。

    @param argv: 参数。
    @returns: 退出码。
    """
    ap = argparse.ArgumentParser(description="推送与发版")
    ap.add_argument("--proxy", default=os.environ.get("HTTPS_PROXY") or DEFAULT_PROXY)
    ap.add_argument("--no-proxy", action="store_true")
    ap.add_argument("--check-token", action="store_true", help="只检查 token 权限")
    ap.add_argument("--push", action="store_true", help="推送 main")
    ap.add_argument("--tag", help="要发布的 tag，如 v0.1.1")
    ap.add_argument("--notes-file", help="Release 正文文件")
    ap.add_argument("--title", help="Release 标题")
    ap.add_argument("--prerelease", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    proxy = None if args.no_proxy else args.proxy
    token = read_token()
    if not token:
        msg = {"ok": False, "error": "没有 token：请设置环境变量 GITHUB_TOKEN"}
        print(json.dumps(msg, ensure_ascii=False) if args.json else msg["error"])
        return 2

    result: dict = {}

    if args.check_token:
        result["token"] = check_token(token, proxy)

    if args.push:
        result["push"] = git_push(token, "main", proxy)

    if args.tag:
        notes = ""
        if args.notes_file:
            notes = Path(args.notes_file).read_text(encoding="utf-8")
        result["release"] = make_release(
            token, args.tag, args.title or f"DSH 适配 {args.tag}",
            notes, proxy, prerelease=args.prerelease,
        )

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if all(v.get("ok") for v in result.values()) else 1

    for key, val in result.items():
        if val.get("ok"):
            print(f"✓ {key}: 成功")
            if val.get("url"):
                print(f"    {val['url']}")
        else:
            print(f"✗ {key}: 失败")
            print(f"    {val.get('error') or val.get('detail') or val.get('output', '')[:300]}")
    return 0 if all(v.get("ok") for v in result.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
