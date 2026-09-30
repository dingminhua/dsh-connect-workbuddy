# 审计 D：独立复现验证（对抗式）

> 验证员：`audit-verify`（共享任务板 `task-4`）。对象：A / B / C 三份审计报告的**全部「确认缺陷」**，外加 Lead 的 L-1..L-5。
> **只信复现，不信结论。** 每条发现都尽量构造可执行反证；找不到反证才写「已复现」。
> 本文件是本次会话**唯一**写入：`git status` 确认 `src/`、`tests/`、`docs/audit/{A,B,C,LEAD}*.md` 未被本会话改动（本会话只读）。

## 0. 方法与一个重要的方法论更正

### 0.1 环境事实：真实渲染**是可行的**

审计 A 与审计 C 都把「本项目没有 react-dom / jsdom」当成方法边界（`A-account-pool.md:21`、`C-interaction.md:10`、`tests/searched-paths.spec.ts:6`），并因此把大量条目降级为「纯逻辑推测」或「待验证」。

**这个前提不成立。** 仓库默认没装，但它是可安装的：

```
$ cd /tmp/dverify/render && npm install react@18.3.1 react-dom@18.3.1 jsdom
added 44 packages in 3s
```

本次验证因此做到了 A 与 C 都**没有**做到的事：把**真实的 `AccountPool.tsx` / `WorkBuddyCard.tsx`** 用 **react-dom 18.3.1 + jsdom** 渲染进真实 DOM，并让它的 `fetch()` 走**真实挂载插件**的真实路由（`apply()` + `webServer.register` + `settings.mutate` 就地提交 → `current()` 能看到写入），上游用桩。

所以：**A 的 V-1（siblingBusy 时序）、C 的 C2-4、C 声明的「凡涉及真实渲染的都标待验证」，本次都被真实渲染取代**。这些条目的裁决强度高于报告本身。

### 0.2 验证环境

| 项 | 值 |
| --- | --- |
| Node | v25.9.0（`--experimental-strip-types` + 自定义 `resolve`/`load` 把 `.tsx` 转译后加载） |
| React / react-dom / jsdom | 18.3.1 / 18.3.1 / 安装于 `/tmp/dverify/render` |
| 被测代码 | **未改动**：`AccountPool.tsx b5a8117521d1`、`WorkBuddyCard.tsx 755dcc61160d`、`web-status.ts 034c4a327dd0`、`status-paths.ts bfa7467eb433`、`index.ts 9f470926f0cb`、`account-pool.ts e61029559513`、`account-pool-run.ts ca93f2e2cfe3`、`account-selection.ts 825878bc073e`、`auth.ts 57ea87317f3c` |
| Host 挂载 | `new Context()` + FakeWebServer + FakeSettings + **真实 `WorkBuddy.apply()`**，同 `tests/pool-e2e.spec.ts:87-98` 的 `mount()`；`settings.mutate` 就地写回 `config`，使 `current()` 与真实 Loader 提交一致 |
| 脚本位置 | `/tmp/dverify/`（**仓库外**；按要求**已删除**，见 §6 的重建配方）。仓库根目录零残留，`git status` 无新增 |

**基线核对（本次实测，全部一致）**：A/B/C 三份报告声明的 9 个 `sha256` 前 12 位与当前工作区**逐字符相符**，因此报告中所有行号引用有效。

```
$ for f in src/client/AccountPool.tsx src/client/WorkBuddyCard.tsx src/client/account-selection.ts \
           src/web-status.ts src/status-paths.ts src/index.ts src/account-pool.ts src/account-pool-run.ts src/auth.ts; do
    printf "%-40s %s\n" "$f" "$(shasum -a 256 "$f" | cut -c1-12)"; done
src/client/AccountPool.tsx  b5a8117521d1   …（9/9 与报告一致）
```

统一调用形式（脚本已删，见 §6）：`cd /tmp/dverify && node --experimental-strip-types --import ./loader-register.mjs <script>.mjs`

### 0.3 裁决口径

- **已复现** = 在本机用命令产出与报告一致的现象；输出摘要见证据列。
- **无法复现** = 本环境无法产生该现象（附原因）。
- **报告有误** = 报告描述的行为与实际相反，且给出反证。

---

## 1. 高危发现（必须裁决）

