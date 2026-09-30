# 审计 C：活动记录 / 冲突提示 / 轮换上报（只读）

> 审计员：`audit-interaction`（共享任务 board `task-3`）
> 范围：`src/client/AccountPool.tsx`（日志 / 冲突提示 / 轮换上报）、`src/client/WorkBuddyCard.tsx` 池相关部分（`poolRotationLocked`、`poolBusy`、`siblingBusy`、`AccountPool` 调用点）、`src/client/locales.ts` 池文案。为判定行为是否与文案一致，只读延伸核查了 Host 侧 `src/index.ts`、`src/web-status.ts`、`src/auth.ts`、`src/account-pool.ts`、`src/account-pool-run.ts`、`src/client/account-selection.ts`。
> **本报告未修改 `src/` 下任何文件**（唯一写入：本文件）。
> 基线：`git HEAD = b209af2`（工作区含未提交改动）。sha256 前 12 位：
> `AccountPool.tsx b5a8117521d1`、`WorkBuddyCard.tsx 755dcc61160d`、`locales.ts db8689927a3f`、`auth.ts 57ea87317f3c`、`index.ts 9f470926f0cb`、`web-status.ts 034c4a327dd0`、`account-pool.ts e61029559513`、`account-pool-run.ts ca93f2e2cfe3`、`status-paths.ts bfa7467eb433`、`account-selection.ts 825878bc073e`。
> 上述 10 个文件在审计读数期间（文件 mtime 均 ≤ 05:51:36，本次读数 ≥ 05:58）未再变动，行号已对齐该基线；审计结束后复查哈希仍一致。
>
> 方法与限制：环境无 `react-dom`/jsdom，**不做真实渲染**。结论来自逐行静态精读 + 一处纯逻辑复现（`/tmp/audit-interaction-model.mjs`，只复现 `useCallback` 记忆化规则与 effect 的 ref 守卫，**已删除**）。凡涉及真实渲染像素、上游网络分叉时序的，标为「待验证」。
> 计数：**确认缺陷 23 条（高 2 / 中 9 / 低 12）**，另 **待验证 3 条**。

---

## §3（Lead 指定重点）「关闭自动轮换」在未保存状态下的明确结论

### 结论（一句话）

**未保存状态下手动下拉并没有保持禁用 —— 点「关闭自动轮换」后下拉会立即解禁，而持久化配置和 Host 运行时 override 都还没变。** 因此矛盾不是「点了却还是不能选」，而是相反的、更危险的一种：**点了就能选，但选了不算数**。

### 代码引用（判定链，全部确认）

| 环节 | 位置 | 事实 |
| --- | --- | --- |
| 1 | `AccountPool.tsx:209` | `const active = draftRegion === region && draft !== null ? draft : saved` —— 界面读的是**草稿优先** |
| 2 | `AccountPool.tsx:222` | `const rotationLocked = active.enabled && active.rotateByCredits` —— 锁定判定取自草稿 |
| 3 | `AccountPool.tsx:230-233` | `useEffect(() => { onRotationChange?.(rotationLocked) … }, [onRotationChange, rotationLocked])` —— 上报给卡片 |
| 4 | `WorkBuddyCard.tsx:916` | `disabled={switchingAccount \| !canWrite \| poolRotationLocked}` —— 下拉的禁用只由这个 boolean 决定 |
| 5 | `AccountPool.tsx:507` | `onUnlock: () => { editDraft(current => ({ ...current, rotateByCredits: false })) }` —— **只改草稿，不保存** |
| 6 | `AccountPool.tsx:758-771` | 冲突提示的渲染条件是 `active.enabled && active.rotateByCredits` —— 点完这一条提示**立即消失** |
| 7 | `index.ts:955-968` | Host 的 `applyRotation()` 读 `poolPreferencesOf(current(), region)`（**已保存配置**）决定是否 `setRotatedAccount(...)` |
| 8 | `auth.ts:964-969` | `current()` **优先**返回 `rotatedAccountId` 命中的凭证 —— 只要 override 还在，计费就走它 |

点击后的状态迁移（同一渲染周期内完成，无需保存）：

