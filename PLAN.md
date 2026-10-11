# 题 1《Git 衍生文档管理器（.gmd）》· 实施计划书

> **本文件写给执行者（DSH）看。** 执行者看不到需求方与助手之间的对话，因此本文件是**唯一的上下文来源**，所有必要信息在此自包含。
> **范围**：只覆盖熬测第 1 题（`.gmd`）。其余三题另有计划书，不在本文件范围。
> **本文件不做的事**：不写实现代码。执行者按本文件的规格产出代码。
> **配套阅读**：`docs/problem-statement.md`（题面逐字原文）。**凡本文件与原文冲突，一律以原文为准。**

---

## 0. 执行约定（先读）

1. **交付形态**：**命令行工具 + 文件格式实现**。题面明确**不要求**：调用大模型、云端/在线协作、完整 Markdown AST、覆盖所有语言的语义分析、图形界面、后台守护服务。
2. **语言/栈**：**TypeScript + Node 22**（精确下限见 §2.1，§11 已登记），**零第三方依赖**。运行方式：
   ```bash
   node --experimental-strip-types src/cli.ts <子命令> [...]
   ```
   **为什么不用 Go/Python**：其余三题同为 TS + Node，执行者不必切换工具链；且**唯一的"外部程序"是 `git` 本身**（用 `node:child_process` 调用系统 git），不需要 libgit2 / pygit2 / isomorphic-git 之类依赖。
3. **命令名是硬要求**：**必须叫 `gmd`**（题面原文）。`bin/` 下提供 `gmd`（POSIX 可执行）与 `gmd.cmd`（Windows）两个转发壳；同时保证不装 PATH 也能用 `node --experimental-strip-types src/cli.ts` 直接跑。
4. **不引入**：数据库、Docker、Markdown 渲染库、YAML/TOML 解析库、JSON Schema 库、diff 库（最小行比对自己写）。
5. **"无需初始化项目或项目级配置"**（题面原文）：**不得**要求用户先跑 `gmd init`。仓库定位靠 `--repo <path>` 或当前目录向上找 `.git`。
6. **凭据/配置**：本题不需要任何 Key、不需要联网。
7. **§3 的格式文法与 §4 的判定语义是"不可改"的部分**（题面硬要求）；CLI 的呈现细节可调（此类"可调"项一律以 §11 为准）。

---

## 1. 题目原文要点（逐条摘录，不可漏）

> 📄 **题面原文已落盘：`docs/problem-statement.md`**（161 行，来源 PDF 第 1 页 + 第 1–4 页，逐字摘录）。动手前先读它。

### 1.1 要解决的问题

README、设计说明、接口说明、运维手册常**由代码或配置衍生而来**；代码一变，文档就可能不再准确。要一种**面向 AI 的、类似 Markdown 的衍生文档格式（`.gmd`）**及配套 `gmd` 工具，让 AI 读到一段衍生内容时**立刻**得到三个答案：

1. 这段内容**还准不准**；
2. 不准时，是**照旧用 / 由自己判断 / 还是必须重写**；
3. 想追问"**为什么变了**"，**能直接看到来源的变化过程**，不必自己去翻 Git。

同时，**普通 Markdown 阅读体验不应被明显破坏**。

### 1.2 核心概念（题面定义，全部要落地）

| 概念 | 含义 |
|---|---|
| 源内容 / 衍生内容 | 被引用的代码、配置等仓库文件 / 由其总结转换而来的文档内容 |
| 文档 / 片段（block） | 一个 `.gmd` 文件 / 其中**可独立判断新旧状态**的一部分 |
| 引用 | 片段对源内容中**一段具体范围**的引用 |
| 来源版本 / 活动版本 / 历史版本 | 生成内容时对应的 Git 版本及来源信息 / 当前展示的版本 / 同一片段过去生成的版本 |

> **代码和 Git 历史是事实来源；文档不能靠修改自身说明信息宣称自己是最新的。**

### 1.3 五条硬约束（题面"一些建议"，须逐条满足）

| # | 原文要点 | 落成规格 |
|---|---|---|
| 1 | **单文件自包含**：文档标识、片段划分、版本历史、来源信息、Git 版本与时间**全部内嵌于 `.gmd`**；**不依赖旁车文件、索引、数据库或文件名**。可生成缓存，**删除后仅凭该文件即可完整判断语义** | §3 格式把上述全部塞进文件内的注释块；**不生成任何侧车文件**；缓存**可选且非必需**（本实现默认**不做缓存**） |
| 2 | **文件名不含任何版本信息**：hash、版本号、片段标识、来源路径、生成时间**只能来自文件内容** | §3；`doc_id` 与全部元数据在文件内 |
| 3 | **片段级独立**：多片段状态互不牵连；**历史只追加，不覆盖不删除** | §4.2 / §4.7 |
| 4 | **基于读取时的真实仓库状态判断**，不用陈旧缓存；**格式损坏或元数据无法解析必须报错，绝不判为可用** | §4.5（判定引擎）/ §4.1（解析严格模式） |
| 5 | **不伪造正式版本**：来源存在未提交修改时**默认拒绝写入** | §4.6.2（写回闸门） |

### 1.4 三档严重度（题面原文）

工具对每个片段**只回答一个问题**：记录的这段文字**还能不能直接用**。

| 严重度 | 什么时候出现 | AI 的动作 |
|---|---|---|
| `ok` | 被引用范围内的源内容**没变** | 直接用 |
| `warning` | **引用范围还在**，但范围内的内容变了；还算不算准，**取决于含义** | 自己判断：接受或重写 |
| `error` | **引用目标消失或已被整体重写**（文件没了、整段被替换或删除） | 必须重写 |

四条补充（原文）：

- `warning` 是**唯一需要 AI 解释**的一档。**工具不猜**："变更点 + 来源当前内容"摆出来，由 AI 判断。
- `error` **刻意隐藏旧文字**：留着它，AI 就会去补丁式修改，而引用目标已经不在了。
- 引用范围内有**未提交修改**时，判为 `warning`，且**不允许写回**。
- **判断只看被引用的范围**：同一文件其它地方的改动**不算**过期。

### 1.5 难度阶段（题面原文：阶段 1、2 构成最小可用交付，**阶段 3 是本题核心目的**，阶段 4 为加分）

| 阶段 | 要完成 | 完成标志 |
|---|---|---|
| **1 读得准** | 单文件多片段多版本格式；按引用范围记录与判断；三档严重度 | **只有被引用范围变化才报警，改无关处仍为 `ok`** |
| **2 查得到** | 片段版本历史；来源提交历史；引用目标消失或被整段重写时判为 `error` 且**不输出旧内容** | **对一个失效引用给出原因与追查入口，AI 无需自己调用 Git** |
| **3 改得回（核心）** | 冲突视图；草稿文件；提交前后的校验；读取 → 判断 → 重写 → 提交闭环且历史不丢 | **AI 无人工干预完成一次从 `warning` 到新版本写入的全过程** |
| 4 进阶（任选其一以上） | 符号/选区级引用；**未提交来源的受控写回**；分支合并与祖先判断；变更监听或 Git hook；Agent/MCP 集成；冲突辅助；大文档性能优化 | — |

### 1.6 参考命令行接口（题面原文：不要求完全一致，ai 会用就行）

| 命令 | 用途 |
|---|---|
| `gmd read <doc> [--block <id>] [--version <id>] [--json]` | 取正文与严重度；**默认冲突视图**，可切换为只出正文 |
| `gmd log <doc> [--block <id>] [--path <src>] [--range <a..b>] [--json]` | 片段版本历史 / 来源提交历史 |
| `gmd edit <doc> --block <id> [--json]` | 生成草稿文件并返回其路径 |
| `gmd commit <doc> --block <id> [--input <file\|->] [--allow-dirty] [--json]` | 提交草稿或标准输入，**追加新版本** |

> **工具命令名必须是 `gmd`**；无需初始化项目或项目级配置；通过 `--repo` 或当前目录定位 Git 仓库。

### 1.7 交付与范围（题面原文）

> 你需要交付：**可运行的 `.gmd` 格式实现**；**能读取和修改 `.gmd` 格式的 CLI 工具**。
>
> 不要求：调用特定大模型、云端或在线协作、完整 Markdown AST、覆盖所有语言的语义分析、图形界面或后台守护服务。**实现语言、存储方式、格式载体与接口风格自定。**
>
> **以上所有要求仅供参考，一切以服务 AI、辅助 AI 多快好省地完成任务为准。我们很乐于看到你能给出比题目更好的设计。**

⚠️ 这是四题里**唯一明写"乐于看到更好的设计"**的一题 —— `.gmd` 的**格式设计本身就是评分点**。

---

## 2. 已定设计决策（执行者直接采用，不要重新选型）

| 决策 | 取值 | 理由 |
|---|---|---|
| 语言 | **TypeScript**（零运行时依赖） | 与其余三题统一；类型能承载版本历史结构 |
| Git 访问 | **`node:child_process` 调用系统 `git`** | 零库依赖；`git` 本身是题面预设环境（"定位 Git 仓库"） |
| 元数据载体 | **HTML 注释 `<!-- gmd:... -->`** | 这是本题最关键的格式决策：**标准 Markdown 渲染器完全忽略 HTML 注释** ⇒ 满足"阅读体验不被明显破坏"；同时是纯文本、可 diff、可手改 |
| 元数据编码 | 注释内**单行 JSON**（多行允许，但序列化输出为紧凑单行） | 机器可解析、人可读、无需引 YAML 库 |
| 行范围表示 | **1-based 闭区间** `[l0, l1]` | 与题面 `--range <a..b>` 一致；与编辑器行号一致 |
| 引用快照 | **`src_hash`（记录时该范围文本的 sha256）+ `commit`** | 判定不需要旧原文即可发现"变了"；只在需要区分 warning/error 时才回头取旧原文 |
| 判定依据 | **工作区内容（worktree）**，不是 `HEAD` | 题面"基于读取时的真实仓库状态判断，不用陈旧缓存" |
| 历史存储 | **每个片段自带 `hist[]` 数组，只 push 不删** | "片段级独立"＋"历史只追加" |
| 判定输出 | 默认**冲突视图**（严重度 + 变更点 + 来源当前内容），`--json` 给结构化 | 题面"工具不猜，把变更点+当前内容摆出来" |
| `read` 的"只出正文"开关 | **`--plain`**（别名 `--body`）：只打印块正文，不带严重度 / 变更点；不加时为冲突视图 | 题面参考接口原文"默认冲突视图，**可切换为只出正文**"（§1.6）。**这是题面点名的能力，必须实现** |
| 缓存 | **不做** | 题面"**可**生成缓存"是可选；不做缓存 = 每次真读仓库，天然满足"不用陈旧缓存" |
| 分隔符安全 | JSON 序列化时对 `--` 转义为 `\u002d\u002d` | HTML 注释内**不允许出现 `--`**，否则注释提前闭合、格式损坏 |

### 2.1 🔴 运行环境硬约束（写错就"跑不起来"）

`node --experimental-strip-types` **只做类型擦除、不做任何语法转换**：

| 约束 | 说明 |
|---|---|
| **Node ≥ 22.6**（建议 ≥ 22.18；见 §11） | README **必须写明版本要求** + 给一条 `node --version` 自检 |
| **相对 import 必须带 `.ts` 后缀**（`import { X } from './types.ts'`） | 最常见的翻车点 |
| **禁用** `enum` / `namespace` / 装饰器 / 构造函数参数属性 | `enum` 改用 `const` 对象 + union type（§3 已按此写） |
| 禁用 `tsconfig` 的 `paths` 别名 | type stripping 不解析别名 |
| **`.env` 不适用** | 本题不需要任何环境变量 |

**另外两条本题特有的硬约束**：

| 约束 | 说明 |
|---|---|
| **`git` 必须在 PATH 中** | 启动时探测一次（`git --version`），失败则给出**明确报错**而非静默降级 |
| **子进程调用 git 必须设超时（15s，见 §11）+ 必须用 `-C <repo>` 指定仓库** | 不要依赖 `process.cwd()`，否则 `--repo` 形同虚设 |

---

## 3. `.gmd` 格式规范（**本题核心，执行者照此实现**）

> 文件：`src/types.ts`（类型）+ `src/format.ts`（解析/序列化）。

### 3.1 文法总览

