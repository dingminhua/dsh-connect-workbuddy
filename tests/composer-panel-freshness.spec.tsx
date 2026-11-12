// @vitest-environment jsdom
/**
 * The composer panel's rows must not be a frozen snapshot.
 *
 * The maintainer's screenshot pair was taken at the SAME second (17:12:47) and
 * disagreed about one account: the pool card said dingxiyue was 模型繁忙 with
 * 「10/15, 17:13 之后可再用」, while the composer panel drew NO mark against it.
 * Both surfaces read the same `exclusionOf` rule over the same store, so the
 * only way they can differ is TIME.
 *
 * That is what these cases pin, by executing the real component under fake
 * timers rather than grepping its source:
 *
 * 1. The account table is re-read on a cadence while the panel stays open, at
 *    the CARD's cadence (60 s) rather than the readout's five minutes — because
 *    the shortest pool cooldown it has to render is the 2-minute model-scoped
 *    throttle, so anything slower can claim 模型繁忙 behind the card's back.
 * 2. Pressing 刷新 on that table refreshes the TABLE. It used to call
 *    `fetchUsage` alone, leaving every row's mark exactly as it was.
 *
 * A source-text guard cannot express either: both defects are about WHICH code
 * runs at WHICH moment, and a regex would pass on a respelled ternary.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerCredits, COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS } from '../src/client/ComposerCredits.tsx'
import { WORKBUDDY_DEFAULT_POLL_INTERVAL_MS } from '../src/status-paths.ts'
import { mount, stubFetch, t, type Mounted } from './pool-render-helpers.tsx'

/**
 * Fake ONLY the interval APIs.
 *
 * `vi.useFakeTimers()` with its defaults also fakes `setTimeout`, and the shared
 * harness drains React with a real `setTimeout(…, 0)` (`Mounted.settle`). Faking
 * it therefore deadlocks every helper in this file — the timer the component
 * arms is not the timer the harness waits on, so the two must be separated
 * rather than the harness rewritten.
 */
const fakeIntervals = (): void => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.querySelectorAll('.dsm-workbuddy-composer-panel').forEach(node => { node.remove() })
})

/** A signed-in usage body for one region. */
function usageOf(total: number): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    accountId: 'a-1',
    accountName: 'A One',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [
      { id: 'a-1', accountName: 'A One', selected: true },
      { id: 'a-2', accountName: 'A Two', selected: false },
    ],
    models: [],
    enabledModelIds: [],
    imageModelIds: [],
    contexts: {},
    contextBudgets: {},
    credits: { total, expiringSoon: 0, packages: [] },
  }
}

function scopeOf(value: unknown, writable = true): any {
  return {
    getSnapshot: () => ({ status: 'ready', value, writable }),
    subscribe: () => () => {},
    set: async () => true,
  }
}

const panelText = (): string =>
  document.body.querySelector('.dsm-workbuddy-composer-panel')?.textContent ?? ''

/**
 * Mount the readout, open the panel, and settle.
 *
 * `act` is driven through the shared harness so React batches every update the
 * timer causes; a bare `vi.advanceTimersByTime` would fire the interval outside
 * `act` and the assertions would race the re-render.
 */
async function openPanel(props: Record<string, unknown> = {}): Promise<Mounted> {
  const m = await mount(ComposerCredits as any, { t, provider: 'workbuddy', settingsScope: scopeOf({ accounts: {} }), ...props })
  await m.settle()
  await m.click(m.buttons()[0] as Element)
  await m.settle()
  return m
}

/**
 * Answer with a body the component can read as a stream.
 *
 * `stubFetch` cannot express the case below: it always answers IMMEDIATELY, and
 * this test needs one request (the post-batch re-read) to stay open. The shape
 * is otherwise identical to the shared double, including the `content-type`
 * header the panel picks its parser from.
 */
function streamAnswer(contentType: string, lines: readonly unknown[]): Response {
  const text = lines.map(line => JSON.stringify(line)).join('\n') + '\n'
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => JSON.parse(text) as unknown,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    }),
  } as unknown as Response
}

const jsonAnswer = (body: unknown): Response => streamAnswer('application/json', [body])