```
点击前： draft=null            → active=saved(rotate=true)  → rotationLocked=true  → 下拉禁用，冲突提示显示
点击后： draft.rotateByCredits=false → active=draft(rotate=false) → rotationLocked=false → 下拉解禁，冲突提示消失
        （而持久化配置 rotateByCredits 仍为 true；store.rotatedAccountId 仍为 B）
```

### 复现路径

1. 池设置里「按积分自动轮换」已开启并**保存**；Host 已轮换到账号 B。
2. 点冲突提示里的「关闭自动轮换」（`AccountPool.tsx:764-769`）。
3. 立刻观察：冲突提示消失（`758`），上方手动下拉可点（`916` 的 `poolRotationLocked` 已随 `230-233` 变为 `false`）。
4. 此时手动选账号 A：`writeAccountSlot` 会**成功**（`WorkBuddyCard.tsx:446`），但 `store.current()` 仍先命中 `rotatedAccountId=B`（`auth.ts:964-969`），且 `applyRotation` 只在测试路径调用（`index.ts:913`、`1224`）——**A 被静默忽略，B 继续计费**。

### 两个派生事实（本次审计新增，Lead 的 L-1 未覆盖）

- **「放弃修改」会把解锁静默撤销。** `discard()`（`AccountPool.tsx:273-277`）清空 draft 与 `draftRegion` → `active` 回到 `saved` → `rotationLocked` 重新为 `true` → 下拉**重新禁用**、冲突提示重新出现。用户视角是「解锁自己变回去了」，没有任何解释。→ **C3-2（中）**
- **解锁期间被接受的手动选择，不会因之后保存而追溯生效地消除歧义。** 若用户最终保存了 `rotateByCredits=false`，`applyRotation` 也要等到下一次测试才清 override（见 C3-3），窗口可能长达一个 `autoTestIntervalMinutes`（默认 30 分钟），池关闭时**永不**。

### 对选项取舍的补充（供 Lead 决策）

Lead 的 L-1 修复方向 1（`rotationLocked` 改读 `saved`）确实会让「界面允许的操作」与「Host 会执行的操作」一致；需要一个额外说明：改读 `saved` 后，点「关闭自动轮换」到保存之间，下拉会**保持禁用**且冲突提示仍在，此时用户唯一的出路是那个保存按钮 —— 建议同屏补一句「已改草稿，保存后生效」（可复用 `row.poolSaveDirty`，`AccountPool.tsx:747`）。仅改判定而不补提示，会把「解锁了但不生效」换成「点了没反应」。

---

## §1 活动记录（log state）

| # | 级别 | 结论 | 证据 |
| --- | --- | --- | --- |
| C1-1 | 中 | **批量失败只留「开始」，不留失败行**：`catch` 只 `setActionError`，不写日志；错误渲染在日志**之外**（`501-502`），日志读者只看到悬空的「开始签到 N 个账号」 | `AccountPool.tsx:329-334`（开始）← `374-377`（catch 只设 actionError） |
| C1-2 | 低 | **签到成功后签到列最长 60 秒仍与日志矛盾**：`runAction` 成功路径不触发任何刷新/`onSaved`，而 Host 的 `checkedInToday` 由 60 秒轮询重算 | `AccountPool.tsx:323-381`（无刷新调用）；`WorkBuddyCard.tsx:1234-1243`（只传 `onSaved`，仅保存路径用）、`401-409`（60 秒轮询）；`index.ts:866-883` |
| C1-3 | 低 | **「清空」在批处理进行中不禁用**：清空后仍在途的 `runAction` 会继续 `appendLog`，新行随即出现，看起来「清空没生效」 | `AccountPool.tsx:787-791`（清空按钮无 disabled）vs `329-372`（批次内多次 appendLog） |
| C1-4 | 低 | **日志 key 不稳定（但不会冲突）**：`key={`${entry.atMs}-${index}`}`，新增行插在头部使既有行 index 全部 +1 → 每次追加都重挂载整个列表（无动画/无状态保留的成本）。**同一渲染内 index 唯一，确认不会出现重复 key**；同一批次多行 `Date.now()` 常为同一毫秒，而显示精度只到秒（`formatClock`），故同批行的时刻不可区分 —— 但这是显示精度问题，不是 key 冲突 | `AccountPool.tsx:796-798`、`147-151` |
| C1-5 | 低 | **Host 的权威模型字段被丢弃**：响应体类型声明了 `modelId?`（Host 在 `web-status.ts:826` 确实返回它），客户端从未读取；「开始测试 N 个账号 × 模型」用的是**上一次轮询**的 `pool.targetModelId`，可能在日志里报出不是本次实际被测的模型 | `AccountPool.tsx:332`（用 pool 值）、`341-344`（声明后未使用）；`web-status.ts:826` |

