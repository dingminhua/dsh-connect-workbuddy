/**
 * The daily check-in, run by the plugin instead of by a button press.
 *
 * ## Why this exists at all, given the old rule
 *
 * This plugin deliberately shipped with NO automatic check-in, and README and
 * CHANGELOG both said so: claiming a daily reward is a real WRITE on the user's
 * account, and a feature that does it unasked is the plugin making a decision
 * that belongs to its owner. That reasoning is still correct — which is why this
 * is an OPT-IN switch, off by default, and why nothing here runs until the user
 * ticks it (issue #191).
 *
 * What changed is the cost of the alternative. A missed day resets the streak to
 * zero (the reporter was at 32 days), and the check-in itself costs no credits
 * and is idempotent upstream. So the honest framing is not "should the plugin
 * ever do this" but "the user may decide, once, that it should" — and the switch
 * is where they decide.
 *
 * ## The four properties that make it safe
 *
 * 1. **Idempotent by construction.** It calls the SAME `checkinAllAccounts` the
 *    manual button calls, which reads status first and reports `already` WITHOUT
 *    sending a claim. So a restart, a retry, or a duplicate timer tick cannot
 *    claim twice — there is no second code path that could.
 * 2. **Scoped to the pool the user ticked.** Membership is the existing
 *    "yes, spend this account's credits" consent. An account not in the pool is
 *    not checked in, exactly as it is not tested or rotated.
 * 3. **Bounded retries, then stop.** A transient failure retries on a widening
 *    backoff and then settles into a slow poll until the day rolls over. It
 *    never hammers the upstream, and it never gives up for good on the day.
 * 4. **Observable.** The card shows what happened ("N of M checked in today"),
 *    so a background action is never invisible.
 *
 * ## Why the scheduling is pure
 *
 * Every decision — "is it time?", "which accounts?", "what do I report?" — lives
 * in exported functions over plain data. The module holds no timer and reads no
 * clock. `src/index.ts` owns the timer and the disk; this file owns the rules,
 * so the rules can be tested without a Host, a network, or fake time. That is
 * the same split `account-pool-run.ts` uses for the batches, and for the same
 * reason.
 *
 * @module dsh-connect-workbuddy/auto-checkin
 */

import type { WorkBuddyPoolCheckinRow } from './account-pool-run.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/**
 * Regions that have a daily check-in at all.
 *
 * The CN gateway runs a consumer check-in; the international one does not. The
 * card hides the switch on a region without one, and this predicate is the
 * single place that fact is stated for the background path — the manual button
 * asks `checkinSupported` on the same rule.
 */
export function autoCheckinRegions(): readonly WorkBuddyRegion[] {
  return ['cn']
}

/**
 * Retry backoff after a failed attempt, in milliseconds.
 *
 * Five widening steps and then a slow poll. The shape matters more than the
 * numbers: the first retry is soon (a transient socket fault clears in seconds),
 * and the tail is slow (an upstream outage should not be probed every minute for
 * the rest of the day). After the last entry, {@link AUTO_CHECKIN_TAIL_MS}
 * repeats until the local day rolls over.
 */
export const AUTO_CHECKIN_BACKOFF_MS: readonly number[] = [
  30_000,
  60_000,
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
]

/** The steady-state retry interval once {@link AUTO_CHECKIN_BACKOFF_MS} is spent. */
export const AUTO_CHECKIN_TAIL_MS = 30 * 60_000

/**
 * How long after a completed day the runner waits before trying again.
 *
 * Not a retry: this is the "everything is done, come back tomorrow" interval.
 * It exists so the timer keeps a slow heartbeat rather than stopping dead — a
 * stopped timer cannot notice the local day rolling over, and re-arming from a
 * one-shot is how a background feature silently dies after its first day.
 */
export const AUTO_CHECKIN_IDLE_MS = 30 * 60_000

/**
 * The local calendar day, as `YYYY-MM-DD`.
 *
 * LOCAL, not UTC, and deliberately so: the upstream resets its check-in at the
 * user's local midnight (the card's own wording is 「今天」), so a runner keyed
 * to UTC would consider 08:00 local a new day and try to claim twice, or think
 * the day was done while the reward was still claimable.
 *
 * Built from the local getters rather than `toISOString()` — the latter is UTC
 * and would put the boundary in the wrong place for every user not on UTC.
 */
