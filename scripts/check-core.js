/**
 * 快速验证 guard/naming 的关键逻辑（含边界），确保后续集成前是对的。
 * 运行：node scripts/check-core.js
 * @module dsh-workspace-folders/scripts/check-core
 */

import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isInside, canonicalize } from '../src/guard.js';
import { slugify, isSafeSegment, baseFolderName, resolveSessionFolder, readBinding, findSession, writeBinding, upsertSession, otherSessions } from '../src/naming.js';

let pass = 0;
let fail = 0;
/**
 * 断言。
 * @param {string} label - 用例名。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 详情。
 */
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`[PASS] ${label}`); } else {
    fail += 1;
    console.log(`[FAIL] ${label}${detail === undefined ? '' : `\n       ${detail}`}`);
  }
}

async function main() {
  console.log('guard / naming 核心逻辑验证');
  console.log('='.repeat(60));

  // ── isInside ──────────────────────────────────────────────────
  const root = path.resolve('D:/Wasio/Workspace/2026-02-14-fix-auth');
  check('界内：自身', isInside(root, root));
  check('界内：子文件', isInside(path.join(root, 'notes/a.md'), root));
  check('界内：子目录', isInside(path.join(root, 'src'), root));
  check('出界：父目录', !isInside(path.dirname(root), root));
  check('出界：主工作区根', !isInside(path.resolve('D:/Wasio/Workspace'), root));
  check('出界：其它盘', !isInside('C:/Windows', root));
  // 关键前缀陷阱：/a/bc 不在 /a/b 内
  check('出界：前缀相似的兄弟目录', !isInside('D:/Wasio/Workspace/2026-02-14-fix-authX', root));
  check('出界：.. 穿越', !isInside(path.join(root, '..', 'other'), root));
  check('出界：.. 穿越（规范化后）', !isInside(path.join(root, 'a/../../other'), root));

  // ── canonicalize（symlink 逃逸）───────────────────────────────
  const tmp = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'wbf-'));
  const inside = path.join(tmp, 'root');
  const outside = path.join(tmp, 'outside');
  await nodeFs.mkdir(inside, { recursive: true });
  await nodeFs.mkdir(outside, { recursive: true });

  const realInside = await canonicalize(inside, nodeFs);
  const realOutside = await canonicalize(outside, nodeFs);
  check('canonicalize 保留界内判定', isInside(await canonicalize(path.join(inside, 'a.txt'), nodeFs), realInside));
  check('canonicalize 识别界外', !isInside(realOutside, realInside));

  // 真实 symlink 逃逸（Windows 需管理员或开发者模式；失败则跳过）
  let linkMade = false;
  try {
    await nodeFs.symlink(outside, path.join(inside, 'escape'), 'junction');
    linkMade = true;
  } catch { linkMade = false; }
  if (linkMade) {
    const escaped = await canonicalize(path.join(inside, 'escape'), nodeFs);
    check('symlink 逃逸被识别为界外', !isInside(escaped, realInside),
      `解析后 ${escaped}，界内 ${realInside}`);
  } else {
    console.log('[SKIP] symlink 逃逸用例（无权限创建链接）');
  }

  // ── slugify ───────────────────────────────────────────────────
  check('slug：英文', slugify('Fix Auth Bug') === 'fix-auth-bug', slugify('Fix Auth Bug'));

  // ★ 这两条曾断言「纯中文**不为空**」且「纯中文**可区分**」——
  //   那是**刻意保留 CJK** 的旧行为。用户看到
  //   `2026-09-25-你是一名-dshdeepseek-harness` 之后明确要求
  //   「改成纯英文字符」，所以现在**丢弃**非 ASCII，`slugify('重构认证')` 是空串。
  //   「可区分」的责任移到了 `baseFolderName`（空 slug → 退化为会话 id）。
  check('★★ slug：纯中文被丢弃（只留 ASCII）', slugify('重构认证') === '',
    JSON.stringify(slugify('重构认证')));
  check('★★ slug：中英混合只留英文', slugify('重构 auth 认证') === 'auth',
    JSON.stringify(slugify('重构 auth 认证')));
  check('★★ slug：输出永远是纯 ASCII', /^[\x20-\x7e]*$/.test(slugify('重构 認証 テスト αβγ')),
    JSON.stringify(slugify('重构 認証 テスト αβγ')));
  check('★ slug：emoji 被丢弃', slugify('fix 🐛 bug') === 'fix-bug', slugify('fix 🐛 bug'));

  check('slug：剥离路径分隔符', !slugify('../../etc/passwd').includes('/'), slugify('../../etc/passwd'));
  check('slug：剥离反斜杠', !slugify('..\\..\\windows').includes('\\'), slugify('..\\..\\windows'));
  check('slug：空输入为空串', slugify('   ') === '');
  check('slug：超长被截断', slugify('a'.repeat(200)).length <= 48);
  check('slug：不产生首尾连字符', !/^-|-$/.test(slugify('--hello--')));

  // ── isSafeSegment ─────────────────────────────────────────────
  check('segment：拒绝 ..', !isSafeSegment('..'));
  check('segment：拒绝 .', !isSafeSegment('.'));
  check('segment：拒绝含斜杠', !isSafeSegment('a/b'));
  check('segment：拒绝含反斜杠', !isSafeSegment('a\\b'));
  check('segment：拒绝 Windows 保留字符', !isSafeSegment('a:b'));
  check('segment：拒绝结尾点', !isSafeSegment('a.'));
  check('segment：接受正常名', isSafeSegment('2026-02-14-fix-auth'));

  // ── baseFolderName ────────────────────────────────────────────
  //
  // ★ 默认**不再加日期前缀** —— 用户对比工作区实际风格后否掉了它
  //   （`MinerU` / `PhO` / `Books` / `qq-bot` / `dsh-config` 都没日期）。
  //   `dated: true` 仍可显式打开，两条路径都要守住。
  const now = new Date(2026, 1, 14);
  check('★★ 目录名：默认**无**日期前缀',
    baseFolderName({ title: 'Fix Auth', sessionId: 'session-abc', now }) === 'fix-auth',
    baseFolderName({ title: 'Fix Auth', sessionId: 'session-abc', now }));
  check('★ 目录名：dated:true 时才加日期',
    baseFolderName({ title: 'Fix Auth', sessionId: 'session-abc', now, dated: true })
      === '2026-02-14-fix-auth',
    baseFolderName({ title: 'Fix Auth', sessionId: 'session-abc', now, dated: true }));
  check('★ 目录名：无标题时退化为 id',
    baseFolderName({ title: '', sessionId: 'session-abc123', now }) === 'abc123',
    baseFolderName({ title: '', sessionId: 'session-abc123', now }));
  check('★ 目录名：中文标题退化为 id（非空）',
    baseFolderName({ title: '重构认证', sessionId: 'session-abcd1234', now }).length > 0,
    baseFolderName({ title: '重构认证', sessionId: 'session-abcd1234', now }));

  // ── resolveSessionFolder（幂等 + 去重）────────────────────────
  const wsRoot = path.join(tmp, 'ws');
  await nodeFs.mkdir(wsRoot, { recursive: true });

  const first = await resolveSessionFolder({ parentDir: wsRoot, sessionId: 's1', title: 'Fix Auth', now });
  check('创建：首次为 created', first.created === true);
  check('创建：目录真实存在',
    (await nodeFs.stat(first.dir).catch(() => undefined))?.isDirectory() === true);
  check('创建：绑定文件写入',
    (await readBinding(first.dir))?.sessions?.[0]?.id === 's1',
    JSON.stringify(await readBinding(first.dir)));

  const again = await resolveSessionFolder({ parentDir: wsRoot, sessionId: 's1', title: 'Fix Auth', now });
  check('幂等：同会话重复调用得到同一目录', again.dir === first.dir, `${first.dir} vs ${again.dir}`);
  check('幂等：不重复创建', again.created === false);

  const other = await resolveSessionFolder({ parentDir: wsRoot, sessionId: 's2', title: 'Fix Auth', now });
  check('去重：同名不同会话不踩踏', other.dir !== first.dir, `${first.dir} vs ${other.dir}`);
  check('去重：占用者绑定未被覆盖',
    findSession(await readBinding(first.dir), 's1') !== undefined,
    JSON.stringify(await readBinding(first.dir)));

  // `existing` 是登记表**显式指定**的目录，必须复用 —— 即使里面已经
  // 住着别的会话。这正是 ④⑤ 的场景：新对话要**加入**已有文件夹。
  //
  // 回归：曾经这里要求「绑定里已有本会话」才复用，导致新会话被迫
  // 新建 `-2` 兄弟目录，继承功能整体失效。
  const viaExisting = await resolveSessionFolder({
    parentDir: wsRoot, sessionId: 's3', title: 'Whatever', existing: first.folder, now,
  });
  check('★ existing 指定的目录即使住着别的会话也复用（④⑤ 的前提）',
    viaExisting.dir === first.dir, `${first.dir} vs ${viaExisting.dir}`);
  check('★ 复用时不新建目录', viaExisting.created === false);

  // 但**自动命名**仍必须防止两个无关会话踩同一个名字。
  const collide = await resolveSessionFolder({
    parentDir: wsRoot, sessionId: 's4', title: 'Fix Auth', now,
  });
  check('★ 自动命名仍会为无关会话换后缀（不与已有会话踩踏）',
    collide.dir !== first.dir, `${first.dir} vs ${collide.dir}`);

  // 安全性：parentDir 不存在应报错
  let missingThrew = false;
  try {
    await resolveSessionFolder({ parentDir: path.join(tmp, 'nope'), sessionId: 's4', title: 'x', now });
  } catch { missingThrew = true; }
  check('parentDir 不存在时明确报错', missingThrew);

  // ── 绑定格式：新旧兼容（④⑤ 依赖这个结构）──────────────────────
  console.log('\n【绑定格式兼容】');
  {
    const legacy = path.join(tmp, 'legacy');
    await nodeFs.mkdir(legacy, { recursive: true });
    // 手写一份**旧格式**文件，模拟历史遗留的文件夹。
    await nodeFs.writeFile(
      path.join(legacy, '.dsh-session.json'),
      JSON.stringify({ sessionId: 'old-style', claimedAt: '2026-01-01T00:00:00Z' }),
      'utf8',
    );

    const read = await readBinding(legacy);
    check('★ 旧格式 {sessionId} 仍能读出', read !== undefined);
    check('★ 旧格式被归一化为 sessions 数组',
      Array.isArray(read?.sessions) && read.sessions[0]?.id === 'old-style',
      JSON.stringify(read));
    check('旧格式归一化后 state=active', read?.sessions?.[0]?.state === 'active');
    check('旧格式的 claimedAt 被保留', read?.claimedAt === '2026-01-01T00:00:00Z');

    // 再写一次 → 应升级为新格式，且不残留旧字段。
    await writeBinding(legacy, { sessions: [{ id: 'old-style', state: 'archived' }] });
    const upgraded = JSON.parse(
      await nodeFs.readFile(path.join(legacy, '.dsh-session.json'), 'utf8'),
    );
    check('★ 写回后不再有顶层 sessionId 字段', upgraded.sessionId === undefined,
      JSON.stringify(upgraded));
    check('写回后 sessions 生效', upgraded.sessions?.[0]?.state === 'archived');

    // 传旧式 {sessionId} 给 writeBinding 也应自动转新格式（防止混写）。
    await writeBinding(legacy, { sessionId: 'auto-convert' });
    const auto = JSON.parse(await nodeFs.readFile(path.join(legacy, '.dsh-session.json'), 'utf8'));
    check('★ writeBinding 收到旧式入参也会转成新格式',
      auto.sessionId === undefined && auto.sessions?.[0]?.id === 'auto-convert',
      JSON.stringify(auto));

    // 多会话结构
    const multi = upsertSession(
      upsertSession({ sessions: [{ id: 'a', state: 'active' }] }, { id: 'b', state: 'archived' }),
      { id: 'a', state: 'inherited' },
    );
    check('upsertSession 追加新会话', multi.sessions.length === 2);
    check('upsertSession 更新已存在会话', findSession(multi, 'a')?.state === 'inherited');
    check('otherSessions 排除自己',
      otherSessions(multi, 'a').length === 1 && otherSessions(multi, 'a')[0].id === 'b');
    check('findSession 对 undefined 绑定不抛错', findSession(undefined, 'x') === undefined);
    check('otherSessions 对 undefined 绑定返回空数组', otherSessions(undefined, 'x').length === 0);
  }

  // ── folderPrefix 真的生效（曾经是「声明了但没人读」的死配置）────
  console.log('\n【folderPrefix 生效】');
  {
    const now2 = new Date('2026-03-01T00:00:00Z');
    check('无前缀时就是基础名',
      baseFolderName({ title: 'Fix Auth', sessionId: 's', now: now2 }) === 'fix-auth',
      baseFolderName({ title: 'Fix Auth', sessionId: 's', now: now2 }));
    check('★ 前缀被加到最前面',
      baseFolderName({ title: 'Fix Auth', sessionId: 's', now: now2, prefix: 'proj' })
        === 'proj-fix-auth',
      baseFolderName({ title: 'Fix Auth', sessionId: 's', now: now2, prefix: 'proj' }));
    check('★ 前缀含非法字符时被净化（不会生成坏目录名）',
      isSafeSegment(baseFolderName({ title: 'x', sessionId: 's', now: now2, prefix: '../evil' })),
      baseFolderName({ title: 'x', sessionId: 's', now: now2, prefix: '../evil' }));
    check('前缀整段非法时退化为不加前缀',
      baseFolderName({ title: 'Fix Auth', sessionId: 's', now: now2, prefix: '///' })
        === 'fix-auth',
      baseFolderName({ title: 'Fix Auth', sessionId: 's', now: now2, prefix: '///' }));
    check('空前缀等同无前缀',
      baseFolderName({ title: 'Fix Auth', sessionId: 's', now: now2, prefix: '' })
        === baseFolderName({ title: 'Fix Auth', sessionId: 's', now: now2 }));
  }

  await nodeFs.rm(tmp, { recursive: true, force: true });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${pass}，失败 ${fail}`);
  if (fail > 0) process.exitCode = 1;
}

await main();
