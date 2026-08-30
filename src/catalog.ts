/**
 * WorkBuddy model catalog: a static fallback list, replaced by the upstream's
 * dynamic catalog once it loads, and filtered by the user's explicit selection.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   — 「上次刷新的完整目录（lastCatalog）与用户勾选分离，运行时目录由两者
 *     推导」的模型来自该项目。它让卡片永远展示最新目录而不是陈旧快照，
 *     并让上游刷新成为草稿操作（用户点保存才生效）。
 *   静态 fallback 目录的做法来自
 *     corrinehu/dsh-workbuddy-connect（MIT）：上游不可用时 provider 不为空。
 * 改动：WorkBuddy 直接用各模型的 `maxInputTokens` 声明实际上下文窗口；
 *   上游没有独立的长上下文开关或第二个模型 id，因此不会虚构 `@1m` 变体。
 *   本目录额外承载上游给出的积分倍率、多模态与推理档位。
 *
 * @module dsh-connect-workbuddy/catalog
 */

import type { WorkBuddyUpstreamModel } from './upstream.ts'

/** One model entry the adapter exposes. */
export type WorkBuddyModelInfo = WorkBuddyUpstreamModel

/**
 * Static CLI models captured from the CN endpoint (2026-08-30). The upstream
 * refresh replaces this list at startup; it exists so the provider registers
 * with a usable catalog even while the first fetch is in flight or offline.
 */
export const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'auto', name: 'Auto', contextWindow: 168_000, maxTokens: 32_000 },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200_000, maxTokens: 64_000, multimodal: true },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 48_000 },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxTokens: 48_000 },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, maxTokens: 128_000 },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000 },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', contextWindow: 256_000, maxTokens: 32_000 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000 },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1_000_000, maxTokens: 50_000 },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, maxTokens: 50_000 },
]

/**
 * Derive the runtime catalog from the last-refreshed directory plus the
 * user's selection. This is the single source of truth for what DSH exposes,
 * so saving only the selection is enough to rebuild it after a restart.
 *
 * An empty selection falls back to the whole directory: a plugin that has
 * never been configured must still serve models rather than nothing.
 */
export type WorkBuddyContextBudget = number

/** Apply the saved local DSH budget; models above 200K default to 200K. */
export function applyContextBudgets(
  catalog: readonly WorkBuddyModelInfo[],
  budgets: Readonly<Record<string, WorkBuddyContextBudget | undefined>> = {},
): WorkBuddyModelInfo[] {
  return catalog.map(model => ({
    ...model,
    contextWindow: model.contextWindow > 200_000
      ? Math.min(model.contextWindow, budgets[model.id] ?? 200_000)
      : model.contextWindow,
  }))
}

export function deriveCatalog(
  catalog: readonly WorkBuddyModelInfo[],
  enabled: ReadonlySet<string>,
  budgets: Readonly<Record<string, WorkBuddyContextBudget | undefined>> = {},
): WorkBuddyModelInfo[] {
  const selected = enabled.size === 0 ? catalog : catalog.filter(model => enabled.has(model.id))
  return applyContextBudgets(selected, budgets)
}

/** Mutable catalog shared by the shim's `/v1/models` and the adapter. */
export class WorkBuddyCatalog {
  private models: readonly WorkBuddyModelInfo[] = FALLBACK_WORKBUDDY_MODELS

  /** Current entries; the fallback list until the upstream answer lands. */
  current(): readonly WorkBuddyModelInfo[] {
    return this.models
  }

  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly WorkBuddyModelInfo[]): void {
    if (models.length === 0) throw new Error('workbuddy model catalog cannot be empty')
    this.models = models.map(model => ({ ...model }))
  }
}
