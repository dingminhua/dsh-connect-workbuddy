/**
 * Same-origin routes for the WorkBuddy plugin card: sign-in state, the
 * read-only credit summary, model refresh, and account rescan. The routes
 * answer loopback browser requests only and never carry token material.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 路由的注册方式（`ctx.webServer.register({kind:'exact', path, handler})`）、
 *     回环来源校验、`safeMessage` 的脱敏规则（JWT 与 token 查询参数截断至
 *     500 字符）、以及「积分查询失败降级为 creditsError 而非让整个文档失败」
 *     的处理，均来自该项目。
 *   单条 status 路由的原始形态来自
 *     corrinehu/dsh-workbuddy-connect（MIT）。
 * 改动：由 1 条路由扩展为 3 条（新增模型刷新与账号重扫），
 *   并加入多账号字段与按套餐聚合的积分文档；
 *   双 provider 化后每条路由再按 `?region=cn|global` 参数化，
 *   国内版与国际版两套 store 各自应答自己区域的请求。
 *
 * @module dsh-connect-workbuddy/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { preferredAccountName } from './auth.ts'
import type { WorkBuddyCredential, WorkBuddyCredentialStore } from './auth.ts'
import { isVaultAccountId } from './auth.ts'
import { isDeviceId } from './device-id.ts'
import { isDeviceMode } from './device-profile.ts'
import type { WorkBuddyDeviceSettingsPort } from './device-profile.ts'
import type { WorkBuddyDeviceSdkPort } from './turing-sdk.ts'
import { lastRefusalFor, offRefused } from './off-thinking.ts'
import { hostMatchesListener, originIsLoopback } from './loopback.ts'
import type { WorkBuddyBusyLevel } from './busy.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import { applyContextBudgets } from './catalog.ts'
import { isUnconfiguredFallbackSnapshot } from './catalog-sync.ts'
import { resolveCredentialRecovery } from './credential-recovery.ts'
// Live binding only: `Config` is referenced inside request-time function
// bodies, never at module top level, so the index<->web-status cycle is safe.
import { Config, unwrapVolatileDeep } from './index.ts'
import type { WorkBuddyRecoveryCandidate } from './credential-recovery.ts'
import type { WorkBuddyMediaModel } from './image-gen.ts'
import type { WorkBuddyCredits, WorkBuddyUpstreamClient } from './upstream.ts'
import type { WorkBuddyBenefitView } from './benefits.ts'
import { WORKBUDDY_BENEFIT_TITLES } from './benefits.ts'
import { isCredentialRejectedError } from './upstream.ts'
import { effectiveMembersOf, rankPool, resolveTargetModel } from './account-pool.ts'
import type { WorkBuddyPoolMember, WorkBuddyPoolProbe } from './account-pool.ts'
import type {
  WorkBuddyPoolCheckinRow,
  WorkBuddyPoolTestRow,
} from './account-pool-run.ts'
import { fastDetailOf, regionOfStatusUrl, regionsMapOf, transferActionOf } from './status-paths.ts'
import type { WorkBuddyCreditPosition } from './status-paths.ts'
import type { RosterSeenReadout } from './roster-seen-store.ts'
import type { WorkBuddyRegion } from './upstream.ts'
import {
  oauthActionOf,
  poolAccountIdOf,
  poolActionOf,
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_CHECKIN_PATH,
  WORKBUDDY_MEDIA_MODELS_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_OAUTH_PATH,
  WORKBUDDY_BENEFIT_CLAIM_PATH,
  WORKBUDDY_CLI_LIVE_PATH,
  WORKBUDDY_DEVICE_PROFILE_PATH,
  WORKBUDDY_DEVICE_SDK_ACTION_PARAM,
  WORKBUDDY_DEVICE_SDK_PATH,
  WORKBUDDY_POOL_PATH,
  WORKBUDDY_POOL_ACCOUNT_PARAM,
  WORKBUDDY_PROBE_PATH,
  WORKBUDDY_TPS_PATH,
  WORKBUDDY_TRANSFER_PATH,
  WORKBUDDY_ACCOUNT_CREDITS_PATH,
  WORKBUDDY_USAGE_PATH,
} from './status-paths.ts'
import type {
  WorkBuddyTransferExportAnswer,
  WorkBuddyTransferImportAnswer,
  WorkBuddyTransferPreview,
  WorkBuddyWebAccount,
  WorkBuddyWebAccountCredit,
  WorkBuddyWebCredits,
  WorkBuddyWebPool,
  WorkBuddyWebPoolAccount,
  WorkBuddyWebPoolExclusion,
  WorkBuddyWebProbeOutcome,
  WorkBuddyWebProbeResult,
  WorkBuddyWebTpsAnswer,
  WorkBuddyWebTpsResult,
  WorkBuddyWebSearchPath,
  WorkBuddyWebUsage,
} from './status-paths.ts'

export {
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_CHECKIN_PATH,
  WORKBUDDY_MEDIA_MODELS_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_OAUTH_PATH,
  WORKBUDDY_POOL_PATH,
  WORKBUDDY_PROBE_PATH,
  WORKBUDDY_TPS_PATH,
  WORKBUDDY_TRANSFER_PATH,
  WORKBUDDY_USAGE_PATH,
}
export type { WorkBuddyWebUsage }

/** Constructor dependencies. */
export interface WorkBuddyStatusRouteOptions {
  /** The region-scoped credential store backing each region's requests. */
  store(region: WorkBuddyRegion): WorkBuddyCredentialStore
  client: Pick<WorkBuddyUpstreamClient, 'fetchCredits' | 'fetchCheckinStatus' | 'claimDailyCheckin' | 'fetchBenefits' | 'claimBenefit'>
  /**
   * The requested region's last-refreshed model directory (unfiltered) for
   * card display. Region-scoped because the CN and international apps expose
   * different rosters; showing one region's directory on the other account is
   * the bug this parameter exists to prevent.
   */
  displayModels(region: WorkBuddyRegion): readonly WorkBuddyModelInfo[]
  /** The requested region's selection, stored as model ids. */
  enabledModelIds(region: WorkBuddyRegion): readonly string[]
  /** Model ids the user opted into image input, for the requested region. */
  imageModelIds(region: WorkBuddyRegion): readonly string[]
  /** Model ids whose `off` thinking level is offered, for the requested region. */
  offModelIds(region: WorkBuddyRegion): readonly string[]
  /** Saved local DSH context budgets by model id, for the requested region. */
  contextBudgets(region: WorkBuddyRegion): Readonly<Record<string, number | undefined>>
  /**
   * The saved per-model default thinking tiers (issue #179), keyed by model id.
   *
   * Optional so a Host built before the feature keeps serving: the card then
   * treats every model as "follow the upstream default" and offers the picker
   * with only that option.
   */
  defaultThinkingEfforts?(region: WorkBuddyRegion): Readonly<Record<string, string | undefined>>
  /** Re-read the live catalog of one region from the upstream. */
  discoverModels?(region: WorkBuddyRegion, signal?: AbortSignal): Promise<readonly WorkBuddyModelInfo[]>
  /**
   * Which ids of the requested region's roster THIS machine first saw inside the
   * new-model window (the "· N 新模型" segment), plus a note when the on-disk
   * first-sighting history is in a version this build cannot read.
   *
   * READ-ONLY: the usage route never writes first-sighting history — only the
   * catalog reconciler does (`src/index.ts`), so a panel poll can never change
   * "who is new". Region-scoped because the two regions keep separate catalogs
   * and therefore separate first-sighting tables.
   *
   * Optional, and absent means the Host predates the feature: the pill then
   * renders no segment at all rather than a made-up "0 新模型".
   */
  rosterSeen?(region: WorkBuddyRegion): Promise<RosterSeenReadout>
  /**
   * Read the region's MEDIA models (image + video) for the card's read-only
   * roster block.
   *
   * Optional: a Host that mounts these routes without the upstream client
   * simply answers 503, and the card hides the block. Returns the same rows the
   * image tool consumes, so the card's list and the tool's model validation
   * cannot disagree about what exists in a region.
   */
  mediaModels?(
    region: WorkBuddyRegion,
    options?: { readonly signal?: AbortSignal; readonly refresh?: boolean },
  ): Promise<readonly WorkBuddyMediaModel[]>
  /**
   * Whether the requested region's provider is currently offered to DSH. The
   * card renders this as the tab's on/off checkbox, so the switch reflects the
   * committed settings value rather than a local guess.
   */
  regionEnabled(region: WorkBuddyRegion): boolean
  /**
   * Whether the region's sidebar credit line is shown.
   *
   * Read from the COMMITTED settings value here rather than in the browser, for
   * the same reason as `regionEnabled` — and additionally because the browser's
   * settings mirror is documented as stale for this namespace on the affected
   * 0.1.7 deployments, which made the checkbox appear unable to turn the line
   * off ("关闭不了"). The card reads this field off the Host's answer.
   *
   * Optional so a Host that predates the setting still satisfies the interface;
   * absent reads as ON, matching the schema's `default(true)`.
   */
  showCreditsInMainUi?(region: WorkBuddyRegion): boolean
  /**
   * WHERE this region's credit readout sits (issue #62).
   *
   * Optional, and absent reads as `composer` — the only seat before the setting
   * existed, so a Host that predates it renders exactly as it used to.
   */
  creditPosition?(region: WorkBuddyRegion): WorkBuddyCreditPosition
  /**
   * Whether the model may call the image-generation tool in this region.
   *
   * Optional, and absent reads as OFF — the opposite of the fields above. This
   * one authorizes the MODEL to spend credits on its own, so an older Host that
   * cannot answer must not be read as consent.
   */
  imageToolEnabled?(region: WorkBuddyRegion): boolean
  /**
   * Whether the model may call the video-generation tool in this region.
   * Optional, absent reads as OFF — same opt-IN semantics as `imageToolEnabled`
   * (the model decides to spend, so an older Host must not be read as consent).
   */
  videoToolEnabled?(region: WorkBuddyRegion): boolean
  /**
   * The video model pinned per tag in this region (`text-to-video` /
   * `image-to-video`), as a model id from that region's own catalog.
   *
   * Optional, and absent reads as "nothing pinned" — the same direction as
   * `videoToolEnabled`: an older Host that cannot answer must not invent a
   * choice the user never made. The card uses it to render the per-mode picker
   * from the committed value the tool will actually read.
   */
  preferredVideoModels?(region: WorkBuddyRegion): Readonly<Record<string, string>>
  /**
   * Whether the OPTIONAL CodeBuddy CLI route is mounted (`codebuddy_ask` tool +
   * `/codebuddy` command).
   *
   * GLOBAL rather than per region — one switch, one route — so it takes no
   * argument. Optional, and absent reads as OFF: this switch authorizes a child
   * process to edit files and spend CodeBuddy quota, so an older Host that
   * cannot answer must not be read as consent. The card reads it off the Host's
   * answer for the same measured reason as `imageToolEnabled`: the browser's
   * settings mirror is stale for this namespace on the affected 0.1.7
   * deployments, and a stale `true` here would claim a spending capability is on.
   */
  cliBridgeEnabled?(): boolean
  /**
   * The model the OPTIONAL CodeBuddy CLI route runs on, or `''` for "the CLI's
   * own default".
   *
   * GLOBAL like `cliBridgeEnabled` — one route, one pin, so no argument.
   * Optional, and absent is the same as `''`: the route then runs on the CLI's
   * default. The card carries it on the Host's answer for the same measured
   * reason as `cliBridgeEnabled` — the browser's settings mirror is stale for
   * this namespace on the affected 0.1.7 deployments, so a picker reading the
   * mirror alone would keep showing a pin that had just been cleared.
   */
  cliBridgeModel?(): string
  /**
   * The reasoning effort the OPTIONAL CodeBuddy CLI route runs on, or `''` for
   * "the CLI's own default". GLOBAL, optional, and absent-as-`''` for the same
   * reasons as {@link cliBridgeModel}.
   */
  cliBridgeEffort?(): string
  /**
   * The order the OPTIONAL CodeBuddy CLI route walks the credential regions in
   * (a comma-separated list such as `'cn,global'`), or `''` for "the CLI's own
   * default order". GLOBAL, optional, and absent-as-`''` for the same reasons
   * as {@link cliBridgeModel}.
   */
  cliBridgeRegionOrder?(): string
  /**
   * Whether the request path drops foreign thinking blocks (issue #147).
   *
   * Optional, absent reads as OFF: the repair changes bytes the upstream counts,
   * so a Host that cannot answer must not be read as consent.
   */
  dropForeignThinking?(): boolean
  /**
   * What the LAST request had to drop, for the card's explanation of a turn that
   * arrived looking like working notes (issue #147).
   *
   * Optional, and absent means "nothing to report" — the card then renders no
   * warning rather than a permanent one. Process-local and last-wins: it
   * describes the turn the user is looking at, not a historical tally.
   */
  latestForeignThinking?(): { blocks: readonly { messageIndex: number, blockIndex: number, characters: number, variant: 'flattened' | 'dropped' }[], atMs: number } | undefined
  /**
   * The LIVE load level per model id, for the card's icon.
   *
   * Optional, and absent means "not measured": the card draws no badge rather
   * than a made-up one. A SEPARATE read because the card's model list is the
   * SAVED roster, which carries no load level (`src/busy.ts`).
   */
  busyLevels?(region: WorkBuddyRegion): Readonly<Record<string, WorkBuddyBusyLevel>>
  /**
   * Send one real-volume request to each named model of a region and report what
   * came back.
   *
   * Optional: it is the only dependency the card's test button needs, so a Host
   * built without it (or a route mounted for a status-only consumer) simply
   * answers 503 and the button reports that instead of failing the card.
   *
   * Every request costs real credits (measured `credit: 0.72` for one probe), so
   * the card drives this ONE model per click and never as a batch.
   */
  probeModels?(
    region: WorkBuddyRegion,
    modelIds: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<readonly WorkBuddyWebProbeResult[]>
  /**
   * Measure OUTPUT SPEED for each named model of a region (issue #92).
   *
   * Separate from {@link probeModels} because it answers the opposite question
   * with the opposite request shape: tiny input, long output. The availability
   * probe's `max_tokens: 1` means its `elapsedMs` is time-to-first-token and
   * carries no rate information at all.
   *
   * Costs a fraction of a probe per model (measured `credit 0.01`–`0.15` against
   * `0.72`), because this gateway prices by INPUT. It still spends real credit,
   * so it stays one model per click like every other spending route.
   */
  measureTps?(
    region: WorkBuddyRegion,
    modelIds: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<readonly WorkBuddyWebTpsResult[]>
  /**
   * The region's next monthly quota refresh, when the upstream declares one.
   *
   * Used ONLY to answer "when can I use this again" for an out-of-credit
   * outcome, which is the one cooldown the service actually states: a monthly
   * resource that resets at a known time. Every other limited outcome has no
   * time from any source and must be reported as such.
   */
  quotaRefreshAtMs?(region: WorkBuddyRegion): number | undefined
  /**
   * Report whether a region still has at least one local sign-in.
   *
   * The card is where sign-in state actually changes under the plugin's nose
   * (the user signs in to the desktop app, then presses "detect accounts
   * again"), so the routes are the earliest honest place to notice. Both
   * callers already read `store.accounts()` for their own answer, so this adds
   * no scan of its own.
   */
  regionUsable?(region: WorkBuddyRegion, usable: boolean): void
  /**
   * Verify whether one local account is still accepted by the upstream.
   *
   * Consulted ONLY after the selected credential has been refused, to tell
   * "switch accounts" apart from "sign in again". Left undefined, nothing is
   * claimed usable and the card falls back to the re-login advice that needs no
   * probe.
   */
  accountUsable?(region: WorkBuddyRegion, account: WorkBuddyRecoveryCandidate): Promise<boolean>
  /**
   * The CLI route's live turns, for the composer readout.
   *
   * A READ of the bridge's in-memory board, not a computation: the route exists
   * so a turn that is still running has somewhere to be observed from, and the
   * board is the only thing that knows. Absent (the bridge is switched off, or
   * this Host mounted the status routes without it) means "no live turns", which
   * the chip renders as nothing at all.
   */
  cliLive?(): unknown
  /**
   * 设备头设置（「虚拟值 / 真实值」+ 每账号覆盖参数）的读写口。
   *
   * Optional like the other ports: a Host mounted without it answers 503, and the
   * card hides the toggle and the row gears entirely rather than showing controls
   * that cannot do anything.
   */
  deviceSettings?: WorkBuddyDeviceSettingsPort
  /**
   * 真实设备参数（内置 SDK）的状态与取值口。
   *
   * Optional like the rest: 一个没有接 SDK 的宿主（别的平台、或构建时裁掉了
   * `native/`）答 503，卡片就把「SDK」这一页藏起来——比渲染一页永远"不可用"的
   * 红字诚实。
   */
  deviceSdk?: WorkBuddyDeviceSdkPort
  /**
   * Why each of the region's accounts cannot serve right now, keyed by account
   * id. Absent key (or an absent dep) means "no reason known" — the composer
   * panel then marks nothing, which is the honest answer for an account that has
   * never been measured.
   *
   * The rule is the SAME one the pool ranks by (`exclusionOf`), including its
   * cooldown-expiry handling, so an account the pool calls usable and one the
   * panel calls rate-limited can never be the same account at the same moment.
   * Reimplementing the expiry check here would let the two drift.
   */
  accountExclusions?(region: WorkBuddyRegion): Promise<Readonly<Record<string, WorkBuddyWebPoolExclusion>>>
  /**
   * The region's account pool, assembled on the Host.
   *
   * Optional as a whole: a Host built without pool support simply omits it, and
   * the card then renders no pool section rather than an empty, confusing one.
   * Inside it, `test` is in turn optional because a batch test is the one part
   * that needs a working probe dependency.
   */
  pool?: WorkBuddyPoolDeps
  /**
   * OAuth QR sign-in: start a login and poll it to completion.
   *
   * Optional as a whole: a Host built without it simply omits the card's
   * sign-in affordance (an older bundle keeps rendering, minus the button).
   */
  oauth?: WorkBuddyOAuthDeps
  /**
   * Batch credential export / import between machines.
   *
   * Optional as a whole: a Host built without it simply omits the card's
   * transfer section (an older bundle keeps rendering, minus the buttons).
   */
  transfer?: WorkBuddyTransferDeps
}

/**
 * What the transfer route needs from the Host. Everything is region-scoped:
 * the two regions' vaults are parallel stacks, and an export of one tab must
 * never leak the other tab's accounts.
 */
export interface WorkBuddyTransferDeps {
  /**
   * Export the named accounts' credentials in the shared transfer format.
   * Unknown ids are simply absent from the answer; an answer with zero
   * records means nothing named was exportable (the caller decides whether
   * that is an error).
   */
  exportAccounts(region: WorkBuddyRegion, accountIds: readonly string[]): Promise<WorkBuddyTransferExportAnswer>
  /** Parse transfer-file text into the desensitized preview. */
  previewImport(region: WorkBuddyRegion, text: string): Promise<WorkBuddyTransferPreview>
  /**
   * Merge the selected file entries into the region's vault. Returns the
   * counters the card reports; `skipped` covers missing tokens, bad indexes,
   * and records belonging to the other region.
   */
  importAccounts(region: WorkBuddyRegion, text: string, indexes: readonly number[]): Promise<WorkBuddyTransferImportAnswer>
}

/**
 * What the OAuth route needs from the Host: the two session actions, plus the
 * persistence step the route cannot do itself (only the Host may touch the
 * credential vault).
 */
export interface WorkBuddyOAuthDeps {
  /**
   * Start one login for the region. Resolves the URL the user opens to scan
   * and confirm, or an actionable error.
   */
  start(region: WorkBuddyRegion): Promise<WorkBuddyOAuthStartResult>
  /**
   * Poll once. The card repeats until `done` — then either the account was
   * persisted (the Host saved it to the vault) or an error is reported.
   */
  poll(region: WorkBuddyRegion, loginId: string): Promise<WorkBuddyOAuthPollView>
}

/** The start answer, token-free (the state never leaves the Host). */
export type WorkBuddyOAuthStartResult =
  | { loginId: string, verificationUri: string, expiresIn: number }
  | { error: string }

/** The poll answer the card sees. `account` carries display fields only. */
export type WorkBuddyOAuthPollView =
  | { done: false }
  | { done: true, accountName: string, accountId: string }
  | { done: true, error: string }

/**
 * What the pool route needs from the Host.
 *
 * Everything is region-scoped because the two regions are parallel stacks: one
 * region's pool must never see, rank, or bill the other region's accounts.
 */
export interface WorkBuddyPoolDeps {
  /** The region's stored preferences, resolved from the Host config. */
  preferences(region: WorkBuddyRegion): {
    enabled: boolean
    targetModelId: string
    /** Per-account override of `targetModelId` (issue #61). */
    /**
     * Tokens each test probe sends as saved; `0` when the user never chose.
     *
     * Optional so a caller that has not learnt about the setting still
     * satisfies this interface, and so its absence reads as "default" — the
     * same meaning the host gives an older profile.
     */
    probeInputTokens?: number
    memberAccountIds: readonly string[]
    /**
     * The user's hand-ordered pool order, as account ids.
     *
     * Optional so a Host that never learnt about the setting still satisfies
     * this interface — its absence then reads as "no manual order" and the
     * ranking simply ignores it.
     */
    orderAccountIds?: readonly string[]
  }
  /** One region's CHECKED accounts, plus their credits and last measurements. */
  members(region: WorkBuddyRegion): Promise<readonly WorkBuddyPoolMember[]>
  /**
   * One region's CHECKED accounts from LOCAL state only — the first-paint
   * source (issue #77).
   *
   * Cheap by contract in the strongest sense: no upstream read at all. It
   * returns the saved members with whatever credit reading a previous full
   * document already recorded (a snapshot, possibly minutes old, possibly
   * absent), so the card can paint the account table before any billing
   * endpoint answers. `credits` being absent is normal here and renders as "—",
   * which is why {@link WorkBuddyWebPoolAccount} makes every figure optional.
   *
   * A Host built without it degrades to omitting the pool block from a
   * first-paint document (rather than paying {@link members} on that path):
   * the card then paints its account list from the full document, exactly as
   * before this contract existed.
   */
  localMembers?(region: WorkBuddyRegion): Promise<readonly WorkBuddyPoolMember[]>
  /**
   * The checked accounts that actually RESOLVE to a local sign-in.
   *
   * Cheap by contract (a local scan, no upstream calls), unlike {@link members}
   * which fetches credits per account. The route's empty-pool guard uses this
   * so a ghost id — a saved member whose sign-in is gone — is refused with
   * `no-live-members` (distinct from `no-members`, which means nothing was ever
   * checked) instead of passing the guard and running a batch over nothing.
   */
  effectiveMemberAccountIds?(region: WorkBuddyRegion): Promise<readonly string[]>
  /**
   * Last display name measured for each of a region's saved member ids
   * (issue #60), from the runtime probe store — no upstream call.
   *
   * The card needs this for the one case it cannot answer from its own props: a
   * saved member whose sign-in is gone resolves to no listed account, so its
   * name exists ONLY in the measurement that once saw it. Optional: a Host
   * built without it still renders, with the id-prefix fallback.
   */
  memberNames?(region: WorkBuddyRegion): Promise<Readonly<Record<string, string>>>
  /**
   * Test ONE account against the region's target model.
   *
   * The per-row button's Host half. Optional: a Host built without it simply
   * omits the row button (an older bundle keeps rendering, minus the control).
   * Returns undefined when the region cannot name a target model — the same
   * refusal the batch route reports as 409.
   */
  testOne?(region: WorkBuddyRegion, accountId: string): Promise<WorkBuddyPoolTestRow | undefined>
  /**
   * Forget ONE account's plugin-stored credential. Only the vault entry is
   * removed; the desktop app's files are never touched. Returns whether an
   * entry existed — false means the account exists only as a desktop sign-in
   * (or was already gone), which the card reports instead of a silent no-op.
   */
  removeOne?(region: WorkBuddyRegion, accountId: string): Promise<boolean>
  /**
   * Today's check-in state per account id.
   *
   * Read for the pool's table so the card can state it. Absent (or a missing
   * entry) means "not read", which the card renders as unknown rather than as a
   * definite "not checked in" — a claim that would contradict the check-in the
   * user just performed.
   *
   * Only the CN region has a check-in to report; see {@link checkinSupported}.
   */
  checkedInToday?(region: WorkBuddyRegion): Promise<Readonly<Record<string, boolean>>>
  /**
   * Today's check-in state, from the cells already measured this process.
   *
   * The first-paint counterpart of {@link checkedInToday}: reads the Host's
   * measurement cache and nothing else, so a first paint never waits on one
   * upstream request per account. An account it has not measured is simply
   * absent, which the card renders as unknown — the same meaning as a failed
   * per-account read in the full document.
   */
  cachedCheckedInToday?(region: WorkBuddyRegion): Readonly<Record<string, boolean>>
  /**
   * Claimable promotional benefits per account id (issue #79).
   *
   * Only campaigns the account can STILL claim are present; a claimed or lapsed
   * campaign is absent on purpose, so the card renders nothing for it. Absent
   * (or a missing entry) also means "not read yet", which the card treats the
   * same way — no line, rather than a guessed state.
   */
  benefits?(region: WorkBuddyRegion): Promise<
    Readonly<Record<string, readonly WorkBuddyBenefitView[]>>
  >
  /**
   * Claimable benefits, from the readings already taken this process.
   *
   * The first-paint counterpart of {@link benefits}: no request, so painting
   * never waits on two upstream reads per account.
   */
  cachedBenefits?(region: WorkBuddyRegion): Readonly<Record<string, readonly WorkBuddyBenefitView[]>>
  /**
   * Forget this account's cached benefit reading so the next status read is live.
   *
   * The claim route writes to upstream directly, so nothing else in the plugin
   * knows the campaign just changed. Without this the card kept showing 领取 for
   * up to `BENEFIT_CACHE_MS` (30 min) after a SUCCESSFUL claim: the credits went
   * up, the pill stayed, and the only remaining explanation was "the claim
   * silently failed" — which invited a second click the route then refused as
   * already-claimed. `checkin` has the same rule and invalidates its own cache;
   * this is the benefit counterpart.
   *
   * Absent is legal (a Host from before this hook) and means "the click refreshes
   * the card, but the host-side cache may still answer stale for a while".
   */
  invalidateBenefit?(region: WorkBuddyRegion, accountId: string): void
  /**
   * Every local sign-in the pool does NOT cover, so the card can offer them to
   * check in. Absent means the card lists only pool members.
   */
  otherAccounts?(region: WorkBuddyRegion): Promise<readonly { id: string, accountName: string, enterprise?: boolean }[]>
  /** The account currently billing traffic for the region, when known. */
  currentAccountId?(region: WorkBuddyRegion): Promise<string | undefined>
  /**
   * Whether this region offers the daily check-in action at all.
   *
   * The CN app rewards a daily check-in; the international region is not offered
   * one here, so its card must not show the button and its route must refuse the
   * action. A capability rather than a region name compared in the browser: the
   * policy belongs in the Host, and the card should not have to know which
   * regions happen to have the feature.
   */
  checkinSupported?(region: WorkBuddyRegion): boolean
  /**
   * Claim the daily reward for every account of one region.
   *
   * Absent means the action answers 503 — the same contract as {@link
   * WorkBuddyStatusRouteOptions.probeModels}, so a Host without the dependency
   * reports "unavailable" instead of appearing to succeed.
   */
  checkin?(region: WorkBuddyRegion): Promise<readonly WorkBuddyPoolCheckinRow[]>
  /**
   * Test every account of one region against the resolved target model.
   *
   * `onRow` is optional and exists so the route can STREAM each account as it
   * finishes. An older Host ignores it and answers with the whole batch at once;
   * the route handles both, because a missing reporter must degrade to the
   * previous behaviour rather than to no rows at all.
   */
  test?(
    region: WorkBuddyRegion,
    /**
     * The model the whole batch is measured on — ONE value, by design: every
     * member of the batch must be probed on the same model or a green batch
     * stops meaning a single thing (see the removal note in `account-pool-run.ts`).
     */
    modelId: string,
    onRow?: (row: WorkBuddyPoolTestRow) => void,
  ): Promise<readonly WorkBuddyPoolTestRow[]>
  /** The region's live catalog, used to resolve the free target model. */
  catalog?(region: WorkBuddyRegion): readonly WorkBuddyModelInfo[]
}

/** Redact token-like content before it crosses to the browser. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

/**
 * The upstream-identity switches the card may write through `__save`.
 *
 * These are TOP-LEVEL config fields (see the schema in `index.ts`), not a
 * nested block, so each is set on its own path and no merge base is involved.
 * The list is a constant here rather than derived from the schema because this
 * endpoint must stay a closed allow-list: deriving it would let an unrelated
 * schema addition quietly widen what the browser can write.
 *
 * Every entry is a switch the user can already set by hand in
 * `cordis.patch.yml`; this list only adds a UI route to the same fields (issue
 * #133 suggestions 2 and 3), so it can never expose anything the config file
 * does not already expose.
 */
const UPSTREAM_SWITCH_FIELDS: ReadonlySet<string> = new Set([
  'usageIdentity',
  'keepPromptLast',
  'extraInjectedPrefixes',
  'sessionTitle',
  // Issue #147: the transcript repair switch, driven from the card's reply
  // notice as well as its switch row.
  'dropForeignThinking',
  // 渠道门拒绝后自动续发（见 `src/channel-continue.ts`）。整块写入：它有三个
  // 字段，卡片只改 `enabled` 时也要把用户调过的上限与文本一起带上，否则一次
  // 布尔写会把它们擦回默认值（同 `sessionTitle` 的处置）。
  'channelRejectContinue',
])

/** A non-null, non-array object: the only shape the slot merge applies to. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Merge a `cliBridge` patch into the committed settings object.
 *
 * ONE level on purpose: every field in that block is a scalar (a boolean, a cap,
 * a path), so the only thing a deeper merge could produce is a half-written entry.
 * Sibling keys survive — flipping the switch must not drop the user's tuned caps.
 */
export function nextCliBridgeSettings(current: unknown, patch: unknown): Record<string, unknown> {
  const base = isPlainRecord(current) ? { ...current } : {}
  if (!isPlainRecord(patch)) return base
  for (const [key, value] of Object.entries(patch)) base[key] = value
  return base
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * A JSON response that must never be cached.
 *
 * Used for every answer that carries live credentials — the transfer export
 * hands the browser real access and refresh tokens. Without `no-store` such a
 * response is eligible for the browser's HTTP cache, where a token can outlive
 * the session on disk.
 */
function jsonPrivate(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/** Request-body cap for the probe route: model ids only, never content. */
const PROBE_BODY_LIMIT = 64 * 1024

/**
 * Read a small JSON request body.
 *
 * Bounded, unlike the settings route's reader: this endpoint takes a list of
 * model ids and has no legitimate use for a large payload, so an oversized body
 * is refused rather than buffered.
 */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > PROBE_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject(new Error('request body must be a JSON object'))
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.on('error', reject)
  })
}

/**
 * The full gate a state-changing route must clear: Host AND Origin.
 *
 * Origin alone is not enough. It answers "did a foreign page cause this?", but a
 * DNS-rebinding attack arrives with the attacker's domain in `Host` and no
 * useful Origin, so the Host check is what drops it — and until this function
 * existed, all thirteen routes below (ten POST, three GET) had only the Origin
 * half while the shim's chat route had both. The asymmetry was invisible per-file.
 *
 * Both halves are cheap and NEITHER IS AUTHENTICATION. A local process — or any
 * peer that can reach the listener when it is bound to a LAN address — may send
 * whatever Host and Origin it likes. What these two checks buy is narrow and
 * worth stating precisely:
 *
 * - they stop a BROWSER on a foreign page from driving these routes (the browser
 *   chooses Origin for us, and rebinding fails the Host comparison), which is
 *   the CSRF / rebinding family;
 * - they do NOT stop a program that can already open a socket to the port.
 *
 * There is no per-route secret here: `req.headers` is read for `host` and
 * `origin` and nothing else. Every route that spends credit or returns token
 * material is protected by the same two forgeable headers as the read routes, so
 * binding this listener to a non-loopback address exposes those routes to the
 * local network. That is a property of the whole surface, not of this function,
 * and it must not be described as though a stronger guard existed.
 *
 * Absent Host is refused: HTTP/1.1 requires it, and its absence on a
 * credit-spending surface is not worth the benefit of the doubt. Absent Origin
 * passes, because that is the shape of the plugin's own fetch and of curl.
 */
function requireLoopback(req: IncomingMessage, res: ServerResponse): boolean {
  if (!hostMatchesListener(req.headers.host, req.socket?.localAddress)) {
    json(res, 403, { error: 'host-not-trusted' })
    return false
  }
  if (!originIsLoopback(req.headers.origin, req.socket?.localAddress)) {
    json(res, 403, { error: 'origin-not-trusted' })
    return false
  }
  return true
}

/** Map the credit answer to the card's compact document. */
function toCredits(answer: WorkBuddyCredits): WorkBuddyWebCredits {
  return {
    total: answer.total,
    packages: answer.packages.map(pack => ({
      packageName: pack.packageName,
      remain: pack.remain,
      size: pack.size,
      monthly: pack.monthly,
      ...pack.refreshAtMs === undefined ? {} : { cycleRefreshMs: pack.refreshAtMs },
      ...pack.expiresAtMs === undefined ? {} : { expiresAtMs: pack.expiresAtMs },
    })),
    expiringSoon: answer.expiringSoon,
    ...answer.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: answer.nearestExpiryMs },
  }
}

