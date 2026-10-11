# `.gmd` 衍生文档管理器（题 1 交付说明）

> **一句话**：`.gmd` 是一种面向 AI 的衍生文档格式（Markdown 超集），配套 `gmd` CLI ——
> 一段"由代码衍生而来的说明文字"，读到的那一刻就能回答：**还准不准（ok / warning / error）、
> 不准时该照旧用还是重写、为什么变了（一条命令看 Git 历史）**。
>
> 本 README 面向**快速评审**：完成度 → 怎么用 → 怎么检查 → 代码导读。
> 完整设计细节（格式文法 / 判定算法逐条 / 设计取舍）见 **`docs/README-设计详版.md`**；
> 每个模块的《答辩问答》在 **`docs/defense/`**。

---

## 1. 完成度（对照题面）

| 题面要求 | 状态 |
|---|---|
| `.gmd` 格式设计（单文件自包含：文档标识 / 片段 / 版本历史 / 来源全部内嵌，无旁车文件） | ✅ |
| 严格解析：格式损坏或元数据不可解析**必须报错**（带行号），绝不判为可用 | ✅ |
| `read`：默认冲突视图，每块三档判定（ok / warning / error） | ✅ |
| `log`：片段版本历史 + 来源文件提交历史 | ✅ |
| `edit` / `commit`：改得回（草稿 → 校验 → 写回，历史只追加） | ✅ |
| 三档判定语义：只看引用范围 / error 隐藏旧文字 / 基于工作区现状 | ✅ |
| warning（内容变化）与 error（整段替换/删除）的区分 | ✅（分段 Jaccard 相似度） |
| "文档不能靠修改自身说明信息宣称自己最新" | ✅（步骤 0：正文哈希 ≠ `text_hash` 即 error） |
| 不伪造正式版本（来源有未提交修改时拒绝写回） | ✅（dirty 闸门；`--allow-dirty` 受控放行并留审计标记） |
| 可选进阶：`--allow-dirty` / 重绑定来源 / 历史正文内嵌 | ✅ 三项全做 |
| 可选进阶：符号/选区级引用、分支与祖先判断、MCP 集成 | ❌ 未做（`docs/README-设计详版.md` §6 如实声明） |

**测试**：45 条验收用例 **45 pass / 0 fail**（约 14s）＋ 7 个对抗性探针 **58 项断言全 PASS**（含 1500 例解析器模糊测试：崩溃 0 / 往返不一致 0）。

---

## 2. 怎么使用

**环境**：Node ≥ 22.6（`node -v` 自检）、git 在 PATH（唯一外部程序）。**零第三方依赖、离线可跑**。

```bash
# ① 生成/重建测试仓库（幂等，可反复跑）
node --experimental-strip-types scripts/setup-fixtures.ts

# ② 读一份真实文档（默认冲突视图：正文 + 每块判定）
node --experimental-strip-types src/cli.ts read docs/api.gmd --repo fixtures/repo

# ③ 四个子命令
#    read  <doc> [--block b1] [--version 2] [--plain|--json]   读 + 三档判定
#    log   <doc> [--block b1 | --path src --range 10..24]       版本历史 / 来源提交历史
#    edit  <doc> --block b1                                     生成草稿（改正文用）
#    commit <doc> --block b1 --input new.md                     写回（追加新版本）
```

> `bin/gmd`（POSIX）/ `bin/gmd.cmd`（Windows）是转发壳，装入 PATH 后命令名即题面要求的 **`gmd`**。
> `--repo` 可省略（默认从当前目录向上找 `.git`）。

**退出码**：0 成功 ／ 1 用法错误 ／ 2 格式损坏 ／ 3 存在 error 块 ／ 4 写回被拒 ／ 5 环境错误。
`--json` 输出单行合法 JSON（`JSON.parse` 必成功），供脚本 / AI 直接分支。

---

## 3. 怎么检查（3 分钟验收清单）

```bash
# A. 全量用例（应输出 # tests 45 / # pass 45 / # fail 0）
node --experimental-strip-types scripts/setup-fixtures.ts
node --experimental-strip-types --test "tests/*.test.ts"

# B. 对抗探针（7 个，逐个跑；共 58 项，应全部 passed）
node --experimental-strip-types probes/gmd-probe.mjs      # …probe2…probe7

# C. 判定行为肉眼验证（演示 1：ok → 改无关处仍 ok → warning → error → log 追查）
node --experimental-strip-types demo/stage1-2.ts

# D. 写回闭环（演示 2：warning → edit 草稿 → commit → 回到 ok，hist 长度 2）
node --experimental-strip-types demo/warning-loop.ts
```

**预期看点**：
- 演示 1 里"整段替换"与"删文件"都判 `error`，且**不回显来源旧文字**（题面：防 AI 补丁式修改已不存在的目标）；
- 演示 2 的 `commit` 走五道校验（非空 / base_rev 一致 / 范围存在 / dirty 闸门 / 内容确实变了），任一不过退出码 4；
- 格式示意 `docs/example.gmd` 的哈希是刻意写错的示意值：`read` 它应返回**退出码 3**（error 块）而非 2（格式损坏）——可用来验证"解析器与判定器分工正确"。

---

## 4. 代码导读

```
src/
  types.ts      数据契约（gmd:doc / gmd:block / hist[] 字段）
  format.ts     解析 / 序列化（严格报错带行号；JSON 内 -- 转义；围栏代码块内标记不识别）
  gitrepo.ts    git 适配层（异步 spawn + 15s 超时）+ hashRange / textHash / 换行归一化唯一实现
  judge.ts      判定引擎（本题算法核心）：步骤 0–6 顺序判定 + 一轮内共享缓存
  diff.ts       行级差异（changes）+ 有界预览（单行 200 / 总 20000 字符封顶）
  edit.ts       草稿生成 / 草稿头剥离
  commit.ts     写回五道闸门 + 原子写（.tmp → rename）+ --path/--range 重绑定
  render.ts     冲突视图 / --json / --plain 输出
  cli.ts        参数解析 + 子命令分发 + 退出码（选项归属严格，传错即码 1）
scripts/setup-fixtures.ts   幂等重建 fixtures/repo（演示与测试共用）
demo/stage1-2.ts · warning-loop.ts   两个演示脚本（自建 fixture，可反复跑）
tests/*.test.ts    45 条验收用例（每条从模板仓库 clone 到独立临时目录，互不污染）
probes/gmd-probe*.mjs   7 个对抗探针：路径逃逸 / 越界伪造 ok / 模糊测试 / 边界环境…
```

**主要设计（答辩深挖入口，详版各有展开）**：
1. 元数据藏 HTML 注释 → Markdown 渲染器完全忽略，阅读体验零破坏、零依赖；
2. 判定用**行集合 / 字符集合 Jaccard** 而非 git diff → 对行号漂移免疫（diff 在文件中部插入一行后整体错位）；
3. 短引用（≤2 行）单独用字符集合（阈值 0.30）→ 防止单行改写被误判 error；
4. 历史只追加、每版正文内嵌 → `--version N` 可取回任意历史；代价是文件线性膨胀（单文件自包含的必要开销）；
5. 换行归一化只有一份实现 → `core.autocrlf=true` 不会把所有块永久判脏。
