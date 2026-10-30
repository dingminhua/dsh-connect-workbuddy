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

import type { WorkBuddyBusyLevel } from './busy.ts'
import type { WorkBuddyPromo } from './promo.ts'

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
/**
 * The page where a human claims a benefit: 「套餐与积分」.
 *
 * Named here rather than inline in the card because it is the page the benefit
 * line points at when the plugin itself declines to claim (an unknown campaign
 * kind). One constant keeps that pointer honest if the page moves.
 */
export const WORKBUDDY_PLAN_URL = 'https://www.workbuddy.cn/profile/plans-usage'
/**
 * Plugin-owned benefit claim endpoint: POST + loopback, ONE account per call.
 *
 * A credit grant is a write on a real account, so it carries the same guards as
 * check-in, plus `?accountId=` because the pool can hold accounts this plugin
 * did not pick. There is deliberately no batch action here — see
 * `claimBenefit` and the route handler.
 */
export const WORKBUDDY_BENEFIT_CLAIM_PATH = '/plugins/dsh-connect-workbuddy/benefit/claim'
/** Plugin-owned live model refresh endpoint. */
export const WORKBUDDY_MODELS_REFRESH_PATH = '/plugins/dsh-connect-workbuddy/models/refresh'
/**
 * Plugin-owned MEDIA model list endpoint (image + video, read from the region's
 * `/v3/config`).
 *
 * Separate from {@link WORKBUDDY_MODELS_REFRESH_PATH} because it answers a
 * different question from a different document projection: the refresh route
 * returns the CHAT roster, from which `selectCliModels` drops every media
 * entry, while this one keeps the `text-to-image`/`image-to-image`/
 * `text-to-video`/`image-to-video` rows the card lists. Read-only and free —
 * it is the same GET the image tool already performs.
 */
