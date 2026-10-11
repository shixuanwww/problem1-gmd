/**
 * `gmd commit` —— 写回闸门 + 原子写（PLAN §4.6.2，阶段 3 的核心）。
 *
 * 提交前依次通过：步骤 0（剥离草稿头）+ 四道校验，任一不过**拒绝写回**（CLI 映射为退出码 4）：
 *   1 正文非空；2 草稿 base_rev == 当前活动版本；3 来源未提交修改闸门（除非 --allow-dirty）；
 *   4 内容确有变化（不然就是造无效版本）。
 * 通过后：重算 commit / src_hash（**沿用它记录的旧 range**）→ 追加 hist → 原子写（.tmp → rename）。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

import { normalizeNewlines, parseGmd, serializeGmd } from './format.ts';
import { draftPathFor, nowIso, stripDraftHeader } from './edit.ts';
import { SourceEncodingError, hashRange, readWorktreeText, revParseHead, textHash } from './gitrepo.ts';
import { judgeBlock } from './judge.ts';
import type { GmdVersion } from './types.ts';

/** 写回被拒（退出码 4）。 */
export class CommitRejected extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CommitRejected';
  }
}

export interface CommitOptions {
  repo: string;
  docRel: string;
  blockId: string;
  /** 输入全文（草稿文件 / --input 文件 / stdin，由调用方读好）。 */
  inputText: string;
  allowDirty?: boolean;
  at?: string;
}

export interface CommitResult {
  block: string;
  rev: number;
  text_hash: string;
  range: [number, number];
  note?: string;
  /** 本次写回是否基于未提交来源（仅 --allow-dirty 时可能为 true）。 */
  sourceDirty: boolean;
}

export function defaultDraftPath(repo: string, docRel: string, blockId: string): string {
  return draftPathFor(repo, docRel, blockId);
}

export function readInputFile(absPath: string): string {
  return readFileSync(absPath, 'utf8');
}

/**
 * 读来源以重算 `src_hash`（阶段 1–3 的 `range` 只能沿用旧范围，所以来源必须还在）。
 *
 * ⚠️ 失败必须让 CLI 落在**退出码 4（写回被拒）**，**不能**冒泡成裸 `ENOENT`（会被 CLI 兜底成
 * 码 1「参数/用法错误」—— 参数明明是好的）。题面 §2.4 把「文件没了」列为 `error`（= 必须重写），
 * 所以这条链路必须给出**可解释、可分支**的拒绝理由，而不是一句 `open ... ENOENT`。
 * 这条正是 §8 用例 4（删来源 → error）之后 `edit → 重写 → commit` 的收尾：AI 重写得了正文，
 * 但**记不了新版本的来源**，只能被明确拒绝。
 */
async function readSourceForCommit(repo: string, relPath: string): Promise<string> {
  try {
    return await readWorktreeText(repo, relPath);
  } catch (e) {
    if (e instanceof SourceEncodingError) {
      throw new CommitRejected(`来源不是 UTF-8 文本，无法记录新版本的来源摘要: ${relPath}`);
    }
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (typeof code === 'string' && code.startsWith('ENOENT')) {
      throw new CommitRejected(
        `来源文件已不存在，无法记录新版本的来源信息: ${relPath}` +
          '（阶段 1–3 不做符号/选区级引用，range 只能沿用旧范围；请先恢复来源文件，或改用其它引用）',
      );
    }
    throw e;
  }
}

export async function commitBlock(opts: CommitOptions): Promise<CommitResult> {
  const raw = await readWorktreeText(opts.repo, opts.docRel);
  const parsed = parseGmd(raw);

  const idx = parsed.blocks.findIndex((b) => b.id === opts.blockId);
  if (idx < 0) throw new CommitRejected(`找不到片段: ${opts.blockId}`);
  const block = parsed.blocks[idx];
  const active = block.hist[block.hist.length - 1];

  // ---- 步骤 0：剥离并校验草稿头，得到"新正文" ----
  const stripped = stripDraftHeader(opts.inputText);
  if (stripped.headerError !== null) throw new CommitRejected(stripped.headerError);
  if (stripped.header !== null) {
    const h = stripped.header;
    if (h.doc !== opts.docRel || h.block !== opts.blockId) {
      throw new CommitRejected('草稿头与当前文档/片段/版本不符（doc/block/base_rev 校验失败）');
    }
    if (h.base_rev !== active.rev) {
      throw new CommitRejected(`草稿基于旧版本 rev=${h.base_rev}，当前为 ${active.rev}`);
    }
  }
  const newBody = stripped.body;

  // ---- 校验 1：新正文非空 ----
  if (newBody.trim().length === 0) throw new CommitRejected('草稿正文为空');

  // ---- 校验 3：来源未提交修改闸门（判定口径与 judge 完全一致）----
  const judgement = await judgeBlock(block, opts.repo);
  const dirty = judgement.dirty;
  if (dirty && opts.allowDirty !== true) {
    throw new CommitRejected('来源存在未提交修改，默认拒绝写入（确需写入请显式加 --allow-dirty）');
  }

  // ---- 校验 4：内容确有变化 ----
  const newHash = textHash(newBody);
  if (newHash === active.text_hash) throw new CommitRejected('内容未变化');

  // ---- 通过：重算来源信息（range 沿用它记录的旧范围）----
  const commitSha = await revParseHead(opts.repo);
  if (commitSha === null) throw new CommitRejected('仓库没有 HEAD 提交，无法记录来源版本');
  // 来源文件已被删除 / 变成二进制时，这里会抛 CommitRejected（码 4），而不是裸 ENOENT（码 1）。
  const srcText = await readSourceForCommit(opts.repo, active.path);
  const version: GmdVersion = {
    rev: active.rev + 1,
    at: opts.at ?? nowIso(),
    path: active.path,
    range: [active.range[0], active.range[1]],
    commit: commitSha,
    src_hash: hashRange(srcText, active.range),
    text_hash: newHash,
  };
  if (dirty) version.note = 'based_on_dirty';

  const blocks = parsed.blocks.map((b, i) =>
    i === idx
      ? { id: b.id, hist: [...b.hist, version], text: normalizeNewlines(newBody) }
      : { id: b.id, hist: b.hist, text: b.text },
  );
  const out = serializeGmd(raw, blocks);

  // ---- 原子写：.tmp → rename（避免中途崩溃留下半截文件）----
  const tmp = `${opts.repo}/${opts.docRel}.tmp`;
  writeFileSync(tmp, out, 'utf8');
  renameSync(tmp, `${opts.repo}/${opts.docRel}`);

  return {
    block: block.id,
    rev: version.rev,
    text_hash: newHash,
    range: [active.range[0], active.range[1]],
    note: version.note,
    sourceDirty: dirty,
  };
}
