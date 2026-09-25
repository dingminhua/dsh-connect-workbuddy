<p align="center">
  <img src="docs/assets/dsh-connect-workbuddy-usage-card.png" width="640" alt="dsh-connect-workbuddy settings panel" />
</p>

<h1 align="center">dsh-connect-workbuddy</h1>

<p align="center"><b>把本机登录的 WorkBuddy 模型接入 DeepSeek Harness，并提供只读的积分概览与模型管理。</b></p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="#安装">安装</a> ·
  <a href="#工作原理">工作原理</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="https://github.com/dingminhua/dsh-connect-workbuddy/issues">问题反馈</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-connect-workbuddy"><img src="https://img.shields.io/npm/v/dsh-connect-workbuddy?style=flat-square&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-connect-workbuddy"><img src="https://img.shields.io/npm/d18m/dsh-connect-workbuddy?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/dingminhua/dsh-connect-workbuddy/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/dingminhua/dsh-connect-workbuddy/ci.yml?branch=main&style=flat-square&label=tests" alt="test status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/dingminhua/dsh-connect-workbuddy?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/dingminhua/dsh-connect-workbuddy/stargazers"><img src="https://img.shields.io/github/stars/dingminhua/dsh-connect-workbuddy?style=flat-square" alt="GitHub stars"></a>
  <a href="https://dshfind.com/plugins/dingminhua/dsh-connect-workbuddy"><img src="https://dshfind.com/api/badge/dingminhua/dsh-connect-workbuddy" alt="dshfind plugin"></a>
</p>

一个独立的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) bundle 插件。它把本机已登录的 WorkBuddy 账号（**国内版与国际版 WorkBuddy AI 均支持**）接到 DSH 的模型选择器，同时提供**只读**的积分概览与可勾选的模型管理界面。**国内版与国际版是两个并行的供应商（`workbuddy` / `workbuddy-global`），可同时使用**；插件设置卡片以 tab 区分两者，方便统一管理。

## 功能特性

- **双供应商并行接入（国内版 + 国际版）** —— 国内版注册为 `workbuddy` provider（`GLM-5.3`、`DeepSeek-V4-Pro`、`Kimi-K3`、`MiniMax-M3`、`Hy3` 等），国际版注册为 `workbuddy-global` provider（`GPT-5.6`、`Gemini-3.5-Flash`、`GLM-5.3`、`Kimi-K3` 等）。**有账号的区域其模型会出现在 DSH 模型选择器里**：两边都有账号时两组同时可选，不同会话可以各选一边，互不干扰。**本机没有账号的区域不列出任何模型**（该区域一个请求也发不出去，列出来只会点到就失败）；只要在该区域登录一次，「重新检测账号」或重启后模型就会自动出现——provider 本身始终注册着，因为它的设置卡片与账号选择器正是登录的入口。模型名内嵌上游积分倍率（如 `GLM-5.3 · x0.79`），与 WorkBuddy 自身模型菜单一致。
- **插件卡片 tab 切换** —— 设置卡片顶部为「国内版 / 国际版」两个 tab，各含独立的账号选择、积分概览与模型管理；每个 tab 的账号、目录、勾选与未保存草稿完全隔离——在一个 tab 里切账号或刷新模型，不会触碰另一边的运行时目录与会话。
- **可单独关闭任一版本供应商** —— 每个 tab 右侧有一个勾选框（默认都勾选）。**取消勾选即把该供应商从 DSH 模型选择器里彻底撤掉**（不是只藏起 tab）：它的路由与「设置 → 模型」页的目录条目一并摘除，启动时也不再为它发无用请求。账号、积分、目录与勾选**全部保留**，重新勾选即完整恢复。典型用法是「我根本用不到国际版」——关掉它，让选择器干净。注意：若某会话此前选中的正是被关闭供应商的模型，该会话再调用会报 `NO_ADAPTER`，卡片会在关闭态的 tab 上明确提示这一点，不会静默失败。
- **模型管理** —— 从上游刷新完整模型目录，逐项勾选启用或禁用；刷新是草稿操作，点保存才生效。上游同时给出积分倍率、上下文/输出上限与推理档位；图片输入按模型手动勾选（默认不勾选）。
- **本机账号切换** —— 自动发现 WorkBuddy 桌面端留下的多个登录凭据，可按区域切换账号；Token 不写入 DSH 设置。
- **凭据失效时给出可执行的建议** —— 上游拒绝当前账号的 token 时，插件会**实际探测**本机其他账号：若有账号仍然可用，就直接告诉你「切换到它即可」（并附一键切换），而不是笼统地让你重新登录——被钉在一个作废的旧备份上时，重新登录并不能解决问题。只有本机确实没有别的账号可切换时，才会提示重新登录。
- **只读积分概览** —— 按套餐聚合展示剩余积分，并列出每个模型的积分倍率。查询不消耗积分。
- **凭据路径多候选** —— macOS / Windows / Linux 逐一探测默认位置，也支持环境变量与卡片内直接指定。**未登录时卡片会列出「探测过哪些路径、各自为什么没成」**：五档原因（不存在 / 读不了 / 没有可用 token / 字段已加密且拿不到密钥 / 属于另一个地区）分开呈现，因此「已经登录了、但桌面 App 不在场」这种最容易误判的情况会明说需要 App 在场，而不是叫你重新登录一次。**属于另一个地区**那一档尤其不同：登录信息是真实可用的，只是挂在另一个标签页下，卡片会直接给出结论「切换标签页即可，不用重新登录」。列表只讲一次——提示段落说结论，折叠列表给路径细节，两处不重复同一件事。
- **安全 loopback shim** —— 每区域一个随机端口 + 进程内随机 secret，真实 WorkBuddy token 不交给 pi-ai。
- **命令行诊断** —— `status` / `doctor` / `logout`，按区域报告登录与积分，无需浏览器即可确认宿主状态。

