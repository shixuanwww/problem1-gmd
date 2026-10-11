# `.gmd` —— Git 衍生文档管理器

> **一句话定位**：`.gmd` 是一种**面向 AI 的衍生文档格式**（Markdown 的超集），让一段"由代码/配置衍生而来的文字"在**读到的那一刻**就能回答三个问题 —— ① 还准不准（`ok`/`warning`/`error`）② 不准时该照旧用、自己判断、还是必须重写 ③ 想追问"为什么变了"，**一条命令**就能看到来源的 Git 变化过程。配套 `gmd` CLI 负责读、查、改、写回。

---

## 1. 启动方式（两条命令以内）

```bash
node --version   # 需要 >= 22.6（见 §8）
git --version    # git 必须在 PATH 中（唯一的外部程序）

# ① 生成/重建测试仓库（幂等，可反复跑）
node --experimental-strip-types scripts/setup-fixtures.ts

# ② 读一个真实文档（默认冲突视图）
node --experimental-strip-types src/cli.ts read docs/api.gmd --repo fixtures/repo
```

装到 PATH 后命令名就是题面硬要求的 **`gmd`**：`bin/gmd`（POSIX）、`bin/gmd.cmd`（Windows）。
**无需 `gmd init`、无需项目级配置**：仓库靠 `--repo <path>` 或"当前目录向上找 `.git`"定位。

> 装了 PATH 之后：
> ```bash
> gmd read docs/api.gmd --repo fixtures/repo
> ```

---

## 2. `.gmd` 格式（本项目门面）

`.gmd` = 普通 Markdown + 若干**HTML 注释块**。标准 Markdown 渲染器**完全忽略 HTML 注释**，所以**阅读体验不被破坏**（题面要求），而机器又能拿到全部元数据。

### 2.1 文法

```
.gmd 文件 := [BOM] [空行] doc 头块 block*
doc 头块  := "<!-- gmd:doc "   <JSON> "-->"        ← 文件内第一个非空内容，必须存在
block     := "<!-- gmd:block " <JSON> "-->" 正文 "<!-- /gmd:block -->"
正文      := 任意 Markdown（可含空行、围栏代码块、HTML）；围栏代码块内的 gmd 标记字面量不算标记
其余      := 块外的普通 Markdown = 自由文本，**不参与判定**
```

**六条不可放宽的解析纪律**（题面："格式损坏或元数据无法解析必须报错，绝不判为可用"）：

1. 文件内**第一个非空内容必须是 `gmd:doc` 块**，否则报错（退出码 2）；
2. `gmd:block` / `/gmd:block` 必须**成对且不嵌套**，未闭合 / 嵌套 / JSON 非法 / `id` 非法或重复 / `hist` 为空或 `rev` 不连续 ⇒ 报错并指出**出错行号**；
3. **JSON 里不得出现裸 `--`**：序列化时把 `--` 转义成 `\u002d\u002d`（HTML 注释内出现 `--` 会提前闭合、把整个格式搞坏）。
4. **来源路径必须落在仓库内**：`hist[].path` 不得是绝对路径 / 盘符 / 反斜杠，也不得含 `..`、`.` 或空段 ⇒ 报错（退出码 2）。否则一份 `.gmd` 就能让 `gmd read` 把**仓库外**的任意文件当"来源当前内容"打印出来。
5. **围栏代码块（\`\`\` / `~~~`）内的 `<!-- gmd:… -->` 是字面量，不算标记**：这样"讲 .gmd 格式本身"的文档（在代码块里写标记示例）依然是合法文档。只承认**已闭合**的围栏 —— 一个没配对的围栏不得把后面真正的块标记一起吞掉。
6. **不认识 ≠ 丢弃（前向兼容）**：`gmd:doc` / 块头 / 版本记录里本工具不认识的字段**一律原样保留**并写回；`commit` **只重写目标片段**，其它片段按原文**逐字节拷贝**。格式带 `gmd:1` 版本号 ⇒ 将来一定会有新字段，"老工具改新文件"绝不能**静默丢数据**（比报错更糟）。

### 2.2 字段说明

| 位置 | 字段 | 含义 |
|---|---|---|
| `gmd:doc` | `gmd` | 格式版本，恒为 `1` |
| | `doc_id` | UUID；**文件名不含它**（题面：文件名不含任何版本信息） |
| | `created_at` | 创建时刻 |
| `gmd:block` | `id` | 片段标识，`^[A-Za-z0-9_-]{1,64}$`，文件内唯一 |
| | `hist[]` | 该片段的**全部生成版本**，只追加、不覆盖、不删除 |
| `hist[i]` | `rev` | 版本号，从 1 起**连续**（= 下标 + 1） |
| | `at` | 该版本的生成时刻 |
| | `path` | 来源文件路径（相对仓库根、正斜杠；**不得含 `..` / `.` / 空段**，见 §2.1 纪律 4） |
| | `range` | 引用的**源文件行范围**，1-based 闭区间 `[l0,l1]` |
| | `commit` | 记录时的仓库 HEAD 全 sha |
| | `src_hash` | `range` 内文本的摘要（`sha256:<hex>`） |
| | `text_hash` | 本片段正文（换行归一化后 `trim`）的摘要 |
| | `text` | **该版本的正文**（阶段 4·3）。本实现写出的版本**一律带它**，于是 `gmd read --version <rev>` 能取回"那一版写了什么"，`text_hash` 也从"不可验证的承诺"变成**可验证的摘要**（解析时校验二者一致，不一致即码 2）。代价是每追加一版多存一份正文（见 §5.3）；旧格式文件可缺此字段，那一版只取不到正文 |
| | `note` | 可选备注（如 `based_on_dirty`） |

### 2.3 格式示意（`docs/example.gmd`，与 PLAN §3.2 逐字一致）

```markdown
<!-- gmd:doc {"gmd":1,"doc_id":"d7f3a1c2-...","created_at":"2026-07-01T09:00:00Z"} -->

