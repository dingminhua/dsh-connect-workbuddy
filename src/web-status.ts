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
import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import { resolveCredentialRecovery } from './credential-recovery.ts'
// Live binding only: `Config` is referenced inside request-time function
// bodies, never at module top level, so the index<->web-status cycle is safe.
import { Config, unwrapVolatileDeep } from './index.ts'
import type { WorkBuddyRecoveryCandidate } from './credential-recovery.ts'
import type { WorkBuddyCredits, WorkBuddyUpstreamClient } from './upstream.ts'
import { isCredentialRejectedError } from './upstream.ts'
import { effectiveMembersOf, rankPool, resolveTargetModel } from './account-pool.ts'
import type { WorkBuddyPoolMember, WorkBuddyPoolProbe } from './account-pool.ts'
import type {
  WorkBuddyPoolCheckinRow,
  WorkBuddyPoolTestRow,
} from './account-pool-run.ts'
import { regionOfStatusUrl } from './status-paths.ts'
import type { WorkBuddyRegion } from './upstream.ts'
import {
  poolActionOf,
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_CHECKIN_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_POOL_PATH,
  WORKBUDDY_PROBE_PATH,
  WORKBUDDY_USAGE_PATH,
} from './status-paths.ts'
import type {
  WorkBuddyWebAccount,
  WorkBuddyWebCredits,
  WorkBuddyWebPool,
  WorkBuddyWebPoolAccount,
  WorkBuddyWebProbeOutcome,
  WorkBuddyWebProbeResult,
  WorkBuddyWebSearchPath,
  WorkBuddyWebUsage,
} from './status-paths.ts'

export {
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_CHECKIN_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_POOL_PATH,
  WORKBUDDY_PROBE_PATH,
  WORKBUDDY_USAGE_PATH,
}
export type { WorkBuddyWebUsage }

