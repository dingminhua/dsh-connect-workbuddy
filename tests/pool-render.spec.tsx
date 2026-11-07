// @vitest-environment jsdom
/**
 * AccountPool.tsx BEHAVIOURAL tests — the renderer this component never had.
 *
 * docs/audit/I-round4-verification.md proved that every source-text guard on
 * AccountPool.tsx can be defeated by a respelling (a ternary around an
 * argument, a decoy lambda parameter, an alias for a binding). 18 mutants
 * restored real defects — including the user-reported interval clamp — with
 * the suite green and both tsc projects clean. The fix is not another regex:
 * it is executing the component and asserting on the DOM.
 *
 * Each `it` here is written so that the mutant it names (see the I report's
 * §3) fails it. A mutant that survives this file is a mutant that restores a
 * defect the USER can see, so if one survives, the test is wrong — not the
 * guard strategy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../src/client/AccountPool.tsx'
import { accountOf, fakeScope, mount, poolOf, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

const GENUINE_ACCOUNT = accountOf({ accountId: 'real-1', accountName: 'Real One', current: true })
const GENUINE_ID = 'real-1'

/** Props for the common case: one live member, enabled pool, free model. */
function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    t,
    region: 'cn',
    settingsScope: fakeScope({}),
    pool: poolOf({
      memberAccountIds: [GENUINE_ID],
      effectiveMemberAccountIds: [GENUINE_ID],
      accounts: [GENUINE_ACCOUNT],
    }),
    ...overrides,
  }
}

describe('save keeps the draft unless the write AND the re-read both verify (A-8 / N1)', () => {
  /** A draft edit: unchecking the only member. Any edit dirties the draft. */
  async function makeDirty(m: Awaited<ReturnType<typeof mount>>): Promise<void> {
    const box = m.checkboxes()[0]
    if (box === undefined) throw new Error('no member checkbox rendered')
    await m.click(box)
  }

  it('discards the draft once the verified write succeeds, even before onSaved resolves', async () => {
    const onSaved = vi.fn(async () => true)
    const scope = fakeScope({})
    const props = baseProps({ settingsScope: scope, onSaved })
    const m = await mount(AccountPool, props)
    await makeDirty(m) // dirty: members [real-1] → []
    expect(m.button('row.poolSaved').disabled, 'the edit is still pending — Save must be enabled').toBe(false)
    await m.click(m.button('row.poolSaved')) // "Save"
    // Success: no longer dirty, and the re-read delivered fresh props.
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(m.button('row.poolSaved').disabled, 'nothing left to save — Save must be disabled').toBe(true)
    // The parent now re-renders with the pool it re-read (no members); the
    // panel must show the new state, not the pre-edit one.
    await m.update({ ...props, pool: poolOf({ memberAccountIds: [], effectiveMemberAccountIds: [], accounts: [GENUINE_ACCOUNT] }) })
    expect(m.text()).toContain('row.poolSelectedCount|count=0|total=1')
    await m.unmount()
  })

  it('drops the busy veil as soon as the write lands, while the usage re-read continues', async () => {
    // Saving is a write the user is waiting on, and the panel's values change
    // only after the Host answers. The veil must span BOTH halves — the write
    // and the re-read — which is exactly the window `saving` already covers.
    // A veil that came down at the write would leave the panel showing the
    // pre-save values it is about to replace. (The pool props are NOT re-rendered
    // here, so this pins the ordering the component itself controls.)
    let release: (() => void) | undefined
    const onSaved = vi.fn(() => new Promise<boolean>(resolve => {
      release = () => resolve(true)
    }))
    const m = await mount(AccountPool, baseProps({ settingsScope: fakeScope({}), onSaved }))
    await makeDirty(m)
    await m.click(m.button('row.poolSaved'))
    await m.settle()
    // The write is done, so the user is no longer waiting on the save even
    // though the billing re-read is still in flight (issue #131).
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(m.container.querySelector('.dsm-workbuddy-veil')).toBeNull()
    expect(m.text()).not.toContain('row.poolSaving')
    release?.()
    await m.settle()
    // Now everything has landed, so nothing is being waited on.
    expect(m.container.querySelector('.dsm-workbuddy-veil')).toBeNull()
    await m.unmount()
  })

  it('explains a stale refresh after the write has committed the draft', async () => {
    const onSaved = vi.fn(async () => false)
    const scope = fakeScope({})
    const m = await mount(AccountPool, baseProps({ settingsScope: scope, onSaved }))
    await makeDirty(m)
    await m.click(m.button('row.poolSaved'))
    // The write already committed the draft; the stale-refresh notice is only
    // about the display catching up (issue #131).
    expect(m.button('row.poolSaved').disabled, 'nothing left to save — Save must be disabled').toBe(true)
    // The stale-refresh notice names the DISPLAY problem (the write landed), and
    // it must NOT be wrapped in 「保存失败：」 — that framing told the user the
    // opposite of what had happened, since the setting was already verified on
    // disk (issue #131).
    expect(m.text()).toContain('row.poolSavedStaleRefresh')
    expect(m.text()).not.toContain('row.poolSaveFailed')
    expect(m.container.querySelector('[role="alert"]')).toBeNull()
    await m.unmount()
  })

  it('keeps the draft when the WRITE itself fails (M16: a failed write must not discard)', async () => {
    const onSaved = vi.fn(async () => true)
    // Both write paths refuse: the Host endpoint 500s AND the scope answers
    // false, so `writePoolPreferences` must throw.
    const scope = fakeScope({}, true)
    const posts = stubFetch(() => ({ status: 500, body: { error: 'boom' } }))
    const m = await mount(AccountPool, baseProps({ settingsScope: scope, onSaved }))
    await makeDirty(m)
    await m.click(m.button('row.poolSaved'))
    expect(posts.length).toBe(1)
    // The draft survives: the user's edit is still on screen and still dirty.
    expect(m.button('row.poolSaved').disabled, 'the edit is still pending — Save must be enabled').toBe(false)
    expect(m.text()).toContain('row.poolSaveFailed|message=')
    // The re-read never ran: the write never landed.
    expect(onSaved).not.toHaveBeenCalled()
    await m.unmount()
  })

  it('explains a locked-file refusal instead of pasting a raw EPERM', async () => {
    // Measured live against the 3.0.0 host with the profile's patch file held
    // open: the write came back HTTP 500 with
    //   EPERM: operation not permitted, rename '…cordis.patch.yml.<hex>.tmp' -> '…'
    // which names a temp file and no remedy. The account-save path already
    // appended advice for this case; the pool path did not, so a Windows user
    // hitting antivirus/OneDrive contention got an unactionable error.
    const onSaved = vi.fn(async () => true)
    const scope = fakeScope({}, true)
    stubFetch(() => ({
      status: 500,
      body: { errorName: 'Error', error: "EPERM: operation not permitted, rename 'C:\\u\\.dsh\\p\\cordis.patch.yml.79498ff8fb27.tmp' -> 'C:\\u\\.dsh\\p\\cordis.patch.yml'" },
    }))
    const m = await mount(AccountPool, baseProps({ settingsScope: scope, onSaved }))
    await makeDirty(m)
    await m.click(m.button('row.poolSaved'))
    // The remedy is shown...
    expect(m.text()).toContain('row.saveContentionHint')
    // ...and the draft survives (the hint promises it does).
    expect(m.button('row.poolSaved').disabled, 'the edit is still pending — Save must be enabled').toBe(false)
    // ...and the raw reason is still there for diagnosis.
    expect(m.text()).toContain('EPERM')
    await m.unmount()
  })

  it('does NOT claim file contention for an unrelated save failure', async () => {
    // The hint sends the user to close their editor. Showing it for a validation
    // refusal would send them chasing a cause that is not present.
    const scope = fakeScope({}, true)
    stubFetch(() => ({ status: 500, body: { errorName: 'Error', error: 'value must be an integer' } }))
    const m = await mount(AccountPool, baseProps({ settingsScope: scope, onSaved: vi.fn(async () => true) }))
    await makeDirty(m)
    await m.click(m.button('row.poolSaved'))
    expect(m.text()).toContain('value must be an integer')
    expect(m.text()).not.toContain('row.saveContentionHint')
    await m.unmount()
  })
})

describe('a batch refreshes the card exactly once, only on success (M-4)', () => {
  it('fires onRefresh once after a successful check-in (M18, M39)', async () => {
    const onRefresh = vi.fn()
    const posts = stubFetch(() => ({
      body: { action: 'checkin', rows: [{ accountId: GENUINE_ID, accountName: 'Real One', status: 'already' }] },
    }))
    const m = await mount(AccountPool, baseProps({ onRefresh }))
    await m.click(m.button('row.poolCheckinAll'))
    expect(posts.length).toBe(1)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    // Not in finally: a batch that SUCCEEDED must not log a failure line.
    expect(m.text()).toContain('row.poolLogCheckinDone')
    expect(m.text()).not.toContain('row.poolLogBatchFailed')
    await m.unmount()
  })

  it('does NOT fire onRefresh when the batch fails (M-M4-finally mutant)', async () => {
    const onRefresh = vi.fn()
    stubFetch(() => ({ status: 503, body: { reason: 'pool-unavailable', error: 'no' } }))
    const m = await mount(AccountPool, baseProps({ onRefresh }))
    await m.click(m.button('row.poolCheckinAll'))
    expect(onRefresh).not.toHaveBeenCalled()
    expect(m.text()).toContain('row.poolLogBatchFailed')
    await m.unmount()
  })

  it('announces the count the batch will actually run on (H-5, on the live render path)', async () => {
    const posts = stubFetch(() => ({
      body: { action: 'checkin', rows: [{ accountId: GENUINE_ID, accountName: 'Real One', status: 'claimed' }] },
    }))
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: [GENUINE_ID, 'ghost-1'],
        effectiveMemberAccountIds: [GENUINE_ID],
        accounts: [GENUINE_ACCOUNT],
      }),
    }))
    await m.click(m.button('row.poolCheckinAll'))
    expect(posts.length).toBe(1)
    expect(m.text()).toContain('row.poolLogCheckinStart|count=1')
    await m.unmount()
  })
})

