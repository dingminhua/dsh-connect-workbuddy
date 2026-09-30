# 审计 Lead：跨层复核（Lead 独立发现）

> 本文件记录 Team Lead 在组队审计期间**独立**发现的问题，与 A/B/C/D 四份报告互为补充。
> 所有结论均附可执行证据。范围：跨「草稿态 → 保存 → Host 运行时」的语义断层。

## L-1（高）「关闭自动轮换」按钮会立刻解锁手动下拉，但 Host 仍在轮换 —— 用户的账号选择静默无效

**这是设计上最忌讳的「显示 A、实际计费 B」缺陷，经草稿/保存边界重新引入。**

### 证据链

1. 组件的锁定判定读的是**草稿优先**的值：
   - `src/client/AccountPool.tsx:209` — `const active = draftRegion === region && draft !== null ? draft : saved`
   - `src/client/AccountPool.tsx:222` — `const rotationLocked = active.enabled && active.rotateByCredits`
2. 「关闭自动轮换」按钮只改草稿、不保存：
   - `src/client/AccountPool.tsx:507` — `onUnlock: () => { editDraft(current => ({ ...current, rotateByCredits: false })) }`
3. 但 Host 侧轮换判定读的是**已保存的配置**：
   - `src/index.ts:955-958` — `applyRotation()` 里 `poolPreferencesOf(current(), region)`，`current()` 返回的是已提交 config
4. 运行时的计费账号优先取轮换覆盖：
   - `src/auth.ts` `current()` 先看 `rotatedAccountId`，命中即返回

### 复现（Lead 实测输出）

```
1. 初始（已保存 rotate=on）        下拉禁用 = true  | Host 在轮换 = true
2. 点「关闭自动轮换」（未保存）      下拉禁用 = false | 冲突提示消失 | Host 仍在轮换 = true
3. 此时手动选账号                  写 config.accounts=A，但 rotatedAccountId 仍=B → B 继续计费
4. 保存后                          下拉禁用 = false | Host 轮换停止 → 这时才一致
```

### 后果

第 2~3 步之间存在一个窗口：界面**已经**允许手动选账号，**已经**撤掉了冲突提示，但 Host 的轮换覆盖仍然生效。用户选完账号后界面显示该账号为当前，实际计费的却是轮换选中的另一个账号——**而且没有任何提示**。保存之后窗口关闭，但用户此前的那次选择已被静默忽略。

### 根因

互斥规则的状态源不一致：**UI 用草稿判定，运行时用已保存配置判定**。两者在「有未保存改动」时必然背离。

### 修复方向（供决策，未实施）

三个方向，各有取舍：

1. **锁定时按已保存值判定**：`rotationLocked` 改读 `saved.enabled && saved.rotateByCredits`。改动最小，且与 Host 语义一致；代价是点了「关闭自动轮换」后下拉要等保存才解锁——但这**恰恰是诚实的**，因为 Host 确实还在轮换。
2. **让「关闭自动轮换」立即写入**：该按钮绕过草稿直接保存。与其它偏好「草稿+保存」不一致，但消除了窗口。
3. **保存前把手动选择也挡住并解释**：保留草稿判定，但在未保存时给出「保存后生效」的明确提示。

Lead 倾向 **方向 1**：它让「界面允许的操作」与「Host 会执行的操作」始终一致，而这正是本项目反复强调的原则（`src/auth.ts` 与卡片注释里都写着绝不让界面与实际计费不一致）。方向 2 会让一个按钮绕过用户预期的保存流程，方向 3 只是提示、窗口依然存在。

## L-2（中）同一类断层的通用模式

L-1 不是孤例，而是一类问题的实例：**任何「草稿优先」的 UI 判定，与「已保存配置」驱动的运行时行为，在有未保存改动时都会背离。** 已核查的其它同类点：

- `siblingBusy` 串行：判定用 `saving` 状态（真实在途），**不涉及草稿**，因此无此问题。已排除。
- 池开关 `active.enabled` 控制两个批量按钮的禁用：按钮禁用用草稿，而 Host 路由用已保存配置判定 `enabled`。后果与 L-1 同类但**方向相反且更安全**：用户在草稿里关掉池后按钮即禁用（保守），Host 侧仍接受请求但卡片不会发。若在草稿里**打开**池而尚未保存，按钮变为可用，但 Host 会返回 409「pool is disabled」——用户看到的是明确错误而非静默错误。属**低severity**，因为失败是可见的。

## 待验证（Lead 未能确认）

- 手动下拉在锁定窗口内选账号后，`writeAccountSlot` 的成功回执是否会让卡片把该账号显示为「当前」。这取决于 Host `currentAccountId` 的实现（读 `store.current()`，会被轮换覆盖），因此**预期**显示为轮换账号而非用户所选——但未在真实浏览器中验证渲染结果。

## L-3（高）`editDraft` 的依赖数组漏了 `saved.memberAccountIds`，勾选账号会静默丢失其它成员

### 证据

- `src/client/AccountPool.tsx:268-271` — `editDraft` 的 `useCallback` 依赖数组为
  `[draftRegion, region, saved.autoTestIntervalMinutes, saved.enabled, saved.rotateByCredits, saved.targetModelId]`
- 函数体第 270 行用整个 `saved` 作为草稿基准：`edit(previous !== null && draftRegion === region ? previous : saved)`
- **`saved.memberAccountIds` 不在依赖里**，而它是在加入成员勾选功能时新增到 `saved` 上的字段（第 205 行构造 `saved` 时含该字段）。

