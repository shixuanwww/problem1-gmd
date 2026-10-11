### 模块：数据契约 `src/types.ts`

**1. 这段在干什么（一句话）**
定义 `.gmd` 的全部数据结构（文档头、片段、版本、判定结果、变更点）与一个带行号的格式错误类 `GmdFormatError`。

**2. 关键设计决策 + 为什么这么做**

- **只放类型 + 一个错误类，不放逻辑**：因为 `node --experimental-strip-types` **只做类型擦除**。纯类型接口在编译期整体消失，运行期零开销；只要文件里没有值级的复杂语法就不会擦除失败。
- **`export interface` 而不是 `type`**（对结构体）：可被 `import type` 精确引入，语义更清晰。
- **没用 `enum`**：`Severity` 写成 `'ok' | 'warning' | 'error'` 的字符串联合类型。原因有二：① type stripping 不支持 `enum`（需要运行期对象）；② 字符串联合在 `--json` 输出里**天然就是可读字面量**，不需要映射表。
- **`GmdFormatError` 带 `line`**：题面要求"格式损坏或元数据无法解析必须报错"，且 PLAN §4.1 要求"指出出错行号"。把行号做成错误对象的一等字段（而不是拼进 message），CLI 才能稳定地渲染 `错误：<message>（第 <line> 行）` 并映射退出码 2。
- **`BlockJudgement` 的字段直接对齐题面语义**：`severity/dirty/writable/changes/currentSource` 不是内部实现细节，而是**给 AI 读的对外契约**（`--json` 原样输出）。

**3. 可能被追问的问题 + 要点**

- **Q：`rev` 为什么必须从 1 起且连续？**
  A：`rev = hist 下标 + 1`。它既是对外展示的版本号，也是 `hist` 数组的**自校验位**：解析时 `rev !== index+1` 直接判格式损坏。这样能挡住"手工删掉中间一条历史"造成的静默错位 —— 而题面要求"历史只追加，不覆盖不删除"，`rev` 可充当这一约束的守卫。
- **Q：`text_hash` 和 `src_hash` 有什么区别，为什么不合并？**
  A：`src_hash` 是**来源侧**（`v.range` 内的源码文本），用于判断"来源还准不准"；`text_hash` 是**文档侧**（本片段正文），用于步骤 0 发现"手改正文却不追加版本"。两者是正交的：来源可能没变而正文被手改（应判 `error`），正文没动也可能来源变了（应判 `warning`/`error`）。
- **Q：`BlockJudgement.source` 为什么只带 `path/range/commit`，不把 `at`/`src_hash` 也带上？**
  A：对外"溯源三要素"是**在哪、引用哪一段、基于哪个提交**；`at`/`src_hash` 属于版本内部账目，放在 `log --block --json`（`versionToJson`）里给，避免 `read` 的输出膨胀。需要时一条 `gmd log` 就能拿到完整 `hist`。
- **Q：`GmdFormatError` 和其他错误（如 `GitError`）如何区分？**
  A：按类型分派退出码 —— `GmdFormatError`→2（格式损坏）、`CommitRejected`→4（写回被拒）、`GitError`/`SourceEncodingError`→5（环境错误）、其余参数类→1。见 `src/cli.ts` 的 `catch` 段。
