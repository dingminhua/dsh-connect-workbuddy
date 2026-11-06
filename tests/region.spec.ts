import { describe, expect, it } from 'vitest'
import {
  nextRegionCnBase,
  nextRegionEnabled,
  nextRegionSlots,
  regionCnBaseOf,
  regionEnabledOf,
  regionsFieldIsCorrupt,
  regionsMapOf,
} from '../src/status-paths.ts'
import { regionEnabled, regionStateOf } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/**
 * The region on/off switch, mirrored from dsh-connect-trae (issue #11). These
 * tests lock the invariants that broke once there: the card passing the WHOLE
 * settings section where the `regions` map was expected (lookup read
 * `section['cn']`, found nothing, reported `true` forever — the checkbox looked
 * dead), and a toggle silently dropping the user's model picks or re-opening a
 * disabled region.
 */

describe('regionEnabledOf', () => {
  it('defaults to on when the flag is absent (opt-out, old config stays on)', () => {
    expect(regionEnabledOf({}, 'cn')).toBe(true)
    expect(regionEnabledOf({ regions: {} }, 'global')).toBe(true)
  })

  it('is on unless the flag is explicitly false', () => {
    expect(regionEnabledOf({ regions: { cn: { enabled: true } } }, 'cn')).toBe(true)
    expect(regionEnabledOf({ regions: { cn: { enabled: false } } }, 'cn')).toBe(false)
    // The truthiness edge: only a strict `false` disables; null/undefined/'' do not.
    expect(regionEnabledOf({ regions: { cn: { enabled: null } } }, 'cn')).toBe(true)
  })

  it('accepts the WHOLE settings section, not just the regions map', () => {
    const whole = { regions: { cn: { enabled: false } }, someOther: 1 }
    expect(regionEnabledOf(whole, 'cn')).toBe(false)
    expect(regionEnabledOf(whole, 'global')).toBe(true)
  })

  it('reads from the bare regions map when given one', () => {
    expect(regionEnabledOf({ cn: { enabled: false } }, 'cn')).toBe(false)
  })

  it('does NOT hop a layer when the regions MAP itself carries a dirty `regions` key', () => {
    // Observed on a live profile: `config.regions` held `accounts`, `regions`
    // and `cliBridge` beside `cn` / `global` — sibling field names a pre-fix
    // build had written INTO the map. The old rule ("has a `regions` key =>
    // the caller passed the whole section") then jumped down to a STALE copy of
    // the same region, and a saved manual pool order read back as empty: the
    // user's sort looked unsaved while the file still had it.
    //
    // The shallow copy is the truth here; the nested one is the stale duplicate.
    const dirtyMap = {
      regions: { cn: { enabled: true, pool: { orderAccountIds: [] } } }, // stale copy
      cliBridge: { enabled: false },
      cn: { enabled: false, pool: { orderAccountIds: ['c', 'a', 'b'] } }, // the real slot
      global: { enabled: true },
    }
    expect(regionEnabledOf(dirtyMap, 'cn'), 'must read the shallow slot').toBe(false)
    // …and the same for the whole section, where hopping IS correct.
    const whole = { regions: dirtyMap, lastCatalog: [] }
    expect(regionEnabledOf(whole, 'cn')).toBe(false)
  })

  it('still hops for a section whose only non-region key is `accounts`-like', () => {
    // `accounts` is ambiguous (a real top-level field AND a stray key inside the
    // live map), so it is not treated as evidence. A section carrying any OTHER
    // field still hops.
    const section = { regions: { cn: { enabled: false } }, models: [] }
    expect(regionEnabledOf(section, 'cn')).toBe(false)
  })
})

describe('nextRegionEnabled', () => {
  it('flips only the target region enabled flag and keeps its other fields', () => {
    const before = {
      regions: {
        cn: { enabled: true, enabledModelIds: ['glm-5.3'], contextBudgets: { 'glm-5.3': 200_000 } },
      },
    }
    const after = nextRegionEnabled(before, 'cn', false)
    expect(after).toEqual({
      cn: { enabled: false, enabledModelIds: ['glm-5.3'], contextBudgets: { 'glm-5.3': 200_000 } },
    })
  })

  it('accepts the whole section and returns just the regions map', () => {
    const whole = { regions: { cn: { enabled: true } }, accounts: { cn: 'a' } }
    const after = nextRegionEnabled(whole, 'cn', false)
    expect(after).toEqual({ cn: { enabled: false } })
  })

  it('does not touch the other region', () => {
    const before = { regions: { cn: { enabled: true }, global: { enabled: false, lastCatalog: [] } } }
    const after = nextRegionEnabled(before, 'cn', false)
    expect(after.global).toEqual({ enabled: false, lastCatalog: [] })
  })

  it('works for a signed-out region too (the one the user most wants off)', () => {
    const after = nextRegionEnabled({ regions: {} }, 'global', false)
    expect(after).toEqual({ global: { enabled: false } })
  })
})

