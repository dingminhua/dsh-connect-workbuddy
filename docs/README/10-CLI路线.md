<!-- 原版 README 章节逐字归档：CLI 路线（可选）：让 CodeBuddy 直接干活。返回总览：../../README.md -->

## CLI 路线（可选）：让 CodeBuddy 直接干活

> 默认关闭（`cliBridge.enabled: false`）。关闭时不注册工具、不注册指令，provider 那条路一行都没变。**唯一的例外**是下面那颗实时胶囊：它的只读路由与客户端组件无条件注册（客户端要靠它区分「没有回合」和「没有这条路由」），所以关着时每个打开的页面仍会每 5 秒问一次那条本地路由——不碰上游、不花额度，返回一个空数组。

这条路不把 CodeBuddy 当模型提供方，而是当**工具**：插件提供一个 `codebuddy_ask` 工具和一条 `/codebuddy` 指令，由本机已登录的 CodeBuddy CLI 在自己的进程里跑一轮真实任务——读文件、跑 `git`、改代码——再把结论交回来。

**这条路到底绕开了什么，说清楚。** 提供方那条路要让请求看起来像 CodeBuddy 客户端才能过网关的渠道校验，4.15.x 起那条校验已经升级成「按提示词中段做精确子串匹配」，靠句读处插零宽空格躲开——这是军备竞赛，而且不再免费：issue #98 里已经出现**账号级**限制（`code 11140`，「账号存在异常行为，已被限制使用」）。

> **2026-10-29 的 #163 复测更新**：零宽这条路已经被网关堵死——CN 网关在匹配前会规范化 U+200B，system 开头每个词边界都插零宽仍然 11128。现在改为**按句改词**（`rewriteChannelFingerprintPhrases`，落在 `neutralizeChannelFingerprints` 之前），只改命中句、其余逐字节不动，也不再需要把提示词伪装成第三方 agent。细节见 CHANGELOG 的 Unreleased。

CLI 路线逃掉的是**客户端指纹层**，不是账号层。它用 `CODEBUDDY_AUTH_TOKEN` 把本插件 vault 里的同一个 WorkBuddy 账号交给 CLI，所以「跟网关说话的是真的 CodeBuddy CLI 进程、没有身份要伪造、因此账号不会被限制」这句话**不成立**：身份仍然是同一批账号，`11140` 是账号级的，同一批账号在 CLI 路线上一样受限。真正被绕开的只有「这条请求的客户端指纹像不像 CodeBuddy」——这一层是真实的收益（渠道校验不会再因为提示词里有句读而拒你），但它不等于「免封」。两条路是互补的容错，不是替代。

### 前提

- 本机装了 CodeBuddy CLI（npm 包 `@tencent-ai/codebuddy-code`，`codebuddy` 与 `cbc` 是同一个入口）。装在非标准位置就用 `cliBridge.binary` 指绝对路径。
- 它已登录。插件按这个顺序找凭据：环境变量 `CODEBUDDY_AUTH_TOKEN` → 本插件**已经维护的**那份 vault（`$DSH_HOME/workbuddy-vault/<region>/<account>.json`）。也就是说，**你为了用这个插件登录过的账号，CLI 路线直接复用，不需要再登录一次。**（真机验证：CLI 的 `getAuthenticationAttributesSync` 把 `CODEBUDDY_AUTH_TOKEN` 排在自己的登录文件之前。）
- 区域**优先于新鲜度**：国内账号的令牌对 `copilot.tencent.com` 有效，国际版的令牌在那边会 401（真机实测：`401 Authentication required ... (target: https://copilot.tencent.com)`）。所以默认顺序是 `cn,global`，某个区域失败才换下一个。

### 打开

```jsonc
{
  "cliBridge": {
    "enabled": true
  }
}
```

其余键都有默认值，不写就是默认。完整的键见下表。改这些键不需要重启宿主：`cliBridge` 是 volatile 字段，改动只重建这一条路由，不会重载两个 provider 栈。

