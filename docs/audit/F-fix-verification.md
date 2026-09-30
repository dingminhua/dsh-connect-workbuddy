# 审计 F：修复的独立对抗式验证

> 验证员：`fix-verify`（独立于实施者）。对象：`E-fix-log.md` 声明的**全部修复**（H-1..H-6、M-3、M-5、M-9 及 12 项"廉价项"）与 `tests/pool-e2e.spec.ts` 新增的回归测试。
> **只信复现，不信声明。** 每条修复都构造了**能区分"已修"与"未修"**的测试：用 `react-dom 18.3.1 + jsdom` 渲染**真实组件**，
> 并让 `fetch()` 走**真实挂载插件**（真实 `apply()` + 真实路由 + `settings.mutate` 就地写回 config）。
> 关键条目额外在 `/tmp` 的**变异体**（把修复逐条回退的副本）上跑同一脚本，以证明该脚本**确实能判出未修状态**。
>
> 本文件是本会话**唯一**写入：`src/`、`tests/`、`docs/audit/{A,B,C,D,E,LEAD,MASTER}*` 一字未改。

## 0. 方法与验证基线

### 0.1 环境

| 项 | 值 |
| --- | --- |
| Node | v25.9.0（`--experimental-strip-types` + `register()` 钩子用 `typescript.transpileModule` 转译 `.tsx`） |
| React / react-dom / jsdom | 18.3.1（**symlink 到仓库同一份 react**，避免双实例）/ 18.3.1 / 29.1.1，装在 `/tmp/fverify/render` |
| 被测代码 | **未改动**，验证期间哈希固定（见 §0.2） |
| Host 挂载 | `new Context()` + FakeWebServer + FakeSettings，**真实 `apply()`**；`settings.mutate` **就地写回** `apply()` 收到的那个 config 对象 |
| 脚本位置 | `/tmp/fverify/`（仓库外，**已删除**；重建配方见 §7） |

**验证基线（本轮实测，全部固定）**：

```
src/client/AccountPool.tsx        7df6965a151df23f
src/client/WorkBuddyCard.tsx      5ddacbf2c360e664
src/index.ts                      33667250ac8d5bb7
src/web-status.ts                 e24fce5a7b4c673e
src/account-pool.ts               3c8d06878d17b38a
src/client/locales.ts             f55726a40682736b
src/client/account-selection.ts   825878bc073e45e6
```

> **中途变更（重要）**：`AccountPool.tsx` 在我开始验证后（07:01）被改动了一次 —— `savedRef` 从**渲染期赋值**改为 `useLayoutEffect` 同步。
> 我在**新版本**上重跑了全部 21 个脚本（§5 的裁决均以新版本为准），并针对这次改动单独复核（§3.1）。

### 0.2 裁决口径

- **已修复** = 在本机复现出"修复后的正确行为"，**且**在对应变异体上同一脚本能判出缺陷。
- **未修复** = 用修复后的代码仍能复现原缺陷现象（附复现步骤）。
- **修复引入新缺陷** = 修复本身带来了新的、可复现的错误行为。
- **无法验证** = 环境限制，说明原因。

### 0.3 变异体（本报告的方法学核心）

仅"修复后行为正常"不足以证明修复有效——**必须证明测试能判出未修状态**。为此在 `/tmp/fverify/` 建了三棵变异树，把修复**逐条回退**后跑同一脚本：

| 变异体 | 回退内容 | 用途 |
| --- | --- | --- |
| `mutant/` | H-1（旧 `editDraft` 闭包 + 标量依赖数组）、H-2（`rotationLocked` 读草稿）、C1-3（清空不禁用） | 证明 H-1/H-2 的脚本有判别力 |
| `mutant_gating/` | H-4（tab 开关去掉 `saving \|\| poolBusy`；两个保存按钮去掉 `togglingRegion`；`siblingBusy` 只含 `saving`） | 证明 H-4 的脚本有判别力 |
| `repo-mutant/` | 逐条回退 Host 侧修复，**跑仓库自己的 vitest 套件** | 审计 §4 的回归测试是否恒真 |

