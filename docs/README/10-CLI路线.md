<!-- 原版 README 章节归档：CLI 路线。已按主题重构精简，逐字原版见 git 历史。返回总览：../../README.md -->

## CLI 路线（可选）：让 CodeBuddy 直接干活

默认关闭（`cliBridge.enabled: false`）。关闭时不注册工具、不注册指令，provider 那条路一行没变。它不把 CodeBuddy 当模型提供方，而是当**工具**：提供 `codebuddy_ask` 工具和 `/codebuddy` 指令，由本机已登录的 CodeBuddy CLI 在自己进程里跑一轮真实任务（读文件、跑 git、改代码），再把结论交回来。

**它绕开的是客户端指纹层，不是账号层。** 提供方那条路要让请求看起来像 CodeBuddy 客户端才能过渠道校验，而校验已升级成按提示词中段精确子串匹配，这是军备竞赛且不再免费（issue #98 的账号级限制 `11140`）。CLI 路线用 `CODEBUDDY_AUTH_TOKEN` 把本插件 vault 里的**同一批账号**交给 CLI，所以「不被限制」不成立——身份还是同一批账号，`11140` 照样生效。真正绕开的只有「这条请求的客户端指纹像不像 CodeBuddy」这一层；两条路是互补的容错，不是替代。

### 前提与打开

- 本机装 CodeBuddy CLI（npm 包 `@tencent-ai/codebuddy-code`，`codebuddy` 与 `cbc` 同一入口），非标准位置用 `cliBridge.binary` 指绝对路径。
- 它已登录。凭据顺序：环境变量 `CODEBUDDY_AUTH_TOKEN` → 本插件 vault（`$DSH_HOME/workbuddy-vault/<region>/<account>.json`）。**为这个插件登录过的账号直接复用，不用再登录一次。**
- 区域优先于新鲜度：国内令牌只对 `copilot.tencent.com` 有效，国际令牌在那边会 401，故默认顺序 `cn,global`，某区失败才换下一个。

```jsonc
{ "cliBridge": { "enabled": true } }
```

其余键都有默认值。`cliBridge` 是 volatile 字段，改动只重建这条路由，不重载两个 provider 栈，也**不需要重启宿主**。

### 两个入口

| 入口 | 谁触发 | 工作目录 | 花谁的额度 |
| --- | --- | --- | --- |
| `codebuddy_ask` 工具 | 模型自己决定 | 会话工作区 / 调用方 `working_dir` / `cliBridge.workingDir` | CodeBuddy 配额 + 回注唤醒的 DSH token（`injectResult` 默认开） |
| `/codebuddy` 指令 | 用户敲 | 自动取当前会话工作区 | 同上（指令不过模型，但默认回注结论） |

`/codebuddy` 后**留空** = 评审当前工作区未提交的改动（强制只读 `dontAsk`，要求它自己跑 `git diff`、只报确实看见的问题）；**写了字** = 原样发过去；**以 `--edit` 开头** = 这一轮允许改文件（`acceptEdits`，只影响此次，如 `/codebuddy --edit 修一下这个空指针`；单独用 = 评审并顺手修）。

结论默认**回注给会话模型**（`injectResult` 默认开）：空闲时直接唤醒一轮，正在跑就排进下一步——这一步真的花 DSH token；设 `false` 才是完全不碰模型，结论只显示给你看。回注文本以 `[dsh-connect-workbuddy · 由 /codebuddy 自动回注，不是用户输入]` 开头，避免被当成用户输入。

### 实时胶囊

输入框下方（`conversation.composer.dock`，与额度胶囊同排）挂一颗胶囊 `CodeBuddy · 7 tools · 42s · last: Bash`，由只读路由 `/plugins/dsh-connect-workbuddy/cli-live` 把宿主 live board（`src/cli-bridge/live.ts`）序列化供数。它让「还在干活」和「已经卡死」一眼可分。

- **只在真有回合时出现**：没回合时渲染 `null`，那一行一个像素都不变。路由无条件注册（开关关着也在），客户端才能区分「没有回合」与「没有这条路由」。
- **只描述本会话**：座位声明 `scope: 'session'`、`inject` 传 `sessionId`。不这么过滤，A 会话输入框下会描述 B 会话的回合。老宿主没给 `sessionId` 时不过滤——少一颗读数比假装没回合更糟。
- **不按供应商门控**：它报的是一个本地进程，与模型无关，从 DeepSeek 会话发起也看得见。
- **秒数本地走、不额外请求**：5 秒轮询文档，1 秒 tick 从 `startedAt` 推算；多会话共享同一在途请求（inflight 去重）。
- **时钟按宿主校正**：用文档的 `serverTime` 算偏移，且只在拿到新文档时重算（用缓存的旧 `serverTime` 会把已经过去的时间再减一遍，计数器冻住）。
- **不撒谎、不赖着**：`serverTime` 非有限数字时整份作废；路由连续三个周期（15s）失败就清空。同会话多回合显示最新一条，`+N` 表示还有几条，目录只进 tooltip。
- 工具次数是 NDJSON 里 `tool_use` 帧数，`phase` 为 `starting`/`running`/`finishing`，只是给人看的进度信号，不是计费依据。
- 这颗胶囊走客户端入口（`dsh.client`），改它需重新构建 `lib/client.js` 并重启宿主。

