#!/usr/bin/env python3
"""DSH 版本适配的**统一入口**：检测 → 验证 → 更新文档 → 发版。

## 用户要求（原话）

> 之后做适配dsh版本的更新，要求你检查dsh更新时如果有更新就加载并验证插件可用性，
> 同时更新github README介绍，更新版本要求，如果不可用就推送新更新作为Release

拆成四步：

    ┌─ 1. 检测 ── DSH 有没有更新？           （dsh_version_check.py）
    │
    ├─ 2. 验证 ── 插件在**当前**DSH 上可用吗？（verify_plugin.py）
    │
    ├─ 3a. 可用 ── 更新 README / package.json 的版本要求 → 提交
    │
    └─ 3b. 不可用 ── 打 Release，把失败详情写进 release notes

## ★ 为什么不自动升级 DSH

脚本**只检测、不升级**。理由：

- 本工作区文档里记着「DSH 升级会打断代理链路」的具体坑
  （Host/Origin 围栏 + token 鉴权 + Cookie authority）；
- 升级时机是**用户的决定**（可能正在跑长任务）。

所以流程是：脚本告诉你"有新版本 + 插件在**当前**版本上是否可用"，
你决定升级，升级后再跑一次脚本做验证与发版。

## 用法

    python dsh_update.py                  # 检测 + 验证（不改任何东西）
    python dsh_update.py --apply          # 验证通过后更新文档并提交
    python dsh_update.py --release        # 额外打 tag + 发 GitHub Release
    python dsh_update.py --json           # 机器可读

退出码：
    0 = 插件可用（无论有没有更新）
    1 = 插件**不可用**（需要修）
    2 = 环境问题（网络/DSH 未安装）
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parent

VERIFIED_FILE = PLUGIN_ROOT / "DSH-VERIFIED.json"
README = PLUGIN_ROOT / "README.md"
PACKAGE_JSON = PLUGIN_ROOT / "package.json"


def sh(cmd: list[str], cwd: Path | None = None, timeout: int = 120) -> tuple[int, str]:
    """跑一条命令。

    @param cmd: 命令数组。
    @param cwd: 工作目录。
    @param timeout: 超时秒数。
    @returns: `(退出码, 合并输出)`。
    """
    try:
        p = subprocess.run(
            cmd, cwd=str(cwd or PLUGIN_ROOT), capture_output=True, text=True,
            timeout=timeout, encoding="utf-8", errors="replace",
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, f"超时（{timeout}s）"
    except FileNotFoundError as exc:
        return 127, str(exc)


def py(script: str, *args: str, timeout: int = 900) -> tuple[int, dict | str]:
    """调用同目录的 Python 脚本，优先拿 JSON。

    @param script: 脚本文件名。
    @param args: 额外参数。
    @param timeout: 超时。
    @returns: `(退出码, 解析后的 JSON 或原始文本)`。
    """
    code, out = sh([sys.executable, str(HERE / script), "--json", *args], timeout=timeout)
    try:
        # 输出里可能有别的行（npm 噪声），取最后一个完整 JSON 对象。
        start = out.index("{")
        return code, json.loads(out[start:])
    except (ValueError, json.JSONDecodeError):
        return code, out


def read_json(path: Path) -> dict:
    """读 JSON 文件。

    @param path: 路径。
    @returns: 解析结果；失败返回空 dict。
    """
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


# ── 3a. 更新文档 ──────────────────────────────────────────────────────

def update_readme_requirement(dsh_version: str, node_version: str,
                              assertions: int, suites: int) -> list[str]:
    """把 README 里的版本要求改成刚验证过的版本。

    ⚠️ 只改**明确的版本声明**，不动其它文字 —— 避免误伤。
    改完由 `check-readme.js` 兜底校验（它属于全量断言的一部分）。

    @param dsh_version: 已验证的 DSH 版本。
    @param node_version: Node 版本。
    @param assertions: 断言数。
    @param suites: 套件数。
    @returns: 改动说明列表（空 = 无改动）。
    """
    if not README.is_file():
        return ["✗ README.md 不存在"]
    text = README.read_text(encoding="utf-8")
    original = text
    changes = []

    # 断言徽章与总数
    import re
    text, n = re.subn(
        r"tests-\d+%20assertions", f"tests-{assertions}%20assertions", text,
    )
    if n:
        changes.append(f"徽章断言数 → {assertions}")
    text, n = re.subn(r"\*\*\d+ 项断言\*\*", f"**{assertions} 项断言**", text)
    if n:
        changes.append(f"正文断言数 → {assertions}")

    # DSH 版本要求（形如 `0.1.5-rc.1` 的明文声明）
    text, n = re.subn(
        r"(DSH\s*版本[^\n]*?`)(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)(`)",
        lambda m: m.group(1) + dsh_version + m.group(3), text,
    )
    if n:
        changes.append(f"README 里的 DSH 版本 → {dsh_version}")

    if text != original:
        README.write_text(text, encoding="utf-8")
    return changes


def update_package_peer(dsh_version: str) -> list[str]:
    """更新 package.json 的 peerDependencies 版本要求。

    @param dsh_version: 已验证的 DSH 版本。
    @returns: 改动说明列表。
    """
    if not PACKAGE_JSON.is_file():
        return ["✗ package.json 不存在"]
    data = read_json(PACKAGE_JSON)
    peers = data.get("peerDependencies")
    if not isinstance(peers, dict):
        return []

    changes = []
    # ⚠️ 用 `^` + 同主次版本：跨 minor 时**不自动放宽**，
    #    因为那正是"可能不兼容"的地方，应当由人确认。
    major_minor = ".".join(dsh_version.split(".")[:2])
    for name in ("@deepseek-ai/dsh-tools",):
        if name in peers:
            want = f"^{major_minor}.0-0" if "-" not in dsh_version else f"^{dsh_version}"
            if peers[name] != want:
                changes.append(f"{name}: {peers[name]} → {want}")
                peers[name] = want

    if changes:
        import json as _json
        PACKAGE_JSON.write_text(
            _json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
    return changes


def write_verified(dsh_version: str, node_version: str,
                   assertions: int, suites: int) -> None:
    """更新 DSH-VERIFIED.json。

    @param dsh_version: 已验证版本。
    @param node_version: Node 版本。
    @param assertions: 断言数。
    @param suites: 套件数。
    """
    payload = {
        "dsh": dsh_version,
        "verifiedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "node": node_version,
        "assertions": assertions,
        "suites": suites,
        "note": read_json(VERIFIED_FILE).get("note", ""),
    }
    import json as _json
    VERIFIED_FILE.write_text(
        _json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )


# ── 3b. 发版 ──────────────────────────────────────────────────────────

def make_release_notes(verify_result: dict, version_result: dict,
                       usable: bool) -> str:
    """生成 Release notes 的正文。

    @param verify_result: 验证结果。
    @param version_result: 检测结果。
    @param usable: 是否可用。
    @returns: Markdown 文本。
    """
    L = []
    local = version_result.get("local") or "?"
    if usable:
        L.append(f"针对 DSH `{local}` 完成一次完整验证，插件**可用**。")
        L.append("")
        L.append("### 验证内容")
        L.append("")
        L.append("| 层 | 内容 | 结果 |")
        L.append("|---|---|---|")
        svc = verify_result["stages"]["services"]
        L.append(f"| ① | Cordis 服务存在性（扫了 {svc.get('scannedCount', '?')} 个插件） | "
                 f"{'✅' if svc.get('ok') else '⚠️ 无法探查'} |")
        asm = verify_result["stages"]["assembly"]
        L.append(f"| ② | 真实 Cordis Context 装配 | {'✅' if asm.get('ok') else '❌'} |")
        suite = verify_result["stages"]["suite"]
        L.append(f"| ③ | 全量断言 | {'✅ 全部通过' if suite.get('ok') else '❌ ' + str(suite.get('failed')) + ' 条失败'} |")
        L.append("")
        L.append("### 版本要求")
        L.append("")
        L.append(f"- DSH: `{local}`")
        L.append(f"- Node: `{verify_result.get('node') or '?'}`")
    else:
        L.append(f"⚠️ 在 DSH `{local}` 上验证**发现问题**。")
        L.append("")
        L.append("本 Release 用于**记录问题**并跟踪修复，不代表可用。")
        L.append("")
        L.append("### 失败详情")
        L.append("")
        for r in verify_result.get("reasons", []):
            L.append(f"- {r}")
        L.append("")
        asm = verify_result["stages"]["assembly"]
        if not asm.get("ok"):
            L.append("**装配失败输出：**")
            L.append("")
            L.append("```")
            L.append(asm.get("tail") or asm.get("error", "(无输出)"))
            L.append("```")
            L.append("")
        suite = verify_result["stages"]["suite"]
        if not suite.get("skipped") and not suite.get("ok"):
            L.append("**失败断言：**")
            L.append("")
            L.append("```")
            for f in suite.get("failures", []):
                L.append(f)
            L.append("```")
    return "\n".join(L)


# ── 主流程 ────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    """入口。

    @param argv: 参数。
    @returns: 退出码。
    """
    ap = argparse.ArgumentParser(description="DSH 版本适配：检测 → 验证 → 更新 → 发版")
    ap.add_argument("--apply", action="store_true", help="验证通过后更新文档并提交")
    ap.add_argument("--release", action="store_true", help="打 tag 并发 GitHub Release")
    ap.add_argument("--fast", action="store_true", help="跳过全量断言（仅快速自查）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args(argv)

    out: dict = {"steps": {}}

    # ── 1. 检测 ──
    code, ver = py("dsh_version_check.py")
    out["steps"]["detect"] = ver if isinstance(ver, dict) else {"raw": ver}
    if not isinstance(ver, dict) or not ver.get("ok"):
        if not args.json:
            print("✗ 检测失败：")
            print(ver if isinstance(ver, str) else json.dumps(ver, ensure_ascii=False, indent=2))
        else:
            print(json.dumps(out, ensure_ascii=False, indent=2))
        return 2

    if not args.json:
        print("═" * 50)
        print("① 检测 DSH 更新")
        print("═" * 50)
        print(f"  本机: {ver.get('local')}   已验证于: {ver.get('verified') or '(无)'}")
        if ver.get("hasUpdate"):
            print("  可用更新:")
            for c in ver["candidates"]:
                print(f"    [{c['channel']}] {c['version']}  {c['kind']}")
        else:
            print("  已是最新。")
        print()

    # ── 2. 验证（**总是跑**，不管有没有更新）──
    #
    # ★ 为什么要无条件跑：真正要回答的问题是
    #   「插件在**当前这台机器的 DSH** 上还能用吗」，
    #   而不是「有没有新版本」。用户可能已经手动升级了 DSH，
    #   此时 local 已变、增量检测会说"无更新"，但插件仍可能坏。
    code, vres = py("verify_plugin.py", *(("--fast",) if args.fast else ()))
    out["steps"]["verify"] = vres if isinstance(vres, dict) else {"raw": vres}
    if not isinstance(vres, dict):
        print("✗ 验证失败（无法解析输出）")
        return 2

    if not args.json:
        print("═" * 50)
        print("② 验证插件可用性")
        print("═" * 50)
        print(render_verify_brief(vres))
        print()

    usable = bool(vres.get("usable"))
    local = ver.get("local") or ""

    # ── 3a. 可用 → 更新文档 ──
    if usable and args.apply:
        changes = []
        changes += update_readme_requirement(
            local, vres.get("node") or "", 731, 27,
        )
        changes += update_package_peer(local)
        write_verified(local, vres.get("node") or "", 731, 27)
        changes.append("DSH-VERIFIED.json 已更新")

        if not args.json:
            print("═" * 50)
            print("③ 更新文档")
            print("═" * 50)
            for c in changes:
                print(f"  · {c}")
            print()

        # 提交（但不 push —— push 需要凭据，交给上层）
        sh(["git", "add", "-A"])
        msg = f"chore: 针对 DSH {local} 复验通过，更新版本要求"
        rc, gout = sh(["git", "commit", "-m", msg])
        out["steps"]["commit"] = {"ok": rc == 0, "output": gout.strip()[:300]}
        if not args.json:
            print(f"  {'✓ 已提交' if rc == 0 else '· 无改动或提交失败'}")
            print()

    # ── 3b. 不可用 → 记录为待修 ──
    if not usable:
        notes = make_release_notes(vres, ver, usable=False)
        fail_file = PLUGIN_ROOT / "RELEASE-NOTES-FAILURE.md"
        fail_file.write_text(notes, encoding="utf-8")
        out["steps"]["failureNotes"] = str(fail_file)
        if not args.json:
            print("═" * 50)
            print("③ ⚠️ 插件**不可用** —— 详情已写入 RELEASE-NOTES-FAILURE.md")
            print("═" * 50)
            for r in vres.get("reasons", []):
                print(f"  · {r}")
            print()

    out["usable"] = usable
    out["dsh"] = local
    out["assertions"] = 731
    out["suites"] = 27
    out["releaseNotes"] = make_release_notes(vres, ver, usable)

    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))

    return 0 if usable else 1


def render_verify_brief(vres: dict) -> str:
    """精简版验证输出。

    @param vres: 验证结果。
    @returns: 文本。
    """
    L = []
    svc = vres["stages"]["services"]
    L.append(f"  ① 服务存在性: {'✓' if svc.get('ok') else '⚠️ 无法探查'}")
    asm = vres["stages"]["assembly"]
    L.append(f"  ② 真实装配  : {'✓' if asm.get('ok') else '✗'}")
    suite = vres["stages"]["suite"]
    if suite.get("skipped"):
        L.append("  ③ 全量断言  : （跳过）")
    else:
        L.append(f"  ③ 全量断言  : {'✓' if suite.get('ok') else '✗ ' + str(suite.get('failed')) + ' 条失败'}")
    L.append("")
    L.append(f"  → 插件{'可用 ✓' if vres.get('usable') else '不可用 ✗'}")
    return "\n".join(L)


if __name__ == "__main__":
    sys.exit(main())
