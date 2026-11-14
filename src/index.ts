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
import { preferredAccountName, workbuddyAccountId, WorkBuddyCredentialStore, type WorkBuddyCredential } from './auth.ts'
import { deriveCatalog, fallbackModelsFor, withoutRouters, WorkBuddyCatalog } from './catalog.ts'
import type { WorkBuddyContextBudget, WorkBuddyModelInfo } from './catalog.ts'
import {
  catalogFingerprint,
  isUnconfiguredFallbackSnapshot,
  repairedCatalog,
  resolveRoster,
} from './catalog-sync.ts'
import {
  clearRegionAccountSelection,
  healRegionsField,
  writeRegionCatalog,
  type HostSettingsService,
} from './catalog-write.ts'
import { createAccountUsabilityProbe } from './credential-recovery.ts'
import {
  createDeviceProfileLookup,
  describeDerivedDevices,
  readDeviceSettings,
  saveDeviceProfile,
  saveDeviceSdkSettings,
  setDeviceMode,
} from './device-profile.ts'
import type { WorkBuddyDeviceSettings } from './device-profile.ts'
import { createDeviceSdkPort, createTuringSdk } from './turing-sdk.ts'
import { WORKBUDDY_DEVICE_TOKEN_FILE_ENV } from './device-token.ts'
import { BENEFIT_CACHE_MS, claimableBenefits, type WorkBuddyBenefitView } from './benefits.ts'
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
import { resolveCnGateway } from './cn-gateway.ts'
import type { CnGatewayRejection } from './cn-gateway.ts'
import { createContextRescue } from './context-rescue.ts'
import type { RescueAgents, RescueCompaction, RescueTokenMeter } from './context-rescue.ts'
import {
  channelContinueSettingsOf,
  installChannelContinue,
  type ContinueAgent,
} from './channel-continue.ts'
import type { WorkBuddyAdapter, ForeignThinkingBlock } from './adapter.ts'
import { createWorkBuddyShim } from './shim.ts'
import { MEDIA_MODEL_TTL_MS, registerWorkBuddyImageTool, type ToolsServiceLike } from './image-tool.ts'
import { registerWorkBuddyVideoTool } from './video-tool.ts'
import { IMAGE_TAG_TEXT_TO_IMAGE } from './image-gen.ts'
import type { WorkBuddyMediaModel } from './image-gen.ts'
import {
  createCliBridgeRuntime,
  mountCommandSurface,
  mountToolSurface,
  type CliBridgeRuntime,
  type CliBridgeSettings,
} from './cli-bridge/mount.ts'
import type { DirectoryOf } from './cli-bridge/tool.ts'
import { readProjectedState } from './cli-bridge/services.ts'
import type {
  BridgeCommandsService,
  BridgeProjectionReader,
  BridgeToolsService,
} from './cli-bridge/services.ts'
import { recordBodyReport, type WorkBuddyUsageCounts } from './body-report.ts'
import { cooldownOf, outcomeOfFailure, probeModel, redactUpstreamText, resolveProbeInputTokens } from './probe.ts'
import { measureTps } from './tps.ts'
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
import { exclusionOf } from './account-pool.ts'
import type { WorkBuddyPoolCredits, WorkBuddyPoolExclusion, WorkBuddyPoolMember, WorkBuddyPoolProbe } from './account-pool.ts'
import { resolveTargetModel } from './account-pool.ts'
import { oauthPoll, oauthStart } from './oauth.ts'
import { mergeTransferRecords, parseTransferFile, previewTransferFile, transferRecordOf } from './transfer.ts'
import {
  effectiveMembersOf,
  rankPool,
} from './account-pool.ts'
import { readPoolProbes, writePoolProbes, reconcilePoolCredits } from './account-pool-store.ts'
import {
  autoCheckinRegions,
  emptyAutoCheckinState,
  foldAttempt,
  isDue,
  localDayKey,
  nextDelayMs,
  pendingTargets,
  checkinReadingFresh,
  todaySummary,
  AUTO_CHECKIN_IDLE_MS,
} from './auto-checkin.ts'
import type { AutoCheckinState } from './auto-checkin.ts'
import { readAutoCheckinState, writeAutoCheckinState } from './auto-checkin-store.ts'
import { createFileRosterSeenStore } from './roster-seen-store.ts'
import type { RosterSeenStore } from './roster-seen-store.ts'
import type { WorkBuddyShim } from './shim.ts'
import { WorkBuddyUpstreamClient, APP_VERSION, knownRegionOf, regionOf } from './upstream.ts'
import type { WorkBuddyRegion } from './upstream.ts'
import { attachBusyLevels } from './busy.ts'
import type { WorkBuddyBusyLevel } from './busy.ts'
import { registerWorkBuddyStatusRoute } from './web-status.ts'
import { clearHostHeartbeat, writeHostHeartbeat, type WorkBuddyHostHeartbeatOwner } from './host-heartbeat.ts'

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
// Re-exported above for consumers, and imported here because the image-selection
// seeding (issue #168) is what applies the same table the card pre-ticks with.
import { imageDefaultFor } from './native-modality.ts'
import { defaultOffModelIds, offDefaultFor, lastRefusalFor, recordRefusal, REFUSES_OFF_MODEL_IDS, withEffectiveOff } from './off-thinking.ts'
export { defaultOffModelIds, offDefaultFor, REFUSES_OFF_MODEL_IDS, withEffectiveOff }
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
  modelIdOfBody,
  knownRegionOf,
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
  type WorkBuddyHostHeartbeatOwner,
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
  WORKBUDDY_TPS_PATH,
  WORKBUDDY_REGION_PARAM,
  WORKBUDDY_REGIONS,
  WORKBUDDY_SETTINGS_NS,
  WORKBUDDY_USAGE_PATH,
  WORKBUDDY_POLL_INTERVALS_MS,
  WORKBUDDY_DEFAULT_POLL_INTERVAL_MS,
  regionOfStatusUrl,
  toPersistedWorkBuddyModel,
  withWorkBuddyRegion,
  regionEnabledOf,
  nextRegionEnabled,
  nextRegionSlots,
  // The shape of the `regions` field is not trustworthy in a profile written by
  // an older build (see `healedRegionsMap` in `src/status-paths.ts`): the Host's
  // read and the catalog repair's write both go through this narrowing, so one
  // rule heals both halves (the "restart reset" report).
  regionsMapOf,
  regionsFieldIsCorrupt,
  // 从 shared bridge 转出给消费者（`WorkBuddy.unwrapVolatileDeep`），本文件不直接用。
  unwrapVolatileDeep,
  type WorkBuddyWebAccount,
  type WorkBuddyWebCheckin,
  type WorkBuddyWebCredits,
  type WorkBuddyWebModel,
  type WorkBuddyWebPackage,
  type WorkBuddyWebPoolExclusion,
  type WorkBuddyWebRegion,
  type WorkBuddyWebSearchPath,
  type WorkBuddyWebTpsResult,
  type WorkBuddyWebUsage,
  type WorkBuddyTransferExportAnswer,
  type WorkBuddyTransferImportAnswer,
  type WorkBuddyTransferPreview,
  type WorkBuddyTransferRecord,
  type WorkBuddyCreditPosition,
} from './status-paths.ts'
export {
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_CHECKIN_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_PROBE_PATH,
  WORKBUDDY_TPS_PATH,
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
  regionsMapOf,
  regionsFieldIsCorrupt,
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
  /**
   * Whether this region's credit balance shows at the DSH sidebar foot.
   *
   * Per-region, independently switched: WB CN and WB AI are separate accounts
   * on separate gateways, so a user holding only one of them must be able to
   * show exactly that one. Opt-out — an absent value reads as ON, so a config
   * written before this switch existed keeps whatever the default was.
   */
  showCreditsInMainUi?: boolean
  /**
   * Whether the composer pill shows its "· N 新模型" segment (opt-IN).
   *
   * Absent means OFF: "new" means first seen by this machine, so on a fresh
   * install the whole roster qualifies and the number means nothing.
   */
  showNewModelsInMainUi?: boolean
  /**
   * Whether the model may call the image-generation tool here (opt-IN).
   *
   * The only switch in this interface where an ABSENT value means OFF. Every
   * other flag here governs something the user can undo by clicking again;
   * this one authorizes the model to spend real credits on its own, so an
   * upgrade — or a config whose value could not be read — must leave it off.
   */
  imageToolEnabled?: boolean
  /**
   * Same opt-IN shape as `imageToolEnabled`, but for the video-generation tool
   * (`workbuddy_draw_video`). Absent means OFF, for the same reason: the model
   * decides to spend, so an upgrade must never hand out a spending capability.
   */
  videoToolEnabled?: boolean
  /**
   * Which text-to-image model this region generates with (issue #241).
   *
   * Absent or `''` means "no choice" — the tool takes the catalog's first model
   * for that tag, so a config predating this field keeps its exact behaviour.
   * Set to `hunyuan-image-v3.0` to get output WITHOUT the "AI生成 WORKBUDD>"
   * watermark, at ~11.1 credits/image instead of ~6 and with a smaller maximum
   * size (2048 px edge, 1,048,576 px total).
   *
   * A free id rather than an enum, deliberately: the watermark-free model is not
   * in the upstream catalog (it is the official CLI's hard-coded fallback), and
   * a stale pick must degrade to "no choice" rather than fail a generation.
   */
  preferredImageModel?: string
  /**
   * The video model the user pinned in the card, keyed by video tag
   * (`text-to-video` / `image-to-video`), value is a model id from this
   * region's own catalog.
   *
   * Per-REGION and per-TAG on purpose: the two modes can be served by different
   * models (a catalog may carry a text-to-video-only row), and model ids do not
   * cross regions (CN publishes `kling-video-v3` and `minimax-video-h3`,
   * international only `kling-video-v3`). Absent or stale is NOT an error: the
   * tool falls back to the first model of the group, because a preference the
   * catalog no longer carries must not fail a generation the user asked for.
   */
  preferredVideoModels?: Record<string, string>
  /**
   * WHERE this region's credit readout sits (issue #62).
   *
   * Two seats, because the first one is not always available:
   *
   *   - `composer` — the composer row (`conversation.input.right`), shared
   *     with the shell's own controls. It is the closer, more glanceable seat,
   *     and it is the default so nothing moves for anyone who does not choose.
   *   - `stats` — the ambient dock below the composer card
   *     (`conversation.composer.dock`), where the shell renders its own
   *     round/step/token pills. That row is a LIST seat whose shipped occupant
   *     registers separately, so a third-party plugin that ALSO parks something
   *     in the composer row cannot crowd this readout out of existence.
   *
   * The report behind this (issue #62) was exactly that: with another plugin
   * installed, the readout vanished from the composer row. Making the seat a
   * choice is what keeps one plugin's presence from deciding another's.
   */
  creditPosition?: WorkBuddyCreditPosition
  /** The last-refreshed directory for this region; what the card displays. */
  lastCatalog?: WorkBuddyModelInfo[]
  /** The user's selection in this region, as model ids. */
  enabledModelIds?: string[]
  /**
   * Model ids the user opted into image input for this region.
   *
   * Every id here is honoured. What the SAVED array cannot express is the
   * difference between "I looked at this model and unticked it" and "this model
   * did not exist when the list was last refreshed" — so the runtime also adds
   * a model this build's vendor table classifies as verified-multimodal, UNLESS
   * {@link imageSelectionExplicit} says the user has edited these boxes. See
   * `effectiveImageIds` (issue #168); the seed never rewrites this array.
   */
  imageModelIds?: string[]
  /**
   * Whether the image boxes have been edited by a human (issue #168).
   *
   * `imageModelIds` alone cannot distinguish a DECISION from a leftover refresh
   * snapshot: the array is written both by the card's save (a judgement) and by
   * a catalog refresh (what the roster said on that day). Without that
   * distinction a model the roster gained after the last refresh was stamped
   * `multimodal: false` purely by its ABSENCE, `workBuddyModelInput` answered
   * `['text']`, and the host refused the attachment with
   * `MODEL_DOES_NOT_SUPPORT_IMAGES` — 「这个模型不支持图片」 — for a model the
   * plugin's own table calls verified-multimodal.
   *
   * `false`/absent means "nobody has chosen yet, so the table may fill the gaps";
   * a card save sets `true`, after which this array is the whole answer — which
   * is what keeps an explicit UNTICK of a verified-multimodal model from being
   * silently re-ticked on the next read.
   */
  imageSelectionExplicit?: boolean
  /**
   * Model ids whose `off` thinking level is offered (issue #34). Seeded from
   * the built-in rule (upstream declaration minus the models known to reject
   * `off`) when first read; the card's checkbox toggles membership.
   */
  offModelIds?: string[]
  /** Local DSH context budget per model in this region. */
  contextBudgets?: Record<string, WorkBuddyContextBudget>
  /**
   * The thinking tier each model runs on when a caller names none (issue #179).
   *
   * Keyed by model id because the vocabularies disagree across one roster (see
   * `regionStateConfig`'s declaration of the same field). An ABSENT key follows
   * the model's own upstream `defaultEffort` — the runtime answer is computed by
   * `defaultEffortFor` in `src/default-effort.ts`, which is the only place that
   * decides, and which refuses to name a tier the model does not declare.
   */
  defaultThinkingEfforts?: Record<string, string>
  /**
   * An alternative CN gateway host (issue #220).
   *
   * Only the CN region reads it; the international gateways follow the
   * credential's own brand domain and have no equivalent setting.
   *
   * EXISTS FOR ONE CASE: a corporate network that filters on the TLS
   * ClientHello's SNI. `copilot.tencent.com` is then reset before any HTTP is
   * sent (`ECONNRESET`, <100ms) while the WorkBuddy desktop app keeps working,
   * because the app reads a failover list from its own config and also uses
   * `wb.tencentbuddy.com`. Without this field the plugin is simply unusable on
   * such a network, and looks broken rather than filtered.
   *
   * The value is a HOST, validated against a closed allowlist by
   * `resolveCnGateway` (`src/cn-gateway.ts`) — never a free-form URL. That
   * allowlist is the security boundary, not a convenience: this base carries
   * `Authorization: Bearer <token>` on every CN request, so accepting an
   * arbitrary host would turn a settings file into a token-exfiltration
   * primitive. Empty/absent means the built-in gateway, i.e. the behaviour
   * before #220.
   */
  cnBase?: string
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
   * It deliberately does NOT change the SAVED selection: while on, the pool
   * picks the serving account for every request (`applyPoolSelection` ranks
   * the usable members and sets a per-request override), but that override is
   * per-request borrowing — turning the pool off hands every request back to
   * the account the user chose, and the card can keep reporting who really
   * served. (An older version of this comment said the pool "does NOT change
   * which account serves NEXT", which was wrong the moment `applyPoolSelection`
   * started ranking on every request; what never changes is the saved choice.)
   */
  enabled?: boolean
  /** Model id to test; `''` means auto-pick a free model from this region. */
  targetModelId?: string
  /**
   * Per-account override of {@link targetModelId}, keyed by account id (#61).
   *
   * `6004` is an ACCOUNT × MODEL condition, so "can this account serve" has no
   * single answer: the reporter measured two accounts where one model answered
   * and another returned `429 / 6004` in the same second. The region-wide target
   * stays the default — this map only says "for THIS account, test THAT model",
   * which is what makes the pool's verdict match the model the user is actually
   * chatting with. An id that is no longer in the catalog is reported as stale
   * rather than replaced, so no credits are spent on a model nobody chose.
   */
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
  /**
   * The user's hand-ordered pool order, as a list of account ids.
   *
   * SEPARATE FROM MEMBERSHIP: this is purely a display/preference of what the
   * user wants the pool to prefer, and it is independent of which accounts are
   * checked in. An id here need not be in {@link memberAccountIds} — the
   * ranking only consults this order for accounts that are actually members,
   * and ids that are not listed simply sort last. Keeping them separate lets
   * the user reorder first and check accounts in later without the ordering
   * being destroyed by an unrelated membership edit (see `poolPreferencesOf`,
   * which must always carry this list through alongside membership). Ids that
   * no longer resolve to a listed account are dropped on transmit, never
   * silently merged into membership.
   */
  orderAccountIds?: string[]
  /**
   * Whether the plugin claims the daily check-in by itself (issue #191).
   *
   * OFF by default. Claiming a daily reward is a real WRITE on the user's
   * account, and this plugin deliberately shipped without an automatic
   * check-in so it would never make that decision on someone's behalf. The
   * reasoning still holds — what changed is that the user can now make that
   * decision once and have it honoured.
   *
   * Only the CN region has a check-in, so the card hides the switch elsewhere
   * and the runner refuses to start there.
   */
  autoCheckin?: boolean
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
  /**
   * The optional CLI route: let the locally signed-in CodeBuddy CLI do the work
   * in a separate agent instead of proxying the gateway.
   *
   * It is OFF by default and completely independent of the provider stacks, so a
   * config that never mentions it behaves exactly as before. This is a
   * client-fingerprint workaround, not an account one — see `cli-bridge/runner`.
   */
  cliBridge?: CliBridgeSettings
  /**
   * Put the WorkBuddy panel in the DSH sidebar (opt-IN, PR #188).
   *
   * OFF by default, like every other optional surface this plugin adds: the
   * panel claims a GLOBAL seat (`sidebar.panellist` row + `main` page) that
   * every bundle shares, so switching it on is a decision about the user's
   * whole sidebar rather than a preference about this card. An absent value
   * therefore reads as off, and an upgrade must never re-arrange a sidebar
   * nobody asked to change.
   *
   * The settings card is unaffected either way: this only adds a second door to
   * the same content, and the Plugins page keeps the first one.
   */
  sidebarPanel?: boolean
  /**
   * When scanned messages are perturbed with invisible characters.
   *
   * `failure` (default) learns from a successful channel-gate rescue and starts
   * later requests with the learned form; `always` starts every request with
   * the dense form for a gateway whose plain attempt is a guaranteed refusal;
   * `off` keeps only the post-failure rescue ladder.
   */
  channelPerturbation?: 'off' | 'failure' | 'always'
  /**
   * 出站身份档位（`docs/DEVICE-IDENTITY-AUDIT.md` 的 P1）。
   *
   * `balanced`（默认）让每一条出站请求说同一种话：`X-Product` / `X-IDE-Name` /
   * `X-IDE-Type` 同值 `WorkBuddy`，加 `X-Agent-Purpose`、`X-CodeBuddy-Request`、
   * `Accept-Language`、`X-Root-Request-ID`，以及按账号派生的一对
   * `X-Machine-ID` / `X-Session-ID`；billing 域补齐 UA / Origin / Referer。
   *
   * `conservative` 逐字节还原 5.16.0：**连 `X-Product: SaaS` 这个改名前的值也还原**，
   * 因为"回退了但没完全回退"会造出第三个从未上线过的形状，排查时最误导人。
   *
   * 为什么默认已经是 `balanced`：P0.5 的对照实验（2026-10-31）证实这组头有效。
   * 留这一档不是为了默认值，是为了让"某台机器上某个账号忽然不行了"能先换档排除，
   * 而不必先回滚一个版本。
   */
  wireProfile?: 'conservative' | 'balanced'
  /**
   * How often the card refreshes its account table, in milliseconds.
   *
   * One of 60000 / 300000 / 600000 / 1800000 / 3600000; absent reads as 5
   * minutes. This is the setting that decides the plugin's upstream request
   * volume (one credits read plus one check-in read per pooled account, per
   * refresh), and the composer account panel follows it.
   */
  pollIntervalMs?: number
  /**
   * SDK 功能的**总开关**（默认开）。
   *
   * 关掉之后：不发现 SDK 目录、不起取 token 的子进程、不后台预热——真实值档因此
   * 永远取不到 token。这是"我根本不想让这个插件碰桌面端的原生模块"的那条退路：
   * 在此之前这项能力是无条件启动的，一个只想用虚拟值档的人也照样每 10 分钟付一次
   * 子进程与一次风控取数。
   *
   * 与「取不到真实设备时退回虚拟值」不是一回事：那个管**取不到时怎么办**（落在设备
   * 设置文件里），这个管**要不要去取**。两者都关时真实值档零设备头；总开关关而回退
   * 开时，退到虚拟值。
   *
   * 关掉不影响虚拟值档：派生值全靠本机盐，与 SDK 无关。
   */
  deviceSdkEnabled?: boolean
  /**
   * 外部设备 token（`docs/DEVICE-IDENTITY-AUDIT.md` 的 P2）。
   *
   * 只收**文件**，不收内联字符串：token 是分钟级过期的，写在配置里的值十分钟后
   * 就是死值，只能靠人改配置——那条路只在一次性排障里成立。文件可以由 A 自己的
   * `.turing_token_cache.json`、一个 cron 或任何脚本刷新，插件按 `ttlMs` 重读。
   *
   * 文件支持两种形状：裸 token，或 A 的 `{"token":"v3:…","ts":…}` 信封。上限
   * 4 KB（A 实测 1210 字符，B 的 1 KB 上限会把它误杀成"没配"）。
   *
   * 读不到时**不发送该头**并记一条 warn，绝不回退成临时造一个 token。只在
   * `wireProfile: 'balanced'` 下生效——`conservative` 的契约是逐字节等于 5.16.0。
   */
  deviceToken?: {
    /**
     * token 文件的绝对路径（支持 `~`）。空 = 不启用。
     *
     * 指向 A 的缓存文件即可直接复用它的设备身份，不需要额外脚本。
     */
    file?: string
    /** 重读周期，默认 5 分钟。token 本身约 10 分钟过期。 */
    ttlMs?: number
  }
  /**
   * Adopt the official client's usage-page identity on chat requests (issue #132).
   *
   * 2026-10-31（P1）：`X-IDE-*` 从这里搬到了 {@link Config.wireProfile} 的
   * `balanced` 档（它属于"客户端是谁"，而那一层现在整体统一）。这条开关**现在
   * 只管 id 的格式**：把会话身份三连换成官方客户端用的 32 位十六进制 UUIDv7，并
   * 补一个镜像消息 id 的 `X-Request-ID`。Off by default：它是 reporter 测的、
   * 本插件未复现的显示对齐，不该成为某个账号开始失败的理由。
   */
  usageIdentity?: boolean
  /**
   * Move the harness's injected context above the real prompt (issue #132).
   *
   * The WorkBuddy usage page records the last `user` message as the request
   * text, and DSH appends its runtime context after the user's prompt — so the
   * usage column shows the injected block instead of what the user typed. The
   * reorder is order-only and matches only the harness's own injected prefixes.
   *
   * Off by default: it changes the message order the upstream counts, so it is
   * an explicit opt-in rather than a silent change on upgrade.
   */
  keepPromptLast?: boolean
  /**
   * Extra literal prefixes (issue #133) treated like the harness's injected
   * context markers when `keepPromptLast` is on, for injected blocks a
   * companion plugin produces that the built-in list does not recognize. Each
   * entry is matched literally at the start of a trailing `user` message.
   */
  extraInjectedPrefixes?: string[]
  /**
   * Drop foreign thinking blocks pi-ai would publish as prose (issue #147).
   *
   * When a session moves between providers, `dsh-llm-pi-ai` rebuilds the other
   * provider's assistant turns with `api: 'dsh-foreign'`, and pi-ai's
   * `isSameModel` then fails — so up to pi-ai 1.2 it did not DROP their
   * `thinking` blocks, it rewrote each one to plain `text`. The other model's
   * working notes therefore arrived as this turn's answer, and the model copied
   * that shape on every later turn. (pi-ai 1.3 discards such a block instead,
   * which is the same outcome this switch produces — see the note on
   * `dropForeignThinking` in `adapter.ts` for why the repair still runs
   * unconditionally.)
   *
   * On, those blocks are removed from the request instead: they carry no
   * `thinkingSignature` (the host builds them without one), so they could never
   * be replayed as reasoning anyway — their only possible contribution to the
   * wire was the prose they turned into. Text blocks and tool calls are
   * untouched, and so is every message's identity.
   *
   * OFF by default: it changes bytes the upstream counts, so it is an explicit
   * opt-in on the same rule as {@link Config.usageIdentity}.
   */
  dropForeignThinking?: boolean
  /**
   * Strip every historical thinking block from the request (issue #213).
   *
   * A reasoning REDACTION rather than a repair: the channel gate scans the text
   * we send, and past reasoning rides along as `reasoning_content` whenever a
   * block carries a signature. Costs the model its own earlier reasoning, so it
   * is off unless the user says otherwise.
   */
  dropAllThinking?: boolean
  /**
   * Move the host's session-title request onto the hidden lightweight model
   * (issues #132/#133). Off by default: it is a real upstream request either
   * way, and the rewrite changes which bucket it is billed against.
   */
  sessionTitle?: {
    /**
     * Whether title requests are re-pointed at {@link sessionTitle.model}.
     * The host still fires the request exactly once per new session; the
     * reporter measured the lightweight model at 0 credits for these calls
     * (request volume still counts, and the evidence is reporter-level, not
     * reproduced by this plugin).
     */
    enabled?: boolean
    /**
     * Target model for the rewritten title request. Defaults to `wb-lite`,
     * the hidden model the reporter measured; configurable in case the id
     * changes or a region exposes a different one.
     */
    model?: string
  }
  /**
   * 被网关渠道校验拦截（`channel_reject` / 11128）之后自动再发一次「继续」，
   * 可选、有上限。默认关闭。
   *
   * 这条失败**不换号也不重试**（`isFailoverWorthy` 刻意把它排除在外：网关匹配的
   * 是消息开头，换账号只会每个账号白烧一次请求），所以这一轮就此结束，用户看到的
   * 是「本轮运行失败400: … 被网关的渠道校验拦截 …」。固定指纹由 `prepareChatBody`
   * 的按句改词处理；这条开关只是**最后兜底**：只有被拒内容刚好随轮次变化的窄情况
   * 才可能靠新回合碰过去。固定 system 指纹每轮相同，重发也救不了（#163 实测）。
   *
   * 默认关闭的理由与 {@link Config.usageIdentity} 相同：它会在用户没有发消息的
   * 情况下花掉真实请求，属于必须显式授权的开销。上限默认 1 次：1 次救不了，3 次也
   * 救不了，旧默认 3 只会把同一个 400 付三遍。
   */
  channelRejectContinue?: {
    /**
     * 是否启用自动续发。只有显式 `true` 才算开启。
     */
    enabled?: boolean
    /**
     * 连续自动续发的次数上限（默认 1，夹在 1..10）。
     *
     * 「连续」是关键：一次成功回合、或者用户自己发了一条消息，计数立刻清零。
     * 所以上限拦的是「一直过不去就一直试」，而不是这个会话一生的总次数。
     */
    maxConsecutive?: number
    /**
     * 续发时发送的文本，默认「继续」。
     */
    text?: string
  }
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
  /**
   * Whether the plugin claims the daily check-in by itself (opt-IN, default off).
   *
   * OFF BY DEFAULT, and that is the whole design (issue #191). Claiming a daily
   * reward is a real WRITE on the user's account, and this plugin shipped with no
   * automatic check-in precisely so it would never make that decision for
   * someone. The reasoning still holds — what changed is that the user can now
   * make the decision once and have it honoured.
   *
   * The alternative was worse than it looks: a missed day resets the streak to
   * zero (the reporter was at 32), and the claim costs no credits and is
   * idempotent upstream. So the trade is "one switch" against "a 32-day streak
   * lost to a weekend".
   *
   * Only the CN region has a check-in; the switch is hidden elsewhere and the
   * runner refuses to start there, so a hand-edited profile cannot make the
   * background path spend a request per account per day learning a refusal.
   */
  autoCheckin: z.boolean().default(false).description('Claim the daily check-in automatically for the accounts checked into this pool (opt-in). Idempotent: an account already checked in today is reported, never re-claimed. Only the CN region has a daily check-in.'),
  orderAccountIds: z.array(z.string()).default([]).description('The user\'s hand-ordered pool order, as account ids. Independent of membership: an id need not be checked in (it only takes effect once the account is a member), and ids not listed sort last. Separate from memberAccountIds so reordering never conflicts with, or is destroyed by, a membership edit.'),
})

