// 第七轮：模糊测试 —— 解析器只允许"成功"或"抛 GmdFormatError"，且成功时必须往返幂等。
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import path from 'node:path';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fmt = await import(pathToFileURL(`${PROJ}/src/format.ts`).href);
const t = await import(pathToFileURL(`${PROJ}/src/types.ts`).href);
const { buildGmd, parseGmd, serializeGmd } = fmt;
const { GmdFormatError } = t;

// 确定性 PRNG（可复现）
let seed = 0x9e3779b9;
function rnd() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 0x100000000;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const ATOMS = [
  '<!-- gmd:doc {"gmd":1,"doc_id":"d","created_at":"t"} -->',
  '<!-- gmd:block {"id":"b1","hist":[{"rev":1,"at":"t","path":"src/a.ts","range":[1,2],"commit":"c","src_hash":"sha256:' + 'a'.repeat(64) + '","text_hash":"sha256:' + 'b'.repeat(64) + '","text":"正文"}]} -->',
  '<!-- /gmd:block -->',
  '<!-- gmd:block {"id":"b1","hist":[]} -->',
  '<!-- gmd:block {oops -->',
  '<!-- gmd:block {"id":"b1","hist":[{"rev":2,"at":"t","path":"/abs","range":[0,0],"commit":"c","src_hash":"x","text_hash":"y"}]} -->',
  '<!-- gmd:doc -->',
  '<!--gmd:block{"id":"b1","hist":[]}-->',
  '<!-- /gmd:block',
  '-->',
  '<!--',
  '```',
  '~~~',
  '```markdown',
  '<!-- gmd:block {"id":"b 1","hist":[]} -->',
  '<!-- gmd:block {"id":"b1","hist":[],"extra":{"a":1}} -->',
  '\r\n',
  '\n\n',
  '正文行',
  '"--"',
  '正文含 --> 箭头',
  '\uFEFF',
  '\u0000',
  '中文🙂',
];

const base = buildGmd(
  { gmd: 1, doc_id: 'd0', created_at: 't0' },
  [
    {
      id: 'b1',
      hist: [
        {
          rev: 1,
          at: 't',
          path: 'src/a.ts',
          range: [1, 2],
          commit: 'c',
          src_hash: `sha256:${'a'.repeat(64)}`,
          text_hash: `sha256:${'b'.repeat(64)}`,
          text: '正文',
        },
      ],
      text: '正文',
    },
  ],
  '尾部自由文本',
);

let ok = 0;
let formatErrors = 0;
let crashes = [];
let roundTripMismatch = [];
let notIdempotent = [];

for (let i = 0; i < 1500; i++) {
  let input;
  const mode = i % 3;
  if (mode === 0) {
    // 随机拼装标记汤
    const n = 1 + Math.floor(rnd() * 6);
    input = Array.from({ length: n }, () => pick(ATOMS)).join(pick(['\n', '\n', '\r\n', '']));
  } else if (mode === 1) {
    // 对合法文档做随机变异
    const chars = base.split('');
    const ops = 1 + Math.floor(rnd() * 6);
    for (let k = 0; k < ops; k++) {
      const at = Math.floor(rnd() * chars.length);
      const kind = rnd();
      if (kind < 0.34) chars.splice(at, 1);
      else if (kind < 0.67) chars.splice(at, 0, pick(['<!--', '-->', '--', '```', '"', '{', '}', '\n']));
      else chars.splice(at, 1, pick(['\n', '\\', '\u0000']));
    }
    input = chars.join('');
  } else {
    // 纯随机字节（含非法 UTF-8 的替代字符、控制字符）
    const n = Math.floor(rnd() * 200);
    input = Array.from({ length: n }, () => String.fromCharCode(Math.floor(rnd() * 0x2500))).join('');
  }

  let parsed = null;
  try {
    parsed = parseGmd(input);
    ok++;
  } catch (e) {
    if (e instanceof GmdFormatError) {
      formatErrors++;
      // 格式错误必须带**有限**行号，且信息非空
      if (!Number.isInteger(e.line) || e.line < 1 || !e.message) crashes.push([input, `坏的行号/信息: ${e.line} ${e.message}`]);
      continue;
    }
    crashes.push([input, `${e?.name}: ${e?.message}`]);
    continue;
  }

  // 成功解析 ⇒ 必须能序列化，且再解析回来逐字段一致；再序列化必须逐字节一致
  try {
    const out1 = serializeGmd(parsed.raw, parsed.blocks);
    const again = parseGmd(out1);
    if (JSON.stringify(again.blocks) !== JSON.stringify(parsed.blocks) || again.doc.doc_id !== parsed.doc.doc_id) {
      roundTripMismatch.push([input, out1]);
    }
    const out2 = serializeGmd(again.raw, again.blocks);
    if (out1 !== out2) notIdempotent.push([input, out1, out2]);
  } catch (e) {
    crashes.push([input, `往返失败: ${e?.name}: ${e?.message}`]);
  }
}

console.log(`模糊 1500 例：成功解析 ${ok}，格式错误 ${formatErrors}，异常崩溃 ${crashes.length}，往返不一致 ${roundTripMismatch.length}，非幂等 ${notIdempotent.length}`);
for (const [input, why] of crashes.slice(0, 3)) console.log(`  CRASH: ${why}\n    input=${JSON.stringify(input).slice(0, 200)}`);
for (const [input, out] of roundTripMismatch.slice(0, 2)) console.log(`  RT: input=${JSON.stringify(input).slice(0, 160)}\n    out=${JSON.stringify(out).slice(0, 200)}`);
for (const [input, o1, o2] of notIdempotent.slice(0, 2)) console.log(`  IDEM: input=${JSON.stringify(input).slice(0, 160)}\n    o1=${JSON.stringify(o1).slice(0, 160)}\n    o2=${JSON.stringify(o2).slice(0, 160)}`);
console.log(crashes.length === 0 && roundTripMismatch.length === 0 && notIdempotent.length === 0 ? 'PASS  解析器只允许"成功"或"GmdFormatError"，且往返幂等' : 'FAIL');
