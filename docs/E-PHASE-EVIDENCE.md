# 稳定 `X-Conversation-ID` 的真实上游单变量对照：证据与复现工具

这份文档把一组**可离线复算的真实上游对照实验读数**和**复现它的工具**交给维护者与第三方，
目的是让「稳定 `X-Conversation-ID` 与隐式前缀缓存命中之间的关系」这件事可以被独立复核。

先说清楚它**不是**什么：

- 它不是对 `stableConversationId` 开关（PR #260）的收益背书，也不改动那个开关的默认值。
  开关仍然**默认关闭**、默认行为零变化；本 PR 不改任何 `src/`。
- 以下所有命中率读数都是**报告者在本机、指定构建/账号别名/模型/时间窗口下的实测**
  （即 `docs/WINDOWS.md` §2 所说的「报告者实测、本插件/维护者尚未独立复现」）。
  它们**不构成机制证明**，也**不能外推到其它账号、模型、端点或时间窗口**。
- 它不把结论从 C 档自动升成 A/B 档：升档需要维护者或第三方按本文步骤独立重跑并核对。
  这份 PR 提供的是「让独立复核变得可能」的证据链与工具，不是复核本身。
- 端到端完整链路（安装 / 重载 / DSH→bili→插件→网关）验证**没有完成**，不在本文结论内。

---

## 1. 为什么做这个对照

插件默认对每个 chat 请求现生成一套 conversation / request / message id
（见 `conversationHeaders`）。在排查某次长会话命中率偏低时，报告者怀疑**每请求更换
`X-Conversation-ID`** 是相关因素之一；但观察性的缓存统计里混杂了模型切换、前缀改写、
断流、TTL 淘汰等变量，无法单独归因。

PR #260 落地的是一个**默认关闭**的 opt-in 开关，让「稳定 id」这件事可以被单变量地打开/关闭，
但按 `docs/WINDOWS.md` §2 的 C 档规则，feature PR 本身「不附带任何命中率实测结论」。
于是需要一个单独的、纯工具 + 研究证据的 PR：把「打开 vs 不打开」放到同一套受控请求里对照，
并把读数以可复算的字节形式归档，供他人独立核对。这与 PR #249
（`prompt cache` 重算审计与网关实测脚本）的形态一致：只加 `scripts/` + `tests/` + `docs/`，
不动 `src/`。

## 2. 实验设计（预注册、冻结，自包含复述）

两臂除了 `stableConversationId` 之外完全一致；每臂各用一份**逐字节固定、且两臂互不相同**
的长前缀，逐轮重发，统计 warm 轮的命中率。关键冻结参数如下（这些值同时写在证据 JSONL 的
首行 `meta` 里，可对照核验）：

| 参数 | 值 |
| --- | --- |
| 账号 / 模型 / 端点 | 别名 `账号A` / `hy4free` / `cn-chat-v2` |
| 线级画像 | `wireProfile: balanced`、`usageIdentity: false` |
| 前缀 | 每组一份全新随机冷前缀（`FILLER.repeat(420)`，约 10k token，约 38220 字符），两臂 body 故意不同、共享 system head |
| 每组请求 | 12 发 = 2 冷启动 + 10 warm（每臂 1 冷 + 5 warm），OFF/ON 顺序按 `mulberry32` 随机化、串行发出 |
| 正式实验 | 20 组 × 12 = 240 发；总预算上限 300 发 |
| 随机种子 | 预实验 `7`（5 组，不进统计）；正式第一批 `20261113`、第二批 `314159265` |
| 单发上限 | `maxTokens: 16`，`requestTimeoutMs: 180000` |
| 停止条件 | 401/403/429、连续 3 次 `!complete`、wiring 违规、预算封顶或撤回；**保留不完整数据 → `DATA INCOMPLETE` / `NOT_EVALUATED`，不无上限补跑、不删不利结果** |
| 预注册判据 | `D = R_ON − R_OFF`，`R = Σhit / Σ(hit+miss)`（仅 warm 完整轮）；20 组全完整 + wiring PASS 才评估；组级配对 bootstrap 10000 次取 95% 区间；`ciLow > 0` 且 `mean(D) ≥ 0.20` 才判 `BENEFIT_SUPPORTED` |
| 凭证 | 只读本机 vault 明文，绕开会写 `.lock` 的 store 解析；设备盐只读；唯一写入是 `--out` 指向的 JSONL；从不打印 token / 账号 / 正文 |

