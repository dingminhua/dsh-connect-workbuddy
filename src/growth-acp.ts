/**
 * Console ACP session — the ONLY way to light up "today is active" (issue #286).
 *
 * The plugin already sends model traffic through `/v2/chat/completions`. That
 * path bills normally but leaves the growth heatmap at `score: 0` /
 * `is_active: false` — the reporter measured it directly. The upstream counts a
 * "real conversation" ONLY through the console ACP channel:
 *
 *   1) POST /console/as/conversations/          → data.{id, session:{link,token,sessionId}}
 *   2) GET  /console/as/conversations/{id}/session   (only when step 1 omitted link/token)
 *   3) GET  {session.link}  (Accept: text/event-stream) → header `acp-connection-id`
 *   4) POST {session.link}  JSON-RPC 2.0: initialize, then session/prompt
 *   best-effort DELETE {session.link} to close the connection.
 *
 * Design rules carried over from the reporter's tested reference:
 *   - `session.link` may already end in `/acp` or `/api/v1/acp`; otherwise
 *     `/api/v1/acp` is appended. Normalizing twice must be a no-op.
 *   - The prompt is ONE short turn ("你好" by default). The CALLER chooses the
 *     model from the region's own catalog — CN and global rosters differ, so
 *     this module never hardcodes a model id.
 *   - Every network detail is injected (`fetch`, `now`, `sleep`) so the state
 *     machine is unit-testable with no Host, no clock, and no socket.
 *   - `activateGrowth` is IDEMPOTENT: it reads the heatmap first and sends NO
 *     session when the account is already active today.
 *
 * This module deliberately knows nothing about settings, pools, or regions. It
 * is the protocol layer; policy lives in the batch runner.
 *
 * @module dsh-connect-workbuddy/growth-acp
 */

/** What one activation attempt reports. Never throws. */
export interface GrowthActivationResult {
  status: 'already-active' | 'activated' | 'failed'
  /** The heatmap score AFTER a confirmed activation, when known. */
  score?: number
  /** Conversation id of the session we sent, when one was sent. */
  conversationId?: string
  /** Human-readable reason on failure. */
  reason?: string
}

/** The pieces of heatmap state this module needs. */
export interface GrowthHeatmapReader {
  (): Promise<{ isActive: boolean; score: number } | undefined>
}

/** Constructor options; all network/clock seams are injectable. */
export interface GrowthAcpOptions {
  /** Base host for the console API, already region-resolved by the caller. */
  base: string
  /** Bearer token of the account being activated. */
  accessToken: string
  /** Origin/Referer for the console API (the account's own base). */
  origin: string
  /** The model id to use for the single prompt. */
  model: string
  /** Prompt text; defaults to a short greeting. */
  prompt?: string
  /** User-agent fragment for console requests. */
  userAgent?: string
  /** Injected fetch (defaults to the global one). */
  fetch?: typeof globalThis.fetch
  /** Read today's heatmap, for the idempotency guard and post-send verify. */
  heatmap: GrowthHeatmapReader
  /** Sleep between verification polls; injected for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Verification attempts after sending; defaults to 4. */
  verifyAttempts?: number
  /** Verification gap in ms; defaults to 1500. */
  verifyIntervalMs?: number
}

/** Normalize a session link to its ACP endpoint, without duplicating the suffix. */
export function resolveAcpEndpoint(link: string): string {
  let value = (link ?? '').trim().replace(/^http:\/\//u, 'https://').replace(/\/+$/u, '')
  if (value === '') return ''
  if (/\/api\/v1\/acp$/u.test(value) || /\/acp$/u.test(value)) return value
  return `${value}/api/v1/acp`
}

/** Parse an SSE body: yield the JSON payloads of `data:` lines with the given id. */
export function rpcResultFromSse(text: string, id: number): Record<string, unknown> | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed.slice(5).trim())
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const message = parsed as Record<string, unknown>
    if (message['id'] !== id) continue
    if (message['error'] !== undefined) {
      throw new Error(`ACP RPC error: ${String(message['error']).slice(0, 200)}`)
    }
    return typeof message['result'] === 'object' && message['result'] !== null
      ? message['result'] as Record<string, unknown>
      : {}
  }
  return undefined
}