describe('callbacks survive a prop change (D5 — the stale-closure class)', () => {
  it('a batch started before a pool refresh still counts the NEW pool (M12, M20–M22, M35, M41)', async () => {
    // The card polls every 60s; a user can click while the poll is in flight.
    // The click's callback must read the pool it was given NOW, not the one
    // captured at mount — and not a decoy that shadows the name.
    let answer: { status: number, body: unknown } = { status: 200, body: { action: 'checkin', rows: [] } }
    const posts = stubFetch(() => answer)
    const props = baseProps()
    const m = await mount(AccountPool, props)
    // The poll delivers a DIFFERENT pool: the ghost resolved (a new sign-in).
    const refreshedPool = poolOf({
      memberAccountIds: [GENUINE_ID, 'ghost-1'],
      effectiveMemberAccountIds: [GENUINE_ID, 'ghost-1'],
      accounts: [GENUINE_ACCOUNT, accountOf({ accountId: 'ghost-1', accountName: 'Ghost', member: true })],
    })
    await m.update({ ...props, pool: refreshedPool })
    await m.click(m.button('row.poolCheckinAll'))
    expect(posts.length).toBe(1)
    // The announced count must be 2 — the NEW pool's effective members.
    expect(m.text()).toContain('row.poolLogCheckinStart|count=2')
    await m.unmount()
  })

  it('the FIRST edit after a refresh bases on the REFRESHED saved list (H-1)', async () => {
    // v1: both accounts are members.
    const v1 = poolOf({
      memberAccountIds: [GENUINE_ID, 'second-1'],
      effectiveMemberAccountIds: [GENUINE_ID, 'second-1'],
      accounts: [GENUINE_ACCOUNT, accountOf({ accountId: 'second-1', accountName: 'Second' })],
    })
    const props = baseProps({ pool: v1 })
    const m = await mount(AccountPool, props)
    // The poll delivers v2: second was unchecked elsewhere, genuine remains.
    const secondRow = accountOf({ accountId: 'second-1', accountName: 'Second', member: false })
    const v2 = poolOf({
      memberAccountIds: [GENUINE_ID],
      effectiveMemberAccountIds: [GENUINE_ID],
      accounts: [GENUINE_ACCOUNT, secondRow],
    })
    await m.update({ ...props, pool: v2 })
    // The user's FIRST edit after the refresh: uncheck the genuine account.
    const genuineBox = m.checkboxes()[0]
    if (genuineBox === undefined) throw new Error('no member checkbox rendered')
    await m.click(genuineBox)
    // A fresh base (v2 members [real-1]) minus real-1 = NO members left. A
    // stale base (v1 [real-1, second-1]) minus real-1 would RESURRECT the
    // unchecked-elsewhere second-1 — count 1 instead of 0.
    expect(m.text()).toContain('row.poolSelectedCount|count=0|total=2')
    expect(m.text()).toContain('row.poolUnsavedMembers')
    await m.unmount()
  })

  it('a DRAFT edit does not change the announced batch count (M41)', async () => {
    // The count a batch announces is the SAVED effective set — the set the Host
    // itself resolves — so an unsaved member must never be announced.
    //
    // This is also the only observable that separates reading `pool` (a declared
    // dependency) from reading a draft-derived binding (`effectiveMembers`,
    // `active`). `runAction`'s deps are [appendLog, onRefresh, pool, region, t],
    // so a draft edit re-renders WITHOUT recreating it: a draft-derived read is
    // frozen at the last render whose deps changed. The scenario therefore has
    // to leave the draft DIRTY at that moment, then edit again — otherwise the
    // stale value happens to equal the saved one and the mutant hides.
    const posts = stubFetch(() => ({
      body: { action: 'checkin', rows: [{ accountId: GENUINE_ID, accountName: 'Real One', status: 'claimed' }] },
    }))
    const v1 = poolOf({
      memberAccountIds: [GENUINE_ID],
      effectiveMemberAccountIds: [GENUINE_ID],
      accounts: [GENUINE_ACCOUNT, accountOf({ accountId: 'second-1', accountName: 'Second', member: false })],
    })
    const props = baseProps({ pool: v1 })
    const m = await mount(AccountPool, props)
    expect(m.text()).toContain('row.poolSelectedCount|count=1|total=2')
    // Edit 1: uncheck the only saved member. The draft is now dirty with ZERO
    // members — the pool prop has NOT changed, so `runAction` is not recreated.
    const genuineBox = m.checkboxes()[0]
    if (genuineBox === undefined) throw new Error('no genuine checkbox rendered')
    await m.click(genuineBox)
    expect(m.text()).toContain('row.poolSelectedCount|count=0|total=2')
    // The poll lands: a new pool object with effective [genuine]. `pool` is a
    // dependency, so THIS is when `runAction` is recreated — and it now closes
    // over a draft-derived binding holding the ZERO-member draft.
    const v2 = poolOf({
      memberAccountIds: [GENUINE_ID],
      effectiveMemberAccountIds: [GENUINE_ID],
      accounts: [GENUINE_ACCOUNT, accountOf({ accountId: 'second-1', accountName: 'Second', member: false })],
    })
    await m.update({ ...props, pool: v2 })
    // Edit 2: check the unsaved second account. The draft is dirty again, but
    // the callback is NOT recreated, so a draft-derived read still says ZERO
    // while the correct answer is the saved set of ONE.
    const secondBox = m.checkboxes()[1]
    if (secondBox === undefined) throw new Error('no second checkbox rendered')
    await m.click(secondBox)
    // The log is a module-level store keyed by region (C2-1), so it carries the
    // lines of every earlier test in this file. Clear it through the component's
    // own control so the only lines left are THIS batch's.
    await m.click(m.button('row.poolLogClear'))
    await m.click(m.button('row.poolCheckinAll'))
    const text = m.text()
    expect(posts.length).toBe(1)
    const post = posts[0]
    // The batch posts no member list at all: the Host resolves the SAVED
    // preferences itself. That is exactly why announcing the draft would lie.
    expect(post?.init?.body ?? undefined).toBeUndefined()
    expect(text).toContain('row.poolLogCheckinStart')
    const announcement = text.slice(text.indexOf('row.poolLogCheckinStart'))
    expect(announcement).toContain('|count=1')
    expect(announcement).not.toContain('|count=0')
    await m.unmount()
  })

  it('select-all after a refresh checks the REFRESHED roster, not the mount-time one (D5)', async () => {
    // `selectAll` declares `[editDraft, pool]`, so the card's 60s poll recreates
    // it on every new pool object. Dropping `pool` from that array restores the
    // stale-closure class for the selector: "select all" would tick the accounts
    // the card knew about at MOUNT and silently ignore a sign-in that appeared
    // since, leaving a visible row uncheckable from that button.
    //
    // This test also settles what the round-4 campaign's two remaining
    // "survivors" mean. M20 (`const savedNow = saved`, read by `selectAll`) and
    // M22 (`const regionNow = region`, read by `runAction`) restore NO defect:
    // `saved` is a pure function of `pool`, and `pool`/`region` are declared
    // dependencies of the callbacks that read them, so the read cannot be
    // stale. They are EQUIVALENT mutants, not a coverage gap — the invariant
    // that can actually break is the dependency itself, and that is what this
    // asserts.
    const v1 = poolOf({
      memberAccountIds: [],
      effectiveMemberAccountIds: [],
      accounts: [GENUINE_ACCOUNT],
    })
    const props = baseProps({ pool: v1 })
    const m = await mount(AccountPool, props)
    expect(m.text()).toContain('row.poolSelectedCount|count=0|total=1')
    // A sign-in appears while the card is open; the poll delivers it.
    const v2 = poolOf({
      memberAccountIds: [],
      effectiveMemberAccountIds: [],
      accounts: [
        GENUINE_ACCOUNT,
        accountOf({ accountId: 'late-1', accountName: 'Late', member: false }),
      ],
    })
    await m.update({ ...props, pool: v2 })
    await m.click(m.button('row.poolSelectAll'))
    // Both accounts, including the one that did not exist at mount.
    expect(m.text()).toContain('row.poolSelectedCount|count=2|total=2')
    await m.unmount()
  })
})

describe('the pool section renders its guards (H-5 exits, on the render path)', () => {
  it('disables both batch buttons for a ghost-only pool', async () => {
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: ['ghost-1'],
        effectiveMemberAccountIds: [],
        accounts: [GENUINE_ACCOUNT],
      }),
    }))
    expect(m.button('row.poolCheckinAll').disabled).toBe(true)
    expect(m.button('row.poolTestAll').disabled).toBe(true)
    expect(m.text()).toContain('row.poolSelectedCount|count=0|total=1')
    await m.unmount()
  })
})

describe('every timestamp is a 24-hour clock (no AM/PM)', () => {
  it('renders the probe time and the retry time without a meridiem marker', async () => {
    // The defect: `Intl.DateTimeFormat` with NO `hourCycle` defers to the browser
    // locale, and en-US renders `09/30, 01:23 PM`. The card otherwise speaks
    // 24-hour, so one wall-clock glued to "AM/PM" is the single element a Chinese
    // user cannot scan past — and it is invisible to every non-render test,
    // because `Intl` output depends on a locale the node test runner does not
    // share with the browser.
    //
    // Both instants are built from LOCAL calendar fields, so the expected text is
    // the same on any machine: `Intl` formats in the local zone too.
    //
    // RELATIVE TO TODAY, not to a fixed date: a cooldown instant in the past is a
    // different state — the card stops printing 「05:20 之后可再用」 and states
    // 「恢复时间已到 · 待复核」 instead, because a future-tense date for an expired
    // moment is a lie. Fixed dates made this test pass until the calendar caught
    // up with them and then start asserting the wrong branch's text.
    const today = new Date()
    const testedAt = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 13, 23).getTime()  // yesterday 13:23 (1:23 PM)
    const retryAt = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 5, 20).getTime()    // tomorrow 05:20 (5:20 AM)
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: [GENUINE_ID, 'limited-1'],
        effectiveMemberAccountIds: [GENUINE_ID, 'limited-1'],
        accounts: [
          accountOf({ accountId: GENUINE_ID, accountName: 'Real One', current: true, probe: { outcome: 'ok', atMs: testedAt } }),
          accountOf({ accountId: 'limited-1', accountName: 'Limited', probe: { outcome: 'rate-limited', atMs: testedAt, retryAtMs: retryAt } }),
        ],
      }),
    }))
    const text = m.text()
    // 13:23 on a 24-hour clock; 01:23 PM on a 12-hour one. Any meridiem marker
    // therefore fails the LAST assertion below rather than this one.
    expect(text).toContain('13:23')
    expect(text).toContain('05:20')
    // The date/time SEPARATOR is locale-dependent (`Intl` with an undefined
    // locale emits `09/30, 13:23` under en-US and `09/30 13:23` under zh-CN/ja),
    // so only the digits are pinned here. Asserting the comma would have made
    // this test pass on an en-US machine and fail on the very locale the product
    // is written for.
    expect(text).toMatch(/row\.poolTestedAt\|at=\d{2}\/\d{2}[,、]?\s?\d{2}:\d{2}/u)
    expect(text).toMatch(/row\.poolRetryAt\|at=\d{2}\/\d{2}[,、]?\s?\d{2}:\d{2}/u)
    // The assertion with teeth: `Intl`'s locale default is the only thing that
    // can put a meridiem on screen, so its absence pins `hourCycle: 'h23'`.
    expect(text).not.toMatch(/\d{2}:\d{2}[ \u00a0]?(?:AM|PM)/u)
    await m.unmount()
  })
})

describe('the account in use is marked in words, not only by a tint', () => {
  it('names it in the pool header and tags its row', async () => {
    // The pool decides who is billed, so "who is it right now" is the first
    // question a reader has — and once failover exists it is not a rhetorical
    // one. A 7%-opacity row wash answers it only for someone already looking.
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: [GENUINE_ID, 'second-1'],
        effectiveMemberAccountIds: [GENUINE_ID, 'second-1'],
        accounts: [
          accountOf({ accountId: GENUINE_ID, accountName: 'Real One', current: true }),
          accountOf({ accountId: 'second-1', accountName: 'Second', current: false }),
        ],
      }),
    }))
    const text = m.text()
    expect(text).toContain('row.poolCurrentHeader|account=Real One')
    expect(text).toContain('row.poolCurrentBadge')
    // The paragraph that used to explain the badge here is GONE, along with the
    // header subtitle: both stated what the rest of the block already shows, and
    // two lines of prose above the first control is a lot of reading before
    // anything can be acted on. What must SURVIVE is the naming itself (asserted
    // above and by the row tag below), because a tint alone answers "who is in
    // use" only for someone already looking for it.
    expect(text, 'the removed explanation came back').not.toContain('row.poolCurrentHint')
    // Exactly one row carries the tag, and it is the current one.
    expect(m.container.querySelectorAll('.dsm-workbuddy-pool-current-tag')).toHaveLength(1)
    expect(m.container.querySelectorAll('.dsm-workbuddy-pool-row-current')).toHaveLength(1)
    await m.unmount()
  })

  it('says nothing about a current account when none is in effect', async () => {
    // A signed-in machine with no selectable account is a real state (an
    // orphaned saved id). Inventing a name would be worse than staying quiet.
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({ accounts: [accountOf({ accountId: GENUINE_ID, accountName: 'Real One', current: false })] }),
    }))
    expect(m.text()).not.toContain('row.poolCurrentHeader')
    expect(m.container.querySelectorAll('.dsm-workbuddy-pool-current-tag')).toHaveLength(0)
    await m.unmount()
  })
})

