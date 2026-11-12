/**
 * One account's availability, described the SAME way everywhere it is shown.
 *
 * The defect this exists to prevent: the pool card and the composer credits
 * panel both list accounts and both answer "can this one be used right now?",
 * but they answered in different words and different colours. The card said
 * "被限流 · 10/19 01:32 之后可再用" with an amber dot; the panel said "被限流"
 * with a grey dot and no time. Two tables, one screen, one measurement, two
 * stories — which teaches the user to trust neither.
 *
 * So the colour and the sentence are defined here, once, and both surfaces call
 * these functions. Anything that needs a new nuance adds it HERE rather than at
 * one call site, because a rule duplicated at two call sites is a rule that
 * will drift.
 */
import type {
  WorkBuddyWebProbeOutcome,
  WorkBuddyWebProbeResult,
  WorkBuddyWebPoolAccount,
  WorkBuddyWebPoolExclusion,
  WorkBuddyWebPoolTestRow,
  WorkBuddyWebUsage,
} from '../status-paths.ts'
import { exclusionOf } from '../account-pool.ts'
import type { Translate } from './searched-paths.ts'
import { recoversInText, remainingText } from './remaining.ts'

/**
 * The slice of an account this module reasons about.
 *
 * Declared structurally rather than as `WorkBuddyWebPoolAccount`, so a caller
 * that only has the credits row can still ask the question. Both properties
 * admit an EXPLICIT `undefined` (the repo compiles with
 * `exactOptionalPropertyTypes`), because a fallback object built from an absent
 * field naturally carries one, and forcing callers to build it conditionally
 * would spread that detail across call sites.
 */
export interface AccountStateInput {
  readonly checkinSupported?: boolean | undefined
  readonly checkedInToday?: boolean | undefined
  readonly enterprise?: boolean | undefined
  readonly excludedBy?: WorkBuddyWebPoolExclusion | undefined
  readonly probe?: {
    readonly outcome: WorkBuddyWebProbeOutcome
    readonly retryAtMs?: number | undefined
  } | undefined
}

/** 积分补充需要实际到账；月度刷新时间不能代表账号必须等待的期限。 */
function creditRecoveryLine(t: Translate, account: AccountStateInput): string | undefined {
  if (account.probe?.outcome !== 'out-of-credit' && account.excludedBy !== 'out-of-credit') return undefined
  const action = account.checkinSupported === true && account.enterprise !== true
    ? account.checkedInToday === true ? 'row.creditCheckinTomorrow'
      : account.checkedInToday === false ? 'row.creditCheckinRetry' : 'row.creditAwaitReplenishment'
    : 'row.creditAwaitReplenishment'
  return `${t('row.poolExcludedOutOfCredit')} · ${t(action)}`
}

/** Whether a probe outcome means the model answered. */
export function outcomeOk(outcome: WorkBuddyWebProbeOutcome): boolean {
  return outcome === 'ok'
}

/**
 * The MARK form of one probe outcome: the verdict alone, for a slot that cannot
 * hold an explanation (issue #108).
 *
 * `outcomeText` is the right function wherever the reader has room — the pool
 * card's probe column, the test log — and there the extra sentence earns its
 * width. The composer panel is a different slot: one line, beside an account
 * name, in a column about 180 px wide. `row.probeChannelRejected` is 88
 * characters in Chinese and 179 in English, so it could never fit; with
 * `nowrap` + `overflow:hidden` on the row it was cut mid-sentence, which the
 * reporter read as broken rendering.
 *
 * So this function returns the SHORT label where one is declared and falls back
 * to {@link outcomeText} otherwise. The full sentence is never lost: the row's
 * `title` carries `availabilityLine`, which keeps every word and the absolute
 * instant, and the pool card still prints it in full.
 */
export function outcomeMarkText(t: Translate, outcome: WorkBuddyWebProbeOutcome): string {
  switch (outcome) {
    // The one outcome whose label is an explanation rather than a verdict.
    case 'channel-rejected': return t('row.probeChannelRejectedShort')
    default: return outcomeText(t, outcome)
  }
}

