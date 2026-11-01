import { describe, expect, it } from 'vitest'
import { deriveCatalog, fallbackModelsFor, FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog, withoutRouters } from '../src/catalog.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

const MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000 },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000 },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, maxTokens: 50_000 },
]

describe('deriveCatalog', () => {
  it('does not pre-mark any fallback model as image-capable', () => {
    expect(FALLBACK_WORKBUDDY_MODELS.every(model => model.multimodal !== true)).toBe(true)
  })

  it('serves the whole directory when nothing is enabled yet', () => {
    const derived = deriveCatalog(MODELS, new Set())
    expect(derived.map(model => model.id)).toEqual(['glm-5.3', 'kimi-k3-1', 'deepseek-v4-pro'])
  })

  it('keeps each model\'s own window when no budget is set (issue #33)', () => {
    // This INVERTS the former default, which clamped every >200K model to 200K.
    // That default was justified as keeping DSH under the upstream throttle, but
    // the measured throttle fires on a single request past 20k-30k input tokens
    // while 200K sits an order of magnitude above it — so the clamp cost every
    // 1M model its real window and bought nothing. `contextBudgets` is a
    // user-set upper limit, not a silent downgrade.
    const derived = deriveCatalog([
      ...MODELS,
      { id: 'kimi', name: 'Kimi', contextWindow: 256_000, maxTokens: 32_000 },
      { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 },
    ], new Set())
    expect(derived.map(model => model.contextWindow)).toEqual([1_000_000, 1_000_000, 1_000_000, 256_000, 192_000])
  })

  it('applies an explicit budget, and only as an upper limit', () => {
    const derived = deriveCatalog(
      MODELS,
      new Set(['deepseek-v4-pro', 'glm-5.3']),
      { 'deepseek-v4-pro': 1_000_000 },
    )
    expect(derived.map(model => [model.id, model.contextWindow])).toEqual([
      // No budget for glm-5.3, so it keeps its own 1M rather than being clamped.
      ['glm-5.3', 1_000_000],
      ['deepseek-v4-pro', 1_000_000],
    ])
  })

  it('never raises a window above its native size', () => {
    // A budget larger than the model's own window is a no-op, not an error.
    const derived = deriveCatalog(MODELS, new Set(['glm-5.3']), { 'glm-5.3': 5_000_000 })
    expect(derived.map(model => model.contextWindow)).toEqual([1_000_000])
  })

  it('lowers a window when the user sets a smaller budget', () => {
    // The conservative behaviour is still reachable — it is now opt-in.
    const derived = deriveCatalog(MODELS, new Set(['glm-5.3']), { 'glm-5.3': 200_000 })
    expect(derived.map(model => model.contextWindow)).toEqual([200_000])
  })

  it('ignores selections for models no longer in the directory', () => {
    const derived = deriveCatalog(MODELS, new Set(['glm-5.3', 'retired-model']))
    expect(derived.map(model => model.id)).toEqual(['glm-5.3'])
  })

  it('falls back to the whole directory when the selection matches nothing', () => {
    // A realistic trigger: a user whose only ticked model was the upstream's
    // `auto` router, which this version stops offering. Emptying the picker is
    // the issue #32 failure mode; a selection that no longer matches anything
    // must degrade to the whole directory instead of to silence.
    const derived = deriveCatalog(MODELS, new Set(['auto']))
    expect(derived.map(model => model.id)).toEqual(MODELS.map(model => model.id))
  })

  it('does not hand out the stored array itself', () => {
    const derived = deriveCatalog(MODELS, new Set(['glm-5.3']))
    derived[0]!.id = 'mutated'
    expect(MODELS[0]!.id).toBe('glm-5.3')
  })
})

