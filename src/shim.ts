/**
 * Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
 * shim applies the WorkBuddy wire quirks (forced streaming, string
 * `tool_choice`, CLI-shaped headers) and forwards to the real upstream.
 * It binds 127.0.0.1 only and never serves another interface.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
 *   — 入站加固的四重校验（Host 必须回环、Origin 必须回环、chat POST 必须
 *     JSON、bearer 必须匹配进程内随机 secret）、常量时间比对、
 *     随机端口绑定、body 上限、上游错误分类到 HTTP 状态码的映射，
 *     均由该项目设计并验证。
 * 改动：随机端口绑定加了「先确认客户端能用」一步（`listenOnClientReachablePort`）。
 *   绑定方式仍是 `listen(0)` + 仅回环，随机性不变；改的只是抽到 HTTP 客户端
 *   禁用端口（fetch 规范的 block-bad-port 清单）时重抽，而不是带着一个自己
 *   客户端连不上的端口启动。四重校验、常量时间比对、body 上限、
 *   错误分类均未改动。
 *
 * @module dsh-connect-workbuddy/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { WorkBuddyCredential, WorkBuddyCredentialStore } from './auth.ts'
import { workbuddyAccountId } from './auth.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import type { WorkBuddyRefusalReport } from './off-thinking.ts'
import { usageOfChunk } from './body-report.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { DsmlStreamBuffer } from './dsml-recovery.ts'
import type { RecoveredToolCall, RecoveryGate } from './dsml-recovery.ts'
import { parseQueueAnswer, queueNoticeText } from './queue.ts'
import {
  declaredTools,
  prepareChatBody,
  modelIdOfBody,
  forceNeutralHead,
  channelGateMemberOf,
  isConversationIdGateBody,
  isContextTooLongBody,
  CONTEXT_OVERFLOW_MARKER,
  isFirstMessageGateBody,
  openingEvidenceOfBody,
  perturbChannelFingerprints,
  requestEvidenceOf,
  rewriteSessionTitleModel,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyChatResult,
} from './upstream.ts'

/** Minimal logger surface the plugin context already provides. */
export interface ShimLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** What the plugin needs from a running shim. */
export interface WorkBuddyShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this instead of the upstream access token, because the shim
   * resolves the real credential itself via the store.
   */
  token(): string
  /** Stop serving and destroy open connections. */
  close(): Promise<void>
}

/**
 * Supplies the credential to retry a failed chat request with.
 *
 * Called with every account id already tried for THIS request, the one that just
 * failed LAST, and resolves to the next candidate — or `undefined` when the pool
 * is off, empty, or exhausted, in which case the original failure is reported
 * unchanged.
 *
 * The plugin owns the policy (which pool members count as usable, in what
 * order); the shim owns only the retry loop and the wire-level rule that a
 * retry may happen before anything has been written to the client.
 */
export type WorkBuddyFailoverAccount = (
  triedAccountIds: readonly string[],
) => Promise<WorkBuddyCredential | undefined>

/**
 * Why the pool had no candidate, asked only after failover came up empty.
 *
 * A separate callback rather than a richer return type on
 * {@link WorkBuddyFailoverAccount}: the loop calls that one on the HOT PATH of
 * every retry, and a policy that had to explain its refusal on every call would
 * make the common case pay for the rare one. This runs at most once per failed
 * request, and only when the answer is already going to be an error.
 *
 * Returns a short Chinese clause naming the reason (e.g. "池中其余账号都在冷却"),
 * or undefined when the host has nothing to add — in which case the reply says
 * only that no other account was available.
 */
export type WorkBuddyFailoverShortfall = () => Promise<string | undefined>

/** Constructor dependencies. */
export interface WorkBuddyShimOptions {
  store: WorkBuddyCredentialStore
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>
  catalog: WorkBuddyCatalog
  logger?: ShimLogger
  /**
   * When to perturb scanned messages with invisible characters.
   *
   * `off` keeps the ordinary fail-then-rescue ladder; `failure` (the default)
   * remembers a successful rescue and starts later requests with it; `always`
   * starts every request with the dense rescue. `always` is for users whose
   * gateway has already made the plain attempt a guaranteed 11128 — it trades a
   * little prompt byte-level purity for avoiding that doomed round trip.
   */
  channelPerturbation?: 'off' | 'failure' | 'always'
  /**
   * Move the harness's injected `user` blocks above the real prompt (issue #132).
   *
   * The WorkBuddy usage page records the LAST `user` message as the request
   * text, and the harness appends its runtime context after the user's real
   * prompt — so the usage column shows injected noise instead of what was typed.
   * The reorder is order-only (every message and its text survive), and it only
   * ever moves messages that MATCH the harness's own injected prefixes; the single
   * textual edit is stripping the recorded prompt's own leading marker.
   *
   * Default false: it changes bytes the upstream counts, so it is opt-in.
   */
  keepPromptLast?: boolean
  /**
   * Extra literal prefixes (issue #133) treated like the harness's injected
   * markers under `keepPromptLast`, for context blocks a companion plugin
   * injects that the built-in list does not know about. Only read when
   * `keepPromptLast` is on.
   */
  extraInjectedPrefixes?: readonly string[]
  /**
   * Move the host's session-title request onto the hidden lightweight model
   * (issues #132/#133). Disabled by default; when enabled, a body recognized
   * as the one-message title prompt is re-pointed at `model` (default
   * `wb-lite`, measured 0 credits) instead of billing the main paid model.
   * See `rewriteSessionTitleModel` for the fail-closed detection rules.
   */
  sessionTitle?: {
    enabled?: boolean
    model?: string
  }
  /**
   * Pool failover for chat requests. Absent means no failover at all — the
   * pre-pool behaviour, where the selected account serves and its failure is
   * reported as-is.
   */
  failoverAccount?: WorkBuddyFailoverAccount
  /**
   * Why the pool had no usable candidate, asked after failover found none.
   *
   * The failure path uses this to answer the question the user is actually left
   * with — "why did nothing else work?" — instead of only reporting that every
   * attempt failed. Without it the pool's own reasoning is invisible at exactly
   * the moment it matters, and "换个模型" reads as a guess rather than as the
   * conclusion of a search the plugin already performed.
   *
   * Optional, and its absence is a supported state: a host that does not supply
   * it produces the same reply as before this option existed.
   */
  failoverShortfall?: WorkBuddyFailoverShortfall
  /**
   * Told about every refused request the plugin can attribute to a MODEL, right
   * before the failure is rendered (issue #83).
   *
   * Separate from the rendered reply because the caller that hit the refusal is
   * not always the user: compaction reads the failure as a boolean and shows
   * "could not produce a useful summary", so the one fact that explains it (this
   * model refuses `off`) never reaches any surface. This callback is how the
   * card learns it happened. Must not throw: a bookkeeping failure must never
   * replace the upstream's own failure.
   */
  reportRefusal?: (refusal: WorkBuddyRefusalReport) => void
  /**
   * Called before the FIRST attempt of every chat request, so the plugin can
   * point the store at the account the pool's ranking says should serve.
   *
   * It exists because "who serves" and "who to retry with" are the same decision
   * made at two moments: the ranking picks the first account, and after a failure
   * picks the next one. The shim resolves the credential itself right after this
   * returns, so the ranking never has to produce a credential — which keeps
   * token REFRESH in one place (`store.resolve()`) instead of duplicating it on
   * a path that would silently send expired tokens.
   *
   * Absent means the store's own selection always serves.
   */
  prepareAccount?: () => Promise<void>
  /**
   * Called for every attempt that failed upstream, before the next one is tried.
   *
   * Exists so the plugin can RECORD the failure as a measurement. The ranking
   * that picks the serving account reads the pool's STORED measurements, so
   * without this an account that just answered 429 still reads as untested — and
   * the next request picks it again and pays the same failed round trip before
   * failing over.
   *
   * Fired without awaiting: a slow write must never delay the retry the user is
   * waiting on, and the measurement only matters for LATER requests.
   */
  onAccountFailure?: (accountId: string, failure: {
    status: number
    kind: UpstreamErrorKind
    message: string
    /**
     * The model that request asked for (issue #61).
     *
     * Carried because the failure is remembered against the ACCOUNT, and `6004`
     * is an account × model condition: without this the record cannot say which
     * model the measurement belongs to, so the card has to present a
     * single-model result as account-level availability.
     */
    modelId?: string
  }) => void
  /**
   * Called with the FINAL serialized body of every chat request, just before it
   * goes upstream (issue #59).
   *
   * It exists so the plugin can record what was actually sent without the shim
   * having to know where that record goes: the region belongs to whoever wires
   * this up, and the report is a plugin concern. The body handed over is the
   * post-`prepareChatBody` one, because THAT is what the upstream counts.
   *
   * Fired without awaiting: a request must never wait on a diagnostic. The
   * callee must treat the string as read-only.
   */
  onRequestBody?: (bodyJson: string) => void
  /**
   * Called with the token counts the UPSTREAM reported for the request whose
   * body was just handed to {@link onRequestBody} (issue #59).
   *
   * `onRequestBody` records what we SENT; this records what the gateway
   * CHARGED. The issue cannot be settled with only one of them: a difference
   * between two captures is ambiguous until both sides are known, because
   * "the gateway counted the same bytes differently" and "the two bodies were
   * not the same" look identical from the sent side alone.
   *
   * May fire zero times (the upstream reported no `usage`, or the stream was
   * cut before its final frame) or more than once per body (a failover retry
   * reaches a second upstream). The callee is expected to keep the FIRST
   * real measurement, since that is the one the report's line belongs to.
   *
   * Fired without awaiting, and never allowed to fail the request.
   */
  onUpstreamUsage?: (usage: {
    promptTokens?: number
    completionTokens?: number
    cachedTokens?: number
  }) => void
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/**
 * Pause between failover attempts, after one account's request failed.
 *
 * The upstream's rate limit (6004) fires on request volume — firing retries at
 * zero gap makes every candidate hit the same wall, and 4 accounts can all fail
 * in under a second. The batch test already waits `POOL_BATCH_GAP_MS` (400ms)
 * between accounts for exactly this reason; the failover loop used to wait
 * nothing. 2 seconds is longer than the batch's 400 because a failover retry is
 * a real request the user is waiting on, not a probe — it needs enough room for
 * the upstream's window to breathe, not just enough to avoid self-inflicted
 * rate-limiting.
 */
const FAILOVER_ACCOUNT_GAP_MS = 2_000

/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  // Same status as `soft_rate`, because that is what the upstream returned — the
  // distinction lives in `code`/`type`, not in a relabelled status. See
  // KIND_HOST_CODE for why the host must not read this as an account limit.
  model_busy: 429,
  session_dead: 401,
  policy_reject: 403,
  account_restricted: 403,
  // A 400, because that is what the gateway answered and the request really is
  // malformed from its point of view. See KIND_HOST_CODE for why the host must
  // not read this as a retryable transport failure.
  channel_reject: 400,
  // A queue is a 429 in the sense the host understands: "not now, try again".
  // The host's bounded in-place retry is exactly right for `6020` (the queue is
  // moving), and for `6021`/`6022` the sentence says what to do instead.
  model_queue: 429,
  not_found: 502,
  server: 502,
  client: 400,
}