| 编号 | 来源 | 裁决 | 证据（命令 + 输出摘要） | 备注 |
| --- | --- | --- | --- | --- |
| **A-1 / L-3** | A / Lead（C 附录「模型 A」为同一根因） | **已复现** | `node … t2_memberloss.mjs`（真实卡 + 真实路由）<br>`0. saved members` = `[]` → 勾选唯一账号 → 保存 → `saved members ["ff4d…"]` → **再勾同一行** → `checked rows: 0`、`count label 已选 0 / 1`、保存按钮 `disabled=false` → 再保存 → **`saved members []`**（刚保存的成员被静默删除） | 报告描述的「需要外部写入者」偏保守：**自身保存路径即可命中**（C/Lead 的修正正确）。机制 = `useCallback` 依赖数组漏 `saved.memberAccountIds`，`discard()` 引发的重渲染先于重读落地、之后依赖不再变化 → 闭包持有旧 `saved`。变体（外部写入者落地成员 `[A]`→轮询→再勾一次）同脚本 V 段复现 |
| **A-2 / C3-1 / L-1** | A / C / Lead（三方独立同结论） | **已复现** | `node … t1_unlock.mjs`<br>`STEP 1` 下拉 `disabled=true`、冲突提示在、徽标「自动轮换中」<br>`STEP 2` 点「关闭自动轮换」后 下拉 `disabled=false`、冲突提示消失、徽标消失<br>`STEP 3` Host 仍 `pool.rotateByCredits = true` | 真实渲染 + 真实 Host 两侧都验到。另确认父组件**没有第二道防线**：`switchAccount`（`WorkBuddyCard.tsx:438-456`）无任何轮换检查。C3-2 是同一状态机的另一出口，单列 |
| **B-1** | B | **已复现** | `node … t17_delta.mjs`：saved 成员 = 幽灵 id、磁盘只有 1 个真实登录<br>`client-side state` `已选 1 / 1 \| button disabled=false`<br>点击后 `upstream delta` = `{"upstream":0,"usage":0,"pool":1,"save":0}`；`log` = `["签到完成","开始签到 1 个账号（逐个执行）"]`；`actionError (none)` | **静默成功假象**成立：0 次上游请求、界面宣称完成。B 给的三条「已选 N/M / 按钮可用 / 行未勾」现象逐条对上 |
| **B-2** | B | **已复现** | 纯函数 `resolveTargetModel([{id:'m1'}], 'ghost')` → `{"modelId":"ghost","source":"preferred"}`；挂载实测 `targetModelSource: preferred`、`targetModelId: ghost-model-not-in-catalog`、`id in catalog? false`；`node … t5b_target.mjs`：`test button disabled = false`、无「没有免费模型」告警、点击后 Host 真的跑批：日志 `开始测试 1 个账号 × ghost-model-not-in-catalog` | 报告「`source=none` 与「有 id」互斥的另一半未被覆盖」准确。按钮禁用条件确实只拦 `'none'` |
| **C3-3** | C | **已复现** | `node … t13_misc.mjs`：测试批次后 `rotatedTo 9c847…` → **把池开关关掉并保存**（`saved pool.enabled now false`）→ `rotatedTo` **仍是 9c847…**；手动测试路由此时 `409 {"error":"account pool is disabled for this region"}`；`applyRotation call sites` = **2**（`index.ts:913` 手动测试、`:1224` 定时测试，均在测试路径） | 「关闭池 → override 永不清理 → `current()` 继续优先它」在真实 Host 上成立。**开启方向滞后**亦成立：`duePoolRegions` 的 `enabledOf` 还要求区域开关（`index.ts:1180-1183`），`pool-e2e.spec.ts:370-376` 用真实定时器固定了「第一个 tick 只上弦」 |
| **L-4** | Lead | **已复现** | `node … t4_l4.mjs`<br>(a) 池保存进行中：池保存按钮 `disabled=true`，**区域开关 `disabled=false`**（判定式实测为 `disabled={togglingRegion === region \|\| !canWrite}`）<br>(b) 受控交错：`[save #1] pool-preferences … 落地 100ms`、`[save #2] region-toggle … 落地球 220ms`（载荷 `{"value":{"cn":{"enabled":false,"pool":{…"memberAccountIds":[]}}}}` = **过期整槽**）→ 最终 `saved members []`，而池保存本已写入 `["ff4d…"]` | 报告结论（第三个写入者绕过串行门控、带过期快照覆盖）成立。机制比报告更具体：`toggleRegion` 把**整个区域槽**（含过期的 `pool`）交给 `__save`，Host 按区域整体替换 → 池偏好一起被回退 |

**高危合计：9 条编号（去重后 6 个根因）→ 全部「已复现」。**

---

## 2. 「界面说谎」类中级发现（指定复核）

| 编号 | 来源 | 裁决 | 证据（命令 + 输出摘要） | 备注 |
| --- | --- | --- | --- | --- |
| **A-3** | A | **已复现** | `node … t3_actions.mjs`<br>case 1（草稿勾 1、已保存为空）：`checkin button disabled false`、`draft count label 已选 1 / 1`、`inline "unsaved" hint 勾选已改动 —— 保存后生效` → 点击 → `actionError: no accounts are checked into this region's pool`（中文界面下的**英文原文**），同一次点击的日志却是 `开始签到 0 个账号（逐个执行）`<br>case 2（草稿开池、已保存关池）：点击 → `account pool is disabled for this region` | 两个变体都复现。**「加重项」（Host 英文串直出）确认**。附带一个比报告更尖锐的观察：同一次操作里界面同时显示「已选 1/1」与日志「签到 0 个账号」，即**同一块 UI 自己否定自己** |
| **B-3** | B | **已复现** | 同 t3_actions.mjs：两种 409 的 `error` 分别是 `no accounts are checked into this region's pool` / `account pool is disabled for this region`，客户端只用 `body?.error ?? HTTP ${status}` 原样渲染，**不做结构化区分、不经 `t()`** | 报告称「无成员 409 在 UI 里不可能被触发」——**准确**，唯一路径就是它自己指出的「草稿已勾但未保存」，本次即由该路径触发。C4-6 是同一事实的文案侧 |
| **B-4** | B | **已复现** | `node … t3_actions.mjs` case 4：`usage reads before/after the batch: 2 -> 2`（批量成功后**零次** usage 重读） | 与 C1-2 同一根因。后果（`probe` / `rotatedToAccountId` 要等 60 秒轮询才出现）由 t8 的轮换日志时机侧证：轮换记录确实只在轮询后才出现 |
| **C4-2 / A-9** | C / A | **已复现** | `grep -c "targetLabel" src/client/AccountPool.tsx` = **1**（仅第 385 行声明）；`poolTargetPreferred`/`poolTargetFree` 全仓库只有 `AccountPool.tsx:386,388` 这两个**死分支**引用；渲染实测 `node … t5_contract.mjs`：目标模型 `source='preferred'` 时 `target label rendered anywhere? false` | 「算出来从不用 → 用户看不出目标模型来源」成立；且两个 locale key 因此看起来「已被使用」，会误导后续清理 |
| **C2-1** | C | **已复现** | `node … t8b_c21.mjs`（带区分标记，避免误判）：步骤 2 日志有 4 行（含标记行 `签到完成`）→ 折叠卡片（`.dsm-workbuddy-pool` 不再存在 = 真卸载）→ 重开 → 日志只剩 **1 行** `计费账号已从 — 切换到 Alpha`，标记行**全部消失** | 证明「日志被销毁 + 重挂载时**新写**一条假轮换记录」。**方法学提醒**：只用「记录条数」无法判定（销毁+新写与保留的条数相同），必须用标记行区分——这一点报告没写清 |

