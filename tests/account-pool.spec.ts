import { describe, expect, it } from 'vitest'
import {
  createLatestWins,
  effectiveMembersOf,
  duePoolRegions,
  exclusionOf,
  pickAccount,
  pickFreeModel,
  POOL_MIN_INTERVAL_MINUTES,
  POOL_UNKNOWN_COOLDOWN_MS,
  poolDueAt,
  rankPool,
  resolveTargetModel,
} from '../src/account-pool.ts'
import type { WorkBuddyPoolMember } from '../src/account-pool.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

const NOW = 1_800_000_000_000

/** A pool member with only the fields a test cares about. */
function member(
  id: string,
  options: {
    credits?: number
    expiringSoon?: number
    nearestExpiryMs?: number
    probe?: WorkBuddyPoolMember['probe']
    tokenExpiresAtMs?: number
  } = {},
): WorkBuddyPoolMember {
  return {
    account: { id, accountName: id },
    ...options.credits === undefined
      ? {}
      : {
          credits: {
            total: options.credits,
            expiringSoon: options.expiringSoon ?? 0,
            ...options.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: options.nearestExpiryMs },
          },
        },
    ...options.probe === undefined ? {} : { probe: options.probe },
    ...options.tokenExpiresAtMs === undefined ? {} : { tokenExpiresAtMs: options.tokenExpiresAtMs },
  }
}

/** A catalog entry. `creditMultiplier` absent means the upstream stated none. */
function model(
  id: string,
  contextWindow: number,
  creditMultiplier?: number,
): WorkBuddyModelInfo {
  return {
    id,
    name: id,
    contextWindow,
    maxTokens: 8_000,
    ...creditMultiplier === undefined ? {} : { creditMultiplier },
  }
}

describe('pickFreeModel', () => {
  it('picks a multiplier of exactly zero', () => {
    const picked = pickFreeModel([model('paid', 100_000, 0.79), model('free', 200_000, 0)])
    expect(picked?.id).toBe('free')
  })

  it('DOES NOT treat an absent multiplier as free', () => {
    // This is the CN static fallback's actual shape: it carries no
    // `creditMultiplier` at all. Reading absence as zero would silently bill
    // real credits for a batch the user expected to be free.
    const picked = pickFreeModel([model('unrated', 1_000_000), model('paid', 100_000, 3.31)])
    expect(picked).toBeUndefined()
  })

  it('prefers the largest context window among free models', () => {
    const picked = pickFreeModel([
      model('small', 192_000, 0),
      model('large', 1_000_000, 0),
      model('medium', 512_000, 0),
    ])
    expect(picked?.id).toBe('large')
  })

  it('returns undefined when the catalog has no free model', () => {
    expect(pickFreeModel([model('a', 100_000, 1.2)])).toBeUndefined()
  })

  it('returns undefined for an empty catalog', () => {
    expect(pickFreeModel([])).toBeUndefined()
  })

  it('treats a zero-multiplier model as free even with a tiny window', () => {
    // Zero is a positive statement ("this is free"), unlike absence, so a small
    // window must not disqualify it.
    expect(pickFreeModel([model('tiny', 8_000, 0)])?.id).toBe('tiny')
  })
})

