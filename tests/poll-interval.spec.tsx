// @vitest-environment jsdom
/**
 * The refresh interval is a SETTING, and these tests pin the three things that
 * make it one rather than a hard-coded constant (issue #232 follow-up).
 *
 * The complaint that started this: the card polled every 60 seconds, and one
 * poll of a 4-account pool costs ~8 upstream requests (a credits read plus a
 * check-in read per account). That is ~11,520 requests a day for figures that
 * move slowly. The answer is not a different constant — it is a control, with a
 * 5-minute default.
 *
 * Three independent properties, and each has its own way of going wrong:
 *
 *   1. The Host must REFUSE a value outside the offered set. A free number would
 *      let a hand-edited profile or a stale bundle arm `setInterval(…, 0)`.
 *   2. The card must ARM the value it was given. A picker that saves a number
 *      nothing reads is a control that lies.
 *   3. The composer panel must follow the SAME value. Two surfaces disagreeing
 *      about one account is the original defect this cadence work exists for.
 */
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKBUDDY_DEFAULT_POLL_INTERVAL_MS, WORKBUDDY_POLL_INTERVALS_MS } from '../src/status-paths.ts'
import { pollIntervalMsOf } from '../src/client/account-selection.ts'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS } from '../src/client/ComposerCredits.tsx'
import { mount, fakeScope, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/**
 * Fake ONLY the interval API, never `setTimeout`.
 *
 * `Mounted.settle` drains React with a real `setTimeout(…, 0)`, so faking that
 * timer deadlocks every helper here: the timer the component arms is not the
 * timer the harness waits on. The card's poll is a `setInterval`, so that is the
 * one thing that needs to be controllable.
 */
const fakeIntervals = (): void => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
}

/** The document the card renders from, with an optional saved interval. */
function usageOf(intervalMs?: number): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    domain: 'www.codebuddy.cn',
    accountId: 'cn-1',
    accountName: '账号A',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'cn-1', accountName: '账号A' }],
    models: [{ id: 'glm-5.3', name: 'GLM-5.3' }],
    enabledModelIds: ['glm-5.3'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 10, expiringSoon: 0, packages: [] },
    ...intervalMs === undefined ? {} : { pollIntervalMs: intervalMs },
  }
}

describe('the offered interval set', () => {
  it('is the five documented steps, and the default is one of them', () => {
    // The set IS the validation: the dropdown can only produce these, and the
    // Host only accepts these, so the two cannot drift apart.
    expect(WORKBUDDY_POLL_INTERVALS_MS).toEqual([60_000, 300_000, 600_000, 1_800_000, 3_600_000])
    expect(WORKBUDDY_POLL_INTERVALS_MS).toContain(WORKBUDDY_DEFAULT_POLL_INTERVAL_MS)
    // 5 minutes, not the old 60 s — that move is the point of the change.
    expect(WORKBUDDY_DEFAULT_POLL_INTERVAL_MS).toBe(5 * 60_000)
  })

  it('is strictly ascending, so a menu built from it reads as a scale', () => {
    for (let i = 1; i < WORKBUDDY_POLL_INTERVALS_MS.length; i += 1) {
      expect(WORKBUDDY_POLL_INTERVALS_MS[i]!).toBeGreaterThan(WORKBUDDY_POLL_INTERVALS_MS[i - 1]!)
    }
  })
})

describe('pollIntervalMsOf coerces toward the SAFE direction', () => {
  it('accepts every offered value verbatim', () => {
    for (const interval of WORKBUDDY_POLL_INTERVALS_MS) {
      expect(pollIntervalMsOf({ pollIntervalMs: interval })).toBe(interval)
    }
  })

  it('falls back to the DEFAULT for anything outside the set', () => {
    // The direction matters: this number drives `setInterval`, so a typo must
    // not become a sub-second poll. `0` is the dangerous one — it would poll
    // continuously — and a huge value would silently stop refreshing.
    for (const bad of [0, 1, 1000, 59_999, 61_000, 7 * 60_000, -60_000, Number.NaN, '60000', null]) {
      expect(pollIntervalMsOf({ pollIntervalMs: bad }), `value ${String(bad)}`).toBe(
        WORKBUDDY_DEFAULT_POLL_INTERVAL_MS,
      )
    }
  })

  it('reads an absent or unreadable settings value as the default', () => {
    expect(pollIntervalMsOf({})).toBe(WORKBUDDY_DEFAULT_POLL_INTERVAL_MS)
    expect(pollIntervalMsOf(undefined)).toBe(WORKBUDDY_DEFAULT_POLL_INTERVAL_MS)
    expect(pollIntervalMsOf(null)).toBe(WORKBUDDY_DEFAULT_POLL_INTERVAL_MS)
  })
})

describe('the card arms the interval it was given', () => {
  it('polls at the document value, not at a hard-coded minute', async () => {
    // THE discriminating assertion: a picker can save any number, but only a
    // timer that reads it makes the setting real. Fake timers let this count
    // the actual refreshes instead of inspecting source text.
    fakeIntervals()
    try {
      stubFetch((url: string) => ({ body: url.includes('__save') ? { value: {} } : usageOf(600_000) }))
      const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
      await m.settle()
      const fetchStub = globalThis.fetch as unknown as { mock: { calls: unknown[] } }
      const before = fetchStub.mock.calls.length
      // 5 minutes of clock: at 10 minutes per poll, nothing may happen.
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000) })
      expect(fetchStub.mock.calls.length - before, 'a 10-minute cadence must not poll at 5 minutes').toBe(0)
      // One more minute reaches the boundary; exactly one poll is due.
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000) })
      expect(fetchStub.mock.calls.length, 'the 10-minute cadence must poll by then').toBeGreaterThan(before)
      await m.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to 5 minutes when the document does not carry an interval', async () => {
    // An older Host cannot answer. The card must then use the shared default —
    // not 60 s, which is the cadence this change deliberately moved away from.
    fakeIntervals()
    try {
      stubFetch((url: string) => ({ body: url.includes('__save') ? { value: {} } : usageOf(undefined) }))
      const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
      await m.settle()
      const fetchStub = globalThis.fetch as unknown as { mock: { calls: unknown[] } }
      const before = fetchStub.mock.calls.length
      // Just under 5 minutes: still quiet.
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 - 1000) })
      expect(fetchStub.mock.calls.length - before).toBe(0)
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(fetchStub.mock.calls.length).toBeGreaterThan(before)
      await m.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the composer panel follows the card, not its own constant', () => {
  it('uses the shared default as its fallback, never a second literal', () => {
    // The old arrangement had two 60 s numbers that merely happened to agree.
    // The fallback is now the SAME constant the Host defaults to, so a change
    // to the default cannot leave the panel behind.
    expect(COMPOSER_ACCOUNT_REFRESH_INTERVAL_MS).toBe(WORKBUDDY_DEFAULT_POLL_INTERVAL_MS)
  })
})