/** Project a model into the card's row, dropping empty optional fields. */
function toWebModel(
  model: WorkBuddyModelInfo,
  budgets: Readonly<Record<string, number | undefined>>,
): WorkBuddyWebModelFromInfo {
  // Route through the shared rule rather than repeating the clamp: this used to
  // hold its own copy of the `?? 200_000` default, so issue #33's wrong default
  // lived in two places and the card could disagree with the runtime catalog.
  const budgeted = applyContextBudgets([model], budgets)[0] ?? model
  return {
    id: model.id,
    name: model.name,
    contextWindow: budgeted.contextWindow,
    nativeContextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...model.creditMultiplier === undefined ? {} : { creditMultiplier: model.creditMultiplier },
    // The load level rides along so the CARD can draw it as an icon. The host's
    // model picker cannot (its name is a plain string) and gets a character
    // instead — see `busyDisplaySuffix`. Absent means "not measured right now".
    ...model.busyLevel === undefined ? {} : { busyLevel: model.busyLevel },
    ...model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages },
    ...model.multimodal === undefined ? {} : { multimodal: model.multimodal },
    ...model.reasoning === undefined ? {} : {
      reasoning: {
        ...model.reasoning.supportedEfforts === undefined ? {} : { supportedEfforts: [...model.reasoning.supportedEfforts] },
        ...model.reasoning.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort },
        // Carried so it survives the card's save back into `lastCatalog`.
        // Dropping it here meant one Save stripped the declaration from every
        // model, and since an absent declaration never offers `off` (issue #34's
        // default), the level silently vanished for the models that accept it.
        ...model.reasoning.canDisableThinking === undefined ? {} : { canDisableThinking: model.reasoning.canDisableThinking },
        // The table's verdict, not the declaration, so the card's warning hint
        // and the runtime catalog (which stamps `off` off for these ids) cannot
        // disagree (issue #83).
        ...offRefused(model.id) ? { offRefused: true } : {},
        // Only ever added, never cleared by this projection: the flag records an
        // observed refusal, and a refresh that recomputes every other field must
        // not erase the one piece of evidence the user can act on (issue #83).
        ...model.reasoning.refusesOff === true ? { refusesOff: true } : {},
      },
    },
    // The upstream's own promotion / tier badges for this model, UNRESOLVED:
    // the card picks the one that holds at the moment it draws, because a
    // badge is a function of the clock (see `src/promo.ts`).
    ...model.promos === undefined ? {} : { promos: model.promos },
  }
}

