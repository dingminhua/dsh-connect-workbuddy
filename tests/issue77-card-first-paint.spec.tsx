// @vitest-environment jsdom
/**
 * Issue #77 from the CARD's side: the account table must appear from the
 * first-paint document, before any full document lands.
 *
 * The route tests (`tests/issue77-fast-first-paint.spec.ts`) prove a fast
 * document makes no upstream call. That is necessary but not sufficient: the
 * reported symptom was the PANEL, so the fix only counts if the rows are on
 * screen from that document alone. These tests mount the real card with a stub
 * whose full-document answer NEVER resolves, and assert that the account table
 * is rendered anyway — the shape the reporter would have seen instantly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

const USAGE_PATH = '/plugins/dsh-connect-workbuddy/usage'
const FAST_MARKER = 'detail=fast'

function isUsage(url: string): boolean { return url.startsWith(USAGE_PATH) }
function isFast(url: string): boolean { return isUsage(url) && url.includes(FAST_MARKER) }
function isFull(url: string): boolean { return isUsage(url) && !url.includes(FAST_MARKER) }

/**
 * A signed-in FIRST-PAINT document: the account table, and deliberately NO
 * credits / check-in / live pool figures — exactly what the Host's local read
 * produces. Anything the card renders from this body is what a user sees before
 * any billing request answers.
 */
function fastDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    offModelIds: [],
    pool: {
      enabled: true,
      checkinSupported: true,
      targetModelSource: 'free',
      targetModelId: 'free-1',
      memberAccountIds: ['real-1'],
      effectiveMemberAccountIds: ['real-1'],
      // No `credits`, no `checkedInToday`: nothing billing-side has been read.
      accounts: [{ accountId: 'real-1', accountName: 'Real One', current: true, member: true }],
      catalog: [{ id: 'free-1', name: 'Free One', creditMultiplier: 0 }],
    },
    ...overrides,
  }
}

/** A full document: the same rows, plus the live figures that arrive later. */
function fullDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return fastDocument({
    credits: { total: 20, expiringSoon: 0, packages: [] },
    pool: {
      ...(fastDocument()['pool'] as Record<string, unknown>),
      accounts: [{
        accountId: 'real-1', accountName: 'Real One', current: true, member: true,
        checkedInToday: true, credits: 20,
      }],
    },
    ...overrides,
  })
}

interface Gate {
  promise: Promise<void>
  release: () => void
}

function gate(): Gate {
  let release!: () => void
  const promise = new Promise<void>(done => { release = done })
  return { promise, release }
}

/**
 * Answer first-paint requests immediately and let every full document wait.
 *
 * The base stub is installed FIRST so `baseFetch` captures it, then a wrapper is
 * installed on top that records the attempt and holds it. (A wrapper installed
 * before the stub would hold requests that then reach a `fetch` the stub has
 * already replaced.)
 */
function hangingFullFetch(fast: Record<string, unknown> = fastDocument()): {
  calls: { url: string, init: any }[]
  /** Full documents the card ASKED for — recorded before the hold applies. */
  fullAttempts: { url: string, init: any }[]
  releaseFull: () => void
} {
  const calls = stubFetch(url => ({ body: isFast(url) ? fast : fullDocument() }))
  const baseFetch = globalThis.fetch as unknown as (url: any, init: any) => Promise<unknown>
  const fullAttempts: { url: string, init: any }[] = []
  const gates: Gate[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
    const target = String(url)
    if (isFull(target)) {
      fullAttempts.push({ url: target, init })
      const held = gate()
      gates.push(held)
      await held.promise
    }
    return baseFetch(url, init)
  }))
  return {
    calls,
    fullAttempts,
    releaseFull: () => { for (const held of gates) held.release() },
  }
}