## 工作原理

```text
DSH PiAiAdapter（每个 provider 一套）
  -> 安全 loopback shim（每区域一个随机端口 + 进程内随机 secret）
  -> WorkBuddyUpstreamClient
  -> 国内版 https://copilot.tencent.com/v2/chat/completions
  -> 国际版 https://www.workbuddy.ai/v2/chat/completions
  -> WorkBuddy SSE
  -> DSH 本地执行工具并回传结果
```

国内版与国际版各持一套完整的运行时栈——凭据 store、模型 catalog、回环 shim、adapter——按凭据域名（`workbuddy.ai` / `codebuddy.ai` → 国际版，其余 → 国内版）隔离可见账号，所以**两个区域的账号可以同时在线、同时被不同会话使用**。国际版有两个品牌域名：桌面端登录在 `workbuddy.ai`，CodeBuddy CLI 登录在 `codebuddy.ai`，两者都是国际版。

模型目录按区域取自各自的正确来源：国内版走 `/v2/enterprises/personal/models`，国际版走 `<国际网关>/v3/config`（配置服务按客户端渠道返回不同清单，国际版必须用桌面端 User-Agent 才能取到账号真实的 20 个模型，含免费的 `deepseek-v4.1-flash`）。积分概览走 `https://www.codebuddy.cn/v2/billing/meter/get-user-resource`（国际版账号自动路由到其凭据所属的国际网关，`workbuddy.ai` 或 `codebuddy.ai`——两个品牌域名的凭据互不通用），均为只读接口。

凭据读取自 WorkBuddy 桌面 App 自身的 auth 文件（只读）；刷新得到的 token 按区域存放在 `$DSH_HOME/.workbuddy-auth.cn.json` 与 `$DSH_HOME/.workbuddy-auth.global.json`（双账号同时在线互不覆盖；旧的单文件 `.workbuddy-auth.json` 作为迁移来源保留读取），桌面端文件永不被写入。

**加密凭据字段**：新版桌面端（Windows 先行）把 auth 文件里的 `accessToken` / `refreshToken` 从纯字符串改为 `{"$wbEncrypted":1,"envelope":"…"}` 的 AES-256-GCM 信封，**账号昵称 `nickname` 同样被加密**（不解密就会退回成一串 uin 数字）。信封用的是 App **自身构建期内置**的字段密钥，并非用户密钥，因此插件不内置任何密钥副本，而是在需要时用 `ELECTRON_RUN_AS_NODE` 调用已安装 App 的原生绑定（`electron_browser_workbuddy_storage.loggerGet()`）取回同一份载荷并就地派生密钥——也就是「向写下这个文件的那个构建本身询问」。密钥只在本进程内存中缓存，不落盘、不进日志；纯字符串文件（macOS 与旧版 Windows）走原路径，一次子进程都不会启动。其中的 `account.phoneNumber` 虽同样加密，插件**不读取也不显示**。若 App 安装在非常规位置，用 `WORKBUDDY_APP_EXECUTABLE` 指定其可执行文件。

## 安装

> ⚠️ **版本要求：DSH 0.1.7-rc.1 及以上。** 自 v2.1.0 起本插件只支持 DSH 0.1.7-rc.1 及以上的宿主（旧版宿主无法通过依赖解析安装本版）；0.1.5 及更早的宿主请停留在 v2.0.15。

前置：已安装并登录 WorkBuddy 桌面 App（插件复用 App 的登录状态）。

