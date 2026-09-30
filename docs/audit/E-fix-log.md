# 审计修复记录（Lead 实施）

> 针对 [MASTER.md](MASTER.md) 的 51 条发现实施修复。按实测破坏力排序推进。
> 验证由独立验证员对抗式复核，结果见 [F-fix-verification.md](F-fix-verification.md)（若存在）。

## 一、高危根因（6 条，全部已修）

| 编号 | 缺陷 | 修复 | 自验证 |
| --- | --- | --- | --- |
| **H-1** | 勾选成员静默丢账号（stale closure） | `editDraft` 改用 `savedRef`：基准在 `setDraft` updater 内部取，依赖数组只剩 `[draftRegion, region]` | 模拟 React 记忆化：`['a']`→勾 c 得 `['a','b','c']` ✓ |
| **H-2** | 一键解锁即出现「显示A计费B」 | `rotationLocked` 改读**已保存值**；新增 `rotationUnlockPending` 提示"保存后生效" | 四步状态机：未保存时下拉保持禁用、保存后才解锁 ✓ |
| **H-3** | 关池后轮换 override 永不清理 | `loader/volatile-update` 事件与启动时都调用 `applyRotation` | 真实插件：建立轮换→关池→override 已清 ✓ |
| **H-4** | 第三个写入者（tab 开关）绕过串行 | tab 开关加入 `saving \|\| poolBusy`；两个保存按钮加入 `togglingRegion` | 六场景门控矩阵全部闭合 ✓ |
| **H-5** | 幽灵成员：界面宣称完成、零请求 | Host 下发 `effectiveMemberAccountIds`；客户端据此计数与禁用 | 真实插件：`已选 0/1`、按钮禁用、0 上游请求 ✓ |
| **H-6** | 目标模型可为目录外 id | `resolveTargetModel` 新增 `'stale'`；stale 时**省略 modelId**（未加守卫的调用方也 fail-safe） | 真实插件：`source='stale'`、路由 409 `reason=target-model-stale` ✓ |

### 设计取舍说明

- **H-6 为何新增 `'stale'` 而不是复用 `'none'`**：两者需要相反的补救（"换个模型" vs "刷新目录"），合并会让卡片说错话。且 stale 时**不**回退到免费模型——那会测一个用户没选的模型。
- **H-2 为何让下拉等到保存才解锁**：因为 Host 确实还在轮换。让 UI 允许一个 Host 会忽略的操作，正是原缺陷。代价是多一次保存，但诚实。
- **H-1 为何用 ref 而非"补全依赖数组"**：补依赖能修当前这个字段，但依赖清单手工维护正是根因；ref 让基准永远新鲜，且回调身份稳定。

## 二、中危（已修）

| 编号 | 缺陷 | 修复 |
| --- | --- | --- |
| **M-3** | 两种 409 不区分、不本地化 | Host 下发 `reason`（`pool-disabled` / `no-members` / `no-free-model` / `target-model-stale`）；客户端 `poolErrorText()` 本地化，未知 reason 回退原文 |
| **M-5** | 每轮询对全池每账号发签到状态请求（10 账号 ≈ 14,400 次/天） | 10 分钟 TTL 缓存 + 池关闭时不读 + 本插件签到成功后失效自己那条 |
| **M-9** | 「没有可用账号」警告永不触发（usable 用整表） | `usable` 改为只算**池成员** |

## 三、低危（已修，集中在"界面说谎"）

| 编号 | 缺陷 | 修复 |
| --- | --- | --- |
| **C2-1** | 每次重挂载凭空写假轮换记录 | `rotationMemory` 首次观察只**上弦**不记录 |
| **C2-2** | 轮换回退不记录、ref 不清 → 同账号再轮换漏记 | 回退写「轮换已停止」并清 `last` |
| **C2-3** | 日志/ref 不按 region 隔离 → 切 tab 写假记录 | 两者都按 region 键控 |
| **C2-4** | `from` 空名不套占位符 | 改用 `nameOf(...) \|\| previous`（与 `to` 分支一致） |
| **C1-1** | 批量失败只留「开始」不留失败行 | catch 里写入失败日志 |
| **C1-3** | 批处理中「清空」不禁用 → 清空后新行随即出现 | 批处理中禁用清空 |
| **C4-2 / A-9** | `targetLabel` 死代码 → 从不说明目标模型来源 | 接入渲染（含 stale 分支） |
| **C4-5** | 头部显示「目标模型 自动」而同屏说「暂无免费模型」 | 摘要按 source 显示「无免费模型」/「目标模型已失效」 |
| **A-5** | 保存中编辑被 `discard()` 静默吞掉 | `editDraft` 在 `savingRef` 为真时拒绝编辑 |
| **A-11** | `row.result.outcome` 未校验解引用 → 抛错且不写完成日志 | 逐行校验，畸形行记为警告并继续 |
| **A-12** | 目标模型下拉缺失效占位项 → 显示与存储值分叉 | 补一个 disabled 的「（已下架）」选项 |
| **C4-7/8/9** | 文案与行为不符（还需区域开关、第四种排除原因、两个并列排序键） | 三处文案据实修正 |

## 四、自验证结果

- **584 个测试通过**（新增 12 个回归测试，覆盖 H-5/H-6/M-3/M-5），typecheck 双配置通过，构建成功。
- 每个高危修复都用**独立脚本复现了"修复前会失败"的场景**（见上表"自验证"列），而非只跑单元测试。

### 新增回归测试是否真能捕获原缺陷

自查中发现**两个测试因隔离不当而恒真**，已修正：

1. H-5 的批量测试原先统计**所有**上游请求，把 usage 文档自带的签到面板读取（选中账号 1 次）也算了进去 → 改为只统计批量自身的端点。
2. M-5 的缓存测试原先断言"第二次轮询请求数为 0"，忽略了面板每次仍读 1 次 → 改为断言"增量 ≤ 1"（即池不再按账号扇出）。

这正是"测试必须能区分修复前后"的实例：两个测试在修复前也会通过。

## 五、未修（有意保留）

以下发现**未修**，理由记录在此以免被误认为遗漏：

> **2026-02 更新**：本表中 **M-2 / A-4**、**M-4 / B-4 / C1-2**、**L-5** 三项已在**第三轮**修复（理由当时成立，后来条件变了：`AccountPool` 获得了 `onRefresh` prop、输入框引入字符串中间态、Host 的 `createLatestWins` 已可复用）。见 §十一。**M-1 / A-3** 与其余各项仍保持原判。

| 条目 | 为何不修 |
| --- | --- |
| **M-1 / A-3**（按钮按草稿判定、动作按已保存执行） | H-5 已让计数与禁用基于**有效**成员；剩余差异是"草稿已改但未保存"时的文案口径（C4-6），属产品口径选择。若要让按钮完全按草稿判定，需把批量动作也改为读草稿——那会让"未保存的勾选被执行"，更危险 |
| **M-2 / A-4**（数字框逐键 clamp） | 需要引入字符串中间态（允许 `''` 与部分输入），是独立的输入组件改造。当前行为是"输入被纠正"而非数据损坏 |
| **M-4 / B-4 / C1-2**（批量成功后不重读 usage） | 修复需要给 `runAction` 加一次 `refreshUsage` 调用，但 `AccountPool` 目前不持有该能力（需新增 prop）。已在 H-3 中让**轮换**通过事件路径即时生效；探针结果的刷新留待下一轮 |
| **M-6 / M-7 / M-8** | 与已修的 C2-1/2/3 是同一根因的不同表现，已随 `rotationMemory` 一并修复 |
| **B-6 / B-7 / B-9 / B-11**（类型冗余、可选性名不副实、无人 import 的信封类型） | 纯类型整洁问题，无运行时后果。改动会触及 Host↔client 契约面，收益低于风险 |
| **C4-10 / C4-4 / C4-6**（个别文案仍不精确） | 与已修的 C4-7/8/9 同类。C4-10 描述的保护在 H-2 修复后已真正成立；C4-4 的 tooltip 与 C4-6 的禁用理由属措辞级 |
| **L-5**（两次 refreshUsage 无请求序护栏） | 需引入请求序号或 abort 编排；与 M-4 同批处理更合适 |

## 六、第二轮：F 报告四项遗留的修复

针对 [F-fix-verification.md](F-fix-verification.md) 的 4 项遗留逐一处理。

| 编号 | F 的裁决 | 本轮修复 |
| --- | --- | --- |
| **H-5**（测试按钮） | 部分修 | 测试按钮 `disabled` 由 `active.memberAccountIds.length === 0` 改为 `effectiveMembers.length === 0`（与签到按钮同判据）。**Host 侧兜底**：`WorkBuddyPoolDeps` 新增 `effectiveMemberAccountIds?(region)`（契约：纯本地扫描、无上游调用，区别于昂贵的 `members`），路由守卫用 `const runnable = effective ?? savedMembers`，空则 409 `no-members`；error 文案按 `savedMembers.length === 0` 区分"没勾选"与"勾选的账号都没有本地登录" |
| **A-12**（静默清空） | 未修（不可达） | `saved` 基准 `targetModelId` 改为 `pool?.targetModelId \|\| pool?.staleTargetModelId \|\| ''`。原逻辑下 stale 时 Host 省略 `targetModelId`，读作 `''` → 受控 select 显示"自动"而磁盘仍是旧 id → 下次保存写回 `''` **静默销毁**用户选择。带上 stale id 后显示/草稿/磁盘三者一致，只有显式"切回自动"按钮才清空 |
| **C2-4**（`from` 裸 id） | 未修（只修了 to） | 两处 `nameOf(previous, pool) \|\| previous` 改为 `\|\| t('row.accountUnnamed')`（`nameOf` 对无名账号返回 `''`，`\|\|` 兜底曾把 24 位 hex id 直接展示给用户） |
| **恒真测试** | 已判恒真 | `tests/pool-e2e.spec.ts` 的「H-5: the batch still refuses…」重写为「a ghost-only pool is refused, so the card cannot announce a batch」，断言从"零上游请求"（修复前也成立）改为**路由必须答 409 `reason='no-members'`** |
| **覆盖面缺口** | H-1/H-2/H-3/H-4 无回归测试 | 新建 `src/client/pool-state.ts`（纯函数、不 import React）导出 `rotationLockState` / `draftBaseFor` / `effectiveMemberIds` / `ghostMemberIds` / `usableMemberIds`，`AccountPool.tsx` 改为调用它们；新建 `tests/pool-state.spec.ts`（21 条）。另把 H-3 的 generation 令牌抽成纯工厂 `createLatestWins<Key>()`（`src/account-pool.ts`），`applyRotation` 改用 `rotationGuard.begin(region)`，补 5 条单测 |