describe('nextRegionSlots', () => {
  it('carries over the other region slots untouched', () => {
    const before = { cn: { enabled: true }, global: { enabled: false } }
    const after = nextRegionSlots(before, 'cn', { enabled: true, lastCatalog: [] })
    expect(after).toEqual({
      cn: { enabled: true, lastCatalog: [] },
      global: { enabled: false },
    })
  })
})

describe('regionsMapOf: the common case must not pay for the healing', () => {
  it('returns a CLEAN field as the very object it was handed', () => {
    // Not an optimisation detail — a latency contract. `regionsMapOf` is on the
    // Host's request path through `regionStateOf`, and the healing path
    // deep-copies the whole field, including a multi-model directory per region.
    // Measured on a 28-model slot: 11 µs per call against 0.05 µs for the bare
    // lookup it replaced. Returning the same reference pins the fast path.
    const field = { cn: { enabled: true, lastCatalog: [{ id: 'm' }] }, global: { enabled: false } }
    expect(regionsMapOf(field)).toBe(field)
    // A volatile field arrives as a live `{get()}` reference: still no copy.
    const live = { get: () => field }
    expect(regionsMapOf(live)).toBe(field)
    // A whole SECTION takes the healing path (it has to be reconstructed).
    expect(regionsMapOf({ regions: field, accounts: {} })).not.toBe(field)
  })

  it('still heals when the field is dirty, including a `regions: null` leftover', () => {
    // `null` is a foreign key too: an old writer could store it, and the fast
    // path must not hand it back as if it were a clean map.
    expect(regionsMapOf({ cn: { enabled: true }, regions: null })).toEqual({ cn: { enabled: true } })
  })
})

describe('regionEnabled (Host pure function)', () => {
  const cnSlot = { enabled: true, lastCatalog: [], enabledModelIds: [], imageModelIds: [], contextBudgets: {} }
  const globalSlot = { enabled: true, lastCatalog: [], enabledModelIds: [], imageModelIds: [], contextBudgets: {} }
  const base = { regions: { cn: cnSlot, global: globalSlot } } as Config

  it('is on by default, including for pre-region-split flat configs', () => {
    expect(regionEnabled(base, 'cn')).toBe(true)
    expect(regionEnabled({} as Config, 'cn')).toBe(true)
    // A flat config predating the regions map never carries `enabled`.
    expect(regionEnabled({ lastCatalog: [] } as unknown as Config, 'global')).toBe(true)
  })

  it('is off only on an explicit false', () => {
    const config = { regions: { cn: cnSlot, global: { ...globalSlot, enabled: false } } } as Config
    expect(regionEnabled(config, 'global')).toBe(false)
    expect(regionEnabled(config, 'cn')).toBe(true)
  })
})