推荐使用 DSH 插件命令安装 npm 已发布版本：

```sh
dsh plugin --profile desktop add dsh-connect-workbuddy
```

或直接通过 npm 安装：

```sh
npm install dsh-connect-workbuddy
```

安装、更新或卸载 bundle 后，需要重启对应的 DSH 进程。

插件在 **Web**、**Desktop**、**TUI** 三种界面下均可运行，按你使用的 profile 选择对应命令：

```sh
dsh plugin --profile web add dsh-connect-workbuddy     # Web
dsh plugin --profile dsh-tui add dsh-connect-workbuddy # TUI
```

## 命令行

```sh
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-connect-workbuddy status   # 登录状态与剩余积分
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-connect-workbuddy doctor   # 凭据路径与宿主诊断
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-connect-workbuddy logout   # 清理插件持有的凭据副本
```

`status` 与 `doctor` 支持 `--json` 输出机器可读格式。

## 开发

```sh
pnpm install
pnpm run check   # typecheck + test + build
```

本地开发用 `link:` 安装到 desktop profile（改码后重启 DSH Desktop 生效）：

```sh
dsh plugin --profile desktop add /Users/dmh2002/DshProject/dsh-connect-workbuddy
```

## 市场收录与展示

插件已包含可安装的 `dsh.bundle` manifest，并发布到 npm。社区市场通常从 [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 注册表同步条目；仓库内的提交草稿位于 [`awesome-dsh-plugin-submission/dingminhua__dsh-connect-workbuddy.yml`](awesome-dsh-plugin-submission/dingminhua__dsh-connect-workbuddy.yml)，正式提交为 PR [#3812](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/3812)（`data/plugins/dingminhua__dsh-connect-workbuddy.yml`，已通过 CI 与 Submission gate，等待维护者合并）。

**收录目录规范**（依据 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)）：

- 每个插件一个 YAML：`data/plugins/<owner>__<repo>.yml`，字段为 `url`（与仓库地址完全一致）、`name`（`owner/repo`）、`category`（有效值之一，本项目为 `model`）、`description.en`（必填，以句号结尾）/ `description.zh`（可选）；描述中含 `: ` 必须加引号。
- 仓库必须声明 `dsh.bundle` manifest（本项目 `dsh.bundle.patch: ./cordis.patch.yml`），且被 `dsh-plugin` topic 标记；提交数 ≥ 10、仓库满 1 天由 CI 自动检查。
- 两个 README（`README.md` / `README.zh.md`）由脚本生成，不得手工编辑；修改 YAML 后执行 `node scripts/generate-readme.mjs` 重新生成。
- 一个 PR 最多收录 3 条；只改自己的条目，不动其他插件。

市场卡片中的截图与 GitHub README 徽章是两套机制：

- **GitHub 徽章**由本 README 顶部的 Shields/dshfind 图片链接生成。
- **市场截图**按当前约定由**插件自己仓库根目录的 `screenshots.json`** 声明（本项目声明了 [screenshots.json](screenshots.json)，含使用界面截图），注册表 `data/screenshots.json` 是旧约定下的回退，**不再添加新键**（本项目已在提交前撤销该文件的改动）。
- **市场图标/占位图**由具体市场的展示规则决定，并不是 npm `package.json` 的通用字段，也不是 README 徽章。

## 已知限制

- 依赖 WorkBuddy 客户端接口（非官方开放 API），WorkBuddy 更新后插件可能需要随之调整。
- **账号切换**基于 WorkBuddy 桌面端留下的历史 auth 文件（App 自身的备份产物），并非官方多账号 API。默认行为仍是跟随 App 当前登录；切换账号是显式选项，且历史凭据可能因 App 清理或退出登录而失效。
  - 显式选择的账号若在本机消失（App 更换登录或清理备份文件），插件**不会**静默改选其他账号——那样会让账单落到另一个账号上。卡片会明确说明「保存的账号已不存在」，此时重新选择一个账号，或点「跟随 App 当前登录」清除该选择即可恢复。**重新登录桌面端 App 无法修复这种状态**：凭据本身是好的，失效的只是保存下来的账号标识。
  - 从 2.0.0 之前的版本升级而来的用户，设置里可能仍留有旧版的顶层 `accountId`（迁移来源）。它只作用于其所属区域，且**该区域被显式清除（`accounts.<区域> = ""`）后即不再生效**——否则清除掉的账号会在下次启动时被静默恢复。卡片会显示每个区域当前是「使用保存的账号」还是「跟随 App 当前登录」：清除后回到的默认账号往往与刚清掉的账号是同一个，没有这行提示就无法分辨清除是否生效。
- **Windows：设置文件 `settings.yaml` 被占用时，账号改动可能无法保存**。DSH 用「写临时文件 + 覆盖替换」的方式更新该文件，而杀毒软件、OneDrive 等同步盘或正在打开该文件的编辑器会短暂锁住它；重试耗尽后，写入失败**不会**让 `set()` 报错。插件因此会在写入后回读校验：**确认落盘才显示「已清除」**，失败则给出明确错误并保留原来的选择（不会显示一个旧选择默默反驳的假确认）。遇到该提示时，关闭占用该文件的程序后重试即可。
- Windows / Linux 的凭据默认路径为按平台约定推导，未经真机验证；必要时可通过环境变量 `WORKBUDDY_AUTH_FILE` 指定实际位置。
- **加密凭据依赖桌面 App 在场**：新版桌面端（**5.6.0 起，macOS 与 Windows 同样如此**）加密了 auth 文件里的 token 字段，插件需要调用该 App 自身的原生绑定才能取回字段密钥。因此 App 若未安装、被卸载，或安装在探测路径之外（用 `WORKBUDDY_APP_EXECUTABLE` 指定），加密文件就读不出来——此时账号会显示为未登录，而**不会**退化成读出一个残缺的 token。`doctor` 会报告这项能力是否可用。该密钥是构建期常量，随 App 版本可能轮换；插件每次向本机 App 现取，不缓存到磁盘，所以 App 升级后无需升级插件。
  - **App 可执行文件按 bundle 自身声明定位，不按 App 名猜**：WorkBuddy 的 macOS bundle 里 `CFBundleExecutable` 是 `Electron`（不是 `WorkBuddy`），因此插件读取 bundle 的 `Info.plist` 来决定二进制名。国内版 `WorkBuddy.app` 与国际版 `WorkBuddy AI.app` 都在候选内；App 被归入 `/Applications` 子目录（如 `/Applications/IDE/WorkBuddy.app`）时，插件还会向下扫一层并用 bundle id 确认身份后才使用——**不会**因为同名的其他 Electron 应用而误启动它。
  - **「未登录」与「登录信息读不出来」是两件事**：加密文件读不出时，插件给出的建议是「安装桌面 App / 用 `WORKBUDDY_APP_EXECUTABLE` 指定其位置」，而**不是**「重新登录一次」——后者对这种情况无效（凭据本身是好的，缺的是密钥）。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 WorkBuddy 的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
- 本项目与腾讯、WorkBuddy、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 致谢

本项目的实现建立在他人已公开的工作之上。以下内容如实标注来源与许可证，我们对此保持充分尊重：

### 连接内核的参照

- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT，Copyright (c) 2026 Corrine Hu）— **本项目的主要参照**。WorkBuddy 接入 DeepSeek Harness 的完整可行方案由该项目首先验证：桌面端凭据的发现与刷新机制、上游协议与请求头约定、loopback shim 的入站加固、pi-ai provider 的装配方式、以及状态诊断 CLI，均以其为参照。本项目在保留这些已验证能力的基础上重写，着重改善使用体验。
- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）— WorkBuddy 上游协议（`copilot.tencent.com` 的 wire behavior）的参照实现，经 `dsh-workbuddy-connect` 转引。

### 插件呈现与结构的基线

- [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae)（MIT，Copyright (c) 2026 LaoDing）— 插件的呈现方式与其保持一致：设置卡片的结构与交互、模型管理（刷新 → 勾选 → 保存）与账号选择模型、只读的 host↔client 路由形态，以及 npm 发布工程。
- [dingminhua/dsh-subagent-default-model](https://github.com/dingminhua/dsh-subagent-default-model)（MIT，Copyright (c) 2026 LaoDing）— `dsm-*` 卡片风格体系、`row.*` 双语文案键约定与品牌图标的来源，经 `dsh-connect-trae` 转引。
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect)（Apache-2.0）— DSH 插件结构与 provider 注册的参照，经 `dsh-workbuddy-connect` 转引；其 Apache-2.0 义务在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中单独履行。

### 说明

以上项目的版权归各自作者所有。本项目采用**借鉴设计思路 + 独立实现**的方式，未整体复制任何参考项目的源码；关键模块均为独立编写，并在源文件头部注释中标注了所参考的具体项目与模式。若你发现本项目的标注有遗漏或不当之处，请提交 issue，我们会立即更正。

## 第三方开源依赖

本项目参考的开源项目、其许可证与合规说明，完整记录见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。引入新的与 WorkBuddy 接入相关的外部依赖或复用其他项目代码时，请同步更新该文件并遵守对应许可证要求。

## 许可证

本项目采用 [MIT](LICENSE) 许可证，版权归属：**Copyright (c) 2026 LaoDing**。
