/**
 * Multi-account growth batches (issue #286), region-agnostic by construction.
 *
 * Mirrors `account-pool-run.ts`'s check-in batch: one row per account, serial
 * with a small gap, every failure captured on its own row so one bad account
 * never hides the others. The account's credential is fetched via
 * `credentialFor(id)` — NEVER `resolve()` — so a batch never changes which
 * account bills the user's live traffic.
 *
 * Two capabilities, each with its own dependency seam so it is testable with
 * no Host and no network:
 *   - `redeemGrowthAll` — for each member, read streak, redeem only the tiers
 *     the gateway marked `available`. Idempotent: an all-locked snapshot is a
 *     `skipped` row and sends no write.
 *   - `activateGrowthAll` — for each member, ensure "active today" through the
 *     ACP session. The caller supplies a per-credential activation function
 *     (which closes over the region's model roster), so this module stays
 *     ignorant of model choice and of the ACP protocol itself.
 *
 * @module dsh-connect-workbuddy/growth-run
 */

import type { AutoCheckinState } from './auto-checkin.ts'

/** One pool member as a growth batch addresses it. */
export interface GrowthTarget {
  accountId: string
  accountName: string
}

/** One row of a growth batch. `status` values are stable for the card to render. */
export interface GrowthRow {
  accountId: string
  accountName: string
  status: 'done' | 'skipped' | 'failed'
  /** Human-readable detail (what was redeemed / why skipped / error). */
  message?: string
  /** Total credit gained this run, when known. */
  credit?: number
}

/**
 * Map growth rows into the check-in row shape `foldAttempt` accepts.
 *
 * The `message` must be carried through: `foldAttempt` uses a failed row's
 * message as `lastError`, and falls back to `accountId` when it is absent — so
 * dropping it here makes the card show a raw 24-hex account id as "last attempt
 * failed" (the bug this helper pins). Both the timer and the manual run call
 * this ONE mapping so they cannot drift.
 */
export function growthRowsForFold(rows: readonly GrowthRow[]): {
  accountId: string
  accountName: string
  status: 'claimed' | 'already' | 'failed'
  message?: string
}[] {
  return rows.map(row => ({
    accountId: row.accountId,
    accountName: row.accountName,
    status: row.status === 'done' ? 'claimed' : row.status === 'skipped' ? 'already' : 'failed',
    ...row.message === undefined ? {} : { message: row.message },
  }))
}

/* ------------------------------------------------------------------------- *
 * Growth day state — deliberately NOT the check-in retry state machine.
 *
 * Check-in records only SUCCESSFUL accounts so a failed one is retried with
 * backoff (that is right for a reward you must not miss). Growth is different:
 * "active today" and "redeem available tiers" are idempotent per-day facts, and
 * the user asked for a STABLE "已兑换 / 已点亮" state — an account we already
 * attempted today is settled, whether it redeemed something, was already done,
 * or the gateway was unreachable. Re-trying it produces exactly the "待重试 N /
 * 上次失败" noise the user rejected. So these helpers mark every addressed
 * account settled and never carry `lastError`/`failures` forward.
 * ------------------------------------------------------------------------- */

/** Accounts still due today: pool members minus those already settled. */
export function growthPendingTargets<T extends { accountId: string }>(
  targets: readonly T[],
  state: AutoCheckinState | undefined,
): T[] {
  const done = new Set(state?.doneAccountIds ?? [])
  return targets.filter(target => !done.has(target.accountId))
}

/**
 * Fold one growth attempt into today's state: every addressed account is marked
 * settled. No backoff, no `lastError` — the card shows a plain done/total count.
 * `scopeSize` is the REAL member count passed by the caller (never accumulated),
 * so a manual run cannot inflate the denominator the way the earlier bug did.
 */
export function foldGrowthAttempt(
  state: AutoCheckinState,
  attemptedIds: readonly string[],
  scopeSize: number,
  nowMs: number,
): AutoCheckinState {
  const done = new Set([...state.doneAccountIds, ...attemptedIds])
  return {
    day: state.day,
    doneAccountIds: [...done],
    scopeSize,
    failures: 0,
    lastAttemptAtMs: nowMs,
  }
}

/** A day summary with NO pending/retry/failure fields — just done of total. */
export function growthTodaySummary(
  state: AutoCheckinState | undefined,
  day: string,
): { done: number; total: number } | undefined {
  if (state === undefined || state.day !== day) return undefined
  return {
    done: Math.min(state.doneAccountIds.length, state.scopeSize),
    total: state.scopeSize,
  }
}

