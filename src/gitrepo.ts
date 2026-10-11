/**
 * git 适配层（PLAN §4.3 / §4.8 / §2.1）。
 *
 * 纪律：
 *  - 一律 `git -C <repo>`（不依赖 process.cwd()，否则 --repo 形同虚设）；
 *  - 一律设超时（默认 15s），超时视为环境错误（退出码 5）；
 *  - 换行归一化 / 范围摘要 / 正文摘要各**只有一份实现**（normalizeEol / hashRange / textHash），
 *    fixture 脚本与判定引擎必须共用它们。
 *
 * 注：本文件用**异步** spawn（不用 spawnSync）—— Node 里同步派生子进程在部分受限环境下
 * 会直接 EBUSY 失败，异步通道没有这个限制，且天然支持超时。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const GIT_TIMEOUT_MS = 15000;

export interface GitRunResult {
  status: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  spawnError: NodeJS.ErrnoException | null;
}

/** 来源文件不是合法 UTF-8 文本（或含 NUL 字节 = 二进制）。 */
export class SourceEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceEncodingError';
  }
}

/** git 子进程非零退出 / 超时 / 起不来。 */
export class GitError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError: NodeJS.ErrnoException | null;

  constructor(message: string, opts: { exitCode: number | null; stderr: string; timedOut?: boolean; spawnError?: NodeJS.ErrnoException | null }) {
    super(message);
    this.name = 'GitError';
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
    this.timedOut = opts.timedOut === true;
    this.spawnError = opts.spawnError ?? null;
  }
}

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------

export async function runGit(
  repo: string | null,
  args: string[],
  opts: { timeoutMs?: number; allowNonZero?: boolean; env?: Record<string, string> } = {},
): Promise<GitRunResult> {
  const argv = repo === null ? args : ['-C', repo, ...args];
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;

  return await new Promise<GitRunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    const done = (r: GitRunResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }
    };

    let child;
    try {
      child = spawn('git', argv, {
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env ?? {}) },
      });
    } catch (e) {
      resolve({
        status: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        timedOut: false,
        spawnError: e as NodeJS.ErrnoException,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => {
      done({
        status: null,
        signal: null,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        timedOut,
        spawnError: e as NodeJS.ErrnoException,
      });
    });
    child.on('close', (code, signal) => {
      done({
        status: code,
        signal: signal ?? null,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        timedOut,
        spawnError: null,
      });
    });
  });
}

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

/** 宽松解码（只用于给人看的报错信息，不参与判定）。 */
export function decodeLoose(buf: Buffer): string {
  return buf.toString('utf8');
}

/** 严格 UTF-8 解码：非法字节或含 NUL → SourceEncodingError。 */
export function decodeStrict(buf: Buffer): string {
  if (buf.includes(0)) throw new SourceEncodingError('内容包含 NUL 字节（二进制）');
  try {
    return UTF8_STRICT.decode(buf);
  } catch {
    throw new SourceEncodingError('内容不是合法 UTF-8');
  }
}

function ensureOk(res: GitRunResult, what: string, repo: string | null): GitRunResult {
  if (res.timedOut) {
    throw new GitError(`${what} 超时（> ${GIT_TIMEOUT_MS}ms）`, { exitCode: null, stderr: '', timedOut: true, spawnError: res.spawnError });
  }
  if (res.spawnError) {
    throw new GitError(`${what} 无法启动: ${res.spawnError.message}`, { exitCode: null, stderr: '', spawnError: res.spawnError });
  }
  if (res.status !== 0) {
    const firstErr = decodeLoose(res.stderr).split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
    throw new GitError(
      `${what} 失败（git 退出码 ${res.status}）${firstErr ? `: ${firstErr}` : ''}${repo !== null ? `  [repo=${repo}]` : ''}`,
      { exitCode: res.status, stderr: decodeLoose(res.stderr) },
    );
  }
  return res;
}

// ---------------------------------------------------------------------------
// 换行归一化 / 摘要（各只有一份实现 —— fixture 与 judge 共用）
// ---------------------------------------------------------------------------

/** 🔒 换行归一化的唯一原语：CRLF / LF / 孤立 CR 一律 → LF。 */
export function normalizeEol(text: string): string {
  return text.split(/\r\n|\r|\n/).join('\n');
}

/** 🔒 src_hash 的唯一实现：先归一化换行，再取 [l0,l1]（1-based 闭区间）行，join('\n') 后 sha256。 */
export function hashRange(text: string, [l0, l1]: [number, number]): string {
  const lines = normalizeEol(text).split('\n').slice(l0 - 1, l1);
  return 'sha256:' + createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/** 🔒 text_hash 的唯一实现：先归一化换行，再 trim，再 sha256。 */
export function textHash(text: string): string {
  return 'sha256:' + createHash('sha256').update(normalizeEol(text).trim(), 'utf8').digest('hex');
}

/** 取 [l0,l1] 行（1-based 闭区间，越界自动截断）。仅用于展示与相似度计算，不直接哈希。 */
export function rangeLines(text: string, [l0, l1]: [number, number]): string[] {
  return normalizeEol(text).split('\n').slice(l0 - 1, l1);
}

/** 🔒 dirty 的唯一口径：两边都经 hashRange 归一化后比较 ⇒ 换行差异不构成 dirty。 */
export function isRangeDirtyTexts(nowText: string, headText: string, range: [number, number]): boolean {
  return hashRange(nowText, range) !== hashRange(headText, range);
}

// ---------------------------------------------------------------------------
// 仓库定位 / 文件读取
// ---------------------------------------------------------------------------

export async function gitVersion(): Promise<string | null> {
  const res = await runGit(null, ['--version']);
  if (res.spawnError || res.status !== 0) return null;
  return decodeLoose(res.stdout).trim();
}

/** 从 startDir 向上找含 .git 的目录；找不到返回 null。 */
export function findRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 元数据 / 参数里的来源路径逃出仓库（`..` / 绝对路径 / 盘符）—— 视同格式非法，CLI 映射为退出码 2。 */
export class RepoPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoPathError';
  }
}