**已核对为「与实际响应形状一致」（无缺陷）**：

- checkin：客户端按 `claimed` / `already` / 其他→失败 三分支（`AccountPool.tsx:347-363`），与 `status-paths.ts:597-604` 的类型和 `account-pool-run.ts:108-141` 的实际产出（`claimed`+credit、`already`、`failed`+message）一致；`else` 兜底未知状态为失败，属防御而非误报。
- test：客户端读 `row.result.outcome`（`AccountPool.tsx:366-371`），与 `status-paths.ts:607-611` 及 `account-pool-run.ts:167-193` 的 `{accountId, accountName, result:{modelId, outcome, …}}` 嵌套完全一致（`row.result` 一定存在，两条 early-return 也显式构造了 `result`）。
- `appendLog` 的 `useCallback(..., [])` 依赖正确：函数体只使用 `setLog` 的函数式更新，无外部捕获（`AccountPool.tsx:243-245`）。
- `setLog` 上限逻辑正确：`[{new}, ...previous].slice(0, LOG_LIMIT)`，上限 60、新的在前、丢弃最旧（`243-245`、`104`）。
- 清空按钮本身工作正常（`513` → `renderLog` 的 `onClear`，`787-791`）。

**低优先观察（不计入缺陷数）**：日志计数用**已保存**成员数（`AccountPool.tsx:328`），而 Host 还会按"当前本机仍存在的登录"再过滤一次（`index.ts:1039`）——若某成员的本机登录已被删除，实际执行的账号数会少于日志声称的数量。

---

## §2 轮换上报日志（缺陷 7 的修复）

被审代码（`AccountPool.tsx:255-266`，完整引用）：

```ts
const rotatedTo = pool?.rotatedToAccountId
const lastRotatedRef = useRef<string | undefined>(undefined)
useEffect(() => {
  if (rotatedTo === undefined || rotatedTo === lastRotatedRef.current) return
  const from = lastRotatedRef.current
  lastRotatedRef.current = rotatedTo
  const name = pool?.accounts.find(account => account.accountId === rotatedTo)?.accountName
  appendLog(t('row.poolLogRotated', { from: …, to: … }), 'info')
}, [appendLog, pool, rotatedTo, t])
```

| # | 级别 | 结论 | 证据 / 复现 |
| --- | --- | --- | --- |
| C2-1 | 中 | **每次（重新）挂载都会凭空写一条「从 — 切换到 X」**：`lastRotatedRef` 初值 `undefined`（`256`），首次观察到的已存在轮换被当成一次新切换；而 `log` 与 ref 都活在组件内部，卡片折叠（`WorkBuddyCard.tsx:832`）或一次轮询失败导致 `status` 离开 `signed-in`（`WorkBuddyCard.tsx:957`、`1244-1245`）都会卸载它 → 重新打开时**又写一条**。用户看到的是"刚刚切换过一次"的假记录 | `AccountPool.tsx:191`（log 属组件状态）、`256`、`257-266`；模型步骤 1、5 输出 `["switched from — to Bob"]` ×2 |
| C2-2 | 中 | **回退（`rotatedAccount` 被清空为 `undefined`）不记录，且 ref 不清空**：`rotatedTo === undefined` 直接 return（`258`），ref 保留旧值 → ①「轮换已停止、回到手动选择」这一事件永不入日志；②若之后又轮回到**同一个**账号，`rotatedTo === lastRotatedRef.current` 再次 return（`258`），**完全不记录**；③若之后轮到账号 C，日志会说「从 B 切到 C」，而中间真实状态是"手动选择" | `applyRotation` 的清除分支 `index.ts:958-961`（`setRotatedAccount(undefined)`）→ `web-status.ts:618` 键被省略 → 客户端 `pool?.rotatedToAccountId` 为 `undefined`。模型步骤 3、4 输出：回退后无新行；同账号再轮换后仍无新行 |
| C2-3 | 中 | **`lastRotatedRef` 与 `log` 都不按区域隔离，切 tab 会写假记录**：组件实例在两 tab 间复用，`region` 只换 prop；模型步骤 6、7 输出「from B to Ann」（用 cn 的 B 去解释 global 的轮换，B 在 global 列表里查不到就会退化成裸 id）与「from Alice to Bob」（回到 cn 后凭 global 的 A 造出一次并不存在的切换）。而 `row.poolRegionNote`（`locales.ts:172/347`）向用户承诺两个池"完全独立" | `AccountPool.tsx:191`、`255-256`（无 region 键）；调用点 `WorkBuddyCard.tsx:1234-1243`（单实例，`region` 可变） |
| C2-4 | 低 | **`from` 名为空串时不套占位符**：`nameOf(from, pool) ?? from`（`263`）只兜 `null/undefined`，`accountName === ''` 时返回 `''` 并被 `??` 放行 → 渲染成「计费账号已从  切换到 X」；`to` 分支（`264`）显式处理了 `''`，两分支不一致 | `AccountPool.tsx:261-265`、`518-521`（`nameOf` 原样返回 `accountName`）；同文件 `532` 展示了本仓库的正确写法（`accountName === '' ? t('row.accountUnnamed')`）。空串实际渲染成空还是未替换的 `{from}` 取决于 DSH locale 服务 → 渲染表现**待验证**，逻辑缺口确认 |

