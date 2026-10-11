/**
 * 阶段 1 / 2 的判定用例（PLAN §8 用例 1–7、19c、23）。
 * 每个用例都从模板仓库**克隆**一份，互不污染。
 *
 * 铁律（PLAN §8 用例 0）：改完源文件**必须提交**，否则 §4.3 步骤 3 的 dirty 闸门会把结果截成
 * `warning` 且 `writable=false`。只有用例 6 / 14 / 23 保留未提交态。
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';

import { CONF_TS, KV_TS, commitAll } from '../scripts/setup-fixtures.ts';
import { isRangeDirty } from '../src/gitrepo.ts';
import { blockOf, cli, freshRepo, parseJson, readText, srcPath, writeText } from './helpers.ts';

const D = '2026-08-01T00:00:00Z';

async function judge(repo: string): Promise<unknown> {
  const res = await cli(['read', 'docs/api.gmd', '--json', '--repo', repo]);
  assert.ok(res.code === 0 || res.code === 3, `read 非预期退出码 ${res.code}: ${res.err}`);
  return parseJson(res.out);
}

test('用例 1：未被改动的块 → ok，且 currentSource 有值', async () => {
  const { repo } = await freshRepo();
  const payload = await judge(repo);
  for (const id of ['b1', 'b2', 'b3']) {
    const b = blockOf(payload, id);
    assert.equal(b.severity, 'ok', `${id} 应为 ok`);
    assert.equal(b.dirty, false);
    assert.equal(b.writable, true);
    assert.ok(typeof b.currentSource === 'string' && b.currentSource.length > 0, `${id} 应有 currentSource`);
    assert.deepEqual(b.changes, []);
  }
});

test('用例 2：只改引用范围之外的行（已提交）→ 仍为 ok', async () => {
  const { repo } = await freshRepo();
  const lines = KV_TS.split('\n');
  lines[2] = 'export type Key = string; // 用例 2：块外无关改动';
  writeText(srcPath(repo), lines.join('\n'));
  await commitAll(repo, 'case 2: 改无关处', D);

  const payload = await judge(repo);
  assert.equal(blockOf(payload, 'b1').severity, 'ok');
  assert.equal(blockOf(payload, 'b2').severity, 'ok');
  assert.equal(blockOf(payload, 'b3').severity, 'ok');
});

test('用例 3：改引用范围内一行（已提交）→ warning + changes 非空', async () => {
  const { repo } = await freshRepo();
  const lines = KV_TS.split('\n');
  lines[14] = '  return null; // 用例 3：范围内第 15 行被动过';
  writeText(srcPath(repo), lines.join('\n'));
  await commitAll(repo, 'case 3: 改范围内一行', D);

  const payload = await judge(repo);
  const b1 = blockOf(payload, 'b1');
  assert.equal(b1.severity, 'warning');
  assert.ok(b1.changes.length > 0, 'changes 应非空');
  assert.equal(b1.dirty, false);
  assert.equal(b1.writable, true);
  assert.equal(blockOf(payload, 'b2').severity, 'ok');
});

test('用例 4：删掉整个源文件（已提交）→ error，currentSource 为 null、changes 为空', async () => {
  const { repo } = await freshRepo();
  rmSync(srcPath(repo));
  await commitAll(repo, 'case 4: 删除 src/kv.ts', D);

  const payload = await judge(repo);
  for (const id of ['b1', 'b2']) {
    const b = blockOf(payload, id);
    assert.equal(b.severity, 'error');
    assert.equal(b.currentSource, null, 'error 必须刻意隐藏旧文字');
    assert.deepEqual(b.changes, []);
    assert.equal(b.writable, false);
  }
  assert.equal(blockOf(payload, 'b3').severity, 'ok', '片段级独立：b3 不受影响');
});

test('用例 5：把引用范围整段替换成无关内容（已提交）→ error（不是 warning）', async () => {
  const { repo } = await freshRepo();
  const lines = KV_TS.split('\n');
  const decoy = [
    '[server]',
    'host = example.invalid',
    'retries = 3',
    'timeout_ms = 250',
    'log_level = info',
    'max_conn = 64',
    'tls = off',
    'idle_timeout = 30',
    'region = cn-north',
    'protocol = udp',
    'batch = 128',
    'queue = fifo',
    'workers = 4',
    'cache = lru',
    'backoff = exp',
  ];
  lines.splice(9, 15, ...decoy); // 覆盖第 10–24 行（b1 的 15 行）
  assert.equal(lines.length, KV_TS.split('\n').length, '替换后总行数不变，b2 的行号才稳定');
  writeText(srcPath(repo), lines.join('\n'));
  await commitAll(repo, 'case 5: 整段替换 b1 范围', D);

  const payload = await judge(repo);
  const b1 = blockOf(payload, 'b1');
  assert.equal(b1.severity, 'error', '行集合相似度 < 0.20 ⇒ 必须判 error');
  assert.equal(b1.currentSource, null);
  assert.equal(blockOf(payload, 'b2').severity, 'ok');
});

test('用例 6：范围里有未提交修改 → warning + dirty + 禁止写回', async () => {
  const { repo } = await freshRepo();
  const lines = KV_TS.split('\n');
  lines[11] = ' * 按键取值（未提交的改动）。';
  writeText(srcPath(repo), lines.join('\n'));
  // 刻意不提交

  const b1 = blockOf(await judge(repo), 'b1');
  assert.equal(b1.severity, 'warning');
  assert.equal(b1.dirty, true);
  assert.equal(b1.writable, false);
  assert.match(b1.reason, /未提交修改/);
  assert.equal(await isRangeDirty(repo, 'src/kv.ts', [10, 24]), true, 'isRangeDirty 必须为 true');
});

test('用例 7：内容仍在但上方插入 10 行（已提交）→ warning，reason 提及行号', async () => {
  const { repo } = await freshRepo();
  const original = KV_TS.split('\n');
  const inserted = Array.from({ length: 10 }, (_, i) => `// 用例 7：上方插入的第 ${i + 1} 行`);
  writeText(srcPath(repo), [...inserted, ...original].join('\n'));
  await commitAll(repo, 'case 7: 上方插 10 行', D);

  const payload = await judge(repo);
  const b1 = blockOf(payload, 'b1');
  assert.equal(b1.severity, 'warning');
  assert.match(b1.reason, /行号/);
  assert.deepEqual(b1.changes, [], '行号漂移不是内容变更，changes 应为空');
  assert.equal(b1.currentSource, original.slice(9, 24).join('\n'), '应回显漂移后的那 15 行原文');
});

test('用例 19c：单行范围的短引用被改写（已提交）→ warning 而非 error', async () => {
  const { repo } = await freshRepo();
  const lines = CONF_TS.split('\n');
  lines[11] = '  port: 9090,';
  writeText(srcPath(repo, 'src/conf.ts'), lines.join('\n'));
  await commitAll(repo, 'case 19c: 改写单行引用', D);

  const payload = await judge(repo);
  const b3 = blockOf(payload, 'b3');
  assert.equal(b3.severity, 'warning', '单行引用改写必须走字符集合 Jaccard 判 warning');
  assert.ok(b3.currentSource !== null && b3.currentSource.includes('9090'));
  assert.equal(blockOf(payload, 'b1').severity, 'ok');
});

test('用例 23：工作区是 CRLF、HEAD 是 LF、内容语义相同 → ok，换行不构成 dirty', async () => {
  const { repo } = await freshRepo();
  writeText(srcPath(repo), KV_TS.replace(/\n/g, '\r\n')); // 只改换行字节，不提交

  const payload = await judge(repo);
  const b1 = blockOf(payload, 'b1');
  assert.equal(b1.severity, 'ok', 'CRLF 工作区 vs LF HEAD 不应被判成变化');
  assert.equal(b1.dirty, false);
  assert.equal(b1.writable, true);
  assert.equal(await isRangeDirty(repo, 'src/kv.ts', [10, 24]), false);

  const raw = readText(srcPath(repo));
  assert.ok(raw.includes('\r\n'), '确认工作区确实是 CRLF');
});
