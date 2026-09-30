# 审计 A：`AccountPool` 组件逻辑

**审计对象**：`src/client/AccountPool.tsx`（805 行，新增未跟踪文件）
**只读约束**：未修改 `src/` 下任何文件；本次审计只新增本报告（`git status` 已确认）。
**方法**：静态精读为主；对草稿状态机用**纯逻辑复现**（把 `useState`/`useCallback` 的闭包与依赖比较语义逐帧照抄成 60 行 JS，用 node 跑；不依赖 react-dom）。复现脚本写在 `/tmp` 并已删除，仓库内无遗留。
**审计基线（sha256，前 12 位；行号以此为准）**：

| 文件 | 基线 |
| --- | --- |
| `src/client/AccountPool.tsx` | `b5a8117521d1` |
| `src/client/WorkBuddyCard.tsx`（父组件，仅用于核对契约） | `755dcc61160d` |
| `src/client/account-selection.ts` | `825878bc073e` |
| `src/web-status.ts` | `034c4a327dd0` |
| `src/status-paths.ts` | `bfa7467eb433` |
| `src/index.ts` | `9f470926f0cb` |

> 另两位同伴若改动 `WorkBuddyCard.tsx` / `web-status.ts`，本报告中"跨模块"引用的行号可能漂移；`AccountPool.tsx` 的行号以基线哈希为准（该文件不在他人写入范围内）。

**结论**：确认缺陷 **12** 条 —— 高 **2** / 中 **2** / 低 **8**；另有"已排除疑点"10 条、"待验证"6 条（含 2 条跨模块）。

**本组已有的测试覆盖（避免下游把已覆盖设计当新缺陷）**：`tests/pool-route.spec.ts`、`tests/pool-e2e.spec.ts`、`tests/account-pool*.spec.ts` 全部是 Host 侧；仓库**没有组件级测试**（`tests/searched-paths.spec.ts:6` 明确写着本项目没有 jsdom 也没有 react-dom）。因此下面每一条都是"Host 已正确防住、但客户端仍会把用户带到那个错误面前"或纯客户端状态机问题。

---

## 一、确认缺陷

### A-1（高｜逻辑·stale closure）`editDraft` 依赖数组漏掉 `saved.memberAccountIds`，草稿基准对象会陈旧，成员被静默丢弃

- **位置**：`AccountPool.tsx:268-271`（依赖数组），`:201-207`（`saved` 每次渲染都是新对象），`:268-270`（闭包体用 `saved` 做兜底基准），`:305-312`（`toggleMember` 经它落笔）
- **问题**：`editDraft` 的依赖是 `[draftRegion, region, saved.autoTestIntervalMinutes, saved.enabled, saved.rotateByCredits, saved.targetModelId]`，**没有 `saved.memberAccountIds`，也没有 `saved` 本身**。React 只在依赖变化时重建回调，所以只要那 4 个标量字段不变，回调就继续持有**若干帧之前**的 `saved` 对象；而它恰恰是这个函数在 `draft === null` 时的**兜底基准**：`edit(previous !== null && draftRegion === region ? previous : saved)`。
- **为什么是缺陷**：同一个渲染里存在两个不同的 "saved"：`dirty`（`:210-218`）用的是**本次渲染的新鲜 `saved`**，`editDraft` 用的是**陈旧闭包里的 `saved`**。两者不一致时，用户看到"未保存的点已勾上"，而草稿实际基于旧成员表。成员表被写回 Host 后会**永久丢失**账号，且全程没有任何报错。
- **复现（自足，不需要外部写入者）**。用纯逻辑复现（脚本已删）逐帧跟踪：

  1. `pool.memberAccountIds = ['a']`，4 个标量字段此后一直不动。勾选 `b`（草稿 `['a','b']`）→ 点保存 → 写入校验通过 → `discard()`（`:289`）→ `onSaved()`（`:294`）触发 `refreshUsage`（父组件 `:1241`）。
  2. `discard()` 把 `draftRegion` 从 `'cn'` 改回 `undefined`，这一帧依赖变化 → 回调**重建**，但此时 `pool` prop 还是旧的，捕获的仍是 `memberAccountIds: ['a']`。
  3. 刷新落地：`pool.memberAccountIds = ['a','b']`，4 个标量**完全没变** → 依赖无变化 → 回调**不重建** → 陈旧基准 `['a']` 就这么留下了。逐帧输出：
     ```
     R2: editDraft RECREATED, base.members=["a"]
     R3: editDraft RECREATED, base.members=["a"]
     R4: editDraft REUSED,    base.members=["a"]   <- 刷新已落地，基准仍是旧的
     ```
  4. 再勾选 `c` → 草稿 = `["a","c"]`，**`b` 被丢掉**（期望 `["a","b","c"]`）。此时 `dirty` 为 true，用户再点一次保存，`b` 的成员资格就被真正写没了。

  - 变体（同一根因，更容易撞上）：外部写入者（另一个窗口的卡片、手改配置、其他工具）改了成员表 → 60 秒轮询把新 `memberAccountIds` 拿回来，标量不变 → 陈旧基准 → 下一次**任何**草稿编辑（不只是复选框；`enabled`/`rotateByCredits`/`autoTestIntervalMinutes`/`targetModelId` 的开关、数字框、下拉，以及「关闭自动轮换」，都走 `{...current, x}` 这种基于兜底基准的写法，会把旧成员表一起带上）都会把外部新增的成员重新抹掉。
  - `selectAll`（`:315-320`）依赖里含 `pool`，每次轮询都重建，因此**不受影响**；受害路径只有 `editDraft` 的兜底分支。
