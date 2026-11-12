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

/**
 * Which of the pool's writers produced a measurement.
 *
 * `test-batch` — the user pressed "test" (or the check-in batch), so the
 *   outcome is a deliberate measurement of the target model.
 * `live-request` — a real chat request failed and its failure was recorded so
 *   the NEXT request starts from a measurement instead of rediscovering the
 *   same wall.
 *
 * The distinction is diagnostic, not behavioural: both feed the same routing
 * and cooling logic. It exists so a user who watched an account measure `ok`
 * and later saw it limited can tell whether that was a later live failure
 * (expected) or an older value winning (a bug).
 */
export type WorkBuddyPoolProbeSource = 'test-batch' | 'live-request'

/** One account's pool entry: what the picker needs, plus its last measurement. */
export interface WorkBuddyPoolAccount {
  /** Stable account id (the same one `WorkBuddyAccountChoice` carries). */
  id: string
  /** Human name, or `''` when the desktop app recorded none. */
  accountName: string
  /**
   * This account belongs to an enterprise/education tenant (issue #124/#129).
   *
   * A projection fact, carried from the credential's `enterpriseId` rather than
   * inferred from any benefit or check-in response: upstream can advertise
   * campaigns and `active:false` for enterprise members while refusing every
   * write with `10001`.
   */
  enterprise?: boolean
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
   * WHAT WROTE THIS MEASUREMENT.
   *
   * Two sites write probes for the same account, and before this field they
   * were indistinguishable in the file — which made a real confusion
   * unanswerable: the user presses "test", sees an account measured `ok`, and
   * later finds it `rate-limited`. Nothing in the record said whether that was
   * a NEWER measurement (a live request really did hit the limit) or an OLDER
   * one somehow winning, and the file keeps no history to tell them apart.
   *
   * With the source recorded, that question has an answer on sight: a
   * `live-request` entry that replaced a `test-batch` result is the pool
   * working as designed (a live failure steers the next request away from the
   * account); two entries of the SAME source with the OLDER one winning would
   * be a genuine bug.
   *
   * ABSENT for any measurement written before this field existed, so old probe
   * files stay readable — an absent source means "unknown", never a guess.
   */
  source?: WorkBuddyPoolProbeSource
  /**
   * The upstream's reset timestamp, interpreted according to the outcome.
   *
   * Present for a `rate-limited` outcome whose failure body carried a reset
   * sentence, and for an `out-of-credit` outcome with a known quota refresh.
   * For credit exhaustion this is package metadata, not a minimum wait or
   * proof of replenishment; later positive balance evidence clears the failure.
   * ABSENT when the upstream named no time — that absence is meaningful and
   * must never be turned into a locally invented countdown.
   */
  retryAtMs?: number
  /**
   * The upstream's own words on the failure, already redacted.
   *
   * Kept so the card can say WHY an account left the pool instead of repeating
   * one generic sentence for a DNS failure, a gateway 502 and a request the user
   * cancelled alike. Those three used to render as the SAME line, which left the
   * user with a message they could not act on and no way to tell a broken
   * account from a broken network.
   *
   * ABSENT for a success, and for any measurement written before this field
   * existed: an `outcome` without a `message` is a complete, valid record, so
   * old probe files stay readable rather than being discarded.
   */
  message?: string
  /**
   * WHICH MODEL this measurement is about (issue #61).
   *
   * The pool's "test all accounts" action probes ONE model — the region's
   * `targetModelId` — while `6004` is an ACCOUNT × MODEL condition: the reporter
   * measured two accounts where `hy4-preview-f` answered and `step-5-preview`
   * returned `429 / 6004` at the same moment. A row rendered as plain "可用"
   * therefore claims more than the measurement says, and the pool's own routing
   * reads that `ok` as an account-level fact.
   *
   * Storing the model id is what makes the claim checkable: the card can say
   * WHICH model an `ok` came from, and a reader can see that a different model
   * was never tested at all. `probeModel()` has always returned this field; the
   * write simply dropped it.
   *
   * Deliberately NOT inherited by {@link mergePoolProbe} when an update omits it
   * — the opposite of `accountName` and `retryAtMs`. Those two describe the
   * ACCOUNT (a name that a later writer could not see is still true, and a
   * future refresh time is still in the future), whereas the model describes
   * THIS measurement. Carrying an older model id forward would relabel a fresh
   * measurement with a model it was not taken on, which is exactly the confusion
   * this field exists to end. ABSENT therefore means "unknown scope", never a
   * guess.
   */
  modelId?: string
  /**
   * The account's display name AT THE MOMENT IT WAS MEASURED (issue #60).
   *
   * Stored because a saved pool member can outlive its sign-in. Once the
   * desktop app drops a login, that id resolves to no listed account, so the
   * card has nothing left to render for it — and the old warning ("1 saved
   * account is no longer signed in") was a count with no subject, leaving the
   * user unable to tell WHICH account had gone. The name was in hand at write
   * time (both writers already carry it) and nowhere afterwards, so the record
   * is the only place it can survive.
   *
   * ABSENT on records written before this field existed, and when the desktop
   * app recorded no name: the card then falls back to a short id prefix rather
   * than inventing a label. Snapshots are never refreshed from a LISTING — only
   * a real measurement writes this, so a stale name cannot be "confirmed" by a
   * routine scan that never saw the account.
   */
  accountName?: string
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
  | 'model-busy'
  | 'out-of-credit'
  | 'credential-rejected'
  /**
   * The upstream restricted this credential for unusual activity (issue #127).
   *
   * Unlike `policy-rejected`, this is an account-level decision. Another
   * account may serve and this one should not be billed again until the user
   * re-authenticates or appeals successfully.
   */
  | 'account-restricted'
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
 * How long an account stays out of the pool when the upstream stated no time.
 *
 * A conservative FALLBACK, not a measurement: it applies whenever a failed
 * outcome carries no `retryAtMs`, which is every rate limit that came without a
 * reset sentence AND every transient failure (a transport error, a 5xx). In both
 * cases "when can I use this again" has no honest answer.
 *
 * The two failure directions it avoids: keeping the account in the pool would
 * re-bill it immediately and re-trip the same limit; dropping it FOREVER would
 * discard a working account over an event that said nothing about it. A short,
 * stated cooldown is the least-wrong of the two — and it is what lets the pool
 * heal itself, since nothing else re-probes an excluded member.
 */
export const POOL_UNKNOWN_COOLDOWN_MS = 30 * 60_000

/**
 * How long a MODEL-scoped throttle benches its account.
 *
 * Short on purpose, and THIS is the fix for issue #56.
 *
 * `model_busy` (upstream 14003) is not a statement about the account at all: it
 * is the model's own load, and the reporter's measurement shows the same
 * credential answering other models at the same second. Benching the account for
 * the generic half-hour fallback therefore did three wrong things at once:
 *
 * 1. It waited 30x longer than the upstream's own advice ("wait about a
 *    minute").
 * 2. It benched EVERY account, because failover walked the pool and each member
 *    hit the same model-level wall — so the user could not talk to the model at
 *    all for half an hour.
 * 3. It taught the pool a false fact about each account, overwriting a good
 *    `test-batch` measurement with a `live-request` failure that said nothing
 *    about the account.
 *
 * The value is deliberately the same order as {@link MODEL_BUSY_COOLDOWN_MS} in
 * `src/probe.ts`, but it is NOT imported from there: this module is deliberately
 * dependency-light (it is the pure ranking rule), and a cooldown that a probe
 * writes and a ranking reads must not be able to drift by a refactor of either
 * file. A unit test pins the two together instead.
 */
export const MODEL_BUSY_COOLDOWN_MS = 2 * 60_000

/**
 * Whether one account can be billed at `nowMs`.
 *
 * Returns the exclusion reason, or undefined when the account is a candidate.
 * The order matters and is NOT arbitrary:
 *
 * - A `credential-rejected` account is excluded regardless of any cooldown: its
 *   token is not accepted, so waiting cannot help and the user must re-auth.
 * - A limited, unreachable or failed outcome is checked against its stated (or
 *   fallback) cooldown, so an account whose limit has already reset — or whose
 *   gateway blipped once — is back in the pool without needing another test
 *   first.
 * - An `ok` measurement, and no measurement at all, are both candidates. The
 *   latter matters: a freshly discovered account has never been tested and must
 *   not be invisible.
 *
 * WHY TRANSIENT OUTCOMES GET A COOLDOWN. They are not statements about the
 * ACCOUNT. A transport failure can be a DNS blip, and — before the shim learned
 * to skip reporting an aborted request — it was routinely the user closing the
 * panel mid-flight. A 5xx is the gateway's afternoon, not this account's health.
 * Excluding them permanently meant one transient event idled a perfectly good
 * account until the user happened to press "test" again, and with every member
 * so idled the pool had no candidate at all: failover then had nowhere to go and
 * the raw upstream error was reported as-is. The cooldown is what makes the pool
 * RECOVER instead of staying broken.
 *
 * `not-found` and `credential-rejected` deliberately get none: one describes a
 * model the region no longer offers (a catalog fact, not a transient one) and
 * the other needs the user to sign in again. Neither is fixed by waiting, and
 * pretending otherwise would re-bill a token the upstream has already refused.
 *
 * Each unusable outcome keeps its OWN value rather than being folded into
 * `credential-rejected`. The fold made one row state two contradictory things —
 * the name column said "被拒绝" (sign in again) while the probe column, reading
 * the same measurement, said "连不上上游——这是网络问题，不是模型问题" — and it
 * told a user whose upstream had merely blipped that their sign-in was bad.
 * (That label has since been made cause-NEUTRAL: it used to assert "not the
 * model" for a bucket that also holds gateway 5xx and request timeouts, where
 * the claim is simply unfounded. The recorded `message` now carries the cause.)
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
    case 'account-restricted':
      // The upstream explicitly identifies this credential as restricted, so a
      // cooldown cannot repair it: the user must re-auth/appeal. Keep it out of
      // failover rather than rotating through every known dead account (issue
      // #127).
      return 'account-restricted'
    case 'not-found':
      return 'not-found'
    case 'unavailable':
      return retryDue(probe, nowMs) ? undefined : 'unavailable'
    case 'failed':
      return retryDue(probe, nowMs) ? undefined : 'failed'
    case 'rate-limited':
      return retryDue(probe, nowMs) ? undefined : 'rate-limited'
    case 'model-busy':
      // The model is loaded, not the account. It STILL leaves the pool — a
      // request billed to it right now would hit the same wall — but on its own
      // short clock ({@link MODEL_BUSY_COOLDOWN_MS}), never the half-hour
      // fallback that turned one busy minute into a pool-wide outage.
      //
      // NOT a permanent candidacy either: returning `undefined` here (the
      // treatment `policy-rejected` gets) would make failover re-try the same
      // account against a model known to be refusing it, which is exactly the
      // "walk every member into the same wall" behaviour issue #56 reports.
      return retryDue(probe, nowMs, MODEL_BUSY_COOLDOWN_MS) ? undefined : 'model-busy'
    case 'out-of-credit':
      // Time alone cannot establish that check-in or purchased credits arrived.
      // A later positive balance reading clears the recorded failure.
      return 'out-of-credit'
    case 'policy-rejected':
      // NOT the `default` branch. A content-policy refusal is a fact about ONE
      // REQUEST, not about the account: the server refused that message's
      // content, and the same account will happily serve a different one. It is
      // therefore a candidate, exactly like `ok` — benching it would idle a
      // healthy account over a single tripped filter, which is the failure the
      // transient-outcome note above exists to prevent (and worse here, since
      // the user's next request may well be perfectly acceptable).
      //
      // The measurement is still recorded, so the card can explain what
      // happened; it just must not remove the account from the pool.
      return undefined
    case 'channel-rejected':
      // Same treatment as `policy-rejected`, for the same structure of fact: the
      // gateway refused the PROMPT, and every account sends that same prompt, so
      // none of them is a better candidate. Benching this one would remove an
      // account that has nothing wrong with it — and hide the real remedy
      // (change the prompt, not the account).
      return undefined
    default:
      // An outcome this build does not know is treated as unusable rather than
      // as a candidate: billing through a state we cannot interpret is worse
      // than leaving the account out until a later version explains it. It keeps
      // the no-cooldown treatment too — a state we cannot read is not one we
      // should re-enter on a timer.
      return 'unusable'
  }
}

/**
 * Whether an account's cooldown has elapsed (or was never stated).
 *
 * Transient failures without a stated retry time use the local short window.
 * Credit exhaustion is cleared by later positive balance evidence or an explicit
 * successful pool test; ordinary chat success does not update the probe store.
 * It does not call this helper.
 *
 * `fallbackMs` lets one outcome carry a SHORTER clock than the generic one: the
 * model-scoped throttle is upstream's own "about a minute", and applying the
 * half-hour account fallback to it is issue #56. It is a parameter rather than a
 * second function so every outcome keeps sharing one definition of "due".
 */
function retryDue(
  probe: WorkBuddyPoolProbe,
  nowMs: number,
  fallbackMs: number = POOL_UNKNOWN_COOLDOWN_MS,
): boolean {
  const until = probe.retryAtMs ?? probe.atMs + fallbackMs
  return nowMs >= until
}

/**
 * When an EXCLUDED account becomes a candidate again, in epoch ms.
 *
 * Same arithmetic as {@link retryDue} — deliberately, so the two can never
 * disagree about when an account is back: this answers "at what instant", that
 * one answers "is that instant past". Two separate clocks would let the card
 * say "recovers at 14:05" while the ranking still refuses it at 14:06.
 *
 * `Infinity` when time cannot fix the account: a rejected token and a
 * restricted or banned account are states a cooldown cannot repair, so they
 * sort after everything that merely has to wait (`exclusionOf` gives them no
 * cooldown at all — this mirrors that, rather than inventing one).
 */
function recoversAtOf(
  probe: WorkBuddyPoolProbe | undefined,
  excludedBy: WorkBuddyPoolExclusion,
  fallbackMs: number = POOL_UNKNOWN_COOLDOWN_MS,
): number {
  if (probe === undefined) return Number.POSITIVE_INFINITY
  switch (excludedBy) {
    case 'rate-limited':
    case 'unavailable':
    case 'failed':
      return probe.retryAtMs ?? probe.atMs + fallbackMs
    case 'model-busy':
      return probe.retryAtMs ?? probe.atMs + MODEL_BUSY_COOLDOWN_MS
    // `out-of-credit` gets a date here even though the exclusion does not clear
    // on the clock: `retryAtMs` for it is package metadata (when the allowance
    // resets), which is exactly the "when might this be usable" fact the card
    // wants to show. It does NOT become a candidate at that instant — a later
    // positive balance read does that (`exclusionOf` says so).
    case 'out-of-credit':
      return probe.retryAtMs ?? Number.POSITIVE_INFINITY
    default:
      return Number.POSITIVE_INFINITY
  }
}

/**
 * Rank a pool's members best-first.
 *
 * The rule, in priority order — this is the whole feature:
 *
 * 1. **Usability.** Only accounts that can be billed right now are candidates;
 *    they always outrank every excluded one.
 * 2. **Expiring credits first, soonest first.** Points about to expire are
 *    worth exactly zero after they do, so spending them before they lapse is
 *    strictly better than saving them.
 * 3. **User's manual order.** When the user has hand-ordered the pool (see
 *    `orderAccountIds`), that order breaks ties among accounts that are equal
 *    on the keys above AND below. It is the one place the user's own preference
 *    influences "who serves next": the manual picker on the card drags these
 *    ids into place, and the ranking honors the result.
 *    WHY EXPIRY STILL OUTRANKS THE MANUAL ORDER: this rule sits strictly BELOW
 *    the at-risk flag (rule #2), so an account with ANY expiring credits always
 *    beats the manual order even when the user dragged it to the bottom. That
 *    is deliberate (issue #70): a manual order that is unsaved, stale, or
 *    sloppily edited must never cause credits to lapse unspent — expiring
 *    credits are real money about to vanish, while the manual order is just a
 *    preference that might be wrong. This is not a bug, and a test pins it.
 * 4. **Largest expiring amount.** Between two accounts that both have expiring
 *    points, the one with more at risk goes first.
 * 5. **Credits, highest first.** Among accounts with nothing expiring, spend the
 *    one with the most, so a nearly-drained account is conserved.
 * 6. **Freshest credential.** Tie-break so a stale token never wins a draw.
 * 7. **Account id.** Final tie-break, making the order TOTAL: two accounts
 *    equal on every ranking key would otherwise keep the caller's array order,
 *    so the same pool could rotate differently between two runs.
 *
 * WHY EXPIRY OUTRANKS SIZE (issue #70). These used to be strict lexicographic
 * keys: total, THEN expiry. Since totals are almost never exactly equal, the
 * expiry rule was unreachable — a live report had an account with 196 points
 * lapsing that day ranked LAST, behind two accounts that expire weeks later,
 * simply because it held ~1,200 fewer points overall. It was never selected, so
 * the 196 points always lapsed. A "use it or lose it" rule that another rule
 * completely shadows is not a tie-break, it is dead code.
 *
 * WHY SPENDING THE SMALL EXPIRING ACCOUNT IS STILL RIGHT. Ordering by expiry
 * does mean an account with 1 point lapsing outranks one holding 50,000. That
 * looks wrong and is not: credits are fungible, so using the rich account
 * instead does not preserve the 1 point — it spends the 1 point's chance and
 * loses it. Using the expiring account spends a point that was going to be lost
 * anyway, and the rich account is still there for the next request. The only
 * real cost is a failover round-trip if the expiring account cannot cover a
 * whole request, which the exclusion/failover path already absorbs. Ordering by
 * total instead loses the expiring points with certainty.
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
  orderAccountIds?: readonly string[],
): WorkBuddyPoolRanked[] {
  // The user's manual order, as a position lookup so missing ids (and accounts
  // never listed) map consistently to "sorted last". Position 0 is "first".
  // Duplicate ids keep the FIRST occurrence's position — hand lists often have
  // a stray duplicate, and whichever the user intended first must win.
  const order = new Map<string, number>()
  for (const [index, id] of (orderAccountIds ?? []).entries()) {
    if (!order.has(id)) order.set(id, index)
  }
  const rows = members.map(member => {
    // A zero balance does not rule out free models. Keep this verdict identical
    // to the panel and shortfall explanation: only a recorded failure excludes.
    const excludedBy = exclusionOf(member.probe, nowMs)
    return {
      account: member.account,
      score: scoreOf(member),
      ...excludedBy === undefined ? {} : { excludedBy },
      // Ordering keys below the primary score; not part of the public row.
      _usable: excludedBy === undefined,
      // The user's manual order position; Infinity = not listed = sorted last.
      _order: order.get(member.account.id) ?? Number.POSITIVE_INFINITY,
      // Whether ANYTHING lapses within the window, and how much.
      //
      // `expiringSoon` is the amount (credits); `nearestExpiryMs` is a
      // timestamp. Comparing them directly would be a units error, so they
      // stay two separate keys: `_expiring` now means "has something at risk"
      // (the old key reused the name for the raw timestamp, which is why the
      // amount was never consultable at all).
      _atRisk: (member.credits?.expiringSoon ?? 0) > 0,
      _expiringAmount: member.credits?.expiringSoon ?? 0,
      _expiring: member.credits?.nearestExpiryMs ?? Number.POSITIVE_INFINITY,
      _tokenExpiresAtMs: member.tokenExpiresAtMs ?? 0,
      // When this account becomes a candidate again (issue #240).
      //
      // Only meaningful for EXCLUDED rows, and only as a DISPLAY order among
      // them: it is computed here so the card can list "the one that comes back
      // soonest" first, which is the half of the reporter's rule 2 that the
      // ranking can honestly answer. It deliberately does not change who
      // SERVES: an excluded row is not a candidate at any position, and when
      // its cooldown elapses `exclusionOf` drops the exclusion and the ordinary
      // credit keys decide — so "prefer the account that recovers first" is
      // expressed as "it is at the top of the table and explains why", not as a
      // sticky preference.
      //
      // Infinity for a candidate and for an account with no stated recovery
      // time: `undefined` here means "nobody can say", and inventing a number
      // would put an account in a position the plugin cannot justify.
      _recoversAt: excludedBy === undefined ? Number.POSITIVE_INFINITY : recoversAtOf(member.probe, excludedBy),
    }
  })
  rows.sort((left, right) => {
    if (left._usable !== right._usable) return left._usable ? -1 : 1
    // Among two EXCLUDED accounts: whichever recovers soonest goes first, then
    // the richer one (issue #240).
    //
    // This only ever orders rows that cannot serve — `pickAccount` and the
    // failover loop skip every `excludedBy !== undefined` row before reading
    // its position — so it changes the TABLE, not who is billed. That is the
    // honest scope: the reporter's "prefer the account with the shortest
    // remaining cooldown" cannot mean "bill it", because a cooling account
    // refuses by definition. What it can mean is that the account about to come
    // back is the one at the top of the list, saying so, instead of being
    // buried wherever the credit keys left it.
    //
    // Above `_order` deliberately: a manual rank on a row that cannot serve
    // conveys nothing, and the user's complaint is precisely that they had to
    // hand-sort to get a sensible order. Usable rows are unaffected — both
    // sides carry `Infinity` there and the branch never runs.
    if (!left._usable && !right._usable && left._recoversAt !== right._recoversAt) {
      return left._recoversAt - right._recoversAt
    }
    // Expiring credits before anything else among usable accounts (issue #70).
    if (left._atRisk !== right._atRisk) return left._atRisk ? -1 : 1
    // The user's manual order, only among accounts equal on usability & the
    // at-risk flag — see the doc note about why expiry still outranks it.
    if (left._order !== right._order) return left._order - right._order
    // Both at risk: whichever lapses FIRST goes first.
    if (left._atRisk && right._atRisk && left._expiring !== right._expiring) {
      return left._expiring - right._expiring
    }
    // Same expiry (or neither at risk): the larger amount at stake wins, which
    // for accounts with nothing expiring falls through to total credits.
    if (left._expiringAmount !== right._expiringAmount) {
      return right._expiringAmount - left._expiringAmount
    }
    if (left.score !== right.score) return right.score - left.score
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
  orderAccountIds?: readonly string[],
): WorkBuddyPoolAccount | undefined {
  return rankPool(members, nowMs, orderAccountIds).find(row => row.excludedBy === undefined)?.account
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
 * WHY THERE IS NO SCHEDULER HERE.
 *
 * This module used to carry `POOL_TICK_MS`, `poolDueAt` and `duePoolRegions` for
 * an automatic re-test timer. That timer was removed as a product decision
 * (`8c17fef`): rotation is a PERSISTENT change of who pays while failover is a
 * PER-REQUEST borrow of another account, and having both made "who is being
 * billed right now" unanswerable on one card.
 *
 * The pure helpers were left behind and kept green by their own unit tests —
 * this project's most misleading kind of dead weight, because the suite asserted
 * a capability the shipped plugin no longer had. "All tests pass" then said
 * nothing about whether an account ever came back.
 *
 * Recovery is expressed as the cooldown in {@link exclusionOf} instead, which
 * needs no timer: it is evaluated at ranking time, so a cooled-down member simply
 * becomes a candidate again on the next request.
 */

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
