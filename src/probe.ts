/**
 * The minimal-request model probe: what it sends, what an answer means, and
 * what (if anything) can honestly be said about a cooldown.
 *
 * 参考：本仓库 `src/upstream.ts` 的错误分类（`classifyUpstreamError` 的中英文额度
 *   标记、`soft_rate` / `hard_credit` 两态）被直接复用，不另起一套判定。
 * 改动：把「一次最小请求」的构造与解读单独成模块，因为卡片和 Host 路由两边
 *   都要用它，而这些规则必须能被单元测试直接钉住 —— 它们包含两个**实测得到、
 *   猜不出来**的结论：
 *
 *   1. **首条消息必须是 system。** 国际网关（`www.workbuddy.ai`）对
 *      `[{role:'user'}]` 一律返回 HTTP 400 / 业务码 11128
 *      (`first message is not system prompt`)。按国内版那样只发一条 user 消息
 *      去探测，会把**整个国际版误报成全部不可用**。所以探测请求总是带一条
 *      system 消息，两个网关都接受。
 *   2. **上游把限流恢复时间写在响应体里，不在响应头里。** 实测 200 响应头里没有
 *      `Retry-After`，也没有 `X-RateLimit-*`；但**被限流的 429 响应体里明确写着**
 *      `{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-30 02:30:30
 *      UTC+8 重置，…"}`。只看响应头就会得出「上游不给数据」的错误结论，卡片于是
 *      显示「上游未给出何时恢复」，而时间其实就在眼前。因此
 *      {@link parseUpstreamResetAt} 从响应体解析，{@link cooldownOf} 只在三处都
 *      没有时才如实返回「上游未给出」—— 绝不编造倒计时。
 *
 * @module dsh-connect-workbuddy/probe
 */

import type { WorkBuddyCredential } from './auth.ts'
import { classifyUpstreamError } from './upstream.ts'

/**
 * The system message every probe carries.
 *
 * Not decoration: the international gateway rejects a conversation that does not
 * start with a system message (see the module note). A probe that omitted it
 * would report every global model as broken.
 */
export const PROBE_SYSTEM_PROMPT = 'You are a connectivity check. Reply with a single word.'

/** The one-word user turn; the smallest thing a chat endpoint accepts. */
export const PROBE_USER_PROMPT = 'ping'

/**
 * Output cap for a probe. One token is enough to prove the model answers, and
 * keeps the cost negligible: live measurements of `max_tokens: 1` probes
 * reported `credit` between 0 and 0.01, and one such probe left the credit
 * balance unchanged (933 → 933). For scale, a model on that roster bills 0.79+
 * per real reply. The point of the feature is to learn whether a model works
 * while spending as close to nothing as the service allows.
 */
export const PROBE_MAX_TOKENS = 1

/**
 * Build the request body for one probe.
 *
 * `stream` is forced because the upstream rejects non-streaming chat requests;
 * `prepareChatBody` enforces that too, but sending it explicitly keeps this
 * function's output valid on its own.
 */