describe('the switch controls AUTOMATIC routing, not manual actions', () => {
  /** The pool switched off, with one checked account so a batch would be runnable. */
  function poolSwitchedOff(): Record<string, unknown> {
    return poolOf({
      enabled: false,
      memberAccountIds: [GENUINE_ID],
      effectiveMemberAccountIds: [GENUINE_ID],
      accounts: [GENUINE_ACCOUNT],
    })
  }

  it('keeps check-in and test usable while the pool is off', async () => {
    // "Manual mode" has to have a manual path. Gating these on the switch meant
    // switching the pool off ALSO disabled check-in and testing — and the Host
    // refused the request too, so there was no way to check in at all without
    // turning automatic routing back on. The switch answers "does the plugin
    // decide by itself", not "may the user act".
    const m = await mount(AccountPool, baseProps({ pool: poolSwitchedOff() }))
    const checkin = m.button('row.poolCheckinAll')
    const test = m.button('row.poolTestAll')
    expect(checkin.disabled, 'check-in must stay available with the pool off').toBe(false)
    expect(test.disabled, 'testing must stay available with the pool off').toBe(false)
    // And the switch really is off — otherwise this would pass on a pool that is
    // on and the test would be asserting nothing.
    expect(m.text()).toContain('row.poolEnabledHint')
    await m.unmount()
  })

  it('keeps the target-model choice editable while the pool is off', async () => {
    // The manual test needs a model to test against; disabling the picker with
    // the pool off made the one remaining manual measurement impossible to aim.
    //
    // Selector excludes `pool-account-select` on purpose: the manual-mode account
    // picker shares the `pool-select` class, so the bare selector matched
    // whichever rendered first rather than the model picker this test is about.
    const m = await mount(AccountPool, baseProps({ pool: poolSwitchedOff() }))
    const select = m.container.querySelector<HTMLSelectElement>(
      'select.dsm-workbuddy-pool-select:not(.dsm-workbuddy-pool-account-select)',
    )
    expect(select, 'no target-model select rendered').not.toBeNull()
    expect(select?.disabled).toBe(false)
    await m.unmount()
  })

  it('still refuses a batch over nothing, with the pool off', async () => {
    // The one guard that survives: an empty pool must never degrade into "then
    // do all of them". Unchecking everything is how a user says "none".
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({ enabled: false, memberAccountIds: [], effectiveMemberAccountIds: [], accounts: [GENUINE_ACCOUNT] }),
    }))
    expect(m.button('row.poolCheckinAll').disabled).toBe(true)
    expect(m.button('row.poolTestAll').disabled).toBe(true)
    await m.unmount()
  })
})

describe('manual mode can actually pick the serving account', () => {
  const OTHERS = [
    accountOf({ accountId: GENUINE_ID, accountName: 'Real One', current: true }),
    accountOf({ accountId: 'second-1', accountName: 'Second', current: false }),
  ]

  it('offers the picker while the pool is off, and calls back with the chosen id', async () => {
    // With the pool off nothing else picks the serving account — the ranking is
    // out of the picture — so this control IS manual mode. Removing it from the
    // card header without putting it here left the user stuck with whatever had
    // been selected before, which is what "no place to choose my account" was.
    const onSelectAccount = vi.fn()
    const m = await mount(AccountPool, baseProps({
      onSelectAccount,
      pool: poolOf({ enabled: false, accounts: OTHERS, memberAccountIds: [GENUINE_ID], effectiveMemberAccountIds: [GENUINE_ID] }),
    }))
    const select = m.container.querySelector<HTMLSelectElement>('select.dsm-workbuddy-pool-account-select')
    expect(select, 'no account picker rendered with the pool off').not.toBeNull()
    // It shows who is serving, and lists every account of the region.
    expect(select?.value).toBe(GENUINE_ID)
    expect(Array.from(select?.options ?? []).map(o => o.value)).toEqual([GENUINE_ID, 'second-1'])
    // Choosing another one is reported upward (the card owns the write).
    if (select !== null) {
      select.value = 'second-1'
      select.dispatchEvent(new window.Event('change', { bubbles: true }))
    }
    expect(onSelectAccount).toHaveBeenCalledWith('second-1')
    await m.unmount()
  })

  it('does NOT offer it while the pool is on', async () => {
    // With the pool ON the ranking decides, so a picker would change nothing
    // while looking authoritative — the exact "shows A, bills B" trap this card
    // keeps having to avoid. The manual row must be absent, not merely disabled.
    const m = await mount(AccountPool, baseProps({
      onSelectAccount: () => {},
      pool: poolOf({ enabled: true, accounts: OTHERS, memberAccountIds: [GENUINE_ID], effectiveMemberAccountIds: [GENUINE_ID] }),
    }))
    expect(m.container.querySelector('select.dsm-workbuddy-pool-account-select')).toBeNull()
    expect(m.text()).not.toContain('row.poolManualAccountLabel')
    await m.unmount()
  })

  it('holds the picker while a selection write is in flight', async () => {
    const m = await mount(AccountPool, baseProps({
      onSelectAccount: () => {},
      selectingAccount: true,
      pool: poolOf({ enabled: false, accounts: OTHERS }),
    }))
    const select = m.container.querySelector<HTMLSelectElement>('select.dsm-workbuddy-pool-account-select')
    expect(select?.disabled, 'a second change must not race the first write').toBe(true)
    await m.unmount()
  })

  it('keeps describing the RUNNING pool while the switch is an unsaved draft', async () => {
    // The draft/committed split, respected here for the same reason as
    // everywhere else in this section: Save is what makes an edit real. The
    // picker is part of the pool's RUNNING state, so an unsaved flip of the
    // switch must not change it — with `active.enabled` it did, revealing a
    // picker whose selection the still-running pool would override (the
    // "shows A, bills B" trap).
    const m = await mount(AccountPool, baseProps({
      onSelectAccount: () => {},
      pool: poolOf({ enabled: false, accounts: OTHERS, memberAccountIds: [GENUINE_ID], effectiveMemberAccountIds: [GENUINE_ID] }),
    }))
    // The pool is OFF on disk, so manual mode is what is running.
    expect(m.container.querySelector('select.dsm-workbuddy-pool-account-select')).not.toBeNull()
    // Flip the switch ON without saving: a dirty draft, not a running pool.
    await m.click(m.toggles()[0]!)
    // Manual mode is still what bills, so the picker and its note stay.
    expect(m.container.querySelector('select.dsm-workbuddy-pool-account-select')).not.toBeNull()
    expect(m.text()).toContain('row.poolEnabledHint')
    await m.unmount()
  })

  it('does not reveal the picker until a pool-off edit is SAVED', async () => {
    // The mirror case: with the pool ON the picker is absent, and an unsaved
    // "off" flip must not reveal it — the ranking still picks who serves.
    const m = await mount(AccountPool, baseProps({
      onSelectAccount: () => {},
      pool: poolOf({ enabled: true, accounts: OTHERS, memberAccountIds: [GENUINE_ID], effectiveMemberAccountIds: [GENUINE_ID] }),
    }))
    expect(m.container.querySelector('select.dsm-workbuddy-pool-account-select')).toBeNull()
    await m.click(m.toggles()[0]!)
    expect(m.container.querySelector('select.dsm-workbuddy-pool-account-select')).toBeNull()
    // The edit is still registered, so Save stays available.
    expect(m.button('row.poolSaved').disabled).toBe(false)
    await m.unmount()
  })
})

describe('the settings commit row matches the model section', () => {
  it('leads with the encouragement link and puts the buttons last', async () => {
    // The card has exactly two "commit your edits" rows: the pool's and the model
    // section's. They must not teach different muscle memory — the model row
    // already leads with the star link and ends with its buttons, and the pool row
    // used to do the opposite (buttons first, hint last).
    const m = await mount(AccountPool, baseProps({ pool: poolOf({ enabled: true }) }))
    const bar = m.container.querySelector('.dsm-workbuddy-pool-save-bar')
    expect(bar, 'no commit row rendered').not.toBeNull()

    const order = Array.from(bar?.children ?? []).map(node => node.className)
    // Cheer first, then the hint, then the buttons wrapper.
    expect(order[0], 'the encouragement link must lead, as in the model row')
      .toContain('dsm-workbuddy-usage-cheer')
    // Exactly two groups now: the status line between them was removed (the Save
    // button's own enabled state carries that information).
    expect(order, 'the row must hold only the link and the buttons').toHaveLength(2)
    expect(order[1], 'the buttons must be the last group').toContain('dsm-workbuddy-pool-save-buttons')

    // The link is a real external link, not decoration.
    const cheer = bar?.querySelector<HTMLAnchorElement>('a.dsm-workbuddy-usage-cheer')
    expect(cheer?.href, 'the encouragement link lost its target').toContain('github.com')
    expect(cheer?.getAttribute('rel')).toContain('noopener')
    await m.unmount()
  })

  it('keeps 放弃修改 to the left of 保存, inside the buttons group', async () => {
    // Same order as the model row. Swapping them puts the destructive action where
    // the confirming one was, one click away from a habit.
    const m = await mount(AccountPool, baseProps({ pool: poolOf({ enabled: true }) }))
    const buttons = m.container.querySelector('.dsm-workbuddy-pool-save-buttons')
    expect(buttons, 'no buttons group rendered').not.toBeNull()
    const labels = Array.from(buttons?.querySelectorAll('button') ?? []).map(b => b.textContent ?? '')
    expect(labels).toHaveLength(2)
    expect(labels[0], 'the secondary action must come first').toContain('row.poolDiscard')
    expect(labels[1], 'the primary action must come last').toContain('row.poolSaved')
    await m.unmount()
  })
})

describe('the commit row states its own availability', () => {
  // `makeDirty` is scoped to another describe, so this block needs its own copy:
  // unchecking the only member is an edit, and any edit dirties the draft.
  async function dirtyTheDraft(m: Awaited<ReturnType<typeof mount>>): Promise<void> {
    const box = m.checkboxes()[0]
    if (box === undefined) throw new Error('no member checkbox rendered')
    await m.click(box)
  }

  it('gates BOTH buttons on dirtiness — there is nothing to save or discard otherwise', async () => {
    // The status line that used to say this in words is gone, so the buttons are
    // now the only thing that can. Asserted for Discard too: it was never checked
    // before (the old tests read the hint text instead), which left "Discard
    // enabled with nothing to discard" undetected.
    const clean = await mount(AccountPool, baseProps())
    expect(clean.button('row.poolSaved').disabled, 'Save must be off while clean').toBe(true)
    expect(clean.button('row.poolDiscard').disabled, 'Discard must be off while clean').toBe(true)
    await clean.unmount()

    const dirty = await mount(AccountPool, baseProps())
    await dirtyTheDraft(dirty)
    expect(dirty.button('row.poolSaved').disabled, 'Save must turn on once dirty').toBe(false)
    expect(dirty.button('row.poolDiscard').disabled, 'Discard must turn on once dirty').toBe(false)
    await dirty.unmount()
  })
})

describe('the pool header states nothing twice', () => {
  it('leaves the header to the title and the badge', async () => {
    // The subtitle ("N accounts in this region · target model X") was removed:
    // the account count IS the member table's row count, and the target model is
    // the value of the control right below. Two lines of prose before the first
    // control is a lot of reading before anything can be acted on.
    const m = await mount(AccountPool, baseProps())
    expect(m.container.querySelector('.dsm-workbuddy-pool-summary'), 'the subtitle came back').toBeNull()
    expect(m.text(), 'the target model is stated outside its setting row').not.toContain('row.poolSummary')
    // The title is still there — this is a removal of the SUBTITLE, not the head.
    expect(m.container.querySelector('.dsm-workbuddy-pool-title')).not.toBeNull()
    await m.unmount()
  })

  it('states the target model once — in its picker, not again beside it', async () => {
    // This used to assert the opposite: the row printed "当前：X（你指定）" next to
    // a select whose visible value IS X. That is the same id twice in one line of
    // pixels, and a third copy sat in every table row ("模型 X" on each measured
    // account) even though the pool has exactly one test model. A sentence now
    // appears only when it says something the picker cannot: that the pool chose
    // the model itself, so the user did not.
    const preferred = await mount(AccountPool, baseProps({
      pool: poolOf({ targetModelSource: 'preferred', targetModelId: 'deepseek-v4.1-flash' }),
    }))
    const select = preferred.container.querySelector('select.dsm-workbuddy-pool-select') as HTMLSelectElement | null
    expect(select, 'the picker is where the model is stated').not.toBeNull()
    expect(select!.value, 'the picker must show the model the pool will use').toBe('deepseek-v4.1-flash')
    expect(preferred.text(), 'the picker already shows this; the sentence restates it').not.toContain('row.poolTargetCurrentPreferred')
    await preferred.unmount()

    const free = await mount(AccountPool, baseProps({
      pool: poolOf({ targetModelSource: 'free', targetModelId: 'free-1' }),
    }))
    expect(free.text(), 'a model the user did not choose still says so').toContain('row.poolTargetCurrentFree')
    await free.unmount()
  })
})

