import { describe, expect, it } from 'vitest'
import {
  createLatestWins,
  effectiveMembersOf,
  exclusionOf,
  pickAccount,
  pickFreeModel,
  POOL_UNKNOWN_COOLDOWN_MS,
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
  it('keeps zero-credit untested and successful free-model accounts eligible under the shared verdict', () => {
    for (const probe of [undefined, { outcome: 'ok' as const, atMs: NOW }]) {
      const input = member('free-account', { credits: 0, ...probe === undefined ? {} : { probe } })
      const ranked = rankPool([input], NOW)[0]
      expect(ranked?.excludedBy).toBeUndefined()
      expect(ranked?.excludedBy).toBe(exclusionOf(probe, NOW))
    }
    const failed = member('depleted-account', { credits: 0, probe: { outcome: 'out-of-credit', atMs: NOW } })
    expect(rankPool([failed], NOW)[0]?.excludedBy).toBe(exclusionOf(failed.probe, NOW))
  })

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

  it('keeps an out-of-credit account excluded until a balance read confirms replenishment', () => {
    const probe = { outcome: 'out-of-credit' as const, atMs: NOW, retryAtMs: NOW + 3_600_000 }
    expect(exclusionOf(probe, NOW + 3_600_001)).toBe('out-of-credit')
    expect(exclusionOf({ outcome: 'out-of-credit', atMs: NOW }, NOW + 86_400_000)).toBe('out-of-credit')
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

  it('keeps an account in the pool after a content-policy refusal', () => {
    // The refusal was about ONE REQUEST's content, not this account: the same
    // account will serve a different message. Benching it would idle a healthy
    // account over a single tripped filter, and — before this case existed — it
    // fell into the `default` branch and was labelled `unusable` FOREVER,
    // because `unusable` deliberately carries no cooldown.
    expect(exclusionOf({ outcome: 'policy-rejected', atMs: NOW }, NOW)).toBeUndefined()
    // And it stays a candidate even with no elapsed time, i.e. it is not merely
    // waiting out a fallback cooldown.
    expect(exclusionOf({ outcome: 'policy-rejected', atMs: NOW }, NOW + 1)).toBeUndefined()
  })

  it('benches an upstream-restricted account until re-authentication (issue #127)', () => {
    // Unlike a content refusal, 11140 restricted-account is a statement about
    // THIS credential; another account is the remedy and this one must not be
    // billed again before the user acts.
    expect(exclusionOf({ outcome: 'account-restricted', atMs: NOW }, NOW)).toBe('account-restricted')
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
    // Both must carry points genuinely AT RISK (`expiringSoon`), because that is
    // what "expiring" means to the ranking since issue #70. The old key compared
    // the raw `nearestExpiryMs` timestamp and never consulted the amount, so this
    // fixture passed while carrying `expiringSoon: 0` on BOTH accounts — it was
    // asserting a path the old rule reached only by ignoring the amount.
    const ranked = rankPool([
      member('late', { credits: 100, expiringSoon: 100, nearestExpiryMs: NOW + 30 * 86_400_000 }),
      member('soon', { credits: 100, expiringSoon: 100, nearestExpiryMs: NOW + 86_400_000 }),
    ], NOW)
    expect(ranked[0]?.account.id).toBe('soon')
  })

  it('ranks an account with no expiry after one that expires', () => {
    const ranked = rankPool([
      member('never', { credits: 100 }),
      member('expires', { credits: 100, expiringSoon: 100, nearestExpiryMs: NOW + 86_400_000 }),
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

  describe('expiring credits outrank a larger balance (issue #70)', () => {
    /**
     * The live case from the report, reproduced with its real numbers.
     *
     * C held 196.40 points expiring the same day but ~1,200 fewer points than
     * A and B, whose packages expire weeks later. Under the old lexicographic
     * keys (total, then expiry) C ranked LAST every time, so it was never
     * selected and its 196.40 points always lapsed.
     */
    it('ranks the account whose points lapse today above bigger accounts that lapse later', () => {
      const ranked = rankPool([
        member('A', { credits: 2596.88, expiringSoon: 0, nearestExpiryMs: NOW + 31 * 86_400_000 }),
        member('B', { credits: 2594.73, expiringSoon: 0, nearestExpiryMs: NOW + 31 * 86_400_000 }),
        member('C', { credits: 1396.40, expiringSoon: 196.40, nearestExpiryMs: NOW + 13 * 3_600_000 }),
      ], NOW)
      expect(ranked.map(row => row.account.id)).toEqual(['C', 'A', 'B'])
    })

    it('still spends the LARGEST balance when nothing is expiring', () => {
      // The change must not disturb the ordinary case: no expiry ⇒ highest
      // total first, exactly as before.
      const ranked = rankPool([
        member('small', { credits: 10, expiringSoon: 0, nearestExpiryMs: NOW + 86_400_000 }),
        member('large', { credits: 900, expiringSoon: 0, nearestExpiryMs: NOW + 31 * 86_400_000 }),
      ], NOW)
      expect(ranked.map(row => row.account.id)).toEqual(['large', 'small'])
    })

    it('ranks a smaller expiring balance above a much larger one that is not expiring', () => {
      // Deliberate, and the part that reads wrong at first glance: credits are
      // fungible, so saving the big balance costs the 1 point with certainty,
      // whereas spending the small account loses nothing (the big one is still
      // there next request). Guarded so nobody "fixes" it back to a total-first
      // order thinking it is a bug.
      const ranked = rankPool([
        member('rich-no-expiry', { credits: 50_000, expiringSoon: 0, nearestExpiryMs: NOW + 30 * 86_400_000 }),
        member('tiny-expiring', { credits: 1, expiringSoon: 1, nearestExpiryMs: NOW + 86_400_000 }),
      ], NOW)
      expect(ranked.map(row => row.account.id)).toEqual(['tiny-expiring', 'rich-no-expiry'])
    })

    it('ranks the sooner lapsing account first when both have points at risk', () => {
      const ranked = rankPool([
        member('in-two-days', { credits: 2000, expiringSoon: 300, nearestExpiryMs: NOW + 2 * 86_400_000 }),
        member('today', { credits: 1396, expiringSoon: 196, nearestExpiryMs: NOW + 3_600_000 }),
      ], NOW)
      expect(ranked.map(row => row.account.id)).toEqual(['today', 'in-two-days'])
    })

    it('ranks the larger amount at risk first when both lapse at the same moment', () => {
      const same = NOW + 86_400_000
      const ranked = rankPool([
        member('less-at-risk', { credits: 900, expiringSoon: 10, nearestExpiryMs: same }),
        member('more-at-risk', { credits: 500, expiringSoon: 400, nearestExpiryMs: same }),
      ], NOW)
      expect(ranked.map(row => row.account.id)).toEqual(['more-at-risk', 'less-at-risk'])
    })

    it('never promotes an account whose points are expiring but which cannot be billed', () => {
      // Usability still comes first: an account in cooldown cannot spend its
      // lapsing points either, so promoting it would strand every request.
      const ranked = rankPool([
        member('expiring-but-limited', {
          credits: 500,
          expiringSoon: 500,
          nearestExpiryMs: NOW + 3_600_000,
          probe: { outcome: 'rate-limited', atMs: NOW, retryAtMs: NOW + 60_000 },
        }),
        member('ok-no-expiry', { credits: 10, expiringSoon: 0, nearestExpiryMs: NOW + 30 * 86_400_000 }),
      ], NOW)
      expect(ranked[0]?.account.id).toBe('ok-no-expiry')
      expect(ranked[1]?.excludedBy).toBe('rate-limited')
    })
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

  /**
   * Manual priority (`orderAccountIds`), the user's own "who serves next".
   *
   * The order sits BELOW usability and the at-risk flag and ABOVE every
   * credit-derived key. Every test here pins one clause of that sentence,
   * because each clause is a decision someone will otherwise try to "fix":
   * the expiry guard in particular looks like a bug until you read issue #70.
   */
  describe('manual order (orderAccountIds)', () => {
    it('falls back to the credit policy when no order is given', () => {
      // Regression guard for the whole feature: an absent (or empty) order must
      // reproduce the pre-feature ranking exactly. If this ever changes, every
      // profile that never touched the card silently starts rotating accounts
      // in a new sequence.
      const members = [
        member('low', { credits: 10 }),
        member('high', { credits: 1_000 }),
        member('mid', { credits: 500 }),
      ]
      const withNone = rankPool(members, NOW).map(row => row.account.id)
      const withEmpty = rankPool(members, NOW, []).map(row => row.account.id)
      expect(withNone).toEqual(['high', 'mid', 'low'])
      expect(withEmpty).toEqual(withNone)
    })

    it('puts the user\'s order ahead of the credit policy', () => {
      // The headline promise: the account the user dragged to the top is the
      // one selected even though it holds the LEAST credit. Ranking by balance
      // here would mean the manual order never actually wins anything, because
      // totals are almost never exactly equal (see the issue #70 note).
      const ranked = rankPool([
        member('rich', { credits: 50_000 }),
        member('middle', { credits: 500 }),
        member('poor', { credits: 1 }),
      ], NOW, ['poor', 'middle', 'rich'])
      expect(ranked.map(row => row.account.id)).toEqual(['poor', 'middle', 'rich'])
    })

    it('sorts members missing from the order after every ordered one', () => {
      // An order that names a subset (the user checked in a new account after
      // sorting) must not interleave: the unlisted account goes last, where
      // the card also draws it (`sortAccountsByOrder` uses the same rule).
      // Were the two to disagree, the number on the badge would name a
      // position the ranking does not use.
      const ranked = rankPool([
        member('unlisted-rich', { credits: 9_000 }),
        member('second', { credits: 10 }),
        member('first', { credits: 1 }),
      ], NOW, ['first', 'second'])
      expect(ranked.map(row => row.account.id)).toEqual(['first', 'second', 'unlisted-rich'])
    })

    it('never lets the manual order float an excluded account above a usable one', () => {
      // Usability outranks everything, including the user's own order: an
      // account in cooldown cannot serve, so putting it first would only make
      // every request fail over before reaching the account that can answer.
      const ranked = rankPool([
        member('limited-but-first', {
          credits: 5,
          probe: { outcome: 'rate-limited', atMs: NOW, retryAtMs: NOW + 60_000 },
        }),
        member('usable-second', { credits: 1 }),
      ], NOW, ['limited-but-first', 'usable-second'])
      expect(ranked.map(row => row.account.id)).toEqual(['usable-second', 'limited-but-first'])
      expect(ranked[1]?.excludedBy).toBe('rate-limited')
    })

    it('expiring credits still outrank the manual order (issue #70 wins)', () => {
      // DELIBERATE, and the most likely clause to be mistaken for a bug. The
      // user's order is a preference that may be stale or sloppy; credits
      // lapsing are real money about to vanish. A single mis-drag must never
      // cost the points, so `_atRisk` sits ABOVE `_order` in the comparator.
      // If someone reorders those two lines, this test is the one that says why
      // that was wrong — do not "fix" it by adjusting the expectation.
      const ranked = rankPool([
        member('user-first-no-expiry', { credits: 9_000, expiringSoon: 0 }),
        member('user-second-expiring', { credits: 100, expiringSoon: 100, nearestExpiryMs: NOW + 3_600_000 }),
      ], NOW, ['user-first-no-expiry', 'user-second-expiring'])
      expect(ranked.map(row => row.account.id)).toEqual(['user-second-expiring', 'user-first-no-expiry'])
    })

    it('ignores ids in the order that belong to no member', () => {
      // The saved order outlives accounts (a sign-in removed from the desktop
      // app leaves its id behind, exactly like `memberAccountIds`). A ghost id
      // sitting in position 0 must not push every real member down a place, or
      // the card's "第 1 位" would describe an empty slot.
      const ranked = rankPool([
        member('b', { credits: 2 }),
        member('a', { credits: 1 }),
      ], NOW, ['ghost', 'a', 'b'])
      expect(ranked.map(row => row.account.id)).toEqual(['a', 'b'])
    })

    it('uses the FIRST position for a duplicated id, so ranks do not drift', () => {
      // A hand-edited list can repeat an id. Taking the LAST occurrence would
      // let a stray duplicate silently demote the account it names, so the row
      // would jump away from the badge that claims to describe it.
      const ranked = rankPool([
        member('first', { credits: 1 }),
        member('second', { credits: 100 }),
      ], NOW, ['first', 'first', 'second'])
      expect(ranked.map(row => row.account.id)).toEqual(['first', 'second'])
    })

    it('is stable when the order and the credit keys both tie', () => {
      // Two ordered accounts identical on credits, expiry and token age: the
      // user's own order must decide, and the result must not depend on the
      // caller's array order. Without the `_order` key this fell through to the
      // account id, so the manual order was unreachable for exact ties.
      const rows = [
        member('b', { credits: 5, tokenExpiresAtMs: NOW }),
        member('a', { credits: 5, tokenExpiresAtMs: NOW }),
      ]
      const forward = rankPool(rows, NOW, ['b', 'a']).map(row => row.account.id)
      const reversed = rankPool([...rows].reverse(), NOW, ['b', 'a']).map(row => row.account.id)
      expect(forward).toEqual(['b', 'a'])
      expect(reversed).toEqual(forward)
    })
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
    // (The probe wording is now cause-neutral — it claimed "not the model" for a
    // bucket holding gateway 5xx and timeouts too. Only the FOLD is pinned here.)
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

  it('still gives no cooldown to an unreachable upstream (D1b: reversed on purpose)', () => {
    // DELIBERATE REVERSAL of the earlier pin, which read "a year later it is
    // still excluded — recovery comes from the next probe, not the clock".
    //
    // That reasoning stopped holding when the automatic re-test was removed
    // (`8c17fef`): "the next probe" now only happens if the user presses
    // "test", so a member measured `unavailable` was out of the pool FOREVER.
    // With every member so measured, the pool had no candidate at all and
    // failover had nowhere to go — the raw upstream error was then reported
    // as-is, which is exactly the failure this change fixes.
    //
    // Worse, the recorded event said nothing about the ACCOUNT: a transport
    // failure can be a DNS blip, and before the shim stopped reporting aborted
    // requests it was routinely the user closing the panel mid-flight.
    expect(exclusionOf({ outcome: 'unavailable', atMs: NOW }, NOW)).toBe('unavailable')
    expect(exclusionOf(
      { outcome: 'unavailable', atMs: NOW },
      NOW + POOL_UNKNOWN_COOLDOWN_MS - 1,
    )).toBe('unavailable')
    expect(exclusionOf(
      { outcome: 'unavailable', atMs: NOW },
      NOW + POOL_UNKNOWN_COOLDOWN_MS,
    )).toBeUndefined()
  })

  it('gives `failed` the same self-healing cooldown as an unreachable upstream', () => {
    expect(exclusionOf({ outcome: 'failed', atMs: NOW }, NOW)).toBe('failed')
    expect(exclusionOf(
      { outcome: 'failed', atMs: NOW },
      NOW + POOL_UNKNOWN_COOLDOWN_MS,
    )).toBeUndefined()
  })

  it('honours a stated retry time over the fallback, for a transient outcome too', () => {
    // A 5xx body that names a time is a better answer than the 30-minute
    // guess, and `retryDue` must prefer it rather than adding to it.
    const stated = NOW + 60_000
    expect(exclusionOf({ outcome: 'unavailable', atMs: NOW, retryAtMs: stated }, stated - 1))
      .toBe('unavailable')
    expect(exclusionOf({ outcome: 'unavailable', atMs: NOW, retryAtMs: stated }, stated))
      .toBeUndefined()
  })

  it('never heals a rejected credential or a missing model on a timer', () => {
    // Waiting fixes neither: one needs a new sign-in, the other needs the
    // catalog to change. A cooldown here would re-bill a token the upstream has
    // already refused, and would keep offering a model the region does not have.
    const year = 365 * 24 * 60 * 60_000
    expect(exclusionOf({ outcome: 'credential-rejected', atMs: NOW }, NOW + year))
      .toBe('credential-rejected')
    expect(exclusionOf({ outcome: 'not-found', atMs: NOW }, NOW + year)).toBe('not-found')
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
