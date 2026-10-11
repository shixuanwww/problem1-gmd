/**
 * `gmd commit` —— 写回闸门 + 原子写（PLAN §4.6.2，阶段 3 的核心）。
 *
 * 提交前依次通过：步骤 0（剥离草稿头）+ 五道校验，任一不过**拒绝写回**（CLI 映射为退出码 4）：
 *   1 正文非空；2 草稿 base_rev == 当前活动版本；3 来源未提交修改闸门（除非 --allow-dirty）；
 *   4 内容确有变化（不然就是造无效版本）；5 引用范围仍然存在（越界 ⇒ 拒写，防伪造成 ok）。
 * 通过后：重算 commit / src_hash → 追加 hist → 原子写（.tmp → rename）。
 *
 * 目标来源 = 活动版本的 (path, range)，可用 `--path` / `--range` **重新绑定**（阶段 4 的
 * "旧来源已消失 ⇒ 重写后写回"通路）。校验 3 与校验 5 一律针对**目标来源**判。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

import { normalizeNewlines, parseGmd, serializeGmd } from './format.ts';
import { draftPathFor, nowIso, stripDraftHeader } from './edit.ts';
import {
  SourceEncodingError,
  countLines,
  hashRange,
  isRangeDirtyTexts,
  readWorktreeText,
  revParseHead,
  showText,
  textHash,
} from './gitrepo.ts';
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
  /** 重新绑定引用：本版本改用这个来源路径（缺省沿用活动版本的 path）。必须是仓库内相对路径。 */
  path?: string;
  /** 重新绑定引用：本版本改用这个来源范围（缺省沿用活动版本的 range）。 */
  range?: [number, number];
}

export interface CommitResult {
  block: string;
  rev: number;
  text_hash: string;
  range: [number, number];
  /** 本次写回的来源路径（重新绑定时即新 path）。 */
  path: string;
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

  // ---- 本次要记录的来源：可能被 --path / --range **重新绑定** ----
  // 阶段 4 的"重写后可写回"通路：旧来源（文件被删 / 整段被替换）已经没有出路，
  // 只允许**改指到仍存在的来源**，新版本记新 path/range，历史版本各自的 path/range 不动。
  const targetPath = opts.path ?? active.path;
  const targetRange: [number, number] = opts.range ?? [active.range[0], active.range[1]];
  if (
    !Number.isInteger(targetRange[0]) ||
    !Number.isInteger(targetRange[1]) ||
    targetRange[0] < 1 ||
    targetRange[1] < targetRange[0]
  ) {
    throw new CommitRejected(`引用范围非法: [${targetRange[0]}, ${targetRange[1]}]（须是 1-based 闭区间且 l0 <= l1）`);
  }

  // ---- 校验 5：目标范围必须真的存在（越界 ⇒ 拒写）----
  // 🔒 越界闸门（P0 回归）：range 全在文件外时 hashRange 会**静默截断**成空串哈希，
  // 沿用越界 range 就会写出"引用目标已消失、却自证与当前内容一致"的无效版本
  // —— 下一次 read 会把它判成 ok（题面明确要求"绝不判为可用"）。宁拒不写。
  // 来源文件已被删除 / 变成二进制时，这里会抛 CommitRejected（码 4），而不是裸 ENOENT（码 1）。
  const srcText = await readSourceForCommit(opts.repo, targetPath);
  const srcLineCount = countLines(srcText);
  if (targetRange[1] > srcLineCount) {
    throw new CommitRejected(
      `引用范围 ${targetRange[0]}-${targetRange[1]} 已不存在（来源 ${targetPath} 现有 ${srcLineCount} 行），拒绝写入无法自洽的新版本；` +
        '请用 --path / --range 把引用指向仍存在的来源范围',
    );
  }

  // ---- 校验 3：来源未提交修改闸门（对**目标来源**判，而不是拿被判定的旧来源）----
  // 为什么不再调 judgeBlock(block)：重绑定后闸门要落在新来源上；而且 judgeBlock 在"正文与元数据
  // 不一致"等步骤 0 场景会返回 dirty=false —— 那等于"先手改正文就能绕过脏来源闸门"。
  // 这里直接用 §4.3 步骤 3 的同一组原语（showText + isRangeDirtyTexts）算，口径不变但不漏判。
  let headText: string | null;
  try {
    headText = await showText(opts.repo, 'HEAD', targetPath);
  } catch (e) {
    if (e instanceof SourceEncodingError) {
      throw new CommitRejected(
        `来源在 HEAD 中不是 UTF-8 文本，无法比较是否已提交: ${targetPath}（确需写入请显式加 --allow-dirty）`,
      );
    }
    throw e;
  }
  // `git show HEAD:<path>` 取不到（仓库没有 HEAD，或该路径不在 HEAD 里）⇒ 视为未提交修改。
  const dirty = headText === null ? true : isRangeDirtyTexts(srcText, headText, targetRange);
  if (dirty && opts.allowDirty !== true) {
    throw new CommitRejected('来源存在未提交修改，默认拒绝写入（确需写入请显式加 --allow-dirty）');
  }

  // ---- 校验 4：内容确有变化 ----
  const newHash = textHash(newBody);
  if (newHash === active.text_hash) throw new CommitRejected('内容未变化');

  // ---- 通过：重算来源信息 ----
  const commitSha = await revParseHead(opts.repo);
  if (commitSha === null) throw new CommitRejected('仓库没有 HEAD 提交，无法记录来源版本');

  const version: GmdVersion = {
    rev: active.rev + 1,
    at: opts.at ?? nowIso(),
    path: targetPath,
    range: [targetRange[0], targetRange[1]],
    commit: commitSha,
    src_hash: hashRange(srcText, targetRange),
    text_hash: newHash,
    // 历史正文随版本一起落盘（阶段 4·3）：只留 text_hash 的话 `read --version <rev>`
    // 答不出"那一版写了什么"，题面的"版本历史内嵌于 .gmd"也就落空了。
    text: normalizeNewlines(newBody),
  };
  if (dirty) version.note = 'based_on_dirty';
  // `--allow-dirty` 的收口：这一版的 `src_hash` 取自**脏工作区**，而 `commit` 记的是 HEAD，
  // 两者不同源 —— 把基准写成字段，`src_hash === hashRange(基准处的范围文本, range)` 才可校验。
  if (dirty) version.src_base = 'worktree';

  // 目标块：`{ ...b }` 保留它的块头扩展字段（EXTRAS 是 Symbol 键，展开才带得走）；
  // 其它块原样传入 —— `serializeGmd` 只重写 `rewriteIds` 里的片段，其余逐字节拷贝。
  const blocks = parsed.blocks.map((b, i) =>
    i === idx ? { ...b, hist: [...b.hist, version], text: normalizeNewlines(newBody) } : b,
  );
  const out = serializeGmd(raw, blocks, [block.id]);

  // ---- 原子写：.tmp → rename（避免中途崩溃留下半截文件）----
  const tmp = `${opts.repo}/${opts.docRel}.tmp`;
  writeFileSync(tmp, out, 'utf8');
  renameSync(tmp, `${opts.repo}/${opts.docRel}`);

  return {
    block: block.id,
    rev: version.rev,
    text_hash: newHash,
    range: [targetRange[0], targetRange[1]],
    path: version.path,
    note: version.note,
    sourceDirty: dirty,
  };
}
