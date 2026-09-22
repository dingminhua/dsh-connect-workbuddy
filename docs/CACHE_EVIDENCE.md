# workbuddy 缓存取证：对照 trae issue #10

> 对照：https://github.com/dingminhua/dsh-connect-trae/issues/10
> （「我测试了一下一直0缓存」「不知道接口原因还是 trae 上有不反悔缓存」）
>
> 日期：2026-09-22 · 取证时版本：2.0.4
> （复核于 2.0.5：该版本只改账号选择的语义与写入校验，`src/adapter.ts` /
> `src/shim.ts` / `src/upstream.ts` **零改动**，本结论不受影响。）

## 结论

**workbuddy 没有 trae #10 那个 bug，也无需修。上游用的是 pi-ai 认得的规范拼写，缓存数据能原样到达 DSH。**

| 环节 | trae | workbuddy |
| --- | --- | --- |
| 上游是否报缓存 | ✅ 实测命中 9216 | ✅ 实测命中 7936 |
| 插件是否重编码 SSE | ✅ 有解码层（`sse.ts` + `solo-bridge.ts`） | ❌ 无，字节直通（`shim.ts` 的 `body.pipe(res)`） |
| 字段是否被丢 | ❌ 曾丢 → 2.0.5 修 | ✅ 不可能丢 |
| 上游字段名 | `cache_read_input_tokens`（pi-ai 不认） | `prompt_tokens_details.cached_tokens`（pi-ai 认） |
| 是否需要翻译层 | ✅ 需要，已补 | ❌ 不需要 |

**架构差异决定了这个结果**：trae 的 bug 出在「自己把上游事件重编码成 OpenAI 格式」这一步，
workbuddy 根本没有这一步——shim 只做鉴权与 body 规范化，SSE 回包原样 pipe 给 pi-ai。
没有翻译层，就不存在「翻译时丢字段」。

## 证据

### 1. 上游确实在报缓存，且字段名是 pi-ai 认得的

用插件自己的请求路径（`prepareChatBody` + `store.resolve()` + `chatStream`）连发三次，
第一次只发前缀（预热），后两次发**逐字节相同**的前缀+后缀（约 8008 tokens）：

```
=== turn 1: PREFIX only (warms cache) ===
  pi-ai would report: input=8002 cacheRead=0    cacheWrite=0 output=16
=== turn 2: PREFIX + SUFFIX (identical #2) ===
  pi-ai would report: input=136  cacheRead=7872 cacheWrite=0 output=16
=== turn 3: PREFIX + SUFFIX (identical #3) ===
  pi-ai would report: input=72   cacheRead=7936 cacheWrite=0 output=16
```

turn 3 上游 usage 原文（真实捕获）：

```json
{"prompt_tokens":8008,"completion_tokens":16,"total_tokens":8024,
 "prompt_tokens_details":{"cached_tokens":7936,...},
 "prompt_cache_hit_tokens":7936,"prompt_cache_miss_tokens":72,
 "cache_read_input_tokens":0,"cache_creation_input_tokens":0,...}
```

关键：`prompt_tokens_details.cached_tokens` 正是 pi-ai `parseChunkUsage`
第一个分支读的拼写（`?? prompt_cache_hit_tokens ?? cached_tokens`），
且上游**同时**给出 `prompt_cache_hit_tokens: 7936` 作为第二顺位兜底。命中率 7936/8008 ≈ 99%。

**该判断的源码依据**（`scripts/probe-cache-convention.mjs` 里的 `simulatePiAi()`
是**自己重实现**的规则，不调用 pi-ai 本体，所以这里记录真实出处以便复核）：

```
@earendil-works/pi-ai/dist/api/openai-completions.js:1179-1195
  const promptTokens = rawUsage.prompt_tokens || 0;                    // 1179
  const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens
    ?? rawUsage.prompt_cache_hit_tokens ?? rawUsage.cached_tokens ?? 0; // 1180
  const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0; // 1181
  const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);      // 1193
  const outputTokens = rawUsage.completion_tokens || 0;                // 1195
```