export const WORKBUDDY_MEDIA_MODELS_PATH = '/plugins/dsh-connect-workbuddy/media-models'
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
 * Plugin-owned OUTPUT-SPEED measurement endpoint (issue #92).
 *
 * Separate from {@link WORKBUDDY_PROBE_PATH} because the two ask opposite
 * questions and cost different amounts: the availability probe sends 25,000
 * input tokens and caps output at one (measured `credit 0.72`), while this one
 * sends ~35 input tokens and caps output at 256 (measured `credit 0.01`–`0.15`).
 * Sharing the route would mean sharing its one-model-per-request cap and its
 * cost wording, and the two would then be wrong for each other.
 */
export const WORKBUDDY_TPS_PATH = '/plugins/dsh-connect-workbuddy/tps'

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

/**
 * The CLI route's live turns, for the composer readout.
 *
 * A GET with no parameters and no region: a live turn is not scoped to a
 * credential region (it is one spawned process), and the chip polls this on an
 * interval, so it must stay cheap — the handler reads an in-memory board and
 * serializes it, touching no upstream and no disk.
 *
 * The document is `{ turns: LiveTurnView[], serverTime: number }`. `serverTime`
 * is the host's clock at serialization so the browser can derive an age from
 * `startedAt` without trusting the two clocks to agree.
 */
export const WORKBUDDY_CLI_LIVE_PATH = '/plugins/dsh-connect-workbuddy/cli-live'

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
 * Query parameter selecting how much of a status document the Host assembles.
 *
 * The card's first paint only needs what local state already knows; live
 * figures (credit, check-in, per-account readings) arrive through the SAME
 * route once they have been measured. See {@link WORKBUDDY_DETAIL_FAST}.
 */
export const WORKBUDDY_DETAIL_PARAM = 'detail'

/**
 * The `detail` value asking for the first-paint document.
 *
 * Absent means the full document, which is what every earlier caller asks for
 * and what the route keeps answering — the parameter only ever ADDS a cheap
 * mode, it never changes an existing one.
 */
export const WORKBUDDY_DETAIL_FAST = 'fast'

/**
 * Address one region's status route for its first-paint document.
 *
 * The Host answers this from local state only (no upstream read, no token
 * refresh), so a slow billing endpoint cannot decide when the account list
 * appears. The card paints it first and then upgrades the same snapshot from
 * the full document.
 */
export function withWorkBuddyRegionFastDetail(path: string, region: WorkBuddyWebRegion): string {
  return `${withWorkBuddyRegion(path, region)}&${WORKBUDDY_DETAIL_PARAM}=${WORKBUDDY_DETAIL_FAST}`
}

/**
 * Whether a status-route URL asks for the first-paint document.
 *
 * Only the exact `fast` value is recognized: an unknown or misspelled value
 * degrades to the full document, which is what every earlier caller already
 * gets. A typo must never produce an emptier panel than no parameter at all.
 */
export function fastDetailOf(url: string): boolean {
  const at = url.indexOf('?')
  if (at === -1) return false
  return new URLSearchParams(url.slice(at + 1)).get(WORKBUDDY_DETAIL_PARAM) === WORKBUDDY_DETAIL_FAST
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
 *
 * THE HOP IS CONDITIONAL, and that is the whole point (a saved manual pool
 * order "disappearing"). "Has a `regions` key" is NOT sufficient evidence that
 * the caller passed the whole section: the `regions` MAP can legitimately carry
 * a `regions` key of its own, because an earlier build could write a sibling
 * field name into it — a live profile was found with `accounts`, `regions` and
 * `cliBridge` sitting beside `cn` / `global`. Hopping there means reading a
 * DIFFERENT, older copy of the same region: measured, the same document returned
 * `['c','a','b']` when read as a section and `[]` when read as a map. So a value
 * counts as the whole section only when it shows a key that is neither a region
 * id nor a known sibling — i.e. it looks like a settings document. A plain (or
 * dirty) `cn` / `global` map is returned as-is.
 *
 * THE RESULT IS HEALED, not merely narrowed — see {@link healedRegionsMap}.
 * Returning the map "as-is" is what let a corrupted document keep reading as
 * half-empty: the field held `cn` at level 0 and `global` only one level down,
 * so every `global` question answered "never configured" even though the file
 * still had the answer. Reads and writes both come through here, so healing
 * here fixes both halves at once (the Host's `regionStateOf`, the card's
 * `nextRegion*` write bases, and the catalog repair's write).
 */
export function regionsMapOf(value: unknown): Record<string, unknown> {
  // FAST PATH, and it is load-bearing for latency: the Host's `regionStateOf`
  // comes through here on every request (pool switch, model selection, catalog,
  // credit gate), and the slow path DEEP-COPIES the whole field — including a
  // 28-model directory per region. Measured on that shape: 11 µs per call
  // against 0.05 µs for the bare lookup it replaced, i.e. a real regression on
  // an interactive path for a field that is clean in every profile this bug
  // never touched.
  //
  // A field is already healed when it has no nested `regions` copy and no
  // sibling-field names; then it can be returned as the object it is. This is
  // sound because only the FIELD is declared volatile — the slots inside it are
  // stored plain data, so there is no nested live reference for the deep copy to
  // peel (that is what the section-level `accounts` / `regions` references need,
  // and those are handled by the slow path).
  const peeled = peelLiveReference(value)
  if (typeof peeled === 'object' && peeled !== null && !Array.isArray(peeled)) {
    const candidate = peeled as Record<string, unknown>
    if (!isRecord(candidate['regions']) && !carriesForeignKey(candidate)) return candidate
  }

  const unwrapped = unwrapVolatileDeep(value)
  if (typeof unwrapped !== 'object' || unwrapped === null || Array.isArray(unwrapped)) return {}
  const record = unwrapped as Record<string, unknown>
  const nested = record['regions']
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) {
    return healedRegionsMap(record)
  }
  // Both shapes are objects and both may carry `regions`. Decide by asking which
  // one IS a region map: a map's keys are region ids (possibly plus stray
  // sibling names left by an old writer). If the OUTER object has at least one
  // region id, it is the map — hopping would land on a different, older copy of
  // the same region (measured: `['c','a','b']` as a section, `[]` as a map).
  return healedRegionsMap(hasRegionKey(record) ? record : nested as Record<string, unknown>)
}

/** `value` with ONE `{get(): T}` live reference peeled, exactly like a read. */
function peelLiveReference(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const get = (value as { get?: unknown }).get
  return typeof get === 'function' ? (get as () => unknown)() : value
}

/** Whether the object carries a sibling-field name where a region id belongs. */
function carriesForeignKey(record: Record<string, unknown>): boolean {
  return Object.keys(record).some(key => REGION_MAP_FOREIGN_KEYS.has(key))
}

/**
 * Names that belong to the settings SECTION (`Config` in `src/index.ts`) or to
 * one region SLOT (`regionStateConfig`) — never to the `regions` map.
 *
 * They are the signature of a data-loss bug and the list that undoes it. From
 * 5.4.0 to 5.5.0 `mergeRegionCatalog` was handed the WHOLE settings section but
 * read it as the `regions` field, so every boot's directory repair wrote
 * `{ accounts, regions, cliBridge }` INTO the field — replacing the region map
 * and burying the real one under a `regions` key. A live profile ended up five
 * levels deep (one per startup) and 258 KB of duplicated slots.
 *
 * Neither a region id (`cn` / `global`) nor any future one can collide with
 * these names, so removing them from the map is safe, idempotent, and does not
 * discard a region that a newer build might add.
 */
const REGION_MAP_FOREIGN_KEYS: ReadonlySet<string> = new Set([
  // The section's own fields.
  'authFile', 'accountId', 'accounts', 'regions', 'cliBridge',
  // One region slot's fields.
  'enabled', 'showCreditsInMainUi', 'creditPosition', 'lastCatalog',
  'enabledModelIds', 'imageModelIds', 'imageToolEnabled', 'offModelIds',
  'contextBudgets', 'defaultThinkingEfforts', 'pool',
])

/** A non-null, non-array object: the only shape a slot or a level can have. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a map carries at least one real region id. */
function hasRegionKey(map: Record<string, unknown>): boolean {
  return Object.keys(map).some(key => (WORKBUDDY_REGIONS as readonly string[]).includes(key))
}

/**
 * How much USER CONFIG one candidate slot actually carries.
 *
 * Used only when the map lost a region and the copies left at different depths
 * disagree — and they do: the bug's own directory repair wrote a slot that held
 * nothing but `lastCatalog` (it started from a map where the region was already
 * missing), while the copy further down still holds the pool the user had
 * checked in. "Shallowest wins" would therefore resurrect the EMPTY one and
 * throw away the real configuration. Depth is not age in this wreckage; CONTENT
 * is the only usable signal.
 *
 * Deliberately counts only non-default, user-authored values: resolved slots
 * carry every schema default, so a slot's key count says nothing.
 */
function slotConfigWeight(slot: Record<string, unknown>): number {
  let weight = 0
  const pool = slot['pool']
  if (isRecord(pool)) {
    if (pool['enabled'] === true) weight += 4
    if (Array.isArray(pool['memberAccountIds']) && pool['memberAccountIds'].length > 0) weight += 4
    if (Array.isArray(pool['orderAccountIds']) && pool['orderAccountIds'].length > 0) weight += 2
    if (typeof pool['targetModelId'] === 'string' && pool['targetModelId'] !== '') weight += 2
    if (typeof pool['probeInputTokens'] === 'number' && pool['probeInputTokens'] > 0) weight += 1
  }
  for (const key of ['enabledModelIds', 'imageModelIds', 'offModelIds'] as const) {
    const list = slot[key]
    if (Array.isArray(list) && list.length > 0) weight += 1
  }
  const budgets = slot['contextBudgets']
  if (isRecord(budgets) && Object.keys(budgets).length > 0) weight += 1
  // Opt-outs are user decisions too, and the defaults are all `true` / `false`.
  if (slot['enabled'] === false) weight += 1
  if (slot['showCreditsInMainUi'] === false) weight += 1
  if (slot['imageToolEnabled'] === true) weight += 1
  return weight
}

/**
 * The `regions` map with a corrupted document's wreckage removed.
 *
 * Two repairs, both keyed on the bug's signature (a foreign key or a nested
 * `regions` copy) so a HEALTHY map passes through untouched:
 *
 *  1. DROP every key that names a section field or a slot field. Those are the
 *     copies the bug wrote; keeping them means the next save carries them
 *     forward forever.
 *  2. RECOVER a region this level does not have from the copies buried beneath
 *     it. A region that IS here is never replaced — the outer copy is the one
 *     the surviving writers have been updating, and re-reading a stale inner
 *     copy over it is exactly the defect the shape rule above was fixed for.
 *
 * Recovery exists because `global` in the measured profile lived ONLY one level
 * down: without it, the host reads that region as "never configured" and the
 * first write after the fix would delete the user's international pool outright.
 *
 * Among the buried copies of a MISSING region, the one carrying the most user
 * configuration wins rather than the shallowest — see {@link slotConfigWeight}:
 * the bug's own directory repair left `{ lastCatalog }` slots that look newer
 * but hold nothing, one level above the copy with the pool still in it.
 */
function healedRegionsMap(map: Record<string, unknown>): Record<string, unknown> {
  const healed: Record<string, unknown> = {}
  for (const [key, slot] of Object.entries(map)) {
    if (REGION_MAP_FOREIGN_KEYS.has(key)) continue
    healed[key] = slot
  }
  const recovered: Record<string, { slot: Record<string, unknown>, weight: number }> = {}
  let deeper = map
  // Bounded: the measured profile was five levels deep. A number rather than
  // `while (true)` because a self-referencing object is representable in a
  // settings document and this function must never hang a read.
  for (let depth = 0; depth < 8; depth += 1) {
    const nested = deeper['regions']
    if (!isRecord(nested)) break
    for (const region of WORKBUDDY_REGIONS as readonly string[]) {
      // PRESENT at this level — by key, not by shape: an emptied slot is stored
      // as `null` (schemastery simplifies `{}` to `null`), and that is an
      // explicit "nothing configured". Recovering over it would resurrect a pool
      // the user had cleared, so presence alone is what protects the outer copy.
      if (region in map) continue
      const candidate = nested[region]
      if (!isRecord(candidate)) continue
      const weight = slotConfigWeight(candidate)
      const best = recovered[region]
      // `>` not `>=`: on equal weight the shallower copy stays, which makes the
      // choice stable and prefers the copy written most recently.
      if (best === undefined || weight > best.weight) recovered[region] = { slot: candidate, weight }
    }
    deeper = nested
  }
  for (const [region, entry] of Object.entries(recovered)) healed[region] = entry.slot
  return healed
}

/**
 * Whether the stored `regions` FIELD still carries the debris described at
 * {@link REGION_MAP_FOREIGN_KEYS}.
 *
 * Pass the field itself (`Config['regions']`), not the whole section: the
 * section legitimately has `accounts` / `cliBridge` beside `regions`, so asking
 * that question of a section would always answer "corrupt".
 *
 * The catalog repair uses it to write even when the model directory already
 * matches: without that, a profile whose directory is in agreement would never
 * be cleaned — the very shape that made the pool look unsaved would outlive the
 * fix that stops producing it.
 */
export function regionsFieldIsCorrupt(value: unknown): boolean {
  const unwrapped = unwrapVolatileDeep(value)
  if (!isRecord(unwrapped)) return false
  return Object.keys(unwrapped).some(key => REGION_MAP_FOREIGN_KEYS.has(key))
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
 * The per-region account SELECTIONS map (`Config.accounts`), as plain data.
 *
 * `value` may be the whole settings SECTION or the `accounts` FIELD: `describe()`
 * hands back the section with volatile fields as live references, and a blind
 * spread of that leaks the `get()` function into a write payload — the settings
 * service then refuses the whole save with `found a function at $.ops[0].value.get`
 * (measured at the card's save endpoint, `src/web-status.ts`). Unwrapping first is
 * what makes the merge carry data and not behaviour.
 *
 * The map is recognised by its KEYS, not by its shape: only region ids can appear
 * in it, while a section always carries at least one non-region key (`authFile`,
 * `regions`, `cliBridge`). Same direction as {@link regionsMapOf} chose for the
 * reason documented there — a nested copy is a DIFFERENT, older value, so the
 * outer object's own keys decide what it is.
 */
export function accountsMapOf(value: unknown): Record<string, unknown> {
  const unwrapped = unwrapVolatileDeep(value)
  if (!isRecord(unwrapped)) return {}
  if (hasRegionKey(unwrapped)) return unwrapped
  const nested = unwrapVolatileDeep(unwrapped['accounts'])
  return isRecord(nested) ? nested : {}
}

/**
 * Build the next `accounts` FIELD for one region's selection.
 *
 * ONLY the target region's key changes; the sibling region is carried over
 * verbatim. `accounts` is a flat two-key map that BOTH regions write, so a
 * whole-field write that rebuilt it from one caller's view would drop the other
 * region's pin — the failure mode every other `next*` helper in this file exists
 * to prevent, in a field that is easier to clobber because it looks trivial.
 *
 * The value is written as given, including `''`. That distinction is load-bearing
 * and not a detail: `''` is the Clear sentinel ("this region follows the app's
 * current sign-in"), while an ABSENT key means "never configured" and still falls
 * back to the legacy flat `accountId` — see `selectAccountFor`. A helper that
 * deleted the key to "clear" a region would silently re-bind it to whichever
 * account the legacy field names.
 */
export function nextAccountsSelection(
  value: unknown,
  region: WorkBuddyWebRegion,
  accountId: string,
): Record<string, unknown> {
  return { ...accountsMapOf(value), [region]: accountId }
}

/**
 * Whether one region's selection is PERSISTENTLY bound to this account id.
 *
 * THE QUESTION {@link nextAccountsSelection} MUST ANSWER BEFORE WRITING. Two
 * persisted sources can pin an account, and clearing only the obvious one leaves
 * the other in place:
 *
 * 1. `accounts[region]` — the per-region slot, the current spelling.
 * 2. the deprecated flat `accountId`, which `selectAccountFor` falls back to for
 *    the ONE region the startup scan attributed it to (`legacyAccountRegion`) and
 *    only when that region's slot is ABSENT. A pre-split profile therefore pins
 *    its account through field 2 while field 1 holds nothing at all — and that
 *    is precisely a profile whose user can remove an account and inherit an
 *    orphaned pin.
 *
 * `accounts[region] === ''` answers `false` even when the id matches nothing: the
 * sentinel means "this region follows the app's current sign-in", which already
 * cannot point at a dead account, so there is nothing to clear and a write would
 * be noise (and a needless settings round trip).
 *
 * @param value the resolved settings section, or the `accounts` field.
 * @param region the region whose pin is being questioned.
 * @param accountId the account about to be removed.
 * @param legacyAccountId the deprecated flat `accountId`, read as persisted.
 * @param legacyRegion which region the startup scan attributed that flat id to.
 */
export function regionPinsAccount(
  value: unknown,
  region: WorkBuddyWebRegion,
  accountId: string,
  legacyAccountId?: string,
  legacyRegion?: WorkBuddyWebRegion,
): boolean {
  const configured = accountsMapOf(value)[region]
  if (configured !== undefined) return configured === accountId
  return legacyAccountId !== undefined
    && legacyAccountId === accountId
    && legacyRegion === region
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
 * Whether the model may call the image-generation tool in one region.
 *
 * OPT-IN, unlike every other switch in this file: absent reads as `false`. The
 * asymmetry is deliberate. The credit line and the provider switch are things
 * whose absence should behave like a fresh install (on), because a hidden line
 * or a withdrawn provider is recoverable by clicking. This one authorizes the
 * MODEL to spend credits on its own — about 5.71 per image, with no per-call
 * approval available in the host — so an upgrade or an unreadable setting must
 * leave it OFF rather than silently grant it.
 */
export function regionImageToolEnabledOf(value: unknown, region: WorkBuddyWebRegion): boolean {
  return regionSlotOf(value, region)['imageToolEnabled'] === true
}

export function regionVideoToolEnabledOf(value: unknown, region: WorkBuddyWebRegion): boolean {
  return regionSlotOf(value, region)['videoToolEnabled'] === true
}

/**
 * The video model pinned per tag in one region, or an empty record.
 *
 * A PIN, not an authorisation: reading it grants nothing, and an absent entry
 * merely means the tool takes that tag group's first model. Values are model ids
 * from the same region's catalog. A stale id is tolerated on purpose — a catalog
 * can drop a model the user had pinned, and that must not turn into a failed
 * generation (the tool falls back to the group's first model).
 */
export function regionPreferredVideoModelsOf(
  value: unknown,
  region: WorkBuddyWebRegion,
): Record<string, string> {
  const raw = regionSlotOf(value, region)['preferredVideoModels']
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Record<string, string> = {}
  for (const [tag, id] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof id === 'string' && id !== '') out[tag] = id
  }
  return out
}

/**
 * Build the next `regions` settings value for one pinned video model.
 *
 * `modelId` of `undefined` or `''` CLEARS that tag's pin, which is why this is
 * a three-state write rather than a boolean: the card's picker has a "no pin"
 * row, and deleting the key is what makes the absence mean "nothing pinned"
 * again (an empty string would be a value the tool would have to special-case).
 *
 * Same merge rule as the switches above: only this region's field changes.
 */
export function nextRegionPreferredVideoModels(
  value: unknown,
  region: WorkBuddyWebRegion,
  tag: string,
  modelId: string | undefined,
): Record<string, unknown> {
  const pinned = { ...regionPreferredVideoModelsOf(value, region) }
  if (modelId === undefined || modelId === '') delete pinned[tag]
  else pinned[tag] = modelId
  return nextRegionSlots(regionsMapOf(value), region, {
    ...regionSlotOf(value, region),
    preferredVideoModels: pinned,
  })
}

/**
 * The two seats the credit readout can occupy (issue #62).
 *
 * `composer` is the composer row (`conversation.input.right`, rendered just
 * before the model picker); `stats` is
 * the ambient dock below the composer card (`conversation.composer.dock`),
 * beside the shell's own round/step/token pills. Named as a union rather than a
 * boolean because a third seat is plausible and `showAtTop: boolean` would have
 * to be migrated rather than extended.
 */
export type WorkBuddyCreditPosition = 'composer' | 'stats'

/** The seat a region's readout uses, defaulting to the composer row. */
export function regionCreditPositionOf(value: unknown, region: WorkBuddyWebRegion): WorkBuddyCreditPosition {
  return regionSlotOf(value, region)['creditPosition'] === 'stats' ? 'stats' : 'composer'
}

/**
 * Build the next `regions` settings value for one region's credit seat.
 *
 * Same merge rule as {@link nextRegionCreditsShown}: only the target region's
 * field changes, so every other field of that slot and every other region's slot
 * survive the write.
 */
export function nextRegionCreditPosition(
  value: unknown,
  region: WorkBuddyWebRegion,
  position: WorkBuddyCreditPosition,
): Record<string, unknown> {
  return nextRegionSlots(regionsMapOf(value), region, {
    ...regionSlotOf(value, region),
    creditPosition: position,
  })
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

/**
 * Build the next `regions` settings value for the image-tool opt-in.
 *
 * Same merge rule: ONLY the target region's flag changes, so the directory,
 * the model selection and the sibling region survive the write.
 */
export function nextRegionImageToolEnabled(
  value: unknown,
  region: WorkBuddyWebRegion,
  enabled: boolean,
): Record<string, unknown> {
  return nextRegionSlots(regionsMapOf(value), region, {
    ...regionSlotOf(value, region),
    imageToolEnabled: enabled,
  })
}

export function nextRegionVideoToolEnabled(
  value: unknown,
  region: WorkBuddyWebRegion,
  enabled: boolean,
): Record<string, unknown> {
  return nextRegionSlots(regionsMapOf(value), region, {
    ...regionSlotOf(value, region),
    videoToolEnabled: enabled,
  })
}

/** One credit package as the upstream returns it, node-free. */
export interface WorkBuddyWebCreditPackage {
  packageName: string
  /** Capacity-pool balance (`CapacityRemain`); see the host-side type for issue #48. */
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

/**
 * One MEDIA model row (image / video) as the card's read-only roster shows it.
 *
 * Deliberately its own shape, not a subset of {@link WorkBuddyWebModel}: a
 * media entry carries `id`/`name`/`tags` and NOTHING else upstream (no price,
 * no context window), and it is never editable — the card has no media
 * checkbox, because each tag group holds exactly one model today and a
 * one-option picker is a fake choice.
 */
export interface WorkBuddyWebMediaModel {
  id: string
  name: string
  tags: readonly string[]
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
   * The model's load level, as read from the upstream's own probe.
   *
   * Carried so the CARD can draw it as an ICON. The host's model picker cannot
   * (its name is a plain string), which is why the picker gets a character and
   * the card gets a picture.
   *
   * ABSENT means "not measured right now" and is NOT the same as `normal`: the
   * card must not draw a level the upstream never stated. It is deliberately
   * not persisted into `lastCatalog` — load is a fact about this minute.
   */
  busyLevel?: WorkBuddyBusyLevel
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
    /**
     * This model is on the reviewed `off`-refusal table (`src/off-thinking.ts`),
     * so ticking its checkbox cannot take effect (issue #83).
     *
     * The verdict, derived on the host — not a stored preference, and not
     * something the card has to recompute. It exists so the card can explain a
     * tick that did not stick instead of leaving the user staring at a checkbox
     * that looks saved. Like every other `reasoning` field it rides along in
     * the saved `lastCatalog` entry, where it is ignored on load: the verdict is
     * always recomputed from `id`.
     */
    offRefused?: boolean
    /**
     * A REQUEST really carried `reasoning_effort: "off"` for this model and the
     * upstream answered HTTP 400 / code 11133 (issue #83).
     *
     * Row-level, DERIVED on write from the last refusal's `modelIdOfBody` —
     * never typed in by hand. Merged rather than replaced when the saved
     * catalog is refreshed, so the badge survives the full-table overwrite a
     * model refresh performs.
     */
    refusesOff?: boolean
  }
  description?: string
  /**
   * The upstream's promotion / tier badges that name this model, UNRESOLVED.
   *
   * Every candidate that names the model rides along, in priority order, so
   * the card can pick the one that holds at the moment it draws — a badge is a
   * function of the clock, and a badge frozen at fetch time would keep
   * claiming a night discount after the night is over. See `src/promo.ts`.
   *
   * Persisted inside `lastCatalog` (it rides along in the saved entries) and
   * read back from there, which is why it must stay JSON-shaped.
   */
  promos?: readonly WorkBuddyPromo[]
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
  /**
   * This account belongs to an enterprise (issue #124).
   *
   * Its credits come from the enterprise table and its check-in is refused by
   * the upstream (`10001`), so the card must not offer the action for it. The
   * field is a FACT about the credential (`enterpriseId` is present), not a
   * guess from `status.active`: that reads `false` for every enterprise member.
   */
  enterprise?: boolean
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
    /**
     * Whether the model may call the image-generation tool here (opt-in).
     *
     * Travels on the Host's answer for the same reason as the fields around it,
     * and matters more: a checkbox rendering a stale value would let the user
     * believe the spending capability was ON when it is off, or leave it on
     * after a switch-off that never landed.
     */
    imageToolEnabled?: boolean
    /**
     * Whether the model may call the video-generation tool here (opt-in).
     * Same opt-IN travel semantics as `imageToolEnabled` — an absent value
     * is NOT consent, so a stale mirror cannot leave the spending capability on.
     */
    videoToolEnabled?: boolean
    /**
     * The video model pinned per tag here (`text-to-video` /
     * `image-to-video`), as a model id from this region's catalog.
     *
     * Travels on the Host's answer for the same measured reason as the switches
     * above: the picker has to render the pin the TOOL will read, and the
     * browser settings mirror is stale for this namespace on the affected 0.1.7
     * deployments. Absent reads as "nothing pinned", never as a made-up id.
     */
    preferredVideoModels?: Readonly<Record<string, string>>
    /**
     * Whether the OPTIONAL CodeBuddy CLI route is mounted (tool `codebuddy_ask`
     * + command `/codebuddy`).
     *
     * GLOBAL, not per region: the route has ONE switch for both regions, so the
     * same value rides on every region's answer and the card reads it off the
     * active tab. Absent reads as OFF — this switch authorizes a child process
     * that edits files and spends CodeBuddy quota, so a Host that cannot answer
     * must not be read as consent.
     */
    cliBridgeEnabled?: boolean
    /**
     * The model the OPTIONAL CodeBuddy CLI route runs on, or `''` for
     * "nothing is pinned, the CLI uses its own default".
     *
     * GLOBAL like `cliBridgeEnabled`. Travels on the Host's answer for the
     * same measured reason: on the stale-mirror 0.1.7 deployment a picker that
     * read the settings mirror alone would keep showing a pin that had just
     * been cleared (or had not landed yet).
     */
    cliBridgeModel?: string
    /**
     * The reasoning effort the OPTIONAL CodeBuddy CLI route runs on, or `''`
     * for "nothing is pinned, the CLI uses its own default".
     *
     * GLOBAL and Host-carried for the same reasons as `cliBridgeModel`.
     */
    cliBridgeEffort?: string
    /**
     * The order the OPTIONAL CodeBuddy CLI route walks the credential
     * regions in — a comma-separated region list such as `'cn,global'` — or
     * `''` for "nothing is pinned, the CLI walks its own default order".
     *
     * GLOBAL and Host-carried for the same reasons as `cliBridgeModel`.
     */
    cliBridgeRegionOrder?: string
    /**
     * Whether the request path drops foreign thinking blocks (issue #147).
     *
     * Optional and absent reads as OFF: the repair changes bytes the upstream
     * counts, so a Host that cannot answer must not be read as consent.
     */
    dropForeignThinking?: boolean
    /**
     * What the LAST request had to drop, for the card's explanation of a turn
     * that arrived looking like working notes (issue #147).
     *
     * Absent means "no report", not "feature off" — the two are different facts
     * and the card says different things about them. Process-local and
     * last-wins: it describes the turn the reader is looking at.
     */
    lastForeignThinking?: {
      blocks: readonly { messageIndex: number, blockIndex: number, characters: number, variant: 'flattened' | 'dropped' }[]
      atMs: number
    }
    /**
     * The LIVE load level per model id, for the card's icon.
     *
     * A SEPARATE field from `models`, because the card's model list is the
     * SAVED roster (the one the user edits) and a saved roster has no load
     * level in it. Absent means "not measured right now" — never "normal".
     */
    busyLevels?: Readonly<Record<string, WorkBuddyBusyLevel>>
    /** WHERE this region's readout sits (issue #62); absent means `composer`. */
    creditPosition?: WorkBuddyCreditPosition
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
    /**
     * Whether the model may call the image-generation tool here (opt-in).
     *
     * Travels on the Host's answer for the same reason as the fields around it,
     * and matters more: a checkbox rendering a stale value would let the user
     * believe the spending capability was ON when it is off, or leave it on
     * after a switch-off that never landed.
     */
    imageToolEnabled?: boolean
    /**
     * Whether the model may call the video-generation tool here (opt-in).
     * Same opt-IN travel semantics as `imageToolEnabled`.
     */
    videoToolEnabled?: boolean
    /**
     * The video model pinned per tag here; see the signed-out variant for why
     * this travels on the Host's answer instead of the browser mirror.
     */
    preferredVideoModels?: Readonly<Record<string, string>>
    /**
     * Whether the OPTIONAL CodeBuddy CLI route is mounted (tool `codebuddy_ask`
     * + command `/codebuddy`).
     *
     * GLOBAL, not per region: the route has ONE switch for both regions, so the
     * same value rides on every region's answer and the card reads it off the
     * active tab. Absent reads as OFF — this switch authorizes a child process
     * that edits files and spends CodeBuddy quota, so a Host that cannot answer
     * must not be read as consent.
     */
    cliBridgeEnabled?: boolean
    /**
     * The model the OPTIONAL CodeBuddy CLI route runs on, or `''` for
     * "nothing is pinned, the CLI uses its own default".
     *
     * GLOBAL like `cliBridgeEnabled`. Travels on the Host's answer for the
     * same measured reason: on the stale-mirror 0.1.7 deployment a picker that
     * read the settings mirror alone would keep showing a pin that had just
     * been cleared (or had not landed yet).
     */
    cliBridgeModel?: string
    /**
     * The reasoning effort the OPTIONAL CodeBuddy CLI route runs on, or `''`
     * for "nothing is pinned, the CLI uses its own default".
     *
     * GLOBAL and Host-carried for the same reasons as `cliBridgeModel`.
     */
    cliBridgeEffort?: string
    /**
     * The order the OPTIONAL CodeBuddy CLI route walks the credential
     * regions in — a comma-separated region list such as `'cn,global'` — or
     * `''` for "nothing is pinned, the CLI walks its own default order".
     *
     * GLOBAL and Host-carried for the same reasons as `cliBridgeModel`.
     */
    cliBridgeRegionOrder?: string
    /**
     * Whether the request path drops foreign thinking blocks (issue #147).
     *
     * Optional and absent reads as OFF: the repair changes bytes the upstream
     * counts, so a Host that cannot answer must not be read as consent.
     */
    dropForeignThinking?: boolean
    /**
     * What the LAST request had to drop, for the card's explanation of a turn
     * that arrived looking like working notes (issue #147).
     *
     * Absent means "no report", not "feature off" — the two are different facts
     * and the card says different things about them. Process-local and
     * last-wins: it describes the turn the reader is looking at.
     */
    lastForeignThinking?: {
      blocks: readonly { messageIndex: number, blockIndex: number, characters: number, variant: 'flattened' | 'dropped' }[]
      atMs: number
    }
    /**
     * The LIVE load level per model id, for the card's icon.
     *
     * A SEPARATE field from `models`, because the card's model list is the
     * SAVED roster (the one the user edits) and a saved roster has no load
     * level in it. Absent means "not measured right now" — never "normal".
     */
    busyLevels?: Readonly<Record<string, WorkBuddyBusyLevel>>
    /** WHERE this region's readout sits (issue #62); absent means `composer`. */
    creditPosition?: WorkBuddyCreditPosition
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
    /**
     * Ids of THIS region's roster that this machine first saw inside the
     * new-model window, oldest first — the data behind the composer pill's
     * "· N 新模型" segment.
     *
     * "新" means "this machine first recorded the id in its catalog", NOT "the
     * gateway added it": the upstream list carries no listed-since field, so
     * claiming an upstream fact would be fabricating one. Absent means "nothing
     * is new right now" or "this Host predates the feature" — never "0".
     */
    newModelIds?: readonly string[]
    /**
     * A sentence explaining why no new-model readout is shown, present only
     * when the on-disk first-sighting history is in a version this build cannot
     * read. Kept separate from the field above so "no new models" is never the
     * story for a file that simply was not read.
     */
    rosterSeenVersionNote?: string
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
     * The per-model default thinking tiers the user saved (issue #179), keyed by
     * model id.
     *
     * Carried here for the same measured reason as {@link contextBudgets}: on the
     * affected 0.1.7 deployment the browser settings mirror never picks up a
     * write made through the Host save endpoint, so rendering this from a
     * snapshot made a successful choice look like it reverted.
     *
     * An absent key is not "no opinion": it means "follow this model's own
     * upstream `defaultEffort`", which is exactly what the card's first option
     * says out loud.
     */
    defaultThinkingEfforts?: Record<string, string>
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
  /**
   * The MODEL is loaded, not the account (upstream code 14003).
   *
   * Kept apart from `rate-limited` because the two need OPPOSITE advice:
   * `rate-limited` is this account's volume limit (wait, or bill another
   * account), while `model-busy` follows the model everywhere — every account
   * hits the same wall, so switching accounts only spends a request per account
   * to learn what the first one already said. The remedy is the upstream's own:
   * wait about a minute, or switch to a less busy model.
   */
  | 'model-busy'
  | 'out-of-credit'
  | 'credential-rejected'
  | 'policy-rejected'
  /**
   * The upstream restricted this credential for unusual activity (issue #127).
   *
   * Separate from `policy-rejected`: a content refusal is about the request,
   * while this is about the credential and needs re-authentication or an appeal.
   */
  | 'account-restricted'
  /**
   * The gateway's channel gate refused the request itself (upstream code 11128).
   *
   * Kept apart from `failed` because its whole point is the question it answers:
   * the probe passes and the chat fails on the SAME model and the SAME account,
   * because the gate matches the OPENING of a `system` message and the probe's
   * is a neutral one-liner. A generic failure would leave the user swapping
   * accounts that cannot change a byte of their prompt (issues #87–#90).
   */
  | 'channel-rejected'
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
   * A client-invented countdown here would be fiction. Four sources fill it:
   * a real `Retry-After` header; the reset sentence the upstream writes into
   * its own failure BODY (`将在 … UTC+8 重置`, which is where this service
   * actually puts it — its 429s carry no rate-limit header at all); the
   * region's own quota refresh point for an exhausted quota; or, for the
   * model-scoped 14003 throttle, the magnitude the upstream states in PROSE
   * ("wait about a minute") — see {@link WorkBuddyWebProbeOutcome}.
   */
  retryAtMs?: number
  /** Which of those four sources supplied {@link retryAtMs}. */
  retrySource?: 'retry-after' | 'upstream-message' | 'quota-refresh' | 'upstream-tips'
}

/** The probe endpoint's answer document. */
export interface WorkBuddyWebProbeAnswer {
  results: readonly WorkBuddyWebProbeResult[]
}

/**
 * One model's output-speed result, as the card renders it (issue #92).
 *
 * Deliberately its own type rather than extra fields on
 * {@link WorkBuddyWebProbeResult}: the two runs answer different questions, and
 * a shared type would let a card render an availability verdict with a speed on
 * it, or vice versa, with nothing to stop it.
 */
export interface WorkBuddyWebTpsResult {
  modelId: string
  /** `ok` when at least one run answered; the speed fields say what was learned. */
  outcome: 'ok' | 'unavailable' | 'credential-rejected' | 'failed'
  /** Median output tokens/second over the usable runs. */
  tokensPerSecond?: number
  /** Median time to first content chunk, in ms. */
  timeToFirstTokenMs?: number
  /** Output tokens the upstream counted for the fastest usable run. */
  outputTokens?: number
  /** How many runs contributed; below the planned count when runs were lost. */
  samples: number
  /** Why {@link tokensPerSecond} is absent, when it is. */
  reason?: 'few-chunks' | 'no-usage' | 'all-failed'
  /** Total credit the runs reported, rounded to 2dp. */
  credit?: number
  /** Upstream's own words when the run failed outright. */
  message?: string
}

/** The speed endpoint's answer document. */
export interface WorkBuddyWebTpsAnswer {
  results: readonly WorkBuddyWebTpsResult[]
}

/** Why one account is currently out of the pool. */
export type WorkBuddyWebPoolExclusion =
  | 'unusable'
  | 'rate-limited'
  /**
   * The MODEL this account was measured against is loaded, not the account.
   *
   * Mirrors the same-named member of `WorkBuddyPoolExclusion` in
   * `./account-pool.ts`, and mirrored here for the same reason as the outcome
   * vocabulary above: this module is the node-free bridge and must not import
   * the Host-side pool module. The card renders it with its own label, because
   * showing "被限流" next to an ACCOUNT name asserts something the measurement
   * does not say (issue #56).
   */
  | 'model-busy'
  | 'out-of-credit'
  | 'credential-rejected'
  /**
   * The upstream restricted this account (issue #127); unlike a request policy
   * refusal, another account can serve and this one should be benched.
   */
  | 'account-restricted'
  | 'not-found'
  | 'unavailable'
  | 'failed'

/** One claimable benefit, as the card renders it (issue #79). */
export interface WorkBuddyWebBenefit {
  /** Which campaign: compensation (crash补偿) or gift (新人首月赠送). */
  kind: 'compensation' | 'gift'
  /** Display name for the campaign, resolved Host-side so both clients agree. */
  title: string
  /** Credits on offer. */
  creditNum: number
  /**
   * Whole days until the window closes, floored at 0.
   *
   * ABSENT when the gateway stated no end time — the card must then omit the
   * countdown rather than print a number nobody knows.
   */
  daysLeft?: number
  /** True when the window closes within 3 days, so the card can say 即将到期. */
  urgent: boolean
}

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
  /**
   * The credential belongs to an enterprise/education tenant (issues #124/#129).
   *
   * Carried through the pool row so the card can render the two actions the
   * upstream does not support for those accounts (daily check-in and benefit
   * claiming) as explicitly unavailable rather than as pending work.
   */
  enterprise?: boolean
  /** Total remaining credits, absent when the credits route failed. */
  credits?: number
  /** Credits expiring within 3 days. */
  expiringSoon?: number
  /** When the nearest package expires, in ms. */
  nearestExpiryMs?: number
  /**
   * The last test of this account's target model, absent when never tested.
   *
   * The model is recorded INSIDE the probe (issue #61) rather than assumed from
   * the row's current setting: the setting can be changed after the test, and a
   * result must keep naming what it actually measured.
   */
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
    /**
     * WHICH model this measurement is about (issue #61).
     *
     * `6004` is an account × model condition, so an `ok` without a model reads as
     * account-level availability — which is exactly the false positive the
     * reporter hit: the card said 可用 for two accounts whose actual model
     * returned `429 / 6004`. ABSENT for records written before the field existed;
     * the card must then say the scope is unknown rather than assume it.
     */
    modelId?: string
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
  /**
   * Promotional benefits this account can STILL claim (issue #79).
   *
   * Never carries a claimed or lapsed campaign: the issue's rule is that those
   * do not appear at all, so their absence here IS the "hide it" instruction.
   * ABSENT means not read (or nothing claimable), and the card renders no line
   * either way — a benefit line is only ever added to say "there is something
   * here for you", never to announce its own absence.
   */
  benefits?: readonly WorkBuddyWebBenefit[]
  /**
   * The model a TEST of this row would use (issue #61).
   *
   * Per row, because a test model can be chosen per account: the card shows it
   * beside the row it applies to rather than implying one model for the table.
   */
  testModelId?: string
  /** Where this row's test target came from (see {@link WorkBuddyWebPool.targetModelSource}). */
  testModelSource?: 'preferred' | 'free' | 'none' | 'stale'
  /** This row's saved override that the region no longer offers. */
  staleTestModelId?: string
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
   * The SAVED per-account test models, keyed by account id (issue #61).
   *
   * Sent verbatim rather than as the effective set: the card edits this map, and
   * an id whose model has left the catalog must survive a save so the user's
   * record of what they chose is not silently destroyed.
   */
  /**
   * Where the target came from. `'stale'` means the SAVED id is no longer in
   * the catalog — a distinct state from `'none'` (no free model exists),
   * because the two need opposite advice.
   */
  targetModelSource: 'preferred' | 'free' | 'none' | 'stale'
  /** The account ids the user has checked into this region's pool. */
  memberAccountIds?: readonly string[]
  /**
   * The user's hand-ordered pool order, as account ids.
   *
   * Independent of {@link memberAccountIds}: an id need not be checked in
   * (it only takes effect once the account is a member), and ids not listed
   * sort last. Kept separate from membership so reordering never conflicts
   * with, or is destroyed by, a membership edit. Only ids that resolve to a
   * currently listed account are transmitted (see `web-status.ts`).
   */
  orderAccountIds?: readonly string[]
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
  /**
   * Last measured display name per saved member id (issue #60).
   *
   * Only ids the roster above does NOT list are useful here: those are the
   * members whose sign-in has gone, and whose name therefore survives nowhere
   * else. The card renders a name when there is one and a short id prefix when
   * there is not — the point is that the ghost warning stops being a
   * subjectless count ("1 saved account is no longer signed in") that the user
   * has no way to act on.
   */
  memberNames?: Readonly<Record<string, string>>
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
  /**
   * `'skipped'` means the account has no consumer check-in to claim — an
   * enterprise member (issue #124). It is NOT a failure: nothing is wrong with
   * the account, the action simply does not exist for it.
   */
  status: 'claimed' | 'already' | 'failed' | 'skipped'
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

/**
 * Every namespace spelling the browser half follows when looking for the
 * settings form the Host actually serves, in preference order.
 *
 * `describe()` keys a form by its Loader entry id, and the profile patch picks
 * that id — so the plugin must ASK rather than assume. The observed spellings
 * are the bare package name, the `include:`-wrapped id the live Desktop host
 * uses, and the declared name as the last resort. `configForms.whileServed`
 * follows all of them and re-runs when the mirror arrives, which is what keeps
 * the binding correct on a host whose mirror populates after `apply` (the
 * 4.3.0 readout defect, issue #46).
 */
export const WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES: readonly string[] = [
  'dsh-connect-workbuddy',
  'include:dsh-connect-workbuddy',
  WORKBUDDY_SETTINGS_NS,
]

/**
 * The `<package name>` keys under which the card registers itself in the
 * Plugins panel.
 *
 * `plugins.bundle.config` and `plugins.row.config` are KEYED slots: the page
 * renders them with `entryKey: pkg.name`, and it decides whether to render the
 * section at all from `ledger.bundles.has(pkg.name)` — a `Set` of exactly the
 * `key` values registered on that slot, compared against the plugin-manager
 * inventory's own package name. Both halves of that comparison are EXACT and
 * neither side is the settings namespace: the inventory name comes from the
 * profile's package list, while a deployment may mount the same code under a
 * different Loader entry id.
 *
 * That is the whole of issue #55. A deployment whose inventory name is
 * `dsh-connect-workbuddy` and whose card registered only under
 * `include:dsh-connect-workbuddy` gets NO card and NO error: the keyed lookup
 * finds nothing, the section is simply not rendered, and `apply()` finished
 * happily. Since the keys live in separate cells (one entry per `key` per
 * priority), registering under every spelling at once is a shadowing-free
 * duplicate rather than a conflict, and is strictly safer than betting on one.
 *
 * The bare package name is FIRST because it is the common case — a profile that
 * installs the package by name mounts it under that name.
 */
export const WORKBUDDY_CARD_KEYS: readonly string[] = [
  'dsh-connect-workbuddy',
  'include:dsh-connect-workbuddy',
]