describe('the probe-size picker really controls the request size', () => {
  /** The pool switched off, with one checked account so a batch would be runnable. */
  function poolSwitchedOffHere(): Record<string, unknown> {
    return poolOf({
      enabled: false,
      memberAccountIds: [GENUINE_ID],
      effectiveMemberAccountIds: [GENUINE_ID],
      accounts: [GENUINE_ACCOUNT],
    })
  }

  /**
   * The probe picker, found by its own option text.
   *
   * NOT by class: it deliberately shares `.dsm-workbuddy-pool-select` with the
   * model picker and the manual-mode account picker, so a class-only selector
   * matches whichever rendered first and would silently assert on the wrong
   * control — the trap the model-picker test already documents.
   */
  function probeSelect(m: { container: HTMLDivElement }): HTMLSelectElement | null {
    return Array.from(m.container.querySelectorAll('select')).find(
      select => select.innerHTML.includes('row.poolProbeSizeDefault'),
    ) ?? null
  }

  it('offers exactly the sizes the host honours, in order', async () => {
    // The menu is driven by the same exported list the host's coercion reads, so
    // a size the user can pick is always a size that will be sent. Hard-coding a
    // second menu in the component is how the two drift apart into "I chose 50K
    // and it tested at 25K".
    const m = await mount(AccountPool, baseProps({}))
    const select = probeSelect(m)
    expect(select, 'no probe-size select rendered').not.toBeNull()
    // '0' is the default option; the rest are the shared choices.
    expect(Array.from(select?.options ?? []).map(option => option.value))
      .toEqual(['0', '10000', '20000', '30000', '50000', '100000'])
    await m.unmount()
  })

  it('saves the chosen size as a NUMBER, and dirtiness follows it', async () => {
    // Two claims at once, both user-visible: picking a size makes the save
    // pending (so the edit is not silently lost), and the value that reaches the
    // write is the number rather than the option string or NaN.
    const onSaved = vi.fn(async () => true)
    const scope = fakeScope({})
    const m = await mount(AccountPool, baseProps({ settingsScope: scope, onSaved }))
    const select = probeSelect(m) as HTMLSelectElement
    expect(select.value, 'a host with no stored choice must show the default').toBe('0')
    expect(m.button('row.poolSaved').disabled, 'nothing edited yet — Save starts disabled').toBe(true)
    await m.choose(select, '50000')
    expect(m.button('row.poolSaved').disabled, 'the size edit must make the save pending').toBe(false)
    await m.click(m.button('row.poolSaved'))
    expect(onSaved).toHaveBeenCalledTimes(1)
    // The saved document carries the number under the region's pool slot.
    const regions = (scope.getSnapshot().value as { regions?: Record<string, { pool?: Record<string, unknown> }> }).regions
    expect(regions?.cn?.pool?.['probeInputTokens']).toBe(50_000)
    await m.unmount()
  })

  it('shows the saved size as selected, not the default', async () => {
    // The controlled-select trap: if a saved value had no matching option (or
    // the value were bound as a number against string options), the browser would
    // fall back to displaying the FIRST option — claiming "默认" while the disk
    // held 100000, and the next save would write the default over the choice.
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: [GENUINE_ID],
        effectiveMemberAccountIds: [GENUINE_ID],
        accounts: [GENUINE_ACCOUNT],
        probeInputTokens: 100_000,
      }),
    }))
    const select = probeSelect(m)
    expect(select?.value).toBe('100000')
    // And it must not read as dirty, or a user who changed nothing would see a
    // pending save the moment the panel rendered.
    expect(m.button('row.poolSaved').disabled, 'a freshly loaded panel is not dirty').toBe(true)
    await m.unmount()
  })

  it('leaves the picker editable while the pool switch is off', async () => {
    // Same reasoning as the model picker: with the pool off the manual test is
    // the ONLY way to measure an account, and the size is the question that test
    // asks — so disabling its control would defeat the feature.
    const m = await mount(AccountPool, baseProps({ pool: poolSwitchedOffHere() }))
    const select = probeSelect(m)
    expect(select, 'no probe-size select rendered with the pool off').not.toBeNull()
    expect(select?.disabled).toBe(false)
    await m.unmount()
  })
})

describe('the pool toolbar is one row of two clusters', () => {
  it('groups account actions on the left and discovery on the right', async () => {
    // Before: the rescan button sat alone on a row pushed right, and the batch
    // buttons sat on the NEXT row pushed left — two alignments two lines apart
    // with nothing explaining the split.
    const m = await mount(AccountPool, baseProps({ onRescan: () => {} }))
    const bar = m.container.querySelector('.dsm-workbuddy-pool-actions')
    expect(bar, 'no toolbar rendered').not.toBeNull()
    const groups = Array.from(bar?.children ?? []).filter(n => n.className.includes('dsm-workbuddy-pool-actions-group'))
    expect(groups, 'the toolbar is not two clusters').toHaveLength(2)
    // Left cluster: the batch actions. Right cluster: the rescan.
    expect(groups[0]?.textContent, 'the batch actions are not in the left cluster')
      .toContain('row.poolCheckinAll')
    expect(groups[1]?.textContent, 'the rescan is not in the right cluster')
      .toContain('row.accountsRescan')
    // And nothing sits outside a cluster (a stray child would break the layout).
    expect(Array.from(bar?.children ?? []).every(n => n.className.includes('dsm-workbuddy-pool-actions-group'))).toBe(true)
    await m.unmount()
  })

  it('keeps the rescan OUT of the header', async () => {
    // It moved into the toolbar, so the old standalone row must not linger.
    const m = await mount(AccountPool, baseProps({ onRescan: () => {} }))
    expect(m.container.querySelector('.dsm-workbuddy-pool-rescan')).toBeNull()
    await m.unmount()
  })

  it('hangs the bar under the member heading, above the rows it acts on', async () => {
    // The buttons act on the CHECKED set. That set is described one line above
    // it (「已选 N / M」 + 全选 / 全不选) and selected in the table one line
    // below — so the bar belongs between the two. It used to sit ABOVE the whole
    // member block, reading as a page-level toolbar with nothing to act on yet.
    const m = await mount(AccountPool, baseProps({ onRescan: () => {} }))
    const bar = m.container.querySelector('.dsm-workbuddy-pool-actions')!
    const head = m.container.querySelector('.dsm-workbuddy-pool-members-head')!
    const table = m.container.querySelector('.dsm-workbuddy-pool-table')!
    expect(head.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the bar must come AFTER the member heading it acts for').toBeTruthy()
    expect(bar.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the bar must come BEFORE the rows it acts on').toBeTruthy()
    // And inside the member block, not a sibling of it: it is part of that block
    // in the DOM, which is what makes it survive the block being re-ordered.
    expect(bar.closest('.dsm-workbuddy-pool-members'), 'the bar escaped the member block').not.toBeNull()
    await m.unmount()
  })
})

describe('the pool table says WHY a member is out, not just THAT it is', () => {
  it('appends a SHORT reason, not the raw upstream body', async () => {
    // Before the message was persisted, a DNS failure, a gateway 502 and a
    // request the user cancelled all rendered as the SAME sentence. That left a
    // message nobody could act on, and no way to tell a broken account from a
    // broken network — which is exactly the question this table exists to
    // answer. The upstream's own words are what separate them.
    //
    // But "the upstream's own words" cannot mean the raw body: what is appended
    // here is the SHORT form (`probe-reason.ts`), which is also why the redundant
    // `transport error:` prefix is gone. The full text stays as a tooltip.
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: ['down-1'],
        effectiveMemberAccountIds: ['down-1'],
        accounts: [
          accountOf({
            accountId: 'down-1',
            accountName: 'Down',
            probe: {
              outcome: 'unavailable',
              atMs: 1_800_000_000_000,
              message: 'transport error: AbortError',
            },
          }),
        ],
      }),
    }))
    const text = m.text()
    expect(text).toContain('AbortError')
    expect(text, 'the redundant English prefix is noise in a Chinese card')
      .not.toContain('transport error:')
    // The label must survive alongside it: the message replaces nothing, it
    // explains the outcome the row already states.
    expect(text).toContain('row.probeUnavailable')
    // Shortened, never lost.
    expect(m.html()).toContain('transport error: AbortError')
    await m.unmount()
  })

  it('renders the bare outcome when no message was recorded', async () => {
    // Probe files written before the field existed carry no `message`. They must
    // still render — an `undefined` leaking into the cell would be worse than the
    // generic sentence, because it reads as a plugin bug rather than a fact.
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: ['down-2'],
        effectiveMemberAccountIds: ['down-2'],
        accounts: [
          accountOf({
            accountId: 'down-2',
            accountName: 'Down Two',
            probe: { outcome: 'unavailable', atMs: 1_800_000_000_000 },
          }),
        ],
      }),
    }))
    const text = m.text()
    expect(text).toContain('row.probeUnavailable')
    expect(text).not.toContain('undefined')
    await m.unmount()
  })

  it('adds how long is left beside the instant the upstream named', async () => {
    // The instant alone answers "when" but forces a subtraction from the clock
    // in the reader's head. Both must appear: the instant is the upstream's own
    // answer and stays authoritative, while the relative form is what makes the
    // wait scannable. Two hours out, so the expected unit is unambiguous.
    const retryAt = Date.now() + 2 * 60 * 60_000
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: ['limited-9'],
        effectiveMemberAccountIds: ['limited-9'],
        accounts: [
          accountOf({
            accountId: 'limited-9',
            accountName: 'Limited Nine',
            probe: { outcome: 'rate-limited', atMs: Date.now(), retryAtMs: retryAt },
          }),
        ],
      }),
    }))
    const text = m.text()
    expect(text).toContain('row.poolRetryAt|at=')
    expect(text).toContain('row.remainingHours|count=2')
    await m.unmount()
  })

  it('adds no relative text for an outcome that named no time', async () => {
    // The whole feature forbids inventing a countdown. An outcome without a
    // stated time must keep saying exactly that, with nothing appended — a
    // fabricated "in 30 minutes" would look like an upstream answer.
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: ['limited-8'],
        effectiveMemberAccountIds: ['limited-8'],
        accounts: [
          accountOf({
            accountId: 'limited-8',
            accountName: 'Limited Eight',
            probe: { outcome: 'rate-limited', atMs: Date.now() },
          }),
        ],
      }),
    }))
    const text = m.text()
    expect(text).toContain('row.poolRetryUnknown')
    expect(text).not.toContain('row.remaining')
    await m.unmount()
  })

  it('does not restate a limit body that only duplicates the time beside it', async () => {
    // A 429 body is `{"code":6004,…将在 <the same instant> 重置…,"requestId":…}`.
    // Inlining it would print the reset time THREE times and bury the row's real
    // content under a duplicate of itself. Suppressed inline — but it must stay
    // reachable, so the same text goes on the element as a tooltip.
    const body = '{"code":6004,"msg":"将在 2026-10-02 05:23:27 重置","requestId":"abc"}'
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: ['limited-7'],
        effectiveMemberAccountIds: ['limited-7'],
        accounts: [
          accountOf({
            accountId: 'limited-7',
            accountName: 'Limited Seven',
            probe: {
              outcome: 'rate-limited',
              atMs: Date.now(),
              retryAtMs: Date.now() + 2 * 60 * 60_000,
              message: body,
            },
          }),
        ],
      }),
    }))
    const text = m.text()
    expect(text, 'the duplicate body was inlined').not.toContain('requestId')
    expect(text, 'the row lost its recovery time').toContain('row.remainingHours|count=2')
    expect(m.html(), 'the upstream text is unreachable once suppressed').toContain('title=')
    await m.unmount()
  })
})

