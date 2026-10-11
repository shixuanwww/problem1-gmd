// 第五轮：性能 —— 判定路径上的重复工作（多块同源重复读文件/重复 spawn git；锚定滑窗重复整文件切分）。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function gmd(cwd, args) {
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - started };
}
const clean = (s) => s.split('\n').filter((l) => !/ExperimentalWarning|Type Stripping|trace-warnings/.test(l)).join('\n');

const dir = mkdtempSync(path.join(tmpdir(), 'gmd-audit5-'));
try {
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'a@b.c');
  git(dir, 'config', 'user.name', 'audit');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'), { recursive: true });

  // 一个 3000 行的来源文件
  const LINES = 3000;
  const src = Array.from({ length: LINES }, (_, i) => `export const k${i + 1} = ${i + 1};`).join('\n') + '\n';
  writeFileSync(path.join(dir, 'src', 'big.ts'), src);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  const head = git(dir, 'rev-parse', 'HEAD');

  // 一个文档：16 个片段，全部引用同一个 200 行的来源范围（模拟"一个文件衍生出很多片段"）
  const blocks = Array.from({ length: 16 }, (_, i) => {
    const body = `片段 b${i + 1} 的正文`;
    return {
      id: `b${i + 1}`,
      hist: [{ rev: 1, at: 't', path: 'src/big.ts', range: [1, 200], commit: head, src_hash: hashRange(src, [1, 200]), text_hash: textHash(body), text: body }],
      text: body,
    };
  });
  writeFileSync(path.join(dir, 'docs', 'many.gmd'), buildGmd({ gmd: 1, doc_id: 'd', created_at: 't' }, blocks));

  const all = gmd(dir, ['read', 'docs/many.gmd', '--repo', dir, '--json']);
  const one = gmd(dir, ['read', 'docs/many.gmd', '--block', 'b1', '--repo', dir, '--json']);
  console.log(`  16 块全量 read: ${all.ms}ms   单块 read --block: ${one.ms}ms`);
  check('A1 16 块同源文档 read 应在 1s 内', all.ms < 1000, `${all.ms}ms`);
  check('A2 只读 1 块也应在 500ms 内（判定不应随整篇块数放大）', one.ms < 500, `${one.ms}ms`);

  // 行号漂移（**窗口内**）：上方插 20 行 ⇒ 锚定滑窗（±50）应当认出来，判 warning
  const moved = [...Array.from({ length: 20 }, (_, i) => `// 插入 ${i + 1}`), ...src.split('\n')].join('\n');
  writeFileSync(path.join(dir, 'src', 'big.ts'), moved);
  git(dir, 'commit', '-am', 'insert 20 lines above');
  const drifted = gmd(dir, ['read', 'docs/many.gmd', '--block', 'b1', '--repo', dir, '--json']);
  const b = JSON.parse(clean(drifted.out)).blocks[0];
  console.log(`  漂移 20 行后 read --block: ${drifted.ms}ms（severity=${b.severity}）`);
  check('B1 漂移（窗口内）判定应在 1s 内', drifted.ms < 1000, `${drifted.ms}ms`);
  check('B2 漂移（窗口内）判 warning 且 reason 提到行号', b.severity === 'warning' && /行号/.test(b.reason), `severity=${b.severity} reason=${b.reason}`);

  // 行号漂移（**超出窗口**）：再插到 400 行以外 ⇒ 按 §11 登记的 ±50 启发式，退化为 error。
  // 这是**已登记的取舍**（PLAN §11 ANCHOR_WINDOW=50），不是本次要改的行为；这里只记录实测值。
  const far = [...Array.from({ length: 400 }, (_, i) => `// 远处 ${i + 1}`), ...moved.split('\n')].join('\n');
  writeFileSync(path.join(dir, 'src', 'big.ts'), far);
  git(dir, 'commit', '-am', 'insert 400 more lines above');
  const farRes = gmd(dir, ['read', 'docs/many.gmd', '--block', 'b1', '--repo', dir, '--json']);
  const farSev = JSON.parse(clean(farRes.out)).blocks[0].severity;
  console.log(`  漂移超出 ±50 窗口后：${farRes.ms}ms（severity=${farSev}，§11 登记为退化行为）`);
  check('B3 漂移超出窗口时仍是"保守的 error"（不会误判 ok）', farSev === 'error', `severity=${farSev}`);

  console.log(`\n== ${pass} passed, ${fail} failed ==`);
} catch (e) {
  console.log('PROBE5 ERROR', e);
  fail++;
} finally {
  if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
}