**已核对为非缺陷**：

- effect 依赖 `[appendLog, pool, rotatedTo, t]` 中的 `pool` 每次轮询都是新对象，effect 体因此每轮都跑，但 `258` 的 ref 守卫使其不重复记录（模型步骤 2 已验证）。
- StrictMode 双调用不会重复记录（ref 在首次执行时已被赋值）。
- `nameOf(from, pool)` 用**当前**池列表解析 `from` 名，是本模块能做到的最好选择；失败时退化为 id（`263`）。

---

## §3 冲突提示其余项（`AccountPool.tsx` / `WorkBuddyCard.tsx`）

| # | 级别 | 结论 | 证据 |
| --- | --- | --- | --- |
| C3-1 | 高 | 「关闭自动轮换」立即解禁但 Host 仍在轮换 —— 见上文§3重点 | `AccountPool.tsx:209/222/230-233/507/758-771`、`WorkBuddyCard.tsx:916`、`index.ts:955-968`、`auth.ts:964-969`（与 Lead 的 L-1 互相独立确认） |
| C3-2 | 中 | 「放弃修改」会静默撤销解锁：`discard()` 清空 `draftRegion`/`draft` → `rotationLocked` 回到 `true` → 下拉重新禁用、冲突提示重现，无任何说明 | `AccountPool.tsx:273-277` → `209` → `222` → `230-233`；按钮 `742-745` |
| C3-3 | 高 | **rotation 的生效时机只有"测试"一条路，关闭池后 override 永不清理**：`applyRotation` 的两个调用点都在测试路径（`index.ts:913` 手动测试、`1224` 定时测试）；而池一旦禁用，手动测试路由直接 409（`web-status.ts:791-793`）、定时器也不再调度（`index.ts:1180-1183`，且 `duePoolRegions` 删除其时钟，`account-pool.ts:350-355`）→ `store.rotatedAccountId`（`auth.ts:687`，进程内字段）**在本次插件生命周期内保持不变**，`current()` 继续优先返回它（`auth.ts:964-969`）。这与两条界面承诺冲突：`poolEnabledHint`「关闭时插件行为与从前完全一致：跟随你选择的账号」（`locales.ts:141/316`）与 `applyRotation` 注释「Clearing on every non-rotating path」（`index.ts:944-953`）。**开启方向同样滞后**：保存开启后到真正开始轮换之间，要多等一个完整间隔（首次见到只是"上弦"，`account-pool.ts:333-339`、`352-355`；tick 周期 `284`，默认间隔 30 分钟 `AccountPool.tsx:204`），而界面上已有「自动轮换中」徽标（`400-402`）与已置灰的下拉（`916`） |
| C3-4 | 中 | **锁定期间下拉显示的账号 ≠ 实际计费账号**：下拉的 value 取自 `accounts().selected`（`WorkBuddyCard.tsx:915`），而 `store.accounts()` 的 `selected` 只看**持久化的显式选择/默认选择**（`auth.ts:929-933`），**完全不看 `rotatedAccountId`**；`current()` 却优先返回轮换账号（`auth.ts:964-969`）。于是轮换生效时：下拉显示用户保存的 A（禁用），池表当前行高亮 B（`AccountPool.tsx:548` + `index.ts:891-897`）。`row.poolManualLockedHint`（`locales.ts:158/333`）声称置灰是为了"避免出现显示 A 却计费 B"——锁定态本身就处于该状态，置灰只是让用户无法纠正显示。`auth.ts:895-907` 的注释声称"两者绝不能不一致"，与其实现相矛盾 |

