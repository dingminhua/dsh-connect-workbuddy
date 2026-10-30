# DSH 0.2.1-rc.5 升级复核

> 调研日期：2026-10-30
> 宿主实测版本：`0.2.1-rc.5`（`DeepSeek Harness.app` 的 `CFBundleShortVersionString` 与
> `CFBundleVersion` 一致；`desktop-runtime.json` 的 `release.version` 同为 `0.2.1-rc.5`，
> node 24.21.0 / pnpm 11.28.5，GUI `http://127.0.0.1:54150`）
> 上一份复核：[`DSH-0.2.1-RC3-FOLLOWUP.md`](DSH-0.2.1-RC3-FOLLOWUP.md)（rc.3）
> 结论：**无需改动**。rc.5 没有触碰本插件的任何一处宿主契约（4 个槽位、14 条 `webServer` 路由、
> LLM 适配器注册面、locale、`session/event`、`loader/volatile-update`、提示词归属包、主题 token），
> 兼容闸门照旧放行，本机实测全部健康。

## 一、结论速览

| 面 | 状态 | 依据 |
|---|---|---|
| peer 版本范围 | ✅ 无需改 | 闸门用 `includePrerelease: true`，实算 `rc.1`~`rc.5` 五个宿主全部 ADMITTED（§3.1） |
| 逐包类型面 | ✅ 无需改 | 14 个直接依赖里 **13 个的 `lib/` 与 rc.3 逐字节相同**，`pi-ai` 由宿主供给且版本未变（§4） |
| 4 个槽位 | ✅ 无需改 | `conversation.input.left` / `composer.dock` / `model.label` / `shell.quota-notice` 的 kind、注册字段、owner props 全未变（§3.2） |
| 14 条 Web 路由 | ✅ 无需改 | `dsh-host-webserver` 的 `lib/index.js` md5 与 rc.3 相同；本机 200/405 行为符合预期（§3.3） |
| pi-ai 适配 | ✅ 无需改 | 宿主仍捆 `pi-ai@1.1.0`；`dsh-llm-pi-ai` 的 `piContext()` 仍返回扁平 `{systemPrompt, messages, tools}` |
| 提示词指纹锚点 | ✅ 无需改 | `dsh-system-prompt` / `dsh-harness-dev-context` / `dsh-file-reference` / `dsh-web-app` 四个包 `lib/` 逐字节相同 |
| 主题 token | ✅ 无需改 | 定义集与 rc.3 相同（5 个缺失项是既有问题，本插件自带 fallback） |
| **rc.5 唯一新增特性** | ⚪ 不在本插件面上 | `conversation.chat.reasoning.body` 新增 `rawText`、`text` 改为显示文本——本插件**对该槽零贡献**（§2） |

一句话：**rc.5 的五处改动全落在本插件不碰的面上**——四处是别人的 UI 细节或 ACP 日志卫生，
一处（`rawText`）是本插件零贡献的推理槽位。没有一处需要同步。

## 二、rc.5 到底改了什么

rc.3 → rc.5 的区间共 13 个提交，但去重后只有 **5 条独立改动**（其余是 4 条 merge、2 条
`release(dsh)` 版本提交，以及两条与它们的 PR 分支提交同内容的重复记录）：

| 改动 | 范围 | 与本插件的关系 |
|---|---|---|
| #7484 fix(web): customize thinking block rendering | `ui-chat` 推理渲染、`slot-catalog`、`cot-translation-bundle` | 不在本插件面上（§2.1） |
| #7183 fix(ui): show view tab tooltip only for overflowing labels | `ui-conversation` 会话头工具提示 | 不在本插件面上 |
| #7342 fix(ui): keep the more views tooltip fixed | 同上，另删两条不再使用的 locale key | 不在本插件面上 |
| #7179 fix(acp): keep account catalog diagnostics off stdout | `llm-deepseek-account` 把一条 `info` 改到 `console.error`，并加 stdout 回归夹具 | 无影响：本插件不写 stdout（§2.2） |
| #7168 fix(mcp): keep resource-listing diagnostics off ACP stdout | `mcp-client` 为 `resources/*` 加能力门 | 无影响：本插件不接触 MCP |