/** 是否是可安全解析的仓库相对路径（正斜杠、无盘符与反斜杠、无空段、无 `.` / `..`）。 */
export function isRepoRelativePath(p: string): boolean {
  if (p.length === 0 || p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

/**
 * 把来源相对路径解析为绝对路径，并**确保结果仍在仓库内**。
 *
 * 这是不信任 .gmd 元数据的第二道闸（第一道在 `format.ts` 的 `validateVersion`）：
 * 否则 `path: "../../secret"` 就能让 gmd 读出仓库外的任意文件。
 */
export function resolveInRepo(repo: string, relPath: string): string {
  if (!isRepoRelativePath(relPath)) throw new RepoPathError(`路径必须是仓库内的相对路径: ${relPath}`);
  const root = path.resolve(repo);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new RepoPathError(`路径逃出仓库: ${relPath}`);
  }
  return abs;
}

export function worktreePath(repo: string, relPath: string): string {
  return resolveInRepo(repo, relPath);
}

export function worktreeFileExists(repo: string, relPath: string): boolean {
  try {
    return existsSync(worktreePath(repo, relPath));
  } catch {
    return false;
  }
}

/** 读工作区文件（严格 UTF-8；二进制/非 UTF-8 → SourceEncodingError）。 */
export async function readWorktreeText(repo: string, relPath: string): Promise<string> {
  const buf = await readFile(worktreePath(repo, relPath));
  return decodeStrict(buf);
}

export async function revParseHead(repo: string): Promise<string | null> {
  const res = await runGit(repo, ['rev-parse', 'HEAD']);
  if (res.status !== 0) return null;
  return decodeLoose(res.stdout).trim();
}

/**
 * `git show <commit>:<path>` 的原文。
 * 返回 null 表示该 (commit, path) 组合取不到（路径不在该提交里，或提交不存在）；
 * 内容非 UTF-8 → 抛 SourceEncodingError；git 自身异常 → 抛 GitError。
 */
export async function showText(repo: string, commit: string, relPath: string): Promise<string | null> {
  const res = await runGit(repo, ['show', `${commit}:${relPath}`]);
  if (res.timedOut || res.spawnError) ensureOk(res, `git show ${commit}:${relPath}`, repo);
  if (res.status !== 0) return null;
  return decodeStrict(res.stdout);
}

/**
 * 独立可用的「范围内是否脏」——判定的唯一口径是 isRangeDirtyTexts，
 * 这里只是把两个文本读出来（供 §5 阶段 1 的自检与测试直接调用）。
 */
export async function isRangeDirty(repo: string, relPath: string, range: [number, number]): Promise<boolean> {
  const nowText = await readWorktreeText(repo, relPath);
  const headText = await showText(repo, 'HEAD', relPath);
  if (headText === null) return true; // 工作区有、HEAD 没有 ⇒ 未提交
  return isRangeDirtyTexts(nowText, headText, range);
}

// ---------------------------------------------------------------------------
// 历史查询（PLAN §4.8）
// ---------------------------------------------------------------------------

export interface CommitRecord {
  sha: string;
  short: string;
  at: string;
  subject: string;
}

const LOG_FORMAT = '--pretty=format:%H%x1f%h%x1f%aI%x1f%s';

function parseLog(out: string): CommitRecord[] {
  const rows: CommitRecord[] = [];
  for (const line of out.split('\n')) {
    if (line.trim().length === 0) continue;
    const parts = line.split('\x1f');
    if (parts.length < 4) continue;
    rows.push({ sha: parts[0], short: parts[1], at: parts[2], subject: parts.slice(3).join('\x1f') });
  }
  return rows;
}

/** 某个来源文件的提交历史（题面阶段 2 的「追查入口」：AI 无需自己调用 git）。 */
export async function historyForPath(repo: string, relPath: string): Promise<CommitRecord[]> {
  resolveInRepo(repo, relPath); // 路径必须落在仓库内（结果不用，只做校验）
  const res = await runGit(repo, ['log', LOG_FORMAT, '--', relPath]);
  ensureOk(res, `git log -- ${relPath}`, repo);
  return parseLog(decodeLoose(res.stdout));
}

/**
 * 触及某范围的提交（`git log -L a,b:<path>` 的简化解析）。
 * 调用前**必须先判** b <= 当前文件行数（否则 git 会 fatal 退出，码 128）。
 */
export async function commitsTouchingRange(repo: string, relPath: string, a: number, b: number): Promise<CommitRecord[]> {
  resolveInRepo(repo, relPath); // 路径必须落在仓库内（结果不用，只做校验）
  const res = await runGit(repo, ['log', LOG_FORMAT, `-L`, `${a},${b}:${relPath}`]);
  ensureOk(res, `git log -L ${a},${b}:${relPath}`, repo);
  return parseLog(decodeLoose(res.stdout));
}

/** 文件行数（与 `git log -L a,b:` 的口径一致：**尾随换行不额外算一行**）。 */
export function countLines(text: string): number {
  const t = normalizeEol(text);
  if (t.length === 0) return 0;
  const n = t.split('\n').length;
  return t.endsWith('\n') ? n - 1 : n;
}
