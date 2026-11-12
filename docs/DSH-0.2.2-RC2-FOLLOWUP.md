# DSH 0.2.2-rc.2 升级复核

> 调研日期：2026-11-13
> 宿主实测版本：`0.2.2-rc.2`（本机 `DeepSeek Harness.app`；随包 `@deepseek-ai/dsh*` 全部
> `0.2.2-rc.2`，vendor 为 `cordis 4.1.0`、`schemastery 3.19.0`、`cordis-plugin-loader 1.1.0`、
> `@earendil-works/pi-ai 1.3.0`；GUI `http://127.0.0.1:49298`）
> 上一份复核：[`DSH-0.2.2-RC1-FOLLOWUP.md`](DSH-0.2.2-RC1-FOLLOWUP.md)（rc.1）
> 结论：**rc.1 引出的三项待办在本版一并结清，本轮无新增宿主破坏面。**

rc.1 那份的结论是「无需改动」，留了三件事在案上：① `sessionProjections.stateOf` 已弃用；
② 升 devDeps 到 0.2.2 线时 `profileFor` 会因两个新必填字段编译失败；③ `LlmModelInfo.badge` 是可选增强。
本版（**5.23.0**）把 ① 和 ② 做掉，并顺带处理了 rc.1 那份**漏记**的一条 —— 同一个 badge 类型还藏着
第二处编译失败（§4.1）。此外本轮发现一件 rc.1 时无法看见的事：宿主随包的 pi-ai 是 **1.3.0**，
而它已经改变了「异模型思考块」的处置方式，使本仓库 5 条前提测试在真实组合上失效（§4.3）。

## 一、结论速览

| 面 | 状态 | 依据 |
|---|---|---|
| peer 版本范围 | ✅ 无需改 | 闸门两函数与 rc.1 逐字节相同；实算 `0.2.2-rc.2` ADMITTED、`0.3.0-rc.1` BLOCKED（§3.1） |
| 8 个槽位 | ✅ 无需改 | kind / 注册字段 / owner props 未变；运行中的宿主上本插件 6 处在位（§3.2） |
| 16 条 Web 路由 | ✅ 无需改 | 契约未变；本机 200 / 200 / 405 符合预期（§3.3） |
| LLM 适配器面 | ✅ 无需改 | `registerAdapter` / `registerModelDiscovery` 未变；`LlmError` 形态变化不影响本插件（§3.4） |
| pi-ai 适配 | ⚠️ 行为代际改变 | 宿主自 rc.1 起即依赖 `^1.3.0`；1.3 起**丢弃**异模型思考块而非改写为正文（§4.3） |
| settings | ✅ 无需改 | `configure(presentation, owner)` 类型未变；`ctx.fiber` 仍是正确入参 |
| sessionProjections | ✅ 本版已迁移 | `stateOf` → `snapshot(session, keys)`，并保留旧宿主回退（§4.2） |
| 主题 token | ✅ 无需改 | 414 → 450 项，**零删除**；本插件缺定义的 8 个 token 与 rc.1 完全一致（§3.6） |
| 客户端模块 | ✅ 无需改 | 4 个 `dsh.client.inject` 模块照旧；`SlotKind` 新增 `hoc` 不落在本插件用到的四种里（§3.2） |
| **本仓库套件** | ✅ 全绿 | 205 文件 / 3494 条通过（2 条按平台跳过）；`tsc` 两个项目 0 error（§5） |

一句话：**rc.2 没有新增任何需要本插件适应的宿主变更；这一版做的是把 rc.1 留下的技术债结清，
并让测试与「用户实际拿到的 pi-ai」对齐。**

## 二、0.2.2-rc.2 到底改了什么

随包 `docs/upgrade-guide/README.md` 里**最新的一节是 `## v0.2.2-rc.1`**（19 条），没有
`v0.2.2-rc.2` 一节。也就是说 rc.2 没有自己的破坏性清单，这 19 条构成 rc.1 → rc.2 的全部官方变更面。
逐条对照后，**只有两条与本插件沾边，且都不需要改代码**：

| 指南 | 内容 | 与本插件的关系 |
|---|---|---|
| `runtime-context-reminders` | 运行时上下文被包进 `<system-reminder>` | 本插件 `INJECTED_BUILT_IN_PREFIXES` 本来就含 `<system-reminder>` 形状，`keepPromptLast` 分类不变（§3.5） |
| `window-drag-regions` | macOS 自动排除拖动行与行内控件 | 本插件三个 fixed 浮层都不在拖动行内，属「新规则下无需声明」；**只能在 macOS 上人工点一次才算数**（§3.7） |

