import { describe, expect, it } from 'vitest'
import { nextRegionEnabled, regionEnabledOf } from '../src/status-paths.ts'
import { writeAccountSlot, writeRegionEnabled, writeRegionModels } from '../src/client/account-selection.ts'
import type { WorkBuddyAccountScope } from '../src/client/account-selection.ts'

/**
 * The client half reading a settings section that carries LIVE REFERENCES.
 *
 * Regression suite for the report "saving the international region loses the
 * domestic one" (and the mirror case). Every write in the card preserves the
 * region it is not editing by spreading the region it read out of the resolved
 * settings section — so a read that returns `{get: <function>}` instead of the
 * map deletes the untouched region on every save.
 *
 * The scope shape that SHIPS, not the one the rest of the suite models.
 *
 * `regions` and `accounts` are declared `asVolatile(...)`, and schemastery
 * resolves a volatile field to a `{get(): T}` LIVE REFERENCE. That happens in
 * schemastery itself, from the schema's `meta.volatile` — so it is independent
 * of the DSH line, and it is what the resolved section looks like to the card
 * on BOTH 0.1.5 and 0.1.7 (the user hit exactly this shape through `__save`).
 *
 * A live reference is still `typeof === 'object'`, which is why it slips past
 * the "is this an object?" guard and gets spread as `{get: <function>}`.
 */
function volatileScopeWith(initial: {
  accounts?: Record<string, string>
  regions?: Record<string, unknown>
}): { scope: WorkBuddyAccountScope, document: () => Record<string, unknown> } {
  // The stored document is PLAIN (that is what lands in settings.yaml)...
  let document: Record<string, unknown> = { ...initial }
  return {
    scope: {
      // ...but the RESOLVED value the scope hands out wraps each volatile field
      // in a live reference, exactly as schemastery's resolve() does.
      getSnapshot: () => ({
        value: {
          accounts: { get: () => document['accounts'] ?? {} },
          regions: { get: () => document['regions'] ?? {} },
        },
      }),
      set: async (field: string, value: unknown) => {
        document = { ...document, [field]: value }
      },
    },
    document: () => document,
  }
}

const payload = {
  lastCatalog: [{ id: 'glm-5.3' }],
  enabledModelIds: ['glm-5.3'],
  contextBudgets: {},
}

describe('settings scope delivering volatile fields as live references', () => {
  it('writeRegionModels must not drop the other region', async () => {
    const { scope, document } = volatileScopeWith({
      regions: {
        global: { enabled: true, enabledModelIds: ['gpt-5.6-sol'] },
        cn: { enabled: true, enabledModelIds: ['old'] },
      },
    })
    await writeRegionModels(scope, 'cn', payload)
    const regions = document()['regions'] as Record<string, unknown>
    // The user's report: saving one region loses the other.
    expect(Object.keys(regions)).toContain('global')
    expect(regions.cn).toEqual(payload)
  })

  it('writeRegionModels must never store the reference FUNCTION', async () => {
    const { scope, document } = volatileScopeWith({ regions: { global: { enabled: true } } })
    await writeRegionModels(scope, 'cn', payload)
    const regions = document()['regions'] as Record<string, unknown>
    expect(typeof (regions as { get?: unknown }).get).not.toBe('function')
    // Whatever lands must survive the Host's JSON-compatibility gate.
    expect(() => JSON.parse(JSON.stringify(regions))).not.toThrow()
  })

  it('writeAccountSlot must not drop the other region', async () => {
    const { scope, document } = volatileScopeWith({ accounts: { global: 'global-id', cn: 'old' } })
    await writeAccountSlot(scope, 'cn', 'new-id')
    expect(document()['accounts']).toEqual({ global: 'global-id', cn: 'new-id' })
  })

  it('writeRegionEnabled must not drop the other region', async () => {
    const { scope, document } = volatileScopeWith({
      regions: { global: { enabled: true }, cn: { enabled: true } },
    })
    await writeRegionEnabled(scope, 'cn', false, { enabled: false })
    const regions = document()['regions'] as Record<string, unknown>
    expect(Object.keys(regions)).toContain('global')
    expect((regions.cn as { enabled?: boolean }).enabled).toBe(false)
  })

  it('reads back the written slot so a landed write is verified, not falsely failed', async () => {
    // The landed-check reads the SAME snapshot. Through a live reference that
    // read returns `undefined`, so a write that actually landed would be
    // reported as failed and re-sent to the Host endpoint.
    const { scope } = volatileScopeWith({ regions: { cn: { enabled: true } } })
    await expect(writeRegionModels(scope, 'cn', payload)).resolves.toBeUndefined()
  })
})

/**
 * The same live reference reaches the CARD's own reads, not just the write
 * helper. `regionEnabledOf` / `nextRegionEnabled` narrow the settings section
 * to the `regions` map — and a live reference is `typeof === 'object'` and not
 * an array, so it passed the naive object check and was returned AS the map.
 */
describe('card region reads through a live reference', () => {
  const liveSection = (regions: Record<string, unknown>) => ({
    regions: { get: () => regions },
  })

  it('regionEnabledOf sees a switched-off region instead of reporting on forever', () => {
    // The historical shipped bug this helper documents: a wrong narrowing made
    // the checkbox read `true` forever so clicking it appeared dead.
    expect(regionEnabledOf(liveSection({ cn: { enabled: false } }), 'cn')).toBe(false)
    expect(regionEnabledOf(liveSection({ cn: { enabled: true } }), 'cn')).toBe(true)
  })

  it('nextRegionEnabled carries the other region through the section shape', () => {
    const next = nextRegionEnabled(
      liveSection({ global: { enabled: true, enabledModelIds: ['gpt-5.6-sol'] }, cn: { enabled: true } }),
      'cn',
      false,
    )
    // Toggling CN must not delete the international region's slot.
    expect(next.global).toEqual({ enabled: true, enabledModelIds: ['gpt-5.6-sol'] })
    expect((next.cn as { enabled?: boolean }).enabled).toBe(false)
  })
})
