<p align="center">
  <img src="docs/assets/dsh-connect-workbuddy-usage-card.png" width="640" alt="dsh-connect-workbuddy settings panel" />
</p>

<h1 align="center">dsh-connect-workbuddy</h1>

<p align="center"><b>把本机登录的 WorkBuddy 模型接入 DeepSeek Harness，并提供只读的积分概览与模型管理。</b></p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="#安装">安装</a> ·
  <a href="#工作原理">工作原理</a> ·
  <a href="#账号池">账号池</a> ·
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

- **双供应商并行接入（国内版 + 国际版）** —— 国内版注册为 `workbuddy` provider（`GLM-5.3`、`DeepSeek-V4-Pro`、`Kimi-K3`、`MiniMax-M3`、`Hy3` 等），国际版注册为 `workbuddy-global` provider（`GPT-5.6`、`Gemini-3.5-Flash`、`GLM-5.3`、`Kimi-K3` 等）。**有账号的区域其模型会出现在 DSH 模型选择器里**：两边都有账号时两组同时可选，不同会话可以各选一边，互不干扰。**本机没有账号的区域不列出任何模型**（该区域一个请求也发不出去，列出来只会点到就失败）；只要在该区域登录一次，「重新检测账号」或重启后模型就会自动出现——provider 本身始终注册着，因为它的设置卡片正是登录的入口（重新检测在账号池区块里）。模型名内嵌上游积分倍率（如 `GLM-5.3 · x0.79`），与 WorkBuddy 自身模型菜单一致。
- **插件卡片 tab 切换** —— 设置卡片顶部为「国内版 / 国际版」两个 tab，各含独立的账号选择、积分概览与模型管理；每个 tab 的账号、目录、勾选与未保存草稿完全隔离——在一个 tab 里切账号或刷新模型，不会触碰另一边的运行时目录与会话。
- **可单独关闭任一版本供应商** —— 每个 tab 右侧有一个勾选框（默认都勾选）。**取消勾选即把该供应商从 DSH 模型选择器里彻底撤掉**（不是只藏起 tab）：它的路由与「设置 → 模型」页的目录条目一并摘除，启动时也不再为它发无用请求。账号、积分、目录与勾选**全部保留**，重新勾选即完整恢复。典型用法是「我根本用不到国际版」——关掉它，让选择器干净。注意：若某会话此前选中的正是被关闭供应商的模型，该会话再调用会报 `NO_ADAPTER`，卡片会在关闭态的 tab 上明确提示这一点，不会静默失败。
- **模型管理** —— 从上游刷新完整模型目录，逐项勾选启用或禁用；刷新是草稿操作，点保存才生效。上游同时给出积分倍率、上下文/输出上限与推理档位；**图片输入按厂商核验表判定**：刷新时只有厂商文档明确写为原生多模态的模型才自动勾选，文档写明纯文本的不勾，**没有厂商资料的一律按「未核实」不猜**（上游的 `supportsImages` 是平台侧声明，不等于模型能看图，不参与判定）。用户仍可随时手动勾选，勾选状态保存在本地。
- **模型可用性测试（含冷却恢复时间）** —— 限量模型的冷却时间过去只能靠反复试错去猜。现在每个模型行有一个「测试」按钮，直接告诉你它此刻能否使用、不能用时何时恢复。**它发的是一条真实体积的请求（约 25k 输入 token）**，而不是「发个 ping 看通不通」——因为上游的限流**按请求体积触发**（实测约 20k 能过、约 30k 被拒），小请求看着正常、长对话里却可能每次都被拒，那正是「测试通过、实际被限」的来源。**恢复时间的来源**：上游的 429 **不带** `Retry-After` 响应头（也没有 `X-RateLimit-*`），但它把重置时间写在**响应体**里——`{"code":6004,"msg":"…将在 2026-09-30 02:30:30 UTC+8 重置…"}`。插件从响应体解析该时间（并按其声明的 UTC 偏移换算，不受你本机时区影响），因此卡片能直接显示「✗ 被限流 · 2026/9/30 02:30:30 之后可再用」。三处来源都没说时，插件**不编造倒计时**，如实显示「上游未给出何时恢复」。限流**不会**去借月周期包的刷新时间（那会让人为几秒的限流去等几周）。探测在后台发起，**凭据不会传到页面**；结果不写入设置，也不改变你已保存的勾选。

  **两点需要知道**：① **它真的花钱**——实测一次报 `credit` 0.02（被限流时直接 429，几乎不花）。因此**只能按单个模型手工点**，没有「测试已勾选」这类批量按钮：一次覆盖整个列表就是一次不可控支出（服务端也据此**只接受单个模型**，多模型请求会被拒）。② 上游虽宣称 1M 上下文，但节流线远低于此；插件向 DSH 宣称的窗口最高 200K，所以 DSH 很晚才压缩对话——长会话撞限流是这条机制的直接结果。