其余 17 条（账号通知/Remote、worktree 归档、附件错误码、CUA 六条、`dsh-doc` skill、Forge 三条、
`BundleInfo.update`、`Session.append` 重载、subagent interrupt、terminal 两条、web-search 计费）
逐条核对后本插件**一处都不碰**：无 `deepseekAccount`、无 `ctx.forge`、无 `listBundles`、
无 `Session.append` 替身、无 `TerminalError`、无 web search。

### 2.1 逐包比对（只比本插件真正 import 的）

| 包 | rc.1 → rc.2 的 `lib/` 变化 | 结论 |
|---|---|---|
| `dsh-llm` | `HarnessError` 迁至 `@deepseek-ai/dsh-error` 并再导出；`LlmError` 构造只接受内置 code，新增静态 `LlmError.fromFailure`；`LLM_FAILURE_CODES` / `RETRY_CODE_CHOICES`；retry schema 加 `min(Number.MIN_VALUE)`；`attribution` 增可选 `suffix` | 本插件不构造 `LlmError`，只按 `record.code === 'channel_reject'` 分支 → 无影响 |
| `dsh-llm-pi-ai` | 新增 Anthropic `prefix-binding`（`PrefixDigests` / `bindThinkingToPrefix` / 可选 `onThinkingOmitted`）；Gemini discovery；默认值 `maxRequestImages: 50`、`imageOffloadCountQuantum: min(10, maxRequestImages)` | 全部是加法；`conversationUpdates()` 与 rc.1 **逐字节相同**（`supportsReasoningEffort` / CN-only `supportsMidConvoSystemMessages` 两条 compat 判据未变） |
| `dsh-host-webserver` | **`lib/` 零变化**（只多 `.map` 与 `src/`） | — |
| `dsh-settings` | **`lib/` 零变化** | — |
| `dsh-session-projection` | 仅 JSDoc：`stateOf` / `cachedSnapshot` 的 `@deprecated` 措辞加重；`stateVersion` 说明放宽 | 本版已按推荐读面迁移（§4.2） |
| `dsh-attachment` | `AttachmentError` 改继承 `HarnessError` | 本插件只 `import type { AttachmentStore }` → 无影响 |
| `dsh-client-ui-slots` | 新增 `SlotKind = 'single' \| 'list' \| 'keyed' \| 'chain' \| 'hoc'`；hoc 注册要求 `options.id`；崩溃接管扩到 `single`/`keyed`/`list` | 本插件 `declaredSlotKind()` 只认旧的四种，未知 kind 归 `undefined` → 单席兜底（保守，可接受） |
| `dsh-client-ui-settings` | `SettingsLauncherOwnerProps.openSettings: (sectionId?: string) => void` | 本插件不调用 `openSettings` |
| 主题 token | 414 → 450，**零删除** | 本插件用到的 token 全部仍在（§3.6） |

## 三、逐面核对（本机实测）

### 3.1 兼容闸门：0.2.2-rc.2 放行，0.3.0-rc.1 仍被挡

`dsh-app-boot` 的 `satisfies()` 与 `unmetRequirements()` 在 rc.1 → rc.2 之间**逐字节相同**
（仍是 `semver.satisfies(rt, range, { includePrerelease: true })`）。用本仓库 `package.json` 实算：

```
0.2.2-rc.1   ADMITTED
0.2.2-rc.2   ADMITTED
0.2.2        ADMITTED
0.3.0-rc.1   BLOCKED（10 条 dsh-* peer 全部不满足 <0.3.0-0）
```

非 `dsh*` 的四个 peer 也逐个实算过（闸门不管它们，但插件自己声明了范围）：

```
@deepseek-ai/cordis       4.1.0   OK  (>=4.0.1-rc.1 <5.0.0 || >=4.0.2 <5.0.0)
@deepseek-ai/schemastery  3.19.0  OK  (>=3.18.1-rc.1 <4.0.0 || >=3.18.2 <4.0.0)
@earendil-works/pi-ai     1.3.0   OK  (>=0.85.0 <0.88.0 || >=1.0.0-0 <2.0.0)
react                     18.3.1  OK  (^18.2.0)
```

### 3.2 槽位账本

在运行中的 0.2.2-rc.2 GUI 上读槽位账本（Cordis Inspect `Slots.listSubTree`）：

