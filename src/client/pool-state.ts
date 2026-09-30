/**
 * Pure decision helpers for the account pool's card section.
 *
 * 参考：`src/account-pool.ts` 的做法——把「判定规则」从组件里抽出来，让规则本身
 *   可被单测直接钉住，而不是只能通过渲染整棵组件树间接观察。
 * 改动：新增本模块，收纳三组此前内联在 `AccountPool.tsx` 里的判定。抽出它们的
 *   直接原因是**独立验证发现 H-1/H-2 两个最高危修复没有任何自动化回归测试**：
 *   内联在组件里就只能靠真实渲染验证，而渲染测试既慢又容易被隔离问题骗过。
 *
 * 本模块不 import React、不碰网络，纯函数、全函数。
 *
 * @module dsh-connect-workbuddy/client/pool-state
 */

import { effectiveMembersOf } from '../account-pool.ts'
import type { Translate } from './searched-paths.ts'

/** The four preference fields the pool section edits. */
export interface PoolPreferencesLike {
  enabled: boolean
  rotateByCredits: boolean
  autoTestIntervalMinutes: number
  targetModelId: string
  memberAccountIds: readonly string[]
}

/**
 * Whether rotation currently owns the region's billing choice, and whether the
 * user has drafted turning it off.
 *
 * `locked` reads the COMMITTED preferences, never the draft. The Host decides
 * who is billed from the saved config, so a draft-based lock let one click of
 * "turn off rotation" re-enable the manual dropdown and hide the conflict
 * notice while the Host kept rotating — the user then picked an account, the
 * card showed it as current, and a different account was billed. That is
 * exactly the failure the lock exists to prevent.
 *
 * `unlockPending` is the honest intermediate state: the draft says "stop
 * rotating" but the Host has not been told yet, so the lock still applies and
 * the UI must say so rather than looking broken.
 */
export function rotationLockState(
  saved: Pick<PoolPreferencesLike, 'enabled' | 'rotateByCredits'>,
  active: Pick<PoolPreferencesLike, 'enabled' | 'rotateByCredits'>,
): { locked: boolean, unlockPending: boolean } {
  const locked = saved.enabled && saved.rotateByCredits
  return {
    locked,
    unlockPending: locked && !(active.enabled && active.rotateByCredits),
  }
}

/**
 * The base a draft edit starts from.
 *
 * Resolved at EDIT time rather than captured when the callback was built. The
 * defect this fixes: the callback's dependency list named individual scalar
 * fields, so a field added later (`memberAccountIds`) was missing from it and
 * the callback kept a STALE base — checking one account then silently dropped
 * another that had been saved in between.
 *
 * `previous` is the draft already in state; it only applies to the region it
 * was made on, because the two pools are independent and one region's unsaved
 * edits must never seed the other's.
 */
export function draftBaseFor<T extends PoolPreferencesLike>(
  previous: T | null,
  previousRegion: string | undefined,
  region: string,
  saved: T,
): T {
  return previous !== null && previousRegion === region ? previous : saved
}

/**
 * Membership that resolves to a real local sign-in — what a batch runs on.
 *
 * The HOST computes this and sends it; this helper only chooses which answer to
 * trust. Counting the raw saved list is what let the UI claim "已选 1 / 共 1"
 * and enable both buttons while the batch ran on ZERO accounts and reported
 * success, so:
 *
 *   - while the draft is CLEAN, the Host's answer is authoritative (it reflects
 *     what would actually run, including sign-ins that have since disappeared);
 *   - while the draft is DIRTY, it must be derived from the edited list, since
 *     the Host's answer describes the SAVED state and would ignore the edit the
 *     user is looking at.
 */
export function effectiveMemberIds(input: {
  savedEffective: readonly string[]
  draftMembers: readonly string[]
  listedIds: ReadonlySet<string>
  dirty: boolean
}): string[] {
  if (!input.dirty) return [...input.savedEffective]
  // The dirty branch is the shared rule, not a fourth copy of it.
  return effectiveMembersOf(input.draftMembers, input.listedIds)
}

/**
 * Saved member ids with no matching sign-in.
 *
 * Surfaced rather than silently ignored: the ids remain in the user's saved
 * list (a login can come back), so the card has to explain why the pool behaves
 * as though they were absent.
 */
export function ghostMemberIds(
  draftMembers: readonly string[],
  listedIds: ReadonlySet<string>,
): string[] {
  return draftMembers.filter(id => !listedIds.has(id))
}

/**
 * How many accounts a batch will really touch, as the log announces it.
 *
 * Mirrors the HOST's own resolution exactly — `effective ?? saved` in the pool
 * route — because the number in the activity log must describe what the Host
 * runs, not what the card happens to display. Two wrong answers are possible and
 * both were live at different times:
 *
 *   - counting the raw SAVED list overstates it, so a ghost-only pool logged
 *     "checking in 1 account(s)" and was then refused with 409 having touched
 *     nothing;
 *   - counting the DRAFT-derived set announces unsaved edits the Host will not
 *     run (it reads the committed config).
 *
 * `savedEffective` is `undefined` only for a Host too old to send it, where the
 * saved list is the best available answer — the same fallback the route uses.
 */
export function announcedBatchCount(input: {
  savedEffective: readonly string[] | undefined
  savedMembers: readonly string[]
}): number {
  return (input.savedEffective ?? input.savedMembers).length
}

