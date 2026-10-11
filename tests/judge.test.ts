/**
 * 阶段 1 / 2 的判定用例（PLAN §8 用例 1–7、19c、23）。
 * 每个用例都从模板仓库**克隆**一份，互不污染。
 *
 * 铁律（PLAN §8 用例 0）：改完源文件**必须提交**，否则 §4.3 步骤 3 的 dirty 闸门会把结果截成
 * `warning` 且 `writable=false`。只有用例 6 / 14 / 23 保留未提交态。
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';

import { CONF_TS, KV_TS, commitAll } from '../scripts/setup-fixtures.ts';
import { parseGmd } from '../src/format.ts';
import { isRangeDirty } from '../src/gitrepo.ts';
import { judgeDoc, newJudgeCache } from '../src/judge.ts';
import { blockOf, cli, docPath, freshRepo, parseJson, readText, srcPath, writeText } from './helpers.ts';

const D = '2026-08-01T00:00:00Z';

async function judge(repo: string): Promise<unknown> {
  const res = await cli(['read', 'docs/api.gmd', '--json', '--repo', repo]);
  assert.ok(res.code === 0 || res.code === 3, `read 非预期退出码 ${res.code}: ${res.err}`);
  return parseJson(res.out);
}

test('用例 1：未被改动的块 → ok，且 currentSource 有值', async () => {
  const { repo } = await freshRepo();
  const payload = await judge(repo);
  for (const id of ['b1', 'b2', 'b3']) {
    const b = blockOf(payload, id);
    assert.equal(b.severity, 'ok', `${id} 应为 ok`);
    assert.equal(b.dirty, false);
    assert.equal(b.writable, true);
    assert.ok(typeof b.currentSource === 'string' && b.currentSource.length > 0, `${id} 应有 currentSource`);
    assert.deepEqual(b.changes, []);
  }
});

test('用例 2：只改引用范围之外的行（已提交）→ 仍为 ok', async () => {
  const { repo } = await freshRepo();
  const lines = KV_TS.split('\n');
  lines[2] = 'export type Key = string; // 用例 2：块外无关改动';
  writeText(srcPath(repo), lines.join('\n'));
  await commitAll(repo, 'case 2: 改无关处', D);

  const payload = await judge(repo);
  assert.equal(blockOf(payload, 'b1').severity, 'ok');
  assert.equal(blockOf(payload, 'b2').severity, 'ok');
  assert.equal(blockOf(payload, 'b3').severity, 'ok');
});

test('用例 3：改引用范围内一行（已提交）→ warning + changes 非空', async () => {
  const { repo } = await freshRepo();
  const lines = KV_TS.split('\n');
  lines[14] = '  return null; // 用例 3：范围内第 15 行被动过';
  writeText(srcPath(repo), lines.join('\n'));
  await commitAll(repo, 'case 3: 改范围内一行', D);

  const payload = await judge(repo);
  const b1 = blockOf(payload, 'b1');
  assert.equal(b1.severity, 'warning');
  assert.ok(b1.changes.length > 0, 'changes 应非空');
  assert.equal(b1.dirty, false);
  assert.equal(b1.writable, true);
  assert.equal(blockOf(payload, 'b2').severity, 'ok');
});

test('用例 4：删掉整个源文件（已提交）→ error，currentSource 为 null、changes 为空', async () => {
  const { repo } = await freshRepo();
  rmSync(srcPath(repo));
  await commitAll(repo, 'case 4: 删除 src/kv.ts', D);

  const payload = await judge(repo);
  for (const id of ['b1', 'b2']) {
    const b = blockOf(payload, id);
    assert.equal(b.severity, 'error');
    assert.equal(b.currentSource, null, 'error 必须刻意隐藏旧文字');
    assert.deepEqual(b.changes, []);
    assert.equal(b.writable, false);
  }
  assert.equal(blockOf(payload, 'b3').severity, 'ok', '片段级独立：b3 不受影响');
});

test('用例 5：把引用范围整段替换成无关内容（已提交）→ error（不是 warning）', async () => {
  const { repo } = await freshRepo();
  const lines = KV_TS.split('\n');
  const decoy = [
    '[server]',
    'host = example.invalid',
    'retries = 3',
    'timeout_ms = 250',
    'log_level = info',
    'max_conn = 64',
    'tls = off',
    'idle_timeout = 30',
    'region = cn-north',
    'protocol = udp',
    'batch = 128',
    'queue = fifo',
    'workers = 4',
    'cache = lru',
    'backoff = exp',
  ];
  lines.splice(9, 15, ...decoy); // 覆盖第 10–24 行（b1 的 15 行）
  assert.equal(lines.length, KV_TS.split('\n').length, '替换后总行数不变，b2 的行号才稳定');
  writeText(srcPath(repo), lines.join('\n'));
  await commitAll(repo, 'case 5: 整段替换 b1 范围', D);

  const payload = await judge(repo);
  const b1 = blockOf(payload, 'b1');
  assert.equal(b1.severity, 'error', '行集合相似度 < 0.20 ⇒ 必须判 error');
  assert.equal(b1.currentSource, null);
  assert.equal(blockOf(payload, 'b2').severity, 'ok');
});

test('用例 6：范围里有未提交修改 → warning + dirty + 禁止写回', async () => {
  const { repo } = await freshRepo();
  const lines = KV_TS.split('\n');
  lines[11] = ' * 按键取值（未提交的改动）。';
  writeText(srcPath(repo), lines.join('\n'));
  // 刻意不提交

  const b1 = blockOf(await judge(repo), 'b1');
  assert.equal(b1.severity, 'warning');
  assert.equal(b1.dirty, true);
  assert.equal(b1.writable, false);
  assert.match(b1.reason, /未提交修改/);
  assert.equal(await isRangeDirty(repo, 'src/kv.ts', [10, 24]), true, 'isRangeDirty 必须为 true');
});

test('用例 7：内容仍在但上方插入 10 行（已提交）→ warning，reason 提及行号', async () => {
  const { repo } = await freshRepo();
  const original = KV_TS.split('\n');
  const inserted = Array.from({ length: 10 }, (_, i) => `// 用例 7：上方插入的第 ${i + 1} 行`);
  writeText(srcPath(repo), [...inserted, ...original].join('\n'));
  await commitAll(repo, 'case 7: 上方插 10 行', D);

  const payload = await judge(repo);
  const b1 = blockOf(payload, 'b1');
  assert.equal(b1.severity, 'warning');
  assert.match(b1.reason, /行号/);
  assert.deepEqual(b1.changes, [], '行号漂移不是内容变更，changes 应为空');
  assert.equal(b1.currentSource, original.slice(9, 24).join('\n'), '应回显漂移后的那 15 行原文');
});

test('用例 19c：单行范围的短引用被改写（已提交）→ warning 而非 error', async () => {
  const { repo } = await freshRepo();
  const lines = CONF_TS.split('\n');
  lines[11] = '  port: 9090,';
  writeText(srcPath(repo, 'src/conf.ts'), lines.join('\n'));
  await commitAll(repo, 'case 19c: 改写单行引用', D);

  const payload = await judge(repo);
  const b3 = blockOf(payload, 'b3');
  assert.equal(b3.severity, 'warning', '单行引用改写必须走字符集合 Jaccard 判 warning');
  assert.ok(b3.currentSource !== null && b3.currentSource.includes('9090'));
  assert.equal(blockOf(payload, 'b1').severity, 'ok');
});

test('用例 23：工作区是 CRLF、HEAD 是 LF、内容语义相同 → ok，换行不构成 dirty', async () => {
  const { repo } = await freshRepo();
  writeText(srcPath(repo), KV_TS.replace(/\n/g, '\r\n')); // 只改换行字节，不提交

  const payload = await judge(repo);
  const b1 = blockOf(payload, 'b1');
  assert.equal(b1.severity, 'ok', 'CRLF 工作区 vs LF HEAD 不应被判成变化');
  assert.equal(b1.dirty, false);
  assert.equal(b1.writable, true);
  assert.equal(await isRangeDirty(repo, 'src/kv.ts', [10, 24]), false);

  const raw = readText(srcPath(repo));
  assert.ok(raw.includes('\r\n'), '确认工作区确实是 CRLF');
});

/**
 * 用例 24（P0 回归）：来源被**截断到引用范围之外**（已提交）⇒ 引用目标整段消失 ⇒ `error`。
 *
 * 修复前这里也是 error（靠 hash 不等），但**写回侧**会沿用越界的旧 range 重算 src_hash：
 * `hashRange` 对越界范围静默截断成空串哈希，下一次 read 就比较空串哈希 === 空串哈希 ⇒ **ok**。
 * 于是"引用目标早已消失"的片段被伪造成"内容未变化、可直接用"。
 */