/** Constructor dependencies. */
export interface WorkBuddyStatusRouteOptions {
  /** The region-scoped credential store backing each region's requests. */
  store(region: WorkBuddyRegion): WorkBuddyCredentialStore
  client: Pick<WorkBuddyUpstreamClient, 'fetchCredits' | 'fetchCheckinStatus' | 'claimDailyCheckin'>
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
  /** Saved local DSH context budgets by model id, for the requested region. */
  contextBudgets(region: WorkBuddyRegion): Readonly<Record<string, number | undefined>>
  /** Re-read the live catalog of one region from the upstream. */
  discoverModels?(region: WorkBuddyRegion, signal?: AbortSignal): Promise<readonly WorkBuddyModelInfo[]>
  /**
   * Whether the requested region's provider is currently offered to DSH. The
   * card renders this as the tab's on/off checkbox, so the switch reflects the
   * committed settings value rather than a local guess.
   */
  regionEnabled(region: WorkBuddyRegion): boolean
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
   * The region's account pool, assembled on the Host.
   *
   * Optional as a whole: a Host built without pool support simply omits it, and
   * the card then renders no pool section rather than an empty, confusing one.
   * Inside it, `test` is in turn optional because a batch test is the one part
   * that needs a working probe dependency.
   */
  pool?: WorkBuddyPoolDeps
}

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
    memberAccountIds: readonly string[]
  }
  /** One region's CHECKED accounts, plus their credits and last measurements. */
  members(region: WorkBuddyRegion): Promise<readonly WorkBuddyPoolMember[]>
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
   * Every local sign-in the pool does NOT cover, so the card can offer them to
   * check in. Absent means the card lists only pool members.
   */
  otherAccounts?(region: WorkBuddyRegion): Promise<readonly { id: string, accountName: string }[]>
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
  /** Test every account of one region against the resolved target model. */
  test?(
    region: WorkBuddyRegion,
    modelId: string,
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

/** A non-null, non-array object: the only shape the slot merge applies to. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
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

/** Loopback browser origins only; other devices are refused until trusted origins exist. */
function loopbackOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const { hostname } = new URL(origin)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
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
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow > 200_000 ? Math.min(model.contextWindow, budgets[model.id] ?? 200_000) : model.contextWindow,
    nativeContextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...model.creditMultiplier === undefined ? {} : { creditMultiplier: model.creditMultiplier },
    ...model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages },
    ...model.multimodal === undefined ? {} : { multimodal: model.multimodal },
    ...model.reasoning === undefined ? {} : {
      reasoning: {
        ...model.reasoning.supportedEfforts === undefined ? {} : { supportedEfforts: [...model.reasoning.supportedEfforts] },
        ...model.reasoning.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort },
      },
    },
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
}): WorkBuddyWebAccount {
  return {
    id: account.id,
    accountName: account.accountName,
    domain: account.domain,
    source: account.source,
    tokenExpiresAtMs: account.tokenExpiresAtMs,
    selected: account.selected,
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
 * Assemble one region's card document. `region` is the tab the card is on;
 * the region-scoped store already answers with only that region's accounts,
 * so the document's model slots and account list are that region's by
 * construction. Sign-in state is read-only; credit is a live billing answer
 * whose failure degrades to `creditsError` rather than failing the document.
 */
export async function workBuddyWebStatus(
  deps: WorkBuddyStatusRouteOptions,
  region: WorkBuddyRegion,
): Promise<WorkBuddyWebUsage> {
  const store = deps.store(region)
  const accounts = await store.accounts()
  // The card is a live view of this same scan, so this is where a sign-in that
  // happened behind the plugin's back gets noticed — before the next restart.
  deps.regionUsable?.(region, accounts.length > 0)
  // The provider's on/off state is independent of sign-in: a region the user
  // switched off renders its switch as off even when fully signed in, and the
  // card reads this committed value rather than a local guess.
  const enabled = deps.regionEnabled(region)
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
    return { status: 'signed-out', accounts: [], selectionExplicit, enabled }
  }
  let credential
  try {
    credential = await store.resolve()
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
    accountName: credential.nickname ?? '',
    ...credential.domain === '' ? {} : { domain: credential.domain },
    region,
    source: credential.source,
    tokenExpiresAtMs: credential.expiresAtMs,
    selectionExplicit,
    enabled,
    accounts: accounts.map(toWebAccount),
    models: deps.displayModels(region).map(model => toWebModel(model, deps.contextBudgets(region))),
    enabledModelIds: [...deps.enabledModelIds(region)],
    imageModelIds: [...deps.imageModelIds(region)],
  }
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
    status: 'signed-in',
    // The persisted per-region budgets, read straight from the Host config.
    // The browser settings mirror can be stale — a write made through the Host
    // save endpoint never updates it — so the card renders these instead of
    // re-deriving them from a snapshot that may predate the save.
    contextBudgets: Object.fromEntries(
      Object.entries(deps.contextBudgets(region)).filter(([, value]) => typeof value === 'number'),
    ) as Record<string, number>,
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
    ...creditsResult.status === 'fulfilled'
      ? { credits: toCredits(creditsResult.value) }
      : { creditsError: safeMessage(creditsResult.reason) },
    ...checkinResult.status === 'fulfilled'
      ? { checkin: checkinResult.value }
      : { checkinError: safeMessage(checkinResult.reason) },
    ...!rejected ? {} : { credentialRejected: true },
    ...recovery === undefined ? {} : { recovery },
    // The pool is assembled last and never allowed to fail the document: it is
    // an enhancement, and a credits read that failed inside it must not take
    // the whole status route down with it (the card would then show nothing at
    // all, including the account picker the user needs to recover).
    ...await poolSectionOf(deps, region),
  }
}

