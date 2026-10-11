#!/usr/bin/env node
/**
 * gmd CLI（PLAN §4.8 / §4.9 / §5）。
 *
 * 子命令：read / log / edit / commit（命令名必须是 `gmd` —— 题面硬要求）。
 * 退出码：0 成功 · 1 参数/用法错 · 2 格式损坏 · 3 存在 error 块（read 专用）·
 *         4 写回被拒 · 5 环境错误（git 不可用 / 不是仓库 / git 子进程非零或超时）。
 *
 * 失败时**不污染 stdout**：`--json` 给 `{"error","code"}`，人类可读文字一律走 stderr。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CommitRejected, commitBlock, readInputFile } from './commit.ts';
import { draftPathFor, writeDraft } from './edit.ts';
import { parseGmd } from './format.ts';
import {
  GitError,
  SourceEncodingError,
  commitsTouchingRange,
  countLines,
  findRepoRoot,
  gitVersion,
  historyForPath,
  readWorktreeText,
  worktreeFileExists,
} from './gitrepo.ts';
import { judgeBlock, judgeDoc } from './judge.ts';
import {
  renderDocSummary,
  renderLogBlock,
  renderLogPath,
  renderPlainBody,
  renderReadView,
  shortHash,
  shortSha,
  toJson,
  versionToJson,
} from './render.ts';
import { GmdFormatError } from './types.ts';
import type { ParsedGmd } from './types.ts';

export const EXIT = {
  OK: 0,
  USAGE: 1,
  FORMAT: 2,
  HAS_ERROR_BLOCK: 3,
  REJECTED: 4,
  ENV: 5,
} as const;

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

export interface CliOptions {
  cwd?: string;
  /** 测试/嵌入用：直接给出 stdin 内容（`--input -`）。 */
  stdin?: string;
  io?: CliIO;
}

const BOOL_FLAGS = new Set(['json', 'plain', 'body', 'allow-dirty', 'help', 'h']);
const VALUE_FLAGS = new Set(['repo', 'block', 'version', 'input', 'path', 'range']);

