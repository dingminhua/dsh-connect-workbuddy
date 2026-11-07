/**
 * Folding one streamed test row into the document the panel renders.
 *
 * The batch is serial and streamed, so each account's measurement arrives while
 * the other accounts are still being tested. The panel has to show the row the
 * user is watching the moment that account's line lands — waiting for the batch
 * end is what made the button look dead for the duration of the slowest member.
 *
 * These cases pin the two decisions that makes that safe:
 *
 * 1. A row is matched to an account by ID, never guessed from a name two
 *    accounts might share.
 * 2. The exclusion is RE-DERIVED from the new measurement. Copying the previous
 *    one forward would leave an account that just measured `ok` red until the
 *    re-read — and, worse, one that just hit its limit green.
 */
import { describe, expect, it } from 'vitest'
import { availabilityLine, availabilityMark, testRowOf, withTestRow } from '../src/client/account-state.ts'
import type {
  WorkBuddyWebPoolAccount,
  WorkBuddyWebPoolTestRow,
  WorkBuddyWebUsage,
} from '../src/status-paths.ts'
import type { Translate } from '../src/client/searched-paths.ts'

/** A key-preserving translator: assertions name the message the code chose. */
const t: Translate = (key, params) => {
  if (params === undefined || params === null) return key
  return [key, ...Object.entries(params).map(([k, v]) => `${k}=${String(v)}`)].join('|')
}

/** A signed-in document carrying a pool block, which is what the panel reads. */
function usageWith(accounts: readonly WorkBuddyWebPoolAccount[]): WorkBuddyWebUsage {
  return {
    status: 'signed-in',
    region: 'cn',
    accountId: accounts[0]?.accountId ?? 'a-1',
    accountName: accounts[0]?.accountName ?? 'A One',
    tokenExpiresAtMs: 0,
    selectionExplicit: true,
    accounts: accounts.map(account => ({
      id: account.accountId,
      accountName: account.accountName,
      domain: 'workbuddy.cn',
      source: 'desktop' as const,
      tokenExpiresAtMs: 0,
      selected: account.current,
    })),
    models: [],
    enabledModelIds: [],
    imageModelIds: [],
    offModelIds: [],
    contextBudgets: {},
    credits: { total: 0, expiringSoon: 0, packages: [] },
    pool: {
      enabled: true,
      checkinSupported: true,
      targetModelSource: 'free',
      targetModelId: 'free-1',
      accounts,
    },
  }
}

function accountOf(accountId: string, overrides: Partial<WorkBuddyWebPoolAccount> = {}): WorkBuddyWebPoolAccount {
  return {
    accountId,
    accountName: `Name ${accountId}`,
    current: false,
    member: true,
    ...overrides,
  }
}

const NOW = 1_760_000_000_000

function testRow(accountId: string, result: WorkBuddyWebPoolTestRow['result']): WorkBuddyWebPoolTestRow {
  return { accountId, accountName: `Name ${accountId}`, result }
}

describe('testRowOf', () => {
  it('reads the row out of one line of the batch stream', () => {
    const row = testRowOf({
      row: {
        accountId: 'a-2',
        accountName: 'A Two',
        result: { modelId: 'free-1', outcome: 'rate-limited', retryAtMs: NOW + 60_000, status: 429 },
      },
    })
    expect(row).toEqual({
      accountId: 'a-2',
      accountName: 'A Two',
      result: { modelId: 'free-1', outcome: 'rate-limited', retryAtMs: NOW + 60_000, status: 429 },
    })
  })

  it('ignores the batch envelope and the closing line', () => {
    // `{ action, modelId }`, `{ done: true }` and `{ reason, error }` all share
    // the stream with the rows; folding one of them would invent a measurement.
    expect(testRowOf({ action: 'test', modelId: 'free-1' })).toBeUndefined()
    expect(testRowOf({ done: true })).toBeUndefined()
    expect(testRowOf({ reason: 'pool-failed', error: 'boom' })).toBeUndefined()
  })

  it('refuses a row that does not name the model it measured', () => {
    // Issue #61: an outcome without its model reads as account-level
    // availability, which is the false positive that started it.
    expect(testRowOf({ row: { accountId: 'a-1', result: { outcome: 'ok' } } })).toBeUndefined()
  })

  it('refuses an outcome this build does not know', () => {
    expect(testRowOf({ row: { accountId: 'a-1', result: { modelId: 'm', outcome: 'vibes' } } })).toBeUndefined()
    expect(testRowOf({ row: { accountId: '', result: { modelId: 'm', outcome: 'ok' } } })).toBeUndefined()
  })
})

