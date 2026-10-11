/**
 * CLI 层用例（PLAN §8 用例 10、11、12、19、19d + 退出码 1/5）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { test } from 'node:test';

import { commitAll, KV_TS } from '../scripts/setup-fixtures.ts';
import { blockOf, cli, docPath, freshRepo, parseJson, readText, srcPath, writeText } from './helpers.ts';

const D = '2026-08-01T00:00:00Z';

test('用例 10：log --path <src> → 直接列出来源提交历史（AI 无需自己调用 git）', async () => {
  const { repo } = await freshRepo();
  const res = await cli(['log', 'docs/api.gmd', '--path', 'src/kv.ts', '--repo', repo]);
  assert.equal(res.code, 0);
  assert.match(res.out, /step 0: 来源文件/);
  assert.match(res.out, /无需自己调用 git/);
});

test('用例 11/12：存在 error 块时 read 给出追查入口，且退出码为 3', async () => {
  const { repo } = await freshRepo();
  rmSync(srcPath(repo));
  await commitAll(repo, 'case 11: 删除来源', D);

  const res = await cli(['read', 'docs/api.gmd', '--repo', repo]);
  assert.equal(res.code, 3, '脚本必须能靠退出码分支');
  assert.match(res.out, /gmd log docs\/api\.gmd --path src\/kv\.ts/, 'error 块必须附追查入口');
  assert.match(res.out, /已刻意隐藏/);
  assert.doesNotMatch(res.out, /按键取值/, 'error 不得回显旧文字');
});

test('用例 19：--json 四类命令都是单行合法 JSON，形状与契约一致', async () => {
  const { repo } = await freshRepo();

  const readRes = await cli(['read', 'docs/api.gmd', '--json', '--repo', repo]);
  assert.equal(readRes.out.trim().split('\n').length, 1, '--json 必须是单行');
  const readPayload = parseJson(readRes.out) as { doc: { gmd: number; doc_id: string }; blocks: unknown[] };
  assert.equal(readPayload.doc.gmd, 1);
  assert.equal(readPayload.blocks.length, 3);
  const b1 = blockOf(readPayload, 'b1');
  for (const key of ['id', 'severity', 'rev', 'source', 'reason', 'dirty', 'writable', 'changes', 'currentSource']) {
    assert.ok(key in (b1 as unknown as Record<string, unknown>), `BlockJudgement 缺字段 ${key}`);
  }

  const logBlock = parseJson((await cli(['log', 'docs/api.gmd', '--block', 'b1', '--json', '--repo', repo])).out) as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(Object.keys(logBlock[0]).sort(), ['at', 'commit', 'path', 'range', 'rev', 'src_hash', 'text_hash']);

  const logPath = parseJson((await cli(['log', 'docs/api.gmd', '--path', 'src/kv.ts', '--json', '--repo', repo])).out) as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(Object.keys(logPath[0]).sort(), ['at', 'sha', 'short', 'subject']);

  const logDoc = parseJson((await cli(['log', 'docs/api.gmd', '--json', '--repo', repo])).out) as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(logDoc[0]).sort(), ['id', 'path', 'range', 'rev', 'severity']);

  const editRes = await cli(['edit', 'docs/api.gmd', '--block', 'b1', '--json', '--repo', repo]);
  const editPayload = parseJson(editRes.out) as { draft_path: string };
  assert.ok(path.isAbsolute(editPayload.draft_path), 'draft_path 必须是绝对路径');

  const commitRes = await cli(
    ['commit', 'docs/api.gmd', '--block', 'b1', '--json', '--repo', repo, '--input', '-'],
    { stdin: '## `get(key)`\n\n按键取值，命中即返回。\n' },
  );
  assert.equal(commitRes.code, 0, commitRes.err);
  const commitPayload = parseJson(commitRes.out) as Record<string, unknown>;
  assert.deepEqual(Object.keys(commitPayload).sort(), ['block', 'range', 'rev', 'text_hash']);
});

test('用例 19d：read --plain 只出正文；与 --json 互斥（退出码 1）', async () => {
  const { repo } = await freshRepo();

  const plain = await cli(['read', 'docs/api.gmd', '--plain', '--repo', repo]);
  assert.equal(plain.code, 0);
  assert.match(plain.out, /## `get\(key\): Promise<Buffer \| null>`/, '必须包含块正文');
  assert.doesNotMatch(plain.out, /严重度|\[ok\]|\[warning\]|动作/, '--plain 不得带冲突视图');

  const single = await cli(['read', 'docs/api.gmd', '--plain', '--block', 'b3', '--repo', repo]);
  assert.equal(single.code, 0);
  assert.match(single.out, /默认端口/);
  assert.doesNotMatch(single.out, /get\(key\)/, '给了 --block 就只出该块正文');

  const conflict = await cli(['read', 'docs/api.gmd', '--plain', '--json', '--repo', repo]);
  assert.equal(conflict.code, 1, '--plain 与 --json 必须互斥');
});

/**
 * 用例 34：`read --plain` 的 stdout 保持**纯正文**，但必须在 **stderr** 点明哪些片段已失效。
 *
 * 背景：`--plain` 输出的是块自身正文，而失效（`error`）的块恰好**必须重写**（题面 §2.4）。
 * 只靠退出码 3，AI 在多块文档里**不知道失效的是哪一块** —— 这正是"补丁式改一段已经不适用的文字"
 * 的入口。这里**不改 stdout 语义**（"只出正文"是题面参考接口的承诺），只把那一条缺失的信息补上。
 */