/** A short, localizable label for one probe outcome. */
export function outcomeText(t: Translate, outcome: WorkBuddyWebProbeOutcome): string {
  switch (outcome) {
    case 'ok': return t('row.probeOk')
    case 'rate-limited': return t('row.poolExcludedRateLimited')
    // Its own label: naming the MODEL as the limited party is the point — the
    // row shows an ACCOUNT, and "被限流" beside an account name is what made
    // issue #56's reporter hunt for a bad account that did not exist.
    case 'model-busy': return t('row.poolExcludedModelBusy')
    case 'out-of-credit': return t('row.poolExcludedOutOfCredit')
    case 'credential-rejected': return t('row.probeCredentialRejected')
    case 'account-restricted': return t('row.probeAccountRestricted')
    // NOT `default` (which reads "✗ 测试失败"): this row is shown next to an
    // ACCOUNT name, and a bare "test failed" invites the account fix that cannot
    // work. The label names the prompt as the thing the gateway refused.
    case 'channel-rejected': return t('row.probeChannelRejected')
    case 'not-found': return t('row.probeNotFound')
    case 'unavailable': return t('row.probeUnavailable')
    default: return t('row.probeFailed')
  }
}

/**
 * `MM/DD, HH:mm` on a 24-hour clock.
 *
 * `hourCycle: 'h23'` is REQUIRED, not decorative: without it `Intl` follows the
 * browser locale's preference, and en-US renders `09/30, 01:23 PM`. A wall-clock
 * glued to "AM/PM" reads as 12-hour no matter what the surrounding UI assumes,
 * and it is the one thing a Chinese user cannot scan past — the card otherwise
 * speaks 24-hour everywhere (see `formatClock`).
 *
 * `h23` rather than `hour12: false`, because the latter maps to `h24` in some
 * engines and would print midnight as `24:00`. `h23` pins 00–23 exactly, which
 * is also the cycle DSH's own timestamps use.
 */
export function formatShortClock(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value))
}

/**
 * The "why can't this serve, and until when" sentence for one account.
 *
 * Returns `undefined` when there is nothing to say — an account with no
 * measurement and no exclusion is simply unknown, and inventing "可用" for it
 * would be a claim nobody made.
 *
 * The retry wording has four states, matching the card's four:
 *  - a stated instant still ahead → "被限流 · 10/19 01:32 之后可再用 · 约 6 小时后"
 *  - a stated instant ALREADY past, on a WAIT-AND-SEE cooldown (rate-limited,
 *    model-busy) → NOTHING at all: no verdict (it has expired), no instant (it is
 *    behind us), and no chore for the reader. The dot already answers the
 *    question, and the card re-tests that one account by itself. Other outcomes
 *    that happen to carry a past instant keep their verdict and drop the instant
 *  - no instant but a timed       → "被限流 · 未提供恢复时间"
 *    exclusion
 *  - any other outcome            → the bare outcome ("连不上上游")
 *
 * That last case is deliberate: "未提供恢复时间" beside a credential rejection
 * would imply waiting helps, when the only fix is signing in again.
 */