**变异体结果摘录**（同一脚本，仅代码不同）：

```
H-1  FIXED : step 2 saved = ["ff4d…","9c84…"]   (两个成员都保留)
     MUTANT: step 2 saved = ["9c84…"]           (Alpha 被静默丢弃 ← 原缺陷复现)
H-2  FIXED : STEP 2 dropdown disabled = true     (Host 仍在轮换，UI 诚实)
     MUTANT: STEP 2 dropdown disabled = false    (一键解锁即出现"显示A计费B" ← 原缺陷复现)
H-4  FIXED : (a) tabCn/tabGlobal disabled = true during a pool save
     MUTANT: (a) tabCn/tabGlobal disabled = false
H-5  FIXED : 计数 已选 0/1、签到按钮禁用
     MUTANT(repo): "H-5 的批量测试" **仍然通过** ← 该测试恒真（见 §4）
```

---

## 1. 高危修复（6 条）

| 编号 | 声明 | 裁决 | 反证尝试与证据 |
| --- | --- | --- | --- |
| **H-1** | `editDraft` 经 `savedRef` 在 updater 内取基准 | ✅ **已修复** | 真实渲染 + 两账号：`[]` → 勾 Alpha → 保存得 `["ff4d…"]` → **再勾 Beta** → 保存得 `["ff4d…","9c84…"]`（**两个成员都在**）。同脚本在回退版上得 `["9c84…"]`，Alpha 被静默丢弃 → 脚本有判别力。**StrictMode 下重跑同样通过**。另验证 `useLayoutEffect` 版本：H-1 序列仍成立（§3.1） |
| **H-2** | `rotationLocked` 读已保存值 + `rotationUnlockPending` | ✅ **已修复** | 四步：①已保存轮换 ON → 下拉禁用、冲突提示在、徽标「自动轮换中」；②点「关闭自动轮换」（**仅改草稿**）→ **下拉仍禁用**、提示「保存后生效 —— 在那之前插件仍在轮换。」、Host 仍 `rotateByCredits=true`（**显示与计费一致**）；③「放弃修改」→ 回到锁定态，无残留；④改草稿+保存 → Host `false`、下拉解锁、冲突消失。回退版第②步下拉立刻可点 → 原缺陷复现。**用户提的"下拉一直禁用会不会困惑"：有显式提示 + 可点的保存按钮，不存在"点了没反应"** |
| **H-3** | `loader/volatile-update` 与启动都调用 `applyRotation` | ❌ **未完全修复（存在新竞态）** | 基本路径已修：启动即轮换 ✓；关池+提交事件后 override 清除 ✓；重新开启后恢复 ✓。**但修复引入新缺陷** → 详见 **§2.1** |
| **H-4** | tab 开关加入 `saving \|\| poolBusy`；两个保存按钮加入 `togglingRegion` | ✅ **已修复** | 真实渲染 + 慢速 `__save`（400ms）在途探测：(a) 池保存在途时 **cn 与 global 的 tab 开关都禁用**、模型保存按钮禁用；(b) 区域开关在途时 **池保存按钮禁用**、模型保存按钮禁用。回退版 (a)(b) 都露出缺口 → 脚本有判别力 |
| **H-5** | Host 下发 `effectiveMemberAccountIds`，客户端据此计数与禁用 | ⚠️ **部分修复（测试按钮仍放行）** | 计数与签到按钮已修：`memberAccountIds:['ghost-id']` → 计数「已选 0 / 1」、签到按钮 `disabled=true`、幽灵成员提示出现。**但测试按钮仍用 `active.memberAccountIds.length`** → 复现见 **§2.2** |
| **H-6** | `resolveTargetModel` 新增 `'stale'`，stale 时省略 `modelId` | ✅ **已修复** | 五案例矩阵全部符合预期：目录内 id → `preferred`/按钮可用/200；目录外 → `stale`/`modelId` **省略**/按钮禁用/409 `reason=target-model-stale`；无 id+有免费 → `free`/200；无 id+无免费 → `none`/409 `no-free-model`；**目录从未加载 → `stale`**（fail-safe 方向正确） |

