import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { registerWorkBuddyStatusRoute } from '../src/web-status.ts'
import type { WorkBuddyStatusRouteOptions, WorkBuddyPoolDeps } from '../src/web-status.ts'
import { WORKBUDDY_POOL_PATH } from '../src/status-paths.ts'
import type { WorkBuddyRegion } from '../src/upstream.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

interface CapturedEntry {
  path: string
  handler: (req: unknown, res: unknown) => Promise<void> | void
}

/** A minimal request; an absent Origin header reads as loopback. */
function request(
  method = 'POST',
  url = `${WORKBUDDY_POOL_PATH}?region=cn&action=test`,
  origin?: string,
): { method: string, url: string, headers: { origin?: string } } {
  return { method, url, headers: origin === undefined ? {} : { origin } }
}

/**
 * Response recorder.
 *
 * `json()` needs writeHead + end; the TEST action additionally STREAMS (one
 * NDJSON line per account), so `write` is recorded too. Everything written lands
 * in one buffer, so `body()` reads a single-document answer and `lines()` reads a
 * streamed one — the shape a given test expects is the shape it reaches for.
 */
function response(): {
  res: {
    writeHead: (status: number, headers?: Record<string, string>) => void
    write: (chunk: string) => void
    end: (payload?: string) => void
  }
  status: () => number
  headers: () => Record<string, string>
  body: () => Record<string, unknown>
  lines: () => Record<string, unknown>[]
} {
  let statusCode = 0
  let headers: Record<string, string> = {}
  const chunks: string[] = []
  const written = (): string => chunks.join('')
  return {
    res: {
      writeHead: (status: number, next?: Record<string, string>) => {
        statusCode = status
        if (next !== undefined) headers = next
      },
      write: (chunk: string) => { chunks.push(chunk) },
      end: (body?: string) => {
        if (body !== undefined) chunks.push(body)
      },
    },
    status: () => statusCode,
    headers: () => headers,
    body: () => JSON.parse(written()) as Record<string, unknown>,
    lines: () => written()
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>),
  }
}

const FREE_CATALOG: readonly WorkBuddyModelInfo[] = [
  { id: 'deepseek-v4.1-flash', name: 'Free', contextWindow: 1_000_000, maxTokens: 8_000, creditMultiplier: 0 },
  { id: 'glm-5.3', name: 'Paid', contextWindow: 1_000_000, maxTokens: 8_000, creditMultiplier: 0.79 },
]

/** A pool dependency double with per-test overrides. */
function poolDeps(overrides: Partial<WorkBuddyPoolDeps> = {}): WorkBuddyPoolDeps {
  const preferences = overrides.preferences ?? ((): {
    enabled: boolean
    targetModelId: string
    memberAccountIds: readonly string[]
  } => ({
    enabled: true,
    targetModelId: '',
    memberAccountIds: ['a'],
  }))
  return {
    preferences,
    members: async () => [],
    // Defaults to "everything checked is still signed in", DERIVED from the
    // test's own saved list — so a test that empties `memberAccountIds` gets an
    // empty effective list too (the "nothing checked" case) rather than a
    // mismatched double that would let a batch through.
    effectiveMemberAccountIds: async region => [...preferences(region).memberAccountIds],
    catalog: () => FREE_CATALOG,
    // The CN region is the one with a daily check-in; the route refuses the
    // action elsewhere, and the tests below drive the CN shape.
    checkinSupported: () => true,
    checkin: async () => [{ accountId: 'a', accountName: 'Alpha', status: 'claimed', credit: 60 }],
    test: async (_region: WorkBuddyRegion, modelId: string) => [
      { accountId: 'a', accountName: 'Alpha', result: { modelId, outcome: 'ok' } },
    ],
    ...overrides,
  }
}

/** Base deps: the pool route needs nothing else from the Host. */
/**
 * A store double with one signed-in account, so the usage route takes its
 * SIGNED-IN branch (the pool block only exists there — a signed-out document
 * has no accounts to pool).
 */
