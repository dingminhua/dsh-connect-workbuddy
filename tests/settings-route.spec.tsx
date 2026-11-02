// @vitest-environment jsdom
/**
 * The credits panel's route to this plugin's settings page.
 *
 * Two halves, both pinned here because they fail differently:
 *
 *  - `settings-route.ts` (pure) decides WHICH host route is taken. It is the
 *    only place that knows a plugin's settings live on the Plugins page rather
 *    than in Settings, and it must probe at PRESS time — the service it uses
 *    belongs to another bundle whose apply order is not ours to assume.
 *  - `ComposerCredits` owns the button: when it is rendered at all, that a press
 *    closes the popover, and that a host with no route says so instead of
 *    leaving a button that does nothing.
 *
 * The reported request (m01691): the credit popover listed nine accounts and a
 * batch test, and getting from there to the plugin's own settings meant closing
 * it, hunting the Plugins row and clicking the bundle. One press should do it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PLUGINS_PANEL_ID,
  WORKBUDDY_PACKAGE_NAME,
  openPluginSettingsPage,
} from '../src/client/settings-route.ts'
import { ComposerCredits } from '../src/client/ComposerCredits.tsx'
import { WORKBUDDY_COMPOSER_CSS } from '../src/client/styles.ts'
import { mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.querySelectorAll('.dsm-workbuddy-composer-panel').forEach(node => { node.remove() })
})

/** A usage body with two accounts, so the panel renders its table. */
function usageOf(total: number): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    accountId: 'a-1',
    accountName: 'A One',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [
      { id: 'a-1', accountName: 'A One', selected: true },
      { id: 'a-2', accountName: 'A Two', selected: false },
    ],
    models: [],
    enabledModelIds: [],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total, expiringSoon: 0, packages: [] },
  }
}

/** Buttons of the open panel (it is portaled to `document.body`). */
const panelButtons = (): HTMLButtonElement[] =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-composer-panel button'))

describe('openPluginSettingsPage: which host route is taken', () => {
  it('opens the bundle page through pluginNavigation, by EXACT package name', () => {
    // Exact equality is the contract: the Plugins inventory compares
    // `pkg.name` and a Loader entry id would never match.
    const openBundle = vi.fn()
    const selectPanel = vi.fn()
    const opened = openPluginSettingsPage(name => ({
      pluginNavigation: { openBundle },
      layout: { selectPanel },
    })[name as 'pluginNavigation' | 'layout'])

    expect(opened).toBe(true)
    expect(openBundle).toHaveBeenCalledWith(WORKBUDDY_PACKAGE_NAME)
    // The published route wins; the layout fallback must not also fire, or the
    // user would land on the plugin LIST instead of this bundle's page.
    expect(selectPanel).not.toHaveBeenCalled()
  })

  it('falls back to the Plugins main panel when pluginNavigation is absent', () => {
    // A profile composed without the plugin-manager bundle's navigation service
    // still has the page itself; landing on it is one click from the row.
    const selectPanel = vi.fn()
    const opened = openPluginSettingsPage(name => ({ layout: { selectPanel } })[name as 'layout'])

    expect(opened).toBe(true)
    expect(selectPanel).toHaveBeenCalledWith(PLUGINS_PANEL_ID)
  })

  it('falls back when the bundle is not in the inventory', () => {
    // `openBundle` throws for a package the page does not list (the live Desktop
    // profile mounts this code under an `include:` id, so a composition CAN end
    // up there). A throw must not escape into a click handler.
    const selectPanel = vi.fn()
    const opened = openPluginSettingsPage(name => ({
      pluginNavigation: {
        openBundle: () => { throw new Error('unknown bundle') },
      },
      layout: { selectPanel },
    })[name as 'pluginNavigation' | 'layout'])

    expect(opened).toBe(true)
    expect(selectPanel).toHaveBeenCalledWith(PLUGINS_PANEL_ID)
  })

  it('answers false when the Plugins page is not registered', () => {
    // `selectPanel` throws for a key with no `main` registration — the Plugins
    // page disabled or stripped from the composition.
    const opened = openPluginSettingsPage(name => ({
      layout: { selectPanel: () => { throw new Error('main key not registered') } },
    })[name as 'layout'])

    expect(opened).toBe(false)
  })

  it('answers false when the host offers neither route', () => {
    expect(openPluginSettingsPage(() => undefined)).toBe(false)
    // A service that exists but carries no usable method is the same answer: a
    // half-shaped stub must not be called into.
    expect(openPluginSettingsPage(name => ({ layout: {} })[name as 'layout'])).toBe(false)
  })

  it('probes on EVERY call, so a late-applying provider is still found', () => {
    // The whole reason the probe is not captured in `apply`: the Plugins bundle
    // may apply after this one. First press finds nothing, second finds it.
    const openBundle = vi.fn()
    let provided = false
    const opened = openPluginSettingsPage(name => {
      if (name !== 'pluginNavigation' || !provided) return undefined
      return { openBundle }
    })

    expect(opened).toBe(false)
    provided = true
    expect(openPluginSettingsPage(name => {
      if (name !== 'pluginNavigation' || !provided) return undefined
      return { openBundle }
    })).toBe(true)
    expect(openBundle).toHaveBeenCalledOnce()
  })
})

