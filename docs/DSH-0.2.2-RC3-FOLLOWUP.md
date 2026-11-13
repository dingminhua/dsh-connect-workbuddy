# DSH 0.2.2-rc.3 升级复核

> 调研日期：2026-11-14
> 宿主实测版本：`0.2.2-rc.3`（本机 `DeepSeek Harness.app`；随包 `@deepseek-ai/dsh*` 全部
> `0.2.2-rc.3`，vendor 为 `cordis 4.1.0`、`schemastery 3.19.0`、`cordis-plugin-loader 1.1.0`、
> `@earendil-works/pi-ai 1.3.0`；GUI `http://127.0.0.1:59901`）
> 上一份复核：[`DSH-0.2.2-RC2-FOLLOWUP.md`](DSH-0.2.2-RC2-FOLLOWUP.md)（rc.2）
> 结论：**rc.3 没有新增任何需要本插件适配的宿主变更；本轮不改一行源码。**
> 附带清掉了一条**从未发布过**的死 override（§4.1），那不是 rc.3 引出的，是它让这个问题显形。

## 一、结论速览

| 面 | 状态 | 依据 |
|---|---|---|
| peer 版本范围 | ✅ 无需改 | 闸门代码与 rc.2 逐字节相同；实算 `0.2.2-rc.3` ADMITTED、`0.3.0-rc.1` BLOCKED（§3.1） |
| 直接依赖的 `lib/` | ✅ 零代码变化 | 13 个 import 的包里 **12 个逐字节相同**，剩下 1 个只有包版本号（§2.1） |
| 新增槽种 `hoc` | ✅ 无需改 | rc.3 首次落地（`sidebar.session.action`），本插件不 claim 它，`declaredSlotKind()` 的兜底仍然正确（§3.2） |
| 新增 Factory `workspace.picker` | ✅ 无需改 | 本插件不使用任何 Factory |
| 既有 6 处槽位 | ✅ 无需改 | 运行中的 rc.3 上全部 `active: true`（§3.2） |
| 16 条 Web 路由 | ✅ 无需改 | 契约未变；该 200 的 200、POST-only 的 405（§3.3） |
| LLM 适配器面 | ✅ 无需改 | `dsh-llm` / `dsh-llm-pi-ai` 的 `lib/` 与 rc.2 逐字节相同 |
| pi-ai 代际 | ✅ 无需改 | 宿主仍随包 1.3.0，`dsh-llm-pi-ai@0.2.2-rc.3` 仍声明 `^1.3.0` |
| 主题 token | ✅ 无需改 | `dsh-client-ui-theme` 的 `lib/` 逐字节相同 |
| 依赖栈 | ⚠️ 本版跟随 | overrides 整块 `0.2.2-rc.2` → `0.2.2-rc.3`，并删除死 override（§4） |
| **本仓库套件** | ✅ 全绿 | 205 文件 / 3497 通过 / 2 按平台跳过；`tsc` 两个项目 0 error（§5） |

一句话：**rc.3 是一次「只加了一个实验包」的发布，本插件一行源码都不用动；这一版做的是把依赖基线
和实测声明跟上，并清掉一条早就该死掉的 override。**

## 二、0.2.2-rc.3 到底改了什么

随包 `docs/upgrade-guide/README.md` 里**最新的一节仍是 `## v0.2.2-rc.1`**（19 条），没有
`v0.2.2-rc.3` 一节 —— 与 rc.2 时一样，rc.3 没有自己的破坏性清单。

从 `deepseek-harness` 仓库看，`dsh-v0.2.2-rc.2..dsh-v0.2.2-rc.3` **只有 6 个提交**，其中
4 个是 CI/发布相关，真正的功能改动只有一个：**新增实验包 `dsh-deepseek-chat-import`**
（把 DeepSeek 官网导出的对话导入为会话）。

### 2.1 逐包比对（npm tarball 逐个文件 sha1）

比对了 37 个包（本插件 import 的、宿主关键面、以及 rc.3 动过的）：

| 结论 | 包数 | 明细 |
|---|---|---|
| **`lib/` 逐字节相同**，只有 `package.json` 的版本号不同 | **31** | 含全部 13 个本插件 import 的包里的 12 个、`dsh-app-boot`、`dsh-web-app`、`dsh-session`、`dsh-error`、`dsh-client-ui-theme` |
| **有代码变化** | **6** | 见下表 |
| 有代码变化的包中，**本插件依赖的** | **1** | `dsh-client-ui-primitives`，且是纯加法 |

