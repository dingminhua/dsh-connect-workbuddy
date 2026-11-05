# DSH 0.2.2-rc.1 升级复核

> 调研日期：2026-11-05
> 宿主实测版本：`0.2.2-rc.1`（`DeepSeek Harness.app` 的 `CFBundleShortVersionString` 与
> `CFBundleVersion` 一致；`Contents/Resources/runtime/versions.json` 为 node 24.21.0 / pnpm 11.28.5；
> GUI `http://127.0.0.1:56825`）
> 上一份复核：[`DSH-0.2.1-RC5-FOLLOWUP.md`](DSH-0.2.1-RC5-FOLLOWUP.md)（rc.5）
> 结论：**无需改动。** 本版不改代码即可在 0.2.2-rc.1 上运行，本机实测全部健康。宿主没有触碰本插件的任何一处
> 硬契约（兼容闸门、8 个槽位的 kind/注册字段/owner props、16 条 `webServer` 路由、`ctx.llm` 的
> 注册面、`ctx.settings`、`ctx.sessionProjections`、locale、主题 token）。有三件事需要记在案上：
> ① `sessionProjections.stateOf(session, key)` 在 0.2.2 起**已弃用**（仍返回值，只多一条一次性告警）；
> ② `ResolvedPiAiProviderProfile` 新增两个**必填**字段（运行时容忍缺省，只有把 devDeps 升到
> 0.2.2 时才会在类型层报错）；③ 宿主新增的 `LlmModelInfo.badge` 与 `llm/models-updated` 是**可选的**
> 增强面，不是待办。

## 一、结论速览

| 面 | 状态 | 依据 |
|---|---|---|
| peer 版本范围 | ✅ 无需改 | 闸门实现与 rc.5 逐字节相同，实算 `0.2.2-rc.1` ADMITTED、`0.3.0-rc.1` BLOCKED（§3.1） |
| 8 个槽位 | ✅ 无需改 | kind / 注册字段 / owner props 未变；运行中的宿主上本插件 **6 处在位**（`sidebar.panellist` / `main` 因 `sidebarPanelEnabled: false` 未注册，与设计一致）（§3.2） |
| 16 条 Web 路由 | ✅ 无需改 | `ctx.webServer.register({kind:'exact', handler})` 契约未变（新增的是并行的 `resource` 形态）；本机 200/405 符合预期（§3.3） |
| LLM 适配器面 | ✅ 无需改 | `registerAdapter` / `registerModelDiscovery` / `registerConfigurableProviders` 的 `.d.ts` 与 rc.5 逐字节相同；新增 `LlmModelInfo.badge` 与 `llm/models-updated` 是加法（§3.4） |
| pi-ai 适配 | ✅ 无需改 | 宿主从 pi-ai `1.1.0` 升到 `1.3.0`，但 `transcript.js` 与 `models.js` 语义未变（只多一个 `baseUrl` 字段）；`PiAiAdapter` 的 `resolveModel` / `prepareCall` / `stream` 签名未变（§3.5） |
| settings | ✅ 无需改 | `configure(presentation, owner)` 的**类型**未变；运行时改为读 `owner.ctx.fiber`，本插件传的正是 `ctx.fiber`，两者同一对象（§3.6） |
| sessionProjections | ⚠️ 弃用但可用 | `stateOf(session, key)` 在 0.2.2 标记 deprecated，首次调用打一条 warn 后仍返回状态；本插件只在 CLI 桥的目录源里调用它（§5.1） |
| 主题 token | ✅ 无需改 | 定义集 190 → 201 项，**只增不减**，唯一被删的 `--dsw-specific-sidebar-nav-item-hover` 本插件未使用（§3.7） |
| 客户端模块 | ✅ 无需改 | 4 个 `dsh.client.inject` 模块全部照旧；本机客户端已加载并完成注册（§3.2） |
| **本仓库测试** | ✅ 全绿 | 183 文件 / 3098 条通过（2 条按平台跳过；含本次新增 1 条）；`tsc` 两个项目 0 error（§6） |

一句话：**0.2.2-rc.1 是本插件自 0.2.1-rc.5 以来改动最大的一次宿主（2623 个提交、vendor 全线升版），
但改动全部落在本插件不碰的面上。** 需要动作的只有一条弃用 API，且不紧急。

