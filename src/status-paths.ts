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

/** One selectable local account, token-free. */
export interface WorkBuddyWebAccount {
  id: string
  accountName: string
  uin?: string
  domain: string
  source: 'desktop' | 'dsh'
  tokenExpiresAtMs: number
  selected: boolean
}

export type WorkBuddyWebPackage = WorkBuddyWebCreditPackage

/** The JSON document the plugin card renders. */
export type WorkBuddyWebUsage =
  | { status: 'signed-out'; accounts: readonly WorkBuddyWebAccount[]; message?: string }
  | {
    status: 'signed-in'
    accountId: string
    accountName: string
    uin?: string
    domain?: string
    source?: 'desktop' | 'dsh'
    tokenExpiresAtMs: number
    accounts: readonly WorkBuddyWebAccount[]
    models: readonly WorkBuddyWebModel[]
    enabledModelIds: readonly string[]
    credits?: WorkBuddyWebCredits
    creditsError?: string
    checkin?: WorkBuddyWebCheckin
    checkinError?: string
  }
  | { status: 'error'; message: string }
