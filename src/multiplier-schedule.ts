/**
 * When the background PRICE refresh is due, and what it remembers.
 *
 * THE RULES HALF of the scheduled multiplier refresh. Like `src/auto-checkin.ts`
 * this module holds no timer and reads no clock: every decision — "is it time?",
 * "how long until it is?", "what did the last attempt do?" — is an exported
 * function over plain data, so the rules can be tested without a Host, a
 * network, or fake time. `src/index.ts` owns the timer and the memory.
 *
 * WHY A SCHEDULE AT ALL, WHEN STARTUP ALREADY REFRESHES THE CATALOG. The startup
 * read is a FULL directory refresh and it lands on every boot; this exists for
 * the harness that stays up for days, where the upstream can reprice a model
 * without anything on this machine noticing. A stale multiplier is not a stale
 * label: the account pool picks its test target with `creditMultiplier === 0`
 * (`src/account-pool.ts`), so a model that stopped being free is still treated
 * as free and gets probed with real credits.
 *
 * WHY A CLOSED SET OF INTERVALS. Same reason as `WORKBUDDY_POLL_INTERVALS_MS`
 * (`src/status-paths.ts`): this value decides upstream request volume, and a
 * hand-edited `0` or a typo'd `0.5` would turn a background convenience into a
 * poll. The offered set IS the validation, and the card's dropdown offers
 * exactly these, so the control cannot produce a value the Host refuses.
 *
 * @module dsh-connect-workbuddy/multiplier-schedule
 */

/**
 * The intervals the card offers, in HOURS.
 *
 * Hours rather than milliseconds because that is the unit the user thinks in
 * for a once-in-a-while background job, and because hours keep the stored
 * number small enough to read in a profile file.
 */
export const WORKBUDDY_MULTIPLIER_REFRESH_HOURS: readonly number[] = [1, 3, 6, 12, 24]

/**
 * The default interval: six hours.
 *
 * Four reads a day. The upstream's own promotions run on wall-clock windows
 * (a night discount opens and closes inside one day), so a 24-hour cadence
 * would systematically misreport the price for hours at a time; six hours keeps
 * the drift inside one window boundary without turning the feature into a poll.
 */
export const WORKBUDDY_DEFAULT_MULTIPLIER_REFRESH_HOURS = 6

/**
 * Coerce a stored hour count onto the offered set.
 *
 * An unrecognized value (an older profile, a hand edit) degrades to the DEFAULT
 * rather than to the nearest offered step: silently rewriting someone's `8` into
 * `6` would make the card show a number they never chose, and the default is the
 * one value whose meaning they can predict.
 */
export function multiplierRefreshHoursOf(value: unknown): number {
  return typeof value === 'number' && WORKBUDDY_MULTIPLIER_REFRESH_HOURS.includes(value)
    ? value
    : WORKBUDDY_DEFAULT_MULTIPLIER_REFRESH_HOURS
}

/** The interval in milliseconds, coerced first. */
export function multiplierRefreshIntervalMs(value: unknown): number {
  return multiplierRefreshHoursOf(value) * 60 * 60_000
}

/**
 * What one region's runner remembers between ticks.
 *
 * IN MEMORY ONLY, and that is deliberate. The state answers "when did this
 * process last refresh", so persisting it would let a restart skip the refresh
 * that the NEW process never performed — and a restart is precisely when the
 * user expects the prices to be re-read. Nothing here is worth a file.
 */
export interface MultiplierRefreshState {
  /** When the last attempt FINISHED, in epoch ms. Absent means never. */
  lastAttemptAtMs?: number
  /** How many saved rows this attempt actually changed. */
  changed: number
  /**
   * Whether the upstream read that produced this attempt was PARTIAL.
   *
   * A degraded read answered from one product document, so the rows the refused
   * document published were not repriced — which makes the answer "partly
   * refreshed", not "refreshed". Recorded rather than hidden: the card says so,
   * and the next tick retries on the normal schedule.
   */
  degraded: boolean
  /** Why the last attempt failed, for the card. Absent after a clean run. */
  lastError?: string
}

/** The state before anything has run. */
export function emptyMultiplierRefreshState(): MultiplierRefreshState {
  return { changed: 0, degraded: false }
}

/**
 * Whether an attempt is due now.
 *
 * NEVER-RUN IS DUE — including at startup, which is what makes the feature act
 * immediately after a reload instead of waiting out its first interval. The
 * startup catalog refresh and this call are not the same request: the startup
 * read derives a runtime catalog and repairs the directory wholesale, while this
 * one is the narrow "reprice the rows already saved" answer whose result the
 * card reports.
 */
export function isMultiplierRefreshDue(
  state: MultiplierRefreshState,
  hours: unknown,
  nowMs: number,
): boolean {
  if (state.lastAttemptAtMs === undefined) return true
  return nowMs - state.lastAttemptAtMs >= multiplierRefreshIntervalMs(hours)
}

/**
 * How long to wait before the next attempt.
 *
 * CLAMPED AT BOTH ENDS, and both clamps are load-bearing:
 *
 *   - not below 0: a clock that moved backwards would otherwise answer a
 *     negative delay, which `setTimeout` treats as "now" — a re-arm on every
 *     tick;
 *   - not above one interval: a `lastAttemptAtMs` in the FUTURE (the clock was
 *     set back, a laptop resumed with a stale time) would otherwise push the
 *     next refresh to `interval + (future overshoot)` away. The feature is
 *     already best-effort about WHEN it runs; letting a clock oddity silence it
 *     for a day is worse than running it one interval early. A delay longer
 *     than the interval is never legitimate: `isMultiplierRefreshDue` would have
 *     answered "due" and the caller would not be asking for a delay at all.
 */
export function nextMultiplierRefreshDelayMs(
  state: MultiplierRefreshState,
  hours: unknown,
  nowMs: number,
): number {
  const interval = multiplierRefreshIntervalMs(hours)
  if (state.lastAttemptAtMs === undefined) return 0
  return Math.min(interval, Math.max(0, state.lastAttemptAtMs + interval - nowMs))
}