| 包 | 代码变化 | 与本插件的关系 |
|---|---|---|
| `dsh-client-ui-primitives` | `lib/index.js` 新增 `upload-outline` 图标 + 两个导出（`IconUploadOutlineRegular` / `…Medium`）；`artwork.d.ts` / `index.d.ts` 同步 | **纯加法**。本插件刻意不依赖它（`WorkBuddyQuotaNotice.tsx` 用自建 DOM，理由写在该文件头） |
| `dsh-client-ui-sidebar` | 新增 `sidebar.session.action`（`kind: 'hoc'`）、New Session 行包进 `.newSessionRow` | 本插件不 claim 该槽；也不依赖 New Session 行的 DOM 结构（§3.4） |
| `dsh-client-ui-workspace` | 新增 `workspace.picker` Factory + `workspace.picker.directoryFlow` 槽、`WorkspacePickerFactory` | 本插件不使用 Factory |
| `dsh-client-ui-plugin-manager` | 只往两张常青名单里加了 `@deepseek-ai/dsh-deepseek-chat-import` | 无关 |
| `dsh-client-modules` | 只改了内嵌的 commit 哈希字符串 | 无关 |
| `dsh-web-frontend` | 前端 bundle 重建（唯一的功能改动来自上面那个实验包） | 无关 |

`dsh-app-boot` 的 `lib/index.js` 与 rc.2 **逐字节相同**——兼容闸门没动，这是 §3.1 结论的直接依据。

## 三、逐面核对（本机实测）

### 3.1 兼容闸门：0.2.2-rc.3 放行，0.3.0-rc.1 仍被挡

闸门两函数（`satisfies()` / `unmetRequirements()`）在 rc.2 → rc.3 之间逐字节相同
（仍是 `semver.satisfies(rt, range, { includePrerelease: true })`）。用本仓库 `package.json`
和真实 `semver` 实算：

```
0.2.2-rc.1   ADMITTED
0.2.2-rc.2   ADMITTED
0.2.2-rc.3   ADMITTED      ← 本轮新增
0.2.2        ADMITTED
0.3.0-rc.1   BLOCKED（10 条 dsh-* peer 全部不满足 <0.3.0-0）
0.3.0-0      BLOCKED（同上）
```

非 `dsh*` 的四个 peer 也逐个实算过：

```
@deepseek-ai/cordis       4.1.0   OK  (>=4.0.1-rc.1 <5.0.0 || >=4.0.2 <5.0.0)
@deepseek-ai/schemastery  3.19.0  OK  (>=3.18.1-rc.1 <4.0.0 || >=3.18.2 <4.0.0)
@earendil-works/pi-ai     1.3.0   OK  (>=0.85.0 <0.88.0 || >=1.0.0-0 <2.0.0)
react                     18.3.1  OK  (^18.2.0)
```

### 3.2 槽位账本

在运行中的 0.2.2-rc.3 GUI 上读槽位账本（Cordis Inspect `Slots.listSubTree`）：

| 槽位 | kind | 本插件占用者 | 状态 |
|---|---|---|---|
| `conversation.input.right` | list | `dsh-connect-workbuddy-composer-credits` order 4 | `active: true` |
| `conversation.input.model.label` | **single** | 本插件 `priority -105`（压过 trae `-102` / qoder `-101`，两者 `active: false`） | `active: true` |
| `conversation.composer.dock` | list | `stats-credits` order 10、`cli-live` order 11 | 均 `active: true` |
| `shell.quota-notice` | chain | 宿主一条 + 本插件一条 | 均 `active: true` |
| `plugins.bundle.config` / `plugins.row.config` | keyed | — | 按配置在位 |

**关于 rc.3 新增的 `hoc` 槽种。** 这是 `hoc` 第一次真正出现在运行时，`sidebar.session.action`
就是一个 `hoc` 槽（`replaceRisk: 'wraps-owner-content'`，实测 `occupants: []`）。本插件：

