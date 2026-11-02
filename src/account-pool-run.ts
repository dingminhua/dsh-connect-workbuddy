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
  status: 'claimed' | 'already' | 'failed' | 'skipped'
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
  /**
   * The account belongs to an enterprise (issue #124).
   *
   * The enterprise gateway does not run the consumer check-in: it answers
   * `10001` for every enterprise member, so a batch that includes one would
   * spend two requests per run to learn the same refusal and then list it as a
   * failure in a column that never applies to it. The runner skips it and says
   * so, rather than reporting a broken account.
   */
  enterprise?: boolean
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
  let issued = 0
  for (const target of targets) {
    // An enterprise account has no consumer check-in to claim (see
    // `WorkBuddyPoolTarget.enterprise`). Reported as `skipped`, not `failed`:
    // nothing is wrong with the account.
    if (target.enterprise === true) {
      rows.push({
        accountId: target.accountId,
        accountName: target.accountName,
        status: 'skipped',
        message: 'enterprise accounts have no daily check-in',
      })
      continue
    }
    // The gap is between REQUESTS, not between rows: a skipped row costs
    // nothing, so it must not delay the next one.
    if (issued > 0) await (deps.wait ?? defaultWait)(POOL_BATCH_GAP_MS)
    issued += 1
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
  /*
   * ONE model for the whole batch (issue #61 removed the per-account form).
   *
   * The per-account override was adopted from the reporter's proposal and then
   * REMOVED by the maintainer's decision: the region already has one test model,
   * and pointing it at the model you actually chat with is what the report was
   * about. Letting each row test a different model makes a green batch
   * UNCOMPARABLE — one account's `ok` would be on model X and another's on model
   * Y — which is the very reading ("all green") the report warned against. What
   * stays from #61 is the half that needs no new setting: every measurement
   * records the model it probed, and each row displays it.
   */
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
    // Reading the credential STORE threw — a local disk fault, not an upstream
    // verdict about this account (issue #195).
    //
    // This used to report `credential-rejected`, which is the one outcome
    // `exclusionOf` excludes with NO cooldown: the account left the pool
    // permanently, and the card explained it as "sign in again" while the
    // sign-in was perfectly fine. A one-off `EIO` on the vault file would
    // therefore idle a healthy account forever — worse than issue #193's
    // half-hour, and pointing the user at a fix that cannot work.
    //
    // `status: 0` is this codebase's convention for "the request never landed",
    // and it is what makes `probeUpdatesOf` DROP this row instead of persisting
    // it — the account keeps its previous measurement, which is the honest
    // outcome: we learned nothing about it. The batch still reports the row (a
    // failure must never hide the other accounts), and `failed` is the neutral
    // label for the row itself: `unavailable` would render as "cannot reach the
    // upstream", which is precisely the wrong party to blame.
    return {
      ...base,
      result: { modelId, outcome: 'failed', status: 0, message: messageOf(error) },
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
 * That covers two distinct "we never got to ask the model" cases, and they are
 * dropped by {@link isTransportFailure} for different reasons: an absent
 * credential reports itself as `credential-rejected` with the pool's own
 * message, while a credential STORE that threw reports `failed` with `status: 0`
 * (issue #195 — it used to report `credential-rejected`, which carries no
 * cooldown and excluded the account permanently).
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
      // 'test-batch' is what makes a later live failure VISIBLE as such: the
      // record now says this account was deliberately measured `ok`, so a
      // subsequent `live-request` entry is explainable rather than looking
      // like the file rolled back to an older value.
      source: 'test-batch',
      // The model this batch probed (issue #61). Every row of one batch shares
      // it, and without it the record cannot say what the `ok` was about.
      modelId: row.result.modelId,
      // The name is written HERE, at the one moment it is certainly available
      // (issue #60): the batch holds the account because it just resolved it.
      // A member whose sign-in later disappears can then still be named in the
      // card, instead of degrading to a bare id and a subjectless count.
      ...row.accountName === '' ? {} : { accountName: row.accountName },
      ...row.result.retryAtMs === undefined ? {} : { retryAtMs: row.result.retryAtMs },
      ...row.result.message === undefined ? {} : { message: row.result.message },
    }
  }
  return updates
}

/**
 * Whether a probe result measures the TRANSPORT rather than the model.
 *
 * Two shapes qualify, and both must be dropped rather than persisted:
 *
 * 1. `credential-rejected` with the pool's own "no stored credential" message —
 *    we could not even read the credential, so the request never left.
 * 2. `status: 0` — the request never produced an HTTP response at all. That is
 *    what a probe timeout looks like (`transport error: no response within
 *    30000ms`), and equally a DNS failure, a reset connection, or a throw from
 *    the identity work that runs BEFORE the request is sent (`wireIdentity`).
 *    Issue #195 is the third of those: `probeModel`'s own `catch` returned
 *    `unavailable` with NO `status` at all, so it slipped past this test and
 *    benched a healthy account for half an hour.
 *
 * WHY (2) MATTERS — it is the difference between a working pool and a 30-minute
 * outage. A `status: 0` result carries no `retryAtMs` (nothing upstream said
 * when to come back), so `exclusionOf` falls back to
 * {@link POOL_UNKNOWN_COOLDOWN_MS} — 30 minutes. Persisting a timeout therefore
 * benches a perfectly healthy account for half an hour, and since nothing
 * re-probes an excluded member, the pool stays empty until the cooldown lapses
 * on its own. The user sees "池中已无可用账号" and a 502 for a fault that was
 * never the account's.
 *
 * The distinction has to stay honest in the other direction too: `status >= 500`
 * is NOT a transport failure. The gateway answered, and its answer is a
 * statement about this account's standing with it, so those rows are still kept.
 */
function isTransportFailure(result: WorkBuddyProbeResult): boolean {
  if (result.status === 0) return true
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
