# 渠道指纹：主流网关/中转/适配层的处理方式调研

日期：2026-10-23  
范围：本插件遇到的 WorkBuddy `11128` / `channel_reject` 类失败（网关按消息开头/正文内容识别非官方客户端），以及开源网关、中转站、适配层的公开做法。  
结论先说：**本插件的「失败后强制中性头 + 不可见扰动」不是主流做法；主流做法是主动伪装、零宽遮蔽、结构级指纹复刻，或坚持只识别、绝不伪造。** 但主流方案大多面向 Claude Code / ChatGPT 的官方订阅协议，WorkBuddy 这种只暴露一个 OpenAI 兼容端点、却在服务端扫描正文开头的网关没有完全对应的成熟开源方案。

## 1. 本插件现状（代码证据）

- 失败分类：[src/upstream.ts](../src/upstream.ts) 把 `"code":11128` 整族归为 `channel_reject`；三道门（unapproved channel / conversation id missing / first message is not system prompt）共用同一码。
- 已知指纹名单：`UNAPPROVED_CHANNEL_OPENINGS` 只有两条实测快照（DSH 系统提示、Claude Code 系统提示），且名单注释明确承认「不可能完整」。
- 扫描范围：`system` 与 `assistant` 消息的开头（含数组 content 的每个 text part）。
- 被动救援梯子（`src/shim.ts`）：
  1. `forceNeutralHead`：给所有被扫描消息开头强制加一行中性提示；
  2. `perturbChannelFingerprints`：在句界/逗号/大写词对之间插入 U+200B；
  3. 只有第三次仍失败才回错误，并把原始宿主请求里的开头回显给用户（`channelEvidenceText`）。
- 已有旁路路线：`src/cli-bridge/runner.ts` 承认「真客户端进程」路线可以彻底摆脱客户端指纹军备竞赛。

## 2. 网关侧的现实做法（含反向证据）

WorkBuddy 的行为与公开的网关设计一致：

- 按请求内容前缀/精确子串识别已知 agent 提示词；
- 按消息角色扫描（`system`/`assistant`，不扫 `user`）；
- 错误文案统一伪装成「渠道校验 / 不是官方客户端」，但真正判据是请求内容；
- 列表可随时扩充，客户端无法预测。

