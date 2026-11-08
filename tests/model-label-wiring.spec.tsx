// @vitest-environment jsdom
/**
 * The WIRING, not the plan: does `apply()` actually reach the registry the way
 * `model-label-seat.ts` says it should?
 *
 * WHY THIS FILE EXISTS. Every other label test drives `modelLabelSeats` /
 * `registerModelLabelSeats` directly, or drives the component. None of them runs
 * the real `registerModelLabel()` inside `apply()`, so three of the most
 * expensive mistakes in this area are invisible to them:
 *
 *   1. Reading the kind once and hardcoding it (`kind: 'single'`) — the planner
 *      tests stay green because they call the planner themselves.
 *   2. Moving the `try/catch` back OUTSIDE the inject callback. The whole point
 *      of the in-callback catch is that `inject()` may DEFER the callback and a
 *      deferred throw is re-thrown from a `queueMicrotask`, out of reach of any
 *      call-site try/catch — the user gets a renderer error banner on the first
 *      paint. A catch in the wrong place still passes every planner test.
 *   3. Publishing the diagnostics ONCE, before the deferred callback ever runs,
 *      so `window.__dshWorkBuddyModelLabel__` reports a state that predates the
 *      registration. (This one was real: the fields were added, the publish was
 *      not moved, and nothing failed.)
 *
 * So this suite asserts the observable consequences: the registry receives what
 * the declaration says it should, a deferred refusal is CONTAINED rather than
 * escaping the microtask, and the published view reflects the deferred outcome.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'

const SLOT = 'conversation.input.model.label'

/** A `slots` service backed by the REAL core, with an inject that can defer. */
function slotsFixture(options: { kind: 'single' | 'keyed', defer: boolean }) {
  const core = new SlotCore()
  ;(core as unknown as {
    register(options: { name: string, children: Record<string, unknown> }, component: unknown): void
  }).register({ name: 'root', children: { [SLOT]: { kind: options.kind, scope: 'session' } } }, () => null)

  const deferred: Array<() => void> = []
  const slots = {
    spec: (key: string) => (core as unknown as { spec(k: string): { kind?: string } | undefined }).spec(key),
    entries: (key: string) => (core as unknown as { entries(k: string): unknown[] }).entries(key),
    // ONLY the label slot is real. `apply()` registers several other slots too;
    // this fixture declares just the one under test and lets the others no-op,
    // because their behaviour is not what these cases are about.
    register: (seat: { name: string, priority?: number, key?: string }, component: unknown) =>
      seat.name === SLOT
        ? (core as unknown as {
          register(o: typeof seat, c: unknown): () => void
        }).register(seat, component)
        : () => {},
    // `inject` returns a disposer either way. When `defer` is set the callback is
    // queued instead of run — the shape the host uses for a not-yet-declared
    // slot, and the reason the catch has to live inside the callback.
    inject: (key: string, callback: () => () => void) => {
      if (key !== SLOT) return () => {}
      if (options.defer) deferred.push(() => { disposers.push(callback()) })
      else disposers.push(callback())
      return () => {}
    },
  }
  /** Disposers the callbacks returned, in the order they were produced. */
  const disposers: (() => void)[] = []
  return {
    core,
    slots,
    disposers,
    flush: () => { for (const run of deferred.splice(0)) run() },
  }
}

/** The minimum `apply()` touches before the label registration. */
function ctxFor(slots: unknown): Context {
  return {
    slots,
    locale: { register: () => () => {}, bind: () => () => '' },
    effect: () => () => {},
    get: () => undefined,
  } as unknown as Context
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>)['__dshWorkBuddyModelLabel__']
})

