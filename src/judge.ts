/**
 * 判定引擎（PLAN §4.3，**本题算法核心**）。
 *
 * 对每个片段的**活动版本**只回答一个问题：记录的这段文字还能不能直接用。
 *   步骤 0  正文与元数据一致性（手改正文不追加版本 ⇒ 自证最新 ⇒ error）
 *   步骤 1  引用文件是否存在
 *   步骤 2  读工作区原文（严格 UTF-8）
 *   步骤 3  范围级 dirty 检查（worktree vs HEAD；**换行差异不算脏**）
 *   步骤 3.5 引用范围是否仍然存在（越界 ⇒ error；防 hashRange 静默截断伪造成 ok）
 *   步骤 4  范围内容 hash 比对         → ok
 *   步骤 5  内容锚定（±50 行滑窗）      → warning（内容还在，只是行号漂了）
 *   步骤 6  相似度分段判定              → warning / error
 *
 * 三条铁律：① 只看 v.range 范围（其它地方改动不算过期）；② error 时 currentSource 必须为 null、
 * changes 必须为空（题面：刻意隐藏旧文字）；③ 判定依据永远是**工作区当前内容**，不是 HEAD。
 */

import type { BlockJudgement, GmdBlock, ParsedGmd, Severity } from './types.ts';
import {
  GitError,
  SourceEncodingError,
  countLines,
  hashRange,
  isRangeDirtyTexts,
  normalizeEol,
  rangeLines,
  readWorktreeText,
  showText,
  textHash,
  worktreeFileExists,
} from './gitrepo.ts';
import { recordChanges } from './diff.ts';

/** 行号漂移搜索窗口：range ± 50 行（PLAN §11）。 */
export const ANCHOR_WINDOW = 50;
/** 范围 >= 3 行：非空行的行集合 Jaccard 阈值。 */
export const SIM_THRESHOLD_LINE_SET = 0.2;
/** 范围 <= 2 行：各行首尾相接后的去重字符集合 Jaccard 阈值。 */
export const SIM_THRESHOLD_CHAR_SET = 0.3;
/** 少于多少行改用字符集合（短引用下行集合必然退化，见 PLAN §4.3 步骤 6b）。 */
export const MIN_LINES_FOR_LINE_SET = 3;

export interface JudgeOptions {
  /**
   * 只实现步骤 0/1/3/4（= PLAN §5 阶段 1）：
   * 此时 hash 不同一律先降级为 warning，真正区分 warning / error 要等阶段 2 的步骤 6。
   */
  staged?: boolean;
}

/** 行集合 Jaccard（非空行、trim 后去重）。 */
export function lineSetJaccard(oldLines: string[], newLines: string[]): number {
  const a = new Set(oldLines.map((s) => s.trim()).filter((s) => s.length > 0));
  const b = new Set(newLines.map((s) => s.trim()).filter((s) => s.length > 0));
  return jaccard(a, b);
}

