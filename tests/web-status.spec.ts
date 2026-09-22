import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { workBuddyWebStatus } from '../src/web-status.ts'
import type { WorkBuddyStatusRouteOptions } from '../src/web-status.ts'
import { WORKBUDDY_CHECKIN_PATH, WORKBUDDY_USAGE_PATH } from '../src/status-paths.ts'
import { FALLBACK_WORKBUDDY_MODELS } from '../src/catalog.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { WorkBuddyCredentialRejectedError } from '../src/upstream.ts'

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAtMs: Date.now() + 86_400_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid',
  uin: '100000000001',
  nickname: 'Alpha',
  source: 'desktop',
  filePath: '/tmp/a.info',
}

const ACCOUNTS = [
  {
    id: 'aaa',
    accountName: 'Alpha',
    uin: '100000000001',
    domain: 'www.codebuddy.cn',
    source: 'desktop' as const,
    tokenExpiresAtMs: CREDENTIAL.expiresAtMs,
    filePath: '/tmp/a.info',
    selected: true,
  },
  {
    id: 'bbb',
    accountName: 'Beta',
    uin: '100000000002',
    domain: '',
    source: 'desktop' as const,
    tokenExpiresAtMs: CREDENTIAL.expiresAtMs,
    filePath: '/tmp/b.info',
    selected: false,
  },
]

/** The store mock the region dispatch hands out. */
function baseStore(): {
  accounts: () => Promise<typeof ACCOUNTS>
  status: () => Promise<{ state: 'signed-in'; expiresAtMs: number }>
  resolve: () => Promise<WorkBuddyCredential>
  selectionLost: () => Promise<boolean>
  hasExplicitSelection: () => boolean
} {
  return {
    accounts: async () => ACCOUNTS,
    status: async () => ({ state: 'signed-in', expiresAtMs: CREDENTIAL.expiresAtMs }),
    resolve: async () => CREDENTIAL,
    selectionLost: async () => false,
    hasExplicitSelection: () => true,
  }
}

function deps(overrides: Partial<WorkBuddyStatusRouteOptions> = {}): WorkBuddyStatusRouteOptions {
  return {
    store: () => baseStore() as never,
    client: {
      fetchCredits: async () => ({
        total: 1875,
        packages: [
          { packageName: 'CodeBuddy个人体验版', remain: 41, size: 500, monthly: true, refreshAtMs: 1_799_999_999_000 },
          { packageName: 'CodeBuddy个人版国内运营裂变包', remain: 1806, size: 2000, monthly: false, expiresAtMs: 1_800_000_000_000 },
        ],
        expiringSoon: 75,
        nearestExpiryMs: 1_800_000_000_000,
      }),
      fetchCheckinStatus: async () => ({
        active: true,
        todayCheckedIn: true,
        streakDays: 9,
        dailyCredit: 100,
        todayCredit: 100,
        isStreakDay: false,
        nextStreakDay: 0,
        streakBonusDays: 0,
        streakBonusCredit: 0,
      }),
      claimDailyCheckin: async () => ({ credit: 100, streakDays: 9, isStreakDay: false }),
    },
    displayModels: () => FALLBACK_WORKBUDDY_MODELS,
    enabledModelIds: () => ['glm-5.3'],
    imageModelIds: () => ['glm-5.3'],
    contextBudgets: () => ({}),
    ...overrides,
  }
}

