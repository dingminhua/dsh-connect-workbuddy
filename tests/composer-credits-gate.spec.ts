/**
 * The composer credit readout's DECISION: which session shows it.
 *
 * The risk here is not rendering a number — it is rendering the WRONG plugin's
 * number, or rendering one into a shared row that belongs to another provider.
 * The composer row (`conversation.input.left`) is shared with the shell's own
 * controls and with every other bundle, so every assertion below pins WHICH
 * provider/region leads to WHICH decision, not merely that something appeared.
 */
import { describe, expect, it } from 'vitest'
import {
  composerCreditsRegionOf,
  selectedProviderOf,
} from '../src/client/ComposerCreditsGate.tsx'
import { WORKBUDDY_COMPOSER_PROVIDERS } from '../src/client/ComposerCredits.tsx'

/** A settings scope stub whose snapshot is the given section. */
function scopeOf(value: unknown, writable = true): any {
  return {
    getSnapshot: () => ({ status: 'ready', value, writable }),
    subscribe: () => () => {},
    set: async () => true,
  }
}

describe('selectedProviderOf', () => {
  it('prefers `next` over `lastUsed`', () => {
    // A switch that has landed but not yet been sent is still what the composer
    // displays — the same precedence the shell itself uses.
    expect(selectedProviderOf({
      next: { provider: 'workbuddy' },
      lastUsed: { provider: 'workbuddy-global' },
    })).toBe('workbuddy')
  })

  it('falls back to `lastUsed` when nothing is queued', () => {
    expect(selectedProviderOf({ lastUsed: { provider: 'workbuddy' } })).toBe('workbuddy')
  })

  it('treats an absent, empty or malformed provider as no selection', () => {
    expect(selectedProviderOf(undefined)).toBeUndefined()
    expect(selectedProviderOf({})).toBeUndefined()
    expect(selectedProviderOf({ next: null, lastUsed: null })).toBeUndefined()
    expect(selectedProviderOf({ next: { provider: '' } })).toBeUndefined()
    expect(selectedProviderOf({ next: { provider: 42 } })).toBeUndefined()
  })
})

describe('composerCreditsRegionOf', () => {
  const on = scopeOf({ regions: {} })

  it('maps each of this plugin\'s providers to its region', () => {
    // BOTH regions, unlike the referring project: WorkBuddy's international
    // accounts carry a real balance, so there is a number to show either way.
    expect(composerCreditsRegionOf({ next: { provider: 'workbuddy' } }, on)).toBe('cn')
    expect(composerCreditsRegionOf({ next: { provider: 'workbuddy-global' } }, on)).toBe('global')
  })

  it('renders NOTHING for another provider', () => {
    // The whole reason the readout can share a composer row with other bundles:
    // a foreign provider must produce no readout, no markup and no fetch.
    expect(composerCreditsRegionOf({ next: { provider: 'trae' } }, on)).toBeUndefined()
    expect(composerCreditsRegionOf({ next: { provider: 'anthropic' } }, on)).toBeUndefined()
    expect(composerCreditsRegionOf(undefined, on)).toBeUndefined()
  })

  it('honors the per-region readout switch', () => {
    const scope = scopeOf({ regions: { cn: { showCreditsInMainUi: false } } })
    expect(composerCreditsRegionOf({ next: { provider: 'workbuddy' } }, scope)).toBeUndefined()
    // The sibling region is unaffected.
    expect(composerCreditsRegionOf({ next: { provider: 'workbuddy-global' } }, scope)).toBe('global')
  })

  it('renders nothing for a region whose provider is switched off', () => {
    // A withdrawn provider has no readable credits, so the readout must not
    // appear at all rather than sit there failing.
    const scope = scopeOf({ regions: { cn: { enabled: false } } })
    expect(composerCreditsRegionOf({ next: { provider: 'workbuddy' } }, scope)).toBeUndefined()
    expect(composerCreditsRegionOf({ next: { provider: 'workbuddy-global' } }, scope)).toBe('global')
  })

  it('reads through a volatile-wrapped section', () => {
    // The live settings section wraps each field as `{ get() }`; the gate must
    // unwrap before deciding, or a region reads as "shown" when it is hidden.
    const scope = scopeOf({ get: () => ({ regions: { global: { showCreditsInMainUi: false } } }) })
    expect(composerCreditsRegionOf({ next: { provider: 'workbuddy-global' } }, scope)).toBeUndefined()
    expect(composerCreditsRegionOf({ next: { provider: 'workbuddy' } }, scope)).toBe('cn')
  })

  it('treats an absent scope as both regions shown', () => {
    // No settings surface (read-only host): opt-out semantics apply, so the
    // readout still works rather than vanishing on a host that cannot say.
    expect(composerCreditsRegionOf({ next: { provider: 'workbuddy' } }, undefined)).toBe('cn')
  })
})

describe('provider route table', () => {
  it('covers exactly this plugin\'s two routes', () => {
    // A missing entry would silently drop a region's readout; an extra one
    // would let a foreign provider render this plugin's balance.
    expect(WORKBUDDY_COMPOSER_PROVIDERS).toEqual({
      'workbuddy': 'cn',
      'workbuddy-global': 'global',
    })
  })
})