describe('ComposerCredits settings control', () => {
  const openPanel = async (props: Record<string, unknown> = {}) => {
    stubFetch(() => ({ body: usageOf(1072) }))
    const m = await mount(ComposerCredits as never, { t, provider: 'workbuddy', ...props })
    await m.settle()
    // The trigger is the first button in the composer row.
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    return m
  }

  const settingsButton = (): HTMLButtonElement | undefined =>
    panelButtons().find(button => button.className.includes('panel-settings'))

  it('renders the control when the host has a route, and opens the page', async () => {
    const onOpenSettings = vi.fn(() => true)
    const m = await openPanel({ onOpenSettings })

    const button = settingsButton()
    expect(button).toBeDefined()
    // The label names the destination; a bare "Settings" would send the reader
    // to the shell's read-only inventory instead of this plugin's page.
    expect(button?.textContent).toBe('composer.openSettings')
    expect(button?.title).toBe('composer.openSettingsHint')

    await m.click(button as Element)
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('closes the popover after navigating', async () => {
    // The panel is portaled over the composer; navigating the centre column does
    // not remove it, so it would sit on top of the page it just opened.
    const onOpenSettings = vi.fn(() => true)
    const m = await openPanel({ onOpenSettings })
    const button = settingsButton()
    await m.click(button as Element)
    await m.settle()

    expect(onOpenSettings).toHaveBeenCalledOnce()
    expect(document.body.querySelector('.dsm-workbuddy-composer-panel')).toBeNull()
  })

  it('renders NO control when the host has no route at all', async () => {
    // A control that cannot do what it says is worse than one that is absent.
    await openPanel({})
    expect(panelButtons().length).toBeGreaterThan(0)
    expect(settingsButton()).toBeUndefined()
  })

  it('says so, and stays open, when the press cannot navigate', async () => {
    // A host that offers the button but refuses the route: silence here reads as
    // a broken button, and closing would lose the table for nothing.
    const onOpenSettings = vi.fn(() => false)
    const m = await openPanel({ onOpenSettings })
    await m.click(settingsButton() as Element)
    await m.settle()

    expect(onOpenSettings).toHaveBeenCalledOnce()
    const panel = document.body.querySelector('.dsm-workbuddy-composer-panel')
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('composer.openSettingsFailed')
  })

  it('leaves the batch test OUT of the header', async () => {
    // The owner's call (m02239): the one-click "test all" control is gone. It
    // was a real cost — a serial probe batch that spends credits and takes a
    // minute — sitting one pixel from a link, and the card's account pool already
    // owns that job. Pinned here so it is not quietly restored: the panel now has
    // exactly one header control.
    stubFetch(() => ({ body: usageOf(1072) }))
    const m = await mount(ComposerCredits as never, {
      t,
      provider: 'workbuddy',
      onOpenSettings: vi.fn(() => true),
    })
    await m.settle()
    await m.click(m.buttons()[0] as Element)
    await m.settle()

    const headerButtons = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-composer-panel-head button'),
    )
    expect(headerButtons).toHaveLength(1)
    expect(headerButtons[0]?.className).toContain('panel-settings')
  })
})

describe('settings control CSS contract', () => {
  it('defines a rule for the classes the head renders', () => {
    // Same contract the readout's own classes are held to: a class the component
    // renders with no rule looks like a browser default button in the header.
    for (const name of ['dsm-workbuddy-composer-panel-actions', 'dsm-workbuddy-composer-panel-settings']) {
      expect(WORKBUDDY_COMPOSER_CSS).toContain(`.${name}{`)
    }
  })

  it('pins itself right from the WRAPPER, not from the button', () => {
    // The wrapper is always rendered, the button is not (a host with no route
    // renders none). Putting the auto margin on the button would tie the header
    // layout to whether the host happens to offer that route.
    const wrapper = /\.dsm-workbuddy-composer-panel-actions\{([^}]*)\}/.exec(WORKBUDDY_COMPOSER_CSS)?.[1] ?? ''
    expect(wrapper).toContain('margin-left:auto')
    expect(wrapper).toContain('display:flex')
    const button = /\.dsm-workbuddy-composer-panel-settings\{([^}]*)\}/.exec(WORKBUDDY_COMPOSER_CSS)?.[1] ?? ''
    expect(button).not.toContain('margin-left:auto')
  })
})

