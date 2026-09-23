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
import type { WorkBuddyRecoveryCandidate } from './credential-recovery.ts'
import type { WorkBuddyCredits, WorkBuddyUpstreamClient } from './upstream.ts'
import { isCredentialRejectedError } from './upstream.ts'
import { regionOfStatusUrl } from './status-paths.ts'
import type { WorkBuddyRegion } from './upstream.ts'
import {
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_CHECKIN_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_SETTINGS_WRITE_PATH,
  WORKBUDDY_USAGE_PATH,
} from './status-paths.ts'
import type { WorkBuddyWebAccount, WorkBuddyWebCredits, WorkBuddyWebSearchPath, WorkBuddyWebUsage } from './status-paths.ts'

export {
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_CHECKIN_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_SETTINGS_WRITE_PATH,
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
  /** Host settings mutation used when the 0.1.7 browser form is memory-backed. */
  mutateSettings?(path: readonly string[], value: unknown): Promise<void>
  /** Re-read the live catalog of one region from the upstream. */
  discoverModels?(region: WorkBuddyRegion, signal?: AbortSignal): Promise<readonly WorkBuddyModelInfo[]>
  /**
   * Whether the requested region's provider is currently offered to DSH. The
   * card renders this as the tab's on/off checkbox, so the switch reflects the
   * committed settings value rather than a local guess.
   */
  regionEnabled(region: WorkBuddyRegion): boolean
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
}

/** Redact token-like content before it crosses to the browser. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
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

const MAX_SETTINGS_BODY_BYTES = 1_048_576

type WorkBuddySettingsWrite =
  | { field: 'accounts'; region: WorkBuddyRegion; value: string }
  | { field: 'regions'; region: WorkBuddyRegion; value: Record<string, unknown> }
  | { field: 'regions.enabled'; region: WorkBuddyRegion; value: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse the card's small, field-constrained settings mutation. */
async function readSettingsWrite(req: IncomingMessage): Promise<WorkBuddySettingsWrite> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_SETTINGS_BODY_BYTES) throw new Error('settings payload is too large')
    chunks.push(buffer)
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!isRecord(body) || (body.region !== 'cn' && body.region !== 'global')) {
    throw new Error('invalid settings payload')
  }
  if (body.field === 'accounts' && typeof body.value === 'string') {
    return { field: body.field, region: body.region, value: body.value }
  }
  if (body.field === 'regions' && isRecord(body.value)) {
    return { field: body.field, region: body.region, value: body.value }
  }
  if (body.field === 'regions.enabled' && typeof body.value === 'boolean') {
    return { field: body.field, region: body.region, value: body.value }
  }
  throw new Error('invalid settings field or value')
}

function settingsPath(write: WorkBuddySettingsWrite): readonly string[] {
  if (write.field === 'accounts') return ['accounts', write.region]
  if (write.field === 'regions.enabled') return ['regions', write.region, 'enabled']
  return ['regions', write.region]
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
    ...account,
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
    const disposeSettingsWrite = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_SETTINGS_WRITE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        if (deps.mutateSettings === undefined) {
          return json(res, 503, { error: 'settings service does not support mutations' })
        }
        try {
          const write = await readSettingsWrite(req)
          await deps.mutateSettings(settingsPath(write), write.value)
          return json(res, 200, { ok: true })
        } catch (error: unknown) {
          const status = error instanceof SyntaxError || (error instanceof Error && error.message.startsWith('invalid settings'))
            ? 400
            : error instanceof Error && error.message === 'settings payload is too large'
              ? 413
              : 500
          return json(res, status, {
            ok: false,
            errorName: error instanceof Error ? error.name : 'Error',
            error: safeMessage(error),
          })
        }
      },
    })
    return () => {
      disposeRefresh()
      disposeCheckin()
      disposeAccounts()
      disposeUsage()
      disposeSettingsWrite()
    }
  }, 'dsh-connect-workbuddy: Web status route')
}
