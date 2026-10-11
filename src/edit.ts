/**
 * `gmd edit` —— 生成草稿文件（PLAN §4.6.1，阶段 3 的第一步）。
 *
 * 草稿 = `<!-- gmd:draft {...} -->` 头 + 当前正文。
 * 它写在 `<repo>/.gmd/tmp/` 下，是**唯一允许的临时产物**：可随时删除，判定从不读它
 *   ⇒ 不违反题面"不依赖旁车文件、索引、数据库或文件名"（草稿不是元数据载体）。
 * 目标已存在时**覆盖**并打印提示（不静默追加编号）。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { BlockJudgement, GmdBlock } from './types.ts';
import { escapeDashes } from './format.ts';

/** 相对仓库根的草稿目录。 */
export const DRAFT_DIR = '.gmd/tmp';
/** 草稿头前缀（commit 侧据此剥离）。 */
export const DRAFT_PREFIX = '<!-- gmd:draft ';
export const DRAFT_SUFFIX = ' -->';

export interface DraftHeader {
  doc: string;
  block: string;
  base_rev: number;
  at: string;
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 草稿路径规则（PLAN §4.6.1 / §11）：分隔符→下划线 + 文档绝对路径摘要前 8 位 + 片段 id。 */
export function draftPathFor(repo: string, docRel: string, blockId: string): string {
  const escaped = docRel.split(/[\\/]/).join('_');
  const digest = createHash('sha256').update(path.resolve(repo, docRel), 'utf8').digest('hex').slice(0, 8);
  return path.join(repo, DRAFT_DIR, `${escaped}-${digest}-${blockId}.draft.md`);
}

export function renderDraftHead(header: DraftHeader): string {
  // 草稿头同样是 HTML 注释：JSON 里的裸 `--` 必须转义（与 .gmd 元数据同一规则），
  // 否则文档路径/片段名含 `--` 时注释会提前闭合。JSON.parse 会把 \u002d 还原。
  return `${DRAFT_PREFIX}${escapeDashes(JSON.stringify(header))}${DRAFT_SUFFIX}`;
}

export interface EditResult {
  draftPath: string;
  overwritten: boolean;
  judgement: BlockJudgement;
}

export function writeDraft(
  repo: string,
  docRel: string,
  block: GmdBlock,
  judgement: BlockJudgement,
  at: string = nowIso(),
): EditResult {
  const draftPath = draftPathFor(repo, docRel, block.id);
  const overwritten = existsSync(draftPath);
  mkdirSync(path.dirname(draftPath), { recursive: true });
  const head = renderDraftHead({ doc: docRel, block: block.id, base_rev: block.hist[block.hist.length - 1].rev, at });
  writeFileSync(draftPath, `${head}\n${block.text}\n`, 'utf8');
  return { draftPath, overwritten, judgement };
}

export interface StrippedInput {
  /** 是否带草稿头。 */
  hadHeader: boolean;
  header: DraftHeader | null;
  /** 新正文 = 输入去掉草稿头之后的内容（再做首尾各去一个换行）。 */
  body: string;
  /** 草稿头 JSON 解析失败时的原因。 */
  headerError: string | null;
}

/** `commit` 步骤 0：剥离并解析草稿头，定义"新正文"。 */
export function stripDraftHeader(input: string): StrippedInput {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (!text.startsWith(DRAFT_PREFIX)) {
    return { hadHeader: false, header: null, body: trimOneNewline(text), headerError: null };
  }
  const end = text.indexOf(DRAFT_SUFFIX, DRAFT_PREFIX.length);
  if (end < 0) {
    return { hadHeader: true, header: null, body: '', headerError: '草稿头缺少结尾标记' };
  }
  const json = text.slice(DRAFT_PREFIX.length, end).trim();
  let header: DraftHeader;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是对象');
    header = parsed as DraftHeader;
  } catch (e) {
    return {
      hadHeader: true,
      header: null,
      body: '',
      headerError: `草稿头不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (typeof header.doc !== 'string' || typeof header.block !== 'string' || typeof header.base_rev !== 'number') {
    return { hadHeader: true, header: null, body: '', headerError: '草稿头缺少 doc / block / base_rev 字段' };
  }
  let rest = text.slice(end + DRAFT_SUFFIX.length);
  rest = trimOneNewline(rest);
  return { hadHeader: true, header, body: rest, headerError: null };
}

/** 去掉首尾各一个换行（与 PLAN §4.1 正文归一化同口径）。 */
export function trimOneNewline(text: string): string {
  let out = text;
  if (out.startsWith('\r\n')) out = out.slice(2);
  else if (out.startsWith('\n') || out.startsWith('\r')) out = out.slice(1);
  if (out.endsWith('\r\n')) out = out.slice(0, -2);
  else if (out.endsWith('\n') || out.endsWith('\r')) out = out.slice(0, -1);
  return out;
}
