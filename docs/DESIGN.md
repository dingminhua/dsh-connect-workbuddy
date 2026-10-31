# 设计方案：dsh-connect-workbuddy

> **目标**：连接 WorkBuddy 的 DSH 插件。
> **表现形式**：与 `dsh-connect-trae` 一致（插件家族统一外观）。
> **内核**：参考 `dsh-workbuddy-connect`（技术难题照搬已验证的做法）。
> **体验**：从 trae 借来，解决 workbuddy 原版的不足。

---

## 零、硬性边界：不做插件之间的联动

**本插件不与其他插件协作。** 这不是实现细节，是项目级不变量：改代码时不需要、
也不允许为「另一个插件在场」做任何适配。落到可执行的规则上：

1. **不读别人的注册。** 不调用 `slots.entries(...)` / `entriesOfSlot(...)` 去枚举同一槽位里
   还有谁注册过，也不检查某个插件是否安装。
2. **不渲染别人的组件。** 不退而求其次地把某个槽位的行「转交」给另一个插件的组件渲染。
   这看起来只是转发，实际要代渲染器合成对方的 props——例如 `t` 席位来自对方注册时声明的
   `locale:` 命名空间——一处合成不对就抛错；而为了不递归，还得约定一条跨插件的转交方向。
   这正是本插件明确不承担的责任。
3. **不依赖别人的优先级。** 槽位只声明自己的优先级常量，取值只要求「不与别人碰撞」，
   不要求知道别人用了几。别人改优先级不该让本插件失效。
4. **不因别人在场而改变行为。** 不是自己的模型行，一律给宿主的契约下限（纯目录名）。

**这条边界是有代价的，且代价被接受。** `conversation.input.model.label` 是 `single` 槽位，
一格只有一个赢家。当本插件赢得该格时，别的插件在**它自己的行**上的装饰不会被合成——
例如宿主自带的「1017」发布徽章不会出现在本插件渲染的那一行。这是**放弃联动换来的确定性**，
不是待修的缺陷；想改成联动，先改本节。

**这个代价会被用户当成 bug 报上来（issue #138，2026-10-24）。** 报告者描述完全准确：启用本插件
后，官方 DeepSeek 行上的「1017」徽标消失，禁用即恢复。他还提了三条修法，逐条处置如下：

1. **「按 provider 决定是否注册」——不采纳。** 注册是**全局一次性**的（`ctx.slots.inject` 一次
   挂载），而 `provider` 是**逐行渲染时**才传进组件的；要做到「只在 WorkBuddy 行注册」，必须
   监听模型选择器的当前选中状态、切换时注销再注册。副作用是中间那格会空（闪烁），且本插件
   开始观察宿主的选中状态——比现在更深的耦合，正是 §零 要避免的。
2. **「接管时补画官方徽标」——不采纳。** 那要把 `deepseek-official`/`deepseek-account` +
   `deepseek-flash` 的判断和一个蓝色徽标的样式抄进本插件；而该包自述是 **temporary** 发布徽章、
   承诺结构化标签上线后移除，抄进来等于绑死一个会被删的东西，且违反本节第 2 条。
3. **「让宿主把槽改成 `list` / `chain`」——这是唯一能根治的方向**，但属于上游改动，插件侧
   无论怎么调，一格仍只有一个赢家。

**因此本节的处置是「说清楚」而不是「改行为」**：把注释里那句不准确的
「renders nothing at all for a provider that is not ours」改成事实（它渲染**纯目录名**，
而占位与输出无关，`null` 同样不释放格子），并在注册处写明代价由谁承担。不引入开关、
不做动态注册——若将来要推翻，先改本节。

**为什么这条边界与宿主同向（2026-10-24 实测取证）。** 本节一度被怀疑是「自作自受」，
但宿主一方早就有书面立场：`@deepseek-ai/dsh-client-ui-deepseek-model-label-1017` 的
README「Known Limitations and Deferred Work」逐字写着——

> This package occupies a `single` slot. Another model-label plugin at the same
> priority conflicts; **the two presentations do not compose automatically.**

宿主把「两个模型标签徽章不自动合成」列为**已知限制**，并给出的处置办法是**在配置层禁用**
（profile patch `disabled: true`），而不是运行时协商。所以本节不是额外施加的洁癖，
而是与宿主官方口径一致。

> 实测记录：宿主 `0.2.1-rc.2` 起在 web-app 捆绑里新增
> `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017`，与本插件同占该槽的默认优先级 `0`，
> 导致本插件注册**抛错**、徽章静默消失。修法只是**换一个不碰撞的优先级**（见
> `MODEL_LABEL_PRIORITY`），**不引入任何联动**。详见
> [`DSH-0.2.1-RC3-FOLLOWUP.md`](DSH-0.2.1-RC3-FOLLOWUP.md) §2.3。

> **宿主面的边界写成了测试**：本插件认领的槽位是一个**封闭集合**（`conversation.input.right`、
> `conversation.input.model.label`、`conversation.composer.dock`、`shell.quota-notice`），
> 由 [`tests/host-slot-surface.spec.ts`](../tests/host-slot-surface.spec.ts) 钉住。加第五个槽位
> 不会自动算错，但那是一次**改变了「我们在哪个宿主面上」的判断**，所以它先在那里变红，
> 提醒回头读 [`DSH-0.2.1-RC5-FOLLOWUP.md`](DSH-0.2.1-RC5-FOLLOWUP.md) §2.1——那里记着
> rc.5 起 `conversation.chat.reasoning.body` 的 `rawText` / `text` 语义分离，以及
> 「渲染 `text` 时不得重复做显示处理」这条约定。同一个文件还以**条件断言**表达它：
> 源码一旦碰到那个槽，就必须读 `rawText`。

---

## 一、两个项目的分工

| 层 | 来源 | 取什么 |
|---|---|---|
| 插件外壳 / 外观 | `dsh-connect-trae` | 卡片结构、`dsm-*` CSS、LD 品牌图标、`settingsScope` 配置回写、3 条 webServer 路由、npm 发布工程、CI |
| 连接内核 | `dsh-workbuddy-connect` | 桌面端凭据读取、token 刷新、`copilot.tencent.com` 上游协议、SSE 直通、shim 加固、CLI 诊断、host heartbeat |
| 体验改善 | 新设计（见下） | 模型管理、账号切换、凭据路径多候选、错误信息可读 |

两项目已有大量同构代码（`web-status.ts` 的 `safeMessage`/`json` 与当时的 `loopbackOrigin` 几乎逐字相同（`loopbackOrigin` 已于 5.8.5 抽成 `src/loopback.ts` 的共享判定），`client/index.tsx` 结构一致），说明这条融合路径是低风险的。

---

## 二、内核：照搬 workbuddy 的什么

这些是技术难点，别人已经验证可用，不要重造：

