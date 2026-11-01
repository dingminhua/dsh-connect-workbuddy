# 【置顶】当前版本：npm 上还是 5.17.0，5.18.0 只在 GitHub 上（11 月 5 日才发 npm 包，急用请自己编译）

> **一句话**：代码发完了，**包没发出去**。`npm view dsh-connect-workbuddy version` 现在仍然是 **`5.17.0`**；`5.18.0` 只在 GitHub 的 tag 上（连 Release 都还没建）。下一次能发包是**北京时间 2026-11-05**——我这边 npm 发布凭据失效，得回到能做两步验证的环境。
>
> **不着急的话什么都不用做**，继续用 `5.17.0`。急用的，往下看「自己编译」，那套步骤我在干净的临时目录里从零跑通过一遍。

## 现在的状态

| 渠道 | 版本 | 状态 |
| --- | --- | --- |
| npm `dsh-connect-workbuddy` | **5.17.0** | 最新可安装版本，`dsh plugin add` / 市场拿到的都是它。发布于 2026-11-01 04:44 UTC |
| git tag `v5.18.0` | 5.18.0 | **已推送**，指向提交 `06006e4` |
| GitHub Releases | v5.17.0（Latest） | **没有 v5.18.0 的 Release**，tag 有、Release 没有 |
| npm 5.18.0 | — | **未发布**，等 2026-11-05 |

> ⚠️ 所以「仓库里有 `v5.18.0` 这个 tag」不等于「你能 `npm install` 到 5.18.0」。**看 `npm view` 和 Releases，别看 tag 列表。**

## 为什么现在发不了

本机 npm 发布凭据已失效（直连 registry 与走代理都返回 `401`），重新登录 / 补发要走人工两步验证流程。`npm publish` 在非交互环境里会直接退出，这一步**只能等到 11 月 5 日**。

这不是「暂时不想发」——代码、测试、构建产物、CI（ubuntu + windows）全部就绪，卡住的只有最后那次上传。

## 5.18.0 里有什么

四件事：一个新功能、两条用户报的 bug、一处行为变更。**新功能与那处变更默认都是关的，升级不改变你现有行为。**

1. **侧边栏面板（#188，新功能，默认关）**：卡片「能力」栏多一行「在侧边栏显示 WorkBuddy」。勾上后侧边栏多一个 WorkBuddy 行，点开是同一张卡片的**整页版**（账号表格、模型目录、诊断原文都摊到整栏，页头带「返回会话」）。取消勾选这一行立刻消失，中间栏自动回到对话。**不勾就升级，侧边栏一行都不会多** —— 这一行占的是所有插件共用的全局侧边栏座位，所以要你自己点头。
2. **鸿蒙（HarmonyOS）上检测不到桌面账号（#190，修）**：`defaultDesktopAuthDirs()` 原来只有 darwin / win32 / linux 三个分支，其余平台返回空数组。鸿蒙的 Node 把 `process.platform` 报成 `"openharmony"`，于是候选路径为空 → 账号池恒为 0、模型不出现。现在补上了固定挂载点 `/storage/Users/currentUser/.local/share/CodeBuddyExtension/Data/Public/auth`（可用 `WORKBUDDY_USER_HOME` 覆盖）。顺带给 Linux 加了 `$XDG_DATA_HOME` 候选（**只做加法**，`~/.config` 仍排在前面）。
3. **生视频三个独立故障（#187，修）**：图生视频传 http(s) 链接必然 403（COS 签名只覆盖 GET，而旧实现先发 HEAD 探活，且上游本来就不吃外链 → 现在改成 GET 下载并编码成 data URI，与图生图同一条规则）；`VIDEO_TOOL_TIMEOUT_MS` 从 600 000 降到 570 000、轮询预算 540 000，**内部两层严格早于宿主工具上限**，超时后能拿到带 task id 的结构化报错而不是裸的 `tool call timed out`；上游 `failed` 时把它的原始字段一并带出来（不猜字段名）。
4. **真实设备 SDK 有了总开关（行为变更，默认关）**：此前这项能力无条件启动——插件一挂载就建预热链，每 10 分钟起一次子进程去风控服务取设备 token，**哪怕你只用「虚拟值」档、这个 token 一次都不会发出去**。现在默认关：不发现 SDK 目录、不起子进程、不预热。「虚拟值」档不受影响。

升级不会动你已有的账号池、模型勾选、积分设置、思考强度默认值。

## 急用：自己编译（已实测跑通）

**要求**：Node.js `^22.19.0` 或 `>=24.0.0`（`engines` 写死的，低版本装不上），pnpm 10 或 11 都行，git。我实测用的是 Node 25.9.0 + pnpm 10.34.5 / 11.28.5。

```sh
# 1) 拉 tag（不是 main —— main 会继续往前走）
git clone --depth 1 --branch v5.18.0 https://github.com/dingminhua/dsh-connect-workbuddy.git
cd dsh-connect-workbuddy

# 2) 装依赖。prepare 会自动构建一次，不用另外跑 build
pnpm install --frozen-lockfile
```