const USAGE = `gmd —— Git 衍生文档管理器（.gmd）

用法：
  gmd read   <doc> [--block <id>] [--version <rev>] [--plain] [--json]
  gmd log    <doc> [--block <id>] [--path <src>] [--range <a..b>] [--json]
  gmd edit   <doc> --block <id> [--json]
  gmd commit <doc> --block <id> [--input <file|->] [--allow-dirty] [--json]

全局：
  --repo <path>   指定 Git 仓库（缺省从当前目录向上找 .git）
  --json          单行 JSON 输出（失败时为 {"error","code"}）
  --plain         只出正文（read 专用，与 --json 互斥）

退出码：0 成功 · 1 参数错 · 2 格式损坏 · 3 存在 error 块 · 4 写回被拒 · 5 环境错误`;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
  errors: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const errors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const name = (eq >= 0 ? tok.slice(2, eq) : tok.slice(2)).toLowerCase();
      const inlineValue = eq >= 0 ? tok.slice(eq + 1) : null;
      if (BOOL_FLAGS.has(name)) {
        if (inlineValue !== null) {
          errors.push(`选项 --${name} 是开关，不接受取值`);
          continue;
        }
        flags.set(name, true);
        continue;
      }
      if (!VALUE_FLAGS.has(name)) {
        errors.push(`未知选项 --${name}`);
        continue;
      }
      let value: string | undefined;
      if (inlineValue !== null) {
        value = inlineValue;
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          errors.push(`选项 --${name} 缺少取值`);
          continue;
        }
        value = next;
        i++;
      }
      flags.set(name, value);
      continue;
    }
    positionals.push(tok);
  }
  return { positionals, flags, errors };
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function parseRange(raw: string): { a: number; b: number } | null {
  const m = /^(\d+)\s*(?:\.\.|,)\s*(\d+)$/.exec(raw.trim());
  if (m === null) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a < 1 || b < a) return null;
  return { a, b };
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const io: CliIO =
    options.io ?? {
      out: (t) => process.stdout.write(`${t}\n`),
      err: (t) => process.stderr.write(`${t}\n`),
    };
  const cwd = options.cwd ?? process.cwd();
  const parsed = parseArgs(argv);
  const wantJson = parsed.flags.has('json');

  const fail = (code: number, message: string): number => {
    if (wantJson) io.out(toJson({ error: message, code }));
    io.err(`错误：${message}`);
    return code;
  };

  if (parsed.flags.has('help') || parsed.flags.has('h')) {
    io.out(USAGE);
    return EXIT.OK;
  }
  if (parsed.errors.length > 0) return fail(EXIT.USAGE, parsed.errors[0]);

  const cmd = parsed.positionals[0];
  if (cmd === undefined) {
    io.err(USAGE);
    return EXIT.USAGE;
  }
  if (cmd !== 'read' && cmd !== 'log' && cmd !== 'edit' && cmd !== 'commit') {
    return fail(EXIT.USAGE, `未知子命令: ${cmd}`);
  }

  try {
    // ---- 环境自检：git 必须在 PATH 中（PLAN §2.1，失败必须明确报错而非静默降级）----
    const version = await gitVersion();
    if (version === null) {
      return fail(EXIT.ENV, '环境错误：找不到可执行的 git（请确认 git 在 PATH 中）');
    }

    // ---- 定位仓库：--repo 优先，否则从 cwd 向上找 .git ----
    const repoFlag = parsed.flags.get('repo');
    let repo: string | null;
    if (typeof repoFlag === 'string') {
      repo = findRepoRoot(path.resolve(cwd, repoFlag));
      if (repo === null) return fail(EXIT.ENV, `环境错误：--repo 不是 Git 仓库: ${path.resolve(cwd, repoFlag)}`);
    } else {
      repo = findRepoRoot(cwd);
      if (repo === null) return fail(EXIT.ENV, '环境错误：当前目录不在 Git 仓库内（可用 --repo 指定）');
    }

    const docArg = parsed.positionals[1];
    if (docArg === undefined) {
      return fail(EXIT.USAGE, `用法：gmd ${cmd} <doc> ...（见 gmd --help）`);
    }
    const docPath = path.resolve(repo, docArg);
    const docRel = path.relative(repo, docPath).split(path.sep).join('/');
    if (docRel.startsWith('..')) {
      return fail(EXIT.USAGE, `文档必须在仓库内: ${docArg}`);
    }
    if (!existsSync(docPath)) {
      return fail(EXIT.USAGE, `找不到文档: ${docRel}`);
    }

    const loadDoc = async (): Promise<ParsedGmd> => parseGmd(await readWorktreeText(repo, docRel));

    // ======================= read =======================
    if (cmd === 'read') {
      const plain = parsed.flags.has('plain') || parsed.flags.has('body');
      if (plain && wantJson) return fail(EXIT.USAGE, '--plain 与 --json 互斥');
      const blockFlag = parsed.flags.get('block');
      const versionFlag = parsed.flags.get('version');
      const doc = await loadDoc();

      if (typeof blockFlag === 'string' && !doc.blocks.some((b) => b.id === blockFlag)) {
        return fail(EXIT.USAGE, `找不到片段: ${blockFlag}`);
      }

      if (typeof versionFlag === 'string') {
        const rev = Number(versionFlag);
        if (!Number.isInteger(rev) || rev < 1) return fail(EXIT.USAGE, `--version 必须是 >= 1 的整数: ${versionFlag}`);
        const blocks = typeof blockFlag === 'string' ? doc.blocks.filter((b) => b.id === blockFlag) : doc.blocks;
        const rows = blocks
          .map((b) => ({ block: b.id, version: b.hist.find((v) => v.rev === rev) ?? null }))
          .filter((r) => r.version !== null);
        if (rows.length === 0) return fail(EXIT.USAGE, `没有片段存在 rev ${rev}`);
        if (wantJson) {
          io.out(toJson(rows.map((r) => ({ block: r.block, ...versionToJson(r.version!) }))));
          return EXIT.OK;
        }
        io.out(
          [
            `# gmd read --version ${rev} — ${docRel}`,
            '※ 本实现只保存**活动版本正文**，历史正文不保存（见 README「历史正文的取舍」）。',
            '  下面给出的是该版本的来源与摘要信息，而不是当年的文档原文。',
            ...rows.map(
              (r) =>
                `  ${r.block}  rev ${r.version!.rev}  ${r.version!.at}  ${r.version!.path}:${r.version!.range[0]}-${r.version!.range[1]}  ${shortSha(r.version!.commit)}  ${shortHash(r.version!.src_hash)}`,
            ),
          ].join('\n'),
        );
        return EXIT.OK;
      }

      if (plain) {
        io.out(renderPlainBody(doc, typeof blockFlag === 'string' ? blockFlag : undefined));
        const judgements = await judgeDoc(doc, repo);
        return judgements.some((j) => j.severity === 'error') ? EXIT.HAS_ERROR_BLOCK : EXIT.OK;
      }

      const judgements = await judgeDoc(doc, repo);
      if (wantJson) {
        io.out(toJson({ doc: doc.doc, blocks: judgements }));
      } else {
        const selected =
          typeof blockFlag === 'string' ? judgements.filter((j) => j.id === blockFlag) : judgements;
        io.out(renderReadView(doc.doc, selected, { repo, docRel, docPath }));
      }
      return judgements.some((j) => j.severity === 'error') ? EXIT.HAS_ERROR_BLOCK : EXIT.OK;
    }

    // ======================= log =======================
    if (cmd === 'log') {
      const blockFlag = parsed.flags.get('block');
      const pathFlag = parsed.flags.get('path');
      const rangeFlag = parsed.flags.get('range');
      if (typeof rangeFlag === 'string' && typeof pathFlag !== 'string') {
        return fail(EXIT.USAGE, '--range 必须与 --path 一起使用');
      }
      if (typeof blockFlag === 'string') {
        const doc = await loadDoc();
        const block = doc.blocks.find((b) => b.id === blockFlag);
        if (block === undefined) return fail(EXIT.USAGE, `找不到片段: ${blockFlag}`);
        if (wantJson) io.out(toJson(block.hist.map(versionToJson)));
        else io.out(renderLogBlock(docRel, block));
        return EXIT.OK;
      }
      if (typeof pathFlag === 'string') {
        const src = pathFlag.split('\\').join('/');
        let note: string | undefined;
        let commits;
        if (typeof rangeFlag === 'string') {
          const range = parseRange(rangeFlag);
          if (range === null) return fail(EXIT.USAGE, `--range 需要形如 a..b 且 1 <= a <= b: ${rangeFlag}`);
          const exists = worktreeFileExists(repo, src);
          const lines = exists ? countLines(await readWorktreeText(repo, src)) : 0;
          if (!exists) {
            note = '来源文件当前不存在，已降级为列出该文件全部提交';
            commits = await historyForPath(repo, src);
          } else if (range.a > lines || range.b > lines) {
            note = `range ${range.a}..${range.b} 超出当前文件行数（当前 ${lines} 行），已降级为列出该文件全部提交`;
            commits = await historyForPath(repo, src);
          } else {
            commits = await commitsTouchingRange(repo, src, range.a, range.b);
          }
        } else {
          commits = await historyForPath(repo, src);
        }
        if (wantJson) io.out(toJson(commits.map((c) => ({ sha: c.sha, short: c.short, at: c.at, subject: c.subject }))));
        else io.out(renderLogPath(docRel, src, commits, note));
        return EXIT.OK;
      }
      const doc = await loadDoc();
      const judgements = await judgeDoc(doc, repo);
      if (wantJson) {
        io.out(
          toJson(
            judgements.map((j) => ({
              id: j.id,
              rev: j.rev,
              severity: j.severity,
              path: j.source.path,
              range: j.source.range,
            })),
          ),
        );
      } else {
        io.out(renderDocSummary(docRel, judgements));
      }
      return EXIT.OK;
    }

    // ======================= edit =======================
    if (cmd === 'edit') {
      const blockFlag = parsed.flags.get('block');
      if (typeof blockFlag !== 'string') return fail(EXIT.USAGE, '用法：gmd edit <doc> --block <id>');
      const doc = await loadDoc();
      const block = doc.blocks.find((b) => b.id === blockFlag);
      if (block === undefined) return fail(EXIT.USAGE, `找不到片段: ${blockFlag}`);
      // error 档也允许 edit（题面：error 时必须重写）
      const judgement = await judgeBlock(block, repo);
      const result = writeDraft(repo, docRel, block, judgement);
      if (result.overwritten) io.err(`覆盖已有草稿: ${result.draftPath}`);
      if (wantJson) io.out(toJson({ draft_path: result.draftPath }));
      else io.out(result.draftPath);
      io.err(renderReadView(doc.doc, [judgement], { repo, docRel, docPath }));
      return EXIT.OK;
    }

    // ======================= commit =======================
    const blockFlag = parsed.flags.get('block');
    if (typeof blockFlag !== 'string') return fail(EXIT.USAGE, '用法：gmd commit <doc> --block <id> [--input <file|->]');
    const inputFlag = parsed.flags.get('input');
    let inputText: string;
    if (inputFlag === undefined) {
      const draft = draftPathFor(repo, docRel, blockFlag);
      if (!existsSync(draft)) {
        return fail(EXIT.USAGE, `未找到草稿文件: ${draft}（请先 gmd edit，或用 --input <file|-> 指定）`);
      }
      inputText = readInputFile(draft);
    } else if (inputFlag === '-') {
      inputText = options.stdin ?? (await readAllStdin());
    } else {
      const abs = path.resolve(cwd, inputFlag);
      if (!existsSync(abs)) return fail(EXIT.USAGE, `找不到 --input 文件: ${abs}`);
      inputText = readInputFile(abs);
    }

    const result = await commitBlock({
      repo,
      docRel,
      blockId: blockFlag,
      inputText,
      allowDirty: parsed.flags.has('allow-dirty'),
    });
    if (result.sourceDirty) {
      io.err(`※ 审计提示：此版本基于**未提交来源**（新版本 note=based_on_dirty）—— 来源改动请尽快提交为正式版本。`);
    }
    if (wantJson) {
      io.out(toJson({ block: result.block, rev: result.rev, text_hash: result.text_hash, range: result.range }));
    } else {
      io.out(
        `已写入 ${docRel} 片段 ${result.block} → rev ${result.rev}（来源 ${result.range[0]}-${result.range[1]}，text_hash ${shortHash(result.text_hash)}）`,
      );
    }
    return EXIT.OK;
  } catch (e) {
    if (e instanceof GmdFormatError) return fail(EXIT.FORMAT, `${e.message}（第 ${e.line} 行）`);
    if (e instanceof CommitRejected) return fail(EXIT.REJECTED, e.message);
    if (e instanceof GitError) return fail(EXIT.ENV, `环境错误：${e.message}`);
    if (e instanceof SourceEncodingError) return fail(EXIT.ENV, `环境错误：${e.message}`);
    // ENOENT 等文件系统错误
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (typeof code === 'string' && code.startsWith('ENOENT')) {
      return fail(EXIT.USAGE, `找不到文件：${(e as Error).message}`);
    }
    return fail(EXIT.ENV, `内部错误：${e instanceof Error ? e.message : String(e)}`);
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`错误：${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = EXIT.ENV;
    },
  );
}