test('用例 34：read --plain 必须在 stderr 点明失效片段（stdout 仍是纯正文）', async () => {
  const { repo } = await freshRepo();
  rmSync(srcPath(repo)); // b1/b2 的来源被删 ⇒ error；b3 的来源是 src/conf.ts，仍 ok
  await commitAll(repo, 'case 34: 删除 src/kv.ts', D);

  const plain = await cli(['read', 'docs/api.gmd', '--plain', '--repo', repo]);
  assert.equal(plain.code, 3, '存在 error 块 ⇒ 退出码 3（不因 --plain 放宽）');
  assert.match(plain.out, /按键取值/, 'stdout 仍是正文');
  assert.doesNotMatch(plain.out, /失效|必须重写|\[error\]/, 'stdout 不得混进提示文字');
  assert.match(plain.err, /b1、b2|b2、b1/, 'stderr 必须点名失效的片段');
  assert.match(plain.err, /gmd edit/, '必须给出下一步命令');

  // 窄化到仍然可用的块：stdout 只有该块正文，stderr 仍提醒文档里另有失效片段
  const narrowed = await cli(['read', 'docs/api.gmd', '--block', 'b3', '--plain', '--repo', repo]);
  assert.equal(narrowed.code, 3, '退出码仍按整篇文档算');
  assert.match(narrowed.out, /默认端口/);
  assert.doesNotMatch(narrowed.out, /失效/);
  assert.match(narrowed.err, /另有 2 个片段已失效[\s\S]*b1/);
});

/**
 * 用例 35：**选项归属** —— 不属于该子命令的选项必须报错（码 1），绝不静默忽略。
 *
 * 修复前 `parseArgs` 只校验"选项名是否存在于全局表"，于是 `read --range 1..2` 会被接受并
 * **悄悄丢掉** —— AI 以为读到的只是那两行 / 只按那个范围判定，实际拿到的是整篇。
 * 对"给 AI 用的 CLI"来说，"传了却不生效"比报错危险得多。
 */