describe('a streamed test batch reports each account as it lands', () => {
  /** One NDJSON frame. */
  const frame = (payload: Record<string, unknown>): string => `${JSON.stringify(payload)}\n`

  /** A streamed answer: a header line, two accounts, then completion. */
  function streamOf(): string {
    return frame({ action: 'test', modelId: 'free-1' })
      + frame({ row: { accountId: GENUINE_ID, accountName: 'Real One', result: { modelId: 'free-1', outcome: 'ok' } } })
      + frame({ row: { accountId: 'beta', accountName: 'Beta', result: { modelId: 'free-1', outcome: 'rate-limited' } } })
      + frame({ done: true })
  }

  /**
   * Empty the activity log before asserting on it.
   *
   * The log is deliberately per-REGION and outlives a mount (a remount continues
   * the same history), so within one test file it accumulates. An assertion that
   * something was NOT logged would otherwise pass or fail on a previous test's
   * entries rather than on this one's.
   */
  async function clearLog(m: Awaited<ReturnType<typeof mount>>): Promise<void> {
    const clear = m.buttons().find(button => button.textContent?.includes('row.poolLogClear'))
    if (clear !== undefined) await m.click(clear)
  }

  it('logs one line per account from the stream, then the completion', async () => {
    // The route streams NDJSON for tests so the card can report progress instead
    // of holding everything until the slowest member answers. This pins the
    // CLIENT half: each `row` frame becomes one log entry, and the completion
    // line comes from `done` rather than from the response ending.
    stubFetch(url => url.includes('/pool')
      ? { body: streamOf(), contentType: 'application/x-ndjson' }
      : { body: {} })
    const onRefresh = vi.fn()
    const m = await mount(AccountPool, baseProps({ onRefresh }))
    await clearLog(m)
    await m.click(m.button('row.poolTestAll'))
    await m.settle()
    const text = m.text()
    // The outcome is rendered through the SAME labels the table uses, so one
    // measurement cannot be described two ways in one card.
    expect(text).toContain('row.poolLogTestRow|accountName=Real One|outcome=row.probeOk')
    expect(text).toContain('row.poolLogTestRow|accountName=Beta|outcome=row.poolExcludedRateLimited')
    expect(text).toContain('row.poolLogTestDone')
    expect(onRefresh, 'a successful stream must still re-read the usage').toHaveBeenCalledTimes(1)
    await m.unmount()
  })

  it('reports a mid-stream failure as the batch error and does NOT re-read', async () => {
    // Once the first line is written the status code is committed, so a failure
    // arrives as a frame. It must still be treated as a failure: no completion
    // line, and no usage re-read that would paper over it.
    stubFetch(url => url.includes('/pool')
      ? { body: frame({ row: { accountId: GENUINE_ID, accountName: 'Real One', result: { modelId: 'free-1', outcome: 'ok' } } })
          + frame({ reason: 'pool-failed', error: 'upstream exploded' }), contentType: 'application/x-ndjson' }
      : { body: {} })
    const onRefresh = vi.fn()
    const m = await mount(AccountPool, baseProps({ onRefresh }))
    await clearLog(m)
    await m.click(m.button('row.poolTestAll'))
    await m.settle()
    const text = m.text()
    expect(text).toContain('row.poolLogTestRow|accountName=Real One|outcome=row.probeOk')
    expect(text, 'a failed stream must not be announced as complete').not.toContain('row.poolLogTestDone')
    expect(text).toContain('row.poolLogBatchFailed')
    expect(onRefresh, 'a failed batch must not re-read').not.toHaveBeenCalled()
    await m.unmount()
  })

  it('puts the measurement age and writer on their OWN line, not the outcome line', async () => {
    // The two facts that make an unexpected value explainable. They answer a
    // different question from the outcome line, and appending them to it made one
    // dense run a reader scans past — so they must render as a second element.
    // A mutant that folds them back into one string fails this.
    stubFetch(() => ({ body: {} }))
    const real = accountOf({
      accountId: GENUINE_ID,
      accountName: 'Real One',
      current: true,
      probe: { outcome: 'ok', atMs: Date.now(), source: 'test-batch' },
    })
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: [GENUINE_ID],
        effectiveMemberAccountIds: [GENUINE_ID],
        accounts: [real],
      }),
    }))
    const probe = m.container.querySelector('.dsm-workbuddy-pool-probe')
    expect(probe, 'the probe cell must exist').not.toBeNull()
    const main = probe!.querySelector('.dsm-workbuddy-pool-probe-main')
    const prov = probe!.querySelector('.dsm-workbuddy-pool-probe-prov')
    expect(main, 'the outcome line must be its own element').not.toBeNull()
    expect(prov, 'provenance must be its own element, not appended to the outcome').not.toBeNull()
    // The outcome line must NOT carry the provenance text: that is the mutant.
    expect(main!.textContent).not.toContain('row.poolProbeSourceTest')
    expect(prov!.textContent).toContain('row.poolProbeSourceTest')
    expect(prov!.textContent).toContain('row.poolProbeJustNow')
    await m.unmount()
  })

  it('marks a live-request write with its own pill class', async () => {
    // "hit by a live request" is the one readable distinction on that line: it
    // explains a change the user would otherwise read as a bug. If it renders
    // with the same class as the neutral "tested", the distinction is invisible
    // and the whole point of recording the source is lost.
    stubFetch(() => ({ body: {} }))
    const real = accountOf({
      accountId: GENUINE_ID,
      accountName: 'Real One',
      current: true,
      probe: { outcome: 'rate-limited', atMs: Date.now(), source: 'live-request', retryAtMs: Date.now() + 3_600_000 },
    })
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: [GENUINE_ID],
        effectiveMemberAccountIds: [GENUINE_ID],
        accounts: [real],
      }),
    }))
    const tag = m.container.querySelector('.dsm-workbuddy-pool-probe-prov .dsm-workbuddy-pool-prov-tag')
    expect(tag, 'the writer must render as a pill').not.toBeNull()
    expect(tag!.className).toContain('dsm-workbuddy-pool-prov-live')
    expect(tag!.textContent).toBe('row.poolProbeSourceLive')
    await m.unmount()
  })

  it('says "source unknown" for a record written before the field existed', async () => {
    // The honest answer. Guessing a writer for the one row the user is asking
    // about would be worse than admitting the record predates the field.
    stubFetch(() => ({ body: {} }))
    const real = accountOf({
      accountId: GENUINE_ID,
      accountName: 'Real One',
      current: true,
      probe: { outcome: 'ok', atMs: Date.now() },
    })
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: [GENUINE_ID],
        effectiveMemberAccountIds: [GENUINE_ID],
        accounts: [real],
      }),
    }))
    const prov = m.container.querySelector('.dsm-workbuddy-pool-probe-prov')
    expect(prov, 'an old record still has an age worth showing').not.toBeNull()
    expect(prov!.textContent).toContain('row.poolProbeSourceUnknown')
    const tag = prov!.querySelector('.dsm-workbuddy-pool-prov-unknown')!
    expect(tag.className).toContain('dsm-workbuddy-pool-prov-unknown')
    // The unknown pill must keep the BASE tag class too, because that is what
    // carries `font-weight:600` and the pill background. An earlier version gave
    // this state `background:none; border:1px dashed; font-weight:400` — four
    // simultaneous weakenings that made 10px text genuinely hard to read, which
    // is how it shipped to a reader who reported exactly that. "This record
    // predates the field" is still worth saying loudly enough to be legible.
    expect(tag.className, 'the unknown pill must keep the base pill styling').toContain('dsm-workbuddy-pool-prov-tag')
    await m.unmount()
  })

  it('renders no provenance line at all for an untested account', async () => {
    // An empty second line would add height to every row while explaining
    // nothing; an untested account has no measurement to date.
    stubFetch(() => ({ body: {} }))
    const real = accountOf({ accountId: GENUINE_ID, accountName: 'Real One', current: true })
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: [GENUINE_ID],
        effectiveMemberAccountIds: [GENUINE_ID],
        accounts: [real],
      }),
    }))
    expect(m.container.querySelector('.dsm-workbuddy-pool-probe-prov')).toBeNull()
    expect(m.text()).toContain('row.poolNeverTested')
    await m.unmount()
  })
})

/**
 * Manual priority (`orderAccountIds`) — the user-visible contract of "move this
 * account up/down".
 *
 * These run against the REAL component because the whole point is what the user
 * sees: the row order, which account holds which rank badge, and whether the
 * arrows are clickable. Every assertion is on the DOM, so a mutant that
 * respells the comparator or the draft edit cannot slip past.
 */