const regionStateConfig = z.object({
  enabled: z.boolean().default(true).description('Whether this region\'s provider is offered to DSH (opt-out; false withdraws it entirely)'),
  /**
   * Whether this region's credit line shows at the DSH sidebar foot.
   *
   * Per-REGION rather than one global switch, because the two sides are
   * independent providers the user may hold only one account on: a CN-only user
   * has nothing to read from the international line and vice versa, and a
   * single shared switch would force them to either show a permanently empty
   * row or lose the one that works.
   *
   * ON by default (opt-out). The configuration page is not reachable in every
   * host — a composition can omit the Settings shell, and even where it exists
   * the user has to know the page is there — so a feature that is off until
   * discovered would be off forever for those users. The line carries its own
   * `×` in the sidebar, which is reachable exactly where the feature renders.
   */
  showCreditsInMainUi: z.boolean().default(true).description('Show this region\'s remaining credits at the DSH sidebar foot (opt-out; the line carries its own hide button)'),
  /**
   * Whether the composer pill carries its "· N 新模型" segment (opt-IN, default
   * off).
   *
   * WHY OFF BY DEFAULT. "New" here means *first seen by this machine*, not *new
   * upstream* — the plugin cannot observe when the upstream listed a model, only
   * when its own roster history first recorded the id. On a fresh install every
   * id is first-seen, so the very first refresh announces the entire roster as
   * new: a number that is true by construction, says nothing about the upstream,
   * and reads as a defect.
   *
   * It is a genuinely useful signal ONCE history exists, and it WAS already on,
   * so the people who want it would lose it to a silent change. Hence opt-in
   * rather than removal: the segment is worth having, it is just not worth
   * showing to someone who never asked for it. The same switch governs the "新"
   * mark on individual picker rows — both read one snapshot (see
   * `WorkBuddyModelLabel`), so the two surfaces cannot disagree.
   */
  showNewModelsInMainUi: z.boolean().default(false).description(
    'Show the "· N 新模型" segment (and the per-row "新" mark) in the composer. '
    + '"New" means first seen BY THIS MACHINE, not newly listed upstream — on a fresh '
    + 'install that is the whole roster. Off by default.',
  ),
  creditPosition: z.union([z.const('composer'), z.const('stats')]).default('composer').description('Where the credit readout sits: "composer" = the composer tool row (default), "stats" = the ambient row below the composer card, next to the shell\'s own token pills. Choose "stats" if another plugin occupies the composer row.'),
  lastCatalog: z.array(modelConfig).default([]),
  enabledModelIds: z.array(z.string()).default([]),
  imageModelIds: z.array(z.string()).default([]),
  /**
   * Which text-to-image model this region uses, as picked in the card (issue #241).
   *
   * An EMPTY string means "no choice": the tool takes the group's first model,
   * which is whatever the upstream catalog lists first (`hunyuan-image-alpha` in
   * the CN region as of 2026-11-12). Set it to `hunyuan-image-v3.0` for output
   * with no watermark.
   *
   * Why a free string and not an enum: the watermark-free model is NOT in the
   * `/v3/config` catalog — it is the official CLI's own hard-coded fallback — so
   * an enum would have to hard-code a vendor id list that can change without
   * this plugin being released. The tool validates it against the choices it can
   * actually offer (`imageModelChoices`) and falls back silently when the id is
   * stale, exactly like `preferredVideoModels`.
   */
  preferredImageModel: z.string().default('').description(
    'Text-to-image model for this region, picked in the card. Empty = the catalog\'s first model. '
    + 'Set "hunyuan-image-v3.0" for watermark-free output (CN region only; ~11.1 credits/image '
    + 'instead of ~6, and a smaller size limit).',
  ),
  /**
   * Alternative CN gateway host (issue #220); see the interface field of the
   * same name. Empty = the built-in gateway.
   *
   * A plain string rather than a `union` of the allowed hosts on purpose: the
   * allowlist lives in `src/cn-gateway.ts` and is enforced there with an
   * explicit reason the card can word ("not a known CN host" vs "not https").
   * Encoding it in the schema too would produce a validation error the settings
   * layer reports as a generic schema failure, and the user would be told their
   * value is invalid without being told which rule it broke.
   */
  cnBase: z.string().default('').description(
    'Alternative CN gateway host for networks that filter copilot.tencent.com by TLS SNI (issue #220). '
    + 'Must be an https URL on one of the CN brands: copilot.tencent.com, wb.tencentbuddy.com, '
    + 'www.workbuddy.cn, www.codebuddy.cn (any subdomain of those registrable domains). '
    + 'Empty keeps the built-in gateway. Chat, billing, catalog and check-in all follow it; '
    + 'Origin/Referer keep naming the CN web app. CONNECTION-LAYER failures only — set it after '
    + 'a filter, not to change your account or region.',
  ),
  /**
   * Whether the model may call the image-generation tool (opt-IN, default off).
   *
   * Per-REGION like the credit switches, and it now means the same thing on both
   * tabs: each region's catalog carries its own `text-to-image` model (CN
   * `hunyuan-image-alpha`, international `hy-image-3.5`; measured 2026-10-25,
   * see `docs/IMAGE_GEN.md`). Whichever region is switched on AND opted in owns
   * the tool; CN wins when both qualify (see `imageToolRegionOf`).
   *
   * Every other spending path in this plugin requires a human action: a chat
   * request is one the user sent, and the per-model "test" button is one the
   * user clicked. `workbuddy_draw_image` is the first capability where the
   * MODEL decides to spend — it calls the tool on its own, at about 5.71 credits
   * an image on CN and 0.03 on the international gateway (measured, not a price
   * list: the media catalog carries no cost, so the tool reports the
   * `usage.credit` the upstream actually settles), and there is no per-call
   * approval seam in the host to ask the user first (`needsApproval` /
   * `toolApproval` do not exist; verified against the shipped `app.asar`).
   *
   * So it is opt-in, the same way the account pool's credit-based rotation is
   * opt-in (3.0.0's reasoning): a feature that can move money on its own must be
   * one the user switched on, not one that arrives with an upgrade. Off also
   * means that region contributes nothing, and with no opted-in region at all
   * the tool is not REGISTERED, so the model never sees it and cannot attempt a
   * call that would be refused.
   */
  imageToolEnabled: z.boolean().default(false).description('Let the model call workbuddy_draw_image on its own (opt-in; an image costs ~5.71 credits on the CN gateway and ~0.03 on the international one, and there is no per-call approval). Off by default, and off means no region registers the tool at all.'),
  /**
   * Whether the model may call the video-generation tool (opt-IN, default off).
   * Per-REGION like `imageToolEnabled`, gated the same way: the region must be
   * switched on AND the user must opt in. CN wins when both qualify. A video
   * costs real credits per generation and the task runs tens of seconds to
   * minutes, so no per-call approval exists in the host — hence opt-in.
   */
  videoToolEnabled: z.boolean().default(false).description('Let the model call workbuddy_draw_video on its own (opt-in; a video is an async task that costs WorkBuddy credits and runs tens of seconds to minutes). Off by default, and off means no region registers the tool at all.'),
  /**
   * The video model pinned for one tag (`text-to-video` / `image-to-video`),
   * as a model id from THIS region's catalog.
   *
   * Written by the card's per-mode picker. The tool reads it only when the call
   * itself did not name a model, and falls back to the group's first model when
   * the pinned id is no longer in this region's directory — see
   * `preferredVideoModel` in `src/video-tool.ts`.
   */
  preferredVideoModels: z.dict(z.string()).default({}).description('Video model pinned per tag ("text-to-video"/"image-to-video"), as a model id from this region catalog. Used only when a tool call names no model.'),
  /**
   * Per-model override of whether thinking `off` is offered, keyed by model id
   * (issue #34). An ABSENT key means "use the built-in rule" — the upstream's
   * `canDisableThinking` declaration minus the ids known to refuse `off` (see
   * `src/off-thinking.ts`).
   *
   * Seeded from {@link defaultOffModelIds} on first read so the checkbox is
   * ticked correctly without the user having to save.
   */
  offModelIds: z.array(z.string()).default([]).description('Model ids whose "off" thinking level is offered; seeded from the built-in rule when first read.'),
  /**
   * Whether a human has edited the image boxes (issue #168). `false` lets the
   * vendor-verified table fill ids the saved array does not mention; `true`
   * makes `imageModelIds` the whole answer, so an explicit untick sticks.
   */
  imageSelectionExplicit: z.boolean().default(false),
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}),
  /**
   * The thinking tier each model runs on when a caller names none (issue #179).
   *
   * Keyed by model id because the tier VOCABULARY is per model, not per route:
   * the live CN roster carries `low/high/max` (deepseek, glm-5.3), `high/xhigh`
   * (glm-5.2, deepseek-v4-pro), `low/medium/high` (step-5-preview) and five
   * tiers on `space-bunny` / `minimax-m3.1-flash`. A single route-wide default —
   * the `WORKBUDDY_DEFAULT_EFFORT` constant this replaces — therefore cannot be
   * right for more than a subset of the roster, and naming a tier a model does
   * not have is a hard `UNSUPPORTED_REASONING_EFFORT` (issue #90).
   *
   * An ABSENT key means "follow this model's own upstream `defaultEffort`",
   * which the great majority of the live catalog declares (measured 2026-10-30:
   * `high` on thirteen of fifteen, `max` on the two five-tier ones) — and where
   * the upstream declares none, "follow this model's own MIDDLE tier", never its
   * weakest one (qoder 518ecbb's rule; see `src/default-effort.ts`). That is NOT
   * the same as "no opinion": the adapter must still pin SOMETHING for the request
   * paths that name no tier, and issue #83 is the record of what happens when
   * that is left to pi-ai's level map — it filled in `off`, the upstream answers
   * 400 / 11133, and `/compact` failed.
   *
   * `off` is deliberately absent from this field's vocabulary: whether a model
   * offers `off` is `offModelIds`' decision (issue #34), and letting both own it
   * would give one question two answers that can disagree.
   */
  defaultThinkingEfforts: z.dict(z.string()).default({}),
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

const cliBridgeConfig = z.object({
  enabled: z.boolean().default(false).description(
    'Mount the optional CodeBuddy CLI route (tool codebuddy_ask + /codebuddy). Off by default; '
    + 'the provider stacks are unaffected either way.',
  ),
  binary: z.string().default('').description(
    'Absolute path to the CodeBuddy CLI JS entry (the package\'s bin/codebuddy, not its .cmd shim). '
    + 'Empty means auto-detect in the usual global npm/pnpm/yarn/volta/nvm/fnm locations. '
    + 'There is deliberately no fallback to whatever "codebuddy" is on PATH.',
  ),
  model: z.string().default('').description(
    'Model id passed as --model. Empty means the CLI\'s own configured default.',
  ),
  permissionMode: z.string().default('dontAsk').description(
    'Permission mode passed as --permission-mode: dontAsk (default: read tools allowed, writes refused, never blocks), '
    + 'plan / default / auto, acceptEdits (may edit files), or bypassPermissions (allows everything).',
  ),
  effort: z.string().default('').description(
    'Reasoning effort passed as --effort: minimal, low, medium, high, xhigh or max. Empty means unset.',
  ),
  maxTurns: z.number().step(1).min(1).default(10).description(
    'Agent turn budget for one bridged call. Clamped to 100.',
  ),
  timeoutSecs: z.number().step(1).min(1).default(900).description(
    'Wall-clock budget for one bridged call, in seconds. Clamped to 1800.',
  ),
  regionOrder: z.string().default('cn,global').description(
    'Credential region preference for the CLI, comma separated. Domestic tokens are accepted by '
    + 'copilot.tencent.com; global tokens are refused there with 401.',
  ),
  workingDir: z.string().default('').description(
    'Default working directory for a bridged call when the caller names none. Must exist and be a directory. '
    + 'Empty means a call has to name one (or come from a session that has one).',
  ),
  allowedDirs: z.string().default('').description(
    'Extra roots a bridged call may be pointed at, comma separated absolute paths. A call can always run '
    + 'inside its own session workspace; anything else has to be listed here. Empty means only the session workspace.',
  ),
  appendSystemPrompt: z.string().default('').description(
    'Extra system prompt appended to every bridged call. Passed as --append-system-prompt, never through a shell.',
  ),
  allowUnattended: z.boolean().default(false).description(
    'Allow a bridged call with no directory at all to run in a throwaway temp directory. '
    + 'Off by default: an agent that can edit files should not be aimed at a directory nobody chose.',
  ),
  maxReplyChars: z.number().step(1).min(1).default(60_000).description(
    'Reply length cap handed back to the model, in characters. Clamped to 400000.',
  ),
  injectResult: z.boolean().default(true).description(
    'Hand a successful /codebuddy result to the session model so the conversation knows about it. '
    + 'That wake-up costs a real DSH turn; set false to keep results purely local.',
  ),
  sessionContinuity: z.string().default('auto').description(
    'Whether a second /codebuddy (or codebuddy_ask) in the same session continues the previous CodeBuddy '
    + 'conversation: auto (default) resumes it via --session-id, off starts a fresh one every time. '
    + 'An explicit session_id argument always wins over this setting.',
  ),
  maxTurnsPerSessionHour: z.number().step(1).min(0).default(6).description(
    'Bridged calls allowed per hour in one session. 0 disables the limit.',
  ),
  maxTurnsPerHour: z.number().step(1).min(0).default(20).description(
    'Bridged calls allowed per hour across the whole process. 0 disables the limit.',
  ),
})