### 2.1 唯一的新增特性：`conversation.chat.reasoning.body` 的 `rawText`

rc.5 给「推理展开体」这个槽换了一对字段：

```ts
// rc.3
export interface ReasoningBodyOwnerProps {
  readonly text: string      // 原始模型输出
  readonly running: boolean
}
// rc.5
export interface ReasoningBodyOwnerProps {
  readonly rawText: string   // 原始模型输出（新增）
  readonly text: string      // 已准备好显示的文本（语义变更）
  readonly running: boolean
}
```

配套新增 `packages/client/ui-chat/src/client/reasoning-text.ts`，把 `<signature>…</signature>`
信封剥掉后再交给 `text`；官方升级指南是
`docs/upgrade-guide/v0.2.1-rc.4/reasoning-body-props/guide.zh.md`（宿主将其记在 rc.4 目录下，
实际随 rc.5 的 #7484 落地）。

**本插件为什么不受影响**：`grep -rn "conversation.chat" src/ tests/` **零命中**。本插件的
四个槽位是 composer 行（`conversation.input.left`）、模型标签（`conversation.input.model.label`）、
输入卡下方（`conversation.composer.dock`）与帧级配额提示（`shell.quota-notice`），
一个都不在 `conversation.chat.*` 命名空间里。宿主这次也没有删字段——旧实现读 `text` 仍能拿到
字符串，只是语义从「原始」变成「已准备」，属于**加法兼容**。

记入「将来要盯的面」而不是「要改的面」：如果本插件某天要在展开推理体里插东西
（例如给 WorkBuddy 的思考内容加个来源标记），必须同时读 `rawText` 与 `text` 并遵守
「不得对 `text` 重复执行显示处理」这条新约定。

### 2.2 ACP stdout 洁净化的两条提交为何与本案无关

rc.4 的两条 `fix(acp)` 处理的是「宿主的诊断日志写进了 ACP 的 stdout，污染 JSON-RPC 流」。
`grep -rn "console.log\|process.stdout" src/` 在本插件里**只有一处命中**，且是
`src/at-rest.ts:720` 里交给子进程 `execFile` 执行的 Electron `-e` 源码字符串（读 WorkBuddy
的构建期密钥），不是本进程的 stdout。本插件的宿主侧日志一律走 `ctx.logger` 与
`console.error`，因此这两条提交对它是空操作。

## 三、逐面核对（本机实测）

### 3.1 兼容闸门：五个 rc 宿主全部放行

用 rc.5 自己的 `evaluatePluginCompatibility()`（`@deepseek-ai/dsh-app-boot`）对本仓库
`package.json` 实算：

```
0.2.1-rc.1 ADMITTED by the gate
0.2.1-rc.2 ADMITTED by the gate
0.2.1-rc.3 ADMITTED by the gate
0.2.1-rc.4 ADMITTED by the gate
0.2.1-rc.5 ADMITTED by the gate
0.3.0-rc.1 BLOCKED
```

放行的原因仍是那条：闸门的 `satisfies()` 包装带 `{ includePrerelease: true }`
（`dsh-app-boot/lib/index.js`，`unmetRequirements` 上方的 `satisfies` 函数），
所以「裸 semver 判 false」与「宿主实际放行」并存——这正是
[`DSH-0.2.1-RC3-FOLLOWUP.md`](DSH-0.2.1-RC3-FOLLOWUP.md) §3 订正过的归因，本次无新变化。

`dsh-app-boot` 的 `lib/` 在 rc.3 与 rc.5 之间**逐字节相同**，所以这道闸门连实现都没动。

### 3.2 四个槽位：定义与占用都照旧

在**运行中的 rc.5 GUI** 上读槽位账本（Cordis Inspect `Slots.listSubTree`）：

| 槽位 | kind / scope | 本机占用者（优先级或 order） |
|---|---|---|
| `conversation.input.left` | list / session | trae `4`、qoder `4`、**workbuddy `4`** — 全部 `active: true` |
| `conversation.input.model.label` | single / session | qoder `-1`（active）、**workbuddy `-0.5`**、trae `0` |
| `conversation.composer.dock` | list / session | 宿主 `activity`/`usage`，trae `10`、qoder `10`、**workbuddy `10`**、**workbuddy-cli-live `11`** |
| `shell.quota-notice` | chain / root | 宿主一条 + **workbuddy 一条**，均 `active: true` |