```
.gmd 文件 := [BOM] [空行] doc 头块 block*
doc 头块  := "<!-- gmd:doc " <JSON> "-->"          ← 文件内第一个非空内容，必须存在
block     := "<!-- gmd:block " <JSON> "-->" 正文 "<!-- /gmd:block -->"
正文      := 任意 Markdown（可含空行、围栏代码块、HTML）；围栏代码块内的 gmd 标记字面量不算标记
其余      := 块外的普通 Markdown = 自由文本，不参与判定
```

**三个必须遵守的解析纪律**：

1. **文件内第一个非空内容必须是 `gmd:doc` 块**；否则 → **报错退出**（题面：格式损坏必须报错，绝不判为可用）。
2. **`gmd:block` / `/gmd:block` 必须成对且不嵌套**；出现未闭合、嵌套、或 JSON 解析失败 → **报错退出**，并指出**出错行号**。
3. **JSON 内不得出现裸 `--`**（序列化时转义；解析时若发现注释提前结束 → 视为格式损坏）。

### 3.2 示例文件（可直接用作 fixture）

```markdown
<!-- gmd:doc {"gmd":1,"doc_id":"d7f3a1c2-5b8e-4a91-9c3d-2f6e8b0a1c44","created_at":"2026-07-01T09:00:00Z"} -->

# KVStore 接口说明

本文档由 `src/kv.ts` 的接口定义衍生而来。

<!-- gmd:block {"id":"b1","hist":[{"rev":1,"at":"2026-07-01T09:00:00Z","path":"src/kv.ts","range":[10,24],"commit":"a1b2c3d4e5f60718293a4b5c6d7e8f9012345678","src_hash":"sha256:9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0","text_hash":"sha256:1122334455667788990011223344556677889900112233445566778899001122"}]} -->

## `get(key): Promise<Buffer | null>`

按键取值。键不存在时返回 `null`，**不抛异常**。

<!-- /gmd:block -->

<!-- gmd:block {"id":"b2","hist":[{"rev":1,"at":"2026-07-01T09:00:00Z","path":"src/kv.ts","range":[26,40],"commit":"a1b2c3d4e5f60718293a4b5c6d7e8f9012345678","src_hash":"sha256:00aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff66778899","text_hash":"sha256:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"}]} -->

## `set(key, value): Promise<void>`

写入键值。**若键已存在则直接覆盖**，不校验。

<!-- /gmd:block -->

## 备注

本节不是衍生内容，不做判定。
```

> 上例刻意展示：**块外的 "备注" 节是完全自由的普通 Markdown**。
>
> ⚠️ **执行者更正（2026-10-11）**：本示例原先 `b2` 的 `src_hash` / `text_hash` 是 **66 位** hex，与 §3.3 契约「`sha256:<64 位小写 hex>`」及 §4.1 的严格校验冲突 —— 照抄会被 `parseGmd` 判为**格式损坏（退出码 2）**。此处已按 **64 位**改正（只截掉多余的尾部两位），`docs/example.gmd` 同步修正；差异记录见 `docs/notes-plan-conflicts.md` §1.4。
> 复现：`node --experimental-strip-types src/cli.ts read docs/example.gmd` 应**不再**报「格式损坏」（两个块的正文 hash 仍对不上，那属于刻意的示意值，会正常判 `error`）。

### 3.3 TypeScript 数据契约（`src/types.ts`，直接落地）

```ts
// ---------- 版本（片段的一次生成记录）----------
export interface GmdVersion {
  rev: number;              // 单调递增，从 1 开始；= hist 下标 + 1
  at: string;               // ISO8601 UTC，生成时刻
  path: string;             // 源文件路径，相对仓库根，正斜杠；**不得含 .. / . / 空段**（本次复核新增，防越界读文件）
  range: [number, number];  // 1-based 闭区间 [l0, l1]，l0 <= l1
  commit: string;           // 记录时的仓库 HEAD commit 全 sha（= git rev-parse HEAD，§4.6.2）
  src_hash: string;         // "sha256:<hex>" —— 该 range 内文本的摘要
  text_hash: string;        // "sha256:<hex>" —— 本片段正文（换行归一化为 \n 后 trim）的摘要
  text?: string;            // 该版本的正文（阶段 4·3；本实现写出的版本一律带它，须与 text_hash 自洽）
  note?: string;            // 可选备注（序列化时须转义 "--"）
}

// ---------- 片段 ----------
export interface GmdBlock {
  id: string;               // 稳定标识，文件内唯一；^[A-Za-z0-9_-]{1,64}$
  hist: GmdVersion[];       // 只追加，长度 >= 1
  text: string;             // 活动版本的正文（hist 最后一条对应的正文）
  lineStart: number;        // 解析信息：块起始行（报错用）
}

// ---------- 文档 ----------
export interface GmdDoc {
  gmd: 1;                   // 格式版本
  doc_id: string;           // UUID v4，文件名不含它
  created_at: string;
}

export interface ParsedGmd {
  doc: GmdDoc;
  blocks: GmdBlock[];       // 按文件内出现顺序
  raw: string;              // 原文，写回时保持块外内容不变
}

// ---------- 判定（§4.5）----------
export type Severity = 'ok' | 'warning' | 'error';

export interface ChangePoint {
  line: number;             // 源文件当前行号
  before: string | null;    // 记录时该行（null = 当时不存在）
  after: string | null;     // 当前该行（null = 已删除）
}

export interface BlockJudgement {
  id: string;
  severity: Severity;
  rev: number;
  source: { path: string; range: [number, number]; commit: string };
  reason: string;           // 一句话原因（error 时不得含旧文字）
  dirty: boolean;           // 引用范围内是否有未提交修改
  writable: boolean;        // 是否允许写回：= !dirty && severity !== 'error'
  changes: ChangePoint[];   // warning 时给出变更点；error/ok 时为空数组
  currentSource: string | null; // warning/ok 时的"来源当前内容"；error 时**必须为 null**
}

// ---------- 格式错误（§4.1；§3.3 契约，CLI 须映射为退出码 2）----------
export class GmdFormatError extends Error {
  line: number;             // 出错行号（1-based），必须随错误一并给出
  constructor(message: string, line: number);
}
```

**`GmdFormatError` 属于 §3.3 契约（同一代码块内导出）**：`parseGmd` 的**任何**异常（首个非空内容不是 `gmd:doc`、块未闭合/嵌套、JSON 非法、`id` 非法或重复、`hist` 为空或 `rev` 不连续）**一律**抛它，且**必须带 `line`**；CLI 捕获后 → 打印 `错误：<message>（第 <line> 行）` → **退出码 2**（§4.9）。

> 🔒 **`text_hash` 归一化的唯一实现（与 §4.3 的 `hashRange` 同级，必须三方共用）**：正文一律**先用 §4.3 的 `normalizeEol` 归一化换行（`text.split(/\r\n|\r|\n/)` 后再以 `'\n'` 连接，即 CRLF / LF / **孤立 `\r`** 统一为 LF；与 `hashRange` **同一原语、同一口径**），再 `trim`，最后取 sha256**：
>
> ```ts
> // gitrepo.ts 导出；commit.ts（写 text_hash）、judge.ts（步骤 0 校验）必须调用同一个它
> // 归一化原语 normalizeEol 定义在 §4.3 的代码块里，textHash 与 hashRange 共用，不得各写一份
> export function textHash(text: string): string {
>   return 'sha256:' + createHash('sha256').update(normalizeEol(text).trim(), 'utf8').digest('hex');
> }
> ```
>
> 不归一化的后果：本机 `core.autocrlf=true`（§4.3），编辑器或 `git checkout` 一旦改变换行，`text_hash` 就对不上 → §4.3 **步骤 0** 会把整块判 `error("正文与元数据不一致")`，**与来源是否变化毫无关系**。写文件侧同理：一律以 `\n` 落盘（§3.4），并由仓库根的 `.gitattributes` 保证 checkout 不改换行（归一化口径与 `.gitattributes` 约定登记在 §11）。

### 3.4 序列化规则（写文件时）

| 规则 | 说明 |
|---|---|
| 块头 | `<!-- gmd:block ` + 紧凑 JSON + ` -->`，**单行** |
| 块尾 | `<!-- /gmd:block -->`，单独一行 |
| `hist` 顺序 | 按 `rev` 升序；写入时**永不重排、永不删除** |
| `--` 转义 | 对 JSON 文本调用 `json.replace(/--/g, '\\u002d\\u002d')`（**只影响 JSON 字面量，不影响正文**） |
| 块外文本 | **原样保留**（重写文件时保留块外内容；换行按下一行规则统一为 `\n`） |
| 换行 | **一律以 `\n` 落盘**（写文件时把正文与块外文本中的 `\r\n` / `\r` 归一化为 `\n`）；配合 §7 的 `.gitattributes`（`*.gmd text eol=lf`）保证 checkout 不改换行，`text_hash` / `hashRange` 才稳定 |
| 块顺序 | 保持块在文件中的原有顺序；`commit` 只改目标块的 `hist` 与正文，**其它片段按原文逐字节拷贝**（不重渲染 ⇒ 它们的键序与扩展字段都不动） |
| 前向兼容（2026-10-11 第四轮新增） | 本工具**不认识的字段一律原样保留**（`gmd:doc` / 块头 / 版本记录三层皆是），写回时合并在已知字段之后。实现上挂在 `EXTRAS`（Symbol 键）上：不可能与 JSON 字段重名，且 `JSON.stringify` 天然忽略它 ⇒ 只有 `renderBlockHead` 那一次显式合并能把它写回文件。**为什么不能"不认识就丢"**：格式带 `gmd:1` 版本号，将来必有新字段，"老工具改新文件"若静默丢字段，比报错更糟（题面要求损坏必须报错，但扩展字段不是损坏）。`serializeGmd(raw, blocks, rewriteIds?)` 的第三参数即"只重写这些片段" |

---

## 4. 模块与接口规格（**语义 + 边界，不可改**）

> 文件划分见 §7。以下函数签名只是建议（属契约自由度，不入 §11 账本），语义必须一致。

### 4.1 `parseGmd(raw: string): ParsedGmd` —— 严格解析

- 跳过 BOM 与前导空行/空白。
- 第一个非空内容必须是 `gmd:doc` 块；否则 → 抛 `GmdFormatError`（带行号）。
- 逐个扫描 `gmd:block` / `/gmd:block` 对。**未闭合、嵌套、JSON 非法、`id` 非法或重复、`hist` 为空或 `rev` 非连续 → 抛错**。
- 块正文 = 两个标记之间的全部内容，**按照"去掉首尾各一个换行"归一化后**作为 `text`。
- 块外内容原样保留到 `raw`（用于 §4.6 写回）。
- ⚠️ **绝不宽容**：任何异常都必须**报错退出**，不得跳过一个坏块继续（题面硬约束 4）。

> **来源文件的读取约定（P1/P2 补）**：`judgeBlock` / `commit` 读取来源一律按 **UTF-8** 解码；遇到**非 UTF-8**（`Buffer` → `TextDecoder('utf-8', {fatal:true})` 抛错）或**二进制**（含 NUL 字节）→ **明确报错**（单块记 `error("来源不是 UTF-8 文本: <path>")`，§4.4；CLI 不静默降级、不用替换字符）——题面：格式损坏或元数据无法解析**必须报错，绝不判为可用**（该来源编码口径登记在 §11）。

### 4.2 `blockView(block, version?): string` —— 取正文

- 默认取**活动版本**（`hist` 最后一条）对应的 `text`。
- 指定 `--version <rev>` 时，取该版本：**给出该版本当时写下的正文（`hist[].text`）+ 来源信息**；若给了 `--plain` 则**只出该版正文**。各块的 `active_severity` 是**活动版本**的严重度（历史版本本身不谈严重度，字段名已把它标注清楚）。旧格式文件缺 `text` 时：`--json` 给 `text: null`、人类可读视图与 `--plain` 在 stderr 说明"该版本未存正文"，**不因此改退出码**（见 §4.7）。

### 4.3 `judgeBlock(block, repo): BlockJudgement` —— 三档判定（**本题算法核心**）

对活动版本 `v = hist[hist.length-1]` 执行：

