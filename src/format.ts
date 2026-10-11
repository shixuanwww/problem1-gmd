/**
 * .gmd 解析 / 序列化（PLAN §3.1 / §3.4 / §4.1）。
 *
 * 解析纪律（不可放宽）：
 *  1. 文件内第一个非空内容必须是 `gmd:doc` 块，否则报错退出；
 *  2. `gmd:block` / `/gmd:block` 必须成对且不嵌套，未闭合 / 嵌套 / JSON 非法 → 报错并给出行号；
 *  3. JSON 内不得出现裸 `--`（序列化时转义为 \u002d\u002d；解析时注释被提前截断 → JSON 解析失败 → 格式损坏）。
 */

import { EXTRAS, GmdFormatError } from './types.ts';
import type { GmdBlock, GmdDoc, GmdVersion, ParsedGmd, WireBlock } from './types.ts';
// 🔒 路径纪律与 gitrepo 共用**同一份**判定（仓库纪律：一个口径只有一份实现），
// 不在这里另抄一遍。见 gitrepo.ts 的 isRepoRelativePath / resolveInRepo。
import { isRepoRelativePath, textHash } from './gitrepo.ts';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

/** 本工具**认识**的字段；其余一律当扩展字段原样保留（前向兼容）。 */
const KNOWN_VERSION_KEYS = new Set(['rev', 'at', 'path', 'range', 'commit', 'src_hash', 'text_hash', 'text', 'note']);
const KNOWN_BLOCK_KEYS = new Set(['id', 'hist']);

/**
 * 收集 `src` 里本工具不认识的字段（前向兼容：不认识 ≠ 丢弃）。
 *
 * 🔒 用 `Object.defineProperty` 而不是 `bag[k] = v`：`JSON.parse('{"__proto__":{...}}')` 会造出
 * 一个**自有**属性 `__proto__`，而普通赋值会走它的 setter、直接改写原型链。这里只建自有属性。
 */
function collectExtras(src: Record<string, unknown>, known: Set<string>): Record<string, unknown> | null {
  let bag: Record<string, unknown> | null = null;
  for (const key of Object.keys(src)) {
    if (known.has(key)) continue;
    if (bag === null) bag = {};
    Object.defineProperty(bag, key, { value: src[key], enumerable: true, writable: true, configurable: true });
  }
  return bag;
}

/** 已知字段在前、扩展字段在后（合并顺序即序列化后的键序，稳定可复现）。 */
function mergeExtras(base: Record<string, unknown>, extras: Record<string, unknown> | undefined): Record<string, unknown> {
  return extras === undefined ? base : { ...base, ...extras };
}

/** 匹配三种标记：doc / block 开 / block 闭。JSON 允许跨多行。 */
const MARKER_RE = /<!--\s*(\/?)\s*gmd:(doc|block)\b\s*([\s\S]*?)-->/g;

/**
 * **已闭合**的围栏代码块（``` / ~~~）覆盖的字符区间。
 *
 * 为什么需要：题面要求「普通 Markdown 阅读体验不应被明显破坏」。一份**讲 .gmd 格式本身**的
 * 文档必然会在围栏代码块里写出 `<!-- gmd:block ... -->` 这类**字面量**；若把它们当真标记，
 * 合法文档会被判成「片段嵌套 / 未闭合」（退出码 2）—— 工具连自己都没法写文档。
 * 只承认**已闭合**的围栏：正文里一个没配对的围栏不得把后面真正的块标记一起吞掉。
 */
function scanFenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  let pos = 0;
  let open: { ch: string; len: number; start: number } | null = null;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd).replace(/\r$/, '');
    if (open === null) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (m !== null) open = { ch: m[1][0], len: m[1].length, start: pos };
    } else if (new RegExp(`^ {0,3}${open.ch}{${open.len},}\\s*$`).test(line)) {
      spans.push({ start: open.start, end: lineEnd });
      open = null;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return spans;
}

function insideSpans(spans: Span[], offset: number): boolean {
  return spans.some((s) => offset >= s.start && offset < s.end);
}

export const BLOCK_CLOSE = '<!-- /gmd:block -->';

interface Marker {
  kind: 'doc' | 'block-open' | 'block-close';
  json: string;
  start: number; // `<!--` 的偏移
  end: number; // `-->` 之后一位
  line: number; // 1-based
}

/** 把 `\r\n` / 孤立 `\r` 归一化为 `\n`（PLAN §3.4 写盘口径）。 */
export function normalizeNewlines(text: string): string {
  return text.split(/\r\n|\r|\n/).join('\n');
}