- **不 claim 它**，也不打算 claim（理由见 §3.4）；
- `ModelLabelSeatKind` 只认 `'single' | 'list' | 'keyed' | 'chain'`，遇到 `hoc` 归 `undefined`
  → 走单席兜底。**这是保守方向**：本插件真正读的那个槽（`conversation.input.model.label`）
  在 rc.3 上实测仍是 `single`，所以兜底路径根本不会被走到。这条记下来，是因为它是
  `declaredSlotKind()` 那个「未知 kind 一律 `undefined`」设计第一次有了非假设的对照物。

### 3.3 Web 路由探针

15 条声明路由（`src/status-paths.ts`）逐条探过，加 `__save` 共 16 条（与 README「16 条路由」一致）：

| 方法 | 结果 | 路由 |
|---|---|---|
| `GET` | `200` | `usage`、`account-credits`、`device-profile`、`device-sdk`、`cli-live` |
| `GET` | `405`（该路由本就只接受 POST） | `media-models`、`tps`、`pool`、`oauth`、`transfer`、`checkin`、`probe`、`benefit/claim`、`models/refresh`、`accounts/refresh` |

无 5xx。`GET …/usage` 返回体仍带 `contextBudgets`、账号列表与 `creditPosition` 等既有字段。

### 3.4 New Session 行的 HOC 层：是机会，不是需求

rc.3 在侧边栏 New Session 行上开了 `sidebar.session.action`，任何插件都能在那一行装饰自己的控件。
本插件**不跟**，两个理由都写在这里免得下次重新讨论：

1. 本插件的积分读数在 composer 与卡片里，侧边栏那一行没有要放的东西；
2. 为「用上新能力」而加控件，正是 [`DESIGN.md`](DESIGN.md) §零 禁止的联动。

另外确认过：本插件**没有**任何代码依赖 New Session 行的 DOM 结构（`newSession` 类名
改成 `newSessionRow` 包裹对它无影响）。

### 3.5 主题 token

`dsh-client-ui-theme` 的 `lib/` 与 rc.2 **逐字节相同**，本插件用到的 `--dsw-*` 无缺口。

## 四、本版实际改动（只有依赖与文档，无源码）

### 4.1 依赖栈：整块跟到 rc.3，并删掉一条从未发布的死 override

| 项 | 旧 | 新 |
|---|---|---|
| `dsh-*`（overrides 线） | `0.2.2-rc.2` | `0.2.2-rc.3` |
| `@deepseek-ai/cordis` | `4.1.0` | 不变 |
| `@deepseek-ai/schemastery` | `3.19.0` | 不变 |
| `@earendil-works/pi-ai` | `1.3.0` | 不变 |

`package.json` 的 devDeps 写的是**范围**（`>=0.1.7-rc.1 <0.3.0-0`），不是精确版本，所以这一跳
**只动 `pnpm-workspace.yaml`**。装完实测版本：

```
dsh-llm / dsh-llm-pi-ai / dsh-attachment / dsh-settings / dsh-host-webserver
dsh-client-locale / dsh-client-ui-{primitives,renderer,settings,settings-plugins,slots}
dsh-home-paths / dsh-atomic-write                                  全部 0.2.2-rc.3
cordis 4.1.0 / schemastery 3.19.0 / pi-ai 1.3.0                    不变
lockfile 中 0.2.2-rc.2 残留：0 条
```

**顺带清掉的坑：`@deepseek-ai/dsh-invariants`。** 它一直是 overrides 里的一条，从 0.1.2-rc.1
时代就在。本轮整块换线时才发现它有两个问题叠在一起：

1. 上游已在 **0.2.1-rc.3 把这个包从捆绑集里删除**
   （[`DSH-0.2.1-RC3-FOLLOWUP.md`](DSH-0.2.1-RC3-FOLLOWUP.md) §四已记录）；
2. 本仓库那条 override 跟着整块换线被推到了 `0.2.2-rc.2` —— **而 npm 上从来没有发布过那个版本**
   （`dsh-invariants` 的 0.2.x 线只有 `0.2.0-rc.2`；`0.2.2-rc.1`/`rc.2`/`rc.3` 全部 E404）。

它之所以一直没报错，是因为**已经没有包再依赖它**，pnpm 根本不去解析这条 override：它既不在
lockfile 里、也不在 `node_modules` 里。也就是说，这条 override 一年多来只是在**声称一份并不
存在的依赖**。这与本文件 §4.1 上方 `dsh-client-runtime` 那条是同一类问题，处置也一致：删掉。