**已核查为非缺陷（Lead 特别问到的 unmount 清理）**：`AccountPool.tsx:230-233` 的清理在卸载时上报 `false`，且在 `rotationLocked` 真值翻转时先 `false` 再新值，净结果正确；`onRotationChange={setPoolRotationLocked}`（`WorkBuddyCard.tsx:1242`）是稳定的 state setter，不会因父组件重渲染而抖动。**真正的卸载副作用不在锁上，而在日志上**（见 C2-1）。`onBusyChange`（`238-241`）同理正确；`siblingBusy`（`WorkBuddyCard.tsx:1239` / `AccountPool.tsx:737/743`）用真实的在途布尔量，不涉及草稿，无明显问题。

---

## §4 文案准确性逐条核对

「说了但没做」/「做了但没说」逐条列。全部给出中英双份行号。

| # | 级别 | 文案（中/英） | 实际行为 | 结论 |
| --- | --- | --- | --- | --- |
| C4-1 | 中 | `poolRotateHint`：「开启后下方的手动选择会被停用，**每次切换都会留下记录**」（`locales.ts:143/318`）；`poolLogEmpty`：「签到、测试与**账号切换**都会记录在这里」（`162/337`） | 日志的 `appendLog` 调用点只有 4 处：轮换上报（`262`）、批次开始/逐行/完成（`329`、`349-372`）。**手动下拉切换**（`WorkBuddyCard.tsx:438-453`）从不写日志；**解锁动作本身**（rotation on→off，`507`）也不写；轮换回退（C2-2）不写；两次轮询之间的多次切换只留最后一次 | 「说了但没做」×3 种情形 |
| C4-2 | 中 | `poolTargetFree`「自动选中的免费模型：{model}」/`poolTargetPreferred`「你指定的模型：{model}」（`117-118/292-293`） | `targetLabel` 在 `AccountPool.tsx:385-389` 被算出后**从未使用**（全文件仅此一处出现）；这两个 key 在 `src/`、`tests/` 内无第二个消费者。卡片只消费 `'none'` 分支（`496-499`），因此**从不说明目标模型从何而来**，而这正是 `targetModelSource` 存在的唯一理由（`status-paths.ts:558-563`） | 死代码 +「该说没说」 |
| C4-3 | 中 | `poolNoCandidate`「账号池里目前没有可用的账号。」+ hint「每个账号要么被限流、要么积分耗尽、要么被上游拒绝」（`108-109/283-284`） | 触发条件是 `rotationLocked && usable.length === 0`，而 `usable` 是**整张账号表**（含未入池账号，`221`）；未入池行由 Host 从 `others` 生成，**永远不带 `excludedBy`**（`web-status.ts:578-586`、`604`）。于是只要本机存在任一**未入池**登录，`usable.length` 就 ≥1，这条警告**永不出现**——恰恰是"成员全被限流但还有别的本机账号"这一最需要解释的场景。反向（全部本机账号都已入池且全部被排除）才显示 | 该说没说；条件与文案语义不符（"池里的账号" vs 整表） |
| C4-4 | 低 | `poolCheckinUnknown`：显示 `—`，`title` 用 `row.poolNeverTested`「尚未测试」（`129/304`、`598`） | 三态实现本身正确（`undefined`→未知、`true`→已签到、`false`→未签到，`593-603`，与 `status-paths.ts:546-553`"ABSENT 表示未读取"的契约一致），但未知态的 tooltip 说的是**测试**而不是**签到未读取** | 文案张冠李戴（「说了个别的」） |
| C4-5 | 低 | `poolSummary`「本区域 {count} 个账号 · 目标模型 {model}」，`model` 回退到 `poolTargetAuto`「自动」（`107/282`、`395-398`） | 当 `targetModelSource === 'none'`（无免费模型）时，`targetModelId` 缺失 → 头部显示「目标模型 **自动**」，同一屏下方却显示「本区域暂时没有倍率为 0 的免费模型」 | 同屏自相矛盾（"自动"≠"没有"） |
| C4-6 | 低 | `poolNoneSelectedHint`「请在上方勾选至少一个账号并保存。在此之前两个按钮都不可用 —— 空池没有可执行的对象」（`179/354`） | 按钮禁用读**草稿**成员数（`413`、`419-422`），批处理读**已保存**成员数（`328`；Host 侧 `index.ts:1034`）。于是：①已保存 3 个成员、草稿里全不勾（未保存）→ 按钮禁用，理由不是"空池"而是"草稿为空"；②草稿里新勾一个未保存 → 按钮**可用**，而文案例说"保存前都不可用" | 禁用理由与实际判定源不符（两方向都错） |
| C4-7 | 低 | `poolIntervalHint`「仅在账号池启用时运行」（`145/320`） | Host 还要求**区域开关**也开：`enabledOf: region => poolPref.enabled && regionEnabled(...)`（`index.ts:1180-1183`） | 「做了但没说」（卡片他处有区域关闭提示 `WorkBuddyCard.tsx:866-868`，故只算低） |
| C4-8 | 低 | `poolNoCandidateHint` 只列"限流 / 积分耗尽 / 被上游拒绝"（`109/284`） | 排除原因有第四种 `unusable`（`AccountPool.tsx:167-175`、`account-pool.ts:103`） | 「做了但没说」 |
| C4-9 | 低 | `poolRotateHint` / `poolManualLockedHint` 描述排序为「可用性 → 积分 → 可用时间」（`143/318`、`158/333`） | 实际排序是 可用性 → 积分 → 最近过期 → **token 过期** → id（`account-pool.ts:194-215`，`pickAccount` `236-238`） | 「做了但没说」（token 过期这一并列键） |
| C4-10 | 低 | `poolManualLockedHint`「上面的下拉已置灰，避免出现显示 A 却计费 B」（`158/333`） | 该保护在两种情形下失效：①点「关闭自动轮换」后提示消失、下拉解禁而轮换仍在（C3-1）；②锁定态本身下拉就显示 A 而计费 B（C3-4） | 声明与实际不符 |
| C4-11 | 低 | `poolBusyHint`「正在逐个账号执行…」（`115/290`） | 与 Host 顺序执行 + 400ms 间隔一致（`account-pool-run.ts:81`、`100-104`、`159-163`） | ✅ 一致 |
| C4-12 | 低 | `poolTargetHint`「挑一个倍率为 0 的免费模型，多个候选取上下文窗口最大的」「手动指定优先于自动」（`148/323`） | `pickFreeModel`：`creditMultiplier !== 0` 跳过、取 `contextWindow` 最大（`account-pool.ts:265-274`）；`resolveTargetModel`：preferred 直接返回（`379-388`，注释明确"即使收费也返回"） | ✅ 一致（唯一未说的是"手动可指定收费模型，测试会花积分"，但选项标签已带倍率 `AccountPool.tsx:722-727`） |
| C4-13 | 低 | `poolMembersHint`「只有勾选的账号才会被签到、测试和轮换」（`174/349`） | Host 的成员解析只取已保存勾选（`index.ts:1033-1040`、`1043-1049`），未勾选行不参与 | ✅ 一致 |
| C4-14 | 低 | `poolSettingsHint`「测试结果与轮换记录由插件自动写入，不受这个保存按钮影响」（`139/314`） | 探针结果由 Host 写入、不进 settings 草稿（`account-selection.ts:332-334`），保存不会回滚测量值 | ✅ 一致（但"轮换记录"指运行时事实；真正的问题在文案"每次切换都会留下记录"，见 C4-1） |