- **修复方向（已验证有效）**：把 `saved.memberAccountIds` 加进依赖数组即可（同一复现脚本改为含该依赖后输出 `["a","b","c"]`）；更稳的做法是让兜底基准不来自闭包（例如用 ref 或在 setter 外先算好 base）。
- **注意不要误改成**："把 `saved` 加进依赖"（`saved` 每次渲染都是新对象 → `editDraft` 每帧重建 → 会连带每次轮询都重建，虽然正确但会放大下游 `toggleMember`/`selectAll` 的 identity 抖动）。加**字段级**依赖（含 `memberAccountIds`）才是最小改动。

### A-2（高｜逻辑·契约违背）`rotationLocked` 用**草稿**计算，而 prop 文档承诺报的是**已提交**状态 —— 一键"关闭自动轮换"会立刻把手动下拉放开，Host 却仍在轮换

- **位置**：`AccountPool.tsx:222`（`const rotationLocked = active.enabled && active.rotateByCredits`，`active` 是草稿）、`:230-233`（上报 effect）、`:94-100`（prop 文档："Reports the **committed** rotation state"）、`:504-509` / `:507`（`onUnlock`）、`:758-770`（冲突提示与解锁按钮）
- **问题**：上报给父组件的锁状态取自 `active`（草稿优先，`:209`），而**运行时是否真的在轮换**由 Host 读取**已存储**的偏好决定（`src/index.ts:955-963` `applyRotation` → `if (!preferences.enabled || !preferences.rotateByCredits) store.setRotatedAccount(undefined)`，即真正停轮换必须让存储值变 false）。第 767-769 行的"关闭自动轮换"按钮只改草稿（`:507`），**不写盘、不保存**，于是下一帧 `rotationLocked` 变 false → effect（`:230-233`）把 false 报给父组件 → 父组件的手动账号下拉（`WorkBuddyCard.tsx:916` `disabled={switchingAccount || !canWrite || poolRotationLocked}`）**立即恢复可点**；父组件没有第二道防线（`switchAccount` 里不检查轮换，见 `:900-935`）。
- **为什么是缺陷**：这就是本模块头部注释（`:10-12`）声称它存在就是为了防的那个故障——"自动轮换开启时上方的手动账号下拉必须停用，否则会出现'下拉显示 A、实际计费 B'"。解锁后用户选中账号 B → 卡片显示 B → Host 仍在按积分轮换 → 实际计费 A。触发只要**一次点击且不用保存**。
- **复现**：卡片上开启「按积分自动轮换」并保存（存储值 true）→ 重开卡片，池区显示"自动轮换中"、手动下拉被禁用 → 点池区冲突提示里的「关闭自动轮换」→ 手动下拉立刻可点 → 选另一个账号 → 观察卡片显示与 Host 侧日志中的实际计费账号不一致（Host 仍轮换）。
- **反向（过度加锁，无害）**：在草稿里把轮换打开但未保存，下拉会提前被禁用。这也是"锁跟草稿走"的证据。
- **修复方向**：`rotationLocked` 用 `saved.enabled && saved.rotateByCredits`（已提交值）计算；解锁按钮若要"一步到位"，应改成保存后再解锁（或至少在下拉旁明确提示"保存后生效"）。

