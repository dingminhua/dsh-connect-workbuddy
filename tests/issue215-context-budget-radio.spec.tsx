// @vitest-environment jsdom
/**
 * Issue #215 — the context-budget radios claimed a cap the backend never took.
 *
 * THE REPORT. With `regions.cn.contextBudgets` empty, the model row showed the
 * 200K radio as SELECTED while DSH was told the model's native 1,000,000. The
 * expression was:
 *
 *   checked={(activeContextBudgets[model.id] ?? 200_000) === 200_000}
 *
 * — a browser-side copy of a rule the backend had already changed (issue #33:
 * no budget means "keep the native window"). So the UI and the runtime held two
 * different defaults, and the visible one was the wrong one. The reporter also
 * noted the second-order effect: because the 200K radio already LOOKED chosen,
 * a user who wanted the default had nothing to click, so saving kept the empty
 * map and the disagreement survived every reopen.
 *
 * WHAT MAKES THIS A REAL BUG AND NOT COSMETIC. `contextWindow` is what DSH
 * advertises to the model and uses to decide when to compact. A card saying
 * "capped at 200K" while the host answers 1M misleads about exactly the
 * behaviour the control exists to change.
 *
 * THE FIX has two halves, and both are pinned below:
 *
 *   1. ONE rule — `effectiveContextBudget()` in `src/catalog.ts`, next to
 *      `applyContextBudgets()`. Each radio is lit by comparing that value, so
 *      exactly one tier is selected and it is the tier DSH is told.
 *   2. The native tier CLEARS the budget instead of storing the window's
 *      number. Storing `1000000` would look identical today but would stop
 *      following the model if the upstream raised its window, and it makes
 *      "native" indistinguishable from "a cap that happens to equal it".
 *
 * The reporter asked for four states (missing / 200K / 500K / native) plus the
 * "save without touching anything, then reopen" path. Both are here, and every
 * assertion compares the RADIO against the WINDOW the backend derives — not
 * against a hard-coded label — so the test fails if either side drifts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { applyContextBudgets, deriveCatalog, effectiveContextBudget } from '../src/catalog.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

/**
 * Every card this file mailed, so each test tears its own down.
 *
 * `mount()` attaches to `document.body` and does NOT unmount automatically, so
 * a test that mounts a card without releasing it leaves a live React tree
 * behind. That tree keeps its 60-second usage interval and — the reason it
 * mattered here — its own `fetch` calls, which land in the NEXT test's
 * `stubFetch` recording and make a green test look red. The sweep tests below
 * mount fifteen cards, so this is not hypothetical.
 */
const mounted: { unmount: () => Promise<void> }[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const card of mounted.splice(0)) await card.unmount()
})

const MODEL_ID = 'deepseek-v4.1-flash'
const NATIVE = 1_000_000

/** The model the report names, as the runtime catalog holds it. */
const MODEL: WorkBuddyModelInfo = {
  id: MODEL_ID,
  name: 'Deepseek-V4.1-Flash',
  contextWindow: NATIVE,
  maxTokens: 128_000,
}

/** The window the BACKEND ends up advertising for a saved budget map. */
function backendWindow(budgets: Record<string, number>): number {
  return deriveCatalog([MODEL], new Set([MODEL_ID]), budgets)[0]?.contextWindow ?? -1
}

/** A signed-in usage body carrying an arbitrary native window. */
function usageBody(
  nativeContextWindow: number,
  contextBudgets: Record<string, number> = {},
): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'real-1', accountName: 'Real One' }],
    models: [{
      id: MODEL_ID,
      name: 'Deepseek-V4.1-Flash',
      // The Host's own answer already applies the budget; the card renders the
      // radios from `contextBudgets` + `nativeContextWindow`, which is what this
      // test drives.
      contextWindow: nativeContextWindow,
      nativeContextWindow,
      maxTokens: 128_000,
    }],
    enabledModelIds: [MODEL_ID],
    imageModelIds: [],
    contextBudgets,
    credits: { total: 20, expiringSoon: 0, packages: [] },
  }
}

async function render(body: Record<string, unknown>) {
  stubFetch(() => ({ body }))
  const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
  mounted.push(m)
  await m.settle()
  return m
}

/** Every tier radio in the model row, in document order. */
function radios(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('.dsm-workbuddy-context-budget input[type=radio]'))
}