export function availabilityLine(
  t: Translate,
  account: AccountStateInput,
  nowMs: number = Date.now(),
): string | undefined {
  const creditLine = creditRecoveryLine(t, account)
  if (creditLine !== undefined) return creditLine
  const probe = account.probe
  if (probe !== undefined) {
    // A SUCCESS is never waiting, whatever time came with it.
    //
    // The stored record can carry `outcome: 'ok'` beside a `retryAtMs` eight
    // days out — that value is the account's monthly quota reset, read off a
    // `Retry-After` header on a 200 — and rendering it through the cooldown
    // sentence produced “✓ 可用 · 11/01 00:00 之后可再用 · 约 8 天后” on a free
    // model that had just answered. The Host heals such records on read, but the
    // sentence must be safe on its own: an `ok` row renders its verdict alone.
    if (probe.outcome === 'ok') return outcomeText(t, probe.outcome)
    if (probe.retryAtMs !== undefined) {
      // The instant AND the wait, in one sentence, derived from the same number.
      //
      // The instant alone answers "when?" but not "how long do I wait?" — the
      // reader has to subtract from the clock in their head, and a time like
      // "01:32" is ambiguous about whether it means tonight or tomorrow. The
      // relative form ("约 9 小时后") answers the actual question.
      //
      // It lives HERE rather than being appended by each caller because the card
      // appended it and the panel did not — the same drift this module exists to
      // stop, one layer down. Assembling a sentence at a call site guarantees the
      // call sites will disagree eventually.
      //
      // Once the moment has passed `remainingText` returns '' and there IS no
      // wait left, but the answer is NOT "the outcome, and the instant it should
      // have recovered at" — that printed 被限流 · 11/08 15:44 之后可再用 about a
      // time already in the past, i.e. a present-tense verdict beside a
      // future-tense date for the same moment. The row says the one state that is
      // actually true then, and the card re-tests this single account on its own
      // (see autoReTest) so the next measurement — not the wording — is what
      // resolves it.
      const left = remainingText(t, probe.retryAtMs, nowMs)
      if (left === '') {
        // AN ELAPSED COOLDOWN SAYS NOTHING — not "awaiting re-check", not the old
        // verdict, not the instant.
        //
        // 「恢复时间已到 · 待复核」 was printed here for a while and the owner
        // rejected it with a screenshot: the row's dot is GREEN (the pool already
        // put this account back among its candidates the moment the instant
        // passed), and a yellow 「待复核」 beside a green dot is the contradiction
        // the wording was meant to remove. Two facts, both true, that read as one
        // wrong one.
        //
        // The state itself has nothing to assert: the last measurement said "not
        // until T", T has passed, and nobody has measured since. Every sentence
        // built from those pieces is either stale ("rate limited") or an
        // instruction ("re-check me") this surface cannot carry out. So it says
        // nothing and lets the dot answer the only question it asks — can this
        // account serve — which the green already answers correctly.
        //
        // A non-cooldown verdict keeps its own words: an exhausted quota or a
        // rejected credential is STILL the reason the account cannot serve, and
        // dropping that would hide the one thing the user has to act on.
        return probe.outcome === 'rate-limited' || probe.outcome === 'model-busy'
          ? undefined
          : outcomeText(t, probe.outcome)
      }
      const at = t('row.poolRetryAt', { at: formatShortClock(probe.retryAtMs) })
      return `${outcomeText(t, probe.outcome)} · ${at} · ${left}`
    }
    // A limited account with NO stated time says exactly that. Rendering the
    // bare outcome would leave the user unable to tell "the upstream gave no
    // time" apart from "this plugin forgot to show it" — and the honest
    // absence is the same contract `cooldownOf()` already keeps.
    if (probe.outcome === 'rate-limited'
      || probe.outcome === 'model-busy'
      || probe.outcome === 'out-of-credit') {
      return `${outcomeText(t, probe.outcome)} · ${t('row.poolRetryUnknown')}`
    }
    // Any other measured outcome keeps its own label. This branch is what makes
    // the function a faithful move of the card's logic: without it a probed
    // account fell through to the exclusion lookup below and rendered as
    // "never tested" — the row contradicting the measurement it was showing.
    return outcomeText(t, probe.outcome)
  }
  // No probe: fall back to the exclusion alone. This happens for an account the
  // Host excluded from another signal, and for a row the pool never measured.
  if (account.excludedBy !== undefined) return exclusionLabel(t, account.excludedBy)
  return undefined
}

/**
 * The SHORT form of the same fact: why the account cannot serve, and how long
 * until it can — without the absolute instant.
 *
 * This exists because the composer's balance panel prints one line per account
 * and the absolute date made every limited row read like a log entry
 * ("被限流 · 10/19, 01:32 之后可再用 · 约 6 小时后") beside a number the row is
 * actually about. The panel keeps the reason and the wait; the pool card keeps
 * the full sentence from {@link availabilityLine}, which is the one place a
 * reader can afford the exact instant.
 *
 * It is a sibling rather than a parameter so the two surfaces cannot half-adopt
 * a flag: the card has no way to reach this function, and the panel has no way
 * to lose the wait.
 */
