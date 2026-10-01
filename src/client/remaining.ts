/**
 * How long until a stated recovery time, in the reader's own words.
 *
 * The card has always shown the ABSOLUTE instant the upstream named
 * (`05:23:27`). That answers "when", but it forces the reader to subtract it from
 * the clock in their head — the one mental step that makes a cooldown hard to act
 * on. "约 1 小时后" is the answer to "how long do I wait", and it is derived from
 * the SAME instant, so the two can never disagree.
 *
 * Only ever applied to a time the UPSTREAM stated. Inventing a countdown for an
 * outcome that named none is still forbidden (`cooldownOf` returning `{}` is
 * still rendered as "the upstream gave no time"); this module adds no new source
 * of truth, it only reformats one that already exists.
 *
 * @module dsh-connect-workbuddy/client/remaining
 */

import type { Translate } from './searched-paths.ts'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * How far out hours stop being the useful unit.
 *
 * Below this, hours; at or above it, days. The cut is at TWO days rather than
 * one so that 30 hours reads as "约 30 小时后" instead of rounding to "约 1 天后",
 * which would understate it by six hours.
 */
const DAYS_AT_MS = 2 * DAY_MS

/**
 * A short "约 N 分钟后 / 约 N 小时后 / 约 N 天后", or `''` once the moment passed.
 *
 * The empty string is the contract callers depend on: an elapsed cooldown means
 * the account is already back, so appending "in 0 minutes" would assert the
 * opposite of the state the card is showing. Callers append this only when it is
 * non-empty.
 *
 * Rounding is deliberately coarse — "约 1 小时后" for 69 minutes is what a reader
 * wants, and a precision that changes every minute would be noise rather than
 * information. The absolute instant sits right beside it for anyone who needs it.
 */
export function remainingText(t: Translate, untilMs: number, nowMs: number): string {
  const left = untilMs - nowMs
  if (left <= 0) return ''
  if (left < MINUTE_MS) return t('row.remainingImminent')
  if (left < HOUR_MS) return t('row.remainingMinutes', { count: Math.round(left / MINUTE_MS) })
  if (left < DAYS_AT_MS) return t('row.remainingHours', { count: Math.round(left / HOUR_MS) })
  return t('row.remainingDays', { count: Math.round(left / DAY_MS) })
}
