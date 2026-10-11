/**
 * 演示 2 —— 阶段 3（**本题核心目的**）：无人工干预闭环（PLAN §9.3）。
 *
 * 一键跑通：`node --experimental-strip-types demo/warning-loop.ts [repoDir]`
 *   读 → 判断 → 重写 → 提交，从 `warning` 起，**全程无人工干预**走完，结束后该块 `read` 为 `ok`。
 *
 * 🔴 两个硬前置（不做则闭环断掉）：
 *   1. 先 `git add -A && git commit` 把来源改动提交为**正式版本** —— 否则 §4.6.2 校验 3 的
 *      dirty 闸门会拒绝写回（退出码 4）；
 *   2. 草稿里的 `<!-- gmd:draft ... -->` 头**原样保留**，只改其下的正文；
 *      `commit` 的步骤 0 会剥离它，**写入 `.gmd` 的正文永不含草稿头**。
 *
 * 注：「AI 脚本自动执行 git commit」**不算人工干预**，只有"人手动敲命令 / 手动改文件"才算。
 * 所以本脚本自己完成 commit，正是"无人工干预闭环"的一部分。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from '../src/cli.ts';
import {
  DOC_REL,
  FIXTURE_DATE_2,
  KV_RANGE_B1,
  buildFixtureRepo,
  commitAll,
} from '../scripts/setup-fixtures.ts';

/** 默认 fixture 位置：<项目根>/fixtures/repo。 */
const DEFAULT_FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'repo');
const repoDir = path.resolve(process.argv[2] ?? DEFAULT_FIXTURE_DIR);
const kvAbs = path.join(repoDir, 'src', 'kv.ts');

let step = 0;
function banner(title: string, why: string): void {
  step++;
  process.stdout.write(
    `\n${'='.repeat(78)}\n【演示 2 · 第 ${step} 步】${title}\n  为什么这么做: ${why}\n${'='.repeat(78)}\n`,
  );
}

interface RunResult {
  code: number;
  out: string;
  err: string;
}

/** 跑一次 gmd（进程内），把 stdout / stderr 实时回显，并返回退出码与文本。 */
async function gmd(args: string[], stdin?: string): Promise<RunResult> {
  process.stdout.write(`\n$ gmd ${args.join(' ')}\n`);
  let out = '';
  let err = '';
  const code = await runCli(args, {
    cwd: repoDir,
    stdin,
    io: {
      out: (t) => {
        out += `${t}\n`;
        process.stdout.write(`${t}\n`);
      },
      err: (t) => {
        err += `${t}\n`;
        process.stderr.write(`${t}\n`);
      },
    },
  });
  return { code, out, err };
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `      | ${l}`)
    .join('\n');
}

function readBodyBetween(srcText: string, a: number, b: number): string {
  return srcText.split('\n').slice(a - 1, b).join('\n');
}

