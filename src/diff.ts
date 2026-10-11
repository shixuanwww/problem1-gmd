/**
 * 行级差异（PLAN §4.5）。
 *
 * 刻意**不做** LCS 最优编辑脚本：按行号逐行比对即可，输出稳定、可复现，
 * 且对「行号漂移」这类场景本来就不该由 diff 负责（那是判定引擎 §4.3 步骤 5 的事）。
 */

import type { ChangePoint } from './types.ts';

/** changes 的输出上限（PLAN §11）。 */
export const MAX_CHANGES = 20;
/** 单个变更行的字符上限：超过就截断（超长行会把冲突视图撑到 MB 级）。 */
export const MAX_CHANGE_LINE_CHARS = 200;

/**
 * 有界预览：超长文本不能原样进入**给 AI 的输出**。
 *
 * 为什么必需：这份输出是给模型读的。一行 300KB 的生成文件（minified bundle / 单行 JSON）
 * 会让 `read` 的冲突视图与 `--json` 各吐 ~900KB（变更点 before+after + currentSource），
 * 既烧上下文、模型又没法用。截断是**保功能**而不是省事：判定与哈希全部基于原文，
 * 只有"给人/AI 看的预览"被截断，并**如实带上原始字符数**（`*_chars`）。
 *
 * `totalChars` 只对多行文本有意义（逐行截断后再限制总长）；单行预览传 lineChars 即可。
 */
export function boundedPreview(
  text: string,
  lineChars: number = MAX_CHANGE_LINE_CHARS,
  totalChars: number = lineChars,
): string {
  if (text.length <= totalChars && !text.split('\n').some((l) => l.length > lineChars)) return text;
  const lines = text.split('\n').map((l) => (l.length > lineChars ? `${l.slice(0, lineChars)}…` : l));
  let out = lines.join('\n');
  if (out.length > totalChars) out = `${out.slice(0, totalChars)}…`;
  return out;
}

export interface ChangeResult {
  changes: ChangePoint[];
  /** 被截断略过的条数（用于渲染 `... 其余 N 处变更略`）。 */
  omitted: number;
  /** 差异总数（截断前）。 */
  total: number;
}

/**
 * 逐行比对。`startLine` = 该段在源文件中的起始行号（1-based，用于填 ChangePoint.line）。
 */
export function recordChanges(oldLines: string[], newLines: string[], startLine: number): ChangeResult {
  const changes: ChangePoint[] = [];
  let total = 0;
  const n = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < n; i++) {
    const before = i < oldLines.length ? oldLines[i] : null;
    const after = i < newLines.length ? newLines[i] : null;
    if (before === after) continue;
    total++;
    if (changes.length < MAX_CHANGES) {
      const point: ChangePoint = { line: startLine + i, before: null, after: null };
      // 超长行**截断后**才进输出，并带上原始字符数（见 boundedPreview 的说明）
      if (before !== null) {
        point.before = boundedPreview(before);
        if (before.length > MAX_CHANGE_LINE_CHARS) point.before_chars = before.length;
      }
      if (after !== null) {
        point.after = boundedPreview(after);
        if (after.length > MAX_CHANGE_LINE_CHARS) point.after_chars = after.length;
      }
      changes.push(point);
    }
  }
  return { changes, omitted: total - changes.length, total };
}