## 二、0.2.2-rc.1 到底改了什么

`dsh-v0.2.1-rc.5..dsh-v0.2.2-rc.1` 共 **2623 个提交**（含大量 merge 与 release 提交），是一次大版本的
功能合集。与本插件相关的结构变化只有四类：

| 类别 | 内容 | 与本插件的关系 |
|---|---|---|
| vendor 底座 | `cordis 4.0.2 → 4.1.0`、`schemastery 3.18.4 → 3.19.0`（代码逐字节相同）、Loader `1.0.6 → 1.1.0`、Include `1.1.1`、cosmokit/hmr/timer 同批 | 公开 API 未变；`fiber.entry` 仍由 Loader 设置（§3.6） |
| LLM 面 | `LlmModelInfo.badge`、`llm/models-updated` 事件、`GenerateOptions.purpose` 改为可声明合并 | 全部是加法；本插件对三者都不依赖（§3.4） |
| pi-ai 面 | 宿主依赖 `@earendil-works/pi-ai ^1.1.0 → ^1.3.0`；`PiAiAdapterOptions.prepareHeaders`；`ResolvedPiAiProviderProfile` 新增 `maxRequestImages` / `imageOffloadCountQuantum` | 前两项加法；第三项是类型面必填、运行时容忍（§3.5、§5.2） |
| 投影/会话面 | 投影帧改为 `changes[]`、`snapshot` 只算选中的单元、`stateOf(session,key)` 弃用、已释放单元保留检查点 | 本插件只用 `stateOf` 读 `workingDirectory`，仍可用（§5.1） |

其余 13 份升级指南（`docs/upgrade-guide/v0.2.2-alpha.2/`）逐条对照后**没有一份要求本插件改代码**：
`context-menu-target`、`forge-git-permissions`、`forge-worktree-entry`、`fs-observation-policy-default-off`、
`projection-event-frames`、`projection-released-checkpoint`、`projection-snapshot-scope`、
`schedule-agent-tools`、`schedule-remote-host-tasks`、`sdk-run-commands`、`cordis-loader-entry-trees`、
`llm-request-purpose-declarations`、`pi-ai-request-image-count`。其中后两份与本插件的两个「看似相关」的点有关——
结论同样是「不需要改」，但值得写下为什么，见 §2.1 / §2.2。

### 2.1 `llm-request-purpose-declarations` 为什么不影响本插件

该指南说 `GenerateOptions.purpose` 不再由 `dsh-llm` 声明 `'compaction' | 'session-title'`，改由生产方
包声明合并。本插件**从不读 `GenerateOptions.purpose`**：它对「宿主发来的标题请求」的识别走的是
**请求体模板**（`src/shim.ts` 的 `rewriteSessionTitleModel` 匹配单 user 消息的固定模板），不是这个
字段。`grep -rn "session-title\|purpose" src/` 命中的都是注释与 `sessionTitle` 选项名，没有一处读
`GenerateOptions.purpose`。所以类型收窄只是编译期的变化，本插件的 wire 判据不受影响；而且该判据
本来就是 fail-closed——宿主改模板，改写静默停止、回到原计费。

### 2.2 `pi-ai-request-image-count` 为什么不影响本插件

该指南给 pi-ai 路由加了 `maxRequestImages`（默认 50）与 `imageOffloadCountQuantum`（默认 10），超过
上限时由 `dsh-compaction-image-offload` 把最老的若干张替换为占位文本并重试。

**本插件的路由不经过 `llm-pi-ai` 的 Config 解析**：它自己构造 `ResolvedPiAiProviderProfile`
（`src/adapter.ts` 的 `profileFor`），只填 `maxRequestImageBytes` / `requestImagePixelBudget` /
`requestImageMaxBytes` 三个既有预算，不填这两个新字段。实测 0.2.2 的 `dsh-llm-pi-ai` 在
`toPiContextWithImages` 里对这两个值是**缺省即跳过**的：

```js
...maxRequestImages === void 0 ? {} : { maxImages: maxRequestImages },
...imageOffloadCountQuantum === void 0 ? {} : { countQuantum: imageOffloadCountQuantum }
```

