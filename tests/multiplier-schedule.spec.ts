/**
 * The scheduled PRICE refresh: the rules, and the field-level overlay.
 *
 * TWO THINGS ARE PINNED HERE, and they are the two the feature would fail on
 * silently:
 *
 *   1. `withLiveMultipliers` must never change AVAILABILITY. It is the one
 *      writer in this plugin that runs on a timer, and if it ever inherited
 *      `mergeRoster`'s behaviour a background job would start adding and
 *      withdrawing models from the user's picker — the exact thing the design
 *      separates it from a full refresh to prevent.
 *   2. The schedule must not spin. A negative or zero delay from a clock that
 *      jumped backwards would turn a six-hourly read into a busy loop, and a
 *      never-run state must be DUE (the startup refresh the user asked for)
 *      rather than waiting out its first interval.
 *
 * @module dsh-connect-workbuddy/tests/multiplier-schedule
 */

import { describe, expect, it } from 'vitest'
import {
  emptyMultiplierRefreshState,
  isMultiplierRefreshDue,
  multiplierRefreshHoursOf,
  multiplierRefreshIntervalMs,
  nextMultiplierRefreshDelayMs,
  WORKBUDDY_DEFAULT_MULTIPLIER_REFRESH_HOURS,
  WORKBUDDY_MULTIPLIER_REFRESH_HOURS,
} from '../src/multiplier-schedule.ts'
import { catalogFingerprint, withLiveMultipliers } from '../src/catalog-sync.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

const HOUR = 60 * 60_000

function model(
  id: string,
  multiplier?: number,
  promos?: readonly unknown[],
): WorkBuddyModelInfo {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    maxTokens: 8_000,
    ...multiplier === undefined ? {} : { creditMultiplier: multiplier },
    ...promos === undefined ? {} : { promos: promos as unknown as NonNullable<WorkBuddyModelInfo['promos']> },
    reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' },
  }
}

describe('multiplierRefreshHoursOf', () => {
  it('keeps an offered value', () => {
    for (const hours of WORKBUDDY_MULTIPLIER_REFRESH_HOURS) {
      expect(multiplierRefreshHoursOf(hours)).toBe(hours)
    }
  })

  it('falls back to the default for anything not offered', () => {
    // A hand-edited profile, an older build, or a typo. Degrading to a NEAREST
    // step would show the user a number they never chose; the default is the
    // one value whose meaning they can predict.
    for (const bad of [0, 0.5, 2, 8, 48, -6, Number.NaN, '6', undefined, null]) {
      expect(multiplierRefreshHoursOf(bad)).toBe(WORKBUDDY_DEFAULT_MULTIPLIER_REFRESH_HOURS)
    }
  })

  it('converts the default to six hours in milliseconds', () => {
    // The load-bearing number: four reads a day. If this ever silently became
    // minutes, the feature would be a poll.
    expect(multiplierRefreshIntervalMs(undefined)).toBe(6 * HOUR)
    expect(multiplierRefreshIntervalMs(1)).toBe(HOUR)
  })
})

describe('isMultiplierRefreshDue', () => {
  const now = Date.UTC(2026, 10, 28, 12, 0, 0)

  it('is DUE when nothing has run yet', () => {
    // This is what makes the refresh happen at startup instead of after the
    // first full interval.
    expect(isMultiplierRefreshDue(emptyMultiplierRefreshState(), 6, now)).toBe(true)
  })

  it('is not due before the interval has elapsed', () => {
    const state = { lastAttemptAtMs: now - 5 * HOUR, changed: 1, degraded: false }
    expect(isMultiplierRefreshDue(state, 6, now)).toBe(false)
  })

  it('is due once the interval has elapsed', () => {
    const state = { lastAttemptAtMs: now - 6 * HOUR, changed: 1, degraded: false }
    expect(isMultiplierRefreshDue(state, 6, now)).toBe(true)
  })

  it('follows the interval the user chose', () => {
    const state = { lastAttemptAtMs: now - 2 * HOUR, changed: 0, degraded: false }
    expect(isMultiplierRefreshDue(state, 1, now)).toBe(true)
    expect(isMultiplierRefreshDue(state, 24, now)).toBe(false)
  })
})

describe('nextMultiplierRefreshDelayMs', () => {
  const now = Date.UTC(2026, 10, 28, 12, 0, 0)

  it('waits zero when nothing has run yet', () => {
    expect(nextMultiplierRefreshDelayMs(emptyMultiplierRefreshState(), 6, now)).toBe(0)
  })

  it('answers the remaining time', () => {
    const state = { lastAttemptAtMs: now - 2 * HOUR, changed: 0, degraded: false }
    expect(nextMultiplierRefreshDelayMs(state, 6, now)).toBe(4 * HOUR)
  })

  it('caps the delay at one interval when the clock moved backwards', () => {
    // A resume from sleep, a manual time change. An uncapped answer would push
    // the next refresh to `interval + overshoot` away — a clock oddity silencing
    // the feature for longer than its own period, which is worse than running it
    // one interval early.
    const state = { lastAttemptAtMs: now + 5 * HOUR, changed: 0, degraded: false }
    expect(nextMultiplierRefreshDelayMs(state, 6, now)).toBe(6 * HOUR)
  })
})

