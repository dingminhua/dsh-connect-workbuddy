// @vitest-environment jsdom
/**
 * The sidebar-credit switch INSIDE THE CARD: one control, owned by the active
 * tab's region.
 *
 * The sidebar-line tests (`sidebar-credits-render.spec.tsx`) and the storage
 * tests (`sidebar-credits-switch.spec.ts`) both pass with the two boxes rendered
 * side by side under the tab bar — which is exactly what shipped and what the
 * user rejected: two boxes in one row read as ONE shared setting rather than as
 * "this tab's setting".
 *
 * So the assertions here are about WHICH control exists for WHICH tab, not
 * merely that a checkbox is present:
 *   - the CN tab shows the CN box and NOT the international one;
 *   - the international tab shows the international box and NOT the CN one;
 *   - exactly one box exists at a time (never a pair);
 *   - the box that exists is bound to the ACTIVE region's stored flag.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { mount, fakeScope, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

/** A signed-in usage body for one region. */
function usageOf(region: string): Record<string, unknown> {
  return {
    status: 'signed-in',
    region,
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: `${region}-1`, accountName: `${region} One` }],
    models: [{ id: 'glm-5.3', name: 'GLM-5.3' }],
    enabledModelIds: ['glm-5.3'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 10, expiringSoon: 0, packages: [] },
  }
}

/** The credit-switch controls currently rendered, as {label, checked}. */
function creditSwitches(container: HTMLElement): { label: string, checked: boolean }[] {
  return Array.from(container.querySelectorAll<HTMLLabelElement>('.dsm-workbuddy-credits-switch'))
    .map(label => ({
      label: label.querySelector('span')?.textContent ?? '',
      checked: label.querySelector('input')?.checked ?? false,
    }))
}

const render = async (body: Record<string, unknown>, scopeValue: Record<string, unknown>) => {
  const calls = stubFetch((url) => ({
    // The settings write posts to the host's save endpoint; answer it the way
    // the host does (`{ value }`) so the write path completes.
    body: url.includes('__save') ? { value: {} } : body,
  }))
  const scope = fakeScope(scopeValue)
  const m = await mount(WorkBuddyCard, { t, settingsScope: scope, view: 'page' })
  await m.settle()
  return { m, scope, calls }
}

describe('card sidebar-credit switch when the region is switched OFF', () => {
  /** The switch's input, with its checked/disabled state. */
  const switchOf = (container: HTMLElement): HTMLInputElement | null =>
    container.querySelector<HTMLInputElement>('.dsm-workbuddy-credits-switch input')

  it('renders the switch unchecked for a region whose provider is off', async () => {
    // A disabled provider has no credits to show, so reporting the stored flag
    // (which defaults to true) would claim the line is on while nothing can be
    // fetched for it. The control must read OFF.
    const { m } = await render(usageOf('cn'), {
      regions: { cn: { enabled: false, showCreditsInMainUi: true } },
    })
    const box = switchOf(m.container)
    expect(box).not.toBeNull()
    expect(box?.checked).toBe(false)
  })

  it('disables the switch while the region is off, so it cannot be turned on', async () => {
    const { m } = await render(usageOf('cn'), { regions: { cn: { enabled: false } } })
    expect(switchOf(m.container)?.disabled).toBe(true)
  })

  it('leaves the switch usable for a region that is ON', async () => {
    // The control case: the gating must not disable the box for a live region.
    const { m } = await render(usageOf('cn'), { regions: { cn: { enabled: true } } })
    const box = switchOf(m.container)
    expect(box?.disabled).toBe(false)
    // And it still reports the stored value rather than a forced false.
    expect(box?.checked).toBe(true)
  })

  it('writes nothing when the disabled switch is clicked', async () => {
    // A disabled input fires no change event; this pins that the region's stored
    // flag is not silently rewritten for a provider the user switched off.
    const { m, calls } = await render(usageOf('cn'), {
      regions: { cn: { enabled: false, showCreditsInMainUi: true } },
    })
    await m.click(switchOf(m.container) as Element)
    expect(calls.filter(call => call.url.includes('__save'))).toHaveLength(0)
  })
})

