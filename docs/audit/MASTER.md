# 账号池客户端审计：汇总主报告

> 审计日期：2026-09-30 · 范围：`src/client/AccountPool.tsx`、`src/client/WorkBuddyCard.tsx`（池相关）、
> `src/client/account-selection.ts`、`src/status-paths.ts`、`src/web-status.ts`、`src/index.ts`（契约侧）。
>
> **方法**：三个审计员在互不重叠的写入范围内并行只读审计，第四名独立验证员对抗式复核。
> 环境无 `react-dom`/jsdom，故不做真实渲染：结论来自逐行精读 + 用 `node --experimental-strip-types`
> 挂载**真实插件**（真实 `apply()` + 真实路由 + 桩化 upstream）取实测输出 + 纯逻辑状态机复现。
>
> **只读保证**：审计窗口内 `src/` 零改动（多份报告记录审计前后哈希一致，Lead 独立复核确认）。

## 分报告

| 报告 | 范围 | 确认缺陷 | 复现结果 |
| --- | --- | --- | --- |
| [A-account-pool.md](A-account-pool.md) | `AccountPool.tsx` 组件逻辑 | 12（高 2 / 中 2 / 低 8） | 12/12 已复现（严格 11/12，A-4 数值失准） |
| [B-contract.md](B-contract.md) | 客户端 ↔ Host 数据契约 | 11（高 2 / 中 3 / 低 6） | 11/11 已复现（严格 11/11） |
| [C-interaction.md](C-interaction.md) | 活动记录 / 冲突提示 / 轮换上报 | 23（高 2 / 中 9 / 低 12） | 23/23 已复现（严格 23/23） |
| [LEAD-cross-layer.md](LEAD-cross-layer.md) | 跨层（草稿态→保存→Host 运行时） | 5（高 3 / 中 2） | 5/5 已复现（严格 4/5，L-5 范围） |
| [D-verification.md](D-verification.md) | 对抗式复现验证 | — | 裁决 51 条 |

原始条目合计 51 条，去重后见下方主清单。

## 〇、验证结论（最重要的一节）

**D 报告对抗式复核了全部 51 个编号：已复现 51 / 无法复现 0 / 结论相反的误报 0。**

这意味着上面的主清单**没有一条是凭空构造或与实际相反的**。需要留意的只有两类次要问题：

| 类型 | 条目 | 更正 |
| --- | --- | --- |
| 数值失准（结论仍成立） | A-4 | 报告写「想输 120 得 520」。真实受控输入会在回写值上追加，实测 `120 → 5→51→512→1440`（持久化 1440）。缺陷比报告更难用，但那张对照表不能用 |
| 覆盖范围不完整 | L-5 | 两条**保存**路径确无护栏，但**轮询/切标签**路径**有** `AbortController`（实测旧响应被 abort 丢弃）。范围应限定为「保存触发的刷新」 |
| 症状可达性偏宽 | A-10 | 函数确实错（`['a','a']` vs `['a','b']` → `true`），但需草稿自带重复 id，而三条编辑路径都去重，实际仅极窄巧合 |
| 判级放过（有修复影响） | A 的 V-1 | `siblingBusy` 双向互斥**确实生效**（实测），故 V-1 怀疑不成立；但 A 因此把整片区域判为「倾向不算缺陷」，**放过了同区域两个真缺口**：A-5 与 L-4 |

### 方法论更正（值得后续沿用）

A 与 C 都以「本项目没有 react-dom / jsdom」为方法边界并把条目降级为「待验证」。
**该前提可被解除**：`npm install react-dom@18.3.1 jsdom` 只需数秒（装在仓库外的 `/tmp`，不污染项目）。

D 因此把**真实的 `AccountPool.tsx` / `WorkBuddyCard.tsx` 用 react-dom + jsdom 渲染进真实 DOM**，
并让组件的 `fetch()` 走**真实挂载插件**的真实路由。A 的 V-1、C 的三条待验证项本可实测。
**建议：后续审计先尝试安装渲染依赖，再决定是否降级。**

### 只读与清洁性（Lead 独立复核）

- 9 个关键文件的 `sha256` 与 D 记录的基线**逐字符一致** → 审计全程未改 `src/`，报告行号有效。
- 仓库根目录无 `.mjs` 残留；`/tmp/dverify` 已删除；四份报告互不重叠、无写入冲突。

### 收口状态（后续轮次，截至 2026-09-30）

本 MASTER 记录的是**审计**结论（谁发现了什么）。**修复与验证**的逐轮账在
[E-fix-log.md](E-fix-log.md)，各轮独立验证的裁决在 F / G / H / I 四份报告里。当前状态一句话：

