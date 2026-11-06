// @vitest-environment node
/**
 * The CN gateway override reaches EVERY route that carries the token
 * (issue #220).
 *
 * `tests/cn-gateway.spec.ts` pins the allowlist. This file pins the part a unit
 * test cannot: that the validated base is actually used by each request builder,
 * and that the requests which must NOT follow it still do not.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. `upstream.ts` builds the CN base through
 * two private helpers (`chatBase` / `billingBase`) that ~16 call sites use. An
 * override threaded through only some of them produces a plugin that is WORSE
 * than the unfixed one: chat works, so the user believes the workaround landed,
 * and then check-in, credits and image generation silently keep hitting the host
 * their network resets. The whole point of the setting is that one host name
 * replaces the other everywhere.
 *
 * The counter-case matters too: `Origin` / `Referer` describe which WEB APP the
 * request claims to come from and must keep naming the CN web app, and the
 * international region must be untouched (those tokens are brand-bound, so a CN
 * host override applied to them would 401 them outright).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

afterEach(() => { vi.unstubAllGlobals() })

function cnCredential(): WorkBuddyCredential {
  return {
    accessToken: 'cn-token-SECRET',
    refreshToken: 'cn-refresh',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'www.codebuddy.cn',
    uid: 'u-1',
    source: 'desktop',
    filePath: '/tmp/workbuddy-desktop.info',
  }
}

function globalCredential(): WorkBuddyCredential {
  return {
    accessToken: 'global-token',
    refreshToken: 'global-refresh',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'www.workbuddy.ai',
    uid: 'u-2',
    source: 'desktop',
    filePath: '/tmp/workbuddy-desktop.info',
  }
}

interface Call { url: string; headers: Record<string, string> }

/** Record every fetch (URL + headers) and answer per path substring. */
function stub(paths: Record<string, unknown>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: any, init: any) => {
    const target = String(url)
    calls.push({ url: target, headers: (init?.headers ?? {}) as Record<string, string> })
    for (const [part, body] of Object.entries(paths)) {
      if (target.includes(part)) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => body,
          text: async () => JSON.stringify(body),
          body: null,
        } as unknown as Response
      }
    }
    return {
      ok: false,
      status: 404,
      headers: { get: () => 'application/json' },
      json: async () => ({ code: 404, msg: 'not found' }),
      text: async () => '',
      body: null,
    } as unknown as Response
  })
  return calls
}

const OVERRIDE = 'https://wb.tencentbuddy.com'

function overridden(): WorkBuddyUpstreamClient {
  return new WorkBuddyUpstreamClient(undefined, {}, { cnBase: () => OVERRIDE })
}

describe('the override carries every CN route', () => {
  it('sends the credits read to the override host', async () => {
    const calls = stub({
      '/v2/billing/meter/get-user-resource': { code: 0, msg: 'OK', data: { Response: { Data: { Accounts: [] } } } },
    })
    await overridden().fetchCredits(cnCredential())
    const call = calls.find(entry => entry.url.includes('/get-user-resource'))
    expect(call, 'the credits route never ran').toBeDefined()
    expect(call?.url.startsWith(OVERRIDE), `credits went to ${call?.url}`).toBe(true)
  })

  it('sends the check-in status read to the override host', async () => {
    const calls = stub({
      '/v2/billing/meter/checkin-activity-status': { code: 0, msg: 'OK', data: { todayCheckedIn: false } },
    })
    await overridden().fetchCheckinStatus(cnCredential())
    const call = calls.find(entry => entry.url.includes('/checkin-activity-status'))
    expect(call, 'the check-in status route never ran').toBeDefined()
    expect(call?.url.startsWith(OVERRIDE), `check-in went to ${call?.url}`).toBe(true)
  })

  it('sends the daily check-in WRITE to the override host', async () => {
    // The write is the one that cannot be retried for free, so it must follow
    // the same host as the read: a status read from the override and a claim to
    // the blocked host would report "not checked in" forever.
    const calls = stub({
      '/v2/billing/meter/daily-checkin': { code: 0, msg: 'OK', data: { credit: 150 } },
    })
    await overridden().claimDailyCheckin(cnCredential())
    const call = calls.find(entry => entry.url.includes('/daily-checkin'))
    expect(call, 'the daily check-in route never ran').toBeDefined()
    expect(call?.url.startsWith(OVERRIDE), `daily check-in went to ${call?.url}`).toBe(true)
  })

  it('sends the model catalog read to the override host', async () => {
    // A model with non-zero token limits: `parseUpstreamModel` drops an entry
    // without them, and an EMPTY roster makes `fetchModels` throw rather than
    // return — so an empty fixture would leave this test unable to tell "the
    // override did not apply" from "the fixture was too thin to parse".
    const roster = {
      code: 0,
      msg: 'OK',
      data: {
        models: [{ id: 'm-1', name: 'M One', maxInputTokens: 128_000, maxOutputTokens: 8_000 }],
        agents: [{ name: 'cli', models: ['m-1'] }],
      },
    }
    const calls = stub({
      '/v2/enterprises/personal/models': roster,
      '/v3/config': roster,
    })
    await overridden().fetchModels(cnCredential())
    expect(calls.length, 'no catalog request ran').toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.url.startsWith(OVERRIDE), `catalog went to ${call.url}`).toBe(true)
    }
  })

  it('sends the per-model busy probe to the override host', async () => {
    const calls = stub({ '/v2/chat/busy': { code: 0, msg: 'OK', data: [] } })
    await overridden().fetchModelBusy(cnCredential(), ['m-1'])
    const call = calls.find(entry => entry.url.includes('/v2/chat/busy'))
    expect(call, 'the busy probe never ran').toBeDefined()
    expect(call?.url.startsWith(OVERRIDE), `busy probe went to ${call?.url}`).toBe(true)
  })
})

