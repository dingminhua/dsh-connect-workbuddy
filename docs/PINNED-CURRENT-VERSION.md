# 【置顶】当前版本：npm `latest` 是 **5.18.1**（2026-11-05 02:53 +08:00 上架）

> **一句话**：`5.18.0` 与 `5.18.1` 的内容已经**合并成 5.18.1** 发布。`5.18.0` 那一版从未在 npm 上存在过
> （当时账号被安全冻结，包没发出去），所以你会看到版本号从 5.17.0 直接跳到 5.18.1 —— 那不是漏发，是跳过了那个从未上架的号。
>
> 升级只需一条命令（**写精确版本号**，原因见「怎么升级」）：
>
> ```sh
> dsh plugin --profile desktop add dsh-connect-workbuddy@5.18.1
> ```

## 现在的状态

| 渠道 | 值 | 说明 |
| --- | --- | --- |
| npm `dsh-connect-workbuddy` | **5.18.1** | `latest`，发布于 2026-11-04 18:53 UTC（北京时间 11-05 02:53） |
| 前一版 | 5.17.0 | 发布于 2026-11-01 04:44 UTC |
| GitHub Releases | v5.18.1 | 与本版同时创建 |
| git tag `v5.18.1` | `2b9d457` | 版本 bump 提交，tag 与 npm 上的包同源 |
| git tag `v5.18.0` | `06006e4` | 代码仍在历史里，但**这个版本从未发布到 npm** |
| 市场索引里的本插件 | 未核对 | 市场读的是会滞后的快照，判断口径永远是 `npm view` |

## 为什么版本号跳过了 5.18.0

`5.18.0` 的代码 11 月 2 日就并进 `main`、tag 也推了，但发布当天用了**恢复码**登录 npm，
触发了官方的预防性冻结：账号进入 **72 小时只读**（不能发布、不能改包设置），冻结期到
**2026-11-04 18:43 UTC**（北京时间 11-05 02:43）。冻结期间 `npm publish` 表现为
`PUT 403 ... temporarily suspended`，包一个字节都没上传。

冻结解除后重发，为了不和「可能存在过的暂存版本」纠缠，直接取了 `5.18.1`，
并在 `CHANGELOG.md` 的 5.18.1 一节写明「本版包含 5.18.0 一节的全部内容」。
从 5.17.0 升上来，拿到的是两版的全部东西。

## 这一版里有什么

### 来自 5.18.0

1. **侧边栏面板（#188，新功能，默认关）**：卡片「能力」栏多一行「在侧边栏显示 WorkBuddy」。勾上后侧边栏多一个 WorkBuddy 行，点开是同一张卡片的**整页版**（账号表格、模型目录、诊断原文都摊到整栏，页头带「返回会话」）。**不勾就升级，侧边栏一行都不会多** —— 这一行占的是所有插件共用的全局侧边栏座位。
2. **鸿蒙（HarmonyOS）上检测不到桌面账号（#190，修）**：`defaultDesktopAuthDirs()` 原来只有 darwin / win32 / linux 三个分支，鸿蒙的 `process.platform` 是 `"openharmony"`，候选路径为空 → 账号池恒为 0。现在补上固定挂载点（可用 `WORKBUDDY_USER_HOME` 覆盖），顺带给 Linux 加了 `$XDG_DATA_HOME` 候选（只做加法）。
3. **生视频三个独立故障（#187，修）**：http(s) 输入改为 GET 下载后编码成 data URI（COS 签名只覆盖 GET，旧实现的 HEAD 探活必然 403）；内部超时预算收紧到**严格早于宿主工具上限**，超时后能拿到带 task id 的结构化报错；上游 `failed` 时带出原始字段。
4. **真实设备 SDK 有了总开关（行为变更，默认关）**：此前无条件启动预热链（每 10 分钟起一次子进程取设备 token），哪怕你只用「虚拟值」档、这个 token 一次都不发。现在默认关：不发现目录、不起子进程、不预热。

### 5.18.1 新增的修复