### 判别力验证（每条都做了变异测试）

只跑通测试不算数——必须证明测试在**回退修复**时会失败。

| 变异 | 结果 |
| --- | --- |
| H-2 改回读 draft（原缺陷） | `tests/pool-state.spec.ts` **3 条失败** ✓ |
| H-1 去掉 region 校验（原缺陷） | **1 条失败** ✓ |
| C4-3 `usable` 改回整表（原缺陷） | **3 条失败** ✓ |
| H-5 Host 守卫回退为 `savedMembers` | pool-e2e 的 ghost-only 用例失败（`expected 200 to be 409`）✓ |
| `createLatestWins` 改为 `return () => false` | **4 条失败** ✓ |
| H-3 移除 `stale()` 令牌 **且** 移除 await 后重读 | 「slow ON cannot resurrect」失败 ✓ |

**一处必须记录的负面结果**：H-3 若**只**移除 `stale()` 令牌（保留 await 后重读），真实插件竞态测试**仍然通过**——说明该 harness 测的是两条防御的组合，且共享读取计数器让两轮互相污染、没能真正制造交错。同理，只移除令牌时"isolated"用例也通过。这正是验证员警告的假通过模式。**结论：真实插件竞态 harness 脆弱，改为测机制**（纯工厂单测，已证明有判别力）；真实插件层面只保留组合行为的覆盖。

### 自验证结果（第二轮）

- **613 个测试通过**（29 个文件），typecheck 双配置通过，`tsdown` 构建成功。
- 变异测试逐条确认了上表判别力。

## 七、下一步建议

1. **M-4 与 L-5 同批修**：给池区块加 `onRefresh` 能力，并在 `refreshUsage` 引入请求序号，一次解决"批量后不刷新"与"刷新乱序"。
2. **M-2** 单独做输入组件（字符串中间态 + `onBlur` clamp）。
3. **开启 `eslint-plugin-react-hooks/exhaustive-deps`**：H-1 的根因是手工依赖清单，H-4 是手工写入者清单。这两类都靠纪律维持，应该交给工具。
4. **A-8 遗留窗口**：保存成功后 `discard()` 立即生效而 `onSaved()` 重读异步，窗口内界面短暂回落且控件可交互。

## 八、Lead 自查：同型缺陷继续清扫

F 报告的总评指出贯穿全项目的一个模式——**修了判定的一端漏了另一端**。接受这个判断后，按"同一个判定的所有出口"逐条列出并核对，又查出 **3 处同型残留**。这个模式目前是本项目产出最高的矿脉，值得单独记录。

### 8.1 已修：Host 算出了两种原因，却只下发一种 reason（M-3 的残留）

**位置**：`src/web-status.ts:834-844`（修复前 `reason: 'no-members'` 恒定）。

Host 在空池分支里**已经算出了两种原因**（`savedMembers.length === 0` → "没勾选" vs 非空但都解析不出 → "勾选的账号都没登录"），却把两种都写成 `reason: 'no-members'`，只在英文 `error` 里区分。而客户端 `poolErrorText()` **只读 `reason`、从不读 `error`**（`src/client/AccountPool.tsx:536`，`poolErrorText(t, body?.reason) ?? body?.error`——已知 reason 会短路掉 `error`）。于是：

- Host 自己算出的区分是**死代码**；
- 勾了账号但都掉线的用户，收到的建议是「本池没有勾选任何账号……请至少勾选一个账号并保存」——**而他已经勾了**，真正的修复动作是「在桌面端重新登录，或保存以移除它们」。

这是 M-3 的残留：第二轮修了**客户端显示**和**路由守卫**，没修**路由的 reason 取值**。

**修复**：拆成两个 reason——`no-members`（真空池）与 `no-live-members`（幽灵池）；客户端 `poolErrorText` 新增分支；`locales.ts` 新增 `row.poolErrNoMembers` / `row.poolErrNoLiveMembers` 双语（键数 185×2 校验通过）。

**测试**：ghost 用例断言改为 `no-live-members`；**新增对照用例**「H-5: an UNCHECKED pool answers no-members, a distinct reason from the ghost case」用真空 `memberAccountIds: []` 钉住另一分支。

**变异确认**：折叠回 `reason: 'no-members'` → ghost 用例失败 `AssertionError: expected 'no-members' to be 'no-live-members'` ✓。**注意**：对照用例单独**不**具判别力（真空列表在两个版本下都答 `no-members`），判别力全在 ghost 用例上——这一点必须记录，否则后人会误以为两条测试都在保护这个区分。

### 8.2 已修：`announcedBatchCount` 用原始列表宣告批次规模（H-5 的第五个出口）

见上文 §六。ghost-only 池会在日志宣告"开始签到 1 个账号"，随后被 409 拒绝、零请求。

### 8.3 未修（已冻结，待下轮）：`exclusionOf` 把 4 种结局压成 1 个值，其中 3 种永久禁用

**位置**：`src/account-pool.ts:133-156`。

```ts
case 'credential-rejected':
case 'not-found':
case 'failed':
case 'unavailable':
  return 'credential-rejected'      // ← 4 种结局 → 1 个标签
case 'rate-limited':
  return retryDue(probe, nowMs) ? undefined : 'rate-limited'
case 'out-of-credit':
  return retryDue(probe, nowMs) ? undefined : 'out-of-credit'
```

`retryDue` **只对 `rate-limited` / `out-of-credit` 调用**。其余四种结局（含 `unavailable` = 网络不通/5xx、`failed`、`not-found`）返回的排除**没有自己的过期时间**。

**实测**（out-of-tree vitest 配置，`src/` 与 `tests/` 均未改动）：`exclusionOf({outcome:'unavailable'}, NOW + 365天)` 仍为 `'credential-rejected'`；`not-found` / `failed` 同理（`NOW + 999天` 仍排除）；对照 `rate-limited` 在 `POOL_UNKNOWN_COOLDOWN_MS`（30 分钟）后正确清零 ✓。

**⚠️ 自我更正（重要）**：上面这个测量容易读成"永久禁用"，**那是过度声称**。`exclusionOf` 的输入是**存储的探测结果**，而调度器会刷新它：`runScheduledPoolTest` → `poolTargets` → `poolMemberAccounts`（`src/index.ts:1123-1130`）**只按 `memberAccountIds` 成员资格过滤，不过滤 `excludedBy`**，所以每次计划测试都会**重新探测被排除的账号**；`probeUpdatesOf`（`src/account-pool-run.ts:206-219`）会**替换**存储的探测（仅跳过 `isTransportFailure`，即"无存储凭据"），因此网络恢复后下一次探测返回 `'ok'`，排除**自动清除**。正确表述是：

- **排除不是永久的**，它由**下一次计划测试或手动测试**界定（默认间隔 30 分钟，范围 5–1440 分钟）。
- 真正的**不对称**在于：`rate-limited` 有 30 分钟冷却兜底（即使探测陈旧也会自行到期），而 `unavailable` **依赖探测被刷新**——若调度器早退（区域或池关闭、无免费模型且未指定目标模型、成员为空），探测就**永不刷新**，此时卡片会一直显示该排除状态。

**后果（按严重度，已按更正后的机制重排）**：

1. **同型缺陷（确定成立，不依赖上面的更正）**：4 种上游结局被压成 1 个值，而**客户端只按值渲染**（`exclusionText` → `row.poolExcludedRejected` = "被拒绝"），于是**同一条账号行自相矛盾**——名称列说「被拒绝」（`AccountPool.tsx:855`），探测列说「✗ 连不上上游——这是网络问题，不是模型问题」（`:870` → `outcomeText('unavailable')`）。两句话在同一行同时渲染，用户无法判断该重登录还是该查网络。**这是本项目"算出了区分却压平"模式的第六例。**
2. **`poolNoCandidateHint`（C4-8）同步失准**：文案列「被限流、积分耗尽、被上游拒绝、本版本无法使用」四种，但 `unavailable`/`failed`/`not-found` 都显示为「被上游拒绝」，用户按文案排查会走错方向。
3. **一次网络抖动就让账号退出轮换，最长一个间隔**：`unavailable` 包含 `status === 0 || status >= 500`（`src/probe.ts:296`），即一次超时或一次上游 5xx 就足以让该账号在下一次探测前不再是轮换候选。`rate-limited` 用 30 分钟冷却，而它用"整个测试间隔"（默认 30 分钟，最长 24 小时）——两把尺子不同，且没有文档说明。

**为什么这不一定是本轮要修的**：不自动重试 `credential-rejected` **有安全性论据**——凭证确实坏了，重试只是浪费请求。问题不在"是否排除"，而在**把网络类失败也塞进同一个值**，以及**界面对同一行给出两种互相矛盾的诊断**。建议下轮：给 `unavailable` / `failed` 独立的值（或让它们走 `retryDue` 的冷却路径），并让 `exclusionText` 覆盖之。**这也正是验证员被要求继续挖的方向**（见 §8.1 末尾给 `round2-verify` 的留言）。

**已写入的核查**：`exclusionOf` 现有测试（`tests/account-pool.spec.ts:162-215`）覆盖了 `rate-limited` 冷却、`out-of-credit` 冷却、`credential-rejected`、`unusable`，但**没有**覆盖 `unavailable` / `failed` / `not-found` 的时间行为——这正是缺陷藏身处。

**教训**：把"值永不改变"当成"状态永不恢复"是错的——必须先确认**谁在刷新这个值**。我第一版写下了"永久禁用"，核对调度器与 `probeUpdatesOf` 后推翻。这类"测量正确、推论过头"的错误，与 F 报告里 A-4 的"报告数值与实际不符"是同一类，值得在验证清单里单列一条。

## 九、第二轮独立验证结果（G 报告）

