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
