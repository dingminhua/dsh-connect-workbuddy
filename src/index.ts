/**
 * WorkBuddy models for DeepSeek Harness, reusing the WorkBuddy desktop
 * app's sign-in. Registers TWO provider routes — `workbuddy` (domestic CN
 * gateway) and `workbuddy-global` (international workbuddy.ai gateway) —
 * each backed by its own region-scoped credential store, model catalog, and
 * loopback shim, so both regions serve simultaneously; streaming, tool calls,
 * compaction, and permissions stay Harness-owned.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
 *   — 宿主的装配顺序（先起 shim，拿到端口后才构造 provider，
 *     再注册 adapter 与可配置 provider，最后异步刷新目录）由其设计并验证；
 *     `installSettingsSection` 的用法、webServer 为可选服务（无头 profile
 *     下宿主仍工作）的处理，亦沿用其做法。
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 配置 schema 的字段划分（lastCatalog 目录 + enabledModelIds 勾选分离）、
 *     `displayModels` 与 `configuredModels` 的区分、
 *     `registerModelDiscovery` 与 `discoverModels` 返回草稿目录的做法，
 *     均来自该项目。
 * 改动：账号选择严格绑定用户显式选择的账号（不按积分自动切换），
 *   并移除与本项目上游无关的 1M 变体逻辑；双 provider 化后国内版与
 *   国际版各持一套 store/catalog/shim，区域由凭据域名隔离，
 *   设置卡片以 tab 区分两个供应商。
 *
 * @module dsh-connect-workbuddy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { workbuddyAccountId, WorkBuddyCredentialStore, type WorkBuddyCredential } from './auth.ts'
import { deriveCatalog, fallbackModelsFor, WorkBuddyCatalog } from './catalog.ts'
import type { WorkBuddyContextBudget, WorkBuddyModelInfo } from './catalog.ts'
import { createAccountUsabilityProbe } from './credential-recovery.ts'
import {
  createWorkBuddyAdapter,
  regionOfProvider,
  workBuddyDisplayName,
  workBuddyModelInput,
  WORKBUDDY_GLOBAL_PROVIDER,
  WORKBUDDY_PROVIDER,
  WORKBUDDY_PROVIDER_DISPLAY_NAMES,
  WORKBUDDY_PROVIDERS,
} from './adapter.ts'
import type { WorkBuddyAdapter } from './adapter.ts'
import { createWorkBuddyShim } from './shim.ts'
import { cooldownOf, outcomeOfFailure, probeModel, redactUpstreamText, resolveProbeInputTokens } from './probe.ts'
import type { UpstreamErrorKind } from './upstream.ts'
import {
  checkinAllAccounts,
  probeUpdatesOf,
  testAllAccounts,
} from './account-pool-run.ts'
import type {
  WorkBuddyPoolRunnerDeps,
  WorkBuddyPoolTarget,
} from './account-pool-run.ts'
import type { WorkBuddyPoolCredits, WorkBuddyPoolMember, WorkBuddyPoolProbe } from './account-pool.ts'
import {
  effectiveMembersOf,
  rankPool,
} from './account-pool.ts'
import { readPoolProbes, writePoolProbes } from './account-pool-store.ts'
import type { WorkBuddyShim } from './shim.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import type { WorkBuddyRegion } from './upstream.ts'
import { registerWorkBuddyStatusRoute } from './web-status.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'

export {
  WORKBUDDY_GLOBAL_PROVIDER,
  WORKBUDDY_PROVIDER,
  WORKBUDDY_PROVIDER_DISPLAY_NAMES,
  WORKBUDDY_PROVIDERS,
  WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
  createWorkBuddyAdapter,
  regionOfProvider,
  workBuddyDisplayName,
  workBuddyModelInput,
  workBuddyThinkingLevelMap,
  type WorkBuddyAdapter,
} from './adapter.ts'
export { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
export {
  deriveCatalog,
  fallbackModelsFor,
  FALLBACK_WORKBUDDY_MODELS,
  FALLBACK_WORKBUDDY_MODELS_GLOBAL,
  WorkBuddyCatalog,
  type WorkBuddyModelInfo,
} from './catalog.ts'
export {
  imageDefaultFor,
  NATIVE_MODALITY_BY_MODEL_ID,
  nativeModalityOf,
  type WorkBuddyNativeModality,
} from './native-modality.ts'
export {
  authFileName,
  defaultDesktopAuthCandidates,
  defaultDesktopAuthDirs,
  defaultDesktopAuthPath,
  ENCRYPTED_CREDENTIAL_CODE,
  hasEncryptedCredentialFields,
  isEncryptedCredentialError,
  legacyWorkbuddyOwnAuthPath,
  parseWorkBuddyAuth,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_AUTH_FILENAME,
  workbuddyAccountId,
  WorkBuddyCredentialStore,
  WorkBuddyEncryptedCredentialError,
  workbuddyOwnAuthPath,
  type WorkBuddyAccountChoice,
  type WorkBuddyAuthStatus,
  type WorkBuddyCandidateFailure,
  type WorkBuddyCredential,
  type WorkBuddyStoreOptions,
} from './auth.ts'
export {
  clearAtRestKeyCache,
  deriveAtRestKey,
  deriveAtRestKeyId,
  fetchAtRestKeyPayload,
  findWorkbuddyAppExecutable,
  isEncryptedFieldWrapper,
  isWorkbuddyBundle,
  macosBundleExecutable,
  macosNestedAppBundles,
  openEncryptedField,
  readAtRestKey,
  WORKBUDDY_APP_EXECUTABLE_ENV,
  workbuddyAppExecutableCandidates,
  type WorkBuddyEncryptedField,
} from './at-rest.ts'
export {
  classifyUpstreamError,
  CREDENTIAL_REJECTED_CODE,
  isCredentialRejectedError,
  parseCreditMultiplier,
  parseReasoning,
  parseUpstreamModel,
  prepareChatBody,
  regionOf,
  WorkBuddyCredentialRejectedError,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyChatResult,
  type WorkBuddyCreditPackage,
  type WorkBuddyCredits,
  type WorkBuddyReasoning,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyUpstreamModel,
} from './upstream.ts'
export {
  createAccountUsabilityProbe,
  resolveCredentialRecovery,
  type WorkBuddyCredentialRecovery,
  type WorkBuddyProbeStore,
  type WorkBuddyRecoveryCandidate,
  type WorkBuddyUsabilityProbeOptions,
} from './credential-recovery.ts'
export {
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  writeHostHeartbeat,
  workbuddyHostHeartbeatPath,
  type WorkBuddyHostHeartbeat,
} from './host-heartbeat.ts'
export { WORKBUDDY_CONNECT_VERSION } from './version.ts'
export {
  cooldownOf,
  creditOfStream,
  outcomeOfFailure,
  parseRetryAfter,
  probeModel,
  probeRequestBody,
  PROBE_INPUT_TOKEN_CHOICES,
  probeSucceeded,
  DEFAULT_PROBE_INPUT_TOKENS,
  PROBE_MAX_TOKENS,
  PROBE_SYSTEM_PROMPT,
  type WorkBuddyProbeClient,
  type WorkBuddyProbeOutcome,
  type WorkBuddyProbeResult,
} from './probe.ts'
export {
  registerWorkBuddyStatusRoute,
  workBuddyWebStatus,
  type WorkBuddyStatusRouteOptions,
} from './web-status.ts'
import {
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_CHECKIN_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_PROBE_PATH,
  WORKBUDDY_REGION_PARAM,
  WORKBUDDY_REGIONS,
  WORKBUDDY_SETTINGS_NS,
  WORKBUDDY_USAGE_PATH,
  regionOfStatusUrl,
  toPersistedWorkBuddyModel,
  withWorkBuddyRegion,
  regionEnabledOf,
  nextRegionEnabled,
  nextRegionSlots,
  // Imported for this module's own use AND re-exported below, so moving the
  // implementation to the shared bridge did not change the public API.
  unwrapVolatileDeep,
  type WorkBuddyWebAccount,
  type WorkBuddyWebCheckin,
  type WorkBuddyWebCredits,
  type WorkBuddyWebModel,
  type WorkBuddyWebPackage,
  type WorkBuddyWebRegion,
  type WorkBuddyWebSearchPath,
  type WorkBuddyWebUsage,
} from './status-paths.ts'
export {
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_CHECKIN_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_PROBE_PATH,
  WORKBUDDY_REGION_PARAM,
  WORKBUDDY_REGIONS,
  WORKBUDDY_SETTINGS_NS,
  WORKBUDDY_USAGE_PATH,
  regionOfStatusUrl,
  toPersistedWorkBuddyModel,
  withWorkBuddyRegion,
  regionEnabledOf,
  nextRegionEnabled,
  nextRegionSlots,
  unwrapVolatileDeep,
}

/** Stable Cordis plugin name. */
export const name = 'dsh-connect-workbuddy'

