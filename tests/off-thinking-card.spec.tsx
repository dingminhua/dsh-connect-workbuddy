// @vitest-environment jsdom
/**
 * Issue #34 at the CARD layer: the per-model "offer the off thinking level"
 * checkbox.
 *
 * `tests/off-thinking.spec.ts` locks the seed rule and
 * `tests/off-thinking-runtime.spec.ts` locks the runtime wiring. Neither covers
 * the control the user actually touches — that the box renders on every row,
 * starts from the Host's saved set, and reaches the `offModelIds` it posts on
 * save. A checkbox that renders but never writes its value is indistinguishable
 * from a working one in every other test file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

const USAGE_PATH = '/plugins/dsh-connect-workbuddy/usage'

/**
 * A signed-in body whose roster separates the three cases that matter:
 * a model the Host offers `off` for, one it withdraws it from, and one that
 * declares no reasoning at all (so the control must not appear).
 */
function usageOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'real-1',
    accountName: 'Real One',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'real-1', accountName: 'Real One' }],
    models: [
      { id: 'glm-5.3', name: 'GLM-5.3', reasoning: { supportedEfforts: ['low', 'high'] } },
      { id: 'deepseek-v4.1-flash', name: 'Deepseek', reasoning: { supportedEfforts: ['low', 'high'] } },
      { id: 'plain-model', name: 'Plain' },
    ],
    enabledModelIds: ['glm-5.3', 'deepseek-v4.1-flash', 'plain-model'],
    imageModelIds: [],
    // The Host's saved set: `off` survives for glm-5.3, withdrawn for Deepseek.
    offModelIds: ['glm-5.3'],
    credits: { total: 20, expiringSoon: 0, packages: [] },
    ...overrides,
  }
}

/** Render the card against one usage body and answer with the scope. */
async function renderCard(usage: Record<string, unknown>, scope = fakeScope({})) {
  const calls = stubFetch(url => (url.includes(USAGE_PATH) ? { body: usage } : { body: {} }))
  const m = await mount(WorkBuddyCard, { t, settingsScope: scope, view: 'page' })
  await m.settle()
  return { m, scope, calls }
}

const SAVE_PATH = '/plugins/dsh-connect-workbuddy/__save'

/**
 * The `offModelIds` the card POSTed to the Host save route.
 *
 * The Host endpoint is the authoritative writer and runs FIRST, so on a stub
 * that answers it the scope is refreshed from the Host's reply rather than from
 * the card's own merge — asserting on the request body is what actually
 * observes the value the card decided to save.
 */
function savedOffModelIds(calls: { url: string, init: any }[]): string[] | undefined {
  const save = [...calls].reverse().find(call => call.url.includes(SAVE_PATH))
  if (save === undefined) return undefined
  const body = JSON.parse(String(save.init?.body ?? '{}')) as {
    value?: Record<string, { offModelIds?: string[] }>
  }
  return body.value?.cn?.offModelIds
}

/** The checkbox for one model, addressed by its row rather than by index. */
function offBoxFor(m: { container: HTMLDivElement }, modelName: string): HTMLInputElement {
  const rows = Array.from(m.container.querySelectorAll('.dsm-workbuddy-model'))
  const row = rows.find(r => (r.querySelector('.dsm-workbuddy-model-name')?.textContent ?? '').includes(modelName))
  if (row === undefined) throw new Error(`no row for ${modelName}; rows: ${rows.length}`)
  const box = row.querySelector<HTMLInputElement>('.dsm-workbuddy-model-off input[type=checkbox]')
  if (box === null) throw new Error(`no off checkbox in the ${modelName} row`)
  return box
}

describe('issue #34: the off checkbox renders on every row, defaulted by the Host', () => {
  it('appears on every model row, including ones with no declared reasoning', async () => {
    // The control is on every row, as the card's other checkboxes are; a model
    // with no declared efforts still gets the box, so the user can tick it.
    const { m } = await renderCard(usageOf())
    expect(m.container.querySelectorAll('.dsm-workbuddy-model-off')).toHaveLength(3)
    expect(offBoxFor(m, 'Plain')).toBeDefined()
    await m.unmount()
  })

  it('starts from the Host saved set rather than from the raw declaration', async () => {
    // Both rows declare reasoning. The Host withdrew `off` for only one of
    // them, and the card has no way to know that on its own — so a card that
    // defaulted to "checked" (or to the declaration) would silently re-offer
    // the level the whole fix exists to withdraw.
    const { m } = await renderCard(usageOf())
    expect(offBoxFor(m, 'GLM-5.3').checked).toBe(true)
    expect(offBoxFor(m, 'Deepseek').checked).toBe(false)
    await m.unmount()
  })

  it('shows a row the Host list includes as checked, whatever the declaration says', async () => {
    // The saved set is the truth at render time: a refused model ticked back
    // on by the user renders as checked.
    const { m } = await renderCard(usageOf({ offModelIds: ['glm-5.3', 'deepseek-v4.1-flash'] }))
    expect(offBoxFor(m, 'Deepseek').checked).toBe(true)
    await m.unmount()
  })
})

describe('issue #34: clicking the box flips one row and saves it', () => {
  it('adds a model to the saved list when ticked', async () => {
    const { m, calls } = await renderCard(usageOf())
    await m.click(offBoxFor(m, 'Deepseek'))
    expect(offBoxFor(m, 'Deepseek').checked).toBe(true)
    await m.click(m.button('row.save'))
    await m.settle()
    expect(savedOffModelIds(calls)).toEqual(['glm-5.3', 'deepseek-v4.1-flash'])
    await m.unmount()
  })

  it('removes a model from the saved list when unticked', async () => {
    const { m, calls } = await renderCard(usageOf())
    await m.click(offBoxFor(m, 'GLM-5.3'))
    expect(offBoxFor(m, 'GLM-5.3').checked).toBe(false)
    await m.click(m.button('row.save'))
    await m.settle()
    expect(savedOffModelIds(calls)).toEqual([])
    await m.unmount()
  })

  it('carries the rest of the list through a second save', async () => {
    // The save replaces the stored list wholesale, so a model dropped here
    // would silently come back.
    const { m, calls } = await renderCard(usageOf({ offModelIds: ['gemini-3.5-flash'] }))
    await m.click(offBoxFor(m, 'Deepseek'))
    await m.click(m.button('row.save'))
    await m.settle()
    expect(savedOffModelIds(calls)).toEqual(['gemini-3.5-flash', 'deepseek-v4.1-flash'])
    await m.unmount()
  })
})
