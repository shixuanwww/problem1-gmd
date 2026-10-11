// 对抗性探针：在临时仓库里端到端跑 gmd CLI，验证题面硬约束。
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
function check(name, cond, info = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${info ? `  <<< ${info}` : ''}`);
  }
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} -> ${r.stderr}`);
  return r.stdout.trim();
}
function gmd(cwd, args, input) {
  const r = spawnSync(NODE, ['--experimental-strip-types', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    input,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const WARN_RE = /ExperimentalWarning|--experimental-strip-types|Type Stripping/;
const clean = (s) => s.split('\n').filter((l) => !WARN_RE.test(l)).join('\n');

const dir = mkdtempSync(path.join(tmpdir(), 'gmd-audit-'));
try {
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'a@b.c');
  git(dir, 'config', 'user.name', 'audit');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'), { recursive: true });

  const lines = [
    '// line 1',
    'export function get(key: string) {',
    '  // line 3',
    '  return null;',
    '}',
    '// line 6',
    '// line 7',
    '// line 8',
    '// line 9',
    '// line 10',
  ];
  const kv = lines.join('\n') + '\n';
  writeFileSync(path.join(dir, 'src', 'kv.ts'), kv);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  const head = git(dir, 'rev-parse', 'HEAD');

  const BODY1 = '## get(key)\n\n按键取值，键不存在返回 null。';
  const doc1 = buildGmd(
    { gmd: 1, doc_id: 'audit-doc', created_at: '2026-01-01T00:00:00Z' },
    [
      {
        id: 'b1',
        hist: [
          {
            rev: 1,
            at: '2026-01-01T00:00:00Z',
            path: 'src/kv.ts',
            range: [2, 4],
            commit: head,
            src_hash: hashRange(kv, [2, 4]),
            text_hash: textHash(BODY1),
          },
        ],
        text: BODY1,
      },
    ],
    '## 备注\n\n块外文本不参与判定。\n',
  );
  writeFileSync(path.join(dir, 'docs', 'api.gmd'), doc1);
  const docRel = 'docs/api.gmd';

  // S1 基线：ok
  let r = gmd(dir, ['read', docRel, '--repo', dir, '--json']);
  let j = JSON.parse(clean(r.out));
  check('S1 基线 ok + 退出码 0', r.code === 0 && j.blocks[0].severity === 'ok', `${r.code} ${clean(r.out)}`);

  // S2 改无关行（第 10 行）且已提交 → 仍 ok（题面：改无关处仍为 ok）
  writeFileSync(path.join(dir, 'src', 'kv.ts'), lines.map((l, i) => (i === 9 ? '// line 10 CHANGED' : l)).join('\n') + '\n');
  git(dir, 'commit', '-am', 'unrelated change');
  r = gmd(dir, ['read', docRel, '--repo', dir, '--json']);
  j = JSON.parse(clean(r.out));
  check('S2 改无关行仍 ok', r.code === 0 && j.blocks[0].severity === 'ok', `${r.code} ${clean(r.out)}`);

  // S3 范围内内容变了且已提交 → warning + changes + 来源当前内容
  writeFileSync(path.join(dir, 'src', 'kv.ts'), lines.map((l, i) => (i === 2 ? '  // line 3 CHANGED' : l)).join('\n') + '\n');
  git(dir, 'commit', '-am', 'in-range change');
  r = gmd(dir, ['read', docRel, '--repo', dir, '--json']);
  j = JSON.parse(clean(r.out));
  check(
    'S3 范围内变更 → warning',
    r.code === 0 && j.blocks[0].severity === 'warning' && j.blocks[0].changes.length > 0 && j.blocks[0].currentSource !== null,
    `${r.code} ${clean(r.out)}`,
  );

  // S4 未提交的范围改动 → warning + dirty + 不可写 + commit 被拒（码 4）
  writeFileSync(path.join(dir, 'src', 'kv.ts'), lines.map((l, i) => (i === 1 ? 'export function get(key: string, extra = 1) {' : l)).join('\n') + '\n');
  r = gmd(dir, ['read', docRel, '--repo', dir, '--json']);
  j = JSON.parse(clean(r.out));
  check(
    'S4 未提交改动 → warning/dirty/writable=false',
    j.blocks[0].severity === 'warning' && j.blocks[0].dirty === true && j.blocks[0].writable === false,
    clean(r.out),
  );
  r = gmd(dir, ['commit', docRel, '--repo', dir, '--block', 'b1', '--input', '-'], '新正文\n');
  check('S4b 脏来源默认拒写（码 4）', r.code === 4, `${r.code} ${clean(r.err)}`);
  const afterReject = readFileSync(path.join(dir, 'docs', 'api.gmd'), 'utf8');
  check('S4c 拒写后文档未被改动', afterReject === doc1, 'doc changed on rejection');
  git(dir, 'checkout', '--', 'src/kv.ts');

  // S5 整段替换成无关内容且已提交 → error + 隐藏旧文字
  writeFileSync(
    path.join(dir, 'src', 'kv.ts'),
    [...lines.slice(0, 1), 'const totally = "unrelated";', 'const other = 42;', 'const third = true;', ...lines.slice(4)].join('\n') + '\n',
  );
  git(dir, 'commit', '-am', 'rewrite range');
  r = gmd(dir, ['read', docRel, '--repo', dir, '--json']);
  j = JSON.parse(clean(r.out));
  check(
    'S5 整段重写 → error 且隐藏旧文字',
    r.code === 3 && j.blocks[0].severity === 'error' && j.blocks[0].currentSource === null && j.blocks[0].changes.length === 0,
    `${r.code} ${clean(r.out)}`,
  );

  // S6 error 块也能 edit → 改草稿 → commit → 新版本（阶段 3 闭环）
  r = gmd(dir, ['edit', docRel, '--repo', dir, '--block', 'b1', '--json']);
  check('S6 edit 生成草稿', r.code === 0 && JSON.parse(clean(r.out)).draft_path !== undefined, clean(r.out));
  const draftPath = JSON.parse(clean(r.out)).draft_path;
  const draft = readFileSync(draftPath, 'utf8');
  writeFileSync(draftPath, draft.replace('按键取值，键不存在返回 null。', '按键取值；键不存在返回 null（重写版）。'));
  r = gmd(dir, ['commit', docRel, '--repo', dir, '--block', 'b1', '--json']);
  check('S6b commit 追加 rev2', r.code === 0 && JSON.parse(clean(r.out)).rev === 2, `${r.code} ${clean(r.out)}`);
  r = gmd(dir, ['read', docRel, '--repo', dir, '--json']);
  j = JSON.parse(clean(r.out));
  check('S6c 重写后回到 ok', j.blocks[0].severity === 'ok' && j.blocks[0].rev === 2, clean(r.out));

  // S7 历史正文是否可取。注意本探针的 .gmd 是**手写**的（hist[0] 没带 text ⇒ 旧格式），
  // 所以 rev1 应当明确说"未存正文"；而 rev2 是 gmd commit 写出来的，必须能取回正文。
  r = gmd(dir, ['read', docRel, '--repo', dir, '--version', '1']);
  const legacyNote = /未存正文/.test(clean(r.out));
  const r2 = gmd(dir, ['read', docRel, '--repo', dir, '--version', '2']);
  const hasNewBody = clean(r2.out).includes('重写版');
  check(
    'S7 read --version 取回历史正文（rev1 旧格式明示未存 / rev2 工具写入可取回）',
    legacyNote && hasNewBody,
    `rev1=${clean(r.out).slice(0, 160)} || rev2=${clean(r2.out).slice(0, 160)}`,
  );

  // S8 `-->` 出现在正文里（真实 Markdown 常见）
  const body2 = '流程 A --> B --> C 的说明。';
  const doc2 = buildGmd(
    { gmd: 1, doc_id: 'd2', created_at: '2026-01-01T00:00:00Z' },
    [{ id: 'x', hist: [{ rev: 1, at: '2026-01-01T00:00:00Z', path: 'src/kv.ts', range: [1, 1], commit: head, src_hash: hashRange(kv, [1, 1]), text_hash: textHash(body2) }], text: body2 }],
  );
  writeFileSync(path.join(dir, 'docs', 'arrow.gmd'), doc2);
  r = gmd(dir, ['read', 'docs/arrow.gmd', '--repo', dir, '--json']);
  check('S8 正文含 --> 仍可解析', r.code === 0, `${r.code} ${clean(r.err)}`);

  // S9 CRLF 文档
  writeFileSync(path.join(dir, 'docs', 'crlf.gmd'), doc2.replace(/\n/g, '\r\n'));
  r = gmd(dir, ['read', 'docs/crlf.gmd', '--repo', dir, '--json']);
  check('S9 CRLF 文档可解析', r.code === 0, `${r.code} ${clean(r.err)}`);

  // S10 格式损坏 → 退出码 2 且报行号
  writeFileSync(path.join(dir, 'docs', 'broken.gmd'), '<!-- gmd:doc {"gmd":1"doc_id":"x","created_at":"t"} -->\n');
  r = gmd(dir, ['read', 'docs/broken.gmd', '--repo', dir]);
  check('S10 损坏格式 → 码 2 + 行号', r.code === 2 && /第 1 行/.test(clean(r.err)), `${r.code} ${clean(r.err)}`);

  // S11 log --path --range
  r = gmd(dir, ['log', docRel, '--repo', dir, '--path', 'src/kv.ts', '--range', '1..3', '--json']);
  check('S11 log --path --range 可用', r.code === 0 && Array.isArray(JSON.parse(clean(r.out))), `${r.code} ${clean(r.err)}`);

  // S12 非仓库 → 环境错误码 5
  const outside = mkdtempSync(path.join(tmpdir(), 'gmd-nonrepo-'));
  r = gmd(outside, ['read', 'a.gmd']);
  check('S12 非仓库 → 码 5', r.code === 5, `${r.code} ${clean(r.err)}`);
  rmSync(outside, { recursive: true, force: true });

  // S13 块外文本在 commit 后是否保持
  const after = readFileSync(path.join(dir, 'docs', 'api.gmd'), 'utf8');
  check('S13 块外文本保留', after.includes('## 备注') && after.includes('块外文本不参与判定。'), after.slice(-200));

  // S14 多块独立性：第二个块的来源被删，第一个块仍 ok
  const bodyB = 'B 片段内容';
  const doc3 = buildGmd(
    { gmd: 1, doc_id: 'd3', created_at: '2026-01-01T00:00:00Z' },
    [
      { id: 'A', hist: [{ rev: 1, at: '2026-01-01T00:00:00Z', path: 'src/kv.ts', range: [1, 1], commit: head, src_hash: hashRange(kv, [1, 1]), text_hash: textHash('A 片段内容') }], text: 'A 片段内容' },
      { id: 'B', hist: [{ rev: 1, at: '2026-01-01T00:00:00Z', path: 'src/gone.ts', range: [1, 1], commit: head, src_hash: hashRange('x', [1, 1]), text_hash: textHash(bodyB) }], text: bodyB },
    ],
  );
  writeFileSync(path.join(dir, 'docs', 'multi.gmd'), doc3);
  r = gmd(dir, ['read', 'docs/multi.gmd', '--repo', dir, '--json']);
  j = JSON.parse(clean(r.out));
  check(
    'S14 片段级独立（A ok / B error）',
    j.blocks.find((b) => b.id === 'A').severity === 'ok' && j.blocks.find((b) => b.id === 'B').severity === 'error',
    clean(r.out),
  );

  // S15 手改正文不追加版本 → error（自证最新不认账）
  // ⚠️ 不能直接 replace：自阶段 4·3 起，同一段文字也内嵌在块头 JSON 的 hist[].text 里，
  //    replace 会先命中**元数据**那一份，被"text 与 text_hash 必须自洽"判成码 2（探针踩过这个坑）。
  //    块正文永远排在块头之后 ⇒ 取最后一次出现。
  const s15raw = readFileSync(path.join(dir, 'docs', 'api.gmd'), 'utf8');
  const s15at = s15raw.lastIndexOf('重写版');
  const tampered = s15raw.slice(0, s15at) + '偷偷改的字' + s15raw.slice(s15at + '重写版'.length);
  writeFileSync(path.join(dir, 'docs', 'api.gmd'), tampered);
  r = gmd(dir, ['read', docRel, '--repo', dir, '--json']);
  j = JSON.parse(clean(r.out));
  check(
    'S15 手改正文 → error',
    Array.isArray(j.blocks) && j.blocks.length === 1 && j.blocks[0].severity === 'error',
    clean(r.out),
  );
  writeFileSync(path.join(dir, 'docs', 'api.gmd'), after);

  // S16 --allow-dirty 写回后，记录是否自洽（commit 与 src_hash 是否同源）
  writeFileSync(path.join(dir, 'src', 'kv.ts'), lines.map((l, i) => (i === 0 ? '// line 1 DIRTY' : l)).join('\n') + '\n');
  r = gmd(dir, ['commit', docRel, '--repo', dir, '--block', 'b1', '--input', '-', '--allow-dirty', '--json'], '脏来源写回测试正文\n');
  const allowDirtyOk = r.code === 0;
  const docAfter = parseGmd(readFileSync(path.join(dir, 'docs', 'api.gmd'), 'utf8'));
  const vLast = docAfter.blocks.find((b) => b.id === 'b1').hist.at(-1);
  const headText = git(dir, 'show', 'HEAD:src/kv.ts') + '\n';
  const srcHashConsistent = vLast.src_hash === hashRange(headText, vLast.range);
  check('S16 --allow-dirty 可写回且带 note', allowDirtyOk && vLast.note === 'based_on_dirty', `${r.code} ${clean(r.out)} ${clean(r.err)}`);
  // S16b 契约（阶段 4·1 收口）：`--allow-dirty` 的 src_hash 取自**脏工作区**，与 HEAD 本来就不是
  // 同源 —— 所以判据是"**基准字段**与哈希一致"，而不是"与 HEAD 哈希相等"。
  const worktreeText = readFileSync(path.join(dir, 'src', 'kv.ts'), 'utf8');
  const invariant = vLast.src_base === 'worktree' && vLast.src_hash === hashRange(worktreeText, vLast.range);
  check(
    'S16b src_base=worktree 且 src_hash 与工作区一致、与 HEAD 不同',
    invariant && !srcHashConsistent,
    `src_base=${vLast.src_base} src_hash=${vLast.src_hash.slice(0, 20)}… HEAD哈希=${hashRange(headText, vLast.range).slice(0, 20)}…`,
  );

  console.log(`\n== ${pass} passed, ${fail} failed ==`);
  console.log(`scratch: ${dir}`);
} catch (e) {
  console.log('PROBE ERROR', e);
  fail++;
} finally {
  if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
}