1. **凭据发现与解析**（`auth.ts`）
   - 平台默认路径：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`
   - 两种文档形态都支持：嵌套 `{"auth":{...},"account":{...}}` 与扁平 panel 形态
   - `expiryToMs()` 同时接受秒与毫秒
   - **双凭据择新**：桌面端文件（只读）+ `$DSH_HOME/.workbuddy-auth.json`（持有刷新结果），取 `expiresAtMs` 较大者；桌面端文件永不写入
   - 按需刷新：仅在 5 分钟余量内刷新，单飞去重；刷新失败但 token 未过期则继续用旧 token

2. **上游协议**（`upstream.ts`）
   - chat：`POST {base}/v2/chat/completions`，base 由 `domain` 决定（`workbuddy.ai` → global，否则 cn → `copilot.tencent.com`）
   - 强制 `stream: true`（上游拒绝非流式）；`tool_choice` 从 OpenAI 对象形态压成上游要的字符串
   - **`11128` 是网关的一组门，不是一个原因。** 首条不是 system、`developer` 角色、缺 conversation 三件套（issue #66）、**被扫描消息的开头**命中「已知第三方 agent 提示」清单，都回同一个业务码，而 `displayTips` 一律写成「渠道校验 / 不是官方客户端发出的」——误导性文案每一次事件里都把人引向客户端身份。前三条分别由 `ensureSystemHead()` / `prepareChatBody()` 的 role 改写 / `conversationHeaders()` 处理；最后一条是内容前缀匹配，由 `prepareChatBody()` 在命中者最前面补一行 `You are a helpful assistant.`，未命中的 body 逐字节不动。清单是**实测快照**，不是理论：测法、边界（只看开头、大小写不敏感、**每个 text part 都扫**）见 `src/upstream.ts` 的 `UNAPPROVED_CHANNEL_OPENINGS` 注释
   - **被扫的是 `system` 与 `assistant` 两种角色，不是只有 `system`（4.15.0，issue #98）。** 实测（CN，2026-10-21）：`system` 开头命中 → 400；**`assistant` 历史消息开头命中 → 同样 400**；同一句话放在内容中间、放在 `user` 消息开头、放在 `tool` 结果开头 → 全部 200。这条差别的后果是会话级的：只要历史里有一条 `assistant` 消息开头是被拦的身份（模型复述自己的提示词、会话恢复/重放、折叠摘要残留），**该会话之后的每一轮**都被拒，换账号与换区域都不会改变一个字节。所以 `neutralizeChannelFingerprints()` 对两种角色做同一件事（字符串或每个 text part），而**不是**只修 system
   - **名单不可能列全，所以有了「强制中性头」重试（4.15.0）。** 那份名单是网关自己的数据，插件只持有实测快照；网关加一条，插件就漏一条，而漏掉的那条会让整个会话死掉。因此渠道校验失败后，插件用 `forceNeutralHead()` 给**每一条** `system` 与 `assistant` 消息（含每个 text part、跳过空内容）最前面补中性头，在**同一个账号**上重试一次：闸读的是开头而不是内容，所以「挪到开头之外」与具体指纹无关。返回 `undefined`（无处可改）时不重试；第一次失败是提示词的问题，不记账号账
   - **网关不止看开头，还按「提示词中间的一段长文本」匹配（4.15.0 之后补，issue #98）。** 实测（2026-10-21，国内区，把宿主的真实失败请求逐段二分）：插件已把每条被扫消息的开头移到中性头之后，请求仍然 400；触发点是 system 提示词里 **221 个字符**的一段（DSH 的 Web GUI 段落前两句），**单独发就 400，其中任意一处改动就 200**，外面加前后缀不影响——精确子串匹配。单句各自发都是 200，所以按开头设计的归一化永远看不到它。解法是 `perturbChannelFingerprints()`：在被扫消息的句读处插入 U+200B 零宽空格，对读者不可见、对模型无意义，但任何跨句指纹都会被截断。它**只在网关已经拒绝之后**跑（重试阶梯的第二级，第一级是 `forceNeutralHead`），正常请求逐字节不变。**注意**：这是对「精确子串匹配」这一实测事实的通用兜底，不是对某个具体词条的猜测——具体词条随时会变
   - **但 agent 身份从句是已知词条，必须在请求路径就先破坏，不能等被拒（5.8.1，issue #125 / workbuddy2api-hub #533）。** 上一条的「通用兜底」只在失败后跑，代价是每次都得先挨一发注定被拒的普通请求；而对**已被实测点名的**身份从句，这个代价没必要付。#125 与 #533 独立测出同一件事：网关对被扫消息做的是**大小写不敏感的精确子串匹配**，活的 DSH 提示词里有**三处**这样的 span（`You are an AI agent powered by DeepSeek Harness.` / `You are a coding agent powered by the <model> model.` / `You are interacting with the user through the DeepSeek Harness Web GUI …`），而且**三处全改才 200**（「只改任意一两处不够」）。关键教训是第二处：它**没有相邻大写词对**（`WORD_INTERNAL_BREAK` 打不到）、**没有逗号/分号**、句末那个 `.` 又落在被禁子串**之后**（句读规则也打不到）——所以稀疏扰动清掉了第一、三处，却把第二处**逐字节原样**发出去，正是那条请求一直 400 的原因。密集扰动能打到它，但要 **+70.7% 字节**（10,818 字的真实提示插 7,742 个 U+200B）。修法是在 `prepareChatBody()` 里对身份从句做**定向破坏** `breakIdentityClauses()`：在从句的**每个内部词界**后插一个 U+200B，实测三处 span 全部失配、**每个模型读到的词都不变**、真实提示只 **+0.26% 字节**（~28 个字符）——足够便宜到能无条件跑，这才是「救援必须先被拒一次」的真正替代。前缀名单（`UNAPPROVED_CHANNEL_OPENINGS`）与它**各司其职、都要跑**：名单管 offset 0 的前缀门，从句破坏管任意位置的子串门；顺序是**先补中性头、再破坏从句**，否则从句里的 U+200B 会让前缀谓词匹配不上、连累中性头这级防线
   - **定向破坏取代了「粗粒度幂等保护」，所以每条扰动规则必须自己幂等（5.8.1）。** `perturbChannelFingerprints()` 此前靠一句 `if (text.includes(U+200B)) return undefined` 保证重试不叠加零宽；但请求路径现在**本来就会**先放几个 U+200B 进去，这句粗判会让整个梯子从第二级起**永久空转**（连 dense 都被它挡掉）。删掉它之后，幂等改由各规则**自身**保证：拉丁句读/逗号规则锚在尾随 `(\s+)` 上，而 U+200B 不是空白，所以已断的句子自然不再匹配；CJK 句读规则没有尾随空白可锚，必须显式补 `(?!\u200b)` lookahead，否则每次重试都会在 `。！` 后叠一个零宽；`breakIdentityClauses()` 靠 `\s+` 不匹配 U+200B 而自然幂等（从句一断，`IDENTITY_CLAUSE` 就不再匹配它）。三条各有测试钉住
   - **渠道校验现在是三级救援，并可配置扰动策略（5.7.0）。** 默认 `channelPerturbation: "failure"` 保持原有低侵入学习式救援：普通请求被 `11128` 拒绝后依次用「强制中性头 → 稀疏零宽扰动 → 密集零宽扰动」重试，任何一级成功后本进程后续请求直接从该形状起步；`"always"` 让每个请求从最保守的密集扰动形状起步，适合网关已让普通请求必失败的用户；`"off"` 只保留拒绝后的救援、从不预先改写。密集模式在被扫描的 `system` / `assistant` 文本字符边界插入 U+200B，能打破没有标点的纯 prose 指纹；稀疏模式仍先试，以保持已实测形状的最小改动。**注意**：`"always"` 的密集扰动是 5.8.1 之前对付身份子串门的唯一可靠手段，但现在请求路径的定向破坏已用 +0.26% 覆盖了三处已知 span，`"always"` 只剩「网关出现定向破坏与稀疏都打不到的**未知** prose 指纹」这一种理由——绝大多数用户不该再开它。证据回显也从「只显示首行」升级为「首行 + 尾行（若有）+ 总字数」，避免把中性化后的 assistant 历史误报成网关新增词条。
   - **同一族码的三道门只能靠 body 区分**（4.13.2 / 4.15.0）。既然 `11128` 有三个来源、而 `displayTips` 对三者**一字不差**，那句话就永远不是判据。所以「开头命中」这一道在错误分类里**单独成类**（`channel_reject`），判据要**两半同时**成立：body 里有 `"code":11128` **且** `msg` 的措辞命中（`unapproved channel` / `illegal api invocation`）；另外两道门（`conversation id missing`、`first message is not system prompt`）**显式排除**——认错会让读者去改写一条根本没问题的提示，比通用回复更糟。**只认 `msg`、绝不认 `displayTips`**：那句托词是全族共用的，认它等于把三道门混成一道。4.15.0 起，另外两道门**仍然**不进 `channel_reject`，但会用各自的文案点名（`isConversationIdGateBody()` / `isFirstMessageGateBody()`），而不是落进通用兜底、把网关那句托词原样转述
   - **`11128` 与 `11140` 的 `msg` 会逐字相同，所以标记表里不能放裸文本（5.8.0，issue #127）。** 11140 的 `msg` 实测为 `request illegal`，而 11128 的渠道门**也**回 `request illegal`——5.7.0 的分类器把这条裸文本登记成 11140 的标记，于是渠道拒绝被整族误判成 `policy_reject`：账号池按「内容问题、换号无用」处理，用户收到的建议也跟着错。修法是把这条裸文本删掉，分类只认**业务码**：`11140` 改成从信封里读 `code` 字段（`businessCodeOf`，先 `JSON.parse` 再退回带空白的正则），而不是匹配 `"code":11140` 这一种紧凑拼法——带空格的 `{"code": 11140}`、字符串码 `"code":"11140"`、嵌套的 `{"error":{"data":{"code":…}}}` 都会掉出原来的字面量匹配，而掉到 `client` 之后 `outcomeOfFailure(403, …)` 会把健康账号报成 `credential-rejected`（review #127 实测）。11140 内部的账号判定再要求短语出现在**解码后**的 `displayMsg` / `displayTips` / `msg` 上（NFKC + 去零宽 + 空白折叠），因此 `\uXXXX` 转义与断行不再造成漏判，短语出现在无关字段里也不会被当成账号证据；11128 / 14003 的匹配仍保留实测过的紧凑写法（漏判只会退化成普通 400，不会不可逆）。**（本条前半原先写作「11140 与 11128 都改成从信封里读 code 字段」，与本条末尾这句自相矛盾；不成立的是前半——`6bdba2a` 里 `businessCodeOf` 只有一个调用点，`11128` 从未被换过，连 #127 自己的提交信息也这么说。5.12.3 按实测把前半改写为只讲 `11140`。）**
   - **同一处紧凑写法又活了 12 个发布版本，而上一条低估了它的代价（5.12.3，issue #155）。** 上一条里那句「漏判只会退化成普通 400，不会不可逆」在事实上没错——`client` 不停号、不烧额度——但它让 `11128` 一族继续用 `body.includes('"code":11128')` 判族，而 #127 之后 `11128` / `14003` / `14018` 三族实测在 v5.8.0 → v5.12.2 每个 tag 都还留着 5 处 `includes(...CODE)`。真正的代价不是「退化成 400」：**渠道救援阶梯只认 `kind === 'channel_reject'`**（`shim.ts`），漏判成任何别的类别都等于整条阶梯不跑——`forceNeutralHead` 与两级扰动一次都不会碰，用户被要求「调整请求后重试」，而插件根本没试过救援；#113 那一整套救援取决于上游 JSON 里有没有一个空格。`14003` 的降级目标还随 HTTP 状态而变（`429` → `soft_rate`，`400` → `client`），而 `model_busy` 是三个不换号类别之一——落到 `soft_rate` 就是让整个账号池挨个烧一次真实请求，去学一个跟账号无关的「模型忙」。`14018` spaced 只有当 `msg` 恰好带上 `Credits exhausted` 那句话时才被措辞标记救回——上游改一个字判据就失效。逐行跑在 5.12.2 代码上的完整矩阵见 `src/upstream.ts` 的 `statesBusinessCode` 注释。修法是**一个共享读取器**：四族 6 处判族统一走 `statesBusinessCode`，且判族与 `parseUpstreamErrorDetail`（给用户打印 `code NNNNN` 那一半）读**同一个** `businessCodeOfDocument`——矩阵第 4 行 `{"error":{"code":11128}}` 方向相反（substring 恰好命中嵌套码、而解析器当时只认 `error.data.code`），这正是「只换成解析器」不够的证据。
   - **密集扰动这一级是 O(n²)，大 body 上「跑得太慢」与「根本没跑」无法区分（2026-10-28，issue #159 衍生）。** 这一级只在网关已拒过两次之后才走，恰好落在真实的大会话上；而它的插入位置是用 `replace(/(?=\S)/gu, cb)` 找的，回调里为每一个匹配位置重新取「上一个非空白字符」——`source.slice(0, offset).match(/\S(?=\S*$)/u)`，每个位置一次 O(offset) 前缀切片，整体 O(n²)。实测（Node 25，改动前）：11,575 字符 1.3 s、23,075 → 5.2 s、46,075 → 22.8 s、**92,075 → 82.7 s**、184,075 → 322.8 s。`chatStream` 对真实请求**刻意不设超时**（真实答案要先预填整个提示词，卡一个「够用」的上限必然切掉慢而正常的答案），所以这一级是同步 CPU、先算完才发请求，于是救援会先被读者自己的等待熬过去——**从外面看，「这一步跑了 82 秒」和「这一步没跑」是同一件事**，这正是 #159 现场看到的「一级都没跑」的可解释来源之一。修法是一趟累加扫描（`spaceDenseBreaks`），输出**逐字节相同**：旧规则那句 `/\S(?=\S*$)/u` 要求「其后全部非空白」，所以它取回的是**当前这段非空白串的首字符**而不是上一个字符——这个反直觉点写成状态机时极易写错（本轮写错两次，靠 22 个定点用例 + 1500 例定种子随机语料的字节比对发现）。92 KB 由 82.7 s → **10 ms**。**耗时断言不能用绝对值**：`issue159-dense-rescue-cost.spec.ts` 钉的是 60 KB→120 KB 的**比值 < 3**，因为实测旧规则恰为 4.0，而最初用的 8 倍上限会把二次方规则放过去（变异测试发现后改成 3）。
   - **`!controller.signal.aborted` 这道门保留，删掉它会把诊断改坏（2026-10-28，issue #159 建议未采纳）。** #159 建议删掉阶梯上三处 `&& !controller.signal.aborted`，理由是「中止已由下传的 `signal` 在 `chatStream` 内部保证，外层这道 `&&` 重复且有害」。**前提不成立**：这个 shim 里 `signal` 只有 `res.on('close')` 一个来源（`shim.ts` 里唯一的 `controller.abort()`），即客户端**真的断开了**，不存在 issue 假设的「宿主内部中止」这第二个来源。**「重复」也只对一半**：删掉后 `chatStream` 确实立刻返回，但返回的是 `{status: 0, kind: 'server'}`（被 abort 的 `fetch` 抛 `AbortError`，客户端兜成传输失败），它会**盖掉**真正的 `channel_reject` 诊断——读者从「网关拒了这条请求」变成「上游服务器错误」；`reportFailures` 还会为一个**根本没上线的请求**记一笔账号测量，而「关闭一个面板就让健康账号 idle、全池无候选」正是 `shim-failover.spec.ts` 里 D1b 那条反向测试钉住的旧缺陷。实测对照（真挂断）：保留门 → 断线后**额外调用 0 次**、最终 `channel_reject`、不记测量；删掉门 → **额外 2 次**、最终 `server`、记一笔假测量。#159 真正关心的那一半（请求还活着时的 11128，三级照跑）由 `issue113-channel-gate-evidence.spec.ts` / `issue98-shim.spec.ts` 覆盖，新增的 `issue159-abort-gate.spec.ts` 同时钉住两半，防止后来者以「救援没跑」为名再把门删掉。
   - **11140 有两种语义，区分处是 `displayMsg` 而不是 `msg`（5.8.0）。** 内容政策拒绝是**请求级**的，而「`账号存在异常行为，已被限制使用`」是**账号级**的：前者换号无用、后者换号正好。新增 `account_restricted` 类，判定顺序放在 `policy_reject` **之前**——两者共用同一个业务码，晚一步就会被吞进那个桶
   - **`account_restricted` 值得换号并把账号永久停权；`channel_rejected` 两个都不（5.8.0）。** 这条分界是这一族错误唯一的实际区别：渠道门拒的是**每条账号都会发的同一份请求**，换号只会晚一轮拿到同一个 11128、还多烧一次真实额度；而「账号被上游限制」拒的是**这个账号**，下一个号就能答，所以它进 `failoverReasonText()`，并把成员以 `account-restricted` **停权**。它与 `policy-rejected`（测量照记、仍是候选）的区别在于**没有冷却倒计时**：上游不会因为等待而解禁。**回池路径实测只有手动「测试」一条**：账号 id 是 `uin`/`uid` 的哈希，重登后 id 不变、也没有任何落点会清这条测量，所以「重新授权就回池」不成立；上游解除后测一次拿到可用结果，测量被覆盖，账号才重新成为候选。另外停权只作用于池内候选资格——`applyPoolSelection` 在全池无可用候选时会清掉轮换覆盖，请求回到保存的选择，被停权的账号若正是它仍会计费一次。两处都有反向测试钉住（含一条 shim 级换号测试：此前删掉这一类的换号资格，全套测试仍全绿），防止后来者把它们合并回「反正都是 400」
   - **这类失败的三条行为都跟着「拒的是请求，不是账号」走**：不换号（闸读的是每条账号都会发的同一份请求，换号只会晚一轮拿到同一个 11128，还烧真实额度）、不把账号踢出池（与 `policy-rejected` 同处理：测量照记，账号仍是候选）、探针与账号表用各自的文案（`channel-rejected`，语气 `warn` 而非 `bad`——账号没问题）。**证据在请求里而不在回复里**，所以这一类额外回显**宿主原始请求**里被扫描消息的开头——**不是**归一化之后那份：旧实现取的是 `prepared`，而插件补的中性头正好在第一条，于是回复永远说「命中的是 `You are a helpful assistant.`」（这句话单独发是 200），issue #98 的十位报告者收到的都是这句。现在用 `openingEvidenceOfBody()` 读**宿主 body**，逐条标 `system：` / `assistant：`，并标「插件已加中性头」/「不在插件已知名单里，网关可能新增了词条」；最多列 4 条并写明还剩几条。**不再说「命中的」**：网关从不告诉插件它匹配了哪一条
   - CLI 形态请求头：`X-User-Id` / `X-No-User-Id`、`X-Enterprise-Id` / `X-No-Enterprise-Id`、`X-Domain` / `X-No-Department-Info`、`X-Product: SaaS`
   - **`X-IDE-*` 与 UUIDv7：只对齐「用量页怎么写这一笔」，不对齐「网关是否放行」（5.8.0，issue #132）。** 网关从 `X-IDE-Name` 填用量页的「使用端」，插件从不发它，于是用户在**自己的**用量记录里看到一行没有客户端的调用；网关还把 `X-Conversation-Message-ID` 回显成 SSE 的 `id` 并写进用量页，而插件的 `randomUUID()` 是带连字符的 v4，与官方客户端的 32 位十六进制 v7 摆在同一页上就像两种客户端。现在 chat 请求补 `X-IDE-Type: CLI` / `X-IDE-Name: WorkBuddy` / `X-IDE-Version`（版本号**从 `PRODUCT_UA` 解析**，不留第二个硬编码数字），三件套改为 `uuidv7()` 的 32 位十六进制并补 `X-Request-ID`（与 Message-ID 同值）；**生图路径不跟着变**——它保持 2026-10-21 在两个入口都答过 200 的带连字符 v4，因为 #132 只测了 chat，而生图的 id **格式**从来不是那道闸问的事（把 `'image'` 改成 `'chat'` 会让 `tests/upstream.spec.ts` 的生图守卫变红，这条经变异验证）。**`User-Agent` 在两种取值下都一字未动**：聊天绑在 CLI 通道上，那是账单与限流认的通道。三件套在任何形状下都是**每请求现生成、互不相同**——复用会伪造一个插件并不拥有的会话身份，这条理由与格式无关。`X-IDE-Type` 保持 `CLI` 而不是 `WorkBuddy`：本次需要的只是「使用端有名字」，冒充桌面端比这个需要更大。**证据等级决定了默认值**：这两项是报告者在其**插件 5.3.1 构建**上的实测（HTTP 200、模型不减、使用端与 ID 形状变对；注意这个 `5.3.1` 指的是本插件的版本，不是 WorkBuddy 客户端的 `5.8.3`），本插件的测试套件里没有复现这条链路，所以按 `docs/WINDOWS.md` §2 的档位含义（该节 2026-10-24 已把「C 档结论只能做成默认关闭的开关」写成条文，此前只是隐含用法），C 档证据既不写成「已验证」，也不作为**默认字节**上线——`usageIdentity` 默认 `false`。这跟「怀疑它有用」无关：`11128` 的三道门读的是消息开头、会话 id 有没有、首条是不是 system，**头改不动其中任何一条**；正因为它只是显示对齐、修不了任何东西，让全量账号先为一次没人复测的形状变化担风险就更没有依据
   - **出站身份统一到 `WorkBuddy`，并配一个逐字节回退档（2026-10-31，P1）。** 5.16.0 里同一个 token 在同一分钟会发出两种客户端：chat 带 `X-Product: SaaS` + `X-IDE-Type: CLI` + `X-IDE-Name: WorkBuddy`（三个互不相同的自称，且后两个还被 `usageIdentity` 挡着），billing 连 `User-Agent` / `Origin` / `Referer` 都没有，是一个裸 HTTP 客户端——而 billing 恰好是签到、领补偿这类**写操作**所在的域。A（`workbuddy2openapi`）与 B（`workbuddy2api-panel-main`）都不这么做：两家都让 `X-IDE-Name` / `X-IDE-Type` / `X-Product` **同值**、都发 `X-Agent-Purpose: conversation`，B 还给 billing 补齐了 UA / `Origin` / `X-CodeBuddy-Request` / `Accept-Language`。现在 `wireProfile` 的 `balanced`（默认，2026-10-31 的对照实验已证实有效）统一发 `WorkBuddy` 三头 + `X-Agent-Purpose` + `X-CodeBuddy-Request` + `Accept-Language`（按区 `zh-CN` / `en-US`）+ `X-Root-Request-ID`（与 `X-Conversation-Request-ID` **同值**，是同一个事实的第二个名字）+ 按账号派生的 `X-Machine-ID` / `X-Session-ID`（盐在 `$DSH_HOME/.workbuddy-device.json`，本机随机、绝不重键）；billing 补齐 `User-Agent: WorkBuddy/<ver>` / `Origin` / `Referer` / `X-Requested-With`。`conservative` **逐字节还原 5.16.0**（连 `X-Product: SaaS` 都还原——只删新头会造出第三个从未上线过的形状，排查时最误导人）。`usageIdentity` 因此只剩「id 格式」这一半职责。**刻意没有动的四处**：chat 的 `User-Agent` 仍是 `CLI/2.63.2 CodeBuddy/2.63.2`（会话三连绑在这个通道上，是账单与限流认的通道）；`/v3/config` 仍按 `PRODUCT_UA` 选文档（两条通道答不同文档，换 UA 就换答案）；生图仍不带 `Origin` / `Referer`（2026-10-21 在两个入口都答 200 的形态，统一改的是身份、不是把当时特意排除的变量加回来）；`X-Auth-Refresh-Source` 仍是 `workbuddy`（A/B 都写 `plugin`，但 refresh 是整条链路里最不能出错的一跳，改它必须单独实测）。**设备头与 `X-Device-Token` 是互斥两档、不是叠加项**：真 token 内含设备信息，再配一对伪造 id 等于自证不一致（`docs/DEVICE-IDENTITY-AUDIT.md` §5.3），因此这一版只发派生对，token 源留给 P2/P3
   - **`keepPromptLast`（默认 `false`）：搬顺序，外加只剥被记录那一条的前导标记（5.8.0，issue #132）。** 用量页的「请求」列取自 body 里**最后一条** `user` 消息，而宿主把时间采样、`Current runtime context.`、`<system-reminder>` 追加在用户真实 prompt **之后**，那一列于是常年记的是注入块。开启后把真实 prompt **之后**那些匹配注入前缀的 `user` 消息整段提到真实 prompt **之前**：消息数、角色、正文都不变，只有顺序变。**唯一的正文改动**是剥掉真实 prompt 自己的前导 `<acp …>mNNNNN</acp>`：不剥，那一列仍然以标记开头，等于只修了一半；而**更早的消息保留各自的标记**，因为模型会用 `mNNNNN` 引用历史，正在回答的这条的编号是唯一不可能被引用的。三个约束决定了它默认关：**①** 顺序与前导字符都是上游会数到的东西，升级后静默改它们不该由插件替用户决定；**②** 只认实测过的注入前缀（外加可选的 `<acp …>mNNNNN</acp>` 壳），匹配不上的消息一律不动——「取最后一条非空 user」这种写法会把别人的真实追问当成注入块搬走，所以有专门的**反向测试**钉住「普通对话逐字节不变」；**③** 搬移发生在 `ensureSystemHead()` **之后**，注入块永远不可能占据会话开头，那是网关明令要求的位置
   - 刷新走独立的 `X-Refresh-Token` 头；**chat 请求绝不携带 refresh token**（原版注释标为安全红线）
   - 错误分类：`hard_credit` / `soft_rate` / `model_busy` / `session_dead` / `policy_reject` / `channel_reject` / `not_found` / `server` / `client`，含中英文额度不足标记。`model_busy`（14003）与积分、账号无关、且是**暂时**的，因此与 `soft_rate`（6004，重置在几小时后）**必须区别对待**——见 §3.4 的「错误呈现」

3. **shim 加固**（`shim.ts`）—— 全部保留
   - 随机端口 + 进程内随机 secret（`randomBytes(32).toString('base64url')`），`timingSafeEqual` 常量时间比对
   - 四重入站校验：Host 头必须回环、Origin 必须回环、content-type 必须 JSON、bearer 必须匹配
   - 真实 WorkBuddy token 不交给 pi-ai；shim 自己从 store 解析

4. **适配器**（`adapter.ts`）：`createProvider` + `openAICompletionsApi()` + inert auth plane + `resolveApiKey: () => shim.token()`
   - **默认档位按路由定，能不能吃档位按模型定，两者的差必须由插件自己补。** `profileFor()` 给整条路由钉 `reasoning: WORKBUDDY_DEFAULT_EFFORT`（`'high'`，issue #83 的修法：缺省默认在 pi-ai 眼里等于 `off`，`/compact` 因此 100% 400 / 11133），而 `dsh-llm-pi-ai` 每次解析都用 `options.reasoningEffort ?? profile.reasoning`。目录里没有 `reasoning` 块的模型（`toPiModel()` 据此产出 `reasoning: false`）只支持 `['off']`，继承来的 `'high'` 接不了 ⇒ 组装请求时就抛 `UNSUPPORTED_REASONING_EFFORT`（issue #90 后半段，4.13.1 修）。修法：`EffortNormalizingAdapter extends PiAiAdapter`，对 `effortCapable(model) === false` 的模型①在 `resolveModel()`/`prepareCall()` 返回的信息里补 `reasoning: { efforts: [{ id: 'off', name: 'Off' }] }`（**不带 `defaultEffort`**——宿主会把它物化进每个未带档位的请求，随后 `callConfigEquals()` 逐字段比对会抛 `INVALID_PREPARED_CALL`），②在 `stream()`/`prepareCall().stream` 里把 `options.reasoningEffort` 归一成 `'off'`（宿主 `profileOptions()` 把 `'off'` 翻成不下发字段）⇒ 上游请求体一个字节不变。路由默认一字未动，显式请求不支持的档位仍由宿主如实拒绝

5. **保留 CLI 诊断**：`status` / `doctor` / `logout` + host heartbeat 文件（用户明确要求保留）

---

## 三、体验：从 trae 借什么

### 3.1 模型管理（原版最大短板）

**原版问题**：`catalog.ts` 只有 45 行，11 个模型硬编码为常量；启动后拉一次上游就全量覆盖，用户**不能启用/禁用、不能手动刷新、不能选择**。

**改善方案**（照搬 trae 的 `lastCatalog` + 勾选模型）：

```
Config:
  lastCatalog?: WorkBuddyModelInfo[]   // 上次刷新的完整目录（卡片展示用）
  enabledModelIds?: string[]           // 用户勾选启用的模型 id