---

## 待验证（未确认，不下结论）

1. **`from` 为空串时的实际渲染**（C2-4）：逻辑缺口确认（`??` 不拦 `''`），但 DSH locale `ctx.locale.bind()` 对空参数是渲染成空还是保留 `{from}` 字面量，未能在本机确认（DSH checkout 路径不可读）。需要一次真实渲染或对 locale 服务的单测。
2. **`body.modelId` 与 `pool.targetModelId` 在实际使用中是否会分叉**（C1-5）：分叉需要"轮询与批次之间目录/偏好发生变化"（例如用户刚刷新目录、或保存后 `onSaved` 的重读尚未落地）。静态可确认的是权威字段被丢弃，分叉频率未验证。
3. **手动选择在锁定窗口内写入后，卡片的渲染结果**（C3-4 的渲染面）：`writeAccountSlot` 成功后下拉 value 来自 `accounts().selected`，而 `current()` 会被 override 覆盖——代码上可推出"下拉显示 A、池表高亮 B"，但真实浏览器下的重渲染时序（`refreshUsage` 落地与 60 秒轮询交错）未实测。Lead 的 L-2 也把同一点列为待验证。

## 防御性/健壮性备注（非本次范围结论）

- 客户端对 `body.rows` 是**无校验的 `as` 断言**（`AccountPool.tsx:347`、`366`）。若某行缺 `result`（`366-370` 直接取 `row.result.outcome`），会在 `try` 内抛 `TypeError` → 被 `374-377` 捕获成 `actionError`，此时日志里只剩「开始」而没有完成行（与 C1-1 同一表现）。当前 Host 一定构造 `result`（`account-pool-run.ts:177-192`），故只是契约脆弱点。