describe('withTestRow', () => {
  it('writes the measurement onto the account the row names', () => {
    const usage = usageWith([accountOf('a-1'), accountOf('a-2')])
    const next = withTestRow(usage, testRow('a-2', { modelId: 'free-1', outcome: 'ok' }), NOW)
    if (!('pool' in next) || next.pool === undefined) throw new Error('pool went missing')
    const measured = next.pool.accounts[1]
    expect(measured?.probe).toEqual({
      outcome: 'ok',
      atMs: NOW,
      source: 'test-batch',
      modelId: 'free-1',
    })
    // The other account is untouched: a batch line measures ONE account.
    expect(next.pool.accounts[0]?.probe).toBeUndefined()
  })

  it('clears a stale exclusion when the fresh measurement says usable', () => {
    // The regression: reusing the old `excludedBy` keeps a just-measured-good
    // account red until the re-read, which is exactly the "still shows limited
    // after testing it" report.
    const usage = usageWith([
      accountOf('a-1', { excludedBy: 'rate-limited', probe: { outcome: 'rate-limited', atMs: NOW - 60_000 } }),
    ])
    const next = withTestRow(usage, testRow('a-1', { modelId: 'free-1', outcome: 'ok' }), NOW)
    if (!('pool' in next) || next.pool === undefined) throw new Error('pool went missing')
    expect(next.pool.accounts[0]?.excludedBy).toBeUndefined()
  })

  it('excludes an account the row measured as limited, and says when', () => {
    const usage = usageWith([accountOf('a-1')])
    const next = withTestRow(
      usage,
      testRow('a-1', { modelId: 'free-1', outcome: 'rate-limited', retryAtMs: NOW + 3_600_000 }),
      NOW,
    )
    if (!('pool' in next) || next.pool === undefined) throw new Error('pool went missing')
    expect(next.pool.accounts[0]?.excludedBy).toBe('rate-limited')
    expect(next.pool.accounts[0]?.probe?.retryAtMs).toBe(NOW + 3_600_000)
  })

  it('matches by id, and by name only when exactly one account carries it', () => {
    const usage = usageWith([
      accountOf('a-1', { accountName: 'Shared' }),
      accountOf('a-2', { accountName: 'Shared' }),
    ])
    // The id decides when it is listed, even if the name points elsewhere.
    const byId = withTestRow(usage, { accountId: 'a-2', accountName: 'Shared', result: { modelId: 'm', outcome: 'ok' } }, NOW)
    if (!('pool' in byId) || byId.pool === undefined) throw new Error('pool went missing')
    expect(byId.pool.accounts[1]?.probe?.outcome).toBe('ok')
    expect(byId.pool.accounts[0]?.probe).toBeUndefined()

    // An unknown id whose name two accounts share: writing it onto either would
    // be a guess, and a measurement filed under the wrong account is worse than
    // a row that waits for the re-read.
    const byName = withTestRow(usage, { accountId: 'gone', accountName: 'Shared', result: { modelId: 'm', outcome: 'ok' } }, NOW)
    expect(byName).toBe(usage)
  })

  it('leaves a document alone when it carries no pool at all', () => {
    // An older Host: the panel renders the credits table, and a test batch that
    // this document cannot describe must not invent a pool block.
    const usage = usageWith([accountOf('a-1')])
    const withoutPool: WorkBuddyWebUsage = { ...usage } as WorkBuddyWebUsage
    delete (withoutPool as { pool?: unknown }).pool
    expect(withTestRow(withoutPool, testRow('a-1', { modelId: 'm', outcome: 'ok' }), NOW)).toBe(withoutPool)
  })
})

describe('a successful probe never renders a wait', () => {
  // The report that started this: a free (`x0.00`) model tested as usable, then
  // shown as “✓ 可用 · 11/01 00:00 之后可再用 · 约 8 天后”. The instant was the
  // account's monthly quota reset, picked up from a `Retry-After` header on the
  // 200 — so the record is `ok` WITH a `retryAtMs`, which older builds stored.
  const QUOTA_RESET = NOW + 8 * 24 * 3_600_000

  it('prints the verdict alone on the pool card', () => {
    expect(availabilityLine(t, {
      probe: { outcome: 'ok', retryAtMs: QUOTA_RESET },
    }, NOW)).toBe('row.probeOk')
  })

  it('prints the verdict alone in the composer panel', () => {
    expect(availabilityMark(t, {
      probe: { outcome: 'ok', retryAtMs: QUOTA_RESET },
    }, NOW)).toBe('row.probeOk')
  })

  it('still states the instant on a genuinely limited account', () => {
    // The guard is scoped to `ok`. A limited row must keep its time, or the fix
    // would trade one wrong answer for a worse one: no recovery time at all.
    expect(availabilityLine(t, {
      probe: { outcome: 'rate-limited', retryAtMs: NOW + 60_000 },
    }, NOW)).toContain('row.poolRetryAt')
    expect(availabilityMark(t, {
      probe: { outcome: 'rate-limited', retryAtMs: NOW + 60_000 },
    }, NOW)).toContain('row.recoversMinutes')
  })
})