| 槽位 | kind | 本机占用者（本插件部分） |
|---|---|---|
| `conversation.input.right` | list | `dsh-connect-workbuddy-composer-credits` order 4，`active: true` |
| `conversation.input.model.label` | **single** | 本插件 `priority -105`，`active: true`（对端宿主仍声明 `single`） |
| `conversation.composer.dock` | list | stats-credits order 10、cli-live order 11，均 active |
| `shell.quota-notice` | chain | 宿主一条 + 本插件一条，均 active |
| `plugins.bundle.config` | keyed | `dsh-connect-workbuddy`、`include:dsh-connect-workbuddy` 两个 key |
| `plugins.row.config` | keyed | 同上两个 key |

`sidebar.panellist` / `main` 因 `sidebarPanelEnabled: false` 未注册，与设计一致。
rc.2 新增的 `hoc` 槽种没有被任何本插件用到的槽采用，`declaredSlotKind()` 的兜底路径不需要改。

### 3.3 Web 路由探针

| 路由 | 结果 |
|---|---|
| `GET /plugins/dsh-connect-workbuddy/usage?region=cn` | `200`，`status: signed-in`，带 `contextBudgets` |
| `GET /plugins/dsh-connect-workbuddy/account-credits?region=cn` | `200`，返回账号列表 |
| `GET /plugins/dsh-connect-workbuddy/pool?region=cn` | `405`（该方法门本就只接受 POST，属预期） |

### 3.4 LLM 适配器面

`registerAdapter` / `registerModelDiscovery` / `registerConfigurableProviders` 的 `.d.ts` 与 rc.1
逐字节相同。`LlmError` 的形态变化（构造只接受内置 code、新增 `fromFailure`）本插件不参与：它从不
构造 `LlmError`，判定上游失败只读 `record.code === 'channel_reject'`。

### 3.5 运行时上下文包裹

rc.2 把运行时上下文包进 `<system-reminder>`。本插件 `src/upstream.ts` 的
`INJECTED_BUILT_IN_PREFIXES` 本就以 `<system-reminder>` 为内置候选之一，因此 `keepPromptLast`
把它归为「注入内容」的判断不变，无需改。

### 3.6 主题 token

定义集 414 → 450 项，**零删除**。本插件用到而宿主未定义的 8 个 token 与 rc.1 完全相同（都有
fallback），本轮没有新缺口。

### 3.7 窗口拖动分区（`window-drag-regions`）

macOS 起自动排除 `data-window-drag` 行与其 `data-window-drag-controls` 内的控件。本插件有三处
fixed 浮层（`.dsm-workbuddy-veil`、`.dsm-workbuddy-device-backdrop`、composer 的 portal 面板），
按代码判断都不在拖动行内，属「新规则下不必声明」。⚠️ 这一条**只能靠人在 macOS 上点一次**确认，
测试无法覆盖；本轮未做人工点击验收，留作发布后观察项。

## 四、本版实际改动

### 4.1 两处类型（升 devDeps 到 0.2.2 线的前置）

把 devDeps / overrides 指向 `0.2.2-rc.2` 后，两个 tsc 项目各报一条：

```
src/adapter.ts TS2322  badge.text: string | Record<string,string> 不可赋给 LocalizedText
src/adapter.ts TS2739  profileFor 缺 maxRequestImages / imageOffloadCountQuantum
```

第二条是 rc.1 文档 §5.2 已预告的；**第一条是那份漏记的**。两处都在 rc.1 上就已存在，只是当时
devDeps 钉在 0.1.7、类型里没有这些声明，所以看不见。

- **`LlmModelBadge.text`**：从 `string | Record<string, string>` 收窄成
  `string | ({ en: string } & Record<string, string>)`。宿主 `LocalizedText` 要求 `en` 必填，
  而这不是迁就编译器——`en` 缺失时宿主的 resolver 返回 `undefined`，徽章直接不显示，**这本来就是
  本插件依赖的不变量**，只是原来的写法无法表达它。
- **`REQUEST_IMAGE_BUDGETS`**：补 `maxRequestImages` / `imageOffloadCountQuantum`。**值刻意取
  `1_000_000` 而不是照抄宿主的 50**：本插件的路由从来没有张数上限（`toPiContextWithImages`
  对 `undefined` 是「跳过」），填 50 等于借一次依赖升级**悄悄收紧**行为，症状会是图片多的会话
  突然 `IMAGE_OFFLOAD_REQUIRED`。两个值在常量旁写明了这条理由，以及「若将来测到网关真实上限，
  该数字放 `maxRequestImages`」的指引。

两处都做了变异验证：分别改回原样 → 各自复现同一条 tsc 错误；改回修复 → 0 error。

### 4.2 `stateOf` → `snapshot`（rc.1 文档 §5.1 的待办）

CLI 桥的目录源改走 `readProjectedState()`：

```ts
if (typeof reader.snapshot === 'function') return reader.snapshot(session, [key])?.values?.[key]
return reader.stateOf?.(session, key)
```

