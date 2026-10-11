/**
 * 阶段 3（本题核心）用例：PLAN §8 用例 13–18 + 可选的 20（--allow-dirty）。
 * 覆盖「读 → 判断 → 重写 → 提交」闭环，以及四道写回闸门与原子写。
 */

import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { CONF_TS, KV_TS, commitAll } from '../scripts/setup-fixtures.ts';
import { parseGmd } from '../src/format.ts';
import { hashRange } from '../src/gitrepo.ts';
import {
  blockOf,
  cli,
  docPath,
  editBlockHead,
  freshRepo,
  git,
  outsideText,
  parseJson,
  readText,
  replaceBlockBody,
  srcPath,
  writeText,
} from './helpers.ts';

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
  const rev1Body = parseGmd(readText(docPath(repo))).blocks.find((b) => b.id === 'b1')!.text;
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
  // 活动正文必须是新正文（阶段 4·3 起，新正文还会作为 rev2 的 hist[].text 再出现一次，
  // 所以不能再用"整文件里出现几次"来断言）。
  const parsed = parseGmd(raw);
  const b1Block = parsed.blocks.find((b) => b.id === 'b1')!;
  assert.equal(b1Block.text.trim(), NEW_BODY.trim(), '活动正文必须就是新正文');
  assert.equal(b1Block.hist.length, 2, 'hist 只追加');
  assert.equal(b1Block.hist[1].text?.trim(), NEW_BODY.trim(), '新版本必须带上自己的正文');
  assert.equal(b1Block.hist[0].text, rev1Body, '旧版本的正文必须原样保留（历史只追加）');
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
  assert.match(log.out, /src_base=worktree/, '必须点明 src_hash 取自脏工作区（commit 记的是 HEAD）');
  assert.match(log.out, /rev 2/);

  const logJson = parseJson((await cli(['log', 'docs/api.gmd', '--block', 'b1', '--json', '--repo', repo])).out) as Array<
    Record<string, unknown>
  >;
  assert.equal(logJson[1].note, 'based_on_dirty', '机器可读输出必须能分辨"基于未提交来源"的版本');
  assert.equal('note' in logJson[0], false, '无 note 的版本不应凭空多出该字段（形状保持稳定）');
  assert.equal(logJson[1].src_base, 'worktree', '--allow-dirty 版本的 src_hash 基准是工作区');
  assert.equal('src_base' in logJson[0], false, '基准为缺省 commit 的版本不应凭空多出该字段');

  // 不变式：src_hash 必须等于"**它自己声明的基准**处的范围文本"的哈希
  const parsedDoc = parseGmd(readText(docPath(repo)));
  const v2 = parsedDoc.blocks.find((b) => b.id === 'b1')!.hist[1];
  assert.equal(v2.src_base, 'worktree');
  assert.equal(v2.src_hash, hashRange(readText(srcPath(repo)), v2.range), 'src_base=worktree ⇒ 对工作区文本取哈希');
  assert.notEqual(
    v2.src_hash,
    hashRange(await git(repo, ['show', 'HEAD:src/kv.ts']), v2.range),
    '正因为与 HEAD 不同源，才必须把基准写在字段里（这正是修复前的不自洽）',
  );
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

/**
 * 用例 28（阶段 4 通路）：`commit --path / --range` **重新绑定引用** ⇒ 打通 `error` 档的闭环。
 *
 * 题面 §2.4：`error`（引用目标消失/整段被重写）= "必须重写"。但阶段 1–3 的 `range` 只能沿用旧范围，
 * 旧来源已经没了 ⇒ 重写后**记不了新版本的来源**，只能拒写。`--path/--range` 让 AI 把引用改指到
 * 仍存在的来源，于是"读 → 判断 → 重写 → 写回"在 `error` 档也能走完。
 * 铁律：新版本记新 path/range，**历史版本各自的 path/range 不被改写**（历史只追加）。
 */
