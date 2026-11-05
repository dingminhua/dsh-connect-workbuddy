# 【置顶】当前版本：npm `latest` 是 **5.18.2**（2026-11-05 上架）

> **一句话**：`5.18.2` 是**有破坏性变更**的一版 —— `workbuddy_draw_image` 的 `size` 变成必填、
> `image` 收敛成纯数组。升级前先看「破坏性变更」那一节，别只按老习惯装完就走。
>
> `5.18.0` 那一版从未在 npm 上存在过（当时账号被安全冻结，包没发出去），所以版本号从 5.17.0
> 直接跳到 5.18.1、再到现在的 5.18.2 —— 那不是漏发。
>
> 升级命令（**写精确版本号**，原因见「怎么升级」）：
>
> ```sh
> dsh plugin --profile desktop add dsh-connect-workbuddy@5.18.2
> ```

## 现在的状态

| 渠道 | 值 | 说明 |
| --- | --- | --- |
| npm `dsh-connect-workbuddy` | **5.18.2** | `latest`，发布于 2026-11-05（见下方发布时间） |
| 前一版 | 5.18.1 | 发布于 2026-11-04 18:53 UTC（北京时间 11-05 02:53） |
| GitHub Releases | v5.18.2 | 与本版同时创建 |
| git tag `v5.18.2` | `2c25e45` | 版本 bump 提交，tag 与 npm 上的包同源 |
| git tag `v5.18.0` | `06006e4` | 代码仍在历史里，但**这个版本从未发布到 npm** |
| 市场索引里的本插件 | 未核对 | 市场读的是会滞后的快照，判断口径永远是 `npm view` |

## ⚠️ 破坏性变更：生图工具的两个参数（5.18.2）

