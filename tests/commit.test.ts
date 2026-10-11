/**
 * 阶段 3（本题核心）用例：PLAN §8 用例 13–18 + 可选的 20（--allow-dirty）。
 * 覆盖「读 → 判断 → 重写 → 提交」闭环，以及四道写回闸门与原子写。
 */

import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { KV_TS, commitAll } from '../scripts/setup-fixtures.ts';
import { blockOf, cli, docPath, freshRepo, outsideText, parseJson, readText, srcPath, writeText } from './helpers.ts';

const D = '2026-08-01T00:00:00Z';
const D2 = '2026-08-02T00:00:00Z';
const NEW_BODY = '## `get(key)`\n\n按键取值；命中缓存则返回副本。';

async function makeDraft(repo: string, blockId: string): Promise<string> {
  const res = await cli(['edit', 'docs/api.gmd', '--block', blockId, '--repo', repo]);
  assert.equal(res.code, 0, res.err);
  const draftPath = res.out.trim().split('\n').pop() ?? '';
  assert.ok(path.isAbsolute(draftPath), `edit 必须返回绝对路径，实际：${res.out}`);
  return draftPath;
}

function replaceDraftBody(draftPath: string, body: string): void {
  const head = readText(draftPath).split('\n')[0];
  assert.match(head, /^<!-- gmd:draft /, '草稿首行必须是 draft 头');
  writeText(draftPath, `${head}\n${body}\n`);
}

async function prepareWarning(repo: string): Promise<void> {
  const lines = KV_TS.split('\n');
  lines[14] = '  return null; // 改了范围内的第 15 行';
  writeText(srcPath(repo), lines.join('\n'));
  await commitAll(repo, 'step: 改范围内一行', D);
  const b1 = blockOf(parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out), 'b1');
  assert.equal(b1.severity, 'warning', '前置状态必须是 warning');
}

test('用例 13：edit → 重写 → commit → rev+1 追加，且旧版本仍在 hist 里', async () => {
  const { repo } = await freshRepo();
  await prepareWarning(repo);

  const draft = await makeDraft(repo, 'b1');
  assert.match(draft, /\.gmd[\\/]tmp[\\/]docs_api\.gmd-[0-9a-f]{8}-b1\.draft\.md$/, '草稿路径命名规则');
  replaceDraftBody(draft, NEW_BODY);

  const res = await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--input', draft, '--json']);
  assert.equal(res.code, 0, res.err);
  const payload = parseJson(res.out) as { rev: number; range: [number, number] };
  assert.equal(payload.rev, 2);
  assert.deepEqual(payload.range, [10, 24], 'range 沿用它记录的旧范围');

  const hist = parseJson((await cli(['log', 'docs/api.gmd', '--block', 'b1', '--json', '--repo', repo])).out) as Array<{
    rev: number;
    commit: string;
  }>;
  assert.deepEqual(hist.map((v) => v.rev), [1, 2], '历史只追加、不覆盖');
  assert.notEqual(hist[0].commit, hist[1].commit, '新版本必须记录新的来源 commit');

  const b1 = blockOf(parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out), 'b1');
  assert.equal(b1.severity, 'ok', '提交后必须回到 ok');
  assert.equal(b1.rev, 2);

  const raw = readText(docPath(repo));
  assert.doesNotMatch(raw, /gmd:draft/, '草稿头绝不能进入 .gmd 正文');
  assert.equal(raw.split('按键取值；命中缓存则返回副本。').length - 1, 1, '新正文只应出现一次');
});

test('用例 14：来源有未提交修改且未加 --allow-dirty → 拒绝（码 4），文件字节不变', async () => {
  const { repo } = await freshRepo();
  const lines = KV_TS.split('\n');
  lines[11] = ' * 按键取值（未提交）。';
  writeText(srcPath(repo), lines.join('\n'));

  const before = readText(docPath(repo));
  const res = await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--input', '-'], {
    stdin: NEW_BODY,
  });
  assert.equal(res.code, 4);
  assert.match(res.err, /未提交修改/);
  assert.equal(readText(docPath(repo)), before, '被拒时文件必须逐字节不变');
});