**验证员**：`round2-verify`（独立 teammate，fresh context）。**产出**：`docs/audit/G-round2-verification.md`（281 行）。
**方法**：证伪而非确认——**21 个变异体**跑在 `/tmp/r2ver/mut` 的抛离副本上，每个 patch 都用哈希守卫确认**真的应用了**（否则报 `NO-OP-PATCH`），并有两个 oracle：自建 **14 条真实渲染** oracle（React 18.3.1 + jsdom，`t` 换成保 key 的翻译器 → 断言读 **locale key** 而非文案）+ 快照自身套件。跑前跑后各比一次 8 个哈希，**全部一致**。

### 裁决：11/11 条修复全部 CONFIRMED（证伪尝试全部失败）

| # | 被验事项 | 结果 | 判别证据 |
| --- | --- | --- | --- |
| 1 | **最高优先级怀疑**：`pool-state.ts` 纯函数是否真在渲染路径上（抽函数后可能只剩测试在用） | **CONFIRMED 非装饰性** | M7/M8a/M8b/M9/M10 各杀一条渲染测试；6 个 helper 全部有 `AccountPool.tsx` 调用点（§3 列表）；`grep` 无第二份内联规则 |
| 2–3 | H-5 **两个**按钮同判据 | CONFIRMED | M1/M2 → `expected false to be true` |
| 4 | 路由守卫 `effective ?? saved` → 409 | CONFIRMED | H2/H3 → `expected 200 to be 409`（ghost + 对照各一） |
| 5 | 拆分 reason 由 ghost 用例判别、对照用例**不**判别 | CONFIRMED | H1 只失败 ghost 用例；对照用例两版都过（**与我 §8.1 的记录一致**） |
| 6 | A-12 基准 + **可达性** | CONFIRMED | M5 → 2 条失败；端到端证明 clear→save 的 POST body 真的带 `pool.targetModelId: ''` |
| 7 | C2-4 **两个方向** | CONFIRMED | M6a/b/c 各失败一条 |
| 8 | ghost-only e2e 改为断言 409 | CONFIRMED | 在 H1/H2/H3 下失败；改写前不可能 |
| 9 | `createLatestWins` + `begin(region)` | CONFIRMED（作为**一对**） | H4 → 4 条失败；H6（令牌+重读都删）→ `expected '9c847c48…' to be undefined` |
| 10 | **我自陈的负面结果**：只删令牌仍通过 | **CONFIRMED 复现** | H5 → `Tests 23 passed`，零失败 |
| 11 | `announcedBatchCount` 镜像 `effective ?? saved`、**不可** draft-aware | CONFIRMED | M3 → 1 条失败；M4 初版**存活**，见下 |

**计数差异（验证员主动说明）**：他没复现我的 H-2→3、C4-3→3，因为他的 oracle **刻意每行为一条测试**（各 1 条失败）。判别力成立，计数是 oracle 相关——这个说明很诚实，避免了"数字对不上=有人错了"的误判。

### 唯一逃逸的变异体 M4，以及它暴露的**我的**测试缺陷

M4（把 `announcedBatchCount` 的入参换成 draft-aware 的 `effectiveMembers`——一个看似合理的"未来简化"）**第一轮存活**，即当时"宣告已被测试"是**假的**。
**根因**：`runAction` 是 `useCallback(..., [appendLog, pool, region, t])`（`AccountPool.tsx:503-592`），body 读 `saved`/`active`/`dirty`/`effectiveMembers`——**都不是依赖**，所以点击处理器用的是**上一次改 `pool` 的那次渲染**的值。验证员的 S2b 勾选后立即点击 → 变异体读到勾选前的闭包 → **要等卡片下一次身份变化（真实应用里是 60 秒轮询）才可见**。
**修复在 oracle（非 `src/`）**：S2b 改为先刷新 `pool` prop（正是卡片自己的轮询行为）再点击 → M4 失败 `expected '…count=2…' to contain '…count=1'`，纯净树保持 14/14。**矩阵至此零存活变异体。**
**两个后果**：(1) 冻结版在这里是**正确**的——宣告**刻意**读已保存对，draft-aware 会宣告 Host 不会执行的编辑，由 S2b 的正/负配对钉住；(2) `runAction` 的依赖数组是**潜在陷阱**（见 D5）——今天 body 里唯一的状态读取恰好与 draft 无关所以无害，但**未来任何 draft-aware 读取都会静默陈旧一个轮询周期**。

### 新发现（6 条，详见 G 报告 §5）

- **D4（中，测试完整性）**：`tests/pool-e2e.spec.ts` 那条"证明挂载的插件**真的执行了**调度"的 e2e **无法观测它声称的事**，两个独立原因：(1) 它挂 `memberAccountIds: []`，被唤醒的调度器无事可做，而两条断言都是 `expect(probes).toBe(0)`——**死计时器与活调度器产生同样的结果**；(2) 它先在**真实计时器**上挂载、之后才 `vi.useFakeTimers()`，而心跳 `setInterval` 是在 `apply()` 内创建的（`src/index.ts:1281`），所以假时钟**永远不触发它**。验证员第一次驱动调度器就复现了两半（`chatCalls = 0`，对照测试"通过"而批次从未运行）；只有把假时钟装在 `WorkBuddy.apply(...)` **之前**，批次才真的跑起来。**同一空洞也影响邻接用例**"整间隔未到不探测任何东西"（`memberAccountIds: ['x']` 不是本地登录 → 批次也是 no-op）。**这与我已经重写的 ghost-only e2e 属同一类**：一条正确实现与缺失实现都能满足的断言。
- **D1（中）**：即我的发现 7，验证员**独立复现且无法证伪**——真实挂载下**同一行**同时含 `row.poolExcludedRejected`（"Rejected"）与 `row.probeUnavailable`（"…这是网络问题，不是模型"）；对照行（真被拒）无矛盾。`exclusionOf({outcome:'unavailable'}, NOW+365d)` 仍排除。**他同时确认了有界性**（下一批重探即清除），与我的更正一致。
- **D3（低）**：我收窄后的不对称性**真实可观测**——他用**真实插件+真实调度器**（`/tmp/r2ver/sched`，4 条绿）证明：健康上游在下一个到期 tick 治好 `unavailable` 成员（`excludedBy` 消失、`chatCalls` 0→1，**非空洞**）；而 saved target 陈旧时批次**根本不运行**（12 个间隔、`chatCalls === 0`、probe `atMs` 未变），成员一直挂起——同一状态下 `rate-limited` 成员**仅靠时钟**就清除（probe 未动）。不对称性成立。
- **D2（低）**：**`web-status.ts:838` 的注释是假的**——它写卡片"从 `reason` 本地化、从不读 `error`"，但 `AccountPool.tsx:536` 是 `poolErrorText(t, body?.reason) ?? body?.error ?? \`HTTP ${status}\``。因此**所有不带 `reason` 的池路由响应**（三个 503、500、403/405/400）**以英文原样进入日志**（真实挂载证明：503 → `row.poolLogBatchFailed|message=pool check-in unavailable`，无任何 `row.poolErr*`）。**我的 §8.1 修复只覆盖了带 reason 的 409**。中文用户仍会看到英文。
- **D5（低，潜在）**：`runAction` 依赖数组（见上）。
- **D6（信息）**：**五处独立实现"有效成员"**——`web-status.ts:636-638`（状态文档）、`web-status.ts:830-833`（路由守卫）、`index.ts:892-898`（host dep）、`index.ts:1123-1130`（`poolMemberAccounts`，刻意不过滤排除）、`pool-state.ts:effectiveMemberIds`（卡片）。今天一致，但**这正是产生前五个"修一端漏另一端"缺陷的形状**。

### 覆盖面缺口（非缺陷，但需补）

- **H7**：删掉客户端 `case 'no-live-members'` → **618 全过**；**H8b**：把 `row.poolErrNoLiveMembers` 从**中英两表**都删掉 → **618 全过**。即"幽灵池给用户的恢复指引"**在仓库套件里毫无守卫**，目前只有验证员的 oracle 在盯。**这必须补进 `tests/`。**
- **H5**：`stale()` 令牌未被单独覆盖，但 await 后重读使它在唯一可竞态的路径上冗余 → 属覆盖缺口而非活缺陷。

### 验证员未能验证的部分（已明说）

文案**散文**（oracle 断言 key，未断言文本）、浏览器/CSS 渲染（仅 jsdom）、真实 DSH Loader/volatile 配置行、已记录未修的 M-4/L-5/A-8 窗口、以及仓库套件是否会捕获 D1/D2 回归（**不会**）。

### 复现方式（G 报告 §7）

```bash
cd /tmp/r2ver/base    && ./node_modules/.bin/vitest run                          # 618 passed (29 files)
cd /tmp/r2ver/harness && REPO_ROOT=/tmp/r2ver/base ./node_modules/.bin/vitest run # 14 passed
cd /tmp/r2ver/probe   && REPO_ROOT=/tmp/r2ver/base ./node_modules/.bin/vitest run # 10 passed
cd /tmp/r2ver/sched   && REPO_ROOT=/tmp/r2ver/base ./node_modules/.bin/vitest run tests/g-heal.spec.ts  # 4 passed
bash /tmp/r2ver/mutate.sh                                                        # 21 mutants + 2 controls
```

四个套件全部把 `DSH_HOME/HOME/USERPROFILE/LOCALAPPDATA/APPDATA/XDG_CONFIG_HOME` 隔离到 per-run 临时目录（与 `vitest.config.ts:39` 一致），未触碰真实 `~/.dsh`；每个变异副本都在 `/tmp` 下；冻结版在跑完后与 §0 逐字节一致。

**总评**：这一轮**没有存活变异体**，且最高优先级怀疑（抽函数是装饰性的）被明确**证伪**。剩下的问题集中在两类：(a) **测试空洞**（D4、H7/H8）——断言在正确与缺失实现下都成立；(b) **又一次"算出区分却压平/只修一端"**（D1 四种结局压成一个值、D2 只本地化了带 reason 的那一支）。这两类都不是新类型，而是本项目既有模式的延续。

## 十、第三轮待办（按用户价值排序）