/** 字符集合 Jaccard（各行首尾相接后取去重字符集合）。 */
export function charSetJaccard(oldLines: string[], newLines: string[]): number {
  const a = new Set([...oldLines.map((s) => s.trim()).filter((s) => s.length > 0).join('')]);
  const b = new Set([...newLines.map((s) => s.trim()).filter((s) => s.length > 0).join('')]);
  return jaccard(a, b);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface SimilarityResult {
  sim: number;
  mode: 'line-set' | 'char-set';
  threshold: number;
}

export function similarity(oldLines: string[], newLines: string[], rangeLength: number): SimilarityResult {
  if (rangeLength >= MIN_LINES_FOR_LINE_SET) {
    return { sim: lineSetJaccard(oldLines, newLines), mode: 'line-set', threshold: SIM_THRESHOLD_LINE_SET };
  }
  return { sim: charSetJaccard(oldLines, newLines), mode: 'char-set', threshold: SIM_THRESHOLD_CHAR_SET };
}

function judgement(
  block: GmdBlock,
  severity: Severity,
  reason: string,
  extra: Partial<BlockJudgement> = {},
): BlockJudgement {
  const v = block.hist[block.hist.length - 1];
  const dirty = extra.dirty === true;
  return {
    id: block.id,
    severity,
    rev: v.rev,
    source: { path: v.path, range: v.range, commit: v.commit },
    reason,
    dirty,
    writable: !dirty && severity !== 'error',
    changes: [],
    currentSource: null,
    ...extra,
  };
}

/** 记一个 error 块：**永远不带旧文字**（题面"刻意隐藏旧文字"）。 */
function errorJudgement(block: GmdBlock, reason: string, dirty = false): BlockJudgement {
  return judgement(block, 'error', reason, { dirty, writable: false, changes: [], currentSource: null });
}

export async function judgeBlock(block: GmdBlock, repo: string, opts: JudgeOptions = {}): Promise<BlockJudgement> {
  const v = block.hist[block.hist.length - 1];

  // ---- 步骤 0：正文与元数据一致性（手改正文却不追加版本 ⇒ 不认账）----
  if (textHash(block.text) !== v.text_hash) {
    return errorJudgement(block, '正文与元数据不一致');
  }

  // ---- 步骤 1：引用文件是否存在（重命名也算不存在 —— 本题不做 rename 跟踪）----
  if (!worktreeFileExists(repo, v.path)) {
    return errorJudgement(block, `引用文件不存在: ${v.path}`);
  }

  // ---- 步骤 2：读工作区原文 ----
  let nowText: string;
  try {
    nowText = await readWorktreeText(repo, v.path);
  } catch (e) {
    if (e instanceof SourceEncodingError) {
      return errorJudgement(block, `来源不是 UTF-8 文本: ${v.path}`);
    }
    throw e;
  }
  const nowLines = normalizeEol(nowText).split('\n');
  const inRangeNow = () => rangeLines(nowText, v.range).join('\n');

  // ---- 步骤 3：范围级 dirty 检查（worktree vs HEAD）----
  let headText: string | null;
  try {
    headText = await showText(repo, 'HEAD', v.path);
  } catch (e) {
    if (e instanceof SourceEncodingError) {
      return errorJudgement(block, `来源不是 UTF-8 文本: ${v.path}`);
    }
    throw e;
  }

  // ---- 步骤 3.5：引用范围是否仍然存在（题面 §2.4：整段被删除 ⇒ error，绝不判为可用）----
  // 为什么必须单独判：range 越界时 hashRange 会**静默截断**，范围全在文件外时退化成空串哈希。
  // 若写入侧沿用越界 range（见 commit.ts 的同类闸门），"引用目标已消失"会被记成 hash 一致 ⇒ 伪造成 ok。
  const srcLineCount = countLines(nowText);
  if (v.range[1] > srcLineCount) {
    // 仍如实报告 dirty：范围不存在与"未提交"是两件事，AI 需要同时看到。
    const dirtyOutOfRange = headText === null ? true : isRangeDirtyTexts(nowText, headText, v.range);
    return errorJudgement(
      block,
      `引用范围已不存在（来源现有 ${srcLineCount} 行，引用 ${v.range[0]}-${v.range[1]}）`,
      dirtyOutOfRange,
    );
  }

  if (headText === null) {
    // `git show HEAD:<path>` 取不到：仓库没有 HEAD，或该路径不在 HEAD 里。
    // 工作区存在（步骤 1 已保证）⇒ 来源是新增 / 未跟踪 ⇒ 视为未提交修改。
    if (!worktreeFileExists(repo, v.path)) {
      // 竞态兜底：步骤 1 之后文件被删掉了。
      return errorJudgement(block, `引用文件不存在: ${v.path}`);
    }
    return judgement(block, 'warning', '引用范围内存在未提交修改', {
      dirty: true,
      writable: false,
      currentSource: inRangeNow(),
    });
  }

  if (isRangeDirtyTexts(nowText, headText, v.range)) {
    const diff = recordChanges(rangeLines(headText, v.range), rangeLines(nowText, v.range), v.range[0]);
    return judgement(block, 'warning', '引用范围内存在未提交修改', {
      dirty: true,
      writable: false,
      changes: diff.changes,
      changes_omitted: diff.omitted,
      currentSource: inRangeNow(),
    });
  }

  // ---- 步骤 4：范围内容 hash 比对 ----
  if (hashRange(nowText, v.range) === v.src_hash) {
    return judgement(block, 'ok', '引用范围内内容未变化', { currentSource: inRangeNow() });
  }

  if (opts.staged === true) {
    // 阶段 1 只到步骤 4：无法区分"内容变了"与"整段被替换"，先统一降级为 warning。
    const diff = recordChanges(rangeLines(headText, v.range), rangeLines(nowText, v.range), v.range[0]);
    return judgement(block, 'warning', '引用范围内内容已变化（阶段 1 降级：未做相似度判定）', {
      changes: diff.changes,
      changes_omitted: diff.omitted,
      currentSource: inRangeNow(),
    });
  }

  // ---- 步骤 5：内容锚定（处理行号漂移）----
  const len = v.range[1] - v.range[0] + 1;
  const winLo = Math.max(1, v.range[0] - ANCHOR_WINDOW);
  const winHi = Math.min(nowLines.length, v.range[1] + ANCHOR_WINDOW);
  for (let s = winLo; s + len - 1 <= winHi; s++) {
    if (s === v.range[0]) continue; // 原位置已在步骤 4 排除
    if (hashRange(nowText, [s, s + len - 1]) === v.src_hash) {
      return judgement(block, 'warning', `引用内容仍在文件中，但已不在原行号范围（现位于第 ${s}–${s + len - 1} 行）`, {
        currentSource: rangeLines(nowText, [s, s + len - 1]).join('\n'),
      });
    }
  }

  // ---- 步骤 6：相似度分段判定 ----
  let oldText: string | null;
  try {
    oldText = await showText(repo, v.commit, v.path);
  } catch (e) {
    if (e instanceof SourceEncodingError) {
      return errorJudgement(block, `来源不是 UTF-8 文本: ${v.path}`);
    }
    throw e;
  }
  if (oldText === null) {
    return errorJudgement(block, '无法回溯来源版本');
  }

  const oldRange = rangeLines(oldText, v.range);
  const newRange = rangeLines(nowText, v.range);
  const { sim, mode, threshold } = similarity(oldRange, newRange, len);
  if (sim < threshold) {
    return errorJudgement(block, '引用目标已被整体重写或删除');
  }

  const diff = recordChanges(oldRange, newRange, v.range[0]);
  return judgement(block, 'warning', '引用范围内内容已变化', {
    changes: diff.changes,
    changes_omitted: diff.omitted,
    currentSource: newRange.join('\n'),
  });
}

/**
 * 逐块判定：**块之间不共享状态**（题面"片段级独立"）。
 * 单块判定抛错（如来源是二进制、git 异常）不影响其它块 —— 记为该块 error，继续。
 */
export async function judgeDoc(parsed: ParsedGmd, repo: string, opts: JudgeOptions = {}): Promise<BlockJudgement[]> {
  const out: BlockJudgement[] = [];
  for (const block of parsed.blocks) {
    try {
      out.push(await judgeBlock(block, repo, opts));
    } catch (e) {
      const msg = e instanceof GitError ? e.message : e instanceof Error ? e.message : String(e);
      out.push(errorJudgement(block, `判定失败: ${msg}`));
    }
  }
  return out;
}

export function worstSeverity(judgements: BlockJudgement[]): Severity {
  if (judgements.some((j) => j.severity === 'error')) return 'error';
  if (judgements.some((j) => j.severity === 'warning')) return 'warning';
  return 'ok';
}
