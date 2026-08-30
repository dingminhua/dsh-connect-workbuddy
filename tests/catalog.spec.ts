import { describe, expect, it } from 'vitest'
import { deriveCatalog, FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from '../src/catalog.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

const MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000 },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000 },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, maxTokens: 50_000 },
]

describe('deriveCatalog', () => {
  it('marks the known fallback vision model as image-capable', () => {
    expect(FALLBACK_WORKBUDDY_MODELS.find(model => model.id === 'glm-5v-turbo')?.multimodal).toBe(true)
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
})