/** The mark a panel row prints, selected by the account name it is drawn beside. */
function rowMarkOf(name: string): string {
  return rowOf(name)?.querySelector('.dsm-workbuddy-composer-panel-mark')?.textContent ?? ''
}

/** The dot's classes, which is where the colour decision lives. */
function rowDotOf(name: string): string {
  return rowOf(name)?.querySelector('.dsm-workbuddy-composer-panel-dot')?.className ?? ''
}

function rowOf(name: string): Element | undefined {
  return Array.from(document.body.querySelectorAll('.dsm-workbuddy-composer-panel-table tbody tr'))
    .find(row => (row.textContent ?? '').includes(name))
}

describe('the panel keeps its account rows current while it is open', () => {
  it('uses one usage polling timer while open and restores readout polling on close', async () => {
    fakeIntervals()
    const calls = stubFetch(url => ({ body: url.includes('account-credits')
      ? { accounts: [{ id: 'a-1', accountName: 'A One', selected: true, credits: 100 }] }
      : { ...usageOf(100), pollIntervalMs: 300_000 },
    }))
    const m = await mount(ComposerCredits as any, { t, provider: 'workbuddy', settingsScope: scopeOf({ accounts: {} }) })
    await m.settle()
    vi.advanceTimersByTime(1000)
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    const usageCalls = () => calls.filter(call => call.url.includes('/usage')).length
    const opened = usageCalls()
    // Offset the two possible timers and settle between their ticks so an
    // in-flight guard cannot hide a duplicate timer behind the same request.
    vi.advanceTimersByTime(299_000)
    await m.settle()
    expect(usageCalls()).toBe(opened)
    vi.advanceTimersByTime(1000)
    await m.settle()
    expect(usageCalls() - opened).toBe(1)
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    const closed = usageCalls()
    vi.advanceTimersByTime(300_000)
    await m.settle()
    expect(usageCalls() - closed).toBe(1)
  })

  it('updates pool state alongside credits after automatic check-in without a model test', async () => {
    fakeIntervals()
    let replenished = false
    stubFetch(url => ({ body: url.includes('account-credits')
      ? { accounts: [{ id: 'a-1', accountName: 'A One', selected: true, credits: replenished ? 100 : 0 }] }
      : { ...usageOf(replenished ? 100 : 0), pollIntervalMs: 60_000, pool: {
          enabled: true, checkinSupported: true, targetModelSource: 'none', accounts: [{
            accountId: 'a-1', accountName: 'A One', member: true, current: replenished,
            credits: replenished ? 100 : 0, checkedInToday: replenished,
            ...replenished ? {} : { excludedBy: 'out-of-credit', probe: {
              outcome: 'out-of-credit', atMs: Date.now() - 1000, retryAtMs: Date.now() + 21 * 86_400_000,
            } },
          }],
        } },
    }))
    const m = await openPanel()
    expect(rowMarkOf('A One')).toContain('row.creditCheckinRetry')
    expect(rowMarkOf('A One')).not.toContain('row.recoversDays')
    replenished = true
    vi.advanceTimersByTime(60_000)
    await m.settle()
    expect(rowOf('A One')?.textContent).toContain('100')
    expect(rowMarkOf('A One')).not.toContain('row.poolExcludedOutOfCredit')
    expect(rowDotOf('A One')).not.toContain('error')
  })

  it('re-reads the account table on the CARD cadence, not the readout one', () => {
    // The property that matters is AGREEMENT, not a particular number. The panel
    // used to hold its own 60 s constant that merely happened to equal the
    // card's hard-coded 60 s — two numbers that stayed equal only as long as
    // nobody changed either one. The interval is a user setting now, so the
    // panel must READ it from the same document the card polls.
    //
    // What replaces the old pin, therefore, is the source: the panel's timer is
    // armed from `refreshIntervalMs`, and its fallback is the shared default —
    // never a second literal.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'ComposerCredits.tsx'),
      'utf8',
    )
    expect(source, 'the panel must read the cadence off the document').toContain('refreshIntervalMs')
    expect(source, 'the panel must arm its timer from that value').toContain(
      '() => { void refreshPanel() },\n        refreshIntervalMs,',
    )
    // The fallback is the shared constant, not a fresh literal.
    expect(COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS).toBe(WORKBUDDY_DEFAULT_POLL_INTERVAL_MS)
    const card = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'WorkBuddyCard.tsx'),
      'utf8',
    )
    // The card's timer reads the same field; a hard-coded interval reappearing
    // there would silently split the two surfaces again.
    expect(card).toContain('pollIntervalMs,')
    expect(card, 'the card must not re-grow a hard-coded 60 s cadence').not.toContain(
      'const POLL_INTERVAL_MS = 60_000',
    )
  })

  it('picks up a mark that appeared AFTER the panel was opened', async () => {
    // The reported symptom, reproduced: the panel opened while nothing was
    // wrong, then a live request benched the account — and the panel kept
    // drawing no mark while the card said 模型繁忙.
    fakeIntervals()
    let marked = false
    stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [
            { id: 'a-1', accountName: 'A One', selected: true, credits: 1072 },
            {
              id: 'a-2',
              accountName: 'A Two',
              selected: false,
              credits: 300,
              ...marked ? { excludedBy: 'model-busy' } : {},
            },
          ] }
        : usageOf(1072),
    }))
    const m = await openPanel()
    // Before the failure: no mark, as the panel originally showed.
    expect(panelText()).not.toContain('row.poolExcludedModelBusy')

    // A live request benches the account — exactly what happened at 17:11:47,
    // AFTER the panel's open-time read at ~17:12.
    marked = true
    await m.settle()
    vi.advanceTimersByTime(COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS)
    await m.settle()

    // Mutation: drop the interval, or restore the open-only effect → still empty.
    expect(panelText()).toContain('row.poolExcludedModelBusy')
    // Two lines: the selected row always names itself, and the newly benched one
    // now carries its reason. Before the refresh there was one; the interval is
    // what adds the second.
    const marks = Array.from(document.body.querySelectorAll('.dsm-workbuddy-composer-panel-mark'))
      .map(node => node.textContent ?? '')
    expect(marks).toContain('composer.current')
    expect(marks.some(line => line.includes('row.poolExcludedModelBusy')), 'the new reason is drawn').toBe(true)
    expect(marks).toHaveLength(2)
  })

  it('stops reading the table once the panel closes', async () => {
    // The cost rule at the top of the component: per-account figures are fetched
    // ONLY while the panel is visible. A timer that outlives the close would turn
    // one read per account into a permanent background poll.
    fakeIntervals()
    const calls = stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [{ id: 'a-1', accountName: 'A One', selected: true, credits: 1072 }] }
        : usageOf(1072),
    }))
    const m = await openPanel()
    const afterOpen = calls.filter(call => call.url.includes('account-credits')).length
    expect(afterOpen).toBeGreaterThan(0)

    // Close it again (the trigger toggles).
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    vi.advanceTimersByTime(COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS * 3)
    await m.settle()

    // Mutation: leave the timer running on close → this count keeps climbing.
    expect(calls.filter(call => call.url.includes('account-credits')).length).toBe(afterOpen)
  })

  it('does not fire the table read before the open-time read settles', async () => {
    // Start-only-after-settle, the same shape the readout's cycle uses: two
    // overlapping reads of one route would race to set the same rows.
    fakeIntervals()
    const calls = stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [{ id: 'a-1', accountName: 'A One', selected: true, credits: 1072 }] }
        : usageOf(1072),
    }))
    await openPanel()
    const tableCalls = calls.filter(call => call.url.includes('account-credits')).length
    // One open-time read, and nothing more: no timer has been armed yet by
    // inspecting the count, because a 1 ms advance cannot have fired it.
    expect(tableCalls).toBe(1)
  })

  it('SKIPS a timer tick that arrives while a read is still in flight', async () => {
    // The cost rule this protects: a tick means "has anything changed?", and a
    // read already on its way answers that. Without the guard, a slow upstream
    // would accumulate one in-flight read per minute per account.
    //
    // The overlap must be built on the TIMER's read, not the open-time one: the
    // interval is only armed after the open-time read settles (`…finally`), so
    // hanging that read would leave no timer to tick at all and the case would
    // pass whether or not the guard existed — which is exactly how the first
    // draft of this test failed to catch the guard's removal.
    fakeIntervals()
    let tableCalls = 0
    let releaseTick: (() => void) | undefined
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      const target = String(url)
      const payload = target.includes('account-credits')
        ? { accounts: [{ id: 'a-1', accountName: 'A One', selected: true, credits: 1072 }] }
        : usageOf(1072)
      if (target.includes('account-credits')) {
        tableCalls += 1
        // Call 1 = the open-time read, which must settle for the timer to arm.
        // Call 2 = the first tick's read, held open so the next ticks overlap it.
        if (tableCalls === 2) await new Promise<void>(resolve => { releaseTick = resolve })
      }
      void init
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => payload,
        text: async () => JSON.stringify(payload),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)))
            controller.close()
          },
        }),
      } as unknown as Response
    })
    const m = await mount(ComposerCredits as any, {
      t,
      provider: 'workbuddy',
      settingsScope: scopeOf({ accounts: {} }),
    })
    await m.settle()
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    expect(tableCalls).toBe(1)

    // First tick: starts a read and leaves it in flight.
    vi.advanceTimersByTime(COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS)
    await m.settle()
    expect(tableCalls).toBe(2)

    // Two more ticks land while that read is still unanswered.
    vi.advanceTimersByTime(COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS * 2)
    await m.settle()
    // Mutation: drop the `!force && accountsInFlight.current > 0` bail → 4.
    expect(tableCalls).toBe(2)

    // Let it finish: the harness must not be left with a dangling promise.
    releaseTick?.()
    await m.settle()
  })
  it('does NOT skip a deliberate read, even during an in-flight tick', async () => {
    // The failure mode the guard must not have: the timer's read is slow and a
    // DELIBERATE read arrives — here the re-read after the user switches account,
    // which must report the account the user just picked. Dropping it because a
    // read is already running would leave the panel describing the account it was
    // showing BEFORE the switch, so the deliberate path claims the newest
    // generation (`force`) and its answer is the one that lands.
    fakeIntervals()
    let tableCalls = 0
    let releaseFirst: (() => void) | undefined
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      const target = String(url)
      const payload = target.includes('__save')
        ? { ok: true, value: { accounts: { cn: 'a-2' } } }
        : target.includes('account-credits')
          ? { accounts: [
              { id: 'a-1', accountName: 'A One', selected: true, credits: 1072 },
              { id: 'a-2', accountName: 'A Two', selected: false, credits: 300 },
            ] }
          : usageOf(1072)
      if (target.includes('account-credits')) {
        tableCalls += 1
        if (tableCalls === 1) await new Promise<void>(resolve => { releaseFirst = resolve })
      }
      void init
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => payload,
        text: async () => JSON.stringify(payload),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)))
            controller.close()
          },
        }),
      } as unknown as Response
    })
    const m = await mount(ComposerCredits as any, {
      t,
      provider: 'workbuddy',
      settingsScope: scopeOf({ accounts: {} }),
    })
    await m.settle()
    await m.click(m.buttons()[0] as Element)
    await m.settle()
    expect(tableCalls).toBe(1)

    const rowButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-composer-panel-switch'))
      .find(button => button.textContent?.includes('A Two'))
    expect(rowButton, 'switch button for A Two').toBeDefined()
    await m.click(rowButton as Element)
    await m.settle()

    // Mutation: make the guard unconditional (drop `!force &&`) → stays 1.
    expect(tableCalls).toBe(2)
    releaseFirst?.()
    await m.settle()
  })
})

