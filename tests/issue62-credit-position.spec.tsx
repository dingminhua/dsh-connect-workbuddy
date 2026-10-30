// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, stubFetch, t } from './pool-render-helpers.tsx'
import {
  nextRegionCreditPosition,
  regionCreditPositionOf,
  regionCreditsShownOf,
} from '../src/status-paths.ts'
import { ComposerCreditsGate } from '../src/client/ComposerCreditsGate.tsx'

afterEach(() => { vi.unstubAllGlobals() })

/**
 * Issue #62: the credit readout sat in ONE fixed seat — the composer tool row
 * (`conversation.input.right`) — and a user reported that installing another
 * plugin made it disappear. That row is a LIST seat shared with the shell's own
 * controls and with every other bundle, and a list seat cannot promise that
 * every occupant is visible: whoever else registers there can crowd it out.
 *
 * The fix is to make the SEAT a per-region choice: `composer` (default,
 * unchanged for anyone who does not choose) or `stats` — the ambient dock below
 * the composer card where the shell renders its own round/step/token pills.
 *
 * Both properties are pinned here, and neither is cosmetic:
 *   1. the reader/writer round-trip — the seat survives a settings write, and a
 *      profile written before the setting existed reads as `composer`;
 *   2. the GATE renders in the chosen seat and nowhere else, so the readout
 *      cannot appear twice (or vanish) while the setting says otherwise.
 */

/** A settings scope stub whose snapshot is the given section. */
function scopeOf(value: unknown): any {
  return {
    getSnapshot: () => ({ status: 'ready', value, writable: true }),
    subscribe: () => () => {},
    set: async () => true,
  }
}

/**
 * Render the gate as the slot does, and report WHAT was drawn.
 *
 * A real mount rather than calling the component: the gate reads a settings
 * scope and subscribes to it, so the decision only exists inside React's
 * lifecycle. `drawn` counts the readout's own trigger — the one node the gate
 * produces — which is what makes "renders in exactly one seat" observable.
 */
async function drawGate(input: {
  position?: 'composer' | 'stats'
  scope?: unknown
  provider?: string
}): Promise<{ container: HTMLElement, drawn: number }> {
  // The readout fetches its balance on mount; an empty answer keeps this about
  // the SEAT decision rather than about credits.
  stubFetch(() => ({ body: { status: 'signed-out', accounts: [] } }))
  const useProjection = (): unknown => ({ next: { provider: input.provider ?? 'workbuddy' } })
  const m = await mount(ComposerCreditsGate, {
    t,
    ...input.position === undefined ? {} : { position: input.position },
    ...input.scope === undefined ? {} : { settingsScope: input.scope },
    useProjection,
  })
  const drawn = m.container.querySelectorAll('.dsm-workbuddy-composer-credits').length
  await m.unmount()
  return { container: m.container, drawn }
}

describe('the credit readout seat', () => {
  it('defaults to the composer row, including for a profile written before the setting', () => {
    // The whole point of the default: an upgrade moves nothing on screen.
    expect(regionCreditPositionOf({ regions: { cn: {} } }, 'cn')).toBe('composer')
    expect(regionCreditPositionOf({ regions: { cn: { showCreditsInMainUi: false } } }, 'cn')).toBe('composer')
    // An unknown value from a hand-edited config reads as the default too,
    // rather than rendering nowhere.
    expect(regionCreditPositionOf({ regions: { cn: { creditPosition: 'sidebar' } } }, 'cn')).toBe('composer')
  })

  it('reads the seat per REGION, not globally', () => {
    const value = { regions: { cn: { creditPosition: 'stats' }, global: {} } }
    expect(regionCreditPositionOf(value, 'cn')).toBe('stats')
    expect(regionCreditPositionOf(value, 'global')).toBe('composer')
  })

  it('writes one region\'s seat without disturbing its other fields', () => {
    // Same merge rule as every other region write: only the target field
    // changes, so a seat change cannot drop the model list, budgets, or the
    // sibling region.
    const value = {
      regions: {
        cn: { showCreditsInMainUi: false, enabledModelIds: ['m1'], creditPosition: 'composer' },
        global: { creditPosition: 'stats' },
      },
    }
    // `nextRegionSlots` returns the REGIONS MAP (not the whole section), which
    // is what the card's caller expects: it indexes it by region and writes that
    // slot back.
    const next = nextRegionCreditPosition(value, 'cn', 'stats') as any
    expect(next.cn.creditPosition).toBe('stats')
    expect(next.cn.enabledModelIds).toEqual(['m1'])
    expect(next.cn.showCreditsInMainUi).toBe(false)
    expect(next.global.creditPosition).toBe('stats')
    // …and the reader agrees with what was written, given the section shape it
    // actually reads.
    expect(regionCreditPositionOf({ regions: next }, 'cn')).toBe('stats')
  })

  it('keeps the seat independent of the show/hide switch', () => {
    // The two answer different questions, and a hidden readout must not lose
    // where it was going to sit: turning it back on should return it to the
    // chosen seat rather than resetting to the default.
    const hidden = nextRegionCreditPosition(
      { cn: { showCreditsInMainUi: false } },
      'cn',
      'stats',
    ) as any
    expect(regionCreditsShownOf({ regions: hidden }, 'cn')).toBe(false)
    expect(regionCreditPositionOf({ regions: hidden }, 'cn')).toBe('stats')
  })
})

describe('the gate renders in the seat the setting names', () => {
  it('renders in the composer seat when the setting says composer', async () => {
    const { drawn } = await drawGate({ position: 'composer', scope: scopeOf({ regions: { cn: {} } }) })
    expect(drawn).toBe(1)
  })

  it('renders NOTHING in the seat the setting does not name', async () => {
    // The defect this prevents: the readout appearing twice (once per seat)
    // while the setting names only one.
    const scope = scopeOf({ regions: { cn: { creditPosition: 'stats' } } })
    expect((await drawGate({ position: 'composer', scope })).drawn).toBe(0)
    expect((await drawGate({ position: 'stats', scope })).drawn).toBe(1)
  })

  it('treats an absent seat as `composer`, so an existing caller is unchanged', async () => {
    // Every registration before this setting existed passed no `position`; they
    // must keep rendering exactly as they did.
    expect((await drawGate({ scope: scopeOf({ regions: { cn: {} } }) })).drawn).toBe(1)
    expect((await drawGate({ scope: scopeOf({ regions: { cn: { creditPosition: 'stats' } } }) })).drawn).toBe(0)
  })

  it('renders in NEITHER seat for a region whose readout is hidden or off', async () => {
    // Ownership and the switches are decided BEFORE the seat test, so a region
    // that is switched off renders nothing anywhere rather than drawing in the
    // inactive seat first.
    const hidden = scopeOf({ regions: { cn: { showCreditsInMainUi: false, creditPosition: 'stats' } } })
    expect((await drawGate({ position: 'stats', scope: hidden })).drawn).toBe(0)
    expect((await drawGate({ position: 'composer', scope: hidden })).drawn).toBe(0)
    const off = scopeOf({ regions: { cn: { enabled: false } } })
    expect((await drawGate({ position: 'composer', scope: off })).drawn).toBe(0)
    expect((await drawGate({ position: 'stats', scope: off })).drawn).toBe(0)
  })

  it('renders in neither seat for another provider', async () => {
    const scope = scopeOf({ regions: { cn: {}, global: {} } })
    expect((await drawGate({ position: 'composer', scope, provider: 'trae' })).drawn).toBe(0)
    expect((await drawGate({ position: 'stats', scope, provider: 'trae' })).drawn).toBe(0)
  })
})
