// 第四轮：CLI 表面行为（选项归属、退出码一致性、报错可诊断性）。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
function gmd(cwd, args, input) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], { cwd, encoding: 'utf8', input });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const clean = (s) => s.split('\n').filter((l) => !/ExperimentalWarning|Type Stripping|trace-warnings/.test(l)).join('\n');

const dir = mkdtempSync(path.join(tmpdir(), 'gmd-audit4-'));
try {
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'a@b.c');
  git(dir, 'config', 'user.name', 'audit');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  const kv = 'A1\nA2\nA3\nA4\nA5\nA6\nA7\nA8\nA9\nA10\nA11\nA12\n';
  writeFileSync(path.join(dir, 'src', 'kv.ts'), kv);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  const head = git(dir, 'rev-parse', 'HEAD');

  const body = 'A 片段正文';
  const doc = buildGmd(
    { gmd: 1, doc_id: 'd', created_at: 't' },
    [{ id: 'b1', hist: [{ rev: 1, at: 't', path: 'src/kv.ts', range: [1, 3], commit: head, src_hash: hashRange(kv, [1, 3]), text_hash: textHash(body), text: body }], text: body }],
  );
  writeFileSync(path.join(dir, 'docs', 'api.gmd'), doc);
  const D = 'docs/api.gmd';

  // A. 选项归属：不属于该子命令的选项被**静默忽略**？
  let r = gmd(dir, ['read', D, '--repo', dir, '--range', '1..2', '--json']);
  const readIgnoredRange = r.code === 0;
  r = gmd(dir, ['log', D, '--repo', dir, '--plain']);
  const logIgnoredPlain = r.code === 0;
  r = gmd(dir, ['edit', D, '--repo', dir, '--block', 'b1', '--allow-dirty']);
  const editIgnoredAllowDirty = r.code === 0;
  check('A1 read 接受并忽略 --range（应改判码 1）', !readIgnoredRange, 'read --range 1..2 返回 0：选项被静默忽略');
  check('A2 log 接受并忽略 --plain（应改判码 1）', !logIgnoredPlain, 'log --plain 返回 0：选项被静默忽略');
  check('A3 edit 接受并忽略 --allow-dirty（应改判码 1）', !editIgnoredAllowDirty, 'edit --allow-dirty 返回 0：选项被静默忽略');
  check('A4 合法选项仍然通过（read --block b1 --plain）', gmd(dir, ['read', D, '--repo', dir, '--block', 'b1', '--plain']).code === 0);

  // B. 退出码一致性：block 不存在
  const codes = {
    read: gmd(dir, ['read', D, '--repo', dir, '--block', 'nope']).code,
    log: gmd(dir, ['log', D, '--repo', dir, '--block', 'nope']).code,
    edit: gmd(dir, ['edit', D, '--repo', dir, '--block', 'nope']).code,
    commit: gmd(dir, ['commit', D, '--repo', dir, '--block', 'nope', '--input', '-'], 'x\n').code,
  };
  const allSame = codes.read === codes.log && codes.log === codes.edit && codes.edit === codes.commit;
  check('B1 "片段不存在"在四个子命令下同码', allSame, `read=${codes.read} log=${codes.log} edit=${codes.edit} commit=${codes.commit}`);

  // C. --input 指向目录
  mkdirSync(path.join(dir, 'adir'), { recursive: true });
  r = gmd(dir, ['commit', D, '--repo', dir, '--block', 'b1', '--input', 'adir']);
  check('C1 --input 指向目录 → 参数错（码 1）', r.code === 1, `code=${r.code} ${clean(r.err).slice(0, 120)}`);

  // D. 围栏代码块包住真标记 ⇒ 报错是否点明真正原因
  const wrapped = [
    '<!-- gmd:doc {"gmd":1,"doc_id":"d","created_at":"t"} -->',
    '',
    '```',
    '<!-- gmd:block {"id":"b1","hist":[]} -->',
    '正文',
    '<!-- /gmd:block -->',
    '```',
  ].join('\n') + '\n';
  writeFileSync(path.join(dir, 'docs', 'wrapped.gmd'), wrapped);
  r = gmd(dir, ['read', 'docs/wrapped.gmd', '--repo', dir]);
  const d1ok = r.code === 0 && /围栏/.test(clean(r.err)) && /第 4 行/.test(clean(r.err));
  check('D1 围栏包住真标记：0 片段但 stderr 点明（不再静默）', d1ok, `code=${r.code} err=${clean(r.err).split('\n')[0]}`);
  const d1json = JSON.parse(clean(gmd(dir, ['read', 'docs/wrapped.gmd', '--repo', dir, '--json']).out));
  check(
    'D2 --json 用 fence_ignored 报出被忽略的标记',
    Array.isArray(d1json.fence_ignored) && d1json.fence_ignored.length === 2 && d1json.blocks.length === 0,
    JSON.stringify(d1json).slice(0, 200),
  );
  // D3 对照：**片段正文内部**的格式示例（合法用法）不得被报出来。
  // ⚠️ 必须用 buildGmd 重建：block.text 与 hist[].text 都要带上这段正文，
  //    直接对 doc 做字符串替换会把裸换行插进块头的 JSON 字符串里 ⇒ 码 2（探针自己踩过）。
  const insideBody = ['示例：', '', '```', '<!-- gmd:block {"id":"x"} -->', '```'].join('\n');
  const insideDoc = buildGmd(
    { gmd: 1, doc_id: 'd2', created_at: 't' },
    [{ id: 'b1', hist: [{ rev: 1, at: 't', path: 'src/kv.ts', range: [1, 3], commit: head, src_hash: hashRange(kv, [1, 3]), text_hash: textHash(insideBody), text: insideBody }], text: insideBody }],
  );
  writeFileSync(path.join(dir, 'docs', 'inside.gmd'), insideDoc);
  r = gmd(dir, ['read', 'docs/inside.gmd', '--repo', dir, '--json']);
  const d3json = JSON.parse(clean(r.out));
  check('D3 片段正文里的格式示例不报 fence_ignored', r.code === 0 && d3json.fence_ignored === undefined, JSON.stringify(d3json).slice(0, 200));

  console.log(`\n== ${pass} passed, ${fail} failed ==`);
} catch (e) {
  console.log('PROBE4 ERROR', e);
  fail++;
} finally {
  if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
}