来自 PR [#217](https://github.com/dingminhua/dsh-connect-workbuddy/pull/217)（感谢 @eghrhegpe）。
如果你有脚本、prompt 模板或别的工具在调 `workbuddy_draw_image`，这两处要改：

| 参数 | 以前 | 现在 | 旧写法会怎样 |
| --- | --- | --- | --- |
| `size` | 可选，不填默认 `1024x1024` | **必填**，写「宽x高」或 `auto` | 不填直接 `INVALID_ARGS`，不再悄悄出方图 |
| `image` | `string \| array` 都收 | **纯数组**，单图也要写 `["/abs/a.png"]` | `image: "a.png"` 直接 `INVALID_ARGS` |

**为什么改**：不填尺寸时模型学会了「什么都不写、让它自己猜」，用户要竖版壁纸也出方图，还看不出
是哪一步丢的；`image` 的联合类型在只认单 type 的 function-calling 上游会被压平或丢掉，
参考图被静默丢弃后工具静默切回文生图，出的图和 prompt 毫无关系、积分照扣。
现在这两类路径都在**发请求之前**以 `INVALID_ARGS` 拦下（本地免费、不扣积分）。

**这一版还做了什么**（都是围绕「让模型能一次填对参数」）：

- `size` 越界不再报错：`fitIntoRange()` 按「长边 2560」与「面积 ≤ 4,194,304」中更严的约束
  等比缩放，改动写进 `hint` 并用 `requestedSize` 回带原值。
- 改图写 `size: "auto"`：工具自己解析 PNG / JPEG / GIF / WEBP 头拿到第一张输入图的宽高，
  按同比例定画布，模型不必知道原图尺寸。
- 视频工具补 `rejectUnknownArgs()`：`size` / `ratio` / `n` / `return_base64` 这类从别的生图
  工具串进来的字段一律 `INVALID_ARGS`，不再静默忽略让模型以为横竖版生效了。
- 输出 schema 把 `region` 与 `size` 列进 `required`，报价与后处理不用靠运气。
- 工具描述整段重写成「画什么 / 花多少 / 走哪个区 / size 怎么填」四段问答，`size` 写成
  八阶优先级链（具体像素 → 比例词 → 档位词 → 改图 auto → 用途 → 表外比例 → 只提方向 → 默认档），
  命中即停；删掉硬编码的两区模型 id 与「不要做什么」的否定清单。
- `tests/image-gen.spec.ts` 从 62 条涨到 104 条。完整打磨记录见 `CHANGELOG.md` 的 5.18.2 一节。

> **视频工具不受影响**：`workbuddy_draw_video` 的 `image` 仍是字符串或单元素字符串数组、
> 只收一张，与生图的「纯数组、可多张」不同。

## 从 5.17.0 升上来的人

`5.18.1` 已经把 `5.18.0` 与之后 30 个提交一起发过一次，所以你一次拿到的是三版的全部内容：

- **来自 5.18.0**：可选侧边栏面板（#188，默认关）、鸿蒙上检测不到桌面账号（#190）、
  生视频三个独立故障（#187）、真实设备 SDK 总开关（默认关）。
- **来自 5.18.1**：生图多图参考、错型参数不再静默降级、#198 窄屏第三档上下文预算被裁、
  #199 权限加固锁死用户、#208 ACL 抹掉 `$DSH_HOME`、#207 DSML 恢复三处失效、
  #191 每日自动签到（默认关）、积分面板「刷新 / 设置」、#212 / #215 / #214 / #213 / #193 / #195
  等一批修复。
- **来自 5.18.2**：上面那两处破坏性变更与工具契约重写。

升级不会动你已有的账号池、模型勾选、积分设置、思考强度默认值。

## 怎么升级

```sh
dsh plugin --profile desktop remove dsh-connect-workbuddy   # 之前自己编译 / link 装过的先移除
dsh plugin --profile desktop add dsh-connect-workbuddy@5.18.2
```

**写精确版本号，别用 `^` 或 `latest`**：如果你的 profile 配了 pnpm 的 `minimumReleaseAge`（新版本等待期），浮动范围会被**静默压回旧版**，症状恰好是「升级命令跑完了、版本没变」；写死精确版本号则会明确报 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`，反而好判断。要立刻装就在 profile 的 `pnpm-workspace.yaml` 里加 `minimumReleaseAgeExclude: [dsh-connect-workbuddy]`。

一直用 npm 版、没自己编译过的，**不需要 `remove`**，直接 `add` 即可（`add` 到已存在的包名就是升级）。

装完请**重启或重载 DSH**（bundle 的 host 半边在启动时加载），并留意生图工具的参数契约变了。

## 怎么确认自己到底是哪个版本

```sh
dsh plugin --profile desktop exec dsh-connect-workbuddy doctor
# 第一行：WorkBuddy Connect <版本号> on v<node 版本>
```

> 两个以前写过的自查方式**并不存在**，别再用了：插件注册的斜杠命令是 `/codebuddy`（转发本机 CodeBuddy CLI），不是 `/workbuddy`；卡片的「诊断」栏也没有版本号这一行。版本只在 CLI 输出里。

## 常见问题

**Q：我还停在 `5.17.0` / `5.18.1`，必须升吗？**
没有「必须升」的硬理由：这一版没有安全修复。但如果你是**模型自主生图**的重度用户，5.18.2 值得升——
它专门修的就是「模型乱填参数、静默出错图还扣积分」这一族问题。你撞到下面任一条更该升：
鸿蒙上账号池为空（#190）、生视频三个故障（#187）、想用侧边栏面板（#188）、
窄屏选不到第三档上下文预算（#198）、生图想传多张参考图、被「参数类型写错却照常扣积分」坑过。

**Q：升级后生图工具报错 `size 必填` / `image 必须是字符串数组`，是不是坏了？**
不是，是 5.18.2 的破坏性变更生效了。把调用改成 `size: "1024x1024"`（或按工具描述选档）、
`image: ["/abs/a.png"]` 即可。写 `size: "auto"` 可以让工具按输入图比例自己定画布（仅改图、需给 `image`）。

**Q：`5.18.0` 那个 tag 还有用吗？**
只作为历史参照点。它对应的代码已经在 `5.18.1` 里，**不要**再按旧文档从那个 tag 自己编译——那时还缺 #199 / #198 / #213 等一批修复。

**Q：为什么不在插件市场里更新？**
市场索引是一份会滞后的快照，桌面宿主还会把发布 24 小时内的版本标成「新版等待中」。判断标准永远只有 `npm view dsh-connect-workbuddy version` 与 [Releases](https://github.com/dingminhua/dsh-connect-workbuddy/releases)。

**Q：我在鸿蒙上，账号池是空的。**
升到 5.18.2。临时绕过（不升级时）：设环境变量 `WORKBUDDY_AUTH_FILE`（或 `WORKBUDDY_USER_HOME`）指向你机器上真实的那份 `workbuddy-desktop.info`。

**Q：`doctor` 说 SDK 是 `ready`，但界面里说没取过 token。**
真实设备 SDK 现在是**默认关**的。要真实设备值，先在卡片「SDK」页把「启用真实设备 SDK」打开。macOS 上「真实值」这一档本身是禁用的（它要 dispatch_sync 到主队列，会和宿主互相等死），卡片上会写明原因。

## English summary

**Current installable version: `5.18.2`.** This is a **breaking change**: `workbuddy_draw_image` now requires `size`, and `image` must be an array (`["/abs/a.png"]` even for a single image). Old forms fail with `INVALID_ARGS` before any request is sent — silently wrong images that still cost credits are no longer possible. The tool also gained automatic size fitting, `size: "auto"` for edits (parses PNG/JPEG/GIF/WEBP dimensions), unknown-argument rejection for the video tool, and a rewritten decision-chain description. See PR [#217](https://github.com/dingminhua/dsh-connect-workbuddy/pull/217).

`5.18.0` never reached npm — the account was in a 72-hour read-only security suspension, so that number was skipped. `5.18.1` carried everything from the never-published `5.18.0` plus 30 subsequent commits (optional sidebar panel, HarmonyOS credential detection, three video-generation fixes, strict argument types, and many fixes).

Install with an exact version (a floating range can be silently pinned back by pnpm's `minimumReleaseAge`):

```sh
dsh plugin --profile desktop add dsh-connect-workbuddy@5.18.2
```

Restart or reload DSH afterwards, and update any script or prompt template that calls `workbuddy_draw_image`.