```
0) 正文与元数据一致性检查（P1-3）
   if textHash(block.text) !== v.text_hash:      ← §3.3 的唯一实现（换行归一化为 \n 后 trim）
       → error("正文与元数据不一致")
         reason = "正文与元数据不一致"      ← 只说明"不一致"，不得输出旧文字
         changes = []，currentSource = null
         返回（不再往下判）
   （依据题面"文档不能靠修改自身说明信息宣称自己是最新的"：
     手改正文却不追加版本 ⇒ 自证最新 ⇒ 直接判 error，而不是勉强给出 ok/warning）

1) 文件存在性
   worktree 中 repo/v.path 不存在
       → error("引用文件不存在: <path>")，currentSource = null
   （注意：文件被重命名也算"不存在"—— 本题不做 rename 跟踪，正确且诚实）

2) 取当前文件文本 / 行
   nowText  = readFile(repo/v.path)          ← UTF-8 原文（§4.1）
   nowLines = nowText.split(/\r?\n/)         ← **只用于行数、步骤 5/6 与展示**
   （若 v.range[1] > 当前文件行数 → **在步骤 3.5 直接判 error**，不再往下做内容锚定）
   ⚠️ **dirty 判定不得使用 `nowLines`**（见步骤 3）：行数组已完成一次切分，
      拿它去和 `git show` 的结果直接比，会把 CRLF/LF 差异误判成"内容变了"。

3) 未提交修改检查（题面硬约束 5 / 三档补充第 3 条）—— 粒度**仅限 `v.range` 内**
   headText = git show HEAD:<path>          ← **stdout 原文；禁止在此处另做一次切分 / 归一化**
   ⚠️ **`git show HEAD:<path>` 失败时不能一律当成"引用目标不存在"**（本次复核修；
      必须把"仓库没有 HEAD"与"该路径不在 HEAD 里"分开）：
       失败 **且工作区存在** `v.path`（源文件是新增/未跟踪）→ 视为**未提交**，
         按下面的 dirty 分支处理：dirty = true、severity = warning、writable = false、
         返回（不再往下判）；
      失败 **且工作区也不存在** → error("引用文件不存在: <path>")
          （步骤 1 已先判过工作区存在性，本分支只是 TOCTOU 兜底：两次调用之间文件被删掉了。
            两者都不得输出旧文字）
   🔒 **dirty 的判定口径写死（唯一实现，不得另造一份比较逻辑）**：
       isRangeDirty(path, range) := hashRange(nowText, range) !== hashRange(headText, range)
     `nowText` = 工作区文件全文（步骤 2 读到的 UTF-8 原文）、`headText` = `git show HEAD:<path>` 的 stdout 原文；
     **两边都必须先经同一个 `hashRange`（§4.3 的唯一实现，内部 `normalizeEol`：`split(/\r\n|\r|\n/)` 后再以
     `'\n'` 连接）归一化后再比**。**禁止**直接比较原文、行数组（`nowLines` / `headLines`），或用第二套切分口径。
     ⇒ **换行差异不构成 dirty**：本机 `core.autocrlf=true` 时工作区是 CRLF、`git show HEAD:` 给的是 LF，
       只要引用范围内**语义相同**就必须判 equal（否则所有块永久 dirty ⇒ 全块 `warning` + `writable = false`）。
  if isRangeDirty(v.path, v.range):
      → dirty = true，severity = warning
        reason = "引用范围内存在未提交修改"
        writable = false                        ← 题面：不允许写回
        记 changes = 该范围内的行级差异
        currentSource = nowLines 在 range 内的内容
        返回（不再往下判）

3.5) 引用范围是否仍然存在（**在 dirty 分支之后、内容比对之前**；本次复核新增）
   countLines(nowText) < v.range[1]
       → error("引用范围已不存在（来源现有 N 行，引用 a-b）")，currentSource = null，changes = []
         writable = false；dirty 仍如实计算并附上（越界 != 未提交，两个信号正交）
   🔑 **为什么必须单独判**：`hashRange` 用 `slice(l0-1, l1)` 实现，范围越界时**静默截断**；
      范围全在文件外时切片为空 ⇒ 返回**空串的 sha256**。于是"引用目标已消失"与"范围内是空内容"
      在 hash 层面无法区分 ⇒ 若写回侧沿用越界 range（见 §4.6.2 校验 5），下一次 read 就是
      "空串哈希 === 空串哈希" ⇒ **伪造成 ok**，违反题面"引用目标消失 ⇒ error""绝不判为可用"。

4) 内容比对（range 内）
   nowHash = hashRange(当前文件文本, v.range)      ← 唯一实现，见下
   if nowHash === v.src_hash → ok
       reason = "引用范围内内容未变化"
       currentSource = 该范围当前内容

5) 内容锚定（处理"行号漂移"）
   在窗口 [max(1, l0-50), min(len, l1+50)] 内滑窗寻找长度 = (l1-l0+1) 的子串，   ← 窗口大小 ±50，见 §11
   使 hashRange(子串候选, 相对 range) === v.src_hash
   if 找到 → warning("引用内容仍在文件中，但已不在原行号范围")
             changes = []，currentSource = 该子串

6) 相似度判定（区分"范围内内容变了" vs "整段被替换/删除"）—— **按范围长度分段**
   oldText = git show v.commit:<path> 的 range 行     ← 仅用于内部计算
     （取不到，如 commit 已被 GC → error("无法回溯来源版本")）
   n = v.range[1] - v.range[0] + 1
   A = oldText 的非空行（trim 后）；B = nowLines[v.range] 的非空行（trim 后）

   6a) n >= 3：**行集合 Jaccard，阈值 0.20（保持原规则不变）**
       sim = |A ∩ B| / |A ∪ B|（A、B 均为空 → sim = 0）
       if sim < 0.20 → error("引用目标已被整体重写或删除")

   6b) n <= 2：**改用字符级相似度（字符集合 Jaccard），阈值 0.30**
       为什么必须换：范围只有 1 行时（配置项引用常是 range:[12,12]），
       改写这一行 ⇒ 行集合交集为空 ⇒ sim = 0 ⇒ 误判 error；
       而题面把"引用范围还在、内容变了"明确定义为 **warning**（原 0.20 在短引用上不可达）。
       公式：A' = A 各行首尾相接后的**去重字符集合**；B' = B 同法；
             sim = |A' ∩ B'| / |A' ∪ B'|（A'、B' 均为空 → sim = 0）
       判定：sim < 0.30 → error("引用目标已被整体重写或删除")
             sim >= 0.30 → warning("引用范围内内容已变化")
       边界保证：① 该行内容被改写（`PORT = 8080` → `PORT = 9090`，sim ≈ 0.78）→ warning；
                 ② 该行被删除/清空（B 为空 ⇒ sim = 0）→ error；
                 ③ 整行替换成完全无关内容（字符集几乎不相交）→ error。

   if 判为 error → error("引用目标已被整体重写或删除")
                   ⚠️ reason/changes/currentSource 中**不得出现 oldText 的任何片段**
   else          → warning("引用范围内内容已变化")
                   changes = 行级差异（oldText vs nowLines[range]）
                   currentSource = nowLines[range] 的内容
```

> 🔒 **`src_hash` 归一化的唯一实现（P1-6，必须三方共用）**：`range` 内文本一律**先按行拆分、再以 `\n` 连接**后取 sha256，**不得**直接对文件切片哈希（本机 `core.autocrlf=true`，CRLF/LF 两处各写一份就会全块告警）。固化函数：
>
> ```ts
> // gitrepo.ts 导出；scripts/setup-fixtures.ts（生成 src_hash）与 judge.ts（比对）必须调用同一个它
> // 🔒 换行归一化的**唯一原语**：§3.3 的 textHash 与下面的 hashRange 共用它，禁止各写一份或换第二套切分口径
> export function normalizeEol(text: string): string {
>   return text.split(/\r\n|\r|\n/).join('\n');  // CRLF / LF / 孤立 CR → LF（口径见 §11；刻意覆盖孤立 \r，与写盘侧 §3.4 一致）
> }
> export function hashRange(text: string, [l0, l1]: [number, number]): string {
>   const lines = normalizeEol(text).split('\n').slice(l0 - 1, l1);
>   return 'sha256:' + createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
> }
> ```
>
> 即 `hashRange(text,[l0,l1]) = sha256(normalizeEol(text).split('\n').slice(l0-1,l1).join('\n'))`（与旧式 `sha256(text.split(/\r?\n/).slice(l0-1,l1).join('\n'))` **对只有 LF / CRLF 的文件逐字节等价**；本式额外把**孤立 `\r`** 也当换行 —— 这是**有意**的，为的是与写盘侧 §3.4 的口径完全一致，避免"按含 `\r` 的内容算 hash、却按不含 `\r` 的内容落盘"导致刚提交完就自证不一致），hex 小写、前缀 `sha256:`。**`normalizeEol` 同时是 §3.3 `textHash` 的归一化原语 ⇒ 两份"唯一实现"口径必然一致**；步骤 3 的 `isRangeDirty` 也**只**通过 `hashRange` 在两边各做一次归一化后比较，故**换行差异不构成 dirty**。

**必须遵守的三条**：

- **判定只读写 `v.range` 范围**。同一文件其它地方的改动**不得**影响结果（题面硬约束）。**唯一例外**是步骤 3 的 dirty 检查 —— 也只比较 `v.range` 内。dirty 的粒度函数因此是 **`isRangeDirty(path, range)`**（不是整文件级 `isDirty(path)`；见 §5、§11）。它的实现口径**写死为**：`isRangeDirty(path, range) := hashRange(当前文件文本, range) !== hashRange(git show HEAD:<path> 的文本, range)` —— 两边共用本节 `hashRange`（`normalizeEol` 内部 `split(/\r\n|\r|\n/)` 后再以 `'\n'` 连接）归一化后再比；**禁止**直接比较原文、行数组或用第二套切分口径，否则 CRLF 工作区 vs LF HEAD 会被误判成"内容变了"。**换行差异不构成 dirty**（§3.3 / §11 / §8 用例 23）。
- **`error` 时 `currentSource` 必须为 `null`**，`changes` 必须为空（题面："刻意隐藏旧文字"）。步骤 0 的 error 同样适用。
- **相似度阈值是分段的设计决策**：范围 **≥3 行取 0.20**（行集合 Jaccard）、**≤2 行取 0.30**（字符集合 Jaccard，步骤 6b），写进 README；允许执行者改成别的值，但**必须可复现**（同一输入必得同一输出）—— 阈值登记与"可调但须可复现"的口径见 §11。

> 🔑 **为什么用相似度而不是"看 git diff 有没有删除行"**：diff 需要把"旧文本"和"新文本"对齐，而 `range` 是绝对行号，文件中间插一行就会让整个 diff 错位、误判为"整段替换"。**行集合相似度对行号漂移天然免疫**，且实现简单、结果确定。**短引用（≤2 行）下行集合必然退化，故改按字符集合比 —— 见步骤 6b**。这是本题值得写进 README 的设计取舍。

### 4.4 `judgeDoc(doc, repo): BlockJudgement[]`

- 逐块判定，**块之间不共享状态**（题面"片段级独立"）。
- 单块判定抛错（如来源文件是二进制）**不影响其它块** —— 记为该块 `error`，继续。

### 4.5 `recordChanges(oldText, newText): ChangePoint[]` —— 行级差异

- 简化实现：按行号逐行对比，标出不同的行（`before` / `after`）。
- **不要求**做 LCS 最优编辑脚本；但要求输出**稳定、可复现**。
- 输出上限 20 条，超出截断并注明 `... 其余 N 处变更略`（见 §11）。

### 4.6 写回：`gmd edit` 与 `gmd commit`

#### 4.6.1 `gmd edit <doc> --block <id>` —— 生成草稿

- 先跑 `judgeBlock`；**`severity === 'error'` 也可 edit**（题面：error 时必须重写）。
- 草稿内容 = **`<!-- gmd:draft ... -->` 头 + 当前正文**：
  ```markdown
  <!-- gmd:draft {"doc":"docs/api.gmd","block":"b1","base_rev":2,"at":"2026-10-11T05:00:00Z"} -->
  （在此行之下重写正文；保留本行行首的标记不变）
  ## `get(key)`
  ...
  ```
- 草稿路径：`<repo>/.gmd/tmp/<doc相对路径转义>-<block>.draft.md`，其中**转义规则唯一且不得碰撞**（P2-2）：
  ```ts
  const escaped = docRelPath.replace(/[\\/]/g, '_')            // 分隔符 → '_'
                 + '-' + sha256(absolutePath(doc)).slice(0, 8); // 路径摘要后缀，防同名覆盖
  // 完整：`${escaped}-${block}.draft.md`
  ```
  （`docs/api.gmd` → `docs_api.gmd-3f1a9c20-b1.draft.md`。**该规则写进 README**；`edit` 写草稿前若目标已存在 → 直接**覆盖**并打印 `覆盖已有草稿: <path>`，不静默追加编号。）
  **这是唯一允许的临时产物，且可随时删除**；它**不是**侧车元数据 —— 判定从不读它。
