# issue #189 回复草稿（可直接粘贴到 GitHub）

> 取证方法与逐条读数见文末。本机 macOS 26.6.1 / arm64，插件 5.17.0（测试时版本号，代码与 5.18.0 相同），
> 打的是**活的** CN 网关（`www.workbuddy.cn`），账号 `1XX****XXXX`，
> 模型 `hy3`（x0.00，免费，不烧积分）。

---

感谢反馈，`dsh-auto-memory.json` 那段配置和三条被拦的开头很有用。我按你给的开头在
真实网关上做了一组对照，结论和你推测的方向部分一致、但**根因不是"套话不在名单里"**，
这一点得先纠正，否则照着改名单是改不好的。

## 一、先确认现象：能复现

把 DSH 自己的 system prompt 形状（`You are an AI agent powered by DeepSeek Harness.`
\+ 运行上下文里那段 `Tokens prefixed with @ …` 的段落）配上子智能体的套话，直接发给
网关：

| 请求体 | 结果 |
|---|---|
| 原样发（不经过插件救援） | **400 / `channel_reject` / code 11128** |
| 经过 5.12.1 的 `prepareChatBody` | **400 / `channel_reject`** ← 和你看到的一样 |
| 经过当前 main（5.18.0）的 `prepareChatBody` | **200 ok** |

两种形状都复现了：套话在 `system` 里，和套话在 `assistant` 历史里。

## 二、根因：是「DSH 身份那句话」，不是「子智能体那三句」

我把你贴的三条开头**逐条单独**放进 `system` 发了一次（其余内容保持最小）：

| 消息开头 | 原样发 |
|---|---|
| `You are an AI agent powered by DeepSeek Harness.` | **400 / channel_reject** |
| `This is a message from a subagent.` | 200 ok |
| `The background subagent finished.` | 200 ok |

也就是说：**网关匹配的是 DSH 身份那一句**，它是一段**任意位置出现的子串匹配**，
不是消息开头的前缀匹配。子智能体的 system prompt 继承的是同一个宿主提示词，
所以一样带着这句 —— 被拦的是这一句，不是"来自子智能体"的那几句。

这有个直接后果：把 `This is a message from a subagent…` 加进"已知指纹名单"是**无效**的
（它本来就不在名单里也没被拦），而成天变的那句身份话术才是要处理的。

顺带把我测到的角色边界也列一下，免得以后重复试：

| 那句身份话放在哪 | 原样发 |
|---|---|
| `system` / `assistant`（字符串或 parts 数组） | **400** |
| `tool` 消息里 | 200 ok |
| `user` 消息里 | 200 ok |

`tool` 和 `user` 不扫 —— 与插件 `scansOpening()` 的实测结论一致。

## 三、为什么 5.12.1 不行、现在行

用你环境里的**完整形状**（身份句 + 中段的 `Tokens prefixed with @ …` 段落 + 子智能体套话）
逐个等级打了一遍：

| 救援等级 | 同一份 body 的结果 |
|---|---|
| 原样 | 400 / `channel_reject` |
| `forceNeutralHead`（开头插中性头） | **400 / `channel_reject`** |
| 零宽扰动 | 400 / `channel_reject` |
| 密集零宽扰动 | 400 / `channel_reject` |
| `prepareChatBody`（5.12.1） | **400 / `channel_reject`** |
| `prepareChatBody`（5.18.0） | **200 ok** |

原因很清楚：中性头只能把**开头**那句话挪走，而中段那段 `@`-路径段落是**子串**，
挪开头对它无效；零宽扰动又已经被网关归一化掉了（README 记的 2026-10-29 实测）。
5.13.1 起插件改成**在发出前按句改写**这几段固定指纹，5.14.0 补了 Web GUI 段落的第二句 ——
那之后这类请求才真的能过。

这也解释了为什么"换账号、换区域、换模型都没用"（你贴的报错自己也这么写）：
被拒的是请求的字节，不是凭据。

所以**升级是对的，改名单是不对的**。README §平台支持里那句
「国内区的渠道校验 400 请确保插件 ≥ 5.14.0」针对的就是这个。

> 反过来说，如果**只**有那三句「来自子智能体」的套话而没有 DSH 身份句，5.12.1 也能过 ——
> 我单独测过，那两句原样发就是 200。所以这一条不是"名单缺条目"，这一点请别照第一版推测改。

## 四、你的另一条建议（让后台评估换 provider）也成立，但不必等

`workbuddy` 只是默认 provider。把自动记忆的评估/写日志改成别的 provider（或用
`dsh-subagent-default-model` 把子智能体钉到别家）就能彻底绕开这道校验，与插件版本无关。
不过升级到 ≥ 5.14.0 之后，这条就不需要了。

## 五、需要你确认的

1. 升级到最新（现在是 5.18.0）后再跑一轮 `autoConsolidate`，看还出不出现 11128。
2. 如果还出，把**这一轮**的报错原文贴给我 —— 特别是里面的 `requestId`。同一句
   11128 底下其实是四个不同的门（prompt / conversation-id / first-message / 未知），
   插件的回复会按门给不同建议，`requestId` 能让我定位是哪一道。

---

## 取证方法（供复核）

全部读数来自一次性的真实调用，模型选 `hy3`（倍率 0.00），没有花积分：

- 直接构造 OpenAI chat-completions body，用 `WorkBuddyUpstreamClient.chatStream`
  打到 `www.workbuddy.cn`，记录 `ok` / `status` / `kind`。
- 同一份 body 分别过 `prepareOld`（从 `v5.12.1` 标签的 worktree 导入）与
  `prepareNow`（工作树 5.18.0），三次请求对照。
- 回归侧：`npx vitest run tests/issue189-subagent-channel-gate.spec.ts`（7 例全绿），
  以及在真实 GUI 里跑了一轮带子智能体的对话（`workbuddy-global` / `hy3`，13s 完成，
  会话日志里 `11128` 出现 0 次）。

**没做到的**：没有把 `@a9i5k4/dsh-auto-memory` 真的装起来跑它的后台子智能体
（它的 `onnxruntime-node` / `sharp` 在本机的一次性 profile 里被 pnpm 拦了构建脚本）。
复现的是**请求体形状**，不是那个插件的运行时。形状一致，且同一形状在真实网关上
可分辨地复现了 400 → 200,所以结论成立;如果要做成"端到端"，需要一个能装它的环境。
