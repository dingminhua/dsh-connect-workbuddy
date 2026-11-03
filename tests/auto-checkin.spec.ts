import { describe, expect, it } from 'vitest'
import {
  AUTO_CHECKIN_BACKOFF_MS,
  AUTO_CHECKIN_TAIL_MS,
  autoCheckinRegions,
  emptyAutoCheckinState,
  foldAttempt,
  isDue,
  localDayKey,
  nextDelayMs,
  pendingTargets,
  summarizeAutoCheckin,
} from '../src/auto-checkin.ts'
import { checkinAllAccounts } from '../src/account-pool-run.ts'
import type { WorkBuddyPoolCheckinRow, WorkBuddyPoolRunnerDeps } from '../src/account-pool-run.ts'

function row(
  accountId: string,
  status: WorkBuddyPoolCheckinRow['status'],
  message?: string,
): WorkBuddyPoolCheckinRow {
  return {
    accountId,
    accountName: accountId,
    status,
    ...message === undefined ? {} : { message },
  }
}

const DAY = '2026-11-02'

describe('localDayKey', () => {
  it('reads the LOCAL calendar day, not the UTC one', () => {
    // The upstream resets its check-in at the user's local midnight — the card's
    // own wording is 「今天」. A UTC key would put the boundary in the wrong place
    // for every user not on UTC, and in this zone it would call 08:00 local a new
    // day: the runner would try to claim a reward it had already claimed.
    const lateEvening = new Date(2026, 10, 2, 23, 30, 0)
    expect(localDayKey(lateEvening.getTime())).toBe(DAY)
    // 00:30 the next morning is a DIFFERENT day, and one minute earlier is not.
    expect(localDayKey(new Date(2026, 10, 3, 0, 30, 0).getTime())).toBe('2026-11-03')
    expect(localDayKey(new Date(2026, 10, 2, 0, 0, 0).getTime())).toBe(DAY)
  })

  it('pads single-digit months and days', () => {
    // A key of `2026-1-5` and `2026-01-05` would be different strings for the same
    // day, and the reset comparison is string equality.
    expect(localDayKey(new Date(2026, 0, 5, 12, 0, 0).getTime())).toBe('2026-01-05')
  })
})

describe('foldAttempt', () => {
  it('records claimed and already, and nothing else', () => {
    const state = foldAttempt(emptyAutoCheckinState(DAY), [
      row('a', 'claimed'),
      row('b', 'already'),
      row('c', 'failed', 'upstream said no'),
      row('d', 'skipped', 'enterprise'),
    ], 1_000)
    // `skipped` is out of scope, not done: counting it would make the card claim
    // a check-in that never happened, and counting it as PENDING would keep the
    // backoff spinning on an account that can never succeed.
    expect([...state.doneAccountIds].sort()).toEqual(['a', 'b'])
    expect(state.lastError).toBe('upstream said no')
  })

  it('accumulates across attempts within one day', () => {
    // A batch can fail halfway. Recomputing the done set from one attempt would
    // make the next tick re-check accounts that already succeeded — one status
    // request per account per tick, for nothing.
    const first = foldAttempt(emptyAutoCheckinState(DAY), [row('a', 'claimed'), row('b', 'failed')], 1_000)
    const second = foldAttempt(first, [row('b', 'claimed')], 2_000)
    expect([...second.doneAccountIds].sort()).toEqual(['a', 'b'])
  })

  it('resets the failure count when an attempt made progress', () => {
    // Progress means the upstream is reachable, so the NEXT failure deserves a
    // fresh short backoff rather than the 30-minute tail.
    const failed = foldAttempt(emptyAutoCheckinState(DAY), [row('a', 'failed', 'x')], 1_000)
    expect(failed.failures).toBe(1)
    const progressed = foldAttempt(failed, [row('a', 'claimed')], 2_000)
    expect(progressed.failures).toBe(0)
  })

  it('does not count a skipped-only attempt as a failure', () => {
    // An enterprise member is `skipped` forever. Counting that as a failure would
    // drive the backoff to its 30-minute tail for a day with nothing to do.
    const state = foldAttempt(emptyAutoCheckinState(DAY), [row('a', 'skipped', 'enterprise')], 1_000)
    expect(state.failures).toBe(0)
    expect(state.lastError).toBeUndefined()
  })
})