/** Bounds the Host enforces on the automatic-test interval (`src/index.ts:390`). */
export const POOL_INTERVAL_MIN = 5
export const POOL_INTERVAL_MAX = 1440

/**
 * Localize a pool route failure from its structured cause.
 *
 * Lives here, not in `AccountPool.tsx`, because the card's module graph pulls
 * DSH's browser packages and there is no jsdom in this project — a rule left
 * inside the component cannot be tested at all. That is not hypothetical: the
 * independent verification deleted this function's `no-live-members` branch AND
 * both locale copies of its copy, and the whole 618-test suite still passed.
 * Extracting it is what lets `tests/pool-state.spec.ts` pin every branch.
 *
 * Returns undefined for an unknown cause so the caller can fall back to the
 * Host's own words — a new cause added upstream must still be visible rather
 * than swallowed into a generic message.
 *
 * `detail` is the Host's raw `error` text, used only where the sentence has a
 * slot for it (`pool-failed`). It is NOT the primary path: echoing English
 * developer prose into a Chinese UI was the defect this function exists to
 * prevent, and only the cases with no structured cause fall back to it.
 */
export function poolErrorText(
  t: Translate,
  reason: string | undefined,
  detail?: string,
): string | undefined {
  switch (reason) {
    case 'pool-disabled': return t('row.poolErrDisabled')
    case 'no-members': return t('row.poolErrNoMembers')
    case 'no-live-members': return t('row.poolErrNoLiveMembers')
    case 'no-free-model': return t('row.poolErrNoFreeModel')
    case 'target-model-stale': return t('row.poolErrStaleModel')
    case 'pool-unavailable': return t('row.poolErrUnavailable')
    case 'pool-failed': return t('row.poolErrFailed', { message: detail ?? '' })
    default: return undefined
  }
}

/**
 * The message to show for a failed pool request, from every signal available.
 *
 * The three-tier rule, in order, and why each tier exists:
 *
 *  1. the STRUCTURED cause, localized — the Host's `error` is an English
 *     developer sentence, and echoing it put untranslated prose in a Chinese UI;
 *  2. the Host's raw text, for a cause this build does not know — still more
 *     informative than a generic message, and it keeps a new upstream cause
 *     visible rather than swallowed;
 *  3. a message keyed on the STATUS — every pool exit that carries no reason
 *     (405/403/400 and the generic 500) otherwise reached the user as bare
 *     English like `HTTP 405`.
 *
 * Extracted from the card for the same reason as {@link poolErrorText}: a rule
 * inside the browser-only `.tsx` cannot be tested, and the status tier in
 * particular had no guard at all — reverting it to `` `HTTP ${status}` `` left
 * the entire suite green.
 */
export function poolFailureText(
  t: Translate,
  input: { status: number, reason?: string | undefined, error?: string | undefined },
): string {
  return poolErrorText(t, input.reason, input.error)
    ?? input.error
    ?? t('row.poolErrHttp', { status: String(input.status) })
}

/**
 * Parse an in-progress interval edit.
 *
 * Returns `undefined` while the text is not yet a plain non-negative integer —
 * empty, `-`, `12e`, `1.5` — so the caller can leave EXACTLY what the user typed
 * on screen instead of rewriting the control from a parsed number.
 *
 * That rewriting was the defect this replaces: the field clamped on every
 * keystroke and wrote the clamped result back into a controlled `value`, so
 * typing `120` produced `520` (each keystroke's clamped `5` was rendered, and the
 * next digit appended to it) and clearing the field immediately snapped it to
 * `5`. The user's original request was "设置一个时间间隔自动测试" — a field that
 * cannot be typed into is that requirement unmet, not a cosmetic wart.
 */
export function parseIntervalInput(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!/^[0-9]+$/.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(POOL_INTERVAL_MAX, Math.max(POOL_INTERVAL_MIN, Math.round(parsed)))
}

/**
 * One keystroke in the interval field: what to DISPLAY, and what to commit.
 *
 * `text` is ALWAYS the raw keystroke, never a re-serialized number — that
 * distinction is the whole defect. A field whose displayed value is derived from
 * the parsed-and-clamped number cannot be typed into: each keystroke's clamped
 * `5` is rendered, and the next digit appends to it (`120` → `520`).
 *
 * `commit` is the clamped number to fold into the draft, or `undefined` while the
 * text is not yet a plain integer (so the draft is left alone until the entry is
 * meaningful). Splitting the two makes the invariant unit-testable without a DOM,
 * which this project has no way to render.
 */
export function intervalEditOnInput(raw: string): { text: string, commit: number | undefined } {
  return { text: raw, commit: parseIntervalInput(raw) }
}

/**
 * Pool MEMBERS that can serve right now.
 *
 * Judged over members only. Using the whole account table made the "no usable
 * account" warning unreachable: unchecked rows are listed for the user to opt
 * into and never carry `excludedBy`, so any unchecked sign-in kept the count
 * above zero — exactly when every member was limited and the explanation was
 * most needed.
 */
export function usableMemberIds<T extends { accountId: string, excludedBy?: string }>(
  accounts: readonly T[],
  effectiveMembers: readonly string[],
  draftMembers: readonly string[],
): string[] {
  const wanted = new Set([...effectiveMembers, ...draftMembers])
  return accounts
    .filter(account => wanted.has(account.accountId) && account.excludedBy === undefined)
    .map(account => account.accountId)
}