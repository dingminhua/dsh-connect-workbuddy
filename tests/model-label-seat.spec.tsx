// @vitest-environment jsdom
/**
 * How many model-label seats this plugin claims, and under which keys.
 *
 * WHY THIS IS A RUNTIME DECISION. `conversation.input.model.label` is declared
 * by the HOST (`@deepseek-ai/dsh-client-ui-model-selection`). Until that
 * declaration changes it is `single`, which holds exactly one cell: every
 * registration shares the `undefined` cell, `entriesOfSlot` keeps only the first
 * in priority order, and every other registration is discarded with no log.
 *
 * A `keyed` declaration is the contract this work is aimed at: each
 * `options.key` is its own cell, the owner dispatches per row with
 * `{ entryKey: provider.id }`, and a provider with no contribution falls through
 * to the owner's own fallback. One seat per provider id is therefore exactly one
 * row's decoration — which is what this plugin always wanted.
 *
 * THE FAILURE THIS SUITE EXISTS TO PREVENT. Getting the count wrong in either
 * direction is silent:
 *
 *   - two keyed seats registered against a `single` host throw on the SECOND
 *     (`single slot … already has a registration at priority …`), and the
 *     plugin's catch turns that into a console line while the picker shows no
 *     badges;
 *   - one unkeyed seat registered against a `keyed` host throws
 *     `keyed slot … requires options.key` — the same silent disappearance, for
 *     the opposite reason.
 *
 * Both are exercised against the REAL `SlotCore` from
 * `@deepseek-ai/dsh-client-ui-slots`, declared both ways, so the constraints
 * under test are the host's rather than this suite's invention.
 */
