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
/**
 * Per-account credit balances for one region, read ONLY while the composer
 * panel is open.
 *
 * Separate from {@link WORKBUDDY_USAGE_PATH} because its cost is different in
 * kind: the usage document is one upstream read for the selected account, while
 * this is one read PER account in the region. Folding it into the usage route
 * would make every 5-minute refresh pay for a table nobody is looking at, so it
 * is fetched on demand instead — the same principle the pool applies to its
 * per-account figures.
 */
export const WORKBUDDY_ACCOUNT_CREDITS_PATH = '/plugins/dsh-connect-workbuddy/account-credits'
/**
 * The project's public repository.
 *
 * Lives here rather than beside one component because TWO sections link to it
 * now — the model section and the account pool — and a second copy of a URL is
 * a second thing to forget when it moves. Node-free and side-effect free, so it
 * costs nothing on the Host side either.
 */
export const WORKBUDDY_GITHUB_URL = 'https://github.com/dingminhua/dsh-connect-workbuddy'
/** Plugin-owned live model refresh endpoint. */
export const WORKBUDDY_MODELS_REFRESH_PATH = '/plugins/dsh-connect-workbuddy/models/refresh'
/** Plugin-owned local account rescan endpoint. */
export const WORKBUDDY_ACCOUNTS_REFRESH_PATH = '/plugins/dsh-connect-workbuddy/accounts/refresh'
/** Plugin-owned daily check-in action endpoint. */
export const WORKBUDDY_CHECKIN_PATH = '/plugins/dsh-connect-workbuddy/checkin'
/**
 * Plugin-owned model probe endpoint.
 *
 * Sends one minimal chat request per named model so the card can answer "is
 * this model usable right now, and if it is limited, when can it be used
 * again?". Lives on the Host because the credential must never reach the
 * browser half.
 */
export const WORKBUDDY_PROBE_PATH = '/plugins/dsh-connect-workbuddy/probe'

/**
 * Plugin-owned account-pool endpoint: one batch action per call.
 *
 * `?action=checkin` claims the daily reward for every account of a region;
 * `?action=test` probes every account against the region's target model. Both
 * are POST and loopback-only because both cost something real — check-in writes
 * to the user's account, a probe spends credits.
 *
 * Deliberately ONE endpoint rather than two: the two actions share every
 * guard (method, origin, region, pool-enabled) and differ only in the work, so
 * splitting them would duplicate the guards and invite them to drift apart.
 */
export const WORKBUDDY_POOL_PATH = '/plugins/dsh-connect-workbuddy/pool'

/**
 * Plugin-owned OAuth sign-in endpoint: one session step per call.
 *
 * `?action=start` asks the upstream for a login state and returns the URL to
 * open; `?action=poll` (+ `loginId` in the body) reports whether the user
 * finished, and on success persists the account into the vault. POST +
 * loopback-only like the card's other mutations: the poll carries the login
 * binding, and the Host-side session state must not be settable by another
 * origin.
 */
export const WORKBUDDY_OAUTH_PATH = '/plugins/dsh-connect-workbuddy/oauth'

/** Query parameter selecting which pool batch action a request means. */
export const WORKBUDDY_POOL_ACTION_PARAM = 'action'

/** The OAuth session steps. */
export type WorkBuddyOAuthAction = 'start' | 'poll'

/** How long the card waits between polls while the user is scanning. */
export const OAUTH_POLL_INTERVAL_MS = 2_000

/** Read the OAuth action off a request URL; unknown/absent means undefined. */
export function oauthActionOf(url: string): WorkBuddyOAuthAction | undefined {
  const at = url.indexOf('?')
  if (at === -1) return undefined
  const value = new URLSearchParams(url.slice(at + 1)).get(WORKBUDDY_POOL_ACTION_PARAM)
  return value === 'start' || value === 'poll' ? value : undefined
}

/** The pool batch actions. `remove` is per-account and never batch-wide. */
export type WorkBuddyPoolAction = 'checkin' | 'test' | 'remove'