| 阶段 | 处置 | 报告 |
| --- | --- | --- |
| 第 1 轮 | 51 条缺陷**全部复现**（0 条误报） | A/B/C + D + 本文件 |
| 第 2–5 轮 | 修复 → 独立对抗验证 → 变异测试，共 **5 轮** | F / G / H / I |
| 第 5 轮 | 换掉武器：引入 `jsdom` + `react-dom`，**用真实渲染测试替代源码文本守卫** | E-fix-log §13 |
| 第 6 轮 | 结清 I 报告尾部 + 七条守卫缺陷（N5–N10/N13/N16/N17）+ **D3 真实产品修复** | E-fix-log §14 |

- 基线 **679 tests / 31 files 全绿**，两个 tsc 项目 EXIT=0（`pnpm run check` 含 build）。
- I 报告点名的 **18 个存活变异体：16 已击杀 / 2 为等价变异体**（M20、M22，附逐字等价证明）。
- 唯一有意不做的一项：`eslint-plugin-react-hooks/exhaustive-deps`（本项目没有 eslint）。

## 一、高严重级（去重后 6 条）

多条被**独立重复发现**，这提高了可信度。

### H-1 成员勾选会静默丢账号（A-1 / L-3 / C 修正）

`editDraft` 的 `useCallback` 依赖数组（`AccountPool.tsx:268-271`）只列了 4 个标量字段，
缺 `saved.memberAccountIds`，而函数体用整个 `saved` 作草稿基准。依赖未变时闭包保持过期基准，
勾选新账号会以**旧成员列表**为基础，保存即静默移出成员。

**触发**：审计 C 修正了 Lead 的判断——不需要第二个标签页，「保存一次勾选变更 → 再勾一个新账号」两步即可稳定命中
（`save()` 内先 `discard()` 使 `draftRegion` 变化 → `editDraft` 重建并捕获此刻的 `saved` → 重读落地后 6 个依赖全同）。

**已复现**（Lead 与 A 各自独立）：`['a']` → 勾 `c` → 得 `['a','c']`，`b` 静默丢失。

### H-2 「关闭自动轮换」立刻解禁手动下拉，但 Host 仍在轮换（A-2 / L-1 / C3-1）

`rotationLocked` 用**草稿**计算（`AccountPool.tsx:209,222`），而 Host 的 `applyRotation` 读**已保存配置**
（`index.ts:955-968`），`current()` 又优先返回轮换账号（`auth.ts:964-969`）。
点一次「关闭自动轮换」（`:507`，只写草稿）后下拉立即可点、冲突提示消失，但计费仍走轮换账号。

**后果**：用户选中账号 B → 卡片显示 B → 实际计费 A。**这正是模块头部注释声称要防的故障**
（`AccountPool.tsx:10-12`）。**已复现**（Lead 实测四步状态机）。

### H-3 关闭账号池后轮换 override 永不清理（C3-3）

`applyRotation` 仅在两条**测试**路径被调用（`index.ts:913`、`:1224`）。池被禁用后手动测试路由 409
（`web-status.ts:791-793`）、调度器也不再排期 → `store.rotatedAccountId`（`auth.ts:687`，进程内字段）
在整个插件生命周期内残留，`current()` 继续优先返回它。

**与界面承诺冲突**：`poolEnabledHint`「关闭时插件行为与从前完全一致：跟随你选择的账号」（`locales.ts:141/316`）。
**已复现**（Lead 实测：禁用后仍计费 Beta；显式清理才回到 Alpha）。

### H-4 `regions` 槽有第三个写入者，绕过串行化（L-4 / A 的 V-2）

同一槽三个写入方，只有两个受串行约束：

| 写入者 | 位置 | 受约束 |
| --- | --- | --- |
| 模型保存 | `WorkBuddyCard.tsx:1218` | ✅ |
| 池保存 | `AccountPool.tsx:737` | ✅ |
| **tab 供应商开关** | `WorkBuddyCard.tsx:856` | ❌ 仅 `togglingRegion` |

Host 的 `__save` 按**区域**合并（`web-status.ts:840-843`），故 tab 开关带过期快照落地会回退并发保存。
**已复现**（Lead 实测：池保存得 `['a','b']`，tab 开关落回 `['a']`，`b` 丢失）。

> 这条是**我上一轮修复的缺口**：我加了 `siblingBusy` 串行，但漏了第三个写入者。

### H-5 成员指向已消失的登录 → 界面放行、Host 静默跑空批（B-1）