### A-3（中｜逻辑·判定基准不一致）批量按钮的可用性看**草稿**，动作却按**已保存**成员执行 → 卡片显示"已选择 2/5"的同时弹出 Host 的 409

- **位置**：`AccountPool.tsx:413`、`:419-422`（`disabled` 用 `active.memberAccountIds.length` / `active.enabled`）对 `:328`（日志计数用 `saved.memberAccountIds.length`）、`:322-340`（请求体不带成员，Host 只认自己存的那份）
- **问题**：Host 端在执行前重新读**存储的**偏好做两道闸：`src/web-status.ts:789-800` —— `!pool.preferences(region).enabled` → 409 `account pool is disabled for this region`（`:792`）；`memberAccountIds.length === 0` → 409 `no accounts are checked into this region's pool`（`:799`）。客户端却按草稿判断按钮能不能点。
- **为什么是缺陷**：`:410-412` 的注释自我描述为"buttons act on checked accounts only"，与 `:328` 的实际基准矛盾。用户会看到**互相否定**的两块 UI：表格里 2 个账号勾着、右上角"已选择 2 / 5"、按钮可点，点下去却是一条红色英文报错说"没有勾选任何账号"。两个变体都有 Host 测试固定该行为：`tests/pool-route.spec.ts:237-259`（池被关掉仍被请求）与 `:289-321`（成员为空）。
- **复现**：卡片里勾选 2 个账号但**不点保存** → 一键签到按钮为可点状态 → 点击 → `actionError` = `no accounts are checked into this region's pool`。或：在草稿里把池开关打开（存储仍为 false，未保存）→ 按钮可点 → 点击 → 409 `account pool is disabled for this region`。
- **加重项**：`:344` 直接把 Host 的英文错误串当用户文案（`body?.error ?? \`HTTP ${status}\``），中文界面下也是英文原文。
- **修复方向**：批量按钮的 `disabled` 与 `runAction` 的计数都改用 `saved`（并在有未保存成员改动时就近提示"先保存"）；或让 `runAction` 先确保草稿已落盘。

### A-4（中｜逻辑·受控输入）间隔数字框每次按键都 clamp，想输入 120 会得到 520；清空立即变 5

- **位置**：`AccountPool.tsx:685-699`（`onChange` 内 `Math.min(1440, Math.max(5, Math.round(parsed)))`），受控值在 `:691` `value: String(active.autoTestIntervalMinutes)`
- **问题**：clamp 在**每次 keystroke** 上执行并立刻写回受控 value，而 `<input type="number">` 在输入过程中会经过"前缀"状态。前缀 `< 5` 会被改写成 5 并覆盖用户已键入的文本；另外 `Number('') === 0`，`Number.isFinite(0)` 为 true，所以 `:695` 的守卫拦不住"清空"，清空即被写成 5。
- **为什么是缺陷**：静默产生用户没输入过的值并被保存（`autoTestIntervalMinutes` 直接决定 Host 调度间隔，520 分钟 ≈ 8.7 小时不测试，轮换排序会长期停留在过期数据上）。
- **复现**：全选数字框内容 → 依次键入 `1`、`2`、`0`。第 1 次按键后字段就被改成 `5`（受控值覆盖 DOM value，光标随之落到末尾），后续按键变成追加：`5`→`52`→`520`，最终字段与草稿都是 **520**，而用户想输入的是 **120**。受影响的是所有**首字符为 1–4** 的输入：想输 `30` 得到 `50`、想输 `45` 得到 `55`、想输 `12` 得到 `52`、想输 `1200` 得到 `5200`（再被上限截成 `1440`）；首字符 ≥5 的输入（`50`、`90`、`600`）正常。
- **修复方向**：草稿里保留原始字符串/在 `onBlur`（或 `onChange` 但仅在值合法时）clamp，允许中间态为 `''`。

