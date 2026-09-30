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

describe('the interval field is typeable (A-4 / M-2 — the user-reported clamp)', () => {
  it('shows each raw keystroke while typing "120" (M01, M17, M38b)', async () => {
    const m = await mount(AccountPool, baseProps())
    // The field must render what the user typed, character by character.
    // The user-reported defect: typing `120` showed `5`, then `52`, then `520`
    // — the clamped first keystroke re-serialized into the display.
    await m.type('1')
    expect(m.input().value).toBe('1')
    await m.type('12')
    expect(m.input().value).toBe('12')
    await m.type('120')
    expect(m.input().value).toBe('120')
    await m.unmount()
  })

  it('folds a valid integer into the draft but keeps the text raw (M01: text ≠ String(commit))', async () => {
    const m = await mount(AccountPool, baseProps({ pool: poolOf({ autoTestIntervalMinutes: 30 }) }))
    // `1` parses to the minimum 5 — but the DISPLAY must stay `1`, or the
    // next digit appends onto `5` and `120` becomes `520`.
    await m.type('1')
    expect(m.input().value).toBe('1')
    // The draft has the clamped commit (saveable), the display has the text.
    expect(m.text()).toContain('row.poolSaveDirty')
    await m.unmount()
  })

  it('keeps an empty field empty while focused, then clamps exactly once on blur', async () => {
    const m = await mount(AccountPool, baseProps({ pool: poolOf({ autoTestIntervalMinutes: 30 }) }))
    const input = m.input()
    // Clearing the field must not snap to `5` while the user is still there.
    await m.clear()
    expect(input.value).toBe('')
    await m.blur()
    // On commit, the half-typed text is dropped and the control re-renders the
    // committed number (the saved value — nothing parseable was committed).
    expect(input.value).toBe('30')
    await m.unmount()
  })

  it('typing over the value then blurring shows the committed number once', async () => {
    const m = await mount(AccountPool, baseProps({ pool: poolOf({ autoTestIntervalMinutes: 30 }) }))
    await m.type('9999')
    expect(m.input().value).toBe('9999')
    await m.blur()
    // 9999 > 1440, so the commit clamps to the maximum — exactly once.
    expect(m.input().value).toBe('1440')
    await m.unmount()
  })
})

describe('save keeps the draft unless the write AND the re-read both verify (A-8 / N1)', () => {
  it('discards the draft only after onSaved resolves true (M16: committed must not be set in catch)', async () => {
    const onSaved = vi.fn(async () => true)
    const scope = fakeScope({})
    const props = baseProps({ settingsScope: scope, onSaved })
    const m = await mount(AccountPool, props)
    await m.type('45') // dirty: interval 30 → 45
    await m.click(m.button('row.poolSaved')) // "Save"
    // Success: no longer dirty, and the re-read delivered fresh props.
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(m.text()).toContain('row.poolSaveIdle')
    // The parent now re-renders with the pool it re-read (interval 45); the
    // panel must show the new number, not the pre-edit 30.
    await m.update({ ...props, pool: poolOf({ autoTestIntervalMinutes: 45 }) })
    expect(m.input().value).toBe('45')
    await m.unmount()
  })

  it('keeps the draft and explains when onSaved resolves false (M14, M15: the N1 bail-out must return)', async () => {
    const onSaved = vi.fn(async () => false)
    const scope = fakeScope({})
    const m = await mount(AccountPool, baseProps({ settingsScope: scope, onSaved }))
    await m.type('45')
    await m.click(m.button('row.poolSaved'))
    // The draft is the only copy of what was just saved; discarding it against
    // a still-stale `saved` prop would revert the panel to the pre-edit values.
    expect(m.text()).toContain('row.poolSaveDirty')
    // The stale-refresh notice names the DISPLAY problem (the write landed).
    expect(m.text()).toContain('row.poolSaveFailed|message=row.poolSavedStaleRefresh')
    // The half-typed text survives too — the edit is still in progress.
    expect(m.input().value).toBe('45')
    await m.unmount()
  })

  it('keeps the draft when the WRITE itself fails (M16: a failed write must not discard)', async () => {
    const onSaved = vi.fn(async () => true)
    // Both write paths refuse: the Host endpoint 500s AND the scope answers
    // false, so `writePoolPreferences` must throw.
    const scope = fakeScope({}, true)
    const posts = stubFetch(() => ({ status: 500, body: { error: 'boom' } }))
    const m = await mount(AccountPool, baseProps({ settingsScope: scope, onSaved }))
    await m.type('45')
    await m.click(m.button('row.poolSaved'))
    expect(posts.length).toBe(1)
    // The draft survives: the user's edit is still on screen and still dirty.
    expect(m.text()).toContain('row.poolSaveDirty')
    expect(m.text()).toContain('row.poolSaveFailed|message=')
    // The re-read never ran: the write never landed.
    expect(onSaved).not.toHaveBeenCalled()
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
    const testedAt = new Date(2026, 8, 30, 13, 23).getTime()   // 13:23 (1:23 PM)
    const retryAt = new Date(2026, 9, 1, 5, 20).getTime()      // 05:20 (5:20 AM)
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
    expect(text).toMatch(/row\.poolTestedAt\|at=\d{2}\/\d{2}, \d{2}:\d{2}/u)
    expect(text).toMatch(/row\.poolRetryAt\|at=\d{2}\/\d{2}, \d{2}:\d{2}/u)
    // The assertion with teeth: `Intl`'s locale default is the only thing that
    // can put a meridiem on screen, so its absence pins `hourCycle: 'h23'`.
    expect(text).not.toMatch(/\d{2}:\d{2}[ \u00a0]?(?:AM|PM)/u)
    await m.unmount()
  })
})
