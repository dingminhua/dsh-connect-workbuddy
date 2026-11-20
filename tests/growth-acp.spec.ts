import { describe, expect, it, vi } from 'vitest'
import { activateGrowth, resolveAcpEndpoint, rpcResultFromSse, type GrowthAcpOptions } from '../src/growth-acp.ts'

/** Build a fake fetch that walks the four ACP steps and records each call. */
function fakeAcpFetch(overrides: {
  createPayload?: unknown
  sessionPayload?: unknown
  openHeaders?: Record<string, string>
  sseResult?: unknown
} = {}): { fetch: typeof globalThis.fetch; calls: { url: string; method: string; headers: Record<string, string>; body: string }[] } {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = []
  const doFetch = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({ url, method: init.method ?? 'GET', headers, body: String(init.body ?? '') })
    if (url.endsWith('/console/as/conversations/')) {
      return {
        ok: true,
        status: 200,
        json: async () => overrides.createPayload ?? {
          data: {
            id: 'conv-1',
            session: { link: 'https://acp.example.com', token: 'rt', sessionId: 'sess-1' },
          },
        },
      } as unknown as Response
    }
    if (url.includes('/session')) {
      return {
        ok: true,
        status: 200,
        json: async () => overrides.sessionPayload ?? { data: { link: 'https://acp.example.com', token: 'rt', sessionId: 'sess-1' } },
      } as unknown as Response
    }
    if (init.method === 'GET') {
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => k === 'acp-connection-id' ? (overrides.openHeaders === undefined ? 'conn-1' : (overrides.openHeaders['acp-connection-id'] ?? null)) : null },
        text: async () => '',
      } as unknown as Response
    }
    if (init.method === 'POST') {
      return {
        ok: true,
        status: 200,
        text: async () => `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: overrides.sseResult ?? {} })}\n\n`,
      } as unknown as Response
    }
    return { ok: true, status: 200 } as unknown as Response
  }) as unknown as typeof globalThis.fetch
  return { fetch: doFetch, calls }
}

function options(over: Partial<GrowthAcpOptions> = {}): GrowthAcpOptions {
  return {
    base: 'https://www.workbuddy.ai',
    accessToken: 'at',
    origin: 'https://www.workbuddy.ai',
    model: 'hy4-preview',
    heatmap: async () => ({ isActive: false, score: 0 }),
    sleep: async () => {},
    verifyAttempts: 3,
    verifyIntervalMs: 1,
    ...over,
  }
}

describe('resolveAcpEndpoint', () => {
  it('appends /api/v1/acp once and is idempotent', () => {
    expect(resolveAcpEndpoint('https://acp.example.com/')).toBe('https://acp.example.com/api/v1/acp')
    expect(resolveAcpEndpoint('https://acp.example.com/api/v1/acp')).toBe('https://acp.example.com/api/v1/acp')
    expect(resolveAcpEndpoint('https://acp.example.com/acp')).toBe('https://acp.example.com/acp')
  })
  it('upgrades http to https and returns empty for empty input', () => {
    expect(resolveAcpEndpoint('http://acp.example.com')).toBe('https://acp.example.com/api/v1/acp')
    expect(resolveAcpEndpoint('')).toBe('')
  })
})

describe('rpcResultFromSse', () => {
  it('finds the matching id and ignores other frames and errors', () => {
    const text = [
      'data: ' + JSON.stringify({ id: 9, result: { nope: true } }),
      'data: not-json',
      'data: ' + JSON.stringify({ id: 2, result: { stopReason: 'end' } }),
    ].join('\n')
    expect(rpcResultFromSse(text, 2)).toEqual({ stopReason: 'end' })
    expect(rpcResultFromSse(text, 99)).toBeUndefined()
  })
  it('throws on an RPC error frame with the matching id', () => {
    const text = 'data: ' + JSON.stringify({ id: 2, error: { code: -1, message: 'bad' } })
    expect(() => rpcResultFromSse(text, 2)).toThrow(/ACP RPC error/)
  })
})

describe('activateGrowth', () => {
  it('is idempotent: already active sends NO session', async () => {
    const { fetch } = fakeAcpFetch()
    const heatmap = vi.fn(async () => ({ isActive: true, score: 6 }))
    const result = await activateGrowth(options({ fetch, heatmap }))
    expect(result).toEqual({ status: 'already-active', score: 6 })
    expect(heatmap).toHaveBeenCalledTimes(1)
  })

  it('walks the four ACP steps and confirms via the heatmap', async () => {
    const { fetch, calls } = fakeAcpFetch()
    const heatmap = vi.fn()
      .mockResolvedValueOnce({ isActive: false, score: 0 })
      .mockResolvedValueOnce({ isActive: false, score: 0 })
      .mockResolvedValueOnce({ isActive: true, score: 2 })
    const result = await activateGrowth(options({ fetch, heatmap }))
    expect(result.status).toBe('activated')
    expect(result.score).toBe(2)
    expect(result.conversationId).toBe('conv-1')
    const methods = calls.map(c => `${c.method} ${new URL(c.url).pathname}`)
    expect(methods[0]).toContain('POST /console/as/conversations/')
    expect(methods.some(m => m.includes('/api/v1/acp') && m.startsWith('GET'))).toBe(true)
    expect(methods.some(m => m.includes('/api/v1/acp') && m.startsWith('POST'))).toBe(true)
    expect(calls.some(c => c.method === 'DELETE')).toBe(true)
    // The POST body carries the caller-chosen model, never a hardcoded id.
    const createCall = calls[0]
    expect(createCall).toBeDefined()
    expect(JSON.parse(createCall?.body ?? '{}')).toMatchObject({ model: 'hy4-preview' })
  })

  it('reports failure when the SSE response has no connection id', async () => {
    const { fetch } = fakeAcpFetch({ openHeaders: {} })
    const result = await activateGrowth(options({ fetch }))
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('acp-connection-id')
  })

  it('reports failure, not success, when the heatmap never lights up', async () => {
    const { fetch } = fakeAcpFetch()
    const result = await activateGrowth(options({ fetch, heatmap: async () => ({ isActive: false, score: 0 }) }))
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('stayed false')
  })
})
