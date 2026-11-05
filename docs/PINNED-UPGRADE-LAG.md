# 【置顶】更新请走命令或让 AI 做：插件市场会滞后，`latest` 才是准的

> 长期置顶，**只讲一件事**：怎么把本插件升到**当前真实最新版**。
>
> 一句话：**别拿插件市场里那个「最新」当答案**——它读的是一份会落后的索引；以 npm 的 `latest` 和仓库 Release 为准。
> 手动跑一条命令，或者把下面那段话直接丢给 DSH 里的 AI，让它替你跑。

## 0. 现在的最新版本

> **版本状态与发布节奏请看 [#192](https://github.com/dingminhua/dsh-connect-workbuddy/issues/192)**（那边随发布更新）。本节只留判断口径与一张最小对照表，**发新包时优先改 #192**。

| 事实 | 值 | 采集时间 |
|---|---|---|
| npm `latest` | **5.18.2** | 2026-11-05 +08:00 |
| 5.18.2 发布时间 | 2026-11-05（见 registry `time`） | 同上 |
| 此前一版 | 5.18.1，2026-11-04 18:53 UTC | 同上 |
| 再此前 | 5.17.0，2026-11-01 04:44 UTC | 同上 |
| GitHub Releases | [v5.18.2](https://github.com/dingminhua/dsh-connect-workbuddy/releases/tag/v5.18.2)（Latest） | 同上 |
| **5.18.0** | **从未上架**——发布当天账号进入 72 小时只读冻结，该版本号被跳过，内容并入 5.18.1 | 同上 |
| **市场索引里的本插件** | **本次未核对**（原因见下） | 同上 |

> **⚠️ 5.18.2 有破坏性变更**：`workbuddy_draw_image` 的 `size` 变成必填、`image` 收敛成纯数组
> （单图也要写 `["/abs/a.png"]`）。有脚本或 prompt 模板在调生图工具的，升级后要改参数；
> 旧写法现在直接 `INVALID_ARGS`（本地免费、不扣积分）。详见
> [#192](https://github.com/dingminhua/dsh-connect-workbuddy/issues/192) 与 `CHANGELOG.md` 的 5.18.2 一节。

> **为什么「市场索引里是几」这一行这次不用一个数字回答**：社区市场的索引源是**每份 profile 各自配置**的（`dsh-plugin-market` 的 `sources` 是设置项，不是硬编码常量），
> 本机 profile 没有覆盖它，页面接口又要鉴权。**判断该不该升级，永远用 `npm view` 和 Release，不要看市场里的版本号。**

**最低版本要求（按你撞的问题挑，不是随便挑）**：

| 你遇到的 | 至少要升到 |
|---|---|
| 国内区 400 + `code 11128`（「渠道校验」） | **5.14.0**（5.13.1 改了词但漏了 Web GUI 段第二句，#167） |
| 名册里的新模型发不了图（`MODEL_DOES_NOT_SUPPORT_IMAGES`） | **5.14.1**（核验表补 `space-bunny` / `minimax-m3.1-flash`，#175 的表部分） |
| 每次开新对话都要重挑思考强度（如 `deepseek-v4.1-flash` 想固定用 `low`） | **5.15.0**（`defaultThinkingEfforts`，#179） |
| 切换账号后输入框的档位标签从 `low` 跳回 `high` | **5.15.0**（档位默认值不再写死成常量，#179②） |
| 积分读数挨着权限切换器、容易误触 | **5.15.1**（改挂 `conversation.input.right`） |
| 暗色主题下「虚拟值 / 真实值」选中项是一格空白 | **5.17.0** |
| 弹窗里「真实设备 Token」几乎看不见 / 派生值不显示 | **5.17.0** |
| 状态读取失败永久卡在卡片上 | 5.14.0（#170） |
| `doctor` 把活着的宿主报成 `stale` | 5.14.0（#174①） |
| 鸿蒙上账号池恒为 0；生视频三个故障；想要侧边栏面板；切换账号后档位标签跳回 | **5.18.1** |
| 窄屏下模型行选不到第三档「上下文预算」（#198） | **5.18.1** |
| 生图传多张参考图被静默切成文生图；参数类型写错却照常扣积分（`INVALID_ARGS`） | **5.18.1** |
| 渠道校验报错把「首行不在名单里」说成「网关可能新增了词条」（#213） | **5.18.1** |
| 没什么具体问题 | **直接上 5.18.2**，省得逐条对 |
| 升级 5.18.2 后生图报 `size 必填` / `image 必须是字符串数组` | **不是坏了，是破坏性变更**——改写成 `size: "1024x1024"` 与 `image: ["/abs/a.png"]` |

## 1. 为什么市场里的版本会滞后

三个**互相独立**的环节，任何一个都能让你「点了更新却没升上去」：

| # | 环节 | 它读到的是什么 | 后果 |
|---|---|---|---|
| ① | **社区市场索引**（CDN 上的 `catalog.json` / `index.json`） | 一份**定期构建的快照**，按包各自收录 | 快照里没有的版本，市场根本不会展示。2026-10-30 15:00 那次观测里本插件停在 5.13.1，而当时 npm 已是 5.14.1 |
| ② | **DSH 市场自己的「检查更新」** | npm 的 `latest` dist-tag，30 分钟缓存；桌面宿主还会把 24 小时内发布的版本标成「新版等待中」 | 版本对，但**按钮是灰的/标签是等待中**，看起来像「没有新版」 |
| ③ | **pnpm 的新版本等待期**（`minimumReleaseAge`） | profile 的 pnpm 配置 | 浮动范围被**静默压回旧版**；写死精确版本号则直接报错拒绝 |

> **③这条现在正好在一个窗口里**：`5.18.2` 发布于 2026-11-05（北京时间下午），
> `5.18.1` 发布于 2026-11-04 18:53 UTC —— 两者的 24 小时窗口分别延伸到 11-06 / 11-05 的对应时刻。
> 在此之前，配了 `minimumReleaseAge` 的 profile 会拒绝浮动范围、也可能拒绝精确版本号。
> 实测过两种形态（隔离目录、pnpm 10.34.5、`--lockfile-only`，未触碰任何人的环境）：
>
> | 写法 | 设了 `minimumReleaseAge=1440` 的结果 |
> |---|---|
> | 浮动 `^5.17.0` | 解析到旧版本，不报错 ⚠️（「升级成功了，版本没变」） |
> | 精确 `5.18.2` | `ERR_PNPM_NO_MATURE_MATCHING_VERSION`（明确拒绝，反而好判断） |
> | 不设该配置（pnpm 默认） | 浮动范围直接解析到最新版 ✅ |
>
> 也就是说：**窗口一旦被配置，浮动范围会骗你，精确版本号不会**——它会如实报错，而不是假装成功。
> 本机 `desktop` profile 的 `pnpm-workspace.yaml` **没有**设这条（2026-11-02 03:11 复核：只有 `packages` / `nodeLinker: hoisted` / `autoInstallPeers: false`），
> 所以在本机上不会撞到；这一条对**自行加过该配置**的人仍然成立。

> **①这一条要按「按包各自发生」来理解**：滞后不是全局开关。同一天里有的包索引里是新的、有的还是旧的，
> 所以**「别人那个包显示了新版」不能证明「你这个包也该显示」**——快照收录到哪一天就是哪一天。

## 2. 手动更新（推荐先试这个）

把 `desktop` 换成你用的 profile（`web` / `dsh-tui`）：

```sh
# 1) 装精确版本号（不要用 ^ 或 latest，理由见 §1）
dsh plugin --profile desktop add dsh-connect-workbuddy@5.18.2

# 2) 确认真的装上去了（见 §4，别凭感觉）
dsh plugin --profile desktop exec dsh-connect-workbuddy doctor
```

**如果命令报 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`**：那是 pnpm 的等待期在拦，不是包装坏了。两条路，选一条：

```sh
# A) 等窗口过去（默认 24 小时，从该版本发布时刻算）
#    5.18.2 发布于 2026-11-05 → 窗口约在 2026-11-06 同一时刻结束（以 registry 的 time 为准）

# B) 现在就装：告诉 pnpm 这个包不必等（写进 profile 的 pnpm-workspace.yaml）
minimumReleaseAgeExclude:
  - dsh-connect-workbuddy
```

**如果市场里显示「新版等待中」**：同上，②的 24 小时判断，等窗口过去，或直接用 §2 的命令装。

**如果你是 `link:` 本地目录装的（本仓库开发者）**：`add` 会把 `link:` 改写成 registry 规格，别那么干。更新 = `git pull` + `pnpm run build`。

## 3. 让 AI 更新（懒人路线，效果一样）

在 DSH 里新开一句话，把下面这段**整段**发给 AI：

```text
把 dsh-connect-workbuddy 更新到 npm 上的最新版，按下面的步骤来，不要跳步：
1) 先跑 `npm view dsh-connect-workbuddy version` 确认当前 latest 是多少；
2) 用精确版本号安装：`dsh plugin --profile desktop add dsh-connect-workbuddy@<上一步得到的版本>`；
3) 如果报 ERR_PNPM_NO_MATURE_MATCHING_VERSION，不要改用浮动范围硬装（那会静默装回旧版），
   告诉我这个版本还要等多久，或者问我是否要在 profile 的 pnpm-workspace.yaml 里加
   minimumReleaseAgeExclude: dsh-connect-workbuddy；
