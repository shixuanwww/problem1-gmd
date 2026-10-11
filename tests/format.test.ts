/**
 * 解析 / 格式破坏用例（PLAN §8 用例 8、9、19b）+ 首块约束。
 * 题面硬约束：格式损坏或元数据无法解析**必须报错**，绝不判为可用。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blockOf, cli, docPath, freshRepo, parseJson, readText, writeText } from './helpers.ts';

test('用例 8：块未闭合 → 退出码 2，错误信息含行号', async () => {
  const { repo } = await freshRepo();
  const raw = readText(docPath(repo));
  const corrupt = `${raw}<!-- gmd:block {"id":"bX","hist":[]} -->\n这一块永远不会闭合\n`;
  writeText(docPath(repo), corrupt);

  const res = await cli(['read', 'docs/api.gmd', '--repo', repo]);
  assert.equal(res.code, 2, `应为格式损坏，实际 ${res.code}`);
  assert.match(res.err, /未闭合/);
  assert.match(res.err, /第 \d+ 行/);
  assert.equal(res.out.trim(), '', '格式损坏时 stdout 不应有内容（人类可读文字走 stderr）');
});

test('用例 9：块头 JSON 非法 → 退出码 2', async () => {
  const { repo } = await freshRepo();
  const raw = readText(docPath(repo));
  const corrupted = raw.replace('<!-- gmd:block {"id":"b2"', '<!-- gmd:block {oops');
  assert.notEqual(corrupted, raw, '替换必须生效，否则用例形同虚设');
  writeText(docPath(repo), corrupted);

  const res = await cli(['read', 'docs/api.gmd', '--repo', repo]);
  assert.equal(res.code, 2);
  assert.match(res.err, /JSON/);
  assert.match(res.err, /第 \d+ 行/);
});

test('首块约束：文件第一个非空内容不是 gmd:doc → 退出码 2', async () => {
  const { repo } = await freshRepo();
  const original = readText(docPath(repo));

  // (a) 前面出现了一个片段标记 ⇒ 第一个标记不是 doc
  writeText(
    docPath(repo),
    `<!-- gmd:block {"id":"bZ","hist":[]} -->\n领先于文档头的片段\n<!-- /gmd:block -->\n\n${original}`,
  );
  const a = await cli(['read', 'docs/api.gmd', '--repo', repo]);
  assert.equal(a.code, 2);
  assert.match(a.err, /第一个非空内容必须是 gmd:doc 块/);

  // (b) 文档头前面有普通正文 ⇒ 也不允许
  writeText(docPath(repo), `随便写一行普通 Markdown\n${original}`);
  const b = await cli(['read', 'docs/api.gmd', '--repo', repo]);
  assert.equal(b.code, 2);
  assert.match(b.err, /gmd:doc 块之前不允许出现内容/);
  assert.match(b.err, /第 2 行/);
});

test('用例 19b：手改正文但不追加版本 → error（正文与元数据不一致），且不影响其它片段', async () => {
  const { repo } = await freshRepo();
  const raw = readText(docPath(repo));
  const edited = raw.replace('按键取值。键不存在时返回 `null`，**不抛异常**。', '按键取值（手改，没有追加版本）。');
  assert.notEqual(edited, raw, '替换必须生效');
  writeText(docPath(repo), edited);

  const res = await cli(['read', 'docs/api.gmd', '--json', '--repo', repo]);
  assert.equal(res.code, 3, '存在 error 块 ⇒ read 退出码 3');
  const payload = parseJson(res.out);
  const b1 = blockOf(payload, 'b1');
  assert.equal(b1.severity, 'error');
  assert.equal(b1.reason, '正文与元数据不一致');
  assert.equal(b1.currentSource, null, 'error 必须隐藏旧文字');
  assert.deepEqual(b1.changes, []);
  assert.equal(blockOf(payload, 'b2').severity, 'ok', '片段级独立');
});

/**
 * 用例 26（回归）：正文在**围栏代码块**里写 gmd 标记字面量 ⇒ 仍是合法文档。
 *
 * 题面要求「普通 Markdown 阅读体验不应被明显破坏」。一份讲 .gmd 格式本身的文档必然会在代码块里
 * 写出 `<!-- gmd:block ... -->`；若把字面量当真标记，合法文档会被判成「片段嵌套 / 未闭合」。
 */
test('用例 26：围栏代码块里的 gmd 标记字面量不得被当真标记（可写入、可读回）', async () => {
  const { repo } = await freshRepo();
  const body = [
    '## 格式示例',
    '',
    '```markdown',
    '<!-- gmd:block {"id":"x","hist":[]} -->',
    '正文',
    '<!-- /gmd:block -->',
    '```',
    '',
    '上面两行是字面量，不是真标记。',
  ].join('\n');

  const committed = await cli(['commit', 'docs/api.gmd', '--block', 'b2', '--repo', repo, '--input', '-', '--json'], {
    stdin: body,
  });
  assert.equal(committed.code, 0, `含标记字面量的正文应当能写回：${committed.err}`);

  const res = await cli(['read', 'docs/api.gmd', '--json', '--repo', repo]);
  assert.equal(res.code, 0, `含标记字面量的正文应当能解析：${res.err}`);
  const payload = parseJson(res.out);
  assert.equal(blockOf(payload, 'b2').severity, 'ok');
  assert.equal(blockOf(payload, 'b2').rev, 2, '写回确实追加了一版');
  assert.equal(blockOf(payload, 'b1').severity, 'ok', '其它片段不受影响');
  assert.ok(readText(docPath(repo)).includes('```markdown'), '围栏原样保留');
});

/**
 * 用例 27（安全回归）：来源路径含 `..` ⇒ 格式非法（码 2）。
 *
 * 修复前该路径会被 `path.resolve` 解析到仓库之外，`gmd read` 会把仓库外文件的内容
 * 当「来源当前内容」打印出来（任意文件读取）。`..` / 绝对路径 / 盘符一律拒绝。
 */
test('用例 27：来源路径含 .. 逃逸仓库 → 格式非法（退出码 2），绝不读仓库外文件', async () => {
  const { repo } = await freshRepo();
  const raw = readText(docPath(repo));
  for (const bad of ['../outside.ts', 'src/../../outside.ts', '/etc/hosts', 'C:/Windows/win.ini', 'src//kv.ts']) {
    const corrupted = raw.replace('"path":"src/kv.ts"', `"path":"${bad}"`);
    assert.notEqual(corrupted, raw, '替换必须生效');
    writeText(docPath(repo), corrupted);

    const res = await cli(['read', 'docs/api.gmd', '--repo', repo]);
    assert.equal(res.code, 2, `path=${bad} 必须判格式损坏，实际 ${res.code}`);
    assert.match(res.err, /path/);
    assert.equal(res.out.trim(), '', '格式损坏时 stdout 不得有内容（更不能回显仓库外文件）');
  }
});