test('用例 28：来源被删的 error 块，用 --path/--range 重绑定到仍存在的来源 → 写回成功、回到 ok', async () => {
  const { repo } = await freshRepo();
  rmSync(srcPath(repo));
  await commitAll(repo, 'case 28: 删除 b1/b2 的来源', D);

  const before = blockOf(parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out), 'b1');
  assert.equal(before.severity, 'error', '前置：来源被删 ⇒ error');
  assert.equal(before.source.path, 'src/kv.ts');

  // src/conf.ts 第 9–13 行仍存在（defaultConfig 定义），把 b1 改指过去
  const res = await cli(
    ['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--path', 'src/conf.ts', '--range', '9..13', '--input', '-', '--json'],
    { stdin: '## 重写后的接口说明\n\n来源已改为 `src/conf.ts` 的默认配置定义。\n' },
  );
  assert.equal(res.code, 0, `重绑定后应当能写回：${res.err}`);
  const payload = parseJson(res.out) as { rev: number; range: [number, number]; path?: string };
  assert.equal(payload.rev, 2);
  assert.deepEqual(payload.range, [9, 13], '新版本记新范围');
  assert.equal(payload.path, 'src/conf.ts', '重绑定时 --json 必须给出新 path');

  const after = blockOf(parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out), 'b1');
  assert.equal(after.severity, 'ok', '重绑定后闭环回到 ok');
  assert.equal(after.rev, 2);
  assert.deepEqual(after.source.path, 'src/conf.ts');
  assert.deepEqual(after.source.range, [9, 13]);

  // 历史只追加：rev1 仍记着旧来源（不被新绑定改写）
  const hist = parseJson(
    (await cli(['log', 'docs/api.gmd', '--block', 'b1', '--json', '--repo', repo])).out,
  ) as Array<{ rev: number; path: string; range: [number, number] }>;
  assert.deepEqual(hist.map((v) => v.rev), [1, 2]);
  assert.equal(hist[0].path, 'src/kv.ts', '旧版本的来源不得被改写');
  assert.deepEqual(hist[0].range, [10, 24]);
  assert.equal(hist[1].path, 'src/conf.ts');
  assert.deepEqual(hist[1].range, [9, 13]);

  // 片段级独立：b2 没被重绑定，仍是 error
  assert.equal(blockOf(parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out), 'b2').severity, 'error');
});

/**
 * 用例 33（前向兼容）：`commit` **只重写目标片段**，且**不丢扩展字段**。
 *
 * 格式带 `gmd:1` 版本号 ⇒ 将来一定会有本工具不认识的字段。修复前 `serializeGmd` 把**每个**
 * 片段都重新渲染：① 其它块的元数据行被"规范化"（键序变化、扩展字段被抹掉），diff 变脏，
 * 与"commit 只改目标片段"的说法不符；② 连**被改的那一块**自己的扩展字段也一起丢了 ——
 * 对"版本 1 的工具读版本 2 的文件"来说，这是**静默数据丢失**，比报错更糟。
 * 现在：其它片段按原文**逐字节拷贝**，目标片段的扩展字段（块头级 + 版本级）原样合并回写。
 */
test('用例 33：commit 只重写目标片段；块头级与版本级的扩展字段都不丢', async () => {
  const { repo } = await freshRepo();
  const headLine = (text: string, id: string): string => {
    const line = text.split('\n').find((l) => l.startsWith(`<!-- gmd:block {"id":"${id}"`));
    assert.ok(line !== undefined, `找不到 ${id} 的块头`);
    return line;
  };
  const docHead = (text: string): string => {
    const line = text.split('\n').find((l) => l.startsWith('<!-- gmd:doc '));
    assert.ok(line !== undefined, '找不到文档头');
    return line;
  };

  // 造"未来版本写入的字段"：b1 块头一个、b1 的 hist[0] 一个、b2 块头一个
  const withExt = editBlockHead(
    editBlockHead(readText(docPath(repo)), 'b1', (h) => {
      h.future_block = 'keep';
      (h.hist as Array<Record<string, unknown>>)[0].future_ver = 'keep';
    }),
    'b2',
    (h) => {
      h.future_b2 = 'keep';
    },
  );
  writeText(docPath(repo), withExt);
  // 文档头也塞一个未来字段（文档头从不参与重渲染，应当天然逐字节保留）
  const withDocExt = withExt.replace('"gmd":1,', '"gmd":1,"future_doc":"keep",');
  assert.notEqual(withDocExt, withExt, '替换必须生效');
  writeText(docPath(repo), withDocExt);

  // 前置：不认识 ≠ 报错，也 ≠ 影响判定
  const before = blockOf(parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out), 'b1');
  assert.equal(before.severity, 'ok', '扩展字段不得影响判定');
  const b2HeadBefore = headLine(withDocExt, 'b2');

  await prepareWarning(repo);
  const draft = await makeDraft(repo, 'b1');
  replaceDraftBody(draft, NEW_BODY);
  assert.equal((await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--input', draft])).code, 0);

  const after = readText(docPath(repo));
  assert.equal(headLine(after, 'b2'), b2HeadBefore, '其它片段的块头必须逐字节不变（commit 只改目标片段）');
  assert.equal(docHead(after), docHead(withDocExt), '文档头也必须逐字节不变');

  const b1Head = headLine(after, 'b1');
  assert.match(b1Head, /"future_block":"keep"/, '块头级扩展字段不得被丢弃');
  assert.match(b1Head, /"future_ver":"keep"/, '版本级扩展字段不得被丢弃');
  assert.match(b1Head, /"rev":2/, '目标片段本身照常追加新版本');

  // 写回后仍然自洽可读（扩展字段不能把格式搞坏）
  const afterRead = blockOf(parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out), 'b1');
  assert.equal(afterRead.severity, 'ok');
  assert.equal(afterRead.rev, 2);
});