所以本插件的 route 仍然只有字节预算、没有张数上限——与 rc.5 **行为完全一致**。宿主给**它自己**的
pi-ai 路由默认 50 张，不会波及本插件。

## 三、逐面核对（本机实测）

### 3.1 兼容闸门：0.2.2-rc.1 放行，0.3.0-rc.1 仍被挡

`dsh-app-boot` 的 `satisfies()` 与 `unmetRequirements()` 两个函数在 rc.5 → 0.2.2-rc.1 之间**逐字节
相同**（仍是 `semver.satisfies(rt, range, { includePrerelease: true })`）。用本仓库 `package.json`
实算：

```
0.2.1-rc.5   ADMITTED
0.2.2-alpha.3 ADMITTED
0.2.2-rc.1   ADMITTED
0.3.0-rc.1   BLOCKED（10 条 dsh-* peer 全部不满足 <0.3.0-0）
```

非 `dsh*` 的四个 peer 也逐个实算过（闸门不管它们，但插件自己声明了范围）：

```
@deepseek-ai/cordis       4.1.0   OK  (>=4.0.1-rc.1 <5.0.0 || >=4.0.2 <5.0.0)
@deepseek-ai/schemastery  3.19.0  OK  (>=3.18.1-rc.1 <4.0.0)
@earendil-works/pi-ai     1.3.0   OK  (>=0.85.0 <0.88.0 || >=1.0.0-0 <2.0.0)
react                     18.3.1  OK  (^18.2.0)
```

### 3.2 槽位账本：8 个槽位里本机 6 处在位

在**运行中的 0.2.2-rc.1 GUI** 上读槽位账本（Cordis Inspect `Slots.listSubTree`）：

| 槽位 | kind / scope | 本机占用者（本插件部分） |
|---|---|---|
| `conversation.input.right` | list / session | `dsh-connect-workbuddy-composer-credits` order 4，`active: true` |
| `conversation.input.model.label` | single / session | `priority -0.5`，`active: false`（qoder 的 `-1` 先占，`single` 槽常态） |
| `conversation.composer.dock` | list / session | `…-stats-credits` order 10、`…-cli-live` order 11，均 `active: true` |
| `shell.quota-notice` | chain / root | 宿主一条 + 本插件一条，均 `active: true` |
| `plugins.bundle.config` | keyed / root | `dsh-connect-workbuddy`、`include:dsh-connect-workbuddy` 两个 key，`priority 30` |
| `plugins.row.config` | keyed / root | 同上两个 key，`priority 30` |

这六个槽的 `registration` 字段名、必填性与 owner props 与 rc.5 一字未改（`model.label` 仍是空
`registration` + `ModelLabelOwner`；`shell.quota-notice` 仍是 `QuotaNoticeOwnerProps` 的
`code` / `message` / `dismiss` / `keepOpen`）。`sidebar.panellist` / `main` 因
`sidebarPanelEnabled: false` 未注册，与设计一致。

客户端能加载本身就是 `dsh.client.inject` 四项（`dsh-client-ui-settings`、`dsh-client-ui-slots`、
`dsh-client-ui-settings-plugins`、`dsh-client-locale`）在 0.2.2 模块注册表里全部可解析的证据——
少任何一项，整张卡会是「依赖失败」，而不是账本里出现 `dsh-connect-workbuddy-client`。

### 3.3 Web 路由：宿主契约未变，本机全绿

`dsh-host-webserver` 的 `register()` 在 0.2.2 新增了 `WebResourceRoute`（`{kind, path, resource}`）与
`readResource()`，但**原有的 `handler` 形态原样保留**（`register(route: WebRoute | WebResourceRoute)`），
请求分发仍走 `match(pathname) ?? fallback`。本机实探：

| 请求 | 结果 |
|---|---|
| `GET …/plugins/dsh-connect-workbuddy/usage?region=cn` | **200**，`status: signed-in`，含 `contextBudgets` / 账号 / 区域设置 |
| `GET …/account-credits?region=cn` | **200** |
| `GET …/pool?region=cn` | **405**（该路由只接受 POST，宿主的方法门先答） |
| `POST …/media-models?region=cn` | **200** |
| `POST …/pool?region=cn` | **200**（`{"error":"action must be checkin, test, or remove"}` 是参数校验，路由本身通） |

