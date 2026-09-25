/**
 * Node-free constants and types shared by the Host and browser halves.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 「3 条同源只读路由（usage / models:refresh / accounts:refresh）+ 一份
 *     与浏览器共享的 node-free 类型定义」的 host↔client 桥梁形态来自该项目
 *     （其 `status-paths.ts` 亦如此，并注明沿用
 *     corrinehu/dsh-workbuddy-connect 的 status-route 模式）。
 * 改动：路由路径改用本插件 id；类型字段按 WorkBuddy 上游实际给出的能力
 *   （积分倍率、多模态、推理档位）调整，不保留 trae 的 1M 变体字段。
 *
 * @module dsh-connect-workbuddy/status-paths
 */

/** Plugin-owned usage endpoint consumed by its browser half. */
export const WORKBUDDY_USAGE_PATH = '/plugins/dsh-connect-workbuddy/usage'
/** Plugin-owned live model refresh endpoint. */
export const WORKBUDDY_MODELS_REFRESH_PATH = '/plugins/dsh-connect-workbuddy/models/refresh'
/** Plugin-owned local account rescan endpoint. */
export const WORKBUDDY_ACCOUNTS_REFRESH_PATH = '/plugins/dsh-connect-workbuddy/accounts/refresh'
/** Plugin-owned daily check-in action endpoint. */
export const WORKBUDDY_CHECKIN_PATH = '/plugins/dsh-connect-workbuddy/checkin'

/** Query parameter naming the region a card request addresses. */
export const WORKBUDDY_REGION_PARAM = 'region'

/** Every region, in card tab order. */
export const WORKBUDDY_REGIONS: readonly WorkBuddyWebRegion[] = ['cn', 'global']

/**
 * Address one region's status route. The two regions are separate provider
 * stacks; every card request carries the region whose tab the user is on.
 */
export function withWorkBuddyRegion(path: string, region: WorkBuddyWebRegion): string {
  return `${path}?${WORKBUDDY_REGION_PARAM}=${region}`
}

/**
 * Read the region parameter off a status-route URL. Absent means the domestic
 * tab (`cn`); a present-but-unknown value returns undefined so the route can
 * answer 400 instead of guessing.
 */
export function regionOfStatusUrl(url: string): WorkBuddyWebRegion | undefined {
  const at = url.indexOf('?')
  const value = at === -1 ? null : new URLSearchParams(url.slice(at + 1)).get(WORKBUDDY_REGION_PARAM)
  if (value === null || value === '') return 'cn'
  return (WORKBUDDY_REGIONS as readonly string[]).includes(value) ? value as WorkBuddyWebRegion : undefined
}

/**
 * Narrow a settings value to the `regions` map. Accepts EITHER the whole
 * settings section (the Host's resolved `Config`) OR the `regions` map itself,
 * and unwraps the former. This tolerance is deliberate: passing the whole
 * section where the map was expected was a real shipped bug in the sibling
 * project — the lookup then read `section['cn']` (absent), so the card's
 * checkbox reported `true` forever and clicking it appeared to do nothing even
 * though the write succeeded.
 *
 * The resolved section delivers `regions` as a `{get(): T}` LIVE reference, and
 * a live reference is `typeof === 'object'` and not an array — so it passes a
 * naive object check and gets returned as if it were the map. Every lookup on
 * it is then `undefined`: the enabled flag reads back as "on" forever (the very
 * symptom described above), and a merge that spreads this map silently drops
 * the region it was not editing. Unwrap before narrowing.
 */
function regionsMapOf(value: unknown): Record<string, unknown> {
  const unwrapped = unwrapVolatileDeep(value)
  if (typeof unwrapped !== 'object' || unwrapped === null || Array.isArray(unwrapped)) return {}
  const record = unwrapped as Record<string, unknown>
  const nested = record['regions']
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    return nested as Record<string, unknown>
  }
  return record
}

/** One region's stored slot as a plain object; any other shape reads as empty. */
function regionSlotOf(value: unknown, region: WorkBuddyWebRegion): Record<string, unknown> {
  const slot = regionsMapOf(value)[region]
  return typeof slot === 'object' && slot !== null && !Array.isArray(slot)
    ? slot as Record<string, unknown>
    : {}
}

