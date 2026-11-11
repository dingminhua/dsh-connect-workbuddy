// @vitest-environment jsdom
/**
 * The "· N 新模型" segment of the composer readout: a real control, and a real
 * answer to "which models?".
 *
 * Two things are pinned here, and they are the whole point of the follow-up:
 * 1. The segment is a control, not decoration bolted into the trigger — it is
 *    its own `<button>`, reached with the pill by keyboard, announced as a
 *    button, and never rendered while the new-model list is empty.
 * 2. Clicking it takes the reader to the answer: the panel opens with the
 *    new-model row focused and highlighted. The Host owns the model picker and
 *    offers this plugin no API to open it, so the honest answer is the panel's
 *    own row — and the rows themselves are marked "新" by the picker label,
 *    which reads the SAME ids.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerCredits, hostNewModelsShownOf } from '../src/client/ComposerCredits.tsx'
import { mount, t } from './pool-render-helpers.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
  // The panel is portaled to document.body; clean it between cases.
  document.body.querySelectorAll('.dsm-workbuddy-composer-panel').forEach(node => { node.remove() })
})

/** A signed-in usage body for one region, optionally with first-seen ids. */
function usageOf(
  region: string,
  total: number,
  newModelIds?: string[],
  // The segment is opt-IN, so a test that wants to see it has to turn it on the
  // same way the settings card would. Passing ids alone no longer renders
  // anything — see `showNewModelsInMainUi` and the first `describe` below.
  showNewModels = true,
): Record<string, unknown> {
  return {
    status: 'signed-in',
    region,
    accountId: 'a-1',
    accountName: 'A One',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ id: 'a-1', accountName: 'A One', selected: true }],
    models: [
      { id: 'm1', name: 'Model One' },
      { id: 'm2', name: 'Model Two' },
    ],
    enabledModelIds: [],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total, expiringSoon: 0, packages: [] },
    showNewModelsInMainUi: showNewModels,
    ...newModelIds === undefined ? {} : { newModelIds },
  }
}

const render = async (body: Record<string, unknown>) => {
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => body }))
  const m = await mount(ComposerCredits as any, { t, provider: 'workbuddy' })
  await m.settle()
  return m
}

const buttonsOf = (container: HTMLElement): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button'))

/** The "· N 新模型" button, if the readout rendered one. */
const segmentOf = (buttons: HTMLButtonElement[]): HTMLButtonElement | undefined =>
  buttons.find(button => button.className.includes('dsm-workbuddy-composer-credits-new'))

describe('the "· N 新模型" opt-in switch', () => {
  it('renders NOTHING when the switch is absent from the usage document', async () => {
    // Default OFF. The document is the authority and an absent field must read
    // as "not enabled", never as consent — same rule as `imageToolEnabled`.
    const m = await render(usageOf('cn', 100, ['m1'], false))
    expect(segmentOf(buttonsOf(m.container))).toBeUndefined()
    await m.unmount()
  })

  it('tips the panel open with the new-model row already revealed', async () => {
    const m = await render(usageOf('cn', 100, ['m1'], true))
    const segment = segmentOf(buttonsOf(m.container))
    if (segment === undefined) throw new Error('expected a new-model segment')
    segment.click()
    await m.settle()
    const row = document.body.querySelector('.dsm-workbuddy-composer-panel-new-row-revealed')
    expect(row).not.toBeNull()
    await m.unmount()
  })

  it('shows the note explaining what "new" means, only while the switch is on', async () => {
    const off = await render(usageOf('cn', 100, ['m1'], false))
    expect(document.body.querySelector('.dsm-workbuddy-composer-panel-new')).toBeNull()
    await off.unmount()
    const on = await render(usageOf('cn', 100, ['m1'], true))
    const segment = segmentOf(buttonsOf(on.container))
    if (segment === undefined) throw new Error('expected a new-model segment')
    segment.click()
    await on.settle()
    // The test double `t` returns the KEY, so this asserts that the note is the
    // new-model one rather than pinning the Chinese wording in two places.
    expect(document.body.textContent).toContain('composer.newModelsNote')
    await on.unmount()
  })
})

describe('the "· N 新模型" segment', () => {
  it('is its own button beside the trigger, named by its text', async () => {
    const m = await render(usageOf('cn', 143, ['m1', 'm2']))
    expect(m.buttons()).toHaveLength(2)
    const segment = segmentOf(m.buttons())
    expect(segment).toBeDefined()
    // A real control: announced as a button, named by what it says.
    expect(segment?.tagName).toBe('BUTTON')
    expect(segment?.textContent).toContain('2')
    expect(segment?.textContent).toContain('composer.newModels')
    // The tooltip answers "which two" before a click.
    expect(segment?.title).toContain('composer.newModelsTitle')
    // The credit figure the pill exists to show is still on the trigger.
    expect(m.text()).toContain('143')
  })

  it('is ABSENT while the new-model list is empty', async () => {
    // A permanently-on clickable "0 新模型" is background noise.
    const m = await render(usageOf('cn', 143))
    expect(m.buttons()).toHaveLength(1)
    expect(m.html()).not.toContain('dsm-workbuddy-composer-credits-new')
  })

  it('opens the panel on the row that answers "which models"', async () => {
    const m = await render(usageOf('cn', 143, ['m1']))
    const segment = segmentOf(m.buttons())
    expect(segment).toBeDefined()
    await m.click(segment as HTMLButtonElement)
    const panel = document.body.querySelector('.dsm-workbuddy-composer-panel')
    expect(panel).not.toBeNull()
    const row = document.body.querySelector('.dsm-workbuddy-composer-panel-new-row')
    expect(row).not.toBeNull()
    // Focus lands on the row (not just a scroll), and it is marked as the one
    // the click was for.
    expect(document.activeElement).toBe(row)
    expect(row?.className).toContain('dsm-workbuddy-composer-panel-new-row-revealed')
    expect(row?.textContent).toContain('composer.newModelsRow')
  })

  it('leaves the trigger\'s open/close behaviour intact', async () => {
    const m = await render(usageOf('cn', 143, ['m1']))
    // The credits trigger still toggles the panel on its own.
    const trigger = m.buttons()[0] as HTMLButtonElement
    await m.click(trigger)
    expect(document.body.querySelector('.dsm-workbuddy-composer-panel')).not.toBeNull()
  })
})