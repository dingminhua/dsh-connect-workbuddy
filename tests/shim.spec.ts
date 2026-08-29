import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'

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

/** Loosely-typed client: tests supply only the one method the shim calls. */
type TestClient = {
  chatStream: (credential: WorkBuddyCredential, body: string, signal?: AbortSignal) => Promise<WorkBuddyChatResult>
}

function makeShim(client: Partial<TestClient> & Record<string, unknown>): WorkBuddyShim {
  return createWorkBuddyShim({
    store,
    client: client as unknown as import('../src/upstream.ts').WorkBuddyUpstreamClient,
    catalog: new WorkBuddyCatalog(),
  })
}

/**
 * Send a raw HTTP request so the Host header is fully under test control.
 *
 * `fetch` derives the Host header from the URL and ignores attempts to set
 * it, so a DNS-rebinding simulation (attacker domain in Host) needs a raw
 * socket write.
 */
async function rawRequest(
  shim: WorkBuddyShim,
  options: { method?: string; path?: string; host?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  const { connect } = await import('node:net')
  const url = new URL(shim.baseUrl())
  const method = options.method ?? 'GET'
  const path = options.path ?? '/healthz'
  const host = options.host ?? `${url.hostname}:${url.port}`
  const extra = Object.entries(options.headers ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n')
  const body = options.body ?? ''
  const payload = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${host}`,
    ...extra === '' ? [] : [extra],
    ...body === '' ? [] : ['Content-Length: ' + Buffer.byteLength(body)],
    'Connection: close',
    '',
    '',
  ].join('\r\n') + body

  return await new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) })
    let raw = ''
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('shim request timed out')) })
    socket.on('error', reject)
    socket.on('data', chunk => { raw += String(chunk) })
    socket.on('close', () => {
      const [head = '', ...rest] = raw.split('\r\n\r\n')
      const statusLine = head.split('\r\n')[0] ?? ''
      const match = /HTTP\/1\.1\s+(\d+)/.exec(statusLine)
      resolve({ status: match === null ? 0 : Number(match[1]), body: rest.join('\r\n\r\n') })
    })
    socket.write(payload)
  })
}

/** Call the shim the way its own in-process client does. */
async function request(
  shim: WorkBuddyShim,
  init: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${shim.baseUrl()}${init.path ?? '/healthz'}`, {
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    ...init.body === undefined ? {} : { body: init.body },
  })
  return { status: response.status, body: await response.text() }
}

async function authed(shim: WorkBuddyShim, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return { authorization: `Bearer ${shim.token()}`, ...extra }
}

describe('shim inbound hardening', () => {
  it('rejects a non-loopback Host header (DNS-rebinding simulation)', async () => {
    shim = makeShim({ chatStream: async () => ({ ok: true, response: new Response('') }) })
    await shim.ready
    // A rebinding page reaches 127.0.0.1 but sends its own domain in Host.
    const response = await rawRequest(shim, { host: 'evil.example.com' })
    expect(response.status).toBe(403)
    expect(response.body).toContain('host_not_allowed')
  })

  it('accepts an explicit loopback Host header', async () => {
    shim = makeShim({ chatStream: async () => ({ ok: true, response: new Response('') }) })
    await shim.ready
    const response = await rawRequest(shim, {
      host: '127.0.0.1',
      headers: { authorization: `Bearer ${shim.token()}` },
    })
    expect(response.status).toBe(200)
  })

  it('rejects a cross-origin browser Origin', async () => {
    shim = makeShim({ chatStream: async () => ({ ok: true, response: new Response('') }) })
    await shim.ready
    const response = await request(shim, { headers: { origin: 'https://evil.example.com' } })
    expect(response.status).toBe(403)
    expect(response.body).toContain('origin_not_allowed')
  })

  it('rejects a missing or wrong bearer', async () => {
    shim = makeShim({ chatStream: async () => ({ ok: true, response: new Response('') }) })
    await shim.ready
    expect((await request(shim, {})).status).toBe(401)
    const wrong = await request(shim, { headers: { authorization: 'Bearer wrong-secret' } })
    expect(wrong.status).toBe(401)
  })

  it('serves healthz and the model list to its own client', async () => {
    shim = makeShim({ chatStream: async () => ({ ok: true, response: new Response('') }) })
    await shim.ready
    const health = await request(shim, { headers: await authed(shim) })
    expect(health.status).toBe(200)
    const models = await request(shim, { path: '/v1/models', headers: await authed(shim) })
    expect(models.status).toBe(200)
    const listed = JSON.parse(models.body) as { data: { id: string }[] }
    expect(listed.data.length).toBeGreaterThan(0)
  })

  it('requires a JSON content type for chat completions', async () => {
    shim = makeShim({ chatStream: async () => ({ ok: true, response: new Response('') }) })
    await shim.ready
    const response = await request(shim, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: await authed(shim, { 'content-type': 'text/plain' }),
      body: '{}',
    })
    expect(response.status).toBe(415)
  })

  it('maps upstream credit exhaustion to HTTP 402', async () => {
    shim = makeShim({
      chatStream: async () => ({ ok: false, status: 400, kind: 'hard_credit', message: '积分不足' }),
    })
    await shim.ready
    const response = await request(shim, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: await authed(shim, { 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'glm-5.3', messages: [] }),
    })
    expect(response.status).toBe(402)
    expect(response.body).toContain('hard_credit')
  })

  it('maps a dead session to HTTP 401 and a rate limit to 429', async () => {
    const cases: [import('../src/upstream.ts').UpstreamErrorKind, number][] = [
      ['session_dead', 401],
      ['soft_rate', 429],
      ['server', 502],
    ]
    for (const [kind, expected] of cases) {
      shim = makeShim({ chatStream: async () => ({ ok: false, status: 500, kind, message: 'x' }) })
      await shim.ready
      const response = await request(shim, {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: await authed(shim, { 'content-type': 'application/json' }),
        body: '{}',
      })
      expect(response.status).toBe(expected)
      await shim.close()
    }
    shim = undefined
  })

  it('never forwards the caller\'s bearer to the upstream', async () => {
    let seenAuth: string | undefined
    const local = makeShim({
      chatStream: async (credential: WorkBuddyCredential) => {
        seenAuth = credential.accessToken
        return { ok: true, response: new Response('data: [DONE]\n\n') }
      },
    })
    shim = local
    await local.ready
    await request(local, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: await authed(local, { 'content-type': 'application/json' }),
      body: '{}',
    })
    // The shim must resolve the real credential from its store, not pass
    // through the per-process secret the caller presented.
    expect(seenAuth).toBe(CREDENTIAL.accessToken)
    expect(seenAuth).not.toBe(local.token())
  })

  it('reports a signed-out store as 401 rather than leaking a stack', async () => {
    const failing = createWorkBuddyShim({
      store: { resolve: async () => { throw new Error('workbuddy: no signed-in account') } } as never,
      client: { chatStream: async () => ({ ok: true, response: new Response('') }) } as never,
      catalog: new WorkBuddyCatalog(),
    })
    shim = failing
    await failing.ready
    const response = await request(failing, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: await authed(failing, { 'content-type': 'application/json' }),
      body: '{}',
    })
    expect(response.status).toBe(401)
    expect(response.body).toContain('not_signed_in')
  })
})

describe('shim lifecycle', () => {
  it('binds a loopback port and closes cleanly', async () => {
    const local = makeShim({ chatStream: async () => ({ ok: true, response: new Response('') }) })
    await local.ready
    expect(local.baseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(local.token().length).toBeGreaterThan(20)
    await local.close()
  })

  it('uses a distinct secret per instance', async () => {
    const a = makeShim({ chatStream: async () => ({ ok: true, response: new Response('') }) })
    const b = makeShim({ chatStream: async () => ({ ok: true, response: new Response('') }) })
    await Promise.all([a.ready, b.ready])
    expect(a.token()).not.toBe(b.token())
    await a.close()
    await b.close()
  })
})

// Guard against leaking a listening server between tests.
afterEach(() => {
  const servers = (globalThis as { __wbServers?: Server[] }).__wbServers
  void servers
})