export const Config: z<Config> = z.object({
  authFile: asVolatile(z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)')),
  accountId: z.string().description('Deprecated: pre-split account selector, attributed to its own region'),
  accounts: asVolatile(accountSelectionConfig.default({} as any).description('Per-region account selections, keyed cn | global')) as z<Partial<Record<WorkBuddyRegion, string>>>,
  regions: asVolatile(z.dict(regionStateConfig).default({}).description('Per-region model directory and selection, keyed cn | global')),
  lastCatalog: z.array(modelConfig).description('Deprecated: pre-region-split CN model directory') as z<WorkBuddyModelInfo[]>,
  enabledModelIds: z.array(z.string()).default([]).description('Deprecated: pre-region-split CN selection'),
  imageModelIds: z.array(z.string()).default([]).description('Deprecated: pre-region-split CN image opt-in'),
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}).description('Deprecated: pre-region-split CN context budgets'),
  // Volatile: a user turning the route on or retuning its budget should not need
  // a full plugin reload (which disposes both provider stacks and drops every
  // in-flight request). The mount listens for `loader/volatile-update` and
  // rebuilds only when the serialized settings actually changed.
  cliBridge: asVolatile(
    cliBridgeConfig.default({} as any).description('Optional CodeBuddy CLI route; off by default and independent of the providers'),
  ) as unknown as z<CliBridgeSettings>,
  // Volatile for the same reason as the block above: the browser card's switch
  // writes it, and a full plugin reload (which disposes both provider stacks and
  // drops in-flight requests) would be a wildly disproportionate price for
  // adding one nav row.
  sidebarPanel: asVolatile(
    z.boolean()
      .default(false)
      .description('Add a WorkBuddy panel to the DSH sidebar: a nav row that opens the credits / accounts / model catalog as a full page. Off by default — the row claims a global sidebar seat shared by every bundle, and the Plugins page already reaches the same content.'),
  ) as unknown as z<boolean>,
  channelPerturbation: asVolatile(
    z.union([z.const('off'), z.const('failure'), z.const('always')])
      .default('failure')
      .description('When to perturb scanned messages with invisible characters: "off" only rescues after a channel-gate refusal, "failure" (default) learns from a successful rescue and starts later requests perturbed, "always" starts every request with the dense rescue for a gateway whose plain attempt is guaranteed to fail.'),
  ) as unknown as z<'off' | 'failure' | 'always'>,
  usageIdentity: asVolatile(
    z.boolean()
      .default(false)
      .description("Send the chat conversation ids in the official client's 32-hex UUIDv7 shape and add a mirroring X-Request-ID. Off by default — it is a display alignment measured by a reporter, not by this plugin, and the chat channel identity (User-Agent) and request body never change."),
  ) as unknown as z<boolean>,
  wireProfile: asVolatile(
    z.union([z.const('conservative'), z.const('balanced')])
      .default('balanced')
      .description('Outbound identity profile. "balanced" (default) makes every request claim the same client (WorkBuddy product/IDE/agent headers, X-CodeBuddy-Request, Accept-Language, X-Root-Request-ID, and a per-account X-Machine-ID/X-Session-ID pair) and gives the billing routes a User-Agent plus Origin/Referer. "conservative" restores the 5.16.0 bytes exactly, including X-Product: SaaS.'),
  ) as unknown as z<'conservative' | 'balanced'>,
  /**
   * How often the card re-reads the usage document.
   *
   * GLOBAL, not per-region: the card polls ONE region at a time (whichever tab
   * is open), so a per-region value would be a setting the user edits per tab
   * while only one of them is ever in effect. The composer account panel reads
   * the same number, which is what keeps the two surfaces from disagreeing
   * about one account — the complaint that fixed the panel at 60s in the first
   * place.
   *
   * A CLOSED SET of five values rather than a free number: this interval decides
   * the plugin's upstream request volume, and a typo'd `0` or a hand-written
   * `1000` would turn a display refresh into a poll the upstream could rate
   * limit. The same five are what the dropdown offers, so the control and its
   * validation cannot drift apart.
   *
   * WHY THE DEFAULT MOVED OFF 60s: one refresh reads a credits document AND a
   * check-in status per pooled account, so a 4-account pool at 60s is ~11,520
   * requests a day for figures that move slowly. 5 minutes is a fifth of that
   * and still far finer than the 30-minute auto check-in heartbeat.
   */
  pollIntervalMs: asVolatile(
    z.union([
      z.const(60_000),
      z.const(5 * 60_000),
      z.const(10 * 60_000),
      z.const(30 * 60_000),
      z.const(60 * 60_000),
    ])
      .default(5 * 60_000)
      .description('How often the card refreshes its account table: 60000 (1 min), 300000 (5 min, default), 600000 (10 min), 1800000 (30 min) or 3600000 (60 min), in milliseconds. One refresh costs a credits read plus a check-in read per pooled account, so this is the setting that decides the plugin\'s upstream request volume. The composer account panel follows this value so the two surfaces cannot disagree about one account.'),
  ) as unknown as z<number>,
  deviceSdkEnabled: asVolatile(
    z.boolean()
      .default(false)
      .description('Master switch for the real-device SDK. OFF by default, matching the default Virtual tier: turning it on makes the plugin discover the installed desktop SDK, fetch its device token in a background child process and keep it fresh. A capability that reaches into a third party\'s native modules on your machine should be opted into, and with the Virtual tier (the default) the token it fetches would never be sent anyway. On: discover, fetch, prewarm. Off: none of that — no discovery, no child process, no prewarming — so the Real tier has no token to send; the Virtual tier is unaffected (its ids derive from the local salt).'),
  ) as unknown as z<boolean>,
  deviceToken: asVolatile(
    z.object({
      file: z.string().default(''),
      ttlMs: z.number().step(1).min(1000).default(300_000),
    }).default({})
      .description('Optional X-Device-Token supplied by a file, re-read every ttlMs (default 5 min; the token itself expires in about 10). Accepts a bare token or an {"token":…} JSON envelope, so pointing it at workbuddy2openapi\'s .turing_token_cache.json works as-is. Empty file = off. Only used by wireProfile "balanced"; a token that cannot be read is skipped with a warning, never invented.'),
  ) as unknown as z<{ file: string, ttlMs: number }>,
  keepPromptLast: asVolatile(
    z.boolean()
      .default(false)
      .description("Move the harness-injected runtime context above the real prompt, so the " +
        "WorkBuddy usage page records what you actually typed instead of the injected block. " +
        "Message count and text are preserved; the one edit is the recorded prompt's own leading " +
        "<acp> marker. Off by default because it changes the message order the upstream counts."),
  ) as unknown as z<boolean>,
  extraInjectedPrefixes: asVolatile(
    z.array(z.string())
      .default([])
      .description('Extra literal prefixes (issue #133) treated like the harness-injected context markers when keepPromptLast is on — for blocks a companion plugin injects that the built-in list does not recognize. Each entry matches the start of a trailing user message; read only while keepPromptLast is enabled. Sampled when the plugin mounts: reload the plugin (or restart the host) after changing it.'),
  ) as unknown as z<string[]>,
  dropForeignThinking: asVolatile(
    z.boolean()
      .default(false)
      .description('Drop foreign thinking blocks that pi-ai would publish as prose (issue #147). ' +
        'CROSS-PROVIDER turns are dropped automatically: after a provider switch the other provider\'s ' +
        'unsigned thinking blocks can never be replayed, and pi-ai would flatten them into assistant prose ' +
        'that the gateway refuses with 11128 (issue #163\'s measured scene). This switch only widens the ' +
        'repair to a model switch inside one of this bundle\'s own routes. On, those blocks are removed ' +
        'from the request; text and tool calls are untouched. Off by default for the same-route leg ' +
        'because it changes bytes the upstream counts.'),
  ) as unknown as z<boolean>,
  dropAllThinking: asVolatile(
    z.boolean()
      .default(false)
      .description('Strip EVERY historical thinking block before the request goes out (issue #213). ' +
        'The channel gate scans the request text, and a 11128 report matched every banned opening against ' +
        'this session\'s own reasoning blocks: WorkBuddy answers reasoning in `reasoning_content`, pi-ai ' +
        'records that field name as the block signature and replays it under the same name, so past ' +
        'reasoning rides along in the request and is one of the things carrying the text the gate refuses. ' +
        'On, all thinking blocks are removed from the request; your messages, tool calls and ' +
        'the model\'s answers are untouched, but the model no longer sees its own earlier reasoning. ' +
        'OFF by default: that loss is real, so it is a deliberate answer to a 11128 you can match to ' +
        'reasoning text, not a default. Takes effect on the next turn, no reload.'),
  ) as unknown as z<boolean>,
  sessionTitle: asVolatile(
    z.object({
      enabled: z.boolean().default(false),
      model: z.string().default('wb-lite'),
    }).default({})
      .description('Move the host session-title request onto a hidden lightweight model (issues #132/#133). The host fires one real upstream request per new session either way; enabled re-points it at `model` (default wb-lite, measured 0 credits by the reporter) instead of billing the main paid model. Request volume still counts, and the lightweight model is reporter-measured, not reproduced here. Sampled when the plugin mounts: reload the plugin (or restart the host) after changing it.'),
  ) as unknown as z<{ enabled: boolean, model: string }>,
  channelRejectContinue: asVolatile(
    z.object({
      enabled: z.boolean().default(false),
      maxConsecutive: z.number().step(1).min(1).max(10).default(1),
      text: z.string().default('继续'),
    }).default({})
      .description('LAST RESORT, not a fix for 11128. After the gateway refuses a turn with `channel_reject` (business code 11128), send 「继续」 once automatically. Off by default: it spends a real request without the user typing anything. Fixed system fingerprints are handled by prepareChatBody\'s sentence rewrites; they are byte-identical every turn, so resending only pays for the same 400 again. The narrow case this can help is content that changes between turns. `maxConsecutive` (default 1) counts CONSECUTIVE auto-sends: one successful turn, or one real user message, resets it. Subagent sessions are never touched. Live: the engine reads this on every failure, so no reload is needed.'),
  ) as unknown as z<{ enabled: boolean, maxConsecutive: number, text: string }>,
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
  // THROUGH `regionsMapOf`, not a bare lookup. The field is written by older
  // builds in a shape that buries the real region map one level down (the
  // "restart reset" report: the pool and the model selection looked unsaved
  // after every restart), and this one-level read is what turned that wreckage
  // into "the pool was never configured" — the Host's answer decides the pool
  // switch, the member list, the model selection and the directory.
  // `regionsMapOf` narrows the field, drops the sibling-field copies and
  // recovers a region that only survives deeper, so an already-corrupted
  // profile reads correctly BEFORE the repair write has cleaned it.
  const regions = regionsMapOf(config.regions)
  const stored = regions[region]
  // `null` counts as "no slot", exactly like `undefined`. schemastery's
  // `simplify()` serialises an EMPTY region slot as `null` (`{cn:{}}` →
  // `{cn:null}`), and a `null` reaching the return value makes every caller
  // throw on the first property read (`regionEnabled` dies on `.enabled`). It is
  // not reachable today — resolving a stored `null` slot expands it back into a
  // full default state — so this is defence, not a fix for an observed crash.
  if (stored !== undefined && stored !== null) return stored
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
  /** This region's first-sighting history, feeding the "· N 新模型" segment. */
  rosterSeen: RosterSeenStore
}

/** Every region, in card tab order. */
const REGION_KEYS: readonly WorkBuddyRegion[] = ['cn', 'global']

/**
 * 「真实值」档在这台机器上能不能真的工作，以及为什么不能。
 *
 * ## 为什么不让界面自己判断平台
 *
 * 客户端能拿到 `sdk.platform`，但**平台不是判据**。macOS 上 SDK 能被发现、
 * `probe` 也答 `ready`，真正坏掉的是取 token 那一环：SDK 向 dispatch 主队列
 * `dispatch_sync`，而纯 libuv 子进程永不排空那个队列（`sample` 栈实测，见
 * CHANGELOG 的「macOS 现状如实记录」）。于是「darwin → 禁用」会把一台**没装**
 * 桌面端的 mac 和一台装了的 mac 说成同一件事，而它们的用户该做的事完全不同。
 *
 * ## 为什么现在还写死
 *
 * 这是一个**已知的、非本平台的**缺陷，不是运行时可以测出来的：真去测就要起子进程
 * 等 15 秒超时，而这一页每次打开都会拉一次设置。写成常量意味着它是可以被人替换
 * 的显式声明，而不是散在三个组件里的 `if (platform === 'darwin')`。
 *
 * ⚠️ 修好 `dispatch_sync` 那条路之后，**这里必须跟着改**，否则界面会继续劝退一个
 * 已经能用的功能。修法不在本次范围（需要一个排空主队列的伴生原生模块）。
 *
 * `state`：
 *   - `available` —— 能取到 token，切成「真实值」就能用；
 *   - `broken` —— 这套 SDK 在本平台取不到 token，切过去只会降级，界面上应禁用
 *     并说明原因；
 *   - `unavailable` —— 本平台没有这条取链（不预期出现，留作兜底）。
 */
export function realTierAvailabilityFor(platform: string): {
  state: 'available' | 'broken' | 'unavailable'
  platform: string
} {
  return platform === 'darwin'
    ? { state: 'broken', platform: 'darwin' }
    : { state: 'available', platform }
}

const REAL_TIER_AVAILABILITY = realTierAvailabilityFor(process.platform)

/**
 * The region that owns the image tool right now, or `undefined` when no region
 * has it switched on.
 *
 * BOTH gates are required, and both are read live: the region's provider switch
 * must be ON (`regionEnabled`, opt-OUT) and the user must have opted IN to the
 * model spending credits there (`imageToolEnabled`, opt-IN). Absence of
 * `imageToolEnabled` is never consent.
 *
 * CN wins when both regions qualify, and that order is the only backward
 * compatible one: before the international gateway carried a `text-to-image`
 * model (measured 2026-10-25: `hy-image-3.5`) CN was the only region that could
 * ever be opted in, so a profile that opted in there keeps using CN even after
 * the global tab is switched on as well. That is exactly `REGION_KEYS`' order;
 * it is not incidental.
 */
export function imageToolRegionOf(config: Config): WorkBuddyRegion | undefined {
  for (const region of REGION_KEYS) {
    if (!regionEnabled(config, region)) continue
    if (regionStateOf(config, region).imageToolEnabled === true) return region
  }
  return undefined
}

/**
 * Region that owns the video tool right now, or `undefined` when no region has
 * it switched on. Mirrors `imageToolRegionOf` but reads `videoToolEnabled`
 * (the video-generation opt-in). Both gates required, read live: region provider
 * switch ON (`regionEnabled`, opt-OUT) and the user opted IN (`videoToolEnabled`,
 * opt-IN). CN wins when both qualify (see `REGION_KEYS`).
 */