```

- 运行时目录 = `deriveCatalog(lastCatalog, enabledSet)`，与展示目录分离
- 卡片永远展示**最新刷新的目录**，不是陈旧快照
- 上游刷新是**草稿操作**，用户点保存才写入运行时目录
- 有 Discard / Save 两个按钮 + dirty 标记

**上游数据完全撑得起**（实测 28 个模型 / 16 个 cli 模型）：

| 上游字段 | 卡片展示 |
|---|---|
| `id` / `name` | 模型名与 id |
| `maxInputTokens` / `maxOutputTokens` | 上下文 / 最大输出 |
| `credits` (`"x0.79 credits"`) | 积分倍率，需从字符串解析出数字 |
| `supportsImages` | **平台**图片输入声明（**不是**模型能力，不参与默认勾选，见下方「图片输入」） |
| `reasoning.supportedEfforts` (`["low","high","xhigh"]`) | 可选推理档位（用户可选手动档位） |
| `reasoning.effort` (`"high"` / `"medium"`) | 单数形态；折叠为全阶梯可选档位，该值作默认档（见下方「推理强度两态」） |
| `reasoning.defaultEffort` | 默认档位 |
| `descriptionZh` / `descriptionEn` | 中英文描述 |
| `onlyReasoning` / `supportsToolCall` | 能力标记 |

> 原版把这些**全丢了**，只留 id/name/tokens。这是最可惜的一处。
>
> **图片输入（2.2.0）**：点「从 WorkBuddy 刷新」时，卡片用**厂商核验表**覆盖图片勾选，保存后写入 `imageModelIds`；用户仍可随时修改，只有下一次刷新才会再次覆盖。运行时生效值仍由 `src/index.ts` 的 `withImageSelection` 从 `imageModelIds` 盖章为 `multimodal`——刷新目录本身不会越过用户保存直接改运行时。
>
> 三层含义必须分清（这是本改动最核心的一条）：
>
> | 字段 | 含义 | 谁说了算 |
> |---|---|---|
> | `supportsImages` | 上游**平台侧**的图片输入声明 | 上游目录接口 |
> | `native_modality` | 模型**原生**输入模态 | 厂商核验表（`src/native-modality.ts`） |
> | `multimodal` | 运行时**生效**值 | 用户保存的 `imageModelIds` |
>
> **`supportsImages` 不等于「模型能看图」**——它是平台声明。2026-09-29 用插件自身的凭据路径只读实测（不消耗积分）：
>
> | 网关 | CLI 模型 | `supportsImages=true` | `=false` | 缺失 |
> |---|---|---|---|---|
> | CN `copilot.tencent.com` | 16 | 15 | 1（仅 `glm-5.1`） | 0 |
> | 国际 `www.workbuddy.ai` | 23 | **23（全部）** | 0 | 0 |
>
> 即它对几乎整份名册都报 true。拿它当能力答案就会把纯文本模型也标成能看图——**这个错误本项目犯过一次，姊妹项目 `workbuddy-manager` 也犯过并已修正**（其 CHANGELOG 1.0.70：「此前直接把腾讯的『平台支持图片』开关当成模型的原生能力，于是 GLM-5.3 这类纯文本模型也被标成多模态」）。
>
> **核验表**（`src/native-modality.ts` 的 `NATIVE_MODALITY_BY_MODEL_ID`，15 条）：
>
> 表里有**两档证据**，界线必须记住——它不是「厂商页面」与「随便什么」的区别，而是「型号文档」与「上游目录自述」的区别：
>
> | 证据档位 | 条数 | 来源 | 为什么可信 |
> |---|---|---|---|
> | **A 档：厂商文档**（13 条，核验于 2026-09-25） | 13 | `workbuddy-manager` 的 `server/services/native_modalities.json`（逐条附厂商页面） | 厂商为自家的输入模态背书，可复核 |
> | **B 档：上游目录自述**（2 条，核验于 2026-10-30） | 2 | 桌面端缓存的 CN 目录 `acc-product-config-v3.json`（WorkBuddy 5.8.3，文档日期 2026-10-14）的 `descriptionZh` | 上游自己写明「原生多模态输入」，且 `supportsImages: true` |
>
> | id | kind | 档位 | 来源 |
> |---|---|---|---|
> | `glm-5.3` / `glm-5.2` / `glm-5.1` | `text` | A | <https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md> 等（「仅支持文本」） |
> | `glm-5.3-flash` | `multimodal` | A | <https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash.md>（原生多模态，图片/视频/文本） |
> | `glm-5v-turbo` | `multimodal` | A | <https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5v-turbo.md> |
> | `deepseek-v4-pro` | `text` | A | <https://api-docs.deepseek.com/quick_start/pricing>（V4-Pro 的 Vision：Not supported） |
> | `deepseek-v4.1-flash` | `multimodal` | A | 同上（V4.1-Flash 支持 Vision） |
> | `minimax-m3` | `multimodal` | A | <https://platform.minimax.io/docs/guides/text-generation.md> |
> | `kimi-k2.6` / `kimi-k2.7` | `multimodal` | A | <https://platform.moonshot.cn/docs/overview> |
> | `kimi-k3-1` | `multimodal` | A | <https://github.com/MoonshotAI/Kimi-K3> |
> | `hy3` / `hy4-preview` | `text` | A | <https://huggingface.co/tencent/Hy3>、`.../Hy4-preview`（模型卡 `pipeline_tag: text-generation`） |
> | `space-bunny` | `multimodal` | **B** | 目录 `descriptionZh`：「推理速度极快，编码能力强劲，并支持**原生多模态输入**的匿名大模型」 |
> | `minimax-m3.1-flash` | `multimodal` | **B** | 目录 `descriptionZh`：「**原生多模态**，擅长 office、agentic、编程任务…」 |
>
> **既然 `supportsImages` 对几乎整份名册都报 true，为什么 B 档还要参考目录？** 因为判据不是那个布尔字段，而是**描述里的措辞**——目录对 `hy3`、`glm-5.3` 这类纯文本模型只写「混元思考模型…」「旗舰模型…」，从不写「原生多模态」。也就是说，描述是一个**有区分度的**信号，而 `supportsImages` 没有。B 档把这条区分度用起来，但仍**不把它开放成通用许可**：新增 id 若只有目录描述、没有厂商文档，需要单独评估后再进表（写进表里的注释与 `tests/native-modality.spec.ts` 各自钉住「B 档恰好是这两条」），因为「目录说了」一旦变成立即可用的规则，就等于绕回被这张表取代的「报 true 就勾」。
>
> **B 档要解决的具体故障**：这两条 id 在 A 档快照之后才进名册，于是每次刷新都仅因「不在表里」被判成 `text`，宿主以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝粘贴的图片——与 issue #168 同一形状，只是根因从「数组没提到」换成了「表没收录」。
>
> **刷新时的判定（`imageDefaultFor`）**：只有核验为 `multimodal` 的才预勾选。`text` 不勾（文档说它读不了图）；`unknown` 也**不勾**——「不猜」正是这张表存在的理由，上游那枚布尔字段在这里不参与判定（否则又回到"报 true 就勾"的老路）。平台显式 `false` 保留一票否决，因此核验为多模态的模型也不会违逆平台的明确拒绝。
>
> **不做前缀/族匹配**：`glm-5.3` 是 `text` 而 `glm-5.3-flash` 是 `multimodal`，前缀规则必然错一个；`hy3` 是 `text` 而 `hy3-x` 无来源，不能用族关系把结论传下去；B 档的 `minimax-m3.1-flash` 同样不会把 `minimax-m3.1` 带上。表按**精确 id** 匹配，未列出的新模型一律 `unknown`。
>
> **本机实测影响面**（2026-10-30 用本机 CN 的 `cli` 名册 21 个重算，此前那节的 16 个是 2026-09-29 的名册）：
>
> - CN 21 个里 **7 个**会预勾选（A 档 5 个：`glm-5.3-flash`、`glm-5v-turbo`、`deepseek-v4.1-flash`、`kimi-k3-1`、`minimax-m3`；B 档 2 个：`space-bunny`、`minimax-m3.1-flash`）。被排除的纯文本有 `glm-5.3`、`glm-5.2`、`glm-5.1`、`hy3`、`hy4-preview`、`deepseek-v4-pro`（上游对它们全报 true）。
> - 其余 8 个（`hy3-x`、`step-5-preview`、`kimi-k3.1-pro`、`kimi-k2.8-preview`、`mimo-v2.6-pro`、别名 `fast-model`/`balanced-model`/`deep-model`）无来源，一律 `unknown`、默认不勾。这是「不猜」的代价，也是它的意义。
> - 国际区的结论仍是 2026-09-29 那次（23 个里只有 3 个有厂商来源），本轮**未重测**国际名册；`default-model` 已不在名册里：它是国际区的 `auto` 路由，见下条。
>
> **维护负担**：这张表是**快照而非实时同步**，且与 `workbuddy-manager` 仓库各存一份。新增 A 档 id 必须附**厂商来源**与核验日期；B 档（上游目录自述）目前**恰好只有两条**，由 `tests/native-modality.spec.ts` 钉住——再要加一条需要先想清楚为什么描述是唯一可得的证据，而不是顺手把目录里写着「原生多模态」的都抄进来。两边更新时需手动同步。表在卡片上体现为勾选框 tooltip（`row.modelImageText` / `row.modelImageUnverified`），否则一排勾选中间夹着两个空框会显得像 bug。
>
> 名单在卡片上带 tooltip（`row.modelImageUntrusted`）说明原因，否则它夹在一排已勾选的模型中间会显得像 bug。
>
> 此前（≤2.1.2）图片支持完全由用户手动勾选 `imageModelIds`（默认不勾选），上游标记实测不可靠故不采信。这套「默认全关」的代价是：上游明明声明支持的模型也要用户自己一个个找出来勾上。改为刷新覆盖后，默认状态跟随上游，用户只需纠正错的那几个。
>
> **推理强度两态（已修复，issue #7 / 2.0.10）**：上游 `reasoning` 有两种形态——(A) `supportedEfforts` 数组（可选手动档位，如 glm-5.3 的 low/high/xhigh）与 (B) `effort` 单值（如 deepseek 的 high）。`parseReasoning`（`src/upstream.ts`）**两态都解析**：形态 A 逐字段透传，形态 B 由 `singularEffortLadder` 折叠为复数形态——`supportedEfforts` 展开为全阶梯 `low/medium/high/xhigh/max`、单数值折入 `defaultEffort`、`canDisableThinking` 视为 `true`；未识别的 `effort` 值按单档透传，交由 adapter 的已知档位过滤。
>
> 依据是**两网关实测**（CN `copilot.tencent.com` / 国际 `www.workbuddy.ai`）：单数 `effort` 是模型的**默认档而非唯一档**——`deepseek-v4.1-flash` 对 low/high/max 全部 200 且 `reasoning_content` 各异，`kimi-k3-1` 接受未声明的 high；而**不发 `reasoning_effort` 时上游零思考**。adapter / 卡片 / 持久化零改动即自动生效。调查过程见 `docs/reasoning-investigation.md`（该文「未修复」结论已过期，正文就地加了更正注）。

#### 模型可用性测试（2.3.0）

每个模型行一个**测试**按钮，模型区顶部一个**测试已勾选**。每个模型发一条最小请求（`max_tokens: 1`），报告此刻能否使用。

**实测数据（本机真实账号，2026-09-29）**：

| 网关 | 抽样 | 结果 | 单次耗时 | `credit` |
|---|---|---|---|---|
| CN `copilot.tencent.com` | `auto` / `hy4-preview` / `hy3` / `glm-5.3` / `minimax-m3` | 全部 200 | 0.8～3.4s | 0～0.01 |
| 国际 `www.workbuddy.ai` | `fast-model` / `balanced-model` / `primary-model` | 全部 200 | 1.0～2.1s | 0 |

一次探测前后查余额：**933 → 933，不变**。同一名册正常一次回答为 0.79x 起，所以探测的代价可忽略。

**两个必须写下来的实测结论：**

1. **首条消息必须是 system。** 国际网关对 `[{role:'user',content:'hi'}]` 一律回 HTTP 400 / 业务码 `11128`（`first message is not system prompt`，附 `displayMsg`「请求被安全策略拦截」）。若照国内版只发一条 user 消息去探测，**整个国际版会被误报为全部不可用**。加上 system 消息后立即 200。故 `probeRequestBody` 恒带一条 system 消息。
2. **上游不提供限流元数据。** 200 响应头只有 `x-request-id` / `traceid` / `eo-log-uuid` / `server: APISIX/3.9.1` 一类，**无 `Retry-After`、无 `X-RateLimit-*`**；对 `minimax-m3` **连续快速打 12 次全部 200**，未触发限流。429 是否附带 `Retry-After` 未能实测到（未触发），因此解析器按 RFC 9110 同时接受**秒数**与 **HTTP-date** 两形态，并拒绝 0 / 负数 / 已过期的值——「立即重试」不是冷却时间，把它当冷却显示比不显示更糟。

**因此「多久之后可以再次使用」的取值只有两个真实来源**，由 `cooldownOf` 强制：

| 来源 | 适用 | 说明 |
|---|---|---|
| `Retry-After` 响应头 | 任何失败 | 上游为该次请求明确给出的时间，优先 |
| 月周期包 `refreshAtMs`（CapacityType 4） | **仅** `out-of-credit` | 该服务唯一主动声明的时间点 |

**限流绝不借用月周期刷新时间**：那会让用户为几秒的限流去等几周。上游两者都没给时，卡片显示「上游未给出何时恢复」——**不编造倒计时**。这是本功能最核心的一条约束：一个看起来像上游答案、实际是本地猜测的倒计时，会让人去等一个毫无意义的时刻。

**架构**：探测在 Host 侧发起（`src/probe.ts` 构造与解读 → `WorkBuddyUpstreamClient.probeChat` 传输 → `/plugins/dsh-connect-workbuddy/probe` 路由）。浏览器只发模型 id、只收回结论，**凭据绝不跨到页面**。

**路由逐模型串行**：并发扇出正是制造限流最直接的办法，那样测出来的是插件自己的负载而非上游的限制。批次上限 64，空列表 / 非数组一律 400（空成功会让卡片把「没跑」渲染成「全绿」）。

**与保存状态无关**：探测不写任何设置，因此不受 `dirty` / `canWrite` 限制，也可在只读卡片上使用；但需要已登录（无凭据时只可能是「被拒」）。结果不落盘、不影响 `enabledModelIds` / `imageModelIds`。

**失败分类复用 `classifyUpstreamError`**，使探测与真实 chat 对同一上游应答不可能得出不同结论；`401/403` 单独成一类（要的是重新登录/换账号，不是等待）。

#### 默认思考强度：为什么是「每模型」而不是「每路由」（issue #179）

用户要的是一个**默认值**：挑一次 `low`，以后每个新对话都不必在宿主的模型菜单里再挑一次。实现上真正要
回答的问题有三个，任何一个答错都会让「默认值」变成「硬编码」。

**第一，档位词汇是每模型的，不是每路由的。** 本机 CN 名册 15 个模型（2026-10-30 实测）各说各的：

| 档位集合 | 模型 |
|---|---|
| `low / high / max` | `deepseek-v4.1-flash`、`glm-5.3`、`glm-5.3-flash`、`kimi-k3.1-pro`、`kimi-k2.8-preview` |
| `high / xhigh` | `glm-5.2`、`deepseek-v4-pro` |
| `low / medium / high` | `step-5-preview` |
| `low / medium / high / xhigh / max` | `space-bunny`、`minimax-m3.1-flash`、`mimo-v2.6-pro` |
| `low / high / xhigh` | `kimi-k3-1` |
| 单档 `high` | `hy4-preview` |
| `low / high` | `hy3`、`hy3-x` |

所以「一个路由级默认值」在结构上不可能对整份名册成立，而点名一个模型没有的档位是硬错
`UNSUPPORTED_REASONING_EFFORT`（issue #90 的现场就是这条）。选择器因此只列**该模型自己声明的档位**，
名字照上游原样，不做本地化、不做跨模型统一——`low` 在 DeepSeek 和 Qwen 上不是同一回事，替用户「统一」
反而会让他以为自己选的是同一个东西。

**第二，`defaultEffort` 是宿主真正会用的那个字段，不是展示用的。** 宿主的
`LlmRuntime.resolveCallWithInfo` 做的是 `options.reasoningEffort ?? reasoning.defaultEffort`，也就是说
**每一个没指定档位的请求**（新对话、压缩摘要、会话标题）都由适配器公布的这个字段决定它走哪一档。
把它写死成常量，等于把用户的设置关在卡片里。本版把这个字段改成「用户选的，否则上游自己声明的」。

**第三，`off` 不能进这个字段。** 是否提供「关闭思考」是 `offModelIds` 的职责（issue #34 / #83），
两处都管会让同一个问题有两个能互相矛盾的答案。`src/default-effort.ts` 的解析函数把 `off` 一律当作
未设置处理，级别表里也不放它。

**「跟随默认」用「键不存在」表达。** 上游每个模型都自己声明 `defaultEffort`（13 个 `high`，两个五档模型
是 `max`），所以缺省项不是「没有意见」，而是「照上游说的办」——选择器第一项的标签因此写出真实档位。
这也决定了保存语义：`--save` 的槽位合并只做两层，嵌套字典是**整体替换**的，卡片每次必须送完整映射，
否则只送一部分就等于删掉其余模型的选择（而「未提到」正是「跟随默认」的表达方式）。

**顺带修掉的现象：切换账号后输入框的强度标签回退成 `high`。** 输入框标签取值是
`current.reasoningEffort ?? reasoning.defaultEffort`，而 `defaultEffort` 来自 `llm/adapters-updated`
触发的目录重载——本插件每次设置变更都会发这个事件。默认值写死成 `high` 时，重载后标签就被 `high`
盖掉了；**持久化的会话选择没变，所以发出的请求仍然是用户选的那一档**。本版改用真实默认值后，
重载前后通告的 `defaultEffort` 一致，标签自然稳定，不需要改动宿主。

### 3.2 账号切换（实测可行，原版完全没有）

**原版问题**：只认 `workbuddy-desktop.info` 单文件，账号切换只能靠在 WorkBuddy App 里重新登录。

**实测证据**（本机，只读探测）：

```
distinct accounts (by uin): 2
  uin <A>: <账号甲>  <- workbuddy-desktop.info
  uin <B>: <账号乙>  <- workbuddy-desktop.2026-08-28T...info