---

## 3. 所有其余「确认缺陷」的裁决（A/B/C 全覆盖）

> 本节各表的「来源」由小节标题给出：**3.1 = 审计 A，3.2 = 审计 B，3.3 = 审计 C，3.4 = Lead**；「级别」沿用原报告的定级。裁决口径同 §0.3。

### 3.1 审计 A（12 条）

| 编号 | 级别 | 裁决 | 证据 | 备注 |
| --- | --- | --- | --- | --- |
| A-1 | 高 | 已复现 | 见表 1 | |
| A-2 | 高 | 已复现 | 见表 1 | |
| A-3 | 中 | 已复现 | 见表 2 | |
| A-4 | 中 | **已复现** | `node … dbg_num4.mjs`：清空字段 → 立刻变 `"5"`（`Number('')===0` 不被 `isFinite` 拦住）；逐键键入 `120` → 字段 `5 → 51 → 512 → 1440`，最终**持久化 1440**；`typing 30 -> "530"`、`typing 45 -> "545"`、`typing 12 -> "512"`、`typing 600 -> "1440"`、`typing 90 -> "590"` | 缺陷成立（受控输入每次按键 clamp，用户永远输不进目标值）。**但报告给出的具体数值与实际不符**：报告写「想输入 120 会得到 520 / 想输 30 得到 50」，那是「按键值整体替换」模型；真实按键是**在受控回写后的值上追加**，实测得 1440 / 530。数值见 §5 失准项 1 |
| A-5 | 低 | **已复现** | `node … t7_ui.mjs`：保存进行中 `row checkbox disabled: false`；`during save draft 已选 2 / 2` → 保存落地后 `after the save resolved: draft 已选 1 / 2`，Host 只有 1 个成员（`the mid-flight edit survived: false`） | 期间的新编辑被 `discard()` 无条件吞掉，且无提示 |
| A-6 | 低 | **已复现** | `node … t7_ui.mjs`：`cn draft 已选 1 / 1` → 切 global → 勾 1 个 → 切回 cn → `cn draft after returning 已选 0 / 1`，且 `cn "unsaved changes" hint: undefined` | 单槽草稿 + 无提示，与报告一致 |
| A-7 | 低 | **已复现** | `node … t12_component.mjs`：saved 成员 = 2 个幽灵 id、1 个真实账号 → `count label 已选 2 / 1`（**count > total**）、`checkin button disabled: false`、所有行都没勾、无「没勾任何账号」警告 | 修复方向（取 现存账号 ∩ 成员）与报告一致 |
| A-8 | 低 | **已复现** | `node … t13_misc.mjs`：写入已落地而重读在途时 `checked 已选 0 / 1`、`dirty hint 修改任一设置后即可保存。`（已回落）、而 `Host has the member ["ff4d…"]`；重读落地后回到 `已选 1 / 1`。`t14_last.mjs` A-8b：让重读返回 500 → `write landed on the Host? ["ff4d…"]`、**`pool section still on screen? false`**（整块池区消失） | 「界面短时回退」与「刷新失败则池区消失」两半都复现 |
| A-9 | 低 | **已复现** | 同 C4-2 证据 | |
| A-10 | 低 | **已复现（函数语义）** | `node … t12_component.mjs`：从源文件**逐字抽取** `sameIds` 并经 tsc 去类型后执行 → `sameIds(['a','a'],['a','b']) = true`、`sameIds(['a','b'],['a','a']) = false`、`sameIds(['a'],['a']) = true` | 单向包含确实不可靠。**可达性比报告更低**：组件的编辑路径全部经 `Set` 去重，`draft.memberAccountIds` 只有在「基准已含重复 id 且用户只改标量」时才带重复，而那种情况下标量差异本身已使 `dirty=true`；要出现「dirty 误为 false 且掩盖改动」需要「外部重复 id + 标量改回 + 外部再改成员」三段巧合。报告自己的「可达性（诚实标注）」是准确的，但可再收紧 |
| A-11 | 低 | **已复现** | `node … t12_component.mjs`：桩化 `rows:[{accountId,accountName}]`（无 `result`）→ `actionError: Cannot read properties of undefined (reading 'outcome')`、日志停在 `开始测试 1 个账号 × free-1`、**无** `测试完成` 行 | 与 C 的「防御性备注」同一点 |
| A-12 | 低 | **已复现** | `node … t12_component.mjs`：`targetModelId='gone-model'` 不在 catalog → 摘要行 `目标模型 gone-model`，而 `select .value ""`、`selectedIndex 0`、可见项 `自动 —— 挑一个免费模型`、`option values ["","free-1"]` | 显示与存储分叉成立（jsdom 的 select 选中态按规范回落到首项，与真实浏览器一致）。报告的「旁证」（父组件手动下拉专门插了占位 option）经查存在（`WorkBuddyCard.tsx:918-928`） |