---

## 二、确认缺陷（低）

### A-5（低｜时序）保存进行中草稿控件仍可编辑，成功后 `discard()` 无条件丢弃这期间产生的新草稿

- **位置**：`:289`（`discard()`）与唯一被 `saving` 闸住的两个控件 `:737`、`:743`；未被闸住的编辑入口：`:413/421`（批量）、`:461/467`（全选/全不选）、`:556`（行复选框）、`:650`（开关）、`:692`（间隔）、`:712`（目标模型）、`:767`（解锁）
- **问题**：`saving` 只禁用"保存/放弃"两个按钮，其余控件照常可编辑；写成功后的 `discard()` 清的是**当前**草稿（`setDraft(null)`），而不是"这次保存的那份快照"。
- **为什么是缺陷**：窗口 = 一次校验写入的 RTT（`account-selection.ts:152-171` 一次 host 端点往返 + 可能的 `scope.set`；`web-status.ts:834-886` 是一次 `settings.mutate`，无重试但含落盘）。本机通常数十毫秒，用户"点保存后顺手再勾一个"有机会命中；命中后那次编辑**静默消失**，`dirty` 变 false，没有任何提示（草稿是唯一副本，符合 `:286-288` 自己写的"不可恢复"标准）。
- **复现**：点保存，在按钮回到"保存"字样之前立刻点另一个账号的复选框 → 写入成功后该勾选消失、界面回到保存前的值。
- **修复方向**：在 `saving` 期间禁用编辑类控件；或 `setDraft(prev => prev === snapshot ? null : prev)`（按快照身份丢弃，保留期间的新编辑）。

### A-6（低｜草稿隔离·单槽）草稿只有一份：在另一个 tab 上编辑会静默覆盖另一区域的未保存草稿

- **位置**：`:186`（单个 `draft` state）、`:194` + `:209-210`（隔离靠 `draftRegion` 比对）、`:268-270`
- **问题**：`draft` 是单槽 + 一个 `draftRegion` 标签。隔离判定本身**是正确的**（`:268-270` 的 `draftRegion === region` 守卫，且 `draftRegion`/`region` 都在依赖数组里，所以"草稿串区域"这个怀疑不成立）；但在 B 区编辑会把 A 区的草稿整个替换掉。
- **为什么是缺陷**：与本卡片自己的约定不一致——父组件对模型草稿是**按区域分别保存**的（`WorkBuddyCard.tsx:306-307`："a draft on one tab is never dropped by switching to the other tab"）。切回 A 时草稿已不存在，`dirty` 直接为 false（`:210`），用户看不到任何"你的修改没了"的提示。模块头部注释只承诺"不会把一区的未保存修改带到另一区"，这条不违反字面承诺，但违反卡片既有语义。
- **复现**：在 CN 勾选若干账号（不保存）→ 切到 Global → 勾选任意账号 → 切回 CN：此前的勾选全部消失，且没有未保存提示。
- **修复方向**：`draft` 改成按 region 的 map（与父组件 `drafts` 同构）；若确实有意单槽，请在注释里写明"在另一区编辑会丢弃本区草稿"。

### A-7（低｜边界）`memberAccountIds` 含已消失账号时：计数、警告、按钮、日志同时失真