describe('workBuddyWebStatus', () => {
  it('reports signed-out with accounts when no credential resolves', async () => {
    const status = await workBuddyWebStatus(deps({
      store: () => ({
        accounts: async () => ACCOUNTS,
        status: async () => ({ state: 'signed-out' }),
        resolve: async () => { throw new Error('workbuddy: no signed-in account') },
        selectionLost: async () => false,
        hasExplicitSelection: () => false,
      }) as never,
    }), 'cn')
    expect(status.status).toBe('signed-out')
    if (status.status !== 'signed-out') return
    expect(status.accounts).toHaveLength(2)
  })

  it('reports signed-out with an empty list when no credential file exists at all', async () => {
    const status = await workBuddyWebStatus(deps({
      store: () => ({
        accounts: async () => [],
        status: async () => ({ state: 'signed-out' }),
        resolve: async () => { throw new Error('no account') },
        selectionLost: async () => false,
        hasExplicitSelection: () => false,
      }) as never,
    }), 'cn')
    expect(status.status).toBe('signed-out')
    if (status.status !== 'signed-out') return
    expect(status.accounts).toEqual([])
  })

  it('flags an orphaned saved selection so the card can stop saying "sign in again"', async () => {
    // The saved id matches no local account while other sign-ins exist: the
    // tokens are fine, so the generic signed-out hint would misdirect the user
    // into re-signing in — the one action that cannot repair an orphaned id.
    const status = await workBuddyWebStatus(deps({
      store: () => ({
        accounts: async () => ACCOUNTS,
        status: async () => ({ state: 'signed-out' }),
        resolve: async () => {
          throw new Error('workbuddy: no signed-in WorkBuddy account found; sign in once in the WorkBuddy desktop app')
        },
        selectionLost: async () => true,
        hasExplicitSelection: () => true,
      }) as never,
    }), 'cn')
    expect(status.status).toBe('signed-out')
    if (status.status !== 'signed-out') return
    expect(status.selectionLost).toBe(true)
    // The account list must still be offered: it is the way out of the state.
    expect(status.accounts).toHaveLength(2)
  })

  it('does not flag selectionLost for a genuinely signed-out machine', async () => {
    const status = await workBuddyWebStatus(deps({
      store: () => ({
        accounts: async () => ACCOUNTS,
        status: async () => ({ state: 'signed-out' }),
        resolve: async () => { throw new Error('no account') },
        selectionLost: async () => false,
        hasExplicitSelection: () => false,
      }) as never,
    }), 'cn')
    if (status.status !== 'signed-out') throw new Error('expected signed-out')
    expect(status.selectionLost).toBeUndefined()
  })

  it('keeps the signed-in document free of selectionLost', async () => {
    const status = await workBuddyWebStatus(deps({
      store: () => ({ ...baseStore(), selectionLost: async () => true }) as never,
    }), 'cn')
    expect(status.status).toBe('signed-in')
    expect('selectionLost' in status).toBe(false)
  })

  it('reports whether a saved choice is in effect, so clearing is observable (issue #11)', async () => {
    // Clearing restores "follow the app's sign-in", which usually resolves to
    // the SAME account. Without this flag the card cannot tell the user that
    // anything happened, which is the "the button does nothing" report.
    const saved = await workBuddyWebStatus(deps(), 'cn')
    if (saved.status !== 'signed-in') throw new Error('expected signed-in')
    expect(saved.selectionExplicit).toBe(true)

    const following = await workBuddyWebStatus(deps({
      store: () => ({ ...baseStore(), hasExplicitSelection: () => false }) as never,
    }), 'cn')
    if (following.status !== 'signed-in') throw new Error('expected signed-in')
    expect(following.selectionExplicit).toBe(false)
  })

  it('reports the selection state on the signed-out branches too', async () => {
    // The picker (and its Clear button) renders on the signed-out branches, so
    // the flag has to be there as well or the state line goes blank exactly
    // when the user needs the way out.
    const orphaned = await workBuddyWebStatus(deps({
      store: () => ({
        accounts: async () => ACCOUNTS,
        status: async () => ({ state: 'signed-out' }),
        resolve: async () => { throw new Error('no account') },
        selectionLost: async () => true,
        hasExplicitSelection: () => true,
      }) as never,
    }), 'cn')
    if (orphaned.status !== 'signed-out') throw new Error('expected signed-out')
    expect(orphaned.selectionExplicit).toBe(true)

    const none = await workBuddyWebStatus(deps({
      store: () => ({
        accounts: async () => ACCOUNTS,
        status: async () => ({ state: 'signed-out' }),
        resolve: async () => { throw new Error('no account') },
        selectionLost: async () => false,
        hasExplicitSelection: () => false,
      }) as never,
    }), 'cn')
    if (none.status !== 'signed-out') throw new Error('expected signed-out')
    expect(none.selectionExplicit).toBe(false)
  })

  it('never puts token material in the signed-in document', async () => {
    const status = await workBuddyWebStatus(deps(), 'cn')
    expect(status.status).toBe('signed-in')
    const serialized = JSON.stringify(status)
    // Field names are the contract; leak detection is about token-shaped values.
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]+\./u)
    expect(serialized).not.toMatch(/"(accessToken|refreshToken)"/u)
    expect(serialized).not.toContain('access')
  })

  it('carries accounts, models, selection, and credits', async () => {
    const status = await workBuddyWebStatus(deps(), 'cn')
    if (status.status !== 'signed-in') throw new Error('expected signed-in')
    expect(status.accountName).toBe('Alpha')
    expect(status.accounts).toHaveLength(2)
    expect(status.models.length).toBe(FALLBACK_WORKBUDDY_MODELS.length)
    const glm = status.models.find(model => model.id === 'glm-5.3')
    expect(glm).toMatchObject({ nativeContextWindow: 1_000_000, contextWindow: 200_000 })
    expect(status.enabledModelIds).toEqual(['glm-5.3'])
    expect(status.imageModelIds).toEqual(['glm-5.3'])
    expect(status.checkin).toMatchObject({ todayCheckedIn: true, todayCredit: 100, streakDays: 9 })
    expect(status.credits).toMatchObject({
      total: 1875,
      expiringSoon: 75,
      nearestExpiryMs: 1_800_000_000_000,
      packages: [
        { packageName: 'CodeBuddy个人体验版', monthly: true, cycleRefreshMs: 1_799_999_999_000 },
        { packageName: 'CodeBuddy个人版国内运营裂变包', monthly: false, expiresAtMs: 1_800_000_000_000 },
      ],
    })
  })

  it('degrades a credit failure to creditsError instead of failing the document', async () => {
    const status = await workBuddyWebStatus(deps({
      client: {
        fetchCredits: async () => { throw new Error('billing unavailable') },
        fetchCheckinStatus: async () => ({ active: true, todayCheckedIn: false, streakDays: 0, dailyCredit: 100, todayCredit: 0, isStreakDay: false, nextStreakDay: 0, streakBonusDays: 0, streakBonusCredit: 0 }),
        claimDailyCheckin: async () => ({ credit: 100, streakDays: 1, isStreakDay: false }),
      },
    }), 'cn')
    if (status.status !== 'signed-in') throw new Error('expected signed-in')
    expect(status.credits).toBeUndefined()
    expect(status.creditsError).toBe('billing unavailable')
    // The account and model sections still render.
    expect(status.models.length).toBeGreaterThan(0)
  })

  it('redacts token-like text in error messages', async () => {
    const status = await workBuddyWebStatus(deps({
      client: {
        fetchCredits: async () => {
          throw new Error('failed with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig and refresh_token=supersecret')
        },
        fetchCheckinStatus: async () => ({ active: true, todayCheckedIn: false, streakDays: 0, dailyCredit: 100, todayCredit: 0, isStreakDay: false, nextStreakDay: 0, streakBonusDays: 0, streakBonusCredit: 0 }),
        claimDailyCheckin: async () => ({ credit: 100, streakDays: 1, isStreakDay: false }),
      },
    }), 'cn')
    if (status.status !== 'signed-in') throw new Error('expected signed-in')
    expect(status.creditsError).toContain('[redacted token]')
    expect(status.creditsError).toContain('[redacted]')
    expect(status.creditsError).not.toContain('supersecret')
  })

  it('flags a refused credential and points at the usable account instead of saying "sign in again"', async () => {
    const probed: string[] = []
    const status = await workBuddyWebStatus(deps({
      client: {
        fetchCredits: async () => { throw new WorkBuddyCredentialRejectedError(401) },
        fetchCheckinStatus: async () => { throw new WorkBuddyCredentialRejectedError(401) },
        claimDailyCheckin: async () => ({ credit: 100, streakDays: 1, isStreakDay: false }),
      },
      accountUsable: async (_region, account) => {
        probed.push(account.id)
        return account.id === 'bbb'
      },
    }), 'cn')
    if (status.status !== 'signed-in') throw new Error('expected signed-in')
    expect(status.credentialRejected).toBe(true)
    // The selected account is 'aaa', so only the OTHER account is probed.
    expect(probed).toEqual(['bbb'])
    expect(status.recovery?.usableAccount).toEqual({ accountId: 'bbb', accountName: 'Beta' })
    // Switching is the fix, so re-login must NOT be demanded.
    expect(status.recovery?.reloginRequired).toBe(false)
  })

  it('does not claim any account is usable when the probe confirms none', async () => {
    const status = await workBuddyWebStatus(deps({
      client: {
        fetchCredits: async () => { throw new WorkBuddyCredentialRejectedError(401) },
        fetchCheckinStatus: async () => { throw new WorkBuddyCredentialRejectedError(401) },
        claimDailyCheckin: async () => ({ credit: 100, streakDays: 1, isStreakDay: false }),
      },
      accountUsable: async () => false,
    }), 'cn')
    if (status.status !== 'signed-in') throw new Error('expected signed-in')
    expect(status.credentialRejected).toBe(true)
    expect(status.recovery?.usableAccount).toBeUndefined()
    // Other accounts exist, so "sign in again" is not the only fix and must not
    // be asserted — that assertion is what misleads when a switch would do.
    expect(status.recovery?.reloginRequired).toBe(false)
  })

  it('requires a re-login only when there is no other account to switch to', async () => {
    const single = [ACCOUNTS[0]!]
    const status = await workBuddyWebStatus(deps({
      store: () => ({ ...baseStore(), accounts: async () => single }) as never,
      client: {
        fetchCredits: async () => { throw new WorkBuddyCredentialRejectedError(403) },
        fetchCheckinStatus: async () => ({ active: true, todayCheckedIn: false, streakDays: 0, dailyCredit: 100, todayCredit: 0, isStreakDay: false, nextStreakDay: 0, streakBonusDays: 0, streakBonusCredit: 0 }),
        claimDailyCheckin: async () => ({ credit: 100, streakDays: 1, isStreakDay: false }),
      },
    }), 'cn')
    if (status.status !== 'signed-in') throw new Error('expected signed-in')
    expect(status.credentialRejected).toBe(true)
    expect(status.recovery?.reloginRequired).toBe(true)
  })

  it('does not treat an ordinary upstream fault as a refused credential', async () => {
    // A transient failure needs a retry, not a re-login: classifying it as a
    // credential problem would send the user to re-authenticate for nothing.
    const status = await workBuddyWebStatus(deps({
      client: {
        fetchCredits: async () => { throw new Error('workbuddy upstream server (http 503): busy') },
        fetchCheckinStatus: async () => { throw new Error('workbuddy upstream server (http 503): busy') },
        claimDailyCheckin: async () => ({ credit: 100, streakDays: 1, isStreakDay: false }),
      },
    }), 'cn')
    if (status.status !== 'signed-in') throw new Error('expected signed-in')
    expect(status.credentialRejected).toBeUndefined()
    expect(status.recovery).toBeUndefined()
  })

  it('classifies a JSON 401 body as a refused credential too', async () => {
    // The edge usually answers HTML, but a business-shaped 401 means the same
    // thing about the token, so it must reach the same advice.
    const status = await workBuddyWebStatus(deps({
      client: {
        fetchCredits: async () => { throw new WorkBuddyCredentialRejectedError(401) },
        fetchCheckinStatus: async () => ({ active: true, todayCheckedIn: false, streakDays: 0, dailyCredit: 100, todayCredit: 0, isStreakDay: false, nextStreakDay: 0, streakBonusDays: 0, streakBonusCredit: 0 }),
        claimDailyCheckin: async () => ({ credit: 100, streakDays: 1, isStreakDay: false }),
      },
      accountUsable: async () => false,
    }), 'cn')
    if (status.status !== 'signed-in') throw new Error('expected signed-in')
    expect(status.credentialRejected).toBe(true)
  })
})