逐项对齐：`??` 链的三个拼写、`cacheWrite` 只读 `prompt_tokens_details.cache_write_tokens`、
`Math.max(0, prompt - read - write)`，以及 `totalTokens = input + output + cacheRead + cacheWrite`
（真实实现见同文件 1202 行）——与 `simulatePiAi()` 一致。唯一措辞差异是脚本用
`?? 0`、真实实现用 `|| 0`；只有当上游把某字段发成 `null`/`false`/`0` 时二者才分叉，
而本次抓到的 usage 里这些均为数字，故结论不受影响。
（注意上游 `cache_read_input_tokens` / `cache_creation_input_tokens` 为 0 也不影响：
pi-ai **根本不读**这两个 Anthropic 拼写。）

上报侧另有一处闸门：`@deepseek-ai/dsh-llm-pi-ai` 只在**非零**时才转发缓存字段
（`lib/index.js:1362`，`...usage.cacheRead > 0 ? { cacheReadTokens } : {}`）——
这解释了为什么「上游报了缓存」不等于「DSH 里一定看得到非零值」。

### 2. 账目守恒：OpenAI 口径，不会重复扣减

pi-ai 的算法是 `input = prompt_tokens - cacheRead - cacheWrite`，
只有在上游 `prompt_tokens` **包含**缓存量时才正确。实测：

```
hit + miss : 7936+72=8008, 7936+72=8008   vs prompt 8008   → MATCHES
```

即 `cache_hit + cache_miss == prompt_tokens` 恒成立，缓存是 `prompt_tokens` 的**子集**
（OpenAI 口径）。pi-ai 算出的 `input=72` 就是真实未缓存部分，不重复扣减。

### 3. 两个曾被怀疑的环节，均已排除

- **`stream_options`**：上游只在收到 `stream_options:{include_usage:true}` 时才把 usage
  放进流末（否则 `prompt_tokens_details` 根本不会出现）。这条链有四个环节，逐一定位：

  1. pi-ai **默认下发**：`openai-completions.js:594-595`
     `if (compat.supportsUsageInStreaming !== false) { params.stream_options = { include_usage: true } }`；
  2. 该 compat 的默认值为 `true`：同文件 `1281` 行 `supportsUsageInStreaming: true`，
     并经 `1331` 行 `model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming` 回退；
  3. 插件**没有关掉它**：`src/adapter.ts:170` 只设 `compat: { supportsReasoningEffort: … }`，
     未触及 `supportsUsageInStreaming`，故默认值生效；
  4. `prepareChatBody` **不碰** `stream_options`：它只改 `stream`（强制 true）、
     `messages[].role`（`developer`→`system`）与 `tool_choice`（见 `src/upstream.ts:308-331`），
     既不增删也不重写该字段，字段原样到达上游。

  历史上「看不到 usage」的观感来自 `verify-e2e.mjs:69` 的 `.slice(0, 6)` ——
  它只打印前 6 个 SSE 事件，而 usage 在**最后一个** chunk。

- **`NO_COST`**（`src/adapter.ts:93`，喂给 `model.cost`）：只影响**费用**计算
  （`cost` 全 0 → 费用显示 0），`cacheRead` 的 token 计数是独立字段、照常上报，
  与「0 缓存」无关。

## 复现

```bash
node scripts/probe-cache-convention.mjs            # 默认 3 轮
node scripts/probe-cache-convention.mjs --turns 4  # 结论不明时加轮数
node scripts/probe-cache-convention.mjs --no-stream-options   # 排查 body 被拒
```

脚本只打印 usage 计数器与字段名，不打印消息内容与凭证；**会消耗少量积分**（N 次短补全）。

判据（与 trae 一致，不要看单轮是否为 0）：

- **看 `prompt_tokens` 是否恒定 + 缓存字段是否非零**。新前缀第一轮必然冷启动（实测 turn 1 的 `cacheRead=0`）；
- 缓存**跨进程、跨会话存活**（服务端侧），所以重跑时 turn 1 可能直接命中。

## 需要说清楚的一点

上游报了缓存 ≠ 每次都能看到非零。

- 前缀要**逐字节一致**才能复用。正常多轮对话（历史往后追加新消息）满足；改系统提示词、切模型、大幅编辑历史都会让前缀失效。
- 实测 `cache_creation_input_tokens` 与 `prompt_cache_write_tokens` **恒为 0**，
  即 workbuddy 目前**只报读、不报写**——与 trae 表现一致。所以 DSH 的「缓存写入」一栏恒 0 属于正常。
- 本次取证的账号是 `www.workbuddy.cn`（CN 区）。国际区（`workbuddy.ai` / `codebuddy.ai`）
  尚未取证，如需确认可用 `--region global` 重跑。
