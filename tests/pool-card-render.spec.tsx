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
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

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
  // Built on the SHARED stub rather than hand-rolling a second response shape:
  // this file's private version answered without `headers`, so the moment the
  // card started reading `content-type` to pick its parser every test here threw
  // inside the batch's catch and silently reported a failed batch. One double,
  // one shape, no drift.
  return stubFetch(url => {
    const route = routes.find(([pattern]) => pattern === '*' || url.includes(pattern))
    return route === undefined ? { body: {} } : route[1]()
  }) as FetchCall[]
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

  it('keeps the saved draft usable when the usage re-read FAILS after a successful write', async () => {
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
    expect(m.container.querySelector('.dsm-workbuddy-pool-save-buttons button:last-child')?.hasAttribute('disabled'), 'the edit is still pending — Save must be enabled').toBe(false)
    // The save writes through the Host endpoint (stubbed to succeed) but the
    // re-read then fails: `refreshUsage` resolves `undefined` → `onSaved`
    // answers false → the section must KEEP the draft. With M15 the catch
    // returns `{}`, `onSaved` answers true, and the draft is discarded.
    usageOk = false
    await m.click(m.button('row.poolSaved'))
    await m.settle()
    // The write committed the draft, so no edit remains; the stale-refresh
    // message tells the user the figures will catch up later (issue #131).
    expect(m.container.querySelector('.dsm-workbuddy-pool-save-buttons button:last-child')?.hasAttribute('disabled'), 'nothing left to save — Save must be disabled').toBe(true)
    expect(m.text()).toContain('row.poolSavedStaleRefresh')
    expect(m.text()).not.toContain('row.poolSaveFailed')
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

describe('the model list no longer folds', () => {
  const headOf = (m: { container: HTMLElement }): HTMLElement => {
    const found = m.container.querySelector('.dsm-workbuddy-models-head')
    if (found === null) throw new Error('no model section header rendered')
    return found as HTMLElement
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

  it('renders no disclosure at all — the list is simply always there', async () => {
    // It used to be a native <details>: clickable header, chevron, "click to
    // collapse" hint. The list is what users came for, so folding it only ever
    // hid the thing they wanted — and it made this the card's only
    // click-to-hide section, which reads as a different kind of section.
    const m = await openCard()
    expect(m.container.querySelector('details.dsm-workbuddy-models-fold')).toBeNull()
    // Scoped to the MODEL section on purpose. This used to assert that the whole
    // card contained no <summary> at all, which was only ever true because the
    // models fold was its sole disclosure. The pool's account table has since
    // gained an unrelated one (the ordering-rule section), and a card-wide
    // "no summary anywhere" would now fail for a reason that has nothing to do
    // with this section. The guarantee that matters is: the model list, in its
    // own section, does not fold.
    expect(m.container.querySelector('.dsm-workbuddy-models summary')).toBeNull()
    expect(m.container.querySelector('.dsm-workbuddy-models details')).toBeNull()
    expect(m.container.querySelector('.dsm-workbuddy-models-chevron')).toBeNull()
    expect(m.container.querySelector('.dsm-workbuddy-models-fold-hint')).toBeNull()
    // The header and the list are both still rendered, and the header still says
    // what the section holds.
    expect(headOf(m).textContent).toContain('row.modelsTitle')
    // The "已启用 N 个" line under the title was removed on request: it
    // restated a count the rows themselves show. Asserted as an ABSENCE so a
    // later refactor cannot quietly put a second line of chrome back.
    expect(headOf(m).textContent).not.toContain('row.modelsSummary')
    expect(m.container.querySelectorAll('.dsm-workbuddy-model').length).toBeGreaterThan(0)
    // A click on the header must NOT hide anything any more.
    await m.click(headOf(m))
    expect(m.container.querySelectorAll('.dsm-workbuddy-model').length).toBeGreaterThan(0)
    await m.unmount()
  })

  it('still says so in the header when there are unsaved edits', async () => {
    // Kept from the fold era, and it matters MORE now: with no fold there is no
    // way to hide the pending edit, but the header marker is still what tells a
    // reader — without scrolling a long model list to the buttons — that
    // something is unsaved. The "looks settled, is not" shape this card avoids.
    const m = await openCard()
    expect(headOf(m).textContent).not.toContain('row.modelsDirty')
    await m.click(modelCheckbox(m))
    expect(headOf(m).textContent).toContain('row.modelsDirty')
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

describe('the account-level error is actually rendered', () => {
  it('shows what the Host said when the hides could not be cleared', async () => {
    // `rescanAccounts` writes `accountError` for TWO reasons — a refused write
    // and a rescan whose hides stayed put — and until this change nothing
    // rendered it: the state was set on every failure path and displayed on
    // none. The user's evidence was a button that appeared to work. This pins
    // the rendering half against the card's own DOM, because the wiring half
    // (the route flag) is asserted in `tests/web-status.spec.ts`.
    routeFetch([
      ['/accounts/refresh', () => ({ body: { accounts: [{ accountId: 'real-1' }], dismissalsCleared: false } })],
      [USAGE_PATH, () => ({ body: usageOf() })],
      ['*', () => ({ body: {} })],
    ])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()
    // Before the rescan there is no error line.
    expect(m.container.querySelector('.dsm-workbuddy-account-error')).toBeNull()
    const rescan = m.buttons().find(button => (button.textContent ?? '').includes('row.accountsRescan'))
    expect(rescan, 'no rescan button rendered').toBeDefined()
    await m.click(rescan!)
    await m.settle()
    const error = m.container.querySelector('.dsm-workbuddy-account-error')
    expect(error, 'the failed clear was not surfaced').not.toBeNull()
    expect(error?.getAttribute('role')).toBe('alert')
    expect(error?.textContent).toContain('row.rescanHidesKept')
    await m.unmount()
  })
})

/**
 * The free-model quota warning.
 *
 * WHY THIS IS NOT COSMETIC. The catalog marks several models `creditMultiplier: 0`,
 * and the card displays them as free. The upstream still refuses them with
 * `6004` / `14003` once a per-window token quota is spent — that refusal is the
 * quota, not a billing balance, and it cannot be topped up. A user who reads
 * "free" as "unlimited" therefore interprets a 6004 as the plugin being broken
 * and goes looking for a bad account (issue #56's reporter spent that hunt), or
 * for a top-up that would change nothing.
 *
 * The line has to be its own BOLD paragraph. Folding it into the grey sentence
 * above is exactly how the ×0 tiers came to read as unlimited in the first
 * place, so the two properties pinned here are the ones that carry the meaning:
 * it RENDERS at all, and it does not share the muted weight of its neighbours.
 *
 * The locale PROSE is asserted in the table check below rather than here, so a
 * rewording does not have to touch this file.
 */
describe('the free-model quota warning', () => {
  it('renders, and is bold rather than another muted hint line', async () => {
    routeFetch([
      [USAGE_PATH, () => ({ body: usageOf() })],
      ['*', () => ({ body: {} })],
    ])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()

    const warn = m.container.querySelector('.dsm-workbuddy-free-quota-warn')
    expect(warn, 'the free-model quota warning is not rendered').not.toBeNull()
    // `t` returns the KEY in these tests, so this proves WHICH string was chosen
    // rather than what it says — the split that keeps prose and wiring from
    // breaking each other.
    expect(warn?.textContent).toContain('row.tabFreeQuotaWarn')

    // The bold class is the whole signal. Asserting the class rather than a
    // computed weight keeps this out of jsdom's (absent) cascade, and the CSS
    // rule itself is pinned in `tests/card-credits-switch.spec.tsx`'s sibling
    // source guard below.
    // It no longer borrows `.dsm-workbuddy-models-summary`: that class carries the
    // block margins of a paragraph following a section heading, and this element
    // now sits INLINE on the pool heading's row. Asserting its own class also
    // proves the stylesheet rule below is the one that styles it.
    expect(warn?.className).toContain('dsm-workbuddy-free-quota-warn')
    await m.unmount()
  })

  it('keeps the weight in the stylesheet rather than in an inline style', async () => {
    // A `style={{fontWeight:600}}` would satisfy the render assertion above
    // while making the rule unfindable to anyone auditing the card's CSS. The
    // weight has to live where every other card rule lives.
    //
    // Read through `fileURLToPath` rather than `new URL(..., import.meta.url)`:
    // under this file's jsdom environment `import.meta.url` is not a file URL,
    // and handing it to `readFile` throws "The URL must be of scheme file" —
    // a broken TEST, not a missing rule (it fails the same way against the
    // correct stylesheet).
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'styles.ts'),
      'utf8',
    )
    // The DECLARATION, not the whole rule: the selector also carries spacing now
    // that this line reads as the second half of the region hint, and pinning
    // the full rule text made an unrelated margin change look like a lost weight.
    expect(css, 'the bold rule is missing from the stylesheet')
      .toMatch(/\.dsm-workbuddy-free-quota-warn\{[^}]*font-weight:600/u)
  })
})

/**
 * WHERE the region hint lives.
 *
 * The hint explains the pair of provider cells at the top of the card. It used
 * to be rendered inside the accounts panel — below the section tabs — so it read
 * as a caption for 「账号 / 模型 / 能力」, the row it does not describe, and it
 * vanished whenever the user picked any other section.
 *
 * These two cases pin the position rather than the wording: the text is chosen
 * by key (`t` returns the key here), so rewording stays a locale-only change.
 */
describe('the region-pair hint', () => {
  it('sits directly under the region tabs and above the section tabs', async () => {
    routeFetch([[USAGE_PATH, () => ({ body: usageOf() })], ['*', () => ({ body: {} })]])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()

    const hint = m.container.querySelector('.dsm-workbuddy-tab-hint')
    expect(hint, 'the region hint is not rendered').not.toBeNull()
    expect(hint?.textContent).toContain('row.tabHint')

    const html = m.html()
    const regions = html.indexOf('class="dsm-workbuddy-tabs"')
    const hintAt = html.indexOf('class="dsm-workbuddy-models-summary dsm-workbuddy-tab-hint"')
    const sections = html.indexOf('class="dsm-workbuddy-panels"')
    expect(regions, 'no region tab row').toBeGreaterThan(-1)
    expect(sections, 'no section tab row').toBeGreaterThan(-1)
    expect(hintAt, 'the hint is not between the two tab rows').toBeGreaterThan(regions)
    expect(hintAt, 'the hint is below the section tabs').toBeLessThan(sections)
    await m.unmount()
  })

  it('stays visible from every section, not only the accounts one', async () => {
    // Living inside the accounts panel meant `hidden` took it with that panel.
    // Outside every panel there is no state in which it is hidden.
    routeFetch([[USAGE_PATH, () => ({ body: usageOf() })], ['*', () => ({ body: {} })]])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()

    const hint = m.container.querySelector('.dsm-workbuddy-tab-hint')
    expect(hint, 'the region hint is not rendered').not.toBeNull()
    // No ancestor of the hint may be a hideable panel.
    let node: Element | null = hint
    while (node !== null && node !== m.container) {
      expect(node.classList.contains('dsm-workbuddy-panel'),
        'the hint is inside a section panel and will disappear with it').toBe(false)
      node = node.parentElement
    }
    await m.unmount()
  })
})

/**
 * THE POOL TABLE MUST FIT ITS COLUMN, NOT THE WINDOW.
 *
 * The card renders in three places with unrelated widths: the composer card, the
 * full page (capped at 860px) and the Settings panel's content column (~560px on
 * a 1400px screen). Every breakpoint this file used was a viewport media query,
 * so inside the Settings panel none of them fired and the five-column table was
 * laid into a 560px box.
 *
 * jsdom does not lay out, so these cases pin the CONTRACT the browser needs —
 * that the tracks may shrink, and that the collapse is measured against the
 * table. A layout assertion here would pass no matter what the CSS said.
 */
describe('the pool table fits the Settings panel width', () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'styles.ts'),
    'utf8',
  )

  it('leaves the grid tracks as bare fr, because minmax was measured and changed nothing', () => {
    // Tracks are NOT the constraint here. Measured in headless Chrome at the
    // Settings column width (564px), swapping `1.6fr` for `minmax(0,1.6fr)`
    // moved the overflowing-cell count 1 -> 1 in both cases: the row's own
    // width (530) never exceeded the table's (532). What overflows is a CELL,
    // and `.dsm-workbuddy-pool-benefit` already carries the `min-width:0` that
    // fixes it (see the sibling case in tests/pool-e2e.spec.ts, which records
    // the same result and exists so nobody re-tries this).
    //
    // Pinned here too, from the opposite direction: the collapse below is
    // supposed to happen through @container, so if the tracks ever grow a
    // minmax minimum that conclusion has been revisited and this note is stale.
    const row = /\.dsm-workbuddy-pool-row\{display:grid;grid-template-columns:([^;]+);/.exec(css)?.[1] ?? ''
    expect(row, 'the pool row grid rule is missing').not.toBe('')
    expect(row, 'the tracks were measured as not being the constraint').not.toContain('minmax(')
  })

  it('measures the collapse against the table, not the viewport', () => {
    // `container-type: inline-size` is what makes @container work at all; without
    // it the queries below are inert and the media query is all that is left.
    expect(css).toContain('.dsm-workbuddy-pool-table{container-type:inline-size;')
    // ONE threshold, and it must sit ABOVE the Settings column's ~564px. An
    // earlier revision had a 720px band that only dropped a track, and the
    // Settings column landed INSIDE it: readers got a 2x2 grid whose cells no
    // longer lined up with their headers. The single breakpoint has to fire for
    // that column, which is the whole point of measuring the table.
    const threshold = /@container \(max-width:(\d+)px\)\{[\s\S]*?\.dsm-workbuddy-pool-row\{display:flex/u.exec(css)
    expect(threshold, 'no @container breakpoint scoped to the pool row').not.toBeNull()
    expect(Number(threshold?.[1]), 'the breakpoint must fire for the ~564px Settings column')
      .toBeGreaterThan(564)
    // And it must stack rather than re-grid: a table has no useful "slightly
    // narrower" form, so the narrow form is a card.
    expect(threshold?.[1], 'the narrow form must stack, not re-grid').toBeDefined()
  })

  it('collapses the account cell OWN inner column, not just its wrapper', () => {
    // THE HALF THAT DECIDES ROW HEIGHT (learned from dsh-connect-trae 4.9.0,
    // which shipped the outer half and measured 138px rows).
    //
    // `.dsm-workbuddy-pool-account` is only a flex wrapper. The cells that stack
    // live one level deeper, in `.dsm-workbuddy-pool-account-name`, which
    // declares `flex-direction:column` so name / rank+arrows / current pill /
    // tested-at read as a small card when the table is wide. Collapsing the
    // wrapper alone left that block stacking four deep inside the narrow form:
    // measured at 549px it was 81px of the row's 157px, and the row read as one
    // tall account block beside three one-line facts.
    const narrow = /@container \(max-width:700px\)\{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? ''
    expect(narrow, 'the pool narrow form is missing').not.toBe('')
    expect(narrow, 'the account name block must stop stacking in the narrow form')
      .toMatch(/\.dsm-workbuddy-pool-account-name\{[^}]*flex-direction:row/u)
    // ...and the margins that only make sense while it stacks must go with it,
    // or the wrapped line gains uneven leading between the pills.
    expect(narrow, 'the current badge keeps a stacking margin')
      .toMatch(/\.dsm-workbuddy-pool-account-name \.dsm-workbuddy-pool-current-tag\{[^}]*margin-top:0/u)
    // The ellipsis cannot engage on a flex item left at min-width:auto.
    expect(narrow, 'a long account name can still push the line instead of clipping')
      .toMatch(/\.dsm-workbuddy-pool-account-name b\{[^}]*min-width:0/u)
  })

  it('labels the account column where the account NAME starts, not at the cell edge', () => {
    // Measured at the plugin page's 1120px: the header cell starts at x=65 and
    // the name at x=103. The account cell leads with the membership checkbox, so
    // a header flush to the cell edge floated 38px into the margin and pointed
    // at nothing. dsh-connect-trae carries the same offset for the same reason.
    const rule = /(\.dsm-workbuddy-pool-col-account\{[^}]*\})/u.exec(css)?.[1] ?? ''
    expect(rule, 'the account header cell has no class to indent').not.toBe('')
    expect(rule, 'the header must be pushed to the name, not left at the checkbox')
      .toMatch(/padding-inline-start:\s*\d+px/u)
  })

  it('keeps the section strip visible while the sections scroll', () => {
    // The pool sits below the fold. Before this, reaching it scrolled the five
    // tabs off the top, so switching sections meant scrolling the whole page
    // back up first (dsh-connect-trae 4.9.0 hit the identical thing).
    //
    // Sticky, NOT a second scroller: the Settings panel's column already
    // scrolls, so `height:100%` / `overflow:auto` here would add a second one.
    const rule = /(^|\n)(\.dsm-workbuddy-panels\{[^}]*\})/u.exec(css)?.[2] ?? ''
    expect(rule, 'the section strip rule is missing').not.toBe('')
    expect(rule, 'the strip must stay visible while the sections scroll')
      .toMatch(/position:sticky/u)
    expect(rule, 'the strip must not add a second scroll container')
      .not.toMatch(/overflow:\s*(auto|scroll)/u)
    // Opaque, or the rows scroll through the gaps between the labels. It
    // paints the SURFACE variable rather than a hard-coded layer, so the strip
    // and the content area behind it can never drift apart: the page surface
    // repaints its fill with layer-3, and a strip stuck on layer-1 would then
    // read as a lighter second bar sliding over a darker card.
    expect(rule, 'the strip must paint, or rows show through it')
      .toMatch(/background:var\(--dsm-workbuddy-surface,/u)
    // ...and every surface must therefore declare it beside its own fill.
    const declarers = css.split('\n').filter(line => /\.dsm-workbuddy-usage\{/u.test(line))
    expect(declarers.length, 'no content-area rules found').toBeGreaterThan(1)
    for (const decl of declarers) {
      expect(decl, `this surface paints a fill the strip cannot follow: ${decl.slice(0, 70)}`)
        .toMatch(/--dsm-workbuddy-surface:/u)
    }
  })

  it('keeps containment off every element that holds a fixed-position overlay', () => {
    // `container-type` makes the element the containing block for position:fixed
    // descendants, which would anchor the busy veils and the device dialog to a
    // table instead of the viewport. Only the two content-only elements may
    // carry it.
    const roots = Array.from(css.matchAll(/\.([\w-]+)\{container-type:/g)).map(m => m[1])
    expect(roots.sort()).toEqual(['dsm-workbuddy-pool-settings', 'dsm-workbuddy-pool-table'])
  })
})

/**
 * NO TEXT MAY SIT DIRECTLY ON A WALLPAPER (issue #209).
 *
 * With a custom wallpaper the shell's centre column is TRANSLUCENT. Every
 * surface in this card assumed an opaque column behind it, and only some of them
 * painted their own fill: the content area and the page header carried none, so
 * 「账号池」, the hint line and the tab row rendered straight over the picture.
 *
 * jsdom paints nothing, so this cannot be a rendering assertion. What IS
 * checkable is the property that failed: these surfaces must declare an opaque
 * background drawn from the theme's own layer tokens.
 */
describe('surfaces stay readable over a wallpaper (issue #209)', () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'styles.ts'),
    'utf8',
  )

  /**
   * The LAST rule declaring `selector`.
   *
   * Last, not first: these selectors are refined further down the sheet, and the
   * fill lives on the later rule. Reading the first match reported "no
   * background" for a stylesheet that does paint one — which is how this test
   * caught its OWN bug rather than the CSS's.
   */
  function ruleFor(selector: string): string {
    let found = ''
    for (const line of css.split('\n')) {
      const at = line.indexOf(`${selector}{`)
      if (at >= 0) found = line.slice(at)
    }
    return found
  }

  it('gives EVERY content area an opaque fill', () => {
    // `.dsm-workbuddy-usage` is the same class on three surfaces — the card, the
    // sidebar page and the Settings section — and each has its own later rule.
    // Checking only ONE of them is not enough: the Settings rule paints a fill,
    // so a case that accepted any match stayed green while the card's own
    // surface went back to transparent (verified by mutation). Every rule that
    // sets this class as its final selector must paint.
    const own = css.split('\n')
      .filter(line => /(^|[\s>])\.dsm-workbuddy-usage\{/u.test(line))
      .filter(line => !/background:transparent/u.test(line))
    expect(own.length, 'no content-area rule found').toBeGreaterThan(1)
    for (const rule of own) {
      expect(rule, `this content area lost its fill: ${rule.slice(0, 80)}`)
        .toMatch(/background:var\(--dsw-alias-bg-/u)
    }
  })

  it('gives the page header an opaque fill', () => {
    // The title and the one-line description sit ABOVE the content area, so
    // fixing `.dsm-workbuddy-usage` alone left them over the picture. Both the
    // Settings section and the sidebar page header must carry it.
    const rule = ruleFor('.dsm-workbuddy-page .dsm-workbuddy-page-head')
    expect(rule, 'the page header has no fill').not.toBe('')
    expect(rule, 'the header must paint an opaque surface')
      .toMatch(/background:var\(--dsw-alias-bg-/u)
  })

  it('keeps the settings surface itself free of a translucent base', () => {
    // The panel column is the shell's; this page must not add a second
    // translucent layer of its own on top of it.
    const rule = ruleFor('.dsm-workbuddy-settings .dsm-workbuddy-page-body .dsm-workbuddy-usage')
    expect(rule, 'the settings content rule is missing').not.toBe('')
    expect(rule, 'the settings content area must not be rewritten to transparent')
      .toMatch(/background:var\(--dsw-alias-bg-/u)
  })
})

/**
 * THE MODEL NAME MUST SURVIVE ITS OWN BADGES (the Settings panel, DSH 0.2.2).
 *
 * A model row is one line of: name, optional rate, the upstream's promotion
 * chip, the "new" marker, then three controls, three budget radios and two
 * buttons. Every chip is `flex:none` — a half-drawn pill reads as a rendering
 * bug — so the ONLY shrinkable item is the name, and it is also the one thing a
 * reader needs. Left alone, a long name plus two chips squeezed the name down to
 * a stub (「GLM-5.」 with nothing after it).
 *
 * jsdom does no layout, so this pins the CONTRACT the browser needs rather than
 * a measured width: the copy line wraps, and the name has a floor.
 */
describe('the model name survives its badges', () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'styles.ts'),
    'utf8',
  )
  const ruleFor = (selector: string): string => {
    let found = ''
    for (const line of css.split('\n')) {
      const at = line.indexOf(`${selector}{`)
      if (at >= 0) found = line.slice(at)
    }
    return found
  }

  it('lets the chips wrap instead of squeezing the name', () => {
    const copy = ruleFor('.dsm-workbuddy-model-copy')
    expect(copy, 'the copy rule is missing').not.toBe('')
    expect(copy, 'without wrapping, every chip holds its width and the name gives way')
      .toContain('flex-wrap:wrap')
  })

  it('does NOT let the name claim leftover width', () => {
    // WAS "gives the name a floor so it cannot collapse to a stub", and the floor
    // was the bug. `flex:1 1 auto; min-width:9em` made the name box grow to fill
    // the row's spare space — 117px for "Hy4", whose text is ~30px — so the promo
    // chip sat at the end of that inflated box and the space between the price
    // and the chip read as a stray blank block. It appeared ONLY on rows that
    // carry a chip, which is what pointed at the name box rather than at the chip.
    //
    // The concern the old floor was protecting against is real — a long name must
    // not squeeze the chip out of view — but it is answered by SHRINKING, not by
    // growing: `flex:0 1 auto` takes the name's own width and still allows it to
    // give way, and the name already ellipsizes.
    const name = ruleFor('.dsm-workbuddy-model-copy>.dsm-workbuddy-model-name')
    expect(name, 'the name has no rule of its own').not.toBe('')
    expect(name, 'the name must not GROW into the free space').not.toMatch(/flex:1 1 auto/u)
    expect(name, 'the name must still be allowed to shrink').toMatch(/flex:0 1 auto/u)
    // And no em-based floor, which is what turned "do not collapse" into
    // "always at least 117px".
    expect(name, 'an em floor reintroduces the blank block').not.toMatch(/min-width:\d+em/u)
  })

  it('lets the models header wrap instead of squeezing the title', () => {
    // Four long Chinese button labels and a title column do not fit the panel's
    // ~538px; without wrapping, 「已启用 3 个」 broke mid-phrase while the buttons
    // stayed at full width.
    const head = ruleFor('.dsm-workbuddy-models-head')
    expect(head, 'the models header rule is missing').not.toBe('')
    expect(head, 'the header must wrap').toContain('flex-wrap:wrap')
    // And the title column must be allowed to shrink, or wrapping does nothing.
    const titleCol = ruleFor('.dsm-workbuddy-models-head>div:first-child')
    expect(titleCol, 'the title column has no min-width:0').toContain('min-width:0')
  })
})

/**
 * The free-quota warning travels with the region hint.
 *
 * The two sentences answer one question: "what am I looking at, and what are its
 * limits". The warning used to sit INSIDE the accounts panel, so the section
 * tabs and the rule above the pool came between a statement and its caveat — and
 * it disappeared on the model section, which is exactly where the ×0 tiers the
 * warning is about are shown.
 */
describe('the free-quota warning sits beside the pool heading', () => {
  /**
   * WHERE IT LIVES NOW, and why the old position was wrong.
   *
   * It used to travel with the region hint (above the section tabs), then for one
   * release above the model list. Both put it AWAY from the thing it is about: it
   * corrects exactly one misreading — a ×0 multiplier looks free, so a column of
   * them looks unlimited — and a caveat three hundred pixels above the numbers,
   * behind a tab row, is a caveat nobody connects to them.
   *
   * Beside the pool heading it is a note ON this tab: every account here serves
   * the same gateways, so the limit belongs to the panel rather than to one row
   * or one model. It also uses the gap that was already empty — the heading is
   * short and the serving-account badge is pushed to the right edge.
   */
  it('renders on the pool heading row, next to the title', async () => {
    routeFetch([[USAGE_PATH, () => ({ body: usageOf() })], ['*', () => ({ body: {} })]])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()

    const head = m.container.querySelector('.dsm-workbuddy-pool-head')
    expect(head, 'no pool heading row').not.toBeNull()
    const warn = head?.querySelector('.dsm-workbuddy-free-quota-warn')
    expect(warn, 'the warning is not on the pool heading row').not.toBeNull()
    // Beside the TITLE, not somewhere else on the row.
    expect(warn?.previousElementSibling?.className).toContain('dsm-workbuddy-pool-title')
    expect(warn?.textContent).toContain('row.tabFreeQuotaWarn')
    await m.unmount()
  })

  it('is no longer one of the region-pair paragraphs', async () => {
    // The old home is asserted as an ABSENCE, so a later refactor cannot quietly
    // put a second copy back above the tabs while this one stays here.
    routeFetch([[USAGE_PATH, () => ({ body: usageOf() })], ['*', () => ({ body: {} })]])
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()

    // SIBLING, not descendant: the region hint and the pool share one big
    // container (`dsm-workbuddy-usage`), so a descendant check would fail for the
    // right reason on the wrong evidence. What the old layout had was the warning
    // as the very NEXT element after the hint — that is what must not come back.
    const hint = m.container.querySelector('.dsm-workbuddy-tab-hint')
    expect(hint, 'no region hint').not.toBeNull()
    expect(hint?.nextElementSibling?.className ?? '',
      'the warning is a sibling of the region hint again').not.toContain('dsm-workbuddy-free-quota-warn')
    await m.unmount()
  })
})


/**
 * ONE SPACING SOURCE, NOT THREE (the Settings panel).
 *
 * `.dsm-workbuddy-usage` is a flex column with `gap`, so its children are
 * already separated. Three of them added their own margin or padding on top,
 * and the gaps stacked: the section tabs landed 32px under the hint (16 gap +
 * 16 margin), and the pool 28px under the tabs (16 gap + 12 margin + 16 padding
 * of its own). On a narrow panel that reads as two accidental blank bands.
 *
 * Measured in headless Chrome at the panel's width: both gaps are 16px once the
 * stacking is gone, which is the rhythm the rest of the card uses.
 */
describe('the panel adds no spacing on top of the column gap', () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'styles.ts'),
    'utf8',
  )
  const ruleFor = (selector: string): string => {
    let found = ''
    for (const line of css.split('\n')) {
      const at = line.indexOf(`${selector}{`)
      if (at >= 0) found = line.slice(at)
    }
    return found
  }

  it('keeps the section tab row margin-free', () => {
    const tabs = ruleFor('.dsm-workbuddy-panels')
    expect(tabs, 'the tab row rule is missing').not.toBe('')
    // `margin:0` — NOT `margin-top`, which would still stack on the gap.
    expect(tabs, 'the tab row must not add a top margin over the column gap')
      .toContain('margin:0')
    // The bottom rule is the tabs' underline, not spacing: it must stay.
    expect(tabs, 'the tabs lost their underline').toContain('border-bottom')
  })

  it('keeps the panel margin-free', () => {
    const panel = ruleFor('.dsm-workbuddy-panel')
    expect(panel, 'the panel rule is missing').not.toBe('')
    expect(panel, 'the panel must not add a top margin over the column gap').toBe('.dsm-workbuddy-panel{margin:0}')
  })

  it('keeps the pool free of top padding', () => {
    const pool = ruleFor('.dsm-workbuddy-pool')
    expect(pool, 'the pool rule is missing').not.toBe('')
    expect(pool, 'the pool must not add top padding under the tab row')
      .toMatch(/padding:0 0 \d+px/u)
  })
})

describe('the per-row actions sit on the account-name line', () => {
  /**
   * MOVED BY REQUEST. The gear / test / remove buttons used to be the pool row's
   * LAST GRID CELL, which put them on a line of their own below the credits on a
   * wide panel (and on their own wrapped line on a narrow one). Three small
   * buttons were costing the row a whole line while the name line — the shortest
   * one — sat with empty space to the right of the sort badge.
   *
   * They now live inside the `.dsm-workbuddy-pool-account` cell and are pushed to
   * its right edge by `margin-inline-start:auto`.
   */
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'styles.ts'),
    'utf8',
  )
  const ruleFor = (selector: string): string => {
    const at = css.indexOf(`${selector}{`)
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at) + 1)
  }

  it('is a flex item that claims the name line\'s leftover space', () => {
    const actions = ruleFor('.dsm-workbuddy-pool-row-actions')
    expect(actions, 'the row-actions rule is missing').not.toBe('')
    // The auto margin is what moves them to the right edge. Without it they sit
    // immediately after the sort badge, which reads as a fourth badge.
    expect(actions, 'the actions must be pushed to the end of the name line')
      .toContain('margin-inline-start:auto')
    // And they must not shrink: a squeezed button is unclickable.
    expect(actions, 'the buttons must not shrink').toContain('flex:none')
  })

  it('no longer forces itself onto a full-width line of its own', () => {
    // The narrow-panel override was `flex:1 1 100%`, which is exactly the "own
    // line" behaviour this change removes. It must be gone from the media query.
    expect(css, 'the old full-width override is still present')
      .not.toContain('.dsm-workbuddy-pool-row-actions{flex:1 1 100%')
  })
})