describe('regionStateOf: a field an earlier build buried one level down', () => {
  /**
   * THE MEASURED DOCUMENT (the "restart reset" report). The buggy catalog repair wrote the whole
   * settings section into the `regions` field, which pushed the real region map
   * under a nested `regions` key. `cn` survived at the surface (a later card
   * save), `global` did NOT — its pool, selection and directory lived only in
   * the buried copy.
   *
   * `regionStateOf` is the ONE read the Host decides everything with: pool on/off,
   * pool members and order, the model selection, the directory, the switches.
   * Before the heal it answered `{}` for `global`, i.e. "never configured", and
   * the next save then wrote that emptiness back.
   */
  const corrupted = {
    regions: {
      accounts: { enabled: true, pool: { enabled: false } }, // the bug's copy of a sibling FIELD
      regions: { // the buried (older) region map — the only copy of `global`
        cn: { enabled: true, pool: { enabled: true, memberAccountIds: ['older-cn'] } },
        global: {
          enabled: true,
          pool: { enabled: true, targetModelId: 'hy3', memberAccountIds: ['g1', 'g2'] },
          enabledModelIds: ['hy3'],
        },
      },
      cliBridge: { enabled: false }, // another sibling copy
      cn: { enabled: true, pool: { enabled: true, memberAccountIds: ['cn1'] } }, // newest
    },
  } as unknown as Config

  it('recovers the region whose slot only survives one level down', () => {
    const state = regionStateOf(corrupted, 'global')
    expect(state.pool).toMatchObject({ enabled: true, targetModelId: 'hy3', memberAccountIds: ['g1', 'g2'] })
    expect(state.enabledModelIds).toEqual(['hy3'])
    // …which is what makes this an account-pool fix and not a cosmetic one: the
    // Host's pool switch reads this slot.
    expect(regionEnabled(corrupted, 'global')).toBe(true)
  })

  it('keeps the SURFACE slot for a region that exists there', () => {
    const state = regionStateOf(corrupted, 'cn')
    expect(state.pool).toMatchObject({ memberAccountIds: ['cn1'] })
    // The fake slot built from the sibling `accounts` field must not win.
    expect(state.pool).not.toMatchObject({ memberAccountIds: ['older-cn'] })
  })

  it('never leaks a sibling field back as a region', () => {
    // `accounts` / `cliBridge` are the section's own fields; reading them as
    // regions was how the bug's wreckage stayed alive across restarts.
    expect(regionStateOf(corrupted, 'accounts' as never)).toEqual({})
    expect(regionStateOf(corrupted, 'cliBridge' as never)).toEqual({})
  })

  it('does not recover over a slot the surface emptied on purpose', () => {
    // An emptied slot is stored as `null` (schemastery simplifies `{}` to
    // `null`). Treating it as "missing" and recovering the buried copy would
    // bring back a pool the user had deliberately cleared — the failure mode
    // that makes a heal worse than the disease.
    const cleared = {
      regions: {
        regions: { global: { pool: { enabled: true, memberAccountIds: ['zombie'] } } },
        global: null,
      },
    } as unknown as Config
    expect(regionStateOf(cleared, 'global')).toEqual({})
  })

  it('leaves a healthy field untouched (the heal only fires on the bug signature)', () => {
    const healthy = {
      regions: {
        cn: { enabled: false, enabledModelIds: ['glm-5.3'] },
        global: { enabled: true, pool: { enabled: true, memberAccountIds: ['g1'] } },
      },
    } as unknown as Config
    expect(regionStateOf(healthy, 'cn')).toEqual({ enabled: false, enabledModelIds: ['glm-5.3'] })
    expect(regionStateOf(healthy, 'global')).toEqual({ enabled: true, pool: { enabled: true, memberAccountIds: ['g1'] } })
    // A region that is genuinely absent stays absent: the heal must not invent
    // one, or "I removed the international slot" would come back from the dead.
    expect(regionStateOf({ regions: { cn: { enabled: true } } } as unknown as Config, 'global')).toEqual({})
  })

  it('reports the corrupted FIELD (not the clean map) so the repair knows to write', () => {
    // The other half of the fix: with the directory already in agreement, the
    // boot repair would otherwise never run and the wreckage would outlive the
    // fix that stops producing it.
    expect(regionsFieldIsCorrupt(corrupted.regions)).toBe(true)
    expect(regionsFieldIsCorrupt({ cn: {}, global: {} })).toBe(false)
    expect(regionsFieldIsCorrupt({ cn: {} })).toBe(false)
    // Asked of the whole SECTION it must not answer "corrupt" — that shape is
    // normal. This is why the caller passes `Config['regions']`.
    expect(regionsFieldIsCorrupt({ regions: { cn: {} }, accounts: {} })).toBe(true)
  })
})

