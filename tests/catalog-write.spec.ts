import { describe, expect, it } from 'vitest'
import { healRegionsField, mergeRegionCatalog, writeRegionCatalog } from '../src/catalog-write.ts'
import type { HostSettingsService } from '../src/catalog-write.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

/**
 * THE REGRESSION THIS FILE EXISTS FOR (the "restart reset" report).
 *
 * `writeRegionCatalog` writes `{ op: 'set', path: ['regions'] }`, i.e. its value
 * must be the `regions` FIELD. It used to hand `mergeRegionCatalog` the whole
 * resolved settings section (`describe().value`) — which that helper read as if
 * it were the field. The result was a field shaped
 * `{ accounts, regions, cliBridge }`: the real region map pushed one level down,
 * its siblings turned into fake region slots, and NOTHING at `config.regions.cn`.
 *
 * The Host reads exactly one level (`regionStateOf` → `config.regions[region]`),
 * so the visible symptom was every account-pool preference, model selection and
 * model directory vanishing at the next start — and coming back only when the
 * card happened to save again. Each startup added another nesting level; a real
 * profile reached five levels and 258 KB.
 *
 * The tests below pin the two halves: the value written is the FIELD (not the
 * section), and an already-corrupted field is healed rather than propagated.
 */

const repair: WorkBuddyModelInfo[] = [
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 },
]

/** A resolved settings SECTION exactly as `describe().value` delivers it. */
function sectionOf(regions: Record<string, unknown>): Record<string, unknown> {
  return {
    authFile: '/tmp/auth.info',
    accounts: { cn: 'acct-cn', global: 'acct-gl' },
    regions,
    lastCatalog: [],
    enabledModelIds: [],
    cliBridge: { enabled: false },
  }
}

describe('mergeRegionCatalog: the value written at path ["regions"] is the FIELD', () => {
  it('takes the whole settings section and answers the region map, nothing else', () => {
    const section = sectionOf({
      cn: {
        enabled: true,
        enabledModelIds: ['hy3'],
        pool: { enabled: true, targetModelId: 'hy3', memberAccountIds: ['m1', 'm2'] },
        lastCatalog: [],
      },
      global: { enabled: false, pool: { enabled: false }, lastCatalog: [] },
    })
    const next = mergeRegionCatalog(section, 'cn', repair)

    // The regression: no section keys at this level, and `cn` IS here.
    expect(Object.keys(next).sort()).toEqual(['cn', 'global'])
    expect(next['cn']).toBeDefined()
    expect(next['accounts']).toBeUndefined()
    expect(next['cliBridge']).toBeUndefined()
    expect(next['regions']).toBeUndefined()

    // The repaired directory lands in the region's slot…
    expect((next['cn'] as { lastCatalog: unknown }).lastCatalog).toEqual(repair)
    // …without dropping the preferences that live beside it.
    expect(next['cn']).toMatchObject({
      enabled: true,
      enabledModelIds: ['hy3'],
      pool: { enabled: true, memberAccountIds: ['m1', 'm2'], targetModelId: 'hy3' },
    })
    // …and the sibling region is untouched.
    expect(next['global']).toEqual(section['regions'] && (section['regions'] as Record<string, unknown>)['global'])
  })

  it('accepts the bare field too, and still answers just the field', () => {
    const field = { cn: { enabled: true, lastCatalog: [] }, global: { enabled: true } }
    expect(mergeRegionCatalog(field, 'cn', repair)).toEqual({
      cn: { enabled: true, lastCatalog: repair },
      global: { enabled: true },
    })
  })

  it('unwraps a live `{get()}` reference without leaking the function into the write', () => {
    // A volatile field resolves as a `{get(): T}` LIVE reference. Spreading it
    // leaks `get` into the payload and the strict JSON codec on `mutate` then
    // rejects the whole save ("found a function at $.ops[0].value.get").
    const live = { get: () => ({ cn: { enabled: true, lastCatalog: [] } }) }
    const next = mergeRegionCatalog({ regions: live, accounts: {} }, 'cn', repair)
    expect(Object.keys(next)).toEqual(['cn'])
    expect(JSON.parse(JSON.stringify(next))).toEqual({ cn: { enabled: true, lastCatalog: repair } })
  })
})

