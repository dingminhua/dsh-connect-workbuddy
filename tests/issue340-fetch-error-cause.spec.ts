/**
 * ISSUE #340 — Node's `fetch` throws the same `TypeError: fetch failed` for
 * every network failure; the real reason lives in `error.cause`. The transport
 * message must append the short cause code so DNS / refused / reset / proxy-cut
 * are distinguishable in the card, the pool record, and issue reports.
 *
 * Constraint: the appended text must come AFTER `fetch failed`, so #337's
 * `/transport error:.*fetch failed/iu` discrimination keeps matching.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { describeFetchError, WorkBuddyUpstreamClient } from '../src/upstream.ts'

function credential(): WorkBuddyCredential {
  return {
    accessToken: 'at', refreshToken: 'rt', expiresAtMs: 0,
    domain: 'www.codebuddy.cn', uid: 'u', source: 'desktop', filePath: '/tmp/workbuddy-desktop.info',
  }
}

afterEach(() => { vi.unstubAllGlobals() })

const NETWORK = /transport error:.*fetch failed/iu

describe('describeFetchError (#340)', () => {
  it('appends the cause code after `fetch failed`', () => {
    const base = new TypeError('fetch failed')
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND no-such-host.invalid'), { code: 'ENOTFOUND' })
    Object.defineProperty(base, 'cause', { value: cause })
    const described = describeFetchError(base)
    expect(described).toBe('TypeError: fetch failed [ENOTFOUND]')
    expect(`transport error: ${described}`).toMatch(NETWORK)
  })

  it('covers refused / reset / timeout codes the same way', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT']) {
      const base = new TypeError('fetch failed')
      Object.defineProperty(base, 'cause', { value: Object.assign(new Error(code), { code }) })
      const described = describeFetchError(base)
      expect(described, code).toBe(`TypeError: fetch failed [${code}]`)
      expect(`transport error: ${described}`, code).toMatch(NETWORK)
    }
  })

  it('uses the cause constructor name when there is no code', () => {
    const base = new TypeError('fetch failed')
    Object.defineProperty(base, 'cause', { value: new RangeError('weird socket state') })
    expect(describeFetchError(base)).toBe('TypeError: fetch failed [RangeError]')
  })

  it('leaves a cause-less error untouched (cancel / timeout self-describe)', () => {
    expect(describeFetchError(new TypeError('fetch failed'))).toBe('TypeError: fetch failed')
    expect(describeFetchError(new Error('no response within 30000ms'))).toBe('Error: no response within 30000ms')
    const abort = new Error('This operation was aborted')
    abort.name = 'AbortError'
    expect(describeFetchError(abort)).toBe('AbortError: This operation was aborted')
  })

  it('wires describeFetchError into BOTH transport catches (chat + probe)', async () => {
    // The helper alone is not enough: a refactor could drop it from the call
    // sites and every unit test would still pass. Mock fetch to reject with a
    // real-shaped cause and assert the returned message/body carries the code.
    const rejectWithCause = (): never => {
      const err = new TypeError('fetch failed')
      Object.defineProperty(err, 'cause', {
        value: Object.assign(new Error('getaddrinfo ENOTFOUND no-such-host.invalid'), { code: 'ENOTFOUND' }),
      })
      throw err
    }
    vi.stubGlobal('fetch', rejectWithCause)
    const client = new WorkBuddyUpstreamClient()
    const chat = await client.chatStream(credential(), '{}')
    expect(chat.ok).toBe(false)
    expect('message' in chat && chat.message).toContain('[ENOTFOUND]')
    const probe = await client.probeChat(credential(), '{}')
    expect(probe.status).toBe(0)
    expect(probe.body).toContain('[ENOTFOUND]')
  })
})
