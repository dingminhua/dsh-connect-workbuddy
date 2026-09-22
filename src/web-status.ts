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
import type { WorkBuddyCredits, WorkBuddyUpstreamClient } from './upstream.ts'
import { regionOfStatusUrl } from './status-paths.ts'
import type { WorkBuddyRegion } from './upstream.ts'
import {
  WORKBUDDY_ACCOUNTS_REFRESH_PATH,
  WORKBUDDY_CHECKIN_PATH,
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_USAGE_PATH,
} from './status-paths.ts'
import type { WorkBuddyWebAccount, WorkBuddyWebCredits, WorkBuddyWebUsage } from './status-paths.ts'

export { WORKBUDDY_ACCOUNTS_REFRESH_PATH, WORKBUDDY_CHECKIN_PATH, WORKBUDDY_MODELS_REFRESH_PATH, WORKBUDDY_USAGE_PATH }
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

/** Project a store account into the card's token-free account row. */
function toWebAccount(account: {
  id: string
  accountName: string
  uin?: string
  domain: string
  source: 'desktop' | 'dsh'
  tokenExpiresAtMs: number
  selected: boolean
}): WorkBuddyWebAccount {
  return {
    id: account.id,
    accountName: account.accountName,
    ...account.uin === undefined ? {} : { uin: account.uin },
    domain: account.domain,
    source: account.source,
    tokenExpiresAtMs: account.tokenExpiresAtMs,
    selected: account.selected,
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
  const authStatus = await store.status()
  // Whether a saved per-region choice is in effect, on every branch: the card
  // needs it to show that clearing really did return the region to the app's
  // current sign-in, even when that default is the same account as before.
  const selectionExplicit = store.hasExplicitSelection()
  if (authStatus.state !== 'signed-out' && accounts.length === 0) {
    return { status: 'signed-out', accounts: [], selectionExplicit }
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
    return {
      status: 'signed-out',
      accounts: accounts.map(toWebAccount),
      message: safeMessage(error),
      selectionExplicit,
      ...await store.selectionLost() ? { selectionLost: true } : {},
    }
  }
  // Only user-facing identity and expiry cross to the browser. Token material
  // and stable user IDs stay on the Host.
  const selected = accounts.find(account => account.selected)
  const account = {
    accountId: selected?.id ?? '',
    accountName: credential.nickname ?? credential.uin ?? credential.uid,
    ...credential.uin === undefined ? {} : { uin: credential.uin },
    ...credential.domain === '' ? {} : { domain: credential.domain },
    region,
    source: credential.source,
    tokenExpiresAtMs: credential.expiresAtMs,
    selectionExplicit,
    accounts: accounts.map(toWebAccount),
    models: deps.displayModels(region).map(model => toWebModel(model, deps.contextBudgets(region))),
    enabledModelIds: [...deps.enabledModelIds(region)],
    imageModelIds: [...deps.imageModelIds(region)],
  }
  const [creditsResult, checkinResult] = await Promise.allSettled([
    deps.client.fetchCredits(credential),
    deps.client.fetchCheckinStatus(credential),
  ])
  return {
    status: 'signed-in',
    ...account,
    ...creditsResult.status === 'fulfilled'
      ? { credits: toCredits(creditsResult.value) }
      : { creditsError: safeMessage(creditsResult.reason) },
    ...checkinResult.status === 'fulfilled'
      ? { checkin: checkinResult.value }
      : { checkinError: safeMessage(checkinResult.reason) },
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
          json(res, 200, { accounts: (await deps.store(region).accounts()).map(toWebAccount) })
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
    return () => {
      disposeRefresh()
      disposeCheckin()
      disposeAccounts()
      disposeUsage()
    }
  }, 'dsh-connect-workbuddy: Web status route')
}