test('用例 35：不属于该子命令的选项 → 参数错（码 1），不得静默忽略', async () => {
  const { repo } = await freshRepo();
  const bad: string[][] = [
    ['read', 'docs/api.gmd', '--range', '1..2'],
    ['read', 'docs/api.gmd', '--path', 'src/kv.ts'],
    ['log', 'docs/api.gmd', '--plain'],
    ['log', 'docs/api.gmd', '--version', '1'],
    ['edit', 'docs/api.gmd', '--block', 'b1', '--allow-dirty'],
    ['commit', 'docs/api.gmd', '--block', 'b1', '--version', '1'],
  ];
  for (const argv of bad) {
    const res = await cli([...argv, '--repo', repo]);
    assert.equal(res.code, 1, `${argv.join(' ')} 应当是参数错，实际 ${res.code}`);
    assert.match(res.err, /不支持选项/, `${argv.join(' ')} 必须说清是选项不属于该子命令`);
  }

  // 各子命令自己的选项与全局选项照常工作（别把合法用法一起拦了）
  assert.equal((await cli(['read', 'docs/api.gmd', '--block', 'b1', '--plain', '--repo', repo])).code, 0);
  assert.equal((await cli(['read', 'docs/api.gmd', '--body', '--repo', repo])).code, 0, '--body 是 --plain 的别名');
  assert.equal((await cli(['log', 'docs/api.gmd', '--path', 'src/kv.ts', '--range', '1..3', '--repo', repo])).code, 0);
  assert.equal(
    (await cli(['edit', 'docs/api.gmd', '--block', 'b1', '--repo', repo])).code,
    0,
    'edit 只接受 --block（外加全局选项）',
  );
  assert.equal(
    (await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--allow-dirty', '--input', '-', '--repo', repo], { stdin: '新正文\n' }))
      .code,
    0,
  );
});

/**
 * 用例 36：**退出码一致性** —— "片段不存在"在四个子命令下都必须码 1；`--input` 指向目录也是码 1。
 *
 * 修复前 `commit --block nope` 回**码 4（写回被拒）**，而 read/log/edit 回码 1：按退出码分支的
 * 调用方会把"参数打错了"当成"来源脏 / 内容没变"去处理。`--input <目录>` 则冒泡 EISDIR 被兜底成
 * **码 5（环境错误）**，同样指错了方向。
 */
test('用例 36：片段不存在四命令同码（1）；--input 指向目录也是码 1', async () => {
  const { repo } = await freshRepo();
  const cases: string[][] = [
    ['read', 'docs/api.gmd', '--block', 'nope'],
    ['log', 'docs/api.gmd', '--block', 'nope'],
    ['edit', 'docs/api.gmd', '--block', 'nope'],
    ['commit', 'docs/api.gmd', '--block', 'nope', '--input', '-'],
  ];
  for (const argv of cases) {
    const res = await cli([...argv, '--repo', repo], { stdin: '新正文\n' });
    assert.equal(res.code, 1, `${argv[0]} 的"片段不存在"应当是参数错，实际 ${res.code}`);
    assert.match(res.err, /找不到片段/);
  }

  const dirArg = mkdtempSync(path.join(tmpdir(), 'gmd-input-dir-'));
  try {
    const res = await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--input', dirArg, '--repo', repo]);
    assert.equal(res.code, 1, `--input 指向目录必须是参数错，实际 ${res.code}`);
    assert.match(res.err, /普通文件/);
    assert.doesNotMatch(res.err, /内部错误/, '不能落进兜底的"内部错误"');
  } finally {
    rmSync(dirArg, { recursive: true, force: true });
  }
});

test('用例 19 补：日志的三种参数组合都能落地，read --version 给出该版本来源信息与历史正文', async () => {
  const { repo } = await freshRepo();

  const blockLog = await cli(['log', 'docs/api.gmd', '--block', 'b2', '--repo', repo]);
  assert.equal(blockLog.code, 0);
  assert.match(blockLog.out, /rev 1/);
  assert.match(blockLog.out, /src\/kv\.ts:26-40/);

  const summary = await cli(['log', 'docs/api.gmd', '--repo', repo]);
  assert.equal(summary.code, 0);
  assert.match(summary.out, /文档级汇总/);
  assert.match(summary.out, /b1\s+rev 1\s+ok/);

  const version = await cli(['read', 'docs/api.gmd', '--version', '1', '--repo', repo]);
  assert.equal(version.code, 0);
  assert.match(version.out, /src\/kv\.ts:10-24/);
  // 阶段 4·3 起：历史正文随 hist[].text 内嵌，--version 必须能取回它（不再是"只回元信息"）
  assert.match(version.out, /## `get\(key\): Promise<Buffer \| null>`/, '必须给出 rev1 的正文');
  assert.doesNotMatch(version.out, /历史正文不保存/);
});

test('回归：read --block <id> --json 必须只返回该块（与冲突视图口径一致）', async () => {
  const { repo } = await freshRepo();

  const json = await cli(['read', 'docs/api.gmd', '--block', 'b2', '--json', '--repo', repo]);
  assert.equal(json.code, 0);
  const payload = parseJson(json.out) as { blocks: Array<{ id: string }> };
  assert.deepEqual(payload.blocks.map((b) => b.id), ['b2'], '--json 也必须按 --block 收窄');

  const view = await cli(['read', 'docs/api.gmd', '--block', 'b2', '--repo', repo]);
  assert.match(view.out, /\[ok\] b2/);
  assert.doesNotMatch(view.out, /\[ok\] b1/, '两种输出形态的块集合必须一致');

  // 不给 --block 时仍是全量
  const all = parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out) as { blocks: unknown[] };
  assert.equal(all.blocks.length, 3);

  // 退出码仍按**整篇文档**算（§4.9）：即便只看 b1，只要文档里有 error 块就返回 3
  rmSync(srcPath(repo, 'src/conf.ts'));
  await commitAll(repo, 'case: 删除 conf.ts', D);
  const narrowed = await cli(['read', 'docs/api.gmd', '--block', 'b1', '--json', '--repo', repo]);
  assert.equal(narrowed.code, 3, '退出码不因 --block 收窄而放宽');
  const narrowedPayload = parseJson(narrowed.out) as { blocks: Array<{ id: string }> };
  assert.deepEqual(narrowedPayload.blocks.map((b) => b.id), ['b1']);
});

test('退出码：文档不存在 → 1；--repo 不是仓库 → 5', async () => {
  const { repo } = await freshRepo();

  const missingDoc = await cli(['read', 'docs/nope.gmd', '--repo', repo]);
  assert.equal(missingDoc.code, 1);

  const outside = mkdtempSync(path.join(tmpdir(), 'gmd-norepo-'));
  try {
    const notRepo = await cli(['read', 'docs/api.gmd', '--repo', outside]);
    assert.equal(notRepo.code, 5, '--repo 不是 Git 仓库 ⇒ 环境错误 5');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }

  const badFlag = await cli(['read', 'docs/api.gmd', '--repo', repo, '--nope']);
  assert.equal(badFlag.code, 1);
  assert.match(badFlag.err, /未知选项/);

  // 未提交修改下仍然能正常读到 warning（不写回时不会被闸门拦）
  const lines = KV_TS.split('\n');
  lines[11] = ' * 用例：脏工作区';
  writeText(srcPath(repo), lines.join('\n'));
  const dirty = await cli(['read', 'docs/api.gmd', '--repo', repo]);
  assert.equal(dirty.code, 0);
  assert.match(dirty.out, /\[warning\]/);
  assert.match(dirty.out, /禁止写回/);
  assert.ok(readText(docPath(repo)).length > 0);
});
