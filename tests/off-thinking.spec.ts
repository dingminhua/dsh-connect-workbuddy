import { describe, expect, it } from 'vitest'
import { effectiveOff, offDefaultFor, REFUSES_OFF_MODEL_IDS, withEffectiveOff } from '../src/off-thinking.ts'

/**
 * Which models can actually turn thinking off (issue #34).
 *
 * The upstream's `reasoning.canDisableThinking` is the only declared signal, and
 * it is WRONG for nine models: they answer HTTP 400 to
 * `reasoning_effort: "off"`, the refusal does not name the parameter, and
 * because the level is part of the saved per-model selection it fails on every
 * later request too. These tests lock the reviewed table in as the correction,
 * and lock the user's override to a genuine two-way answer.
 *
 * The refusing ids are listed here INDEPENDENTLY of the source table on
 * purpose: a test that iterated the implementation's own set would stay green
 * if an id were quietly dropped from it.
 */
const REFUSING_PER_ISSUE_34 = [
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-sg',
  'deepseek-v4-pro',
  'primary-model',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gemini-3.5-flash',
]

/**
 * Models issue #34 measured as ACCEPTING `off` (HTTP 200) while declaring
 * `canDisableThinking: true`. They must keep the level, because hiding it would
 * be a functional regression for the majority of the roster.
 */
const ACCEPTING_PER_ISSUE_34 = [
  'fast-model',
  'balanced-model',
  'glm-5.3-flash',
  'glm-5.3',
  'glm-5.2',
  'kimi-k3',
  'kimi-k2.6',
  'kimi-k2.8-preview',
]

/** A model that declares thinking can be disabled, as the gateways report it. */
function declaring(id: string) {
  return { id, reasoning: { supportedEfforts: ['low', 'medium', 'high'], canDisableThinking: true } }
}

describe('REFUSES_OFF_MODEL_IDS', () => {
  it('lists exactly the ids issue #34 measured as refusing off', () => {
    expect([...REFUSES_OFF_MODEL_IDS].sort()).toEqual([...REFUSING_PER_ISSUE_34].sort())
  })
})

describe('offDefaultFor', () => {
  it('withdraws off for every model measured as refusing it', () => {
    for (const id of REFUSING_PER_ISSUE_34) {
      expect(offDefaultFor(declaring(id)), id).toBe(false)
    }
  })

  it('keeps off for every model measured as accepting it', () => {
    // The guard against an over-broad table: these all declare the same
    // capability as the refusing nine, and only the table separates them.
    for (const id of ACCEPTING_PER_ISSUE_34) {
      expect(offDefaultFor(declaring(id)), id).toBe(true)
    }
  })

  it('keeps off for an unlisted model that declares it can be disabled', () => {
    // A brand-new model must not inherit its family's answer in either
    // direction; the declaration decides until the table is updated.
    expect(offDefaultFor(declaring('grok-4.7'))).toBe(true)
  })

  it('never offers off without an explicit declaration', () => {
    expect(offDefaultFor({ id: 'glm-5.3', reasoning: { supportedEfforts: ['high'] } })).toBe(false)
    expect(offDefaultFor({ id: 'glm-5.3', reasoning: { canDisableThinking: false } })).toBe(false)
    expect(offDefaultFor({ id: 'glm-5.3' })).toBe(false)
  })

  it('matches on the EXACT id, never a family prefix', () => {
    // `deepseek-v4-pro` is tabled (and refuses); an unknown sibling must fall
    // back to its own declaration rather than inheriting the correction.
    expect(offDefaultFor(declaring('deepseek-v4-pro'))).toBe(false)
    expect(offDefaultFor(declaring('deepseek-v4-pro-preview'))).toBe(true)
    expect(offDefaultFor(declaring('gpt-5.6-sol'))).toBe(false)
    expect(offDefaultFor(declaring('gpt-5.6-sol-x'))).toBe(true)
  })
})

describe('effectiveOff', () => {
  it('falls back to the built-in rule when the user has no opinion', () => {
    // An ABSENT key is the whole reason this is a map: it must keep the level
    // for the models that accept it, which a saved empty list could not.
    expect(effectiveOff(declaring('glm-5.3'), {})).toBe(true)
    expect(effectiveOff(declaring('deepseek-v4.1-flash'), {})).toBe(false)
  })

  it('lets the user withdraw off from a model the upstream lies about', () => {
    // The case that needs no plugin release: a refusing model missing from the
    // table (or a future one) is corrected from the card.
    expect(effectiveOff(declaring('gpt-7-unlisted'), { 'gpt-7-unlisted': false })).toBe(false)
  })

  it('lets the user offer off for a model the table withdraws', () => {
    // The other direction: the table errs towards hiding, so a wrong entry must
    // be correctable by the person who hit it.
    expect(effectiveOff(declaring('deepseek-v4.1-flash'), { 'deepseek-v4.1-flash': true })).toBe(true)
    expect(effectiveOff(declaring('gemini-3.5-flash'), { 'gemini-3.5-flash': true })).toBe(true)
  })

  it('honours an explicit answer over the declaration too', () => {
    // `false` is an answer, not "no opinion": a model that declares the
    // capability but misbehaves can be silenced without adding it to the table.
    expect(effectiveOff(declaring('glm-5.3'), { 'glm-5.3': false })).toBe(false)
  })

  it('ignores an answer recorded for a different model', () => {
    expect(effectiveOff(declaring('glm-5.3'), { 'kimi-k3': false })).toBe(true)
  })
})

describe('withEffectiveOff', () => {
  it('rewrites the declaration to the effective answer', () => {
    // The runtime descriptor is consumed by `workBuddyThinkingLevelMap`, which
    // reads ONLY this field — so the correction has to land here.
    const [refused, accepted] = withEffectiveOff([
      declaring('deepseek-v4.1-flash'),
      declaring('glm-5.3'),
    ], {})
    expect(refused?.reasoning?.canDisableThinking).toBe(false)
    expect(accepted?.reasoning?.canDisableThinking).toBe(true)
  })

  it('preserves every other field on the model and on its reasoning', () => {
    // A stamp that dropped a field would silently break the model row: name,
    // window and the other effort levels all travel through this list.
    const [model] = withEffectiveOff([
      {
        id: 'deepseek-v4.1-flash',
        name: 'Deepseek-V4.1-Flash',
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        reasoning: { supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'high', canDisableThinking: true },
      },
    ], {})
    expect(model).toMatchObject({
      id: 'deepseek-v4.1-flash',
      name: 'Deepseek-V4.1-Flash',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    })
    expect(model?.reasoning).toEqual({
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      canDisableThinking: false,
    })
  })

  it('leaves a model with no reasoning untouched', () => {
    // No declaration means no level to correct — and inventing a `reasoning`
    // object here would fabricate a capability answer out of nothing.
    const input: Array<{
      id: string
      name: string
      contextWindow: number
      maxTokens: number
      reasoning?: { supportedEfforts: readonly string[], canDisableThinking: boolean }
    }> = [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200_000, maxTokens: 32_000 }]
    const output = withEffectiveOff(input, {})
    expect(output[0]).toBe(input[0])
    expect(output[0]?.reasoning).toBeUndefined()
  })

  it('applies the same override the rule reports, for every model', () => {
    const models = [...REFUSING_PER_ISSUE_34, ...ACCEPTING_PER_ISSUE_34].map(declaring)
    const overrides = { 'deepseek-v4-pro': true, 'glm-5.3': false }
    for (const model of withEffectiveOff(models, overrides)) {
      expect(model.reasoning?.canDisableThinking, model.id)
        .toBe(effectiveOff(model, overrides))
    }
  })
})