describe('the override is a live read, not a sampled value', () => {
  it('follows a value that changes between requests', async () => {
    // This is what makes the setting usable without restarting DSH: `regions` is
    // volatile, and the card saves it while the process keeps running. A
    // constructor-time string would pin the first value for the whole session.
    let base = ''
    const client = new WorkBuddyUpstreamClient(undefined, {}, { cnBase: () => base })
    stub({
      '/v2/billing/meter/checkin-activity-status': { code: 0, msg: 'OK', data: { todayCheckedIn: false } },
    })

    const before = stub({
      '/checkin-activity-status': { code: 0, msg: 'OK', data: { todayCheckedIn: false } },
    })
    await client.fetchCheckinStatus(cnCredential())
    expect(before[0]?.url.startsWith('https://www.codebuddy.cn'), 'default gateway expected before the override').toBe(true)

    base = OVERRIDE
    const after = stub({
      '/checkin-activity-status': { code: 0, msg: 'OK', data: { todayCheckedIn: false } },
    })
    await client.fetchCheckinStatus(cnCredential())
    expect(after[0]?.url.startsWith(OVERRIDE), 'the override did not take effect mid-session').toBe(true)
  })
})

describe('what must NOT follow the override', () => {
  it('leaves Origin and Referer naming the CN web app', async () => {
    // They say which web app the request claims to be, not which socket it
    // reaches. Rewriting them from a host override would make the identity claim
    // disagree with itself for no benefit: the gateway reads them as "the CN
    // web app".
    const calls = stub({
      '/v2/billing/meter/get-user-resource': { code: 0, msg: 'OK', data: { Response: { Data: { Accounts: [] } } } },
    })
    await overridden().fetchCredits(cnCredential())
    const call = calls[0]
    expect(call?.headers['Origin']).toBe('https://www.codebuddy.cn')
    expect(call?.headers['Referer']).toBe('https://www.codebuddy.cn/')
    expect(call?.url.startsWith(OVERRIDE)).toBe(true)
  })

  it('never routes the CATALOG of an INTERNATIONAL credential to the CN override', async () => {
    // The catalog read takes its own `global` branch that never consults
    // `chatBase`, so this one passes even with a broken guard — it is here to
    // pin the branch, not to prove the guard. The case that DOES exercise the
    // guard is the credits read below.
    const calls = stub({
      '/v3/config': {
        code: 0,
        msg: 'OK',
        data: {
          models: [{ id: 'g-1', name: 'G One', maxInputTokens: 128_000, maxOutputTokens: 8_000 }],
          agents: [{ name: 'cli', models: ['g-1'] }],
        },
      },
    })
    await overridden().fetchModels(globalCredential())
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.url.startsWith(OVERRIDE), `a global credential was sent to the CN override: ${call.url}`).toBe(false)
      expect(call.url.startsWith('https://www.workbuddy.ai'), call.url).toBe(true)
    }
  })

  it('never routes a BILLING read of an INTERNATIONAL credential to the CN override', async () => {
    // THE CASE THAT ACTUALLY GUARDS THE BRANCH. `billingBase` and `chatBase` are
    // the two helpers that consult the override, and both must test the region
    // FIRST. Global tokens are brand-bound (`codebuddy.ai` tokens are refused by
    // the `workbuddy.ai` gateway and vice versa), so an override that won by
    // being non-empty would send a valid token to a host that 401s it — and the
    // user would blame their network for a bug this setting introduced.
    //
    // Verified by mutation: making either helper check the override before the
    // region leaves every other case in this file green and THIS one red.
    const calls = stub({
      '/v2/billing/meter/get-user-resource': { code: 0, msg: 'OK', data: { Response: { Data: { Accounts: [] } } } },
    })
    await overridden().fetchCredits(globalCredential())
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.url.startsWith(OVERRIDE), `a global billing read was sent to the CN override: ${call.url}`).toBe(false)
      expect(call.url.startsWith('https://www.workbuddy.ai'), call.url).toBe(true)
    }
  })

  it('keeps the token out of the URL on every overridden request', async () => {
    // The token travels in `Authorization`, never in the URL — a value the user
    // typed must not change that, or the credential lands in access logs.
    const calls = stub({
      '/v2/billing/meter/get-user-resource': { code: 0, msg: 'OK', data: { Response: { Data: { Accounts: [] } } } },
    })
    await overridden().fetchCredits(cnCredential())
    for (const call of calls) {
      expect(call.url).not.toContain('cn-token-SECRET')
      expect(call.headers['Authorization']).toBe('Bearer cn-token-SECRET')
    }
  })
})

describe('an empty override is the pre-#220 behaviour, byte for byte', () => {
  it('uses the built-in chat and billing hosts', async () => {
    const calls = stub({
      '/v2/billing/meter/get-user-resource': { code: 0, msg: 'OK', data: { Response: { Data: { Accounts: [] } } } },
    })
    await new WorkBuddyUpstreamClient(undefined, {}, { cnBase: () => '' }).fetchCredits(cnCredential())
    expect(calls[0]?.url.startsWith('https://www.codebuddy.cn')).toBe(true)
  })

  it('behaves identically with no cnBase option at all', async () => {
    // Every profile in the world today: no option, no field, no override.
    const calls = stub({
      '/v2/billing/meter/get-user-resource': { code: 0, msg: 'OK', data: { Response: { Data: { Accounts: [] } } } },
    })
    await new WorkBuddyUpstreamClient().fetchCredits(cnCredential())
    expect(calls[0]?.url.startsWith('https://www.codebuddy.cn')).toBe(true)
  })
})