describe('WorkBuddyCatalog', () => {
  it('starts from the static fallback list', () => {
    const catalog = new WorkBuddyCatalog()
    expect(catalog.current()).toEqual(FALLBACK_WORKBUDDY_MODELS)
    expect(catalog.current().length).toBeGreaterThan(0)
  })

  it('replaces the list and copies entries defensively', () => {
    const catalog = new WorkBuddyCatalog()
    catalog.set(MODELS)
    expect(catalog.current()).toHaveLength(3)
    const mutable = [...MODELS] as WorkBuddyModelInfo[]
    catalog.set(mutable)
    mutable.pop()
    expect(catalog.current()).toHaveLength(3)
  })

  it('refuses to go empty so the provider never serves nothing', () => {
    const catalog = new WorkBuddyCatalog()
    expect(() => catalog.set([])).toThrow(/cannot be empty/)
    expect(catalog.current().length).toBeGreaterThan(0)
  })

  it('starts usable, so a scan that has not run yet cannot blank a region', () => {
    // The permissive default matters: `setRegionUsable(false)` is called from an
    // async scan, and a region must not lose its roster before that lands.
    const catalog = new WorkBuddyCatalog()
    expect(catalog.isRegionUsable()).toBe(true)
    expect(catalog.current().length).toBeGreaterThan(0)
  })

  it('advertises nothing once its region is known to have no sign-in (issue #12)', () => {
    // The static fallback exists for an OFFLINE upstream — not for a region the
    // user has no account for, where every model is guaranteed to 401. DSH drops
    // empty groups from the picker, so an empty answer is what hides the group.
    const catalog = new WorkBuddyCatalog('global')
    expect(catalog.current().length).toBeGreaterThan(0)
    expect(catalog.setRegionUsable(false)).toBe(true)
    expect(catalog.current()).toEqual([])
    expect(catalog.isRegionUsable()).toBe(false)
  })

  it('reports no change when the usability value is already correct', () => {
    // The caller uses this to skip invalidating adapter snapshots, and it runs
    // on every settings change and card poll.
    const catalog = new WorkBuddyCatalog()
    expect(catalog.setRegionUsable(true)).toBe(false)
    catalog.setRegionUsable(false)
    expect(catalog.setRegionUsable(false)).toBe(false)
    expect(catalog.setRegionUsable(true)).toBe(true)
    expect(catalog.current().length).toBeGreaterThan(0)
  })

  it('keeps the non-empty guard and the usability flag independent', () => {
    // They answer different questions: `set()` carries a live upstream answer
    // and must never be empty, while "no account here" is a legitimate empty
    // state that must survive a later refresh. Merging them would either lose
    // the guard or lose the ability to hide the group.
    const catalog = new WorkBuddyCatalog()
    expect(() => catalog.set([])).toThrow(/cannot be empty/)
    catalog.setRegionUsable(false)
    expect(catalog.current()).toEqual([])
    // A refresh that lands while the region is unusable still restores a real
    // roster internally, ready for the moment an account appears.
    catalog.set(MODELS)
    expect(catalog.current()).toEqual([])
    catalog.setRegionUsable(true)
    expect(catalog.current()).toHaveLength(3)
  })
})

/**
 * `hasLiveRoster` is the discriminator that keeps issue #32 fixed from the
 * OTHER side.
 *
 * `applySelection` passes `current()` into `configuredModels` as the roster a
 * partial save may demote to instead of the static list. But the constructor
 * seeds `current()` with that very static list, and `resolveRoster` cannot tell
 * the two apart (it only sees a non-empty array). Without this flag a settings
 * write arriving before the first refresh would copy the static roster in as
 * if it were upstream.
 */
describe('WorkBuddyCatalog.hasLiveRoster', () => {
  it('is false before any upstream answer, even though current() is non-empty', () => {
    const catalog = new WorkBuddyCatalog('cn')
    // The trap: the seeded fallback LOOKS like a roster.
    expect(catalog.current().length).toBeGreaterThan(0)
    expect(catalog.hasLiveRoster()).toBe(false)
  })

  it('becomes true once an upstream roster is set', () => {
    const catalog = new WorkBuddyCatalog('cn')
    catalog.set(MODELS)
    expect(catalog.hasLiveRoster()).toBe(true)
  })

  it('stays false when a re-derivation is written — only upstream counts', () => {
    // applySelection writes the roster it re-derived from the saved slot; that
    // is bookkeeping, not a fresh observation.
    const catalog = new WorkBuddyCatalog('cn')
    catalog.set(MODELS, 'derived')
    expect(catalog.hasLiveRoster()).toBe(false)
  })

  it('does not go back to false after a later derived write', () => {
    // Once the upstream has answered, a re-derivation must not un-learn that.
    const catalog = new WorkBuddyCatalog('cn')
    catalog.set(MODELS)
    catalog.set(MODELS, 'derived')
    expect(catalog.hasLiveRoster()).toBe(true)
  })
})