/**
 * 🔒 片段正文归一化的**唯一实现**（PLAN §4.1）：先归一化换行（CRLF / 孤立 CR → LF），
 * 再去掉首尾各一个换行。**解析（parseGmd）与写回（commit）必须共用它** ——
 * 否则 edit→commit 的往返会多出/少掉空行，`text_hash` 与块外观都会漂移。
 */
export function normalizeBlockBody(text: string): string {
  let b = normalizeNewlines(text);
  if (b.startsWith('\n')) b = b.slice(1);
  if (b.endsWith('\n')) b = b.slice(0, -1);
  return b;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') line++;
    else if (text[i] === '\r' && text[i + 1] !== '\n') line++;
  }
  return line;
}

/** 第一个含非空白字符的行号（1-based）；全文空白时返回 1。 */
function firstNonEmptyLine(text: string): number {
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) return i + 1;
  }
  return 1;
}

function scanMarkers(text: string): Marker[] {
  const fences = scanFenceSpans(text);
  const out: Marker[] = [];
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(text)) !== null) {
    // 围栏代码块里的字面量不是标记（见 scanFenceSpans 的说明）。
    if (insideSpans(fences, m.index)) continue;
    const isClose = m[1] === '/';
    const name = m[2];
    out.push({
      kind: name === 'doc' ? 'doc' : isClose ? 'block-close' : 'block-open',
      json: m[3].trim(),
      start: m.index,
      end: m.index + m[0].length,
      line: lineOf(text, m.index),
    });
  }
  return out;
}

function parseJsonObject(json: string, what: string, line: number): Record<string, unknown> {
  if (json.length === 0) {
    throw new GmdFormatError(`${what}缺少 JSON 元数据`, line);
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new GmdFormatError(`${what}的 JSON 非法: ${msg}`, line);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GmdFormatError(`${what}的 JSON 必须是对象`, line);
  }
  return value as Record<string, unknown>;
}

