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

/** The tier labels rendered for the model row, in document order. */
function tierLabels(html: string): string[] {
  const fieldset = /<fieldset[^>]*dsm-workbuddy-context-budget[^>]*>([\s\S]*?)<\/fieldset>/.exec(html)
  if (fieldset === null) return []
  return Array.from((fieldset[1] ?? '').matchAll(/<span>([^<]*)<\/span>/g), match => match[1] ?? '')
}

/** The tier radios in the model row, in document order. */
function tierRadios(container: HTMLElement): HTMLInputElement[] {
  // `Array.from`, not a spread: this tsconfig carries `dom` without
  // `dom.iterable`, so `NodeListOf` has no `[Symbol.iterator]`.
  return Array.from(container.querySelectorAll<HTMLInputElement>('.dsm-workbuddy-context-budget input[type=radio]'))
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
    expect(tierLabels(m.html())).toEqual(['200K', '256K'])
  })

  it('offers 500K to a model that really exceeds it', async () => {
    // 1M: the user's actual case (deepseek-v4.1-flash, glm-5.3-flash,
    // space-bunny, hy4-preview all advertise 960K-1M).
    const m = await render(usageWithWindow(1_000_000))
    expect(tierLabels(m.html())).toEqual(['200K', '500K', '1M'])
  })

  it('does not offer 500K to a model at exactly 500 000', async () => {
    // The boundary the gate must exclude: `> 500_000` is strict, so an exact
    // 500K window keeps the native tier as its only "max" — no duplicate label
    // with two different meanings. (No shipped CN model sits at exactly 500K;
    // this pins the operator, not an observed catalog entry.)
    const m = await render(usageWithWindow(500_000))
    expect(tierLabels(m.html())).toEqual(['200K', '500K'])
    // Exactly one 500K: the native tier, which for this window IS 500K. The
    // 500K convenience tier must not also render — two identical radio labels
    // writing different values is unreadable and un-clickable.
    expect(tierLabels(m.html()).filter(label => label === '500K')).toHaveLength(1)
  })

  it('shows only the native tier for a model at or below 200K', async () => {
    // hy3 (192K) is the shipped case: the 200K radio was already hidden, and
    // the half-meg tier must stay hidden by the same rule.
    const m = await render(usageWithWindow(192_000))
    expect(tierLabels(m.html())).toEqual(['192K'])
  })

  it('checks the 500K radio when the budget is 500 000', async () => {
    const m = await render(usageWithWindow(1_000_000, { 'probe-model': 500_000 }))
    const radios = tierRadios(m.container)
    const checked = radios.filter(radio => radio.checked)
    expect(checked).toHaveLength(1)
    // Sibling span of the checked input, so this asserts the LABEL the user sees.
    expect(checked[0]?.nextElementSibling?.textContent).toBe('500K')
  })

  it('leaves the 500K radio unchecked when no budget is stored', async () => {
    // No stored budget must not read as "500K selected": the default the card
    // renders is the 200K tier, and `activeContextBudgets[id] === 500_000` is
    // false for `undefined`.
    const m = await render(usageWithWindow(1_000_000))
    const radios = tierRadios(m.container)
    const checked = radios.filter(radio => radio.checked)
    expect(checked).toHaveLength(1)
    expect(checked[0]?.nextElementSibling?.textContent).toBe('200K')
  })

  it('keeps 500K selectable on a read-only card but not while saving', async () => {
    // `!canWrite || saving` is the shared gate for every tier radio. This pins
    // that the new tier copies it rather than accidentally shipping a writable
    // control on a locked card.
    const m = await render(usageWithWindow(1_000_000))
    const radios = tierRadios(m.container)
    expect(radios).toHaveLength(3)
    expect(radios.map(radio => radio.disabled)).toEqual([false, false, false])
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

  it('lets the tier group wrap between its own labels', () => {
    // `flex:none` stays — the group must not be SHRUNK into unreadability by a
    // long model name — but `flex-wrap` has to be set too, because the three
    // labels (`200K`, `500K`, `1.048M`) exceed a phone row on their own. Without
    // this the group would be pushed whole past the clip: a wrapped row whose
    // children refuse to wrap still overflows.
    const budget = ruleOf('dsm-workbuddy-context-budget')
    expect(budget).toContain('flex-wrap:wrap')
    expect(budget).toContain('flex:none')
    // A tier label breaks mid-word otherwise (`20` / `0K`), which reads as a
    // rendering bug on the one control the user is trying to hit.
    expect(ruleOf('dsm-workbuddy-context-budget label')).toContain('white-space:nowrap')
  })

  it('gives the tier group its own full-width line on a phone', () => {
    // The media query is the difference between "reachable" and "scrambled": at
    // `justify-content:flex-end` a wrapped group dangles under the buttons, and
    // the native-window tier — the last label in the group, and the one #198 is
    // about — is what lands nearest the edge.
    const media = /@media \(max-width:760px\)\{\.dsm-workbuddy-context-budget\{([^}]*)\}\}/u.exec(WORKBUDDY_CARD_CSS)?.[1] ?? ''
    expect(media).toContain('flex:1 1 100%')
    expect(media).toContain('justify-content:flex-start')
  })

  it('renders all three tiers in the DOM for a 1M model', async () => {
    // The guard the issue asked for on top of the CSS ones: DOM presence is not
    // what regressed, and asserting it alone is precisely how this stayed green
    // — but it is the PREMISE of the CSS assertions, so it is pinned here in the
    // same file that reads them. All three, in one row, for one model.
    const m = await render(usageWithWindow(1_000_000))
    expect(tierRadios(m.container)).toHaveLength(3)
    expect(tierLabels(m.html())).toEqual(['200K', '500K', '1M'])
    // And the row that holds them is the one the stylesheet allows to wrap.
    const head = m.container.querySelector('.dsm-workbuddy-model-head')
    expect(head).not.toBeNull()
    expect(head?.querySelector('.dsm-workbuddy-context-budget')).not.toBeNull()
  })
})