/** Send one console ACP session; returns its conversation id. Throws on failure. */
async function sendAcpSession(options: GrowthAcpOptions): Promise<string> {
  const doFetch = options.fetch ?? globalThis.fetch
  const base = options.base.replace(/\/+$/u, '')
  const ua = options.userAgent ?? 'WorkBuddy/5.8.3'
  const jsonHeaders = (token: string): Record<string, string> => ({
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'x-codebuddy-request': '1',
    'x-client-platform': 'web',
    'user-agent': ua,
    'authorization': `Bearer ${token}`,
    'origin': options.origin,
    'referer': `${options.origin.replace(/\/+$/u, '')}/`,
  })

  // Step 1: create the conversation. Some builds reject the `plugins` field,
  // so retry once without it on 400/404 (the reporter hit both spellings).
  let created: Record<string, unknown> | undefined
  let lastError = ''
  for (const withPlugins of [true, false]) {
    const body: Record<string, unknown> = { prompt: options.prompt ?? '你好', model: options.model }
    if (withPlugins) body['plugins'] = []
    try {
      const response = await doFetch(`${base}/console/as/conversations/`, {
        method: 'POST',
        headers: jsonHeaders(options.accessToken),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })
      if (response.ok) {
        const parsed: unknown = await response.json()
        created = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
        break
      }
      lastError = `HTTP ${response.status}`
      if (response.status !== 400 && response.status !== 404) break
    } catch (error: unknown) {
      lastError = String(error)
      break
    }
  }
  if (created === undefined) throw new Error(`ACP create conversation failed: ${lastError}`)

  const data = typeof created['data'] === 'object' && created['data'] !== null
    ? created['data'] as Record<string, unknown>
    : created
  const id = String(
    data['id'] ?? data['conversationId'] ?? (data['info'] as Record<string, unknown> | undefined)?.id ?? '',
  )
  if (id === '') throw new Error('ACP create response had no conversation id')

  // Step 2: fetch the session link/token if the create response omitted them.
  let session = typeof data['session'] === 'object' && data['session'] !== null
    ? data['session'] as Record<string, unknown>
    : undefined
  if (session === undefined || typeof session['link'] !== 'string' || typeof session['token'] !== 'string') {
    const response = await doFetch(`${base}/console/as/conversations/${encodeURIComponent(id)}/session`, {
      method: 'GET',
      headers: jsonHeaders(options.accessToken),
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`ACP fetch session failed: HTTP ${response.status}`)
    const parsed: unknown = await response.json()
    const sdata = typeof parsed === 'object' && parsed !== null
      ? parsed as Record<string, unknown>
      : {}
    session = typeof sdata['data'] === 'object' && sdata['data'] !== null
      ? sdata['data'] as Record<string, unknown>
      : sdata
  }

  const link = resolveAcpEndpoint(
    String(session?.['link'] ?? session?.['endpoint'] ?? ''),
  )
  const sessionToken = String(session?.['token'] ?? session?.['accessToken'] ?? '')
  const sessionId = String(session?.['sessionId'] ?? session?.['session_id'] ?? '')
  if (link === '' || sessionToken === '' || sessionId === '') {
    throw new Error('ACP session response missing link/token/sessionId')
  }

  // Step 3: open the SSE connection and read the connection id from HEADERS.
  const openResponse = await doFetch(link, {
    method: 'GET',
    headers: { ...jsonHeaders(sessionToken), 'accept': 'text/event-stream' },
    signal: AbortSignal.timeout(60_000),
  })
  const connectionId = openResponse.headers.get('acp-connection-id') ?? ''
  if (connectionId === '') throw new Error('ACP SSE response missing acp-connection-id')

  // Step 4: initialize + session/prompt JSON-RPC, reading SSE data frames.
  const rpc = async (method: string, params: Record<string, unknown>, rpcId: number): Promise<void> => {
    const response = await doFetch(link, {
      method: 'POST',
      headers: {
        ...jsonHeaders(sessionToken),
        'accept': 'application/json, text/event-stream',
        'acp-connection-id': connectionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`ACP RPC ${method} failed: HTTP ${response.status}`)
    const text = await response.text()
    rpcResultFromSse(text, rpcId)
  }

  await rpc('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'dsh-connect-workbuddy', version: '1.0' },
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      _meta: { 'codebuddy.ai': { question: false, terminalOutput: false } },
    },
  }, 1)
  await rpc('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: options.prompt ?? '你好' }],
  }, 2)

  // Best-effort close — a failure here must not fail an otherwise-lit session.
  try {
    await doFetch(link, {
      method: 'DELETE',
      headers: { ...jsonHeaders(sessionToken), 'acp-connection-id': connectionId },
      signal: AbortSignal.timeout(10_000),
    })
  } catch { /* ignore */ }

  return id
}

/**
 * Ensure the account is active today. Idempotent: already-active sends nothing.
 * After sending, polls the heatmap up to `verifyAttempts` times to confirm the
 * write landed before reporting success.
 */
export async function activateGrowth(options: GrowthAcpOptions): Promise<GrowthActivationResult> {
  const before = await options.heatmap()
  if (before?.isActive === true) {
    return { status: 'already-active', score: before.score }
  }
  let conversationId: string
  try {
    conversationId = await sendAcpSession(options)
  } catch (error: unknown) {
    return { status: 'failed', reason: String(error) }
  }
  const sleep = options.sleep ?? (async (ms: number) => { await new Promise<void>(resolve => setTimeout(resolve, ms)) })
  const attempts = options.verifyAttempts ?? 4
  const gap = options.verifyIntervalMs ?? 1500
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await sleep(gap)
    const now = await options.heatmap()
    if (now?.isActive === true) {
      return { status: 'activated', score: now.score, conversationId }
    }
  }
  return {
    status: 'failed',
    conversationId,
    reason: 'ACP session sent but heatmap today.is_active stayed false',
  }
}