describe('resolveTargetModel', () => {
  const catalog = [model('free', 1_000_000, 0), model('paid', 1_000_000, 0.79)]

  it('prefers an explicit id over the free default', () => {
    const target = resolveTargetModel(catalog, 'paid')
    expect(target).toEqual({ modelId: 'paid', source: 'preferred' })
  })

  it('falls back to the free model when no id is given', () => {
    expect(resolveTargetModel(catalog, undefined)).toEqual({ modelId: 'free', source: 'free' })
  })

  it('reports "none" rather than a paid fallback when nothing is free', () => {
    const picked = resolveTargetModel([model('paid', 1_000_000, 0.79)], undefined)
    expect(picked).toEqual({ source: 'none' })
    expect(picked.modelId).toBeUndefined()
  })

  it('treats an empty-string id as unspecified', () => {
    expect(resolveTargetModel(catalog, '')).toEqual({ modelId: 'free', source: 'free' })
  })

  it('reports a saved id that LEFT the catalog as stale, not as preferred', () => {
    // The defect this fixes: an id that dropped out of the roster was returned
    // as `preferred`, so the card enabled its test button and the Host ran a
    // batch against a model the region no longer offers.
    const target = resolveTargetModel(catalog, 'model-that-left')
    expect(target.source).toBe('stale')
    expect(target.staleModelId).toBe('model-that-left')
  })

  it('omits modelId for a stale target, so an unguarded caller still fails safe', () => {
    // Every existing guard refuses on a missing id, so omitting it means a
    // caller that forgets to check `source` cannot spend credits either.
    expect(resolveTargetModel(catalog, 'model-that-left').modelId).toBeUndefined()
  })

  it('does NOT silently swap a stale saved id for the free model', () => {
    // Testing something the user did not choose would be its own defect.
    const target = resolveTargetModel(catalog, 'model-that-left')
    expect(target.modelId).not.toBe('free')
    expect(target.source).not.toBe('free')
  })

  it('reports stale, not none, when the catalog has not loaded yet', () => {
    // An empty roster is the CN region's real state before its first refresh.
    // `stale` gives the right advice ("pick another / go automatic") rather
    // than "this region has no free model", which would be a different claim.
    const target = resolveTargetModel([], 'saved-model')
    expect(target.source).toBe('stale')
  })

  it('still resolves a saved id that IS in the catalog', () => {
    expect(resolveTargetModel(catalog, 'paid')).toEqual({ modelId: 'paid', source: 'preferred' })
  })

  it('distinguishes none from stale when no id is saved', () => {
    // `none` and `stale` need opposite advice, so they must not collapse.
    expect(resolveTargetModel([model('paid', 1000, 0.79)], undefined).source).toBe('none')
    expect(resolveTargetModel([], undefined).source).toBe('none')
  })
})

describe('exclusionOf', () => {
  it('treats an untested account as a candidate', () => {
    // A freshly discovered account has never been measured and must not be
    // invisible — that would make a brand-new pool look empty.
    expect(exclusionOf(undefined, NOW)).toBeUndefined()
  })

  it('treats an ok measurement as usable', () => {
    expect(exclusionOf({ outcome: 'ok', atMs: NOW }, NOW)).toBeUndefined()
  })

  it('excludes a rate-limited account before its reset time', () => {
    const probe = { outcome: 'rate-limited' as const, atMs: NOW, retryAtMs: NOW + 60_000 }
    expect(exclusionOf(probe, NOW)).toBe('rate-limited')
  })

  it('RETURNS a rate-limited account to the pool after its reset time', () => {
    // `rate-limited` means "works, but not right now" — the single most useful
    // state for this feature. Permanently dropping it would discard an account
    // that is about to become the best candidate.
    const probe = { outcome: 'rate-limited' as const, atMs: NOW, retryAtMs: NOW + 60_000 }
    expect(exclusionOf(probe, NOW + 60_001)).toBeUndefined()
  })

  it('excludes an out-of-credit account before its quota refresh', () => {
    const probe = { outcome: 'out-of-credit' as const, atMs: NOW, retryAtMs: NOW + 3_600_000 }
    expect(exclusionOf(probe, NOW)).toBe('out-of-credit')
  })

  it('returns an out-of-credit account once the quota refreshes', () => {
    const probe = { outcome: 'out-of-credit' as const, atMs: NOW, retryAtMs: NOW + 3_600_000 }
    expect(exclusionOf(probe, NOW + 3_600_001)).toBeUndefined()
  })

  it('excludes a rejected credential regardless of any cooldown', () => {
    // Waiting cannot fix a rejected token, so a cooldown must not make it look
    // like a candidate again.
    expect(exclusionOf({ outcome: 'credential-rejected', atMs: NOW }, NOW)).toBe('credential-rejected')
    expect(exclusionOf(
      { outcome: 'credential-rejected', atMs: NOW, retryAtMs: NOW - 1 },
      NOW,
    )).toBe('credential-rejected')
  })

  it('excludes a limited account for a bounded time when the upstream named none', () => {
    const probe = { outcome: 'rate-limited' as const, atMs: NOW }
    expect(exclusionOf(probe, NOW)).toBe('rate-limited')
    // Bounded, not permanent: it comes back after the fallback cooldown.
    expect(exclusionOf(probe, NOW + POOL_UNKNOWN_COOLDOWN_MS)).toBeUndefined()
  })

  it('treats an unrecognised outcome as unusable rather than as a candidate', () => {
    const probe = { outcome: 'something-new' as never, atMs: NOW }
    expect(exclusionOf(probe, NOW)).toBe('unusable')
  })
})