- **生图多图参考**：`image` 传数组不再被当成「没给图」而静默切回文生图；数组逐项校验，混入非字符串 / 空串一律 `INVALID_ARGS`。
- **错型参数不再静默降级**：`seconds: "10"`、`model: [...]`、`image: 123` 这类以前会被当成「没填」、用默认值跑完还照扣积分的形态，现在直接 `INVALID_ARGS` 且**不发请求**；生视频只收一张输入图，两张及以上明确拒绝。
- **#198**：窄屏下模型行第三档「上下文预算」被裁掉、只能选到 200K / 500K。
- **#199**：权限加固把用户锁在自己凭据库外（修复来自社区 PR #200 by @yunyu-lu）。
- **#208**：同类加固路径会把 `$DSH_HOME` 自己的继承权限抹掉，导致附件目录读不了。
- **#207**：DSML 恢复的三处失效（`calls` 缩写永不配对、孤立闭标签进不了清理、原生调用后文本不再清洗）。
- **#191**：国内版账号池可选「每日自动签到」（新增，默认关）。
- **积分面板**：头部加「刷新」与「设置」，「一键测试」改名为「刷新」（它确实会花积分）；**#212** 两个开关的样式统一。
- **#215**：预算单选框按后端实际窗口选中，选「原生」即删除预算。
- **#214**：国际版兜底表不再声称价格，`models/refresh` 立刻落盘并生效。
- **#213**：渠道校验报错不再说「网关可能新增了词条」，并把「首行」与「整条消息」分开表述。
- **#193 / #195**：传输失败（status 0）不再落盘为账号测量，探测超时 10 s → 30 s（PR #194 by @Antony232）；另外两条「非账号事件被写成账号测量」的路径一并修掉。
- 默认思考强度：没声明默认档的模型落到自己声明的中档，不再是最弱的一档。

升级不会动你已有的账号池、模型勾选、积分设置、思考强度默认值。

## 怎么升级

```sh
dsh plugin --profile desktop remove dsh-connect-workbuddy   # 之前自己编译 / link 装过的先移除
dsh plugin --profile desktop add dsh-connect-workbuddy@5.18.1
```

**写精确版本号，别用 `^` 或 `latest`**：如果你的 profile 配了 pnpm 的 `minimumReleaseAge`（新版本等待期），浮动范围会被**静默压回旧版**，症状恰好是「升级命令跑完了、版本没变」；写死精确版本号则会明确报 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`，反而好判断。要立刻装就在 profile 的 `pnpm-workspace.yaml` 里加 `minimumReleaseAgeExclude: [dsh-connect-workbuddy]`。

一直用 npm 版、没自己编译过的，**不需要 `remove`**，直接 `add` 即可（`add` 到已存在的包名就是升级）。

## 怎么确认自己到底是哪个版本

```sh
dsh plugin --profile desktop exec dsh-connect-workbuddy doctor
# 第一行：WorkBuddy Connect <版本号> on v<node 版本>
```

> 两个以前写过的自查方式**并不存在**，别再用了：插件注册的斜杠命令是 `/codebuddy`（转发本机 CodeBuddy CLI），不是 `/workbuddy`；卡片的「诊断」栏也没有版本号这一行。版本只在 CLI 输出里。

## 常见问题

**Q：我还停在 `5.17.0`，必须升吗？**
没有「必须升」的硬理由：这一版没有安全修复，全部是功能与体验问题。你撞到下面任一条就该升：鸿蒙上账号池为空（#190）、生视频三个故障（#187）、想用侧边栏面板（#188）、窄屏选不到第三档上下文预算（#198）、生图想传多张参考图（5.18.1）、被「参数类型写错却照常扣积分」坑过（5.18.1）。

**Q：`5.18.0` 那个 tag 还有用吗？**
只作为历史参照点。它对应的代码已经在 `5.18.1` 里，**不要**再按旧文档从那个 tag 自己编译——那时还缺 #199 / #198 / #213 等一批修复。

**Q：为什么不在插件市场里更新？**
市场索引是一份会滞后的快照，桌面宿主还会把发布 24 小时内的版本标成「新版等待中」。判断标准永远只有 `npm view dsh-connect-workbuddy version` 与 [Releases](https://github.com/dingminhua/dsh-connect-workbuddy/releases)。

**Q：我在鸿蒙上，账号池是空的。**
升到 5.18.1。临时绕过（不升级时）：设环境变量 `WORKBUDDY_AUTH_FILE`（或 `WORKBUDDY_USER_HOME`）指向你机器上真实的那份 `workbuddy-desktop.info`。

**Q：`doctor` 说 SDK 是 `ready`，但界面里说没取过 token。**
真实设备 SDK 现在是**默认关**的。要真实设备值，先在卡片「SDK」页把「启用真实设备 SDK」打开。macOS 上「真实值」这一档本身是禁用的（它要 dispatch_sync 到主队列，会和宿主互相等死），卡片上会写明原因。

## English summary

**Current installable version: `5.18.1`** (published 2026-11-04 18:53 UTC). `5.18.0` never reached npm — the account was in a 72-hour read-only security suspension, so that number was skipped. `5.18.1` contains everything from the never-published `5.18.0` plus 30 subsequent commits.

Highlights: an **optional sidebar panel** (#188, off by default), **HarmonyOS credential detection** (#190), **three video-generation fixes** (#187), an **off-by-default real-device SDK switch**, **multi-image reference support** for image generation, and **strict argument types** — wrong-typed tool arguments now fail with `INVALID_ARGS` instead of silently falling back to defaults and spending credits.

Install with an exact version (a floating range can be silently pinned back by pnpm's `minimumReleaseAge`):

```sh
dsh plugin --profile desktop add dsh-connect-workbuddy@5.18.1
```