export function probeRequestBody(modelId: string): string {
  return JSON.stringify({
    model: modelId,
    messages: [
      { role: 'system', content: PROBE_SYSTEM_PROMPT },
      { role: 'user', content: PROBE_USER_PROMPT },
    ],
    max_tokens: PROBE_MAX_TOKENS,
    stream: true,
  })
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 真实体积测试（heavy probe）——**临时诊断，可整体删除**
 *
 * 为什么需要它：上游的限流（业务码 6004）**按请求体积触发**，而普通探针只发
 * `max_tokens: 1` + `ping`（约 38 token），永远够不到那条线。2026-09-29 在真机
 * 上量化（同一账号、同一模型，只改输入体积）：
 *
 *   | 输入 | 上游实际计到的 prompt_tokens | 结果 |
 *   | --- | --- | --- |
 *   | ~10 | 38 | ok |
 *   | ~1,000 | 1,138 | ok |
 *   | ~10,000 | 11,138 | ok |
 *   | ~18,000 | 20,018 | ok |
 *   | ~30,000（干净账号只发这一次） | ~32k | **429 / 6004** |
 *
 * 即：**阈值在 20k 与 30k 之间**，且**单次大请求就足以触发**（不是累计），
 * 每个账号各有自己的重置时间。长会话里的真实请求会越过这条线，而小探针不会
 * ——这正是「测试通过、实际被限」的成因。
 *
 * 因此这个探测**故意发一个 ~25k token 的真实体积请求**，回答「这个模型能不能
 * 承接我的长对话」。已实测（2026-09-29，构建产物直连）：请求体 112,713 B →
 * 上游计到 **prompt_tokens 25,023**，报 credit **0.72**；而最小探针是 192 B /
 * 18 tokens / credit 0。代价高两个数量级，所以它**只对单个模型、只由人手点击**，
 * 绝不进批量。
 *
 * 删除方式：删掉本段与 `heavyProbeRequestBody` 的引用（router / 卡片 / 测试），
 * 其余功能不受影响。
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** 目标输入体积（token）。25k 落在实测阈值（20k 成功 / 30k 失败）之上。 */
export const PROBE_HEAVY_INPUT_TOKENS = 25_000

/**
 * 填充文本的「字符 / token」比，实测得出。
 *
 * 用固定英文句子填充时，上游实测 prompt_tokens 与字符数的比值约 4.5。这里写一个
 * 估算值而不是内嵌真实 tokenizer：只需要「够大」，不需要精确——目标体积离阈值有
 * 足够余量，估算偏差不影响结论。
 */
const HEAVY_CHARS_PER_TOKEN = 4.5

/** 填充用的中性句子；不含任何用户内容，只占体积。 */
const HEAVY_FILLER_LINE = 'The quick brown fox jumps over the lazy dog. '

/**
 * Build the request body for one heavy (real-volume) probe.
 *
 * The OUTPUT stays at {@link PROBE_MAX_TOKENS}: the throttle is triggered by the
 * input, so paying for a large completion would add cost without adding signal.
 */
export function heavyProbeRequestBody(modelId: string): string {
  const targetChars = Math.ceil(PROBE_HEAVY_INPUT_TOKENS * HEAVY_CHARS_PER_TOKEN)
  const filler = HEAVY_FILLER_LINE.repeat(Math.ceil(targetChars / HEAVY_FILLER_LINE.length))
  return JSON.stringify({
    model: modelId,
    messages: [
      { role: 'system', content: PROBE_SYSTEM_PROMPT },
      { role: 'user', content: `${filler}Reply with a single word.` },
    ],
    max_tokens: PROBE_MAX_TOKENS,
    stream: true,
  })
}

/**
 * How one probe ended.
 *
 * `rate-limited` is split out from a generic failure because it is the one
 * outcome the feature exists for: it means "this model works, but not right
 * now". Everything else is a real, actionable failure or a success.
 */
export type WorkBuddyProbeOutcome =
  | 'ok'
  | 'rate-limited'
  | 'out-of-credit'
  | 'credential-rejected'
  | 'unavailable'
  | 'not-found'
  | 'failed'

/**
 * One probe result, as the card renders it.
 *
 * `retryAtMs` is present ONLY when the upstream actually stated a time (a
 * `Retry-After` header, or the region's quota refresh point when the failure is
 * an exhausted quota). Its absence is meaningful and must be rendered as "the
 * upstream did not say", never as a locally invented countdown.
 */
export interface WorkBuddyProbeResult {
  modelId: string
  outcome: WorkBuddyProbeOutcome
  /** Round-trip time in ms, for a successful probe. */
  elapsedMs?: number
  /** HTTP status the upstream answered with; 0 means the request never landed. */
  status?: number
  /** Upstream's own words, redacted. Present on failures. */
  message?: string
  /** A time the upstream named, in ms. Absent when it named none. */
  retryAtMs?: number
  /** Where a supplied `retryAtMs` came from, so the card can say so. */
  retrySource?: 'retry-after' | 'upstream-message' | 'quota-refresh'
}

/**
 * Parse a `Retry-After` header value into an absolute time.
 *
 * Both RFC 9110 forms are accepted: delay-seconds (`120`) and an HTTP-date
 * (`Wed, 21 Oct 2026 07:28:00 GMT`). Returns undefined for anything else,
 * including the negative/zero delays some gateways emit — a "retry now" is not
 * a cooldown and reporting it as one would be worse than saying nothing.
 *
 * `nowMs` is injected so the delay-seconds branch is testable without a clock.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number(trimmed)
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined
    return nowMs + seconds * 1_000
  }
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) return undefined
  // An HTTP-date already in the past is not a cooldown either.
  if (parsed <= nowMs) return undefined
  return parsed
}

/**
 * The upstream's reset sentence, as its Chinese gateway writes it.
 *
 * Measured on a live 429 (code 6004), verbatim:
 *
 *   `您的使用量已超出频率限制，将在 2026-09-30 02:30:30 UTC+8 重置，您也可以切换其他模型继续使用。`
 *
 * The two halves are captured separately because the second one is the whole
 * reason this parser exists: the upstream DOES name a time, and the plugin was
 * showing "the upstream gave no time" while the answer was sitting right there
 * in the body. The earlier note in this module ("the upstream provides no
 * rate-limit metadata") was drawn from the RESPONSE HEADERS alone — true as far
 * as it went, and wrong as a conclusion, because the time is in the body text.
 *
 * Deliberately loose about the surrounding wording (`[\s\S]*?` on both sides)
 * and strict about the parts that must not be guessed: the keyword 重置, the
 * timestamp shape, and an explicit UTC offset. A message that merely mentions
 * 重置 without a parsable offset yields no time, which is the honest answer.
 */
const UPSTREAM_RESET_PATTERN
  = /将在?\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC\s*([+-])(\d{1,2})(?::?(\d{2}))?[\s\S]*?重置/u

/**
 * Parse the reset time out of an upstream failure message.
 *
 * Returns epoch ms, or undefined when the message names no parsable time — the
 * caller must then say "the upstream gave no time", never invent one.
 *
 * THE OFFSET IS HONOURED, NOT ASSUMED. `2026-09-30 02:30:30 UTC+8` is 18:30:30
 * UTC the previous day, and `Date.parse` on the bare string would read it as
 * LOCAL time — on a machine set to UTC+8 that happens to be right, and on any
 * other machine it is silently wrong by the offset. So the components are
 * assembled with `Date.UTC` and the stated offset subtracted, which is correct
 * on every host regardless of its own zone.
 *
 * A whole-second resolution is what the upstream prints; sub-second precision
 * would be fiction in the other direction.
 */
export function parseUpstreamResetAt(message: string): number | undefined {
  const match = UPSTREAM_RESET_PATTERN.exec(message)
  if (match === null) return undefined
  const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = match
  const offsetTotalMinutes
    = (sign === '-' ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes ?? '0'))
  const utcMs = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
  )
  // `Date.UTC` normalizes overflow (month 13, day 32) instead of failing, so a
  // nonsense timestamp would silently become a real-but-wrong moment. Reject it.
  const parsed = new Date(utcMs)
  if (parsed.getUTCFullYear() !== Number(year)
    || parsed.getUTCMonth() !== Number(month) - 1
    || parsed.getUTCDate() !== Number(day)
    || parsed.getUTCHours() !== Number(hour)
    || parsed.getUTCMinutes() !== Number(minute)
    || parsed.getUTCSeconds() !== Number(second)) {
    return undefined
  }
  if (Math.abs(offsetTotalMinutes) > 14 * 60) return undefined
  return utcMs - offsetTotalMinutes * 60_000
}

