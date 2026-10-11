// 第二轮：路径逃逸、未知字段保真、error 闭环、plain 语义。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
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

const dir = mkdtempSync(path.join(tmpdir(), 'gmd-audit2-'));
try {
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'a@b.c');
  git(dir, 'config', 'user.name', 'audit');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'), { recursive: true });

  // 仓库外放一个"机密"文件（父目录）
  const outside = path.join(path.dirname(dir), `secret-${path.basename(dir)}.txt`);
  writeFileSync(outside, 'TOP_SECRET_LINE\n');

  const kv = 'A1\nA2\nA3\nA4\nA5\n';
  writeFileSync(path.join(dir, 'src', 'kv.ts'), kv);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  const head = git(dir, 'rev-parse', 'HEAD');

  // P1: v.path 里塞 ".." 逃逸仓库
  const escRel = path.relative(dir, outside).split(path.sep).join('/');
  const bodyEsc = '泄露测试正文';
  const docEsc = buildGmd(
    { gmd: 1, doc_id: 'e', created_at: 't' },
    [{ id: 'e1', hist: [{ rev: 1, at: 't', path: escRel, range: [1, 1], commit: head, src_hash: hashRange('TOP_SECRET_LINE\n', [1, 1]), text_hash: textHash(bodyEsc) }], text: bodyEsc }],
  );
  writeFileSync(path.join(dir, 'docs', 'esc.gmd'), docEsc);
  let r = gmd(dir, ['read', 'docs/esc.gmd', '--repo', dir, '--json']);
  let leaked = false;
  try {
    const j = JSON.parse(clean(r.out));
    leaked = j.blocks[0].severity === 'ok' || (j.blocks[0].currentSource ?? '').includes('TOP_SECRET');
  } catch {}
  let leakedText = '';
  try {
    leakedText = JSON.parse(clean(r.out)).blocks[0].currentSource ?? '';
  } catch {}
  check('P1 v.path 含 .. 被拒绝（不逃逸仓库）', !leaked, `code=${r.code} leaked=${JSON.stringify(leakedText)}`);

  // P2: 未知字段是否在 commit 时被静默丢弃
  const b1 = 'B1 正文';
  const docUnknown = buildGmd(
    { gmd: 1, doc_id: 'u', created_at: 't' },
    [{ id: 'u1', hist: [{ rev: 1, at: 't', path: 'src/kv.ts', range: [1, 2], commit: head, src_hash: hashRange(kv, [1, 2]), text_hash: textHash(b1) }], text: b1 }],
  );
  const withExtra = docUnknown.replace('"id":"u1"', '"id":"u1","future_field":"keep-me"');
  writeFileSync(path.join(dir, 'docs', 'unk.gmd'), withExtra);
  r = gmd(dir, ['edit', 'docs/unk.gmd', '--repo', dir, '--block', 'u1', '--json']);
  const dp = JSON.parse(clean(r.out)).draft_path;
  writeFileSync(dp, readFileSync(dp, 'utf8').replace('B1 正文', 'B2 正文'));
  r = gmd(dir, ['commit', 'docs/unk.gmd', '--repo', dir, '--block', 'u1', '--json']);
  const afterUnk = readFileSync(path.join(dir, 'docs', 'unk.gmd'), 'utf8');
  check('P2 commit 后未知字段保留', afterUnk.includes('future_field'), '未知字段被静默丢弃');

  // P3: 源文件被删除（已提交）→ error；重写后能否写回
  const b3 = 'C 正文';
  const docGone = buildGmd(
    { gmd: 1, doc_id: 'g', created_at: 't' },
    [{ id: 'g1', hist: [{ rev: 1, at: 't', path: 'src/tmp.ts', range: [1, 2], commit: head, src_hash: hashRange('X1\nX2\n', [1, 2]), text_hash: textHash(b3) }], text: b3 }],
  );
  writeFileSync(path.join(dir, 'docs', 'gone.gmd'), docGone);
  writeFileSync(path.join(dir, 'src', 'tmp.ts'), 'X1\nX2\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'add tmp');
  const head2 = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(path.join(dir, 'docs', 'gone.gmd'), readFileSync(path.join(dir, 'docs', 'gone.gmd'), 'utf8'));
  r = gmd(dir, ['read', 'docs/gone.gmd', '--repo', dir, '--json']);
  let sev1 = JSON.parse(clean(r.out)).blocks[0].severity;
  git(dir, 'rm', '-q', 'src/tmp.ts');
  git(dir, 'commit', '-m', 'delete tmp');
  r = gmd(dir, ['read', 'docs/gone.gmd', '--repo', dir, '--json']);
  const sev2 = JSON.parse(clean(r.out)).blocks[0].severity;
  void head2;
  check('P3 源文件删除 → error', sev1 === 'ok' && sev2 === 'error', `${sev1}/${sev2}`);
  r = gmd(dir, ['commit', 'docs/gone.gmd', '--repo', dir, '--block', 'g1', '--input', '-', '--json'], '重写后的全新正文\n');
  check('P3b error 档：只重写正文必须被拒（码 4）', r.code === 4, `code=${r.code} ${clean(r.err).slice(0, 200)}`);
  const r2 = gmd(
    dir,
    ['commit', 'docs/gone.gmd', '--repo', dir, '--block', 'g1', '--path', 'src/kv.ts', '--range', '1..2', '--input', '-', '--json'],
    '重写后的全新正文\n',
  );
  let rev2 = -1;
  try {
    rev2 = JSON.parse(clean(r2.out)).rev;
  } catch {}
  check('P3c --path/--range 重绑定后闭环写回成功（rev2）', r2.code === 0 && rev2 === 2, `code=${r2.code} ${clean(r2.err).slice(0, 200)}`);

  // P4: --plain 对 error 块是否仍输出正文。
  // ⚠️ 必须用一个**全新的、来源缺失的**文档：上面的 P3c 已经把 gone.gmd 的 g1 写回成 ok 了，
  //    若仍拿它测，这条会"看起来通过"，其实是测了个已经修好的块。
  const docGone2 = buildGmd(
    { gmd: 1, doc_id: 'g2', created_at: 't' },
    [{ id: 'g2', hist: [{ rev: 1, at: 't', path: 'src/nope.ts', range: [1, 1], commit: head, src_hash: hashRange('Z\n', [1, 1]), text_hash: textHash('C 正文') }], text: 'C 正文' }],
  );
  writeFileSync(path.join(dir, 'docs', 'gone2.gmd'), docGone2);
  // P4 的**已定契约**：`--plain` 的 stdout 保持纯正文（"只出正文"是题面参考接口的承诺），
  // 但必须在 stderr 点明哪些片段已失效 —— 否则 AI 拿到失效正文却不知道是哪一块。
  r = gmd(dir, ['read', 'docs/gone2.gmd', '--repo', dir, '--plain']);
  const p4ok =
    r.code === 3 &&
    r.out.includes('C 正文') && // stdout 仍是正文，不混提示
    !/失效|必须重写|\[error\]/.test(r.out) &&
    /已失效/.test(r.err) &&
    /g2/.test(r.err) &&
    /gmd edit/.test(r.err);
  check('P4 --plain：stdout 纯正文 + stderr 点明失效片段与下一步', p4ok, `code=${r.code} out=${JSON.stringify(clean(r.out))} err=${JSON.stringify(clean(r.err).slice(0, 160))}`);

  // P5: 正文里出现块标记字面量（代码块里讲 .gmd 格式）
  const tricky = '示例：\n\n```\n<!-- gmd:block {"id":"x"} -->\n```\n';
  const docSelf = buildGmd(
    { gmd: 1, doc_id: 's', created_at: 't' },
    [{ id: 's1', hist: [{ rev: 1, at: 't', path: 'src/kv.ts', range: [1, 1], commit: head, src_hash: hashRange(kv, [1, 1]), text_hash: textHash(tricky) }], text: tricky }],
  );
  writeFileSync(path.join(dir, 'docs', 'self.gmd'), docSelf);
  r = gmd(dir, ['read', 'docs/self.gmd', '--repo', dir, '--json']);
  check('P5 正文含 gmd 标记字面量可解析', r.code === 0, `code=${r.code} ${clean(r.err).slice(0, 200)}`);

  // P6: doc 头字段之外的未知字段
  const docHeadExtra = buildGmd({ gmd: 1, doc_id: 'h', created_at: 't' }, []).replace('"gmd":1', '"gmd":1,"owner":"me"');
  writeFileSync(path.join(dir, 'docs', 'head.gmd'), docHeadExtra);
  r = gmd(dir, ['read', 'docs/head.gmd', '--repo', dir, '--json']);
  check('P6 doc 头未知字段可读', r.code === 0, `code=${r.code} ${clean(r.err).slice(0, 200)}`);

  console.log(`\n== ${pass} passed, ${fail} failed ==`);
} catch (e) {
  console.log('PROBE2 ERROR', e);
  fail++;
} finally {
  if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
}
