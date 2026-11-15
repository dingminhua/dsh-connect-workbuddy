// @vitest-environment jsdom
/**
 * A 403 from the Host's loopback gate must be VISIBLE and ACTIONABLE
 * (issue #261).
 *
 * ## The defect
 *
 * Behind a reverse proxy the plugin's routes answer 403 with a structured
 * `{ error: 'host-not-trusted' }` (or `origin-not-trusted`). `refreshUsage`
 * parsed that body into `value` and then threw it away with a bare
 * `throw new Error('HTTP 403')`. The card therefore rendered its two generic
 * hints — "sign back in to WorkBuddy" and "the local DSH service may have just
 * restarted" — both of which are FALSE for this failure: re-authenticating
 * cannot change a Host header. A user with a proxy deployment saw an empty card
 * and advice that could never help.
 *
 * ## What is pinned here
 *
 *   SPECIFIC   The two gate codes get their own copy and suppress the generic
 *              error block and the re-login hint. The copy names the real
 *              remedy (open DSH at its local address / trust the authority).
 *   NARROW     Only those two codes take the branch. A 403 with any other body,
 *              a 500, and a genuine signed-out document keep the existing
 *              rendering — the change must not mislabel an unrelated refusal.
 *   MUTATION   Removing `gateRefusalOf`'s code check (returning `undefined`
 *              always, or trusting any 403) turns the SPECIFIC and NARROW
 *              assertions red respectively.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

const USAGE_PATH = '/plugins/dsh-connect-workbuddy/usage'

/** A minimal signed-in body, for the recovery / non-gate cases. */
function usageOf(): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'account-a',
    accountName: '账号A',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'account-a', accountName: '账号A' }],
    models: [{ id: 'model-a', name: 'Model A', creditMultiplier: 0 }],
    enabledModelIds: ['model-a'],
    imageModelIds: [],
  }
}

/** Every usage read answers with the given HTTP status + JSON body. */
function refused(status: number, body: unknown) {
  return stubFetch(url => url.startsWith(USAGE_PATH)
    ? { status, body }
    : { body: {} })
}

describe('#261: a refused Host/Origin surfaces a specific, actionable hint', () => {
  it('shows the gate copy for host-not-trusted and hides the misleading hints', async () => {
    refused(403, { error: 'host-not-trusted' })
    const view = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await view.settle()
    const text = view.text()
    expect(text).toContain('row.usageGateRefusedTitle')
    expect(text).toContain('row.usageGateHostRefused')
    // The two generic hints would tell the user to do something that cannot help.
    expect(text).not.toContain('row.reloginHint')
    expect(text).not.toContain('row.usageErrorHint')
    await view.unmount()
  })

  it('distinguishes the Origin refusal from the Host one', async () => {
    refused(403, { error: 'origin-not-trusted' })
    const view = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await view.settle()
    const text = view.text()
    expect(text).toContain('row.usageGateRefusedTitle')
    expect(text).toContain('row.usageGateOriginRefused')
    expect(text).not.toContain('row.usageGateHostRefused')
    expect(text).not.toContain('row.reloginHint')
    await view.unmount()
  })

  it('keeps the generic error path for a 403 that is NOT a gate refusal', async () => {
    refused(403, { error: 'some other refusal' })
    const view = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await view.settle()
    const text = view.text()
    expect(text).toContain('row.usageErrorHint|message=HTTP 403')
    expect(text).not.toContain('row.usageGateRefusedTitle')
    await view.unmount()
  })

  it('keeps the generic error path for a 500', async () => {
    refused(500, { error: 'boom' })
    const view = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await view.settle()
    const text = view.text()
    expect(text).toContain('row.usageErrorHint|message=HTTP 500')
    expect(text).not.toContain('row.usageGateRefusedTitle')
    await view.unmount()
  })

  it('shows no gate hint for a healthy signed-in document', async () => {
    stubFetch(url => url.startsWith(USAGE_PATH) ? { body: usageOf() } : { body: {} })
    const view = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await view.settle()
    const text = view.text()
    expect(text).not.toContain('row.usageGateRefusedTitle')
    expect(text).toContain('row.modelsTitle')
    await view.unmount()
  })

  it('clears the gate hint once a later read succeeds', async () => {
    let refuse = true
    stubFetch(url => {
      if (url.startsWith(USAGE_PATH) && refuse) return { status: 403, body: { error: 'host-not-trusted' } }
      return { body: usageOf() }
    })
    const view = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await view.settle()
    expect(view.text()).toContain('row.usageGateRefusedTitle')

    // The card's automatic retry (issue #170) or the Retry button drives this.
    // Force a fresh read through the visible Retry button; the gate block offers
    // one so the user need not close and reopen the card.
    refuse = false
    await view.click(view.button('row.usageRetry'))
    await view.settle()
    expect(view.text()).not.toContain('row.usageGateRefusedTitle')
    await view.unmount()
  })
})
