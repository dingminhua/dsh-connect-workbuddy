// @vitest-environment jsdom
/**
 * The context-budget tier buttons, rendered.
 *
 * The 500K tier is a convenience point on top of the upstream ladder
 * (300K/600K/960K-or-1M), so the risk is not the arithmetic — it is the GATING.
 * A tier offered to a model whose real window is SMALLER than the tier is a
 * button that cannot mean what it says: picking "500K" for a 192K model would
 * persist a budget above the native window, and `catalog.ts` clamps with
 * `Math.min`, so the radio would silently do nothing while reading as a
 * downgrade the user chose.
 *
 * Every assertion below therefore checks WHICH tiers exist for a given window,
 * not merely that a 500K input is present somewhere on the page.
 *
 * THE SECOND HALF (issue #198): existing is not the same as CLICKABLE. All three
 * radios were always in the DOM; on a narrow card the row clipped the third one
 * out of view, so a phone user could only ever pick 200K / 500K and the plugin
 * appeared to cap the context at 500K. jsdom performs NO layout, so "would this
 * survive a 360px panel" cannot be asserted on the rendered box — it is pinned on
 * the stylesheet instead, which is where the clipping actually lived.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { WORKBUDDY_CARD_CSS } from '../src/client/styles.ts'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

/** A signed-in usage body whose single model carries the given native window. */
function usageWithWindow(nativeContextWindow: number, contextBudgets: Record<string, number> = {}): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'real-1', accountName: 'Real One' }],
    models: [{
      id: 'probe-model',
      name: 'Probe Model',
      contextWindow: nativeContextWindow,
      nativeContextWindow,
      maxTokens: 64_000,
    }],
    enabledModelIds: ['probe-model'],
    imageModelIds: [],
    contextBudgets,
    credits: { total: 20, expiringSoon: 0, packages: [] },
  }
}

/**
 * WAS A FLEX ROW OF THREE RADIOS, IS NOW A SINGLE <select>.
 *
 * The tiers themselves did not change — the same 200K / 500K / native gates,
 * derived from the mode's real window — so every assertion in this file still
 * checks the same contract. What changed is how the tier list is READ: options
 * instead of sibling spans, `selectedIndex` instead of `checked`.
 */
function budgetSelect(container: HTMLElement): HTMLSelectElement | null {
  return container.querySelector<HTMLSelectElement>('select.dsm-workbuddy-context-budget')
}

/** The tier labels OFFERED for the model row, in document order. */
function tierLabels(container: HTMLElement): string[] {
  const select = budgetSelect(container)
  return select === null ? [] : Array.from(select.options, option => option.textContent ?? '')
}

/** The label of the tier the control currently shows as chosen. */
function selectedTier(container: HTMLElement): string | undefined {
  const select = budgetSelect(container)
  return select?.selectedOptions[0]?.textContent ?? undefined
}

const render = async (body: Record<string, unknown>) => {
  stubFetch(() => ({ body }))
  const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
  await m.settle()
  return m
}

