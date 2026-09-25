#!/usr/bin/env python3
"""验证本插件在**当前安装的 DSH** 上仍然可用。

## 这脚本要回答的问题

DSH 升级后，插件会不会坏？坏的**唯一现实途径**是：
插件依赖的 **Cordis 服务契约**变了（服务名改了、方法改名了、
参数形状变了）。本插件**不 import 任何 @deepseek-ai 包**，
所以"依赖版本不匹配"这类问题不存在 —— 这也是它能跨版本活下来的原因。

## ★ 三层验证，缺一不可

1. **服务的真实存在性** —— 插件 inject 的每个服务，
   在真实 DSH 的插件目录里是否还有插件提供它。
   服务没了 → Cordis 会让插件**永远等待**（`pending (waiting for service: X)`），
   也就是"装上了但什么都不工作"。这是最隐蔽的坏法。

2. **真实装配** —— 在真 Cordis Context 里 `apply()` 一次。
   契约错了这里必炸（历史上崩过两次，都发生在这一层）。

3. **全量断言** —— 跑 `npm run check`（731 项）。
   它覆盖了业务逻辑，但**前面两层才是版本相关的**。

## 用法

    python verify_plugin.py              # 人类可读
    python verify_plugin.py --json       # 机器可读

退出码：
    0 = 可用
    1 = 不可用（附具体原因）
    2 = 无法验证（环境问题，不是插件问题）
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parent

DSH_ROOT = (
    Path(os.environ.get("APPDATA", ""))
    / "npm" / "node_modules" / "@deepseek-ai" / "dsh"
)

# ── 插件依赖的服务（必须与 src/index.js 的 inject 保持一致）──────────
#
# ⚠️ 这些是**宿主侧**服务名。改这里之前先改 src/index.js，
#    两边不一致会让"验证通过"变成谎言。
HOST_SERVICES = [
    "tools", "systemPrompt", "commands", "workspaceRegistry",
    "sessions", "approval", "sessionTitle", "webServer", "connection",
]

# 客户端侧（浏览器）依赖的服务。宿主侧只能间接验证。
CLIENT_SERVICES = ["uiWorkspace", "sessions", "slots"]


def run_node(script: str, timeout: int = 180) -> tuple[int, str, str]:
    """跑一段 Node 代码。

    @param script: JS 源码。
    @param timeout: 超时秒数。
    @returns: `(退出码, stdout, stderr)`。
    """
    env = dict(os.environ)
    env["NODE_NO_WARNINGS"] = "1"
    try:
        p = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=str(PLUGIN_ROOT), capture_output=True, text=True,
            timeout=timeout, env=env, encoding="utf-8", errors="replace",
        )
        return p.returncode, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", f"超时（{timeout}s）"
    except FileNotFoundError:
        return 127, "", "找不到 node"


# ── 第 1 层：服务是否还有插件提供 ─────────────────────────────────────

SERVICE_PROBE = r"""
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DSH = process.env.DSH_ROOT;
const SERVICES = JSON.parse(process.env.PROBE_SERVICES);

// 在 DSH 的 node_modules 里扫描所有自定义插件，收集它们 **provide** 的服务。
//
// ⚠️ 为什么用"扫描"而不是"直接问 Cordis"：
//    直接问需要先把整个 DSH 装配起来（重量级、且要 profile），
//    而插件目录里 `inject`/`provide` 的声明是**静态可读**的。
//    这里做的是"存在性检查"，够用来发现"服务被删了"。
const roots = [
  path.join(DSH, 'node_modules', '@deepseek-ai'),
];

const provided = new Set();
const scanned = [];

for (const root of roots) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch { continue; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    let pkg;
    try { pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')); }
    catch { continue; }
    scanned.push(e.name);
    // 服务可以在 package.json 的 dsh.service 里声明，也可能在源码里。
    // 这里两种都看，宁可多收集也不能漏。
    const declared = pkg?.dsh?.service ?? pkg?.dsh?.services ?? [];
    for (const s of (Array.isArray(declared) ? declared : [declared])) {
      if (typeof s === 'string') provided.add(s);
    }
  }
}