export function availabilityMark(
  t: Translate,
  account: AccountStateInput,
  nowMs: number = Date.now(),
): string | undefined {
  const creditLine = creditRecoveryLine(t, account)
  if (creditLine !== undefined) return creditLine
  const probe = account.probe
  if (probe !== undefined) {
    // Same rule as {@link availabilityLine}: a success has no wait to state, so
    // a stray instant from an older record must not become “约 8 天后恢复” on a
    // row whose verdict is 可用.
    if (probe.outcome === 'ok') return outcomeMarkText(t, probe.outcome)
    if (probe.retryAtMs !== undefined) {
      // The WAIT, never the instant, and WITH its verb: "被限流 · 约 2 小时后恢复"
      // rather than a bare "约 2 小时后". The duration alone left the reader to
      // guess what happens when it elapses — on a row whose whole job is "can
      // this account serve", the verb is the answer, not the rounding.
      //
      // Once the moment has passed `recoversInText` returns '' — there is no
      // wait left to name. Returning the reason ALONE there was wrong, and the
      // bug was invisible for a whole session: a row whose cooldown expired an
      // hour ago rendered exactly like a row measured a second ago, so
      // 「被限流」 on a seven-hour-old record looked like a live verdict.
      //
      // What is true in that state is narrower than "rate limited": the upstream
      // said it would free up at a time that has NOW PASSED, and nothing has
      // re-measured since. So the line states that instead of repeating the
      // stale verdict — it is the difference between "this is the situation" and
      // "this was the situation, as of the last test".
      //
      // The verdict is NOT prefixed here, and that is the whole point: the first
      // version printed 「被限流 · 限流时段已过 · 重新测试以确认」, three fragments
      // that contradict each other inside one line — a present-tense verdict, a
      // note that it is over, and a chore for the reader. The owner's answer was
      // that the plugin should simply re-test that one account, which is what
      // `autoReTest` in the card does; the row only has to name the moment before
      // the new measurement lands.
      const left = recoversInText(t, probe.retryAtMs, nowMs)
      if (left !== '') return `${outcomeMarkText(t, probe.outcome)} · ${left}`
      // An elapsed cooldown says NOTHING here either, for the reason spelled out in
      // `availabilityLine`: the panel's dot is already green, and the sentence that
      // used to sit beside it contradicted it. A quota refresh or a rejected
      // credential keeps its own reason, because waiting does not clear those.
      return probe.outcome === 'rate-limited' || probe.outcome === 'model-busy'
        ? undefined
        : outcomeMarkText(t, probe.outcome)
    }
    if (probe.outcome === 'rate-limited'
      || probe.outcome === 'model-busy'
      || probe.outcome === 'out-of-credit') {
      return `${outcomeMarkText(t, probe.outcome)} · ${t('row.poolRetryUnknown')}`
    }
    return outcomeMarkText(t, probe.outcome)
  }
  if (account.excludedBy !== undefined) return exclusionLabel(t, account.excludedBy)
  return undefined
}

/**
 * The exclusion's own label, for the case where no probe backs it.
 *
 * Kept private: callers that have a probe must go through `availabilityLine` or
 * `availabilityMark`, so neither surface can invent its own vocabulary for the
 * same measurement.
 */
function exclusionLabel(t: Translate, excludedBy: WorkBuddyWebPoolExclusion): string {
  switch (excludedBy) {
    case 'rate-limited': return t('row.poolExcludedRateLimited')
    case 'model-busy': return t('row.poolExcludedModelBusy')
    case 'out-of-credit': return t('row.poolExcludedOutOfCredit')
    case 'credential-rejected': return t('row.poolExcludedRejected')
    case 'account-restricted': return t('row.poolExcludedAccountRestricted')
    case 'not-found': return t('row.probeNotFound')
    case 'unavailable': return t('row.probeUnavailable')
    case 'failed': return t('row.probeFailed')
    case 'unusable': return t('row.poolExcludedUnusable')
    default: return t('row.poolExcludedUnusable')
  }
}

/**
 * The dot's state as a class suffix, so CSS can colour it without inline styles.
 *
 * `error` is separate from `warn` because the advice differs: one means "wait",
 * the other means "do something".
 */