describe('card sidebar-credit switch follows the active tab', () => {
  it('shows only the CN switch while the CN tab is active', async () => {
    // The card opens on the CN tab, so only the CN control may exist. A second
    // box here is the reported defect.
    const { m } = await render(usageOf('cn'), { regions: { cn: {} } })
    const boxes = creditSwitches(m.container)
    expect(boxes).toHaveLength(1)
    expect(boxes[0]?.label).toBe('row.showCreditsCn')
  })

  it('never renders the two switches as a pair', async () => {
    // Pins the shape that was rejected: both regions' boxes side by side.
    const { m } = await render(usageOf('cn'), { regions: { cn: {}, global: {} } })
    const labels = creditSwitches(m.container).map(box => box.label)
    expect(labels).not.toContain('row.showCreditsGlobal')
  })

  it('binds the CN switch to the CN region flag, not the international one', async () => {
    // Stored: CN off, international on. The CN tab must show UNCHECKED — the
    // bug this guards is reading one region's flag while rendering the other's
    // box, which a "a checkbox exists and is checked" assertion would miss.
    const { m } = await render(usageOf('cn'), {
      regions: { cn: { showCreditsInMainUi: false }, global: { showCreditsInMainUi: true } },
    })
    const boxes = creditSwitches(m.container)
    expect(boxes).toHaveLength(1)
    expect(boxes[0]?.label).toBe('row.showCreditsCn')
    expect(boxes[0]?.checked).toBe(false)
  })

  it('checks the CN switch when the CN flag is on', async () => {
    const { m } = await render(usageOf('cn'), { regions: { cn: { showCreditsInMainUi: true } } })
    expect(creditSwitches(m.container)[0]?.checked).toBe(true)
  })

  it('swaps to the international switch after activating the international tab', async () => {
    // The whole point of scoping the control to the tab: selecting 国际版 must
    // replace the CN box with the international one, bound to the
    // international region's own flag. Without this, "each tab manages its own"
    // is not actually true.
    const calls = stubFetch((url) => ({
      body: url.includes('__save')
        ? { value: {} }
        : usageOf(url.includes('region=global') ? 'global' : 'cn'),
    }))
    const m = await mount(WorkBuddyCard, {
      t,
      settingsScope: fakeScope({
        regions: { cn: { showCreditsInMainUi: true }, global: { showCreditsInMainUi: false } },
      }),
      view: 'page',
    })
    await m.settle()
    expect(creditSwitches(m.container)[0]?.label).toBe('row.showCreditsCn')

    // The tab button carries the region label; its accessible text is the one
    // rendered by `row.tabGlobal`.
    const tab = Array.from(m.container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('row.tabGlobal'))
    expect(tab, 'international tab button').toBeDefined()
    await m.click(tab as Element)

    const boxes = creditSwitches(m.container)
    expect(boxes).toHaveLength(1)
    expect(boxes[0]?.label).toBe('row.showCreditsGlobal')
    // And it reflects the INTERNATIONAL flag (off), not the CN one (on): a
    // control that merely changed its label would pass without this.
    expect(boxes[0]?.checked).toBe(false)
    expect(calls.some(call => call.url.includes('region=global'))).toBe(true)
  })

  it('unchecks after a successful write even while the settings MIRROR stays stale', async () => {
    // The "关闭不了" regression. On the affected 0.1.7 deployments the browser's
    // settings mirror never picks up this plugin's writes, so a control that
    // read the mirror re-rendered its previous value after a successful save and
    // the switch looked dead. The checkbox must read the value off the HOST's
    // usage answer instead, which is the authority.
    let hostValue = true
    const bodies: any[] = []
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      const json = (payload: unknown) => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => payload,
        text: async () => JSON.stringify(payload),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)))
            controller.close()
          },
        }),
      }) as unknown as Response
      const target = String(url)
      if (target.includes('__save')) {
        bodies.push(JSON.parse(String(init?.body)))
        hostValue = false
        return json({ ok: true, value: { cn: { showCreditsInMainUi: false } } })
      }
      return json({
        ...usageOf('cn'),
        // The HOST reports the committed value.
        showCreditsInMainUi: hostValue,
      })
    })
    // A scope whose mirror NEVER updates — exactly the reported failure mode.
    const staleScope: any = {
      getSnapshot: () => ({ status: 'ready', writable: true, value: { regions: { cn: { showCreditsInMainUi: true } } } }),
      subscribe: () => () => {},
      set: async () => true,
    }
    const m = await mount(WorkBuddyCard, { t, settingsScope: staleScope, view: 'page' })
    await m.settle()
    expect(m.container.querySelector<HTMLInputElement>('.dsm-workbuddy-credits-switch input')?.checked).toBe(true)

    await m.click(m.container.querySelector('.dsm-workbuddy-credits-switch input') as Element)
    await m.settle()

    // The write reached the host...
    expect(bodies).toHaveLength(1)
    expect((bodies[0].value as any).cn.showCreditsInMainUi).toBe(false)
    // ...and the control now reflects it, despite the stale mirror.
    expect(m.container.querySelector<HTMLInputElement>('.dsm-workbuddy-credits-switch input')?.checked).toBe(false)
  })

  it('writes the ACTIVE region slot when toggled', async () => {
    // The write must name the tab's region, or a CN toggle would silently edit
    // the international side. The save goes to the host endpoint (which merges
    // per region), so the contract to pin is the POSTED body.
    const { m, calls } = await render(usageOf('cn'), { regions: { cn: { showCreditsInMainUi: true } } })
    const box = m.container.querySelector<HTMLInputElement>('.dsm-workbuddy-credits-switch input')
    expect(box).not.toBeNull()
    await m.click(box as Element)
    const save = calls.find(call => call.url.includes('__save'))
    expect(save).toBeDefined()
    const posted = JSON.parse(String(save?.init?.body)) as {
      field: string
      value: Record<string, { showCreditsInMainUi?: boolean }>
    }
    expect(posted.field).toBe('regions')
    // Only the CN slot is addressed, and it carries the new value.
    expect(Object.keys(posted.value)).toEqual(['cn'])
    expect(posted.value.cn?.showCreditsInMainUi).toBe(false)
  })
})