describe('mergeRegionCatalog: heals a field an earlier build already corrupted', () => {
  /**
   * The measured shape: `cn` at the surface, `global` only one level down, and
   * the bug's own copies (`accounts` / `cliBridge` / a nested `regions`) sitting
   * beside them. `global`'s buried slot is the ONLY place the international
   * pool's members survive, so dropping it would delete the user's config.
   */
  const corrupted = sectionOf({
    accounts: { enabled: true },
    cliBridge: { enabled: false },
    regions: {
      cn: { enabled: true, pool: { enabled: true, memberAccountIds: ['old-cn'] } },
      global: {
        enabled: true,
        pool: { enabled: true, targetModelId: 'm', memberAccountIds: ['g1', 'g2', 'g3'] },
        lastCatalog: [],
      },
    },
    cn: {
      enabled: true,
      pool: { enabled: true, memberAccountIds: ['cn1'], orderAccountIds: [] },
      lastCatalog: [],
    },
  })

  it('drops the sibling-copy keys and keeps only real regions', () => {
    const next = mergeRegionCatalog(corrupted, 'cn', repair)
    expect(Object.keys(next).sort()).toEqual(['cn', 'global'])
    expect(next['accounts']).toBeUndefined()
    expect(next['cliBridge']).toBeUndefined()
    expect(next['regions']).toBeUndefined()
  })

  it('keeps the SURFACE slot of a region that is there (the newest copy)', () => {
    // "Shallowest wins" for a region that exists, even though the buried copy
    // has more configured members: re-reading a stale inner copy over the outer
    // one is exactly the defect the shape rule was fixed for.
    const next = mergeRegionCatalog(corrupted, 'cn', repair)
    expect(next['cn']).toMatchObject({ pool: { memberAccountIds: ['cn1'] }, lastCatalog: repair })
  })

  it('recovers a region that only survives one level down', () => {
    const next = mergeRegionCatalog(corrupted, 'cn', repair)
    expect(next['global']).toMatchObject({ pool: { enabled: true, memberAccountIds: ['g1', 'g2', 'g3'] } })
  })

  it('prefers the buried copy that carries the configuration over a hollow newer one', () => {
    // The bug's own directory repair left `{ lastCatalog }` slots one level
    // above the copy that still had the pool in it. Picking the shallower one
    // would resurrect "no pool configured" and then write it back.
    const hollow = sectionOf({
      regions: {
        global: { lastCatalog: [{ id: 'stale', name: 'Stale', contextWindow: 1, maxTokens: 1 }] },
        cn: { enabled: true },
      },
      cn: { enabled: true },
    })
    // One level further down: the configured copy.
    ;(hollow['regions'] as Record<string, unknown>)['regions'] = {
      global: { enabled: false, pool: { enabled: true, memberAccountIds: ['keep-me'] } },
    }
    const next = mergeRegionCatalog(hollow, 'cn', repair)
    expect(next['global']).toMatchObject({ pool: { memberAccountIds: ['keep-me'] } })
  })
})

describe('writeRegionCatalog: mutates path ["regions"] with the field it built', () => {
  it('hands mutate the region map, not the section around it', async () => {
    const calls: { path: readonly string[], value: unknown }[] = []
    const service: HostSettingsService = {
      describe: () => [{
        ns: 'workbuddy',
        value: sectionOf({ cn: { enabled: true, lastCatalog: [] }, global: { enabled: false } }),
      }],
      mutate: async (ns, ops) => {
        expect(ns).toBe('workbuddy')
        calls.push(...ops.map(op => ({ path: op.path, value: op.value })))
      },
    }
    await expect(writeRegionCatalog(service, 'workbuddy', 'cn', repair)).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toEqual(['regions'])
    // The whole point: `cn` at the top of the written value, no `accounts`.
    expect(calls[0]?.value).toEqual({
      cn: { enabled: true, lastCatalog: repair },
      global: { enabled: false },
    })
  })

  it('is a no-op without a settings service or without the namespace', async () => {
    await expect(writeRegionCatalog(undefined, 'workbuddy', 'cn', repair)).resolves.toBe(false)
    const service: HostSettingsService = {
      describe: () => [{ ns: 'someone-else', value: {} }],
      mutate: async () => { throw new Error('must not be called') },
    }
    await expect(writeRegionCatalog(service, 'workbuddy', 'cn', repair)).resolves.toBe(false)
  })
})

