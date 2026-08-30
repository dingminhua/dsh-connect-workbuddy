import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { workBuddyWebStatus } from '../src/web-status.ts'
import type { WorkBuddyStatusRouteOptions } from '../src/web-status.ts'
import { FALLBACK_WORKBUDDY_MODELS } from '../src/catalog.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

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

function deps(overrides: Partial<WorkBuddyStatusRouteOptions> = {}): WorkBuddyStatusRouteOptions {
  return {
    store: {
      accounts: async () => ACCOUNTS,
      status: async () => ({ state: 'signed-in', expiresAtMs: CREDENTIAL.expiresAtMs }),
      resolve: async () => CREDENTIAL,
      accountsFail: false,
    } as never,
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
    contextBudgets: () => ({}),
    ...overrides,
  }
}

describe('workBuddyWebStatus', () => {
  it('reports signed-out with accounts when no credential resolves', async () => {
    const status = await workBuddyWebStatus(deps({
      store: {
        accounts: async () => ACCOUNTS,
        status: async () => ({ state: 'signed-out' }),
        resolve: async () => { throw new Error('workbuddy: no signed-in account') },
      } as never,
    }))
    expect(status.status).toBe('signed-out')
    if (status.status !== 'signed-out') return
    expect(status.accounts).toHaveLength(2)
  })

  it('reports signed-out with an empty list when no credential file exists at all', async () => {
    const status = await workBuddyWebStatus(deps({
      store: {
        accounts: async () => [],
        status: async () => ({ state: 'signed-out' }),
        resolve: async () => { throw new Error('no account') },
      } as never,
    }))
    expect(status.status).toBe('signed-out')
    if (status.status !== 'signed-out') return
    expect(status.accounts).toEqual([])
  })

  it('never puts token material in the signed-in document', async () => {
    const status = await workBuddyWebStatus(deps())
    expect(status.status).toBe('signed-in')
    const serialized = JSON.stringify(status)
    // Field names are the contract; leak detection is about token-shaped values.
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]+\./u)
    expect(serialized).not.toMatch(/"(accessToken|refreshToken)"/u)
    expect(serialized).not.toContain('access')
  })

  it('carries accounts, models, selection, and credits', async () => {
    const status = await workBuddyWebStatus(deps())
    if (status.status !== 'signed-in') throw new Error('expected signed-in')
    expect(status.accountName).toBe('Alpha')
    expect(status.accounts).toHaveLength(2)
    expect(status.models.length).toBe(FALLBACK_WORKBUDDY_MODELS.length)
    const glm = status.models.find(model => model.id === 'glm-5.3')
    expect(glm).toMatchObject({ nativeContextWindow: 1_000_000, contextWindow: 200_000 })
    expect(status.enabledModelIds).toEqual(['glm-5.3'])
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
    }))
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
    }))
    if (status.status !== 'signed-in') throw new Error('expected signed-in')
    expect(status.creditsError).toContain('[redacted token]')
    expect(status.creditsError).toContain('[redacted]')
    expect(status.creditsError).not.toContain('supersecret')
  })
})

describe('registerWorkBuddyStatusRoute', () => {
  it('mounts the usage, account, check-in, and model routes', async () => {
    const registered: string[] = []
    // Provide the service through Cordis so `ctx.get('webServer')` sees it.
    const FakeWebServer = {
      name: 'webServer',
      inject: [] as const,
      apply(ctx: Context) {
        ctx.provide('webServer', {
          register: (entry: { path: string }) => {
            registered.push(entry.path)
            return () => {}
          },
        })
      },
    }
    const ctx = new Context()
    await ctx.plugin(FakeWebServer)
    const { registerWorkBuddyStatusRoute } = await import('../src/web-status.ts')
    registerWorkBuddyStatusRoute(ctx, deps())
    expect(registered).toEqual([
      '/plugins/dsh-connect-workbuddy/usage',
      '/plugins/dsh-connect-workbuddy/accounts/refresh',
      '/plugins/dsh-connect-workbuddy/checkin',
      '/plugins/dsh-connect-workbuddy/models/refresh',
    ])
    await ctx.fiber.dispose()
  })
})
