// @vitest-environment jsdom
/**
 * The capabilities panel's STRUCTURE, pinned (5.20.0).
 *
 * Every assertion here corresponds to a defect that actually shipped and that a
 * screenshot could not name:
 *
 *   1. The panel had NO gap between its blocks. It was `display:block` with
 *      `gap:normal`, so the six blocks touched and the rhythm was improvised by
 *      whatever padding each one carried — ink-to-ink 12 / 50 / 2 / 17 / 0. The
 *      fix makes the panel a flex column, and these tests pin that it stays one.
 *   2. The rule that fixed it was first written as
 *      `.dsm-workbuddy-panel-capabilities{…}`, a selector that matches NOTHING:
 *      no panel in this card carries a per-panel class, they are all just
 *      `.dsm-workbuddy-panel`. It parsed, shipped and did nothing. The CSS now
 *      targets the id, and one test below asserts the ID is what the panel has.
 *   3. The gateway card's title rendered at 16px while every switch label in the
 *      same panel rendered at 13px — it inherited the page size because its row
 *      is not a `.dsm-workbuddy-pref` and nothing else set the size.
 *   4. Only the middle group had a lead line, so the panel read as "a paragraph,
 *      a card, then three lists" with one list explaining itself.
 *
 * jsdom computes no real layout, so nothing here measures pixels. The pixel
 * numbers live in `tools/capabilities-shot.tsx`, which renders the real column
 * at 564px and dumps geometry; this file pins the CSS CONTRACT that produces
 * those numbers — the properties, on the right elements, at the right values.
 * Two files, because a jsdom test that asserted geometry would be asserting
 * jsdom's fake layout, and a Chrome dump that asserted structure would need a
 * live browser to run in CI.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { WORKBUDDY_CARD_CSS } from '../src/client/styles.ts'
import { mount, fakeScope, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

const usageOf = (region: string): Record<string, unknown> => ({
  status: 'signed-in',
  region,
  domain: region === 'cn' ? 'www.codebuddy.cn' : 'www.workbuddy.ai',
  accountId: `${region}-1`,
  accountName: `${region} One`,
  tokenExpiresAtMs: Date.now() + 86_400_000,
  selectionExplicit: true,
  accounts: [{ accountId: `${region}-1`, accountName: `${region} One` }],
  models: [{ id: 'glm-5.3', name: 'GLM-5.3' }],
  enabledModelIds: ['glm-5.3'],
  imageModelIds: [],
  contextBudgets: {},
  credits: { total: 10, expiringSoon: 0, packages: [] },
})

async function render(): Promise<Awaited<ReturnType<typeof mount>>> {
  const body = usageOf('cn')
  stubFetch(url => ({ body: url.includes('__save') ? { value: {} } : body }))
  const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
  await m.settle()
  // The panels are all MOUNTED but the inactive ones are `hidden`. `hidden`
  // does not remove children from the DOM, so the structural assertions below
  // work either way — but switching the tab first is what a user does, and it
  // keeps these tests honest if the panel ever becomes conditionally rendered.
  const tab = m.container.querySelector('#dsm-workbuddy-tab-capabilities')
  if (tab === null) {
    throw new Error(`capabilities tab missing; ids=${Array.from(m.container.querySelectorAll('[id]')).map(el => el.id).join(',')}; textlen=${m.text().length}`)
  }
  await m.click(tab)
  return m
}

/** Read one declaration out of a selector's block in the emitted CSS. */
function ruleBody(css: string, selector: string): string {
  // The CSS is a template literal with no nested braces inside a declaration
  // block, so a non-greedy match to the first `}` is exact.
  const match = new RegExp(`${selector.replace(/[.#>[\]]/g, ch => `\\${ch}`)}\\s*\\{([^}]*)\\}`).exec(css)
  return match === null ? '' : (match[1] ?? '')
}