/**
 * The `code` spelling the HOST is expected to classify each upstream failure by.
 *
 * The host decides whether a failed request may be retried IN PLACE (5 attempts
 * with backoff) or must be handed to cross-provider failover by reading English
 * phrases out of `type + " " + code + " " + message` — see
 * `isQuotaExceededError` in `@deepseek-ai/dsh-llm`. Only `RATE_LIMIT`, `SERVER`,
 * `TIMEOUT`, `TRANSPORT` and `EMPTY_RESPONSE` are in its retry set, so the
 * spelling decides which of two very different things happens next.
 *
 * `soft_rate` is the one kind that spelling got wrong. The upstream's 429 says
 * "usage exceeds the frequency limit, and it resets at 13:37" — hours away, not
 * two seconds. Sent as `soft_rate` it reads as an ordinary rate limit, enters
 * the in-place retry set, and spends the whole retry budget on an endpoint that
 * cannot recover within it; by the time cross-provider failover is offered, the
 * turn has already failed. The upstream's own words are Chinese, so the
 * phrase-based classifier cannot see the distinction either — the label is the
 * only channel left to carry it.
 *
 * `quota_exceeded` is the minimal honest translation: it is the WORDS the host
 * recognises, and it matches what the upstream is actually saying. The HTTP
 * status stays 429 (that is what the upstream returned — relabelling it 402
 * would misreport the upstream), and the upstream's own message is still passed
 * through verbatim for a human to read.
 *
 * Every other kind already lands outside the retry set by its status alone
 * (`hard_credit` 402 → quota, `session_dead` 401 → auth, 502/400 → other), so
 * none of them is listed: a translation nobody needs is a lie waiting to drift.
 *
 * `policy_reject` is deliberately NOT listed either, for a sharper reason than
 * the others: the obvious candidate translation would be the upstream's own
 * numeric code (11140), but that is not a class the host knows, so it would take
 * the host's generic path and add nothing over `policy_reject`. It needs no
 * translation to stay outside the retry set (403), and it must NOT be translated
 * INTO the set — a content-policy refusal is deterministic, so retrying it in
 * place would spend the retry budget on a request the server will refuse again,
 * and cross-provider failover cannot help a policy decision either. The code the
 * host receives therefore names the class honestly.
 *
 * `model_busy` used to get the same `quota_exceeded` translation, for what
 * looked like the same reason, and that was WRONG in a way users reported
 * (issue #84). The reasoning above assumed `quota_exceeded` only influenced
 * retryability. It does more than that: `isQuotaExceededError` is matched
 * against `type + " " + code + " " + message`, the match yields host code
 * `QUOTA`, and the chat client hard-codes its copy for `QUOTA`/`ACCOUNT_QUOTA`
 * — substituting 「当前请求的额度已用尽」 and DISCARDING this plugin's message.
 * So a loaded model was shown to the user as an exhausted balance: an
 * actionable, transient condition rendered as a terminal, account-level one.
 *
 * Leaving `model_busy` untranslated is the correct spelling, and it was
 * verified end to end rather than reasoned about: driving pi-ai against a
 * server replaying this shim's real bodies, `code: 'model_busy'` classifies as
 * `RATE_LIMIT` — which (a) is outside the substitution list, so the plugin's
 * own honest sentence is what the user reads, and (b) IS in the host's
 * in-place retry set, so `dsh-llm-retry` performs a bounded retry with the
 * default 500 ms→10 s backoff instead of failing the turn on one 14003. That
 * retry is what makes "the model is momentarily busy" recoverable, which is
 * exactly what a 14003 is: measured against the same credential and second,
 * five consecutive sends gave 200/200/200/200/429.
 *
 * `soft_rate` keeps the translation, and the contrast is the whole point: its
 * reset is hours away, so the retry budget cannot produce an answer and must
 * not be spent. One word, two opposite temporal claims — so the spelling
 * follows the clock, not the status code both share.
 *
 * `channel_reject` is not listed, and the reason is the same rule applied to a
 * third clock: the gate's verdict is DETERMINISTIC for a given prompt, so an
 * in-place retry would spend the budget re-sending bytes it already refused, and
 * cross-provider failover cannot help either (every account sends that same
 * prompt). Its 400 already places it outside the host's retry set, so `type`
 * alone, untranslated, is the honest spelling.
 */
const KIND_HOST_CODE: Partial<Readonly<Record<UpstreamErrorKind, string>>> = {
  soft_rate: 'quota_exceeded',
}

/**
 * The `code` to write for an upstream failure, given its classified kind.
 *
 * `type` deliberately stays the plugin's own kind: it is what a human reads in
 * a log or a bug report, and it keeps the two fields individually meaningful.
 * Only `code` carries the host-facing translation.
 */
function hostErrorCode(kind: UpstreamErrorKind): string {
  return KIND_HOST_CODE[kind] ?? kind
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  })
  res.end(payload)
}

/**
 * Write a JSON error the way an OpenAI-compatible client expects.
 *
 * `code` defaults to `type`, which is right for every error THIS shim raises on
 * its own (`unauthorized`, `not_found`, …): those are not upstream failures and
 * must not be disguised as one. The upstream failure path passes an explicit
 * `code` so the host classifies it correctly — see {@link KIND_HOST_CODE}.
 */
function writeOpenAIError(
  res: ServerResponse,
  status: number,
  kind: string,
  message: string,
  code?: string,
  headers?: Readonly<Record<string, string>>,
): void {
  writeJson(res, status, { error: { message, type: kind, code: code ?? kind } }, headers)
}

/**
 * Tell every retrying client NOT to retry this failure (2026-10-22, at the
 * maintainer's request: the queue's automatic retry is removed).
 *
 * `x-should-retry` is a non-standard header that both clients in this stack
 * check BEFORE their status-based rules — the pinned OpenAI SDK's `shouldRetry`
 * and pi-ai's `isRetryableProviderError` each return false on "false".
 *
 * WHY THE QUEUE MUST NOT BE RETRIED. Without this header a 429 is retried by
 * construction: `@deepseek-ai/dsh-llm` maps status 429 to the `RATE_LIMIT` code
 * and `RATE_LIMIT` is in `DEFAULT_RETRYABLE_CODES`, so the HOST runs five
 * in-place attempts with 0.5s→8s backoff. Measured, that budget totals roughly
 * 15 seconds — against a queue the upstream reports in thousands. Every one of
 * those attempts is a real request spent to be told the same position again, and
 * none of them can clear the queue.
 *
 * So the queue is now reported ONCE, with the position intact, and the reader
 * decides whether to resend or switch models. That is exactly what
 * {@link queueNoticeText} tells them to do — the two changes are one decision: a
 * diagnostic that declares itself final must actually be final.
 */
const NO_RETRY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-should-retry': 'false',
  // The same instruction in the standard spelling, for a client that prefers it
  // over the vendor one. `0` means "do not wait, do not retry".
  'retry-after': '0',
})

/**
 * An over-limit request body (issue #174).
 *
 * A named class rather than an `Error` with a magic message, because the two
 * callers must answer it with a DIFFERENT status: the protocol answer is 413,
 * and classifying it as an ordinary internal failure made it a 500. A class
 * survives renaming the message, which is the only reason this is not a
 * string comparison.
 */
export class RequestBodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`request body too large (limit ${limitBytes} bytes)`)
    this.name = 'RequestBodyTooLargeError'
  }
}

/**
 * Read a request body with a size cap; over-limit bodies fail the request.
 *
 * AN OVER-LIMIT BODY IS STOPPED, NOT DESTROYED (issue #174). Calling
 * `req.destroy()` here tears down the SOCKET, so the 413 the caller is about to
 * write can never reach the client — it saw a reset connection instead of an
 * answer, which is strictly worse than the 500 this replaced. So the stream is
 * paused and its listeners are dropped: the request is no longer read, the
 * response still goes out, and Node closes the connection once the response
 * ends. Bytes already arriving are discarded with the socket, which is the
 * whole point of a cap (`content-length` is not trusted, so the cap has to be
 * enforced on arrival).
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        // Drop what was buffered before answering: holding a partial 64 MB body
        // while writing a one-line error is pure waste.
        chunks.length = 0
        req.removeAllListeners('data')
        req.removeAllListeners('end')
        req.pause()
        reject(new RequestBodyTooLargeError(REQUEST_BODY_LIMIT))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Rewrites the upstream SSE stream, converting markup the model wrote into the
 * text back into a real `delta.tool_calls` — and, when a whole turn produced
 * nothing but markup, holding the bytes long enough to retry ONCE.
 *
 * ============================================================================
 * Why this class exists rather than a `.pipe()`
 * ============================================================================
 *
 * Recovering a call means inspecting `delta.content` before the client sees it,
 * which the old `body.pipe(res)` could not do. The parsing rules live in
 * `src/dsml-recovery.ts`; everything here is about the STREAM's obligations:
 *
 *   1. FRAME ORDER IS NEVER CHANGED. Frames are forwarded in arrival order.
 *      The only frame this class invents is the trailing one that carries a
 *      block still unfinished at end-of-stream.
 *
 *   2. HOLDS ARE TEMPORARY AND PAY FOR THEMSELVES. Nothing is held unless the
 *      answer so far consists only of markup: the moment real prose or a real
 *      call appears, everything held is flushed in order and the stream returns
 *      to plain pass-through. An ordinary answer therefore pays no latency at
 *      all, and no byte is ever discarded while a retry is still possible.
 *
 *   3. A RETRY MUST NOT SPLICE TWO ANSWERS TOGETHER. That constraint is why the
 *      hold exists: because no content frame has been written yet, the caller
 *      can discard this attempt and re-send the same body. The existing
 *      failover loop makes the same promise for failures BEFORE the stream
 *      starts (see its comment in `chatCompletions`); this extends it to the
 *      one case that can only be recognised after the fact.
 *
 *   4. NOTHING IS INVENTED WHEN THE UPSTREAM ALREADY SPEAKS STRUCTURED CALLS.
 *      Once a native `delta.tool_calls` appears, recovery switches off for the
 *      rest of the response — two live call channels for one answer is worse
 *      than either one alone.
 *
 *   5. EVERY FRAME LEAVES SELF-CONTAINED. An SSE event ends at a blank line,
 *      and a frame written without its terminator merges into the NEXT event
 *      the client decodes — whose `data:` lines are then joined and parsed as
 *      one document (issue #53). Every write therefore goes through
 *      {@link emitFrame}, which completes the terminator; `push()` cuts frames
 *      that already carry it, and the one source of unterminated bytes — the
 *      half-frame left in `carry` when the upstream dies — is normalized in
 *      {@link consume}.
 */
class RecoveryStream {
  private carry = ''
  private readonly decoder = new TextDecoder('utf-8')
  /** Frames received after the hold began, in arrival order. */
  private held: Array<{ frame: string; final: boolean }> = []
  /**
   * The hold window, as two separate facts.
   *
   * `windowOpened` becomes true at the FIRST content-bearing frame and stays
   * true: before it, frames carry no answer (a role delta, a keep-alive) and go
   * straight out; from it on, they are held until the answer is known to be
   * real. `windowClosed` means "an answer was delivered", after which every
   * frame passes through again — for the rest of the response, because a turn
   * that has already produced prose can no longer be replaced by a retry.
   */
  private windowOpened = false
  private windowClosed = false
  private wroteContent = false
  private sawResidue = false
  private sawDone = false
  /**
   * Set once the upstream speaks structured calls.
   *
   * Sticky for the whole response on purpose: recovering markup into a second
   * call channel after the upstream already produced a real one would hand the
   * client two answers to the same question.
   */
  private nativeCallsSeen = false

  private readonly buffer: DsmlStreamBuffer | undefined

  /**
   * A notice to place at the head of the answer, once, before any prose.
   *
   * Set when the request reached this stream only after the pool failed over, so
   * the user learns WHY the answer came from a different account. Without it a
   * failover is invisible: the reply looks like it came from the account they
   * picked, and the only trace is a `logger.warn` they never see. The notice is
   * emitted ahead of the model's own text so it cannot be mistaken for part of
   * the answer, and only once — a retry that never delivers text must not leave
   * a stray line behind.
   */
  private notice: string | undefined

  constructor(
    private readonly res: ServerResponse,
    gate: RecoveryGate | undefined,
    private readonly logger: ShimLogger | undefined,
    notice?: string,
    /** Called once, with the upstream's token counts, when the stream reports them. */
    private readonly onUsage?: (usage: {
      promptTokens?: number
      completionTokens?: number
      cachedTokens?: number
    }) => void,
  ) {
    this.buffer = gate === undefined ? undefined : new DsmlStreamBuffer(gate)
    this.notice = notice
  }

