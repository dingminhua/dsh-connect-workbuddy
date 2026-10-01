/**
 * The pool's two batch actions: check in every account, and test every account.
 *
 * 参考：本仓库 `src/probe.ts` 的 `probeModel`（一次真实体积探测，永不抛异常）
 *   与 `src/upstream.ts` 的 `fetchCheckinStatus`/`claimDailyCheckin`/
 *   `fetchCredits`。批处理只是把它们串起来，不重新定义任何一次请求。
 * 改动：新增「跨账号」这一层编排，并且把三条规则固化成代码 ——
 *
 *   1. **串行，绝不并发。** 上游的限流按请求体积触发，且每个账号各自计时；
 *      同时打整池正是把好账号打成 429 的最快方式。串行 + 账号间小间隔。
 *   2. **一个账号失败不中断整批。** 这是 `probeModel` 已确立的原则：一个坏
 *      账号不能把其余账号的结果一起藏起来。批量结果**逐个账号**返回，
 *      而不是整体成功/失败。
 *   3. **签到先查状态，已签到就不再发写入请求。** 幂等，避免重复领取 —— 也
 *      避免把一次「已经签过」当成失败。
 *
 * 本模块不持有定时器、不写盘：编排是纯的（依赖注入），因此可被单测直接驱动。
 *
 * @module dsh-connect-workbuddy/account-pool-run
 */

import type { WorkBuddyCredential } from './auth.ts'
import type { WorkBuddyPoolProbe } from './account-pool.ts'
import type { WorkBuddyProbeResult } from './probe.ts'
import type { WorkBuddyCheckinStatus } from './upstream.ts'

/** One account's check-in outcome. */
export interface WorkBuddyPoolCheckinRow {
  accountId: string
  accountName: string
  status: 'claimed' | 'already' | 'failed'
  /** Credits gained, when the upstream stated a figure. */
  credit?: number
  /** Streak length after the claim, when the upstream stated one. */
  streakDays?: number
  /** The upstream's own words on failure, redacted by the caller. */
  message?: string
}

/** One account's test outcome. */
export interface WorkBuddyPoolTestRow {
  accountId: string
  accountName: string
  result: WorkBuddyProbeResult
}

/** One pool member as the batch runner addresses it. */
export interface WorkBuddyPoolTarget {
  accountId: string
  accountName: string
}

