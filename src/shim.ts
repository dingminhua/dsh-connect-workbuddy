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
import { prepareChatBody, WorkBuddyUpstreamClient, type UpstreamErrorKind, type WorkBuddyChatResult } from './upstream.ts'

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

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
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
      if (onAccountFailure === undefined) return
      for (const entry of failures) {
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
      )
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let sawDone = false
    const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (chunk: Buffer) => {
      if (chunk.includes('[DONE]')) sawDone = true
    })
    body.on('error', (error: unknown) => {
      logger?.warn('dsh-connect-workbuddy: upstream stream failed mid-flight', error)
      if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
    })
    body.pipe(res)
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
