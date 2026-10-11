/**
 * 测试辅助（PLAN §8）：fixture 仓库的「模板 + 克隆」，以及 CLI 的进程内调用与输出捕获。
 *
 * 为什么不直接共用 `fixtures/repo`：用例之间会改源文件 / 删文件 / 造脏工作区，
 * 共用一份会互相污染（这正是 PLAN §8 用例 0 反复强调的坑）。每个用例克隆一份 ⇒ 互相隔离。
 *
 * 为什么不 `cpSync` .git：Windows 上 git 对象是只读属性，拷贝后容易被后续 `git commit` 拒绝；
 * `git clone` 走 git 自己的复制路径，天然没有这个问题，且 commit sha 与模板一致（固定时间戳）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildFixtureRepo, type FixtureInfo, gitFixture } from '../scripts/setup-fixtures.ts';
import { runCli, type CliIO } from '../src/cli.ts';

const TEMP_DIRS: string[] = [];
process.on('exit', () => {
  for (const dir of TEMP_DIRS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响测试结论 */
    }
  }
});

let templatePromise: Promise<FixtureInfo> | null = null;

/** 模板仓库只建一次（固定时间戳 ⇒ sha 可复现），后续用例都从它克隆。 */
export function template(): Promise<FixtureInfo> {
  if (templatePromise === null) {
    templatePromise = (async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'gmd-template-'));
      TEMP_DIRS.push(dir);
      return await buildFixtureRepo(dir);
    })();
  }
  return templatePromise;
}

export interface FreshRepo {
  repo: string;
  /** 模板的固定 sha（克隆后一致）。 */
  info: FixtureInfo;
  /** 模板路径（用例若需要参考"未被改动"的原始内容）。 */
  templateRepo: string;
}

export async function freshRepo(): Promise<FreshRepo> {
  const info = await template();
  const dir = mkdtempSync(path.join(tmpdir(), 'gmd-case-'));
  TEMP_DIRS.push(dir);
  const res = await gitFixture(null, ['clone', '-q', info.repo, dir]);
  if (res.status !== 0) throw new Error(`git clone 失败：${res.stderr}`);
  return { repo: dir, info, templateRepo: info.repo };
}

export async function git(repo: string, args: string[]): Promise<string> {
  const res = await gitFixture(repo, args);
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} 失败（${res.status}）：${res.stderr}`);
  return res.stdout;
}

export interface CliCapture {
  code: number;
  out: string;
  err: string;
}

/** 进程内调用 CLI（不起子进程，因此本沙箱也能跑），并把 stdout / stderr 抓下来。 */
export async function cli(argv: string[], opts: { cwd?: string; stdin?: string } = {}): Promise<CliCapture> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (t) => out.push(t), err: (t) => err.push(t) };
  const code = await runCli(argv, { cwd: opts.cwd, stdin: opts.stdin, io });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

export function readText(file: string): string {
  return readFileSync(file, 'utf8');
}

export function writeText(file: string, text: string): void {
  writeFileSync(file, text, 'utf8');
}

export function docPath(repo: string): string {
  return path.join(repo, 'docs', 'api.gmd');
}

export function srcPath(repo: string, rel = 'src/kv.ts'): string {
  return path.join(repo, ...rel.split('/'));
}

/** 解析 `--json` 输出（顺带断言它确实是合法 JSON）。 */
export function parseJson(out: string): unknown {
  return JSON.parse(out.trim().split('\n').pop() ?? 'null');
}

export interface BlockJson {
  id: string;
  severity: string;
  reason: string;
  dirty: boolean;
  writable: boolean;
  changes: Array<{ line: number; before: string | null; after: string | null }>;
  currentSource: string | null;
  rev: number;
  source: { path: string; range: [number, number]; commit: string };
}

export function blockOf(payload: unknown, id: string): BlockJson {
  const blocks = (payload as { blocks: BlockJson[] }).blocks;
  const found = blocks.find((b) => b.id === id);
  if (found === undefined) throw new Error(`JSON 里没有片段 ${id}`);
  return found;
}

/** 取出 .gmd 中**块外**的文本（用例 17 验"块外逐字节未变"）。 */
export function outsideText(raw: string): string {
  return raw.replace(/<!--\s*gmd:block\b[\s\S]*?<!--\s*\/gmd:block\s*-->/g, '');
}

/**
 * 把 `.gmd` 里**块正文**中的某段文字换成新文字（用例里模拟"手改正文但不追加版本"）。
 *
 * ⚠️ 不能直接 `raw.replace(from, to)`：从阶段 4·3 起，每个版本的正文也内嵌在**块头 JSON** 的
 * `hist[].text` 里，而块头排在块正文之前 ⇒ `replace` 会先命中**元数据**那一份，把文档变成
 * "text 与 text_hash 不一致"的格式损坏，用例的前置状态就不成立了。
 * 块正文永远排在它所属的块头之后 ⇒ 取**最后一次**出现。
 */
export function replaceBlockBody(raw: string, from: string, to: string): string {
  const at = raw.lastIndexOf(from);
  if (at < 0) throw new Error(`块正文里找不到要替换的文字：${from}`);
  return raw.slice(0, at) + to + raw.slice(at + from.length);
}

/**
 * 精修某个块的**块头元数据**（用例要造"手改 text / 删掉 text 字段"这类场景时用）。
 * 块头是单行注释：解析出 JSON → 交给 `mutate` 改 → 重新序列化回那一行。
 */
export function editBlockHead(
  raw: string,
  blockId: string,
  mutate: (head: Record<string, unknown>) => void,
): string {
  const lines = raw.split('\n');
  const idx = lines.findIndex((l) => l.startsWith(`<!-- gmd:block {"id":"${blockId}"`));
  if (idx < 0) throw new Error(`找不到片段 ${blockId} 的块头`);
  const json = lines[idx].slice('<!-- gmd:block '.length, -' -->'.length);
  // 序列化时 JSON 里的 `--` 被转义成 \u002d\u002d（见 format.ts 的 escapeDashes），还原后才能 parse
  const head = JSON.parse(json.split('\\u002d\\u002d').join('--')) as Record<string, unknown>;
  mutate(head);
  lines[idx] = `<!-- gmd:block ${JSON.stringify(head)} -->`;
  return lines.join('\n');
}