1. **M-2 / A-4 间隔输入框逐键 clamp**（`AccountPool.tsx:974-988`）——**直接违背用户原始需求"设置一个时间间隔自动测试"**：逐键输入 `120` 实得 `520`，清空即变 5。修法：字符串中间态 + `onBlur` clamp。
2. **D2 未本地化的池路由错误**（`web-status.ts` 三个 503 + 500 + 403/405/400）——中文用户看英文。修法：给这些响应加 `reason`，或删掉 `web-status.ts:838` 的假注释并按 `status` 兜底本地化。
3. **D4 + H7/H8 测试空洞**——把"调度器真的执行"的 e2e 修成有判别力（**假时钟装在 mount 前**、放一个真实成员、断言一个间隔后 `probes ≥ 1`）；把客户端 reason 映射与 `row.poolErrNoLiveMembers` 双表 key 钉进仓库套件。
4. **D1 `exclusionOf` 压平**——给 `unavailable`/`failed`/`not-found` 独立值（或走冷却），并让 `exclusionText` 覆盖之，消除同一行自相矛盾。
5. **D5 `runAction` 依赖数组**、**D6 五处"有效成员"收敛为一处**、开启 `eslint-plugin-react-hooks/exhaustive-deps`。
6. 仍挂着：**M-4 + L-5 同批修**（批量后刷新 + 请求序号）、**A-8 遗留窗口**。

## 十一、第三轮修复（全部完成，含 D5/D6 与 §十 第 6 项）

**基线**：618 → 651 tests / 29 files 全绿；`npx tsc --noEmit` 退出 0。逐项如下。

### 11.1 M-2 / A-4 间隔输入框逐键 clamp —— 已修

**缺陷**：`AccountPool.tsx` 的 `onChange` 内立即 `Math.min(1440, Math.max(5, Math.round(Number(value))))` 写回**受控** value，于是逐键输入 `120` 实得 `520`，清空即变 5。**直接违背用户原始需求"设置一个时间间隔自动测试"**。

**修复**：`src/client/pool-state.ts` 新增 `POOL_INTERVAL_MIN = 5` / `POOL_INTERVAL_MAX = 1440` 与 `parseIntervalInput(raw: string): number | undefined`——非纯数字（空、`-`、`12e`、`1.5`）返回 `undefined` 让调用方**原样保留用户输入**；合法则 clamp。卡片新增 `intervalText` 字符串中间态：`onIntervalInput`（记录原文 + 合法才折入 draft）、`onIntervalCommit`（blur/Enter 清中间态、只 clamp 一次）；`value: intervalText ?? String(active.autoTestIntervalMinutes)`。`discard()` 与 region 切换都清中间态。

**测试**：`tests/pool-state.spec.ts` 加 `parseIntervalInput` 5 条（`120` 通过、逐键前缀 `1`→5 / `12`→12、越界 clamp、非整数 undefined、常量与 Host schema 一致）。

### 11.2 D2 池路由错误未本地化 —— 已修

三个 503（`pool-unavailable`）与 500（`pool-failed`）补 `reason`；**修正假注释**（原称卡片 "never reads `error`"，实际有 `?? body?.error` 回退）。新增 `row.poolErrUnavailable`/`row.poolErrFailed`/`row.poolErrHttp` 双语；`poolErrorText` 扩到 7 个 case；抽取 `poolFailureText(t, { status, reason?, error? })` 表达三级规则（结构化 cause → Host 原文 → 按状态本地化）。**`exactOptionalPropertyTypes` 陷阱**：可选参数必须写 `reason?: string | undefined`，否则 `error TS2379`。

### 11.3 D4 调度器 e2e 空洞 —— 已修（本节最重的发现）

`tests/pool-e2e.spec.ts` 的 `'arms on the first tick…'` 原挂 `memberAccountIds: []` 且两条断言都是 `expect(probes).toBe(0)`——**死计时器与活调度器同结果**；邻接用例 `'does not probe anything before a full interval has elapsed'` 同空洞（挂 `['x']` 非本地登录 → no-op）。

改写后**首次运行即失败**，暴露两个真问题：(1) **假时钟必须在 mount 之前**（心跳 `setInterval` 在 `apply()` 内创建），且 `toFake` 必须含 `Date`（调度器用 `Date.now()` 比较），并收窄到 `['setInterval','clearInterval','Date']`（不含 `setImmediate`，否则 mount 的 `setTimeout(0)` 不结算）；(2) **假计时器不伪造 I/O**——批处理经 `fs/promises` 读 auth 文件（`auth.ts:909`），`advanceTimersByTimeAsync` 返回时批次仍挂起，必须 `flushRealWork()`（drain 60 次 `setImmediate`）后 `probes` 才从 0 变 1。

**变异确认（4 次，全部恢复字节一致）**：`POOL_TICK_MS` → `×100`、`for (const region of schedule.due)` → 空数组、`duePoolRegions` 首次即运行 —— 后两者在**修前通过、修后失败**，证明判别力是这次改写带来的。

### 11.4 H7/H8 覆盖缺口 —— 已修

删客户端 `case 'no-live-members'` 或删双语 `row.poolErrNoLiveMembers`，仓库套件都曾 618 全过。`poolErrorText`/`poolFailureText` 移入 `src/client/pool-state.ts`（`.tsx` 模块图拉 DSH 浏览器包、本项目无 jsdom，组件内规则**根本无法测试**）。测试用 `keyT` 断言**选了哪个 key** 而非文案；locale 表断言中英键集相等、zh≠en。

### 11.5 D5 `runAction` 依赖数组 —— 已修，并推广

`runAction` 的 body 曾读 `saved.memberAccountIds`，而 `saved` 是每次渲染重建、**不在依赖里**的绑定 → 点击处理器用上一次渲染值；静止时两值相等所以整套测试从不失败（M4 变异体正是靠这点逃逸）。改为经 `pool?.memberAccountIds` 读取。**推广**：同一形状还有 `save` 读 `onSaved`、`runAction` 读 `onRefresh`——两个 prop 回调都不在各自依赖数组里，已补。新增两条结构性守卫：一条钉 `runAction` 不得读 draft 派生绑定，一条**通用**扫描 `AccountPool.tsx` 全部 `useCallback`，断言 body 读到的 prop 回调都出现在依赖数组里。**注意**：守卫最初硬编码依赖数组文本，导致"**增加**一个依赖（正确改动）也会失败"，已改为结构化定位 `\n  }, [`。

### 11.6 M-4 批量后不刷新 —— 已修

签到消耗积分、测试写入探测结果，但面板数字来自 usage 路由，批量后**无人重读** → 面板一直显示**签到前**的积分直到下一次 60s 轮询。新增 `onRefresh` prop，由卡片传 `refreshUsage`，在批量**成功路径**调用（放在 `finally` 会在失败时也刷新并掩盖错误——有守卫钉住）。

### 11.7 L-5 两次 refreshUsage 无请求序护栏 —— 已修

两个刷新（轮询 / 保存 / 批量 / 重扫）都是裸 `fetch`，无顺序保证 → **慢的响应获胜**，签到前的快照可能覆盖签到后的。加**按区域**的 latest-wins 令牌（`createLatestWins<WorkBuddyWebRegion>()`，**复用** Host 那份已测试的工厂而非重写）；成功与错误两条写入路径**都**在守卫之后。**必须按区域**：卡片刻意一次取两个区域，全局计数会让两个调用互相取消、留下一个永远陈旧的标签页。

### 11.8 A-8 保存后遗留窗口 —— 已修

`discard()` 让 `active` 回落到来自 usage 路由的 `saved` prop，而**先 discard 后刷新**会在窗口内显示用户刚替换掉的**旧值**且控件可交互。改为**先 `await onSaved?.()` 再 discard**，`saving` 全程为 true（控件不可交互），discard 因此不可见。**配套**：`onSaved` 必须**返回** promise——卡片原写 `onSaved={() => { void refreshUsage(activeRegion) }}`，`void` 让 `await` 立即结算、窗口照旧存在。新增 `committed` 标志，**只有验证过的写入才 discard**（否则失败写入会毁掉唯一副本）。`onSaved` 返回类型放宽到 `Promise<unknown>`（`refreshUsage` 返回 `WorkBuddyWebUsage | undefined`）。

### 11.9 D6 五处"有效成员" —— 收敛为一处

`effectiveMembersOf(saved, listedIds)` 落入 `src/account-pool.ts`，五个站点全部委托：状态文档（store 序）、批量路由守卫（经依赖）、Host 依赖（saved 序）、`poolMemberAccounts`（store 序）、浏览器 helper。**顺序由调用方决定**（卡片按 store 序渲染花名册、saved 序是用户自己的顺序，都不该被过滤器悄悄重排）——因此返回 `saved.filter(...)` 而非按 listedIds 迭代。新增 5 条纯函数测试 + 1 条结构性守卫（三个文件必须含 `effectiveMembersOf`，且旧的内联形状必须消失；`poolMemberAccounts` 的检查**限定在函数体内**，因为 `otherAccounts` 合法地过滤**补集**）。

### 11.10 未做：`eslint-plugin-react-hooks/exhaustive-deps`

**本项目根本没有 eslint**（无配置文件、无 devDependency、无 lint script）。为一个规则引入整套 linter 依赖面，成本远大于收益，且 D5 的两条结构性守卫已覆盖同一风险。**记录在案**，若将来引入 eslint 应开此规则。

### 11.11 本轮新增守卫的判别力（全部变异确认）

| 修复 | 变异 | 结果 |
|---|---|---|
| M-2 | 逐键 clamp 回退 | 5 条失败 |
| D1 | 四结局折叠回 `credential-rejected` | 失败 |
| D2 状态层 | `?? t('row.poolErrHttp',…)` → `` `HTTP ${status}` `` | 3 条失败 |
| D4 | 心跳 ×100 / 调度器空转 / 首次即运行 | 失败（后两者修前通过） |
| H7 | 删 `case 'no-live-members'` | 失败 |
| H8 | 删 zh 版 `row.poolErrNoLiveMembers` | 2 条失败 |
| D5 具体 | 改回 `saved.memberAccountIds` | 失败 |
| D5 推广 | `save` 去掉 `onSaved` 依赖 | 失败 |
| M-4 | `onRefresh` 移入 `finally` | 失败 |
| L-5 | 删成功路径守卫 | `expected 1 to be 2` |
| A-8 顺序 | 真旧序（先 discard 后刷新） | 失败 |
| A-8 守卫 | 无 `committed` 的裸 `discard()` | 失败 |
| A-8 接线 | 卡片 `void` 掉 promise | 失败 |
| D6 | `poolMemberAccounts` 重新内联 | 失败 |

