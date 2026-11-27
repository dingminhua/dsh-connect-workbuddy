/**
 * Issue #332: the WorkBuddy-backed `web_search` provider.
 *
 * The network paths are tested against an injected fetcher, so the SSE framing,
 * source extraction and session-dead retry are exercised without a real account.
 * Mutation-check target: break any one of the parsers/retry and a test goes red.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  cleanSynthesis,
  createWorkBuddySearchProvider,
  extractSources,
  WorkBuddyWebSearchError,
  WORKBUDDY_SEARCH_PROVIDER_ID,
} from '../src/web-search.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

function credential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'tok-1',
    refreshToken: 'refresh-1',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'copilot.tencent.com',
    uid: '100000000001',
    source: 'desktop',
    filePath: '/Users/<you>/auth.json',
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('cleanSynthesis', () => {
  it('drops selected-refs blocks, including ones with attributes', () => {
    const input = '开头<selected-refs id="1">内部标记</selected-refs>结尾'
    expect(cleanSynthesis(input)).toBe('开头结尾')
  })

  it('is total for non-string-shaped content at the boundary', () => {
    // The function itself accepts string; an empty result is still a string.
    expect(cleanSynthesis('')).toBe('')
  })
})

describe('extractSources', () => {
  it('prefers markdown links and keeps non-ASCII URLs intact', () => {
    const text = '见 [维基](https://zh.wikipedia.org/wiki/中文) 与 https://example.com/a。'
    const { sources } = extractSources(text)
    expect(sources[0]).toEqual({ url: 'https://zh.wikipedia.org/wiki/中文', title: '维基' })
    expect(sources[1]?.url).toBe('https://example.com/a')
  })

  it('does not swallow Chinese prose into a bare URL', () => {
    const text = '详见 https://example.com/说明 结束'
    const { sources } = extractSources(text)
    expect(sources).toHaveLength(1)
    expect(sources[0]?.url).toBe('https://example.com/')
  })

  it('de-duplicates by URL and reports truncation', () => {
    const text = 'https://a.com/1 https://a.com/1 https://a.com/2 https://a.com/3'
    const { sources, capped } = extractSources(text, 2)
    expect(sources.map(s => s.url)).toEqual(['https://a.com/1', 'https://a.com/2'])
    expect(capped).toBe(true)
  })

  it('does not report truncation when only duplicates were dropped', () => {
    const { sources, capped } = extractSources('https://a.com/1 https://a.com/1', 10)
    expect(sources).toHaveLength(1)
    expect(capped).toBe(false)
  })
})

describe('workbuddy web search provider', () => {
  const deps = (fetcher: typeof fetch, overrides: Record<string, unknown> = {}) => ({
    resolveCredential: vi.fn(async () => credential()),
    fetcher,
    ...overrides,
  })

  it('registers under a fresh id that cannot collide with built-in providers', () => {
    const provider = createWorkBuddySearchProvider(deps(async () => { throw new Error('unused') }))
    expect(provider.id).toBe(WORKBUDDY_SEARCH_PROVIDER_ID)
    expect(provider.id).not.toBe('workbuddy-agentic')
    expect(provider.available()).toBe(true)
  })

  it('uses the fast structured endpoint by default and maps results', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      code: 0,
      data: {
        results: [
          { title: 'A', url: 'https://a.com', snippet: 'snippet A', date: '2026-01-01' },
          { title: 'B', url: 'https://b.com', snippet: 'snippet B' },
        ],
      },
    }))
    const provider = createWorkBuddySearchProvider(deps(fetcher))
    const result = await provider.search({ query: 'hello', maxResults: 10 }, undefined)
    expect(result.sources).toEqual([
      { url: 'https://a.com', title: 'A', snippet: 'snippet A', publishedAt: '2026-01-01' },
      { url: 'https://b.com', title: 'B', snippet: 'snippet B' },
    ])
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://copilot.tencent.com/agenttool/v1/search')
    expect(JSON.parse(String(init.body))).toEqual({ query: 'hello', max_results: 10 })
  })

  it('respects a smaller maxResults and flags truncation', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      results: [
        { url: 'https://a.com' },
        { url: 'https://b.com' },
        { url: 'https://c.com' },
      ],
    }))
    const provider = createWorkBuddySearchProvider(deps(fetcher))
    const result = await provider.search({ query: 'q', maxResults: 2 }, undefined)
    expect(result.sources).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('routes global credentials to the international gateway', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ results: [] }))
    const provider = createWorkBuddySearchProvider({
      ...deps(fetcher),
      resolveCredential: vi.fn(async () => credential({ domain: 'workbuddy.ai' })),
    })
    await provider.search({ query: 'q' }, undefined)
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe('https://www.workbuddy.ai/agenttool/v1/search')
  })

  it('refreshes once and retries on a session-dead response', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ msg: 'Offline user session not found' }, 401))
      .mockResolvedValueOnce(jsonResponse({ results: [{ url: 'https://ok.com' }] }))
    const refreshToken = vi.fn(async () => credential({ accessToken: 'tok-2' }))
    const provider = createWorkBuddySearchProvider(deps(fetcher, { refreshToken }))
    const result = await provider.search({ query: 'q' }, undefined)
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(result.sources[0]?.url).toBe('https://ok.com')
    const secondCall = fetcher.mock.calls[1]
    expect(secondCall).toBeDefined()
    const secondInit = secondCall?.[1] as RequestInit
    expect(secondInit.headers).toMatchObject({ Authorization: 'Bearer tok-2' })
  })

  it('does not retry a non-session failure', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ msg: 'rate limited' }, 429))
    const refreshToken = vi.fn(async () => credential({ accessToken: 'tok-2' }))
    const provider = createWorkBuddySearchProvider(deps(fetcher, { refreshToken }))
    await expect(provider.search({ query: 'q' }, undefined)).rejects.toBeInstanceOf(WorkBuddyWebSearchError)
    expect(refreshToken).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects an empty query without touching the network', async () => {
    const fetcher = vi.fn()
    const provider = createWorkBuddySearchProvider(deps(fetcher))
    await expect(provider.search({ query: '   ' }, undefined)).rejects.toMatchObject({ code: 'WB_SEARCH_BAD_QUERY' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reads the synthesis from a CRLF-framed done event in agentic mode', async () => {
    const frame = 'event: done\r\ndata: {"synthesis":{"content":"答案 [来源](https://s.com/x)"}}\r\n\r\n'
    const fetcher = vi.fn(async () => new Response(frame, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    const provider = createWorkBuddySearchProvider(deps(fetcher, { agentic: () => true }))
    const result = await provider.search({ query: 'q' }, undefined)
    expect(result.content).toContain('答案')
    expect(result.sources[0]?.url).toBe('https://s.com/x')
  })

  it('caps the synthesis length when configured', async () => {
    const long = 'x'.repeat(100)
    const frame = `event: done\ndata: ${JSON.stringify({ synthesis: { content: long } })}\n\n`
    const fetcher = vi.fn(async () => new Response(frame, { status: 200 }))
    const provider = createWorkBuddySearchProvider(deps(fetcher, { agentic: () => true, maxContentChars: () => 10 }))
    const result = await provider.search({ query: 'q' }, undefined)
    expect(result.content).toBe('x'.repeat(10))
  })

  it('reports an aborted signal without issuing a request', async () => {
    const fetcher = vi.fn()
    const provider = createWorkBuddySearchProvider(deps(fetcher))
    const controller = new AbortController()
    controller.abort()
    await expect(provider.search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
