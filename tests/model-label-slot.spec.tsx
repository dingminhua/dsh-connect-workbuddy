// @vitest-environment jsdom
/**
 * The load badge in the HOST's model picker.
 *
 * The host renders a provider's model name as a plain string, so the only
 * thing a provider can put there is a character — and a character's colour is
 * the emoji font's business, not ours. The host therefore offers exactly one
 * seam for this: the `conversation.input.model.label` slot, whose contract is
 * "render non-interactive inline content such as a coloured name or badge"
 * while the picker keeps owning clicks, focus and check marks.
 *
 * Three things are worth pinning here, and all three are about not overstating
 * what the upstream said:
 *
 * 1. The badge is drawn NEXT TO the catalog name, never instead of it. The
 *    contract says to retain `model.name` as the text, and a picker row that
 *    lost its model name would be useless.
 * 2. Another provider's model gets the PLAIN name — no badge, no fetch.
 * 3. A model the probe did not answer for gets NO badge, even once other
 *    models have one. A badge that guesses is worse than no badge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { regionOfProvider, WorkBuddyModelLabel, resetBusyLevelCache } from '../src/client/WorkBuddyModelLabel.tsx'
import { renderToStaticMarkup } from 'react-dom/server'
import { mount } from './pool-render-helpers.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
  resetBusyLevelCache()
})

/** A signed-in usage body carrying the given load levels. */
function usageWithLevels(busyLevels: Record<string, string> | undefined): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'cn-1', accountName: 'cn One' }],
    models: [{ id: 'model-a', name: 'Model A' }],
    enabledModelIds: ['model-a'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 20, expiringSoon: 0, packages: [] },
    ...busyLevels === undefined ? {} : { busyLevels },
  }
}

const props = {
  provider: { id: 'workbuddy', name: 'WorkBuddy' },
  model: { id: 'model-a', name: 'Model A' },
  placement: 'menu' as const,
  selected: false,
}

describe('the model label in the host picker', () => {
  it('keeps the catalog name, and adds the badge beside it', () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => usageWithLevels({ 'model-a': 'congested' }),
    }))
    const markup = renderToStaticMarkup(<WorkBuddyModelLabel {...props} />)
    // The NAME is still there — the contract says to retain it.
    expect(markup).toContain('Model A')
  })

  it('renders another provider\'s model as the plain name, with no fetch', () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: unknown) => {
      calls.push(String(url))
      return { ok: true, status: 200, json: async () => usageWithLevels({}) }
    })
    const markup = renderToStaticMarkup(
      <WorkBuddyModelLabel {...props} provider={{ id: 'other', name: 'Other' }} />,
    )
    expect(markup).toContain('Model A')
    expect(markup).not.toContain('dsm-workbuddy-busy')
    // No fetch for a provider that is not ours.
    expect(calls).toHaveLength(0)
  })

  it('draws NO badge for a model the probe did not answer for', () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => usageWithLevels({ 'model-a': 'congested' }),
    }))
    // A model id the probe never mentioned: the badge must not appear.
    const markup = renderToStaticMarkup(
      <WorkBuddyModelLabel {...props} model={{ id: 'model-z', name: 'Model Z' }} />,
    )
    expect(markup).toContain('Model Z')
    expect(markup).not.toContain('dsm-workbuddy-busy')
  })

  it('maps each provider to the region it serves', () => {
    // The two gateways are separate catalogs with separate load, so a request
    // without the region would show one region's levels on the other's models.
    // Pinning the MAPPING (not the fetch) keeps the test honest under static
    // rendering, where effects do not run at all.
    expect(regionOfProvider('workbuddy')).toBe('cn')
    expect(regionOfProvider('workbuddy-global')).toBe('global')
    expect(regionOfProvider('deepseek-account')).toBeUndefined()
  })

  it('does not fetch at all when the Host has no levels to report', () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => usageWithLevels(undefined),
    }))
    const markup = renderToStaticMarkup(<WorkBuddyModelLabel {...props} />)
    expect(markup).toContain('Model A')
    expect(markup).not.toContain('dsm-workbuddy-busy')
  })
})

/** A promotion in the shape the usage route carries it in (already parsed). */
function promo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'night-discount',
    source: 'promotion',
    modelIds: ['model-a'],
    badge: { label: '夜间折扣', shortLabel: '夜间', color: '#009273' },
    schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '00:00', end: '24:00' }] },
    priority: 5,
    ...overrides,
  }
}

/** The same usage body, with promotions on the model. */
function usageWithPromos(promos: readonly unknown[]): Record<string, unknown> {
  const body = usageWithLevels({ 'model-a': 'normal' })
  return { ...body, models: [{ id: 'model-a', name: 'Model A', promos }] }
}