describe('manual priority: rows, rank badges and the up/down arrows', () => {
  /** Three ordered members, deliberately rendered in a DIFFERENT order than saved. */
  function threeMembers(savedOrder: string[], accounts?: unknown[]): Record<string, unknown> {
    const ids = ['a', 'b', 'c']
    return baseProps({
      pool: poolOf({
        memberAccountIds: ids,
        effectiveMemberAccountIds: ids,
        orderAccountIds: savedOrder,
        accounts: accounts ?? ids.map(id => accountOf({
          accountId: id,
          accountName: `Name ${id.toUpperCase()}`,
          current: id === 'a',
        })),
      }),
    })
  }

  /** The account ids of the rendered table rows, top to bottom. */
  function renderedIds(m: Awaited<ReturnType<typeof mount>>): string[] {
    return Array.from(m.container.querySelectorAll<HTMLInputElement>('.dsm-workbuddy-pool-table input[type=checkbox]'))
      .map(box => (box.getAttribute('aria-label') ?? '').replace(/^.*accountName=/, '').replace(/\|.*$/, ''))
  }

  it('renders rows in the SAVED order, not in the accounts array order', async () => {
    // The `accounts` array arrives in whatever order the Host built it, and the
    // saved order is what the user dragged into place. If the table ignored
    // `orderAccountIds`, the arrows would visibly do nothing after a save.
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, threeMembers(['c', 'a', 'b']))
    expect(renderedIds(m)).toEqual(['Name C', 'Name A', 'Name B'])
    await m.unmount()
  })

  it('renders the accounts-array order when nothing is saved', async () => {
    // The "never sorted" state must be byte-identical to the pre-feature
    // behaviour: no rearrangement at all.
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, threeMembers([]))
    expect(renderedIds(m)).toEqual(['Name A', 'Name B', 'Name C'])
    await m.unmount()
  })

  it('numbers each badge by its RENDERED position', async () => {
    // The number is the row's rank, so it must be derived from the sorted
    // sequence. Numbering the badge from the raw array index would print
    // "第 1 位" beside whatever account happened to arrive first.
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, threeMembers(['c', 'a', 'b']))
    const badges = Array.from(m.container.querySelectorAll('.dsm-workbuddy-pool-rank'))
      .map(node => node.textContent ?? '')
    expect(badges).toEqual([
      'row.poolRankLabel|rank=1',
      'row.poolRankLabel|rank=2',
      'row.poolRankLabel|rank=3',
    ])
    await m.unmount()
  })

  it('shows the dashed "automatic" badge — and NO number — when no order is saved', async () => {
    // A numeric rank next to a credit-policy order would be a lie: that order
    // reshuffles on every refresh, so "第 2 位" would describe a position the
    // pool is not going to keep. The auto state says so instead.
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, threeMembers([]))
    const badges = Array.from(m.container.querySelectorAll('.dsm-workbuddy-pool-rank'))
    expect(badges.length).toBe(3)
    for (const badge of badges) {
      expect(badge.textContent).toBe('row.poolRankAuto')
      expect(badge.className).toContain('dsm-workbuddy-pool-rank-auto')
    }
    expect(m.text()).not.toContain('row.poolRankLabel')
    await m.unmount()
  })

  it('gives every row exactly two arrows and disables the first/last edges', async () => {
    // The arrows are buttons; a disabled edge keeps the row from shifting when
    // an account is already at an end, and "exactly two per row" is the count
    // the CSS lays out.
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, threeMembers(['c', 'a', 'b']))
    const up = Array.from(m.container.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-pool-move-btn'))
      .filter(button => button.textContent === '↑')
    const down = Array.from(m.container.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-pool-move-btn'))
      .filter(button => button.textContent === '↓')
    expect(up.length).toBe(3)
    expect(down.length).toBe(3)
    // Rendered order is c, a, b — so c's ↑ and b's ↓ are the disabled edges.
    expect(up[0]!.disabled, 'the TOP row cannot move up').toBe(true)
    expect(down[2]!.disabled, 'the BOTTOM row cannot move down').toBe(true)
    expect(up[1]!.disabled).toBe(false)
    expect(down[1]!.disabled).toBe(false)
    await m.unmount()
  })

  it('offers the arrows while the pool switch is still an UNSAVED draft', async () => {
    // The natural flow is: tick an account, order it, press Save ONCE. Gating
    // the arrows on the SAVED switch made them not exist until a save the user
    // had no reason to suspect was required, so the order looked impossible to
    // set — and the next Save then had nothing to write. The arrows describe the
    // DRAFT, so the draft's `enabled` is what they must read.
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        // The Host has the pool OFF; the draft is about to turn it on.
        enabled: false,
        memberAccountIds: ['a', 'b'],
        effectiveMemberAccountIds: ['a', 'b'],
        orderAccountIds: [],
        accounts: [
          accountOf({ accountId: 'a', accountName: 'Name A', current: true }),
          accountOf({ accountId: 'b', accountName: 'Name B' }),
        ],
      }),
    }))
    // Turn the pool on in the DRAFT only (no save yet)…
    // The switch lives in the mode bar (which carries `pool-settings` too), and
    // the member checkboxes live in the table — so the mode bar's own checkbox
    // is the ONE under `.dsm-workbuddy-pool-modebar`.
    const poolSwitch = m.container.querySelector<HTMLInputElement>(
      '.dsm-workbuddy-pool-modebar input[type=checkbox]',
    )
    expect(poolSwitch, 'the pool switch must render').not.toBeNull()
    await m.click(poolSwitch!)
    await m.settle()
    // …and the member rows must already offer their arrows.
    expect(
      m.container.querySelectorAll('.dsm-workbuddy-pool-move-btn').length,
      'a ticked member must be orderable before Save',
    ).toBe(4)
    await m.unmount()
  })

  it('the badge is NOT a button — it only describes the order', async () => {
    // Rendering it as an inert <button> would announce a control that does
    // nothing, and inflate the row's button count (2 arrows + N inert badges).
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, threeMembers(['c', 'a', 'b']))
    const badge = m.container.querySelector('.dsm-workbuddy-pool-rank')!
    expect(badge.tagName).toBe('SPAN')
    // Three ordered rows => exactly six move buttons and no more. Counting the
    // whole `.dsm-workbuddy-pool-row` subtree would also pick up each row's
    // Test / Remove actions and the header row (which shares the class), so the
    // selector is narrowed to the arrows themselves.
    expect(m.container.querySelectorAll('.dsm-workbuddy-pool-move-btn').length).toBe(6)
    expect(m.container.querySelectorAll('.dsm-workbuddy-pool-rank button').length).toBe(0)
    await m.unmount()
  })

  it('clicking ↓ moves the row down and marks the draft dirty', async () => {
    // The end-to-end promise. Save is a DRAFT edit (not a straight write), so
    // the observable proof is: rows reorder, and Save becomes enabled because
    // the order now differs from what the Host has.
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, threeMembers([]))
    expect(m.button('row.poolSaved').disabled, 'nothing edited yet').toBe(true)
    const downOnTopRow = Array.from(
      m.container.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-pool-row .dsm-workbuddy-pool-move-btn'),
    ).filter(button => button.textContent === '↓')[0]!
    await m.click(downOnTopRow)
    expect(renderedIds(m)).toEqual(['Name B', 'Name A', 'Name C'])
    expect(m.button('row.poolSaved').disabled, 'the reorder is an unsaved edit').toBe(false)
    await m.unmount()
  })

  it('the FIRST move sorts the WHOLE visible order, not just the swapped pair', async () => {
    // Clicking ↑ on an unsorted pool must persist every row's position. A
    // draft that wrote only the moved id would leave the other rows unordered
    // (and the badges would fall back to "automatic"), so this pins the
    // "materialise the current order on first edit" behaviour.
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, threeMembers([]))
    const upOnMiddle = Array.from(
      m.container.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-pool-row .dsm-workbuddy-pool-move-btn'),
    ).filter(button => button.textContent === '↑')[1]!
    await m.click(upOnMiddle)
    expect(renderedIds(m)).toEqual(['Name B', 'Name A', 'Name C'])
    // Now MANUAL: numbers replace the dashed badge.
    const badges = Array.from(m.container.querySelectorAll('.dsm-workbuddy-pool-rank')).map(n => n.textContent)
    expect(badges).toEqual([
      'row.poolRankLabel|rank=1',
      'row.poolRankLabel|rank=2',
      'row.poolRankLabel|rank=3',
    ])
    await m.unmount()
  })

  it('persists the reordered ids through Save', async () => {
    // The save must carry POSITIONAL ids. A set-shaped write would reorder the
    // pool arbitrarily on the next load and the user's drag would be lost.
    const calls = stubFetch((url) => url.includes('__save')
      ? { body: { ok: true } }
      : { body: {} })
    const scope = fakeScope({})
    const props = baseProps({
      settingsScope: scope,
      pool: poolOf({
        memberAccountIds: ['a', 'b'],
        effectiveMemberAccountIds: ['a', 'b'],
        orderAccountIds: ['a', 'b'],
        accounts: [
          accountOf({ accountId: 'a', accountName: 'Name A', current: true }),
          accountOf({ accountId: 'b', accountName: 'Name B' }),
        ],
      }),
    })
    const m = await mount(AccountPool, props)
    const downOnTop = Array.from(
      m.container.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-pool-row .dsm-workbuddy-pool-move-btn'),
    ).filter(button => button.textContent === '↓')[0]!
    await m.click(downOnTop)
    expect(renderedIds(m)).toEqual(['Name B', 'Name A'])
    await m.click(m.button('row.poolSaved'))
    await m.settle()
    // The Host endpoint is the authoritative write path (`writeField` tries it
    // FIRST, so `scope.set` is only a best-effort mirror refresh and records
    // nothing here). Read the order out of the request body the card actually
    // sent — that is the value the Host persists.
    const saveBodies = calls
      .filter(call => call.url.includes('__save'))
      .map(call => JSON.parse(String(call.init.body)) as { field: string, value: Record<string, any> })
    const regions = saveBodies.find(body => body.field === 'regions')
    expect(regions, 'the pool must be saved through the regions field').toBeDefined()
    const poolWrite = Object.values(regions!.value).map((slot: any) => slot?.pool).filter(Boolean).pop()
    expect(poolWrite?.orderAccountIds, 'the swapped order must be what was saved').toEqual(['b', 'a'])
    // …and it must be POSITIONAL, not a re-sorted set: the ids keep the
    // user's order, which is the entire point of the feature.
    expect(poolWrite?.orderAccountIds[0]).toBe('b')
    await m.unmount()
  })

  it('renders no arrows for an UNCHECKED account', async () => {
    // An account outside the pool has no place in the order, so offering to
    // move it would promise a change the saved order cannot express.
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: ['a'],
        effectiveMemberAccountIds: ['a'],
        orderAccountIds: ['a'],
        accounts: [
          accountOf({ accountId: 'a', accountName: 'Name A', member: true }),
          accountOf({ accountId: 'b', accountName: 'Name B', member: false }),
        ],
      }),
    }))
    // `.dsm-workbuddy-pool-row` also matches the header row, so select the
    // DATA rows by the checkbox cell they contain.
    const rows = Array.from(m.container.querySelectorAll('.dsm-workbuddy-pool-row'))
      .filter(row => row.querySelector('input[type=checkbox]') !== null)
    expect(rows.length).toBe(2)
    expect(rows[0]!.querySelector('.dsm-workbuddy-pool-order'), 'the member has ordering chrome').not.toBeNull()
    expect(rows[0]!.querySelectorAll('.dsm-workbuddy-pool-move-btn').length, 'the member has both arrows').toBe(2)
    expect(rows[1]!.querySelector('.dsm-workbuddy-pool-rank'), 'a non-member has no badge').toBeNull()
    expect(rows[1]!.querySelectorAll('.dsm-workbuddy-pool-move-btn').length, 'a non-member has no arrows').toBe(0)
    await m.unmount()
  })
})

/**
 * The ordering rule, disclosed in the settings panel.
 *
 * The rule is invisible in normal use — it lives in `rankPool`'s comparator —
 * and users were asking "why wasn't the account at position 1 used?". These
 * assertions pin the two things that make the disclosure useful: it is present
 * but COLLAPSED by default (so it does not push the table down), and when
 * opened it states the priority order a reader would otherwise have to read the
 * source to discover.
 */
describe('ordering-rule disclosure in the settings panel', () => {
  it('is rendered, collapsed, and sits below the member table', async () => {
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, baseProps())
    const rules = m.container.querySelector('details.dsm-workbuddy-pool-order-rules')
    expect(rules, 'the rule must be discoverable from the panel').not.toBeNull()
    // Collapsed by default: reference text must not push the controls down.
    expect(rules!.hasAttribute('open')).toBe(false)
    expect(rules!.querySelector('summary')!.textContent).toBe('row.poolOrderRulesTitle')
    // BELOW the table and ABOVE the settings rows. It explains the 「第 N 位」
    // badges and the ↑/↓ arrows in the data above it, so it belongs under the
    // data: it used to sit between the member heading and the first row, which
    // put a paragraph of annotation in front of the accounts themselves.
    const table = m.container.querySelector('.dsm-workbuddy-pool-table')!
    expect(table.compareDocumentPosition(rules!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the rule must follow the member table').toBeTruthy()
    const modelSelect = m.container.querySelector(
      'select.dsm-workbuddy-pool-select:not(.dsm-workbuddy-pool-account-select)')!
    expect(rules!.compareDocumentPosition(modelSelect) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the rule must open the settings block, before its first control').toBeTruthy()
    await m.unmount()
  })

  it('states all eight rules IN THE COMPARATOR ORDER', async () => {
    // Ordering here is the point: the list must match `rankPool`. A rule moved
    // to the wrong slot would teach the user the opposite of what the code does.
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, baseProps())
    const rules = Array.from(
      m.container.querySelectorAll('.dsm-workbuddy-pool-order-rules-list li'),
    ).map(li => li.textContent ?? '')
    expect(rules).toEqual([
      expect.stringContaining('row.poolOrderRuleUsable'),
      expect.stringContaining('row.poolOrderRuleExpiring'),
      expect.stringContaining('row.poolOrderRuleManual'),
      expect.stringContaining('row.poolOrderRuleNearestExpiry'),
      expect.stringContaining('row.poolOrderRuleExpiringAmount'),
      expect.stringContaining('row.poolOrderRuleTotal'),
      expect.stringContaining('row.poolOrderRuleFreshness'),
      expect.stringContaining('row.poolOrderRuleId'),
    ])
    await m.unmount()
  })

  it('explains why expiring credits outrank the manual order', async () => {
    // The single most surprising rule, and the one this section exists for.
    // Without it "No. 2 was skipped" looks like a bug.
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, baseProps())
    expect(m.container.querySelector('.dsm-workbuddy-pool-order-rules-why')!.textContent)
      .toBe('row.poolOrderWhy')
    // And the badge caveat: saved position != live ranking.
    expect(m.text()).toContain('row.poolOrderBadgeNote')
    await m.unmount()
  })

  it('stays open across a props refresh', async () => {
    // The pool re-renders on every usage poll; a disclosure that snapped shut
    // mid-read would be worse than not having one.
    stubFetch(() => ({ body: {} }))
    const props = baseProps()
    const m = await mount(AccountPool, props)
    const rules = m.container.querySelector('details.dsm-workbuddy-pool-order-rules') as HTMLDetailsElement
    rules.open = true
    rules.dispatchEvent(new window.Event('toggle', { bubbles: false }))
    await m.settle()
    await m.update({ ...props, pool: poolOf({
      memberAccountIds: [GENUINE_ID],
      effectiveMemberAccountIds: [GENUINE_ID],
      accounts: [GENUINE_ACCOUNT],
    }) })
    expect(
      (m.container.querySelector('details.dsm-workbuddy-pool-order-rules') as HTMLDetailsElement).open,
      'the opened rule must survive a refresh',
    ).toBe(true)
    await m.unmount()
  })

  it('is not a SAVED setting — opening it must not dirty the draft', async () => {
    // Reading the rules is not an edit. If it dirtied the draft, Save would
    // light up and the user would be asked to commit nothing at all.
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, baseProps())
    expect(m.button('row.poolSaved').disabled).toBe(true)
    const rules = m.container.querySelector('details.dsm-workbuddy-pool-order-rules') as HTMLDetailsElement
    rules.open = true
    rules.dispatchEvent(new window.Event('toggle', { bubbles: false }))
    await m.settle()
    expect(m.button('row.poolSaved').disabled, 'opening the rule is not an unsaved change').toBe(true)
    await m.unmount()
  })
})