### 3.2 审计 B（11 条）

| 编号 | 级别 | 裁决 | 证据 | 备注 |
| --- | --- | --- | --- | --- |
| B-1 | 高 | 已复现 | 见表 1 | |
| B-2 | 高 | 已复现 | 见表 1 | |
| B-3 | 中 | 已复现 | 见表 2 | |
| B-4 | 中 | 已复现 | 见表 2 | |
| B-5 | 中 | **已复现** | `node … t13_misc.mjs`：一次 usage 读取（2 个账号）的上游序列 = `[get-user-resource, checkin-activity-status × 3]`；即在**不打开卡片、不做任何操作**的情况下，每次轮询都会按账号发签到状态请求 | 「每个账号每分钟一次」的量级成立（实测 2 账号一次读取 ≥3 次请求）。报告未夸大 |
| B-6 | 低 | **已复现（结构）** | `grep -rn "\.member\b" src/client/` → **无输出**；挂载实测 `accounts[0].member` 确有下发（`"member":false`），客户端一律用 `active.memberAccountIds.includes(...)` 推断勾选态 | 与 B-1 同根因的另一面 |
| B-7 | 低 | **已复现** | `node … t5_contract.mjs`：两种配置下 `pool block keys` 恒含 `catalog`、`"catalog" key present true`；未保存任何模型列表时仍下发 `catalog length 12` | 「可选标记与实际行为不符」成立；「靠 `targetModelSource` 判空是对的」亦成立 |
| B-8 | 低 | **已复现** | `node … t13_misc.mjs`：目录原样下发 `creditMultiplier:0` / `0.5` / **键缺席**，客户端渲染 `Free (x0.00)` / `Paid (x0.50)` / `No Multiplier` | 报告结论是「已正确接线」，本次独立复核**确认正确**（0 未被当假值丢弃） |
| B-9 | 低 | **已复现（结构）** | `grep -rn "streakDays" src/ tests/`：`status-paths.ts:602` 声明、`account-pool-run.ts:136` 赋值，`src/client/` **零消费** | |
| B-10 | 低 | **已复现** | `node … t12_component.mjs`：签到列未知态渲染 `—`，其 `title` = `尚未测试` | 报告的**正文**准确；但它的**小标题**（「`accountName` 的 `''` …占位文案是 `—`」）把账号名占位（`row.accountUnnamed`=「未命名账号」，`:532`）与签到列占位混为一谈，容易误读。属表述问题，非误报 |
| B-11 | 低 | **已复现（结构）** | `grep -rn "WorkBuddyWebPoolCheckinAnswer\|WorkBuddyWebPoolTestAnswer" src/ tests/ \| grep -v "^src/status-paths.ts"` → **无输出** | 客户端 `runAction` 用就地匿名类型（`AccountPool.tsx:341-343`），契约守卫缺口成立 |

### 3.3 审计 C（23 条）