  /**
   * Emit the pending failover notice, if any, and forget it.
   *
   * Called immediately before the first content reaches the client. Placed
   * here rather than in the constructor because a stream whose write fails, or
   * whose attempt is discarded in favour of a retry, must not have already told
   * the user about a switch it never completed.
   */
  private flushNotice(): void {
    const notice = this.notice
    if (notice === undefined) return
    this.notice = undefined
    if (!this.res.writable) return
    const chunk: Record<string, unknown> = { choices: [{ index: 0, delta: {}, finish_reason: '' }] }
    const choiceRecord: Record<string, unknown> = { index: 0, delta: {}, finish_reason: '' }
    // Written straight to the socket, deliberately bypassing the hold window:
    // the notice is ours, not the upstream's, so it is not something a retry
    // could need to replace — and putting it through the window would let a
    // discarded attempt take it away again after the user had seen it.
    this.windowOpened = true
    this.emitFrame(contentFrame(chunk, choiceRecord, notice))
  }

  /** True when a call or real prose has reached the client. */
  get delivered(): boolean {
    return this.wroteContent
  }

  /** True when the held bytes contain markup the gates refused. */
  get residueSeen(): boolean {
    return this.sawResidue
  }

  /**
   * The single exit every byte of a FRAME passes through.
   *
   * SSE dispatches one event per blank-line-terminated run of `data:` lines.
   * A frame written WITHOUT its terminator leaves the client's decoder
   * waiting for a blank line that never arrives, so the NEXT write is
   * appended to the SAME event — and a client that joins the several `data:`
   * lines of one event with `\n` and parses the result as one JSON document
   * (openai's `SSEDecoder` does exactly that) then reads two payloads as one
   * and fails. Issue #53 is that failure: the upstream died between a `data:`
   * line and its blank line, `consume()` forwarded the half-frame verbatim,
   * and `finish()` glued its synthetic `[DONE]` onto it, producing
   * `data: {...}\ndata: [DONE]\n\n` — parsed as one event whose data is
   * `"{...}\n[DONE]"`, which throws "Unexpected non-whitespace character
   * after JSON at position N". The whole turn is then classified as a
   * non-retryable error, so the user simply sees the answer stop.
   *
   * Completing the terminator here fixes both halves at once: the truncated
   * frame becomes a self-contained event, and the `[DONE]` that follows can no
   * longer be joined to it. It is idempotent for the frames `push()` cuts —
   * those always carry the terminator already, so they pass through
   * byte-for-byte, which keeps guarantee 1 (frame order is never changed)
   * intact.
   *
   * Note that a missing NEWLINE is also completed: `data: {…}` cut mid-line
   * needs the full `\n\n`, not a single `\n`, to close the event. Such a frame
   * is upstream-corrupted JSON that cannot be repaired here; closing it at
   * least keeps the corruption confined to its own event instead of taking
   * the terminator down with it.
   */
  private emitFrame(frame: string): void {
    if (frame.endsWith('\n\n')) {
      this.res.write(frame)
      return
    }
    this.res.write(frame.endsWith('\n') ? `${frame}\n` : `${frame}\n\n`)
  }

  /** Record that text the gates refused was seen (markup residue, not prose). */
  private noteResidue(seen: boolean): void {
    this.sawResidue ||= seen
  }

  /** Drain one upstream body into the client. */
  async consume(body: ReadableStream<Uint8Array> | null): Promise<void> {
    if (body === null) return
    const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])
    try {
      for await (const chunk of source) {
        this.push(this.decoder.decode(chunk as Buffer, { stream: true }))
      }
    } catch (error: unknown) {
      // The old pass-through logged the same way and let the response end with
      // a synthesized terminator; that behaviour is preserved by `finish()`.
      this.logger?.warn('dsh-connect-workbuddy: upstream stream failed mid-flight', error)
    }
    const tail = this.carry
    this.carry = ''
    if (tail !== '') {
      // `push()` only cuts a frame at an EMPTY line, so whatever is left in
      // `carry` when the upstream ends is by definition a frame that never
      // received its terminator — the upstream died between a `data:` line and
      // the blank line that would have closed it. Forwarding it verbatim leaves
      // the client's SSE decoder inside that event, so the `[DONE]` written by
      // `finish()` becomes a SECOND `data:` line of the SAME event and the two
      // payloads are joined and parsed as one JSON document — issue #53's
      // "Unexpected non-whitespace character after JSON at position N".
      //
      // Closing the frame here keeps it a self-contained event: the last real
      // chunk of the answer is delivered instead of being lost (without a
      // terminator the client never dispatches the event at all and silently
      // drops that content), and the synthetic terminator that follows can no
      // longer be glued onto it. `emitFrame` completes the terminator for every
      // write, so this normalization is the tail's share of that guarantee.
      const lineTerminated = tail.endsWith('\n')
      this.handleFrame(lineTerminated ? `${tail}\n` : `${tail}\n\n`)
    }
  }

  /**
   * Close the response: emit the block still unfinished at end-of-stream, then
   * everything held, then the terminator.
   */
  finish(): void {
    const flushed = this.buffer?.flush()
    if (flushed !== undefined && flushed.text !== '') {
      this.noteResidue(!flushed.prose)
      this.emitContent(flushed.text)
    }
    this.closeWindow()
    if (!this.sawDone && this.res.writable) this.emitFrame('data: [DONE]\n\n')
    if (this.res.writable) this.res.end()
  }

  /** Drop held bytes without writing them (used when a retry replaced them). */
  discard(): void {
    this.held = []
    this.windowClosed = true
  }

  // -------------------------------------------------------------------------

  /** Split incoming bytes into whole SSE frames, handling chunk boundaries. */
  private push(text: string): void {
    this.carry += text
    let start = 0
    for (;;) {
      const newline = this.carry.indexOf('\n', start)
      if (newline === -1) break
      const line = this.carry.slice(start, newline)
      if (line.trim() === '') {
        const frame = this.carry.slice(0, newline + 1)
        this.carry = this.carry.slice(newline + 1)
        start = 0
        this.handleFrame(frame)
        continue
      }
      start = newline + 1
    }
  }

  /** Whether a usage measurement has already been reported for this stream. */
  private usageReported = false

  /**
   * Read the upstream's token counts out of one parsed chunk and report them.
   *
   * FIRES AT MOST ONCE per stream, and only when there is a real number to
   * report. Two reasons, both load-bearing:
   *
   *   - a streamed answer's `usage` arrives on its final frame, but a failover
   *     retry starts a NEW `RecoveryStream`, so a second call here would be a
   *     second measurement for the same line;
   *   - a chunk with no `usage` (which is every chunk but the last) must not be
   *     reported as zero — an absent measurement and a measurement of zero are
   *     different facts, and the #59 comparison turns entirely on that
   *     difference.
   */
  private noteUsage(chunk: Record<string, unknown>): void {
    if (this.usageReported || this.onUsage === undefined) return
    const usage = usageOfChunk(chunk)
    if (usage === undefined) return
    this.usageReported = true
    try {
      this.onUsage(usage)
    } catch (error: unknown) {
      // A diagnostic must never fail a chat request.
      this.logger?.warn('dsh-connect-workbuddy: usage report failed', error)
    }
  }

  /** Handle one complete frame, rewriting it only when recovery produced something. */
  private handleFrame(frame: string): void {    const payload = dataPayload(frame)
    if (payload === undefined) {
      this.send(frame, false)
      return
    }
    if (payload === '[DONE]') {
      this.sawDone = true
      this.send(frame, false)
      return
    }

    let chunk: Record<string, unknown>
    try {
      chunk = JSON.parse(payload) as Record<string, unknown>
    } catch {
      // Not ours to interpret: forward verbatim, exactly as the diagnostic
      // module's own frame parser treats an unparsable frame.
      this.send(frame, false)
      return
    }

    const choices = chunk['choices']
    // The `usage` block is normally carried by a frame that has NO `choices`
    // (the final chunk on a streamed answer), so it must be read BEFORE the
    // choices check below — otherwise every such frame is forwarded unread and
    // the measurement never leaves the stream.
    this.noteUsage(chunk)
    const choice = Array.isArray(choices) ? choices[0] : undefined
    if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) {
      this.send(frame, false)
      return
    }
    const choiceRecord = choice as Record<string, unknown>
    const deltaValue = choiceRecord['delta']
    const delta = typeof deltaValue === 'object' && deltaValue !== null && !Array.isArray(deltaValue)
      ? deltaValue as Record<string, unknown>
      : undefined
    if (delta === undefined) {
      this.send(frame, false)
      return
    }

    // A native call means the upstream is already speaking the protocol: stop
    // recovering for this response so the two cannot both fire.
    const nativeCalls = delta['tool_calls']
    if (Array.isArray(nativeCalls) && nativeCalls.length > 0) {
      this.nativeCallsSeen = true
      this.windowOpened = true
      this.flushNotice()
      this.send(frame, false)
      this.wroteContent = true
      this.closeWindow()
      return
    }

    const content = delta['content']
    if (typeof content !== 'string' || content === '') {
      const reason = finishReasonOf(choiceRecord)
      // A terminator is the last thing the answer says. Anything the buffer is
      // still holding is content that logically PRECEDES it, so it must be
      // emitted first — otherwise a client that stops accumulating at
      // `finish_reason` silently loses the tail of the answer.
      if (reason !== '') this.drainBuffer()
      this.send(frame, reason !== '')
      return
    }

    if (this.buffer === undefined || this.nativeCallsSeen) {
      // Gate 3 (nothing declared) or a response that already carries real calls:
      // nothing may be recovered, and the bytes go through untouched. The window
      // is opened so that a later frame cannot start holding either — with no
      // recovery there is nothing a hold could be waiting for.
      this.windowOpened = true
      this.flushNotice()
      this.closeWindow()
      this.emitFrame(frame)
      this.wroteContent = true
      return
    }

    // The first content-bearing frame opens the hold window: from here until
    // the answer is proven real, frames are queued rather than forwarded.
    this.windowOpened = true

    const outcome = this.buffer.add(content)
    if (outcome.calls !== undefined && outcome.calls.length > 0) {
      // Queued through `send` first so it lands ahead of any `finish_reason`
      // frame already held, then the window closes and everything flushes in
      // arrival order.
      this.flushNotice()
      this.send(callsFrame(chunk, choiceRecord, outcome.calls), false)
      this.wroteContent = true
      this.closeWindow()
      // Any text the same chunk also carried still belongs to the client.
      if (outcome.text !== '') this.emitFrame(contentFrame(chunk, choiceRecord, outcome.text))
      return
    }

    this.noteResidue(!outcome.prose && outcome.text !== '')
    if (outcome.text === '') {
      // Nothing to show: either the buffer is still holding a half-arrived
      // block, or the upstream sent an empty delta.
      this.send(contentFrame(chunk, choiceRecord, ''), false)
      return
    }
    if (outcome.prose) {
      this.flushNotice()
      this.send(contentFrame(chunk, choiceRecord, outcome.text), false)
      this.wroteContent = true
      this.closeWindow()
      return
    }
    this.send(contentFrame(chunk, choiceRecord, outcome.text), false)
  }

  /**
   * Hand back whatever the buffer is still holding, right now.
   *
   * Called before a terminator frame is forwarded. `flush()` ends the buffer's
   * attempt — if content somehow keeps arriving afterwards it starts a fresh
   * one, which is the correct reading of a stream that declared itself finished.
   */
  private drainBuffer(): void {
    const flushed = this.buffer?.flush()
    if (flushed === undefined || flushed.text === '') return
    this.noteResidue(!flushed.prose)
    this.emitContent(flushed.text)
  }

  /**
   * Emit text the buffer was still holding when the stream ended.
   *
   * It goes through `send` + `closeWindow` rather than straight to the socket on
   * purpose: a `finish_reason` frame may already be queued, and this text is
   * content that logically precedes it. Writing directly would put the answer
   * after its own terminator — a client that stops accumulating at
   * `finish_reason` would silently lose the tail.
   */
  private emitContent(text: string): void {
    const chunk: Record<string, unknown> = { choices: [{ index: 0, delta: {}, finish_reason: '' }] }
    const choiceRecord: Record<string, unknown> = { index: 0, delta: {}, finish_reason: '' }
    this.windowOpened = true
    const frame = contentFrame(chunk, choiceRecord, text)
    if (text.trim() !== '') {
      this.flushNotice()
      this.send(frame, false)
      this.wroteContent = true
      this.closeWindow()
      return
    }
    this.send(frame, false)
  }

  /** Queue a frame while the window is open, or write it once it has closed. */
  private send(frame: string, final: boolean): void {
    if (this.windowClosed || !this.windowOpened) {
      this.emitFrame(frame)
      return
    }
    // A frame carrying `finish_reason` belongs AFTER content still in flight,
    // so a trailing content frame is inserted ahead of every such frame rather
    // than appended behind it.
    const entry = { frame, final }
    if (!final) {
      const at = this.held.findIndex(item => item.final)
      if (at !== -1) {
        this.held.splice(at, 0, entry)
        return
      }
    }
    this.held.push(entry)
  }

  /**
   * An answer has been delivered: flush everything held, in order, and never
   * hold again for this response.
   */
  private closeWindow(): void {
    this.windowClosed = true
    const pending = this.held
    this.held = []
    for (const entry of pending) this.emitFrame(entry.frame)
  }
}