开源路由器也在做同类识别，只是目的不同：BitRouter 曾用 Claude Code 的 system prompt 前缀做「真 Claude Code 流量」检测，后来因官方提示词文本改变而失效，改为识别 `anthropic-beta: claude-code-…` 协议标记（[BitRouter PR #594](https://github.com/bitrouter/bitrouter/pull/594)）。这说明：**提示词开头是最脆弱的协议信号，头部/结构级信号更稳定。**

## 3. 主流开源反代/适配层的处理谱系

### A. 真客户端进程路线（最强，但不通用）

做法：不伪装协议，而是让真正符合官方客户端身份的 CLI 进程发出请求。

代表：本插件 `cli-bridge`（CodeBuddy CLI）路线。

优点：

- 不需要维护提示词指纹名单；
- 不需要零宽字符或结构伪装；
- 官方订阅端点天然接受自己客户端的系统块。

缺点：

- 依赖宿主生态提供可嵌入的官方 CLI；
- 每个回合有进程启动、工具权限、上下文续接成本；
- 不解决所有 OpenAI 兼容网关场景。

### B. 内容遮蔽 / 零宽扰动（与本插件最接近）

代表：CLIProxyAPI Claude Cloak（[PR #868](https://github.com/router-for-me/CLIProxyAPI/pull/868)）和 AIRoute（[STEALTH_GUIDE.md](https://github.com/jaccen/AIRoute/blob/main/docs/security/STEALTH_GUIDE.md)）。

共同点：

- 可配置敏感词表；
- 在首字符后或句界插入 U+200B / U+200D；
- 作用范围包括 system 块、messages content、tools description；
- 目的是让精确字符串过滤器失配，同时让模型几乎读不出差异。

差异：

- CLIProxyAPI 的默认是「命中词表才遮蔽」；
- AIRoute 默认在敏感客户端名首字符后插入 U+200D；
- 本插件当前只在失败后按句子边界插入 U+200B，且默认不主动遮蔽。

优点：

- 不需要知道完整黑名单；
- 对 exact substring / prefix 检测通常有效；
- 改动小、可逆、模型语义基本不变。

风险：

- 如果网关做归一化（去零宽、去空白、大小写折叠）则会失效；
- 如果网关要求字节级缓存一致性或计算内容哈希，扰动可能影响缓存或校验；
- 零宽字符可能被用户复制、被审计工具视为异常内容；
- 本插件把 U+200B 放在句界，对「首字符后才匹配」的词表不如首字符后插入稳定。

### C. 主动伪装成官方客户端（最主流，但最激进）

代表：AIRoute、CLIProxyAPI cloak、部分 coding-plan 中转。

手段分四层：

1. 协议头：固定/复刻官方 User-Agent、beta 头、conversation headers；
2. 结构：header 顺序、JSON 字段顺序、metadata.user_id、cache_control；
3. 完整性：复刻官方客户端的哈希、token、版本指纹（AIRoute 的 cc_version / CCH）；
4. TLS：JA3/JA4、HTTP/2 指纹、浏览器 impersonation。

优点：

- 对「官方客户端身份」型网关最有效；
- 不依赖提示词黑名单。

缺点：

- 需要持续抓包维护；
- 可能触及上游服务条款；
- 官方客户端一旦加完整性校验，就要实现完整签名/哈希；
- 对 WorkBuddy 这种未知字段/未知头规则，成本很高。

### D. 只识别、绝不伪造（合规路由器路线）

代表：BitRouter 新版 Claude Code provider。

原则：

- 识别真实客户端时只读取稳定协议标记；
- 不给任意流量注入官方身份；
- 路由器自己不伪造上游签名。

优点：

- 风险最低；
- 不参与客户端指纹军备竞赛。

缺点：

- 不能解决「网关拒绝第三方客户端」本身；
- 只适合订阅/官方流量分流，不适合伪装接入。

### E. 用户侧临时规避（非软件方案）

coding-plan 社区常见做法：

- 挂假客户端 User-Agent；
- 改 base URL；
- 换区域/账号；
- 降级到旧版本客户端。

这些做法与本插件错误信息一致：**对 WorkBuddy 的内容开头门无效**，因为门读的是消息内容，不是账号、IP、UA。

## 4. 对照表

| 方案 | 是否需要知道黑名单 | 是否改正文 | 代表 | 主要风险 | 对本插件 11128 的适用性 |
|---|---:|---:|---|---|---|
| 失败后加中性头 | 否 | 只改命中/全部被扫描开头 | 本插件 | 额外一轮失败；宿主历史仍可能复发 | 高 |
| 零宽扰动 | 否 | 可逆微改 | 本插件、CLIProxyAPI、AIRoute | 网关归一化后失效 | 高 |
| 黑名单词首字符后插零宽 | 是（可配置） | 局部微改 | CLIProxyAPI、AIRoute | 词表维护；归一化 | 中高 |
| 官方身份头/结构复刻 | 否 | 常伴随正文改写 | AIRoute | ToS、维护成本 | 低到中 |
| 官方 CLI 进程 | 否 | 不需要伪装正文 | 本插件 cli-bridge | 依赖真实 CLI | 高，但不通用 |
| 只识别不伪造 | 否 | 不改 | BitRouter | 不能绕过第三方拒绝 | 低 |
| 换账号/区域/UA | 否 | 不改 | 用户临时方案 | 浪费额度 | 无 |

## 5. 针对本次错误的诊断

错误中的三个开头：

- `system：You are an AI agent powered by DeepSeek Harness.` —— 已知 DSH 指纹，插件已有名单；
- 两个 `assistant：验收做完了……` / `assistant：这是宿主按计划投递的……` —— 很可能不是「网关新增词条」，而是证据提取只回显首行 120 字符。真正可疑的指纹更可能在这些 assistant 历史消息的后续正文里；
- 另有 4 条未列出，被 `CHANNEL_EVIDENCE_LIMIT = 4` 截断。

因此当前回显有三个误导点：

1. 「不在插件已知名单里」只说明**首行**不在名单，不说明整条消息不在名单；
2. 「网关可能新增了词条」把 assistant 历史里的内部短语误说成官方新增指纹；
3. 用户看不到未列出的 4 条，无法判断真正触发点。

本次失败的合理解释：

- DSH 的 system 开头是已知命中；
- 安静期提醒的 assistant 消息中可能含有 DSH/宿主相关长句，命中 exact-substring 规则；
- 错误报告把首行当成了候选指纹，实际门可能命中正文中部。

## 6. 建议方向（不实施，只给优先级）

1. **提高默认救援强度，而不是扩大名单。**  
   WorkBuddy 的门是前缀 + 精确子串，名单永远追不上。对 `channel_reject` 可以考虑直接使用「中性头 + 密集零宽扰动」组合，而不是先做一次注定失败的普通请求。

2. **改善证据回显。**  
   `channelEvidenceText` 应显示每条被扫描消息的前 120 字和后 120 字，或显示消息长度与中段摘要；否则首行很容易被误认为唯一证据。

3. **保留零宽扰动的自愈学习，但考虑失败即升级。**  
   当前第一次普通请求失败后才走梯子；如果 `channel_reject` 已是稳定分类，可以对该错误直接从强救援开始，避免每条新会话浪费一轮。

4. **不要默认做「完全冒充官方客户端」。**  
   AIRoute/CLIProxyAPI 面向的是明确的官方协议兼容层；WorkBuddy 目前没有公开稳定的官方头部、结构、完整性规则。主动伪造会把内容检测问题升级成协议欺骗问题，维护和合规成本更高。

5. **继续保留真客户端路线。**  
   `cli-bridge` 是本插件最接近主流强方案的路线：让真实官方 CLI 发请求，比继续维护提示词指纹更可扩展。

6. **把「零宽扰动」做成可配置策略。**  
   可选 `off / on-failure / always`。默认 `on-failure` 保持现状；对频繁触发 11128 的用户可提供 `always`，以减少每次新进程的第一次失败。

### 6.1 已落地改动（本次推进）

- `src/upstream.ts`：`perturbChannelFingerprints(body, dense)` 支持密集词边界扰动；`OpeningEvidence` 增加 `textLength` 与可选 `closing`。
- `src/shim.ts`：救援梯增加第三级密集扰动；新增 `channelPerturbation: 'off' | 'failure' | 'always'`；失败证据回显首行、尾行与总字数。
- `src/index.ts`：配置 schema 暴露 `channelPerturbation`，默认 `failure`；传入两个区域的 shim。
- 测试：新增密集扰动、`always` / `off` 策略、证据回显字段覆盖；渠道相关测试 80 个全部通过，完整套件 2137 个通过、2 个按平台跳过。

### 6.2 已落地改动（5.8.1，本次调查后推进）

上面建议 1 与建议 3 都指向同一件事——**别等被拒了才救援**——但都比「直接上密集扰动」有更好的解。调查期间读到的两条独立实测（本插件 issue #125、`workbuddy2api-hub` #533）把触发点点名到了字节：网关对被扫消息做的是**大小写不敏感的精确子串匹配**，活的 DSH 提示词里有**三处** span，且**三处全改才 200**。其中第二处 `You are a coding agent powered by the <model> model.` 是稀疏扰动打不到的（无相邻大写词对、无逗号、句末 `.` 在子串之后），正是那条请求一直 400 的直接原因；而密集扰动能打到它，代价是 **+70.7% 字节**。

- **`src/upstream.ts`：新增 `breakIdentityClauses()`，在 `prepareChatBody()` 里无条件跑。** 对身份从句的**每个内部词界**插一个 U+200B，实测三处 span 全部失配、**模型读到的每个词不变**、真实 10,818 字提示只 **+0.26% 字节**（~28 个字符）。这是「救援必须先被拒一次」的真正替代：已知词条不再靠一次注定失败的请求去发现，也不靠 +70% 的密集扰动去覆盖。
- **`src/upstream.ts`：删掉 `perturbChannelFingerprints()` 里的粗粒度幂等保护 `if (text.includes(U+200B)) return`。** 请求路径现在本来就先放几个 U+200B，这句粗判会让梯子从第二级起**永久空转**（连 dense 都被挡）。幂等改由各规则**自身**保证：拉丁句读/逗号规则锚在尾随 `(\s+)`（U+200B 非空白，自然不重复匹配），CJK 句读规则补 `(?!\u200b)` lookahead，`breakIdentityClauses()` 靠 `\s+` 不匹配 U+200B 而自然幂等。
- **建议 6 的 `always` 降级为边缘手段。** 定向破坏已用 +0.26% 覆盖三处已知 span，`"always"` 的密集扰动只剩「出现定向破坏与稀疏都打不到的**未知** prose 指纹」这一种理由，README 与 DESIGN 都据此改了措辞，不再推荐普通用户开启。
- **测试：新增 `tests/identity-clause-break.spec.ts`（13 条）。** 钉住三处 span 全部失配、词不变、成本上界、大小写/换行/任意空白、自然幂等、普通对话逐字节不变、assistant 历史也被破坏、`user`/`tool` 不动，以及移除粗判后三条扰动规则各自的幂等（含 CJK lookahead）。因身份从句现在在请求路径就被破坏，`issue98` / `issue98-shim` / `upstream` 里几条钉「旧字节形态」的断言改为钉**不变量**（去掉 U+200B 后与宿主原文一致、前缀门仍补中性头），并加注释说明为何旧断言不再成立。完整套件 **2218 通过 / 2 跳过**，`typecheck` 与 `build` 通过；构建产物用「故意破坏源码、只留 lib」的方式独立复验，确认新逻辑确实进了包。

### 6.3 已落地改动（issue #213，2026-11-04）

§5 列出的三个误导点里，前两个（「不在名单里」只判首行、「网关可能新增了词条」把首行误说成官方新增指纹）在一位报告者身上完整复现了，代价是一整节错误论证。改的是 `src/shim.ts` 的 `channelEvidenceText()` 与渠道失败文案，**不碰请求字节**：

- 标签改成「（不在插件已知名单里，仅指首行）」；
- 「网关匹配的是每一条 system 与 assistant 消息的开头」→「开头做前缀匹配，正文做精确子串匹配」（#125 实测到的另一半，旧句把它漏掉了，读起来像「只有开头会被扫」）；
- 强制中性头那一级**真跑过**时追加「这次重试里每一条被扫描消息都已经加了中性头，仍然被拒，说明卡点不在这些开头本身」；由 `retriedWithForcedHead` 决定，没跑过就不出现；
- 结尾「若上面标着…请修改该提示」→「只说明首行不是已知指纹，既不表示没被处理，也不表示它一定有问题；如果确实有问题，命中的更可能是中段的某一句」。
- 测试：`tests/issue213-channel-evidence.spec.ts`（3 条）——逐条列出 reasoning 形状的 assistant 开头、断言最后一发里每条 assistant 文本确已带中性头（去 U+200B 后比较）、以及「没跑过第三级就不许说跑过」。§5 第 3 点（4 条截断后用户看不到其余）**仍未解决**：它需要把完整请求落盘或让用户主动提供，属于另一个决定，不在本次改动里。

## 7. 参考

- 本插件渠道门实现：[src/upstream.ts](../src/upstream.ts)、[src/shim.ts](../src/shim.ts)
- 本插件真客户端路线：[src/cli-bridge/runner.ts](../src/cli-bridge/runner.ts)
- CLIProxyAPI Claude Cloak：[PR #868](https://github.com/router-for-me/CLIProxyAPI/pull/868)
- AIRoute Stealth Guide：[docs/security/STEALTH_GUIDE.md](https://github.com/jaccen/AIRoute/blob/main/docs/security/STEALTH_GUIDE.md)
- BitRouter 从 system prompt 识别改为 beta header 识别：[PR #594](https://github.com/bitrouter/bitrouter/pull/594)
- Claude Code 请求隐写背景：[Claude Code is Steganographically Marking Requests](https://thereallo.dev/blog/claude-code-prompt-steganography)、[HN discussion](https://news.ycombinator.com/item?id=48734373)
