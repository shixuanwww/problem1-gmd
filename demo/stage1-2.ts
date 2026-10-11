/**
 * 演示 1 —— 阶段 1 + 阶段 2：读得准 + 查得到（PLAN §9.2）。
 *
 * 一键跑通：`node --experimental-strip-types demo/stage1-2.ts [repoDir]`
 *   · 脚本自己会**重建 fixture 仓库**（等价于先跑 scripts/setup-fixtures.ts），因此可反复运行；
 *   · 🔴 每一步"改源文件"之后**立刻 `git add -A && git commit`**（PLAN §8 用例 0）——
 *     否则 §4.3 步骤 3 的 dirty 闸门会把结果截成 `warning`，用例 4/5 根本不可达；
 *   · 每一步都打印「为什么」，因为题面唯一的评分门是"能被深挖细节"。
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from '../src/cli.ts';
import { runGit } from '../src/gitrepo.ts';
import {
  CONF_RANGE_B3,
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
const confAbs = path.join(repoDir, 'src', 'conf.ts');

let step = 0;
function banner(title: string, why: string): void {
  step++;
  process.stdout.write(`\n${'='.repeat(78)}\n【演示 1 · 第 ${step} 步】${title}\n  为什么这么做: ${why}\n${'='.repeat(78)}\n`);
}

async function gmd(args: string[], stdin?: string): Promise<number> {
  process.stdout.write(`\n$ gmd ${args.join(' ')}\n`);
  return await runCli(args, { cwd: repoDir, stdin });
}

function lines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n');
}
function writeLines(file: string, ls: string[]): void {
  writeFileSync(file, ls.join('\n'), 'utf8');
}

async function main(): Promise<void> {
  process.stdout.write(`演示 1：读得准（阶段 1）+ 查得到（阶段 2）\n目标仓库: ${repoDir}\n`);

  // ---- 前置：重建 fixture（幂等）----
  await buildFixtureRepo(repoDir);
  process.stdout.write(`已重建 fixture 仓库（src/kv.ts、src/conf.ts、docs/api.gmd，hist[0].commit 已实测）\n`);

  // ---- 第 1 步：ok 基准 ----
  banner(
    'ok 基准：三块都是 ok',
    '先给一个"完全没动过"的基线，确认判定引擎把「引用范围内内容未变化」判为 ok。',
  );
  await gmd(['read', DOC_REL]);

  // ---- 第 2 步：改无关处（范围之外）----
  banner(
    `改无关处：把 src/kv.ts 第 3 行改掉（不在 b1[${KV_RANGE_B1[0]}-${KV_RANGE_B1[1]}] / b2[26-40] 内），提交`,
    '题面阶段 1 完成标志 = 「只有被引用范围变化才报警，改无关处仍为 ok」。所以这里必须仍然 ok。',
  );
  const l2 = lines(kvAbs);
  l2[2] = 'export type Key = string; // 已改动（这是范围外的行）';
  writeLines(kvAbs, l2);
  await commitAll(repoDir, 'demo step 2: 改引用范围之外的一行', FIXTURE_DATE_2);
  process.stdout.write(`  $ git -C ${repoDir} add -A && git -C ${repoDir} commit -m "demo step 2"（已提交为正式版本）\n`);
  await gmd(['read', DOC_REL]);
  process.stdout.write('\n→ 预期：仍为 ok（判定只看 v.range，不看整文件）。\n');

  // ---- 第 3 步：改范围内 ----
  banner(
    `改范围内：把 src/kv.ts 第 20 行（落在 b1 的 [${KV_RANGE_B1[0]},${KV_RANGE_B1[1]}] 内）改掉，提交`,
    '范围还在、内容变了 ⇒ 题面定义为 warning（不是 error）。工具不猜，只把「变更点 + 来源当前内容」摆出来。',
  );
  const l3 = lines(kvAbs);
  l3[19] = ' * 若键已存在则直接覆盖（语义已改）。';
  writeLines(kvAbs, l3);
  await commitAll(repoDir, 'demo step 3: 改引用范围内的第 20 行', FIXTURE_DATE_2);
  process.stdout.write(`  git commit -m "demo step 3"（已提交，绕开 dirty 短路）\n`);
  await gmd(['read', DOC_REL, '--block', 'b1']);
  process.stdout.write('\n→ 预期：b1 为 warning，且给出变更点与来源当前内容。\n');

  // ---- 第 4 步：整段替换 ----
  banner(
    `整段替换：把 b1 的 [${KV_RANGE_B1[0]},${KV_RANGE_B1[1]}] 共 15 行换成完全无关内容，提交`,
    '行集合相似度应为 0 < 0.20（§4.3 步骤 6a）⇒ 判 error「引用目标已被整体重写或删除」，且**不显示旧文字**。',
  );
  const l4 = lines(kvAbs);
  const filler = Array.from({ length: 15 }, (_, i) => `// REPLACED-${i + 1}: 与原来完全无关的占位行`);
  l4.splice(KV_RANGE_B1[0] - 1, KV_RANGE_B1[1] - KV_RANGE_B1[0] + 1, ...filler);
  writeLines(kvAbs, l4);
  await commitAll(repoDir, 'demo step 4: 整段替换引用范围', FIXTURE_DATE_2);
  process.stdout.write(`  git commit -m "demo step 4"（必须提交，否则被 dirty 短路成 warning）\n`);
  await gmd(['read', DOC_REL, '--block', 'b1']);
  process.stdout.write('\n→ 预期：error，且 currentSource 为 null（题面：error 刻意隐藏旧文字）。\n');

  // ---- 第 5 步：删文件 ----
  banner(
    '删文件：rm src/kv.ts 并提交',
    '引用文件不存在 ⇒ error「引用文件不存在」（重命名也算不存在 —— 本题不做 rename 跟踪）。',
  );
  rmSync(kvAbs, { force: true });
  await commitAll(repoDir, 'demo step 5: 删除 src/kv.ts', FIXTURE_DATE_2);
  await gmd(['read', DOC_REL]);
  process.stdout.write('\n→ 预期：b1 / b2 error，b3（引用 src/conf.ts）仍 ok —— 片段级独立。\n');

  // ---- 第 6 步：追查入口 ----
  banner(
    '追查：一条命令看到来源提交历史（AI 无需自己调用 git）',
    '题面阶段 2 完成标志 = 「对一个失效引用给出原因与追查入口」。',
  );
  await gmd(['log', DOC_REL, '--block', 'b1', '--path', 'src/kv.ts']);
  await gmd(['log', DOC_REL, '--path', 'src/kv.ts']);
  await gmd(['log', DOC_REL, '--path', 'src/conf.ts', '--range', `${CONF_RANGE_B3[0]}..${CONF_RANGE_B3[1]}`]);

  // ---- 彩蛋（唯一保留未提交态）：展示 warning + dirty + writable=false ----
  banner(
    '彩蛋：把已删除的 src/kv.ts 恢复到工作区（不提交）⇒ 展示 dirty 闸门',
    '题面硬约束 5：来源存在未提交修改时判 warning 且不允许写回。' +
      '注意：HEAD（第 5 步）里已无该文件，所以从 HEAD~1 把它取回工作区却不提交 ⇒ 工作区有、HEAD 无 ⇒ 未提交。',
  );
  await runGit(repoDir, ['checkout', 'HEAD~1', '--', 'src/kv.ts']);
  process.stdout.write(`  $ git -C ${repoDir} checkout HEAD~1 -- src/kv.ts   # 取回工作区，但不提交\n`);
  await gmd(['read', DOC_REL, '--block', 'b1']);
  process.stdout.write(
    '\n→ 预期：warning + dirty=true + writable=false（对应 PLAN §8 用例 6）。\n',
  );
  process.stdout.write('\n演示 1 结束。\n');
}

await main();