---

## 附录：复现脚本（已删除）

`/tmp/audit-interaction-model.mjs`，两个模型：

- **A**：按 `useCallback` 的记忆化规则复现 `editDraft`（`AccountPool.tsx:268-271`）的 `saved` 捕获，逐次渲染推进状态。输出（关键行）：
  `after check B (unsaved): active ["A","B"] / saved ["A"]` → `saved state now: ["A","B"]` → `after checking C: active ["A","C"] / saved ["A","B"]` → `=> saving here drops B: true`。
- **B**：复现轮换日志 effect（`255-266`）的 ref 守卫，覆盖首挂载 / 轮询 / 回退 / 同账号再轮换 / 卸载重挂 / 跨 tab 六种序列，输出与 C2-1~C2-3 三条结论一一对应。

### 对 Lead L-3 的补充（触发条件比"另一个标签页"更常见）

Lead 的 L-3 把触发条件描述为"另一个浏览器标签页保存了勾选 / Host 侧変化"，并注明"不是每次都会触发"。**实测（模型 A）表明本池自己的保存路径就能稳定触发，且它就在主流程上**：

1. 已保存成员 `[A]`，勾选 B → 保存。`save()` 内先 `discard()`（清 draft 与 draftRegion，`289`）再 `onSaved()` 触发重读（`294`；`WorkBuddyCard.tsx:1241`）。
2. `discard()` 导致的这次重渲染里 `draftRegion` 由 `cn` 变回 `undefined` → **依赖数组变化 → `editDraft` 重建，捕获此刻仍是旧值的 `saved`（`[A]`）**。
3. 重读落地后的渲染里 6 个依赖全部与上一步相同 → **不再重建**，闭包继续持有过期的 `saved`（`[A]`）。
4. 用户下一次点任意一行的复选框 → 草稿基准用 `[A]` → 草稿变成 `[A,C]`：**刚刚保存成功的 B 立刻从勾选里消失**；此时若保存，B 被静默移出池。

也就是说：**"保存一次勾选变更 → 再勾一个新账号"这一最常见的两步操作就能命中**，而不是需要第二个标签页。建议 Lead 在 L-3 的触发条件里按此更新，并在修复时对"保存后首次编辑"补一条回归测试。

**模型 A 的诚实前提**：它假设 `discard()` 引发的那次重渲染**先于**重读落地（`onSaved()` 的 fetch 至少是一次网络往返），此时闭包捕获的 `saved` 仍是旧值；若在真实环境里 React 把这次状态更新推迟到重读落地之后才刷新，则该路径退化为"捕获新值"、此路径不触发（但"任何 `memberAccountIds` 变化而 4 个标量不变"的窗口仍然存在，缺陷本身不受影响）。这一渲染时序需要真实浏览器确认，是本节唯一的待验证点。