/**
 * The cooldown the upstream stated, if it stated one.
 *
 * Three sources, in order of authority:
 *
 * 1. `Retry-After` on the failure response. This is the upstream naming a time
 *    for THIS request, so it wins.
 * 2. The reset time the upstream writes into its own failure body (see
 *    {@link parseUpstreamResetAt}). This is the case that actually fires on
 *    this service: a 429 from the Chinese gateway carries code 6004 and a
 *    `将在 … 重置` sentence, with no `Retry-After` header at all.
 * 3. The region's monthly quota refresh point, but ONLY for an out-of-credit
 *    outcome. A quota that resets at a known time is the one case where "when
 *    can I use this again" has a real answer even without a header — and it is
 *    the answer for the most common real limit on this service.
 *
 * A limited outcome with none of the three returns `{}`, which the card renders
 * as "the upstream did not say when". That remains the honest answer for a
 * genuinely timeless failure; inventing a number here would be pure fiction.
 */
export function cooldownOf(input: {
  outcome: WorkBuddyProbeOutcome
  retryAfter: string | null
  nowMs: number
  /** The upstream's own failure text, where a reset sentence may live. */
  body?: string
  /** The region's next monthly quota refresh, when the upstream declares one. */
  quotaRefreshAtMs?: number
}): Pick<WorkBuddyProbeResult, 'retryAtMs' | 'retrySource'> {
  const fromHeader = parseRetryAfter(input.retryAfter, input.nowMs)
  if (fromHeader !== undefined) return { retryAtMs: fromHeader, retrySource: 'retry-after' }
  const fromBody = input.body === undefined ? undefined : parseUpstreamResetAt(input.body)
  if (fromBody !== undefined) return { retryAtMs: fromBody, retrySource: 'upstream-message' }
  if (input.outcome === 'out-of-credit' && input.quotaRefreshAtMs !== undefined) {
    return { retryAtMs: input.quotaRefreshAtMs, retrySource: 'quota-refresh' }
  }
  return {}
}

/**
 * Classify one failed probe into the card's outcome vocabulary.
 *
 * Built on `classifyUpstreamError` rather than re-testing status codes, so a
 * probe and a real chat request can never disagree about what the same upstream
 * answer means. The extra split here is `credential-rejected`, which the
 * upstream signals with a non-JSON 401/403 edge page and which needs completely
 * different advice (re-auth, not "wait").
 */