> 这条是本轮唯一「不是 rc.3 引出、但被 rc.3 显形」的改动。它不改变任何用户可见行为——
> 本来就没装、也没被解析。

### 4.2 文档

- 两条 README 的实测表把 rc.3 加进去（`0.2.2-rc.1` / `rc.2` / `rc.3`），并把「本仓库套件在
  `0.2.2-rc.2` + pi-ai `1.3.0` 上全绿」改成 rc.3。
- 本文件。

## 五、测试与验收

| 组合 | typecheck | 套件 |
|---|---|---|
| `0.2.2-rc.3` + pi-ai `1.3.0`（**宿主真实组合，本轮基线**） | 0 error | 205 文件 / 3497 通过 / 2 跳过 |
| `0.2.2-rc.2` + pi-ai `1.3.0`（换线前基线，对照用） | 0 error | 205 文件 / 3497 通过 / 2 跳过 |

`pnpm run build` 通过，6 项声明产物齐全。
`node scripts/check-pii.mjs`：扫描 438 文件（其中 29 个随包发布），**clean**。

### 5.1 一条既有偶发失败（与本轮无关，但记在这里）

`tests/pool-e2e.spec.ts` 的「claims an account the status read reports as not checked in」
在**全量并行**时偶发超时（`waitFor` 的 10 秒预算）。本轮 8 次全量运行里失败了 2 次：

- **第一次发生在源码未改动时**（换线前的对照跑：仍是 5.23.1 的源码，只把依赖换到 rc.3），
  所以它不是 rc.3 引起的，也不是本轮的文档/依赖改动引起的；
- 单独跑这个 spec 文件连跑 5 次、以及 `-t` 单跑，**全部通过**；
- 换成 rc.3 线后 3 次全量运行全部通过。

排除掉的一个假设是**跨用例状态污染**：`tests/setup-per-file-home.ts` 给每个文件独立的
`DSH_HOME`，而这条用例与同文件其余三条共用它，看上去像是前一条把 `.workbuddy-auto-checkin.cn.json`
写成「今日已完成」、于是这一条读到「无待办」而不领取。但这个假设站不住：状态按 `day` 字段
逐日重置（`autoCheckinTick` 里 `stored.day !== today` 即从空状态开始），而那 2 次失败里有一次
发生在**这些用例根本还没跑到**的对照环境；实测把 store 写成今日已完成再读回，也没有改变
单跑必过的结果。

剩下的最可能解释是**并行负载下的 CPU 争抢**：这条用例要等一个 `setTimeout(…, 0)` 的一次性
定时器真正跑起来，而全量运行时 8 个 worker 同时在跑（同文件还有 47 条、`shim-failover` 有 39 条
各带 2–10 秒的真实等待）。**它不是本轮要修的东西**，但它是 CI 上一颗已知的地雷——记在这里，
下一轮要么把它挪到独立文件，要么把预算从 10 秒放宽到与 `testTimeout` 一致的 30 秒。本轮
**没有**改动它，因为没有稳定可复现的失败可供验证修复（改宽了再跑绿，证明不了任何事）。

## 六、结论与后续

1. **rc.3 没有新增需要适配的宿主破坏面**：37 个包里 31 个 `lib/` 逐字节相同，6 个有代码变化的
   里只有 1 个是本插件依赖的，且是纯加法。本版不改一行源码。
2. **新增的两个槽位（`sidebar.session.action`、`workspace.picker.directoryFlow`）本插件都不碰**，
   这也是「不做插件联动」在运行时的又一次确认。
3. **`dsh-invariants` 那条死 override 已删除**——它是本轮唯一实质性的清理，代价为零（本来就没装）。
4. **下一道围栏仍是 `0.3.0-0`**。0.2.2-rc.3 在声明范围内，`0.3.0-rc.1` 被明确挡住，实算已复验。
5. **复核路径不变**：下次宿主升级仍按 `RELEASING.md` §2.6 走 —— 先跑闸门实算，再跑槽位账本与
   路由探针，最后逐包比对确认直接依赖有没有动。本轮新增一条：**核对 overrides 里每一条是否
   真的能解析**（`pnpm why <pkg>` 无输出、且 lockfile 里没有它，就是死条目）。
