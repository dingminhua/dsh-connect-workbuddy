/**
 * The account pool: which local account should be billed, and why.
 *
 * 参考：本仓库既有的「按区域隔离的账号/凭据栈」(`src/auth.ts` 的
 *   `WorkBuddyCredentialStore`) 与「真实体积探测」(`src/probe.ts` 的
 *   `probeModel`)。两者都被直接复用，不另起一套账号或探测机制。
 * 改动：把「选哪个账号」这件事从**跟随桌面端登录**扩展为「可选的、按规则
 *   自动挑选」。这是插件原先刻意不做的事 —— `src/auth.ts` 的 `preferred()`
 *   注释写着 "This is NOT credit-seeking"。本次把它做成**用户显式开启**的
 *   功能，因此所有规则都在这里显式化，且永不悄悄改写用户的选择记录。
 *
 * 本模块只做**纯逻辑**（打分、排序、挑免费模型），不碰网络、不碰文件系统，
 * 以便单测直接钉住这些规则 —— 它们包含三个猜不出来、必须显式表达的结论：
 *
 *   1. **`creditMultiplier` 缺失不等于免费。** 上游的倍率来自 `credits`
 *      字符串（`x0.00`），由 `parseCreditMultiplier()` 在刷新时解析。国内版
 *      的静态 fallback 目录**整份都没有**该字段，所以「没有倍率」在国内版是
 *      常态。把 `undefined` 当作 0 会让插件在首次刷新前把收费模型当成免费
 *      模型去反复探测，直接产生用户没预期的开销。
 *   2. **没有免费模型时不回退到收费模型。** 宁可让按钮告知「本区域暂无免费
 *      模型」，也不静默换一个收费模型去跑批量测试。
 *   3. **`rate-limited` 只是暂时出池。** 它恰恰是本功能最想利用的状态
 *      （模型本身没问题），若当成永久不可用剔除，就等于把好账号扔了。
 *
 * @module dsh-connect-workbuddy/account-pool
 */

import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyProbeOutcome } from './probe.ts'

/** One account's pool entry: what the picker needs, plus its last measurement. */
export interface WorkBuddyPoolAccount {
  /** Stable account id (the same one `WorkBuddyAccountChoice` carries). */
  id: string
  /** Human name, or `''` when the desktop app recorded none. */
  accountName: string
}

/**
 * What the pool knows about ONE account's last test of the target model.
 *
 * `undefined` means "never tested", which is deliberately distinct from every
 * measured outcome: an untested account is a candidate (the user may want to
 * use it now) whereas a measured failure is not. Collapsing the two would make
 * a fresh pool look empty until the first timer tick.
 */
export interface WorkBuddyPoolProbe {
  outcome: WorkBuddyProbeOutcome
  /** When this measurement was taken, in epoch ms. */
  atMs: number
  /**
   * When this account may be usable again, when the upstream stated a time.
   *
   * Present for a `rate-limited` outcome whose failure body carried a reset
   * sentence, and for an `out-of-credit` outcome with a known quota refresh.
   * ABSENT when the upstream named no time — that absence is meaningful and
   * must never be turned into a locally invented countdown.
   */
  retryAtMs?: number
}

/** One account's live credit situation, as the pool ranks it. */
export interface WorkBuddyPoolCredits {
  total: number
  /** Credits expiring within the card's "soon" window (3 days). */
  expiringSoon: number
  /** When the nearest package expires, if any does. */
  nearestExpiryMs?: number
}

/**
 * Everything the ranking rule reads about one account. Assembled by the Host
 * from the credential store, the credits route, and the runtime probe store —
 * this module only consumes it.
 */
export interface WorkBuddyPoolMember {
  account: WorkBuddyPoolAccount
  credits?: WorkBuddyPoolCredits
  probe?: WorkBuddyPoolProbe
  /** When the stored credential expires, used as the final tie-break. */
  tokenExpiresAtMs?: number
}