- **本机账号切换** —— 自动发现 WorkBuddy 桌面端留下的多个登录凭据，可按区域切换账号；Token 不写入 DSH 设置。
- **账号池：多账号批量操作与自动换号** —— 把要用的账号勾进池子，即可**一键签到所有账号**、**一键测试所有账号 × 你指定的模型**（默认挑该区域倍率为 0 的免费模型）；开启**启用账号池**即同时打开**自动换号**——某个请求在上游失败时，插件会依次用池内其他可用账号重试，直到有一个接手、或全部不可用为止，然后才把错误报给你。成员**默认一个都不含**、必须显式勾选（「本机有登录」不等于「要拿它去签到和花积分」）；**开启后由池子的排序决定每一次请求用谁**（可用优先，其次积分高、快过期的积分包、凭据更新的）；失败时依次用池内其他可用账号重试。排序**从不写回你保存的选择**——关掉开关，你选定的账号立刻完全生效。只有请求本身不合法（HTTP 400）不换号：同一个请求体换谁都是 400，重试只会白等。测试走的是与模型行同一套真实体积探测，因此**有真实成本**；**不提供自动签到**——签到会真实领取奖励，只在你点按钮时执行。详见[账号池](#账号池)。
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

## 账号池

<p align="center">
  <img src="docs/assets/dsh-connect-workbuddy-account-pool.png" width="900" alt="dsh-connect-workbuddy 账号池区块：一键签到所有账号、一键测试所有账号、成员勾选与自动换号" />
</p>

一台机器上往往登录过多个 WorkBuddy 账号。**账号池**把这件事收成一次点击：把要用的账号勾进池子，然后「一键签到所有账号」或「一键测试所有账号」；再打开**启用账号池**，插件就会在请求失败时自动换号接着跑。

**每个区域（国内版 / 国际版）各有独立的一池**：成员与目标模型互不影响——两边的账号本来就属于不同的上游栈。**签到只有国内版有**：海外区域不显示签到按钮，也没有那一列。

### 自动换号（开启账号池即生效）

- **谁来服务由排序决定**：开启账号池后，**每一次请求**都发给池子里排序最靠前的可用账号——所以「当前使用」显示的是排序的结果，不一定是你手动选的那个。排序规则见下一节。
- **失败时继续往下试**：某个请求在上游失败时，插件会**依次**用池内其他可用账号重试，直到有一个接手、或全部不可用为止；全部失败才把错误报出来（并在错误里注明尝试过几个账号）。
- **哪些失败会换号**：429 限流、402 无积分、401 凭据失效、502 网关/网络——这些都是**某个账号**的状态，换一个账号很可能就过了。
- **哪些不会**：请求本身不合法（HTTP 400）。同一个请求体换哪个账号都是同样的 400，重试只是让用户多等几轮才看到同一个错误。**流中途断开也不会重试**——字节已经发出去了，重放会让客户端看到两段拼接的回答。
- **已知不可用的账号会被跳过**：正在限流冷却期内、或凭据已被上游拒绝的成员不会参与（这也是「一键测试」的意义：测试结果直接决定谁能被选中）。**从没测试过的账号按「默认可用」参与**——刚发现的登录不该因为「还没测」就被排除。
- **手动选择不会被改写**：池子通过运行时覆盖决定「谁服务」，**从不写回你保存的选择**；关闭账号池，你选定的账号立刻完全恢复生效。这也是为什么卡片要显示「当前使用」——它可能不是你在上面选的那个，而你应该看得出来。
- 每次换号都会在宿主日志里留一行 `warn`，写明因何失败、换到了下一个账号。

### 排序规则（开启账号池后决定谁服务）

1. **可用优先** —— 被测量判定为不可用（限流未到恢复时间、凭据被拒、连通性失败等）的排到最后，不参与选择；
2. **积分高者优先** —— 在可用的账号里选积分最多的。**积分只在有新鲜读数时参与**（卡片轮询、批量测试或保存时读到的那份，10 分钟内有效）：请求路径**不会**为了排序去打上游，否则一页对话就会变成 N 个额外请求；
3. **快过期的积分包优先** —— 3 天内到期的先用，过期即作废；
4. **凭据更晚过期的优先**；
5. 最后按账号 id 收尾，保证顺序是**全序**、可复现，不会因为账号表顺序变化而抖动。

### 两个批量动作

- **一键签到所有账号** —— 逐个账号签到。**签到前先查当天状态**，已签到的直接标记为「已签到」而**不发写入请求**（幂等，不重复领取）；任何单个账号失败只标记该行，**不中断整批**。
- **一键测试所有账号** —— 对每个成员发一次**真实体积**的探测请求（约 25k 输入 token；与模型行的「测试」是同一套 `probeModel`，因而同样继承两个实测结论：限流**按请求体积**触发、恢复时间写在**响应体**里而不是响应头），得出该账号此刻能否用这个模型。

**测试目标是哪个模型**：默认是**该区域目录里倍率为 0 的免费模型**（实测国内版当前只有 `hy3` 一个；**不写死名字**，因为上游会改倍率——`deepseek-v4.1-flash` 就已从 0 变成 0.11），也可以在下拉里指定一个具体模型。指定的模型若已离开目录，**手动动作会明确拒绝**（`target-model-stale`），而不是偷偷换一个——你点的是「测这个模型」，换掉就是答非所问。

**成本与边界**：测试是真实请求，指向免费模型时（倍率 0）几乎不花钱，但它**不是零成本的空转**；签到则会真实领取当日奖励。两个动作都**只在你点按钮时执行**——插件**不提供自动签到**，卡片上也不放一个永远点不动的开关。

### 池成员是显式勾选，默认一个都不含

「本机有登录」不等于「要拿它去签到和花积分」。成员默认**空**，必须逐个勾选（或点「全选」）；**空池不会退化成「全部账号」**——没勾选时两个批量动作直接拒绝，而不是替你把所有账号跑一遍。

勾选是一次**草稿编辑**：点「保存」才落盘，未保存时保存按钮带 dirty 指示；切走或关掉卡片，草稿仍在。

### 手动选择：卡片上没有账号下拉了

账号**一律在账号池里管**：成员勾选就是现在的账号选择面，「重新检测账号」也在那一块。原先那个「账号选择」下拉在有账号池之后是自相矛盾的——池开启时由排序决定谁服务，它改什么都不生效，却看起来像权威；顶部状态行还可能显示成 A、下拉显示成 B。

所以区域状态行也跟着改：**池开启时不再报出某一个账号名**（多个账号同时登录是常态，用单数说「已登录：A」本身就是错的），只陈述本区域可用、由池决定用谁；**池关闭时才报出那个账号**——那时它确实是唯一答案。状态行旁边的圆点与 token 过期时间讲的是「这个区域能不能用」，和「谁在计费」是两件事，后者由账号池区块负责显示。

### 账号为什么出池，以及什么时候回来

| 探测结果 | 对轮换的意义 |
| --- | --- |
| 可用 | 可入选 |
| 被限流 | **暂时**出池，按上游给出的重置时间自动回池（上游没说时间就如实说没说，**不编造倒计时**） |
| 积分耗尽 | 出池，按月周期包的刷新时间回池 |
| 凭据被拒 / 模型不存在 / 连不上上游 / 失败 | 出池，直到下一次探测刷新结果 |

关键一条：**「被限流」不等于不可用**。它恰恰是最值得等的那一类状态——把它当成永久失效剔除，正好丢掉池子里本来最能用的账号。

### 保存与草稿：为什么卡片上有两个「保存」

模型管理一个、账号池一个，这是**刻意保留**而非漏合并：两者的草稿域不同，合并后一次写入失败会连累另一边（模型目录写不进去，就连池偏好也存不了）；一个共享的「放弃」还会在一次误点里同时丢掉两份草稿。两边都是**验证写入**——**写不成功不丢弃草稿**，否则用户的编辑就永久丢了。

池里还有一类状态**不走草稿**：探测结果、冷却时间、当前轮换到的账号。它们是**观测事实**，由插件自己高频写入。原因很实际——草稿是覆盖式的，若观测结果也进草稿，你手工点一次「保存」就可能把定时器刚写进去的结果**回退成几分钟前的旧值**。

## 安装

> ⚠️ **版本要求：DSH 0.1.7-rc.1 及以上（当前窗口：`0.1.7-rc.1` ~ `0.2.x`）。** 自 v2.1.0 起本插件只支持 DSH 0.1.7-rc.1 及以上的宿主（旧版宿主无法通过依赖解析安装本版）；0.1.5 及更早的宿主请停留在 v2.0.15。自 v2.1.2 起上界放宽为 **`<0.3.0-0`**——**0.2.0 全线（含正式版）已实测支持**，0.3.0 线则被明确拒绝。详见下方[受支持的宿主范围](#受支持的宿主范围)。

### 受支持的宿主范围

DSH 的随包门禁（`packages/boot/app-boot/src/plugin-compatibility.ts` 的 `evaluatePluginCompatibility`）会逐条核对本插件声明的 `dsh-*` peer 范围；**只要有一条不满足，整个组合包会被跳过**（进入 `skippedBundles`，仅打印到 stderr）——provider 不注册、卡片不出现、模型列表清空，而页面上没有任何报错。

| 宿主版本 | 判定 |
| --- | --- |
| `0.1.7-rc.1` ~ `0.1.7-rc.2` | ✅ 支持 |
| `0.2.0-rc.1` ~ `0.2.x`（含 `0.2.0` 正式版） | ✅ 支持（2.1.2 起实测） |
| `0.3.0-0` 及以上 | ❌ 明确拒绝（该线尚未验证） |
| `0.1.6` 及更早 | ❌ 明确拒绝（0.1.5 线请停留在 v2.0.15） |

> 上界写作 `<0.3.0-0` 而非 `<0.3.0`：DSH 至今**全部 tag 都是预发布**（`-alpha.N` / `-rc.N`），只写 `<0.3.0` 会放行整条 `0.3.0-alpha.1` / `0.3.0-rc.1` 这条从未验证过的线，围栏形同虚设——这正是 2.1.2 修掉的缺陷形状。该口径由 `tests/dsh-line.spec.ts` 守卫。

> 🪟 **平台支持：Windows、macOS、Linux 三者并列支持。** **Windows 是一等目标平台**，不是「顺带能跑」：CI 在 `windows-latest` 上跑完整套件，凭据路径、进程心跳、App 可执行文件定位、设置写入四处都有 Windows 专属分支与测试，并且**修复只对 Windows 生效的缺陷时，以 Windows 用户回报的现场与真机取证的加密向量为准**（见 [CHANGELOG](CHANGELOG.md) 的 2.0.6 / 2.0.11 / 2.0.12 各节）。见下方[平台支持](#平台支持)一节了解各平台的具体差异与已知限制。

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

## 平台支持

三个平台都是受支持目标；下列差异是**实现事实**，不是「尚未支持」的委婉说法。要改这一节，请同时改 [`docs/WINDOWS.md`](docs/WINDOWS.md)——那份文件是平台相关约束的登记处。

| 方面 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 凭据默认目录 | `%LOCALAPPDATA%` / `%APPDATA%` 优先，未设时回落 `<home>\AppData`（重定向配置文件仍可解析） | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth` | `$XDG_CONFIG_HOME` 优先，未设时回落 `~/.config` |
| 桌面 App 可执行文件 | `%LOCALAPPDATA%\Programs\WorkBuddy`、`%LOCALAPPDATA%\WorkBuddy`、两个 `Program Files`（按 `WorkBuddy.exe` 定位） | 读 bundle 的 `Info.plist` 取 `CFBundleExecutable`（真实值 **`Electron`**，不是按 App 名猜）；含国际版 `WorkBuddy AI.app` 与 `/Applications` 下的子目录 | 不适用（加密凭据场景下 Linux 无对应 App；用 `WORKBUDDY_AUTH_FILE` 指定凭据） |
| 进程心跳的时间戳来源 | PowerShell `Get-Process` 的 `StartTime`（POSIX 无 `ps -lstart` 等价物） | `ps -o lstart=` | `ps -o lstart=` |
| 子进程的窗口 | **必须 `windowsHide`**：宿主本身没有控制台（GUI 进程），漏设会让每次探测都在屏幕上闪一个可见的黑框 | 不适用（该选项仅 Windows 生效） | 不适用 |
| 设置写入的瞬时占用 | **会踩到**：profile 的配置文件 `cordis.patch.yml` 被杀毒软件 / OneDrive / 编辑器短暂锁定会拒绝 rename 覆盖，`@deepseek-ai/dsh-atomic-write` 的重试**只在 `win32` 生效** | 不踩：POSIX 的 rename 直接替换，同一段代码不进重试分支 | 同 macOS |
| CI 覆盖 | `windows-latest` 跑完整套件 | 开发者本机（macOS） | `ubuntu-latest` 跑完整套件 |

**Windows 上需要知道的三个具体点**：

1. **账号改动可能保存失败**（profile 的配置文件 `cordis.patch.yml` 被占用）。插件会在写入后**回读校验**：确认落盘才显示「已清除」，失败则明确报错并保留原选择。遇到提示时关闭占用该文件的程序后重试。详见[已知限制](#已知限制)。
2. **凭据路径已部分经真机验证**。候选列表按平台约定推导并有单元测试钉住（含 `LOCALAPPDATA` / `APPDATA` 缺省与空白串两种回落）。已在真实 Windows 11 上确认：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth` 与 `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe` **命中**，加密凭据的 `keyId` 与登记向量逐字一致。**其余候选仍未经真机逐项验证**——若你的凭据或 App 不在默认位置，用 `WORKBUDDY_AUTH_FILE` / `WORKBUDDY_APP_EXECUTABLE` 指定，并欢迎回报现场。
3. **加密凭据（5.6.0 起）需要桌面 App 在场**，Windows 与 macOS 同样如此；App 装在自定义目录（如 `E:\WorkBuddy\WorkBuddy.exe`）时用 `WORKBUDDY_APP_EXECUTABLE` 指定。

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
- **Windows：profile 的配置文件 `cordis.patch.yml` 被占用时，账号改动可能无法保存**。DSH 用「写临时文件 + 覆盖替换」的方式更新该文件，而杀毒软件、OneDrive 等同步盘或正在打开该文件的编辑器会短暂锁住它；重试耗尽后，写入失败**不会**让 `set()` 报错。插件因此会在写入后回读校验：**确认落盘才显示「已清除」**，失败则给出明确错误并保留原来的选择（不会显示一个旧选择默默反驳的假确认）。遇到该提示时，关闭占用该文件的程序后重试即可。
- Windows / Linux 的凭据默认路径按平台约定推导。已在真实 Windows 11 上确认 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth` 与 `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe` 命中，**其余候选与 Linux 路径仍未经真机验证**；必要时可通过环境变量 `WORKBUDDY_AUTH_FILE` 指定实际位置。
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