计划正文的字节哈希 `frozenPlanHash = 313aa68204b04cdec237c63009dda8d23f70e86c04284554e1dce1862d9de4ff`
由驱动在运行时对计划文件取 sha256 写入每条证据的 `meta.e.frozenPlanHash`。**计划正文含内部
授权叙事与仓库外文档指针，未纳入本公开仓库**；本节的表格已把可复核的关键参数自包含地复述，
`meta` 行还带有完整 240 发的 plan 与 wiring 快照，足以重建实验清单。

## 3. 证据文件与哈希核验

```
evidence/
  batch-1/  formal-20groups.jsonl  pilot-5groups.jsonl
            smoke-initial.jsonl  smoke-after-adapter.jsonl  SHA256SUMS.txt
  batch-2/  formal-20groups.jsonl  smoke.jsonl  SHA256SUMS.txt
```

每行 JSONL 是一条请求记录，只含脱敏后的别名、计数器与 wiring 断言；序列化器显式禁止写出
`message` / `body` / `headers` / `sseText` / `rawError` / `credential` / `token` 等字段。
两个 `SHA256SUMS.txt` 只列本 PR 实际附带的 `.jsonl`，可自行核验字节：

```console
(cd evidence/batch-1 && shasum -a 256 -c SHA256SUMS.txt)
(cd evidence/batch-2 && shasum -a 256 -c SHA256SUMS.txt)
```

全部 6 个 `.jsonl` 与两份 `SHA256SUMS.txt` 都过了 `node scripts/check-pii.mjs --stdin`，
没有真值账号、机器、路径、会话 / 设备 id 或邮箱。

## 4. 两批结果与离线复算（如实各报各的，不合并不择优）

复算是纯离线的，不联网、不读凭证：

```console
node scripts/recompute-probe-real.mjs --in evidence/batch-2/formal-20groups.jsonl
node scripts/recompute-probe-real.mjs --in evidence/batch-1/formal-20groups.jsonl
```

| | 第一批（seed `20261113`） | 第二批（seed `314159265`，全新独立重跑） |
| --- | --- | --- |
| 记录 / 完整 | 240 / 239（`incomplete=1`） | 240 / 240（`incomplete=0`） |
| 完整组 | 19 / 20 | 20 / 20 |
| wiring | PASS | PASS（240/240、ON 键 120/120 匹配、OFF 每请求新 id、其余 id 每请求新生成） |
| 数据状态 | `DATA INCOMPLETE` | `DATA COMPLETE` |
| 效应状态 | `NOT_EVALUATED`（**未输出任何收益结论**） | `BENEFIT_SUPPORTED` |
| `mean(D)` / 95% CI | 复算内部值，因不完整**不作为判据** | `0.9136` / `[0.8726, 0.9538]`（即 91.4 个百分点 / `[87.3, 95.4]`） |
| `MECHANISM_PROVEN` | `false` | `false` |
| 退出码 | 2 | 0 |

第一批第 13 组因一次孤立的 `NETWORK_ERROR` 导致 ON 冷启动轮不完整；按预注册停止条件，
它保留为 `INCOMPLETE` 并判 `NOT_EVALUATED`，没有补跑、也没有删掉这条不利数据。
第二批是**另起炉灶的全新独立重跑**（不同种子、不同冷前缀），不是对第一批的修补；两批并列报告，
不合并、不择优。

第二批复算打印的 CONCLUSION 原文（作为实测读数引用，不作插件官方结论）：

> 在指定构建、账号别名、模型、时间窗口和冻结实验计划下，20 个独立冷前缀组的
> warm 命中率配对平均差为 91.4 个百分点，95% 区间为 [87.3,95.4]。结果支持稳定
> `X-Conversation-ID` 在这些条件下改善命中。真实上游实验（E 阶段）RUN。该实验不能
> 区分缓存键分区与路由亲和等内部机制，也不能外推所有账号/模型；不得据此声称已
> 厘清缓存键的分区方式。