/** The SSE `data:` payload of one frame, or nothing when it carries none. */
function dataPayload(frame: string): string | undefined {
  for (const line of frame.split('\n')) {
    const trimmed = line.trimEnd()
    if (!trimmed.startsWith('data:')) continue
    return trimmed.slice('data:'.length).trim()
  }
  return undefined
}

/** A frame's `finish_reason`, or '' when it carries none. */
function finishReasonOf(choice: Record<string, unknown>): string {
  const reason = choice['finish_reason']
  return typeof reason === 'string' ? reason : ''
}

/**
 * One frame carrying recovered calls.
 *
 * The shape is OpenAI's: `index` per call, `type: "function"`, arguments as a
 * JSON STRING. `finish_reason` becomes `tool_calls` — without it a client that
 * waits for the reason before executing an assembled call would never run it.
 */
function callsFrame(
  chunk: Record<string, unknown>,
  choice: Record<string, unknown>,
  calls: readonly RecoveredToolCall[],
): string {
  const toolCalls = calls.map((call, index) => ({
    index,
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }))
  const next = { ...chunk, choices: [{ ...choice, delta: { tool_calls: toolCalls }, finish_reason: 'tool_calls' }] }
  return `data: ${JSON.stringify(next)}\n\n`
}

/**
 * How to name a pool account in a sentence the USER reads.
 *
 * Prefers the phone number (`uin`) because that is what the pool table shows and
 * what a person recognises; the nickname and the opaque account id are fallbacks
 * so this can never render an empty name. Deliberately NOT the hashed account id
 * on its own: a 24-character hex digest identifies an account to the plugin, but
 * to the person reading the answer it identifies nothing.
 */
function describeAccount(credential: WorkBuddyCredential): string {
  if (credential.uin !== undefined && credential.uin !== '') return credential.uin
  if (credential.nickname !== undefined && credential.nickname !== '') return credential.nickname
  return workbuddyAccountId(credential)
}

/**
 * One short phrase for why an account was abandoned, for the in-reply notice.
 *
 * Kept to the distinction the user can act on rather than the internal kind
 * name: "账号被限流" says wait or add an account, "登录已失效" says the sign-in
 * is the problem. The numeric kind would only send them to the log.
 *
 * The wording is what `failoverNoticeText` interpolates into a Chinese sentence,
 * so these are Chinese phrases rather than English ones — the reader of a failed
 * turn in this product reads Chinese, and an English clause inside Chinese prose
 * was the previous build's most visible rough edge.
 */
/**
 * Name the rejected PARAMETER when the upstream refused a reasoning tier, or
 * `undefined` when it is any other failure (issue #83).
 *
 * The compaction path used to surface "Compaction could not produce a useful
 * summary" and nothing else, so a 11133 caused by `reasoning_effort: "off"` was
 * indistinguishable from a model that was simply unavailable — the reporter had
 * to read the raw body to learn that one parameter was at fault. When the body
 * names the offending parameter (`extError.param`) the reply says so; this is a
 * refusal the plugin can explain without guessing, because it is the union of
 * two facts the upstream stated in the response.
 */
/**
 * Turn a failure into a refusal report for {@link WorkBuddyShimOptions.reportRefusal},
 * or `undefined` when it is not a tier refusal worth recording.
 *
 * Only refusals the upstream attributed to a PARAMETER are reported: a plain
 * 500 or a quota error says nothing about `off`, and recording it would pin a
 * "refuses off" badge on a model that never refused anything.
 */
function refusedTierReport(
  failure: WorkBuddyChatResult,
  modelId: string | undefined,
): WorkBuddyRefusalReport | undefined {
  if (failure.ok || failure.kind !== 'client') return undefined
  const param = failure.detail?.rejectedParam
  if (param === undefined || !param.includes('reasoning')) return undefined
  const tier = failure.detail?.rejectedTier
  return {
    param,
    ...tier === undefined ? {} : { tier },
    ...failure.detail?.upstreamCode === undefined ? {} : { code: failure.detail.upstreamCode },
    ...modelId === undefined ? {} : { modelId },
    at: Date.now(),
  }
}

function reasoningTierRefusal(failure: WorkBuddyChatResult): string | undefined {
  if (failure.ok || failure.kind !== 'client') return undefined
  const param = failure.detail?.rejectedParam
  if (param === undefined || !param.includes('reasoning')) return undefined
  const tier = failure.detail?.rejectedTier
  return tier === undefined
    ? `上游拒绝了推理档位参数（${param}）`
    : `上游拒绝了推理档位「${tier}」（${param}）`
}

function failoverReasonText(failure: WorkBuddyChatResult): string {
  // The union is discriminated by `ok`; only a failure carries a kind, and this
  // is only ever called on the failed attempt that triggered a switch.
  if (failure.ok) return '不可用'
  switch (failure.kind) {
    // The 6004 volume limit: the account serves this request again once the
    // stated reset passes.
    case 'soft_rate':
      return '被限流'
    // NOT the same sentence as `soft_rate`, though both leave the pool. The
    // remedy differs in kind: an exhausted account cannot pay for this model AT
    // ALL until it is topped up or its quota cycle rolls over, so "被限流"
    // sends the user to wait for something that will not arrive. Kept
    // failover-worthy — another ACCOUNT may well have credits, which is exactly
    // why the notice has to name the real reason.
    case 'hard_credit':
      return '积分已耗尽'
    case 'model_busy':
      // NOT "被限流": that phrasing is what sent issue #56's reporter to the
      // account pool. The failure belongs to the model, and the notice this
      // text feeds only ever appears when the plugin DID switch accounts — which
      // it no longer does for this kind.
      return '该模型当前繁忙（不是账号问题）'
    case 'session_dead':
      return '登录已失效'
    case 'policy_reject':
      return '被服务端策略拒绝'
    // An upstream restriction against THIS credential, not the request. It is
    // kept out of `policy_reject`'s copy and its 403 remains failover-worthy:
    // another account can serve, and this one must be benched (issue #127).
    case 'account_restricted':
      return '账号被上游限制使用'
    // The gateway's channel gate: it refuses the PROMPT, not the account or the
    // model. Its own `displayTips` blames "channel verification / an unofficial
    // client", which is what sent issues #87–#90's reporters through account
    // swaps; none of them could help, and saying so is the point of this line.
    case 'channel_reject':
      return '被网关的渠道校验拦截（不是账号、额度或网络问题）'
    case 'not_found':
      return '模型不可用'
    case 'server':
      return '上游异常'
    // A request the upstream rejected on its PARAMETERS (issue #78). Deliberately
    // NOT "不可用": the plugin never fails over for this kind, so saying only
    // "unavailable" leaves the reader to guess whether an account or the network
    // is at fault. Neither is — the same body will be refused by every account.
    case 'client':
      return '请求被上游拒绝'
    default:
      // No status code here. The caller already renders `（http N）` for every
      // failure, so embedding it again produced "（http 400）（http 400）" — the
      // duplicate made the one piece of information the reader could search for
      // look like a glitch (issue #78).
      return '不可用'
  }
}

/**
 * One upstream sentence, made safe to paste into a single-line error message.
 *
 * `result.message` carries the WHOLE upstream body — for a classified failure
 * that is a JSON envelope 637–777 characters long whose first 400 characters are
 * the `code`/`requestId`/`extError` skeleton (`param: ""`, `Request: null`). A
 * plain `slice(0, 400)` therefore cut the one actionable sentence in half: the
 * reply ended mid-word at `Pleas` and the reader lost `displayTips` entirely
 * (issue #78).
 *
 * Two rules keep that from happening again:
 * - whitespace collapses to single spaces, because the body is JSON/HTML and its
 *   newlines would otherwise render as a ragged block inside one paragraph;
 * - the cut prefers a sentence boundary once one exists past the halfway point,
 *   so a clipped sentence reads as "truncated" instead of as broken prose, and
 *   the `…` always says the text continues.
 *
 * This is the LAST resort: a body that parsed into a `detail` with `displayMsg`
 * or `tips` never reaches it, and those are short by construction.
 */
function clippedUpstreamText(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= limit) return collapsed
  const cut = collapsed.slice(0, limit)
  const stop = Math.max(
    cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'),
    cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '),
  )
  if (stop >= Math.floor(limit / 2)) return `${cut.slice(0, stop + 1).trimEnd()}…`
  return `${cut.trimEnd()}…`
}

/**
 * The channel-gate reply's evidence sentence: what the gateway actually read.
 *
 * Read from the HOST's body, not from the prepared one, because the prepared
 * body has the plugin's neutral head in front of every opening it recognises —
 * so the first line it could report is the plugin's own placeholder, which is
 * exactly the false lead issue #98's reporters were given. They were told the
 * gateway had refused `You are a helpful assistant.`, a line that returns 200
 * when sent alone.
 *
 * Each entry is labelled with its ROLE (`system` / `assistant`) because both are
 * scanned and the difference is what tells the reader where to look: an
 * `assistant` entry is a history message, i.e. the session is poisoned and every
 * later turn will fail the same way until that line is changed.
 *
 * Each entry also says whether the plugin's own neutralisation already covers
 * it. An entry marked "not in the plugin's list" is the actionable one: that
 * opening goes on the wire verbatim, so either the host wrote it or the
 * gateway's list grew.
 *
 * Capped at {@link CHANNEL_EVIDENCE_LIMIT} entries: a session can carry dozens
 * of system/assistant messages, and a wall of them would bury the one that
 * matters. The remainder is counted instead of listed.
 */
function channelEvidenceText(bodyJson: string): string {
  const entries = openingEvidenceOfBody(bodyJson)
  if (entries.length === 0) return '（请求里没有可读的 system 或 assistant 消息开头。）'
  const shown = entries.slice(0, CHANNEL_EVIDENCE_LIMIT)
  const rendered = shown
    .map(entry => {
      const label = entry.neutralized
        ? '（插件已加中性头）'
        : '（不在插件已知名单里，网关可能新增了词条）'
      const span = entry.closing === undefined
        ? `，共 ${entry.textLength} 字`
        : `，首尾为「${entry.closing}」，共 ${entry.textLength} 字`
      return `「${entry.role}：${entry.opening}${span}」${label}`
    })
    .join('、')
  const hidden = entries.length - shown.length
  return `请求里被网关扫描的消息开头：${rendered}${hidden > 0 ? `……另有 ${hidden} 条未列出。` : '。'}`
}

/** How many message openings the channel-gate reply lists. */
const CHANNEL_EVIDENCE_LIMIT = 4

/**
 * The line prepended to an answer that came from a failover account.
 *
 * Block-quoted and bracketed so it reads as machinery rather than as the model's
 * own words, and so a user skimming for the answer can skip it. It states the
 * reason AND the account left behind, because those are the two facts that make
 * an unexpected reply explicable.
 *
 * The wording avoids "switched TO <account>" on purpose: the account that took
 * over is the one the user is about to keep talking to, and naming it invites
 * the reading that they must now manage it. What they need is to know the one
 * they chose did not answer, and why.
 *
 * Chinese, matching the rest of a failed turn's copy: the host renders its own
 * quota sentence in Chinese, the pool rows are Chinese, and an English clause
 * here was the one line of the reply a Chinese reader had to decode.
 */
function failoverNoticeText(from: string, reason: string): string {
  return `\n\n> [dsh-connect-workbuddy] 「${from}」${reason}，已改用池中另一个账号回答\n\n`
}