describe('settings control: the shape of the affordance', () => {
  /**
   * The control was an underlined grey word, which in a 13px header reads as
   * body text that happens to be clickable — the owner's report was simply
   * "美化一下". These pin the three properties that make it read as a control,
   * because each of them is easy to lose in a later tweak and none of them is
   * observable from the DOM alone.
   */
  const rule = (selector: string): string =>
    new RegExp(`\\.${selector}\\{([^}]*)\\}`).exec(WORKBUDDY_COMPOSER_CSS)?.[1] ?? ''

  it('is a pill with a visible fill at rest, not a text link', () => {
    const button = rule('dsm-workbuddy-composer-panel-settings')
    // A fill at REST is the whole point: an affordance that only appears on
    // hover is discovered after the user already knew it was there.
    expect(button).toContain('background:')
    expect(button).toContain('border-radius:999px')
    // No underline: that was the "this is a paragraph" tell.
    expect(button).not.toContain('text-decoration:underline')
  })

  it('renders a gear beside the label, hidden from assistive tech', async () => {
    stubFetch(() => ({ body: usageOf(1072) }))
    const m = await mount(ComposerCredits as never, { t, provider: 'workbuddy', onOpenSettings: vi.fn(() => true) })
    await m.settle()
    await m.click(m.buttons()[0] as Element)
    await m.settle()

    const button = panelButtons().find(node => node.className.includes('panel-settings'))
    const icon = button?.querySelector('svg')
    expect(icon).not.toBeNull()
    // aria-hidden: the button's own text already names it, so announcing the
    // icon too would read "设置 设置" to a screen reader.
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
    expect(icon?.getAttribute('focusable')).toBe('false')
    // The label is a SEPARATE element so the icon can be sized independently;
    // a bare text node would make the gap between them unstyleable.
    expect(button?.querySelector('.dsm-workbuddy-composer-panel-settings-label')?.textContent)
      .toBe('composer.openSettings')
  })

  it('keeps the label on one line and the icon from shrinking', () => {
    // A flex item shrinks by default, which would squash the gear into an oval
    // in a narrow popover; and a wrapped label would push the header taller.
    expect(rule('dsm-workbuddy-composer-panel-settings-icon')).toContain('flex:none')
    expect(rule('dsm-workbuddy-composer-panel-settings-label')).toContain('white-space:nowrap')
  })

  it('stops transitioning under prefers-reduced-motion', () => {
    // The colour transition is decoration; the hover state is fully visible
    // without it, so the media query only removes motion.
    expect(WORKBUDDY_COMPOSER_CSS).toContain('prefers-reduced-motion')
    expect(WORKBUDDY_COMPOSER_CSS).toMatch(/prefers-reduced-motion[^}]*\{[^}]*transition:none/)
  })
})
