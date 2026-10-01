// @vitest-environment jsdom
/**
 * WorkBuddyCard integration tests — the WIRING layer AccountPool's own tests
 * cannot reach.
 *
 * `tests/pool-render.spec.tsx` mounts `AccountPool` directly and pins the
 * three-state `onSaved` CONTRACT. But the card is what IMPLEMENTS that
 * contract, and the implementations that the round-4 verifier found had no
 * behavioural coverage live here:
 *
 *   POLARITY  `refreshUsage`'s latest-wins probe reports STALE. Writing
 *        `if (!fresh()) return undefined` inverts it, so every response that
 *        is NOT superseded — i.e. every response when only one fetch is in
 *        flight — is discarded and the card renders its placeholder forever.
 *        This SHIPPED once, and the source-text guard in
 *        `tests/pool-e2e.spec.ts` enforced the inverted spelling. The rendered
 *        assertion below is what makes the polarity un-regressable.
 *   M15  `refreshUsage`'s catch returns `{}` instead of `undefined`, so a
 *        FAILED re-read resolves truthy and the pool section discards the
 *        draft against a stale prop — the exact A-8/N1 defect, restored.
 *   M18  `onRefresh={() => {}}` — the pool goes stale after every batch.
 *   M19  `const fresh = () => usageGuard.current.begin(region)()` — a wrapper
 *        that re-claims a generation on every call, so the probe is always
 *        superseded and the card applies NO usage at all, ever.
 *
 * Each test names the mutant it kills. A survivor here is a user-visible
 * defect, not a guard gap.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { fakeScope, mount, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

const USAGE_PATH = '/plugins/dsh-connect-workbuddy/usage'

/** A signed-in usage body with an account pool the card will render. */
function usageOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'real-1',
    accountName: 'Real One',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'real-1', accountName: 'Real One' }],
    models: [{ id: 'free-1', name: 'Free One', creditMultiplier: 0 }],
    enabledModelIds: ['free-1'],
    imageModelIds: [],
    credits: {
      total: 20,
      expiringSoon: 0,
      packages: [{
        packageName: 'Monthly', remain: 12.5, size: 20, monthly: true,
      }],
    },
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

interface FetchCall { url: string, init: any }

/**
 * A fetch stub with per-route answers, recording the order of calls so a test
 * can count usage re-reads without depending on the response payloads.
 *
 * Patterns are matched IN ORDER and are plain substrings; `'*'` is the
 * catch-all and must be listed LAST. It is NOT a glob — `includes('*')` is
 * false for every real URL, so a routes table whose only entry is `'*'` would
 * silently answer `{}` for everything and hand the card an empty usage body
 * (which throws on `status.accounts.length`, not on the assertion under test).
 */
function routeFetch(
  routes: Array<[string, () => { status?: number, body: unknown }]>,
): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
    const href = String(url)
    calls.push({ url: href, init })
    const route = routes.find(([pattern]) => pattern === '*' || href.includes(pattern))
    const result = route === undefined ? { body: {} } : route[1]()
    const status = result.status ?? 200
    return { ok: status < 400, status, json: async () => result.body }
  }))
  return calls
}

const usageCalls = (calls: FetchCall[]): FetchCall[] => calls.filter(call => call.url.startsWith(USAGE_PATH))
const poolCalls = (calls: FetchCall[]): FetchCall[] => calls.filter(call => call.url.includes('/pool'))