type WorkBuddyWebModelFromInfo = import('./status-paths.ts').WorkBuddyWebModel

/**
 * Project a store account into the card's token-free account row.
 *
 * `uin` is deliberately NOT forwarded: the card has never rendered it, so
 * sending it was pure exposure of an account identifier for no feature. The
 * name carries whatever the desktop app recorded, and `''` means the card
 * should show its own placeholder rather than an identifier.
 */
function toWebAccount(account: {
  id: string
  accountName: string
  domain: string
  source: 'desktop' | 'dsh'
  tokenExpiresAtMs: number
  selected: boolean
  /** Credential belongs to an enterprise/education tenant (issue #129). */
  enterprise?: boolean
}): WorkBuddyWebAccount {
  return {
    id: account.id,
    accountName: account.accountName,
    domain: account.domain,
    source: account.source,
    tokenExpiresAtMs: account.tokenExpiresAtMs,
    selected: account.selected,
    ...account.enterprise === true ? { enterprise: true } : {},
  }
}

/**
 * The probed-path list for a signed-out region, or nothing when the store
 * cannot produce one.
 *
 * Diagnostics must never turn a page into an error: `diagnose()` re-reads the
 * filesystem, and a store built without it (or one whose probe throws on an
 * exotic filesystem) degrades to the plain "not signed in" hint the card showed
 * before this existed. Failure reasons are `safeMessage`d because a raw
 * filesystem error can embed an absolute path or a fragment of file content.
 */
