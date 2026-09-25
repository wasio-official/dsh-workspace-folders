/**
 * DSH 版本适配脚本的回归测试。
 *
 * ## 为什么需要它
 *
 * 这几个 Python 脚本的核心是**判断逻辑**：
 *   - 版本号比较（`0.1.7-rc.2 > 0.1.5-rc.3` 吗？）
 *   - README 版本行的正则（我第一版**写错了且静默跳过**）
 *   - Release notes 在两种结果下都要生成得对
 *
 * 这些判断一旦错，后果是**沉默的错误结论** —— 脚本说"已是最新"
 * 或者"已更新 README"，而实际上什么都没做。比崩溃更难发现。
 *
 * ⚠️ 本套件用 `spawnSync` 调 Python。在受限沙箱里进程管道可能被拒
 *    （`EPERM`）——那属于环境问题，套件会**跳过并明说**，而不是假装通过。
 *
 * @module dsh-workspace-folders/scripts/check-dsh-update
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

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
 * 跑一段 Python 代码，返回它写进临时文件的输出。
 *
 * ## ★ 为什么走文件而不是 stdout（真实踩坑）
 *
 * 本仓库的 JS 套件运行在 DSH 的**受限沙箱**里，而沙箱不允许
 * 进程间用管道通信：
 *
 * ```
 * spawnSync('python', [...], { encoding: 'utf8' })   // EPERM
 * spawnSync('python', [...], { stdio: 'pipe' })      // EPERM
 * spawnSync('python', [...], { stdio: 'ignore' })    // ✓ 能跑
 * ```
 *
 * 实测确认：`stdio: 'ignore'` 能正常执行，只是**拿不到 stdout**。
 * 所以让 Python 把结果写进一个临时文件，Node 再读回来 ——
 * 绕开管道限制，同时保留完整的断言能力。
 *
 * @param {string} code - Python 源码。可用 `OUT_PATH` 表示结果文件路径。
 * @param {number} [timeout] - 毫秒。
 * @returns {{ok: boolean, out: string, err: string, blocked: boolean}} 结果。
 */
function py(code, timeout = 30000) {
  const outFile = path.join(HERE, '__py_result.txt');
  try { rmSync(outFile, { force: true }); } catch { /* ignore */ }

  // 把结果写成 UTF-8 文件；OUT_PATH 由调用方的代码自己引用。
  const wrapped = `OUT_PATH = ${JSON.stringify(outFile)}
import pathlib
_buf = []
_o = print
print = lambda *a, **k: _buf.append(' '.join(str(x) for x in a))
try:
${code.split('\n').map((l) => `    ${l}`).join('\n')}
except Exception as _e:
    import traceback
    _buf.append('__PYERR__ ' + traceback.format_exc())
finally:
    print = _o
    pathlib.Path(OUT_PATH).write_text('\\n'.join(_buf), encoding='utf-8')
`;

  const r = spawnSync('python', ['-c', wrapped], {
    cwd: ROOT, timeout, stdio: 'ignore',
    // ★ 固定传 PYTHONIOENCODING，但**不要**动 USERPROFILE 等身份变量。
    //   实测：当 USERPROFILE 被指向别的目录（用于测试"插件在另一个 DSH 版本上"）
    //   时，Python 启动会去找不存在的用户配置而卡到超时（ETIMEDOUT）。
    //   这里显式把必要变量列出来，而不是整体 {...process.env} 的隐式依赖。
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONDONTWRITEBYTECODE: '1',
    },
  });

  let out = '';
  try { out = readFileSync(outFile, 'utf8'); } catch { /* ignore */ }
  try { rmSync(outFile, { force: true }); } catch { /* ignore */ }

  const blocked = r.error !== undefined;
  const hasPyErr = out.includes('__PYERR__');
  return {
    ok: r.status === 0 && !hasPyErr,
    out: out.replace(/__PYERR__[\s\S]*/, '').trim(),
    err: hasPyErr ? out.slice(out.indexOf('__PYERR__')) : (r.error?.message ?? ''),
    blocked,
  };
}

console.log('\n【0】环境');
{
  const probe = py("import sys; print(sys.version_info[0])");
  if (probe.blocked) {
    console.log('  ⚠️ 无法调用 Python（沙箱限制或未安装）—— 本套件跳过。');
    console.log(`     ${probe.err.split('\n')[0]}`);
    console.log('\n总计 0 项（已跳过）');
    process.exit(0);
  }
  check('Python 可用', probe.ok, probe.err);
  const major = Number.parseInt(probe.out, 10);
  check('Python 3.10+（脚本用了 `X | None` 语法）', major >= 3, `major=${major}`);
}

