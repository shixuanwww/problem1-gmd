/**
 * 输出渲染（PLAN §4.3 / §4.6 / §4.8 / §4.9）。
 *
 * 两套输出：**冲突视图**（默认，给人/AI 看：严重度 + 变更点 + 来源当前内容 + 下一命令建议）
 * 与 **`--json` 单行结构化**（便于 jq / AI 解析）。
 * `--plain` 只出正文（题面："默认冲突视图，可切换为只出正文"）。
 */

import type { BlockJudgement, ChangePoint, GmdBlock, GmdDoc, GmdVersion, ParsedGmd } from './types.ts';
import type { CommitRecord } from './gitrepo.ts';

export const SEVERITY_MARK: Record<string, string> = {
  ok: '[ok]',
  warning: '[warning]',
  error: '[error]',
};

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

export function shortHash(h: string): string {
  const m = /^sha256:([0-9a-f]+)$/.exec(h);
  return m ? `sha256:${m[1].slice(0, 8)}…` : h;
}

/** 严重度 → 题面规定的 AI 动作。 */
export function actionOf(severity: string): string {
  if (severity === 'ok') return '直接用';
  if (severity === 'warning') return '自己判断：接受或重写（工具不猜）';
  return '必须重写（工具刻意隐藏旧文字）';
}

function indentLines(text: string, prefix: string): string[] {
  return text.split('\n').map((l) => prefix + l);
}

function renderChanges(changes: ChangePoint[], omitted: number): string[] {
  const out: string[] = [];
  changes.forEach((c) => {
    const head = `  L${c.line}`;
    const before = c.before === null ? '（当时不存在）' : c.before;
    const after = c.after === null ? '（已删除）' : c.after;
    out.push(`${head}  记录时: ${before}`);
    out.push(`${' '.repeat(head.length)}  当前:   ${after}`);
  });
  if (omitted > 0) out.push(`  ... 其余 ${omitted} 处变更略`);
  return out;
}

export interface ReadViewOptions {
  repo: string;
  docRel: string;
  docPath: string;
}

/** 冲突视图（人类可读）。error 块必须附「追查入口」。 */
export function renderReadView(doc: GmdDoc, judgements: BlockJudgement[], opts: ReadViewOptions): string {
  const lines: string[] = [];
  const nOk = judgements.filter((j) => j.severity === 'ok').length;
  const nWarn = judgements.filter((j) => j.severity === 'warning').length;
  const nErr = judgements.filter((j) => j.severity === 'error').length;

  lines.push(`# gmd read — ${opts.docRel}`);
  lines.push(`doc_id ${doc.doc_id}  ·  created_at ${doc.created_at}`);
  lines.push(`repo   ${opts.repo}`);
  lines.push(`片段   ${judgements.length} 个：${nOk} ok · ${nWarn} warning · ${nErr} error`);
  lines.push('');

  for (const j of judgements) {
    lines.push(`${SEVERITY_MARK[j.severity]} ${j.id}  rev ${j.rev}`);
    lines.push(`  来源   ${j.source.path}:${j.source.range[0]}-${j.source.range[1]} @ ${shortSha(j.source.commit)}`);
    lines.push(`  原因   ${j.reason}`);
    lines.push(`  动作   ${actionOf(j.severity)}`);
    if (j.dirty) {
      lines.push('  状态   引用范围内有未提交修改 ⇒ 禁止写回（writable=false）');
    }

    if (j.changes.length > 0 || (j.changes_omitted ?? 0) > 0) {
      lines.push(`  变更点 ${j.changes.length + (j.changes_omitted ?? 0)} 处:`);
      lines.push(...renderChanges(j.changes, j.changes_omitted ?? 0));
    }

    if (j.currentSource !== null) {
      lines.push(`  当前内容 (${j.source.path}:${j.source.range[0]}-${j.source.range[1]}):`);
      lines.push(...indentLines(j.currentSource, '    | '));
    } else if (j.severity === 'error') {
      lines.push('  当前内容 已刻意隐藏（引用目标已不在；留着旧文字会诱导补丁式修改）');
    }

    if (j.severity === 'error') {
      lines.push(`  追查   gmd log ${opts.docRel} --path ${j.source.path}`);
      lines.push(`         git -C ${opts.repo} log -- ${j.source.path}`);
    } else if (j.severity === 'warning') {
      lines.push(`  下一步 gmd edit ${opts.docRel} --block ${j.id}`);
      lines.push(`         gmd log ${opts.docRel} --block ${j.id} --path ${j.source.path}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** `--plain`：只出正文（不给 --block 时按块顺序输出，空行分隔）。 */
export function renderPlainBody(parsed: ParsedGmd, blockId?: string): string {
  const blocks = blockId === undefined ? parsed.blocks : parsed.blocks.filter((b) => b.id === blockId);
  return blocks.map((b) => b.text).join('\n\n');
}

export function renderLogBlock(docRel: string, block: GmdBlock): string {
  const lines: string[] = [`# gmd log — ${docRel} · 片段 ${block.id}（${block.hist.length} 个版本）`];
  for (const v of block.hist) {
    lines.push(
      `  rev ${v.rev}  ${v.at}  ${v.path}:${v.range[0]}-${v.range[1]}  ${shortSha(v.commit)}  ${shortHash(v.src_hash)}` +
        (v.note ? `   note=${v.note}` : ''),
    );
  }
  return lines.join('\n');
}

export function renderLogPath(docRel: string, srcPath: string, commits: CommitRecord[], note?: string): string {
  const lines: string[] = [
    `# gmd log --path ${srcPath} — ${docRel} · ${commits.length} 个提交（AI 无需自己调用 git）`,
  ];
  if (note) lines.push(`  ※ ${note}`);
  for (const c of commits) {
    lines.push(`  ${shortSha(c.sha)}  ${c.at}  ${c.subject}`);
  }
  return lines.join('\n');
}

export function renderDocSummary(docRel: string, judgements: BlockJudgement[]): string {
  const lines: string[] = [`# gmd log — ${docRel} · 文档级汇总`];
  for (const j of judgements) {
    lines.push(`  ${j.id}  rev ${j.rev}  ${j.severity}  ${j.source.path}:${j.source.range[0]}-${j.source.range[1]}`);
  }
  return lines.join('\n');
}

/** `--json` 契约：单行合法 JSON（JSON.parse 必成功）。 */
export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export function versionToJson(v: GmdVersion): Record<string, unknown> {
  const out: Record<string, unknown> = {
    rev: v.rev,
    at: v.at,
    path: v.path,
    range: v.range,
    commit: v.commit,
    src_hash: v.src_hash,
    text_hash: v.text_hash,
  };
  // 可选扩展（与 `changes_omitted` 同一先例）：**仅在存在时**附加，不改变无 note 时的形状。
  // 为什么必要：§4.6.2 要求 `--allow-dirty` 写回时把 `based_on_dirty` 记进版本的 `note`，
  // 那是"此版本基于未提交来源"的**机器可读审计标记**；只在人类可读视图里显示，
  // 用 `--json` 的 AI 就分辨不出这一版是不是脏来源产物。
  if (typeof v.note === 'string') out.note = v.note;
  return out;
}

/** 给 `read --json` 用的块序列化（保留 §3.3 全部字段）。 */
export function judgementToJson(j: BlockJudgement): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: j.id,
    severity: j.severity,
    rev: j.rev,
    source: j.source,
    reason: j.reason,
    dirty: j.dirty,
    writable: j.writable,
    changes: j.changes,
    currentSource: j.currentSource,
  };
  if (j.changes_omitted !== undefined) out.changes_omitted = j.changes_omitted;
  return out;
}