三件事值得记下来：

1. **优先新读面、保留旧回退**。`stateOf` 仍正确，只是每 key 每进程打一条弃用告警；但把「宿主可能
   比弃用更旧」这件事硬编码掉，会让旧宿主上 `cliDirectoryOf` 静默变 `undefined`，而阶梯随后回落到
   **会话 header** —— 也就是 `/cd` 之前那个陈旧目录，正是这套机制存在的理由。所以旧读面留着。
2. **抽成纯函数是为了可测**。原来内联在 `ctx.inject` 闭包里，「到底调了哪个读面」只能靠读代码。
   现在 `readProjectedState` 是导出的纯函数，三条用例分别钉住：优先 `snapshot` 且**完全不碰**
   `stateOf`、无 `snapshot` 时回退、两个读面对「没记录」都答 `undefined`。
3. **变异验证**：把优先级调反 → 「优先 snapshot」那条立刻红。

**没有**改用 `ctx.workingDirectory.get(session)`：那个服务在「没有提交过目录」时回落到**宿主进程的
cwd**，会把「不知道」变成「用这个」，是本插件注释里明确要避免的。

### 4.3 pi-ai 1.3.0：异模型思考的处置方式变了（本轮新发现）

宿主 `dsh-llm-pi-ai` 从 **rc.1 起**就依赖 `@earendil-works/pi-ai ^1.3.0`（rc.1 与 rc.2 相同），
而市场安装没有本地副本，**真用户跑的就是 1.3.0**。1.3 的 `transform-messages` 把异模型思考块

```js
// 1.3.0
if (!isSameModel) return []          // 直接丢弃
```

而不是像 ≤1.2 那样改写成正文：

```js
// 1.1.0 / 0.85.1
if (isSameModel) return block
return { type: "text", text: block.thinking }   // 摊平成可见正文
```

这正是本插件的 `dropForeignThinking` / `crossProviderThinkingOf` 在修的那个缺陷（issue #147/#163）。
1.3 把它在上游修掉之后：

- **修复本身仍然是幂等无害的**，但它在这条栈上已经变成 no-op；
- **5 条「前提测试」变成假的** —— 它们断言「pi-ai 会把异模型思考摊平成正文」，
  在 1.3.0 上这个前提不存在，测试失败（`expected [['text']]` / `['text','text']`，实得 `[[]]` / `['text']`）。

处置方式**不是**把测试改宽，也不是给修复加版本开关：

1. 新增 [`tests/foreign-thinking-helpers.ts`](../tests/foreign-thinking-helpers.ts)，**用真实 transform
   实测一次**「这块思考最终成了正文还是消失了」，而不是比较版本号。理由写在文件头：版本号是库内部
   规则的第二个副本，第一次 1.x 改主意而不改大版本时它就会错——而这正是本文件的由来。
2. 5 条前提测试改成按实测结果断言：≤1.2 断言摊平、≥1.3 断言消失。**被检验的腿没有变松**：
   `isSameModel` 的三条腿（provider / api / model）仍是每条用例真正在证明的东西。
3. **修复保持无条件运行**，并在 `adapter.ts` 写明为什么不加代际开关：pi-ai 是**按进程**解析的，
   嵌套副本会遮蔽宿主的（issue #24 实证），所以本插件不能假设用户手上是哪一代。「别的模型的思考
   永远不进这次请求」是本 bundle 自己的保证，比推断「装的是哪份库」便宜。
4. 注释按代际修正（`adapter.ts` 的 `ForeignThinkingBlock` / `foreignThinkingOf` / `allThinkingOf`
   与 `WORKBUDDY_MODEL_IDENTITY` 说明、`index.ts` 的 Config 文档、`body-report.ts` 的归因段落），
   并把已漂移的行号引用（`:68` / `:87–90` / `:88–96`）改成符号名 —— 这些行号在 1.3.0 里已经全部变了。

变异验证：把实测判定反过来 → 恰好这 5 条红，其余 36 条绿。

### 4.4 CI 矩阵

`test-pi-ai-next` 从单腿 `['1.1.0']` 扩到 `['1.1.0', '1.3.0']`：

- `1.1.0` 是 `flattened` 那一代，**修复自己**的回归保护靠它；
- `1.3.0` 是宿主随包的那一代（`dropped`），也是 `pnpm-workspace.yaml` 现在的 pin。

两条本地都实跑过（各 205 文件 / 3494 条通过），并保留旧线（`0.1.7-rc.1` + pi-ai `0.85.1`）的
兼容性实测 —— 那套也全绿，说明本版改动没有破坏上一代组合。