function signedInStore(): unknown {
  const credential = {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAtMs: Date.now() + 86_400_000,
    domain: 'www.codebuddy.cn',
    uid: 'uid-a',
    uin: '100000000001',
    nickname: 'Alpha',
    source: 'desktop',
    filePath: '/tmp/a.info',
  }
  return {
    accounts: async () => [{
      id: 'a',
      accountName: 'Alpha',
      domain: 'www.codebuddy.cn',
      source: 'desktop',
      tokenExpiresAtMs: credential.expiresAtMs,
      filePath: credential.filePath,
      selected: true,
    }],
    current: async () => credential,
    resolve: async () => credential,
    credentialFor: async () => credential,
    selectionLost: async () => false,
    // The usage route reads these to summarise the region's sign-in state.
    status: async () => ({ accounts: 1, selected: true }),
    hasExplicitSelection: async () => true,
  }
}

function deps(pool?: WorkBuddyPoolDeps): WorkBuddyStatusRouteOptions {
  return {
    store: () => signedInStore() as never,
    client: {
      fetchCredits: async () => ({ total: 0, packages: [], expiringSoon: 0 }),
      fetchCheckinStatus: async () => ({ active: true, todayCheckedIn: true }) as never,
      claimDailyCheckin: async () => ({ credit: 0, streakDays: 0, isStreakDay: false }),
    },
    displayModels: () => [],
    enabledModelIds: () => [],
    imageModelIds: () => [],
    contextBudgets: () => ({}),
    regionEnabled: () => true,
    ...pool === undefined ? {} : { pool },
  }
}

/** Mount the routes against a fake webServer and return the pool handler. */
async function mountPoolHandler(
  options: WorkBuddyStatusRouteOptions = deps(poolDeps()),
): Promise<CapturedEntry['handler']> {
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
  registerWorkBuddyStatusRoute(ctx, options)
  await ctx.fiber.dispose()
  const pool = captured.find(entry => entry.path === WORKBUDDY_POOL_PATH)
  if (pool === undefined) throw new Error('pool route was not registered')
  return pool.handler
}

/** Mount routes; return the usage handler. */
async function mountUsage(
  pool: WorkBuddyPoolDeps,
): Promise<(req: unknown, res: unknown) => Promise<void> | void> {
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
  registerWorkBuddyStatusRoute(ctx, deps(pool))
  await ctx.fiber.dispose()
  const usage = captured.find(entry => entry.path === '/plugins/dsh-connect-workbuddy/usage')
  if (usage === undefined) throw new Error('usage route was not registered')
  return usage.handler
}