- **位置**：`:454-457`（`count: active.memberAccountIds.length, total: pool.accounts.length`）、`:487-490`（无选择警告判据是 `length === 0`）、`:413/421`（按钮判据同样是 `length`）、`:328` + `:326-327` 的注释（"Count the CHECKED accounts: they are what the batch will actually touch"）
- **问题**：Host 侧 `poolMemberAccounts` 会按**现存账号**过滤（`src/index.ts:1037-1039`：`return accounts.filter(account => wanted.has(account.id))`），而客户端全程只数 `memberAccountIds.length`。当存储的成员里有已被删除的登录（其注释 `:1036` 明确承认这会发生：a removed sign-in cannot linger），会出现：`已选择 2 / 1`（count > total）、整张表所有复选框都没勾、"没勾任何账号"的警告不出现、按钮可点；点下去 Host 以 200 + `rows: []` 返回（`src/account-pool-run.ts:93-105` 空目标就是空数组），客户端日志却按 `:328` 报"签到开始（2 个账号）"再报"签到完成"——`:326-327` 注释声称这个数就是"实际会被处理的账号数"，与实现不符。
- **复现**：先勾选账号 A 和 B 并**保存**（存储成员 = {A,B}）→ 在 WorkBuddy 侧删掉 B 的登录 → 刷新卡片：列表只剩 A 一行，A 的复选框仍是勾的；但计数是 `active.memberAccountIds.length = 2` 对 `pool.accounts.length = 1` → 显示 **"已选择 2 / 1"**。若删掉的是**唯一**成员：列表可能仍有其他未勾选账号，则所有复选框都未勾、"没勾任何账号"的警告（判据是 `length === 0`，实际为 1）不出现、按钮仍可点，点下去日志报"签到开始（1 个账号）"。
- **修复方向**：计数与判据统一改为"现存账号 ∩ 成员"（`pool.accounts.filter(a => active.memberAccountIds.includes(a.accountId)).length`），并在有幽灵成员时提示。

### A-8（低｜时序）保存成功后的 `discard()` 早于刷新落地：界面会回退到保存前的值；刷新失败则整块池区消失

- **位置**：`:289`（`discard()`）→ `:294`（`onSaved?.()`，**未 await**）→ `:299-301`（`saving` 立即清掉）→ 父组件 `:1241` `onSaved={() => { void refreshUsage(activeRegion) }}` → `WorkBuddyCard.tsx:357-378`（成功才 `setStatusByRegion`，失败把该区域置为 `status:'error'`）
- **问题**：写成功后先丢草稿，再（异步）重读；草稿一丢，`active` 立刻回落到**上一份** `saved`（`:209`），而新 `pool` 还没到。这段窗口里开关/成员显示的是保存前的值，`dirty` 已是 false（`:210`），用户无法区分"没保存成功"和"界面还没刷新"。若这次重读失败，父组件把区域置为 error，`AccountPool` 直接不再渲染（父组件 `:957` 的 `status.status === 'signed-in'` 分支才渲染 `:1234` 的池区）——写其实已经成功，但用户看到的是错误页。
- **为什么定低**：窗口只有一次 loopback 往返（通常几十毫秒），失败分支需要 Host 路由真的出错；不会造成数据损坏（写入本身有 `writePoolPreferences` 的逐字段回读校验，`account-selection.ts:361-377`，写没落地会 throw 且**不**丢草稿，这一点是对的）。
- **复现**：改一个开关 → 保存 → 观察开关短暂回到旧值再跳回新值；或在 Host 路由上注入一次 500 观察池区整块消失。
- **修复方向**：`await onSaved?.()` 之后再 `discard()`（保持 `saving=true` 覆盖整个刷新），或让父组件在刷新失败时保留上一份 pool 而不降级成 error。

### A-9（低｜死代码）`targetLabel` 计算后从未使用，两个 locale key 只被这段死代码引用 → UI 无法区分目标模型来源

- **位置**：`:385-389`（`const targetLabel = pool.targetModelSource === 'preferred' ? t('row.poolTargetPreferred', …) : … ? t('row.poolTargetFree', …) : t('row.poolTargetNone')`）；全文件仅此一处出现 `targetLabel`（`grep -c` = 1）
- **证据**：`row.poolTargetPreferred` / `row.poolTargetFree` 在 `src/client/locales.ts` 有中英定义，但除 `:386` / `:388` 外全仓库无引用；实际渲染的摘要行 `:395-398` 只输出 `pool.targetModelId ?? t('row.poolTargetAuto')`，`none` 另有 `:423` / `:496-499`。两个 tsconfig（`tsconfig.json`、`tsconfig.client.json`）都**没开** `noUnusedLocals`，所以 `tsc` 不会报。
- **为什么是缺陷**：不是崩溃，而是"重构残留 + UI 信息缺失"：用户看到目标模型 id，却看不出它来自自己显式选择（preferred）还是自动挑的免费模型（free），而两者的失效语义完全不同。同时它让两个 key 看起来"已被使用"，会误导后续的 key 清理。
- **修复方向**：把 `targetLabel` 接到摘要行（或删掉它并删掉两个 key）。二者择一，别只改一半。

