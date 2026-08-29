import { describe, expect, it } from 'vitest'
import { deriveCatalog, FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from '../src/catalog.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

const MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000 },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000 },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, maxTokens: 50_000 },
]

describe('deriveCatalog', () => {
  it('serves the whole directory when nothing is enabled yet', () => {
    const derived = deriveCatalog(MODELS, new Set())
    expect(derived.map(model => model.id)).toEqual(['glm-5.3', 'kimi-k3-1', 'deepseek-v4-pro'])
  })

  it('keeps only the selected models, in directory order', () => {
    const derived = deriveCatalog(MODELS, new Set(['deepseek-v4-pro', 'glm-5.3']))
    expect(derived.map(model => model.id)).toEqual(['glm-5.3', 'deepseek-v4-pro'])
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