/** Dependencies for the redeem batch, injected for tests. */
export interface RedeemBatchDeps {
  credentialFor(accountId: string): Promise<{ accessToken: string } | undefined>
  readStreak(credential: { accessToken: string }): Promise<{
    availableTiers: readonly string[]
  } | undefined>
  redeem(credential: { accessToken: string }, tier: string): Promise<{ credit: number }>
  wait?: (ms: number) => Promise<void>
}

/** Gap between accounts, same politeness as the check-in batch. */
export const GROWTH_BATCH_GAP_MS = 400

async function pause(deps: { wait?: (ms: number) => Promise<void> }, issued: number): Promise<void> {
  if (issued > 0) await (deps.wait ?? (async (ms: number) => { await new Promise<void>(r => setTimeout(r, ms)) }))(GROWTH_BATCH_GAP_MS)
}

/**
 * Redeem every claimable tier for every target, one account at a time.
 * Only tiers the gateway reported `available` are written — a `locked` tier is
 * never redeemed, so a repeated run is a no-op rather than a refused write.
 * Never throws: each problem becomes a `failed` row and the batch continues.
 */
export async function redeemGrowthAll(
  targets: readonly GrowthTarget[],
  deps: RedeemBatchDeps,
): Promise<GrowthRow[]> {
  const rows: GrowthRow[] = []
  let issued = 0
  for (const target of targets) {
    const base = { accountId: target.accountId, accountName: target.accountName }
    let credential
    try {
      credential = await deps.credentialFor(target.accountId)
    } catch (error: unknown) {
      rows.push({ ...base, status: 'failed', message: String(error) })
      continue
    }
    if (credential === undefined) {
      rows.push({ ...base, status: 'failed', message: 'no stored credential for this account' })
      continue
    }
    let streak
    try {
      streak = await deps.readStreak(credential)
    } catch (error: unknown) {
      rows.push({ ...base, status: 'failed', message: String(error) })
      continue
    }
    if (streak === undefined) {
      rows.push({ ...base, status: 'failed', message: 'growth streak was not readable' })
      continue
    }
    if (streak.availableTiers.length === 0) {
      rows.push({ ...base, status: 'skipped', message: 'no tier is available to redeem' })
      continue
    }
    await pause(deps, issued)
    issued += 1
    let credit = 0
    const done: string[] = []
    let failure = ''
    for (const tier of streak.availableTiers) {
      try {
        const result = await deps.redeem(credential, tier)
        credit += result.credit
        done.push(tier)
      } catch (error: unknown) {
        failure = String(error)
        break
      }
    }
    if (failure !== '' && done.length === 0) {
      rows.push({ ...base, status: 'failed', message: failure })
    } else {
      rows.push({
        ...base,
        status: 'done',
        credit,
        message: `redeemed ${done.join(',')}${failure === '' ? '' : `; stopped: ${failure}`}`,
      })
    }
  }
  return rows
}

/** One account's activation, as the batch needs it. Returns a result .status string. */
export type ActivateOne = (accountId: string) => Promise<
  { status: 'already-active' | 'activated' | 'failed'; score?: number; reason?: string }
>

/**
 * Ensure "active today" for every target, one account at a time. The caller
 * supplies `activateOne` so model selection and ACP details stay outside this
 * module. Idempotency lives in the activate function (already-active sends no
 * session), so a repeated batch is safe.
 */
export async function activateGrowthAll(
  targets: readonly GrowthTarget[],
  activateOne: ActivateOne,
  wait?: (ms: number) => Promise<void>,
): Promise<GrowthRow[]> {
  const rows: GrowthRow[] = []
  let issued = 0
  for (const target of targets) {
    let result
    try {
      result = await activateOne(target.accountId)
    } catch (error: unknown) {
      rows.push({ accountId: target.accountId, accountName: target.accountName, status: 'failed', message: String(error) })
      continue
    }
    if (result.status === 'already-active') {
      rows.push({ accountId: target.accountId, accountName: target.accountName, status: 'skipped', message: 'already active today' })
      continue
    }
    if (result.status === 'activated') {
      if (issued > 0) await (wait ?? (async (ms: number) => { await new Promise<void>(r => setTimeout(r, ms)) }))(GROWTH_BATCH_GAP_MS)
      issued += 1
      rows.push({ accountId: target.accountId, accountName: target.accountName, status: 'done', message: 'activated' })
      continue
    }
    rows.push({
      accountId: target.accountId,
      accountName: target.accountName,
      status: 'failed',
      message: result.reason ?? 'activation failed',
    })
  }
  return rows
}