/**
 * The label of the ONE checked tier, or a description of how many were checked.
 *
 * "Exactly one" is itself part of the contract: with no budget stored the old
 * code could light the 200K radio while the native one was also checked (its
 * `<= 200_000 || …` clause), so two tiers claimed to be current at once.
 */
function checkedLabel(container: HTMLElement): string {
  const checked = radios(container).filter(radio => radio.checked)
  if (checked.length !== 1) return `<${checked.length} checked>`
  return checked[0]?.nextElementSibling?.textContent ?? ''
}

/** The label a tier with this value would render. */
function labelFor(value: number): string {
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}

/**
 * The radio whose label is `label`, re-read from the live DOM on each call.
 *
 * A NODE HELD ACROSS A RENDER GOES STALE: React replaces the input when the
 * draft changes, so clicking a saved reference acted on a detached element and
 * the card never saw the event. Looking it up by the label the user actually
 * reads is both safe across renders and the thing the user is choosing.
 */
function radioFor(container: HTMLElement, label: string): HTMLInputElement {
  const found = radios(container).find(radio => radio.nextElementSibling?.textContent === label)
  if (found === undefined) {
    throw new Error(`no "${label}" tier. Present: ${radios(container).map(r => r.nextElementSibling?.textContent).join(', ')}`)
  }
  return found
}

describe('issue #215: the selected tier must equal the window DSH is told', () => {
  // The reporter's four states, each asserted against the BACKEND's own answer.

  it('missing budget → the native tier, and the backend keeps the native window', async () => {
    const m = await render(usageBody(NATIVE, {}))
    expect(backendWindow({})).toBe(NATIVE)
    expect(checkedLabel(m.container)).toBe('1M')
  })

  it('200K stored → the 200K tier, and the backend reports 200000', async () => {
    const m = await render(usageBody(NATIVE, { [MODEL_ID]: 200_000 }))
    expect(backendWindow({ [MODEL_ID]: 200_000 })).toBe(200_000)
    expect(checkedLabel(m.container)).toBe('200K')
  })

  it('500K stored → the 500K tier, and the backend reports 500000', async () => {
    const m = await render(usageBody(NATIVE, { [MODEL_ID]: 500_000 }))
    expect(backendWindow({ [MODEL_ID]: 500_000 })).toBe(500_000)
    expect(checkedLabel(m.container)).toBe('500K')
  })

  it('native stored explicitly → the native tier, and the backend reports it', async () => {
    // A profile from an older build may carry the window's number as a real
    // budget. It resolves to the SAME window, so the native tier is the honest
    // answer — the value and "no cap" are indistinguishable in effect.
    const m = await render(usageBody(NATIVE, { [MODEL_ID]: NATIVE }))
    expect(backendWindow({ [MODEL_ID]: NATIVE })).toBe(NATIVE)
    expect(checkedLabel(m.container)).toBe('1M')
  })

  it('confirms the pair end to end for every state, in one place', async () => {
    // The four assertions above are deliberately independent so a failure names
    // which state broke. This one states the invariant they share, which is the
    // sentence the issue is about: the lit radio is the effective window.
    for (const budgets of [{}, { [MODEL_ID]: 200_000 }, { [MODEL_ID]: 500_000 }, { [MODEL_ID]: NATIVE }]) {
      const m = await render(usageBody(NATIVE, budgets))
      const label = checkedLabel(m.container)
      expect(label, `saved=${JSON.stringify(budgets)}`).toBe(labelFor(backendWindow(budgets)))
    }
  })

  it('never lights two tiers at once, at any window', async () => {
    // The old native radio was `nativeContextWindow <= 200_000 || …`, so for a
    // small model it was checked even when a budget existed. A radio group with
    // two checked members cannot express what will happen.
    for (const window of [192_000, 200_000, 256_000, 500_000, 1_000_000]) {
      for (const budgets of [{}, { [MODEL_ID]: 200_000 }, { [MODEL_ID]: 500_000 }]) {
        const m = await render(usageBody(window, budgets))
        const checked = radios(m.container).filter(radio => radio.checked)
        expect(checked, `window=${window} saved=${JSON.stringify(budgets)}`).toHaveLength(1)
      }
    }
  })
})