/**
 * Why one account was excluded from being billed.
 *
 * Reported per account rather than collapsed into a single "no candidate"
 * answer, because the three reasons call for completely different actions
 * (wait / re-auth / top up), and the card has to say which one applies.
 */
export type WorkBuddyPoolExclusion =
  | 'unusable'
  | 'rate-limited'
  | 'out-of-credit'
  | 'credential-rejected'
  | 'not-found'
  | 'unavailable'
  | 'failed'

/** One ranked account: its score, and whether it can serve right now. */
export interface WorkBuddyPoolRanked {
  account: WorkBuddyPoolAccount
  /** Higher wins. Only comparable between rows of the same ranking call. */
  score: number
  /** Absent when the account is a candidate; set when it is excluded. */
  excludedBy?: WorkBuddyPoolExclusion
}

/**
 * How long a limited account is considered out of the pool when the upstream
 * stated no reset time.
 *
 * A conservative FALLBACK, not a measurement: it applies only to a limited
 * outcome with no `retryAtMs`, where "when can I use this again" has no honest
 * answer. Keeping such an account in the pool would re-bill it immediately and
 * re-trip the same limit; dropping it forever would discard a working account.
 * A short, stated cooldown is the least-wrong of the two.
 */
export const POOL_UNKNOWN_COOLDOWN_MS = 30 * 60_000

/**
 * Whether one account can be billed at `nowMs`.
 *
 * Returns the exclusion reason, or undefined when the account is a candidate.
 * The order matters and is NOT arbitrary:
 *
 * - A `credential-rejected` account is excluded regardless of any cooldown: its
 *   token is not accepted, so waiting cannot help and the user must re-auth.
 * - A limited outcome is checked against its stated (or fallback) cooldown, so
 *   an account whose limit has already reset is back in the pool without
 *   needing another test first.
 * - An `ok` measurement, and no measurement at all, are both candidates. The
 *   latter matters: a freshly discovered account has never been tested and must
 *   not be invisible.
 *
 * Each unusable outcome keeps its OWN value rather than being folded into
 * `credential-rejected`. The fold made one row state two contradictory things —
 * the name column said "被拒绝" (sign in again) while the probe column, reading
 * the same measurement, said "连不上上游——这是网络问题，不是模型问题" — and it
 * told a user whose upstream had merely blipped that their sign-in was bad.
 * The distinctions are already computed upstream in `outcomeOfFailure`
 * (`src/probe.ts:290-299`); this only stops discarding them.
 */
export function exclusionOf(
  probe: WorkBuddyPoolProbe | undefined,
  nowMs: number,
): WorkBuddyPoolExclusion | undefined {
  if (probe === undefined) return undefined
  switch (probe.outcome) {
    case 'ok':
      return undefined
    case 'credential-rejected':
      return 'credential-rejected'
    case 'not-found':
      return 'not-found'
    case 'unavailable':
      return 'unavailable'
    case 'failed':
      return 'failed'
    case 'rate-limited':
      return retryDue(probe, nowMs) ? undefined : 'rate-limited'
    case 'out-of-credit':
      return retryDue(probe, nowMs) ? undefined : 'out-of-credit'
    default:
      // An outcome this build does not know is treated as unusable rather than
      // as a candidate: billing through a state we cannot interpret is worse
      // than leaving the account out until a later version explains it.
      return 'unusable'
  }
}

/** Whether a limited account's cooldown has elapsed (or was never stated). */
function retryDue(probe: WorkBuddyPoolProbe, nowMs: number): boolean {
  const until = probe.retryAtMs ?? probe.atMs + POOL_UNKNOWN_COOLDOWN_MS
  return nowMs >= until
}

