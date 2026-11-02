// @vitest-environment jsdom
/**
 * Issue #199 defect 2, on the card: an unreadable vault must not read as
 * "the account no longer exists".
 *
 * THE REPORTER'S SCREEN. Their pinned OAuth account was still on disk — the ACL
 * lockout had only made the folder unopenable — and the card's one visible
 * sentence was 「已保存的账号在本机已不存在」. Every action that message implies
 * (re-pick, sign in again) leaves a lockout untouched, so the copy was not merely
 * unhelpful, it pointed the user away from the only repair.
 *
 * WHY A REAL MOUNT. The three assertions below are about which paragraph the CARD
 * chose among copy keys it owns, and about a hint that must DISAPPEAR: a
 * source-text regex guard on a 3,900-line component can be defeated by re-spelling
 * the ternary (the standing lesson in `tests/pool-render-helpers.tsx`), and the
 * suppression case has no positive text to grep for at all. So the component runs.
 *
 * `t` is the key-preserving translator from the harness, which is what lets each
 * assertion name the exact message rather than its wording.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

/** A signed-out usage document, with the optional #199 fields as given. */
function signedOutBody(input: {
  selectionLost?: boolean
  vaultError?: string
}): Record<string, unknown> {
  return {
    status: 'signed-out',
    region: 'cn',
    accounts: [],
    selectionExplicit: true,
    message: 'workbuddy: no signed-in WorkBuddy account found',
    ...input.selectionLost === undefined ? {} : { selectionLost: input.selectionLost },
    ...input.vaultError === undefined ? {} : { vaultError: input.vaultError },
  }
}

const render = async (body: Record<string, unknown>) => {
  stubFetch(() => ({ body }))
  const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
  await m.settle()
  return m
}

describe('issue #199 defect 2: the card distinguishes "cannot read" from "does not exist"', () => {
  it('says the vault could not be read, naming the errno, when the Host reports one', async () => {
    const m = await render(signedOutBody({ selectionLost: true, vaultError: "EPERM: operation not permitted, opendir 'vault/cn'" }))
    const text = m.text()
    expect(text).toContain('row.vaultUnreadableMessage')
    // The errno has to SURVIVE to the screen: it is the difference between "repair
    // your folder permissions" and "check your antivirus", and the user is the one
    // who has to pick.
    expect(text).toContain('EPERM')
  })

  it('drops the "account no longer exists" copy when the vault is unreadable', async () => {
    // The suppression is the actual fix. Rendering BOTH sentences would keep the
    // wrong advice on screen next to the right one, and the wrong one is shorter.
    const m = await render(signedOutBody({ selectionLost: true, vaultError: 'EPERM: operation not permitted' }))
    expect(m.text()).not.toContain('row.selectionLostHint')
    expect(m.text()).not.toContain('row.selectionLostMessage')
  })

  it('keeps the "account no longer exists" copy when the vault read fine', async () => {
    // The old behaviour is correct on a healthy machine — an orphaned id really
    // does mean re-pick — so this pins that the new branch did not eat it.
    const m = await render(signedOutBody({ selectionLost: true }))
    expect(m.text()).toContain('row.selectionLostMessage')
    expect(m.text()).not.toContain('row.vaultUnreadableMessage')
    // And the HINT renders here, which is what makes the suppression in the case
    // above a real assertion: guarding that something never appears is worthless
    // unless something else proves it normally does.
    expect(m.text()).toContain('row.selectionLostHint')
  })

  /**
   * The SIGNED-IN half, which the signed-out paragraph above cannot carry.
   *
   * Here the region still WORKS — the desktop scan answers for the accounts that
   * can be read — so the picker renders and is silently missing every account that
   * lives only in the vault (all of the ones added through the plugin). No error,
   * no message, no way for the user to notice a row is gone.
   */
  it('flags an unreadable vault on a signed-in card too', async () => {
    stubFetch(() => ({
      body: {
        status: 'signed-in',
        region: 'cn',
        tokenExpiresAtMs: Date.now() + 86_400_000,
        selectionExplicit: true,
        accounts: [{ accountId: 'real-1', accountName: 'Real One' }],
        models: [{
          id: 'probe-model',
          name: 'Probe Model',
          contextWindow: 200_000,
          nativeContextWindow: 200_000,
          maxTokens: 64_000,
        }],
        enabledModelIds: ['probe-model'],
        imageModelIds: [],
        credits: { total: 20, expiringSoon: 0, packages: [] },
        vaultError: 'EPERM: operation not permitted, opendir',
      },
    }))
    const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
    await m.settle()
    expect(m.text()).toContain('row.vaultUnreadableHint')
  })
})
