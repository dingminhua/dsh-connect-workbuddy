/**
 * Presentation rules for the signed-out card's probed-path list.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 「未登录时把探测过的路径与失败原因列给用户，而不是只说一句 not signed
 *     in」这一做法来自该项目（`auth.ts` 的 `diagnose()` →
 *     `TraeUsageCard` 的 `<details>` 块）。此处沿用其思路。
 * 改动：1. 原因多一档 `encrypted`（见下）；
 *   2. 探测结果按「值得先看 / 只是不存在」分组，而不是全部平铺 ——
 *      普通机器上多数候选路径都是「不存在」，平铺会把真正解释失败的那一条
 *      淹掉；trae 的 `row.searchedMore` 文案定义了却从未接上，这里真正实现。
 *
 * Kept out of `WorkBuddyCard.tsx` — and free of any browser-only import — so the
 * grouping and labelling rules can be unit-tested directly. The card is a
 * `.tsx` component whose module graph pulls DSH's browser packages, which cannot
 * load in the Node test environment (there is no jsdom or react-dom here); the
 * rules below are exactly the part that must not go untested.
 *
 * @module dsh-connect-workbuddy/client/searched-paths
 */

import type { WorkBuddyWebSearchPath } from '../status-paths.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

/** Localized copy lookup, with optional interpolation. */
export type Translate = (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string

/**
 * Reasons that explain a failure, as opposed to merely recording an absence.
 *
 * `missing` is the normal state of most candidates on any machine — the app
 * writes one file while the platform offers several possible directories — so
 * it is the one reason that gets hidden by default. Everything else is a real
 * finding: the file is there and unreadable, present but not a credential, or
 * present and encrypted without a key.
 *
 * `encrypted` is WorkBuddy-specific and the most important of the three: the
 * user is very likely signed in already, and the plugin simply cannot open the
 * token fields without the desktop app present. "Sign in again" is the one
 * action that cannot help, so this reason must never be hidden behind a toggle.
 *
 * `wrong-region` is equally a finding and equally actionable: the sign-in is
 * real and readable, it just belongs to the other tab. That is why it must be
 * shown up front — hidden among the absences it would look like "nothing here",
 * when it is in fact the whole explanation, and the cheapest possible fix.
 */
export const INTERESTING_REASONS: readonly WorkBuddyWebSearchPath['reason'][]
  = ['encrypted', 'invalid', 'unreadable', 'wrong-region']

/** How one probed-path list should be presented. */
export interface SearchedView {
  /** Findings that explain the failure; always shown. */
  interesting: readonly WorkBuddyWebSearchPath[]
  /** Candidates that were simply absent; shown behind a toggle when possible. */
  missing: readonly WorkBuddyWebSearchPath[]
  /**
   * Whether the absent list starts open.
   *
   * When nothing interesting was found, the absent list IS the explanation
   * (the user needs to see where we looked so they can point the plugin
   * somewhere else), so it opens directly instead of hiding the entire answer
   * behind a second click.
   */
  missingOpen: boolean
  /** Total probed entries, for the summary label. */
  total: number
}

/**
 * Partition one region's probe failures for display.
 *
 * Order within each group is preserved from the Host: the store reports
 * candidates in probe order, which is meaningful (the live file before its
 * timestamped backups).
 *
 * There is deliberately no `encrypted` flag here. There used to be, for a
 * notice rendered inside the list; that notice is gone because
 * {@link signedOutNotice} now answers the encrypted cause in the paragraph, so
 * the flag would have had no consumer — and a derived field kept "just in
 * case" is how the list and the paragraph drift apart again.
 */
export function searchedView(items: readonly WorkBuddyWebSearchPath[]): SearchedView {
  const interesting = items.filter(item => INTERESTING_REASONS.includes(item.reason))
  const missing = items.filter(item => !INTERESTING_REASONS.includes(item.reason))
  return {
    interesting,
    missing,
    missingOpen: interesting.length === 0,
    total: items.length,
  }
}

/** Every reason's locale key, so no reason can silently fall through to a wrong one. */
const REASON_KEYS: Record<WorkBuddyWebSearchPath['reason'], WorkBuddySettingsKey> = {
  missing: 'row.reasonMissing',
  unreadable: 'row.reasonUnreadable',
  invalid: 'row.reasonInvalid',
  encrypted: 'row.reasonEncrypted',
  'wrong-region': 'row.reasonWrongRegion',
}

/** The reason's short label; `missing`/`unreadable`/`invalid`/`encrypted`/`wrong-region`. */
export function searchReasonKey(reason: WorkBuddyWebSearchPath['reason']): WorkBuddySettingsKey {
  return REASON_KEYS[reason] ?? 'row.reasonInvalid'
}

/**
 * One entry's cause line: which store the path belongs to, and why it failed.
 *
 * The source matters because the two are fixed differently — a desktop-app path
 * is about the app's installation and sign-in, a plugin-owned copy is about the
 * plugin's own storage.
 */
export function searchReasonLabel(item: WorkBuddyWebSearchPath, t: Translate): string {
  const source = t(item.source === 'desktop' ? 'row.sourceDesktop' : 'row.sourceDsh')
  return `${source} · ${t(searchReasonKey(item.reason))}`
}

/** What the signed-out paragraph should say, and the inputs that decided it. */
export interface SignedOutNotice {
  key: WorkBuddySettingsKey
  /** The Host's raw `resolve()` error, shown only when nothing supersedes it. */
  fallback?: string
}

/**
 * Choose the signed-out paragraph's copy.
 *
 * This exists because the card was saying the same thing twice. `resolve()`
 * refuses with a message that already ENUMERATES every path it tried
 * (`expected <Local>\workbuddy-desktop.info or <Roaming>\... or
 * WORKBUDDY_AUTH_FILE`), and the probed-path `<details>` right below it listed
 * those same paths with a per-entry reason. Both hint keys also opened with a
 * variant of "no sign-in was found", so one screen carried four statements of
 * one fact and the user's eye had nowhere to land.
 *
 * The rule: the paragraph states the situation, the list supplies the detail.
 * Whenever a list is rendered, the enumeration in `message` is redundant by
 * construction — the list is the same paths, with strictly better reasons — so
 * the paragraph falls back to the concise hint. Measured against the real
 * `resolve()` branches, the only content this drops is "or refresh an existing
 * session", which is vacuous exactly here: `searched` is attached only when
 * there are zero accounts, so there is no session to refresh.
 *
 * `selectionLost` still wins outright: there the tokens are healthy and the
 * advice is to re-pick an account, which no path list can replace.
 *
 * `encrypted` also outranks the generic hint, and for the same reason
 * `wrong-region` does: the generic copy tells the user to sign in again, which
 * is precisely the action that cannot work when the credential exists but is
 * encrypted. Leaving it in the collapsed list meant the headline contradicted
 * the detail below it — and the headline is the only part most users read.
 */
export function signedOutNotice(input: {
  selectionLost: boolean
  message: string | undefined
  searched: readonly WorkBuddyWebSearchPath[]
}): SignedOutNotice {
  if (input.selectionLost) return { key: 'row.selectionLostMessage' }
  // A wrong-region sign-in is the one answer better than "you are not signed
  // in": the user IS signed in, on the other tab. Say so in the headline
  // instead of burying the fix in a collapsed list.
  if (input.searched.some(item => item.reason === 'wrong-region')) {
    return { key: 'row.signedOutWrongRegion' }
  }
  // Ranked below wrong-region because a readable sign-in on the other tab is a
  // conclusive, cheaper fix; ranked above the generic hint because "sign in
  // again" is the one instruction that cannot help here.
  if (input.searched.some(item => item.reason === 'encrypted')) {
    return { key: 'row.signedOutEncrypted' }
  }
  if (input.searched.length > 0) return { key: 'row.signedOutHint' }
  // Nothing was probed, so the Host's message is the only account we have of
  // what happened — and then it is not a duplicate, it is the whole story.
  return input.message === undefined
    ? { key: 'row.signedOutHint' }
    : { key: 'row.signedOutHint', fallback: input.message }
}

/**
 * The paragraph's final text: the localized copy, plus the Host message only
 * when {@link signedOutNotice} decided nothing supersedes it.
 *
 * Kept here rather than inline in the JSX so the anti-duplication guarantee can
 * be asserted on the string that is actually rendered, not on its inputs.
 */
export function signedOutText(notice: SignedOutNotice, t: Translate): string {
  const hint = t(notice.key)
  return notice.fallback === undefined ? hint : `${hint} (${notice.fallback})`
}