/**
 * The two switches in the mode bar must LOOK the same (issue #191 follow-up).
 *
 * THE REPORT. A screenshot with both toggles circled: 「启用账号池」 drew as a
 * large control directly on the tinted bar, 「每天自动签到」 as a smaller switch
 * sitting in a second, darker nested card with a deep gap above it.
 *
 * THE CAUSE. The check-in `<label>` carried `.dsm-workbuddy-pool-modebar` — the
 * class that styles the WHOLE mode BAR (12px/14px padding, brand gradient,
 * border, radius). It was borrowed for its flex-row geometry, and brought the
 * card with it. Nothing in the CSS was "wrong"; one element wore a class that
 * means "I am a card" when it meant "I am a row".
 *
 * WHY THE ASSERTIONS ARE STRUCTURAL. Comparing computed geometry in jsdom would
 * measure nothing (no layout engine), and comparing pixel values in a unit test
 * would pin a design that is allowed to change. What must NOT change is the
 * relationship: both switches are `label > .sw > input + .sw-track`, and neither
 * label carries a class that also styles a card. That is what a future edit
 * would break, and it is checkable here.
 */
describe('the mode bar draws both switches the same way', () => {
  /** The props that render BOTH switches (check-in only exists on CN). */
  function bothSwitches(): Record<string, unknown> {
    return baseProps({
      pool: poolOf({
        checkinSupported: true,
        autoCheckin: false,
        memberAccountIds: [GENUINE_ID],
        effectiveMemberAccountIds: [GENUINE_ID],
        accounts: [GENUINE_ACCOUNT],
      }),
    })
  }

  it('renders two switches, and both use the same internal markup', async () => {
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, bothSwitches())
    const switches = Array.from(m.container.querySelectorAll('.dsm-workbuddy-pool .sw'))
    expect(switches, 'the pool switch AND the check-in switch').toHaveLength(2)
    for (const sw of switches) {
      // The shared shape is what makes them look alike: a hidden checkbox plus
      // the styled track. A second switch drawn with a bare <input> would have
      // no `.sw-track` and would come out at the host's default size.
      // `label.sw` is the switch, in BOTH places: the label is the click target,
      // and `.sw` (38x22) is the box. A span inside a separate label would put
      // the box on the inner element and leave the outer one as an unstyled
      // second click surface.
      expect(sw.tagName).toBe('LABEL')
      expect(sw.querySelector('input[type=checkbox]'), 'a switch holds a checkbox').not.toBeNull()
      expect(sw.querySelector('.sw-track'), 'a switch draws the track pill').not.toBeNull()
      // `input + .sw-track` is the selector the checked/disabled rules hang on,
      // so a wrapper element between them would silently kill those states.
      expect(sw.children[0]?.tagName).toBe('INPUT')
      expect(sw.children[1]?.className).toBe('sw-track')
    }
    await m.unmount()
  })

  it('never styles the check-in label as the mode BAR (the nesting that caused it)', async () => {
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, bothSwitches())
    const checkinLabel = m.container.querySelector('.dsm-workbuddy-pool-auto-checkin label.sw')
    expect(checkinLabel, 'the check-in switch must render').not.toBeNull()
    // The defect in one line: this label used to carry the CARD class.
    expect(
      checkinLabel!.classList.contains('dsm-workbuddy-pool-modebar'),
      'the check-in switch must not reuse the mode BAR class — it draws a nested card',
    ).toBe(false)
    // …and it shares the ROW class with the pool switch's line, so their switch
    // and label align on both axes.
    // The switch row is the WRAPPER now (mirroring the pool switch), and the
    // switch itself is the label — so one click surface, one shape.
    expect(checkinLabel!.parentElement?.classList.contains('dsm-workbuddy-pool-switchrow')).toBe(true)
    await m.unmount()
  })

  it('keeps the card styling on the mode bar itself, so the master control still reads as the master', async () => {
    stubFetch(() => ({ body: {} }))
    const m = await mount(AccountPool, bothSwitches())
    const bar = m.container.querySelector('.dsm-workbuddy-pool-modebar')
    expect(bar, 'the mode bar is still a card').not.toBeNull()
    // Exactly ONE element is the card, and it is the bar — not a switch row.
    expect(m.container.querySelectorAll('.dsm-workbuddy-pool-modebar')).toHaveLength(1)
    await m.unmount()
  })
})

describe('a rate-limited account says so ONCE', () => {
  /**
   * THE REPORT: the state line read 「被限流 · 11/08 03:56 之后可再用 · 约 7 小时后 被限流」.
   *
   * Two independent fields describe the same fact — the pool's own exclusion
   * verdict (`excludedBy: 'rate-limited'`) and the probe's outcome — and each
   * renders its own 「被限流」. They used to sit in different cells; moving the
   * exclusion label onto the state line put the two a few pixels apart, which is
   * what turned a latent duplication into an obvious one.
   *
   * The verdict is the one kept: it also carries the reset time. The coarse
   * exclusion label is therefore dropped ONLY for that one reason — every other
   * exclusion reason states a fact the verdict does not, and must still print.
   */
  it('prints the exclusion label once when the probe already says it', async () => {
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: ['limited-1'],
        effectiveMemberAccountIds: ['limited-1'],
        accounts: [
          accountOf({
            accountId: 'limited-1',
            accountName: 'Limited',
            probe: { outcome: 'rate-limited', atMs: Date.now(), retryAtMs: Date.now() + 3600_000 },
            excludedBy: 'rate-limited',
          }),
        ],
      }),
    }))
    // NOT `querySelector`: the FIRST `.dsm-workbuddy-pool-row` is the header row,
    // which carries only column labels.
    const row = m.container.querySelectorAll('.dsm-workbuddy-pool-row')[1]
    // Count the RENDERED words, not the source: the duplication was visible on
    // screen while every text assertion on either field passed on its own.
    // The double count came from TWO different keys, so each is counted
    // separately rather than by scanning for one literal string.
    const text = row?.textContent ?? ''
    const verdict = text.split('row.poolExcludedRateLimited').length - 1
    const outcome = text.split('row.probeRateLimited').length - 1
    expect(verdict + outcome, 'a rate-limited row must not say 被限流 twice').toBe(1)
    await m.unmount()
  })

  it('does not print a model-busy verdict twice either', async () => {
    // The first version of the suppression compared the TRANSLATED label, so it
    // only covered `rate-limited`: a model-busy or out-of-credit row still read
    // 「模型繁忙 · … · 模型繁忙」. The comparison is on the reason CODE now, and
    // this case is what keeps it there — the wording of the label is not what
    // decides whether it repeats the verdict.
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: ['busy-1'],
        effectiveMemberAccountIds: ['busy-1'],
        accounts: [
          accountOf({
            accountId: 'busy-1',
            accountName: 'Busy',
            probe: { outcome: 'model-busy', atMs: Date.now(), retryAtMs: Date.now() + 60_000 },
            excludedBy: 'model-busy',
          }),
        ],
      }),
    }))
    const row = m.container.querySelectorAll('.dsm-workbuddy-pool-row')[1]
    const text = row?.textContent ?? ''
    const label = text.split('row.poolExcludedModelBusy').length - 1
    const verdict = text.split('row.probeModelBusyAt').length - 1
    expect(label + verdict, 'a model-busy row must not say 模型繁忙 twice').toBe(1)
    // …and the line still ends with the timestamp, which the old branch dropped
    // whenever an exclusion label was printed.
    expect(text, 'the merged line must still date the measurement').toContain('row.poolTestedAt')
    await m.unmount()
  })

  it('still prints an exclusion reason the verdict does not state', async () => {
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: ['poor-1'],
        effectiveMemberAccountIds: ['poor-1'],
        accounts: [
          accountOf({
            accountId: 'poor-1',
            accountName: 'Poor',
            probe: { outcome: 'ok', atMs: Date.now() },
            excludedBy: 'out-of-credit',
          }),
        ],
      }),
    }))
    const row = m.container.querySelectorAll('.dsm-workbuddy-pool-row')[1]
    // The suppression above must be narrow: an out-of-credit account is healthy
    // per the probe, so dropping this label would hide the ONLY reason it is
    // not serving.
    expect(row?.textContent ?? '', 'out-of-credit must still be stated').toContain('row.poolExcludedOutOfCredit')
    await m.unmount()
  })
})

describe('the row groups its cells into the three intended lines', () => {
  /**
   * THE REQUEST: 「被限流 · 11/08 15:44 之后可再用 · 约 15 小时后 / 测试于 11/07
   * 17:36 / 这个放在一行，整个账号，就是三行，国内国际一样」.
   *
   * The row had grown to FOUR lines — identity / verdict / timestamp / provenance
   * — because the verdict and its timestamp were separate sub-rows, so the last
   * line held nothing but a date. Three lines are what is left when those two
   * share one:
   *   line 1: identity + credits
   *   line 2: verdict + timestamp, then the check-in, then the buttons
   *   line 3: provenance (writer · age · model)
   *
   * The line assignment comes from TWO places that must agree: the grid's
   * `grid-template-areas` (which cells share a row) and the DOM order (which cell
   * a reader reaches first). These assertions check the DOM half, because the
   * CSS half is asserted in pool-card-render.
   */
  it('orders the cells so line two reads verdict → check-in → actions', async () => {
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: ['a-1'],
        effectiveMemberAccountIds: ['a-1'],
        accounts: [
          accountOf({
            accountId: 'a-1',
            accountName: 'Acct',
            checkedInToday: true,
            probe: { outcome: 'ok', atMs: Date.now() },
          }),
        ],
      }),
    }))
    const row = m.container.querySelectorAll('.dsm-workbuddy-pool-row')[1]
    const order = Array.from(row?.children ?? []).map(el => el.className)
    const at = (needle: string): number => order.findIndex(c => c.includes(needle))
    // Line one: the identity, then its price.
    expect(at('dsm-workbuddy-pool-account'), 'the account cell is missing').toBe(0)
    expect(at('dsm-workbuddy-pool-credits'), 'the credits cell must follow the account')
      .toBeGreaterThan(0)
    // Line two: verdict → check-in → actions, in that order. The check-in used to
    // be emitted BEFORE the verdict (it owned an area on the identity line), which
    // put it ahead of the verdict for a screen reader while the eye met it after.
    expect(at('dsm-workbuddy-pool-probe'), 'the verdict opens line two')
      .toBeGreaterThan(at('dsm-workbuddy-pool-credits'))
    expect(at('dsm-workbuddy-pool-checkin'), 'the check-in follows the verdict')
      .toBeGreaterThan(at('dsm-workbuddy-pool-probe'))
    expect(at('dsm-workbuddy-pool-row-actions'), 'the actions close the row')
      .toBeGreaterThan(at('dsm-workbuddy-pool-checkin'))
    await m.unmount()
  })

  it('puts the timestamp INSIDE the verdict line, not on a line of its own', async () => {
    // The DOM half of the merge: both fragments must live in ONE flex line, so
    // that no CSS rule can put them back on two lines without this failing.
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: ['a-1'],
        effectiveMemberAccountIds: ['a-1'],
        accounts: [
          accountOf({
            accountId: 'a-1',
            accountName: 'Acct',
            probe: { outcome: 'rate-limited', atMs: Date.now() - 3_600_000, retryAtMs: Date.now() + 3_600_000 },
          }),
        ],
      }),
    }))
    const row = m.container.querySelectorAll('.dsm-workbuddy-pool-row')[1]
    const line = row?.querySelector('.dsm-workbuddy-pool-probe-line')
    expect(line, 'the verdict line wrapper is missing').not.toBeNull()
    // ONE wrapper holds both, and neither is a sibling of it: the "two lines"
    // shape this replaced was exactly two siblings inside the probe cell.
    expect(line?.querySelector('.dsm-workbuddy-pool-probe-main'), 'the verdict is not in the line')
      .not.toBeNull()
    expect(line?.querySelector('.dsm-workbuddy-pool-tested-at'), 'the timestamp is not in the line')
      .not.toBeNull()
    // …and the provenance line is NOT inside it: that is line three.
    expect(line?.querySelector('.dsm-workbuddy-pool-probe-prov'), 'the provenance row must stay out of line two')
      .toBeNull()
    await m.unmount()
  })
})

