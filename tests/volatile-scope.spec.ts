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
  // The stored document is PLAIN (that is what lands in the profile patch)...
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

/**
 * The write PATH, not just the value shape.
 *
 * The two writers have different semantics, and the difference DELETES data:
 *
 *  - `__save` merges the posted region into the field's authoritative value
 *    inside the Host, preserving every other region.
 *  - `scope.set(field, next)` hands the settings service the WHOLE field, which
 *    the client merged from its own browser mirror. The Host does no
 *    server-side merge on that path, so the client's object REPLACES the field.
 *
 * The mirror lags writes made through the endpoint (documented on
 * `contextBudgets`), so re-deriving the merge from it loses the sibling region
 * and then stores that loss verbatim.
 *
 * This is the reported Symptom: "I saved the domestic region and the
 * international one was gone" — the disk showed `accounts` with both regions
 * but `regions` holding only `cn`.
 */
describe('the Host endpoint is authoritative, so the mirror cannot delete a sibling', () => {
  /** Faithful host: server-side merge, answers with the field it stored. */
  function endpointWith(authoritative: Record<string, Record<string, unknown>>) {
    const calls: { field: string, value: Record<string, unknown> }[] = []
    const fetchImpl = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { field: string, value: Record<string, unknown> }
      calls.push(body)
      const merged = { ...(authoritative[body.field] ?? {}), ...body.value }
      authoritative[body.field] = merged
      return { ok: true, json: async () => ({ ok: true, value: merged }) }
    }
    return { fetchImpl, calls, authoritative }
  }

  const slot = (id: string) => ({ enabled: true, lastCatalog: [{ id }], enabledModelIds: [id], contextBudgets: {} })

  it('saving the second region must not delete the first', async () => {
    const { fetchImpl, authoritative } = endpointWith({})
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    try {
      // The scope stores whatever it is handed, and its mirror never learns
      // about the endpoint's merge — the exact shape on the user's machine.
      const mirror: Record<string, unknown> = {}
      const scope: WorkBuddyAccountScope = {
        getSnapshot: () => ({ value: { regions: { get: () => mirror['regions'] ?? {} } } }),
        set: async (field: string, next: unknown) => { mirror[field] = next },
      }

      await writeRegionModels(scope, 'global', slot('gpt-5.6-sol'))
      expect(Object.keys(authoritative['regions'] ?? {})).toEqual(['global'])

      // A stale mirror (as after any endpoint write) must not cost a region.
      mirror['regions'] = {}
      await writeRegionModels(scope, 'cn', slot('glm-5.3'))

      expect(Object.keys(authoritative['regions'] ?? {}).sort()).toEqual(['cn', 'global'])
      expect(authoritative['regions']?.global).toEqual(slot('gpt-5.6-sol'))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('mirrors back the value the HOST stored, never a re-merge of its own', async () => {
    // The scope records whatever it was handed, so this asserts what the client
    // chose to mirror: the Host's authoritative field, not the stale re-merge.
    const { fetchImpl } = endpointWith({})
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    try {
      const mirrored: unknown[] = []
      const scope: WorkBuddyAccountScope = {
        getSnapshot: () => ({ value: { regions: { get: () => ({}) } } }),
        set: async (_field: string, next: unknown) => { mirrored.push(next) },
      }
      await writeRegionModels(scope, 'cn', slot('glm-5.3'))
      expect(mirrored).toHaveLength(1)
      expect((mirrored[0] as Record<string, unknown>).cn).toEqual(slot('glm-5.3'))
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

/**
 * The provider switch must render the value the HOST committed.
 *
 * `writeField` sends the switch through the plugin's Host save endpoint (the
 * only writer that cannot drop the sibling region), and that endpoint does NOT
 * update the browser settings mirror. So a checkbox rendered from the mirror
 * stayed ON after a successful disable — the "不能正确取消国际版/国内版" report —
 * even though `enabled: false` was already in the settings document.
 *
 * The Host sends its committed value on the status payload (`status.enabled`),
 * and the card prefers it, falling back to the mirror only when the Host has
 * not answered yet.
 */
describe('the region switch reads the Host value, not the lagging mirror', () => {
  /** Mirrors the card's `regionOn` resolution order. */
  function regionOn(
    fromHost: boolean | undefined,
    mirror: unknown,
    region: 'cn' | 'global',
  ): boolean {
    if (typeof fromHost === 'boolean') return fromHost
    return regionEnabledOf(mirror, region)
  }

  it('shows OFF after the Host committed a disable, though the mirror still says ON', () => {
    // The mirror is stale — exactly the shape after an endpoint-first write.
    const staleMirror = { regions: { global: { enabled: true } } }
    expect(regionOn(false, staleMirror, 'global')).toBe(false)
  })

  it('shows ON after the Host committed an enable, though the mirror still says OFF', () => {
    const staleMirror = { regions: { global: { enabled: false } } }
    expect(regionOn(true, staleMirror, 'global')).toBe(true)
  })

  it('falls back to the mirror when the Host has not answered yet', () => {
    // A host that predates the field, or a status still loading.
    expect(regionOn(undefined, { regions: { global: { enabled: false } } }, 'global')).toBe(false)
    expect(regionOn(undefined, { regions: { global: { enabled: true } } }, 'global')).toBe(true)
    // ...and keeps the opt-out rule for a slot that never carried the flag.
    expect(regionOn(undefined, { regions: { global: { enabledModelIds: [] } } }, 'global')).toBe(true)
  })

  it('keeps the live-reference tolerance on the fallback path', () => {
    // The mirror holds `{get(): T}` on both DSH lines; the fallback must still
    // read the flag rather than reporting ON forever.
    const liveMirror = { regions: { get: () => ({ global: { enabled: false } }) } }
    expect(regionOn(undefined, liveMirror, 'global')).toBe(false)
  })
})