function validateVersion(raw: unknown, index: number, line: number): GmdVersion {
  const where = `片段 hist[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GmdFormatError(`${where} 必须是对象`, line);
  }
  const v = raw as Record<string, unknown>;
  const rev = v.rev;
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev !== index + 1) {
    throw new GmdFormatError(`${where}.rev 必须从 1 起且连续（此处应为 ${index + 1}）`, line);
  }
  const { at, path, range, commit, src_hash, text_hash, note } = v as {
    at?: unknown;
    path?: unknown;
    range?: unknown;
    commit?: unknown;
    src_hash?: unknown;
    text_hash?: unknown;
    note?: unknown;
  };
  if (typeof at !== 'string' || at.length === 0) {
    throw new GmdFormatError(`${where}.at 必须是非空字符串`, line);
  }
  // 🔒 安全闸门（不是洁癖）：`.gmd` 是给 AI 读的、可能由模型生成。若放任 `path: "../../x"`，
  // 一份文档就能让 `gmd read` 把仓库外的任意文件内容当「来源当前内容」打印出来。
  if (typeof path !== 'string' || !isRepoRelativePath(path)) {
    throw new GmdFormatError(
      `${where}.path 必须是仓库内的相对正斜杠路径（不得是绝对路径 / 盘符，且不得含 .. / . / 空段）`,
      line,
    );
  }
  if (
    !Array.isArray(range) ||
    range.length !== 2 ||
    range.some((n) => typeof n !== 'number' || !Number.isInteger(n))
  ) {
    throw new GmdFormatError(`${where}.range 必须是 [l0, l1] 两个整数`, line);
  }
  const [l0, l1] = range as [number, number];
  if (l0 < 1 || l1 < l0) {
    throw new GmdFormatError(`${where}.range 必须是 1-based 闭区间且 l0 <= l1`, line);
  }
  if (typeof commit !== 'string' || commit.length === 0) {
    throw new GmdFormatError(`${where}.commit 必须是非空字符串`, line);
  }
  if (typeof src_hash !== 'string' || !HASH_RE.test(src_hash)) {
    throw new GmdFormatError(`${where}.src_hash 必须是 "sha256:<64 位小写 hex>"`, line);
  }
  if (typeof text_hash !== 'string' || !HASH_RE.test(text_hash)) {
    throw new GmdFormatError(`${where}.text_hash 必须是 "sha256:<64 位小写 hex>"`, line);
  }
  // 历史正文（可选）：写出的版本一律带；旧格式文件没有也合法。
  // 🔒 带它就必须自洽 —— 这是 `text_hash` 从"不可验证的承诺"变成"可验证摘要"的关键：
  // 否则一份手改过 hist[].text 的文档能一路读到 `read --version` 才暴露。
  let text: string | undefined;
  if (v.text !== undefined) {
    if (typeof v.text !== 'string') {
      throw new GmdFormatError(`${where}.text 若存在必须是字符串`, line);
    }
    if (textHash(v.text) !== text_hash) {
      throw new GmdFormatError(`${where}.text 与 ${where}.text_hash 不一致（历史正文必须自洽）`, line);
    }
    text = v.text;
  }
  if (note !== undefined && typeof note !== 'string') {
    throw new GmdFormatError(`${where}.note 若存在必须是字符串`, line);
  }
  const out: GmdVersion = { rev, at, path, range: [l0, l1], commit, src_hash, text_hash };
  if (typeof text === 'string') out.text = text;
  if (typeof note === 'string') out.note = note;
  // 前向兼容：本工具不认识的字段**原样留着**，写回时再合并回去（不做静默丢弃）。
  const extras = collectExtras(v, KNOWN_VERSION_KEYS);
  if (extras !== null) out[EXTRAS] = extras;
  return out;
}

/** 严格解析：任何异常都抛 GmdFormatError（带行号），绝不跳过一个坏块继续。 */
export function parseGmd(raw: string): ParsedGmd {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const markers = scanMarkers(text);

  if (markers.length === 0 || markers[0].kind !== 'doc') {
    throw new GmdFormatError('文件内第一个非空内容必须是 gmd:doc 块', firstNonEmptyLine(text));
  }
  if (text.slice(0, markers[0].start).trim().length > 0) {
    throw new GmdFormatError('gmd:doc 块之前不允许出现内容（必须位于文件最前）', markers[0].line);
  }

  const docRaw = parseJsonObject(markers[0].json, '文档头', markers[0].line);
  if (docRaw.gmd !== 1) {
    throw new GmdFormatError('文档头的 gmd 字段必须为 1', markers[0].line);
  }
  if (typeof docRaw.doc_id !== 'string' || docRaw.doc_id.length === 0) {
    throw new GmdFormatError('文档头缺少 doc_id', markers[0].line);
  }
  if (typeof docRaw.created_at !== 'string' || docRaw.created_at.length === 0) {
    throw new GmdFormatError('文档头缺少 created_at', markers[0].line);
  }
  const doc: GmdDoc = { gmd: 1, doc_id: docRaw.doc_id, created_at: docRaw.created_at };

  const blocks: GmdBlock[] = [];
  const seenIds = new Set<string>();
  let open: Marker | null = null;

  for (let i = 1; i < markers.length; i++) {
    const mk = markers[i];
    if (mk.kind === 'doc') {
      throw new GmdFormatError('gmd:doc 块只能有一个', mk.line);
    }
    if (mk.kind === 'block-open') {
      if (open !== null) {
        throw new GmdFormatError('片段嵌套：上一个 gmd:block 尚未闭合', mk.line);
      }
      open = mk;
      continue;
    }
    // block-close
    if (open === null) {
      throw new GmdFormatError('未匹配的 /gmd:block（没有对应的 gmd:block 开头）', mk.line);
    }
    const head = parseJsonObject(open.json, '片段头部', open.line);
    if (typeof head.id !== 'string' || !ID_RE.test(head.id)) {
      throw new GmdFormatError('片段 id 必须是 1–64 位的 [A-Za-z0-9_-]', open.line);
    }
    if (seenIds.has(head.id)) {
      throw new GmdFormatError(`片段 id 重复: ${head.id}`, open.line);
    }
    seenIds.add(head.id);
    if (!Array.isArray(head.hist) || head.hist.length === 0) {
      throw new GmdFormatError(`片段 ${head.id} 的 hist 必须是非空数组`, open.line);
    }
    const hist = head.hist.map((h: unknown, idx: number) => validateVersion(h, idx, open!.line));

    // 正文 = 两标记之间的全部内容，去掉首尾各一个换行（与 commit 共用唯一实现）
    const body = normalizeBlockBody(text.slice(open.end, mk.start));

    const block: GmdBlock = { id: head.id, hist, text: body, lineStart: open.line };
    // 块头里除 id / hist 之外的字段同样原样保留（前向兼容）
    const blockExtras = collectExtras(head, KNOWN_BLOCK_KEYS);
    if (blockExtras !== null) block[EXTRAS] = blockExtras;
    blocks.push(block);
    open = null;
  }

  if (open !== null) {
    throw new GmdFormatError('gmd:block 未闭合（缺少 <!-- /gmd:block -->）', open.line);
  }

  return { doc, blocks, raw };
}

// ---------------------------------------------------------------------------
// 序列化（写文件侧，PLAN §3.4）
// ---------------------------------------------------------------------------

/** HTML 注释内不允许裸 `--`：只对 JSON 字面量做转义，正文不动。 */
export function escapeDashes(json: string): string {
  return json.replace(/--/g, '\\u002d\\u002d');
}

export function renderDocHead(doc: GmdDoc): string {
  return `<!-- gmd:doc ${escapeDashes(JSON.stringify(doc))} -->`;
}

/** 一条版本记录的**线上形状**：已知字段按固定顺序在前，扩展字段合并在后。 */
function wireVersion(v: GmdVersion): Record<string, unknown> {
  const base: Record<string, unknown> = {
    rev: v.rev,
    at: v.at,
    path: v.path,
    range: v.range,
    commit: v.commit,
    src_hash: v.src_hash,
    text_hash: v.text_hash,
  };
  if (typeof v.text === 'string') base.text = v.text;
  if (typeof v.note === 'string') base.note = v.note;
  return mergeExtras(base, v[EXTRAS]);
}

export function renderBlockHead(id: string, hist: GmdVersion[], extras?: Record<string, unknown>): string {
  return `<!-- gmd:block ${escapeDashes(JSON.stringify(mergeExtras({ id, hist: hist.map(wireVersion) }, extras)))} -->`;
}

export function renderBlock(block: WireBlock): string {
  return `${renderBlockHead(block.id, block.hist, block[EXTRAS])}\n${block.text}\n${BLOCK_CLOSE}`;
}

/** 从零拼一份 .gmd（供 fixture 脚本与 README「快速开始」的最小骨架使用）。 */
export function buildGmd(
  doc: GmdDoc,
  blocks: WireBlock[],
  tail = '',
): string {
  const parts = [renderDocHead(doc), ''];
  for (const b of blocks) parts.push(renderBlock(b), '');
  if (tail.length > 0) parts.push(tail);
  return normalizeNewlines(parts.join('\n'));
}

interface Span {
  start: number;
  end: number;
}

function scanBlockSpans(text: string): Span[] {
  const markers = scanMarkers(text);
  const spans: Span[] = [];
  let open: Marker | null = null;
  for (const mk of markers) {
    if (mk.kind === 'block-open') {
      if (open !== null) throw new GmdFormatError('片段嵌套：上一个 gmd:block 尚未闭合', mk.line);
      open = mk;
    } else if (mk.kind === 'block-close') {
      if (open === null) throw new GmdFormatError('未匹配的 /gmd:block', mk.line);
      spans.push({ start: open.start, end: mk.end });
      open = null;
    }
  }
  if (open !== null) throw new GmdFormatError('gmd:block 未闭合', open.line);
  return spans;
}

/**
 * 就地重写：只替换各片段所占区间（标记 + 正文），**块外文本逐字节保留**（仅把换行统一为 \n）。
 * 片段顺序与个数必须与原文一致（commit 只改内容，不增删片段）。
 *
 * `rewriteIds`：只重写这些 id 的片段，其它片段**按原文逐字节拷贝**。
 * 为什么要有它：重渲染会把块头 JSON 规范成"已知字段在前的紧凑形式"，
 * 于是"改一个块"会顺手改写**其它块**的元数据行（键序变化、扩展字段被规范化）——
 * 那既让 diff 变脏，也和"commit 只改目标片段"的说法不符。不传 = 全部重写（建新文档时用）。
 */
export function serializeGmd(raw: string, blocks: WireBlock[], rewriteIds?: readonly string[]): string {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const spans = scanBlockSpans(text);
  if (spans.length !== blocks.length) {
    throw new GmdFormatError('内部错误：原文片段数与待写入片段数不一致', 1);
  }
  let out = '';
  let cursor = 0;
  for (let i = 0; i < spans.length; i++) {
    out += text.slice(cursor, spans[i].start);
    const rewrite = rewriteIds === undefined || rewriteIds.includes(blocks[i].id);
    out += rewrite ? renderBlock(blocks[i]) : text.slice(spans[i].start, spans[i].end);
    cursor = spans[i].end;
  }
  out += text.slice(cursor);
  return normalizeNewlines(out);
}