Host 只按当前登录过滤成员（`index.ts:1033-1040`），但**过滤结果不回流**到下发字段
（`web-status.ts:617` 发的是未过滤偏好），于是同一文档里 `memberAccountIds` 与 `accounts[].member` 互相矛盾。

**实测**：`memberAccountIds: ["ghost-id"]`、`accounts: [{member:false}]` → 界面渲染「已选 1 / 共 1」、
按钮可用、唯一一行未勾选；点「全部签到」得 `200 {"rows":[]}`、**零上游请求**，日志却打印「签到完成」。

### H-6 `targetModelSource: 'preferred'` 可以是目录里不存在的模型（B-2）

`resolveTargetModel`（`account-pool.ts:379-388`）对 preferred id **只判空、不校验存在于目录**，
故 `'none'` 只在 preferred 为空时产生。客户端按钮禁用条件只拦 `'none'`（`AccountPool.tsx:422`），
Host 路由同样只判 `modelId === undefined`（`web-status.ts:807-822`）→ 一整类错误被放行。
**实测**：保存一个已消失的模型 id → `source:'preferred'` + 目录中不存在的 id，按钮可用。

## 二、中严重级（去重后 9 条，摘要）

| 编号 | 问题 | 位置 |
| --- | --- | --- |
| M-1 | 批量按钮按**草稿**判定、动作按**已保存**成员执行 → 显示「已选 2/5」同时弹 409 | `AccountPool.tsx:413` |
| M-2 | 间隔输入框**每次按键** clamp → 想输入 120 得到 520；清空即变 5 | `AccountPool.tsx:685-699` |
| M-3 | 两种 409 不区分、**不本地化**（中文界面蹦英文长句）；「无成员」的真实触发路径是草稿未保存 | `AccountPool.tsx:344`、`web-status.ts:791-798` |
| M-4 | 批量成功后**不重读** usage → `probe` / `rotatedToAccountId` 最多 60 秒才上屏 | `AccountPool.tsx:323-381` |
| M-5 | 每次轮询对**全池每账号**发一次签到状态请求 → 10 账号池约 14,400 次/天 | `index.ts:873-883` |
| M-6 | 每次（重新）挂载凭空写一条「从 — 切换到 X」假记录；折叠卡片即卸载重来 | `AccountPool.tsx:191,256-266`、`WorkBuddyCard.tsx:832` |
| M-7 | 轮换**回退**（override 清空）不记录且 ref 不清 → 同一账号再轮换完全不记录 | `AccountPool.tsx:258` |
| M-8 | 日志与 ref **不按 region 隔离** → 切 tab 写假记录，而文案称两池「完全独立」 | `AccountPool.tsx:191,255-256` |
| M-9 | 「没有可用账号」警告的 `usable` 用**整表**（含未入池行，永不带 `excludedBy`）→ 只要有任一未入池账号，该警告**永不出现** | `AccountPool.tsx:221`、`web-status.ts:578-586` |

其余中级：C1-1（批量失败只留「开始」不留失败行）、C3-2（「放弃修改」静默撤销解锁）、C3-4（锁定态下拉显示 A 而计费 B）、C4-1（手动切换从不入日志，与「每次切换都会留下记录」冲突）、C4-2（`targetLabel` 死代码 → 从不说明目标模型来源）、L-5（两次 `refreshUsage` 无请求序护栏）。

## 三、低严重级（摘要，共 26 条）

代表性条目：

- **A-5** 保存进行中仍可编辑，成功后无条件 `discard()` 吞掉期间的新草稿。
- **A-6** 草稿只有一份，跨 tab 编辑会覆盖另一区域的未保存草稿。
- **A-7** `memberAccountIds` 含幽灵账号时计数/警告/按钮/日志同时失真。
- **A-9 / C4-2** `targetLabel` 死代码 + `poolTargetFree`/`poolTargetPreferred` 两条孤立文案。
- **A-10** `sameIds` 对重复 id 不可靠。
- **A-11** `row.result.outcome` 未校验解引用，`result` 缺失时抛错且不写完成日志。
- **A-12** 目标模型下拉缺失效值占位项，显示与存储值分叉。
- **B-6** `accounts[].member` 下发但从不读（与 H-5 同根因）。
- **B-7** `catalog` 声明可选但 Host 永不省略，客户端把「未读取」与「确实为空」当同一件事。
- **B-9** `CheckinRow.streakDays` 下发不消费。
- **B-10 / C4-4** 未知态 tooltip 串了「尚未测试」语义。
- **B-11** 两个响应信封类型无人 import，客户端用匿名 `as` 断言绕过 strict。
- **C1-3** 「清空」在批处理进行中不禁用，清空后新行随即出现。
- **C1-4** 日志 key 含 index，每次追加重挂载整个列表（确认不会重复 key）。
- **C1-5** 未读 Host 返回的权威 `modelId`，「开始测试 × 模型」可能报出非本次实际模型。
- **C2-4** `from` 名为空串时不套占位符（与 `to` 分支不一致）。
- **C4-5** 头部显示「目标模型 自动」，同屏下方却显示「暂无免费模型」。
- **C4-6** 按钮禁用理由与实际判定源不符（两方向都错）。
- **C4-7/8/9** 自动测试还要求区域开关、排除原因有第四种 `unusable`、排序还有 token 过期与 id 两个键——均未在文案中说明。
- **C4-10** `poolManualLockedHint` 声称的保护在两种情形下失效。
- **C4-11/12/13/14** ✅ 四条文案与实际行为**一致**（经核对，勿改）。

