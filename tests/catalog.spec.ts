import { describe, expect, it } from 'vitest'
import { deriveCatalog, fallbackModelsFor, FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from '../src/catalog.ts'
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

  it('defaults every model above 200K to 200K and preserves smaller maxima', () => {
    const derived = deriveCatalog([
      ...MODELS,
      { id: 'kimi', name: 'Kimi', contextWindow: 256_000, maxTokens: 32_000 },
      { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 },
    ], new Set())
    expect(derived.map(model => model.contextWindow)).toEqual([200_000, 200_000, 200_000, 200_000, 192_000])
  })

  it('keeps only selected models and applies explicit 1M budgets', () => {
    const derived = deriveCatalog(
      MODELS,
      new Set(['deepseek-v4-pro', 'glm-5.3']),
      { 'deepseek-v4-pro': 1_000_000 },
    )
    expect(derived.map(model => [model.id, model.contextWindow])).toEqual([
      ['glm-5.3', 200_000],
      ['deepseek-v4-pro', 1_000_000],
    ])
  })

  it('ignores selections for models no longer in the directory', () => {
    const derived = deriveCatalog(MODELS, new Set(['glm-5.3', 'retired-model']))
    expect(derived.map(model => model.id)).toEqual(['glm-5.3'])
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
    // The international roster uses `default-model`, the CN one `auto`.
    expect(global.has('default-model')).toBe(true)
    expect(cn.has('auto')).toBe(true)
    expect(cn.has('default-model')).toBe(false)
    // The CN open-weight deepseek ids stay CN-only; the one deepseek id the
    // international desktop channel offers is its own.
    expect(cn.has('deepseek-v4-pro')).toBe(true)
    expect(global.has('deepseek-v4-pro')).toBe(false)
    expect(global.has('deepseek-v4.1-flash')).toBe(true)
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