**总评**：第三轮全部 5 项 + §十 第 6 项完成。两个反复出现的教训已各自落成守卫：(1) **测试空洞**——"断言在正确与缺失实现下都成立"（D4 的 `expect(probes).toBe(0)`、H7/H8）；(2) **修一端漏另一端**（D5 只修了一个回调、A-8 只修了顺序没修接线）。守卫本身也踩过一次同型错误（硬编码依赖数组，使正确改动失败）。

---

## 十二、第四轮：H 报告（独立对抗验证）后的收口

**背景**：`docs/audit/H-round3-verification.md`（415 行，独立 agent）对第三轮 10 条 claim 出裁决：5 CONFIRMED / 3 PARTIAL / 1 部分 REFUTED，并给出**六个"恢复真实缺陷而套件仍 651 全绿"的变异体**、四条新发现 N1–N4。本轮把它们全部收口。

### 12.1 结构性根因（决定了本轮所有修法）

`node_modules` 只有 7 项——**无 jsdom、无 react-dom、无 @testing-library**，`vitest.config.ts` 用 `environment: 'node'`。因此 `AccountPool.tsx` / `WorkBuddyCard.tsx` 的接线**无法真实渲染测试**，只能做源码断言。六个存活变异体的共同形状就是：**断言用"保留文本的变异"仍能满足**（裸 `toContain`、只数出现次数、只看首次出现、从不读初始值、硬编码名字清单）。故本轮把每个守卫从"文本存在"升级为**"结构/位置/取值"**。

### 12.2 N1（真实产品缺陷）—— 已修

`save` 的 `await onSaved?.()` → 卡片 `onSaved={() => refreshUsage(activeRegion)}` → `refreshUsage` **永不 reject**（非 OK 或网络错误都 resolve `undefined`）。所以**写入验证成功但重读失败**时仍到达 `committed = true` 与 `discard()`：清空草稿 → `active` 回落到**陈旧的** `saved` prop → 面板显示编辑前旧值且控件恢复可交互，正是 A-8 声称已关闭的那个窗口。**非数据丢失**（写入已验证，Host 已持新偏好；60s 轮询自愈）。

**修法**：`onSaved` 契约改为三态 `() => void | Promise<boolean>`。JSDoc 写明"**RESOLVE `false` WHEN THE RE-READ DID NOT DELIVER FRESH PROPS**"——父级**无法用抛异常**报告失败（`refreshUsage` 用 resolve 报失败），"没抛"≠"新 props 到了"。`save` 体：`await writePoolPreferences(...)` → `const refreshed = await onSaved?.()` → `if (refreshed === false) { setSaveError(t('row.poolSavedStaleRefresh')); return }` → `committed = true`。卡片接线 `onSaved={async () => (await refreshUsage(activeRegion)) !== undefined}`。新增双语 `row.poolSavedStaleRefresh`。

### 12.3 六个覆盖缺口 —— 全部补齐（每个都先证明缺口、再杀变异体）

| 缺口 | 原守卫为何失察 | 升级后的形状 | 变异体结果 |
|---|---|---|---|
| M-2 接线 | 只有纯 helper 被测，无人覆盖 `AccountPool.tsx` 的输入接线 | 新增 `intervalEditOnInput(raw) → { text, commit }` 纯函数（`text` 永远是原始击键），卡片经它接线；测试断言 `'1' → {text:'1',commit:5}` 与 `not.toMatch(/setIntervalText\(\s*String\(/u)` | KILLED |
| D2 主机侧 `reason` | `tests/pool-route.spec.ts` 里 `reason` 出现 **0** 次 | 四处 503/500 全部断言 `body()['reason']`；新增 ghost 用例断言 `'no-live-members'` | KILLED |
| D5 prop 读取 | 守卫只监视硬编码四个回调名 | 从组件**自身解构**读 prop 名单，逐个 `useCallback` 用词边界核对依赖 | KILLED |
| M-4 重复调用 | 守卫用 `indexOf` 只看首次出现 | 断言 `onRefresh` 调用**恰好一次**（`tests/pool-e2e.spec.ts:995`） | KILLED |
| L-5 守卫挪位 | 守卫只**计数**两条守卫（挪到错误路径后仍是 2） | 断言**位置归属**：两条守卫必须分别早于两条 `setStatusByRegion(`，且 `} catch` 分界正确（`tests/pool-e2e.spec.ts:1022`） | KILLED |
| A-8 committed 初值 | 守卫**从不读初始值** | 断言 `let committed = false` 逐字，且 N1 的 `if (refreshed === false)` 早于 `committed = true` | KILLED |

**M-2 是本轮唯一需要改产品的缺口**：用户报告的"逐键 clamp"（输入 `120` 得 `520`）此前**确实无测试**——只有 `parseIntervalInput` 被钉住，接线无人覆盖。拆出 `intervalEditOnInput` 使"显示原文 / 提交解析值"这一不变量**无需 DOM 即可单测**。

### 12.4 N2 —— 已修（参数命名是陷阱本身）

`effectiveMembersOf` 首参原名 `saved`，但 `src/web-status.ts:637` **合法地**传入 roster（为了 store 序）。只因集合运算可交换才正确。改名 `orderedIds`，JSDoc 写明"**顺序取自 `orderedIds`**，调用方传它想要的那个顺序；参数名描述**角色**而非来源"。

### 12.5 N3 —— 已修（委托曾是行为上的空操作）

原 `poolMemberAccounts`：`const live = new Set(effectiveMembersOf(saved, new Set(accounts.map(...))))` 后接 `return accounts.filter(a => live.has(a.id))`。**外层 filter 遍历 `accounts`，所以无论 `live` 怎么算，结果都是 `accounts ∩ saved`**——把 `effectiveMembersOf` 的函数体换成 `return []` 也全绿。改为**规则自身的输出驱动结果**：`return effectiveMembersOf(accounts.map(a => a.id), new Set(saved)).flatMap(id => …)`。守卫同步改为断言 `return effectiveMembersOf(` 且禁止 `.filter(account => live.has(`。三个变异体（恢复欺骗形状 / 清空规则体 / 内联 saved filter）全部 KILLED。

### 12.6 N4 —— 已修（同一 staleness 类的另一半）

原"generalised"守卫只覆盖 **prop** 读取；H-1 的形状是回调闭包读**渲染期派生绑定**（`editDraft` 读 `saved.memberAccountIds` 而依赖数组没有它）。守卫扩展为同时核对 10 个派生绑定（`saved`/`active`/`dirty`/`listedIds`/`savedEffective`/`effectiveMembers`/`ghostMembers`/`usable`/`usableMemberSet`/`current`），并排除三种误报：lambda 参数、属性读取（`mounted.current`）、对象字面量键（`{ savedEffective: … }`）。变异体：`editDraft` 改回读 `saved`、`runAction` 改读 `savedEffective` → 均 KILLED。

### 12.7 变异确认总表（本轮，工装见 §12.8）

| # | 变异体 | 结果 | 决定性断言 |
|---|---|---|---|
| 1 | `M-2-wiring-revert-v2` | KILLED | `to contain 'const { text, commit } = intervalEdit…'` |
| 2 | `M-D2-drop-reason` | KILLED | `expected undefined to be 'pool-unavailable'` |
| 3 | `M-D5-save-reads-pool-undeclared` | KILLED | `save reads the pool prop but does not declare it` |
| 4 | `M-M4-refresh-also-in-finally` | KILLED | `expected 2 to be 1` |
| 5 | `M-L5-success-guard-moved` | KILLED | `the SUCCESS write is not behind a freshness check: expected 841 to be less than 705` |
| 6 | `M-A8-committed-true` | KILLED | `expected 'let committed = true' to be 'let committed = false'` |
| 7 | `M-D6-comment-only` | 首轮 **SURVIVED** → 升级后 KILLED | `tests/pool-e2e.spec.ts:1113` `poolMemberAccounts does not return the shared rule\'s answer` → `toMatch(/return effectiveMembersOf\s*\(/u)`（行号已核正：旧稿引的 `:1099` 只是 `const index = …` 一行，不是断言） |
| 8 | `M-N1-bailout-removed` | KILLED | `tests/pool-e2e.spec.ts:1144` `the re-read result is discarded (N1 stays open)`（旧稿引的 `:1096` 是注释行） |
| 9 | `N3a-deceptive-shape-restored` | KILLED | `does not return the shared rule's answer` |
| 10 | `N3b-rule-body-emptied` | KILLED | `expected [] to deeply equal [ 'a', 'c' ]` |
| 11 | `N3c-inlined-saved-filter` | KILLED | `tests/pool-e2e.spec.ts:1115` `poolMemberAccounts re-inlined the membership test` → `not.toMatch(/\.filter\(account => live\.has\(/u)` |
| 12 | `N4a-editDraft-reads-saved` | KILLED | `editDraft reads the render-scoped saved but does not declare it (H-1 shape)` |
| 13 | `N4b-runAction-reads-savedEffective` | KILLED | `to contain 'pool?.effectiveMemberAccountIds'` |

**13/13 KILLED**，其中 #7 正是 H 报告证明存活的攻击——**升级前它通过、升级后被杀**，证明本轮升级真的带来了判别力。

### 12.8 变异工装（纪律）