describe('the capabilities panel is a column of groups, not a run of paragraphs', () => {
  it('sets a real gap on the panel itself', () => {
    // The defect: `gap:normal` on a block container means ZERO space between
    // children, so six blocks sat flush and the rhythm came from their padding.
    const body = ruleBody(WORKBUDDY_CARD_CSS, '#dsm-workbuddy-panel-capabilities')
    expect(body, 'the panel has no rule of its own').not.toBe('')
    expect(body).toContain('display:flex')
    expect(body).toContain('flex-direction:column')
    expect(body).toMatch(/gap:\s*18px/)
  })

  it('targets the ID, because the panel carries no per-panel class', async () => {
    // THE REGRESSION THAT MADE THE FIX A NO-OP. A `.dsm-workbuddy-panel-capabilities`
    // selector parses, ships and matches nothing — the panel keeps looking wrong
    // and the CSS keeps looking right. Assert the hook the CSS actually uses.
    const m = await render()
    try {
      const panel = m.container.querySelector('#dsm-workbuddy-panel-capabilities')
      expect(panel, 'the capabilities panel is missing').not.toBeNull()
      expect(panel?.className).toBe('dsm-workbuddy-panel')
      expect(panel?.classList.contains('dsm-workbuddy-panel-capabilities')).toBe(false)
      // ...and the stylesheet must not SELECT that class. The comment explaining
      // this trap necessarily SPELLS the dead selector, so strip comments first:
      // matching the raw text would fail on the very note that documents it.
      const withoutComments = WORKBUDDY_CARD_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
      expect(withoutComments).not.toMatch(/\.dsm-workbuddy-panel-capabilities/)
    } finally {
      await m.unmount()
    }
  })

  it('no longer fakes the panel gap with per-group top padding', () => {
    // `.prefs` used to carry `padding:2px 0 0`, which is what produced the 2px
    // squeeze between two switch groups and the 50px hole after the card. One
    // gap owns the rhythm now, so the ad-hoc padding is gone.
    const body = ruleBody(WORKBUDDY_CARD_CSS, '.dsm-workbuddy-prefs')
    expect(body, '.dsm-workbuddy-prefs has no rule').not.toBe('')
    expect(body).toMatch(/gap:\s*14px/)
    expect(body).toMatch(/padding:\s*0(;|$)/)
  })

  it('drops the divider that became a third spacing statement', () => {
    // The border above the first upstream switch existed to separate kinds of
    // setting AND to prop up a gapless panel. With an 18px gap it added a third
    // statement in the same 20px of air (measured 69px ink against 18px
    // elsewhere). The rule must not come back.
    expect(WORKBUDDY_CARD_CSS).not.toMatch(/\.dsm-workbuddy-upstream-pref:first-of-type\s*\{/)
  })
})

describe('the gateway card speaks the same typography as its neighbours', () => {
  it('sets the switch-row size on the card row', () => {
    // It is not a `.dsm-workbuddy-pref`, so without this it inherited the page's
    // 16px and its title rendered larger than every label around it.
    const body = ruleBody(WORKBUDDY_CARD_CSS, '.dsm-workbuddy-cnbase-row')
    expect(body, '.dsm-workbuddy-cnbase-row has no rule').not.toBe('')
    expect(body).toMatch(/font-size:\s*13px/)
    expect(body).toMatch(/line-height:\s*18px/)
  })

  it('indents the card so its title lines up with the switch labels', () => {
    // Measured 318px vs 330px before this value: 15px checkbox + 10px row gap.
    const body = ruleBody(WORKBUDDY_CARD_CSS, '.dsm-workbuddy-cnbase')
    expect(body).toMatch(/padding:\s*10px 12px 10px 25px/)
  })
})

describe('every group carries a lead line', () => {
  it('renders five groups and six blocks', async () => {
    // The note + the card + four groups. The count is the contract: a group that
    // silently becomes a bare <label> takes the panel gap as a ROW instead of as
    // a group, which is exactly what the sidebar switch used to do.
    const m = await render()
    const panel = m.container.querySelector('#dsm-workbuddy-panel-capabilities')
    const blocks = Array.from(panel?.children ?? []) as Element[]
    const groups = blocks.filter(el => String(el.className).includes('dsm-workbuddy-prefs'))
    expect(groups, `blocks were ${blocks.map(el => String(el.className)).join(', ')}`).toHaveLength(4)
    await m.unmount()
  })

  it('gives every group its own lead sentence', async () => {
    // Only the upstream group had one before, so the panel read as "a paragraph,
    // a card, then three lists" with one list explaining itself.
    const m = await render()
    const panel = m.container.querySelector('#dsm-workbuddy-panel-capabilities')
    for (const group of Array.from(panel?.querySelectorAll('.dsm-workbuddy-prefs') ?? [])) {
      const lead = group.querySelector(':scope > .dsm-workbuddy-pref-hint')
      expect(lead, `a group has no lead line: ${group.innerHTML.slice(0, 80)}`).not.toBeNull()
      expect((lead?.textContent ?? '').trim().length).toBeGreaterThan(10)
    }
    await m.unmount()
  })
})

describe('the lead line reads as a heading, not as body text', () => {
  it('pulls each lead closer to its first row than the rows are to each other', () => {
    // Measured before: the lead sat 14px from its first row — the SAME distance
    // as row-to-row, so it read as a paragraph that happened to precede the list
    // rather than as the list's heading. The rule makes it 8px.
    const body = ruleBody(WORKBUDDY_CARD_CSS, '.dsm-workbuddy-prefs > .dsm-workbuddy-pref-hint:first-child')
    expect(body, 'the lead rule is missing').not.toBe('')
    expect(body).toMatch(/margin-bottom:\s*-6px/)
    // ...and the group gap it is measured against must still be the larger of
    // the two, or "closer to its own row" stops meaning anything.
    const group = ruleBody(WORKBUDDY_CARD_CSS, '.dsm-workbuddy-prefs')
    expect(group).toMatch(/gap:\s*14px/)
  })

  it('gives every group exactly one lead, as its first child', async () => {
    const m = await render()
    try {
      const panel = m.container.querySelector('#dsm-workbuddy-panel-capabilities')
      for (const group of Array.from(panel?.querySelectorAll('.dsm-workbuddy-prefs') ?? [])) {
        const first = group.firstElementChild
        expect(first?.className, 'the lead is not the first child').toBe('dsm-workbuddy-pref-hint')
        // `:first-child` is what the CSS targets, so a group whose lead ends up
        // anywhere else would style nothing.
        expect(group.querySelectorAll(':scope > .dsm-workbuddy-pref-hint')).toHaveLength(1)
      }
    } finally {
      await m.unmount()
    }
  })
})
