// @vitest-environment jsdom
/**
 * The card as a SETTINGS SECTION (5.19.0).
 *
 * The configuration moved out of the Plugins page's keyed slots and into the
 * Settings panel's `settings.section` list. The component is the same one, drawn
 * on a third surface — and the surfaces differ in CHROME, never in data:
 *
 *   card      the Plugins page row: a collapse header and a `<li>` shell.
 *   page      the optional sidebar panel: a full page with a back control.
 *   settings  a Settings section: no collapse header, no back control, and no
 *             `<li>` — the shell owns the panel, the title and the scrolling
 *             column, so anything the card adds on top of the content is a
 *             second piece of chrome competing with the first.
 *
 * Why these are worth pinning rather than eyeballing:
 *
 *   NO BACK    A back arrow in a Settings dialog points at a conversation the
 *              reader did not come from — the shell's close button is the way
 *              out. It is also the affordance most likely to be restored by
 *              copy-paste from the `page` branch.
 *   NO `<li>`  A list item inside the panel's content column is invalid markup
 *              and inherits card spacing from a list context that is not there.
 *   SAME DATA  The section renders the same sub-tabs and the same account table
 *              as the other two surfaces. A behaviour that only exists on one
 *              surface is a behaviour two thirds of users never get.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { WORKBUDDY_CARD_CSS } from '../src/client/styles.ts'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

const USAGE_PATH = '/plugins/dsh-connect-workbuddy/usage'

function usageOf(): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'real-1',
    accountName: 'Real One',
    region: 'cn',
    domain: 'www.workbuddy.cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'real-1', accountName: 'Real One' }],
    models: [{ id: 'paid-1', name: 'Paid One', creditMultiplier: 0.79 }],
    enabledModelIds: ['paid-1'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 1072, expiringSoon: 0, packages: [] },
  }
}

async function mountSurface(surface: 'card' | 'page' | 'settings'): Promise<Awaited<ReturnType<typeof mount>>> {
  stubFetch(() => ({ body: usageOf() }))
  const m = await mount(WorkBuddyCard as never, { t, settingsScope: fakeScope(), surface })
  await m.settle()
  return m
}

describe('settings surface: chrome belongs to the shell', () => {
  it('renders the content without a collapse header', async () => {
    const m = await mountSurface('settings')
    // The collapse header is the Plugins-page affordance: it opens a row in
    // someone else's list. Here the reader already arrived at a page.
    expect(m.container.querySelector('.dsm-plugin-card-header')).toBeNull()
    expect(m.container.querySelector('.dsm-workbuddy-page-back')).toBeNull()
  })

  it('renders no `<li>` shell, because it is not a list item here', async () => {
    const m = await mountSurface('settings')
    expect(m.container.querySelector('li')).toBeNull()
    // ...but the panel did render, so this is not passing on an empty tree.
    expect(m.container.querySelector('.dsm-workbuddy-settings')).not.toBeNull()
  })

  it('names itself at the top: title and one-line description', async () => {
    // Without this the page opens on a table of accounts and a row of switches
    // with nothing saying what either belongs to.
    const m = await mountSurface('settings')
    expect(m.container.querySelector('.dsm-workbuddy-settings-head')).not.toBeNull()
    expect(m.container.querySelector('.dsm-workbuddy-page-title')?.textContent).toBeTruthy()
    expect(m.container.querySelector('.dsm-workbuddy-page-desc')?.textContent).toBeTruthy()
  })

  it('shows the same sub-tabs the other surfaces show', async () => {
    // The section is a surface, not a reduced version. If a later change gives
    // Settings its own idea of what is visible, the same plugin starts behaving
    // differently depending on where the user clicked.
    const settings = await mountSurface('settings')
    const tabs = Array.from(settings.container.querySelectorAll('.dsm-workbuddy-panel-tab')).map(node => node.textContent)
    expect(tabs.length).toBeGreaterThan(0)

    // Compared against the OTHER page-like surface: the Plugins-page card starts
    // COLLAPSED (its content is not mounted until the header is pressed), so it
    // is not a peer to compare against without an extra click.
    const page = await mountSurface('page')
    const pageTabs = Array.from(page.container.querySelectorAll('.dsm-workbuddy-panel-tab')).map(node => node.textContent)
    expect(pageTabs).toEqual(tabs)
  })
})

describe('page surface: unchanged by the new one', () => {
  it('still carries its back control and stays expanded', async () => {
    // The sidebar panel's page is a DIFFERENT destination and keeps its own
    // chrome; the settings surface must not have altered it while sharing the
    // render branch.
    const back = vi.fn()
    stubFetch(() => ({ body: usageOf() }))
    const m = await mount(WorkBuddyCard as never, {
      t,
      settingsScope: fakeScope(),
      surface: 'page',
      backToConversation: back,
    })
    await m.settle()

    const button = m.container.querySelector('.dsm-workbuddy-page-back')
    expect(button).not.toBeNull()
    expect(m.container.querySelector('.dsm-workbuddy-settings')).toBeNull()
    await m.click(button as Element)
    expect(back).toHaveBeenCalledOnce()
  })
})

describe('settings surface: the stylesheet it depends on', () => {
  const rule = (selector: string): string =>
    new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(WORKBUDDY_CARD_CSS)?.[1] ?? ''

  it('does not claim the full height inside the panel column', () => {
    // `.dsm-workbuddy-page` sets `height:100%` for the sidebar page, where it is
    // the whole centre column. Inside the Settings panel that produces a SECOND
    // scrollbar inside a column that already scrolls.
    const settings = rule('.dsm-workbuddy-settings')
    expect(settings).toContain('height:auto')
    expect(settings).toContain('overflow:visible')
  })

  it('drops the 860px centring cap the standalone page needs', () => {
    // Centring is right when the page owns the window. Inside an 800px panel
    // minus a 188px nav rail, the cap would shrink the content and leave it
    // sitting against the left edge.
    expect(rule('.dsm-workbuddy-settings>*')).toContain('max-width:none')
  })

  it('unwraps the content block from the floating card it used to be', () => {
    // In the Plugins page this block IS a card in a list, so it has a border.
    // As page content the border is wrong: it draws a box around the whole
    // panel.
    const body = rule('.dsm-workbuddy-settings .dsm-workbuddy-page-body .dsm-workbuddy-usage')
    expect(body).toContain('border:0')
    // The BACKGROUND must stay, and 5.19.1 is why. This case used to require
    // `background:transparent` on the theory that page content needs no fill —
    // true only while the shell's column is opaque. issue #209: with a custom
    // wallpaper that column is translucent, so a transparent content area put
    // 账号池 and the hint lines straight over the picture. The fill is now the
    // theme's own layer colour, which is invisible on an opaque theme.
    expect(body, 'the content area must paint an opaque surface (issue #209)')
      .toMatch(/background:var\(--dsw-alias-bg-/u)
  })
})