describe('an elapsed cooldown says so instead of repeating the stale verdict', () => {
  /**
   * THE REPORT: the composer panel showed 「被限流」 with no time on some rows and
   * 「被限流 · 约 17 小时后恢复」 on others, and asked why they disagree.
   *
   * They disagree because they are in different states, not because one is
   * broken. `recoversInText` returns '' once the moment passes (a negative wait
   * cannot be printed), so the elapsed rows fell back to the bare verdict — which
   * then looked IDENTICAL to a verdict measured one second ago. Measured on a
   * real profile, the two such rows were backed by probes taken SEVEN HOURS
   * earlier, so the panel was reporting yesterday's situation as today's.
   *
   * The fix states the one thing that is certainly true: the window the upstream
   * named has passed, and nothing has re-measured since.
   *
   * SECOND REPORT, same state: 「被限流 · 限流时段已过 · 重新测试以确认」 was three
   * fragments contradicting each other inside one line — a present-tense verdict,
   * a note that it is over, and a chore for the reader. The owner's answer was
   * that the plugin should re-test that single account instead (see the card's
   * autoReTest), which leaves the row with exactly this to say while the new
   * measurement is on its way. The verdict must therefore be ABSENT from the
   * mark: printing both is the contradiction, not the fix.
   */
  const RETRY_PAST = NOW - 5 * 3_600_000

  it('names the elapsed cooldown in the composer panel', () => {
    const mark = availabilityMark(t, {
      probe: { outcome: 'rate-limited', retryAtMs: RETRY_PAST },
    }, NOW)
    expect(mark).toContain('row.poolRetryExpired')
    expect(mark, 'an elapsed cooldown must not repeat the verdict it contradicts')
      .not.toContain('row.poolExcludedRateLimited')
  })

  it('says the same in the full sentence the card prints', () => {
    // The two surfaces come from ONE rule. The card's line went on printing
    // 「被限流 · 05:20 之后可再用」 about an instant five hours in the past — a
    // present-tense verdict beside a future-tense date for the same moment.
    const line = availabilityLine(t, {
      probe: { outcome: 'rate-limited', retryAtMs: RETRY_PAST },
    }, NOW)
    expect(line).toContain('row.poolRetryExpired')
    expect(line ?? '', 'the past instant must not be printed as a future one')
      .not.toContain('row.poolRetryAt')
    expect(line ?? '').not.toContain('row.poolExcludedRateLimited')
  })

  it('leaves a non-cooldown verdict alone when its instant has passed', () => {
    // An exhausted quota stores the monthly refresh as `retryAtMs`, and a
    // rejected credential can carry a `Retry-After` — neither is cleared by
    // waiting, and neither is "awaiting a re-check". Replacing those with
    // 「恢复时间已到 · 待复核」 hid the one fact the user has to act on (top up, or
    // sign in again) and, for the quota, promised a re-check that would return the
    // same answer until the month turned over.
    const poor = availabilityLine(t, {
      probe: { outcome: 'out-of-credit', retryAtMs: RETRY_PAST },
    }, NOW)
    expect(poor, 'the reason must survive').toContain('row.poolExcludedOutOfCredit')
    expect(poor ?? '', 'and it must not claim a re-check is pending').not
      .toContain('row.poolRetryExpired')
    expect(poor ?? '', 'a past instant is not news').not.toContain('row.poolRetryAt')
    // The panel agrees, from the same rule.
    const rejected = availabilityMark(t, {
      probe: { outcome: 'credential-rejected', retryAtMs: RETRY_PAST },
    }, NOW)
    expect(rejected).not.toContain('row.poolRetryExpired')
  })

  it('never prints a negative or zero wait', () => {
    const mark = availabilityMark(t, {
      probe: { outcome: 'rate-limited', retryAtMs: RETRY_PAST },
    }, NOW)
    // `recoversInText` returning '0' would be the obvious wrong fix: it reads as
    // "no wait left" while the row still claims the account is limited.
    expect(mark).not.toContain('row.recovers')
  })

  it('keeps the verdict unchanged while the cooldown still runs', () => {
    // The guard must be scoped to the elapsed case only. A row with time left
    // keeps its countdown — replacing that with 「已过」 would be a worse lie.
    const mark = availabilityMark(t, {
      probe: { outcome: 'rate-limited', retryAtMs: NOW + 2 * 3_600_000 },
    }, NOW)
    expect(mark).toContain('row.recoversHours')
    expect(mark).not.toContain('row.poolRetryExpired')
  })
})
