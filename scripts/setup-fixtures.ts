/**
 * 生成可复现的测试仓库（PLAN §7 / §8 用例 0 / §11）。
 *
 * 幂等机制（**必须重跑不出错、且 commit sha 一致**）：
 *   1. 第一件事是 `rm -rf <target>` 再重建 —— 绝不往旧仓库上叠提交；
 *   2. 所有 `git commit` 注入固定 GIT_AUTHOR_DATE / GIT_COMMITTER_DATE；
 *   3. 所有 git 调用都带 `-c core.autocrlf=false` ⇒ 工作区字节与 blob 字节一致（LF），
 *      fixture 与 judge 才能共享同一个 hashRange 口径。
 *
 * ⚠️ `.gmd` 里的 `src_hash` **一律由 hashRange 实测**（与判定引擎同一个函数），绝不手写。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGmd } from '../src/format.ts';
import { hashRange, textHash } from '../src/gitrepo.ts';
import type { GmdVersion } from '../src/types.ts';

/** 固定时间戳：保证 commit sha 可复现（PLAN §7 第 2 条）。 */
export const FIXTURE_DATE = '2026-07-01T09:00:00Z';
export const FIXTURE_DATE_2 = '2026-07-01T09:05:00Z';

/** 来源文件（行号与 PLAN 用例固定绑定，改动前先看 §8 用例 3/5/7/19c）。 */
export const KV_TS = [
  '// kv.ts —— 极简 KV 存储接口（docs/api.gmd 的来源）',
  '',
  'export type Key = string;',
  '',
  'export interface KVStore {',
  '  get(key: Key): Promise<Buffer | null>;',
  '  set(key: Key, value: Buffer): Promise<void>;',
  '}',
  '',
  '/**',
  ' * 按键取值。',
  ' * 键不存在时返回 null，不抛异常。',
  ' */',
  'export async function get(key: Key): Promise<Buffer | null> {',
  '  return null; // TODO: 接后端缓存',
  '}',
  '',
  '/**',
  ' * 写入键值。',
  ' * 若键已存在则直接覆盖，不校验。',
  ' */',
  'export async function set(key: Key, value: Buffer): Promise<void> {',
  '  void key; void value; // TODO',
  '}',
  '',
  '/**',
  ' * 批量写入。',
  ' * 顺序执行，任一失败即中断。',
  ' */',
  'export async function setMany(pairs: Array<[Key, Buffer]>): Promise<void> {',
  '  for (const [k, v] of pairs) {',
  '    await set(k, v);',
  '  }',
  '}',
  '',
  '/**',
  ' * 删除键。',
  ' * 返回是否真的删除了。',
  ' */',
  'export async function del(key: Key): Promise<boolean> {',
  '  void key;',
  '  return false; // TODO',
  '}',
].join('\n') + '\n';

/** b1 引用 [10,24]，b2 引用 [26,40]（都是 15 行，走 §4.3 步骤 6a） */
export const KV_RANGE_B1: [number, number] = [10, 24];
export const KV_RANGE_B2: [number, number] = [26, 40];

export const CONF_TS = [
  '// conf.ts —— 运行时配置（docs/api.gmd 片段 b3 的来源）',
  '',
  'export interface Config {',
  '  host: string;',
  '  port: number;',
  '  debug: boolean;',
  '}',
  '',
  'export const defaultConfig: Config = {',
  "  host: '127.0.0.1',",
  '  debug: false,',
  '  port: 8080,',
  '};',
].join('\n') + '\n';

/** b3 引用 [12,12]（单行短引用，走 §4.3 步骤 6b 的字符集合 Jaccard） */
export const CONF_RANGE_B3: [number, number] = [12, 12];

export const DOC_REL = 'docs/api.gmd';
export const DOC_ID = 'd7f3a1c2-5b8e-4a91-9c3d-2f6e8b0a1c44';
export const DOC_CREATED_AT = '2026-07-01T09:00:00Z';

const B1_TEXT = ['## `get(key): Promise<Buffer | null>`', '', '按键取值。键不存在时返回 `null`，**不抛异常**。'].join('\n');
const B2_TEXT = ['## `setMany(pairs): Promise<void>`', '', '批量写入，顺序执行，任一失败即中断。'].join('\n');
const B3_TEXT = ['## 默认端口', '', '`defaultConfig.port = 8080`。'].join('\n');
const TAIL = ['## 备注', '', '本节不是衍生内容，不做判定（块外的普通 Markdown 完全自由）。'].join('\n');