/** The pool block for a status document, or nothing when it cannot be built. */
async function poolSectionOf(
  deps: WorkBuddyStatusRouteOptions,
  region: WorkBuddyRegion,
): Promise<{ pool?: WorkBuddyWebPool }> {
  if (deps.pool === undefined) return {}
  try {
    const pool = await workBuddyWebPool(deps, region)
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
): Promise<WorkBuddyWebPool | undefined> {
  const pool = deps.pool
  if (pool === undefined) return undefined
  const preferences = pool.preferences(region)
  const members = await pool.members(region)
  const nowMs = Date.now()
  const ranked = rankPool(members, nowMs)
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
  // rather than asserting a state nobody read.
  const checkedIn: Readonly<Record<string, boolean>> =
    await pool.checkedInToday?.(region).catch(() => ({} as Record<string, boolean>))
    ?? {} as Record<string, boolean>
  const rows: readonly {
    account: { id: string, accountName: string }
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

  const accounts: WorkBuddyWebPoolAccount[] = rows.map(({ account, member, ranked: row }) => {
    const measured = byId.get(account.id)
    return {
      accountId: account.id,
      accountName: account.accountName,
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
          ...measured.probe.retryAtMs === undefined ? {} : { retryAtMs: measured.probe.retryAtMs },
        },
      },
      ...row?.excludedBy === undefined ? {} : { excludedBy: row.excludedBy },
      current: account.id === currentAccountId,
      member,
      ...checkedIn[account.id] === undefined ? {} : { checkedInToday: checkedIn[account.id] as boolean },
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
    // The SAVED list, verbatim. Deliberately not rewritten to the effective
    // set: silently dropping ids would destroy the user's record of what they
    // chose, and a login can come back (the desktop app re-adds it) in which
    // case the saved id should apply again.
    memberAccountIds: preferences.memberAccountIds,
    // The ids that actually resolve to a listed account, i.e. what a batch will
    // run on. Sent explicitly so the card never has to re-derive it: deriving
    // it in the browser is what let the UI claim "1 of 1 selected" while the
    // Host ran on zero accounts.
    effectiveMemberAccountIds: effectiveMembersOf(
      accounts.map(account => account.accountId),
      new Set(preferences.memberAccountIds),
    ),
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
        if (!loopbackOrigin(req)) {
          json(res, 403, { error: 'origin-not-trusted' })
          return
        }
        const region = requestRegion(req, res)
        if (region === undefined) return
        try {
          json(res, 200, await workBuddyWebStatus(deps, region))
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
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        const region = requestRegion(req, res)
        if (region === undefined) return
        try {
          const accounts = await deps.store(region).accounts()
          deps.regionUsable?.(region, accounts.length > 0)
          json(res, 200, { accounts: accounts.map(toWebAccount) })
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
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
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
    const disposeRefresh = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_MODELS_REFRESH_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
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
    const disposeProbe = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_PROBE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
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
    const disposePool = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_POOL_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        // Both actions are writes: check-in claims a reward on the user's real
        // account, and a test spends real credits. So POST + loopback, the same
        // guards the card's other mutations carry.
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        const region = requestRegion(req, res)
        if (region === undefined) return
        const action = poolActionOf(req.url ?? '/')
        if (action === undefined) {
          return json(res, 400, { error: 'action must be checkin or test' })
        }
        const pool = deps.pool
        if (pool === undefined) {
          return json(res, 503, { reason: 'pool-unavailable', error: 'account pool unavailable' })
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
          const target = resolveTargetModel(
            pool.catalog?.(region) ?? [],
            pool.preferences(region).targetModelId,
          )
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
          const rows = await pool.test(region, target.modelId)
          // Measurements are persisted by the Host's own `test` implementation,
          // alongside the rotation they feed. Doing it here as well would write
          // the same facts twice and could interleave with a concurrent batch.
          return json(res, 200, { action: 'test', modelId: target.modelId, rows })
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
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
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
          if (field !== 'regions' && field !== 'accounts') return json(res, 400, { error: 'field must be regions or accounts' })
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
          const current = unwrapVolatileDeep(row.value?.[field] ?? {}) as Record<string, unknown>
          const incoming = (body.value ?? {}) as Record<string, unknown>
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
    return () => {
      disposeRefresh()
      disposeCheckin()
      disposeAccounts()
      disposeUsage()
      disposeProbe()
      disposePool()
      disposeDiagWrite()
    }
  }, 'dsh-connect-workbuddy: Web status route')
}