/**
 * 用例 29：重绑定的边界与非法参数 —— 新来源照样要过"存在性 + 位置合法 + 不脏"三道门。
 */
test('用例 29：重绑定参数非法（码 1）、新来源不存在/越界（码 4）、新来源脏（码 4）', async () => {
  const { repo } = await freshRepo();
  rmSync(srcPath(repo));
  await commitAll(repo, 'case 29: 删除 b1/b2 的来源', D);
  const NEW = '## 重写正文\n\n内容。\n';
  const commit = (extra: string[]) =>
    cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--input', '-', ...extra], { stdin: NEW });

  // 参数层（码 1）
  const badRange = await commit(['--range', '5..2']);
  assert.equal(badRange.code, 1, '--range 5..2 是参数错');
  const zeroRange = await commit(['--range', '0..3']);
  assert.equal(zeroRange.code, 1, '--range 0..3 是参数错');
  const escape = await commit(['--path', '../outside.ts']);
  assert.equal(escape.code, 1, '--path 逃出仓库是参数错');

  // 目标来源层（码 4）
  const missing = await commit(['--path', 'src/nope.ts']);
  assert.equal(missing.code, 4);
  assert.match(missing.err, /来源文件已不存在/);

  const overRange = await commit(['--path', 'src/conf.ts', '--range', '9..999']);
  assert.equal(overRange.code, 4, '新来源上越界的 range 同样必须拒写');
  assert.match(overRange.err, /已不存在/);

  // 新来源脏 ⇒ 默认拒（闸门必须落在**新**来源上，而不是旧的被删来源）
  const conf = CONF_TS.split('\n');
  conf[11] = '  port: 9090, // 未提交';
  writeText(srcPath(repo, 'src/conf.ts'), conf.join('\n'));
  const dirtyNewSource = await commit(['--path', 'src/conf.ts', '--range', '9..13']);
  assert.equal(dirtyNewSource.code, 4);
  assert.match(dirtyNewSource.err, /未提交修改/);

  // 文档必须逐字节不变（三次拒写都没有半截写入）
  assert.equal(blockOf(parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out), 'b1').rev, 1);
});

/**
 * 用例 30（回归·闸门漏洞）：**手改正文**让块本身变成 `error`，不能因此绕过脏来源闸门。
 *
 * 修复前 `commit` 用 `judgeBlock(...).dirty` 取脏标记，而该函数在"正文与元数据不一致"等
 * 步骤 0 场景会返回 `dirty = false` —— 于是"先把正文手改坏、再 commit"就能在**来源范围有未提交
 * 修改**时照样写回，违反题面"引用范围内有未提交修改时…不允许写回"。
 */