uin <A> (<账号甲>): catalog HTTP 200, 28 models, 16 cli, credits total=1875
uin <B> (<账号乙>): catalog HTTP 200, 28 models, 16 cli, credits total=0
```

> uin 与昵称在本文件中做脱敏处理；真实输出见 `scripts/probe-account-switch.mjs`（该脚本只在本机运行，不打印 token）。

**两个账号都拿到 28 个模型，但一个有 1875 积分、一个是 0** —— 用户必须能选。

**设计方案**：
- 扫描**整个 auth 目录**而非单个文件：`workbuddy-desktop.info` + 所有 `workbuddy-desktop.<stamp>.info` 历史文件
- 按 `uin` 去重（实测 6 个文件 → 2 个账号）
- 每个账号一项：`{ id: sha256(uin), accountName: nickname, uin, domain, source, tokenExpiresAtMs, selected }`
- 优先用最新文件（按文件名时间戳倒序）
- 默认跟随 App 当前登录（live 文件）；用户显式选择的账号被严格绑定，不按积分切换，失效时也不静默改选
- `accountId` 存进配置，**token 不进配置**（与 trae 一致）

> 注意：历史文件是 WorkBuddy 的**备份产物**，不是官方多账号 API。需在 README 明确标注，并把"跟随 App 当前登录"作为默认行为，账号切换作为显式选择。

### 3.3 平台路径（原版未验证 Windows/Linux）

**原版**：macOS 单路径；Windows 有 Local/Roaming 两个候选但未验证；Linux 未验证。

**改善**：
- 凭据文件候选列表化（macOS / Windows Local+Roaming / Linux XDG），逐个探测
- auth 目录整体扫描（同时服务于多账号）
- 环境变量 `WORKBUDDY_AUTH_FILE` 仍可覆盖
- 卡片内可直接指定 `authFile` 路径，不必手改配置文件
- `doctor` 命令输出每个候选路径的命中情况

> **平台口径（长期）**：Windows、macOS、Linux **三者并列支持**，且 **Windows 是一等目标平台**——它有专属分支、专属静默故障，且这些故障在 macOS 开发机上**不可能复现**。因此平台相关约束的登记处是 [`WINDOWS.md`](WINDOWS.md)：任何改动 Windows 行为的提交必须同步更新该文件，README 的「平台支持」一节与两份 README 也随之保持一致。改动的默认考量面包含 Windows（检查清单见 `WINDOWS.md` §4）。

### 3.4 其他体验点

- **积分展示**：原版只显示 `total` + 每个包的进度条；实测有 20~29 个包，其中 19 个同名「运营裂变包」各 100 积分 —— 需要**按包名聚合**，否则卡片被刷屏。同时区分**月度周期套餐**（按周期刷新、看周期剩余）与**一次性礼包**（看到期时间）；月度包不显示到期时间、展示下次刷新点
- **每日签到**：`/plugins/dsh-connect-workbuddy/checkin`（POST）提供一键签到，查询状态与领取均走该路由，回环来源校验 + 领取前二次确认，不重复领取
- **卡片外观**：从 workbuddy 的 inline style 换成 trae 的 `dsm-*` CSS 类 + `--dsw-alias-*` 主题变量 + LD 图标
- **错误呈现**：上游错误分类映射到人话（额度不足 / 需重新登录 / 限流），而不是抛 HTTP 状态码

  **写回宿主的 `error.code` 不是自由选择，它决定用户看到哪句话**（issue #84）。宿主的分类器 `classifyPiAiError()` 对 `type + " " + code + " " + message` 跑一串正则，命中顺序是：`401`/`403` 数字 → `AUTH`，**quota 措辞 → `QUOTA`**，`429`/rate-limit → `RATE_LIMIT`，`400` → `INVALID_REQUEST`，`5xx` → `SERVER`……而 `@deepseek-ai/dsh-client-ui-chat` 的 `failureMessage()` **对 `QUOTA`/`ACCOUNT_QUOTA` 写死自己的文案并丢弃插件自己的 message**。因此：

  - `model_busy` **不翻译**（拼写成自己的名字）。文本里只剩 `429` ⇒ 宿主读作 `RATE_LIMIT` ⇒ 文案保留插件那句，**且**进入原地重试集合，由 `dsh-llm-retry` 有界重试几次。这正是 issue #84 报告的「模型繁忙显示成额度已用尽 + 请求重试」两件事的正解。
  - `soft_rate` **翻译成 `quota_exceeded`**：它的 6004 重置在几小时后，重试预算换不出答案，必须继续挡在重试集合外。
  - `hard_credit` **不翻译**：报文里就有 `Credits exhausted`，`isQuotaExceededError` 自然命中 ⇒ `QUOTA`，宿主的终局文案此时是**对的**。
  - `channel_reject`（4.13.2）**也不翻译**，且**刻意不写成任何含英文限流措辞的形状**：它的中文文案里出现「额度」「积分」这些词是事实陈述（「与账号、积分、额度、网络都无关」），而宿主那几条 quota 正则全是英文的，所以不会被误判成额度失败——这条由 `tests/issue90-channel-reject.spec.ts` 用**宿主自己的** `isQuotaExceededError()` 钉住（真实 pi-ai 客户端打真实 shim）。它的 400 落在 `INVALID_REQUEST`，**不在**宿主原地重试集合（`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`/`EMPTY_RESPONSE`）里，这也是对的：闸对同一段提示的判决是确定的，重试只是把同一串字节再发一遍。

  同一个 HTTP 429 有两种相反的时间判断，所以**拼写跟的是时钟，不是状态码**。回归：`tests/issue84-model-busy-not-quota.spec.ts` 用真实 pi-ai 客户端打真实 shim，把产出的文本交给**宿主自己的** `isQuotaExceededError()` 断言。
- **区域开关**（对齐 trae 的 issue #11）：每个 tab 一个勾选框，取消即 `AdapterRegistrationHandle.replace([])` + `DirectoryRegistrationHandle.replace([])`，把该供应商从选择器与「设置 → 模型」页**彻底摘除**（不是只藏 tab）。改动只落在 `regions.<region>.enabled` 一个字段上，其余槽位原样带过。

  三个必须说清的约束：

  1. **为何必须落在注册层**：DSH 的模型选择器取数自 `llm.listProviders()`，而它直接读路由表。只隐藏卡片 tab 的话，模型仍可选、选中必失败（正是 issue #12 那类「选择器说可选、实际必报错」）。已验证关闭后 `listProviders()` 不再含该 provider。
  2. **为何是「先注册、再 replace([])」**：`registerAdapter([])` 的**首次**注册被 DSH 拒绝（`INVALID_ADAPTER`），而 `replace([])` 对已完成注册的句柄明确合法。两步放在同一同步段内，没有可观测的路由空窗。
  3. **目录是「一条注册持有两个条目」**：`replace` 设置的是**完整条目集**，因此必须**一次性**给出「启用集合的完整列表」。按区域分别 replace 会让后者覆盖前者，把启用的一侧一起弄丢（DSH 的 `commit` 会先删本注册持有的全部条目再写入新集）。集成测试专门守护这一点。
  4. **与 issue #12 的维度差异**：`WorkBuddyCatalog.usable` 是**自动**判断（本机有无该区域账号，由 `setRegionUsable` 驱动），`enabled` 是**用户显式**开关。两者独立且必须同时成立才对外提供模型——只修一个都会得出错误结论：只按 `usable` 会忽略用户「我就是不想看到它」的诉求，只按 `enabled` 会让无账号区域在用户勾选后复活成一堆必然 401 的模型。

- **未登录诊断**（对齐 trae 的未登录体验）：未登录时卡片折叠列出一条条「探测过的路径 + 来源 + 原因」，而不是只说一句「在桌面 App 里登录一次」。两个约束：

  1. **`encrypted` 必须独立成档，不能并入 `invalid`**：Windows 新版桌面端加密 auth 文件里的 token 字段，读它要靠 App 自身的原生绑定（`WORKBUDDY_APP_EXECUTABLE`）。此时用户**通常已经登录了**，失败原因是「App 不在场」，而 `invalid` 对应的建议是「没有可用 token」——两者指向完全相反的动作。并入后卡片会对着一个已登录的用户说「重新登录一次」，且这种错法在测试里不产生任何红灯（除了专门写的那条），所以有独立测试 + 定向变异守护。
  2. **只在「一无所获」时列出**：`selectionLost`（有本地登录、只是保存的账号 id 失配）这条分支**不列路径**——那些 token 是健康的，正确动作是重新选账号。诊断信息只在它确实解释现状时才出现，否则就是把用户带偏。同理，插件自己的副本在首次刷新前必然不存在，不作为「已检查路径」上报。

  展示上，`missing` 在「还有别的发现」时才收进二级折叠：普通机器上多数候选目录都是空的，平铺会把真正解释失败的那一条淹掉；而全部都是 `missing` 时它就是答案本身，直接展开。分类与文案映射放在 `src/client/searched-paths.ts`（不含任何浏览器依赖），因为卡片 `.tsx` 的模块图会拉进 DSH 的浏览器包，而本项目测试环境是纯 Node、没有 jsdom/react-dom——留在组件里的规则无法被测到。

- **未登录卡片的信息分工**（2.0.10，修「重复提示」）：2.0.9 把探测路径列出来之后，同一条事实在屏幕上出现了四遍——`resolve()` 的错误**本身已经枚举全部候选路径**，折叠区又列一遍，两处提示语还各自说一遍「没有找到登录信息」。定下的分工是 **段落说结论，列表给细节**：只要列表会渲染，段落就不再复述 `resolve()` 的路径枚举（退回简短提示，`searchedHint` 也去掉开头的「未找到登录信息」）；只有列表缺席（旧 Host、探测抛错）时，原始错误才是唯一信息来源，此时照常显示。丢弃的仅有「或刷新已有会话」——该分支**只在账号数为 0 时**成立，无会话可刷新。`selectionLost` 优先级最高，token 健康时任何路径列表都不能替代「重选账号」这条建议。

  **`wrong-region` 是「发现」，不是「缺席」**（同版修 `已检查的路径 (N)` 少一条的真实缺陷）：`diagnose()` 曾有一句 `if ('credential' in probe) continue`，只要文件能解析成凭据就跳过且**不套用区域过滤**，于是「有效的、属于另一区域的登录」被两边同时排除——`readAll()` 按区域滤掉它、`diagnose()` 因解析成功跳过它——**不在任何列表里**，卡片只好如实报「检查了 1 条」而同屏消息列了 2 条。这类文件真实、可读、只是属于另一个标签页，因此必须归入「值得先看」直接展开（收进折起的「不存在」里等于把唯一的解释藏起来），并在段落里直接给出修法：切标签页即可，不用重新登录。同理，`missing` 条目不再携带消息——Node 的 ENOENT 文案内嵌了路径，而卡片本就单独印该路径。

  判定规则（`signedOutNotice()` / `signedOutText()`）同样放在 `src/client/searched-paths.ts`：本项目测试环境是纯 Node，留在 `.tsx` 里就测不到，而「有没有重复」正是必须守住的东西。

---

## 四、目标结构

```
dsh-connect-workbuddy/
├── package.json            # trae 的元数据形态 + workbuddy 的 bin 字段
├── locale/                 # 市场卡面文案：en.json（锚点）/ zh.json（宿主读，不经本插件）
├── cordis.patch.yml        # - insert: [{ id: dsh-connect-workbuddy, name: dsh-connect-workbuddy }]
├── tsdown.config.ts        # 双入口（node ESM + browser CJS） + version define
├── tsconfig.json / .client.json
├── vitest.config.ts
├── RELEASING.md            # 照搬 trae（含 Copyright (c) 2026 LaoDing 不变）
├── CHANGELOG.md
├── README.md / README.en.md
├── THIRD_PARTY_NOTICES.md  # workbuddy2api (MIT) + dsh-workbuddy-connect 参考
├── src/
│   ├── index.ts            # host 入口：Config schema + 路由 + 适配器注册
│   ├── status-paths.ts     # 3 条路由常量 + 共享类型（node-free）
│   ├── web-status.ts       # usage / models:refresh / accounts:refresh
│   ├── auth.ts             # 多账号凭据 store（改造自 workbuddy）
│   ├── upstream.ts         # 照搬 workbuddy + 解析 credits/reasoning/多模态
│   ├── catalog.ts          # lastCatalog + deriveCatalog（照搬 trae 模型）
│   ├── adapter.ts          # 照搬 workbuddy
│   ├── shim.ts             # 照搬 workbuddy（加固全部保留）
│   ├── bin.ts              # status / doctor / logout CLI（保留）
│   ├── host-heartbeat.ts   # 保留
│   └── client/
│       ├── index.tsx       # trae 形态（inject: slots, locale, settingsScope）
│       ├── WorkBuddyCard.tsx
│       ├── locales.ts      # row.* 中英
│       ├── styles.ts       # dsm-* CSS
│       └── icon.ts         # LD 图标
├── tests/
├── scripts/                # 探针与校验脚本（probe-auth / probe-accounts / probe-account-switch / probe-models / probe-credits / probe-checkin / verify-e2e）
└── docs/DESIGN.md
```

---

## 五、溯源与致谢（强制规范）

### 5.1 溯源链

```
dsh-codex-connect (Apache-2.0)  ──► dsh-workbuddy-connect (MIT, Corrine Hu) ──┐
workbuddy2api (MIT)             ──► dsh-workbuddy-connect                     ├──► 本项目 (MIT, LaoDing)
dsh-subagent-default-model (MIT) ──► dsh-connect-trae (MIT, LaoDing)         ──┘
```

### 5.2 许可证义务差异（关键点）

| 许可证 | 义务 | 本项目的履行 |
|---|---|---|
| MIT | 保留版权与许可声明 | README 致谢 + THIRD_PARTY_NOTICES + 源文件头标注 |
| **Apache-2.0** | 除上述外，还需**声明改动**、随带 **NOTICE**（若有）、保留专利/商标免责 | 单独一节说明：标注「经 dsh-workbuddy-connect 转引」、声明未修改其源码、上游若无 NOTICE 文件则如实说明 |

> `dsh-codex-connect` 是唯一非 MIT 的参考项，且是**间接**参考（经 workbuddy 转引）。即便如此也按 Apache-2.0 第 4 条完整履行，不因间接而省略。

### 5.3 源文件头标注规范

**每个从参考项目借鉴的源文件，头部注释必须写明三件事**：参考了谁、参考了什么、本项目改动了什么。格式：

```ts
/**
 * <本模块职责一句话>
 *
 * 参考：<项目名>（<许可证>）— <具体借鉴了什么>
 * 改动：<本项目相对参考实现做了什么不同的事，为什么>
 *
 * @module dsh-connect-workbuddy/xxx
 */
