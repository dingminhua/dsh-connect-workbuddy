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

import { isRouterModelId } from './native-modality.ts'
import type { WorkBuddyUpstreamModel } from './upstream.ts'

/** One model entry the adapter exposes. */
export type WorkBuddyModelInfo = WorkBuddyUpstreamModel

/**
 * Static CLI models captured from the CN endpoint (2026-08-30). The upstream
 * refresh replaces this list at startup; it exists so the provider registers
 * with a usable catalog even while the first fetch is in flight or offline.
 *
 * The upstream's `auto` ROUTER is deliberately absent, matching what
 * `selectCliModels` now does to the live roster: it resolves to a different
 * model per request, so it is not a row this plugin can describe. Keeping it
 * here would have reintroduced it on the offline/第一帧 path only, which is the
 * hardest kind of inconsistency to notice.
 */
export const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[] = [
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
 * usable before the first fetch lands. Order mirrors the upstream.
 *
 * ⚠️ IT CARRIES NO `creditMultiplier`, AND THAT IS THE FIX FOR ISSUE #214.
 * This list used to hardcode one rate per model, captured on 2026-09-11. The
 * upstream moves those rates — the reporter measured `glm-5.3` at x0.69 and
 * `hy4-preview` at x0.29 on 2026-11-04 against the x0.79 / x0.00 written
 * here — so every captured rate aged into a WRONG PRICE. Worse, the overlay
 * rule (`overlayLiveCapabilities`: the live side owns `creditMultiplier`)
 * meant this table WON over the user's saved directory whenever the catalog
 * still held it, which is exactly the reported symptom: the card showed the
 * built-in table's figures, not the saved ones and not the upstream's.
 *
 * A price is a FACT ABOUT NOW, and this module never learns "now": it is the
 * offline placeholder, written once and never refreshed. So it must not
 * assert a price at all. An absent multiplier renders as "no rate" — the
 * honest answer — and `pickFreeModel` deliberately treats absence as NOT
 * free, so the account pool can never probe a paid model by mistake. The CN
 * table has always been shaped this way for the same reason.
 *
 * The ROSTER (ids, names, windows) stays: that is what keeps the provider
 * non-empty while the first fetch is in flight, and an id list ages far
 * more slowly than a price list.
 */
export const FALLBACK_WORKBUDDY_MODELS_GLOBAL: readonly WorkBuddyModelInfo[] = [
  // `default-model` is deliberately ABSENT: it is the international gateway's
  // `auto` router (name "Auto", `isDefault: true`, no declared `credits`), and
  // `ROUTER_MODEL_IDS` drops it from the live roster. This list must agree —
  // shipping it here would reintroduce the row on the offline path only, which
  // is the one place nobody looks. See `src/native-modality.ts`.
  { id: 'fast-model', name: 'Fast', contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256_000, maxTokens: 32_000 },
  { id: 'primary-model', name: 'Primary', contextWindow: 272_000, maxTokens: 72_000 },
  { id: 'deep-model', name: 'Deep', contextWindow: 176_000, maxTokens: 24_000 },
  // The desktop channel's free-flagged `deepseek-v4.1-flash` is the reason the
  // global roster is read from that channel at all — the CLI channel omits it.
  // Its rate is NOT pinned here: the reporter measured it billing real credits
  // while the channel still advertised x0.00, so a captured "free" is the most
  // expensive thing this table could claim.
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, maxTokens: 64_000 },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, maxTokens: 72_000 },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', contextWindow: 272_000, maxTokens: 72_000 },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1_000_000, maxTokens: 65_536 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 48_000 },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000 },
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
 * Drop the upstream's ROUTER rows from a roster that came from settings.
 *
 * The static lists and `selectCliModels` both refuse routers already, but
 * `lastCatalog` is a SNAPSHOT the user's profile carries from an earlier
 * version — and every read of it (the card's list, the runtime catalog, the
 * provider's advertisement) would otherwise keep showing the row long after the
 * code stopped offering it. Filtering at the READ point instead of migrating the
 * saved value is deliberate: the stored slot stays exactly what the last refresh
 * wrote, so nothing is silently rewritten on load, and the row disappears the
 * moment the new code runs rather than at the next refresh.
 */
export function withoutRouters(
  models: readonly WorkBuddyModelInfo[],
): readonly WorkBuddyModelInfo[] {
  return models.filter(model => !isRouterModelId(model.id))
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

/**
 * Apply the saved local DSH budget. A budget is an UPPER LIMIT the user sets,
 * never a default: a model without an explicit budget keeps its own window, and
 * a budget can only ever LOWER a window (`Math.min`), so a value above the
 * native one is not an error, just a no-op.
 *
 * There used to be a `?? 200_000` default here (issue #33), on the rationale
 * that a lower advertised window makes DSH compact sooner and so keeps a long
 * session under the upstream throttle. That rationale does not hold: the
 * measured throttle fires on a SINGLE request past 20k-30k input tokens (the
 * CHANGELOG's own wording calls 200K "远超上游 ~20–30k 的节流线"), so clamping to
 * 200K bought none of the safety it claimed while costing every >200K model its
 * real window — and contradicting the static roster in this very file, which
 * declares those models as 1M. A user who wants the conservative behaviour sets
 * a budget explicitly; the card offers that per model.
 */
export function applyContextBudgets(
  catalog: readonly WorkBuddyModelInfo[],
  budgets: Readonly<Record<string, WorkBuddyContextBudget | undefined>> = {},
): WorkBuddyModelInfo[] {
  return catalog.map(model => ({
    ...model,
    contextWindow: budgets[model.id] === undefined
      ? model.contextWindow
      : Math.min(model.contextWindow, budgets[model.id] as number),
  }))
}

/**
 * The tier one model currently RESOLVES TO, given the saved budgets.
 *
 * This is the rule the card's radio group has to agree with, so it lives next
 * to {@link applyContextBudgets} rather than being re-derived in the browser —
 * ONE definition, so the UI cannot drift from the backend again (issue #215).
 *
 * `undefined` means "no explicit budget" and answers the NATIVE window, which
 * is exactly what {@link applyContextBudgets} does with an absent entry. The
 * card used to default the 200K radio with `?? 200_000` instead, so a model
 * with no stored budget showed "200K" selected while DSH was told 1,000,000 —
 * the reporter's case. The radio was right there in the UI and wrong in the
 * only place that matters.
 *
 * A budget ABOVE the native window answers the native window, because
 * {@link applyContextBudgets} clamps with `Math.min`: a stored 1048576 for a 1M
 * model genuinely resolves to the native tier, and that radio is the one that
 * should be lit.
 */
export function effectiveContextBudget(
  nativeContextWindow: number,
  savedBudget: WorkBuddyContextBudget | undefined,
): number {
  return savedBudget === undefined
    ? nativeContextWindow
    : Math.min(nativeContextWindow, savedBudget)
}

/**
 * Derive the runtime catalog from the last-refreshed directory plus the user's
 * selection.
 *
 * An empty selection means "never configured" and serves the whole directory.
 * But a NON-empty selection that intersects the directory in nothing must NOT
 * serve nothing: that is the issue #32 failure mode (the picker empties out),
 * and it now has a realistic trigger — a user whose only ticked model was the
 * upstream's `auto` router, which this version stops offering. Such a selection
 * degrades to the whole directory rather than to silence: the user asked for
 * "some models to be on", and the alternative is a region with no models at
 * all. An empty directory still yields an empty result; the guard is only about
 * a selection that no longer matches anything.
 */
export function deriveCatalog(
  catalog: readonly WorkBuddyModelInfo[],
  enabled: ReadonlySet<string>,
  budgets: Readonly<Record<string, WorkBuddyContextBudget | undefined>> = {},
): WorkBuddyModelInfo[] {
  const selected = enabled.size === 0 ? catalog : catalog.filter(model => enabled.has(model.id))
  return applyContextBudgets(selected.length === 0 && enabled.size > 0 ? catalog : selected, budgets)
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
   * Whether {@link models} came from the upstream at least once.
   *
   * Starts `false`: the constructor seeds the static fallback, and that list
   * must never be mistaken for a live answer (see {@link hasLiveRoster}).
   */
  private live = false

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

  /**
   * Whether {@link current} is an UPSTREAM answer rather than the built-in
   * fallback it was constructed with.
   *
   * This distinction is what keeps issue #32 fixed. `applySelection` passes
   * `current()` into `configuredModels` as the live roster to fall back to, so
   * a partial saved slot demotes to the live directory instead of the static
   * list. But before the first refresh lands, `current()` IS the static list
   * (the constructor seeds it), and `resolveRoster` cannot tell the two apart
   * because it only sees a non-empty array. The result was the exact bug #32
   * describes, reached from the other direction: a settings write arriving
   * before the first catalog refresh let the STATIC roster masquerade as live,
   * and `set()` then committed it — so a model that only exists upstream
   * (`space-bunny`) vanished from the picker while the runtime still served it.
   *
   * Callers that use `current()` as a *live* answer must check this first. A
   * caller that only wants "what would we advertise right now" does not need
   * to: the fallback is the honest answer to that question.
   */
  hasLiveRoster(): boolean {
    return this.live
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

  /**
   * Replace the list; callers invalidate their adapter snapshot after this.
   *
   * `origin` says where the list came from, and it is not cosmetic: only an
   * `upstream` answer may mark the catalog live. `applySelection` also calls
   * this on every settings write — including before the first refresh has
   * landed — and the list it passes then is the static fallback. Letting that
   * count as live is what re-opened issue #32 (see {@link hasLiveRoster}).
   *
   * The default is `'upstream'` so every pre-existing call site keeps meaning
   * what it meant; only the re-derivation path opts into `'derived'`.
   */
  set(models: readonly WorkBuddyModelInfo[], origin: 'upstream' | 'derived' = 'upstream'): void {
    if (models.length === 0) throw new Error('workbuddy model catalog cannot be empty')
    if (origin === 'upstream') this.live = true
    this.models = models.map(model => ({ ...model }))
  }
}
