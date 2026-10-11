/**
 * .gmd 数据契约（PLAN §3.3）。
 *
 * ⚠️ 本文件只放类型与一个错误类，不含逻辑 —— 保证 `node --experimental-strip-types`
 * 能把它整体擦除。禁 `enum` / `namespace` / 装饰器 / 构造函数参数属性。
 */

/**
 * 解析时保留的**未知扩展字段**的挂载点（前向兼容，见 `GmdVersion` / `GmdBlock`）。
 *
 * 为什么用 **Symbol 键**而不是普通字段（如 `extra`）：
 *  1. 不可能与 JSON 里真实存在的字段重名（`extra` 完全可能被将来的格式占用）；
 *  2. `JSON.stringify` **天然忽略 Symbol 键** ⇒ 扩展字段绝不会被顺手序列化出去，
 *     只有 `renderBlockHead` 里那一次**显式合并**能把它写回文件。
 * 代价：`Object.keys()` 看不到它，所以要用 `EXTRAS` 显式取。
 */
export const EXTRAS: unique symbol = Symbol('gmd.extras');

// ---------- 版本（片段的一次生成记录）----------
export interface GmdVersion {
  rev: number; // 单调递增，从 1 开始；= hist 下标 + 1
  at: string; // ISO8601 UTC，生成时刻
  path: string; // 源文件路径，相对仓库根，正斜杠
  range: [number, number]; // 1-based 闭区间 [l0, l1]，l0 <= l1
  commit: string; // 记录时的仓库 HEAD commit 全 sha（= git rev-parse HEAD）
  src_hash: string; // "sha256:<hex>" —— 该 range 内文本的摘要
  /**
   * `src_hash` 的**基准**（阶段 4·1 的收口）：
   *  - `"commit"`（缺省）：`src_hash = hashRange(git show <commit>:<path>, range)`
   *  - `"worktree"`：`src_hash = hashRange(--allow-dirty 当时的工作区文件, range)`
   *
   * 为什么要有这个字段：`--allow-dirty` 写出的版本里 `commit` 记的是 **HEAD**，而 `src_hash`
   * 取的是**脏工作区** —— 两者本就不同源。与其留一个"读者得自己猜"的组合（`git show <commit>`
   * 再按 range 哈希，得到的值与 `src_hash` 对不上），不如把基准写成字段，于是不变式
   * `src_hash === hashRange(该基准下的范围文本, range)` **永远成立、可机器校验**。
   * 字段不存在 = `"commit"`，旧文件语义不变。
   */
  src_base?: 'commit' | 'worktree';
  text_hash: string; // "sha256:<hex>" —— 本片段正文（换行归一化为 \n 后 trim）的摘要
  /**
   * 该版本的**正文**（阶段 4·3）。
   *
   * 为什么存：题面 §2.3 要求"版本历史……全部内嵌于 .gmd"，§2.2 把"历史版本"定义为
   * "同一片段过去生成的版本" —— 只留一个 `text_hash` 等于正文没留，`read --version <rev>`
   * 也就答不出"那一版到底写了什么"。存了之后 `text_hash` 还从"不可验证的承诺"变成
   * **可验证的摘要**（解析时校验 `textHash(text) === text_hash`）。
   * 代价：每追加一版就多存一份正文，文件线性膨胀 —— 这是"单文件自包含"的必要开销。
   *
   * 可选字段：本实现写出的版本**一律带它**；旧格式文件（或手写的 .gmd 骨架）没有时
   * 解析照旧通过，只是那一版取不到正文。
   */
  text?: string;
  note?: string; // 可选备注（序列化时须转义 "--"）
  /** 本工具不认识、但**原样保留**的扩展字段（前向兼容；写回时合并在已知字段之后）。 */
  [EXTRAS]?: Record<string, unknown>;
}

// ---------- 片段 ----------
export interface GmdBlock {
  id: string; // 稳定标识，文件内唯一；^[A-Za-z0-9_-]{1,64}$
  hist: GmdVersion[]; // 只追加，长度 >= 1
  text: string; // 活动版本的正文（hist 最后一条对应的正文）
  lineStart: number; // 解析信息：块起始行（报错用）
  /** 块头里除 `id` / `hist` 之外的扩展字段（前向兼容，原样保留）。 */
  [EXTRAS]?: Record<string, unknown>;
}

/** 可写回的片段形状：解析结果 `GmdBlock` 与 `commit` 新构造的对象都符合它。 */
export interface WireBlock {
  id: string;
  hist: GmdVersion[];
  text: string;
  [EXTRAS]?: Record<string, unknown>;
}

// ---------- 文档 ----------
export interface GmdDoc {
  gmd: 1; // 格式版本
  doc_id: string; // UUID v4，文件名不含它
  created_at: string;
}

export interface ParsedGmd {
  doc: GmdDoc;
  blocks: GmdBlock[]; // 按文件内出现顺序
  raw: string; // 原文，写回时保持块外内容不变
  /**
   * 位于**围栏代码块**内、因此被按字面量忽略、且**不属于任何片段**的 gmd 标记。
   *
   * 为什么要暴露：围栏里的标记一律不当真（见 format.ts 的 scanFenceSpans），于是"用围栏把真片段
   * 包起来"的文档会**静默变成 0 片段**、`read` 还返回成功 —— 对判定工具来说这太安静了。
   * 这里如实报出来，由调用方提示用户（不报错：同一个形态也可能就是"展示格式示例"）。
   * 落在某个片段正文**内部**的（= 合法的格式示例）不计入。
   */
  ignoredInFence: Array<{ line: number; kind: 'doc' | 'block-open' | 'block-close' }>;
}

// ---------- 判定（PLAN §4.3）----------
export type Severity = 'ok' | 'warning' | 'error';

export interface ChangePoint {
  line: number; // 源文件当前行号
  before: string | null; // 记录时该行（null = 当时不存在）
  after: string | null; // 当前该行（null = 已删除）
  /** 该行被截断时，**原始**字符数（仅超长行出现；见 diff.ts 的 boundedPreview）。 */
  before_chars?: number;
  after_chars?: number;
}

export interface BlockJudgement {
  id: string;
  severity: Severity;
  rev: number;
  source: { path: string; range: [number, number]; commit: string };
  reason: string; // 一句话原因（error 时不得含旧文字）
  dirty: boolean; // 引用范围内是否有未提交修改
  writable: boolean; // 是否允许写回：= !dirty && severity !== 'error'
  changes: ChangePoint[]; // warning 时给出变更点；error/ok 时为空数组
  currentSource: string | null; // warning/ok 时的"来源当前内容"；error 时必须为 null
  /** `currentSource` 被截断时，**原始**字符数（仅超长范围出现）。 */
  currentSource_chars?: number;
  /**
   * PLAN §4.5 的截断注记：changes 超过 20 条被截断时，被略过的条数。
   * 属对 §3.3 契约的**可选扩展**（不改变既有字段语义，JSON 解析仍稳定）。
   */
  changes_omitted?: number;
}

// ---------- 格式错误（PLAN §4.1；CLI 须映射为退出码 2）----------
export class GmdFormatError extends Error {
  line: number; // 出错行号（1-based），必须随错误一并给出

  constructor(message: string, line: number) {
    super(message);
    this.name = 'GmdFormatError';
    this.line = line;
  }
}