/** Read the pool action off a request URL; unknown/absent means undefined. */
export function poolActionOf(url: string): WorkBuddyPoolAction | undefined {
  const at = url.indexOf('?')
  if (at === -1) return undefined
  const value = new URLSearchParams(url.slice(at + 1)).get(WORKBUDDY_POOL_ACTION_PARAM)
  return value === 'checkin' || value === 'test' || value === 'remove' ? value : undefined
}

/** Query parameter naming ONE pool account a per-row request addresses. */
export const WORKBUDDY_POOL_ACCOUNT_PARAM = 'accountId'

/**
 * Plugin-owned account transfer endpoint: the batch export / import of
 * credentials between machines and between tools of the SAME format family.
 *
 * `?action=export` POSTs account ids, answers a JSON ARRAY of credential
 * records; `?action=preview` POSTs file text, answers a token-free listing;
 * `?action=import` POSTs file text plus selected indexes, merges into the
 * vault. POST + loopback-only like every other mutation: the file content is
 * arbitrary user data and export carries token material.
 */
export const WORKBUDDY_TRANSFER_PATH = '/plugins/dsh-connect-workbuddy/transfer'

/** The transfer endpoint's steps. */
export type WorkBuddyTransferAction = 'export' | 'preview' | 'import'

/** Read the transfer action off a request URL; unknown/absent means undefined. */
export function transferActionOf(url: string): WorkBuddyTransferAction | undefined {
  const at = url.indexOf('?')
  if (at === -1) return undefined
  const value = new URLSearchParams(url.slice(at + 1)).get(WORKBUDDY_POOL_ACTION_PARAM)
  return value === 'export' || value === 'preview' || value === 'import' ? value : undefined
}

/**
 * One entry of the transfer PREVIEW: display fields only, never token
 * material. `hasToken` is the import decision input — the import step skips
 * records without one — and the indexes are the FILE's positions, so the user
 * picks by the same numbers the import call sends back.
 */
export interface WorkBuddyTransferPreviewEntry {
  index: number
  uid: string
  nickname: string
  email: string
  hasToken: boolean
}

/** The preview answer: the desensitized listing plus the file's total count. */
export interface WorkBuddyTransferPreview {
  accounts: readonly WorkBuddyTransferPreviewEntry[]
  total: number
}

/**
 * The import answer. `imported` counts records merged into the vault (new OR
 * overwritten — both change the stored entry); `skipped` counts what was
 * left out: missing token, a bad index, or a record whose login domain does
 * not belong to the addressed region.
 */
export interface WorkBuddyTransferImportAnswer {
  imported: number
  skipped: number
}

/**
 * The shared file format's record shape, subset the importer consumes.
 *
 * Contract with sibling tools exporting the same format: a JSON array of
 * objects keyed in snake_case — `access_token` (required), `refresh_token`,
 * `uid`, `nickname`, `email`, `domain`, `expiresAt` (epoch ms),
 * `refreshExpiresAt`, `auth_raw`. Extra fields ride along untouched.
 */
export interface WorkBuddyTransferRecord {
  access_token: string
  refresh_token?: string
  uid?: string
  nickname?: string
  email?: string
  domain?: string
  /** Access-token expiry in epoch MILLISECONDS, the sibling format's unit. */
  expiresAt?: number
  refreshExpiresAt?: number
  /** The sibling tool's original credential document, preserved verbatim. */
  auth_raw?: unknown
}

/** The export answer: the records themselves, tokens included. */
export interface WorkBuddyTransferExportAnswer {
  accounts: WorkBuddyTransferRecord[]
}

/** Read the per-row account id off a request URL, when the action takes one. */
export function poolAccountIdOf(url: string): string | undefined {
  const at = url.indexOf('?')
  if (at === -1) return undefined
  const value = new URLSearchParams(url.slice(at + 1)).get(WORKBUDDY_POOL_ACCOUNT_PARAM)
  return value !== null && value !== '' ? value : undefined
}

/** Address one region's pool endpoint with an action. */
export function withWorkBuddyRegionAndAction(
  path: string,
  region: WorkBuddyWebRegion,
  action: WorkBuddyPoolAction,
): string {
  return `${withWorkBuddyRegion(path, region)}&${WORKBUDDY_POOL_ACTION_PARAM}=${action}`
}

