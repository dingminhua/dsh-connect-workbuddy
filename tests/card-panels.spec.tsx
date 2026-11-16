// @vitest-environment jsdom
/**
 * The card's SECTION TABS (accounts / models / diagnostics).
 *
 * The card grew into one ~3,500 px column carrying two unrelated jobs: running
 * an account and editing the model catalog. They do not even commit the same
 * way — an account change lands on the click, a catalog change is a draft until
 * saved — so the save button sat three screens away from what it saves.
 *
 * What these tests pin, and why each line matters:
 *
 *   DEFAULT    The card opens on the accounts section. A card that opened on a
 *              section the user did not ask for would hide the account state
 *              they came to check.
 *   HIDDEN     An inactive panel leaves the accessibility tree via the `hidden`
 *              attribute, and the ACTIVE one carries `role="tabpanel"`.
 *   MOUNTED    An inactive panel stays in the DOM. This is not an implementation
 *              detail: remounting it would refetch usage and drop a half-filled
 *              catalog draft every time the user glanced at another section.
 *   ARIA       Exactly one tab is `aria-selected`, and each tab points at the
 *              panel it controls.
 *   SIGNED OUT A signed-out card is one screen of instructions; it renders no
 *              tab strip, and nothing may hide that screen behind a tab the user
 *              cannot see.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

const USAGE_PATH = '/plugins/dsh-connect-workbuddy/usage'

/** A signed-in usage body, trimmed to what these tests read. */
function usageOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'real-1',
    accountName: 'Real One',
    region: 'cn',
    domain: 'www.workbuddy.cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'real-1', accountName: 'Real One' }],
    models: [
      { id: 'free-1', name: 'Free One', creditMultiplier: 0 },
      { id: 'paid-1', name: 'Paid One', creditMultiplier: 0.79 },
      // qoder 518ecbb: declares tiers but NO upstream default. The card's
      // "Default (x)" must name the tier the adapter will really dispatch.
      { id: 'no-default-1', name: 'No Default', creditMultiplier: 0, reasoning: { supportedEfforts: ['low', 'high', 'max'] } },
    ],
    enabledModelIds: ['free-1'],
    imageModelIds: [],
    credits: { total: 20, expiringSoon: 0, packages: [] },
    pool: {
      enabled: true,
      checkinSupported: true,
      targetModelSource: 'free',
      targetModelId: 'free-1',
      staleTargetModelId: '',
      memberAccountIds: ['real-1'],
      effectiveMemberAccountIds: ['real-1'],
      accounts: [{
        accountId: 'real-1', accountName: 'Real One', current: true, member: true, checkedInToday: true,
      }],
      catalog: [{ id: 'free-1', name: 'Free One', creditMultiplier: 0 }],
    },
    ...overrides,
  }
}

async function mountCard(body: Record<string, unknown> = usageOf()) {
  stubFetch(url => (url.startsWith(USAGE_PATH) ? { body } : { body: {} }))
  const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope(), view: 'page' })
  await m.settle()
  return m
}

/**
 * Find one model's reasoning picker, by the model's NAME.
 *
 * The card labels the select with the model's name (never its id), so the
 * lookup matches that. `t` renders `key|param=value`, which makes the
 * assertion name the exact message the component chose.
 */
const effortPicker = (m: Awaited<ReturnType<typeof mountCard>>, name: string): HTMLSelectElement => {
  const found = Array.from(m.container.querySelectorAll<HTMLSelectElement>('.dsm-workbuddy-model-effort-select'))
    .find(element => element.getAttribute('aria-label') === `row.modelEffortAria|model=${name}`)
  if (found === undefined) throw new Error(`no effort picker for ${name}`)
  return found
}

const panel = (m: Awaited<ReturnType<typeof mountCard>>, id: string): HTMLElement => {
  const found = Array.from(m.container.querySelectorAll<HTMLElement>('.dsm-workbuddy-panel'))
    .find(element => element.id === `dsm-workbuddy-panel-${id}`)
  if (found === undefined) throw new Error(`no panel dsm-workbuddy-panel-${id}`)
  return found
}