/**
 * Rank a pool's members best-first.
 *
 * The rule, in priority order — this is the whole feature:
 *
 * 1. **Usability.** Only accounts that can be billed right now are candidates;
 *    they always outrank every excluded one.
 * 2. **Credits, highest first.** Spend the account that has the most, so an
 *    account running low is conserved rather than drained first.
 * 3. **Credits expiring soonest first.** Points about to expire are worth
 *    exactly zero after they do, so using them earlier is strictly better than
 *    saving them.
 * 4. **Freshest credential.** Tie-break so a stale token never wins a draw.
 * 5. **Account id.** Final tie-break, making the order TOTAL: two accounts
 *    equal on every ranking key would otherwise keep the caller's array order,
 *    so the same pool could rotate differently between two runs.
 *
 * Excluded accounts are still RETURNED (sorted after the candidates) so the
 * card can explain why each is out; they differ from candidates by
 * `excludedBy` being set on them, never by being silently dropped.
 *
 * Pure and total: the same input always yields the same order, and it never
 * throws on missing data (an account with no credits is ranked as 0, not
 * crashed on).
 */
export function rankPool(
  members: readonly WorkBuddyPoolMember[],
  nowMs: number,
): WorkBuddyPoolRanked[] {
  const rows = members.map(member => {
    const excludedBy = exclusionOf(member.probe, nowMs)
    return {
      account: member.account,
      score: scoreOf(member),
      ...excludedBy === undefined ? {} : { excludedBy },
      // Ordering keys below the primary score; not part of the public row.
      _usable: excludedBy === undefined,
      _expiring: member.credits?.nearestExpiryMs ?? Number.POSITIVE_INFINITY,
      _tokenExpiresAtMs: member.tokenExpiresAtMs ?? 0,
    }
  })
  rows.sort((left, right) => {
    if (left._usable !== right._usable) return left._usable ? -1 : 1
    if (left.score !== right.score) return right.score - left.score
    if (left._expiring !== right._expiring) return left._expiring - right._expiring
    if (left._tokenExpiresAtMs !== right._tokenExpiresAtMs) {
      return right._tokenExpiresAtMs - left._tokenExpiresAtMs
    }
    // Final key: the account id. Without it, two accounts identical on every
    // ranking key would keep whatever order the caller happened to pass, so
    // the same pool could rotate differently between runs — an instability
    // that makes the feature hard to reason about and impossible to test.
    // Ids are unique, so this makes the order TOTAL.
    return left.account.id < right.account.id ? -1 : left.account.id > right.account.id ? 1 : 0
  })
  return rows.map(({ account, score, excludedBy }) => ({
    account,
    score,
    ...excludedBy === undefined ? {} : { excludedBy },
  }))
}

/**
 * The checked ids that still resolve to a local sign-in, in the caller's order.
 *
 * This is THE definition of "effective members", and it exists because the same
 * predicate was written five separate times: the status document
 * (`web-status.ts`), the batch route's empty-pool guard, the Host dependency the
 * card reads, `poolMemberAccounts` and the browser helper. Five copies of one
 * rule is this project's single most productive bug shape ("fixed one end,
 * missed the other"), so the rule now has one home and every site delegates to
 * it.
 *
 * ORDER IS THE CALLER'S, and comes from `orderedIds`: the answer preserves the
 * order of THAT argument. Callers pass whichever list's order they want to show
 * — the saved list for the user's own order, the store's roster for the account
 * table's. Neither is silently reshuffled by the filter. (The first parameter was
 * once named `saved`, which read as "this must be the saved list" even though
 * `web-status.ts` legitimately passes the roster for store order; the name was
 * the trap, so it now describes the ROLE instead of the source.)
 *
 * Pure, so it is unit-testable without a store, and it never mutates its input.
 */
export function effectiveMembersOf(
  orderedIds: readonly string[],
  listedIds: ReadonlySet<string>,
): string[] {
  return orderedIds.filter(id => listedIds.has(id))
}

/**
 * The account to bill, or undefined when the pool has no usable member.
 *
 * A thin selector over {@link rankPool} so the winner is decided in exactly one
 * place: every caller that needs "who serves now" gets the same answer.
 */
export function pickAccount(
  members: readonly WorkBuddyPoolMember[],
  nowMs: number,
): WorkBuddyPoolAccount | undefined {
  return rankPool(members, nowMs).find(row => row.excludedBy === undefined)?.account
}