describe('the card paints the account table from the first-paint document (issue #77)', () => {
  it('renders the pool rows while the full document is still in flight', async () => {
    // The reported wait, reproduced: the expensive read never answers. The
    // account table must be on screen anyway — that is the whole fix.
    const stub = hangingFullFetch()
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()

    // The row is the thing the user was waiting for.
    expect(m.text()).toContain('Real One')
    expect(m.container.querySelector('.dsm-workbuddy-pool')).not.toBeNull()
    expect(m.container.querySelector('.dsm-workbuddy-pool-table')).not.toBeNull()
    // The signed-out guidance — what the reporter actually saw for ~30 s — must
    // NOT be on screen: it told a signed-in user they were not signed in.
    expect(m.text()).not.toContain('row.signedOut')
    expect(m.text()).not.toContain('row.accountsScanning')

    // And the card did ask for the first paint, then for the full one.
    expect(stub.calls.some(call => isFast(call.url))).toBe(true)
    expect(stub.fullAttempts.length).toBeGreaterThan(0)

    stub.releaseFull()
    await m.settle()
    await m.unmount()
  })

  it('shows a loading line — not the signed-out guidance — while NOTHING has answered', async () => {
    // A slower-than-local Host still exists (a cold process, a busy machine).
    // Until any document lands the card must say it is loading; it used to say
    // "not signed in" and offer to detect accounts the user already had.
    stubFetch(() => ({
      body: { status: 'signed-out', accounts: [], selectionExplicit: false },
    }))
    const baseFetch = globalThis.fetch as unknown as (url: any, init: any) => Promise<unknown>
    const held: Gate[] = []
    const attempts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      attempts.push(String(url))
      const blocked = gate()
      held.push(blocked)
      await blocked.promise
      return baseFetch(url, init)
    }))

    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    // No settle yet: nothing is allowed to answer, so this is the empty window.
    // The card has ALREADY asked (that is why the window exists at all).
    expect(attempts.length).toBeGreaterThan(0)
    expect(m.text()).toContain('row.accountsLoading')
    expect(m.text()).not.toContain('row.signedOutHint')
    expect(m.text()).not.toContain('row.accountsRescan')

    // Issue #279: IMPORT must not wait on the account document. On a fresh
    // Docker/Linux machine with no desktop sign-in this is the ONLY way in, so
    // hiding it for the whole loading window ties "can I import" to "has the
    // read answered". The button lives here even while nothing has answered.
    expect(m.text()).toContain('row.transferImport')
    expect(m.container.querySelectorAll('.dsm-workbuddy-pool-tools').length).toBe(1)

    for (const blocked of held) blocked.release()
    await m.settle()
    // Once an answer lands the loading line yields to the real signed-out
    // guidance with its re-detect button.
    expect(m.text()).toContain('row.accountsRescan')
    expect(m.text()).not.toContain('row.accountsLoading')
    await m.unmount()
  })

  it('keeps IMPORT available when the usage document fails (issue #279)', async () => {
    // A failed account read is the state with NO usable snapshot — exactly when
    // a file carried over from another machine is most needed. Import does not
    // read that document (it writes the vault), so the error state must not be
    // the one state that hides it.
    stubFetch(() => ({ status: 500, body: { error: 'usage unavailable' } }))
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()

    expect(m.text()).toContain('row.transferImport')
    // Still exactly one copy — the loading and error branches are exclusive.
    expect(m.container.querySelectorAll('.dsm-workbuddy-pool-tools').length).toBe(1)

    await m.unmount()
  })

  it('does NOT let a late first paint overwrite a full document already on screen', async () => {
    // The two documents race in reality: the full one may answer first on a fast
    // upstream. The fast body is the POORER one (no credits, no check-in), so
    // writing it over a loaded region would blank columns that were visible.
    const calls = stubFetch(url => ({ body: isFast(url) ? fastDocument() : fullDocument() }))
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()
    expect(calls.some(call => isFast(call.url))).toBe(true)
    expect(calls.some(call => isFull(call.url))).toBe(true)
    expect(m.text()).toContain('Real One')
    // The credits cell is rendered from the pool row. It reads 20 because the
    // full document was applied LAST — a fast re-paint that arrived after it
    // would have replaced the row with the credit-less variant and shown "—".
    expect(m.container.querySelector('.dsm-workbuddy-pool-credits')?.textContent).toContain('20')
    await m.unmount()
  })
})
