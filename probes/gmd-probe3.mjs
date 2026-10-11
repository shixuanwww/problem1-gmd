// 第三轮：引用范围已被整段删除（文件还在）时，重写 + commit 会不会伪造出 ok。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const CLI = `${PROJ}/src/cli.ts`;
const fmt = await import(pathToFileURL(`${PROJ}/src/format.ts`).href);
const gr = await import(pathToFileURL(`${PROJ}/src/gitrepo.ts`).href);
const { buildGmd, parseGmd } = fmt;
const { hashRange, textHash } = gr;

let pass = 0;
let fail = 0;
const check = (n, c, i = '') => {
  c ? pass++ : fail++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : `  <<< ${i}`}`);
};
function git(cwd, ...a) {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function gmd(cwd, args, input) {
  const r = spawnSync(NODE, ['--experimental-strip-types', CLI, ...args], { cwd, encoding: 'utf8', input });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const clean = (s) => s.split('\n').filter((l) => !/ExperimentalWarning|Type Stripping|trace-warnings/.test(l)).join('\n');
const sev = (dir, doc) => JSON.parse(clean(gmd(dir, ['read', doc, '--repo', dir, '--json']).out)).blocks[0].severity;

const dir = mkdtempSync(path.join(tmpdir(), 'gmd-audit3-'));
try {
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'a@b.c');
  git(dir, 'config', 'user.name', 'audit');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'), { recursive: true });

  const longKv = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
  writeFileSync(path.join(dir, 'src', 'kv.ts'), longKv);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  const head = git(dir, 'rev-parse', 'HEAD');

  const body = '接口说明正文（rev1）';
  const doc = buildGmd(
    { gmd: 1, doc_id: 't', created_at: 't' },
    [{ id: 'b1', hist: [{ rev: 1, at: 't', path: 'src/kv.ts', range: [10, 12], commit: head, src_hash: hashRange(longKv, [10, 12]), text_hash: textHash(body) }], text: body }],
  );
  writeFileSync(path.join(dir, 'docs', 'api.gmd'), doc);
  check('Q1 基线 ok', sev(dir, 'docs/api.gmd') === 'ok');

  // 文件被截断到 5 行并提交 → 引用范围 [10,12] 已整段删除
  writeFileSync(path.join(dir, 'src', 'kv.ts'), 'L1\nL2\nL3\nL4\nL5\n');
  git(dir, 'commit', '-am', 'truncate');
  check('Q2 范围整段删除 → error', sev(dir, 'docs/api.gmd') === 'error', `得到 ${sev(dir, 'docs/api.gmd')}`);

  // AI 按题面「必须重写」重写正文并写回
  const r = gmd(dir, ['commit', 'docs/api.gmd', '--repo', dir, '--block', 'b1', '--input', '-', '--json'], '重写后的正文（引用目标已不存在）\n');
  check('Q3 只重写正文（沿用越界 range）必须被拒（码 4）', r.code === 4, `code=${r.code} ${clean(r.err).slice(0, 160)}`);
  const after = sev(dir, 'docs/api.gmd');
  check('Q4 写回后仍为 error（不得伪造成 ok）', after === 'error', `写回后 severity=${after}（引用范围 10-12 在 5 行文件里根本不存在）`);

  // Q5：把引用改指到仍存在的范围 ⇒ 闭环走完（阶段 4·2）
  const r5 = gmd(
    dir,
    ['commit', 'docs/api.gmd', '--repo', dir, '--block', 'b1', '--range', '1..3', '--input', '-', '--json'],
    '重写后的正文（引用已改指到 1-3 行）\n',
  );
  let rev = -1;
  try {
    rev = JSON.parse(clean(r5.out)).rev;
  } catch {}
  check('Q5 --range 重绑定到仍存在的范围 ⇒ 写回成功且回到 ok', r5.code === 0 && rev === 2 && sev(dir, 'docs/api.gmd') === 'ok', `code=${r5.code} rev=${rev} ${clean(r5.err).slice(0, 160)}`);

  const p = parseGmd(readFileSync(path.join(dir, 'docs', 'api.gmd'), 'utf8'));
  const v = p.blocks[0].hist.at(-1);
  console.log(`   rev2: range=${JSON.stringify(v.range)} src_hash=${v.src_hash.slice(0, 20)}… commit=${v.commit.slice(0, 8)}`);
  console.log(`   实际文件行数=5，range 上界=12`);

  console.log(`\n== ${pass} passed, ${fail} failed ==`);
} catch (e) {
  console.log('PROBE3 ERROR', e);
  fail++;
} finally {
  if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
}