describe('the account-pool route', () => {
  it('streams one line per account, in order, so the card can report progress', async () => {
    // The defect: the route held the whole batch, and the batch is SERIAL, so the
    // card could not say anything until the slowest member answered. One stuck
    // account therefore looked like a dead button. Each row now lands as it
    // happens: a header line naming the model, then one line per account, then a
    // completion line.
    const handler = await mountPoolHandler(deps(poolDeps({
      test: async (_region, modelId, onRow) => {
        const rows = [
          { accountId: 'a', accountName: 'Alpha', result: { modelId, outcome: 'ok' as const } },
          { accountId: 'b', accountName: 'Beta', result: { modelId, outcome: 'rate-limited' as const } },
        ]
        for (const row of rows) onRow?.(row)
        return rows
      },
    })))
    const { res, status, headers, lines } = response()
    await handler(request(), res)
    expect(status()).toBe(200)
    expect(headers()['Content-Type']).toBe('application/x-ndjson')
    expect(lines()).toHaveLength(4)
    // The model first, so the card can label the progress before any account runs.
    expect(lines()[0]?.['modelId']).toBe('deepseek-v4.1-flash')
    const rowOf = (line: Record<string, unknown> | undefined): { accountId?: string } =>
      (line?.['row'] ?? {}) as { accountId?: string }
    expect(rowOf(lines()[1]).accountId).toBe('a')
    expect(rowOf(lines()[2]).accountId).toBe('b')
    expect(lines()[3]?.['done']).toBe(true)
  })

  it('runs the check-in batch for the addressed region', async () => {
    const handler = await mountPoolHandler(deps(poolDeps()))
    const { res, status, body } = response()
    await handler(request('POST', `${WORKBUDDY_POOL_PATH}?region=cn&action=checkin`), res)
    expect(status()).toBe(200)
    expect(body()['action']).toBe('checkin')
    expect((body()['rows'] as unknown[]).length).toBe(1)
  })

  it('resolves the free model itself rather than trusting the client', async () => {
    // The card sends no model id: which model a batch spends on is a Host
    // decision, so a stale or hand-rolled client cannot make it test a paid one.
    let asked: string | undefined
    const handler = await mountPoolHandler(deps(poolDeps({
      test: async (_region, modelId) => {
        asked = modelId
        return [{ accountId: 'a', accountName: 'Alpha', result: { modelId, outcome: 'ok' } }]
      },
    })))
    const { res, status, lines } = response()
    await handler(request(), res)
    expect(status()).toBe(200)
    expect(asked).toBe('deepseek-v4.1-flash')
    // The stream OPENS by naming the model it resolved, before any account is
    // touched — so the card can label the progress it is about to show.
    expect(lines()[0]?.['modelId']).toBe('deepseek-v4.1-flash')
  })

  it('refuses a test when the region has no free model, instead of billing a paid one', async () => {
    let called = false
    const handler = await mountPoolHandler(deps(poolDeps({
      catalog: () => [FREE_CATALOG[1] as WorkBuddyModelInfo],
      test: async () => {
        called = true
        return []
      },
    })))
    const { res, status, body } = response()
    await handler(request(), res)
    expect(status()).toBe(409)
    expect(called).toBe(false)
    expect(String(body()['error'])).toContain('no zero-multiplier model')
    // The reason the card localizes (D2/M-3). `no-free-model` is distinct from
    // `target-model-stale`: the first means the catalog offered nothing free,
    // the second means the user's saved pick is gone.
    expect(body()['reason']).toBe('no-free-model')
  })

  it('honours an explicitly chosen target model', async () => {
    let asked: string | undefined
    const handler = await mountPoolHandler(deps(poolDeps({
      preferences: () => ({
        enabled: true,
        targetModelId: 'glm-5.3',
        memberAccountIds: ['a'],
      }),
      test: async (_region, modelId) => {
        asked = modelId
        return []
      },
    })))
    const { res, status } = response()
    await handler(request(), res)
    expect(status()).toBe(200)
    expect(asked).toBe('glm-5.3')
  })

  it('runs the batch even when the pool is switched off', async () => {
    // The switch gates AUTOMATIC routing (does the plugin pick the serving
    // account by itself, does it retry elsewhere after a failure), NOT whether
    // the user may act on the accounts they checked. Refusing here — together
    // with the card disabling the buttons — left "manual mode" with no way to
    // check in or test anything, which is the opposite of what the switch is for.
    //
    // Membership is still required, so this test checks an account to get past
    // that guard: "the pool is off" must not be read as "then run nothing".
    let called = false
    const handler = await mountPoolHandler(deps(poolDeps({
      preferences: () => ({
        enabled: false,
        targetModelId: '',
        memberAccountIds: ['a'],
      }),
      test: async () => {
        called = true
        return [{ accountId: 'a', accountName: 'Alpha', result: { modelId: 'free-1', outcome: 'ok' } }]
      },
    })))
    const { res, status } = response()
    await handler(request(), res)
    expect(status(), 'a manual batch must not be refused just because the pool switch is off').toBe(200)
    expect(called).toBe(true)
  })

  it('refuses a non-POST method', async () => {
    // Both actions are writes: check-in claims a reward, a test spends credits.
    const handler = await mountPoolHandler()
    const { res, status } = response()
    await handler(request('GET'), res)
    expect(status()).toBe(405)
  })

  it('refuses a non-loopback origin', async () => {
    const handler = await mountPoolHandler()
    const { res, status } = response()
    await handler(request('POST', `${WORKBUDDY_POOL_PATH}?region=cn&action=test`, 'https://evil.example'), res)
    expect(status()).toBe(403)
  })

  it('refuses an unknown action', async () => {
    const handler = await mountPoolHandler()
    const { res, status } = response()
    await handler(request('POST', `${WORKBUDDY_POOL_PATH}?region=cn&action=delete`), res)
    expect(status()).toBe(400)
  })

  it('refuses an unknown region', async () => {
    const handler = await mountPoolHandler()
    const { res, status } = response()
    await handler(request('POST', `${WORKBUDDY_POOL_PATH}?region=mars&action=test`), res)
    expect(status()).toBe(400)
  })

  it('runs NOTHING when no account is checked into the pool', async () => {
    // Membership is an explicit opt-in. "Nothing checked" must never degrade
    // into "then do all of them" — that reading would spend credits and claim
    // rewards on accounts the user never selected.
    let checkinCalled = false
    let testCalled = false
    const handler = await mountPoolHandler(deps(poolDeps({
      preferences: () => ({
        enabled: true,
        targetModelId: '',
        memberAccountIds: [],
      }),
      checkin: async () => {
        checkinCalled = true
        return []
      },
      test: async () => {
        testCalled = true
        return []
      },
    })))

    for (const action of ['checkin', 'test']) {
      const { res, status, body } = response()
      await handler(request('POST', `${WORKBUDDY_POOL_PATH}?region=cn&action=${action}`), res)
      expect(status()).toBe(409)
      expect(String(body()['error'])).toContain('no accounts are checked')
      // Truly EMPTY, as opposed to "checked but no longer signed in" — the card
      // shows a different instruction for each, so the two reasons must not
      // collapse into one (M-3). The Host's distinction was dead code until the
      // card started reading it.
      expect(body()['reason']).toBe('no-members')
    }
    expect(checkinCalled).toBe(false)
    expect(testCalled).toBe(false)
  })

  it('runs as soon as one account is checked', async () => {
    const handler = await mountPoolHandler(deps(poolDeps({
      preferences: () => ({
        enabled: true,
        targetModelId: '',
        memberAccountIds: ['a'],
      }),
    })))
    const { res, status } = response()
    await handler(request(), res)
    expect(status()).toBe(200)
  })

  it('distinguishes "nothing checked" from "nothing still signed in" (M-3 / D2)', async () => {
    // Both refuse with 409, but the FIX differs: one asks the user to check an
    // account, the other to sign in again (or save to drop the ghosts). The card
    // reads `reason`, so a collapsed reason would send a ghost-member user to the
    // wrong instruction — and, before `reason` existed, to a raw English string.
    let called = false
    const handler = await mountPoolHandler(deps(poolDeps({
      preferences: () => ({
        enabled: true,
        targetModelId: '',
        // A saved id, but no local sign-in resolves it.
        memberAccountIds: ['ghost'],
      }),
      effectiveMemberAccountIds: async () => [],
      test: async () => {
        called = true
        return []
      },
    })))
    const { res, status, body } = response()
    await handler(request(), res)
    expect(status()).toBe(409)
    expect(called).toBe(false)
    expect(body()['reason']).toBe('no-live-members')
    expect(String(body()['error'])).toContain('still has a local sign-in')
  })

  it('answers 503 when the Host has no pool support at all', async () => {
    const handler = await mountPoolHandler(deps(undefined))
    const { res, status, body } = response()
    await handler(request(), res)
    expect(status()).toBe(503)
    // The `reason` is what the card localizes (D2); without it the card falls
    // back to the raw English `error` string in a Chinese UI. Deleting it used
    // to leave the whole suite green, because this file never read the field.
    expect(body()['reason']).toBe('pool-unavailable')
  })

  it('answers 503 when only the requested action is unavailable', async () => {
    const handler = await mountPoolHandler(deps(poolDeps({ test: undefined as never })))
    const { res, status, body } = response()
    await handler(request(), res)
    expect(status()).toBe(503)
    expect(body()['reason']).toBe('pool-unavailable')
  })

  it('answers 503 with an explicit reason when the CHECKIN route is unavailable', async () => {
    // N11/M24/M36: the sibling test above only ever removed `test`. The Host
    // has a SECOND host-dependency pair for check-in (`src/web-status.ts:857`),
    // reached by requesting the `checkin` action, and NOTHING asserted that
    // branch — so its whole `reason` field could be deleted (M36) or changed to
    // `pool-failed` (M24) with the suite still green.
    //
    // That matters because the card PREFERS `reason` over the raw `error`
    // string (src/client/pool-state.ts:172 maps it to localized copy) and only
    // falls back to English when no reason arrives. `pool-failed` in particular
    // would tell the user a BATCH FAILED ("批量操作在宿主侧失败") when the truth
    // is that this build simply has no check-in route — a different problem
    // with a different fix, which is exactly the distinction D2 protects.
    //
    // This pins the CURRENT value. Note check-in and test deliberately share
    // `pool-unavailable` (both mean "this build lacks the route"), so the
    // assertion is on the value the code actually sends, not a fancier one —
    // its job is to make any future edit to this line fail loudly.
    const handler = await mountPoolHandler(deps(poolDeps({ checkin: undefined as never })))
    const { res, status, body } = response()
    await handler(request('POST', `${WORKBUDDY_POOL_PATH}?region=cn&action=checkin`), res)
    expect(status()).toBe(503)
    expect(body()['reason']).toBe('pool-unavailable')
  })

  it('refuses the check-in action for a region that has no check-in', async () => {
    // The international region has no daily check-in. Refusing HERE, before the
    // client is ever called, is what keeps the hidden button and the endpoint in
    // agreement: a page that still had the button (a stale tab, a hand-rolled
    // request) cannot reach an action the product does not offer — and it gets a
    // distinct cause rather than a generic failure, so a caller can tell "not
    // offered here" from "offered, but it broke".
    const checkin = vi.fn(async () => [
      { accountId: 'a', accountName: 'Alpha', status: 'claimed' as const },
    ])
    const handler = await mountPoolHandler(deps(poolDeps({
      checkinSupported: () => false,
      checkin: checkin as never,
    })))
    const { res, status, body } = response()
    await handler(request('POST', `${WORKBUDDY_POOL_PATH}?region=global&action=checkin`), res)
    expect(status()).toBe(409)
    expect(body()['reason']).toBe('checkin-unsupported')
    // Nothing was spent: the refusal happens before any upstream call.
    expect(checkin).not.toHaveBeenCalled()
  })

  it('reports the region capability in the document the card renders from', async () => {
    // The card decides whether to draw the button and the column from THIS flag,
    // so the two halves cannot drift: a card that hid the action while the route
    // still offered it would be a UI-only rule, and the reverse would hide a
    // working action.
    const handler = await mountUsage(poolDeps({ checkinSupported: region => region === 'cn' }))
    const domestic = response()
    await handler(request('GET', '/plugins/dsh-connect-workbuddy/usage?region=cn'), domestic.res)
    expect((domestic.body() as { pool?: { checkinSupported?: boolean } }).pool?.checkinSupported).toBe(true)

    const international = response()
    await handler(request('GET', '/plugins/dsh-connect-workbuddy/usage?region=global'), international.res)
    expect((international.body() as { pool?: { checkinSupported?: boolean } }).pool?.checkinSupported).toBe(false)
  })

  it('reports a failing batch as a streamed error line rather than a silent success', async () => {
    // The route streams, so the status is committed by the first line and a
    // mid-batch failure can no longer become a 500. It travels as a LINE instead
    // — and it must still be an explicit failure, because a truncated stream with
    // no error line is indistinguishable from a batch that tested nothing.
    const handler = await mountPoolHandler(deps(poolDeps({
      test: async () => { throw new Error('upstream exploded') },
    })))
    const { res, status, lines } = response()
    await handler(request(), res)
    expect(status()).toBe(200)
    const failure = lines().find(line => line['reason'] !== undefined)
    expect(failure?.['reason']).toBe('pool-failed')
    expect(String(failure?.['error'])).toContain('upstream exploded')
    // No completion line: the batch did not finish, and saying otherwise would
    // let the card log a success it never had.
    expect(lines().some(line => line['done'] === true)).toBe(false)
  })

  it('redacts token-shaped text out of a failure message', async () => {
    const handler = await mountPoolHandler(deps(poolDeps({
      test: async () => {
        throw new Error('failed with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij')
      },
    })))
    const { res, lines } = response()
    await handler(request(), res)
    const failure = lines().find(line => line['reason'] !== undefined)
    expect(String(failure?.['error'])).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(String(failure?.['error'])).toContain('[redacted token]')
  })

  it('defaults to the domestic region when none is named', async () => {
    const handler = await mountPoolHandler(deps(poolDeps()))
    const { res, status } = response()
    await handler(request('POST', `${WORKBUDDY_POOL_PATH}?action=test`), res)
    expect(status()).toBe(200)
  })
})