describe('the card renders what it fetched (polarity)', () => {
  it('applies a NON-superseded usage snapshot — the guard must not discard it', async () => {
    // The regression this pins: `begin()` reports STALE (see `createLatestWins`
    // in `src/account-pool.ts`; `tests/account-pool.spec.ts` asserts
    // `first()` is `true` only after a NEWER call begins). Writing
    // `if (!fresh()) return undefined` against that probe bails out on the
    // FIRST, un-superseded, perfectly-good response, so no snapshot is ever
    // applied. Nothing else in the suite catches it: the source guard counted
    // the guard occurrences and pinned the inverted spelling verbatim.
    const calls = routeFetch([['*', () => ({ body: usageOf() })]])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()
    // The fetch DID happen — so a blank card cannot be blamed on the stub.
    expect(usageCalls(calls).length).toBeGreaterThanOrEqual(2)
    // The signed-in BODY renders only from an APPLIED snapshot. The model section
    // is the marker: it lives inside the signed-in branch and always renders there,
    // so a dropped or superseded snapshot leaves it out. (The marker has moved twice
    // as this card shed single-account-era chrome — first the status line, then the
    // credits panel — which is exactly why it is now a structural element rather
    // than a piece of copy.)
    expect(m.text()).toContain('row.modelsTitle')
    expect(m.text()).not.toContain('row.signedOut')
    expect(m.text()).not.toContain('row.requestFailed')
    await m.unmount()
  })

  it('does not depend on which of the two region fetches resolves last', async () => {
    // Both regions are fetched on open. A guard keyed globally (or re-claimed
    // per call) would make one region cancel the other and leave a tab blank.
    // The CN answer is deliberately the SLOW one, so it settles last; a
    // "last response wins" rule would still have to apply it.
    const settled: string[] = []
    const calls = routeFetch([
      ['region=cn', () => ({ body: usageOf() })],
      ['region=global', () => ({ body: usageOf({ accountName: 'Global One' }) })],
      ['*', () => ({ body: {} })],
    ])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()
    for (const call of calls) settled.push(call.url)
    expect(settled.length).toBeGreaterThanOrEqual(2)
    expect(m.text()).toContain('row.modelsTitle')
    expect(m.text()).toContain('Real One')
    await m.unmount()
  })
})

describe('the card implements the pool contract it hands down (M15, M18, M19)', () => {
  it('applies the usage snapshot it fetched (M19: a wrapper around the guard drops every answer)', async () => {
    // The card fetches BOTH regions on open (that is the fix for the tab-dot
    // staleness). With M19 the guard's closure is re-claimed, the probe is
    // always superseded, and NEITHER region's snapshot is ever applied: the
    // card renders as if no usage had arrived at all.
    const calls = routeFetch([['*', () => ({ body: usageOf() })]])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()
    expect(usageCalls(calls).length).toBeGreaterThanOrEqual(2)
    expect(m.text()).toContain('row.modelsTitle')
    expect(m.text()).toContain('Real One')
    expect(m.text()).not.toContain('row.requestFailed')
    await m.unmount()
  })

  it('does NOT discard the pool draft when the usage re-read FAILS (M15)', async () => {
    // Open with a healthy usage, then make the NEXT usage read fail — exactly
    // what happens when the user saves while the Host is unreachable.
    let usageOk = true
    const calls = routeFetch([
      [USAGE_PATH, () => (usageOk ? { body: usageOf() } : { status: 500, body: { error: 'boom' } })],
      ['*', () => ({ body: {} })],
    ])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()
    expect(calls.length).toBeGreaterThan(0)
    expect(m.text()).toContain('row.modelsTitle')
    // Edit the pool membership so the draft is dirty.
    const box = m.container.querySelector<HTMLInputElement>('.dsm-workbuddy-pool-table input[type=checkbox]')
    if (box === null) throw new Error('no pool member checkbox rendered')
    await m.click(box)
    expect(m.text()).toContain('row.poolSaveDirty')
    // The save writes through the Host endpoint (stubbed to succeed) but the
    // re-read then fails: `refreshUsage` resolves `undefined` → `onSaved`
    // answers false → the section must KEEP the draft. With M15 the catch
    // returns `{}`, `onSaved` answers true, and the draft is discarded.
    usageOk = false
    await m.click(m.button('row.poolSaved'))
    await m.settle()
    expect(m.text()).toContain('row.poolSaveDirty')
    expect(m.text()).toContain('row.poolSaveFailed|message=row.poolSavedStaleRefresh')
    // A failed re-read must NOT blank the panel. The region keeps its last good
    // snapshot with a `refreshError` overlay, so the pool section the user was
    // editing is still there. Before the merge fix the catch replaced the whole
    // region with `{ status: 'error' }` — a variant carrying no `accounts`,
    // `pool`, `credits` or `models` — and the entire body (which is gated on
    // `status === 'signed-in'`) disappeared, pool draft included.
    expect(m.text()).toContain('row.poolTitle')
    expect(m.text()).toContain('row.modelsTitle')
    expect(m.text()).toContain('row.requestFailedHint|message=HTTP 500')
    await m.unmount()
  })

  it('re-reads the usage after a successful batch (M18: onRefresh is not a no-op)', async () => {
    let batches = 0
    const calls = routeFetch([
      [USAGE_PATH, () => ({ body: usageOf() })],
      ['/pool', () => {
        batches += 1
        return {
          body: {
            action: 'checkin',
            rows: [{ accountId: 'real-1', accountName: 'Real One', status: 'claimed' }],
          },
        }
      }],
      ['*', () => ({ body: {} })],
    ])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()
    const before = usageCalls(calls).length
    await m.click(m.button('row.poolCheckinAll'))
    await m.settle()
    expect(batches).toBe(1)
    // The batch must trigger a usage re-read so the panel reflects the new
    // check-in state. With M18 (`onRefresh={() => {}}`) the count is unchanged.
    expect(usageCalls(calls).length).toBeGreaterThan(before)
    await m.unmount()
  })
})