另一处相关改动是 `webserver/index-inject` 事件多了第二个参数 `peer`——本插件**不监听**该事件，
无影响。

### 3.4 LLM 适配器面：三处加法，零处破坏

`dsh-llm` 的 `lib/types/index.d.ts`（服务与注册面）与 rc.5 **逐字节相同**；`lib/index.js` 的唯一语义
改动是目录校验里多拷一个 `badge` 字段。`lib/types/types.d.ts` 的全部 6 个 hunk：

1. 新增事件 `llm/models-updated(provider)`（`@mode emit`）；
2. 新增 `LlmModelBadge { text: LocalizedText; tone }`；
3. `LlmModelInfo` 新增可选 `badge`；
4. 新增 `LlmRequestPurposeMap`，`GenerateOptions<Purpose>` 泛型化，`purpose` 从固定联合改为派生；
5. 对应 `import type { LocalizedText }`。

本插件对 `LlmModelInfo` 只填 `id` / `name` / `contextWindow` / `maxTokens` / `input` 等既有字段
（`registerModelDiscovery` 的返回值），多一个可选字段不影响校验；`registerAdapter` 的
`AdapterRegistrationHandle` / `DirectoryRegistrationHandle` 类型一字未动。

### 3.5 pi-ai 适配：1.1.0 → 1.3.0，transcript 契约未变

这是本轮唯一「宿主依赖大版本前进」的点，逐项核过：

| 检查项 | 结果 |
|---|---|
| `createProvider` / `createAssistantMessageEventStream` / `isContextOverflow` / `openAICompletionsApi`（`./api/openai-completions.lazy`）导出 | 1.3.0 全部仍在 |
| `dist/utils/transcript.js`（`normalizeContext` / `resolveTranscriptTools`） | **逐字节相同** |
| `dist/models.js` 的 `setProvider` / `streamSimple` | 未变；`refresh` 的上下文只多一个 `baseUrl` 字段 |
| `Model` / `BaseModel` / `CreateProviderOptions` 形状 | 未变（`input` 从 `("text"\|"image")[]` 放宽为 `ModelInputModality[]`；`type?` 仍可选） |
| 被删导出 `./utils/assistant-message-frame.ts` | 本插件未使用 |
| `PiAiAdapter` 的 `resolveModel` / `prepareCall` / `stream` | 签名未变；只新增可选 `prepareHeaders` |

本插件的 `EffortNormalizingAdapter` 覆写的正是这三个方法，`super.*` 调用照旧。`prepareHeaders` 与
`llm-pi-ai/request-headers` 瀑布本插件不参与——它的鉴权走 `resolveApiKey` → 共享密钥 →
`Authorization: Bearer`，宿主新增的 header 钩子在 `attributionHeaders()` 之前执行，不会覆盖它。

`ResolvedPiAiProviderProfile` 新增的两个必填字段见 §5.2。

同一包里还有一处容易误读的改动：`DEFAULT_CONTEXT_WINDOW` 从 262144 提到 **1000000**、
`DEFAULT_MAX_TOKENS` 从 32768 提到 **128000**。这两个默认值只作用于「配置没写、目录也没给」的模型；
本插件的 `toPiModel` 对每个模型都显式写 `contextWindow` / `maxTokens`（来自上游目录，schema 要求
`min(1)`，见 `src/index.ts` 的模型 schema），所以不落在这条默认值上——不会出现「模型没声明窗口就被
当成 1M」的情况。

### 3.6 settings / 投影 / 附件 / 客户端

- **`dsh-settings`**：`.d.ts` 未变；`index.js` 的三处改动都是 Cordis 4.1 的适配——
  `configure(presentation, owner = this.ctx.fiber)` 内部改为 `owner.ctx.fiber`，`entries()` 改为读
  `fiber.effectiveConfig`。本插件 `ctx.effect(() => settings.configure({ auto: true }, ctx.fiber))`
  传的是 `ctx.fiber`，而 `Fiber.ctx.fiber` 就是它自己，键身份不变，行为不变。本机插件已加载、
  设置卡片两个 key 均注册成功，是这条路径可用的直接证据。