async function searchedPaths(
  store: WorkBuddyCredentialStore,
): Promise<{ searched?: readonly WorkBuddyWebSearchPath[] }> {
  if (typeof store.diagnose !== 'function') return {}
  try {
    const { failures } = await store.diagnose()
    if (failures.length === 0) return {}
    return {
      searched: failures.map(failure => ({
        path: failure.path,
        source: failure.source,
        reason: failure.reason,
        ...failure.message === undefined ? {} : { message: safeMessage(failure.message) },
      })),
    }
  } catch {
    // A diagnostics pass is never worth failing the card over.
    return {}
  }
}

/** Reads schemastery's internal `meta.volatile` marker for one top-level field. */
function volatileFlagOf(field: string): boolean {
  const dict = (Config as unknown as {
    dict?: Record<string, { meta?: { volatile?: unknown } }>
  }).dict
  return dict?.[field]?.meta?.volatile === true
}


/**
 * Per-account credit balances for one region, for the composer panel's table.
 *
 * ONE upstream read per account, which is exactly why this is its own route:
 * the panel calls it only while it is open, so the 5-minute readout never
 * multiplies its cost by the account count.
 *
 * Every account is listed even when its balance cannot be read — a credential
 * that no longer resolves, or an upstream that refused — because the panel's
 * job is to show which accounts exist and let the user switch. Such a row
 * carries NO `credits` field rather than `0`, so the panel renders "—" instead
 * of telling the user they are out of credits.
 *
 * Failures are contained per account: one dead credential must not blank the
 * table for the accounts that are fine.
 */
export async function workBuddyAccountCredits(
  deps: WorkBuddyStatusRouteOptions,
  region: WorkBuddyRegion,
): Promise<WorkBuddyWebAccountCredit[]> {
  const store = deps.store(region)
  const accounts = await store.accounts()
  // Read once, not per account: it is a single local file, and the rule that
  // turns a measurement into an exclusion must stay the pool's (`exclusionOf`).
  const exclusions = await deps.accountExclusions?.(region).catch(() => undefined) ?? {}
  return Promise.all(accounts.map(async account => {
    const credential = await store.credentialFor(account.id).catch(() => undefined)
    const credits = credential === undefined
      ? undefined
      : await deps.client.fetchCredits(credential).then(answer => answer.total).catch(() => undefined)
    const excludedBy = exclusions[account.id]
    return {
      id: account.id,
      accountName: account.accountName,
      selected: account.selected,
      ...credits === undefined ? {} : { credits },
      ...excludedBy === undefined ? {} : { excludedBy },
    }
  }))
}

/**
 * How much live measurement a status document carries (issue #77).
 *
 * `full` is the original answer: the selected account's credit and check-in
 * plus every pool account's credit and check-in, all read from upstream now.
 * It is what the card's 60-second poll, the composer panel and every
 * measurement-driven control expect.
 *
 * `fast` is the FIRST PAINT. It answers from local state only — no token
 * refresh, no billing endpoint, no check-in endpoint — so the account list can
 * render in the first round trip and cannot be held up by a slow or
 * rate-limited upstream. Live figures are absent from it by construction; the
 * card then asks for the full document and upgrades the same snapshot.
 */
export type WorkBuddyStatusDetail = 'full' | 'fast'

/** The live, possibly-slow half of a signed-in document. */
type WorkBuddyLiveFigures = Pick<
  Extract<WorkBuddyWebUsage, { status: 'signed-in' }>,
  'credits' | 'creditsError' | 'checkin' | 'checkinError' | 'credentialRejected' | 'recovery'
>

/**
 * Read the selected account's live figures, and classify a refusal.
 *
 * Extracted so the first-paint path can omit it as a unit: the two calls here
 * are the ones that used to gate the account list (each up to the upstream
 * client's 30-second ceiling, and the pool adds one pair per member on top).
 */
async function liveFigures(
  deps: WorkBuddyStatusRouteOptions,
  region: WorkBuddyRegion,
  credential: WorkBuddyCredential,
  selected: { id: string } | undefined,
): Promise<WorkBuddyLiveFigures> {
  const [creditsResult, checkinResult] = await Promise.allSettled([
    deps.client.fetchCredits(credential),
    deps.client.fetchCheckinStatus(credential),
  ])
  // Both calls carry the SAME credential, so either one reporting a refusal
  // classifies the credential itself — and the honest advice depends on whether
  // another local account would work, which is what the recovery pass answers.
  // It runs only on this failure path, so a healthy account pays nothing.
  const rejected = [creditsResult, checkinResult].some(
    result => result.status === 'rejected' && isCredentialRejectedError(result.reason),
  )
  const recovery = !rejected ? undefined : await resolveCredentialRecovery({
    region,
    store: deps.store(region),
    ...selected === undefined ? {} : { rejectedAccountId: selected.id },
    // Without an injected probe nothing can be verified, so no account is
    // claimed usable — `reloginRequired` then still reports the one case that
    // needs no probe (there is nothing else to switch to).
    probe: deps.accountUsable ?? (async () => false),
  })
  return {
    ...creditsResult.status === 'fulfilled'
      ? { credits: toCredits(creditsResult.value) }
      : { creditsError: safeMessage(creditsResult.reason) },
    ...checkinResult.status === 'fulfilled'
      ? { checkin: checkinResult.value }
      : { checkinError: safeMessage(checkinResult.reason) },
    ...!rejected ? {} : { credentialRejected: true },
    ...recovery === undefined ? {} : { recovery },
  }
}

/**
 * Assemble one region's card document. `region` is the tab the card is on;
 * the region-scoped store already answers with only that region's accounts,
 * so the document's model slots and account list are that region's by
 * construction. Sign-in state is read-only; credit is a live billing answer
 * whose failure degrades to `creditsError` rather than failing the document.
 *
 * `options.detail` selects the first-paint variant: it uses the credential
 * already known locally instead of resolving (resolving may refresh a token
 * over the network) and skips {@link liveFigures} entirely, so nothing about
 * the account list depends on how fast a billing endpoint answers.
 */
export async function workBuddyWebStatus(
  deps: WorkBuddyStatusRouteOptions,
  region: WorkBuddyRegion,
  options: { detail?: WorkBuddyStatusDetail } = {},
): Promise<WorkBuddyWebUsage> {
  const fast = options.detail === 'fast'
  const store = deps.store(region)
  const accounts = await store.accounts()
  // The card is a live view of this same scan, so this is where a sign-in that
  // happened behind the plugin's back gets noticed — before the next restart.
  deps.regionUsable?.(region, accounts.length > 0)
  // The provider's on/off state is independent of sign-in: a region the user
  // switched off renders its switch as off even when fully signed in, and the
  // card reads this committed value rather than a local guess.
  const enabled = deps.regionEnabled(region)
  // Same reasoning as `enabled`, plus one more: the browser's settings mirror
  // is documented as stale for this namespace on the affected 0.1.7
  // deployments, so a control that read the mirror kept rendering the old value
  // after a successful write — the switch looked impossible to turn off
  // ("关闭不了"). Absent means ON, matching the schema's `default(true)`.
  const showCreditsInMainUi = deps.showCreditsInMainUi?.(region) ?? true
  const creditPosition = deps.creditPosition?.(region) ?? 'composer'
  // `?? false`, unlike the two above: the image tool lets the MODEL spend,
  // so an older Host that cannot answer must not be read as consent.
  const imageToolEnabled = deps.imageToolEnabled?.(region) ?? false
  const videoToolEnabled = deps.videoToolEnabled?.(region) ?? false
  // Absent reads as "nothing pinned", never as a made-up id: the picker then
  // shows its default row, which is exactly what the tool would do anyway.
  const preferredVideoModels = deps.preferredVideoModels?.(region) ?? {}
  // GLOBAL, read once per answer and repeated on each region: the card polls one
  // region at a time, so the switch has to be present on whichever tab is open.
  // `=== true` for the same reason as `imageToolEnabled`: absent is not consent.
  const cliBridgeEnabled = deps.cliBridgeEnabled?.() === true
  // The route's three quick-adjust pins. Absent reads as `''` (the CLI's own
  // default), never as a made-up value: an older Host without the deps simply
  // cannot answer, and the card's pickers then fall back to the settings
  // snapshot for the same reason `cliBridgeEnabled` does.
  const cliBridgeModel = deps.cliBridgeModel?.() ?? ''
  const cliBridgeEffort = deps.cliBridgeEffort?.() ?? ''
  const cliBridgeRegionOrder = deps.cliBridgeRegionOrder?.() ?? ''
  // ISSUE #147. `=== true` for the same reason as the spend switches: the repair
  // changes bytes the upstream counts, so an absent answer is not consent.
  const dropForeignThinking = deps.dropForeignThinking?.() === true
  // The last request's repair report, or nothing. Absent reads as "no report",
  // never as "the feature is off": the two are different facts and the card
  // says different things about them.
  const lastForeignThinking = deps.latestForeignThinking?.()
  // The LIVE load levels, beside the model list rather than inside it: the
  // card's list is the SAVED roster, and a saved roster has no load level.
  const busyLevels = deps.busyLevels?.(region) ?? {}
  const authStatus = await store.status()
  // Whether a saved per-region choice is in effect, on every branch: the card
  // needs it to show that clearing really did return the region to the app's
  // current sign-in, even when that default is the same account as before.
  const selectionExplicit = store.hasExplicitSelection()
  if (authStatus.state !== 'signed-out' && accounts.length === 0) {
    // Both `status()` and `accounts()` derive from the same scan, so this pair
    // is only reachable when a sign-in landed between the two calls. A
    // credential just appeared: there is nothing to diagnose, and a list of
    // failed probe paths would contradict what the user is looking at.
    return { status: 'signed-out', accounts: [], selectionExplicit, enabled, showCreditsInMainUi, imageToolEnabled, videoToolEnabled, preferredVideoModels, cliBridgeEnabled, cliBridgeModel, cliBridgeEffort, cliBridgeRegionOrder, busyLevels }
  }
  let credential
  try {
    // The first paint reads the credential that is ALREADY known locally.
    // `resolve()` is the right call for the full document — it makes sure the
    // tokens handed to the upstream are usable — but it can refresh them over
    // the network, and no token refresh may decide when the account list
    // appears. An expired token is fine here: the card only needs identity and
    // expiry to paint, and the follow-up full document still validates it.
    credential = fast ? await store.current() : await store.resolve()
    // With nothing known locally there is nothing to paint either; `resolve()`
    // then only classifies WHY (it makes no network call without a credential),
    // so the first paint still gets the same diagnosis as the full document.
    if (credential === undefined) credential = await store.resolve()
  } catch (error: unknown) {
    // Account selection must remain available even when the selected token is
    // expired or its refresh request fails. Report that as account-level
    // status instead of converting the entire route into HTTP 500.
    //
    // `selectionLost` lets the card tell the two causes apart: an orphaned
    // saved id (the tokens here are fine — re-pick or clear) versus a genuinely
    // signed-out machine (the "sign in again" hint is then accurate).
    const webAccounts = accounts.map(toWebAccount)
    return {
      status: 'signed-out',
      accounts: webAccounts,
      message: safeMessage(error),
      selectionExplicit,
      enabled,
      showCreditsInMainUi,
      creditPosition,
      imageToolEnabled,
      videoToolEnabled,
      preferredVideoModels,
      cliBridgeEnabled,
      cliBridgeModel,
      cliBridgeEffort,
      cliBridgeRegionOrder,
      dropForeignThinking,
      ...lastForeignThinking === undefined ? {} : { lastForeignThinking },
      busyLevels,
      ...await store.selectionLost() ? { selectionLost: true } : {},
      // Only the genuinely empty machine gets the probe list. When local
      // sign-ins DO exist (the orphaned-saved-id case), the card already has
      // the right advice and a list of failed paths would bury it.
      ...webAccounts.length === 0 ? await searchedPaths(store) : {},
    }
  }
  // Only user-facing identity and expiry cross to the browser. Token material
  // and stable user IDs stay on the Host.
  const selected = accounts.find(account => account.selected)
  const account = {
    accountId: selected?.id ?? '',
    // The human name only; '' lets the card render its own placeholder. A bare
    // `uin`/`uid` is an identifier, not a name, and showing one made the account
    // read as "unknown user" instead of simply unnamed.
    accountName: preferredAccountName(credential),
    ...credential.domain === '' ? {} : { domain: credential.domain },
    region,
    source: credential.source,
    tokenExpiresAtMs: credential.expiresAtMs,
    selectionExplicit,
    enabled,
    showCreditsInMainUi,
    creditPosition,
    imageToolEnabled,
    videoToolEnabled,
    preferredVideoModels,
    cliBridgeEnabled,
    cliBridgeModel,
    cliBridgeEffort,
    cliBridgeRegionOrder,
    dropForeignThinking,
    ...lastForeignThinking === undefined ? {} : { lastForeignThinking },
    busyLevels,
    accounts: accounts.map(toWebAccount),
    // Stamped with what the plugin OBSERVED, not just what the catalog declares:
    // `displayModels` is the saved/live directory and knows nothing about a
    // refusal the shim recorded, so the badge would never appear on the one row
    // it exists for (issue #83).
    models: deps.displayModels(region)
      .map(model => toWebModel(model, deps.contextBudgets(region)))
      .map(model => model.reasoning === undefined || lastRefusalFor(model.id) === undefined
        ? model
        : { ...model, reasoning: { ...model.reasoning, refusesOff: true } }),
    enabledModelIds: [...deps.enabledModelIds(region)],
    imageModelIds: [...deps.imageModelIds(region)],
    offModelIds: [...deps.offModelIds(region)],
  }
  // The first paint carries no live figures at all: this is the await that used
  // to make the account list wait on a billing endpoint (issue #77).
  const figures: WorkBuddyLiveFigures = fast
    ? {}
    : await liveFigures(deps, region, credential, selected)
  // "· N 新模型": which ids of THIS region's roster this machine first saw inside
  // the new-model window. READ-ONLY — the catalog reconciler is the only writer
  // of first-sighting history, so this route can never change "who is new" no
  // matter how often the card or pill polls it. Absent for a Host that predates
  // the feature, which renders no segment at all.
  const rosterSeen = deps.rosterSeen === undefined ? undefined : await deps.rosterSeen(region)
  return {
    status: 'signed-in',
    // The persisted per-region budgets, read straight from the Host config.
    // The browser settings mirror can be stale — a write made through the Host
    // save endpoint never updates it — so the card renders these instead of
    // re-deriving them from a snapshot that may predate the save.
    contextBudgets: Object.fromEntries(
      Object.entries(deps.contextBudgets(region)).filter(([, value]) => typeof value === 'number'),
    ) as Record<string, number>,
    // The saved per-model default tiers (issue #179), for exactly the same
    // reason as the budgets above: the card must render what the Host will
    // DISPATCH, not a settings snapshot that this very endpoint's writes never
    // refresh. Only string values survive the filter, so a malformed entry
    // reads as "follow the upstream default" rather than as a broken row.
    defaultThinkingEfforts: Object.fromEntries(
      Object.entries(deps.defaultThinkingEfforts?.(region) ?? {})
        .filter(([, value]) => typeof value === 'string' && value !== ''),
    ) as Record<string, string>,
    // Host-side liveness probe for the settings write gate (diagnostic; see
    // the __save endpoint for why this is worth exposing). `dict`/`meta` are
    // schemastery internals the public typings do not describe, so the shape is
    // named here rather than widened to `any`.
    diagVolatile: {
      regions: volatileFlagOf('regions'),
      accounts: volatileFlagOf('accounts'),
      authFile: volatileFlagOf('authFile'),
    },
    ...account,
    // The new-model segment's data. Spreads are conditional because both fields
    // are optional on the document shape (`exactOptionalPropertyTypes`).
    ...rosterSeen === undefined ? {} : {
      newModelIds: [...rosterSeen.newModelIds],
      ...rosterSeen.versionNote === undefined ? {} : { rosterSeenVersionNote: rosterSeen.versionNote },
    },
    ...figures,
    // The pool is assembled last and never allowed to fail the document: it is
    // an enhancement, and a credits read that failed inside it must not take
    // the whole status route down with it (the card would then show nothing at
    // all, including the account picker the user needs to recover).
    ...await poolSectionOf(deps, region, fast),
  }
}