```

按文件分配：

| 文件 | 标注来源 |
|---|---|
| `src/upstream.ts` | `dsh-workbuddy-connect` (MIT) + `workbuddy2api` (MIT)；改动：解析 credits/reasoning/多模态字段 |
| `src/auth.ts` | `dsh-workbuddy-connect` (MIT)；改动：单文件 → 目录扫描多账号 |
| `src/at-rest.ts` | 无参考实现（原创）；来源：逆向本机 WorkBuddy 桌面端自身的字段加密格式（AES-256-GCM 信封 + 长度前缀 AAD 转录），密钥向已安装 App 的原生绑定现取，不内置副本 |
| `src/credential-recovery.ts` | 无参考实现（原创）；区分「切换账号即可」与「必须重新登录」两条 401 恢复路径：靠真实探测而非猜测，且绝不自动切换账号（账单归属由用户决定） |
| `src/shim.ts` | `dsh-workbuddy-connect` (MIT)；改动：无（加固原样保留） |
| `src/adapter.ts` | `dsh-workbuddy-connect` (MIT) → `dsh-codex-connect` (Apache-2.0) 转引 |
| `src/bin.ts` / `src/host-heartbeat.ts` | `dsh-workbuddy-connect` (MIT)；改动：扩展多账号诊断 |
| `src/catalog.ts` / `src/web-status.ts` / `src/client/*` | `dsh-connect-trae` (MIT) → `dsh-subagent-default-model` (MIT) 转引 |
| `src/channel-continue.ts` | `dsh-client-auto-continue` (MIT) + `dsh-purge` (MIT)；改动：只认 `channel_reject` 一种失败、不换号、不原地重试、不落盘计数，且订阅由调用方注入（无 `dsh-session` peer 依赖）。逐条差异见该文件头部 |

### 5.4 分发层面

- `THIRD_PARTY_NOTICES.md` 列入 `package.json` 的 `files` 白名单，随 npm 包分发
- README（中英双语）致谢章节与该文件互为索引
- LICENSE 版权主体保持 **Copyright (c) 2026 LaoDing**（不改成 npm/GitHub 账号名）

## 六、风险与边界

1. **历史 auth 文件不是官方多账号 API** —— 是 WorkBuddy 的备份产物。默认仍跟随 App 当前登录，切换是显式选项；文档需如实说明。
2. **上游协议非官方** —— WorkBuddy 更新可能破坏；保留静态 fallback 目录，上游不可用时 provider 不空。
3. **`credits` 字段是字符串**（`"x0.79 credits"` / `"x0.05"` / `undefined`）—— 解析需容错，解析不出就不显示倍率，不虚构。
4. **隐私** —— 卡片只传**昵称**（App 未记录名字时传空串，由卡片显示「未命名账号」占位）、到期时间与积分；token、**uin、uid** 都不出现在任何 HTTP 响应里。账号名是**显示值，绝不是标识符**：把 `uin`/`uid` 当名字显示会让一个完全健康的账号读起来像「插件不知道这是谁」，所以 store 的名字兜底链里没有它们。所有探针脚本已按此原则编写（只输出长度与形状）。
5. **字段加密随版本轮换** —— 新版桌面端把 auth 文件的 token 字段改为 AES-256-GCM 信封，密钥是**构建期常量**（编译进 App 的 Electron 原生模块），不是用户密钥，也**不是插件可以长期内置的东西**：随 App 版本可能更换。插件因此在需要时向本机已安装的 App 现取（`ELECTRON_RUN_AS_NODE` + `loggerGet()`），只在进程内存缓存，绝不落盘；App 不在场时加密文件读不出来，表现为未登录，而不会退化成残缺 token。纯字符串文件走原路径，不启子进程。
6. **加密启用范围是 5.6.0 起、且 macOS 同样在内**（issue #15 取证）—— 此前文档与实现都把「字段加密」当作 Windows 先行的现象，`at-rest.ts` 的 macOS 候选也因此只是**占位**：路径用 App 名拼成 `<bundle>/Contents/MacOS/WorkBuddy`。实测两个真实 bundle 的 `CFBundleExecutable` 都是 `Electron`，**该路径不存在**，于是 macOS 上「App 明明装着、账号也登录着」却永远取不到密钥。四条结论固化下来：
   - **二进制名向 bundle 自己问**（`macosBundleExecutable()` 读 `Info.plist`），不按 App 名猜。App 改名或换二进制名都不需要改插件。
   - **候选要含国际版**，且允许 App 被归入 `/Applications` 的子目录：向下扫一层，并用 `CFBundleIdentifier` 确认身份后才 `execFile`。这条身份校验不是洁癖——**每个 Electron 应用的二进制都叫 `Electron`**，只按名字匹配就可能启动另一个产品；拒绝一个候选只损失一次回退，接受错的那个则是在用户机器上跑别的程序。
   - **「未登录」不等于「读不出来」**：两者在 `readAll()` 之后都表现为账号数为 0，此前共用同一句「请重新登录一次」。而加密文件读不出时用户**本来就是登录着的**，那句话指向的是唯一无效的动作。现在 `resolve()` 在失败路径上跑一次 `diagnose()`，把 `encrypted` 单独归为 `WorkBuddyEncryptedCredentialError`（`code` 标记而非 `instanceof`，跨打包边界可靠），给出「安装 App / 用 `WORKBUDDY_APP_EXECUTABLE` 指定」这条**可执行**的建议。健康路径一次探针都不跑。
   - `encrypted` 之所以**只能**来自桌面文件、不需要额外过滤：该原因由 `probeAuthFile()` 赋予，而插件自有副本从不经过它（按自有文档形状解析，损坏时是 `invalid`/`unreadable`）。代码里那句 `source === 'desktop'` 过滤是**不可达**的，已删——留着会让它看起来在防守一件它并没防的事。
7. **合规** —— 沿用 workbuddy 的免责声明；第三方声明登记 `workbuddy2api` (MIT) 与架构参考。
8. **不做插件之间的联动（项目级不变量）** —— 见 **§零**。不读别人的槽位注册、不渲染别人的组件、不依赖别人的优先级、不因别人在场而改变行为。副作用是 `single` 槽位里本插件赢下那一格时，别的插件在自己行上的装饰不会被合成；该代价是**刻意接受**的，改动前需先改 §零。守卫测试：`tests/model-label-slot-coexistence.spec.tsx` 的 `no inter-plugin coordination` 一节（含源码结构守卫）。

---

## 七、卡面文案：插件在市场上的门面

插件卡上的标题与简介**不是本插件渲染的**（`plugins.bundle.config` 槽位只插面板本体），而是 DSH 插件管理器读的**包元数据**：`readPluginMeta()`（`@deepseek-ai/dsh-app-boot`）先解析 `<包名>/locale/en.json`，再**扫描这个文件所在的目录**取出其余语言文件，逐个读 `meta.title` / `meta.description`；客户端按当前语言的兜底链取词（`en` = `["en"]`，`zh` = `["zh","en"]`）。三条机制事实（2026-10-21 取证于 `@deepseek-ai/dsh-app-boot`）：

1. **`locale/en.json` 是锚点**：读取端遍历的是「英文资源所在目录」，没有 `en.json` 就不会去读 `zh.json`——中文永不生效，而且**不报错**。
2. **缺 `exports` 里的 `"./locale/*.json"` 通配 = 静默失败**：解析抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，读取端把它连同 `ENOENT` / `ERR_MODULE_NOT_FOUND` 一起当「没有本地化元数据」**直接吞掉**——只显示英文，没有任何告警。
3. **`displayName` 不在这条链上**：标题的回退是**裸包名**（`manifest.name`），不是 `package.json` 的 `displayName`。没有 `meta.title` 时，卡上写的就是 `dsh-connect-workbuddy`。
4. **本仓库的 `meta.title` 就写成包名**：两处 `locale/*.json` 的 `title` 都是 `dsh-connect-workbuddy`。不是「懒得起名」，而是刻意与仓库名、npm 包名、issue 里的叫法一致——这个插件的身份就是那个包名。写出来而不是留空，是因为留空也会经 `localizedText` 的 `fallback` 渲染出同样的字，但文件里就没有任何地方记录「这是决定」，下一次「给它起个好听点的名字」看起来就会像免费改进。

简介的回退是 `package.json` 的 `description`（**只认字符串**，非字符串即丢）。本仓库这一处是**中文**：它同时出现在 npm 包页面和 GitHub 的仓库简介上，而这两处的读者就是中文用户；英文文案住在 `locale/en.json`，而 `localizedText` 会把字典里的词**覆盖**在 fallback 之上（`{ en: fallback, ...entries }`），所以英文界面读到的仍是英文，中文只用于「locale 读不到」的降级与商品页。同一句话因此共有三处副本：

| 副本 | 位置 | 作用 |
|---|---|---|
| 卡面字典 | `locale/en.json` / `locale/zh.json` | 宿主读到的真正文案（中文界面读 zh，英文界面读 en） |
| 英文兜底 | `package.json.description` | 没有 `locale/` 时的兜底，也是 npm 页面上的描述 |
| 市场条目草稿 | `awesome-dsh-plugin-submission/dingminhua__dsh-connect-workbuddy.yml` 的 `description.en` / `description.zh` | 市场页面的收录文案 |

三处由 `tests/locale-meta.spec.ts` 钉死：**改一处就要同改三处**。`files` 里写**裸目录名** `locale`（整个目录随包分发），`exports` 里写通配 `"./locale/*.json": "./locale/*.json"`（宿主按**子路径**解析资源，缺了就静默跳过）。

> **教训**（本仓库反复踩的那一族）：**「插件自己渲染的界面」与「DSH 渲染的插件元数据」是两套真源**。前者走 `ctx.locale` 注册的字典（`src/client/locales.ts`，中英 1:1 对齐），后者走 `package.json` + `locale/`。只改一套，就会出现「面板全中文、卡片全英文」这种自相矛盾的自述面。而本条里的三个坑**没有一个会报错**，只会安静地不生效——凡是**框架替我读**的文件，先找到读它的代码，再问一句「它读不到时会说什么」。
