### 模块：fixture + 测试 + 演示（`scripts/setup-fixtures.ts` · `tests/` · `demo/`）

**1. 这段在干什么（一句话）**
`scripts/setup-fixtures.ts` 幂等重建一个**可复现**的测试 git 仓库（`fixtures/repo`）；`tests/` 用 `node:test` 覆盖 PLAN §8 验收；`demo/stage1-2.ts` 与 `demo/warning-loop.ts` 一键跑通阶段 1+2 与阶段 3 闭环。

**2. 关键设计决策 + 为什么这么做**

- **幂等 = 第一件事 `rm -rf fixtures/repo` 再重建。** 绝不往旧仓库上叠提交，否则重跑一次就多一次 commit、sha 全变、用例必红（PLAN §7 / §8 用例 0）。
- **commit sha 可复现 = 注入固定 `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` + `-c core.autocrlf=false`。** 同一次内容 ⇒ 同一个 sha。演示/测试里"改来源后的 commit"也走同一个 `commitAll(repo, msg, date)`。
- **`src_hash` / `text_hash` **实测**、绝不手写**：脚本调用的就是判定引擎用的同一份 `hashRange` / `textHash`（`src/gitrepo.ts`）。手写 hash 一跑用例就红。
- **测试隔离 = 模板 + 克隆**：模板仓库只建一次，之后每个用例 `git clone` 一份到独立临时目录 ⇒ 用例之间互不污染（它们是"改源文件 / 删文件 / 造脏工作区"的，不能共用一份）。用 `git clone` 而非 `cpSync`，是因为 Windows 上 `.git` 对象常带只读属性，拷贝后可能被后续 `git commit` 拒绝。
- **用例 0 是前置条件**：凡是"改源文件"的用例（3/5/7/13/16）**必须先提交**，否则 §4.3 步骤 3 的 dirty 闸门会把结果截成 `warning`；只有用例 6/14/23 保留未提交态。测试里统一用 `commitAll` 保证这一点。
- **演示脚本自己完成 `git commit`**：题面阶段 3 要"AI 无人工干预"，而写回校验在来源 dirty 时默认拒绝 ⇒ 一个真正的自动闭环**必然包含"先把来源改动提交为正式版本"**。**"脚本自动 commit"不算人工干预**（只有"人手动敲命令/改文件"才算）。

**3. 可能被追问的问题 + 要点**

- **Q：`fixtures/repo` 为什么整目录 `.gitignore` 掉、不入库？**
  A：它是**脚本现场生成的内层 git 仓库**。提交它 ① 会与脚本悄悄漂移（改了脚本但忘了重生成），② 父仓库会把内层 `.git` 记成 **gitlink**（一个 commit 指针），克隆方**拿不到任何文件**，反而把"可复现"做成"不可复现"。故整目录排除，评审跑一条 `scripts/setup-fixtures.ts` 即可现场重建（含受控的提交历史）。
- **Q：`git clone` 出来的仓库，commit sha 和模板一致吗？**
  A：一致 —— clone 复制的是同一批对象，sha 只由内容+父提交+固定时间戳+提交信息决定。用例里断言"克隆后仍能读到 `step 0: 来源文件`"就是验这一点。
- **Q：演示脚本为什么自己重建 fixture？**
  A：为了让 §9 的"一键跑通"**可反复执行**（跑两次结果一致）。虽然文档仍建议先跑 `setup-fixtures.ts`（等价、无害），但 demo 自带重建能消掉"忘了先建仓 ⇒ demo 直接失败"这个最常见的翻车点。
- **Q：测试用例为什么大多在 15 秒上下？**
  A：每个用例都要 `git clone` 一份仓库 + 若干次 git 调用，而本机 git 子进程启动开销较大（且必须是异步 spawn）。这是隔离性换来的成本，可接受；`--test` 会并行跑各文件。
- **Q：环境里 `spawnSync` 失败、`rmSync` 被护栏拦，会不会影响评审？**
  A：不会。`spawnSync` 是本机沙箱特有的问题，实现**已统一改用异步 `spawn`**（反而更稳）；`rmSync` 护栏是"批量删除确认"型沙箱护栏，普通机器没有。两者都记录在 `docs/notes-plan-conflicts.md` §3 与 README「环境注记」。