test('用例 30：手改正文（块变 error）不得绕过脏来源闸门', async () => {
  const { repo } = await freshRepo();
  const lines = KV_TS.split('\n');
  lines[14] = '  return null; // 范围内未提交改动';
  writeText(srcPath(repo), lines.join('\n')); // 未提交 ⇒ 范围脏

  const raw = readText(docPath(repo));
  // ⚠️ 只改**块正文**那一份（同一字符串也内嵌在块头 JSON 的 hist[0].text 里，见阶段 4·3）
  writeText(docPath(repo), replaceBlockBody(raw, '按键取值。键不存在时返回 `null`，**不抛异常**。', '手改的正文（没有追加版本）'));
  const broken = blockOf(parseJson((await cli(['read', 'docs/api.gmd', '--json', '--repo', repo])).out), 'b1');
  assert.equal(broken.severity, 'error', '前置：手改正文 ⇒ 步骤 0 error');
  assert.equal(broken.dirty, false, '判定引擎此时不报 dirty（正是漏洞的入口）');

  const before = readText(docPath(repo));
  const res = await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--input', '-'], {
    stdin: '## 重写正文\n\n内容。\n',
  });
  assert.equal(res.code, 4, '来源范围脏 ⇒ 即便块本身是 error 也必须拒写');
  assert.match(res.err, /未提交修改/);
  assert.equal(readText(docPath(repo)), before, '被拒时文件必须逐字节不变');
});

/**
 * 用例 31（阶段 4·3）：`read --version <rev>` **取回该版本的历史正文**。
 *
 * 题面参考接口把 `--version <id>` 列在 `read` 下、用途是"取正文与严重度"。只存 `text_hash`
 * 时这条命令只能回元信息（"那一版写了什么"答不出来）。现在每版正文随 `hist[].text` 内嵌，
 * 于是：`--json` 给 `text`（缺正文时显式 `null`）、`--plain` 只出该版正文。
 */
test('用例 31：read --version 取回历史正文（--json / --plain），且不改写旧版本', async () => {
  const { repo } = await freshRepo();
  const rev1Body = parseGmd(readText(docPath(repo))).blocks.find((b) => b.id === 'b1')!.text;
  await prepareWarning(repo);
  const draft = await makeDraft(repo, 'b1');
  replaceDraftBody(draft, NEW_BODY);
  assert.equal((await cli(['commit', 'docs/api.gmd', '--block', 'b1', '--repo', repo, '--input', draft])).code, 0);

  // rev1：正文 = 旧正文
  const v1 = parseJson(
    (await cli(['read', 'docs/api.gmd', '--block', 'b1', '--version', '1', '--json', '--repo', repo])).out,
  ) as Array<{ block: string; rev: number; text: string | null; active_severity: string; note?: string }>;
  assert.equal(v1.length, 1);
  assert.equal(v1[0].block, 'b1');
  assert.equal(v1[0].rev, 1);
  assert.equal(v1[0].text, rev1Body, '必须取回 rev1 当时写下的正文');
  assert.notEqual(v1[0].text, NEW_BODY, '不能拿活动正文冒充历史正文');
  assert.equal(v1[0].active_severity, 'ok', '严重度标注的是活动版本（rev2 已 ok）');
  assert.equal('note' in v1[0], false, '无 note 的版本不应凭空多出该字段');

  // rev2：正文 = 新正文
  const v2 = parseJson(
    (await cli(['read', 'docs/api.gmd', '--block', 'b1', '--version', '2', '--json', '--repo', repo])).out,
  ) as Array<{ text: string | null }>;
  assert.equal(v2[0].text, NEW_BODY);

  // --plain --version：只出该版正文
  const plain1 = await cli(['read', 'docs/api.gmd', '--block', 'b1', '--version', '1', '--plain', '--repo', repo]);
  assert.equal(plain1.code, 0, plain1.err);
  assert.equal(plain1.out.trim(), rev1Body.trim(), '--plain 必须只出该版正文');
  assert.doesNotMatch(plain1.out, /命中缓存/, '不能混进活动版本的正文');

  // 人读视图：给出正文与来源，并显著说明严重度是对活动版本的判断
  const view = await cli(['read', 'docs/api.gmd', '--block', 'b1', '--version', '1', '--repo', repo]);
  assert.equal(view.code, 0);
  assert.match(view.out, /该版本当时写下的正文/);
  assert.match(view.out, /当前严重度/);
});
