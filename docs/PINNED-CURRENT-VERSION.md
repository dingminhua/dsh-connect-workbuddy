# 【置顶】当前版本：npm `latest` 是 **5.19.0**（2026-11-06 上架）

> **一句话**：`5.19.0` 是**入口迁移的破坏性变更** —— 配置界面从「插件市场详情页里的卡片」
> 搬到**设置面板左侧导航的独立页面**（设置 → WorkBuddy）。插件市场那一页不再显示这张卡，
> 但也不需要你改任何配置或脚本：所有设置都在，只是换了个门。
>
> 同一版把插件详情页**恢复成渲染完整 README**（撤销 5.18.3 的 100 字短文档），并修了四处
> 「内容第一次被放进 564px 窄栏」才显形的布局缺陷，其中一条是 issue #209 的壁纸透明底问题。
>
> 5.18.2 的两处生图参数破坏性变更（`size` 必填、`image` 纯数组）**依然有效**，见下面那一节。
>
> `5.18.0` 那一版从未在 npm 上存在过（当时账号被安全冻结，包没发出去），所以版本号从 5.17.0
> 直接跳到 5.18.1、5.18.2、5.18.3、再到现在的 5.19.0 —— 那不是漏发。
>
> 升级命令（**写精确版本号**，原因见「怎么升级」）：
>
> ```sh
> dsh plugin --profile desktop add dsh-connect-workbuddy@5.19.0
> ```

## 现在的状态

| 渠道 | 值 | 说明 |
| --- | --- | --- |
| npm `dsh-connect-workbuddy` | **5.19.0** | `latest`，发布于 2026-11-05 21:49 UTC（北京时间 11-06 05:49） |
| 前一版 | 5.18.3 | 发布于 2026-11-05（插件详情页改用短文档，本版已撤销） |
| GitHub Releases | v5.19.0 | 与本版同时创建 |
| git tag `v5.19.0` | `c1a3f27` | 与 npm 上的包同源 |
| git tag `v5.18.3` | `e5ab115` | 版本 bump 提交 |
| git tag `v5.18.2` | `2c25e45` | 版本 bump 提交 |
| git tag `v5.18.0` | `06006e4` | 代码仍在历史里，但**这个版本从未发布到 npm** |
| 市场索引里的本插件 | 未核对 | 市场读的是会滞后的快照，判断口径永远是 `npm view` |

## 这一版改了什么（5.19.0）

### 入口：配置从插件详情页搬进设置面板

配置界面现在注册在宿主的 `settings.section` 槽位，与「账号与余额 / 通用设置 / 模型 / 插件」
并列，位置 `order: 35`（内置页 20 之后、插件市场 40 之前）。插件详情页现在只回答「这是什么」，
不再兼任一整页配置。

顺带消掉一整类缺陷：旧入口是 keyed 槽位，宿主拿 inventory 的 `pkg.name` 做**精确字符串相等**
比较，部署完全可以把同一份代码挂在 `include:` 前缀的 Loader entry id 下，于是 key 对不上就
什么都不渲染、也不报错（issue #55）。新槽位由本插件自己的 id 索引，没有别人的名字要对齐。

### 插件详情页恢复完整 README

`locale/*.json` 的 `meta.detail`、两份 `docs/DETAIL*.md` 与 4 条守卫单测全部移除。
理由：`meta.detail` 依赖「路径正确 + 语言链命中」这类隐式约定，失败时静默回落到 README、
界面看不出问题，而它唯一的作用只是缩短显示文本。**`locale/` 目录保留**——它还承担市场卡片的
标题与描述。

### 四处窄栏布局缺陷

都不是新代码写坏的，而是同一份内容第一次被放进 564px 宽的列之后才显形（旧入口从不窄于 ~800px）：

1. **账号表被压成 2×2**：断点原是 `@media(max-width:760px)`，量的是**视口**；设置面板里视口
   1400px、内容列 564px，那个分支永不成立。改成 `container-type` + `@container` 量表格自身，
   窄形态从「重新分栏」改成堆叠成卡片。
2. **模型名被自己的徽章吃掉**：徽章都是 `flex:none`，唯一能收缩的就是名字（`GLM-5.` 后面什么都
   不剩）。给名字 9em 下限并独占伸缩权，徽章行内换行；模型区头部加 `flex-wrap`。
3. **壁纸下整片内容压在图片上（issue #209）**：内容区与页头都没有自己的底色，外壳的列在壁纸
   主题下是半透明的。补一层外壳 layer 色，实底主题上看不出差别。
4. **两处双重留白**：`.dsm-workbuddy-usage` 已有 `gap`，标签栏、面板、账号池又各自加了边距，
   叠出 32px 与 44px 两条空带。归零，让 `gap` 成为唯一间距来源。

### 文案位置

「免费模型并非无限量」跟着区域说明走 —— 两句回答的是同一个问题，原本被分栏和一条分割线隔开。

### 历史记录：5.18.3 的短文档机制（本版已撤销）

5.18.3 曾给 `locale/*.json` 补 `meta.detail`，指向两份 ≤100 字符的 Markdown，让插件详情页
显示一段短简介而不是整篇 README（本仓库 README 有 748 行）。5.19.0 把这套机制整体移除：
设置页接管配置之后，详情页只剩「这是什么」，正文本身就是回答，缩短它反而把唯一的内容删掉了；
而 `meta.detail` 依赖「路径与语言链同时正确」这类隐式约定，失败时静默回落、界面看不出问题。