describe('no blank block between the price and the promo chip', () => {
  /**
   * THE REPORT: "不应该有空白" — a ~40px empty gap appeared between `x0.00` and the
   * promo chip, on SOME rows only.
   *
   * The rows that showed it were exactly the rows with a chip, which is the whole
   * clue: with nothing after the name, an over-wide name box is invisible; add a
   * chip and the box's leftover width becomes a visible blank. The cause was
   * `.dsm-workbuddy-model-copy>.dsm-workbuddy-model-name{flex:1 1 auto;
   * min-width:9em}` — 117px of name box for a ~30px name.
   */
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'styles.ts'),
    'utf8',
  )
  const ruleFor = (selector: string): string => {
    const at = css.indexOf(`${selector}{`)
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at) + 1)
  }

  it('leaves the name at its own width', () => {
    const name = ruleFor('.dsm-workbuddy-model-copy>.dsm-workbuddy-model-name')
    // `flex:0 1 auto` = do not grow, may shrink, base on content.
    expect(name).toMatch(/flex:0 1 auto/u)
    expect(name, 'a min-width in em re-creates the blank').not.toMatch(/min-width:\d+em/u)
  })

  it('still lets the name give way instead of pushing the chip out', () => {
    // The reason the floor existed. Shrinking answers the same worry without
    // inflating short names, and `min-width:0` is what allows it (a flex item
    // cannot shrink below its content width otherwise).
    const name = ruleFor('.dsm-workbuddy-model-copy>.dsm-workbuddy-model-name')
    expect(name, 'min-width:0 is required for a flex item to shrink').toContain('min-width:0')
    // The name still ellipsizes rather than overflowing. Looked up by its own
    // rule — `ruleFor` matches the FIRST occurrence, which is the
    // `.dsm-workbuddy-model-copy>.dsm-workbuddy-model-name` override above.
    const full = ruleFor('\n.dsm-workbuddy-model-name')
    expect(full).toContain('text-overflow:ellipsis')
    expect(full).toContain('white-space:nowrap')
  })
})