/** The model registry required before the provider can register. */
export const inject = ['llm', 'settings']

/**
 * Settings namespace for the plugin configuration card.
 *
 * (历史注记：0.1.5 线上插件自选命名空间并经 `installSection` 注册；自
 * 2.1.0 起只支持 0.1.7 线，该路径已移除。) 0.1.7 的 settings 服务自行推导
 * 命名空间 —— `describe()` 返回 `ns: entry.options.id`，即 Loader 条目 id
 * —— 因此插件不再能自选。此常量仅作为「宿主不暴露条目 id」时的回落值；
 * 实际生效值来自 {@link settingsNamespaceOf}。
 *
 * 这个区分不是装饰性的。宿主按**精确匹配**查表
 * （模型设置页的 `namespaces.get(entry.settingsNs)`），所以宣告
 * `workbuddy` 而宿主实际服务 `include:dsh-connect-workbuddy` 时，provider
 * 会被判为「未配置」：配置入口与模型发现双双静默失效。
 */

/**
 * The namespace the HOST actually serves this plugin under.
 *
 * `ctx.fiber.entry` is added by the Loader, not by Cordis itself, so it is not
 * in Cordis's public types and is absent on hosts that mount a plugin without a
 * Loader entry (a test harness, or `ctx.plugin()` called directly). Hence the
 * probe plus the documented fallback, mirroring the first-party plugins:
 * `const settingsNs = ctx.fiber.entry?.options.id ?? NS`.
 */
export function settingsNamespaceOf(ctx: unknown): SettingsNamespace {
  const id = (ctx as { fiber?: { entry?: { options?: { id?: unknown } } } })?.fiber?.entry?.options?.id
  return typeof id === 'string' && id !== '' ? id as SettingsNamespace : WORKBUDDY_SETTINGS_NS as SettingsNamespace
}

/** One region's model directory and the user's selection within it. */
export interface WorkBuddyRegionState {
  /**
   * Whether this region's provider is switched on. Opt-out: only an explicit
   * `false` disables it, so a config predating this switch keeps both providers
   * running. A disabled region is fully withdrawn from the harness — its adapter
   * route and its configurable-provider entry both hold zero routes, so it
   * disappears from DSH's model picker instead of lingering as an unselectable
   * row (see `syncRegionRegistration`).
   */
  enabled?: boolean
  /** The last-refreshed directory for this region; what the card displays. */
  lastCatalog?: WorkBuddyModelInfo[]
  /** The user's selection in this region, as model ids. */
  enabledModelIds?: string[]
  /** Model ids the user explicitly opted into image input. */
  imageModelIds?: string[]
  /** Local DSH context budget per model in this region. */
  contextBudgets?: Record<string, WorkBuddyContextBudget>
  /** This region's account-pool preferences (opt-in; see {@link WorkBuddyPoolPreferences}). */
  pool?: WorkBuddyPoolPreferences
}

/**
 * One region's account-pool preferences, as stored.
 *
 * Every field is a USER CHOICE, which is why the pool's measured facts are not
 * here: preferences are saved through the card's draft-and-discard path, and a
 * measurement living in the same slot would be rolled back by the next save.
 */
export interface WorkBuddyPoolPreferences {
  /**
   * Whether the pool is active for this region — which now means the
   * FAILOVER switch, not a credit ranking.
   *
   * Opt-in: default false. While on, a chat request that fails upstream is
   * retried against the other usable members of this region's pool, in order,
   * until one serves it or none is left (see `src/shim.ts`). While off the
   * plugin behaves exactly as it did before the pool existed: the account the
   * user selected serves every request, and a failure is reported as-is.
   *
   * It deliberately does NOT change which account serves NEXT: failover is
   * per-request borrowing, so the user's selection stays in effect and the
   * card can keep reporting who really served.
   */
  enabled?: boolean
  /** Model id to test; `''` means auto-pick a free model from this region. */
  targetModelId?: string
  /**
   * How much input a probe sends, in tokens — the pool's biggest single knob.
   *
   * The upstream's rate limit (6004) fires on request SIZE, and the threshold
   * was measured to sit between 20k and 30k tokens. The probe has to be sized
   * near where the user's REAL conversations land: too small and it reports
   * "usable" while every long conversation is refused (the exact false positive
   * that made this knob necessary), too large and it costs real credit on every
   * batch AND excludes accounts that would have served the shorter requests the
   * user actually sends.
   *
   * A fixed value therefore cannot be right for everyone — the right size is a
   * property of the user's own traffic, which only they know. `undefined` keeps
   * the measured default ({@link DEFAULT_PROBE_INPUT_TOKENS}), so an existing
   * profile is unaffected.
   */
  probeInputTokens?: number
  /**
   * The account ids checked into this region's pool.
   *
   * An EXPLICIT opt-in, and empty by default: the batch actions claim rewards
   * and spend credits on real accounts, so membership is the user's decision
   * rather than a consequence of which sign-ins happen to exist. Empty means
   * the pool covers nothing and both buttons stay disabled.
   */
  memberAccountIds?: string[]
}

/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy desktop auth-file path, overriding env and platform defaults. */
  authFile?: string
  /**
   * @deprecated Legacy single-slot account selector from before the dual
   * provider split. It is attributed to whichever region the account actually
   * belongs to (resolved once at startup from the local account scan); new
   * writes go to {@link Config.accounts}.
   */
  accountId?: string
  /**
   * Per-region account selections, keyed `cn` | `global`. Each region's tab
   * writes its own slot; tokens remain outside settings.
   */
  accounts?: Partial<Record<WorkBuddyRegion, string>>
  /**
   * Per-region model state, keyed `cn` | `global`. The CN app and the
   * international WorkBuddy AI app expose different rosters, so each keeps its
   * own directory and selection and switching accounts never drops the other
   * region's picks.
   */
  regions?: Partial<Record<WorkBuddyRegion, WorkBuddyRegionState>>
  /**
   * @deprecated Legacy single-slot fields from before the region split. They
   * predate international support and are read as the CN region's state when
   * `regions.cn` is absent; new writes go to `regions`.
   */
  lastCatalog?: WorkBuddyModelInfo[]
  /** @deprecated See {@link Config.lastCatalog}. */
  enabledModelIds?: string[]
  /** @deprecated See {@link Config.lastCatalog}. */
  imageModelIds?: string[]
  /** @deprecated See {@link Config.lastCatalog}. */
  contextBudgets?: Record<string, WorkBuddyContextBudget>
}