describe('the model list folds, and the fold cannot hide unsaved edits', () => {
  const foldOf = (m: { container: HTMLElement }): HTMLDetailsElement => {
    const found = m.container.querySelector('details.dsm-workbuddy-models-fold')
    if (found === null) throw new Error('the model section is not rendered as a <details> fold')
    return found as HTMLDetailsElement
  }
  const summaryOf = (m: { container: HTMLElement }): HTMLElement => {
    const found = foldOf(m).querySelector('summary')
    if (found === null) throw new Error('the fold has no summary')
    return found
  }
  const modelCheckbox = (m: { container: HTMLElement }): HTMLInputElement => {
    const found = m.container.querySelector<HTMLInputElement>('.dsm-workbuddy-model-enabled input[type=checkbox]')
    if (found === null) throw new Error('no model checkbox rendered')
    return found
  }
  const openCard = async (): Promise<Awaited<ReturnType<typeof mount>>> => {
    routeFetch([['*', () => ({ body: usageOf() })]])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()
    return m
  }

  it('starts EXPANDED — the list users already see must not move behind a click', async () => {
    const m = await openCard()
    // The header keeps the title and the count OUTSIDE the fold, so a collapsed
    // section still says what it contains and how many are enabled.
    expect(summaryOf(m).textContent).toContain('row.modelsTitle')
    expect(summaryOf(m).textContent).toContain('row.modelsSummary|count=1')
    expect(foldOf(m).open).toBe(true)
    await m.unmount()
  })

  it('toggles when the header itself is clicked', async () => {
    // Asserted on `open`, not on rendered text: jsdom keeps a closed
    // <details>' descendants in the DOM (it does not implement the UA's
    // closed-content rendering), so a textContent assertion would pass whether
    // or not the fold works at all. `open` is what a browser acts on.
    const m = await openCard()
    await m.click(summaryOf(m))
    expect(foldOf(m).open).toBe(false)
    await m.click(summaryOf(m))
    expect(foldOf(m).open).toBe(true)
    await m.unmount()
  })

  it('draws a chevron, and the open ATTRIBUTE it rotates on tracks the state', async () => {
    // The chevron itself is CSS: it points right when closed and rotates to
    // down under `.dsm-workbuddy-models-fold[open]`. That selector keys off the
    // ATTRIBUTE, not the `open` property, so a change that kept the fold
    // working while dropping the attribute would leave the icon permanently
    // pointing right — the fold would work but stop looking foldable. Both are
    // therefore asserted.
    const m = await openCard()
    const chevron = summaryOf(m).querySelector('.dsm-workbuddy-models-chevron')
    expect(chevron).not.toBeNull()
    // Decorative: the <details> element already announces the state, so the
    // icon must stay out of the accessibility tree.
    expect(chevron?.getAttribute('aria-hidden')).toBe('true')
    expect(chevron?.querySelector('svg')).not.toBeNull()
    expect(foldOf(m).hasAttribute('open')).toBe(true)
    await m.click(summaryOf(m))
    expect(foldOf(m).hasAttribute('open')).toBe(false)
    await m.unmount()
  })

  it('names the action available now in the header hint, and swaps it on toggle', async () => {
    // The chevron alone was not an obvious enough affordance, so the header
    // carries a faint hint. It must name the action that is available NOW:
    // a static "expand or collapse" leaves the reader to work out which one
    // applies, which is the very thing the hint is there to remove.
    const m = await openCard()
    const hint = (): string => summaryOf(m).querySelector('.dsm-workbuddy-models-fold-hint')?.textContent ?? ''
    expect(hint()).toContain('row.modelsFoldHide')
    expect(hint()).not.toContain('row.modelsFoldShow')
    await m.click(summaryOf(m))
    // jsdom dispatches `toggle` on a turn AFTER the click, so React's
    // `onToggle` — the only thing that updates this hint — may not have run yet
    // when `click` resolves. Settle first, or this asserts on a stale render and
    // fails on correct code (the hint still says "click to collapse"). The test
    // above survives without this because it reads `open`, which jsdom has
    // already updated and which no re-render is needed to observe; the RENDERED
    // WORD is what needs the extra turn, and the word is the subject here.
    await m.settle()
    expect(hint()).toContain('row.modelsFoldShow')
    expect(hint()).not.toContain('row.modelsFoldHide')
    // aria-hidden, like the chevron: the <details> element already announces the
    // state, and this text would otherwise be appended to the accessible name.
    expect(summaryOf(m).querySelector('.dsm-workbuddy-models-fold-hint')?.getAttribute('aria-hidden')).toBe('true')
    await m.unmount()
  })

  it('refreshing does NOT also fold the list', async () => {
    // The refresh button lives INSIDE <summary>, and a click anywhere inside a
    // summary activates the disclosure — so without the guard in the summary's
    // onClick, pressing "Refresh from WorkBuddy" would also collapse the list, a
    // side effect of an unrelated control. This is what the guard exists for, so
    // it is pinned rather than trusted.
    const m = await openCard()
    await m.click(m.button('row.modelsRefresh'))
    expect(foldOf(m).open).toBe(true)
    // And the fold must still work for a click that did NOT land on the button.
    await m.click(summaryOf(m))
    expect(foldOf(m).open).toBe(false)
    await m.unmount()
  })

  it('says so in the header when there are unsaved edits (the fold cannot hide them)', async () => {
    // The save/discard buttons are inside the fold and are only enabled while
    // `dirty`. Without a marker in the header a user could tick a model and
    // collapse the list, hiding their own pending edit with nothing on screen
    // saying so — the "looks settled, is not" shape this card avoids.
    const m = await openCard()
    expect(summaryOf(m).textContent).not.toContain('row.modelsDirty')
    await m.click(modelCheckbox(m))
    expect(summaryOf(m).textContent).toContain('row.modelsDirty')
    // Still true while collapsed — which is the whole point.
    await m.click(summaryOf(m))
    expect(foldOf(m).open).toBe(false)
    expect(summaryOf(m).textContent).toContain('row.modelsDirty')
    await m.unmount()
  })
})