`MATCH_LIVE_REPORT true` 表示离线复算与当时在线生成的报告一致，即证据内部自洽；
它**不等于**维护者已独立复现。

## 5. 如何复现

工具分两层：离线层（零网络、零账号、零 build 依赖）与真实上游层（需要凭证、消耗少量额度）。

**离线层**（`probe-core.ts` 是零 import / 零 I/O 的纯函数；`recompute-probe-real.mjs`
只从 JSONL 的 `meta` 取哈希，不读任何计划文件）：

```console
node scripts/recompute-probe.mjs --self-test                    # 合成自测（不代表真实收益）
node scripts/probe-stable-conversation-id.mjs                   # 无 flag 时 STATUS NOT_RUN，零网络零写
node scripts/recompute-probe-real.mjs --in evidence/batch-2/formal-20groups.jsonl
```

**真实上游层**：`scripts/probe-stable-conversation-id-real.mjs` 对 `lib/index.js` 的依赖是
**门控之后的动态 `import()`**（PR review #262 中-2 修正；此前为顶层静态 import）：未授权
路径在任何 checkout 上都直接可跑，不需要构建产物；授权后若 `lib/` 缺失则以固定类别码
`STATUS LIB_UNAVAILABLE` 失败，零路径泄漏。真实复现前仍需 `pnpm run build`（这是
PR #249 里 `probe-mid-convo-system.mjs` 的既有惯例）。构建之后：

```console
pnpm run build
node scripts/probe-stable-conversation-id-real.mjs --synthetic   # 合成 fetch 全流水线自测，不联网
```

真实对照由 `--real --e-phase-authorized` **双 flag 门控**；缺任一 flag 时打印
`STATUS NOT_RUN` / `EXIT 3`，零网络、零凭证、零写入——该判据现在由 `main()` 与
`runExperiment()` **各自独立**从参数推导（低-6：库级入口不接受调用方直送 `network:true`），
并由 `tests/probe-real-gate.spec.ts` 在无构建、无凭证、无网络环境下钉住。两个 flag 都给
才会读取本机凭证：`--account-id <24位hex>` 显式指定 vault 账号文件，**多账号且未指定时
拒绝运行（`STATUS CREDENTIAL_AMBIGUOUS`）而不是默默取目录第一个文件**（中-1；实际选档方式
记入 `meta.e.accountResolution`）；单账号可省略。随后按冻结参数发真实上游短请求（消耗少量
额度）。凭证路径、设备盐与输出 JSONL 全部只读 / 只写 `--out`，从不打印 token。新增防护测试
`tests/probe-core.spec.ts`、`tests/probe-real-adapter.spec.ts`、`tests/probe-real-gate.spec.ts`
只依赖 `scripts/`，不碰 `lib/`，所以 `pnpm run test` 在无构建产物时也能跑。

## 6. 口径与限定

- **默认不变**：`stableConversationId` 仍默认 `false`，本 PR 不改 `src/`、不请求改默认值、不请求发版。
- **机制免责**：`MECHANISM_PROVEN false`。实验只能说「在这些条件下稳定 id 与更高命中相关且配对差为正」，
  不能区分上游是按 conversation id 分区缓存、还是路由亲和、还是两者兼有，更不证明某种内部实现。
- **不外推**：单一账号别名、单一模型 `hy4free`、单一端点 `cn-chat-v2`、特定时间窗口与构建。
  其它账号 / 模型 / 端点可能不同（仓库既有 `docs/CACHE-HIT-70-RESEARCH.md`、`docs/CACHE_EVIDENCE.md`
  记录了不同模型读数差异）。
- **两臂前缀故意不同**：OFF / ON 各用一份独立冷前缀，统计的是「同一前缀逐轮重发」下的 warm 命中，
  不是「两臂请求体相同」；共享 system head 是已知限制。
- **完整链路未跑**：安装 / 重载 / DSH→bili→插件→网关 的端到端验证（阶段 F）**未完成**
  （官方安装被 `already-installed` 挡回、profile 未改动、端到端六项验证未执行）。另有一次本机
  完整链路的现场观测因含会话 id 真值，**未纳入本公开 PR**，也不作为本文结论。