---

## 2. 未修复 / 新缺陷（本轮最有价值的部分）

### 2.1 【新缺陷】H-3 的修复引入 `applyRotation` 竞态 —— 旧 ON 覆盖新 OFF

`applyRotation` 现在挂在**每一次** settings 提交上，但它**不是可重入的**：它在入口处同步读取偏好（`poolPreferencesOf(current(), region)`），随后 `await poolMembersOf(region)`（对每个成员发一次 `fetchCredits`），**恢复后无条件** `store.setRotatedAccount(picked?.id)`。于是一个"轮换 ON"的旧调用可以在一个"OFF"的新调用**清空之后**才落地，把 override 又写回去。

**复现（真实挂载插件，`/tmp/fverify/t8_h3_race.mjs`、`t8b_h3_race_variants.mjs`）**：

```
1. startup                             : {rotate:true, enabled:true}
2. 提交 #1（仍 ON，改了间隔）→ 慢速 credits 读取在途
   提交 #2（rotateByCredits = false，更新）→ 立即清空 override
   right after the OFF commit          : {rotate:false}          ← 此刻是对的
3. after the slow re-rank settles      : rotatedTo = "ff4d…"    ← 旧 ON 又写回来了
VERDICT: 轮换已关，但运行时 override 仍在 —— 关池后 override 未清理的 H-3 症状重现
```

变体 B（更贴近用户操作，**用池总开关**）：

```
A) OFF then ON     -> rotatedTo = "ff4d…"（ON 更新，正确）
B) ON then pool OFF-> enabled = false | rotatedTo = "ff4d…"   ← 池已关，override 仍在
VERDICT B: STALE OVERRIDE SURVIVES A DISABLE
```

**用户可见后果**：用户开启轮换 → 紧接着关闭账号池（或关闭轮换）并保存，若前一次 re-rank 的网络读取尚未返回，则**界面显示池已关闭，实际计费仍走轮换账号**——正是 H-3 声称修好的那条「与 `poolEnabledHint` 的承诺冲突」。
**建议**：给 `applyRotation` 加一个 per-region 序号（或 generation 令牌）——恢复后若序号已过期就直接返回；清空分支也可标记"已显式关闭"。这与 L-5 的"请求序护栏"是同一类修法，可同批做。

### 2.2 【未修复】H-5 的测试按钮：幽灵成员仍可点，界面宣称完成但零请求

计数与**签到**按钮已用 `effectiveMembers`，但**测试**按钮仍判 `active.memberAccountIds.length === 0`（`AccountPool.tsx:627`），Host 路由的 409 守卫也只判 `preference.memberAccountIds.length === 0`（`web-status.ts`），因此"成员全是幽灵"这一状态**仍能进入批量路径**。

**复现（`/tmp/fverify/t1_h5_test.mjs`）**：`memberAccountIds: ['ghost-account-id']`、本机只有 1 个真实登录、有免费模型：

```
buttons before: [ '一键签到所有账号|disabled=true', '一键测试所有账号|disabled=false' ]   ← 测试按钮仍可用
点击「一键测试所有账号」后：
  log: 测试完成，已重新计算候选账号
       开始测试 1 个账号 × free
  upstream delta: 0            ← 零上游请求
  actionError: (none)          ← 无任何错误
```

即 **B-1 的原始症状（界面宣称完成、实际零请求）在测试路径上完整重现**。签到路径因按钮禁用而不可达（这是修复生效的部分）。
**建议**：测试按钮改用与签到按钮同一判据（`effectiveMembers.length === 0`），并把 Host 路由的 `no-members` 守卫改为基于**可解析成员**，这样即使有绕过客户端的老卡片也会被 409 挡住。

### 2.3 【未修复】C2-4 只修了 `to` 方向，`from` 方向仍渲染裸 id