test('用例 15：草稿基于旧 base_rev（其间已提交过一次）→ 拒绝（码 4）', async () => {
  const { repo } = await freshRepo();
  await prepareWarning(repo);

  const draft = await makeDraft(repo, 'b1');
  replaceDraftBody(draft, NEW_BODY);
  const first = await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--input', draft]);
  assert.equal(first.code, 0, first.err);

  const second = await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--input', draft]);
  assert.equal(second.code, 4);
  assert.match(second.err, /草稿基于旧版本 rev=1，当前为 2/);
});

test('用例 18：内容与当前活动版本相同 → 拒绝（码 4）「内容未变化」', async () => {
  const { repo } = await freshRepo();
  const draft = await makeDraft(repo, 'b1'); // 草稿正文 = 当前正文，原样提交

  const res = await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--input', draft]);
  assert.equal(res.code, 4);
  assert.match(res.err, /内容未变化/);
});

test('用例 16：阶段 3 闭环 warning → edit → 重写 → commit → ok（无人工干预）', async () => {
  const { repo } = await freshRepo();
  await prepareWarning(repo);

  const draft = await makeDraft(repo, 'b1');
  replaceDraftBody(draft, NEW_BODY);
  const committed = await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--input', draft]);
  assert.equal(committed.code, 0, committed.err);

  const payload = parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out);
  const b1 = blockOf(payload, 'b1');
  assert.equal(b1.severity, 'ok');
  assert.equal(b1.rev, 2);
  assert.equal(blockOf(payload, 'b2').severity, 'ok', '其它片段不受影响');
});

test('用例 17：commit 之后块外文本逐字节未变', async () => {
  const { repo } = await freshRepo();
  await prepareWarning(repo);
  const before = outsideText(readText(docPath(repo)));

  const draft = await makeDraft(repo, 'b1');
  replaceDraftBody(draft, NEW_BODY);
  assert.equal((await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--input', draft])).code, 0);

  assert.equal(outsideText(readText(docPath(repo))), before);
});

test('用例 20（阶段 4·1）：来源 dirty + commit --allow-dirty → 写回成功并标注 based_on_dirty', async () => {
  const { repo } = await freshRepo();
  const lines = KV_TS.split('\n');
  lines[11] = ' * 按键取值（未提交，但显式允许写回）。';
  writeText(srcPath(repo), lines.join('\n'));

  const res = await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--allow-dirty', '--input', '-'], {
    stdin: NEW_BODY,
  });
  assert.equal(res.code, 0, res.err);
  assert.match(res.err, /未提交来源/, '审计输出必须显著标注');

  const log = await cli(['log', 'docs/api.gmd', '--block', 'b1', '--repo', repo]);
  assert.match(log.out, /note=based_on_dirty/);
  assert.match(log.out, /rev 2/);

  const logJson = parseJson((await cli(['log', 'docs/api.gmd', '--block', 'b1', '--json', '--repo', repo])).out) as Array<
    Record<string, unknown>
  >;
  assert.equal(logJson[1].note, 'based_on_dirty', '机器可读输出必须能分辨"基于未提交来源"的版本');
  assert.equal('note' in logJson[0], false, '无 note 的版本不应凭空多出该字段（形状保持稳定）');
});

/**
 * 回归（P0 修复）：来源文件被删除 ⇒ 该块判 `error`（题面 §2.4：必须重写），
 * 但"重写"后**记不了新版本的来源**（阶段 1–3 的 range 只能沿用旧范围），
 * 因此 `commit` 必须给出**退出码 4（写回被拒）+ 可解释理由**。
 * 修复前这里是裸 `ENOENT` → CLI 兜底成码 1「参数/用法错误」，AI 无法据码分支。
 */