async function main(): Promise<void> {
  process.stdout.write(`演示 2：阶段 3 —— 无人工干预闭环（本题核心目的）\n目标仓库: ${repoDir}\n`);

  await buildFixtureRepo(repoDir);
  process.stdout.write('已重建 fixture 仓库（幂等：脚本自己重置，可反复运行）。\n');

  // ---- 第 0 步：把来源改动提交为正式版本 ----
  banner(
    '把来源改动提交为正式版本（硬前置）',
    '§4.6.2 校验 3：来源存在未提交修改时**默认拒绝写回**。一个真正的"AI 自动闭环"必然包含' +
      '"先把来源改动提交为正式版本"这一步，也顺带证明工具"不伪造正式版本"的立场。',
  );
  const l0 = readFileSync(kvAbs, 'utf8').split('\n');
  l0[19] = ' * 若键已存在则直接覆盖（本次改动：覆盖语义已确认）。';
  writeFileSync(kvAbs, l0.join('\n'), 'utf8');
  await commitAll(repoDir, 'step 0: 来源改动（把第 20 行改掉）', FIXTURE_DATE_2);
  process.stdout.write(`  $ git -C ${repoDir} add -A && git -C ${repoDir} commit -m "step 0"\n`);

  // ---- 第 1 步：读 → 判断（warning）----
  banner(
    '读 → 判断：当前 b1 为 warning',
    '范围还在、内容变了 ⇒ warning。工具不猜，把变更点与来源当前内容摆出来交给 AI 判断。',
  );
  await gmd(['read', DOC_REL, '--block', 'b1']);
  const j1 = await gmd(['read', DOC_REL, '--block', 'b1', '--json']);
  const before = (JSON.parse(j1.out.trim()) as { blocks: Array<{ severity: string; rev: number }> }).blocks[0];
  process.stdout.write(`\n  → 活动版本 rev=${before.rev}，severity=${before.severity}（非 error ⇒ 允许 edit）\n`);
  if (before.severity !== 'warning') throw new Error(`预期 warning，实际 ${before.severity}`);

  // ---- 第 2 步：edit 生成草稿 ----
  banner(
    'edit：生成草稿文件',
    '草稿 = `<!-- gmd:draft ... -->` 头 + 当前正文。它是唯一允许的临时产物（可删、判定从不读它），' +
      '因此不违反题面"不依赖旁车文件"（草稿不是元数据载体）。',
  );
  const editRes = await gmd(['edit', DOC_REL, '--block', 'b1', '--json']);
  const draftPath = (JSON.parse(editRes.out.trim()) as { draft_path: string }).draft_path;
  process.stdout.write(`\n  → 草稿: ${draftPath}\n  草稿内容（原样）:\n${indent(readFileSync(draftPath, 'utf8'))}\n`);

  // ---- 第 3 步：脚本按"新来源内容"重新生成正文（模拟 AI 的重写）----
  banner(
    '重写：按新的来源内容重新生成正文，写回草稿（保留草稿头）',
    '草稿头必须原样保留 —— commit 的步骤 0 会剥离它；只替换其下的正文。' +
      '新正文必须与旧正文不同，否则 §4.6.2 校验 4 会以"内容未变化"拒绝。',
  );
  const srcNow = readFileSync(kvAbs, 'utf8');
  const newSource = readBodyBetween(srcNow, KV_RANGE_B1[0], KV_RANGE_B1[1]);
  const newBody = [
    '## `set(key, value): Promise<void>`（已按新来源重写）',
    '',
    '写入键值。本次来源把引用范围内某一行改成了**覆盖写入已确认**，因此正文同步重写。',
    '',
    '```ts',
    newSource.split('\n').slice(0, 6).join('\n'),
    '```',
    '',
    '> 本段由演示 2 从「新来源内容」重新生成（模拟 AI 重写）；来源范围仍是 src/kv.ts:' +
      `${KV_RANGE_B1[0]}-${KV_RANGE_B1[1]}（阶段 1–3 不做符号级引用）。`,
  ].join('\n');

  const draftText = readFileSync(draftPath, 'utf8');
  const nl = draftText.indexOf('\n');
  const draftHead = draftText.slice(0, nl);
  writeFileSync(draftPath, `${draftHead}\n${newBody}\n`, 'utf8');
  process.stdout.write(`  已重写草稿正文（首行草稿头原样保留）。\n  新正文:\n${indent(newBody)}\n`);

  // ---- 第 4 步：commit（剥离草稿头 + 四道校验 + 原子写）----
  banner(
    'commit：剥离草稿头 → 四道校验 → 追加新版本（历史只追加）',
    '§4.6.2 步骤 0 先把草稿头剥掉（否则它会污染 .gmd 正文、且 text_hash 永远对不上）；' +
      '再依次校验：正文非空 / base_rev 匹配 / dirty 闸门 / 内容确有变化。',
  );
  const commitRes = await gmd(['commit', DOC_REL, '--block', 'b1', '--input', draftPath, '--json']);
  if (commitRes.code !== 0) throw new Error(`commit 失败，退出码 ${commitRes.code}`);

  // ---- 第 5 步：read 复验 → ok ----
  banner('read 复验：rev 已 +1 且 severity=ok', '阶段 3 完成标志：AI 无人工干预完成从 warning 到新版本写入的全过程。');
  await gmd(['read', DOC_REL, '--block', 'b1']);
  const j2 = await gmd(['read', DOC_REL, '--block', 'b1', '--json']);
  const after = (JSON.parse(j2.out.trim()) as { blocks: Array<{ severity: string; rev: number }> }).blocks[0];
  process.stdout.write(`\n  → rev ${before.rev} → ${after.rev}，severity=${after.severity}\n`);
  if (after.severity !== 'ok' || after.rev !== before.rev + 1) {
    throw new Error(`闭环失败：rev=${after.rev} severity=${after.severity}`);
  }

  // ---- 第 6 步：历史只追加 ----
  banner('证明历史只追加：hist 长度 = 2（旧版本仍在）', '题面硬约束 3：历史只追加，不覆盖、不删除。');
  await gmd(['log', DOC_REL, '--block', 'b1']);
  const histRes = await gmd(['log', DOC_REL, '--block', 'b1', '--json']);
  const hist = JSON.parse(histRes.out.trim()) as unknown[];
  process.stdout.write(`\n  → hist 长度 = ${hist.length}（旧版本仍在，新版本为 rev=${after.rev}）\n`);
  if (hist.length !== 2) throw new Error(`预期 hist 长度 2，实际 ${hist.length}`);

  process.stdout.write('\n✅ 演示 2 结束：warning → 重写 → commit → ok，全程无人工干预。\n');
}

await main();