`E-fix-log.md` 声称 C2-4 已修（`from` 空名套占位符）。实测**只有 `to` 分支**套了占位符；`from` 分支在"上一个轮换账号名为空"时渲染**24 位十六进制 id**。

**复现（`/tmp/fverify/t19b_c24.mjs`）**：本机有 Alpha 与一个**无昵称**账号，先轮到无昵称账号，再轮到 Alpha：

```
计费账号已从 668ab37ecdaf7ab9a9a7358f 切换到 Alpha      ← from 是裸 id（缺陷）
计费账号已从 — 切换到 未命名账号                          ← to 分支正确用了占位符
```

另发现同类瑕疵：**轮换停止**行也渲染裸 id ——

```
轮换已停止 —— 回到 668ab37ecdaf7ab9a9a7358f             ← 应为「未命名账号」
```

（`AccountPool.tsx:381` 的 `nameOf(previous, pool) || previous` 在 `nameOf` 返回 `''` 时回退到 id。`||` 拦不住 `''` 与 `??` 的问题同源，只是方向相反。）
**建议**：两处都改为 `nameOf(previous, pool) || t('row.accountUnnamed')`，与 `to` 分支完全一致。

### 2.4 【未修复】A-12 的占位项存在但**不可达**，且用户保存的失效 id 会被静默清空

`E-fix-log.md` 声称 A-12 已修（补 disabled「（已下架）」选项）。该选项**确实写进了代码**，但触发条件是 `active.targetModelId !== '' && !catalog.some(...)`。而 H-6 修复后，**Host 对 stale 目标不下发 `targetModelId`**（只在 `staleTargetModelId` 里给），于是：

**复现（`/tmp/fverify/t10b_a12.mjs`、`t27_a12_reach.mjs`）**：保存一个目录外 id → Host 下发 `source='stale'`、`targetModelId=undefined`、`staleTargetModelId='gone-model'`：

```
select.value = ""                  ← 显示「自动」，而磁盘上保存的是 gone-model
options = "" (自动) | "free"
placeholder for the stale id present: false      ← 占位项没有渲染
```

即 **A-12 的原始症状（显示与存储值分叉）在 H-6 之后依然成立**，而新加的占位分支在当前契约下**不可能触发**（`targetModelId` 对 stale 恒为 `undefined`）。
另有一条我在探测中发现的**更危险**的路径：用户把一个**当前目录内**的模型选为草稿（未保存），随后目录刷新把它下架 → 下拉显示回落到首项「自动」，若用户此时保存，**存的就是 `''`，用户原来的选择被静默清空**（`t20_misc.mjs` (b) 实测：`before "gone-model"` → 保存后 `""`）。
**建议**：让客户端从 `staleTargetModelId` 取基准值渲染占位项（`active.targetModelId || pool.staleTargetModelId`），或让 Host 在 stale 时仍下发 `targetModelId` 而只靠 `source` 区分；两者取其一即可让显示与存储重新一致。

---

## 3. 我方怀疑点（你点名要我查的）

### 3.1 `savedRef` 的同步方式

- **原实现（渲染期赋值）**：`savedRef.current = saved` 写在渲染体内。这在 React 并发模式下确实不安全（被丢弃的渲染会把 ref 写成从未提交的树的值），你的判断方向正确。
- **现实现（`useLayoutEffect`）**：我用**最新版本**重跑了 H-1 全序列（含 StrictMode），通过。语义上也更稳：`useLayoutEffect` 在 commit 后**同步**执行，早于浏览器绘制，因此任何用户点击（必在绘制之后）读到的都是最新值。**没有发现新问题**。
- 一个**仍然存在**的残留窗口（**非本次声称修复项**，属 A-8 家族）：保存成功后 `discard()` 立即生效、而 `onSaved()` 的重读是异步的，两者之间界面会短暂回落到**保存前**的显示。我在 `t25_final.mjs` (3) 把它卡住并实测：写已落地（`Host members = ["ff4d…"]`）而界面仍显示「已选 0 / 2」，且此窗口内 `saving=false`、`siblingBusy=false`（控件可交互）。**这是 A-8，不是 H-1**；但它是同一片区域里唯一剩下的真实窗口，值得与 M-4/L-5 同批处理。