- 按 `docs/WINDOWS.md` §2，这批读数仍是「报告者实测、本插件未复现」；把 C 档结论升到
  可改默认值的 A/B 档，需要维护者 / 第三方按第 5 节独立重跑并核对。

## 7. usage 双字段为什么需要适配

网关终态 usage 有时会同时给出规范对 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
（例如 `7936 / 112`，`prompt_tokens = 8048`）**和**一个恒为 `0` 的顶层 `cached_tokens`。
`probe-core.ts` 的 `normalizeUsage` 取 `cached = cachedTop ?? cachedDetails`，顶层 `0`
会优先命中，于是 `hitSources = [7936, 7936, 0]` 触发 `HIT_SOURCE_CONFLICT`、
`cpRate = 0` 与 `hmRate = 0.986` 触发 `RATE_CONFLICT`，warm 轮被误判为 `valid=false`。

`scripts/probe-usage-adapter.ts` 的 `adaptTerminalUsage` **只在**规范 hit/miss 都是有限 number 时，
删掉那个冗余顶层 `cached_tokens`，对 OFF / ON、cold / warm 一视同仁，不动 `details`、不动护栏。
`tests/probe-real-adapter.spec.ts` 把 `cached = cachedTop ?? cachedDetails` 这条取数逻辑钉住，
防止适配悄悄放宽；`7936 / 112 / 8048 / 0.986` 全是「同真实 schema 的合成计数器」，不是真值数据、
也不是收益结论。

## 8. 关于脚本注释里的遗留内部指针与 `scriptHash` 记账

随附的 `scripts/` 与 `tests/` 为保持证据链字节一致**全部保留原字节**（REAL 驱动的
`scriptHash = ff95a3cce56fc0cdea29dd0b1665e90a7b3fc4f4762b1caf88f5d849808fd140`
覆盖 `probe-stable-conversation-id-real.mjs` + `probe-usage-adapter.ts` 两文件的排序拼接，
与两批证据 `meta.scriptHash` 一致；改这两个文件会让证据无法复算对齐）。

**PR review #262 的修正改动了一次 `scriptHash`，如实记账如下。** 驱动按评审要求修复
中-1（账号选择拒绝默默取第一个文件）与中-2（lib 静态 import 移到门控之后）后，
`probe-stable-conversation-id-real.mjs` 的字节变了，新的
`scriptHash = 0a0d301eedb8ef9cb3e1a9fc411888b4183e54e46a41733f752d24e44d4c09b7`。这不破坏既有证据的复算：`scripts/recompute-probe-real.mjs` 是**从 JSONL `meta` 里回显
的 `scriptHash` 与重算 report 比对**，证据文件本身仍是旧字节、`--synthetic` 冒烟输出的
新哈希只是「当前驱动」的指纹，两批 `evidence/*.jsonl` 的重算结论（`CONSISTENT` /
`NOT_EVALUATED`）一字未变。若日后要以新驱动**重跑**真实对照，产出的证据必须记新哈希，
与旧两批并列各报各的，不得混批。**证据文件与 `probe-core.ts`、`probe-usage-adapter.ts`
本次未改动。**

因此源码注释里仍留有对「验收方案 §x」「`docs/E-PHASE-FROZEN-PLAN.md` §11」
「`docs/PROBE-OFFLINE-TESTS.md`」等**本 PR 未附带、且部分在仓库外**的历史内部指针，
以及 `B6 场景①…⑬` 之类的内部测试编号标题。它们只是注释、不影响运行与复算；
**本自包含文档是本次 PR 的权威说明**，复现请以第 2、5 节为准，不必去找那些历史文件。

## 9. 隐私

本仓库公开且发 npm。证据 JSONL 在归档时已脱敏：账号一律 `账号A`、会话 / 设备 id 一律别名、
无本机路径、无邮箱、无 uin / uid、无明文凭证或正文。落地后对全部附带文件跑过
`node scripts/check-pii.mjs --stdin`，结果全为 `clean`；提交前同样会对完整 diff 跑一次门禁。