describe('apply() wiring for the model-label seat', () => {
  it('registers ONE keyless entry against a single host', async () => {
    const { slots, core, flush } = slotsFixture({ kind: 'single', defer: true })
    const { apply } = await import('../src/client/index.tsx')
    apply(ctxFor(slots))
    flush()
    const entries = (core as unknown as { entries(k: string): { options: Record<string, unknown> }[] }).entries(SLOT)
    expect(entries).toHaveLength(1)
    // No `key` property at all — not `key: undefined`, which a spread could add.
    expect(entries[0]?.options).not.toHaveProperty('key')
  })

  it('registers one entry PER provider id against a keyed host', async () => {
    const { slots, core, flush } = slotsFixture({ kind: 'keyed', defer: true })
    const { apply } = await import('../src/client/index.tsx')
    apply(ctxFor(slots))
    flush()
    const entries = (core as unknown as { entries(k: string): { options: { key?: string } }[] }).entries(SLOT)
    expect(entries.map(entry => entry.options.key).sort()).toEqual(['workbuddy', 'workbuddy-global'])
  })

  it('CONTAINS a refusal raised from the DEFERRED callback instead of letting it escape', async () => {
    // The regression this pins is #74's, and it is the reason the catch lives
    // INSIDE the inject callback: a throw from a deferred callback is re-thrown
    // by the renderer's `changed()` handler out of a `queueMicrotask`, where no
    // call-site try/catch can reach it — the user gets a renderer error banner
    // on the first paint instead of a log line.
    //
    // The refusal is FORCED rather than hoped for: on a `keyed` host a keyless
    // seat is rejected by the registry, so the real `register()` throws.
    const { slots, flush } = slotsFixture({ kind: 'keyed', defer: true })
    const seatModule = await import('../src/client/model-label-seat.ts')
    vi.spyOn(seatModule, 'modelLabelSeats').mockReturnValue([{ name: SLOT, priority: -105 }])
    const { apply } = await import('../src/client/index.tsx')
    apply(ctxFor(slots))
    // The deferred callback has not run yet, so nothing has been refused.
    expect(() => flush()).not.toThrow()
    // …and the refusal is recorded where a report can find it, which is only
    // possible if the catch was in the callback's scope.
    const published = (globalThis as Record<string, unknown>)['__dshWorkBuddyModelLabel__'] as
      { failure?: string, verdict?: string } | undefined
    expect(published?.verdict).toBe('failed')
    expect(published?.failure).toMatch(/requires options\.key/)
  })

  it('publishes the DEFERRED outcome, not the stale pre-callback snapshot', async () => {
    // The bug this pins: `rebindSlots` publishes once, before a deferred
    // callback exists. Without a republish from inside the callback, the view on
    // `window` keeps `slotKind: undefined, seats: undefined` and the verdict
    // `parent-not-mounted` — the opposite of the truth — even though the
    // registration succeeded.
    const { slots, flush } = slotsFixture({ kind: 'keyed', defer: true })
    const { apply } = await import('../src/client/index.tsx')
    apply(ctxFor(slots))
    flush()
    const published = (globalThis as Record<string, unknown>)['__dshWorkBuddyModelLabel__'] as
      { slotKind?: string, seats?: number, verdict?: string } | undefined
    expect(published?.slotKind).toBe('keyed')
    expect(published?.seats).toBe(2)
    expect(published?.verdict).toBe('claimed')
  })
  it('keeps the pre-existing contract: the returned disposer frees the cell, and only the cell', async () => {
    // The original requirement, restated so a future "keyed" change cannot
    // quietly violate it. `rebindSlots` documents its order as DISPOSE FIRST,
    // then register — so the disposer must genuinely empty the ledger. A
    // composite that released nothing (or everything, including someone else's
    // entry) would break the rebind cycle in a way no planner test can see.
    const { slots, core, flush, disposers } = slotsFixture({ kind: 'single', defer: true })
    const { apply } = await import('../src/client/index.tsx')
    apply(ctxFor(slots))
    flush()
    const entries = () => (core as unknown as { entries(k: string): unknown[] }).entries(SLOT)
    expect(entries()).toHaveLength(1)
    expect(disposers).toHaveLength(1)
    disposers[0]!()
    expect(entries()).toHaveLength(0)
    // Disposing twice is safe (the registry's own disposers are guarded).
    expect(() => disposers[0]!()).not.toThrow()
  })

  it('keeps the pre-existing contract: the winning component is still THIS plugin\'s label', async () => {
    const { slots, core, flush } = slotsFixture({ kind: 'single', defer: true })
    const { apply } = await import('../src/client/index.tsx')
    apply(ctxFor(slots))
    flush()
    const winner = (core as unknown as {
      entriesOfSlot(k: string): { component?: { name?: string } }[]
    }).entriesOfSlot(SLOT)[0]
    // Not just "some entry won" — it is the full label, which is the feature.
    expect(winner?.component?.name).toBe('WorkBuddyModelLabel')
  })

  it('keeps the pre-existing contract: priority is the SHIPPED value on both shapes', async () => {
    // The priority arms race must not be disturbed by this refactor: -105 on a
    // single host, and the same -105 inside each keyed cell.
    const { modelLabelSeats } = await import('../src/client/model-label-seat.ts')
    const { MODEL_LABEL_PRIORITY, WORKBUDDY_PROVIDER_IDS } = await import('../src/client/WorkBuddyModelLabel.tsx')
    for (const kind of ['single', 'keyed', undefined] as const) {
      const seats = modelLabelSeats({ name: SLOT, kind, providerIds: WORKBUDDY_PROVIDER_IDS, priority: MODEL_LABEL_PRIORITY })
      expect(seats.every(seat => seat.priority === MODEL_LABEL_PRIORITY)).toBe(true)
    }
  })
})