describe('the credits cell prints the amount, not an expiry date', () => {
  /**
   * THE REQUEST: 「这个信息不要了」 pointing at 「最近积分包 11/27 03:46 过期」.
   *
   * That line printed the nearest package's expiry on EVERY row — a date months
   * out that nobody is deciding anything with — and it cost the credits cell a
   * second line on all of them. The actionable half is kept: an amount that is
   * about to lapse still prints, because that one can still be spent.
   *
   * Pinned as a rendered assertion rather than a source grep: the date came from
   * a `nearestExpiryMs == undefined ? … :` fallback, so re-adding it is a one-line
   * change that no existing test would notice.
   */
  it('omits the nearest-expiry date but keeps the figure', async () => {
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: ['a-1'],
        effectiveMemberAccountIds: ['a-1'],
        accounts: [
          accountOf({
            accountId: 'a-1',
            accountName: 'Acct',
            credits: 1648,
            // A date months out, exactly the shape the removed line printed.
            nearestExpiryMs: Date.now() + 20 * 24 * 3_600_000,
          }),
        ],
      }),
    }))
    const row = m.container.querySelectorAll('.dsm-workbuddy-pool-row')[1]
    const text = row?.textContent ?? ''
    expect(text, 'the credits figure must still print').toContain('1,648')
    expect(text, 'the expiry date must be gone').not.toContain('row.poolCreditNearest')
    await m.unmount()
  })

  it('still warns about credits that are about to lapse', async () => {
    // The removal must not take the actionable warning with it: "about to expire"
    // answers a question ("should I spend this now?") that a plain date does not.
    const m = await mount(AccountPool, baseProps({
      pool: poolOf({
        memberAccountIds: ['a-1'],
        effectiveMemberAccountIds: ['a-1'],
        accounts: [
          accountOf({
            accountId: 'a-1',
            accountName: 'Acct',
            credits: 1648,
            expiringSoon: 300,
            nearestExpiryMs: Date.now() + 3 * 24 * 3_600_000,
          }),
        ],
      }),
    }))
    const row = m.container.querySelectorAll('.dsm-workbuddy-pool-row')[1]
    expect(row?.textContent ?? '', 'the lapse warning must survive')
      .toContain('row.poolCreditSoon')
    await m.unmount()
  })
})

describe('the international pool (no check-in column) renders the same two lines', () => {
  /**
   * THE GAP THAT LET A REAL BUG SHIP. `checkinSupported: false` is not
   * hypothetical — the `workbuddy-global` region reports exactly that, so this is
   * the everyday path for international accounts. Every layout assertion in this
   * suite mounted the DOMESTIC pool, where the check-in cell exists, so a grid
   * declared with four tracks while naming five areas went unnoticed: the browser
   * discards `grid-template-areas` wholesale in that case, and the two-line
   * layout silently collapsed to a single stacked column.
   *
   * The static assertion in pool-card-render now compares track counts, but a
   * static check cannot prove the DOM for this variant exists at all. This mounts
   * it.
   */
  const international = (overrides: Record<string, unknown> = {}) => baseProps({
    pool: poolOf({
      checkinSupported: false,
      memberAccountIds: ['i-1'],
      effectiveMemberAccountIds: ['i-1'],
      accounts: [
        accountOf({
          accountId: 'i-1',
          accountName: 'Intl',
          credits: 900,
          probe: { outcome: 'ok', atMs: Date.now() },
        }),
      ],
      ...overrides,
    }),
  })

  it('renders no check-in cell, so the class that carries it is absent', async () => {
    const m = await mount(AccountPool, international())
    expect(m.container.querySelector('.dsm-workbuddy-pool-checkin'),
      'an international row must not render a check-in cell').toBeNull()
    // The table variant class selects the no-check-in grid template. Without it
    // the row would use the domestic template, whose `checkin` area has no cell
    // to fill — an empty gap in the middle of line two.
    expect(m.container.querySelector('.dsm-workbuddy-pool-table-checkin'),
      'the check-in table variant must be absent').toBeNull()
    await m.unmount()
  })

  it('emits exactly the cells its template names, and no extra one', async () => {
    // A CELL COUNT, not a class name. The template and the DOM are separate
    // edits, and a grid whose areas name more cells than there are elements
    // silently pulls each cell one slot along — which is how the check-in used
    // to appear under the credits column. The browser will not warn.
    const m = await mount(AccountPool, international())
    const row = m.container.querySelectorAll('.dsm-workbuddy-pool-row')[1]
    const cells = Array.from(row?.children ?? []).map(el => el.className)
    // account, credits, probe, actions — the check-in is absent by design.
    expect(cells, 'the international row must carry four cells').toHaveLength(4)
    expect(cells.some(c => c.includes('dsm-workbuddy-pool-checkin')), 'no check-in cell').toBe(false)
    // …and the header row names three of them, plus the silent actions slot.
    const head = m.container.querySelectorAll('.dsm-workbuddy-pool-row-head')[0]
    const labels = Array.from(head?.children ?? []).map(el => el.textContent ?? '')
    expect(labels.join(' '), 'the header must not label a column that is not there')
      .not.toContain('row.poolColumnCheckin')
    await m.unmount()
  })

  it('still renders the credits, the verdict and the actions', async () => {
    const m = await mount(AccountPool, international())
    const row = m.container.querySelectorAll('.dsm-workbuddy-pool-row')[1]
    const text = row?.textContent ?? ''
    // The three cells that survive must all still be there — the layout change
    // moves them, it must not drop them.
    expect(text, 'the credits figure must print').toContain('900')
    expect(row?.querySelector('.dsm-workbuddy-pool-probe'), 'the verdict cell is missing')
      .not.toBeNull()
    expect(row?.querySelector('.dsm-workbuddy-pool-row-actions'), 'the actions cell is missing')
      .not.toBeNull()
    await m.unmount()
  })
})

describe('an elapsed cooldown re-tests that one account by itself', () => {
  /**
   * THE REQUEST: 「发现这种情况，自己单个账号测试一下就好了，不用写这种自相矛盾的
   * 话」 — about 「被限流 · 限流时段已过 · 重新测试以确认」, a line that states a
   * verdict, says the verdict is over, and then asks the reader to resolve it.
   *
   * So the card does the resolving: one account, one request, no click. The copy
   * that remains is 「恢复时间已到 · 待复核」 (see the locale) and it lives only as
   * long as the measurement takes.
   *
   * Every assertion here is about the ONE thing that could go wrong silently: a
   * test request fired on every render. `autoRetested` is the guard, and the last
   * test below is the one that would catch its removal.
   */
  const expiredAccount = (id: string, extra: Record<string, unknown> = {}) => accountOf({
    accountId: id,
    accountName: id,
    probe: { outcome: 'rate-limited', atMs: Date.now() - 3_600_000, retryAtMs: Date.now() - 60_000 },
    ...extra,
  })
  const poolWith = (accounts: unknown[], members: string[], extra: Record<string, unknown> = {}) => poolOf({
    memberAccountIds: members,
    effectiveMemberAccountIds: members,
    accounts,
    ...extra,
  })
  const testCalls = (calls: { url: string }[]): { url: string }[] => calls.filter(c => c.url.includes('action=test'))

  it('fires one test for the account whose window has passed', async () => {
    const calls = stubFetch(() => ({ body: { rows: [{ accountId: 'limited-1', accountName: 'limited-1', result: { outcome: 'ok' } }] } }))
    const m = await mount(AccountPool, baseProps({ pool: poolWith([expiredAccount('limited-1')], ['limited-1']) }))
    const fired = testCalls(calls)
    expect(fired, 'the expired row must be re-measured without a click').toHaveLength(1)
    expect(fired[0]?.url, 'and it must measure THAT account').toContain('accountId=limited-1')
    await m.unmount()
  })

  it('leaves a cooldown that still has time left alone', async () => {
    const calls = stubFetch(() => ({ body: { rows: [] } }))
    const m = await mount(AccountPool, baseProps({
      pool: poolWith([accountOf({
        accountId: 'limited-2',
        accountName: 'Limited Two',
        probe: { outcome: 'rate-limited', atMs: Date.now(), retryAtMs: Date.now() + 2 * 3_600_000 },
      })], ['limited-2']),
    }))
    expect(testCalls(calls), 'a running cooldown must not be re-tested').toHaveLength(0)
    await m.unmount()
  })

  it('leaves an account that is not in the pool alone', async () => {
    // An unchecked row is listed for the user to opt into; spending a probe on it
    // is work nobody asked for.
    const calls = stubFetch(() => ({ body: { rows: [] } }))
    const m = await mount(AccountPool, baseProps({ pool: poolWith([expiredAccount('unchecked-1')], [GENUINE_ID]) }))
    expect(testCalls(calls), 'a non-member row must not be measured').toHaveLength(0)
    await m.unmount()
  })

  it('measures ONE expired account at a time, not the whole list at once', async () => {
    // The in-flight guard, and the reason it is not decoration: `runRowTest` is
    // serialized on purpose (a pool test that fires N requests at once is how a
    // rate-limited pool hammers itself). Two expired rows must therefore produce
    // one request, not two — the second waits for the first to land.
    //
    // A never-resolving fetch keeps the first request in flight for the whole
    // assertion, so this measures the guard and not the response time.
    let calls = 0
    vi.stubGlobal('fetch', () => { calls += 1; return new Promise(() => {}) })
    const m = await mount(AccountPool, baseProps({
      pool: poolWith([expiredAccount('limited-4'), expiredAccount('limited-5')], ['limited-4', 'limited-5']),
    }))
    expect(calls, 'two expired rows must not fire two requests at once').toBe(1)
    await m.unmount()
  })

  it('does not measure an account the manual 测试 button is disabled for', async () => {
    // `targetModelSource: 'stale'` is exactly the state where the row's own 测试
    // button is disabled and explains why (the pool has no model it can test
    // against). Firing a probe here would be the plugin pressing a button it has
    // just told the user not to press.
    const calls = stubFetch(() => ({ body: { rows: [] } }))
    const m = await mount(AccountPool, baseProps({
      pool: poolWith([expiredAccount('limited-6')], ['limited-6'], { targetModelSource: 'stale' }),
    }))
    expect(testCalls(calls), 'a stale target model must not be re-probed').toHaveLength(0)
    await m.unmount()
  })

  it('does not re-measure an account whose verdict is not a cooldown', async () => {
    // An `ok` record can carry `retryAtMs` (the monthly quota reset read off a
    // 200), and an exhausted quota carries it too — neither is cleared by waiting,
    // and `availabilityLine` says so. Re-probing them would spend a request to
    // learn what the row already states.
    const calls = stubFetch(() => ({ body: { rows: [] } }))
    const m = await mount(AccountPool, baseProps({
      pool: poolWith([
        accountOf({ accountId: 'healed-1', accountName: 'Healed',
          probe: { outcome: 'ok', atMs: Date.now() - 3_600_000, retryAtMs: Date.now() - 60_000 } }),
        accountOf({ accountId: 'poor-1', accountName: 'Poor',
          probe: { outcome: 'out-of-credit', atMs: Date.now() - 3_600_000, retryAtMs: Date.now() - 60_000 } }),
      ], ['healed-1', 'poor-1']),
    }))
    expect(testCalls(calls), 'only a wait-and-see cooldown is re-probed').toHaveLength(0)
    await m.unmount()
  })

  it('does not fire again when the card re-renders with the same stale record', async () => {
    // The guard that matters: the row keeps rendering the OLD probe until the new
    // one lands, and a re-render in that window (a preference edit, the 60s poll)
    // passes a NEW pool object through the same effect. Without `autoRetested`
    // that is a second request per render — a rate-limited pool hammering itself.
    const calls = stubFetch(() => ({ body: { rows: [{ accountId: 'limited-3', accountName: 'limited-3', result: { outcome: 'ok' } }] } }))
    const props = baseProps({ pool: poolWith([expiredAccount('limited-3')], ['limited-3']) })
    const m = await mount(AccountPool, props)
    expect(testCalls(calls)).toHaveLength(1)
    await m.update({ ...props, pool: poolWith([expiredAccount('limited-3')], ['limited-3']) })
    expect(testCalls(calls), 'the second render must not fire another test').toHaveLength(1)
    await m.unmount()
  })
})
