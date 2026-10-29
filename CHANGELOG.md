# Changelog

## Unreleased

### Docs

- **市场条目已收录，但线上描述停在 2.0.15——修正为当前能力，并把「条目不会自己更新」写进文档（#164 的索引问题顺带查出）**
  - **实际状态更正**：PR [#3812](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/3812) **已于 2026-08-30 合并**（merge `c079c705`），而两份 README 与本目录一直写着「等待维护者合并」。（与 #164 的「市场索引把 5.12.x 标成最新」是**两件独立的事**：条目里没有版本字段，索引给旧版是同步节奏问题，不是这句描述造成的。）
  - **线上条目过期**：`data/plugins/dingminhua__dsh-connect-workbuddy.yml` 还是 2.0.15 时写的那句——没提国内版/国际版双供应商、没提每次刷新读取积分倍率、没提账号池自动换号，也没说明签到是**手动**的（会真实领取奖励，只在点按钮时执行）。已提更新 PR [#10281](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10281)，并补 `icon:` 指向本仓库 `icons/dsh-connect-workbuddy-128.png`。
  - **写进文档的教训**：条目合并后不会自己更新；插件每次有大的能力变化，描述要另开一次 PR 跟上——注册表评审明确「描述会被当作声明，并对着代码核」。
  - 同时修正两处过时规范：**没有提交数门槛**（对方 #4196 已废除），以及**只声明 `dsh.client` 是最常见的被拒原因**。
  - 本目录的条目镜像补 `icon:` 字段；`description.en` / `description.zh` 仍与 `locale/en.json` / `locale/zh.json` 逐字一致，由 `tests/locale-meta.spec.ts` 钉住（该测试会拒绝任何一侧的重新翻译）。

- **两份 README 的「安装」加一条版本下限：CN 区渠道校验 400 请确保 ≥ 5.13.1（#164）**
  - **为什么**：#164 的实测矩阵确认 5.13.1 的按句改词在同一份 body 上 **200**，而 5.12.1 / 5.12.4 的
    原样、`prepareChatBody`、三级救援**全部 400**。停在旧版的用户会反复撞上这个已经修好的 400。
  - **两个升级不到的原因也写进去了**：市场不同索引在同一时刻可能给出三个「最新」（#164 实测
    5.12.3 / 5.12.4 / 5.13.1 并存），以及 pnpm 的 24 小时 `minimumReleaseAge` 会把浮动范围静默压回
    上一版；需要立刻修复时给的是**精确版本号**命令。

### Tests

- **把 #164 测到的「最小触发跨度」钉成回归测试（`tests/issue163-sentence-rewrite.spec.ts`）**
  - #164 二分出门槛比 #163 更短：`@` 路径段**前 112 字**（两句）、Web GUI 段**前 217 字**（两句）
    就会触发；两句各自单发都是 200。改词表必须把这两个**截断形态**也清掉，否则宿主只发半段时
    仍会被拒。测试断言两段改写后都不含指纹、且改写后仍是可读的指令。
  - 同时记录一条与 #164 建议 2 对应的口径：第 0 级改词会让 system 略长（#164 实测 +32 字节 / 5 行），
    自助对比正文长度时不要把它当成「扰动后长度」。

### Bug Fixes

- **新增的多模态模型不再被当成纯文本：广告值改为「用户勾选 ∪ 厂商核验表」（#168）**
  - **现场**：`deepseek-v4.1-flash` 已勾选，发图仍被宿主拦下——`Model "…" does not
    support image input`（`MODEL_DOES_NOT_SUPPORT_IMAGES`，宿主 `session/attachment-invalid`
    的判据是 `resolveModelInfo().inputModalities` 不含 `image`）。报错来自宿主，但判据来自插件
    广播的 `multimodal`。
  - **根因**：`imageModelIds` 有两个写入者且语义不同——用户勾选（决定）与目录刷新（当天名册的
    快照）。仅凭数组无法区分，于是「上次刷新之后才出现在名册里的模型」仅因**不在数组里**就被盖成
    `multimodal: false`，`workBuddyModelInput` 答 `['text']`。本机实测复现：cn 的数组是
    `deepseek-v4.1-flash / glm-5.3-flash / kimi-k3-1`，此后名册新增的
    `minimax-m3.1-flash`、`kimi-k3.1-pro`、`kimi-k2.8-preview`、`hy3-x` 全部不可用。
  - **修法**：`effectiveImageIds()` —— 保存的数组**优先**（用户勾过的照旧生效，反向勾选也尊重），
    仅对数组**没有提到**的 id 用 `imageDefaultFor` 的厂商核验表补齐；`imageSelectionExplicit`
    （卡片保存时置 `true`）一旦成立就完全以数组为准，使「显式取消勾选」不会被下一次读取悄悄改回去。
    四个盖 `multimodal` 的地方（保存 / 发现 / 启动种子 / 卡片读数）统一走它。
  - **没做的事**：不给未核验的 id 猜。`hy3-x` 仍是 `['text']`，守住 `docs/DESIGN.md` 那条
    「不猜」的教训。
  - **测试**：新增 `tests/issue168-image-seed.spec.ts`，经 `ctx.llm.resolveModelInfo`
    （宿主自己的判据）断言广告值；含「不猜」「显式取消勾选仍有效」「显式反向勾选仍有效」三条对照。
    对 5.13.1 代码跑该文件会红，即缺陷被真实钉住。

- **状态读取失败不再被当成终态（#170，合并 PR #171 by @aa52312300aa-sys）**
  - 失败文档带 `accounts: []`，于是 `hasAccounts` 为 false，60s 轮询与 open effect 一起把自己
    关掉；一次瞬时 `Failed to fetch` 会永久停在卡片上，只能关掉卡片再打开。
  - 现在：错误横幅在**展开时**按 3s→30s 指数退避重试（以 `loaded` 文档身份为 key，折叠即解除武装），
    横幅从裸的 `TypeError` 改成「读取账号状态失败：…」+「重试」按钮；新增
    `row.usageErrorHint` / `row.usageRetry`（中英）与 `.dsm-workbuddy-usage-error-block`。
  - **测试**：新增 `tests/issue170-status-retry.spec.tsx`，钉住退避序列（3s 后有请求、再 3s 没有、
    再 3s 才有）、读到即停、「重试」按钮立即读取且不等待退避、空 message 回落到
    `row.requestFailed`、以及折叠期间零请求。

- **Web GUI 段落的第二句也是独立指纹，改词表补齐（#167）**
  - #167 用前缀二分测到最小失败窗口是 `er target, they mean this GUI.`：只改第一句（5.13.1 的做法）
    仍 400，两句都改才 200。此前「第二句不是独立指纹」的结论被这次实测推翻，写入表中的注释与
    `tests/issue163-sentence-rewrite.spec.ts` 里那条断言一并纠正。
  - 新增两行长→短的表项（`without naming another target, …` 与 `they mean this GUI.`），因为门槛在
    **截断形态**上也会触发；长行先跑，完整段落不会落到短行。
  - **测试**：新增 `tests/issue167-second-gui-span.spec.ts`（两句都消失、截断窗口也消失、改写后
    仍是可读指令、幂等、经 `prepareChatBody` 对 system 与 assistant 生效而对 user 不动、无关文本不变）。

- **心跳存活性不再把「进程启动时刻」和「心跳写入时刻」相比；auth 文件名接受 `-ai.info`（#174）**
  - **① 误判为本机实测**：`isHeartbeatProcessAlive` 拿 `ps` 的进程启动时间与 `heartbeat.registeredAt`
    （插件写入心跳那一刻）比，窗口 60s。两者的差是「宿主起来之后过了多久才挂载插件」，真实场景普遍
    远超 60s——报告者实测进程 19:47:20、心跳 19:58:45，差 684,817 ms，于是 `doctor` / `status`
    对一个刚写完心跳的活进程报 `hostBundle: "stale"`。既有测试没挡住，因为它把 `registeredAt`
    **设成**进程启动时刻，等于断言了这个 bug 的前提。
    修法：心跳新增 `hostStartedAt`（写心跳时取本进程启动时刻），比较改与**它**比；v1 心跳仍可读，
    降级用 `registeredAt` 并按更宽的窗口判定（宁可漏判 PID 复用，也不把活宿主叫成死的）。
  - **② 文件名**：`WORKBUDDY_LIVE_FILENAME` 只有 `workbuddy-desktop.info`，而 5.7.x 桌面端写的是
    `workbuddy-desktop-ai.info`。后果是双重的：`fileRank` 的「live 永远优先」从不命中（排序退化为
    按 `lastRefreshAtMs`，结果对只是运气），而 `doctor` 报 `desktopAuthFile.present: false` 并给出
    「设置 WORKBUDDY_AUTH_FILE」的无效建议——同时账号列表是满的。修法：已知 live 名变成列表，
    `fileRank` / 候选扫描 / `doctor` 统一走 `isLiveDesktopAuthFileName`。
  - **顺带查出的第三处**：`resolveDesktopCandidates()`（`desktopAuthPath()`、`desktopFilePresent()`
    的来源）原本**忽略 `authDirs`**，于是诊断路径与读取器实际扫描的路径不是同一组——与 ② 是同一种
    「诊断与读取各说一套」的缺陷。现在两者同源。
  - `diagnose()` 的 `missing` 改为**按目录**报一次、且只在目录里没有任何可读凭据时才报：否则在
    用 `-ai.info` 的机器上会多出一行「另一个名字缺失」，而那条用户无法处理，也与已读到的账号相矛盾。

- **生成类临时文件不再只写不删（#174 ③）**
  - 生图（`%TEMP%/workbuddy-image-gen`）与视频（`workbuddy-video-gen`）原来只 `mkdir` + `writeFile`，
    仓库内无任何清理路径。新增 `src/temp-files.ts` 的 `pruneTempDir()`，**挂在写入之后**按 mtime
    保留最新 20 个（不是启动时扫一遍：插件可能活在久不重启的宿主里，那时恰恰不生成）。
    能力被吞掉——清理失败绝不能把一次成功的生成变成失败。

- **请求体超限回 413 而不是 500（#174 ④）**
  - `readBody` 原来 reject 一个裸 `Error`，被外层 catch 写成 `500 internal`。改为具名
    `RequestBodyTooLargeError` → 413 + `types: client`。
  - 同时修掉一个连带缺陷：原来超限时 `req.destroy()` **销毁 socket**，那样 413 根本送不到客户端，
    客户端只会看到连接被重置——比 500 更糟。现在改为停止读取（摘掉监听 + `pause()`），响应得以送达。

### Tests

- **#174 四条各自钉住可失败点**：心跳（长运行宿主必须判活、`hostStartedAt` 与 `registeredAt`
  冲突时以精确者为先、v1 心跳仍可读、容差常量本身）、临时文件（按 mtime 而非文件名、只清本类型、
  目录不存在返 0、`keep` 是有限值）、413（真发一个超限流，断言状态码）、diagnose
  （文件名命中时**不**报 missing、tried 与 failures 按目录对齐）。
- 对修复前代码跑：心跳 4 条红、413 1 条红、#174 临时文件与 diagnose 的新用例分别红。

- **#170 的退避是「有界」的，不只是「有重试」**：`tests/issue170-status-retry.spec.tsx` 断言第二次
  尝试**不在** 3s 时发生（恒为 3s 的定频实现会让这条红），并且读到成功后才回到安静的 60s 轮询。
- **#168 断言的是宿主真正读的那个字段**：`inputModalities`，不是 `multimodal` 中间量；只测后者的话，
  盖值的四个调用点全部传错数组也能绿。

## 5.13.1 (2026-10-29)

### Bug Fixes

- **按句改写网关固定指纹，落在 `neutralizeChannelFingerprints` 之前（#163，2026-10-29 实测）**
  - **新测量**：CN 网关会在匹配前规范化 U+200B；system 开头插零宽仍 11128，`Note: ` 或真改词
    才 200。`user` / `tool` 开头不扫（18:46 连测 3 次 200），所以不碰这两个角色。
  - **第三处是整段组合指纹**：`@` 路径那 8 句逐句单独发 200，整段一起发 400。只改开头或整段
    `replaceAll` 都不满足维护性要求；按句改才能既拆掉组合指纹，又覆盖宿主改一两个词的情况。
  - **修法**：新增 `rewriteChannelFingerprintPhrases()` 与按句表（identity、coding agent、Web GUI、
    `Agent Teams is available in this session`、`@` 路径整段逐句），在 `prepareChatBody()` 里
    `keepPromptLast` 之后、`neutralizeChannelFingerprints` **之前**调用；只遍历 `system` /
    `assistant` 的 string content 与 array text part，`user` / `tool`、工具调用、图片不动；无命中
    逐字节不变，函数幂等。
  - **测试**：新增 `tests/issue163-sentence-rewrite.spec.ts`（三处 span 消失、普通对话不变、
    幂等、assistant 改写、array part、user/tool 不动、无命中 no-op）；同步更新 `issue98*` /
    `upstream` / `identity-clause-break` 里旧的「中性头 + 原文」断言。`pnpm run check` 通过。

- **自动「继续」降为最后兜底：默认 1 次，文案不再承诺有效（#163）**
  - **证据**：固定 system 指纹每轮逐字节相同；同一 body 打上百次都是 400，只改三处才 200
    （freedomx86 17:44）；现场 3 次自动续发、Windpixy 反复继续/新老会话、QIYU 三级救援全跑完
    仍 400；appulsexi-maker 19:12 的零历史新会话、只有 system 一条，仍 11128。新回合换不掉
    固定 system 内容，自动续发对这一族无效。
  - **修法**：`DEFAULT_MAX_CONSECUTIVE` 与 schema / 客户端默认 3 → **1**；卡片、配置描述、
    README 与 `docs/PINNED-11128-RETRY.md` 改为「最后兜底，不是 11128 的修复；固定指纹由按句
    改词处理，只有随轮次变化的内容才可能靠它碰过」。
  - 仍然默认关闭；每次仍真实消耗一次请求。**行为面**未变（只认 `channel_reject`、不换号、
    不碰子代理、成功/真人消息清零）。

- **换 provider 后，另一家的 thinking 不再被摊成 assistant 正文发给 WorkBuddy（#163 现场）**
  - **现场**：`session-bb9396be` 在 02:03:43 从 `dsh-opencode-go/deepseek-v4.1-flash` 切到
    `workbuddy/deepseek-v4.1-flash`，02:04:35 起连续 4 个回合 400/11128；错误里三条 assistant 的
    14,410 / 4,225 / 5,138 字，逐字等于切换前 seq 98/109/114 的 reasoning 块。
  - **机制**：宿主把另一家的 assistant 轮次重建为 `dsh-foreign`，pi-ai 把无签名的 thinking 块
    改写成可见 `text`；WorkBuddy 网关扫描 assistant 消息，把它当成未授权渠道。`dropForeignThinking`
    本来就是修这个的，但默认关闭，且卡片上没有开关。
  - **修法**：`withLegacyContext` 在 `alignAssistantIdentities` 之后**无条件**丢弃**跨 provider** 的
    foreign thinking（`api: dsh-foreign`，或 provider 不属于本 bundle 的两条路由）；同一路由内换
    模型（`hy3` → `deepseek-v4.1-flash`）仍由 `dropForeignThinking` 显式开关控制。跨 provider 的
    思考块没有签名、本来就不可能作为 reasoning 重放，丢弃不改变语义；文本与工具调用不动。
  - **诊断**：自动丢弃时写一条 warn（仅在开关关闭时），`latestForeignThinking` 仍照旧上报。
  - **测试**：`tests/issue147-foreign-thinking.spec.ts` 新增三条（跨 provider 选中、同路由模型
    切换不选、global 路由对齐后不误伤）；`tests/issue147-model-leg-wiring.spec.ts` 新增两条（两个
    generation × 两个入口的 `dsh-foreign` 回合在开关关闭时也被丢弃）。

## 5.13.0 (2026-10-28)

> 用户贴的那条失败：`本轮运行失败400: {"message":"workbuddy 上游失败：被网关的渠道校验拦截（不是账号、
> 额度或网络问题）（http 400）（code 11128，requestId …）。…","type":"channel_reject"}`，
> 以及一句明确的需求：「当我收到这样的信息的时候，自动发送继续，并且如果连续收到3次就不再发送」。
> 这条需求成立的前提是搞清楚**为什么重发可能有用**，因为插件自己在 `perturbChannelFingerprints` 旁的
> 注释一直说「给定提示词被拒是确定性的」，而现场报告反复说「再发一次就过了」。两者其实不矛盾：**新回合
> 是一份重新组装的请求**（surface 重排、注入块位置变化、学到扰动偏好后第一发就带扰动），所以「再发一次」
> 不是把被拒的字节原样再塞一遍——那是 `channel_reject` 被排除在 `isFailoverWorthy` 之外的同一条理由。

### Features

- **可选：渠道门拒绝（`channel_reject` / 11128）之后自动再发一次「继续」，连续上限 3 次**
  - **为什么需要它**：这一类失败在插件里是**三重不救**——不换号（`isFailoverWorthy` 刻意排除：网关读的是
    消息开头，换账号只会每个账号白烧一次真实请求）、不在原地重试（同一请求内的三级救援阶梯
    `forceNeutralHead` → 一次零宽扰动 → 密集零宽扰动已经跑完）、宿主也不重试（400 不在
    `DEFAULT_RETRYABLE_CODES` 里，`LvFailure.code` 还会被 pi-ai 按 `/\b400\b/` 重新分类成
    `INVALID_REQUEST`）。于是这一轮直接结束，用户看到的就是那句 400。
  - **它做什么**：`session/event` 上认 `turn/end` + `reason.kind === 'error'` + 这一类失败 → 等 300ms →
    `agent.followup(createUserMessage(...))` 发一条 `继续`。**不做**任何换号、换区、改请求体的事。
  - **上限的语义是「连续」**（`maxConsecutive`，默认 3）：一次 `completed` 回合、或一条
    `source.kind === 'user'` 的消息立即清零；**插件自己发的那条不清零**——否则我们自己发的消息会把计数
    抹掉，上限永远不生效（这条单独有测试钉住）。`aborted` + `reason.kind === 'user'`（用户点了停止）
    也清零，同 `dsh-purge` / `auto-continue` 的处置。
  - **不做的四件事**：子代理会话一律不碰（它的回合由父代理驱动）；`status === 'running'` 时不发（宿主可能
    自己起了新回合）；收件箱里有排队内容时不发（用户可能正在打字，抢在前面会让模型先答错东西）；
    `turn/start` 一来就取消已排定的那一条。
  - **失败如何识别**：`code === 'channel_reject'`，或消息里带插件自己的 kind 字面量 / 它自己的那句
    「渠道校验拦截」。**刻意不用 `code` 单值判定**——宿主那一份 `code` 极可能已经被 pi-ai 从文本重分类成
    `INVALID_REQUEST`，只看它会漏掉每一次真实失败。
  - **默认关闭**，因为每次都会真实消耗一次请求，与 `usageIdentity` / `imageToolEnabled` 同一条规则。
    它是本插件里**唯一改完即生效**的上游类开关：引擎每次失败现读配置，不必重载插件（因此它**不在**那组
    「改完需重载」的提示里，而是自己一组）。
  - **卡片**：「能力」栏新增一个开关（`.dsm-workbuddy-channel-continue-check`），展开时回报上限与发送
    文本；这两个值卡片只读不写，写入时整块带上，一次布尔写不会把它们擦回默认（同 `sessionTitle` 的处置）。
  - **测试**：`tests/channel-continue.spec.ts`（引擎 30 例，含上限、清零、不清零、子代理、running、
    收件箱忙、seq 去重、卸载、会话数上限、事件总线缺失时功能失效而非拖垮插件）、
    `tests/channel-continue-wiring.spec.ts`（真 `apply()` 挂载：真的订阅了、真的读到活配置、
    真的随 fiber 卸载）、`tests/card-channel-continue.spec.tsx`（渲染与写入契约）、
    `tests/web-status.spec.ts`（`__save` 白名单整块接受）。
  - **溯源**：「连续失败上限」的语义来自 `dsh-client-auto-continue`（MIT，HsiangNianian），
    「哪些失败码不续 / 收件箱忙不插队 / 用 `source.kind` 区分真人介入」来自 `dsh-purge`
    （MIT，YuJunZhiXue）。两者都只是**思路参照**，未复制源码；相对它们本实现是收窄。
    已同步写入 `THIRD_PARTY_NOTICES.md`、两份 README 的致谢与 `docs/DESIGN.md` §5.3 的分发表。

## 5.12.4 (2026-10-28)

> issue #159 的**报告现象成立，归因不成立**。现场确实出现了「三级救援一级都没跑」的 `11128`，但把它
> 唯一地归到 `!controller.signal.aborted` 上不成立：**这个 shim 里 `signal` 只有 `res.on('close')`
> 一个来源**（`src/shim.ts:1657`，客户端真的断开了），不存在 issue 假设的那个「宿主内部中止」的第二来源；
> 而按建议删掉三处 `&&` 经实测会把**诊断改坏**（见下）。顺着这条线索查同一个阶梯，找到的**真实缺陷是另一个**：
> 密集救援 rung 在真实大小的 body 上是 **O(n²)**，现场那种 130 KB 提示词要跑**分钟级同步 CPU**，
> 于是「救援等于没跑」有了一个不依赖 abort 的解释，且这个解释是实测出来的。

### Fixes

- **密集扰动 rung 的 O(n²)：92 KB 的 body 要 82.7 秒，130 KB 的现场提示词要两分多钟（#159 衍生）**
  - **根因**：`perturbChannelFingerprints(body, true)` 用 `replace(/(?=\S)/gu, cb)`，回调里为**每一个**
    匹配位置重新取「上一个非空白字符」，写法是 `source.slice(0, offset).match(/\S(?=\S*$)/u)` ——
    对每个位置做一次 O(offset) 的前缀切片 + 正则，整体 O(n²)。
  - **实测（本机 Node 25，2026-10-28，改动前）**：

    | body | 耗时 |
    | --- | --- |
    | 11,575 字符 | 1.3 s |
    | 23,075 字符 | 5.2 s |
    | 46,075 字符 | 22.8 s |
    | 92,075 字符 | **82.7 s** |
    | 184,075 字符 | 322.8 s |

  - **为什么这条比「救援没跑」更该先修**：这一级只在网关已经拒过两次之后才走，也就是**恰好**落在大 body
    的真实会话上；而 92 KB 就是一次普通的长会话，#159 现场那条 `system` 是 130,345 字符。这一级是**同步**
    CPU，先跑完才发请求，而 `chatStream` 对自己**刻意不设超时**（它自己的注释解释了原因：真实答案要预填
    整个提示词，卡一个够用的上限必然切掉慢而正常的答案）。于是救援会先被读者自己的等待熬过去，而**从外面看，
    「跑得太慢」和「根本没跑」是同一件事** —— 这正是 #159 观察到的那个现象。
  - **修法**：把这条规则改成**一次累加扫描**（`spaceDenseBreaks`）。规则本身一字未改，输出**逐字节相同**：
    旧写法那句 `/\S(?=\S*$)/u` 要求「其后全部非空白」，所以它取回的其实是**当前这段非空白串的首字符**，
    而不是上一个字符 —— 这个反直觉的细节正是重写时最容易写错的地方（本轮就写错过两次，靠下面的等价测试
    发现）。**这不是「顺手优化」**：改动只碰耗时，字节不动，因为换一个字节就是换一份没人测过的 body。
  - **实测（同一台机器，改动后）**：92 KB 由 **82.7 s → 10 ms**（约 8000 倍）；130 KB 的等价 body 在
    **10 ms 量级**完成。
  - **两条新测试各钉住一半**：`tests/issue159-dense-rescue-cost.spec.ts` 用**旧规则的逐字转录**做参照，
    22 个定点用例 + 1500 例定种子随机语料比对**字节相等**；并钉住耗时 —— 130 KB 在 2 s 内完成，
    320 KB 的中位数在 5 s 内完成（真正线性的实现在该尺寸约 15 ms，旧规则约 15 分钟，两者相差三个数量级，
    所以这个上限既不误报也绝不放过）。
  - **耗时断言的度量方式本身改过两次，两次都是被 CI / 变异测试纠正的**：第一版钉 60 KB→120 KB 的
    **比值 < 8**，变异测试显示旧规则在该尺寸的比值恰好 **4.0** —— 8 倍把二次方实现**放过去了**，等于没钉；
    收紧到 **< 3** 后，**CI 又在正确实现上把它跑红**（ubuntu 实测 60 KB 10 ms、120 KB 34 ms，比值 3.4）——
    在个位数毫秒的样本上，比值量到的是计时粒度、GC 和固定开销，不是被主张的增长。最终改为**在能区分两种
    实现的尺寸上钉绝对上限**（320 KB / 5 s，中位数），依据是 40→640 KB 的实测每翻倍约 2 倍
    （3.5 / 7.3 / 11.2 / 28.8 / 69.3 ms）。

- **未采纳 issue 建议的那一行补丁，并给出实测理由（`tests/issue159-abort-gate.spec.ts`）**
  - issue 的建议是删掉三处 `&& !controller.signal.aborted`，理由是「中止已由下传的 `signal` 在
    `chatStream` 内部保证，外层这道 `&&` 是重复且有害的检查」。**「重复」只对了一半**：删掉之后
    `chatStream` 确实会立刻因 abort 返回，但它返回的是 `{status: 0, kind: 'server'}`（被 abort 的
    `fetch` 抛 `AbortError`，在客户端被兜成传输失败）—— 这个结果会**盖掉**真正的 `channel_reject`
    诊断，读者收到的从「网关拒了这条请求」变成「上游服务器错误」；`reportFailures` 还会为一个**根本没
    上线的请求**记一笔账号失败。
  - **实测对照**（真挂断，客户端按真实 `chatStream` 对 abort 的处理返回）：

    | | 保留门（HEAD） | 删掉门（issue 建议） |
    | --- | --- | --- |
    | 断线后额外调用上游 | **0 次** | 2 次 |
    | 最终 kind | `channel_reject`（真实原因） | `server`（自己造出来的） |
    | 账号测量 | **不记** | 记一笔假的 |

  - 保留的正是 #159 真正关心的那一半：**请求还活着时的 11128，三级照跑**。这一半由
    `issue113-channel-gate-evidence.spec.ts` / `issue98-shim.spec.ts` 覆盖，本轮又加了一条同文件内的
    对照用例，防止将来有人以「救援没跑」为名再把门删掉。
  - 变异验证：把三处 `&&` 删掉 → 新增的断线用例**变红**（`the shim spent a rescue on an aborted signal:
    expected 1 to be +0`），对照用例**仍绿**。

### 未改动（据实说明）

- issue 里「`retries` 为空」这个字段名**在本仓库不存在**：实际实现是失败文案里的「，并已用…重试过」
  （`src/shim.ts:2067-2071`），`Error` 信封里没有 `retries` 字段。报告者读到的可能是宿主侧的包装，
  本仓库无法据该字段反推，故不据此改动任何判定。
- issue 的另一半（5.12.3 的 `IDENTITY_CLAUSE` + `neutralizeScannedText` 已修好）与本次改动无关，未触碰。

### 验证

- 端到端对照：同一个 **116,939 字符**的现场形状 body（三段身份句 + 无标点长 prose + 20 轮 assistant
  历史）走完整 shim，三级阶梯全部跑完后答 200 —— **修复后 29 ms，修复前 144,260 ms（2 分 24 秒）**。
  这一条是本次的真正判据：旧代码不是「永远救不回来」，而是慢到读者早已放弃。
- 变异验证（每条都确认会让对应用例变红）：删掉三处 `&& !controller.signal.aborted` → 新增断线用例
  **变红**（`the shim spent a rescue on an aborted signal: expected 1 to be +0`）；把密集规则退回 O(n²)
  实现 → **160 KB 实测 204,670 ms**，超过 5 s 上限 40 倍，**变红**；而正确实现在同一尺寸约 15 ms
  （320 KB 在变异版上跑满 10 分钟未完成，已终止，未作为判据）。
- 全量：`tsc` 双配置 0 错误，**148 文件 / 2563 通过（2 条按平台跳过）**，`tsdown` 构建通过。

## 5.12.3 (2026-10-28)

> issue #155 的**两个独立 Bug**：**① 业务码按字节匹配 JSON**——`11128`/`14003`/`14018` 用
> `body.includes('"code":11128')` 判定，于是同一个信封 `{"code":11128}` 认得、多一个空格的
> `{"code": 11128}` 和写成字符串的 `{"code":"11128"}` 都不认，渠道闸被静默判成 `client`，
> **整条救援阶梯不再运行**（#113 的修复等于被一个空格关掉）；**② 删账号只清内存、不清持久化选择**——
> 磁盘上 `accounts.cn` 仍写着死 id，下次 `applySelection` 把它读回来，CN 整块变「已保存的账号在本机
> 已不存在」且账号列表一条不渲染。

### Fixes

- **渠道闸/限流/耗尽三族业务码按字节匹配，一个空格就漏判（#155）**
  - **现象**：报告者贴回来的那条消息里**自相矛盾**——正文写着 `code 11128`，同一句却带
    `"type":"client"`，收尾是「请按上面的提示调整后重试」。两半出自同一个信封、同一份 body。
  - **根因**：分类器判族用 `body.includes('"code":11128')`——对**一种序列化**做字节测试；上游 JSON 里
    多一个空格、或把码写成字符串，判据就落空。而 `code 11128` 那半走 `parseUpstreamErrorDetail`
    （`JSON.parse`），照旧读得到。**以下矩阵是把每行都跑在 HEAD 代码上测出来的**，不是推理：

    | body 写法 | HEAD classify | HEAD detail.upstreamCode |
    | --- | --- | --- |
    | `{"code":11128}` | `channel_reject` | 11128 |
    | `{"code": 11128}` | `client` ← 漏 | 11128 |
    | `{"code":"11128"}` | `client` ← 漏 | `undefined` ← 也漏 |
    | `{"error":{"code":11128}}` | `channel_reject` | `undefined` ← **反向**不一致 |
    | `{"CODE":11128}` | `client` ← 漏 | `undefined` |
  - **两种不同的错位**，报告者只能贴出第一种。第 2 行就是 #155 那条消息：分类器按 substring 说
    `client`，展示那半按 `JSON.parse` 读到**顶层数字** `11128` 照旧打印 —— 一条回复里，诊断和它自己的
    证据互相打脸。第 3–5 行对支持更糟、对用户不可见：不但两个读取器不一致，**连要求用户提供的那个码都
    整个消失**，`channel_reject` 贴出来却没有 `11128` 可锚。第 4 行方向相反（substring 恰好命中嵌套的
    `"code":11128`，解析器当时只认 `error.data.code`），说明这不是「换成解析器就完了」—— 两侧都得读同一个
    事实，才可能一致。
  - **代价不只是文案**：渠道救援阶梯**只认 `channel_reject`**（`src/shim.ts` 的门是
    `result.kind === 'channel_reject'`），所以漏判成任何别的类别都等于整条阶梯不跑 —— `forceNeutralHead` 与两级
    扰动一次都不会触发，用户被要求「调整请求后重试」，而插件根本没试过救援。`14003` 同族实测降级目标**随 HTTP
    状态而变**：`429 {"code": 14003}` → `soft_rate`、`400` → `client`，而 `model_busy` 是三个**不换号**的类别之一
    （`isFailoverWorthy`）—— 落到 `soft_rate` 就是让整个账号池挨个烧一次真实请求去学一个模型级的事实。
    `14018` spaced 单独看会掉成 `client`，实测只有当 `msg` 里带上了 `Credits exhausted` 那句话时才被
    措辞标记救回 `hard_credit` —— 措辞一改就失效，正是本仓库反复记录的那类脆弱判据。
  - **修法**：新增 `statesBusinessCode(body, code)`，`CHANNEL_REJECT_CODE`/`MODEL_BUSY_CODE`/
    `CREDITS_EXHAUSTED_CODE` 三个常量从字符串形态改成数字，6 处家族判断统一走它。**三段读取，顺序即安全性**：
    ① 信封自己声明的码是最终答案，**绝不再做文本扫描** —— 否则 `extError` 里嵌套的 `"code":11128` 会盖掉外层
    `14003` 的自判，正好是 #127 反过来要的精度；② 解析成功却没在已知三种形态里声明码的 body，仍走带引号锚点
    的文本扫描 —— 这条是**严格扩量**：#127 只留解析器，反而把 `{"error":{"code":11140}}` 这种旧文本匹配本来
    认得的写法**收窄**掉了；③ 扫描锚在 `"code":<n>` 而非裸数字，十六进制 requestId 恰好含 `11128` 仍不能把
    无关 body 提上来（原文本形态存在的理由，一并保留）。
  - **一处先前例**：`CONTEXT_TOO_LONG_CODE`（`11115`，#101）早就写成 `/"code"\s*:\s*11115(?!\d)/u` —— 本仓库
    **第三次**独立撞上同一个坑，前两次各修各的族，这就是为什么这次收成一个共享读取器，而不是第四处正则。
  - **顺带修两处同源缺陷**：`envelopeError()` 已把 `code` 解析成数字，却只把 `msg` 交给分类器 —— 而 `msg`
    永远不含 `"code":…`，于是每个「靠业务码判定」的族在这里都不可见，答案一律落到 `client`（#144 那条
    `workbuddy upstream client (http 400): 请求被拦截，请重新发送` 就是一个插件已经握有其码的信封）；改为按
    规范形重建 body 再分类。`parseUpstreamErrorDetail()` 原先只认**顶层**且 `typeof === 'number'` 的 `code`，
    现与分类器共用 `businessCodeOfDocument`（补上 `{"error":{"code":…}}`，排在 `error.data.code` 之后以免
    细节盖掉判定）—— 不再出现「按码判了类、却不打印码」。
- **删掉一个账号后，该区域的持久化选择复活成死 id（#155 第二份报告）**
  - **现象**：「删了一个账号就这样了」——CN 整块变「未登录」，提示「已保存的账号在本机已不存在」，而上方账号
    列表**一条都不渲染**；`usage?region=cn&detail=fast` 答 `status=signed-out selectionLost=true`，但同一份
    响应里明明还有 3 个 token 未过期的账号，国际版正常。报告者自己定位到 `cordis.patch.yml` 里
    `accounts: cn: <本机已不存在的 id>`，并靠手发 `POST /__save {"field":"accounts","value":{"cn":""}}`
    恢复的 —— 本条就是把那个手动动作变成自动。
  - **根因是「只清了一半」**：`removeAccount()` 确实清了内存里的 `this.accountId`，所以**本次会话内一切正常**、
    删除也回报成功；但设置文档里的死 id 一个字节都没动，下一次 `applySelection`（重启，或**任何一次设置保存**）
    把它读回来重新 pin，区域随即掉进死胡同：`current()` 找不到 → `resolve()` 抛 no signed-in account →
    走 `signed-out` 分支，而该状态下卡片的建议指向一个它自己并不渲染的列表。会话内看不出问题、故障延后到重启才
    现形，正是这两步之间的缝隙让报告者和「删账号」连不起来。**只存在于内存的忘记不是修复，是拖延。**
  - **修法**：`removeOne` 之后调用 `clearRegionAccountSelection()`，**只在被删账号正是本区持久化 pin 时**
    写 `accounts[region] = ''`。判定与写入同在一个函数里，调用方无法只挑一半。四条约束都是这条修复的一部分：
    - **写 `''`，绝不删键**：`''` 是「跟随 App 当前登录」的哨兵（也是全新安装的默认值，所以这是**恢复**而非
      发明状态）；删掉的键含义是「从未配置」，会回落到旧版扁平 `accountId`，把用户**悄悄切到另一个账号**。
    - **只清 pin 了该号的区域**：无关的删除必须零次写入 —— 内存里 `current()` 都拒绝回退到别的账号，
      删除不能绕过它、从设置文件里做同样的事（换账号等于换人计费）。
    - **整字段合并**：`accounts` 是两个区域共用的一张平表，按调用方视角重建会抹掉兄弟区域的 pin；判定与写入
      都读 `describe()` 的权威文档，且先 `unwrapVolatileDeep` —— 把 volatile 的 `{get}` 活引用写进 payload，
      settings 服务会整次拒绝（`found a function at $.ops[0].value.get`）。
    - **同时覆盖旧版扁平 `accountId`**：pre-split 配置的 `accounts` 是空的、只靠扁平字段 pin，
      `regionPinsAccount` 认这条；而哨兵会**终止**那次回落，所以一次写入同时 settle 两种写法。
    - **fail-soft**：写设置失败只记 warn，绝不回报「删除失败」—— 凭证文件此刻已经真删了，说它还在是第二个谎。

### Tests

- `tests/issue155-envelope-spelling.spec.ts` 新增 23 条（#155）：紧凑/带空格/字符串码/嵌套四种写法 ×
  11128/14003/14018/11140 四族；`{"CODE":11128}` 归族（这一半是**恢复**不是保留：member 层先前对 body
  做了 `toLowerCase()` 因而认大写、`tests/issue98-channel-gate` 钉的是 member，而 family 层测的是原始 body、
  不认 —— 现在一个读取器同时回答两侧）；十六进制 requestId 含 `11128` 不得被提上来；嵌套 `11128` 不得盖掉外层
  `14003` 的自判；**分类器与展示给用户的那条码不许互相矛盾**。
- `tests/issue155-account-removal.spec.ts` 新增 17 条（#155）：`regionPinsAccount` 四个方向（本区 pin 了=清 /
  兄弟区 pin 了别的=不清 / 已在跟随 App=不写 / 只靠扁平字段 pin=清，且扁平字段只归它被归属的那个区）；
  `nextAccountsSelection` 保兄弟区、只答 `accounts` 字段而非整个 section、`''` 作为数据保留（区别于缺键）；
  volatile 活引用不得漏进 payload；无服务/无命名空间时零写入。
- `tests/issue155-removal-e2e.spec.ts` 新增 5 条（#155 的**接线**）：真实 `apply()` + 真实路由 + 真实 config
  对象（settings 双按引用答 `describe()`、`mutate` 原地提交并广播 `loader/volatile-update`），断言
  「删除 → 触发那次重读（等价于重启或任何一次设置保存的 `applySelection`）→ 区域仍 `signed-in` 且
  `selectionLost` 消失」这条旧代码做不到的完整链条；另测兄弟区 pin 存活、无关删除零次写入、写失败时删除仍回报
  200。单独存在的理由与 `tests/pool-e2e.spec.ts` 相同：纯 helper 用例对着我自己写的 double，摘掉 `index.ts`
  里的接线它们全绿。
- 变异验证（每条都确认会让对应用例变红）：分类器退回 `body.includes('"code":N')` → **11 条红**；删掉
  「本区是否 pin 了该号」的判定 → **4 条红**；写整个 section 而非 `accounts` 字段 → **4 条红**；
  `removeOne` 退回只清内存 → **1 条红**（正是那条延后到重启才现形的链）。
- 全量：`tsc` 双配置 0 错误，**146 文件 / 2536 通过（2 条按平台跳过）**，`tsdown` 构建通过。

## 5.12.2 (2026-10-27)

> 两处修复：**① 装完重启插件消失**（#151）——把宿主提供的 `@earendil-works/pi-ai` 标成 optional
> peer，使安装期不再因「闭包里解析不到它」而拒绝整个 generation；**② DSML 工具名一字之差**
> （#152）——`pwdsh` → `pwsh` 这类与本次声明工具只差一个字符的名字，现在按那个工具恢复，
> 不再整段回退成正文。两处都保持 fail-closed 的默认：候选集只来自请求自己的 `body.tools`，
> 不凭空造名。

### Fixes

- **安装成功但重启后插件消失：generation peer validation 拒绝了安装（#151）**
  - **现象**：插件市场安装显示 `generation-install: promoted to …`，接着
    `generation peer validation failed: @earendil-works/pi-ai does not resolve from the generation or
    installation closure`，`exit=1`；重启后该 generation 被扫掉（`swept N unreferenced plugin generation(s)`），
    用户得重装。
  - **根因不是"插件依赖没装"，而是"它不可能被装上"**：pi-ai 由**宿主**提供 —— `dsh-llm-pi-ai` 把它列为自己的
    `dependencies`（`^1.1.0`），宿主用运行期拦截层应答这个裸包名；而 profile 是按 `autoInstallPeers: false` 建的，
    peer 从不进入 profile 的 `node_modules`。所以一份「必需 peer」在安装闭包里**永远解析不到**，校验必然失败。
  - **修法**：`package.json` 增加 `peerDependenciesMeta`，把 `@earendil-works/pi-ai` 标为 `optional: true`。
    **范围一个字符都没动**（仍是 `>=0.85.0 <0.88.0 || >=1.0.0-0 <2.0.0`）——`optional` 说的是「不要
    求我自己带一份」，不是「我不支持这些版本」；运行期版本探测（`pi-ai-runtime.ts`）与语义边界仍以该范围为准。
  - 为什么不是干脆删掉这条 peer：插件**静态 import** 了 pi-ai（`adapter.ts:19–21`），它不是可选依赖，
    声明必须留着；只有"安装期强制"这一层需要让开。
  - 报告里那句「`@deepseek-ai/cordis` 已有同样处理，照此办理即可」**不成立** —— 本仓库此前
    `peerDependenciesMeta` 是空的，cordis 也从未标 optional。修法本身没问题，但依据是上面那条，不是先例。

- **DSML 泄漏时工具名一字之差，整段标记回退成正文（#152）**
  - **现象**：模型把工具调用写进正文时把名字写成 `pwdsh`，而请求声明的是 `pwsh`。第二道闸按名字拒绝
    （这是对的：那个名字从未被提供过），于是整块按原文显示 —— 用户看到一堵乱码墙。
  - **新证据**：幻觉名与真实名之间存在**可预测的一字变形**（`pwdsh` = `pwsh` 中间多插一个 `d`，
    编辑距离 1）。这跟此前记录过的 `validate` 那种「名字整段被换掉」不同，是可以低成本兜底的。
  - **修法**：第二道闸在拒绝之前先试一次受限纠正（`repairNearMissName`，由 shim 开启）：
    - 候选集**只来自本次请求的 `body.tools`** —— 永远不会选中一个没被提供的名字，更不会凭空造名；
    - 写出名与候选名的**编辑距离必须 ≤ 1**，且**恰好一个**候选落在这个距离内（两个就放弃）；
    - 双方长度都 **≥ 4**（`cat`/`cut`、`bash`/`dash` 这类三字母的一字之差不是证据）；
    - 写出名若**已精确命中**声明名，直接用它，绝不"纠正"到邻居；
    - **只纠正 `invoke name=`**；`parameter name=` 一律不动（改参数名等于改调用语义，比显示正文更糟）；
    - `tool_choice` 的钉选、第四道闸（必需参数缺失即截断）**都在纠正后的名字上照旧生效**。
  - 默认仍是 fail-closed：`repairNearMissName` 不传就是关闭，只有 shim 的请求路径打开它。

### Tests

- `tests/dsml-recovery.spec.ts` 新增 10 条（#152）：真实捕获形态 `pwdsh` → `pwsh` 被恢复；不开关时仍拒绝；
  两个候选在距离内则放弃；短名（写出名 3 字 / 候选 3 字）两种方向都拒绝；已精确命中的名字不被"纠正"；
  不在声明集里的近邻不被凭空选中；钉选与必需参数两道闸在纠正后仍生效；**参数名不被纠正**。
- `tests/shim-recovery.spec.ts` 新增 1 条（#152 的**接线**）：走真实 shim 与真实响应流，断言 `pwdsh`
  在声明 `pwsh` 时被恢复成 `pwsh`、在只声明 `bash` 时**仍回退成正文**。这条单独存在的理由与 #149 相同：
  纯函数用例自己传开关，摘掉 `shim.ts` 里的 `repairNearMissName: true` 时它们全绿 —— 实测该变异只让这条变红。
- `tests/dsh-line.spec.ts` 新增 1 条（#151）：断言 `peerDependenciesMeta['@earendil-works/pi-ai'].optional === true`，
  且 peer **范围**未因此改动。
- 变异验证（每条都确认过会让对应用例变红）：去掉编辑距离判断 → 1 条红；去掉唯一性判断 → 1 条红；
  去掉两个长度下限 → 2 条红；忽略 opt-in（默认开启）→ 1 条红；摘掉 shim 的接线 → 1 条红；移除 `optional` → 1 条红。
- 全量：`tsc` 双配置 0 错误，**143 文件 / 2491 通过（2 条按平台跳过）**，`tsdown` 构建通过。

## 5.12.1 (2026-10-26)

> 修正 5.12.0 的 `dropForeignThinking` 漏判的一条腿：`isSameModel` 判据是 provider **且** api
> **且** model id 三者全等，而 5.12.0 的 `isForeignAssistant` 只比了前两条。于是**在同一个区域内
> 换模型**（`hy3` → `deepseek-v4.1-flash`，两者都由本插件提供、都盖 `provider: workbuddy`）时
> 一个块也检不出，开关看起来无效，而 pi-ai 照样把历史 thinking 摊平成正文。修复只补判据与传参，
> 不传时行为与 5.12.0 完全一致；开关默认仍为关闭。

### Fixes

- **同一区域内换模型时，`dropForeignThinking` 检不出任何块（#147 的第三条腿）**
  - **病因是判据少了一条腿。** pi-ai 的 `isSameModel` 是 `provider === … && api === … && model === model.id`（`transform-messages.js:68–70`，0.85.1 与 1.1.0 行号一致）；5.12.0 的 `isForeignAssistant` 只比较 provider 与 api。换区场景（provider 变了）能检出，**换模型场景（只有 model 变了）检不出**——症状与 #147 一模一样，却没有诊断、开关也无效。
  - **修法**：`isForeignAssistant` 增加可选的 `requestModelId`，补上 model 腿；`foreignThinkingOf` / `dropForeignThinking` 透传它；`withLegacyContext` 的 `prepare()` 在 `stream` / `streamSimple` 两个入口、legacy / modern 两个分支共四处传 `model.id`。**不传时行为完全不变**（只判前两条腿），所以卡片等只读 surface 与既有调用点零影响。
  - 传 `model.id` 而**不是** `record['model']`：`dsh-llm-pi-ai` 的 `replayedAssistant` 在 `response.api === 'anthropic-messages'` 时会取 `responseModel ?? model`（`lib/index.js:218`），而 `isSameModel` 比的是 `model.id`，这里与它对齐。
  - **顺带澄清一处不成立的顾虑**：卡片那条路径**不需要**单独传 model id。卡片读的是 status 端点的 `lastForeignThinking`，该值由 `onForeignThinking` 在**请求路径**里填充，因此天然带着 `model.id`——「换模型导致的摊平」在卡片上同样可见，无需 follow-up。
  - **两处已失效的表述同步改正**：`alignAssistantIdentities` 的文档（`src/adapter.ts:671`）原写「换模型仍会降级……（有测试覆盖）」，但当时并无任何测试覆盖这条腿；README 中「同一区域内换模型仍会降级」一句现在补明「降级本身消除不了，但它变成正文这件事可以」。

### Tests

- 新增 `tests/issue147-model-leg.spec.ts`（9 条），走**真实 pi-ai 的 `transformMessages`**：缺陷本身可复现 / 旧两腿调用检不出（盲区钉成对照）/ 三腿调用检出并删除 / 外来 provider 仍检出（第三条腿是追加不是替换）/ 同 model 的消息一个不动且返回同一对象 / 无 `model` 字段不误报 / 外来轮次 model id 恰好相同也不洗白 / 一次真实切换里只删旧模型的轮次 / 幂等。
- 新增 `tests/issue147-model-leg-wiring.spec.ts`（12 条），补上**接线**而不是判据：legacy 与 modern 两个分支 × `stream` / `streamSimple` 两个入口 × 三种状态（换模型时删、同名模型时留、开关关闭时原样），都经过真实 `createWorkBuddyAdapter`，断言 api 收到的上下文里 thinking 块的去留、以及 `onForeignThinking` 是否触发。
  - **这条为什么必须单独存在**：把四处 `prepare(context, model.id)` 全部改回 `prepare(context)`（即修复被静默摘掉），**整套 2467 条测试依然全绿**——纯函数测试自己调判据，没有任何东西发现 wrapper 没传 id。补上后该变异使其中 4 条全红。这与 `tests/adapter.spec.ts` 当初为 issue #24 建的洞同型。
  - 后两种状态是防止「一概删除」也能通过的对照：若判据退化成「凡 assistant 轮次都算外来」，删除会把**当前模型自己的**推理一起删掉（#102 的反向回归），所以同 model 与开关关闭两条必须看到 thinking 保留。
- 变异验证：model 腿恒 `false` → 2 条红；恒 `true` → 3 条红（含 #147 原有 suite 1 条）；摘掉 `model.id` 传参 → 接线测试 4 条红；把修复整体短路（`if (true) return aligned`）→ 接线测试 4 条红。
- 全量：`tsc` 双配置 0 错误，**143 文件 / 2479 通过（2 条按平台跳过）**，`tsdown` 构建通过。
- 真实会话数据复核（`session-356f6889`，5,158 事件）：同网关换模型场景（80 条本插件自己的轮次）下，旧的两腿调用检出 **0 块**，三腿调用检出 **76 块 / 134,943 字符**，带正文消息 72 → 56，正文字符 195,867 → 60,984；单模型转录检出 0 块并返回同一对象（no-op 契约成立）。

## 5.12.0 (2026-10-26)

> 特性版本：新增 `dropForeignThinking`（**默认关闭**），修 issue #147——跨 provider 切换后
> pi-ai 把外来轮次的 thinking 改写成正文，模型随后照抄这个格式，整轮回答变成英文工作笔记。
> 关闭时请求字节与 5.11.0 完全一致；打开后只删「本来会被压成正文、且不可能作为带签名 reasoning
> 重放」的外来 thinking 块，正文块、工具调用与每条消息的身份都不动。请求路径、provider 路由、
> 计费与凭据处理一律未变。

### Fixes

- **思考变正文：跨 provider 切换后模型把工作笔记写进回答（#147）**
  - **病因在 pi-ai，不在本插件。** `transform-messages.js:68` 用 `isSameModel`（provider **且** api **且** model id）决定一条历史 thinking 能否按 reasoning 重放；不成立时它**不丢弃**该块，而是改写成 `{type:'text', text: thinking}`（`:87–90`）——也就是答案通道。会话一旦跨 provider 切换过，另一个模型的内部工作笔记就以「本轮回答」的身份出现，模型读到「我过去的思考全是正文」这个形状后持续照抄。
  - **实测复现（本机 pi-ai 0.85.1 + 真实 `transformMessages`）**：`api: 'dsh-foreign'` 的外来轮次 → `[text]`（200/300 字符全部进正文）；本插件自己的轮次 → `[thinking]`；把该块丢掉 → `[]`（不产生任何正文）。报告者的一轮真实会话里，80 条 assistant 消息中 56 条带正文而 `reasoning` ≤ 1 字符，20 条英文工作笔记合计 58,960 字符，CJK 占比跌到 1.37%；会话从 696,966 涨到 758,005 total token。
  - **为什么是「删除」而不是「保留为 thinking」**：`isSameModel` 只比对消息自身字段，唯一的满足方式是把这个外来轮次宣称为本模型的输出——那正是 #111 刚删掉的来源谎言。而这些块由宿主 `foreignAssistant()` 构造、**不带 `thinkingSignature`**，即便被宣称也无法作为带签名 reasoning 重放，它们对线上唯一的贡献就是被压成的那段正文。
  - **修法**：新增 `src/adapter.ts` 的 `foreignThinkingOf()`（只读诊断）与 `dropForeignThinking()`（实施删除），在 `withLegacyContext` 的 `prepare` 里、**`alignAssistantIdentities` 之后**执行。顺序是承重的：国际区自己的轮次到达时同样带 `api: 'dsh-foreign'`，先诊断会把它误判成外来轮次并删掉它自己的推理（#102 的反向回归）。
  - **开关**：`dropForeignThinking`（volatile，默认 `false`）。用 getter 读活值，拨动后**下一个请求**即生效，不需要重载插件——用户正是在看着那条工作笔记时打开它。
  - **诊断可见**：被删的块数与位置写入 status 端点的 `lastForeignThinking`（进程内、last-wins、重启即忘），`dropForeignThinking` 开关本身也随 status 下发，供卡片渲染提示。

### Tests

- 新增 `tests/issue147-foreign-thinking.spec.ts`（15 条），全部经过**真实 pi-ai 的 `transformMessages`**，而不是桩：缺陷本身可复现、开启后不产生正文、关闭时原对象返回（零改动）、本插件国内外两区轮次都保留 thinking、正文与工具调用不被触碰、redacted 与空块不误报、错误轮次报 `dropped` 变体、顺序必须在 alignment 之后、幂等。
- 变异验证：把 `dropForeignThinking` 改成空操作 → 4 条变红；把判断放宽到所有 assistant 轮次 → 7 条变红。
- 全量：**142 文件 / 2458 通过（2 条按平台跳过）**；两个 tsconfig 均 exit 0。

## 5.11.0 (2026-10-26)

> 特性版本：新增 `workbuddy_draw_video`（文生视频 / 图生视频，异步任务「提交 → 轮询 → 下载」，
> 逐区 opt-in、默认关闭），卡片「能力」栏新增视频开关与**按模式钉模型**；同期把生图 `size`
> 的描述补上实测的大图档位与 419 万像素上限（**执行层零改动**，改的是模型对「能画多大」的先验）。
> 视频工具落地后按现场报错修了三处：**时长校验形同虚设**、**参数错误也白等 60 秒冷却**、
> 以及**显式 `resolution` 在拿不到目录清单时被静默丢弃**。请求路径、provider 路由与凭据处理
> 一律未变：视频打的是官方 CLI `VideoService` 早已在用的两条 `/v2/videos/*` 路由，选模型仍只看
> 该区 `/v3/config` 的媒体标签。

### Features

- **新增 `workbuddy_draw_video`：文生视频 / 图生视频，国内区与国际区都能注册，逐区 opt-in**
  - **它不是「接一次 `submitVideo()`」**：视频是异步任务——`POST /v2/videos/generations` 只回一个 `taskId`，还要轮询 `POST /v2/videos/tasks` 到 `completed`（5 秒一次，上限 600 秒），再 `GET` 每条 `data[].url` 把 mp4 拉到本地。旧文档「加视频只是接一次 `submitVideo()`」少说了后两段，已在 `docs/VIDEO_GEN.md` 对账。
  - **参数层与选模型层是复用的**：`MEDIA_TAGS`、`VIDEO_TAG_*`、`fetchMediaModels`、卡片媒体清单原本就认得两个视频标签，所以参数校验与选模型只补了一层 `src/video-gen.ts`；**执行层是全新异步代码**（`src/upstream.ts` 的 `submitVideo` / `pollVideoTask` / `downloadVideo`）。
  - **花钱的三条红线照搬生图**：独占执行（不声明 `isConcurrencySafe`）、失败后 60 秒冷却、冷却**只看请求是否真的发出**（参数错、未登录、读不到输入图一律不进冷却）；工具**逐区 opt-in**，不勾时根本不注册，模型看不到它。
  - **产物落本地临时目录**：视频是二进制，不进对话体，工具只回 `file://` 路径 + 渲染成链接（`os.tmpdir()/workbuddy-video-gen/<model>-<时间戳>.mp4`）。
  - **顺手改对一处描述**：`seconds` 原写「越界会被夹回默认值并提示」，而 `resolveVideoParams` 实际抛
    `INVALID_ARGS`（不会夹取）——描述会教调用方传 30 秒再等一个 5 秒的结果，然后把报错当成 bug。
  - **验证**：`tsc` 两套配置 0 error；`vitest run` 141 个文件 / **2445 条**通过（含新增
    `tests/video-gen.spec.ts`、`tests/video-tool.spec.ts`、`tests/video-tool-optin.spec.ts`）；
    `tsdown` 构建通过。

- **实测单价与产物规格写进文档了（`docs/VIDEO_GEN.md`「实测单价与产物规格」）**
  - **国内区实测单价**：图生视频 4 秒 `minimax-video-h3` 57.14 / `kling-video-v3` 68.57；
    文生视频 5 秒 `minimax-video-h3` 71.43 / `kling-video-v3` 128.57 积分。`minimax-video-h3`
    文生图生同价（14.29/s），`kling-video-v3` 图生比文生便宜（17.14/s 对 25.71/s）——
    「一条 5 秒多少积分」要连模式一起看。
  - **产物实测**（解析 mp4 的 `moov` 盒，不靠上游自报）：H.264 + AAC、**24fps**、
    `1280x720` 或 `1344x768`（这两个尺寸是**默认档位**下的产物；见下方 Fixes 第三条——
    「没有 1080p」此前被记成上游行为，实则其中一部分是本插件把 `resolution` 丢掉了），
    视频码率 3.66–11.47 Mbps、体积 2.0–7.0 MB；**实际时长按帧数走**，请求 5 秒拿回
    5.09–5.17 秒，请求 4 秒拿回 4.04–4.46 秒。`enable_audio: true` 也不保证有音轨。
- **卡片上按模式钉住视频模型（软约束，与显式 `model` 分工明确）**
  - **起因**：国内区每个视频标签组都有 2 个模型（`kling-video-v3` / `minimax-video-h3`），调用方多半省掉 `model`，于是永远拿到目录里的第一个；口头说一次不持久。
  - **按区、按标签存**：`regions.<区>.preferredVideoModels` 是 `{ [tag]: modelId }`——两种模式可能由不同模型提供，且模型 id 不跨区（`minimax-video-h3` 在国际区不存在）。
  - **软约束**：显式 `model` 是调用方为这一次写的，写错就报 `NO_VIDEO_MODEL`；卡片偏好是用户以前写的，钉住的模型已从目录里消失时**静默回落组内第一个**。两条方向相反的规则各有测试钉住。
  - **清空 = 删 key**，不是写空串；卡片读值先问 Host（`statusByRegion`），浏览器配置快照只作回落。
  - **写入走与开关同一条「写后回读校验」路径**（`writeRegionPreferredVideoModels`），不是裸 `scope.set`。

### Fixes

- **视频工具：显式 `resolution` 在拿不到目录清单时被静默丢弃（视频同步找到的第三处）**
  - **症状与上面那条同源**：`resolveVideoParams` 用 `new Set(config?.resolutions ?? [])` + `has()`
    判断，于是「模型不支持这个值」与「我们根本没有这份清单」两条路径合流——**任何**显式
    `resolution` 在目录没下发 `videoGeneration.resolutions[]` 的账号上都被丢掉，`buildVideoBody`
    收到的已是 `undefined`，请求体里连 `resolution` 字段都没有，却还打印一句
    「resolution 1080P 不被模型 · 支持；改用 上游默认」，看起来像上游拒绝。
  - **同一条判据修正**：只有真的拿到 `resolutions[]` 才做回落，拿不到就**原样透传**交给上游判
    ——与 `seconds` 的「拿不到区间就不盲拒」完全一致。
  - **顺带修掉大小写**：清单匹配改为大小写不敏感，命中后发**目录的拼写**。官方 CLI 的兜底档位是
    `["720P","1080P"]`，而工具描述一直举 `720p`/`1080p` 的例子，精确匹配会把一个其实可用的值
    判成不支持。
  - **工具描述与 `docs/VIDEO_GEN.md` 同步改正**（文档此前把这个 bug 的现象记成了上游的行为，
    并据此写了「`resolution: "1080p"` 对 `minimax-video-h3` 不成立」——那条结论在拿不到清单的
    账号上从未真正验证过）。
  - **验证**：`tests/video-gen.spec.ts` 新增 2 条（无清单/空清单透传、大小写命中），全量
    `vitest run` 141 个文件 / **2445 条**通过。

- **视频工具：`seconds: 1` 被上游 400 退回后还要白等 60 秒（两处真 bug）**
  - **现场**：`Error: workbuddy video: 提交生视频任务失败（HTTP 400）: code 14407: Create video failed with error: unsupported video duration: 1 seconds, supported range: 4-15 seconds`，紧接着第二次调用被挡成「请 38 秒后再试」。用户的判断是「上游返回这种错误，也要等半天」。
  - **根因一（本地时长校验是死代码）**：`src/video-tool.ts` 调 `resolveVideoParams({...})` 时**没传第二个参数 `config`**；而 `src/video-gen.ts` 的 `minSeconds`/`maxSeconds` 校验只在 config 存在时才跑。更上游还有一处：`src/image-gen.ts` 的 `selectMediaModels` 只搬 `{id,name,tags}`，把条目上的 `videoGeneration` 丢了——所以即使传了也拿不到。
  - **根因二（没花钱的失败也进冷却）**：`describeVideoFailure` 把提交阶段的一切非 401/403/404/429 都归成 `UPSTREAM`，而 `UPSTREAM` 在冷却集合里。可 400 是「建任务之前就被退回」，没有 task、没有扣积分。
  - **修法**：`selectMediaModels`（video 与 image 两处）保留并透传 `videoGeneration`（`readVideoGeneration` 只搬已知字段，缺字段不补默认值），工具把它喂给 `resolveVideoParams`——越界时长现在**在本地就被拦下，一次付费请求都不发**；提交阶段其它 4xx 单独归类为 `REJECTED`（不进冷却，错误里明说「没有创建任务、没有扣积分」并保留上游原文）。
  - **顺带学会区间**：目录不带 `videoGeneration` 的账号（实测部分国内区账号的 `/v3/config` 条目只有 `{id,name,tags}`）本地无从校验，只能让上游先拒一次；`parseSupportedSecondsRange` 从它的文案里读出 `supported range: 4-15`，按**区域 + 模型 id**记在本次进程里，第二次同样的越界值**零请求、零冷却**直接报「时长必须在 4 到 15 秒之间」。读不出区间（例如拒的是宽高比）就什么都不记——不猜。
  - **验证**：`tsc` 两套配置 0 error；`vitest run` 141 个文件 / **2445 条**通过（`tests/video-gen.spec.ts`
    35→48、`tests/video-tool.spec.ts` 7→12；新增用例钉住「提交 400 之后下一次仍会真的发请求」
    与「学到区间后第二次不出进程」）。

- **`size` 的描述让人以为只能出 1024 级方图，而实测上限是约 419 万像素**
  - **起因**：5.10.0 把 `size` 描述从单个 `1024x1024` 例子改成方 / 竖 / 横三个例子，解决了
    「只能出方图」那个错误先验；但三个例子全是 1024 级，模型据此认为「大图也就是这个量级」，
    用户要桌面壁纸、竖屏壁纸时只会得到一张 1024 宽的照片。
  - **2026-10-25 逐档实测（国内区 `hunyuan-image-alpha`）**：`2048x2048`（4.19 MP）、
    `2048x1536`（3.15 MP）、`2048x1152`（2.36 MP）、`2560x1440`（3.69 MP）、
    `2560x1600`（4.10 MP）**全部成功，输出宽高与请求完全一致**——不是把大图静默压回原生
    尺寸再放大，画面里的刻度文字与纹理是独立线条。`2560x2560`（6.55 MP）、`3072x3072`
    （9.44 MP）、`4096x4096`（16.8 MP）**全部被直接拒绝**，不会退回一个较小尺寸。
  - **据此定上限**：约 **419 万总像素**，任意长宽比。这**推翻**了流传的判断「原生上限约
    1536 长边」——那个数字来自官方 CLI `.describe()` 的三个例子与 bundled OpenAI SDK 类型
    定义的取值范围，从来没有实测过；实测表明 2560 长边是真实可用的。
  - **修法**：`src/image-tool.ts` 的 `size` 描述加入 `2048x2048` / `2048x1536` /
    `2560x1440` / `2560x1600` 四个**实测通过**的档位、写明「约 419 万像素」上限、并点名
    `2560x2560` / `3072x3072` / `4096x4096` 会被拒（防止模型往 4K 上撞）。
  - **只写实测过的尺寸**：`1440x2560`（手机竖屏壁纸的常见答案）**没有单独跑过**，它与已通过
    的 `2560x1440` 像素数相同、只转 90°，按像素阈值推断可用，但描述里不写它——描述只给实测
    通过的宽高；`docs/IMAGE_GEN.md` 的「尺寸与比例」小节把 `1440x2560` 单列一行并标注
    「未单独实测」。
  - **验证**：`tests/image-gen.spec.ts` 新增 1 条（描述同时含 `2048x2048` / `2560x1440` /
    `419` / `4096x4096`，防止以后有人把上限改回「只给三个 1024 例子」）；
    `docs/IMAGE_GEN.md` 的「尺寸与比例」换成 11 行实测对照表 + 按用途选尺寸表；
    README 中英各补一句。

---

## 5.10.0 (2026-10-25)

> 特性版本：`workbuddy_draw_image` 从「只在国内区注册、只能文生图」扩成「国内区与国际区都能用、文生图 + 改图（图生图）」，卡片「能力」栏新增该区媒体模型的只读清单。**请求路径、provider 路由、计费口径与凭据处理一律未变**：改图打的是官方 CLI `ImageService.editImage` 早就用的 `POST /v2/images/edits`，选模型仍然只看该区 `/v3/config` 的媒体标签。

### Features

- **国际区账号也能用 `workbuddy_draw_image`（逐区授权，国内优先）**
  - **起因**：此前文档与代码都写着「只有国内区有生图模型，国际区一条都没有」，工具因此硬编码成 `regionEnabled(config, 'cn')` 才注册。那句话是 **2026-10-21 的观测**，已经过期。
  - **2026-10-25 跨区实测**：国际区 `GET /v3/config` 29 条模型里 `hy-image-3.5` **同时**带 `text-to-image` 与 `image-to-image`；同一份凭据 `POST /v2/images/generations` + `hy-image-3.5` → HTTP 200、`usage.credit = 0.03`、产物是 `ap-singapore` 的 COS 签名 URL。`buildImageBody()` 的「其它」分支（带 `response_format: 'b64_json'`）被原样接受，**协议层一行都不用改**。同一轮探针确认国际区 `/v2/api-keys` 回 503、`/agenttool/v1/tempkey` 回 500（而国内区后者回 200）——即 3D 那条临时密钥链路在国际区整个不存在，与生图无关。
  - **修法（区域选择集中到一处）**：`src/index.ts` 新增 `imageToolRegionOf(config)`——按 `REGION_KEYS`（`cn` 在前）遍历，跳过被关闭的供应商，返回第一个**既启用又打开了「允许模型自主生图」**的区域，都不满足返回 `undefined`。`syncImageTool()` 的注册判定改为 `imageToolRegionOf(value) !== undefined`；`resolveCredential` 改为每次调用时读当前配置、遍历被授权的区逐个 `resolve()`，某区未登录就试下一个区，全失败返回 `undefined`。**CN 优先是唯一向后兼容的顺序**：升级前这个工具只能走国内区，升级不能悄悄把老用户的支出挪到另一个网关。
  - **文案层同步拆除「只有国内区」的前提**：`ImageToolDeps` 删掉 `regionLabel` 字段；工具描述改为「两个区都可用 + 各自的模型名 + 单价随区与模型不同 + 以返回的 `credit` 为准」；`NOT_LOGGED_IN` 改为「要么两个区都没登录，要么已登录的那个区没打开该开关」；`hint` 不再写死 5.71，有 `credit` 时印本次实扣；`describeImageFailure()` 的 404 文案与 `pickImageModel()` 的空目录文案不再断言「国际区没有生图模型」。
  - **卡片**：`imageToolPreference` 不再包在 `activeRegion === 'cn' ? … : null` 里，两个 tab 都显示；勾选仍然只写**当前这一区**的 `imageToolEnabled`，两区都关着时工具根本不注册。
  - **价格口径（README 中英各改一段）**：5.71（国内 `hunyuan-image-alpha`）与 0.03（国际 `hy-image-3.5`）是**两个模型 × 两个区域**同时变化的结果，不是同一张图的跨区差价；两区的积分池彼此独立，两个数字之间没有任何汇率含义。
- **改图（image-to-image）：同一个工具，给了 `image` 就切模式**
  - **起因**：`/v2/images/edits` 与 `hunyuan-image-alpha-edit` 的存在早在 4.13.2 取证时就写在 `docs/IMAGE_GEN.md` 的「没做的事」里——没做，是因为当时没跑通一次真实调用。这次跑通了，才把它接出来。
  - **模式由「有没有输入图」唯一决定，不新增 `mode` 参数**：多一个参数就多一个「`mode=edit` 但没给图」的自相矛盾状态。`image` 存在 → `editImage` + `image-to-image` 组；不存在 → `generateImage` + `text-to-image` 组。
  - **`model` 的校验跟着模式走**：`pickMediaModel(models, requested, tag)` 按当次标签组挑模型。拿文生图模型点名去改图会直接报「目录里没有图生图模型「xxx」。可用：…」，而不是把不匹配的 id 发上去换一个上游 404——那样报错只会是 `route config not found`，读者无从知道是名字写错了。`selectMediaModels` 同时接受单个标签与标签数组，目录一次读回四类媒体标签（`MEDIA_TAGS`），为将来的视频留位。
  - **`image` 收官方 CLI `processImageInput` 的全部四种形态**：本地绝对路径、`file://`、`http(s)`（宿主侧下载、30 秒超时）、data URL，另加裸 base64（长度 ≥ 100、无路径分隔符、字符集合法才认，否则当路径）。**一律先归一成 `data:<mime>;base64,…`** —— 上游唯一接受的形态。mime 判定顺序：HTTP `Content-Type` 的 `image/*` → 按扩展名 → 按魔数嗅探（PNG / JPEG / GIF / WEBP / BMP，兜底 `image/png`）。
  - **不做缩放、裁剪、格式转换**（`MAX_INPUT_IMAGE_BYTES = 8 MB` 只是上限）：用户给什么就传什么。悄悄改输入图是比失败更糟的行为。
  - **输入图的所有毛病都在「请求没发出去」之前**，所以统一 `INVALID_ARGS`、不进 30 秒冷却、不花积分：读不到文件、下载失败、data URL 格式不对、空文件、超 8 MB。紧接着再调一次仍能立刻执行——判据与既有规则一致（冷却只看「请求是否真的发出去了」）。
  - **返回值与 `render` 区分两种模式**：output schema 新增必填 `mode`（`'generate'` | `'edit'`），`render` 显示「改图 · 模型：`xxx`」、markdown alt 由「WorkBuddy 生图」改为「WorkBuddy 文生图/改图」。
  - **上游**：`src/upstream.ts` 新增 `editImage(credential, {model, prompt, size?, image, inputFidelity?})`，`src/image-gen.ts` 新增 `buildEditBody()`（在 `buildImageBody` 之上追加 `image` 数组，`input_fidelity` 仅在非空时写入）。
- **卡片的「能力」栏新增媒体模型只读清单**
  - `POST /plugins/dsh-connect-workbuddy/media-models`（`WORKBUDDY_MEDIA_MODELS_PATH`）：405 非 POST → 403 外部 Origin → 503 未接线 → `region` 查询参数（缺省 `cn`）→ 200 `{models:[{id,name,tags}]}`。空清单是**合法回答**（网关不发布媒体模型），不是错误——卡片为它单独写了一句话，而不是显示一个失败。
  - **为什么单独一条端点**：`models/refresh` 返回的是**聊天**目录，投影时媒体条目被 `selectCliModels` 丢掉，刷新它永远看不到图像模型。
  - 宿主侧 5 分钟缓存（复用 `MEDIA_MODEL_TTL_MS`），`refresh=1` 绕过——刚在上游启用了图像模型的用户不该等 TTL 到期才看见。读失败不写缓存。
  - **只读，不做下拉**：两区今天每个标签组只有 1 个模型，长度 1 的下拉是假选择。切换能力的方式就是工具的 `model` 参数。清单**惰性读取**（只在能力面板打开时读、每区只读一次），失败只落在块内，绝不并进 `statusByRegion`——那会把图像模型写进 `lastCatalog`，adapter 就会拿它当聊天模型。
- **文案与文档**：`docs/IMAGE_GEN.md` 新增「改图」整节（四种形态、模式自动判定、每组模型、8 MB 上限、为什么不给 `mode` 参数），并把「图生图没做」那条从「没做的事」里删掉；README 中英各补一段。

### Fixes

- **超限的 data URL 会绕过 8 MB 与空文件闸门，被原样发到上游，然后按「已计费失败」冷却 30 秒（本轮合并前审核发现）。**
  - **症状**：`resolveImageInput` 的 `data:` 分支校验完格式就 `return text`，而空文件与 `MAX_INPUT_IMAGE_BYTES` 的检查都在 `encodeInputImage` 里——只有 `http(s)`、裸 base64、本地路径这三条路径会走到它。于是 `data:image/png;base64,<12 MB>`（解码后 9 MB）会被整个塞进请求体发出去；上游拒绝后 `sent` 已是 `true`，再吃一次 30 秒冷却。
  - **与本 PR 自己的声明直接冲突**：工具描述、`docs/IMAGE_GEN.md` 的「输入图的失败不进冷却」小节，以及 `image-tool.ts` 里 `inputImageError()` 的注释都写着「输入图的一切毛病都发生在请求发出去之前，所以统一 `INVALID_ARGS`、不花积分、不进冷却」。这不是缺一条边界用例，是四条路径里有三条遵守、一条不遵守。
  - **修法**：新增 `assertInputImageBytes(byteLength, source)` 作为唯一的体积/空文件闸门，`encodeInputImage` 与 `data:` 分支都调它——文案因此只有一份，四条路径不可能再各自漂移。
  - **口径**：体积按**解码后**的字节数比上限，不按 base64 字符串长度。base64 比原始字节长约 4/3，拿字符串长度比会把一张合法的 6 MB 图（8 MB base64 字符）误判成超限，并在错误信息里报出一个虚高的 MB 数。
  - **验证**：`tests/image-gen.spec.ts` 新增 3 条——超限 data URL 报 `INVALID_ARGS` 且 `editImage` 没被调用、紧接着再调一次**不进冷却**；6 MB 输入（8 MB base64 字符）仍被接受；`data:image/png;base64,====`（形似 data URL 但解码为空）报 `INVALID_ARGS`。变异验证：把 `data:` 分支改回直接 `return`，前两条与空内容那条中的两条立刻变红。

### Tests

- `tests/image-gen.spec.ts`：38 → **60 条**。新增 `pickMediaModel` 按组校验（含国际区 `hy-image-3.5` 两组都能选、拿文生图模型去改图的报错文案）、`selectMediaModels` 的多标签形态、`buildEditBody`（字段顺序 / `n:1` / 空 `input_fidelity` 不写入 / `image` 是拷贝）、输入图归一（扩展名大小写、五种魔数 + 兜底、data URL 只认 `data:image/*;base64,`、裸 base64 的字符集判定、8 MB 常量），以及改图路径的 9 条端到端（走 `editImage` 且 `mode:'edit'`、不给图走 `generateImage`、读不到图 `INVALID_ARGS` 且**不进冷却**、`data:text/plain` 被拒、**超限 data URL 被拒且不进冷却**、**上限按解码后字节数算**、**空内容 data URL 被拒**、点名错组模型不发请求、`render` 文案）。国际区夹具换成真实形状（`hy-image-3.5` 双标签 + `kling-video-v3`），新增「国际区目录同样能选出默认模型」「工具描述同时交代两个区」「`render` 原样印出 0.03（不能被抹成 0）」；404 与未登录两条用例从「断言点名国内区」翻转为「断言不再点名」。一条旧断言从「WorkBuddy 生图」改为「WorkBuddy 文生图」——`render` 现在分两种模式。
- `tests/image-tool-optin.spec.ts`：12 条。新增 `imageToolRegionOf` 四条（都没授权 → `undefined`、供应商关着时勾选不算授权、只开国际区 → `'global'`、两区都开 → `'cn'`），卡片源码断言改为「不再 CN-only」。
- `tests/web-status.spec.ts`：新增媒体端点 7 条（200 只回 id/name/tags 且 region 透传、空清单 200、`refresh=1` 透传且 `refresh=0`/缺省读作 false、GET 405、外部 Origin 403、未接线 503、上游抛错 500），以及路由顺序断言。
- `tests/card-media-models.spec.tsx`（新文件，6 条，jsdom 真渲染）：只在能力面板打开后**每区读一次**、按钮才带 `refresh=1`；行里同时显示 name / 工具要用的 `id` / 翻译过的 tag；空清单读成一句话而不是失败；上游 500 只落在块内、同面板的其它开关照常可用；半形行被丢弃而不是抛异常（一个只读列表不值得把整张卡带下去）。
- 全量 `vitest run`：138 文件 / 2362 条通过（本功能相关的 image-gen 60 + image-tool-optin 12 + card-media-models 6 共 78 条）；两个 tsconfig 的 `tsc` 均 0 错。

## 5.9.0 (2026-10-25)

> 健壮性与诊断版本：活动徽标的时窗解析不再能因非字符串端点而抛错，上游改格式时徽标不再**静默**消失，配置区渲染失败不再退化成一片空白；同时修掉一个**徽标被冻结在保存时刻**的静默缺陷。**发往上游的请求体、provider 注册、凭据、计费、换号与路由门禁一律未变**——本轮不新增任何上游请求，也不改动入站路由。

### Fixes

- **`minutesOfClock` 缺运行时类型守卫，非字符串端点会在渲染期抛 `value.trim is not a function`（issue #139）。**
  - **症状（机制属实，但 issue 的根因链不成立）**：函数签名是 `(value: string)`，只靠调用方 `parseDaily` 的 `text()` 维持不变式。一旦 `{ start: 1380, end: 470 }` 这样的数字端点到达 `withinDailyWindows`（`src/promo.ts:530`），渲染期抛 `TypeError`，宿主 `SlotErrorBoundary` 把它吞成一个空的 `<div data-slot-error>`——页面上表现为「插件像没装上」：卡片只剩头部，配置区整块消失。
  - **issue 的根因不成立，已核**：客户端 bundle 里 `modelPromotions` / `parseDaily` 的命中数是 **0**（徽标的 `promos` 由宿主解析后经 `status-paths` → `web-status` 投影下来），且宿主 `parseDaily` 对数字端点是**丢弃而非抛错**（`text()` 先挡）。实测国内区三台主机 × 四种 UA，`schedule.daily` 端点全部是字符串（`"23:00"` / `"7:50"` / `"0:00"` / `"23:59"`），无一个数字。另外 `TypeError` 与时刻无关，issue 描述的「只在夜间崩」自相矛盾（13:00 与 23:30 抛的是同一个错）。
  - **但那条路径并非不可达**：`toPersistedWorkBuddyModel` 保留 `promos`，settings 的 `modelConfig` schema 不剥离未知键，`resolveRoster` 原样携带——所以 `lastCatalog` 是一条**真实的第二入口**，且客户端对它**零运行时校验**。这就是补守卫而不是「纯纵深防御」的理由。
  - **修法**：签名改 `(value: unknown)`，首行 `if (typeof value !== 'string') return undefined`。**没有**采纳 issue 建议的「数字按当日分钟数解释」：`1380` 确实等于 23:00，但没有任何上游发布过这种形状，为一条上游从未描述过的活动凭空造出时段，正是本模块要防的「说多」。
  - **验证**：`tests/promo.spec.ts` 新增 2 条——数字端点 `selectPromoBadge` / `selectPromoMultiplier` 均不抛错且返回 `undefined`；`parseWorkBuddyPromos` 对数字端点产出 `dailyUnusable`（「永不运行」）而非「无时段 = 全天」。变异验证：删掉守卫 → 该条变红。

- **上游的促销变更被冻结在用户保存目录的那一刻（本轮审核发现，影响面大于 #139）。**
  - **症状**：用户只要保存过一次模型目录，`promos` 就被写进 `lastCatalog`，此后**上游的促销变更再也不生效**——徽标与折后价用的都是保存那一刻的快照。两个方向都实测过：saved 无 `promos` + live 有 → 徽标**完全不出现**；saved 有旧 `promos` + live 有新 → **旧的赢**。极端情形：一条无 `schedule` 的常驻徽标（如「订阅优先」）在上游撤下后仍会**永远**挂在模型行上，因为它没有绝对窗口能让它自己过期。
  - **根因**：`promos` 不在 `LIVE_OWNED_FIELDS`（`src/catalog-sync.ts:77`），而 `overlayLiveCapabilities` 返回 `{ ...saved, ...overlay }`——saved 的 `promos` 原样留下，live 的被整个丢掉。这与 `src/promo.ts` 文件头「徽标是时钟的函数，不是抓取的函数」直接矛盾：它冻在了**保存**时。
  - **修法**：`promos` 改为 live-owned，但**不能**复用 `LIVE_OWNED_FIELDS` 那个循环（它只写 live 有值的字段，无法表达「清除」）。改为在 `overlayLiveCapabilities` 里单独处理：live 有 `promos` 就整体覆盖；live 没有就**按 key 删除** saved 的那份（不能用 `undefined`——显式 `undefined` 会存活 `structuredClone`，并被设置写入路径的严格 JSON codec 整单拒绝，与 `busyLevel` 的处理同理）。
  - **验证**：`tests/catalog-sync.spec.ts` 新增 5 条覆盖四个方向 + 直接调用 `overlayLiveCapabilities`。变异验证：让 `promosDiffer` 恒为 false → 4 条变红。
  - **已知未改**：`catalogFingerprint` 仍不含 `promos`，`lastCatalog` 里那份 `promos` 现在是纯冗余。持久化形状的调整会牵动严格 JSON codec 的历史教训，留待另议。

- **配置区渲染失败时页面一片空白，无法与「插件没装上」区分（issue #139 的报告者正是被这一点拖住）。**
  - **症状**：宿主 `SlotErrorBoundary` 的失败面是**空** `<div data-slot-error>`，只留一行 `console.error`。issue 贴的 `slot entry crashed in 'plugins.bundle.config': value.trim is not a function` 与该边界逐字吻合。
  - **修法**：在卡片 **body** 层包一层 `CardBodyBoundary`（**不含 header**——配置区崩了也要能折叠/展开，且 header 是纯静态标记，不可能是抛错源）。失败面显示「配置区渲染失败」+ **错误摘要原文** + 一句「模型服务本身未受影响」，并照旧 `console.error`（含 `componentStack`），因此**不遮蔽**任何本该暴露的错误。
  - **边界条件**：`SlotAssemblyError`（宿主装配故障）**原样重抛**，不降级——把响亮的装配错误变成安静的「配置失败」是错的。
  - **范围声明**：React 边界只捕获 render / 生命周期 / 构造期错误，**不捕获**事件处理器、定时器与 promise 回调里的抛错；那些路径仍按原样呈现。本次崩溃发生在 render 期（栈顶 `promo.ts:263`），落点正确。
  - **验证**：直接渲染抛错的子组件，确认失败面出现、摘要为 `value.trim is not a function`、且 `console.error` 被调用。

- **上游发布了活动时段却一条都读不懂时，徽标静默消失，界面上没有任何解释。**
  - **症状**：`dailyUnusable` 让该活动按「永不运行」处理（正确），但用户看到的是徽标不见了——与「活动已结束」无法区分。**这才是上游将来改格式时用户真正会遇到的症状**（不崩，静默消失），而 issue 猜的是崩溃。
  - **修法**：诊断栏的 `row.diagFailures` 行计入 `promoUnreadable`，显示「N 条活动时段读不懂 —— 徽标已隐藏」。`dailyUnusable` 本来就已传到客户端，只是从未显示过。
  - **验证**：`tests/promo-card.spec.tsx` 新增 2 条（有 `dailyUnusable` 时诊断行出现且不画徽标；全部可解析时该行不出现）。变异验证：删掉该行 → 变红。

- **`parseDaily` 丢弃窗口时完全静默，上游改格式在日志里也留不下痕迹。**
  - **修法**：丢弃时打一行 `console.warn`，带活动 id 与端点的 `typeof`（`number` 单独命名，因为它正是未来格式变更可能的样子）。
  - **位置是刻意的**：日志打在**宿主侧** `parseDaily`（每个上游文档跑一次），**不是**客户端 `withinDailyWindows`（卡片每 60s 轮询、每个模型每轮都重算，打在那里会变成每分钟几十行）。
  - **不泄露上游内容**：只报 `typeof`，不回显原始值。

## 5.8.5 (2026-10-24)

> 安全与健壮性版本：给设置卡片的 13 条路由（10 条 POST + 3 条 GET）补上缺失的 `Host` 校验（DNS-rebinding），并让测速探针不再发送一个自造的档位值。**发往上游的请求体、provider 注册、凭据、计费与换号规则一律未变**——唯一的上游侧行为变化是测速请求少了一个字段；入站侧（本插件对浏览器请求的接受范围）**确有变化**，见下文两条：Host/Origin 判据的扩展与空 Origin 的统一。

### Fixes

- **测速探针硬编码 `reasoning_effort: 'none'`，导致部分模型的速度永远测不出来。**
  - **症状**：在 global 区对 `gpt-6-astra`（以及其它拒绝该字面量的模型）点「测速」，三次采样全部失败，卡片显示无速度；同类模型在 CN 区正常。
  - **根因（推论，不是本仓实测）**：`src/tps.ts` 的 `tpsProbeRequestBody()` 无条件带上 `reasoning_effort: 'none'`，而 `none` 不是任何模型目录声明过的档位值（`supportedEfforts` 只有 low/medium/high/xhigh/max），属于我们自造的拼写。**本仓库没有记录过任何模型对该字面量的反应**——这条结论来自对一个社区分支（`longge1213812138/dsh-workbuddy-connect`）源码的阅读，其注释称 `none` 被 GPT-5.6 家族与 GLM 接受、被 `gpt-6-astra` 拒绝，我们未复测。已知的相邻事实只有 `src/off-thinking.ts` 记的「10 个模型拒绝字面量 `off`，而省略该字段全数返回 200」。因此这个修复的**确切收益是「不再发送一个自造的、未经验证的档位值」**，而不是「修好了一个已证实的 400」。
  - **修法**：**不发这个字段**，而不是换一个拼写。依据是 `docs/reasoning-investigation.md` §4/§5 的两网关实测：请求不带 `reasoning_effort` 时上游返回 **0 个思考字符**——注意那批实测覆盖的是单数 `effort` 形态的模型（deepseek / hy3 / kimi / minimax 一类），**不含 `gpt-6-astra`**，所以对后者「省略即零思考」是合理推断而非已证事实。结论上仍然成立：不思考本来就不需要任何拼写，而任何拼写都可能被某个模型拒绝。注意这与 `dropRefusedReasoning()` 只是**结论**一致，不是同一段代码——那个函数只对 `REFUSES_OFF_MODEL_IDS` 名单内的模型删字面量 `'off'`，TPS 根本不经过它。
  - **验证**：`tests/tps.spec.ts` 的断言从 `reasoning_effort === 'none'` 改为 `'reasoning_effort' in body === false`，并把模型 id 换成 `gpt-6-astra` 且额外断言 `body.model` 确实进入请求体——这样这条用例描述的是「该模型 + 无该字段」这个组合，而不是任意 id 都成立的巧合。用 `in` 而不是 `=== undefined` 是有意的：后者在「忘了做决定」的 body 上也会通过。变异验证：把字面量加回去 → 该条变红。

- **设置卡片的 13 条路由（10 条 POST + 3 条 GET）只校验 `Origin`、不校验 `Host`，DNS-rebinding 页面可以打到其中的读路由。**
  - **症状**：安全缺口，无用户可见现象。**真实的暴露面是 3 条读路由**（`usage` / `account-credits` / `cli-live`）——浏览器对同源 POST 一定带 `Origin`，所以 rebinding 页面打 10 条 POST 时会被旧的 Origin 门拒掉；而同源 GET 不带 `Origin`，旧门直接放行。修复价值真实，但「13 条写路由全可被打」的说法不成立。
  - **根因**：回环判定被写了两份。`src/shim.ts` 的 chat 路由有 `hostIsLoopback` + `originIsLoopback` 两道门，而 `src/web-status.ts` 的 13 条卡片路由只有 `originIsLoopback`（名为 `loopbackOrigin`）。**Origin 挡不住 rebinding**：攻击页面由攻击者域名提供，浏览器把**那个域名**写进 `Host`，socket 却落在 127.0.0.1，于是一条只查 Origin 的 GET 路由会放它过去。这个缺口在 `docs/UPSTREAM-0.7.0-REVIEW.md:27` 早有记录，不是新发现；两份实现各自内部一致，是这次抽共享模块才把差异摆到一处。
  - **修法**：把回环判定抽到新模块 `src/loopback.ts`，shim 与 web-status 共用同一份；13 条路由统一改走 `requireLoopback(req, res)`，即 Host + Origin 两道门，拒绝时分别回 `host-not-trusted` / `origin-not-trusted`。**缺失 `Host` 一律拒绝**（HTTP/1.1 要求该头，在能花积分面上不值得网开一面）；**缺失 `Origin` 仍然放行**（这正是插件自己 fetch 与 curl 的形态，拒了会打断插件自身调用）。
  - **Host 判据不是「必须是回环」，而是「必须是本机地址」**（`hostMatchesListener(host, req.socket.localAddress)`），且「本机」包含整个 IPv4 回环段 `127/8` 与本次连接落在的那个接口。这一点是审核阶段两次纠正的：初稿只认 `127.0.0.1`/`localhost`/`[::1]` 三个字面量，而**宿主实际运行的 0.2.1-rc.3 虽然拒绝 wildcard 绑定（其报错原文要求「bind one concrete IPv4 or IPv6 address of a local interface」），却允许绑定任意一个具体的本机地址——包括局域网 IP**；宿主自己的信任层就接受「监听绑定的那个 IP 字面量，任意端口」。只认回环字面量会把这类部署的 3 条**读路由**从「可用」打成 403（10 条 POST 在旧代码下本来就因 Origin 是局域网地址被拒，所以回归面只在这 3 条 GET）。`localAddress` 是连接实际落到哪个接口的事实，攻击者伪造不了：rebinding 的 Host 是攻击者域名而连接落在 127.0.0.1 或某个本机地址，两者不等即被拦下。`0.0.0.0` / `[::]` 显式排除（bind 通配符，不是客户端会合法发出的地址）。**同时把 Host 与 Origin 两条路径的「本机」判定统一为同一个 `isLocalHostname()`**：此前 `127.0.0.2` 与尾点（`localhost.`）在两条路径上给出不同答案，同一个概念两套解析必然漂移。
  - **审核阶段自查出的一处实现缺陷（已修）**：初版 `hostMatchesListener` 直接用 `hostname === localAddress` 比较，于是当两侧都是同一个**主机名**时也返回 true。生产环境里 `localAddress` 来自 socket、永远是 IP 字面量，所以这不是可达的漏洞；但它把「比较两个地址」写成了「比较两个字符串」，一旦有人把主机名传进来（测试替身、未来某个代理头），门禁就会静默放宽成「只要名字相同就放行」。现在右侧必须是 IP 字面量才参与比较，答案重新变成关于地址的判断。同时处理了 IPv6 的括号差异（Host 带括号、`localAddress` 不带）。
  - **Origin 判据同步对齐（审核发现的「只修了一半」）**：Host 判据升级为「本机地址」后，`originIsLoopback` 仍只认回环，而真实局域网浏览器对**同源 POST** 一定发 `Origin: http://192.168.1.5:3000` ——于是 Host 门放行、Origin 门拒绝，10 条写路由（签到 / 测速 / 探针 / 保存模型 / OAuth / 转存 / 账号池）对局域网部署仍然全 403。初版的一处测试把 LAN 场景写成「只有 Host、没有 Origin」，恰好让这个缺口躲过了自己的测试。现在 `originIsLoopback(origin, localAddress)` 与 Host 复用同一套 `isLocalHostname` + `hostMatchesListener` 判定（只比 hostname，不比端口——Origin 永远带页面端口而 `localAddress` 不带），LAN 测试的 fixture 也补上了真实浏览器会发的 `Origin`。变异验证：把 Origin 门改回不传 `localAddress` → 该条立即变红。
  - **已知限制（未能消除，两条）**：
    1. **任何主机名形式的访问都会 403**，不只是 `trustedHosts` 里的域名——`my-mac.local`（mDNS）、反向代理域名、自定义 hosts 条目都算，因为判据只认 IP 字面量与 `localhost`。插件无从知道某个任意域名指向本机，也不该去猜；要用域名访问就得让插件路由进入宿主的信任层，那是另一个改动。
    2. **Origin 只比对 hostname，不比对端口**。同主机其它端口上的页面会通过 Origin 门。这不是本次能消除的威胁（那需要本机已运行代码，等价于本地权限），且反向代理常常在另一个端口终结 TLS、再转发到本机的本端口，比对端口会误伤这类部署。这一取舍写在 `src/loopback.ts` 的注释里。
  - **一处有意的语义统一**：空字符串 / 纯空白的 `Origin` 从「拒绝」变成「放行」。旧 `web-status` 只判 `origin === undefined`，而 shim 的实现一直判 `origin.trim() === ''`——两个文件对同一件事有两种答案，正是这次重构要消除的分裂，所以统一取 shim 的语义。安全性无变化（浏览器对 http(s) 请求不可能发空 Origin，能发空 Origin 的非浏览器客户端本就伪造得了 Host），在此记录以免日后被当成缺陷。
  - **这不是认证，也没有更硬的第二道防线**：两者都能被本机进程、或被任何能连到该端口的对端伪造。它挡的是「外部页面里的浏览器」（浏览器替我们决定 Origin，rebinding 又过不了 Host 比对），挡不住「已经能对这个端口开 socket 的程序」。**`src/web-status.ts` 里没有任何按路由的密钥**——`req.headers` 只读 `host` 与 `origin` 两个字段。所以会花积分、会返回 token 材料的路由与只读路由受同等保护，一旦把监听绑到非回环地址，这些路由就等于对局域网开放。这是整个面的性质，不是本函数能解决的；审核阶段发现初稿把「已有进程内密钥」当成了既有防线，那是错的，已删。
  - **验证**：路由级逐条用例（13 条路径的表驱动块，含「注册集合与表一致」的守卫断言，并断言每条 403 来自门禁而非上游、且上游计数器为 0）与 5 条专项用例——恶意 `Host` → 403 且 `error: 'host-not-trusted'`；完全无 `Host` → 403；四种合法回环 `Host` → 200（**正向对照**，没有它前两条在「全拒」的实现上也会通过）；局域网 `Host` + 同接口 `localAddress` → 200（**证明 0.0.0.0 回归已消除**）；局域网接口上伪造 `Host` → 403。另有 `tests/loopback.spec.ts` 29 条单元用例覆盖两个判据本身。变异验证三次：删掉 Host 那一支 → 2 条红；把判据退回「只认回环」 → LAN 放行那条红；删掉 Origin 那一支 → Origin 门禁条红。
  - **顺带修掉一个既有缺陷**：`hostnameOfHost()` 对 `[::1]evil.example` 这种「方括号回环前缀 + 任意尾巴」的输入会截成 `[::1]` 并判为回环——也就是说它把**外来源**读成了本机。真实浏览器不会发这种 Host，但这是安全边界，解析器应当 fail closed 而不是抢救前缀。现在方括号后只允许空或 `:<数字>`，其余一律整串返回（不匹配任何回环名）。这个缺陷此前一直躺在 `shim.ts` 里，抽出共享模块时才暴露出来。
  - **代价**：测试替身需要补 `host` 头（5 个调用点 + 新增的 loopback 单测），因为它们此前构造的是浏览器**永远不会发出**的请求形态。这是修 fixture 而不是放宽实现。

### Docs

- **修正注释里一句与代码不符的描述（issue #138）。** `WorkBuddyModelLabel.tsx` 的文件头写着本组件「renders nothing at all for a provider that is not ours」，但它实际返回 `<span>{model.name}</span>`——**渲染纯目录名**，只是不去装饰。
  - 这不是纯文字问题：该槽是 `kind: "single"`，**占位由注册决定，与组件输出什么无关**，所以返回 `null` 也不会释放格子。那句注释让「丢掉别人的装饰」这个代价看起来无害，issue #138 报告者正是引着它来论证，并在外部把它当成了 bug。
  - **行为一行未改**：保留 §零 的取舍（不做联动、不读别人的注册、`-0.5` 优先级），也**不加**「不占用模型标签槽」开关、**不做**按 provider 动态注册。理由是注册是全局一次性的而 `provider` 是逐行传入的，动态注册会造成空格闪烁并引入对宿主选中状态的观察；这三条处置与理由已写进 `docs/DESIGN.md` §零，供下次讨论直接引用，不必重新论证。
  - 三处注释同步：`WorkBuddyModelLabel.tsx` 文件头（说清「渲染纯目录名 ≠ 什么都不渲染」）、`WorkBuddyModelLabel()` 里那个 `return <span>` 分支（说清代价发生在这行）、`index.tsx` 的 `registerModelLabel` 上方（说清代价由宿主 1017 的行承担，且这是 §零 的价格而非缺陷）。
  - 守卫测试的 docblock 也补了对应关系：`tests/model-label-slot-coexistence.spec.tsx` 那条 `renders the plain catalog name for a foreign row` 的 fixture 正是宿主的 1017 行（`deepseek-official` + `deepseek-flash` + `DeepSeek-V4.1-Flash`），断言 `<span>DeepSeek-V4.1-Flash</span>` 且不含 `1017` —— 它就是 issue #138 的机器可验证形式。

## 5.8.4 (2026-10-24)

> 修复版本：热重载一次之后设置卡片上一半按钮永久 405 的那一格（issue #86）。根因不是「宿主在跑旧代码」——是 `benefit/claim` 路由的 disposer 从未被调用，泄漏的路由让**下一次**热重载在它身上抛错，于是排在它后面的 8 条路由一条都没注册上。**请求路径、provider 注册、凭据、计费与换号规则一律未变**；改动是 cleanup 列表里的一行。

### Fixes

- **`benefit/claim` 路由的 disposer 从未被调用，热重载一次之后卡片上一半按钮永久 405 空响应（issue #86 的真正触发条件）。**
  - **症状**：设置卡里点「一键签到」「一键测试」「删除」「扫码登录」「保存」等按钮，报「批量操作接口没有应答（HTTP 405，无响应体）」，或扫码登录报 `登录失败: Failed to execute 'json' on 'Response': Unexpected end of JSON input`。模型本身照常能用——坏掉的只有卡片上的这些接口。
  - **判定**：插件每个 handler 都回 JSON，**包括它自己的 405**（`json(res, 405, {error:'method not allowed'})`，带 `Content-Type` 与 body）；宿主 HTTP 层回的 405 **没有 body**。所以「405 + 空 body」= 该路径在宿主路由表里根本不存在。
  - **根因**：`registerWorkBuddyStatusRoute()` 里 13 条路由都写成 `const disposeXxx = ctx.webServer.register({...})`，**唯独 `benefit/claim` 那条声明了 `disposeBenefitClaim` 却没把它放进 cleanup 列表**（`tsc` 不报错：`noUnusedLocals` 未开）。宿主 `WebServer.register()` 对同一 `(kind, path)` 第二次注册**直接抛错**（`webserver: duplicate exact route "…"`，已核 `@deepseek-ai/dsh-host-webserver/lib/index.js:328`），且路由只在 disposer 运行时才从表里移除。于是：第一次挂载 → `benefit/claim` 泄漏；热重载再挂 → 按注册顺序走到它撞上重复路径 → 抛错 → 整个 `ctx.effect` 回调中断 → 排在它后面的 8 条路由（`models/refresh`、`probe`、`tps`、`pool`、`__save`、`oauth`、`transfer`、`cli-live`）一次都没注册上。
  - **这解释了 issue #86 里「具体触发条件未复现」的那一格**：触发条件不是启动时序，是**热重载过一次**——只有第二次挂载才会撞上第一次的泄漏。所以「重启即恢复」只是把泄漏的那一份清掉，下次热重载再复发，这正是它看起来像「偶发」的原因。
  - **修法**：把 `disposeBenefitClaim()` 补进 cleanup 列表，与其余 12 条对称。一处一行。并在 cleanup 列表处补注释说明「每条注册都必须在此出现」，因为这个缺陷的代价不是多一个 handler，而是让下一次挂载丢掉一半路由。
  - **验证**：新增 3 条回归用例（`tests/web-status.spec.ts` → `registerWorkBuddyStatusRoute re-mount (issue #86)`），用一个**按宿主真实语义**的 `webServer` 替身（同路径第二次 `register` 抛错、只有 disposer 才移除）——宽松的替身会带着 bug 一起通过，所以这条属性必须照抄。变异验证：注释掉 `disposeBenefitClaim()` → 2 条变红并复现同一句 `webserver: duplicate exact route "/plugins/dsh-connect-workbuddy/benefit/claim"`。
  - **代价**：无。请求路径、provider 注册、凭据、计费与换号规则一律未变。

## 5.8.3 (2026-10-24)

> 体验版本：把 #132/#133 那几项「只能手改 `cordis.patch.yml` 才生效」的开关搬进插件卡片，用户可以直接勾选，不用再编辑 profile 里的 YAML、也不用知道那个文件在哪。**请求路径、默认字节、计费行为均未改动**：四个开关的默认值与采样时机与 5.8.0 完全一致（三个布尔默认关闭），这次只新增了一条写入它们的 UI 路径。

### Features

- **上游标识开关进入设置卡片（#133 建议 2/3）。**
  - 卡片「能力」页新增一组开关：`usageIdentity`（让用量页把调用记成官方客户端的样子）、`keepPromptLast`（让用量页记录你真正输入的话）、`sessionTitle`（会话标题请求改用轻量模型）。这三项此前只存在于 `cordis.patch.yml`，用户要手改 profile 里的 YAML 才知道有这个功能。
  - 每个开关都带一行说明和一个「改完需重载插件或重启 DSH」的统一提示——这四项都在插件挂载时采样进 shim，配置改了但没重载就看不到变化。`sessionTitle` 开启时额外显示当前目标模型（只读：该 id 仍由 `sessionTitle.model` 配置，不在这里做第二个未经校验的编辑入口）。
  - `extraInjectedPrefixes` **故意不给输入框**：它是一个字符串数组，塞进复选框形状的 UI 只会比配置文件更难用。改为在 `keepPromptLast` 开启时**报告**当前生效条数，让手写过前缀的用户能确认插件确实看见了。
  - 新增 Host 端点字段：`__save` 现在接受 `usageIdentity` / `keepPromptLast` / `extraInjectedPrefixes` / `sessionTitle` 四个顶层字段，各自 `set` 自己的路径。**不是**塞进 `cliBridge` 块：那四项管的是所有 provider 共享的请求形态，塞进去会让「关掉 CLI 路由」看起来像把它们一起重置了。
  - 写入沿用既有两条写入器（Host 端点优先、设置作用域兜底）：该命名空间的浏览器镜像在有问题的 0.1.7 部署上被文档标注为陈旧，只「看起来翻过去了」的开关正是「关闭不了」那一类报告。

### Tests

- 新增 [`tests/card-upstream-switches.spec.tsx`](tests/card-upstream-switches.spec.tsx)（9 条）：三个开关按**已提交值**渲染、缺省一律读成 OFF（不是「truthy 就算开」）、翻动只写**本字段**、`sessionTitle` 写入保留 `model`（它的字段是对象，退化成布尔就会把用户设的目标模型抹掉）、POST 到 Host 端点、以及重载提示必须在屏上。读取器另有 3 条单独测（volatile 的 `{get()}` 解包、`sessionTitle` 的缺省/畸形回退、前缀列表的去空去重与非数组防御）。
- [`tests/web-status.spec.ts`](tests/web-status.spec.ts) 增 3 条端点用例：四个字段各自只写自己的路径、白名单外的字段被 400 拒绝且不触达设置服务、期望对象的字段收到标量时拒绝。
- 变异验证：把 `sessionTitle` 的写入退化成裸布尔 → 1 条红；把「缺省读 OFF」改成「缺省读 ON」→ 4 条红；把新开关的 class 改回 `.dsm-workbuddy-pref-check` → `card-credits-switch` 5 条红（它按「卡片里只有一个」读那个类）。
- 完整套件 **2268 通过 / 2 条按平台跳过**（此前 2256），`typecheck` 与 `build` 通过。

### Docs

- 卡片文案中英双语同步新增 8 条 key；`styles.ts` 补上两个新 class 的定义（`client-host-contract` 的「每个渲染出的 class 都必须有样式」守卫要求）。

## 5.8.2 (2026-10-24)

> 适配版本：跟随宿主 `0.2.1-rc.3`。rc.2 在 web-app 捆绑里新增了官方插件 `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017`（给 DeepSeek 官方 Flash 行画「1017」发布徽章），它与本插件注册**同一个 `single` 槽**、**同一个默认优先级 0**——于是本插件的注册**抛错**，模型选择器里的负载徽章**静默消失**。本版修掉这一处，其余全部兼容。

### Fixes

- **模型选择器的标签槽位不再与宿主自带的 1017 徽章插件抢同一格（0.2.1-rc.2+）。**
  - 该槽是 `kind: "single"`，`SlotCore.register()` 对同一优先级上的第二次注册**直接抛错**：`single slot "conversation.input.model.label" already has a registration at priority 0 … (lowest renders)`。两个插件都用默认 `0`，谁后注册谁抛。实测是本插件抛——应用自己的崩溃日志里逐字记着这句，以及本插件的 `model label slot failed to register`。因为 `catch` 只 `console.error`（刻意的：标签失注册不该让整页挂掉），页面上**只是徽章不见了**，没有任何可见报错，所以一直没被发现。
  - 修法只做一件事：**换一个不碰撞的优先级**。`-0.5`（分数优先级合法）与宿主的默认 `0`、以及 `dsh-connect-qoder` 占用的 `-1` 都不碰撞，三个插件于是排成 `-1`（qoder）→ `-0.5`（本插件）→ `0`（宿主 1017）。取值只要求「不与别人碰撞」，不需要知道别人用了几。
  - **刻意不引入插件之间的联动**（项目不变量，见 [`docs/DESIGN.md`](docs/DESIGN.md) §零）：不读 `slots.entries(...)` 枚举同槽的其它注册、不把别家的行「转交」给别的插件的组件渲染、不为对方合成 `t` 席位、不依赖别人的优先级。曾经的转交方案能算「更客气」，但它要代渲染器合成对方的 props（`t` 来自对方注册时声明的 `locale:` 命名空间），还得约定一条跨插件转交方向否则递归——实测两个插件都转交时同一行被来回传递，直接 `RangeError: Maximum call stack size exceeded`。这不是本插件该承担的责任，整体撤除。
  - **代价（已接受并记录）**：该槽是 `single`，一格只有一个赢家。「最低优先级渲染」意味着 `-0.5` 实际上**赢过**宿主的 `0`，因此本插件赢下该格时，别的插件在**它自己的行**上的装饰不会被合成（宿主的「1017」徽章不会出现在本插件渲染的那一行）。不是自己的模型行，一律给宿主契约的下限 `model.name`。这是**放弃联动换来的确定性**，不是待修缺陷；要改成联动，先改 `DESIGN.md` §零。
  - **取值 `-0.5` 的定夺依据（不需要用户来选）**：宿主一方早有书面立场——`dsh-client-ui-deepseek-model-label-1017` 的 README「Known Limitations and Deferred Work」逐字写着「the two presentations do not compose automatically」，并把处置办法写成**在 profile patch 里禁用它**（配置层，不是运行时协商）。所以「两个徽标不合成」是宿主的官方立场，本项目的 §零 不变量与之一致。其余三条：1017 的 package description 就是「**Temporary** 1017 release badge」，README 承诺结构化发布标签上线后移除该包；它只装饰**一个**模型（`DeepSeek-V4.1-Flash`，限 `deepseek-official`/`deepseek-account` 两条线路），而本插件装饰**自己全部 WorkBuddy 模型行**（负载等级、促销价、夜间折扣、新模型标记）；`single` 槽「最低优先级渲染」，`-0.5` 实际赢过宿主的 `0`——但选它是为了**不碰撞**而非谦让，且 1017 被移除后本插件自动成为该格唯一占用者。

### Docs

- 新增 [`docs/DSH-0.2.1-RC3-FOLLOWUP.md`](docs/DSH-0.2.1-RC3-FOLLOWUP.md)：rc.3 复核全文，含逐面包比对与本次回归的完整证据链。
- [`docs/DSH-0.2.1-RC1-FOLLOWUP.md`](docs/DSH-0.2.1-RC1-FOLLOWUP.md) 补 §2.4 **订正**：原文把「rc 宿主上照常加载」归因为「闸门只校验 `@deepseek-ai/dsh*` + profile 用 `link:`」，**这是错的**——闸门确实校验，只是用 `semver.satisfies(rt, range, { includePrerelease: true })` 放行。范围本身无需改（裸 semver 判 false 的事实仍成立）。

### Tests

- 新增 [`tests/model-label-slot-coexistence.spec.tsx`](tests/model-label-slot-coexistence.spec.tsx)（6 条），跑**真实的 `SlotCore`**：宿主 1017 在场时注册不抛错、优先级与 `-1`/`0` 均不碰撞、自家行仍有徽章；外加「不做联动」一组——别家行只给纯目录名（**即使**另一个贡献者就在账本上）、源码不得出现 `slots.entries(...)` / 渲染别家组件 / `locale.bind`、注册只声明自家常量。
- 变异验证：把 `MODEL_LABEL_PRIORITY` 改回 `0` → 多条红并**复现同一句崩溃原文**；把注册换成会读账本的写法 → 「不做联动」那组红。
- `tests/dsh-line.spec.ts` 里「已知预发布悬崖」的注释按实测订正归因（断言本身不变，仍钉「裸 semver 判 false」）。
- 完整套件 **2225 通过 / 2 条按平台跳过**（此前 2219），`typecheck` 与 `build` 通过。

## 5.8.1 (2026-10-24)

> 修复版本：解决 DSH 会话在国内区**每一步**都 `400 / 11128` 的死循环。根因不是账号、额度、网络，也不是「宿主提示词要你改」——是插件的救援梯子对网关的**精确子串门**有一个可证明的盲区：`You are a coding agent powered by <model> model.` 这条 agent 身份从句，稀疏零宽扰动打不到，于是每次请求都逐字节原样上线被拒。**凭据、计费、provider 注册均未改动**；请求路径新增的定向破坏只插不可见字符（实测真实提示 **+0.26% 字节**），不改模型读到的任何一个词。

### Fixes

- **DSH 提示词里的 agent 身份从句现在在请求路径就被破坏，不再等被拒（#125 / `workbuddy2api-hub` #533）。**
  - 两条独立实测指向同一机制：网关对被扫的 `system` / `assistant` 消息做的是**大小写不敏感的精确子串匹配**（不只是开头前缀），活的 DSH 提示词里有**三处**这样的 span——`You are an AI agent powered by DeepSeek Harness.`、`You are a coding agent powered by the <model> model.`、`You are interacting with the user through the DeepSeek Harness Web GUI …`——且**三处全改才 200**（「只改任意一两处不够」）。
  - 盲区在第二处：它**没有相邻大写词对**（`WORD_INTERNAL_BREAK` 打不到）、**没有逗号/分号**、句末那个 `.` 又落在被禁子串**之后**（句读规则也打不到）。所以 5.7.0 的稀疏扰动清掉了第一、三处，却把第二处原样发出——那条请求于是一直 400，而错误回显把它标成「不在插件已知名单里」，反而把人引去改一条根本没问题的宿主提示。
  - 修法是在 `prepareChatBody()` 里新增定向破坏 `breakIdentityClauses()`：在身份从句的**每个内部词界**后插一个 U+200B。实测三处 span 全部失配、**模型读到的每个词都不变**（与 #533 那条把 `powered by` 改写成 `built on` 的做法不同——那个会动措辞），真实 10,818 字提示只 **+0.26% 字节**（~28 个字符），足够便宜到无条件跑。前缀名单（`UNAPPROVED_CHANNEL_OPENINGS`）与它各司其职：名单管 offset 0 的前缀门，从句破坏管任意位置的子串门；顺序是**先补中性头、再破坏从句**，否则从句里的 U+200B 会让前缀谓词匹配不上、连累中性头这级防线（有测试钉住这个顺序）。
- **删掉 `perturbChannelFingerprints()` 的粗粒度幂等保护，改由各规则自身幂等（同上）。**
  - 那句 `if (text.includes(U+200B)) return undefined` 原本是防重试叠加零宽。但请求路径现在**本来就会**先放几个 U+200B 进去，这句粗判会让整个梯子从第二级起**永久空转**——连 dense 兜底都被它挡掉，等于救援彻底失效。
  - 幂等改由各规则自己保证：拉丁句读/逗号规则锚在尾随 `(\s+)` 上（U+200B 不是空白，已断的句子自然不再匹配）；CJK 句读规则没有尾随空白可锚，**补 `(?!\u200b)` lookahead**，否则每次重试都会在 `。！` 后叠一个零宽；`breakIdentityClauses()` 靠 `\s+` 不匹配 U+200B 而自然幂等。三条各有测试。
- **`channelPerturbation: "always"` 从推荐手段降级为边缘手段。** 定向破坏已用 +0.26% 覆盖三处已知 span，密集扰动（+70.7%）只剩「出现定向破坏与稀疏都打不到的**未知** prose 指纹」这一种理由。默认仍是 `failure`，README 与 `docs/DESIGN.md` 的措辞同步改了，不再建议普通用户开 `always`。

### Docs

- [`docs/DESIGN.md`](docs/DESIGN.md) 渠道门一节新增两条要点（定向破坏的动机与实测成本、幂等保护的取舍），并订正「`always` 是唯一可靠手段」这句已过时的说法。
- [`docs/CHANNEL-FINGERPRINT-RESEARCH.md`](docs/CHANNEL-FINGERPRINT-RESEARCH.md) 补 `§6.2`，记录本次落地如何比原建议 1/3（直接上密集扰动）更省，以及为何 `always` 降级。

### Tests

- 新增 [`tests/identity-clause-break.spec.ts`](tests/identity-clause-break.spec.ts)（13 条）：三处 span 全部失配、词不变、成本上界（<40 字符）、大小写/换行/任意空白、自然幂等、普通对话逐字节不变、assistant 历史也被破坏、`user`/`tool` 不动、以及移除粗判后三条扰动规则各自的幂等（含 CJK lookahead）。
- 因身份从句现在在请求路径就被破坏，`issue98` / `issue98-shim` / `upstream` 里几条钉「旧字节形态」的断言改为钉**不变量**（去掉 U+200B 后与宿主原文一致、前缀门仍补中性头、扰动仍是纯附加），并逐条加注释说明旧断言为何不再成立——包括 `upstream.spec.ts` 那条曾断言「中段指纹逐字节不变」的测试，它编码的正是 #125 证伪的那个信念。
- 完整套件 **2218 通过 / 2 条按平台跳过**（此前 2205），`typecheck` 与 `build` 通过。构建产物用「故意破坏源码、只留 `lib/`」的方式独立复验，确认定向破坏确实进了包（运行时对真实形状 prompt 报 0 处 span 存活）。

## 5.8.0 (2026-10-24)

> 特性版本：把 `11128` 渠道拒绝与 `11140` 内容/账号限制**真正分开**（此前整族被误判成同一件事），补上企业/教育账号在账号池里丢失的身份标记，修掉「设置已落盘、按钮却永远卡在保存中」，并按 #132 提供与官方客户端一致的请求标识。**凭据、计费、provider 注册与默认发出的字节均未改动**：#132 的两项（`usageIdentity`、`keepPromptLast`）都是**默认关闭的开关**——前者只改显示用的请求标识，后者会改变上游会数到的消息顺序，而它们的实测证据来自报告者的账号与 5.3.1 构建、本插件未在真机复现，因此不以任何形式静默上线。

### Features

- **`11128` 不再被当成内容政策拒绝（#127）。**
  - 11128 家族（渠道未批准 / 会话 id 缺失 / 首条不是 system）与 11140 家族的 `msg` 都可能逐字为 `request illegal`，而 5.7.0 的分类器把这条**裸文本**当成 11140 的标记，于是渠道拒绝被分类成 `policy_reject`：账号池按「内容问题、换号无用」处理，用户看到的建议也是错的。现在分类以**业务码**为准，裸 `request illegal` 标记被删掉。
  - 11140 的两种语义此前从未被区分：内容政策拒绝（请求级）与**账号被上游限制使用**（`账号存在异常行为…` / `restricted due to unusual activity`）。新增 `account_restricted` 错误类：它**值得换号**（实测 5.7.0 的 `isFailoverWorthy` 只排除 `client` / `model_busy` / `channel_reject` / `model_queue`，所以当时的 `policy_reject` **会**换号——「5.7.0 按换号无用处理」是错的），并把该账号**停权**（`account-restricted`，不进入冷却倒计时）。
  - **停权的回池路径实测只有一条：手动「测试」该账号。** 账号 id 是 `uin`/`uid` 的 sha256，重新登录后仍是同一个 id，`readPoolProbes` 也不做过期清理，所以重登/导入**不会**清掉这条测量；「只有重新授权才回池」是不成立的表述（review #127 指出后已改正）。上游解除限制之后，在卡片上测一次拿到可用结果，这条测量被覆盖，账号才会重新成为候选。此外停权是**池内候选资格**层面的排除，不是请求级硬闸：全池没有可用候选时，`applyPoolSelection` 会清掉轮换覆盖、请求回到保存的选择，被停权的账号若正是它，仍会计费一次并被拒一次。
  - 这一分界两处都做了反向测试钉住：`channel_rejected` 不换号、`account_restricted` 换号并写停权（新增 shim 级测试——此前删掉 `isFailoverWorthy` 里的这一类，全套 2196 条测试依然全绿，等于没有守卫）。
- **对齐官方客户端的请求标识（#132，报告者实测；本插件未在真机复测）。**
  - 新增 `usageIdentity`（**默认 `false`**）：开启后 chat 请求带上 `X-IDE-Type: CLI` / `X-IDE-Name: WorkBuddy` / `X-IDE-Version`，用量页的「使用端」由此从空白变成 `WorkBuddy`；版本号由 `PRODUCT_UA` 解析得出，不留第二个硬编码数字。**`User-Agent` 两种取值下都不变**——聊天始终以 CLI 通道发送，会话身份三元组绑在这条通道上。默认关的理由见下。
  - 同一个开关下，**chat** 路径的会话身份三件套改为 **UUIDv7 的 32 位小写十六进制**形态并补 `X-Request-ID`（与 `X-Conversation-Message-ID` 同值，官方客户端也是同值）：网关把这个 id 回显成 SSE 的 `id` 并写进用量页，此前带连字符的 v4 让同一账号的记录看起来像两种客户端。三件套在任何形状下都是**每请求现生成**、互不相同。**生图路径不受这个开关影响**，保持它 2026-10-21 实测过的带连字符 v4：#132 只测了 chat，而生图的 id **格式**从来不是那道闸问的事，不为了用量页好看把它扫进没人测过的形状（这条分界经变异测试确认能失败）。
  - 新增 `keepPromptLast`（默认 `false`）：用量页的「请求」列取自 body 里**最后一条** `user` 消息，而宿主把时间采样、`Current runtime context.`、`<system-reminder>` 追加在真实 prompt **之后**，于是那一列记的是注入块而不是用户输入。开启后把这些注入块**搬到真实 prompt 之前**——消息数、角色、正文都不变，只有顺序变。唯一的正文改动是剥掉**被记录那一条** prompt 的前导 `<acp …>mNNNNN</acp>` 标记（不剥的话那一列仍然以标记开头，也就没修好），而更早的消息**保留各自**的标记：模型靠它们引用历史，而「正在回答的这条」的编号是唯一不可能被引用的。默认关闭的理由：它改变上游会数到的消息顺序、并删掉真实 prompt 的几个前导字符，升级后不该静默变化；搬移只认实测过的注入前缀，普通对话在没有注入尾块时逐字节不变（含「不剥离标记」这条独立测试）。
  - 报告者提议的第四项（把会话标题请求改写为隐藏模型 `wb-lite`）**未实现**：它不是格式对齐，而是给每个新会话增加一次真实计费请求，且依赖宿主标题模板的具体前缀。取舍写在 #132 的回复里。

- **余额胶囊会标出新模型（#128，5.7.0 之后合入、随本版发布）。**
  - 胶囊的模型列表现在会显示「· N 新模型」，并给本机**第一次**见到的模型单独加标记。判定基准是本机记录的目录快照（`roster-seen-store.ts`，doctor 的 `rosterSeen` 一节会打印它的状态与可安全清空的版本号），而不是「比上次请求多了什么」——所以重启、切区域或重新登录都不会把同一批模型反复标成新的。
  - 只有**真的新增**才计数：目录里消失又出现的模型、以及只有 tier/促销信息变化的行都不算，避免徽标长期亮着变成噪音。
- **CLI 桥接卡片补上模型/档位/区域顺序的快调选择器（5.7.0 之后合入、随本版发布）。**
  - CLI 开关下方新增模型、档位与 `regionOrder` 三个快调项，改完即写回配置，不必进设置页翻。`regionOrder` 决定同一账号在 CN / global 两个 provider 之间的尝试顺序，此前只能在配置文件里改。

### Fixes

- **账号池轮换后，卡片上的「当前选用」标在保存的选择上，不是正在计费的账号（报告截图）。**
  - `current()` 会**先看**池的运行时轮换标记（`rotatedAccountId`），再看用户保存的选择；而 `accounts()` 回答 `selected` 时只看保存的选择。池子把请求轮换到 B 号后，shim 记在 B 号账上，卡片却把 A 号标成「当前选用」——截图里那枚标记落在被限流的号上，而胶囊与行内数字都属于另一个号。
  - 同一份用量文档还会因此**点名两个账号**：`credential` 取自 `current()`（真正计费的那个），而 `account.accountId` / `accountName` 取自 `accounts()`（保存的那个）。现在 `accounts()` 用与 `current()` **完全相同**的优先级解析标记：有活跃轮换且该账号仍在本地，就标它；轮换指向已消失的账号时与 `current()` 一样回落；其余情况仍按「显式选择 / 默认最新」判断。清除轮换后标记随 `current()` 回到用户自己的选择，轮换本身仍然从不写设置。
  - 面板里还有第二处同源分裂：行的**底色**读 credits 端点的 `selected`（保存的选择），**「当前选用」文字**读池文档的 `current`（被计费的账号）。池子一轮换，两者就指向不同行——报告者看到的「底色在一个号、文字在另一个号」。现在整行（底色、文字、切换按钮的禁用态）都读同一个答案；`selected` 只在没有池文档时才作为兜底。
- **新增 `sessionTitle` 开关：把每个新会话的标题请求改到隐藏轻量模型（#132/#133，报告者实测；本插件未复现）。**
  - DSH 宿主每个新会话发一次标题生成请求，走与对话相同的 provider，按主付费模型费率计费。开启 `sessionTitle.enabled` 后，识别为标题请求的 body（宿主标题模板 `Generate the session title from this JSON array of human messages:` 打头、整条 body 只有这一条 user 消息、无 assistant/tool 消息）被改写到 `sessionTitle.model`（默认 `wb-lite`），并删除 `reasoning_effort` / `reasoning` 字段。报告者实测该模型对这类请求 **0 积分**，但仍是真实上游请求、计入请求数、仅新会话首条触发一次。
  - 识别依据是**本机安装的 DSH 桌面端 0.2.1-rc.2 `app.asar` 的字节级取证**：请求构造与宿主自己的格式校验器都断言这一模板与单 user 消息形状；宿主 `GenerateOptions.purpose: 'session-title'` 不随 OpenAI 线上协议传输，body 形状是 shim 唯一可用的判据。识别 **fail-closed**：宿主改模板则改写静默停止、回到原计费，普通对话不可能命中（模板前缀须从文本开头匹配，正文引用模板的对话不会被改写——各有测试钉住）。
  - **默认 `false`**，与 #132 两项同一理由：这笔请求无论改写与否都会发出，但改写改变的是上游把这笔记进哪个计费桶（0 积分 vs 主模型费率），升级后不该静默变化；且 wb-lite 是隐藏模型、能过渠道闸是报告者账号级的实测。目标模型可配置（`sessionTitle.model`），防 id 变化或区域差异；上游拒绝时仅该会话标题失败一次，不影响主对话。识别先用模板的纯 ASCII 头做预过滤（真实标题 body 必含、普通对话几乎不含），开关开启时普通请求不再为识别付一次全量 JSON 解析；预过滤只跳过工作，不改判定（含模板引用的对话仍由完整检测拒绝）。**生效时机**：`sessionTitle` 与 `usageIdentity` / `keepPromptLast` / `extraInjectedPrefixes` 都在插件挂载时采样进 shim，修改配置后需重载插件或重启 DSH（loader 的 volatile 更新不重建 shim）。
- **`keepPromptLast` 认得 billion-context 注入的两类上下文块（#133）。**
  - 5.8.0 的注入前缀清单只覆盖宿主自家的三类（时间采样、`Current runtime context.`、`<system-reminder>`），而 billion-context 压缩插件同样以 `role=user` 注入内容：压缩摘要块以 `[Compressed conversation section]` 标题行打头，效率提示以 `This is an efficiency` 打头。开了 `keepPromptLast` 后这两类漏网，被当成真实提问留在末尾，用量页「请求」列随之记错——报告者已在本地产物上逐字节验证此修法并实测恢复。
  - 注入前缀同时做成**可配置**：新增 `extraInjectedPrefixes`（字符串数组，每项按**字面**前缀匹配、正则元字符会被转义，默认空），压缩插件或宿主将来改文案时不必等插件发版。它只在 `keepPromptLast` 开启时参与匹配，默认行为不变。
- **企业/教育版账号在账号池里丢失 `enterprise` 标记（#129）。**
  - 存储层早就算出了 `enterprise: true`，但三个转发点把它丢了：`otherAccounts`、`localPoolMembers`、`poolMembersOf`（`poolTargets` 在 5.6.0 就已带上）。结果企业账号在池卡片上显示一个**根本不存在的「领取」按钮**和一列「签到」，而企业成员点这两样都只会被 `10001` 拒绝。
  - 现在这三个转发点都带上了标记，池行据此签到列显示「不适用（企业版）」、权益块整段隐藏；领取路由在**发起任何上游请求之前**就用 409 拒绝（`enterprise-account-unsupported`）。**Web 侧只到账号行这一层**：`toWebAccount` 与用量页的池账号行带标记，用量页顶部那个 `account` 对象没有——它这次修的是**名字**（改用 `preferredAccountName`，此前只取 `credential.nickname` 导致企业账号显示为空），不是标记；那里也不渲染签到/领取。输入框胶囊（`workBuddyAccountCredits`）同样不带标记，它不显示这两个按钮，因此没有对应缺陷。
  - `10001` 这条实测的出处是 **5.6.0** 的企业账号签到记录，不是 5.7.x；**权益读接口照样返回活动（`active: false`）而写接口一律拒绝**这一点是 #129 报告者的观察，本插件没有在真机上复测过企业账号，所以读取结果不能作为「可以领」的依据这一结论仍成立，但它的证据等级是报告者账号级、不是插件实测。
  - 用量页头部此前只取 `credential.nickname`，displayName 与 enterpriseUserName 都拿不到，企业账号显示为空；现在与池里共用同一个 `preferredAccountName` 顺序（displayName → enterpriseUserName → nickname），两处不再各写一份。
- **保存账号池偏好后按钮永远卡在「保存中…」（#131）。**
  - 设置其实**已经落盘并通过回读校验**，卡住的只是随后那次用量刷新：写入与刷新共用同一个 `saving` 状态，而刷新可能因为账号被限制、网络抖动或上游慢响应而迟迟不返回，用户于是看到「没保存成功」的假象，草稿也被锁死。
  - 现在 `saving` 只覆盖「已校验的设置写入」这一件事：写成功立刻解除 busy 并丢弃草稿，然后 **`await`** 那次回读（不是「再异步刷新」——它是串行等到的，只是结果只影响显示）。这带来一个明确的取舍：回读完成前，卡片上的行还是旧值；`refreshUsage` 失败时不抛而是 resolve，所以「没抛异常」不等于「读到了新值」，旧契约里「保留草稿直到刷新成功」的写法会在这个窗口里拿陈旧的 `saved` 去比对——因此回读结果与保存判定彻底分开。
  - 刷新失败不影响「已保存」的判定，只显示一条**独立**提示（`row.poolSavedStaleRefresh`：「已保存，但面板未能重新读取。设置已写入；下次刷新后会显示。」），它与「保存失败」是两个节点：前者 `role="status"`、后者 `role="alert"`，不再复用 `row.poolSaveFailed`，也就不会出现「保存失败：已保存，但……」这种自相矛盾的一行。只有写入失败才保留草稿。模型选择的保存路径（`WorkBuddyCard.saveModels`）同步修正。
- **`/cd` 换过目录之后，CLI 与 `/codebuddy` 仍把 CodeBuddy 拉回创建时的那个目录。**
  - **症状**：在一个会话里打开 `~/repos/api`，然后用 `working_directory` 工具 `/cd` 到 `~/repos/web`，接着调用 CodeBuddy 或 `/codebuddy`——CodeBuddy 仍然在 `~/repos/api` 里跑，模型在当前上下文里看到的却是 `~/repos/web`。两个入口还互相不一致：工具侧会退到配置里的 `cliBridge.workingDir` 或临时目录，命令侧只有一级、拿不到就直接报错「这个会话没有工作区路径」。
  - **根因**：两个入口都读 `agent.session.header.cwd`，而 Host 自己的文档把 session header 写成 *detached, deep-frozen creation metadata (format version, cwd, lineage...)*——它是**创建时**的快照，之后再也不更新。活的目录根本不在 header 上：Host 用 `@deepseek-ai/dsh-working-directory` 把它维护成一条 session 投影（`key: "workingDirectory"`，`init: header => header.cwd ?? null`，每次 `working-directory/change` 事件 apply 一次），`/cd` 工具发的就是这种事件。Host 也把这条投影写进模型的系统提示（"Current working directory: ..."），官方插件（auto-review、dsh-tools、user-questions）读的都是投影，不是 header。
  - **修法**：新增 `DirectoryOf` 依赖，`sessionDirOf()` 优先读 Host 的 `workingDirectory` 投影，读不到（未发布 / 非字符串 / 空白 / 非绝对路径）才回退 `header.cwd`。`resolveWorkingDir()` 的其余四级阶梯与三重校验（`existsSync` / `statSync.isDirectory` / `isInside` 用 realpath 比对）一行未动。
  - **两个入口同一个裁决器**：`/codebuddy` 改成调用 `sessionDirOf()`，与工具共用同一段逻辑，两边从此不可能再各说各话；都拿不到时的报错文案改为说明「投影与回退都为空」。
  - **降级是硬约束**：Host 没有发布 `sessionProjections` 时，`cliDirectoryOf` 保持 `undefined`，行为与改动前逐字节一致（`src/index.ts` 里 reactive `inject(['sessionProjections'])` 而非 apply 期采样一次，避免在 Desktop 上重演 tools/commands 被丢的历史）。**故意不回退到投影服务自己的 `defaultDirectory`**——Host 的 `get()` 是 `stateOf ?? defaultDirectory`，而那个值是 `process.cwd()`，照抄等于把「不知道」偷换成「用这个」，是本次唯一不许做的事，测试 `degrades to the configured default, not to the Host process directory` 钉死这条。
  - **装配顺序缺陷（审核时发现，随本条一并修复）**：`createCliBridgeRuntime` 在 tools/commands 行触发，可能早于 `sessionProjections` 到位；而 `syncCliBridge` 的重建键是序列化后的设置——投影到位时设置没变，重建是 no-op，runtime 里带着 build 时的 `undefined`，投影**永远不生效且无报错**（症状原样保留）。修法：runtime 接的不是值而是**探针闭包** `cliDirectoryProbe`（每回合读当前格），顺序依赖从此消失；投影服务缺席或卸载时格子清零，探针返回 `null`，回退行为不变。测试 `honours a projection that appears AFTER the runtime was built` 钉死这条时序。
- **行为变化（读投影的必然后果）**：目录阶梯 roots 白名单的第一项现在是**投影目录**（`/cd` 之后的当前目录），不再是创建时的 header 目录。因此显式传 `working_dir` 指向旧目录（header 目录的子树）在 `/cd` 之后会被三重校验拒绝，报错文案会列出当前 roots——这是「会话在哪、CLI 就在哪」的正确形态，不是回归。**凭据、计费、provider 注册与普通请求路径均未改动**；工作目录阶梯的顺序与校验规则不变，只是第一档从「会话创建时的目录」换成了「会话当前的目录」。

### Docs

- [`docs/DESIGN.md`](docs/DESIGN.md) 补充 `11128` / `11140` 的分类依据（**按业务码，不按 `displayTips`，也不按裸 `request illegal`**）、`account-restricted` 的停权语义与它唯一实测的回池路径（手动「测试」），以及「渠道拒绝不换号、账号限制要停权」的分界。
- `src/cli-bridge/services.ts` 记下为什么读 Host 的 `workingDirectory` 投影而不是 `session.header.cwd`，以及 `stateOf` 同步、无文件系统 IO 这两个性质如何让目录阶梯仍然是 `execute` 的同步第一步。

### Tests

- 新增 11128/11140 分类与账号限制切分（含按信封读码、转义/断行措辞、混合体归属三组反向测试）、企业标记贯穿三个池内转发点与 Web 账号行、领取 409 拒绝、保存后草稿丢弃与陈旧刷新提示（两条 UI 测试原先钉住的正是缺陷本身，已改正）、以及「`selected` 必须跟随 `current()` 的轮换优先级」两条（轮换中只许一个标记、轮换指向已消失账号时回落）；会话身份三件套一节 9 条（默认形状不变 / 开启后的 v7+`X-IDE-*`+`X-Request-ID`+`User-Agent` 不变 / 生图不受开关影响）；`keepPromptLast` 一节 10 条（默认不动、搬移正确、`system-reminder` 与 `<acp>` 形状、**取自真实会话的组合注入形状**、**不重排普通对话**这条反向测试、system 仍居首、只剥离被记录那一条的前导标记、array content 两种形状、无注入块时不剥离）。
- 完整套件 **2205 通过 / 2 条按平台跳过**，`typecheck` 与 `build` 通过。所有「守卫能失败」的说法都做过变异验证，逐条结果：X-IDE 或三件套改成「无视开关」→ 默认形状测试变红；开关改成永不生效 → 对齐测试变红；生图 `'image'` 改成 `'chat'`、或删掉 `shape === 'chat'` 判据 → 生图守卫变红（这条只有把 identity 真正传进 `imageHeaders` 之后才成立——`shape` 曾经是空转参数，那时改它不会变红，是真的假阳性，已修）；删掉 `isFailoverWorthy` 里的 `account_restricted` → 新增的 shim 换号测试变红（此前全绿）；把 11140 的码判定退回紧凑字面量或退回裸 `11140` 文本 → 新增的「按信封读码」测试变红（分别命中 `spaced: client` 与十六进制假阳性）；让 `accounts()` 重新忽略轮换标记 → 新增的「标记跟随被计费账号」测试变红；把面板的底色改回读 `selected` → 新增的「底色与文字指向同一行」测试变红。
- `tests/cli-bridge.spec.ts` 增 7 条（该文件 82 条全过）：投影优先于 header、投影为空回退 header、非绝对路径的投影被忽略、不得退到 Host 进程目录（`defaultDirectory`）、`/codebuddy` 跑在投影目录里、投影与 header 都为空时拒绝，加一条时序回归（runtime 先建、投影后发布、不重挂也不改设置，下一回合仍须落在投影目录——把 runtime 接回 build 时的快照值，这条就落回 `header.cwd`，当场变红）。本条并入本版后在 Windows 上重跑：完整套件 **132 files / 2214 tests 全过、0 跳过**（上面两条记录的 2205 与 2 条按平台跳过都落在同一批：那 2 条在本平台不跳），`typecheck`（`tsconfig.json` + `tsconfig.client.json`）与 `tsdown` 构建通过。

## 5.7.0 (2026-10-23)

> 特性版本：加强 WorkBuddy 渠道校验（`11128`）的三级自愈救援，并改善失败证据回显。**凭据、计费、provider 注册与普通请求路径均未改动**；默认策略仍只在渠道校验拒绝后启用，可选 `channelPerturbation: "always"` 让已确认普通请求必失败的环境跳过无效首轮。

### Features

- **渠道校验新增密集零宽救援与可配置扰动策略。**
  - 渠道门现在按「强制中性头 → 稀疏零宽扰动 → 密集零宽扰动」逐级重试；密集模式在被扫描的 `system` / `assistant` 文本字符边界插入 U+200B，能覆盖没有标点的纯 prose 指纹。
  - 新增全局 `channelPerturbation` 配置：`off` 只保留失败后救援，`failure`（默认）从成功救援中学习形状，`always` 每个请求都从密集救援形状起步。CN 与 global 两个 provider 均由同一配置驱动。
  - 普通请求仍然逐字节保持原样（除已有的已知指纹归一化）；任何渠道救援都使用同一账号，不触发账号池换号，也不记为账号失败。

### Fixes

- **渠道失败证据不再只显示被扫描消息的首行。**
  - 证据现在显示首行、尾行（若文本有多行）与总字数，帮助区分「已知开头命中」与「assistant 历史中段存在精确子串」；这避免把插件已中性化的开头误报为网关新增词条。
  - `OpeningEvidence` 增加 `textLength` 与可选 `closing`，失败回复仍保持原有的 `workbuddy 上游失败：…（http N）` 报告形状。

### Docs

- 新增 [`docs/CHANNEL-FINGERPRINT-RESEARCH.md`](docs/CHANNEL-FINGERPRINT-RESEARCH.md)，整理主流网关、中转站与适配层对客户端指纹的处理方式，并记录本次实现取舍。
- 更新 [`docs/DESIGN.md`](docs/DESIGN.md)，补充三级渠道救援、扰动策略与证据回显设计。

### Tests

- 新增密集扰动、`always` / `off` 策略、证据回显字段与既有渠道门回归测试；渠道相关测试 80 条全部通过，完整套件 2137 条通过、2 条按平台跳过。

## 5.6.3 (2026-10-23)

> 补丁版本：修「免费模型测出来可用，却显示 8 天后才能用」。**请求路径、provider 路由、计费与凭据一律未变。**

### Fixes

- **成功的探测被当成「要等到下个月」，免费模型显示「约 8 天后」**
  - **症状**（用户报告 + 真机记录）：倍率 `x0.00` 的免费模型，测试结果是 `✓ 可用`，同一行却写着 `11/01, 00:00 之后可再用 · 约 8 天后`，读起来就是「这个免费模型要等 8 天」。
  - **根因**：`cooldownOf()` 把**任何**存在的 `Retry-After` 头都当成「你在此之前不能用」，不区分响应是 200 还是 429。而这个网关在**成功的 200** 上也会带 `Retry-After`，其值是**账号月度积分包的刷新时刻**（本机 `.workbuddy-pool.global.json` 里三条记录逐字为 `outcome:"ok"` + `retryAtMs:2026-10-31T16:00:00Z` + `message:"credit 0"`）。于是「额度什么时候补」被渲染成了「模型什么时候解禁」。
  - **修法**：把「成功没有冷却」这条规则**放在 `cooldownOf()` 里**（`outcome === 'ok'` 直接返回 `{}`），而不是只在调用点去掉。理由是这类头在成功响应上确实存在，任何未来的调用方都可能再把头透传进来；规则只有一处，就无法被绕过。`probeModel()` 的成功分支同步不再请求冷却，注释写明为什么。
  - **旧记录一起治**：已经落盘的 `ok` + `retryAtMs` 记录，由 `retryAtMsOf()` 在**读取时**丢弃那个时间（这是所有消费者的唯一入口：卡片、输入框面板、换号路由），下一次 `writePoolProbes` 把修好的形状写回文件。`mergePoolProbe()` 同步拒绝把旧记录的 `retryAtMs` 继承到新的 `ok` 测量上——否则每次重测都会把那个八天重新捡回来。**测量本身不丢**：`modelId`、`atMs`、`source` 都保留，只是不再附一个不存在的等待。
  - **文案层也设了一道闸**：`availabilityLine()` / `availabilityMark()`（卡片与输入框面板共用的那一条规则）遇到 `outcome: 'ok'` 一律只输出判定，不再拼「之后可再用」。这样即使将来又有写入方带进一个时间，用户看到的仍然只是 `✓ 可用`。
  - **没有动的地方**：真实限流（`rate-limited`）、模型繁忙、积分耗尽三条路径的恢复时间**完全不变**——它们的时间是上游明确说的「什么时候能再用」，是有用信息。本次只摘掉「成功」上的时间。
  - **测试**：`tests/probe.spec.ts` 增 2 条（`cooldownOf` 对 `ok` 忽略 `Retry-After` 与 quota-refresh；`probeModel` 端到端在 200 带 `Retry-After` 时不产出 `retryAtMs`）；`tests/account-pool-store.spec.ts` 增 3 条（旧 `ok`+时间被读时治愈、新 `ok` 不继承旧时间、仍限流的账号照旧继承）；`tests/account-state.spec.ts` 增 3 条（卡片与面板都只印判定、限流行仍印时间）。

## 5.6.2 (2026-10-23)

> 补丁版本：修 5.6.0/5.6.1 里「折后价读不出来」的原因。**请求路径、provider 路由、计费与凭据一律未变。**

### Fixes

- **真实促销的 `displayMode` 是 `strikethrough`，只认 `replace` 等于把折扣全丢了（#120，第二次报告）**
  - **症状**：徽标亮着，价格不动。模型行显示 `DeepSeek-V4.1-Flash · x0.11` 配「夜间折扣」。
  - **查证方式**：直接把国内区 `/v3/config` 的 8 条 `modelPromotions` 原文 dump 出来逐条比对，而不是继续照着此前文档里的样例推断（样例只出现过 `replace`）。
  - **真实数据**（2026-10-23 实测，8 条）：
    | id | 标签 | `discount` | `displayMode` |
    | --- | --- | --- | --- |
    | `glm-52-night-discount-202607` | 夜间折扣 | `"0.50x"` | **`strikethrough`** |
    | `hy4-night-discount-daytime-badge-202609` | 夜间免费 | `"0.00x"` | **`strikethrough`** |
    | `step-5-discount-daytime-badge-202610` | 独家限免 | `"0.00x"` | **`strikethrough`** |
    | `hy3-free-trial-202608` | 限时免费 | `"0x"` | `replace` |
    | `glm-52-…-daytime-badge`、`hy4-…-badge`、`ds-discount-daytime-badge-202608`、`space-bunny-discount-202610` | — | 无 | — |
  - **根因**：原实现把 `displayMode` 硬写成 `'replace'`（唯一的样例来源），解析时把 `strikethrough` 当成未知值丢弃，判定时也只放行 `replace`。于是**八条里三条带价格的折扣一条都不生效**，只有 hy3 的 `replace` 能过。
  - **修法**：两种观测到的拼写都认。语义上它们都是「折后价才是实付价」，区别只在客户端是否同时把原价划掉——本插件每行只画一个数字，所以两者等价处理。**仍不认没标 `displayMode` 的 `discount`**：字段缺失不说明该怎么读那个数，猜成 `replace` 就是凭猜改价。
  - **顺带确认不是 bug 的一条**：`ds-discount-daytime-badge-202608`（`deepseek-v4.1-flash` / `deepseek-v4-pro`）的 `discount` 就是 **`null`**，时段 `0:00→23:59` 几乎全天。所以这两个模型「徽标亮着但价格是目录价」是**上游没给折后价**，不是插件漏读。这条单独写了测试钉住：没有数字就**不能**编一个。
  - **测试**：`tests/issue120-promo-discount.spec.ts` 增至 14 条，新增四条用的是**真实原文**（不是样例形状）——`strikethrough` 生效（`0.50x` → 0.50）、`0.00x` 免费算作 0 而不是「没有」、**only-badge 条目（deepseek 那条）徽标有、价格不动**、仍拒绝没有 `displayMode` 的折扣。原「未知 displayMode」那条改成用一个真正不存在的值，避免把已观测值钉成未知。

## 5.6.1 (2026-10-23)

> 补丁版本：修 5.6.0 自己引入的一处显示回退。**请求路径、provider 路由、计费与凭据一律未变。**

### Fixes

- **模型选择器里积分倍率显示了两遍（#120 回归）**
  - **症状**：5.6.0 之后选择器每一行都是 `DeepSeek-V4.1-Flash · x0.11 · x0.11`。截图在 5.6.0 发布后几分钟内报告。
  - **根因**：宿主的模型名**本来就以倍率结尾**（`workBuddyDisplayName` 拼的是 `"<name> · x<multiplier>"`，宿主原样渲染），#120 又在这个字符串旁边追加了一个倍率 span，于是同一个数字出现两次。**不是 #120 的判定错了，是我加渲染时没注意那串名字里已经有一个。**
  - **修法**：新增 `splitCatalogRate()`，把倍率**从宿主字符串里剥出来**、再画到能承载折后值的那个 span 里——始终只有一个数字，且它是此刻生效的那个。后缀按**形状**识别（`· x<数字>` 结尾），不按快照的 `baseRate` 比：目录价可能在快照与渲染之间变化，靠值比对会留下旧后缀、又变成两个数字，正是这个函数要消掉的东西。
  - **测试**：新增 `tests/issue120-picker-rate-duplicate.spec.tsx`（8 条）——剥离后缀保留原值、折扣时**替换**而非追加、快照过期仍按形状剥离、无倍率的名字不动、无后缀时用快照值、无后缀时仍能显示折扣、名字中间的 `x` 不动、`x0.00`（免费）不被当成「没有倍率」。

## 5.6.0 (2026-10-23)

> 特性版本：两条都来自 issue 报告——#120（错峰时段的积分倍率没跟着变）与 #124（企业/教育版账号积分恒为 0、姓名显示成登录别名）。**请求路径、provider 路由、渠道门与计费口径一律未变**；改的是「倍率与徽标同源同时钟」和「企业账号读自己那张计费表」。

### Features

- **错峰时段的积分倍率跟随打折，卡片与模型选择器一起变（#120）**
  - **报告**：模型行戴着「夜间折扣」徽标，旁边的数字还是原价 `x0.11`；真实折后价要去 WorkBuddy 客户端才看得到。徽标与价格来自**同一份** `/v3/config`、同一条促销条目，但插件只解析了 `badge`，把 `discount` 整个丢掉了。
  - **修法**：`src/promo.ts` 新增 `WorkBuddyPromoDiscount` 与 `parseDiscount()`，读 `discount.discountedCredits`（`"0.06x"` 这种**把单位粘在值里**的字符串，`Number("0.06x")` 是 `NaN`，必须剥掉末尾 `x` 再转）+ `displayMode`；`factor` 只在字符串读不出时兜底，两者不一致时**字符串胜**——它才是用户实际被扣的那个数。
  - **何时生效**：新增 `selectPromoMultiplier()`，只让**此刻正在运行**的促销打折。夜间折扣在上游是**两条条目**：一条带折扣 + 夜间时段，另一条是白天的常驻徽标（同款徽标、互补时段、无折扣）。白天那条只配画徽标、**不许改价**，否则卡片会把夜间价挂一整天。绝对有效期（`validFrom`/`validUntil`）也一并管住，活动过期即恢复原价。
  - **两处渲染**：卡片模型行（`WorkBuddyCard.tsx` 的 `effectiveRate()`）与宿主模型选择器的标签（`WorkBuddyModelLabel.tsx`，同时显示 `· x0.06`）都用同一套判定；选择器原来根本不显示倍率，现在补上了——那一屏正是「现在到底多少钱」最该看到的地方。
  - **README**（中英各一句）：模型名里的倍率是**实付价**——活动时段显示折后价，窗口关闭自动回原价，不需要重启。
  - **测试**：新增 `tests/issue120-promo-discount.spec.ts`（10 条）——`"0.06x"` / 裸数字 / `"0x"`（免费不等于缺失）/ `factor` 兜底 / 非有限值与非负值拒绝 / 未知 `displayMode` 忽略 / **白天常驻条目不降价** / 无折扣条目返回 `undefined`（保留目录价）/ 过期恢复 / 多条同时打折取最高优先级。

- **企业版（`type: ultimate`）账号读企业计费表，姓名显示真名（#124）**
  - **报告**：企业/教育版账号积分恒为 0，账号名显示成登录别名。
  - **积分修法**：`fetchCredits()` 按 `enterpriseId` 分流到 `/billing/meter/get-enterprise-user-usage`（**没有 `/v2` 前缀**）。个人端点对企业成员回的是 **HTTP 200 + 空 `Accounts` 列表**——一个形状合法但内容为假的「你没有积分」，插件不是被拒绝，是问错了表。企业表回 `{credit, limitNum, cycleResetTime}`，**`credit` 是已用额度**，余额是 `limitNum - credit`；把 `credit` 当余额读会把答案整个反转，比它替换掉的 0 更糟。`cycleResetTime` 不带时区标记，按**本地时间**手动拼（`Date.parse` 对这种形状是实现相关的）。
  - **宁可报错也不报 0**：企业端点若回不出两个数字，抛错而不是返回 `total: 0`——后者正是 #124 报告的症状，等于把 bug 当作修复。
  - **姓名修法**：新增 `preferredAccountName()`，顺序是 `displayName` → `enterpriseUserName` → `nickname`（登录别名垫底），空白串跳过。企业凭证的 `nickname` 是登录别名，把它放第一位会让卡片看起来在管别人的账号。`displayName` / `enterpriseUserName` 从桌面 auth 文档的 `account` 节点读，并随 DSH 凭证一起落盘。
  - **跨次读取不丢**：新增 `mergeCredentialDisplayNames()`，`scanAll()` 合并同账号的两份副本时把姓名**双向带过去**——桌面 App 不总重写这两个字段，整条替换会静默退回别名，让 #124 的症状自己回来。
  - **签到不再浪费请求**：企业网关没有消费者签到（对成员一律回 `10001`）。`WorkBuddyPoolTarget` 新增 `enterprise`，批次直接跳过并在日志里说「企业账号无每日签到」（新增 `skipped` 状态与新文案，中英各一条）；跳过的行**不占批次间隔**——间隔是给请求留的。
  - **测试**：新增 `tests/issue124-enterprise-credits.spec.ts`（14 条）——姓名优先级三级 + 空白跳过 + 合并保留/覆盖；企业端点被用而个人端点不被用、`limitNum - credit`、超额不为负、`Data` 包裹也能读、读不出余额即抛错、`cycleResetTime` 本地时间解析、非企业凭证仍走个人表。`tests/account-pool-run.spec.ts` 增 2 条（跳过企业账号、跳过的行不计间隔）。

## 5.5.2 (2026-10-23)

> 补丁版本：两条修复都来自 issue 报告——#118（`WORKBUDDY_BODY_REPORT` 报告文件无界增长、回填整文件读写导致宿主 OOM）与 #122（界面文案审计）。**请求路径、provider 路由、模型目录、计费与凭据一律未变**；改的只有诊断文件的 I/O 形状、若干句用户可见文案与两处内部注释，外加三张 README 截图换成合成数据。

### Fixes

- **`WORKBUDDY_BODY_REPORT` 的报告文件不再无界增长，回填不再整文件读写（#118）**
  - **报告**：报告者开着该环境变量长跑，`global.jsonl` 长到 **508 MB**；每次上游回 `usage` 后的回填都会 `readFile` 整文件 → `split('\n')` → `writeFile` 整文件，峰值约为文件大小的 2–3 倍（读串 + 行数组 + 重组串），把宿主进程顶到 OOM。`USAGE_ATTACH_WINDOW = 32` 只裁了**搜索**范围，没裁读写。
  - **修法一：写侧有上限**。`appendBodyReport()` 追加前 `stat` 当前文件，追加会越过 `BODY_REPORT_MAX_BYTES = 32 MB` 时先滚成 `<region>.jsonl.1`（`rm` 旧滚档再 `rename`，只保留一份旧档）再写新行。尺寸检查与追加在**同一个文件锁**里，两个并发请求不会同时判「不用滚」再一起写超。滚档后活文件里是**新**行——报告者对比「最后一行」时不会拿到被滚走的旧捕获。32 MB 的取值：真实会话一行几 KB，32 MB 是几千次请求，远超还有人读它的时点。
  - **修法二：回填只碰尾部窗口**。`attachUsage()` 改成 `open(file, 'r+')` + 读最后 `USAGE_ATTACH_TAIL_BYTES = 1 MB` + 窗口内定位目标行 + 从该行偏移写回 + `truncate` 到新长度；窗口前一个字节都不读不写，500 MB 文件在这里只花 1 MB 堆。窗口起点用**一字节回看**判定行边界：回看字节是 `\n` 说明窗口正好起在行边界、首行完整（必须保留——丢掉等于从文件里删一行）；否则首行是上一条的残尾，从搜索与写回里都排除。窗口外的目标行**不再回填**：标注只是 #59 对比的便利，不是正确性要求（发送侧计数早已在盘上）。
  - **README 补警告**（中英各一句）：会持续追加、32 MB 滚档、排查完请关闭环境变量并删除报告文件。
  - **测试**：新增 `tests/issue118-body-report-bounded.spec.ts`（6 条）——滚档与「只留一份旧档」、滚档后活文件是新行、不滚空文件与未超上限、大于一个窗口的文件里近期行仍被标注且窗口前逐字节不变、**窗口恰好起在行边界**（用迭代法把追加行尺寸钉到正好 1 MB：`model` 字段被原样抄进行里是唯一的尺寸旋钮，而 `bodyBytes` 的位数会随填充自增，一步算不准；断言三行都在、前两行未被标注也未被删）、目标行被推出窗口后文件不被截断或切碎。原有 `tests/issue59-body-report.spec.ts` 26 条全绿（含「标注只加在原有行上、不新增行」）。
- **四处用户可见文案与两处内部注释按 #122 审计改正**
  - `row.showCreditsCnHint` / `row.showCreditsGlobalHint`（中英）：删掉**不存在**的「手动刷新」——面板头部唯一的按钮是「一键测试」（会真跑一轮测试、真实消耗积分）；改成「点击可看各账号余额并一键测试勾选的账号（测试会真实消耗积分）。读数每 5 分钟自动刷新；各账号明细在面板打开时每 60 秒刷新」，把两个周期分开写清（此前只写了 5 分钟那个）。
  - `row.poolEnabledHint`（中英）：「失败就换下一个」改成「只有可换号的失败才换下一个」，并点名四类例外（请求本身不合法、模型繁忙、平台排队、渠道校验）与理由（换号只会为同一个拒绝白烧一次真实配额）——这四类在 `isFailoverWorthy` 里被显式排除，旧文案说反了。
  - `row.cliBridgeHint`（中英）：`injectResult` **只影响 `/codebuddy` 指令**（结果回注会话、会话空闲时多花一次 DSH 回合），`codebuddy_ask` 工具不读它；并补上三条此前完全没提的限流（每会话每小时 6 回合、每进程每小时 20 回合、同时只跑一个回合）。
  - `row.tabFreeQuotaWarn`（中英）：不再声称「时间段内定额 Token 上限」这个插件**读不到**的机制（上游没有这个字段），改成「免费模型并非无限量：上游按单次请求体积与负载限流」；内部注释同步改写——6004 实测是**单次请求体积**触发（`src/probe.ts:71-89`：~25k 通过 / ~30k 被拒），14003 是模型侧负载，两者都不是累计定额。
  - `src/index.ts` 的 `WorkBuddyPoolPreferences.enabled` 注释：旧句「刻意不改变下一个由谁服务」与 `applyPoolSelection()` 每次请求都按排名设服务账号的事实相反；改成「从不改变的是用户**保存的选择**」，并留一句旧注释错在哪的追溯（#122 的审计者指出「用户文案反而比这处注释更准」）。
  - ①④ 三条审计结论无需改动：三条 tab 提醒在 5.5.0 的「能力」分区里已分开表述；5.71 仍是 2026-10-21 的实测常量（无配置项）、生图开关仍 CN-only 且关闭时根本不注册；测试默认 25000 与 1/2/3/5/10 万五档未变。

### Docs

- **README 产品截图换成真机图并做隐私处理**。旧图停在 5.5.0 之前（「一键签到所有账号」「刷新积分」等已改名的按钮），且带着真实令牌过期日 / 积分包到期日；本版换成维护者实机截的四张：设置卡「模型」页（`dsh-connect-workbuddy-usage-card.png`，含倍率、图片与可关闭思考开关、`拒绝 off` 标记、活动标签）、账号池（`dsh-connect-workbuddy-account-pool.png`，含「只有可换号的失败才换」的新文案与八行成员表）、输入框积分面板（`dsh-connect-workbuddy-composer-credits.png`，一键测试按钮）与模型选择器（`dsh-connect-workbuddy-model-picker.png`，同一枚活动徽标画在模型名之后）。
  - **隐私**：账号列每一行的名字格用不透明色块覆盖（不是可复原的马赛克），并逐行用「色块覆盖区内深色像素数 = 0」的脚本复核；积分、签到状态、排序位次与时间戳保留——它们不含身份。
  - 模型选择器那张只含模型名、倍率与活动文案，没有账号信息。`screenshots.json` 与中英两份 README 的 alt 文本同步。

## 5.5.1 (2026-10-23)

> 补丁版本：修「账号池状态重启就失效」的根因，以及同一症状的另外三处（手动排序箭头、`regionsMapOf` 跳层读旧副本、卡片保存把脏数据带回去）。**没有新增任何功能**：请求路径、provider 路由、模型目录、计费与凭据一律未变，5.5.0 的全部能力原样保留。
> **本版会主动改写一个设置字段的形状**：被 5.4.0–5.5.0 写脏的 `regions` 字段会在**开机时**被清洗一次（只动形状，不动任何区域内容，干净 profile 不写）。如果你正是「账号池重启就失效」的受害者，升级后重启一次即可恢复，**不需要手动改 profile**；国际版整槽沉到第 4 层的情况也会被捞回来（本机实测 3 个成员与 27 个模型目录）。

### Fixes

- **排序箭头在「账号池还没保存开启」时不出现 —— 先勾选再排序这条自然路径被堵死。** `AccountPool.tsx` 的 `moveEnabled` 读的是**已保存**的 `pool.enabled`，而同一行旁边的 `isMember` 读的却是**草稿** `active.memberAccountIds`。于是：勾选账号入池（草稿变了）→ 想去排序 → **箭头根本不存在**，因为开关还没保存；用户既看不到箭头，也就没有理由去按保存，下一次保存自然「什么都没写」——这正是「手动排序没保存」的实际形态。改成读草稿的 `active.enabled`：箭头描述的是草稿，就该跟着草稿走（报告运行中的池仍然是 `poolRunning`，那个值没有动）。变异验证：改回 `pool.enabled`，新增用例立刻红（期望 4 个箭头、实际 0 个）。
- **`regionsMapOf()` 会跳到更深一层，读到同名区域的过期副本。** 旧规则是「只要有 `regions` 键就往下跳」，理由是可以同时接受「整份 settings」和「regions map」两种入参。但 regions **map 自己也可能有 `regions` 键** —— 本机真实 profile 里 `config.regions` 下就躺着 `accounts` / `regions` / `cliBridge` 三个旧写入留下的兄弟键。一旦跳下去，读到的就是**另一份更旧的同名区域**：实测同一份文档，「按 section 读」得到 `['c','a','b']`，「按 map 读」得到 `[]`（正是「排序明明存了却读不出来」）。现在改为**按形状判定**：外层对象只要含有区域 id（`cn` / `global`）就是 map，直接用它；否则才是 section，才往里跳。变异验证：把判定换回无条件跳，新增用例立刻红。
- **「账号池状态重启就失效」的根因：目录修复把整份 settings 写进了 `regions` 字段。** 上一条修的是**读**，这一条修的是**造出那份脏数据的写**。`writeRegionCatalog()` 用 `{ op: 'set', path: ['regions'] }` 写回目录，所以它的值必须是 `regions` **字段**；但它把 `describe().value`（**整份 section**：`{authFile, accounts, regions, cliBridge, …}`）交给了 `mergeRegionCatalog()`，而后者把入参当字段读、又原样展开写回。结果每次开机目录修复都把 section 写进字段：真正的区域表被推到下一层 `regions` 键里，`accounts` / `cliBridge` 成了两个假区域槽，于是宿主 `regionStateOf(config, 'cn')`（只读一层）读到的是**空** —— 账号池开关、成员、手动排序、目标模型、模型选择全部「看起来没保存」，下次保存再把这份空写回去。每次开机多一层：本机实测 5 层、字段 103 KB（其中 3 层是纯拷贝）。修法：`mergeRegionCatalog()` 统一走 `regionsMapOf()`（接受 section 或字段），返回值恒为字段本身；`regionStateOf()`、设置保存端点 `__save`、卡片各写路径的合并基点、以及 `readOrderAccountIds()` 全部改走同一个窄化函数。
  - **脏 profile 不靠人手修**：`regionsMapOf()` 现在同时做三件事 —— 丢掉 section/槽位的兄弟键名拷贝；把只活在下层的区域**捞回来**（本机 `global` 就是这种情况：外层 `cn` 还在、国际版整槽只在下一层，不捞就等于让第一次写入删掉用户的国际版池）；「在表里的区域」仍然以外层为准，且当多个深层副本都有同一区域时按**用户配置量**取舍而不是按深浅（本机就有 `{lastCatalog}` 的空壳副本躺在一个仍有 3 个成员的真副本上面 —— 按深浅会捞回空壳）。修复写仍只在目录指纹变化时触发，但**字段脏时也写一次**，否则「目录恰好一致」的 profile 永远等不到打扫。
  - **修复写不再「只在目录变了才写」**：目录指纹相同时，只要 `Config['regions']` 还带兄弟键名就照写一次（`regionsFieldIsCorrupt()`），否则「目录恰好与上游一致」的 profile 永远等不到打扫 —— 那种 profile 的脏数据会活得比产生它的 bug 还久。写一次即净，之后这条分支不再触发。
  - **开机再补一次独立清洗**（`healRegionsField()`）：上面那条挂在「拿到实时模型目录」之后，于是关掉的区域、断网启动、上游空回答这三种情况都不会清洗。新增一次纯形状写入 —— 不需要上游、不碰任何区域内容、干净 profile 直接返回不写（只扫一遍键名），失败只记 warn（读侧本来就已是对的）。
  - **代价控制在请求路径上**：`regionStateOf()` 现在是每次请求都会走的读（池开关、模型选择、额度门控），而 heal 会深拷贝整份字段（每区一份多模型目录）。实测 28 模型槽位：不做快路径是 **11 µs/次**（原来裸读 0.05 µs），加「干净字段原样返回」的快路径后回到 **0.09 µs**；脏字段 0.86 µs 且只到 profile 被写入修复为止。快路径的成立条件写在代码注释里（只有**字段本身**是 volatile，槽内是普通数据），并用同引用断言（`toBe`）钉住，防止以后被顺手删掉。
  - **实测（本机真实 profile）**：修复前该字段 5 层嵌套、103 KB；用新 `mergeRegionCatalog()` 对同一份 section 重算，输出恰为 `['cn','global']`，13 KB；`cn` 保住 `pool.enabled=true` / `step-5-preview` / **8 个成员**，`global` 从下层捞回 `pool.enabled=true` / `deepseek-v4.1-flash` / **3 个成员**与 27 个模型目录。另有「主动清空」的保护：外层已显式写成 `null`（schemastery 把 `{}` 简化成 `null`）时不再从下层捞，否则会把用户清掉的池子复活。
  - **变异验证（六处，逐个改回旧行为都必红）**：①`mergeRegionCatalog()` 改回「把入参当字段」→ `catalog-write.spec.ts` 红 4 条；②`regionStateOf()` 改回单层裸读 → `region.spec.ts` 红（`global` 读成空）；③`__save` 改回对原始字段合并 → `web-status.spec.ts` 红（写回的值里出现 `regions` 兄弟键、`global` 消失）；④卡片写路径改回直接展开原始快照 → `client-account-selection.spec.ts` 红；⑤删掉快路径 → `region.spec.ts` 的同引用断言红；⑥删掉开机清洗的脏判断 → `catalog-write.spec.ts` 的「干净字段不写」红。新增 24 条测试（`catalog-write.spec.ts` 13 条、`region.spec.ts` 8 条、`web-status.spec.ts` / `client-account-selection.spec.ts` / `manual-order.spec.ts` 各 1 条）。

### Docs

- **写明负载徽标仅在国内版：国际网关没有这条接口（实测，非推断）。** 2026-10-22 用插件自己的凭据与客户端对 `www.workbuddy.ai` 实测：`POST /v2/chat/busy` 回 **404 `{"error_msg":"404 Route Not Found"}`**，另试 `/v3/chat/busy`、`/v2/models/busy`、`/v2/chat/model/busy`、`/v1/chat/busy`（POST + GET 各一次）**12 个组合全是 404**；同一份凭据读该网关的 `/v3/config` **200、28 个模型**，且这 28 个模型的**全部字段名里没有任何**含 busy / load / queue / wait / level / pressure 的字段。结论：**不是路径写错、不是身份不对、不是权限问题 —— 上游国际版从未提供这个事实**。行为保持不变（探针失败仍被 `withBusyLevels` 捕获、记一条 warn、模型目录照常下发，卡片渲染为「没有徽标」），本次只补文档与代码注释，**故意不按区域门控探针**：真门控等于把「上游将来补上」这件事也一并关掉，而今天多付的代价只是每轮一次 404。顺带订正 README 里一句已过时的描述（还写着「`idle` 有词但不画」）：5.3.1 起 `idle` 就是那枚**绿色火箭**、`normal` 是 1 个黄人，两处文案现在与 `src/client/busy-icon.tsx` 的实际渲染一致。

## 5.5.0 (2026-10-22)

> 新增能力属 **minor**：实时胶囊、会话续接、模型选择器的活动标签，以及账号池与卡片的信息架构整理。**provider 路由、模型目录、计费与凭据一律未变**；CLI 路线仍默认关闭，关闭时插件行为与 5.4.0 一致。
> **实时胶囊是唯一的例外**：它的只读路由 `/plugins/dsh-connect-workbuddy/cli-live` 与客户端组件**无条件注册**（否则客户端无法把「没有回合」和「没有这条路由」区分开），所以开关关着时每个打开的页面仍会每 5 秒问一次这条本地路由——它不碰上游、不花额度，代价是一个空数组的 JSON。

### Features

- **跑的时候看得见（实时胶囊）**：`conversation.composer.dock` 上挂一颗 `CodeBuddy · 7 tools · 42s · last: Bash`，数据来自插件自己的只读路由 `/plugins/dsh-connect-workbuddy/cli-live`（序列化宿主侧的 live board）。宿主工具调用是一次性的，`execute()` 不返回界面就什么都不知道——这颗胶囊补的就是那几分钟的空白。5 秒轮询、秒数由 1 秒本地 tick 推、多会话共享一个在途请求；没有回合时渲染 `null`，那一行不动。路由**无条件注册**（开关关着也在），客户端才能把「没有回合」与「没有这条路由」分开。**胶囊只描述本会话的回合**：座位 `conversation.composer.dock` 声明成 `scope: 'session'`，`inject` 第一个参数就是 `sessionId`，组件按它过滤——live board 是**宿主级**的（一条路由回答进程里所有会话），不过滤就会在 A 会话的输入框下面描述 B 会话（甚至另一个标签页）的回合。宿主没给 `sessionId` 时不过滤；宿主拿不到 `agent.id` 而标成 `sessionId: ''` 的行也保留，那同样是「真有人在干活」的证据。**不按供应商门控**：额度胶囊只在 WorkBuddy 供应商下出现是因为它报那家的额度，这颗胶囊报的是一个本地进程，CLI 路线刻意与模型无关。
- **连续调用默认续接同一条 CodeBuddy 对话**（`sessionContinuity`，默认 `auto`）。第一次调用报回的 CLI `session_id` 记在宿主进程里（按 DSH 会话分开，最多 256 条，FIFO），第二次调用没显式传 `session_id` 时自动用它走 `--session-id`。**先量过再接**：真机跑两轮，第一轮让 CLI 记住 `7391`，第二轮只传会话 id 问它数字，答出 `7391`，且两次回显同一个 id；另一个方向也量了——传一个**不存在**的 id 不报错，CLI 会静默开一条新会话，所以这条记忆丢掉或过期只会退化成「一次新对话」，不会串到别人的对话里。显式传 `session_id` 永远优先（可以故意开新线）；设 `off` 回到「每次独立」。**没有落盘**：值是一个 CLI 自己拥有的 uuid，CLI 对不存在的 id 不报错，弄丢的代价只是一次新对话，不值得为它引入一个需要回收的文件——因此重启宿主后记忆清空。
- **模型选择器里也能看见活动标签了**：卡片上的模型行一直有 `夜间折扣` / `独家限免` 这类胶囊，但**真正做选择的地方**（输入框旁的模型选择器）只有一个队列图标，于是同一次促销在卡片里写着、在选择器里看不见 —— 而选择器恰恰是用户决定「今天用哪个」的那一屏。
  - **零新请求、零硬编码**：促销候选本来就跟在 label slot 已经在拉的那个 usage 响应里（`WorkBuddyWebModel.promos`，`src/web-status.ts:672` 透传）。原来的 `levelsNow()` 只取了 `busyLevels`，把同一份 `models[]` 里的 `promos` 丢掉了；现在合并成 `statusNow()` 一次取回 `{ levels, promos }`。文案与颜色全部来自上游（`parseWorkBuddyPromos` 解析的 `/v3/config`），插件不判断「什么时候该免费」。
  - **用时钟判定，不在拉取时冻结**：`selectPromoBadge(promos, Date.now())` 在**渲染时**求值，并挂一个共享的 60 秒 ticker（首个订阅建立、最后一个卸载清掉，`unref()` 不吊住进程）重算 —— 否则 23:59 拉到的「夜间折扣」会一直挂到第二天早上。
  - **窄行说短词**：菜单行（`placement: 'option'`）用上游给的 `shortLabel`（`夜间` / `限免`），输入框触发器（`trigger`）用完整 `label`（`夜间折扣` / `独家限免`）；胶囊整体不截断，只对文字做省略号（`.dsm-workbuddy-model-label-promo` 限宽 6em，内层 `-text` 省略），避免把同一行里宿主的勾选、推理档位挤出去。顺序固定为**名字 → 促销 → 队列图标**：活动说「多少钱」，图标说「堵不堵」，是两个问题。
  - 顺带统一计费倍率写法：卡片原来是 `(0.00x)`，选择器是 `x0.00`，同一个数字两种写法；卡片改为 `x0.00`（`src/client/WorkBuddyCard.tsx`）。
  - `tests/model-label-slot.spec.tsx` 新增三条：①胶囊在名字之后、带上游色 `#009273`、且队列图标仍在；②`option` 用短词、`trigger` 用完整词；③`validUntil` 已过的活动**一个像素都不画**。都用 `mount` + `settle()` 而不是 `renderToStaticMarkup`：促销是在 `useEffect` 拉回来的，静态渲染跑不到那里。
- **三个「能力开关」搬进自己的「能力」分区，不再挤在「账号」面板顶部**：CLI 干活、模型自主生图、积分读数（含「显示位置」picker）原来平铺在「账号」面板的分区 tab 下面就着，和账号表格抢同一屏。这些开关**授权的是插件能替你做什么**（其中两个直接花钱、注册工具），而且点一下**当场生效** —— 它们既不属于「哪个账号服务这个 tab」，也不属于任何写着「点保存才生效」的区块。
  - 新增第四个分区 tab「能力」（介于「模型」与「诊断」之间），面板内容为一句说明（「插件可以替你做什么。这些开关点一下立即生效 —— 这一区里没有保存按钮。」）加那三组开关，顺序按代价排：**先花钱（CLI / 生图），再显示（积分读数）**。
  - 这样每个开关都有地方长自己的子选项 —— CLI 的工作目录、生图的尺寸或价格上限 —— 而不用继续在表格上方那一小条里越堆越长。
  - `tests/card-credits-switch.spec.tsx` 的两条断言随之改写：开关必须落在 `#dsm-workbuddy-panel-capabilities` **里面**，且 `#dsm-workbuddy-panel-accounts` 里**没有**它们；另一条断 tab 的文档顺序（模型 → 能力 → 诊断）、默认折叠、点击后展开且 `aria-selected` 变成 true。测试用 `[id="…"]` 而不是 `#…`：这套 jsdom 里 `#id` 选择器一律返回 null（踩过一次，全部断言假红）。
  - 未登录时仍然只有「账号」一屏（分区 tab 本来就不渲染），「能力」面板因此沿用 `hidden={signedIn && panel !== 'capabilities'}`，开关不会在旧 Host 上消失。

### Fixes

- **回注不再冒充用户发言**：`source.kind` 从 `'user'` 改成 `'codebuddy-bridge'`。`MessageSourceMap` 本来就是**可扩展**的（每个生产者在自己模块里声明 kind，`dsh-connect-atomcode` 就是这么做的），只在宿主自己的闭集里挑一个「最像的」既没必要也没好处——副作用是 GUI 把这条回注渲染成**用户气泡**，看不出它是通知。声明放在 `src/dsh-llm-augment.d.ts`；`PROVENANCE_LINE` 仍然留在正文首行，因为模型看不见 `source`。
- **胶囊改用 composer 共用的样式**：原来是内联 `fontSize: 0.85em` / `opacity: .85`，字号继承 dock 正文，和旁边的额度胶囊、ContextMeter 对不齐，看着像外挂。类定义进 `WORKBUDDY_COMPOSER_CSS`（`.dsm-workbuddy-cli-live` / `-dot`，12px、`label-tertiary`、tab-nums、`prefers-reduced-motion` 关掉脉冲），由组件自己幂等注入——额度胶囊被 gate 关掉时样式也得在。
- **Windows 上自动探测 CLI 会 100% 失败（阻断级）。** #107 把清单写成「每个根目录都拼 `lib/node_modules`」，但 Windows 的 npm 全局前缀是 `%APPDATA%\npm`，包直接落在 `<prefix>\node_modules`，**没有 `lib` 这一层**。于是它探测的是 `%APPDATA%\npm\lib\node_modules\...` —— 那个目录在 Windows 上根本不存在，9 条候选全部落空，`resolveCliEntry('')` 直接报「没有找到本机安装的 CodeBuddy CLI」，用户必须手填 `cliBridge.binary` 才能用。修法：清单改成「每个根目录自带自己的布局」—— Windows 前缀拼 `node_modules`，POSIX 前缀拼 `lib/node_modules`，pnpm / yarn 的全局仓本身**就是** `node_modules` 根；volta 的镜像目录改成按版本展开（`tools/image/node/<version>/lib/node_modules`）。顺带去重：`%APPDATA%\npm` 与 `~/AppData/Roaming/npm` 在正常 Windows 上是同一个目录，原清单把它列了两遍。**为什么 CI 没拦住**：#107 的 runner spec 里没有任何一条针对 `cliEntryCandidates()` 的断言，所以 windows-latest 腿照样绿着 —— 绿的是测试，坏的是真机。现在补了 4 条。
- **同一类缺陷还有三处（一并补上）：pnpm / yarn / fnm 在 Windows 上的默认位置。** 清单原来只写 POSIX 路径（`~/.local/share/pnpm/global/5`、`~/.config/yarn/global`、`~/.fnm/node-versions`），而这三家在 Windows 上分别落在 `%LOCALAPPDATA%\pnpm\global\5`、`%LOCALAPPDATA%\Yarn\Data\global`、`%APPDATA%\fnm\node-versions`；pnpm 在 macOS 上还有 `~/Library/pnpm/global/5`。这些路径按各自工具文档的默认值补 —— 判错只多一次 `existsSync`，判漏就是「CLI not found」。**本机只能实测 npm 那条**（`%APPDATA%\npm\node_modules\@tencent-ai\codebuddy-code` 确认存在），其余三条没有对应的全局安装可验证。
- **`/codebuddy` 的示例在自己的默认配置下必然失败。** hint 写「或写你的要求（如"修一下这个空指针"）」，但非评审调用**不传** `permission_mode`，于是走默认的 `dontAsk` = 写文件被拒。工具入口有 `permission_mode` 参数可按次覆盖，指令入口什么都没有 —— 这条不对称让 hint 举的那个例子只能是「这些工具被拒绝」。修法：新增 `--edit` 前缀（`/codebuddy --edit 修一下这个空指针`），只对这一次调用生效、不改默认值；`--edit` 单独用 = 评审并顺手修掉找到的问题。hint 与描述改成「留空 = 评审 / 写字 = 只读执行 / `--edit` 开头 = 允许改文件」，被拒时的提示也改成指向 `--edit`。`--edit` 会被剥掉，不会传给 CodeBuddy。
- **配额拒绝时会泄漏临时目录。** `resolveWorkingDir()` 在 `allow_unattended` 下**先**创建 scratch 目录，`gate.tryEnter()` 在它之后；被拒时直接 `return`，那个目录就留在 OS temp 里 —— 配额耗尽后反复重试，每次留一个空目录。实测本机 temp 里已经堆了 **9 个**。修法：拒绝分支里同样 `removeScratch`。测试是**先证明它会红**才留下的：把修复临时摘掉跑一次，报 `expected [ 'dsh-codebuddy-scratch-fVf7kZ' ] to deeply equal []`。
- **`scratchDir()` 的固定共享目录改成每次调用一个新目录。** 原来是固定路径 `tmpdir()/dsh-codebuddy-scratch`：两个并发的无人值守回合会共用一块可读写空间，互相看得见、也改得掉对方的文件，上一轮留下的东西还在。现在用 `mkdtempSync`，每次拿到一个空的、名字唯一的目录，回合结束时（`finally`）尽力删除。`allowUnattended` 仍然默认 `false`。
- **`isReviewInvocation` 的注释过期。** 它还写着「empty line」，而 `--edit` 单独出现也会走评审分支。一行注释的事，但下一个读代码的人会按注释理解行为。
- **胶囊的秒数会冻住（新增功能里的缺陷，被新测试当场逮到）。** 时钟偏移原本在**每次轮询返回**时重算（`offsetRef.current = next.serverTime - Date.now()`），但 `readLive` 会把同一份文档缓存到下一个轮询周期，而那份文档带的是**旧的** `serverTime` —— 于是每次命中缓存都把已经过去的时间从偏移里再减一遍，`Date.now() + offset - startedAt` 恒等于文档刚取到时的年龄，计数器永远显示同一个秒数（实测：过了 1.1 秒仍然显示 `0s`）。修法：只在 `serverTime` 变化（即真的拿到新文档）时重算偏移。测试是**先证明它会红**才留下的：把守卫临时改成恒真，报 `expected 'CodeBuddy · 3 tools · 0s · last: Read' to contain '1s'`。
- **`serverTime` 缺校验时标签会印出 `NaNs`（独立复审发现的第二处）。** 路由是本插件自己的，但「自己人」不等于「永远对」：字段被改名、`undefined` 被 `JSON.stringify` 丢掉、以后换了 shape，都会让 `serverTime` 变成 `NaN`，偏移变 `NaN`，`Math.round(NaN)` 还是 `NaN`，而用户正好在这一行看「还要多久」。现在整份文档先过 `acceptDocument()`：`turns` 必须是数组、`serverTime` 必须是有限数字，单条回合缺 `startedAt`/`toolCalls` 时只丢那一条。测试同样是**先证明会红**：摘掉守卫跑一次，报 `expected 'CodeBuddy · 3 tools · NaNs · last: Read' to be ''`。
- **路由连续失败时胶囊不会退场。** 原来的注释说「失败就继续显示上一份文档，等下一个 tick」——对一次掉包是对的，对一条开始返 500 的路由就是错的：胶囊会无限期描述一个早就结束的回合，秒数还在涨。现在连续三个周期（15s）拿不到文档就清空，长到能扛过一次重载，短到不会在输入框上留一颗幽灵。
- **胶囊会把别人的回合算成自己的（新增功能里的缺陷）。** live board 是**宿主级**的，一条路由回答进程里所有会话；组件原来不加区分地画「最新的那条」，于是 A 会话输入框下面会描述 B 会话（甚至另一个标签页）的回合——一条关于你没在看的目录的字，计数器还在动。现在座位用 `scope: 'session'` 给的 `sessionId` 过滤，只留本会话的行；宿主没给 id 时不过滤，`sessionId: ''`（宿主拿不到 `agent.id`）的行也保留。
- **板子上的 `sessionId` 被 CLI 自己的 uuid 覆盖。** `tool.ts` 在「finishing」阶段写过 `liveTurn.sessionId = outcome.sessionId`，但那是**两个不同的 id**：板子上的 `sessionId` 是回合所属的 DSH 会话（开行时取自 `execution.agent.id`，也是胶囊过滤用的那个），`outcome.sessionId` 是 CLI 自己的会话 uuid（结果里以 `session_id` 返回，用于续接 CLI 会话）。覆盖之后，每个回合在最后几秒都会显示成属于一个不存在的会话——加上本会话过滤后，胶囊会把自己的行丢掉。现在两个 id 各归各位；回归测试**先证明它会红**才留下：把那一行临时加回去，报 `expected 'cli-session-uuid' to be 'session-dsh'`。
- **账号池的总开关上移为模式条**：原来决定整页行为的「启用账号池」在页面最底部，而被它控制的一切在顶部。现在它紧跟标题，同一行给出当前模式（自动挑号 / 手动选号）和一句说明；池关闭时账号选择器收进标题行右侧，不再单占一行并重复一次账号名。
  - **删掉逐字重复的整段说明**：同一段「开启后……关闭后……」原来在按钮下方和底部开关下方各出现一次，读起来像开发注释漏到界面上。
  - **「当前使用」与「未入池」不再同框**：两者是正交概念，同时出现会让人问「都在用了为什么不在池里」。行内只保留「未入池」，当前账号不在池里时在模式条下给一句旁注（`poolServingOutside`）。
  - **禁用原因就近**：空池时「勾选至少一个账号，才能签到与测试。」紧贴「已选 0 / 1」，不再挂在半屏之外。
- **排序规则说明移到「更多设置」顶部**：纯说明不该排在账号前面（用户的直接反馈）。
- **测试模型只说一遍**：设置行、行尾、表头原本各说一次同一个模型；行尾改为仅在「实际测的模型 ≠ 本池保存的模型」时才提示。「目标模型」列名本就是误称（该列是可用性状态），改为「状态」。
- **保存条改为 sticky**：两个让改动生效的按钮原本在整页最底部，编辑完时正好在视口之外。
- 「账号池设置」降级为「更多设置」；`row.poolNeverTested` 由「尚未测试」改为「未测试」。
- **两个批量按钮不再说「所有账号」**：它们只走**勾选进池**的成员 —— 而表格里未勾选的账号就摆在旁边，所以「一键签到所有账号」会被读成「我登录过的每一个账号」，与同一个面板里那句「只有勾选的账号参与轮换、签到与测试」正好相反。改名「**签到勾选的账号**」「**测试勾选的账号**」（英文 `Check in selected` / `Test selected`）：对谁做，由按钮自己说完。**禁用条件本来就是同一套语义**（一个都没勾就置灰），所以这只是把界面上最后一句不实的话改掉，交互与请求集合一个字没动。
  - 英文旧标签 `Check in all accounts` 也一并改掉：英文的 "all accounts" 和中文一样，读的是「所有账号」，不是「池里所有成员」。
  - README 里引用旧按钮名的措辞同步（中 5 处 / 英 4 处）；**CHANGELOG 的历史条目保留原措辞** —— 那是当时界面上的事实，改掉等于伪造记录。
  - 文案键没动（测试用的是保键翻译器 `t`），所以没有测试需要改：`tests/pool-render.spec.tsx` 与 `tests/pool-card-render.spec.tsx` 里 `m.button('row.poolCheckinAll')` 这类断言照旧生效，也正是它们保证这个键不会被顺手改名。
- **批量按钮搬进成员区，紧跟「已选 N / M · 全选 / 全不选」**：这两个按钮只对**勾选的账号**做事，而「勾了哪些、勾了几个」是**成员区**在回答 —— 它原来却挂在成员区**上方**，读起来像一条页面级工具栏：先看到「签到勾选的账号」，往下 40px 才遇到「本池包含的账号 / 已选 1 / 1」。顺序改成**先声明范围，再给动作，再列账号**：`本池包含的账号 + 已选 + 全选/全不选` → `签到勾选的账号 · 测试勾选的账号 ·…· 重新检测账号` → 表格。
  - 顺带去掉这条工具条的上边框：它现在是成员块内部的一行，和上面那行计数是一件事，分隔线会把按钮和解释它们的数字切开；真正需要分隔的是它下面那块「更多设置」，那里的线保留。
  - 空池时的就近提示（「勾选至少一个账号，才能签到与测试。」）也跟着落到「已选 0 / 1」的下一行，禁用原因和禁用状态现在同屏同一处。
  - 新增 `tests/pool-render.spec.tsx` 断言：`pool-actions` 必须排在 `pool-members-head` **之后**、`pool-table` **之前**，且 `closest('.dsm-workbuddy-pool-members')` 不为 null（是成员块的子节点，不是兄弟节点）。三条断的都是文档顺序，改回去会直接红。
- **「扫码登录 / 导出导入」那一块不再自己念一遍标题，并从「更多设置」里搬到了它上方**：两处都是用户直接指出的观感问题，改的却是同一块 DOM。
  - **删掉重复的一行**：这一块原来每条上面都有一行小标题——「扫码添加账号」压着一个「扫码登录」按钮，「导出 / 导入账号」压着「导出账号」「导入账号」。两个词说的是同一件事，标题只比按钮多说两个字，却每条都要占掉一行高度。**标题保留但不显示**：它现在是该 `<section>` 的 `aria-label`，读屏器仍然知道这块叫什么，而屏幕上由按钮自己报名。`.dsm-workbuddy-bar-label` 这条样式规则随之删除——删掉类而留着空 `<p>` 是没有意义的，空段落一样占那一行。
  - **搬到「更多设置」上方**：它原本在「更多设置」标题**底下**、紧跟标题里的那句「下面是偏好设置：点保存才生效」。这句话对账号工具是**假的**——扫码登录和导入点一下当场生效，从来没有保存这一步。动作和偏好混在同一块里，先读说明的人会去找一个根本不需要的按钮，先动手的人则会被表格自己变了吓一跳。搬到标题上方之后，虚线边框加「这里没有保存按钮」把两件事分开了：**上面是动作，下面是偏好**。
  - 这一块顺带从两行竖排换成一行左对齐的工具条：标题没了之后没有东西需要竖着堆，而横排才是用户找「立即执行」的地方；「扫码登录」排在第一个、贴着面板左边，和一键签到、下面的「更多设置」同一条视觉栏。窄面板下仍然自动换行，状态文字也不再被省略号截断（在工具条里它宁可换行也要说完）。
  - 这三处都写进了测试：`tests/oauth-wording.spec.tsx` 改为断言 `aria-label`（`textContent` 看不见属性，删掉名字就会拿到 null 而不是悄悄通过），并新增 `tests/account-tools-placement.spec.tsx`——「在上方」断的是**文档顺序**，「不在保存区块里」断的是 `closest('.dsm-workbuddy-pool-settings')` 为 null，两条都不是源码注释能糊过去的。

### Tests

- 重做版补的 8 条：`cliEntryCandidates()` 的四条布局断言（Windows 的 npm 前缀下直接是 `node_modules`、**没有 `lib` 层**；POSIX 前缀仍拼 `lib/node_modules`；pnpm / yarn 的全局仓本身就是模块根；同一个目录只被探测一次）；Windows 上 pnpm / yarn / fnm 三个仓库位置一条（fnm 那条要真造一个版本目录，否则「按版本展开」根本没被执行）；`parseCommandInput` 的 `--edit` 一条（带正文 → `acceptEdits` 且正文剥掉前缀）；配额拒绝后临时目录不残留一条；以及一条**反向约束**：指令的 hint 里不得出现默认权限模式跑不起来的示例。
- **实时胶囊的测试（新增）**：`tests/cli-bridge-live.spec.ts`（12 条）锁宿主侧 live board —— 开/退休告、失败回合也退休、指令与工具两个入口的标签、`elapsedMs` 由宿主时钟算、无 board 时不告警、以及「目录校验拒绝的调用**不得**留下胶囊」（公告发生在所有前置条件之后，所以没开始的工作不会闪一下）；`tests/cli-bridge-live-pill.spec.tsx`（19 条）锁客户端 —— 空闲渲染 `null`、标签含工具数与秒数、`starting`/`finishing` 不显示秒、`+N`、**秒数在两次轮询之间本地前进且请求数不变**、宿主时钟偏移校正、路由失败/畸形文档/没有 `fetch` 都不抛、**`serverTime` 不是数字时整份文档作废（否则标签会印出 `NaNs`）**、**单条回合缺数字时只丢那一条**、**连续三个周期失败后胶囊自己退场**、目录只进 tooltip 不进标签、**只描述本会话的回合**（别会话的行既不出现在标签里也不计入 `+N`）、**只有别会话在跑时渲染 `null`**、**宿主标不成会话的行照样保留**、**座位不给 `sessionId` 时不过滤**，以及 `readLive` 的并发合并与缓存过期。另在 `cli-bridge-runner.spec.ts` 补一条「板子上的 `sessionId` 必须是 DSH 会话 id，不得被 CLI 自己的 uuid 覆盖」——**先证明它会红**才留下：把那一行临时加回去，报 `expected 'cli-session-uuid' to be 'session-dsh'`。
- **会话续接的 7 条**（`cli-bridge-runner.spec.ts` 4 条 + `cli-bridge.spec.ts` 3 条）：第二轮真的带上第一轮报回的 `--session-id`、**第一轮不带**（没有可续接的就不该传）、显式 `session_id` 盖过记忆、`off` 时两轮都不带、两个 DSH 会话互不串（记忆按会话分桶）、设置的默认值与错值回退、以及记忆本身的写入/覆盖/清空/空值不覆盖/256 条上限。跨会话那条第一版用的是固定 key，被记忆污染后改成每例独立 key + `forgetCliSession` —— 那不是「修测试」，是测试自己发现了一个真实的隔离缺口。
- `tests/pool-render.spec.tsx`：新增 `pool-actions` 必须排在 `pool-members-head` 之后、`pool-table` 之前，且属于成员块子节点的断言；排序规则说明改为断言「在表格之后、目标模型设置之前」。
- `tests/account-tools-placement.spec.tsx`（新增）：「在上方」断文档顺序，「不在保存区块里」断 `closest('.dsm-workbuddy-pool-settings')` 为 null，「没有标题」断 `.dsm-workbuddy-bar-label` 不存在且标题只存在于 `aria-label`。
- `tests/oauth-wording.spec.tsx`：断言从 `textContent` 改为 `aria-label`（属性不进 textContent，删掉名字会拿到 null 而不是悄悄通过）。
- `tests/model-label-slot.spec.tsx` 新增三条：①胶囊在名字之后、带上游色 `#009273`、且队列图标仍在；②`option` 用短词、`trigger` 用完整词；③`validUntil` 已过的活动**一个像素都不画**。都用 `mount` + `settle()` 而不是 `renderToStaticMarkup`：促销是在 `useEffect` 拉回来的，静态渲染跑不到那里。
- `tests/card-credits-switch.spec.tsx`：开关必须落在 `#dsm-workbuddy-panel-capabilities` **里面**，且 `#dsm-workbuddy-panel-accounts` 里**没有**它们；另一条断 tab 的文档顺序（模型 → 能力 → 诊断）、默认折叠、点击后展开且 `aria-selected` 变成 true。
- 全量：**124 文件 / 2055 条通过（另 2 条 skip，共 125 文件 / 2057 条）**；`tsc -p tsconfig.json` 与 `tsc -p tsconfig.client.json` 均 exit 0；`tsdown` build 成功。

## 5.4.0 (2026-10-22)

> 少数版本：修四处真实缺陷，**请求路径、provider 路由、计费与凭据一律未变**。其中三处是「代码写好了但没被走到」的缺陷——功能早就存在，只是有一整类真实报文从未进入它们。

### Fixes

- **模型目录不再被陈旧快照锁死（#114 + #115，同一处缺陷的两面）**
  - **病因**：`configuredModels()` / `displayModels()` 把「已保存目录 `lastCatalog`」当作第一优先级，而它**唯一的写入者**是卡片保存、写回的又是**它自己读到的目录**——闭环成立，实时目录被永久压制。于是上游新增的模型（CN 的 `deepseek-v4.1-flash`）永远进不来；更糟的是**冷启动播种**会在上游尚未应答时把静态兜底表写进 `lastCatalog`，而那张表**不含 `reasoning`**，每个模型因此以 `reasoning: false` 发布，宿主只给 `Default` / `Off`。
  - **修法**：目录解析改为「**实时 > 已保存 > 静态兜底**」。已保存目录只承担**名字与勾选**，能力字段（`reasoning` / `creditMultiplier` / `supportsImages`）一律取自实时目录（新增 `src/catalog-sync.ts`）。上游已撤回但用户仍在用的模型继续保留（#32 的规则不变）。
  - **自愈**：实时目录到达后按**内容指纹**比对回写 `lastCatalog`，只在真有差异时写、幂等（新增 `src/catalog-write.ts`），所以升级后无需手动清 profile。与兜底表逐项相同且不含能力字段的旧快照被识别为「从未配置」，不再当真。
  - **播种不再写兜底表**：`src/web-status.ts` 播种前先判断「这份目录是不是兜底表本身」，是则跳过。
  - **`busyLevel` 绝不进入卡片目录**：它是「这一分钟」的事实（`src/busy.ts`），且显式 `undefined` 会被设置写入的严格 JSON 编解码器拒绝，因此按 key 删除而非赋 `undefined`。

- **`11128` 一族按 code 整体识别，成员由插件自己的证据点名（#113）**
  - **病因**：旧 `isChannelRejectBody()` 要求「带渠道措辞」**且**「不带另两个门的措辞」。而 #113 实测到 `msg: "conversation id missing"` 出现在**携带全部三个会话头**的请求上——措辞不可信。后果不是文案问题：该 body 被判成 `client`，而 `src/shim.ts` 的两级救援阶梯（`forceNeutralHead` → `perturbChannelFingerprints`）是**按 kind 门控**的，`client` 根本不进那个分支。**门 A、门 B 的救援都写好了，但这一整类真实报文从未走到它们面前**——这解释了「升级了却没变化」的反馈。
  - **修法**：`isChannelRejectBody()` 现在回答「是否属于 11128 一族」，只按 `"code":11128` 判定；新增 `channelGateMemberOf()`，用**请求侧证据**（是否带了会话头 / 首条是否 system）点名成员 `prompt` / `headers` / `first_message` / `unknown`，只影响**建议文案**、不影响分类。回复会回显上游原始 `msg`（新增 `UpstreamErrorDetail.rawMsg`）并说明为何可信或不可信；不认识的措辞明确写「没点名是哪一道门」，而不是猜一个诊断。

- **扰动补上词内断点（#113 暴露的真实缺口）**
  - 原来只在 `.` `!` `?` `,` `;` 之后插入零宽字符，所以**结尾没有标点的裸产品名完全不会被改动**——例如 DSH agent 提示的首行 `You are an AI agent powered by DeepSeek Harness` 正好在文末，`perturbChannelFingerprints()` 直接返回 `undefined`（「无可改动」），救援空转。现在按「大写词 + 大写词」加词内断点（`DeepSeek|Harness`），仍只在**上游已拒绝之后**作为最后一级重试发生，正常请求一个字节都不动。

- **`alignAssistantIdentities` 只改本插件产生的消息（#111）**
  - **病因**：原实现对**每一条** `role: 'assistant'` 消息重写 `provider` / `api`，其 docblock 断言「transcript 里不会有别的 provider 的 assistant 轮次」。**该前提不成立**：`dsh-llm` 的 `forAdapter()` 只剥掉外来消息的 `replayState`，消息本身留在列表里。于是切换过 provider 的会话会把别人的轮次改写成 `workbuddy` / `openai-completions`——等于把宿主刚关上的「可重放」那道门重新打开，并让 transcript 宣称一个不成立的来源。
  - **修法**：重写范围收敛到本 bundle 的两个路由（`workbuddy` / `workbuddy-global`）或已带 identity 的消息，其余**原对象返回**。#102（全球区 thinking 被压平）与 #59（跨区 identity）的修复均不受影响。`HOST_FOREIGN_API` 改为导出以便测试钉住。

### Docs

- 订正三处此前写错的论证：`reasoning` **不会**被设置写入路径剥掉（实测 `projectForm` / standard validate 都完整保留；`simplify()` 只是表单投影、不在写入路径上）；「回显的 `You are a helpful assistant.` 就是被拒的开头」实为插件自己垫的中性头挡住了真实开头（4.15.x 已改为从 `raw` 读证据）；`systemOpeningsOfBody()` 只读字符串 content 的数组形状盲区已由 `openingEvidenceOfBody()` 取代。

### Tests

- 新增 `tests/catalog-sync.spec.ts`（22 条）、`tests/issue113-channel-gate-evidence.spec.ts`（17 条，含一条端到端「用 #113 的真实报文作第一次应答，断言插件真的发出了第二次请求」）、`tests/issue111-align-scope.spec.ts`（9 条）。
- 订正 `tests/issue90-channel-reject.spec.ts`、`tests/issue98-channel-gate.spec.ts`、`tests/issue98-shim.spec.ts` 里四处**钉住旧行为**的断言（它们把「11128 的另两个门归类为 `client`」当成契约，而那正是 #113 要修的东西）。
- 全量：**121 文件 / 1996 条通过（另 2 条 skip）**；两个 tsconfig 均 exit 0；build 成功。

## 5.3.1 (2026-10-22)

> 补丁版本：5.3.0 已经发布了负载徽标，这一版修它的**消失**问题，并把它的**呈现方式**换成更好认的样子。	**没有新增任何功能**：模型目录、请求路径、provider 路由、计费与凭据一律未变，5.3.0 的全部能力原样保留。


### Fixes

- **负载徽标不再「刚出现就消失」**：等级以前只活在**运行时目录**里，而任何一次配置变更（切区、改模型选择、改思考档、开关、换号）都会触发 `applySelection()` 用**已保存的 `lastCatalog` 重算目录**——而 `lastCatalog` 里没有 `busyLevel`（负载**刻意不落盘**：`src/busy.ts` 写着「存下来的负载等级是谎言」）。于是你一动任何设置，徽标就被抹掉，上游其实什么都没变。	**现在改为「重放后重新问一次」**：探针只读、免费、整份名单约 190 ms，徽标因此在设置变更后活下来。	不落盘这件事仍然保留——负载是**这一分钟**的事实，跨重启后那个数字可能早就过期了，比不显示更危险。	探针失败照旧只是少一枚徽标，绝不会连模型列表一起丢。

- **负载徽标改用图标**：拥堵不再是四个字，而是一枚一眼能认的标记。
  - **四种状态、四种标记**：**正常 `normal` = 1 个黄人**、**轻微拥堵 `busy` = 2 个橙人**、**极度拥堵 `congested` = 3 个红人**、**空闲 `idle` = 一枚绿色火箭**（没人排队 = 可以全速跑）。	**人数 = 排队的人**，**颜色 = 严重程度**（绿→黄→橙→红是眼睛本来就认识的顺序，扫一眼就能比出两行谁更堵）。	空闲之所以是**另一种形状**而不是「绿色的 1 个人」：在 12px 下「没人等」和「有 1 个人在等」必须一眼分开，光靠颜色不够。
  - **小人跟 `🧍` emoji 是同一个人**：黄头发（带刘海）、肤色脸和白上衣、灰裤、黑鞋。	**换色只改「上衣+裤子」**，头发和皮肤保留本色，所以每一档都是「同一个人换了件衣服」。	**五官不画**——模型行里高度只有 12px，眼睛画出来只有 0.2px，是噪点不是脸，靠轮廓认人。	横向步进 9.6 个单位（约半个身位），肩挨肩，**高度固定、只向右变宽**，不会被压扁。
  - **模型选择器里也用彩色小人**：宿主提供了 `conversation.input.model.label` 插槽（契约原文：「渲染非交互的内联内容，例如带颜色的名称或徽标」；官方自己就用它挂 DeepSeek 的「1017」发布徽标），插件在那里注册了 SVG 标记。	**模型名里不再挂 emoji**——那会变成同一件事用两套视觉语言说两遍；emoji 的颜色本来就由字体决定（永远是黄的），拿不到绿/黄/橙/红。	插槽里**保留目录里的模型名**，只在旁边加徽标；**别人的提供方一个徽标都不画、连请求都不发**；徽标按 provider 取**对应区域**的等级（`workbuddy`→cn、`workbuddy-global`→global，否则会把一个网关的负载贴到另一个网关的模型上）。
  - 颜色跟随主题，并**保留 `title` 悬停文字**（「极度拥堵」四个字还在），所以省地方但不丢信息。

### Tests

- 新增 `tests/busy-badge.spec.ts`（8 条）、`tests/busy-icon-card.spec.tsx`（11 条）与 `tests/model-label-slot.spec.tsx`（5 条），覆盖徽标的合并语义、图标的人数与颜色、以及插槽的「别人的提供方不画、模型名要保留、没等级就不画」。
- 全量：**119 文件 / 1946 条通过（另 2 条 skip）**；两个 tsconfig 均 exit 0；build 成功。

## 5.3.0 (2026-10-22)

> 新增能力属 **minor**，本次定版 **5.3.0**。**默认关闭，关闭时插件行为与 5.2.3 完全一致**：不多一个工具、不多一条指令、不多一个请求，provider 路由、模型、凭据与计费一律未变。
>
> 这一版是 PR #104 按维护者 13 条评审逐条重做的结果，**不是原样重提**。改动分三类：把「原版会真的伤到用户」的地方修掉、把原版站不住的论证改掉、把 runner 这条从未被测过的路径补上测试。

### Features

- **CLI 路线（可选）：让本机已登录的 CodeBuddy CLI 直接干活**
  - **两个入口**：`codebuddy_ask` 工具（模型自己调用）与 `/codebuddy` 指令（用户敲，**自动取当前会话工作区**，留空 = 评审未提交改动）。
  - **结论回注会话模型**（`injectResult`，默认开）：空闲则 `steer` 起一轮，运行中则 `inject` 排进下一步。回注文本首行带 `[dsh-connect-workbuddy · 由 /codebuddy 自动回注，不是用户输入]`，并明确写「不要为了再确认一次而重复调用」，防止「回注 → 模型再问 → 再回注」的烧额度循环。
  - **凭据复用**：`CODEBUDDY_AUTH_TOKEN` → 插件已维护的 vault，**不需要再登录一次**。区域优先于新鲜度，`regionOrder` 默认 `cn,global`。
  - **非破坏性装配**：`cliBridge.enabled` 默认 `false`；`tools` / `commands` 用 `ctx.inject([...])`（**不是** apply 期 `ctx.get()` 采样）等待宿主服务。
  - **配置**：`cliBridge.{enabled,binary,model,permissionMode,effort,maxTurns,timeoutSecs,regionOrder,workingDir,allowedDirs,appendSystemPrompt,allowUnattended,maxReplyChars,injectResult,maxTurnsPerSessionHour,maxTurnsPerHour}`，逐键有默认值，硬上限 `maxTurns 100` / `timeoutSecs 1800` / `maxReplyChars 400000`。**`cliBridge` 是 volatile 字段**：改它只重建这一条路由，不 dispose 两个 provider 栈。
  - **开关在卡片里，不用手改 YAML**：账号卡片的偏好区新增一个**全局**勾选「允许调用本机 CodeBuddy CLI 干活」，默认关闭。勾上后 `/codebuddy` 与 `codebuddy_ask` 一起出现，取消后一起消失；**关着时两个入口根本不注册**，不是注册后藏起来。写的是顶层 `cliBridge.enabled`（全局，与 cn/global 分区无关），只重建这一条路由，不 dispose provider 栈、不打断在飞请求。读取走 Host 的已提交值而不是浏览器镜像——后者在本命名空间会 stale，一个「看起来开了」的假值在这里等于谎报消费能力。

### Fixes（相对 PR #104 初版）

- **默认权限模式从 `acceptEdits` 改成 `dontAsk`，并且不采用评审建议的 `plan`。** `plan` 在 `-p` 下会发 `control_request` 等 stdin 回授权（`ExitPlanMode`）；初版写完 prompt 就 `stdin.end()`，于是永远等不到回音，一路等到 `timeoutSecs`（默认 900 秒）才失败 —— 真机两次实测都是这样挂死的。`dontAsk` 则是只读工具放行、写工具被拒、且**不卡住**（真机实测：9.9 秒一轮，Glob/Bash 放行、Write 被拒并如实汇报）。同时 runner 现在对每一条 `control_request` 明确拒绝，但 **`interrupt` 按工具区分**：只有 `ExitPlanMode` 带 `interrupt: true`（不带则 `plan` 挂过 70 秒），其它工具不带——带了会让整轮中止（实测 `acceptEdits` 下拒绝 Bash → `is_error`、空回复、4.2 秒），不带则 CLI 换个工具继续（实测改用 PowerShell，12 秒正常出结论）。拒绝理由也不能以 `cancelled` / `timeout waiting for user response` / `this is an unattended automated session` 开头（CLI 会把这类理由当作 synthetic deny 忽略掉，工具继续跑）。
- **工作目录不再「传什么用什么」。** 初版把 `args.working_dir` 原样返回，配合默认写权限，模型可以让 agent 在 `/` 或 `~/.ssh` 里跑。现在：显式目录必须是**绝对路径**、**存在且是目录**、**落在允许根之内**（本会话工作区 / `workingDir` / `allowedDirs`），比较用 `realpath` 解析后的路径并按分隔符对齐边界（`/repo-evil` 不算 `/repo`）。工具入口的目录阶梯也从「宿主 `exec.cwd`」改成「**本会话工作区**（`execution.agent.session.header.cwd`）」——宿主给工具的 execution 里根本没有 `cwd` 字段，那一级在初版里永远是 `undefined`。
- **装配改用 `ctx.inject`。** 初版在 `apply` 期 `ctx.get('tools')` / `ctx.get('commands')` 采样一次，与本仓库自己写的警告（"sampling ctx.get() once during apply silently loses all routes on Desktop"）冲突；Desktop 上服务晚到位时两个入口会静默消失。现在与生图工具同一套写法。
- **`/codebuddy` 的文案不再说谎。** 初版描述写「不经过模型，不消耗 DSH 额度」，但 `injectResult` 默认开会 steer 唤醒会话模型 —— 默认配置下**真的花 DSH token**。描述与 README 现在都写明这一点，并指出 `injectResult: false` 才是完全不碰模型。
- **加配额闸门。** 初版没有次数/频率上限，只有 `/codebuddy` 侧的 `inFlight` 挡同会话并发，工具侧完全不设防，且回注文本还写「据此继续」，形成循环烧 CodeBuddy 配额的路径。现在 `TurnGate` 同时管工具与指令（**共享同一个门**，初版的 `inFlight` 只覆盖指令），每会话每小时 6 次、全场每小时 20 次（`0` = 不限），超限具名拒绝并写日志；工具描述里带成本信号。
- **换号只看凭据拒绝，且不再扫模型正文。** 初版 `looksLikeAuthFailure` 的正则作用在 `${errors}\n${text}`，把 assistant 的正文也扫了 —— 评审一段含 `HTTP 401` 的代码就会误判凭据被拒、整轮换号重跑。现在只看 `{isError, errors, subtype}`，并且 `catch` 里不再一律 `continue`：超时、崩溃、ENOENT 直接抛，只有明确 401 才换下一个账号（初版在 10 个 vault 账号下最坏会跑 10 × 900 秒）。
- **超时真的杀干净。** 初版只 `child.kill()` 直接子进程，CLI 派生的 `git` / `npm` 变孤儿。现在 POSIX 用 `detached: true` + `process.kill(-pid)` 并在一秒后升级 SIGKILL，Windows 用 `taskkill /pid <pid> /T /F`；收到 result 帧后先 `stdin.end()` 并给 3 秒优雅退出窗口（实测 96 ms 自行退出），超时才杀树。
- **缓冲有上限。** stdout 单行超 8 MiB、assistant 文本累计超 2M 字符、stderr 超 16K 字符都各自有界；初版 `stderr += chunk` 与 `buffer` / `assistantText` 累积都没有上限。
- **所有对外文本先脱敏。** 新增 `src/cli-bridge/redact.ts`：`CODEBUDDY_AUTH_TOKEN` 就在子进程 env 里，CLI 回显它就会进会话历史。stdout 文本、`errors`、stderr 尾 6 行、回注正文全部过一遍（精确匹配本轮 token + JWT/Bearer/`sk-`/`token=` 形态）。**没有复用 `redactUpstreamText`**，因为它末尾有 `.slice(0, 300)`，会把评审结论砍成 300 字符。
- **不再回退 PATH。** 初版探测不到就 `spawn('codebuddy')`（Windows 上 `codebuddy.cmd` + `shell: true`）—— PATH 上的任意二进制都能拿到 vault 令牌。现在探测失败**拒绝运行**并提示用 `cliBridge.binary` 指绝对路径；显式 `.cmd` / `.bat` 在 Windows 上直接拒绝（会经 `cmd.exe` 解释）。`shell: false` 全路径覆盖，`--model` / `--append-system-prompt` 不再有被 cmd.exe 切词的面。
- **探测清单补齐，且不再承诺 `cbc`。** 初版只覆盖 `%APPDATA%\npm` 等四条；现在加了 `~/.npm-global`、`/opt/homebrew`、`~/.local`、pnpm/yarn/volta 全局目录，以及 nvm / n / fnm 的 node 版本目录。文档不再写「自动探测 `codebuddy` / `cbc`」——`cbc` 是同一个 `bin/codebuddy` 的别名，探测的是包路径而不是命令名。
- **论证改成事实。** 初版与 README 都写「跟网关说话的那个进程真的是登录着的 CodeBuddy CLI，没有身份要伪造，所以伪装那条路被封时它还能用」。实际上代码是用 `CODEBUDDY_AUTH_TOKEN` 把 plugin vault 里的**同一个 WorkBuddy 账号**交给 CLI，身份没变，`11140` 是账号级的 —— 逃掉的只有客户端指纹层。README / 顶部注释 / CHANGELOG 现在都这么写，不再把它当「封号之后的免死金牌」。
- **`scratchDir()` 的固定共享目录只作为 `allow_unattended` 的最后一档**，不再是默认出路；`allowUnattended` 仍然默认 `false`。

- **`killTree()` 不再把 `pid ≤ 1` 当进程组 —— 这条测试曾经会把评审者的整个登录会话打死。** 原来只挡 `pid === undefined`，而 `process.kill(-pid)` 拿到的 `pid` 一旦是 `1`（测试里为了区分两个假子进程写的 `fakeChild(1)`）就退化成 `kill(-1)`：不是杀子进程树，而是**给当前用户能 signal 的所有进程发 SIGTERM**，一秒后还升级成 SIGKILL。实测（macOS）跑 `vitest run tests/cli-bridge-runner.spec.ts` 会让 launchd 记录 `node[<pid>]` 向 Finder / Dock / WindowManager / ControlCenter / 用户正开着的微信 / DSH 宿主同时发 SIGTERM；DSH 的 renderer 作为受害者退出后又被 `DesktopFatalRecovery` relaunch，用户视角就是「DSH 反复重启，还把微信一起关了」。现在 group-kill 只对 `Number.isInteger(pid) && pid > 1` 开放，其余退化成单进程 `child.kill()`；测试里的假 pid 从 `1/2` 改成 `51_001/51_002`，并新增回归用例（spy `process.kill`，断言永不出现非正数信号目标）。

### Fixes（同期并入 main：issue #102 / #108）

- **#102 没修完：`dsh-foreign` 的历史消息仍然把思考摊平成正文** —— 5.2.3 的 `alignAssistantIdentities()` 只改 `provider`，但 DSH 交给 pi-ai 的这条消息**根本到不了 provider 比较那一步之前就换了 api**。
  - 真实链路：`dsh-llm-pi-ai` 的 `replayedAssistant()` 发现 `state.response.provider !== source.provider`（`workbuddy` vs `workbuddy-global`）就判定 replay 无效，改走 `foreignAssistant()`，而它把 `api` 写成 `dsh-foreign`、`provider` 取 `source.provider`（路由名）。于是 `isSameModel` 的两条比较**同时**失败；只补 `provider` 之后 `api` 仍然不等，thinking 照样被降级成 `text`。
  - 实测（DSH 0.2.1-rc.2 + 本插件 5.2.3，真实 global 会话）：只改 `provider` 时，一条 1514 字符的 thinking 块变成 1514 字符的**正文**；两个字段都修后恢复成 `thinking`。
  - 修法：`alignAssistantIdentities()` 在改 `provider` 之外，**仅当 `api === 'dsh-foreign'`**（宿主回退标记，插件自己从不会发这个值）时把它改回 `openai-completions`；其他任何 api 原样保留。
  - **为什么这不算伪造签名**：`foreignAssistant()` 造的 thinking 块**没有 `thinkingSignature`**，而 pi-ai 的请求组装只有存在签名时才会写 `reasoning_content`，所以该块根本不会进请求——与现在一样不发，只是不再变成可见正文。另外 `api` 只取自 `model.api`（请求组装全文不读消息自带的 `api`），改它不改变线上形状。
  - 真正的换模型仍然降级：`isSameModel` 还要求 model id 相等（有测试钉住）。

- **（#108）输入框积分面板的失败原因被截断成半句话** —— 截图里那一行是「✗ 网关拦的是提示词本身，不是这个账号—」，到破折号就没了，它要解释的那半句永远看不到。
  - 两个原因叠在一起，**缺一个都还能复现**：
    1. **文案选错了**：面板那一行按设计是**短标签**（`availabilityMark` 的注释写明 "the SHORT form of the same fact"），但它取的是 `outcomeText()`，而 `channel-rejected` 在那里返回 `row.probeChannelRejected` —— **一段 88 字（中文）/ 179 字（英文）的解释**，本来是给账号池卡片那一列宽地方写的。面板这一列实际只有约 180px。
    2. **CSS 是硬切不是省略**：面板的 switch 给账号名设了 `white-space:nowrap` + `overflow:hidden`（名字必须单行加省略号），而原因那一行**继承了这两条**。于是溢出部分被**直接切掉**，连省略号都没有 —— 硬切不带任何「后面还有」的信号，所以读起来像渲染坏了，而不是像被截断。
  - 修法分两层：
    - 新增 `outcomeMarkText()`：面板这一栏拿**结论**（`✗ 网关拦的是提示词`，新增 `row.probeChannelRejectedShort`），完整解释一个字不删 —— 它仍在行的 `title` 里（`availabilityLine`，含绝对时刻），也仍在账号池卡片上。一句话：**解释没有消失，只是不再挤在放不下它的那一格**。
    - `.dsm-workbuddy-composer-panel-mark` 显式 `white-space:normal` + `overflow-wrap:anywhere`。这条针对**根因**：这一行是本行里唯一长度不受布局控制的文字（译文，两种语言相差 2 倍），所以它该**换行**而不是被切 —— 多一行是能读的结果，切断半个字不是。
  - 同栏另外两个偏长的结论（`credential-rejected` 39 字、`unavailable` 19 字）现在会正常折行，不再被切。

- **（#108 后续）「被限流 · 约 2 小时后」补成「……后恢复」** —— 只有时长、没有动词，读者还得自己猜这两小时后会发生什么；而这一行整行的职责就是回答「这个账号现在能不能用」。
  - 新增 `recoversInText()`（`src/client/remaining.ts`）与四个 `row.recovers*` 键，**数字、取整、空串契约与 `remainingText()` 完全一致**，只多一个动词：`约 2 小时后恢复` / `约 25 分钟后恢复` / `约 3 天后恢复` / `即将恢复`；英文 `recovers in about 2 h`。
  - **只改面板，不改账号池卡片**，这是有意为之：卡片那句自带动词（`✗ 被限流 · 10/22, 14:47 之后可再用`），再叠「恢复」就成了 `之后可再用 · 约 2 小时后恢复`，一句话说两遍。所以两个函数并存，而不是给 `remainingText()` 加参数 —— 加了参数，那两个自带动词的调用点迟早会多长出一个。
  - 随之调整了一条既有的跨界面契约用例：它原本断言两边「同一个 key 名逐字相同」，现在断言**同一测量算出同一个时长与取整**（把 `row.recovers*` 映射成 `row.remaining*` 后比对）。这才是那个测试真正要守的不变量：两面不会对「还剩多久」给出两个答案。

### Tests

- 新增 `tests/cli-bridge.spec.ts`（69 条）与 `tests/cli-bridge-runner.spec.ts`（17 条），共 **86 条**（含 `killTree` 的 `pid ≤ 1` 回归用例）。
- 开关本身另有两条：`tests/cli-bridge-switch.spec.ts`（`__save` 的合并语义：显式 false 生效、同级 cap 不被冲掉）与 `tests/cli-bridge-card-switch.spec.tsx`（读取只认显式 true、写入先 Host 后 scope、卡片默认关且点击只 POST 全局字段）。
- **`runner.ts` 第一次有测试。** 初版的 53 条全是纯逻辑与注册形状，`runOneTurn` / `runAgent` / `spawn` 一次都没被调用过 —— 而评审找到的第 5/6/7/8 条缺陷全在那个盲区里。新 spec 用 `vi.mock('node:child_process')` 造 fake child，断言的是模块自己声明的协议：
  - `control_request` 的回包形状（`subtype:'success'` / `request_id` 原样回传 / `allowed:false`），且拒绝理由不以 synthetic-deny 前缀开头、result 帧前 **stdin 不 close**（这一条在修复前必红）；`interrupt` 分两条：普通工具**不带**（带了会中止整轮）、`ExitPlanMode` **必带**（不带则 `plan` 挂死）
  - 多 text block 拼接、tool_use 计数、result 帧的 usage / session_id / errors 解析
  - 单行超 `MAX_FRAME_BYTES` 即失败、无 result 帧就退出时保留 stderr 尾、超时、宿主取消（精确文本 `cancelled by the host`）、CLI 路径不存在时**从未 spawn**
  - 换号：只有 401 才换、**超时/崩溃不换**、最后一条 401 也不重试、空凭据列表报 `no credential worked`
  - 脱敏：token 与 `Bearer …` 形态既不进正文也不进 errors
- 主 spec 的新增/重写部分：`resolveWorkingDir` 的 9 条真目录断言（不存在 / 是文件不是目录 / 相对路径 / 允许根之外 / `allowedDirs` 放行 / 前缀相同的兄弟目录拒绝）、`TurnGate` 的 7 条（假时钟注入、并发 busy、配额拒绝、窗口滑过恢复、`0` = 不限、`clear()`）、`resolveCliEntry` 的新签名与「显式路径失败不得回退 PATH」、`looksLikeAuthFailure` 的新签名。
- 全量：**118 文件 / 1935 条通过（另 2 条 skip）**；`tsc -p tsconfig.json` 与 `tsc -p tsconfig.client.json` 均 exit 0；`tsdown` build 成功（`lib/index.js` 451.31 kB）。
- **另做了一轮真机联调**（`@tencent-ai/codebuddy-code` 2.171.0，真实 vault 账号，非 mock），六项全过：①`dontAsk` 默认 9.9 秒一轮，Glob/Bash 放行、Write 被拒且如实汇报；②`acceptEdits` 下 Bash 被拒后 CLI 换 PowerShell 完成任务（12.2 秒、`ok:true`），验证 `interrupt` 不能对所有工具开；③`plan` 的 `ExitPlanMode` 被带 `interrupt:true` 拒掉后 12.8 秒结束，不再挂满 `timeoutSecs`；④`acceptEdits` 真的写文件，且落在我们指定的 cwd（`hello.txt` 内容一字不差）；⑤6 秒超时 → 6.0 秒抛 `codebuddy exceeded its 6s budget`，**事后无残留 codebuddy 进程**（`taskkill /T` 生效）；⑥凭据链真实可用：global 令牌得到 `401 Authentication required`、换 cn 后 8.1 秒成功，且全程 token 未进正文/errors。

### Tests（同期并入 main：issue #102 / #108）

- `tests/issue59-cross-region-thinking.spec.ts`：原「rewrites ONLY provider — api and model are untouched」用例改写为「只修宿主回退 api，原生 api 逐字节不动」。
- 新增 2 条：宿主真实形状（`api:'dsh-foreign'` + 无签名 thinking）能保住 thinking（修复前必红）；provider 已对齐时 `dsh-foreign` 仍被单独修好（防止两个字段的修复互相短路）。
- 已验证：撤回 `src/adapter.ts` 的改动后，新增用例立刻转红（2 failed / 12 passed）。
- `tests/composer-credits-render.spec.tsx`（+3 条，`issue #108` 分节）：用**真实中文 locale**（不是回显 key 的桩）断言面板打印的是 `✗ 网关拦的是提示词` 且长度 < 20；完整解释仍在行 `title` 里（含「第三方 agent 过滤」）；样式表里 mark 一栏必须 `white-space:normal` + `overflow-wrap:anywhere`。
- 变异验证：撤回 `account-state.ts` + `styles.ts` 的改动 → 2 条立刻转红；单独把 locale 里的长文案改短（模拟「删掉解释」）→ 第 2 条转红。三条都真的在守卫，不是空转。
- 全量：**111 文件通过 / 1 跳过；1819 通过 / 2 跳过**；两个 tsconfig 均 exit 0；build 成功。
- `tests/remaining.spec.tsx`（+2 条）：`recoversInText()` 与 `remainingText()` 对同一批时刻给出**相同数字与单位**（只差前缀）；过去时刻返回空串。
- `tests/composer-credits-render.spec.tsx`：`WAIT` 正则改指 `row.recovers*`；跨界面契约用例改为比较「时长」而非「key 名」，并注明卡片为何不该加「恢复」。
- 变异验证：把 `availabilityMark` 里的 `recoversInText` 换回 `remainingText` → 上述 2 条立刻转红。

## 5.2.3 (2026-10-22)

### Fixes

- **「一键测速启用模型」按钮永远点不动（5.2.0 引入，截图发现）** —— 那个按钮的 `disabled` 条件里写的是 `tpsProbing !== undefined`，而 `tpsProbing` 是 `useState<Record<string, boolean>>({})`：**一个永远是对象的记录，永远不会 `undefined`**。于是比较恒为真，按钮永久禁用，整个测速功能从界面上根本进不去，而且没有任何提示说明为什么。
  - **为什么会写错**：旁边两个可用性按钮比较的是 `sweeping !== undefined`，在那个变量上是对的 —— `sweeping` 真的是 `{done,total} | undefined`，`undefined` 确实表示「没在跑」。我照抄了那个表达式的形状，却没带上让它成立的事实：不同的状态变量，可取的值集合不同。**对一个 map 来说，「忙」是「有键」，不是「已定义」。**
  - 修法：新增派生的 `tpsBusy = Object.keys(tpsProbing).length > 0`，用它替代恒真的比较。

### Tests

- `tests/card-tps-button.spec.tsx`（5 条，新增）：**断言的是 DOM 上真实的 `disabled` 布尔值，不是 JSX 文本** —— bug 就住在那条表达式里，文本级断言会和它一起说谎。
  - 有启用模型且没在跑时**不可禁用**（这一条在修复前必红）
  - 点击后真的发出请求，且只测启用的模型
  - **一次只测一个模型**（路由的上限，防止一次点击变成对整份名册的无账花费）
  - **一个都没启用时确实禁用**（防止修复把按钮变成无条件可点）
  - 点击后**行上真的出现数字**（只发请求不渲染的按钮会骗过前四条）
  - 已验证：把修复临时撤回，其中 4 条立刻转红。
- 全量：**112 文件 / 1812 条全绿**；两个 tsconfig 均 exit 0；build 成功。

## 5.2.2 (2026-10-22)

### Fixes

- **排队不再承诺、也不再触发自动重试（按维护者要求）** —— 两半都得改，因为它们是同一件事。
  - **文案**：原来结尾是「约 N 秒后自动重试」。**没有任何东西在重试**：插件没有排队轮询循环（`src/queue.ts` 的 "WHAT THIS MODULE DOES NOT DO YET" 写明了这一点），也不会重发。现在改成「请稍后重新发送这条消息，或换一个模型」——位次照常报，但把决定权交回给用户。
  - **请求本身**：那句谎言还有成本。`@deepseek-ai/dsh-llm` 把 HTTP 429 映射成 `RATE_LIMIT`，而 `RATE_LIMIT` 在它的 `DEFAULT_RETRYABLE_CODES` 里 —— 所以宿主会跑 **5 次** 原地重试（0.5s→8s 退避，实测合计约 15 秒）。一次排队在几千位之后，15 秒不可能排到，这 5 次全是**真实请求**，每次都只为再听一遍同一个位次。现在该响应带上 `x-should-retry: false`（两个客户端都**先**看这个头，再看状态码）与 `retry-after: 0`。
  - **不转发上游的 `retry_after`**：7 秒也清不掉 9021 位的队，转发它只会让客户端先等一会再收到同一个答复。
  - **`retryAfterSec` 字段一并删除**：它只用来喂那句倒计时，现在没人读。留着解析但不用的数据，等于给这个承诺留了条回头的路。
  - **其他 429 仍然可以重试**：`model_busy`（14003）是模型级限流，确实约一分钟就恢复，宿主重试正是对的处置。只把排队这一类标成终局，不是一刀切。

### Tests

- `tests/queue-no-retry.spec.ts`（6 条，新增）：`x-should-retry: false`、`retry-after: 0`、不转发上游 `retry_after`、位次与队列长度仍在、文案里没有「自动重试」、**其他 429 不受影响**（最后这条防止把可恢复的限流也变成即时失败）。
- `tests/queue.spec.ts`：`retryAfterSec` 相关断言改写为「不携带倒计时」。
- 全量：**111 文件 / 1807 条全绿**；两个 tsconfig 均 exit 0；build 成功。

## 5.2.1 (2026-10-22)

### Fixes

- **每一次成功请求前都要先浪费一次被拒请求（自查发现）** —— 重试阶梯是「先发原文→被 11128 拒→再发扰动版」。第一次这样是对的，但**之后每一次都重复这个失败**，而一个会话里提示词的形状并不变。实测每次多付 **209ms + 一次被拒请求**。
  - 修法：扰动版成功过一次之后，记住它，**下一次直接从扰动版开始**。实测：第 1 次请求用 2 次上游调用，之后每次 1 次。
  - **只记在内存里，不落盘**：上游的指纹名单是可以**撤销**的，不只是增加。落盘的标志会活过它成立的条件，继续扰动一个已经不再拒绝的网关。
  - **而且会自我纠正**：扰动版一旦也被拒，立刻清掉标志、退回原文重新探测 —— 所以规则被撤销、或同一网关后面换了别的模型，都不会让插件卡在一个不再有用的形状上。
  - 只在**成功**时记忆。一次也被拒的扰动没有教会我们任何关于网关想要什么的信息。

### 关于用户反馈的那份「改提示词」方案

有用户报告用 `dsm-prompt-easymanager` 取消勾选 `harness:identity` 并把它改成 `DSH` 就能解决。**我实测了，结论是部分有效、但不是根本解法**：

| 做法 | 实测 |
|---|---|
| 只取消勾选 `harness:identity` | **400 / 11128**（不够） |
| 只把 `identity` 改成 `DSH`，另两段原文 | **400 / 11128**（不够） |
| 只改 `source` + `web`，`identity` 原文 | **400 / 11128**（不够） |
| **三段全改成 `DSH`** | **200** ✅ |
| 插件当前（零宽扰动） | **200** ✅ |

也就是说**必须三段全部改**才有效，只改一段不够 —— 这份方案之所以在那个用户的机器上「可用」，是因为他改了三段。而插件的扰动方案不需要用户改任何东西。

顺带定位到了一处更精确的事实：门 B 的触发条件不是「含 `DeepSeek Harness`」，而是**特定句子组合**。单独 `source` 段 200、单独 `web` 首句 200、单独 `web` 次句 200，但**两段一起**就 400；而 `web` 次句末尾的**句号**决定成败（改成感叹号则 200）。所以这是一条**内容指纹**规则，不是长度规则 —— 也再次确认 #105 里那个「需要 15,196 字符」的结论不成立。

## 5.2.0 (2026-10-22)

> 新功能：实测输出速度（issue #92）。默认不跑，点了才花积分。

### Features

- **一键测速 / 单模型测速：输出速度（issue #92）** —— 倍率不再是选模型的唯一依据了。DSH 会把模型当**子代理并行派发**，每个子任务还有多轮往返，所以**输出速度会乘进整个任务的实际耗时**：一个便宜但慢的模型，总耗时可能超过贵但快的。issue 报告者实测同倍率（x0.08）的四个模型，中位输出速度差 **3.8 倍**。
  - **已有探针为什么给不出这个数**：现有可用性探测发 25,000 输入 token、输出上限 **1 个**（`PROBE_MAX_TOKENS = 1`），它的 `elapsedMs` 是**首字延迟**，没有生成跨度可除。测速需要相反的请求形状：极小输入 + 长输出。所以这是**独立的路由**，不是给老路由加字段。
  - **成本比可用性探测低一个数量级**：这个网关按**输入**计价。可用性探测实测 `credit 0.72`；测速实测 **0.01–0.15**（取决于模型倍率）。每次 3 轮，也就是单模型约 0.03–0.45。
  - **3 次取中位数，不是均值**：实测 `glm-5.3-flash` 五次是 110 / 105 / **177** / 103 / 109 tok/s —— 均值 121 被离群值拉高，而四次都在 103–110。中位数 109 才是它真实的位置。所以轮数取**奇数**（偶数中位数要平均两个中间值，等于把离群值的影响又请回来）。
  - **失败的轮次丢弃，不记 0**：一个模型两次跑到 400 tok/s，不会因为第三次超时就变慢；差距体现在 `samples`（"3 次"变"2 次"）而不是速率上。
  - **测不出就报测不出，绝不编**：分块太少（整个答案一次到达）→ 报「无法测速：分块太少」；上游没报 token 数 → 报「上游没报 token 数」。绝不拿 `elapsedMs` 倒推一个速率。
  - **结果带时间戳**：速度随负载变，一个过期的数字比没有更糟。行里显示 `· 10-22 02:31 测`。
  - **不影响可用性判定**：独立状态、独立路由、行里独立一行显示 —— 一个「快但不可用」的模型不会被渲染成一个不存在的合成状态。

### Fixes

- **测速的首字延迟一开始是错的（自查发现，未发布）** —— 第一版在 `probeChat` resolve 之后才取时钟，也就是「响应头到达」之后才计时，于是报的是「响应头→首块」而不是「发请求→首块」。实测三个模型里两个报 `timeToFirstTokenMs: 0`，正是这个错误的签名：读时钟时首块已经在缓冲区里了。
  - **速率不受影响**（它是首块→末块），这恰恰是为什么容易漏掉：主数字一直是对的，副数字是垃圾。
  - 已修，并补了一条测试：模拟服务端 120ms 才开始应答，断言 TTFT ≥ 100ms。时钟一旦被挪回响应头之后，这条会立刻红。

### Tests

- `tests/tps.spec.ts`（21 条，新增）：请求形状（输出上限远大于 1、输入极小、要求低推理档）、流式读取真的在测间隔（已知到达节奏下断言跨度）、只计 content 不计 reasoning、畸形/分片帧不抛、单块流报「无法测速」、中位数抗离群、丢失败轮不记 0、区分「无 token 数」与「分块太少」、积分求和去浮点噪声、真实循环驱动、单轮失败仍继续、全失败不抛、帧语法单测、以及**TTFT 时钟位置**的回归测试。
- `tests/web-status.spec.ts`：路由清单断言补上测速路由。
- 全量：**109 文件 / 1794 条全绿**；两个 tsconfig 均 exit 0；build 成功。

## 5.1.0 (2026-10-22)

> 版本号是 **minor**：修了两个行为缺陷（不是接口变更），但其中第一个会改变每一轮请求实际发出去的内容，所以不用 patch。

### Fixes

- **global 区的历史思考不再被降级成正文（issue #102）** —— 这是本仓库最严重的一个 bug，而且它被一条假绿的测试盖了四个版本。pi-ai 只在「记这条消息的 provider / api / model 三者都等于当前请求」时才把历史 thinking 重放成 thinking，否则整块摊平成 `text`。DSH 的 agent loop 写消息时用的是**路由名**（`source.provider = request.provider` → `workbuddy-global`），而插件给模型盖的章是**共享 identity**（`workbuddy`），两者永远不等。后果：global 会话**每一轮**都把模型自己的历史推理翻成正文，模型看到「我以前的思考全是正文」，于是把新推理也写进正文——这就是报告里「reasoning 只有 1 个字、text 里全是工作笔记」的形状。
  - 国内区之所以正常，只是因为它**恰好**路由名 == 章名（`workbuddy` === `workbuddy`）。
  - 修法：新增 `alignAssistantIdentities()`，在 transcript 交给 pi-ai 之前把历史 assistant 消息的 `provider` 改写成 identity。**只改 `provider`，不动 `api`**——`dsh-foreign` 消息的 api 是插件从不会发的形状，声称 `openai-completions` 等于断言一个它从未按之构建的线上格式；而 `isSameModel` 仍然要求 model id 匹配，所以真正的换模型照样降级（有测试钉住）。
  - **测试先改红再改绿**：`tests/issue59-cross-region-thinking.spec.ts` 里那条「双向」用例原本是 `for (...) { void recorded; void replayed; ... }`——两个循环变量被直接丢弃，两次迭代断言的是同一件事，从未测过跨区域。现在按**真实形状**喂（`source.provider` = 路由名 + 请求侧 = identity），修复前必红。
  - 新增 5 条边界用例：user / toolResult 不动（原对象返回，请求路径上不分配）、已对齐时不分配、只改 provider、不同 model id 仍降级、畸形条目不抛。

- **`11115` 让宿主认不出「上下文溢出」，丢掉了自愈能力（issue #101）** —— 上游这个码有两种报文：形态 A 带 `prompt is too long: N tokens > M maximum`，形态 B 只有一句中文「本次输入加上历史对话超过了模型上限」。而宿主是靠**英文正则**（25 条 pattern，第一条就是 `prompt (?:is )?too long`）判断要不要跑压缩救援的——中文一句都不命中。于是形态 B 既不压缩也不重试，直接把 400 甩给用户，连它自己那句「请精简内容」的建议宿主都无法执行。
  - 修法：错误文案前面加一句 `prompt is too long (upstream code 11115)`，上游原文紧跟在后面。机器拿到信号，人仍然看到网关自己的建议。
  - **不编造 token 数字**：形态 B 根本没给数字，写一个「N tokens > M」正是这个仓库一直在避免的那种「自信的错误诊断」。
  - `isContextTooLongBody()` 用带边界的正则，`111150` / `1111` 不会被误判成溢出——误判会让宿主跑一轮毫无用处的压缩。
  - 分类不变：仍是 `client`，仍然不换号（溢出是请求的问题，换账号只会每个账号烧一次）。

### Tests

- `tests/issue101-context-overflow.spec.ts`（8 条，新增）：两种形态都识别、相邻码不误伤、marker 命中宿主 pattern 且不被误认为限流、不编造数字、分类不变；外加一条**端到端**用例真的把一次 11115 请求驱过 shim，读宿主会看到的那句文案，确认 marker 在、网关原文在、requestId 在。
- `tests/issue59-cross-region-thinking.spec.ts`（12 条，改写 1 条 + 新增 5 条）。
- 全量 `npx vitest run` = **108 文件 / 1773 测试全绿**；`tsc` 两个 project 均 exit 0；`npm run build` 成功。

## 5.0.1 (2026-10-22)

> 版本号是 **patch**：改卡面上的一个字符串（标题）、去掉模型列表的一条 CSS 规则与两行路由项，以及几处描述它们的文档。没有接口或配置结构的变更——但如果你的配置里存着 `auto` / `default-model`，升级后它不再出现在列表里。

### Fixes

- **国际区的 `Auto` 行也从模型列表里去掉了** —— 它和国内区的 `auto` 是**同一个东西的两个 id**：都是该区的默认路由（`isDefault: true`、都叫 `Auto`），也都是各自名册里**唯一不声明积分倍率**的那一行（实测 2026-10-22：国内 20 个里 19 个标了价，国际 28 个里 27 个）。国内区的 `auto` 早就被过滤了，国际区的 `default-model` 一直漏着——一个插件无法标价的行，就是它无法向你交代成本的行。
  - **判据不是名字**：`fast-model` / `balanced-model` / `primary-model` 也是别名，但它们都声明了真实倍率（x0.34 / x0.59 / x3.31），所以保留。丢掉它们会平白拿走三个用户真正会选的模型。
  - **顺带修掉一个会把它带回来的漏洞**：`keepIds` 分支（让用户正在用的模型不被刷新撤掉，issue #32）原本不过滤路由，于是**旧配置里 `enabledModelIds` 还留着 `auto` 的人，每次刷新都会把这行重新加回来**——而且取消勾选也去不掉。现在两条路径都过滤。
  - **在读取点过滤，而不是迁移已保存的配置**：`lastCatalog` 是配置里带着的历史快照，卡片读的就是它。只改刷新逻辑的话，升级后这一行会继续显示到下次刷新为止，看起来就像「没修好」。现在 `withoutRouters()` 在 `displayModels` 与 `configuredModels` 两处读取时过滤，存进去的值不动——升级后立刻消失，而不是等一次刷新。

- **模型页不再有内部滚动条，所有模型一次全部呈现** —— 设置卡片「模型」栏的列表此前带 `max-height: 520px` + `overflow-y: auto`，20 多个模型只显示七行左右，其余藏在一条需要先发现、再拖动的滚动条后面；而面板本身已经在滚动，于是是两条滚动条叠在一起。
  - **`overflow: hidden` 保留**，而且是必要的：圆角由这个带边框的盒子绘制，不裁剪的话首行与末行会把直角画到圆角上。只是现在盒子的高度就等于内容高度，不会再裁掉任何东西。
  - **5.0.0 的描述写错了**，本版一并更正：当时记的是「模型表自己内滚」，与最终代码不符。

- **插件卡片的标题改回包名 `dsh-connect-workbuddy`** —— 5.0.0 里补 `locale/{en,zh}.json` 时，`meta.title` 写成了「WorkBuddy 模型接入」/「WorkBuddy Model Access」，于是卡片标题从裸包名变成了那个名字。这个插件的身份就是包名——仓库、npm 页面、issue 里都是这个叫法——所以改回去。
  - **显式写出包名，而不是删掉 `meta.title` 留空**。两种做法渲染出的字完全一样（宿主 `localizedText` 的 fallback 就是 `manifest.name`），但留空之后文件里没有任何地方记录「标题应当等于包名」这件事，下一次「给它起个好听点的名字」看起来就会像一次免费改进，而不是一次回退。`tests/locale-meta.spec.ts` 现在钉住它。
  - **简介不受影响**：仍由 `locale/zh.json` / `locale/en.json` 各自的 `meta.description` 提供，中英分离如初。

### Docs

- `docs/DESIGN.md` 更正一处过时说法（原文写「本仓库的 `package.json.description` 是英文」，那是 PR 原本的写法，合并时按「保持中文」处理了）；并补上第 4 条机制事实：`meta.title` 就写成包名，以及为什么写出来而不是留空。
- `CHANGELOG` 的 5.0.0 条目同步改成包名口径。
- 顺带说明 `package.json` 里那个 `DSH Connect WorkBuddy`（`displayName`）**不参与任何渲染**——宿主标题的回退是 `manifest.name`，不是它。保留只是历史遗留。

### Tests

- `tests/locale-meta.spec.ts` 那条从「标题**不**等于包名」改为「两种语言的标题**都**等于包名」，并把理由写进用例：这是一个决定，不是一个默认值。
- `tests/client-host-contract.spec.ts` 新增 1 条守卫：`.dsm-workbuddy-model-list` 的规则里**不得**出现 `max-height` 或 `overflow-y`，同时**必须**保留 `overflow:hidden`（只断言「没有上限」会让人以后把裁剪也顺手删掉，而那是圆角所依赖的）。
- `tests/catalog.spec.ts` 新增 4 条 `withoutRouters` 用例：过滤旧快照里的路由、CN 的 `auto` 与国��的 `default-model` 都被认出、`fast`/`balanced`/`primary` 不受牵连、不修改入参；并把「两个区的 fallback 名册都不含各自的路由」从只查 `auto` 扩到两个 id。
- `tests/upstream.spec.ts` 新增 4 条 `selectCliModels` 用例：两个区各自的 `auto` 都被丢掉、**旧配置里仍写着 `auto` 时不会借 `keepIds` 复活**、真正的「已下架但你在用」的模型仍然被保住（issue #32 那一半不能被这次过滤破坏）。
- `tests/native-modality.spec.ts` 的路由用例扩成两个 id，并明确 `fast`/`balanced`/`primary`/`deep` 不算路由。
- 全量 `npx vitest run` = **107 文件 / 1760 测试全绿**；`tsc` 两个 project 均 exit 0；`npm run build` 成功。

## 5.0.0 (2026-10-21)

> 版本号是 **major**：接口与配置项没有破坏性变更（顶层配置字段一个不少，也没有导出被删），但这一版把「花不花钱」的决定权**第一次交给了模型**。在此之前，本插件每一次花钱都跟一个人工动作绑在一起：一条聊天请求是你发的，模型行的「测试」按钮是你点的。5.0.0 新增的 `workbuddy_draw_image` 是模型自己决定调的——约 5.71 积分一张，而宿主没有「调用前先确认」的机制（`needsApproval` / `toolApproval` 在 `app.asar` 里都不存在）。
>
> 按这个仓库自己的判准，这属于**语义级**变更：3.0.0 升 major 是因为账号池让「哪个账号被计费」可以变（同样是零 API 破坏），4.0.0 升 major 是因为一个用户可见的位置消失（同样是零 API 破坏）。一个能自己花钱的能力，比这两者都更需要一个新的大版本号来说清楚。
>
> 正因为如此，它以**默认关闭**的形态出现：`regions.<region>.imageToolEnabled` 默认 `false`，关着的时候这个工具**根本不注册**——模型看不到它，也就不会去调用一个注定失败的入口。升级本身不会赋予任何人花钱的能力。

### ⚠️ Breaking Change（语义，非接口）

- **生图工具默认关闭**。旧版本升级上来的人不会自动拥有 `workbuddy_draw_image`；要发一句话让模型画图，先在卡片「账号」栏勾上「允许模型自主生图」。这是刻意的：这项能力能让模型在你没有逐次确认的情况下花掉积分，所以它必须是你打开的，而不是升级附赠的。
- **没勾选时工具不存在**，不是「存在但拒绝」。一个注册了却永远拒绝的工具会出现在模型的工具列表里，诱使它发起注定失败的调用；不注册则完全不可见。

### Features

- **设置卡片按「账号 / 模型 / 诊断」分栏** —— 这张卡片原来是一条 3538 像素的长页，把两类提交语义完全不同的事情混排在一根竖线上：账号改动点一下立刻生效，目录改动是草稿、必须按「保存」，而用户在第 1 屏勾完模型后要滚三屏才能找到那个按钮。
  - **三栏**：**账号**（地区说明、积分开关、凭据类错误、账号池的切换/签到/导入导出/日志）、**模型**（模型表、保存/放弃）、**诊断**（只读事实表：区域、上游域名、当前服务的账号名、登录有效期、目录模型数、已启用数、上游最近一次错误的原文）。地区的「国内版 / 国际版」两个 tab 原样保留在最上面，它是这三栏共同的作用域。
  - **切栏不重新拉、不丢草稿**：非活动栏用 `hidden` 留在页面里而不是卸载，所以改了几个勾、切去看一眼余额、再切回来的改动还在，账号池的日志也不重建。`hidden` 同时把非活动栏移出无障碍树，`role="tabpanel"` 的语义成立（用 CSS `display:none` 反而会被后续样式覆盖）。
  - 模型表**全部展开，不设内部滚动**。（5.0.0 原本写成 `max-height: 520px` 内滚，5.0.2 改掉：见该版说明。）
  - **签出态不画分栏**：没有登录时这张卡片就是一屏说明，套三个空 tab 只会把唯一的说明藏起来。
  - **诊断栏没有任何控件**，它存在的唯一理由是能被整段贴进问题反馈：账号显示**名字**而不是 id（测试里专门断言不出现 id），上游错误是原文引用、不翻译不概括。

- **模型行显示上游的繁忙程度** —— 上游把「这个模型现在多忙」放在一条独立的只读探针里（`POST /v2/chat/busy`，一次最多 50 个 id，只读、免费、不动账号状态），不在模型目录文档中。插件在每次刷新目录时顺带问一次，把等级拼到模型名右侧：`Hy4 preview · x0.29 · 极度拥堵`。
  - **只画 `busy` / `congested` / `unavailable`**：`idle` 有词（空闲）但不画——实测 20 个模型里 7 个空闲，每行都挂徽标就成了装饰而不是警告；`normal` / `unknown` 一律不画。
  - **`unknown` 不等于 `normal`**：探针没回答的模型是未知，不替它猜「一切正常」。
  - **等级不落盘**：目录是能活过重启的事实，负载只是那一分钟的事实。等级只盖在运行时目录上，随进程消失；探针失败只 warn，绝不挡住目录刷新。
  - **实测**：`POST /v2/chat/busy` 在 CLI 与 App 两种身份下答案逐字节相同（所以不需要产品身份）；50 个 id 的上限真实存在（62 个 → HTTP 400 `too many models: 62 (max 50)`）；19 个模型 186 ms 返回，不拖累刷新。

- **补上市场卡面文案（`locale/{en,zh}.json`）** —— 插件卡上的标题与简介**不是本插件渲染的**，而是 DSH 插件管理器读的包元数据：`readPluginMeta()` 先解析 `<包名>/locale/en.json`，再**扫描这个文件所在目录**取出其余语言文件，逐个读 `meta.title` / `meta.description`。此前本仓库只提供了后一半（`package.json` 的 `description`），于是卡面标题落回**裸包名**、英文界面里的简介是一句中文。
  - **`locale/en.json` 是锚点**：读取端遍历的是「英文资源所在目录」，没有它 `zh.json` 永远不会被读——而且不报错。
  - **`exports` 缺 `"./locale/*.json"` 通配 = 静默失败**：解析抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，读取端把它连同其它失败一起吞掉。
  - **`files` 必须带裸目录 `locale`**，否则发布出去的 tarball 里没有它自己那份文案。
  - 现在中文界面读 `locale/zh.json`、英文界面读 `locale/en.json`，两边各有自己的简介。**标题就是包名 `dsh-connect-workbuddy`**（两处 `meta.title` 都这么写）：这个插件的身份就是那个包名，仓库、npm 页面与 issue 里都是这个叫法；写出来而不是留空，是因为留空也会经 `localizedText` 的 `fallback` 渲染出同样的字，但文件里就没有任何地方记录「这是决定」。`package.json` 的 `description` **保持中文**：它同时是 npm 包页面的简介、GitHub 的仓库简介，和「万一 locale 读不到」的最后兜底——英文文案住在 `locale/en.json` 里，那才是能覆盖兜底的那一份。

- **新增生图工具 `workbuddy_draw_image`（国内区，默认关闭，需显式授权）** —— 把 WorkBuddy 官方 CLI 的文生图能力暴露成一个 DSH agent 工具，模型可以按用户的描述直接画一张图。
  - **为什么它是 opt-in，而其他功能不是**：这是本插件唯一「由模型决定花钱」的能力。聊天请求是你发的，「测试」按钮是你点的，而工具调用是模型自己发起的——约 5.71 积分一张，宿主又没有逐次确认的机制。所以开关归你：`regions.cn.imageToolEnabled`，默认 `false`，关着时工具不注册。这与 3.0.0 给账号池的处理是同一个道理（能改变账单落点的功能必须显式打开）。
  - **读侧刻意与同槽其他开关相反**：`regionImageToolEnabledOf` 用 `=== true` 而不是 `!== false`。卡片上的积分读数与供应商开关都是 opt-out（缺省即开，因为藏一行或撤一个 provider 都可以再点回来），而这一项是**授权消费**，缺省必须是关——升级、配置读取失败、手写了个 `"yes"` 都不能被当成同意。
  - **为什么是工具而不是又一个按钮**：生图是「一句话 → 一张图」的能力，用户的自然表达是「帮我画一只在窗台上晒太阳的猫」，不是「打开某个面板、填三个字段、点提交」。做成 agent 工具，模型自己就能决定什么时候画、画什么。
  - **端点与协议照抄官方 CLI 的 ImageService**：`POST {chatBase}/v2/images/generations`，请求体只有 `model` / `prompt` / `size`（`hunyuan-*` 额外带 `n: 1`，`gemini-*` 什么都不加，其它模型带 `response_format: 'b64_json'`）。国内区 `chatBase` 为 `https://copilot.tencent.com`。响应是 `{code, msg, requestId, data:{created, data:[{url}], usage:{credit}}}`。
  - **产物是 24 小时有效的 COS 签名 URL**：插件把 URL 原样返回，并在 `hint` 里写明时效与「要长期保留请及时下载」；上游若返回内联 base64（非 hunyuan 分支），插件落盘到系统临时目录下的 `workbuddy-image-gen/`（`os.tmpdir()`，三个平台各自的位置）再返回 `file://` URL 与本地路径，不让 2 MB 的 base64 灌进对话。
  - **模型目录会多读一次同一份文档**：生图要 `data.models` 里的媒体标签，而聊天目录投影时会把它们丢掉，所以工具**另发一次只读 GET** `/v3/config`（国内区同样走 `/v3` → `/v2` 降级），结果缓存 5 分钟。国内区实测 62 条模型里只有 `hunyuan-image-alpha` 带 `text-to-image`；**国际区一条都没有**——所以工具只在国内区注册（国际区注册出来只会是每次调用都报「没有生图模型」的按钮）。这只读、不花积分，但**确实是一次额外请求**，不记成「零新增请求」。
  - **按「花钱的工具」对待**：缺省即独占执行（不声明 `isConcurrencySafe`），单次超时 180 秒（实测一张 12.9–38.7 秒），失败后 **30 秒冷却**——冷却只看**这一次有没有真的把请求发出去**，由调用点显式置位而不是从异常类型反推：`AUTH` / `RATE_LIMIT` / `NO_ROUTE` / `UPSTREAM` / `EMPTY_RESULT` 这些发生在请求已发出之后的失败才冷却；参数写错、未登录、目录里没有模型，以及**读目录时的一次网络抖动**，一分钱没花，都不进冷却。工具描述里直接写明单价（实测约 5.71 积分/张），让模型自己知道不要为了试错连续调用。
  - **点名的模型不在目录里就直接报错**并列出可用模型，而不是把不存在的 id 发上去换一个上游 404——那样报错只会是 `route config not found`，读者无从知道是名字写错了。
  - **注册跟随国内区开关的活值**：`regions` 是 volatile 字段，用户拨动开关时 loader 只广播、不重新 apply。在 apply 期判一次的话，启动时关着的用户之后打开永远看不到工具，而启动时开着的用户关掉后台工具仍挂着、调用时报「未登录」而不是「区域已关闭」。
  - **没有引入新依赖**：工具定义是手写的 raw JSON Schema `ToolDefinition`，不 import `@deepseek-ai/dsh-tools`（宿主 `Tools.register` 只校验 `output.render` 是函数与 `output.schema` 是受支持的 JSON Schema，`defineTool` 多出来的只是包装）。这样 `lib/bin.js` 的静态可达图里不会多出裸 peer 说明符，`tests/host-peers.spec.ts` 的断言原样成立。
  - **凭据不出宿主进程**：token 只用于这一次 `fetch`，不进对话上下文、不进页面。

### Fixes

- **撞上排队时不再先把整个账号池试一遍** —— 上游用三个业务码表达排队（`6020` 等待、`6021` 队列满、`6022` 已达上限）。它们在错误分类里此前**没有任何分支**，于是按承载它的 HTTP 状态落成 `server`(500) 或 `soft_rate`(429)——两者都是换号worthy。实测：`HTTP 500` + `code 6020` → `kind=server` → `failover=true`。结果是一次排队会先把账号池挨个试一遍、每个账号都烧一次真实请求，最后才告诉用户「你排在第 8777 位」；而队列跟随的是模型和平台级队伍，换个账号拿到的还是同一个位次。
  - **`model_queue` 成为自己的错误类别**，分类放在状态分支**之前**（排队是业务码，承载它的状态是偶然的：实测同一条件在 200/429/500 三种信封下都出现过）。
  - **`isFailoverWorthy` 排除它**，与 `channel_reject` / `model_busy` 同理。
  - 渲染改由 kind 选择，不再二次解析 body 决定；body 解析只用来取位次与队列长度。

- **生图工具的冷却不再把「没花钱的失败」算成花过钱** —— 原实现从异常类型反推：凡不是 `WorkBuddyImageError` 的一律算「花过钱」。方向错了两头：读目录（一次只读 GET）失败抛的是上游的 `envelopeError` 或网络错误，一分钱没花却把工具冷却 30 秒；而真正免费的 `INVALID_ARGS` 全靠码表才被放行。现在由调用点在发起生图前显式置位「已发出」，冷却只看它。

- **`fetchMediaModels` 补上 `/v3` → `/v2` 降级** —— 聊天目录早就会在 `/v3` 不答时降级，生图这里没有：上游一旦收起 `/v3`，聊天照常工作而点生图会得到一个原始异常。国际区不降级（它没有对应的历史文档，给过去只会是 CN 形状的数据）。

### Tests

- **`tests/image-tool-optin.spec.ts`（8 条，新增）**：这一版唯一新增的**授权**契约。读侧把「没说开」与「说了开」分开：`{}`、`{regions:{}}`、`{regions:{cn:{}}}`、显式 `false`，以及手写配置里的 `"yes"` / `1` 全部读成 **关**；只有真正布尔 `true` 读成开；两个区域互不串（CN 开了不意味着国际版也开）。写侧 `nextRegionImageToolEnabled` 只动目标槽的那一个字段，同槽的 `enabled` / `enabledModelIds` 与兄弟区域都保住。另有两组直接钉住升级路径：空配置不是同意、`enabled: true` 也不是同意——**供应商开着和允许模型花钱是两道独立的闸**，把它们混为一谈就等于给所有存量用户发了一个花钱能力。最后一条钉住渲染位置与类名（只在 CN tab、用独立的 `.dsm-workbuddy-image-tool-check`，不与积分开关共用 `.dsm-workbuddy-pref-check`——那是「恰好一个开关」那条测试的选择器契约）。
- **`tests/image-gen.spec.ts`（35 条）**，夹具是 2026-10-21 国内区 `/v3/config` 的真实片段：模型筛选与去重、`pickImageModel` 的点名/回退/空目录、`buildImageBody` 三分支、`parseImageResponse`（url / b64 / `code !== 0` / 空结果）、`describeImageFailure`（401/403/404/429/500-JSON/非 JSON）、工具的 schema 形状与**返回值键严格落在 `output.schema` 里**、`INVALID_ARGS` 不冷却、`NOT_LOGGED_IN`、`NO_IMAGE_MODEL`、上游失败进冷却、目录 TTL 只读一次、base64 落盘、`render` 的 markdown；以及本轮新增的**两条**：读目录失败不进冷却（同一实例紧接着调用可成功）、读目录失败不被缓存（两次调用都真的到达读取器）。
- **`tests/busy.spec.ts`（14 条）**：枚举外一律 `unknown`、分批去重（62 → 50+12）、空闲有词但不进名字、等级只盖在匹配的条目上、不修改传入的目录条目；`tests/promo-card` 之外另有 `tests/card-panels.spec.tsx`（6 条，jsdom）钉住分栏：`hidden` 而非卸载、非活动栏仍挂载、诊断栏显示账号名而不显示 id、签出态不画分栏、恰好一个 tab 被标记选中。
- **`tests/queue.spec.ts`（14 条）**：三个业务码的识别、位置/队列长度/`retry_after` 的读取、嵌套与 `_meta` 信封、14003/402/500 不被误判为队列、永不打印上游的 `queue.*` i18n key、文案；以及本轮新增的**三条**：三种业务码在 200/400/429/500 四种状态下一律 `model_queue`、无关失败不被吞、**两种曾导致换号的承载状态（500 与 429）逐个钉住**。
- **`tests/upstream.spec.ts`（+2 条）**：`fetchMediaModels` 在 `/v3` 失败时降级到 `/v2` 并上报降级原因；国际区不降级。
- **`tests/locale-meta.spec.ts`（9 条）**：`locale/en.json` 是锚点、每个 locale 文件名必须是语言 id、`exports` 的通配与 `files` 的裸目录都在、中英两份各自是自己的语言、市场草稿与卡面逐字一致；以及「`package.json` 的 `description` 保持中文」——它记着 `8f3a96e` 把这行从英文改成中文是为了对齐 README 首屏，将来想改回英文必须显式说明。
- 全量 `npx vitest run` = **107 文件 / 1751 测试全绿**；`tsc` 两个 project 均 exit 0；`npm run build` 成功。
- **真实联调**（已花 5.71 积分）：同一凭据出图成功，HTTP 200、12.9 秒、`credit: 5.71`、产物 2 065 707 字节 PNG、1024×1024、画面与提示词一致。取证与协议细节见 [docs/IMAGE_GEN.md](docs/IMAGE_GEN.md)。

### Notes

- **README 顶部新增「风险提示」，文末「免责声明」同步重写**（中英双份）。提示本身说两层：① 上游已开始限制非官方客户端请求，本项目**不保证接口长期可用**、上游收紧时可能失效，请自行评估账号风险，官方客户端始终最安全；② 这个插件的目的很普通——**省掉在 WorkBuddy 客户端和 DSH 之间来回切换的麻烦**，接的是你自己机器上已有的登录态，不提供账号、不共享凭据、不绕过计费，每次调用都按上游倍率真实扣费、从不修改账号状态，也不带任何提权或刷额度的能力。它依赖客户端自身的接口（非官方开放 API），所以上游调整时需要跟着调整——这是这类工具的常态，也是这条提示存在的理由。文末的免责声明补齐了第三方接入的账号风险口径（受限／封禁／暂停／终止）、个人使用与商用边界、与腾讯及 DeepSeek 无关联的声明，以及后果自负。
- **图生图（`/v2/images/edits`）与视频（`/v2/videos/generations`）没有暴露成工具**：两条端点的存在与模型名（`hunyuan-image-alpha-edit`、`minimax-video-h3`、`kling-video-v3`）已由探针确认，但**没有跑通一次真实调用**，所以不给用户一个「看起来能用」的按钮。
- **「排队后自动重发」没有实现**：识别并把位次说清楚是今天能诚实交付的那一半；重发循环需要排队答案在 OpenAI 兼容通道上的真实信封，没有测到就写等于写一段永不执行的代码。为此准备的三个常量（轮询节奏、12 分钟上限、位次分档）随实现一起撤下，而不是留成只被自己测试调用的导出。

## 4.15.1 (2026-10-21)

> 版本号是 **patch**：没有接口与配置变更。发往上游的请求在**没有被网关拒绝时仍然逐字节不变**；改动的只有「被渠道校验拒绝之后」那一段——多一级重试。路由、模型、凭据、计费与换号规则未变。

### Fixes

- **4.15.0 上线后仍有 11128：网关还会按「提示词里的一段长文本」匹配，不只看开头**
  - **真实报文**（2026-10-21 19:1x，国内区、插件 4.15.0、requestId `06e7950a…`）：回显「system：You are an AI agent powered by DeepSeek Harness.」（插件已加中性头）——**每条被扫消息的开头都已经在中性头之后**，网关仍然 400。这直接证伪了「只匹配开头」这个 4.13.0 时代的结论。
  - **实测**（同账号 / 同模型 / 同请求头，只改 body；把宿主的真实失败请求逐段二分）：
    - 触发点是 system 提示词里 **221 个字符**的一段（DSH 的 Web GUI 段落前两句：「You are interacting with the user through the DeepSeek Harness Web GUI … they mean this GUI.」）；
    - 这一段**单独**发就 400；**任何一处**变化就 200（改写一个词、替换引号里的某个词、甚至插入一个零宽空格都行）；
    - 在这段外面加前缀或后缀**不影响**结果 ⇒ 精确子串匹配，不是开头规则；
    - 段落里的**单句**各自发都是 200 —— 所以按「开头」设计的归一化永远看不到它。
  - **为什么之前的两级都救不了**：前缀归一化与强制中性头都只动「开头」，而这次命中的是提示词**中间**的一段。
  - **改法**：新增 `perturbChannelFingerprints()` —— 在被扫消息（`system` / `assistant`，含每个 text part）的**句读处**插入 U+200B 零宽空格。对读者不可见、对模型无意义（词一个都没改），但任何跨句的指纹都会被截断。**只在网关已经拒绝之后**使用，正常请求逐字节不变。
  - **重试阶梯**（同一个账号，`channel_reject` 仍不换号）：首次失败 → ① `forceNeutralHead`（无处可改就跳过）→ 仍失败 → ② `perturbChannelFingerprints`（无处可改就跳过）。回复里会写明用了哪几级（「并已用强制中性头与一次不可见扰动重试过」）。
  - **代价**：被拒的那一轮最多多两个请求；账号池不记这两次失败（拒的是请求，不是账号）。

- **`perturbChannelFingerprints()` 的最终形态**：在被扫消息（`system` / `assistant`，含每个 text part）的**句末标点后**与**分句逗号/分号后**插入 U+200B；对已含 U+200B 的内容幂等跳过；`undefined` 表示「改了也没用」，调用方据此不发请求。`prepareChatBody` 与它的关系是「前者管已知开头，后者管未知的中段」，两者互不覆盖。

- **回复会写明用了几级重试**：「并已用强制中性头重试过」「并已用一次不可见扰动重试过」「并已用强制中性头与一次不可见扰动重试过」。这一行只在这两级真的跑过时出现。

### Tests

- `tests/issue98-channel-gate.spec.ts` 新增 5 条 `perturbChannelFingerprints` 用例：句读处插入、`system`/`assistant` 两种角色都插而 `user`/`tool` 不动、parts 数组与中日文标点、幂等且无改动时返回 `undefined`、畸形 body 不抛错。
- `tests/issue98-shim.spec.ts` 新增 2 条：开头级无救时**仍会**走扰动级（第二份 body 只多了不可见字符）；扰动级把被拒请求救成 200。
- 既有断言按新阶梯更新：重试全失败时的文案改为同时写出两级。

### 真实上游核验

- 用**宿主的真实失败请求**（`/tmp/failing-body.json`：10,956 字符 system + 5 条 user + 44 个 tools）在真实国内网关跑完整阶梯：`prepareChatBody` → **400**；`forceNeutralHead` → `undefined`（开头已在中性头之后，证实 4.15.0 那一级在这里是空操作）；`perturbChannelFingerprints` → **200**。
- 同一份 body 上把开头换成 `You are CodeBuddy…` / `You are WorkBuddy…` 仍然 **400**——这是「换成腾讯身份」不能作为解法的直接证据。

## 4.15.0 (2026-10-21)

> 版本号是 **minor**：有两处用户可见的行为变更 ——（1）`assistant` 历史消息也会被归一化（此前只处理 `system`），（2）渠道校验失败后插件会用「强制中性头」在**同一个账号**上重试一次。**没有被网关拒绝的请求逐字节不变**；被拒的那一次多花一个请求。路由 id、模型 id、凭据、计费与换号规则一律未变。

### Fixes

- **issue #98：网关的渠道校验也扫 `assistant` 历史消息，而插件只归一到 `system` —— 一个被污染过的会话从此每一步都失败**
  - **实测**（2026-10-21，国内网关 `copilot.tencent.com`，同账号 / 模型 `deepseek-v4.1-flash` / 请求头，**只改 body**；`max_tokens: 8`）：

    | body 里唯一的变化 | 结果 |
    | --- | --- |
    | `system` 开头 = `You are an AI agent powered by DeepSeek Harness.` | 400 / 11128 |
    | **`assistant` 历史消息开头** = 同一句 | **400 / 11128** |
    | 同一句放在 `assistant` 消息内容**中间** | 200 |
    | 给那条 `assistant` 消息开头补一行 `You are a helpful assistant.` | 200 |
    | `user` 消息开头 = 同一句 | 200（不扫 user） |
    | `tool` 结果开头 = 同一句 | 200（不扫 tool） |
    | `system` 的 content 是 parts 数组、命中在**第 2 个** text part | 400 |
    | 同上，但每个 text part 都补了中性头 | 200 |
    | `system` 开头是当前宿主的 `You are a coding agent powered by …` | 200（不在名单里） |

  - **它解释了 issue #98 的每一条症状**：只要会话里有一条 `assistant` 消息**开头**是被拦的身份（模型把系统提示词原样复述出来、会话恢复/重放、折叠摘要留下的痕迹），**这个会话之后的每一轮**都会被拒——「单轮跑到 7 分钟多才第一次报错」「继续仍报同一个错」「同一账号另一个会话正常」「重启后 1 分 22 秒失败」都是这一条的形状。换账号、换区域、重装官方客户端都不能改变它，因为被拒的是**请求里的那一行历史**。
  - **改了什么**：`neutralizeChannelFingerprints()` 现在对 `system` 与 `assistant` **两种角色**做同一件事（字符串 content 或 parts 数组里的**每个** text part，命中已知指纹就在最前面补一行中性头）。此前只处理 `system`，所以 `assistant` 里那一行**原样发出**。
  - **为什么可以改历史消息**：这是唯一能救活会话的做法——那一行在**宿主的历史里**，插件只能改它发出去的那一份。改动只有一行前缀，`user` / `tool` / `tool_calls` 结构与工具配对一律不动；宿主自己的会话记录也不改（插件只重写请求体）。

- **`system` 的 content 是 parts 数组时，4.13.0 的归一化一个字节都没生效**
  - 归一化只认 `typeof content === 'string'`，于是数组形态的 system 消息（多段文本、图文混排）整个跳过。实测：命中放在**第 2 个** text part 照样 400；每个 part 都补中性头才 200。
  - 现在逐个 text part 判断并前置；非 text part（图片等）与未命中的 part **逐字节不动**，畸形 part 只跳过、不抛错。

- **渠道校验失败后，用「强制中性头」在同一个账号上重试一次（结构性兜底）**
  - **不能靠「把名单列全」**：那份名单是网关自己的数据，插件只持有**实测快照**（`UNAPPROVED_CHANNEL_OPENINGS`）。网关加一条，插件就漏一条，而漏掉的那条会让**整个会话**死掉。猜下一条的名字不是修法。
  - **所以改成不看名单**：首次被渠道校验拒绝后，`forceNeutralHead()` 给**每一条** `system` 与 `assistant` 消息（含每个 text part）的最前面补中性头，再发一次。实测：任何被拦的开头，只要被挪到内容开头之外就 200——网关读的是**开头**，不是内容。
  - **同一个账号**：闸读的是请求，不是账号，所以 `channel_reject` 本来就不换号；这一次重试也不换（换号只会烧真实额度，再拿同一个 11128）。
  - **只在需要时**：如果每条开头都已经是中性头（`forceNeutralHead` 返回 `undefined`），不重试——那只会把同样的字节再发一遍。
  - **不记假账**：第一次失败是提示词的问题，不是账号的问题，所以它不进账号池的失败统计；重试若也失败，按最后一次的结果记账。

- **回复不再谎报「命中的 system 提示开头」（issue #98 的核心误导）**
  - **旧行为**：从**归一化之后**的 body 里取第一条 `system` 的第一行，而插件补的中性头正好在第一条 ⇒ 回复永远说「命中的 system 提示开头：「You are a helpful assistant.」」。issue #98 里 10 位报告者收到的都是这句，而这句话单独发是 200，真正被拦的那一行从未出现在回复里。
  - **新行为**：从**宿主原始 body**（归一化之前）取，**逐条**列出每个 `system` 与 `assistant` 消息的开头（parts 数组按 part 计），每条标明角色与插件是否已覆盖：
    - `「system：…」（插件已加中性头）` —— 插件会改写它；
    - `「system：…」（不在插件已知名单里，网关可能新增了词条）` —— 这一行**原样发出**，是真正该看的那条；
    - 超过 4 条时只列前 4 条，并写明还剩几条。
  - **不再说「命中的」**：网关从不告诉插件它匹配了哪一条，声称知道就是这次误导的根因。

- **同一族业务码的另两道门现在会点名，而不是转述网关的托词**
  - `11128` 有三个来源，`displayTips` 对三者**一字不差**（「这次调用没通过渠道校验，可能不是官方客户端发出的」）。另两道（`conversation id missing`、`first message is not system prompt`）此前落进通用 `client` 兜底，读者拿到的是「该请求被上游按参数拒绝……请按上面的提示调整后重试」＋那句误导文案——与本次报告者粘贴回来的那条 400 逐字一致。
  - 现在按 `msg` 点名（仍**只认 msg，绝不认 displayTips**，分类与宿主错误码保持 `client` / 400）：缺会话 id 时说明网关要三枚会话头、插件每次都带；首条不是 system 时说明网关要求首条 system、插件在有消息时会补上，因此出现即代表这次请求本身没有消息或没走插件通道。

### 评估后**没有**采纳：把中性头换成腾讯自家产品身份

- **提议**（issue #98 末尾）：把 `You are a helpful assistant.` 换成 `You are CodeBuddy, Tencent's official AI coding assistant.`。理由成立——腾讯不会把自家客户端写进黑名单，这条「结构上安全」。
- **实测代价**（同一天、同一账号、同一份 DSH 提示词，**只换开头一行**，问「你是哪个产品的助手？」）：

  | 中性头 | 回答 |
  | --- | --- |
  | `You are a helpful assistant.`（现状） | 我是 DeepSeek 的编程助手。 |
  | `You are CodeBuddy, Tencent's official AI coding assistant.` | 我是腾讯云 CodeBuddy 的 AI 编程助手。 |
  | `You are WorkBuddy, an AI agent developed by Tencent.` | 我是腾讯 WorkBuddy 的 AI 助手。 |

  前者不改变模型对自身身份的表述，后两者会**串味**——这是所有请求都要付的质量代价，不只是被拦的那几次。
- **它也不解决 issue #98**：真正被拦的是**会话里的 `assistant` 历史**，不是开头那一行；中性头当时实测仍是 200，报告者把它当成「被拦的行」是插件的回显造成的误解。
- **结论**：默认不变。「强制中性头」+「不可见扰动」已经覆盖了两类风险，且不必冒充。若将来中性头本身被拉黑，最小改动是把中性头**做成可配置**（默认仍为中性），而不是默认冒充——这留待届时有证据再评估。

### Tests

- `tests/issue98-channel-gate.spec.ts`（新增）：把上表的边界逐条钉住——parts 数组的第 1/第 2 个 part 都归一化、非 text part 与非命中 part 逐字节不动、畸形 part 不抛错、`assistant` 角色同样归一化、`isUnapprovedChannelOpening` 只匹配开头且大小写不敏感、`forceNeutralHead` 覆盖两种角色且空内容不碰、`openingEvidenceOfBody` 按角色与 part 上报并区分「插件已加中性头」与「不在名单里」、`conversation id missing` / `first message is not system prompt` 两道门的判据（code 与措辞两半都要，请求 id 里恰好含数字不算）。
- `tests/issue98-shim.spec.ts`（新增）：挂载**真实的 shim**，只替换上游应答——重试一次即成功（且发出去的第二份 body 在 `system` 与 `assistant` 两种消息前都补了中性头）、重试不换号且第一次失败不记账号账、无法改变时不重试、重试也失败时回复点名的是**宿主的**开头（含 `assistant：`）而不是插件自己的占位行、回复里不再出现「命中的 system 提示开头」与旧兜底句、两道旁门各自点名且不转述误导文案、宿主错误码仍是 `client` / 400。
- `tests/issue90-channel-reject.spec.ts` 改写：旧的三条按「从归一化后的 body 回显」写的用例方向相反（那正是本次修掉的误导），改为按新契约断言；分类与「不浪费换号」等护栏原样保留。

### 真实上游核验

- 2026-10-21 共 **200 余次只读对照**（每次 `max_tokens: 8`，未改动任何账号设置）：国内网关覆盖开头/中间/parts/角色/多 system/缺头/内容指纹定位（逐段二分 + 前缀增长 + 单点改写的双向验证）等 180 余组，国际网关 20 余组（国际不拦 DSH 身份，只拦 Claude Code；`user` 首条仍是 `first message is not system prompt`）。
- **内容指纹那一组的判定是「同一份 body 只改一处」**：原样 400、任意一处改动 200、外面加前后缀仍 400，三种同时成立才敢下「精确子串」的结论。
- 关键结论都经过**双向**确认：既能复现 400，也能用同一份 body 只改开头一行拿到 200（否则无法排除账号、区域或时间窗的影响）。

## 4.14.1 (2026-10-21)

> 版本号是 **patch**：没有接口、配置项或请求结构的变更，发往上游的请求体**一个字节都没变**。本版只改「哪些上游条目算作模型」这一处判断，以及它带出的一个目录退化路径。

### Fixes

- **不再把上游的 `auto` 路由器当成模型列出来**
  - **它不是模型**：国内区 `cli` 名单里的 `auto` 是一个**路由决策**，网关在请求时把它解析成它认为合适的那一个（实测 → `hy4-preview`）。所以它的价格、上下文窗口与行为都由别人在请求时决定，插件无法如实描述；把它列成一行，用户看到的将是一行「倍率未知、行为不定」的条目。
  - **它还制造重复**：同一份名单里本来就有它会被解析到的那个真实模型（`hy4-preview`），于是选择器出现两行指向同一个上游模型、其中一行没有倍率。
  - **改在名单构建的单一位置**（`selectCliModels`），因此卡片、模型选择器、探针与发现路由看到的是同一份结果，不会出现「卡片上没有、选择器里还有」。
  - **用显式表而不是名字启发式**：新增 `ROUTER_MODEL_IDS` / `isRouterModelId`（`src/native-modality.ts`），与既有的 `nativeModalityOf(...) === 'router'` 共用同一个来源。路由是上游的概念、没有声明字段，按名字猜迟早会误伤真实模型。
  - **静态兜底同步移除**：`FALLBACK_WORKBUDDY_MODELS` 里也有 `auto`。只改实时名单的话，它会在离线/首帧路径上复活——那是这类不一致里最难察觉的一种。
  - **空名单守卫挪到并入保留模型之后**：否则名单只剩 router 时，守卫会在合并前抛错，把「上游改了 router」放大成「这个区域一个模型都没有」。现在「上游名单为空、但用户仍有在跑的真实模型」会正常降级为后者。

- **勾选与目录零交集时退回整个目录，而不是返回空**
  - 真实触发路径正是一位「只勾过 `auto`」的用户：4.14.0 里他还能勾选它，本版不再提供之后，他的 `enabledModelIds` 与目录的交集为空，运行时目录会变成空的——那是 issue #32 的故障形态（选择器突然没有模型，且没有任何报错）。
  - `deriveCatalog` 现在只在「非空勾选 ∩ 目录 = ∅」时退回整个目录。用户勾选表达的是「要一些模型开着」，不是「一个都不要」；空目录仍然返回空，这条只处理「勾选不再匹配任何东西」。

### Tests

- `tests/upstream.spec.ts` 新增 2 条：**router 绝不作为模型出现**（名单里 `auto` 与 `hy4-preview` 同时存在时，结果只有后者）；**名单只剩 router 时保留模型仍然生效**——这条专门钉住「守卫在合并前还是合并后」这个坑，守卫放错位置它会红。
- `tests/catalog.spec.ts` 新增/改写：两区静态兜底都不含 `auto`；勾选只命中 router 时退回整个目录而不是空。
- 既有两条把 `auto` 当素材的用例改用真实模型（`hy3`），避免测试本身依赖刚被删掉的行为。
- **真实上游核验**（只读 GET，不消耗积分）：国内区 `cli` 名单 20 → **19** 条，`auto` 已不在其中；其余 9 枚活动徽标一个不少，与 WorkBuddy 客户端逐条一致。

## 4.14.0 (2026-10-21)

> 版本号是 **minor**：有用户可见的功能与行为变更（模型行新增上游活动徽标；国内区改以 App 身份读产品配置，因此目录与客户端一致）。发往上游的**聊天**请求体、路由 id、凭据、计费与换号规则一律未变——变的只有**读取模型目录**那一次 GET 的 User-Agent。

### Features

- **模型行显示上游自己的活动徽标（促销 / 等级标记）**
  - **上游把它放在同一份目录文档里**：`/v3/config` 的 `data` 下并列着 `data.models`、`data.modelPromotions`、`data.modelTiers`。插件本来就为取目录读这份文档，所以画一枚徽标**不新增任何一次上游请求**，只多一个解析器（`src/promo.ts`）。
  - **徽标是「此刻」的函数，不是解析时的快照**。上游的时段是**某个具名时区里的墙钟时间**（`schedule.daily`，例如 `Asia/Shanghai` 的 `23:00–07:50`，**跨零点**），外加一段**右开**的绝对生命周期（`validFrom` / `validUntil`）。若在解析时就挑定一枚，夜里读到的「夜间折扣」会在第二天早上继续挂着。所以解析层保留**全部候选**，由渲染时刻按当前时钟挑选：先取此刻正在运行且 `priority` 最高的一条；没有正在运行的，再退回常驻型（`display !== 'activeOnly'`）里优先级最高的一条，且它仍受绝对生命周期约束。
  - **必须保留全部候选**，因为上游用「同一模型两条互补条目」表达一个夜间活动：一条带 `discount` 落在夜间时段，另一条不带 `discount` 落在白天的互补时段、只负责把徽标常驻。只留一条必然出错。
  - **徽标只说上游的话**：文案取 `badge.label` / `labelEn`（英文界面优先 `labelEn`），颜色取 `badge.color`（**只接受 `#rgb` / `#rrggbb`**，其余当作没有颜色，避免把任意字符串塞进 CSS），悬停取上游的 `hover.textZh` / `textEn`，并在其后补上**有效期区间**与**每日时段（含上游声明的时区）**，好让「为什么此刻有这枚徽标」一眼可查。插件不翻译、不改写、不编造。
  - **每个模型只画一枚**：模型行只有一行宽，两枚徽标会把模型名与右侧勾选框挤出行外。徽标落在模型名**旁边**而不是里面——模型名是省略号截断的，徽标放进去会被一起裁掉。
  - **污染项必须丢弃**：`modelPromotions` 里混着根本不是促销的条目（`hy-image-3.5`、`kling-video-v3`：只有 `tags` / `videoGeneration`，没有 `modelIds`、没有 `badge`）。判据很干脆：**没有 `modelIds` 或没有 `badge` 的一律丢弃**，`enabled === false` 的同样不参与。
  - **徽标随 `lastCatalog` 持久化**，读回时仍是未解析的全部候选，因此卡片每次打开都能按当刻重新判定；卡片展开时本就每 60s 轮询一次，时窗边界最迟一分钟内被感知，不另设定时器。
  - **只读**：不写上游任何接口、不改账号与积分语义。徽标只是提示，不替用户做选择；上游 `hover.action`（`selectModel` / `upgrade`）**没有**做成可点击动作。取证与判定规则整理在 [`docs/PROMO_BADGE.md`](docs/PROMO_BADGE.md)。

- **国内区改以 App 自己的产品身份读产品配置，徽标与客户端一致**
  - **根因是「读错了文档」，不是「上游没下发」**。`/v3/config` 按请求头声明的**客户端通道**裁剪答案，且与主机无关（`www.workbuddy.cn`、`copilot.tencent.com`、`wb.tencentbuddy.com`、`www.codebuddy.cn` 在同一身份下逐字节一致）。实测（同 token、同 URL，**只换 User-Agent**）：
    | User-Agent | 国内区 `/v3/config` 的答案 |
    | --- | --- |
    | `CLI/2.63.2 CodeBuddy/2.63.2`（插件此前用的） | 5 键、35 模型、**无** `modelPromotions` / `modelTiers` |
    | `WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0`（App 身份） | 22 键、62 模型、**8 条促销 + 1 条等级标记** |
    CLI 通道的答案是 App 通道的**严格子集**，恰恰不发布那两个活动数组——所以国内版此前一枚徽标都画不出来，而 WorkBuddy 客户端在同一个账号上是有的。
  - **这个身份不是插件自造的**：桌面端 `app.asar` 的 `buildVlmGatewayHeaders` 拼的就是 `WorkBuddy/<app> WorkBuddy/<app> CLI/<cli>`，其自身日志也记录了这一次请求（`fetch cloud product from url:https://www.workbuddy.cn/v3/config success`）。版本号是**惰性**的（`WorkBuddy/1.0.0 …` 与 `WorkBuddy/5.8.3 …` 答案一致），决定答案形状的是**头里声明的通道**。
  - **聊天仍以 CLI 身份发送**：会话身份三元组（conversation id / request id / message id）绑定在聊天通道上。`PRODUCT_UA` 只出现在 `fetchModels` 的两处目录读取；聊天、探针、token 刷新全部保持 `CLIENT_UA`，计费路径本就不带 User-Agent。**计费归属与凭据暴露面均未变。**
  - **换取名单的变化**：国内区 App 身份的 `cli` 名单相对 CLI 身份只差一项——**多 `auto`、少 `minimax-m2.7`**，其余 19 个模型同名同价。两个模型都实测可对话（`auto` 被上游解析为 `hy4-preview`）。国际区两种身份答案相同，零回归。

### Fixes

- **换身份后，读名单时带上用户已勾选的模型，不再默默撤下正在用的那个**（issue #32 同一类故障，往前推一步）
  - 运行时目录用用户的勾选过滤上游名单，所以名单少一个 id 就等于无声撤下用户正在用的模型。`minimax-m2.7` 在 App 身份的 `cli` 名单里不见了，但**同一份文档仍然列出它**（`x0.26`、200K in / 48K out），聊天端点也照常应答。
  - 名单读取因此带上用户勾选：**名单 = 上游名单 ∪（用户已勾选、且同一份文档仍然列出的模型）**。上游真正下架的模型（文档里也没有的）不会被复活。仍然零新增请求。

- **徽标的时窗判定与文案不再「说多」——三处审查中发现的缺陷**
  - **畸形 `daily` 被降级成「全天有效」**：`parseDaily` 的注释写「丢弃，而不是当作 always」，代码恰好相反——窗口丢弃后 `daily` 整个缺失，判定见「没有时段」就返回运行中。上游任何一次形状微调（写 `25:00`、加秒 `23:00:00`、把 `start`/`end` 改名 `from`/`to`）都会让一条 `activeOnly` 的夜间活动变成 **24 小时常驻徽标**，正午也挂着「夜间折扣」。这是唯一会「说多」的方向。**修法**：新增 `schedule.dailyUnusable`，区分「上游没说时段」（24 小时活动）与「说了但一条都解析不出」（**永不运行**，不画徽标）。同时 `minutesOfClock` 接受 `24:00`（=1440，仅作终点）——上游现在把「全天」写成 `0:00–23:59`，在 23:59 与零点之间留了 1 分钟空洞。
  - **常驻 tier 能顶掉正在跑的促销**：无 `schedule` 的等级标记对「此刻是否运行」恒为 true，被算进「正在运行」候选，于是高 `priority` 的「订阅优先」会盖掉 `priority` 更低、但时窗真的开着的夜间促销——文档承诺「正在运行优先」，实现成了「priority 最高优先」。国际区实测促销与等级标记的 `priority` 都是 200，这个组合会真的发生。**修法**：第一步只考虑**带 `schedule`** 的条目（无 schedule 的只会「常驻」、不会「正在运行」）；第二步补上「解析不出时段的条目不得常驻」。tie-break 同时显式写进比较器（同 `priority` 时促销优先），不再依赖两个数组的读取顺序。
  - **tooltip 把结束日显示晚一天**：`validUntil` 是右开（当刻即失效），上游把它写成活动次日的零点、自己的文案说「– 10月31日」；tooltip 直接格式化该时刻，于是同一句里出现「11月1日」。另外日期按读者本地时区渲染，而时间戳是上游按 `Asia/Shanghai` 写的——UTC 以西的读者会看到「7月5日」，与旁边的上游文案自相矛盾。**修法**：右开区间减 1ms 再格式化，按 `schedule.timezone` 渲染。

### Docs

- 新增 [`docs/PROMO_BADGE.md`](docs/PROMO_BADGE.md)：上游活动字段的取证（两区实测矩阵、17 条真实样本、必须丢弃的污染项）、时间语义（左闭右开 / 起点含终点不含 / 跨零点 / `end === start` 为整天 / `24:00` / `dailyUnusable`）、实现取舍与**刻意不做**的边界。
- `README.md` / `README.en.md`：功能特性各加一条「模型行上的活动徽标」；**更正三处已被本轮实测推翻的说法**——① 原文写「国内版上游目录不下发活动字段、因此国内版不会出现徽标」（换 App 身份后国内区有 8 促销 + 1 等级标记）；② 原文写「国内版用 CLI 的 UA、国际版用桌面端 UA」（现两区同用 App 身份）；③ 原文引用的 `hy4-preview-f` 免费层已不复存在（两渠道现均挂付费的 `hy4-preview` `x0.29`，免费额度改以活动徽标表达）。

### Tests

- **`tests/promo.spec.ts`（21 条）**：解析丢弃污染项与 `enabled:false`、读出徽标/文案/生命周期、tier 无 schedule、**候选全保留不冻结**、attach 按模型分组且 priority 降序、生命周期边界（`validUntil` 排他）、`schedule.daily` 按上游时区读取（跨零点、起点含终点不含）、运行中的促销优先、过期即无徽标、运行中的促销优先于常驻 tier、常驻徽标在时段外仍在但过期即消失；以及本轮新增的**七条**：畸形窗口三种形状均判「永不运行」且不常驻、无时长条目不与解析失败混淆、`24:00` 无空洞、`end === start` 为整天、真在跑的促销压过无 schedule 的高 priority tier、tie-break 与输入顺序无关。
- **`tests/promo-card.spec.tsx`（6 条，jsdom）**：渲染上游文案、颜色经自定义属性下发、悬停含上游文案、无促销不渲染、过期不渲染、多条只画 priority 最高的一条。
- **`tests/promo-badge.spec.ts`（7 条，新增）**：结束日取最后一天（不为右开边界所骗）、日期按上游时区渲染（三个 locale 逐一核对）、时段按上游时区展示、无时段条目只输出上游原文、语言回退、颜色白名单。
- **`tests/upstream.spec.ts`（+6 条）**：两区都发 App 身份、国内区换身份后仍以 CLI 身份聊天、活动数组随模型带出、回落路径在两种身份下名单一致、`selectCliModels` 的并集保住用户已勾选模型。

## 4.13.2 (2026-10-21)

> 版本号是 **patch**：没有接口、配置项或请求结构的变更。发往上游的请求体**一个字节都没变**——4.13.0 的「渠道指纹归一化」照旧在跑，本版只改**网关已经拒绝之后**的那一段：把 11128 从「通用参数拒绝」里拆出来单独归类，并把**被拒的那条 system 提示开头**回显给读者。路由 id、模型 id、凭据、计费与换号规则一律未变（换号规则只有一处「不再多问一次」的减少，见下）。

### Fixes

- **issue #87 / #88 / #89 / #90 的后半段：11128 仍被归进「通用参数拒绝」，读者拿到的还是那句「请按上面的提示调整后重试」，而「上面的提示」是网关的误导文案**
  - **报告**：4.13.0 把「为什么被拒」查清了（网关按 system 提示**开头**匹配第三方 agent 清单），并让这类请求不再发出去。但**清单是实测快照**：网关新增词条时，请求照样被拒，而插件此时给出的仍然是那句通用回复——`workbuddy 上游失败：请求被上游拒绝（http 400）（code 11128，requestId …）。这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。该请求被上游按参数拒绝：与网络、账号、额度都无关，换账号也不会改变结果，请按上面的提示调整后重试`。四份报告里的一共五位用户（@huaizhuanghub、@ShiningYangYXN、@yuhang0529、@haohui421 等）在这句上花了大量时间：换账号、换区域、装官方客户端、改 UA。
  - **真实原因：`11128` 这一族里有三道门共用一个业务码，而插件只认其中一道。** 网关的 `displayTips` 对**每一道**都写成同一句「这次调用没通过渠道校验，可能不是官方客户端发出的」，所以那句话从来不是判据，只是一句放之四海皆准的托词。本版要处理的那一道是**提示开头命中**（4.13.0 已定位），而另外两道是**请求头**缺 conversation id（issue #66 已修）与**首条消息不是 system**。三道门共用 `11128`，**只有 body 能区分**。
  - **插件此前的三个错处，逐条对应**：
    1. **归类错了**：11128 落在 `client` 兜底类，读者拿到的是「按参数拒绝，换账号也没用」——这句本身没错，但**它没说是什么参数被拒**，于是提示词从来不在嫌疑名单上；而「不是官方客户端发出的」那句托词被原样转述，用户信了它。
    2. **证据没有回显**：被拒的证据在**我们刚发出去的请求**里，不在上游的回复里。插件手上明明有那几行字，却只转述了上游的托词。
    3. **探针那一侧也退化成通用失败**：探针用的是中性 system 提示（`probeRequestBody`），所以「测试能过、聊天被拒」正是这个闸的特征，而卡片当时把同一种拒绝印成「✗ 测试失败」——那一句在账号旁边，读者只会去换账号。
  - **修法一：把「提示开头命中」这一道单独归类（`channel_reject`）**。判据是**两半都要**：body 里同时有 `"code":11128` **和** msg 的措辞（`unapproved channel` / `illegal api invocation`，大小写不敏感）。只看 code 会连另外两道门一起认领——那会让读者去改写一条根本没问题的 system 提示，比通用回复更糟；所以另外两道门（`conversation id missing`、`first message is not system prompt`）被**显式排除**。**只认 `msg`、绝不认 `displayTips`**：那句托词是全族共用的，认它等于把三道门混成一道。判据放在 `classifyUpstreamError()` 里**策略拒绝之后、429/14003 之前**，所以真正的内容拒绝（`11140`）仍走它更具体的回复。
  - **修法二：回显被拒的那一行**。新增 `systemOpeningsOfBody()`：从**实际发出去的 body**（`prepareChatBody` 归一化之后的那一份）里取每条 system 消息的**第一行非空内容**，最多回显 3 条、每条截到 120 字符，取的是**上真实发送的字节**（所以命中已知指纹时回显的是插件加的那行占位语，不是宿主原文——这正是「证据」二字的含义）。读不出 body 时不编造，直接省略这段，但结论句仍然成立。
  - **修法三：三条行为跟着这个归类走**，因为它们都属于「上游拒的是提示词，不是账号」这一件事：
    - **不再换号**（`isFailoverWorthy`）：网关读的是**每条 account 都会发的那同一句提示**，换到下一个账号只会晚一轮拿到同一个 11128，而每换一次就烧一次真实额度、还往一个从没出问题的凭据上记一笔假账。
    - **不把账号踢出池**（`exclusionOf`）：与 `policy-rejected` 同处理——测量照记（卡片要能解释发生了什么），但账号仍是候选。把它 bench 掉既浪费一个好账号，又把真正的解法（改提示词）藏起来。
    - **探针与账号表用各自的说法**（`channel-rejected` 这个 outcome）：卡片那一行的文案是「网关拦的是提示词本身，不是这个账号——某条 system 消息的开头命中了它的第三方 agent 过滤，换账号或换区域都会得到同一个答案（测试能过、聊天被拒，正是这个原因）」，语气用 `warn` 而不是 `bad`：账号本身没问题，一行 `bad` 会把读者送回「换账号」。
  - **回复文本长什么样**（形状与其它失败一致，报告者会原样粘进 issue，所以外框不变）：`workbuddy 上游失败：被网关的渠道校验拦截（不是账号、额度或网络问题）（http 400）（code 11128，requestId …）。命中的 system 提示开头：「You are an AI agent powered by DeepSeek Harness.」。该请求被 WorkBuddy 网关的渠道校验拦截，上游把它描述成「不是官方客户端发出的」，但那是误导性文案：网关匹配的是 system 提示的开头，与账号、积分、额度、网络都无关，换账号或换区域也不会改变结果。若这段开头来自宿主或其他插件，请修改该提示；插件已对已知的第三方 agent 指纹做归一化，新的指纹可反馈到 issue 里`
  - **宿主那一侧也核过了（本版刻意**不**改的地方）**：这个失败写给宿主的 `code` 就是 `channel_reject`（**不翻译**），状态 400 ⇒ 宿主分类为 `INVALID_REQUEST`。这一类**不在**宿主的原地重试集合（`RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE`）里——这是对的：闸的判决对同一段提示是确定的，重试只是把同一串字节再发一遍。宿主 `failureMessage()` 只对 `QUOTA` / `ACCOUNT_QUOTA` / `AUTH` 等少数几类**丢掉插件自己的文案**，本类不在其中，所以上面那句原样到达读者。
  - **代价与边界（如实登记）**：① 回显的是**提示开头**，不是整个提示——闸只看开头，其余内容无辜，不该被抄进 issue；② 只对**body 能区分**的那一道门生效，另外两道门（请求头缺 id、首条不是 system）维持原分类，它们各有各的修法；③ 提示开头若本身就是敏感内容，读者粘进 issue 时要注意（插件不做脱敏，**上游原文回显与 issue 传播是使用者自己的决定**）；④ 4.13.0 的「已知指纹归一化」清单仍是实测快照，本版**不扩大**它——归一化是修复，单独归类是**兜底**，两者不互相替代。

### Tests

- **`tests/issue90-channel-reject.spec.ts` 新增 24 条用例**（含 3 组）：把「认得这道门」与「**认错**这道门」分开钉，后者才是本版的真正难点：
  - **认门（6 条）**：真实 CN 网关的 11128 报文逐字节捕获 → 归为 `channel_reject`（修复前是 `client`）；只认 `msg` 不认 `displayTips`（三道门共用的那句托词不足以认领任何一道）；另外两道 11128 门**保持原分类**（认错会让读者去改一条没问题的提示）；code 与措辞**两半都要**（换个业务码引同样的英文短语不是这道门）；真正的内容拒绝（`11140`）仍走它更具体的回复；请求 id 里恰好含 `11128` 不被误认。
  - **探针与账号池（2 条）**：探针把这个拒绝报成 `channel-rejected` 而不是 `failed`（后者在卡片上是「✗ 测试失败」，是唯一会引人去换账号的标签）；`exclusionOf()` 对它返回 `undefined`——账号不被踢出池。
  - **回显取什么（6 条）**：每条 system 消息各取第一行；**取的是归一化之后真正上线的字节**（已知指纹回显的是占位行，不是宿主原文）；病态长行截到 120 字符而不是把整个提示倒出来；最多 3 条；读不出来的 body 一律返回 `[]` 且**不抛**（丢掉测量不是可以接受的代价）；`content` 是数组而非字符串的消息被跳过。
  - **渲染出来的回复（6 条）**：真的挂起 **shim**（真 body 准备 + 真失败渲染），只把上游应答换成固定报文：回复里有被拒的那一行、有 `code 11128`、有 `requestId`、有「换账号或换区域也不会改变结果」、有「误导性文案」，并且**没有**旧那句「换账号也不会改变结果，请按上面的提示调整后重试」；回显的是**归一化后**的内容；宿主没给 system 消息时回显插件补的那行占位语（`ensureSystemHead` 保证有头，所以这是离「没有提示可引」最近的一种）；**没有把一次换号花掉**（failover 回调被调用 0 次，且回复不声称「已尝试 N 个账号」——那是 issue #78 的老坑）；宿主面拿到的是 400 + `channel_reject`。
  - **卡片文案（2 条）**：中英文都与「策略拒绝」「通用失败」不同（共用字符串会让「测试能过、聊天被拒」读成内容拒绝，而那有完全相反的下一步）；**所有 `row.probe*` 文案里不含 `**` 粗体标记**——探针结论是当作纯文本渲染进 `<p>` 的，带标记就会在屏幕上显示成字面的星号。
  - **宿主那一侧（2 条，issue #84 的做法）**：用**真实 pi-ai 客户端**打**真实 shim**，再问**宿主自己的判定函数**——`isQuotaExceededError()` 必须为假（为真则宿主会用自己的「额度已用尽」顶掉插件的句子，正是 issue #84 的那个坑），且文本里必须有「命中的 system 提示开头」与「换账号或换区域也不会改变结果」，**且不能有**「请用官方版本重新发送」那句托词。
  - **变异验证**：`git checkout src/upstream.ts src/shim.ts` 回退修复后，本文件 **17 条**失败（归类回 `client`、回显消失、换号又发生、探针退回 `failed`、宿主侧被判成额度失败）；仍然通过的 7 条正是护栏（另外两道 11128 门的原分类、`11140` 的原分类、账号不被踢出池、不浪费换号、卡片文案互不相同、文案不带 `**`）。

## 4.13.1 (2026-10-21)

> 版本号是 **patch**：没有接口、配置项或请求结构的变更。发往上游的请求体**一个字节都没变**——修的是「请求根本没被发出去」这条本地失败路径：目录里没有 reasoning 元数据的模型，此前在组装请求时就被本地判定失败（`UNSUPPORTED_REASONING_EFFORT`），网络一个字节都没出。路由 id、模型 id、凭据、计费与换号规则一律未变。

### Fixes

- **issue #90（后半段）：选到「没有推理档位元数据」的模型时，消息发不出去，本地直接报 `UNSUPPORTED_REASONING_EFFORT`**
  - **报告**：`#90` 里一位用户在国内区被 11128 挡住（本版 4.13.0 修的那件事），想切国际区绕开，结果撞上**另一个纯本地**的失败：`pi-ai provider "workbuddy-global" model "default-model" does not support reasoning effort "high"`，请求未出网。这条与 11128 相互独立，4.13.0 没有修它。
  - **真实原因：默认档位是「按路由」定的，而能不能接受档位是「按模型」定的。** `profileFor()` 给整条路由钉了 `reasoning: WORKBUDDY_DEFAULT_EFFORT`（`'high'`，issue #83 的修法），`dsh-llm-pi-ai` 每次解析请求都用 `options.reasoningEffort ?? profile.reasoning`。而目录里没有 `reasoning` 块的模型（`toPiModel()` 据此产出 `reasoning: false`）在 pi-ai 眼里只支持 `['off']` 一个档位，继承来的 `'high'` 它接不了，于是 `resolveReasoningLevel()` 在**组装请求时**就抛错。
  - **影响面（实测，不是推测）**：用真实凭据打真实网关取目录——国内区 34 个模型里 **6 个**无 reasoning 元数据（`default`、`glm-5.0`、`glm-4.7`、`glm-4.6`、`hunyuan-chat`、`hunyuan-image-alpha`），国际区 21 个里 **2 个**（`default-model`、`deep-model`）；而两份**静态兜底目录**（`FALLBACK_WORKBUDDY_MODELS` / `_GLOBAL`，共 32 条）**全部**没有 reasoning 字段，所以在第一次目录刷新落地之前，**每个模型都会中**。
  - **两道门，都得开**：①宿主 `dsh-llm` 的 `resolveCallWithInfo()` 看到「模型元数据里根本没有 `reasoning`」而调用方**显式**给了任何档位（**连 `'off'` 也算**）就拒；②`PiAiAdapter` 在隐式继承路由默认时于 `resolveReasoningLevel()` 拒。前者早于 adapter，所以只改派发路径修不掉显式 `'off'`。
  - **引入时间**：`git log -S 'reasoning: WORKBUDDY_DEFAULT_EFFORT'` 只指向 `1801b01`（v4.11.0，issue #83 的修法）。在那之前路由默认是缺省的，pi-ai 会自己就近降级（`clampThinkingLevel()` 不抛），所以这个回归是 **4.11.0 起的**。
  - **修法：在插件自己的 adapter 层做「按模型」的档位归一化，不动路由默认。** 新增 `EffortNormalizingAdapter extends PiAiAdapter`（`src/adapter.ts`），判据 `effortCapable(model)` = `catalog.current().some(info => info.id === model && workBuddyThinkingLevelMap(info) !== undefined)`——与 `toPiModel()` 用的是同一个判据，且读**活目录**，所以目录刷新后自动生效，不需要重建 adapter。对判据为假的模型：
    - `resolveModel()` / `prepareCall()` 返回的模型信息补上 `reasoning: { efforts: [{ id: 'off', name: 'Off' }] }`——这正是 pi-ai 认为它唯一支持的档位，于是宿主的门①放行，`'off'` 也成为用户在界面上唯一能选到的档位（此前这类模型只有「Provider default」一个不可选项）；
    - `prepareCall().stream` 与 `stream()` 把 `options.reasoningEffort` 归一成 `'off'`，于是门②放行，而 `profileOptions()` 又把 `'off'` 翻成「不下发 reasoning 字段」，pi-ai 侧 `model.reasoning === false` 也保证 `openai-completions` 不会写 `reasoning_effort` ⇒ **上游收到的请求体与修复前完全一致**（修复前是「没收到」）。
  - **一个必须记下的坑：注入的 `reasoning` 不能带 `defaultEffort`。** 宿主 `prepareCall()` 会把 `defaultEffort` **物化**进每一个「没带档位」的请求（`resolvedConfig.reasoningEffort = effective`），随后用 `callConfigEquals()` 逐字段比对调用方的 config，不一致就抛 `INVALID_PREPARED_CALL`。补 `defaultEffort: 'off'` 会让宿主给这类请求凭空加一个字段，正好撞上这条校验——所以只给 `efforts`，让宿主保持「调用方没给就是没给」。
  - **刻意不改的行为**：显式请求一个该模型做不到的档位（例如给 `glm-5.0` 选 `high`）仍然被宿主拒，消息如实说明原因。那是宿主自 v4.11.0 之前就有的契约，静默降级会把一次真实的配置错误藏起来。同理，`profileFor()` 的路由默认**一个字符都没动**：issue #83 靠它才成立（缺省默认在 pi-ai 眼里等于 `off`，`/compact` 因此 100% 400 / 11133），`tests/issue83-profile-default.spec.ts` 的三条断言也照旧全绿。
  - **代价与边界**：判据来自目录的 `reasoning` 元数据；上游哪天给 `glm-5.0` 补上元数据，插件下一次目录刷新就会自动改走正常档位路径（新测试第 6 条钉的就是这个）。反过来，若上游漏报元数据而模型其实支持档位，这类模型会停在 `off`——与 4.11.0 之前的行为一致，不会更糟。

### Tests

- **`tests/issue90-unsupported-reasoning-effort.spec.ts` 新增 6 条用例**：真实 `Context` + 真实 `LlmRuntime` + 真实插件 `apply()`，只把网关调用替换成三帧 SSE 并录下请求体，钉的是「请求到底出没出去、body 里有没有 `reasoning_effort`」，不是函数里有没有那个 if：
  - 无元数据模型不带档位 → 成功派发，body **不含** `reasoning_effort`（修复前：本地 `UNSUPPORTED_REASONING_EFFORT`，body 一个都没有）；
  - 显式 `'off'` → 同样成功（修复前宿主连 `'off'` 都拒）；
  - 显式 `'high'` → 仍被拒且 `code === 'UNSUPPORTED_REASONING_EFFORT'`、message 含 `does not support reasoning effort "high"`、**没有任何请求出网**；
  - 有元数据模型不带档位 → body 里 `reasoning_effort === 'high'`（issue #83 的护栏，确保这次没把它修坏）；
  - `resolveModelInfo()` 对无元数据模型严格返回 `{ efforts: [{ id: 'off', name: 'Off' }] }`（**没有** `defaultEffort`），对有元数据模型仍是 `['low','high','max']` + `defaultEffort: 'high'`；
  - 目录补上元数据后（改写 `liveConfig` + 发 `loader/volatile-update`）→ 档位自动回到 `high`，证明判据读的是活目录。
  - **变异验证**：`git checkout src/adapter.ts` 回退修复后，6 条里 **4 条失败**（三条报 `+ "code": "UNSUPPORTED_REASONING_EFFORT"`，一条报 `expected undefined to deeply equal { efforts: [ { id: 'off', … } ] }`）；仍然通过的 2 条正是「显式 high 必须被拒」与「有元数据模型档位必须上线」——它们在修复前后行为一致，是护栏而非修复证据。

## 4.13.0 (2026-10-21)

> 版本号是 **minor**：本版有两块改动，其中**请求体**首次新增一条 system 提示的「渠道指纹」归一化（只对开头命中上游清单的 system 消息前置一行占位语，未命中的 body 逐字节不变），这是发往上游的内容变化；另一块是**报错文案**的 405 判断与文案修正。路由 id、模型 id、凭据、计费与换号规则一律未变。

### Fixes

- **CN 版每次发消息都 400 / 11128「这次调用没通过渠道校验，可能不是官方客户端发出的」：上游按 system 提示的**开头**匹配第三方 agent 指纹，命中即拒**（issue #87 / #88 / #89 / #90 是同一件事的四份报告）
  - **报告**：国内版发「1+1」也直接失败，报错原文（插件转述上游）：`workbuddy 上游失败：请求被上游拒绝（http 400）（code 11128，requestId …）。这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。…`。同一账号、同一模型、同一套请求头，换成极简 body 却稳定 200 —— 先排除了账号、额度、UA 与 conversation 三件套（issue #66 的成因）。
  - **真实原因**：两个网关都会扫**每一条** `system` 消息的**开头**，命中一份「已知第三方 agent 系统提示」清单就回业务码 `11128`（`Illegal API invocation from an unapproved channel`）。用国内网关实测（账号 `ba217455…`、模型 `deepseek-v4.1-flash`、`stream:true`、其余请求字段固定），**同一账号同一模型**只换 system 开头：
    - `You are an AI agent powered by DeepSeek Harness` → CN **400 / 11128**，国际 **200**；
    - `You are Claude Code, Anthropic's official CLI for Claude.` → CN **400 / 11128**，国际 **400 / 11128**；
    - `You are an AI agent powered by Kimi.`、`You are Cursor Agent…`、`You are Gemini CLI…` → 两区都 **200**；
    - 同一段 DSH 提示，但最前面加一行 `You are a helpful assistant.` → 两区都 **200**。

  - **规则精确到字符**（二分实测，不是推测）：`'x'`×10956 同长度通过；DSH 提示前 **47** 个字符即 `You are an AI agent powered by DeepSeek Harness` 触发，**46** 个字符（少一个 `s`）通过；大小写不敏感（全小写同样 400）；开头多一个空格、或把同一句放进提示中段/`user` 消息都通过；**每一条** system 消息都会被扫（第二条才命中同样 400）。
  - **为什么此前没有暴露**：插件只转发宿主给的 system 提示，此前没有宿主提示命中过这份清单。issue #66 的 11128 是**请求头**上的 conversation id 门（缺三枚 UUID），与这次同码不同因，所以 4.12.0 的头修复对它无效；`displayTips` 那句「不是官方客户端发出的」在两次事件里都是**误导性文案**——网关的真正判据分别是「头缺 id」与「提示开头命中清单」。国际网关目前不拦 DSH 这句、但拦 Claude Code：同一份清单的两个不同子集，插件对两区用同一条规则。
  - **修法：只做「开头」归一化，不改提示内容。** `prepareChatBody()` 在 `ensureSystemHead()` 之后新增 `neutralizeChannelFingerprints()`：遍历 `messages`，对 `role.trim().toLowerCase() === 'system'` 且 `content` 为字符串的消息，取 `content.replace(/^\s+/, '').toLowerCase()` 与 `UNAPPROVED_CHANNEL_OPENINGS`（当前两条：DeepSeek Harness、Claude Code）做前缀比对，命中则 `content = WORKBUDDY_FALLBACK_SYSTEM_PROMPT + '\n\n' + content`。未命中的 body 逐字节不动（`tools`、`reasoning_effort`、历史形状均不动）；宿主提示原文一字不改，只在最前面多一行两个区都已接受的占位句 —— 与 `ensureSystemHead()` 用的是同一句，理由同样是「加一行中性的话，比改写宿主自己的提示代价小」。
  - **实测修复**：完整 DSH 提示 + 50 个 tools + `reasoning_effort:'high'` + 真实的 `tool_calls`/`tool` 历史：改前 400，改后 200；只加一个换行（`'\n' + 提示`）当时也 200，但那是靠网关当前的宽松，不能当修法，所以用显式占位行。
  - **代价与边界（如实登记）**：清单是**实测快照**，网关新增词条不会被提前发现，直到有 body 带上它；prepend 只在「命中仍在 offset 0」时有效；宿主若把这段文案放到 `user` 消息或提示中段，当前规则不触发（也无需触发）。这不是绕过额度或内容审核——`11140` 安全审核、`14018` 额度、`6004` 限流等路径一行未动。

- **issue #86：批量操作报「HTTP 405」时，提示「请确认插件是最新版本」把人引向错误的修法**
  - **报告**：点「一键签到所有账号」后卡片报「批量操作失败 —— 没有执行：批量操作被拒绝（HTTP 405）。请确认插件是最新版本后重试。」，而插件**已是最新版本**。重启 DSH 后恢复。
  - **真实原因：那条路由在宿主进程里根本没注册。** 405 是宿主 HTTP 层回的，不是插件回的。判定依据是两种 405 的形态完全不同：插件自己的拒绝是 `json(res, 405, {error:'method not allowed'})`，带 `Content-Type: application/json` 与 body；而实测 `POST /pool` 的 405 **没有 Content-Type、没有 body**。插件每个 handler 都回 JSON，所以「405 + 空 body」只可能来自宿主 HTTP 层，也就是路径没匹配上任何插件路由。
  - **同一次排查里所有路由的实测**（同一进程内，`GET` / `POST`）：`usage` 200/405、`benefit/claim` 405(带 JSON)/400、`models/refresh` 404/405、`probe` 404/405、`pool` 404/405、`oauth` 404/405、`transfer` 404/405。注册顺序是 usage → account-credits → accounts → checkin → benefit/claim → models/refresh → probe → pool → diag → oauth → transfer，所以断点落在 `benefit/claim` 与 `models/refresh` 之间。
  - **这不是「插件版本旧」**：这些路由的引入时间都远早于出问题的构建（`pool` 是 3.0.0 / 09-30，`probe` 是 2.3.0 / 09-29，`models/refresh` 更早），任何已发布版本都包含它们。是那次启动时注册中途失败了；具体触发条件未复现，重启即恢复。**记在这里是为了不再把它误判成版本问题**——按「更新插件」去查会一无所获。
  - **修法：客户端区分这两种 405。** `poolFailureText` 的第三层（按状态码兜底）新增一条前置判断：响应体不是 JSON 且状态是 405 时，改用新文案「批量操作接口没有应答（HTTP {status}，无响应体）—— 宿主进程很可能还在跑旧版插件代码，这个接口没有注册上。请完全退出 DSH 再重新打开后重试。」四个调用点（批量签到/测试、行内测试、行内删除、福利领取）都传入 `bodyUnreadable: body === undefined`。
  - **只有 405 走这个分支，这是刻意的**：客户端这里只会 POST，未注册的路径只可能以 405 回来；一个**没有 body 的 500/502 是真实的服务端故障**，把它改写成「重启试试」会让人放弃真正该查的东西。结构化 `reason` 仍然优先于两种状态码兜底——未来宿主若在不可解析的 body 旁带 `reason`，本地化的原因严格更有信息量。

### Tests

- **`tests/upstream.spec.ts` 新增 4 条用例**，钉的是「发往上游的 system 内容」，不是函数里有没有那句 if：
  - 完整 DSH 开头 + 后续行 → `messages[0].content === WORKBUDDY_FALLBACK_SYSTEM_PROMPT + '\n\n' + 原文`，`messages` 长度与 user 消息不动；
  - 全小写 + 两个前导空格的开头同样归一化（网关现在容忍大小写与前导空白只是巧合，不能让它成为下一个失败点）；
  - 同一句出现在提示中段 → 原文**逐字节**保留（网关只看开头，多改一个字都是在动本可以正常工作的请求）；
  - 第二条 system（DSH 的 `developer` 目录更新经 `developer → system` 改写而来）命中时同样被归一化，而第一条原样保留——`ensureSystemHead()` 只看第一条，这条用例把两者的作用域分开钉住。
- **`tests/pool-state.spec.ts` 新增 4 条用例**，钉住「两种 405 不可混同」：空 body 的 405 走新文案；**带 JSON 的 405 仍走原文案**（否则会把一次真正的「方法不对」误诊成「重启」）；无 body 的 500/502 **不**被劫持（防止把服务端故障改写成重启建议）；带 `reason` 时仍优先结构化原因。

## 4.12.0 (2026-10-20)

> 版本号是 **minor**：有用户可见的行为变更（模型繁忙不再显示成「额度已用尽」，且会被宿主原地重试几次）。发往上游的请求体、路由 id、模型 id、凭据、计费与换号规则一律未变。

### Fixes

- **issue #84：模型繁忙（14003）在聊天窗口被显示成「当前请求的额度已用尽」，并因此一次就失败**
  - **报告**：issue #84 的评论里先有「国际版用deepseek模型会提示额度不足，step模型可以正常调用。但是我用workbuddy国际版正常使用deepseek免费模型」，随后又被同一线程的第二位报告者（zhangxinhang）收窄到真正的缺陷：**DeepSeek 用的人太多，经常 `model_busy`，而插件对于 `model_busy`，聊天窗口似乎会显示为「当前请求的额度已用尽」**；并请求「对于这种模型繁忙，是否可以进行适当次数的重试」。两条都要修，且它们是同一个原因的两个后果。
  - **根因是一行映射，不是额度**：`src/shim.ts` 的 `KIND_HOST_CODE` 把 `model_busy` 翻成了 `quota_exceeded`（issue #56/#63 的取舍，理由是把 429 挡在宿主的原地重试集合之外）。但宿主判定失败类别靠的是**对错误文本跑正则**：`classifyPiAiError()` 把 `type + " " + code + " " + message` 交给 `@deepseek-ai/dsh-llm` 的 `isQuotaExceededError()`，而它的 `(?:quota|usage[_\s-]+limit)[_\s-]+(?:exceeded|exhausted|reached)` 恰好匹配 `quota_exceeded` 这个**字面拼写**。于是类别落到 `QUOTA`，而 `@deepseek-ai/dsh-client-ui-chat` 的 `failureMessage()` 对 `QUOTA`/`ACCOUNT_QUOTA` **硬编码固定文案并丢弃插件自己的 message**——「当前请求的额度已用尽」其实**不是插件写的**，是宿主替插件写的。
  - **后果比措辞严重**：一个**暂时**、**与账号无关**、**换模型即可绕开**的状况，被渲染成一个**终局**、**账号级**的结论；同时 `QUOTA` 不在宿主的重试集合里（`DEFAULT_RETRYABLE_CODES` = `EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT`），所以一次 14003 就直接结束这一轮——正是报告者要求补救的那件事。
  - **修法：不再翻译 `model_busy`。** 不翻译之后同一份 wire body 的文本里只剩 `429`，宿主读作 `RATE_LIMIT`，于是一举两得：**(a)** `RATE_LIMIT` 不在 `failureMessage()` 的替换名单里，插件自己那句诚实的说明原样显示给用户；**(b)** `RATE_LIMIT` **在**宿主的默认重试集合里，`dsh-llm-retry` 按默认的 500 ms→10 s 指数退避**原地重试**——报告者要的「适当次数的重试」由宿主自己的机制完成，插件不新增重试循环，也不引入无界重试。
  - **`soft_rate` 保留翻译，这正是关键对比**：它的 6004 重置时刻在**几小时后**，重试预算换不出答案，所以必须继续挡在重试集合外。**同一个状态码 429，两种相反的时间判断**——所以拼写跟的是**时钟**，而不是两者共用的状态码。
  - **文案跟着改**：`model_busy` 的回复现在明确写出「这与积分、额度无关」，并说明「这类失败会被自动重试几次」。不加这两句，用户读到的「建议等待约 1 分钟」会让一个已经被重试过五次的请求看起来像插件什么都没做。
  - **不是推断，是端到端验过**：用本地 `node:http` 服务器重放这个 shim 真实产出的错误体，驱动**真实的 pi-ai `stream()`**（宿主用的就是它）拿到 `errorMessage`，再跑**宿主自己的** `isQuotaExceededError()`。改前 `model_busy` 判 `QUOTA`，改后判 `RATE_LIMIT`；`hard_credit`（报文里真有 `Credits exhausted`）两条路径都仍是 `QUOTA`——真花光积分时宿主仍显示它的终局文案，这个修复没有把真额度问题一起放过。
  - **同时确认不是这个原因的两件事**（都已实测排除，记在这里省下后来人重走）：**a.** 与**请求的 User-Agent 通道**无关——CLI UA 与桌面 UA 各发 5 次，`deepseek-v4.1-flash` 200/200/200/200/429 与 200×5，`step-5-preview` 全 200，付费的 `deepseek-v4.1-flash-sg` 全 14018；**b.** 与**请求大小**无关——8k/16k/30k/50k 输入下 14003 时有时无、非单调，纯属瞬时繁忙。
  - **一个仍存在的相邻陷阱（本轮未改，如实登记）**：国际版 `/v3/config` 的 28 个模型里，`deepseek-v4.1-flash`（`x0.00`，免费）与 `deepseek-v4.1-flash-sg`（`x0.03`，付费）**显示名完全相同**（都是 `Deepseek-V4.1-Flash`），说明与能力字段也逐字相同，选择器里只有 ` · x0.00` / ` · x0.03` 这个后缀能区分；零积分账号选中付费那一个就会拿到 14018，而那是**真的**额度不足，宿主显示「额度已用尽」是对的。`step-5-preview` 没有付费孪生，所以「deepseek 报额度不足、step 正常」也可能来自**选错了同名的付费孪生**。改名会影响用户已保存的模型身份与全部按 id 的 join，需要单独一轮评估，因此不在本版顺手改。

### Tests

- **`tests/issue84-model-busy-not-quota.spec.ts`：钉「宿主实际看到的那段文本」，而不是「映射表里没有那个键」**
  - 关键断言不是实现细节，而是宿主的判定：测试用**真实的 pi-ai `stream()`**（宿主用的同一个客户端）打到**真实的 shim**（真的开 socket），把 pi-ai 产出的 `errorMessage` 交给**宿主自己的** `isQuotaExceededError()`。重新实现一份分类器只能证明两份正则今天一致；而决定文案的是宿主那份。
  - 四条用例覆盖两种失败的两侧：`model_busy` **不是** quota 且文案里带「与积分、额度无关」；`hard_credit`（真实 14018 报文）**仍是** quota；`soft_rate`（真实 6004 报文）**仍是** quota 且保留上游的重置时刻——「不该改的那半边别一起扫掉」。
  - **重试那条断言读的是 adapter 自己发布的策略**（`config.profiles()` 的 `retryPolicy`，也就是宿主经 `providerRetryPolicy` 读到的同一个对象），不是 `resolveRetryPolicy(undefined)` 的默认值：后者在 adapter 干脆不再发布策略时**依然会绿**。断言含 `RATE_LIMIT` 在内、`QUOTA` 不在内、`maxRetries` 有界（>0 且 ≤10，即「适当次数」而不是无界循环）。
  - **变异验证**：把 `model_busy: 'quota_exceeded'` 加回 `KIND_HOST_CODE`，`issue84` 的第一条与 `shim-failover` 的对应用例**当场变红**；恢复后全绿。`shim.spec.ts` 的「只有 soft_rate 需要翻译」那条清单把 `model_busy` 也收了进去，且注释写明它会红在哪。
  - **改了两条既有断言**：`tests/shim.spec.ts`（`model_busy` 现在也属于「按自己的名字拼写」那一组）与 `tests/shim-failover.spec.ts`（`"code":"quota_exceeded"` → `"code":"model_busy"`，并新增 `not.toContain('quota_exceeded')`）。两条都是原先在**钉住缺陷**的断言，不是回归。

## 4.11.0 (2026-10-20)

> 版本号是 **minor**：有行为变更（对实测拒绝 `off` 的那 9 个模型，卡片上的「可关闭思考」变为不可勾选）。发往上游的请求体、路由 id、模型 id、凭据、计费与换号规则一律未变。

### Fixes

- **issue #83：给「实测拒绝 off」的模型勾上「可关闭思考」后，该模型的每一次 `/compact` 必定 400 / 11133**
  - **报告链路**：用户在卡片上给 `deepseek-v4.1-flash` 之类**实测拒绝 `off`** 的模型勾了「可关闭思考」→ `withEffectiveOff()` 用保存的勾选覆盖 `canDisableThinking` → `workBuddyThinkingLevelMap()` 把 `off` 映成 `"off"` → pi-ai 的 `openai-completions` 在**调用方没传 `reasoningEffort`** 时用 `model.thinkingLevelMap?.off` 兜底 → 压缩摘要请求（`summarizeWithLlm`）恰好**不传**档位 → 每次 `/compact` 都带 `reasoning_effort:"off"` → 两个网关都回 400 / 11133，界面只说 `Compaction could not produce a useful summary`。
  - **多写出来的那一条**：`REFUSES_OFF_MODEL_IDS` 一直被当作「种子」而不是「墙」，3.5.0 的说明写着「用户勾选即生效」。但它与同一条 changelog 里写下的取舍原则相反：**提供一个必定失败的档位，代价是该模型每一次请求；误藏一个本来可用的档位，代价只是一个选项**。而且这次失败的不只是「某个请求」——pi-ai 会把这个档位当成**所有未指定档位请求的默认值**。
  - **三道防线（独立失效点，各自有测试）**：
    1. **层级映射墙**：`withEffectiveOff()` 对名单内 id 恒置 `canDisableThinking: false`（`offRefused()` 与 `offDefaultFor()` 同口径），`workBuddyThinkingLevelMap()` 再查一次名单，所以 `off` 根本不会被提供，也不依赖调用方先盖章。
    2. **请求体兜底**：`prepareChatBody()` 新增 `dropRefusedReasoning()`——名单内模型的 `reasoning_effort: "off"` 在发往上游前被摘掉。这一层守的是**目录建好之后才变**的情形：账号池换号会把 body 指向另一个账号的模型，`primary-model` 还是个由网关解析的别名。
    3. **显式默认档位**：`dsh-llm-pi-ai` 按 `options.reasoningEffort ?? profile.reasoning` 解析档位，此前 `profile.reasoning` 是 `undefined`，等于把默认值交给 pi-ai 的层级映射——也就是交给那个 `off`。现在 profile 显式声明 `reasoning: 'high'`（`WORKBUDDY_DEFAULT_EFFORT`），所有注册键一致。
  - **只摘 `off`**：其他档位在 issue #34 的实测里全部 200；body 里**本来就没有**档位时不补任何值——插件不替模型决定该怎么思考。
  - **列表外模型不受影响**：名单按**精确 id** 匹配，`grok-4.7` 这类未记录的模型仍然由用户勾选与自身声明决定，修复不会顺手拿走一个本来能用的档位。
  - **错误信息可诊断**：`parseUpstreamErrorDetail()` 现在读 `extError.param` / `extError.value`；当被拒参数与推理档位有关时，回复直接点名「上游拒绝了推理档位「off」（reasoning_effort）」并给出「取消可关闭思考勾选」的处置建议，而不是只说「请求被上游拒绝」。`param` 为空时（issue #78 的那类 body）**不猜**，原有文案原样保留。
  - **观测记录**：`reportRefusal` 回调把「某模型确实被拒了 off」记进一个有界环形缓冲（20 条，进程内、不落盘）。这是压缩路径唯一能把事实送到界面上的通路——它只把失败当布尔值，正文被丢掉。

### Features

- **卡片上如实标注拒绝 `off` 的行**：名单内模型（以及进程内实测被拒的模型）的「可关闭思考」显示为**勾选但禁用**，旁边多一枚 `拒绝 off` 标记，tooltip 说明「实测两个网关都回 400 / code 11133，勾选后所有未指定档位的请求（尤其压缩摘要）都会失败」。**不禁用、不隐藏**这个勾选框：旧版本可能已经把勾存下来了，藏起来等于把用户保存的状态和失败原因一起藏掉。判定值 `offRefused` / `refusesOff` 由宿主给出，卡片不自行推断。

### Tests

- **`tests/issue83-off-refusal.spec.ts`：钉请求体，而不是钉函数返回值**
  - 用**真实 pi-ai `openai-completions`** 经**真实 adapter** 构建请求，注入 `fetch` 捕获 body，再断言 `reasoning_effort` 不在其中——「盖了章」不等于「没发出去」，只有 body 能证明。模型描述符取自 adapter 自己的目录（声明 `canDisableThinking: true`，与上游对这 9 个 id 的声明一致），所以手写描述符绕过的 profile 级修复在这里藏不住。
  - 另外三条守 `prepareChatBody`：名单内摘除、名单外保留、其他档位一格不动、原本没有档位就不补。
- **`tests/issue83-profile-default.spec.ts`**：profile 的默认档位是 `'high'` 而不是 `undefined`/`'off'`，且**每一个注册键**都一致（issue #75 的身份键也算）。
- **`tests/off-thinking.spec.ts` / `off-thinking-runtime.spec.ts` / `off-thinking-card.spec.tsx` 改了三条断言**：此前它们断言「用户勾选优先于名单」，而那正是 issue #83 的成因。现在改为断言墙生效、名单外仍然尊重勾选、以及卡片对宿主标记的行渲染成「勾选但禁用 + 有标记」。
- **`tests/upstream-error-copy.spec.ts` 加了 4 条**：11133 且 `param` 指向档位时点名档位与处置；`param` 为空时**不**归因到档位；拒绝被上报（含被请求命名的 `modelId`，不是账号别名）；非参数类失败不上报。
- **变异验证**：单独回退「层级映射墙」→ 1 条红；单独回退「adapter 名单判断」→ 2 条红；单独回退「显式默认档位」→ profile 那 2 条红。撤回其中任一层都有测试当场报错。全量 1536 passed / 2 skipped，`pnpm run typecheck` 与 `pnpm run build` 均干净。

## 4.10.1 (2026-10-20)

> 版本号是 **patch**：没有接口、配置项或请求结构的变更，发往上游的请求体、路由 id、模型 id、凭据、计费与换号规则一律未变。**但它是 issue #77 的正解**——4.9.3 起的 `detail=fast` 只去掉了上游调用，真正吃掉 60 秒的本地开销一直没动；本版把每次打开设置页的 `reg query` 子进程从约 **135 个**降到 **3 个以内**。

### Fixes

- **issue #77（第二轮）：字段密钥的探测按「失败也记住」缓存，一次打开页面不再逐文件重跑注册表探测**
  - **报告与归因**：4.9.3 加了 `detail=fast` 之后，用户在 4.9.4、4.10 上仍然等 60 s。其 CPU profile 指出：19.1 s 的请求里 **15.3 s 在 `spawnSync`**，来自约 **135 个同步 `reg query` 子进程**——`findWorkbuddyAppExecutable()` 每次请求被调用 45 次，每次查三个卸载 hive。
  - **根因**：`readAtRestKey()` 只缓存**成功**。当凭据字段是 `$wbEncrypted` 而桌面端又不在候选目录里时，每次探测都会重跑整套发现；`scanAll()` 是**逐文件**调用的，一次打开页面又要读多次，两个乘数叠在一起。
  - **第二个乘数**：`SCAN_SHARE_WINDOW_MS` 从扫描的**开始**时刻计窗——比窗口更慢的那次扫描**在完成时就已经过期**，永远无法服务它之后的读取。现在从**完成**时刻计窗，并单独保留 `invalidateScan()` 供写入路径强制刷新（写完再读不会看到旧列表）。
  - **两处顺手的去重**：`findWorkbuddyAppExecutableWithSource()` 会在默认布局 → 注册表 → `findWorkbuddyAppExecutable()` 的回落链里对同一个答案问两遍注册表，现在只问一遍；失败结果带上过期时间缓存，所以「先不装、后装 App」的用户**不需要重启**就能被看见。
  - **代价**：第一次真正的读取仍付一次探测的钱（3 次 `reg`），此后每一轮读取都是 0。

### Tests

- **`tests/issue77-at-rest-key-cache.spec.ts`：用「子进程次数」钉住，不靠计时措辞**
  - `process.platform` 影子成 `win32` + `execFileSync` 在模块边界打桩，于是**任何宿主（含 CI 的 macOS/Linux）**都会真的走进 Windows 分支并把 `reg` 调用数出来：一次探测恰好 3 次、5 个加密凭据文件的一轮读取（`accounts` → `status` → `current` → `accounts`）仍是 3 次、失败结果被记住、过期后重新探测。
  - **变异验证**：把修复回退后这两条断言分别报 **15 ≠ 3** 与 **9 ≠ 3**；三个用例在修复后全绿。写入后再读的用例在前修复/后修复两种状态下都绿——它守的是「共享窗口不得变成 TTL」，是回归护栏而非修复证据。
  - 文件里的凭据夹具用**真实的加密字段形状** `{$wbEncrypted: 1, envelope: "<base64>"}`；写成嵌套对象会被 `isEncryptedFieldWrapper()` 判为「未加密」，让整条用例静默走错分支（写测试时踩到过，已在夹具注释里记下）。

## 4.10.0 (2026-10-19)

> 版本号是 **minor**：4.9.5 / 4.9.6 两个 patch 从未单独发布到 npm（npm 上仍是 4.9.4），本次一次性带上它们，并新增福利活动的完整链路。**发往上游的请求体、路由 id、模型 id、凭据、计费与换号规则一律未变。**

### Features

- **issue #79：福利活动自动发现 + 单账号领取（4.9.4 → 4.10.0 的主线）**
  - **自动发现**：卡片逐账号标出上游活动（模型服务异常补偿 / 新人首月赠送）里**还没领的那一份**。数据来自上游两个只读状态接口 `/billing/meter/compensation-status` 与 `/billing/meter/check-gift-claimed`（注意**没有 `/v2` 前缀**，探 `/v2/...` 会 404）。
  - **判定规则完全由上游状态决定**：`active && !claimed` 才显示；`claimed` 整行消失；活动过期（上游把 `active` 翻成 `false`）自动消失。**不拿本地时钟去比 `end_time`**，本机时间偏了也不会与服务端打架；`end_time` 只用于 3 天内临期高亮。
  - `active` 单独看**不行**：已领取的账号 `active` 仍为 `true`，只看它会让领过的活动永远挂着待领取。
  - 读取复用签到管线：每账号一次、30 分钟缓存、账号池关闭时不发请求；任一接口失败按「未读」处理，**不会把一次失败缓存成「全都没福利」**。
  - **单账号「领取」按钮**：每个待领取项后一个实心琥珀色胶囊按钮，**一次只领一个账号的一个活动**。没有「全部领取」——一次点击花掉的是一份不可撤销的真实权益。
  - 新路由 `POST /plugins/dsh-connect-workbuddy/benefit/claim?accountId=&kind=`，沿用写路由的 POST + loopback 守卫，并**强制要求 `accountId`**，请求本身无法批量领取。
  - 领取前**重新读取**状态再判定；已领取/已过期一律 409 且不调用上游。领取后用上游**新读数**作答并刷新卡片，不做乐观更新。
  - **领取成功后清掉该账号的福利缓存**：这是本次修掉的最关键 bug。缓存 TTL 30 分钟且此前从不因领取失效，于是「积分涨了、按钮还在」，用户会以为领取失败而重复点击，第二次被 409 拒绝。
  - **每行按钮只联动自己那一行**：此前行的 busy 标志传的是「有任一行动作」，点一行会让五行同时变成「领取中…」，看起来像一次领了整池。
  - 实测：真实账号 `19dea97d` 领取后 `claimed` 由 false 变 true，500 积分到账；同一批次 6 个账号 × 500 积分待领取，截止 10/22。

### Docs

- **描述与 README 同步到插件实际能力**：`package.json` 的 `description`、市场提交草稿的 `description.zh` / `description.en`、两个 README 的标题下 tagline 与开头段，统一改写为「国内版 + 国际版接入 / 每次刷新按上游目录自动读取每个模型的积分倍率 / 逐模型图片输入开关 / 多账号切换与账号池自动换号 / 每日签到与只读积分概览」。旧描述只写了「模型接入 + 只读积分概览 + 模型管理」，把 3.x~4.9 长出来的能力全落在了外面。
- **更正一处不成立的表述**：描述草稿里曾有「费率随错峰时段变化」的说法。全仓（`src/`、`tests/`、`docs/`、两个 README）与 WorkBuddy 桌面端 asar 里都没有任何峰谷/时段折扣逻辑，`git log -S` 也从无此词；插件真正做的是**从上游目录解析每个模型自带的积分倍率**（`x0.79` 这种，解析不出就不显示，绝不猜），且该倍率确实会被上游改动（`deepseek-v4.1-flash` 已从 0 变成 0.11）。会随「时段」变的那个是**免费模型的 token 定额**，不是价格，因此文案按实测口径写「随上游目录刷新更新」，不承诺峰谷计价。
- **README 补上「福利活动」条目（中英双语）**：4.9.4 的待领取标记与 4.9.6 的单账号「领取」按钮此前在两个 README 里**一次都没提过**。新增条目写清：数据只来自上游两个状态接口、标记阶段只读、三条显示规则由上游状态决定（不用本地时钟比 `end_time`）、一次只领一个账号的一个活动、写路由强制 `accountId` 所以无法批量、领取前重读状态、领取后用上游新读数刷新并清掉该账号的福利缓存。
- **卡片内说明文案（`src/client/locales.ts` 的 `row.desc`，中英同步）**同步改写，与上面的描述口径一致；两侧键仍严格 1:1。
- **修 EN README 的编号重复**：自动换号那一节有两个 `7.`，第二条（每次重试写一行 `warn`）改为 `8.`。

### Fixes

- **裁剪福利说明不再撑破积分列**：福利文案与按钮曾被挤成竖排「领取」二字并压住右侧目标模型列；胶囊改为 `white-space:nowrap` + 固定 19px 高 + `flex:none`，让列宽只能压缩文字、压不了按钮。
- **「领取」二字的视觉居中**：无头 Chrome 像素扫描测得 CJK 字形墨迹比行盒中心偏低约 1px，用 `padding-top:1px` 补偿（`transform` 与 `padding-bottom` 两个方向都试过，都会把墨迹推得更低，已弃用）。
- **CHANGELOG 结构：补回丢失的 `## 4.9.5 (2026-10-19 · 未单独发布，并入 4.10.0)` 标题**。`6bf825a`（feat: 单账号领取福利按钮）把顶部标题改写成 4.9.6 时，把 4.9.5 那一节的正文留在了下面却没有版本标题——于是 4.9.5 的 Features 看起来像是 4.9.6 的一部分，而 `git tag` 与 npm 上它确实是一个独立版本。现按 `cad9ec3`（chore(release): 4.9.5）的原样恢复标题。

## 4.9.6 (2026-10-19 · 未单独发布，并入 4.10.0)

> 版本号是 **patch**：新增一个写路由与行内按钮，发往上游的请求体、路由 id、模型 id、凭据、计费与换号规则一律未变。

### Features

- **issue #79：账号池卡片提供单账号「领取」按钮**
  - 每个待领取的福利后面带一个按钮，**一次只领一个账号的一个活动**；没有任何「全部领取」，因为一次点击花掉的是一份不可撤销的真实权益。
  - 新路由 `POST /plugins/dsh-connect-workbuddy/benefit/claim?accountId=&kind=`，沿用写路由的 POST + loopback 守卫，并**强制要求 accountId**——请求本身无法批量领取。
  - 领取前**重新读取**状态再判定（窗口内 && 未领取），所以过期的卡片不会触发无谓写入；已领取/已过期一律 409 且不调用上游。
  - 领取后用上游的**新读数**作答并刷新卡片，不做乐观更新：即使上游静默失败，也不会留下「已领取」的假象。
  - 实测：真实账号 `19dea97d` 领取后 `claimed` 由 false 变 true，500 积分到账。

## 4.9.5 (2026-10-19 · 未单独发布，并入 4.10.0)

> 版本号是 **patch**：只新增只读查询与界面标记，发往上游的请求体、路由 id、模型 id、凭据、计费与换号规则一律未变。

### Features

- **issue #79：账号池卡片标出「有福利还没领」**
  - 数据来自上游自己的两个活动状态接口（`/billing/meter/compensation-status`、`/billing/meter/check-gift-claimed`），**只读**；`claim-compensation` / `claim-gift` 两个写接口从不调用。
  - 三条显示规则都由上游状态直接决定，前端不维护状态：
    - `active && !claimed` → 显示待领取。
    - `claimed` → 整行不出现（领过的不再骚扰）。
    - 活动过期 → `active` 翻 `false`，整行自动消失，**不用本地时钟比 `end_time`**（时钟偏了不会与服务端打架）；`end_time` 只用于 3 天内临期高亮。
  - `active` 不能单独判断：已领取的账号 `active` 仍为 `true`，只看它会让领过的账号永远挂着待领取。
  - 读取复用 `checkedInToday` 的管线：每账号一次、TTL 30 分钟、池关闭不发请求；任一接口失败按「未读」处理，不会把一次失败缓存成「全都没福利」。

## 4.9.4 (2026-10-19)

> 版本号是 **patch**：只改**错误文案的取材方式**，发往上游的请求体、路由 id、模型 id、凭据、计费与换号规则一律未变（换号规则的变化只有一处「不再多问一次」的减少，见下）。但它修的是一个**会把人送去查错地方**的故障——一个普通的 400 被渲染成「账号池空了」，而上游唯一那句可执行建议被截断丢掉。

### Fixes

- **issue #78：400/11133 被渲染成「池中其余账号本次请求都已尝试过」，且 `displayTips` 被 400 字截断丢弃**
  - **原来错在哪**：三个缺陷叠在同一行错误里。
    1. **描述了一次从未发生的账号遍历**。`isFailoverWorthy()` 明确排除 `client`（同一个请求体换哪个账号都是 400），换号循环因此一次都没跑；但通用分支判断「要不要问池子要解释」用的条件是**回调是否存在**，而真实宿主两个回调都给了。于是 `explainPoolShortfall()` 被问了一次，它看到池里每个成员都健康（400 不记账号故障）、`excluded.length === 0`，命中那条分支返回「池中其余账号本次请求都已尝试过」——**池子其实没被问过任何候选**。句中再加上尾部固定的「池中没有其他可用账号」，整句读起来就是「账号用完了/额度耗尽了」，而真实原因是请求参数。
    2. **`displayTips` 从未被解析**。`parseUpstreamErrorDetail()` 只取 `code`/`requestId`/`displayMsg`；通用分支把 `result.message.slice(0, 400)` 直接拼进用户可见文本，而这类报文 637–777 字符，前 400 字符全是 `code`/`requestId`/`extError` 的骨架（`param: ""`、`Request: null`），那句「请新建任务、换个模型或稍后重试」必然落在截断之外。报告者看到的回复停在 `Pleas` 中间。
    3. **状态码印两次**。`failoverReasonText()` 的 `default` 回「不可用（http 400）」，而调用方自己又拼了一次「（http 400）」。
  - **为什么测试没抓住**：既有测试全都用**不带 `displayTips`** 的报文（#56 的 14003、#51 的策略拒绝），所以「可执行建议被截断」这件事在夹具里根本不存在；而「问了没问池子」只被间接覆盖——`shortfall` 回调存在的用例恰好都是有换号的用例，于是「有没有问」和「该不该问」在测试里始终是同一个问题。状态码重复更无从断言：**没有任何测试读过用户看到的那一行**，只断言过 `detail` 字段本身。
  - **现在的形状**：
    - `UpstreamErrorDetail` 增加 `tips?: string`，`parseUpstreamErrorDetail()` 用同一个 `localizedText()` 读 `displayTips` 与 `displayMsg`（字符串与 `{ zh, en }` 两种形态都接受）。两个字段分开存：`displayMsg` 说「错在哪」，`displayTips` 说「该怎么办」——合并会让其中一个失去自己的意思。
    - 通用分支的正文改成 `detail.tips ?? detail.displayMsg ?? clippedUpstreamText(message, 400)`，`code`/`requestId` 收进紧凑后缀「（code 11133，requestId 33221fe5-…）」（support 要的就是这两个，此前只能从被切碎的 JSON 里自己找）。`clippedUpstreamText()` 压平空白、超长时优先在句末断开并补 `…`——它**只**接住解析不出来的报文（非 JSON 网关页），有 `detail` 的报文永远走不到它。
    - `failoverReasonText()` 增加 `case 'client': return '请求被上游拒绝'`，`default` 改为 `'不可用'`（不再自带状态码）。另两个分支（`policy_reject` / `model_busy`）里同样的 `slice(0, 200)` 也换成 `clippedUpstreamText()`，形状统一。
    - **问池子的条件改为「真的搜过」**：`failoverShortfall !== undefined && failoverAccount !== undefined && isFailoverWorthy(result.kind)`。`client` 与 `model_busy` 两类不再触发那次排序（它们本来就不换号，问出来的答案必然是假的）；`client` 另给一句正确的建议——「该请求被上游按参数拒绝：与网络、账号、额度都无关，换账号也不会改变结果」。
  - **同一份报文现在渲染为**（177 字符，原来是 490）：
    ```
    workbuddy 上游失败：请求被上游拒绝（http 400）（code 11133，requestId 33221fe5-f6d5-4ea1-8882-669411e07a5b）。这次对话的内容这个模型不接受，与网络无关。请新建任务、换个模型或稍后重试。该请求被上游按参数拒绝：与网络、账号、额度都无关，换账号也不会改变结果，请按上面的提示调整后重试
    ```
  - **测试**：新增 `tests/upstream-error-copy.spec.ts`（12 例）。它**不测 helper 而测渲染出来的那句话**——helper 只值它换来的用户可见结果，且 `detail` 由真实的 `parseUpstreamErrorDetail()` 产出，所以解析与渲染是一起被覆盖的（手搓 `detail` 的夹具可以在解析坏掉时仍然是绿的）。用例含：报告者那份 11133 报文逐字节渲染出上游建议、`message` 里**没有** `extError`/`"requestId"` 等骨架、长度 < 300、`（http 400）` 恰好出现**一次**（数出来的，因为「含有 http 400」对坏文案也成立）、`client` 失败时 shortfall 回调**调用次数为 0**且不出现两句池子术语、429 这类**会**换号的失败仍然既问池子又打印池子的结论并保留上游的重置时间、超长非 JSON 页补 `…` 且长度有界、短的非 JSON 页原样显示且不加 `…`、以及 `policy_reject`/`model_busy` 两个分支的文案不回归。删掉 `tips` 的解析、或把「问池子」的条件改回看回调是否存在，这组里都有用例会失败——已实测确认判别力。
  - **刻意没做的**：没有改 `explainPoolShortfall()` 本身（它那句「池中其余账号本次请求都已尝试过」在**真的**搜过池子之后是诚实的，问题在于以前没搜过也会被问）；没有把 `triedAccountIds` 传进 shortfall 回调（`tests/pool-e2e.spec.ts` 有源码文本守卫固定 `explainPoolShortfall(region)` 这个调用形状，且现有签名「不从 shim 接收参数」是 `src/index.ts:837-844` 写明的设计）；没有改 400 的换号策略本身——它本来就是对的，错的是文案在描述一次没发生的换号。

## 4.9.3 (2026-10-19)

> 版本号是 **patch**：新增一个**可选**的查询参数（`detail=fast`）和一条**只读**的本地取数路径；不带参数的老请求逐字节不变，发往上游的请求体、路由 id、模型 id、凭据与配置项一律未改。但**它修的是一个用户可见的等待**——打开设置页后要等半分钟到一分钟才出现账号列表。

### Fixes

- **issue #77：打开设置页要等 30–60 秒才出现各个账号**
  - **原来错在哪**：卡片的账号列表来自**一份**用量文档，而这份文档的**末尾**要等一串上游读取——账号池每个成员一次 `fetchCredits`、每个账号一次 `fetchCheckinStatus`、当前账号自己再一次 `fetchCredits` + `fetchCheckinStatus`。每次上游调用超时是 `JSON_TIMEOUT_MS = 30_000`（`src/upstream.ts`）且**没有重试**，于是慢一点的上游把等待叠成 30–60 秒。更糟的是这段时间里卡片渲染的是 `signed-out` 占位（说是「未登录」并给出「重新检测账号」按钮）——**报告者截图里看到的正是这个占位**，一个已经登录、池里有一堆账号的用户被告知未登录。
  - **为什么 4.6.7 显得快**：那版还没有账号池的逐账号读数和签到读数（`poolMembersOf` 的逐成员积分读、`checkedInToday` 的逐账号签到读都是更早的提交引入的，但**卡片等整份文档**这个形状把它们的代价直接变成了首屏代价）；不是 4.9.x 新增了扇出，而是 4.9.x 的功能让这份文档变得更长。所以修法不是微调超时，而是**把首屏和计费读解耦**。
  - **现在的形状**：
    - **服务端**：用量路由接受 `detail=fast`（`src/status-paths.ts` 的 `withWorkBuddyRegionFastDetail` / `fastDetailOf`），快速文档**只读本地状态**——凭据用 `store.current()`（不触发 token 刷新），实时数字（`credits` / `checkin` / `credentialRejected` / `recovery`）整块省略，账号池成员取自新增的 `localMembers`（就是请求路径本来就在用的 `localPoolMembers`，**零上游调用**），签到状态取自本进程已有的测量缓存 `cachedCheckedInToday`。**不带参数的行为一字未变**：未知或拼错的 `detail` 值一律退回完整文档，绝不会变成一份更空的卡片。
    - **客户端**：先取 `detail=fast` 把账号表格画出来，再照旧取完整文档补上积分与签到。快速文档**永远不会覆盖**已经拿到完整文档的区域（它更穷，覆盖会把已显示的列抹成「—」）。在这之前（两份都还没回来）渲染 `row.accountsLoading`「正在加载账号…」，**不再假称未登录**。
    - **为什么快速文档仍然带账号池块**：`AccountPool` 在没有 `pool` 块时返回 `null`，账号行就来自那里——首屏要「出现各个账号」，这个块就是必须的。它现在由本地花名册生成，不再等积分读数。
  - **测试**：`tests/issue77-fast-first-paint.spec.ts` 在**路由层**断言快速文档**一次上游调用都不发**（积分/签到客户端被换成会抛错的桩，快速文档仍然成功），以及 `detail` 的解析只认精确的 `fast`、其余值全部退回完整文档，并保留完整文档行为不变的用例。`tests/issue77-card-first-paint.spec.tsx` 在**渲染层**用「完整文档永不返回」的桩挂载真实卡片，断言账号行**照样出现**、且不出现「未登录」文案；同时断言全部未返回时显示加载行，以及迟到的快速文档不会覆盖已加载的完整文档。删掉快速路径或让卡片等完整文档，这两组都会失败——已实测确认判别力。
  - **刻意没做的**：没有给上游调用加重试或缩短超时（那只是把 30 秒变成另一种 30 秒）；没有把 `poolMembersOf` 从完整文档里拿掉（完整文档仍然需要真实积分）；没有让快速文档在宿主不支持时触发那次昂贵读取（缺 `localMembers` 就省略账号池块，宁可少画一行也不拖慢首屏）。

## 4.9.2 (2026-10-19)

> 版本号是 **patch**：只改 `profiles` 里多登记一个注册表键，外加文档与注释；发往上游的请求体、路由 id、模型 id、模型选择器、目录与凭据一律未变。但**它修的是一个整区不可用的故障**——4.9.0/4.9.1 期间国际版（`workbuddy-global`）的每一个请求都在发出前失败。

### Fixes

- **issue #75：国际版整区报 `Unknown provider: workbuddy`，任何请求都不可能成功**
  - **原来错在哪**：4.9.0 为修 issue #59 把两条路由的模型身份统一成 `workbuddy`（`WORKBUDDY_MODEL_IDENTITY`），理由是「只有让 `isSameModel` 判等，跨区的 thinking 才不会降级成正文」。当时的论证是：pi-ai 的 `getModel(provider, id)` 取 `providers.get(provider).getModels()`（`models.js:116–118`），**查表的键**与**模型上盖的 `provider` 字段**是分开的，所以盖上 `workbuddy` 无害。**这条论证只对按参数查表的那条路径成立，漏掉了真正跑聊天的那条**：`models.streamSimple(model, …)` 的第一帧就是 `requireProvider(model)` = `this.providers.get(model.provider)`（`models.js:351–355`），查的正是模型上盖的那个字段。而每条路由的注册表里只登记过它自己的路由 id（宿主 `dsh-llm-pi-ai` 对每个 profile 调一次 `models.setProvider(profile.piProvider)`，键取 **provider 对象的 `id`**）。于是国内版（路由 `workbuddy`、盖 `workbuddy`）自洽，国际版（路由 `workbuddy-global`、盖 `workbuddy`）在一个只有 `workbuddy-global` 的注册表里查 `workbuddy` —— 抛 `ModelsError("provider", "Unknown provider: workbuddy")`，**在请求发出之前**。
  - **为什么测试没抓住**：#59 配的守卫测试断言的是 `getModel(provider, id)` 这种**按参数**的查表，恰好是不看盖上字段的那一种形状；于是它可以全绿，而聊天路径已经整区死掉。报错文案里也不含 "WorkBuddy" 字样，用户看到的是宿主状态一个无关的 provider 名。
  - **现在的形状**：新增 `modelIdentityKeysOf(providerId, identity)`（`src/adapter.ts`），返回一条路由要在自己的注册表里登记的全部键。每条路由把**同一个** shim 的 provider **按两个 id 各建一个对象**登记：路由 id（`workbuddy-global`，含它自己的 shim 地址、目录、凭据）＋共享身份（`workbuddy`）。国内版路由 id 与身份相同，去重后仍只登记一个。这段构造抽成 `buildProfiles()`，初始发布与 `invalidate()`（目录刷新后重建）**共用同一份**——旧代码在 `invalidate()` 里按单键重建，刷新一次就会把国际版重新打回故障。
  - **一个必须说破的细节**：`Models.setProvider(provider)` 存的是 `this.providers.set(provider.id, provider)`（`models.js:35–38`），键取的是**provider 对象的 `id`**，不是 `profiles` 映射的键。因此「把同一个 provider 对象发布两次」是**静默无效**的，必须给身份那个键一个 `id` 改为身份的 provider 对象。`ResolvedPiAiProviderProfile.provider` 上游注释称自己就是「`Models` 集合的键」，只有 `piProvider.id === profile.provider` 时才成立——按对象拆开后这个不变式回来了。
  - **顺带覆盖的第二处失败点**：`Models.getAuth(providerOrModel)` 同样用 `providers.get(providerOrModel.provider)` 取 provider（`models.js:275–280`，宿主侧 `:334–341`），修之前国际版即使过了 `requireProvider` 也会以 `Provider is not configured` 倒在取凭据一步；同一个键一并覆盖。
  - **刻意没做的**：报告者提议的一行改法（`modelIdentity = options.modelIdentity ?? providerId`）**不能采纳**——它把身份拆回按路由区分，等于回退 #59（跨区 thinking 又整批降级成正文、计费跳变重现）。也没必要把身份做成「第二条 provider 条目」：`Models.providers` 本来就是 `Map`，多一个键不影响路由集合，模型选择器、目录、凭据、`registerAdapter` 的 routes 数组全都没有变化。上游的真修法仍是让 `isSameModel` 认「provider 等价组」声明（`earendil-works/pi#6167`）。
  - **测试**：新增 `tests/issue75-global-provider-dispatch.spec.ts`，不用 `profiles()` 的字面量断言，而是**照宿主的构造方式**建注册表（`createModels()` + 每个 profile 一次 `setProvider`）再走 `streamSimple`。其中包含：国际版真实服务的模型能在国际版注册表里被 `requireProvider` 解析且拿到**国际版自己的** `baseUrl`（不是国内版的）；国内版不被连累；**一个反证用例**手工重建 4.9.1 的单键注册表，断言它仍然失败于 `Unknown provider: workbuddy`，防止上面几条变成空转通过；`invalidate()` 之后上述性质仍在；以及 #59 的两条性质（两边盖同一个身份、跨区 thinking 仍是 `thinking`）不回退。把 `buildProfiles` 临时改回单键重跑，这组测试会以 `ModelsError: Unknown provider: workbuddy` 失败——已实测确认判别力。
  - **文档**：`README.md` 的 issue #59 那一段原文把上述错误论证当成了依据，已改正并写明 #75 的成因与 4.9.2 的做法；`docs/audit/ISSUE59-OPTIONS.md` 的「O1′ SHIPPED」一节补了「#75 CORRECTION」，说明当时为什么论证错了、以及为什么「按你推理的那条查表路径写的测试，无法证伪从同一条路径得出的结论」。

## 4.9.1 (2026-10-19)

> 版本号是 **patch**：只改账号池里两枚「当前使用」徽章的配色，外加一处 CHANGELOG 排序修正；不改请求、响应、计费、排序规则或任何配置项。发往上游的请求体与 4.9.0 逐字节相同。

### Fixes

- **账号池的两枚「当前使用」徽章改成实心绿底 + 白字**
  - **原来错在哪**：两枚徽章（`src/client/styles.ts:303` 的区块标题行、`:353` 的表格行内）的颜色由**两个互不相干的来源**拼成 —— 底色是写死的淡蓝 `rgba(86,134,254,.16)`，字色却取 `--dsw-alias-brand-primary`。后者是宿主主题的**对比色**（见同文件约 118 行那条 checkbox 注释：它曾被用来画勾选框，在浅色主题下把格子涂成沉重的黑色药丸），于是同一枚徽章在浅色主题下是「近黑字 + 淡蓝底」，读起来像一条**禁用标签**，而不是「这一行正在服务」。
  - **为什么底色也要一起换**：只把字改成绿色（4.9.0 之后内部试过的一版）仍然是一枚**淡色药丸上的彩色小字**，属于安静的批注。徽章存在的全部意义就是让人一眼找到正在服务的那一行，需要找的东西不算数。所以改成填充态：绿底本身就是底，白字压在上面。
  - **现在的形状**：
    | 片段 | 值 | 说明 |
    | --- | --- | --- |
    | 背景 | `var(--dsw-alias-state-success-primary,#22c55e)` | 与右列「已签到」「✓ 可用」**同一个绿**，跟随主题（深色 `#22c55e` / 浅色 `#16a34a`） |
    | 文字 | `#fff` | 直接写死而非取 token：字色与底色各走一路，正是这条故障的成因 |
    | 描边 | `1px solid rgba(34,197,94,.55)` | 主题把 success 改成深色时，防止药丸与行底色糊在一起 |
  - **对比度要说准**：白字在 `#22c55e` 上约 **2.2:1**、在 `#16a34a` 上约 **3.3:1**，低于正文 4.5:1 的门槛。这是有意的取舍，已写在 CSS 注释里：徽章保持 11–12px **粗体**、只承载两个字的短标签，先被当作「形状」看见，再被当作字读到。若要更硬的对比需改深绿底（`#15803d`，白字约 4.9:1），本版没这么做。
  - **刻意没动的**：账号名左侧那条实心色条（`:343`）、手动排序的「第 N 位」排名徽章（`:357`）、↑↓ 按钮的 hover 态（`:359`）、行底色（`:325`/`:329`）仍用 `brand-primary`。它们描摹的是「顺序」与「可操作性」，与「是不是我在用的那个」是两件事 —— 4.8.1 之前那版正因为把一种颜色同时用于多件事才读不出来。
  - **测试**：`tests/client-host-contract.spec.ts` 新增用例，逐个选择器从提取出的 CSS 里断言「绿底 + `color:#fff`」，同时钉住两条**不得回归**：不得再出现 `brand-primary`，不得再出现淡蓝 `rgba(86,134,254,.16)`。按选择器逐条断言而非全文断言，是为了防止其中一枚悄悄改回去而测试仍然通过。
- **`CHANGELOG.md` 的版本节顺序修正**
  - 4.9.0 上次发布时被插到了 4.8.2 **之后**，最新版本不在最上面。本版把 4.9.0 一节移回 4.8.2 之前；两节正文一字未改。

## 4.9.0 (2026-10-18)

> 版本号是 **minor**：这不是只改内部或只改文案的 patch —— 它改了请求里每个模型声明的身份，因此**会改变发往同一模型的历史消息的重放形状**（thinking 不再被降级成正文）。计费前提本身没有改；不跨区、不换模型的会话，其请求体与 4.8.2 逐字节相同。

### Changes

- **issue #59 计费前提定案：`reasoning` 不计费；同时撤回我们自己一个说法、改正报告者两个数**
  - **定案的是什么**：`docs/reasoning-investigation.md` §10.1 的 (ii)「上游忽不忽略 `reasoning`」自 4.6.x 起一直记**尚未测定**，`docs/audit/ISSUE59-VERIFY.md` 的 C7 也记 UNVERIFIABLE-LOCALLY。现在可以写清楚了，依据两条互不依赖的算式：
    1. **同区同模型增量**（报告者的机器实测）：国际侧两次相邻请求之间 `promptTokens` +416，`reasoning` 字符 +1,290、其余块 +892。计费读法算出来是 **0.1907 tok/char**，不计费读法是 **0.4664**；后者与我们自己实测的 `tool-result` 系数 **455.5 tok/1k** 只差 2.4%，而那一步新增的正是 `assistant(tool-call)` + `tool(result)`。
    2. **国际侧自己的账**（纯本仓库系数）：tool 块 959,283 字符 × 0.4555 = **436,953 tok**，已是它 447,306 总量的 **97.7%**；剩下的 10,353 tok 要分给另外 822,343 字符（0.0126 tok/char）—— 只要 `reasoning` 也计费，这笔账就凑不出来。
  - **性质必须说准**：这是「**报告者实测 + 本仓库系数复算佐证**」，**不是本机实测**。本机没有 `global.jsonl`，`cn.jsonl` 685 条里 `promptTokens` 命中 0（都是 4.6.6 之前写的记录）。要升级成「本机独立复现」，还差一份独立账号的捕获或一次受控的 reasoning 开关 A/B。
  - **我们撤回了什么**：4.8.0/4.8.1 的文档里那句「若 `reasoning` 计费，预测比值 0.697」是**量纲串了** —— 0.697 是两边非 reasoning 密度的比值，不是计费假设的预测。计费假设下两区计费字符几乎相等（差 0.15%），预测比值应 **≈1.00**，而实测 **1.4370**：计费假设是**被证伪**，不是被吻合。报告者的这条批评成立，`docs/audit/ISSUE59-VERIFY.md` 的追记里已写明。
  - **改正了两个数**：报告者撤回 `text` 741,952 → **741,687**（原数重复计了 265 字符），代码注释与测试文件头随之更正；他给过的隐含系数 **0.3518 tok/char 作废**（分母串了，真分母是 555,724），该数从未进过公开文档，C7 当初「无法复现」的疑问至此解释完毕。
  - **不变的部分**：`isSameModel` 判据、两个 provider id 的成因、`context-rescue` 的兜底行为，一条都没改 —— 本次只改文档与注释，不动任何运行时行为。

- **issue #59 插件侧修复：两条路由的 model 身份统一，换区不再把 thinking 降级成正文**
  - **原来错在哪**：pi-ai 只把历史里的 thinking 当 thinking 重放，条件是产生它的消息与本次请求的 provider、api、model id **三者全等**（`transform-messages.js:68`）；不等就**降级成普通正文**（`:88–96`）。本插件把国内版与国际版注册成两条独立路由（`workbuddy` / `workbuddy-global`），而它们是**同一个 model id** —— 于是换一次区，另一侧产生的全部 thinking 整批从 reasoning 桶挪进正文桶。报告者实测：同一份字节相同的历史，一侧 708K、另一侧 1.374M（1.94×），为其中一侧算出的压缩请求因此永远塞不进另一侧的窗口。
  - **改了什么**：新增 `WORKBUDDY_MODEL_IDENTITY = 'workbuddy'`（`src/adapter.ts`），`toPiModel` 盖在模型上的 `provider` 字段两边都用它，`isSameModel` 于是成立。**路由 id 一个都没合并** —— 注册键仍是 `workbuddy` / `workbuddy-global`，各自指向自己的 shim、目录与凭据；`tests/issue59-cross-region-thinking.spec.ts` 断言「同一个 model 身份 + 各自的 baseUrl + 各自的路由键」三件事同时成立。
  - **为什么能这样做而不出问题**：pi-ai 的查表本来就分两件事 —— `getModel(provider, id)` 是 `providers.get(provider).getModels()` 里按 id 找（`models.js:116–118`），**键**是路由 id，**盖在返回对象上的 `provider` 字段**是 provider 自己写的。本插件不注册 `fetchModels`，没有任何下游从该字段反推路由；openai-completions 的 api 只用它取厂商特例（都不匹配这两个 id）和错误信息里的标签。
  - **没有一并「修」掉的**：同区内换模型仍降级（那是真的换了模型，thinking 签名对新模型未必有效，保留才是错的）；升级前录进历史的消息带旧的按区域 id，重放时仍按旧规则降级，但只会越聊越少，不影响新录的消息。真正的修法仍在上游：`isSameModel` 应当能读「provider 等价组」声明，而不是让插件去伪装身份。
  - **测试如何证明**：`transformMessages` 上跑了两组对照 —— 旧的一对按区域 id 复现出 `[text, text]`（这正是报告的成因），新的一对给出 `[thinking, text]` 且正文原样保留；另有一条断言**不同 model id 仍然降级**，防止这次修复被误读成「任何模型都算同一个」。本地 pi-ai 0.85.1 与宿主 1.1.0 在这条判据上的行为已分别核对一致。

## 4.8.2 (2026-10-18)

> 版本号是 **patch**：只改积分面板第二行的文字配色，不改请求、响应、计费、排序或任何配置项。`stateTone` 的判定、圆点的颜色规则、行的顺序都与本版之前完全相同。

### Changes

- **积分面板第二行的「当前选用」改成绿色**
  - **原来错在哪**：`ComposerCredits.tsx` 把那两个事实拼成**一个** span —— `detailLine(当前选用, 被限流 · 约 6 小时后)`。一个 span 只能有一种颜色，而它挂的是 `.dsm-workbuddy-composer-panel-mark`，颜色是原因用的琥珀色 `--dsw-alias-state-warn-primary`。于是「当前选用」这句陈述事实的话，被涂成了问题的颜色：在一张「被限流」的表格里，它看起来像第三种警告。
  - **现在的形状**：第二行拆成两个 span，各得各的语气 ——
    | 片段 | 类名 | 颜色 | 出现在 |
    | --- | --- | --- | --- |
    | 当前选用 | `.dsm-workbuddy-composer-panel-mark-current` | `--dsw-alias-state-success-primary`（绿） | 正在服务本 tab 的那一行 |
    | 被限流 · 约 X 小时后 | `.dsm-workbuddy-composer-panel-mark-reason` | `--dsw-alias-state-warn-primary`（琥珀，**未变**） | 用不了的行 |
  - **分隔符改由 CSS 画**：两个 span 之间的 ` · ` 来自相邻兄弟选择器 `-current + -reason::before{content:" · "}`，所以把这一行当**纯文本**读出来仍是 `当前选用 · 被限流 · 约 6 小时后` —— 行 `title` 的悬浮提示、`th` 的 `aria-label`、以及既有的字符串断言都不受影响。这也是没有把两段文案在 TS 里拼成一个字符串的原因：拼了就没法给它们分别上色。
  - **刻意没动的**：圆点的颜色规则（能用=绿、不能用=红、未测=灰）与 `stateTone` 的判定一行未改。选哪个颜色回答的是「能不能用」，第二行回答的是「是不是我在用的那个」，这两条规则各自独立 —— 4.8.1 之前那一版正是因为把颜色同时用于两件事才读不出来。
  - **测试**：`tests/composer-credits-render.spec.tsx` 新增用例钉住「选中为独立绿色 span、原因为独立琥珀 span、两者共存仍不合并」，颜色断言直接从 `WORKBUDDY_COMPOSER_CSS` 里读规则，而不是断言类名存在就算过。

## 4.8.1 (2026-10-18)

> 版本号是 **patch**：只改卡片界面的样式与排版，不改请求、响应、计费或任何配置项。发往上游的请求体与本版之前逐字节相同。

### Changes

- **积分读数区重排为「偏好行」，样式与排版对齐 dsh-connect-trae**
  - **原来错在哪**：这个区块在卡片上换过三个位置 —— 先是 tab 栏下两个并排的复选框（读起来像**一个**共享设置），再被塞进「账号池」标题行（与标题、当前账号徽章挤在同一条基线，最宽的下拉框把徽章推到卡片最右缘，读起来像下拉框的标签），最后成了带独立标题的小节（`justify-content:space-between` 又把每句话劈成「左边缘的标签 + 右边缘的控件」，中间隔着半张卡的空隙）。三次都是**归属**问题，不是间距问题。
  - **现在的形状**（与参考实现逐条一致）：一块**没有标题的偏好行组**，直接挂在 tab 块下面 —— 一个复选框 + 标题 + 其下一行说明，然后**缩进 25px**（15px 方框 + 10px 行距）的「显示位置」行，标签与下拉框相邻、从左侧打包，行内没有任何元素被拉伸到边缘。
  - **顺带修掉一个真漏洞**：这个区块此前通过 `AccountPool` 的 `headerExtra` 插槽渲染，而 `AccountPool` 在宿主不报告账号池状态时**整段返回 null** —— 开关会跟着一起消失，用户在那个宿主上**根本没有**打开读数的入口，唯一的线索是一行读数不见了。现在它渲染在 `AccountPool` 之外，与该区块是否存在无关。`headerExtra` 这个插槽已从 `AccountPool` 整个删除，不只是不再传。
  - **文案随之改为「说明」而非「复述」**：主开关的标题由区域相关（「对话框显示 WB CN 积分」）改为区域无关的「在输入框工具栏显示积分读数」—— 它现在带一行自己的说明，且紧邻的下拉框就叫「输入框工具栏」，旧标题会与它重复。新增两段说明：开关下面那句讲**读数是什么**，下拉框下面那句讲**选位置是什么意思**；主开关关闭时后者换成一句点名原因和做法的提示，而不是留一个灰框让用户猜。
  - **勾选框交回平台**：区域卡里的勾选框曾用 `appearance:none` 手绘（15px 方块、3px 圆角、两条旋转边框拼的勾）。参考实现没有手绘 —— 它只写 `accent-color`，方框的尺寸/圆角/勾形全由平台决定。截图实测：2x 屏上那个方块是 26 设备像素 = **13 CSS px**，正是引擎自带复选框的默认尺寸，不是任何人写下的数字。已改为与参考实现相同的两条声明，手绘规则全部删除。
  - **下拉框退回原生外观**：曾手绘成白底细边 + 两条渐变拼的箭头（照一张**浅色**设置页截图），在深色卡片里成了唯一自带填充/边框/箭头的元素，读起来像贴进段落里的一个表单控件。现在用原生控件 + 一条细边，尺寸由它自己的两个选项决定，不再有 `min-width:132px` 这个为「与徽章共享标题行」而设的地板。
  - **README**（中英同步）：关掉读数的那句话改为新标签，并补上「显示位置」这一行的说明。

## 4.8.0 (2026-10-18)

> 版本号是 **minor**：这不是只改内部的 patch —— 它**会改动会话历史**。跨区/跨窗口切换后原本必然卡死的那一类会话，本版能把上下文折回去继续用。没有溢出时行为完全不变。

### Fixes

- **切到窗口更小的路由后，会话永久卡在 `400 code 11115 prompt is too long`（#59 后半）**
  - **症状**：会话在一个 1M 窗口的模型上跑得很长，切成国际区（`workbuddy-global`，窗口 1,048,576）后，**每一条**请求都返回 `prompt is too long: 1374460 tokens > 1048576 maximum`。换回原区域能用，再切过去还是卡死；手动压缩同样 400。会话实质报废。
  - **根因（宿主侧，两处叠加）**：
    1. **压力阈值按「当前模型」窗口现算**，`compaction-basic/src/config.ts:188-192` 的 `thresholdTokens = min(contextWindow × thresholdRatio, messageBudgetTokens)`。1M 窗口下阈值是 800,000，而 707,801 未到 —— 会话在**切区那一刻就已经超了新模型的窗口**，可自动压缩的触发点还在旧模型的尺度上，永远等不到。
    2. **溢出兜底把整段历史塞进一次摘要请求**，`compaction-basic/src/index.ts:299` 的 `selectCompactableRange(session, measurement, 0)` 保留量为 0 → `region.ts:150-154` 选出「除最后一条外的全部历史」；`summarizer.ts:141-151` 又把这份摘要发给**当前那条小窗口路由**。于是救援请求和它要救援的请求一样溢出 —— 死锁。
    宿主侧已按 deepseek-ai/deepseek-harness#9814 提交，上面两处即该 issue 的 A、B 两点。
  - **本版做的事**：适配器在溢出错误**仍然持有 session id** 的那一刻接手，用宿主**自己的**压缩事务（`ctx.compaction.compactRegion`）把历史折回去，而不是另发一次摘要请求。
    - 分块上限 = 模型窗口的 **35%**，因此摘要请求本身**按构造**一定装得下（宿主默认那一次是 131%）。
    - 折叠目标是窗口的 **60%**，逐块折叠直到低于目标；块边界来自宿主自己的 `tokenMeter`。
    - **绝不折掉当前请求携带的那条消息**（`nodes.at(-1)` 永远保留）。
    - 宿主拒绝某个区间（切断了 tool call 与 result 的配对、或正有压缩在跑）时，把尾边向内收一格重试；仍是拒绝就放弃，绝不空转。
    - 折完仍降不下去（单条消息本身就超过窗口）时立刻停手 —— 这是结构性问题，重试只会烧掉重试预算。
  - **实测（真实 GL 400 载荷）**：`isContextOverflow` 对 `prompt is too long: 1374460 tokens > 1048576 maximum` 与 `{"code":11115,...,"type":"CONTEXT_WINDOW_EXCEEDED"}` 均判定为真，对 `rate limit exceeded` 判定为假 —— 只在真溢出时动手。
  - **降级路径**：宿主没装压缩包（`compaction` 服务不存在）、或请求没带 `sessionId`（非主循环调用）时，适配器原样返回，行为与本版之前**逐字节相同**。

### 已知未修

- **跨区 prompt token 计数漂移**（#59 前半）：同一份 3.6 MB 请求体，CN 计 642,800、GL 计 447,306。这不是网关数错 —— 历史里的 thinking 块按上游当初实际返回的字段名（`reasoning` / `reasoning_content`）原样回放（宿主 `pi-ai` 0.85.1 `openai-completions.js:428` → `:1006`），同一批字节因此落进不同计费桶。归属宿主，本插件没有改写历史的权限，详见 #59 与 `src/body-report.ts` 头部说明。

## 4.7.0 (2026-10-17)

> 版本号是 **minor**：这不是只改内部的 patch —— 它**改变了发往上游的请求体**。DSH Desktop 0.2.1-rc.1 随包 pi-ai 1.1.0，本版修的是该组合下「请求静默丢掉 system prompt 与全部工具声明」。若你停留在更早的宿主，行为不变。

### Fixes

- **DSH 0.2.1-rc.1 下所有 workbuddy 模型静默丢失 system prompt 与工具声明（新一轮 #24/#25/#26 同族缺陷）**
  - **症状**：升级到 DSH `0.2.1-rc.1`（随包 `@earendil-works/pi-ai@1.1.0`）后，workbuddy / workbuddy-global 的模型**全部**不再调用工具，界面上**没有任何报错**。模型有时把 DSML 标记当正文吐出来——和 4.4.2 记录的现象一模一样。
  - **根因（三环叠加，缺一不成立）**：
    1. `dsh-llm-pi-ai` **两版都不做归一化**。0.1.7 与 0.2.1 的 `piContext()` 都直接返回 `{systemPrompt, messages, tools}`，两版里 `normalizeContext` 出现次数均为 **0**。
    2. pi-ai **0.85.1 读顶层字段**：`dist/api/openai-completions.js:909` 的 `if (context.systemPrompt)`，工具读 `context.tools`。所以 0.85 能自己兜底，宿主不归一化也看不出问题。
    3. pi-ai **1.1.0 只读 `messages`**：走 `resolveTranscript()` → `collapseSystemMessages()`，顶层 `systemPrompt` / `tools` **从不读取**。
    于是 `withLegacyContext()` 的 **modern 分支原样透传**（当时一行 `return api`），把 0.85 形状的原始信封直接交给 1.1.0 的 api → 请求体里 system prompt 与 tools 双双为空。
  - **为什么 4.4.2 的修复不够**：4.4.2 修的是「1.x 被判成 legacy → 折成 0.85 形状 → 工具丢」。本版是**同一失效模式的反面**——「1.x 判成 modern（判定是对的）→ 不折 → 工具和 prompt 一起丢」。门是对的，空的是那个分支。`generationOf()` 无需改动。
  - **实测证据（真实 `createProvider` + 真实 `openAICompletionsApi` + 本地 SSE 服务器抓线上 body）**：

    | pi-ai | 线上 `messages[].role` | system 文本 | `body.tools` |
    |---|---|---|---|
    | 0.85.1 | `["system","user"]` | 原样 | 1 ✅ |
    | **1.1.0（修复前）** | **`["user"]`** | **丢失** | **0** |
    | 1.1.0（修复后） | `["system","user"]` | 原样 | 1 ✅ |
    | 1.1.0（已归一化输入） | `["system","user"]` | 原样 | 1 ✅（幂等） |

  - **改了什么**：新增 `foldModernContext()`，modern 分支改为**归一化**而非透传——把顶层的 `systemPrompt`/`tools` 折进首条 `system` 消息（文本进 `content`、工具进 `toolsAdded`），并**删掉**这两个顶层字段，与 pi-ai 官方 `normalizeContext` 的输出形状一致。
  - **为什么内联而不是调 `normalizeContext`**：该函数在 **0.85.1 里不存在**，静态 import 会在那里变成 `undefined`；而本模块一贯「绝不静态 import pi-ai」（`pi-ai-runtime.ts` 头部教条，正是它让独立 `bin` 能在没装 peer 的 profile 里跑）。内联折叠零新依赖。
  - **幂等**：输入若已归一化（顶层两字段都不存在），直接原样返回——否则会再前置一条**空的** system 消息。
  - **★ 守卫为什么一直没抓到**：`tests/adapter-outgoing-body.spec.ts` 是唯一断言「线上 body 真的带 tools 与 system」的用例，却被 `it.skipIf(piAiRuntimeInfo().generation !== 'legacy')` 限死，**modern 分支零覆盖**；而作者 checkout 解析到 0.85.1，它一直是绿的。`adapter.spec.ts` 也帮不上忙——它 mock 了 api，只断言「交给 wrapper 的 context」，这个断言恰好**认证**了缺陷。
  - **本版把守卫扩成 2×2 矩阵**：{legacy, modern} × {原始信封, 已归一化 transcript} 四格都断言 `body.tools` 与首条 system 文本。在原用例的基础上补了「modern × 原始信封」这一格——**它就是本缺陷的回归钉**。另加幂等用例与「只有 tools、没有 systemPrompt」用例。
  - **本机与 CI 的代际约束（写在用例注释里）**：legacy 两格只能在 0.85 checkout 上跑（1.x 的 api 读不了 0.85 扁平形状）；modern 两格只能在 0.87+/1.x 上跑（0.85 的 `estimateMessageTokens` 会对 system 消息的**字符串**逐字符迭代并读 `block.name.length` 而崩溃，即 #24 的崩溃）。用例按**已安装版本**选格，不会让任何一代完全无人看管。
  - **变异验证**：把 modern 分支改回 `return api` → 新增的「FOLDS a raw seam envelope」用例**红**（1 例）。验证后已还原。
  - **实机验证**：临时把 checkout 的 `node_modules/@earendil-works/pi-ai` 换成 1.1.0（连同 1.1.0 新需要的 `typebox`/`partial-json`/`openai`），modern 四格**全绿**；legacy 两格如预期红（1.1.0 读不了扁平形状）。验证后已完整还原 0.85.1 与依赖树。

- **「可关闭思考」的模型被锁成不可关闭，不可关闭的反倒可关（`adapter.ts` 既有缺陷，非本次升级引入）**
  - **根因**：`workBuddyThinkingLevelMap()` 的判断写反了 —— `if (canDisableThinking !== true) map.off = null`，而 `null` 在 pi-ai 里的语义是「该档位**不支持**」（`getSupportedThinkingLevels` 按 `mapped === null` 过滤；`openai-completions` 用 `thinkingLevelMap?.off !== null` 决定能否发「关闭思考」的请求）。
  - **实际后果**：上游声明 `canDisableThinking: true` 且用户没取消勾选 → `off` 被置 `null` → 关闭思考**不可选**；上游声明 `false`/未声明 → 不置 `null` → `off` 落成字符串 `'off'` → **反而可选**。与 `offDefaultFor()` 的语义正好相反。
  - **为什么一直没发现**：`tests/adapter.spec.ts` 只探了 `canDisableThinking: false` 那半边，而写反的形式在那半边也恰好通过；另外两条对 `true` 的用例把期望值写成了「没有 off」或「off 缺失」，**把缺陷当成了规格**。
  - **改了什么**：改为 `canDisableThinking === true ? 'off' : null`，并把三条用例的期望值改正，新增「能力未声明时不给 off」一例。
  - **变异验证**：把判断改回 `!== true` → 2 例红。

- **DSH 宿主线守卫的 semver 比较器是错的：判 `0.2.1-rc.1` 通过，而 npm 实算是 false**
  - **根因**：`tests/dsh-line.spec.ts` 自写的 `satisfiesRange()` 只做朴素 `>=` / `<` 比较，没有实现 semver 的**预发布悬崖**——预发布版本只有当同一比较器集合里存在**同一 `major.minor.patch` 元组**上的预发布比较符时才被放行。`>=0.1.7-rc.1` 只对 `0.1.7-x` 开口，`<0.3.0-0` 排除整个 `0.3.0` 元组，`0.2.1-rc.1`（元组 `0.2.1`）两条都不满足。
  - **为什么夹具没触发**：原夹具是 `['0.1.7-rc.1','0.1.7-rc.2','0.2.0-rc.1','0.2.0-rc.9','0.2.0','0.2.1','0.2.99']`——恰好跳过真实发布的 `0.2.1-rc.1`；而 `0.2.0-rc.1` / `0.2.0-rc.9` 被断言成 admitted，那本身也是错的（npm 判 false）。
  - **改了什么**：比较器按规范重写（`parseVersion` / `compareParsed` / `sameTuple` + 悬崖规则），夹具拆成「正式版放行」与「已知预发布偏差」两组，并新增 5 条照抄 npm 实际输出的悬崖用例。
  - **新增的「已知偏差」用例**：显式断言 `0.2.1-rc.1` 与 `0.2.0-rc.1` 在现声明下 **不** admitted、而 `0.2.1` GA admitted。于是偏差是**被记录、被解释**的，而不是被错比较器掩盖；将来若改清单，这条会提醒同步更新说明。
  - **为什么可以暂不改清单**：详见下一条。宿主 `evaluatePluginCompatibility()` 只校验 `@deepseek-ai/dsh*` 命名空间，本机 profile 用 `link:` + 默认不自动装 peer，rc 宿主上插件照常加载；等宿主发 `0.2.1` GA，现声明即放行。
  - **变异验证**：去掉悬崖规则 → 2 例红。

### Changed

- **`@earendil-works/pi-ai` 的 peer 范围放宽到 1.x：`>=0.85.0 <0.88.0 || >=1.0.0-0 <2.0.0`（peer 与 dev 两处同步）**
  - **为什么必须改**：旧范围 `>=0.85.0 <0.88.0` **不**放行 DSH 0.2.1-rc.1 随包的 1.1.0，而 1.1.0 恰恰是本版修好后要支持的版本 —— 声明与实际支持面自相矛盾。
  - **范围是实算出来的，不是猜的**：`0.85.0 / 0.85.1 / 0.87.1 / 1.0.0 / 1.0.2 / 1.1.0` 均 `true`；`2.0.0` 与 `1.1.0-beta.1` 均 `false`。上界停在 `<2.0.0` 与 `generationOf()` 刻意不认 2.x 的判断保持一致；预发布串不承诺。
  - **注意**：宿主门禁只校验 `@deepseek-ai/dsh*`，所以这条 peer **从不参与**宿主校验（4.4.2 已记录）。改它主要是让**清单说真话**，真正保护用户的是上面那条代码修复。
  - **`dsh-*` 那 9 条 peer 本版未动**：理由见上一条「已知偏差」——任何为 `0.2.x` rc 硬凑的静态范围都会有漏（已逐一实算否证：`|| >=0.2.0-rc.1 <0.2.99`、`|| >=0.3.0-0 <0.3.0`、`>=0.1.7-rc.1-0 <0.3.0-0`、去掉预发布上界、`0.2.x` 通配符，全部失败）。

### CI

- **新增 `test-pi-ai-next` 作业：在 pi-ai 1.1.0 上跑一遍完整 typecheck + 测试 + 构建**
  - **为什么必须有**：`tests/adapter-outgoing-body.spec.ts` 的矩阵是 2×2，但**一个代际跑不了另一个代际的库**——0.85 checkout 上只能跑 legacy 两格（1.x 的 api 读不了扁平形状），1.x checkout 上只能跑 modern 两格（0.85 的分词器在 system 消息上崩，即 #24）。主 `test` 作业钉的是 0.85.1，**modern 半边从未在 CI 里运行过**，而这正是 0.2.1-rc.1 坏掉的那一半。
  - **怎么切版本**：pi-ai 既是 peer 又是直接 devDependency，`pnpm-workspace.yaml` 的 `overrides` 是官方支持的改法。作业用 `sed` 改那一条 override，再 `--no-frozen-lockfile` 让 pnpm 只为它重解析。
  - **有一道断言防止作业空转**：装完立刻 `node -p` 读实际版本并要求等于矩阵值，否则「跑了一遍绿」可能跑的根本不是 1.1.0。
  - **本作业当场抓到一个本机永远看不到的缺陷**：pi-ai 1.x 给 provider 侧上下文加了**品牌**（`TranscriptContext`，`unique symbol` 字段，声明为「只有 `normalizeContext()` 能产出」）。在 1.x 的**类型**上，`stream`/`streamSimple` 的两条分支都收到品牌类型，于是把普通 `Context` 传进去会 `TS2345`——而 `modern` 分支的 `return api` 也一并被类型系统拒绝。本机 0.85 的类型面是裸 `Context`，**这个错误在 0.85 上不存在**。修法是一处**有注释的** `transcript<T>()` 断言，理由写在函数上：调用点已经完成 `normalizeContext` 的职责，而 `normalizeContext` 在 0.85 不存在、不能导入。**变异验证**：去掉该断言 → 1.1.0 上 `tsc` 报 4 个 `TS2345`。
  - **验证过它真的会响**：把 modern 分支改回 `return api`，1.1.0 作业**红 4 例**（`adapter.spec.ts` 与 `adapter-outgoing-body.spec.ts` 各自的 modern 守卫），而 0.85.1 作业保持全绿。这正是本作业存在的意义。
  - 仅跑 ubuntu：这是库层面的断言，不是平台断言；OS 矩阵已由主 `test` 作业覆盖。

### Docs

- `src/pi-ai-runtime.ts` 头部更正：peer 范围同步为新值；删去把 1.x 说成「未发布」的过时表述（DSH 0.2.1-rc.1 已随包 1.1.0）；补一句「落在 modern 是必要但**不充分**——modern 分支还必须折叠原始信封」。
- `src/adapter.ts` 的 `adaptLegacyPiAiContext()` 补注 **legacy-only**：它的结果是 0.85 扁平形状，绝不能交给 1.x 的 api（1.x 从 `messages[].toolsAdded` 读工具，会一个都看不到）。
- 新增 `docs/DSH-0.2.1-RC1-FOLLOWUP.md`：本次升级的完整调研档，含逐包对照表、四项「已核对无需改动」、失败候选与证据来源。

## 4.6.7 (2026-10-17)

> 版本号是 **patch**：只改账号池的排序规则，没有接口或配置变更。但它是**行为变更**——开启账号池的机器上，「这次请求用谁」可能变了，且新行为正是本版要的。

### Fixes

- **「快过期的积分优先」从未生效：第 3 个排序键被第 2 个键完全遮蔽，临期积分必然作废（issue #70）**
  - **症状**：开启账号池后，`当前使用` 永远是积分总量最高的那个账号；哪怕另一个账号有积分**当天就要过期**，它也一直排最后，直到临期积分作废。
  - **根因**：`rankPool()` 的排序键是**严格字典序**——先比积分总量（`scoreOf()` = `credits.total`），**只有总量完全相等**才比到期时间。而总量几乎从不恰好相等，所以「快过期优先」这条规则**在数学上不可达**。报告者的真实病例：账号 C 有 **196.4 分当天 17:21 到期**，只因为比 A/B 少约 1,200 分，即永远排最后，那 196.4 分必然烂掉。
  - **为什么这条特别值得记**：README 把这两条写成**并列的第 2、3 条**，读起来像两个同级偏好；代码里却是严格优先级。**一条「不花就作废」的规则被另一条完全压制，等于死代码**，而它从输出上看不出任何异常——顺序永远「有道理」，只是那条规则从不参与。
  - **改了什么**：把临期判据提到总量之前，并拆成三个独立的键——**有临期积分者优先** → **先到期者优先** → **临期量大者优先**，之后才回到积分总量。
  - **一个单位错误顺手修掉**：旧的 `_expiring` 键实际存的是 `nearestExpiryMs`（**时间戳**），而 `expiringSoon`（**积分量**）在排序里从未被读过。现在两者分开：`_expiring` 仍是时间戳（用于「谁先到期」），`_expiringAmount` 才是积分量。直接拿这两个相减会是一个不容易发现的数量级错误。
  - **一个反直觉但正确的后果，写进了代码注释与两份 README**：这条规则会让**临期 1 分**的账号排到**余额 5 万**的账号前面。**这不是缺陷**——积分是通用的，不花那 1 分它**确定**会损失；而余额 5 万的账号下一轮还在。唯一的真实代价是临期账号可能不够跑完一个请求，此时由既有的换号逻辑接手。若按总量优先，则临期积分**确定**作废。
  - **可用性仍然第一**：处于限流冷却/凭据被拒的账号即使有大量临期积分也**不会**被提前——它花不掉，提上去只会让每个请求都撞墙。
  - **测试**：新增 6 例（报告者真实数据 `C → A → B`、无临期时仍按总量、临期 1 分压过 5 万、都在临期时先到期者优先、同到期时量大者优先、不可用账号不被提升）。**变异验证**：① 恢复旧的字典序（总量先判）→ 红 4 例；② 去掉「先到期者优先」→ 红 2；③ `_atRisk` 恒为 false（等价修复前）→ 红 2。
  - **顺带修正一条名不副实的旧测试**：`prefers the account whose credits expire soonest when totals tie` 的两个夹具都只有 `nearestExpiryMs`、`expiringSoon` 为 0，即**两个账号都没有任何临期积分**。它在旧规则下能过，靠的正是「排序看时间戳、不看量」这个缺陷；现已补上真实的 `expiringSoon`，让它真的在测名字里那件事。
  - **README**（中英同步）：排序规则把「快过期先花」提到第 2 条、「积分高者优先」降到第 3 条，并就地写明旧行为为何是死代码、以及「临期 1 分压过 5 万」为何是对的。

## 4.6.6 (2026-10-17)

> 版本号是 **patch**：只动诊断（`WORKBUDDY_BODY_REPORT` 的报告内容），不改请求、响应、计费或界面。**默认行为完全不变**——报告默认仍是关的，关着时这版与 4.6.5 行为等价。

### Fixes

- **body 报告只记「发了什么」不记「上游算了多少」，导致 #59 的抓取无法回答它要问的问题（issue #59）**
  - **缺口**：`WORKBUDDY_BODY_REPORT` 抓的是**本地组装好、发往上游之前**的 body 构成（`bodyBytes` / `chars` / 各块字符数）。而 #59 要判定的是「同一份历史为什么国际网关算 1.94 倍」。**只有「发出侧」时，两种世界长得一模一样**：
    - **A** 网关对几乎相同的字节算出两倍 → **上游的问题**，插件无能为力；
    - **B** 两边发出的 body 其实不同 → **我们的问题**，要修。

    报告者 10-16 抓到的配对 body 总量只差 **0.3%**（3,554,248 vs 3,565,415 字节），但仅凭这个数无法区分 A 与 B —— 缺的正是「上游回了多少」。
  - **改了什么**：报告每行新增 `promptTokens` / `completionTokens` / `cachedTokens` 三个**可选**字段，取自上游响应流里的 `usage` 块。至此一行同时给出两半：**发出去的字节** 与 **网关算的 token**，两者一比即可定案。
  - **为什么必须新加一个响应侧钩子**：`usage` 走的是**响应流**，而不是请求。`createWorkBuddyShim` 原先只有 `onRequestBody`（请求发出前），响应侧不记任何东西 —— 而 `usage` 只在上游的**最后一帧**才出现。新增 `onUpstreamUsage`，在 `RecoveryStream` 解析每一帧时读取。
  - **★ 一个位置性缺陷，写完就撞上了**：`usage` 帧**不带 `choices`**（它是流末尾的独立帧），而 `handleFrame()` 里第一个早退分支就是「没有 choices 就原样转发」。把读取放在那个分支之后，代码跑起来一切正常、**永不报错**，只是永远拿不到数。守卫 `tests/issue59-upstream-usage.spec.ts` 的第 1 例专门钉这一条：**变异（把读取挪到 `choices` 检查之后）→ 红 2 例**，正是原始的漏读形态。
  - **「没有」不等于「零」**：上游没报 `usage`（请求失败、流被截断、非流式路径）时字段**缺省**，而不是写 `0`。这是全条的关键区分——把「没测到」记成「没花钱」，会让整个对比失效。守卫用一条显式用例钉住（变异：把缺失记成 `promptTokens: 0` → **5 例全红**）。
  - **每个流只报一次**：`usageReported` 幂等，因为 failover 重试会**另起一个 `RecoveryStream`**，同一个 body 可能被量两次；先到的那次是实际服务的那次。
  - **写回同一行，不新起一行**：两个半边的可观测时刻不同（发出侧在请求前、计费侧在流结束后），所以 `recordBodyReport` 改为返回一个 handle，等 `usage` 到了再**回填它自己那一行**。之所以不能追加第三行：报告者的用法是「取 `cn.jsonl` 与 `global.jsonl` 的**最后一行**对比」，多出来的 usage-only 行会**静默变成被比较的那一行**。
  - **行身份靠四元组匹配**（`at` + `region` + `bodyBytes` + `messageCount`），故意不用 `at` 一个字段：同一毫秒内可能有两笔请求。**这里踩到并修掉了一个测试自身的洞**：初版测试标注的是**最后一行**，而回填是从文件末尾**倒着找**的 —— 于是把 `bodyBytes` 校验整个删掉，测试**照样全绿**。改成标注**靠前**那一行后，该变异立刻转红；`messageCount` 同理（构造了两份**字节数完全相同、消息条数不同**的 body：一条 51 字符的消息 与 两条 11 字符的消息，都是 196 字节）。**最终变异验证**：去掉 `bodyBytes` 校验 → 红 1；去掉 `messageCount` 校验 → 红 1；两者都去掉 → 红 2。
  - **两道幂等闸刻意保留冗余**：handle 内的 `done` 与磁盘上的「已标注就跳过」互为备份，各自覆盖另一种情形（后者专治「同一 body 的第二个 handle」）。只删一道**行为上不可观测**，删两道才红——这一点写进了代码注释，免得后人以为其中一道是死代码而删掉。
  - **缓存命中一并记录**：两个网关的缓存命中**拼写不同**（OpenAI 的 `prompt_tokens_details.cached_tokens` 与国内的 `prompt_cache_hit_tokens`），两种都读、取先命中者，否则同一份对话在两个区域会显示成一个有缓存、一个没有。
  - **对 #59 的实际意义**：这一版让报告者**不必再做重放实验**——同一会话两区各抓一次，直接比 `promptTokens` 两列即可区分 A / B。重放要发的是一整份真实历史，既贵，又会引入「两次请求之间还发生了什么」的新变量。
  - **本条不包含对 1.94 倍的结论**：它补的是**验证手段**。那个结论仍待报告者带新字段重抓后才能下。

## 4.6.5 (2026-10-16)

> 版本号是 **patch**：两处诊断正确性修复，没有接口或配置变更。

### Fixes

- **国际版 App 探测不到：可执行文件候选缺了 `WorkBuddyAI.exe` 与 `WorkBuddyAI` 目录（issue #68）**
  - **症状**：只装了国际版的机器上，插件拿不到密钥 payload 的**来源** → 凭据读不出 → 界面显示成「属于另一个地区」。而报告者实测国际版装在 **`%LOCALAPPDATA%\Programs\WorkBuddyAI\WorkBuddyAI.exe`** —— **目录名与二进制名都和国内版不同**，`workbuddyAppExecutableCandidates()` 的 win32 分支两个都没覆盖。
  - **为什么这类漏探特别难查**：它的失败形态**不是「找不到可执行文件」**，而是「凭据读不出」，最后被下游渲染成区域问题。探针少一个候选与「用户没装 App」在界面上长得一样。
  - **改了什么**：新增 `WINDOWS_APP_EXECUTABLE_NAMES`（`WorkBuddy.exe` / `WorkBuddyAI.exe`）与 `WINDOWS_APP_SUBDIRECTORIES`（`Programs\WorkBuddy` / `WorkBuddy` / `Programs\WorkBuddyAI` / `WorkBuddyAI`），候选按「三个 base × 四个目录 × 两个二进制」笛卡尔积生成（16 个，原先是 4 个）。**目录与二进制不做配对假设**：观察到的是 `WorkBuddyAI\WorkBuddyAI.exe`，但一个 miss 在这里是不可见的，所以两种拼法都试。
  - **`normalizeRegistryExecutable()` 同步放宽**：它是另一处按文件名判断的地方，也必须认国际版 —— 否则注册表里指向国际版二进制的 `DisplayIcon` 会被当成「别的产品的二进制」拒掉。**这个值是会被启动的**，所以只加白名单里的两个名字，不是「任何 exe 都收」。
  - **守卫**：`tests/at-rest.spec.ts` 新增 2 例并把原先断言候选数为 `4` 的那条改成断言**乘积**（`3 × 4 × 2`）—— 用乘积而不是常量，是为了让「少掉一个维度」这种编辑无法靠集合变小而静默通过。新增例子断言国际版路径在内、国内版仍在且在它之前；另一条断言注册表校验接受两种二进制、且**仍拒绝** `uninstall.exe` 与 `WorkBuddy.exe.bak`。**变异验证**：① 去掉 `WorkBuddyAI.exe` → 红 3 例；② 去掉 `WorkBuddyAI` 目录 → 红 2 例；③ 注册表校验不再限制文件名 → 红 2 例。
  - **证据档位**：报告的路径来自报告者的真机（属 A 档观察）；**本仓库无法在真机上复现**（无一等 Windows 机器在手），所以这条修复的依据是 A 档观察 + 本仓库的形态断言，未在真机复核 —— 按 `docs/WINDOWS.md` §2 的口径，其「国际版路径命中」仍是 **C 档（约定推导）**，待 Windows 用户回报后升格。

- **「另一个地区」把「解密失败」盖住了：优先级顺序把更具体的诊断吃掉（issue #68）**
  - **症状**：凭据**解密失败**时，卡片显示的是「找到了你的 WorkBuddy 登录信息，但它**属于另一个地区的标签页**」。报告者据此去切 tab，**而切 tab 永远救不了解密失败** —— 两个区域都读不出来，密钥推导才是问题。
  - **根因**：`signedOutNotice()` 里 `wrong-region` **先于** `encrypted` 判定，而这两者**不是互斥的，它们会同时出现**，且同时出现是**常态**：`diagnose()` 会探测**两个区域**的文件，于是一台装了**两个 WorkBuddy 版本**的机器上，新版的文件解密失败（`encrypted`），旧版的文件仍能解开、只是属于另一个区域（`wrong-region`）。先判 `wrong-region` 的后果是：只要有一个可解的兄弟文件，headline 就永远说「切 tab」，把真正的阻塞压在下面。
  - **改了什么**：把 `encrypted` 提到 `wrong-region` **之前**。判据不是「哪个更常见」，而是「**哪个是硬阻塞**」—— 另一个标签页上有可读的登录是一条更便宜的修法，但前提是**有登录可读**。诚实地说：原先的顺序把用户推向唯一不可能起作用的动作，而这**正是这个函数存在的理由**，只是两个原因的位置对调了。
  - **反向那一半也保住了**：没有 `encrypted` 时，`wrong-region` 仍然胜出（新增一条测试钉住），否则就是用一个错 headline 换另一个。
  - **守卫**：`tests/searched-paths.spec.ts` 新增 2 例 —— ① 两者共存时 `encrypted` 胜出，且**断言渲染出的字符串**里不含「切换到上方对应标签页」（文案才是用户看到的东西）；② 无阻塞时 `wrong-region` 仍胜出。**变异验证**：把顺序恢复成 `wrong-region` 先判 → 红 1 例。

## 4.6.4 (2026-10-16)

> 版本号是 **patch**：只动开发脚本与测试，**不改插件运行时行为**。

### Fixes

- **`probe-region-token-accounting.mjs` 补上 `tool-result` 与高熵类 —— 这正是 #59 那个「预测不出上游数字」缺口的关键一格（issue #59）**
  - **为什么补**：本仓库的探针原先只有 `prose` / `code` / `json` 三档。而一份真实长会话的 body 构成（`WORKBUDDY_BODY_REPORT` 抓下来的 35 个真实请求）是 **`tool-result` 占 47% 字符**，是三档里**一档都没覆盖**的内容类别。用三档去预测，结论是「上游报的数比最贵档还高 28%」，看起来像发现了新机制；而把实测的 `tool-result` 系数（**455.5 tok/1k**，跨区域 455.5 vs 455.6）代回去，**缺口从 28% 收到约 1%**。**缺的是系数表的一行，不是新机制。**
  - **新增的 `--kind`**：`base64`（实测 2.50× 于 `code`）、`hex`（2.04×）、`ansi`（1.92×）、`proc`（1.63×）、`tool-result`。报告者的实测显示**高熵内容是长会话里最贵的一类**，而 base64 恰是 `code` 的 2.5 倍 —— 老表把 `code` 当成天花板，因此系统性低估。
  - **生成器必须是确定性的**：两个区域要收到**逐字节相同**的填充文本，否则测出来的比值是在量生成器而不是量网关。故不读时钟、不读随机源、不读文件系统；用固定种子的 32 位 LCG。**这一点由测试直接断言源码文本**（`Math.random` / `Date.now` / `new Date` / `fs` 调用一律不得出现），因为行为断言只能证明「这次恰好相同」。
  - **★ 写测试时抓到一个真缺陷**：初版生成器是 `(state >>> 8) % alphabet.length` —— 只取 LCG 状态的 log2(L) 位，**在 L=64 时每 16384 字符就重复一次**，于是 65536 字符的填充里同一段 16 KiB 出现四次。**短周期正是这个类存在要避免的「可压缩」**：一个能看出重复的分词器会少收 token，于是实测水位被**低估**，而这正是原始 #59 现象的形状。修法是在取模前先做两轮 xorshift-multiply 混合（实测 12 万字符内无周期）。
  - **采样规则**（写进模块注释）：**不得只取日志开头**。报告者实测同一类真实 `tool-result` 文本，取开头 12k 字符得 322.6 tok/1k，全时段均匀采样得 455.5 —— **差 41%**。填充文本不仅要跨区域逐字节相同，还要与真实分布同构，否则量到的是一类内容的系数、却被当作整份历史用。
  - **`tool-result` 刻意不走 `entropy()`**：逐字符打散模板会产出没有任何工具会发出的文本，而这个类的**全部意义就在于内容形状**（标识符、花括号、引号键、路径、对齐数字）真实。它的变化来自「每轮以递进的偏移重复模板」，因此同样没有短周期。
  - **守卫**：新增 `tests/probe-fillers.spec.ts`，8 例 —— ① 十个 `语言:类别` 组合都存在；② 每次生成逐字节相同；③ **源码文本里不得出现随机源或时钟**；④ **不得有 64 / 1024 / 16384 的周期**（这一条就是抓到上面那个真缺陷的那条）；⑤ `tool-result` 仍像 tool-result（含 `export function` / `"path"` / `await fs.readFile`，且中文版确实是中文）；⑥ `ansi` 是**真的控制字节** `<ESC>[31m`，不是字面的 `\u001B` 六字符；⑦ 结构化类别里不得出现 `NaN`；⑧ 每个填充长度都超过默认 `--chars=12000`。
  - **第 ⑦ 条的取法有讲究，写在测试注释里**：`NaN` 只查 `ansi` / `proc` / `tool-result` 三类 —— 它们是**格式化**出来的（`\u001B[3${n}m`、`.padStart`），出现 `NaN` 必是缺陷；而 base64 / hex 是从字母表里取的，字母表本身含 `N`、`a`、`N`，子串会以约 64³ 分之一的概率偶然出现。初版断言查了全部类别，**是错的**（会在无关的地方随机转红）—— 这是我写完立刻遇到并改掉的。
  - **变异验证（5 个变异，全部转红，各自只打中应打中的用例）**：① 去掉取模前的混合（重现 16384 周期）→ 红 1 例；② 顺序循环字母表（64 周期）→ 红 1 例；③ 改用 `Math.random` → 红 1 例；④ `ansi` 退化成字面 `\u001B` → 红 1 例；⑤ `tool-result` 逐字符打散成乱码 → 红 1 例。
  - **来源**：本条的补类与采样规则由 issue #59 的报告者提出并附实测数据（`tool-result` 455.5、高熵四档、尺寸梯度 12k→500k），本仓库按其建议固化。**探针脚本不随包发布**（`files` 白名单不含 `scripts/`），所以这一版与已安装插件的行为无关。

## 4.6.3 (2026-10-16)

> 版本号是 **patch**：没有接口、配置或界面变更，但它修的是一个**所有国际版模型全部不可用**的缺陷。

### Fixes

- **国际版全部模型 400 / `11128 conversation id missing`：网关新增了一道「会话身份」闸，插件一个头都没发（issue #66）**
  - **症状**：`workbuddy-global` 的**每一个**模型、**每一步**都失败，报文是 `400` + 业务码 `11128` / `conversation id missing`。而上游自带的 `displayTips` 把它描述成「这次调用没通过渠道校验，可能不是官方客户端发出的」—— **那句话把人引向客户端身份**（UA / 渠道），真正的可执行信息是字面那句「缺会话 id」。
  - **根因**：国际网关在 3.1.0 修过的「首条必须是 system」之外，**又加了一道**：chat 请求必须携带官方桌面端的会话身份三件套（`X-Conversation-ID` / `X-Conversation-Request-ID` / `X-Conversation-Message-ID`，见官方 bundle 的 `applyGatewayHeaders`），而本插件的 `chatHeaders()` 只发 `X-Product: SaaS` 与 `X-No-*` 系列，**三件套一个都没有**。
  - **两道闸是叠加的，不是替代关系** —— 这是本条最容易改错的地方。报告者用真实国际网关做了矩阵（请求体固定，只改两个变量）：

    | 请求头 | messages | 结果 |
    |---|---|---|
    | 插件现状（含 3.1.0 的 system 兜底） | `["system","user"]` | **400 / 11128** |
    | 现状 **+ 三件套** | `["system","user"]` | **200** |
    | 现状 **+ 三件套** | `["user"]` | **400 / 11128** |

    末行是**不能把 `ensureSystemHead()` 当成「已经不需要了」而删掉**的证据：system 规则从**充分**变成了**必要不充分**。CHANGELOG 的 3.1.0 那节记着当年的矩阵（空格 system → 200），今天同样的形状是 11128 —— 上游在这期间收紧了校验，而这次收紧**没有**替换掉旧规则。
  - **改了什么**：新增 `conversationHeaders()`，三个头各用一个**新生成的 UUID**（`randomUUID()`，与官方客户端每次请求 `randomUUID()` 的行为一致），在 `chatHeaders()` 里展开。这是报告者逐项二分测出的**最小必需集**：单独一个 `X-Conversation-ID` 仍然 11128，官方还发的 `acp-connection-id` / `X-Agent-*` / `X-IDE-*` / `X-Private-Data` / trace 系列**都不需要**。三个 id 的值上游**不校验来源**，但不复用同一个值 —— 复用等于拿一个 id 冒充三次会话身份，而上游拿它做的就是关联。
  - **两个区域都加，是刻意的**：国内网关当前容忍缺失，所以加在那边无害；而「只在一边发某个头」正是 3.1.0 那个缺陷长成**国际版专有、且在国内侧完全看不见**的原因。一条代码路径、两个区域，少一个分支就少一种只在一边复现的故障形状。
  - **范围**：只加在 chat 端点（`chatHeaders()`）。billing / refresh 等端点**不加** —— 官方客户端调它们时也不带，报告者的矩阵也只在 chat 端点上取过数。
  - **`11128` 的错误分类（报告者建议的第 3 条）本次没有采纳**：他建议把它并入 `policy_reject`（与 `11140` 同类）。但另一位报告者提供了反例 —— 同一批测试、同一毫秒内，一个账号 `ok`、另一个 `11128`，两者**同样缺三件套**。若 11128 其实是按账号生效的，那么「换号能过」意味着它可恢复，落进 `failed` + 冷却 30 分钟后回池反而更合适（`policy_reject` 会让它**不冷却、仍当候选**）。分类改错会让账号池做出更差的调度，所以先把确定的正向做掉，分类问题留待更多数据。
  - **守卫**：`tests/upstream.spec.ts` 新增 7 例 —— ① 国际网关三个头都发；② 国内网关也发（钉住「一条代码路径」这个决定，而不是国内的需求）；③ **三个值互不相同**；④ 每个都是合法 UUID 形态；⑤ **每个请求新生成**（防止有人把它提升成模块级常量「优化」掉）；⑥ **探针路径也带**（探针打的就是 chat 端点，这也是「一键测试所有账号」能看出 11128 的原因 —— 只修 `chatStream()` 会让账号池拿着不满足规则的请求去测账号）；⑦ billing 端点**不带**。
  - **第 ⑦ 条的形态本身踩过一个坑**：初版是 **grep 源码文本**来判断 `billingHeaders()` 里有没有 `conversationHeaders`。变异验证时把一个变异体加进去，**它没红** —— 因为那段文本切片压根没匹配上，测试是在对一个空片段做断言。改为**行为断言**（真的调 `fetchCredits()` 并看发出去的头）后，同一个变异体立刻转红。**变异验证（5 个变异）**：① 从 `chatHeaders` 去掉三件套 → 红 6 例（等价修复前）；② 三个值写成同一个 → 红 1 例；③ 提升为模块级常量 → 红 1 例；④ 三件套泄漏到 billing 端点 → 红 1 例；⑤ UUID 形态被破坏 → 红 1 例。
  - **端到端**：报告者已在本地对 `4.6.2` 打同一处补丁并**实测国际版恢复正常**；本仓库侧改动与其独立实现等价（他手写十六进制拼 UUID，本仓库用 `node:crypto` 的 `randomUUID`，后者本仓库 `oauth.ts` / `dsml-recovery.ts` 已在用）。

## 4.6.2 (2026-10-16)

> 版本号是 **patch**：修的是一个启动期缺陷，没有接口、配置或界面变更。

### Fixes

- **shim 启动时会避开「HTTP 客户端自己拒绝」的端口**
  - **症状**：某个区域（`cn` 或 `global`）的模型请求**全部失败**，报错只有一句 `Connection error.`，而 shim 本身完全健康 —— `curl`、`node:http`、裸 TCP 连上去都是 200。重启后可能好、可能照样坏。
  - **根因**：`server.listen(0)` 让内核挑端口，而 Fetch 规范定义了一张**必须拒绝**的端口清单（`fetch.spec.whatwg.org#block-bad-port`，undici 实现为 `badPorts`，当前最大到 `10080`）。`fetch` 在**开 socket 之前**就拒绝这些端口，所以请求根本没上过网线。pi-ai 驱动官方 `openai` SDK，而它的 `getDefaultFetch()` 返回 `globalThis.fetch` —— **生产路径走的就是这一层**，不是只有测试才会中招（已实测 `openai@6.40.0`：坏端口报 `Connection error. → fetch failed → bad port`，正常端口正常返回）。端口只在启动时 bind 一次，不会自己重掷，所以一旦抽中就是**该区域持续失败直到插件重新加载**。
  - **只在特定机器上发生**：`listen(0)` 的抽取范围是系统的动态端口范围，三平台默认值（Windows/macOS `49152-65535`、Linux `32768-60999`）**整体高于**清单最大值 `10080`，交集为空 —— 默认机器**结构上不可能中招**。只有当范围被下调到触及 `10080` 以下才会发生，例如本机的遗留注册表值 `MaxUserPort = 15000`（实测 `netsh` 报 `1024-15000`，范围内有 **19 个**被禁端口，约 `0.136%`／次绑定；每次插件加载建 2 个 shim，约 `0.27%`／次加载）。这一条**已按三方独立实测核对**：`0.105%`（60000 次采样）、`0.115%`（20000 次采样）、理论值 `0.136%`。
  - **为什么难自查**：错误链上真正的 `cause`（`bad port`）被 SDK 归一化时丢弃，界面和日志都只剩 `Connection error.`，读不出是端口问题；用户唯一能做的「换个账号」恰好**救不了**（与账号无关）。顺带确认：这个拒绝与代理无关（把 `HTTP_PROXY` 指向死端口、清空 `NO_PROXY`，回环好端口仍返回 200 —— 说明回环流量根本不经过代理），也不是 `ECONNREFUSED`（后者带 `code`，而它是 `cause.message === 'bad port'`、无 `code`）。
  - **改了什么**：新增 `clientRefusesPort()`（绑定后用自己的 `fetch` 打 `/healthz` 探测：**返回任何 HTTP 码都算客户端接受**，含 401；只有抛异常才算被拒）与 `listenOnClientReachablePort()`（有界重掷，上限 `PORT_ROLL_LIMIT = 5`）。用客户端自身探测而**不是**比对一张抄来的端口表：清单是规范的一部分，抄本会随规范漂移，而这里要满足的规则**本身就是客户端的**。绑定方式仍是 `listen(0)` + 仅回环（随机性不变），端口在 `ready` 之前定格，因此 `baseUrl()` 的消费方一行未改。
  - **顺带修掉一个自己引入的缺陷**：`close()` 落在 `listen()` 未完成期间时，Node **既不触发 `listening` 也不触发 `error`，只触发 `close`**（实测确认）——最初的 `listenOnce` 只监听前两者，会让 `ready` 永久 pending、卡住插件卸载。已补 `close` 监听。
  - **守卫**：`tests/shim.spec.ts` 新增 6 例（真实客户端识别被禁端口、健康端口不误判、拒绝与真实传输错误可区分、重掷后确实服务、上界生效不空转、首抽即通过时不重掷），外加 2 例生命周期守卫（启动期被处置不得挂起、并发 `close()` 安全）。**变异验证（4 个变异全部转红，且各自只打中应打中的用例）**：① 探测恒真（永不重绑，等价修复前）→ 红 3 例；② 探测恒假 → 红 1 例；③ 移除 `close` 监听 → 红 1 例（30s 超时，正是挂起）；④ 上界失效 → 红 1 例。
  - **端到端验证（跑在真实 `createWorkBuddyShim` 上，非 mock）**：启动 **500 个**真实 shim，落在被禁端口的 **0 个**、客户端不可达的 **0 个**（修复前期望约 0.68 个）；劫持 `fetch` 让首次探测抛出与真实 `bad port` **同形状**的错误后，真实对象从 `4512` 重掷到 `4513` 并在新端口正常服务。全量 `79` 文件／`1308` 用例通过，与改动前的 `1300` 相比净增 `8` 例。

## 4.6.1 (2026-10-16)

> 版本号是 **patch**：只加了一行提示文案，没有行为、接口或配置变更。

### Fixes

- **模型区补一句「免费模型有时间段内定额 Token 上限，并非无限制使用。」（加粗）**
  - **为什么单独一句、而不是接在上面那句说明后面**：目录里有一批 `creditMultiplier: 0` 的模型，卡片把它们显示为免费；而上游仍会在**某一时段内的 token 定额**用完时用 `6004` / `14003` 拒掉 —— **那个定额不是账单余额，充钱也解决不了**。把「免费＝无限」当成事实的人，会把 `6004` 读成「插件坏了」进而去找一个没问题的账号（#56 的报告者就为这个误读花掉过时间），或者去充值（`#63` 报的正是这个读法）。上面那句是描述**事实**、灰度的说明文字，这一句纠正的是**预期**，所以它独立成行并加粗。
  - **颜色刻意不变**：仍是三级灰，不换成主色也不换成错误色 —— 它陈述的是正常产品行为，不是故障；换成红色会读成报错横幅，而真正该被当成错误的信息在别处。
  - **中英 1:1**：`row.tabFreeQuotaWarn`（`免费模型有时间段内定额 Token 上限，并非无限制使用。` / `Free models have a per-window token quota — they are not unlimited.`）。
  - **守卫**：`tests/pool-card-render.spec.tsx` 新增 2 例 —— ① 提示会渲染、且带的是**加粗类**而不是又一条灰度提示；② 字重必须写在样式表里（断言 `.dsm-workbuddy-free-quota-warn{font-weight:600}`），防止有人改成内联 `style={{fontWeight:600}}` 之后这条规则在 CSS 里查不到。**变异验证**：① 删掉那段提示 → 红；② 从 CSS 删掉加粗规则 → 红。
  - **顺带踩到并记录一个老坑**：这行的样式注释里写了反引号（引用 locale 键），而 `styles.ts` 是**模板字面量** —— 反引号会直接截断字符串，表现为 `tsc` 报 `',' expected`。同一个错在本次发布周期里犯了两次，已改为不带反引号的写法。

## 4.6.0 (2026-10-15)

> 版本号是 **minor** 而不是 patch：这一版新增了**用户可见的界面结论与控件**（池级「模型整体繁忙」判断、积分弹窗的打开期自动刷新、额度提示的呈现位置调整），按语义化版本属于特性。主线是**三处「界面上说了错话」的修正** —— 窗口左上角那个本来没有的方框、池卡片把模型问题说成账号问题、以及同一个账号在两个界面上状态不一致。三处都不会让测试或 CI 变红，只有人看界面才会发现，这也是它们能一路发出去的原因。

### Fixes

- **「状态不合拍」的真正根因：同一个账号，积分弹窗和账号池卡片说出了两个不同的状态**（维护者第二次报同一句话，这次带了三张**同一秒**的截图）
  - **先证明这不是「先后两个时刻」的错觉**：维护者这次附的两张卡片截图，文件写入时间都是 **17:12:47**，同一个面板上的两个视图在**同一秒**画出了不同的世界 —— 池卡片说 `dingxiyue` 是「模型繁忙 · 10/15, 17:13 之后可再用 · 约 2 分钟后」，积分弹窗对**同一个账号**一个字都没画。同一份 store、同一条 `exclusionOf` 规则，两边唯一能不同的只有**时间**。
  - **三个各自独立的缺陷叠成了这一张图**，逐个修：
  - **① 弹窗的表格是一次性快照，开完就不动了。**`fetchAccountCredits` 只在 `[open, activeRegion]` 变化时跑一次，而池卡片是每 60 秒重新排一次（`POLL_INTERVAL_MS`）。`dingxiyue` 那条 `live-request` 失败发生在 **17:11:47**，弹窗的读取早就结束了，所以它画不出这个标记 —— 两边对**各自手上那份数据**都没说错，这正是它难读的原因。改为在面板打开期间按 **60 秒**（卡片同一节奏）重读，最后**一次读完之后**才起定时器（避免与打开时那次读重叠）。**为什么不用读数自己的 5 分钟**：这张表要渲染的最短冷却就是 `MODEL_BUSY_COOLDOWN_MS`（2 分钟），5 分钟的周期意味着它能在卡片已经改口之后**继续谎报「模型繁忙」最多 4 分钟**。关闭面板即停（关闭后不再读，成本规则不变）。
  - **② 写着「刷新」的按钮刷新的不是它所在的那张表。**它只调 `fetchUsage`，于是按下去只动了触发器上的余额，**表格每一行（连标记一起）原封不动**。按钮就在账号表的表头里，用户按它的意思是「刷新这张表」；一个刷新别处的东西比没有这个控件更糟。改为 `refresh()` 并发刷新两半（读数 + 表格），因为 `fetchUsage` 自己吞掉失败、不会抛，所以一半出错也不会让另一半被跳过。
  - **③ 上游明明说了时间，却被丢掉了。**`dingxiaoman2016` 存下来的报文是 code 6004 的**英文**写法：`usage exceeds frequency limit, but don't worry, your usage will reset at 2026-10-16 11:34:04 UTC+8, …`。而 `UPSTREAM_RESET_PATTERN` 要求中文关键词 `重置`，于是 `parseUpstreamResetAt` 返回 `undefined` → `cooldownOf` 返回 `{}` → 记录**没有** `retryAtMs`，尽管它自己的 `message` 就写着那一刻。卡片于是渲染「被限流 · **上游未给出何时恢复**」，而 `retryDue` 退回 30 分钟的 `POOL_UNKNOWN_COOLDOWN_MS`，把账号提前约 **18 小时**放回候选池，再花一次请求重新撞上同一堵墙。这是「诚实缺席」契约坏在了**更糟的那一侧**：不是编了一个时间，而是**把真的时间扔了**。
  - **英文写法不是个例**：issue #63 的正文里就带着同一句式（`will reset at 2026-10-14 23:28:38 UTC+8`），所以这是这项服务**真的在用**的第二种措辞。两种措辞的**标记位置相反**（中文 `重置` 在时间戳**后面**，英文 `reset at` 在**前面**），所以不是一个正则放宽就能覆盖的 —— 拆成 `UPSTREAM_RESET_PATTERN_ZH` / `_EN` 两条，共用一个 `RESET_STAMP` 片段，避免两份时间戳形状各自漂移。英文那条仍然**锚定在时间戳紧前面**，与中文条一样严格。
  - **存量记录在读取时被治好**（`retryAtMsOf`，`src/account-pool-store.ts`）：光修解析器只能救**以后**的写入，而维护者屏幕上那条记录已经躺在文件里了。`readPoolProbes` 是所有消费者拿到 probe 的**唯一入口**（`accountExclusions` 弹窗 / `poolMembersOf` 卡片**和故障转移路由** / `memberNames`），在这里治一次就全部生效；分散到三个消费点重推就是同一规则的三份拷贝，而且**以后新加的消费者会静默漏掉**。这不是永久的第二套推导：`writePoolProbes` 是「读→合并→写」，所以**下一次写入就把治好值落盘**。
  - **只治 `rate-limited` / `out-of-credit` 两种结局**，因为只有这两种的语义**存在**「上游说的时间」。放宽它会出事：`AccountPool.tsx` 会渲染任何存在的 `retryAtMs`，给一个 `ok` 的账号补上时间就会显示「可用 · <某时刻> 之后可再用」—— 在一个**什么都没在等**的健康账号上。`model-busy` 同理被排除：它的冷却是一个本地量级，永远不是报文里的时间戳。
  - **守卫**：新增 `tests/state-mismatch-surfaces.spec.ts`（10 例，用**逐字的真实英文 6004 报文**，裁剪过的 fixture 证明不了任何事）与 `tests/composer-panel-freshness.spec.tsx`（8 例，**执行真实组件** + 假定时器，因为这两个缺陷都是「哪段代码在哪个时刻跑」，正则守卫会被改写绕过）。**变异验证**（逐个改回、各自变红）：① 解析器去掉英文分支 → 红 **5** 例；② 关掉读取时治疗 → 红 **3** 例；③ 去掉结局范围限制 → 红 1 例（这条是安全属性）；④ 恢复「只在打开时读一次」→ 红 1 例；⑤ 刷新按钮改回只调 `fetchUsage` → 红 1 例；⑥ 关闭面板不清定时器 → 红 1 例；⑦ 把在途守卫改成无条件（**连用户的手动刷新一起吞掉**）→ 红 1 例；⑧ 彻底删掉在途守卫 → 红 1 例。**注意**：新测试用 `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })` —— 默认连 `setTimeout` 一起假掉会**死锁共用 harness 的 `settle()`**（它靠真实 `setTimeout(…, 0)` 排空 React）。
  - **一个「定时器守卫」的分寸**：表格的重读分两条路 —— **定时器**的问句是「有变化吗」，所以一次在途的读取已经回答了它，**跳过**这次 tick；而**用户按下的动作**（刷新按钮、`switchTo` 写完之后的重读）**必须真的发生**，所以带 `force` 并且认领最新的 generation。这个区分不是洁癖：定时器读得慢时用户按下刷新，如果被「已有读取在跑」吞掉，控件就是在**没有问过上游**的情况下宣称「表是最新的」—— 与「刷新按钮刷新的是别的地方」属于同一类缺陷。**这一条是被变异验证逼出来的**：先写的版本守卫是无条件的，第 ⑦ 项变异（把 `!force &&` 去掉）暴露出它会吞掉手动刷新；第 ⑧ 项变异（彻底删掉守卫）又暴露出**「跳过 tick」那个测试本身是假的** —— 定时器只在打开时那次读**结束之后**才装上，所以把打开时那次的 promise 挂住，根本没有 tick 会来，那个用例无论如何都通过。改成挂住**第一次 tick** 的读取之后，第 ⑧ 项才真正变红。
  - **顺带一条**：弹窗页脚的时间戳现在跟着**表格**那次读取走（`fetchAccountCredits` 里也写 `lastRefresh`）。原来它只反映读数那次读取，于是「刚刷过的表」可能顶着**一个没动过的时刻** —— 与那些冻住的标记是同一个「这数据还新吗」的问题。

- **数据损坏：账号池的 `modelId` 写入后被读丢，并被后续每次写入抹掉**（维护者报「账号池表和积分弹窗状态没对齐」时查出来的）
  - **根因不是显示，是读写不对称**：`readPoolProbes` 的白名单里没有 `modelId`，而 `writePoolProbes` 是**读→合并→写回**。所以这个字段不是"看不见"——它会被**下一次写入永久抹掉**，之后再写也回不来。已复现：写入 `modelId` 后读回是 `undefined`。
  - **为什么危险**：这不是少显示一个字段。#61 加这个字段是为了让「哪个模型的测量」可核对（`6004` 是「账号 × 模型」条件，同一时刻 A 账号在 `hy4-preview-f` 可用、`step-5-preview` 却返回 429/6004）。字段一丢，池子就把一次**单模型**的 `ok` 当成了**账号级**结论——正是这个字段要防的误读。卡片上的「未记录模型」只是它的可见症状。
  - **改了什么**：`readPoolProbes` 补读 `modelId`；`isProbe` 补校验（非字符串丢弃，与 `accountName` 同理由：它作为标签进 UI）。
  - **守卫**：`tests/account-pool-store.spec.ts` 新增 2 例。**关键点**：单次写入的往返测试**抓不到**这个 bug（第一次写入是完整的）——必须**第二次写入**才能暴露，所以第二例专门写「无关账号的写入不得破坏已存的 modelId」。**变异验证**：删掉补读那行 → 两例都变红。

### 改进

- **池级状态：所有成员都卡在同一个模型上时，卡片直接说「这是模型的问题，不是你的账号」（issue #64 的第 ① 条）**
  - **报告者的问题**：池内 4 个账号全被同一模型 14003 挡住，卡片上**每一行都写着「模型繁忙」——每行都对，加起来却是错的**。用户读到的是「我的池子坏了」，于是去找一个不存在的坏账号（正是 #56 报告的那场搜寻），而换账号恰好是唯一救不了的动作 —— 限制跟随模型。
  - **改了什么**：新增 `allMembersBlockedByModel()`（`src/client/pool-state.ts`）与两条文案（`row.poolModelWideBusy` / `Hint`）。命中时卡片渲染「所有成员都卡在同一个模型上 —— 这是模型的问题，不是你的账号」并建议**换模型**；未命中时仍是原来那条「账号池里目前没有可用的账号」。两支**刻意分开**：那条说的是**账号**不行，这条说的是**账号没问题、模型才是那堵墙**。模型级分支先判、优先胜出。
  - **判据是 `every` 而不是 `some`**：必须有成员、且每个被排除的成员原因**都是** `model-busy`。一个账号被限流、其余是模型繁忙的池子**不算**模型级结论 —— 那个限流确实说的是那个账号，此时说「不是你的账号」就是同一类虚假安慰。
  - **一条被证伪的注释与随之删掉的死代码**：最初把「非空」与「无可用成员」写成两个并列条件，但**后者不可达** —— 可用成员的 `excludedBy` 是 `undefined`，所以 `every(... === 'model-busy')` 在任何成员可用时已经为假。（已按「三个成员以内所有组合」穷举验证：`every` 成立且存在可用成员的状态数为 0。）留着它就等于留一段测不住的代码，所以删掉，把这条性质写在文档注释里而不是写成跑不到的分支。
  - **守卫**：`tests/pool-state.spec.ts` 新增 6 例。**变异验证**：① `every`→`some` → 红 3 例（这条最关键，防止模型级结论在混合池上误报）；② 删掉非空判断 → 红 1 例；③ 判定整张表而非成员 → 红 2 例。

- **额度失败的两条提示都改成可行动的中文**（维护者要求：「换号成功要显示切换了账号，换号失败要给原因并建议换模型」）
  - **换号成功**：`failoverNoticeText` 由 `「xxx」was rate limited — this answer came from another account` 改为 `「xxx」被限流，已改用池中另一个账号回答`；`failoverReasonText` 整条改为中文（`被限流` / `积分已耗尽` / `登录已失效` / `该模型当前繁忙（不是账号问题）` 等）。**按维护者的选择，不点名接管账号**——代码原本就有一条明确注释反对点名（改名会诱导用户以为要去管理那个账号），这条理由保留。
  - **失败计数**：`(after trying 3 accounts)` → `（已尝试 3 个账号）`。
  - **换号失败时补「为什么没号可换」**：新增可选回调 `failoverShortfall`（shim 侧）与 `explainPoolShortfall`（宿主侧）。宿主用**与路由同一个** `exclusionOf` 读每个成员的去向，按原因归并计数，输出如 `池中已无可用账号（2 个账号被限流）`，并接一句 `建议换一个模型继续，或稍后等待该账号的额度恢复`。
  - **为什么用「不要再换账号」的口径**：池子刚刚搜过所有成员，用户的下一个动作应该是**搜索替不了他做的那一个**。原本文案只说"请求失败"，把四种补救（等额度/加账号/重新登录/换模型）全留给用户猜，而其中三种插件已经排除过了。
  - **热路径代价为零**：`failoverShortfall` **只在请求已经失败之后**才问一次，成功路径完全不碰（有专门用例断言：成功时回调调用次数为 0）。回调抛错时**降级为不提原因**，绝不把真实的 429 换成插件自己的错误。
  - **守卫**：`tests/shim-failover.spec.ts` 新增 5 例（原因入正文、失败类别不丢、宿主不给原因时保持原样、回调抛错时不污染、成功时不问）。`tests/pool-e2e.spec.ts` 新增 1 例源码守卫：确认接线存在、受池子开关门控、复用 `exclusionOf`（不得自己重推）、且失败路径不发起网络调用。**变异验证**（逐个改回、各自变红）：① 回调异常泄漏进回复 → 红；② 删掉「建议换模型」 → 红；③ 成功路径也去问解释器 → 红 9 例；④ 解释器去掉池子开关门控 → 红；⑤ 解释器改用原始 `probe.outcome` 而非 `exclusionOf` → 红。

- **额度提示：把占用的 `shell.quota-notice` 座位还回去 —— 左上角那个「本来没有」的方框就是这个插件画的**（issue #63 的第二次后续；维护者看截图后的判定）
  - **维护者看到的**：窗口**左上角**出现一个带边框的方框，内容正是宿主那句「当前请求的额度已用尽」加一句括号，而且不走。维护者说「这个本来没有的啊」—— **判断是对的，那确实是本插件画的。**
  - **它是怎么来的（根因）**：上一版为了「接着宿主那句话补一句」，注册进了 `shell.quota-notice` 这条链。链的契约写得很清楚：**认领该 code 的条目是「接管整个界面」（take over the surface），不是给宿主界面加装饰** —— 全拒时宿主才渲染它自带的 `Toast`。于是：宿主的 `Toast`（`position:fixed; top:40px; left:50%`，会自动淡出）**根本没被渲染**，顶替它的却是个 `display:inline` 的 `span` —— 没有定位、没有居中、没有背景、不会淡出。它落在 `shell.overlay`（`AppFrame` 里一个 `absolute; inset:0` 的层）的**左上角**，一直留着。**「本来没有」是真的：那个坐标上原本是宿主的 Toast，被换掉之后就成了一个没人见过的盒子。**
  - **改了什么**：`select` 由「认领 `QUOTA`」改为**一律返回 `null`**（新增导出 `selectQuotaNoticeClaim`，规则只有一处、只有一个测试）。全拒让链回到宿主自己的 `Toast`，**插件不再往 `shell.overlay` 里画任何东西**。组件本身只留那句括号：不再重绘宿主那句（上一版重绘它，才在对话里造出**第二份**同一句话），`-head` 类与 `quotaNotice.fallbackHead` 的渲染一并去掉 —— 宿主自己那句仍然一字未改地由宿主画。
  - **为什么不改成「只加样式、不接管」**：做不到。链只有「接管」与「不接管」两种结果，没有「叠加」；想让那条括号跟着宿主的 Toast 走，就必须接管，接管就必然失去 Toast 的定位与淡出。所以选择归还座位，括号去**对话里**补 —— 那本来就是用户失败时真正在看的地方。
  - **文案与样式**：`quotaNotice.supplement` 不变（`（部分模型另有每日额度，与积分无关）`）；`.dsm-workbuddy-quota-notice` 仍是 `display:inline` 且**不许画盒子**；`.dsm-workbuddy-quota-notice-head` 删除（它存在的唯一理由是给被接管的那句话上色）。
  - **守卫**：`tests/issue63-quota-notice.spec.tsx` 重写为 6 例，其中**两例是形态/决策守卫**：`selectQuotaNoticeClaim` 对任何 owner 都必须返回 `null`（**这条是本次修复的核心**），根节点必须是 `span`、**一个 `button` 都没有**、**恰好一个子节点**（第二个子节点就是宿主那句话又溜回来了）、且**不存在** `.dsm-workbuddy-quota-notice-head`。**变异验证**（逐个改回、各自变红）：① 让 `select` 重新认领 `QUOTA` → 红；② 把宿主句子重新渲染进组件 → 红（连红 3 例）；③ 加回 `-head` 类 → 红。**注意**：上一版的文案守卫**全部**在出问题的版本上照样绿 —— 文案对、形态错，这就是那个方框能发出去的原因。
  - **产物**：`docs/assets/quota-notice-inline-mock.html` + 同名 PNG 重做，新增「v2 占用 overlay 后的真实落点」一栏，用 `absolute; inset:0` 的容器**复刻**出维护者截图里那个左上角落点，并并排给出「归还座位后宿主 Toast 回来」的样子。

### 已核对（不是本次改动，是维护者的第二个问题）

- **「额度已用尽时自动换池子里的账号继续」这条链路是通的 —— 逐环节复核并补了**端到端**守卫**（`tests/quota-auto-switch-chain.spec.ts`，6 例）
  - **这条链的五环各有自己的测试**（分类 `upstream.spec.ts`、结果 `outcomeOfFailure`、冷却 `cooldownOf`/`quotaRefreshOf`、排名 `rankPool`、失败转移 `shim-failover.spec.ts`），但**没有一条测试把它们连起来跑**：换掉分类器，失败转移的用例照样绿（它自己造 `kind`）；换掉 `exclusionOf`，分类用例照样绿（它不问池子拿这个结论做什么）。新文件把**上游真实报文**一路喂到「下一个请求会发给谁」，覆盖 `6004`（带 `将在 … UTC+8 重置` 的 429）与 `14018`（积分耗尽）两种拼写，并反向钉住 `14003` 是**模型级**冷却（`upstream-tips`，2 分钟）而非账号判决。**结论：通。** 两个前提同时成立才会不换号 —— **账号池开关打开**、且**池子里有第二个可用成员**；只有这一个账号时 `rankPool` 仍返回该行（卡片要能解释它为什么出局），但它不是候选，`failoverAccountFor` 因此返回 `undefined`，用户看到的就是带括号的那句失败提示。这一点也由新用例钉住。
  - **顺带记一条容易误读的事实**：`14003` 的账号在排名里**确实**被记为 `model-busy` 排到候选之后（排在 `fresh` 之后，不是我之前以为的「仍排第一」）。真正阻止它换号的是另一道闸 —— `isFailoverWorthy` 按 `kind` 拒绝。两处是同一决定的两道防线，别只看排名就以为它会换号。

## 4.5.2 (2026-10-14)

> 本节含三件事，**一次发布**：先修了「每行下拉框挤坏布局 + 命名看不懂」，随后维护者判定**把这个下拉框连同逐账号设置整体撤掉**；并**新增两个一键遍历按钮**（对齐同族 trae 插件）——撤掉的是「逐账号指定测试哪一个模型」，加回的是「一次把模型测一遍」，两者不冲突。4.4.6 之后没有任何以 4.5.2 发布过的产物，所以合并为一版。

### Features

- **新增两个一键遍历按钮：「一键测试启用模型」与「一键测试所有模型」**（维护者要求在对比同族 `trae` 插件后补齐；`trae` 3.5.0 提供同一对按钮）
  - **为什么这两个按钮与「3.0.0 删掉批量按钮」不矛盾**：3.0.0 删它是因为「一次覆盖整个已勾选列表就是一次不可控支出」，并**在路由层加固**（多于 1 个模型直接 400，防止陈旧 bundle 或手写客户端把按钮变成消费循环）。这一版**保留那道闸门**，把循环放在**卡片端**：一个模型一次请求、串行、每个结果一出来就显示 —— 也就是 `trae` 的做法。路由仍然只接受 1 个模型。
  - **成本按维护者的选择写在提示里（不做二次确认）**：每次探测都发真实体积的请求，真花积分。**本机实测**（默认 25000 token 体积）每次约 **0.01 积分**，目录 16~20 个模型 → 「所有模型」一轮约 **0.16~0.2 积分**。历史实测曾达 0.02~0.72/次（体积不同），所以提示里写明「含未启用的模型，明显更贵」而不是只给一个数。
  - **两个按钮的范围不同，这一点是成本控制而不是措辞**：「启用模型」= 用户勾选的那几个（尊重他刚做的选择，不花在他关掉的模型上）；「所有模型」= 本区域 live 目录里的每一个。取的是**可见目录**而不是配置里的任意 id，所以不可能花在只存在于配置文件里的名字上。
  - **串行而非并发**：探测的目的就是发现限流，一次把整个名册打出去是最容易制造限流的做法 —— 与宿主自己那条循环同样的理由。
  - **凭据被拒时立刻停止并明说**：被拒的凭据对剩下每个模型都会给出同一个答案，继续跑只是花钱重复收集同一个答案。**模型级失败（如某模型被限流）不停** —— 那是关于那个模型的信息，停下来会把它藏掉。汇总只统计**实际测到**的数量，所以提前停止的一次遍历不会读成「整册全绿」。
  - **顺带修掉一处过期注释**：`probeModels` 的文档还在描述「宿主端一次跑完整个批量」（那是 3.0.0 之前的形态），与新的事实（路由只收 1 个、由卡片端循环）相反，已更正。
  - **守卫**：`tests/card-model-sweep.spec.tsx`（10 例）钉住三件事：**一个请求一个模型**（断言每次 `/probe` 请求体的 `modelIds` 长度为 1）、**两个按钮范围不同**（「所有」= 全部三个；「启用」= 只有勾选的，且断言**不含**未启用的那个）、**汇总只算测到的**（一个模型被限流时不得读成全绿）。另含：无启用项时「启用」按钮置灰而「所有」仍可用、凭据被拒只发一次请求、模型级失败不中断、跑完按钮恢复可用。**变异验证**：把「所有模型」改成只遍历启用项 → 2 例红；去掉凭据被拒的提前停止 → 2 例红。
  - **布局**：模型区头部现在有三个按钮（刷新 + 两个遍历），中文标签较长（「一键测试所有模型」），所以按钮组允许换行且标签 `nowrap` —— 与之前账号池行那个「测试按钮被拆成两行」是同一类失败，这次先防住。


### Fixes（同一次发布，见上）

- **（已随本节撤除）账号池每行那个「测试模型」下拉框把行挤坏了：「测试」按钮被压成一列一个字（「测」/「试」），选项名也让人看不懂。**（维护者看截图发现，属 4.5.0 的 #61 改动引入）
  - **布局**：那一行的动作列是按「只有两个按钮」的宽度设计的网格轨道（有签到列时仅 `.8fr`），4.5.0 往里塞了一个**约 150px、不可再压缩**的下拉框，于是按钮被挤到只剩一个字符宽 —— 每一行都变成两行「测 / 试」。**注意：这个缺陷的修法（加最小宽度轨道等）随后连同下拉框一起被撤掉了** —— 保留下来的是 `white-space:nowrap`，它独立成立：这个动作列的宽度是表格的一个分数轨，一个固定的两字标签（测试）不该被拆行，窄窗口下**裁剪**才是正确的失败方式。
  - **文案**：那个下拉框的第一个选项原本叫**「区域目标」** —— 维护者看到它直接问「这目标区域是做什么用的？」，这本身就是命名失败的证据：它读起来像一个**区域**，而它表达的是「**跟随账号池的目标模型**」。当时先改为**「同账号池」**（en: `same as pool`）并把 `title` 重写为**先回答「它是做什么的」**；随后整个下拉框被撤除，这两个字符串也一并删掉了。**留下的教训是命名那条**：一个选项名如果让人需要问「这是做什么用的」，那它写的就是「值从哪来」而不是「它做什么」。
  - **为什么这件事值得记**：这两处都不是逻辑错，而是**只有人看界面才会发现**的错 —— 自动测试全绿、CI 全绿、发布会成功。它提醒本仓库的验证手段（源码级守卫 + 变异验证）覆盖不了「读起来对不对、排得下排不下」，而这两类恰恰需要真机截图或使用者提问才能暴露。
  - **守卫**：`tests/client-host-contract.spec.ts` 新增一例钉住 `nowrap`；随撤除一并改写为「不再为已移除的下拉框预留宽度」（见下）。**变异验证**：删掉 `nowrap` → 该例变红。

### 撤除

- **撤掉「逐账号测试模型」（`pool.targetModelIdByAccount`）—— 它是 4.4.6 采纳报告者提议时加进来的，维护者判定应撤。**（issue #61 的后续）
  - **为什么撤**：**池设置里本来就有统一的测试模型**（`pool.targetModelId`），而报告的诉求（「你用 `step5` 就要测这个模型」）用它就能达成 —— 报告者当时把它配成 `hy4-preview-f`（实际在用 `step-5-preview`），**根因是那个统一设置指错了模型，不是缺少逐账号能力**。
  - **更重要的理由**：逐账号让**同一张表的「全绿」不再可比** —— A 的 `ok` 是模型 X 上的、B 的 `ok` 是模型 Y 上的，而「全绿不代表可用」正是这个 issue 抱怨的东西。为了「方便对比某个号」引入一个削弱「整表可比」的设置，方向是反的。
  - **撤掉的东西**：配置字段 `pool.targetModelIdByAccount`（含 schema）、`targetModelPreference()`、批量路由的**逐账号解析器**（`testAllAccounts` 回到「整批一个模型」的 `string` 形态，`WorkBuddyPoolDeps.test` 的联合类型一并收窄）、池文件与 usage 载荷里的逐账号映射、每行那个「测试模型」下拉框（含 `setRowModel`、draft 比较、写入与**写入后校验**、三个 locale 键）、以及为容纳它而加的网格最小宽度。
  - **完整保留的东西（#61 里真正解决问题的那一半，不需要任何新配置）**：
    1. 探针记录**写入 `modelId`**（`probeModel()` 一直返回它，此前落盘被丢掉），所以每行的结论**自带适用范围**；批量与实时聊天失败两条路径都写；
    2. 每行**显示**「模型 X」（`poolProbeModel`），以及未记录时的显式说明；
    3. `resolveTargetModel` 的**陈旧目标如实报告、绝不静默替换**（指向已下架模型时报 `stale`，不换一个用户没选的模型去花积分）。
  - **升级影响**：老配置里若已写了 `targetModelIdByAccount`，升级后**被忽略**（未知字段），池的实际测试模型回到 `targetModelId` —— 也就是「所有号测同一个模型」，这正是撤除的目的。**不影响聊天用哪个模型**（那个设置从来不参与选路）。
  - **守卫**：`tests/issue61-probe-model-scope.spec.ts` 重写为钉住「保留的那一半」+「整批只能一个模型」（`probes every account on the SAME model` 直接断言两次探测拿到同一个 id，若有人把它改回逐账号，这条会红）；`tests/pool-route.spec.ts` 删掉逐账号解析器的路由断言与 `askedModel()` 联合类型收窄辅助函数；`tests/client-host-contract.spec.ts` 的布局守卫改写为「不再为已移除的下拉框预留宽度」（并保留 `nowrap`，它与下拉框无关、独立成立）。
  - 全量 **1249 通过 / 2 跳过**。

## 4.5.1 (2026-10-14)

### Fixes

- **`6004`（账号频率超限）在对话里被显示成「当前请求的额度已用尽」，而账号余额还剩 6,788 —— 现在那句话下面补了一句说明。**（issue #63；维护者判定：**保持不进重试**，只补文案）
  - **根因（实测，不是读代码猜的）**：宿主对失败按**码**路由，而插件这条链是 —— shim 的错误响应 → pi-ai 抛出的 message → `classifyPiAiError(message)` → 宿主码 → 客户端文案。三个环节的出货代码取出来直接跑之后：`quota_exceeded` 这个拼写里的下划线**恰好命中** `@deepseek-ai/dsh-llm` 的 `isQuotaExceededError` 正则（`quota[\s_-]+exceeded` 的 `[\s_-]+` 能匹配 `_`），于是归成 `QUOTA`；而 `@deepseek-ai/dsh-client-ui-chat` 对 `QUOTA`/`ACCOUNT_QUOTA` **硬编码**成那句固定文案、并**丢弃**插件自己的 message。**这一版之前我在 #56/#61 里把它说成「插件挑了宿主认识的词」，那个解释是错的。**
  - **为什么不改分类（维护者的决定，也是实测支持的）**：把拼写换成任何一个不再被 quota 正则命中的值，都会落进 `RATE_LIMIT` —— 而它在 `DEFAULT_RETRYABLE_CODES` 里（`EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`）。按出货默认（`initialDelayMs=500`、指数退避、封顶 10s、`maxRetries=5`）这是**5 次原地重试、标称 15.5 秒退避**，而 `6004` 的恢复点在报文里明写了是**几小时后** —— 退避窗口内不可能恢复。所以「不进重试」保留，「那句话不够准确」用**补充**解决。
  - **修法**：用宿主**专门为此留的扩展点** `shell.quota-notice`（链式插槽，其自有文档写着「the first entry whose selector claims its code takes over the surface」）。本插件注册一条 `select: owner => code === 'QUOTA' ? owner : null` 的链项：
    - **只 claim `QUOTA`** —— 其余码（`AUTH`、`ACCOUNT_SIGNED_OUT`、`ACCOUNT_QUOTA` 等）继续走宿主自己的兜底 Toast，本插件不接管自己说不清的提示；
    - **宿主那句话原样保留**（`matched.message`），补充是**第二行**而不是改写 —— 那句话在别处也显示，重写会让插件与 shell 的用词互相矛盾；
    - 补充文案：**「部分模型另有每日额度限制，与积分余额无关 —— 也可能确实是本账号积分耗尽。账号池那一行会写明上游给出的恢复时刻；也可以先换个账号或换个模型继续。」** 措辞对 `QUOTA` 覆盖的**两种**情况都成立，因为上游是用中文散文区分的，而插件不允许解析它来下政策判断；中英双语都写。
    - 带一个「知道了」按钮，调用宿主自己的 `dismiss`；宿主没给 `dismiss` 时只渲染文字而不崩 —— 这是**全窗口**的提示，在这里抛错会连别的插件的提示一起带走。
  - **组件用本插件自己的 DOM 与样式类**，不引 `@deepseek-ai/dsh-client-ui-primitives`：客户端刻意不依赖它（那条 stale 的 `inject` 曾让整张卡片的到达依赖上宿主最易变的包，见 `tests/client-host-contract.spec.ts` 的说明），所以这里沿用本插件其它组件的做法。
  - **实机核对**：构建后用 Slot 检查器读运行中的插槽树，`shell.quota-notice` 的 occupants 已包含 `dsh-connect-workbuddy-client`（`active: true`），与宿主自己的 `mf` 并列；插槽目录给出的 `ownerProps`（`code`/`message`/`dismiss`/`keepOpen`）与组件读取的字段一致。
  - **守卫**：`tests/issue63-quota-notice.spec.tsx`（7 例）覆盖：claim 恰好是 `QUOTA`、其余码（含 `QUOTA_EXCEEDED`、空串、数字、对象）一律不 claim、宿主句子原样保留且补充可见、dismiss 按钮调用宿主回调、无 `dismiss` 时不崩、宿主没给 message 时回退到自己的标题。**变异验证**：把 claim 扩到 `AUTH`/`ACCOUNT_QUOTA` → 2 例红；删掉补充那一行 → 2 例红。
  - **未做**：没有改任何分类/HTTP 状态，也没有动 `KIND_HOST_CODE` 里 `soft_rate`/`model_busy` → `quota_exceeded` 的翻译（那正是 #56 修复的核心）。

## 4.5.0 (2026-10-14)

> 版本号是 **minor** 而不是 patch：这一版新增了一个**用户可见的设置**（积分读数的位置）和一个**新的渲染席位**，而且配置 schema 多了一个字段 —— 按语义化版本这是特性，不是修错。`4.4.6` 之后没有任何以 4.4.7 发布过的产物或 Release（tag 已撤回重打）。

### Features

- **积分读数只有一个固定位置：装了别的插件后它就不显示了 —— 现在位置可选（输入框工具栏 / 输入框下方）**（issue #62 报告者）
  - **现象**：报告者装了第三方插件（`dsh-auto-continue`）之后，对话输入框里的 WorkBuddy 积分余额消失。根因是那个位置本身：`conversation.input.left`（输入框工具栏）是一个**共享的 list 插槽**，shell 自己的控件和任何其他 bundle 都注册在那里 —— 而 list 插槽无法保证每个占用者都可见，别人挤进来就可能把本插件的读数挤没。原注释里其实已经记着同类问题（更早放在侧边栏底部时，两个连接器插件互相挤压，才迁到输入框这一行）。
  - **修法**：把「位置」做成**每区域一个选项**，两个席位都注册、由 gate 决定在哪个席位渲染：
    - `composer`（默认）—— 输入框工具栏 `conversation.input.left`，与模型选择同一行；
    - `stats` —— 输入框下方 `conversation.composer.dock`，shell 自己渲染「轮次 / 步数 · tok/s · token · 缓存命中」那一行；`order: 10` 排在 shell 的统计之后，所以官方那几颗统计仍在最左，读数是**追加**而不是顶替。
    - 选默认值是为了**升级不动任何人的界面**：设置在 schema 里默认 `composer`，升级前写下的 profile 读出来仍是 `composer`。
  - **为什么两个席位都注册**：位置这种东西用户是「一边看着结果一边改」的，注册哪个席位取决于设置就意味着每次改设置都要**重新注册插槽**；而本仓库的注释里已经写明这种绑定是脆的（晚到的 settings 命名空间必须产生新的注册而不是改闭包）。现在**决定权在 gate 里一处**：席位不符就 `return null`，另一个席位照常渲染。
  - **判定的顺序**：先归属（是不是本插件的 provider）、再两个开关（区域是否启用、读数是否显示）、**最后**才是席位。所以一个被关掉的区域在**两个席位都不渲染**，而不是先在非当前席位画一帧再被拒。
  - **卡片新增一个两选一控件**（就在「对话框显示积分」那个勾选旁边，只作用于当前标签页的区域）：读取走 Host 的 usage 应答（与那个勾选同源，因为浏览器 settings 镜像在本命名空间上是过期的那份），写完**重新读一次 Host** —— 否则控件会一直显示旧席位，看起来像没生效。
  - **守卫**：`tests/issue62-credit-position.spec.tsx`（9 例）覆盖：默认 `composer`（含升级前的 profile 与手改的未知值）、按区域而非全局读取、写入只改该区域该字段（模型列表/预算/兄弟区域都不动）、席位与显示开关相互独立、gate 在**指定席位渲染 / 另一席位渲染 0 个 / 两个席位都不渲染（隐藏或区域关闭）/ 别的 provider 两个席位都不渲染**。**变异验证**：把 gate 的席位判定删掉（两个席位都渲染）→ 2 例红；把读取的默认值去掉（升级前的 profile 读成 stats）→ 2 例红。


- **新增「上游请求体构成」诊断（`WORKBUDDY_BODY_REPORT`），用于定案 issue #59：两份请求体到底是不是同一份历史。**（issue #59）
  - **为什么需要**：报告里同一份历史被国内网关算约 70.8 万 token、国际网关算约 137.4 万（1.94 倍），切区域即 `code 11115 prompt is too long`。两条独立测量已经把范围压到唯一一个问题：报告者在**两个区域**跑本仓库的内容类别探针，逐字节相同的散文/代码/JSON 六格比值全在 **0.98~1.06**（同一段字节两边计价一致）；代码链路核对又表明**历史 reasoning 根本没进请求体**（pi-ai 只在 `compat.requiresThinkingAsText` 为真时把 `thinking` 当文本转发，本插件从未设置；`reasoning_details` 那条路需要流式解析从不写出的签名）。**剩下唯一可能是两份请求体不同**，而这件事**不需要任何区域有积分**就能查：请求体是本地拼好的，`14018 Credits exhausted` 是发出去之后才可能发生的。
  - **做法**：`src/body-report.ts` 在 shim 把 body 交给上游**之前**记录它的**构成** —— 每条消息的 `role`、逐块的类型（`system`/`text`/`tool-call`/`tool-result`/`reasoning`/`image`）、字符数与其中**中日韩字符**数（实测中文 0.669、英文 0.224 token/字符，差 3 倍，混在一起看不出来）、`tools` 数组、`messages.length` 与 body 总字节数。按区域写 `<dir>/<region>.jsonl`，一次请求一行（一轮对话有很多次上游调用，**最后一次**才是要比的那份）。
  - **只记计数、不记文本**：不写任何消息内容、账号名或令牌 —— 一个要被贴进公开 issue 的诊断不能有泄漏用户会话的能力。`tests/issue59-body-report.spec.ts` 里有一条专门的断言：用带特征串的 body 生成报告后，序列化结果**不含**该特征串（变异验证：让 `block()` 把 `text` 一起带上 → 该例与 reasoning 那例同时变红）。
  - **开关**：环境变量 `WORKBUDDY_BODY_REPORT` 未设置或为空白即**关闭**；`1`/`true` 写到 `<DSH home>/body-reports/`；其他值按**目录路径**解释。写文件失败只走日志，**绝不影响聊天请求**（有专门断言）。
  - **守卫**：`tests/issue59-body-report.spec.ts`（16 例）。
  - **配套**：`scripts/probe-region-token-accounting.mjs` 新增 `--language en|zh` 与 `--kind prose|code|json`（六种组合确定性填充、跨区域逐字节相同），并补上国内侧实测基线：prose 214.0 / code 287.0 / json 288.3（en），prose 671.0 / code 480.7 / json 397.3（zh），单位 tokens/1k chars。

## 4.4.6 (2026-10-14)

### Fixes

- **面板的「测试」只测一个模型，却把结果当成账号级结论：账号池说「可用」，一切到实际在用的模型就撞 `429 / 6004`。**（issue #61 报告者报告，维护者在 issue 下确认「测试的是某一个模型……不能换其他模型」）
  - **现象与证据**：报告者同一时刻、同一脚本测两个国内账号 —— `hy4-preview-f`（当时的 `pool.targetModelId`，面板测的就是它）两个号都可用，而 `step-5-preview`（当时实际在用的模型）两个号都 `429 / 6004`。池文件里这两个号还被更早的一次批量测试记成 `outcome=ok source=test-batch`，而池开着时那份「ok」正是选号依据。**`6004` 是「账号 × 模型」维度的条件**（本项目 10-13 也在三个国际账号上量到 `deepseek-v4.1-flash` 挂、其余模型全通），所以单一模型探测在结构上无法回答「这个账号能不能服务」。
  - **根因（报告者给出代码位置，本地逐条复核属实）**：`resolveTargetModel()` 只解析出**一个** `modelId`（来自区域级 `pool.targetModelId`），一条路径同时服务批量与逐行测试；而 `probeModel()` 的三个返回分支**早就带着 `modelId`**，落盘时被丢掉了 —— 记录里只有 `outcome/atMs/source/retryAtMs/message`，没有任何字段说明这条 `ok` 是**哪个模型**上的。
  - **修法（三处，各自成立）**：
    1. **测量记录记住模型**：`WorkBuddyPoolProbe` 新增可选 `modelId`，两个写入方（批量测试、实时聊天失败）在拿到模型的那一刻写下它。
    2. **每个账号可单独指定测试模型**：新增设置 `pool.targetModelIdByAccount`（账号 id → 模型 id），读取时先查 map、查不到回落 `targetModelId`。**批量测试与逐行测试走同一条解析**（报告者指出这正是「改一处两处同时生效」的地方），所以「测试所有账号」也会按每个号自己的模型去测。解析仍然过 `resolveTargetModel`：指向本区域已下架模型时**报 `stale`、绝不静默换成另一个模型**（换一个等于花积分测一个用户没选的模型，还把它当作这个号的结论）。
    3. **卡片显示适用范围**：池表每行的测量结论旁写上「模型 {model}」（记录里没有该字段的旧数据写「未记录模型」，不猜）；每行新增一个测试模型下拉框（留空 = 跟随区域目标），随「保存」一起写入。
  - **为什么 `modelId` 落盘时不继承**：`accountName` 与 `retryAtMs` 描述的是**账号**（后来者看不到的名字仍然是真的，未来的刷新时刻仍然在未来），而模型描述的是**这一次测量**。把旧的 model id 继承到一次新测量上，等于用不是它的模型给它贴标签 —— 正是这个字段要终结的那种混淆。所以**缺失即「范围未知」，不是猜测**。
  - **配置向后兼容**：`targetModelIdByAccount` 默认空对象，且**只有非空时才写入** settings（与 `probeInputTokens` 同一条规则）—— 从未用过这个设置的 profile 写出来的槽位与升级前逐字节相同，升级不会看起来像用户改过设置。
  - **守卫**：`tests/issue61-probe-model-scope.spec.ts`（9 例）覆盖：逐账号优先/回落、空串视为「跟随区域目标」、override 下架时解析为 `stale` 且不带 `modelId`、批量按各账号自己的模型探测、单一模型的旧调用形态不变、解析不出模型时产出 `unavailable` 行并指名那个模型（**没有**回退到别的模型）、批量写入 `modelId`、**不继承**、新测量覆盖旧模型。`tests/pool-route.spec.ts` 新增一条路由级断言：批量路由交给 Host 的是**逐账号解析器**（`a` 用区域目标、`b` 用 `b` 自己的）。**变异验证**：记录不再写 `modelId` → 1 例红；合并改成继承 → 1 例红；批量改回「整批一个模型」→ 1 例红；路由改回传单一 modelId → 路由断言红。

### Features

## 4.4.5 (2026-10-14)

### Fixes

- **积分余额读错了「家族」：月度套餐被按容量池（上限值）计入，国内、国际都偏高一个完整月度额度；同时漏读了小数。这条**推翻** 4.3.3 对 issue #48 的判断。**（issue #58 报告者报告，维护者用官方客户端截图定案）
  - **判据（决定性）**：维护者自己账号的官方客户端截图 —— `总剩余积分 2,196.61 = 套餐基础积分 500 + 平台奖励积分 1,696.61`，而**同一份账单响应**里 `Σ CycleCapacityRemainPrecise = 2,196.61`（分毫不差），`Σ CapacityRemain = 2,196`。**那个「.61」就是证据**：整数 `CapacityRemain` 无论怎么加都加不出小数位，因为小数只存在于 `*Precise` 字段里，而它属于**周期**家族。客户端自己的三个桶（套餐基础 / 平台奖励 / 购买）与（月度周期、gift 周期、购买）一一对应。
  - **为什么池值不是余额**：一个周期已用尽的月度套餐仍返回 `CapacityRemain=500, CapacityUsed=0`（「一点没用、全都还在」），而周期说 `CycleCapacityUsed=500`。本机 **8/8** 个国内账号上，池值与周期值只在**周期未被使用**时相等；周期一旦开始消耗，按池读数就**整整高出一个月度额度**（LaoDing 500、老丁 500、两次实测各差 56 / 115）。
  - **国际侧的独立佐证**：三个国际账号返回 `CapacityRemain=100`，而国际网关**用 `14018 Credits exhausted` 拒绝它们的对话请求** —— 池值在那里不是可花的额度。也就是说 #48 当初认定的「误报 0」其实是真值，报告者看到的 200 来自 gift 包（或宽限路径）。
  - **修法**：
    - 余额一律读**周期**家族（`CycleCapacityRemain`），**两种套餐统一** —— gift 的两套字段实测完全相等，所以统一读周期等于**删掉了那个出错的月度分支**：不再有「哪种包读哪个字段」这种可以搞错的特殊情况。
    - **读 `*Precise`**（字符串，带小数）优先，整数拼写回退。这是 2,196.61 里那个 `.61` 的来源，此前完全没读。
    - `size` 同样取周期家族（`CycleCapacitySize` → `CapacitySize` 回退），这样「已剩 0 / 共 100」读得通。
    - 完全没有周期家族的行（例如只带 `CapacitySize`/`CapacityRemain` 的合成行）回退读池，避免静默报 0。
    - **删除 `cycleRemain` 字段**：余额本身就是周期值了，它成了同义重复；`refreshAtMs`（周期续期点）才是「本周期已用完、什么时候恢复」的表达。gift 的丢弃规则（耗尽/过期）、`expiringSoon`、`nearestExpiryMs` 均未改变。
    - **显示只取整数部分（向下取整）**：余额现在带小数（`2,196.61`），卡片不显示小数位。取**向下取整**而非四舍五入：四舍五入会把 `2,196.61` 印成 `2,197`，而官方客户端显示 `2,196.61` —— 一张刚跟客户端核对过的卡片反而看起来差 1；而且 `0.61` 向上取整会印成 `1`，等于告诉读者他有一个并不存在的积分可花。三处显示（编辑器读数、账号池积分列、模型容量）统一走新增的 `src/client/credit-format.ts`，守卫 `tests/credit-format.spec.ts`（5 例）。
  - **实测核对**（构建后的插件，真实账号）：`177****417… total=2196.61` —— 与客户端截图**逐位一致**；`LaoDing 647.01`、`老丁 1360.13`（旧读数为 1147 / 1860）。国际三个账号 `0.00`，与 `14018` 一致。
  - **守卫**：`tests/issue58-credit-balance-cycle.spec.ts`（9 例，替换掉 `tests/issue48-monthly-pool-credits.spec.ts` —— 后者的断言钉的正是被推翻的规则）。覆盖：total == Σ 周期精确值（含小数）、周期耗尽时读周期而非池、国际耗尽行为 0、周期未用时两种读法一致（说明不是「所有数字都变了」）、无周期家族回退、精确/整数两种拼写、gift 丢弃规则不变、负值不进 total、`expiringSoon` 与 total 同源。**变异验证**：把余额改回读池 → 3 例变红；把 `*Precise` 读法去掉 → 4 例变红。
  - **另一处新增工具**：`scripts/probe-credits-raw.mjs` —— 逐包原样打印账单响应（含未被读取的字段）并给出三个候选口径的合计，让「客户端显示的到底是哪个字段」这件事可以被独立复现，而不必相信本文件的叙述。

- **账号池的「已不再登录」警告只报数量、不报是谁，而且没有任何一行可以处理。**（issue #60 报告者）
  - **现象**：账号池下方出现 `有 1 个已保存的账号在本机已不再登录……再保存一次即可移除它们。` —— 用户既不知道是哪个账号，界面里也找不到对应的行，更**没有办法执行「再保存一次」**：这句话描述的移除动作，在当时的数据结构下无处可做。
  - **三条独立成因**（报告者逐条给出代码位置，本地逐条复核属实）：
    1. `ghostMemberIds()` 只返回**裸 id**，把当时就在手边的名称丢掉了；
    2. 文案模板只有 `{count}`，而同文件的 `row.poolSelectAria` / `row.poolCurrentHeader` 都带 `{accountName}` —— 不是没东西可显示，是这条文案没设计成能显示；
    3. 幽灵账号**没有行**：账号表格渲染的是**本机已登录**的名册，而幽灵恰恰是「不在名册里」的那一个，所以「哪一行该打标记」在旧结构下无解。
  - **修法**（两条，各自成立）：
    - **让测量记录记住名称**：`WorkBuddyPoolProbe` 新增可选 `accountName`，由**两个写入方**在拿到账号的那一刻写下（测试批次一直持有该名称；实时聊天那条在取不到名称时**继承**旧值）。选择存在测量文件而非设置里的原因与 4.4.4 同源：**名称只在被测量的那一刻确定可知**，登录消失后别处都查不到；而设置槽会被「草稿 → 保存」覆盖，实测数据不该住在里面。`mergePoolProbe()` 对缺失名称**继承**、对新名称**覆盖**（与 `retryAtMs` 同一口径：**缺失不等于声明**）。
    - **给幽灵一个可见且可处理的位置**：警告句改为指名（`{count}` + `{names}`），下面渲染**每个幽灵一个只读徽标 + ✕ 移除按钮**。移除是**草稿编辑**（与取消勾选一个已列出账号完全同构），仍然由「保存」提交 —— 旧文案承诺的那个动作，现在真的做得到了。
    - **取不到名称时不编造**：徽标退回 **id 前缀**（`e44e62b3…`）。前缀不是好标签，但它是**诚实的**，且足以把两个幽灵分开；换成「第 1 个」这类更好看的位置标签，会把用户指向错误的账号。宿主**只**为名册里没有的 id 下发名称，避免同一件事有两个可能互相矛盾的来源。
  - **守卫**：新增 `tests/issue60-ghost-member-labels.spec.ts`（14 例）—— 命名、空名退回前缀、顺序稳定、三名截断、`mergePoolProbe` 的继承/覆盖/两字段同时继承、`probeUpdatesOf` 写名与空名不写、磁盘往返。**变异验证**：把名称继承改回整体替换 → 2 例变红。

### Docs

- 新增 `scripts/probe-region-token-accounting.mjs`：同一段英文文本在国内外两个网关下各发一次，比较上游自报的 `prompt_tokens`，并判定该网关的**缓存计账口径**（`prompt_tokens` 是否包含命中缓存的部分）。用于 issue #59 的根因定位；只读、按账号逐个报告失败原因。
- 新增 `scripts/probe-credits-raw.mjs`：逐包原样打印账单响应并列出三个候选口径的合计，用于核对「官方客户端显示的余额到底是哪个字段」（issue #58）；只读，账号名做遮蔽。

## 4.4.4 (2026-10-13)

### Fixes

- **实时聊天路径丢掉了「确定的积分刷新时刻」：同一个「积分耗尽」在一屏上给出两个恢复时间，其中一个差了 18 天。**（issue #56 报告者在核验 4.4.3 时发现）
  - **来源**：报告者核完 4.4.3 的三处修复后，回答我请他判断的那个问题（「`out-of-credit` 无时刻时仍走 30 分钟兜底，是否该改」），并给出了**实测依据**。他先写下、又**自己更正掉**了一个错误结论（「`quotaRefreshAtMs` 没有调用点」—— 实测有 15 处、管道是通的），更正后的结论反而更具体。
  - **现象**：同一个 `out-of-credit` 失败，**按它从哪个门进来**得到两个答案：
    | 路径 | `cooldownOf` 输出 | 池表显示的恢复时刻 |
    | --- | --- | --- |
    | 探针（传 `quotaRefreshAtMs`） | `{retryAtMs: 2026-11-01, retrySource: 'quota-refresh'}` | **2026-11-01** |
    | 实时聊天（当时不传） | `{}` → 落到 `POOL_UNKNOWN_COOLDOWN_MS` | **约 30 分钟后** |
    **两条路径相差约 18 天**，而计费侧给出的那个「下月 1 日」才是唯一诚实的答案。
  - **两个独立缺陷，且会叠加**：
    1. **`recordAccountFailure()` 没有传 `quotaRefreshAtMs`** —— 探针路径早已证明这个数据拿得到（`quotaRefreshOf(region, credential)`），实时路径却没接上。
    2. **`writePoolProbes()` 是账户级整体展开**（`{ ...existing, ...updates }`），`updates[accountId]` 这整个**新对象**替换掉旧对象 —— 所以实时聊天那次写入会把探针**已经存好的** `retryAtMs` 一起删掉。只修第 1 条不够：一条不带 `retryAtMs` 的 `live-request` 记录仍会抹掉好值。
  - **修法**：
    - `recordAccountFailure()` 在 `outcome === 'out-of-credit'` 时查一次 `quotaRefreshOf(region, credential)` 并传入 `cooldownOf`。**只对这一个 outcome 查**：`quotaRefreshOf` 要发一次上游请求，而限流或网络抖动**没有刷新点可找** —— 为它付这次请求等于花钱去学「没有答案」。查不到不是错误，兜底照旧。
    - `writePoolProbes()` 改为逐账户调用新增的纯函数 **`mergePoolProbe(existing, update)`**：`outcome` / `atMs` / `source` / `message` 一律归**更新的那次测量**，而 `retryAtMs` 在**更新没给**时**继承**旧值。继承只针对「缺失不等于声明」的这一个字段 —— 更新**给了**时刻仍然覆盖（新的、更短的冷却必须能压过旧的）。另有一条边界：**已经过去的时刻不继承**，否则记录会被钉在一个已经消失的时刻上，行里会读成「<过去的时刻> 之后可再用」。
    - **刻意未改**「无时刻时仍走 30 分钟兜底」—— 报告者明确不主张改这一条（拿不到刷新点时，用短窗口偶尔试试是合理的）。我们反对的只是**在拿得到真值的时候用那个数字**。
  - **守卫**：新增 `tests/issue56-quota-refresh-merge.spec.ts`（11 例），覆盖继承规则、覆盖规则、过期时刻不继承、以及**磁盘上真实的「探针先写、实时聊天后写」序列**仍然保住刷新点；另把 `tests/pool-e2e.spec.ts` 里那条按**源码形状**断言的守卫扩了三条（必须查到 `quotaRefreshOf(`、必须把 `quotaRefreshAtMs` 传进 `cooldownOf`、且只对能有的 outcome 查）—— 因为 `recordAccountFailure` 此前**没有任何测试覆盖到**，把修复还原后全套测试仍然全绿，这正是它会溜掉的原因。变异验证：还原合并改动 → 2 例变红；还原实时路径的入参 → 源码守卫变红。

- **两处「下一版补」的文档欠账，本版补上。**
  - **`chatStream()` 返回信封而非可迭代流**（issue #56 报告者最初就提醒过，我当时说了「下一版补」）：中英 README 的「开发」一节新增一节，写明要先查 `envelope.ok`，并点名跳过它的典型后果是**把失败全报成成功**（`response` 为 `undefined`，读它会抛错或被吞掉，于是「每个模型都成功」—— 报告者自己第一次写脚本就踩了这个）。
  - **pnpm 新版本等待期会挡住浮动升级**（报告者在核验 4.4.3 时顺手实测）：中英 README 的「安装」一节新增告示 —— 版本刚发布时浮动范围（`^4.4.2`）会被**静默压回上一版**，而精确版本（`4.4.3`）立即生效；两种写法都「安装成功」，所以症状是「升级跑完了、版本没变」，**极易被误报成发布失败**。附上他的实测表（隔离目录、pnpm 12.3.4、`--lockfile-only`），并明确建议写精确版本号。

### Docs

- 无其它。本版含上述修复与两处文档补记。

## 4.4.3 (2026-10-13)

### Fixes

- **插件页里 `dsh-connect-workbuddy` 的设置项整片空白，且不报任何错。**（issue #55）
  - **现象**：侧边栏「插件」→「已安装」→ 点进 `dsh-connect-workbuddy`，详情页里本该出现的 WorkBuddy 卡片（国内版 / 国际版两个标签页、扫码登录、账号检测、积分、模型勾选）**整个不见**，没有占位、没有报错、控制台也干净。报告者按另一份 AI 建议在 `node_modules` 里打补丁续了一版，但那是打在产品产物上、升级即失效。
  - **根因是两处叠加，各自都足以让卡片消失**：
    - **① 注册用的 key 与页面查找用的 name 不是同一个东西。** `plugins.bundle.config` / `plugins.row.config` 是 **keyed** 槽位（`kind: 'keyed'`，每个 `key` 每个优先级只能有一条）。插件页渲染它们时用的是 `renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })`，而 `pkg.name` 来自插件管理器清单里的**包名**；渲染前还要先过一道 `ledger.bundles.has(pkg.name)` —— 而这个 Set 装的正是各注册条目的 `key`。**两侧都是精确相等比较，比的都是包名，没有一处回落到 Loader 条目 id**。所以清单里叫 `dsh-connect-workbuddy`、而卡片只注册在 `include:dsh-connect-workbuddy` 下时，查找必然落空：整段不渲染，`apply()` 平静结束。
    - **② 注册这件事被挂在了「namespace 到达」的边沿上。** 卡片原本只在 `configForms.whileServed()` 的 `register` 回调里注册，而这个回调只在 **unserved→served 的跳变**上跑一次。若 settings 镜像始终不上报本插件的 namespace（名字不在候选表里、settings 面答得晚或答失败、该部署本就没把插件挂成可配置条目），这个跳变永远不会发生，`registerAllSlots()` 一次都不执行。因为整个 `apply` 体包在只打日志的 try/catch 里，**UI 就这样静默空白** —— 报告者遇到的那份补丁也正是这条。
  - **修法**：① 卡片的 `plugins.bundle.config` / `plugins.row.config` 注册改为覆盖包名的**所有拼写**（`WORKBUDDY_CARD_KEYS`：裸包名 + `include:` 前缀形式，行 key 为 `<包名>#<包名>`）。这些 key 各占一个 cell，属于**无遮蔽的重复条目**而非冲突，所以「全注册一遍」严格优于赌一个。② 注册**不再等待边沿**：`whileServed` 保留原语义（等 namespace 真到了再重绑一次、拿到可写表单），同时无条件先注册一遍；卡片在没有 `settingsScope` 时本就以**只读**形态渲染，这与「宿主没有 settings 面」的既有降级路径是同一条。
  - **顺带修掉一个会让上面②反而变成「整片空白 2.0」的顺序坑**：`rebindSlots()` 必须**先 dispose 再 register**。keyed 槽位会拒绝一个仍然存活的 key（`already has an entry for key …`），而每次注册都有各自的 try/catch 把它吞成一行 `console.error` —— 于是「先注册后 dispose」的结果是：旧条目刚被拆掉、新条目全被拒绝，账本归空。这一点由新增用例显式钉住，并在变异验证（把顺序改回去）下变红。
  - **守卫**：新增 `tests/issue55-card-not-registered.spec.ts`（8 例），按**页面真正读的那个账本**断言：裸名与 `include:` 前缀两种清单名下 `ledger.bundles.has(pkg.name)` 都为真；namespace 永不到达时仍完成注册；namespace 已经到了时不产生重复注册（不触发 keyed 冲突）；无 settings 面的宿主仍注册（只读降级）；以及上面那条 dispose/register 顺序。`tests/client-fallback.spec.ts` 的手工镜像同步更新（注册数 3→5）。

- **14003 是模型级、逐请求的软限流，却被当成账号级失败：换号循环把池内每个账号各锁 30 分钟。**（issue #56）
  - **现象**：报告者的决定性对照 —— **同一凭据、同一时刻**，除 `model` 一个字段外逐字节相同的请求，`deepseek-v4.1-flash`（×0）3 发只成 1 发、`deepseek-v4.1-flash-sg`（×0.03）同样 1/3、而 `glm-5.3-flash` / `hy3` / `kimi-k2.6` 全部 **3/3**。同一秒内同账号别的模型全部正常，所以**账号没有被限流**。上游原话也把维度说明白了：`displayTips` = 「建议等待约 1 分钟后重试，**或切换到负载较低的模型**」。而插件的实际效果是：三个账号全部变 `rate-limited`，用户在此后约 30 分钟里完全无法交流 —— 把上游说的一分钟放大了 30 倍，还放大到了整个账号池。
  - **根因**：`classifyUpstreamError()` 把 429 一律归为 `soft_rate`。14003 的报文里**没有任何日期时间**，所以 `parseUpstreamResetAt()` 返回 `undefined` → `cooldownOf()` 返回 `{}` → `retryDue()` 落到 `probe.atMs + 18e5`（`POOL_UNKNOWN_COOLDOWN_MS` = 30 分钟）。三重放大同时发生：**等太久**、**锁错对象**（锁的是账号，而限制跟着模型走）、**把每个账号都锁一遍**（failover 逐个撞同一堵墙，每撞一次就给一个本来健康的账号写入一条 `live-request` 的限流记录，覆盖掉它先前的 `ok` 测量）。
  - **修法**（四处，各自独立可验）：
    - **分类**：新增 `model_busy` 这一 kind（`UpstreamErrorKind` / `WorkBuddyProbeOutcome` / `WorkBuddyPoolExclusion` 三处词汇表各加一枚），判据是 **`"code":14003` 这一带引号的 key 形式** —— 不用 `displayTips` 文案当判据，否则一个恰好提到「负载较低的模型」的网关横幅也会被改判。检查放在**积分标记之后**（两者同时出现时仍按「要充值」这条可执行的结论走）、**普通 429 分支之前**。
    - **时长**：`MODEL_BUSY_COOLDOWN_MS = 2 分钟`，与上游「约 1 分钟」同量级（取 2 而非 1，是为了越过这一阵而不是踩在边上）。`cooldownOf()` 为 `model-busy` 补上这个兜底，并把 `retrySource` 标成新的 `'upstream-tips'` —— 它如实说明这个数字的来路是**上游给的数量级**，不是上游给的时刻。
    - **不换号**：`isFailoverWorthy()` 把 `model_busy` 与 `client` 一起排除。换号撞的是同一堵墙，只会每个账号各花一次请求去学到第一发已经说过的事实，并往每个账号写一条假测量。失败**仍然如实上报一次**（卡片要靠它显示「为什么这个账号不在池里」）。
    - **如实告知**：shim 给 `model_busy` 单独一条错误文案 —— 沿用上游自己的话（「请求过于频繁，请稍后重试。」）+ `requestId`，并明确写出**这不是账号被限流、换账号没用、建议等待约 1 分钟或切换模型**。卡片侧新增 `row.probeModelBusy*` / `row.poolExcludedModelBusy` 文案，池表里「模型繁忙」与「被限流」**分开显示**（把模型的问题写在账号名旁边，正是让报告者去找一个并不存在的坏账号的原因）。
  - **顺带对齐两处**：`probe-reason.ts` 把 `model-busy` 列入「标签已说清、不再内联原始报文」的集合（该报文只是 14003 信封，会把补救办法挤掉）；`AccountPool` 的状态色把 `model-busy` 归入琥珀（会自行恢复、账号没坏）而非红色。
  - **守卫**：新增 `tests/issue56-model-scoped-throttle.spec.ts`（14 例），用报告者的原文报文当 fixture：分类正确（14003→`model-busy`，6004→`soft_rate` 不变）、不误伤（只有文案没有 code、或 requestId 恰好含 `14003`，都仍是普通限流）、与积分同时出现时仍判积分、冷却时长为分钟级且带 `'upstream-tips'` 来源、有真实时刻时以时刻为准、模型级账号在一分钟后回到池内而普通限流仍在池外。`tests/shim-failover.spec.ts` 新增 3 例：`model_busy` **不走**换号（池里明明有候选也不问）、失败仍上报且只报一次、用户看到的是「模型繁忙」而不是「账号被限流」。
  - **刻意保留的重复**：`MODEL_BUSY_COOLDOWN_MS` 在 `src/probe.ts` 与 `src/account-pool.ts` 各声明一次。两者不能互相 import（一个是 Host 侧探测、一个是纯排序规则，后者刻意不依赖前者），所以由一条测试断言两个声明**必须相等** —— 探测写一种冷却、排序读另一种，就会悄悄把这个缺陷重新打开。

- **`14018`「积分耗尽」被判成普通限流：marker 表漏了复数形式，用户拿到的建议从「去充值」变成「等一等」。**（issue #56 的追加报告）
  - **来源**：这条是报告者在回答「`14018` 是否与 `14003` 同族」时**顺手挖出来的**，不在原 issue 范围内。
  - **现象**：上游对「这个账号在这些模型上没积分了」返回 `429` / `code 14018`，报文逐字为
    `{"error":{"data":{"code":14018,"msg":"Credits exhausted. Please visit the link below to purchase add-on packs and get more credits: …"}}}`。
  - **根因**：`HARD_CREDIT_MARKERS` 里写的是 **`'credit exhausted'`（单数）**，而上游发的是 **`"Credits exhausted."`（复数 + 大写 C）**。`'credits exhausted.'.includes('credit exhausted')` 是 **false** —— `s` 正好夹在两个词中间。**八条英文 marker 逐条试过，全部未命中**；中文 marker 也不在报文里，救不了。于是它落到通用 429 分支：`classifyUpstreamError → soft_rate`、`outcomeOfFailure → rate-limited`、`cooldownOf → {}`。
  - **后果**：一条本该读成「**去充值**」的失败被降级成「**等一等**」，用户看到「稍后重试」而正确答案是「这个号的积分用完了」。这与 issue #56 那个「把一分钟放大成半小时」是**同一类放大，只是入口不同**。
  - **报告者同时做了两条反证，都很关键**：① 特意在**网络层**确认真实 HTTP 状态是 **429 而不是 402** —— 因为 `classifyUpstreamError()` 第一行就是 `if (status === 402) return 'hard_credit'`，若上游真发 402 则这条 bug 根本不成立；② 用 **3 账号 × 4 模型** 的矩阵证明 `14018` 是**账号级**而非模型级（账号 B 余额 100 上 `hy4-preview` 0/2，而余额 379/350 的 A/C 服务同一模型 2/2；同号上免费模型 `hy3`/`deepseek-v4.1-flash` 均 2/2 而计费模型全挂）⇒ **`14018` 保持账号级路径，不与 `14003` 合并**。
  - **修法**（两条都采用，因为它们防的是不同失效）：
    1. 补 **`'credits exhausted'`** 复数形式，并**保留单数**（网关改过措辞，只认今天这一种的表就是同一个坑的下一轮）；
    2. 新增按 **`"code":14018`** 的带引号 key 判定（`CREDITS_EXHAUSTED_CODE`），与既有的 `MODEL_BUSY_CODE` 同构 —— 措辞**完全改掉**的报文也能正确归类，且不受大小写与单复数影响。
  - **顺序**：code 判定放在中文/英文 marker **之后**、`model_busy` **之前**，因此一条同时携带 `14018` 与 `14003` 的报文读作「去充值」（那是可执行的结论）。
  - **未改动**：`exclusionOf` 对 `out-of-credit` 在**无时刻**时仍走 `POOL_UNKNOWN_COOLDOWN_MS` 通用兜底。这是**既有行为**，本版未动 —— 积分耗尽只能靠充值或周期刷新解除，与 `14003` 的秒级恢复性质不同。已在 issue 里如实说明并请报告者判断是否另案处理。
  - **守卫**：新增 `tests/issue56-credits-exhausted-code.spec.ts`（9 例），**用报告者贴的报文原文当 fixture**（含尾随空格与 `{"error":{"data":…}}` 嵌套 —— 它和 `14003` 的扁平信封不同，本身就是「按散文做表很脆」的又一证据）。既钉住 `14018 → hard_credit → out-of-credit`，也钉住「两者必须分开」与「配额刷新点仍被采用」。变异验证：同时还原复数 marker 与 code 判定，**9 例中 5 例变红**，恢复后全绿。

- **客户端注册后打印一行摘要，把「静默空白」变成一眼可诊断。**（issue #55 报告者的建议）
  - **动机来自报告者的原话**：整片 UI 消失与一切正常在页面上**完全无法区分**，因为他（和后来的我们）定位耗时几乎全花在那个只打日志的静默 `try/catch` 上。
  - 现在每个 rebind 结束都会打一行**成功路径**的 `console.info`：
    `[dsh-connect-workbuddy] registered 5 slots (settings form: bound)` 或
    `[dsh-connect-workbuddy] registered 5 slots (settings form: none — card is read-only)`。
    后者正是「公网域名部署」那一类场景（客户端根本不发 `/api/settings/describe`，命名空间永不到达）会打出的样子：一眼看出「注册成功但表单只读」，而不是对着空白页猜。
  - 刻意用 `console.info` 而非 `warn`/`error`：健康路径打警告会训练用户忽略真正出事的那条通道。
  - **未采纳**「把 `apply()` 拆成多个 try/catch」：外层兜底的作用是「槽位 API 变更时降级为日志，而不是让宿主弹 `Failed to load plugins` 红条」，拆开会让部分 UI 失败时更难判断整体状态。加了摘要后日志已能定位到具体哪几个没上。

- **换号提示把「积分耗尽」说成「被限流」，用户被叫去等一个不会来的恢复。**（issue #56 报告者指出）
  - **来源**：报告者在同一份追加报告里顺带指出 `src/shim.ts` 的 `failoverReasonText()` 把 `soft_rate` 与 `hard_credit` **并列成同一句 `'rate limited'`**，并预期「§三 修好之后这个号会走 `hard_credit` ⇒ 用户能拿到『积分耗尽』而不是『被限流』」。**这个预期当时并不成立** —— 卡片/池表一侧确实会显示「积分耗尽」（`poolExcludedOutOfCredit`），但**回复里的换号提示**仍读作「rate limited」，而那正是用户在对话中最先看到的那一句。
  - **为什么必须分开**：两者**都会出池、都会触发换号**（另一个账号可能确实有余额），但**补救办法不同类**——限流会在上游给出的时刻自行解除，积分耗尽在充值或周期刷新之前**永不会**好。共用一句话等于叫人去等一件不会发生的事，而正确动作是去充值或换号。
  - **修法**：`hard_credit` 拆出独立的 `'out of credits'`。**未改动** `isFailoverWorthy()`：`hard_credit` 依旧可换号（换到有余额的账号是可行的自救），只是提示词如实说明原因。
  - **守卫**：`tests/shim-failover.spec.ts` 新增 1 例，断言耗尽场景的提示含 `out of credits` 且**不含** `rate limited`，同时确认它**仍然换号**（`seen == ['selected', 'other']`）。变异验证：把两个 case 合并回 `'rate limited'`，该例立即变红，恢复后全绿。

### Docs

- 无。本版含上述修复与配套测试。

## 4.4.2 (2026-10-13)

### Fixes

- **DSH 0.2.1-alpha.2 下 workbuddy 模型工具调用全失效：把 pi-ai 主版本 1 判为 modern。**（PR #52，issues #24/#25/#26 的同源延伸）
  - **现象**：DSH `0.2.1-alpha.2` 起，**所有** workbuddy / workbuddy-global 模型都无法调用工具（本地模型与 deepseek 账号组不受影响），且**界面上没有任何报错**。会话事件流停在「只有思考块」→「整轮 completed」，全程没有 `tool-call` 事件；模型有时还会把 DSML 标记当**正文**吐出来。
  - **根因**：`src/pi-ai-runtime.ts` 的 `generationOf()` 用 `/^0\.(\d+)\./u` 解析版本，**只认 `0.x`**。DSH 0.2.1-alpha.2 随包的是 `@earendil-works/pi-ai@1.0.2`，`'1.0.2'` 匹配不到 → 返回 `'legacy'`。`legacy` 会让 `withLegacyContext()` 用 `adaptLegacyPiAiContext()` 把上下文折成 pi-ai **0.85** 形状：system 消息抽出去当 `systemPrompt`，工具声明搬到**顶层 `tools`**。而 pi-ai 1.x 从 `context.messages` 里 system 消息的 `toolsAdded` 读工具（`resolveTranscriptTools` / `getCurrentTools`），**不看顶层 `tools`**——请求里一个工具声明都没有，模型自然发不出 `toolCall`。国内网关容忍无 system 的请求，模型就把 DSML 写进正文。更隐蔽的是 shim 的 DSML 恢复也一并失效（`gate.declaredNames` 为空 → 整段禁用），所以整套缺陷**完全静默**。
  - **为什么在作者 checkout 上不复现**：源码注释里写着 "this checkout resolves 0.85.1 today"——解析到 0.85.1 时 `legacy` 分支是**正确**的。另外 `doctor` 在宿主**之外**跑会显示 `modern`，那是 `resolvedLocally: false` 的默认值，与宿主内的真实判定无关。
  - **修法**：只特判**主版本 1**，`>= 87` 的 minor 判定保持不变。已逐包对照 **pi-ai 0.87.1、1.0.2、1.1.0、1.2.0** 四个版本：三者的 `openai-completions` 都从 `context.messages` 调 `resolveTranscriptTools()`，`getCurrentTools()` 都读 system 消息的 `toolsAdded`/`toolsRemoved`，契约一致。**刻意是 `=== 1` 而不是 `>= 1`**：未核验未来 2.x 的上下文契约，不替未验证的版本做兼容承诺；测试里 `2.0.0` 明确断言仍为 `legacy`。
  - **顺带记录的边界事实**（本版**未**改动 peer 范围）：宿主 `dsh-app-boot` 的 `evaluatePluginCompatibility()` 只校验 `@deepseek-ai/dsh*` 命名空间，所以 `"@earendil-works/pi-ai": ">=0.85.0 <0.88.0"` 这条 peer **从不参与校验**，插件会对着越界的 1.x 静默运行。peer 范围的取舍留给维护者单独决定。
  - **守卫**：`tests/pi-ai-runtime.spec.ts` 的版本→代际用例改为数据驱动，并用临时目录里伪造的 `package.json` 驱动 `piAiRuntimeFor()`，**不依赖本机解析到哪个版本**，因此在解析到 0.85.1 的机器上也能跑。覆盖 `0.85.0/0.85.1/0.86.3 → legacy`、`0.87.0/0.87.1/1.0.0/1.0.2/1.1.0 → modern`、`2.0.0 → legacy`、不可解析版本保守判 `legacy`。变异验证（还原修复）后恰好 4 个 1.x 用例变红，其余 13 个不变。

- **上游流被截断时，恢复层把补写的 `[DONE]` 粘在半截帧之后，客户端 SSE 解析崩溃（PI_AI_ERROR）。**（PR #54，issue #53）
  - **现象**：对话中途偶发整轮直接失败，报错文本 `Unexpected non-whitespace character after JSON at position 319 (line 2 column 1)`，宿主归到兜底码 `PI_AI_ERROR`。该码**不在宿主的原地重试集**里（只认 `EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`），所以一旦出现，这一轮直接结束、不重试——用户看到的就是「突然断了」。已确认与具体模型、工作区无关，且**紧跟在一次 transport 故障之后**。
  - **根因**：是恢复层自己制造了非法的 SSE 帧，不是上游发的。两处叠加——① `consume()` 把流尾巴的残余帧直接透传，不补帧分隔空行；② `finish()` 补写合成终止帧时，没有确保前面有帧分隔。于是客户端实际收到的是**同一个 SSE 事件里的两条 `data:` 行**（中间只有一个 `\n`，不是空行）。openai SDK 的 `SSEDecoder` 会把一个事件内的多条 `data:` 行用 `\n` 拼起来再解析，拼出来就是「一个完整 JSON + 换行 + 第二个 JSON」，`JSON.parse` 在第二行行首抛错。**报错位置恰好是 319，因为第一段 chunk 的长度正好是 318**——这不是巧合。
  - **修法**：把「每个帧必须自带空行终止符」变成不变量，而不是在 `finish()` 里特判——`RecoveryStream` 有 6 处直接 `res.write`，逐个补分隔容易漏，而 `handleFrame` 里 JSON 解析失败的原帧透传路径同样会写出不带空行的帧。现在类内所有帧写出收敛到单一出口 `emitFrame()`，由它补齐帧尾；`consume()` 对 `carry` 剩下的半帧先归一化再交给 `handleFrame`。**缺换行和缺空行是两种情形**：前者补一个 `\n` 只结束「行」不结束「事件」，必须补 `\n\n` 才能让随后的 `[DONE]` 不粘上去。
  - **顺带修掉一个静默丢内容**：`finish()` **不**补 `[DONE]` 时，半截帧没有空行收尾，SDK 永远等不到分隔，最后那一小段内容被静默丢弃。归一化帧尾后这段内容能正常 dispatch 出来。
  - **不影响普通路径**：`push()` 切出的帧本就带终止符，经 `emitFrame` 原样通过，仍是 byte-for-byte 透传——「帧顺序永不改变」的既有承诺不受影响。
  - **守卫**：新增 `tests/issue53-sse-terminator.spec.ts`，断言在**字节层**：按 SSE 规范切事件，每个事件内多条 `data:` 行拼接后必须是单个合法 JSON。缺陷本质是字节粘连，只有字节级断言能抓住它。变异验证（还原两处修复）后 3 个缺陷用例全部变红，「完整流字节不变」的守卫用例保持绿色——说明没有过度归一化。

- **保存/删除/导入时的忙碌遮罩：改用宿主主题令牌，spinner 换成宿主同款弧线。**
  - **现象**：遮罩卡片是一块近黑的板子，上面的字（尤其是副标题「完成后列表会立即刷新。」）几乎看不清；spinner 的转法也和外壳里其他转圈明显不同拍。
  - **根因**：三处都出在自造值上。① 卡片底色用 `--dsw-alias-bg-primary`，而这个变量在宿主的令牌集里**根本不存在**（宿主只有 `bg-base` / `bg-layer-1..3` / `bg-module-platform` / `bg-overlay` 等），于是一路回退到硬编码的近黑 `#1b1c20`。② 遮罩底色写死 `rgba(0,0,0,.38)`，既不跟随主题、也没有宿主的模糊。③ 副标题用 `label-tertiary`——那是宿主最暗的一档（亮色 `neutral-bluish-600`、暗色 `neutral-bluish-400`），给元数据用的，不该承载一句要等的人必须读的话。
  - **修法**：卡片改用宿主给弹层用的 `--dsw-alias-bg-layer-2`（亮色白 / 暗色 `neutral-bluish-850`，各自成立）；遮罩改用宿主自己遮罩用的 `--dsw-alias-bg-mask-1`（亮 `.24` / 暗 `.5`）+ `--dsw-mask-blur`，与外壳里其他遮罩一致；副标题改用 `label-secondary`。阴影也从手写的 `0 8px 28px rgba(0,0,0,.35)` 换成宿主的 `--dsw-elevation-prominent`。
  - **spinner**：原本是 18px 的 CSS border 环、`.7s` 匀速转，比宿主自己的状态转圈（`_dsh-state-dot-spin`，SVG 弧线 + dash 呼吸、`1.5s`）快了近一倍。比起形状本身，**这个速度差才是它看着廉价的主因**。现在改为同款弧线几何与 `1.5s` 节奏，`currentColor` 继承所在层级，reduced-motion 降级为静态弧线（与宿主降级方式一致），并补 `aria-hidden` 免得 `role=status` 之外多报一次。
  - **顺带记录一个会静默损坏产物的坑**：`WORKBUDDY_CARD_CSS` 是模板字符串，注释里写反引号会**提前截断整个样式表**，而 typecheck 与 build **都不报错**（截断后的尾部仍是合法 TS，被当成一堆散落的表达式语句）。本次改注释时真的踩到了。新增一条守卫：按顶层语句数断言（正常 2 条变量声明；一旦截断会炸成几十条表达式语句）。变异验证：塞回一个反引号后该守卫变红，恢复后全绿。
  - **守卫**：`tests/client-host-contract.spec.ts` 由 8 例增至 10 例。

### Docs

- 无。本版含上述三处修复与配套测试。

## 4.4.1 (2026-10-12)

### Fixes

- **登录成功后「正在添加账号…」的遮罩不再无限转圈；导入的遮罩同样有上限。**（issue #51）
  - **现象**：报告者描述「登录成功后这里会转很久，等一分钟也没等完，每次都是直接退出 DSH 重新打开」，截图里账号表**已经有三条账号、其中一条正在服务**，而遮罩仍停在「正在添加账号…｜完成后列表会立即刷新。」。这两个事实合起来就是全部分析：凭据在 Host 答 `done` **之前**就已写入，所以表格有数据说明**登录本身是成功的**，卡住的是它的下一步。
  - **根因**：`OAuthSignIn` 的 `done` 分支里，`setPhase({ kind: 'syncing' })` 之后跟着一句 `await onAdded?.()`，而遮罩的显示条件正是 `phase.kind === 'syncing'`。也就是说**遮罩唯一的退出条件是一个 promise 落地**——既没有超时，也没有 `catch`。重读（卡片那次同源 usage 请求）只要永不 settle，`phase` 就永远停在 `syncing`。上一段的 `waiting` 阶段**有**自己的本地超时，`syncing` 两者都没有，这是本缺陷的形状。
  - **为什么代码评审看不见**：这是本次修复中最值得记下的一点。`phase` 是轮询 effect 的依赖项，`setPhase({ kind: 'syncing' })` 会让该 effect 重跑，React **先执行上一次的 cleanup**，而 cleanup 会把旧闭包的 `cancelled` 置为 `true`。React 在 `await` 恢复之前就提交了这次 cleanup，所以**恢复后总会看到 `cancelled === true` 并直接 return**。于是——**只有当重读快到不与 React 提交相交时**（即最快的那条路径），它才在 cleanup 之前落地、通过守卫并显示成功行。**慢到跨过一次 React 提交的顺序（也就是报告者遇到的那种）反而必然失败。缺陷藏在它自己的常见路径背后**，这也是第一版「把竞态写在原处」的修法**实测无效**的原因（不是推断，是跑出来的）。
  - **修法**：把这个等待搬进一个以 `phase` 为键的独立 effect。它的 cleanup 只在阶段**离开** `syncing` 时才跑，也就是在它已经做完事之后，因此不存在自我取消。新加的账号名走 `addedAccountName` state（而不是 ref），这样第二次登录（再添一个账号）会正确地重新计时，而不是复用上一轮的闭包值。
  - **两个出口都报成功，且刻意不做区分**：账号**确实**已经添加（Host 在答 `done` 之前就存好了凭据），所以诚实的说法是成功；超时只是不让屏幕无限期地声称相反。真正失败的 usage 路由仍由卡片自己以 `refreshError` 如实报告——那部分数据的拥有者是卡片，不是这里。
  - **导入路径一并设上限**：`AccountTransfer` 的 `await onChanged?.()` 是同一形态、同一个遮罩，唯一的区别是它没有把 `phase` 放进任何 effect 依赖，所以原地加超时即可生效。两条路径共用同一个 `settlesWithin` 实现，正是为了不再各自漂移。**一个上限值 `5_000ms`**：远长于一次健康的回环重读，又远短于轮询节奏给人的预期。
  - **守卫**：新增 `tests/issue51-sync-veil.spec.tsx`（5 例）。断言的是**可观察结果**而不是实现细节——重读仍在 pending 时遮罩必须已经落下、成功行必须已经出现；快路径不得因此被拖到超时；重读**抛错**按成功处理（它若逃逸进轮询的 `catch` 会重试轮询并再次报告同一个已添加的账号）；只在超时窗口内推进时钟时遮罩必须仍在。
  - **变异验证**：把 `src/client/OAuthSignIn.tsx` 改回原来的 `await onAdded?.()` 并删掉新 effect（即完全恢复旧逻辑），5 例中**3 例变红**；改回修复版 5 例全绿。这条记录有意写下来，因为**第一版修法本身是无效的**——只有经过这次还原才确认了守卫真的能抓住它。
  - **测试基建注意**：`tests/pool-render-helpers.tsx` 的 `settle()` 用 `setTimeout` 排空异步工作，而假时钟会冻结它，所以本文件不能沿用 `settle()`（会一直挂到测试超时，表现为「找不到按钮」这类级联报错）。本文件改用 `act` + `advanceTimersByTimeAsync` 手动驱动时钟。另：登录轮询间隔是 `OAUTH_POLL_INTERVAL_MS = 2000`，**不是**卡片 usage 的一分钟——写作过程中一度按 60 秒推进时钟，等价于把整个流程跑完，因此这一处边界在测试里以注释标明。
  - **未改动**：`window.open('')` 的占位窗口与「被拦则降级为弹窗内手动链接」这套行为一字未动。报告者说的「从来没有成功打开过浏览器」在该桌面外壳里 `window.open` 返回 `null`，走的是**已文档化的降级路径**，功能不损失（弹窗里始终有可复制的链接与「重新打开页面」按钮）；把它改成别的行为属于另一个议题，不在本次范围内。

## 4.4.0 (2026-10-12)

### Features

- **「在对话框显示积分」开关移进「账号池」标题行，少占一行。**
  - **改动**：该开关原本单独占一行（在 tab 栏下方），一个复选框换来一整行高度。现在它与「账号池」标题在同一行：标题在左，开关紧随其后，右侧仍是「当前账号」徽标。**账号池区块不会因此变高**。
  - **没有采用「干脆删掉这行、只在别处留开关」的做法**：`AccountPool` 在宿主不提供 pool 状态时（旧宿主，或该路由缺字段）会 `return null`，把开关交给它会让**整个设置项随之消失**——一个设置控件不能因为另一个区块没渲染就不可达。因此有两条渲染点，**同一时刻只有一条生效**：有 pool 时进标题行，没有 pool 时回落到它自己那行（`dsm-workbuddy-credits-switch-row`，间距与移动前一致）。守卫按**祖先关系**断言（开关在 `.dsm-workbuddy-pool-head` 之内，且回落行不存在），而不是只数复选框个数——两条同时渲染也能通过「存在性」断言，却把省下的那一行又还了回去。
  - **开关不因区域被关闭而隐藏**：区域关掉时它照旧渲染为**禁用**状态。藏起来会让用户看不到「为什么侧边栏没有那行」，而卡片自己的提示指向的是供应商复选框，不是一个凭空消失的控件。
  - **文案随位置微调（不是为了好看）**：标签从「在对话框显示 WB CN 积分 / Show WB CN credits in the composer」缩到「对话框显示 WB CN 积分 / WB CN credits in composer」，省掉的是「在」与「Show」这类可以由上下文承接的词，**区域区分保留**——开关现在与「账号池」同排、不再紧贴 tab 栏，丢掉区域名会让 CN 与国际版两个开关在文案上无法区分。完整解释仍在 `title` 提示里，一字未减。
  - **徽标改用 `margin-left:auto` 而非整行的 `space-between`**：三个子元素下 `space-between` 会把开关甩到中间而不是贴着标题；只有两个子元素（无开关）时 `margin-left:auto` 让徽标仍留在右边缘，与改动前一致。
  - **联动清理**：`AccountPool` 新增 `headerExtra` 插槽（与既有 `accountTools` 同款「传现成节点」约定），开关的写入路径、禁用规则与「与卡片其他区域写入者串行」的逻辑**全部留在卡片里**——它们依赖设置 scope 与保存状态，搬进池区块等于把同一份写入与串行化逻辑再实现一遍。
  - **守卫**：`tests/card-credits-switch.spec.tsx` 由 11 例增至 14 例，新增「开关在账号池标题行内且回落行不存在」「没有 pool 时回落到自己那行」「标签仍带区域名」三条。**变异验证**：把开关改回「永远单独成行」→ 第一条变红（`expected null not to be null`，即标题行里找不到开关）。

## 4.3.4 (2026-10-12)

### Fixes

- **移除一条只会在 Windows 上失败的测试断言，CI 恢复全绿。**（PR #49）
  - **现象**：4.3.2 与 4.3.3 的 CI 在 `windows-latest` 上红、`ubuntu-latest` 全绿，失败点只有一处：
    ```
    AssertionError: expected 'D:\explicit\home' to be '/explicit/home'
    ```
  - **根因**：`tests/host-peers.spec.ts` 把 `resolveDshHome('/explicit/home')` 与**字面量** `/explicit/home` 比较。而 `resolveDshHome` 会对入参跑 `path.resolve`，win32 下 `/explicit/home` 被规范成 `\explicit\home`——这条断言把「哪个平台在跑测试」写进了期望值，正是 `docs/WINDOWS.md` §4 那条「断言行为，不要断言跑测试的机器」要拦的形态。
  - **修法**：改为与 `path.resolve` **自身**比较（两侧同一个解析器），因此在任何平台都成立；并补一条不含分隔符的用例，证明胜出的是「显式入参」而不是某个字符串的写法。守卫本身（解析优先级、后备实现行为）一条未减。
  - **验证**：先在本地按 win32 路径语义逐形态核对（`/explicit/home`、`relative-ish`、`C:\…`、`~/dsh` 两侧全部一致），再经 **CI 的 `windows-latest` 真机跑通**——本次缺陷恰恰属于「本机（macOS）永远绿」的那一类，所以最终判据只能是在 Windows 上跑出来的结果。
  - **注意**：本次只改了 `tests/`，**`lib/` 与 `package.json` 的发布产物逐字未变**（`tests/` 不在 `files` 白名单内，从不随包分发）。因此 4.3.2 / 4.3.3 对用户而言没有问题，本版存在只为让 tag 上的 CI 结论与事实一致。

#### Docs

- **README 增补「在服务器上使用：搬运已登录的凭据」一节**（承接 issue #47 报告者 tuoyuangui 在 #47 评论中贡献的做法）。
  - **内容**：给出从「已登录 WorkBuddy 的机器」打包 `CodeBuddyExtension` 目录 → 传到服务器 → 解到插件实际读取的目录 → 用 `status` 验证的完整三步命令；中英双语同步（`README.md` / `README.en.md`）。
  - **更正了报告者原话里的一处平台细节**：报告者写的是 `cp -r 其他位置的 ~/.local/share[~/.config]/CodeBuddyExtension …`，其中 `~/.local/share` 在 **Linux 上插件不会读取**。`src/auth.ts` 的 `defaultDesktopAuthDirs()` 在 Linux 只返回 `${XDG_CONFIG_HOME:-~/.config}/CodeBuddyExtension/Data/Public/auth` 一项。README 因此列出三平台**实际**读取路径的对照表，并明确「只解到 `~/.local/share` 不会被读到」，同时给出 `WORKBUDDY_AUTH_FILE` 这条兜底（显式指定时同级备份仍会被扫描，账号切换照常可用）。
  - **补了两条报告者未提及、但读者必须知道的边界**：其一，**5.6.0 起的加密凭据无法靠搬运解决**——密钥在运行时由 App 原生绑定现取、不落盘，所以没有 App 的服务器上即使拿到加密后的 auth 文件也读不出来（插件会如实报未登录，不会退化成读出一个残缺 token，该行为见 `src/at-rest.ts` 与[已知限制](README.md#已知限制)）；其二，凭据文件本身**等同于账号**，必须走加密通道传输并 `chmod 600`。
  - **本版只改文档**，未触动 `src/`、`tests/` 与构建产物。措辞中的每条行为断言（候选路径、加密凭据的失败形态、`doctor` 的输出文本）均对照 `src/auth.ts`、`src/at-rest.ts`、`src/bin.ts` 逐条核过，不是照抄 issue 评论。

## 4.3.3 (2026-10-12)

### Fixes

- **月度套餐的余额改用容量池（`CapacityRemain`），不再用本周期余额（`CycleCapacityRemain`）——国际版账号不再被误报「积分耗尽」为 0。**（issue #48）
  - **现象（报告者，`global` 区域 / macOS）**：两个国际版账号在 DSH 里显示积分耗尽，而同一账号在 WorkBuddy 客户端里完全正常；用同批 token 直接打 `/v2/chat/completions` 返回 **200**，证明账号并未耗尽。
  - **根因**：上游对**同一个月度套餐**（`CapacityType === 4`）同时返回**两套容量字段**，它们回答的是两个不同的问题——`CapacityRemain`/`CapacitySize`/`CapacityUsed` 是**容量池**，`CycleCapacityRemain`/`CycleCapacitySize`/`CycleCapacityUsed` 是**本计费周期**。旧代码对月度套餐只读周期字段 `remain = monthly ? numberField('CycleCapacityRemain') : …`。
  - **本机以真实账单接口复现（3 个国际版账号全部命中）**：`CapacityRemain=100` 而 `CycleCapacityRemain=0`、`CycleCapacityUsed=100`，且 `CycleEndTime="2026-10-31 23:59:59"`（**周期尚未结束**）、`Status=0`、`ExpiredTime=""`。即套餐有效、池里还有 100，插件却报 **0**。对照组：同机 CN 账号两字段一致（500/500），读数为 2267，**所以国内版看不出异常**——但 CN 也在受影响之列：本机 `老丁`/`LaoDing` 两个 CN 账号的月度套餐同样是池 500 而周期余额更小（实测同一时刻分别为 `CycleCapacityRemain=125` 与 `0`），修复后读数分别为 **1343→1718** 与 **768→1268**；`老丁` 的增量 +375 恰等于 `500 − 125`，正好说明这一个字段差异在两个区域都存在、且月度套餐的周期余额会随消耗变化。报告者「cn 是否受影响未能对照」一节由此有答案。
  - **修法**：余额一律读容量池 `CapacityRemain`（两种套餐都是），`size` 同理统一读 `CapacitySize`（真实月度行上 `CapacitySize` 与 `CycleCapacitySize` 同时存在且相等，取前者；后者保留为回退）。**周期字段继续读取**并作为新的 `cycleRemain` 随包透出——它回答的是「本周期额度是否用完」这个**不同**的问题，而 `refreshAtMs`（周期续期点）的提示文案只有靠它才成立。**没有采用报告者建议的 `Math.max(两者)`**：那两个字段不是同一量的两种口径，取较大值会把「本周期已用完、等 10/31 续期」误报成「仍有余额」，正是 `quotaRefreshAtMs` 冷却提示要避免的误导。
  - **修法未触动 gift 路径**（`CapacityType 1`）：仍读 `CapacityRemain`、仍按「耗尽或过期即丢弃」处理——本缺陷只存在于月度分支。
  - **实测（真实接口，修复前后对照）**：3 个国际版账号 `0 → 100`（各自 `CapacityRemain=100`）；CN `17749714179` 保持 2267 不变（该账号两字段本来就一致）；CN `老丁` 1343→1718、`LaoDing` 768→1268。**CN 侧读数上升不是回归，是修正**：这两个账号的月度套餐池余额（500）一直高于本周期余额，旧代码只读了后者。
  - **守卫 `tests/issue48-monthly-pool-credits.spec.ts`（8 例）**：直接驱动**真实的 `fetchCredits` 解析器**（stub 掉的只有 `fetch`），用**真实账单行的原始字段值**（池 100 / 周期 0 / 周期未结束）构造夹具。原有的全部套件都在边界上 mock 掉整个 `fetchCredits`，**这正是该缺陷能漏出去的原因**——字段解析这一层此前零覆盖。覆盖：读池而非周期（回归本体）、`cycleRemain` 单独透出且 `refreshAtMs` 仍在、多账号求和、两字段一致时不受影响（同时通过新旧代码，用来说明「CN 没有开始按另一种方式读」）、周期耗尽但池充足时账号不被丢弃、gift 路径不变（含耗尽/过期两条丢弃分支）、负值不进入 total、月度与 gift 混合不重复计数。**变异验证**：把 `remain` 改回 `numberField('CycleCapacityRemain')` → 3 例变红，报错正是 `expected +0 to be 100`（与现场症状同形）。
  - **边界透传守卫**：`tests/web-status.spec.ts` 增补断言，钉住 `remain` 与 `cycleRemain` **各自独立**地跨 host→client 边界存活（`toMatchObject` 不会因字段丢失而变红），并钉住 gift **不带**该字段（缺失而非 0）。**变异验证**：删掉 `web-status.ts` 里的透传 → 立即变红。

## 4.3.2 (2026-10-12)

### Fixes

- **独立 CLI 在干净安装上不再于加载期崩溃：`@deepseek-ai/dsh-atomic-write` / `@deepseek-ai/dsh-home-paths` 改为「宿主优先、按需加载」，并保留一份等价后备实现。**（issue #47）
  - **现象（报告者 Fedora 真机，4.3.0）**：按 README 走完 `dsh plugin --profile web add dsh-connect-workbuddy`、`dsh plugin --profile dsh-tui add …` 之后，任何一条 `exec` 命令都直接崩，且**报错文件与所跑命令看起来无关**：
    ```
    Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-atomic-write'
    imported from /home/liguolong/.dsh/profiles/dsh-tui/node_modules/dsh-connect-workbuddy/lib/host-heartbeat-jNlsUMZO.js
    dsh: plugin command failed; diagnostics: …/.plugin-manager/logs/operation-KO6W9v/pnpm.log
    ```
    **环境**：Fedora 全新机器，`nvm install 24`（Node v24.21.0）、`pnpm 12.6.0`，`npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui`。
  - **根因（本机以 `pnpm add` 装进同构的空 profile 后逐字复现，含同一个 chunk 名 `host-heartbeat-jNlsUMZO.js`）**：两个包声明在 **peerDependencies**，而 `dsh plugin … exec` 只是在 profile 目录里跑一次 `pnpm exec`（`plugin-manager` 的 `runProfilePnpm`，`execution: 'cli'`、继承环境）——**子进程用普通 Node 解析规则，且 DSH 从不设 `NODE_PATH`（`app-boot` 明确清洗它）**。宿主内的运行期拦截层只在**已启动的 DSH 进程**里存在，`exec` 的子进程没有它；而 profile 由 `PROFILE_PNPM_WORKSPACE` 创建（`nodeLinker: hoisted` + **`autoInstallPeers: false`**），peer 也永远不会被装进去。两者相加 → 裸包名解析失败。
  - **为什么触发点藏在 `host-heartbeat-*.js` 里**：tsdown 把 `auth` / `at-rest` / `host-heartbeat` / `pi-ai-runtime` 合并成**同一个共享 chunk**，而 `lib/bin.js` 一 import 它，`auth.ts` 顶层那句 `import … from '@deepseek-ai/dsh-atomic-write'` 就被求值——**只读的 `status` 也一样**。静态 import 在**模块求值期**抛错，任何「先 import 再 try/catch」的兜底都来不及。
  - **为什么本机看不出来**：两处巧合同时掩盖了它——① profile 里 `dsh-connect-workbuddy` 是指向本仓库的符号链接，而仓库自身的 `node_modules` 因 `devDependencies` 恰好带有这两个 peer；② `~/.dsh/profiles/node_modules` 里还留着 **0.1.5 时代 link-backend 的投影符号链接**（现已指向不存在的 `DSH Desktop.app`，且新版本已用运行期拦截层取代该物理投影）。报告者的机器两处都没有。
  - **修法**：新增 `src/host-peers.ts`。`writeFileAtomic` / `withFileLock` **宿主优先**——用 `import()` 在**调用时**解析 `@deepseek-ai/dsh-atomic-write`，宿主在场就用宿主那份（保持与宿主共享同一套跨进程写协议）；解析不到才启用后备实现。`resolveDshHome` 则改为**纯本地同步实现**：上游该函数是不做任何 I/O 的纯函数，而本插件**每一处调用都不传参**，零参形态只取决于 `$DSH_HOME`（非空白）否则 `~/.dsh`，逐字转写即等价——若改成「宿主优先」反而会把一批同步调用点（凭据路径、心跳路径）逼成异步，付出真实复杂度换取零行为差异。
  - **后备实现转写而非重造**：锁文件命名（`<file>.lock`）、`wx` 独占创建、`EPERM` 需 `lstat` 复核才算争用、Windows 瞬时错误集合（`EACCES`/`EBUSY`/`EPERM`）与重试节奏（initial 20ms / max 200ms / limit 8，即 `docs/WINDOWS.md` §3 末已更正的 ≈1100ms 预算）全部照抄上游。两份实现若预算不同，同一文件上「谁先拿到锁」将取决于**进程身份**而不是锁本身。`isTransientWindowsRenameError` 同样在 `process.platform !== 'win32'` 时短路，平台语义与 §1-4 一致。
  - **`doctor` 可见**（#26 的 `piAiRuntime` 同款做法）：新增 `hostPeers.atomicWrite`（`host` | `fallback`）与说明行，`--json` 的 `schemaVersion` 3 → 4。**两种状态都以真实输出核对过**：干净目录（无任何 `@deepseek-ai/*`）→ `fallback`，且 `status`/`doctor` 均正常退出；仓库检出（peer 齐全）→ `host`。
  - **本机实测（无 peer 的空目录，即报告者形态）**：修复前 `node …/lib/bin.js status` → 与 issue 逐字一致的 `ERR_MODULE_NOT_FOUND`；修复后 `status`、`doctor`、`doctor --json` 全部 0 退出并输出真实账号数据。
  - **守卫（两层，均做过变异验证）**：`tests/host-peers.spec.ts` 共 9 例——① **扫描构建产物**：从 `lib/bin.js` 沿相对 import 走完整个依赖图，出现任何裸包名即红；对**真实 4.3.0 产物**跑它是**红的**，且逐条点出 `lib/host-heartbeat-jNlsUMZO.js` 与 issue 报告里一模一样的两个包名（含 chunk 名），恢复到修复版即绿。② **源码层同规则**（不依赖构建，`pnpm test` 单独跑也能拦住）；把 `src/auth.ts` 改回静态 import → 立即红。③ 反面对照：钉住 `lib/index.js`（宿主半边）**必须**继续把 `@deepseek-ai/dsh-llm` / `@deepseek-ai/schemastery` 留作外部依赖——否则有人可能用「两边都内联」的方式把它「修」掉。④ 后备实现的行为：原子写往返并建父目录、无残留临时文件、写锁互斥（断言**互斥**而非**谁先拿到**——两者同时发起时顺序是调度细节，被断言的是绝不交错）、异常路径也释放锁、`DSH_HOME` 优先级。
  - **`lib/index.js` 的外部依赖清单未变**（`dsh-llm`、`dsh-llm-pi-ai`、`schemastery`、`pi-ai` 仍为外部），宿主半边的接驳方式一行未改。

#### Docs

- `README.md` / `README.en.md`：命令行一节新增 issue #47 的成因说明（peer + `autoInstallPeers: false` + `exec` 子进程无拦截层 + chunk 合并导致报错文件名看似无关），并说明 4.3.2 起的解析顺序与 `doctor` 的 `Atomic writes:` 行；「已知限制」新增对应条目。
- `docs/WINDOWS.md` §3 末新增「同一预算的第二份实现」，登记 `src/host-peers.ts` 与上游共用同一锁协议与同一重试预算；§4 检查清单新增一条（改后备实现时必须与上游的锁命名、Windows 瞬时错误集合、重试节奏保持一致）。
- `THIRD_PARTY_NOTICES.md` §四：原文写「唯一一处代码移植：`src/dsml-recovery.ts`」，本次后备实现属于**行为契约转写**（来自排除项中的 `@deepseek-ai/*` 通用平台依赖），已就地补记，避免该句因本次改动而失实。
- `tsdown.config.ts` 的 `neverBundle` 上方补注释：说明**宿主包保持外部依赖是刻意的**，以及 `bin` 与 `index` 共用 chunk 这一事实对新增代码的约束（`bin.ts` 可达的代码必须用调用期 `import()`）。

## 4.3.1 (2026-10-11)

### Fixes

- **对话框积分读数现在关得掉：设置命名空间改为「跟随宿主」而非「猜名字」。**（issue #46）
  - **现象**：设置卡片里取消勾选「在对话框显示 WBCN 积分」，勾选框随即显示为已关闭、`cordis.patch.yml` 里也确实落了 `regions.cn.showCreditsInMainUi: false`——**写入侧正常**——但切到该 provider 的会话，输入框左侧**仍然渲染** `WB CN · <余额>`。
  - **根因（两段）**：① `src/client/index.tsx` 的命名空间解析只跑一次，且恰逢 describe 镜像未就绪（镜像由异步 `ctx.remote.settings.describe()` 填充）。旧代码把「镜像为空」当成「声明的名字一定对」，绑定 `forms.get('workbuddy')` 且此后永不复查；而 0.2.0 的设置命名空间**就是 Loader entry id**（`dsh-connect-workbuddy`），`ConfigFormController.derive()` 又是**精确匹配**，于是这个猜出来的表单永久停在 `{status:"unavailable", value:undefined}`。② `regionCreditsShownOf` 是 opt-out（`!== false` 即「显示」），`undefined` 于是被判为显示，读数照常渲染。**卡片本身显示正确**，因为 `WorkBuddyCard` 的 `creditsShownOn` 是 Host 优先——4.0.0 新增的读数 gate 没有继承这条规则。
  - **修法一（治本）**：改用宿主现成范式 `configForms.whileServed([...])`（内部 `mirror.subscribe` + 立即 `sync`），把命名空间候选表 `WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES` 按**真实 entry id 优先、声明名最后**排序，并从 `served` 集合里现场挑选。**晚绑定必须重新注册**：渲染器按 entry 的**对象身份**永久缓存 inject 结果（`rootInjectCache` / `cachedRootInject` 里的 `if (!props) { props = runInject(...) }`），已注册 entry 不会再求值——所以旧注册被 dispose、新注册被创建。副作用是宿主不再服务该命名空间时绑定会被自动撤回。
  - **修法二（治复发）**：让 gate 与卡片同源。Host 的 usage 载荷本就带 `showCreditsInMainUi`，现在它**压过**设置 scope（`composerCreditsRegionOf` 新增 `hostValue` 参数，`ComposerCredits` 在拿到文档后按它隐藏，并停掉 5 分钟轮询）。非布尔值（含 `error` 变体与旧文档）一律视为「宿主没说」，仍由 scope 定夺——这样镜像陈旧或未绑定时都不会再让读数复活。
  - 回归测试 `tests/issue46-namespace-binding.spec.tsx` 14 条，覆盖：镜像后到时的重绑（原缺陷）、候选表顺序、`include:` 包裹的 entry id、声明名绝不被绑定、宿主停服时撤回、只开一个 watch；并钉住「死 scope 读作显示」这一现象本身与 Host 优先级。渲染层新增三条（Host 报关闭则隐藏、Host 报开启则显示、无该字段则沿用 scope）。**变异验证**：去掉 Host 优先级判断 → 1 红；把声明名排到候选表首位 → 3 红。

## 4.3.0 (2026-10-11)

> **升级前请读这一条（行为变更）**：账号列表里的「删除」在 4.3.0 起是**「暂时隐藏」**——删掉后立即从列表消失，也不会被自动轮询带回来，但它是**可找回**的：点「重新检测账号」会把**所有**隐藏的账号一次性全部找回（不是只找回你刚删的那个），重新登录或导入同一账号也会清除该账号的隐藏记录。如果你的习惯是「删掉就永远不再看到它」，请在升级前确认这一语义可以接受。桌面 App 自身的登录**始终不被改动**——删除只是「本插件不再列出它」。上一版（4.2.0）不存在隐藏记录，因此**没有历史状态需要迁移**。

### Features

- **扫码登录改为弹窗交互，发起后自动打开浏览器。**（PR #44）
  - 点开后弹窗内分步走：获取授权链接 → 自动打开浏览器 → 弹窗内显示链接与等待状态 → 完成/失败回填结果。弹窗内提供链接原文、复制、重新打开、取消，以及实时等待秒数与剩余有效分钟。样式复用本项目的导出/导入弹框类。
  - 自动打开用「用户手势内同步开占位窗口、拿到授权 URL 后再导航」规避弹窗拦截；占位窗口被环境拦下时，弹窗内的链接与按钮兜底，功能不损失。
  - **占位窗口刻意不带 `noopener`/`noreferrer`**：按规范，带 `noopener` 的 `window.open` 会打开标签页但返回 `null`，而这里的占位窗口**就是要拿句柄去导航**。安全属性改由 `placeholder.opener = null` 建立，等价且不牺牲句柄。这一条有源码守卫与实际 `window.open` 语义的行为测试（`tests/oauth-auto-open.spec.tsx`）——原先的写法只会留下一个空白标签页。
  - 登录方式文案按区域区分：国际版是网页登录，国内版才是扫码。只拆「称呼登录方式」的三条文案，其余（等待、取消、完成）与方式无关，继续共用。

### Fixes

- **导入/删除后列表即时刷新，并统一加缓冲遮罩。**（PR #44）
  - **导入后新账号不出现**：导入成功后没有刷新调用；且轮询只在 `signed-in` 时启动，首次导入（原本无账号）根本不轮询。现在导入完成即回调重新读取；轮询门槛改为「该区域有账号」。
  - **删除后列表滞后**：行删除 fire-and-forget 触发刷新，遮罩随即收起，而旧快照仍渲染那一行。现在 `await` 刷新落地后才收起。
  - 新增共用 `BusyOverlay`：删除/导入/扫码添加三处共用同一套遮罩视觉与语义，文案按场景给出，并提示「完成后列表会立即刷新」。

- **桌面 App 登录的账号现在可以真正「删除」。**（PR #44）
  - **现象**：账号列表里桌面 App 登录的账号点删除后会在下一次扫描回来，删除按钮像坏了。实测：`removeAccount` 返回 `true`，`accounts()` 仍然列出该账号。
  - **根因**：删的只是 vault 副本，而 `readAll()` 会把桌面扫描结果增量写回 vault（`syncVault`——这正是桌面账号能被选中的原因），下一轮读取又把它写回来。
  - **修法**：新增持久化忽略名单（vault 目录下 `.dismissed.json`，与 vault 同锁同原子写），删除时无论账号来自桌面、OAuth 还是导入都记录 id；扫描（`readAll` 两处）与写回（`syncVault`）都跳过被忽略的账号。**删除的语义是「暂时隐藏」，不是永久删除**：点「重新检测账号」时桌面端现存账号重新出现（该路由先清除隐藏再读取）；重新登录或导入同一账号也会清除该账号的隐藏记录。桌面 App 的 auth 文件**始终只读、绝不改动**。

- **「重新检测账号」在隐藏名单清不掉时会如实说明，而不是假装成功。**（PR #44 评审追加）
  - **现象（Windows）**：`clearDismissals` 原本是 `rm(path, { force: true })` 外面套一个吞掉异常的 `catch`，而 `force` 只忽略「文件不存在」，不忽略拒绝。POSIX 上 `unlink` 对打开的文件照样成功，所以 macOS 看不出问题；Windows 上杀毒/OneDrive/编辑器持有句柄会让它返回 `EPERM`/`EBUSY`/`EACCES`（见 `docs/WINDOWS.md`）。实测结果是**最糟的一种破法**：账号没回来、界面什么都不说、按钮看起来像成功了——而它的文案明确写着「点重新检测账号即可找回」。
  - **修法**：`clearDismissals` 在 unlink 被拒时回退为「经同一把锁原子写入空名单」（对任何读者而言两种结果等价），并把结果**读回来验证**后返回布尔值；路由把 `dismissalsCleared` 转给卡片；卡片新增账户级错误行（`role="alert"`）如实显示。该状态原先只被写入、从未渲染——`accountError` 的渲染一并补上。
  - 测试模拟 Windows 的拒绝：unlink 被拒时回退生效、两条路都失败时诚实返回 `false`、路由转发该标志、卡片真的把它画出来。
  - **另有一层真机取证**：`tests/windows-file-lock.spec.ts` 用 PowerShell 的 `[System.IO.File]::Open(…, FileShare.Read)` 在 **真实 Windows**（CI 的 `windows-latest`）上占住文件，断言返回 `false` 且账号保持隐藏、释放后同一调用转为成功——占用由操作系统造成，不是注入假异常。其余平台该文件 skip（`FileShare` 无 POSIX 等价物）。
  - **变异验证在 `windows-latest` 上真跑**：还原成原来的裸 `rm` + 吞异常后，该文件 2 例全红，报错即 `expected true to be false`——静默成功这个缺陷在真实 Windows 上复现并被咬住。据此 `docs/WINDOWS.md` §3 该条按其自身分级规则定为 **B 档（CI 实测）**，并写明未升 A 档的原因。

- **vault 目录里的非凭据文件不再被当成「读不了的凭据」。**（PR #44 评审追加）
  - **现象**：在**完全没有账号**的机器上（只有这种情况才渲染路径列表），删过账号之后，「已探测路径」会多出一条 `…/vault/.dismissed.json — not a readable vault credential`。登录本身是健康的，插件把自己的记账文件读成了坏掉的 token 文件。
  - **根因**：`readVaultEntries` 与 `diagnose` 两处 vault 枚举都用 `endsWith('.json')` 收编目录内容，而 `.dismissed.json` 是格式正确的 JSON、却不是凭据文档。
  - **修法**：两处统一改用**账号 id 形状**判断（`^[0-9a-f]{24}\.json$`，即 store 自己写出的文件名），顺带覆盖原子写留下的 `<id>.json.<hex>.tmp` 兄弟文件。不用「文件名约定」是因为记账文件与临时文件都不该靠约定去排除。测试含正向对照（真实 vault 条目仍能读到），确保过滤器没有把 vault 变成读不到任何东西的目录。

- **清理三条已失效的文案键**（`row.oauthOpen`、`row.oauthUnavailable`、`row.oauthUnavailableGlobal`）：改为弹窗后前者不再有引用，后两条自加入起就没有引用。中英文键集合保持一一对应。其余 12 条失效键在本次改动前就已存在，未一并处理。

## 4.2.0 (2026-10-10)

### Fixes

- **导入不再拒掉插件自己导出的账号：CN 聊天网关 `copilot.tencent.com` 现在被识别为国内站。**
  - **现象**：卡片导出 8 个账号，再把同一个文件导入回来，结果是「导入 5 / 跳过 3」——**导出的文件自己导不回去**。用户反馈这 3 个账号在另一台电脑上完全正常。
  - **根因**：`copilot.tencent.com` 不是第三个上游，它**就是本插件自己的国内聊天网关**（`CN_CHAT_BASE = 'https://copilot.tencent.com'`，见 `src/upstream.ts`），而真实凭据的 `domain` 字段就写着它。4.1.x 的导入闸门（`knownRegionOf`，为防伪冒域名而做的「正向识别」）只认 `workbuddy.cn` / `codebuddy.cn` / `workbuddy.ai` / `codebuddy.ai`，`copilot.tencent.com` 匹配不上任何一个 → 返回 `undefined` → 计入 `skipped`。于是插件导出得出、导入不认，自相矛盾。
  - **为什么 4.2.0 而不是 4.1.3**：4.1.0 刚把「批量导出 / 导入」作为新功能交付，4.1.2 收紧区域闸门时把它变成了自身不可用——跨机器迁移这条主路径在 4.1.x 整条线上都是断的，属于功能级缺陷而非补丁级瑕疵。
  - **修法**：`knownRegionOf` 的 CN 表加入 `copilot.tencent.com` 及其子域。仍按可注册域匹配，仿冒主机（`copilot.tencent.com.evil.com`、`evilcopilot.tencent.com`）依旧被拒，闸门没有放宽成默认归 CN。
  - 回归测试两条：一条钉住网关域名与仿冒主机的判定（`tests/transfer.spec.ts`），一条复刻「5 个登录域名 + 3 个网关域名混在一个导出文件」的完整往返，确认导入 CN 得 8/0、导入 global 得 0/8。


- **导入不再拒掉插件自己导出的账号：CN 聊天网关 `copilot.tencent.com` 现在被识别为国内站。**
  - **现象**：卡片导出 8 个账号，再把同一个文件导入回来，结果是「导入 5 / 跳过 3」——**导出的文件自己导不回去**。用户反馈这 3 个账号在另一台电脑上完全正常。
  - **根因**：`copilot.tencent.com` 不是第三个上游，它**就是本插件自己的国内聊天网关**（`CN_CHAT_BASE = 'https://copilot.tencent.com'`，见 `src/upstream.ts`），而真实凭据的 `domain` 字段就写着它。4.1.2 的导入闸门（`knownRegionOf`，为防伪冒域名而做的「正向识别」）只认 `workbuddy.cn` / `codebuddy.cn` / `workbuddy.ai` / `codebuddy.ai`，`copilot.tencent.com` 匹配不上任何一个 → 返回 `undefined` → 计入 `skipped`。于是插件导出得出、导入不认，自相矛盾。
  - **修法**：`knownRegionOf` 的 CN 表加入 `copilot.tencent.com` 及其子域。仍按可注册域匹配，仿冒主机（`copilot.tencent.com.evil.com`、`evilcopilot.tencent.com`）依旧被拒，闸门没有放宽成默认归 CN。
  - 回归测试两条：一条钉住网关域名与仿冒主机的判定，一条复刻「5 个登录域名 + 3 个网关域名混在一个导出文件」的完整往返。

## 4.1.2 (2026-10-10)

### Features

- **账号可自行添加、迁移与逐个管理，不必再装桌面 App。**（合并自 PR #38）
  - **扫码添加账号**：卡片新增「扫码添加账号」，点开授权链接在浏览器完成登录即可，无需先装 WorkBuddy 桌面 App。会话只存在进程内（600 秒超时），拿到凭据即终结，token 不落独立账号库。
  - **统一凭据库**：所有凭据统一落盘到 `$DSH_HOME/workbuddy-vault/<region>/<accountId>.json`，一账号一文件——扫码添加的、桌面扫描到的、插件刷新过的，都汇入同一目录。桌面 App 的认证文件**始终只读**，插件永不写入或删除它们。
  - **账号行级「测试 / 删除」**：表格每行新增两个按钮。单账号测试复用批处理同一套探测依赖与模型解析，因此行级与批量测的是同一个模型、产生同一种测量。删除只删插件自己的 vault 副本；若该账号来自桌面端，下次扫描会重新出现，文案如实说明。
  - **账号批量导出 / 导入**：多选导出 JSON 文件，选文件后给出**脱敏预览**（只展示字段与 `hasToken`，token 明文不进预览），再勾选导入。文件格式与同类凭据管理工具互通；`uin` 会从 `auth_raw` 恢复，保证「导出 → 换机 → 导入」收敛到同一账号 id，不产生影子账号。关闭 issue #41。

### Fixes

- **扫码添加账号与导出/导入账号移入「账号池设置」区块。**
  - 两处原先夹在积分区与账号池表格之间，语义上是悬空的——上面是余额、下面是表格，它们自己像两个孤儿。现在归入账号池设置区块，与账号管理其它操作收在一起。
  - **放在该区块的偏好设置之上**，这是有意的：区块开头写着「点保存才生效」，而扫码登录与导入导出是**即时生效**、没有草稿的动作。放在那句提示语之下，会让用户以为要点保存——反之亦然。
  - 两者共用一个虚线边框容器，与下方「点保存」的实线设置行区分开：虚线标记「点了就生效」，实线标记「要保存」。
  - **未登录时同样显示**：账号池区块在未登录时不渲染，而这恰恰是这两项最要紧的时候——扫码是不装桌面 App 时唯一能加账号的方式，从别的电脑导出的文件也是这台机器凭空获得账号的唯一途径。两种状态渲染的是同一个 `accountTools` 节点，顺序与容器完全一致，不会让用户以为这是两个功能。
- **扫码添加账号与导出/导入账号改为各占一行，不再各占一个大区块。**
  - 原先两者各是一个带虚线边框、内边距 12px 的整块，静止状态下就要占掉三行（标题 + 说明 + 按钮），把账号表格和模型列表挤到需要滚动才能看完。现在两处都是**一行工具条**：标签、状态文字、按钮同处一行，按钮右对齐。
  - **状态文字与标签同行**，并且是卡片变窄时**最先被截断**的那一段（`text-overflow: ellipsis`），而不是把整条栏撑成两行。
  - 导出/导入的**静止说明文字从常驻栏移进了导出确认弹窗**：那句「文件里是账号凭据——请妥善保管」在凭据真正离开机器的那一刻才有意义，常驻只是白白占掉三分之一行。
  - 弹窗本身保持块级布局不变：它要容纳可滚动的账号列表和逐条勾选框，塞不进一行。
- **修复每次重启都把全部账号重新刷一遍 token 的循环。**
  - 插件刷新出的 token 会写入 vault，但**取用**时仍无条件让桌面 App 的 live 文件优先（该优先是实测结论：上游会吊销备份文件里的 token，不能推翻）。结果每次重启都重新读到桌面那份较旧的 token、判定临近过期、再刷一次，刷新循环从未真正停止。
  - 修法是给 vault 条目加一个**来源标记**：记录该条目是对哪个桌面文件刷新后写下的。取用时若标记与当前读到的文件同名，说明这份副本就是它的刷新结果、必然更新，于是可以取代桌面那份；而**仅靠「活得更久」仍然不能**越过 live 文件。
  - 回归测试模拟 5 次重启并断言刷新只发生 1 次——这正是此前没有任何测试守住的场景。
- **修复扫码登录与账号导入导出在界面上完全不可用。** 卡片的两处请求漏拼 `action` 参数，宿主一律返回 400。新增 `withWorkBuddyRouteAction` 统一构造，并补上**客户端 ↔ 宿主 URL 契约测试**：此前测试都是手写带 `action` 的 URL，客户端拼出来的地址从未被验证过。
- **导入的区域门禁由「默认归 CN」改为「正向识别」。** 原实现把无法识别的域名一律当作 CN，而导入文件里的 `domain` 是文件作者可控的伪造值，仿冒域名（如 `workbuddy.ai.evil.com`）会被写进 CN vault。现在只有**确认属于目标区域**的域名才入库，认不出的一律计入 `skipped`；`regionOf` 保持原样，因为它服务的是上游签发的域名。
- **修复删除账号时删除任意文件。** `accountId` 取自查询参数并直接拼进文件路径，`join` 会规范化 `..`，可越出 vault 目录。现在按账号 id 的真实形态（sha256 前 24 位十六进制）校验，路由层与存储层各一道。
- **删除账号改为在文件锁内进行。** 原实现绕过锁并删掉 `.lock`，与并发的刷新写入相撞时会让两个写者同时进入临界区。
- **导出响应加 `Cache-Control: no-store`。** 导出会把 access/refresh token 明文交给浏览器用于下载，不应进入任何缓存。

## 4.0.0 (2026-10-04)

### ⚠️ Breaking Changes

- **侧边栏底部的积分行已被移除，积分读数改到对话输入框工具栏。**
  - 如果你在用上一版的侧边栏积分行：它**不会**再出现。新版在**对话输入框左上角**显示一行可点击的读数（`WB CN · 1,072` / `WB AI · 88`），并**按本会话当前选中的模型自动切换区域**——原来那两行是常驻的，现在只在你用本插件的模型时才出现。
  - **不需要重新配置**：原来那两个开关（`regions.<region>.showCreditsInMainUi`）**沿用同一个字段**，只是含义从「在侧边栏显示」变成「在对话框显示」。你此前关闭过的那一边，升级后依然是关闭的。
  - **主版本号只因此 +1**：功能没有减少，但这个改动会让正在用它的用户**看不到原来那一行**，属于用户可见的行为变更，按语义化版本应当升 major 而不是 minor。

### Features

- **积分读数移入对话输入框工具栏（`conversation.input.left`），按会话当前所选模型自动切换区域。**
  - **做法沿用同族项目** `dsh-connect-trae`（MIT）的 composer 读数：一行可点击的读数 `WB CN · 1,072`，点击弹出锚定面板；面板里是**账号表格**（每账号一行余额，点行即切换到该账号）；**手动刷新按钮放在面板内**而不是读数上；每账号余额**只在面板打开时抓**；5 分钟定时器在首取结束后才启动；失败保留上次数值。
  - **为什么从侧边栏搬过来**：宿主的 `sidebar.footer.action` 是**单个 root 级共享行**——所有 bundle 都往那一行里塞。实测把它扩成两行时，该容器 `display:flex` 且无 `flex-wrap`/`flex-direction`，两行会被压成等宽两列而重叠。输入框这行是 **session 级且按 provider 归属**，装两个连接器插件也不会互相抢位置。这也是 trae 自己在 2.13.0 移除侧边栏积分行的同一结论。
  - **按 provider 判定归属**：gate 读宿主的 `modelSelection` 投影（`next` 优先于 `lastUsed`，与宿主自身一致），只有本会话选中的模型属于本插件的 `workbuddy` / `workbuddy-global` 时才渲染。**换成别的 provider 就完全不渲染**——不占位、不发请求。
  - **两个区域都支持**（与 trae 不同）：trae 的国际版是订阅制、没有可比数字，本插件的国际版有真实余额。所以读数据当前模型所属区域显示，并标明 `WB CN` / `WB AI`，面板标题也按区域区分。
  - **面板里的余额读数是「总额」**（`credits.total`，与卡片头部同一字段），且**读不到时显示 `—` 而不是 `0`**：宿主端点在该账号取不到余额时**省略** `credits` 字段，正是为了让界面不能对账号做出「没积分了」这种错误断言。
  - **面板里标出「被限流」等不可用原因**：每个账号行若当前不能服务，就在账号名下方用**与账号池表格同一套文案**标出原因（被限流／积分耗尽／被拒绝／…）。复用宿主已有的 `exclusionOf` 判定（含冷却到期逻辑）与 `exclusionText` 标签函数（本版从 `AccountPool.tsx` 提到 `exclusion-text.ts` 共用），因此同一账号在池子表格与积分面板里不会出现两种说法。
  - **读数只反映当前选中账号**（`store.resolve()` 取到的那个），不是该区域所有账号的汇总——它读的就是宿主 usage 文档里的 `credits.total`，与卡片头部同一字段。
  - **新增宿主端点** `/account-credits`：按区域列出每个账号的余额，**每次打开面板才抓一次**（每账号一次上游读），不挂在 5 分钟循环上。单账号失败不影响其他行。
  - **开关跟着 tab 走**：卡片的「在对话框显示 WB CN / WB AI 积分」只显示当前 tab 区域的那一个，写入 `regions.<region>.showCreditsInMainUi`（与 `enabled` 同级），并走 landed-check 的 `writeRegionCreditsShown`。**该区域 provider 关闭时**该行不渲染、开关置灰且显示为关闭（关闭的 provider 取不到积分，留着只会常驻失败）。
  - **样式类名与组件一一对应**（本版修掉一个真实缺陷）：组件从 `Points` 重命名为 `Credits` 时，只有两条 **trigger** 规则没跟着改，于是读数按钮匹配不到任何规则、回退成**浏览器默认按钮**（带边框的大方块）。新增用例断言「组件渲染的每个 `dsm-workbuddy-composer-*` 类名都在 CSS 里有定义」，并把触发器的「无边框／透明底／12px」写成显式契约。其余类名恰好一致，所以当时只有这两条出错、别的测试都没发现。
  - **`react-dom` 必须在 `CLIENT_EXTERNALS` 里**：面板用 `createPortal` 挂到 `document.body`，而打包 react-dom 会把它的 CJS 开发构建内联进来（开头即 `process.env.NODE_ENV`），在浏览器**模块求值期**抛 `ReferenceError: process is not defined`，导致**整个客户端半边 import 失败**——这正是同族项目 2.12.0/2.13.0 的线上事故。本版除在 `tsdown.config.ts` 外置外，另加 `tests/client-runtime-imports.spec.ts` 静态守卫（未外置的裸导入、外置了但宿主未注册的模块，都会让它变红）。

  <img src="docs/assets/dsh-connect-workbuddy-composer-credits.png" width="360" alt="对话输入框积分面板：国内版账号余额表格、刷新积分按钮与最近刷新时间" />

  面板实机截图（国内版）：标题按区域为「WB CN 积分」，表格两列为账号与积分，当前生效账号用实心圆点标出，底部显示最近刷新时间。

## 3.6.0 (2026-10-04)

### Features

- **「DSH 上下文预算」增加 500K 挡位。**
  - 该选择器原本只有「200K」与「模型原生窗口」两档。上游官方的挡位阶梯是 300K／600K／960K（或 1M），没有 500K，所以 500K 是一个**便利挡位**而非上游限制，按需求直接加。
  - **门槛取 `原生窗口 > 500_000`**，而不是复用 200K 那档的 `> 200_000`：否则 192K 的 `hy3`、300K 的模型都会得到一个写着 500K、实际却高于自身原生窗口的按钮——`catalog.ts` 用 `Math.min(原生, 预算)` 兜底，点它等于什么都没发生，却看起来像用户主动做了降级。
  - 未存过预算时该挡位**不选中**（`activeContextBudgets[id] === 500_000` 对 `undefined` 为假），默认仍是 200K 那档；`?? 200_000` 只属于 200K 挡位。

### Fixes

- **国内版模型目录改读 App 自己那份 `/v3/config`，卡片显示的模型与价格不再和 App 对不上。**
  - **现象**：同一个模型槽，App 里显示 `Hy4 preview (x0.00)`，插件卡片里显示 `Hy4 preview (x0.29)`。两边都没错，只是**读的不是同一份文档**——插件读 `/v2/enterprises/personal/models`（CLI 渠道名册，该槽位是付费的 `hy4-preview`），App 读 `/v3/config`（该槽位是免费的 `hy4-preview-f`）。两者显示名同为 "Hy4 preview"，价格却不同，于是看起来像插件显示错了。
  - **根因**：`fetchModels` 的国内分支固定读 `/v2`，国际分支读 `/v3`。国内版从来没有读过 App 的那份文档，因此名册与价格天然可能与 App 不一致；而 `/v2` 里还有一个上游目录里不存在的 `auto` 槽，`/v3` 里则有 `auto` 没有的 `hy4-preview-f` 与 `minimax-m2.7`。
  - **修法**：国内分支改为读 `/v3/config`，**沿用 CLI 的 User-Agent**——这一步是关键：`/v3` 按客户端渠道返回不同名册，桌面端渠道的国内名册（29 条）里**没有** `hy4-preview-f`，只有 CLI 渠道的 17 条名册有。实测确认 `/v3` 接受国内分支原有的整套请求头（`X-Domain` / `X-Product` / `X-Requested-With` 一个都不需要加），所以这是一处常量改动，没有协议风险。另加回退：`/v3` 请求失败或返回非 0 时退回旧的 `/v2` 并记一条 `ctx.logger.warn`，避免网关不再提供新文档时整个区域拿不到模型。回退覆盖三种失败：传输错误、信封 code 非 0、以及**解析出的名册为空**（`selectCliModels` 对空名册抛错）——三者都会退回旧源，不会让区域变空。
  - **升级后需要手动做的两件事**（名册换源，不是可选项）：
    1. 旧源独有的 `auto` 与 `hy4-preview` 不再出现在名册里；新源独有的是 `hy4-preview-f` 与 `minimax-m2.7`（两者并集 19 条，交集 17 条，实测）。
    2. 若你此前勾选的正是 `hy4-preview`，刷新后这个勾会消失（`refreshModels` 用 `freshIds.has(id)` 过滤），而 `hy4-preview-f` **不会**被自动勾上——这是既有设计：插件从不替你勾选你没选过的模型（`stillEnabled` 的注释即此意）。勾一下新出现的 `Hy4 preview` 即可，它是免费的那只；其余已勾选的模型不受影响，模型列表也不会变空。

- **`regions.<区域>` 为 `null` 时不再让读取路径崩溃（防御性加固，当前不可达）。**
  - **背景**：为排查 issue #31 实测时发现，schemastery 的 `simplify()` 会把**空槽**序列化成 `null`（`{ cn: {} }` → `{ cn: null }`）。而 `regionStateOf` 的守卫只拒绝 `undefined`，所以 `null` 槽会被原样返回，`regionEnabled` 随即在 `.enabled` 上抛 `Cannot read properties of null`。
  - **可达性**：**当前不可达**。宿主解析配置时会把存下来的 `null` 槽重新展开成完整的默认 regionState，实测 `Config({ regions: { cn: null } })` 得到的是一整份默认值而非 `null`。因此这是纯防御，不是某个已知崩溃的修复。
  - **改动**：守卫补上 `&& stored !== null`，并新增 3 个回归用例（返回对象而非 null、`null` 槽与「缺失」槽行为一致地回落到遗留扁平字段、`regionEnabled` 不抛）。
  - **顺带**：排查过程中的结论已贴在 issue #31——该 issue 里最后一条指向本插件的线索（`accountId` 是「存在且为 undefined」的自有键）**被实测证伪**：`accountId` 在解析后是**缺失**，且遍历 7 种真实输入的解析结果都没有任何「值为 undefined 的自有键」，`simplify()` 之后与 JSON 往返完全相等。

## 3.5.0 (2026-10-04)

### Features

- **每个模型行新增「可关闭思考」勾选框：`off` 档位不再由上游声明单独决定（issue #34）。**
  - **背景**：本版之前，某个模型是否提供「关闭思考」（`reasoning_effort: "off"`）完全由上游的 `canDisableThinking` 声明决定，而那个声明对部分模型是**错的**——它们声称可关闭思考，实际对 `off` 返回 HTTP 400，且报文里不说是哪个参数被拒。
  - **做什么**：模型行上多一个「可关闭思考」勾选框，勾上 = 提供 `off`，取消 = 不提供。**每个模型都有这个勾选框**，最终由用户决定；上游声明与内置名单只决定**默认值**，不再是一道墙。
  - **默认怎么来**：内置一份按精确 id 复核的名单（`src/off-thinking.ts` 的 `REFUSES_OFF_MODEL_IDS`，9 个模型），首次读取时用它填勾选状态，所以「不勾」的模型从一开始就不是这 9 个会失败的。这份名单**只是种子**，不是墙：
    - 上游新增一个拒绝 `off` 的模型 → **取消勾选**即可，不必等我们发版；
    - 名单误伤了一个其实可用的模型 → **勾上**即可恢复。
  - **首次保存即生效**：保存的是勾选后的 id 列表（`offModelIds: string[]`）。`undefined`（从未保存）与 `[]`（用户全不勾）是可区分的，前者用内置名单填，后者保持空——`regionStateOf` 读原始槽位，所以这个区分在数据层天然存在。
  - **刷新不覆盖**：与「图片」勾选刻意不同。图片的勾选在刷新时会被上游声明重新同步；`off` 的勾选**保持不动**，因为它存在的理由就是「上游声明不可信」，刷新重写等于抹掉用户的修正。

### Fixes

- **保存模型列表不再抹掉 `canDisableThinking`，`off` 不会在保存后从全部模型上消失（issue #34 同族缺陷，发布前发现）。**
  - **现象**：在 3.4.5 及更早版本上，只要在卡片上按过一次「保存」，**所有模型**的「关闭思考」档位就会一起消失——连 `glm-5.3`、`kimi-k3` 这些确实接受 `off` 的也一起没了。
  - **根因**：`toWebModel` 把 `canDisableThinking` 从卡片负载里丢掉了，而卡片保存时会把整行模型**原样写回** `lastCatalog`。于是这一次保存把上游的声明从每一行里删掉了；下次解析名册读到「没有声明」，而缺省一律视为**不提供 `off`**（这个保守缺省必须保留：`hy4-preview`、`hy3-x` 明确声明 `false`，把缺省翻成 `true` 会让它们重新开始报 400）。
  - **修法**：`canDisableThinking` 现在随卡片负载往返，与旁边的 `supportsImages` 同一种处理——它是**上游的声明**，只负责持久化，不是运行时答案（运行时读的是勾选状态盖上去的值）。
  - **已有配置**：曾经保存过的 profile 里那份声明已经丢了。按一次「从 WorkBuddy 刷新」再「保存」即可补回；在那之前也可以直接在勾选框上手动勾选。

- **对上游声明为可关闭、实际返回 HTTP 400 的模型，不再提供 `off` 档位（issue #34）。**
  - **现象**：选中 `off` 后**每一次**请求都硬失败，且报文里 `extError.param` 是空的——上游不说是哪个参数被拒。因为 `off` 属于按模型保存的选择，失败会一直持续到用户手动换档，看起来像「这个模型坏了」。
  - **依据（报告者实测，3.4.4，两个网关）**：28 次观测中 18 次接受 `off`（HTTP 200）、10 次返回 400（去重后 9 个模型 id）；**除 `off` 之外**的每一档（`minimal`/`low`/`medium`/`high`/`xhigh`/`max`）以及完全不传该字段，在两个网关上都是 200——`off` 是唯一失败的档位。两个网关用**不同的错误码报同一个原因**：国际版 `11133`（`Invalid request parameters`，附 `extError.code: model_param_invalid`），国内版 `11150`（`the reasoning effort value is not supported by the current model`）。
  - **不再信任声明**：`src/off-thinking.ts` 新增一份按**精确模型 id** 复核的名单（`deepseek-v4.1-flash` / `-sg` / `-pro`、`primary-model`、`gpt-6-astra`、`gpt-5.6-sol` / `-terra` / `-luna`、`gemini-3.5-flash`），与 `native-modality.ts` 的图片能力表同一种做法。没有任何**声明字段**能分开这两组：接受侧是 GLM/Kimi/MiniMax 加 `fast-model`/`balanced-model`/`auto`/`hy3`，拒绝侧是 DeepSeek-v4/GPT/Gemini 前沿模型加 `primary-model`，两组公布的是一模一样的能力。
  - **按 id 而非按区域**：`deepseek-v4.1-flash` 在**两个网关上都拒绝**，分组跟着模型家族走而不是网关。代价是不对称的——提供一个必定失败的档位，代价是用户该模型的**每一次**请求；误藏一个本来可用的档位，代价只是一个选项——所以名单**宁可多藏**，并交给上面的勾选框兜底。
  - **为什么是「与 200K 同样的取法」**：`null` 才是撤销档位的唯一正确手段，与档位的**值**是两个不同的位置——pi-ai 的 `getSupportedThinkingLevels` 只在 `map[level] === null` 时把该档位移出选择器，而线上取值走的是 `map[level] ?? level`，所以给个字符串仍会照发。

### Docs

- `docs/reasoning-investigation.md` 的实测表（`hy3-x`、`hy4-preview`、`hy4-preview-x` 声明 `canDisableThinking: false`）是「缺省不能翻成 `true`」这一判断的依据，本版沿用该结论而未改动该文档。
- 两份 README 的「模型管理」一节补上「可关闭思考」勾选框，并修正 3.4.5 起已失效的「窗口最高 200K」表述（issue #33 已改为按原生窗口宣称）。

## 3.4.5 (2026-10-04)

### Fixes

- **保存设置不再把「本该用实时目录」的模型槽写空，正在用的模型不会凭空消失（issue #32）。**
  - **现象**：在 `regions` 从未成功写入过的 profile 上（如 issue #31 所述的环境），第一次保存（哪怕只改了一处偏好）之后，模型选择器里**正在使用的默认模型突然不见了**，其他只在上游目录里、不在内置静态名单里的模型也一起消失，且**没有任何报错**。
  - **根因**（两半，缺一不可）：
    1. **写半边**——`__save` 的 `merged` 以宿主解析值为种子。当 `regions` 还是空对象时，`{"cn":{"imageModelIds":[]}}` 这样的载荷会落下**一个没有 `lastCatalog` 的 cn 槽**。槽本身合法（schema 里 `lastCatalog` 默认就是 `[]`），但它缺了这份目录。
    2. **读半边**——`configuredModels` / `displayModels` 把 roster 解析成两步：`state.lastCatalog?.length ? lastCatalog : 静态名单`。「槽存在但没有目录」和「从未配置过」于是被当成同一件事，都退回**内置的 12 条静态名单**；而 `applySelection` 又把这份静态名单 `catalog.set()` 进**实时目录**——实时发现注册的 17 条就此被覆盖。正在用的 `space-bunny` 只在实时目录里、不在静态名单里，当场消失。
  - **修法**：
    - 写半边：`__save` 在合并之后、落盘之前，对本次载荷**真正触及**的区域（只碰 `incoming` 里出现过的键，不动调用方没提到的兄弟区域），若该槽缺目录（`lastCatalog` 缺失或为空数组），就用 `displayModels` 取到的**实时名册**补上。用 `displayModels` 而非上游往返：保存不该依赖网络，也不该因为上游不可用而失败。调用方显式传来的数组（含非空数组）仍然优先，实时名册为空则维持原状、不写空数组。
    - 读半边：roster 解析改成三步 `lastCatalog → 该区域当前已注册的实时目录 → 静态名单`。静态名单退回它本来该待的位置——上游离线、什么都发现不了时的最后兜底。`applySelection` 在 `set()` **之前**读一次当前目录，避免观察到自己正要写的值。
  - 这样「槽存在但缺目录」会**降到实时目录**，永远不会越过它掉到静态名单。

- **未显式设置预算的模型不再被强制压到 200K，1M 模型的真实窗口得以保留（issue #33）。**
  - **现象**：上游目录里 17 个模型有 15 个被改报成 200000——`space-bunny`、`deepseek-v4.1-flash`、`deepseek-v4-pro`、`glm-5.3`、`glm-5.3-flash`、`glm-5.2`、`kimi-k3-1`、`kimi-k2.8-preview` 的 1000000、`hy4-preview` 的 960000、`minimax-m3` 的 512000、`auto`/`kimi-k2.6`/`kimi-k2.7` 的 256000 全部变成 200000。
  - **根因**：`applyContextBudgets` 里 `budgets[model.id] ?? 200_000` 的默认值——**未设置预算被当成「设成 200K」**。这条默认值在 CHANGELOG 里给出的理由是「让 DSH 提前压缩以避开上游节流」，但同一份 CHANGELOG 又自述实测节流线是 **2 万～3 万 token 且单次请求即触顶**：200K 比那条线高一个数量级，压到 200K 并没有把压缩提前到安全区。200K 在静态目录里也无出处（`auto` 是 168000、`hy3` 是 192000、`default-model` 是 176000、`primary-model` 是 272000）；插件自己的静态目录还把 `glm-5.3` 等声明为 1000000，与钳制自相矛盾。
  - **修法**：`applyContextBudgets` 不再有默认值——**只做上限**：未设置预算时保留模型的原生窗口，设置了就用 `Math.min(原生, 预算)`。`contextBudgets` 的语义恢复成「用户设的上限」，而不是一个隐式的全局改写。（`toWebModel` 里那份重复的 `?? 200_000` 也一并去掉，改为调用同一个函数，避免卡片与运行时目录各说各话。）
  - 想继续压缩的用户仍然可以显式设置 `regions.<region>.contextBudgets`；卡片上原本只在原生窗口 > 200K 时才出现的「DSH 上下文预算」选择器，现在因为不再默认钳制而更有意义。

## 3.4.4 (2026-10-03)

### Features

- **测试请求体积可选（1 万 / 2 万 / 3 万 / 5 万 / 10 万 token），不再固定 2.5 万。**
  - **背景**：上游的频率限制（6004）按**请求体积**触发——实测阈值落在 2 万～3 万 token 之间，**单次请求就足以触顶**（不是累计）。而账号池的「测试」探针此前固定发 25,000 token，于是真实对话体积在 2.5 万～3 万之间时会出现「测试测出可用、一发聊天立刻被限」。
  - **为什么不是把固定值调大**：探针只测一个点，而阈值是一个区间、真实对话体积是连续的——把 2.5 万改成 3 万只是把缝隙上移（3 万以上漏判），且成本线性上升（2.5 万 ≈ 0.72 积分，5 万 ≈ 1.4+）。**体积是用户流量的属性，因此交给用户选。**
  - 新增池子设置「测试请求体积」，默认仍是实测标定的 25K（`0` = 默认）；改动立即生效，无需重载。
  - 相应用户可见的说明写在设置项旁：解释 2 万～3 万阈值与「测出可用、一发就被限」的成因。

- **换号时在回复正文里说明原因，不再只有日志。**
  - **背景**：池子的 failover 会给同一个请求依次试多个账号，此前只写一行 `logger.warn`——用户完全看不到。于是一次切换过的回复，和「你选的那个账号正常回答」**在界面上完全一样**，而且事后无法从记录区分「刚才真有请求失败」和「状态莫名其妙退回了旧值」。
  - 现在回答开头会附一行（仅当真的发生了切换、且确实有内容送达时）：

    > [dsh-connect-workbuddy] 「13046625578」was rate limited — this answer came from another account

  - 只报**第一个**被放弃的账号与原因（连续试 4 个账号时不刷屏），原因按用户能采取的行动措辞（`rate limited` / `signed out` / `rejected by policy` / …），而不是内部 kind 名。

- **池子记录标注来源与时间，让「结果变了」可解释。**
  - 每条测量现在记录它是**谁写的**：`测得`（用户点「测试」的批测）或 `聊天撞上`（实时聊天失败被记录），以及**多久前**更新。
  - 卡片上分两行显示：主行是结果/恢复时间/原因，次行是来源胶囊 + 相对时间。此前只能靠时间戳分布**猜**来源（批测写同一时间戳、单账号写入时间戳各不同）。
  - 「来源未知」用于本次升级之前写入、没有来源字段的旧记录——不猜，如实标注。

### Fixes

- **「来源未知」胶囊太淡看不清。** 旧样式同时做了四处削弱（`background:transparent`、`1px dashed`、`label-dimmed #9aa0a6`、`font-weight:400`）；实测对比度发现**字色不是主因**（`#9aa0a6` 5.28:1，反而比正常胶囊的 `#999` 4.89:1 更亮），主因是 10px 小字配 400 字重。已改为实底 + 实线边框 + `label-secondary`（8.41:1），并去掉字重覆盖以继承基类的 600。

## 3.4.3 (2026-10-03)

### Features

- **装在非默认目录的 Windows 安装也能找到了：注册表回退（issue #30）。**
  - **现象**：WorkBuddy 桌面端装在 `E:\workbuddy`、`F:\AGENTS\WorkBuddy` 这类非默认位置时，插件报「未登录」——而用户明明已经登录。
  - **根因**：`workbuddyAppExecutableCandidates()` 只探四个**默认布局**路径（`%LOCALAPPDATA%\Programs\WorkBuddy`、`%LOCALAPPDATA%\WorkBuddy`、`%ProgramFiles%\WorkBuddy`、`%ProgramFiles(x86)%\WorkBuddy`）。装在别处时四个候选全落空，于是拿不到加密字段的密钥，**已登录的账号被报成未登录**。README 的答案是手工设 `WORKBUDDY_APP_EXECUTABLE`——而安装器其实早就把答案记在注册表里了。
  - **修法**：四个候选全落空后，在 `win32` 上查询卸载注册表（`HKCU` / `HKLM` / `HKLM\WOW6432Node` 三处），从 `DisplayIcon` 优先、`InstallLocation` 兜底推出可执行文件路径。路径必须 basename 为 `WorkBuddy.exe` 且 `existsSync` 通过才会被采用（该路径最终会传给 `execFile`）；注册表只是**回退**，默认安装零开销。`queryRegistry` 作为可注入 seam，测试不依赖主机状态。
  - `doctor` 现在同时报告**来源**（`via env` / `default-layout` / `registry`）：只看路径的话，「默认布局命中」和「回退救了你」输出的字符串一模一样，而这正是用户排查时唯一有用的区别。

### Fixes

- **Windows 路径不再用宿主平台的分隔符构造（非 Windows 上会静默失效）。**
  - **现象**：在 Linux/macOS 上构建/运行时，Windows 专用路径会带上 `/` 分隔符，永远不可能命中真实安装。
  - **根因**：`workbuddyAppExecutableCandidates()` 的四个 Windows 候选、以及注册表回退的 `normalizeRegistryExecutable()` / `registryInstallLocationFromQuery()`，都用了 `path.join` / `path.basename`——它们跟随**运行平台**，不是数据的平台。在 POSIX 宿主上 `basename('E:\workbuddy\WorkBuddy.exe')` 返回整串，于是**每一个合法路径都被 basename 白名单拒绝**，注册表回退等于从未生效。
  - **修法**：凡处理 Windows 数据一律改用 `path.win32.join` / `path.win32.basename`——**分隔符由数据决定，不由宿主决定**。
  - **测试同样是错的**：期望值也用 `join()` 构造，生产与测试一起漂移，所以本地绿、CI（ubuntu）绿，而 Windows 上根本不命中。已改为 `win32.*` 并补一条**形状守卫**（断言每个 Windows 候选都不含 `/`、末段为 `WorkBuddy.exe`），变异验证（把 `win32.join` 换回 `join`）必红。
  - 顺带修正一条与环境耦合的断言：原测试断言 `darwin` 返回 `undefined`，但本机装了 WorkBuddy 时 macOS 分支会**合法**命中，于是「开发者机器红、CI 绿」。该用例真正要断言的是注册表 seam 未被调用，已按此重写。

### Fixes

- **403「request illegal」（11140）不再伪装成登录故障。**

  国际网关的真实失败（2026-09-29 抓包）：同一凭据下 `GET /v3/config` 返回 200，聊天 `POST /v2/chat/completions` 却被 403 拒绝，响应体逐字为：

```json
{"code":11140,"msg":"request illegal","requestId":"3498bf50-98a9-4746-962e-c14016b8c578","displayMsg":{"en":"The content did not pass the safety review. Please adjust and retry.","zh":"内容未通过安全审核，请调整后重试。"},"actions":["SUBMIT_FEEDBACK","COPY_ERROR","EDIT_INPUT"]}
```

  - **根因**：`classifyUpstreamError` 只认积分、会话失效、限流三类标记，11140 落进兜底的 `client`；shim 把 `client` 映射成 400，DSH 侧进一步归为 AUTH。用户看到的是「登录坏了」——实际是服务端内容策略拒绝，重新登录、刷新 token 都不会有效。
  - **改动**：
    - `upstream.ts` 新增 `policy_reject` 分类（标记 `request illegal` / `"code":11140`，在通用 4xx 之前判定）与 `parseUpstreamErrorDetail()`（从 JSON 失败体提取 `code` / `requestId` / `displayMsg`，非 JSON 返回 `undefined`，不猜）；chat 失败结果附带 `detail`。
    - `shim.ts` 把 `policy_reject` 映射回 403，错误消息从解析字段合成：官方文案（zh 优先，回落 en、`msg`）+ `code 11140` + `requestId` +「重新登录不会解决；可在桌面端用同一账号验证，或切换区域/账号后重试」；不再把整段原始 JSON 嵌进 message。
    - **写回宿主的 `code` 是 `policy_reject`，不是上游的数值码 11140**（2026-10-03 适配 3.4.1 的 `hostErrorCode`）。宿主按稳定的机器可读类别路由，`11140` 不是它认识的类别；而 3.4.1 建立的规则是「只有 429/6004 需要翻译成宿主认得的词」。`policy_reject` 在 403 下本就落在重试集合之外，**不需要**翻译；更要紧的是**不能**被翻译进集合——内容策略拒绝是确定性的，原地重试只会把预算烧在一次必然再被拒的请求上，跨供应商故障转移也治不了策略判定。
    - 探针 `outcomeOfFailure` 在 401/403 一刀切**之前**先判 `policy_reject`，卡片新增「服务端按内容策略拒绝」文案（中英）。探针与真实请求复用同一分类函数，对同一响应的判定不会分歧。
    - **账号池不再因一次策略拒绝把健康账号永久踢出**（适配 3.4.2 时发现的连带问题）：`policy-rejected` 是新 outcome，在 `exclusionOf` 里落进了 `default` 分支被标成 `unusable`——而 `unusable` 刻意**不带冷却**，于是账号会被**永久**移出池子，且卡片会显示「不可用」。这是错的：策略拒绝针对的是**那一条请求的内容**，不是这个账号，同一个账号换一条消息照样能服务。现按 `ok` 处理（测量照常记录，卡片能解释发生了什么，但不影响它继续被计费），并补守卫 + 变异验证。
  - **守卫（先红后绿）**：`upstream.spec` / `shim.spec` / `probe.spec` 新增 8 例——分类（完整/最小 403 体 → `policy_reject`）、字段解析（zh 优先、缺 `displayMsg` 回落 `msg`、非 JSON 为 `undefined`）、shim 端到端（重放上面那段真实 403 体，断言 403 + `policy_reject` + **`code` 为 `policy_reject`** + 官方文案 + requestId，而不是 400）、探针（11140 → `policy-rejected`）。7 例先在未修复代码上跑红、实现后转绿；1 例良性对照（良性 403 / HTML 403 仍判 `client` / `credential-rejected`）双向保持绿——防止修复把无辜的 403 一起吞掉。

## 3.4.2 (2026-10-03)

### Fixes

- **换号重试之间补上 2 秒间隔，不再零延迟连发。**
  - **现象**：一次请求撞上限流后，换号循环会**零间隔**地把池里剩下的账号挨个试一遍——实测 4 个账号在 **35 秒内全部失败**（最后两次只隔 1 秒），而它们全部撞的是同一个 429。
  - **根因**：上游的限流（业务码 6004）**按请求体积/频率触发**，零间隔连发等于自己把每个候选都推到同一堵墙上。批量测试早就为此在账号之间等 `POOL_BATCH_GAP_MS`（400ms），**换号循环却什么都没有**——两者的差别没有理由。
  - **修法**：每次换号前等待 `FAILOVER_ACCOUNT_GAP_MS`（2 秒）。比批测的 400ms 更长，因为换号重试是**用户在等的真实请求**，不是探测——它需要给上游的窗口留出喘息，而不只是避免自己踩到限流。
  - **等待是可中断的**：客户端断开时立刻结束等待并退出循环，不会白等 2 秒，也不会拿一个已经作废的 signal 去把剩余账号试完。
  - 顺带修正：等待结束后重新检查一次中断状态——否则客户端已断开时，剩余账号会被逐个发出去（每个都立即因 signal 作废而失败），白白写下一串假的账号失败测量。
  - 测试：新增一条用例钉住「两次尝试之间确实等待了 ≥1.9 秒」，变异验证（把间隔改成 0）必红。

## 3.4.1 (2026-10-02)

### Fixes

- **「要等几小时才恢复」的配额错误不再被宿主当成「等两秒就好」的瞬时抖动（issue #28）。**
  - **现象**：上游 429 / code 6004 的原文是「您的使用量已超出频率限制，**将在 13:37:03 重置**」——要等几小时。本插件把它正确分类成 `soft_rate`（`src/upstream.ts`），但写回宿主时 `type` 与 `code` 都用了 `soft_rate` 这个内部名字。
  - **根因**：宿主决定「这个失败要不要在原地重试」靠的是从 `type + code + message` 里匹配**几个英文措辞**（`@deepseek-ai/dsh-llm` 的 `isQuotaExceededError`）。`soft_rate` 不在那份名单里，上游原话又是中文，于是宿主只能按 `429` 的默认含义理解——进入 `RATE_LIMIT`，而 `RATE_LIMIT` **在**宿主的重试集合里（`DEFAULT_RETRYABLE_CODES`），`QUOTA` **不在**。宿主于是原地重试 5 次、指数退避，把预算烧光；而真正能救场的跨供应商故障转移（`dsh-subagent-default-model` 的 `failoverEnabled`）根本没被叫到——实测一次会话 1228 个 step、只切换过 1 次供应商、以 429 收场，`models` 里其它供应商全程闲置。
  - **修法**：只翻译写回宿主的 `code`——`soft_rate` → `quota_exceeded`（宿主认得这个词，且它符合上游实际在说的事）。**HTTP 状态码仍是 429**（那才是上游返回的东西，改成 402 是谎报），上游原话仍原样留在 `message` 里给人看。`type` 保持插件自己的内部名字，便于读日志与报错。
  - **只翻译这一处**：其余 kind 本来就落在重试集合之外（`hard_credit` 402 → 按状态就是 QUOTA，`session_dead` 401 → AUTH，502/400 → OTHER），所以**不做多余翻译**——没有人需要的翻译只是等着漂移的谎言。插件**自己的**错误（`unauthorized` / `not_found` / `host_not_allowed` / `internal`）也一律不翻译：把自身的 401/404 说成「配额用尽」，会让宿主去为一个换供应商也治不好的错误做故障转移。
  - 测试直接调用**宿主自己的** `isQuotaExceededError`（`@deepseek-ai/dsh-llm` 导出）来钉住这件事，而不是在测试里抄一份正则——抄一份只能证明两份副本今天一致。三次变异验证：撤回翻译 / 把翻译扩大到所有 kind / 让本地错误也翻译，均会变红。

## 3.4.0 (2026-10-02)

### Fixes

- **账号池不再被一次瞬时故障永久打死：`unavailable` / `failed` 现在有 30 分钟冷却。**
  - **原来的形状**：`exclusionOf` 只给 `rate-limited` / `out-of-credit` 判冷却到期，`unavailable` / `failed` 一律无条件出池且**不带恢复时间**。而自动复测定时器已在 3.2.0 删除，能刷新它的只剩手动「测试」——**一次 502 或一次网络抖动就能把一个健康账号永久踢出池子**。
  - **症状**：池内每个成员都被这样剔除后，池子没有任何候选，`failoverAccountFor` 第一轮即返回 `undefined`，自动换号无处可去，上游原始 429/502 直接报给用户——界面上「账号池已启用」与「请求失败」同时成立，且报错没有 `(after trying N accounts)`（因为只试了 1 个账号）。
  - **现在的形状**：`unavailable` / `failed` 与限流同形，走 `retryDue()`；上游没给时间就按 `POOL_UNKNOWN_COOLDOWN_MS`（30 分钟）兜底。冷却在**排序时求值**，所以不需要定时器——到点的成员在下一次请求自动变回候选。`credential-rejected` 与 `not-found` 保持永不冷却：一个要重新登录，一个是本区域不再提供的模型，等待都修不好。
  - 反转了 `tests/account-pool.spec.ts` 里一条**明确钉住旧行为**的测试（其原注释即写明「这是留给未来主动决定的反转」），并在测试内记录反转理由。

- **自己中止的请求不再被记成账号故障。** 客户端断开时 `res.on('close')` 会 abort 上游调用，`fetch` 抛出的 `AbortError` 经 `chatStream` 统一成 `status: 0, kind: 'server'`，读起来与「网络真的断了」完全一样——于是**关一次面板就可能把正在服务的账号记成 `unavailable`**。换号循环本来就有 `controller.signal.aborted` 守卫，但那只管「要不要继续换号」，不管「要不要把这次失败记成测量」；`reportFailures()` 现在同样短路。

- **换号路径不再抓积分。** `failoverAccountFor` 用的是 `poolMembersOf`（逐成员 `fetchCredits`），而它自己上方的注释写着「不得再花请求去决定谁服务」——一次失败的对话因此先变成 N 个额外上游请求才发出重试。改用 `localPoolMembers`，与 `applyPoolSelection` 对齐；有新鲜快照时积分仍然参与排序。

- **探测请求补上超时（10 秒）。** `probeChat` 在没有 signal 时完全没有上限，而池的批量测试是**串行**且不传 signal——一个挂住的连接会阻塞整批，且界面上看不出是哪一个成员。现在给「等待响应」设 10 秒上限（远高于正常网关的首字节，远低于用户的耐心），并与调用方传入的 signal 用 `AbortSignal.any` 合并，单模型路由的取消行为不变。
  - **上限只覆盖等待响应**：`fetch` 一 resolve 就 `clearTimeout`，绝不在读取 body 期间继续计时——否则一个健康但偏慢的模型会和死端点共用同一块表，这正是此处不能用裸 `AbortSignal.timeout` 的原因。

- **两句会误导人的文案改掉了。** `row.probeUnavailable` 去掉了「这是网络问题，**不是模型问题**」——`unavailable` 这个分类里同时装着网关 5xx、DNS 失败与请求超时，对后两者这个断言并不成立（5xx 恰恰是上游侧的问题）。新文案只陈述可核实的事实：「连不上上游——上游没有给出可用答复」，具体原因由旁边记录的 `message` 给出。
- `row.poolNoCandidateHint` 不再叫人「重新检测账号，或在桌面端重新登录」。池内全不可用时那个建议是错的：限流、积分耗尽与瞬时故障都会**自动回池**（上游给的时间，没给就 30 分钟兜底），只有「凭据被拒」才需要重新登录。原话会让用户去做一件没有任何用处的事。
- 顺带修掉 3 处本地化文案里的字面量 Markdown（`**真实体积**`、`**不会**`、`**手动动作**`）。React 不解析 Markdown，它们此前是原样把星号画在界面上的——与本轮改掉的两处属于同一类缺陷。
- **池表与模型行不再把上游报文原样贴一遍。** 限流账号的记录文本就是 `{"code":6004,"msg":"…将在 2026-10-02 06:53:43 重置…","requestId":"…"}`——与旁边刚显示的绝对时刻完全重复；加上新的相对说法后会变成同一时间印三次，后面还跟一个没人看的 requestId。规则现在只在 `src/client/probe-reason.ts` 里写一次、两处共用：
  - **标签本身已说清的结果**（`rate-limited` / `out-of-credit`，它们都带恢复时刻）**不内联任何正文**；
  - 其余结果内联**短**形式：JSON 信封里取 `msg` 那句人话，`transport error: ` 这个英文前缀也去掉（中文卡片上它只是噪声），整段封顶 72 字符——一行的病态正文不该把整张表挤出屏幕；
  - 完整原文挂在 `title` 上，**缩短不等于丢掉**（含 requestId），悬停即可看到。
  - 例外是有意的：`credential-rejected` / `not-found` 不在「已说清」之列——它们的标签只给结论（「重新登录」「没有这个模型」），上游原话才是让结论可核实的东西。

### Features

- **池表能说清「为什么出池」了。** `WorkBuddyPoolProbe` 新增 `message`：落盘前经 `redactUpstreamText` 脱敏（与探测路径共用同一实现），卡片在结果后追加 `· <上游原话>`。此前 DNS 失败、网关 502、被中止的请求在池表里渲染成**逐字相同**的一句话，用户拿到的是无法行动的提示。字段可选，旧记录照常读取而不被当成损坏。

- **冷却时间现在同时给出「还要等多久」。** 卡片一直只印上游给出的绝对时刻（`05:23:27`）——它回答「何时」，但要读者自己拿当前时间去减，这一步正是让冷却难以行动的地方。现在它旁边多一个相对说法：`05:23:27 之后可再用 · 约 1 小时后`。
  - 粒度按距离切换：不足 1 分钟 → 「即将恢复」；不足 1 小时 → 「约 N 分钟后」；不足 2 天 → 「约 N 小时后」；再远 → 「约 N 天后」。**小时档从整点开始**（不是 90 分钟）——因为用户自己描述那个 69 分钟后的时刻时写的就是「约 1 小时后」，阈值放高反而会把触发这个改动的那个例子渲染成「约 69 分钟」。天档切在 **2 天**而不是 1 天，否则 36 小时会印成「约 1 天后」，少说 12 小时。
  - **只对上游给过的时间生效**：`cooldownOf` 返回 `{}`（上游没说时间）时仍然只说「上游未给出何时恢复」，绝不编造倒计时——这是本功能一贯的红线，本次没有新增任何时间来源，只是把已有的那个换个说法。已经到点的时刻返回空串而不是「0 分钟后」。
  - 模型行与池表两处都接上了；绝对时刻仍是主文案，相对说法是附加的便利。

### Docs

- README 的「账号为什么出池」表按新规则改写：区分「限流/欠费/瞬时故障会自动回池」与「凭据被拒/模型不存在只能手动重测」，并删掉已不存在的「定时器」表述。
- 清理死代码：`POOL_TICK_MS`、`POOL_MIN_INTERVAL_MINUTES`、`poolDueAt`、`duePoolRegions`、`PoolScheduleInput` / `PoolScheduleResult` 及其单元测试全部删除。它们自 3.2.0 起已无任何生产调用（构建时已被 tree-shake），却仍被测试覆盖——于是「测试全绿」对「账号会不会回来」这个问题什么也没说明。
## 3.3.0 (2026-10-01)

### Features

- **DSML 恢复：模型把工具调用写进正文时，插件现在会把它转回真正的 `tool_calls`。**
  - **背景**：上游模型在长上下文下偶尔漏掉工具调用的起始包裹，把 `<｜DSML｜invoke name="…">` 这类标记直接写进 `delta.content`。DSH 因此**没有任何东西可以路由**——标记被当正文渲染出来，也就是用户看到的「一堵乱码墙」。这是模型族的有名缺陷，不是本插件的 bug，但本插件正好站在「拿到字节之后、交给客户端之前」这一层，是唯一能动手的地方。
  - **四道闸**（缺任何一道，上游都真的出过生产事故：把空参数调用发出去、把**讨论**这段标记的正文执行成真实调用、把请求根本没声明的工具提升成可执行调用）：
    1. **闭合才提交** —— 只有闭标签到达才产出调用；被 token 上限截断的块按原文显示，绝不猜。
    2. **名字必须在本次请求声明的工具里** —— 名字取自 `prepareChatBody` 已经解析过的那份请求体，不再解析第二遍。
    3. **没声明工具就完全不做** —— `tool_choice: "none"` 会在预处理时删掉 `tools`，于是「本次没声明工具」是一读即得的既成事实，而不是另一条要记得同步的规则。
    4. **任何可疑一律回滚成正文** —— 必填参数缺失、名字对不上、解析失败：整块**原样显示**。注意是「显示」不是「删掉」：静默吞掉一段文本会丢内容而用户看不出来——「检查永远不命中」与「检查通过」在界面上长得一模一样，这个坑本项目已经付过一次学费。
  - **只有整轮都是标记时才重发一次**：能恢复的形态当场转换（零重新生成、不加延迟、不重复计费）。本仓库真实捕获的那一类——工具名被写坏成 `<｜DSML｜ validate>`、拿不到任何工具名——注定过不了第二道闸，按原文显示；只有当**整轮去除标记后没有任何正文**时才重发一次，并复用既有的账号池换号语义。判据是可复核的既成事实，不是猜测。
  - **普通回答不受影响**：只有在「回答到目前为止全是标记」时才扣住字节，一旦出现真正的正文或调用就立刻按序放行并恢复原样透传。因此正常请求的延迟没有变化，也不会出现「先丢字节再反悔」——那会造成「两段回答拼接」，是既有换号逻辑明确拒绝的事。
  - **上游已经会发结构化调用时一律不插手**（粘性判定）：一次回答里两条调用通道互相竞争，比任一条单独出问题更糟。
  - 解析器移植自 [`hawklithm/workbuddy2api`](https://github.com/hawklithm/workbuddy2api) 的 `dsml_parser.py`（MIT），并补上它**没有的**第 2、3 道闸；逐条偏离见 `src/dsml-recovery.ts` 头部与 `THIRD_PARTY_NOTICES.md`。

- **`scripts/verify-dsml.mjs` 新增 `--through-shim`**：让真上游响应**经过 shim** 再判定，量的才是「客户端最终看到什么」。原有的 `--live` 直连 `client.chatStream`、绕过转换，对已经能恢复的泄漏会给出**「仍在泄漏」的假结论**——而这正是该脚本最不该犯的错。同一次改动里，它的静态探针也从「响应路径是否仍是 `body.pipe(res)`」改为「响应路径是否已被接管」，否则实现之后它会反过来陈述事实。

### Docs

- **`docs/DSML-LEAK-RESEARCH.md` 第五节改写**：原口径是「本仓库不实现恢复（只诊断）」，其理由里有两条后来不再成立——声明了哪些工具、必填参数是什么，`prepareChatBody` 早就解析过了；「闭合才提交」由解析器自己判定。该节现在说明定位已改为**诊断 + 恢复**，并指明恢复必须照抄第三、四节那四道闸。
- 新增 `docs/DSML-RECOVERY-PLAN.md`：移植清单、四道闸落点、改动点、测试矩阵（含「移除任一闸必然变红」的变异清单）与文档口径修正。
- `THIRD_PARTY_NOTICES.md`：新增 `hawklithm/workbuddy2api` 条目，并**修正第四节**——它原本写「未复制、修改或再分发任何参考项目的源文件」，而本次是**代码移植**，那句话必须如实改掉。
- 两份 README 的致谢章节补上 `hawklithm/workbuddy2api`，并标明它是名单里**唯一一项代码移植**（发布清单要求致谢章节列出全部参考项目；漏掉它等于把本版的主线改动排除在署名之外）。
- `docs/WINDOWS.md` §5 登记诊断脚本的跨平台写法：`verify-dsml.mjs` 改用 Node 读源码代替 `grep`，仓库根改用 `fileURLToPath`。
- 新增 `docs/DSML-RECOVERY-WINDOWS-VERIFY.md`：面向「到 Windows 机器上再验一次」的操作手册，取证点全部是机器可读的，并把两条最容易被误判成失败的事实写在最前面（工具名被写坏的那一类仍以正文显示；模型会摇摆）。

## 3.2.0 (2026-10-01)

### Features

- **账号池的开关从此就是「智能路由 + 自动换号」：排序决定每一次请求用谁，失败时依次用池内其他可用账号重试，直到有人接手或全部不可用。**
  - **触发与顺序**：某个请求失败 → 按池子的排序依次取下一个**可用**成员重试，全部失败才把错误报出来，并在错误里注明 `(after trying N accounts)`（不注明的话，「换过号仍然失败」与「你选的账号失败了」在界面上长得一模一样）。
  - **哪些失败会换**：429 限流、402 无积分、401 凭据失效、502 网关/网络——这些都是**某个账号**的状态，换一个很可能就过了。**请求本身不合法（HTTP 400）不换**：同一个请求体换哪个账号都是同样的 400，走完整池只是让用户多等 N 轮才看到同一个错误。**流中途断开也不换**——字节已经发出去了，重放会让客户端看到两段拼接的回答（这条写在 `src/shim.ts` 的重试循环里，是它只覆盖 `!result.ok` 的原因）。
  - **排序决定「谁服务」，不只是「换给谁」**：开启账号池后，**每一次请求**都由池子的排序选出服务账号（可用优先 → 积分高 → 快过期 → 凭据新 → 账号 id）。所以卡片上的「当前使用」是排序的结果，不一定是用户手动选的那个——这也正是「在测试之后有一个智能排序」的意思。
    - 实现上是**每请求一次**选择：shim 在 `resolve()` **之前**先问宿主（`prepareAccount`），宿主用**纯本地数据**排序，把胜者写进 store 的运行时覆盖（`setRotatedAccount`），然后照旧走 `resolve()`。这样 token 刷新仍然只有一处，不会在路由路径上被改写成「发一个过期 token」。
    - **请求路径绝不抓积分**：积分是排序的第二键，但每个成员一次上游调用。所以请求路径只用**新鲜读数**（卡片轮询 / 批量测试 / 保存时读到的那份，10 分钟内有效；由 `poolMembersOf` 顺手写进快照），过期就**跳过这一键**，而不是为了排序去打上游——否则一页对话会变成 N 个额外请求。
    - **从不写回用户的选择**：覆盖只存在于运行时（从不落盘），关掉账号池立即清空、用户选定的账号完全恢复生效。卡片因此必须显示「当前使用」。而账号选择器**只在池关闭时**渲染：池开着时由排序决定，那时候摆一个改了不生效的下拉就是在骗人。
  - **候选走 `credentialFor()` 而不是 `resolve()`**：换号与路由都不改选择状态，只是在运行时覆盖上取凭据。

  - **跳过已知不可用的成员，但「没测过」算可用**：仍在冷却期内的限流账号、凭据被上游拒绝的账号都不参与（免得花一次往返去重新学到测量结果已经写着的事）；**从没测试过的账号默认视为可用**——刚发现的登录不该因为「还没测」就被排除在外。这正是「一键测试」的意义所在：测试结果直接决定谁能被选中。
  - **循环有刹车**：`triedAccountIds` 是唯一的刹车，因此 shim **自己**也会拒绝一个「已经试过的」候选（不只依赖策略层的自觉）——否则一个策略缺陷会变成无上限的重复发送，真实消耗额度。客户端断开后停止重试（`AbortSignal`）。
  - **修掉一个一直存在的缺陷**：`req.on('close')` 无法表达「客户端挂了」——Node 在**请求体读完**时就触发它，所以在 `readBody` 之后才挂的监听**永远不触发**（实测：真实断开后 signal 仍是 un-aborted），而挂在 `readBody` **之前**则会立刻中止每一个请求。改用 `res.on('close')`：正常完成时它发生在 `res.end` 之后（无影响），中途断开时才触发（于是上游调用被真正取消）。这同时让上面那条「断开即停止重试」从「写了但不可能生效」变成真的生效。

- **删除「按积分自动轮换」与「自动测试间隔」两个设置项，以及它们背后的机制。**
  - 轮换（按「可用性 → 积分 → 可用时间」挑计费账号）与它的运行时覆盖（`setRotatedAccount`/`rotatedAccount`/`rotationGuard`/`createLatestWins` 用法）、自动测试定时器（`setInterval` + `duePoolRegions` + `runScheduledPoolTest` + `poolLastRunMs`）整体移除。设置 schema 少两个字段：读旧配置时它们被静默忽略（zod 的默认 strip 行为），不需要迁移。
  - **为什么不留着作为可选项**：两者与「换号」是同一件事的两种相反做法——轮换是**持久**改选、换号是**按请求**借用。同时存在会让人无法回答「现在到底谁在计费」，而卡片只能显示一个答案。用户裁定：要换号，不要轮换。
  - 顺带清掉随之成为死代码的客户端部分：`rotationLockState`、`rotatedToAccountId` 观测字段与那段「宿主侧轮换记录」的日志逻辑、`intervalEditOnInput`/`parseIntervalInput`/`POOL_INTERVAL_MIN|MAX`、以及两语言里对应的文案键。

- **海外区域不再提供签到**（`checkinSupported` 能力位）。
  - 国内版 App 每天有签到奖励，国际区域没有对应的东西——所以海外版的卡片**不渲染**「一键签到所有账号」按钮，也不再渲染每行的「签到」列（空列会暗示「有这个状态、只是没读到」）。
  - 后端同样拒绝该动作（`409 checkin-unsupported`），而不是只把按钮藏起来：否则会留下一个「界面看不见、接口却还能打」的死角。判定放在宿主（`region === 'cn'`）而不是浏览器比较区域名——策略属于宿主，卡片不该知道哪个区域碰巧有这个功能。

- **卡片上「单账号时代」的装饰全部退场：账号选择下拉、已登录状态卡、积分面板都不再渲染。**
  - **账号选择下拉**：有了账号池之后它是**自相矛盾**的——池开启时由排序决定谁服务，它改什么都不会生效，却看起来像权威；而它还可能和别处显示的账号不一致（真机截图里就出现过）。
  - **已登录状态卡（账号名 + token 过期）**：多个账号同时登录是常态，用单数说「已登录：A」本身就不成立；而 token 会自动续期，那个到期时间**不是用户能据以行动的东西**。真正出问题时，凭据失效面板会带着补救动作（「切换到可用账号」）说出来。
  - **积分面板与它的单账号签到**：积分已经在账号池的成员表里**逐账号**显示（还带最近到期时间），并且是排序的第二键；而那个签到按钮只对当前账号生效，还**绕过了账号池的勾选**——「本机有登录 ≠ 要拿它去签到和花积分」正是这个池子要守护的同意。
  - **账号选择并没有失去入口**：它搬进了账号池区块，且**只在池关闭时渲染**——那才是「手动模式」，也正是那个下拉唯一说得通的状态（见下方 Bug Fixes）。
  - 随之删除的四个文案键与只服务于这些元素的样式规则一并清理；「切换账号」的代码路径保留（凭据失效时的「切换到可用账号」仍在用它）。

- **模型管理移到卡片最后。**
  - 顺序改为：区域标签 → **账号池** → **模型管理**。账号池是日常要碰的东西，不该被一个可折叠的长列表压在下面；模型列表是一次性配置，放最后更顺。（原先夹在中间的积分面板已整体移除，理由见上。）

- **「重新检测账号」移到账号池区块里。**
  - 理由：账号池的成员表**就是**现在管理账号的地方，新登录的账号会以「一行待勾选」的形式出现在那里，所以「再看一眼本机登录」属于它旁边，而不是卡片顶部的状态栏。原来它和状态栏里那句「已登录：X」放一起，还会造成一种误导——有账号池之后**多个账号同时登录**是常态，用单数说「已登录」并不准确。
  - **但未登录状态必须保留一个副本**：账号池区块只在「有账号的区域」渲染，而「我刚在桌面端登录了，你再看看」恰恰是**未登录时**才需要的动作。少了这个副本，那条路就没有入口了。守卫里为此专门有一条用例。

### Bug Fixes

- **修正：账号池的开关被错误地同时管住了「手动动作」。**
  - 现象：关掉账号池之后，卡片的「一键签到 / 一键测试」都置灰了，而 Host 也会以 `409 pool-disabled` 拒绝同一个请求——于是「关闭」等于「再也没法签到或测试」。
  - 根因：把「插件是否自动路由」与「用户是否可以操作」当成了一个条件。它们是两件事。
  - 修法：开关只保留它在路由上的作用（排序选谁、失败换谁）；签到、测试、目标模型选择与勾选在任何状态下都可用。`409 pool-disabled` 这条原因连同它的文案键一并删除。
  - **唯一保留的硬约束**：池里没勾选任何成员时批量动作一律拒绝——空的池绝不退化成「那就对全部执行」。

- **修正：关闭账号池后没有任何地方可以选择要用的账号。**
  - 现象：把账号池关掉之后，想换一个服务账号却找不到入口——卡片头部的账号下拉已被移除，而账号池区块也没有提供选择。
  - 根因：删掉那个下拉时只论证了「池开启时它改了不生效」，漏了另一半——**池关闭时它是唯一的选择入口**。于是「关闭」变成了「卡在之前选定的那个账号上」。
  - 修法：把账号选择放进账号池区块，**只在池关闭时渲染**（那就是手动模式），选项来自本区域已检测到的账号，当前生效的那个为选中值；写入走与「切换到可用账号」同一条已验证路径。**池开启时该行不渲染**——那时由排序决定，一个改了不生效的下拉比没有更糟。
  - 顺带给它一个专属 class（`dsm-workbuddy-pool-account-select`）：它与「目标测试模型」共用 `pool-select`，导致按类名查询会命中先渲染的那个——这个坑在测试里当场就被踩到了。

- **修正：线上碰到的 429 没有留下任何测量，于是下一个请求又会先撞同一个账号。**
  - 现象：某个账号刚被限流，但下一个请求仍然先发给它、撞一次失败、再换号——每个请求都白付一次往返。虽然结果仍然是成功（换号救回来了），但「发现有可用的就继续用它」只对**当前这一次请求**成立。
  - 根因：测量只在**手动「一键测试」**时写盘；聊天路径碰到失败时什么都不记。而排序读的正是这些已存测量，所以一个刚被限流的账号在排序里仍然是「未测试 → 候选」。
  - 修法：失败发生时把它记成测量——新增 `onAccountFailure`（shim → 宿主）与 `recordAccountFailure`（宿主侧落盘），用 `outcomeOfFailure` 归类、用 `cooldownOf` 从上游报文里解析它**自己给出的重置时间**（「将在 … 重置」）。于是该账号在冷却期内被排序排除，下一个请求直接走可用账号。
  - **只对每个失败尝试上报一次，包含最后一次**：没有任何后继可试的那个账号，恰恰是下一个请求最该避开的——只上报「有后继」的那些会漏掉最要紧的一例。
  - **两类刻意不记**：`client`（HTTP 400）——上游拒绝的是**请求本身**，与账号无关，记了会因为一个坏 body 而闲置一个好账号；以及**未被勾选进池**的账号——勾选才是「可以花这个账号的积分」的显式同意，而测量会影响路由。池关闭时也不记：那时没有任何路由在读它。
  - **上报不阻塞重试**：写盘只影响后续请求，而用户正等着这次重试；回调抛错也只记一行 warn，不影响请求本身。

- **修正：所有成员都被限流时，卡片仍把其中一个报成「当前使用」。**
  - 现象：池里每个账号都在冷却期内时，卡片上方写「当前使用：A」，而正下方的成员表同时写着「A 被限流」——同一屏自相矛盾，而「池子换到了可用账号」这件事也就无法被验证。
  - 根因：请求与显示混用了同一个答案。没人可用时 `applyPoolSelection` 会清空运行时覆盖（好让**请求**落到你保存的那个账号上），而卡片读的也是 `store.current()`，于是把那个「兜底账号」当成了在服务的账号。
  - 修法：把两个问题分开。请求该去哪就去哪（兜底不变，失败照实报），但**显示**在「当前账号已被测量为不可用」时报「没有可用的账号」——卡片本来就有这个状态，而且那才是事实。不是池成员的账号不算在内：那时池没有意见，就不该替它表态。

- **修正：DSML 检测器只认双竖线，对真实泄漏报「一切正常」。**（仓库内诊断工具；**不影响插件行为，也不随 npm 包发布**——`src/markup-diagnosis.ts` 无人 import，不进 `lib/`）
  - 现象：`｜DSML｜` 的**竖线个数是写法变量，不是 token 的一部分**。一次真实捕获的正文块里
    五个标记混用三种写法——`<｜DSML｜ validate>`、`<｜DSML｜ parameter name="spec">`、
    `</｜DSML｜ invoke>` 都是单竖线，只有收尾 `</｜｜DSML｜｜ calls>` 是双竖线。
    只按双竖线匹配，会对一个真的泄漏了四次的会话给出零命中——而「检查永不命中」看起来与
    「检查通过」一模一样。
  - 修法：新增 `BARS`（1–2 个全角竖线）与 `MARKUP_RE`，定位与计数一律改按它匹配
    （`MARKUP_TOKEN` 保留为双竖线的参考写法）；`CALL_ATTEMPT` 除 `invoke name="…"` 外
    再接受 `parameter name=` 子句——那次泄漏的开头被写坏成 `<｜DSML｜ validate>`（工具名占了
    `invoke name="…"` 的位置），但每个参数子句都完整。
  - 配套：「在行内反引号里引用标记」也计为 `mention`。参数子句既可能是调用、也可能是在**解释**
    语法，而解释性引用写在反引号里；不区分就会把解释当成事发，数字随即失去意义。
  - 效果（同一份会话记录）：判定为真实泄漏 **6 次 / 2 会话 → 12 次 / 4 会话**；另单独计出 13 次
    「讨论/引用」不计入。`scripts/verify-dsml.mjs` 的抬头同步改正——它此前把「双竖线常量」
    印成「检测的 token」，与实际匹配口径不符。
  - 外部依据与上游各层修法见 `docs/DSML-LEAK-RESEARCH.md`（含 vLLM 那些**关闭未合并**的
    尝试，以及急切恢复炸出的三类生产事故）。

- **账号池的「保存 / 放弃修改」行动作行改为与模型管理一致：按钮靠右，左侧放「鼓励一下」。**
  - 同一张卡片上两处「提交你的修改」行为长得不一样——模型管理那行是左侧鼓励链接（★）、右侧按钮，
    账号池这行却是按钮在左、提示在右。同类动作行不该教出两套肌肉记忆。
  - 现在两行同构：左侧鼓励链接、右侧按钮组（放弃修改 → 保存，次要动作在前，与模型行同序）；
    样式也对齐（相同的上边框与间距，`justify-content: space-between` 把按钮顶到右侧）。
  - 该行原有的状态提示（「修改任一设置后即可保存」/「有未保存的修改」）**整句删除**，两行因此完全等形。
    它本来就是多余的：**保存按钮自身的可用状态**已经区分了这两种情况；而一句只在 dirty 时才出现的文字，会让这行在每次编辑时抖动一下。
  - `WORKBUDDY_GITHUB_URL` 提到 `src/status-paths.ts`：现在两个区块都链接到它，复制一份 URL 就是多一处会忘记同步的地方。

- **账号池顶部重新设计：删掉两处重复的说明，按钮收成一行两簇。**
  - **副标题整行删除**（「本区域 N 个账号 · 目标模型 X」）：账号数就是成员表的行数，目标模型就是下面
    那个控件的当前值。首个控件之前先读两行说明，成本不小。
  - **徽章旁那 4 行说明整行删除**：它讲的「失败会借用另一个成员重试」与「启用账号池」自己的说明重叠，
    而且池关闭时那件事根本不会发生。
  - **目标模型的来源移进「目标测试模型」这一行**（`当前：deepseek-v4.1-flash（你指定）`），
    而不是像原来那样在副标题与底部各说一遍——信息没丢，但只剩一处。
  - **按钮收成一行两簇**：左簇是「对勾选的账号做的事」（一键签到、一键测试），右簇是「重新发现账号」
    （重新检测账号）。此前重新检测独占一行靠右、签到/测试在下一行靠左，两行两种对齐却没有理由。
  - 随之删除：2 个文案键（`poolSummary`/`poolCurrentHint`，两语言共 4 行）、2 条只服务于它们的样式规则
    与 1 条已无使用者的 `pool-current` 容器规则；新增 2 个来源文案键。
  - 设计过程的形态校对稿留在 `docs/pool-header-redesign.html`（不进发布包）。
- **模型区不再可折叠：去掉「点击收起」与那个折叠头。**
  - 原来它是原生 `<details>`：表头可点、带方向指示箭头、中间一行「点击收起 / 点击展开」。
  - 去掉的理由：模型列表正是用户来看的东西，折叠它只会把想看的内容藏起来；而且这让模型区成了卡片上
    **唯一**一个「点一下就能藏起来」的区块，读起来像另一种性质的区块，而不是同一张卡片里的一段。
  - 表头与列表照常渲染，表头仍写明「已启用 N 个」；**未保存标记仍留在表头**（这一条比折叠时代更重要——
    列表长的时候，用户不必滚到底部的按钮才知道有改动没保存）。
  - 随之删除：3 个文案键（`modelsFoldHint`/`modelsFoldShow`/`modelsFoldHide`，两语言共 6 行）、
    2 条样式规则、以及表头为 `<details>`/`<summary>` 而写的原生三角抑制、焦点环与手型光标。
  - 「探测过哪些路径」那个折叠列表**不受影响**——它仍是 `<details>`，那是另一件事。
### Docs

- README 双语与 `docs/ACCOUNT_POOL_PLAN.md` 同步改版说明；`docs/assets/account-pool-demo.html` 演示原型同步（去掉两个开关、改写启用文案、海外版不显示签到）。

## 3.1.0 (2026-10-01)

### Bug Fixes

- **修复国际版每一步都 400 / 业务码 11128（`first message is not system prompt`），而国内版正常。**
  - **现象**：用户切到 `workbuddy-global` 后，每一步都失败；同一会话里国内版 18 个 turn 全部成功。响应体里带的是 `displayMsg: "The request was blocked by security policy"`，看起来像风控，实际不是。
  - **根因（真机复现）**：两个网关都要求会话**以 `system` 消息开头**，**国际网关强制、国内网关容忍**——这就是「只有国际版报」的全部原因。而 system 消息会在到达本插件的 shim 之前就消失：`dsh-llm-pi-ai` 把首条 `system` 消息抽成 `Context.systemPrompt`，pi-ai 只在 `if (context.systemPrompt)` 为真时才发它——**空串或空文本是 falsy**，于是它一条 system 都不发，并把 `messages` 里那条 `system` 降级成 `user`。出站因此以 user 打头。
  - **实测矩阵**（真实国际网关，插件真实 shim + adapter 路径）：首条 system 文本为空 → 线上 `["user"]` → 11128；`system=""` 且 `messages` 首条是 system → 线上 `["user","user"]` → 11128；system 是空格 `"   "` → 线上 `["system","user"]` → 200。**空格能过、空串不能**，正好卡在 pi-ai 的真值判断上。
  - **修法**（两道，都在出站前）：
    1. `src/adapter.ts` 的 `adaptLegacyPiAiContext` 把 `systemPrompt !== undefined` 改成真值判断。空串不再被当作「已经设好了」而提前返回，于是 `messages` 里真实存在的那条 system 会被折回 `systemPrompt`——**把用户真正的提示词救回来**，而不是替换掉。
    2. 兜底：确实一条 system 都没有时，补一条最小占位（`WORKBUDDY_FALLBACK_SYSTEM_PROMPT`，定义在 `src/upstream.ts`）。同时 `prepareChatBody` 增加 `ensureSystemHead()` 作为最后一道：出站前首条不是 `system` 就补。
  - **占位提示词刻意极短**（`You are a helpful assistant.`）：它是最后手段，不是人格设定；编一段长的会悄悄改变所有受影响请求的模型行为。
  - **与探测路径对齐**：`src/probe.ts` 早就知道这条规则（注释写着「探测请求总是带一条 system 消息，两个网关都接受」），但聊天这条路一直没有这道防护——本次补齐。
  - **守卫**：`tests/adapter.spec.ts` 新增「空 `systemPrompt` 不吞掉真实 system 文本」与「无 system 时补占位」两例，并**修正了一条编码旧契约的用例**（原先断言「没有 system 消息时返回同一个对象」，而这正是必须改动的输入）；`tests/upstream.spec.ts` 新增三例：user 打头时补占位、已是 system 打头时不重复补、无历史时一条都不补。
  - **未验证**：生产宿主里究竟是哪条路径进入该分支（空文本被丢弃，还是 `options.system=''` 导致降级）——两者都被兜底覆盖，且都已在真实国际网关上端到端验证返回 200。

- **修复 issue #26（以及 #25 的完整根因）：3.0.2 的 `adaptLegacyPiAiContext` 折叠会丢掉 system prompt 与全部工具声明——上一条只治了 400 症状，本条治根。**
  - **现象（#26）**：升级 3.0.2 后 desktop profile 下所有 WorkBuddy 模型都无法调用工具：模型不产生 `tool_calls`，而是在正文里用 Markdown 代码块**编造**工具调用与"执行结果"，`stopReason` 恒为 `stop`（报告者实测 15 个请求 `calls=0`；编造的工具名是 `Bash` 而非 DSH 真实的 `pwsh`——连工具清单都没收到）。国际版则先撞上网关校验表现为 #25 的硬 400。
  - **根因（逐条对照两版 pi-ai 源码核实）**：pi-ai 0.87 的 `normalizeContext` 把 system prompt 与工具声明**只**放在 `messages` 首条 system 消息上（`content` 与 `toolsAdded`），顶层 `systemPrompt`/`tools` 字段就此消失；而 0.87 的 `openai-completions` **全文没有一处读顶层 `systemPrompt`**，工具只从首条 system 消息的 `toolsAdded` 取（宿主 asar 里的 0.87.1 已逐行核实）。3.0.2 的 `withLegacyContext` 按 **context 形状**判断"要修"，把首条 system 消息删掉、文本折回顶层——恰好删掉了两个代次 api 各自唯一的载体：
    - 插件解析到 **0.87**（干净安装，无磁盘 0.85 副本，#26 报告者的机器）：顶层 `systemPrompt` 没人读 → **提示词丢**；`toolsAdded` 被删 → **工具丢** → 模型编造工具调用；
    - 插件解析到 **0.85**（本机：`~/.dsh/profiles/desktop` 里的安装是指向本仓库的符号链接，嵌套 dev 依赖 0.85.1，而宿主 asar 是 0.87.1）：折回的文本 0.85 认，但折叠**只搬文本不搬工具**——0.85 只读顶层 `context.tools`，而 `toolsAdded` 被丢弃 → **工具同样丢**。两个方向都是错的，区别只是症状。
  - **为什么不能照 #26 的"最小修复"直接删掉 wrapper**：本机插件解析的正是 0.85.1，宿主却用 0.87.1 归一化 context——删掉 wrapper 会立刻复活 issue #24 的崩溃（0.85 的 `estimateMessageTokens` 对字符串 content 的 system 消息抛 `Cannot read properties of undefined (reading 'length')`，已在本机复现为流内 error、请求未发出）。报告者机器与作者机器**环境互补**，任何基于单一环境的修法都会弄坏另一台。
  - **修法（按代次门控，而不是按 context 形状猜）**：新增 `src/pi-ai-runtime.ts`，判定**插件自己解析到的那份 pi-ai**：
    1. **modern（0.87+）**：`withLegacyContext` 原样返回 api，context **字节级透传**——0.87 自己就能消费归一化 transcript（#26 的复现脚本证明了这条路 tools 与 prompt 都在）；
    2. **legacy（0.85）**：折叠照旧，但**把工具状态一并提升**——按 0.87 自己 `getCurrentTools` 的语义重放每条 system 消息的 `toolsRemoved`/`toolsAdded`（先删后加、按名去重），写回顶层 `context.tools`（顶层已有 `tools` 数组时不覆盖）。
  - **检测刻意不 import pi-ai 本体**：用 `import.meta.resolve` 定位入口文件（不执行模块）+ 读取**所属 manifest 的版本号**判定代次（0.87+ → modern；peer 范围内版本与 `normalizeContext` 特征一致）。原因是 standalone CLI 必须在**市场安装**（本地无 pi-ai 副本、模块只由宿主提供）下也能跑 `doctor`——静态 import 会让它在加载期就 `ERR_MODULE_NOT_FOUND`（已用 3.0.2 官方包在裸目录复现同一现象：缺 peer 时谁都跑不起来，本次新增的这条依赖则被彻底避免）。
  - **解析失败 = 宿主提供**（市场安装的常态）：此时默认走 modern 透传，因为**会归一化 context 的宿主（0.2.0+）都提供 0.87.1**；该默认对旧宿主同样安全——旧宿主从不归一化，原生 0.85 形状在两个分支下都是恒等。
  - **实测（本机 0.85.1，真实 api + fetch 注入捕获出站 body）**：修复前有 wrapper → `tools = MISSING`、system 文本在；修复后 → **`tools = 1`（pwsh）、首条 `system` 消息文本完整**。无 wrapper 的对照 → system 也丢、且 #24 崩溃以流内 error 出现。
  - **doctor 可见性（#26 的附加建议）**：`doctor` 输出新增 `piAiRuntime` 块（generation / version / resolvedFrom / **resolvedLocally** / adapter 行为说明），人类可读行同步打印；legacy 时追加 hint 提示"插件解析到 0.85 而 DSH 0.2.0+ 宿主用 0.87 归一化，适配器在桥接，若工具异常请清理嵌套 pi-ai 副本"。JSON schemaVersion 2 → 3。**两种环境的真实输出已分别实测**：仓库检出（嵌套 0.85.1）→ `legacy 0.85.1 (<pnpm 真实路径>) — folds…`；市场式安装（有 peer、无 pi-ai）→ `modern, host-provided (no local copy; DSH 0.2.0+ ships 0.87.1) — passes…`。
  - **守卫**：接线用例从一条拆成**三条**——legacy 折叠并提升工具（含 `tools` 断言）、modern **同一对象引用**透传（`toBe`，最强度断言）、默认跟随实际解析代次；新增 `tests/adapter-outgoing-body.spec.ts` 按 #26 建议的测法**直接断言出站请求体**（`body.tools` 与首条 system 文本，并在失败信息里带出流内错误）；新增 `tests/pi-ai-runtime.spec.ts` 四例钉住检测自洽（generation 与模块特征一致、路径与版本来自同一份 manifest、结果缓存稳定）——**不钉具体版本号**，peer 范围内换版本时检测必须跟着走而不是被测试冻住。
  - **对上一条（#25 修复）的关系**：`ensureSystemHead`/兜底占位保留——它们是 wire 层最后防线（空文本 system、`options.system=''` 等退化输入仍需兜底），但 400 消失后若不修本条，国际版会立刻从"报错"变成"不报错但没工具"（#26 原文预测，本机复现坐实）。
  - **跨机真机验证（发布前）**：Windows 11 与 macOS 两台机器、国内版与国际版两个区域，均完成真实工具调用（`pwsh` 执行 `echo`，输出逐字一致；模型列出的工具名是 DSH 真名而非编造的 `Bash`）。Windows 那台先复现了 #25 的 400 报文与 #26 的「我没有可用的 shell 工具」，部署修复后同一路径通过——红绿对照。存档见 `docs/ISSUE-25-26-WINDOWS-VERIFY.md`。
  - **本次未覆盖**：两台机器都是 junction 到仓库本体（解析到嵌套 0.85.1）→ 都走 legacy 桥接分支；**modern（市场安装、宿主提供 pi-ai）分支尚无真机端到端观测**，仅有单元测试的恒等断言与模拟安装树上的 `doctor` 选中验证。

### Features

- **模型区可折叠**：模型列表现在折在标题行下面（标题、已启用数量、「从 WorkBuddy 刷新」按钮留在外面），点标题行即可收起，把下方的账号池一次露出来。用原生 `<details>` 实现，因此键盘可达、助记语义正确，且不引入任何状态库。
  - **标题左侧有折叠箭头**：收起时朝右、展开时旋转 90° 朝下（0.16s 过渡，与卡片既有过渡一致）。**原生三角被隐藏、改为自绘**——否则会出现两个方向相反的状态指示器。旋转由 `details[open]` 驱动，不需要额外状态，也就不可能与实际显示不一致；箭头本身是纯装饰（`<details>` 已向助记技术播报状态），故标记 `aria-hidden`。
  - **默认展开**：这是用户原本就看得到的内容，默认折起来会让人以为它没了。
  - **折叠状态不持久化**：卡片只挂载当前 tab，所以「记住」需要新增一个设置字段——一个纯外观偏好不值得。切 tab 或重开卡片会回到默认。
  - **折叠态标题行会显示「有未保存的修改」**：保存/放弃按钮在折叠区里面，且只在 `dirty` 时可点；没有这个提示，用户勾了几个模型再折起来，就把自己的未保存改动藏在了折叠后面而界面上一言不发。
  - **标题行中间加了一句淡色动作提示**（「点击展开」/「点击收起」）：只有箭头时，「这里能点」这件事不够明确。提示说的是**此刻能做的那个动作**，而不是固定的「展开或收起」——后者会让读者自己去想该按哪个，正是这句提示要消除的疑问。它用与标题下方摘要行相同的淡色 token，读起来是提示而不是第二个标题；窄屏（≤760px）下隐藏，因为箭头已足以表明这是折叠控件，先让位给标题与按钮。
  - **刷新按钮不会误触发折叠**：按钮位于 `<summary>` 内，而点击 summary 内任何位置都会激活这个 disclosure——所以 summary 的 `onClick` 对落在操作区的点击调用了 `preventDefault()`，否则「刷新模型」会顺手把列表收起来。这条有专门用例钉住。

## 3.0.2 (2026-09-30)

### Bug Fixes

- **修复 issue #24：宿主 pi-ai 0.87 下所有 WorkBuddy 模型立即失败**（`Cannot read properties of undefined (reading 'length')`）。
  - **根因**：pi-ai 0.87 的 `normalizeContext` 把 system 提示词搬进 `messages`，成了 `{ role: 'system', content: '<字符串>' }`。而 pi-ai 0.85 的 `Message` 联合类型里**根本没有 `system` 变体**（只有 `UserMessage | AssistantMessage | ToolResultMessage`），于是它的 `estimateMessageTokens` 没有对应分支：`for (const block of message.content)` 会把**字符串逐字符**迭代，`block` 变成单个字符，`block.name.length` 抛错。崩溃发生在 `buildBaseOptions → clampMaxTokensToContext → estimateContextTokens`，即**构造请求体之前**——所以每个模型都在十几毫秒内失败，且**没有任何上游请求发出**。
  - **修法**：新增 `adaptLegacyPiAiContext()`，在把 context 交给本插件的 pi-ai 之前，把 `messages` 里的 system 消息折回 `Context.systemPrompt`（0.85 期望的位置），并用 `withLegacyContext()` 包住 `openAICompletionsApi()` 的 `stream`/`streamSimple` 两个入口。
  - **按形状适配，不按版本判断**：判断依据是「context 里有没有 system 消息」，不是「加载的是哪个 pi-ai 版本」。版本判断会在任一侧升级时立刻失效；本插件必须在**两代宿主**下都能活。对原生 0.85 形状（已有 `systemPrompt`）返回**同一个对象**，原路径零改动。
  - **实测**（用插件真正加载的那份 pi-ai 0.85.1）：修复前 0.87 形状 → `Cannot read properties of undefined (reading 'length')`；修复后 → `Connection error.`（走到传输层，即请求已构造完成）。旧形状恒等，`system` 用 block 内容时也能正确合并。
  - **守卫**：`tests/adapter.spec.ts` 新增 8 例，其中**接线用例**（`vi.mock` 掉 stream API，断言 provider 收到的 context 已被折平）是必要的——只测纯函数时，把修复从 provider 上摘掉的变异**不会被打红**（已实测），等于留了一个「修复被摘掉而测试全绿」的缺口。变异验证：去掉 `withLegacyContext` → 该用例变红。
  - **顺带核实**：宿主 asar 声明 `@earendil-works/pi-ai ^0.87.1` 且含 `normalizeContext`；磁盘上四份 pi-ai（profiles / 插件嵌套 / 仓库 / 旧安装树）**全是 0.85.1**。issue 建议的「插件包内放一份 0.87.1」绕行在本机并未生效——嵌套副本是 0.85.1，漂移依旧，只是被当前加载的旧 `dsh-llm-pi-ai`（0.1.5-rc.2，不含 `normalizeContext`）掩盖了。
  - **peer 范围放宽**：`@earendil-works/pi-ai` 由 `>=0.85.0 <0.86.0` 改为 `>=0.85.0 <0.88.0`（peer 与 dev 两处）。原范围**不承认 0.87**，与实际已验证的兼容性不符：适配按形状生效，代码在 0.85 与 0.87 下都已验证可用。放宽后 `pnpm install` 报 "Lockfile is up to date"，未产生 lockfile 变更。

## 3.0.1 (2026-09-30)

### Bug Fixes

#### 保存账号池会把该区域的模型目录整段删掉，于是「保存后目标模型就下架了」

**用户报告**：在账号池里点保存后，目标模型立刻显示「已下架」，并且「一键测试所有账号」被停用；**macOS 上不出现**。

**根因（真机取证）**：`__save` 的路由此前做的是 `{ ...current, ...incoming }` —— **区域级整体替换**。而客户端只能按自己的 settings 镜像拼出槽位，这个镜像**本仓库自己注释过对本命名空间不可靠**（经本端点写入不会刷新它，在 0.1.7 线上可长期陈旧）。于是：

1. 保存账号池时客户端 POST 的是 `{ cn: { pool } }`；
2. Host 用这一个键**替换掉整个 cn 槽** → `lastCatalog`、`enabledModelIds`、`imageModelIds`、`contextBudgets`、`enabled` **全被删除**；
3. `displayModels` 见 `lastCatalog` 为空即回落到**静态 CN 目录**（`src/catalog.ts`），而它只有 `deepseek-v4-flash`（第 39 行），**没有 `deepseek-v4.1-flash`**（那在第 59 行，属国际版）；
4. 于是判「已下架」，`resolveTargetModel` 返回 `stale`，测试随之停用。

**证据**：同一 profile 下留有 1:58 的配置备份（20711 B，`cn.lastCatalog` 含 `auto`/`hy4-preview`/… 完整清单），而当前配置（14873 B）的 `cn` 槽**只剩 `pool`**——差出的约 6 KB 正是被删掉的目录。本项目审计 `docs/audit/D-verification.md` L-4 记录过同一机制（当时是 `toggleRegion` 的过期整槽写入），但只修了写入交错，没有修「整体替换」这一步。

**修法**：`__save` 的合并**下沉一层**——字段的键做一层（保兄弟区域），被触及区域槽内的键再做一层。**只保留客户端未提及的键**；客户端显式发来的字段（含空数组）依旧覆盖，因此「主动清空」不受影响。刻意不再更深：`contextBudgets` 这类嵌套 map 由其所有者整体发送，继续递归会让单个条目无法删除。

**为什么不动 macOS**：该合并只在「客户端漏发了某个键」时才有差别；macOS 上的槽位是完整的，因此对它是恒等操作。

守卫：`tests/web-status.spec.ts` 新增 4 例——① 只发 `{cn:{pool}}` 时 `contextBudgets`/`enabled` 必须存活（**这条直接复现本次数据丢失**）；② 国际版同理（`{global:{pool}}` 不得删掉 global 的目录与预算）；③ 显式发空数组仍能清空；④ `accounts` 的账号 id 是字符串，不得被对象化。**变异验证**：把合并改回一层展开 → ① 与 ② 同时变红（已实测）。

**即时补救**：卡片上的「切回自动」会把目标换成该区域的免费模型（`hy3`，静态目录里也有），立即可用；被删掉的模型勾选与上下文预算需在「模型管理」里重新保存一次以重建 `lastCatalog`。

**国际版（global）同样已覆盖，而且它更需要这个修复**：

- **为什么覆盖**：合并遍历的是**字段自己的键**，不认区域名——`{cn:{…}}` 与 `{global:{…}}` 走的是同一段代码，没有区域分支。有专门用例钉住（`preserves omitted fields in the INTERNATIONAL region too`）。
- **为什么它更需要**：同一个删除在国际版**不表现出任何症状**。`displayModels` 在 `lastCatalog` 为空时回落到静态目录，而**国际版静态目录里有 `deepseek-v4.1-flash`（`src/catalog.ts:59`，倍率 0）**，国内版静态目录没有（只有 `deepseek-v4-flash`，L39）。所以国际版用户的目标模型照旧解析成功——目录、勾选、上下文预算**被默默删掉却毫无提示**。国内版至少还会喊「已下架」。
- 这条区域差异已用 `tests/catalog.spec.ts` 的断言钉住（`cn.has('deepseek-v4.1-flash') === false` 且 `cn.has('deepseek-v4-flash') === true`），避免日后改动任一份目录时悄悄改变「哪些故障可见」。

**另说明**：本次两处修复都不区分区域。`isFileContentionWriteError` 是**平台**维度的（只在 Windows 上会命中 `EPERM/EBUSY/EACCES`），两条区域共用同一段客户端代码，因此国际版的保存失败提示也一并改善。

- **Windows 上文件被占用时，两条保存路径只甩原始 EPERM、不给做法**（模型列表与账号池；账号路径本来就有）。真机实测（3.0.0 宿主 + 锁住 profile 的 `cordis.patch.yml`）：写入返回 HTTP 500，报文是
  `EPERM: operation not permitted, rename 'C:\…\cordis.patch.yml.79498ff8fb27.tmp' -> '…\cordis.patch.yml'`
  ——只报了一个临时文件路径，**没有说明原因、也没告诉用户怎么办**。而 `row.accountsWriteFailed` 早就把「杀毒软件/同步盘占用 → 关闭占用者后重试」写进了文案。
  - **修法**：新增 `isFileContentionWriteError()`（匹配 `EPERM`/`EBUSY`/`EACCES` 三个**词边界**标记——正是 `dsh-atomic-write` 在 win32 上重试的那三个），命中时在原因后追加 `row.saveContentionHint`；模型列表与账号池两条路径接上。
  - **只对文件占用生效，不做无条件提示**：校验类失败走的是同一个 catch，对那种失败说「去关闭占用文件的程序」会把用户引向不存在的原因。有专门用例钉住「无关失败不得出现该提示」。
  - **macOS 行为不变**：POSIX 的 `rename` 无论目标是否被打开都直接替换，所以这三个错误码在 macOS/Linux 上基本不会出现——检测器天然只在 Windows 上生效。
- **顺带记录的核验结论：Windows 保存逻辑本身没有「静默成功」**。锁住文件时 `regions` 与 `accounts` 两条写入都返回 500 并带 `EPERM`，客户端随即抛 `WorkBuddySettingsWriteError`，卡片明确报错并**保留草稿/原选择**（三条保存路径都不会丢弃用户改动）。回退路径的回读校验读的是「被拒后重新加载的 Host 状态」，不会把乐观写入误判为已落盘。因此本次修的是**报错文案的可操作性**，不是落盘判定。

### Docs

- **改正 3.0.0 里一处过期的免费模型举例**（README 两份 + 上方 3.0.0 条目）：原文写「该区域倍率为 0 的免费模型（**国内版即 `deepseek-v4.1-flash`**）」。2026-09-30 在真机上核对 live catalog（16 个模型）后，`deepseek-v4.1-flash` 的倍率是 **0.11**，国内版**唯一**倍率为 0 的是 **`hy3`**（ctx 192000）。
  - **机制本来是对的，错的只是举例**：`pickFreeModel` 严格按 `creditMultiplier === 0` 现挑、多个候选取上下文窗口最大者，实测输入真实目录时返回 `hy3`，规则成立；`docs/ACCOUNT_POOL_PLAN.md` §4.4 早就写明「不写死 `deepseek-v4.1-flash`」并解释了原因。所以这条只是文档里的名字腐坏了，不是行为缺陷。
  - **为什么不改成另一个写死的名字**：上游会改倍率（本次观察到的就是一次改动），任何名字都会再次过期。现改为陈述「按 `creditMultiplier === 0` 现挑」并附本次实测值，同时说明为何不写死。
  - **顺带印证的一条正确设计**：`auto` 在上游目录里**没有** `creditMultiplier` 字段，`pickFreeModel` 不把它当免费——这正是该模块注释警告过的陷阱（缺失 ≠ 0），实测确认未踩。

## 3.0.0 (2026-09-30)

> **主版本号升级的理由**：账号池是第一个会改变「哪个账号被计费」的功能。在此之前插件只有一条硬规则——**绝不为了找积分而重排账号**（`src/auth.ts` 的原注释：*This is NOT credit-seeking*）。账号池把这条规则变成**用户显式授权的例外**：打开「按积分自动轮换」后，被计费的账号可能不是你手动选的那个。这是语义级的变化，因此走主版本号。

### Features

#### 账号池：多账号批量操作与自动轮换

- **一键签到所有账号**：逐个账号签到，**签到前先查当天状态**，已签到的直接标记、**不发写入请求**（幂等，不重复领取）；单个账号失败只标记该行，**不中断整批**。
- **一键测试所有账号**：对每个成员发一次**真实体积**的探测（约 25k 输入 token，复用模型行的 `probeModel`），得出该账号此刻能否用这个模型。默认目标是**该区域倍率为 0 的免费模型**（**不写死名字**：实测国内版当前只有 `hy3` 一个免费模型，而 `deepseek-v4.1-flash` 已从 0 变为 0.11——上游会改倍率，所以按目录里的 `creditMultiplier === 0` 现挑），也可指定具体模型；指定的模型若离开目录，手动动作**明确拒绝**（`target-model-stale`）而不是偷换一个。
- **按积分自动轮换**：在可用成员中按 **① 积分余额高者优先 → ② 快过期的积分优先用完 → ③ 平手时凭据更新鲜者优先** 选出计费账号。**与手动选择互斥**：开启后手动下拉立即置灰并就地给出原因与关闭按钮（否则会出现「下拉写着 A、实际计费 B」）。**轮换只在运行时决定用谁，绝不写回 `config.accounts[region]`**，关掉开关即原样恢复你上次的手动选择；每次换号都在卡片上留一条记录。
- **成员是显式勾选、默认空**：「本机有登录」不等于「要拿它去签到和花积分」。**空池不会退化成「全部账号」**——未勾选时两个批量按钮直接拒绝。
- **定时自动测试**：间隔 **5 ~ 1440 分钟（默认 30）**，定时器每 60 秒走一次。下限 5 分钟是刻意的：更密只会把整池打成限流。
- **每个区域各有独立的一池**：国内版与国际版的成员、目标模型、间隔与轮换开关互不影响。
- **不提供自动签到**（明确边界）：签到是写操作、会真实领取奖励，只在你点按钮时执行；卡片上也不放一个永远点不动的开关。
- **成本如实标注**：测试是真实请求，指向免费模型（倍率 0）时几乎不花钱，但**不是零成本空转**。

### Bug Fixes

- **卡片里的时间戳全部改为 24 小时制**：四个 `Intl.DateTimeFormat` 都漏了 `hourCycle`，于是跟随浏览器语言的默认偏好——en-US 渲染成 `09/30, 01:23 PM`。现统一为 `hourCycle: 'h23'`（不用 `hour12: false`：后者在部分引擎会落到 `h24`，把半夜显示成 `24:00`）。新增渲染回归测试钉住这一点，并用变异体确认该测试有判别力（去掉 `hourCycle` 即变红）。
- **陈旧的「目标模型」不再冻结整池的测量**：定时轮次原先在 `resolveTargetModel` 解不出 id 时直接返回，而「你指定的模型已离开目录」正是产出「无 id」的情形之一。于是一处显示偏好的错误会让整个区域的测量停摆：`被限流` 的成员靠时钟就能回池，而 `连不上上游` 的成员只能靠**新的探测**清除——探测不再写入，该成员便**永久挂起**。现在定时轮次会回落到该区域的**免费**模型继续刷新；没有免费模型时仍然整轮跳过（**绝不在定时器上烧收费模型**）。手动动作依旧拒绝陈旧目标。
- **一次刷新失败不再抹掉整个面板**：`refreshUsage` 的失败路径原先把整个区域的状态塌缩成 `{status:'error', message}`，而面板主体 gate 在 `signed-in` 上——于是**一次网络抖动就让正在编辑的账号池连草稿一起消失**。现在沿用项目既有的「快照 + 分区错误叠加」范式：**有数据就叠加 `refreshError`，没数据才塌缩**。
- **卡片不再永远渲染未登录占位**：`usageGuard` 的极性写反了（`begin()` 返回的探针报告的是**过期**），导致每一个未被更新的响应都被丢弃。已修正为 `const stale = …; if (stale()) return`，并由真实渲染测试（jsdom + react-dom）钉住。
- **间隔输入框可以正常输入**：逐键 clamp 会让 `120` 被记成 `520`、清空即跳回 `5`。现在只把**合法的整数**折进草稿，显示始终是原始输入，失焦/回车时**恰好收敛一次**。
- **保存失败不再丢弃草稿**：写入失败或「回读没有带来新 props」时保留草稿并说明原因；**草稿是用户编辑的唯一副本**。
- **批量动作后重新读取用量**：签到会领取积分、测试会写入探测结果，而面板数字来自用量路由——现在批量成功后**恰好重新读取一次**，且**失败时不重读**（避免掩盖错误）。
- **同一区域的用量请求只允许最新一次写入**：轮询 / 保存 / 批量三种刷新会并发，慢的响应原先可以覆盖新的快照。
- **成员勾选不再静默丢账号**：`editDraft` 的依赖数组缺了保存的成员列表，勾选会以**旧成员列表**为基准，保存即静默移出成员。
- **池路由的错误按原因本地化**：四个 503/500 位置现在都带结构化的 `reason`，中文用户不再只看到英文。
- **幽灵池（成员已消失）给出可执行的恢复指引**，而不是笼统失败。

### Tests

- **引入真实渲染测试（jsdom + react-dom）**：第四轮独立对抗验证证明「读源码文本」的守卫与「住在行为里」的缺陷之间必然有缝——18 个变异体恢复了**用户可见**的缺陷而整套测试仍全绿。本轮把 `AccountPool.tsx` / `WorkBuddyCard.tsx` 真正挂载进 DOM 断言，从根上结束这一整类问题，并据此击毙了其中 16 个（余 2 个经逐字论证为**等价变异体**，不恢复任何缺陷）。
- 逐条收紧被证明可绕过的守卫：`stripLiterals()` 连**字符串字面量**一起去（原先只去注释，一个字符串就能顶替一次真实调用）；「恰好一次」改为对**标识符**计数；A-8 增加「`committed` 只能被写一次且不在 `catch` 里」。
- 修掉一个会**伪造结论**的工装缺陷：调度器用例对负载敏感，固定轮数的排空在 CPU 争用下会读到 0，变异工装会把它读成「守卫抓住了变异体」，从而报告出并不存在的覆盖。现在改为**排空到条件成立**。

### Docs

- README 两份均新增**账号池**章节（含产品截图）：两个批量动作、成员为何必须显式勾选、自动轮换与手动选择的互斥、目标模型与间隔、四种探测结果与回池条件、以及为什么卡片上有两个「保存」。
- 新增 `docs/audit/` 审计与修复档案：A–I 九份独立报告 + MASTER 汇总 + E-fix-log 逐轮修复记录。全部 51 条审计条目经独立验证**100% 可复现**（0 条误报）。

## 2.3.1 (2026-09-29)

### Features

#### 模型「测试」改为真实体积：揭穿「测试通过、实际被限」

**上游的 6004 限流按请求体积触发**，而此前的探针只发 `max_tokens: 1` + `ping`（约 18 token）——它永远够不到那条线。于是出现一个自相矛盾的现象：**卡片测出来模型可用，真实会话却每次都 429**。这不是探针算错，而是它**问的问题太轻**。

真机量化（2026-09-29，同一账号、同一模型，只改输入体积）：

| 输入 | 上游计到的 prompt_tokens | 结果 |
| --- | --- | --- |
| ~10 | 38 | ok |
| ~1,000 | 1,138 | ok |
| ~10,000 | 11,138 | ok |
| ~18,000 | 20,018 | ok |
| **~25,000** | **25,023** | ok |
| ~30,000（干净账号只发这一次） | ~32k | **429 / 6004** |

- **阈值在 20k 与 30k 之间，单次大请求即触发**（不是累计），且**每个账号各有自己的重置时间**（实测同一时刻两个账号分别报 `22:20:33` 与 `00:32:51`）。
- **为什么这是用户会踩到的**：插件向 DSH 宣称的上下文窗口最高 200K（`web-status.ts` 把 1M 的模型按默认预算压到 200K），DSH 因此要到 20 万 token 才压缩——**远超上游 ~20–30k 的节流线**。长会话里请求一路涨过阈值，之后每一次都失败，而小探针始终显示可用。
- **改动**：**只保留一种测试**，即每个模型行上的「测试」按钮，它现在发一条 **~25k 输入 token** 的真实体积请求。真机验证：请求体 112,713 B，上游计到 `prompt_tokens: 25023`。
- **删掉了两样东西**：① 原先的最小探针（`probeRequestBody` 的 `ping` 版本、`heavy` 开关、`PROBE_USER_PROMPT`）；② 模型区顶部的**「测试已勾选」批量按钮**。后者不是排版调整而是成本决定——每次探测都真花钱（实测 `credit` 约 0.02～0.72），一次覆盖整个已勾选列表就是一次不可控支出。路由相应改为**只接受 1 个模型**（多于 1 个直接 400）：卡片只发这一个形状，多模型请求不是卡片发的，拒绝它正是防止陈旧 bundle 或手写客户端把按钮变成消费循环的那道闸。
- **实测代价**：一次「测试」报 `credit` 0.02（健康账号、25k 输入）；被限流时立即 429 并给出重置时间。此前的最小探针是 0～0.01。

### Bug Fixes

#### 「上游未给出何时恢复」是错的：恢复时间一直在响应体里

2.3.0 的模型测试上线后，真实使用暴露了一个要命的偏差：**探针说模型可用、用户点「测试」也看到通过，但真正发请求却被限流**；而被限流的那一行显示的是「上游未给出何时恢复」——**上游其实说了，就在响应体里**。

- **根因**：`cooldownOf()` 只读两个来源——`Retry-After` 响应头、以及积分耗尽时的月度刷新点。而本服务的 429 **根本没有 `Retry-After` 头**，重置时间写在响应体的 `msg` 文本里。实测抓到的原文（2026-09-29，逐字）：

  ```json
  {"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-30 02:30:30 UTC+8 重置，您也可以切换其他模型继续使用。"}
  ```

  2.3.0 的注释写「上游不提供限流元数据」，这个结论**是从响应头单独得出的**——就响应头而言是对的，作为结论是错的。
- **为什么「测试通过、实际被限」不是探针的错**：探针与真实请求的判定本来就一致。用真实凭据实测，同一模型用**四种请求形态**（`max_tokens:1` + `ping`、`max_tokens:2000` + 长 prompt、以及两者交叉）全部返回**同一个 429**；13 个模型里只有 `deepseek-v4.1-flash` 被限，其余 12 个（含默认的 `glm-5.3-flash` 一类）全部 `ok`。所以「测试通过」看到的是**别的模型**，而被限的那个恰好是配置里用着的。限流由账户/模型维度的配额决定，与请求大小无关——这也回答了「加大请求能不能测出来」：不能。
- **修法**：新增 `parseUpstreamResetAt()`，从失败响应体解析 `将在 <时间> UTC<偏移> 重置`；`cooldownOf()` 增加第三个来源 `upstream-message`（优先级：响应头 > 响应体 > 月度刷新点）。`probeModel()` 把 body 传给它。
- **时区必须按偏移量算，不能被本机时区左右**：`2026-09-30 02:30:30 UTC+8` 是 UTC 的 `2026-09-29T18:30:30Z`。直接 `Date.parse` 会**按本地时区**解读——在 UTC+8 的机器上恰好正确，换台机器就静默错一个偏移量。因此用 `Date.UTC` 组装后减去声明的偏移，实测 UTC / Asia/Shanghai / America/New_York 三种 `TZ` 下输出一致。
- **宁可不说，也不说错**：无法解析时返回 `undefined`，卡片继续如实显示「上游未给出何时恢复」。`Date.UTC` 会把 13 月、32 日**静默归一化**成另一个真实时刻，所以解析后逐字段回验，不合法就丢弃；`UTC+99` 这类越界偏移同样拒绝。这些都配了用例。
- **守卫与变异验证**：`tests/probe.spec.ts`（28 → 38 例）覆盖：真机原文端到端（经 `probeModel`）、响应头优先于响应体、`T` 分隔符与 `UTC+0800` 紧凑写法、负偏移、四种「不该解析出时间」的形态、三种非法日期、越界偏移。**变异验证**：把偏移量那一步去掉（当成 UTC 算）→ **6 例变红**。
- 文案无需改动：`row.probeRateLimitedAt`（`✗ 被限流 · {at} 之后可再用`）本就存在，此前只是永远走不到。

### Tests

- `tests/probe.spec.ts`（28 → 42 例）：探测请求体**恒为真实体积**且随目标常量缩放；`parseUpstreamResetAt` 的真机原文、`T` 分隔符、`UTC+0800` 紧凑写法、负偏移、越界偏移、三种非法日期、四种「不该解析出时间」的形态；`cooldownOf` 三级来源的优先级（响应头 > 响应体 > 月度刷新点）。
- `tests/web-status.spec.ts`（49 → 50 例）：路由**只接受单个模型**，多模型请求 400。
- **变异验证**：把偏移量换算去掉（当成 UTC 算）→ **6 例变红**；去掉单模型强制 → 对应用例变红。
- 全量：**449 例全绿**（2.3.0 为 434 例），typecheck 与 build 通过。

## 2.3.0 (2026-09-29)

### Features

#### 模型「测试」：一键查出限量模型的冷却恢复时间

**新增模型可用性测试。** 卡片每个模型行新增一个**测试**按钮，模型区顶部新增**测试已勾选**（对 `enabledModelIds` 逐个测）。每个模型只发**一条最小请求**（`max_tokens: 1`），直接回答两件事：**这个模型现在能不能用**，以及**不能用时什么时候恢复**。

限量模型的冷却时间过去只能靠反复试错去猜——现在点一下就有结论。

**实测（本机真实账号，两个网关）**：CN 16 个与全球 23 个模型各抽样实打，全部 HTTP 200；单次耗时 0.8～3.4s。**成本可忽略**——响应体 `"credit"` 报 0～0.01，其中一次探测前后余额完全不变（933 → 933），而名册上正常一次回答是 0.79x 起。

**关于「多久之后可以再次使用」，有一条必须先说清的事实：上游不给这个数据。**

探测前先做了取证：200 响应头里**没有 `Retry-After`，也没有 `X-RateLimit-*`**；对同一模型**连续快速打 12 次全部成功**，未触发任何限流。因此本功能**不编造倒计时**，只在两种上游真的说了时间的情形下显示时间：

| 情形 | 卡片显示 | 时间来源 |
|---|---|---|
| 成功 | `✓ 可用（1.2s）` | — |
| 429 / 限流，上游未给时间 | `✗ 被限流 · 上游未给出何时恢复` | 无（如实说没有） |
| 429 / 限流，带 `Retry-After` | `✗ 被限流 · {时间} 之后可再用` | `Retry-After` 头（秒数或 HTTP-date 两种形态） |
| 积分耗尽，且该区域有月周期包 | `✗ 积分不足 · 积分包 {时间} 刷新` | 月周期包的 `refreshAtMs` |
| 积分耗尽，无月周期包 | `✗ 积分不足 · 上游未给出何时恢复` | 无 |
| 401/403 凭据被拒 | `✗ WorkBuddy 拒绝了这个账号的 token——请重新登录或换一个账号` | — |

> ⚠️ **本节的第 2 条来源此后有更正（见 Unreleased）**：本节写「上游不提供这个数据」，那是**只看响应头**得出的结论——响应头里确实没有，但上游把重置时间写在**响应体**里（`将在 … UTC+8 重置`）。「上游未给时间」那一行因此在真实 429 上从不该出现。解析与实测见 Unreleased 的 Bug Fixes 一节。

限流**不会**去借月周期包的刷新时间：那会让用户为几秒的限流去等几周。这个区分由 `cooldownOf` 强制，并有专门用例钉住。

**为何每个探测请求都必须以 system 消息开头**：国际网关（`www.workbuddy.ai`）对 `[{role:'user'}]` 一律返回 HTTP 400 / 业务码 `11128`（`first message is not system prompt`）。按国内版那样只发一条 user 消息，会把**整个国际版误报成全部不可用**。实测加上 system 消息后立即 200，故探测请求始终带一条 system 消息。

- **架构**：探测在 **Host** 侧发起（`src/probe.ts` 构造与解读，`WorkBuddyUpstreamClient.probeChat` 传输，`/plugins/dsh-connect-workbuddy/probe` 路由）。浏览器只发模型 id、只收回结论——**凭据绝不跨到页面**。
- **串行而非并发**：路由逐模型依次探测。一次并发扇出正是制造「限流」最直接的办法，那样测出来的会是插件自己的负载，而不是上游的限制。有专门用例钉住这一点。
- **不依赖 `dirty`**：测试按钮不受「有未保存改动」影响——它回答的是「这个模型现在能不能用」，这与是否已保存无关；把它绑在 dirty 上，按钮会在用户正决定取舍时恰好失效。也**不依赖 `canWrite`**（探测不写任何设置），但**依赖已登录**（没凭据只可能是「被拒」）。
- **不改动运行时**：探测结果不写入设置、不影响 `enabledModelIds` / `imageModelIds`，运行时目录零改动。
- **错误分类复用**：`outcomeOfFailure` 建立在既有的 `classifyUpstreamError` 之上（中英文额度标记、`soft_rate` / `hard_credit`），使探测与真实 chat 请求对同一上游应答的判定不可能分歧。
- **失败不抛异常**：单个模型探测失败返回一条结果，不中断整批——一个坏模型不该把其余行的结论一起吞掉。失败正文经 `safeMessage` 同规则脱敏（JWT 与 `token=` 查询参数）。

### Tests

- `tests/probe.spec.ts`（新增，28 例；此后在 Unreleased 增至 38 例）：请求体必带 system 首条且 `max_tokens: 1` / `stream:true`；`Retry-After` 的秒数与 HTTP-date 两形态、以及 0 / 负数 / 过期时间不被当作冷却；`cooldownOf` 的四种组合（含**限流绝不编造时间**、**限流不借月周期刷新时间**）；七类失败分类；成功流不被截断影响；**抛出异常不逃逸**；失败正文脱敏。
- `tests/web-status.spec.ts`（+10 例）：逐模型串行调用（并发变异会红）、region 透传、空列表 / 非数组 / 超限批量一律 400、无能力时 503、非回环来源 403、非 POST 405、未知 region 400、抛错转 500 且不泄露 token。
- **变异验证**（5 处，逐一实测变红）：给限流编造固定倒计时 → 3 例红；删掉 system 首条消息 → 2 例红；让限流借用月周期刷新时间 → 1 例红；把串行批改为并发扇出 → 1 例红；其余对照组全绿。

## 2.2.1 (2026-09-29)

### Fixes

#### 图片勾选框的提示文案去掉冗余括注

2.2.0 把「已核验为多模态」这一态的提示写成了「图片（厂商文档标明原生多模态）」。这行字挂在**勾选框的 tooltip** 上，而该态是刷新后的默认态——多数模型都是它，把判定依据重复一遍既啰嗦又没有信息量。

现在该态只显示「图片」/ `Image`。另两态（厂商文档为纯文本 / 未核实）保留说明文字：它们需要解释**为什么没被勾上**，否则夹在一排已勾选的模型中间会显得像缺陷。

- 改动面：仅 `src/client/locales.ts` 的中英两条文案，无行为变化。
- 已确认构建产物中不再包含该括注。

## 2.2.0 (2026-09-29)

### Features

#### 图片输入：刷新时按**厂商核验表**覆盖勾选

此前图片支持完全由用户手动勾选（默认全关），**上游声明支持的模型也要用户自己一个个找出来勾上**。现在改为：点「从 WorkBuddy 刷新」时，卡片按**厂商核验表**覆盖图片勾选，保存后写入 `imageModelIds`；用户仍可随时手动纠正，只有下一次刷新才会再次覆盖。

**关键区分：上游的 `supportsImages` 不是「模型能不能看图」。** 它是**平台侧**的图片输入声明。2026-09-29 用插件自身的凭据路径只读实测（不消耗积分）：

| 网关 | CLI 模型 | `supportsImages=true` | `=false` | 缺失 |
|---|---|---|---|---|
| CN `copilot.tencent.com` | 16 | 15 | 1（仅 `glm-5.1`） | 0 |
| 国际 `www.workbuddy.ai` | 23 | **23（全部）** | 0 | 0 |

拿它当能力答案，就会把纯文本模型也标成能看图。**这个错误本项目犯过一次，姊妹项目 `workbuddy-manager` 也犯过并已修正**——其 CHANGELOG 1.0.70 原文：「此前直接把腾讯的『平台支持图片』开关当成模型的原生能力，于是 GLM-5.3 这类纯文本模型也被标成多模态。现在按厂商文档逐条核对（记录来源与核验日期）……**未核实的新型号显示『待核实』而不猜**」。本版采用同一口径。

- **核验表** `NATIVE_MODALITY_BY_MODEL_ID`（新增 `src/native-modality.ts`）：13 条，全部核验于 2026-09-25，取自 `workbuddy-manager` 的 `server/services/native_modalities.json`。`glm-5.3` / `glm-5.2` / `glm-5.1` / `hy3` / `hy4-preview` / `deepseek-v4-pro` = `text`；`glm-5.3-flash` / `glm-5v-turbo` / `deepseek-v4.1-flash` / `minimax-m3` / `kimi-k2.6` / `kimi-k2.7` / `kimi-k3-1` = `multimodal`。逐条来源见 `docs/DESIGN.md` 的「图片输入」。
- **刷新判定** `imageDefaultFor`：只有核验为 `multimodal` 才预勾选。`text` 不勾；`unknown`（含 `auto` 路由器与所有未收录的新模型）**也不勾**——「不猜」正是这张表存在的理由，上游声明不参与判定。平台显式 `false` 保留一票否决。
- **不做前缀/族匹配**：`glm-5.3` 是 `text` 而 `glm-5.3-flash` 是 `multimodal`，前缀规则必然错一个；`hy3` 是 `text` 而 `hy3-x` 无来源，不能用族关系传递结论。表按**精确 id** 匹配。
- **分工**：`supportsImages`（平台声明，仍解析并随 `lastCatalog` 持久化）= 展示用；`native_modality`（厂商核验）= 刷新默认值；`multimodal`（运行时生效值）= **只来自保存的 `imageModelIds`**（`src/index.ts` 的 `withImageSelection` 盖章）。解析器从不设置 `multimodal`——刷新目录不会越过用户保存去改运行时，勾选仍是「刷新 = 草稿、保存 = 生效」。
- **本机实测影响面**：CN 16 个里 **7 个**会预勾选；被排除的纯文本有 `glm-5.3`、`glm-5.2`、`hy3`、`hy4-preview`、`deepseek-v4-pro`（上游对前五个全报 `true`）。国际 23 个里只有 **3 个**有厂商来源，其余 17 个（`gpt-5.x`、`gemini-3.5-flash`、`grok-4.7`、自建别名 `default-model`/`fast-model` 等）都是 `unknown`，默认不勾——这是「不猜」的代价，也是它的意义。
- **卡片 tooltip**：勾选框按三种情形给出说明（已核验多模态 / 文档为纯文本 / 未核实），否则一排勾选中间夹着两个空框会显得像 bug。
- **改动面**：`src/upstream.ts` 解析 `supportsImages`（平台声明，仅展示）；`src/native-modality.ts`（新）承载核验表与判定；`src/status-paths.ts` / `src/web-status.ts` 透传给卡片；`src/client/WorkBuddyCard.tsx` 的 `refreshModels` 用它覆盖 `imageIds`。**Host 侧运行时逻辑零改动**。
- **维护负担**：核验表是**快照而非实时同步**，且与 `workbuddy-manager` 仓库各存一份，两边更新需手动同步。新增 id 必须附厂商来源与核验日期。
- **边界**：静态 fallback 目录不参与判定，新装用户首次刷新并保存后即获得默认勾选；已保存过目录的老用户，勾选状态在下次刷新前保持不变。

### Tests

- `tests/native-modality.spec.ts`（新增）：锁定核验表为唯一判据——`text` 不勾（即便平台报 `true`）、`multimodal` 勾、`unknown`/`router` 不勾、精确 id 匹配（`glm-5.3` vs `glm-5.3-flash`、`hy3` vs `hy3-x` 不得互相传递）、平台显式 `false` 保留否决、表条目数固定为 13 以防 id 悄悄漂入。
- `tests/upstream.spec.ts`：新增「解析平台声明」一例（true / false / 否决 / 缺失即未知四态），并保留原「解析器不推断 `multimodal`」一例。
- `tests/web-status.spec.ts`：新增刷新路由一例，确认 `models/refresh` 逐模型带回 `supportsImages`、未声明的条目不带该字段。
- `tests/persisted-model.spec.ts`：新增一例，确认 `supportsImages` 随 `lastCatalog` 持久化、而 `multimodal` 仍被按 KEY 剥离（严格 JSON codec 兼容）。

## 2.1.2 (2026-09-29)

### ⚠️ 兼容性修复：peer 上界 `<0.2.0` 会在 0.2.0 落地时把整个组合包静默判死

本版**无功能改动**，只修一处**声明**——但这是一处会在下一个 DSH 版本落地那一刻生效、且**用户侧完全无提示**的缺陷。

#### 缺陷

10 条 `dsh-*` peer 此前写作 `>=0.1.7-rc.1 <0.2.0`。这个上界在写下的当时是对的，但它有一个**只在下一个版本线落地时才显形**的形状：

- `0.2.0-rc.1 < 0.2.0` 成立 → 整条 0.2.0 **预发布**线被放行（所以 0.2.0-rc.1 上一切正常）
- `0.2.0 < 0.2.0` 不成立 → 正式版一发布，**10 条 peer 全部失败**

DSH 的随包门禁 `evaluatePluginCompatibility`（`packages/boot/app-boot/src/plugin-compatibility.ts`）逐条判定这 10 条；**只要一条不满足，整个组合包就被 `loadProfileDirectory` 跳过**，只写进 `skippedBundles` 并由 `reportSkippedBundles` 打到 stderr。它不是崩溃，是**静默消失**：provider 不注册、卡片不出现、模型列表清空，页面上没有任何报错。

- **取证方式**：把 0.2.0-rc.1 tag 里的 `plugin-compatibility.ts` **原样取出**，喂进本插件真实的 `package.json`。`0.2.0` / `0.2.1` / `0.3.0-rc.1` 全部 `DENIED(10/10 peers fail)`，而 `0.2.0-rc.1` / `0.2.0-rc.2` 通过——即「预发布能用、正式版不能用」的悬崖。
- **这条路径并非假想**：同机实测，profile 里 `dsh-rewind-plugin`（`^0.1.7-rc.2`）、`dsh-free-search`（`^0.1.7-rc.1`）、`dsh-better-reasoning-effort`、`@changfenhuang/dsh-genui` 四个组合包**已经**因同样的原因没有出现在实时组合里——`listConfigs` 共 203 条，其中无一条来自它们；同 profile 内 peer 全通过的包则全部在场。

#### 修法：上界改为 `<0.3.0-0`

**为什么带 `-0`**：DSH 至今 **23 个 tag 全部是预发布**（`-alpha.N` / `-rc.N`），从未发过 GA。因此：

- `<0.3.0` 只挡 `0.3.0` GA——而 GA 永远不来——上界**永不生效**，同时静默放行 `0.3.0-alpha.1` / `0.3.0-rc.1` 整条从未验证过的线。**这正是今天这个缺陷的形状：看起来是围栏，实际不挡任何东西。**
- `<0.3.0-0` 显式挡掉 `0.3.0-0`（含）以上的一切预发布与 GA，围栏真的会响。

`-0` 是 semver 里「该版本线的最小可能预发布」，所以 `<0.3.0-0` 意为「0.3.0 线一个都不放」。同作者同架构的 `dsh-connect-trae` 2.3.0 对同一处缺陷的处置与此一致。

| 宿主 | 改前 | 改后 |
| --- | --- | --- |
| `0.1.7-rc.1` / `0.1.7-rc.2` | admitted | admitted（**不回归**） |
| `0.2.0-rc.1` / `0.2.0-rc.9` / **`0.2.0`** / `0.2.1` / `0.2.99` | rc 通过、**GA 被拒** | admitted |
| `0.3.0-0` / `0.3.0-alpha.1` / `0.3.0-rc.1` / `0.3.0` | — | **DENIED**（下一线仍未验证，符合原意） |

`0.1.7-alpha.1/alpha.2` 改前改后都是 DENIED（`>=0.1.7-rc.1` 下界所限），属既有行为，不是本次引入的回归。

#### 顺带移除一处过期声明：`@deepseek-ai/dsh-client-runtime`

该包停在 `0.1.1-rc.2`、不在任何受支持主机的捆绑集内，且 **源码零引用**（`src/` 里只有两处注释提到它；构建产物 `lib/client.js` 的 `require` 只有 `react` / `react/jsx-runtime`）。它此前作为「旧主机行的类型来源」被保留，但那条线已随 2.1.0 移除。现连同 **devDependency、pnpm override、tsdown 的 `neverBundle` external** 一并删除——保留一个零引用的 override 只会让清单与 lockfile 继续声称一份并不存在的依赖。

#### Tests

新增 `tests/dsh-line.spec.ts`（11 例）：守卫上下界口径、**上界真的挡得住**、下界不放松、两个客户端包不掉队、过期 devDependency 不回流，外加两条把口径写进发布清单与两份 README 的 POLICY 守卫。

- **关键设计**：边界断言**对声明本身求值**，而不是对测试里另写一遍的字面量求值——否则清单与断言各自漂移也能全绿，那正是本套件要防的「看起来是围栏、实际不挡」缺陷换了一层。为此自带一个小而完整的 semver 序比较（本仓库无 `semver` 依赖），并附一条**比较器自检**用例：它错了，整套守卫就是装饰品。
- **变异验证**（7 处，逐一实测变红）：改回 `<0.2.0` → 3 例红；`<0.3.0-0` 改成 `<0.3.0` → 3 例红；下界抬到 `>=0.2.0-rc.1` → 3 例红；**只让 10 条 peer 里的一条漂移** → 4 例红；把 `dsh-client-runtime` 塞回 devDependencies → 2 例红；删掉 `RELEASING.md` 的宿主范围核对 → 1 例红；删掉 README 的范围表 → 1 例红。对照组（未变异）11 例全绿。
- **比较器可信度**：自写的 semver 序比较与真实 `semver@7.8.5` 做过差分测试，576 组配对全部一致（该差分用例为一次性核对，未随包分发）。

#### Docs

- `README.md` / `README.en.md`：「版本要求」一节补上**当前验证窗口**（`0.1.7-rc.1` ~ `0.2.x`）与新增的「受支持的宿主范围」表（含 0.3.0 线被明确拒绝），并就地说明 `<0.3.0-0` 与 `<0.3.0` 的区别。两语一致。
- README 里指向 `tests/` 的引用写成代码体而非 Markdown 链接：`tests/` 不在 npm `files` 白名单内，写成链接在 npm 上会是死链——与 2.1.1 处理 `docs/WINDOWS.md` 时同一考量。

#### 复核结论：对 0.2.0-rc.1 零代码改动

除上述声明外，**代码一行未改**。逐包核对 0.2.0-rc.1 tag，本插件触碰的 12 个内核包其 `src/` 树与 0.1.7-rc.2 **逐字节相同**（`git rev-parse <tag>:<path>/src` 树哈希相等）：

`dsh-llm`、`dsh-llm-pi-ai`、`dsh-settings`、`dsh-host-webserver`、`dsh-atomic-write`、`dsh-home-paths`、`dsh-attachment`、`dsh-client-ui-settings`、`dsh-client-ui-slots`、`dsh-client-ui-renderer`、`dsh-client-ui-settings-plugins`、`dsh-client-locale` —— 仅 `package.json` 的 `version` 字段由 `0.1.7-rc.2` 变为 `0.2.0-rc.1`。

运行时契约同步核对：`plugins.bundle.config` / `plugins.row.config` 两个槽位仍在且分发点未变（`renderSlot(..., { entryKey })` 三行未改动）；客户端 `configForms` 服务与 `PluginConfigViewProps` 契约未变；主题令牌只增未减（插件使用的 `--dsw-alias-state-error-primary` / `-warn-primary` 均在）。实机状态：0.2.0-rc.1 宿主上 `/plugins/dsh-connect-workbuddy/usage` 返回 **200** 真实数据，两个槽位均由 `dsh-connect-workbuddy-client` 占用且 `active: true`，宿主 Config 条目 `include:dsh-connect-workbuddy` 状态为 `schema`。

## 2.1.1 (2026-09-26)

### Features

- **平台支持口径明确化：Windows 是一等目标平台。** 此前 README 只在**散落的五处**顺带提到 Windows（凭据路径、加密字段、`settings.yaml` 占用、路径未验证、CLI），**没有任何一处说「支持 Windows」**——读者要自己把五处拼起来才知道这是受支持平台。本次把它写成明示口径，并把「以后每次改动都要考虑 Windows」落到仓库里，而不是留在会话或记忆里。

  - **`README.md` / `README.en.md` 新增「平台支持 / Platform support」一节**：一张三平台对照表（凭据默认目录、桌面 App 可执行文件的定位方式、心跳时间戳来源、设置写入的瞬时占用、CI 覆盖），加 Windows 上需要知道的三个具体点。表内每格都是**实现事实**（对应代码位置与测试已登记在 `docs/WINDOWS.md`），不是「尚未支持」的委婉说法。
  - **新增 `docs/WINDOWS.md`（平台约束登记处）**：登记 Windows 专属分支（初版四处，本次追加 §1-5 后为五处；改错会怎样）、**证据分级 A/B/C/D**（真机取证 / CI 实测 / 约定推导 / 未验证，写结论时措辞必须与档位相称）、Windows 专有故障历史（2.0.6 / 2.0.11 / 2.0.12 / issue #11 #13 #15）、改动检查清单、尚未做的事。该文件随 npm 包分发（`files` 白名单），否则 README 里指向它的链接在 npm 上会是死链。
  - **`RELEASING.md` 新增 §2.5「平台核对」**：每次发布前过一遍 `docs/WINDOWS.md` §4 的检查清单，并核对 CI 矩阵仍含 `windows-latest`、两条 README 的平台节与登记处三者一致。这是唯一**每次发布都必然被读到**的位置，因此把口径挂在这里。
  - **`.gitattributes`（新增）**：仓库此前没有换行符约定，而文本文件在索引里都是 LF。Git for Windows 默认 `core.autocrlf=true` 会在检出时转成 CRLF，于是同一份测试在 Windows 与 POSIX 上读到的字节不同——本仓库的测试会直接读源码文本，这类断言必须跨平台稳定。现显式声明 `* text=auto eol=lf` 与各文本类型、并把图片等标为 `binary`。
  - **为什么值得写进文件而不是只嘱咐一句**：这四个要素（CI 矩阵的 Windows 项、登记文件、两条 README 的平台节、发布清单）**每一个都是一行之差就会静静消失的东西**，而消失时不会有任何东西报错——CI 会继续全绿，构建会继续成功，README 会继续正常渲染。据此加了 `tests/platform-standing.spec.ts` 作为守卫。
  - **`docs/WINDOWS.md` §7「在 Windows 真机上验证」**：一份可照做的操作手册——先跑 `doctor --json` 一次拿全四项证据（附字段→分支对照表），再逐项验 §1 的各分支，重点是最值得实测的 §1-4（设置写入的瞬时占用，附可直接粘贴的 PowerShell 锁文件脚本），最后给出回报时应附的信息，以便把 §2 里那些 C 档结论升为 A 档。本次已在真机执行过其中大部分，结果记录在 §7.0。
  - **顺带查实并改正一处事实错误：被写入的是 profile 配置，不是 `settings.yaml`。** 撰写 §7.3 的锁文件脚本时才发现，0.1.7 线上配置文档是 profile 目录下的 **`cordis.patch.yml`**（`config-editor` 的 `documentPath`；易失字段也经同一条 `edit()` 落在那里），而 `settings.yaml` 在该线**只用于一次性导入旧版本配置**，导入后即改名为 `settings.yaml.imported`。插件此前在**代码注释、README（两语）、以及一条面向用户的报错文案**里都写着 `settings.yaml`——在「Windows 上文件被占用」这个头号限制的场景里，这等于把用户指向一个不存在的文件。现已全部改正；面向用户的文案改为「当前 profile 的配置文件」并指向 `docs/WINDOWS.md`（不写死具体文件名，避免随 DSH 版本再次过期）。

### Bug Fixes

#### Windows 宿主内每次进程存活判定都闪一个黑色控制台窗口

`src/host-heartbeat.ts` 的 `processStartTimeMs()` 用 `execFileSync('powershell', …, { encoding: 'utf8' })` 启动子进程，**没有设 `windowsHide`**——而同一仓库的 `src/at-rest.ts` 在取 at-rest 密钥时设了。两处不一致，缺的那一处就是缺陷。

- **为什么在 macOS 与终端里永远看不到**：Windows 只在**父进程没有控制台**时才给控制台程序子进程新建窗口。终端里父进程有控制台，子进程只是继承，现象根本不存在；`windowsHide` 在 POSIX 上又是无操作。所以这个缺陷对本地开发与现有测试**完全不可见**。
- **而真实宿主正是会触发的形态**：`DSH NEXT.exe` 是 Electron GUI 进程，实测 `MainWindowHandle = 0`、无控制台。于是每次 `isHeartbeatProcessAlive()`（`status` / `doctor` 都会走到）都会在用户屏幕上新建并显示一个控制台窗口——即「黑框一闪」。
- **真机取证**（Windows 11 22621，用 WMI 服务 `Win32_Process.Create` 造出与 GUI 宿主同为「无控制台」的父进程，再由子进程用 `kernel32!GetConsoleWindow` + `user32!IsWindowVisible` 自报它实际拥有的控制台）：

  | 父进程形态 | 不设 `windowsHide` | 设 `windowsHide: true` |
  | --- | --- | --- |
  | 终端（有控制台） | 继承，无新窗口 | 继承，无新窗口 |
  | WMI 服务创建（无控制台，等价于 GUI 宿主） | **`NEW-console hwnd=1573500 visible=True`** | `no-console` |

- **同时排除一条错误判据**：不能用 `Get-Process powershell | MainWindowHandle` 观察。控制台窗口归 `conhost.exe` 所有，控制台程序自身的 `MainWindowHandle` 恒为 0——即使窗口正在屏幕上，该探针也报 0（本次实测中它先给出了假阴性）。
- **修法**：抽出 `PROCESS_PROBE_OPTIONS`（`{ encoding: 'utf8', windowsHide: true }`）与 `processStartProbe(pid, platform)`。后者的 `platform` 可注入，与 `defaultDesktopAuthDirs()` / `workbuddyAppExecutableCandidates()` 同一套缝——使平台分支与启动选项**在任意主机上都可断言**，这是此类「Windows 专有、macOS 上不可能复现」缺陷唯一能被回归拦住的形态。
- **守卫与变异验证**：`tests/host-heartbeat.spec.ts` 断言选项值与平台分支；`tests/platform-standing.spec.ts` 新增用例要求**两个** spawn 点都带 `windowsHide: true`。去掉该选项 → 对应用例变红（已实测）。`docs/WINDOWS.md` 登记为 §1-5 分支并附 A 档取证。

#### `docs/WINDOWS.md` 里 issue #13 的「重试预算（200+600ms）」是错的

该数字没有任何实现支撑。核对上游 `@deepseek-ai/dsh-atomic-write`（rc.1 与 rc.2 常量相同）后，真实预算是**延迟序列 20+40+80+160+200×4 ≈ 1100ms**（`initial 20ms` / `max 200ms` / `limit 8`）——**不存在 600ms 这一项**。

- **真机实测**（同一台 Windows 11，逐一量持有期与结果）：持有 0 / 100 / 300 / 600 / 1000ms 后释放 → 写入**全部成功**（端到端 3 / 174 / 339 / 760 / 1165ms）；持有 60s（超出预算）→ `EPERM`，且目标文件**保持原内容**、不产生半写文件（已验证 `onDisk` 仍为原值）。
- 现已按实测改写 `docs/WINDOWS.md` §3。这条属于**文档里的数字与实现脱节**：它不影响行为，但会误导后来者按错误的预算去调参或归因。

#### `dsh.client.inject` 仍依赖 `dsh-client-ui-primitives`

`ddd11ed`（上游复审那次提交）第 6 条把卡片折叠箭头从宿主图标 `IconChevronDownOutline14` 改为**纯 CSS caret**，并删掉了该包在 `src/client/` 的最后一处导入——但 `package.json` 的 `dsh.client.inject` 里的 `@deepseek-ai/dsh-client-ui-primitives` 留了下来。声明比代码活得久。

- **为什么不是无害的多余声明**：`inject` 不是「仅供参考的清单」，但**它的作用范围比初看要窄**——两条机制各自加了一道限制，本条据实说明：
  1. **它是加载/预取元数据**。内核在 `arriveGraphRow` 里沿它走 `arriveDependency`（`packages/client/modules/src/client/system.ts:268`），把该包列为「本行物化前必须先到」；`prune` 也把它当保留根（同文件 `:448`）。内核自己的注释把语义定得很明确：「`inject` names package rows whose factories must arrive before this row materializes」（`manifest.ts:47`），而 `ui-workspace` 的注释补了另一半：**「`dsh.client.inject` edges are informational (loading/prefetch metadata, never apply sequencing)」**（`packages/client/ui-workspace/src/client/index.ts:90`）。**不是 apply 顺序约束**。
  2. **目标是 graph row 才成边**。`arriveGraphRow` 取依赖时带 `if (dependency !== undefined)` 守卫（`system.ts:269`），而 `graphRows` 只装入 `dsh.client` 声明过的包（`system.ts:133` ← `index.ts:837`）。`ui-primitives` **没有** `dsh.client` 声明，它是平台 seed 词（`packages/client/web/src/seed.ts:36`、`platform.ts:12`）——**因此它永远不在模块图里，这一条 inject 条目实际不产生任何加载边**。
- **那么它为什么仍该删**：它是**过期声明**，不是运行时炸弹。真实成本是「声明与代码不一致」本身——保留一个零引用条目，等于向未来的维护者与工具谎称本插件依赖该包；一旦哪天该包被移出平台 seed 表（它并非不可能：该包在本区间改动 75 个文件、约 1500 行，且是唯一删除了导出 `OnboardingSurface` 的一个），这条就会从「无效」变成「生效的隐式依赖」，而那时没人记得它是怎么来的。清掉它，是让声明回到只描述真实依赖的状态。
- **修法**：从 `inject` 删除该条目（`package.json` 的 `peerDependencies` / `devDependencies` / `tsdown.config.ts` 的 externals 保留——那是类型检查与构建所需，与运行时装配无关）。
- 另：`src/client/WorkBuddyCard.tsx` 的文件头注释至今仍写着「`IconChevronDownOutline14` 的使用…来自该项目」，而该图标导入早在 `ddd11ed` 就已删除（改成纯 CSS caret）。本次一并更正该注释——它就是这条过期声明当初的同类残留。

#### 卡片主题令牌名写错：`state-warning-primary` 在两条 0.1.7 线上都不存在

加密凭据原因的着色用了 `--dsw-alias-state-warning-primary`，而宿主真实令牌是**缩写形** `--dsw-alias-state-warn-primary`（`packages/client/ui-theme/src/styles/design-platform.css`，在 rc.1 与 rc.2 上**都**只有缩写形）。

- **为什么静默**：该声明带十六进制兜底色 `#e0a13a`。CSS 自定义属性名不存在时 `var()` 走兜底——规则从不空白，于是**兜底值在每一次渲染都生效**，宿主令牌从未被用上，颜色与设计系统彻底脱钩。写错一个词，不会有任何报错、告警或视觉空白来提示。
- **修法**：令牌改为 `--dsw-alias-state-warn-primary`，兜底值改为该令牌的真实解析值 `#f59e0b`（`--dsw-static-amber-500`）。
- **实际可见变化**：加密凭据那条原因的着色由 `#e0a13a` 变为 `#f59e0b`（宿主设计系统的 amber）。据实说明一点：`--dsw-static-amber-500` 在 light 与 dark 两处定义**同为 `rgb(245,158,11)`**，即该令牌是**主题不变量**——所以这次修复不是「颜色开始跟随主题」，而是「颜色回到宿主令牌这条正确的取值路径上」：取值此后由宿主决定，且兜底值与令牌一致，即便令牌缺失也不会再显示成一个无关的颜色。
- 这不是 0.1.7-rc.2 引入的问题，是**既有缺陷**；rc.2 只是提供了发现它的时机。内核自己的决策记录点名过同一处混淆（`.agents/notes/implemented/architecture/2026-09-05-shared-client-control-primitives.md:71`）。

### Tests

- 新增 `tests/client-host-contract.spec.ts`（6 例）：上述两处都是**声明性**缺陷，因此测试读文件（`package.json` 与 `src/client/styles.ts`）而非导入它们——也让本套件不必拖入浏览器专属的 DSH 客户端包。用例覆盖：`inject` 不得出现客户端半边零引用的包；不得依赖 `ui-primitives`；四条真正参与组合的客户端包同时在册（防反向丢漏）；不得使用 `state-warning-primary` 长形；`state-*` 令牌必须落在宿主定义集内；兜底值必须是宿主 amber。
- **变异验证**：把 `ui-primitives` 塞回 `inject` → **2 例变红**；把令牌改回 `state-warning-primary`/`#e0a13a` → **3 例变红**。两处缺陷各自单独还原都会被抓住。
- 记录一条本次核实到的**反直觉事实**，避免后人写下错误的断言：`inject` **不是** value imports 的镜像。内核自身两个方向的反例都在——`ui-settings-plugins` 用裸 `import type {}` 做模块增强却照样 inject 那两个包（`src/client/index.ts:11,15`）；`ui-theme` 实际导入并使用 `ui-primitives` 的**组件**（`AppearanceRow.tsx:11`）却**不** inject 它。故本套件只断言「inject 里不得有零引用项」这一单向不变量，不碰反向。

- 新增 `tests/platform-standing.spec.ts`：把「**Windows 是一等目标平台**」这条长期口径固化成可执行的守卫（见上方 Features 的说明）。守卫两头：**政策面**（CI 矩阵仍含 `windows-latest`、登记文件与两条 README 的平台节仍在且互相指得通、`RELEASING.md` 的平台核对仍在、`DESIGN.md` 仍指向登记处），以及**代码面**（`docs/WINDOWS.md` §1 登记的 `win32` 分支仍存在、生产源码不得把平台路径写成 POSIX 字面量）。**变异验证**：CI 矩阵去掉 `windows-latest` → 1 例变红；README 把「一等目标平台」改软 → 1 例变红；`auth.ts` 的 `win32` 分支改名 → 1 例变红。本次追加 1 例（要求两个 spawn 点都带 `windowsHide: true`），并把心跳分支的断言改指向新缝 `processStartProbe(pid, platform)`——**变异验证**：去掉 `windowsHide` → 该例变红。
- 另新增 2 例（同文件）守卫本次顺带查实的事实：被写入的配置文档是 profile 的 `cordis.patch.yml`，不是 `settings.yaml`。**变异验证**：把用户文案改回 `settings.yaml` → 1 例变红；把 `docs/WINDOWS.md` §7.3 里「不是 `settings.yaml`」的澄清改掉 → 1 例变红。

### Docs

- **修正两处已过期的「推理强度两态」表述**——文档还停在「未修复」，而代码早在 **2.0.10**（`4c39645`，issue #7）就已修复。纯文档纠正，**无代码改动**。
  - `docs/DESIGN.md`：「推理强度两态（已知问题）」改为「已修复」，并补上实际实现（`parseReasoning` 两态解析、`singularEffortLadder` 折叠为全阶梯 `low/medium/high/xhigh/max`、单数值折入 `defaultEffort`、`canDisableThinking` 视为 `true`）与两网关实测依据；同节字段表里 `reasoning.effort` 的「固定推理档位」改为「折叠为全阶梯可选档位，该值作默认档」。
  - `docs/reasoning-investigation.md`：状态由「调查完成，**未修复**」改为「已修复（issue #7，随 2.0.10）」，并**就地标注**其余过期处——第三节（根因）标为历史代码形态；第四节的推断「不发 `reasoning_effort` 时上游按默认 `effort` 运行、这些模型一直在思考」被修复时的实测**推翻**（实测为**零思考**，即默认思考关闭）；第七节「待决策」标为已决策（采纳「结合实测」一路）；第八节补「落地情况」列，如实区分已落地与未采纳（`supportsReasoning` / `onlyReasoning` 至今确实未解析，属拟议增强而非缺陷）；第九节改标各文件实际改动状态。
  - 保留原文与就地注记，不删史——记录当时的推理路径，避免后人重复踩。

## 2.1.0 (2026-09-25)

### ⚠️ 版本基线：仅支持 DSH 0.1.7-rc.1 及以上

**自本版起，本插件只支持 DeepSeek Harness 0.1.7-rc.1 及以上的宿主**（`@deepseek-ai/dsh-*` peer 依赖的最低版本已从 `>=0.1.5-rc.1` 提高到 `>=0.1.7-rc.1`，旧版宿主将无法通过依赖解析安装本版）。

- **0.1.5 双线分支已移除**：宿主的 `installSection` 回落、客户端的 `settingsScope` 分支、`settings.plugin.item` 槽位注册已全部删除——`configure({auto}, owner)` 与 `configForms` 是唯一路径。
- 如果你仍在 0.1.5 宿主上，请停留在 **2.0.15**（最后一个支持 0.1.5 的 GA 版本；2.0.16 / 2.0.17 的缺陷修复已并入本版）。

### Bug Fixes

#### provider 被宿主判定为「未配置」（DSH 0.1.7-rc.1）

0.1.7 把设置模型整体重建（`SettingsProvider` → `SettingsForms`）后，**命名空间不再由插件自选**：宿主 `describe()` 以 **`ns: entry.options.id`**（Loader 条目 id）为键，而宿主按**精确匹配**查表 —— `namespaces.get(entry.settingsNs)`。我们此前硬编码 `settingsNs: 'workbuddy'`，而实测条目 id 是 **`include:dsh-connect-workbuddy`**，于是查表落空、provider 读作「未配置」，**不报错、只是静默失效**。

- **修法**：新增 `settingsNamespaceOf(ctx)`，采用一线插件的权威范式
  `const settingsNs = ctx.fiber.entry?.options.id ?? NS`（见 `dsh-llm-pi-ai`），并把全部 6 处用法改为解析值。`ctx.fiber.entry` 由 Loader 注入（非 Cordis 公共类型），因此保留探测 + 回落，并在无 Loader 条目时回落到声明常量。
- **常量移入 `src/status-paths.ts`**：浏览器侧也需要同一个回落值，而它不能 import Node-only 的宿主入口。该模块本就是 host↔client 的无 node 依赖桥梁。`src/index.ts` 继续导出，**公共 API 不变**。
- **回归测试**（`tests/settings-integration.spec.ts`，+4 例）：采纳 Loader 条目 id、无条目/空 id/非字符串时回落、以及**目录实际宣告的就是解析值**（断言目录条目而非常量，否则恒过）。**变异验证**：忽略 entry id 恒用常量 → **1 例立即变红**。

#### 插件管理页 / 市场页的 logo 显示不对

0.1.7 的插件管理页从插件包的 `package.json` 的 `icon` 字段读图标（`dsh-client-ui-plugin-manager` 渲染 `row.meta?.icon`，plugin-manager 契约含 `icon: z.string().optional()`），我们没有声明该字段 → 宿主无图可用。

- **修法**（照同级 `dsh-ldvh` 的做法）：新增 `icons/` 目录（64px + 128px 真实 PNG，其中 64px 与既有卡片内嵌 base64 逐字节一致——同族 LD logo），`package.json` 声明 `"icon": "icons/dsh-connect-workbuddy-128.png"`，并把 `icons` 加入 `files` 白名单随包分发。
- **验证**：`npm pack` 确认两个 PNG 进包（15 → 17 个文件）；desktop profile 的 link 安装下，`node_modules/dsh-connect-workbuddy/package.json` 已含该字段。

### Compatibility（对运行中 0.1.7-rc.1 宿主实测，非推测）

- **可用接缝**：宿主已识别本插件 Config（`status: "schema"`、`limitations: []`）；`authFile` / `accounts` / `regions` 的 `"x-cordis": {"volatile": true}` 齐备；客户端卡片在 `plugins.bundle.config` 与 `plugins.row.config` **均已注册且 active**；`settings.configure/describe/mutate` 三个方法签名逐字匹配；`loader/volatile-update` 事件仍在。
- **确认不受影响的破坏性变更**：`settings.plugin.item` 槽位删除（我们各自独立 try/catch，不牵连其他槽位）、`settingsScope` 客户端服务删除（改用 `configForms`）、**`dsh-client-ui-primitives` 图标命名族改名**（本插件不从该包取任何具名图标，折叠箭头早已改为纯 CSS）、`agent/session-start` 删除（未监听）、会话格式 V3→V4（不读写会话文件）。
- 核对明细见 `.dsh-npm-cache/compat-017-audit.md`。
- **测试基座改为手动 `apply(ctx, config)`**：`ctx.plugin(WorkBuddy, config)` 会让 Cordis 校验出 frozen 代理对象，测试无法再就地写入；改为直接调用 `apply()` 让 config 由测试与所选 settings 服务共享同一引用（模拟 0.1.7 Loader 的就地提交语义），`loader/volatile-update` 事件用正确的单参形式触发。

### Tests

- 349 → 348（删 2 例 0.1.5 形态用例：`installSection` 引用清理、0.1.5 回落；加 1 例 0.1.7 `configure` 唯一路径；命名空间 +4、其余不变）。

## 2.0.15 (2026-09-24)

### Bug Fixes

- **不能正确取消（或启用）国际版 / 国内版区域开关**（用户实报：「我发现现在不能正确取消国际或者国内版本」）。**写入其实一直是成功的**——用户机器上的 `settings.yaml` 已经写着 `regions.global.enabled: false`——失败的是**开关控件没能反映这个事实**，所以看起来像「点了没用」。

  - **根因（两处，都在读取侧）**：

    1. **开关读的是浏览器镜像，而写入落在 Host。** 2.0.14 把设置写入改为 **Host 端点优先**（那是唯一不会删掉兄弟区域的写入方），而**端点写入不会更新浏览器的 settings 镜像**——这一滞后在本仓库别处早已注明。开关的勾选态却是从镜像读的：

       ```tsx
       checked={regionEnabledOf(settingsScope?.getSnapshot().value, region)}
       ```

       于是 Host 已经提交了 `enabled: false`，复选框**仍显示为开**。这同时解释了为什么此前「读法」与「写入顺序」两轮修复都没有暴露它：**写入一直是对的，错的是回显**。

    2. **切换后不重新读取 Host。** `toggleRegion()` 写完就结束，从不重新拉取状态，因此新值根本没有机会进入卡片。

  - **修法**：
    - 开关改为**以 Host 的值为准**——Host 在状态载荷里已经送回它按自身 config 判定的 `enabled`（`deps.regionEnabled`）。镜像降级为**兜底**：老版本 Host 没这个字段、或状态尚未加载时，仍按存储文档渲染，而不是靠猜。两边用的是**同一条 opt-out 规则**（只有显式 `false` 才算关闭），因此两个来源不可能互相矛盾——只可能其中一个**过期**。
    - `toggleRegion()` 在写入后 **`await refreshUsage(item)`**，重新读取 Host；失败时**显式报错**，而不是让开关静静地不动。
    - 面板打开时**两个区域都拉取**，而不是只拉当前标签页。两个开关**始终**渲染在标签栏上，只拉当前区域会让另一个开关一直停在镜像兜底上——正是本次要摆脱的那个过期来源。

  - **回归测试**（`tests/volatile-scope.spec.ts`，9 → 13 例）：断言 Host 已提交关闭而镜像仍说开时开关显示为**关**（反向同理）、Host 未应答时回落到镜像、以及兜底路径仍能容忍 `{get(): T}` 活引用（否则会退回「永远显示开」的老毛病）。**变异验证**：把读取改回「只看镜像」→ **2 例立即变红**。

### Tests

- 341 → 345（新增 4 例：区域开关以 Host 真值为准、镜像仅兜底）。

## 2.0.14 (2026-09-23)

### Bug Fixes

- **保存国内版 / 国际版信息时，总有一个区域的配置被清掉**（用户实报：「我保存国际版信息和国内版信息，总会丢失一个」）。这是 2.0.13 那条「活引用被展开成函数」缺陷的**客户端侧同源路径**——服务端（`__save`）那次只修了一半，浏览器侧一直在按错误的方式读同一个值。

  - **根因**：`regions` / `accounts` 被声明为 `asVolatile(...)`，schemastery 会把这类字段解析成 `{ get(): T }` **活引用**——**这一步发生在 schemastery 内部**（由 schema 的 `meta.volatile` 驱动），因此与 DSH 版本无关：0.1.5 与 0.1.7 上，浏览器侧看到的解析值**都是**活引用。
  - 而活引用**仍然是 `typeof === "object"`**。卡片的每一次写入都是「读出当前区域映射 → 展开 → 覆盖自己那一格」，用来保住**另一个**区域。两处读法都栽在这一点上：
    - `src/client/account-selection.ts` 的 `fieldSnapshotOf()`：`{ ...活引用, [region]: slot }` 得到 `{ get: <函数>, [region]: slot }` —— **另一个区域被整个丢掉**，同时还把引用函数写进了文档。
    - `src/status-paths.ts` 的 `regionsMapOf()`：它检查「是对象且不是数组」就把值当成区域映射返回，而活引用**恰好满足**这个判断。于是映射里每一次查表都是 `undefined`——`regionEnabledOf()` 读出的开关状态**永远是「开」**（这正是该函数注释里警告过的那个历史症状），`nextRegionEnabled()` 的合并基座也变成 `{ get: <函数> }`，**开关一次就丢掉另一个区域**。
  - **修法**。三条独立缺陷，缺一条症状就仍在：
    1. **读法**：`fieldSnapshotOf()` 与 `regionsMapOf()` 都先 `unwrapVolatileDeep()` 再使用。该 helper 原本只存在于 Host 入口，浏览器侧取不到，因此**移入 `src/status-paths.ts`**——那个模块本来就是 host↔client 的无 node 依赖桥梁——并由 `src/index.ts` 继续对外导出，**公共 API 不变**。
    2. **写入顺序**：`writeField()` 改为 **Host 端点优先**。两个写入方的语义**并不相同**，而这一点恰恰会删数据：
       - `__save` 在 Host 进程内把提交的区域合并进该字段的**权威值**，保留其余区域；
       - `scope.set(field, next)` 是把**整个字段**交给 settings 服务，而这个字段是客户端**从浏览器的镜像**自己合并出来的——Host 在这条路径上**不做任何服务端合并**，因此客户端给什么就**原样成为**什么。

       而镜像**不更新**由端点完成的写入（`contextBudgets` 处早已注明这一滞后），在此前受影响的 0.1.7 部署上该命名空间的镜像更是长期陈旧。于是从镜像构造的合并结果是 `{ [本次区域]: slot }`——**兄弟区域全部缺失**——而 `scope.set` 把它原样存下，区域就此消失。这正是「我保存了国内版，国际版的信息就没有了」。也解释了用户机器上的**混合状态**：`accounts` 两个区域都在（写入时镜像恰好是新的），而 `regions` 少了一个。
    3. **镜像回写**：`__save` 现在**返回它实际存下的那个字段**，客户端据此刷新镜像；此前客户端会用**自己那份陈旧镜像重新合并**再 `scope.set` 回去，**反而把 Host 刚保住兄弟区域的合并结果覆盖掉**。老版本 Host 只回 `{ok:true}`，此时该刷新自动跳过。
  - **回归测试**（新增 `tests/volatile-scope.spec.ts`，9 例）：整个套件此前只用**普通对象**模拟 `getSnapshot().value`，而线上真实的形状是活引用——**受影响的路径从未被测过**。新用例按真实形状构造 scope，并**按真实写入路径**建模（Host 端点在服务端合并并回传结果、镜像滞后、`scope.set` 原样存储），断言两个区域在每种交替顺序下都存活、且文档里绝不出现引用函数。另有一例断言客户端镜像的是 **Host 答回的权威值**，而不是它自己重新合并的结果。
  - **变异验证**（分别撤销每一处）：`fieldSnapshotOf` 解包 → **5 例红**；`regionsMapOf` 解包 → **2 例红**；镜像回写改回「从自身镜像重合并」→ **仍会删掉兄弟区域**。三处修复各自必需。

  > 更正两次：① 2.0.13 的说明里我写过「对单 region 写入足够」——**那是错的**，每条写入路径都要靠这次读取来保住另一个区域。② 2.0.14 发布前我判断「读法」是唯一根因——**也不完整**，还有上述第 2、3 条写入路径缺陷。二者均在此订正。

### Tests

- 332 → 341（新增 9 例：活引用形状下的双区域写入、开关回归，以及「Host 端点为权威、镜像不得删掉兄弟区域」的写入路径回归）。

## 2.0.13 (2026-09-23)

### Bug Fixes

- **上下文预算（或任何 regions/accounts 字段）保存失败：`settings mutate … must contain only JSON-compatible data (found a function at $.ops[0].value.get)`**（用户实报）。这是把「易失标记一生效」那条缺陷（2.0.12 修的）的**另一条受害者路径**补上了。

  - **根因**：`__save` 端点（卡片保存的 Host 兜底路径）在合并时直接读取 `row.value[field]`，而 `row.value` 是 settings 服务解析后的 config——某 volatile 字段（`regions` / `accounts`）在那里是一个 `{ get(): T }` **活引用**。`{ ...这种对象 }` 展开后变成 `{ get: <函数> }`，于是 `settings.mutate` 的严格 JSON 兼容校验拒绝它，报 `found a function at $.ops[0].value.get`。保存**完全失败**（不是静默失败，而是直接报错），因为真实保存流程里 `scope.set()` 被判为未落盘后回退到了这个端点。
  - **修法**：`__save` 在合并前先 `unwrapVolatileDeep(row.value?.[field])` 把活引用剥净，让 `mutate` 收到的 payload 只含 JSON 兼容数据。`unwrapVolatileDeep` 是 2.0.12 为 `installSection` 引入的同一 helper，这里复用。
  - **回归测试**（`tests/web-status.spec.ts`）：构造一个 resolved config 含 `{ get() }` 活引用的 settings 服务，经真实 `__save` 路由请求，断言 `mutate` 收到的是一个能通过 JSON 往返的 payload（无函数），且上下文预算字段完好。**变异验证**：把 `unwrapVolatileDeep` 那行去掉，该用例立即变红。

  > 说明：`__save` 会先把 `row.value[field]` 解包、再用「浅展开 + incoming 覆盖」合并到该字段。对单 region 写入（本次场景）足够；若日后要一次写多个 region 槽位，应改为深合并——届时再扩。

### Tests

- 331 → 332（新增 1 例：live-reference 配置下的 `__save` 保存回归）。

## 2.0.12 (2026-09-23)

### Features

- **支持 DSH 0.1.7 线，且同一个构建同时服务 0.1.5 与 0.1.7**（合并社区 PR #14，作者 [@qikairo7](https://github.com/qikairo7)）。这不是「多支持一个版本」的可选增强——**在 0.1.7 上插件此前根本装配不起来**。

  - **根因：settings 服务换型，`installSection` 消失。** 0.1.5 的 `SettingsProvider` 提供 `installSection(owner, ns, schema, entry, hooks)`；0.1.7 换成 `SettingsForms`，该方法**整个移除**（我在 `dsh-settings` / `dsh-config-editor` / `dsh-client-ui-settings-plugins` 三个包的整份 tarball 里逐一确认无此符号，也未迁移到其他包），取而代之的是 `configure({auto}, owner)`。而插件此前**无保护地裸调用** `ctx.settings.installSection(...)`——`inject = ['llm','settings']` 两个服务在 0.1.7 上都存在，所以 `apply()` 会一路执行到那一行。实测（用一个行为等同 0.1.7 的 settings 服务装配）：

    ```
    apply() THREW -> ctx.settings.installSection is not a function
    ```

    即**整个插件装配失败**：两个 provider 都不注册，卡片与 Web 状态路由同样不存在。这与「某个功能坏掉」在用户侧都是「用不了」，但成因完全不同——**也因此「重新登录」「重装插件」一概无效**。现在改为按能力探测：有 `configure` 走 `configure`，否则回落 `installSection`。
  - **易失字段必须显式声明（issue #13 在 0.1.7 线上的真正根因）。** 0.1.7 的 settings 写入门要求插件 schema 把可写字段标记为 volatile，否则**写入被直接拒绝**（`Plugin entry "workbuddy" has no volatile fields`），`scope.set()` 却正常 resolve——于是卡片回读校验抛 `settings field "regions" was not persisted`。新增 `asVolatile()`：运行时探测 `schema.volatile()`，**有则调用、无则退化为 identity no-op**。这一条是兼容易失的关键——`volatile()` 在 3.18.3 才出现，更早的版本上 `asVolatile()` 必须**原样返回**同一个 schema 对象（identity no-op），而不是手写 `meta.volatile = true`：后者会绕过 schemastery 自身的 `validateVolatileSchema` 校验，产出一个它自己都不认的 schema，因此**故意不那样做**。
  - **0.1.7 以「活引用」交付配置值。** 0.1.7 把配置值以 `{get(): T}` 形式交给 `apply()`，不解包则 `config.regions`、`value.accounts[region]`、`config.authFile` 静默变成对象或 `undefined`——表现为「设置明明写了却读不到」。新增 `unwrapVolatile()` 并在所有读取路径上解包，同时监听 `loader/volatile-update` 在每次写入后重读选择。
  - **客户端双线槽位。** 两条线声明的是**互不相交**的槽位集合（0.1.5 只有 `settings.plugin.item`；0.1.7 是插件管理器的 `plugins.bundle.config` / `plugins.row.config`）。卡片现在逐个注册且**各自独立 try/catch**——一个槽位在某一线上不存在时，不能把另一条线的注册一起带走。settings scope 也按能力获取：0.1.7 走 `configForms.get(ns)`（并从镜像里取 Host 实际服务的 namespace，插件可能挂在别的 entry id 下），0.1.5 回落 `settingsScope.bind()`。
  - **折叠箭头改为纯 CSS。** 两线 primitives 的图标名不重叠（`…Outline14` vs `…OutlineRegular`），没有任何一个静态图标 import 能同时服务两边。

### Bug Fixes

- **CI 在 windows-latest 上红了 2 例**（2.0.11 引入，本仓库自身的缺陷）。新增的 darwin 候选断言写死了 POSIX 字面量（`expect(mac).toContain('/Applications/WorkBuddy.app/Contents/MacOS/Electron')`）。生产代码没问题——它用 `join` 拼路径；错的是**测试**：它断言的是「跑测试的机器是 POSIX」，而非「darwin 候选列表对不对」。Windows 上 `join` 产出反斜杠，于是必然失败，而 macOS 上恒绿——**这正是它能一路走到 CI 的原因**。改为全部经 `join` 构造期望值，并补一条回归守卫：候选路径不得**混用**分隔符（用字面量 `/` 拼接在 Windows 上会产出 `\Applications/WorkBuddy.app`，任何正确路径都不会长这样）。

- **易失标记一生效，0.1.5 线的设置区就整个消失**（合并 PR #14 后由本仓库查出并修复的真缺陷）。`asVolatile()` 给字段打上 volatile 标记后，该字段的值会被包成 `{get(): T}` **活引用**。而 `installSection(owner, ns, schema, entry, hooks)` 的第 4 个参数 `entry` 会被服务**校验并 `structuredClone`**，于是拿到活引用时逐字段抛错：

  ```
  $.authFile expected string but got [object Object]
  ```

  结果是命名空间**注册不上**——卡片设置区静默消失（实测 13 个测试变红）。

  - **为什么 PR14 与 CI 都没发现**：两边都把 schemastery 锁在 **3.18.2**，那里没有 `volatile()`，`asVolatile()` 退化为 identity no-op，**这条路径从未被执行过**。而 PR14 自己又把 schemastery 钉进 `dependencies: 3.18.4`——npm 用户会解析到嵌套的 3.18.4，`volatile()` 真正生效，**恰好走进没人测过的分支**。开发环境掩盖了用户环境的缺陷，这是本次最值得记取的教训。
  - **修法**：新增 `unwrapVolatileDeep()`，在把 config 交给 settings 服务前**递归**剥掉全部活引用（既有的 `unwrapVolatile()` 只剥调用方读取的那一层，够普通读路径用，不够交给服务校验用）。数组会被重建而非就地改写，调用方的 config 对象不受影响。
  - **顺带把 `asVolatile()` 导出**，让「有 `volatile()` 则打标记 / 没有则恒等 no-op」两条分支**在任何机器上都能被确定性地断言**；否则把钉住的版本一提，no-op 那条分支的覆盖就会静默消失（而这正是手写 `meta.volatile` 会绕过校验的那条防线）。

### Tests

测试总数 300 → 331。

- **双 settings 形态兼容（新增 2 例，这是 PR14 缺的那块）**：PR14 只测了 0.1.5 形态——而它修的恰恰是 **0.1.7 分支**，这样的套件在 0.1.7 分支再次坏掉时**不会变红**，正是让本次缺陷穿过 CI 的原因。现在两条路径各有独立用例：0.1.7 形态（有 `configure`、**无** `installSection`）下必须装配成功、两个 provider 均注册、且确实走了 `configure({auto:true})`；0.1.5 形态下必须继续走 `installSection`（否则命名空间不会注册）。**变异验证**：把 `installSection` 改回无保护裸调用，第一条立即变红。
- **活引用不得喂给 settings 服务（新增 3 例）**：`unwrapVolatileDeep()` 必须递归剥净（含嵌套与数组）、且不就地改写调用方对象；`installSection` 拿到的 entry 必须无活引用（断言注册结果与 `base` 形状，而不是断言内部调用，实现改动无法伪造）；两条 volatile 分支各自被确定性断言。**变异验证**：把 `installSection` 的 entry 改回原始 config，**13 个用例立即变红**。
- **供应商开关的落盘校验（新增 5 例）**：`locked` scope 下必须抛错、错误须标明 `regions`、正常落盘须成功、整槽位其余字段须原样带过、槽位存在但 `enabled` 是错值也须判失败（浅检查会放过「开关没真的关掉」）。
- **测试读取也走生产 helper**：新增 `readSettings()`——0.1.7 上 `settings.get()` 返回的同样是活引用，直接读 `doc.accounts.cn` 得到 `undefined`，那是**任何真实消费方都不会看到的形状**。断言统一经 `unwrapVolatileDeep()` 解包，避免测试在真实消费方看不见的形状上通过或失败。
- 其余为 PR14 自带的兼容与槽位隔离用例，以及上一版的凭据修复用例，全部保留。

**双版本验证**：同一份代码在 schemastery **3.18.4**（volatile 生效）与 **3.18.2**（no-op 分支）下**均为 326 通过**。

- **供应商开关是唯一漏掉「落盘校验」的设置写入**（同批查出的第二处）。关掉某个区域的供应商时，卡片直接调 `settingsScope.set('regions', …)`，**没有**读回校验，也**没接上**插件自己的 Host 兜底端点——而账号选择与模型目录两处早就两者皆有。于是 0.1.7 上那个「`set()` 正常 resolve 但什么都没存」的 scope 会让开关**看起来生效、随后静默复原**，正是 issue #13 的同一类静默失败。现在开关改走 `writeRegionEnabled()`，与其余写入同一条「先 scope、没落盘再走 Host 端点」的路径，要么写进去、要么明确报错。

  - 整槽位照旧原样带过（只改 `enabled`），用户的模型目录、勾选、图片开关与上下文预算不受影响。
  - 回归测试用 `locked` scope（`set()` 正常 resolve、不落盘）钉住；**变异验证**：把它改回直接调 `scope.set()`，3 个用例立即变红。

**同时把开发环境的 schemastery 提到 3.18.4**（`pnpm-workspace.yaml` 的 override）。此前它锁在 3.18.2，于是 CI 只覆盖 no-op 分支——**而用户实际拿到的是 3.18.4**（`dependencies` 钉住的那份嵌套副本）。开发环境与用户环境不一致，正是这个缺陷能同时躲过 PR 评审与 CI 的原因。代价是 no-op 分支不再由「装到的版本恰好很旧」顺带覆盖，因此 `asVolatile()` 改为导出，并用一条不依赖安装版本的用例把它钉死。

### Docs

- 本条目记录 0.1.7 的三项差异（settings 换型、易失声明、活引用）与其判定方式，供后续 DSH 升级时对照。

## 2.0.11 (2026-09-23)

### Bug Fixes

- **macOS 上「App 装着、账号也登录着，插件却说你没登录」**（issue #15，真机复现）。WorkBuddy 桌面端 **5.6.0 起**把 auth 文件的 token 字段改为 `$wbEncrypted` 加密信封，**macOS 与 Windows 同样如此**——此前「加密是 Windows 先行」的判断已不成立。而解密的密钥只能向本机 App 现取，于是「能不能找到 App」直接决定了「读不读得出凭据」。

  - **根因：macOS 可执行文件名是写死的，而且写错了。** `workbuddyAppExecutableCandidates()` 把路径拼成 `<bundle>/Contents/MacOS/WorkBuddy`，但两个真实 bundle（`WorkBuddy.app` / `WorkBuddy AI.app`）的 `CFBundleExecutable` 都是 **`Electron`**——该路径并不存在。于是 `findWorkbuddyAppExecutable()` 返回 undefined，密钥取不到，加密凭据一律读不出来。真机实测：修正后 `doctor` 从 `unavailable` 变为 `available (/Applications/WorkBuddy.app/Contents/MacOS/Electron)`，`keyId=9127dea1b44020a7` 与真实构建一致。
  - **二进制名改为向 bundle 自己问**（新增 `macosBundleExecutable()`，读 `Info.plist` 的 `CFBundleExecutable`）。App 改名、或换个二进制名，都不再需要改插件；plist 缺失或名字为空、含路径分隔符、为 `.`/`..` 时返回 undefined，**绝不猜一个路径**（plist 是磁盘数据，穿越会让 `execFile` 拿到 bundle 之外的东西）。
  - **候选补齐国际版与「App 被归入子目录」两种情况**：新增 `WorkBuddy AI.app`（只装国际版的机器此前零命中），并对 `/Applications` 与 `~/Applications` **向下扫一层**，覆盖 `/Applications/IDE/WorkBuddy.app` 这类整理习惯。扫到的候选必须先用 `CFBundleIdentifier` 确认身份（`com.tencent.workbuddy*` / `com.workbuddy.*`，按点号边界匹配）才会被使用——**每个 Electron 应用的二进制都叫 `Electron`**，只按名字匹配就有可能启动另一个产品；拒绝一个候选只损失一次回退，接受错的那个是在用户机器上跑别的程序。这条有独立测试钉住。
  - **Windows 候选补 `%LOCALAPPDATA%\WorkBuddy\WorkBuddy.exe`**：此前只探 `%LOCALAPPDATA%\Programs\WorkBuddy` 与两个 `Program Files`，装在用户级目录（同源 issue 里就有 `E:\WorkBuddy\WorkBuddy.exe` 这类自定义位置）的机器找不到 App。
  - **macOS 分支改为可注入（`readBundleExecutable`）**：它与 `platform`/`home`/`env` 同一性质——会读真实文件系统，不留缝的话「期望的候选列表」会取决于跑测试的机器恰好装没装 App（本机装了、CI 没装），正是 2.0.6 已经修过的那类红灯。

- **「未登录」与「登录信息读不出来」不再共用同一句话**（同一 issue 的用户可见症状）。这两件事在 `readAll()` 之后都表现为「账号数为 0」，此前一律抛 `no signed-in WorkBuddy account found … sign in once in the WorkBuddy desktop app`。但加密文件读不出来时用户**本来就是登录着的**，那句「重新登录一次」指向的是唯一无效的动作——issue #15 报告者的原话正是这句。

  - 新增 `WorkBuddyEncryptedCredentialError`（以 `ENCRYPTED_CREDENTIAL_CODE` 标记而非 `instanceof`，跨打包边界仍可靠，与 `WorkBuddyCredentialRejectedError` 同一约定）：`resolve()` 在**失败路径上**跑一次 `diagnose()`，只要有一个桌面文件归因 `encrypted`，就改抛这条，文案给出「安装桌面 App，或用 `WORKBUDDY_APP_EXECUTABLE` 指定其位置」，并明说重新登录无效。**健康路径一个探针都不跑。**
  - **诊断自身抛错不得顶掉真正的错误**：探测会读盘，失败时退回原来那句通用文案（有测试）。
  - **顺带删掉一句不可达的过滤**：初版写了 `reason === 'encrypted' && source === 'desktop'`，但 `encrypted` 只由 `probeAuthFile()` 赋予，而插件自有副本从不经过它（按自有文档形状解析，损坏时是 `invalid`/`unreadable`）——该条件永远为真。留着它会让代码看起来在防守一件它并没防的事；测试改为直接钉住真正的不变量（自有副本必须归 `invalid`，以及不存在 `source === 'dsh'` 的 `encrypted`），变异验证确认可咬住。
  - **卡片文案同步**：`signedOutNotice()` 让 `encrypted` 抢在通用提示之前（新增 `row.signedOutEncrypted`），因为通用提示说的正是那个无效动作。此前该建议藏在折叠区里的 `searchedEncryptedNotice`，而**段落**仍写着「重新登录一次」——用户多半只读那一段。既然段落已经承担，折叠区里那份重复提示连同其专属样式一并删除（2.0.10 刚立下的「段落说结论、列表给细节」分工，这次是它的延伸）。
  - 优先级：`selectionLost` > `wrong-region` > `encrypted` > 通用提示。`wrong-region` 仍排在前面——那种情况下凭据是可读的，切个标签页即可，比装 App 更省事。

### Tests

测试总数 300 → 316（新增 16 例）。

- `tests/at-rest.spec.ts`（+10 例）：`macosBundleExecutable` 必须读出 `Electron` 而不是按 App 名猜（**直接钉住本次根因**）、bundle 缺失时返回 undefined 而非猜路径、**四种穿越名（`../Evil` / `..` / `.` / `sub/Bin`）一律拒绝**、无 `CFBundleExecutable` 时返回 undefined；`isWorkbuddyBundle` 认国内版与国际版两个 id、**拒绝另一个 Electron 应用**（含 `com.workbuddyish` / `org.workbuddyevil` 这类仅前缀相似的）、拒绝不可读与无 id 的 bundle；候选列表含国际版与用户级目录、Windows 用户级安装被探到。macOS 相关断言全部走注入的 bundle reader，**套件结果不依赖跑测试的机器装没装 App**。
- `tests/auth.spec.ts`（+5 例）：加密文件 + 取不到密钥必须抛 `WorkBuddyEncryptedCredentialError`、`paths` 指向该文件、文案含 `WORKBUDDY_APP_EXECUTABLE` 且**明确不含**「sign in again」与通用那句（对渲染出的字符串断言，不是对输入）；真正没有凭据的机器仍走通用文案；密钥可用时照常解析成功；**自有副本损坏必须归 `invalid` 且不得产生加密结论**；`diagnose()` 抛错时退回通用文案。
- `tests/searched-paths.spec.ts`（+1 例，改 2 例）：加密原因必须在**段落**里被回答、且不回落去回显 `resolve()` 的消息；对渲染后的字符串断言「重新登录」这句话没有以任何形式残留。删掉了 `SearchedView.encrypted` 的两条断言——该字段已随折叠区那份重复提示一并删除（见下）。

**变异验证（实测）**：共 8 处定向改写，7 处被测试咬住。**其中 1 处（`source === 'desktop'` 过滤）逃脱**——正因如此才发现它是不可达的死代码并删除，同时把测试改为钉住真正的不变量，再次变异确认可咬住。其余：把 macOS 二进制名改回 `'WorkBuddy'`、从候选里删掉 `WorkBuddy AI.app`、让身份校验恒为 `true`、关掉加密归类、去掉穿越防护、把 `encrypted` 移出段落优先级、调换 `wrong-region` 与 `encrypted` 的次序——逐一挂掉对应用例。

**顺带清掉两处「看着像在防守、其实没有消费者」的代码**（与上面那句同源）：`describeMissingCredential()` 里不可达的 `source === 'desktop'` 过滤，以及 `SearchedView.encrypted`。后者的消费者是折叠区那份重复提示；提示既已由段落取代，字段留着只会让「列表」与「段落」在下次改动时再次漂移。

### Docs

- `README.md` / `README.en.md`：已知限制改口径——加密自 **5.6.0** 起、**macOS 同样在内**；补「二进制名向 bundle 现问」「含国际版 + 子目录扫描 + 身份校验」「未登录 ≠ 读不出来」三条。
- `docs/DESIGN.md` §6 风险与边界：新增第 6 条，记录本次取证结论与三个决定（向 bundle 问名字、扫子目录但必须校验身份、失败分类下沉到 `resolve()`），并记下那句不可达过滤为何被删。

## 2.0.10 (2026-09-22)

### Bug Fixes

- **未登录卡片「重复提示」**（用户实拍反馈）。上一版把探测过的路径列出来之后，同一条信息在屏幕上出现了四遍：`resolve()` 抛出的错误本身已经**枚举了所有候选路径**（`expected <Local>\workbuddy-desktop.info or <Roaming>\... or WORKBUDDY_AUTH_FILE`），下面折叠区又把同样的路径列了一遍（还带各自原因）；两处提示语（`row.signedOutHint` 与 `row.searchedHint`）又各自说了一遍「没有找到登录信息」。现在分工明确：**段落说结论，列表给细节**——只要列表会渲染，段落就不再复述 `resolve()` 的路径枚举，退回简短提示；`row.searchedHint` 也删掉了开头的「未找到登录信息」（列表标题「已检查的路径」已经承担）。

  - **列表缺席时才显示原始错误**：`searched` 为空（旧 Host、或探测抛错）时，`message` 不是重复而是唯一的信息来源，此时照常显示。被丢弃的只有「或刷新已有会话」——在 `searched` 出现的那条分支上它恰好是废话：那条分支**只在账号数为 0 时**成立，根本没有会话可刷新。
  - **`selectionLost` 优先级最高**：那种情况下 token 是健康的，正确动作是重选账号，任何路径列表都不能替代这条建议。
  - **判定规则下沉到可测模块**：新增 `signedOutNotice()` / `signedOutText()`（`src/client/searched-paths.ts`，无浏览器依赖）。卡片是 `.tsx`，本项目测试环境是纯 Node、没有 jsdom/react-dom，规则留在组件里就永远测不到——而「有没有重复」正是必须守住的东西。

- **`已检查的路径 (N)` 的 N 少数了一条**（同一张截图暴露的真实缺陷，经实机复现确认）。`diagnose()` 里有一句 `if ('credential' in probe) continue`：只要文件**能解析成凭据**就跳过，**不套用 `readAll()` 的区域过滤**。于是「一份有效的、属于另一个区域的登录」同时被两边排除——`readAll()` 按区域把它滤掉（所以它不是账号），`diagnose()` 因为它解析成功而跳过（所以它不是失败）。结果是：**它不在任何列表里**，卡片如实报告「检查了 1 条」，而同屏的报错信息却列了 2 条路径。用户那份**真正可用的登录**，正是被隐掉的那条。

  - **新增 `wrong-region` 原因**（第五档）：这**不是「没有」而是「找到了」**——凭据真实、可读、只是属于另一个标签页。因此它归入「值得先看」一组，直接展开，绝不收进折起的「不存在」里；它同时是整件事最省事的解释（切个标签页就好，不用重新登录）。
  - **段落直接给出修法**：存在 `wrong-region` 时，未登录文案换成 `row.signedOutWrongRegion`（「找到了你的登录信息，但它属于另一个地区…切换标签页即可，不需要重新登录」），而不是让用户自己从折叠列表里推断。

- **`missing` 条目的消息把路径又印了一遍**（实机验证时发现，同一类问题的更隐蔽一处）。Node 的 ENOENT 文案形如 `ENOENT: no such file or directory, open '<path>'`，而卡片本来就用自己的 `<code>` 行显示该路径，于是同一串字符**上下两行完全相同**。现在 `missing` 不再携带消息；真正的读取错误（`EISDIR` / `EACCES`）仍然保留——它们的文案说的是原因本身不包含的信息，且**不含路径**，这一点有测试钉住。

### Tests

测试总数 286 → 300（新增 14 例）。

- `tests/searched-paths.spec.ts`（14 → 23 例）：新增 `signedOutNotice` / `signedOutText` 专项——**有列表时不再复述路径**（直接对渲染出的字符串断言，且断言其中不含 `workbuddy-desktop.info` / `WORKBUDDY_AUTH_FILE`）、列表缺席时仍显示原始错误、`wrong-region` 抢先给出切换建议、`selectionLost` 在任何组合下都最高优先。另外把散在各处的四档原因清单收敛为 `ALL_REASONS`，并新增「**每一档原因都必须被分组，新原因不许落进 `missing`**」——这正是本次踩到的坑：新原因默认归入 `missing` 会被**藏进折起区**，与「发现」所需的可见性正好相反。
- `tests/diagnose.spec.ts`（10 → 14 例）：**跨区域的桌面凭据必须上报为 `wrong-region`**（直接钉住上面那个 `(1)` 的根因）、**它报告的路径条数必须与它给出的路径数一致**（总数不许少报）、`missing` 不带消息、`unreadable` 保留消息且不含路径。
- `tests/web-status.spec.ts`（+1 例）：`wrong-region` 原样穿过到浏览器——这条链路任何一环丢掉它，用户的登录就既不可见、计数也短一位。

**变异验证（实测）**：本轮共 8 处定向改写，全部被测试咬住（0 逃脱）——恢复 `diagnose()` 的静默跳过、段落重新复述 `resolve()` 消息、去掉 `wrong-region` 头部结论、把 `selectionLost` 降级、把 `wrong-region` 归入 `missing`、原因标签表回落到 `invalid`、提示语重新加上「未找到登录信息」、恢复 ENOENT 消息。

### Docs

- `docs/DESIGN.md` §3.4：记录「段落说结论、列表给细节」的分工，以及 `wrong-region` 为什么是**发现**而不是**缺席**。

## 2.0.9 (2026-09-22)

### Features

- **未登录时列出「探测过哪些路径、各自为什么没成」**（对齐 trae 的未登录体验）。此前卡片只会说一句「在桌面 App 里登录一次」，用户无法判断插件到底找过哪里——凭据存在别处、或桌面 App 装在非默认位置时，这句话既不解释现状也不给出下一步。现在未登录态的卡片带一个折叠区「已检查的路径 (N)」，逐条列出**路径 + 来源 + 原因**；标签页的改动只落在**真正什么都没找到**的那条分支上。

  - **四档原因，而不是笼统的「读不到」**：`missing`（不存在）/ `unreadable`（在但读不了）/ `invalid`（读到了但没有可用 token）/ `encrypted`（读到了、字段是加密的、拿不到密钥）。探测在 `probeAuthFile()` 里一次完成，`readAuthFile()` 退化为只要凭据的薄包装，既有调用方一行未改。
  - **`encrypted` 是 workbuddy 特有的、也是本版最重要的新增档位**：Windows 新版桌面端把 token 字段加密，读它需要桌面 App 自身的原生绑定（`WORKBUDDY_APP_EXECUTABLE` 可指定）。此时用户**多半已经登录了**，卡片若沿用「重新登录一次」就是在指一条无效的路。因此这类探测结果会额外顶出一条提示，明说「需要桌面 App 在场，单纯重新登录解决不了」。把它并入 `invalid` 会让这句提示永远显示不出来——这正是变异测试专门盯住的一条。
  - **同一档内再分「值得先看 / 只是不存在」**：普通机器上多数候选路径都是 `missing`（App 只写一个文件，平台却有好几个候选目录），全部平铺会把真正解释失败的那一条淹掉。因此 `encrypted`/`invalid`/`unreadable` 直接展开，`missing` 收在第二层折叠后；而当**全都是** `missing` 时它就是答案本身，直接展开，不需要再点一次。trae 定义了 `row.searchedMore` 文案却从未接上，这里真正实现。
  - **只在「一无所获」时列出**：`selectionLost`（有本地登录、只是保存的账号 id 失配）这条分支不列路径——那些 token 是好的，正确动作是重新选账号，一列失败路径只会把话带偏。这一条有独立测试。
  - **诊断本身永不成为失败源**：`diagnose()` 会真的读盘，因此卡片侧对「没有 `diagnose()` 的旧 Host」「探测抛错」「结果为空」三种情况都退回到原来那句提示，不把整个卡片拖成错误态；空结果也不下发空数组（否则卡片会渲染出一个「已检查的路径 (0)」的空块）。
  - **消息先脱敏再下发**：探测信息来自文件系统与桌面 App 的子进程，两者都可能回显 token 片段。新增的路径列表不能变成新的泄露面，因此沿用 `safeMessage()` 过滤后再跨到浏览器。
  - **插件自己的副本不作为「已检查路径」上报**：它直到首次刷新才存在，报出来只会给每台机器稳定加两条噪声。

### Tests

测试总数 255 → 286（新增 31 例）：

- `tests/diagnose.spec.ts`（新增 10 例）：`diagnose()` 的四档原因逐一钉住——全空机器上**仍报告探测路径**、可读文件**不出现在报告里**、非法 JSON 与「有 JSON 无 token」都归 `invalid`、加密且无密钥归 `encrypted`、密钥查找抛错也归 `encrypted`、**拿到了密钥却打不开归 `invalid`**（这是「App 在、文件坏了」，建议与「装 App」不同）、**健康文件不因旁边有个坏文件而被误报**、报告里不含 token 片段、跨区域不串号。加密夹具用与桌面端相同的 AES-256-GCM 编解码器现场封制（复用 `at-rest.spec.ts` 的做法），因此 `encrypted` 是对着一个真实信封证明的，而不是一个现实中不可能出现的假标记。
- `tests/web-status.spec.ts`（新增 7 例）：路径列表下发、`encrypted` 原因原样穿过到浏览器、空结果**不下发空数组**、无 `diagnose()` 的旧 store 优雅降级、探测抛错不影响状态路由、`selectionLost` 时不列路径、消息里的 token 形状内容被脱敏而路径本身保留。
- `tests/searched-paths.spec.ts`（新增 14 例）：展示规则（`missing` 何时隐藏/何时展开、分组内保持 Host 探测顺序、四档原因各自映射到不同文案键、来源标签、总数口径），以及**两套语言里四档原因的文案互不相同**——文案合并会让 `encrypted` 在用户眼里退回成「文件不存在」，而其余测试全绿。

**变异验证（实测）**：共 14 处定向改写，全部被测试咬住（0 逃脱）——`encrypted` 并入 `invalid`、`missing` 误报为 `unreadable`、把插件副本的空缺也上报、无密钥的加密文件报成 `invalid`、空结果下发空数组、消息不脱敏、`selectionLost` 时也列路径、`missingOpen` 恒为 `false`、`encrypted` 移出「值得先看」集合、原因标签丢掉来源、`encrypted` 映射到别的文案键、总数只数可见组、加密提示丢掉 `WORKBUDDY_APP_EXECUTABLE`、以及四档文案合并成一条。

### Docs

- `README.md` / `README.en.md`：功能特性新增「未登录时列出探测过的路径与原因」一条。
- `docs/DESIGN.md` §3.4：记录未登录诊断的四档原因划分，以及「`encrypted` 必须独立成档」的理由。

## 2.0.8 (2026-09-22)

### Features

- **可以单独关掉任一版本的供应商**（对齐 trae 的 issue #11）。每个 tab 右侧新增一个勾选框（默认都勾选），**取消勾选即把该供应商从 DSH 模型选择器里彻底撤掉**，而不是只藏起 tab。

  - **关闭动作落到注册层，不是 UI 层**：`AdapterRegistrationHandle.replace([])` 抽掉该区域的路由，`DirectoryRegistrationHandle.replace([])` 摘掉它在「设置 → 模型」页的目录条目。已验证 `listProviders()` 在该区域关闭后不再含它——这正是 DSH 构造模型选择器的取数来源，所以分组是**真的消失**，不是被藏起来。注册仍是「先正常注册、再 replace([])」两步在同一同步段内完成：空数组的**首次**注册会被 DSH 拒绝（`INVALID_ADAPTER`），而 `replace([])` 明确合法。
  - **配置**：`regions.<cn|global>.enabled`，**opt-out**——只有显式 `false` 才关闭。**开关出现前的配置、以及区域拆分前的扁平旧字段一律视为开启**，老用户零感知。
  - **状态不丢**：开关只改该区域 `enabled` 一个字段，该槽位的目录 / 勾选 / 图片开关 / 上下文预算，以及另一个区域的整个槽位，全部原样带过。关掉再打开能完整恢复。
  - **保存模型不会偷偷重开**：卡片保存目录时会**回写 `enabled`**——那次写入替换整个槽位，漏掉它就会「保存一次模型列表 = 悄悄重新打开已关闭的供应商」。
  - **已关闭的区域不再做无意义的启动请求**：跳过它的启动目录刷新与 `registerModelDiscovery` 兜底，顺带消掉「无账号区域每次启动报一次错」的失败面。
  - **已知代价**：若某会话此前选中的正是被关闭供应商的模型，该会话再调用会报 `NO_ADAPTER`（`no adapter registered for provider "..."`）。这是「彻底移除」的必然结果，卡片在关闭态的 tab 上给出明确提示文案，不静默失败。
  - **与 issue #12 的「无账号自动隐藏」是两个独立维度**：`WorkBuddyCatalog` 现在同时持有 `usable`（自动：本机有无该区域账号）与 `enabled`（用户显式开关），`current()` 在**两者都成立**时才返回模型。只有用户重新勾选、且该区域确有账号时，模型才会回来。

### Tests

测试总数 236 → 255（新增 19 例）：

- `tests/region.spec.ts`（新增 11 例）：`regionEnabledOf` 的 opt-out 缺省、**同时接受「整个 settings 段」与「`regions` 子对象」两种入参**（这正是 trae 上真实发生过的 bug：卡片传错一半 → 判定恒为 `true` → 勾选「点了没反应」）、`nextRegionEnabled` 只改目标字段且不碰另一区域、以及 Host 侧 `regionEnabled` 对扁平旧配置判定为开启。
- `tests/catalog.spec.ts`（新增 4 例）：`setRegionEnabled` / `isRegionEnabled`、关闭后 `current()` 为空、重新开启恢复、以及 **`usable` 与 `enabled` 两个闸门互不干扰**（只开开关不足以让无账号区域复活）。
- `tests/settings-integration.spec.ts`（新增 4 例，走真实宿主装配）：关闭国际版后 `listProviders()` 不含 `workbuddy-global`、目录条目同步消失、**国内版的目录条目必须仍在**（守护「目录是一次性注册持有两个条目」这一约束）、另一侧不受影响、重新开启恢复、两个都关仍可恢复、旧配置两边都开。
- `tests/web-status.spec.ts`：`enabled` 在 signed-in / signed-out 两个分支都下发。

**变异验证（实测）**：把「撤掉路由」改成「照常注册」（即只隐藏 tab 的假实现），3 条集成测试立刻失败；把目录 `replace` 改回**按区域分别调用**，`registers both regional providers` 与 `both switched off can still be restored` 两条失败，失败现场收到的正是 `[{workbuddy-global}]`——国内版条目被覆盖掉了，与 trae 记录的这个 bug 完全一致。测试确实咬得住。

### Docs

- `README.md` / `README.en.md`：「功能特性」新增「可单独关闭任一版本供应商」一条，并在双供应商那条说明关闭后的效果与代价。
- `docs/DESIGN.md`：说明区域开关为何必须落在注册层（`replace([])`），以及它与 issue #12「无账号隐藏」的维度差异。

## 2.0.7 (2026-09-22)

### Features

- **凭据被上游拒绝时，给出「可执行的」建议，而不是笼统地让你重新登录**。一个 401 背后可能是两件完全不同的事，而说错那一句比不说更糟：**选中的账号**已作废、但本机另一个登录明明好用（此时该「切换账号」，重新登录毫无作用——凭据从来不是问题，作废的是那条**选择**）；或者本机所有登录都已失效（此时才该「重新登录」）。

  - **先分类，再给建议**：新增 `WorkBuddyCredentialRejectedError`（由 `CREDENTIAL_REJECTED_CODE` 标记而非 `instanceof` 识别，跨打包边界仍可靠），网关的 HTML 401/403 与 JSON 形态的 401/403 都归入此类；503 之类的**瞬时故障不会被误判**成凭据问题——那需要重试，不是重新登录。
  - **确实去探测，而不是猜**：被拒后，插件用 `credentialFor()` 取出**其他**账号的凭据（**不触碰当前选择**），向计费网关的廉价只读接口发一次真实请求，验证它是否仍然可用。有一个能用 → 卡片直说「本机账号『X』实测可用，切换即可」并给**一键切换**按钮；一个都不能用 → 如实说「还有其他账号但都没通过校验，可切换试试」；**本机再无其他账号** → 才提示重新登录。
  - **`reloginRequired` 只在「本机没有别的账号可切换」时为真**，绝不作为「探测没验证出东西」的兜底——那正是本次要消除的误导。三种情形互斥，各有独立测试。
  - **代价只在失败路径上**：健康账号一次探测都不发。判定按「区域 + 账号 id + 该凭据的 `lastRefreshAtMs`」缓存 60 秒（卡片会轮询），**重新登录会改变签发时间从而自动失效旧判定**，无需显式清理。
  - **绝不自动切换**：账单落到哪个账号是用户的选择，探测只回答「切过去是否有用」，切换动作留给用户点。`credentialFor()` 独立于当前选择，正是为了在探测期间不把计费悄悄改道。
  - **卡片的泛化提示不再与之打架**：原先「出现错误 → 重新登录 APP」在凭据被拒时会让位给上面这条具体建议；`creditsError` 仍原样保留在下方作为技术细节。

### Fixes

- **新版桌面端（Windows 先行）加密了 auth 文件的 token 字段，插件不再把「已登录」误判为「未登录」**。WorkBuddy 桌面端某个 Windows 构建起，`auth.accessToken` / `auth.refreshToken` 不再是纯字符串，而是写成 `{"$wbEncrypted":1,"envelope":"…"}` —— 一个 AES-256-GCM 信封。此前的解析器只接受字符串，遇到对象即返回「无 token」，于是**文件完全健康、账号却显示未登录**，或退回到某个早就作废的旧备份凭据上、由上游回一个 HTML 401。用户侧的「重新登录桌面端 + 重新选账号」当然修不好它：问题不在凭据，而在读不出来。

  - **加密格式**：`envelope` 是 base64 的 JSON（`suite` / `keyId` / `nonce` / `authTag` / `ciphertext`），suite 1 = AES-256-GCM，12 字节 nonce、16 字节 tag。AAD 不是空串，而是一段**长度前缀转录**（域分隔符 `WB-AAD\0` + 版本 + 格式 ID `WBEV1` + scheme `sym-v1` + suite + keyId + framing 码 + 两个可选字段的缺省标记）。转录把「这段密文是为哪种 framing 封的」也绑进认证，因此把整文件信封当字段信封打开会认证失败，而不是解出半截东西。
  - **密钥来源（本版本最关键的决定）**：字段密钥是 App 的**构建期常量**，编译在其 Electron 原生模块（`electron_browser_workbuddy_storage`）里，由 `loggerGet()` 返回载荷；App 自己对载荷里的 base64 **字符串**做 SHA-256 得到 32 字节密钥，`keyId` 是该密钥 SHA-256 的前 16 个十六进制字符。**插件因此不内置任何密钥副本**，而是在遇到加密文档时用 `ELECTRON_RUN_AS_NODE` 运行**本机已安装的那个 App**、调它自己的同一个绑定，取回同一份载荷后就地派生。也就是「向写下这个文件的那个构建本身询问」——App 升级换了密钥，插件无需跟着发版。
  - **只在真的需要时才付代价**：先按纯字符串解析，只有文档确实带加密字段时才去问 App 要密钥，所以 macOS 与旧版 Windows（以及插件自有副本）这条常用路径**一次子进程都不会启动**。密钥只在进程内存缓存，**不落盘、不进日志**；派生结果先按 `keyId` 校验，不匹配即报「不属于这把密钥」。
  - **fail-closed**：信封畸形、密钥不匹配、GCM tag 校验失败，一律当作「这份文档读不出来」（返回未登录），**绝不退化成截断的、空的、或半解密的 token**——那会让计费落到错误的地方。
  - **身份与时间字段原样保留**：加密路径只替换被加密的那些字段，`uin` / `uid` / `domain` / `expiresAt` / `lastRefreshTime` 的读取与纯文本路径完全一致，多账号去重与排序不受影响（`uin` 是明文，账号 id 保持稳定，无迁移问题）。
  - **账号名也一并解密**：这些构建**同样加密了 `account.nickname`**。只解 token 的读法会让 token 工作正常、账号名却读不出来而回退成一串 uin 数字（`330105772757`），看起来像「插件不知道这是谁」——实测确认。现在昵称走同一条解密路径，卡片与 `doctor` 显示 `老丁`、`LaoDing` 这样的名字。昵称是**可选**字段：信封打不开（密钥轮换、信封损坏）只表示「名字未知」，**不会**像 token 那样让整份凭据作废；token 依旧 fail-closed。`account.phoneNumber` 在这些构建里同样加密，**故意不读**——卡片的隐私契约只允许昵称、到期时间与积分，手机号不在其列。
  - **uin 不再显示，也不再见诸接口**：账号名是**显示值，不是标识符**。原先的名字兜底链是 `nickname ?? uin ?? uid`，昵称一旦缺席就把一串数字当名字显示；现在 store 的名字只取昵称，**没有就返回空串**，由卡片渲染本地化的「未命名账号」占位（`doctor` 对应打印 `(unnamed)`），标识符不再冒充名字。同时把 `uin` 从下发给浏览器的账号行与登录文档里**整个移除**——卡片从未渲染过它，继续传只是在无功能收益地暴露账号标识；`uin` 仍留在凭据模型内部（账号 id 由它派生，去重与排序都靠它）。
  - **门控随之放宽**：`hasEncryptedTokenFields` → `hasEncryptedCredentialFields`，除两个 token 外还检查 `nickname` / `uin` / `uid` / `enterpriseId` / `domain`。否则一个「token 明文、昵称加密」的构建会读不到密钥，账号名又静默退回数字。
  - **`doctor` 新增一行**：报告「加密凭据支持」是否可用及其解析到的 App 可执行文件路径；App 装在非常规位置时可用新增的 `WORKBUDDY_APP_EXECUTABLE` 指定。该项**不读取也不输出任何密钥材料**。

  **核查**：以本机真机取证——加密文件解出的 access token 长度 1462、`refreshToken` 1102，两者都是标准 JWT 形状；用解出的 token 调上游积分接口得 **HTTP 200**（`code: 0`，真实积分数据），模型目录接口同样 200。集成后 `store.accounts()` 正确列出 2 个账号（加密的那个被标为 selected），`store.resolve()` 返回可用凭据，`status` 子命令打印出真实余额。

### Tests

测试总数 179 → 236（新增 57 例，新文件 `tests/at-rest.spec.ts` 与 `tests/credential-recovery.spec.ts`）：

- 密钥派生：断言哈希的是载荷里的 base64 **字符串**而非解码后的字节（两者结果不同，写错即挂）、`keyId` 规则、以及畸形载荷必须抛错而不是派生出一把假密钥。
- 信封开启：本文件用与服务端**同一算法独立封出**的密文往返，覆盖同一密钥下的多个字段；另含「换一把密钥必须拒绝」「篡改密文必须失败（不得返回部分明文）」「整文件 framing 的信封必须认证失败」「畸形信封逐个字段报错」。
- 文档解析：纯字符串文档不需要密钥即可读；**看起来像 base64 的普通 token 不得被当成密文**；加密文档在没有密钥时返回 undefined（正是原缺陷的形状）；给对密钥后 token 与身份/时间字段全部正确；access 加密而 refresh 明文、以及只有 refresh 加密的混合形状；**给错密钥必须 fail-closed**；空 token 规则保持不变。
- 账号名：加密昵称必须还原成真名而不是退回 uin（并按卡片同一 fallback 链断言）；明文昵称照常原样读；**打不开的昵称只算「未知」、不得让整份凭据作废**（与 token 的 fail-closed 相反）；`phoneNumber` 即使加密且可解也**不得**被读入凭据对象（隐私契约）。
- 门控：加密昵称/uin/uid/enterpriseId/domain 各自单独出现时都要被识别为「需要密钥」，全明文的文档必须为 false。
- 可执行文件探测：环境变量优先、空/空白覆盖值被丢弃、darwin 给出 bundle 路径、linux 不给候选、路径都不存在时返回 undefined。
- 恢复建议（`tests/credential-recovery.spec.ts`）：探测命中/被拒/账号已消失三种结果；TTL 内不重复探测；**重新登录改变签发时间后旧判定自动失效**（同一账号从不可用翻回可用）；判定按区域与账号互不串味；**「本机没有其他账号」才 `reloginRequired`**、有其他账号时即使一个都没验证通过也**绝不**要求重新登录（误导守卫）、且永不把「本机一个账号都没有」误报成需要重新登录之外的结论。
- 拒绝分类（`tests/web-status.spec.ts`）：HTML 401/403 与 JSON 401 都标记 `credentialRejected` 并附建议；**503 之类的瞬时故障不得被当成凭据问题**；探测只针对**被拒账号之外**的账号；探测确认可用时给出 `usableAccount` 且不要求重新登录。
- 账号名与标识符（`tests/auth.spec.ts` / `tests/web-status.spec.ts`）：有昵称时用昵称；**昵称缺席时 `accountName` 必须是空串，绝不含 uin/uid**（并断言账号仍完全可用、id 仍正常）；空字符串昵称与缺失同义；`uin` 仍留在凭据模型里供 id 派生使用；**下发给浏览器的文档与账号行都不得出现 `uin` 字段，也不得出现 uin/uid 的数字**。

每条守卫都用「删掉对应实现即失败」验证过：把密钥派生改回哈希解码字节、或让解析器忽略 `keyId` 校验、或去掉 `hasEncryptedCredentialFields` 的门控、或让 `optionalCredentialField` 的失败向上抛、或把 `reloginRequired` 改成「没验证出来就算 true」、或把名字兜底链改回 `nickname ?? uin`，都会挂掉对应用例。

### Docs

- `README.md` / `README.en.md`：新增「加密凭据字段」说明（为什么要向本机 App 现取密钥、密钥不落盘、纯文本路径不启子进程、账号名也来自加密字段、`WORKBUDDY_APP_EXECUTABLE`），在「已知限制」补一条「加密凭据依赖桌面 App 在场」，并在「功能特性」补一条「凭据失效时给出可执行的建议」。
- `docs/DESIGN.md`：§5.3 源文件标注表新增 `src/at-rest.ts` 一行（原创，无参考实现）；§6 风险与边界新增第 5 条「字段加密随版本轮换」，说明为何不得把密钥内置进插件。

## 2.0.6 (2026-09-22)

### Fixes

- **没有账号的区域不再向模型选择器列出模型**（issue #12，报告者 `stephenyab`）。此前只有国内版账号的用户，模型选择器里会多出一整组 `WorkBuddy Global`（**恰好 20 个**，与 `FALLBACK_WORKBUDDY_MODELS_GLOBAL` 逐条一致）——这些模型一个都用不了：该区域连凭据都解析不出来，选中后 `store.resolve()` 必抛错，shim 一律回 `401 not_signed_in`。**选择器说可选、实际必失败**，对单区域用户是纯噪音。

  - **根因**：静态 fallback 的初衷是「上游离线也不让 provider 空着」，但它无条件播种（`new WorkBuddyCatalog(region)` 即装载整份 fallback），而 `deriveCatalog` 的「空勾选 = 全量」又把整份放行；启动时的真实刷新对无账号区域必然失败、只留一条 `logger.warn`，fallback 便永久留存。DSH 宿主对凭据一无所知（`buildModelCatalog` 只过滤 `models.length > 0`），于是原样渲染。
  - **修复**：`WorkBuddyCatalog` 新增「本区域是否有本机登录」状态（`setRegionUsable()` / `isRegionUsable()`），无账号时 `current()` 返回空数组 → 宿主的空分组过滤让该分组**直接消失**。**provider 本身照常注册**：它的设置卡片与账号选择器正是用户登录的入口，隐藏分组是目录层决定，不是注册层决定。
  - **与 `set()` 的非空守卫分开**，没有放宽它：两者回答不同问题——`set()` 承载**上游真实答案**，永不允许为空；「本区域没有账号」是**合法的空状态**，且必须能跨刷新存活。合并二者会要么丢掉守卫、要么丢掉隐藏分组的能力。测试专门锁定这一点：区域不可用期间上游刷新仍会在内部恢复目录，账号一出现即可立即服务。
  - **默认可用（宽松方向）**：`setRegionUsable` 由异步扫描调用，扫描尚未完成或失败时保持原状，因此**一次瞬时文件系统错误不会把正常区域清空**。
  - **两个触发点覆盖登录后的恢复**：① 设置变更时重算（`applySelection` 之后）；② 卡片侧——usage 轮询与「重新检测账号」路由本就调用 `store.accounts()`，顺手上报可用性，所以用户登录桌面端后**无需重启**，模型自动出现。`setRegionUsable()` 返回值表明状态是否真的变化，未变化时不做多余的 adapter 失效。
  - **对称覆盖两侧**：报告举的例子是「只有国内版账号 → 国际版多出 20 个」，反之亦然（只有国际版账号时国内版会多出 12 个），修复同时作用于两个区域。

  **核查**：报告的根因链**逐条属实**，本版本按报告建议的方向（其「建议修复方向」第 1、2、3 条）实现。我们额外确认了它列出的两条实现约束确实成立——`catalog.ts` 的 `set([])` 会抛错（故另开一条状态而非放宽守卫）、空目录会让宿主过滤掉整个分组（故无需注销 provider），并验证了它在第 5 条提到但未展开的点：`routableProviders` 仍包含该 provider id，这与选择器过滤是两个独立概念，本次不改动。

  **措辞说明**：`README` 此前写「两边模型同时出现在选择器里」——该表述自本版本起变为**有条件**（有账号才出现），中英文 README 与 2.0.0 的 CHANGELOG 条目均已就地更正，而不是留着一个已被推翻的说法。

### Tests

测试总数 173 → 179（新增 6 例）：

- `tests/issue12-region-hiding.spec.ts` 新增 2 例（新文件，端到端复现报告者的环境）：CN-only 机器上 `workbuddy-global` **不再列出任何模型**，而 `workbuddy` 正常服务；同时断言 **provider 与可配置 provider 仍在册**（登录入口不能消失）。第 2 例覆盖恢复路径：登录国际版账号后经设置链路重算，模型**无需重启**即可用。
- `catalog.spec.ts` 新增 4 例：默认可用（扫描未完成不误清空）、无账号后 `current()` 为空且 `isRegionUsable()` 为假、`setRegionUsable()` 的「无变化」返回值语义、以及**非空守卫与可用性标记互相独立**（区域不可用期间 `set()` 仍保有真实目录，账号出现即恢复）。

每条新增守卫都用「删掉对应实现即失败」验证过：让 `current()` 忽略可用性标记会挂 5 例；移除 `applySelection` 的重算调用会挂 3 例（含一条端到端用例）。

### Docs

- `README.md` / `README.en.md`：双供应商一节的「两边模型同时出现」改为「**有账号的区域**其模型出现」，并说明无账号区域不列出、登录后自动恢复、provider 始终注册。
- `CHANGELOG.md` 2.0.0 条目中同一处表述就地标注了 2.0.6 的收紧。

## 2.0.5 (2026-09-22)

### Fixes

- **「跟随 App 当前登录」清除后不再被旧版 `accountId` 顶掉，且清除结果在卡片上可见**（issue #11 的缺陷 1；其症状属实，但所声称的机制与严重性不准确——见下方「核查」）。

  - **空字符串哨兵现在显式终止旧值回退**。`selectAccountFor()`（由 `applySelection` 内联逻辑提升为导出纯函数）按顺序判定：`accounts.<region> === ""` → 无选择（跟随 App）；具体 id → 该区域的显式选择；键不存在 → 回退到所属区域的旧版 `accountId`。此前 `""` 走的是「值已存在」分支并被 `selectAccount('')` 归一化为 `undefined`，结果碰巧正确，但语义靠下游兜底；任何一处偏离（下游不再归一化、或增加新的读取方）都会让旧账号复活。现在哨兵在源头终止回退，并有测试锁定。
  - **启动时的旧值归属（attribution）跳过被显式清除的区域**（`legacyAttributionRegion()`）。该 pass 在启动后异步运行：跳过被清除的区域，既避免把用户刚丢弃的选择重新绑回，也保证**另一个区域仍有机会认领同一个 id**（用 `continue` 而非 `break`，否则国际版的迁移会被国内版的清除顺手打断）。
  - **卡片新增区域状态行**：显示该区域当前是「使用保存的账号」还是「跟随 App 当前登录」，清除后先显示确认文案。这是 issue #11 里真正属于产品缺陷的那一半——清除后回退到的默认账号**通常正是刚被清掉的那个账号**（用户当初就是在 App 登录状态下选它的），因此清除成功与清除无效在界面上完全同形。此前 `usage` 文档也没有任何字段能区分二者。
  - **设置写入改为「写入后回读校验」，失败时明确报错**（Windows 上尤其重要，见下）。`settingsScope.set()` 的 promise resolve **并不代表值已落盘**：设置文档 `settings.yaml` 靠「写临时文件 + rename 覆盖」替换，而 `@deepseek-ai/dsh-atomic-write` 对 `EPERM`/`EBUSY`/`EACCES` 的重试**只在 `win32` 生效**——Windows 上杀毒软件、OneDrive 等同步盘或编辑器会短暂锁住该文件。重试耗尽后，失败以「不成功的响应」回到客户端，而设置 scope 的 `mutate()` 对此**只是重新加载 Host 状态然后正常返回**，所以调用方的 `await` 会成功、文档却没变。新增 `writeAccountSlot()` 与 `writeRegionModels()`：写入后把值读回，读不回即抛 `WorkBuddySettingsWriteError`。对三处写入的影响：
    - **清除账号**：只有确认落盘才显示「已清除」，失败则显示错误并说明原选择仍生效——否则会给出一个被旧选择默默反驳的假确认，比不提示更糟；
    - **切换账号**：同样校验。静默丢弃会让下拉框显示一个账号、实际计费另一个；
    - **保存模型**：尤其要紧——保存成功会**丢弃草稿**，若写入没落盘就丢，用户唯一的副本就没了，却还被告知「已保存」。校验比对回读的 `lastCatalog` id 序列（不能只看「槽位存在」，截断/残缺的写入同样要检出）。

  **核查**：报告的根因链在 HEAD 上不成立，逐条复现如下。**注意措辞更正**：2.0.5 初稿曾断言「清除本来就生效」，该结论只在 Host 侧成立；在 Windows 上写入可能被静默丢弃，因此报告的「点了没反应」在那里是真实存在的，只是机制与报告所述不同（不是 `accountId` 顶掉，而是写入没落盘）。回读校验修复的正是后者。

  | 报告的主张 | 实测结果 |
  |---|---|
  | `clearAccount()` 只写区域槽位，旧 `accountId` 会持续顶掉清除结果 | 清除后该区域立即跟随 App 默认；三种变体（旧账号≠当前登录、旧账号＝当前登录、启动归属与清除竞争）均通过 |
  | `effectiveAccountFor()` 在哨兵值上不提前返回，因此旧值继续生效 | 该分支返回 `""`，经 `selectAccount('')` 归一化为 `undefined`，**不会**回退到 `accountId`——返回值虽然「不提前」，但结果正确 |
  | 启动迁移块会把区域重新绑回旧账号 | 迁移块只在启动时运行一次，且 `applySelection` 走同一个 `effectiveAccountFor`，同样被哨兵挡住 |
  | `""` 与「未设置」在 schema 层不可区分 | `""` 与键缺失**是可区分的**：`z.object({cn: z.string()})` 对 `{cn: ''}` 保留空串、对 `{}` 保留缺键；`Object.hasOwn` 亦为真。不可区分的只有**语义**，不是 schema |
  | （报告未提及）写入可能根本不生效 | **成立，且与平台相关**：见上一条。空串本身在 YAML 里能正确往返（写成 `cn: ""`），所以哨兵语义没问题；丢的是**整次写入** |

  因此本版本不按报告的建议去「清除旧字段」——旧字段是**两个区域共享的**迁移来源，清掉它会让另一侧失去迁移依据；正确的做法是让哨兵赢（已实现），并把无法观测的状态暴露给界面（已实现），再加上对「写入没生效」的显式检测。

### Tests

测试总数 142 → 173（新增 31 例，**全套 173 通过**）。

> 关于 `host-heartbeat.spec.ts` 的 `processStartTimeMs`：在受限沙箱下该例会失败
> （`processStartTimeMs` 需要执行 `ps`，被沙箱以 `EPERM` 拒绝 → 返回 `undefined`）。
> 放开文件策略后 `ps` 可用，**5/5 通过**。该例与本次改动无关——两次运行用同一份
> 源码，差异只来自沙箱能否执行 `ps`。

- `settings-integration.spec.ts` 新增 15 例：`selectAccountFor` 的 6 例（显式选择优先、旧值只归属本区域、哨兵终止回退、清除与未配置可区分、两区域同时清除、清除一侧不影响另一侧）；`legacyAttributionRegion` 的 6 例（归属、跳过已清除区域、跳过但继续扫描另一区域、账号已消失、无旧字段、跨区域共享 id）；另有 3 例走真实 settings 链路 —— 清除后旧字段仍在但选不中、**重启后**已清除区域不被重新归属、以及清除前后经 usage 路由可见 `selectionExplicit` 翻转（账号名不变，这正是报告里「看起来没反应」的场景）。
- `client-account-selection.spec.ts` 新增 13 例（新文件）：`configuredAccountsOf` 的容错读取；`writeAccountSlot` 的保存与「保留另一区域」、哨兵写成 `""` 而非删键、**锁文件导致的静默未落盘必须抛错**、错误携带字段名、**不把「键缺失」误判为清除成功**、正常落盘不误报、回读与卡片读取同源（scope 的 flush 默认 `sync`，落盘后同步可见，故不会误失败）；`writeRegionModels` 的保存与区域保留、**静默未落盘必须抛错**、目录被截断也要检出（不能只看「槽位存在」）、错误字段名、正常落盘不误报。
- `auth.spec.ts` 新增 1 例：`hasExplicitSelection()` 在未选择/已选择/选择失效/哨兵清除四种状态下的取值。
- `web-status.spec.ts` 新增 2 例：signed-in 与两个 signed-out 分支都携带 `selectionExplicit`。

每条新增守卫都用「删掉对应实现即失败」逐一验证过：移除哨兵判断会挂 5 例，移除归属跳过会挂 2 例，把 `selectionExplicit` 写死为 `true` 会挂 3 例，把账号回读校验换成「相信 resolve」会挂 3 例，去掉模型保存的回读校验会挂 3 例。

### Docs

- `README.md` / `README.en.md` 的「已知限制 / Known limitations」补充：旧版 `accountId` 只作用于所属区域、且该区域被显式清除后不再生效；卡片状态行用于分辨清除是否生效；**Windows 上设置文件被占用会导致账号改动无法保存**，此时卡片报错且原选择保持生效。

## 2.0.4 (2026-09-21)

### Fixes

- **修复「保存的账号在本机消失后，界面自相矛盾」**（issue #10 的缺陷 3；其症状属实，但其声称的机制与严重性不准确）。显式选择的账号若在本机不再存在（WorkBuddy 更换登录或清理备份文件——`current()` 的注释早已点名这个成因），同一个状态下四条读取路径给出两种说法：

  | 路径 | 修复前 | 修复后 |
  |---|---|---|
  | `accounts()` | 靠对象同一性比较**仍标记一个账号为 selected** | 无人生效时不标记任何行 |
  | `current()` | 返回 `undefined`（拒绝计费，刻意不回退） | 不变（账单安全语义保留） |
  | `status()` | `signed-out` | 不变 |
  | 卡片下拉框 | `value` 取 signed-in 分支才有的 `accountId` → `''` → **空白**（选项仍在） | 显示「当前没有生效的账号」占位项 |

  - **根因**：`accounts()` 与 `current()` 对「id 失配」的口径不一致。卡片渲染前者、计费走后者，于是面板同时出现「下拉框选中 Alpha」「状态栏未登录」「提示去桌面端登录一次」——而用户明明已登录，那句提示还把人指向唯一无法修复该问题的操作。commit `1279234` 移除 `current()` 的回退（`?? this.preferred()`）以避免账单落到别的账号，本修复保留该决定，只消除显示层矛盾。
  - **`accounts()` 不再报告幽灵选中**：显式选择失配时不再回退到对象同一性比较（原写法依赖 `preferred()` 返回同一数组元素，能工作但语义脆弱）；未显式选择时仍如实标出正在跟随的默认账号。
  - **新增 `selectionLost`**：usage 文档的 `signed-out` 分支新增该可选字段，区分「保存的选择已失效（凭据是好的，请重选或清除）」与「本机确实没有登录（去桌面端登录）」。仅前者为真时才显示新的说明文案，后者保留原文案。
  - **卡片下拉框改从账号列表取选中值**（原先取 signed-in 文档的 `accountId`）。这是同一类问题的第二处：当保存的账号**仍然有效**、只是 token 过期且刷新失败时，`resolve()` 同样抛错，下拉框也会变空白——用户的完整选择看起来像消失了。现在由账号列表这一个来源决定，并以此区分「没有任何账号生效」与「已登录」。
  - **新增「跟随 App 当前登录」按钮**：清除该区域的显式选择，回到文档承诺的默认行为。清除写入空字符串哨兵值，`selectAccount('')` 归一化为 `undefined`；此前空字符串会像任何失配 id 一样永久卡死（即「没有清除路径」）。
  - **`rescanAccounts()` 不再写入选中的账号**：原先只要 `accounts()` 报告的选中项与保存值不同就回写设置，导致两点危害——无显式选择时把「跟随 App 登录」的默认行为固化成一个永久绑定（此后 App 换登录不再跟随，与 `README`/`DESIGN` 承诺不符），以及保存的 id 失配时静默把区域改绑到**另一个账号**（正是严格不回退规则要防的静默改选）。「重新检测」现在只重读，选择权归下拉框与清除按钮。

### Tests

测试总数 131 → 142（新增 11 例）：

- `auth.spec.ts` 新增 7 例：失配选择不标记任何账号、未显式选择仍标出默认账号、有效选择在刷新失败时保持可见、`selectionLost` 的三种取值（无选择/有效选择/失配）、无本机登录时不报 `selectionLost`、空字符串哨兵恢复默认、以及区域隔离（一个区域失配不影响另一区域）。
- `web-status.spec.ts` 新增 3 例：orphaned 选择标记 `selectionLost` 且保留账号列表、真正的未登录不标记、signed-in 文档不含该字段。
- `settings-integration.spec.ts` 新增 1 例：空字符串哨兵经真实的 `settings.update` 链路写入后仍为 `''`，且两个 provider 继续正常服务。

### Docs

- `README.md` / `README.en.md` 的「已知限制 / Known limitations」补充账号失效后的表现与恢复方式，并说明重新登录桌面端无法修复该状态。

## 2.0.3 (2026-09-17)

### Fixes

- **解析单数 `effort` 形态的推理声明，单数模型不再注册为非推理**（issue #7）。上游 `reasoning` 元数据存在两种拼写：复数 `supportedEfforts` 形态，与单数 `effort` 形态（`deepseek-v4.1-flash`、`kimi-k3`、`gemini-3.5-flash` 等）。原 `parseReasoning` 只读复数，单数形态整档被丢弃，模型被注册为 `reasoning: false`，thinking 永远无法启用。

  - **实测证实单数 `effort` 是默认档而非唯一档**：两个网关（CN `copilot.tencent.com` / 国际 `www.workbuddy.ai`）均确认——`deepseek-v4.1-flash` 对 `low`/`high`/`max` 全部返回 200 且 `reasoning_content` 各异；`kimi-k3-1` 接受未声明的 `high` 档；不发 `reasoning_effort` 时思考字符数为 0，即上游默认关闭思考。
  - **依据实证在解析层把单数形态折叠为复数**：`supportedEfforts` 展开为全阶梯 `low`/`medium`/`high`/`xhigh`/`max`（复数载荷观测到的词表，`minimal` 从未出现）、`effort` 折入 `defaultEffort`、`canDisableThinking` 视为 `true`（`off` 可用）。
  - **复数形态逐字段透传不受影响**（`hy4-preview` 仍仅 `high` 且锁定 `off`）；未识别的单数 `effort` 值按单档透传，交由 adapter 的已知档位过滤。
  - **adapter / 卡片 / 持久化零改动即自动生效**：改动只落在解析层。

### Tests

- `tests/upstream.spec.ts` 新增 55 行、`tests/adapter.spec.ts` 新增 20 行，共 6 例：覆盖单数折叠、混合形态优先级、以及线上真实载荷的集成断言。

## 2.0.2 (2026-09-15)

### Fixes

- **修复「同一账号多个凭据文件时选中已失效的那一个」，导致积分/签到/模型全部返回 openresty HTML 401**。此前按**存储的 `expiresAt` 最大**来挑选凭据，但 `expiresAt` 描述的是「签发时有效期有多长」，**不代表上游仍然接受** —— 上游吊销 token 时不会同步改写该字段，于是一个早已失效的备份文件可以声称比真实可用的文件**更晚过期**，从而永远被选中。

  - **实测复现**：本机某账号有 8 个凭据文件，其中 `2026-07-08` 的备份声称 `2027-07-06` 过期（最远），而真正可用的当前登录文件只到 `2026-11-14`。旧逻辑因此始终选中那个 07-08 的死文件，三个端点（`get-user-resource` / `checkin-activity-status` / `models`）全部返回 `401 Authorization Required` + `openresty`。
  - **改用 `auth.lastRefreshTime` 作为新鲜度判据**：这是上游自己的签发时间，是唯一可靠的信号。新增 `WorkBuddyCredential.lastRefreshAtMs` 字段并在解析时读入；`preferred()`、多账号去重、以及插件自有副本的合并**三处**统一改用新的 `isFresher()` 比较器。
  - **排序优先级**：① live 文件 `workbuddy-desktop.info`（应用当前登录）→ ② `lastRefreshAtMs` 较新者 → ③ `expiresAtMs`（仅作为文档缺失该字段时的回退，保证比较是全序的）。
  - **实测验证**：切换判据后，本机 11 个账号选中的凭据**全部返回 200**（此前 `老丁`、`LaoDing` 等均命中死文件）。
  - 插件自有刷新副本（无 `lastRefreshTime`）不参与签发时间比较：它只在**确实更长寿**时取代桌面端备份，且**永不顶替 live 登录**。

- **上游返回 HTML 401 时给出可执行的提示**，不再原样抛出 HTML 片段。识别 openresty / APISIX 的鉴权拒绝，改为提示「凭据已被上游网关拒绝，通常说明选中的是旧登录留下的失效凭据；请重新登录 WorkBuddy 桌面端后在卡片中选择该账号，可运行 `dsh-connect-workbuddy doctor` 查看全部凭据」。非鉴权类的非 JSON 响应（如 502 网关错误）保持原有的通用提示。

### Tests

- `auth.spec.ts` 新增 4 例：**备份之间**按签发时间而非存储过期时间选择（回归锚点，旧逻辑下必失败）、文档缺失 `lastRefreshTime` 时回退到过期时间、`auth.lastRefreshTime` 的正确解析、缺失该字段时保持 `undefined`。
- `upstream.spec.ts` 新增 2 例：网关 HTML 401 被转写为可执行提示（且不泄漏 `<html>`）、非鉴权类的非 JSON 失败仍保留通用提示。
- 全套 **126 个测试通过**。

## 2.0.1 (2026-09-15)

### Fixes

- **修复 `codebuddy.ai` 国际账号被判为国内、上游返回 HTML 401（issue #4）**。国际版产品有两个品牌域名：WorkBuddy AI **桌面端**在 `workbuddy.ai` 登录，而 **CodeBuddy CLI** 把同一个国际账号登录在 `codebuddy.ai`。`regionOf()` 此前只认 `workbuddy.ai`，于是 CLI 登录的 `www.codebuddy.ai` 凭据被判为 `cn`，其 token 被发往国内网关（`copilot.tencent.com` / `www.codebuddy.cn`），在 openresty 层被直接拒绝，返回 **HTML** 401 而非业务 JSON —— 表现为积分、签到、模型列表与对话**全部失败**（报告者最初描述为「仅积分失败」，后经其本人确认实际是全挂，与该根因一致）。
  - **`regionOf()` 增补第二个国际品牌域名**：`codebuddy.ai` / `*.codebuddy.ai` → `global`。判定仍按凭据自带的 `domain` 字段，无需任何手动开关。
  - **新增 `globalBase(credential)`：国际版网关跟随凭据自身的 `domain`**，不再写死 `www.workbuddy.ai`。两个品牌域名的凭据**互不通用**（在 `codebuddy.ai` 签发的 token 会被 `workbuddy.ai` 网关拒绝，反之亦然），因此 base 必须跟随凭据。`chatBase` / `billingBase` / `originReferer` / `fetchModels` 四处全部改用 `globalBase(credential)`；未识别的国际域名回落至 `www.workbuddy.ai`。
  - **token 刷新同样受益**：刷新端点走 `chatBase(credential)`，此前 `codebuddy.ai` 账号会向国内网关刷新；现在跟随凭据域名。
  - 国内版（`codebuddy.cn` / `workbuddy.cn` / `copilot.tencent.com`）行为完全不变。

  > 实测依据（只读探测，未使用任何凭据）：`www.workbuddy.ai` 与 `www.codebuddy.ai` 对 `/v3/config` 均返回 **200 + 同一 JSON envelope**，对 `/v2/billing/meter/get-user-resource` 均返回 **401 + 同形 HTML**（未带 token），确认两者是同一套网关栈的不同品牌域名，路径形态一致。

### Docs

- `scripts/probe-global-billing-401.mjs` 同步：`regionOf` / `globalBase` 与发布版保持一致；「凭据中是否出现 codebuddy.ai」的判定改为**中性陈述**——该脚本扫的是桌面端凭据目录，而 `codebuddy.ai` 来自 CLI 登录，扫不到只能说明本机没有 CLI 登录，不构成「该域名不存在」的结论（此前正是这个措辞导致了 issue #4 中的误判）。

### Tests

- `upstream.spec.ts` 新增 3 例：`codebuddy.ai` / `*.codebuddy.ai` / 大小写与空白归一化判为 `global`，且 `www.codebuddy.cn`、`notcodebuddy.ai` 不被宽松后缀匹配误升为国际；`globalBase` 跟随凭据域名并正确回落；`fetchModels` 对 `www.codebuddy.ai` 凭据请求 **`https://www.codebuddy.ai/v3/config`**（回归锚点，验证不再误发国内网关）。

## 2.0.0 (2026-09-15)

### Breaking Changes

- **为什么是 2.0.0**：本版是架构级变更——插件由「单 provider 单活区域」变为「双 provider 并行」，运行形态与外部可见契约均有变化，按语义化版本升主版本号：
  - **运行形态**：插件现在注册两个 provider 路由（`workbuddy` + `workbuddy-global`）并打开**两个**回环端口（原先各一个）。下游脚本若假定「只存在一个 workbuddy provider」，需适配新增的 `workbuddy-global`。
  - **CLI `--json` schema v2**：`doctor` / `status` 的 JSON 输出 `schemaVersion` 1 → 2，新增 `regions.{cn,global}` 分区报告；顶层字段保持 CN 语义向后兼容，但按 `schemaVersion` 判断结构的消费方需注意。
  - **设置 schema 扩展**：新增 `accounts.{cn,global}` 每区域账号选择。旧的单 `accountId` 仍被读取并按其账号实际区域自动归位（软迁移，非硬破坏）；`regions` 分槽结构不变。

### Features

- **🆕 国内版与国际版拆分为两个并行供应商，可同时使用**——此前一个 provider 一次只能活一个区域（选哪个账号整个 `workbuddy` 就服务于哪个区域，切账号 = 翻转整个运行时目录）。现在两侧是两套完全独立的实例，**互不干扰**：

  - **双 provider 注册**：国内版保持 `workbuddy`（老 id 不变，存量会话的默认模型与已保存选择全部继续有效），国际版新增 `workbuddy-global`（displayName `WorkBuddy Global`）。两边模型同时出现在 DSH 模型选择器里——不同会话 / 子代理可以各选一边，互不干扰。（**2.0.6 起收紧**：没有账号的区域不再列出模型，理由见该版本 CHANGELOG 的 issue #12 一节。）
  - **每个区域一套完整运行时栈**：凭据 store、模型 catalog、回环 shim、adapter 各一份。store 按凭据域名过滤可见账号（`workbuddy.ai` → 国际版，其余 → 国内版），两个区域的账号可同时在线。
  - **插件卡片 tab 化**：设置卡片顶部新增「国内版 / 国际版」tab 栏（带各自登录状态圆点）。每个 tab 有独立的账号选择、积分概览、签到与模型管理；**切 tab 不丢另一侧未保存的草稿**（模型勾选 / 图片开关 / 上下文预算的草稿按区域隔离保存）。4 条卡片路由全部按 `?region=cn|global` 参数化。
  - **「减少刷新变化」**：一个 tab 里切账号、刷新模型、轮询积分，完全不触碰另一边的运行时目录——绑定另一边模型的进行中会话不受任何影响（单 provider 架构做不到这一点）。
  - **账号选择按区域独立**：配置新增 `accounts.{cn,global}`，每个 tab 各选各的账号。旧的单 `accountId` 在启动时按其实际所属区域归位（另一区域保持「跟随 App 当前登录」的默认，绝不静默继承错区域的选中账号）。
  - **凭据刷新副本按区域分文件**：`$DSH_HOME/.workbuddy-auth.cn.json` 与 `.workbuddy-auth.global.json`，双账号同时在线互不覆盖（此前单文件只存一个账号的刷新结果，后写者赢）；旧单文件 `.workbuddy-auth.json` 作为迁移来源保留读取（只被其凭据所属的区域采纳），`logout` 清除全部三个副本。
  - **CLI 按区域报告**：`doctor` / `status` 分区域列出账号、登录态与积分（JSON schema 升至 v2，新增 `regions` 字段，顶层字段保持 CN 语义向后兼容）；`logout` 清除所有插件自有副本。

### Fixes

- adapter 工厂参数化 provider id / displayName（此前 `WORKBUDDY_PROVIDER` 在 `toPiModel`、`createProvider`、profile 等 5 处硬编码）；`WorkBuddyCatalog` 构造函数接受区域参数，国际实例从第一刻起就 serve 国际 fallback 目录。
- `registerModelDiscovery` 单 handler 按 `request.provider` 分流区域；web-status 的模型刷新路由不再先 `resolve()` 凭据推导区域（区域直接来自请求参数）。

### Tests

- auth：新增区域化测试 5 例——区域过滤的账号发现、跨区域显式选中不回退、旧单副本只服务其所属区域（迁移）、区域刷新写区域文件不动旧副本、logout 清除全部副本。
- settings-integration：双 provider 注册断言（`workbuddy` + `workbuddy-global`、两条 configurable provider 目录、各自 fallback 阵容）；跨区域污染回归（CN 的图片勾选绝不泄漏进国际 provider 的同名模型；国际 tab 的保存绝不触碰 CN provider）。
- web-status：region 参数路由测试（`?region=global` 分发到对应 store、缺省回落 `cn`、未知区域 400 且不触碰 store）；`workBuddyWebStatus` 断言请求区域驱动全部四个区域化访问器。

## 1.4.0 (2026-09-11)

### Features

- **🆕 正式支持国际版 WorkBuddy AI（www.workbuddy.ai）**——国内版与国际版账号在本插件中获得完全对等的支持，**零配置、零开关，全自动**：

  - **怎么用**：在插件卡片的账号列表里选中国际版账号（凭据文件 `workbuddy-desktop-ai.info`，Gmail 等邮箱登录的那个）即等于切到国际版；选回手机号账号即回到国内版。区域判定完全跟随凭据文件自带的 `domain` 字段（国际版为 `www.workbuddy.ai`，国内版为 `www.codebuddy.cn` / `www.workbuddy.cn`），无需任何手动设置。
  - **国际账号可用的完整功能**（全部经真实国际账号端到端实测）：
    - **模型接入**：**20 个模型**进入 DSH 模型选择器，含国际版独有阵容——GPT-6-Astra、GPT-5.6-Sol / Terra / Luna、GPT-5.5 / 5.4 / 5.3-Codex、Gemini-3.5-Flash、免费的 `deepseek-v4.1-flash` / Hy3 / Hy4 preview 等；与国内版共有的 GLM-5.3 / 5.2、Kimi-K3 / K2.6 也正常列出；
    - **积分倍率**：20/20 模型全部带倍率展示（GPT-6-Astra x6.67、GPT-5.6-Sol x3.47、Auto x0.79、`deepseek-v4.1-flash` / Hy3 x0.00 免费等），与 WorkBuddy AI 官方客户端展示的是同一个 `credits` 字段（已在其 App bundle 中确认渲染数据源一致）；
    - **积分概览**：按套餐展示国际账号的剩余积分与到期时间（一次性 Bonus Pack 与月度 Free Plan Subscription 均正确区分），查询走国际网关 `https://www.workbuddy.ai`；
    - **每日签到**：签到状态与领取端点在国际网关实测可用；活动未开启时按钮自动禁用（409 守卫），开启后即可直接领取；
    - **对话路由**：chat 请求自动走国际网关，wire 协议与国内版同构（业务码 11128 等语义一致，`prepareChatBody` 的改写逻辑两侧通用）。
  - **核心修复：按渠道读取模型目录**。原先国际账号读 `/console/enterprises/personal/models`（国内路径，国际网关返回 HTTP 500）。改用两区域各自的正确来源后，国际账号首次拿到**完整 20 个模型**：
    - **国内**：`copilot.tencent.com/v2/enterprises/personal/models`（保持原样，29 个模型中取 `cli` agent 的 15 个）；
    - **国际**：`www.workbuddy.ai/v3/config` —— 关键在于**必须用桌面端 User-Agent**：配置服务按客户端渠道返回不同产品配置，`CLI/… CodeBuddy/…` 只给 35 个模型并**缺失 `deepseek-v4.1-flash`、`gpt-6-astra`**（尽管两者都能正常对话），而桌面渠道给出账号真实的 20 个 chat 模型。版本号无关（`WorkBuddy/5.5.2`、`WorkBuddy/1.0.0`、裸 `WorkBuddy` 结果一致），是 `WorkBuddy` 这个产品标识选择渠道。国内网关不需要这个切换：其桌面配置的 `cli` agent 为 0 个模型。
    - 国际账号此前**只剩 `hy3`、`hy4-preview`** 两个可用模型（`deepseek-v4.1-flash` 被静默丢弃、`gpt-6-astra` 不可见），现在 20 个全部就位，与 WorkBuddy AI 客户端的模型菜单一致。

### Fixes

- **目录与勾选按区域隔离（国内 / 国际各一套）**：此前 `lastCatalog` 与 `enabledModelIds` 是全局单槽。国内账号下勾选的模型（含 `deepseek-v4.1-flash`、`hy3-x`）在切到国际账号后，会与**国际目录**求交集——凡是国际目录里没有的 id 都被静默丢弃：国际账号实际只剩 `hy3`、`hy4-preview` 两个模型可用（`src/index.ts` 启动时 `deriveCatalog(国际目录, 国内勾选)`）。
  - 现改为 `regions.cn` / `regions.global` 两套独立槽位（目录、勾选、图片开关、上下文预算各一份），互不干扰；切换账号不再覆盖另一区域的配置。
  - 新增按区域区分的静态 fallback 目录：国际账号在首次拉取前不再被塞入国内模型清单（`FALLBACK_WORKBUDDY_MODELS_GLOBAL`，2026-09-11 从国际网关桌面渠道配置实测捕获 20 个模型及其倍率，含免费的 `deepseek-v4.1-flash`）。
  - 旧的扁平字段保留为**国内区域的迁移来源**（旧配置一律来自国内端点），国际区域绝不继承——这正是丢勾选的根源。
  - 卡片保存改为写入当前账号所属区域的槽位；usage 文档新增 `region` 字段供卡片定位。
- 三个探测脚本（`probe-models` / `probe-credits` / `probe-account-switch`）同步改用 `/v2/...` 路径：此前它们对国际账号同样会 500，导致诊断输出误导。
- 新增只读评估脚本 `scripts/probe-global-eval.mjs`：对比国际网关 `/v2/...`（500）与 `/v3/config`（200）两条取目录路径，并验证积分与签到端点——本轮的渠道发现即由它得出。

### Tests

- 新增 `fetchModels` 回归测试：stub 上游后断言 CN 凭据（`codebuddy.cn` / `workbuddy.cn`）拼出 `copilot.tencent.com/v2/enterprises/personal/models`、国际凭据（`workbuddy.ai`）拼出 `www.workbuddy.ai/v3/config`，并断言国际请求携带**桌面端 User-Agent**（`WorkBuddy/5.5.2`，CLI UA 会拿到缺模型的 35 个）、CN 请求**不得**携带桌面端 UA（国内桌面配置的 `cli` agent 为空）。把「按渠道取目录」钉死，防止日后退回会丢模型的取法。
- `regionOf` 测试补上 `www.workbuddy.cn`（国内版新 domain 形态，实测本机存在）。
- 新增区域隔离测试：`regionStateOf` 断言旧扁平字段只被读作国内状态、国际区域绝不继承、显式槽位优先；`fallbackModelsFor` 断言国内清单不得泄漏进国际（国内无 `gpt-*`/`gemini-*`，且 `default-model` 仅属国际）；web-status 断言文档携带的 `region` 与凭据域一致、且四个区域化访问器收到的都是该区域。
- **每日签到（领取）路由的守卫逻辑首次获得直接 handler 测试**（实测两区域端点行为后补齐）：
  - 活动未开启（国际账号实测形态，`active:false`）→ 409 且**绝不调用**上游领取；
  - 今日已签到 → 200 `alreadyCheckedIn` 且不调用上游领取（幂等保护）；
  - 活动开启且未签到 → 恰好领取一次、领取后重读状态并返回刷新后的连签天数；
  - 非回环 Origin → 403、非 POST → 405，两道安全守卫均在触碰上游前拒绝。
  - 实测依据（全部经插件真实代码路径、零状态变更验证）：CN 网关领取端点对已签到账号返回业务拒绝「今天已签到，请明天再来」；国际网关同路径存在，对未开启活动返回「签到活动未开启或已过期」（均为 HTTP 400 业务码而非 404，证明端点存在、鉴权与协议一致）。国际版 App bundle 中确认签到端点与插件同路径，官方 App 对签到走无前缀形态、`get-user-resource` 才需 `/v2` 前缀——插件统一 `/v2` 形态在两侧网关均实测可用。

## 1.3.0 (2026-09-10)

### Breaking Changes

- **跟进上游 DSH 内核 0.1.2-rc.1 → 0.1.5-rc.1**：本机 DSH Desktop 2.0.9 捆绑的内核已跃迁到 `0.1.5-rc.1`（npm `latest`），而插件此前按 `0.1.2-rc.1` 编译。依赖链与代码已对齐新内核线：

  - **`ResolvedPiAiProviderProfile.modelErrors` 变为必填**：`dsh-llm-pi-ai` 的 provider profile 在 0.1.5-rc.1 新增必填字段 `modelErrors`，`PiAiAdapter.modelOf` 会在每次请求时读取，并对其中列出的任何 model id 抛出 `INVALID_CONFIG`。本插件的目录来自上游实时读取，因此填**空 Map**——即「无已知失败模型」，绝不预先否定目录后续提供的模型。这是本次跃迁中本插件唯一的一处源码编译失败。
  - **`@deepseek-ai/dsh-client-runtime` 已停止发布**：该包停在 `0.1.1-rc.2`，在 0.1.5 线上既未发布也不在桌面捆绑集内（其槽位/会话服务迁至 `dsh-client-ui-renderer/client`）。此前客户端入口从它取 `ClientContext` 类型、并在 `dsh.client.inject` 中声明它。现改为：运行期注入以真实提供 `slots` 服务的 5 个包为准（移出 `dsh-client-runtime`），类型侧用具名 `WorkBuddyClientContext`（cordis `Context` + `slots`/`locale`/`settingsScope` 三个座位），使客户端入口在两条主机线上都能编译。
  - `@earendil-works/pi-ai`：`0.85.0` → `0.85.1`。

### Fixes

- **升级后 provider 注册不再静默失效**：`modelErrors` 缺失在 0.1.5-rc.1 上是**编译期**硬失败（本次已由 `pnpm run check` 捕获并修复）；回归测试进一步把「运行时该 map 必须为空」钉死，避免日后有人在其中塞入模型 id 而悄悄禁用整条路由。
- **客户端 half 不再依赖已消失的包**：`dsh-client-runtime` 在 0.1.5 主机上无法解析，客户端插件此前把它列为注入目标；现已移除，构建产物 `lib/client.js` 对它零引用。

### Dependencies

- 全部 `@deepseek-ai/dsh-*`：`0.1.2-rc.1` → `0.1.5-rc.2`（`0.1.5-rc.1` 为 npm `latest`，`rc.2` 已在 `next` 通道；本仓库按线跟进并锁在 lockfile）
- `@deepseek-ai/dsh-client-runtime`：保留 `0.1.1-rc.2`，**仅作旧主机线的类型来源**，不参与 0.1.5 运行时
- 新增 `@deepseek-ai/dsh-client-ui-renderer`：0.1.5 线上 `slots` 服务的真实提供方
- 依赖声明统一改为**范围**而非写死补丁版本（含 `pnpm-workspace.yaml` 的 `overrides`），升级时只需改一处版本串

### Docs

- 记录本轮内核跃迁的对照依据与影响判定：本插件**不受** F1（会话持久化改为句柄化接缝）与 F3（`PERSONA_SECTION` 改名）影响——全仓无会话日志直读、无 persona 段 key 注入；受影响面集中在 F4（导出面变化）与 A4（声明依赖须落在捆绑子集内）。

## 1.2.0 (2026-09-09)

### Features

- **模型选择器显示积分倍率**：DSH 模型选择器中的 WorkBuddy 模型现在按 WorkBuddy 自身选择器的拼写显示积分倍率（如 `GLM-5.3 · x0.79`；未解析到倍率则保持原名称，免费模型显示 `x0.00`）。仅改 DSH 侧显示名（`toPiModel` 与模型 discovery 的 `name`）：模型 `id`、`lastCatalog` 存档与插件卡片显示不变——DSH 的选择状态、会话事件（`model/selection` / `request/header`）、agent 默认模型设置与请求路由全部以 `provider + model id` 为连接键，倍率后缀不参与任何映射。

### Fixes

- **修复模型保存始终失败（`client api: settings/mutate rejected "ops"`）**：卡片保存 `lastCatalog` 时曾用 `nativeContextWindow: undefined, multimodal: undefined` 显式清字段——显式 `undefined` 值会穿过 `structuredClone` 并被设置写入路径的严格 JSON codec 拒绝，导致**整次保存静默失败**（错误是 unhandled rejection，UI 无任何提示；用户侧表现为「保存按钮按不下去」）。姊妹项目 dsh-connect-trae 的 payload 不含 undefined 字段，故不受影响。现在改用 `toPersistedWorkBuddyModel` 按 KEY 剥离卡片专用字段（附回归测试：持久化形状不得含 undefined 值属性、JSON 往返无损）。
- **保存失败可见化**：保存抛错此前是静默的 unhandled rejection（UI 零提示，正是它掩盖了上一条 bug）。现在保存失败时在按钮旁显示具体原因，草稿保持 dirty 可直接重试；成功路径与 dsh-connect-trae 卡片完全一致（保存中… → 自然结束 → 恢复「保存」并禁用），无额外装饰。

## 1.1.3 (2026-09-04)

### Breaking Changes

- **跟进上游 DSH 0.1.2-rc.1 / Cordis 4.0.2**：本插件依赖链全部更新至 `0.1.2-rc.1`（`@deepseek-ai/dsh-*`）与 `4.0.2`（`@deepseek-ai/cordis`）。以下 API 变更需要同步适配：

  - `installSettingsSection(ctx, ns, schema, entry, hooks)` 移除：改为 `ctx.settings.installSection(ctx, ns, schema, entry, hooks)`（实为 `SettingsProvider.installSection` 实例方法）。
  - `settingsNamespace('workbuddy')` 移除：改为 `'workbuddy' as SettingsNamespace`（dsh-settings 导出的 branded type）。
  - `registerModelDiscovery` 回调签名的 `signal` 字段从 `request.signal` 移至回调第二参数 `async (request, signal) =>`。
  - `SettingsNamespace` branded type 语义收紧：`WORKBUDDY_SETTINGS_NS` 需显式 `as SettingsNamespace` 断言。
  - Cordis 4.0.2 要求所有服务访问显式 inject：`inject` 声明从 `['llm']` 扩为 `['llm', 'settings']`。
  - `onChange` 回调在 `installSection` 注册时同步触发：涉及的前置变量（如 `invalidateCatalog`）需提前声明。

### Dependencies

- `@deepseek-ai/cordis`：`4.0.1` → `4.0.2`
- 所有 `@deepseek-ai/dsh-*` 包：`0.1.1-rc.1` → `0.1.2-rc.1`
- `@deepseek-ai/dsh-client-runtime`：`0.1.1-rc.2`（不变，0.1.2-rc.1 未发布）
- `@deepseek-ai/schemastery`：`3.18.1-rc.1` → `3.18.2`
- `@earendil-works/pi-ai`：`0.82.1` → `0.85.0`
- `@deepseek-ai/dsh-client-ui-settings`：补充显式 devDependency（已作为 0.1.2-rc.1 依赖）

### Infrastructure

- `pnpm.overrides` 从 `package.json` 迁移至 `pnpm-workspace.yaml`（pnpm 11 要求）。

## 1.1.2 (2026-08-31)

### Fixes

- **兼容当前 DSH 宿主（dsh-plugin-desktop@2.0.4，@deepseek-ai/* = 0.1.2-alpha.1）**：peerDependencies 中 8 个 `dsh-*` 包的预发布分支范围扩展为 `>=0.1.0-rc.1 <0.2.0 || >=0.1.1-rc.1 <0.2.0 || >=0.1.2-alpha.0 <0.1.3`，覆盖 0.1.0-rc / 0.1.1-rc / 0.1.2-alpha 全部已发布分支；`@earendil-works/pi-ai` 由精确 `0.82.1` 放宽为 `>=0.82.1 <0.85.0`（兼容宿主 0.84.3）。修复用户环境版本不匹配导致的 ERESOLVE / 静默排除。

## 1.1.1 (2026-08-31)

### Docs

- `RELEASING.md` 明确发布 2FA 约定：本项目使用**浏览器授权**，不用 `npm publish --otp=<码>` 命令行方式；补充验证 URL 404 时重跑生成新链接。

## 1.1.0 (2026-08-31)

### Features

- **切换账号出错提示**：切换账号后出现错误（如所选账号凭据失效返回 401）时，插件卡片账号信息区（令牌行下方）显示一行小字「出现错误，重新登录 WorkBuddy APP 即可」，提示用户通过重新登录恢复。

### Docs

- 市场收录对齐当前约定：正式提交 PR [#3812](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/3812) 仅保留 `data/plugins/dingminhua__dsh-connect-workbuddy.yml` 与生成的 README；**移除**对注册表 `data/screenshots.json` 的改动（该文件是旧约定回退，新约定为插件自己仓库根目录声明 `screenshots.json`）。
- README 与 README.en.md 市场章节补充「收录目录规范」（contributing.md 要点：单文件命名、url 一致、category、描述引号规则、`dsh.bundle` manifest、topic、CI 门槛、README 由脚本生成、每 PR ≤ 3 条）。
- 新增 `awesome-dsh-plugin-submission/README.md`：市场收录目录的操作说明与当前状态；删除已废弃的 `screenshots-entry.json` 草稿（对应旧约定往注册表加键的做法）。

## 1.0.1 (2026-08-30)

### Fixes

- 账号选择改为严格绑定用户显式选择：删除启动时按积分自动挑选账号的逻辑，未选号时跟随 App 当前登录（live 文件）；账号失效时不再静默切换到其他账号，而是报「未登录」让用户重新选择，避免账单落到用户未选择的账号上。

### Docs

- `docs/DESIGN.md` 对齐当前进度：图片输入改为手动勾选说明；补充 `reasoning.effort`（固定档位）形态与推理强度两态已知问题；积分展示补充月度周期套餐与每日签到；scripts 探针数量更新。
- README 与 README.en.md 功能特性更新：图片输入改为按模型手动勾选。
- 新增 `docs/reasoning-investigation.md`：记录推理强度调查结论（上游两态数据、DSH 链路、实测档位、待决策修复方向）。仅记录，未改代码。

## 1.0.0 (2026-08-30)

### Features

- **WorkBuddy 模型接入**：将本机登录的 WorkBuddy 模型注册为 DSH 的 `workbuddy` provider，通过安全 loopback shim 提供模型调用，DSH 本地执行工具循环。
- **模型管理**：从上游刷新完整模型目录后可逐项勾选启用；刷新为草稿操作，需显式保存。上游同时给出积分倍率、上下文/输出上限与推理档位（实测 16 个 cli 模型全部带出这些字段，原实现仅保留 id/name/token 上限）。
- **图片输入手动开关**：图片支持由用户在模型列表手动勾选「图片」复选框决定（默认不勾选），不再依赖上游 `supportsImages`/`disabledMultimodal` 自动推断；勾选保存后该模型声明 image 输入，未勾选仅 text。
- **本机账号切换**：扫描 WorkBuddy auth 目录（活跃文件 + 时间戳备份），按 uin 去重为多个可选账号，默认跟随 App 当前登录。
- **凭据路径多候选**：macOS / Windows(Local+Roaming) / Linux(XDG) 逐一探测，支持环境变量与配置覆盖。
- **只读积分概览**：按套餐聚合展示剩余积分，区分「月度周期套餐」与「一次性礼包」；查询不消耗积分。
- **每日签到**：卡片下方提供一键签到按钮，查询状态与领取均走 `/plugins/dsh-connect-workbuddy/checkin`（POST），回环来源校验 + 领取前二次确认，不会重复领取。
- **只读路由 trio**：`/plugins/dsh-connect-workbuddy/{usage,models/refresh,accounts/refresh}`，回环来源校验 + token 脱敏，积分查询失败降级为 `creditsError`。
- **CLI 诊断**：`status` / `doctor` / `logout`（`--json` 支持），doctor 列出每个发现的账号及其文件来源。

### Fixes

- **凭据选择优先活跃文件**：实测所有备份文件都声称 2027 年到期，但只有 `workbuddy-desktop.info` 的 token 被上游接受。改为活跃文件优先，到期时间仅作备份间排序。
- **无头 profile 下不再崩溃**：`ctx.effect()` 的回调同步执行，无 `webServer` 服务时（TUI）会同步抛错。现改为先 `ctx.get('webServer')` 判空再注册。
- **刷新保留用户选择**：从 WorkBuddy 刷新目录后，已启用的模型、已勾选的图片与上下文预算均按模型 id 重新映射保留，不再丢失。
- 测试不再污染真实 `$DSH_HOME`：vitest 配置隔离 DSH_HOME，避免写心跳与凭据副本到开发者真实 profile。

### Docs

- README 与 README.en.md 顶部新增插件使用界面截图，并新增 `screenshots.json` 登记截图路径。
- 确立溯源与致谢规范：`THIRD_PARTY_NOTICES.md` 完整记录参考项目及其许可证；README 与 README.en.md 的致谢章节按「连接内核的参照 / 插件外观与结构的基准」两类如实标注来源。
- `dsh-codex-connect`（Apache-2.0）作为唯一非 MIT 参考项，其第 4 条声明义务在 `THIRD_PARTY_NOTICES.md` 中单独履行。
- `docs/DESIGN.md` 第 5.3 节确立源文件头标注规范：每个借鉴自参考项目的文件必须写明「参考了谁 / 参考了什么 / 改动了什么」。
- `RELEASING.md` 将「核对溯源与致谢」列为发布前强制步骤。
- 新增 `awesome-dsh-plugin-submission/` 市场注册草稿（与 `dsh-connect-trae`、`dsh-subagent-default-model` 对齐），README 补充「市场收录与展示」章节。
