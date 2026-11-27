/**
 * Keep the host's `web.searchProvider` in sync with this plugin's web-search
 * opt-in (issue #332).
 *
 * Why this exists
 * ---------------
 * `web_search` is a host tool; it dispatches through `ctx.web.search()`, which
 * picks a provider. For WorkBuddy model routes the host's built-in default is
 * `deepseek-search-api`, so merely REGISTERING our provider is not enough — the
 * host has to be pointed at it. Doing that by hand (settings page) works, but
 * the user asked for the plugin switch to do it automatically.
 *
 * The supported write path is the Host `settings` service: `searchProvider` is
 * a declared VOLATILE field of the `web` entry, so `mutate('web', …)` both takes
 * effect immediately (the WebRuntime reads the live value each call) and is
 * persisted through `configEditor`. This is the same store the official web
 * search settings page writes to.
 *
 * Safety contract
 * ---------------
 * - Only ever write while the switch is ON. On OFF / dispose, restore exactly
 *   what was there before (a saved user value via `set`, or `unset` back to the
 *   composition default). A dangling provider id would make EVERY route's
 *   `web_search` fail with WEB_PROVIDER_CONFIGURED_MISSING after this plugin is
 *   uninstalled, so restoration is not optional.
 * - Use `expectedRevision` from `describe()` so a concurrent edit in the
 *   settings page cannot be silently overwritten.
 *
 * @module dsh-connect-workbuddy/web-search-provider-setting
 */

/** The host settings entry that owns searchProvider (dsh-base's `web` row). */
export const WEB_SETTINGS_NS = 'web'

/** The path of the field we own inside that entry. */
export const SEARCH_PROVIDER_PATH = ['searchProvider'] as const

/** A settings path operation, matching the host's `SettingsPathOp`. */
export type SettingsPathOp =
  | { op: 'set', path: string[], value: string }
  | { op: 'unset', path: string[] }

/** The slice of `ctx.settings` this module needs. */
export interface WebSettingsService {
  describe(): readonly { ns: string, revision: number, user?: Record<string, unknown>, base?: Record<string, unknown> }[]
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<unknown>
}

/** What to write — derived from the saved value, never guessed at write time. */
export type ProviderSettingPlan =
  | { kind: 'set', value: string }
  | { kind: 'unset' }

/**
 * Compute the RESTORE plan: put back the value that was in force before we
 * took over. Read from `user` (an explicit saved choice) first, then `base`
 * (the composition's value); when neither is set, `unset` returns control to
 * the host's per-route default.
 *
 * Kept pure so the restore decision is testable without a live settings
 * service. A value that is not a non-empty string is treated as absent — a
 * malformed stored value must not be re-applied.
 *
 * `ownId` is essential across restarts: the takeover persists our id into the
 * profile, so on the NEXT run `describe()` reports our own id as the "saved
 * user value". Without excluding it, disabling the switch would `set` the host
 * right back to our (now unregistered) id and leave WEB_SEARCH permanently
 * broken with CONFIGURED_MISSING. Treating our own id as absent makes the
 * restore `unset` instead, handing control back to the host's per-route
 * default.
 */
export function restorePlan(
  snapshot: { user?: Record<string, unknown>, base?: Record<string, unknown> } | undefined,
  ownId?: string,
): ProviderSettingPlan {
  const from = (section: Record<string, unknown> | undefined): string | undefined => {
    const value = section?.[SEARCH_PROVIDER_PATH[0]]
    if (typeof value !== 'string' || value === '') return undefined
    // Our own persisted id is not a user choice — it is last run's takeover.
    if (ownId !== undefined && value === ownId) return undefined
    return value
  }
  const saved = from(snapshot?.user) ?? from(snapshot?.base)
  return saved === undefined ? { kind: 'unset' } : { kind: 'set', value: saved }
}

/** The WRITE plan: pin the host to our provider id. */
export function takeoverPlan(providerId: string): ProviderSettingPlan {
  return { kind: 'set', value: providerId }
}

/** Turn a plan into the host's path-op shape. */
export function planToOp(plan: ProviderSettingPlan): SettingsPathOp {
  return plan.kind === 'set'
    ? { op: 'set', path: [...SEARCH_PROVIDER_PATH], value: plan.value }
    : { op: 'unset', path: [...SEARCH_PROVIDER_PATH] }
}

/** The web entry's descriptor from a fresh `describe()`, or undefined. */
export function webEntry(
  settings: WebSettingsService,
): { ns: string, revision: number, user?: Record<string, unknown>, base?: Record<string, unknown> } | undefined {
  return settings.describe().find(row => row.ns === WEB_SETTINGS_NS)
}

/**
 * Apply a plan with revision protection.
 *
 * Returns false (and does nothing) when the web entry is not served by this
 * host — an older host, or a profile where the entry was removed. Callers log
 * and move on: the provider registration itself is still valid, the user just
 * has to pick it manually on such a host.
 */
export async function applyProviderSetting(
  settings: WebSettingsService,
  plan: ProviderSettingPlan,
): Promise<boolean> {
  const entry = webEntry(settings)
  if (entry === undefined) return false
  await settings.mutate(WEB_SETTINGS_NS, [planToOp(plan)], entry.revision)
  return true
}