import { describe, expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { declaredSlotKind, type ModelLabelSeatKind, modelLabelSeats, registerModelLabelSeats } from '../src/client/model-label-seat.ts'
import { MODEL_LABEL_PRIORITY, WORKBUDDY_PROVIDER_IDS, WorkBuddyModelLabel } from '../src/client/WorkBuddyModelLabel.tsx'

const SLOT = 'conversation.input.model.label'

/** Somewhere a plugin goes to claim a cell, narrowed only in the TYPING. */
interface ClaimableSlot {
  register(options: { name: string, priority?: number, key?: string }, component: unknown): () => void
  entries(key: string): readonly { options: { key?: string, priority?: number } }[]
  entriesOfSlot(key: string): readonly { component: unknown, options: { key?: string } }[]
  spec(key: string): { kind?: string } | undefined
}

/**
 * A slot core with the label declared as `kind`.
 *
 * `root` carries the child table: that is a DECLARATION, not a claim, so no
 * priority applies to it. The declaration is what `register()` validates
 * against, which is the whole point — the same plugin code must behave
 * differently under the two contracts, and only the host's declaration differs.
 */
function core(kind: ModelLabelSeatKind): ClaimableSlot {
  const slotCore = new SlotCore()
  ;(slotCore as unknown as {
    register(options: { name: string, children: Record<string, { kind: string, scope: string }> }, component: unknown): void
  }).register({ name: 'root', children: { [SLOT]: { kind, scope: 'session' } } }, () => null)
  return slotCore as unknown as ClaimableSlot
}

/** Register this plugin's planned seats, exactly as the client entry does. */
function claim(slotCore: ClaimableSlot, seats = modelLabelSeats({
  name: SLOT,
  kind: declaredSlotKind(slotCore, SLOT),
  providerIds: WORKBUDDY_PROVIDER_IDS,
  priority: MODEL_LABEL_PRIORITY,
})): void {
  for (const seat of seats) slotCore.register(seat, WorkBuddyModelLabel)
}

describe('declaredSlotKind', () => {
  it('reads the kind the running host declared', () => {
    expect(declaredSlotKind(core('single'), SLOT)).toBe('single')
    expect(declaredSlotKind(core('keyed'), SLOT)).toBe('keyed')
    expect(declaredSlotKind(core('list'), SLOT)).toBe('list')
  })

  it('reports undefined rather than guessing when the slot is not declared', () => {
    // A `slots` service with no declaration for this key yet: the inject
    // callback can run before the parent mounts. Guessing here would choose a
    // seat shape at random.
    expect(declaredSlotKind(new SlotCore(), SLOT)).toBeUndefined()
  })

  it('reports undefined when the service cannot be inspected at all', () => {
    // An older line without `spec()`, a service that is not ready, a getter that
    // throws: all three must degrade to the conservative single-cell shape
    // rather than take the registration path down.
    expect(declaredSlotKind(undefined, SLOT)).toBeUndefined()
    expect(declaredSlotKind({}, SLOT)).toBeUndefined()
    expect(declaredSlotKind({ spec: () => { throw new Error('not ready') } }, SLOT)).toBeUndefined()
    expect(declaredSlotKind({ spec: () => ({ kind: 'something-new' }) }, SLOT)).toBeUndefined()
  })
})

describe('modelLabelSeats', () => {
  it('claims ONE unkeyed seat on a single host', () => {
    const seats = modelLabelSeats({ name: SLOT, kind: 'single', providerIds: WORKBUDDY_PROVIDER_IDS, priority: MODEL_LABEL_PRIORITY })
    expect(seats).toEqual([{ name: SLOT, priority: MODEL_LABEL_PRIORITY }])
    // Specifically: no `key`. A key on a `single` host buys nothing (the entry
    // still lands in the shared undefined cell) and invites the opposite bug.
    expect(seats[0]).not.toHaveProperty('key')
  })

  it('claims one seat PER provider id on a keyed host', () => {
    const seats = modelLabelSeats({ name: SLOT, kind: 'keyed', providerIds: WORKBUDDY_PROVIDER_IDS, priority: MODEL_LABEL_PRIORITY })
    expect(seats.map(seat => seat.key)).toEqual(['workbuddy', 'workbuddy-global'])
    expect(seats.every(seat => seat.priority === MODEL_LABEL_PRIORITY)).toBe(true)
  })

  it('plans NOTHING for `list` / `chain`, because their seats need options we do not have', () => {
    // `list` requires `options.id` and `chain` requires `options.select`. The
    // single-seat fallback would therefore be REFUSED by the registry — a plan
    // that cannot register is worse than no plan, because it reads as an
    // attempt. An empty plan is the honest answer for a contract this plugin
    // does not serve.
    for (const kind of ['list', 'chain'] as const) {
      expect(modelLabelSeats({ name: SLOT, kind, providerIds: WORKBUDDY_PROVIDER_IDS, priority: MODEL_LABEL_PRIORITY }))
        .toEqual([])
    }
  })

  it('falls back to the single seat rather than claiming nothing', () => {
    // An empty provider list under `keyed` would register zero seats: the label
    // would vanish with no throw, the worst of the three failure modes. A
    // wrong-shaped seat that still draws something is the safer degradation —
    // and it is unreachable in practice, because the provider list is a
    // compile-time constant with two entries.
    expect(modelLabelSeats({ name: SLOT, kind: 'keyed', providerIds: [], priority: MODEL_LABEL_PRIORITY }))
      .toEqual([{ name: SLOT, priority: MODEL_LABEL_PRIORITY }])
  })
})

describe('the plan, executed against the real registry', () => {
  it('one seat lands cleanly on a single host, and only one ever renders', () => {
    const slotCore = core('single')
    // The host's own contributor, at the default priority — the situation that
    // made this plugin lose the cell silently before `-105`.
    slotCore.register({ name: SLOT, priority: 0 }, () => 'host')
    expect(() => claim(slotCore)).not.toThrow()
    // Both registrations survive on the ledger…
    expect(slotCore.entries(SLOT)).toHaveLength(2)
    // …but the cell resolves to exactly one winner, and it is ours.
    expect(slotCore.entriesOfSlot(SLOT)).toHaveLength(1)
    expect(slotCore.entriesOfSlot(SLOT)[0]?.component).toBe(WorkBuddyModelLabel)
  })

  it('TWO keyed seats coexist with each other and with the host\'s contributor', () => {
    const slotCore = core('keyed')
    slotCore.register({ name: SLOT, priority: 0, key: 'deepseek-official' }, () => 'host')
    expect(() => claim(slotCore)).not.toThrow()
    // Three cells, three winners: nobody was dropped. This is the property the
    // whole change is for — under `single` the same three registrations would
    // have been one winner and two silent losses.
    const cells = slotCore.entriesOfSlot(SLOT)
    expect(cells).toHaveLength(3)
    expect(cells.map(entry => entry.options.key).sort()).toEqual(['deepseek-official', 'workbuddy', 'workbuddy-global'])
    expect(cells.some(entry => entry.component === WorkBuddyModelLabel)).toBe(true)
  })

  it('the unkeyed single seat is REFUSED by a keyed host, which is why the kind is read', () => {
    // Not a hypothetical: this is exactly what would happen to every released
    // version of this plugin on the day the host flips the declaration. The
    // plugin's catch would swallow it and the badges would vanish with one
    // console line, so the seat count has to follow the declaration.
    const slotCore = core('keyed')
    expect(() => slotCore.register({ name: SLOT, priority: MODEL_LABEL_PRIORITY }, WorkBuddyModelLabel))
      .toThrow(/requires options\.key/)
  })

  it('the SECOND keyed seat is REFUSED by a single host, which is why the count is one', () => {
    // The mirror failure: claiming per provider on a `single` host throws on the
    // second seat, after the first has already landed. A plugin that shipped the
    // keyed plan unconditionally would therefore half-register and log.
    const slotCore = core('single')
    const seats = modelLabelSeats({ name: SLOT, kind: 'keyed', providerIds: WORKBUDDY_PROVIDER_IDS, priority: MODEL_LABEL_PRIORITY })
    slotCore.register(seats[0]!, WorkBuddyModelLabel)
    expect(() => slotCore.register(seats[1]!, WorkBuddyModelLabel))
      .toThrow(/already has a registration/)
  })
})

describe('the provider list is the component\'s own', () => {
  it('covers exactly the ids the label knows how to decorate', () => {
    // Registration and rendering must agree on "which rows are mine", or a seat
    // is registered for a provider whose rows fall into the foreign branch (and
    // render as the host's plain fallback on a keyed host, invisibly).
    expect([...WORKBUDDY_PROVIDER_IDS]).toEqual(['workbuddy', 'workbuddy-global'])
  })
})

describe('registerModelLabelSeats', () => {
  it('registers every seat and releases them all, in reverse order', () => {
    const order: string[] = []
    const dispose = registerModelLabelSeats(
      [{ name: SLOT, key: 'a', priority: 1 }, { name: SLOT, key: 'b', priority: 1 }],
      seat => {
        order.push(`register ${seat.key ?? '(none)'}`)
        return () => order.push(`dispose ${seat.key ?? '(none)'}`)
      },
    )
    expect(order).toEqual(['register a', 'register b'])
    dispose()
    // Reverse: the last seat claimed is the first released, which is the only
    // order that stays correct if a later seat ever depends on an earlier one.
    expect(order).toEqual(['register a', 'register b', 'dispose b', 'dispose a'])
  })

  it('ROLLS BACK the seats that already landed when a later one is refused', () => {
    // The bug this prevents: a plain `.map()` loses the disposers of the seats
    // that succeeded, because they were only held by the array the throw
    // discarded. The ledger keeps those entries forever, the caller believes it
    // failed, and nothing can release them.
    const slotCore = core('single')
    const seats = modelLabelSeats({
      name: SLOT,
      kind: 'keyed',
      providerIds: WORKBUDDY_PROVIDER_IDS,
      priority: MODEL_LABEL_PRIORITY,
    })
    // Force the shape mismatch a plain `.map()` would produce on a single host.
    expect(() => registerModelLabelSeats(seats, seat => slotCore.register(seat, WorkBuddyModelLabel)))
      .toThrow(/already has a registration/)
    // Nothing left behind: the first seat was released by the rollback.
    expect(slotCore.entries(SLOT)).toHaveLength(0)
    expect(slotCore.entriesOfSlot(SLOT)).toHaveLength(0)
  })

  it('leaves no orphan when the FIRST seat is refused', () => {
    const slotCore = core('keyed')
    expect(() => registerModelLabelSeats(
      [{ name: SLOT, priority: MODEL_LABEL_PRIORITY }], // no key on a keyed host
      seat => slotCore.register(seat, WorkBuddyModelLabel),
    )).toThrow(/requires options\.key/)
    expect(slotCore.entries(SLOT)).toHaveLength(0)
  })

  it('does not let a throwing disposer mask the original refusal', () => {
    // A broken unwinder must not turn one refusal into a crash with no cause.
    expect(() => registerModelLabelSeats(
      [{ name: SLOT, key: 'a', priority: 1 }, { name: SLOT, key: 'b', priority: 1 }],
      seat => {
        if (seat.key === 'b') throw new Error('refused')
        return () => { throw new Error('dispose exploded') }
      },
    )).toThrow('refused')
  })

  it('runs every underlying disposer exactly once per call, and twice on a double dispose', () => {
    // The release path can run twice (a re-inject releases, then apply tears
    // down). This pins what the composite actually delegates: it does NOT
    // deduplicate, so idempotence has to come from the registry's own disposers
    // (which are guarded). Asserting "does not throw" against a no-op disposer
    // would pass no matter what the composite did.
    const calls: string[] = []
    const dispose = registerModelLabelSeats(
      [{ name: SLOT, key: 'a', priority: 1 }, { name: SLOT, key: 'b', priority: 1 }],
      seat => () => calls.push(String(seat.key)),
    )
    dispose()
    expect(calls).toEqual(['b', 'a'])
    dispose()
    expect(calls).toEqual(['b', 'a', 'b', 'a'])
  })

  it('an EMPTY plan releases nothing and does not throw', () => {
    // Reachable via the `list` / `chain` plan above, and from a zero-provider
    // keyed host.
    const dispose = registerModelLabelSeats([], () => { throw new Error('must not be called') })
    expect(() => dispose()).not.toThrow()
  })
})