`pnpm install` 结束时会打印 `6 declared artifact(s) present` —— `lib/index.js`、`lib/index.d.ts`、`lib/bin.js`、`lib/client.js`、`cordis.patch.yml`、`package.json` 都在。看到这行就说明产物齐了。

**为什么要 build**：`lib/` 是构建产物且被 gitignore，`link:` 安装**不执行**包的生命周期脚本，所以从一份没构建过的检出装进去，DSH 会直接拒绝加载并报「声明的入口产物缺失(源码检出或构建被拦),下次启动会失败」。这个仓库的 `prepare` 已经挂在 `pnpm install` 上，所以上面那条命令就够了；想单独重建用 `pnpm run build`。

```sh
# 3) 先确认这份源码构建出来的东西是对版
node lib/bin.js doctor
# 第一行应该是：WorkBuddy Connect 5.18.0 on v25.9.0
```

### 装进 profile（两种都实测过）

```sh
dsh plugin --profile desktop add /绝对路径/到/dsh-connect-workbuddy
```

`--profile desktop` 换成你自己的 profile 名（默认就是 `desktop`）。`add <本地绝对路径>` 是 **`link:` 安装**：以后改代码重启 DSH 就生效，不重装依赖树。

也可以先打包再装（更接近真实安装，适合验证「装出来的东西能不能跑」）：

```sh
npm pack                                    # 产出 dsh-connect-workbuddy-5.18.0.tgz
dsh plugin --profile desktop add ./dsh-connect-workbuddy-5.18.0.tgz
```

两条路我都用一个一次性 profile 试过，`dsh plugin --profile <你的> exec dsh-connect-workbuddy doctor` 首行都是 `WorkBuddy Connect 5.18.0`。

> **`link:` 安装会打印一堆 `peerDependencies` 警告**，说无法从目标 `node_modules` 解析 peer。这是 pnpm 的固有警告（本插件把一整套 DSH 包声明为 peer，由宿主提供），**不影响运行**。

**装完重启 DSH。** 宿主不会热加载 `lib/`；bundle 的 host 半边在启动时加载。重启后打开「设置 → 插件 → WorkBuddy」，「能力」栏最下面应该能看到那行「在侧边栏显示 WorkBuddy」。

### 校验：你编译出来的和我的一样吗

同一份源码、同一套锁文件，`lib/` 下 6 个构建文件**字节级相同**（我在自己的仓库构建一次，再从 `v5.18.0` 全新 clone 一次构建，逐个比对）：

| 文件 | 字节数 | SHA-256 |
| --- | --- | --- |
| `lib/index.js` | 627,974 | `b38ebd35759dbd553df2941aa639d47ebddf4f3465ac48dfbea58c8cebde8605` |
| `lib/client.js` | 749,570 | `30d1c74b68eae4df885504fa01b5ac598c06f88a85e44dc2385eff6e30ab2d09` |
| `lib/index.d.ts` | 294,431 | `4674cd4e36df0f325549700529dbbac03e5811ba1ffe46840965439f3b86c044` |
| `lib/bin.js` | 36,779 | `d9832d905ca2fa4494a45c6ef3f24cba3026295d037bc542a926c68428d510b4` |
| `lib/bin.d.ts` | 1,061 | `65e244980e5eed0372fb1d15d9292d52df88c5d650c24f2641d470dad044218a` |
| `lib/host-heartbeat-CPpLIZhM.js` | 455,322 | `c0287893e5113ec5dfc471cd6f0eeebf44d533d812f2cb67e5bcc28c1386c63a` |

```sh
shasum -a 256 lib/*.js lib/*.d.ts    # macOS
sha256sum lib/*.js lib/*.d.ts         # Linux
```

> 别拿 `.tgz` 的 sha1 当基准：tar 头里带打包时间戳，同一份内容不同时刻打出来的 sha1 不一样。要校验就校验上面这些文件。

### 两个坑，先说在前面

- **别把 `github:dingminhua/dsh-connect-workbuddy#v5.18.0` 直接写进 `add`。** 我试了，pnpm 会拦住：`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` —— 从 GitHub 取的包需要执行构建脚本，但又不在 `onlyBuiltDependencies` 白名单里。就算你把它加进白名单跑通了，也是在拿一个**未经你核对**的构建结果。老老实实 clone 下来自己 build。
- **别在正在运行的 profile 目录上 `pnpm run build`。** 如果那份仓库已经 `link:` 进你**正在用**的 DSH，构建会直接改写宿主此刻加载的字节，历史上有过因此崩渲染进程的记录。稳妥顺序：先在干净 clone 里 build 完，再 `add`；或者先用一个一次性 profile 验证，确认无误再动 `desktop`。

## 11 月 5 日之后

npm 上出现 5.18.0、且 `dist-tags.latest` 翻到 5.18.0 之后，切回正式包：

