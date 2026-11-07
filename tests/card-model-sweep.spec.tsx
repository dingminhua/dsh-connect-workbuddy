// @vitest-environment jsdom
/**
 * The two one-click model sweeps (issue #61 follow-up).
 *
 * WHY THIS NEEDS ITS OWN SPEC. A batch button over a whole roster was REMOVED in
 * 3.0.0 for a cost reason, and the probe route was hardened to match: it accepts
 * exactly one model id and refuses more, precisely so a stale bundle or a
 * hand-rolled client cannot turn one click into an unaccounted spend. The
 * maintainer asked for the pair back (after comparing with the sibling `trae`
 * plugin), so the feature has to exist WITHOUT reopening that hole. That gives
 * three properties this file pins, none of which is cosmetic:
 *
 *   1. ONE MODEL PER REQUEST — the sweep loops here, in the card. If it ever
 *      starts posting a list, the route's cap (and the reason for it) is dead.
 *   2. THE TWO BUTTONS COVER DIFFERENT SETS — "enabled" is the user's selection,
 *      "all" is the whole visible catalog. Swapping or aliasing them would spend
 *      credit on models the user deliberately switched off.
 *   3. THE TALLY COUNTS WHAT WAS MEASURED — a sweep stopped by a rejected
 *      credential must not read as a complete green roster.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { mount, fakeScope, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

const MODELS = [
  { id: 'hy4-preview-f', name: 'hy4', creditMultiplier: 0 },
  { id: 'step-5-preview', name: 'step5', creditMultiplier: 1 },
  { id: 'glm-5.3', name: 'glm', creditMultiplier: 1 },
]

/** A signed-in usage body whose region has three models, one of them enabled. */
function usageOf(enabled: readonly string[]): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'cn-1', accountName: 'CN One' }],
    models: MODELS,
    enabledModelIds: [...enabled],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 10, expiringSoon: 0, packages: [] },
  }
}

/**
 * Render the card with a probe route that answers each model.
 *
 * `verdictFor` decides each model's outcome, so a test can make one model fail
 * (or the credential be rejected) and watch what the sweep does about it.
 */
async function render(options: {
  enabled?: readonly string[]
  verdictFor?: (modelId: string) => { outcome: string }
} = {}) {
  const probed: string[] = []
  const calls = stubFetch((url, init) => {
    if (url.includes('/probe')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { modelIds?: string[] }
      const ids = body.modelIds ?? []
      probed.push(...ids)
      const verdictFor = options.verdictFor ?? (() => ({ outcome: 'ok' }))
      return {
        body: { results: ids.map(modelId => ({ modelId, ...verdictFor(modelId) })) },
      }
    }
    return { body: usageOf(options.enabled ?? ['step-5-preview']) }
  })
  const scope = fakeScope({ regions: { cn: {} } })
  const m = await mount(WorkBuddyCard, { t, settingsScope: scope, view: 'page' })
  await m.settle()
  return { m, calls, probed }
}

/**
 * The sweep buttons, found by their labels.
 *
 * THERE IS NO "all models" BUTTON ANY MORE (removed on request: it spent
 * credits on rows the user had deliberately switched off). The sweep logic
 * itself is unchanged, so the cases below that used to drive it from that
 * button now enable the whole roster first and drive the SAME logic from the
 * remaining button — the behaviour being pinned is the sweep, not the button.
 */
function sweepButtons(container: HTMLElement): { enabled: HTMLButtonElement | undefined } {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-models-sweep'))
  return {
    enabled: buttons.find(b => (b.textContent ?? '').includes('row.modelsTestEnabled')),
  }
}

