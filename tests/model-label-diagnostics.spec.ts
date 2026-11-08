/**
 * Reporting whether the model-picker label slot landed.
 *
 * WHY THIS HAS ITS OWN FILE. The slot fails SILENTLY in the one way that
 * matters: it is a `single` cell declared as a CHILD of
 * `conversation.input.model`, so the host only calls our inject callback once
 * that parent entry mounts. If it never does, nothing throws, no disposer is
 * recorded, and the picker simply has no badges — the user sees "they are
 * gone" and there is nothing to report. That is precisely why these three
 * facts exist, and why they are asserted rather than assumed.
 */
import { describe, expect, it, vi } from 'vitest'
import { modelLabelVerdictOf, publishModelLabelState } from '../src/client/index.tsx'

/** A stand-in for the global object that also records warnings. */
function target(): { store: Record<string, unknown>, warnings: string[] } {
  const store: Record<string, unknown> = {}
  const warnings: string[] = []
  const self = {
    ...store,
    warn: (message: string) => { warnings.push(message) },
  }
  // The helper writes and reads the same object, so it must BE the store.
  return {
    store,
    warnings,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(self as any),
  } as never
}

describe('publishModelLabelState', () => {
  it('reports the slot as claimed once the host asked for it', () => {
    const t = target()
    publishModelLabelState({ injectRanAt: 1_700_000_000_000, dispose: () => {} }, t as never)
    expect((t as never as Record<string, unknown>)['__dshWorkBuddyModelLabel__']).toMatchObject({
      injectRanAt: 1_700_000_000_000,
      claimed: true,
    })
  })

  it('reports the silent case: never asked, never claimed, no failure', () => {
    // THE CASE THIS EXISTS FOR. Nothing threw, so `failure` is absent — but the
    // callback never ran either, which means the parent entry never mounted and
    // the badges cannot appear. A report that only carried `failure` would call
    // this state healthy.
    const t = target()
    const view = publishModelLabelState({}, t as never)
    expect(view).toMatchObject({ injectRanAt: undefined, failure: undefined, claimed: false })
  })

  it('publishes WHICH slot contract was in force and how many seats were claimed', () => {
    // `slotKind` + `seats` exist because the picker has ONE symptom — no badges —
    // for two completely different situations: a `single` host where an
    // equal-priority rival took the cell, and a `keyed` host where a provider id
    // was missed. Without these two fields a report cannot tell them apart, and
    // the fix for one is the bug for the other.
    const keyed = target()
    publishModelLabelState(
      { injectRanAt: 1, dispose: () => {}, slotKind: 'keyed', seats: 2 },
      keyed as never,
    )
    expect((keyed as never as Record<string, unknown>)['__dshWorkBuddyModelLabel__']).toMatchObject({
      slotKind: 'keyed',
      seats: 2,
      claimed: true,
    })

    // A host that could not be inspected publishes `unknown` — NOT a guess, and
    // not `undefined`, which would be indistinguishable from "never reached".
    const unknownKind = target()
    publishModelLabelState({ injectRanAt: 1, slotKind: 'unknown', seats: 1 }, unknownKind as never)
    expect((unknownKind as never as Record<string, unknown>)['__dshWorkBuddyModelLabel__']).toMatchObject({
      slotKind: 'unknown',
      seats: 1,
    })
  })

  it('warns exactly once about a failure, never about success', () => {
    const bad = target()
    publishModelLabelState({ failure: 'keyed slot "conversation.input.model.label" requires options.key' }, bad as never)
    const badRecord = bad as never as Record<string, unknown>
    expect(badRecord['__dshWorkBuddyModelLabel__']).toMatchObject({
      failure: 'keyed slot "conversation.input.model.label" requires options.key',
      claimed: false,
    })
    const warnings = (bad as unknown as { warnings: string[] }).warnings
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('could not be registered')

    // A successful claim says NOTHING: a warning that fires when all is well
    // trains the reader to ignore the channel that matters.
    const good = target()
    publishModelLabelState({ injectRanAt: 1, dispose: () => {} }, good as never)
    expect((good as unknown as { warnings: string[] }).warnings).toHaveLength(0)
  })

  it('survives a frozen global and a throwing console', () => {
    // This runs inside `rebindSlots`; a throw here would take the whole slot
    // list down with it, turning a missing badge into a missing card.
    expect(() => publishModelLabelState({ failure: 'x' }, Object.freeze({}) as never)).not.toThrow()
    const throwing = {
      warn: () => { throw new Error('console is gone') },
    } as never
    expect(() => publishModelLabelState({ failure: 'x' }, throwing)).not.toThrow()
  })
})

describe('modelLabelVerdictOf', () => {
  /**
   * FOUR STATES, THREE OF WHICH LOOK IDENTICAL FROM THE PICKER (no badges) and
   * need completely different fixes. Collapsing them is what made this issue take
   * several rounds: "no badge" was reported, and every diagnosis had to start
   * from scratch because the plugin could not say WHICH of the four it was.
   */
  it('says the client half never reached registration', () => {
    // Nothing recorded at all. A boot/composition problem — the slot is not even
    // in the picture yet.
    expect(modelLabelVerdictOf({})).toBe('not-reached')
  })

  it('says the host never called back (the silent case)', () => {
    // We asked; no callback, no throw. The parent entry `conversation.input.model`
    // has not mounted, so the child cell does not exist.
    expect(modelLabelVerdictOf({ askedAt: 1_000 })).toBe('parent-not-mounted')
  })

  it('says it landed', () => {
    expect(modelLabelVerdictOf({ askedAt: 1_000, injectRanAt: 2_000, dispose: () => {} })).toBe('claimed')
  })

  it('reports a throw ahead of everything else', () => {
    // A collision is the one state that DOES produce a message, and it must win
    // over the timestamps: if `register()` threw there is no claim to describe.
    expect(modelLabelVerdictOf({ askedAt: 1_000, injectRanAt: 2_000, failure: 'boom' })).toBe('failed')
    expect(modelLabelVerdictOf({ askedAt: 1_000, failure: 'boom' })).toBe('failed')
  })

  it('is what the published view carries', () => {
    // The verdict is the field a reader acts on; if it were absent from the
    // published object the console line and `window` would disagree.
    const t = target()
    const view = publishModelLabelState({ askedAt: 5 }, t as never)
    expect(view?.['verdict']).toBe('parent-not-mounted')
    expect((t as never as Record<string, unknown>)['__dshWorkBuddyModelLabel__']).toMatchObject({
      verdict: 'parent-not-mounted',
      askedAt: 5,
    })
  })
})
