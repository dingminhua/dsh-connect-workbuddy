// @vitest-environment jsdom
/**
 * A failed status read must not be terminal (issue #170, PR #171).
 *
 * ## The defect
 *
 * `refreshUsage`'s catch writes `{ status: 'error', message }` for a region that
 * never loaded. That variant carries `accounts: []`, so `hasAccounts` is
 * `status.status !== 'error' && status.accounts.length > 0` → false, and BOTH
 * self-refreshes gate on it:
 *
 *   - the 60s poll effect: `if (!open || !hasAccounts) return`;
 *   - the on-open effect: its deps are `[open, activeRegion, refreshUsage,
 *     refreshUsageFast]`, so re-rendering into the error state does not re-run
 *     it.
 *
 * Nothing asked again. One transient `Failed to fetch` — the WebView's fetch
 * rejected while the web process was restarting — stayed on screen until the
 * card was collapsed and reopened. The user was shown a raw browser
 * `TypeError` with no action attached to it.
 *
 * ## What is pinned here, and why each assertion is the one that can fail
 *
 *   RETRY ARMING   A failing status read must arm a bounded retry. The mutant
 *        that matters is the shipped one: `hasAccounts` gating everything, so
 *        the number of usage reads stays at 2 forever (one fast + one full per
 *        region) and the banner never clears.
 *   COLLAPSED      `open === false` must arm NOTHING. Backing off against a
 *        card the user closed is a request the user cannot see the answer to.
 *   ACTIONABLE     The banner must say what happened AND offer the retry, not
 *        echo the error object's `message` as the whole sentence. The old
 *        render was `<p>{status.message}</p>`, i.e. literally `Failed to
 *        fetch`.
 *   RECOVERY       A later successful read replaces the error document. This is
 *        what "not terminal" means, and it is asserted through the rendered
 *        DOM (the signed-in body appears) rather than through state.
 *
 * ## Why fake timers
 *
 * The behaviour is a BACKOFF, so the test has to own time. The shared harness's
 * `settle()` drains work with `setTimeout`, which fake timers freeze, so it
 * cannot be used past `vi.useFakeTimers()`; `advanceTimersByTimeAsync` inside
 * `act` both moves the clock and lets the fetch/json/setState chain run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const USAGE_PATH = '/plugins/dsh-connect-workbuddy/usage'

/** A minimal but real signed-in body: enough to render the panel body. */
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
    ...overrides,
  }
}

const usageCalls = (calls: { url: string }[]): { url: string }[] =>
  calls.filter(call => call.url.startsWith(USAGE_PATH))

/** Move the fake clock and let the awakened promise chain settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('#170: a failed status read retries instead of staying on screen', () => {
  it('arms a retry while the banner is up, and stops as soon as a read lands', async () => {
    vi.useFakeTimers()
    // Every usage read fails with the browser's own network TypeError, which is
    // exactly what the reporter saw: no HTTP status, no upstream business code.
    let fail = true
    const calls = stubFetch(url => {
      if (url.startsWith(USAGE_PATH) && fail) throw new TypeError('Failed to fetch')
      return { body: usageOf() }
    })

    const view = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await advance(0)
    // Two regions x one fast + one full read each; all of the full ones failed.
    expect(usageCalls(calls).length).toBeGreaterThanOrEqual(2)
    expect(view.text()).toContain('row.usageErrorHint|message=Failed to fetch')

    // The retry is armed at STATUS_RETRY_BASE_MS (3s). The shipped defect had NO
    // retry at all, so this count never moved again.
    const before = usageCalls(calls).length
    await advance(3_000)
    expect(usageCalls(calls).length).toBeGreaterThan(before)

    // Keep failing: the second attempt backs off to 6s, so a 3s advance alone
    // must NOT produce another read. This is what "bounded backoff" means, and
    // it is the assertion a constant 3s interval would fail.
    const afterFirstRetry = usageCalls(calls).length
    await advance(3_000)
    expect(usageCalls(calls).length).toBe(afterFirstRetry)
    await advance(3_000)
    expect(usageCalls(calls).length).toBeGreaterThan(afterFirstRetry)

    // A read that lands clears the banner: the error document is replaced by a
    // real one, which is the whole "not terminal" claim.
    fail = false
    await advance(12_000)
    expect(view.text()).toContain('row.modelsTitle')
    expect(view.text()).not.toContain('row.usageErrorHint')

    // And the backoff stops: a landed document returns the card to its 60s poll,
    // so nothing fires in the next few seconds.
    const afterRecovery = usageCalls(calls).length
    await advance(9_000)
    expect(usageCalls(calls).length).toBe(afterRecovery)
  })

  it('offers a Retry button that reads immediately, without waiting out the backoff', async () => {
    vi.useFakeTimers()
    let fail = true
    const calls = stubFetch(url => {
      if (url.startsWith(USAGE_PATH) && fail) throw new TypeError('Failed to fetch')
      return { body: usageOf() }
    })

    const view = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await advance(0)
    expect(view.text()).toContain('row.usageErrorHint|message=Failed to fetch')

    // The banner used to be a bare <p>{message}</p>: nothing to press. A user
    // facing a 30s backoff needs the manual door.
    const before = usageCalls(calls).length
    fail = false
    await view.click(view.button('row.usageRetry'))
    await advance(0)
    expect(usageCalls(calls).length).toBeGreaterThan(before)
    expect(view.text()).toContain('row.modelsTitle')
    expect(view.text()).not.toContain('row.usageErrorHint')
  })

  it('falls back to the generic failure label when the error carries no message', async () => {
    vi.useFakeTimers()
    // `error.message` can be the empty string (a rejection with no args, or a
    // Host answer shaped `{message: ''}`). The banner must still read as a
    // sentence rather than as an empty hint with a colon and nothing after it.
    stubFetch(url => {
      if (url.startsWith(USAGE_PATH)) throw new Error('')
      return { body: {} }
    })

    const view = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await advance(0)
    expect(view.text()).toContain('row.usageErrorHint|message=row.requestFailed')
  })

  it('arms nothing while the card is collapsed', async () => {
    vi.useFakeTimers()
    const calls = stubFetch(url => {
      if (url.startsWith(USAGE_PATH)) throw new TypeError('Failed to fetch')
      return { body: {} }
    })

    const view = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await advance(0)
    expect(view.text()).toContain('row.usageErrorHint')

    // Collapse. The body unmounts and the effect's cleanup aborts its timer, so
    // a closed card cannot keep spending requests on an answer nobody sees.
    //
    // Addressed by the HEADER class, not by its label: the header's text content
    // is the plugin title and description, while `row.collapse` rides on its
    // `aria-label` (the same reason `mount.button()` cannot find it).
    const header = (): Element => {
      const found = view.container.querySelector('.dsm-plugin-card-header')
      if (found === null) throw new Error('no card header')
      return found
    }
    await view.click(header())
    await advance(0)
    const whileClosed = usageCalls(calls).length
    await advance(120_000)
    expect(usageCalls(calls).length).toBe(whileClosed)

    // Re-opening issues a fresh read — the same door the reporter used, now
    // working from the button instead of being the only remedy.
    await view.click(header())
    await advance(0)
    expect(usageCalls(calls).length).toBeGreaterThan(whileClosed)
  })
})
