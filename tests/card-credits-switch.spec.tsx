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

/** The credit-switch controls currently rendered, as {label, checked}.
 *
 * The label is read off `.dsm-workbuddy-pref-label`, not off any span: the row's
 * copy block also carries the explanation, and `textContent` on the wrapper
 * would return the title and the explanation glued together — which would make
 * every label assertion below compare against a string that no locale key ever
 * matches. Scanning from the CHECKBOX (rather than from every preference line)
 * keeps the picker row out: that row has a label of its own and no input. */
function creditSwitches(container: HTMLElement): { label: string, checked: boolean }[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('.dsm-workbuddy-pref-check'))
    .map(input => ({
      label: input.closest('.dsm-workbuddy-pref')?.querySelector('.dsm-workbuddy-pref-label')?.textContent ?? '',
      checked: input.checked,
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
    container.querySelector<HTMLInputElement>('.dsm-workbuddy-pref-check')

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
    expect(m.container.querySelector<HTMLInputElement>('.dsm-workbuddy-pref-check')?.checked).toBe(true)

    await m.click(m.container.querySelector('.dsm-workbuddy-pref-check') as Element)
    await m.settle()

    // The write reached the host...
    expect(bodies).toHaveLength(1)
    expect((bodies[0].value as any).cn.showCreditsInMainUi).toBe(false)
    // ...and the control now reflects it, despite the stale mirror.
    expect(m.container.querySelector<HTMLInputElement>('.dsm-workbuddy-pref-check')?.checked).toBe(false)
  })

  it('writes the ACTIVE region slot when toggled', async () => {
    // The write must name the tab's region, or a CN toggle would silently edit
    // the international side. The save goes to the host endpoint (which merges
    // per region), so the contract to pin is the POSTED body.
    const { m, calls } = await render(usageOf('cn'), { regions: { cn: { showCreditsInMainUi: true } } })
    const box = m.container.querySelector<HTMLInputElement>('.dsm-workbuddy-pref-check')
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

describe('the readout renders as preference lines, not as the pool heading\'s extra', () => {
  /** A usage body that ALSO carries Host pool state, so the pool section renders. */
  function usageWithPool(region: string): Record<string, unknown> {
    return {
      ...usageOf(region),
      pool: {
        enabled: true,
        checkinSupported: true,
        targetModelSource: 'free',
        targetModelId: 'free-1',
        memberAccountIds: [],
        effectiveMemberAccountIds: [],
        catalog: [{ id: 'free-1', name: 'Free One', creditMultiplier: 0 }],
        accounts: [],
      },
    }
  }

  const renderPool = async (body: Record<string, unknown>, scopeValue: Record<string, unknown>) => {
    stubFetch((url) => ({ body: url.includes('__save') ? { value: {} } : body }))
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope(scopeValue), view: 'page' })
    await m.settle()
    return m
  }

  it('keeps the switch OUT of the account-pool heading', async () => {
    // The regression this guards. The control used to be handed to AccountPool
    // as `headerExtra` and rendered between 「账号池」 and the serving-account
    // badge, so a control for one feature sat inside another feature's title —
    // and its width shoved the badge off to the far right. Asserted by ANCESTRY:
    // a presence check would pass just as happily with the control back in there.
    const m = await renderPool(usageWithPool('cn'), { regions: { cn: {} } })
    const head = m.container.querySelector('.dsm-workbuddy-pool-head')
    expect(head).not.toBeNull()
    expect(head?.querySelector('.dsm-workbuddy-prefs')).toBeNull()
    expect(head?.querySelector('.dsm-workbuddy-pref')).toBeNull()
  })

  /** Mount the CN fixture with the CN region tab ACTIVE.
   *
   * The section tabs only render for a signed-in region, and the card remembers
   * which region tab was last used — the region-switch cases earlier in this
   * file click the international one. Landing there leaves this fixture with no
   * usage for that region, the card shows its signed-out screen, and the tab bar
   * does not exist. Clicking CN first is what makes these cases independent of
   * file order. */
  const renderCapabilities = async () => {
    const m = await renderPool(usageWithPool('cn'), { regions: { cn: {} } })
    const cnTab = m.container.querySelectorAll('.dsm-workbuddy-tab')[0]
    if (cnTab !== undefined && !cnTab.classList.contains('dsm-workbuddy-tab-active')) {
      await m.click(cnTab)
    }
    return m
  }

  /* By ATTRIBUTE, not by `#id`: the card's ids are the tab panel wires
     (`aria-controls` -> `aria-labelledby`), so an attribute selector states the
     same fact and keeps working whichever side of the pair is renamed. */
  const byId = (root: ParentNode, id: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[id="${id}"]`)

  it('renders the preference lines inside the capability section', async () => {
    const m = await renderCapabilities()
    const panel = byId(m.container, 'dsm-workbuddy-panel-capabilities')
    expect(panel).not.toBeNull()
    // The switches authorize spend and register tools; the account section is
    // about WHICH account serves the tab. Keeping them in different sections is
    // also what leaves room for the sub-options each switch is due (a working
    // directory for the CLI route, a size or price cap for the image tool) —
    // in the flat list under the tab bar those had nowhere to go.
    expect(panel?.querySelector('.dsm-workbuddy-prefs')).not.toBeNull()
    const accounts = byId(m.container, 'dsm-workbuddy-panel-accounts')
    expect(accounts?.querySelector('.dsm-workbuddy-prefs')).toBeNull()
    // Exactly one switch, never a second copy in a fallback site.
    expect(creditSwitches(m.container)).toHaveLength(1)
  })

  it('hangs the switches off a tab of their own, after the models tab', async () => {
    const m = await renderCapabilities()
    const tab = byId(m.container, 'dsm-workbuddy-tab-capabilities')
    const panel = byId(m.container, 'dsm-workbuddy-panel-capabilities')
    if (tab === null || panel === null) throw new Error('capabilities tab or panel missing')
    expect(tab.textContent).toBe('row.panelCapabilities')
    expect(tab.getAttribute('aria-controls')).toBe('dsm-workbuddy-panel-capabilities')
    // Order is the information: an account, then what it may run, then what it
    // is allowed to diagnose. The new tab sits BEFORE diagnostics, the fallback
    // section, so the two actionable ones stay adjacent.
    const models = byId(m.container, 'dsm-workbuddy-tab-models')
    const diag = byId(m.container, 'dsm-workbuddy-tab-diag')
    if (models === null || diag === null) throw new Error('sibling tabs missing')
    expect(models.compareDocumentPosition(tab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(tab.compareDocumentPosition(diag) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Collapsed on the accounts tab (the others stay mounted, so the draft and
    // the switch state survive), and reachable on a click.
    expect(panel.hasAttribute('hidden')).toBe(true)
    await m.click(tab)
    expect(panel.hasAttribute('hidden')).toBe(false)
    expect(tab.getAttribute('aria-selected')).toBe('true')
  })

  it('renders the same lines when the pool section does not render', async () => {
    // The old `headerExtra` slot had a real hole: AccountPool returns null
    // without Host pool state, and the switch went with it — so on an older Host
    // the readout could not be switched on at all. The lines are rendered by the
    // CARD now, so both Hosts get the identical control.
    const { m } = await render(usageOf('cn'), { regions: { cn: {} } })
    expect(m.container.querySelector('.dsm-workbuddy-pool-head')).toBeNull()
    const prefs = m.container.querySelector('.dsm-workbuddy-prefs')
    expect(prefs).not.toBeNull()
    expect(prefs?.querySelector('.dsm-workbuddy-pref-check')).not.toBeNull()
    expect(creditSwitches(m.container)).toHaveLength(1)
  })

  it('gives each line its own explanation, and no heading above them', async () => {
    // Two lines, two explanations: the switch's says what the readout IS, the
    // picker's says what "where" means. Running either into a single wrapped
    // blob is what makes the pair read as a wall of text.
    //
    // No heading: these switches describe THIS tab, so they hang off the tab
    // block the way the reference card's preferences do. A 「积分」 heading one
    // line under the tab hint would name the same thing twice.
    const m = await renderPool(usageWithPool('cn'), { regions: { cn: {} } })
    const hints = Array.from(m.container.querySelectorAll('.dsm-workbuddy-pref-hint'))
      .map(node => node.textContent)
    expect(hints).toContain('row.showCreditsHintInline')
    expect(hints).toContain('row.creditPositionHintInline')
    expect(m.container.querySelector('.dsm-workbuddy-prefs h3')).toBeNull()
  })

  it('indents the picker line so it reads as a child of the switch', async () => {
    // The picker has no checkbox of its own, so it borrows that column as
    // padding: its label must start on the same left edge as the two labels
    // above it. An unindented row reads as a third, unrelated setting.
    const m = await renderPool(usageWithPool('cn'), { regions: { cn: {} } })
    const pickerRow = m.container.querySelector('.dsm-workbuddy-pref-indent')
    expect(pickerRow).not.toBeNull()
    expect(pickerRow?.querySelector('.dsm-workbuddy-credit-position')).not.toBeNull()
    // The control sits BESIDE its label, not at the row's far edge: one
    // sentence, not a label facing a control across the card.
    expect(pickerRow?.querySelector('.dsm-workbuddy-pref-lead .dsm-workbuddy-pref-label')).not.toBeNull()
  })

  it('keeps the region-specific label', async () => {
    // Two identical labels would make the CN and international switches
    // indistinguishable in a card where both exist, so each names its region.
    const cn = await renderPool(usageWithPool('cn'), { regions: { cn: {} } })
    expect(creditSwitches(cn.container)[0]?.label).toBe('row.showCreditsCn')
  })
})

describe('the new-model segment switch (opt-in, default off)', () => {
  /** The new-models switch's input, which must NOT share the credit class. */
  const newModelsSwitchOf = (container: HTMLElement): HTMLInputElement | null =>
    container.querySelector<HTMLInputElement>('.dsm-workbuddy-new-models-check')

  it('renders unchecked when the stored flag is absent', async () => {
    // Default OFF. This is what makes the whole feature opt-in: an install that
    // has never heard of the flag must not be announcing "N new models".
    const { m } = await render(usageOf('cn'), { regions: { cn: { enabled: true } } })
    const box = newModelsSwitchOf(m.container)
    expect(box).not.toBeNull()
    expect(box?.checked).toBe(false)
  })

  it('renders checked once the Host reports it on', async () => {
    // The Host's answer is the authority (the browser mirror is stale for this
    // namespace), so `showNewModelsInMainUi` on the usage document wins.
    const body = { ...usageOf('cn'), showNewModelsInMainUi: true }
    const { m } = await render(body, { regions: { cn: { enabled: true } } })
    expect(newModelsSwitchOf(m.container)?.checked).toBe(true)
  })

  it('is disabled for a region that is switched off', async () => {
    const { m } = await render(usageOf('cn'), { regions: { cn: { enabled: false } } })
    expect(newModelsSwitchOf(m.container)?.disabled).toBe(true)
  })

  it('falls back to the settings mirror when the Host does not answer the flag', async () => {
    // The Host's answer is preferred, but a Host line that predates this field
    // cannot answer at all. The mirror then decides — and it reads the flag
    // OPT-IN, so a stored `true` is what a user who turned it on would see.
    // Without this, an older Host would silently keep the feature off forever.
    const { m } = await render(usageOf('cn'), {
      regions: { cn: { enabled: true, showNewModelsInMainUi: true } },
    })
    expect(newModelsSwitchOf(m.container)?.checked).toBe(true)
  })

  it('reads the mirror OPT-IN: any non-true stored value is off', async () => {
    // The default in the other direction would announce the whole roster on a
    // fresh install. `undefined`, `false` and a junk string must all read OFF.
    for (const stored of [undefined, false, 'yes']) {
      const { m } = await render(usageOf('cn'), {
        regions: { cn: { enabled: true, showNewModelsInMainUi: stored } },
      })
      expect(newModelsSwitchOf(m.container)?.checked).toBe(false)
      await m.unmount()
    }
  })

  it('commits the flag through the host save endpoint when ticked', async () => {
    const { m, calls } = await render(usageOf('cn'), { regions: { cn: { enabled: true } } })
    await m.click(newModelsSwitchOf(m.container) as Element)
    const saves = calls.filter(call => call.url.includes('__save'))
    expect(saves).toHaveLength(1)
    // The whole region slot travels: the landed check reads the flag back, and
    // dropping the sibling fields would erase the region's other settings.
    // The payload rides on `init`, not on the recorded call object.
    const written = String(saves[0]?.init?.body ?? '')
    expect(written).toContain('showNewModelsInMainUi')
  })
})
