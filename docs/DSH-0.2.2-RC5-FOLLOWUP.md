# DSH 0.2.2-rc.5 升级复核

> 调研日期：2026-11-19
> 宿主实测版本：`0.2.2-rc.5`（本机 `DeepSeek Harness.app`；随包 `@deepseek-ai/dsh*`
> 全部 `0.2.2-rc.5`，vendor 为 `cordis 4.1.0`、`schemastery 3.19.0`、
> `@earendil-works/pi-ai 1.3.0`；GUI `http://127.0.0.1:59161`）
> 上一份复核：[`DSH-0.2.2-RC3-FOLLOWUP.md`](DSH-0.2.2-RC3-FOLLOWUP.md)（rc.3）
> 结论：**rc.5 没有新增任何需要本插件适配的宿主破坏面；本轮不改一行源码。**
> 这一版做的是把依赖基线与实测声明跟到 rc.5、结清 rc.3 复核留下的一条偶发超时，
> 并把跨 rc.4 / rc.5 的两份升级指南逐面登记。

## 一、结论速览

| 面 | 状态 | 依据 |
| --- | --- | --- |
| peer 版本范围 | ✅ 无需改 | 现声明 `>=0.1.7-rc.1 <0.3.0-0` 放行 `0.2.2-rc.5`；`tests/dsh-line.spec.ts` 实算通过（§3.1） |
| 直接依赖的 `lib/` | ✅ 零代码变化 | 5 个 import 的 `dsh-*` 包 rc.3 ↔ rc.5 的 `lib/` **逐字节相同**（§2.2） |
| `CONTENT_REFUSED` 拒答码（rc.4 指南） | ✅ 无需改 | 由宿主的 `dsh-llm-deepseek` 实现；本插件走自己的 pi-ai 路由，且不按宿主错误码分类（§3.2） |
| 搜索提供方默认（rc.5 指南） | ✅ 无需改 | 本插件注册 `workbuddy` / `workbuddy-global` 两条路由，不是 `deepseek-official` / `deepseek-account`，仍走 `deepseek-search-api`；源码无 `searchProvider` 引用（§3.3） |
| pi-ai 代际 | ✅ 无需改 | 宿主仍随包 1.3.0，`dsh-llm-pi-ai@0.2.2-rc.5` 仍声明 `^1.3.0` |
| 依赖栈 | ⚠️ 本版跟随 | overrides 整块 `0.2.2-rc.3` → `0.2.2-rc.5`，lockfile 零 rc.3 残留（§4.1） |
| 偶发超时（rc.3 §5.1 遗留） | ⚠️ 本版结清 | `pool-e2e.spec.ts` 的 `waitFor` 预算 10s → 30s，与 `testTimeout` 对齐（§4.2） |
| **本仓库套件** | ✅ 全绿 | 215 文件 / 3725 通过 / 2 按平台跳过；`tsc` 两个项目 0 error；`check-pii` clean（§5） |

一句话：**rc.5 是一次「改了拒答码与搜索默认」的发布，但两处都落在宿主自己的路由上，
本插件一行源码都不用动；这一版做的是把依赖基线、实测声明和文档跟上，并清掉一条已知的
偶发超时。**

## 二、0.2.2-rc.5 到底改了什么

随包 `docs/upgrade-guide/README.md` 里，从 rc.3 到 rc.5 之间有两节破坏性清单：
`v0.2.2-rc.3`（1 条）与 `v0.2.2-rc.4`（1 条）。`v0.2.2-rc.5` 自身没有独立的一节，
它是 rc.4 那节在 rc.5 宿主上的延续。

### 2.1 两份适用指南

| 版本目录 | 条目 | 摘要 |
| --- | --- | --- |
| `v0.2.2-rc.3` | `deepseek-refusal-code` | DeepSeek 流式内容拒答的错误码从 `MALFORMED_RESPONSE` 改为 `CONTENT_REFUSED`。 |
| `v0.2.2-rc.4` | `web-search-deepseek-model-default` | 交付的组合不再固定搜索提供方；DeepSeek 路由上的会话搜索改走 Messages 搜索并追加 `web/deepseek-search-llm-request` 事件。 |