### 两个入口

| 入口 | 谁触发 | 工作目录 | 花谁的额度 |
| --- | --- | --- | --- |
| `codebuddy_ask` 工具 | 模型自己决定调用 | 会话工作区；或调用方传的 `working_dir`；或 `cliBridge.workingDir` | CodeBuddy 的配额 + 那一次回注唤醒的 DSH token（`injectResult` 默认开） |
| `/codebuddy` 指令 | 用户敲 | **自动取当前会话的工作区** | 同上——指令本身不经过模型，但默认会把结论回注给模型 |

`/codebuddy` 后面**留空** = 让 CodeBuddy 评审当前工作区里未提交的改动（这种调用强制只读的 `dontAsk` 权限模式，并且要求它自己跑 `git diff`、只报确实看见的问题）；**写了字** = 原样把这句话发过去；**以 `--edit` 开头** = 这一轮允许它改文件（`acceptEdits`，只影响这一次，不改变默认值，例如 `/codebuddy --edit 修一下这个空指针`；`--edit` 单独用 = 评审并顺手修掉找到的问题）。

跑完之后结论会**回注给会话模型**（`cliBridge.injectResult`，默认开）：会话空闲时直接唤醒它起一轮，正在跑就排进它的下一步。**这一步真的花 DSH token**——把 `injectResult` 设成 `false` 才是「完全不碰模型」，那时 `/codebuddy` 的结论只显示给你看。回注的文本以一行 `[dsh-connect-workbuddy · 由 /codebuddy 自动回注，不是用户输入]` 开头，免得你（或者模型）把它当成自己打的字。

### 跑的时候看得见：输入框下方那颗胶囊

工具调用在 DSH 里是**一次性**的：`execute()` 什么时候返回，界面才知道发生了什么。中间那几分钟（读文件、跑 `git`、反复试）本来是一片空白，用户分不清「还在干活」和「已经卡死」。

所以插件在 `conversation.composer.dock`（输入框下方那一行，和额度胶囊同排）挂了一颗**实时胶囊**：`CodeBuddy · 7 tools · 42s · last: Bash`。它由插件自己的只读路由 `/plugins/dsh-connect-workbuddy/cli-live` 供数，那个路由把宿主侧的 live board（`src/cli-bridge/live.ts`）序列化出去。

- **只在真有回合在跑时出现。** 没有回合时组件渲染 `null`，那一行一个像素都不变——这条路由是**无条件注册**的（开关关着也在），客户端才能把「没有回合」和「没有这条路由」区分开，而不用知道开关状态。
- **只描述本会话的回合。** live board 是**宿主级**的（一条路由回答进程里所有会话），所以座位 `conversation.composer.dock` 声明成 `scope: 'session'`、`inject` 第一个参数就是 `sessionId`，胶囊只留下这一行的行。不这么过滤，A 会话输入框下面就会描述 B 会话（甚至另一个标签页）的回合——一条关于你没在看的目录的字，计数器还在动。宿主没给 `sessionId` 时（老宿主，或直接挂载组件的测试）**不过滤**：少一颗诊断读数比假装没有回合更糟；宿主拿不到 `agent.id` 而标成 `sessionId: ''` 的行也照样保留，那同样是「真有人在干活」的证据。
- **不按供应商门控。** 额度胶囊只在会话的模型是 WorkBuddy 供应商时出现，因为它报的是那家供应商的额度；这颗胶囊报的是**一个本地进程**，而 CLI 路线刻意与模型无关——从 DeepSeek 会话里发起也应当看得见。`cliBridge.enabled` 也不需要单独判断：关着时不会有回合开始，板子是空的，胶囊自然什么都不渲染。
- **秒数在本地走，不额外发请求。** 5 秒轮询一次文档，秒数由 1 秒的本地 tick 从 `startedAt` 推出来。多个会话共享**同一个**在途请求（模块级缓存 + inflight 去重），N 个标签页不会变成 N 倍轮询。
- **时钟偏差按宿主时间校正。** `startedAt` 是宿主时钟；浏览器时钟慢一分钟就会算出负数。文档里带 `serverTime`，客户端据此算偏移——而且**只在拿到新文档时**重算（缓存的文档带的是旧 `serverTime`，每次都重算会把已经过去的时间从偏移里再减一遍，计数器就会冻在原地）。
- **工具次数是近似值。** 从 CLI 的 NDJSON 里数 `tool_use` 帧得来，`phase` 是 `starting` / `running` / `finishing` 三态；`lastTool` 是最近一次工具名。这些是给人看的进度信号，不是计费依据。
- **它不会撒谎，也不会赖着不走。** 文档里 `serverTime` 不是有限数字时整份作废（否则标签会印出 `NaNs`）；路由连续三个周期（15s）失败就清空，不会在输入框上留一颗描述着已结束回合的幽灵。同一个会话里多条回合同时跑时它显示最新的那条，`+N` 表示还有几条，目录只进 tooltip——因为这条 dock 只有一行。

