/**
 * .gmd 数据契约（PLAN §3.3）。
 *
 * ⚠️ 本文件只放类型与一个错误类，不含逻辑 —— 保证 `node --experimental-strip-types`
 * 能把它整体擦除。禁 `enum` / `namespace` / 装饰器 / 构造函数参数属性。
 */

// ---------- 版本（片段的一次生成记录）----------
export interface GmdVersion {
  rev: number; // 单调递增，从 1 开始；= hist 下标 + 1
  at: string; // ISO8601 UTC，生成时刻
  path: string; // 源文件路径，相对仓库根，正斜杠
  range: [number, number]; // 1-based 闭区间 [l0, l1]，l0 <= l1
  commit: string; // 记录时的仓库 HEAD commit 全 sha（= git rev-parse HEAD）
  src_hash: string; // "sha256:<hex>" —— 该 range 内文本的摘要
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
}

// ---------- 片段 ----------
export interface GmdBlock {
  id: string; // 稳定标识，文件内唯一；^[A-Za-z0-9_-]{1,64}$
  hist: GmdVersion[]; // 只追加，长度 >= 1
  text: string; // 活动版本的正文（hist 最后一条对应的正文）
  lineStart: number; // 解析信息：块起始行（报错用）
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
}

// ---------- 判定（PLAN §4.3）----------
export type Severity = 'ok' | 'warning' | 'error';

export interface ChangePoint {
  line: number; // 源文件当前行号
  before: string | null; // 记录时该行（null = 当时不存在）
  after: string | null; // 当前该行（null = 已删除）
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