export function stateTone(account: AccountStateInput, nowMs: number = Date.now()): 'ok' | 'warn' | 'error' | 'unknown' {
  // AN ELAPSED COOLDOWN WITH NOTHING MEASURED SINCE IS 'unknown', not 'warn'.
  //
  // This is the same state `availabilityLine` now renders as NOTHING, and the two
  // have to agree or the row contradicts itself in the other direction: a red dot
  // beside a blank line asserts "this account cannot serve" and then declines to
  // say why. It also contradicts the POOL, which re-admits such an account the
  // moment the instant passes (`exclusionOf` returns undefined then) — so the dot
  // would report a refusal the pool has already lifted.
  //
  // Grey is this module's own word for "nobody has measured": painting it green
  // would assert a health nobody checked, and red a failure nobody saw. The card
  // re-tests the account by itself, so the honest reading lasts about one request.
  const probe = account.probe
  if (probe !== undefined
    && probe.retryAtMs !== undefined
    && probe.retryAtMs <= nowMs
    && (probe.outcome === 'rate-limited' || probe.outcome === 'model-busy')) {
    return account.excludedBy === undefined ? 'unknown' : 'warn'
  }
  if (account.excludedBy !== undefined) {
    return account.excludedBy === 'rate-limited'
      || account.excludedBy === 'model-busy'
      || account.excludedBy === 'unavailable'
      ? 'warn'
      : 'error'
  }
  if (account.probe === undefined) return 'unknown'
  return outcomeOk(account.probe.outcome) ? 'ok' : 'warn'
}

/**
 * The tone as a CSS colour variable.
 *
 * Derived from `stateTone` rather than repeating its branches: an inlined copy
 * would be a second definition of the rule, free to drift the first time one is
 * edited. The pool table draws a dot from a computed colour, so it needs a value
 * rather than a class name.
 */
export function stateColor(account: AccountStateInput, nowMs: number = Date.now()): string {
  switch (stateTone(account, nowMs)) {
    case 'ok': return 'var(--dsw-alias-state-success-primary, #22a06b)'
    case 'warn': return 'var(--dsw-alias-state-warn-primary, #f59e0b)'
    case 'error': return 'var(--dsw-alias-state-error-primary, #ef4444)'
    default: return 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  }
}

/**
 * Read one line of the test batch's stream as a test row.
 *
 * The stream is `{ action, modelId }`, then one `{ row }` per account, then
 * `{ done: true }` — or `{ reason, error }` when the batch itself broke. Only the
 * row shape is recognized here; the rest is the caller's business.
 *
 * Every field is validated rather than trusted. This parses a wire the panel did
 * not write, and a half-shaped row reaching the component's state would render
 * as a measurement nobody took — worse than ignoring the line, because the
 * subsequent re-read is what would have quietly corrected it.
 */
export function testRowOf(line: Record<string, unknown>): WorkBuddyWebPoolTestRow | undefined {
  const raw = line['row']
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  const accountId = row['accountId']
  const name = row['accountName']
  const rawResult = row['result']
  if (typeof accountId !== 'string' || accountId === '') return undefined
  if (typeof rawResult !== 'object' || rawResult === null) return undefined
  const result = probeResultOf(rawResult as Record<string, unknown>)
  if (result === undefined) return undefined
  return {
    accountId,
    // A row without a name still identifies its account: falling back to the id
    // keeps a real measurement instead of discarding it over a missing label.
    accountName: typeof name === 'string' && name !== '' ? name : accountId,
    result,
  }
}

/** The probe result inside a test row, when it is complete enough to render. */
function probeResultOf(raw: Record<string, unknown>): WorkBuddyWebProbeResult | undefined {
  const outcome = raw['outcome']
  const modelId = raw['modelId']
  // `modelId` is REQUIRED, not optional politeness: the pool tests ONE model per
  // region, and an outcome without the model it measured is the account-level
  // claim issue #61 exists to stop the card from making.
  if (typeof outcome !== 'string' || !isProbeOutcome(outcome)) return undefined
  if (typeof modelId !== 'string') return undefined
  const elapsedMs = raw['elapsedMs']
  const status = raw['status']
  const message = raw['message']
  const retryAtMs = raw['retryAtMs']
  const retrySource = raw['retrySource']
  return {
    modelId,
    outcome,
    ...(typeof elapsedMs === 'number' ? { elapsedMs } : {}),
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof message === 'string' ? { message } : {}),
    ...(typeof retryAtMs === 'number' ? { retryAtMs } : {}),
    ...isRetrySource(retrySource) ? { retrySource } : {},
  }
}