const modelConfig = z.object({
  id: z.string().required(),
  name: z.string().required(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

/**
 * One region's account-pool PREFERENCES.
 *
 * Only user choices live here. The pool's MEASURED facts (probe outcomes,
 * cooldowns, the account currently billed) are deliberately NOT part of this
 * schema — see `src/account-pool-store.ts`. The card saves preferences with a
 * draft-and-discard write, so storing measurements in the same slot would let
 * one "Save" press overwrite results the timer had just written.
 */
const poolConfig = z.object({
  enabled: z.boolean().default(false).description('Whether this region\'s account pool is active (opt-in). While on, a failed chat request is retried against the other usable pool members before the error is reported.'),
  targetModelId: z.string().default('').description('Model id to test; empty means pick a zero-multiplier model from this region\'s catalog'),
  /**
   * Sizing of the test probe, as a token count the user picks from a fixed set.
   *
   * A closed set rather than a free number: each step is a meaningful position
   * relative to the measured 20k~30k threshold, and an arbitrary value would
   * invite a size that is neither safely under nor clearly over it. `0` (and any
   * unknown value) falls back to the measured default, so a profile written by
   * an older build — and one hand-edited to something odd — behaves identically.
   */
  probeInputTokens: z.number().step(1).default(0).description('Input tokens each test probe sends: 10000 / 20000 / 30000 / 50000 / 100000. Bigger probes catch a rate limit real conversations would hit, but cost more credit per test and may mark an account unusable for large requests only. 0 uses the measured default (25000)'),
  memberAccountIds: z.array(z.string()).default([]).description('Account ids checked into this pool (opt-in; empty means the pool covers nothing)'),
})

const regionStateConfig = z.object({
  enabled: z.boolean().default(true).description('Whether this region\'s provider is offered to DSH (opt-out; false withdraws it entirely)'),
  lastCatalog: z.array(modelConfig).default([]),
  enabledModelIds: z.array(z.string()).default([]),
  imageModelIds: z.array(z.string()).default([]),
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}),
  pool: poolConfig.default({}),
})

const accountSelectionConfig = z.object({
  cn: z.string().description('Selected domestic (CN) account id (never a token)'),
  global: z.string().description('Selected international account id (never a token)'),
})

/**
 * Mark a schema's field as volatile on the DSH lines that support it.
 *
 * `volatile()` exists from schemastery 3.18.3 (the DSH 0.1.7 line, which is the
 * only line whose settings write gate reads the marker). Older pinning (3.18.2,
 * the 0.1.5 line) has no such method, and the schema must stay byte-identical to
 * the unmarked original there: hand-writing `meta.volatile = true` would bypass
 * schemastery's own validateVolatileSchema checks and produce a schema no 0.1.5
 * consumer understands — so on that line this degrades to an identity no-op.
 *
 * Exported so BOTH arms are testable on any machine. The capability is decided
 * by whichever schemastery the dependency tree resolves, so without a seam the
 * no-op arm would silently stop being exercised the moment the pinned version
 * moved up — which is exactly how the volatile-path defect below went unseen.
 */
export function asVolatile<T>(schema: z<T>): z<T> {
  if (typeof (schema as unknown as { volatile?: () => z<T> }).volatile === 'function') {
    return (schema as unknown as { volatile: () => z<T> }).volatile()
  }
  return schema
}

function unwrapVolatile<T>(value: T): T {
  if (value !== null && typeof value === 'object' && 'get' in (value as object) && typeof (value as any).get === 'function') {
    return (value as any).get()
  }
  return value
}

/**
 * Deep copy of a config value with every `{get(): T}` live reference replaced
 * by the value it resolves to.
 *
 * {@link unwrapVolatile} only peels the ONE level a caller reads, which is all
 * the ordinary read paths need. Handing a config object to a settings service
 * is different: the service validates and `structuredClone`s the WHOLE object,
 * so a reference surviving anywhere inside it fails schema validation with a
 * message that names the field but not the cause —
 * `$.authFile expected string but got [object Object]`.
 *
 * That is exactly what happened on the 0.1.5 line once volatile marking became
 * active: `installSection` received the raw config, whose volatile fields were
 * live references, and every field it validated threw. The namespace never
 * registered, so the card's settings silently disappeared.
 *
 * The implementation now lives in the node-free host<->client bridge, because
 * the browser half needs the SAME unwrap before it spreads a resolved field —
 * spreading a live reference is `{get: <function>}`, which drops every sibling
 * region. It is imported and re-exported from here so the Host entry keeps
 * exposing it as part of its public API.
 */

export const Config: z<Config> = z.object({
  authFile: asVolatile(z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)')),
  accountId: z.string().description('Deprecated: pre-split account selector, attributed to its own region'),
  accounts: asVolatile(accountSelectionConfig.default({} as any).description('Per-region account selections, keyed cn | global')) as z<Partial<Record<WorkBuddyRegion, string>>>,
  regions: asVolatile(z.dict(regionStateConfig).default({}).description('Per-region model directory and selection, keyed cn | global')),
  lastCatalog: z.array(modelConfig).description('Deprecated: pre-region-split CN model directory') as z<WorkBuddyModelInfo[]>,
  enabledModelIds: z.array(z.string()).default([]).description('Deprecated: pre-region-split CN selection'),
  imageModelIds: z.array(z.string()).default([]).description('Deprecated: pre-region-split CN image opt-in'),
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}).description('Deprecated: pre-region-split CN context budgets'),
}) as unknown as z<Config>

/**
 * One region's saved model state. A config written before the region split has
 * only the flat fields: those were always captured from the CN endpoint (the
 * plugin had no international support), so they are read as the CN state and
 * only when no explicit CN slot exists. The global region never inherits them —
 * that inheritance is exactly the bug where a stale CN directory was
 * intersected with the international catalog and silently dropped the user's
 * picks.
 */
export function regionStateOf(config: Config, region: WorkBuddyRegion): WorkBuddyRegionState {
  const regions = unwrapVolatile(config.regions)
  const stored = regions?.[region]
  if (stored !== undefined) return stored
  if (region !== 'cn') return {}
  const lastCatalog = unwrapVolatile(config.lastCatalog)
  const enabledModelIds = unwrapVolatile(config.enabledModelIds)
  const imageModelIds = unwrapVolatile(config.imageModelIds)
  const contextBudgets = unwrapVolatile(config.contextBudgets)
  return {
    ...lastCatalog === undefined ? {} : { lastCatalog },
    ...enabledModelIds === undefined ? {} : { enabledModelIds },
    ...imageModelIds === undefined ? {} : { imageModelIds },
    ...contextBudgets === undefined ? {} : { contextBudgets },
  }
}

/**
 * Whether one region's provider is switched on. Opt-out semantics: only an
 * explicit `false` disables it, so every config written before this switch
 * existed — including the pre-region-split flat fields, which never carry
 * `enabled` — keeps both providers running exactly as before. The card reads the
 * same rule through `regionEnabledOf`, so the two halves can never disagree
 * about a region's state.
 */
export function regionEnabled(config: Config, region: WorkBuddyRegion): boolean {
  return regionStateOf(config, region).enabled !== false
}

/**
 * One region's runtime stack. The two regions are fully parallel provider
 * stacks — separate credential stores, catalogs, and loopback shims — so the
 * domestic and international accounts serve simultaneously and a change on
 * one side (account switch, catalog refresh) never touches the other.
 */
interface WorkBuddyRegionStack {
  store: WorkBuddyCredentialStore
  catalog: WorkBuddyCatalog
  shim: WorkBuddyShim
}

/** Every region, in card tab order. */
const REGION_KEYS: readonly WorkBuddyRegion[] = ['cn', 'global']

/**
 * The account id a region should select, or `undefined` for the documented
 * default: follow whatever the WorkBuddy app is currently signed in as.
 *
 * Three inputs decide it, and the ORDER is the whole point:
 *
 * 1. `accounts[region] === ''` — the Clear sentinel. It means "the user
 *    dropped this region's choice", which is the opposite of the key being
 *    absent ("never configured"). It therefore terminates the lookup: falling
 *    through to the legacy `accountId` here would re-bind the very account the
 *    user just dropped, and would do it after clearing appeared to succeed.
 * 2. `accounts[region]` set to a real id — an explicit per-region choice.
 * 3. absent key, with the pre-split `accountId` belonging to this region —
 *    the legacy migration, attributed once at startup from the local scan.
 *
 * `legacyAccountRegion` is resolved asynchronously after the first
 * `applySelection` pass, so this is a pure function of it rather than a
 * closure over the stores: the same call answers both the early pass (no
 * attribution yet) and every later one.
 */
export function selectAccountFor(
  region: WorkBuddyRegion,
  value: Config,
  legacyAccountRegion: WorkBuddyRegion | undefined,
): string | undefined {
  const accounts = unwrapVolatile(value.accounts)
  const configured = accounts?.[region]
  if (configured === '') return undefined
  if (configured !== undefined) return configured
  const accountId = unwrapVolatile(value.accountId)
  return legacyAccountRegion === region ? accountId : undefined
}

/** Whether a region carries the Clear sentinel rather than a saved choice. */
export function regionCleared(value: Config, region: WorkBuddyRegion): boolean {
  // `accounts` is volatile on the 0.1.7 line: the stored value is a live
  // cosmokit reference whose `.get()` yields the plain record, so a raw
  // `value.accounts?.[region]` read is always undefined there and the Clear
  // sentinel would never be observed (issue #13's clear path).
  return unwrapVolatile(value.accounts)?.[region] === ''
}

/**
 * Which region owns the pre-split `accountId`, or `undefined` when it cannot
 * be attributed (the field is absent, or the account is gone from every local
 * sign-in list).
 *
 * Regions the user explicitly cleared are skipped, even when the saved account
 * IS among their local sign-ins. `selectAccountFor` already refuses to fall
 * back for a cleared region, so this cannot change what runs — but it keeps the
 * attribution honest about its own decision: the region that owns this id is
 * not the one the user just told the plugin to stop pinning, so the other
 * region must get the chance to claim it.
 *
 * `accountsFor` is injected so the sequential, stop-at-first-match scan is
 * testable without a filesystem.
 */
export async function legacyAttributionRegion(
  value: Config,
  accountsFor: (region: WorkBuddyRegion) => Promise<readonly { id: string }[]>,
): Promise<WorkBuddyRegion | undefined> {
  const id = value.accountId
  if (id === undefined) return undefined
  for (const region of REGION_KEYS) {
    if (regionCleared(value, region)) continue
    if ((await accountsFor(region)).some(account => account.id === id)) return region
  }
  return undefined
}