### A-10（低｜健壮性）`sameIds` 对重复 id 不可靠

- **位置**：`:113-117`
- **问题**：先比长度，再用 `new Set(right)` 做覆盖检查，因此**只对 `left` 的单向包含关系成立**。反例：`sameIds(['a','a'], ['a','b'])` → 长度都是 2，`Set(['a','b'])` 覆盖了两个 `'a'` → 返回 `true`，而两个集合并不相同。
- **可达性（诚实标注）**：本组件自身的编辑路径都去重（`:307-310` 用 `Set`、`:318` 用账号列表 map），Host 的列表也不重复（`tests/pool-route.spec.ts:425-437`），所以**只能由外部写入重复 id 触发**（手改配置文件/其他工具）。触发后表现为：`dirty` 判为 false、保存按钮不亮，用户的改动看起来"没生效"。
- **修复方向**：两侧都先去重再比大小与包含关系，例如 `const a = new Set(left), b = new Set(right); return a.size === b.size && [...a].every(id => b.has(id))`。（只加一次"长度去重校验"不够：`right` 侧也可能有重复。）同一形状在 `account-selection.ts:374-376` 也出现（不在本次范围，建议一并核对）。

### A-11（低｜健壮性）测试结果行的 `row.result.outcome` 未经校验解引用，且测试分支没有 checkin 分支那样的兜底

- **位置**：`:366-371`（`for (const row of (body?.rows ?? []) as WorkBuddyWebPoolTestRow[]) { … row.result.outcome … }`）对比 `:347-362`（checkin 分支用 `if/else` 把未知 `status` 兜成失败行）
- **问题**：`:341-343` 的响应体只做了 `as` 断言，没有逐行校验；`row.result` 缺失时抛 `TypeError`，被 `:374-377` 的外层 catch 变成 `actionError`，日志停在中途且**不会**写 `poolLogTestDone`。
- **为什么是缺陷**：批次此时已经在 Host 上真实跑完（真实花费/领取积分），用户看到的却是一条 JS 报错式的失败信息加半个日志。属于"版本错配/异常响应下的诚实性"缺口，不是常规路径。
- **修复方向**：`const outcome = row?.result?.outcome`，缺失时按 `'failed'`（`outcomeText` 的 `default` 已经映射到 `row.probeFailed`）记一行。

### A-12（低｜边界）目标模型下拉缺"当前值不在选项里"的占位项，显示与存储值会分叉

- **位置**：`:709-728`（`value={active.targetModelId}`，选项只有 `''` + `pool.catalog ?? []`）
- **问题**：存储的 `targetModelId` 若不在本次 `catalog` 里，受控 `<select>` 没有任何匹配 option，浏览器会把选中项退化为首项（即 `''`「自动 —— 挑一个免费模型」），而 `active.targetModelId` 仍是那个旧 id；`:397` 的摘要行也仍显示旧 id。Host 端 `resolveTargetModel`（`src/account-pool.ts:379-388`）对非空 preferredId **不做目录成员校验**，直接返回 `source:'preferred'` + 该 id，所以测试按钮也是可点的（不触发 `:422` 的 `none` 禁用），实际会去测一个目录里不存在的模型。
- **为什么是低/为什么值得报**：需要"先选过模型、之后目录变化"（模块头部 `:16-18` 自己写明国内版目录在首次刷新前可能为空，目录确实会变）；危害是显示"自动"、实际用旧 id，且下次保存会把旧 id 继续写回。
- **旁证（同类问题本项目已有先例与修法）**：父组件的手动账号下拉 `WorkBuddyCard.tsx:918-928` 专门插入了一个 `disabled` 的占位 option，注释（`:920-925`）写明"Without it the control would have no matching option and silently display the first account, which is exactly the 'looks fine, but is not what runs' confusion this fixes"。池区的目标模型下拉缺同样处理。
- **修复方向**：当 `active.targetModelId` 不在 `catalog` 中时插入一个 `disabled` 的"当前值已失效：<id>"选项。