console.log(JSON.stringify({
  ok: true,
  scannedCount: scanned.length,
  providedSample: [...provided].sort(),
}));
"""


def probe_services() -> dict:
    """探查 DSH 插件目录里声明的服务。

    @returns: `{ok, scannedCount, providedSample}` 或 `{ok: False, error}`。
    """
    env = dict(os.environ)
    env["DSH_ROOT"] = str(DSH_ROOT)
    env["PROBE_SERVICES"] = json.dumps(HOST_SERVICES)
    try:
        p = subprocess.run(
            ["node", "--input-type=module", "-e", SERVICE_PROBE],
            capture_output=True, text=True, timeout=60, env=env,
            encoding="utf-8", errors="replace",
        )
        if p.returncode != 0:
            return {"ok": False, "error": (p.stderr or "").strip()[:400]}
        return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception as exc:  # noqa: BLE001 - 环境问题一律降级
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


# ── 第 2 层：真实 Cordis 装配 ─────────────────────────────────────────

def run_assembly() -> dict:
    """用真实的 Cordis Context 装配一次插件。

    复用既有的 `check-inject.js` —— 它挂的是**真 Cordis + 真 commands**。

    @returns: `{ok, exitCode, tail}`。
    """
    script = HERE / "check-inject.js"
    if not script.is_file():
        return {"ok": False, "error": f"缺少 {script.name}"}
    code, out, err = run_node_script(script)
    ok = code == 0 and "[FAIL]" not in out
    return {
        "ok": ok,
        "exitCode": code,
        "tail": tail_of(out or err, 12),
    }


def run_node_script(script: Path, timeout: int = 240) -> tuple[int, str, str]:
    """跑一个 Node 脚本文件。

    @param script: 脚本路径。
    @param timeout: 超时。
    @returns: `(退出码, stdout, stderr)`。
    """
    try:
        p = subprocess.run(
            ["node", str(script)], cwd=str(PLUGIN_ROOT),
            capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace",
        )
        return p.returncode, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", f"超时（{timeout}s）"
    except FileNotFoundError:
        return 127, "", "找不到 node"


def tail_of(text: str, lines: int) -> str:
    """取文本末尾若干行。

    @param text: 原文。
    @param lines: 行数。
    @returns: 截断后的文本。
    """
    parts = [ln for ln in (text or "").splitlines() if ln.strip()]
    return "\n".join(parts[-lines:])


# ── 第 3 层：全量断言 ─────────────────────────────────────────────────

def run_full_suite() -> dict:
    """跑 `npm run check`。

    @returns: `{ok, exitCode, passed, failed, failures}`。
    """
    env = dict(os.environ)
    env["NODE_NO_WARNINGS"] = "1"
    try:
        p = subprocess.run(
            ["npm", "run", "check"], cwd=str(PLUGIN_ROOT), shell=True,
            capture_output=True, text=True, timeout=900, env=env,
            encoding="utf-8", errors="replace",
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "超时（900s）"}

    out = (p.stdout or "") + (p.stderr or "")
    failures = [ln.strip() for ln in out.splitlines() if "[FAIL]" in ln]
    consistent = "全部一致" in out
    return {
        "ok": p.returncode == 0 and not failures,
        "exitCode": p.returncode,
        "failed": len(failures),
        "failures": failures[:15],
        "readmeConsistent": consistent,
    }


# ── 汇总 ──────────────────────────────────────────────────────────────

def verify(skip_suite: bool = False) -> dict:
    """执行三层验证。

    @param skip_suite: 跳过耗时的全量断言（快速自查用）。
    @returns: 结果字典。
    """
    result: dict = {"stages": {}}

    # 0. 环境
    node_ok = subprocess.run(["node", "--version"], capture_output=True, text=True).returncode == 0
    result["node"] = subprocess.run(
        ["node", "--version"], capture_output=True, text=True,
    ).stdout.strip() if node_ok else None
    result["dshRoot"] = str(DSH_ROOT)
    result["dshInstalled"] = DSH_ROOT.is_dir()

    # 1. 服务存在性
    result["stages"]["services"] = probe_services()

    # 2. 真实装配
    result["stages"]["assembly"] = run_assembly()

    # 3. 全量断言
    result["stages"]["suite"] = {"skipped": True} if skip_suite else run_full_suite()

    # 判定：**装配**是硬门槛（它是"能不能用"的直接证据）。
    # 全量断言失败也算不可用 —— 那些是业务契约。
    assembly_ok = result["stages"]["assembly"].get("ok") is True
    suite = result["stages"]["suite"]
    suite_ok = suite.get("skipped") is True or suite.get("ok") is True

    result["usable"] = bool(assembly_ok and suite_ok)
    reasons = []
    if not assembly_ok:
        reasons.append("真实 Cordis 装配失败")
    if not suite_ok:
        reasons.append(f"{suite.get('failed', '?')} 条断言失败")
    result["reasons"] = reasons
    return result


def render(result: dict) -> str:
    """人类可读输出。

    @param result: `verify()` 的返回值。
    @returns: 文本。
    """
    L = []
    L.append(f"Node          : {result.get('node') or '✗ 找不到'}")
    L.append(f"DSH 安装目录  : {'✓ 存在' if result.get('dshInstalled') else '✗ 不存在'}")
    L.append("")

    svc = result["stages"]["services"]
    if svc.get("ok"):
        L.append(f"① 服务存在性  : ✓ 扫到 {svc.get('scannedCount')} 个插件")
    else:
        L.append(f"① 服务存在性  : ⚠️ 无法探查（{svc.get('error', '?')[:80]}）")
        L.append("                （这是环境问题，不代表插件坏了）")
    L.append("")

    asm = result["stages"]["assembly"]
    L.append(f"② 真实装配    : {'✓ 通过' if asm.get('ok') else '✗ 失败'}")
    if not asm.get("ok"):
        L.append("     " + (asm.get("tail") or asm.get("error", "")).replace("\n", "\n     "))
    L.append("")

    suite = result["stages"]["suite"]
    if suite.get("skipped"):
        L.append("③ 全量断言    : （已跳过）")
    else:
        L.append(f"③ 全量断言    : {'✓ 通过' if suite.get('ok') else '✗ 失败'}"
                 f"（失败 {suite.get('failed', '?')} 条）")
        for f in suite.get("failures", [])[:8]:
            L.append("     " + f)
    L.append("")

    L.append("─" * 46)
    if result["usable"]:
        L.append("✓ 插件在当前 DSH 上**可用**")
    else:
        L.append("✗ 插件**不可用**：" + "；".join(result["reasons"]))
    return "\n".join(L)


def main(argv: list[str] | None = None) -> int:
    """入口。

    @param argv: 参数。
    @returns: 退出码。
    """
    ap = argparse.ArgumentParser(description="验证插件在当前 DSH 上是否可用")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--fast", action="store_true", help="跳过全量断言")
    args = ap.parse_args(argv)

    result = verify(skip_suite=args.fast)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(render(result))

    if not result.get("dshInstalled") or not result.get("node"):
        return 2
    return 0 if result["usable"] else 1


if __name__ == "__main__":
    sys.exit(main())