- 草稿头 `<!-- gmd:draft ... -->` 的字段**固定为** `doc` / `block` / `base_rev` / `at` 四个；`commit` 侧**不得**把该头当作正文（`commit` 时必须先剥离，见 §4.6.2 步骤 0），**写入 `.gmd` 的正文里永远不含草稿头**。
- 输出：草稿的**绝对路径**（`--json` 时给 `{"draft_path": "..."}`）。
- ⚠️ 同时把**冲突视图**打印到 stderr，让 AI 在同一屏看到"为什么让你改"。

#### 4.6.2 `gmd commit <doc> --block <id> [--input <file|->] [--allow-dirty]` —— 追加版本

提交前**必须**依次通过以下步骤；任一校验不过则**拒绝写回**并给出原因（退出码 4）：

**步骤 0（先做，P0）：剥离并校验草稿头 —— 定义"新正文"**（登记在 §11）

1. 取输入全文（`--input <file>` 的文件内容 / `--input -` 或 stdin / 缺省时读 `edit` 生成的草稿）。
2. **若输入的首行以 `<!-- gmd:draft ` 开头** → **丢弃该行**，并解析该行的 JSON；解析失败 → 拒绝："草稿头不是合法 JSON"（码 4）。
3. 草稿头中的 **`base_rev` / `block` / `doc` 三者只要与实参或当前状态不符**（`doc` ≠ 本次 `<doc>`、`block` ≠ 本次 `--block`、`base_rev` ≠ 当前活动版本 `rev`）→ **拒绝（码 4）**："草稿头与当前文档/片段/版本不符（doc/block/base_rev 校验失败）"。（**防止把 b2 的草稿误提交到 b1**。）
4. **`新正文 = 输入去掉草稿头之后的内容`**（首行之后的部分；再做首尾空行归一化，与 §4.1 正文归一化一致）。**写入 `.gmd` 的正文一律不含草稿头。**
5. 输入没有 `<!-- gmd:draft ` 首行（例如 `--input -` 直接给纯正文）→ 跳过 2/3/4，**新正文 = 输入原样**。

> 🔴 这条是必需的：若草稿头不剥离，① 头会进入 `.gmd` 正文、污染格式；② `text_hash` 永远对不上，校验 4（"内容未变化"）与用例 18 **永远不可达**。后续所有 hash / 比较 / 写回**一律针对"新正文"**。

| # | 校验 | 不过时 |
|---|---|---|
| 1 | 输入不为空（trim 后非空） | 拒绝："草稿正文为空" |
| 2 | `--block` 存在；草稿头的 `base_rev`（若来自 `edit`）等于当前活动版本 `rev` | 拒绝："草稿基于旧版本 rev=N，当前为 M"（**防止覆盖别人的改动**） |
| 3 | **来源未提交修改闸门**：`judgeBlock(...).dirty === true`（**即 `isRangeDirty(path, range)` 为真**）且**未传 `--allow-dirty`** | 拒绝："来源存在未提交修改，默认拒绝写入"（题面硬约束 5） |
| 4 | 提交后的 `text_hash`（`textHash(新正文)`，§3.3 的唯一实现：换行归一化为 `\n` 后 `trim`）与当前活动版本的 `text_hash` 相同 | 拒绝："内容未变化"（避免造无效版本） |
| 5 | **引用范围仍然存在**：`countLines(来源当前文本) < active.range[1]`（本次复核新增） | 拒绝："引用范围 a-b 已不存在（来源现有 N 行）"（码 4）。**为什么要有**：越界 range 会让 `hashRange` 静默截断成空串哈希，照写就会产出"引用目标已消失却自证一致"的版本 ⇒ 下一次 read 判 `ok`。与 §4.3 步骤 3.5 是同一件事的两道闸 |

**校验所用的"来源"是 `targetPath` / `targetRange`**：缺省等于活动版本的 `(path, range)`，可用 `commit --path <src>` / `--range <a..b>` **重新绑定**（阶段 4·2，本轮新增）。执行顺序为 **①②⑤③④**（⑤ 与 ③ 共用同一次 `readSourceForCommit` 读取：⑤ 看行数、③ 看范围 hash）。校验 3 **不得**再取 `judgeBlock(...).dirty`：该函数在"正文与元数据不一致"等步骤 0 场景会提前返回 `dirty = false`，等于给"先手改正文、再 commit"留了绕过脏来源闸门的口子（§8 用例 30）；改用它判定的同一组原语 `showText(HEAD, targetPath)` + `isRangeDirtyTexts` 直接算。重新绑定只影响**本版本**：`hist` 里旧版本各自的 `path`/`range` 一律不改写（历史只追加）。

通过后：

1. 重新读取来源：`commit = git rev-parse HEAD`，`src_hash = hashRange(当前文件文本, range)`（§4.3 的唯一实现，**不得**另写一份），`range` **沿用它记录的旧范围**（阶段 1–3 不做符号级引用 —— 那是阶段 4）；
2. `hist.push({ rev: last.rev + 1, at: now(), path, range, commit, src_hash, text_hash, text })`（`text_hash = textHash(新正文)`，§3.3；`text = normalizeNewlines(新正文)` —— 阶段 4·3 起**历史正文随版本落盘**，见 §4.7）；
3. 用**新正文**（**已剥离草稿头**）就地替换该块正文，其余内容**逐字节保留**（换行按 §3.4 统一为 `\n`；仓库 LF 时等价）。实现上 `serializeGmd(raw, blocks, [目标块 id])`：**只重写目标片段**，其它片段与文档头按原文拷贝，扩展字段原样保留（§3.4 前向兼容）；
4. 原子写：写 `.tmp` → `rename`（避免中途崩溃造成半截文件）；
5. 输出新版本号（`--json` 给结构）。

> 🔴 **`--allow-dirty`（阶段 4 选做）**：题面把"未提交来源的受控写回"列为阶段 4 进阶项之一。若实现，`--allow-dirty` 必须在**审计输出**里显著标注"此版本基于未提交来源"，并在新版本的 `note` 里写入 `based_on_dirty`。**不做也不算缺 —— 但命令要接受这个 flag 并给出明确提示。**（语义登记在 §11）

### 4.7 历史正文：**随版本落盘**（阶段 4·3，2026-10-11 第三轮改定）

> **每个版本的正文内嵌在 `hist[i].text`。**

原稿（本 PLAN 早先版本）选择"只保存活动版本正文"，理由是"每改一次就在文件里存一份 ⇒ 线性膨胀"。第三轮复核后**改定**，因为那个取舍把题面要的东西弄丢了：

- 题面 §2.3 要求"文档标识、片段划分、**版本历史**、来源信息、Git 版本与时间**全部内嵌于 .gmd**"；§2.2 把"历史版本"定义为"**同一片段过去生成的版本**"。只留一个 `text_hash` ⇒ **正文其实没留**。
- 题面参考接口把 `--version <id>` 列在 `read` 下、用途是"**取正文**与严重度"。只存 hash 时这条命令答不出"那一版到底写了什么"，正是题面开场 "想追问'为什么变了'" 的一半。
- 额外收益：`text_hash` 从**不可验证的承诺**变成**可验证的摘要** —— 解析时校验 `textHash(text) === text_hash`（§4.1），手改历史正文会立刻暴露为格式损坏。

代价**如实写进 README**：每追加一版多存一份正文，文件随版本数线性膨胀。这是"单文件自包含、不依赖旁车文件/索引/数据库"（题面 §2.3）的必要开销；想优化就得做增量压缩或从来源重建，本实现选择先保证语义完整。

字段形状：**`hist[i].text`（可选）**，而不是原稿预留的平行数组 `hist_text[]` —— 理由：`text` 与它自己的 `text_hash` 放在同一条版本记录里才**可校验**，平行数组一旦长度对不上就会静默错位（本轮把这条"替代方案"登记在 §11）。

- 本实现**写出的版本一律带 `text`**；旧格式 / 手写骨架可以没有，此时那一版只取不到正文（`read --version --json` 给 `text: null`，人类可读视图与 `--plain` 在 stderr 说明，**不改退出码**）。
- `read --version <rev>` 输出该版**正文 + 来源信息**；各块的 `active_severity` 是**活动版本**的严重度（历史版本不谈严重度）；`--plain --version <rev>` 只出该版正文。

### 4.8 `gmd log` 的输出

| 参数 | 输出 |
|---|---|
| `--block <id>` | 该片段的 `hist`：每行 `rev / at / path:l0-l1 / commit(短) / src_hash(短)` |
| `--path <src>` | **来源的提交历史**：`git log --oneline -- <path>`（**这就是题面阶段 2 要的"追查入口，AI 无需自己调用 Git"**） |
| `--range <a..b>` | 与 `--path` 配合：过滤出**触及该范围**的提交（`git log -L a,b:<path> --oneline` 的简化解析；若 `-L` 不可靠则退化为列出该文件全部提交并标注） |
| 无额外参数 | 文档级汇总：每块的 `id / rev / severity / 来源` |

> ⚠️ **`--range` 的边界与降级（P2-1）**：`git log -L a,b:<path>` 在 **`b > 当前文件行数`** 时会 **`fatal` 退出（码 128）**，不是空输出。因此调用前**必须先比 `range[1] ≤ 当前行数`**：
> 1. `a > b` 或 `a < 1` → 直接报**参数错（码 1）**；
> 2. `b > 当前行数` → **不调用 `-L`**，降级为"列出该文件全部提交并标注范围越界（`range 超出当前文件行数`）"（与上表"若 `-L` 不可靠则退化"一致）；
> 3. 只要 `git` 子进程**非零退出**（含 128、超时、`-L` 在重命名/合并历史上的报错）→ **一律映射为退出码 5**，打印 stderr 首行作为原因，**不得**把它当成"没有提交"或静默吞掉。
> （同样规则适用于 §4.3 步骤 6 的 `git show v.commit:<path>`：取不到 → 该块 `error("无法回溯来源版本")`。）

> 阶段 2 完成标志是"**对一个失效引用给出原因与追查入口**" ⇒ `gmd read` 报 `error` 时必须**同时打印**该块的 `--path` 来源与 `gmd log --path <src>` 的**建议命令**，让 AI 一条命令就能往下追。

### 4.9 CLI 分发与退出码（退出码 0–5 的登记见 §11）

| 退出码 | 含义 |
|---|---|
| 0 | 成功；且若为 `read`，**所有块均非 error** |
| 1 | 参数错误 / 用法错误 |
| 2 | **格式损坏**（解析失败） |
| 3 | **存在 `error` 块**（`read` 专用 —— 让 AI/脚本能直接分支处理） |
| 4 | 写回被拒（§4.6.2 步骤 0 + 五道校验） |
| 5 | 环境错误（`git` 不存在、`--repo` 不是仓库；**含 git 子进程非零退出或超时**，§4.8；见 §11） |

- `--repo <path>` 是**全局选项**，可出现在子命令前或后。
- 未给 `--repo` → 从 `cwd` 向上找含 `.git` 的目录；找不到 → 退出码 5。
- `--json` 输出**单行合法 JSON**（便于 `jq` / AI 解析）；默认输出人类可读的**冲突视图**。
- `--plain`（别名 `--body`，**`read` 专用**）：**只出正文**，不打印严重度 / 变更点 / 建议命令。给 `--block` 时输出该块正文；不给 `--block` 时按块顺序依次输出，块间以空行分隔。**与 `--json` 互斥**（同时给 → 参数错，退出码 1）。退出码仍按 §4.9 表（存在 error 块时 `read` 仍返回 3）。

**`--json` 输出契约（P1-2，写进 README 与 `types.ts`；必须逐字段稳定，`JSON.parse` 必成功；四种结构的登记见 §11）**：

| 命令 | JSON 形状 |
|---|---|
| `read --json` | `{"doc": GmdDoc, "blocks": BlockJudgement[]}` —— `blocks` 顺序 = 文件内块顺序；每个元素即 §3.3 的 `BlockJudgement`（`source` / `reason` / `dirty` / `writable` / `changes` / `currentSource` 全部保留） |
| `log --json` | **数组**：`--block` → `[{rev, at, path, range, commit, src_hash, text_hash}]`（⚠️ **刻意不含 `text`**：`log` 是"查账"，把每版正文都塞进来会让输出随历史线性膨胀；要取某版正文用 `read --version <rev> --json`，见 §4.7）；`--path`（+`--range`）→ `[{sha, short, at, subject}]`；无参数 → `[{id, rev, severity, path, range}]` |
| `commit --json` | `{"block": string, "rev": number, "text_hash": string, "range": [number, number]}` |
| `edit --json` | `{"draft_path": string}`（绝对路径） |