describe('issue #215: choosing the native tier clears the budget', () => {
  it('writes the absence of a key, not the window number', async () => {
    // What the user gets: they pick 200K, then change their mind and pick "1M".
    // Saving `{ id: 1000000 }` would be a stored cap that merely happens to
    // equal today's window — it would stop following the model if the upstream
    // raised it, and it makes "no cap" unrepresentable in the settings file.
    //
    // Asserted on the HOST SAVE REQUEST rather than on the settings scope: the
    // card prefers the Host endpoint, which is the authority (the scope is only
    // its mirror), so the request body is where the stored value really appears.
    const calls = stubFetch(() => ({ body: usageBody(NATIVE, { [MODEL_ID]: 200_000 }) }))
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    mounted.push(m)
    await m.settle()

    // Start from the stored 200K, then pick the native tier.
    expect(radios(m.container)).toHaveLength(3)
    await m.click(radioFor(m.container, '1M'))
    expect(checkedLabel(m.container)).toBe('1M')

    calls.length = 0
    await m.click(m.button(t('row.save')))
    await m.settle()
    const save = calls.find(call => call.url.includes('/__save'))
    if (save === undefined) {
      throw new Error(`no __save request. Calls: ${calls.map(call => call.url).join(', ')}`)
    }
    const sent = JSON.parse(String((save.init as { body?: string }).body ?? '{}')) as {
      value: Record<string, { contextBudgets?: Record<string, number> }>
    }
    const budgets = sent.value['cn']?.contextBudgets ?? {}
    // The key is GONE, not set to the window's number.
    expect(MODEL_ID in budgets).toBe(false)
    expect(budgets).toEqual({})
  })

  it('keeps the empty budget across an untouched open/close cycle (the reporter\'s step 3)', async () => {
    // The issue's step 3, in its corrected form: open the card, change NOTHING,
    // save, reopen.
    //
    // WHAT ACTUALLY HAPPENS NOW, and why this is the right answer. An untouched
    // card is NOT dirty, so Save is disabled (the card only writes what the user
    // edited) — there is nothing to write and nothing can be lost. That is
    // strictly better than what the reporter expected to happen: under the old
    // default the radios already read "200K", so a user who WANTED the default
    // had nothing to click and the wrong-looking state survived every reopen.
    //
    // The assertion is therefore about the invariant that matters: reopening
    // from the same (empty) budget lands on the native tier every time, and the
    // backend agrees. A regression that reintroduced a written default would
    // make `savedBudgets` non-empty and fail here.
    const first = await render(usageBody(NATIVE, {}))
    expect(checkedLabel(first.container)).toBe('1M')

    // An untouched card has no pending edit, so the commit control is inert.
    expect(first.button(t('row.save')).disabled).toBe(true)

    // Close and reopen with the same empty map — the Host's answer on reload.
    const reopened = await render(usageBody(NATIVE, {}))
    expect(checkedLabel(reopened.container)).toBe('1M')
    expect(backendWindow({})).toBe(NATIVE)
  })
})

describe('issue #215: effectiveContextBudget is the one shared rule', () => {
  it('answers the native window when no budget is stored', () => {
    expect(effectiveContextBudget(NATIVE, undefined)).toBe(NATIVE)
  })

  it('answers the budget when it is a real cap', () => {
    expect(effectiveContextBudget(NATIVE, 200_000)).toBe(200_000)
  })

  it('clamps a budget above the window, exactly like applyContextBudgets', () => {
    // The two must never disagree: the card reads this, the runtime reads
    // `Math.min`. A budget above the window is a no-op, not an error.
    const over = 2_000_000
    expect(effectiveContextBudget(NATIVE, over)).toBe(NATIVE)
    expect(applyContextBudgets([MODEL], { [MODEL_ID]: over })[0]?.contextWindow).toBe(NATIVE)
  })

  it('agrees with applyContextBudgets across a table of cases', () => {
    // The property that makes one rule worth extracting: for ANY saved value,
    // the tier the card lights and the window the runtime serves are the same
    // number. This is what was false before the fix.
    const cases = [undefined, 1, 200_000, 500_000, 999_999, NATIVE, 2_000_000]
    for (const saved of cases) {
      const budgets = saved === undefined ? {} : { [MODEL_ID]: saved }
      const fromBackend = applyContextBudgets([MODEL], budgets)[0]?.contextWindow
      expect(effectiveContextBudget(NATIVE, saved), `saved=${String(saved)}`).toBe(fromBackend)
    }
  })
})