`/tmp/r4v-mut`（`rsync` 副本 + 软链 `node_modules`）、`/tmp/r4v-pristine`（`src`/`tests` 纯净快照）、`/tmp/r4-env.sh`（六个隔离环境变量，匹配 `vitest.config.ts:39`）、`/tmp/r4-run.sh <label> <mutating-cmd>`：补丁前后对全树 `sha256sum` 比对，相同则报 **NO-OP-PATCH**；否则跑套件，grep `Tests +N failed` → **KILLED**/**SURVIVED**；最后从 pristine `rsync --delete` 恢复。**教训**：变异命令必须作为 `r4-run.sh` 的第二个参数传入（写成独立脚本先执行会落在 hash 窗口外，误报 NO-OP-PATCH）。全程**零写入共享仓库**；唯一仓库写入是本文件。

### 12.9 状态

- 基线：651 → **655 tests / 29 files 全绿**；`npx pnpm run check` EXIT=0（typecheck + test + build）。
- H 报告 10 条 claim 的缺口与 4 个被击败的守卫：**全部收口**；N1–N4 四项新发现：**全部修复**。
- 仍成立的方法论教训：**"文本存在"不是"行为存在"**。任何结构性守卫都必须能回答"什么变异会让它失败"，否则它只是注释。

---

## 十三、第五轮：I 报告（第二轮独立对抗验证）后的收口 —— 从"源码文本守卫"转向"真实渲染测试"

**背景**：`docs/audit/I-round4-verification.md`（656 行 / 52 KB，独立 agent）在 655 全绿 + 两个 tsc 项目 EXIT=0 的前提下，一次性交回**十八个"恢复真实缺陷而套件仍全绿"的变异体**，并证明第三轮新增的**八个源码文本守卫里有六个被"保留文本的变异"击败**。报告的结论被采纳：**"修法不是更多正则，而是一个依赖：jsdom + react-dom。"**

### 13.1 结构性根因（本轮为什么必须换武器）

源码守卫的判别力上限由它读的**文本**决定，而缺陷住在**行为**里。六个被击败的守卫共享同一种失败模式：

| 守卫的读法 | 为何必然漏 |
|---|---|
| `toContain('usageGuard.current.begin(region)')` | `() => begin(region)()` 也含这段文本，但从未被调用 |
| `toContain('onRefresh={')` | 属性存在即通过，属性体从不被读 |
| `indexOf` 只找**首次**出现 | 同一调用出现在 `finally` 里不会被发现 |
| **计数**守卫出现次数 | 把守卫挪到错误的路径后数量仍是 2 |
| 断言里引用的文本**恰好也是注释** | 守卫不 `strip()` 注释，删掉代码留注释即通过 |
| 硬编码名字清单 | 换个别名（`poolAlias`）即绕过 |

更严重的是**守卫会固化为 bug 的辩护**：本轮的 P0 缺陷（见 13.2）正是因为 `tests/pool-e2e.spec.ts:1011-1053` 把 `if (!fresh()) return undefined` **写死为正则要求**，任何把它改成正确写法的编辑都会被自己的测试判红。

### 13.2 P0：一个由我引入、由源码守卫保护、只有渲染才暴露的极性缺陷

**症状**：新写的 `tests/pool-card-render.spec.tsx` 挂载真实 `WorkBuddyCard` 后，即使 fetch 被 stub 成合法 signed-in body、两个 region 的 usage 请求都真的发出，卡片**永远渲染 `row.signedOut` 占位符**。

**排查链（每条都被独立排除）**：URL 正确；`mount().settle()` 能正常刷新普通 effect 里的 setState（用独立 Probe 组件验证 `PROBE updated`）；`act` 不是 export（`tests/pool-render-helpers.tsx:27` 是模块私有），所以异步只能靠 `settle()`。

**决定性探针**：在 `refreshUsage` 里插 `DBG-ENTER/DBG-JSON/DBG-GATE/DBG-APPLY/DBG-ELSE`，输出 **`DBG-GATE false true true function`** 且 `DBG-APPLY`、`DBG-ELSE` **都没打印** → 证明执行到 `if (!okFresh) return undefined` 就返回了。

**根因**：`src/account-pool.ts:333` 的 `createLatestWins` 返回的探针**报 STALE**（`return () => generations[key] !== generation`），即**没有更新时返回 `false`**。而 `src/client/WorkBuddyCard.tsx` 原先写 `const fresh = usageGuard.current.begin(region)` + `if (!fresh()) return undefined`——**双重取反并不抵消**：未过期（即唯一一次 fetch）时 `fresh()` 为 `false`，条件为真 → **丢弃每一个响应**。

**交叉验证极性**：`tests/account-pool.spec.ts:462-515` 的 `describe('createLatestWins (H-3 race guard)')` 明确固定 `first()` 为 `false`、新调用 `begin` 后变 `true`；测试 3 `'stays fresh when nothing newer begins'` 断言 `probe()` 五次全为 `false`；`src/account-pool.ts:328` 的文档写着"报告**过期**时退出"；`src/index.ts:1038` 的参考用法 `const stale = rotationGuard.begin(region)` + `if (stale()) return` 是**正确**的。

**产物归属**：`git diff src/client/WorkBuddyCard.tsx` 显示 `usageGuard` 是 L-5 修复的**纯新增内容**，先前不存在 → **缺陷由我引入**。在 `/tmp/r5-mut` 里翻成 `if (fresh()) return undefined` 后立刻恢复完整 UI（`FIXED row.titlerow.descrow.tabCnrow.tabGlobalrow.tabHintrow.signedIn|accountName=A…`）→ 证明修复有效。

**修复（已落地）**：`src/client/WorkBuddyCard.tsx:396` 改为 `const stale = usageGuard.current.begin(region)`；`:407` 与 `:415` 都改为 `if (stale()) return undefined`；`:360-388` 新增注释说明极性陷阱。同步把 `tests/pool-e2e.spec.ts:1011-1053` 的正则改为 `/if \(stale\(\)\) return undefined/gu`。

**回归确认**：变异体 POLARITY 把两处翻回 `fresh` 形式 → **5/5 全红，KILLED**。

### 13.3 同一轮的第二个真实产品缺陷：刷新失败会清空整个面板

修卡片的错误路径时发现：`refreshUsage` 的 catch 原先写 `[region]: { status: 'error', message }`，而 `WorkBuddyWebUsage` 的 error 变体在 `src/status-paths.ts` **只有 `{status; message}` 两个字段** → `accounts`/`pool`/`credits`/`models` 全被丢掉。又因为整个面板主体（账号选择器、积分、模型目录、`AccountPool`）gate 在 `status.status === 'signed-in'`（`src/client/WorkBuddyCard.tsx:1048`），**一次刷新失败 = 用户正在编辑的账号池整个消失**，且 dirty 标记与保存失败提示**一起消失**（STAGE 探针：`STAGE3 pool? false dirty? false stale? false err? true`）。

**项目已有的正确范式**：`src/status-paths.ts:424-426` 早有 `creditsError?` / `checkin?` / `checkinError?`——即**signed-in 快照 + 分区错误叠加**。

**先试后否的方案（教训）**：先尝试"合并 spread + `as WorkBuddyWebUsage`"并用 `carriesData` 放宽大 gate → **放弃**：error 变体没有 `credits` 等字段，放宽 gate 引发一连串 `TS2339: Property 'credits' does not exist on type '{ status: "error"; message: string; }'`（`:1059`/`:1064`/`:1103`/`:1109`），需要满屏 cast。已全部回退（`grep -c carriesData` = 0）。

**最终修复**：`src/status-paths.ts` 的 signed-in 变体新增 `refreshError?: string`（插在 `creditsError` 之后）；卡片 catch 改为"**有数据就叠加，没数据才塌缩**"：

```ts
const message = error instanceof Error ? error.message : t('row.requestFailed')
setStatusByRegion(prev => {
  const previous = prev[region]
  if (previous !== undefined && previous.status === 'signed-in') {
    return { ...prev, [region]: { ...previous, refreshError: message } }
  }
  return { ...prev, [region]: { status: 'error', message } }
})
```

渲染处紧跟 `status.creditsError` 分支之后（`src/client/WorkBuddyCard.tsx:1142-1143`）加 `{status.refreshError === undefined ? null : <p className="dsm-workbuddy-usage-error" role="alert">{t('row.requestFailedHint', { message: status.refreshError })}</p>}`。**同一写法**（`refreshModels` catch，`src/client/WorkBuddyCard.tsx:646`）一并修掉并加注释 `same merge-not-replace rule`。新增双语键：`src/client/locales.ts:50` `'row.requestFailedHint': 'Refresh failed — showing the last loaded data: {message}'`；`:247` 中文同义。

### 13.4 渲染测试基础设施（本轮唯一的工程投入）

- **依赖**：`jsdom@^29.1.1` + `react-dom@18.3.1` + `@types/react-dom@18.3.7`（**18.3.39 不存在**）。
- **接线**：`vitest.config.ts` 的 `include` 加 `'tests/**/*.spec.tsx'`；`.tsx` 用 `// @vitest-environment jsdom` 文档块自选 jsdom，其余文件仍走 `node`。根 `tsconfig.json` 的 `exclude` 与 `tsconfig.client.json` 的 `include` 都改为四项：`["src/client", "tests/pool-render-helpers.tsx", "tests/pool-render.spec.tsx", "tests/pool-card-render.spec.tsx"]`（漏掉新文件会报 `TS6142: … '--jsx' is not set` 与 `Cannot find name 'HTMLInputElement'`）。
- **`tests/pool-render-helpers.tsx`**：`globalThis.IS_REACT_ACT_ENVIRONMENT = true`；`createRoot`；保 key 的翻译器 `t → key|param=value`；`mount(Component, props)` 返回 `{container, update(next), unmount(), text(), html(), buttons(), button(needle), input(), checkboxes(), toggles(), click(el), type(text), clear(), blur(), settle()}`。`:27` 的 `const act = React.act ?? react-dom/test-utils.act` 是**模块私有、不 export**——所以异步刷新只能走 `settle()`（`:147`，循环 5 次 `await act(async () => { await new Promise(r => setTimeout(r, 0)) })`，用于排空在 act 作用域**之外**启动的浮动 promise，例如卡片的 `useEffect` 里 `void refreshUsage(...)`）。另有 `fakeScope(initial = {}, failWrites = false)`、`stubFetch(answer)`、`poolOf` / `accountOf` 夹具。
- **两个把首次运行全弄红的 jsdom 事实**：(1) React 受控输入需要绕过原生 setter——`Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set` 后 `dispatchEvent(new window.Event('input',{bubbles:true}))`；(2) React 的 `onBlur` **走冒泡的 `focusout`** 委托——必须 `dispatchEvent(new window.FocusEvent('focusout',{bubbles:true}))`。
- **`tests/pool-render.spec.tsx`（13 用例）**：覆盖 A-4 逐键原文显示（`'1'`/`'12'`/`'120'`）、`'1'` 提交 5 但显示 `'1'`、清空不跳回 5、blur 复显已提交、`9999` blur 恰好收敛到 `1440` 一次、保存三态、批量成功 `onRefresh` 恰好一次 / 失败从不、ghost 计数、D5 陈旧闭包、H-1 强形状、纯 ghost 池禁用两个批量按钮。
- **`tests/pool-card-render.spec.tsx`（5 用例）**：挂载真实 `WorkBuddyCard`，按 URL stub fetch；用例分别是"应用取回的 usage 快照（M19）"、"重读失败不得丢弃草稿（M15，并断言 `row.poolTitle`/`row.creditsTotalLabel`/`row.requestFailedHint|message=HTTP 500` 仍在）"、"批量成功后重读（M18）"。