/**
 * The pool block for a status document, or nothing when it cannot be built.
 *
 * `fast` asks for the first-paint variant: local state only, no upstream call.
 * A Host without a local member source then omits the block rather than paying
 * the full read, so a first-paint document never regresses into the expensive
 * path this mode exists to avoid.
 */
async function poolSectionOf(
  deps: WorkBuddyStatusRouteOptions,
  region: WorkBuddyRegion,
  fast: boolean,
): Promise<{ pool?: WorkBuddyWebPool }> {
  if (deps.pool === undefined) return {}
  try {
    const pool = await workBuddyWebPool(deps, region, fast)
    return pool === undefined ? {} : { pool }
  } catch {
    return {}
  }
}

/**
 * Assemble one region's pool state for the card.
 *
 * The ranking is computed HERE, on the Host, and shipped as an ordered,
 * annotated list. The card therefore never re-derives "who is eligible" — it
 * renders the Host's answer, so the account the user sees marked as current is
 * decided by the same rule that would actually bill.
 *
 * `current` is answered by the Host too (`currentAccountId`), not inferred from
 * the ranking, because those are different questions: the ranking says who
 * SHOULD serve, `current` says who IS serving. Marking the winner as current
 * would make the card claim a switch that may not have been applied yet.
 */
async function workBuddyWebPool(
  deps: WorkBuddyStatusRouteOptions,
  region: WorkBuddyRegion,
  fast = false,
): Promise<WorkBuddyWebPool | undefined> {
  const pool = deps.pool
  if (pool === undefined) return undefined
  const preferences = pool.preferences(region)
  // THE first-paint decision (issue #77): the local source answers with saved
  // members and whatever credit reading a previous document already recorded,
  // so the account table never waits on one billing request per account. No
  // local source means no pool block in a first-paint document — the card then
  // waits for the full document, which is exactly the pre-#77 behaviour.
  const members = fast ? await pool.localMembers?.(region) : await pool.members(region)
  if (members === undefined) return undefined
  const nowMs = Date.now()
  const ranked = rankPool(members, nowMs, preferences.orderAccountIds)
  const catalog = pool.catalog?.(region) ?? []
  const target = resolveTargetModel(catalog, preferences.targetModelId)
  const currentAccountId = await pool.currentAccountId?.(region)
  const byId = new Map(members.map(member => [member.account.id, member]))
  const rankedIds = new Set(ranked.map(row => row.account.id))

  // Ranked members first (they can actually serve), then every other local
  // sign-in the user could still check in. Unchecked accounts are listed so
  // membership can be granted from the card — an opt-in nobody can see is not
  // an opt-in. They carry no credits or measurement, because neither has been
  // read for an account the pool does not cover.
  const others = await pool.otherAccounts?.(region) ?? []
  // Best-effort: a failure here leaves the column UNKNOWN, which is honest,
  // rather than asserting a state nobody read. The first paint reads the
  // already-measured cells only (no per-account request), so it can report
  // nothing at all; the full document fills the column in later.
  const checkedIn: Readonly<Record<string, boolean>> = fast
    ? pool.cachedCheckedInToday?.(region) ?? {}
    : await pool.checkedInToday?.(region).catch(() => ({} as Record<string, boolean>))
      ?? {} as Record<string, boolean>
  // Claimable benefits per account (issue #79). Read the same two ways as the
  // check-in column: the first paint uses this process's readings (no request),
  // the full document pays for two status calls per account. A failed or absent
  // read leaves the row without a benefit line, which is the same shape as
  // "nothing to claim" — by design, a benefit line only ever announces that
  // something IS there.
  const claimable: Readonly<Record<string, readonly WorkBuddyBenefitView[]>> = fast
    ? pool.cachedBenefits?.(region) ?? {}
    : await pool.benefits?.(region).catch(() => ({} as Record<string, readonly WorkBuddyBenefitView[]>))
      ?? {} as Record<string, readonly WorkBuddyBenefitView[]>
  const rows: readonly {
    account: { id: string, accountName: string, enterprise?: boolean }
    member: boolean
    ranked?: (typeof ranked)[number]
  }[] = [
    ...ranked.map(row => ({
      account: row.account,
      member: true,
      ranked: row,
    })),
    ...others
      .filter(account => !rankedIds.has(account.id))
      .map(account => ({ account, member: false })),
  ]

  /**
   * Names for saved members the roster above does NOT contain (issue #60).
   *
   * Read for the SAVED ids only, and only from the measurement record: those
   * are exactly the accounts the card cannot name from `accounts`, because
   * nothing about them is left on this machine except the fact that they were
   * once measured. Best-effort — a failed read names nothing, and the card
   * falls back to an id prefix rather than inventing a label.
   */
  const memberNames = await pool.memberNames?.(region).catch(() => undefined) ?? undefined

  const accounts: WorkBuddyWebPoolAccount[] = rows.map(({ account, member, ranked: row }) => {
    const measured = byId.get(account.id)
    return {
      accountId: account.id,
      accountName: account.accountName,
      ...account.enterprise === true ? { enterprise: true } : {},
      ...measured?.credits === undefined ? {} : {
        credits: measured.credits.total,
        expiringSoon: measured.credits.expiringSoon,
        ...measured.credits.nearestExpiryMs === undefined
          ? {}
          : { nearestExpiryMs: measured.credits.nearestExpiryMs },
      },
      ...measured?.probe === undefined ? {} : {
        probe: {
          outcome: measured.probe.outcome as WorkBuddyWebProbeOutcome,
          atMs: measured.probe.atMs,
          ...measured.probe.source === undefined ? {} : { source: measured.probe.source },
          ...measured.probe.retryAtMs === undefined ? {} : { retryAtMs: measured.probe.retryAtMs },
          ...measured.probe.message === undefined ? {} : { message: measured.probe.message },
          // WHICH model this measurement is about (issue #61). Without it the
          // row reads as account-level availability, which is exactly how a
          // single-model probe gets mistaken for "this account works".
          ...measured.probe.modelId === undefined ? {} : { modelId: measured.probe.modelId },
        },
      },
      // The model a test of THIS row would use (issue #61) — the per-account
      // override when there is one, otherwise the region target. Sent per row so
      // the card can show it next to the row it applies to instead of implying
      // one model for the whole table.
      ...(() => {
        const perRow = resolveTargetModel(catalog, preferences.targetModelId)
        return {
          ...perRow.modelId === undefined ? {} : { testModelId: perRow.modelId },
          testModelSource: perRow.source,
          ...perRow.staleModelId === undefined ? {} : { staleTestModelId: perRow.staleModelId },
        }
      })(),
      ...row?.excludedBy === undefined ? {} : { excludedBy: row.excludedBy },
      current: account.id === currentAccountId,
      member,
      ...checkedIn[account.id] === undefined ? {} : { checkedInToday: checkedIn[account.id] as boolean },
      ...(() => {
        // Only campaigns that can still be claimed survive this map; a claimed
        // or lapsed one never reaches the card at all (issue #79). The title is
        // resolved here so both clients name a campaign identically.
        const views = claimable[account.id]
        if (views === undefined || views.length === 0) return {}
        return {
          benefits: views.map(view => ({
            kind: view.kind,
            title: WORKBUDDY_BENEFIT_TITLES[view.kind],
            creditNum: view.creditNum,
            ...view.daysLeft === undefined ? {} : { daysLeft: view.daysLeft },
            urgent: view.urgent,
          })),
        }
      })(),
    }
  })

  return {
    enabled: preferences.enabled,
    // Reported so the card can decide whether to render the check-in action at
    // all. The route still refuses the action for an unsupported region, so a
    // stale page cannot reach it by calling the endpoint directly.
    checkinSupported: pool.checkinSupported?.(region) === true,
    ...target.modelId === undefined ? {} : { targetModelId: target.modelId },
    ...target.staleModelId === undefined ? {} : { staleTargetModelId: target.staleModelId },
    targetModelSource: target.source,
    // The SAVED per-account overrides, verbatim (issue #61) — deliberately not
    // rewritten to the effective value, for the same reason the member list is
    // not: a silently dropped id would destroy the user's record of what they
    // chose, and the model can come back in a later catalog.
    // The SAVED list, verbatim. Deliberately not rewritten to the effective
    // set: silently dropping ids would destroy the user's record of what they
    // chose, and a login can come back (the desktop app re-adds it) in which
    // case the saved id should apply again.
    memberAccountIds: preferences.memberAccountIds,
    // The user's manual pool order, SANITIZED to ids that still resolve to a
    // actually listed account. The saved list is independent of membership and
    // may carry ids whose sign-in has gone since the user last dragged them into
    // place; shipping those would let the card render an ordering over accounts
    // it cannot even name. Dropping them on transmit (never rewiring them into
    // membership) keeps the saved preference intact for when the login returns.
    // An empty list omits the key entirely — "no manual order" must not read as
    // "all accounts sorted last" (exactOptionalPropertyTypes; see `rankPool`).
    ...(() => {
      const listed = new Set(accounts.map(account => account.accountId))
      const orderedIds = (preferences.orderAccountIds ?? []).filter(id => listed.has(id))
      return orderedIds.length === 0 ? {} : { orderAccountIds: orderedIds }
    })(),
    // The probe size the user chose, verbatim (`0` = the host's default). Sent
    // rather than resolved so the dropdown can show "默认" as a state distinct
    // from "25000": resolving here would make the card claim the user picked a
    // size they never touched, and the next save would write that number back.
    ...preferences.probeInputTokens === undefined ? {} : { probeInputTokens: preferences.probeInputTokens },
    // The ids that actually resolve to a listed account, i.e. what a batch will
    // run on. Sent explicitly so the card never has to re-derive it: deriving
    // it in the browser is what let the UI claim "1 of 1 selected" while the
    // Host ran on zero accounts.
    effectiveMemberAccountIds: effectiveMembersOf(
      accounts.map(account => account.accountId),
      new Set(preferences.memberAccountIds),
    ),
    // Best-effort, and only for the ids the card cannot label itself: a saved
    // member that still resolves has a live name in `accounts` above, so
    // shipping those too would give the card two sources that could disagree.
    // A read failure degrades to "unknown name", which the card renders as an
    // id prefix — never to a wrong name.
    ...memberNames === undefined ? {} : { memberNames },
    accounts,
    // The same displayed roster the model table uses, so the pool's manual
    // picker can never offer a model id the rest of the card does not know —
    // but TRIMMED to the three fields the picker renders. The model table
    // already ships the full records in this same document, and the card
    // re-reads it every 60 seconds.
    catalog: deps.displayModels(region).map(model => ({
      id: model.id,
      name: model.name,
      ...model.creditMultiplier === undefined ? {} : { creditMultiplier: model.creditMultiplier },
      ...model.busyLevel === undefined ? {} : { busyLevel: model.busyLevel },
    })),
  }
}