/**
 * The footer's "last refreshed" stamp follows the READER's locale.
 *
 * Ported from dsh-connect-trae (issue #71): `formatClock` hardcoded `'zh-CN'`,
 * so the English interface printed the Chinese convention's `23:59` instead of
 * `11:59 PM`.
 *
 * This file already asserted that the stamp is PRESENT (`composer.lastRefresh`)
 * — but never what it looks like, which is exactly why the hardcoded locale
 * survived every release. The check below is about the FORMAT.
 */
describe("the refresh stamp follows the reader's locale", () => {
  it('does not pin a locale for the refresh stamp', () => {
    // Source-level, so it holds whatever locale the test environment runs in:
    // a behavioural assertion would be vacuous under a zh-CN environment,
    // where the pinned and the reader's rendering coincide.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'ComposerCredits.tsx'),
      'utf8',
    )
    const clock = /function formatClock\(value: number\): string \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    expect(clock, 'formatClock was not found in ComposerCredits.tsx').not.toBe('')
    expect(
      clock,
      "formatClock still pins a locale — it must use undefined so the stamp follows the reader",
    ).not.toContain("'zh-CN'")
    expect(clock).toContain('undefined')
  })

  it('renders the stamp the way the reader\'s locale writes it', async () => {
    // The behavioural half. The stamp is the moment of the last refresh — i.e.
    // "now" — so the expected value is captured AROUND the render, and both
    // the instant before and the one after are accepted, because a minute can
    // tick over between the two.
    const format = (ms: number): string =>
      new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    const before = Date.now()
    stubFetch((url) => ({
      body: url.includes('account-credits')
        ? { accounts: [{ id: 'a-1', accountName: 'A One', selected: true, credits: 1072 }] }
        : usageOf(1072),
    }))
    await openPanel()
    const after = Date.now()

    const foot = document.body.querySelector('.dsm-workbuddy-composer-panel-foot')?.textContent ?? ''
    expect(foot).toContain('composer.lastRefresh')
    expect(
      foot.includes(format(before)) || foot.includes(format(after)),
      `the stamp ${JSON.stringify(foot)} is not the reader's locale rendering of ${format(before)}`,
    ).toBe(true)
  })
})

