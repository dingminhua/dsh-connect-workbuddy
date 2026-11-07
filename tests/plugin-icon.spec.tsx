// @vitest-environment jsdom
import { createElement as h, act } from 'react'
import { createRequire } from 'node:module'
const { JSDOM } = createRequire(import.meta.url)('jsdom')
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginIcon, IconStylePreference, iconStyleSnapshot, setIconStyle } from '../src/client/plugin-icon.tsx'

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const storageWindow = new JSDOM('', { url: 'https://plugin.test' }).window
  vi.stubGlobal('localStorage', storageWindow.localStorage)
  vi.stubGlobal('Storage', storageWindow.Storage)
})

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  document.body.innerHTML = ''
  window.localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
async function mount() {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  await act(async () => { root.render(h('div', null, h(PluginIcon, { className: 'live-icon' }), h(IconStylePreference, { t: key => key }))) })
  return element
}
describe('plugin icon preference', () => {
  /**
   * THE DEFAULT IS OUR OWN ICON, and that is a product decision rather than an
   * implementation detail: the LD mark is the glyph the sidebar, the page header
   * and the panel drew before this preference existed. A skin is a CHOICE, so the
   * alternate has to be chosen; shipping it as the default would repaint an
   * identity the user never asked to change.
   *
   * The radio ORDER follows the same rule — default first — so the arrow keys walk
   * from the default towards the alternative, and the first item is the one a
   * keyboard user lands on.
   */
  const radio = (element: HTMLElement, style: 'original' | 'claude'): HTMLButtonElement => {
    const group = element.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    // Position-independent on purpose: this asserts the CONTRACT ("there is a
    // button for this style"), not the array index, so reordering the group for a
    // layout reason cannot turn the test green while the wiring is broken.
    const found = Array.from(group).find(button => button.textContent?.includes(`row.iconStyle${style === 'original' ? 'Original' : 'Claude'}`))
    if (found === undefined) throw new Error(`no ${style} radio`)
    return found
  }

  it('starts on our own icon, and only an explicit choice switches to the other style', async () => {
    const element = await mount()
    expect(iconStyleSnapshot(), 'nothing stored means our own icon').toBe('original')
    expect(element.querySelector('img.live-icon'), 'the default paints the LD mark').not.toBeNull()
    expect(element.querySelector('svg.live-icon')).toBeNull()

    await act(async () => { radio(element, 'claude').click() })
    expect(iconStyleSnapshot()).toBe('claude')
    expect(element.querySelector('svg.live-icon'), 'the alternate is an svg so it can inherit the skin').not.toBeNull()
    expect(element.querySelector('img.live-icon')).toBeNull()

    const remounted = await mount()
    expect(remounted.querySelector('svg.live-icon'), 'the choice survives a remount').not.toBeNull()

    await act(async () => { setIconStyle('original') })
    expect(element.querySelector('img.live-icon')).not.toBeNull()
    expect(remounted.querySelector('img.live-icon')).not.toBeNull()
  })

  it('keeps the previous choice and reports a browser storage refusal', async () => {
    const element = await mount()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    await act(async () => { radio(element, 'claude').click() })
    expect(element.querySelector('[role="alert"]')?.textContent).toBe('row.iconStyleSaveFailed')
    // A refused write must leave BOTH halves alone: the value it reports and the
    // glyph on screen stay on our own icon, so the card never claims a preference
    // it could not store.
    expect(iconStyleSnapshot()).toBe('original')
    expect(element.querySelector('img.live-icon')).not.toBeNull()
  })
})