/** One frame carrying replacement text for a frame whose content was consumed. */
function contentFrame(
  chunk: Record<string, unknown>,
  choice: Record<string, unknown>,
  content: string,
): string {
  const delta = { ...(choice['delta'] as Record<string, unknown> | undefined), content }
  const next = { ...chunk, choices: [{ ...choice, delta }] }
  return `data: ${JSON.stringify(next)}\n\n`
}

/**
 * How many times the listener re-rolls its port before accepting one the client
 * refuses.
 *
 * Bounded on purpose: a machine whose whole dynamic range is refused would
 * otherwise re-roll forever, and a shim on a refused port still fails in ONE
 * region-scoped way — while no shim at all takes that region down outright.
 * Availability wins over tidiness.
 */
export const PORT_ROLL_LIMIT = 5

/**
 * Whether this runtime's `fetch` refuses `port` WITHOUT ever connecting.
 *
 * `server.listen(0)` lets the kernel pick the port, and the Fetch standard bans
 * a list of ports that `fetch` must reject before opening a socket
 * (`fetch.spec.whatwg.org#block-bad-port`, implemented as undici's `badPorts`).
 * Every client of this shim goes through that same `fetch`: pi-ai drives the
 * OpenAI SDK, whose `getDefaultFetch()` returns `globalThis.fetch`. So a shim
 * that lands on a banned port is unreachable to its own client while being
 * perfectly healthy on the wire — measured on port 6000: `fetch` refuses,
 * while `node:http`, a raw TCP socket and `curl` all connect and get 200.
 *
 * That combination is what makes it worth preventing rather than diagnosing: it
 * is silent (the SDK surfaces only `Connection error.`, with the `bad port`
 * cause dropped), total (every request in the region fails), and it does not
 * re-roll on its own.
 *
 * Whether it can happen at all depends on the machine's dynamic port range,
 * because that is the set `listen(0)` draws from:
 *
 *   Windows default 49152-65535, Linux default 32768-60999, macOS 49152-65535
 *     — every banned port is <= 10080 (the current list ends there), so the
 *       intersection is EMPTY and these machines cannot be affected.
 *   A range lowered to reach below 10080 — e.g. the legacy `MaxUserPort`
 *     registry value pinned to 15000, which yields 1024-15000 — draws from a
 *     set that CONTAINS banned ports. Measured there: 19 of 13977 ports are
 *     banned, i.e. ~0.14% per bind and ~0.27% per plugin load (two regions,
 *     one bind each).
 *
 * Probing with the client itself, rather than comparing against a copy of the
 * banned list, is deliberate: a hard-coded list drifts the moment the standard
 * gains a port, whereas the rule being satisfied here IS the client's own, so
 * asking the client cannot disagree with it. `tests/shim.spec.ts` pins the
 * error shape this relies on, so a Node change that renames it fails loudly
 * instead of silently disabling the guard.
 */
export async function clientRefusesPort(port: number): Promise<boolean> {
  try {
    // ANY HTTP answer proves the client accepted the port — including the 401
    // this route returns without a bearer. Only a throw is evidence of refusal.
    await fetch(`http://127.0.0.1:${port}/healthz`)
    return false
  } catch (error: unknown) {
    return isBadPortRefusal(error)
  }
}

/**
 * Whether `error` is the client's PORT REFUSAL rather than a real transport
 * failure.
 *
 * The two must never be conflated: a refused port is worth re-rolling, while
 * `ECONNREFUSED`/`ECONNRESET` are ordinary transport errors that re-rolling
 * would only paper over. Measured shapes on Node 24:
 *
 *   refused port : TypeError('fetch failed') -> cause Error('bad port')        (no `code`)
 *   closed  port : TypeError('fetch failed') -> cause Error('connect ECONNREFUSED …') (code `ECONNREFUSED`)
 *
 * The cause chain is walked, with a bound, rather than read one level deep:
 * the OpenAI SDK wraps this same refusal in its own `APIConnectionError`, and a
 * caller should not have to know how deep the active client happens to nest it.
 */
export function isBadPortRefusal(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4; depth++) {
    if (!(current instanceof Error)) return false
    if (current.message === 'bad port') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/**
 * Listen on an ephemeral loopback port, rejecting on failure.
 *
 * Also settles on `close`, which is NOT redundant: measured on Node 24, a
 * `close()` that lands while `listen()` is still pending fires neither
 * `listening` nor `error` — only `close`. Without that third listener a dispose
 * during startup would leave this promise (and therefore the shim's `ready`)
 * pending forever, wedging plugin unload. Resolving there is deliberate:
 * disposal is a satisfied end state, not a startup failure.
 */
function listenOnce(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const settle = (): void => {
      server.off('listening', onListening)
      server.off('error', onError)
      server.off('close', onClose)
    }
    const onListening = (): void => { settle(); resolve() }
    const onError = (error: Error): void => { settle(); reject(error) }
    const onClose = (): void => { settle(); resolve() }
    // `once` here and not in the caller: the handlers must be scoped to THIS
    // attempt, or a failure on a later re-roll would resolve an earlier attempt.
    server.once('listening', onListening)
    server.once('error', onError)
    server.once('close', onClose)
    server.listen(0, '127.0.0.1')
  })
}

/** Stop listening, resolving once the listener is down. */
function closeOnce(server: Server): Promise<void> {
  return new Promise<void>(resolve => server.close(() => resolve()))
}

/**
 * Bind an ephemeral loopback port that the CLIENT can actually reach.
 *
 * `listen(0)` stays the right way to get a port — the kernel picks a free one
 * instead of this plugin guessing a number — but the first pick is not always
 * usable, so the roll repeats while the client refuses it. See
 * {@link clientRefusesPort} for why the client's own answer is the criterion,
 * and {@link PORT_ROLL_LIMIT} for why the loop is bounded.
 *
 * The probe is injected rather than imported so the re-roll path can be driven
 * deterministically: no test can make `listen(0)` return a banned port on
 * demand, so this seam is the only way to pin the behaviour that actually
 * matters.
 *
 * `ready` (the returned promise) therefore resolves only once a port is
 * settled, which is what lets every consumer keep reading `baseUrl()` as it
 * always has.
 */
export async function listenOnClientReachablePort(options: {
  server: Server
  /** Answers whether the active HTTP client refuses this port. */
  clientRefuses: (port: number) => Promise<boolean>
  logger?: ShimLogger | undefined
  /** Whether the shim was disposed while the listener was still starting. */
  cancelled?: (() => boolean) | undefined
}): Promise<void> {
  const { server, clientRefuses, logger, cancelled } = options
  for (let attempt = 1; ; attempt++) {
    // Checked at the top of each pass: the probe below is the only long await,
    // so a dispose that lands during it is caught here, before the listener is
    // brought back up with nothing left to close it.
    if (cancelled?.() === true) return
    await listenOnce(server)
    const address = server.address()
    const port = address === null || typeof address === 'string' ? undefined : address.port
    // A unix socket cannot come out of a TCP listen, but if there is no port to
    // judge there is also nothing to re-roll — serve what we have.
    if (port === undefined || !(await clientRefuses(port))) return
    if (attempt >= PORT_ROLL_LIMIT) {
      logger?.warn(
        `dsh-connect-workbuddy: port ${port} is on the HTTP client's refused list and ${PORT_ROLL_LIMIT} rolls did not avoid one; serving on it anyway`,
      )
      return
    }
    logger?.warn(`dsh-connect-workbuddy: port ${port} is refused by the HTTP client; re-rolling (attempt ${attempt})`)
    await closeOnce(server)
  }
}

/**
 * Start the loopback endpoint. Requests must carry the shim's shared secret;
 * the loopback bind alone is not a trust boundary.
 */