4) 装完跑 `dsh plugin --profile desktop exec dsh-connect-workbuddy doctor`，
   把第一行的版本号念给我听；
5) 提醒我重启/重载 DSH（bundle 的 host 半边在启动时加载）。
我的 profile 是 desktop。
```

> AI 能做的和不能做的：**能**跑命令、读版本、核对结果；**不能**替你决定要不要改 pnpm 配置，所以第 3 步它会回来问你。
> 也别让 AI「反复重试到成功」——等待期内重试只会得到同一个拒绝，`pnpm` 没有任何一次性的绕过开关。

## 4. 怎么确认真的升上去了（这一节纠正两条旧口径）

```sh
# 第一行就是版本：WorkBuddy Connect 5.18.2 on vX.Y.Z
dsh plugin --profile desktop exec dsh-connect-workbuddy doctor

# 或者看 JSON 顶层的 version 字段
dsh plugin --profile desktop exec dsh-connect-workbuddy status --json
```

> ⚠️ **两条以前置顶帖里写过的自查方式并不存在，以此处为准**：
>
> | 旧写法 | 实际 |
> |---|---|
> | `/workbuddy status` | 插件注册的斜杠命令是 **`/codebuddy`**（转发本机 CodeBuddy CLI），不是 `/workbuddy`。状态请用上面的 `exec ... doctor` / `status` |
> | 「卡片『诊断』栏看 `pluginVersion`」 | 卡片诊断栏只有区域 / 域名 / 服务账号 / 登录有效期 / 目录模型数 / 已启用数 / 账号池 / 最近一次失败**八行**，**没有版本号这一行**。版本只在 CLI 输出里 |

**装完要不要重启？** 要。bundle 的 host 半边在 DSH 启动时加载。一条实测的例外（#164）：同一个宿主进程内 `remove_bundle` → `install_bundle` 之后 `pluginVersion` 就已经变成新版，不必重启——但那是「重载过了」，不是「不用重载」。**重启或重载完再判断有没有修好。**

## 5. 更新后还是老样子？先排除这三种

1. **版本根本没变** → 回 §4 核对。浮动范围被压回旧版是最常见的一种，症状恰好是「升级命令跑完了、问题照旧」。
2. **装上了但没重载** → 请求组装路径上的改动（比如 11128 的按句改词）在挂载时采样，不重载就还是旧行为。
3. **真的是新问题** → 报的时候**一定带版本号**（§4 第一条命令的第一行）、profile、安装方式（市场 / 命令 / `link:` 本地目录），以及完整报错原文（含 `code` 与 `requestId`）。缺版本号的报告无法判断是不是已经修过的问题。

## 6. 相关置顶

- [#192](https://github.com/dingminhua/dsh-connect-workbuddy/issues/192) — **当前版本状态与发布节奏**（npm 上是几、这一版修了什么）；本篇只讲「怎么升上来」
- [#162](https://github.com/dingminhua/dsh-connect-workbuddy/issues/162) — 渠道校验 400（`11128`）的处置与改词表；本楼只负责「怎么升上来」
- [#125](https://github.com/dingminhua/dsh-connect-workbuddy/issues/125) — 400 / 上游失败分类总表与报告模板
- [#156](https://github.com/dingminhua/dsh-connect-workbuddy/issues/156) — WorkBuddy 用不了时的姊妹插件（Trae / Qoder）

---

**一句话收尾**：市场里显示几就是几，那是快照；`npm view dsh-connect-workbuddy version` 与 [Releases](https://github.com/dingminhua/dsh-connect-workbuddy/releases) 才是准的。升的时候**写精确版本号**，升完**用 `doctor` 第一行核对**，然后**重启或重载**。不想记这些，就把 §3 那段话丢给 AI。