const tab = (m: Awaited<ReturnType<typeof mountCard>>, id: string): HTMLButtonElement => {
  const found = Array.from(m.container.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-panels [role="tab"]'))
    .find(element => element.id === `dsm-workbuddy-tab-${id}`)
  if (found === undefined) throw new Error(`no tab dsm-workbuddy-tab-${id}`)
  return found
}

describe('the card splits into three sections', () => {
  it('opens on accounts, with the other two panels hidden', async () => {
    const m = await mountCard()
    expect(panel(m, 'accounts').hidden).toBe(false)
    expect(panel(m, 'models').hidden).toBe(true)
    expect(panel(m, 'diag').hidden).toBe(true)
    await m.unmount()
  })

  it('shows the models section when its tab is clicked, and hides accounts', async () => {
    const m = await mountCard()
    await m.click(tab(m, 'models'))
    expect(panel(m, 'models').hidden).toBe(false)
    expect(panel(m, 'accounts').hidden).toBe(true)
    // The panel is the real section, not a summary of it.
    expect(panel(m, 'models').textContent).toContain('row.modelsTitle')
    await m.unmount()
  })

  it('shows the diagnostics facts when its tab is clicked', async () => {
    const m = await mountCard()
    await m.click(tab(m, 'diag'))
    const text = panel(m, 'diag').textContent ?? ''
    expect(text).toContain('row.diagRegion')
    expect(text).toContain('row.tabCn')
    expect(text).toContain('www.workbuddy.cn')
    // The serving account, by NAME — the diagnostics panel must not print an id
    // where a name belongs.
    expect(text).toContain('Real One')
    expect(text).not.toContain('real-1')
    expect(text).toContain('row.diagCatalog')
    expect(text).toContain('row.diagNoFailures')
    await m.unmount()
  })

  it('keeps the inactive panels mounted, so a draft survives the trip', async () => {
    const m = await mountCard()
    // Present in the DOM while hidden: remounting would refetch usage and drop
    // unsaved catalog edits.
    expect(panel(m, 'models').querySelector('.dsm-workbuddy-model-list')).not.toBeNull()
    await m.click(tab(m, 'models'))
    expect(panel(m, 'models').querySelector('.dsm-workbuddy-model-list')).not.toBeNull()
    await m.unmount()
  })

  it('marks exactly one tab selected and points each tab at its panel', async () => {
    const m = await mountCard()
    const selected = (): HTMLButtonElement[] =>
      Array.from(m.container.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-panels [role="tab"][aria-selected="true"]'))

    expect(selected().map(button => button.id)).toEqual(['dsm-workbuddy-tab-accounts'])
    expect(tab(m, 'accounts').getAttribute('aria-controls')).toBe('dsm-workbuddy-panel-accounts')

    await m.click(tab(m, 'diag'))
    expect(selected().map(button => button.id)).toEqual(['dsm-workbuddy-tab-diag'])
    expect(tab(m, 'diag').getAttribute('aria-controls')).toBe('dsm-workbuddy-panel-diag')

    // Every panel names the tab that labels it.
    for (const id of ['accounts', 'models', 'diag']) {
      expect(panel(m, id).getAttribute('aria-labelledby')).toBe(`dsm-workbuddy-tab-${id}`)
    }
    await m.unmount()
  })

  it('renders no section tabs while signed out, and hides nothing', async () => {
    const m = await mountCard({
      status: 'signed-out',
      accounts: [],
      selectionExplicit: false,
      searched: [],
    })
    expect(m.container.querySelector('#dsm-workbuddy-tab-accounts')).toBeNull()
    // The one screen of instructions stays visible: `hidden` is never applied
    // without the tabs that could undo it.
    expect(panel(m, 'accounts').hidden).toBe(false)
    await m.unmount()
  })

  // qoder 518ecbb's third seam: the card's "Default (x)" label must name the
  // tier the runtime will ACTUALLY dispatch when the first option is picked,
  // not just the upstream declaration. For a model that declares `low/high/max`
  // and NO default, the old card showed a bare "Default" while the adapter
  // silently used `low` (its weakest tier).
  it('names the resolved middle tier as the default when upstream declares none', async () => {
    const m = await mountCard()
    const select = effortPicker(m, 'No Default')
    const options = Array.from(select.querySelectorAll('option'))
    // The first option is the "follow" answer; it must carry the resolved tier
    // (`high`), which is the same answer `defaultEffortFor` gives the adapter.
    expect(options[0]?.textContent).toBe('row.modelEffortFollowNamed|effort=high')
    expect(options.map(option => option.value)).toEqual(['', 'low', 'high', 'max'])
    await m.unmount()
  })

  it('describes the follow option, not the saved choice, when one is picked', async () => {
    const m = await mountCard({
      // A real saved choice for the SAME model, layered over the full fixture.
      // The first option must still describe what happens if the user clears it
      // (the middle tier `high`), not echo the saved `low` — otherwise the row
      // would read "Default (low)" with a separate `low` option beside it.
      ...usageOf(),
      defaultThinkingEfforts: { 'no-default-1': 'low' },
    })
    const select = effortPicker(m, 'No Default')
    expect(select.value).toBe('low')
    expect(select.querySelector('option')?.textContent).toBe('row.modelEffortFollowNamed|effort=high')
    await m.unmount()
  })
})

/**
 * ISSUE #263 — the accounts section says when credits are about to lapse.
 *
 * The reporter pointed at dsh-connect-trae's amber banner
 * 「有 143 积分将在 3 天内过期 / 最早到期：2026/11/19 08:05」 and asked for the same
 * in workbuddy. The pool table already prints the amount per member row, but a
 * non-member has no row there and the pool can be switched off, so this banner
 * is the only place the fact exists for EVERY account in the region — which is
 * also why it is the one place a printed DATE is allowed (per-row warnings stay
 * amount-only by the 5.20.22 decision).
 */
describe('issue #263: the accounts section warns about expiring credits', () => {
  /** The banner, when the card renders one. */
  const bannerOf = (): Element | null =>
    document.body.querySelector('.dsm-workbuddy-expiry')

  it('states the total lapsing and the earliest instant', async () => {
    const m = await mountCard(usageOf({
      credits: {
        total: 1875,
        expiringSoon: 143,
        nearestExpiryMs: Date.UTC(2026, 10, 19, 0, 5),
        packages: [],
      },
    }))
    const banner = bannerOf()
    expect(banner, 'a lapsing balance must be announced').not.toBeNull()
    expect(banner?.getAttribute('role'), 'it is a status, not an alert').toBe('status')
    // The banner NAMES the account: `credits` is the selected account's answer,
    // not a pool total, and an unlabelled figure above a multi-account table
    // would be read as the table's sum.
    expect(banner?.querySelector('strong')?.textContent)
      .toBe('row.creditExpirySoon|accountName=Real One|count=143')
    // The instant, formatted the way the rest of the card formats one: 24-hour,
    // and 2026-11-19 00:05 UTC is 08:05 in Asia/Shanghai.
    expect(banner?.querySelector('.dsm-workbuddy-expiry-detail')?.textContent)
      .toMatch(/row\.creditExpiryEarliest\|time=11\/19, 08:05/)
    await m.unmount()
  })

  it('renders NOTHING when no credits are lapsing', async () => {
    // The regression this pins: `nearestExpiryMs` is the nearest expiry across
    // ALL packages, so it is present on an account with nothing lapsing. A
    // banner keyed off the date would announce an expiry that costs the user
    // nothing — worse than silence, because it would read as a warning.
    const m = await mountCard(usageOf({
      credits: {
        total: 1875,
        expiringSoon: 0,
        nearestExpiryMs: Date.UTC(2027, 0, 1),
        packages: [],
      },
    }))
    expect(bannerOf()).toBeNull()
    await m.unmount()
  })

  it('renders NOTHING when the balance could not be read', async () => {
    // `credits` absent means "not measured", and an unmeasured region must not
    // claim its credits are safe. `creditsError` already carries the failure.
    const m = await mountCard(usageOf({
      credits: undefined,
      creditsError: 'upstream down',
    }))
    expect(bannerOf()).toBeNull()
    await m.unmount()
  })
})