[`docs/PLUGIN-DETAIL-GUIDE.md`](PLUGIN-DETAIL-GUIDE.md) 保留 —— 它讲的是宿主机制，对其他插件
作者仍然有效，开头已注明本插件不再使用。

## ⚠️ 生图工具的两个参数（5.18.2 的破坏性变更，5.19.0 仍沿用）

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
- **来自 5.18.3**：插件详情页曾改用短文档（**5.19.0 已撤销**，恢复整篇 README）。
- **来自 5.19.0**：配置入口搬进「设置 → WorkBuddy」（**破坏性：入口位置变了**）、插件详情页恢复完整 README、
  四处窄栏布局缺陷（账号表栅格、模型名被徽章挤掉、issue #209 壁纸透明底、两处双重留白）。

升级不会动你已有的账号池、模型勾选、积分设置、思考强度默认值。

## 怎么升级

```sh
dsh plugin --profile desktop remove dsh-connect-workbuddy   # 之前自己编译 / link 装过的先移除
dsh plugin --profile desktop add dsh-connect-workbuddy@5.19.0
```

**写精确版本号，别用 `^` 或 `latest`**：如果你的 profile 配了 pnpm 的 `minimumReleaseAge`（新版本等待期），浮动范围会被**静默压回旧版**，症状恰好是「升级命令跑完了、版本没变」；写死精确版本号则会明确报 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`，反而好判断。要立刻装就在 profile 的 `pnpm-workspace.yaml` 里加 `minimumReleaseAgeExclude: [dsh-connect-workbuddy]`。

一直用 npm 版、没自己编译过的，**不需要 `remove`**，直接 `add` 即可（`add` 到已存在的包名就是升级）。

装完请**重启或重载 DSH**（bundle 的 host 半边在启动时加载；插件的客户端半边也是启动时加载的），并留意 5.18.2 起生图工具的参数契约变了。

## 怎么确认自己到底是哪个版本

```sh
dsh plugin --profile desktop exec dsh-connect-workbuddy doctor
# 第一行：WorkBuddy Connect <版本号> on v<node 版本>
```

> 两个以前写过的自查方式**并不存在**，别再用了：插件注册的斜杠命令是 `/codebuddy`（转发本机 CodeBuddy CLI），不是 `/workbuddy`；卡片的「诊断」栏也没有版本号这一行。版本只在 CLI 输出里。

## 常见问题

**Q：我还停在 `5.17.0` / `5.18.1` / `5.18.2` / `5.18.3`，必须升吗？**
没有安全修复，所以不存在「必须」。但 **5.19.0 之后配置的位置变了**：设置 → WorkBuddy，
插件市场那一页不再有配置卡片。如果你装了带自定义壁纸的主题（issue #209），或把面板宽度调窄过，
这一版修的就是那两类显示问题。
如果你是**模型自主生图**的重度用户，5.18.2 值得升——
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
升到 5.19.0（修复自 5.18.1 起就有）。临时绕过（不升级时）：设环境变量 `WORKBUDDY_AUTH_FILE`（或 `WORKBUDDY_USER_HOME`）指向你机器上真实的那份 `workbuddy-desktop.info`。

**Q：插件详情页现在显示整篇 README，是不是坏了？**
不是，那是 5.19.0 的预期行为。5.18.3 曾用 `meta.detail` 把它缩短成一段 100 字以内的简介，
5.19.0 撤销了那套机制。升级后请**重启/重载 DSH**：详情页文档由宿主在读取包时取，不重载还是旧值。

**Q：`doctor` 说 SDK 是 `ready`，但界面里说没取过 token。**
真实设备 SDK 现在是**默认关**的。要真实设备值，先在卡片「SDK」页把「启用真实设备 SDK」打开。macOS 上「真实值」这一档本身是禁用的（它要 dispatch_sync 到主队列，会和宿主互相等死），卡片上会写明原因。

## English summary

**Current installable version: `5.19.0`.** 5.18.3 was a **packaging-only, non-breaking change with no new features**: the plugin detail page (DSH 0.2.2+) no longer rendered the whole README — each `locale/*.json` carried a `meta.detail` pointing at a short Markdown document (92 / 96 characters). **5.19.0 reverses that**: those documents and both `meta.detail` lines are gone, and the detail page renders the full README again by host default. The configuration page moved to Settings → WorkBuddy in the same release, so the detail page no longer has a card to show. See `docs/PLUGIN-DETAIL-GUIDE.md` for the mechanism.

The 5.18.2 **breaking change** still applies: `workbuddy_draw_image` requires `size`, and `image` must be an array (`["/abs/a.png"]` even for a single image). Old forms fail with `INVALID_ARGS` before any request is sent. See PR [#217](https://github.com/dingminhua/dsh-connect-workbuddy/pull/217).

`5.18.0` never reached npm — the account was in a 72-hour read-only security suspension, so that number was skipped. `5.18.1` carried everything from the never-published `5.18.0` plus 30 subsequent commits (optional sidebar panel, HarmonyOS credential detection, three video-generation fixes, strict argument types, and many fixes).

Install with an exact version (a floating range can be silently pinned back by pnpm's `minimumReleaseAge`):

```sh
dsh plugin --profile desktop add dsh-connect-workbuddy@5.19.0
```

Restart or reload DSH afterwards (the host loads the plugin's bundles at start-up), and update any script or prompt template that calls `workbuddy_draw_image` (the 5.18.2 contract).