```sh
npm view dsh-connect-workbuddy version        # 确认是 5.18.0
dsh plugin --profile desktop remove dsh-connect-workbuddy
dsh plugin --profile desktop add dsh-connect-workbuddy@5.18.0
```

**装的时候写精确版本号，别用 `^` 或 `latest`**：如果你的 profile 配了 pnpm 的 `minimumReleaseAge`（新版本等待期），浮动范围会被**静默压回旧版**，症状恰好是「升级命令跑完了、版本没变」；写死精确版本号则会明确报 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`，反而好判断。要立刻装就在 profile 的 `pnpm-workspace.yaml` 里加 `minimumReleaseAgeExclude: [dsh-connect-workbuddy]`。

自己编译装的，建议先 `remove` 掉本地 link 再装 npm 版，避免两个来源的同一个插件打架。**你的配置与账号数据不受影响**（它们在 `$DSH_HOME` 下，不随包走）。

## 怎么确认自己到底是哪个版本

```sh
dsh plugin --profile desktop exec dsh-connect-workbuddy doctor
# 第一行：WorkBuddy Connect <版本号> on v<node 版本>
```

> 两个以前写过的自查方式**并不存在**，别再用了：插件注册的斜杠命令是 `/codebuddy`（转发本机 CodeBuddy CLI），不是 `/workbuddy`；卡片的「诊断」栏只有区域 / 域名 / 服务账号 / 登录有效期 / 目录模型数 / 已启用数 / 账号池 / 最近一次失败这八行，**没有版本号这一行**。版本只在 CLI 输出里。

## 常见问题

**Q：`5.17.0` 有 bug 吗？我是不是必须升？**
没有「必须升」的理由，三个 issue 都不是安全问题，也都有临时绕过。`5.17.0` 里已知的问题都能绕（#187 的生视频三个故障、#190 的鸿蒙检测、#188 的面板都还没有）。如果你不是鸿蒙、也不用生视频、也不想要那个侧边栏行，**什么都别做**。

**Q：我在鸿蒙上，账号池是空的。**
那是 #190，`5.17.0` 修不了，得等这个包或者按上面的步骤自己编译。临时绕过：设环境变量 `WORKBUDDY_AUTH_FILE`（或 `WORKBUDDY_USER_HOME`）指向你机器上真实的那份 `workbuddy-desktop.info`。

**Q：`5.17.0` 的 `doctor` 说 SDK 是 `ready`，但界面里说没取过 token。**
那也是旧行为（SDK 原先只在请求路径取 token）。`5.18.0` 改成了后台预热，并且默认是**关**的——要真实设备值，先在卡片的「SDK」页把「启用真实设备 SDK」打开。macOS 上「真实值」这一档本身是禁用的（它要 dispatch_sync 到主队列，会和宿主互相等死），卡片上会写明原因。

**Q：为什么不在插件市场里更新？**
市场索引是一份会滞后的快照，它读不到 npm 上还不存在的版本——这次是真的没有包，不是市场没刷新。判断标准永远只有 `npm view dsh-connect-workbuddy version`。

## English summary

**Current installable version: `5.17.0`.** The `5.18.0` code is on tag `v5.18.0` (commit `06006e4`) — there is **no GitHub Release for it yet either** — and the npm package is **not published**: publishing needs an interactive 2FA environment I don't have right now. Next publish: **November 5, 2026 (Beijing time, UTC+8)**.

Nothing is broken in `5.17.0`; if you don't need the fixes, keep using it.

`5.18.0` contains: an **optional sidebar panel** (#188, off by default), **HarmonyOS credential detection** (#190), **three independent video-generation fixes** (#187: http(s) inputs downloaded to data URIs instead of being passed upstream, internal timeouts moved strictly under the host's tool ceiling, upstream `failed` payloads surfaced), and an **off-by-default master switch for the real-device SDK** (previously it always started a 10-minute child-process loop even for the Virtual tier).

If you need it now, build from source — verified end-to-end from a clean clone of the tag:

```sh
git clone --depth 1 --branch v5.18.0 https://github.com/dingminhua/dsh-connect-workbuddy.git
cd dsh-connect-workbuddy
pnpm install --frozen-lockfile     # `prepare` builds lib/ automatically
node lib/bin.js doctor             # first line: WorkBuddy Connect 5.18.0
dsh plugin --profile desktop add /absolute/path/to/dsh-connect-workbuddy
```

Requires Node.js `^22.19.0` or `>=24.0.0`. Restart DSH afterwards. Do **not** install straight from `github:` — pnpm refuses to run the build (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`) unless you allowlist it, and you'd be running a build you never verified.

This issue will be updated the moment `5.18.0` is on npm.

---

*本贴是版本状态的唯一权威来源。日期一到我会更新这里的表格并补发，不再单开新帖。升级机制（市场滞后、pnpm 等待期、怎么核对）另见 [#181](https://github.com/dingminhua/dsh-connect-workbuddy/issues/181)，但**那张表里的版本号已过期，以本帖为准**。*