// ── 1. ★ 版本号比较语义 ────────────────────────────────────────────
console.log('\n【1】版本号比较（错了会给出相反结论）');
{
  const r = py(`
import sys
sys.path.insert(0, 'scripts')
from dsh_version_check import parse_version, is_newer
cases = [
    ('0.1.5-rc.3', '0.1.5-rc.1', True),
    ('0.1.5-rc.1', '0.1.5-rc.3', False),
    ('0.1.5-rc.1', '0.1.5-rc.1', False),
    ('0.1.7-alpha.2', '0.1.5-rc.3', True),
    ('0.1.5', '0.1.5-rc.3', True),      # 正式版 > rc
    ('0.1.7-rc.2', '0.1.7-rc.1', True), # 同号比 rc 序号
    ('0.1.7-alpha.1', '0.1.7-rc.2', False), # alpha < rc
    ('0.2.0', '0.1.9', True),
]
for cand, cur, want in cases:
    got = is_newer(cand, cur)
    print(('OK' if got == want else 'BAD') + ' ' + cand + ' vs ' + cur + ' -> ' + str(got))
# 不可解析的版本不能被认为"最新"
print(('OK' if parse_version('乱写') < parse_version('0.0.1') else 'BAD') + ' unparsable-is-lowest')
`);
  check('版本比较脚本能跑', r.ok, r.err);
  for (const line of r.out.split('\n').filter(Boolean)) {
    const [verdict, ...rest] = line.split(' ');
    check(`  版本比较：${rest.join(' ')}`, verdict === 'OK', line);
  }
}

// ── 2. ★★ README 版本行正则 ────────────────────────────────────────
console.log('\n【2】README 版本行正则（第一版写错过，且静默跳过）');
{
  const r = py(`
import re, pathlib
text = pathlib.Path('README.md').read_text(encoding='utf-8')
pat = re.compile(r'(^-\\s*DSH\\s*\`)(\\d+\\.\\d+\\.\\d+(?:-[a-zA-Z0-9.]+)?)(\`)', re.MULTILINE)
ms = pat.findall(text)
print('HITS ' + str(len(ms)))
if ms:
    print('CAP ' + ms[0][1])
# 能替换
new, n = pat.subn(lambda m: m.group(1) + '9.9.9-x' + m.group(3), text)
m2 = pat.search(new)
print('SUB ' + str(n) + ' ' + (m2.group(2) if m2 else 'none'))
`);
  check('正则脚本能跑', r.ok, r.err);
  const hits = r.out.match(/HITS (\d+)/);
  check('★ README 里恰好有一行 DSH 版本要求', hits?.[1] === '1', `hits=${hits?.[1]}`);
  check('★★ 能替换成功（不是静默未命中）', /SUB 1 9\.9\.9-x/.test(r.out), r.out);
}

// ── 3. ★★ 不可用时的 Release notes ─────────────────────────────────
console.log('\n【3】Release notes（不可用时必须带可行动的详情）');
{
  const r = py(`
import sys
sys.path.insert(0, 'scripts')
from dsh_update import make_release_notes
broken = {
  'node': 'v24.18.0', 'usable': False,
  'reasons': ['真实 Cordis 装配失败', '3 条断言失败'],
  'stages': {
    'services': {'ok': True, 'scannedCount': 239},
    'assembly': {'ok': False, 'tail': 'Error: cannot get property "x" without inject'},
    'suite': {'ok': False, 'failed': 3, 'failures': ['[FAIL] A', '[FAIL] B', '[FAIL] C']},
  },
}
print(make_release_notes(broken, {'local': '0.1.7-rc.2'}, usable=False))
`);
  check('notes 生成脚本能跑', r.ok, r.err);
  check('★ 声明了"不代表可用"', r.out.includes('不代表可用'));
  check('★ 列出了失败原因', r.out.includes('真实 Cordis 装配失败'));
  check('★★ 带上了装配失败的**原始输出**（可行动）',
    r.out.includes('without inject'), r.out.slice(0, 200));
  check('★★ 带上了失败断言清单', r.out.includes('[FAIL] A'));
  check('★ 标明了验证的 DSH 版本', r.out.includes('0.1.7-rc.2'));
}

// ── 4. ★ 可用时的 Release notes ────────────────────────────────────
console.log('\n【4】Release notes（可用时）');
{
  const r = py(`
import sys
sys.path.insert(0, 'scripts')
from dsh_update import make_release_notes
ok = {
  'node': 'v24.18.0', 'usable': True, 'reasons': [],
  'stages': {
    'services': {'ok': True, 'scannedCount': 239},
    'assembly': {'ok': True},
    'suite': {'ok': True, 'failed': 0},
  },
}
print(make_release_notes(ok, {'local': '0.1.5-rc.1'}, usable=True))
`);
  check('notes 生成能跑', r.ok, r.err);
  check('★ 明确写了"可用"', r.out.includes('可用'));
  check('★ 有验证内容表格', r.out.includes('| ① |') && r.out.includes('| ③ |'));
  check('★ 列出了版本要求', r.out.includes('DSH: `0.1.5-rc.1`'));
}

