// 第六轮：边界环境 —— 符号链接 / 超长单行 / 非 ASCII 路径 / git worktree / 重命名历史 / 草稿隔离。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = `${PROJ}/src/cli.ts`;
const fmt = await import(pathToFileURL(`${PROJ}/src/format.ts`).href);
const gr = await import(pathToFileURL(`${PROJ}/src/gitrepo.ts`).href);
const { buildGmd } = fmt;
const { hashRange, textHash } = gr;

let pass = 0;
let fail = 0;
const check = (n, c, i = '') => {
  c ? pass++ : fail++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : `  <<< ${i}`}`);
};
function git(cwd, ...a) {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function gitOk(cwd, ...a) {
  const r = git(cwd, ...a);
  if (r.code !== 0) throw new Error(`git ${a.join(' ')}: ${r.err}`);
  return r.out.trim();
}
function gmd(cwd, args, input) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], { cwd, encoding: 'utf8', input });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const clean = (s) => s.split('\n').filter((l) => !/ExperimentalWarning|Type Stripping|trace-warnings/.test(l)).join('\n');

const dir = mkdtempSync(path.join(tmpdir(), 'gmd-audit6-'));
try {
  gitOk(dir, 'init', '-b', 'main');
  gitOk(dir, 'config', 'user.email', 'a@b.c');
  gitOk(dir, 'config', 'user.name', 'audit');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'), { recursive: true });

  // ---------- B. 超长单行：改动它会不会把冲突视图撑爆 ----------
  const longLine = 'x'.repeat(300_000);
  const longSrc = `${longLine}\nshort\n`;
  writeFileSync(path.join(dir, 'src', 'long.ts'), longSrc);
  gitOk(dir, 'add', '-A');
  gitOk(dir, 'commit', '-m', 'init long');
  const head = gitOk(dir, 'rev-parse', 'HEAD');
  const body = '长行片段正文';
  writeFileSync(
    path.join(dir, 'docs', 'long.gmd'),
    buildGmd(
      { gmd: 1, doc_id: 'd', created_at: 't' },
      [{ id: 'b1', hist: [{ rev: 1, at: 't', path: 'src/long.ts', range: [1, 2], commit: head, src_hash: hashRange(longSrc, [1, 2]), text_hash: textHash(body), text: body }], text: body }],
    ),
  );
  writeFileSync(path.join(dir, 'src', 'long.ts'), `${longLine.slice(0, -1)}y\nshort\n`);
  gitOk(dir, 'commit', '-am', 'change long line');
  const longView = gmd(dir, ['read', 'docs/long.gmd', '--repo', dir]);
  const longJson = gmd(dir, ['read', 'docs/long.gmd', '--repo', dir, '--json']);
  console.log(`  超长单行（300KB）：人读视图 ${longView.out.length} 字节，--json ${longJson.out.length} 字节`);
  check('B1 超长单行的冲突视图不应把整行原样吐出来（应截断）', longView.out.length < 20_000, `${longView.out.length} 字节`);
  check('B2 --json 的 changes 同样应截断', longJson.out.length < 20_000, `${longJson.out.length} 字节`);

  // ---------- C. 草稿隔离：两个文档各自的草稿不得互相覆盖 ----------
  const mkDoc = (id, relPath) => {
    const t = 'A1\nA2\nA3\n';
    writeFileSync(path.join(dir, relPath), t);
    gitOk(dir, 'add', '-A');
    gitOk(dir, 'commit', '-m', `src ${relPath}`);
    const h = gitOk(dir, 'rev-parse', 'HEAD');
    const b = `${id} 的正文`;
    return buildGmd(
      { gmd: 1, doc_id: id, created_at: 't' },
      [{ id: 'b1', hist: [{ rev: 1, at: 't', path: relPath, range: [1, 3], commit: h, src_hash: hashRange(t, [1, 3]), text_hash: textHash(b), text: b }], text: b }],
    );
  };
  writeFileSync(path.join(dir, 'docs', 'one.gmd'), mkDoc('one', 'src/one.ts'));
  writeFileSync(path.join(dir, 'docs', 'two.gmd'), mkDoc('two', 'src/two.ts'));
  gitOk(dir, 'add', '-A');
  gitOk(dir, 'commit', '-m', 'two docs');
  const d1 = JSON.parse(clean(gmd(dir, ['edit', 'docs/one.gmd', '--block', 'b1', '--repo', dir, '--json']).out)).draft_path;
  const d2 = JSON.parse(clean(gmd(dir, ['edit', 'docs/two.gmd', '--block', 'b1', '--repo', dir, '--json']).out)).draft_path;
  check('C1 两个文档的草稿路径互不覆盖', d1 !== d2 && existsSync(d1) && existsSync(d2), `${d1} / ${d2}`);
  // 分别写草稿再各自 commit，互不影响
  writeFileSync(d1, `${readFileSync(d1, 'utf8').split('\n')[0]}\none 的新正文\n`);
  writeFileSync(d2, `${readFileSync(d2, 'utf8').split('\n')[0]}\ntwo 的新正文\n`);
  const c1 = gmd(dir, ['commit', 'docs/one.gmd', '--block', 'b1', '--repo', dir, '--input', d1, '--json']);
  const c2 = gmd(dir, ['commit', 'docs/two.gmd', '--block', 'b1', '--repo', dir, '--input', d2, '--json']);
  check('C2 两份草稿各自 commit 成功', c1.code === 0 && c2.code === 0, `${c1.code}/${c2.code} ${clean(c1.err).slice(0, 120)} ${clean(c2.err).slice(0, 120)}`);
  check(
    'C3 两个文档的正文各自正确',
    readFileSync(path.join(dir, 'docs', 'one.gmd'), 'utf8').includes('one 的新正文') &&
      readFileSync(path.join(dir, 'docs', 'two.gmd'), 'utf8').includes('two 的新正文'),
    '交叉污染',
  );

  // ---------- D. 非 ASCII 来源路径 ----------
  const uniRel = 'src/配置.ts';
  const uniSrc = 'K1\nK2\nK3\n';
  writeFileSync(path.join(dir, uniRel), uniSrc);
  gitOk(dir, 'add', '-A');
  gitOk(dir, 'commit', '-m', 'unicode src');
  const uniHead = gitOk(dir, 'rev-parse', 'HEAD');
  const uniBody = '非 ASCII 路径片段';
  writeFileSync(
    path.join(dir, 'docs', 'uni.gmd'),
    buildGmd(
      { gmd: 1, doc_id: 'u', created_at: 't' },
      [{ id: 'b1', hist: [{ rev: 1, at: 't', path: uniRel, range: [1, 3], commit: uniHead, src_hash: hashRange(uniSrc, [1, 3]), text_hash: textHash(uniBody), text: uniBody }], text: uniBody }],
    ),
  );
  const uni = gmd(dir, ['read', 'docs/uni.gmd', '--repo', dir, '--json']);
  const uniSev = JSON.parse(clean(uni.out)).blocks[0].severity;
  check('D1 非 ASCII 来源路径可判定为 ok', uni.code === 0 && uniSev === 'ok', `code=${uni.code} sev=${uniSev} ${clean(uni.err).slice(0, 160)}`);
  const uniLog = gmd(dir, ['log', 'docs/uni.gmd', '--path', uniRel, '--repo', dir]);
  check('D2 非 ASCII 来源路径可查提交历史', uniLog.code === 0 && /unicode src/.test(clean(uniLog.out)), `code=${uniLog.code} ${clean(uniLog.err).slice(0, 160)}`);

  // ---------- E. git worktree（.git 是文件而非目录） ----------
  // ⚠️ 必须先把文档提交，否则 worktree 里根本没有它（探针自己踩过这个坑）
  gitOk(dir, 'add', '-A');
  gitOk(dir, 'commit', '-m', 'commit docs before worktree');
  const wt = path.join(tmpdir(), `gmd-wt-${Date.now()}`);
  const add = git(dir, 'worktree', 'add', '-q', '--detach', wt);
  if (add.code === 0) {
    const wtDoc = path.join(wt, 'docs', 'uni.gmd');
    const existed = existsSync(wtDoc);
    const r = gmd(dir, ['read', 'docs/uni.gmd', '--repo', wt, '--json']);
    check('E1 --repo 指向 git worktree（.git 是文件）可用', existed && r.code === 0, `exists=${existed} code=${r.code} ${clean(r.err).slice(0, 160)}`);
    git(dir, 'worktree', 'remove', '--force', wt);
  } else {
    console.log('  （跳过 E：本环境无法建 worktree）');
  }

  // ---------- G. 重命名后的 log --path / --range ----------
  const oldRel = 'src/old.ts';
  writeFileSync(path.join(dir, oldRel), 'R1\nR2\n');
  gitOk(dir, 'add', '-A');
  gitOk(dir, 'commit', '-m', 'add old.ts');
  gitOk(dir, 'mv', oldRel, 'src/new.ts');
  gitOk(dir, 'commit', '-m', 'rename to new.ts');
  const g1 = gmd(dir, ['log', 'docs/uni.gmd', '--path', 'src/new.ts', '--repo', dir]);
  check('G1 重命名后的 log --path 可用（列出全部历史）', g1.code === 0 && /rename to new\.ts/.test(clean(g1.out)), `code=${g1.code} ${clean(g1.err).slice(0, 160)}`);
  const g2 = gmd(dir, ['log', 'docs/uni.gmd', '--path', 'src/new.ts', '--range', '1..2', '--repo', dir]);
  check('G2 重命名后的 log --path --range 可用（跟随重命名）', g2.code === 0, `code=${g2.code} ${clean(g2.err).slice(0, 200)}`);

  // ---------- F/A. 符号链接（Windows 需要权限，失败则跳过） ----------
  try {
    writeFileSync(path.join(dir, 'outside.ts'), 'OUT1\nOUT2\n');
    symlinkSync(path.join(dir, 'outside.ts'), path.join(dir, 'src', 'link.ts'), 'file');
    const linkSrc = readFileSync(path.join(dir, 'src', 'link.ts'), 'utf8');
    gitOk(dir, 'add', '-A');
    gitOk(dir, 'commit', '-m', 'add symlink');
    const lHead = gitOk(dir, 'rev-parse', 'HEAD');
    const lBody = '符号链接来源片段';
    writeFileSync(
      path.join(dir, 'docs', 'link.gmd'),
      buildGmd(
        { gmd: 1, doc_id: 'l', created_at: 't' },
        [{ id: 'b1', hist: [{ rev: 1, at: 't', path: 'src/link.ts', range: [1, 2], commit: lHead, src_hash: hashRange(linkSrc, [1, 2]), text_hash: textHash(lBody), text: lBody }], text: lBody }],
      ),
    );
    const lr = gmd(dir, ['read', 'docs/link.gmd', '--repo', dir, '--json']);
    const lj = JSON.parse(clean(lr.out)).blocks[0];
    console.log(`  符号链接来源：severity=${lj.severity} dirty=${lj.dirty} writable=${lj.writable} reason=${lj.reason}`);
    check('F1 符号链接来源不应表现为"永久 dirty 且不可写回"', !(lj.dirty === true && lj.writable === false), `severity=${lj.severity} dirty=${lj.dirty} reason=${lj.reason}`);
  } catch (e) {
    console.log(`  （跳过 F/A：本环境无法建符号链接 —— ${String(e).slice(0, 80)}）`);
  }

  console.log(`\n== ${pass} passed, ${fail} failed ==`);
} catch (e) {
  console.log('PROBE6 ERROR', e);
  fail++;
} finally {
  if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
}