describe('rankPool', () => {
  it('ranks by credits, highest first', () => {
    const ranked = rankPool([
      member('low', { credits: 10 }),
      member('high', { credits: 1_000 }),
      member('mid', { credits: 500 }),
    ], NOW)
    expect(ranked.map(row => row.account.id)).toEqual(['high', 'mid', 'low'])
  })

  it('puts usable accounts ahead of every excluded one', () => {
    const ranked = rankPool([
      member('rich-but-limited', {
        credits: 9_999,
        probe: { outcome: 'rate-limited', atMs: NOW, retryAtMs: NOW + 60_000 },
      }),
      member('modest-but-ok', { credits: 1, probe: { outcome: 'ok', atMs: NOW } }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('modest-but-ok')
    expect(ranked[0]?.excludedBy).toBeUndefined()
    expect(ranked[1]?.excludedBy).toBe('rate-limited')
  })

  it('prefers the account whose credits expire soonest when totals tie', () => {
    const ranked = rankPool([
      member('late', { credits: 100, nearestExpiryMs: NOW + 30 * 86_400_000 }),
      member('soon', { credits: 100, nearestExpiryMs: NOW + 86_400_000 }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('soon')
  })

  it('ranks an account with no expiry after one that expires', () => {
    const ranked = rankPool([
      member('never', { credits: 100 }),
      member('expires', { credits: 100, nearestExpiryMs: NOW + 86_400_000 }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('expires')
  })

  it('breaks a full tie by the fresher credential', () => {
    const ranked = rankPool([
      member('stale', { credits: 100, tokenExpiresAtMs: NOW }),
      member('fresh', { credits: 100, tokenExpiresAtMs: NOW + 86_400_000 }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('fresh')
  })

  it('ranks unreadable credits as zero, never first', () => {
    // A failing credits route must not capture all the traffic by looking
    // "unknown, therefore interesting".
    const ranked = rankPool([
      member('unknown'),
      member('known-full', { credits: 1 }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('known-full')
  })

  it('still returns excluded accounts so the card can explain each one', () => {
    const ranked = rankPool([
      member('bad', { probe: { outcome: 'credential-rejected', atMs: NOW } }),
    ], NOW)
    expect(ranked).toHaveLength(1)
    expect(ranked[0]?.excludedBy).toBe('credential-rejected')
  })

  it('is order-independent, breaking a full tie by account id', () => {
    // Every ranking key equal: without a final id key the winner would depend
    // on the caller's array order, so the pool could rotate differently
    // between two runs over identical data.
    const rows = [
      member('a', { credits: 5, tokenExpiresAtMs: NOW }),
      member('b', { credits: 5, tokenExpiresAtMs: NOW }),
    ]
    const forward = rankPool(rows, NOW).map(row => row.account.id)
    const reversed = rankPool([...rows].reverse(), NOW).map(row => row.account.id)
    expect(forward).toEqual(reversed)
    expect(forward).toEqual(['a', 'b'])
  })

  it('handles an empty pool', () => {
    expect(rankPool([], NOW)).toEqual([])
  })
})

describe('pickAccount', () => {
  it('picks the highest-credit usable account', () => {
    const picked = pickAccount([
      member('a', { credits: 100, probe: { outcome: 'ok', atMs: NOW } }),
      member('b', { credits: 900, probe: { outcome: 'ok', atMs: NOW } }),
    ], NOW)
    expect(picked?.id).toBe('b')
  })

  it('skips an account whose limit has not reset', () => {
    const picked = pickAccount([
      member('limited', {
        credits: 900,
        probe: { outcome: 'rate-limited', atMs: NOW, retryAtMs: NOW + 60_000 },
      }),
      member('ok', { credits: 10, probe: { outcome: 'ok', atMs: NOW } }),
    ], NOW)
    expect(picked?.id).toBe('ok')
  })

  it('returns undefined when every account is excluded', () => {
    const picked = pickAccount([
      member('a', { probe: { outcome: 'out-of-credit', atMs: NOW, retryAtMs: NOW + 60_000 } }),
      member('b', { probe: { outcome: 'credential-rejected', atMs: NOW } }),
    ], NOW)
    expect(picked).toBeUndefined()
  })

  it('returns undefined for an empty pool', () => {
    expect(pickAccount([], NOW)).toBeUndefined()
  })

  it('picks an untested account rather than nothing', () => {
    expect(pickAccount([member('fresh', { credits: 5 })], NOW)?.id).toBe('fresh')
  })
})

describe('poolDueAt', () => {
  const NOW = 1_800_000_000_000

  it('is never due before the region has been armed', () => {
    // Firing on first sight would bill the user at every startup.
    expect(poolDueAt({ lastRunMs: undefined, intervalMinutes: 30, nowMs: NOW })).toBe(false)
  })

  it('is due exactly at the interval, not before', () => {
    expect(poolDueAt({ lastRunMs: NOW, intervalMinutes: 30, nowMs: NOW + 30 * 60_000 - 1 })).toBe(false)
    expect(poolDueAt({ lastRunMs: NOW, intervalMinutes: 30, nowMs: NOW + 30 * 60_000 })).toBe(true)
  })

  it('clamps an interval below the schema floor', () => {
    // A hand-edited config must not turn the timer into a spend loop.
    expect(poolDueAt({ lastRunMs: NOW, intervalMinutes: 0, nowMs: NOW + 60_000 })).toBe(false)
    expect(poolDueAt({ lastRunMs: NOW, intervalMinutes: -99, nowMs: NOW + 60_000 })).toBe(false)
    expect(poolDueAt({
      lastRunMs: NOW,
      intervalMinutes: POOL_MIN_INTERVAL_MINUTES,
      nowMs: NOW + POOL_MIN_INTERVAL_MINUTES * 60_000,
    })).toBe(true)
  })

  it('rounds a fractional interval rather than ignoring it', () => {
    expect(poolDueAt({ lastRunMs: NOW, intervalMinutes: 30.4, nowMs: NOW + 30 * 60_000 })).toBe(true)
  })
})

describe('duePoolRegions', () => {
  const NOW = 1_800_000_000_000

  it('ARMS a region on first sight instead of running it', () => {
    // This is the defect that made the whole scheduler dead: `poolDueAt` says
    // "not due" for an unarmed region, so a scheduler that only stamped the
    // clock when it decided to run would never stamp it and never fire.
    const result = duePoolRegions({
      state: {},
      regions: ['cn'],
      enabledOf: () => true,
      intervalMinutesOf: () => 30,
      nowMs: NOW,
    })
    expect(result.due).toEqual([])
    expect(result.next.cn).toBe(NOW)
  })

  it('runs a region once its armed interval has passed', () => {
    const result = duePoolRegions({
      state: { cn: NOW },
      regions: ['cn'],
      enabledOf: () => true,
      intervalMinutesOf: () => 30,
      nowMs: NOW + 30 * 60_000,
    })
    expect(result.due).toEqual(['cn'])
    expect(result.next.cn).toBe(NOW + 30 * 60_000)
  })

  it('keeps the previous stamp while a region is not yet due', () => {
    const result = duePoolRegions({
      state: { cn: NOW },
      regions: ['cn'],
      enabledOf: () => true,
      intervalMinutesOf: () => 30,
      nowMs: NOW + 60_000,
    })
    expect(result.due).toEqual([])
    expect(result.next.cn).toBe(NOW)
  })

  it('drops the clock of a DISABLED region, so re-enabling waits a full interval', () => {
    // Inheriting a stale stamp would fire the moment the pool was switched back
    // on, spending credits on a decision the user had just reversed.
    const result = duePoolRegions({
      state: { cn: NOW },
      regions: ['cn'],
      enabledOf: () => false,
      intervalMinutesOf: () => 30,
      nowMs: NOW + 365 * 24 * 60 * 60_000,
    })
    expect(result.due).toEqual([])
    expect(result.next.cn).toBeUndefined()
  })

  it('schedules the two regions independently', () => {
    const result = duePoolRegions<'cn' | 'global'>({
      state: { cn: NOW, global: NOW },
      regions: ['cn', 'global'],
      enabledOf: () => true,
      intervalMinutesOf: region => region === 'cn' ? 30 : 60,
      nowMs: NOW + 30 * 60_000,
    })
    // cn is due at 30 minutes, global is not until 60.
    expect(result.due).toEqual(['cn'])
    expect(result.next.global).toBe(NOW)
  })

  it('leaves an unmentioned region out of the clock entirely', () => {
    const result = duePoolRegions<'cn' | 'global'>({
      state: { global: NOW },
      regions: ['cn'],
      enabledOf: () => true,
      intervalMinutesOf: () => 30,
      nowMs: NOW,
    })
    expect(result.next.global).toBeUndefined()
  })

  it('handles no regions at all', () => {
    const result = duePoolRegions({
      state: {},
      regions: [],
      enabledOf: () => true,
      intervalMinutesOf: () => 30,
      nowMs: NOW,
    })
    expect(result).toEqual({ due: [], next: {} })
  })
})

describe('createLatestWins (H-3 race guard)', () => {
  it('reports the FIRST caller fresh and invalidates it once a newer call begins', () => {
    // The defect: `applyRotation` awaits per-member credits, so a slow call that
    // read "rotation is ON" could resume AFTER a newer call cleared the override
    // for "rotation is OFF" and write the stale account back — the card showing
    // the pool off while a rotated account was still billed.
    const guard = createLatestWins<'cn' | 'global'>()
    const first = guard.begin('cn')
    expect(first()).toBe(false)
    // A newer call claims the generation...
    const second = guard.begin('cn')
    // ...so the older one must now report stale and bail before writing.
    expect(first()).toBe(true)
    expect(second()).toBe(false)
  })

  it('keeps regions independent, so one region cannot stale another', () => {
    // The two pools are separate stacks; a global or per-key bug would let a
    // global re-rank cancel a CN one.
    const guard = createLatestWins<'cn' | 'global'>()
    const cn = guard.begin('cn')
    const global = guard.begin('global')
    expect(cn()).toBe(false)
    expect(global()).toBe(false)
    // A NEWER cn call invalidates only the older cn probe.
    const cn2 = guard.begin('cn')
    expect(cn()).toBe(true)
    expect(global()).toBe(false)
    expect(cn2()).toBe(false)
  })

  it('stays fresh when nothing newer begins', () => {
    const guard = createLatestWins<'cn'>()
    const probe = guard.begin('cn')
    for (let i = 0; i < 5; i += 1) expect(probe()).toBe(false)
  })

  it('invalidates EVERY earlier call, not just the immediately previous one', () => {
    // Three overlapping calls must leave only the last one able to write.
    const guard = createLatestWins<'cn'>()
    const first = guard.begin('cn')
    const second = guard.begin('cn')
    const third = guard.begin('cn')
    expect(first()).toBe(true)
    expect(second()).toBe(true)
    expect(third()).toBe(false)
  })

  it('hands out independent probes per call', () => {
    // A single shared probe would make a caller's own re-check mutate shared
    // state; each begin() must return its own closure.
    const guard = createLatestWins<'cn'>()
    const a = guard.begin('cn')
    const b = guard.begin('cn')
    expect(a).not.toBe(b)
    expect(a()).toBe(true)
    expect(b()).toBe(false)
  })
})

describe('exclusionOf keeps each unusable outcome distinct (D1)', () => {
  it('no longer folds a network outage into "your sign-in was rejected"', () => {
    // The defect: credential-rejected|not-found|failed|unavailable all became
    // 'credential-rejected', so ONE row simultaneously rendered "被拒绝" (name
    // column) and "连不上上游——这是网络问题，不是模型问题" (probe column), and a
    // user whose upstream merely blipped was told to sign in again.
    expect(exclusionOf({ outcome: 'unavailable', atMs: NOW }, NOW)).toBe('unavailable')
    expect(exclusionOf({ outcome: 'not-found', atMs: NOW }, NOW)).toBe('not-found')
    expect(exclusionOf({ outcome: 'failed', atMs: NOW }, NOW)).toBe('failed')
    expect(exclusionOf({ outcome: 'credential-rejected', atMs: NOW }, NOW)).toBe('credential-rejected')
  })

  it('keeps the name column and the probe column telling one story', () => {
    // Both columns read the SAME measurement, so the exclusion value must be
    // the probe outcome verbatim for every unusable non-limit outcome. This is
    // the invariant the fold broke.
    for (const outcome of ['unavailable', 'not-found', 'failed', 'credential-rejected'] as const) {
      expect(exclusionOf({ outcome, atMs: NOW }, NOW)).toBe(outcome)
    }
  })

  it('still excludes every unusable outcome, so none becomes billable', () => {
    // Distinctness must not be bought by letting a broken account back in.
    for (const outcome of ['unavailable', 'not-found', 'failed', 'credential-rejected'] as const) {
      expect(exclusionOf({ outcome, atMs: NOW }, NOW)).toBeDefined()
    }
  })

  it('still gives no cooldown to an unreachable upstream', () => {
    // A year later it is still excluded — recovery comes from the next probe,
    // not the clock. Pinned so a future "add a cooldown here" change is a
    // deliberate decision rather than an accident.
    const year = 365 * 24 * 60 * 60_000
    expect(exclusionOf({ outcome: 'unavailable', atMs: NOW }, NOW + year)).toBe('unavailable')
  })
})

describe('effectiveMembersOf (D6: the ONE definition of effective members)', () => {
  /**
   * The predicate used to exist five times — the status document, the batch
   * route's guard, the Host dependency the card reads, `poolMemberAccounts` and
   * the browser helper. Five copies of one rule is this project's most
   * productive bug shape, so the rule is now one function and these tests pin
   * the behaviour every site relies on.
   */
  it('keeps only the ids that resolve to a listed account', () => {
    const listed = new Set(['a', 'b', 'c'])
    expect(effectiveMembersOf(['a', 'x', 'c'], listed)).toEqual(['a', 'c'])
  })

  it('preserves the caller\'s order, so store order and saved order both survive', () => {
    const listed = new Set(['a', 'b', 'c'])
    // The saved list is the user's own order; the store list is the roster's.
    expect(effectiveMembersOf(['c', 'a', 'b'], listed)).toEqual(['c', 'a', 'b'])
    expect(effectiveMembersOf(['a', 'b', 'c'], listed)).toEqual(['a', 'b', 'c'])
  })

  it('preserves order ACROSS a filter, not just in an already-listed set (N12/M23)', () => {
    // The two assertions above never actually drop an id — they reshuffle a
    // FULLY listed set — so an implementation that SORTS its output passes
    // them: with nothing filtered out, ascending order and caller order agree.
    // The order rule only becomes observable once the filter drops something,
    // because then the survivors must keep the CALLER's relative order instead
    // of collapsing to ascending id order.
    //
    // This is not tidiness. The batch contacts accounts in the returned order,
    // and the saved list is the user's own arrangement, so a silent sort
    // changes which account is checked first and how the status document lists
    // them. Both call sites rely on exactly "filter, preserving order".
    // 'b' is deliberately ABSENT from the listed set, so it is filtered out and
    // 'd', 'a', 'c' must survive in THAT order.
    const listedWithoutB = new Set(['a', 'c', 'd'])
    expect(effectiveMembersOf(['d', 'b', 'a', 'c'], listedWithoutB)).toEqual(['d', 'a', 'c'])
    // Descending input must stay descending — a sort would flip it.
    const listed = new Set(['a', 'b', 'c', 'd'])
    expect(effectiveMembersOf(['c', 'b', 'a'], listed)).toEqual(['c', 'b', 'a'])
    // A duplicated id keeps both occurrences, in place.
    expect(effectiveMembersOf(['c', 'c', 'a'], listed)).toEqual(['c', 'c', 'a'])
  })

  it('is empty when nothing is checked, or when nothing checked still has a sign-in', () => {
    // The two causes the route must report SEPARATELY (no-members vs
    // no-live-members): both give [] here, which is why the caller has to keep
    // the saved list around to tell them apart.
    expect(effectiveMembersOf([], new Set(['a']))).toEqual([])
    expect(effectiveMembersOf(['x', 'y'], new Set(['a']))).toEqual([])
  })

  it('never mutates its inputs', () => {
    const saved = ['a', 'x']
    const listed = new Set(['a'])
    effectiveMembersOf(saved, listed)
    expect(saved).toEqual(['a', 'x'])
    expect([...listed]).toEqual(['a'])
  })

  it('does not deduplicate, so a doubled saved id stays doubled', () => {
    // The caller owns the list's integrity; silently collapsing duplicates here
    // would hide a corrupt saved value from the card that renders it.
    expect(effectiveMembersOf(['a', 'a'], new Set(['a']))).toEqual(['a', 'a'])
  })
})
