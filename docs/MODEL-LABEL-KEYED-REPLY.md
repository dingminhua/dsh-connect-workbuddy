# 回复上游：`conversation.input.model.label` 改成 `keyed`

> 针对上游关于「模型标签槽被三家连接器抢占、建议改 `keyed`」的答复。
> 复核基准：`@deepseek-ai/dsh-client-ui-model-selection@0.2.2-rc.1` 与
> `dsh-client-ui-slots / dsh-client-ui-renderer@0.2.2-rc.1` 的实机产物（`app.asar` 内），
> 以及源码 `head b830ec950f`。
> 结论：**方向认同、诊断复核无误，但最小改动不是一处，是两处；而且缺一条迁移路径。**

## 一、你的诊断我们逐条复核过，成立

三条都验了，不是附和：

| 你的结论 | 复核结果 |
| --- | --- |
| -100 / -101 / -102 阶梯本身合法，registry 无罪 | ✅ `register()` 只对**同优先级**抛错，不同优先级一律放行 |
| 掉在 `single` 投影里，`entriesOfSlot` 按格去重 | ✅ 逐字是 `const cell = kind === "keyed" ? entry.options.key : kind === "list" ? entry.options.id : (void 0)`，`single` 全落 `undefined` 一格，`seenCells` 去重后只剩首条 |
| 不是 `list` | ✅ `list` 要求 `options.id`，且每次调用渲染**全部**存活行，表达不了「一个 provider 一行」 |

再补一条你可能没注意的：**`chain` 同样不行**。它按 `select()` 选举唯一赢家，
语义与 `single` 相同，只是把「比优先级」换成「比 selector」。

所以 `keyed` 确实是三者里唯一成立的形态。

## 二、缺的第一块：`keyed` 强制要求 `options.key`

`SlotCore.register` 的 `keyed` 分支逐字是：

```js
case "keyed":
  if (options.key === undefined) throw new Error(`keyed slot "…" requires options.key`)
```

这不是可以绕过的细节，而是一条**硬约束**。问题是：**所有已发布的第三方贡献者注册的
都是无 key 条目**。

一个可验证的解释是：在 `single` 语义下 `key` 完全无意义（单元格恒为 `undefined`），
所以「照当时的契约写」自然写出无 key 的注册——`key` 是只有 `keyed` 才需要的字段，
而此前没有任何文档说过这个槽会变成 `keyed`。本族的三个插件（workbuddy / trae / qoder）
此前每个版本都是这个形状，而且每个都把注册包在**吞错 try/catch** 里（因为
`inject()` 可能延迟执行回调，延迟抛出的错误会被渲染器从 `queueMicrotask` 重新抛出，
调用处的 try/catch 够不着——trae 为这条付过 issue #74 的代价）。

**所以只改声明，全族会一起失效，而且不报错。** 症状是最难查的那一类：

- `register()` 抛 `keyed slot … requires options.key`；
- catch 只打一行 `console.error`，页面上什么都没有；
- 用户看到的是「标签突然没了」，从代码里看不出任何变化。

建议在改声明的同时留一条迁移路径，三选一：

1. **keyless 落一个保留 cell**（例如 `undefined` cell 由 keyless 条目占用），并打一次性
   deprecation 警告；
2. **一次性 warn 而非 throw**，给一个版本周期的过渡；
3. 至少在 `CHANGELOG` 里给出明确迁移指引，并接受一个窗口期内的第三方失效。

我倾向于 1 或 2：`keyed` 的收益是「多人共存」，而一条会让存量贡献者静默全灭的迁移
路径，正好与这个收益相反。

## 三、缺的第二块：调用点也必须改，且必须与声明**同一版**发布

渲染器的 `keyed` 分支是：

```js
if (spec.kind === "keyed") {
  const entry = host.entriesOfSlot(slotKey).find(e => e.options.key === opts?.entryKey)
  if (!entry) return entries.some(e => e.options.key === opts?.entryKey) ? deadCell() : <>{opts?.fallback ?? null}</>
  return guarded(entry, entryKeyOf(entry))
}
```

也就是说 keyed 派发依赖**两个独立事实**：声明是 `keyed`，**且**调用点传了
`{ entryKey: provider.id }`。

实机产物里，`@deepseek-ai/dsh-client-ui-model-selection@0.2.2-rc.1` 渲染这个槽
**只有一个**调用点（`trigger` / 菜单当前值 / 每行 option 三处都走它）：

```js
renderSlot("conversation.input.model.label",
  { provider, model, placement, selected },
  { fallback: model.badge === void 0 ? model.name : <badge> })
```

第三个参数只有 `fallback`，**没有 `entryKey`**。

后果：`opts.entryKey` 是 `undefined` → `.find()` 匹配不到任何「以 provider id 为 key」
的条目 → `entries.some()` 也是 false → **每一行都渲染 `opts.fallback`**。
插件的注册**成功**、inject 回调也跑了、无异常、无日志，只是组件再也不会被调用。

和上一节叠加就是最坏情况：**声明改了、调用点没改**时，连「注册失败」这行日志都不会
出现——比第二节那种失败更安静。

所以这两处必须**原子发布**。单独改任何一处都会让全族标签消失，而两次失败的观感完全
一样（标签没了），排查时无法区分。

## 四、你提的 single 冲突告警，建议顺带覆盖 keyed-requires-key