### 3.2 H-4 的三方门控是否真的闭合？有没有第四个写入者？

- **三个已知写入者已闭合**（§1 H-4 的双向探测）。
- **第四个写入者的候选：`switchAccount`**。它写的是 `accounts` 字段（`writeAccountSlot` → `__save` with `field:'accounts'`），与 `regions` **不是同一个顶层槽**，Host 的 `{ ...current, ...incoming }` 在**字段**层合并，因此不会与池/模型保存互相回退。**实测确认**：池保存在途时切换账号，两个 `__save`（`["regions","accounts"]`）都正确落地，池成员与账号选择各自保留（`t6_4th_writer.mjs`）。→ **不是第四个 regions 写入者**。
- 但它**共享同一个 Host 端点与同一条串行通道**，且**不受任何门控**：池保存在途时账号下拉仍可点（`t5_accounts_vs_regions.mjs`：`dropdown disabled = false`）。当前**不构成数据丢失**（字段隔离），属"门控清单不完整"的遗留口径问题——`E-fix-log.md` 把写入者清单描述为已闭合，严格说**只对 `regions` 槽成立**。
- 全仓 `scope.set` / `writeField` 调用点已逐一核对：`account-selection.ts` 内 4 处（accounts ×1、regions ×3），`WorkBuddyCard.tsx` / `AccountPool.tsx` **无任何直接 `scope.set`**。→ **regions 槽确实只有三个写入者**。

### 3.3 模块级 Map（`logStore` / `rotationMemory`）的内存与正确性

- **跨卸载残留**：实测**存在且是有意的**（`t17_maps.mjs`：卸载卡片再挂载，同一 region 的历史仍在）。这正是 C2-1 的修复前提（没有它，折叠卡片就会丢历史并写假记录）。
- **区域隔离**：实测**成立**——cn 的历史不会出现在 global 标签页（`t17_maps.mjs`），跨区轮换记录也不串（`t14_c23.mjs`：global 日志不含 cn 的账号 id）。→ **C2-3 已修**。
- **内存上界**：`logStore` 每 region 最多 60 行、`rotationMemory` 每 region 一个对象、`checkinStateCache` 每 region 每账号一条 —— **都有界**，不构成泄漏。
- **"插件重载残留脏数据"**：**是真实存在的语义**（模块级 Map 在插件重新 `apply()` 时不会重置，因为模块缓存不清），但影响面为**每 region 60 行活动日志**与**一个 `last/primed` 标记**，且两者都只是显示层。最坏情况：重载后第一条轮换记录可能因 `primed=true` 而被跳过。**属可接受的设计取舍**，建议在注释里点明"进程内缓存、不随插件重载重置"。
- 未发现正确性缺陷。

---

## 4. 对 `tests/pool-e2e.spec.ts` 新增回归测试的审查（含变异体实测）

仓库自带 584 个测试**全部通过**（`repo-mutant` 上跑完整套件复核）。我用**逐条回退 Host 修复**的变异体检验每条新测试是否真能判出缺陷：

| 测试 | 变异体回退内容 | 结果 | 裁决 |
| --- | --- | --- | --- |
| `H-5: reports EFFECTIVE membership` | 删掉 `effectiveMemberAccountIds` 下发 | **失败**（`undefined ≠ []`） | ✅ 有判别力 |
| **`H-5: the batch still refuses, and the ghost id is never touched`** | 同上（回退 H-5） | **仍然通过** | ❌ **恒真/无效测试** |
| `H-6: refuses a test whose saved target model left the catalog` | 回退 `resolveTargetModel` 校验 | **失败** | ✅ 有判别力 |
| `M-3: names the failure cause structurally` | 删掉两个 409 的 `reason` | **失败** | ✅ 有判别力 |
| `M-5: does not read check-in state while the pool is off` | 删掉池关闭跳过 | **失败** | ✅ 有判别力 |
| `M-5: caches check-in state across polls` | 删掉 TTL 缓存 | **失败** | ✅ 有判别力 |