### 4.5 依赖栈

| 项 | 旧 | 新 |
|---|---|---|
| `dsh-*`（overrides + devDeps 线） | `0.1.7-rc.1` | `0.2.2-rc.2` |
| `@deepseek-ai/cordis` | `4.0.2` | `4.1.0` |
| `@deepseek-ai/schemastery` | `3.18.4` | `3.19.0` |
| `@earendil-works/pi-ai` | `0.85.1` | `1.3.0` |

**pi-ai 必须跟着走，这不是可选项**：`dsh-llm-pi-ai@0.2.2-rc.2` 声明 `^1.3.0`，而
`@earendil-works/pi-ai/providers/all` 在 0.85.1 里没有 `getAllBuiltinModels` —— 一旦把 dsh 包升到
rc.2 而 pi-ai 留在 0.85.1，加载期直接 `SyntaxError`，**是启动失败，不是类型错误**（本轮已实测复现）。

`schemastery` 3.19.0 与 3.18.4 的 `lib/` **逐字节相同**（npm pack 比对），所以这一跳只让「开发装的」
与「宿主自带的」不再差一个版本号；`volatile()` 在两者中都存在，v4.7 那条「配置区整个消失」的教训不受影响。

## 五、测试与验收

### 5.1 三套组合

| 组合 | typecheck | 套件 |
|---|---|---|
| `0.2.2-rc.2` + pi-ai `1.3.0`（**宿主真实组合**） | 0 error | 205 文件 / 3494 通过 / 2 跳过 |
| `0.2.2-rc.2` + pi-ai `1.1.0`（CI 另一条腿） | 0 error | 205 文件 / 3494 通过 / 2 跳过 |
| `0.1.7-rc.1` + pi-ai `0.85.1`（上一代，兼容性实测） | 0 error | 205 文件 / 3494 通过 / 2 跳过 |

`pnpm run build` 通过，6 项声明产物齐全。
`node scripts/check-pii.mjs`：扫描 437 文件（其中 29 个随包发布），**clean**。

### 5.2 本机 `doctor`

```
WorkBuddy Connect 5.23.0
pi-ai runtime: modern 1.3.0 (…/@earendil-works+pi-ai@1.3.0/…/dist/index.js) — passes provider contexts through unchanged
Host bundle: running (pid 14953)
```

这一行与 rc.1 那轮**不同**：那时本机是 `legacy 0.85.1`（开发链接的本地副本遮蔽宿主那份），现在依赖栈
已升到 1.3.0，`piAiRuntimeInfo()` 判 `modern`，与本插件在真实市场安装下看到的代际**一致**。这本身
就是本轮的一个收获：开发机不再跑在一条用户不会遇到的代际上。

### 5.3 变异验证清单

| 改动 | 变异 | 结果 |
|---|---|---|
| `LlmModelBadge.text` 收窄 | 改回 `string \| Record<string,string>` | 复现 TS2322，红 |
| `REQUEST_IMAGE_BUDGETS` 两字段 | 删掉两个字段 | 复现 TS2739，红 |
| `readProjectedState` 优先级 | 调反成优先 `stateOf` | 「优先 snapshot」用例红 |
| `foreignThinkingAsProse()` 判定 | 把 `flattened`/`dropped` 互换 | 恰好 5 条前提测试红，其余 36 绿 |

## 六、结论与后续

1. **rc.2 没有新增需要适配的宿主破坏面**；本版的可交付内容是「结清 rc.1 的三项待办 + 让测试与
   用户实际拿到的 pi-ai 对齐」。
2. **版本号取 minor（5.23.0）**：依赖栈换代、新增一条 CI 腿、修掉 5 条在真实组合上失效的测试，
   但不改任何用户可见行为（`maxRequestImages` 刻意保持「无实际上限」）。
3. **本轮唯一的人工观察项**：macOS 上 `window-drag-regions` —— 确认三处浮层（付款面纱、设备弹窗、
   composer 面板）在拖动窗口时不被当成拖动把手。代码判断不需要改，但这只能靠手点。
4. **下一道围栏仍是 `0.3.0-0`**。0.2.2-rc.2 在声明范围内，`0.3.0-rc.1` 被明确挡住，实算已复验。
5. **复核路径不变**：下次宿主升级仍按 `RELEASING.md` §2.6 走 —— 先跑闸门实算，再跑槽位账本与
   路由探针，最后按 §2.1 逐包比对确认直接依赖有没有动。本轮新增一条：**核对 pi-ai 代际行为是否又变了**
   （`tests/foreign-thinking-helpers.ts` 会在 CI 上替你回答，但看它一眼比读失败日志快）。
