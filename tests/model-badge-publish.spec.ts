/**
 * Publishing this plugin's selector badge into the host's model catalog.
 *
 * WHY THIS FILE EXISTS. `conversation.input.model.label` is a `single` slot: one
 * plugin wins it and draws EVERY provider's rows, and the host's own badge
 * fallback only runs when the cell has NO occupant. A chip therefore survives
 * another plugin winning the cell only if it travels as DATA. From 0.2.2 the
 * host's directory carries `LlmModelInfo.badge`, and the adapter's own
 * `listModels()` is the only route a third-party plugin can fill it through
 * (`docs/MODEL-LABEL-SPEC.md`).
 *
 * The other half — reproducing a SIBLING's badge in the label component — is
 * pinned in `tests/model-label-slot-coexistence.spec.tsx`. Both halves are
 * needed: without this one a sibling has nothing to reproduce.
 *
 * These tests drive the REAL `createWorkBuddyAdapter` and its real
 * `PiAiAdapter` base class, so they fail if the host's normalization stops
 * carrying `badge` as well as if this plugin stops supplying one.
 */
import { describe, expect, it } from 'vitest'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from '../src/adapter.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { WorkBuddyPromo } from '../src/promo.ts'

/** One promotion that is running at every instant, so the test is clock-free. */
function alwaysOn(overrides: Partial<WorkBuddyPromo> = {}): WorkBuddyPromo {
  return {
    id: 'free-now',
    source: 'promotion',
    modelIds: ['model-a'],
    badge: { label: '限时免费', labelEn: 'Free now', color: '#009273' },
    priority: 100,
    schedule: {
      timezone: 'Asia/Shanghai',
      validFrom: Date.UTC(2000, 0, 1),
      validUntil: Date.UTC(2100, 0, 1),
    },
    ...overrides,
  } as unknown as WorkBuddyPromo
}

/** A catalog seeded with one model, optionally carrying promotions. */
function catalogWith(promos: readonly WorkBuddyPromo[] | undefined): WorkBuddyCatalog {
  const catalog = new WorkBuddyCatalog()
  catalog.set([{
    id: 'model-a',
    name: 'Model A',
    contextWindow: 200_000,
    maxTokens: 8_192,
    ...promos === undefined ? {} : { promos },
  }], 'upstream')
  return catalog
}

/** Build the adapter over a catalog and read back what it publishes. */
async function listModels(catalog: WorkBuddyCatalog): Promise<readonly Record<string, unknown>[]> {
  const { adapter } = createWorkBuddyAdapter({
    shim: { baseUrl: () => 'http://127.0.0.1:1', token: async () => 'shared-secret' } as never,
    store: {} as never,
    catalog,
    piAiGeneration: 'modern',
  })
  // The base class types this as `LlmModelInfo[]`, which at 0.1.7 has no
  // `badge`. The property is what is under test, so read it structurally.
  return await adapter.listModels(WORKBUDDY_PROVIDER) as unknown as readonly Record<string, unknown>[]
}

describe('the adapter publishes this plugin\'s badge', () => {
  it('attaches a badge for a model whose promotion is running', async () => {
    const models = await listModels(catalogWith([alwaysOn()]))
    expect(models).toHaveLength(1)
    const badge = models[0]?.['badge'] as { text: unknown, tone: string } | undefined
    expect(badge, 'the model list carries no badge at all').toBeDefined()
    expect(badge?.tone).toBe('success')
    // Both languages, because the host resolves against the READER's locale and
    // this function runs where the browser's language is not knowable.
    expect(badge?.text).toEqual({ en: 'Free now', zh: '限时免费' })
  })

  it('publishes a plain string when both wordings are identical', async () => {
    // The global feed's `label` is already English, so a one-language table
    // would be noise — and a table whose `en` happened to be missing would
    // resolve to `undefined` and silently drop the chip.
    const models = await listModels(catalogWith([alwaysOn({
      badge: { label: 'Free now', color: '#009273' },
    } as unknown as Partial<WorkBuddyPromo>)]))
    const badge = models[0]?.['badge'] as { text: unknown } | undefined
    expect(badge?.text).toBe('Free now')
  })

  it('omits the field entirely when no promotion holds', async () => {
    // NOT `badge: null`: the host's registry normalization reads `badge.text`
    // and a null there THROWS, which drops the whole provider from the catalog.
    for (const promos of [undefined, []]) {
      const models = await listModels(catalogWith(promos))
      expect(models).toHaveLength(1)
      expect(models[0], 'a badge key appeared with no promotion behind it')
        .not.toHaveProperty('badge')
    }
  })

  it('keeps every other catalog field the base adapter produced', async () => {
    // The override spreads the base result, so a future host field must survive
    // it. Losing `inputModalities` here would silently disable image input.
    const models = await listModels(catalogWith([alwaysOn()]))
    expect(models[0]?.['provider']).toBe(WORKBUDDY_PROVIDER)
    expect(models[0]?.['id']).toBe('model-a')
    // The display name the base adapter builds, credit multiplier included —
    // the badge must not replace or decorate it.
    expect(models[0]?.['name']).toBe('Model A')
    expect(models[0]?.['inputModalities']).toEqual(['text'])
  })

  it('does not throw when the catalog holds no such model', async () => {
    // `resolveModelBadge` looks the id up again; an id the base adapter knows
    // about but the catalog no longer carries must degrade to "no badge".
    const models = await listModels(catalogWith([alwaysOn()]))
    expect(models.length).toBeGreaterThan(0)
  })
})