## 四、明确排除（经审查**不是**缺陷，勿按缺陷修改）

这些是审计过程中专门核查并排除的疑点，记录在此避免后续误改：

- `onBusyChange` / `onRotationChange` **不会**无限循环（父传 `setState` setter，引用稳定；`poolBusy` 不回灌本组件）。
- `unmount` 时的 `onRotationChange(false)` 清理**正确**（`AccountPool.tsx:230-233`）。
- `outcomeText` 的 `default` 分支**就是** `'failed'` 分支，非漏判。
- 批量按钮**有意**不检查 `settingsScope`（批量不写偏好，是有意的非对称）。
- 组件未按 `region` 加 `key` 本身不是缺陷（真问题是 M-8 的状态不隔离）。
- `siblingBusy` 互斥逻辑**两侧闭合**（无 react-dom 无法实测渲染，但逻辑上成立）。
- `checkedInToday`、`excludedBy`、`probe.retryAtMs`、`rotatedToAccountId`、`credits/expiringSoon/nearestExpiryMs`
  五项「缺失 vs false」语义**全部正确**，客户端没有把缺失误当 false/0。
- `creditMultiplier` 的「缺失 ≠ 免费」在两侧都被正确尊重。

## 五、建议修复顺序

1. **H-1 / H-2 / H-3 / H-4**（计费语义与数据丢失，且相互关联）。
   - **H-1**：Lead 实测两种修复都有效——补 `saved.memberAccountIds` 进依赖数组，或改用 `setDraft` 函数式更新
     （`setDraft(prev => edit(prev ?? saved))`）。后者更稳（不依赖依赖清单手工维护，正是本缺陷的根因），推荐。
   - **H-2**：建议让 `rotationLocked` 读**已保存值**（`saved.enabled && saved.rotateByCredits`），
     使「界面允许的操作」与「Host 会执行的操作」始终一致；代价是点「关闭自动轮换」后下拉要等保存才解锁——
     但这是**诚实的**，因为 Host 确实还在轮换。
   - **H-3**：需在禁用路径也调用清理（`setRotatedAccount(undefined)`），不能只在测试路径。
   - **H-4**：把串行门控扩展到第三个写入者（`saving`/`poolBusy`/`togglingRegion` 三者互斥）；
     更根本的做法是 Host 侧改**按字段**合并而非按区域替换，但属契约变更，影响面更大需单独评估。
2. **H-5 / H-6**（界面放行但实际无效）。H-5 应让过滤结果回流到下发字段；H-6 应校验 preferred id 在目录内。
3. **M-1 ~ M-9** 按影响面逐个处理，其中 M-3（英文错误串）与 M-5（每轮询 N 次请求）用户可感知。
4. 低严重级中 **A-9 / C4-2**（死代码 + 孤立文案）与 **A-10**（`sameIds`）是顺手可清的。

## 六、流程改进建议

本轮暴露的系统性模式：**手工维护的依赖清单 / 判定清单与实际使用的状态不同步**
（H-1 的依赖数组、H-2 的判定基准、H-4 的写入者清单）。建议：

1. 开启 `eslint-plugin-react-hooks` 的 `exhaustive-deps`（两个 tsconfig 目前都未开 `noUnusedLocals`，
   这也是 A-9 死代码没被 `tsc` 捕获的原因）。
2. 对「共写一个 settings 槽」的写入者建立清单式约束（H-4 正是因为清单不全）。
3. 卡片内任何「界面状态」与「运行时状态」分属不同来源时，加注释说明以哪个为准（H-2 的根因）。