/**
 * The region a request addresses, or a 400 answer. Absent parameter means the
 * domestic tab; an unknown value is refused rather than guessed.
 */
function requestRegion(req: IncomingMessage, res: ServerResponse): WorkBuddyRegion | undefined {
  const region = regionOfStatusUrl(req.url ?? '/')
  if (region === undefined) {
    json(res, 400, { error: 'unknown region' })
    return undefined
  }
  return region
}

/**
 * Mount the read-only routes on a context where `webServer` is available.
 * The caller uses `ctx.inject(['webServer'], ...)`, so Desktop startup order
 * cannot make this registration disappear.
 */
export function registerWorkBuddyStatusRoute(ctx: Context, deps: WorkBuddyStatusRouteOptions): void {
  ctx.effect(() => {
    const disposeUsage = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_USAGE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        if (!requireLoopback(req, res)) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        // `detail=fast` is the card's first paint (issue #77): local state only,
        // so the account list appears in one round trip no matter how slowly a
        // billing endpoint answers. Absent or unrecognized means the full
        // document, which is what every earlier caller gets.
        const detail = fastDetailOf(req.url ?? '') ? 'fast' : 'full'
        try {
          json(res, 200, await workBuddyWebStatus(deps, region, { detail }))
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    const disposeAccountCredits = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_ACCOUNT_CREDITS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        if (!requireLoopback(req, res)) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        try {
          json(res, 200, { accounts: await workBuddyAccountCredits(deps, region) })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    const disposeAccounts = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_ACCOUNTS_REFRESH_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!requireLoopback(req, res)) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        try {
          const store = deps.store(region)
          // A MANUAL scan is the user asking what this machine currently has,
          // so it also clears the accounts they removed earlier. Those removals
          // exist to survive the AUTOMATIC poll (a hidden desktop account must
          // not pop back a minute later); this button is the explicit way back,
          // and without it a removed desktop account could never return.
          //
          // The answer is VERIFIED, not assumed, and travels to the card: on
          // Windows a locked file can defeat both the unlink and the rewrite
          // (see `clearDismissals`), and silently returning a still-hidden list
          // would leave the user pressing a button that reports success while
          // the account they want back stays invisible.
          const dismissalsCleared = await store.clearDismissals()
          const accounts = await store.accounts()
          deps.regionUsable?.(region, accounts.length > 0)
          json(res, 200, { accounts: accounts.map(toWebAccount), dismissalsCleared })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    const disposeCheckin = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_CHECKIN_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!requireLoopback(req, res)) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        try {
          const credential = await deps.store(region).resolve()
          const current = await deps.client.fetchCheckinStatus(credential)
          if (!current.active) return json(res, 409, { error: 'check-in activity is not active' })
          if (current.todayCheckedIn) return json(res, 200, { alreadyCheckedIn: true, checkin: current })
          const claim = await deps.client.claimDailyCheckin(credential)
          const checkin = await deps.client.fetchCheckinStatus(credential)
          json(res, 200, { alreadyCheckedIn: false, claim, checkin })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    const disposeBenefitClaim = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_BENEFIT_CLAIM_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        // A credit grant on a real account. Same guards as check-in (write +
        // loopback), and it requires an explicit account because the click is
        // always made ROW BY ROW in the card: there is no batch action, so no
        // request can spend six accounts' entitlements in one call.
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!requireLoopback(req, res)) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const accountId = url.searchParams.get(WORKBUDDY_POOL_ACCOUNT_PARAM)
        const kind = url.searchParams.get('kind')
        if (accountId === null || accountId === '') {
          return json(res, 400, { error: 'accountId is required' })
        }
        if (kind !== 'compensation' && kind !== 'gift') {
          return json(res, 400, { error: 'kind must be compensation or gift' })
        }
        try {
          // Resolve the credential for THIS account, not the signed-in default:
          // a claim must never be redirected onto whichever account the pool
          // happens to prefer at that moment.
          const credential = await deps.store(region).credentialFor(accountId)
          if (credential === undefined) return json(res, 404, { error: 'no credential for this account' })
          // The upstream's READ endpoints advertise campaigns to enterprise
          // members even though every WRITE answers `10001 企业账号不支持该操作`.
          // Refuse here so the card cannot turn a known-unsupportable click into
          // an opaque upstream 500 (issue #129).
          if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
            return json(res, 409, { error: 'enterprise-account-unsupported' })
          }
          // Re-read before writing. The status is read first so a stale card
          // cannot cause a pointless call, and so this route states the same
          // rule the card renders: claimable means inside the window and not yet
          // taken. The upstream rejects a second claim, but asking it anyway
          // makes an already-claimed row look like an upstream fault.
          const current = await deps.client.fetchBenefits(credential)
          const target = current.find(benefit => benefit.kind === kind)
          if (target === undefined) return json(res, 404, { error: 'benefit not available on this account' })
          if (target.claimed) return json(res, 409, { error: 'benefit already claimed', benefit: target })
          if (!target.active) return json(res, 409, { error: 'benefit activity is not active', benefit: target })
          await deps.client.claimBenefit(credential, kind)
          // Drop the cached reading BEFORE answering, so the status read the card
          // fires next is live rather than a 30-minute-old snapshot. Ordering is
          // the point: the client awaits its refresh, so by the time the pill is
          // re-rendered this account's cache entry is already gone. Skipping this
          // is what left 领取 on screen after a SUCCESSFUL claim (issue #79).
          deps.pool?.invalidateBenefit?.(region, accountId)
          // Answer with what the gateway says NOW, not with an assumption. The
          // card repaints from this reading, so a claim that did nothing still
          // cannot leave a 待领取 line behind.
          const after = await deps.client.fetchBenefits(credential)
          json(res, 200, { claimed: true, benefit: after.find(benefit => benefit.kind === kind) ?? target })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    const disposeRefresh = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_MODELS_REFRESH_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!requireLoopback(req, res)) return
        if (deps.discoverModels === undefined) return json(res, 503, { error: 'model refresh unavailable' })
        const region = requestRegion(req, res)
        if (region === undefined) return
        try {
          // The refreshed catalog belongs to the requested region, so its
          // context budgets come from that same region's slot.
          const models = await deps.discoverModels(region)
          json(res, 200, { models: models.map(model => toWebModel(model, deps.contextBudgets(region))) })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    const disposeMediaModels = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_MEDIA_MODELS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!requireLoopback(req, res)) return
        if (deps.mediaModels === undefined) return json(res, 503, { error: 'media model list unavailable' })
        const region = requestRegion(req, res)
        if (region === undefined) return
        try {
          // Read-only and free, but still behind POST + loopback like every
          // other route: it takes a region and answers with what that account's
          // product configuration publishes, which is account-scoped data.
          // An empty list is a legitimate answer (a gateway that publishes no
          // media model), not an error — the card renders it as such.
          // `refresh=1` bypasses the Host's 5-minute cache. The card's list is
          // read-only, but a user who just enabled an image model upstream must
          // not have to wait out a TTL to see it.
          const refresh = new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1'
          const models = await deps.mediaModels(region, { refresh })
          json(res, 200, {
            models: models.map(model => ({ id: model.id, name: model.name, tags: [...model.tags] })),
          })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    const disposeProbe = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_PROBE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!requireLoopback(req, res)) return
        if (deps.probeModels === undefined) return json(res, 503, { error: 'model probe unavailable' })
        const region = requestRegion(req, res)
        if (region === undefined) return
        try {
          const body = await readJsonBody(req) as { modelIds?: unknown }
          const modelIds = Array.isArray(body.modelIds)
            ? body.modelIds.filter((id): id is string => typeof id === 'string' && id !== '')
            : []
          // An empty list is a client bug, not "nothing to report": answering an
          // empty success would let the card render a finished batch that never
          // ran. Refuse it so the failure is visible.
          if (modelIds.length === 0) return json(res, 400, { error: 'modelIds must be a non-empty array of strings' })
          // Every probe now sends a real-volume request, which costs real credits
          // (measured `credit: 0.72` each). The card drives one model per click,
          // so a request naming more than one is NOT the card — and refusing it
          // is what keeps a stale bundle or a hand-rolled client from turning a
          // button into a spend loop over a whole roster.
          if (modelIds.length > 1) {
            return json(res, 400, { error: 'a probe accepts exactly one model' })
          }
          // Still sequential: a probe exists to discover rate limits, and firing
          // requests at once is the surest way to create one.
          const results: WorkBuddyWebProbeResult[] = []
          for (const modelId of modelIds) {
            results.push(...await deps.probeModels(region, [modelId]))
          }
          json(res, 200, { results })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    const disposeTps = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_TPS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!requireLoopback(req, res)) return
        if (deps.measureTps === undefined) return json(res, 503, { error: 'tps measurement unavailable' })
        const region = requestRegion(req, res)
        if (region === undefined) return
        try {
          const body = await readJsonBody(req) as { modelIds?: unknown }
          const modelIds = Array.isArray(body.modelIds)
            ? body.modelIds.filter((id): id is string => typeof id === 'string' && id !== '')
            : []
          if (modelIds.length === 0) return json(res, 400, { error: 'modelIds must be a non-empty array of strings' })
          // One model per request, for the same reason the probe route enforces
          // it: a speed run is THREE real requests, and a batch routed through
          // one call would turn a stale bundle into an unaccounted spend over a
          // whole roster. The card's sweep loop lives on the client side.
          if (modelIds.length > 1) {
            return json(res, 400, { error: 'a tps measurement accepts exactly one model' })
          }
          const results: WorkBuddyWebTpsResult[] = []
          for (const modelId of modelIds) {
            results.push(...await deps.measureTps(region, [modelId]))
          }
          const answer: WorkBuddyWebTpsAnswer = { results }
          json(res, 200, answer)
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    const disposePool = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_POOL_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        // Both actions are writes: check-in claims a reward on the user's real
        // account, and a test spends real credits. So POST + loopback, the same
        // guards the card's other mutations carry.
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!requireLoopback(req, res)) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        const action = poolActionOf(req.url ?? '/')
        if (action === undefined) {
          return json(res, 400, { error: 'action must be checkin, test, or remove' })
        }
        const pool = deps.pool
        if (pool === undefined) {
          return json(res, 503, { reason: 'pool-unavailable', error: 'account pool unavailable' })
        }
        // ---- Per-row actions: address ONE account, never the batch. ----
        const rowAccountId = poolAccountIdOf(req.url ?? '/')
        if (action === 'remove') {
          if (pool.removeOne === undefined) {
            return json(res, 503, { reason: 'pool-unavailable', error: 'per-account removal unavailable' })
          }
          if (rowAccountId === undefined) {
            return json(res, 400, { error: 'accountId must name the account to remove' })
          }
          // The id is about to become a file path segment on the store side;
          // reject anything that is not a well-formed id HERE so a malformed
          // request is a 400 rather than a thrown error the client sees as a
          // 500. `removeAccount` re-checks it — defence in depth, not the only
          // guard.
          if (!isVaultAccountId(rowAccountId)) {
            return json(res, 400, { error: 'accountId is not a well-formed account id' })
          }
          try {
            const removed = await pool.removeOne(region, rowAccountId)
            json(res, 200, { action: 'remove', accountId: rowAccountId, removed })
          } catch (error: unknown) {
            json(res, 500, { reason: 'pool-failed', error: safeMessage(error) })
          }
          return
        }
        if (action === 'test' && rowAccountId !== undefined) {
          if (pool.testOne === undefined) {
            return json(res, 503, { reason: 'pool-unavailable', error: 'per-account test unavailable' })
          }
          try {
            const row = await pool.testOne(region, rowAccountId)
            // Undefined = the region cannot name a target model, the SAME
            // refusal the batch reports as 409 (reason makes it localizable).
            if (row === undefined) {
              return json(res, 409, { action: 'test', modelId: undefined, rows: [], reason: 'no-free-model', error: 'no zero-multiplier model in this region; refresh the catalog or set a target model' })
            }
            json(res, 200, { action: 'test', rows: [row] })
          } catch (error: unknown) {
            json(res, 500, { reason: 'pool-failed', error: safeMessage(error) })
          }
          return
        }
        try {
          // The pool's switch is deliberately NOT enforced here.
          //
          // It gates AUTOMATIC routing — whether the plugin picks the serving
          // account by itself and retries on another after a failure — not
          // whether the user may act on the accounts they checked. Refusing the
          // batch when it is off left a user with the pool off no way to check
          // in or test anything at all: the card disabled the buttons AND the
          // Host refused the request, so "manual" had no manual path.
          //
          // Membership is an explicit opt-in, so an empty pool runs NOTHING.
          // Enforced here as well as in the card: "no accounts checked" must
          // never degrade into "then do all of them" — that is the one reading
          // which would spend credits the user never authorized.
          //
          // Judged on RESOLVABLE members, not the saved list. A saved id whose
          // sign-in has gone resolves to no credential, so a batch over it would
          // touch nothing while reporting success — the exact "announced a test
          // that never happened" symptom. A host that cannot answer (older
          // build) falls back to the saved list, which is no worse than before.
          const savedMembers = pool.preferences(region).memberAccountIds
          const effective = await pool.effectiveMemberAccountIds?.(region)
            .catch(() => undefined)
          const runnable = effective ?? savedMembers
          if (runnable.length === 0) {
            // Two causes, two different fixes: "you never checked anything" vs
            // "everything you checked has lost its local sign-in". They must be
            // separate REASONS, not merely separate English sentences — the card
            // PREFERS `reason` over `error` (AccountPool.tsx:585) and only falls
            // back to `error` when no reason is sent, so folding them into one
            // reason made this distinction dead code and told a user with ghost
            // members to "check at least one account" when the real fix is to
            // sign in again (or save to drop them).
            const noneChecked = savedMembers.length === 0
            return json(res, 409, {
              reason: noneChecked ? 'no-members' : 'no-live-members',
              error: noneChecked
                ? 'no accounts are checked into this region\'s pool'
                : 'no checked account still has a local sign-in',
            })
          }
          if (action === 'checkin') {
            // Refuse BEFORE reaching the client: a region without a daily
            // check-in must not spend a request learning that, and the card that
            // hides the button is the UI half of the same rule. Reported as a
            // capability refusal rather than a failure, so a caller can tell
            // "not offered here" from "offered, but it broke".
            if (pool.checkinSupported?.(region) !== true) {
              return json(res, 409, {
                reason: 'checkin-unsupported',
                error: 'this region does not offer a daily check-in',
              })
            }
            if (pool.checkin === undefined) {
              return json(res, 503, { reason: 'pool-unavailable', error: 'pool check-in unavailable' })
            }
            const rows = await pool.checkin(region)
            return json(res, 200, { action: 'checkin', rows })
          }
          if (pool.test === undefined) {
            return json(res, 503, { reason: 'pool-unavailable', error: 'pool test unavailable' })
          }
          const preferences = pool.preferences(region)
          const catalog = pool.catalog?.(region) ?? []
          /**
           * The model ONE member is tested on (issue #61).
           *
           * ONE model for the whole batch, and it is also the gate: if the region
           * cannot name a target model the card is told to pick one before any
           * credits are spent. Every member is therefore measured on the SAME
           * model, which is what makes a green batch mean one thing. Resolution
           * runs through `resolveTargetModel`, so a stale target is reported,
           * never silently swapped for another model.
           */
          const target = resolveTargetModel(catalog, preferences.targetModelId)
          if (target.modelId === undefined) {
            // Two distinct causes, each with its own fix, and the card shows the
            // matching one. NOT a silent fallback to a paid model: the whole
            // point of resolving a free target is that a batch test stays free.
            return json(res, 409, {
              action: 'test',
              modelId: undefined,
              rows: [],
              // A machine-readable cause so the card can localize it rather
              // than echoing this English sentence to a Chinese UI.
              reason: target.source === 'stale' ? 'target-model-stale' : 'no-free-model',
              error: target.source === 'stale'
                ? 'the saved target model is no longer offered by this region; pick another or switch back to automatic'
                : 'no zero-multiplier model in this region; refresh the catalog or set a target model',
            })
          }
          // STREAM one line per account instead of holding the whole batch.
          //
          // The batch is serial on purpose (driving the whole pool at once is the
          // fastest way to trip the upstream's volume limit), so a single
          // response meant the card could say nothing until the SLOWEST member
          // answered. With a stuck account that is seconds of a dead-looking
          // button and no way to tell which member was the problem. NDJSON keeps
          // the ordering and the one-batch semantics while letting each row land
          // as it happens.
          //
          // The status code is already committed once the first line is written,
          // so a mid-batch failure travels as a LINE rather than as a 500 — the
          // client treats it as the batch's error, which is what it is.
          //
          // Measurements are persisted by the Host's own `test` implementation,
          // never here: doing it in this layer as well would write the same facts
          // twice and could interleave with a concurrent batch.
          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            // Proxies must not buffer this: progress the user cannot see is
            // exactly the defect being fixed.
            'X-Accel-Buffering': 'no',
          })
          const writeLine = (payload: unknown): void => {
            res.write(`${JSON.stringify(payload)}\n`)
          }
          writeLine({ action: 'test', modelId: target.modelId })
          try {
            await pool.test(region, target.modelId, row => { writeLine({ row }) })
            writeLine({ done: true })
          } catch (error: unknown) {
            writeLine({ reason: 'pool-failed', error: safeMessage(error) })
          }
          res.end()
          return
        } catch (error: unknown) {
          json(res, 500, { reason: 'pool-failed', error: safeMessage(error) })
        }
      },
    })
    const disposeDiagWrite = ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-connect-workbuddy/__save',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!requireLoopback(req, res)) return
        // Host-side save path: on DSH 0.1.7 the browser-side ConfigForm never
        // delivered a write on this deployment while the Host-side mutate is
        // proven healthy by direct probe, so the card saves through this
        // endpoint instead. The settings service runs inside the Host process
        // and a refusal surfaces as the raw exception, not ok:false.
        const settings: any = (ctx as any).get?.('settings')
        if (settings === undefined) return json(res, 503, { error: 'settings service unavailable to this fiber' })
        try {
          const body = await new Promise<Record<string, unknown>>((resolve, reject) => {
            const chunks: Buffer[] = []
            req.on('data', (chunk: Buffer) => chunks.push(chunk))
            req.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(e) }
            })
            req.on('error', reject)
          })
          const field = body.field
          // `cliBridge` is a GLOBAL scalar bag, not a region map: it skips the
          // region machinery (sibling slots, catalog seeding) and is merged one
          // level through `nextCliBridgeSettings` below.
          //
          // The upstream-identity switches are top-level fields and are handled
          // in their own branch below; they need no merge base because each is a
          // complete independent value. They exist here so the card can drive
          // them without a config-file hand edit (issue #133 suggestions 2 and
          // 3), and they are NOT folded into `cliBridge`: they govern the request
          // path every provider shares, not the CodeBuddy CLI route, so turning
          // the CLI route off must not look like it reset them.
          if (field !== 'regions' && field !== 'accounts' && field !== 'cliBridge'
            && !(typeof field === 'string' && UPSTREAM_SWITCH_FIELDS.has(field))) {
            return json(res, 400, { error: 'field must be regions, accounts, cliBridge, usageIdentity, keepPromptLast, extraInjectedPrefixes, sessionTitle, dropForeignThinking or channelRejectContinue' })
          }
          const rows = settings.describe()
          const row = rows.find((r: any) => String(r.ns).includes('workbuddy'))
          if (row === undefined) return json(res, 503, { error: 'workbuddy namespace missing from describe()' })
          // `row.value` is the settings service's resolved config, where a
          // volatile field (regions / accounts) is a `{get(): T}` LIVE
          // reference, not the plain object it looks like. Spreading that
          // object leaks the reference function into the write payload —
          // `{ ...{ get(){} } }` is `{ get: <function> }` — and the strict
          // JSON-compatibility check on mutate then rejects the save with
          // "found a function at $.ops[0].value.get". Deep-unwrap first so the
          // merge never carries a function.
          //
          // `regions` goes through `regionsMapOf` instead: it unwraps the same
          // reference and additionally drops the sibling-field copies an older
          // build wrote into the field (the "restart reset" report). Merging
          // onto the RAW field would carry `accounts` / `cliBridge` / a nested
          // `regions` copy back into every save — the document would never get
          // clean even after the writer that produced the wreckage was fixed.
          const current = field === 'regions'
            ? regionsMapOf(row.value?.[field])
            : unwrapVolatileDeep(row.value?.[field] ?? {}) as Record<string, unknown>
          // Same narrowing for the posted value: a browser bundle from an
          // earlier build still sends the dirty map as its merge base.
          const incoming = field === 'regions'
            ? regionsMapOf(body.value)
            : (body.value ?? {}) as Record<string, unknown>
          if (field === 'cliBridge') {
            if (!isPlainRecord(incoming)) return json(res, 400, { error: 'cliBridge value must be an object' })
            const mergedBridge = nextCliBridgeSettings(current, incoming)
            await settings.mutate(row.ns, [{ op: 'set', path: [field], value: mergedBridge }], undefined)
            // Answer the committed block, so the card can mirror the truth
            // instead of re-deriving it from its (documented-stale) mirror.
            return json(res, 200, { ok: true, value: mergedBridge })
          }
          // The upstream-identity switches, written as their OWN top-level
          // fields (`usageIdentity` / `keepPromptLast` / `extraInjectedPrefixes`
          // / `sessionTitle`). No wrapper bag and no merge base: each is a
          // complete, independent scalar, so `set` on its own path is exactly
          // what the schema declares and cannot clobber a sibling.
          if (UPSTREAM_SWITCH_FIELDS.has(field)) {
            await settings.mutate(row.ns, [{ op: 'set', path: [field], value: body.value }], undefined)
            return json(res, 200, { ok: true, value: { [field]: body.value } })
          }
          // Merge TWO levels, and the second level is what stops a save from
          // DELETING data.
          //
          // Level 1 (keys of the field) keeps sibling regions alive.
          //
          // Level 2 (keys of a touched region's slot) exists because the client
          // can only send the slot it knows, and its settings mirror is
          // explicitly documented as unreliable for this namespace (a write made
          // through this very endpoint does not refresh it, and on 0.1.7 it can
          // stay stale outright). A one-level `{ ...current, ...incoming }`
          // replaces the WHOLE region slot with whatever the client happened to
          // hold, so every field it did not mention is dropped. Measured on a
          // real Windows profile: saving pool preferences posted `{ cn: { pool } }`,
          // which deleted `cn.lastCatalog` (a ~6 KB model directory),
          // `enabledModelIds`, `contextBudgets` and `enabled`. The card then
          // resolved the saved target model against the STATIC fallback catalog,
          // which does not contain it, and reported the model as withdrawn
          // ("已下架") with testing disabled — a save that silently destroyed
          // settings while reporting success.
          //
          // Only OMITTED keys are preserved: a field the client does send still
          // wins, including an explicit empty array, so clearing a selection
          // remains possible. Deliberately not deeper than the slot: a nested
          // map such as `contextBudgets` is sent whole by its owner, and
          // recursing further would make it impossible to remove an entry.
          const merged: Record<string, unknown> = { ...current }
          for (const [key, slot] of Object.entries(incoming)) {
            const prior = current[key]
            merged[key] = isPlainRecord(prior) && isPlainRecord(slot)
              ? { ...prior, ...slot }
              : slot
          }
          // A region slot must never be persisted without a model directory
          // (issue #32). The merge above preserves an OMITTED `lastCatalog`, but
          // it cannot invent one: on a profile where no write ever succeeded yet
          // (`current` has no `cn` key at all), a partial payload such as
          // `{cn:{imageModelIds:[]}}` created a slot with NO `lastCatalog`, and
          // the read side then resolved that slot against the STATIC roster and
          // overwrote the live catalog — silently deleting the user's in-use
          // model. Seeding the directory from what this region is CURRENTLY
          // serving keeps the first save complete, and only applies when the
          // slot genuinely has no directory of its own: an explicit array from
          // the caller still wins, including an empty one.
          if (field === 'regions') {
            // Only regions this payload actually touches: seeding a sibling the
            // caller never mentioned would write fields the save was not about.
            for (const key of Object.keys(incoming)) {
              const slot = merged[key]
              if (!isPlainRecord(slot) || key !== 'cn' && key !== 'global') continue
              if (Array.isArray(slot.lastCatalog) && slot.lastCatalog.length > 0) continue
              // The live roster, not `discoverModels`: a save must not depend on
              // an upstream round-trip (and must not fail because one is down),
              // and `displayModels` already prefers the live directory.
              const live = deps.displayModels(key as WorkBuddyRegion)
              if (live.length === 0) continue
              // NEVER SEED THE STATIC FALLBACK TABLE (issue #114's root cause).
              // `displayModels` falls back to that table whenever the upstream
              // has not answered yet — and on a cold start, that is exactly the
              // moment a first save happens. So the table was written into
              // `lastCatalog` as if the user had chosen it, and the table
              // declares NO `reasoning` block: every model in it published with
              // `reasoning: false`, so the host offered only `Default` and
              // `Off`. The card then saved that snapshot back, and the upstream's
              // real tiers could never be learned — a closed loop.
              //
              // So a roster that IS the fallback table is not seeded. The slot
              // simply keeps an empty directory, which the live roster fills
              // as soon as it arrives (and `repairRegionCatalog` writes it
              // down then).
              if (isUnconfiguredFallbackSnapshot(live, key as WorkBuddyRegion)) continue
              slot.lastCatalog = live
            }
          }
          await settings.mutate(row.ns, [{ op: 'set', path: [field], value: merged }], undefined)
          // Hand the AUTHORITATIVE merged field back to the caller. The client
          // used to rebuild the field from its own browser mirror to refresh
          // it, and on a scope that stores whatever it is handed that refresh
          // WROTE THE STALE MIRROR BACK over this merge — deleting the sibling
          // region the Host had just preserved. Returning the merged value lets
          // the caller mirror the truth instead of re-deriving it.
          return json(res, 200, { ok: true, value: merged })
        } catch (error: unknown) {
          const err = error as { name?: string, message?: string }
          return json(res, 500, { ok: false, errorName: err?.name ?? 'unknown', error: err?.message ?? String(error) })
        }
      },
    })
    const disposeOAuth = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_OAUTH_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        // Both steps mutate session state (start) or the vault (poll), so the
        // same write guards as the pool route apply.
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!requireLoopback(req, res)) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        const action = oauthActionOf(req.url ?? '/')
        if (action === undefined) {
          return json(res, 400, { error: 'action must be start or poll' })
        }
        const oauth = deps.oauth
        if (oauth === undefined) {
          return json(res, 503, { reason: 'oauth-unavailable', error: 'OAuth sign-in is not available in this build' })
        }
        try {
          if (action === 'start') {
            json(res, 200, await oauth.start(region))
            return
          }
          const body = await readJsonBody(req) as { loginId?: unknown }
          if (typeof body.loginId !== 'string' || body.loginId === '') {
            return json(res, 400, { error: 'loginId must be a non-empty string' })
          }
          json(res, 200, await oauth.poll(region, body.loginId))
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    const disposeTransfer = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_TRANSFER_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        // Export answers carry TOKEN material, and import/preview ingest
        // arbitrary file text: POST + loopback like every other mutation, so
        // another origin can neither pull credentials nor plant them.
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!requireLoopback(req, res)) return
        const region = requestRegion(req, res)
        if (region === undefined) return
        const action = transferActionOf(req.url ?? '/')
        if (action === undefined) {
          return json(res, 400, { error: 'action must be export, preview, or import' })
        }
        const transfer = deps.transfer
        if (transfer === undefined) {
          return json(res, 503, { reason: 'transfer-unavailable', error: 'account transfer is not available in this build' })
        }
        try {
          if (action === 'export') {
            const body = await readJsonBody(req) as { accountIds?: unknown }
            const accountIds = Array.isArray(body.accountIds)
              ? body.accountIds.filter((id): id is string => typeof id === 'string' && id !== '')
              : []
            // An empty selection is a client bug, not "nothing to export":
            // answering an empty success would write an empty (and useless)
            // credentials file the user believes holds their accounts.
            if (accountIds.length === 0) {
              return json(res, 400, { error: 'accountIds must be a non-empty array of strings' })
            }
            const answer = await transfer.exportAccounts(region, accountIds)
            if (answer.accounts.length === 0) {
              return json(res, 409, { error: 'none of the named accounts was found in this region' })
            }
            // The one response that carries live access/refresh tokens: never
            // let it reach a cache.
            return jsonPrivate(res, 200, answer)
          }
          const body = await readJsonBody(req) as { text?: unknown, indexes?: unknown }
          if (typeof body.text !== 'string' || body.text.trim() === '') {
            return json(res, 400, { error: 'text must be the transfer file\'s JSON content' })
          }
          if (action === 'preview') {
            return json(res, 200, await transfer.previewImport(region, body.text))
          }
          const indexes = Array.isArray(body.indexes)
            ? body.indexes.filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0)
            : []
          if (indexes.length === 0) {
            return json(res, 400, { error: 'indexes must name at least one file entry to import' })
          }
          return json(res, 200, await transfer.importAccounts(region, body.text, indexes))
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    /**
     * The CLI route's live turns.
     *
     * Registered even when the bridge is switched off, and answers an empty
     * document in that case: the composer chip polls this path unconditionally
     * (it cannot know the setting — the settings mirror is not readable from a
     * session component), so "off" has to be a 200 with nothing in it rather
     * than a 404 the chip would have to special-case.
     *
     * No region parameter: a live turn is not scoped to a credential region, and
     * `requestRegion` would 400 a perfectly valid read.
     *
     * A 404 is not an option here, and that is a second reason for the
     * unconditional registration: the chip keeps showing the last document it
     * read while a poll fails (it cannot tell "the route is gone" from "the
     * request dropped"), so a route that vanished on a settings change would
     * leave a ghost pill describing a turn that already ended. Answering an
     * empty document keeps "off" inside the same code path as "no turns".
     */
    const disposeCliLive = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_CLI_LIVE_PATH,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        if (!requireLoopback(req, res)) return
        try {
          json(res, 200, deps.cliLive?.() ?? { turns: [], serverTime: Date.now() })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    /**
     * 设备头设置：档位切换 + 每账号的虚拟参数。
     *
     * GET 与 POST 描述的是同一份文档，所以一条路由两种方法。POST 的两种 `kind`
     * 都是**即时生效**——这里没有草稿，因为齿轮改的是"这台机器对外声称自己是谁"，
     * 一个需要点保存才生效的设备身份，会让"我改完到底发出去的是什么"变成猜测。
     */
    const disposeDeviceProfile = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_DEVICE_PROFILE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const port = deps.deviceSettings
        if (port === undefined) {
          return json(res, 503, { reason: 'device-settings-unavailable', error: 'device settings unavailable' })
        }
        if (req.method === 'GET') {
          if (!requireLoopback(req, res)) return
          try {
            json(res, 200, await port.read())
          } catch (error: unknown) {
            json(res, 500, { reason: 'device-settings-failed', error: safeMessage(error) })
          }
          return
        }
        // Writes carry "what this machine claims to be", so they take the same
        // POST + loopback guards as every other mutation on this card.
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!requireLoopback(req, res)) return
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch (error: unknown) {
          return json(res, 400, { error: safeMessage(error) })
        }
        if (body['kind'] === 'mode') {
          if (!isDeviceMode(body['mode'])) {
            return json(res, 400, { error: 'mode must be virtual or real' })
          }
          try {
            json(res, 200, await port.setMode(body['mode']))
          } catch (error: unknown) {
            json(res, 500, { reason: 'device-settings-failed', error: safeMessage(error) })
          }
          return
        }
        if (body['kind'] === 'account') {
          const accountId = typeof body['accountId'] === 'string' ? body['accountId'] : ''
          // The id becomes a key in the device-settings file; reject a malformed
          // one HERE so it is a 400 rather than a thrown error the card sees as 500.
          if (!isVaultAccountId(accountId)) {
            return json(res, 400, { error: 'accountId is not a well-formed account id' })
          }
          const values: { machineId?: string, sessionId?: string } = {}
          for (const key of ['machineId', 'sessionId'] as const) {
            const raw = body[key]
            if (raw === undefined) continue
            if (typeof raw !== 'string') return json(res, 400, { error: `${key} must be a string` })
            // '' clears the override (back to the derived value); anything else
            // must be a 36-character lowercase hex id, or the upstream would
            // receive a header we know is malformed.
            if (raw !== '' && !isDeviceId(raw)) {
              return json(res, 400, { error: `${key} must be 36 lowercase hex characters` })
            }
            values[key] = raw
          }
          try {
            json(res, 200, await port.saveAccount(accountId, values))
          } catch (error: unknown) {
            json(res, 500, { reason: 'device-settings-failed', error: safeMessage(error) })
          }
          return
        }
        json(res, 400, { error: "kind must be 'mode' or 'account'" })
      },
    })
    /**
     * 真实设备参数（内置 SDK）。
     *
     * 三个动作的权限不一样：读状态是 GET，强制重取与取完整值是 POST。把完整值
     * 放在 POST 后面不是形式主义——它会进浏览器历史、会被 proxy 记日志、会被截图，
     * 而 `GET` 是三者里最容易被动触发的（预取、刷新、插件间的探测）。
     */
    const disposeDeviceSdk = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_DEVICE_SDK_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const port = deps.deviceSdk
        if (port === undefined) {
          return json(res, 503, { reason: 'device-sdk-unavailable', error: 'device sdk unavailable' })
        }
        if (!requireLoopback(req, res)) return
        if (req.method === 'GET') {
          try {
            json(res, 200, await port.read())
          } catch (error: unknown) {
            json(res, 500, { reason: 'device-sdk-failed', error: safeMessage(error) })
          }
          return
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const action = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get(WORKBUDDY_DEVICE_SDK_ACTION_PARAM)
        try {
          if (action === 'reveal') {
            const token = await port.reveal()
            if (token === undefined) return json(res, 409, { reason: 'device-sdk-no-token', error: 'no device token is available' })
            return json(res, 200, { token })
          }
          if (action === 'refresh') {
            return json(res, 200, await port.refresh())
          }
        } catch (error: unknown) {
          return json(res, 500, { reason: 'device-sdk-failed', error: safeMessage(error) })
        }
        json(res, 400, { error: "action must be 'refresh' or 'reveal'" })
      },
    })
    return () => {
      // EVERY route registered above must appear here. `benefit/claim` was
      // missing from this list (issue #86), and the cost is not a stray handler:
      // the host's WebServer throws on a second register of the same path, so
      // the leak from mount N makes mount N+1 throw ON this path and abandon
      // every route registered after it. That is why a hot reload left half the
      // card's buttons answering `405` with an empty body — the host's own 405,
      // meaning "no such route".
      disposeBenefitClaim()
      disposeRefresh()
      disposeMediaModels()
      disposeCheckin()
      disposeAccounts()
      disposeUsage()
      disposeAccountCredits()
      disposeProbe()
      disposeTps()
      disposePool()
      disposeOAuth()
      disposeTransfer()
      disposeDiagWrite()
      disposeCliLive()
      disposeDeviceProfile()
      disposeDeviceSdk()
    }
  }, 'dsh-connect-workbuddy: Web status route')
}
