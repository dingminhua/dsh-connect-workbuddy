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
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200_000, maxTokens: 64_000 },
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
 * Static CLI models captured from the INTERNATIONAL gateway's desktop-channel
 * product config (`www.workbuddy.ai/v3/config`, 2026-09-11). The two regions
 * expose different rosters — the CN list has no `gpt-*`/`gemini-*` entries —
 * so a global account must never be seeded with the CN list. Like the CN
 * fallback this is replaced by the live refresh; it only keeps the provider
 * usable before the first fetch lands. Order and rates mirror the upstream.
 */
export const FALLBACK_WORKBUDDY_MODELS_GLOBAL: readonly WorkBuddyModelInfo[] = [
  { id: 'default-model', name: 'Auto', contextWindow: 176_000, maxTokens: 24_000, creditMultiplier: 0.79 },
  { id: 'fast-model', name: 'Fast', contextWindow: 200_000, maxTokens: 32_000, creditMultiplier: 0.34 },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256_000, maxTokens: 32_000, creditMultiplier: 0.59 },
  { id: 'primary-model', name: 'Primary', contextWindow: 272_000, maxTokens: 72_000, creditMultiplier: 3.31 },
  { id: 'deep-model', name: 'Deep', contextWindow: 176_000, maxTokens: 24_000, creditMultiplier: 3.33 },
  // Free promotional model (`x0.00`, "Free now"): the reason the global roster
  // is read from the desktop channel at all — the CLI channel omits it.
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 0 },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 6.67 },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, maxTokens: 64_000, creditMultiplier: 0 },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, creditMultiplier: 0 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 3.47 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 1.39 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 0.14 },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 3.31 },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, maxTokens: 72_000, creditMultiplier: 1.65 },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', contextWindow: 272_000, maxTokens: 72_000, creditMultiplier: 1.25 },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1_000_000, maxTokens: 65_536, creditMultiplier: 0.99 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000, creditMultiplier: 0.79 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 48_000, creditMultiplier: 0.79 },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000, creditMultiplier: 1.62 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000, creditMultiplier: 0.52 },
]

/**
 * Static fallback directory for a region. Each region keeps its own model
 * slot in settings; the fallback must match the region so an account never
 * shows the other region's roster.
 */
export function fallbackModelsFor(region: 'cn' | 'global'): readonly WorkBuddyModelInfo[] {
  return region === 'global' ? FALLBACK_WORKBUDDY_MODELS_GLOBAL : FALLBACK_WORKBUDDY_MODELS
}

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

/**
 * Mutable catalog shared by the shim's `/v1/models` and the adapter.
 *
 * The static fallback exists so an OFFLINE upstream never leaves a provider
 * empty — but "offline" presumes the region is usable at all. A region with no
 * local sign-in cannot serve one single request, so seeding it with a roster
 * puts models in the picker that are guaranteed to 401 (issue #12). The host
 * distinguishes the two cases through {@link WorkBuddyCatalog.setRegionUsable}.
 */
export class WorkBuddyCatalog {
  private models: readonly WorkBuddyModelInfo[]

  /**
   * Whether this region has any local sign-in. Defaults to `true` — the
   * permissive direction — so a scan that has not run yet (or failed) keeps
   * serving the fallback rather than blanking a region that may be fine.
   */
  private usable = true

  /**
   * Whether the user has switched this region's provider ON. Opt-out: defaults
   * to `true`, so a config predating this switch (and the pre-region-split flat
   * fields, which never carry `enabled`) keeps both providers running. Set to
   * `false` by `setRegionEnabled` to withdraw the region from DSH's model
   * picker entirely (its adapter route and configurable-provider entry are
   * pulled by the Host via `AdapterRegistrationHandle.replace([])` /
   * `DirectoryRegistrationHandle.replace([])`). This is a USER choice, distinct
   * from {@link usable}: a region the user switched off keeps its catalog,
   * accounts, and model picks intact and reappears the moment they re-check it.
   */
  private enabled = true

  /**
   * @param region Seeds the static fallback for this region; each region's
   * provider must never serve the other region's roster before its first
   * live refresh lands.
   */
  constructor(region: 'cn' | 'global' = 'cn') {
    this.models = fallbackModelsFor(region)
  }

  /**
   * Current entries; the fallback list until the upstream answer lands.
   *
   * Empty while this region has no local sign-in OR the user has switched it
   * off: the provider stays registered (its row still hosts the settings card
   * and the account picker), but it advertises nothing to pick. DSH drops empty
   * provider groups from the picker (`buildModelCatalog` filters
   * `models.length > 0`), so the group disappears exactly when it would be pure
   * noise. The two empty causes are independent: `usable` is the automatic
   * "no account" gate (issue #12), `enabled` is the user's explicit on/off.
   */
  current(): readonly WorkBuddyModelInfo[] {
    return this.usable && this.enabled ? this.models : []
  }

  /** Whether this region currently advertises any model. */
  isRegionUsable(): boolean {
    return this.usable
  }

  /** Whether the user has this region's provider switched on. */
  isRegionEnabled(): boolean {
    return this.enabled
  }

  /**
   * Record whether this region has a local sign-in.
   *
   * Separate from {@link set} on purpose: `set()` carries a live upstream
   * answer and must never be empty, while "this region has no account" is a
   * legitimate empty state that must survive across refreshes. Keeping them
   * apart is what lets the non-empty guard stay strict.
   *
   * @returns whether the value changed, so the caller can skip invalidating
   *   its adapter snapshots when nothing moved.
   */
  setRegionUsable(usable: boolean): boolean {
    if (this.usable === usable) return false
    this.usable = usable
    return true
  }

  /**
   * Record the user's explicit on/off choice for this region's provider.
   *
   * Distinct from {@link setRegionUsable}: that is the automatic "no local
   * account" gate, while this is a deliberate user action (issue #11-style
   * region switch). The Host reads the same `enabled` flag through
   * `regionStateOf(config, region).enabled !== false`, so the two halves never
   * disagree. Returns whether the value changed.
   */
  setRegionEnabled(enabled: boolean): boolean {
    if (this.enabled === enabled) return false
    this.enabled = enabled
    return true
  }

  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly WorkBuddyModelInfo[]): void {
    if (models.length === 0) throw new Error('workbuddy model catalog cannot be empty')
    this.models = models.map(model => ({ ...model }))
  }
}