**恒真测试的原因**：`H-5: the batch still refuses` 断言 `rows === []` 且 `upstream === 0`。但**幽灵 id 本来就解析不出凭据**，`poolMemberAccounts()` 过滤后为空 → 批量本来就不发任何请求。也就是说该测试断言的正是"修复**没有**改变的行为"，**与 `effectiveMemberAccountIds` 无关**；它在回退版上必然也通过。你在自查里修掉的两个隔离问题（把 usage 面板的签到读取算进批量、断言增量必须为 0）**确实修对了方向**，但这条漏了同一类问题的另一面。
**建议**：把断言换成能区分的行为 —— 例如断言"点击测试按钮时按钮应处于 `disabled`"（这才能捕获 §2.2 的缺口），或断言 Host 路由对"全幽灵成员"返回 409。**这条测试目前会给 §2.2 的缺口提供虚假的安全感。**

**覆盖面缺口**：新增回归测试只覆盖 H-5/H-6/M-3/M-5。**H-1 / H-2 / H-3 / H-4 这四个最高危（数据丢失、错误计费）没有任何自动化回归测试**——正是本轮最容易再退化的四条。建议至少把 H-1（两账号保存序列）与 H-2（未保存时下拉保持禁用）做成组件级测试；本报告的脚本可直接改造为测试用例（§7）。

---

## 5. 其余修复的裁决（逐条）

| 编号 | 裁决 | 证据（脚本） |
| --- | --- | --- |
| **M-3** 409 结构化 + 本地化 | ✅ 已修复 | `t19_c24_m3.mjs`：池关闭时点批量，界面渲染 `本区域的账号池是关闭的。请先启用并保存，再执行批量操作。`，**英文原文不再出现**，且与 zh 字典逐字一致 |
| **M-5** TTL 缓存 + 池关闭不读 | ✅ 已修复 | `t24_m5_clean.mjs`（3 账号）：池关时每次轮询 `checkin-activity-status` 仅 1 次（usage 文档自带的选中账号面板读，非池扇出）；池开时首轮 3 次（每成员一次），随后 0 次（TTL 生效）。变异体回退后两条测试都失败 → 有判别力 |
| **M-9 / C4-3** `usable` 只算成员 | ✅ 已修复 | `t23_c43_clean.mjs`：唯一成员被限流、同时存在一个**未入池**账号 → 强制重读后「账号池里目前没有可用的账号」**正常出现**（回退前该警告永不出现）。**注意**：不重读时看不到（批量后界面不自动刷新，属 M-4） |
| **C2-1** 重挂载写假轮换记录 | ✅ 已修复 | `t25_final.mjs` (1)：**轮换已开启**时挂载卡片 → 日志为空；折叠+重开仍为空（`t13_rotationlog.mjs` 用标记法确认不是"销毁+新写"） |
| **C2-2** 回退不记录 / 同账号漏记 | ✅ 已修复 | `t13_rotationlog.mjs`：轮换停止写入「轮换已停止 —— 回到 …」；再次轮到**同一账号**也有新记录（旧代码会静默跳过） |
| **C2-3** 日志/ref 跨区泄漏 | ✅ 已修复 | `t14_c23.mjs`：cn 轮换记录不出现在 global 标签页日志中 |
| **C2-4** `from` 空名占位符 | ❌ **未修复（仅修了 `to` 方向）** | 见 §2.3 |
| **C1-1** 批量失败写日志 | ✅ 已修复 | `t15_cheap2.mjs`：500 响应 → 日志出现「批量操作失败 —— 没有执行：boom」（此前只有悬空的「开始…」） |
| **C1-3** 批处理中禁用清空 | ✅ 已修复 | `t26_clean.mjs`：批处理在途 `disabled = true`，结束后 `false` |
| **C4-2 / A-9** `targetLabel` 接入渲染 | ✅ 已修复 | `t10_cheap.mjs`：`preferred`→「你指定的模型：paid」；`free`→「自动选中的免费模型：free」；`none`→提示行。三条分支都真的渲染出来了 |
| **C4-5** 摘要自相矛盾 | ✅ 已修复 | 同上：`source='none'` 时摘要显示「目标模型 无免费模型」，与下方告警一致（`contradicts itself? false`） |
| **A-5** 保存中拒绝编辑 | ✅ 已修复 | `t16_a5.mjs`：保存中点击复选框 → 草稿不变（`已选 1 / 1` 保持），且 **React 的受控回写把 DOM 勾选态复位**，未留下"看着勾上了其实没有"的视觉谎言；保存落地后 Host 与界面一致 |
| **A-11** `row.result.outcome` 校验 | ✅ 已修复 | `t15_cheap2.mjs`：桩化无 `result` 的行 → 渲染「Alpha：Host 未返回该账号的结果」、循环继续、**写出「测试完成」**，无 `TypeError` |
| **A-12** 失效占位项 | ❌ **未修复（不可达 + 静默清空）** | 见 §2.4 |
| **C4-7/8/9** 文案据实修正 | ✅ 已修复（抽验） | 文案与实现逐条比对一致（区域开关前置条件、第四种排除原因 `unusable`、token 过期并列排序键均已写入文案） |