describe('healRegionsField: the boot-time clean-up needs no upstream', () => {
  const corruptedField = {
    accounts: { enabled: true },
    regions: { global: { enabled: true, pool: { enabled: true, memberAccountIds: ['g1'] } } },
    cliBridge: { enabled: false },
    cn: { enabled: true, pool: { enabled: true, memberAccountIds: ['m1'] } },
  }

  it('replaces a corrupt field with the healed map, and touches nothing else', async () => {
    const calls: { path: readonly string[], value: unknown }[] = []
    const service: HostSettingsService = {
      describe: () => [{ ns: 'workbuddy', value: sectionOf(corruptedField) }],
      mutate: async (ns, ops) => {
        expect(ns).toBe('workbuddy')
        calls.push(...ops.map(op => ({ path: op.path, value: op.value })))
      },
    }
    await expect(healRegionsField(service, 'workbuddy')).resolves.toBe(true)
    expect(calls.map(call => call.path)).toEqual([['regions']])
    const written = calls[0]?.value as Record<string, unknown>
    expect(Object.keys(written).sort()).toEqual(['cn', 'global'])
    expect(written['cn']).toMatchObject({ pool: { memberAccountIds: ['m1'] } })
    expect(written['global']).toMatchObject({ pool: { memberAccountIds: ['g1'] } })
  })

  it('does not write at all for a healthy field', async () => {
    // Not a courtesy: every boot would otherwise re-write the region map and
    // churn the profile file (and its backups) for no reason.
    const service: HostSettingsService = {
      describe: () => [{
        ns: 'workbuddy',
        value: sectionOf({ cn: { enabled: true }, global: { enabled: false } }),
      }],
      mutate: async () => { throw new Error('must not be called') },
    }
    await expect(healRegionsField(service, 'workbuddy')).resolves.toBe(false)
  })

  it('answers "no write" without a settings service or the namespace', async () => {
    await expect(healRegionsField(undefined, 'workbuddy')).resolves.toBe(false)
    const service: HostSettingsService = {
      describe: () => [{ ns: 'someone-else', value: sectionOf(corruptedField) }],
      mutate: async () => { throw new Error('must not be called') },
    }
    await expect(healRegionsField(service, 'workbuddy')).resolves.toBe(false)
  })

  it('unwraps a live `{get()}` reference before asking the field', async () => {
    // `describe()` hands the section back with volatile fields resolved to live
    // references. A shape check that did not unwrap would see `{get}` — an
    // object with no keys — call the profile healthy, and never clean it.
    const field = { get: () => corruptedField }
    const service: HostSettingsService = {
      describe: () => [{ ns: 'workbuddy', value: { ...sectionOf({}), regions: field } }],
      mutate: async (_ns, ops) => {
        const written = ops[0]?.value as Record<string, unknown>
        expect(Object.keys(written).sort()).toEqual(['cn', 'global'])
      },
    }
    await expect(healRegionsField(service, 'workbuddy')).resolves.toBe(true)
  })
})

/**
 * Concurrent `regions` writes must not lose one another.
 *
 * Every writer here is a read-modify-write: `describe()` the authoritative field,
 * merge ONE region into it, `mutate()` the whole field back. Two running at once
 * both read the pre-write value, so the second overwrites the first — silently,
 * with both calls resolving. The window predates the scheduled price refresh, but
 * that feature made it reachable: it is armed at `apply` with a zero delay, so its
 * write lands in the same turn as the startup repair's, for both regions.
 *
 * THE FIX IS NOT A RETRY. Serially re-running would need the caller to redo a
 * merge whose inputs it no longer holds; queuing the writes removes the window
 * instead. The service below makes the race deterministic by resolving
 * `describe()` only after a tick, so unserialized writes WOULD interleave here.
 */
describe('writeRegionCatalog: concurrent writes are serialized', () => {
  it('lets two overlapping region writes both land', async () => {
    let field: Record<string, unknown> = { cn: { enabled: true }, global: { enabled: true } }
    // Resolves only when the test says so, which is what makes the race
    // deterministic: BOTH writes have already called `describe()` (and so hold
    // the same pre-write value) before either `mutate()` lands.
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const service: HostSettingsService = {
      describe: () => [{ ns: 'workbuddy', value: { regions: structuredClone(field) } }],
      mutate: async (_ns, ops) => {
        await gate
        field = structuredClone(ops[0]?.value) as Record<string, unknown>
      },
    } as HostSettingsService

    const cnRepair: WorkBuddyModelInfo[] = [{ id: 'glm-5.3', name: 'GLM', contextWindow: 1, maxTokens: 1 }]
    const globalRepair: WorkBuddyModelInfo[] = [{ id: 'hy3', name: 'Hy3', contextWindow: 1, maxTokens: 1 }]
    const both = Promise.all([
      writeRegionCatalog(service, 'workbuddy', 'cn', cnRepair),
      writeRegionCatalog(service, 'workbuddy', 'global', globalRepair),
    ])
    // Let the synchronous head of each write run (its `describe()`), then open
    // the gate. Serialized, only ONE of them has reached `mutate()` by now.
    await Promise.resolve()
    release()
    await both

    // The lost update this pins: unserialized, the second value was built from
    // the pre-write field, so ONE of the two repairs vanished.
    expect((field['cn'] as Record<string, unknown>)['lastCatalog']).toEqual(cnRepair)
    expect((field['global'] as Record<string, unknown>)['lastCatalog']).toEqual(globalRepair)
  })

  it('keeps the queue running after a write rejects', async () => {
    // A failed write must not wedge every later one. Without the swallowed copy
    // on the chain, the next caller's `.then()` would inherit this rejection.
    let attempts = 0
    const service: HostSettingsService = {
      describe: () => [{ ns: 'workbuddy', value: { regions: { cn: { enabled: true } } } }],
      mutate: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('locked file')
      },
    } as HostSettingsService

    await expect(writeRegionCatalog(service, 'workbuddy', 'cn', repair)).rejects.toThrow('locked file')
    // The next write still runs and succeeds.
    await expect(writeRegionCatalog(service, 'workbuddy', 'cn', repair)).resolves.toBe(true)
    expect(attempts).toBe(2)
  })
})