- 失败时也输出 JSON：`{"error": string, "code": number}`（与退出码同号），**不混入人类可读文字**（人类可读内容走 stderr）。
- 未列入上表的命令**不承诺**真有 `--json`；若实现，形状必须写进 README（见 §11）。

---

## 5. 分阶段实施计划与验收（**按题面的阶段划分，不要自创**）

### 阶段 1 —— 读得准（最小可用的一半）

- `types.ts` + `format.ts`（解析/序列化，含严格报错；`GmdFormatError` 见 §3.3）
- `gitrepo.ts`：`showFile(commit, path)` / `headOf(path)` / `isRangeDirty(path, range)`（口径见 §4.3 步骤 3：`hashRange` 两边比） / `revParseHead()` / `fileExists(path)` / `normalizeEol(text)`（§4.3 的唯一换行归一化原语）/ `hashRange(text, range)`（§4.3 的唯一哈希实现）/ `textHash(text)`（§3.3 的唯一正文摘要实现，复用 `normalizeEol`），全部带 15s 超时（见 §11）
- `judge.ts` 的**步骤 0/1/3/4**（正文一致性（`textHash`，含换行归一化）、存在性、dirty（含"路径不在 HEAD 里"的分支，§4.3 步骤 3）、hash 比对）
- CLI：`read`（默认冲突视图 + **`--plain` 只出正文** + `--json`）、`--repo`
- **验收**：§8 用例 0、1–4、6、**19d**（`--plain` 只出正文）、**23**（23 = 换行不构成 dirty，验 `isRangeDirty` 的唯一口径）
  > ⚠️ **本阶段只实现步骤 0/1/3/4**：hash 不同而步骤 5/6 尚未实现时，**一律先降级为 `warning`**（真正区分 warning / error 要等阶段 2 的步骤 6）。⇒ **用例 5（整段替换 → `error`）归阶段 2**，不在阶段 1 验收内（原稿把它列在阶段 1 属笔误，已改）。

### 阶段 2 —— 查得到

- `judge.ts` 的**步骤 5/6**（内容锚定 + 分段相似度 ⇒ 真正区分 warning / error）：**≥3 行用行集合 Jaccard（0.20）、≤2 行用字符集合 Jaccard（0.30）**，见 §4.3 步骤 6a/6b 与 §11
- `error` 时**抹掉旧文字**（`currentSource=null`、`changes=[]`）
- CLI：`log`（四种参数组合）
- `read` 报 error 时**同时给出追查入口**（§4.8）
- **验收**：§8 用例 7–11、19c（**单行范围的短引用必须判 warning 而非 error**，即 6b 生效）

### 阶段 3 —— 改得回（**本题核心目的**）

- CLI：`edit`（草稿文件 + 冲突视图到 stderr）、`commit`（**步骤 0 草稿头剥离 + 五道校验** + 原子写 + 追加 hist）
- 冲突视图渲染（`render.ts`）：严重度 / 变更点 / 来源当前内容 / 下一命令建议
- **新建通路（P2-4）**：本版**不新增 `gmd new` 子命令**（题面参考接口只有 `read`/`log`/`edit`/`commit`）。从零建文档的通路是**按 §3.1 手写**：先写 `<!-- gmd:doc {...} -->` 头，再写 `<!-- gmd:block {...} -->` 正文 `<!-- /gmd:block -->`（`hist[0]` 用 `hashRange` 实测值）；**新建片段同理**（在已有文档里插入一个块头 → 首次 `commit` 追加 `rev=1`）。**README 的"快速开始"必须给出这段可复制的最小骨架**，并在 §10"已实现/未实现"里声明"未提供 `gmd new`"。
- **闭环演示**：`demo/warning-loop.ts` 一键跑通"**读 → 判断 → 重写 → 提交**"，且**全程无人工干预**
- **验收**：§8 用例 12–16、19

### 阶段 4 —— 进阶（任选，按剩余时间；建议优先级从高到低）

1. **`--allow-dirty` 受控写回**（题面显式列出的命令参数，做起来最省力，且能补全 `commit` 的签名）
2. **Agent/MCP 集成**：把 `gmd read` / `commit` 暴露成 MCP 工具（stdio JSON-RPC，**零依赖手写**，与题 3 的做法一致），让 AI 直接调用
3. **分支/祖先判断**：`v.commit` 是否为 `HEAD` 的祖先（`git merge-base --is-ancestor`），非祖先时降级为 warning 并提示"来源来自其它分支"

- **验收（P2-7，可选；做哪条就启用 §8 哪条预留用例）**：
  - 做 1 → **启用 §8 预留用例 20**（`--allow-dirty`）；
  - 做 2 → **启用 §8 预留用例 21**（MCP）；
  - 做 3 → **启用 §8 预留用例 22**（非祖先 commit）。
  - ⚠️ 这三条在 §8 表里**已按编号 20/21/22 预留**（均标注"可选"）；做了才算通过，未做则整条跳过（登记口径见 §11）。
  - ⚠️ **编号已到 22，故新增用例从 `23` 起编**；**§8 用例 23（换行不构成 dirty）不属于阶段 4 选做** —— 它是阶段 1 `isRangeDirty` 判定口径的回归用例（已在阶段 1 验收里启用），不要拿它顶替 20/21/22。
  - **未做则整条跳过，并在 README"未实现"里如实声明**（不做不算缺）。

---

## 6. 参考项目映射（**只借设计，不搬代码**）

> ⚠️ 参考清单里的结论**依据各项目 README 的转述，不是逐行读源码**，属相关性判断而非质量背书；许可结论以各仓库当前 `LICENSE` 为准。这些标识符**不得出现在交付代码里**。

> 完整清单见 `D:\aoce\参考资料-GitHub开源项目-4题.md` 的"题 1"节。**GitHub 上没有完整同构项目** —— `.gmd` 的"片段声明引用行范围 + 三档严重度"是本题自有的设计，正是可以出彩的地方。以下是**机制近邻**，只借思路。

| 项目 | 许可 | 可借什么 / 不要借什么 |
|---|---|---|
| **`radiac/sphinx-gitref`** | 许可以仓库当前 LICENSE 为准（参考清单标为 **NOASSERTION**，`D:\aoce\参考资料-GitHub开源项目-4题.md:25`） | **判定思路**："Check code referenced in documentation still exists"（≈ `error` 档）+"Check code hashes and alert when something has changed"（≈ `warning` 档）。它**只检测、不写回** ⇒ 阶段 3 是我们要自己补的。⚠️ **不可当作 MIT 直接复用**（NOASSERTION ⇒ 按"保留所有权利"处理，只读设计） |
| **`HarperZ9/provenance-sensorium`** | MIT | **来源收据数据模型**：文件 + git 状态 + markdown 声明 → hash 收据。可借它"收据"里放哪些字段；**它没有片段与三档概念** |
| **`redhat-community-ai-tools/code-to-docs`** | MIT | **阶段 3 的交互形态**：diff → 找受影响文档 → 逐项 accept/reject。我们的 `edit`/`commit` 是它的 CLI 化版本 |
| **`nantobv/pituitary`** | MIT | **漂移分类口径**（stale / contradict / drift）—— 写 README 时的术语组织可参考 |
| **`CorvidLabs/spec-sync`** | MIT | CLI 命令组织 + "vanished symbols" 的报错措辞 |

🔴 **纪律**：**不复制任何代码**。理由是双重的 —— ① 法律（无 LICENSE = 保留所有权利；MIT 也须留声明）；② **答辩自保**：抄来的结构你讲不清，评审会深挖。
🔴 **提交前自检**：全局搜索 `sphinx-gitref` / `provenance-sensorium` / `code-to-docs` 等标识符，**交付物中应零命中**。

---

## 7. 目录结构

```
D:\aoce\problem1-gmd\
├── README.md                 ← 交付物（§10）
├── PLAN.md                   ← 本文件
├── docs\
│   ├── problem-statement.md  ← 题面逐字原文（已就位）
│   └── defense\              ← **每个模块的《答辩问答》**（硬要求，见 §10）
├── .gitignore                ← **整目录排除 `fixtures/repo/` 与 `.gmd/tmp/`**（见下方"幂等"说明）
├── .gitattributes            ← `*.gmd text eol=lf` —— 保证 checkout 不改换行，`text_hash` / `hashRange` 才稳定（§3.3 / §3.4）
├── package.json              ← 仅 {"type":"module"}，无依赖
├── bin\
│   ├── gmd                   ← POSIX 转发壳（chmod +x）
│   └── gmd.cmd               ← Windows 转发壳
├── src\
│   ├── types.ts              ← §3.3 数据契约
│   ├── format.ts             ← §4.1 / §3.4 解析与序列化
│   ├── gitrepo.ts            ← §4（git 适配层，child_process）
│   ├── judge.ts              ← §4.3 判定引擎（本题算法核心）
│   ├── diff.ts               ← §4.5 行级差异
│   ├── edit.ts               ← §4.6.1 草稿
│   ├── commit.ts             ← §4.6.2 写回闸门 + 原子写
│   ├── render.ts             ← §4.3–§4.6 冲突视图 / JSON 输出（§4.9 只定退出码与 --json 形状）
│   └── cli.ts                ← 参数解析 + 分发 + 退出码
├── fixtures\
│   └── repo\                 ← **一个可复现的测试 git 仓库**（见 §8 说明；**整个目录不入库**，由脚本现场生成）
│       ├── .git\             ← 由 setup 脚本生成
│       ├── src\kv.ts
│       └── docs\api.gmd
├── scripts\
│   └── setup-fixtures.ts     ← 生成 fixtures/repo（含多次 commit，可重跑）
├── demo\
│   ├── stage1-2.ts           ← 阶段 1/2 演示
│   └── warning-loop.ts       ← **阶段 3 无人工干预闭环**（§9）
└── tests\
    └── *.test.ts             ← §8 验收断言（node:test）
```

**测试仓库（`fixtures/repo`）怎么来**：`scripts/setup-fixtures.ts` 用 `git init` 现场建仓并提交 2–3 次，**再写出 `.gmd` 文件**（`src_hash` 由脚本调用 §4.3 的 `hashRange(text, range)` 按真实内容计算 —— **脚本与 judge 必须共用同一个函数**）。⚠️ **不要手写 `src_hash`** —— 必须实测生成，否则用例一跑就红。

**"幂等、可重跑"的机制（P1-4，必须落实；登记见 §11）**：

1. 脚本**第一件事就是 `rm -rf fixtures/repo`**（Windows 用 `fs.rmSync(..., {recursive:true, force:true})`）**再重建**，绝不往旧仓库上叠提交 —— 否则重跑一次就多一次 commit、sha 全变、用例必红。
2. 所有 `git commit` 都注入**固定时间戳**，保证 commit sha 可复现：
   ```bash
   GIT_AUTHOR_DATE="2026-07-01T09:00:00Z" GIT_COMMITTER_DATE="2026-07-01T09:00:00Z" \
     git -C fixtures/repo commit -m "step N"
   ```
   （Node 侧：给 `child_process` 传 `env: {...process.env, GIT_AUTHOR_DATE, GIT_COMMITTER_DATE}`；另加 `git -c core.autocrlf=false ...` 使换行字节可复现。）
3. `.gitignore` **整目录排除 `fixtures/repo/` 与 `.gmd/tmp/`** —— 它是**现场生成的内层 git 仓库**：既不该提交生成物（会与脚本悄悄漂移），也必须避免 git 把它记成 **gitlink**（那样克隆方拿不到文件、用例全红）。根目录的 `.gitignore` 已按此写好。
4. 因此 fixture 的**源文件与 `.gmd` 也不入库**。交付库里可供评审阅读的是：① §3.2 的**手写 `.gmd` 示例**（直接看格式）；② `scripts/setup-fixtures.ts`（clone 后一条命令即可复现全部文件与提交历史）。⚠️ **不要**为了"让评审有东西看"而提交生成物。

---

## 8. 验收与测试清单（执行者必须逐条覆盖）

跑法（写进 README）：

```bash
node --experimental-strip-types scripts/setup-fixtures.ts     # 先建测试仓库
node --experimental-strip-types --test tests/*.test.ts
```