/** What the batch runner needs from the Host, injected so it stays testable. */
export interface WorkBuddyPoolRunnerDeps {
  /**
   * The stored credential for one account, WITHOUT changing the region's
   * selection. Resolving through `credentialFor` is what lets a batch address
   * every account while the user's chosen account keeps serving traffic.
   */
  credentialFor(accountId: string): Promise<WorkBuddyCredential | undefined>
  /** Today's check-in state for one credential. */
  fetchCheckinStatus(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinStatus>
  /** Claim today's reward for one credential. */
  claimDailyCheckin(credential: WorkBuddyCredential): Promise<{ credit: number, streakDays: number }>
  /** One real-volume probe of one model through one credential. */
  probe(
    credential: WorkBuddyCredential,
    modelId: string,
  ): Promise<WorkBuddyProbeResult>
  /** Pause between accounts; injected so tests run without real delays. */
  wait?: (ms: number) => Promise<void>
}

/**
 * Pause between accounts inside one batch.
 *
 * A small, fixed gap. Its purpose is to avoid firing the pool's requests back
 * to back — the upstream's limit fires on request SIZE per account, so the gap
 * is modest politeness rather than a rate-limit workaround.
 */
export const POOL_BATCH_GAP_MS = 400

/**
 * Check in every account, one at a time.
 *
 * Idempotent by design (see the module note): an account already checked in
 * today is reported as `already` and NO write is attempted. A failure on one
 * account is recorded on that row and the batch continues.
 *
 * Never throws: every problem becomes a row, because a batch that aborted on
 * its first bad account would hide the state of all the others.
 */
export async function checkinAllAccounts(
  targets: readonly WorkBuddyPoolTarget[],
  deps: WorkBuddyPoolRunnerDeps,
  nowMs: () => number = Date.now,
): Promise<WorkBuddyPoolCheckinRow[]> {
  void nowMs
  const rows: WorkBuddyPoolCheckinRow[] = []
  for (const [index, target] of targets.entries()) {
    if (index > 0) await (deps.wait ?? defaultWait)(POOL_BATCH_GAP_MS)
    rows.push(await checkinOne(target, deps))
  }
  return rows
}

/** One account's check-in, reduced to its row. */
async function checkinOne(
  target: WorkBuddyPoolTarget,
  deps: WorkBuddyPoolRunnerDeps,
): Promise<WorkBuddyPoolCheckinRow> {
  const base = { accountId: target.accountId, accountName: target.accountName }
  let credential: WorkBuddyCredential | undefined
  try {
    credential = await deps.credentialFor(target.accountId)
  } catch (error: unknown) {
    return { ...base, status: 'failed', message: messageOf(error) }
  }
  if (credential === undefined) {
    return { ...base, status: 'failed', message: 'no stored credential for this account' }
  }
  try {
    const status = await deps.fetchCheckinStatus(credential)
    // Not active (an upstream-declared closed window) is reported as `failed`
    // rather than `already`: claiming is impossible, and saying "already
    // checked in" would be a different, wrong claim.
    if (!status.active) {
      return { ...base, status: 'failed', message: 'check-in activity is not active' }
    }
    if (status.todayCheckedIn) return { ...base, status: 'already' }
    const claim = await deps.claimDailyCheckin(credential)
    return {
      ...base,
      status: 'claimed',
      credit: claim.credit,
      streakDays: claim.streakDays,
    }
  } catch (error: unknown) {
    return { ...base, status: 'failed', message: messageOf(error) }
  }
}

/**
 * Test every account against one model, one at a time.
 *
 * The model is resolved by the caller (see `resolveTargetModel`) so this
 * function never has to decide "free or not" — an unresolvable target is the
 * caller's problem to report, and testing against a model nobody chose would be
 * exactly the silent spend the plan forbids.
 *
 * Never throws: a failed probe is a ROW, not an aborted batch.
 *
 * `onRow` fires the moment one account's row exists, which is what lets a caller
 * report progress. The loop is SERIAL by design (one account at a time — hitting
 * the whole pool at once is the fastest way to trip the upstream's volume limit),
 * so without this a caller cannot say anything until the SLOWEST member answers:
 * one stuck account made a working batch look like a dead button. The return
 * value is unchanged, so every existing caller keeps all rows at the end.
 */
export async function testAllAccounts(
  targets: readonly WorkBuddyPoolTarget[],
  modelId: string,
  deps: WorkBuddyPoolRunnerDeps,
  /** Called after each account finishes, in the order they were tested. */
  onRow?: (row: WorkBuddyPoolTestRow) => void,
): Promise<WorkBuddyPoolTestRow[]> {
  const rows: WorkBuddyPoolTestRow[] = []
  for (const [index, target] of targets.entries()) {
    if (index > 0) await (deps.wait ?? defaultWait)(POOL_BATCH_GAP_MS)
    const row = await testOne(target, modelId, deps)
    rows.push(row)
    // A throwing reporter must not lose the rows already collected, so it is
    // called outside any structure that would abort the loop.
    onRow?.(row)
  }
  return rows
}

/** One account's probe, reduced to its row. */
async function testOne(
  target: WorkBuddyPoolTarget,
  modelId: string,
  deps: WorkBuddyPoolRunnerDeps,
): Promise<WorkBuddyPoolTestRow> {
  const base = { accountId: target.accountId, accountName: target.accountName }
  let credential: WorkBuddyCredential | undefined
  try {
    credential = await deps.credentialFor(target.accountId)
  } catch (error: unknown) {
    return {
      ...base,
      result: { modelId, outcome: 'credential-rejected', message: messageOf(error) },
    }
  }
  if (credential === undefined) {
    return {
      ...base,
      result: {
        modelId,
        outcome: 'credential-rejected',
        message: 'no stored credential for this account',
      },
    }
  }
  return { ...base, result: await deps.probe(credential, modelId) }
}

/**
 * Turn a test batch's rows into the per-account measurements to remember.
 *
 * A row is stored only when the probe actually measured the MODEL. A row that
 * failed because the credential could not even be read says nothing about the
 * model, and recording it would exclude a possibly-perfect account from the
 * pool — so those accounts keep their previous measurement instead.
 *
 * `atMs` is stamped here, once for the batch, so the card's "tested N minutes
 * ago" reflects when the batch finished rather than drifting per row.
 *
 * `message` is carried through as well. `probeModel` already redacted it before
 * returning, so persisting it cannot leak a token, and without it the pool table
 * could only repeat one generic sentence for a DNS failure, a gateway 502 and a
 * cancelled request alike.
 */
export function probeUpdatesOf(
  rows: readonly WorkBuddyPoolTestRow[],
): Record<string, WorkBuddyPoolProbe> {
  const atMs = Date.now()
  const updates: Record<string, WorkBuddyPoolProbe> = {}
  for (const row of rows) {
    if (isTransportFailure(row.result)) continue
    updates[row.accountId] = {
      outcome: row.result.outcome,
      atMs,
      ...row.result.retryAtMs === undefined ? {} : { retryAtMs: row.result.retryAtMs },
      ...row.result.message === undefined ? {} : { message: row.result.message },
    }
  }
  return updates
}

/**
 * Whether a probe result measures the transport rather than the model.
 *
 * `credential-rejected` with the pool's own "no stored credential" message is
 * the one case we can attribute to ourselves rather than the upstream: the
 * request never left. Every other rejection came from the upstream and IS a
 * statement about this account, so it is kept.
 */
function isTransportFailure(result: WorkBuddyProbeResult): boolean {
  return result.outcome === 'credential-rejected'
    && result.message?.startsWith('no stored credential') === true
}

/** The default inter-account pause. */
function defaultWait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A safe message from an unknown throwable, bounded in length. */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 300)
}