---

## 三、已排除（审查过的疑点，结论是**不是缺陷**，请勿按缺陷修改）

| # | 疑点 | 排除理由（证据） |
| --- | --- | --- |
| E-1 | `onBusyChange` / `onRotationChange` 的 effect 会不会无限循环 | 父组件传的是 `useState` 的 setter（`WorkBuddyCard.tsx:1240`、`:1242`），引用天然稳定 → effect 只在 `saving` / `rotationLocked` 真变化时重跑；即使将来换成内联箭头，cleanup 的 `false` 与 effect 的当前值在同一次 commit 内批处理，净值为当前值 → 收敛。`onBusyChange` 上报的是 `saving`，而 `poolBusy` 并**没有**回灌给 `AccountPool`（只喂给模型区块的两个按钮 `:1215` / `:1218`），不存在自激回路 |
| E-2 | `if (pool === undefined) return null`（`:383`）在 hooks 之后 | 全部 hook（含 `:196` / `:230` / `:238` / `:257`）都在这个提前 return **之前**，条件渲染不会改变 hook 调用顺序。这是正确写法 |
| E-3 | `outcomeText` 的 `default`（`:133`）是不是永远不可达的死代码 | 不是。`WorkBuddyWebProbeOutcome` 显式包含 `'failed'`（`status-paths.ts:465-472`），switch 未列它，`default` 正是它的映射（`row.probeFailed`） |
| E-4 | `:491` 的 `dirty && !sameIds(...)` 与 `:210-218` 的 `dirty` 重复判定 | 不是重复 bug：`:491` 只在"差异发生在成员表"时给一条就地提示，是解释而非判定 |
| E-5 | 写入失败时草稿是否会被丢掉 | 不会。`discard()` 在 `try` 内且位于 `await` **之后**（`:285-289`），`writePoolPreferences` 落地校验失败会 throw（`account-selection.ts:361-377`）→ 走 `:295-298` 只设 `saveError`，草稿保留。这正是注释 `:286-288` 承诺的行为，实现是对的 |
| E-6 | 批量按钮不检查 `canEditPool` / `settingsScope`（`:413`、`:421`），而行复选框与全选检查（`:461`、`:467`、`:556`） | 有意的非对称，合理：批量动作不写偏好（`account-selection.ts:332-334` 明确"Deliberately does NOT carry the pool's measured facts"，测得事实由 Host 自己落盘），因此不需要绑定 settings scope；而成员勾选最终要走校验写入，必须要 scope（`:223-226`） |
| E-7 | `<AccountPool>` 没有按 region 加 `key`（`WorkBuddyCard.tsx:1234-1243`） | 不是缺陷：组件内部就是为"同一实例跨 tab"设计的（`:192-194` 注释 + `:209-210` 的 `draftRegion` 比对）。它带来的副作用是单槽草稿，已单独记为 A-6 |
| E-8 | 按钮/警告用 `active`（草稿）而不是 `saved` | 本身是设计（所见即所得：草稿里关掉轮换，冲突提示应立即消失）。缺陷 A-3 的问题不是"按钮看草稿"，而是"**执行基准**是 saved"这一侧不一致，两者必须一起看 |
| E-9 | 日志行的 `key: \`${entry.atMs}-${index}\``（`:798`）像是不稳定的 key | 稳定且唯一：`index` 保证同一毫秒内的多行也互不相同，列表只做前插+截断，不会因 key 冲突丢行 |
| E-10 | `stateColor` / `exclusionText` / `outcomeText` / `formatShort` 等小区分函数是否有永远走不到的分支 | 逐个核对过：`stateColor`（`:154-164`）用 `account.probe === undefined` 与 `outcomeOk` 两段兜底；`exclusionText`（`:167-175`）`default` 对应"未排除"；`outcomeText` 见 E-3。没有死分支 |

---

## 四、待验证（本环境无法判定，需真浏览器 / Host 契约确认）

