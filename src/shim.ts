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
 * 改动：无。安全相关代码不做「改善」，原样沿用。

 * @module dsh-connect-workbuddy/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { WorkBuddyCredential, WorkBuddyCredentialStore } from './auth.ts'
import { workbuddyAccountId } from './auth.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import { DsmlStreamBuffer } from './dsml-recovery.ts'
import type { RecoveredToolCall, RecoveryGate } from './dsml-recovery.ts'
import {
  declaredTools,
  prepareChatBody,
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

/** Constructor dependencies. */
export interface WorkBuddyShimOptions {
  store: WorkBuddyCredentialStore
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>
  catalog: WorkBuddyCatalog
  logger?: ShimLogger
  /**
   * Pool failover for chat requests. Absent means no failover at all — the
   * pre-pool behaviour, where the selected account serves and its failure is
   * reported as-is.
   */
  failoverAccount?: WorkBuddyFailoverAccount
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

/** Loopback hostnames the shim's own in-process client uses. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

/**
 * The request's Host header must name the loopback interface. A DNS-rebinding
 * page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
 * Host, so this check drops those before any routing happens.
 */
function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/**
 * A browser-sent Origin (present header) must be loopback. Non-browser
 * clients (the plugin's own fetch calls) send no Origin at all and pass.
 */
function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
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

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
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
function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string, code?: string): void {
  writeJson(res, status, { error: { message, type: kind, code: code ?? kind } })
}

/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
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

  constructor(
    private readonly res: ServerResponse,
    gate: RecoveryGate | undefined,
    private readonly logger: ShimLogger | undefined,
  ) {
    this.buffer = gate === undefined ? undefined : new DsmlStreamBuffer(gate)
  }

  /** True when a call or real prose has reached the client. */
  get delivered(): boolean {
    return this.wroteContent
  }

  /** True when the held bytes contain markup the gates refused. */
  get residueSeen(): boolean {
    return this.sawResidue
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
    if (tail !== '') this.handleFrame(tail)
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
    if (!this.sawDone && this.res.writable) this.res.write('data: [DONE]\n\n')
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

  /** Handle one complete frame, rewriting it only when recovery produced something. */
  private handleFrame(frame: string): void {
    const payload = dataPayload(frame)
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
      this.closeWindow()
      this.res.write(frame)
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
      this.send(callsFrame(chunk, choiceRecord, outcome.calls), false)
      this.wroteContent = true
      this.closeWindow()
      // Any text the same chunk also carried still belongs to the client.
      if (outcome.text !== '') this.res.write(contentFrame(chunk, choiceRecord, outcome.text))
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
      this.res.write(frame)
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
    for (const entry of pending) this.res.write(entry.frame)
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
 * Start the loopback endpoint. Requests must carry the shim's shared secret;
 * the loopback bind alone is not a trust boundary.
 */
export function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim {
  const { store, client, catalog } = options
  const logger = options.logger
  const failoverAccount = options.failoverAccount
  const prepareAccount = options.prepareAccount
  const onAccountFailure = options.onAccountFailure

  // Per-process shared secret. Lives only in memory; the adapter resolves it
  // as the OpenAI apiKey, which pi-ai sends as `Authorization: Bearer ...`.
  // The shim never forwards it upstream — the real credential comes from the
  // store. A local attacker who can hit the port still cannot forge this.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

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

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  server.listen(0, '127.0.0.1')

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
        writeOpenAIError(res, 500, 'internal', String(error))
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
   * the user sees an error they must act on anyway. Everything else describes a
   * PER-ACCOUNT condition — a rate limit, exhausted credits, a dead session, a
   * gateway that failed this one call — which another account may well survive.
   */
  function isFailoverWorthy(kind: UpstreamErrorKind): boolean {
    return kind !== 'client'
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
    const prepared = prepareChatBody(raw)

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
    let result = await client.chatStream(credential, prepared, controller.signal)
    const triedAccountIds: string[] = []

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
      const note = attempts > 1 ? ` (after trying ${attempts} accounts)` : ''
      writeOpenAIError(
        res,
        KIND_STATUS[result.kind],
        result.kind,
        `workbuddy upstream ${result.kind} (http ${result.status})${note}: ${result.message.slice(0, 400)}`,
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
      ...declared.pinnedToolName === undefined ? {} : { pinnedToolName: declared.pinnedToolName },
    }

    const writer = new RecoveryStream(res, gate, logger)
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
    close: () => new Promise<void>((resolve, reject) => {
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}