`model.label` 那条 `active: false` 是 `single` 槽的正常形态（同优先级只有一个赢家，本插件
`-0.5` 落在 qoder `-1` 之后），不是本轮的新问题——正是
[`DSH-0.2.1-RC3-FOLLOWUP.md`](DSH-0.2.1-RC3-FOLLOWUP.md) §2.3 记录的既定代价。

三个槽的 `registration` 声明（字段名、必填性）与 owner props 在 rc.5 里**一字未改**；
`shell.quota-notice` 的 `QuotaNoticeOwnerProps`（`code` / `message` / `dismiss` / `keepOpen`）
与 rc.3 相同。

### 3.3 Web 路由：宿主侧零改动，本机全绿

`dsh-host-webserver` 的 `lib/index.js` 在 rc.3 与 rc.5 下 md5 相同
（`c73123f999b4425a52a6cf6f39d3f7e0`），`ctx.webServer.register({kind:'exact', …})`
这条契约没有变化。对运行中的 rc.5 宿主实探：

| 请求 | 结果 |
|---|---|
| `GET …/usage?region=cn` | **200**，18317 字节，`status: signed-in`，15 个模型 / 9 个账号 |
| `POST …/media-models?region=cn` | **200** |
| `GET …/models-refresh?region=cn` | 404 → 该路由是 POST-only，`GET` 落在宿主 404 是**正确**行为 |
| `GET …/account-credits?region=cn` | **200**，939 字节，三个账号读数齐全 |

14 条 `exact` 路由（`usage` / `account-credits` / `accounts-refresh` / `checkin` /
`benefit-claim` / `models-refresh` / `media-models` / `probe` / `tps` / `pool` / `__save` /
`oauth` / `transfer` / `cli-live`）的注册代码在 rc.3 复核后没有改动，宿主侧也没有改动，
因此不需要逐条重探。

### 3.4 客户端模块注册表与主题 token

rc.5 shell 的静态模块注册表（`rM()`）仍精确列出本插件 `dsh.client.inject` 用到的那几项：
`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。
一条都没有被移除或改名——`dsh.client.inject` 的每一项都是加载依赖，少了任何一项都会让
整张卡变成「依赖失败」。

主题 token 的定义集在 rc.3 与 rc.5 下**完全相同**：本插件用到的 24 个 token 里 19 个有定义，
剩下 5 个（`--dsw-alias-label-caution`、`--dsw-alias-label-error`、
`--dsw-alias-label-caution-background`、`--dsw-alias-bg-secondary`、`--dsw-alias-bg-l1`）
是**升级前就缺**的，本插件在 `styles.ts` 里为它们带了 fallback，本次没有新增缺口。

## 四、逐面包比对（rc.3 → rc.5）

### 4.1 本插件的 14 个直接依赖

对 npm 上 `0.2.1-rc.3` 与 `0.2.1-rc.5` 两个版本逐个 `npm pack` 后比 `lib/`：

```
dsh-atomic-write            BYTE-IDENTICAL
dsh-attachment              BYTE-IDENTICAL
dsh-client-locale           BYTE-IDENTICAL
dsh-client-ui-primitives    BYTE-IDENTICAL
dsh-client-ui-renderer      BYTE-IDENTICAL
dsh-client-ui-settings      BYTE-IDENTICAL
dsh-client-ui-settings-plugins BYTE-IDENTICAL
dsh-client-ui-slots         BYTE-IDENTICAL
dsh-home-paths              BYTE-IDENTICAL
dsh-host-webserver          BYTE-IDENTICAL
dsh-llm                     BYTE-IDENTICAL
dsh-llm-pi-ai               BYTE-IDENTICAL
dsh-settings                BYTE-IDENTICAL
@earendil-works/pi-ai       由宿主供给（^1.1.0，两版相同）
```

**13 个可打包的依赖全部逐字节相同。** 这与 rc.1→rc.3 那一轮形成对照：那次
`dsh-client-ui-primitives` 动了 75 个文件、删了一个导出，需要逐条核对；这次一个字节都没动。

安装进 `app.asar` 的那份 `lib/` 与 npm 包有一处差异：CSS-module 的类名前缀与源码映射里的
构建路径（`/home/runner/work/...` vs `/Users/deepseek/dsh-ci/...`）不同。归一化这两项后，
**差异归零**——即 rc.5 的本地构建产物与 npm 产物在语义上是同一份。

### 4.2 其余值得点名的包

| 包 | rc.3 vs rc.5 | 说明 |
|---|---|---|
| `dsh-app-boot` | 逐字节相同 | 兼容闸门实现未变 |
| `dsh-system-prompt` | 逐字节相同 | 提示词归属包 |
| `dsh-harness-dev-context` | 逐字节相同 | 同上 |
| `dsh-file-reference` | 逐字节相同 | 同上 |
| `dsh-web-app` | 逐字节相同 | `personaPrefix`（`You are a coding agent powered by the {{model}} model.`）与 1017 徽章插件的 patch 行都在原位 |
| `dsh-cordis-client-runner` | **仅 `slot-catalog.ts` 的 sourcemap 行号 + `reasoning.body` 的 summary/doc/ownerProps** | 就是 §2.1 那处改动在目录里的投影 |
| `dsh` 包的依赖表 | 86 条，**键集合与版本形态完全一致**，仅 `0.2.1-rc.N` 的号一起翻 | 依赖集没有增删 |
| `@deepseek-ai/cordis` / `schemastery` | `~4.0.5` / `~3.18.5`，两版相同 | 运行时底座未动 |

348 个 `package.json` 的版本号重写在 `dist.shasum` 上看起来像 348 处变更，实际全是发布脚本
的机械改写；真正有语义差异的只有 §2.1 那一处。

## 五、测试与验收

### 5.1 本仓库自有套件（0.1.7 依赖线）

```
Test Files  157 passed | 1 skipped (158)
     Tests  2655 passed | 2 skipped (2657)