| 编号 | 级别 | 裁决 | 证据 | 备注 |
| --- | --- | --- | --- | --- |
| C1-1 | 中 | **已复现** | `node … t3_actions.mjs` case 5（桩化 500）：`log lines` 只有 `["开始签到 1 个账号（逐个执行）"]`、`actionError: boom` | 失败行只出现在日志之外，日志留一条悬空「开始」 |
| C1-2 | 低 | **已复现** | 同 B-4（`usage reads 2 -> 2`） | 与 B-4 同一根因 |
| C1-3 | 低 | **已复现** | `node … t7_ui.mjs`：批次在途时 `clear button disabled: false` → 按清空 → `log right after pressing clear []` → 批次结束后 `log ["签到完成","Alpha：签到失败 …"]` | 「清空没生效」成立 |
| C1-4 | 低 | **已复现（结构）** | `AccountPool.tsx:796-798` `key: \`${entry.atMs}-${index}\`` + `:243-245` 前插 | 前插使既有行 `index` 全部 +1 → key 变化 → 整列表重挂载。报告已自行声明「不会重复 key、是成本不是 bug」，准确 |
| C1-5 | 低 | **已复现** | `node … t12_component.mjs`：桩化响应 `modelId: MODEL-THE-HOST-REALLY-USED`，日志仍打印 `开始测试 1 个账号 × STALE-FROM-THE-POLL` | 权威字段被丢弃、日志用轮询快照，成立 |
| C2-1 | 中 | 已复现 | 见表 2 | |
| C2-2 | 中 | **已复现** | `node … t11_final.mjs`：①`after a non-rotating run, rotatedToAccountId undefined` 但 `log after the clear` **无新行**（回退不入日志）→ ②`rotation #2` 回到**同一账号**（`same account as #1? true`）→ `rotation records 1`（**完全不记录**）→ ③在 `t10_c22.mjs` 中，清除后轮到另一账号时日志写 `从 Alpha 切换到 Beta`，而中间真实状态是「手动」 | ①②③ 三小点都复现。（③ 的 `from` 名取自 ref 旧值，与运行时状态不符） |
| C2-3 | 中 | **已复现** | `node … t11_final.mjs`：cn 轮换到 `9c847…` 后切到 global 并让 global 自己轮换 → global 标签页的日志出现 `计费账号已从 9c847c483f7ce0ddaae7dd00 切换到 Gamma`（`cn's rotated account id appears inside a global-tab record: true`） | 裸 id 跨区泄漏，与 `row.poolRegionNote`「两个池完全独立」的承诺矛盾 |
| C2-4 | 低 | **已复现**（报告标「待验证」） | `node … t15_c24.mjs`：先轮换到空名账号 → `从 — 切换到 未命名账号`；再轮到 Y → **`计费账号已从  切换到 Y`**（`from` 渲染为空串，`"from" is rendered as an empty string: true`） | 报告只能推断逻辑缺口、把渲染标为待验证；真实渲染证实 `?? ` 拦不住 `''` |
| C3-1 | 高 | 已复现 | 见表 1 | |
| C3-2 | 中 | **已复现** | `node … t7_ui.mjs`：`initial 下拉 disabled / conflict = true / true` → 点解锁 → `false / false` → 点「放弃修改」→ **`true / true`** | 解锁被静默撤销 |
| C3-3 | 高 | 已复现 | 见表 1 | |
| C3-4 | 中 | **已复现** | `node … t9_rotate.mjs`：轮换生效后 `dropdown shows Alpha · www.codebuddy.cn`、`dropdown disabled true`，而 `pool table current row Beta…`、`Host current account Beta` | 「锁定态下拉显示 A、实际计费 B」在真实 Host + 真实渲染下成立。父组件的占位 option 修复（`:918-928`）**不覆盖**此场景（它有匹配 option，只是值过期） |
| C4-1 | 中 | **已复现** | `grep -n "appendLog(" src/client/AccountPool.tsx` 只有 4 处（轮换上报 + 批次三类）；`node … t14_last.mjs`：手动下拉切账号后 `log after switching to the other account []`、`log mentions a switch? false` | 「每次切换都会留下记录」对手动切换为假 |
| C4-2 | 中 | 已复现 | 见表 2（=A-9） | |
| C4-3 | 中 | **已复现** | `node … t12_component.mjs`：成员全被排除 + 存在一个**未入池**账号 → 告警 `[]`、`warning present? false`；把那个账号也变成成员（全员排除）→ `warning shown? true` | 「整表 usable 判定 → 有未入池账号时永不出现」，成立 |
| C4-4 | 低 | **已复现** | 同 B-10 | |
| C4-5 | 低 | **已复现** | `node … t12_component.mjs`：`targetModelSource='none'` → 摘要 `目标模型 自动`，同屏告警 `本区域暂时没有倍率为 0 的免费模型。…` | 同屏自相矛盾成立 |
| C4-6 | 低 | **已复现** | `t12_component.mjs`（已保存为空 + 未勾选 → 告警 + 按钮禁用）+ `t3_actions.mjs` case 1（未保存勾 1 → 按钮**可用**） | 两个方向都复现 |
| C4-7 | 低 | **已复现（结构）** | `index.ts:1180-1183` `enabledOf: region => poolPreferencesOf(...).enabled && regionEnabled(current(), region)` | 间隔提示未提区域开关 |
| C4-8 | 低 | **已复现** | `account-pool.ts` 出现 `rate-limited / out-of-credit / credential-rejected / unusable` 四种排除原因；`exclusionText` 显式映射 `unusable`（`AccountPool.tsx`），而 `poolNoCandidateHint` 只列三种 | |
| C4-9 | 低 | **已复现（结构）** | `account-pool.ts:204-215` 排序键 = `_usable → score → _expiring → _tokenExpiresAtMs → id`；文案是「可用性 → 积分 → 可用时间」 | token 过期并列键未提 |
| C4-10 | 低 | **已复现** | 由 C3-1（解锁后仍计费 B）+ C3-4（锁定态下拉显示 A 计费 B）共同成立 | |
| C4-11 / C4-12 / C4-13 / C4-14 | —（报告的「✅ 一致」项） | **已复现（结论一致）** | C4-12：`pickFreeModel` 实测选中 `free-big`（跳过 `0.5`、取 `contextWindow` 最大）；C4-13：批次确实只跑已保存成员（B-1/C3-3 的批次证据）；C4-14：轮换记录不经保存按钮即落盘（t8/t9 中轮换记录在未保存任何草稿时出现）；C4-11：与 `account-pool-run.ts` 的串行逻辑一致 | 这 4 条是「文案与实现一致」的核对，本次独立复核**未发现误判** |