### 13.5 本轮变异确认总表（全部串行执行）

| 变异体 | 恢复的缺陷 | 结果 | 决定性断言 |
|---|---|---|---|
| POLARITY | `stale` 翻回 `fresh`（我发布的 P0） | **KILLED 5/5** | `to contain 'row.signedIn'` ×4 + `no button containing "row.poolCheckinAll"` |
| M19 | usage 快照从不落到 state | **KILLED 5/5** | 同上 |
| M15 | 刷新失败塌缩成裸 error 变体 | **KILLED 1/5** | `to contain 'row.poolSaveDirty'` |
| M18 | 批量后不重读 | **KILLED 1/5** | `expected 2 to be greater than 2` |
| M39 | 批量**失败**也重读 | **KILLED 1/14** | `expected "vi.fn()" to not be called at all, but actually been called 1 times` |
| M16 | 写入失败仍清空草稿 | **KILLED 2/14** | `to contain 'row.poolSaveDirty'` |
| M14 | 三态 `onSaved` 兜底被删 | **KILLED 1/14** | `to contain 'row.poolSaveDirty'` |
| M21 | 公告计数读草稿而非已存池 | **KILLED 1/14** | `expected 'row.poolLogCheckinStart\|count=0' to contain '\|count=1'` |
| M22 | `effectiveMembers` 输入被冻结 | **KILLED 5/14** | `expected +0 to be 1` |
| M35 | 渲染期读取冻结成陈旧值 | **KILLED 5/14** | `expected +0 to be 1` |
| M36 | checkin 503 的 `reason` 被删 | **KILLED 1/27** | `expected undefined to be 'pool-unavailable'` |
| M24 | checkin 503 的 `reason` 改成 `pool-failed` | **KILLED 1/27** | `expected 'pool-failed' to be 'pool-unavailable'` |
| M23 | `effectiveMembersOf` 偷偷排序 | **KILLED 2/65** | `expected [ 'a', 'b', 'c' ] to deeply equal [ 'c', 'a', 'b' ]` |

**两条必须记录的教训**：

1. **SURVIVED 不总是测试弱**。M35 第一次的补丁只是把 `pool` 起个别名 `poolAlias`——**行为上的 no-op**，套件全绿是**正确答案**。必须先自问"这个补丁真的还原了缺陷吗"，再判定守卫失察。
2. **工装漂移会伪造 SURVIVED**。M24 首轮报 SURVIVED，实因 `rsync -a --exclude node_modules /abs/tests/ tests/` 这种写法**没有落地**（目标副本停留在 09:20，新用例没被拷进去），被测的是旧套件。改成 `rsync -a --delete <src>/ ./<dst>/`（源与目标都带斜杠）并 `grep -c '<新用例名>'` 确认后才得到真结论。**任何"变异存活"的结论在写进报告前，必须先核对变异树里确实含有那个新断言。**

### 13.6 本轮新增的两条覆盖缺口（非变异，是缺失的断言）

- **N11 / M24 / M36**：`src/web-status.ts:857` 的 checkin 503 分支此前**没有任何断言**（`tests/pool-route.spec.ts:402` 只传过 `test: undefined`，从未传 `checkin: undefined`）。新增用例 `'answers 503 with an explicit reason when the CHECKIN route is unavailable'`，显式请求 `action=checkin` 并断言 `reason`。**注意**：checkin 与 test 两个分支**故意共用** `'pool-unavailable'`（都表示"这个构建没有该路由"），所以断言的是代码**实际发出的值**，其职责是让该行任何未来改动**大声失败**，而不是发明一个更漂亮的 reason 名。
- **N12 / M23**：`tests/account-pool.spec.ts` 里原有两个 `effectiveMemberAccountIds` 断言都是**单元素**、且两个"顺序"用例从不真正过滤掉任何 id，因此对"排序实现"**完全免疫**（无元素被过滤时，升序与调用者顺序一致）。新增 `'preserves order ACROSS a filter, not just in an already-listed set (N12/M23)'`，用**不在 listed 集合里的 id** 制造真实过滤，覆盖过滤后相对顺序、降序输入、重复 id 三种形状。变异体 M23 使**两个**用例同时失败（含原有的那个）。

### 13.7 变异工装（纪律）

`/tmp/r5-mut`（`rsync --delete` 副本 + 软链 `node_modules`）、`/tmp/r5-pristine`（`src`/`tests` 纯净快照）、`/tmp/r5-env.sh`（六个隔离环境变量，匹配 `vitest.config.ts:39`）、`/tmp/r5-run.sh <label> <mutating-cmd> [glob]`：补丁窗口前后全树 `sha256sum` 比对，相同即报 **NO-OP-PATCH**（是**错误**，绝不是通过）；随后串行跑套件，grep `Tests +N failed` → KILLED/SURVIVED；末尾从 pristine `rsync --delete` 恢复；并在前后比对**共享树**哈希，任何变化即 **HARNESS ERROR**（退出码 0=KILLED、3=SURVIVED、4=NO-OP-PATCH、5=harness error）。**变异体必须串行**——`tests/pool-e2e.spec.ts:403` 对负载敏感，4 路并行下会假失败（N15）。所有补丁一律包在 `( cd "$MUT" && … )` 里执行。

**收尾时清理**：本轮在共享树里发现两个前序探针遗留的 `tests/dbg-verify-claim*.spec.tsx`——它们会被 `tests/**/*.spec.tsx` 的 include 收进正式运行并让 `tsc -p tsconfig.json` 报 `TS6142`（因为不在 `exclude` 里）。已删除；临时探针一律用完即 `rm`。

### 13.8 状态

- 基线 655 tests / 29 files → **676 tests / 31 files 全绿**；`npx tsc -p tsconfig.json` 与 `npx tsc -p tsconfig.client.json` 均 EXIT=0。
- 负载敏感的调度器用例连跑三次 `tests/pool-e2e.spec.ts` 均 31 passed，确认前述失败是 N15 假象。
- I 报告点名的 18 个存活变异体中，本轮已确认击毙 13 个（含 POLARITY 这个新引入的 P0），并补上 N11 与 N12 两条缺失断言。
- **仍开放**：D3（`rate-limited` 有 30 分钟冷却而 `unavailable` 没有的修复不对称）、N5–N10 / N13 / N16 / N17；eslint `exhaustive-deps` 一项**有意不做**（本项目根本没有 eslint）。
  - ⚠️ **本行已被 §14（第六轮）取代**：上述 D3 与 N5–N10/N13/N16/N17 已全部结清，N15 亦已修。此处保留原文仅为记录当时的进度。
- 方法论结论（比单个缺陷更重要）：**"守卫读文本"与"缺陷住行为"之间必然有缝**。本轮把这条缝从"六个守卫被文本保留型变异击败"缩到"十四条断言实打实地红"，代价是引入 jsdom + react-dom 两个依赖——这个代价值得，因为它是这一整类缺陷的**终结**，而不是又一次正则升级。

## 十四、第六轮：结清 I 报告尾部、七条守卫缺陷与 D3

**背景**：§13.8 明确留了四笔账——**D3**（冷却不对称）、**N5–N10 / N13 / N16 / N17**（守卫仍然只读文本）、以及 I 报告 18 个存活变异体的尾部。本轮把四笔账一次结清。

### 14.1 先修工装：N15 是"假击杀"的来源

第一次跑幸存者矩阵时 **M22 被判 KILLED**，失败断言是：

```
FAIL tests/pool-e2e.spec.ts > the pool scheduler actually runs a due region
     > arms on the first tick, then probes and re-ranks once the interval passes
AssertionError: expected 0 to be greater than or equal to 1
```

这正是 I 报告 §5 的 **N15**：`tests/pool-e2e.spec.ts` 的调度器用例对负载敏感，固定 60 次 `setImmediate` 排空在 CPU 争用下不够，读到 0。

**为什么必须先修它**：这类失败的方向恰好是"看起来更强"——变异工装把它读成"守卫抓住了变异体"，于是**报告出并不存在的覆盖**。也就是说 N15 不是一条方法论注记，而是**本轮所有结论的前置条件**。不修它，本节其余每一个 KILLED 都不可信。

修法（正是 N15 的 fix direction）：新增 `flushUntil(settled, turns = 5000)`，**正断言排空到探针真的落地**为止；负断言给足预算（`flushRealWork` 默认 60 → 600 轮）。复跑 M22 → **SURVIVED**，与 14.5 的等价性分析一致。本节结束后全文扫描：**没有任何一条 round-6 日志再含调度器用例的失败**。

### 14.2 D3：调度器不再被陈旧的配置饿死（真实产品修复）

**根因**（`src/index.ts` 的 `runScheduledPoolTest`）：它在 `resolveTargetModel(...)` 没有解出 id 时提前 `return`——而"saved target 已离开 catalog"正是产出"无 id"的情形之一。于是一个**显示偏好**的错误冻结了整个区域的测量循环。

**不对称由此成立**：`exclusionOf` 对 `rate-limited` 读 `retryAtMs`，**时钟一到就自动回池**；`unavailable` 只能靠**新的探针**覆盖。探针不再写入 ⇒ `unavailable` 成员**永久挂起**，直到用户自己发现陈旧模型并手动改正。

**修法**：目标解析仍优先用户保存的模型；**当它陈旧时回落到该区域的免费模型**（`pickFreeModel`）。免费规则原样保留——没有零倍率模型时仍然整轮跳过，绝不在定时器上烧paid模型。

**与手动路径的分工（刻意不同）**：手动批量路由**继续**拒绝陈旧 target（`reason: 'target-model-stale'`，H-6 用例守住）。那里用户明确要求"测这个模型"，替换成别的模型是回答一个没被问的问题；而定时轮次无人提问，它的存在意义就是刷新池子自己的测量，**不该被一个它能绕开且零成本的配置错误饿死**。

**正/负配对**（新增两条 e2e）：`saved target 陈旧 + catalog 有免费模型` → 必须探（正）；`saved target 陈旧 + catalog 只有付费模型` → 必须不探（负）。变异体 `D3-revert` 恢复旧实现 → **KILLED 1**，命中的正是新 e2e。