describe('workBuddyWebStatus region routing', () => {
  it('reads the requested region\'s model slot and echoes the region', async () => {
    const seen: string[] = []
    const status = await workBuddyWebStatus(deps({
      displayModels: region => { seen.push(`models:${region}`); return FALLBACK_WORKBUDDY_MODELS },
      enabledModelIds: region => { seen.push(`enabled:${region}`); return ['hy3'] },
      imageModelIds: region => { seen.push(`image:${region}`); return [] },
      contextBudgets: region => { seen.push(`budgets:${region}`); return {} },
    }), 'global')
    if (status.status !== 'signed-in') throw new Error('expected signed-in')
    // The document's region is the requested one — the card writes its save
    // into that region's slot, so it must match the tab the user is on.
    expect(status.region).toBe('global')
    expect(new Set(seen)).toEqual(new Set([
      'models:global',
      'enabled:global',
      'image:global',
      'budgets:global',
    ]))
  })

  it('answers the cn region for the domestic tab', async () => {
    const status = await workBuddyWebStatus(deps(), 'cn')
    if (status.status !== 'signed-in') throw new Error('expected signed-in')
    expect(status.region).toBe('cn')
  })

  it('hands the requested region to the region-scoped store', async () => {
    const seenRegions: string[] = []
    const status = await workBuddyWebStatus(deps({
      store: region => {
        seenRegions.push(region)
        return baseStore() as never
      },
    }), 'global')
    if (status.status !== 'signed-in') throw new Error('expected signed-in')
    expect(seenRegions).toEqual(['global'])
    expect(status.region).toBe('global')
  })
})