### 3.4 Lead 的 L-2 / L-5

| 编号 | 级别 | 裁决 | 证据 | 备注 |
| --- | --- | --- | --- | --- |
| L-2 | 中（模式归纳） | **已复现** | 归纳正确：L-1（锁定判定用草稿、运行时用已保存）与 A-3（按钮用草稿、执行用已保存）都是同一断层的实例，两者分别在 t1 / t3 复现。其中「池开关」一例也复现：草稿开池未保存 → 按钮可用 → Host 返回 `account pool is disabled for this region` | Lead 对该例「低 severity，因为失败是可见的」的判级**准确**：错误确实可见（`t3_actions.mjs` case 2） |
| L-5 | 中 | **已复现** | `node … t16b_l5.mjs`：两次**保存触发**的 `refreshUsage`（`onSaved` 不传 signal）→ 第 1 次响应延迟 500ms、第 2 次即时 → `cn usage reads issued 2`、最终 `card shows STALE · www.codebuddy.cn`、`=> the older STALE snapshot won: true` | 报告点名的两条路径（模型保存 `:764`、池保存 `:1241`）确实无 signal/序号护栏。**一处更精确的边界**：轮询/切标签路径 `:394-400` 是传 `AbortController` 的——`t16_l5.mjs` 里同一手法在切标签路径下**没有**覆盖成功（STALE 被 abort 丢弃）。所以「没护栏」只适用于保存触发的两条路径，不适用于轮询路径（见 §5 失准项 2） |

### 3.5 附带裁决：A/C 标为「待验证」的条目

| 编号 | 来源 | 裁决 | 证据 |
| --- | --- | --- | --- |
| A 的 V-1（siblingBusy 一帧残留窗口） | A | **报告有误（判级放过）** | 真实渲染实测：`t19_e5_sibling.mjs` (b) 模型草稿变脏后模型保存按钮 `disabled=false` → 池保存进行中变为 `disabled=true` → 池保存结束后回到 `disabled=false`；`t4_l4.mjs` (a) 池保存进行中池保存按钮 `disabled=true`。**即 `siblingBusy` 的双向互斥确实生效，A 对 V-1 本身的怀疑（一帧残留窗口）不成立** | 但 A 由此把这一整片区域判为「倾向：不算缺陷」并放过，而**同一片区域里有两个真缺口**：A-5（保存期间草稿控件仍可编辑、成功后无条件丢弃）与 L-4（第三个写入者 `toggleRegion` 完全不受门控）。**缺口的结论本身不错，判级方向错了**——它遮蔽了两个已复现的缺陷 |
| C 的待验证 1（C2-4 渲染） | C | 已复现（见 C2-4） | t15_c24.mjs |
| C 的待验证 2（C1-5 分叉） | C | 已复现（见 C1-5） | t12_component.mjs（人为制造分叉即可，说明字段确实被丢弃） |
| C 的待验证 3（C3-4 渲染面） | C | 已复现（见 C3-4） | t9_rotate.mjs |

---

## 4. 「报告有误」清单（本任务最有价值的部分）

**结论：本轮 46 条 A/B/C 发现中，没有一条是「凭空误报」或「结论与实际相反」。** 逐条复现后，报告的事实性结论全部成立。真正需要更正的是下面 3 处**表述/边界**问题，以及 1 处**判级放过**：

| # | 条目 | 性质 | 更正内容与反证 |
| --- | --- | --- | --- |
| 1 | **A-4 的具体数值** | 数值失准（结论仍成立） | 报告写「想输入 120 会得到 **520**；想输 30 得到 **50**；想输 45 得到 **55**；想输 12 得到 **52**」。这是「按键整值替换」模型。真实受控输入会在**回写后的值上追加**，实测（`dbg_num4.mjs`）：`120 → 5 → 51 → 512 → 1440`（持久化 1440）；`30 → "530"`、`45 → "545"`、`12 → "512"`、`600 → "1440"`、`90 → "590"`。**缺陷本身成立且比报告的数值更难用**，但报告列出的对照表不能用 |
| 2 | **L-5 的护栏范围** | 覆盖面不完整 | L-5 只说两条保存路径「没有请求序号或 abort 护栏」，字面上**正确**；但它没有说明轮询/切标签路径**有** `AbortController` 护栏。反证：`t16_l5.mjs` 用同一「先发慢响应、后发快响应」手法，切标签路径下最终显示 `FRESH`（旧的 STALE 被 abort 丢弃），而保存路径下显示 `STALE`（`t16b_l5.mjs`）。建议报告把范围限定为「保存触发的刷新」 |
| 3 | **A-10 的症状可达性** | 可再收紧 | `sameIds` 函数本身确实不可靠（逐字抽取后实测 `['a','a']` vs `['a','b']` → `true`）。但报告描述的**用户可见症状**（「dirty 判为 false、保存按钮不亮」）还需要「草稿自身带重复 id」——而组件的三条编辑路径（`toggleMember` 用 `Set`、`selectAll` 用账号列表、标量编辑保留成员数组）都无法产生重复，只有「基准已含重复 + 只改标量」这一条路，此时标量差异已使 `dirty=true`。所以实际影响仅限于极窄的三段巧合；报告自己已标注可达性有限，此处只是比报告更收紧 |
| 4 | **A 的 V-1 判级** | 放过真缺口 | A 在 V-1 判定「倾向：不算缺陷」并仅建议加一次回归。真实渲染证明 `siblingBusy` 互斥**确实生效**（池保存中保存按钮禁用），但同一片区域里存在两个**未被 V-1 覆盖**的真缺口：A-5（保存期间草稿控件可编辑、成功后无条件丢弃）与 L-4（第三个写入者 `toggleRegion` 完全不受门控）。V-1 的结论本身不错，但它让读者以为「该区域已闭合」——实际没有 |