describe('withLiveMultipliers', () => {
  it('replaces the multiplier with the live one', () => {
    const saved = [model('a', 0.69), model('b', 1)]
    const live = [model('a', 0.79), model('b', 1)]
    const next = withLiveMultipliers(saved, live)
    expect(next[0]?.creditMultiplier).toBe(0.79)
    expect(next[1]?.creditMultiplier).toBe(1)
  })

  it('NEVER adds a model the saved directory does not have', () => {
    // The whole reason this function exists instead of `mergeRoster`: a
    // scheduled job must not change availability.
    const saved = [model('a', 1)]
    const live = [model('a', 1), model('brand-new', 0)]
    expect(withLiveMultipliers(saved, live)).toHaveLength(1)
    expect(withLiveMultipliers(saved, live)[0]?.id).toBe('a')
  })

  it('NEVER withdraws a model the live roster no longer lists', () => {
    // Issue #32's rule, reaching a new writer: the user may still be running a
    // model the upstream withdrew, and a price refresh is not a roster refresh.
    const saved = [model('kept', 0.5), model('withdrawn', 2)]
    const live = [model('kept', 0.5)]
    const next = withLiveMultipliers(saved, live)
    expect(next.map(entry => entry.id)).toEqual(['kept', 'withdrawn'])
    expect(next[1]?.creditMultiplier).toBe(2)
  })

  it('keeps the saved multiplier when the live entry declares none', () => {
    // An upstream answer without a `credits` string says NOTHING about the
    // price. Replacing a known rate with "unknown" would be a regression
    // dressed as a refresh — and would make the pool stop seeing it as free.
    const saved = [model('a', 0)]
    const live = [model('a')]
    const next = withLiveMultipliers(saved, live)
    expect(next[0]?.creditMultiplier).toBe(0)
  })

  it('replaces promotions, including clearing a withdrawn one', () => {
    // A badge is a function of the clock: a saved promotion keeps advertising
    // a window the upstream ended, so "no promotion" is an ANSWER.
    const saved = [model('a', 1, [{ id: 'old' }])]
    const live = [model('a', 1)]
    const next = withLiveMultipliers(saved, live)
    expect(next[0]?.promos).toBeUndefined()
    expect('promos' in (next[0] as object)).toBe(false)
  })

  it('writes a fresh promotion list', () => {
    const saved = [model('a', 1, [{ id: 'old' }])]
    const live = [model('a', 1, [{ id: 'new' }])]
    expect(withLiveMultipliers(saved, live)[0]?.promos).toEqual([{ id: 'new' }])
  })

  it('treats a byte-identical promotion list as NO change', () => {
    // The live roster is rebuilt on every read, so its arrays are new objects
    // even when the upstream published the same bytes. An identity comparison
    // here would rewrite the saved directory on every single tick.
    const saved = [model('a', 1, [{ id: 'same', priority: 1 }])]
    const live = [model('a', 1, [{ id: 'same', priority: 1 }])]
    expect(withLiveMultipliers(saved, live)).toBe(saved)
  })

  it('returns the SAME array when nothing changed', () => {
    // The caller skips both the in-memory write and the settings write by
    // identity, so this is what stops a write storm.
    const saved = [model('a', 0.69), model('b', 1)]
    const live = [model('a', 0.69), model('b', 1)]
    expect(withLiveMultipliers(saved, live)).toBe(saved)
  })

  it('does not disturb fields it does not own', () => {
    const saved = [model('a', 0.69)]
    const live = [{
      ...model('a', 0.79),
      name: 'upstream rename',
      contextWindow: 400_000,
      maxTokens: 16_000,
    }]
    const next = withLiveMultipliers(saved, live)[0]
    expect(next?.name).toBe('a')
    expect(next?.contextWindow).toBe(200_000)
    expect(next?.maxTokens).toBe(8_000)
    expect(next?.reasoning).toEqual({ supportedEfforts: ['low', 'high'], defaultEffort: 'high' })
  })

  it('is visible in the catalog fingerprint, so the write guard fires', () => {
    // The repair write is gated on this fingerprint. If a multiplier drift were
    // invisible to it, the scheduled refresh would compute a change and then
    // decide not to persist it.
    const saved = [model('a', 0.69)]
    const repriced = withLiveMultipliers(saved, [model('a', 0.79)])
    expect(catalogFingerprint(repriced)).not.toBe(catalogFingerprint(saved))
  })
})
