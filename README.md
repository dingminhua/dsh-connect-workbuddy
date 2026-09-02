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

一个独立的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) bundle 插件。它把本机已登录的 WorkBuddy 中国区账号接到 DSH 的模型选择器，同时提供**只读**的积分概览与可勾选的模型管理界面。

## 功能特性

- **WorkBuddy 模型接入** —— 把本机登录的 WorkBuddy 模型注册为 DSH 的 `workbuddy` provider，模型选择器出现 `GLM-5.3`、`DeepSeek-V4-Pro`、`Kimi-K3`、`MiniMax-M3`、`Hy3` 等。
- **模型管理** —— 从上游刷新完整模型目录，逐项勾选启用或禁用；刷新是草稿操作，点保存才生效。上游同时给出积分倍率、上下文/输出上限与推理档位；图片输入按模型手动勾选（默认不勾选）。
- **本机账号切换** —— 自动发现 WorkBuddy 桌面端留下的多个登录凭据，可切换账号；Token 不写入 DSH 设置。
- **只读积分概览** —— 按套餐聚合展示剩余积分，并列出每个模型的积分倍率。查询不消耗积分。
- **凭据路径多候选** —— macOS / Windows / Linux 逐一探测默认位置，也支持环境变量与卡片内直接指定。
- **安全 loopback shim** —— 随机端口 + 进程内随机 secret，真实 WorkBuddy token 不交给 pi-ai。
- **命令行诊断** —— `status` / `doctor` / `logout`，无需浏览器即可确认登录、积分与宿主状态。

## 工作原理

```text
DSH PiAiAdapter
  -> 安全 loopback shim（随机端口 + 进程内随机 secret）
  -> WorkBuddyUpstreamClient
  -> https://copilot.tencent.com/v2/chat/completions
  -> WorkBuddy SSE
  -> DSH 本地执行工具并回传结果
```

模型目录走 `/console/enterprises/personal/models`，积分概览走 `https://www.codebuddy.cn/v2/billing/meter/get-user-resource`，两者均为只读接口。

凭据读取自 WorkBuddy 桌面 App 自身的 auth 文件（只读）；刷新得到的 token 单独存放在 `$DSH_HOME/.workbuddy-auth.json`，桌面端文件永不被写入。

## 安装

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
- Windows / Linux 的凭据默认路径为按平台约定推导，未经真机验证；必要时可通过环境变量 `WORKBUDDY_AUTH_FILE` 指定实际位置。

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

### 说明

以上项目的版权归各自作者所有。本项目采用**借鉴设计思路 + 独立实现**的方式，未整体复制任何参考项目的源码；关键模块均为独立编写，并在源文件头部注释中标注了所参考的具体项目与模式。若你发现本项目的标注有遗漏或不当之处，请提交 issue，我们会立即更正。

## 第三方开源依赖

本项目参考的开源项目、其许可证与合规说明，完整记录见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。引入新的与 WorkBuddy 接入相关的外部依赖或复用其他项目代码时，请同步更新该文件并遵守对应许可证要求。

## 许可证

本项目采用 [MIT](LICENSE) 许可证，版权归属：**Copyright (c) 2026 LaoDing**。