> 这颗胶囊走的是插件的客户端入口（`dsh.client`），所以**改它需要重新构建 `lib/client.js` 并重启宿主**，和宿主侧代码一样。

### 权限：默认只读

`permissionMode` 默认 **`dontAsk`**：只读工具（Read/Glob/Grep）自动放行，写文件与执行命令被拒，且**不卡住**——CLI 会自己结束这一轮并告诉你哪些工具被拒了。

**为什么不是 `plan`**（`plan` 是更保守的候选，也是本次评审建议的默认值）：在 `-p`（headless）下 `plan` 会发一条 `control_request` 等 stdin 回授权，而无人值守的调用没有人在终端上点「同意」。不处理这条请求，CLI 会一直等到 60 秒的协议超时，插件则会一路等到 `timeoutSecs`（默认 900 秒）才失败——实测两次都是这样挂死的。所以默认取 `dontAsk`，同时在 runner 里把每一条 `control_request` 明确拒掉。**拒绝时要按工具区分**：只有 `ExitPlanMode` 带 `interrupt: true`（不带则 `plan` 不结束，实测挂过 70 秒）；其它工具（Bash、Write…）**不能**带——带了会让整轮直接中止（实测 `acceptEdits` 下拒绝 Bash：`is_error`、空回复、4.2 秒收场），不带则 CLI 记下这次拒绝、换一个工具继续，整轮正常出结论（实测改用 PowerShell 后 12 秒成功）。想让它真的能改文件，显式设成 `acceptEdits`。

### 工作目录：四级阶梯 + 允许根

`codebuddy_ask` 的工作目录按顺序取：调用方传的 `working_dir` → **本会话的工作区**（`session.header.cwd`）→ `cliBridge.workingDir` → （只有 `allow_unattended` 打开时才）临时目录 → 以上都没有就**拒绝并说明三条出路**。

不管来源是哪一级，选中的目录都要过三关：**必须是绝对路径**、**必须存在且是一个目录**、**必须落在允许根之内**（本会话工作区、`cliBridge.workingDir`、`cliBridge.allowedDirs`）。`allowedDirs` 是逗号分隔的绝对路径列表，用来放行工作区之外的目录。这样「模型自己编一个 `/` 或 `~/.ssh` 传进来」不会被执行，`..` 也走不出去（比较的是 `realpath` 解析后的路径，并按路径分隔符对齐边界，`/repo-evil` 不算 `/repo` 的子目录）。

