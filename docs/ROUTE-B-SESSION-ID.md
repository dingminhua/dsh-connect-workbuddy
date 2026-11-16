# 路线 B：从宿主会话 ID 派生上游会话亲和键（实验性，默认关闭）

> 本文是**设计与语义**说明，不是收益结论。本 PR 不附带任何命中率实测数字，
> 不声称改善缓存，也不区分上游内部机制（缓存键分区 / 路由亲和 / 其它）。

## 1. 它解决什么，不解决什么

路线 A（`stableConversationId`，见 [`STABLE-KEY-SEMANTICS.md`](STABLE-KEY-SEMANTICS.md)）
把 `X-Conversation-ID` 固定为**请求前缀**派生的亲和键。它的已知限制是：压缩、
首问变化、换模型、对话分叉都会改变前缀，从而换键——它并不是宿主真正的会话标识。

路线 B 用**宿主会话 ID**代替请求前缀作为亲和键的来源，因此上面的变化不再换键。
它要证明的只是一个可检验的命题：**当上游把同一个 `X-Conversation-ID` 视作同一
会话时，稳定它是否与更高命中相关。** 本文与实现都不对"上游究竟如何分区缓存"
作任何断言（`MECHANISM_PROVEN = false`）。

路线 B 与路线 A **相互独立**，默认都关闭。两者同时打开时，路线 B 优先。

## 2. 会话 ID 如何到达上游（且真值不外发）

宿主在每次生成的 `GenerateOptions` 上带一个 `sessionId`。链路：

1. `dsh-llm-pi-ai` 把 `options.sessionId` 转成字符串传给 pi-ai 的 `streamSimple`。
2. pi-ai 的 `buildBaseOptions` 把 `sessionId` 转发给 `stream`。
3. 本插件在模型描述的 `compat` 上声明
   `sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openai'`，
   pi-ai 的 `createClient` 因此在该请求上 stamp 三个 loopback 头：
   `session_id`、`x-client-request-id`、`x-session-affinity`（值都是 sessionId）。
4. loopback shim 已强制Bearer + 本机回环校验；它在 `chatCompletions` 入口读
   `x-session-affinity`，**只在开关打开时**读，并做限长（≤256）与空值校验。
5. shim 把该值经 `conversationIdFromSessionId()` 做**带域隔离的确定性 SHA-256**
   （scheme `dsh-session-conversation-id/v1`，与路线 A 的 scheme 不同，避免两路
   共享亲和桶），映射成 v4 形状的 ID，作为**每请求一次**的局部变量。
6. 该局部 ID 沿全部 `chatStream` 调用链传递——主路、渠道校验拒绝后的
   救援阶梯、账号 failover——所以同一逻辑请求的每次重试都用同一个 ID。
7. `chatStream` 收到该 ID 后，用它覆盖 `X-Conversation-ID`；**真实 sessionId
   从不离开进程**，不做日志，只以摘要形式出现在出站头里。

关闭开关时：模型描述不带那两个 compat 键（pi-ai 的 detected 默认仍是
`sendSessionAffinityHeaders: false`），shim 不读头，`chatStream` 收到
`undefined`——三次参数调用形态与默认字节**完全不变**。

## 3. 开关与生效时机

配置项 `sessionConversationId: boolean`，默认 `false`。

- shim 与 adapter 都用 **live getter**（每次请求读当前 volatile 配置），
  因此卡片切换后下一次请求就生效，**不需要重载插件**——这是与路线 A（挂载时
  采样一次）的有意区别。
- 与 `stableConversationId` 独立；两者都开时路线 B 优先。

## 4. 已知限制与信任边界

- **共享 secret 不是来源证明。** shim 的 Bearer 只证明调用方持有进程内密钥，
  不独立证明头确实来自宿主。若要严格防伪造，需宿主对头做签名/绑定。
- **头一旦被中间人改写，摘要随之改变。** 所以只接受 loopback + Bearer 的请求，
  并对值做长度/空值约束；不把它当作鉴权凭证。
- **会话 ID 是敏感值。** 只在进程内以明文存在，出站只发域隔离摘要；任何日志、
  错误信息、测试固件都不得出现真值。
- **并发不串。** 摘要是每请求的局部变量，无共享可变状态，不依赖
  `AsyncLocalStorage`（它无法跨 loopback）。
- **不同会话不会复用同一键。** 摘要对 sessionId 是确定性的；相同 sessionId
  跨进程也得到相同键（这是有意的稳定），域隔离只防止与路线 A 的键碰撞。
- **本 PR 不改变默认值、不发版、不请求合并后默认打开。** 是否把它作为默认
  能力属于维护者与 GA 验收的决定。

## 5. 术语

| 概念 | 路线 A | 路线 B |
| --- | --- | --- |
| `X-Conversation-ID` 来源 | 请求前缀派生哈希 | 宿主 sessionId 派生哈希（域隔离） |
| 换键条件 | 压缩 / 首问 / 换模型 / 分叉 | 换会话 |
| 稳定性 | 挂载时采样配置 | 每请求 live getter |
| 真值外发 | 无（只有前缀摘要） | 无（只有 sessionId 摘要） |
| 默认 | 关 | 关 |