export function videoToolRegionOf(config: Config): WorkBuddyRegion | undefined {
  for (const region of REGION_KEYS) {
    if (!regionEnabled(config, region)) continue
    if (regionStateOf(config, region).videoToolEnabled === true) return region
  }
  return undefined
}

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
  // The CN catalog prefers `/v3/config` and falls back to the legacy document.
  // A fallback is worth a line in the log: it means the card's roster may no
  // longer match the app's prices, which is a user-visible difference rather
  // than a purely internal degradation.
  /**
   * 每账号的设备覆盖值（设置里齿轮改的那份）。
   *
   * 读盘缓存在 `device-profile.ts` 里是**模块级**的，所以这里、路由、以及客户端
   * 看到的永远是同一份；`saveDeviceProfile` 写完后会立即失效它，改完下一条请求
   * 就生效，不需要重启。
   */
  const deviceProfiles = createDeviceProfileLookup()
  /**
   * 真实设备参数的取链（P3）。
   *
   * **启动即预热**：`startAutoRefresh()` 立刻取一次，此后在 10 分钟 TTL 到期前自动
   * 换新。此前只有请求路径会调 `current()`，于是空闲进程的「SDK」分区永远停在
   * "已加载、没取过"——那与"SDK 坏了"在界面上长得一样，而这正是用户反馈的现象。
   *
   * 代价是一次子进程 + 一次取数，之后每 10 分钟一次；`stopAutoRefresh()` 挂在
   * `ctx.effect` 的清理上，插件卸载时定时器随之消失。
   *
   * `dirSource` 让卡片上填的目录**下一次观察就生效**（作者意见 #1）：句柄活到
   * 卸载，而设置随时会变，所以目录每次 `probe` 现问一次。`deviceProfiles` 读盘有
   * 5 秒缓存，保存会立即失效它。
   *
   * 总开关只留**一份活真值**。曾经这里写 `const flag = unwrapVolatile(...) === true`
   * 把布尔在 apply 期求值一次传给句柄，而 `readEnabled()` 却每次现读活引用——
   * volatile 字段就地修改、插件不重挂，于是「勾选框是开的、probe 永远答 disabled」。
   * 现在两处共用 `deviceSdkEnabled()`。句柄即使关掉也保留，因为端口仍要能回答
   * "这个功能被关掉了"（`disabled`），而不是给一块空白面板。
   *
   * `=== true`：`undefined`（老配置没有这一项）落到"关"，与 `default(false)` 一致。
   */
  const deviceSdkEnabled = (): boolean => unwrapVolatile(config.deviceSdkEnabled) === true
  const turing = createTuringSdk({
    productVersion: APP_VERSION,
    dirSource: () => deviceProfiles.sdkDir(),
    // getter 而非求值后的布尔：句柄活到卸载，设置随时会变。
    get enabled() { return deviceSdkEnabled() },
  })
  /** 让预热链跟随开关：开则补建（内部幂等），关则立即拆除。 */
  const syncDeviceSdk = (): void => {
    if (deviceSdkEnabled()) turing.startAutoRefresh()
    else turing.stopAutoRefresh()
  }
  syncDeviceSdk()
  ctx.effect(() => () => { turing.stopAutoRefresh() })

  /**
   * Announce a CN gateway override, ONCE per distinct value / failure.
   *
   * The reader runs on every CN request, so logging unconditionally would turn
   * one misconfiguration into a warn per request. Keyed on the VALUE rather than
   * a plain boolean, so fixing the setting and breaking it again both get said —
   * a user who is iterating on hosts needs to see each attempt acknowledged.
   */
  let announcedCnBase: string | undefined
  let announcedCnBaseFailure: string | undefined
  const warnCnBaseOnce = (base: string): void => {
    if (announcedCnBase === base) return
    announcedCnBase = base
    // Per-request failure text is deliberately part of it: an ECONNRESET here is
    // the whole point of the setting, and naming the host is what tells the user
    // which of their attempts is in force.
    ctx.logger.warn(`dsh-connect-workbuddy: CN gateway overridden to ${base} (issue #220). Chat, billing, catalog and check-in follow it; Origin/Referer still name the CN web app.`)
  }
  const warnCnBaseInvalidOnce = (reason: CnGatewayRejection, value: string): void => {
    const key = `${reason}:${value}`
    if (announcedCnBaseFailure === key) return
    announcedCnBaseFailure = key
    const why = reason === 'malformed'
      ? 'it is not an absolute URL'
      : reason === 'insecure'
        ? 'only https is accepted (a plaintext base would put the bearer token on the wire in clear)'
        : 'its host is not one of the CN brands (copilot.tencent.com, wb.tencentbuddy.com, workbuddy.cn, codebuddy.cn)'
    ctx.logger.warn(`dsh-connect-workbuddy: ignoring regions.cn.cnBase "${value}" — ${why}. Using the built-in CN gateway.`)
  }

  const client = new WorkBuddyUpstreamClient(
    message => {
      ctx.logger.warn(`dsh-connect-workbuddy: ${message}`)
    },
    {
      usageIdentity: unwrapVolatile(config.usageIdentity) === true,
      // 未配置时由 upstream 的 DEFAULT_WIRE_PROFILE 决定（`balanced`），这里
      // 不重复写一份默认值——两处默认值是它们开始分叉的方式。
      ...unwrapVolatile(config.wireProfile) === undefined
        ? {}
        : { profile: unwrapVolatile(config.wireProfile) },
    },
    (() => {
      // 设备 token 的文件源（P2）。空路径 = 不启用；读取器在客户端内部按 TTL
      // 重读，所以这里只传配置，不在这里读盘。
      //
      // 配置为空时回落到 `WORKBUDDY_DEVICE_TOKEN_FILE`——同一个值、两个读者
      // （插件读配置，`doctor` 只能读环境变量），因此不会出现两处不一致。
      const token = unwrapVolatile(config.deviceToken)
      const configured = typeof token?.file === 'string' ? token.file.trim() : ''
      const file = configured !== '' ? configured : (process.env[WORKBUDDY_DEVICE_TOKEN_FILE_ENV] ?? '').trim()
      return {
        deviceTokenFile: file,
        ...typeof token?.ttlMs === 'number' ? { deviceTokenTtlMs: token.ttlMs } : {},
        // 每账号覆盖值（设置里齿轮保存的那些）。请求路径按 uid 查，读盘有 5 秒
        // 缓存；保存会立刻失效那次缓存，所以改完下一条请求就生效。
        deviceProfiles,
        // 真实值档的 token 源。档位由 `deviceProfiles.mode()` 决定：真实值档只
        // 认这一个源，虚拟值档完全不碰它（见 `wireIdentity`）。
        realDevice: turing.tokens,
        /**
         * CN 网关覆盖（issue #220）：**每次请求现读**，不是一个采样值。
         *
         * `regions` 是 volatile 字段，用户保存后不重启插件；这里若在构造期采样
         * 一次，改设置就只有重启才生效，而「填了没反应」正是本设置唯一的用途。
         *
         * 只对 CN 生效，且只有 `resolveCnGateway` 通过时才返回覆盖值：
         * 校验失败一律退回内置网关并记一条 warn。**退回而不是抛**，因为这条
         * 路径在每一请求上；但绝不静默——用户填了个不被接受的 host 却一直用着
         * 默认网关，会让他继续怀疑是网络，而不是自己填错。
         */
        cnBase: () => {
          const live = current()
          const raw = regionStateOf(live, 'cn').cnBase
          const resolved = resolveCnGateway(raw)
          if (resolved.ok) {
            if (resolved.overridden) warnCnBaseOnce(resolved.base)
            return resolved.overridden ? resolved.base : ''
          }
          warnCnBaseInvalidOnce(resolved.reason, resolved.value)
          return ''
        },
      }
    })(),
  )

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
   *
   * A reading is ALSO bounded by the local day, not just by the TTL — see
   * `checkinReadingFresh`. Both readers go through it, because an entry is an
   * answer to "has this account checked in TODAY" and a `true` read at 23:58
   * must not be served at 00:08.
   */
  const checkinStateCache: Partial<
    Record<WorkBuddyRegion, Record<string, { checkedIn: boolean, atMs: number }>>
  > = {}

  /**
   * Per-region, per-account benefit readings (issue #79).
   *
   * Same shape and same reasoning as `checkinStateCache`: claim state changes
   * when a human acts on the web page or in the desktop app, not spontaneously,
   * so a per-poll read of two endpoints per account would be thousands of
   * requests a day to learn nothing. Coarser than the check-in TTL because a
   * benefit window is measured in days, not hours.
   */
  const benefitStateCache: Partial<
    Record<WorkBuddyRegion, Record<string, {
      views: readonly WorkBuddyBenefitView[]
      atMs: number
    }>>
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
    // This region's OWN first-sighting history, the source of the composer
    // pill's "· N 新模型". Region-scoped like the credential and pool copies:
    // the two catalogs are separate, so a CN first-sighting says nothing about
    // the international roster, and they must never overwrite each other.
    const rosterSeen = createFileRosterSeenStore(region)
    /**
     * Where the next upstream `usage` should be written.
     *
     * The body report is two-phase (send, then charge), and the two phases are
     * wired through different callbacks, so the seam between them has to live
     * somewhere. `noop` rather than `undefined` keeps the usage path free of a
     * presence check on the hot request path — and a request whose report was
     * disabled resolves to the same noop, so nothing needs to know whether
     * reporting is on.
     */
    let pendingUsage: (usage: WorkBuddyUsageCounts | undefined) => void = () => {}
    const shim = createWorkBuddyShim({
      store,
      client,
      catalog,
      logger: ctx.logger,
      channelPerturbation: unwrapVolatile(config.channelPerturbation) ?? 'failure',
      keepPromptLast: unwrapVolatile(config.keepPromptLast) === true,
      extraInjectedPrefixes: unwrapVolatile(config.extraInjectedPrefixes) ?? [],
      sessionTitle: unwrapVolatile(config.sessionTitle) ?? {},
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
      // What went upstream, in counts (issue #59). Off unless
      // `WORKBUDDY_BODY_REPORT` is set; the region is captured here because the
      // shim deliberately does not know about regions.
      //
      // The returned handle carries the upstream's `usage` back onto the SAME
      // line: the sent side is known before the request leaves, the charged side
      // only after the stream ends. One pending handle per region is enough
      // because a shim serves requests for one body at a time as far as this
      // diagnostic is concerned, and keeping the newest is the right tie-break —
      // a late measurement belongs to the most recently sent body.
      onRequestBody: body => {
        void recordBodyReport(region, body, { onError: error => ctx.logger.warn('dsh-connect-workbuddy: body report failed', error) })
          .then(attach => { pendingUsage = attach })
          .catch((error: unknown) => ctx.logger.warn('dsh-connect-workbuddy: body report failed', error))
      },
      onUpstreamUsage: usage => { pendingUsage?.(usage) },
      // Remember a tier refusal so the model card can name it (issue #83). The
      // reply text is not enough: compaction reads the failure as a boolean and
      // renders "could not produce a useful summary", so this is the only route
      // the observation takes to a surface the user can see.
      reportRefusal: report => { recordRefusal(report) },
      prepareAccount: async signal => {
        await refreshDepletedPoolCredits(region, signal)
        if (!signal?.aborted) await applyPoolSelection(region)
      },
      failoverAccount: triedAccountIds => failoverAccountFor(region, triedAccountIds),
      // Asked only after a request has ALREADY failed and the pool found nowhere
      // to go, so the reply can say why instead of only that it tried. It runs at
      // most once per failed request — never on a request that succeeded.
      //
      // Deliberately takes no argument from the shim: the explanation describes
      // the POOL's state, which the host can read directly, and threading the
      // tried ids through would duplicate a fact the host already holds.
      failoverShortfall: () => explainPoolShortfall(region),
      // Record what a live request learned, so the NEXT one starts from an
      // account that works instead of re-discovering this failure.
      onAccountFailure: (accountId, failure) => {
        void recordAccountFailure(region, accountId, failure)
      },
    })
    stacks[region] = { store, catalog, shim, rosterSeen }
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

  /**
   * The image selection one region should be stamped with (issue #168).
   *
   * The saved array alone cannot answer "does this model take images?", because
   * it has two writers with different meanings: the user ticking a box (a
   * DECISION, to be kept forever) and a catalog refresh re-deriving the
   * vendor-verified defaults (a SNAPSHOT of the roster as it stood that day).
   * Stamping the snapshot marks every model the roster gained SINCE as
   * text-only, `workBuddyModelInput` then answers `['text']`, and the host
   * refuses the attachment outright — `Model "…" does not support image input`
   * (`MODEL_DOES_NOT_SUPPORT_IMAGES`) — for a model `imageDefaultFor`
   * classifies as verified-multimodal.
   *
   * So the two sides are UNIONED, each contributing exactly what it can know:
   *
   *   - the SAVED array states every model the user has ticked. A tick is
   *     honoured even where the vendor table disagrees (someone may know this
   *     account refuses images for that model).
   *   - the VENDOR TABLE states the models this build can vouch for, and is
   *     consulted only for ids the saved array says nothing about. That is what
   *     un-breaks a newcomer without touching a single decision already made.
   *
   * `imageSelectionExplicit` closes the one gap a union cannot: the array cannot
   * say whether an ABSENT id was unticked or simply did not exist yet. Once a
   * human has edited the boxes, absence is a decision again and the table stops
   * contributing at all.
   *
   * This keeps every existing shape working: an empty `imageModelIds` on a
   * never-edited region now means "the user has not chosen any" and is filled
   * from the verified list; a populated one keeps every id it carries. It is
   * deliberately NOT a hard gate on the flag alone, because the settings seam
   * (`ctx.settings.update`) is a public write path and
   * `tests/settings-integration.spec.ts` pins that writing `imageModelIds`
   * there must reach the adapter without a second "I edited it" call.
   */
  const effectiveImageIds = (
    state: ReturnType<typeof regionStateOf>,
    models: readonly WorkBuddyModelInfo[],
  ): ReadonlySet<string> => {
    const chosen = new Set(state.imageModelIds ?? [])
    if (state.imageSelectionExplicit === true) return chosen
    for (const model of models) {
      // `chosen.has` first: the saved array wins, so a model it names is never
      // added or dropped by the table.
      if (!chosen.has(model.id) && imageDefaultFor(model)) chosen.add(model.id)
    }
    return chosen
  }

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
  //
  // ISSUES #114 AND #115 CHANGE THE FIRST STEP. The saved directory used to
  // WIN over the live roster, which froze the roster at a stale snapshot
  // forever: a model the upstream added (`deepseek-v4.1-flash` on the CN
  // roster) could never reach the user, because the only thing that wrote
  // `lastCatalog` was the card's explicit save, and the card saved the SAVED
  // directory back. The saved directory is now the user's NAMES, and the live
  // roster is the CAPABILITIES — see `src/catalog-sync.ts`.
  const configuredModels = (
    value: Config,
    region: WorkBuddyRegion,
    liveModels: readonly WorkBuddyModelInfo[] = [],
  ): readonly WorkBuddyModelInfo[] => {
    const state = regionStateOf(value, region)
    // `keepLoadLevel` is ON: this is the RUNTIME roster, and the load badge
    // the model picker draws lives here. The card's directory drops it (see
    // `displayModels`), because load is never persisted.
    const roster = resolveRoster(state.lastCatalog ?? [], liveModels, region, { keepLoadLevel: true })
    // `canDisableThinking` must be carried into `lastCatalog` by the card's
    // save or the next load loses it and withdraws `off` from every model
    // (the same mechanism as `imageModelIds` / `multimodal`); so stamp the
    // effective value on top of the image stamp, then let the user's selection
    // decide the final answer.
    const declared = withImageSelection(
      deriveCatalog(roster, new Set(state.enabledModelIds ?? []), state.contextBudgets ?? {}),
      // #168: seeded from the vendor table while the user has never edited the
      // boxes. The SET is computed from the roster this call is about to serve,
      // not from the stored array, so a model the roster gained since the last
      // refresh is stamped on its own verified capability instead of on its
      // absence from a stale snapshot.
      effectiveImageIds(state, roster),
    )
    // A refusal observed at request time is an OBSERVATION about the model, so it
    // is stamped beside the table's verdict — the card shows both, and one
    // cannot be mistaken for the other (issue #83).
    const stamped = withEffectiveOff(declared, new Set(savedOffModelIds(state, declared)))
    return stamped.map(model => model.reasoning === undefined || lastRefusalFor(model.id) === undefined
      ? model
      : { ...model, reasoning: { ...model.reasoning, refusesOff: true } })
  }

  /**
   * The region's `off` selection as a Set (issue #34).
   *
   * `undefined` means "the user has never saved" — seed from the built-in rule
   * so the checkbox is ticked correctly on first read. An explicit `[]` means
   * the user UNticked everything and must stay empty: `regionStateOf` reads the
   * raw stored slot, so `undefined` and `[]` are distinguishable here, and
   * collapsing them would silently re-enable every model on the next load.
   */
  const savedOffModelIds = (
    state: ReturnType<typeof regionStateOf>,
    roster: readonly WorkBuddyModelInfo[],
  ): readonly string[] =>
    state.offModelIds ?? defaultOffModelIds(roster)
  // What the card displays: this region's last-refreshed directory, so the user
  // re-reads the current catalog rather than a stale saved snapshot. Same
  // three-step roster as `configuredModels` (issue #32): a saved slot that lost
  // its directory must show the LIVE catalog, not the static fallback, or the
  // card reports the user's in-use model as withdrawn ("已下架") while the
  // runtime is still serving it.
  //
  // ISSUES #114/#115: the saved directory no longer SUPPRESSES the live
  // roster. The card used to list the saved snapshot, so a stale snapshot
  // kept a newly added upstream model invisible AND kept a model with no
  // `reasoning` block listed with no thinking tiers. The live roster is now
  // merged OVER the saved one — the card shows what the upstream actually
  // offers, and the user's own models are still kept.
  const displayModels = (value: Config, region: WorkBuddyRegion): readonly WorkBuddyModelInfo[] => {
    const state = regionStateOf(value, region)
    // Routers are dropped at every read, not just in the fresh roster. A
    // `lastCatalog` saved by an earlier version still names `auto` /
    // `default-model`, and this snapshot is what the card lists — so without
    // the filter the row would survive the upgrade and only vanish at the next
    // refresh, which reads as "the fix did not work".
    //
    // ⚠️ ONLY WHEN THAT ROSTER IS REALLY LIVE (issue #214). `current()` is
    // seeded with the STATIC fallback table by the constructor, and
    // `resolveRoster` cannot tell a static list from an upstream answer (it
    // only sees a non-empty array). Passing it unconditionally made the built-in
    // table speak as the upstream:
    //
    //   - `overlayLiveCapabilities` gives the live side ownership of
    //     `creditMultiplier` / `reasoning` / `supportsImages`, so a table that
    //     declares one of those overrides the user's saved value. THIS IS THE
    //     #214 PRICE BUG; the table's captured rates are what actually did the
    //     damage, and they are gone (see `src/catalog.ts`).
    //   - `mergeRoster` lists the live roster FIRST and appends saved-only
    //     models, so the card's directory was led by a placeholder roster.
    //
    // `applySelection` was fixed for this in 5.18.0; this reader was not, which
    // is why the report survived the upgrade. The guard is now defence in depth
    // rather than the fix: the table asserts no live-owned field, so it is not
    // observable today (the regression test says so explicitly). It stays
    // because the next field someone adds to that table would otherwise
    // silently start overriding a saved value again — which is exactly how
    // this issue began.
    const live = stacks[region]?.catalog?.hasLiveRoster() === true
      ? stacks[region].catalog.current()
      : []
    // `keepLoadLevel` is OFF: this is the card's DIRECTORY, and the load level
    // is a fact about this minute that is deliberately never persisted (see
    // `src/busy.ts`). The card reads the level from a separate map instead —
    // `liveBusyLevels` — so two sources cannot disagree.
    return resolveRoster(state.lastCatalog ?? [], live, region)
  }

  /**
   * The load levels of the LIVE roster, keyed by model id.
   *
   * A SEPARATE read on purpose. `displayModels()` prefers the SAVED
   * `lastCatalog` (it is what the card edits), and a saved roster carries no
   * load level — load is not persisted, see `src/busy.ts`. So the card cannot
   * get the level from the model list it already has; it needs the live roster
   * beside it.
   *
   * Returning a MAP (not a merged roster) keeps the two apart: the card's list
   * stays the saved one the user edits, and the badge is a decoration that may
   * be absent for a model the probe did not answer for.
   */
  const liveBusyLevels = (region: WorkBuddyRegion): Record<string, WorkBuddyBusyLevel> => {
    const live = stacks[region]?.catalog?.current() ?? []
    const levels: Record<string, WorkBuddyBusyLevel> = {}
    for (const model of live) {
      if (model.busyLevel !== undefined) levels[model.id] = model.busyLevel
    }
    return levels
  }

  /**
   * The most recent request whose foreign thinking blocks were dropped
   * (issue #147).
   *
   * Process-local and last-wins, deliberately: this is DIAGNOSTIC state that
   * answers "why did my answer look like working notes", and it is only read by
   * the status endpoint. Persisting it would let a stale turn from yesterday
   * explain a session that has since been fixed — the whole point is that the
   * reader is looking at the turn that just happened. It forgets on restart,
   * which is the natural expiry for "what this process removed recently".
   *
   * Declared HERE rather than inside the adapter mount because the status route
   * is registered outside that callback and must be able to read it.
   */
  let latestForeignThinking: { blocks: readonly ForeignThinkingBlock[], atMs: number } | undefined

  let current = () => config
  let invalidateCatalog = (): void => {}

  /**
   * 渠道门拒绝（`channel_reject` / 11128）之后的自动「继续」。
   *
   * 挂在这里而不是 adapter 里，理由是**它要的是一个新回合**：adapter 只看得到
   * 一次请求，`channel_reject` 在同一个请求内已经跑完三级救援阶梯，再在那一层
   * 重发就是把被拒的字节原样再送一遍。宿主把这一轮判死之后才追加 `turn/end`，
   * 而新回合会让宿主重新组装 surface —— 那才是 `docs/PINNED-11128-RETRY.md`
   * 里「把这条消息再发一次」真正做的事。
   *
   * 会花真实请求，所以开关默认关闭，且只在用户显式打开后才读配置（见
   * `channelContinueSettingsOf`：只有 `=== true` 算开启）。
   */
  const disposeChannelContinue = installChannelContinue({
    // 活值：用户拨动开关之后，下一次失败立刻按新值处置，不必重载插件。
    getConfig: () => {
      const block = unwrapVolatile(current().channelRejectContinue) as
        | { enabled?: unknown, maxConsecutive?: unknown, text?: unknown }
        | undefined
      return channelContinueSettingsOf(block?.enabled, block?.maxConsecutive, block?.text)
    },
    // 每次发送时现取 agent：用户可能在两次失败之间关掉了会话，而缓存的 agent
    // 引用会 followup 到一个已经不在的会话上。
    getAgent: sessionId => {
      const agents = (ctx as unknown as { get(service: string): unknown }).get('agents') as
        | { get(id: string): ContinueAgent | undefined }
        | undefined
      return agents?.get(sessionId)
    },
    log: message => { ctx.logger.warn(`dsh-connect-workbuddy: ${message}`) },
    // `session/event` 是宿主事件，本插件没有 `@deepseek-ai/dsh-session` 这条
    // peer 依赖（也不该有，只为一条监听引入它不划算）。鸭子类型的 cast 只在这
    // 一行，引擎本身因此可以在没有宿主包的测试里逐条验证。
    //
    // 返回值的真实类型是 `() => boolean`（「取消时它是否还在」），这里照实写：
    // 声明成 `() => void` 也是可赋值的，但那条断言会骗过将来的一次重构，让
    // 「退订失败」这个信息从类型上消失。
    onSessionEvent: listener =>
      (ctx as unknown as {
        on(name: string, handler: (session: unknown, event: unknown) => void): () => boolean
      }).on('session/event', listener),
  })
  ctx.effect(() => () => { disposeChannelContinue() })

  /**
   * REPAIR a region's saved directory against the live upstream roster.
   *
   * ISSUES #114 AND #115, THE PERSISTED HALF. The read side now serves the
   * live roster (see {@link resolveRoster}), but the SAVED directory would
   * still hold the stale snapshot — and the card's save writes the saved
   * directory back, so the stale snapshot would outlive the fix and could be
   * written back over the healed one. So the directory is repaired once, when
   * the live roster lands.
   *
   * WHAT IS WRITTEN: the live roster merged over the saved one, so a newly
   * added upstream model enters the directory and the user's own models stay.
   * `enabledModelIds` is NOT touched — the selection is its own field, and a
   * model leaving the upstream roster must not lose its tick.
   *
   * WHEN IT IS WRITTEN: only when the fingerprint actually differs, so a
   * profile that is already in agreement is never written to. Without that
   * guard every startup would write, and a write per startup is a write storm
   * on a profile the user opens often.
   *
   * THE FALLBACK-SNAPSHOT CASE. A directory that is byte-identical to the
   * static fallback table was never a user's selection — it is the plugin's
   * own placeholder that came back as if the user had chosen it (issue
   * #114's root cause). It is replaced by the live roster outright.
   *
   * FAIL-SOFT: a repair that cannot be written is not a reason to fail a
   * request. The read side is already correct without it, so the repair is
   * an optimisation that heals the profile, never a precondition.
   */
  const repairRegionCatalog = async (
    region: WorkBuddyRegion,
    live: readonly WorkBuddyModelInfo[],
    options: { readonly strict?: boolean } = {},
  ): Promise<void> => {
    if (live.length === 0) return
    const state = regionStateOf(current(), region)
    const saved = state.lastCatalog ?? []
    // A saved directory that is the static fallback table is not a selection.
    // The load level is dropped either way: it is a fact about this minute and
    // the saved directory must never carry one (`src/busy.ts`), and an
    // explicit `undefined` would fail the settings write's strict JSON codec.
    const repaired = (isUnconfiguredFallbackSnapshot(saved, region)
      ? withoutRouters(live)
      : repairedCatalog(saved, live)
    ).map(model => {
      if (model.busyLevel === undefined) return model
      const { busyLevel: _dropped, ...rest } = model
      return rest as WorkBuddyModelInfo
    })
    if (repaired.length === 0) return
    // The fingerprint compares what MATTERS (ids, capability fields), so a
    // directory that differs only in a load level or a promo badge is not
    // rewritten — those are not persisted anyway.
    //
    // A CORRUPTED FIELD IS WRITTEN EVEN WHEN THE DIRECTORY AGREES (the "restart
    // reset" report). The repair is also the only writer that replaces the whole
    // `regions` field with a freshly merged map, so it is the one place that can
    // clean out the sibling-field copies an older build wrote in. Gating that on
    // the model directory alone would leave every in-agreement profile dirty
    // forever — which is precisely the shape that made the pool look unsaved,
    // outliving the fix that stopped producing it. One write per corrupted
    // profile: after it lands, the field is clean and this branch stops firing.
    const directoryDiffers = catalogFingerprint(repaired) !== catalogFingerprint(saved)
    if (!directoryDiffers && !regionsFieldIsCorrupt(current().regions)) return
    try {
      await writeRegionCatalog(hostSettings(), settingsNs, region, repaired)
    } catch (error: unknown) {
      // STRICT means the caller PROMISED this write (issue #214). The refresh
      // route answers "here are the fresh prices, and they are recorded"; if the
      // recording failed, a 200 would be a lie the user acts on — they would
      // close the card believing the new rate was saved. Such a caller gets the
      // error and reports it, instead of a log line nobody reads.
      if (options.strict === true) throw error
      // The read side already serves the live roster, so a failed automatic
      // repair costs nothing but the profile's own tidiness. Log and move on.
      ctx.logger.warn(
        `dsh-connect-workbuddy: could not repair the ${region} model directory against the live roster`,
        error,
      )
    }
  }

  /**
   * The Host's settings service, or `undefined` when it is not available.
   *
   * Read through `ctx.get` at the moment of the write rather than sampled
   * once during `apply`: the service is optional on some hosts, and a
   * snapshot taken too early would be `undefined` forever.
   */
  const hostSettings = (): HostSettingsService | undefined =>
    (ctx as unknown as { get?: (name: string) => unknown }).get?.('settings') as HostSettingsService | undefined

  /**
   * Clean a `regions` field a previous version corrupted, once, at boot.
   *
   * The corruption itself is fixed at the source (`src/catalog-write.ts`) and the
   * read paths heal in memory, so a dirty profile is CORRECT long before this
   * runs — but it stays dirty in the file, and the next save would carry the
   * debris forward. The catalog repair writes the same clean shape, yet it only
   * runs when a live roster arrives: a disabled region, an unreachable upstream
   * or an empty answer would leave the wreckage in place for as long as those
   * conditions hold. This needs no upstream at all.
   *
   * FAIL-SOFT, exactly like the repair: the read side is already right, so a
   * write that cannot land costs tidiness and nothing else.
   */
  const healRegionsFieldIfCorrupt = async (): Promise<void> => {
    try {
      await healRegionsField(hostSettings(), settingsNs)
    } catch (error: unknown) {
      ctx.logger.warn(
        'dsh-connect-workbuddy: could not clean the shape of the regions setting',
        error,
      )
    }
  }

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
    // The user's own selection rides along with the refresh. The upstream
    // roster may drop a model the user is running (the app channel's `cli`
    // roster dropped `minimax-m2.7` on 2026-10-21), and the runtime catalog
    // filters the roster by that selection — so without the kept ids a
    // refresh would silently withdraw the model the user is on, which is the
    // exact failure issue #32 was filed for. The document still publishes it
    // and the chat endpoint still answers for it, so it stays in the roster.
    const keep = regionStateOf(current(), region).enabledModelIds ?? []
    return client.fetchModels(credential, signal, keep)
  }
  /**
   * Record a refresh the card just asked for (issue #214).
   *
   * The reported bug, in one sentence: the refresh button was the only code
   * path that read the CURRENT upstream prices, and it discarded them. So the
   * fresh numbers were visible only inside the response to that one press —
   * the card went on rendering `displayModels()` (the saved directory) and the
   * runtime went on serving the catalog built at startup, which is why the
   * reporter saw 0.69 from `models/refresh` and 0.79 from `usage` on the same
   * host at the same moment.
   *
   * TWO WRITES, and they are deliberately different:
   *
   *   1. the live CATALOG, so the running provider and the picker's price
   *      labels follow the upstream immediately — this is the in-memory answer
   *      the user was looking at when they pressed the button;
   *   2. the saved DIRECTORY, through the Host's merge, so the price survives
   *      the settings card being closed and the harness being restarted.
   *
   * What is NOT written is the user's selection. `enabledModelIds`,
   * `imageModelIds`, `contextBudgets` and `defaultThinkingEfforts` remain the
   * card's DRAFT until Save — the card's own refresh handler re-maps them onto
   * the fresh rows and keeps them dirty, and the reporter's report shows the
   * draft list containing models that were not ticked. Committing them here
   * would turn one press of "refresh" into an unrequested "save".
   *
   * `origin: 'upstream'` on the catalog write is correct and load-bearing: this
   * roster IS a fresh upstream answer, which is what lets `hasLiveRoster()`
   * become true and every other reader stop mistaking the static table for the
   * upstream (see `displayModels`).
   */
  const persistRefreshedModels = async (
    region: WorkBuddyRegion,
    models: readonly WorkBuddyModelInfo[],
  ): Promise<void> => {
    if (models.length === 0) return
    const state = regionStateOf(current(), region)
    // Derive the runtime roster from the SAME rules the startup refresh uses,
    // so a mid-session refresh and a restart land on the same catalog. Without
    // this the two writers would disagree about the image seed and the `off`
    // stamp, and which one you got would depend on whether you had pressed a
    // button since starting the harness.
    const next = withEffectiveOff(
      withImageSelection(
        deriveCatalog(models, new Set(state.enabledModelIds ?? []), state.contextBudgets ?? {}),
        effectiveImageIds(state, models),
      ),
      new Set(savedOffModelIds(state, models)),
    )
    stacks[region].catalog.set(next)
    invalidateCatalog()
    // The DIRECTORY. `repairRegionCatalog` is the one writer that knows the
    // merge (it preserves the other region and this slot's sibling fields,
    // drops the never-persisted `busyLevel`, and skips the write when the
    // fingerprint already agrees). Reusing it rather than writing here keeps
    // one definition of "what a correct directory looks like".
    //
    // `strict` because THIS call is the answer to a user's click: the route
    // reports the fresh prices on the strength of this write, so a swallowed
    // failure would produce a 200 for a save that did not happen — the exact
    // class of bug being fixed here.
    await repairRegionCatalog(region, models, { strict: true })
  }
  /**
   * The region's MEDIA models, cached briefly for the card's read-only roster.
   *
   * Two callers ask the same question — the image tool (to validate a model
   * argument) and the card's roster block (to SHOW what exists) — and both get
   * the same answer from the same free GET. The cache exists because the card
   * re-reads it on every settings render, not because the answer is expensive.
   *
   * Region-keyed, and a failure is NOT cached: a gateway hiccup must not make
   * the roster read "no models" for five minutes.
   */
  const mediaCaches = new Map<WorkBuddyRegion, { readonly at: number; readonly models: readonly WorkBuddyMediaModel[] }>()
  const readMediaModels = async (
    region: WorkBuddyRegion,
    options?: { readonly signal?: AbortSignal; readonly refresh?: boolean },
  ): Promise<readonly WorkBuddyMediaModel[]> => {
    const cached = mediaCaches.get(region)
    const now = Date.now()
    if (options?.refresh !== true && cached !== undefined && now - cached.at < MEDIA_MODEL_TTL_MS) {
      return cached.models
    }
    const credential = await stacks[region].store.resolve()
    const models = await client.fetchMediaModels(credential, options?.signal)
    mediaCaches.set(region, { at: Date.now(), models })
    return models
  }

  /**
   * Stamp each model's LIVE load level onto the runtime roster.
   *
   * Deliberately NOT part of {@link discoverModels}: that reader feeds the
   * settings card's "Refresh from WorkBuddy" draft, which is SAVED into
   * `lastCatalog` — and a saved load level is a lie the moment the settings page
   * is closed (`src/busy.ts`). So the level is stamped only on the path that
   * builds the RUNTIME catalog, and it dies with the process.
   *
   * Fail-soft on purpose: a refresh that cannot read the load probe still
   * delivers the roster. Losing a badge is nothing; losing the model list
   * because a 5-second probe timed out would be the same defect this plugin
   * spends most of its comments avoiding.
   */
  const withBusyLevels = async (
    region: WorkBuddyRegion,
    models: readonly WorkBuddyModelInfo[],
    signal?: AbortSignal,
  ): Promise<readonly WorkBuddyModelInfo[]> => {
    if (models.length === 0) return models
    try {
      const credential = await stacks[region].store.resolve()
      const levels = await client.fetchModelBusy(credential, models.map(model => model.id), signal)
      return levels.size === 0 ? models : attachBusyLevels(models, levels)
    } catch (error: unknown) {
      ctx.logger.warn(
        'dsh-connect-workbuddy: model load probe unavailable; refreshing the roster without load levels',
        error,
      )
      return models
    }
  }

  /**
   * Re-stamp the LIVE load levels onto a roster that was just recomputed.
   *
   * WHY A REPLAY NEEDS THIS. `configuredModels()` rebuilds the roster from the
   * SAVED `lastCatalog`, and a saved roster has no load level in it — load is
   * deliberately not persisted (`src/busy.ts`: a cached level is a lie the
   * moment the settings page closes). So every config change — switching
   * region, changing the model selection, toggling a level, moving an account —
   * used to wipe the badges that were on screen a second earlier, and the user
   * saw "极度拥堵" appear and then vanish without touching the upstream at all.
   *
   * The fix is to ask again rather than to remember: the probe is read-only,
   * free, and answers in ~190 ms for the whole roster. Keeping the level out
   * of disk is the point, so the honest place to get it back is the upstream.
   *
   * Fail-soft, like the other probe: a level that cannot be read is a missing
   * badge, never a missing model list.
   */
  const restampBusyLevels = async (
    region: WorkBuddyRegion,
    models: readonly WorkBuddyModelInfo[],
  ): Promise<readonly WorkBuddyModelInfo[]> => {
    if (models.length === 0) return models
    try {
      const credential = await stacks[region].store.resolve()
      const levels = await client.fetchModelBusy(credential, models.map(model => model.id))
      return levels.size === 0 ? models : attachBusyLevels(models, levels)
    } catch (error: unknown) {
      ctx.logger.warn(
        'dsh-connect-workbuddy: load probe unavailable while re-applying the selection; the roster keeps no load levels',
        error,
      )
      return models
    }
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
      //
      // ⚠️ ONLY when that roster is really live. `catalog.current()` returns the
      // static fallback until the first refresh lands, and `resolveRoster` cannot
      // tell a static list from a live one (it only sees a non-empty array). So
      // passing it unconditionally let a settings write that arrives BEFORE the
      // first refresh copy the static roster into the catalog as if it were
      // upstream — reopening issue #32 from the other side. `hasLiveRoster()`
      // is the discriminator; without a live roster the region's saved slot is
      // resolved on its own, which is the pre-refresh behaviour it wants anyway.
      const liveRoster = stacks[region].catalog.hasLiveRoster() ? stacks[region].catalog.current() : []
      stacks[region].catalog.set(configuredModels(value, region, liveRoster), 'derived')
    }
    invalidateCatalog()
    // The replay above rebuilt each roster from the SAVED directory, which
    // carries no load level (see `restampBusyLevels`). Ask the upstream again
    // so the badges survive a settings change instead of blinking out. This runs
    // AFTER the synchronous work on purpose: the roster must be published
    // first, so the model list is never held hostage to a probe.
    for (const region of REGION_KEYS) {
      void (async () => {
        // `origin: 'derived'` on purpose: this re-stamps load levels onto the
        // roster `applySelection` just derived; it is NOT a fresh upstream
        // answer. Marking it live would let the static fallback (which the
        // roster can still be, before the first refresh) claim to be live —
        // the same mistake the loop above was fixed for.
        const live = await restampBusyLevels(region, stacks[region].catalog.current())
        if (live.length === 0) return
        stacks[region].catalog.set(live, 'derived')
        invalidateCatalog()
      })()
    }
    syncRegionRegistration(value)
    // The image tool is gated on this same region switch, and the switch is a
    // volatile field: the loader only broadcasts it, it does not re-apply. So
    // the tool is registered/unregistered HERE, on the same call that moves the
    // routes, or it would follow a stale answer.
    syncImageTool(value)
    // The video tool is gated on the same region switch, for the same reason
    // as the image tool: the switch is volatile, so it must follow HERE.
    syncVideoTool(value)
    // The CLI route reads its settings the same way: `cliBridge` is volatile, so
    // turning it on arrives through this same call and the surfaces have to
    // follow here (they cannot re-apply).
    syncCliBridge(value)
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
      } catch (error) {
        ctx.logger('workbuddy').warn('region usability scan failed for %s: %s', region, error)
        continue
      }
      const changed = stacks[region].catalog.setRegionUsable(accounts.length > 0)
      if (changed) invalidateCatalog()
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

  /**
   * 可选工具（生图 / 视频）的注册机。两者曾是两份 85% 相同的状态机：同一套
   * `wanted && dispose === undefined && tools !== undefined` 闩锁、同一套逐区凭据
   * 解析、同一套 `ctx.inject(['tools'])` 挂载与卸载。现在只保留差异 —— 门判据、
   * 执行层工厂 —— 其余一份。
   *
   * `tools` 服务可能晚于 apply 出现，所以用 inject 等它；`wanted` 每次读活配置：
   * 开关是 volatile 字段，loader 只广播、不重挂 apply。
   */
  type ToolOptIn = 'imageToolEnabled' | 'videoToolEnabled'
  function mountOptionalTool(options: {
    wanted: (value: Config) => boolean
    register: (tools: ToolsServiceLike) => (() => void) | undefined
  }): (value: Config) => void {
    let tools: ToolsServiceLike | undefined
    let dispose: (() => void) | undefined
    const sync = (value: Config): void => {
      const wanted = options.wanted(value)
      if (wanted && dispose === undefined && tools !== undefined) {
        dispose = options.register(tools)
        return
      }
      if (!wanted && dispose !== undefined) {
        dispose()
        dispose = undefined
      }
    }
    ctx.inject(['tools'], (toolsCtx) => {
      tools = (toolsCtx as unknown as { tools?: ToolsServiceLike }).tools
      if (tools === undefined) return
      sync(current())
      toolsCtx.effect(() => () => {
        dispose?.()
        dispose = undefined
        tools = undefined
      })
    })
    return sync
  }

  /**
   * 每次调用现挑区、现解析凭据：用户在两次调用之间换账号或关掉某区都要生效。
   * `optIn` 必须是该工具自己的逐区开关 —— 生图不能借用视频已授权的区，否则绕过
   * 用户按区做出的授权。
   */
  const toolCredential = (optIn: ToolOptIn) => async (): Promise<WorkBuddyCredential | undefined> => {
    const live = current()
    for (const region of REGION_KEYS) {
      if (!regionEnabled(live, region)) continue
      if (regionStateOf(live, region)[optIn] !== true) continue
      try { return await stacks[region].store.resolve() } catch { continue }
    }
    return undefined
  }

  // 生图工具：任一「开着 + 显式授权」的区有生图模型就注册。两区单价不同，工具
  // 文案不写死价钱，回报上游结算里真实的 `data.usage.credit`。
  const syncImageTool = mountOptionalTool({
    wanted: value => imageToolRegionOf(value) !== undefined,
    register: tools => registerWorkBuddyImageTool(tools, {
      resolveCredential: toolCredential('imageToolEnabled'),
      listMediaModels: (credential, signal) => client.fetchMediaModels(credential, signal),
      generateImage: (credential, request, signal) => client.generateImage(credential, request, signal),
      editImage: (credential, request, signal) => client.editImage(credential, request, signal),
      // 卡片上选的文生图模型（issue #241）。空串就是「没选」，工具按组内第一个走——
      // 与视频的钉住同一个读法，只是生图只有一个 tag 组，不必按 tag 存一张表。
      preferredImageModel: (credential, tag) => {
        if (tag !== IMAGE_TAG_TEXT_TO_IMAGE) return undefined
        const picked = regionStateOf(current(), regionOf(credential.domain)).preferredImageModel
        return picked === undefined || picked === '' ? undefined : picked
      },
      logger: ctx.logger,
    }),
  })

  // 视频工具：同一注册机，执行层是 submitVideo→pollVideoTask→downloadVideo。
  const syncVideoTool = mountOptionalTool({
    wanted: value => videoToolRegionOf(value) !== undefined,
    register: tools => registerWorkBuddyVideoTool(tools, {
      resolveCredential: toolCredential('videoToolEnabled'),
      listMediaModels: (credential, signal) => client.fetchMediaModels(credential, signal),
      submitVideo: (credential, request, signal) => client.submitVideo(credential, request, signal),
      pollVideoTask: (credential, taskId, signal) => client.pollVideoTask(credential, taskId, signal),
      preferredVideoModel: (credential, tag) =>
        regionStateOf(current(), regionOf(credential.domain)).preferredVideoModels?.[tag],
      downloadVideo: (credential, url, signal) => client.downloadVideo(credential, url, signal),
      logger: ctx.logger,
    }),
  })

  // Optional CLI route (`codebuddy_ask` + `/codebuddy`).
  //
  // Mounted the SAME way as the image tool above, and for the same reason: both
  // `tools` and `commands` are host services that can appear after this row, so
  // they are awaited with `ctx.inject` instead of sampled with `ctx.get()` once
  // during apply. Sampling looks identical until the day a Host (Desktop) loads
  // the surface later than the plugin, and then the entrance silently never
  // exists — there is no error, just an empty `/` command list.
  //
  // The runtime (normalized options + ONE shared turn gate) is rebuilt only when
  // the serialized settings actually change, which is what makes this safe to
  // run from the volatile-update listener: re-mounting on every unrelated
  // volatile write would reset the hourly budget the user is being held to.
  let cliTools: BridgeToolsService | undefined
  let cliCommands: BridgeCommandsService | undefined
  // Reads a session's LIVE working directory. Set when the Host publishes its
  // session projections and left undefined otherwise, which is exactly the
  // pre-projection behaviour (the ladder then reads the session header).
  let cliDirectoryOf: DirectoryOf | undefined
  // THE PROBE, not the value. The runtime snapshots `directoryOf` once at
  // `createCliBridgeRuntime`, but `sessionProjections` can arrive AFTER the
  // runtime was built on the tools/commands row — and `syncCliBridge` keys the
  // rebuild on the serialized settings only, so a settings-unchanged rebuild is a
  // no-op and the runtime would keep the `undefined` it captured at build time.
  // Wiring the mutable cell through a stable closure makes the runtime read the
  // CURRENT source on every turn, which is what kills the ordering dependency.
  // `null` from an unset cell is indistinguishable from "no projection service",
  // so the header fallback is unchanged.
  const cliDirectoryProbe: DirectoryOf = (session) => cliDirectoryOf?.(session) ?? null
  let cliRuntime: CliBridgeRuntime | undefined
  let cliRuntimeKey = ''
  let disposeCliTool: (() => void) | undefined
  let disposeCliCommand: (() => void) | undefined

  const disposeCliSurfaces = (): void => {
    disposeCliTool?.()
    disposeCliTool = undefined
    disposeCliCommand?.()
    disposeCliCommand = undefined
  }

  const syncCliBridge = (value: Config): void => {
    const settings = unwrapVolatile(value.cliBridge)
    // The key covers everything that changes behavior; anything else in the
    // settings object is derived from these fields anyway.
    const key = JSON.stringify(settings ?? {})
    if (key !== cliRuntimeKey) {
      cliRuntimeKey = key
      disposeCliSurfaces()
      cliRuntime?.deps.gate?.clear()
      cliRuntime = createCliBridgeRuntime(
        settings,
        REGION_KEYS.map(region => ({ region, store: stacks[region].store })),
        message => ctx.logger.warn(`dsh-connect-workbuddy: ${message}`),
        cliDirectoryProbe,
      )
    }
    if (cliRuntime === undefined) {
      disposeCliSurfaces()
      return
    }
    if (cliTools !== undefined && disposeCliTool === undefined) {
      disposeCliTool = mountToolSurface(cliRuntime, cliTools)
    }
    if (cliCommands !== undefined && disposeCliCommand === undefined) {
      disposeCliCommand = mountCommandSurface(cliRuntime, cliCommands)
    }
  }

  ctx.inject(['tools'], (toolsCtx) => {
    cliTools = (toolsCtx as unknown as { tools?: BridgeToolsService }).tools
    if (cliTools === undefined) return
    syncCliBridge(current())
    toolsCtx.effect(() => () => {
      // Only this surface: the other one may still be mounted on a fiber that
      // outlives this one, and tearing it down here would leave `cliTools`
      // unset but `disposeCliCommand` undefined, so nothing would re-mount it.
      disposeCliTool?.()
      disposeCliTool = undefined
      cliTools = undefined
    })
  })

  ctx.inject(['commands'], (commandsCtx) => {
    cliCommands = (commandsCtx as unknown as { commands?: BridgeCommandsService }).commands
    if (cliCommands === undefined) return
    syncCliBridge(current())
    commandsCtx.effect(() => () => {
      disposeCliCommand?.()
      disposeCliCommand = undefined
      cliCommands = undefined
    })
  })


  // The CLI route's directory source: the Host's session projections.
  //
  // WHY THIS INJECT EXISTS. The bridge used to default a turn's directory to
  // `agent.session.header.cwd`, which the Host documents as detached, deep-frozen
  // creation metadata — the directory the session was OPENED with, not the one it
  // is in now. The live directory is a session projection (key
  // `"workingDirectory"`, committed on every /cd), and it is what the Host itself
  // prints into the model's system prompt. Reading the projection here is what makes
  // /codebuddy and codebuddy_ask agree with the model about where the work is
  // happening.
  //
  // SAME REASON AS THE TWO INJECTS ABOVE: sessionProjections is a host service that
  // can appear after this row, so it is awaited rather than sampled once at apply
  // time. Sampling would lose it on Desktop exactly the way tools and commands were
  // being lost before.
  //
  // DEGRADATION IS THE POINT. A Host without this service leaves cliDirectoryOf
  // undefined, and the bridge then reads the session header — the pre-projection
  // behaviour, unchanged. Nothing here is load-bearing: no route disappears and no
  // turn is refused because of a missing projection.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const reader = (projectionCtx as unknown as { sessionProjections?: BridgeProjectionReader })
      .sessionProjections
    // Either read face will do: `snapshot` is the current one, `stateOf` the
    // deprecated one a host older than DSH 0.2.2 may still be the only one
    // offering. `cliDirectoryOf` below decides per call, so a host that gains
    // `snapshot` in an upgrade starts using it without any code here changing.
    if (reader === undefined || (typeof reader.snapshot !== 'function' && typeof reader.stateOf !== 'function')) return

    /**
     * The one place the projection key is spelled out.
     *
     * It must match the Host's own registration — key
     * `"workingDirectory"`, stateVersion 1, in the Host's
     * @deepseek-ai/dsh-working-directory package. If the Host renames the key, this is
     * the line that has to follow, and the comment is what tells the next reader
     * where to look.
     *
     * Returns null for `"no committed directory"`, which is the same signal the header
     * path produces when it has nothing — so the ladder below it behaves identically.
     * NOTE what it deliberately does NOT do: fall back to the service's own default.
     * The Host's get() answers stateOf(...) ?? defaultDirectory, and that fallback is
     * the Host process's cwd, i.e. a directory nobody chose. Substituting it here would
     * quietly turn `"we do not know"` into `"use this one"`, which is the one change this
     * whole refactor must not make.
     */
    const WORKING_DIRECTORY_PROJECTION_KEY = 'workingDirectory'
    cliDirectoryOf = (session: unknown): string | null => {
      let state: unknown
      try {
        // `readProjectedState` prefers the documented read face (DSH 0.2.2+
        // `snapshot`) and falls back to the deprecated `stateOf` only on a Host
        // that has no `snapshot`. Both are synchronous and I/O-free; the only
        // difference is that `stateOf` prints a deprecation warning once per
        // key per process, which is why it is no longer the first choice.
        state = readProjectedState(reader, session, WORKING_DIRECTORY_PROJECTION_KEY)
      } catch {
        // A projection reader that throws is treated as one that does not exist: the
        // header fallback below still produces a usable directory.
        return null
      }
      if (typeof state !== 'string') return null
      const trimmed = state.trim()
      return trimmed === '' ? null : trimmed
    }

    // Nothing to rebuild: the runtime was wired with `cliDirectoryProbe`, which
    // reads THIS cell on every turn, so the source takes effect on the next call
    // whether the runtime existed before or after this service appeared. (The old
    // code called `syncCliBridge` here expecting a rebuild, but that path keys on
    // the serialized settings — unchanged — so it was a no-op and the projection
    // silently never reached an already-built runtime. The probe is the fix.)

    projectionCtx.effect(() => () => {
      cliDirectoryOf = undefined
    })
  })

  // Same-origin routes backing the Plugin-configuration card. `webServer`
  // can mount after this row, so wait reactively for it instead of sampling
  // ctx.get() once during apply (which silently loses all routes on Desktop).
  ctx.inject(['webServer'], (webCtx) => {
    /**
     * 池子里每个账号的 uid，用来算"留空时会发出什么"。
     *
     * 按 accountId 去重：同一个账号可能同时出现在两个区域的凭据目录里（用户
     * 两边都登录过），而它的设备身份只该有一个。`credentialFor` 每账号一次
     * 文件读，只在这条路由被打开/保存时发生，不在请求热路径上。
     */
    const deviceAccounts = async (): Promise<{ accountId: string, uid: string }[]> => {
      const entries: { accountId: string, uid: string }[] = []
      const seen = new Set<string>()
      for (const region of REGION_KEYS) {
        for (const account of await stacks[region].store.accounts()) {
          if (seen.has(account.id)) continue
          const credential = await stacks[region].store.credentialFor(account.id)
          if (credential === undefined || credential.uid === '') continue
          seen.add(account.id)
          entries.push({ accountId: account.id, uid: credential.uid })
        }
      }
      return entries
    }
    /**
     * 给设置补上派生值。读、切档、保存三条路都走它，三个响应因此永远同形。
     *
     * 派生值算不出来（本机没有设备盐）时整块缺席，而不是回一个空对象：缺席是
     * "这次没算"，空对象是"算过，一个都没有"，弹窗对这两种情况要说不同的话。
     */
    const withDerived = async (settings: WorkBuddyDeviceSettings): Promise<WorkBuddyDeviceSettings> => {
      // 派生值只是"给用户看"的附加物：列举账号时的一次 IO 失败不该让整条设置
      // 路由 500——那会让档位开关和齿轮一起打不开，而它们本来是可以用的。
      //
      // `realTier` 与派生值不同：它**永远**要带上，包括派生值算失败的那条路径。
      // 少了它，界面就退回"不禁用任何东西"，于是 mac 上那个点不动的「真实值」
      // 又会重新变得可点——而这正是这次要消掉的状态。
      try {
        const derived = await describeDerivedDevices(await deviceAccounts())
        return derived === undefined
          ? { ...settings, realTier: REAL_TIER_AVAILABILITY }
          : { ...settings, derived, realTier: REAL_TIER_AVAILABILITY }
      } catch {
        return { ...settings, realTier: REAL_TIER_AVAILABILITY }
      }
    }
    return registerWorkBuddyStatusRoute(webCtx, {
    store: region => stacks[region].store,
    client,
    // Verifies whether some OTHER local account is still accepted upstream, so
    // a refused credential can be answered with "switch accounts" instead of a
    // re-login instruction that would change nothing. Cached per account and
    // issuance time; only ever consulted after a rejection.
    accountUsable: accountUsabilityProbe,
    /**
     * The CLI route's live turns, for the composer readout.
     *
     * Read through `cliRuntime` rather than captured once: the runtime is rebuilt
     * whenever `cliBridge` settings change, and the board belongs to the runtime.
     * A captured board would keep answering for a runtime nothing drives any
     * more. Switched off means `undefined`, which the route reports as an empty
     * document.
     */
    cliLive: () => cliRuntime?.live.snapshot() ?? { turns: [], serverTime: Date.now() },
    /**
     * 设备头设置（「虚拟值 / 真实值」+ 每账号覆盖参数）。
     *
     * uid 由 Host 自己解：卡片只认识 accountId，而构头时需要 uid——让浏览器把
     * uid 传上来，等于把账号在网关侧的身份交给前端，没有必要。
     *
     * 每次响应都带一份 `derived`：**留空时真正会发出去的那一对 id**。弹窗把它
     * 显示在空输入框下面，于是"自动派生"不再是句承诺，而是一个能核对的值。
     * 派生用 uid（与 `deviceHeaders()` 同一份输入），所以界面上的值等于线上的值。
     */
    deviceSettings: {
      read: async () => withDerived(await readDeviceSettings()),
      setMode: async mode => withDerived(await setDeviceMode(mode)),
      saveAccount: async (accountId, values) => {
        for (const region of REGION_KEYS) {
          const credential = await stacks[region].store.credentialFor(accountId)
          if (credential !== undefined) {
            return withDerived(await saveDeviceProfile(accountId, { ...values, uid: credential.uid }))
          }
        }
        // 账号在本机已经不存在（凭据被清掉、或来自另一个 profile）：值照写，
        // 只是没有 uid，于是它不会影响任何请求，直到该账号重新出现并再次保存。
        return withDerived(await saveDeviceProfile(accountId, values))
      },
      saveSdk: values => saveDeviceSdkSettings(values),
    },
    /**
     * 真实设备参数（本机安装的桌面端 SDK）的状态与取值。
     *
     * `mode` 现读而不是缓存：切档与面板是同一屏的两件事，中间隔一次 5 秒缓存就会
     * 出现"已经切到真实值、面板还说虚拟值"的一屏。
     */
    deviceSdk: createDeviceSdkPort({
      sdk: turing,
      mode: async () => (await readDeviceSettings()).mode,
      /**
       * 总开关走插件配置（`Config.deviceSdkEnabled`），与 SDK 句柄的 `enabled`
       * getter 共用同一个 `deviceSdkEnabled()`，因此勾选框与 probe 不会分叉。
       */
      enabled: {
        read: async () => deviceSdkEnabled(),
        write: writeDeviceSdkEnabled,
      },
    }),
    /**
     * Why each of the region's accounts cannot serve right now, for the composer
     * panel's table.
     *
     * Runs the SAME `exclusionOf` the pool ranks by, against every account the
     * region knows — not only pool members. Deriving it any other way (a second
     * expiry comparison, or `probe.outcome` read raw) would let the panel call an
     * account rate-limited while the pool has already moved past its cooldown.
     */
    accountExclusions: async (region: WorkBuddyRegion) => {
      const probes = await readPoolProbes(region)
      const nowMs = Date.now()
      const out: Record<string, WorkBuddyWebPoolExclusion> = {}
      for (const [accountId, probe] of Object.entries(probes)) {
        const excludedBy = exclusionOf(probe, nowMs)
        if (excludedBy !== undefined) out[accountId] = excludedBy
      }
      return out
    },
    displayModels: region => displayModels(current(), region),
    /**
     * The LIVE load levels, read beside the saved roster the card lists.
     *
     * The card's model list is the SAVED `lastCatalog`, which carries no load
     * level (load is not persisted — `src/busy.ts`), so the badge has to come
     * from the live roster instead.
     */
    busyLevels: region => liveBusyLevels(region),
    enabledModelIds: region => regionStateOf(current(), region).enabledModelIds ?? [],
    // #168: the card's model editor must show the SAME image ticks the runtime
    // is stamping. Reporting the raw stored array while the runtime seeds from
    // the vendor table would show an unticked box on a model that is actually
    // served as multimodal — and the next save would then write that mismatch
    // down as a decision.
    imageModelIds: region => [...effectiveImageIds(
      regionStateOf(current(), region),
      displayModels(current(), region),
    )],
    offModelIds: region => savedOffModelIds(regionStateOf(current(), region), displayModels(current(), region)),
    contextBudgets: region => regionStateOf(current(), region).contextBudgets ?? {},
    // Issue #179: the card picks a default tier per model, and the Host answers
    // with what it will actually DISPATCH, not what the browser mirror says.
    defaultThinkingEfforts: region => regionStateOf(current(), region).defaultThinkingEfforts ?? {},
    discoverModels,
    // Issue #214: the refresh route's answer is only useful if it is REMEMBERED.
    // Without this the press repainted the response and nothing else, so the
    // card — which renders `displayModels()` — kept showing the saved
    // directory's prices while the reply carried the upstream's.
    persistModels: persistRefreshedModels,
    /**
     * This region's first-sighting readout, the data behind the composer pill's
     * "· N 新模型" segment.
     *
     * READ-ONLY here: only the reconciler's `note` writes first-sighting
     * history, so no amount of polling by the pill or the card can change who
     * counts as new — the one property that keeps the marker honest.
     */
    rosterSeen: region => stacks[region].rosterSeen.readout(),
    mediaModels: readMediaModels,
    regionEnabled: region => regionEnabled(current(), region),
    /**
     * The region's committed sidebar-credit flag, read from the same config the
     * card writes. Exposed on the Host's answer because the browser settings
     * mirror goes stale for this namespace on the affected 0.1.7 deployments,
     * which made the switch look unable to turn the line off ("关闭不了").
     */
    showCreditsInMainUi: region => regionStateOf(current(), region).showCreditsInMainUi !== false,
    /**
     * The region's committed new-model-segment flag, read from the same config
     * the card writes.
     *
     * `=== true`, the opposite reading to the line above and for the same reason
     * `imageToolEnabled` uses it: this one is opt-IN, so a missing or unreadable
     * value must mean "do not show it", never "assume the user wanted it".
     */
    showNewModelsInMainUi: region => regionStateOf(current(), region).showNewModelsInMainUi === true,
    /**
     * Whether the model may call the image tool here. Read from the committed
     * value like the flag above, and deliberately `=== true`: an absent setting
     * is NOT consent to let the model spend.
     */
    imageToolEnabled: region => regionStateOf(current(), region).imageToolEnabled === true,
    /** Whether the model may call the video tool here. Same opt-IN read as above. */
    videoToolEnabled: region => regionStateOf(current(), region).videoToolEnabled === true,
    /**
     * The video model pinned per tag in this region, for the card's per-mode
     * picker. Read from the committed value like the switches above: the picker
     * must render what the TOOL will actually use, not what the browser mirror
     * happens to hold.
     */
    preferredVideoModels: region => regionStateOf(current(), region).preferredVideoModels ?? {},
    /**
     * The text-to-image model chosen per region, for the card's picker (issue
     * #241). Read from the committed value like the switches above, so the
     * picker shows what the TOOL will actually use rather than the browser's
     * stale mirror of this namespace.
     */
    preferredImageModel: region => regionStateOf(current(), region).preferredImageModel ?? '',
    /**
     * Whether the optional CodeBuddy CLI route is mounted (`codebuddy_ask` tool
     * + `/codebuddy` command).
     *
     * GLOBAL, so it takes no region. `=== true` like `imageToolEnabled`, not
     * `!== false`: switching this on lets a child process edit files and spend
     * CodeBuddy quota, so an absent value must read as OFF rather than as
     * consent. `cliBridge` is a volatile field, hence the unwrap.
     */
    cliBridgeEnabled: () => unwrapVolatile(current().cliBridge)?.enabled === true,
    /**
     * Whether the optional DSH sidebar panel is switched on (PR #188).
     *
     * GLOBAL, so it takes no region. `=== true` like `cliBridgeEnabled`, not
     * `!== false`: the row claims a `sidebar.panellist` seat and a `main` page
     * that every installed bundle shares, so an absent value must read as "not
     * asked for" rather than as consent. Volatile, hence the unwrap.
     */
    sidebarPanelEnabled: () => unwrapVolatile(current().sidebarPanel) === true,
    /**
     * The card's refresh cadence, read live so a change takes effect on the
     * next poll rather than on a plugin reload.
     */
    pollIntervalMs: () => pollIntervalOf(current()),
    /**
     * The model / reasoning effort the optional CodeBuddy CLI route runs on.
     *
     * `cliBridge` is volatile, hence the unwrap; absent keys read as `''` —
     * "the CLI's own default" — because an empty pin is a COMMITTED value the
     * card's pickers can render, not a missing one.
     */
    cliBridgeModel: () => unwrapVolatile(current().cliBridge)?.model ?? '',
    cliBridgeEffort: () => unwrapVolatile(current().cliBridge)?.effort ?? '',
    cliBridgeRegionOrder: () => unwrapVolatile(current().cliBridge)?.regionOrder ?? '',
    /**
     * Whether the request path drops foreign thinking blocks (issue #147), read
     * live so the card's switch reflects the value the NEXT request will use
     * rather than the one captured at mount.
     */
    dropForeignThinking: () => unwrapVolatile(current().dropForeignThinking) === true,
    dropAllThinking: () => unwrapVolatile(current().dropAllThinking) === true,
    /**
     * What the last request had to drop, so the card can explain a turn that
     * arrived looking like working notes instead of leaving the user to conclude
     * the model broke. `undefined` until a request actually removes something —
     * an empty report would render as a permanent warning.
     */
    latestForeignThinking: () => latestForeignThinking,
    /**
     * WHERE the readout sits, resolved here rather than read from the browser
     * settings mirror, for the same measured reason as the flag above: on the
     * affected 0.1.7 deployments that mirror never picks up this plugin's
     * writes, and a control reading it would keep showing the old seat.
     */
    creditPosition: region => creditPositionOf(current(), region),
    /**
     * One minimal request per named model, through the region's own credential.
     *
     * Resolved here rather than in the route so the browser half never touches a
     * token: the route passes only model ids and receives only outcomes.
     *
     * `quotaRefreshAtMs` is the region's nearest monthly refresh point, read from
     * the SAME credit answer the card displays. It is recorded beside an
     * out-of-credit result as upstream EVIDENCE, not as a recovery deadline:
     * check-in and top-ups can replenish credits long before it, so the views
     * name the replenishment action instead of rendering a countdown, and the
     * pool does not release the account when the moment passes.
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
    /**
     * Output-speed measurement (issue #92), region-scoped like every other
     * spending path.
     *
     * Deliberately NOT routed through the probe's failover machinery: a speed
     * number describes the MODEL, and having the pool silently serve the run
     * from a different account would attach one account's rate limit (6004) to
     * another's measurement. The selected credential runs all three samples, so
     * "it failed" means this account could not measure it, which is the honest
     * answer.
     */
    async measureTps(region, modelIds, options) {
      let credential
      try {
        credential = await stacks[region].store.resolve()
      } catch (error: unknown) {
        // A missing credential is per-model, actionable information: report it
        // rather than failing the route, so the card can show WHY.
        const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
        return modelIds.map(modelId => ({
          modelId,
          outcome: 'credential-rejected' as const,
          samples: 0,
          message,
        }))
      }
      const results: WorkBuddyWebTpsResult[] = []
      for (const modelId of modelIds) {
        const sample = await measureTps({
          client,
          credential,
          modelId,
          ...options?.signal === undefined ? {} : { signal: options.signal },
        })
        results.push({
          modelId: sample.modelId,
          outcome: sample.tokensPerSecond === undefined ? 'failed' as const : 'ok' as const,
          ...sample.tokensPerSecond === undefined ? {} : { tokensPerSecond: sample.tokensPerSecond },
          ...sample.timeToFirstTokenMs === undefined ? {} : { timeToFirstTokenMs: sample.timeToFirstTokenMs },
          ...sample.outputTokens === undefined ? {} : { outputTokens: sample.outputTokens },
          samples: sample.samples,
          ...sample.reason === undefined ? {} : { reason: sample.reason },
          ...sample.credit === undefined ? {} : { credit: sample.credit },
        })
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
       * The first-paint member list (issue #77): local state only.
       *
       * This is `localPoolMembers`, i.e. the SAME list the request path already
       * consults — saved members, their last credit snapshot (if it is still
       * fresh), and their last probe result. No upstream call, so the card's
       * account table can paint before any billing endpoint answers; live
       * figures arrive with the full document a moment later.
       *
       * A member whose credit snapshot has expired simply carries no `credits`,
       * which the card renders as "—" rather than as zero.
       */
      localMembers: region => localPoolMembers(region),
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
       * Last measured display name per saved member id (issue #60).
       *
       * Answers the one question the card cannot answer itself: a saved member
       * whose sign-in is gone has no row in the roster, so the name the pool
       * once saw is the only thing that can identify it. Read from the runtime
       * probe store — no upstream call, and no credential touched.
       *
       * Best-effort, and deliberately NOT filtered to ghosts here: the route
       * knows which ids are unlisted (it built the roster) and names only
       * those, so this stays a plain lookup with one meaning.
       */
      memberNames: async (region: WorkBuddyRegion) => {
        const probes = await readPoolProbes(region)
        const names: Record<string, string> = {}
        for (const [accountId, probe] of Object.entries(probes)) {
          if (probe.accountName === undefined || probe.accountName === '') continue
          names[accountId] = probe.accountName
        }
        return names
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
          .map(account => ({
            id: account.id,
            accountName: account.accountName,
            ...account.enterprise === true ? { enterprise: true } : {},
          }))
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
        if (region !== 'cn' || !poolPreferencesOf(current(), region).enabled) return {}
        const store = stacks[region].store
        const accounts = await store.accounts()
        const now = Date.now()
        const entries = await Promise.all(accounts.map(async account => {
          // Enterprise accounts do not support check-in; avoid that request.
          if (account.enterprise === true) return undefined
          // Serve from the cache while it is fresh. The card uses a configurable
          // polling interval, but "did this account check in today" only changes when a
          // check-in runs or the day rolls over — so re-reading it on every
          // poll meant ~14,400 requests/day for a 10-account pool. A check-in
          // this plugin performs invalidates its own entry (see `checkin`).
          //
          // "Fresh" includes the local day (issue #232): the TTL alone would
          // serve yesterday's reading across midnight, and the poll would then
          // report an account as done on a day nobody claimed it.
          const cached = checkinStateCache[region]?.[account.id]
          if (cached !== undefined && checkinReadingFresh(cached.atMs, now, CHECKIN_CACHE_MS)) {
            return [account.id, cached.checkedIn] as const
          }
          const credential = await store.credentialFor(account.id).catch(() => undefined)
          if (credential === undefined) return undefined
          const status = await client.fetchCheckinStatus(credential).catch(() => undefined)
          // Personal accounts can also have no active check-in campaign.
          if (status === undefined || !status.active) return undefined
          checkinStateCache[region] = {
            ...checkinStateCache[region],
            [account.id]: { checkedIn: status.todayCheckedIn, atMs: now },
          }
          return [account.id, status.todayCheckedIn] as const
        }))
        return Object.fromEntries(entries.filter(entry => entry !== undefined))
      },
      /**
       * Today's check-in state from the cells already measured this process.
       *
       * The first-paint counterpart (issue #77) of `checkedInToday`: it reads
       * `checkinStateCache` and nothing else, so painting the table never waits
       * on one request per account. An unmeasured account is absent, which the
       * card already renders as unknown rather than as "not checked in".
       */
      cachedCheckedInToday(region) {
        // Same guard as the full read: with the pool off there is no table to
        // fill, so nothing is reported.
        if (!poolPreferencesOf(current(), region).enabled) return {}
        const now = Date.now()
        const state = checkinStateCache[region] ?? {}
        const cached: Record<string, boolean> = {}
        for (const [accountId, entry] of Object.entries(state)) {
          // Day-bounded as well as TTL-bounded (issue #232): a reading taken
          // yesterday answers a different question than today's column asks.
          if (!checkinReadingFresh(entry.atMs, now, CHECKIN_CACHE_MS)) continue
          cached[accountId] = entry.checkedIn
        }
        return cached
      },
      /**
       * Claimable promotional benefits per account (issue #79).
       *
       * Only campaigns the account can STILL claim are returned — a claimed or
       * lapsed one is absent, which is what the issue asked for. Absent means
       * the card shows no benefit line at all.
       *
       * Two status reads per account, so it is cached for `BENEFIT_CACHE_MS` and
       * skipped entirely when the pool is off (same reasoning as
       * `checkedInToday`: no table, no request).
       */
      async benefits(region) {
        if (!poolPreferencesOf(current(), region).enabled) return {}
        const store = stacks[region].store
        const accounts = await store.accounts()
        const now = Date.now()
        const entries = await Promise.all(accounts.map(async account => {
          const cached = benefitStateCache[region]?.[account.id]
          if (cached !== undefined && now - cached.atMs < BENEFIT_CACHE_MS) {
            return [account.id, cached.views] as const
          }
          const credential = await store.credentialFor(account.id).catch(() => undefined)
          if (credential === undefined) return undefined
          // Upstream's read endpoints advertise campaigns for enterprise/education
          // members while every WRITE answers `10001 企业账号不支持该操作`. The UI
          // must not present a button that is certain to fail (issue #129), so
          // these accounts simply have no claimable benefits.
          if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') return [account.id, []] as const
          const read = await client.fetchBenefits(credential).catch(() => undefined)
          // A failed read is UNKNOWN, not "no benefits": caching an empty answer
          // would make one bad request look like a fully-claimed pool for half
          // an hour.
          if (read === undefined) return undefined
          const views = claimableBenefits(read, now)
          benefitStateCache[region] = {
            ...benefitStateCache[region],
            [account.id]: { views, atMs: now },
          }
          return [account.id, views] as const
        }))
        return Object.fromEntries(entries.filter(entry => entry !== undefined))
      },
      /**
       * Claimable benefits from the readings already taken this process.
       *
       * The first-paint counterpart of `benefits`, mirroring
       * `cachedCheckedInToday`: no request, so painting never blocks on two
       * calls per account. An unmeasured account is absent, not empty.
       */
      cachedBenefits(region) {
        if (!poolPreferencesOf(current(), region).enabled) return {}
        const now = Date.now()
        const state = benefitStateCache[region] ?? {}
        const cached: Record<string, readonly WorkBuddyBenefitView[]> = {}
        for (const [accountId, entry] of Object.entries(state)) {
          if (now - entry.atMs >= BENEFIT_CACHE_MS) continue
          cached[accountId] = entry.views
        }
        return cached
      },
      /**
       * Drop one account's cached benefit reading (issue #79).
       *
       * The claim route writes upstream itself, so this cache is the ONLY thing
       * that can keep answering "claimable" after a successful claim — and it was
       * never invalidated: the credits went up, the 领取 pill stayed for up to 30
       * minutes, and the claim looked like it had silently failed. That is the
       * exact symptom the user reported. `checkin` already deletes its entries
       * after a batch; this is the same rule for the claim.
       *
       * Deleting (rather than overwriting with the post-claim read) keeps the
       * ownership where it belongs: the route already made the authoritative
       * re-read, and the next `benefits()` refills this from live data.
       */
      invalidateBenefit(region, accountId) {
        const cached = benefitStateCache[region]
        if (cached !== undefined) delete cached[accountId]
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
      /**
       * What the background check-in has settled today (issue #191).
       *
       * Answers from the runner's in-memory state, which is the same object the
       * tick updates — so the card never has to guess which accounts a previous
       * attempt already handled. `undefined` when the switch is off or nothing
       * has run, which the card renders as "no status line" rather than "0 of N".
       */
      autoCheckinToday: region => {
        if (!autoCheckinEnabled(region)) return undefined
        const state = autoCheckinState[region]
        if (state === undefined) return undefined
        // The denominator came with the state, so this runs on the card's poll
        // without enumerating the credential store (see `scopeSize`).
        //
        // Day-checked (issue #232): a finished day is not rewritten until the
        // next tick, which can be up to `AUTO_CHECKIN_IDLE_MS` after midnight —
        // reporting yesterday's progress as today's is how the card came to say
        // 「今日：N 个全部已签」 while every row read 未签到.
        return todaySummary(state, Date.now())
      },
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
        if (rows.some(row => row.status !== 'failed')) {
          await poolMembersOf(region)
          await applyPoolSelection(region)
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
      /**
       * Test ONE account against the region's target model.
       *
       * The per-row button's Host half. Reuses the batch's probe dependency
       * (same client, same probe size, same quota-refresh input) so a row
       * result and a batch result are the SAME measurement — only the
       * persistence is scoped to one id instead of every member.
       *
       * Returns undefined when the region cannot name a target model (the
       * same refusal the batch route reports as 409) — the card says so
       * rather than pretending a test ran.
       */
      testOne: async (region, accountId) => {
        const target = regionTargetModel(region)
        if (target === undefined) return undefined
        const store = stacks[region].store
        const credential = await store.credentialFor(accountId).catch(() => undefined)
        if (credential === undefined) {
          return {
            accountId,
            accountName: '',
            result: {
              modelId: target,
              outcome: 'credential-rejected' as const,
              status: 0,
              message: 'no stored credential for this account',
            },
          }
        }
        const accounts = await store.accounts().catch(() => [])
        const accountName = accounts.find(account => account.id === accountId)?.accountName ?? ''
        const deps = poolRunnerDeps(region)
        const result = await deps.probe(credential, target)
        // Persist exactly like the batch does, scoped to the one id: the next
        // ranking, failover decision, and table render all read the same file.
        await writePoolProbes(region, probeUpdatesOf([{ accountId, accountName, result }]))
        return { accountId, accountName, result }
      },
      /**
       * Forget ONE account's plugin-stored credential (the vault entry; the
       * desktop app's files are never touched). The card rescans afterwards,
       * so the row disappears the moment the write lands.
       *
       * AND DROP THE REGION'S PERSISTED PIN, when this was the pinned account
       * (issue #155's second report). `removeAccount` forgets the selection in
       * memory only, so the next `applySelection` — a restart, or any settings
       * save — re-reads the dead id out of `accounts.<region>`, re-pins it, and
       * the tab returns to「已保存的账号在本机已不存在」with the card's advice
       * pointing at a list that state does not render. The clear is decided from
       * the settings document rather than from the store, and is scoped to the
       * one region that pinned this account: an unrelated removal must not move
       * anybody off the account they chose.
       *
       * FAIL-SOFT, like the field repair above: the credential is already gone by
       * the time this runs, so a settings write that cannot land must not be
       * reported as a failed removal — that would tell the user the account is
       * still there when it is not.
       */
      removeOne: async (region, accountId) => {
        const removed = await stacks[region].store.removeAccount(accountId)
        try {
          await clearRegionAccountSelection(
            hostSettings(),
            settingsNs,
            region,
            accountId,
            // Read the flat field as it is PERSISTED, not as the store holds it:
            // the pre-split profile pins through this key while `accounts` is
            // empty, and `selectAccountFor` falls back to it per region.
            unwrapVolatile(current().accountId),
            legacyAccountRegion,
          )
        } catch (error: unknown) {
          ctx.logger.warn(
            'dsh-connect-workbuddy: the account was removed, but the region could not be un-pinned from settings; the selection may reappear as orphaned after a restart',
            error,
          )
        }
        return removed
      },
    },
    /**
     * OAuth QR sign-in for this card. The session lives in `src/oauth.ts`
     * (in-process, keyed by loginId); the Host's only extra duty is
     * persisting the finished credential into the region's vault — the same
     * store the request path reads, so the account is selectable the moment
     * the poll answers.
     */
    oauth: {
      async start(region) {
        return oauthStart(region)
      },
      async poll(region, loginId) {
        const answer = await oauthPoll(loginId, region)
        if (!answer.done) return answer
        if ('error' in answer) return answer
        const store = stacks[region].store
        const accountId = await store.addOAuthAccount({
          accessToken: answer.account.accessToken,
          refreshToken: answer.account.refreshToken,
          expiresAtMs: answer.account.expiresAtMs,
          ...answer.account.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: answer.account.refreshExpiresAtMs },
          domain: answer.account.domain,
          uid: answer.account.uid,
          ...answer.account.nickname === undefined ? {} : { nickname: answer.account.nickname },
          ...answer.account.uin === undefined ? {} : { uin: answer.account.uin },
          ...answer.account.enterpriseId === undefined ? {} : { enterpriseId: answer.account.enterpriseId },
        }).catch((error: unknown) => {
          throw new Error(
            'the account was signed in but could not be saved: '
            + (error instanceof Error ? error.message : String(error)),
          )
        })
        const accounts = await store.accounts().catch(() => [])
        const saved = accounts.find(account => account.id === accountId)
        return {
          done: true,
          accountId,
          accountName: saved?.accountName ?? answer.account.nickname ?? '',
        }
      },
    },
    /**
     * Batch credential export / import, in the transfer file format the
     * sibling credential managers share. The Host owns every byte of the
     * vault; the route only ferries parsed answers.
     */
    transfer: {
      async exportAccounts(region, accountIds): Promise<WorkBuddyTransferExportAnswer> {
        const store = stacks[region].store
        const accounts = await store.accounts().catch(() => [])
        const wanted = new Set(accountIds)
        const records: WorkBuddyTransferRecord[] = []
        for (const account of accounts) {
          if (!wanted.has(account.id)) continue
          const credential = await store.credentialFor(account.id).catch(() => undefined)
          if (credential === undefined) continue
          records.push(transferRecordOf(credential, {
            auth: {
              accessToken: credential.accessToken,
              refreshToken: credential.refreshToken,
              expiresAt: credential.expiresAtMs > 0 ? Math.floor(credential.expiresAtMs / 1000) : 0,
              ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAt: Math.floor(credential.refreshExpiresAtMs / 1000) },
              ...credential.lastRefreshAtMs === undefined ? {} : { lastRefreshTime: Math.floor(credential.lastRefreshAtMs / 1000) },
              domain: credential.domain,
            },
            account: {
              uid: credential.uid,
              ...credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId },
              ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
              ...credential.uin === undefined ? {} : { uin: credential.uin },
            },
          }))
        }
        return { accounts: records }
      },
      async previewImport(region, text): Promise<WorkBuddyTransferPreview> {
        void region
        return previewTransferFile(text)
      },
      async importAccounts(region, text, indexes): Promise<WorkBuddyTransferImportAnswer> {
        // Parse FIRST so a malformed file fails the request before any vault
        // write, with the parse error as the message.
        const records = parseTransferFile(text)
        const { changes, imported, skipped } = mergeTransferRecords(
          records,
          indexes,
          region,
          domain => knownRegionOf(domain),
        )
        const store = stacks[region].store
        for (const [id, credential] of changes) {
          await store.addOAuthAccount(credential).catch(error => {
            throw new Error(
              'imported account ' + id + ' could not be stored: '
              + (error instanceof Error ? error.message : String(error)),
            )
          })
        }
        return { imported, skipped }
      },
    },
    })
  })

  /**
   * The region's nearest monthly quota refresh, or undefined when unknown.
   *
   * The monthly resource (`CapacityType 4`) is the one package that never
   * expires and resets on a cycle, so its `refreshAtMs` is the package's own
   * schedule. It is handed to a probe as EVIDENCE to store beside an
   * out-of-credit outcome — never as the moment the account becomes usable
   * again, because check-in and top-ups can land first. A failure to read it is
   * not an error: a probe that records no refresh point is still a useful probe.
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
    // The saved manual order, so failover honors the user's preference order
    // (issue #70's expiry guard still outranks it, inside `rankPool`).
    const order = poolPreferencesOf(current(), region).orderAccountIds
    for (const row of rankPool(await localPoolMembers(region), Date.now(), order)) {
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
   * Why the pool left a failed request with nowhere to go, in one short clause.
   *
   * Runs ONLY after a request has already failed, so it may afford work the hot
   * path cannot — but it still reads local state only (the probe store and the
   * member list), because spending a network call to explain a failure would add
   * a second delay to a request the user is already waiting on.
   *
   * It counts rather than lists. The reply is one line inside an error message,
   * and enumerating accounts there would bury the advice; the card is where a
   * per-account breakdown belongs, and it already shows one.
   *
   * Returns `undefined` when the pool is OFF or has no members — in which case
   * there is no pool story to tell, and the shim renders its own sentence
   * without one. That is a real state, not a failure: the plugin supports
   * running with no pool at all.
   */
  const explainPoolShortfall = async (region: WorkBuddyRegion): Promise<string | undefined> => {
    if (!poolPreferencesOf(current(), region).enabled) return undefined
    const members = await localPoolMembers(region)
    if (members.length === 0) return undefined
    const nowMs = Date.now()
    // The SAME verdict the ranking uses, asked the same way, so this explanation
    // cannot contradict the decision that produced the empty search.
    const excluded = members
      .map(member => ({ id: member.account.id, excludedBy: exclusionOf(member.probe, nowMs) }))
      .filter((entry): entry is { id: string, excludedBy: WorkBuddyPoolExclusion } => entry.excludedBy !== undefined)
    if (excluded.length === 0) {
      // Nothing is excluded, yet failover found no candidate: every member was
      // either already tried this request or has no resolvable credential. The
      // first is the common case and the honest one to report.
      return '池中其余账号本次请求都已尝试过'
    }
    // One clause per DISTINCT reason, with a count, so "三个账号都在冷却" reads
    // as one fact rather than three repetitions of the same sentence.
    const counts = new Map<WorkBuddyPoolExclusion, number>()
    for (const entry of excluded) counts.set(entry.excludedBy, (counts.get(entry.excludedBy) ?? 0) + 1)
    const parts = [...counts.entries()].map(([reason, count]) => `${String(count)} 个${poolExclusionClause(reason)}`)
    return `池中已无可用账号（${parts.join('、')}）`
  }

  /**
   * One exclusion reason as a short Chinese clause for
   * {@link explainPoolShortfall}.
   *
   * Separate from the card's own labels (`exclusion-text.ts` in the client half)
   * on purpose: those are standalone table cells ("被限流"), where these are
   * glued into a sentence and must read after a count ("1 个账号被限流"). Sharing
   * one string would force one of the two to read wrong.
   */
  function poolExclusionClause(reason: WorkBuddyPoolExclusion): string {
    switch (reason) {
      case 'rate-limited': return '账号被限流'
      case 'out-of-credit': return '账号积分耗尽'
      case 'model-busy': return '账号撞上模型繁忙'
      case 'credential-rejected': return '账号登录已失效'
      case 'account-restricted': return '账号被上游限制使用'
      case 'not-found': return '账号已不存在'
      case 'unusable': return '账号不可用'
      default: return '账号不可用'
    }
  }

  /**
   * The last CREDITS reading per region, so a request can rank by balance
   * without fetching one.
   *
   * Credits are the ranking's second key, and they cost an upstream call per
   * member. Normal ranking reuses the last UI/check-in snapshot and omits stale
   * balances rather than fetching all members for each chat. The separate,
   * rate-limited recovery check reads only accounts with recorded credit
   * failures; it does not refresh this whole-pool ranking snapshot.
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
   * the network. `poolMembersOf` refreshes all members on explicit UI/check-in
   * paths. Before a request, `refreshDepletedPoolCredits` separately checks only
   * recorded credit failures, at most once per minute, even with no card open.
   */
  async function localPoolMembers(region: WorkBuddyRegion): Promise<WorkBuddyPoolMember[]> {
    const accounts = await poolMemberAccounts(region)
    const probes = await readPoolProbes(region)
    const fresh = Date.now() - (creditsSnapshotAt[region] ?? 0) <= CREDITS_SNAPSHOT_MS
    const credits = fresh ? creditsSnapshot[region] : undefined
    return accounts.map(account => {
      const reading = credits?.get(account.id)
      return {
        account: {
          id: account.id,
          accountName: account.accountName,
          ...account.enterprise === true ? { enterprise: true } : {},
        },
        ...reading === undefined ? {} : { credits: reading },
        ...probes[account.id] === undefined ? {} : { probe: probes[account.id] as WorkBuddyPoolProbe },
        tokenExpiresAtMs: account.tokenExpiresAtMs,
      }
    })
  }

  /**
   * Recover depleted members without blocking requests that already have a usable
   * account. Concurrent callers share one balance read per region and minute.
   * When every member is excluded, a caller may wait for recovery; disconnecting
   * releases that caller without cancelling evidence needed by other requests.
   * Positive readings update existing ranking balances without extending the
   * lifetime of unrelated cached readings or overwriting a newer UI snapshot.
   */
  const depletedRefreshAt: Partial<Record<WorkBuddyRegion, number>> = {}
  const depletedRefreshInFlight: Partial<Record<WorkBuddyRegion, Promise<void>>> = {}
  async function refreshDepletedPoolCredits(region: WorkBuddyRegion, signal?: AbortSignal): Promise<void> {
    if (!poolPreferencesOf(current(), region).enabled || signal?.aborted) return
    const members = await localPoolMembers(region)
    if (signal?.aborted) return
    let task = depletedRefreshInFlight[region]
    if (task === undefined && Date.now() >= (depletedRefreshAt[region] ?? 0)) {
      const depleted = members.filter(member => member.probe?.outcome === 'out-of-credit')
      if (depleted.length === 0) return
      depletedRefreshAt[region] = Date.now() + 60_000
      task = (async () => {
        const readings = await Promise.all(depleted.map(async member => {
          const credential = await stacks[region].store.credentialFor(member.account.id).catch(() => undefined)
          if (credential === undefined) return undefined
          const startedAtMs = Date.now()
          const credits = await client.fetchCredits(credential).catch(() => undefined)
          return credits === undefined ? undefined : { accountId: member.account.id, startedAtMs, total: credits.total, credits }
        }))
        const completed = readings.filter(reading => reading !== undefined)
        await reconcilePoolCredits(region, completed)
        const snapshot = creditsSnapshot[region]
        if (snapshot !== undefined) {
          const updated = new Map(snapshot)
          for (const reading of completed) {
            // A later whole-pool read wins over a recovery query started earlier.
            if ((creditsSnapshotAt[region] ?? 0) <= reading.startedAtMs) updated.set(reading.accountId, reading.credits)
          }
          creditsSnapshot[region] = updated
        }
      })().catch((error: unknown) => {
        ctx.logger.warn('dsh-connect-workbuddy: pool credit recovery failed', error)
      }).finally(() => { delete depletedRefreshInFlight[region] })
      depletedRefreshInFlight[region] = task
    }
    if (task === undefined || members.some(member => exclusionOf(member.probe, Date.now()) === undefined)) return
    if (signal === undefined) return task
    // Only the wait belongs to this request; the shared read can still help
    // another request after this client disconnects. Always remove the listener.
    await new Promise<void>(resolve => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        resolve()
      }
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted) finish()
      void task.then(finish, finish)
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
   * 「将在 … 重置」 — which `cooldownOf` parses. Transient failures with no stated
   * time use the local short window; credit exhaustion requires balance evidence.
   *
   * The monthly package refresh is retained as upstream evidence, not as the
   * earliest recovery date: check-in and purchases can replenish credits sooner.
   * A later positive balance reading clears an older credit failure under the
   * store lock, without overwriting failures recorded during the query.
   *
   * The upstream's text is persisted alongside the outcome so the card can name
   * the reason. It is REDACTED first because this message is a raw upstream body:
   * without that, a failure containing a token-shaped string would write it into
   * a file on disk.
   */
  const recordAccountFailure = async (
    region: WorkBuddyRegion,
    accountId: string,
    failure: { status: number, kind: UpstreamErrorKind, message: string, modelId?: string },
  ): Promise<void> => {
    if (!poolPreferencesOf(current(), region).enabled) return
    if (failure.kind === 'client') return
    // A request that never reached an HTTP response says nothing about the
    // account: it is the transport, not the model. Persisting it would bench a
    // healthy account for POOL_UNKNOWN_COOLDOWN_MS (30 minutes), because a
    // transport failure carries no `retryAtMs` — the same defect that let one
    // probe timeout empty the pool. `status: 0` is this codebase's convention
    // for "never landed" (see `probeChat` and `chatStream`).
    if (failure.status === 0) return
    // Only accounts this pool covers. Membership is the explicit "yes, spend
    // this account's credits" tick, and a measurement steers routing.
    const members = poolPreferencesOf(current(), region).memberAccountIds
    if (members.length > 0 && !members.includes(accountId)) return
    const outcome = outcomeOfFailure(failure.status, failure.message)
    // Only for the outcome that HAS a real answer to look up. `quotaRefreshOf`
    // makes an upstream call, and a rate limit or a transport blip has no
    // refresh point to find — paying for that read would spend a request to
    // learn nothing.
    const quotaRefreshAtMs = outcome === 'out-of-credit'
      ? await stacks[region].store.credentialFor(accountId)
        .then(credential => credential === undefined ? undefined : quotaRefreshOf(region, credential))
        .catch(() => undefined)
      : undefined
    const { retryAtMs } = cooldownOf({
      outcome,
      retryAfter: null,
      nowMs: Date.now(),
      body: failure.message,
      ...quotaRefreshAtMs === undefined ? {} : { quotaRefreshAtMs },
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
        // WHICH model failed (issue #61). `6004` is account × model, so a live
        // failure on model A must not read as a statement about model B — nor
        // erase the fact that a different model once answered.
        ...failure.modelId === undefined ? {} : { modelId: failure.modelId },
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
    const winner = rankPool(await localPoolMembers(region), Date.now(), poolPreferencesOf(current(), region).orderAccountIds)
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
    const row = rankPool(await localPoolMembers(region), Date.now(), poolPreferencesOf(current(), region).orderAccountIds)
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
    const recordedProbes = await readPoolProbes(region)
    const creditReadings: { accountId: string, startedAtMs: number, total: number }[] = []
    const rows = await Promise.all(accounts.map(async account => {
      const credential = await store.credentialFor(account.id).catch(() => undefined)
      const startedAtMs = Date.now()
      const credits = credential === undefined
        ? undefined
        : await client.fetchCredits(credential).catch(() => undefined)
      if (credits !== undefined) creditReadings.push({ accountId: account.id, startedAtMs, total: credits.total })
      return {
        account: {
          id: account.id,
          accountName: account.accountName,
          ...account.enterprise === true ? { enterprise: true } : {},
        },
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
        tokenExpiresAtMs: account.tokenExpiresAtMs,
      }
    }))
    // 签到或充值后的正余额可以提前解除旧的月度等待记录；查询失败或仍为零时保留。
    const probes = creditReadings.some(reading => recordedProbes[reading.accountId]?.outcome === 'out-of-credit')
      ? await reconcilePoolCredits(region, creditReadings)
      : recordedProbes
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
    return rows.map(row => ({
      ...row,
      ...probes[row.account.id] === undefined ? {} : { probe: probes[row.account.id] as WorkBuddyPoolProbe },
    }))
  }

  /**
   * The model a per-row test would use right now: the SAME resolution the
   * batch route performs (`resolveTargetModel` over the region's displayed
   * catalog and the saved preference — including a per-account override,
   * issue #61), so a row test and a batch test never measure different models.
   * Undefined mirrors the route's 409 states.
   */
  const regionTargetModel = (region: WorkBuddyRegion): string | undefined => {
    const target = resolveTargetModel(
      displayModels(current(), region),
      poolPreferencesOf(current(), region).targetModelId,
    )
    return target.modelId
  }

  /** One region's pool preferences, with the schema's defaults applied. */
  /**
   * WHERE this region's credit readout sits (issue #62).
   *
   * A local reader rather than a schema default so a config written before the
   * setting existed reads as `composer` — the seat that was the only one, so an
   * upgrade moves nothing on screen.
   */
  const creditPositionOf = (config: Config, region: WorkBuddyRegion): WorkBuddyCreditPosition =>
    regionStateOf(config, region).creditPosition === 'stats' ? 'stats' : 'composer'

  /**
   * The card's refresh interval, coerced against the offered set.
   *
   * Coerced HERE rather than trusted from the config, for the same reason
   * `resolveProbeInputTokens` coerces its own: a hand-edited `cordis.patch.yml`
   * can carry any number, and `setInterval(…, 0)` would turn a display refresh
   * into a busy loop against the upstream. An unrecognized value falls back to
   * the default rather than to the smallest step — the safe direction for a
   * setting whose whole purpose is bounding request volume.
   */
  const pollIntervalOf = (config: Config): number => {
    const raw = unwrapVolatile(config.pollIntervalMs)
    return typeof raw === 'number' && WORKBUDDY_POLL_INTERVALS_MS.includes(raw)
      ? raw
      : WORKBUDDY_DEFAULT_POLL_INTERVAL_MS
  }

  const poolPreferencesOf = (config: Config, region: WorkBuddyRegion) => {
    const pool = regionStateOf(config, region).pool
    const probeInputTokens = pool?.probeInputTokens
    return {
      enabled: pool?.enabled === true,
      targetModelId: pool?.targetModelId ?? '',
      // Passed through as a plain copy: the config value is a live cosmokit
      // reference on the 0.1.7 line, and handing that to a route would let a
      // settings mutation change what a running request resolves against.
      // Passed through RAW (not coerced here): `resolveProbeInputTokens` owns
      // that decision and is the only place that knows the offered set. Coercing
      // in two places is how a menu and its validation drift apart.
      //
      // Spread rather than assigned, because `exactOptionalPropertyTypes` makes
      // an explicit `undefined` a different thing from an absent key — and the
      // consumers of this type rely on absence meaning "never chose".
      ...probeInputTokens === undefined ? {} : { probeInputTokens },
      memberAccountIds: pool?.memberAccountIds ?? [],
      orderAccountIds: pool?.orderAccountIds ?? [],
      // `=== true`, not `?? false`: an older profile has no key at all, and an
      // absent answer must read as OFF — this switch authorises a real WRITE.
      autoCheckin: pool?.autoCheckin === true,
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
      // Enterprise members have no consumer check-in (issue #124); the runner
      // skips them instead of spending a request on a refusal it can predict.
      ...account.enterprise === true ? { enterprise: true } : {},
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

  /**
   * The automatic daily check-in (issue #191).
   *
   * A single timer per region, armed only when the user ticks the switch. The
   * rules live in `src/auto-checkin.ts` (pure) and the memory in
   * `src/auto-checkin-store.ts`; this block owns only the two things those
   * modules deliberately do not: a real clock and a real batch call.
   *
   * ## Why a re-arming one-shot instead of `setInterval`
   *
   * The interval is not constant: a failure walks a widening backoff, a finished
   * day idles, and a day rollover resets everything. `setInterval` can only
   * express a fixed period, so the delay is computed per tick and the timer is
   * re-armed from the tick's own `finally`. The alternative — a 30-minute
   * `setInterval` plus "is it due?" inside — would sleep past the short first
   * retries (30 s, 60 s) and make a transient fault look like a 30-minute outage.
   *
   * ## Why the timer never stops
   *
   * Even when the day is finished the timer re-arms at {@link AUTO_CHECKIN_IDLE_MS}.
   * A timer that stops after its first successful day cannot notice the next
   * local midnight, so the feature would silently work exactly once — the
   * failure mode this whole design exists to avoid. The idle tick costs no
   * request: `isDue` answers "nothing pending" before any I/O.
   *
   * ## Why it is safe to run alongside a manual press
   *
   * `checkinAllAccounts` reads status first and reports `already` WITHOUT a
   * claim, so two overlapping runs cannot double-claim. The batch is also
   * serial, so the worst case is one redundant status request per account.
   */
  const autoCheckinTimers: Partial<Record<WorkBuddyRegion, ReturnType<typeof setTimeout>>> = {}
  /** In-memory mirror of the on-disk state, so a tick does not re-read the file. */
  const autoCheckinState: Partial<Record<WorkBuddyRegion, AutoCheckinState>> = {}
  /** Guards against a second tick landing while one is still running. */
  const autoCheckinRunning: Partial<Record<WorkBuddyRegion, boolean>> = {}

  /** Whether the user has asked for the background check-in on this region. */
  function autoCheckinEnabled(region: WorkBuddyRegion): boolean {
    if (!autoCheckinRegions().includes(region)) return false
    return poolPreferencesOf(current(), region).autoCheckin === true
  }

  /**
   * One tick: decide, run, fold, persist, re-arm.
   *
   * Deliberately never throws — a background feature that can take down `apply`
   * (or a later tick) over a disk error would be worse than not having it.
   */
  async function autoCheckinTick(region: WorkBuddyRegion): Promise<void> {
    if (autoCheckinRunning[region] === true) return
    autoCheckinRunning[region] = true
    try {
      // Read the switch EVERY tick, not once at `apply`: turning it off must
      // stop the next tick, and the settings object is live.
      if (!autoCheckinEnabled(region)) return
      const nowMs = Date.now()
      const today = localDayKey(nowMs)
      const stored = autoCheckinState[region] ?? await readAutoCheckinState(region)
      // A new local day resets everything. `day` is the only field that decides
      // this, so a clock change (a laptop crossing a timezone) simply starts a
      // fresh day rather than trusting a stale `doneAccountIds`.
      const state = stored === undefined || stored.day !== today
        ? emptyAutoCheckinState(today)
        : stored
      autoCheckinState[region] = state
      const targets = pendingTargets(await poolTargets(region), state)
      if (!isDue(state, targets.length, nowMs)) {
        // Nothing owed right now. Re-arm and do NO I/O — this is the branch that
        // makes an idle day cost nothing.
        scheduleAutoCheckin(region, AUTO_CHECKIN_IDLE_MS)
        return
      }
      const rows = await checkinAllAccounts(targets, poolRunnerDeps(region))
      // Drop the cached readings for accounts this batch touched, exactly as the
      // manual action does, so the card's column reflects the result at once.
      for (const row of rows) {
        if (row.status === 'failed') continue
        const cached = checkinStateCache[region]
        if (cached !== undefined) delete cached[row.accountId]
      }
      // Refresh balance evidence and selection immediately after check-in.
      if (rows.some(row => row.status !== 'failed')) {
        await poolMembersOf(region)
        await applyPoolSelection(region)
      }
      // `scopeSize` is the count this attempt was measured against: pending
      // targets PLUS whatever the day already settled, which is the honest
      // denominator for "N of M" even after a membership edit.
      const folded = foldAttempt(state, rows, nowMs, targets.length + state.doneAccountIds.length)
      autoCheckinState[region] = folded
      await writeAutoCheckinState(region, folded)
      const pending = pendingTargets(await poolTargets(region), folded).length
      scheduleAutoCheckin(region, nextDelayMs(folded, pending) ?? AUTO_CHECKIN_IDLE_MS)
    } catch (error: unknown) {
      // A throw here is OUR fault (a store read, a pool enumeration), not the
      // upstream's. Log it and re-arm on the slow clock so one bad tick cannot
      // stop the feature for the rest of the day.
      ctx.logger.warn(`dsh-connect-workbuddy: auto check-in tick failed (${region})`, error)
      scheduleAutoCheckin(region, AUTO_CHECKIN_IDLE_MS)
    } finally {
      autoCheckinRunning[region] = false
    }
  }

  /** Arm the next tick, replacing any pending one. */
  function scheduleAutoCheckin(region: WorkBuddyRegion, delayMs: number): void {
    const existing = autoCheckinTimers[region]
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => { void autoCheckinTick(region) }, delayMs)
    // A pending check-in must not hold the host process open: this is a
    // convenience, and a host that is shutting down should not wait 30 minutes
    // for it. (Tests' fake timers have no `unref`.)
    timer.unref?.()
    autoCheckinTimers[region] = timer
  }

  /**
   * Arm or disarm every region to match the saved switches.
   *
   * Called once at `apply` and again on every settings change, so flipping the
   * switch takes effect without a restart. Disarming CLEARS the timer rather
   * than leaving it to notice: an off switch must stop the work immediately, not
   * at the next tick.
   */
  function syncAutoCheckin(): void {
    for (const region of autoCheckinRegions()) {
      if (autoCheckinEnabled(region)) {
        if (autoCheckinTimers[region] === undefined) scheduleAutoCheckin(region, 0)
        continue
      }
      const timer = autoCheckinTimers[region]
      if (timer !== undefined) {
        clearTimeout(timer)
        delete autoCheckinTimers[region]
      }
    }
  }

  /** Stop every timer; called on unload. */
  function stopAutoCheckin(): void {
    for (const region of autoCheckinRegions()) {
      const timer = autoCheckinTimers[region]
      if (timer !== undefined) clearTimeout(timer)
      delete autoCheckinTimers[region]
    }
  }

  syncAutoCheckin()
  ctx.effect(() => () => { stopAutoCheckin() })

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
    /**
     * 写一个设置命名空间下的字段——卡片上那个 SDK 总开关用的就是它。
     *
     * 只在 0.1.7 起存在（`tests/settings-integration.spec.ts` 也是这么用的），
     * 所以这里是可选：老宿主上卡片会退化成只读（开关置灰），而不是让整个面板
     * 抛出。
     */
    update?: (ns: string, patch: Record<string, unknown>) => Promise<unknown>
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

  /**
   * The one settings WRITE the card is allowed to make: the SDK master switch.
   *
   * Resolved lazily (not captured at mount) because `settings` is an optional
   * service and the card may ask before that service is present — a captured
   * `undefined` would make the switch permanently read-only on that host.
   * Returns `false` rather than throwing when the host has no `update`: the
   * panel renders the same switch either way, and a thrown error there would
   * surface as "saving failed" for a capability the host simply lacks.
   *
   * ⚠️ The namespace MUST be `settingsNs` — the Loader entry id the host
   * actually serves — never the declared `WORKBUDDY_SETTINGS_NS` fallback. The
   * settings service resolves an entry by EXACT id
   * (`entries().find(row => row.options.id === ns)`) and throws
   * `No configurable plugin entry "workbuddy"` for a name it does not serve.
   * Every other write path here already threads `settingsNs`
   * (`writeRegionCatalog`, `healRegionsField`, the `__save` route); this one
   * shipped with the bare constant, so on the live Desktop host — whose entry is
   * `include:dsh-connect-workbuddy` — the switch answered HTTP 500 and could
   * never be turned on.
   */
  const writeDeviceSdkEnabled = async (enabled: boolean): Promise<boolean> => {
    const host = ctx.get('settings') as unknown as SettingsShapes | undefined
    if (host?.update === undefined) return false
    await host.update(settingsNs, { deviceSdkEnabled: enabled })
    return true
  }

  // 0.1.7 hands volatile values back as live references and announces each
  // write on this event, so the card's selections are re-read after one. The
  // event does not exist on 0.1.5, which never emits it.
  ;(ctx as unknown as { on(name: string, listener: () => void): unknown })
    .on('loader/volatile-update', () => {
      applySelection(current())
      // The auto check-in switch lives in the same volatile region slot, so this
      // is also where turning it on or off takes effect — without a restart.
      syncAutoCheckin()
      // 总开关同样是 volatile：不重挂，所以预热链要在这里跟随，否则关着启动的
      // 进程打开开关后永远没有定时器（只有一次请求才偶尔取到 token）。
      syncDeviceSdk()
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
  let heartbeatWrite: Promise<WorkBuddyHostHeartbeatOwner | undefined> | undefined

  ctx.effect(() => async () => {
    stopped = true
    for (const region of REGION_KEYS) void stacks[region].shim.close()
    // A write already in progress settles before its own receipt is removed.
    // Startup failures that never wrote have no heartbeat to clear.
    const owner = await heartbeatWrite
    if (owner !== undefined) await clearHostHeartbeat(owner)
  })

  void Promise.all(REGION_KEYS.map(region => stacks[region].shim.ready))
    .then(async () => {
      if (stopped) return

      const adapters = {} as Record<WorkBuddyRegion, WorkBuddyAdapter>
      // The host services that can fold history are optional: a host without the
      // compaction bundle loaded simply has no `compaction` service, and the
      // rescue then reports "nothing folded" instead of failing a request.
      // Resolved per attempt rather than captured, because plugin load order
      // decides when each service exists.
      const hostService = <Service>(name: string): Service | undefined =>
        (ctx as unknown as { get(service: string): unknown }).get(name) as Service | undefined
      const contextRescue = createContextRescue(() => ({
        meter: hostService<RescueTokenMeter>('tokenMeter'),
        compaction: hostService<RescueCompaction>('compaction'),
        agents: hostService<RescueAgents>('agents'),
        log: (message: string, error?: unknown) => { ctx.logger.warn(message, error) },
      }))
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
            resolveContextRescue: () => contextRescue,
            /**
             * Issue #179: the per-model default tier, read LIVE for the same
             * reason as the switch below — the card saves it mid-session, and a
             * captured map would keep dispatching the old tier until a reload.
             *
             * `current()` rather than the captured `config` is what makes a save
             * take effect on the very next request; `applySelection` still runs
             * `invalidateCatalog()` on the same write, which is what re-publishes
             * the advertised `defaultEffort` to the host's model catalog.
             */
            defaultThinkingEfforts: () => regionStateOf(current(), region).defaultThinkingEfforts ?? {},
            // Read through `current()` (not the captured `config`) so the
            // switch applies to the NEXT request: the user turns it on while
            // looking at a working-notes turn, and a stale capture would make
            // that look like a broken toggle.
            dropForeignThinking: () => unwrapVolatile(current().dropForeignThinking) === true,
            dropAllThinking: () => unwrapVolatile(current().dropAllThinking) === true,
            onForeignThinking: blocks => {
              latestForeignThinking = { blocks, atMs: Date.now() }
              // NAME THE REASON THAT ACTUALLY APPLIED.
              //
              // This callback fires for all three repairs, so the message has to
              // be chosen by which one ran, not by which switches happen to be
              // off. Testing only `dropForeignThinking !== true` meant a user who
              // turned on the #213 redaction got a log line claiming a
              // cross-provider switch (#163) — a different cause with a different
              // fix, sending them to the wrong issue while the real reason (their
              // own switch) went unmentioned.
              if (unwrapVolatile(current().dropAllThinking) === true) {
                ctx.logger.warn(
                  `dsh-connect-workbuddy: dropped ${blocks.length} thinking block(s) `
                  + 'before a WorkBuddy request because the reasoning-redaction switch is on; see issue #213',
                )
              } else if (unwrapVolatile(current().dropForeignThinking) !== true) {
                // Cross-provider blocks are dropped even when the switch is off.
                // Name that edit in the log: it changes bytes the upstream would
                // otherwise count, and the user may be looking for the reason
                // their transcript lost the other provider's working notes.
                ctx.logger.warn(
                  `dsh-connect-workbuddy: dropped ${blocks.length} cross-provider thinking block(s) `
                  + 'before a WorkBuddy request (provider switch); see issue #163',
                )
              }
            },
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
          // Load levels are stamped on the RUNTIME roster only — see
          // `withBusyLevels` for why the settings draft stays free of them.
          const live = await withBusyLevels(region, discovered, signal)
          const state = regionStateOf(current(), region)
          const next = withImageSelection(
            deriveCatalog(
              live,
              new Set(state.enabledModelIds ?? []),
              state.contextBudgets ?? {},
            ),
            // #168: a discovery read is exactly the path that reveals a NEW
            // model, so an unedited region must be seeded from the table here
            // rather than from the array a previous refresh wrote.
            effectiveImageIds(state, live),
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
        const logger = ctx.logger
        heartbeatWrite = writeHostHeartbeat().catch((error: unknown) => {
          logger.error('dsh-connect-workbuddy: host heartbeat write failed', error)
          return undefined
        })
      } catch (error: unknown) {
        ctx.logger.error('dsh-connect-workbuddy: provider registration failed', error)
        return
      }

      // Seed each region's catalog from that region's selected account (or the
      // live sign-in default when nothing is selected yet).
      if (stopped) return

      // Heal the FIELD before anything depends on the other write paths: the
      // catalog repair below also cleans it, but only after a live roster lands
      // (so never for a disabled region, an offline start, or an empty answer).
      // The boot does not wait for it — the write only changes the file's shape,
      // and the read side is already healed in memory — but the repair below
      // DOES await it, because two full-field writers racing could otherwise
      // land the older directory last and undo the repair for this boot.
      const regionsFieldHealed = healRegionsFieldIfCorrupt()

      for (const region of REGION_KEYS) {
        // A switched-off region is skipped entirely: its route is withdrawn, so
        // the request would be pure waste — and skipping it is also what keeps a
        // disabled region from contributing an error to the log on every start.
        if (!regionEnabled(current(), region)) continue
        void (async () => {
          try {
            const credential = await stacks[region].store.resolve()
            const models = await withBusyLevels(
              region,
              await client.fetchModels(
                credential,
                undefined,
                regionStateOf(current(), region).enabledModelIds ?? [],
              ),
            )
            if (stopped) return
            const state = regionStateOf(current(), region)
            stacks[region].catalog.set(withEffectiveOff(
              withImageSelection(
                deriveCatalog(models, new Set(state.enabledModelIds ?? []), state.contextBudgets ?? {}),
                // #168: the startup seed is the FIFTH writer of `multimodal` and
                // the one that decides what the picker shows for a whole
                // session. Seeding it from the stored array is what froze a
                // newly-added verified-multimodal model at `['text']`.
                effectiveImageIds(state, models),
              ),
              new Set(savedOffModelIds(state, models)),
            ))
            adapters[region].invalidate()
            // Record when THIS machine first saw each id of the roster that just
            // landed — the whole "· N 新模型" story. This is the ONLY writer of
            // that history; the usage route answering the pill is read-only, so
            // a panel poll can never change "who is new".
            //
            // A failure is a warning, NOT a reason to fall back to the static
            // list (the catalog above is already set), and it is logged with its
            // reason rather than silently answered as "no new models": those are
            // two entirely different facts.
            try {
              await stacks[region].rosterSeen.note(models.map(model => model.id))
            } catch (error: unknown) {
              ctx.logger.warn(`dsh-connect-workbuddy: ${region} first-sighting history not updated`, error)
            }
            // `lastCatalog` is deliberately NOT seeded here: it belongs to the
            // user's saved selection, written only by the card's explicit save
            // (via settingsScope). Until then the card shows the live fallback
            // directory and one press of "Refresh" captures the real one.
            //
            // BUT A STALE DIRECTORY IS REPAIRED (issues #114/#115). A directory
            // written by an older build — or one that a cold start seeded with
            // the static fallback table — would keep the roster frozen at that
            // snapshot, and the card's next save would write it back. So the
            // directory is healed against the roster that just landed. The
            // repair writes only when the fingerprint differs, so a profile
            // already in agreement is never touched.
            //
            // The shape heal goes first, so the directory this describes is the
            // CLEANED one: the repair reads the field through `describe()` right
            // before writing, and awaiting here is what keeps the two writers
            // from landing out of order.
            await regionsFieldHealed
            await repairRegionCatalog(region, models)
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