export interface FixtureInfo {
  repo: string;
  /** 来源文件首次提交的 sha（= 各片段 hist[0].commit）。 */
  sourceCommit: string;
  /** 文档提交的 sha（= 仓库 HEAD）。 */
  docCommit: string;
}

export interface GitFixtureOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** 固定用 `-c core.autocrlf=false` 跑 git（fixture 与测试都走它，保证字节可复现）。 */
export function gitFixture(repo: string | null, args: string[], opts: GitFixtureOptions = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const argv = repo === null ? ['-c', 'core.autocrlf=false', ...args] : ['-C', repo, '-c', 'core.autocrlf=false', ...args];
  return new Promise((resolve, reject) => {
    const child = spawn('git', argv, {
      env: { ...process.env, ...(opts.env ?? {}) },
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

async function gitOk(repo: string | null, args: string[], opts: GitFixtureOptions = {}): Promise<string> {
  const res = await gitFixture(repo, args, opts);
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败（${res.status}）：${res.stderr.trim()}`);
  }
  return res.stdout;
}

/** fixture 内的固定提交身份 + 固定时间戳，保证 sha 可复现。 */
export function commitEnv(dateIso: string): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_DATE: dateIso,
    GIT_COMMITTER_DATE: dateIso,
    GIT_AUTHOR_NAME: 'gmd fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'gmd fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
}

/** `git add -A` + 固定时间戳 commit（测试与演示里"改来源后必须提交"的统一入口）。 */
export async function commitAll(repo: string, message: string, dateIso: string = FIXTURE_DATE): Promise<string> {
  await gitOk(repo, ['add', '-A']);
  await gitOk(repo, ['commit', '-m', message], { env: commitEnv(dateIso) });
  return (await gitOk(repo, ['rev-parse', 'HEAD'])).trim();
}

/** 建一个干净的 fixture 仓库；**第一件事是删掉旧目录再重建**。 */
export async function buildFixtureRepo(targetDir: string): Promise<FixtureInfo> {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(path.join(targetDir, 'src'), { recursive: true });
  mkdirSync(path.join(targetDir, 'docs'), { recursive: true });

  await gitOk(null, ['init', '-q', '-b', 'main', targetDir]);

  writeFileSync(path.join(targetDir, 'src/kv.ts'), KV_TS, 'utf8');
  writeFileSync(path.join(targetDir, 'src/conf.ts'), CONF_TS, 'utf8');
  const sourceCommit = await commitAll(targetDir, 'step 0: 来源文件（src/kv.ts / src/conf.ts）', FIXTURE_DATE);

  const versionFor = (p: string, srcText: string, range: [number, number], text: string): GmdVersion => ({
    rev: 1,
    at: FIXTURE_DATE,
    path: p,
    range,
    commit: sourceCommit,
    src_hash: hashRange(srcText, range),
    text_hash: textHash(text),
    text, // 历史正文（阶段 4·3）：fixture 也要存，否则 `read --version 1` 取不到正文
  });

  const gmd = buildGmd(
    { gmd: 1, doc_id: DOC_ID, created_at: DOC_CREATED_AT },
    [
      { id: 'b1', hist: [versionFor('src/kv.ts', KV_TS, KV_RANGE_B1, B1_TEXT)], text: B1_TEXT },
      { id: 'b2', hist: [versionFor('src/kv.ts', KV_TS, KV_RANGE_B2, B2_TEXT)], text: B2_TEXT },
      { id: 'b3', hist: [versionFor('src/conf.ts', CONF_TS, CONF_RANGE_B3, B3_TEXT)], text: B3_TEXT },
    ],
    TAIL,
  );
  writeFileSync(path.join(targetDir, DOC_REL), gmd, 'utf8');

  const docCommit = await commitAll(targetDir, 'step 1: docs/api.gmd（片段 b1/b2/b3）', FIXTURE_DATE_2);
  return { repo: targetDir, sourceCommit, docCommit };
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

const invoked = process.argv[1];
if (invoked !== undefined && path.resolve(invoked) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.dirname(here);
  const target = process.argv[2] ?? path.join(root, 'fixtures', 'repo');
  const info = await buildFixtureRepo(target);
  process.stdout.write(
    [
      `fixture 仓库已重建: ${info.repo}`,
      `  来源提交  ${info.sourceCommit}`,
      `  文档提交  ${info.docCommit}  (HEAD)`,
      `  文档      ${DOC_REL}（片段 b1/b2/b3，src_hash 由 hashRange 实测）`,
      '',
    ].join('\n'),
  );
}
