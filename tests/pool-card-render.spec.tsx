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
      rotateByCredits: false,
      autoTestIntervalMinutes: 30,
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
    // The signed-in line renders only from an APPLIED snapshot.
    expect(m.text()).toContain('row.signedIn')
    expect(m.text()).toContain('Real One')
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
    expect(m.text()).toContain('row.signedIn')
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
    expect(m.text()).toContain('row.signedIn')
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
    expect(m.text()).toContain('row.signedIn')
    // Edit the pool interval so the draft is dirty.
    const input = m.container.querySelector('input.dsm-workbuddy-pool-num') as HTMLInputElement | null
    if (input === null) throw new Error('no pool interval input rendered')
    await m.type('45')
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
    expect(m.text()).toContain('row.creditsTotalLabel')
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