describe('regionStateOf: a null slot is "no slot", not a value', () => {
  // schemastery's `simplify()` serialises an EMPTY region slot as `null`
  // (`{cn:{}}` → `{cn:null}`). A stored `null` is expanded back into a full
  // default state before the plugin ever reads it, so this is not reachable in
  // production today — but if it were, `regionStateOf` used to return `null`
  // (its guard only rejected `undefined`) and every caller threw on the first
  // property read. `regionEnabled` is the caller that demonstrates it.
  const nullSlot = { regions: { cn: null, global: null } } as unknown as Config

  it('returns an object rather than null', () => {
    expect(regionStateOf(nullSlot, 'cn')).not.toBeNull()
    expect(typeof regionStateOf(nullSlot, 'cn')).toBe('object')
  })

  it('falls through to the flat legacy fields for cn, like an absent slot', () => {
    // The `null` slot must behave exactly as a MISSING one: cn then falls back
    // to the pre-region-split flat fields, and never inherits them for global.
    const legacy = {
      regions: { cn: null },
      lastCatalog: [{ id: 'hy3', name: 'Hy3', contextWindow: 200_000, maxTokens: 32_000 }],
      enabledModelIds: ['hy3'],
    } as unknown as Config
    expect(regionStateOf(legacy, 'cn').enabledModelIds).toEqual(['hy3'])
    expect(regionStateOf(legacy, 'global')).toEqual({})
  })

  it('does not make regionEnabled throw', () => {
    expect(() => regionEnabled(nullSlot, 'cn')).not.toThrow()
    expect(regionEnabled(nullSlot, 'cn')).toBe(true)
  })
})

/**
 * The CN gateway override's slot helpers (issue #220).
 *
 * These pin the two invariants every other region helper in this file already
 * pins, because `cnBase` shares a slot with the model directory, the pool
 * preferences and four switches: writing a host must not disturb any of them,
 * and reading a malformed value must not throw.
 */
describe('cnBase in the region slot (issue #220)', () => {
  it('writes only cnBase, carrying the rest of the slot through', () => {
    const before = {
      regions: {
        cn: { enabled: true, enabledModelIds: ['m-1'], cnBase: 'https://old.example' },
        global: { enabled: false },
      },
    }
    // The RETURN value is the `regions` MAP, not the settings section — i.e.
    // exactly what `scope.set('regions', …)` takes (see `nextRegionSlots`).
    const next = nextRegionCnBase(before, 'cn', 'https://wb.tencentbuddy.com')
    const cn = next['cn'] as Record<string, unknown>
    expect(cn['cnBase']).toBe('https://wb.tencentbuddy.com')
    // Everything else in the slot survives the write.
    expect(cn['enabled']).toBe(true)
    expect(cn['enabledModelIds']).toEqual(['m-1'])
    // ...and the sibling region is untouched.
    expect(next['global']).toEqual({ enabled: false })
  })

  it('keeps an empty value as an explicit key, not a deletion', () => {
    // `''` means "back to the built-in gateway" and has to survive a read-back —
    // the same rule as `accountId`'s Clear sentinel in `nextAccountsSelection`.
    const next = nextRegionCnBase({ regions: { cn: { cnBase: 'https://wb.tencentbuddy.com' } } }, 'cn', '')
    const cn = next['cn'] as Record<string, unknown>
    expect('cnBase' in cn).toBe(true)
    expect(cn['cnBase']).toBe('')
  })

  it('reads an absent value as empty, and a malformed one as empty rather than throwing', () => {
    expect(regionCnBaseOf({}, 'cn')).toBe('')
    expect(regionCnBaseOf({ regions: {} }, 'cn')).toBe('')
    // The settings mirror can hold whatever a previous version wrote; taking the
    // whole capabilities panel down over one bad field would be a worse failure
    // than treating it as "not configured".
    expect(regionCnBaseOf({ regions: { cn: { cnBase: 42 } } }, 'cn')).toBe('')
    expect(regionCnBaseOf({ regions: { cn: { cnBase: null } } }, 'cn')).toBe('')
    expect(regionCnBaseOf({ regions: { cn: { cnBase: 'https://wb.tencentbuddy.com' } } }, 'cn'))
      .toBe('https://wb.tencentbuddy.com')
  })

  it('reads the whole settings section as well as the bare regions map', () => {
    const whole = { regions: { cn: { cnBase: 'https://wb.tencentbuddy.com' } }, authFile: '/x' }
    expect(regionCnBaseOf(whole, 'cn')).toBe('https://wb.tencentbuddy.com')
    expect(regionCnBaseOf({ cn: { cnBase: 'https://wb.tencentbuddy.com' } }, 'cn')).toBe('https://wb.tencentbuddy.com')
  })

  it('defaults the Host-side read to empty for a config that never set it', () => {
    // The overwhelmingly common case: every existing profile reaches this path
    // with no field at all, and it must resolve to the built-in gateway.
    expect(regionStateOf({} as Config, 'cn').cnBase).toBeUndefined()
  })
})