```

（其中 5 条是本次新增的 [`tests/host-slot-surface.spec.ts`](../tests/host-slot-surface.spec.ts)，
见 §5.4。）`tsc -p tsconfig.json` 与 `tsc -p tsconfig.client.json` 均通过，`tsdown` 构建通过。

### 5.2 于 rc.5 宿主包上跑全量（156 通过 / 1 失败）

把 `@deepseek-ai/dsh*` 全部 alias 到 `0.2.1-rc.5` 的 npm 产物、`pi-ai` alias 到宿主捆的
`1.1.0`（配置见 `/tmp/rc5check/vitest.rc5.config.ts`）：

```
Test Files  1 failed | 156 passed | 1 skipped (158)
     Tests  2 failed | 2653 passed | 2 skipped (2657)
```

失败的两条是 `tests/adapter-outgoing-body.spec.ts` 的 **legacy 象限**
（`body.tools missing — the request declared no tools`）。

**这是夹具环境的产物，不是 rc.5 回归**，证据链三条：

1. 该文件自己的 `canDriveCell()` 用 `piAiRuntimeInfo().generation` 决定哪个象限能跑；
   `legacy` 象限要求本机解析到 0.85.x。在同一份 rc.5 alias 下实测 `piAiRuntimeInfo()` 返回
   `{"generation":"legacy","version":"0.85.1",...,"resolvedLocally":true}` —— 它读的是**本仓库
   安装的 0.85.1**，而 vite 的 alias 把**运行时导入**换成了 1.1.0。检测器与实跑库不是同一份，
   于是 legacy 象限拿着 1.1.0 的 api 去喂 0.85 形状的上下文——正是该文件头注释里写明
   「1.x 的 api 读不了这个形状」的那件事。
2. 同一份配置下**只跑这一个文件**，modern 两格 + 两条折叠用例 4/4 通过；把 alias 摘掉
   （`vitest.rc5.config.nopi.ts`）后 6/6 全通过，且用 `projectToolUpdates` 这个只在 rc.5 的
   `dsh-llm` 里导出的符号证明 rc.5 alias 确实生效。
3. 本仓库自己的 0.85.1 线上，该文件 6/6 通过（§5.1 的 2655 条里包含它）。

换句话说：**在真实宿主里**，插件解析到的是宿主捆的 `pi-ai@1.1.0`，`piAiRuntimeInfo()` 会答
`modern`，走的是 modern 分支——这正是本机 `doctor` 之外唯一无法在夹具里完全复现的组合。
CI 里已有的 `test-pi-ai-next`（pi-ai 1.1.0）那一条腿负责钉 modern 象限，本次结论与它一致。

### 5.3 本机 `doctor` 与在架 GUI

```
WorkBuddy Connect 5.14.1 on v25.9.0
pi-ai runtime: legacy 0.85.1 (…/pi-ai@0.85.1/dist/index.js) — folds 0.87 transcripts …
Host bundle: running (pid 35629)
CN (domestic) accounts: 9
Global accounts: 3
```

即：插件 5.14.1 已在 rc.5 宿主里正常运行，9 + 3 个账号读数、15 个模型、4 个槽位全部在位。

### 5.4 把「无需改动」的前提钉成测试

本文件本身不会被执行——它论证 rc.5 与本插件无关，而「无关」这件事随时可能因为**我们自己**
新增一处对 `conversation.chat.*` 的贡献而失效。所以那条论证的**前提**写成了测试
[`tests/host-slot-surface.spec.ts`](../tests/host-slot-surface.spec.ts)（5 条）：

| 用例 | 钉住的东西 |
|---|---|
| 认领的槽位是一个封闭集合 | `ctx.slots.inject` 的名字集合**恰好**是 §3.2 那四个；加第五个先在这里红 |
| 没有一个落在 `conversation.chat.*` | 本插件四个槽全在 composer（`conversation.input.*` / `conversation.composer.*`）或帧级（`shell.*`） |
| `src/` 对该槽零引用 | 不只是「不注册」，连从组件、hook、selector 里伸手都没有 |
| **条件断言**：碰到就必须读 `rawText` | 若哪天引用了该槽，该文件必须出现 `rawText`——这就是 §2.1 那条迁移要求 |
| 复核文档仍可达 | `docs/DSH-0.2.1-RC5-FOLLOWUP.md` 还在、仍写着 `rawText` 与结论 |

变异验证做了三次，全部按预期变红：

- 往封闭集合里加第五个槽（`conversation.chat.footer`）→ 第 1 条红；
- 在 `src/` 新建一个引用 `conversation.chat.reasoning.body` 的文件 → 第 3、4 条红；
- 该文件同时带上 `rawText` → 只剩第 3 条红（第 4 条的条件已被满足），证明条件断言不是恒真。

第 3 条与第 4 条**故意分开**：前者是「别伸手」的当前状态，后者是「伸了手该怎么做」的规则。
若合并成一条，将来真要在这个槽里渲染时，会被迫把规则删掉才能通过。

## 六、结论与后续

1. **本版不改代码。** 没有需要同步适应的宿主契约变化。
2. **不升版本号。** 本文件是纯文档；按本仓库惯例，`docs:` 提交不伴随版本号变更
   （参照 5.14.1 之后那次置顶帖补记）。
3. **记录一个「将来要盯」的面**：`conversation.chat.reasoning.body` 在 rc.5 起有了
   `rawText` / `text` 的语义分离。本插件今天在这个槽位零贡献（§5.4 的三条用例盯着这一点），
   但若将来要在展开推理体里插东西，必须按 §2.1 的约定同时读两个字段，且不得对 `text`
   重复做显示处理——那时 §5.4 的第 4 条会要求源码里出现 `rawText`。
4. **下一道围栏仍是 `0.3.0-0`。** rc.5 与 `0.2.1` GA 都在声明范围内；`0.3.0-rc.1` 被明确
   挡住，实算已复验。宿主目前全部 tag 仍是预发布，`<0.3.0-0` 这个写法继续有效。
5. **复核路径不变**：下次宿主升级仍按 `RELEASING.md` 的「宿主范围核对」走，先跑
   §3.1 的闸门实算，再跑 §3.2 的槽位账本与 §3.3 的路由探针，最后按 §4.1 的逐包比对确认
   直接依赖有没有动。三个探针都健康、依赖全逐字节相同时，本轮就可以只出一份文档。