export function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim {
  const { store, client, catalog } = options
  const logger = options.logger
  const failoverAccount = options.failoverAccount
  const failoverShortfall = options.failoverShortfall
  const reportRefusedTier = options.reportRefusal ?? (() => {})
  const prepareAccount = options.prepareAccount
  const onAccountFailure = options.onAccountFailure
  const onRequestBody = options.onRequestBody
  const onUpstreamUsage = options.onUpstreamUsage
  const channelPerturbation = options.channelPerturbation ?? 'failure'
  /**
   * Whether the harness's injected `user` blocks are moved above the real prompt.
   *
   * OFF by default (issue #132): the reorder changes the message ORDER the
   * upstream counts, so it must be the user's deliberate choice rather than a
   * silent difference after an upgrade.
   */
  const keepPromptLastEnabled = options.keepPromptLast === true
  const extraInjectedPrefixes = Array.isArray(options.extraInjectedPrefixes)
    ? options.extraInjectedPrefixes.filter(entry => typeof entry === 'string' && entry !== '')
    : []
  const sessionTitleOptions = options.sessionTitle ?? {}

  // Per-process shared secret. Lives only in memory; the adapter resolves it
  // as the OpenAI apiKey, which pi-ai sends as `Authorization: Bearer ...`.
  // The shim never forwards it upstream — the real credential comes from the
  // store. A local attacker who can hit the port still cannot forge this.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /**
   * Whether this process's prompts have been PROVEN to need the invisible
   * perturbation before the gateway will accept them.
   *
   * WHY THIS EXISTS (measured 2026-10-22). The retry ladder below is
   * discover-by-failing: a request goes out unmodified, is refused with `11128`,
   * and the ladder re-sends a perturbed copy. That is correct the first time and
   * wasteful every time after — the prompt SHAPE that carries a fingerprinted
   * substring does not change between turns of a session, so the plugin was
   * paying one refused request (~209ms measured) on EVERY request, forever.
   *
   * So once the perturbation is what made a request succeed, the next request
   * starts from the perturbed form and skips the doomed first attempt. The
   * saving is one round trip plus one refused request per turn.
   *
   * WHY A PROCESS-LOCAL FLAG AND NOT A CONFIG. The gateway's fingerprint list is
   * a snapshot the upstream can change at any time, in either direction: a rule
   * can be withdrawn as easily as added. A persisted flag would therefore
   * outlive the condition that justified it and could keep perturbing prompts a
   * gateway no longer objects to. In memory it is forgotten at restart, which is
   * the natural expiry for "what this gateway refused recently".
   *
   * AND IT SELF-CORRECTS. If a perturbed body is EVER refused with the channel
   * gate, the flag is cleared and the request falls back to the plain ladder —
   * so a withdrawn rule, or a different model behind the same gateway, cannot
   * leave the plugin stuck sending a shape that no longer helps.
   */
  let channelNeedsPerturbation = false

  /** Constant-time bearer check; absent or mismatched bearers are rejected. */
  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1] as string
    const expected = SHARED_SECRET
    const a = Buffer.from(presented)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  let disposed = false

  // Attached for the LIFE of the shim, not just the first bind. After the port
  // is settled there is no promise left to reject into, and an 'error' event
  // with no listener is an uncaught exception — so this keeps a late failure
  // visible in the log instead of taking the process down.
  //
  // Guarded on `listening` so startup failures are not reported twice: while
  // binding, `ready` already carries the error out through the rejection below,
  // and logging here as well would print the same stack for one failure.
  server.on('error', (error: Error) => {
    if (server.listening) logger?.error('dsh-connect-workbuddy: loopback listener error', error)
  })

  /**
   * Resolves once the listener is up on a port the client can actually reach.
   *
   * The port is settled HERE — `listenOnClientReachablePort` re-rolls while the
   * client refuses the assigned one — so every consumer can keep resolving
   * `baseUrl()` exactly as before, with no invalidation or rebuild step. A
   * genuine bind failure still rejects, the one behaviour the caller relies on.
   */
  const ready = listenOnClientReachablePort({
    server,
    clientRefuses: clientRefusesPort,
    logger,
    cancelled: () => disposed,
  }).catch((error: unknown) => {
    // Re-rolled into the same contract the old `once('error', reject)` had, but
    // logged first: `index.ts` awaits these in a `Promise.all` with no catch of
    // its own, so a bare rejection would be easy to miss in the console.
    logger?.error('dsh-connect-workbuddy: loopback listener failed to start', error)
    throw error
  })

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('workbuddy shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map(model => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'workbuddy',
          })),
        })
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (!res.headersSent) {
        // An over-limit body is the CLIENT's error, not ours (issue #174): 413 is
        // what the protocol says, and a 500 sends the reader looking for a
        // server-side fault that does not exist. `client` is the same kind every
        // other "this request is malformed" answer uses, so nothing upstream of
        // this reads a new class.
        if (error instanceof RequestBodyTooLargeError) {
          writeOpenAIError(res, 413, 'client', error.message, 'request_too_large')
        } else {
          writeOpenAIError(res, 500, 'internal', String(error))
        }
      } else {
        res.end()
      }
    }
  }

  /**
   * Failure classes worth retrying against another account.
   *
   * `client` is deliberately NOT one of them: the upstream rejected the
   * REQUEST (malformed body, unsupported field), so every account answers the
   * same 400 and walking the rest of the pool only multiplies the wait before
   * the user sees an error they must act on anyway.
   *
   * `model_busy` is NOT one of them either, and the distinction is the whole of
   * issue #56. The 14003 throttle belongs to the MODEL — the upstream's own
   * message says so ("switch to a less busy model") and the reporter's
   * measurement confirms it: same credential, same second, other models answer.
   * So a second account does not answer better than the first; it answers the
   * same 14003, one round trip later, and each attempt writes a rate-limited
   * measurement onto an account that was never the problem. The measured outcome
   * was a pool in which every member had been taught a false fact, and a user
   * who could not talk to the model for half an hour.
   *
   * Everything else describes a PER-ACCOUNT condition — a volume limit,
   * exhausted credits, a dead session, a gateway that failed this one call —
   * which another account may well survive.
   */
  function isFailoverWorthy(kind: UpstreamErrorKind): boolean {
    // `channel_reject` joins the two non-failover kinds. The gate matches the
    // OPENING of a system message, and every account sends that same opening, so
    // the next account answers the same 11128 one round trip later — while each
    // attempt burns real quota and records a false statistic against a credential
    // that was never at fault (issues #87–#90 were reported as account problems
    // for exactly this reason).
    //
    // `model_queue` joins them for a different reason: the queue is a fact about
    // the MODEL and the platform-wide line in front of it, not about this
    // credential. The next account is put in the SAME queue with the SAME
    // position, so rotating spends one real request per account to learn nothing.
    // Before it was its own kind a queue fell through to `server`/`soft_rate`
    // (the status it rides on), both of which fail over — so one queued request
    // walked the whole pool before the user was told their position.
    return kind !== 'client' && kind !== 'model_busy' && kind !== 'channel_reject'
      && kind !== 'model_queue'
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    // Let the plugin point the store at whoever the pool's ranking picks for
    // this request BEFORE resolving. Failure is not fatal: the request then goes
    // to whatever the store already had, which is the user's own account — the
    // same behaviour as a plugin with no pool at all.
    await prepareAccount?.().catch(error => {
      logger?.warn('dsh-connect-workbuddy: pool account selection failed', error)
    })

    let credential
    try {
      credential = await store.resolve()
    } catch (error: unknown) {
      writeOpenAIError(res, 401, 'not_signed_in', String(error))
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const prepared = rewriteSessionTitleModel(prepareChatBody(raw, {
      keepPromptLast: keepPromptLastEnabled,
      extraInjectedPrefixes,
    }), sessionTitleOptions)
    // The model this request is about, read from the body that goes upstream
    // (issue #61). Read ONCE, so every attempt — the first and each failover
    // retry — is remembered against the same model.
    const requestModelId = modelIdOfBody(prepared)
    // Record WHAT goes upstream (issue #59). Handed the prepared body on purpose:
    // it is the one the upstream counts, and reading it must not change it.
    if (onRequestBody !== undefined) {
      try {
        onRequestBody(prepared)
      } catch (error: unknown) {
        // A diagnostic must never fail a chat request.
        logger?.warn('dsh-connect-workbuddy: body report failed', error)
      }
    }

    const controller = new AbortController()
    // Watch the RESPONSE, not the request.
    //
    // `req.on('close')` cannot express "the client hung up" here: Node emits it
    // as soon as the request STREAM ends — which `readBody` has already done —
    // so a listener attached after the read never fires at all (measured: the
    // signal stayed un-aborted through a real disconnect), and one attached
    // BEFORE the read fires immediately and would abort every request. The
    // response's `close` fires on actual socket teardown instead, which is the
    // event that means the reader is gone: mid-flight it aborts the upstream
    // call, and on a normal completion it arrives after `res.end` and changes
    // nothing.
    res.on('close', () => controller.abort())

    // Retry the SAME prepared body against the pool's other usable accounts,
    // in the plugin's order, until one serves it or none is left.
    //
    // Only failures raised BEFORE the stream starts reach this loop: `!ok`
    // means the upstream answered non-2xx, so not one byte has been written to
    // the client and a retry cannot splice two responses together. A stream
    // that dies MID-flight (the `body.on('error')` path below) is deliberately
    // not retried — the client already received a partial answer, and
    // replaying it would duplicate output the model may already have acted on.
    // The first attempt always uses the store's own resolution, so a token
    // refresh still happens exactly once, before any retry.
    /**
     * The body to send FIRST, which is the perturbed form once this process has
     * proven the gateway demands it, or when the user selected `always`.
     *
     * `perturbChannelFingerprints` is consulted only when the flag is set, so a
     * fresh process still pays the plain attempt — that is what discovers
     * whether the gate is on at all (see `channelNeedsPerturbation`).
     *
     * The perturbed form is a purely additive transform: it inserts zero-width
     * spaces and changes no word the model reads, so starting from it is not a
     * behaviour change, only a saved round trip.
     */
    const startPerturbed = channelPerturbation === 'always' || channelNeedsPerturbation
    const preferred = startPerturbed
      ? perturbChannelFingerprints(prepared, channelPerturbation === 'always') ?? prepared
      : prepared
    let result = await client.chatStream(credential, preferred, controller.signal)
    // A refused PERTURBED body means the rule changed under us: fall back to the
    // plain ladder and let it rediscover what works. Without this the plugin
    // could keep sending a shape that no longer helps, forever. `always` is the
    // user's explicit choice, so it is not cleared by one refusal.
    if (channelNeedsPerturbation && !result.ok && result.kind === 'channel_reject') {
      channelNeedsPerturbation = false
      logger?.warn('dsh-connect-workbuddy: a perturbed body was refused too; clearing the learned preference and retrying from the plain form')
      result = await client.chatStream(credential, prepared, controller.signal)
    }

    /**
     * The retry ladder that does not depend on knowing the fingerprint
     * (issue #98, both halves).
     *
     * The gateway refuses the request for data the plugin cannot see: a list of
     * refused `system`/`assistant` OPENINGS (the plugin holds a measured
     * SNAPSHOT, `UNAPPROVED_CHANNEL_OPENINGS`) and, since 2026-10-21, at least
     * one long substring INSIDE the prompt. Every account and every region
     * sends the same bytes, so without a rescue the only outcome is a dead end
     * the reader cannot get out of.
     *
     * Two rungs, both on the SAME credential (the gate reads the request, not
     * the account, which is why `channel_reject` is not failover-worthy):
     *
     *   1. `forceNeutralHead` — move every scanned opening behind the neutral
     *      head. Measured: whatever the banned opening is, moving it off the
     *      start of the content answers 200.
     *   2. `perturbChannelFingerprints` — insert zero-width spaces at the
     *      sentence boundaries of the scanned messages, which breaks an
     *      exact-substring fingerprint without changing a word the model reads.
     *      This is the rung that rescues the inside-the-prompt fingerprints,
     *      where rung 1 is a no-op.
     *
     * Both return `undefined` when they would change nothing; that is the
     * signal not to spend a request on a body that would be refused identically.
     *
     * Nothing has been written to the client at this point (`!ok` means the
     * upstream answered non-2xx before any stream started), so a retry cannot
     * splice two responses together. The first attempt's failure is NOT booked
     * as an account failure: it was the request that was refused, not the
     * credential.
     */
    let retriedWithForcedHead = false
    let retriedWithPerturbation = false
    let retriedWithDensePerturbation = false
    if (!result.ok && result.kind === 'channel_reject' && !controller.signal.aborted) {
      const forced = forceNeutralHead(prepared)
      if (forced !== undefined) {
        logger?.warn('dsh-connect-workbuddy: the channel gate refused the body; retrying once with the neutral head forced in front of every opening')
        result = await client.chatStream(credential, forced, controller.signal)
        retriedWithForcedHead = true
      }
      if (!result.ok && result.kind === 'channel_reject' && !controller.signal.aborted) {
        const rescued = perturbChannelFingerprints(forced ?? prepared)
        if (rescued !== undefined) {
          logger?.warn('dsh-connect-workbuddy: the channel gate refused the body again; retrying once with an invisible perturbation of the scanned text')
          result = await client.chatStream(credential, rescued, controller.signal)
          retriedWithPerturbation = true
          // THE PERTURBATION IS WHAT WORKED, so remember it: the next request
          // in this process starts perturbed and skips both doomed attempts.
          // Only set on SUCCESS — a perturbation that is also refused teaches
          // nothing about what the gateway wants.
          if (result.ok) channelNeedsPerturbation = true
        }
      }
      // The dense rescue is deliberately last: it is the least byte-conservative
      // form, and the gateway's own wording gives no hint that it would be needed.
      // It exists because both measured rungs are punctuation-dependent and a
      // fingerprinted prose span can contain no punctuation at all.
      if (!result.ok && result.kind === 'channel_reject' && !controller.signal.aborted) {
        const dense = perturbChannelFingerprints(forced ?? prepared, true)
        if (dense !== undefined) {
          logger?.warn('dsh-connect-workbuddy: the channel gate refused the sparse perturbation too; retrying once with a dense word-boundary perturbation')
          result = await client.chatStream(credential, dense, controller.signal)
          retriedWithDensePerturbation = true
          // Dense is the strongest form; remembering it is safe only for the
          // `failure` policy, which exists to learn from a successful rescue.
          if (result.ok && channelPerturbation === 'failure') channelNeedsPerturbation = true
        }
      }
    }

    const triedAccountIds: string[] = []
    /**
     * The account the request STARTED on, and the reason it was abandoned.
     *
     * `??=` on the first switch only: if three accounts fail in a row the user
     * cares that the answer did not come from the one they picked, not with a
     * blow-by-blow list of every candidate that was also rate limited.
     */
    let switchedFrom: string | undefined
    let switchedBecause: string | undefined

    /**
     * Tell the plugin about a failed attempt so it can store the measurement.
     *
     * Every failed attempt is reported exactly once, INCLUDING the last one — an
     * account that failed with nobody left to try it is precisely the one the
     * next request must avoid, so reporting only the attempts that had a
     * successor would miss the case that matters most.
     *
     * Reported after the loop rather than inside it, so the account that broke
     * out of the loop is not also reported by the post-loop call. Not awaited: the
     * user is waiting on the retry, and the write only affects later requests.
     */
    const failures: Array<{ accountId: string, failure: WorkBuddyChatResult }> = []
    const recordAttempt = (credential: WorkBuddyCredential, failure: WorkBuddyChatResult): void => {
      if (failure.ok) return
      failures.push({ accountId: workbuddyAccountId(credential), failure })
    }
    const reportFailures = (): void => {
      // Drain FIRST, unconditionally. A second call (the markup-only retry path
      // reports its own attempts) must never re-report a measurement that was
      // already stored, and every early return below has to consume what it
      // discards — an earlier version cleared this and then iterated the cleared
      // array, which silently reported nothing at all.
      const batch = failures.splice(0, failures.length)
      if (onAccountFailure === undefined) return
      // A client that hung up leaves NO measurement worth keeping.
      //
      // Our own abort surfaces as a transport failure (`status: 0`, `kind:
      // 'server'`), so it is indistinguishable from a dead network where the
      // plugin reads it — and it used to be recorded as `unavailable`, which the
      // pool then treated as a statement about the ACCOUNT. One closed panel
      // could therefore idle a healthy account, and with every member idled the
      // pool had no candidate and failover had nowhere to go.
      //
      // The retry loop already refuses to fail over for an aborted request (see
      // the `controller.signal.aborted` guard below); this is the same rule
      // applied one step later, to the bookkeeping.
      if (controller.signal.aborted) return
      for (const entry of batch) {
        if (entry.failure.ok) continue
        try {
          onAccountFailure(entry.accountId, {
            status: entry.failure.status,
            kind: entry.failure.kind,
            message: entry.failure.message,
            ...requestModelId === undefined ? {} : { modelId: requestModelId },
          })
        } catch (error: unknown) {
          // Reporting is bookkeeping; it must never take down a request.
          logger?.warn('dsh-connect-workbuddy: recording an account failure failed', error)
        }
      }
    }

    while (!result.ok && isFailoverWorthy(result.kind) && failoverAccount !== undefined) {
      // A client that hung up is not waiting for a better account.
      if (controller.signal.aborted) break
      recordAttempt(credential, result)
      triedAccountIds.push(workbuddyAccountId(credential))
      const next = await failoverAccount(triedAccountIds).catch(() => undefined)
      if (next === undefined) break
      // The policy is expected to skip what was already tried, and the shim does
      // not rely on it: a candidate that repeats one of them would re-send the
      // same request to the same account forever, spending real quota in a loop
      // with no upper bound. `triedAccountIds` is the only brake there is, so
      // the identity check lives here as well as in the policy.
      if (triedAccountIds.includes(workbuddyAccountId(next))) break
      // Wait before hitting another account: the upstream's rate limit (6004)
      // fires on request volume, so hammering it with zero-gap retries makes
      // every candidate hit the same wall — 4 accounts can fail in under a
      // second. The batch test already waits 400ms between accounts for exactly
      // this reason; the failover loop used to wait nothing. The wait is
      // abortable: if the client hung up we stop instead of sleeping on, and the
      // check AFTER it ends the loop rather than spending the remaining accounts
      // on requests whose signal is already dead.
      if (controller.signal.aborted) break
      await new Promise<void>(resolve => {
        if (controller.signal.aborted) return resolve()
        const timer = setTimeout(resolve, FAILOVER_ACCOUNT_GAP_MS)
        controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
      if (controller.signal.aborted) break
      logger?.warn(
        `dsh-connect-workbuddy: retrying chat on another pool account after ${result.kind} (http ${result.status})`,
      )
      // Remember WHY the switch happened and FROM which account, so the answer
      // can carry one line saying so. Recorded here rather than only logged: the
      // log is invisible to the person reading the reply, and a silent failover
      // is indistinguishable from the account they chose having answered.
      switchedFrom ??= describeAccount(credential)
      switchedBecause ??= failoverReasonText(result)
      credential = next
      result = await client.chatStream(credential, prepared, controller.signal)
    }
    // The final attempt's failure — recorded only if the loop did not already
    // record it (it does not: the loop records each attempt as it starts the
    // next one, and the last attempt has no next).
    if (failures.length === 0 || failures[failures.length - 1]?.accountId !== workbuddyAccountId(credential)) {
      recordAttempt(credential, result)
    }
    reportFailures()

    if (!result.ok) {
      // Say how many accounts were tried when more than one was: without it, a
      // pool that failed over and still lost reads exactly like the single
      // account the user selected failing, and the user cannot tell whether the
      // fallbacks were even attempted.
      //
      // `triedAccountIds` already holds every account that SERVED an attempt —
      // the loop pushes each one before asking for the next — so its length IS
      // the attempt count. Adding one here reported a phantom extra account.
      const attempts = triedAccountIds.length
      const note = attempts > 1 ? `（已尝试 ${attempts} 个账号）` : ''
      // WHY THERE WAS NOWHERE ELSE TO GO. Asked only when the request actually
      // failed, so the success path never pays for it, and only when a POOL
      // SEARCH really ran — which is a different question from whether the host
      // wired the callback (issue #78).
      //
      // The old test was the callback's mere presence, so every host got "池中
      // 没有其他可用账号" on every generic failure, including a plain 400 that
      // `isFailoverWorthy` excludes: the shim had not asked the pool anything,
      // yet the reply described the pool's answer as "nowhere left". Asking also
      // costs the pool a ranking pass, so a search that cannot have happened must
      // not trigger one.
      //
      // A rejected callback must not replace the real upstream failure with a
      // bookkeeping one, so a throw degrades to "no explanation" — the reply the
      // user gets is then exactly the one this option was added to improve, not
      // a worse one.
      const poolSearched =
        failoverShortfall !== undefined && failoverAccount !== undefined && isFailoverWorthy(result.kind)
      const shortfall = poolSearched ? await failoverShortfall().catch(() => undefined) : undefined
      const why = shortfall === undefined ? '' : `：${shortfall}`
      // Emit what the reply is about to say BEFORE the branches, so the model
      // card can show "this model was refused on `off`" even when the caller
      // (compaction, for one) swallows the reply text (issue #83).
      const refusedReport = refusedTierReport(result, requestModelId)
      if (refusedReport !== undefined) reportRefusedTier(refusedReport)
      // A QUEUE CONDITION IS NOT A FAILURE OF THE REQUEST. The upstream accepted
      // the call and stated where it stands in line — `6020` (waiting),
      // `6021` (queue full), `6022` (this user already holds the maximum). The
      // app answers that with a banner and a poll, never with "请求失败"; so does
      // this path, using the app's own vocabulary ("排队中 / 第 N 位") rather than
      // the raw envelope. See `src/queue.ts`.
      //
      // The KIND is what selects this branch, not a second body parse: a queue is
      // now classified as its own kind in `classifyUpstreamError`, which is also
      // what keeps it OUT of the failover loop (see `isFailoverWorthy`). Reading
      // the body again here is only to get the position and the size.
      //
      // 429 keeps the host's bounded in-place retry available: for `6020` a
      // retry is exactly the right next move (the queue is moving), and for
      // `6021`/`6022` the sentence says what to do instead of queueing.
      const queue = result.kind === 'model_queue' ? parseQueueAnswer(result.message) : undefined
      if (queue !== undefined) {
        writeOpenAIError(
          res,
          429,
          'model_queue',
          `${queueNoticeText(queue)}（上游 code ${queue.code}）${note}`,
          undefined,
          NO_RETRY_HEADERS,
        )
        return
      }
      if (result.kind === 'account_restricted') {
        // The upstream names the CREDENTIAL, not the request: 11140 + 「账号存在
        // 异常行为，已被限制使用」. Another account can serve, so this class is
        // failover-worthy and the pool records it as a measurement (issue #127).
        //
        // TWO CLAIMS THIS SENTENCE USED TO MAKE, BOTH FALSE (review #127):
        //  · 「重新登录」lifts it — it does not. The pool's account id is the
        //    sha256 of `uin`/`uid` (`auth.ts`), so a re-login produces the SAME id
        //    and the stored measurement still applies; nothing clears it. The
        //    restriction is the upstream's verdict about the account, which a new
        //    token on this machine cannot answer.
        //  · the upstream's `displayTips` is advice for THIS failure — it is not
        //    necessarily. The `11128` family is measured sharing ONE misleading
        //    `displayTips` across three different gates, so a tips string on a
        //    `11140` body is the same genre of boilerplate, and relaying it under
        //    「上游提示：」 would tell a benched account to go edit its prompt.
        const detail = result.detail
        const meta: string[] = ['账号被上游限制使用']
        if (detail?.upstreamCode !== undefined) meta.push(`code ${detail.upstreamCode}`)
        if (detail?.requestId !== undefined) meta.push(`requestId ${detail.requestId}`)
        const lead = detail?.displayMsg ?? clippedUpstreamText(result.message, 200)
        const message =
          `${lead}（${meta.join('，')}）${note}${why}。该账号已被 WorkBuddy 上游按账号限制，`
          + '与本次请求内容、网络和额度无关；插件会记录该测量并改用其他可用账号。'
          + '该限制是上游对该账号的判定：重新登录不改变插件认的这个账号，'
          + '需要 WorkBuddy 官方渠道解除后，在卡片上手动「测试」该账号才会回池'
        writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, message, hostErrorCode(result.kind))
        return
      }
      if (result.kind === 'policy_reject') {
        // A content-policy refusal is the one upstream failure whose own words
        // the user needs: the server tells them WHAT to change ("内容未通过安全
        // 审核，请调整后重试"), and the requestId is the handle support asks for.
        // The generic line below would bury both inside a truncated raw JSON
        // body, leaving the user to guess — and, because the status reads as a
        // client error, to try signing in again, which cannot help.
        //
        // `code` stays `policy_reject` rather than the upstream's numeric 11140:
        // the host routes on a stable machine-readable class, and `11140` is not
        // one it knows. Under 403 it already falls outside the retry set, so the
        // request is neither retried in place nor reported as an auth failure.
        const detail = result.detail
        // Same LAST-resort clipping as the generic path: a body that parsed
        // never reaches it, and one that did not must not end mid-word.
        const lead = detail?.displayMsg ?? clippedUpstreamText(result.message, 200)
        const meta = ['服务端策略拒绝']
        if (detail?.upstreamCode !== undefined) meta.push(`code ${detail.upstreamCode}`)
        if (detail?.requestId !== undefined) meta.push(`requestId ${detail.requestId}`)
        const message =
          // 「重新登录不会解决」was stated flatly, but `11140` is now known to hold
          // TWO meanings and the restriction half IS answered by re-authenticating
          // upstream. The matcher for that half is a sentence in the localized
          // fields, so when it misses, this reply would push the user away from the
          // one remedy that works — hence the hedge.
          `${lead}（${meta.join('，')}）${note}。该请求被 WorkBuddy 服务端策略拒绝；` +
          '若上游的说明指向内容，重新登录不会解决，可在 WorkBuddy 桌面端用同一账号验证；' +
          '若它指向账号本身，则需要走官方渠道处理，插件会在遇到该措辞时另行标明'
        writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, message, hostErrorCode(result.kind))
        return
      }
      if (result.kind === 'model_busy') {
        // The upstream's own advice, made actionable.
        //
        // A 14003 is not the user's account being limited, and saying so would
        // send them to fix something that is not broken (add accounts, wait half
        // an hour, re-sign-in). The upstream already says what is wrong and what
        // to do — "建议等待约 1 分钟后重试，或切换到负载较低的模型" — so the reply
        // says it too, and the plugin deliberately does NOT switch accounts on
        // this failure: every account shares the model, so a retry elsewhere
        // would spend a request to be told the same thing (issue #56).
        //
        // The reply reaches the user only after the HOST's bounded in-place
        // retry is spent, because `code: model_busy` now classifies as
        // `RATE_LIMIT` (issue #84 — see KIND_HOST_CODE). The sentence says so,
        // otherwise the user reads "wait a minute" about a request that was
        // already retried five times and concludes the plugin did nothing.
        const detail = result.detail
        // Same LAST-resort clipping as the generic path: a body that parsed
        // never reaches it, and one that did not must not end mid-word.
        const lead = detail?.displayMsg ?? clippedUpstreamText(result.message, 200)
        const meta = ['模型当前负载较高']
        if (detail?.upstreamCode !== undefined) meta.push(`code ${detail.upstreamCode}`)
        if (detail?.requestId !== undefined) meta.push(`requestId ${detail.requestId}`)
        const message =
          `${lead}（${meta.join('，')}）${note}。这不是账号被限流，也与积分、额度无关——` +
          '同一凭据下换一个模型即可正常使用；插件不会为此切换账号，因为该限制跟随模型本身。' +
          '这类失败会被自动重试几次；若仍然失败，请等待约 1 分钟后重试，或切换到负载较低的模型'
        writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, message, hostErrorCode(result.kind))
        return
      }
      if (result.kind === 'channel_reject') {
        // The one failure where the evidence lives in the REQUEST we just sent,
        // not in the upstream's reply. `displayTips` blames "channel verification
        // / a non-official client", which is what sent issues #87–#98's
        // reporters to try other accounts, other regions and even the official
        // client — none of which can change a byte of the request.
        //
        // TWO corrections to what this branch used to do, both measured on the
        // live CN gateway on 2026-10-21:
        //
        //   1. The gate scans `system` AND `assistant` messages, at the START
        //      of each content (or of every text part). A history message that
        //      opens with a refused identity poisons the WHOLE session: every
        //      later request is refused, and "another session on the same
        //      account works" is exactly what that looks like from outside.
        //   2. The old excerpt was read from `prepared` — the bytes after the
        //      plugin's own neutralising prepend — so the first line it could
        //      report was the plugin's placeholder `You are a helpful
        //      assistant.`, and issue #98's reporters were told that the
        //      gateway had refused the plugin's own head.
        //
        // So the excerpt is read from `raw`, the body the HOST sent, and every
        // opening is labelled with its role and with whether the plugin already
        // covers it. Nothing is claimed about WHICH line the gateway matched:
        // the upstream never says, and pretending to know is what misdirected
        // the readers of issues #87–#98.
        const detail = result.detail
        const meta: string[] = []
        if (detail?.upstreamCode !== undefined) meta.push(`code ${detail.upstreamCode}`)
        if (detail?.requestId !== undefined) meta.push(`requestId ${detail.requestId}`)
        const stamp = meta.length === 0 ? '' : `（${meta.join('，')}）`
        const evidence = channelEvidenceText(raw)
        const retries: string[] = []
        if (retriedWithForcedHead) retries.push('强制中性头')
        if (retriedWithPerturbation) retries.push('一次不可见扰动')
        if (retriedWithDensePerturbation) retries.push('一次密集不可见扰动')
        const retryNote = retries.length === 0 ? '' : `，并已用${retries.join('与')}重试过`
        // ISSUE #113: WHICH MEMBER of the `11128` family this is, decided by the
        // plugin's OWN evidence rather than by the upstream's `msg` — which
        // issue #113 measured to misreport a content refusal as
        // `conversation id missing`. The member decides the ADVICE: a header
        // problem is the user's to check, a prompt problem is the plugin's to
        // keep working on, and an unrecognised one is honestly named as such
        // rather than guessed at.
        const member = channelGateMemberOf(result.message, requestEvidenceOf(prepared))
        // `detail.msg` is the upstream's own sentence, quoted verbatim so a
        // reporter and support read the same words. It is echoed for the
        // members the plugin can DISPROVE as well, because "what arrived" and
        // "why it cannot be true" are two different facts and the reader needs
        // both: without the echo they cannot tell what they are up against.
        const said = detail?.rawMsg ?? detail?.displayMsg
        const echo = said === undefined ? '' : `上游的 msg 是「${said}」，`
        // A `prompt` member whose body NAMES another gate is the misreport
        // issue #113 measured: the wording points at a header or a shape
        // problem, but the plugin's own request disproves it, so the refusal
        // is about the content. Saying that explicitly is the difference
        // between "the gateway wants your headers fixed" (wrong, unfixable)
        // and "the gateway is fingerprinting what you sent" (right, and the
        // plugin has just retried for it).
        const memberNote = member === 'headers'
          ? `${echo}但本次请求已经带上了会话 id 三件套（X-Conversation-ID / -Request-ID / -Message-ID），所以这条措辞是上游误报；`
          : member === 'first_message'
            ? `${echo}但本次请求的首条消息就是 system；`
            : member === 'prompt'
              ? (isConversationIdGateBody(result.message)
                  ? `${echo}但本次请求已经带上了会话 id 三件套（X-Conversation-ID / -Request-ID / -Message-ID），所以这条措辞是上游误报，实际被拒的是请求内容；`
                  : isFirstMessageGateBody(result.message)
                    ? `${echo}但本次请求的首条消息就是 system，所以这条措辞是上游误报，实际被拒的是请求内容；`
                    : '')
              : `${echo}它属于 11128 这一族但没点名是哪一道门，插件按渠道校验统一处理；`
        // Same `workbuddy 上游失败：…（http N）` frame as every other failure, on
        // purpose: reporters paste this sentence into issues verbatim, so the
        // shape they search for must not change just because the diagnosis did.
        const message =
          `workbuddy 上游失败：${failoverReasonText(result)}（http ${result.status}）${note}${stamp}。${memberNote}${evidence}` +
          '该请求被 WorkBuddy 网关的渠道校验拦截，上游把它描述成「不是官方客户端发出的」，但那是误导性文案：' +
          '网关匹配的是每一条 system 与 assistant 消息的开头，与账号、积分、额度、网络都无关，换账号或换区域也不会改变结果。' +
          '插件已对已知的第三方 agent 指纹做归一化' + retryNote +
          '；若上面标着「不在插件已知名单里」的开头来自宿主或其他插件，请修改该提示；新的指纹可反馈到 issue 里'
        writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, message, hostErrorCode(result.kind))
        return
      }
      // The generic path, and the one a quota failure takes. It now names WHY
      // every account was refused (the pool's own verdict, from
      // `failoverShortfall`) and points at the model as the remaining move.
      //
      // "换一个模型" is the honest advice rather than a suggestion to add
      // accounts: the pool has just searched every member, so the user's next
      // action should be the one the search could not take for them. Saying only
      // "the request failed" left them to guess between four remedies, three of
      // which the plugin had already ruled out.
      //
      // The BODY of the sentence is now the upstream's own advice, in this order
      // of preference (issue #78):
      //   1. `detail.tips` — what to do about it ("请新建任务、换个模型或稍后重试");
      //   2. `detail.displayMsg` — what was rejected, when no tips came;
      //   3. the raw body, clipped — only for a body that did not parse.
      // The old code spliced `message.slice(0, 400)` unconditionally, which for a
      // JSON envelope is the code/requestId/extError skeleton: the actionable
      // sentence always fell past the cut and the reply stopped mid-word.
      //
      // `code`/`requestId` survive as a compact parenthetical: they are exactly
      // what support asks for, and they used to be reachable only by reading the
      // chopped-up JSON.
      const detail = result.detail
      const meta: string[] = []
      if (detail?.upstreamCode !== undefined) meta.push(`code ${detail.upstreamCode}`)
      if (detail?.requestId !== undefined) meta.push(`requestId ${detail.requestId}`)
      const stamp = meta.length === 0 ? '' : `（${meta.join('，')}）`
      // An `off`-tier refusal is the one parameter rejection this plugin can name
      // itself (issue #83), and the reader cannot act on the generic sentence:
      // the remedy is unticking one checkbox, not "adjust the request".
      const refusedTier = reasoningTierRefusal(result)
      const receipt = refusedTier
        ?? detail?.tips
        ?? detail?.displayMsg
        ?? clippedUpstreamText(result.message, 400)
      // A `client` failure is the one class the pool never searched (issue #78),
      // so the advice must not imply an account problem at all: the same request
      // is refused by every account, and the fix is in the request or the model.
      // The pool sentence is emitted only when a search really produced a verdict.
      const advice = refusedTier !== undefined
        ? '这不是账号或网络问题：该模型实测拒绝「off」推理档位，请到模型卡片里取消该行的「可关闭思考」勾选后重试'
        : result.kind === 'client'
          ? '该请求被上游按参数拒绝：与网络、账号、额度都无关，换账号也不会改变结果，请按上面的提示调整后重试'
          : shortfall === undefined
            ? ''
            : '建议换一个模型继续，或稍后等待该账号的额度恢复'
      // `displayTips` and most `msg` bodies already end in a full stop, so gluing
      // an advice sentence on would read "。。" — the upstream's sentence is left
      // exactly as it arrived, minus that final stop, and the join supplies one.
      //
      // The receipt is `displayTips`, and that paragraph is the same
      // "possibly not an official client" sentence for every member of the
      // `11128` family — quoting it as the actionable part is what made these
      // reports cycle through account and region swaps. The channel_reject
      // branch above therefore owns the whole reply for this family, and by the
      // time control reaches here the body is not that family at all.
      // ISSUE #101: the host recognises a context overflow by matching the error
      // text against ~25 ENGLISH patterns, and the gateway's own sentence for
      // `11115` is Chinese with no numbers — so it matched nothing, the host's
      // compaction rescue never ran, and the user got a bare 400 whose advice
      // ("请精简内容") the host could not act on. The English clause goes FIRST so
      // a detector reading the head of the message sees it, and the upstream's
      // own sentence stays right after it so the human still gets the real advice.
      const overflow = isContextTooLongBody(result.message)
        ? `${CONTEXT_OVERFLOW_MARKER}。`
        : ''
      const body = `${overflow}${advice === '' ? receipt : `${receipt.replace(/[。.]$/u, '')}。${advice}`}`
      writeOpenAIError(
        res,
        KIND_STATUS[result.kind],
        result.kind,
        `workbuddy 上游失败：${failoverReasonText(result)}（http ${result.status}）${note}${why}${stamp}。${body}`,
        hostErrorCode(result.kind),
      )
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    // Gate 3 reads the request's own declarations. `prepareChatBody` already
    // deleted `tools` for a `tool_choice: "none"` request, so "nothing was
    // declared" arrives here as `undefined` rather than as a rule to remember.
    const declared = declaredTools(prepared)
    const gate: RecoveryGate | undefined = declared === undefined ? undefined : {
      declaredNames: declared.names,
      requiredParameters: declared.requiredParameters,
      acceptedParameters: declared.acceptedParameters,
      // The name-less invoke (session-333b5f2d) is recovered from the model's
      // own parameter tags against these schemas — see `inferFromSchema`.
      inferFromSchema: true,
      // Issue #152: a DECLARED name one edit away from exactly one offered tool
      // (`pwdsh` for `pwsh`) is read as that tool instead of falling back to
      // plain text. Same rule as above — only ever a name already on offer.
      repairNearMissName: true,
      ...declared.pinnedToolName === undefined ? {} : { pinnedToolName: declared.pinnedToolName },
    }

    // The notice travels with the STREAM, not with this function: only the
    // stream knows whether any content actually reaches the client, and a
    // retry that ended in an error response leaves nothing to prefix.
    const notice = switchedFrom === undefined || switchedBecause === undefined
      ? undefined
      : failoverNoticeText(switchedFrom, switchedBecause)
    const writer = new RecoveryStream(res, gate, logger, notice, onUpstreamUsage)
    await writer.consume(result.response.body)

    // The one outcome that can only be recognised AFTER the stream: the turn
    // wrote markup and nothing else, so there was never any answer to show.
    // Retrying is safe here for exactly one reason — nothing has been written,
    // because a turn that is still only markup is still being held. That is why
    // the hold exists, and why an ordinary answer never pays for it.
    if (gate !== undefined && !writer.delivered && writer.residueSeen && !controller.signal.aborted) {
      logger?.warn('dsh-connect-workbuddy: the turn produced DSML markup only; retrying it once')
      const retryTried = [...triedAccountIds, workbuddyAccountId(credential)]
      let retryCredential = credential
      for (;;) {
        const attempt = await client.chatStream(retryCredential, prepared, controller.signal)
        if (attempt.ok) {
          // The first attempt's held bytes are dropped, not shown: showing them
          // and then the retry would be the two-answers-spliced-together failure
          // the failover loop refuses to risk.
          writer.discard()
          const retried = new RecoveryStream(res, gate, logger)
          await retried.consume(attempt.response.body)
          retried.finish()
          reportFailures()
          return
        }
        recordAttempt(retryCredential, attempt)
        if (!isFailoverWorthy(attempt.kind) || failoverAccount === undefined) break
        if (controller.signal.aborted) break
        const next = await failoverAccount(retryTried).catch(() => undefined)
        if (next === undefined) break
        if (retryTried.includes(workbuddyAccountId(next))) break
        retryTried.push(workbuddyAccountId(next))
        retryCredential = next
      }
      // Nobody could be made to answer: fall back to showing what actually
      // arrived, which is the honest outcome and loses no text.
      logger?.warn('dsh-connect-workbuddy: markup-only retry did not start; showing the original text')
    }

    writer.finish()
    reportFailures()
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => new Promise<void>(resolve => {
      disposed = true
      // `disposed` above is what actually stops a re-roll in flight; this call
      // is for the ordinary case of a listener that is up.
      //
      // The callback is not assumed to fire only when listening: measured on
      // Node 24, it fires in every state, reporting `ERR_SERVER_NOT_RUNNING`
      // when the listener is down — which is exactly the state a dispose can
      // land in, between a `close()` and the next `listen()` of a re-roll. So
      // the callback alone settles this, and the error argument is ignored on
      // purpose: "already down" is a satisfied precondition, not a failure.
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}