test('用例 24：来源被截断到引用范围之外（已提交）→ error，且范围越界不得被当成内容未变化', async () => {
  const { repo } = await freshRepo();
  writeText(srcPath(repo), KV_TS.split('\n').slice(0, 9).join('\n') + '\n'); // 只剩 9 行，b1 的 [10,24] 已不存在
  await commitAll(repo, 'case 24: 截断到引用范围之外', D);

  const payload = await judge(repo);
  for (const id of ['b1', 'b2']) {
    const b = blockOf(payload, id);
    assert.equal(b.severity, 'error', `${id} 的引用范围已整段消失，必须判 error`);
    assert.equal(b.currentSource, null, 'error 必须刻意隐藏旧文字');
    assert.deepEqual(b.changes, []);
    assert.equal(b.writable, false, 'error 一律不可写回');
  }
  assert.equal(blockOf(payload, 'b3').severity, 'ok', '片段级独立：b3 的来源没被动');
});

/**
 * 用例 38（性能·可复现断言）：**多块同源只读一次** —— 判定缓存只省工作，不改结论。
 *
 * 修复前每块都要重新读工作区文件、重新 `git show HEAD:<path>`、步骤 6 再重新
 * `git show <旧 commit>:<path>` —— 都是**独立的 git 子进程**。16 块同源的文档实测 ~1.1s，
 * 而且 `read --block b1`（只关心一块）也照样跑满全篇 ⇒ AI 侧"多快好省"直接打折。
 * 这里不断言耗时（会 flaky），而是断言**读了几次**：来源文件 2 个 ⇒ 工作区/HEAD/切行各 2 次，
 * 两块共用同一个 (commit,path) ⇒ 旧 commit 只取 1 次。再断言"有无缓存逐字段一致"。
 */