export function outcomeOfFailure(status: number, body: string): WorkBuddyProbeOutcome {
  if (status === 401 || status === 403) return 'credential-rejected'
  switch (classifyUpstreamError(status, body)) {
    case 'soft_rate': return 'rate-limited'
    case 'hard_credit': return 'out-of-credit'
    case 'session_dead': return 'credential-rejected'
    case 'not_found': return 'not-found'
    default: return status === 0 || status >= 500 ? 'unavailable' : 'failed'
  }
}

/**
 * Read the credit this probe consumed out of an SSE stream, when the upstream
 * reports it.
 *
 * Purely informational — the card shows it so a user can see how little a probe
 * actually costs rather than having to trust a claim. Absent when the stream
 * carried no `usage` block.
 */
export function creditOfStream(text: string): number | undefined {
  const match = /"credit"\s*:\s*(-?[0-9]*\.?[0-9]+)/u.exec(text)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/** Whether a probe outcome means the model answered. */
export function probeSucceeded(outcome: WorkBuddyProbeOutcome): boolean {
  return outcome === 'ok'
}

/** What one probe needs from the upstream client. */
export interface WorkBuddyProbeClient {
  probeChat(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean
    status: number
    retryAfter: string | null
    body?: string
    response?: Response
  }>
}

/** Max characters of upstream text kept for display, after redaction. */
const PROBE_MESSAGE_LIMIT = 300

/**
 * Redact token-shaped content out of upstream text before it is stored or sent.
 *
 * Duplicated from the route layer on purpose rather than imported: this module
 * is the one that reads raw failure bodies, so the redaction belongs at the
 * point of capture. A probe failure body is the one place a raw upstream string
 * from an arbitrary endpoint enters the plugin's data flow.
 */
function redact(text: string): string {
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, PROBE_MESSAGE_LIMIT)
}

/**
 * Run one probe for one model and reduce it to the card's row.
 *
 * The successful path drains the SSE stream purely to read the `credit` figure
 * the upstream reports, then discards the rest: the probe's question is "did
 * this model answer", and `max_tokens: 1` means there is nothing else in the
 * stream worth keeping.
 *
 * Never throws. A probe is a diagnostic the user asked for, so every failure is
 * a RESULT — one dead model must not abort the batch and hide the other rows.
 */
export async function probeModel(input: {
  client: WorkBuddyProbeClient
  credential: WorkBuddyCredential
  modelId: string
  nowMs: number
  /** The region's next monthly quota refresh, when known. */
  quotaRefreshAtMs?: number
  signal?: AbortSignal
  /**
   * Send a real-volume request instead of the minimal one.
   *
   * The upstream's 6004 throttle fires on request SIZE (measured: ~20k tokens
   * pass, ~30k are refused), so the minimal probe cannot see it. Only ever set
   * for a single, human-initiated model — see the heavy-probe note above.
   */
  heavy?: boolean
}): Promise<WorkBuddyProbeResult> {
  let answer
  const startedAt = Date.now()
  try {
    answer = await input.client.probeChat(
      input.credential,
      input.heavy === true ? heavyProbeRequestBody(input.modelId) : probeRequestBody(input.modelId),
      input.signal,
    )
  } catch (error: unknown) {
    return {
      modelId: input.modelId,
      outcome: 'unavailable',
      message: redact(error instanceof Error ? error.message : String(error)),
    }
  }
  const elapsedMs = Date.now() - startedAt

  if (answer.ok) {
    let credit: number | undefined
    if (answer.response !== undefined) {
      try {
        credit = creditOfStream(await answer.response.text())
      } catch {
        // A truncated stream still proves the model answered; the credit figure
        // is informational, so its absence must not turn a success into a fail.
      }
    }
    return {
      modelId: input.modelId,
      outcome: 'ok',
      elapsedMs: Date.now() - startedAt,
      status: answer.status,
      ...credit === undefined ? {} : { message: `credit ${credit}` },
      ...cooldownOf({
        outcome: 'ok',
        retryAfter: answer.retryAfter,
        nowMs: input.nowMs,
        ...input.quotaRefreshAtMs === undefined ? {} : { quotaRefreshAtMs: input.quotaRefreshAtMs },
      }),
    }
  }

  const body = answer.body ?? ''
  const outcome = outcomeOfFailure(answer.status, body)
  return {
    modelId: input.modelId,
    outcome,
    elapsedMs,
    status: answer.status,
    ...body === '' ? {} : { message: redact(body) },
    ...cooldownOf({
      outcome,
      retryAfter: answer.retryAfter,
      nowMs: input.nowMs,
      // The upstream writes its reset time into the failure body, so the body
      // has to reach the cooldown reader — without it the card says "no time
      // given" while the answer sits in the text (the defect this fixes).
      body,
      ...input.quotaRefreshAtMs === undefined ? {} : { quotaRefreshAtMs: input.quotaRefreshAtMs },
    }),
  }
}
