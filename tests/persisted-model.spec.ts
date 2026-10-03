import { describe, expect, it } from 'vitest'
import { toPersistedWorkBuddyModel } from '../src/status-paths.ts'
import type { WorkBuddyWebModel } from '../src/status-paths.ts'
import { offDefaultFor } from '../src/off-thinking.ts'

function webModel(): WorkBuddyWebModel {
  return {
    id: 'hy3',
    name: 'Hy3',
    contextWindow: 200_000,
    nativeContextWindow: 1_000_000,
    maxTokens: 64_000,
    creditMultiplier: 0.05,
    multimodal: true,
    reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' },
  }
}

/**
 * The strict settings write codec (`settings/mutate` ops) accepts only JSON
 * values; an explicit `undefined` property survives `structuredClone` and
 * fails the whole save with `client api: settings/mutate rejected "ops"`.
 * The persisted projection must therefore strip card-only fields BY KEY.
 */
describe('toPersistedWorkBuddyModel', () => {
  it('stores the native context window and drops the card-only fields by key', () => {
    expect(toPersistedWorkBuddyModel(webModel())).toEqual({
      id: 'hy3',
      name: 'Hy3',
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      creditMultiplier: 0.05,
      reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' },
    })
  })

  it('produces no undefined-valued properties (strict JSON codec compatibility)', () => {
    for (const model of [webModel(), { ...webModel(), multimodal: false }]) {
      const persisted = toPersistedWorkBuddyModel(model)
      expect(Object.values(persisted).every(value => value !== undefined)).toBe(true)
      // A JSON round trip must be lossless for the codec to accept it.
      expect(JSON.parse(JSON.stringify(persisted))).toEqual(persisted)
    }
  })

  it('keeps the upstream image default while still dropping the stamped flag', () => {
    // `supportsImages` is upstream's own answer and belongs in the stored
    // directory (it travels with the entry like the credit multiplier), while
    // `multimodal` is the runtime value stamped from the saved selection and
    // must never be written back — re-reading it would resurrect an opt-in the
    // user later removed.
    const persisted = toPersistedWorkBuddyModel({ ...webModel(), supportsImages: true })
    expect(persisted.supportsImages).toBe(true)
    expect('multimodal' in persisted).toBe(false)
  })

  it('keeps the off declaration so a save cannot withdraw a working level (issue #34)', () => {
    // The sibling of the `supportsImages` rule above, and the reason it exists:
    // the declaration must survive the card's save into `lastCatalog`, or the
    // runtime's default (an absent declaration never offers `off`) silently
    // withdraws the level from every model the user has NOT overridden.
    // Flipping that default to `true` is not an option — `hy4-preview` and
    // `hy3-x` declare `false`.
    const persisted = toPersistedWorkBuddyModel({
      ...webModel(),
      reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisableThinking: true },
    })
    expect(persisted.reasoning).toEqual({
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'high',
      canDisableThinking: true,
    })
    // The stored shape is what the runtime rule reads, so the round trip has to
    // still ANSWER the question, not merely preserve a field.
    expect(offDefaultFor(persisted)).toBe(true)
  })

  it('stores an explicit false rather than dropping it', () => {
    // `false` is an ANSWER, not an absence: dropping it would make the runtime
    // fall back to a default that could disagree with what upstream declared.
    const persisted = toPersistedWorkBuddyModel({
      ...webModel(),
      reasoning: { supportedEfforts: ['high'], canDisableThinking: false },
    })
    expect(persisted.reasoning?.canDisableThinking).toBe(false)
    expect(offDefaultFor(persisted)).toBe(false)
  })

  it('omits the declaration entirely when upstream never gave one', () => {
    // Absent must stay absent: writing `undefined` fails the strict JSON codec,
    // and inventing `false` would misreport an undeclared capability.
    expect('canDisableThinking' in (toPersistedWorkBuddyModel(webModel()).reasoning ?? {})).toBe(false)
  })
})