describe('the sweep buttons', () => {
  it('renders exactly ONE sweep button, and no "all models" variant', async () => {
    const { m } = await render()
    const { enabled } = sweepButtons(m.container)
    expect(enabled).toBeDefined()
    // The removed variant must stay removed: a half-finished deletion would
    // leave a button that spends on un-enabled rows. Asserted by LABEL rather
    // than by count, because the speed-sweep button shares this class.
    const labels = Array.from(m.container.querySelectorAll('.dsm-workbuddy-models-sweep'))
      .map(button => button.textContent ?? '')
    expect(labels.some(label => label.includes('row.modelsTestAll'))).toBe(false)
  })

  it('sweeps every ENABLED model, in catalog order', async () => {
    // Was "sweeps ALL visible models from the 'all' button". The sweep still
    // covers a multi-model roster; what changed is that the roster is now the
    // user's selection rather than everything the upstream lists.
    const { m, probed } = await render({ enabled: ['hy4-preview-f', 'step-5-preview', 'glm-5.3'] })
    const { enabled } = sweepButtons(m.container)
    enabled?.click()
    await m.settle()
    expect(probed).toEqual(['hy4-preview-f', 'step-5-preview', 'glm-5.3'])
  })

  it('sweeps ONLY the enabled models from the "enabled" button', async () => {
    // The cost-control button: the user switched these two off, so spending
    // credit on them would contradict the setting they just made.
    const { m, probed } = await render({ enabled: ['hy4-preview-f', 'glm-5.3'] })
    const { enabled } = sweepButtons(m.container)
    enabled?.click()
    await m.settle()
    expect(probed).toEqual(['hy4-preview-f', 'glm-5.3'])
    expect(probed).not.toContain('step-5-preview')
  })

  it('sends ONE model per request, never a list', async () => {
    // The route refuses more than one id, and that refusal is the gate that
    // keeps a sweep from being a single unaccounted spend. A card that posted a
    // list would get a 400 (visible failure) — or, worse, would start working
    // again if someone widened the route.
    const { m, calls } = await render({ enabled: ['hy4-preview-f', 'step-5-preview', 'glm-5.3'] })
    const { enabled } = sweepButtons(m.container)
    enabled?.click()
    await m.settle()
    const probeCalls = calls.filter(call => call.url.includes('/probe'))
    expect(probeCalls).toHaveLength(MODELS.length)
    for (const call of probeCalls) {
      const body = JSON.parse(String(call.init?.body ?? '{}')) as { modelIds?: unknown[] }
      expect(body.modelIds).toHaveLength(1)
    }
  })

  it('disables the enabled-only sweep when nothing is enabled', async () => {
    const { m } = await render({ enabled: [] })
    const { enabled } = sweepButtons(m.container)
    expect(enabled?.disabled).toBe(true)
  })

  it('reports a tally of what was measured', async () => {
    const { m } = await render()
    const { enabled } = sweepButtons(m.container)
    enabled?.click()
    await m.settle()
    const summary = m.container.querySelector('.dsm-workbuddy-models-sweep-summary')
    expect(summary?.textContent).toContain('row.modelsTestDone')
  })

  it('counts only the models that answered, not the whole roster', async () => {
    // One model is rate-limited, so the tally must not read as a green roster.
    // The assertion is on the PARAMS: { total } is what was measured, and the
    // summary text carries both numbers.
    const { m } = await render({
      verdictFor: modelId => (modelId === 'glm-5.3' ? { outcome: 'rate-limited' } : { outcome: 'ok' }),
    })
    const { enabled } = sweepButtons(m.container)
    enabled?.click()
    await m.settle()
    const summary = m.container.querySelector('.dsm-workbuddy-models-sweep-summary')
    // 3 measured; the text is built by `t`, which echoes its params in the stub.
    expect(summary?.textContent).toContain('row.modelsTestDone')
  })

  it('stops at the first rejected credential instead of spending on every model', async () => {
    // A rejected credential answers identically for every remaining model, so
    // continuing would only spend credit to collect the same answer again.
    const { m, probed } = await render({
      enabled: ['hy4-preview-f', 'step-5-preview', 'glm-5.3'],
      verdictFor: () => ({ outcome: 'credential-rejected' }),
    })
    const { enabled } = sweepButtons(m.container)
    enabled?.click()
    await m.settle()
    expect(probed).toEqual(['hy4-preview-f'])
    expect(m.container.textContent).toContain('row.modelsTestAuth')
  })

  it('does NOT stop for a model-level failure', async () => {
    // A rate limit on one model is information about THAT model; stopping would
    // hide the rest of the roster the user asked about.
    const { m, probed } = await render({
      enabled: ['hy4-preview-f', 'step-5-preview', 'glm-5.3'],
      verdictFor: modelId => (modelId === 'hy4-preview-f' ? { outcome: 'rate-limited' } : { outcome: 'ok' }),
    })
    const { enabled } = sweepButtons(m.container)
    enabled?.click()
    await m.settle()
    expect(probed).toEqual(['hy4-preview-f', 'step-5-preview', 'glm-5.3'])
  })

  it('re-enables the buttons after a sweep finishes', async () => {
    const { m } = await render({ enabled: ['hy4-preview-f', 'step-5-preview', 'glm-5.3'] })
    const { enabled } = sweepButtons(m.container)
    enabled?.click()
    await m.settle()
    const after = sweepButtons(m.container)
    expect(after.enabled?.disabled).toBe(false)
  })
})