describe('nextDelayMs and isDue', () => {
  it('walks the backoff, then settles into the tail', () => {
    const delays = AUTO_CHECKIN_BACKOFF_MS.map((_, index) =>
      nextDelayMs({ day: DAY, doneAccountIds: [], scopeSize: 0, failures: index }, 1))
    expect(delays).toEqual([...AUTO_CHECKIN_BACKOFF_MS])
    // One step past the end is the tail, and it STAYS there: an outage must not be
    // probed every minute for the rest of the day.
    expect(nextDelayMs({ day: DAY, doneAccountIds: [], scopeSize: 0, failures: AUTO_CHECKIN_BACKOFF_MS.length }, 1))
      .toBe(AUTO_CHECKIN_TAIL_MS)
    expect(nextDelayMs({ day: DAY, doneAccountIds: [], scopeSize: 0, failures: 99 }, 1)).toBe(AUTO_CHECKIN_TAIL_MS)
  })

  it('returns undefined when nothing is pending', () => {
    // "Nothing to do" is not "due": arming a retry for an empty set would spin
    // the timer every backoff step to rediscover the same thing.
    expect(nextDelayMs({ day: DAY, doneAccountIds: [], scopeSize: 0, failures: 0 }, 0)).toBeUndefined()
    expect(isDue({ day: DAY, doneAccountIds: [], scopeSize: 0, failures: 0 }, 0, 999_999)).toBe(false)
  })

  it('is due immediately on the first ever attempt', () => {
    expect(isDue(emptyAutoCheckinState(DAY), 1, 1_000)).toBe(true)
  })

  it('waits out the backoff after a failure', () => {
    const state: ReturnType<typeof emptyAutoCheckinState> = {
      day: DAY,
      doneAccountIds: [],
      scopeSize: 1,
      failures: 1,
      lastAttemptAtMs: 10_000,
    }
    expect(isDue(state, 1, 10_000 + AUTO_CHECKIN_BACKOFF_MS[1]! - 1)).toBe(false)
    expect(isDue(state, 1, 10_000 + AUTO_CHECKIN_BACKOFF_MS[1]!)).toBe(true)
  })
})

describe('summarizeAutoCheckin', () => {
  it('excludes enterprise members from the total', () => {
    // The card says "N of M". An enterprise member can never be checked in, so
    // counting it in M would leave a permanent "3 of 4" on a healthy day.
    const state = { day: DAY, doneAccountIds: ['a', 'b'], scopeSize: 3, failures: 0 }
    const summary = summarizeAutoCheckin(state)
    expect(summary).toMatchObject({ done: 2, total: 3, pending: 1 })
  })

  it('never reports more done than in scope', () => {
    // A pool edit can shrink membership while a day's state still remembers an
    // account that was checked in earlier. Clamping keeps the card from printing
    // "5 of 3".
    const state = { day: DAY, doneAccountIds: ['a', 'b', 'c', 'd', 'e'], scopeSize: 3, failures: 0 }
    expect(summarizeAutoCheckin(state)).toMatchObject({ done: 3, total: 3, pending: 0 })
  })

  it('carries the last error through', () => {
    const state = { day: DAY, doneAccountIds: [], scopeSize: 1, failures: 1, lastError: 'boom' }
    expect(summarizeAutoCheckin(state).lastError).toBe('boom')
  })
})

describe('pendingTargets', () => {
  const targets = [
    { accountId: 'a' },
    { accountId: 'b' },
    { accountId: 'c', enterprise: true },
    { accountId: 'd' },
  ]

  it('drops done and enterprise members, keeping pool order', () => {
    const state = { day: DAY, doneAccountIds: ['a'], scopeSize: 3, failures: 0 }
    expect(pendingTargets(targets, state).map(target => target.accountId)).toEqual(['b', 'd'])
  })

  it('returns everything on a fresh day', () => {
    expect(pendingTargets(targets, emptyAutoCheckinState(DAY)).map(target => target.accountId))
      .toEqual(['a', 'b', 'd'])
  })
})

describe('autoCheckinRegions', () => {
  it('is CN only, matching the manual button', () => {
    // The international gateway has no consumer check-in. If this ever widens,
    // the background runner would spend a request per account per day to learn a
    // predictable refusal.
    expect(autoCheckinRegions()).toEqual(['cn'])
  })
})

describe('the idempotency guarantee (the property the old no-auto rule protected)', () => {
  it('an account already checked in today is reported, never claimed', async () => {
    // THE reason this feature is safe to run unattended. `checkinAllAccounts`
    // reads status first and answers `already` WITHOUT calling
    // `claimDailyCheckin`, so a restart, a duplicate timer tick, or an overlap
    // with the manual button cannot double-claim — there is no second code path
    // that could. This test drives the real batch, not a copy of the rule.
    const claims: string[] = []
    const deps: WorkBuddyPoolRunnerDeps = {
      credentialFor: async () => ({ uin: 'a' }) as never,
      fetchCheckinStatus: async () => ({ active: true, todayCheckedIn: true }) as never,
      claimDailyCheckin: async () => {
        claims.push('claimed')
        return { credit: 60, streakDays: 1 } as never
      },
      probe: async () => ({ modelId: 'm', outcome: 'ok' }),
    }
    const rows = await checkinAllAccounts([{ accountId: 'a', accountName: 'A' }], deps)
    expect(rows[0]?.status).toBe('already')
    // The claim was never sent: this is what makes "run it again on every
    // restart" safe rather than merely unlikely to double-claim.
    expect(claims).toEqual([])
  })

  it('folding that result records the account as done, so the next tick skips it', async () => {
    // Together with the test above: the runner must not re-ask an account it has
    // already settled, or every tick would spend one status request per account
    // for the rest of the day.
    const rows = [{ accountId: 'a', accountName: 'A', status: 'already' as const }]
    const state = foldAttempt(emptyAutoCheckinState(DAY), rows, 1_000, 1)
    expect(pendingTargets([{ accountId: 'a' }], state)).toEqual([])
  })
})