**另外 3 处非误报、但会误导的表述（建议一并修订）**：

- **方法论前提**：A（`:21`）与 C（`:10`）都以「本项目没有 jsdom / react-dom」为方法边界，并据此把若干条目降级。该前提在本机**可被解除**（`npm install react-dom jsdom`，3 秒）。因此 A 的 V-1、C 的三条待验证项本可实测；建议后续报告先尝试安装，再决定是否降级。
- **B-10 的小标题**：把「账号名占位」（`row.accountUnnamed`）与「签到列占位」（`—`）混写；正文正确，标题容易误读。
- **C 的计数自述**：C 头部写「确认缺陷 23 条」，而其正文表格共 27 行（其中 C4-11..C4-14 为「✅ 一致」）——23 与 27-4 相符，**无错**，但建议在表格里显式标注哪 4 条不计入，免得读者按 27 复算。

---

## 5. 总体可信度评估

### 5.1 裁决计数（共 51 个编号 = A 12 + B 11 + C 23 + L 5）

| 裁决 | 数量 | 明细 |
| --- | --- | --- |
| **已复现** | **51** | A-1..A-12（12）、B-1..B-11（11）、C1-1..C1-5 / C2-1..C2-4 / C3-1..C3-4 / C4-1..C4-10（23）、L-1..L-5（5） |
| 无法复现 | **0** | — |
| 报告有误（结论相反） | **0** | — |
| 数值/边界失准（结论成立） | **3** | A-4（数值）、L-5（护栏范围）、A-10（症状可达性）；另 A 的 V-1 属**判级放过**而非误报 |

> 其中 12 条由**真实 react-dom 渲染 + 真实 Host 路由**产出证据（A-1/A-2/A-3/A-4/A-5/A-6/A-7/A-8/A-11/A-12/C2-1/C2-4/C3-2/C3-4/C4-3/C4-5/C4-6/L-4/L-5），6 条由**真实挂载插件**产出（B-1/B-2/B-4/B-5/B-7/C3-3），其余为结构/grep 断言。

### 5.2 三份报告的准确率

口径：**已复现 / 已复现+报告有误**。由于「报告有误（结论相反）= 0」，准确率按「报告的事实结论成立 + 数字/边界无失准」两种严格度分别给出。

| 报告 | 确认缺陷数 | 已复现 | 数字/边界失准 | **结论准确率**（结论正确 / 总数） | **严格准确率**（结论+数值边界都无误 / 总数） | 评语 |
| --- | --- | --- | --- | --- | --- | --- |
| **A（AccountPool 组件逻辑）** | 12 | **12** | 1（A-4 数值） | **12/12 = 100%** | **11/12 ≈ 92%** | 事实最扎实的一份：A-1/A-2 两个高危、A-5..A-8 的时序与边界、A-10 的函数反例全部命中。报告的「已排除」项经抽验也成立——**E-5（写入失败不丢草稿）**由 `t19_e5_sibling.mjs` 双向拒写实测确认：`保存失败：…was not persisted…`、草稿仍在（`已选 1 / 1`）、保存按钮仍可点、**Host 未变（`[]`）**；即 `discard()` 位于 `await` 之后的设计是对的。唯一硬伤是 A-4 的对照数值表，以及 V-1 的判级放过 |
| **B（客户端↔Host 契约）** | 11 | **11** | 0 | **11/11 = 100%** | **11/11 = 100%** | 唯一做到「31 项已接线 / 0 项类型撒谎」逐字段三态核对的一份，本次抽验 B-6/B-7/B-8/B-9/B-11 全部与代码一致。B-1/B-2 两个高危在真实 Host 上逐字对上。**B-4 的自我限定（「不是字段没接线，而是读取时机」）尤其准确**——本次实测正是如此。唯一可改进的是 B-10 的小标题表述 |
| **C（交互/文案）** | 23 | **23** | 0 | **23/23 = 100%** | **23/23 = 100%** | 覆盖面最广（含文案逐条核对），且 23 条的**级别判定**没有一条夸大：本次把 C1-1/C2-1/C2-2/C2-3/C3-2/C3-4/C4-1/C4-2/C4-3 逐条做成可执行证据，全部成立。C2-4 报告只能标「待验证」，本次真实渲染证实其逻辑缺口成立。唯一可改进：C2-1 的「重挂载写假记录」需要标记行才能与「日志保留」区分，报告未点出这个判定陷阱 |
| **Lead（跨层复核）** | 5 | **5** | 1（L-5 范围） | **5/5 = 100%** | **4/5 = 80%** | L-1/L-3/L-4 三个高危全部复现（L-3 与 A-1 互为佐证；L-4 本次补上了真实交错复现），L-4 的「第三个写入者」判断尤其有价值。L-5 事实正确但漏了轮询路径有 abort 护栏这一边界 |