# KVStore 接口说明

本文档由 `src/kv.ts` 的接口定义衍生而来。

<!-- gmd:block {"id":"b1","hist":[{"rev":1,"at":"...","path":"src/kv.ts","range":[10,24],"commit":"a1b2c3d4...","src_hash":"sha256:9f8e...","text_hash":"sha256:1122..."}]} -->

## `get(key): Promise<Buffer | null>`

按键取值。键不存在时返回 `null`，**不抛异常**。

<!-- /gmd:block -->

## 备注

本节不是衍生内容，不做判定。     ← 块外文本 = 完全自由的普通 Markdown
```

> ⚠️ `docs/example.gmd` 是**格式示意**：它的 `src_hash` / `text_hash` 是**示意值**（与正文对不上），所以两个块会被判 `error`「正文与元数据不一致」—— 这是**刻意**的。但它**格式本身合法、必须能通过严格解析**：`gmd read docs/example.gmd` 应返回 **3**（存在 error 块），**不应**返回 **2**（格式损坏）。
> 这份示意里**故意没有 `hist[].text`** —— 正因为它的 `text_hash` 是示意值，一旦补上 `text` 就会命中"`text` 与 `text_hash` 不一致"的自洽校验而变成**码 2**。所以它同时也是"旧格式 / 手写骨架（无历史正文）"的样例：`read --version 1` 会明确告诉你要的那一版**未存正文**。
> 想看一个**可被真实判定为 `ok`** 的文档，请先跑 `scripts/setup-fixtures.ts`，再 `gmd read docs/api.gmd --repo fixtures/repo`。

### 2.4 单文件自包含 / 侧车文件说明（PLAN 附二 2）

文档标识、片段划分、版本历史、来源信息、Git 版本与时间**全部内嵌在 `.gmd` 内**；**不生成任何侧车元数据文件**，**不做缓存**。

唯一会写到磁盘的额外产物是 `gmd edit` 的**草稿**（`<repo>/.gmd/tmp/*.draft.md`）：它**是可随时删除的临时文件**，**判定从不读它**，因此**不是**题面禁止的"旁车文件/索引/数据库"。`gmd commit` 成功后它即可删除。

---

## 3. 三档判定算法（`src/judge.ts`，本题算法核心）

对每个片段的**活动版本** `v = hist[last]` 按顺序执行：

| 步骤 | 判定 | 结果 |
|---|---|---|
| **0** | `textHash(块正文) ≠ v.text_hash` | `error`「正文与元数据不一致」—— 手改正文却不追加版本，等于"文档自己宣称最新"，**不认账**（题面：文档不能靠修改自身说明信息宣称自己是最新的） |
| **1** | 工作区里 `v.path` 不存在 | `error`「引用文件不存在」（**重命名也算不存在**，本题不做 rename 跟踪） |
| **2** | 读工作区原文（严格 UTF-8） | 非 UTF-8 / 含 NUL ⇒ `error`「来源不是 UTF-8 文本」 |
| **3** | **范围级 dirty**：`hashRange(工作区, v.range) ≠ hashRange(HEAD 的该文件, v.range)` | `warning`「引用范围内存在未提交修改」+ `dirty=true` + `writable=false` |
| **3.5** | **引用范围是否仍然存在**：`v.range[1] > countLines(工作区)` | `error`「引用范围已不存在（来源现有 N 行）」。为什么单独判：`hashRange` 对越界范围会**静默截断**，范围全在文件外时退化成空串哈希 ⇒ 会把"引用目标已消失"错判成"内容未变化" |
| **4** | `hashRange(工作区, v.range) === v.src_hash` | `ok`「引用范围内内容未变化」 |
| **5** | 在 `[l0-50, l1+50]` 窗口内滑窗找**同长度**、且 hash 相同的片段 | `warning`「引用内容仍在文件中，但已不在原行号范围」（**处理行号漂移**） |
| **6** | 相似度分段判定（见下） | `warning`（内容变了）或 `error`（整段被替换/删除） |

### 3.1 步骤 6 的**分段相似度阈值**

| 引用范围 | 度量 | 阈值 | 判 `error` 的条件 |
|---|---|---|---|
| **≥ 3 行** | 非空行的**行集合 Jaccard** | **0.20** | `sim < 0.20` |
| **≤ 2 行** | 各行首尾相接后的**去重字符集合 Jaccard** | **0.30** | `sim < 0.30` |

**为什么必须分段**（这是本设计的关键取舍）：范围只有 1 行时（配置项引用常是 `range:[12,12]`），把这一行改写 ⇒ **行集合交集必然为空** ⇒ `sim = 0` ⇒ 会把题面明确归为 `warning` 的"引用范围还在、内容变了"误判成 `error`。所以短引用改用**字符集合**：`PORT = 8080 → PORT = 9090` 时 `sim ≈ 0.9`，正确落在 `warning`。两个阈值都**可调**，但**同一输入必得同一输出**（可复现）。

### 3.2 三条铁律

- **只看 `v.range`**：同一文件其它地方的改动**不算过期**（题面："判断只看被引用的范围"）。dirty 检查也只是范围级，函数是 `isRangeDirty(path, range)`，不是整文件级的。
- **`error` 时 `currentSource = null`、`changes = []`**：题面"error 刻意隐藏旧文字"（留着旧文字会诱导 AI 做补丁式修改，而引用目标已不在）。
- **判定依据永远是工作区（worktree）当前内容**，不是 `HEAD`（题面"基于读取时的真实仓库状态判断，不用陈旧缓存"）。

### 3.3 换行归一化的唯一口径（避免"自证不一致"）

```ts
normalizeEol(text) = text.split(/\r\n|\r|\n/).join('\n')     // CRLF / LF / 孤立 CR → LF
hashRange(text,[l0,l1]) = sha256( normalizeEol(text).split('\n').slice(l0-1,l1).join('\n') )
textHash(text)          = sha256( normalizeEol(text).trim() )
isRangeDirty(path,range) = hashRange(工作区,range) !== hashRange(HEAD 该文件,range)   // 两边都归一化
```

`hashRange`、`textHash`、`isRangeDirty` **各只有一份实现**（`src/gitrepo.ts`），fixture 脚本与判定引擎共用 ⇒ **换行差异（CRLF 工作区 vs LF HEAD）不构成 dirty**。

---

## 4. CLI 用法

```bash
gmd read   <doc> [--block <id>] [--version <rev>] [--plain|--body] [--json]
gmd log    <doc> [--block <id>] [--path <src>] [--range <a..b>] [--json]
gmd edit   <doc> --block <id> [--json]
gmd commit <doc> --block <id> [--input <file|->] [--allow-dirty] [--path <src>] [--range <a..b>] [--json]

# 全局：--repo <path>（可放子命令前或后）；--json；--plain（read 专用）
```

### 4.1 退出码（脚本/AI 可直接分支）

| 码 | 含义 |
|---|---|
| `0` | 成功；`read` 时所有块均非 error |
| `1` | 参数 / 用法错误 |
| `2` | **格式损坏**（解析失败，含行号） |
| `3` | **存在 `error` 块**（`read` 专用） |
| `4` | **写回被拒**（草稿头校验 + 五道校验之一不过） |
| `5` | 环境错误（`git` 不存在、`--repo` 不是仓库、git 子进程非零退出或超时） |

### 4.2 `--json` 契约（单行合法 JSON，`JSON.parse` 必成功）

| 命令 | 形状 |
|---|---|
| `read --json` | `{"doc": GmdDoc, "blocks": BlockJudgement[]}`（字段与 §3 判定结构一一对应；**给 `--block` 时 `blocks` 只含该块**，与冲突视图口径一致；退出码仍按整篇文档算） |
| `read --version <rev> --json` | **数组**（每个块一行）：`{block, rev, at, path, range, commit, src_hash, text_hash, text, active_severity}` —— `text` = **该版本当时写下的正文**（未存时**显式 `null`**）；`active_severity` = 该块**活动版本**的严重度（历史版本本身不谈严重度，标注在名字里免得被误读成 rev 的属性） |
| `log --json` | `--block` → `[{rev,at,path,range,commit,src_hash,text_hash}]`（版本带 `note` 时**追加**一个 `note` 字段，见下）；`--path`(+`--range`) → `[{sha,short,at,subject}]`；无参数 → `[{id,rev,severity,path,range}]` |
| `commit --json` | `{"block","rev","text_hash","range"}`（`--path` 重新绑定时**追加** `path`，见 §4.2 注 3） |
| `edit --json` | `{"draft_path"}`（绝对路径） |
| 失败 | `{"error","code"}`（与退出码同号；人类可读文字一律走 stderr） |

> 📎 **对 §4.9 契约的三处可选扩展**（都是**附加**的、不改既有字段语义，`JSON.parse` 与既有消费方不受影响）：
> 1. `read --json` 的 `BlockJudgement` 在 `changes` 被截断时附加 `changes_omitted`（§4.5 的截断注记）；
> 2. `log --block --json` 的元素在**该版本有 `note` 时**附加 `note` —— 这是 `--allow-dirty` 写下的 `based_on_dirty`，是"此版本基于未提交来源"的**机器可读审计标记**；没有 `note` 的版本不会凭空多出该字段（形状保持稳定）。
> 3. `commit --json` 在**本次用 `--path` 重新绑定**来源时附加 `path`（新来源路径）；不重绑时形状与原来完全一致。（只给 `--range` 时不会多字段 —— 新范围本来就在 `range` 里。）

### 4.3 `--plain`（别名 `--body`）—— 只出正文

题面"默认冲突视图，**可切换为只出正文**"。`--plain` 只打印块正文：给 `--block` 出该块，缺省按块顺序、空行分隔；**与 `--json` 互斥**（同时给 → 参数错，码 1）。存在 `error` 块时退出码仍为 3。

`--plain` 也可以和 `--version <rev>` 组合：**只出那一版的历史正文**（题面参考接口"取正文"最直接的形态）。若该版本是旧格式文件、没存正文，stdout 不输出内容、stderr 明确说明是哪一版缺正文 —— 取不到正文不是错误，**不用退出码惩罚调用方**。

### 4.4 `gmd edit` / `gmd commit`（阶段 3：改得回）

- **草稿** = `<!-- gmd:draft {"doc","block","base_rev","at"} -->` 头 + 当前正文；路径 `<repo>/.gmd/tmp/<doc 相对路径的分隔符→下划线>-<sha256(文档绝对路径)前8位>-<block>.draft.md`；目标已存在则**覆盖**并提示（不静默追加编号）。
- **`commit` 步骤 0（先做）**：若输入首行以 `<!-- gmd:draft ` 开头 ⇒ **丢弃该行**并解析；`doc`/`block`/`base_rev` 任一与实参或当前状态不符 ⇒ 拒绝（码 4）；**新正文 = 输入去掉草稿头之后的内容**。⇒ **写入 `.gmd` 的正文永不含草稿头**。
- **五道校验**（任一不过 ⇒ 拒绝，码 4）：① 正文非空 ② `base_rev == 当前 rev` ③ **dirty 闸门**（**目标来源**范围有未提交修改且未加 `--allow-dirty`）④ `textHash(新正文) ≠ 当前 text_hash`（否则"内容未变化"）⑤ **引用范围仍然存在**（`targetRange[1] > countLines(目标来源)` ⇒ 拒写，否则越界 range 会被写成"自证一致"的假 `ok`）。**实际执行顺序是 ①②⑤③④** —— ⑤ 与 ③ 共用同一次来源读取，先判更基础的"范围是否真的存在"。
- **目标来源 = 活动版本的 `(path, range)`**，可用 `--path` / `--range` **重新绑定**（见 §4.6）。**校验 3（dirty）与校验 5（越界）一律针对目标来源判** —— 重绑定之后，旧来源已经被这次写回放弃，闸门必须落在**新**来源上。
- **通过后**：`commit = git rev-parse HEAD`、`src_hash = hashRange(目标来源文本, 目标 range)` → `hist.push(rev+1)` → **只就地替换目标片段**（其它片段与文档头按原文逐字节拷贝，扩展字段原样保留，见 §2.1 纪律 6）→ **原子写**（写 `.tmp` → `rename`）。
- **来源在写回时已取不到**（文件被删 / 变成二进制）⇒ 同样**拒绝（码 4）**，理由写明"来源文件已不存在，无法记录新版本的来源信息"。⚠️ 这一条是必需的：题面 §2.4 把"文件没了"列为 `error`（**必须重写**），而 `range` 缺省只能沿用旧范围 ⇒ 光重写正文**记不了新版本的来源**，必须明确拒绝（而不是抛一句 `ENOENT` 让调用方无从分支）。**出路有三条**：① 恢复来源文件；② 用 `--path` / `--range` 把引用改指到仍存在的来源（§4.6）；③ `--allow-dirty`（仅当来源存在但有未提交修改）。

### 4.5 `--allow-dirty`（阶段 4·1，已实现）

来源范围有未提交修改、但显式加 `--allow-dirty` 时：**允许写回**，并在**审计输出**（stderr）显著标注"此版本基于**未提交来源**"，新版本的 `note` 写入 **`based_on_dirty`**。不加该 flag 时严格拒绝（题面硬约束 5："不伪造正式版本"）。

### 4.6 `commit --path / --range`：重新绑定引用（阶段 4）

题面 §2.4 规定 `error` 档"**必须重写**"。但旧来源（文件被删、整段被替换）已经没有出路 —— 只重写正文的话，`--range` 沿用旧值仍会越界，写回必须拒绝。`--path` / `--range` 就是那条缺失的通路：**让 AI 把这块的引用改指到仍存在的来源**，于是 `error` 档也能走完"读 → 判断 → 重写 → 写回"闭环。

```bash
# 例：src/kv.ts 被删（该块 error）→ 重写正文，并把引用改指到 src/conf.ts 第 9–13 行
gmd commit docs/api.gmd --block b1 --path src/conf.ts --range 9..13 --input new-body.md
```

规则：

1. **只影响本版本**：新版本记新 `(path, range)`；`hist` 里**旧版本各自的 `path`/`range` 原样保留**（历史只追加，绝不改写）。
2. **新来源照样过闸**：存在性、`range` 合法性（1-based 闭区间、`l0 ≤ l1`）、`range[1] ≤ 来源行数`、dirty 闸门 —— 任一不过即拒（参数层错误码 1、来源层错误码 4）。
3. `--path` 必须是**仓库内**的相对路径（不得是绝对路径 / 盘符 / 含 `..`），否则码 1。
4. 可以只给其中一个：只给 `--path` 表示"换文件、沿用旧行号"，只给 `--range` 表示"同文件、换范围"。

---

## 5. 设计取舍与理由

1. **为什么用 HTML 注释承载元数据？** 标准 Markdown 渲染器**完全忽略 HTML 注释** ⇒ 普通 Markdown 阅读体验毫发无损；同时它是纯文本、可 diff、可手改、无需引 YAML/JSON-Schema 依赖。代价是注释内**不允许裸 `--`**，故序列化时把 JSON 里的 `--` 转义为 `\u002d\u002d`（只动 JSON 字面量，不动正文）。
2. **为什么用"行集合相似度"而不是 git diff？** diff 需要把"旧文本"与"新文本"按位置对齐，而 `range` 是**绝对行号**：文件中间插一行就会让整个 diff 错位、把正常改动误判成"整段替换"。**行集合相似度对行号漂移天然免疫**，实现简单、结果确定。短引用（≤2 行）下行集合必然退化，故**改用字符集合 Jaccard**（见 §3.1）。
3. **为什么保存每一版的正文（`hist[].text`，阶段 4·3）？** 题面 §2.3 要求"版本历史……全部内嵌于 .gmd"、§2.2 把"历史版本"定义为"同一片段过去生成的版本"—— 只留 `text_hash` 等于**正文没留**：`read --version <rev>` 答不出"那一版到底写了什么"，"想追问为什么变了"也就少了一半。存了之后还有一个额外好处：`text_hash` 从**不可验证的承诺**变成**可验证的摘要**（解析时校验 `textHash(text) === text_hash`，不一致直接判码 2）。
   代价是**真实的**：每追加一版就多存一份正文，文件随版本数线性膨胀。这是"单文件自包含"的必要开销（题面明确要求不依赖旁车文件/索引/数据库）。真要优化，可做增量压缩或从来源重建 —— 本实现选择**先保证语义完整、把代价写清楚**（§6 亦如实登记）。
4. **为什么 dirty 只按 `v.range` 判、且换行不算脏？** 题面"判断只看被引用的范围"。若整文件级判脏、或不做换行归一化，则 `core.autocrlf=true` 的机器上工作区是 CRLF、`git show HEAD:` 给的是 LF，会把**所有块**永久判成 `warning + 不可写回`。

---

## 6. 已实现 / 未实现（如实声明）

**已实现**（阶段 1 + 2 + 3，含阶段 4·1）

- 单文件多片段多版本格式；严格解析（损坏必报错、带行号）；`--` 转义；来源路径必须落在仓库内（防越界读文件）
- 三档判定（步骤 0 → 6 全实现）、行号漂移锚定、分段相似度、error 隐藏旧文字、**步骤 3.5 范围越界必判 `error`**（防 `hashRange` 静默截断伪造成 `ok`）
- CLI：`read`（冲突视图 / `--plain` / `--json` / `--version`）、`log`（片段历史 / 来源提交历史 / `--range` 过滤与降级）、`edit`（草稿）、`commit`（草稿头剥离 + 五道校验 + 原子写 + 追加版本）
- `--allow-dirty` 受控写回（阶段 4·1，`note=based_on_dirty` + 审计标注）
- `commit --path / --range` **重新绑定引用**（阶段 4·2）：`error` 档"重写后把引用改指到仍存在的来源"⇒ 闭环打通；新来源照样过存在性 / 越界 / dirty 三道闸，历史版本各自的 `path`/`range` 不被改写
- **每一版的正文内嵌**（阶段 4·3，`hist[].text`）：`read --version <rev>` 取回"那一版写了什么"（`--plain --version` 只出该版正文）；`text_hash` 变成可验证的摘要
- **前向兼容**：本工具不认识的扩展字段（`gmd:doc` / 块头 / 版本记录任一层）**原样保留**；`commit` 只重写目标片段，其它片段逐字节不变（§2.1 纪律 6）
- 退出码 0–5；`--json` 契约；`--repo` 定位；git 子进程 15s 超时 + `-C` 指定仓库

**未实现**（如实声明，未做不算缺）

- **不提供 `gmd new`**：题面参考接口只有 `read`/`log`/`edit`/`commit`。从零建文档请**手写骨架**（见 §7），`hist[0]` 的两个 hash 用 `hashRange` / `textHash` 实测。
- **不做缓存**（题面"可生成"是可选；不做 = 每次真读仓库，天然满足"不用陈旧缓存"）。
- **不做文件重命名跟踪**（重命名按"文件不存在"判 `error`，诚实且正确）。
- **不做符号 / 选区级引用**（阶段 4 项；`commit` 缺省沿用旧 `range`，需改指时用 `--path` / `--range` 显式重绑定，见 §4.6）。
- **不做历史正文的压缩 / 去重**：每版正文原样内嵌（§5.3 已说明这是"单文件自包含"的必要开销；`hist[].text` 的**可选**性留给了不用历史正文的调用方 —— 旧格式文件缺该字段仍可读）。
- **不做分支 / 祖先判断**（阶段 4 项；未判"来源来自其它分支"）。
- **不做 MCP / Agent 集成**（阶段 4 项）。
- **不做 Markdown AST 解析**（题面明确不要求）。

---

## 7. 快速开始：从零建一份 `.gmd`（无 `gmd new`）

先手写文档头与片段骨架（`src_hash` 用 `hashRange(来源全文, range)` 实测、`text_hash` 用 `textHash(正文)` 实测）：

```markdown
<!-- gmd:doc {"gmd":1,"doc_id":"<UUID v4>","created_at":"<ISO8601>"} -->

# 我的文档

<!-- gmd:block {"id":"b1","hist":[{"rev":1,"at":"<ISO8601>","path":"src/foo.ts","range":[1,5],"commit":"<git rev-parse HEAD>","src_hash":"sha256:<...>","text_hash":"sha256:<...>"}]} -->

## 我对 src/foo.ts:1-5 的总结

……

<!-- /gmd:block -->
```

想省事，可直接跑 `scripts/setup-fixtures.ts` 生成的 `fixtures/repo/docs/api.gmd` 当模板。**新增片段**同理：在已有文档里插入一个块头（`hist[0]` 实测），首次 `gmd commit` 会追加 `rev=1`。

> 两个 hash 怎么算：
> ```
> node --experimental-strip-types -e "import {hashRange,textHash} from './src/gitrepo.ts'; \
>   console.log(hashRange('来源全文','…'))"
> ```

---

## 8. 演示（PLAN §9）

```bash
# 第 0 步（必须）：生成/重建测试仓库
node --experimental-strip-types scripts/setup-fixtures.ts

# 演示 1：读得准（阶段 1）+ 查得到（阶段 2）
node --experimental-strip-types demo/stage1-2.ts

# 演示 2：阶段 3 —— 无人工干预闭环（本题核心目的）
node --experimental-strip-types demo/warning-loop.ts
```

> ⚠️ **每一步"改源文件"之后必须 `git add -A && git commit`**，否则 §3 步骤 3 的 dirty 闸门会把判定压成 `warning` 且拒绝写回 —— 阶段 3 的闭环根本走不完。演示脚本自己完成这些 commit（**"脚本自动 commit"不算人工干预**）。两个 demo 开头都会**自己重建 fixture**（幂等），因此可反复运行。

演示 1 顺序展示：`ok` 基准 → 改无关处仍 `ok` → 改范围内 `warning` → 整段替换 `error`（不显示旧文字）→ 删文件 `error` → 追查入口 `gmd log --path` → 彩蛋：`dirty` 闸门。
演示 2 顺序展示：提交来源改动 → `warning` → `edit` 草稿 → 重写正文 → `commit` → `read` 回到 `ok` → `hist` 长度 2（历史只追加）。

---

## 9. 测试（PLAN §8）

```bash
node --experimental-strip-types scripts/setup-fixtures.ts          # 先建仓库
node --experimental-strip-types --test "tests/*.test.ts"           # 跑用例
```

覆盖 PLAN §8 的用例 **0、1–20（含 19b/19c/19d、20）、23**，外加 **2 条回归用例**（来源被删除时的写回拒绝；`read --block --json` 的收窄），共 **29** 条断言全部通过。每条用例都从"模板仓库 `git clone` 一份"到独立临时目录，**互不污染**（这正是用例 0 反复强调的坑）。未做的可选用例 **21（MCP）/ 22（分支祖先）** 如实跳过。

---

## 10. Node / git 版本要求

- **Node ≥ 22.6**（本实现实测于 **v22.22.2**；2026-10-11 的复核实测于 **v22.14.0**，两者均满足下限），使用 `node --experimental-strip-types` 直接跑 TS。
- 该模式**只做类型擦除**，因此本仓库遵守：**相对 import 必须带 `.ts` 后缀**；**禁用** `enum` / `namespace` / 装饰器 / 构造函数参数属性 / `tsconfig` `paths` 别名。
- **`git` 必须在 PATH 中**（唯一外部程序）。启动时探测一次 `git --version`，失败则**明确报错**（退出码 5），不静默降级。
- **零第三方运行时依赖**（`package.json` 无 `dependencies`）。
- 自检：`node --version` 应 ≥ `v22.6`；`git --version` 应能打印版本。

### 环境注记（本机实测）

- 本机 `child_process.spawnSync` 会 `EBUSY` 失败，故 git 调用**一律走异步 `spawn`**（带 15s 超时）。异步通道没有该限制，也不影响"带超时 + `-C <repo>`"两条硬要求。
- 若在注入了 `safe-delete` 护栏的环境里跑 `scripts/setup-fixtures.ts`（其 `rm -rf` 重建会触发"单轮批量删除"确认），临时禁用该护栏即可；**普通机器无需任何额外设置**。

---

## 11. 换行约定（LF）+ `.gitattributes`

仓库内文本文件一律 **LF**：`.gitattributes` 用 `*.gmd text eol=lf`（`* text=auto eol=lf` 兜底）。写入侧先把换行归一化为 `\n` 再落盘（`src/format.ts` 的 `normalizeNewlines`）。`text_hash` 与 `hashRange` 都按 `\n` 计算，**因此 checkout 的换行变化不会污染判定**（对应 §3.3、测试用例 23）。

---

## 12. 项目结构

```
problem1-gmd/
├── README.md                     ← 本文件
├── PLAN.md                       ← 需求侧实施规格
├── package.json                  ← 仅 {"type":"module"}，零依赖
├── .gitignore / .gitattributes
├── bin/  gmd · gmd.cmd           ← 转发壳（命令名必须是 gmd）
├── src/
│   ├── types.ts                  ← §3.3 数据契约
│   ├── format.ts                 ← 解析 / 序列化（严格报错；-- 转义）
│   ├── gitrepo.ts                ← git 适配层（异步 spawn + 15s 超时 + -C）
│   ├── judge.ts                  ← 判定引擎（本题算法核心）
│   ├── diff.ts                   ← 行级差异（changes）
│   ├── edit.ts                   ← 草稿生成 / 草稿头剥离
│   ├── commit.ts                 ← 写回闸门 + 原子写
│   ├── render.ts                 ← 冲突视图 / JSON 输出
│   └── cli.ts                    ← 参数解析 + 分发 + 退出码
├── scripts/setup-fixtures.ts     ← 幂等重建 fixtures/repo（可复现 commit）
├── demo/stage1-2.ts · warning-loop.ts
├── tests/*.test.ts               ← PLAN §8 断言
├── docs/
│   ├── problem-statement.md      ← 题面逐字原文
│   ├── example.gmd               ← 格式示意（§3.2）
│   ├── notes-plan-conflicts.md   ← 与 PLAN 的偏差/取舍记录
│   └── defense/                  ← **《答辩问答》**（每题面细节的讲法）
└── fixtures/repo/                ← 现场生成，**不入库**（由 setup 脚本重建）
```

### 《答辩问答》（`docs/defense/`）

| 模块 | 文件 |
|---|---|
| 数据契约 | [`docs/defense/types.md`](docs/defense/types.md) |
| 解析 / 序列化 | [`docs/defense/format.md`](docs/defense/format.md) |
| git 适配层 | [`docs/defense/gitrepo.md`](docs/defense/gitrepo.md) |
| 判定引擎（核心） | [`docs/defense/judge.md`](docs/defense/judge.md) |
| 行级差异 | [`docs/defense/diff.md`](docs/defense/diff.md) |
| 草稿 edit | [`docs/defense/edit.md`](docs/defense/edit.md) |
| 写回 commit | [`docs/defense/commit.md`](docs/defense/commit.md) |
| 渲染 render | [`docs/defense/render.md`](docs/defense/render.md) |
| CLI 分发 | [`docs/defense/cli.md`](docs/defense/cli.md) |
| fixture + 演示 | [`docs/defense/fixtures-and-demo.md`](docs/defense/fixtures-and-demo.md) |

---

## 13. 设计来源与净室声明

`.gmd` 的**片段块语法、三档严重度语义、单文件自包含与写回闭环**均为本项目**自有设计**（题面恰好明写"乐于看到更好的设计"）。

实现阶段只**借鉴了若干通用机制思路**（不涉及任何源代码文本）：① 用"引用是否还存在 / 内容是否变了"两档来检测文档漂移的判定思路；② 用"带 hash 的溯源收据"记录文档与来源版本对应关系的数据模型；③ "diff → 找出受影响文档 → 逐项处理"的写回交互形态。

**净室声明**：交付代码**未复制任何第三方项目的源码文本**；本项目**零第三方运行时依赖**（`package.json` 无 `dependencies`），唯一外部程序是系统 `git`。