/** Every action the shared `action` query parameter can carry. */
export type WorkBuddyRouteAction = WorkBuddyPoolAction | WorkBuddyTransferAction | WorkBuddyOAuthAction

/**
 * Address one region's endpoint for ANY route that dispatches on `action`.
 *
 * The OAuth and transfer routes reject a request with no action (400), so
 * their callers must build the URL here rather than with
 * {@link withWorkBuddyRegion} — a request missing the parameter fails the same
 * way whether the omission was a mistake or not.
 */
export function withWorkBuddyRouteAction(
  path: string,
  region: WorkBuddyWebRegion,
  action: WorkBuddyRouteAction,
): string {
  return `${withWorkBuddyRegion(path, region)}&${WORKBUDDY_POOL_ACTION_PARAM}=${action}`
}

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
/**
 * Build the next `regions` settings value for a MODEL-LIST save.
 *
 * The model save replaces a region slot wholesale, so the merge has to start
 * from the EXISTING slot rather than from a fresh object: the pool's
 * preferences live in that same slot, and a save that omitted them would delete
 * settings the user configured elsewhere in the card. Every writer that owns
 * only part of a slot goes through a helper like this one.
 */
export function nextRegionModels(
  value: unknown,
  region: WorkBuddyWebRegion,
  models: Record<string, unknown>,
): Record<string, unknown> {
  return nextRegionSlots(regionsMapOf(value), region, {
    ...regionSlotOf(value, region),
    ...models,
  })
}

/**
 * Build the next `regions` settings value for a POOL-PREFERENCES save.
 *
 * Same reasoning as {@link nextRegionModels}: the pool is one field of a slot
 * that also holds the model list, so the merge starts from the existing slot.
 */
export function nextRegionPool(
  value: unknown,
  region: WorkBuddyWebRegion,
  pool: Record<string, unknown>,
): Record<string, unknown> {
  return nextRegionSlots(regionsMapOf(value), region, {
    ...regionSlotOf(value, region),
    pool,
  })
}

export function nextRegionEnabled(
  value: unknown,
  region: WorkBuddyWebRegion,
  enabled: boolean,
): Record<string, unknown> {
  return nextRegionSlots(regionsMapOf(value), region, { ...regionSlotOf(value, region), enabled })
}

/**
 * Whether one region's sidebar credit line is shown. Opt-out: only an explicit
 * `false` hides it, so a config written before this switch existed keeps the
 * line visible exactly as a fresh install does.
 *
 * Per-REGION by construction (it reads one region's slot), which is the point:
 * WB CN and WB AI are separate accounts on separate gateways, so "show credits"
 * is not one decision. `value` may be the whole settings section or the
 * `regions` map itself.
 */
export function regionCreditsShownOf(value: unknown, region: WorkBuddyWebRegion): boolean {
  return regionSlotOf(value, region)['showCreditsInMainUi'] !== false
}

/**
 * Build the next `regions` settings value for the sidebar-credit on/off toggle.
 *
 * Same merge rule as {@link nextRegionEnabled}: ONLY the target region's flag
 * changes, so every other field of that slot (directory, selection, pool
 * preferences) and every other region's slot survive the write.
 */