- **`dsh-attachment`**：服务名仍是 `attachments`；类型面只给 `AttachmentAdmissionPart` 加了一种
  「已入库图片」变体（`{type:'image', attachment, encodedBytes}`）。本插件只用 `AttachmentStore`
  类型，不构造 admission part。
- **`dsh-client-locale`**：`LOCALE_IDS` 仍是 `["zh","en"]`，`register(ns, dicts)` 的基线双语要求未变
  （类型上反而放宽为允许额外 locale）。宿主新增 ja/es/fr/de/ru/pt 字典，与本插件自带的
  `settings.workbuddy` 命名空间互不影响。
- **`dsh-client-ui-settings`**：只新增 `settings.section.icon` 槽（本插件未注册 `settings.section`）。
- **`dsh-client-ui-settings-plugins`**：`client.js` 的差异只有 CSS（`@media (hover:hover)`）与六种新
  语言的字典；`PluginsSettingsSection` 的 owner props 未变。
- **`dsh-client-ui-slots` / `dsh-client-ui-renderer`**：`lib/` 与 rc.5 逐字节相同。
- **Cordis 4.1.0**：公开 API 未变（`Context.effect` / `inject` / `get` / `logger` 均原样）；
  `LoggerLevel` 枚举数值重排（`WARN=1, INFO=2`），本插件不引用该枚举，只用 `ctx.logger.warn/error`。
  `Fiber.config` 换成 `effectiveConfig` / `rawConfig` 属内部字段，本插件只读 `ctx.fiber.entry`，
  而 Loader 1.1.0 仍在 `fiber.entry = fiber.parent[Entry.key]` 处赋值。
- **`dsh-client-ui-primitives`**：`lib/` 有 63 个文件变动（新增 `AnimatedRows` / `DetailDocument` 等），
  但本插件的客户端**故意不依赖**该包（`src/client/popover.ts` 有专文说明），因此不在面上。

### 3.7 主题 token：只增不减

`packages/client/ui-theme/src/styles/design-platform.css` 的定义集从 190 项增到 201 项，新增
`--dsw-alias-illustration-*`、`--dsw-alias-state-done-primary`、`--dsw-static-*` 等；删除仅
`--dsw-specific-sidebar-nav-item-hover` 一项，本插件未使用。本插件用到的 29 个 token 名里 17 个有定义，
其余 12 个（含 `--dsw-alias-` 这个模板拼接残片）在 `styles.ts` 里带 fallback——与 rc.5 相比**没有
新增缺口**。

## 四、逐包比对（rc.5 → 0.2.2-rc.1）

对 npm 上两个版本逐个 `npm pack` 后比 `lib/`：

```
dsh-llm                      DIFF   badge / models-updated / purpose 泛型（§3.4）
dsh-llm-pi-ai                DIFF   prepareHeaders、profile 两字段、默认 1M/128K、图像计数（§3.5）
dsh-host-webserver           DIFF   resource 形态 + index-inject 的 peer 参数（§3.3）
dsh-attachment               DIFF   admission part 新增 image 变体（§3.6）
dsh-settings                 DIFF   configure/effectiveConfig 的 Cordis 4.1 适配（§3.6）
dsh-client-ui-settings       DIFF   新增 settings.section.icon 槽（§3.6）
dsh-client-ui-settings-plugins DIFF CSS 与六语言字典（§3.6）
dsh-client-locale            DIFF   新增六语言、register 类型放宽（§3.6）
dsh-client-ui-primitives     DIFF   63 文件；本插件不依赖（§3.6）
dsh-client-ui-slots          BYTE-IDENTICAL
dsh-client-ui-renderer       BYTE-IDENTICAL
dsh-atomic-write             BYTE-IDENTICAL
dsh-home-paths               BYTE-IDENTICAL
@deepseek-ai/cordis          4.0.2 → 4.1.0（公开 API 未变）
@deepseek-ai/schemastery     3.18.4 → 3.19.0（lib/ 逐字节相同，只有 package.json 版本号变）
@earendil-works/pi-ai        1.1.0 → 1.3.0（transcript/models 语义未变，§3.5）
```

