// @vitest-environment jsdom
/**
 * The sidebar panel page (surface = 'page').
 *
 * The same WorkBuddyCard renders two surfaces:
 *
 *   - `surface` omitted/`'card'`: the collapsible `li.dsm-plugin-card` shell the
 *     Plugins page embeds;
 *   - `surface: 'page'`: the full page the sidebar row opens in the centre
 *     column. It must NOT reuse the card chrome — no collapse toggle, no `li`
 *     wrapper — because a page already owns its own chrome, and a collapse
 *     button there would hide the only thing the page shows.
 *
 * What these tests pin:
 *
 *   PAGE       The page surface renders `dsm-workbuddy-page`, never the card
 *              shell, and its body is always expanded.
 *   BACK       The back affordance renders only when `backToConversation` is
 *              supplied (a host without `layout` still gets a usable page), and
 *              calls it exactly once on click.
 *   CARD       The default surface still renders the collapsible shell, so the
 *              existing Plugins-page behaviour is untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

const USAGE_PATH = '/plugins/dsh-connect-workbuddy/usage'

function signedIn(): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'real-1',
    accountName: 'Real One',
    region: 'cn',
    domain: 'www.workbuddy.cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'real-1', accountName: 'Real One' }],
    models: [{ id: 'm-1', name: 'Model One', creditMultiplier: 1 }],
    enabledModelIds: ['m-1'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 100, expiringSoon: 0, packages: [] },
  }
}

async function mountPage(back?: () => void) {
  stubFetch(url => (url.startsWith(USAGE_PATH) ? { body: signedIn() } : { body: {} }))
  const props = back === undefined
    ? { t, settingsScope: fakeScope(), surface: 'page' as const }
    : { t, settingsScope: fakeScope(), surface: 'page' as const, backToConversation: back }
  const m = await mount(WorkBuddyCard, props)
  await m.settle()
  return m
}

describe('the page surface', () => {
  it('renders the page shell, not the collapsible card chrome', async () => {
    const m = await mountPage()
    expect(m.container.querySelector('.dsm-workbuddy-page')).not.toBeNull()
    expect(m.container.querySelector('.dsm-plugin-card')).toBeNull()
    expect(m.container.querySelector('.dsm-plugin-card-header')).toBeNull()
    // The body is always expanded: no `hidden` on the usage block.
    const usage = m.container.querySelector('.dsm-workbuddy-usage')
    expect(usage).not.toBeNull()
  })

  it('renders no back button when no backToConversation is injected', async () => {
    const m = await mountPage()
    expect(m.container.querySelector('.dsm-workbuddy-page-back')).toBeNull()
  })

  it('renders the back button and calls it once', async () => {
    const back = vi.fn()
    const m = await mountPage(back)
    const button = m.container.querySelector('.dsm-workbuddy-page-back') as HTMLButtonElement
    expect(button).not.toBeNull()
    await m.click(button)
    expect(back).toHaveBeenCalledTimes(1)
  })
})

describe('the card surface stays unchanged', () => {
  it('still renders the collapsible shell by default', async () => {
    stubFetch(url => (url.startsWith(USAGE_PATH) ? { body: signedIn() } : { body: {} }))
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope(), view: 'page' })
    await m.settle()
    expect(m.container.querySelector('.dsm-plugin-card')).not.toBeNull()
    expect(m.container.querySelector('.dsm-workbuddy-page')).toBeNull()
  })
})
