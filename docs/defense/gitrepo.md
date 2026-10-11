### 模块：git 适配层 `src/gitrepo.ts`

**1. 这段在干什么（一句话）**
用 `node:child_process` 调系统 `git`（异步 spawn + 15s 超时 + `-C <repo>`），并提供**唯一一份**换行归一化 / 范围摘要 / 正文摘要 / 范围脏检查实现，以及仓库定位、工作区读取、提交历史查询。

**2. 关键设计决策 + 为什么这么做**

- **零依赖：调系统 `git`，不用 libgit2/isomorphic-git**。`git` 本就是题面预设环境（"通过 `--repo` 定位 Git 仓库"），调它 = 零库依赖 + 语义（`show`/`log -L`/`rev-parse`）与用户认知完全一致。
- **一律 `git -C <repo>`，绝不依赖 `process.cwd()`**：否则 `--repo` 选项形同虚设（在 A 目录跑却想操作 B 仓库时会错）。这是 PLAN §2.1 的硬要求。
- **一律 15s 超时**：`setTimeout` 到点 `child.kill()`，把"超时"标成 `timedOut=true` ⇒ 上层映射退出码 5（环境错误），不静默当成"没有变化/没有提交"。
- **用异步 `spawn` 而非 `spawnSync`**：本机实测 `spawnSync` 直接 `EBUSY` 失败（见 `docs/notes-plan-conflicts.md` §3.1）；异步通道没有这个限制，且天然支持超时。
- **三份"唯一实现"（`normalizeEol` / `hashRange` / `textHash`）集中放这里**：fixture 脚本（算 `src_hash`/`text_hash`）与判定引擎（比对）**必须调同一份**。若各写一份，`core.autocrlf=true` 时 CRLF/LF 口径不一致会把所有块误判成变化（PLAN §4.3 反复强调的坑）。
- **`isRangeDirtyTexts(nowText, headText, range)` 两边都先经 `hashRange` 归一化再比**：⇒ **换行差异（CRLF 工作区 vs LF HEAD）不构成 dirty**。否则 `git show HEAD:` 给 LF、工作区是 CRLF，会对每个块都判"脏"⇒ 永远 `warning + 不可写回`。
- **`decodeStrict`（`TextDecoder('utf-8',{fatal:true})` + 拦 NUL）**：题面"元数据无法解析必须报错"。非 UTF-8 / 二进制来源明确报错，不用替换字符静默降级。
- **`showText` 返回 `null` 表示"该 (commit,path) 取不到"**，与"git 自身故障（抛 `GitError`）"分开：调用方才能区分"路径不在这个提交里"和"git 坏了"。

**3. 可能被追问的问题 + 要点**

- **Q：`git show HEAD:<path>` 失败时，怎么区分四种情况？**
  A：`showText` 只回 `null`（取不到）。判定引擎再组合判断：① 工作区存在 + HEAD 取不到 ⇒ 新增/未跟踪 ⇒ 视为**未提交**（dirty）；② 工作区也不存在 + `git log --all -- <path>` 有记录 ⇒ "引用目标已被删除"；③ 从未出现 ⇒ "引用目标不存在"；④ `showText` 抛 `GitError`（超时/异常）⇒ 冒泡到 §4.4 记 `error("判定失败…")`。
- **Q：`log -L a,b:<path>` 什么时候会失败？为什么 `--range` 要先判越界？**
  A：`b > 当前行数` 时 git 会 **`fatal` 退出（码 128）**，不是空输出。所以 CLI 先比 `range[1] ≤ countLines(文件)`：越界就**不调 `-L`**，降级为"列出该文件全部提交并标注越界"。任何 git 非零退出都映射为**退出码 5**（打印 stderr 首行），不当成"没有提交"。
- **Q：`countLines` 为什么不是 `split('\n').length`？**
  A：那样会把**尾随换行**多算一行，导致 `range[1] == 真实行数 + 1` 被误判为"未越界"，进而去调 `-L` 触发 `fatal`（本该降级却变成环境错误 5）。所以按 git 口径：**尾随换行不算一行**。
- **Q：超时之后子进程真被杀掉了吗？会不会留下僵尸？**
  A：`setTimeout` 里调 `child.kill()`；`close` 事件最终触发并 resolve（`settled` 保证只 resolve 一次）。git 是短命进程，`SIGTERM` 足够。注意 Windows 下 `kill()` 语义与 POSIX 略有差异，但对本题的只读查询命令无实际影响。
- **Q：`findRepoRoot` 为什么用 `existsSync('.git')` 而不是 `git rev-parse --show-toplevel`？**
  A：两者都可，但 `.git` 存在性检查**不启子进程**、更快、且在"`--repo` 指向子目录"时能稳定向上找到根。真正的 git 合法性由后续命令的退出码兜底（不是仓库 ⇒ 退出码 5）。
