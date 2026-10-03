/**
 * How old a measurement is, and who wrote it.
 *
 * Why this pair is pinned rather than left to the table: two sites write the
 * same account's record (the user's "test" batch, and any live request that
 * fails), and they overwrite each other. Without these two facts on screen, a
 * user who watched an account measure `ok` and later found it limited could
 * only read that as "the pool went back to an older value" — which is a
 * reasonable bug report and was exactly the one filed. These tests keep the
 * explanation on the screen.
 *
 * @module dsh-connect-workbuddy/tests/probe-age
 */
import { describe, expect, it } from 'vitest'
import { probeAgeText, probeSourceText } from '../src/client/probe-age.ts'
import { t } from './pool-render-helpers.tsx'

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE

describe('probeAgeText', () => {
  it('calls a fresh measurement "just now" instead of "0 minutes ago"', () => {
    expect(probeAgeText(t, NOW, NOW)).toBe('row.poolProbeJustNow')
    expect(probeAgeText(t, NOW - 59_999, NOW)).toBe('row.poolProbeJustNow')
  })

  it('rounds coarsely, so the figure reads as staleness rather than telemetry', () => {
    // The counts are asserted, not just the unit: the point of each branch is
    // that the reader gets a usable magnitude.
    expect(probeAgeText(t, NOW - MINUTE, NOW)).toBe('row.poolProbeMinutesAgo|count=1')
    expect(probeAgeText(t, NOW - 25 * MINUTE, NOW)).toBe('row.poolProbeMinutesAgo|count=25')
    expect(probeAgeText(t, NOW - 90 * MINUTE, NOW)).toBe('row.poolProbeHoursAgo|count=2')
    expect(probeAgeText(t, NOW - 5 * HOUR, NOW)).toBe('row.poolProbeHoursAgo|count=5')
    // 3 days is past the 2-day cut, so it reads in days rather than "72 h ago".
    expect(probeAgeText(t, NOW - 3 * 24 * HOUR, NOW)).toBe('row.poolProbeDaysAgo|count=3')
  })

  it('never prints a negative age when the clock moved backwards', () => {
    // A stored `atMs` can be ahead of `now` if the machine's clock was corrected
    // after the measurement was written. "-3 分钟前" would be nonsense on screen;
    // the record is real, so its age floors at "just now".
    expect(probeAgeText(t, NOW + 5 * MINUTE, NOW)).toBe('row.poolProbeJustNow')
  })
})

describe('probeSourceText', () => {
  it('names the two writers that can overwrite each other', () => {
    expect(probeSourceText(t, 'test-batch')).toBe('row.poolProbeSourceTest')
    expect(probeSourceText(t, 'live-request')).toBe('row.poolProbeSourceLive')
  })

  it('returns nothing for an absent source, so the caller decides the wording', () => {
    // A record written before the field existed carries no evidence either way.
    // The card renders its own "source unknown" line; this helper must not
    // invent a label for a row it knows nothing about.
    expect(probeSourceText(t, undefined)).toBeUndefined()
  })
})
