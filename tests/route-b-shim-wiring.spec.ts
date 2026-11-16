/**
 * Route B at the SHIM boundary: the host session id travels from pi-ai as an
 * `x-session-affinity` HEADER on the loopback request, and the shim must turn
 * it into a domain-separated upstream `X-Conversation-ID` — without ever
 * forwarding the raw session id. `src/upstream.spec.ts` covers the pure digest;
 * this file pins the wiring that only exists once the options cross the shim.
 *
 * All ids here are invented fixtures; no real session/account value is used.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyUpstreamClient, WorkBuddyChatResult } from '../src/upstream.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { classifyUpstreamError } from '../src/upstream.ts'

let shim: WorkBuddyShim | undefined
afterEach(async () => { await shim?.close(); shim = undefined })

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAtMs: Date.now() + 86_400_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid',
  source: 'desktop',
  filePath: '/tmp/auth.info',
}

const store = {
  resolve: async () => CREDENTIAL,
} as unknown as import('../src/auth.ts').WorkBuddyCredentialStore

function streamOf(): WorkBuddyChatResult {
  const encoder = new TextEncoder()
  const frame = 'data: ' + JSON.stringify({
    id: 'c1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
  }) + '\n\ndata: [DONE]\n\n'
  return {
    ok: true,
    response: new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(frame)); controller.close() },
    })),
  }
}

const BODY = JSON.stringify({
  model: 'hy4free',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'hello' },
  ],
})

interface Seen { conversationId: string | undefined }

/** A scripted channel-gate refusal on the first attempt, then success. */
function channelReject(): WorkBuddyChatResult {
  const body = JSON.stringify({ code: 11128, msg: 'unapproved channel' })
  return {
    ok: false,
    status: 400,
    kind: classifyUpstreamError(400, body),
    message: body,
  }
}

function makeShim(opts: {
  enabled?: boolean
  /** If true, fail the first attempt with a channel rejection to exercise the retry ladder. */
  rejectFirst?: boolean
} = {}): {
  shim: WorkBuddyShim
  seen: Seen[]
} {
  const seen: Seen[] = []
  let n = 0
  const created = createWorkBuddyShim({
    store,
    client: {
      chatStream: async (
        _credential: WorkBuddyCredential,
        _body: string,
        _signal: AbortSignal | undefined,
        conversationId?: string,
      ): Promise<WorkBuddyChatResult> => {
        seen.push({ conversationId })
        n += 1
        if (opts.rejectFirst === true && n === 1) return channelReject()
        return streamOf()
      },
    } as unknown as WorkBuddyUpstreamClient,
    catalog: new WorkBuddyCatalog(),
    sessionConversationId: () => opts.enabled === true,
  })
  return { shim: created, seen }
}

async function post(
  target: WorkBuddyShim,
  headers: Record<string, string> = {},
): Promise<void> {
  await target.ready
  const response = await fetch(`${target.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${target.token()}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: BODY,
  })
  expect(response.status).toBe(200)
  await response.text()
}

describe('route B shim wiring', () => {
  it('maps x-session-affinity to an id; never forwards the raw header', async () => {
    const made = makeShim({ enabled: true })
    shim = made.shim
    await post(shim, { 'x-session-affinity': 'session-alpha' })
    expect(made.seen).toHaveLength(1)
    const id = made.seen[0]!.conversationId
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // The digest must not equal the literal session value.
    expect(id).not.toBe('session-alpha')
  })

  it('reuses ONE id across every attempt of a single request (channel-reject ladder)', async () => {
    // The first attempt is refused with `channel_reject`, so the retry ladder
    // re-sends a forced/rescued body. Both attempts must carry the SAME id:
    // the shim computes it once before the ladder, not per attempt.
    const made = makeShim({ enabled: true, rejectFirst: true })
    shim = made.shim
    await post(shim, { 'x-session-affinity': 'session-stable' })
    expect(made.seen.length).toBeGreaterThanOrEqual(2)
    const first = made.seen[0]!.conversationId
    expect(first).toBeDefined()
    for (const attempt of made.seen) {
      expect(attempt.conversationId).toBe(first)
    }
  })

  it('passes undefined when the switch is OFF — default shape unchanged', async () => {
    const made = makeShim({ enabled: false })
    shim = made.shim
    await post(shim, { 'x-session-affinity': 'session-alpha' })
    expect(made.seen).toHaveLength(1)
    expect(made.seen[0]!.conversationId).toBeUndefined()
  })

  it('passes undefined when the header is absent even with the switch ON', async () => {
    const made = makeShim({ enabled: true })
    shim = made.shim
    await post(shim)
    expect(made.seen).toHaveLength(1)
    expect(made.seen[0]!.conversationId).toBeUndefined()
  })

  it('ignores an oversized header (no unbounded digest input)', async () => {
    const made = makeShim({ enabled: true })
    shim = made.shim
    await post(shim, { 'x-session-affinity': 'x'.repeat(257) })
    expect(made.seen).toHaveLength(1)
    expect(made.seen[0]!.conversationId).toBeUndefined()
  })

  it('different sessions in different requests get different ids', async () => {
    const made = makeShim({ enabled: true })
    shim = made.shim
    await post(shim, { 'x-session-affinity': 'alpha' })
    await post(shim, { 'x-session-affinity': 'beta' })
    expect(made.seen).toHaveLength(2)
    expect(made.seen[0]!.conversationId).toBeDefined()
    expect(made.seen[1]!.conversationId).toBeDefined()
    expect(made.seen[0]!.conversationId).not.toBe(made.seen[1]!.conversationId)
  })

  it('a live-toggled switch applies on the very next request', async () => {
    let enabled = false
    const made = makeShim({ enabled: false })
    // Rebuild the shim with a live getter reading the mutable `enabled`.
    await made.shim.close()
    const created = createWorkBuddyShim({
      store,
      client: {
        chatStream: async (
          _c: WorkBuddyCredential,
          _b: string,
          _s: AbortSignal | undefined,
          conversationId?: string,
        ): Promise<WorkBuddyChatResult> => {
          made.seen.push({ conversationId })
          return streamOf()
        },
      } as unknown as WorkBuddyUpstreamClient,
      catalog: new WorkBuddyCatalog(),
      sessionConversationId: () => enabled,
    })
    shim = created
    await post(created, { 'x-session-affinity': 'alpha' }) // OFF
    enabled = true
    await post(created, { 'x-session-affinity': 'alpha' }) // ON
    expect(made.seen).toHaveLength(2)
    expect(made.seen[0]!.conversationId).toBeUndefined()
    expect(made.seen[1]!.conversationId).toBeDefined()
  })
})