---

## 6. 汇总

### 6.1 裁决计数

| 裁决 | 数量 | 条目 |
| --- | --- | --- |
| ✅ **已修复** | **15** | H-1、H-2、H-4、H-6、M-3、M-5、M-9/C4-3、C2-1、C2-2、C2-3、C1-1、C1-3、C4-2/A-9、C4-5、A-5、A-11、C4-7/8/9（其中 M-9 与 C4-3 为同一条） |
| ⚠️ **部分修复** | **1** | **H-5**（计数与签到按钮已修；**测试按钮仍放行 → 原症状可复现**） |
| ❌ **未修复** | **2** | **C2-4**（只修 `to` 方向，`from` 仍渲染裸 id）、**A-12**（占位项不可达；且失效 id 会被静默清空） |
| 🆕 **修复引入新缺陷** | **1** | **H-3**（`applyRotation` 竞态：旧 ON 覆盖新 OFF → 关池后 override 仍在，H-3 症状重现） |
| ⚪ **无法验证** | **0** | — |

### 6.2 对你修复质量的总体评价

**主体是扎实的，且比上一轮有实质性进步。** 三条最有价值的修复我都独立复现通过：**H-1** 用"两账号保存序列"证明数据不再丢（且我在回退版上确认脚本有判别力）；**H-2** 的"读已保存值 + 显式待保存提示"是我见过对这类断层最诚实的修法（把"UI 允许的操作"与"Host 会执行的操作"绑死，代价只有一次额外保存，而且**给了用户解释**）；**H-4** 的三方门控双向都实测闭合，且我按你点名的方向去找第四个写入者，确认 `regions` 槽确实只有三个（`switchAccount` 写的是 `accounts` 字段，实测不会互相回退）。`E-fix-log.md` 里"未修（有意保留）"一节写得尤其好——它把 M-1/M-2/M-4/L-5 的取舍理由讲清楚了，这种自我限定比多修几条更有价值。

**但有一类问题贯穿了本轮：修"读"的一端，没修"写"的一端（或反过来）。**

- **H-5** 把客户端计数与**一个**按钮改对了，另一个按钮留在原地 → 原缺陷症状完整存活（§2.2）。
- **C2-4** 把 `to` 分支改对了，`from` 分支留在原地（§2.3）。
- **A-12** 把占位项**加进了代码**，却没检查它在 H-6 之后是否还有触发的可能 → 变成了不可达的死代码（§2.4）。
- **H-3** 把"调用点补上"了，却没检查 `applyRotation` 在"每次提交都调用"之后是否还满足可重入性 → 引入了比原缺陷更隐蔽的竞态（§2.1）。