describe('registerWorkBuddyStatusRoute', () => {
  /** A captured route entry: the path plus its HTTP handler. */
  interface CapturedEntry {
    path: string
    handler: (req: unknown, res: unknown) => Promise<void> | void
  }

  /** Mount the status routes against a fake webServer; return the captures. */
  async function mountRoutes(
    options: Partial<WorkBuddyStatusRouteOptions> = {},
  ): Promise<CapturedEntry[]> {
    const captured: CapturedEntry[] = []
    const FakeWebServer = {
      name: 'webServer',
      inject: [] as const,
      apply(ctx: Context) {
        ctx.provide('webServer', {
          register: (entry: { path: string }) => {
            captured.push(entry as CapturedEntry)
            return () => {}
          },
        })
      },
    }
    const ctx = new Context()
    await ctx.plugin(FakeWebServer)
    const { registerWorkBuddyStatusRoute } = await import('../src/web-status.ts')
    registerWorkBuddyStatusRoute(ctx, deps(options))
    await ctx.fiber.dispose()
    return captured
  }

  it('mounts the usage, account, check-in, and model routes', async () => {
    const captured = await mountRoutes()
    expect(captured.map(entry => entry.path)).toEqual([
      '/plugins/dsh-connect-workbuddy/usage',
      '/plugins/dsh-connect-workbuddy/accounts/refresh',
      '/plugins/dsh-connect-workbuddy/checkin',
      '/plugins/dsh-connect-workbuddy/models/refresh',
    ])
  })

  it('routes the region query to that region\'s store, defaulting to cn', async () => {
    const seenRegions: string[] = []
    const captured = await mountRoutes({
      store: region => {
        seenRegions.push(region)
        return baseStore() as never
      },
    })
    const usage = captured.find(entry => entry.path === WORKBUDDY_USAGE_PATH)
    if (usage === undefined) throw new Error('usage route was not registered')
    const first = response()
    await usage.handler(request('GET', undefined, `${WORKBUDDY_USAGE_PATH}?region=global`), first.res)
    expect(first.status()).toBe(200)
    expect(first.body()).toMatchObject({ status: 'signed-in', region: 'global' })
    expect(seenRegions.slice()).toEqual(['global'])
    const second = response()
    await usage.handler(request('GET', undefined, WORKBUDDY_USAGE_PATH), second.res)
    expect(second.status()).toBe(200)
    expect(second.body()).toMatchObject({ region: 'cn' })
    expect(seenRegions).toEqual(['global', 'cn'])
  })

  it('refuses an unknown region with 400 before touching the store', async () => {
    const seenRegions: string[] = []
    const captured = await mountRoutes({
      store: region => {
        seenRegions.push(region)
        return baseStore() as never
      },
    })
    const usage = captured.find(entry => entry.path === WORKBUDDY_USAGE_PATH)
    if (usage === undefined) throw new Error('usage route was not registered')
    const { res, status, body } = response()
    await usage.handler(request('GET', undefined, `${WORKBUDDY_USAGE_PATH}?region=eu`), res)
    expect(status()).toBe(400)
    expect(body()).toMatchObject({ error: 'unknown region' })
    expect(seenRegions).toEqual([])
  })

  /** Mount the status routes against a fake webServer; return the check-in handler. */
  async function mountCheckinHandler(
    options: Partial<WorkBuddyStatusRouteOptions> = {},
  ): Promise<CapturedEntry['handler']> {
    const captured = await mountRoutes(options)
    const checkin = captured.find(entry => entry.path === WORKBUDDY_CHECKIN_PATH)
    if (checkin === undefined) throw new Error('check-in route was not registered')
    return checkin.handler
  }

  /** Minimal request; an absent Origin header reads as loopback. */
  function request(method = 'POST', origin?: string, url?: string): { method: string; url: string; headers: { origin?: string } } {
    return { method, url: url ?? '/', headers: origin === undefined ? {} : { origin } }
  }

  /** Response recorder: json() only needs writeHead + end. */
  function response(): {
    res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (payload?: string) => void }
    status: () => number
    body: () => unknown
  } {
    let statusCode = 0
    let payload = ''
    return {
      res: {
        writeHead: (status: number) => { statusCode = status },
        end: (body?: string) => { payload = body ?? '' },
      },
      status: () => statusCode,
      body: () => JSON.parse(payload),
    }
  }

  /** Check-in status with every field, matching the upstream document. */
  function checkinStatus(overrides: Partial<{ active: boolean; todayCheckedIn: boolean; streakDays: number }>) {
    return {
      active: true,
      todayCheckedIn: false,
      streakDays: 0,
      dailyCredit: 100,
      todayCredit: 0,
      isStreakDay: false,
      nextStreakDay: 0,
      streakBonusDays: 0,
      streakBonusCredit: 0,
      ...overrides,
    }
  }

  it('refuses with 409 and never claims when the activity is inactive (global-account shape)', async () => {
    const claims: number[] = []
    const handler = await mountCheckinHandler({
      client: {
        fetchCredits: async () => { throw new Error('unused') },
        fetchCheckinStatus: async () => checkinStatus({ active: false }),
        claimDailyCheckin: async () => { claims.push(1); return { credit: 100, streakDays: 1, isStreakDay: false } },
      },
    })
    const { res, status, body } = response()
    await handler(request(), res)
    expect(status()).toBe(409)
    expect(claims).toEqual([])
    expect(body()).toMatchObject({ error: 'check-in activity is not active' })
  })

  it('answers alreadyCheckedIn without calling the upstream claim', async () => {
    const claims: number[] = []
    const handler = await mountCheckinHandler({
      client: {
        fetchCredits: async () => { throw new Error('unused') },
        fetchCheckinStatus: async () => checkinStatus({ active: true, todayCheckedIn: true, streakDays: 11 }),
        claimDailyCheckin: async () => { claims.push(1); return { credit: 0, streakDays: 11, isStreakDay: false } },
      },
    })
    const { res, status, body } = response()
    await handler(request(), res)
    expect(status()).toBe(200)
    expect(claims).toEqual([])
    expect(body()).toMatchObject({ alreadyCheckedIn: true })
  })

  it('claims exactly once for an active unchecked day and returns the refreshed status', async () => {
    const claims: number[] = []
    const reads: number[] = []
    const handler = await mountCheckinHandler({
      client: {
        fetchCredits: async () => { throw new Error('unused') },
        // First read (the guard) reports unchecked; the post-claim refresh
        // reports the day as claimed, exactly like the upstream does.
        fetchCheckinStatus: async () => {
          reads.push(1)
          return checkinStatus({ todayCheckedIn: reads.length > 1, streakDays: reads.length > 1 ? 6 : 5 })
        },
        claimDailyCheckin: async () => { claims.push(1); return { credit: 100, streakDays: 6, isStreakDay: false } },
      },
    })
    const { res, status, body } = response()
    await handler(request('POST', undefined, `${WORKBUDDY_CHECKIN_PATH}?region=global`), res)
    expect(status()).toBe(200)
    expect(claims).toHaveLength(1)
    expect(reads).toHaveLength(2)
    expect(body()).toMatchObject({
      alreadyCheckedIn: false,
      claim: { credit: 100, streakDays: 6 },
      checkin: { todayCheckedIn: true, streakDays: 6 },
    })
  })

  it('refuses non-loopback origins with 403 before touching the upstream', async () => {
    const handler = await mountCheckinHandler()
    const { res, status } = response()
    await handler(request('POST', 'https://evil.example.com'), res)
    expect(status()).toBe(403)
  })

  it('refuses non-POST methods with 405', async () => {
    const handler = await mountCheckinHandler()
    const { res, status } = response()
    await handler(request('GET'), res)
    expect(status()).toBe(405)
  })
})