test('用例 38：多块同源只读一次（判定缓存不改变结论）', async () => {
  const { repo } = await freshRepo();
  // 把 b1(10-24) 与 b2(26-40) 两个范围**都**换成无关内容（已提交）⇒ 两块都要走到步骤 6
  const lines = KV_TS.split('\n');
  const decoy = Array.from({ length: 31 }, (_, i) => `[decoy] ${i + 1}`);
  lines.splice(9, 31, ...decoy);
  writeText(srcPath(repo), lines.join('\n'));
  await commitAll(repo, 'case 38: 两块都进步骤 6', D);

  const parsed = parseGmd(readText(docPath(repo)));
  const cache = newJudgeCache();
  const cached = await judgeDoc(parsed, repo, { cache });
  assert.deepEqual(cached.map((j) => j.severity), ['error', 'error', 'ok']);
  assert.equal(cache.worktree.size, 2, '来源只有 src/kv.ts + src/conf.ts ⇒ 各读一次（3 块不重复读）');
  assert.equal(cache.head.size, 2, '`git show HEAD:` 同理');
  assert.equal(cache.lines.size, 2, '归一化后的行数组也只切一次');
  assert.equal(cache.atCommit.size, 1, 'b1/b2 共用同一个 (commit, path) ⇒ 旧 commit 只取一次');

  // 缓存只能省工作、不能改结论
  const uncached = await judgeDoc(parseGmd(readText(docPath(repo))), repo);
  assert.deepEqual(cached, uncached, '有无缓存必须逐字段一致');
});

/**
 * 用例 39：**超长单行不得把给 AI 的输出撑爆**（截断 + 如实给原始字符数）。
 *
 * 修复前：一行 300KB（minified bundle / 单行 JSON 的真实形态）会让 `read` 的冲突视图与
 * `--json` 各吐 ~900KB —— 变更点 before+after + currentSource 全是整行。既烧上下文，模型
 * 也没法用。现在只在**预览**上截断（判定与哈希仍基于原文），并给出 `*_chars` 原始长度；
 * 正常引用范围**不受影响**（下面第一条断言就是防"顺手把正常文档也截了"）。
 */
test('用例 39：超长行截断（并给原始字符数）；正常文档不出现任何截断标记', async () => {
  const { repo } = await freshRepo();
  const normal = (await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out;
  assert.doesNotMatch(normal, /_chars/, '正常引用范围不该被截断（截断只在超长时发生）');

  // 把 b1 引用范围内的一行换成 300KB 长行（已提交 ⇒ 走 warning + changes + currentSource）
  const lines = KV_TS.split('\n');
  lines[14] = 'y'.repeat(300_000);
  writeText(srcPath(repo), lines.join('\n'));
  await commitAll(repo, 'case 39: 极长单行', D);

  const view = await cli(['read', 'docs/api.gmd', '--repo', repo]);
  assert.equal(view.code, 0, view.err);
  assert.ok(view.out.length < 20_000, `人读视图必须被截断，实际 ${view.out.length} 字节`);
  assert.match(view.out, /已截断/, '必须显式说明截断');
  assert.match(view.out, /共 300000 字符/, '必须给出原始字符数');

  const payload = parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out) as {
    blocks: Array<{
      id: string;
      severity: string;
      dirty: boolean;
      changes: Array<{ after: string | null; after_chars?: number }>;
      currentSource: string | null;
      currentSource_chars?: number;
    }>;
  };
  const jsonLen = JSON.stringify(payload).length;
  assert.ok(jsonLen < 20_000, `--json 也必须被截断，实际 ${jsonLen} 字节`);

  const b1 = payload.blocks.find((b) => b.id === 'b1')!;
  assert.equal(b1.severity, 'warning', '判定本身仍基于原文：只改了一行 ⇒ warning');
  assert.equal(b1.dirty, false);
  const long = b1.changes.find((c) => c.after_chars !== undefined);
  assert.ok(long !== undefined, '超长变更点必须带上原始字符数');
  assert.equal(long.after_chars, 300_000);
  assert.ok((long.after ?? '').length < 1000, 'after 必须是截断后的预览');
  assert.ok((long.after ?? '').endsWith('…'), '截断要以省略号收尾，便于人看');
  assert.ok(b1.currentSource_chars !== undefined && b1.currentSource_chars > 300_000, 'currentSource 同样要如实给出原始长度');
  assert.ok((b1.currentSource ?? '').length < 20_000, 'currentSource 必须是截断后的预览');
});
