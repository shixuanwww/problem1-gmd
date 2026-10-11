### 模块：CLI 分发 `src/cli.ts`

**1. 这段在干什么（一句话）**
解析参数（`--repo`/`--json`/`--plain`/`--block`/…）、定位仓库、把 `read`/`log`/`edit`/`commit` 分发到对应模块，并**统一把异常映射为退出码 0–5**。

**2. 关键设计决策 + 为什么这么做**

- **退出码是"给 AI/脚本的分支信号"**（题面阶段 2 要求"AI 无需自己调用 Git"、阶段 3 要求自动化闭环）：
  | 码 | 含义 | 由谁产生 |
  |---|---|---|
  | 0 | 成功（`read` 时所有块非 error） | 正常返回 |
| 1 | 参数/用法错误 | 未知名选项、缺参、文档不存在、`--plain --json` 互斥、`--range` 非法、`--path` 逃出仓库（`commit`/`log`） |
  | 2 | 格式损坏 | `GmdFormatError` |
  | 3 | 存在 error 块 | `read` 判定完成后探测 |
  | 4 | 写回被拒 | `CommitRejected` |
  | 5 | 环境错误 | git 不存在、`--repo` 非仓库、`GitError`、非 UTF-8 |
- **`--repo` 是全局选项，放子命令前或后都行**：`parseArgs` 先做一趟无序扫描，把 `--xxx` 收进 `flags`、裸词收进 `positionals`，因此 `gmd --repo X read a.gmd` 与 `gmd read a.gmd --repo X` 等价。
- **`--repo` 优先，否则从 cwd 向上找 `.git`**：找不到 ⇒ 退出码 5。**不用 `process.cwd()` 传给 git**（否则 `--repo` 形同虚设），所有 git 调用都带 `-C <repo>`。
- **失败不污染 stdout**：`--json` 时 stdout 只放 `{"error","code"}`，人类可读文字全部走 stderr（`fail()` 统一处理）。这让 `gmd ... --json | jq` 永远安全。
- **`read --version` 与 `--plain` 走独立分支**：`--version` 输出**该版本当时写下的正文 + 来源信息**（阶段 4·3 起 `hist[].text` 内嵌，见 `render.md`），并附 `active_severity`（该块**活动版本**的严重度）；两者可组合 —— `--plain --version <rev>` 只出该版正文。`--plain`（不带 `--version`）输出活动正文，但**仍按 §4.9 规则返回退出码 3**（存在 error 块）。
- **`read --block <id>` 对两种输出形态**一视同仁**：`--json` 与冲突视图**共用同一个 `selected`**（`blockFlag` 命中则该块、否则全量）。曾出现的坑是"只有冲突视图收窄、`--json` 仍返回全部块"—— 而恰恰是 AI 用 `--json`，于是人和机器看到不同的块集合，属同一条命令自相矛盾。**注意退出码仍按整篇文档算**（存在 error 块 ⇒ 3），不因 `--block` 收窄而放宽，这样脚本据码分支时不会漏判文档整体状态。
- **进程内可调用**：`runCli(argv, {cwd, stdin, io})` 把 `io` 作为参数注入 ⇒ 测试无需起子进程（本机 `spawnSync` EBUSY，进程内调用更稳），也让 demo 能直接复用。仅在"文件被当作入口直接运行"时才接 `process.argv`。
- **`--path` / `--range` 在 `commit` 与 `log` 下语义不同、校验同一套**：`log --path --range` 是**查**来源提交历史（`--range` 不能单独用，会码 1）；`commit --path --range` 是**改**本版本的引用绑定（阶段 4·2，见 `commit.md`）。两者的取值校验共用 `isRepoRelativePath` / `parseRange`，所以"逃出仓库的 `--path`"和"`a>b` 的 `--range`"在两处都是**码 1**，不会出现同一参数两种结论。
- **选项归属校验（本轮新增）**：`parseArgs` 只负责"这个名字认不认识"，**归属**由 `COMMAND_FLAGS` 单独管 —— 每个子命令只接受自己的选项 + 全局选项，其余 **码 1** 并明说"`gmd read` 不支持选项 `--range`"。**为什么必须做**：修复前 `read --range 1..2` 会被接受并**悄悄丢掉**，AI 以为只读那两行 / 只按那个范围判定，实际拿到整篇并按整篇算退出码 —— "传了却不生效"是最难 debug 的一类错误。
- **"片段不存在"四命令同码（本轮新增）**：`read` / `log` / `edit` / `commit` 都回 **码 1**。修复前 `commit --block nope` 走的是 `CommitRejected` ⇒ **码 4**，而 4 的含义是"写回被拒（来源脏 / 内容没变 / 范围越界）"—— 按退出码分支的调用方会把"参数打错了"当成"来源没提交好"。为此 `commit.ts` 单独抛 `BlockNotFoundError`，由 CLI 映射成 1。同理 `--input <目录>` 判 **码 1**（修复前 `readFileSync` 冒泡 `EISDIR`，被兜底成"内部错误"码 5）。