这四条的共性不是粗心，而是**验证停在"目标路径修好了"，没有继续问"同一判定的其他出口呢"、"这个分支现在还能被触发吗"、"这个函数现在会被并发调用吗"**。你在 §4 自查里已经抓到过这个模式（两个恒真测试），说明方法已经具备，只是**没有把它机械地套用到每一条修复上**。

**两条具体建议**：

1. **把"同一判定的所有出口"变成清单**。H-5 的两个按钮、C2-4 的两个分支、A-12 的"加分支"与"分支可达"都是同一模式。你已经在 `E-fix-log.md` 里为写入者建了清单（H-4），把它推广到"判定/分支"层面即可。
2. **`H-5: the batch still refuses` 这条测试现在是负资产**——它恒真，却给 §2.2 的缺口提供"已覆盖"的错觉。建议立刻改成断言"测试按钮在零有效成员时禁用"，或在 Host 侧把 `no-members` 守卫改为基于可解析成员（两者都做最好：客户端拦、Host 兜底）。

**优先级建议**（按用户可感知的破坏力）：
1. **H-3 竞态**（界面说池已关，实际仍按轮换账号计费 —— 与 H-3 原缺陷同害，且更隐蔽）
2. **H-5 测试按钮**（界面宣称"测试完成"，实际零请求）
3. **A-12 静默清空**（用户保存的选择被抹掉，且无提示）
4. **C2-4 `from` 裸 id**（观感问题，改动最小）

---

## 7. 复现脚本与清理

全部脚本写在 `/tmp/fverify/`（**仓库外**），按任务要求**已删除**。仓库内零残留：本会话唯一写入是本文件；`src/`、`tests/` 一字未改（哈希见 §0.1，与 E-fix-log 记录一致）。

**一个必须记录的事故与处置**：初版 harness **未隔离 `$DSH_HOME`**，导致被测插件把一条合成探针结果（`ff4d…: rate-limited`）写进了**真实的 `~/.dsh/.workbuddy-pool.cn.json`**。发现后立即：
① 备份现场（`/tmp/fverify/pool.cn.json.polluted-backup`）；
② 按时间戳分离出**唯一**由本会话注入的那条记录并删除，其余 7 条（06:27–06:42 写入，早于本会话）**逐字节保留**；
③ 给 harness 补上 `DSH_HOME`/`HOME`/`USERPROFILE`/`LOCALAPPDATA`/`APPDATA`/`XDG_CONFIG_HOME` 全部指向临时目录（与仓库 `vitest.config.ts:39` 的做法一致），之后所有结果均在隔离环境下重跑。
`.workbuddy-pool.global.json` 与 `~/.dsh` 下其余文件未被本会话改动。

**重建配方（四个非显然要点，与 D 报告一致）**：

1. `/tmp/fverify/render` 里 `npm install react-dom@18.3.1 jsdom`，并把该目录的 `react` 换成指向仓库 `node_modules/react` 的 **symlink**（否则 hooks 双实例崩溃）。
2. `.tsx` 加载：`node:module` 的 `register()` 写 `load` 钩子，内部 `typescript.transpileModule(src, { jsx: JsxEmit.ReactJSX })`。
3. FakeSettings 的 `mutate` **必须就地写回** `apply()` 收到的那个 config 对象，否则 `current()` 看不到写入，H-1/H-3/H-5 全部失真。
4. 复选框用 `input.click()`（jsdom 会走 activation behavior）；数字/下拉框用原生 setter + `Simulate.change`；探针结果与 `current()` 都依赖 `$DSH_HOME`，**必须隔离**。

**变异体做法**：`cp -R src <mutant>/src` + `ln -s <repo>/node_modules <mutant>/node_modules`，用脚本把修复逐条替换回缺陷版本，再以 `TREE=<mutant>` 跑同一脚本；`repo-mutant` 则是整仓副本（含 `tests/`），可直接 `vitest run`。
