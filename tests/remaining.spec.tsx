/**
 * The relative half of a cooldown: "约 1 小时后" beside the instant it came from.
 *
 * The card has always printed the absolute instant. This pins the reformatting
 * rule, including the rounding a reader actually wants — 69 minutes reads as
 * "约 1 小时", which is exactly how the user described that instant themselves.
 *
 * @module dsh-connect-workbuddy/tests/remaining
 */
import { describe, expect, it } from 'vitest'
import { remainingText } from '../src/client/remaining.ts'
import { t } from './pool-render-helpers.tsx'

const NOW = 1_800_000_000_000

describe('remainingText', () => {
  it('says nothing once the moment has passed', () => {
    // The contract callers depend on: an elapsed cooldown means the account is
    // already back, so "in 0 minutes" would contradict the row it is attached
    // to. The exact instant counts as passed too.
    expect(remainingText(t, NOW, NOW)).toBe('')
    expect(remainingText(t, NOW - 1, NOW)).toBe('')
    expect(remainingText(t, NOW - 86_400_000, NOW)).toBe('')
  })

  it('calls a sub-minute wait imminent rather than rounding it to zero', () => {
    expect(remainingText(t, NOW + 1_000, NOW)).toBe('row.remainingImminent')
    expect(remainingText(t, NOW + 59_999, NOW)).toBe('row.remainingImminent')
  })

  it('counts minutes below the hour', () => {
    expect(remainingText(t, NOW + 60_000, NOW)).toBe('row.remainingMinutes|count=1')
    expect(remainingText(t, NOW + 25 * 60_000, NOW)).toBe('row.remainingMinutes|count=25')
    expect(remainingText(t, NOW + 59 * 60_000, NOW)).toBe('row.remainingMinutes|count=59')
  })

  it('switches to hours at the hour, and rounds the way the reader phrased it', () => {
    // The case that motivated the feature: asked to explain the instant
    // 05:23:27 while it was ~69 minutes away, the user wrote "约 1 小时后" —
    // not "约 69 分钟". So the hour band must start AT the hour, not at 90
    // minutes, or the very case that prompted this renders in the wrong unit.
    expect(remainingText(t, NOW + 60 * 60_000, NOW)).toBe('row.remainingHours|count=1')
    expect(remainingText(t, NOW + 69 * 60_000, NOW)).toBe('row.remainingHours|count=1')
    // The other two real values on this machine at the time: 2h40m and 12h07m.
    expect(remainingText(t, NOW + 160 * 60_000, NOW)).toBe('row.remainingHours|count=3')
    expect(remainingText(t, NOW + 727 * 60_000, NOW)).toBe('row.remainingHours|count=12')
  })

  it('keeps hours up to two days, so 36 hours does not round to "1 day"', () => {
    // A one-day cut would print "约 1 天后" for 36 hours — understating the wait
    // by twelve hours, which is worse than a slightly unusual unit.
    expect(remainingText(t, NOW + 36 * 60 * 60_000, NOW)).toBe('row.remainingHours|count=36')
    expect(remainingText(t, NOW + 47 * 60 * 60_000, NOW)).toBe('row.remainingHours|count=47')
  })

  it('switches to days at two days', () => {
    expect(remainingText(t, NOW + 48 * 60 * 60_000, NOW)).toBe('row.remainingDays|count=2')
    expect(remainingText(t, NOW + 7 * 24 * 60 * 60_000, NOW)).toBe('row.remainingDays|count=7')
  })
})