**3. 可能被追问的问题 + 要点**

- **Q：怎么保证 `gmd` 这个命令名？**
  A：两条路：① `bin/gmd`（POSIX 转发壳，**在 git 里是 `100755`**）与 `bin/gmd.cmd`（Windows）转发到 `node --experimental-strip-types src/cli.ts`，装进 PATH 后命令就叫 `gmd`；② 不装 PATH 也能 `node --experimental-strip-types src/cli.ts ...` 直接跑。题面"命令名必须是 `gmd`"与"无需 `gmd init`"都满足。⚠️ POSIX 侧必须保住可执行位：`git ls-files -s bin/gmd` 应是 `100755`，否则 Linux/macOS 克隆下来 `./bin/gmd` 会 Permission denied（用 `git update-index --chmod=+x bin/gmd` 修）。
- **Q：`read --block b1` 用 `--json` 和不加 `--json`，返回的块集合一样吗？**
  A：**一样**，都是只含 `b1`。这是刻意统一的：`--json` 与冲突视图共用一个 `selected`。若两者不一致，用 `--json` 的 AI 会拿到整篇文档的判定，而人看到的只是一块 —— 同一命令两个口径，属于必须避免的歧义。退出码则统一按**整篇文档**算（有 error 块仍是 3）。
- **Q：`--input -` 的 stdin 怎么读？**
  A：`readAllStdin()` 收集 `process.stdin` 的 data/end 事件拼成 UTF-8 字符串。测试/嵌入场景可不走 stdin，直接通过 `runCli(argv, {stdin})` 注入文本。缺省（不传 `--input`）则读 `edit` 生成的草稿路径。
- **Q：`log --range` 的参数错误与"环境错误"怎么分开？**
  A：`a>b` 或 `a<1` ⇒ **参数错（码 1）**（在校验阶段直接拒）；`b > 当前文件行数` ⇒ **降级**（不调 `-L`，列出全部提交并标注）；而 `git` 子进程**非零退出/超时**（含 128）⇒ **统一码 5**（打印 stderr 首行）。三者在代码里是三个不同分支。
- **Q：`--path` 在 `commit` 里是什么意思？和 `log --path` 是同一个东西吗？**
  A：**同一个名字、两种动作**。`log --path <src>` 是"查这个来源的提交历史"；`commit --path <src>` 是"把这一版的引用**改指**到这个来源"（阶段 4·2 的重绑定，配合 `--range` 一起用，单独给也行）。取值的合法性判定是共用的一份（`isRepoRelativePath`），所以两处的错误码一致。这样安排是为了让 AI 只学一套路径口径 —— 但**动作方向（读 vs 写）必须先想清楚**，这也是我们特意在 README §4.6 与 `commit.md` 里各写了一遍的原因。
- **Q：为什么"选项不属于该子命令"要报错，而不是宽容地忽略？**
  A：因为静默忽略会产生**看不出错误的结果**：`read --range 1..2` 若被忽略，返回的是整篇的正文与**整篇的严重度**，调用方以为只看了两行 —— 这种偏差不会在任何输出里露出来。宽容在这里不是"用户友好"，是"用错误的结果骗人"。报错则一步到位（码 1 + 到底哪个选项不支持）。反过来说，同一套理由也解释了为什么 `--path` / `--range` 在 `log` 与 `commit` 下都保留原名 —— **名字共用可以，语义必须各自写清**。
- **Q：为什么 `read` 在存在 error 块时返回 3 而不是 0？**
  A：0 表示"全部可用"，3 表示"读到了内容但有必须重写的片段"。脚本据此分支：`0` 直接用、`3` 走重写流程。这正是"让 AI 多快好省"的接口设计。
- **Q：参数解析为什么手写而不引库？**
  A：零依赖硬约束（handoff §2.3）。且本题选项集很小（5 个开关 + 6 个取值），手写约 40 行即可，行为完全可控、错误信息可定制。