describe('fallbackModelsFor', () => {
  it('keeps each region on its own roster — the CN fallback never leaks into global', () => {
    // The CN catalog is the one that must never seed a global account: it has
    // no gpt-*/gemini-* entries, so a global account showed a roster it could
    // not use.
    const cn = new Set(fallbackModelsFor('cn').map(model => model.id))
    const global = new Set(fallbackModelsFor('global').map(model => model.id))

    expect([...global].some(id => id.startsWith('gpt-') || id.startsWith('gemini-'))).toBe(true)
    expect([...cn].some(id => id.startsWith('gpt-') || id.startsWith('gemini-'))).toBe(false)
    expect([...cn].some(id => id.startsWith('minimax-'))).toBe(true)
    // NEITHER roster carries its region's `auto` ROUTER. They are the same
    // concept under two ids — CN `auto`, international `default-model` (name
    // "Auto", `isDefault: true`, and the only roster entry declaring no
    // `credits`). `selectCliModels` drops both from the live roster, so the
    // static list must agree or the row reappears on the offline path only.
    expect(cn.has('auto')).toBe(false)
    expect(global.has('auto')).toBe(false)
    expect(global.has('default-model')).toBe(false)
    // The international roster's OTHER aliases stay: `fast`/`balanced`/`primary`
    // are real routes with declared prices (x0.34 / x0.59 / x3.31), so they are
    // rows this plugin CAN describe. Dropping them with the router would remove
    // three models the user may legitimately want.
    expect(global.has('fast-model')).toBe(true)
    expect(global.has('balanced-model')).toBe(true)
    expect(global.has('primary-model')).toBe(true)
    // The CN open-weight deepseek ids stay CN-only; the one deepseek id the
    // international desktop channel offers is its own.
    expect(cn.has('deepseek-v4-pro')).toBe(true)
    expect(global.has('deepseek-v4-pro')).toBe(false)
    expect(global.has('deepseek-v4.1-flash')).toBe(true)
    // The CN roster does NOT carry that id, and that asymmetry decided which
    // region SCREAMED when a save wiped `lastCatalog` and the display fell back
    // to these lists: the CN user's saved target vanished from the fallback and
    // the card said "已下架", while the global user's target still resolved and
    // the same deletion went unannounced. Pinned so a future edit to either
    // roster does not silently change which failures are visible.
    expect(cn.has('deepseek-v4.1-flash')).toBe(false)
    expect(cn.has('deepseek-v4-flash')).toBe(true)
  })

  it('carries the captured credit multipliers on the global roster', () => {
    const global = fallbackModelsFor('global')
    expect(global.find(model => model.id === 'gpt-5.6-sol')?.creditMultiplier).toBe(3.47)
    expect(global.find(model => model.id === 'gpt-6-astra')?.creditMultiplier).toBe(6.67)
    // Free promotional models report a real 0 rather than "no rate known".
    expect(global.find(model => model.id === 'hy3')?.creditMultiplier).toBe(0)
    expect(global.find(model => model.id === 'deepseek-v4.1-flash')?.creditMultiplier).toBe(0)
  })

  it('defaults to the CN roster only for the cn region', () => {
    expect(fallbackModelsFor('cn')).toBe(FALLBACK_WORKBUDDY_MODELS)
  })
})

describe('WorkBuddyCatalog region enabled', () => {
  it('advertises models by default (opt-out switch)', () => {
    const catalog = new WorkBuddyCatalog('cn')
    expect(catalog.isRegionEnabled()).toBe(true)
    expect(catalog.current()).not.toHaveLength(0)
  })

  it('withdraws all models once switched off, and restores them on re-enable', () => {
    const catalog = new WorkBuddyCatalog('cn')
    catalog.setRegionEnabled(false)
    expect(catalog.isRegionEnabled()).toBe(false)
    expect(catalog.current()).toEqual([])
    catalog.setRegionEnabled(true)
    expect(catalog.isRegionEnabled()).toBe(true)
    expect(catalog.current()).not.toHaveLength(0)
  })

  it('setRegionEnabled reports whether the value changed', () => {
    const catalog = new WorkBuddyCatalog('cn')
    expect(catalog.setRegionEnabled(false)).toBe(true)
    expect(catalog.setRegionEnabled(false)).toBe(false)
    expect(catalog.setRegionEnabled(true)).toBe(true)
    expect(catalog.setRegionEnabled(true)).toBe(false)
  })

  it('a switched-off region stays empty even when usable, and an unusable region stays empty even when enabled — the two gates are independent', () => {
    const catalog = new WorkBuddyCatalog('cn')
    catalog.setRegionUsable(false)
    catalog.setRegionEnabled(true)
    expect(catalog.current()).toEqual([])
    catalog.setRegionEnabled(false)
    expect(catalog.current()).toEqual([])
    // Re-enabling alone must not resurrect a region that still has no account.
    catalog.setRegionEnabled(true)
    expect(catalog.current()).toEqual([])
    // Only when BOTH gates pass does the catalog reappear.
    catalog.setRegionUsable(true)
    expect(catalog.current()).not.toHaveLength(0)
  })
})

describe('withoutRouters', () => {
  const saved = [
    { id: 'default-model', name: 'Auto', contextWindow: 176_000, maxTokens: 24_000 },
    { id: 'fast-model', name: 'Fast', contextWindow: 200_000, maxTokens: 32_000 },
    { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 },
  ]

  it('drops a router that a SAVED catalog still names', () => {
    // The upgrade path. `lastCatalog` is a snapshot the profile carries from an
    // earlier version, and it is what the card lists — so filtering only the
    // fresh roster would leave the row on screen until the next refresh, which
    // reads as "the fix did not work".
    expect(withoutRouters(saved).map(model => model.id)).toEqual(['fast-model', 'hy3'])
  })

  it('drops the CN router under its own id', () => {
    const cn = [{ id: 'auto', name: 'Auto', contextWindow: 256_000, maxTokens: 32_000 }]
    expect(withoutRouters(cn)).toEqual([])
  })

  it('touches nothing else — the rows a user can actually pick survive', () => {
    // `fast`/`balanced`/`primary` are aliases too, but they declare real prices
    // and are legitimate picks. A broader "drop the aliases" filter would take
    // three usable models away.
    expect(withoutRouters(saved)).toHaveLength(2)
    expect(withoutRouters(saved).map(model => model.name)).toEqual(['Fast', 'Hy3'])
  })

  it('does not mutate its input', () => {
    const before = JSON.stringify(saved)
    withoutRouters(saved)
    expect(JSON.stringify(saved)).toBe(before)
  })
})