### 权限与目录

**权限默认只读。** `permissionMode` 默认 `dontAsk`：只读工具（Read/Glob/Grep）自动放行，写文件和执行命令被拒且**不卡住**（CLI 自己结束这一轮并告诉你哪些被拒）。不用 `plan` 是因为 headless 下它会发 `control_request` 等 stdin 授权，无人值守会挂到 60 秒协议超时、插件一路等到 `timeoutSecs`（900 秒）；runner 里把每条 `control_request` 明确拒掉，且**按工具区分**：只有 `ExitPlanMode` 带 `interrupt: true`，其它工具（Bash、Write…）不能带（带了整轮中止，不带则 CLI 换工具继续）。想真改文件就显式设 `acceptEdits`。

**工作目录四级阶梯 + 允许根。** 顺序：调用方 `working_dir` → 本会话工作区（`session.header.cwd`）→ `cliBridge.workingDir` →（仅 `allowUnattended` 开时）临时目录 → 都没有就拒绝并说明三条出路。选中的目录必须绝对路径、存在且是目录、落在允许根内（会话工作区、`cliBridge.workingDir`、`cliBridge.allowedDirs`）。`allowedDirs` 是逗号分隔的绝对路径，放行工作区外的目录；比较用 `realpath` 解析并按分隔符对齐边界（`..` 走不出去，`/repo-evil` 不算 `/repo` 的子目录）。

### 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 唯一开关，`false` 时什么都不注册 |
| `binary` | `''` | CLI 绝对路径；留空只按已知位置探测，找不到就拒绝，**不回退 PATH 上的 `codebuddy`**（它会拿到 vault 令牌） |
| `model` | `''` | 传给 `--model`，留空用 CLI 默认 |
| `permissionMode` | `dontAsk` | `dontAsk`（只读）/ `plan` / `default` / `auto` / `acceptEdits` / `bypassPermissions`（后两个可写） |
| `effort` | `''` | `--effort`：`minimal`/`low`/`medium`/`high`/`xhigh`/`max` |
| `maxTurns` | `10` | 单次任务轮数上限（硬上限 100） |
| `timeoutSecs` | `900` | 单次任务墙钟超时，秒（硬上限 1800） |
| `regionOrder` | `cn,global` | 凭据区域优先顺序 |
| `workingDir` | `''` | 工具入口默认工作目录，也是允许根之一 |
| `allowedDirs` | `''` | 额外允许根，逗号分隔绝对路径 |
| `appendSystemPrompt` | `''` | 追加到 CLI 系统提示末尾 |
| `allowUnattended` | `false` | 允许无工作目录时退回临时目录（默认关：不该在没人指定的目录跑） |
| `maxReplyChars` | `60000` | 交回会话模型的最大字符数（硬上限 400000） |
| `injectResult` | `true` | 跑完是否回注模型，设 `false` 才完全不碰模型 |
| `sessionContinuity` | `auto` | 同一 DSH 会话是否续接上次的 CodeBuddy 对话（`auto` 走 `--session-id`，`off` 每次独立）；显式 `session_id` 参数优先 |
| `maxTurnsPerSessionHour` | `6` | 每会话每小时最多几次，`0` 不限 |
| `maxTurnsPerHour` | `20` | 全部会话每小时合计最多几次，`0` 不限 |

### 边界

- **看不到 DSH 对话，但看得到自己的上一轮。** `sessionContinuity=auto` 下同一会话连续调用是同一条 CodeBuddy 对话，第二次知道第一次说了什么、读了哪些文件；但它依据的是 CodeBuddy 自己的上下文，不是你在这里说的话——要它知道就得写进指令。想每次独立设 `off`。
- **有写权限门槛，没有沙箱。** 默认只读；`acceptEdits` 后真的会改工作区文件。允许根只约束在哪个目录跑，不约束在里面做什么。
- **两套账。** CodeBuddy CLI 配额与 DSH 模型额度是两回事；指令本身不花 DSH token，但默认回注让模型多跑一轮，那是真的 DSH token。设了每小时上限防止「回注 → 模型再问 → 再回注」循环。
- **失败就停，不换账号试。** 只有明确识别出凭据被拒（401 / `Authentication required` / `/login`）才换下一个账号；超时、崩溃、找不到 CLI 直接报错——十几个账号逐个试 900 秒比失败本身更糟。换号也不看模型说的话（早期把 CLI 正文也扫一遍，导致评审含 `HTTP 401` 的代码被误判）。
- **超时连子进程一起杀。** CLI 会派生 `git`/`npm`，POSIX 按进程组发信号，Windows 走 `taskkill /T`。
- **要重启。** 新增 bundle 与 JS 改动都要重启 DSH 宿主才生效。
