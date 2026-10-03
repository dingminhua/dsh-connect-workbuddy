/**
 * HOW OLD a measurement is, and WHAT WROTE IT — the two facts that turn
 * "the pool table shows something I did not expect" into an answerable
 * question.
 *
 * Why this exists: two sites write measurements for the same account — the
 * user's own "test" batch, and any live chat request that fails. They overwrite
 * each other, so a user can watch an account measure `ok` and later find it
 * `rate-limited` with nothing in the UI explaining the change. The record kept
 * no history, so the honest reading of that screen was "the pool went back to
 * an older value", which is a plausible bug report and was exactly the one
 * raised. With the age and the writer shown side by side, the same screen says
 * "measured ok 12 minutes ago by a test, then a live request hit the limit
 * just now" — the pool working as designed, visible instead of inferred.
 *
 * @module dsh-connect-workbuddy/client/probe-age
 */

import type { Translate } from './searched-paths.ts'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * How long ago a measurement was taken, coarsely: "刚刚", "N 分钟前",
 * "N 小时前", "N 天前".
 *
 * Coarse on purpose, for the same reason `remainingText` rounds: a figure that
 * changes every second reads as live telemetry rather than as "how stale is
 * this", which is the only question being asked here.
 *
 * A clock skew that puts the measurement in the FUTURE (a stored `atMs` ahead
 * of `nowMs`, from a machine whose clock moved backwards) is reported as
 * "刚刚" rather than as a negative age: the record is real, and the card must
 * not print "-3 分钟前".
 */
export function probeAgeText(t: Translate, atMs: number, nowMs: number): string {
  const age = nowMs - atMs
  if (age < MINUTE_MS) return t('row.poolProbeJustNow')
  if (age < HOUR_MS) return t('row.poolProbeMinutesAgo', { count: Math.round(age / MINUTE_MS) })
  if (age < 2 * DAY_MS) return t('row.poolProbeHoursAgo', { count: Math.round(age / HOUR_MS) })
  return t('row.poolProbeDaysAgo', { count: Math.round(age / DAY_MS) })
}

/**
 * Who wrote the measurement, or `undefined` when the record predates the field.
 *
 * `undefined` is a real answer and the caller renders it as "来源未知" rather
 * than picking the likelier of the two: a record written before the field
 * existed carries no evidence either way, and guessing would put a confident
 * wrong label on the one row the user is asking about.
 */
export function probeSourceText(t: Translate, source: 'test-batch' | 'live-request' | undefined): string | undefined {
  if (source === undefined) return undefined
  return source === 'test-batch' ? t('row.poolProbeSourceTest') : t('row.poolProbeSourceLive')
}
