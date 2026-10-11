/**
 * 行级差异（PLAN §4.5）。
 *
 * 刻意**不做** LCS 最优编辑脚本：按行号逐行比对即可，输出稳定、可复现，
 * 且对「行号漂移」这类场景本来就不该由 diff 负责（那是判定引擎 §4.3 步骤 5 的事）。
 */

import type { ChangePoint } from './types.ts';

/** changes 的输出上限（PLAN §11）。 */
export const MAX_CHANGES = 20;

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
      changes.push({ line: startLine + i, before, after });
    }
  }
  return { changes, omitted: total - changes.length, total };
}