test('回归：来源被删除的 error 块，commit 必须以码 4 被拒（不是 ENOENT → 码 1）', async () => {
  const { repo } = await freshRepo();
  rmSync(srcPath(repo));
  await commitAll(repo, 'case: 删除来源，制造 error', D);

  // 前置：确实是 error，原因就是"引用文件不存在"
  const before = blockOf(parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out), 'b1');
  assert.equal(before.severity, 'error');
  assert.match(before.reason, /引用文件不存在/);

  // error 档允许 edit（题面：error 时必须重写）
  const draft = await makeDraft(repo, 'b1');
  replaceDraftBody(draft, NEW_BODY);
  const raw = readText(docPath(repo));

  const res = await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--input', draft, '--json']);
  assert.equal(res.code, 4, '必须是"写回被拒"（4），不能是参数错（1）或环境错（5）');
  const payload = parseJson(res.out) as { error: string; code: number };
  assert.equal(payload.code, 4, '--json 的失败对象必须与退出码同号');
  assert.match(payload.error, /来源文件已不存在/);
  assert.equal(readText(docPath(repo)), raw, '被拒时 .gmd 必须逐字节不变');

  // 把来源恢复回去 ⇒ 同一条草稿应当顺利写入，证明刚才拒的确实只是"来源缺失"
  writeText(srcPath(repo), KV_TS);
  await commitAll(repo, 'case: 恢复来源', D2);
  const again = await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--input', draft, '--json']);
  assert.equal(again.code, 0, again.err);
  assert.equal((parseJson(again.out) as { rev: number }).rev, 2, '来源恢复后闭环应当走完');
});

test('写回是原子写：临时文件不残留，且 commit 只改目标片段', async () => {
  const { repo } = await freshRepo();
  await prepareWarning(repo);
  const draft = await makeDraft(repo, 'b1');
  replaceDraftBody(draft, NEW_BODY);
  await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--input', draft]);

  assert.equal(existsSync(`${docPath(repo)}.tmp`), false, '.tmp 必须已被 rename 掉');

  const payload = parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out);
  assert.equal(blockOf(payload, 'b2').rev, 1, 'b2 不应被改动');
  assert.equal(blockOf(payload, 'b3').rev, 1, 'b3 不应被改动');
  await commitAll(repo, 'step: 记录 docs 变更', D2);
});

/**
 * 用例 25（P0 回归·写回闸门）：引用范围已整段消失时 **禁止写回**。
 *
 * 越界的 range 会让 `hashRange` 静默截断成空串哈希；若沿用旧 range 写回，就会产出一个
 * "引用目标已消失、却自证与当前内容一致"的版本 —— 下一次 `read` 会把它判成 `ok`，
 * 直接违反题面「引用目标消失 ⇒ error，必须重写」「绝不判为可用」。
 * 正确行为：拒写（码 4）+ 文档逐字节不变 + 仍为 error + 不凭空多出版本。
 */
test('用例 25：引用范围已不存在时 commit 必须拒写（码 4），不得把 error 洗成 ok', async () => {
  const { repo } = await freshRepo();
  writeText(srcPath(repo), KV_TS.split('\n').slice(0, 9).join('\n') + '\n');
  await commitAll(repo, 'case 25: 截断到引用范围之外', D);

  const before = blockOf(parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out), 'b1');
  assert.equal(before.severity, 'error', '前置状态必须是 error');

  const raw = readText(docPath(repo));
  const res = await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--input', '-', '--json'], {
    stdin: NEW_BODY,
  });
  assert.equal(res.code, 4, '越界 range 必须走"写回被拒"（4）');
  assert.match((parseJson(res.out) as { error: string }).error, /已不存在/);
  assert.equal(readText(docPath(repo)), raw, '被拒时 .gmd 必须逐字节不变');

  const after = blockOf(parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out), 'b1');
  assert.equal(after.severity, 'error', '关键回归：拒绝之后必须仍是 error，绝不能被洗成 ok');
  assert.equal(after.rev, 1, '不得凭空多出一个版本');
});