另外几个被本插件间接依赖、但不属于 peer 的包：

| 包 | rc.5 vs 0.2.2-rc.1 | 说明 |
|---|---|---|
| `dsh-app-boot` | DIFF | 新增 `assertBundlePlatform` / `dsh.bundle.platforms`（本插件不声明，默认全平台）；闸门两函数逐字节相同 |
| `dsh-system-prompt` | DIFF | 新增 `TOOL_APPLY_PATCH` / `TOOL_SCHEDULE` 排序常量；工具声明改由 provider 拥有。本插件不注册 prompt 段、不指纹宿主提示词 |
| `dsh-harness-dev-context` | DIFF | 投影注册改为 await 句柄；本插件不读该投影 |
| `dsh-file-reference` / `dsh-web-app` | BYTE-IDENTICAL | — |
| `cordis-plugin-loader` | 1.0.6 → 1.1.0 | `EntryTree.write()` 移除只影响子类；本插件用 patch 文件 `insert`，方言未变；`loader/volatile-update` 仍在、`fiber.entry` 仍设置 |

## 五、三件要记在案上的事

### 5.1 `sessionProjections.stateOf(session, key)` 已弃用（可用，但会告警）

0.2.2 的 `dsh-session-projection` 把注册表级的 `stateOf(session, key)` 标成 deprecated：

```js
stateOf(session, key) {
  if (!this.deprecatedStateOfKeys.has(key)) {
    this.deprecatedStateOfKeys.add(key);
    this.ctx.logger.warn(`sessionProjections.stateOf(session, ${JSON.stringify(key)}) is deprecated; …`);
  }
  …
  return this.cellFor(registration, session).state;
}
```

**它仍然返回正确的值**，只是每个 key 每进程打一条 warn。本插件只在 CLI 桥的目录源里调用一次
（`src/index.ts` 的 `WORKING_DIRECTORY_PROJECTION_KEY`），且 `cliBridgeEnabled` 默认 false，
所以今天连这条告警都不会出现。

推荐的迁移（下个功能版顺手做，不单独发版）：把

```ts
state = reader.stateOf(session, 'workingDirectory')
```

换成

```ts
state = reader.snapshot(session, ['workingDirectory']).values.workingDirectory
```

`snapshot(session, keys)` 在 0.2.2 只计算选中的单元，`workingDirectory` 是 client-visible 单元
（`wire.view = state => state`），返回的正是同一个 `string | null`。**不要**改用
`ctx.workingDirectory.get(session)`：那个服务在「没有提交过目录」时回落到宿主进程的 cwd，而本插件
的注释明确写了这个回落必须避免（会把「不知道」变成「用这个」）。

### 5.2 `ResolvedPiAiProviderProfile` 的两个新必填字段（类型面，运行时容忍）

0.2.2 的 `dsh-llm-pi-ai` 在 `ResolvedPiAiProviderProfile` 上新增：

```ts
maxRequestImages: number            // 默认 50（Config 解析时补）
imageOffloadCountQuantum: number    // 默认 min(10, maxRequestImages)
```

本插件自己构造 profile，**没有填这两个字段**。运行时安全（§2.2 的缺省即跳过），但有两层后果：

- 今天 `pnpm typecheck` 通过，是因为 devDeps 还钉在 `0.1.7-rc.1`，类型里没有这两个字段；
- 一旦把 devDeps 升到 `0.2.2-rc.1`，`src/adapter.ts` 的 `profileFor` 会因缺两个必填字段而**编译失败**。

届时补字段要**有意识地选值**，不能照抄 50：本插件今天没有张数上限，填 `maxRequestImages: 50` 等于
主动收紧行为。建议按 WorkBuddy 上游的真实单请求上限填（未知则填一个明显高于正常用量的值，并在
`REQUEST_IMAGE_BUDGETS` 旁写明理由）。

### 5.3 两个可选增强面（不是待办）