describe('the pool block in the usage document', () => {
  it('is absent when the Host has no pool support', async () => {
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
    registerWorkBuddyStatusRoute(ctx, deps(undefined))
    await ctx.fiber.dispose()
    expect(captured.map(entry => entry.path)).toContain(WORKBUDDY_POOL_PATH)
  })
})

describe('the pool listing in the usage document', () => {
  it('lists unchecked accounts so membership can be granted from the card', async () => {
    // An opt-in nobody can see is not an opt-in: the card must be able to offer
    // accounts that are not in the pool yet.
    const handler = await mountUsage(poolDeps({
      members: async () => [
        { account: { id: 'a', accountName: 'Alpha' }, credits: { total: 100, expiringSoon: 0 } },
      ],
      otherAccounts: async () => [
        { id: 'b', accountName: 'Beta' },
        { id: 'c', accountName: 'Gamma' },
      ],
    }))
    const { res, body } = response()
    await handler(request('GET', '/plugins/dsh-connect-workbuddy/usage?region=cn'), res)
    const pool = (body() as { pool?: { accounts?: { accountId: string, member: boolean }[] } }).pool
    expect(pool?.accounts?.map(row => row.accountId)).toEqual(['a', 'b', 'c'])
    expect(pool?.accounts?.map(row => row.member)).toEqual([true, false, false])
  })

  it('does not list an account twice when it is both a member and local', async () => {
    const handler = await mountUsage(poolDeps({
      members: async () => [
        { account: { id: 'a', accountName: 'Alpha' }, credits: { total: 1, expiringSoon: 0 } },
      ],
      otherAccounts: async () => [{ id: 'a', accountName: 'Alpha' }],
    }))
    const { res, body } = response()
    await handler(request('GET', '/plugins/dsh-connect-workbuddy/usage?region=cn'), res)
    const rows = (body() as { pool?: { accounts?: { accountId: string }[] } }).pool?.accounts ?? []
    expect(rows.map(row => row.accountId)).toEqual(['a'])
  })

  it('reports the checked ids so the card can render its checkboxes', async () => {
    const handler = await mountUsage(poolDeps({
      preferences: () => ({
        enabled: true,
        targetModelId: '',
        memberAccountIds: ['a', 'b'],
      }),
    }))
    const { res, body } = response()
    await handler(request('GET', '/plugins/dsh-connect-workbuddy/usage?region=cn'), res)
    expect((body() as { pool?: { memberAccountIds?: string[] } }).pool?.memberAccountIds)
      .toEqual(['a', 'b'])
  })
})