/** The outcome vocabulary, as a value — the type alone cannot be tested against a wire. */
const PROBE_OUTCOMES: readonly WorkBuddyWebProbeOutcome[] = [
  'ok',
  'rate-limited',
  'model-busy',
  'out-of-credit',
  'credential-rejected',
  'policy-rejected',
  'account-restricted',
  'channel-rejected',
  'unavailable',
  'not-found',
  'failed',
]

function isProbeOutcome(value: string): value is WorkBuddyWebProbeOutcome {
  return (PROBE_OUTCOMES as readonly string[]).includes(value)
}

function isRetrySource(value: unknown): value is NonNullable<WorkBuddyWebProbeResult['retrySource']> {
  return value === 'retry-after'
    || value === 'upstream-message'
    || value === 'quota-refresh'
    || value === 'upstream-tips'
}

/**
 * Fold ONE streamed test row into the usage document the panel is rendering.
 *
 * Why fold at all, when the batch is followed by a re-read: the batch is SERIAL
 * and a stuck member can take seconds, so a panel that changes nothing until the
 * LAST account answers is exactly the dead-looking button the streamed batch was
 * built to avoid. Folding each row as it lands makes the row change the moment
 * its measurement exists; the re-read afterwards then replaces the fold with the
 * same facts, this time from the Host's own store.
 *
 * The exclusion is RE-DERIVED here rather than left as it was: it is derived
 * state (`exclusionOf`), so copying the previous one forward would keep a
 * just-measured-good account red until the re-read — and would keep a
 * just-measured-limited one green, which is the more expensive error.
 */
export function withTestRow(
  usage: WorkBuddyWebUsage,
  row: WorkBuddyWebPoolTestRow,
  nowMs: number,
): WorkBuddyWebUsage {
  if (!('pool' in usage) || usage.pool === undefined) return usage
  const pool = usage.pool
  const index = indexOfTestedAccount(pool.accounts, row)
  if (index === undefined) return usage
  const measured = pool.accounts[index]
  if (measured === undefined) return usage
  // Dropped rather than overwritten: `exclusionOf` may now say "usable", and
  // leaving the field out is the only way to say that on a type whose property
  // admits no `undefined` under `exactOptionalPropertyTypes`.
  const { excludedBy: _previous, ...account } = measured
  const probe = {
    outcome: row.result.outcome,
    atMs: nowMs,
    source: 'test-batch' as const,
    modelId: row.result.modelId,
    ...(row.result.retryAtMs === undefined ? {} : { retryAtMs: row.result.retryAtMs }),
    ...(row.result.message === undefined ? {} : { message: row.result.message }),
  }
  const excludedBy = exclusionOf(probe, nowMs)
  const folded: WorkBuddyWebPoolAccount = {
    ...account,
    probe,
    ...(excludedBy === undefined ? {} : { excludedBy }),
  }
  const accounts = pool.accounts.map((candidate, at) => (at === index ? folded : candidate))
  return { ...usage, pool: { ...pool, accounts } }
}

/**
 * Which listed account a test row measured, or `undefined` when it measured none
 * of them.
 *
 * Matched by ID first. The NAME is only a fallback for a row whose id this
 * document no longer lists, and only when exactly one listed account carries it:
 * two accounts sharing a name must never have one measurement written onto both.
 */
function indexOfTestedAccount(
  accounts: readonly WorkBuddyWebPoolAccount[],
  row: WorkBuddyWebPoolTestRow,
): number | undefined {
  const byId = accounts.findIndex(account => account.accountId === row.accountId)
  if (byId >= 0) return byId
  const matches = accounts.flatMap((account, at) => (account.accountName === row.accountName ? [at] : []))
  return matches.length === 1 ? matches[0] : undefined
}