- **`LlmModelInfo.badge`**：宿主 0.2.2 起允许 provider 在目录里给每个模型带一个
  `{ text: LocalizedText, tone }` 徽章，由模型选择器自己渲染。这正是本插件
  `conversation.input.model.label` 槽在做的事——而那个槽是 `single`，本插件与 qoder/trae 抢同一格
  （`-0.5` 输给 qoder 的 `-1`，徽章在选 qoder 时静默消失）。若将来愿意，可以把「积分倍率」改由
  `badge` 发布，既不用抢槽、又能跟随语言。**注意**：这会让徽章出现在**所有** WorkBuddy 模型行上，
  与现在「只在选中 WorkBuddy 模型时由 gate 渲染」的语义不同，属于产品决策，不是兼容性修复。
- **`llm/models-updated(provider)`**：宿主新增的事件，表示某个 route 的模型目录/展示元数据变了、
  消费者应重新 `listModels()`。本插件目前靠 `adapter.invalidate()` + `registerModelDiscovery` 让宿主
  重新发现，链路已经通；这个事件只是让「目录刷新」有更直接的广播方式，不接也能工作。

## 六、测试与验收

### 6.1 本仓库自有套件

```
Test Files  183 passed | 1 skipped (184)
     Tests  3098 passed | 2 skipped (3100)
  Duration  41.05s
```

`npx tsc -p tsconfig.json --noEmit` 与 `npx tsc -p tsconfig.client.json --noEmit` 均 0 error。

### 6.2 本机 `doctor`

```
WorkBuddy Connect 5.18.2 on v25.9.0
pi-ai runtime: legacy 0.85.1 (…/node_modules/.pnpm/@earendil-works+pi-ai@0.85.1/…/dist/index.js)
Host bundle: running (pid 98131)
CN (domestic) accounts: 9 / Global accounts: 3
Static fallback models: CN 11, Global 19
```

第一行的 `legacy 0.85.1` 是**本仓库开发链接**的必然结果：插件目录下有本地 pi-ai 副本，会遮蔽宿主
注入的那份。市场安装（无本地副本）解析到的是宿主的 1.3.0，`piAiRuntimeInfo()` 判 `modern`；两条
分支的桥接逻辑（`withLegacyContext` / `foldModernContext`）在 0.2.2 上没有改动，§3.5 已逐项核对。

### 6.3 与 rc.5 那轮的差别

rc.5 那轮把 `@deepseek-ai/dsh*` 全量 alias 到 rc.5 产物跑了一遍夹具。本轮没有重复这个动作，原因：
本插件对宿主的**运行时导入**只有 `dsh-llm`（`createUserMessage` / `resolveRetryPolicy` /
`ReasoningEffortId`）与 `dsh-llm-pi-ai`（`PiAiAdapter`）两个符号，其余全是 `import type`；这两个包的
实现已在 §3.4 / §3.5 逐函数比对过，且运行中的 0.2.2-rc.1 宿主已经把插件完整加载起来（槽位账本 +
16 条路由是活的）。夹具 alias 能提供的额外信息只有「类型层是否还编得过」，而那正是 §5.2 已经
写明的一个已知差异。

## 七、结论与后续

1. **本版不改代码。** 0.2.2-rc.1 没有需要同步适应的破坏性宿主变更。
2. **不升版本号。** 本文件是纯文档；按本仓库惯例，`docs:` 提交不伴随版本号变更。
3. **下个功能版顺手做两件小事**：① 把 CLI 桥的 `stateOf` 换成 `snapshot(session, ['workingDirectory'])`；
   ② 升级 devDeps 到 0.2.2 线时给 `profileFor` 补 `maxRequestImages` / `imageOffloadCountQuantum`
   （值要有依据，见 §5.2）。两件都不需要单独发版。
4. **可选增强不进待办**：`LlmModelInfo.badge` 与 `llm/models-updated` 是产品选择，不是兼容性缺口。
5. **下一道围栏仍是 `0.3.0-0`。** 0.2.2-rc.1 在声明范围内，`0.3.0-rc.1` 被明确挡住，实算已复验。
6. **复核路径不变**：下次宿主升级仍按 `RELEASING.md` 的「宿主范围核对」走——先跑闸门实算，再跑
   槽位账本与路由探针，最后按 §4 逐包比对确认直接依赖有没有动。