describe('context-budget tiers', () => {
  it('offers 200K and the native window to a model just over 200K', async () => {
    // 256K: the window is real but below the half-meg point, so 500K must NOT
    // appear — offering it would name a cap the model cannot reach.
    const m = await render(usageWithWindow(256_000))
    expect(tierLabels(m.container)).toEqual(['200K', '256K'])
  })

  it('offers 500K to a model that really exceeds it', async () => {
    // 1M: the user's actual case (deepseek-v4.1-flash, glm-5.3-flash,
    // space-bunny, hy4-preview all advertise 960K-1M).
    const m = await render(usageWithWindow(1_000_000))
    expect(tierLabels(m.container)).toEqual(['200K', '500K', '1M'])
  })

  it('does not offer 500K to a model at exactly 500 000', async () => {
    // The boundary the gate must exclude: `> 500_000` is strict, so an exact
    // 500K window keeps the native tier as its only "max" — no duplicate label
    // with two different meanings. (No shipped CN model sits at exactly 500K;
    // this pins the operator, not an observed catalog entry.)
    const m = await render(usageWithWindow(500_000))
    expect(tierLabels(m.container)).toEqual(['200K', '500K'])
    // Exactly one 500K: the native tier, which for this window IS 500K. The
    // 500K convenience tier must not also render — two identical radio labels
    // writing different values is unreadable and un-clickable.
    expect(tierLabels(m.container).filter(label => label === '500K')).toHaveLength(1)
  })

  it('shows only the native tier for a model at or below 200K', async () => {
    // hy3 (192K) is the shipped case: the 200K radio was already hidden, and
    // the half-meg tier must stay hidden by the same rule.
    const m = await render(usageWithWindow(192_000))
    expect(tierLabels(m.container)).toEqual(['192K'])
  })

  it('checks the 500K radio when the budget is 500 000', async () => {
    const m = await render(usageWithWindow(1_000_000, { 'probe-model': 500_000 }))
    // The label the user actually reads in the closed control.
    expect(selectedTier(m.container)).toBe('500K')
  })

  it('leaves the 500K radio unchecked when no budget is stored', async () => {
    // No stored budget must not read as "500K selected". What it DOES read as is
    // the native tier — issue #215: the old version of this test asserted the
    // 200K tier here, which was the bug rather than the contract. With no stored
    // budget `applyContextBudgets` keeps the model's own 1M window, so 1M is the
    // tier DSH is actually told and the only tier the card may light up.
    const m = await render(usageWithWindow(1_000_000))
    expect(selectedTier(m.container)).toBe('1M')
  })

  it('keeps 500K selectable on a read-only card but not while saving', async () => {
    // `!canWrite || saving` is the shared gate for every tier radio. This pins
    // that the new tier copies it rather than accidentally shipping a writable
    // control on a locked card.
    const m = await render(usageWithWindow(1_000_000))
    const select = budgetSelect(m.container)
    expect(Array.from(select?.options ?? [])).toHaveLength(3)
    // One control now, so one gate instead of three per-option ones.
    expect(select?.disabled).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 7. Issue #198: every tier is REACHABLE on a narrow card, not merely rendered
  // -------------------------------------------------------------------------

  /**
   * One selector's declaration block from the shipped card stylesheet.
   *
   * Extracted rather than eyeballed because the whole bug was a declaration:
   * `flex:none` on a row that had no `flex-wrap`, inside a list with
   * `overflow:hidden`. A test on the RENDERED box cannot see any of that — jsdom
   * performs no layout, so `offsetWidth` is 0 for everything and a clipped
   * element measures exactly as visible as an unclipped one. That is why this
   * file's DOM assertions stayed green across 5.13.1 → 5.17.0 while the third
   * tier was unreachable on every phone: the defect lived one layer below the
   * thing those assertions look at.
   */
  function ruleOf(selector: string): string {
    return new RegExp(`\\.${selector}\\{([^}]*)\\}`).exec(WORKBUDDY_CARD_CSS)?.[1] ?? ''
  }

  it('lets the model row wrap, so no tier can be clipped out of view', () => {
    // The row that carries the budget group. `flex-wrap:wrap` is the half that
    // makes the group land on a second line instead of running past the clip.
    expect(ruleOf('dsm-workbuddy-model-head')).toContain('flex-wrap:wrap')
    // The section footer beside it (cheer link / save buttons), same failure mode
    // and the one the issue named: a fixed single line on a ~360 px panel.
    expect(ruleOf('dsm-workbuddy-model-actions')).toContain('flex-wrap:wrap')
  })

  it('cannot wrap, because it is one control instead of three labels', () => {
    // WAS: "lets the tier group wrap between its own labels" (#198). That test
    // existed because three labels side by side overflowed a phone row, so the
    // group had to be allowed to wrap mid-group — and then forced onto its own
    // line by a media query so the wrapped remainder did not dangle.
    //
    // A <select> removes the premise: it is ONE box whose width is its own, it
    // cannot break a label across lines, and its closed state is a single line
    // by construction. The old assertions would now fail for a correct reason —
    // they describe a failure mode the control no longer has — so they are
    // replaced by the property that keeps it true: the control does not shrink,
    // and no rule lets it wrap.
    const budget = ruleOf('dsm-workbuddy-context-budget')
    expect(budget).toContain('flex:none')
    expect(budget).not.toContain('flex-wrap:wrap')
    // A fixed floor keeps the three rows' controls aligned down the list.
    expect(budget).toContain('min-inline-size:58px')
  })

  it('renders all three tiers in the DOM for a 1M model', async () => {
    // The guard the issue asked for on top of the CSS ones: DOM presence is not
    // what regressed, and asserting it alone is precisely how this stayed green
    // — but it is the PREMISE of the CSS assertions, so it is pinned here in the
    // same file that reads them. All three, in one row, for one model.
    const m = await render(usageWithWindow(1_000_000))
    expect(Array.from(budgetSelect(m.container)?.options ?? [])).toHaveLength(3)
    expect(tierLabels(m.container)).toEqual(['200K', '500K', '1M'])
    // And it lives on the model's SECOND line, with the other per-model
    // switches. This used to assert "inside .dsm-workbuddy-model-head" — the
    // control has since moved to `.dsm-workbuddy-model-controls` when the row
    // was split into three explicit lines, so the old anchor was pinning WHERE
    // the control was rather than that it is reachable.
    const controls = m.container.querySelector('.dsm-workbuddy-model-controls')
    expect(controls).not.toBeNull()
    expect(controls?.querySelector('select.dsm-workbuddy-context-budget')).not.toBeNull()
  })
})

describe('the tier control is a dropdown, not a row of radios', () => {
  it('renders one select and no tier radios', async () => {
    // THE REQUESTED SHAPE. It was three radios wrapping onto a second line in the
    // 564px Settings column, and a wrapped row of radios reads as three
    // independent switches when it is one choice.
    //
    // Asserted as "one select AND zero radios", because either half alone can be
    // satisfied by a half-finished migration: adding the select without deleting
    // the radios would leave both in the row, and deleting the radios without
    // the select would leave no control at all.
    const m = await render(usageWithWindow(1_000_000))
    expect(Array.from(m.container.querySelectorAll('select.dsm-workbuddy-context-budget'))).toHaveLength(1)
    expect(Array.from(m.container.querySelectorAll('.dsm-workbuddy-context-budget input[type=radio]'))).toHaveLength(0)
    // A <fieldset> is the group construct for radios; a select needs neither it
    // nor its legend, and leaving the fieldset behind would nest a form group
    // around a single form control.
    expect(Array.from(m.container.querySelectorAll('fieldset.dsm-workbuddy-context-budget'))).toHaveLength(0)
  })

  it('offers the tiers in ascending order, native last', async () => {
    // Order is information: 200K < 500K < native. A select that listed them in
    // any other order would be the first thing a user notices.
    const m = await render(usageWithWindow(1_000_000))
    const values = Array.from(budgetSelect(m.container)?.options ?? [], option => Number(option.value))
    expect(values).toEqual([200_000, 500_000, 1_000_000])
  })

  it('carries the chosen tier into the save payload', async () => {
    // The read side is pinned above; this is the write side. Choosing a tier and
    // saving must send that number — a select whose onChange is wired to the
    // wrong handler would look right and save nothing.
    const calls = stubFetch(() => ({ body: usageWithWindow(1_000_000) }))
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()
    const select = budgetSelect(m.container)
    if (select === null) throw new Error('no budget select')
    await m.choose(select, '500000')
    calls.length = 0
    await m.click(m.button(t('row.save')))
    await m.settle()
    const save = calls.find(call => call.url.includes('/__save'))
    if (save === undefined) throw new Error('no save request')
    const sent = JSON.parse(String((save.init as { body?: string }).body ?? '{}')) as {
      value: Record<string, { contextBudgets?: Record<string, number> }>
    }
    expect(sent.value['cn']?.contextBudgets?.['probe-model']).toBe(500_000)
    await m.unmount()
  })
})

describe('one model is expressed as three lines', () => {
  /**
   * The row was TWO lines, and the first did not fit 564px — it wrapped, so the
   * row was already three lines tall, just broken wherever the widths landed.
   * These cases pin the explicit structure, and they are deliberately about the
   * STRUCTURE rather than the pixels: jsdom performs no layout, so "is it three
   * lines" is unmeasurable, while "is there one container per concern" is exact.
   */
  const rowOf = async (): Promise<{ head: Element | null, controls: Element | null, details: Element | null }> => {
    const m = await render(usageWithWindow(1_000_000))
    const model = m.container.querySelector('.dsm-workbuddy-model')
    return {
      head: model?.querySelector('.dsm-workbuddy-model-head') ?? null,
      controls: model?.querySelector('.dsm-workbuddy-model-controls') ?? null,
      details: model?.querySelector('.dsm-workbuddy-model-details') ?? null,
    }
  }

  it('gives each concern its own line', async () => {
    const { head, controls, details } = await rowOf()
    expect(head, 'line 1 (name)').not.toBeNull()
    expect(controls, 'line 2 (switches)').not.toBeNull()
    expect(details, 'line 3 (facts + actions)').not.toBeNull()
  })

  it('puts the name line alone on line 1', async () => {
    // Line 1 answers "what is this model": the checkbox, the name, its price,
    // the promo chip and the load icon. A switch or a select here would put a
    // setting back on the line the row was split to lighten.
    const { head } = await rowOf()
    expect(head?.querySelector('.dsm-workbuddy-model-name')).not.toBeNull()
    expect(head?.querySelector('input[type=checkbox]')).not.toBeNull()
    expect(head?.querySelector('select.dsm-workbuddy-context-budget')).toBeNull()
    expect(head?.querySelector('.dsm-workbuddy-model-probe')).toBeNull()
  })

  it('puts the per-model switches on line 2 and the buttons on line 3', async () => {
    // The split that actually needed fixing: the two BUTTONS are actions on the
    // model, not settings OF it, so they belong with its facts.
    const { controls, details } = await rowOf()
    expect(controls?.querySelector('select.dsm-workbuddy-context-budget')).not.toBeNull()
    expect(controls?.querySelector('.dsm-workbuddy-model-probe')).toBeNull()
    expect(details?.querySelector('.dsm-workbuddy-model-probe')).not.toBeNull()
    expect(details?.querySelector('.dsm-workbuddy-model-meta')).not.toBeNull()
  })

  it('indents lines 2 and 3 under the name, not under the checkbox', async () => {
    // A stylesheet contract, because the alignment cannot be observed in jsdom.
    // 22px = the checkbox's own box + the 8px gap before the name, so the three
    // lines read as one block instead of a checkbox column with three toppled
    // fragments beside it.
    const rules = /\.dsm-workbuddy-model-(?:controls|details)\{([^}]*)\}/g
    const found = Array.from(WORKBUDDY_CARD_CSS.matchAll(rules))
    expect(found.length, 'both line-2 and line-3 rules must exist').toBe(2)
    for (const rule of found) {
      expect(rule[1]).toContain('padding-inline-start:22px')
    }
    // Line 1 must NOT be indented: the checkbox opens it.
    const head = /\.dsm-workbuddy-model-head\{([^}]*)\}/.exec(WORKBUDDY_CARD_CSS)?.[1] ?? ''
    expect(head).not.toContain('padding-inline-start')
  })
})