describe('panel refresh regression boundaries', () => {
  it('does not fetch usage ahead of an unfinished balance cycle', async () => {
    fakeIntervals()
    let tableCalls = 0
    let usageCalls = 0
    let release: (() => void) | undefined
    vi.stubGlobal('fetch', async (url: unknown) => {
      if (String(url).includes('account-credits')) {
        tableCalls++
        if (tableCalls === 2) await new Promise<void>(resolve => { release = resolve })
        return jsonAnswer({ accounts: [{ id: 'a-1', accountName: 'A One', selected: true, credits: 100 }] })
      }
      usageCalls++
      return jsonAnswer({ ...usageOf(100), pollIntervalMs: 60_000 })
    })
    const m = await openPanel()
    try {
      const before = usageCalls
      vi.advanceTimersByTime(60_000)
      await m.settle()
      expect(tableCalls).toBe(2)
      expect(usageCalls).toBe(before)
      vi.advanceTimersByTime(60_000)
      await m.settle()
      expect(tableCalls).toBe(2)
      expect(usageCalls, 'the second tick bypasses the balance wait and reads state separately').toBe(before)
    } finally {
      release?.()
      await m.settle()
      await m.unmount()
    }
  })

  it('resumes the readout immediately after cancelling panel usage', async () => {
    fakeIntervals()
    let usageCalls = 0
    let aborted = false
    let release: (() => void) | undefined
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
      if (String(url).includes('account-credits')) {
        return jsonAnswer({ accounts: [{ id: 'a-1', accountName: 'A One', selected: true, credits: 100 }] })
      }
      usageCalls++
      if (usageCalls === 2) {
        await new Promise<void>((resolve, reject) => {
          release = resolve
          init.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
      }
      return jsonAnswer({ ...usageOf(usageCalls === 1 ? 100 : 200), pollIntervalMs: 60_000 })
    })
    const m = await openPanel()
    try {
      if (usageCalls < 2) {
        vi.advanceTimersByTime(300_000)
        await m.settle()
      }
      expect(usageCalls).toBe(2)
      await m.click(m.buttons()[0] as Element)
      release?.()
      await m.settle()
      expect(m.text(), `readout should show the fresh balance after close; aborted=${aborted}, usage calls=${usageCalls}`).toContain('200')
    } finally {
      release?.()
      await m.unmount()
    }
  })


  it('replaces an aborted usage read after a rapid close and reopen', async () => {
    fakeIntervals()
    let usageCalls = 0
    let releaseAbort: (() => void) | undefined
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
      if (String(url).includes('account-credits')) return jsonAnswer({ accounts: [] })
      usageCalls++
      if (usageCalls === 2) {
        await new Promise<void>((_resolve, reject) => {
          releaseAbort = () => reject(new DOMException('aborted', 'AbortError'))
          init.signal?.addEventListener('abort', () => {}, { once: true })
        })
      }
      return jsonAnswer({ ...usageOf(usageCalls === 1 ? 100 : 200), pollIntervalMs: 60_000 })
    })
    const m = await openPanel()
    try {
      expect(usageCalls).toBe(2)
      await m.click(m.buttons()[0] as Element)
      await m.click(m.buttons()[0] as Element)
      releaseAbort?.()
      await m.settle()
      expect(usageCalls).toBe(3)
      expect(m.text()).toContain('200')
    } finally {
      releaseAbort?.()
      await m.unmount()
    }
  })

  it('does not publish an old region manual refresh after changing region', async () => {
    fakeIntervals()
    let domesticReads = 0
    let releaseDomestic: (() => void) | undefined
    let releaseGlobal: (() => void) | undefined
    vi.stubGlobal('fetch', async (url: unknown) => {
      const target = String(url)
      if (target.includes('__save')) return jsonAnswer({ ok: true, value: { accounts: { cn: 'a-2' } } })
      if (target.includes('account-credits')) return jsonAnswer({ accounts: [
        { id: 'a-1', accountName: 'A One', selected: true, credits: 100 },
        { id: 'a-2', accountName: 'A Two', selected: false, credits: 100 },
      ] })
      if (target.includes('region=global')) {
        await new Promise<void>(resolve => { releaseGlobal = resolve })
        return jsonAnswer({ ...usageOf(200), region: 'global' })
      }
      domesticReads++
      if (domesticReads >= 3) await new Promise<void>(resolve => { releaseDomestic = resolve })
      return jsonAnswer(usageOf(domesticReads >= 3 ? 999 : 100))
    })
    const scope = scopeOf({ accounts: {} })
    const m = await openPanel({ settingsScope: scope })
    try {
      const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-composer-panel-switch'))
        .find(value => value.textContent?.includes('A Two'))
      expect(button).toBeDefined()
      await m.click(button!)
      await m.settle()
      expect(releaseDomestic).toBeTypeOf('function')
      await m.update({ t, provider: 'workbuddy', region: 'global', settingsScope: scope })
      releaseDomestic?.()
      await m.settle()
      expect(releaseGlobal).toBeTypeOf('function')
      expect(m.text()).not.toContain('999')
      releaseGlobal?.()
      await m.settle()
      expect(m.text()).toContain('200')
    } finally {
      releaseDomestic?.()
      releaseGlobal?.()
      await m.unmount()
    }
  })



  it('reads fresh usage after a manual switch instead of reusing a pre-switch poll', async () => {
    fakeIntervals()
    let serving = 'a-1'
    let usageCalls = 0
    let release: (() => void) | undefined
    vi.stubGlobal('fetch', async (url: unknown) => {
      const target = String(url)
      if (target.includes('__save')) {
        serving = 'a-2'
        return jsonAnswer({ ok: true, value: { accounts: { cn: serving } } })
      }
      if (target.includes('account-credits')) return jsonAnswer({ accounts: [
        { id: 'a-1', accountName: 'A One', selected: serving === 'a-1', credits: 100 },
        { id: 'a-2', accountName: 'A Two', selected: serving === 'a-2', credits: 100 },
      ] })
      usageCalls++
      const captured = serving
      if (usageCalls === 3) await new Promise<void>(resolve => { release = resolve })
      return jsonAnswer({ ...usageOf(100), accountId: captured, pollIntervalMs: 60_000, pool: {
        enabled: true, checkinSupported: true, targetModelSource: 'none', accounts: [
          { accountId: 'a-1', accountName: 'A One', member: true, current: captured === 'a-1' },
          { accountId: 'a-2', accountName: 'A Two', member: true, current: captured === 'a-2' },
        ],
      } })
    })
    const m = await openPanel()
    try {
      vi.advanceTimersByTime(60_000)
      await m.settle()
      expect(usageCalls).toBe(3)
      expect(release).toBeTypeOf('function')
      const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-composer-panel-switch'))
        .find(value => value.textContent?.includes('A Two'))
      await m.click(button!)
      await m.settle()
      expect(serving).toBe('a-2')
      release?.()
      await m.settle()
      expect(usageCalls, 'a pre-switch poll cannot acknowledge a later account change').toBe(4)
      expect(rowMarkOf('A Two')).toContain('composer.current')
      expect(rowMarkOf('A One')).not.toContain('composer.current')
    } finally {
      release?.()
      await m.unmount()
    }
  })

})