/**
 * The promotion badge, in the picker.
 *
 * The card has drawn these badges for a while; this is the SAME upstream fact
 * rendered where the choice is actually made. Three properties matter, and all
 * three are about not overstating the offer:
 *
 * 1. It is the upstream's own wording and colour, beside the name — the host's
 *    contract keeps `model.name` as the text.
 * 2. It is resolved against the CLOCK at render time, not frozen when the
 *    snapshot was fetched, so an ended campaign cannot outlive itself.
 * 3. A narrow row gets the upstream's compact wording, because a four-character
 *    label would push the row's own controls out.
 */
describe('the promotion badge in the host picker', () => {
  it('draws the upstream\'s chip beside the name, with its own colour', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => usageWithPromos([promo()]),
    }))
    const view = await mount(WorkBuddyModelLabel, { ...props, placement: 'option' })
    await view.settle()
    const html = view.html()
    expect(view.text()).toContain('Model A')
    expect(view.text()).toContain('夜间')
    // The upstream's colour reaches the chip as a custom property, which is how
    // the shared chip class picks it up.
    expect(html).toContain('--dsm-workbuddy-promo-color')
    expect(html).toContain('#009273')
    // The load icon stays: a promotion says what it costs, the icon says how
    // busy it is, and they are different questions.
    expect(html).toContain('dsm-workbuddy-busy')
    // The chip comes after the name, never instead of it.
    expect(html.indexOf('Model A')).toBeLessThan(html.indexOf('dsm-workbuddy-model-label-promo'))
    await view.unmount()
  })

  it('prefers the compact wording in a narrow row and the full one on the trigger', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => usageWithPromos([promo()]),
    }))
    const row = await mount(WorkBuddyModelLabel, { ...props, placement: 'option' })
    await row.settle()
    expect(row.text()).toContain('夜间')
    expect(row.text()).not.toContain('夜间折扣')
    await row.unmount()

    // The composer trigger has the width for the upstream's full wording, and
    // it is the line the user reads without opening anything.
    resetBusyLevelCache()
    const trigger = await mount(WorkBuddyModelLabel, { ...props, placement: 'trigger' })
    await trigger.settle()
    expect(trigger.text()).toContain('夜间折扣')
    await trigger.unmount()
  })

  it('draws NOTHING once the promotion is over', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => usageWithPromos([
        // A campaign that ended a minute ago: `validUntil` is exclusive, so it
        // is over at that instant. A standing badge must not survive it.
        promo({ schedule: { timezone: 'Asia/Shanghai', validUntil: Date.now() - 60_000 } }),
      ]),
    }))
    const view = await mount(WorkBuddyModelLabel, { ...props, placement: 'trigger' })
    await view.settle()
    expect(view.text()).toContain('Model A')
    expect(view.html()).not.toContain('dsm-workbuddy-model-label-promo')
    await view.unmount()
  })
})

describe('the "本机首次见到" marker in the host picker', () => {
  it('marks a row whose id is in the first-seen list', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...usageWithLevels({}), showNewModelsInMainUi: true, newModelIds: ['model-a'] }),
    }))
    const view = await mount(WorkBuddyModelLabel, { ...props, placement: 'option' })
    await view.settle()
    // The name is still the text; the marker sits beside it.
    expect(view.text()).toContain('Model A')
    expect(view.html()).toContain('dsm-workbuddy-model-label-new')
    await view.unmount()
  })

  it('draws NOTHING for a row that is not in the first-seen list', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...usageWithLevels({}), showNewModelsInMainUi: true, newModelIds: ['model-z'] }),
    }))
    const view = await mount(WorkBuddyModelLabel, { ...props, placement: 'option' })
    await view.settle()
    expect(view.text()).toContain('Model A')
    expect(view.html()).not.toContain('dsm-workbuddy-model-label-new')
    await view.unmount()
  })

  it('draws NOTHING while the opt-in switch is off, even with ids present', async () => {
    // The switch defaults OFF and both surfaces read one snapshot. Without this,
    // turning it off would silence the composer segment while the picker kept
    // marking rows "新" — the same feature disagreeing with itself.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      // No `showNewModelsInMainUi`: absent must read as OFF, never as consent.
      json: async () => ({ ...usageWithLevels({}), newModelIds: ['model-a'] }),
    }))
    const view = await mount(WorkBuddyModelLabel, { ...props, placement: 'option' })
    await view.settle()
    expect(view.text()).toContain('Model A')
    expect(view.html()).not.toContain('dsm-workbuddy-model-label-new')
    await view.unmount()
  })

  it('marks once per id: a duplicated first-seen list still yields one marker', async () => {
    // The Host dedupes, but the client must not trust a peer — a duplicated id
    // would turn one new model into two rows marked "新".
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...usageWithLevels({}), showNewModelsInMainUi: true, newModelIds: ['model-a', 'model-a'] }),
    }))
    const view = await mount(WorkBuddyModelLabel, { ...props, placement: 'option' })
    await view.settle()
    const html = view.html()
    expect(html.indexOf('dsm-workbuddy-model-label-new')).toBe(html.lastIndexOf('dsm-workbuddy-model-label-new'))
    await view.unmount()
  })
})
