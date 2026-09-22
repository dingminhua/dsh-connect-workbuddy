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
import { WorkBuddyCredentialStore } from './auth.ts'
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
  authFileName,
  defaultDesktopAuthCandidates,
  defaultDesktopAuthDirs,
  defaultDesktopAuthPath,
  hasEncryptedCredentialFields,
  legacyWorkbuddyOwnAuthPath,
  parseWorkBuddyAuth,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_AUTH_FILENAME,
  workbuddyAccountId,
  WorkBuddyCredentialStore,
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
  registerWorkBuddyStatusRoute,
  workBuddyWebStatus,
  type WorkBuddyStatusRouteOptions,
} from './web-status.ts'
export {
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_CHECKIN_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_REGION_PARAM,
  WORKBUDDY_REGIONS,
  WORKBUDDY_USAGE_PATH,
  regionOfStatusUrl,
  toPersistedWorkBuddyModel,
  withWorkBuddyRegion,
  regionEnabledOf,
  nextRegionEnabled,
  nextRegionSlots,
  type WorkBuddyWebAccount,
  type WorkBuddyWebCheckin,
  type WorkBuddyWebCredits,
  type WorkBuddyWebModel,
  type WorkBuddyWebPackage,
  type WorkBuddyWebRegion,
  type WorkBuddyWebSearchPath,
  type WorkBuddyWebUsage,
} from './status-paths.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-connect-workbuddy'

/** The model registry required before the provider can register. */
export const inject = ['llm', 'settings']

/** Settings namespace for the plugin configuration card. */
export const WORKBUDDY_SETTINGS_NS = 'workbuddy' as SettingsNamespace

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

const regionStateConfig = z.object({
  enabled: z.boolean().default(true).description('Whether this region\'s provider is offered to DSH (opt-out; false withdraws it entirely)'),
  lastCatalog: z.array(modelConfig).default([]),
  enabledModelIds: z.array(z.string()).default([]),
  imageModelIds: z.array(z.string()).default([]),
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}),
})

const accountSelectionConfig = z.object({
  cn: z.string().description('Selected domestic (CN) account id (never a token)'),
  global: z.string().description('Selected international account id (never a token)'),
})

export const Config: z<Config> = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)'),
  accountId: z.string().description('Deprecated: pre-split account selector, attributed to its own region'),
  accounts: accountSelectionConfig.description('Per-region account selections, keyed cn | global'),
  regions: z.dict(regionStateConfig).default({}).description('Per-region model directory and selection, keyed cn | global'),
  lastCatalog: z.array(modelConfig).description('Deprecated: pre-region-split CN model directory') as z<WorkBuddyModelInfo[]>,
  enabledModelIds: z.array(z.string()).default([]).description('Deprecated: pre-region-split CN selection'),
  imageModelIds: z.array(z.string()).default([]).description('Deprecated: pre-region-split CN image opt-in'),
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}).description('Deprecated: pre-region-split CN context budgets'),
})

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
  const stored = config.regions?.[region]
  if (stored !== undefined) return stored
  if (region !== 'cn') return {}
  return {
    ...config.lastCatalog === undefined ? {} : { lastCatalog: config.lastCatalog },
    ...config.enabledModelIds === undefined ? {} : { enabledModelIds: config.enabledModelIds },
    ...config.imageModelIds === undefined ? {} : { imageModelIds: config.imageModelIds },
    ...config.contextBudgets === undefined ? {} : { contextBudgets: config.contextBudgets },
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
  const configured = value.accounts?.[region]
  if (configured === '') return undefined
  if (configured !== undefined) return configured
  return legacyAccountRegion === region ? value.accountId : undefined
}

/** Whether a region carries the Clear sentinel rather than a saved choice. */
export function regionCleared(value: Config, region: WorkBuddyRegion): boolean {
  return value.accounts?.[region] === ''
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

  const stacks = {} as Record<WorkBuddyRegion, WorkBuddyRegionStack>
  for (const region of REGION_KEYS) {
    const store = new WorkBuddyCredentialStore({
      region,
      ...config.authFile === undefined ? {} : { desktopPath: config.authFile },
      refresh: credential => client.refreshToken(credential),
    })
    const catalog = new WorkBuddyCatalog(region)
    const shim = createWorkBuddyShim({ store, client, catalog, logger: ctx.logger })
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
  const configuredModels = (value: Config, region: WorkBuddyRegion): readonly WorkBuddyModelInfo[] => {
    const state = regionStateOf(value, region)
    return withImageSelection(
      deriveCatalog(
        state.lastCatalog?.length ? state.lastCatalog : fallbackModelsFor(region),
        new Set(state.enabledModelIds ?? []),
        state.contextBudgets ?? {},
      ),
      new Set(state.imageModelIds ?? []),
    )
  }
  // What the card displays: this region's last-refreshed directory, so the user
  // re-reads the current catalog rather than a stale saved snapshot.
  const displayModels = (value: Config, region: WorkBuddyRegion): readonly WorkBuddyModelInfo[] => {
    const state = regionStateOf(value, region)
    return state.lastCatalog?.length ? state.lastCatalog : fallbackModelsFor(region)
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
  const applySelection = (value: Config): void => {    for (const region of REGION_KEYS) {
      stacks[region].store.setDesktopPath(value.authFile)
      stacks[region].store.selectAccount(effectiveAccountFor(region, value))
      stacks[region].catalog.set(configuredModels(value, region))
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
        settingsNs: WORKBUDDY_SETTINGS_NS,
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
    // The card re-reads this on every poll and rescan, so a sign-in the user
    // performs after startup brings the region's models back without a restart.
    regionUsable(region, usable) {
      if (stacks[region].catalog.setRegionUsable(usable)) invalidateCatalog()
    },
  }))

  ctx.settings.installSection(ctx, WORKBUDDY_SETTINGS_NS, Config, config, {
    setSource(source: () => Config) { current = source },
    onChange() { applySelection(current()) },
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
              settingsNs: WORKBUDDY_SETTINGS_NS,
              settingsPath: [],
              declared: false,
            },
            {
              provider: WORKBUDDY_GLOBAL_PROVIDER,
              displayName: WORKBUDDY_PROVIDER_DISPLAY_NAMES.global,
              settingsNs: WORKBUDDY_SETTINGS_NS,
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

        ctx.llm.registerModelDiscovery(WORKBUDDY_SETTINGS_NS, async (request, signal) => {
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