### 为什么是缺陷

`useCallback` 只在依赖变化时重建闭包。当 `memberAccountIds` 变了、而六个依赖字段都没变时，闭包**仍捕获上一轮的 `saved`**。此时用户勾选一个账号，草稿基准是**过期的成员列表**，保存时会把其间新增的成员**静默丢弃**。

### 复现（Lead 实测，模拟 React 的记忆化行为）

```
saved1.memberAccountIds = ["a"]
Host 上报 saved2.memberAccountIds = ["a","b"]   （六个依赖字段均未变 → 复用旧闭包）
用户勾选 "c"  → 草稿基准用的是 saved1
结果: ["a","c"]      期望: ["a","b","c"]
静默丢失: ["b"]
```

### 触发条件（经审计 C 修正 —— 比 Lead 原先判断的更容易命中）

Lead 最初写的是「需要另一个标签页」。**审计 C 证明不需要**，日常操作即可稳定命中：

1. 保存一次勾选变更 → `save()` 内部**先** `discard()`（`AccountPool.tsx:289`），使 `draftRegion` 变回 `undefined`；
2. 这次重渲染让 `editDraft` 重建并捕获**此刻仍旧的** `saved`；
3. 随后 `onSaved` 触发的重读落地，`saved.memberAccountIds` 变成新列表，但**六个依赖字段全同** → 闭包保持过期基准；
4. 用户再勾一个账号 → 以旧列表为基准 → 刚保存的成员从草稿消失 → 再保存即**静默移出池**。

即「保存勾选 → 再勾一个」两步即可，无需任何外部并发。审计 C 已用纯逻辑复现（脚本已删）。唯一待验证点是该序列依赖「`discard` 重渲染先于重读落地」的时序，属网络往返必然。

（审计 A 独立得出同一结论，编号 A-1；两份报告互为佐证。）

### 根因

依赖数组手工列举标量字段，而函数体依赖的是整个 `saved` 对象。**列举与使用不一致**——`memberAccountIds` 后加时就漏了。正确的做法是依赖整个 `saved`（React 的比较按引用，`saved` 每次渲染新建会重建闭包，但这是正确性优先于微优化的场合），或把基准值的构造移进 `setDraft` 的更新函数里。

### 与 L-1 的关系

两者根因相同：**手工维护的依赖/判定清单与实际使用的状态不同步**。建议修复时一并处理，并考虑用 lint 规则（react-hooks/exhaustive-deps）防回归。

## L-4（高）我自己的串行化修复不完整：`regions` 槽有**第三个写入者**绕过了 `siblingBusy`

### 背景

上一轮我发现模型保存与池保存共写 `regions[region]` 槽，而 Host 的 `__save` 是**按区域**合并（`{ ...current, ...incoming }`，见 `src/web-status.ts:840-843`），因此两个并发保存会互相回退。我当时的修复是让两个保存按钮互相串行（`siblingBusy` / `onBusyChange`）。

**那个修复漏了一个写入者。**

### 证据

同一个槽有三个写入方，但只有两个受串行约束：

| 写入者 | 位置 | 是否受 `saving`/`poolBusy` 约束 |
| --- | --- | --- |
| 模型保存 | `WorkBuddyCard.tsx:1218` | ✅ `disabled={!dirty \|\| saving \|\| poolBusy ...}` |
| 池保存 | `AccountPool.tsx:737` | ✅ `disabled: !dirty \|\| saving \|\| siblingBusy` |
| **tab 供应商开关** | `WorkBuddyCard.tsx:856` | ❌ 只有 `disabled={togglingRegion === region \|\| !canWrite}` |

`toggleRegion`（`WorkBuddyCard.tsx:498-516`）经 `writeRegionEnabled` 写**整个区域槽**（注释明写 "carries the region's whole slot through"），其合并基准取自 `settingsScope.getSnapshot().value` —— 一个可能落后于在途写入的快照。

### 复现（Lead 实测，模拟 Host 的按区域合并）

```
初始           cn.pool.memberAccountIds = ['a']
池保存（快照含 ['a'] → 写 ['a','b']）   → Host: ['a','b']
tab 开关（快照仍是 ['a'] → 写自己的槽） → Host: ['a']      <-- ['b'] 被回退
静默丢失: ['b']
```

### 后果

用户勾选成员并保存后，若紧接着切换区域开关（或反之），**后落地的那个写入会带着过期快照覆盖前者**，界面两边都显示成功。这正是 L-1/L-3 的同一类缺陷：**过期基准 + 静默覆盖**。

### 修复方向

把串行门控扩展到第三个写入者：`toggleRegion` 期间禁用两个保存按钮，两个保存期间禁用 tab 开关（即让 `saving` / `poolBusy` / `togglingRegion` 三者互斥）。**更根本的做法**是在 Host 的 `__save` 做**按字段**合并而非按区域替换，那样三个写入者天然安全——但那是 Host 契约变更，影响面更大，需单独评估。

## L-5（中）两次 `refreshUsage` 无请求序护栏

`WorkBuddyCard.tsx:764`（模型保存后）与 `:1241`（池保存后经 `onSaved`）都直接 `setStatusByRegion`（`:357-378`），没有请求序号或 abort 护栏。两个刷新并发时，**先发出的响应可能后到达并覆盖更新的快照**。窗口是一次 loopback 往返。与 L-4 相关但独立：即使写入串行了，读取仍可能乱序。审计 A 的 V-2/V-3 也独立提出同一点。
