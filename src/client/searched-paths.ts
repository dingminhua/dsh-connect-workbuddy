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
 */
export const INTERESTING_REASONS: readonly WorkBuddyWebSearchPath['reason'][]
  = ['encrypted', 'invalid', 'unreadable']

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
  /** Whether the encrypted-specific advice applies. */
  encrypted: boolean
  /** Total probed entries, for the summary label. */
  total: number
}

/**
 * Partition one region's probe failures for display.
 *
 * Order within each group is preserved from the Host: the store reports
 * candidates in probe order, which is meaningful (the live file before its
 * timestamped backups).
 */
export function searchedView(items: readonly WorkBuddyWebSearchPath[]): SearchedView {
  const interesting = items.filter(item => INTERESTING_REASONS.includes(item.reason))
  const missing = items.filter(item => !INTERESTING_REASONS.includes(item.reason))
  return {
    interesting,
    missing,
    missingOpen: interesting.length === 0,
    encrypted: items.some(item => item.reason === 'encrypted'),
    total: items.length,
  }
}

/** The reason's short label; `missing`/`unreadable`/`invalid`/`encrypted`. */
export function searchReasonKey(reason: WorkBuddyWebSearchPath['reason']): WorkBuddySettingsKey {
  return reason === 'missing'
    ? 'row.reasonMissing'
    : reason === 'unreadable'
      ? 'row.reasonUnreadable'
      : reason === 'encrypted'
        ? 'row.reasonEncrypted'
        : 'row.reasonInvalid'
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