### 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 唯一的开关。`false` 时这个路由什么都不注册。 |
| `binary` | `''` | CLI 可执行文件的绝对路径。**留空时只按已知安装位置探测，找不到就拒绝运行**——不会回退到 PATH 上的 `codebuddy`（那个二进制会拿到 vault 令牌，不能随便认）。 |
| `model` | `''` | 传给 `--model`；留空用 CLI 自己的默认模型。 |
| `permissionMode` | `dontAsk` | `dontAsk`（默认，只读）/ `plan` / `default` / `auto` / `acceptEdits` / `bypassPermissions`。后两个有写权限。 |
| `effort` | `''` | `--effort`：`minimal` / `low` / `medium` / `high` / `xhigh` / `max`；留空用 CLI 默认。 |
| `maxTurns` | `10` | 单次任务的 CLI 轮数上限（硬上限 100）。 |
| `timeoutSecs` | `900` | 单次任务的墙钟超时，秒（硬上限 1800）。 |
| `regionOrder` | `cn,global` | 凭据区域的优先顺序。 |
| `workingDir` | `''` | 工具入口的默认工作目录，同时也是允许根之一。 |
| `allowedDirs` | `''` | 额外允许的根，逗号分隔的绝对路径。 |
| `appendSystemPrompt` | `''` | 追加到 CLI 系统提示末尾；留空不追加。 |
| `allowUnattended` | `false` | 允许在**没有任何工作目录**时退回一个临时目录。默认关：CLI 有读写权限，不该在没人指定的目录里跑。 |
| `maxReplyChars` | `60000` | 交回给会话模型的最大字符数，超出截断并注明（硬上限 400000）。 |
| `injectResult` | `true` | 跑完后是否把结论回注给会话模型。设为 `false` 才完全不碰模型。 |
| `sessionContinuity` | `auto` | 同一个 DSH 会话里，下一次调用是否续接上一次的 CodeBuddy 对话。`auto` = 自动续接（走 `--session-id`），`off` = 每次都是独立的新对话。显式传 `session_id` 参数时以参数为准。 |
| `maxTurnsPerSessionHour` | `6` | 每个会话每小时最多几次。`0` = 不限。 |
| `maxTurnsPerHour` | `20` | 全部会话每小时合计最多几次。`0` = 不限。 |

### 边界

- **它看不到这段对话，但看得到自己的上一轮。** CodeBuddy 是另一个 agent，DSH 这边的对话历史它拿不到。不过从 4.14 起，同一个会话里连续两次调用默认是**同一条 CodeBuddy 对话**（`sessionContinuity=auto`）：第二次知道第一次说了什么、读了哪些文件，不用从零重读仓库。所以「接着刚才那个思路改」现在可行，但它依据的是 CodeBuddy 自己的上下文，不是你在这里说的话——真要它知道你说过什么，还是得写进指令。想回到「每次都独立」就设 `sessionContinuity=off`。
- **它有写权限的门槛，没有沙箱。** 默认 `dontAsk` 只读；调成 `acceptEdits` 之后它真的会改工作区里的文件。允许根只约束它在**哪个目录**里跑，不约束它在这个目录里做什么。
- **两套账。** CodeBuddy CLI 的配额和 DSH 的模型额度是两回事。指令本身不花 DSH 模型 token，但默认的回注会让会话模型多跑一轮，那一次是真的 DSH token。描述里写了成本信号，也设了每小时上限，防止「回注 → 模型再问 → 再回注」这种循环。
- **失败就停，不换着账号试。** 只有明确识别出凭据被拒（401 / `Authentication required` / `/login`）才会换下一个账号；超时、崩溃、找不到 CLI 都直接报错——十几个 vault 账号逐个重试一遍 900 秒，比失败本身更糟。换号也不再看模型说的话：早期版本把 CLI 的**正文**也扫了一遍，导致「评审一段包含 `HTTP 401` 的代码」被误判成凭据失效。
- **超时会连子进程一起杀。** CLI 会派生 `git` / `npm`，只 kill 直接子进程会留下孤儿。POSIX 上按进程组发信号，Windows 上走 `taskkill /T`。
- **要重启。** 新增的 bundle 与 JS 改动都要重启 DSH 宿主才生效。