| # | 用例 | 期望 |
|---|---|---|
| **0** | **前置：来源改动已提交**（`git -C fixtures/repo add -A && git -C fixtures/repo commit -m "step N"`；用 `setup-fixtures.ts` 现场建，固定 `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`） | 所有"改源文件"的用例（**3/5/7/13/16**）执行前，来源改动**必须已提交为正式版本** —— 否则 §4.3 步骤 3 的 dirty 闸门会把结果截成 `warning` 且 `writable=false`，**用例 5 与 16 根本不可达**。**仅用例 6 / 14 / 23 保留未提交态**（6 专门验 dirty；14 验写回闸门；23 只改换行字节、验"换行不构成 dirty"） |
| 1 | `read` 一个未被改动的块 | `severity === "ok"`，`currentSource` 有值 |
| 2 | **只改源文件"块外引用范围之外"的行**（**改动已提交**，见用例 0） | 该块**仍为 `ok`**（题面阶段 1 完成标志：改无关处仍为 ok） |
| 3 | 改源文件**引用范围内**一行（**改动已提交**，见用例 0） | `severity === "warning"`，`changes` 非空 |
| 4 | 删掉整个源文件 | `severity === "error"`，且 **`currentSource === null`**、`changes` 为空 |
| 5 | 把引用范围内**整段替换成无关内容**（行集合相似度 < 0.20；该 range 共 15 行，走 §4.3 步骤 6a；**替换已提交**，见用例 0） | `severity === "error"`（不是 warning）—— 只有先提交才绕得开 dirty 短路 |
| 6 | 源文件在 range 内**有未提交修改**（**保留未提交态的用例之一**，另见 14 / 23） | `severity === "warning"` + `dirty === true` + `writable === false` + `isRangeDirty(path, range) === true` |
| 7 | 引用范围内**内容仍在**、但文件上方插入了 10 行（行号漂移；**已提交**，见用例 0） | `severity === "warning"`，reason 提及"行号" |
| 8 | 格式损坏（块未闭合） | **报错退出（码 2）**，错误信息含行号；**不得判为 ok** |
| 9 | 格式损坏（块头 JSON 非法） | 同上 |
| 10 | `log --path <src>` | 列出该源文件的提交历史（**不调用 git 也能看到** —— 输出里已含） |
| 11 | `read` 一个 error 块 | 输出含**追查入口**（`gmd log --path …` 的建议命令） |
| 12 | `read` 时存在 error 块 | **进程退出码为 3**（脚本可分支） |
| 13 | `edit` 后 `commit`（内容有变；**来源改动已提交**，见用例 0） | 新版本 `rev+1` 追加；**旧版本仍在 `hist` 里**（历史只追加） |
| 14 | `commit` 时来源 dirty 且未加 `--allow-dirty` | **拒绝（码 4）**，**文件未被修改**（校验写回前后字节一致） |
| 15 | 草稿基于旧 `base_rev`，其间已被 commit 过一次 | **拒绝（码 4）**："草稿基于旧版本 rev=N，当前为 M"（草稿头 `base_rev` 校验，§4.6.2 步骤 0） |
| 16 | **阶段 3 闭环**：`demo/warning-loop.ts`（**来源改动已提交**，见用例 0） | 从 `warning` 起，**全程无人工干预**走完 读→edit→重写→commit，结束后该块 `read` 为 `ok` |
| 17 | `commit` 后块外文本 | **逐字节未变**（对比提交前后的块外内容；仓库按 §7 的 `.gitattributes` 统一 LF，故"换行归一化为 `\n`"与"逐字节不变"等价） |
| 18 | `commit` 内容与当前**新正文**（= 输入剥离 `<!-- gmd:draft -->` 头之后的内容，§4.6.2 步骤 0）相同 | **拒绝（码 4）**："内容未变化"—— 必须先剥离草稿头，否则 `text_hash` 恒不同、本用例永不可达（`text_hash` 按 §3.3 的 `textHash` 计算：换行归一化为 `\n` 后 `trim`） |
| 19 | `--json` 输出（`read` / `log` / `commit` / `edit`） | 单行、**`JSON.parse` 必成功**，且形状与 §4.9 契约逐字段一致（`read` → `{doc, blocks}`；`log` → 数组；`commit` → `{block, rev, text_hash, range}`；`edit` → `{draft_path}`） |
| **19b** | 手改 `.gmd` 正文（不追加版本）后 `read` | 该块 `severity === "error"`、`reason === "正文与元数据不一致"`、`currentSource === null`（§4.3 步骤 0，P1-3） |
| **19c** | **单行范围的短引用**：`setup-fixtures.ts` 建一个 `range:[12,12]` 的块，再**改写该行内容**（**改动已提交**，见用例 0） | `severity === "warning"`（**不是 error**）—— 走 §4.3 步骤 6b 的字符集合 Jaccard（阈值 0.30）。旧版行集合 Jaccard 在 1 行上必退化为 `sim = 0`，会把题面定义的 warning 误判成 error |
| **19d**（P3 补，**非可选**） | `read --plain`（只出正文）／`read --plain --json`（互斥） | 前者输出**不含**严重度 / 变更点 / 建议命令，**只出块正文**（给 `--block` → 该块正文；缺 `--block` → 按块顺序、空行分隔）；后者 → **参数错，退出码 1**。对应题面"可切换为只出正文"（§1.6 / §4.9） |
| 20（可选，阶段 4·1） | 来源 dirty + `commit --allow-dirty` | 写回成功、`rev+1`，新版本 `note` 含 `based_on_dirty`，审计输出显著标注"基于未提交来源" |
| 21（可选，阶段 4·2） | MCP：stdio 发 `tools/list` + `tools/call`（`gmd_read`） | 返回合法 JSON-RPC 响应，内容与 CLI `read --json` 一致 |
| 22（可选，阶段 4·3） | `v.commit` 不是 `HEAD` 祖先（另起分支改来源后 commit） | 降级为 `warning`，reason 提示"来源来自其它分支" |
| **23**（P2 补，**非可选**） | **换行不构成 dirty**：一段已提交的引用（其 `src_hash` 由 `hashRange` 实测）在工作区被换成 **CRLF** 字节（`core.autocrlf=true` 的 checkout 效果，或直接把 CRLF 写回工作区）、`HEAD` 里仍是 **LF**，引用范围内内容**语义相同**且**不提交** | `severity === "ok"`、`dirty === false`、`writable === true`（**不是** `warning`，也不禁止写回）—— 必须走 §4.3 步骤 3 的 `isRangeDirty` 唯一口径 `hashRange(nowText, range) !== hashRange(headText, range)`（两边都 `split(/\r\n|\r|\n/)` 后再以 `\n` 连接）；防止把 CRLF/LF 差异误判成"内容变了"（跑完把该文件恢复为 LF 并 `git checkout -- <path>`，避免污染后续用例） |
| **24**（P0 回归，**非可选**，第二轮复核新增） | 来源被**截断到引用范围之外**（已提交）：`b1` 引 `[10,24]`，把 `src/kv.ts` 砍到只剩 9 行 | `severity === "error"`、`currentSource === null`、`changes === []`、`writable === false`（§4.3 步骤 3.5）；`b3` 仍 `ok`（片段级独立）。**修复前**这条只能靠 hash 不等偶然判对，写回侧仍会把越界 range 洗成 `ok` |
| **25**（P0 回归·写回闸门，**非可选**，第二轮复核新增） | 同 24 的前置（范围已不存在）后执行 `commit`（`--input -` 给新正文） | **拒绝（码 4）**、理由含"已不存在"、`.gmd` **逐字节不变**、`rev` 仍为 1，且**再 read 仍为 `error`**（绝不能被洗成 `ok`）—— §4.6.2 校验 5 |
| **26**（回归，第二轮复核新增） | 块正文在**围栏代码块**里写 `<!-- gmd:block … -->` / `<!-- /gmd:block -->` 字面量后 `commit` | 写回与解析都成功（**不是码 2**）；该块 `ok`、`rev+1`；围栏原样保留。§4.1 围栏豁免 |
| **27**（安全回归，第二轮复核新增） | `hist[].path` 改成 `../outside.ts` / `src/../../outside.ts` / `/etc/hosts` / `C:/Windows/win.ini` / `src//kv.ts` | 一律**码 2**（格式损坏）、`stdout` 为空。**修复前**会把仓库外文件内容当 `currentSource` 回显。§3.1 路径纪律 + §4.1 `resolveInRepo` 兜底 |
| **28**（阶段 4·2，本轮新增） | `error` 档闭环：删掉 `src/kv.ts`（已提交）⇒ b1 `error("引用文件不存在")`，再 `commit --block b1 --path src/conf.ts --range 9..13 --input -` 重写正文 | 写回成功、`rev+1`；新版本 `path=src/conf.ts`/`range=[9,13]`；`read` 回到 `ok`；`log --block b1` 里 **rev1 仍记着旧 `src/kv.ts`/`[10,24]`**（历史只追加、旧绑定不被改写）；`b2` 仍是 error（片段级独立） |
| **29**（阶段 4·2 边界，本轮新增） | 重绑定的四类边界：`--range 5..2` / `--range 0..3` / `--path ../outside.ts` / `--path src/nope.ts` / `--range 9..999` / **新来源脏**（改 `src/conf.ts` 不提交） | 前三者**码 1**（参数错）；不存在与越界**码 4**；新来源脏**码 4**（`/未提交修改/`）；`.gmd` 全程逐字节不变、`rev` 仍为 1 |
| **30**（回归·闸门漏洞，本轮新增） | **手改正文**让 b1 本身变成 `error`，同时来源范围有未提交修改 ⇒ `commit --input -` | **码 4**（`/未提交修改/`）、文件逐字节不变。**修复前** `commit` 取 `judgeBlock(...).dirty`，而该函数在步骤 0 场景返回 `dirty=false` ⇒ "先把正文手改坏再 commit"能绕过脏来源闸门，违反"引用范围内有未提交修改 ⇒ 不允许写回" |
| **31**（阶段 4·3，本轮新增） | 造出 rev1→rev2 后：`read --version 1 --block b1 --json` / `--plain` / 人读视图；再取 rev2 | `text` = **rev1 当时写下的正文**（不得拿活动正文冒充）；`active_severity` 标注的是活动版本（rev2 已 `ok`）；`--plain --version 1` 只出该版正文、不混进 rev2 内容；不带 `note` 的版本不凭空多出该字段 |
| **32**（阶段 4·3 边界，本轮新增） | ① 手改 `hist[0].text` 但不改 `text_hash`；② 删掉 `text` 字段（模拟旧格式 / 手写骨架） | ① **码 2**（"text 与 text_hash 不一致"+行号）；② 仍能 `read` 且 `ok`，`read --version 1 --json` 给 `text: null`、`--version 1 --block b1 --plain` 的 stdout 为空 + stderr 说明"未存正文"（**不改退出码**）；不给 `--block` 时其余块的正文照常输出 |
| **33**（前向兼容，本轮新增） | 给 `gmd:doc` / b1 块头 / b1 的 `hist[0]` / b2 块头各塞一个本工具不认识的字段，再对 b1 走一次 `edit → commit` | ① 加扩展字段**不影响判定**（b1 仍 `ok`）；② **b2 的块头与文档头逐字节不变**（`commit` 只重写目标片段）；③ b1 自己的**块头级与版本级扩展字段都不丢**（`future_block` / `future_ver` 仍在），且 b1 照常 `rev 2`、写回后仍 `ok` |

> 🔴 **用例 0 不是"随便跑一下"，是 3/5/7/13/16 的**前置条件**：演示与测试里每一次"改源文件"之后，都必须**显式提交**（见 §9.2 / §9.3 的注解），否则 dirty 短路让这些用例断言失败。**全文唯一允许不提交源改动的地方是用例 6、用例 14 与用例 23**（23 只改换行字节：CRLF 工作区 vs LF HEAD，属"换行不构成 dirty"）。**

---

## 9. 演示脚本

### 9.1 两个入口

```bash
node --experimental-strip-types scripts/setup-fixtures.ts    # 准备测试仓库（幂等，可重跑）
node --experimental-strip-types demo/stage1-2.ts             # 阶段 1+2：读得准 + 查得到
node --experimental-strip-types demo/warning-loop.ts         # 阶段 3：无人工干预闭环
```

### 9.2 演示 1（阶段 1+2）顺序打印