这条我们完全赞成——现在所有失败都是不出声的，告警是唯一能把它变成可诊断线索的东西。
建议告警同时覆盖两类：

1. `single` 槽上第二条同优先级注册（你提的那条），报出**两个 registrant 与两个 priority**；
2. `keyed` 槽上的无 key 注册，报出 registrant 并指向迁移说明。

第 2 条正是第二节那个陷阱的兜底：它把「标签没了，不知道为什么」变成一行能搜到的日志。

## 五、父槽位 `conversation.input.model` 的接管问题

你提到的这条我们复核也成立，而且它**独立于 label**：children 表绑在获胜的那个注册上，
后来者再声明同名子槽会撞 `is already declared`。所以「父座位被谁占住」决定了
「子槽由谁声明」，这与 label 是 `single` 还是 `keyed` 是两个问题——即使 label 改成
`keyed`，父槽位被别家占住时子槽仍然不会有。

这条需要单独修，我们这边先不指望它。

## 六、插件侧我们已经发版，不用等你们

既然「注册几条」取决于宿主的声明，我们把它做成了**运行时读、一个构建服务两条线**：

```ts
const kind = ctx.slots.spec('conversation.input.model.label')?.kind
const seats = kind === 'keyed'
  ? MY_PROVIDER_IDS.map(id => ({ name: SLOT, key: id, priority: MY_PRIORITY }))
  : [{ name: SLOT, priority: MY_PRIORITY }]
```

- 宿主声明 `keyed` → 每个 provider 一格；
- 其余情况（含读不到 `spec()`、抛错、不认识的 kind）→ 历史那条单格；
- `list` / `chain` → **一条都不注册**（它们要 `options.id` / `options.select`，单条兜底
  会被拒绝；一份注册不了的计划比没有计划更糟）。

已发版：`dsh-connect-workbuddy@5.21.0`、`dsh-connect-trae@4.16.0`、
`dsh-connect-qoder@1.22.0`。宿主改口那天三家不需要重新发版。

同时把这段失败的形状写进了各自的文档（`docs/MODEL-LABEL-SPEC.md` 的
「改声明不够：宿主还必须传 `entryKey`」一节），后来者照做时不会踩。

## 七、我们可以帮着验

如果有一版 preview 同时带上「声明 + `entryKey` + 迁移路径」，我们可以立刻跑：

- 三家插件同时启用，各自两个 / 两个 / 三个 provider id；
- 加上宿主自带的 `dsh-client-ui-deepseek-model-label-1017`；
- 验四点：①每行只由自己的插件画；②无贡献的 provider 落回宿主 fallback（名字 + badge）；
  ③三家的胶囊**同时**出现；④`--verbose` 下无冲突告警。

我们的自检口子在 `window.__dshWorkBuddyModelLabel__`（`slotKind` / `seats` / `verdict`），
一眼能看出「声明读成了什么、注册了几格、有没有落地」。

---

## English summary (for the upstream thread)

Thanks — we re-verified your diagnosis against the shipped `0.2.2-rc.1` artifacts and it
holds: the registry is innocent (the -100/-101/-102 ladder is legal), the drop happens in
the `single` projection (`entriesOfSlot` dedupes by cell, and every `single` entry's cell is
`undefined`), and `list` is not the fix (`list` requires `options.id` and renders *all*
surviving rows per call, so it cannot express "one provider's row"). `chain` is not the fix
either — it elects a single winner via `select()`, same semantics as `single`. `keyed` is
the right target.

**Two things are missing from the minimum change, and both fail silently.**

**(1) `keyed` requires `options.key`** — `register()` throws
`keyed slot "…" requires options.key` otherwise. Every shipped third-party contributor
registers a *keyless* entry — which is the natural thing to write under `single`
semantics, where `key` is meaningless because the cell is always `undefined`.
Combined with the fact that every member
of this family wraps its registration in a swallowing try/catch (a deferred `inject()`
callback throw is re-raised from a `queueMicrotask`, unreachable from a call-site catch),
a declaration-only flip throws for all of them and shows up as "the labels just vanished".
Please ship a migration path — a reserved cell for keyless entries, or a transitional warn
instead of a throw.

**(2) The call site must pass `entryKey`, in the same release.** The `keyed` branch is
`find(e => e.options.key === opts?.entryKey)`. In `0.2.2-rc.1` the slot has exactly ONE
render call site and its third argument carries only `fallback` — no `entryKey`. With
`opts.entryKey` undefined, no provider-keyed entry matches and *every* row renders the
fallback: registration succeeds, the inject callback runs, nothing throws, nothing logs.
Declaring `keyed` without that second change is even quieter than (1). The two must land
atomically.

Your proposed clash warning is right, and we suggest it also cover the keyless-on-keyed
case — that is what turns this from "no labels, no idea why" into one searchable log line.
The parent-seat takeover issue (`conversation.input.model` children tied to the winning
registration, `already declared` for later ones) is real and independent of the label kind.

We have already shipped the plugin side so you do not have to wait for us: all three
connectors read `ctx.slots.spec(key)?.kind` at mount and register per-provider-id seats on
`keyed`, falling back to the historical single seat otherwise — one build serves both host
lines. (`dsh-connect-workbuddy@5.21.0`, `dsh-connect-trae@4.16.0`,
`dsh-connect-qoder@1.22.0`.) Happy to run a preview build against the four-point check
listed above.
