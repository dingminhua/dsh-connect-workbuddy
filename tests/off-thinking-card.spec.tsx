// @vitest-environment jsdom
/**
 * Issue #34 at the CARD layer: the per-model "offer the off thinking level"
 * checkbox.
 *
 * `tests/off-thinking.spec.ts` locks the rule and `tests/off-thinking-runtime.spec.ts`
 * locks the runtime wiring. Neither covers the control the user actually
 * touches — that the box renders for the right rows, starts from the Host's
 * effective answer, records the opposite answer on click, and reaches the
 * saved `offOverrides`. A checkbox that renders but never writes its value is
 * indistinguishable from a working one in every other test file.
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
    // The Host's own effective answer: `off` survives for glm-5.3 and was
    // withdrawn for the DeepSeek model, which is exactly what the table says.
    offModelIds: ['glm-5.3'],
    offOverrides: {},
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
 * The `offOverrides` map the card POSTed to the Host save route.
 *
 * The Host endpoint is the authoritative writer and runs FIRST, so on a stub
 * that answers it the scope is refreshed from the Host's reply rather than
 * from the card's own merge — asserting on the request body is what actually
 * observes the value the card decided to save.
 */
function savedOffOverrides(calls: { url: string, init: any }[]): Record<string, boolean> | undefined {
  const save = [...calls].reverse().find(call => call.url.includes(SAVE_PATH))
  if (save === undefined) return undefined
  const body = JSON.parse(String(save.init?.body ?? '{}')) as {
    value?: Record<string, { offOverrides?: Record<string, boolean> }>
  }
  return body.value?.cn?.offOverrides
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

describe('issue #34: the off checkbox renders only where a level exists', () => {
  it('offers the control for models that declare reasoning, and not for others', async () => {
    const { m } = await renderCard(usageOf())
    // A model with no declared efforts has no thinking levels at all, so a
    // checkbox there would promise a capability that cannot exist.
    expect(m.container.querySelectorAll('.dsm-workbuddy-model-off')).toHaveLength(2)
    expect(() => offBoxFor(m, 'Plain')).toThrow()
    await m.unmount()
  })

  it('starts from the HOST answer rather than from the raw declaration', async () => {
    // Both rows declare reasoning. The Host withdrew `off` for only one of
    // them, and the card has no way to know that on its own — so a card that
    // defaulted to "checked" (or to the declaration) would silently re-offer
    // the level the whole fix exists to withdraw.
    const { m } = await renderCard(usageOf())
    expect(offBoxFor(m, 'GLM-5.3').checked).toBe(true)
    expect(offBoxFor(m, 'Deepseek').checked).toBe(false)
    await m.unmount()
  })

  it('shows a saved override in place of the Host answer', async () => {
    // The user forced the withdrawn level back on, so the box reflects the
    // override even though `offModelIds` still lists only glm-5.3.
    const { m } = await renderCard(usageOf({ offOverrides: { 'deepseek-v4.1-flash': true } }))
    expect(offBoxFor(m, 'Deepseek').checked).toBe(true)
    await m.unmount()
  })
})

describe('issue #34: clicking the box records an explicit answer and saves it', () => {
  it('writes the override map, in the direction the user actually chose', async () => {
    const { m, calls } = await renderCard(usageOf())
    await m.click(offBoxFor(m, 'Deepseek'))
    expect(offBoxFor(m, 'Deepseek').checked).toBe(true)
    await m.click(m.button('row.save'))
    await m.settle()
    // The saved slot must carry the override, or the click is lost as soon as
    // the card re-reads the Host.
    expect(savedOffOverrides(calls)).toEqual({ 'deepseek-v4.1-flash': true })
    await m.unmount()
  })

  it('can withdraw a level the Host currently offers', async () => {
    // The other direction, and the one that needs no plugin release: a model
    // whose `off` the table has not learned about yet.
    const { m, calls } = await renderCard(usageOf())
    await m.click(offBoxFor(m, 'GLM-5.3'))
    expect(offBoxFor(m, 'GLM-5.3').checked).toBe(false)
    await m.click(m.button('row.save'))
    await m.settle()
    expect(savedOffOverrides(calls)).toEqual({ 'glm-5.3': false })
    await m.unmount()
  })

  it('carries the user\'s earlier answers through a second save', async () => {
    // The save replaces the stored map wholesale, so an answer dropped here
    // would be silently un-decided and the level would come back.
    const { m, calls } = await renderCard(usageOf({ offOverrides: { 'gemini-3.5-flash': false } }))
    await m.click(offBoxFor(m, 'Deepseek'))
    await m.click(m.button('row.save'))
    await m.settle()
    expect(savedOffOverrides(calls)).toEqual({
      'gemini-3.5-flash': false,
      'deepseek-v4.1-flash': true,
    })
    await m.unmount()
  })
})
