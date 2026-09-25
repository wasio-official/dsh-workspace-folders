#!/usr/bin/env python3
"""检测 DSH 是否有新版本，并给出「该验证哪个版本」的结论。

## 为什么单独一个脚本

DSH 更新后，本插件可能因为**服务契约变化**而失效（例如
`ctx.systemPrompt.section()` 的参数改名）。用户要求：

> 检查 dsh 更新时如果有更新就加载并验证插件可用性

所以整条链的第一步是**可靠地知道"有没有更新"** —— 而且要能区分
`latest` / `next` / `alpha` 三条发布通道，不能只看一个数。

## ★ 关键设计：绝不在检测阶段碰本机 DSH

本脚本**只读 npm registry**，不改本机任何文件、不装任何东西。
"要不要升级、什么时候升级"是**用户的决定**，脚本只负责报告事实。
自动升级 DSH 风险很大（本工作区文档里记过升级打断代理链路的坑），
所以这里刻意不做。

## 用法

    python dsh_version_check.py            # 人类可读输出
    python dsh_version_check.py --json     # 机器可读，供别的脚本消费

退出码：
    0 = 有更新可用
    1 = 已是最新
    2 = 检测失败（网络/代理问题）
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

# ── 常量 ──────────────────────────────────────────────────────────────

PACKAGE = "@deepseek-ai/dsh"
REGISTRY = "https://registry.npmjs.org"

# DSH 装在哪：全局 npm 的 node_modules 下。
# ⚠️ 不写死用户名 —— 用 %APPDATA% 推导，换台机器也能用。
DSH_PACKAGE_JSON = (
    Path(os.environ.get("APPDATA", ""))
    / "npm" / "node_modules" / "@deepseek-ai" / "dsh" / "package.json"
)

# 插件自己记录「上次针对哪个 DSH 版本验证过」的文件。
# 放在插件目录下，随插件一起被 git 追踪 —— 这样 GitHub 上的
# README 徽章和这个文件能对上。
VERIFIED_FILE = Path(__file__).resolve().parent.parent / "DSH-VERIFIED.json"

DEFAULT_PROXY = "http://127.0.0.1:9910"


# ── 版本号解析与比较 ──────────────────────────────────────────────────

def parse_version(text: str) -> tuple:
    """把 `0.1.5-rc.1` 解析成可比较的元组。

    语义按 semver 的**预发布**规则：`0.1.7-rc.2 > 0.1.5`，
    但 `0.1.7-alpha.1 < 0.1.7-rc.2`（alpha < beta < rc < 正式版）。

    @param text: 版本字符串。
    @returns: `(major, minor, patch, stage_rank, stage_num)`；
        正式版的 `stage_rank` 最大，所以正式版 > 任何预发布版。
    """
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z]+)\.?(\d+)?)?", text.strip())
    if m is None:
        # 解析不了就排到最后，避免"未知版本"被误判成最新。
        return (0, 0, 0, -1, 0)
    major, minor, patch = int(m.group(1)), int(m.group(2)), int(m.group(3))
    stage, num = m.group(4), m.group(5)
    if stage is None:
        # 正式版：rank 给 4（比 rc 的 3 大）。
        return (major, minor, patch, 4, 0)
    ranks = {"alpha": 1, "beta": 2, "rc": 3}
    return (major, minor, patch, ranks.get(stage.lower(), 0), int(num or 0))


def is_newer(candidate: str, current: str) -> bool:
    """candidate 是否比 current 新。

    @param candidate: 候选版本。
    @param current: 当前版本。
    @returns: 是否更新。
    """
    return parse_version(candidate) > parse_version(current)


# ── npm registry 查询 ─────────────────────────────────────────────────

def build_opener(proxy: str | None):
    """构造带代理的 urllib opener。

    @param proxy: 代理地址；None 表示直连。
    @returns: opener。
    """
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"https": proxy, "http": proxy}))
    return urllib.request.build_opener(*handlers)


def fetch_registry(proxy: str | None, timeout: int = 30) -> dict:
    """拉取 npm 上该包的元数据。

    @param proxy: 代理地址。
    @param timeout: 超时秒数。
    @returns: registry JSON。
    @throws: 网络失败时抛异常。
    """
    url = f"{REGISTRY}/{PACKAGE.replace('/', '%2f')}"
    req = urllib.request.Request(url, headers={
        "User-Agent": "dsh-workspace-folders/version-check",
        "Accept": "application/json",
    })
    with build_opener(proxy).open(req, timeout=timeout) as resp:
        return json.load(resp)


def read_local_version() -> str | None:
    """读本机装的 DSH 版本。

    @returns: 版本号；没装则 None。
    """
    if not DSH_PACKAGE_JSON.is_file():
        return None
    try:
        data = json.loads(DSH_PACKAGE_JSON.read_text(encoding="utf-8"))
        return data.get("version")
    except (OSError, json.JSONDecodeError):
        return None


def read_verified() -> dict:
    """读插件记录的「已验证 DSH 版本」。

    @returns: 形如 `{"dsh": "0.1.5-rc.1", "verifiedAt": "..."}`；
        文件不存在或损坏时返回空 dict。
    """
    if not VERIFIED_FILE.is_file():
        return {}
    try:
        return json.loads(VERIFIED_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


# ── 主流程 ────────────────────────────────────────────────────────────

def detect(proxy: str | None) -> dict:
    """执行一次检测。

    @param proxy: 代理地址。
    @returns: 结果字典（也可直接序列化成 JSON）。
    """
    local = read_local_version()
    verified = read_verified()

    try:
        data = fetch_registry(proxy)
    except (urllib.error.URLError, OSError, json.JSONDecodeError, TimeoutError) as exc:
        return {
            "ok": False,
            "reason": f"拉取 npm registry 失败：{type(exc).__name__}: {exc}",
            "hint": "GitHub/npm 直连通常不通，试试 --proxy http://127.0.0.1:9910",
            "local": local,
            "verified": verified.get("dsh"),
        }

    tags = data.get("dist-tags", {})
    versions = list(data.get("versions", {}).keys())
    latest = tags.get("latest")

    # ★ 逐个通道判断"有没有更新"，而不是只看 latest。
    #
    # 只看 latest 会漏掉真实情况：用户可能刻意跟 `next`（本例中
    # `next` = 0.1.7-rc.2，比 `latest` = 0.1.5-rc.3 还新）。
    channels = {}
    for name in ("latest", "next", "alpha"):
        v = tags.get(name)
        channels[name] = {
            "version": v,
            "newerThanLocal": bool(v and local and is_newer(v, local)),
        }

    # ★ 升级建议要保守：只有在**同一通道**里比当前新时才推荐。
    #
    # 当前是 `0.1.5-rc.1`，`next` 通道的 `0.1.7-rc.2` 虽然数字更大，
    # 但跨了大版本（0.1.5 → 0.1.7），属于"尝鲜"而不是"升级"。
    # 脚本只把它作为**选项**呈现，不替用户做决定。
    candidates = []
    if latest and local and is_newer(latest, local):
        candidates.append({"channel": "latest", "version": latest, "kind": "稳定更新"})
    for name in ("next", "alpha"):
        v = tags.get(name)
        if v and local and is_newer(v, local) and v != latest:
            candidates.append({"channel": name, "version": v, "kind": "尝鲜通道"})

    return {
        "ok": True,
        "local": local,
        "verified": verified.get("dsh"),
        "verifiedAt": verified.get("verifiedAt"),
        "tags": tags,
        "channels": channels,
        "hasUpdate": bool(candidates),
        "candidates": candidates,
        "totalVersions": len(versions),
        "publishedAt": data.get("time", {}).get(latest) if latest else None,
        # ★ 这个字段是给用户看的关键信息：插件上次针对哪个版本验证过。
        #    local != verified 就说明**本机 DSH 换了但插件还没复验**。
        "verificationStale": bool(local and verified.get("dsh") and local != verified.get("dsh")),
    }


def render(result: dict) -> str:
    """把结果渲染成人类可读文本。

    @param result: `detect()` 的返回值。
    @returns: 多行文本。
    """
    lines = []
    if not result.get("ok"):
        lines.append("✗ 检测失败")
        lines.append(f"  {result.get('reason')}")
        if result.get("hint"):
            lines.append(f"  {result.get('hint')}")
        return "\n".join(lines)

    local = result["local"] or "(未找到本机 DSH)"
    lines.append(f"本机 DSH      : {local}")
    lines.append(f"插件已验证于  : {result.get('verified') or '(无记录)'}", )
    if result.get("verificationStale"):
        lines.append("                ⚠️ 本机版本与已验证版本**不一致** —— 插件尚未复验")
    lines.append("")

    lines.append("npm 上的发布通道：")
    for name, info in result["channels"].items():
        mark = " ← 比本机新" if info["newerThanLocal"] else ""
        lines.append(f"  {name:<8} {info['version'] or '(无)':<16}{mark}")
    lines.append("")

    if result["hasUpdate"]:
        lines.append("✓ 有更新可用：")
        for c in result["candidates"]:
            lines.append(f"  [{c['channel']}] {c['version']}  （{c['kind']}）")
    else:
        lines.append("✓ 已是最新，无需处理。")

    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    """入口。

    @param argv: 参数列表。
    @returns: 退出码。
    """
    ap = argparse.ArgumentParser(description="检测 DSH 是否有新版本")
    ap.add_argument("--proxy", default=os.environ.get("HTTPS_PROXY") or DEFAULT_PROXY,
                    help="HTTP 代理（默认取 HTTPS_PROXY，否则用本地 9910）")
    ap.add_argument("--no-proxy", action="store_true", help="强制直连")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args(argv)

    proxy = None if args.no_proxy else args.proxy
    result = detect(proxy)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(render(result))

    if not result.get("ok"):
        return 2
    return 0 if result["hasUpdate"] else 1


if __name__ == "__main__":
    sys.exit(main())