/**
 * Start both regions' loopback endpoints, register the `workbuddy` (CN) and
 * `workbuddy-global` (international) providers, and refresh each region's
 * model catalog from the upstream once that region's credentials allow it.
 * The static fallback catalogs serve from the first moment, so an offline
 * upstream never leaves a provider empty.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new WorkBuddyUpstreamClient()

  /**
   * How long a check-in reading is reused before asking the upstream again.
   *
   * The card polls the usage route every 60 seconds, but "did this account
   * check in today" changes only when a check-in runs or the day rolls over.
   * Without a cache, a 10-account pool cost ~14,400 upstream requests a day for
   * an answer that was almost always identical.
   */
  const CHECKIN_CACHE_MS = 10 * 60_000

  /**
   * Per-region, per-account check-in readings.
   *
   * Invalidated by this plugin's own check-in batch (the only writer that can
   * change the answer during a session), so the user sees their result
   * immediately instead of waiting out the TTL.
   */
  const checkinStateCache: Partial<
    Record<WorkBuddyRegion, Record<string, { checkedIn: boolean, atMs: number }>>
  > = {}


  // The namespace the host actually serves (see `settingsNamespaceOf`). On
  // 0.1.7 this is the Loader entry id, and the harness looks it up by EXACT
  // match — advertising anything else makes our provider read as unconfigured.
  const settingsNs = settingsNamespaceOf(ctx)

  const stacks = {} as Record<WorkBuddyRegion, WorkBuddyRegionStack>
  for (const region of REGION_KEYS) {
    // `authFile` is volatile on the 0.1.7 line: the raw config value is a live
    // cosmokit reference, and passing it through would hand the store a
    // reference object instead of a path.
    const authFile = unwrapVolatile(config.authFile)
    const store = new WorkBuddyCredentialStore({
      region,
      ...authFile === undefined ? {} : { desktopPath: authFile },
      refresh: credential => client.refreshToken(credential),
    })
    const catalog = new WorkBuddyCatalog(region)
    const shim = createWorkBuddyShim({
      store,
      client,
      catalog,
      logger: ctx.logger,
      /**
       * Pool routing, bound to THIS region.
       *
       * The region is captured in the closure rather than passed per call: each
       * region owns its own store, pool and shim, and routing that consulted the
       * other region's members would bill an account from a different account
       * pool than the one in play.
       *
       * `prepareAccount` runs before every request (so the ranking decides who
       * serves), `failoverAccount` runs after a failure (so the ranking decides
       * who to try next). Both are resolved lazily — they read pool plumbing
       * defined below — but never called before it exists: the shim only takes
       * traffic once the provider is registered, which happens after this whole
       * setup completes.
       */
      prepareAccount: () => applyPoolSelection(region),
      failoverAccount: triedAccountIds => failoverAccountFor(region, triedAccountIds),
      // Record what a live request learned, so the NEXT one starts from an
      // account that works instead of re-discovering this failure.
      onAccountFailure: (accountId, failure) => {
        void recordAccountFailure(region, accountId, failure)
      },
    })
    stacks[region] = { store, catalog, shim }
  }

  // Answers "would switching to this account help?" after the upstream refuses
  // the selected credential. It reads a candidate credential WITHOUT touching
  // the live selection, so probing can never silently re-route billing.
  const accountUsabilityProbe = createAccountUsabilityProbe({
    store: region => stacks[region].store,
    client,
  })

  // Stamp the user's explicit image opt-in onto a model list. This is the ONLY
  // source of `multimodal`; upstream capability flags are never trusted. Applied
  // to every runtime catalog path (save, discovery, startup seed) so a model's
  // image capability is consistent across them.
  const withImageSelection = (
    models: readonly WorkBuddyModelInfo[],
    images: ReadonlySet<string>,
  ): readonly WorkBuddyModelInfo[] =>
    models.map(model => ({
      ...model,
      ...images.has(model.id) ? { multimodal: true } : { multimodal: false },
    }))
  // Runtime catalog derives from the last-refreshed directory plus the user's
  // selection; an empty selection serves the whole directory so a never-
  // configured plugin still exposes models. Image input is the user's explicit
  // opt-in (`imageModelIds`) and never inferred from upstream capability flags.
  //
  // The roster to derive FROM is resolved in three steps, and the middle one is
  // what fixes issue #32. `state.lastCatalog?.length` alone treated "saved slot
  // with no directory" exactly like "never configured", so it served the STATIC
  // fallback roster — and `applySelection` then committed that over the live
  // catalog, deleting every model the live discovery had registered (the
  // user's in-use model disappeared mid-session, with no error). `liveModels`
  // is that region's currently-registered roster, passed in by `applySelection`
  // so a partial saved slot can DEMOTE to the live directory but never past it
  // to the static list. The static list stays the last resort, for the case it
  // was written for: an offline upstream with nothing discoverable at all.
  const configuredModels = (
    value: Config,
    region: WorkBuddyRegion,
    liveModels: readonly WorkBuddyModelInfo[] = [],
  ): readonly WorkBuddyModelInfo[] => {
    const state = regionStateOf(value, region)
    const roster = state.lastCatalog?.length
      ? state.lastCatalog
      : liveModels.length
        ? liveModels
        : fallbackModelsFor(region)
    return withImageSelection(
      deriveCatalog(roster, new Set(state.enabledModelIds ?? []), state.contextBudgets ?? {}),
      new Set(state.imageModelIds ?? []),
    )
  }
  // What the card displays: this region's last-refreshed directory, so the user
  // re-reads the current catalog rather than a stale saved snapshot. Same
  // three-step roster as `configuredModels` (issue #32): a saved slot that lost
  // its directory must show the LIVE catalog, not the static fallback, or the
  // card reports the user's in-use model as withdrawn ("已下架") while the
  // runtime is still serving it.
  const displayModels = (value: Config, region: WorkBuddyRegion): readonly WorkBuddyModelInfo[] => {
    const state = regionStateOf(value, region)
    if (state.lastCatalog?.length) return state.lastCatalog
    const live = stacks[region]?.catalog?.current()
    return live?.length ? live : fallbackModelsFor(region)
  }

  let current = () => config
  let invalidateCatalog = (): void => {}

  /**
   * Legacy migration for the pre-split single `accountId`: its region is
   * resolved once from the local account scan and the selection is then
   * attributed to that region ONLY — the other region keeps its documented
   * default (follow the app's current sign-in) instead of silently inheriting
   * a selection that belongs to the other side of the split.
   */
  let legacyAccountRegion: WorkBuddyRegion | undefined
  const effectiveAccountFor = (region: WorkBuddyRegion, value: Config): string | undefined =>
    selectAccountFor(region, value, legacyAccountRegion)

  const discoverModels = async (
    region: WorkBuddyRegion,
    signal?: AbortSignal,
  ): Promise<readonly WorkBuddyModelInfo[]> => {
    const credential = await stacks[region].store.resolve()
    return client.fetchModels(credential, signal)
  }

  /** Push the current config into every region's store selection and catalog. */
  const applySelection = (value: Config): void => {
    const authFile = unwrapVolatile(value.authFile)
    for (const region of REGION_KEYS) {
      stacks[region].store.setDesktopPath(authFile)
      stacks[region].store.selectAccount(effectiveAccountFor(region, value))
      // Hand the region's CURRENT roster in as the fallback for a saved slot
      // that lost its directory: a partial save must not be able to replace a
      // live catalog with the static one (issue #32). Read before `set`, which
      // is what keeps this from observing the write it is about to make.
      stacks[region].catalog.set(configuredModels(value, region, stacks[region].catalog.current()))
    }
    invalidateCatalog()
    syncRegionRegistration(value)
    void refreshRegionUsability()
  }

  /**
   * Tell each catalog whether its region has ANY local sign-in, so a region the
   * user has no account for advertises nothing instead of a roster that can
   * only 401 (issue #12).
   *
   * `accounts()` is the right source rather than the SELECTED credential: an
   * orphaned saved id must not blank a region that still has other sign-ins to
   * fall back on, and a region the user deliberately cleared must come back to
   * life the moment its first account appears.
   *
   * Deliberately fire-and-forget and idempotent — it runs on every settings
   * change, and `setRegionUsable` reports whether anything moved so a
   * no-change pass costs nothing beyond the scan. A failed scan leaves the
   * previous answer alone (the catalog starts permissive), so a transient
   * filesystem error never blanks a working region.
   */
  const refreshRegionUsability = async (): Promise<void> => {
    for (const region of REGION_KEYS) {
      let accounts
      try {
        accounts = await stacks[region].store.accounts()
      } catch {
        continue
      }
      if (stacks[region].catalog.setRegionUsable(accounts.length > 0)) invalidateCatalog()
    }
  }

  /**
   * Live registration handles per region, filled once the shim is listening.
   * A disabled region holds ZERO routes while staying registered: DSH allows
   * `replace([])` for exactly this case ("a settings section that emptied holds
   * zero routes while staying registered"), which is what makes the on/off
   * switch reversible without a restart. Withdrawing the adapter route is what
   * actually removes the region's models from DSH's model picker — hiding the
   * card tab alone would leave every model selectable.
   */
  const registration: Record<WorkBuddyRegion, {
    adapter?: AdapterRegistrationHandle
    directory?: DirectoryRegistrationHandle
  }> = { cn: {}, global: {} }

  /**
   * Publish each region's on/off state to the harness (issue #11-style region
   * switch). Both swaps are single synchronous sections, so no request can
   * observe a half-applied state, and `replace` announces itself through
   * `llm/adapters-updated`, which is what makes third-party consumers drop the
   * region too. No-op until the shim has registered; `applySelection` runs again
   * on every card write (and once more after registration completes), so a
   * toggle lands immediately.
   */
  const syncRegionRegistration = (value: Config): void => {
    // Each region owns its OWN adapter registration, so a per-region replace is
    // exactly that region's complete route set.
    for (const region of REGION_KEYS) {
      registration[region].adapter?.replace(regionEnabled(value, region) ? [WORKBUDDY_PROVIDERS[region]] : [])
    }
    // The directory is ONE registration holding BOTH entries: `replace` sets the
    // complete entry set, so it is called once with the full enabled list.
    // Replacing per region would make the last region win and silently drop the
    // other's entry — a disabled region would take its enabled sibling with it.
    registration.cn.directory?.replace(REGION_KEYS
      .filter(region => regionEnabled(value, region))
      .map(region => ({
        provider: WORKBUDDY_PROVIDERS[region],
        displayName: WORKBUDDY_PROVIDER_DISPLAY_NAMES[region],
        settingsNs,
        settingsPath: [],
        declared: false,
      })))
  }

  // Same-origin routes backing the Plugin-configuration card. `webServer`
  // can mount after this row, so wait reactively for it instead of sampling
  // ctx.get() once during apply (which silently loses all routes on Desktop).
  ctx.inject(['webServer'], (webCtx) => registerWorkBuddyStatusRoute(webCtx, {
    store: region => stacks[region].store,
    client,
    // Verifies whether some OTHER local account is still accepted upstream, so
    // a refused credential can be answered with "switch accounts" instead of a
    // re-login instruction that would change nothing. Cached per account and
    // issuance time; only ever consulted after a rejection.
    accountUsable: accountUsabilityProbe,
    displayModels: region => displayModels(current(), region),
    enabledModelIds: region => regionStateOf(current(), region).enabledModelIds ?? [],
    imageModelIds: region => regionStateOf(current(), region).imageModelIds ?? [],
    contextBudgets: region => regionStateOf(current(), region).contextBudgets ?? {},
    discoverModels,
    regionEnabled: region => regionEnabled(current(), region),
    /**
     * One minimal request per named model, through the region's own credential.
     *
     * Resolved here rather than in the route so the browser half never touches a
     * token: the route passes only model ids and receives only outcomes.
     *
     * `quotaRefreshAtMs` is the region's nearest monthly refresh point, read from
     * the SAME credit answer the card displays. It is the only cooldown this
     * service ever states — an exhausted monthly resource that resets at a known
     * time — so it is what makes "when can I use this again" answerable for an
     * out-of-credit result. Every other limited outcome has no time anywhere, and
     * the probe reports exactly that instead of inventing one.
     */
    async probeModels(region, modelIds, options) {
      let credential
      try {
        credential = await stacks[region].store.resolve()
      } catch (error: unknown) {
        // No usable credential is a batch-wide, actionable answer: report it as
        // each requested model's outcome rather than failing the whole route, so
        // the card can show WHICH problem it hit.
        return modelIds.map(modelId => ({
          modelId,
          outcome: 'credential-rejected' as const,
          message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        }))
      }
      const quotaRefreshAtMs = await quotaRefreshOf(region, credential)
      const results = []
      for (const modelId of modelIds) {
        results.push(await probeModel({
          client,
          credential,
          modelId,
          nowMs: Date.now(),
          ...quotaRefreshAtMs === undefined ? {} : { quotaRefreshAtMs },
          ...options?.signal === undefined ? {} : { signal: options.signal },
        }))
      }
      return results
    },
    // The card re-reads this on every poll and rescan, so a sign-in the user
    // performs after startup brings the region's models back without a restart.
    regionUsable(region, usable) {
      if (stacks[region].catalog.setRegionUsable(usable)) invalidateCatalog()
    },
    /**
     * The account pool, resolved per region.
     *
     * Region-scoped throughout: the CN and international pools are separate
     * stacks of accounts, so one region's pool can never rank or bill the
     * other's accounts.
     *
     * The pool decides who serves a FAILED request (see `failoverAccountFor`),
     * and it does so without writing `config.accounts[region]`: a retry borrows
     * another member's credential for that one request, leaving the record of
     * what the user picked — and the account the next request starts from —
     * untouched.
     */
    pool: {
      preferences: region => poolPreferencesOf(current(), region),
      members: region => poolMembersOf(region),
      /**
       * The checked accounts that resolve to a local sign-in.
       *
       * A local scan only — no upstream calls — so the route's empty-pool guard
       * can use it on every batch. {@link poolMembersOf} is the expensive one
       * (it fetches credits per account) and is not suitable there.
       */
      effectiveMemberAccountIds: async region => {
        const saved = poolPreferencesOf(current(), region).memberAccountIds
        if (saved.length === 0) return []
        const accounts = await stacks[region].store.accounts()
        // SAVED order, because this is the list the card compares against the
        // user's own checks; the roster it renders is ordered separately.
        return effectiveMembersOf(saved, new Set(accounts.map(account => account.id)))
      },
      /**
       * Local sign-ins the pool does NOT cover.
       *
       * Sent so the card can offer them to check in. Membership is an explicit
       * opt-in, and a user cannot opt in to an account the card never shows.
       */
      async otherAccounts(region) {
        const wanted = new Set(poolPreferencesOf(current(), region).memberAccountIds)
        const accounts = await stacks[region].store.accounts()
        return accounts
          .filter(account => !wanted.has(account.id))
          .map(account => ({ id: account.id, accountName: account.accountName }))
      },
      /**
       * Today's check-in state per account, for the pool table.
       *
       * Read per account through `credentialFor` (never `resolve`), so asking
       * about an account cannot change which one is billing. A per-account
       * failure is simply omitted, which the card renders as unknown.
       */
      async checkedInToday(region) {
        // Skip the read entirely when the pool is off: the card renders no pool
        // section in that state, so N upstream requests per poll would be pure
        // waste (and cost, on the upstream's side).
        if (!poolPreferencesOf(current(), region).enabled) return {}
        const store = stacks[region].store
        const accounts = await store.accounts()
        const now = Date.now()
        const entries = await Promise.all(accounts.map(async account => {
          // Serve from the cache while it is fresh. The card polls every 60
          // seconds, but "did this account check in today" only changes when a
          // check-in runs or the day rolls over — so re-reading it on every
          // poll meant ~14,400 requests/day for a 10-account pool. A check-in
          // this plugin performs invalidates its own entry (see `checkin`).
          const cached = checkinStateCache[region]?.[account.id]
          if (cached !== undefined && now - cached.atMs < CHECKIN_CACHE_MS) {
            return [account.id, cached.checkedIn] as const
          }
          const credential = await store.credentialFor(account.id).catch(() => undefined)
          if (credential === undefined) return undefined
          const status = await client.fetchCheckinStatus(credential).catch(() => undefined)
          if (status === undefined) return undefined
          checkinStateCache[region] = {
            ...checkinStateCache[region],
            [account.id]: { checkedIn: status.todayCheckedIn, atMs: now },
          }
          return [account.id, status.todayCheckedIn] as const
        }))
        return Object.fromEntries(entries.filter(entry => entry !== undefined))
      },
      async currentAccountId(region) {
        // Apply the SAME selection the request path applies, then report what the
        // store would bill. Going through `applyPoolSelection` instead of
        // re-deriving "who should serve" here is what keeps the card and the
        // router from disagreeing: one rule, one answer.
        //
        // It also means the card is correct immediately on a settings change,
        // rather than only after the next chat request happens to re-point the
        // store.
        await applyPoolSelection(region).catch(() => undefined)
        const credential = await stacks[region].store.current().catch(() => undefined)
        if (credential === undefined) return undefined
        // With a member measured unusable and nobody else to take over, the
        // request still falls back to the saved selection — but reporting that
        // account as "in use" would contradict the table right below it, which
        // says the same account is rate-limited. Answer "nobody" instead: the
        // card already has a state for that, and it is the truth.
        if (await servingAccountIsExcluded(region).catch(() => false)) return undefined
        return workbuddyAccountId(credential)
      },
      /**
       * Only the CN app rewards a daily check-in; the international region has
       * no equivalent here, so its card must not offer the action.
       */
      checkinSupported: region => region === 'cn',
      checkin: async region => {
        const rows = await checkinAllAccounts(
          await poolTargets(region),
          poolRunnerDeps(region),
        )
        // Drop the cached readings for accounts this batch touched, so the
        // card's check-in column reflects the result immediately rather than
        // showing the pre-batch state until the TTL expires.
        for (const row of rows) {
          if (row.status === 'failed') continue
          const cached = checkinStateCache[region]
          if (cached !== undefined) delete cached[row.accountId]
        }
        return rows
      },
      test: async (region, modelId, onRow) => {
        const rows = await testAllAccounts(
          await poolTargets(region),
          modelId,
          poolRunnerDeps(region),
          // Forwarded so the route can report each account as it lands. The
          // measurements are still persisted ONCE, after the whole batch: a
          // per-row write would interleave with a concurrent batch and re-read
          // the file on every account for nothing.
          onRow,
        )
        // Persist the measurements: they are what keeps failover off an account
        // that is known to be limited or rejected.
        await writePoolProbes(region, probeUpdatesOf(rows))
        return rows
      },
      catalog: region => displayModels(current(), region),
    },
  }))

  /**
   * The region's nearest monthly quota refresh, or undefined when unknown.
   *
   * The monthly resource (`CapacityType 4`) is the one package that never
   * expires and resets on a cycle, so its `refreshAtMs` is a real answer to
   * "when can I use this again" after the quota runs out. The probe passes it
   * through; a failure to read it is not an error, because a probe without a
   * cooldown is still a useful probe.
   */
  const quotaRefreshOf = async (
    region: WorkBuddyRegion,
    credential: Awaited<ReturnType<WorkBuddyCredentialStore['resolve']>>,
  ): Promise<number | undefined> => {
    try {
      const credits = await client.fetchCredits(credential)
      const refreshes = credits.packages
        .filter(pack => pack.monthly && pack.refreshAtMs !== undefined)
        .map(pack => pack.refreshAtMs as number)
      return refreshes.length === 0 ? undefined : Math.min(...refreshes)
    } catch {
      return undefined
    }
  }

  /**
   * The next account to try for a request whose current account just failed,
   * or `undefined` when this region's pool has nobody left.
   *
   * Reads the pool's EXISTING measurements instead of probing: a request that
   * just failed must not spend further requests deciding who serves next (and a
   * probe of the target model would itself be billed). Candidates are this
   * region's checked-in members in rank order, minus everyone this request has
   * already tried, minus anyone a measurement says cannot serve right now — a
   * limited account whose stated cooldown has not elapsed, or one whose
   * credential the upstream rejected.
   *
   * The pool switch gates this: off means the user's account serves every
   * request and a failure is reported as-is, exactly as before the pool existed.
   *
   * Reads the candidate through `credentialFor()`, never `resolve()`: the saved
   * selection and the store's runtime state stay untouched, so this is
   * per-request borrowing rather than a silent change of who pays.
   *
   * Uses `localPoolMembers`, NOT `poolMembersOf`. This runs on the failure path
   * of a request the user is already waiting on, and `poolMembersOf` fetches
   * credits per member — so the expensive version turned one failed request into
   * N extra upstream calls before the retry even left. The doc above always said
   * "must not spend further requests"; the code used to contradict it. Credits
   * still steer the ranking when a recent snapshot exists, because
   * `localPoolMembers` reads the one the card's poll already paid for.
   */
  const failoverAccountFor = async (
    region: WorkBuddyRegion,
    triedAccountIds: readonly string[],
  ): Promise<WorkBuddyCredential | undefined> => {
    if (!poolPreferencesOf(current(), region).enabled) return undefined
    const tried = new Set(triedAccountIds)
    for (const row of rankPool(await localPoolMembers(region), Date.now())) {
      // `excludedBy` carries the reason a measurement rules an account out.
      // Skipping on it is what makes "try until none is usable" mean usable
      // rather than merely "not yet tried": re-hitting an account the upstream
      // just limited would burn a round trip to learn what we already recorded.
      if (row.excludedBy !== undefined) continue
      if (tried.has(row.account.id)) continue
      const credential = await stacks[region].store.credentialFor(row.account.id)
      if (credential !== undefined) return credential
    }
    return undefined
  }

  /**
   * The last CREDITS reading per region, so a request can rank by balance
   * without fetching one.
   *
   * Credits are the ranking's second key, and they cost an upstream call per
   * member. A chat request must never pay that: it happens on the hot path, and
   * `fetchCredits` per member would turn one page of conversation into N extra
   * requests. So the request path uses whatever the pool last read (the card's
   * 60-second poll, a batch test, or a save) and simply skips the key when the
   * snapshot is too old to speak for today's balances.
   */
  const creditsSnapshot: Partial<Record<WorkBuddyRegion, ReadonlyMap<string, WorkBuddyPoolCredits>>> = {}
  /** How long a credits reading may steer routing. */
  const CREDITS_SNAPSHOT_MS = 10 * 60_000

  /** When each region's snapshot was taken, for the freshness check above. */
  const creditsSnapshotAt: Partial<Record<WorkBuddyRegion, number>> = {}

  /**
   * One region's pool members from LOCAL sources only: the credential store and
   * the probe store, plus the credits snapshot when it is fresh.
   *
   * The request path calls this on every chat completion, so it must not touch
   * the network. `poolMembersOf` is the honest-but-expensive version (it fetches
   * credits per member) and stays on the card's route, which is where those
   * readings come from in the first place.
   */
  async function localPoolMembers(region: WorkBuddyRegion): Promise<WorkBuddyPoolMember[]> {
    const accounts = await poolMemberAccounts(region)
    const probes = await readPoolProbes(region)
    const fresh = Date.now() - (creditsSnapshotAt[region] ?? 0) <= CREDITS_SNAPSHOT_MS
    const credits = fresh ? creditsSnapshot[region] : undefined
    return accounts.map(account => {
      const reading = credits?.get(account.id)
      return {
        account: { id: account.id, accountName: account.accountName },
        ...reading === undefined ? {} : { credits: reading },
        ...probes[account.id] === undefined ? {} : { probe: probes[account.id] as WorkBuddyPoolProbe },
        tokenExpiresAtMs: account.tokenExpiresAtMs,
      }
    })
  }

  /**
   * Record a failure a LIVE request hit, so the NEXT request starts from a
   * usable account.
   *
   * Without this the ranking only knew what the manual batch test had measured:
   * an account that had just answered 429 carried no measurement, so
   * `exclusionOf` returned "candidate" and the ranking kept picking it — every
   * request paid one failed round trip before failing over. Keeping traffic off
   * an account the upstream just refused is the pool's whole point
   * (`account-pool.ts` says exactly that about `rate-limited`), and it only
   * works if live failures count as measurements.
   *
   * Deliberately NOT recorded for `client` (HTTP 400): the upstream rejected the
   * REQUEST, which says nothing about the account, and recording it would
   * sideline a good account over a bad body.
   *
   * The reset time comes from the upstream's own words — the 429 body carries
   * 「将在 … 重置」 — which `cooldownOf` parses. When it states no time, the store's
   * own short window applies rather than a guess at a long one.
   *
   * The upstream's text is persisted alongside the outcome so the card can name
   * the reason. It is REDACTED first because this message is a raw upstream body:
   * without that, a failure containing a token-shaped string would write it into
   * a file on disk.
   */
  const recordAccountFailure = async (
    region: WorkBuddyRegion,
    accountId: string,
    failure: { status: number, kind: UpstreamErrorKind, message: string },
  ): Promise<void> => {
    if (!poolPreferencesOf(current(), region).enabled) return
    if (failure.kind === 'client') return
    // Only accounts this pool covers. Membership is the explicit "yes, spend
    // this account's credits" tick, and a measurement steers routing.
    const members = poolPreferencesOf(current(), region).memberAccountIds
    if (members.length > 0 && !members.includes(accountId)) return
    const outcome = outcomeOfFailure(failure.status, failure.message)
    const { retryAtMs } = cooldownOf({
      outcome,
      retryAfter: null,
      nowMs: Date.now(),
      body: failure.message,
    })
    const message = failure.message === '' ? '' : redactUpstreamText(failure.message)
    await writePoolProbes(region, {
      [accountId]: {
        outcome,
        atMs: Date.now(),
        // Named explicitly, because this site OVERWRITES whatever the last
        // "test" measured. Without the label, a user who watched this account
        // measure `ok` and then found it limited had no way to tell "a live
        // request really hit the limit just now" from "the file went back to
        // an older value" — and the record kept no history to check.
        source: 'live-request',
        ...retryAtMs === undefined ? {} : { retryAtMs },
        ...message === '' ? {} : { message },
      },
    })
  }

  /**
   * Point this region's store at whoever the pool's ranking says should serve.
   *
   * Called once per chat request. With the pool ON the ranking decides the
   * serving account — the whole point of the switch, and the reason the card can
   * show a "current account" that is not simply the saved selection. With the
   * pool OFF the override is CLEARED, which restores the user's own choice
   * immediately: leaving a stale override in place would keep billing under a
   * switch that reads as off.
   *
   * The override is runtime-only and never written to settings, so the user's
   * recorded choice survives untouched either way — turning the pool off gives
   * it back verbatim.
   *
   * Best-effort: a failure here leaves the previous state in effect, and the
   * request still goes out (to the user's account when the pool is off, which is
   * the safe default).
   */
  const applyPoolSelection = async (region: WorkBuddyRegion): Promise<void> => {
    const store = stacks[region].store
    if (!poolPreferencesOf(current(), region).enabled) {
      store.setRotatedAccount(undefined)
      return
    }
    const winner = rankPool(await localPoolMembers(region), Date.now())
      .find(row => row.excludedBy === undefined)
    // Nobody usable is NOT "no account": clearing the override hands the REQUEST
    // to the saved selection, and the failure is then reported honestly instead of
    // being masked by a pool with nothing better to offer. (The card does not
    // present that fallback as healthy — see `servingAccountIsExcluded`.)
    store.setRotatedAccount(winner?.account.id)
  }

  /**
   * Whether the account the store would bill is one the pool has measured as
   * unusable.
   *
   * The two questions differ exactly when the pool runs out of usable members: a
   * REQUEST still has to go somewhere (the saved selection), but the CARD must
   * not label that account "in use" while the same table says it is rate-limited.
   * One screen contradicting itself is how a user learns to trust neither half —
   * and "the pool moved to an available account" is unverifiable if the display
   * keeps naming an account the table calls excluded.
   */
  const servingAccountIsExcluded = async (region: WorkBuddyRegion): Promise<boolean> => {
    if (!poolPreferencesOf(current(), region).enabled) return false
    const credential = await stacks[region].store.current().catch(() => undefined)
    if (credential === undefined) return false
    const servingId = workbuddyAccountId(credential)
    const row = rankPool(await localPoolMembers(region), Date.now())
      .find(candidate => candidate.account.id === servingId)
    // Not a member at all (unchecked, or the pool is empty) means the pool has no
    // opinion, so it must not assert one.
    return row !== undefined && row.excludedBy !== undefined
  }

  /**
   * One region's POOL members, each with its credits and last measurement.
   *
   * Only CHECKED accounts: an unchecked account is not a candidate to bill, so
   * it must not reach the ranking that decides who serves.
   *
   * Read through `credentialFor()` — never `resolve()` — so no account's
   * selection state is touched: a batch must measure every member without
   * changing which one is billing. Credits are fetched per account and a
   * failure degrades to "unknown" for that row only — one unreadable balance
   * must not blank the whole pool.
   */
  async function poolMembersOf(region: WorkBuddyRegion): Promise<WorkBuddyPoolMember[]> {
    const store = stacks[region].store
    const accounts = await poolMemberAccounts(region)
    const probes = await readPoolProbes(region)
    const rows = await Promise.all(accounts.map(async account => {
      const credential = await store.credentialFor(account.id).catch(() => undefined)
      const credits = credential === undefined
        ? undefined
        : await client.fetchCredits(credential).catch(() => undefined)
      return {
        account: { id: account.id, accountName: account.accountName },
        ...credits === undefined ? {} : {
          credits: {
            // The upstream client already aggregates these two, and the card
            // displays the same figures — so re-deriving them here would let
            // the pool and the card disagree about one account's expiry.
            total: credits.total,
            expiringSoon: credits.expiringSoon,
            ...credits.nearestExpiryMs === undefined
              ? {}
              : { nearestExpiryMs: credits.nearestExpiryMs },
          },
        },
        ...probes[account.id] === undefined ? {} : { probe: probes[account.id] as WorkBuddyPoolProbe },
        tokenExpiresAtMs: account.tokenExpiresAtMs,
      }
    }))
    // Remember the balances for the REQUEST path, which cannot afford to fetch
    // them (`localPoolMembers`). Written here because this is the one place the
    // pool pays for a credits reading — the card's poll and every batch test run
    // through it — so the snapshot is exactly as fresh as the numbers the user
    // is looking at.
    creditsSnapshot[region] = new Map(
      rows
        .filter(row => row.credits !== undefined)
        .map(row => [row.account.id, row.credits as WorkBuddyPoolCredits]),
    )
    creditsSnapshotAt[region] = Date.now()
    return rows
  }

  /** One region's pool preferences, with the schema's defaults applied. */
  const poolPreferencesOf = (config: Config, region: WorkBuddyRegion) => {
    const pool = regionStateOf(config, region).pool
    const probeInputTokens = pool?.probeInputTokens
    return {
      enabled: pool?.enabled === true,
      targetModelId: pool?.targetModelId ?? '',
      // Passed through RAW (not coerced here): `resolveProbeInputTokens` owns
      // that decision and is the only place that knows the offered set. Coercing
      // in two places is how a menu and its validation drift apart.
      //
      // Spread rather than assigned, because `exactOptionalPropertyTypes` makes
      // an explicit `undefined` a different thing from an absent key — and the
      // consumers of this type rely on absence meaning "never chose".
      ...probeInputTokens === undefined ? {} : { probeInputTokens },
      memberAccountIds: pool?.memberAccountIds ?? [],
    }
  }

  /**
   * The accounts the user has checked into this region's pool.
   *
   * Membership is an EXPLICIT opt-in list, not "every local sign-in": the two
   * batch actions spend real credits and claim real rewards, so which accounts
   * they touch has to be the user's decision rather than a side effect of
   * having signed in on this machine. An account that is not checked is
   * untouched by check-in, testing, and rotation alike.
   */
  async function poolMemberAccounts(region: WorkBuddyRegion) {
    const saved = poolPreferencesOf(current(), region).memberAccountIds
    if (saved.length === 0) return []
    const accounts = await stacks[region].store.accounts()
    const byId = new Map(accounts.map(account => [account.id, account]))
    // The shared rule ANSWERS this question and this site only supplies the
    // store's order (see `effectiveMembersOf`'s contract) plus the id→row
    // lookup. The obvious shape — filter `accounts` by a set built from the
    // rule — is deceptive: it makes the delegation unobservable, because
    // `accounts.filter(id ∈ (store ∩ saved))` collapses to `accounts ∩ saved`
    // for ANY membership rule at all. That version passed every test while the
    // rule could have been deleted; the independent verification proved it. So
    // the rule's own output drives the result.
    return effectiveMembersOf(
      accounts.map(account => account.id),
      new Set(saved),
    ).flatMap(id => {
      const account = byId.get(id)
      return account === undefined ? [] : [account]
    })
  }

  /** The batch runner's view of one region's pool members. */
  async function poolTargets(region: WorkBuddyRegion): Promise<WorkBuddyPoolTarget[]> {
    const accounts = await poolMemberAccounts(region)
    return accounts.map(account => ({
      accountId: account.id,
      accountName: account.accountName,
    }))
  }

  /**
   * The two actions' shared dependency set.
   *
   * `credentialFor` — never `resolve()` — is what makes a batch possible at
   * all: it fetches any account's credential WITHOUT changing the region's
   * selection, so testing every account cannot switch the account that bills
   * the user's live traffic.
   */
  function poolRunnerDeps(region: WorkBuddyRegion): WorkBuddyPoolRunnerDeps {
    const store = stacks[region].store
    return {
      credentialFor: accountId => store.credentialFor(accountId),
      fetchCheckinStatus: credential => client.fetchCheckinStatus(credential),
      claimDailyCheckin: credential => client.claimDailyCheckin(credential),
      probe: async (credential, modelId) => {
        // The SAME quota-refresh input the single-model probe route passes.
        // Without it an exhausted account reports "the upstream gave no time",
        // so the card could not say when a drained account returns — and the
        // pool would re-test it blindly instead of waiting for the reset. The
        // read is best-effort: a probe without a cooldown is still a useful
        // probe (see `quotaRefreshOf`).
        const quotaRefreshAtMs = await quotaRefreshOf(region, credential)
        // The user's chosen probe size, coerced against the offered set. Read
        // HERE rather than captured when these deps were built, so changing the
        // setting takes effect on the very next test rather than the next reload.
        const inputTokens = resolveProbeInputTokens(
          poolPreferencesOf(current(), region).probeInputTokens,
        )
        return probeModel({
          client,
          credential,
          modelId,
          nowMs: Date.now(),
          inputTokens,
          ...quotaRefreshAtMs === undefined ? {} : { quotaRefreshAtMs },
        })
      },
    }
  }

  // Settings registration (0.1.7+ only).
  // `SettingsForms` dropped `installSection` entirely and exposes
  // `configure({auto}, owner)`; calling the removed method unconditionally made
  // `apply()` throw on 0.1.7 (`ctx.settings.installSection is not a function`)
  // and took down the WHOLE plugin. Since 2.1.0 the plugin supports DSH
  // 0.1.7-rc.1 and up only, so `configure` is the sole path and is called
  // unconditionally — the pre-0.1.7 `SettingsProvider.installSection` branch
  // is gone with the line it served.
  //
  // The call goes through a narrow local type rather than a blanket `any`: the
  // installed typings describe the 0.1.5 line only, so `configure` is not on
  // `SettingsProvider` and the event names below are not in `Events`. Naming
  // the shapes here keeps the widening honest and reviewable.
  interface SettingsShapes {
    configure: (presentation: { auto?: boolean }, owner?: unknown) => () => void
  }

  // `inject` rather than a direct read: `settings` is an optional service, and
  // the callback runs once it is actually present. `configure` returns a
  // disposer that must be registered with the calling plugin's effects, or the
  // presentation policy leaks past disposal (the first-party plugins do the
  // same: `child.effect(() => child.settings.configure({ auto: false }, …))`).
  ctx.inject(['settings'], (sctx) => {
    const settings = sctx.settings as unknown as SettingsShapes
    ctx.effect(() => settings.configure({ auto: true }, ctx.fiber))
  })

  // 0.1.7 hands volatile values back as live references and announces each
  // write on this event, so the card's selections are re-read after one. The
  // event does not exist on 0.1.5, which never emits it.
  ;(ctx as unknown as { on(name: string, listener: () => void): unknown })
    .on('loader/volatile-update', () => {
      applySelection(current())
    })

  // Initial wiring: selections, per-region catalogs from the saved state.
  applySelection(config)

  // Attribute the legacy single-account selection to its own region once the
  // local scan can tell which one that is, then re-apply. Until this resolves
  // (or when no legacy field exists) both regions simply run their defaults.
  void (async () => {
    try {
      const region = await legacyAttributionRegion(current(), async candidate =>
        stacks[candidate].store.accounts())
      if (region === undefined) {
        // Either no legacy field, or the saved account vanished (the app
        // replaced its sign-in): both regions keep their defaults and the card
        // lets the user re-select.
        return
      }
      legacyAccountRegion = region
      applySelection(current())
    } catch {
      // Scan failure: keep defaults; the next card-driven scan converges.
    }
  })()

  let stopped = false

  ctx.effect(() => () => {
    stopped = true
    for (const region of REGION_KEYS) void stacks[region].shim.close()
    void clearHostHeartbeat()
  })

  void Promise.all(REGION_KEYS.map(region => stacks[region].shim.ready))
    .then(async () => {
      if (stopped) return

      const adapters = {} as Record<WorkBuddyRegion, WorkBuddyAdapter>
      try {
        // Constructed only once the listeners hold their ports: a provider's
        // models read the shim origin at construction time.
        for (const region of REGION_KEYS) {
          adapters[region] = createWorkBuddyAdapter({
            shim: stacks[region].shim,
            store: stacks[region].store,
            catalog: stacks[region].catalog,
            provider: WORKBUDDY_PROVIDERS[region],
            displayName: WORKBUDDY_PROVIDER_DISPLAY_NAMES[region],
            resolveAttachments: () => ctx.get('attachments'),
          })
        }
        invalidateCatalog = () => {
          for (const region of REGION_KEYS) adapters[region].invalidate()
        }

        let releaseAdapterCn: (() => void) | undefined
        let releaseAdapterGlobal: (() => void) | undefined
        let releaseDirectory: (() => void) | undefined
        try {
          // Always register the route first: an empty INITIAL registration is
          // invalid (`INVALID_ADAPTER`), while `replace([])` on a live one is
          // explicitly legal. `syncRegionRegistration` below then withdraws the
          // route for a region the user has switched off, in the same synchronous
          // section, so nothing observes the transient route.
          releaseAdapterCn = registration.cn.adapter = ctx.llm.registerAdapter([WORKBUDDY_PROVIDER], adapters.cn.adapter)
          releaseAdapterGlobal = registration.global.adapter = ctx.llm.registerAdapter([WORKBUDDY_GLOBAL_PROVIDER], adapters.global.adapter)
          releaseDirectory = registration.cn.directory = ctx.llm.registerConfigurableProviders([
            {
              provider: WORKBUDDY_PROVIDER,
              displayName: WORKBUDDY_PROVIDER_DISPLAY_NAMES.cn,
              settingsNs,
              settingsPath: [],
              declared: false,
            },
            {
              provider: WORKBUDDY_GLOBAL_PROVIDER,
              displayName: WORKBUDDY_PROVIDER_DISPLAY_NAMES.global,
              settingsNs,
              settingsPath: [],
              declared: false,
            },
          ])
        } finally {
          if (releaseAdapterCn === undefined || releaseAdapterGlobal === undefined || releaseDirectory === undefined) {
            // Registration threw; release whichever half landed.
            releaseAdapterCn?.()
            releaseAdapterGlobal?.()
            releaseDirectory?.()
          }
        }
        try {
          ctx.effect(() => () => {
            releaseAdapterCn?.()
            releaseAdapterGlobal?.()
            releaseDirectory?.()
          })
        } catch {
          // The plugin was disposed during registration; release immediately —
          // the plugin-level disposer already closed the shims.
          releaseAdapterCn?.()
          releaseAdapterGlobal?.()
          releaseDirectory?.()
        }

        // Converge both regions on the saved on/off state: a region switched off
        // while the harness was down is withdrawn here, before the startup seed
        // below. `syncRegionRegistration` is a no-op for the freshly registered
        // routes until this very call populates their handles.
        syncRegionRegistration(current())

        ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
          const region = regionOfProvider(request.provider ?? '')
          if (region === undefined) return []
          // A switched-off region advertises nothing: its route is withdrawn, so
          // this is defence in depth against a stale model-picker refresh.
          if (!regionEnabled(current(), region)) return []
          const discovered = await discoverModels(region, signal)
          const state = regionStateOf(current(), region)
          const next = withImageSelection(
            deriveCatalog(
              discovered,
              new Set(state.enabledModelIds ?? []),
              state.contextBudgets ?? {},
            ),
            new Set(state.imageModelIds ?? []),
          )
          return next.map(model => ({
            id: model.id,
            name: workBuddyDisplayName(model),
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            inputModalities: workBuddyModelInput(model),
          }))
        })

        // The host bundle is live: write a heartbeat so the status CLI can
        // report host health without a browser. Cleared on disposal; a stale
        // heartbeat after a crash is detected by PID in the reader.
        void writeHostHeartbeat()
      } catch (error: unknown) {
        ctx.logger.error('dsh-connect-workbuddy: provider registration failed', error)
        return
      }

      // Seed each region's catalog from that region's selected account (or the
      // live sign-in default when nothing is selected yet).
      if (stopped) return

      for (const region of REGION_KEYS) {
        // A switched-off region is skipped entirely: its route is withdrawn, so
        // the request would be pure waste — and skipping it is also what keeps a
        // disabled region from contributing an error to the log on every start.
        if (!regionEnabled(current(), region)) continue
        void (async () => {
          try {
            const credential = await stacks[region].store.resolve()
            if (stopped) return
            const models = await client.fetchModels(credential)
            if (stopped) return
            const state = regionStateOf(current(), region)
            stacks[region].catalog.set(withImageSelection(
              deriveCatalog(models, new Set(state.enabledModelIds ?? []), state.contextBudgets ?? {}),
              new Set(state.imageModelIds ?? []),
            ))
            adapters[region].invalidate()
            // `lastCatalog` is deliberately NOT seeded here: it belongs to the
            // user's saved selection, written only by the card's explicit save
            // (via settingsScope). Until then the card shows the live fallback
            // directory and one press of "Refresh" captures the real one.
          } catch (error: unknown) {
            ctx.logger.warn(
              `dsh-connect-workbuddy: dynamic ${region} model catalog unavailable; serving the static fallback list`,
              error,
            )
          }
        })()
      }
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-connect-workbuddy: loopback endpoint failed to start; providers not registered', error)
    })
}