/**
 * The card document must not carry identifiers the card never renders.
 *
 * `uin` was forwarded to the browser while nothing ever displayed it, which
 * made it pure exposure of an account identifier. The name travels as a name
 * (empty when unknown) so the card can supply its own placeholder.
 */
describe('workBuddyWebStatus account identifiers', () => {
  it('never sends uin to the browser', async () => {
    const status = await workBuddyWebStatus(deps(), 'cn')
    if (status.status !== 'signed-in') throw new Error('expected signed-in')
    const payload = JSON.stringify(status)
    expect(payload).not.toContain('100000000001')
    expect(payload).not.toContain('100000000002')
    for (const account of status.accounts) {
      expect(Object.keys(account)).not.toContain('uin')
    }
    expect(Object.keys(status)).not.toContain('uin')
  })

  it('sends an empty name rather than an identifier when no nickname exists', async () => {
    // `exactOptionalPropertyTypes` forbids assigning `undefined`, so the field
    // is omitted rather than blanked.
    const { nickname: _dropped, ...withoutNickname } = CREDENTIAL
    const nameless: WorkBuddyCredential = withoutNickname
    const status = await workBuddyWebStatus(deps({
      store: () => ({
        ...baseStore(),
        resolve: async () => nameless,
        accounts: async () => [{ ...ACCOUNTS[0]!, accountName: '' }],
      }) as never,
    }), 'cn')
    if (status.status !== 'signed-in') throw new Error('expected signed-in')
    expect(status.accountName).toBe('')
    expect(status.accounts[0]?.accountName).toBe('')
    // The account is still identified for the picker by its id...
    expect(status.accountId).toBe('aaa')
    // ...and no identifier leaks through the name.
    expect(status.accountName).not.toContain('100000000001')
  })
})