/**
 * The credit figure used for ordering.
 *
 * Absent credits rank as zero. Deliberately NOT "unknown ranks first": an
 * account whose balance could not be read must never outrank one we positively
 * know is full, or a failing credits route would capture all the traffic.
 */
function scoreOf(member: WorkBuddyPoolMember): number {
  return member.credits?.total ?? 0
}

/**
 * Pick the free model to test against, from one region's catalog.
 *
 * "Free" means `creditMultiplier === 0` EXACTLY. An absent multiplier is NOT
 * free — see the module note: the CN static fallback carries no multiplier at
 * all, so treating absence as zero would silently bill real credits.
 *
 * Among the free candidates the LARGEST context window wins, because the probe
 * sends a real-sized payload (25k input) and a long-conversation probe is the
 * point: a small-window model would either reject it or answer a question the
 * user never asked.
 *
 * Returns undefined when the region has no free model, which the caller must
 * render as "none available" — never as a fallback to a paid model.
 */
export function pickFreeModel(
  catalog: readonly WorkBuddyModelInfo[],
): WorkBuddyModelInfo | undefined {
  let best: WorkBuddyModelInfo | undefined
  for (const model of catalog) {
    if (model.creditMultiplier !== 0) continue
    if (best === undefined || model.contextWindow > best.contextWindow) best = model
  }
  return best
}

/**
 * A latest-wins guard for one region's asynchronous work.
 *
 * Exists because `applyRotation` awaits (it fetches credits per member), so two
 * overlapping calls can interleave: a slow call that read "rotation is ON" can
 * resume AFTER a newer call cleared the override for "rotation is OFF" and write
 * the stale account back — leaving the card showing the pool switched off while
 * a rotated account is still billed.
 *
 * `begin()` claims a new generation and returns a probe; the caller must check
 * it after EVERY await and bail when it reports stale. Extracted as a pure
 * factory rather than inlined so the rule is unit-testable: an inlined token is
 * only observable by reproducing a real interleaving, which is slow and easy to
 * get subtly wrong (a harness that never actually overlaps passes either way).
 */
export function createLatestWins<Key extends string>(): {
  begin(key: Key): () => boolean
} {
  const generations: Partial<Record<Key, number>> = {}
  return {
    begin(key: Key): () => boolean {
      const generation = (generations[key] ?? 0) + 1
      generations[key] = generation
      return () => generations[key] !== generation
    },
  }
}

/**
 * How often the pool scheduler wakes to check whether a region is due.
 *
 * A fixed, coarse heartbeat rather than one timer per region: the heartbeat
 * itself does no network work (it only reads config and compares timestamps),
 * so it is free, and it makes re-arming on a config change unnecessary — the
 * next tick simply reads the new interval.
 */
export const POOL_TICK_MS = 60_000

/** The smallest interval a schedule may use, matching the config schema. */
export const POOL_MIN_INTERVAL_MINUTES = 5

/**
 * Whether an automatic test is due for one region.
 *
 * `lastRunMs === undefined` means "never armed", and returns FALSE: the clock
 * starts when the scheduler first sees the region, so enabling the pool does
 * not immediately spend credits at startup or after a restart. Waiting one
 * interval is the least surprising reading of "test every N minutes" — the
 * alternative (fire immediately) would bill the user on every launch.
 *
 * Pure and total so the scheduling rule can be pinned without real timers.
 */
export function poolDueAt(input: {
  lastRunMs: number | undefined
  intervalMinutes: number
  nowMs: number
}): boolean {
  if (input.lastRunMs === undefined) return false
  const minutes = Math.max(POOL_MIN_INTERVAL_MINUTES, Math.round(input.intervalMinutes))
  return input.nowMs - input.lastRunMs >= minutes * 60_000
}

/** One region's scheduling inputs. */
export interface PoolScheduleInput<Region extends string> {
  /** The persisted clock: when each region's last scheduled run happened. */
  state: Partial<Record<Region, number>>
  regions: readonly Region[]
  /** Whether the pool is switched on for the region. */
  enabledOf(region: Region): boolean
  /** The region's saved interval, in minutes. */
  intervalMinutesOf(region: Region): number
  nowMs: number
}