**保留的取舍（明确记录）**：探针记录里**不含被测模型 id**，所以回落时写下的测量在卡片上仍按"该账号的测量"呈现。这是可接受的：探针文案描述的是**账号**能否服务（"连不上上游"），而不是模型；卡片同时已经在陈旧态显示 `staleTargetModelId` 提示用户改选。

### 14.3 七条守卫缺陷的处置（N5–N10 / N13 / N16 / N17）

原则沿用 §13.1：**缺陷住在行为里，行为只能由执行来断言**。因此分两类处理——能行为化的**行为化**，纯文本的**按报告给出的 fix direction 收紧**。

| 条目 | 性质 | 本轮处置 | 证据 |
| --- | --- | --- | --- |
| **N5** | D5 守卫按硬编码名单判派生绑定，别名即绕过 | 真缺陷形式（M12 / M21 / M35 / M41）全部由渲染用例击杀；**剩余别名形式 M20/M22 证为等价变异体**（14.5） | M35 KILLED 1、M41 KILLED 1 |
| **N6** | M-2 守卫只证"调用过"，不证"用了" | 按报告补**正向**断言：`toContain('setIntervalText(text)')` + 禁 `String(`；负断言不再锚在第一个 token 上 | M01 KILLED 4、M38b KILLED 5（渲染用例为主） |
| **N7** | L-5 守卫只查守卫**位置**，从不查 `fresh`/`stale` **是什么** | 新增：绑定必须是 `begin(region)` 的**结果**，且禁止 `const stale = () => …` 函数式 | 新变异体 `M19fn`（函数式探针，永远报 fresh）→ **KILLED 1** |
| **N8** | A-8 守卫读初值、读先后，**从不读 `catch`** | 新增：`committed = true` 必须**恰出现一次**且位置在 `} catch` **之前** | M16（catch 里置 committed）→ **KILLED 2**（守卫 + 渲染双保险） |
| **N9** | D6 守卫 `strip()` 去注释、**不去字符串字面量** | 新增 `stripLiterals()` 连字符串一起去；负断言从**变量名**改为**形状**（`accounts.filter(account => \w+.has(account.id))`） | M28（字符串 + 改名内联过滤）→ **KILLED 1** |
| **N10** | "恰一次"被重拼调用绕过 | 计数改为对**标识符**：`/onRefresh\s*\??\.\s*(?:\(|call\b|apply\b)/gu` | M39（`finally` 里 `onRefresh?.call(undefined)`）→ **KILLED 3** |
| **N13** | N1 三态只由源码文本钉住 | M15 / M18 已由 `tests/pool-card-render.spec.tsx` 行为击杀（§13.5）；本轮复核 M14 亦 KILLED 2（含卡片级用例） | R6-M14 / M15 / M18 |
| **N16** | D5 跳过规则是 **body-wide**，一个诱饵 lambda 即可关闭对该名的检查 | 决定性变异体 M41 已由**渲染用例**击杀。守卫残留弱点**不再对应任何未击杀缺陷**，因此不再用更复杂的文本分析去追（§13.1） | M41 KILLED 1 |
| **N17** | D5 守卫把**字符串里**提到的派生名当成读 → **正确代码被判红** | `stripLiterals()` 之后不再命中。这是一个**对照**而非变异体：合法代码必须在套件里保持全绿 | `CONTROL-N17-string` → 679 passed（**必须绿，已绿**） |

**为什么要修 N17 而不是容忍它**：一条会误杀正确代码的守卫，下一位维护者撞上它时最便宜的改法是**满足它**（把 `saved` 塞进依赖数组）——那既消掉了红，又让真正的陈旧类（N5/N16）保持原样，还留下一条"正在通过"的守卫。§13.2 的 P0 就是这条路径的成品。

### 14.4 本轮变异确认总表（全部串行执行）

基线：**679 tests / 31 files**，`tsc -p tsconfig.json` 与 `tsc -p tsconfig.client.json` 均 EXIT=0。

| 变异体 | 恢复的缺陷 | 结果 | 决定性断言 |
| --- | --- | --- | --- |
| M01 | A-4 逐键 clamp（三元包裹参数） | **KILLED 4** | `pool-render` A-4 逐键（`expected '5' to be '1'`） |
| M17 | 字段忽略原始输入（断言的文本只活在注释里） | **KILLED 4** | `pool-render` A-4 |
| M38b | 规则被**调用**但 `text` 被丢弃、clamp 手算 | **KILLED 5** | `pool-render` A-4 |
| M41 | D5 诱饵 lambda 关闭守卫（M12 的原缺陷） | **KILLED 1** | `pool-render` H-1（首次编辑的基准） |
| M35 | D5 解构别名（`editDraft`） | **KILLED 1** | `pool-render` H-1 |
| M14 | N1 bail-out 丢 `return` | **KILLED 2** | `pool-render` A-8/N1 + `pool-card-render` M15 |
| M28 | N3 委托装饰化（字符串 + 改名内联过滤） | **KILLED 1** | D6 守卫（`stripLiterals` 后） |
| M16 | A-8 在 `catch` 里置 `committed` | **KILLED 2** | A-8 守卫（新增"恰一次且不在 catch"）+ 渲染 |
| M39 | M-4 在 `finally` 里重喊 `onRefresh` | **KILLED 3** | M-4 守卫（标识符计数）+ 渲染 ×2 |
| `M19fn` | L-5 探针改成函数式，**永远报 fresh** | **KILLED 1** | L-5 守卫（新增 N7 绑定断言） |
| `D3-revert` | 调度器被陈旧 target 饿死 | **KILLED 1** | 新 e2e「陈旧 target 仍必须刷新测量」 |
| `SELECTALL-deps` | `selectAll` 丢 `pool` 依赖 | **KILLED 2** | 新渲染用例「刷新后全选按新名册」+ D5 prop 守卫 |
| `CONTROL-N17-string` | 合法代码在字符串里提到派生名 | **679 全绿**（对照，必须绿） | 假阳性已消除 |

**I 报告 18 个存活变异体的最终账**：第五轮 11 个（M14/M15/M16/M18/M19/M21/M23/M24/M35/M36/M39）+ 本轮 5 个（M01/M17/M28/M38b/M41）= **16 个已击杀**；余 2 个（M20/M22）为**等价变异体**。

### 14.5 两个等价变异体：M20 与 M22（不是覆盖缺口）

两者都以"守卫看不见的别名"形式存活，但**都没有恢复任何缺陷**，因此**没有任何行为测试能击杀它们**——这正是 §13.5 教训 1（"SURVIVED 不总是测试弱"，`poolAlias` 那次补丁是行为 no-op）的第二个实例。证明：

- **M22**（`const regionNow = region`，`runAction` 内 `logStore.set(regionNow, next)`）：`regionNow` 由 `region` 在同一渲染内初始化，而 `runAction` 的依赖数组**含 `region`** ⇒ `region` 变化必然重建回调 ⇒ `regionNow === region` 恒成立。**逐字等价**。
- **M20**（`const savedNow = saved`，`selectAll` 内追加 `targetModelId: savedNow.targetModelId`）：`saved` 只是 `pool` 的**纯函数**（`AccountPool.tsx:281-295` 只读 `pool?.…`），而 `selectAll` 的依赖数组**含 `pool`** ⇒ `saved` 变化必然重建回调。更进一步，写入的值与 `editDraft` 自身基准给出的相同——`savedRef` 由 `useLayoutEffect` 同步（`:477`），`draftBaseFor(...)` 用的 `savedRef.current` 与 `saved` 在点击时刻必然相等。**逐字等价**。

对照 §13.1 的判别标准：真正致命的是**依赖本身**，而不是读法。因此本轮补的是一条**行为**用例——「刷新后点全选必须勾上新出现的账号」——它钉住的正是那个能真坏的依赖：变异体 `SELECTALL-deps`（把 `pool` 从依赖数组里删掉）→ **KILLED 2**。

### 14.6 工装（第六轮）

`/tmp/r6-mut`（`rsync --delete` 副本 + 软链 `node_modules`）、`/tmp/r6-pristine`（`src`/`tests` 纯净快照）、`/tmp/r6-env.sh`（六个隔离环境变量，匹配 `vitest.config.ts`）、`/tmp/r6-apply.py`（**锚点必须恰好命中一次**，否则退出 9——静默 no-op 会被误记成"存活"）、`/tmp/r6-run.sh <label> <patch.json> [glob]`、`/tmp/r6-campaign.sh`（整轮串行）。

三个必须继承的纪律（都是前几轮的教训换来的）：

1. **NO-OP-PATCH 是错误，不是通过**（补丁窗口前后全树 `sha256` 比对）。
2. **共享树哈希前后比对**，任何变化即 HARNESS ERROR（退出码 5）。
3. **变异体串行**——调度器用例对负载敏感（N15）；本轮还额外验证了"所有日志中都不存在调度器用例失败"。

本轮踩到的一个**新**工装坑，记下来：`rsync` 时 `--exclude docs` 会让 `tests/platform-standing.spec.ts` 因**缺文件**而红（它读 `docs/WINDOWS.md` 等），于是每个变异体都被**无关原因**判红。**一个变异体只有在"失败原因恰好是它恢复的那个缺陷"时才算 KILLED**——所以工装必须包含测试要读的全部只读输入（`docs/` 等），并且每次击杀都要核对 FAIL 行。

### 14.7 状态

- 基线 676 tests / 31 files → **679 tests / 31 files 全绿**；两个 tsc 项目 EXIT=0（`pnpm run check` 含 build）。
- **D3 已修**（回落免费模型 + 正/负配对 e2e）；调度器不再被陈旧的显示偏好饿死。
- I 报告 18 个存活变异体：**16 击杀 / 2 等价**（M20、M22，附逐字等价证明）。
- N5–N10 / N13 / N16 / N17 **全部结清**（见 14.3 表）；N15 从"方法论条目"升级为**工装前置条件**并已修。
- **仍开放**：`eslint-plugin-react-hooks/exhaustive-deps`——**有意不做**（本项目没有 eslint；D5 的依赖完备性现已由 `tests/pool-render.spec.tsx` 的行为用例覆盖其真实风险面）。