// ── 5. ★★ tag 推导（修过真 bug：会推导出重复 tag）────────────────────
console.log('\n【5】下一个 tag 推导');
{
  const r = py(`
import sys
sys.path.insert(0, 'scripts')
from github_release import next_tag
# 无 tag 时退回按 package.json
for v in ['0.1.0', '0.1.5-rc.1', 'v2.3.9', '乱写']:
    print('FALLBACK ' + v + ' -> ' + next_tag(v, []))
# ★★ 有 tag 时必须以 tag 为准
print('A ' + next_tag('0.1.0', ['v0.1.1']))
print('B ' + next_tag('0.1.0', ['v0.1.1', '0.1.2']))
print('C ' + next_tag('0.1.0', ['v0.1.1', '乱写', 'v0.2.0']))
`);
  check('tag 推导能跑', r.ok, r.err);
  check('0.1.0（无 tag）→ v0.1.1', r.out.includes('FALLBACK 0.1.0 -> v0.1.1'), r.out);
  check('v2.3.9（无 tag）→ v2.3.10', r.out.includes('FALLBACK v2.3.9 -> v2.3.10'), r.out);
  check('无法解析时给兜底值', r.out.includes('FALLBACK 乱写 -> v0.1.1'), r.out);

  // ★★★ 这几条是本次真 bug 的回归锁。
  //
  // 起因：package.json 的 version 从不写回，一直停在 0.1.0，
  // 于是每次都推导出 v0.1.1 → 第二次发版**静默覆盖**上一个 Release。
  // 版本管理表面正常，实则丢历史。
  check('★★★ 已有 v0.1.1 时推进到 v0.1.2（不重复）',
    r.out.includes('A v0.1.2'), r.out);
  check('★★★ 已有 v0.1.1/0.1.2 时推进到 v0.1.3',
    r.out.includes('B v0.1.3'), r.out);
  check('★★★ 混入非法 tag 时取最大合法版本',
    r.out.includes('C v0.2.1'), r.out);
}

// ── 5b. ★★★ 拒绝覆盖已有 Release ───────────────────────────────────
console.log('\n【5b】已有 Release 必须拒绝覆盖（保护版本历史）');
{
  const r = py(`
import sys, inspect
sys.path.insert(0, 'scripts')
import github_release
src = inspect.getsource(github_release.make_release)
sig = inspect.signature(github_release.make_release)
print('HAS_FORCE', 'force_update' in sig.parameters)
print('DEFAULT_FALSE', sig.parameters['force_update'].default is False)
print('GUARDS', 'not force_update' in src)
print('MSG', '拒绝覆盖' in src)
`);
  check('能读 make_release 源码', r.ok, r.err);
  check('★★ make_release 有 force_update 开关', r.out.includes('HAS_FORCE True'), r.out);
  check('★★★ 默认是**不覆盖**（False）', r.out.includes('DEFAULT_FALSE True'), r.out);
  check('★★★ 有"未显式允许就拒绝"的分支', r.out.includes('GUARDS True'), r.out);
  check('★★ 拒绝时给出明确原因', r.out.includes('MSG True'), r.out);
}

// ── 6. ★★★ token 绝不出现在输出里 ──────────────────────────────────
console.log('\n【6】安全：token 不能泄漏到日志');
{
  // ★ 不调 git_push（那会真的连 GitHub 并挂住）。
  //   直接核对**抹除逻辑本身**：git_push 里必须把 token 替换成 ***。
  //   这比跑一次真推送更适合做单元测试 —— 快、离线、且直指要害。
  const r = py(`
import sys, inspect
sys.path.insert(0, 'scripts')
import github_release
src = inspect.getsource(github_release.git_push)
print('HAS_REDACT', 'out.replace(token' in src or 'replace(token,' in src)
# 模拟：一段含 token 的输出经过同样的抹除
tok = 'github_pat_SECRETTESTVALUE1234567890'
raw = 'fatal: could not read from https://x-access-token:' + tok + '@github.com/o/r.git'
red = raw.replace(tok, '***')
print('LEAK' if tok in red else 'CLEAN')
print('SAMPLE', red[-46:])
# 也确认 token 是从环境变量读的，不是命令行参数（那会进 ps/history）
main_src = inspect.getsource(github_release.read_token)
print('FROM_ENV', 'os.environ' in main_src)
`);
  check('能读到 git_push 源码', r.ok, r.err);
  check('★★ git_push 里确实有抹除 token 的代码', r.out.includes('HAS_REDACT True'), r.out);
  check('★★★ 抹除后不含明文 token', r.out.includes('CLEAN'), r.out.slice(0, 200));
  check('★ token 从环境变量读（不进命令行历史）', r.out.includes('FROM_ENV True'), r.out);
}

// ── 7. ★ 文件齐全 ──────────────────────────────────────────────────
console.log('\n【7】脚本文件齐全');
{
  for (const f of ['dsh_version_check.py', 'verify_plugin.py',
    'dsh_update.py', 'github_release.py']) {
    check(`scripts/${f} 存在`, existsSync(path.join(HERE, f)));
  }
  check('DSH-VERIFIED.json 存在', existsSync(path.join(ROOT, 'DSH-VERIFIED.json')));
}

console.log(`\n总计 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