describe('the account picker is gone, and the status line agrees with the pool', () => {
  it('renders no account dropdown at all', async () => {
    // Accounts are managed in the POOL now: its member checkboxes are the
    // selection surface, and with the pool on the ranking decides who serves —
    // so a dropdown that changes nothing yet looks authoritative is worse than
    // no dropdown. It also removed a real contradiction: the header could name
    // one account while the picker showed another.
    routeFetch([[USAGE_PATH, () => ({ body: usageOf() })], ['*', () => ({ body: {} })]])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()
    expect(m.container.querySelector('.dsm-workbuddy-account-picker')).toBeNull()
    expect(m.container.querySelector('.dsm-workbuddy-usage-select')).toBeNull()
    await m.unmount()
  })

  it('renders no signed-in status card at all', async () => {
    // The card used to lead with a boxed "Signed in: A / token expires …".
    // Both halves are gone, for different reasons: naming ONE account is the
    // wrong claim once several can be signed in (the pool block names the one
    // serving, and its table lists them all), and a token that auto-renews has
    // an expiry the user cannot act on. What remains for a broken region is only
    // text with a remedy — covered by the credential/credits panels, and by the
    // per-region dot on the tabs.
    //
    // Pinned as "absent" rather than deleted from the test file: re-introducing a
    // status card is a UI decision, and it should take a deliberate edit to the
    // expectation, not slip through as a new element nobody asserted.
    routeFetch([[USAGE_PATH, () => ({ body: usageOf() })], ['*', () => ({ body: {} })]])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()
    expect(m.container.querySelector('.dsm-workbuddy-usage-account')).toBeNull()
    expect(m.container.querySelector('.dsm-workbuddy-usage-status')).toBeNull()
    expect(m.text()).not.toContain('row.tokenExpiry')
    // And the card is still rendering the signed-in body — otherwise "absent"
    // would pass on an empty card.
    expect(m.text()).toContain('row.modelsTitle')
    await m.unmount()
  })

  it('offers re-detection in the pool AND while signed out', async () => {
    // The control moved into the pool block, which renders for a signed-in region
    // only — so the signed-out branch needs its own copy. Without it, "I signed in
    // over in the app, look again" (precisely a signed-out action) would have no
    // way to run.
    routeFetch([[USAGE_PATH, () => ({ body: usageOf() })], ['*', () => ({ body: {} })]])
    const signedIn = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await signedIn.settle()
    expect(signedIn.text()).toContain('row.accountsRescan')
    await signedIn.unmount()

    routeFetch([[
      USAGE_PATH,
      () => ({ body: { status: 'signed-out', accounts: [], selectionExplicit: false, searched: [] } }),
    ], ['*', () => ({ body: {} })]])
    const signedOut = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await signedOut.settle()
    expect(signedOut.text()).toContain('row.accountsRescan')
    await signedOut.unmount()
  })
})