| # | 待验证项 | 当前证据与不确定点 |
| --- | --- | --- |
| V-1 | `siblingBusy` 互斥是否真的堵死并发保存 | 两侧按钮都同时看自己的 `saving` 和对方的 busy（池 `:737`/`:743`，模型 `WorkBuddyCard.tsx:1215`/`:1218`），逻辑上闭合。理论上残留窗口 = "点击保存"到"passive effect 把 `poolBusy` 传给父组件"之间的一帧；按 React 的已知行为，离散事件路径上挂起的 passive effect 会在派发下一个离散事件前被 flush，所以人工点击/回车路径实际堵住（该细节**未在此环境实测**：无 react-dom）。**结论倾向：不算缺陷**；若担心，可在 `save()` 里同步调用一次 `onBusyChange(true)`，或后续用一次手工"两按钮连点"回归确认 |
| V-2 | 跨模块：同一 `regions` 槽还有**第三个**写入者 | tab 的 provider 开关（`WorkBuddyCard.tsx:856` `disabled={togglingRegion === region || !canWrite}` → `:486-516` `toggleRegion` → `account-selection.ts:306-316` `writeRegionEnabled`）不看 `saving` / `poolBusy`。它同样走 `writeField`（host 端按区域 merge，不是裸覆盖），所以冲突面与 V-1 同级。属父组件文件，建议由父组件负责人确认 |
| V-3 | 跨模块：两次 `refreshUsage` 可能乱序落地，旧快照覆盖新快照 | 池保存的 `onSaved` 刷新（`:294` → 父 `:1241`）与模型保存自己的刷新（父 `:764`）都直接 `setStatusByRegion`（父 `:357-378`），没有请求序号护栏；池保存的 `saving` 在刷新落地前就清掉了（`:299-301`），更允许两者重叠。是否真能乱序取决于 loopback 往返抖动。建议父组件加"仅接受最新一次响应"的护栏 |
| V-4 | `rotatedToAccountId` 变回 `undefined` 时 `lastRotatedRef` 不清空（`:257-260`） | 现在 `rotatedTo === undefined` 直接 return，ref 保留旧 id。若 Host 存在"先清空、之后再上报同一个账号"的序列，那次轮换就不会记日志（"每次切换都记录"的承诺漏一次）。需要 Host 侧确认 `rotatedToAccountId` 的生命周期（`web-status.ts:613-618` 只做透传） |
| V-5 | `WorkBuddyWebPoolAccount.member` 字段在渲染中被完全忽略 | 组件一律用 `active.memberAccountIds.includes(...)`（`:482`）驱动复选框。与设计一致（复选框必须反映草稿），但与 Host 的 `member` 在外部写入下可能短暂不一致。确认结论：**当前实现合理**，此处仅备案以免被误判 |
| V-6 | `actionError` 直接展示 Host 的英文串（`:344`、`:369`、`:501-502`） | 中文界面下会看到 `no accounts are checked into this region's pool` 这类英文原文。是否本地化取决于产品口径，不是逻辑缺陷 |

---

## 五、复现脚本说明

用于 A-1 的纯逻辑复现把 `useState` + `useCallback` 的语义逐帧照抄（每次 setState 提交一帧、依赖逐项 `Object.is` 比较、闭包捕获当帧的 `saved`），只做状态机推演，不依赖 react-dom；脚本写在 `/tmp/pool_sim*.mjs`，**已删除**，仓库内无任何遗留文件。A-1 的"加依赖即修复"用同一脚本的对照分支验证（`current -> ["a","c"]`；`+members dep -> ["a","b","c"]`）。

其余各条的复现路径都写在各条正文里，均为纯 UI 操作步骤，不需要脚本。

## 六、给修复者的优先级建议

1. **A-1**（会静默丢成员，自足可复现）与 **A-2**（一键就能造出"显示 B、计费 A"）都是"用户数据/计费语义被破坏"级别，建议同批修。
2. **A-3** / **A-4** 是确定性用户体验缺陷，改动都很小（判定基准改成 `saved`；clamp 挪到 blur）。
3. 其余 6 条按低优先处理，其中 **A-9**（死代码）与 **A-10**（`sameIds`）是一行级改动，顺手可清。
4. 修 A-1 时**不要**顺手把 `saved` 整个对象塞进依赖数组（会每帧重建回调），按字段加依赖。