**综合**：四份报告的事实性结论 **51/51 全部可复现**，未发现任何凭空构造的缺陷或与实际相反的描述。主要风险不在「误报」而在两处：**(a) 个别数值/覆盖范围不够精确**（A-4、L-5），**(b) 用「纯逻辑推演 + 待验证」代替实测导致的判级放过**（A 的 V-1）——后者恰好放过了两个真缺口。把真实渲染接进验证流程后，这两类问题都可消除。

### 5.3 给 Lead 的修复优先级（按本次复现的破坏力排序）

1. **A-1 / L-3**（已复现的自足路径：保存成员 → 再勾一次 → 再保存即丢成员）
2. **A-2 / C3-1 / L-1**（一键解锁即出现「显示 A 计费 B」窗口）
3. **L-4**（区域开关用过期整槽覆盖，静默回退池偏好）
4. **B-1**（幽灵成员：界面宣称「开始签到 1 个账号 / 签到完成」，实际 0 次上游请求）
5. **C3-3**（关池后 override 永不清理，界面承诺「跟随你选择的账号」为假）
6. **B-2**（`preferred` 可为目录外 id，按钮与批量都放行）
7. A-3 / B-3 / B-4 / C4-2 / C2-1（界面说谎类，改动都很小）

---

## 6. 复现脚本、清理与重建配方

按任务要求，全部临时脚本**已删除**（写在 `/tmp/dverify/`，仓库外）。仓库内零残留：`git status --porcelain` 中本会话没有任何新增/修改，唯一写入是本文件 `docs/audit/D-verification.md`；`src/` 与 `tests/` 一字未改（已核对 9 个基线哈希，见 §0.2）。未修改 A/B/C/LEAD 四份报告。

复现所需的四个非显然要点（照此可在数分钟内重建）：

1. **单实例 React**：`/tmp/dverify/render` 里 `npm install react@18.3.1 react-dom@18.3.1 jsdom` 后，把该目录的 `react` 换成指向仓库 `node_modules/react` 的 **symlink**，否则 react-dom 与组件各持一个 React 实例，hooks 直接崩。
2. **.tsx 加载**：Node 的 `--experimental-strip-types` 不认 `.tsx`。用 `node:module` 的 `register()` 写一个 `load` 钩子，内部调 `typescript.transpileModule(src, { jsx: JsxEmit.ReactJSX })`，并把 `react/jsx-runtime` 指向上面那份 React。
3. **Host 挂载要"会写回 config"**：`mount()` 照抄 `tests/pool-e2e.spec.ts:87-98`，但 FakeSettings 的 `mutate` 必须**就地写回传给 `apply()` 的那个 config 对象**（真实 Loader 就是这么提交的）——否则 `__save` 成功、`current()` 却看不到，`pool.enabled` / `memberAccountIds` 永远不变，A-1/B-1 这类复现全部失真。
4. **键盘要真敲**：`input.value = x` 会同时更新 React 的 value-tracker，React 会认为"没变"而**不触发 onChange**；而 `Object.getPrototypeOf(input)` 的原型 setter 在本机也没能触发。可用 `react-dom/test-utils` 的 `Simulate.change(input)`：先按一次按键应有的结果写好 DOM 值，再让 React 派发 onChange——这样受控回写（A-4 的 clamp）才是真实观察到的行为。

浏览器侧 `fetch` 垫片：把 `/__save`、`/usage`、`/pool` 转发到真实路由（`routes.find(...)` 后直接调用 handler；`__save` 的 handler 用 `req.on('data'/'end')`，所以 fake req 要用 `node:stream` 的 `Readable`），其余 URL 当上游用桩。

复现入口（重建后可用）：

```
cd /tmp/dverify
node --experimental-strip-types --import ./loader-register.mjs t1_unlock.mjs      # A-2 / C3-1 / L-1
node --experimental-strip-types --import ./loader-register.mjs t2_memberloss.mjs  # A-1 / L-3
node --experimental-strip-types --import ./loader-register.mjs t3_actions.mjs     # A-3 / B-1 / B-3 / B-4 / C1-1
node --experimental-strip-types --import ./loader-register.mjs t4_l4.mjs          # L-4
node --experimental-strip-types --import ./loader-register.mjs t7_ui.mjs          # A-5 / A-6 / C3-2 / C1-3
node --experimental-strip-types --import ./loader-register.mjs t11_final.mjs      # C2-2 / C2-3
node --experimental-strip-types --import ./loader-register.mjs t12_component.mjs  # A-7 / A-10 / A-11 / A-12 / C4-3 / C4-5 / C4-6
node --experimental-strip-types --import ./loader-register.mjs t13_misc.mjs       # C3-3 / B-5 / B-8 / A-8
node --experimental-strip-types --import ./loader-register.mjs t16b_l5.mjs        # L-5
node --experimental-strip-types --import ./loader-register.mjs t19_e5_sibling.mjs # E-5 抽验 / siblingBusy 双向门控
```

> 每个脚本都要以 `process.exit(0)` 结尾：插件自带 `setInterval` 心跳，不显式退出会让 Node 挂住。