/**
 * Whether one region's provider is switched on. Opt-out semantics: only an
 * explicit `false` disables it, so a config written before this switch existed
 * (and the pre-region-split flat fields, which never carry `enabled`) keep both
 * providers running exactly as before. The Host reads the same rule through
 * `regionStateOf`, so card and Host can never disagree about a region's state.
 *
 * `value` may be the whole settings section or the `regions` map (see
 * {@link regionsMapOf}).
 */
export function regionEnabledOf(value: unknown, region: WorkBuddyWebRegion): boolean {
  return regionSlotOf(value, region)['enabled'] !== false
}

/** Build the next `regions` settings value for a signed-in tab's save. */
export function nextRegionSlots<Slot extends object>(
  regions: unknown,
  region: WorkBuddyWebRegion,
  slot: Slot,
): Record<string, unknown> {
  const base = typeof regions === 'object' && regions !== null && !Array.isArray(regions)
    ? regions as Record<string, unknown>
    : {}
  return { ...base, [region]: slot }
}

/**
 * Build the next `regions` settings value for a provider on/off toggle. ONLY
 * the target region's `enabled` flag changes: every other field of that slot
 * (its directory, selection, image opt-ins, context budgets) and every other
 * region's slot are carried over verbatim, so switching a provider off never
 * discards the user's model picks and switching it back on restores them.
 *
 * This is deliberately separate from {@link nextRegionSlots}: that helper
 * writes a whole slot from a signed-in tab's draft, while this one must work
 * for a region that is signed OUT — which is precisely the region a user wants
 * to switch off (no international install, no international account).
 *
 * `value` may be the whole settings section or the `regions` map; the RETURN
 * value is always the `regions` map, i.e. exactly what `settingsScope.set(
 * 'regions', ...)` needs.
 */
export function nextRegionEnabled(
  value: unknown,
  region: WorkBuddyWebRegion,
  enabled: boolean,
): Record<string, unknown> {
  return nextRegionSlots(regionsMapOf(value), region, { ...regionSlotOf(value, region), enabled })
}

/** One credit package as the upstream returns it, node-free. */
export interface WorkBuddyWebCreditPackage {
  packageName: string
  remain: number
  size: number
  /** CapacityType 4: refreshed every cycle and never expires. */
  monthly: boolean
  /** Next cycle start (the monthly refresh point) in ms; only on monthly packages. */
  cycleRefreshMs?: number
  /** One-off expiry in ms; the package disappears from the account then. */
  expiresAtMs?: number
}

/** Aggregated credit answer rendered by the plugin card. */
export interface WorkBuddyWebCredits {
  total: number
  packages: readonly WorkBuddyWebCreditPackage[]
  /** Credits expiring within 3 days across every package. */
  expiringSoon: number
  /** When the nearest package expires, in ms. */
  nearestExpiryMs?: number
}

/** Daily check-in state rendered below total remaining credits. */
export interface WorkBuddyWebCheckin {
  active: boolean
  todayCheckedIn: boolean
  streakDays: number
  dailyCredit: number
  todayCredit: number
  isStreakDay: boolean
  nextStreakDay: number
  streakBonusDays: number
  streakBonusCredit: number
  claimButtonText?: string
}

/**
 * What the user can do about a credential the upstream refused.
 *
 * Two different fixes hide behind one 401, and naming the wrong one is worse
 * than saying nothing: with a stale account SELECTED but a healthy sign-in
 * sitting right there, "sign in again" sends the user to re-authenticate — which
 * changes nothing, because the credentials were never the problem.
 */
export interface WorkBuddyWebRecovery {
  /**
   * Another local account answered the upstream during recovery, so switching
   * to it is a VERIFIED fix rather than a suggestion.
   */
  usableAccount?: { accountId: string; accountName: string }
  /**
   * Signing in again is the only remaining fix: this region has no other local
   * account to switch to. Set only in that case — never as a fallback for
   * "nothing could be verified".
   */
  reloginRequired: boolean
}