> 🔴 **每一步"改源文件"之后必须立刻提交源改动**（P0-1）：
> ```bash
> git -C fixtures/repo add -A && git -C fixtures/repo commit -m "demo step N"
> ```
> 否则 §4.3 步骤 3 的 dirty 短路会把它判成 `warning(dirty)` 而不是期望档位，且 `writable=false`。**演示 1 的唯一例外是第 6 步之后要专门展示 dirty 时**（见末尾说明）。

1. **`ok` 基准**：`gmd read docs/api.gmd` → 两块都是 `ok`，展示冲突视图长什么样
2. **改无关处**：改 `src/kv.ts` 第 3 行 → `git add -A && git commit -m "demo step 2"` → `gmd read` **仍 `ok`**（证明"只看引用范围"）
3. **改范围内**：改 `src/kv.ts` 第 15 行 → `git add -A && git commit -m "demo step 3"` → `warning` + 变更点 + 来源当前内容
4. **整段替换**：把第 10–24 行换成完全无关的代码 → `git add -A && git commit -m "demo step 4"` → **`error` 且不显示旧文字**（不提交就会被 dirty 短路成 `warning`，这一步是演示里最容易翻车的地方）
5. **删文件**：`rm src/kv.ts` → `git add -A && git commit -m "demo step 5"` → `error`（"引用文件不存在"）
6. **追查**：`gmd log --block b1 --path src/kv.ts` → 打印来源提交历史（**AI 无需自己调 Git**）
   - 可选彩蛋（**唯一保留未提交态的步骤**）：先 `git checkout -- src/kv.ts` 把第 5 步删掉的文件恢复回工作区（**不要提交**），再跑一次 `gmd read` → 展示 `warning + dirty=true + writable=false`，正好对上 §8 用例 6。

> 📌 **为什么演示脚本要自己 commit**：题面阶段 3 要的是"AI 无人工干预完成闭环"，而 §4.6.2 校验 3 在来源 dirty 时**默认拒绝写回**。⇒ 一个真正的自动闭环**必然包含"先把来源改动提交为正式版本"这一步**；演示 1 把这一步显式打出来，既满足用例 0 的前置条件，也顺带证明了工具"不伪造正式版本"的立场。

### 9.3 演示 2（阶段 3，**核心**）—— 必须"无人工干预"

```
0. 【第 0 步，先做】把来源改动提交为正式版本（P0-1）
   git -C fixtures/repo add -A && git -C fixtures/repo commit -m "step 0"
   ↑ 不做这一步，下面的 commit 会被 §4.6.2 校验 3 的 dirty 闸门拒绝（码 4），闭环不成立
1. 打印：当前 b1 为 warning（附冲突视图，说明"为什么是 warning 而不是 error"）
2. 自动执行 gmd edit docs/api.gmd --block b1  → 打印草稿路径
3. 脚本按"新来源内容"重新生成正文，写回草稿文件     ← 这一步模拟 AI 的重写
   （草稿里的 <!-- gmd:draft ... --> 头**原样保留**，只改其下的正文；
     commit 时由步骤 0 剥离，不进入 .gmd 正文）
4. 自动执行 gmd commit docs/api.gmd --block b1 --input <草稿>
5. 自动执行 gmd read docs/api.gmd --block b1 → 打印 rev+1 且 severity=ok
6. 打印 hist 长度（证明旧版本还在，历史只追加）
```

> 🔴 **第 0 步是硬前置**：`demo/warning-loop.ts` 若在来源仍 dirty 时直接 `commit`，会在校验 3 被拒（码 4）——"全程无人工干预"就断在这里。脚本必须**自己**执行第 0 步的 `git commit`（这正是"无人工干预"的一部分，也让新 `hist` 里的 `commit` 指向一个正式版本）。
> 🎤 **每一步都要打印"为什么"**：用了什么范围 / 比较了什么 hash / 为什么判这一档。题面明说会**深挖细节、答不出可能被认为过度使用 AI** —— 演示脚本自带决策理由能把风险前置消掉。
> 🔴 **不允许在演示里手工编辑文件** —— 题面阶段 3 的完成标志就是"**AI 无人工干预**完成全过程"。注意区分：**"AI 脚本自动执行 `git commit`"不算人工干预**；只有"人手动敲命令 / 手动改文件"才算。

---

## 10. README 要求（交付物）

必须包含：

1. **一句话定位**（`.gmd` 是什么、解决什么问题）
2. **启动方式**（两条命令以内 + `node --version` 与 `git --version` 自检）
3. **`.gmd` 格式说明**（§3：文法、注释块、示例——**这是本项目的门面，要写得让人一看就懂**）
4. **三档判定算法**（§4.3 的**步骤 0 + 六步**，含**分段相似度阈值（≥3 行 0.20 / ≤2 行 0.30）及其理由**、以及"正文 hash 与元数据不一致直接 error"）
5. **设计取舍与理由**（至少写清三条：① 为什么用 HTML 注释承载元数据；② 为什么用行集合相似度而不是 git diff（短引用 ≤2 行为何退化为字符集合 Jaccard）；③ 为什么只存活动版本正文 —— §4.7）
6. **`--allow-dirty` 的语义**（若未实现，明确写"未实现，但命令接受该 flag 并提示"；语义登记见 §11）
7. **已实现 / 未实现**（如实声明：不做符号级引用？不做分支祖先判断？不做缓存？不做文件重命名跟踪？**未提供 `gmd new`，从零建文档按 §3.1 手写块头**）
8. **演示步骤**（§9 的三条命令；含"改来源后先 `git commit` 再判定"这条前置）
9. **Node / git 版本要求**
10. **《答辩问答》**（`docs/defense/`）：**每个模块一份**，放在 `docs/defense/<模块名>.md`。一句话理由：题面"**对项目细节深入提问，答不出可能被认为过度使用 AI**"是唯一评分门（`docs/handoff-to-dsh.md` §2.4 已把它定为硬要求）。README 的"项目结构"一节必须**列出这些文件并给出链接**。
11. **换行约定（LF）+ `.gitattributes`**：仓库内文本文件一律 LF（`.gitattributes` 用 `*.gmd text eol=lf`，§7）；写入侧先把换行归一化为 `\n` 再落盘（§3.4）；`text_hash`（§3.3）与 `hashRange`（§4.3）都按 `\n` 计算，因此 checkout 换行变化不会污染判定。

### 10.1 交付时一并带上的（题面第 1 页通用要求，最容易漏）

- **git 分阶段 commit** —— 每完成一个阶段提交一次，"方便我们了解你的动态"；**不用 git 则按小时在飞书文档同步**（写清：完成内容 / 背后思路 / 难点 / 解决方式）
- **留下 session** —— 与 AI 的对话记录或分享链接
- ⚠️ 题面原话：**"会对项目细节深入提问，如果答不出细节可能会被认为过度使用 AI"** ⇒ 交付前必须能讲清：为什么相似度阈值**分段取** ≥3 行 0.20 / ≤2 行 0.30（§4.3 步骤 6a/6b）、为什么 dirty 时禁写、为什么 error 不显示旧文字、`rev` 为什么必须连续

---

## 11. 默认值账本（正文取值一律以本节为准）

> 📒 **本表是 §2–§10 全部默认值 / 阈值 / 可调参数 / 我方决定的汇总账本。凡正文写"未定 / 由 §11 拍板 / 可调"的项，取值一律以本表为准；正文与本节不一致属 PLAN 自身缺陷，须回报修正。**
>
> （**不入本表的两类**：① §3 文法与 §3.3 契约里的固定取值 —— 如 `gmd:1`、`id` 的 `^[A-Za-z0-9_-]{1,64}$`、`rev` 从 1 起且连续、`[l0,l1]` 为 1-based 闭区间 —— 属"不可改契约"，一律由 §3 正文写死；② 纯举例与测试数据 —— §3.2 示例里的 `range` / `doc_id`、§4.3 步骤 6b 举例的 `sim ≈ 0.78`、§7/§8/§9 的 fixture 行号、插入行数、`git commit` 次数、提交时间戳 —— 属演示/测试数据而非默认值。除这两类外，正文里的每一个数字都应能在本表找到对应行；找不到即为 PLAN 缺陷，须回报修正。）

