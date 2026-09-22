import { describe, expect, it } from 'vitest'
import {
  nextRegionEnabled,
  nextRegionSlots,
  regionEnabledOf,
} from '../src/status-paths.ts'
import { regionEnabled } from '../src/index.ts'
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