/** Editable WorkBuddy model row rendered by the plugin-owned settings card. */
export interface WorkBuddyWebModel {
  id: string
  name: string
  /** Effective DSH context after applying the saved local budget. */
  contextWindow: number
  /** Native maximum advertised by WorkBuddy; models above 200K expose 200K/max. */
  nativeContextWindow: number
  maxTokens: number
  creditMultiplier?: number
  multimodal?: boolean
  reasoning?: {
    supportedEfforts?: readonly string[]
    defaultEffort?: string
  }
  description?: string
}

/**
 * Project one card row into its persisted `lastCatalog` shape: the native
 * context window becomes the stored `contextWindow`, and the card-only
 * presentation fields (`nativeContextWindow`, `multimodal`) are removed BY
 * KEY. They must never be set to `undefined`: explicit `undefined` values
 * survive `structuredClone` and are rejected by the settings write path's
 * strict JSON codec (`client api: settings/mutate rejected "ops"`), which
 * fails the whole save.
 */
export function toPersistedWorkBuddyModel(
  model: WorkBuddyWebModel,
): Omit<WorkBuddyWebModel, 'nativeContextWindow' | 'multimodal'> {
  const { nativeContextWindow, multimodal: _cardOnly, ...rest } = model
  return { ...rest, contextWindow: nativeContextWindow }
}

/** One selectable local account, token-free. */
export interface WorkBuddyWebAccount {
  id: string
  /**
   * The account's human name, or `''` when the desktop app recorded none.
   * The card renders its own placeholder for the empty case.
   */
  accountName: string
  domain: string
  source: 'desktop' | 'dsh'
  tokenExpiresAtMs: number
  selected: boolean
}

export type WorkBuddyWebPackage = WorkBuddyWebCreditPackage

/**
 * One probed candidate path and why it yielded no account.
 *
 * Safe to send to the browser: a path, its source, and a cause. No token
 * material, and no content read out of the files beyond an error string.
 *
 * `encrypted` exists because WorkBuddy (unlike a plain JSON-token app) can
 * refuse a correctly signed-in user: Windows builds encrypt the token fields,
 * and opening them needs the desktop app present to hand over its at-rest key.
 * Telling that user to "sign in again" is wrong — they already are.
 *
 * `wrong-region` is the other WorkBuddy-specific one: the file holds a valid
 * sign-in for the OTHER tab's region, so this tab filters it out of the account
 * list. Without this entry the file was reported nowhere at all, which both
 * undercounted "paths checked" and hid the user's real sign-in.
 */
export interface WorkBuddyWebSearchPath {
  path: string
  source: 'desktop' | 'dsh'
  reason: 'missing' | 'unreadable' | 'invalid' | 'encrypted' | 'wrong-region'
  message?: string
}

/**
 * Region of the signed-in credential: the CN app (`codebuddy.cn` /
 * `workbuddy.cn`) or the international WorkBuddy AI app (`workbuddy.ai`).
 * The card uses this to read and write the matching per-region model slot.
 */
export type WorkBuddyWebRegion = 'cn' | 'global'