/** Which regions are due now, and the clock state to carry forward. */
export interface PoolScheduleResult<Region extends string> {
  /** Regions to run, in the order given. */
  due: readonly Region[]
  /** The clock to store for the next tick. */
  next: Partial<Record<Region, number>>
}

/**
 * Decide which regions a scheduler tick should run.
 *
 * The FIRST sighting of an enabled region ARMS its clock instead of running it.
 * That split is the whole reason this is a function rather than an `if`:
 * {@link poolDueAt} answers "has enough time passed", which is FALSE for a
 * region that has never run — so a scheduler that only armed the clock when it
 * decided to run would never arm it at all, and the scheduled test would
 * silently never fire. Returning the clock state explicitly makes that
 * impossible to get wrong, and testable without real timers.
 *
 * A region that is switched off keeps NO clock: enabling it later must wait a
 * full interval rather than inheriting a stale timestamp and firing at once.
 */
export function duePoolRegions<Region extends string>(
  input: PoolScheduleInput<Region>,
): PoolScheduleResult<Region> {
  const due: Region[] = []
  const next: Partial<Record<Region, number>> = {}
  for (const region of input.regions) {
    if (!input.enabledOf(region)) continue
    const last = input.state[region]
    if (last === undefined) {
      // Arm, do not run.
      next[region] = input.nowMs
      continue
    }
    if (!poolDueAt({
      lastRunMs: last,
      intervalMinutes: input.intervalMinutesOf(region),
      nowMs: input.nowMs,
    })) {
      next[region] = last
      continue
    }
    next[region] = input.nowMs
    due.push(region)
  }
  return { due, next }
}

/**
 * Where the pool's target model came from.
 *
 * `stale` is its own state rather than being folded into `none`: "this region
 * has no free model" and "the model you saved is no longer offered" need
 * opposite advice (refresh the catalog / pick another model), and collapsing
 * them would make the card say the wrong one.
 */
export type WorkBuddyPoolTargetSource = 'preferred' | 'free' | 'none' | 'stale'

/** The resolved target model, and where the choice came from. */
export interface WorkBuddyPoolTarget {
  /**
   * The model a batch may test, present ONLY when it is safe to run.
   *
   * Deliberately ABSENT for `stale`: every existing guard refuses on a missing
   * id, so omitting it means a caller that forgets to check `source` still
   * fails safe instead of spending credits on an unverifiable model.
   */
  modelId?: string
  /** The saved id that could not be resolved; present only for `stale`. */
  staleModelId?: string
  source: WorkBuddyPoolTargetSource
}

/**
 * Resolve the model the pool should test against.
 *
 * A user-specified id always wins (it is a preference, not a computed default),
 * and is returned even when it is a PAID model: the card says so explicitly
 * rather than silently overriding the user's choice.
 *
 * But the choice is now VALIDATED against the region's catalog, because the
 * catalog changes: the CN roster is empty until its first refresh, and models
 * come and go. A saved id that is no longer offered used to be returned as
 * `preferred`, which let the card enable its test button and the Host run a
 * batch against a model nobody offers. It is reported as `stale` instead —
 * never silently replaced by the free model (that would test something the
 * user did not choose) and never run.
 *
 * A catalog that has not loaded yet therefore reads as `stale` for a saved id.
 * That is the safe direction: no credits are spent while the roster is unknown,
 * and the card offers to switch back to automatic.
 */
export function resolveTargetModel(
  catalog: readonly WorkBuddyModelInfo[],
  preferredId: string | undefined,
): WorkBuddyPoolTarget {
  if (preferredId !== undefined && preferredId !== '') {
    return catalog.some(model => model.id === preferredId)
      ? { modelId: preferredId, source: 'preferred' }
      : { staleModelId: preferredId, source: 'stale' }
  }
  const free = pickFreeModel(catalog)
  return free === undefined ? { source: 'none' } : { modelId: free.id, source: 'free' }
}