export function localDayKey(nowMs: number): string {
  const date = new Date(nowMs)
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * What one region's runner remembers between ticks.
 *
 * Persisted so a restart mid-day resumes instead of re-deriving: without it,
 * every restart would treat the day as unattempted and run a fresh batch, which
 * is idempotent but spends one status request per account each time.
 */
export interface AutoCheckinState {
  /** The local day this state describes; a different day resets everything. */
  day: string
  /**
   * Accounts confirmed done TODAY: `claimed` or `already`.
   *
   * A `failed` row is deliberately NOT recorded, so the next tick retries it
   * while leaving the successful accounts alone.
   */
  doneAccountIds: readonly string[]
  /**
   * How many accounts were IN SCOPE on the last tick (members minus enterprise
   * members).
   *
   * Recorded HERE rather than recomputed by the card, because the card's poll
   * cannot afford to enumerate the credential store, and because membership can
   * change mid-day: the number this day's progress was measured against is the
   * only honest denominator for "N of M".
   */
  scopeSize: number
  /**
   * Consecutive failed attempts today, which selects the backoff step.
   *
   * Reset to 0 whenever an attempt adds at least one account to
   * {@link doneAccountIds}: progress means the upstream is reachable, so the
   * next failure deserves a fresh (short) backoff rather than the tail.
   */
  failures: number
  /** When the last attempt finished, in epoch ms. */
  lastAttemptAtMs?: number
  /** Why the last attempt failed, for the card. Absent after a clean run. */
  lastError?: string
}

/** A state for a day with nothing done yet. */
export function emptyAutoCheckinState(day: string): AutoCheckinState {
  return { day, doneAccountIds: [], scopeSize: 0, failures: 0 }
}

/**
 * Fold one attempt's rows into the day's state.
 *
 * `doneAccountIds` accumulates ACROSS attempts within a day, because a batch can
 * fail halfway: the accounts that answered stay done, and the next tick only
 * has to retry the rest. Recomputing the set from this attempt alone would make
 * the runner re-check accounts that already succeeded.
 *
 * `failures` counts CONSECUTIVE failures, and an attempt that made progress
 * resets it — see {@link AutoCheckinState.failures}.
 */
export function foldAttempt(
  previous: AutoCheckinState,
  rows: readonly WorkBuddyPoolCheckinRow[],
  nowMs: number,
  scopeSize: number = previous.scopeSize,
): AutoCheckinState {
  const done = new Set(previous.doneAccountIds)
  let progressed = false
  const failures: string[] = []
  for (const row of rows) {
    if (row.status === 'claimed' || row.status === 'already') {
      if (!done.has(row.accountId)) {
        done.add(row.accountId)
        progressed = true
      }
      continue
    }
    // `skipped` is not a failure: an enterprise member has no consumer check-in,
    // so it will never succeed and must not keep the backoff spinning. It is
    // also not "done" — it is simply out of scope, and leaving it out of both
    // sets keeps the card's "N of M" honest.
    if (row.status === 'failed') failures.push(row.message ?? row.accountId)
  }
  const nextFailures = progressed ? 0 : previous.failures + (failures.length > 0 ? 1 : 0)
  return {
    day: previous.day,
    doneAccountIds: [...done],
    scopeSize,
    failures: nextFailures,
    lastAttemptAtMs: nowMs,
    ...failures.length === 0 ? {} : { lastError: failures[0] },
  }
}

/**
 * How long to wait before the next attempt.
 *
 * Returns `undefined` when there is nothing left to do today — the caller then
 * arms {@link AUTO_CHECKIN_IDLE_MS} instead of a retry, which is how the timer
 * stays alive to notice the day rolling over without re-running the batch.
 *
 * `pending` is the number of accounts still outstanding. It is passed rather
 * than derived from the state because only the caller can enumerate the pool
 * (the state records what is DONE, not what exists).
 */
export function nextDelayMs(state: AutoCheckinState, pending: number): number | undefined {
  if (pending === 0) return undefined
  const step = AUTO_CHECKIN_BACKOFF_MS[Math.min(state.failures, AUTO_CHECKIN_BACKOFF_MS.length - 1)]
  return state.failures >= AUTO_CHECKIN_BACKOFF_MS.length ? AUTO_CHECKIN_TAIL_MS : step
}

/**
 * Whether an attempt is due now.
 *
 * `pending === 0` is "nothing to do", which is NOT "due": arming a retry for an
 * empty set would spin the timer every backoff step to discover the same thing.
 */
export function isDue(state: AutoCheckinState, pending: number, nowMs: number): boolean {
  if (pending === 0) return false
  if (state.lastAttemptAtMs === undefined) return true
  const delay = nextDelayMs(state, pending)
  if (delay === undefined) return false
  return nowMs - state.lastAttemptAtMs >= delay
}

/**
 * The card's summary of today.
 *
 * `pending` counts accounts that still need an attempt — a `failed` member
 * stays pending, a `skipped` (enterprise) member does not. Reported as a plain
 * shape rather than a sentence so both locales render it, and so the card can
 * decide WHERE to put it (the reporter asked for a status line beside the
 * switch).
 */
export interface AutoCheckinSummary {
  /** Accounts confirmed done today. */
  done: number
  /** Accounts in scope today (members minus enterprise members). */
  total: number
  /** Attempts still owed today; 0 means the day is finished. */
  pending: number
  /** Why the last attempt failed, when it did. */
  lastError?: string
}

/**
 * Build the card's summary.
 *
 * Takes the STATE alone: the denominator was recorded when the day's first
 * attempt ran (see {@link AutoCheckinState.scopeSize}), so the card's poll needs
 * no credential-store scan and membership edits mid-day cannot silently rewrite
 * the progress it is reporting.
 */
export function summarizeAutoCheckin(state: AutoCheckinState): AutoCheckinSummary {
  const inScope = Math.max(0, state.scopeSize)
  const done = Math.min(state.doneAccountIds.length, inScope)
  return {
    done,
    total: inScope,
    pending: Math.max(0, inScope - done),
    ...state.lastError === undefined ? {} : { lastError: state.lastError },
  }
}

/**
 * Today's summary — `undefined` when `state` is not today's.
 *
 * The day check is NOT a nicety (issue #232). The state is only rewritten when a
 * tick runs, and after a finished day the next tick is an idle heartbeat up to
 * {@link AUTO_CHECKIN_IDLE_MS} away — so for the first half hour of a new local
 * day the in-memory state still describes YESTERDAY. Summarizing it as today made
 * the card announce 「今日：N 个全部已签」 at 00:08 while every row underneath
 * read 未签到, i.e. the one place that is supposed to prove the runner works
 * claimed the opposite of the truth.
 *
 * `undefined` (rather than a zeroed summary) is what the card already renders as
 * "no status line", and it is the honest answer: nothing has run today yet. The
 * zeroed variant would invent a denominator for a day no attempt has measured.
 */
export function todaySummary(state: AutoCheckinState, nowMs: number): AutoCheckinSummary | undefined {
  if (state.day !== localDayKey(nowMs)) return undefined
  return summarizeAutoCheckin(state)
}

/**
 * Whether a cached check-in reading may still be served.
 *
 * Two conditions, and the second is the one that took a bug report: a reading is
 * an answer to "has this account checked in TODAY", so it must not survive local
 * midnight. The TTL alone would serve a `true` read taken at 23:58 until 00:08,
 * so the column would assert a check-in that has not happened — the per-account
 * half of the same lie as {@link todaySummary}.
 *
 * The day is derived from `atMs` rather than stored beside it: the read time
 * already says which day the answer belongs to, and a second field could drift
 * out of step with it.
 */
export function checkinReadingFresh(atMs: number, nowMs: number, ttlMs: number): boolean {
  if (nowMs - atMs >= ttlMs) return false
  return localDayKey(atMs) === localDayKey(nowMs)
}

/**
 * The accounts an attempt should address, in the pool's own order.
 *
 * Only members that are not already done. Enterprise members are dropped HERE
 * rather than left to the batch runner: the runner would report them `skipped`
 * on every attempt, and while that is harmless it also means every tick would
 * look like it had work to do. Filtering up front keeps "pending" meaningful.
 */
export function pendingTargets<T extends { accountId: string, enterprise?: boolean }>(
  targets: readonly T[],
  state: AutoCheckinState,
): T[] {
  const done = new Set(state.doneAccountIds)
  return targets.filter(target => target.enterprise !== true && !done.has(target.accountId))
}
