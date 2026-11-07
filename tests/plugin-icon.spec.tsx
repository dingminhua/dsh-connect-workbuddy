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
  it('switches all live icons and persists the selected style across remounts', async () => {
    const element = await mount()
    expect(element.querySelector('svg.live-icon')).not.toBeNull()
    const original = element.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!
    await act(async () => { original.click() })
    expect(iconStyleSnapshot()).toBe('original')
    expect(element.querySelector('img.live-icon')).not.toBeNull()
    const remounted = await mount()
    expect(remounted.querySelector('img.live-icon')).not.toBeNull()
    await act(async () => { setIconStyle('claude') })
    expect(element.querySelector('svg.live-icon')).not.toBeNull()
    expect(remounted.querySelector('svg.live-icon')).not.toBeNull()
  })
  it('keeps the previous choice and reports a browser storage refusal', async () => {
    const element = await mount()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    await act(async () => { element.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!.click() })
    expect(element.querySelector('[role="alert"]')?.textContent).toBe('row.iconStyleSaveFailed')
    expect(iconStyleSnapshot()).toBe('claude')
    expect(element.querySelector('svg.live-icon')).not.toBeNull()
  })
})