**跳过的指南**：`v0.2.2-rc.1` 的 19 条已在 [`DSH-0.2.2-RC1-FOLLOWUP.md`](DSH-0.2.2-RC1-FOLLOWUP.md)
逐面复核过，且 rc.3 / rc.5 之间未再引入其中任何一条涉及的面（CUA、Forge、worktree、
终端、Session.append 替身等本插件都不碰），本轮不重复。

### 2.2 逐包比对（npm tarball 逐个文件）

对源码直接 import 的 5 个 `dsh-*` 包逐个下载 rc.3 与 rc.5 tarball，比对 `lib/`
（忽略 `.map`）：

| 包 | rc.3 ↔ rc.5 `lib/` |
| --- | --- |
| `dsh-llm` | 逐字节相同 |
| `dsh-llm-pi-ai` | 逐字节相同 |
| `dsh-attachment` | 逐字节相同 |
| `dsh-settings` | 逐字节相同 |
| `dsh-host-webserver` | 逐字节相同 |

`cordis 4.1.0` / `schemastery 3.19.0` / `pi-ai 1.3.0` 三个版本钉保持不变，tarball 均可解析。
这解释了为什么本轮 typecheck 0 error：**依赖的真实代码没动，动的只有版本号。**

## 三、逐面核对（本机实测 rc.5）

### 3.1 兼容闸门：rc.5 放行，0.3.0 线仍被挡

`tests/dsh-line.spec.ts` 对 `>=0.1.7-rc.1 <0.3.0-0` 的实算在本轮全量运行中通过。
三条不变量保持：全部 `dsh-*` peer 范围一致、devDeps 与 peer 逐条相等、上界带 `-0`
后缀真的挡住 0.3.0 预发布。rc.5 落在范围内 → 组合包不会被 `loadProfileDirectory` 静默跳过。

### 3.2 拒答码 `CONTENT_REFUSED`（rc.4 指南）

在 rc.5 宿主里，`CONTENT_REFUSED` 由 `@deepseek-ai/dsh-llm-deepseek/lib/index.js`
的 `refusal()` 构造（原 `MALFORMED_RESPONSE` 只留给「工具参数畸形」的另一条路径），
它属于 DeepSeek 官方路由的流终止分类。

本插件不受影响，理由有两条且互相独立：

1. **路由不同**：本插件注册的是 `workbuddy` / `workbuddy-global`（`src/adapter.ts`
   的 `WORKBUDDY_PROVIDER` / `WORKBUDDY_GLOBAL_PROVIDER`），不是 DeepSeek 官方路由；
   拒答码在宿主自己的路由层产生，与本插件的网关 shim 不在同一条链路上。
2. **不做宿主错误码分类**：插件对 `turn/end` 的失败处理
   （`src/channel-continue.ts` 的 `isChannelRejectFailure`）刻意按**插件自己写进 message 的
   字面量**（`channel_reject` / 「渠道校验拦截」）判定，而**不是**按宿主重分类出的
   `LlmFailure.code`。一个内容拒答本就不该触发「自动续发继续」——两类失败各走各的处置。

因此这里**不需要**新增对 `CONTENT_REFUSED` 的分支。将来若本插件要主动识别宿主拒答，
应新增测试证明它确实走到拒答分支，而不是把新码塞进与渠道门共用的分类器里。

### 3.3 搜索提供方默认（rc.5 指南）

指南的条件是「为 `deepseek-official` 或 `deepseek-account` 路由上的模型请求发起的搜索」。
本插件展示的模型来自 WorkBuddy 网关目录、挂在 `workbuddy` / `workbuddy-global` 路由下，
不满足这个条件 → 搜索仍走 `deepseek-search-api`，不会追加 `web/deepseek-search-llm-request`
事件。全库 grep：`src/` 下**没有任何** `searchProvider` / `web-search-deepseek` 引用；
插件不声明也不改写该配置，defaults 由宿主与 profile 决定。

唯一值得留意的运行期场景是**用户自己在设置页把搜索提供方切成自动选择**：那也是宿主与
profile 的行为，插件的网关地址设置（`CN 网关主机`）只影响本插件自己的.chat/目录/积分请求，
不参与 `web-search-deepseek.baseURL`。若将来报告「DeepSeek 模型上网页搜索失败」，先按
指南第 3 步检查 `web-search-deepseek.baseURL` / `$DEEPSEEK_SEARCH_BASE_URL`，不要改本插件源码。