describe('the model list comes last', () => {
  it('renders the pool before the model section', async () => {
    // The requested order: status → credits → pool → models. "Setting the models
    // last" is the point — the pool is what you reach for daily, and it should not
    // sit below a long, foldable list.
    routeFetch([[USAGE_PATH, () => ({ body: usageOf() }), ], ['*', () => ({ body: {} })]])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()
    const html = m.html()
    // Match the SECTION's class attribute, not a bare prefix: `dsm-workbuddy-models`
    // also prefixes the tab hint (`dsm-workbuddy-models-summary`) that sits above
    // everything, so a substring search would compare against the wrong element
    // and pass whatever the order was.
    const pool = html.indexOf('class="dsm-workbuddy-pool"')
    const models = html.indexOf('class="dsm-workbuddy-models"')
    expect(pool, 'no pool section rendered').toBeGreaterThan(-1)
    expect(models, 'no model section rendered').toBeGreaterThan(-1)
    expect(pool, 'the model list is not last').toBeLessThan(models)
    await m.unmount()
  })
})

describe('the two commit rows now look alike', () => {
  it('renders the encouragement link in BOTH the pool row and the model row', async () => {
    // The request was to make the pool row match the model row. Asserting the star
    // link exists in both, from the CARD (not the isolated section), catches the
    // case where the two rows drift apart again.
    routeFetch([[USAGE_PATH, () => ({ body: usageOf() })], ['*', () => ({ body: {} })]])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()
    const poolBar = m.container.querySelector('.dsm-workbuddy-pool-save-bar')
    const modelBar = m.container.querySelector('.dsm-workbuddy-model-actions')
    expect(poolBar, 'no pool commit row').not.toBeNull()
    expect(modelBar, 'no model commit row').not.toBeNull()
    for (const [name, bar] of [['pool', poolBar], ['model', modelBar]] as const) {
      const cheer = bar?.querySelector('a.dsm-workbuddy-usage-cheer')
      expect(cheer, `the ${name} row lost its encouragement link`).not.toBeNull()
      // And in both rows it is the FIRST child, i.e. on the left.
      expect(bar?.firstElementChild?.className, `the ${name} row does not lead with it`)
        .toContain('dsm-workbuddy-usage-cheer')
    }
    await m.unmount()
  })

  it('keeps the pool buttons in the LAST group, matching the model row', async () => {
    routeFetch([[USAGE_PATH, () => ({ body: usageOf() })], ['*', () => ({ body: {} })]])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()
    const poolBar = m.container.querySelector('.dsm-workbuddy-pool-save-bar')
    const modelBar = m.container.querySelector('.dsm-workbuddy-model-actions')
    // Model row: buttons wrapper is last. Pool row must agree.
    expect(modelBar?.lastElementChild?.className).toContain('dsm-workbuddy-model-actions-buttons')
    expect(poolBar?.lastElementChild?.className).toContain('dsm-workbuddy-pool-save-buttons')
    await m.unmount()
  })
})