describe('the check-in column must not lie', () => {
  it('OMITS the state when it was not read, instead of asserting "not checked in"', async () => {
    // The defect: the card hard-coded "未签到", so a successful one-click
    // check-in left the table still saying every account was unsigned — the UI
    // contradicted the result the user had just watched succeed.
    const handler = await mountUsage(poolDeps({
      members: async () => [
        { account: { id: 'a', accountName: 'Alpha' }, credits: { total: 1, expiringSoon: 0 } },
      ],
      // No `checkedInToday` dep at all: nothing was read.
    }))
    const { res, body } = response()
    await handler(request('GET', '/plugins/dsh-connect-workbuddy/usage?region=cn'), res)
    const rows = (body() as { pool?: { accounts?: { accountId: string, checkedInToday?: boolean }[] } })
      .pool?.accounts ?? []
    const row = rows.find(entry => entry.accountId === 'a')
    expect(row).toBeDefined()
    // ABSENT, not `false`: "unknown" and "not checked in" are different claims.
    expect(row?.checkedInToday).toBeUndefined()
  })

  it('passes a read state through, including an explicit false', async () => {
    const handler = await mountUsage(poolDeps({
      members: async () => [
        { account: { id: 'a', accountName: 'Alpha' }, credits: { total: 1, expiringSoon: 0 } },
        { account: { id: 'b', accountName: 'Beta' }, credits: { total: 1, expiringSoon: 0 } },
      ],
      checkedInToday: async () => ({ a: true, b: false }),
    }))
    const { res, body } = response()
    await handler(request('GET', '/plugins/dsh-connect-workbuddy/usage?region=cn'), res)
    const rows = (body() as { pool?: { accounts?: { accountId: string, checkedInToday?: boolean }[] } })
      .pool?.accounts ?? []
    expect(rows.find(row => row.accountId === 'a')?.checkedInToday).toBe(true)
    // An explicit false IS a claim, so it must survive.
    expect(rows.find(row => row.accountId === 'b')?.checkedInToday).toBe(false)
  })

  it('survives a failing check-in read by reporting unknown, not an error', async () => {
    // One unreadable account must not blank the pool.
    const handler = await mountUsage(poolDeps({
      members: async () => [
        { account: { id: 'a', accountName: 'Alpha' }, credits: { total: 1, expiringSoon: 0 } },
      ],
      checkedInToday: async () => { throw new Error('billing route down') },
    }))
    const { res, status, body } = response()
    await handler(request('GET', '/plugins/dsh-connect-workbuddy/usage?region=cn'), res)
    expect(status()).toBe(200)
    const rows = (body() as { pool?: { accounts?: { checkedInToday?: boolean }[] } }).pool?.accounts ?? []
    expect(rows[0]?.checkedInToday).toBeUndefined()
  })
})
