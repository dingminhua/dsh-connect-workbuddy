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
import { publishModelLabelState } from '../src/client/index.tsx'

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

  it('warns exactly once about a failure, never about success', () => {
    const bad = target()
    publishModelLabelState({ failure: 'single slot already has a registration at priority -0.5' }, bad as never)
    const badRecord = bad as never as Record<string, unknown>
    expect(badRecord['__dshWorkBuddyModelLabel__']).toMatchObject({
      failure: 'single slot already has a registration at priority -0.5',
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