/** The JSON document the plugin card renders. */
export type WorkBuddyWebUsage =
  /**
   * Not usable right now. `accounts` is still populated so the picker can
   * offer a way out, and `selectionLost` separates the two very different
   * reasons this happens: local sign-ins exist but the SAVED choice no longer
   * matches any of them (re-select it, or clear it to follow the app's current
   * sign-in again), versus nothing usable was found at all (sign in in the
   * desktop app). Only the latter makes the "sign in again" hint truthful —
   * re-signing in does not repair an orphaned id.
   *
   * `selectionExplicit` answers a question the account list cannot: whether
   * the region runs a saved choice at all. Clearing restores the default, and
   * when the default resolves to the same account the card would otherwise
   * look unchanged — the "clear did nothing" report.
   */
  | {
    status: 'signed-out'
    accounts: readonly WorkBuddyWebAccount[]
    /** Whether this region's provider is currently offered to DSH. */
    enabled?: boolean
    message?: string
    /** The persisted account id matches no local account. */
    selectionLost?: boolean
    /** A saved per-region choice is in effect (false = following the app). */
    selectionExplicit: boolean
    /**
     * The paths this region's store probed, and why each yielded nothing.
     *
     * Present only on the "nothing was found at all" branch — it is the
     * explanation for a state that is otherwise a dead end. A missing candidate
     * (`missing`) is normal noise on any machine and the card filters those out
     * of its default view; the interesting ones are `unreadable`, `invalid`,
     * and especially `encrypted`.
     */
    searched?: readonly WorkBuddyWebSearchPath[]
  }
  | {
    status: 'signed-in'
    accountId: string
    /**
     * The account's human name, or `''` when the desktop app recorded none.
     * Never an identifier — see {@link WorkBuddyWebAccount.accountName}.
     */
    accountName: string
    domain?: string
    /** Which per-region model directory and selection this account owns. */
    region: WorkBuddyWebRegion
    /** Whether this region's provider is currently offered to DSH. */
    enabled?: boolean
    source?: 'desktop' | 'dsh'
    tokenExpiresAtMs: number
    /** A saved per-region choice is in effect (false = following the app). */
    selectionExplicit: boolean
    accounts: readonly WorkBuddyWebAccount[]
    models: readonly WorkBuddyWebModel[]
    enabledModelIds: readonly string[]
    imageModelIds: readonly string[]
    credits?: WorkBuddyWebCredits
    creditsError?: string
    checkin?: WorkBuddyWebCheckin
    checkinError?: string
    /**
     * The upstream refused the credential itself (a 401/403), as opposed to a
     * transient upstream fault. Distinguishes "your token is not usable" from
     * "the request failed", which need opposite advice.
     */
    credentialRejected?: boolean
    /** Present only alongside {@link credentialRejected}. */
    recovery?: WorkBuddyWebRecovery
    /**
     * Diagnostic only: whether this Host build's Config carries the volatile
     * markers dsh-settings requires before it will persist any field. Exposed
     * so a save refusal can be attributed to the settings gate rather than
     * guessed at.
     */
    diagVolatile?: { regions: boolean, accounts: boolean, authFile: boolean }
    /**
     * The persisted per-region context budgets as the Host reads them. The
     * browser settings mirror can lag a write made through the Host save
     * endpoint, so the card renders these rather than a possibly-stale snapshot.
     */
    contextBudgets?: Record<string, number>
  }
  | { status: 'error'; message: string }

/**
 * Deep copy of a settings value with every `{get(): T}` live reference replaced
 * by the value it resolves to.
 *
 * `regions` and `accounts` are declared `asVolatile(...)`, and schemastery
 * resolves a volatile field to a live reference. That resolution happens in
 * schemastery itself, driven by the schema's `meta.volatile`, so it is
 * independent of the DSH line — the resolved section looks like this to the
 * browser half on BOTH 0.1.5 and 0.1.7.
 *
 * A live reference is still `typeof === 'object'`, so `{ ...reference }` does
 * NOT read the field: it produces `{ get: <function> }`. Any caller that
 * spreads the resolved field to preserve its siblings — the card's
 * "write one region, keep the other" merge — would otherwise DROP every
 * sibling and leak a function into the document. Both halves therefore unwrap
 * before touching a resolved field.
 *
 * Lives here, not in the Host entry, because the browser half needs it too and
 * this module is the node-free bridge between the two.
 *
 * Non-reference values are recursed into so a nested volatile field is caught
 * too — arrays and objects are rebuilt rather than mutated, so the caller's
 * value is never touched.
 */
export function unwrapVolatileDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (typeof (value as { get?: unknown }).get === 'function') {
    return unwrapVolatileDeep((value as unknown as { get: () => unknown }).get()) as T
  }
  if (Array.isArray(value)) return value.map(entry => unwrapVolatileDeep(entry)) as T
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    out[key] = unwrapVolatileDeep(source[key])
  }
  return out as T
}

/**
 * The plugin's DECLARED settings namespace — the fallback name, not the value
 * the host necessarily serves.
 *
 * On 0.1.7 the settings service keys every form by the plugin's Loader entry id
 * (`describe()` returns `ns: entry.options.id`), and the harness resolves a
 * provider's namespace by EXACT match. The entry id is chosen by the profile
 * patch, so a plugin cannot know it in advance — the live Desktop host mounts
 * this one as `include:dsh-connect-workbuddy`.
 *
 * Lives here, not in the Host entry, because the browser half needs the same
 * fallback and must not import Node-only host code.
 */
export const WORKBUDDY_SETTINGS_NS = 'workbuddy' as const