## 四、本版实际改动（依赖、测试与文档，无源码）

### 4.1 依赖栈：整块跟到 rc.5

- `pnpm-workspace.yaml`：`overrides` 的 25 条 `dsh-*` 由 `0.2.2-rc.3` 整块换成
  `0.2.2-rc.5`；基线注释同步。`cordis 4.1.0`、`schemastery 3.19.0`、`pi-ai 1.3.0`
  三个钉保持不动（rc.5 仍声明 `^1.3.0`，已核对）。
- `pnpm install --no-frozen-lockfile` 重生成 lockfile：rc.3 残留 **0** 条，rc.5 命中 186 条。
- 逐条可解析性：25 条 override 全部解析到 rc.5（`pnpm install` 输出逐条确认）；
  没有 `dsh-invariants` 那种「指向从未发布版本、lockfile 里也不出现」的死条目。
- `package.json` 的 peer/devDeps 范围**不改**：`>=0.1.7-rc.1 <0.3.0-0` 已放行 rc.5。

### 4.2 结清 rc.3 §5.1 的偶发超时

[`DSH-0.2.2-RC3-FOLLOWUP.md`](DSH-0.2.2-RC3-FOLLOWUP.md) §5.1 记录：
`tests/pool-e2e.spec.ts` 的 `waitFor` 在全量并行下偶发超时（10s 预算），原因是自动签到
那个一次性 `setTimeout` 在 8 个 worker 争抢 CPU 时被饿到，而单跑必过、一度怀疑是跨用例
状态污染又被否证。本版按该文档给出的第二个方案处理：把预算从 10s 放宽到与
`vitest.config.ts` 的 `testTimeout`（30s）一致，并在函数注释里写明原因。

这是**上限**而非固定等待：健康的 tick 仍约 25ms 就返回；真正坏掉的轮询依旧会失败，
只是晚 20s 才失败。没有改动被测代码、没有改动断言语义，所以不需要「故意改坏再验红」的
变异验证——这里改的是测试的等待预算，不是防护逻辑。本轮跑了一次完整 `pnpm run check`
（含该用例所在的全量并行测试），全绿、未再超时；但没有反复多跑，因此只能说「这一次没复现」，
不能据此断言偶发已经根治——若后续 CI 仍偶发，下一步应按 rc.3 §5.1 的另一方案把它挪到独立文件。

### 4.3 文档

- 新增本文档。
- 两份 README 的「受支持的宿主范围」把 rc.4 / rc.5 并入实测行。
- `CHANGELOG.md` 记 5.25.0 的依据。
- `RELEASING.md` §2.6 的示例版本号由 `0.2.2-rc.3` 改为 `0.2.2-rc.5`。

## 五、测试与验收

| 组合 | typecheck | 测试 |
| --- | --- | --- |
| `0.2.2-rc.5` + pi-ai `1.3.0`（**宿主真实组合，本轮基线**） | 0 error | 215 文件 / 3725 通过 / 2 跳过 |

`pnpm run check`（typecheck → build → check:pii → test）整体退出码 0。
`node scripts/check-pii.mjs`：扫描 472 文件（其中 31 个随包发布），**clean**。
`pnpm run build` 的 6 项声明产物齐全。

## 六、结论与后续

1. **rc.5 没有新增需要适配的宿主破坏面**：两份升级指南的两条变更都落在宿主自己的路由上，
   本插件的路由与失败分类与它们正交。本版不改一行源码。
2. **`CONTENT_REFUSED` 与搜索默认都已逐面核对并登记**：前者不需要分支（§3.2），
   后者不满足触发条件（§3.3）；两者都留下了「将来若报告相关问题先看哪里」的线索。
3. **依赖基线整块跟到 rc.5，lockfile 零残留、override 零死条目**。
4. **rc.3 留下的偶发超时已按文档方案结清**（§4.2）。
5. **下一道围栏仍是 `0.3.0-0`**：rc.5 在声明范围内，0.3.0 线仍被明确挡住。
6. **复核路径不变**：下次宿主升级仍按 `RELEASING.md` §2.6 走 —— 先跑闸门实算，再逐份读
   新增的升级指南，逐包比对直接依赖有没有动，最后核对 overrides 每条都能解析。