export function nextRegionCreditsShown(
  value: unknown,
  region: WorkBuddyWebRegion,
  shown: boolean,
): Record<string, unknown> {
  return nextRegionSlots(regionsMapOf(value), region, {
    ...regionSlotOf(value, region),
    showCreditsInMainUi: shown,
  })
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
  /**
   * Native maximum advertised by WorkBuddy, never clamped by a default.
   *
   * Models above 200K expose the tier selector (200K / 500K / max); whether the
   * window is actually reduced is the user's stored `contextBudgets` decision
   * and nothing else — see issue #33.
   */
  nativeContextWindow: number
  maxTokens: number
  creditMultiplier?: number
  /**
   * Upstream's own image-input default from the latest refresh. Used ONLY to
   * pre-fill the image checkboxes when "Refresh from WorkBuddy" overwrites the
   * draft; it is not the effective capability. Persisted inside `lastCatalog`
   * (it rides along in the saved entries) but never read as the runtime flag —
   * that stays `imageModelIds` → stamped `multimodal`.
   */
  supportsImages?: boolean
  multimodal?: boolean
  reasoning?: {
    supportedEfforts?: readonly string[]
    defaultEffort?: string
    /**
     * Upstream's own "thinking can be turned off" declaration, carried through
     * the card so it RIDES ALONG in the saved `lastCatalog` entry.
     *
     * It is a persistence detail, not the runtime answer: the adapter's level
     * map is built from the effective value stamped in `index.ts` (declaration
     * minus the models known to reject `off`, then the user's override). It has
     * to travel because the card writes the whole row back on save — omitting
     * it made one Save silently strip the declaration from every model, which
     * withdrew `off` from the models that accept it (the default is
     * conservative: an absent declaration never offers `off`, so `hy4-preview`
     * and friends keep their intended `false` but the rest lose a working
     * level). Same shape as `supportsImages` above.
     */
    canDisableThinking?: boolean
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

/**
 * One account's credit balance, for the composer panel's table.
 *
 * `credits` is ABSENT when that account's balance could not be read — a
 * credential that no longer resolves, or an upstream that refused. Deliberately
 * not `0`: a zero is a claim about the account, and the panel renders an absent
 * figure as "—" instead of telling the user they are out of credits.
 */
export interface WorkBuddyWebAccountCredit {
  id: string
  accountName: string
  selected: boolean
  credits?: number
  /**
   * Why this account cannot serve right now, or absent when nothing is wrong
   * (or nothing has been measured yet).
   *
   * The composer panel marks the row with this so the user can see, before
   * switching, that an account is rate-limited — otherwise the table would
   * present an exhausted account as an equally good choice.
   */
  excludedBy?: WorkBuddyWebPoolExclusion
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
    /**
     * Whether this region's sidebar credit line is shown.
     *
     * Carried on the Host's answer rather than read from the browser settings
     * mirror, for the same measured reason as `contextBudgets`: on the affected
     * 0.1.7 deployment the mirror never picks up this plugin's writes (a save
     * through the Host endpoint leaves it stale), so a control reading it kept
     * showing the old value and looked like it could not be turned off — the
     * "关闭不了" report.
     */
    showCreditsInMainUi?: boolean
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
    /**
     * Whether this region's sidebar credit line is shown. See the signed-out
     * variant for why this travels on the Host's answer instead of the browser
     * settings mirror.
     */
    showCreditsInMainUi?: boolean
    source?: 'desktop' | 'dsh'
    tokenExpiresAtMs: number
    /** A saved per-region choice is in effect (false = following the app). */
    selectionExplicit: boolean
    accounts: readonly WorkBuddyWebAccount[]
    models: readonly WorkBuddyWebModel[]
    enabledModelIds: readonly string[]
    imageModelIds: readonly string[]
    /**
     * Model ids whose `off` thinking level is offered (issue #34): the saved
     * selection, seeded from the built-in rule the first time it is read.
     */
    offModelIds: readonly string[]
    credits?: WorkBuddyWebCredits
    creditsError?: string
    /**
     * The LAST refresh failed, but the snapshot below is intact.
     *
     * A failed usage re-read must not blank the panel. The account picker,
     * credits, model directory and account pool are all gated on this region
     * being 'signed-in', so collapsing the whole snapshot into the union's
     * `{ status: 'error' }` variant (which carries no data at all) hides every
     * one of them — including a pool the user is midway through editing. It
     * reads as "the plugin lost my configuration". Carrying the failure as an
     * overlay keeps the last good directory on screen with a banner above it,
     * which is also what `creditsError`/`checkinError` already do per section.
     *
     * Only ever set on a snapshot that WAS healthy; a region that never loaded
     * still reports the plain `{ status: 'error' }` so it can show the
     * sign-in guidance instead of an empty panel.
     */
    refreshError?: string
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
     * This region's account-pool state, when the Host supports it.
     *
     * Absent on a Host without pool support, so the card renders no pool
     * section instead of an empty one.
     */
    pool?: WorkBuddyWebPool
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
 * Outcome vocabulary of one model probe, shared by the Host and the card.
 *
 * Mirrors `WorkBuddyProbeOutcome` in `./probe.ts`; kept as its own declaration
 * here because this module is the node-free bridge and must not import the
 * Host-side probe module (which pulls in the credential type).
 */
export type WorkBuddyWebProbeOutcome =
  | 'ok'
  | 'rate-limited'
  | 'out-of-credit'
  | 'credential-rejected'
  | 'policy-rejected'
  | 'unavailable'
  | 'not-found'
  | 'failed'

/** One model's probe result, as the card renders it. */
export interface WorkBuddyWebProbeResult {
  modelId: string
  outcome: WorkBuddyWebProbeOutcome
  /** Round-trip time in ms; present once the request landed. */
  elapsedMs?: number
  /** HTTP status the upstream answered with; 0 means it never landed. */
  status?: number
  /** Upstream's own words, already redacted. */
  message?: string
  /**
   * A time the upstream named for using this model again, in ms.
   *
   * ABSENT means the upstream named none, and the card must say exactly that.
   * A client-invented countdown here would be fiction. Three sources fill it:
   * a real `Retry-After` header; the reset sentence the upstream writes into
   * its own failure BODY (`将在 … UTC+8 重置`, which is where this service
   * actually puts it — its 429s carry no rate-limit header at all); or, for an
   * exhausted quota, the region's own quota refresh point.
   */
  retryAtMs?: number
  /** Which of those three sources supplied {@link retryAtMs}. */
  retrySource?: 'retry-after' | 'upstream-message' | 'quota-refresh'
}

/** The probe endpoint's answer document. */
export interface WorkBuddyWebProbeAnswer {
  results: readonly WorkBuddyWebProbeResult[]
}

/** Why one account is currently out of the pool. */
export type WorkBuddyWebPoolExclusion =
  | 'unusable'
  | 'rate-limited'
  | 'out-of-credit'
  | 'credential-rejected'
  | 'not-found'
  | 'unavailable'
  | 'failed'

/**
 * One account's row in the pool, as the card renders it.
 *
 * Ties together the three facts the card shows per account — credits, the last
 * test, and whether it is currently eligible — so the ranking the card displays
 * comes from ONE Host answer rather than being re-derived in the browser.
 */
export interface WorkBuddyWebPoolAccount {
  accountId: string
  accountName: string
  /** Total remaining credits, absent when the credits route failed. */
  credits?: number
  /** Credits expiring within 3 days. */
  expiringSoon?: number
  /** When the nearest package expires, in ms. */
  nearestExpiryMs?: number
  /** The last test of the target model, absent when never tested. */
  probe?: {
    outcome: WorkBuddyWebProbeOutcome
    atMs: number
    /**
     * What wrote this measurement, so the card can explain a change the user
     * watched happen: `test-batch` is a deliberate test, `live-request` is a
     * real request that failed and overwrote it. ABSENT for records written
     * before the field existed — the card must then say "unknown" rather than
     * guess which of the two it was.
     */
    source?: 'test-batch' | 'live-request'
    /** Only when the upstream named a time; never invented locally. */
    retryAtMs?: number
    /**
     * Why it failed, in the upstream's own redacted words.
     *
     * Carried so the pool table can distinguish a DNS failure from a gateway
     * 502 from a request the user cancelled, instead of repeating one generic
     * sentence for all three. ABSENT on success and on measurements written
     * before this field existed, so the card must render the bare outcome then.
     */
    message?: string
  }
  /** Set when this account cannot serve right now. */
  excludedBy?: WorkBuddyWebPoolExclusion
  /** Whether this is the account currently billing traffic for the region. */
  current: boolean
  /**
   * Whether the user checked this account into the pool.
   *
   * Listed rows include UNCHECKED accounts so the card can offer them to check:
   * membership is an explicit opt-in, and a user can only opt in to something
   * they can see. Only checked rows can bill or be batched.
   */
  member: boolean
  /**
   * Today's check-in state for this account.
   *
   * ABSENT means it was not read — the card must then say so rather than
   * rendering a definite "not checked in", which would contradict the check-in
   * result the user just watched succeed.
   */
  checkedInToday?: boolean
}

/**
 * The pool's state for one region.
 *
 * `targetModelId`/`targetModelSource` exist so the card can state WHICH model a
 * test would use and WHERE that choice came from. `none` is a real, common
 * answer (the CN catalog carries no free model until its first refresh) and the
 * card must render it as "no free model" rather than silently substituting a
 * paid one.
 */
export interface WorkBuddyWebPool {
  enabled: boolean
  /**
   * Whether this region offers the daily check-in at all.
   *
   * The card hides the action entirely when false, rather than rendering a
   * button whose only outcome is a refusal.
   */
  checkinSupported: boolean
  /** The model a test would use right now; absent when none can be resolved. */
  targetModelId?: string
  /**
   * The saved target id that is no longer offered by this region's catalog.
   *
   * Present only when {@link targetModelSource} is `'stale'`. The card says so
   * and offers a way back to automatic, instead of enabling a test button that
   * would run against a model the upstream does not offer.
   */
  staleTargetModelId?: string
  /**
   * Where the target came from. `'stale'` means the SAVED id is no longer in
   * the catalog — a distinct state from `'none'` (no free model exists),
   * because the two need opposite advice.
   */
  targetModelSource: 'preferred' | 'free' | 'none' | 'stale'
  /** The account ids the user has checked into this region's pool. */
  memberAccountIds?: readonly string[]
  /**
   * Tokens each test probe sends, as the user saved it; `0`/absent = default.
   *
   * The SAVED value, not the resolved one: the card needs to tell "the user
   * never chose a size" apart from "the user chose 25000", because the first
   * must keep showing the default option rather than a number they never picked.
   */
  probeInputTokens?: number
  /**
   * The subset of {@link memberAccountIds} that resolves to a real local
   * sign-in — i.e. what a batch actually runs on.
   *
   * Sent so the card never re-derives it: counting the raw saved list is what
   * let the UI claim "1 of 1 selected" and enable both buttons while the Host
   * ran on ZERO accounts and reported success.
   */
  effectiveMemberAccountIds?: readonly string[]
  accounts: readonly WorkBuddyWebPoolAccount[]
  /**
   * The models a manual target can be chosen from.
   *
   * TRIMMED to what the picker renders (id, name, multiplier) rather than the
   * full `WorkBuddyWebModel` roster: the model table above already ships that
   * roster in the same document, and this block is re-read on every 60-second
   * poll, so carrying the full records here duplicated the whole catalog twice
   * per response for three fields.
   */
  catalog?: readonly WorkBuddyWebPoolModel[]
}

/** One account's check-in row, as the card renders it. */
export interface WorkBuddyWebPoolCheckinRow {
  accountId: string
  accountName: string
  status: 'claimed' | 'already' | 'failed'
  credit?: number
  streakDays?: number
  message?: string
}

/** One account's test row, as the card renders it. */
export interface WorkBuddyWebPoolTestRow {
  accountId: string
  accountName: string
  result: WorkBuddyWebProbeResult
}

/** One model as the pool's target picker needs it. */
export interface WorkBuddyWebPoolModel {
  id: string
  name: string
  /** Absent when the upstream stated no multiplier (NOT the same as free). */
  creditMultiplier?: number
}

/** The pool endpoint's answer for `action=checkin`. */
export interface WorkBuddyWebPoolCheckinAnswer {
  action: 'checkin'
  rows: readonly WorkBuddyWebPoolCheckinRow[]
}

/** The pool endpoint's answer for `action=test`. */
export interface WorkBuddyWebPoolTestAnswer {
  action: 'test'
  /** The model actually tested; absent when none could be resolved. */
  modelId?: string
  rows: readonly WorkBuddyWebPoolTestRow[]
}

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