| 项 | 默认 |
|---|---|
| 元数据载体 | HTML 注释（§2） |
| `range` 表示 | 1-based 闭区间 `[l0, l1]`（含两端） |
| `src_hash` 算法 | **唯一实现 `hashRange(text,[l0,l1]) = sha256(normalizeEol(text).split('\n').slice(l0-1,l1).join('\n'))`**（§4.3；`normalizeEol` 见下一行，**对只有 LF / CRLF 的文件**逐字节等价于 `sha256(text.split(/\r?\n/).slice(l0-1,l1).join('\n'))`），hex 小写、前缀 `sha256:`；fixture 脚本与 judge **必须共用同一个函数** |
| 换行归一化的唯一原语（判定 / 摘要用） | **`normalizeEol(text) = text.split(/\r\n|\r|\n/).join('\n')`**（`gitrepo.ts` 导出；定义在 §4.3 代码块）：**CRLF / LF / 孤立 `\r` 统一为 LF**（等价写法 `replace(/\r\n?/g,'\n')`，但**只保留一处实现**、不得另写一份）。§4.3 的 `hashRange`（先归一化再按 `[l0,l1]` 切行 `join('\n')`）与 §3.3 的 `textHash`（先归一化再 `trim()`）**共用它** ⇒ 两个"唯一实现"口径必然一致；§4.3 步骤 3 的 `isRangeDirty` **只**经 `hashRange` 比较，故**换行差异（CRLF 工作区 vs LF HEAD）不构成 dirty**（§3.3 / §4.3 / §8 用例 23）。写盘侧（§3.4）把 `\r\n` / `\r` 一律归一化为 `\n` 是**输出规范化**；与本行口径**一致**（本原语同样覆盖孤立 `\r`），不再存在"写盘比判定更严格"的差异 |
| 正文归一化 | 块正文去掉首尾各一个换行；计算 / 比较 `text_hash` 前**先用 `normalizeEol` 归一化换行（CRLF / LF → LF）再 `trim()`**，即 `textHash(text) = 'sha256:' + sha256(normalizeEol(text).trim())`（hex 小写、前缀 `sha256:`；§3.3 的**唯一实现** —— `commit` 写 `text_hash` 与 §4.3 步骤 0 校验必须调用同一个它） |
| 草稿头剥离 | `commit` 时若输入首行以 `<!-- gmd:draft ` 开头 → **丢弃该行**并解析其 JSON（解析失败 → 拒绝，码 4）；`base_rev`/`block`/`doc` 与实参或当前状态不符则拒绝（码 4）；**新正文 = 输入去掉草稿头之后的内容**（再做首尾空行归一化）；输入没有草稿头 → **新正文 = 输入原样**（§4.6.2 步骤 0） |
| 相似度阈值 | **分段**：范围 ≥3 行 **0.20**（非空行的**行集合 Jaccard**）、范围 ≤2 行 **0.30**（各行首尾相接后的**去重字符集合 Jaccard**），均为 warning / error 分界（§4.3 步骤 6a/6b），写进 README。**理由**：1–2 行时行集合交集必为空（`sim = 0`），会把题面定义的 warning 误判成 error，故短引用改按字符集合比。阈值**可调**，但改值必须**可复现**（同一输入必得同一输出）；`A`、`B` 均为空时 `sim = 0` |
| 行号漂移搜索窗口 | `range ± 50` 行 |
| `changes` 上限 | 20 条，超出截断 |
| 缓存 | **不做**（题面说"可生成"，非必需） |
| 历史正文 | **保存**：`hist[i].text`（可选字段，本实现写出的版本一律带；与 `text_hash` 必须自洽，见 §4.1 校验）。`read --version <rev>` 取回该版正文；缺 `text` 的旧格式给 `text: null` + stderr 说明（§4.7 / §4.9 / §8 用例 31、32）。原稿预留的平行数组 `hist_text[]` **不采用**（同一版本记录内才可校验） |
| 草稿目录 | `<repo>/.gmd/tmp/`（可删；判定从不读它） |
| 未提交修改的判定粒度 | **仅比较 `v.range` 范围内**（题面："判断只看被引用的范围"）；函数是 `isRangeDirty(path, range)`，**不是**整文件级 `isDirty(path)`。**实现口径写死**：`isRangeDirty(path, range) := hashRange(当前文件文本, range) !== hashRange(git show HEAD:<path> 的文本, range)` —— 两边**必须先经同一个 `hashRange`**（内部 `normalizeEol`：`split(/\r\n|\r|\n/)` 后再以 `'\n'` 连接）归一化后再比；**禁止**直接比较原文、行数组（`nowLines` / `headLines` 只可用于行数 / 相似度 / 展示）或用第二套切分口径 —— **换行差异不构成 dirty**（CRLF 工作区 vs LF HEAD 判 equal），否则全块永久 `warning` + `writable = false`（§4.3 步骤 2/3、§8 用例 23） |
| 文件重命名 | **不做跟踪**（按"文件不存在"判 error）；写进 README 的"未实现" |
| 写回原子性 | 写 `.tmp` → `rename` |
| 块外文本（非正文部分） | 写回时**逐字节保留**，只把换行统一为 `\n`（§3.4）；仓库按 `.gitattributes` 强制 LF ⇒ "换行归一化"与"逐字节不变"等价（§8 用例 17） |
| 退出码 | **0** 成功（`read` 时所有块均非 error）/ **1** 参数·用法错 / **2** 格式损坏（解析失败；含来源路径逃逸仓库）/ **3** 存在 `error` 块（`read` 专用）/ **4** 写回被拒（§4.6.2 步骤 0 + 五道校验）/ **5** 环境错误（`git` 不存在、`--repo` 不是仓库、git 子进程非零退出或超时）；详见 §4.9 |
| 阶段 4 选做项与预留用例编号 | 三条选做：① **`--allow-dirty` 受控写回**（首选，题面显式列出的命令参数）② **MCP 集成** ③ **分支/祖先判断**；**做哪条就补 §8 哪条用例**：①→用例 **20**、②→**21**、③→**22**（§8 已按 20/21/22 预留三条"可选"行）；**20/21/22 已被占用，故 §8 新增用例一律从 `23` 起编** —— 用例 **23 是阶段 1 的 `isRangeDirty` 口径回归用例（非选做、必做，已列入阶段 1 验收）**；未做则整条跳过，并在 README"已实现 / 未实现"里如实声明（§5 阶段 1 / 阶段 4） |
| 仓库换行约定 | 仓库内文本一律 **LF**：`.gitattributes` 写 `*.gmd text eol=lf`（§3.4 / §7 / §10 第 11 条）；写入侧先把换行归一化为 `\n` 再落盘 |
| fixture 的排除与复现 | **整目录排除 `fixtures/repo/`**（其源文件与 `.git` **一律不入库** —— 避免与脚本悄悄漂移、避免被父库记成 gitlink）与 `.gmd/tmp/`；`scripts/setup-fixtures.ts` **第一件事是 `rm -rf fixtures/repo` 再重建**，每次 `git commit` 注入固定 **`GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`**（另加 `-c core.autocrlf=false`），保证重跑后 commit sha 一致（§7 / §8 用例 0 / 附二1） |
| 判定依据 | **工作区（worktree）当前内容**，不是 `HEAD`（题面"基于读取时的真实仓库状态判断，不用陈旧缓存"；§2 / §4.3） |
| 来源文件编码 | 读取来源一律按 **UTF-8** 解码（`TextDecoder('utf-8', {fatal:true})`）；**非 UTF-8** 或**二进制**（含 NUL 字节）→ **明确报错**（该块记 `error("来源不是 UTF-8 文本: <path>")`，其它块继续判），**不静默降级、不用替换字符**（§4.1 / §4.4） |
| `--json` 输出结构 | **单行合法 JSON**（`JSON.parse` 必成功）：`read` → `{doc, blocks}`；`read --version <rev>` → **数组** `[{block, rev, at, path, range, commit, src_hash, text_hash, text, active_severity}]`（`text` 缺正文时 **`null`**）；`log` → **数组**（`--block` → `[{rev, at, path, range, commit, src_hash, text_hash}]`（**不含 `text`**）；`--path`（+`--range`）→ `[{sha, short, at, subject}]`；无参数 → `[{id, rev, severity, path, range}]`）；`commit` → `{block, rev, text_hash, range}`（`--path` 重绑定时**追加** `path`）；`edit` → `{draft_path}`（绝对路径）；失败 → `{error, code}`（与退出码同号，人类可读文字走 stderr）；未列入的命令**不承诺**有 `--json`（§4.9 / §8 用例 19） |
| `read` 的"只出正文"开关 | **`--plain`**（别名 `--body`，`read` 专用）：只打印块正文，不带严重度 / 变更点 / 建议命令；缺 `--block` 时按块顺序输出、空行分隔；**与 `--json` 互斥**（同时给 → 参数错，码 1）；退出码仍按 §4.9 表（存在 error 块时 `read` 仍返回 3）。题面依据：§1.6"默认冲突视图，**可切换为只出正文**"（§4.9 / §8 用例 19d） |
| git 子进程 | 一律 **`git -C <repo>`**（不得依赖 `process.cwd()`，否则 `--repo` 形同虚设）且**必须带 15s 超时**；启动时 `git --version` 探测一次，失败 → **明确报错**而非静默降级（§2.1 / §5 阶段 1） |
| `log --range` 的边界与降级 | `a > b` 或 `a < 1` → 参数错**码 1**；`b > 当前文件行数` → **不调用** `git log -L`，降级为"列出该文件全部提交并标注 `range 超出当前文件行数`"；**任何** git 非零退出（含 128、超时、`-L` 在重命名 / 合并历史上报错）→ 一律**码 5**（打印 stderr 首行），**不得**当成"没有提交"或静默吞掉；`git show v.commit:<path>` 取不到 → 该块 `error("无法回溯来源版本")`（§4.8 / §4.3 步骤 6） |
| 追加版本的 `range` | `commit` **沿用它记录的旧范围**（阶段 1–3 不做符号 / 选区级引用 —— 那是阶段 4）；`commit = git rev-parse HEAD`、`src_hash = hashRange(当前文件文本, range)` 均重算（§4.6.2） |
| 草稿文件命名 | `<repo>/.gmd/tmp/<doc 相对路径的分隔符→下划线>-<sha256(文档绝对路径) 前 8 位>-<block>.draft.md`；目标已存在则**覆盖**并打印 `覆盖已有草稿: <path>`（**不**静默追加编号）；规则写进 README（§4.6.1） |
| `--allow-dirty` 语义（阶段 4 选做） | 若实现：**审计输出显著标注"此版本基于未提交来源"**，新版本 `note` 写入 `based_on_dirty`；**不做也须接受该 flag 并给出明确提示**（§4.6.2） |
| 从零建文档 | **不提供 `gmd new` 子命令**（题面参考接口只有 `read`/`log`/`edit`/`commit`）；按 §3.1 **手写** `gmd:doc` / `gmd:block` 骨架，`hist[0]` 的 `src_hash` 用 `hashRange` 实测；README"快速开始"必须给出可复制的最小骨架（§5 阶段 3） |
| 历史正文（阶段 4·3，已实现） | 字段为 `hist[i].text`（**不是**原稿预留的 `hist_text[]` —— 见 §4.7 的理由）；解析时校验 `textHash(text) === text_hash`，否则**码 2**；`read --version --json` 缺正文时给 `text: null`、`--plain` 走 stderr 说明且**不改退出码**；README 已如实说明"文件随版本数线性膨胀"（§4.7 / §8 用例 31、32） |
| 语言 / 运行环境 | **TypeScript + Node**（零第三方依赖，唯一外部程序是 `git`）；**Node ≥ 22.6（建议 ≥ 22.18）** + `node --experimental-strip-types`；相对 import 必须带 `.ts` 后缀；禁用 `enum` / `namespace` / 装饰器 / 构造函数参数属性 / `tsconfig paths` 别名（§0 第 2 条 / §2 / §2.1） |
| 元数据编码 | 注释内 **JSON**：解析允许跨多行，**序列化输出为紧凑单行**（§2 / §3.4） |
| 分隔符安全 | 序列化 JSON 时把 `--` 转义为 `\u002d\u002d`（只处理 JSON 字面量，不动正文）；解析时若注释提前闭合 → 视为格式损坏（§2 / §3.1 / §3.4） |
| 围栏代码块豁免（本次复核新增） | 扫描标记时先算出**已闭合**的 ```/~~~ 围栏字符区间，落在其中的 `<!-- gmd:… -->` **不当标记**；未闭合的围栏不入表（不得吞掉真标记）。理由：讲 .gmd 格式的文档必然在代码块里写标记示例，不豁免会误判"片段嵌套/未闭合"（§3.1 / §4.1） |
| 引用范围存在性（本次复核新增） | 判定侧 §4.3 步骤 3.5 + 写回侧 §4.6.2 校验 5：`countLines(来源) < range[1]` ⇒ 判定 `error` / 写回拒（码 4）。理由：`hashRange` 对越界 range **静默截断**成空串哈希，会与"范围内是空内容"不可区分 ⇒ 沿用越界 range 写回会把 `error` 伪造成 `ok`（§4.3 / §4.6.2 / §8 用例 24、25） |
| 来源路径必须落在仓库内（本次复核新增） | `hist[].path` 拒绝绝对路径 / 盘符 / 反斜杠 / `..` / `.` / 空段 ⇒ 格式错（码 2）；`gitrepo.resolveInRepo` 再兜底。理由：否则一份 `.gmd` 就能让 `gmd read` 把仓库外文件内容当"来源当前内容"回显（§3.1 / §4.1 / §8 用例 27） |
| 引用重绑定（阶段 4·2，本轮新增） | `commit --path <src>` / `--range <a..b>`：本版本改指到仍存在的来源，`targetPath/targetRange` 缺省沿用活动版本。`--path` 必须仓库内相对路径（否则**码 1**）、`--range` 须 1-based 闭区间（否则**码 1**）；新来源不存在 / 范围越界 / 范围脏 ⇒ **码 4**。只影响本版本，`hist` 里旧版本绑定不改写（§4.6.2 / §8 用例 28、29） |
| 扩展字段（前向兼容，本轮新增） | 本工具不认识的字段一并**原样保留**（`gmd:doc` / 块头 / 版本记录三层），挂在 `EXTRAS`（Symbol 键）上、写回时显式合并；`serializeGmd(raw, blocks, rewriteIds?)` 只重写 `rewriteIds` 里的片段，其余按原文逐字节拷贝。**不做**"不认识就报错"（扩展字段不是损坏），也**不做**静默丢弃（§3.4 / §8 用例 33） |

---

## 附：给执行者的第一步

1. 建 `types.ts`（§3.3 原样）+ `format.ts` 的**解析**（严格模式）+ `scripts/setup-fixtures.ts`；
2. 跑 `setup-fixtures.ts`，确认 `fixtures/repo/docs/api.gmd` 的 `src_hash` 是**实测算出来的**；
3. 实现 `judge.ts` 的**步骤 0/1/3/4**（正文一致性、存在性、dirty、hash 比对），`read` 能输出 ok/warning；
4. 通过 §8 用例 0、1–6 后，再补步骤 5/6（真正区分 warning/error），进阶段 2。

---

## 附二：已知待办（不影响开工，交付前要处理）

1. **fixture 仓库的可复现性** —— **不要把 `fixtures/repo/` 纳入交付**：它是脚本现场生成的内层 git 仓库，提交它既会与脚本悄悄漂移，又会被父库记成 **gitlink**（一个 commit 指针），**克隆方拿不到任何文件**，等于把"可复现"做成了"不可复现"。正确做法：① 在 `.gitignore` 里**整目录排除 `fixtures/repo/` 与 `.gmd/tmp/`** —— `fixtures/repo/` 下的源文件与 `.git` **一律不入库**（措辞与 §7 第 3、4 条一致）；② 交付库里可供评审阅读的是 §3.2 的**手写 `.gmd` 示例** + `scripts/setup-fixtures.ts`，README 写明"跑一条 `scripts/setup-fixtures.ts` 即现场重建仓库与其提交历史"；③ 脚本按 §7 的做法 **`rm -rf` 重建 + 固定 `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`**，保证重跑后 commit sha 一致（评审跑 `git log` 照样能看到历史，且看到的是可复现的历史）。
2. **`gmd edit` 的草稿是否算"侧车文件"** —— 严格读题面第 1 条"不依赖旁车文件、索引、数据库**或文件名**"：草稿是**临时的、可删的、判定从不读的**，因此不违反；但**必须在 README 明确解释这一点**，否则容易被质疑。
3. **`--version <rev>` 的语义已在 §4.7 收窄** —— 若执行者实现了历史正文保留，README 要同步改。
4. **大文档性能（阶段 4 可选）** —— 若做，方向是：解析结果缓存（内存内，不落盘）+ 只在 `read` 单块时判定该块（避免全文 `git show`）。
