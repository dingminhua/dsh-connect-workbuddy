/**
 * Issue #253, SECOND report: the reporter installed 5.24.2 and still got 11129,
 * then supplied three more draft-4 spellings and a patch. Two findings here, and
 * the second one is a bug in this plugin's OWN 5.24.2 change.
 *
 * FINDING 1 — the reporter's three shapes were never refused. Measured raw
 * (bypassing `prepareChatBody` entirely) on `deepseek-v4.1-flash`:
 *
 *   type: ["string","null"]   200
 *   dependencies (array)      200
 *   dependencies (object)     200
 *   additionalItems           200   (alongside an object `items`, or without one)
 *
 * So migrating them fixes nothing, and their patch would have been a no-op. The
 * value in their report was the METHOD: they proved the traversal had blind
 * spots, and looking for what the blind spots were pointed at the real class.
 *
 * FINDING 2 — what IS refused is a class of TYPE errors in the definition
 * itself, 36 of them measured one keyword at a time. `title: 1`,
 * `minimum: "0"`, `examples: "x"`, `pattern: 123`, `allOf: {}`,
 * `additionalProperties: "x"`, `uniqueItems: "true"`, `type: "thing"`, and so on
 * — each answers 11129 as sent, and 200 once the value has the keyword's type.
 *
 * FINDING 3 — our own regression. 5.24.2 rewrote draft-4's empty tuple
 * `items: []` into `prefixItems: []`, and the upstream refuses an empty
 * `prefixItems`. The "fix" turned one 11129 into another 11129. That is pinned
 * below as a regression test, because it is the only part of this round that was
 * a real defect in shipped code.
 */

import { describe, expect, it } from 'vitest'
import { prepareChatBody, toolSchemaRejectAdvice } from '../src/upstream.ts'

/** Run one tool schema through the rewrite and return what would be sent. */
function normalized(parameters: unknown): Record<string, unknown> {
  const body = JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 't', description: 'd', parameters } }],
  })
  return JSON.parse(prepareChatBody(body, {})).tools[0].function.parameters
}

/** A property schema under a normal object root, which is the common shape. */
function property(schema: Record<string, unknown>): Record<string, unknown> {
  return (normalized({ type: 'object', properties: { a: schema } }) as {
    properties: { a: Record<string, unknown> }
  }).properties.a
}

describe('issue #253 second report — the reporter\'s three shapes must keep working', () => {
  it('leaves a `type` union alone, because the upstream accepts it', () => {
    // Rewriting this into `oneOf` would be a large change to a schema the
    // upstream already understands.
    expect(property({ type: ['string', 'null'] })).toEqual({ type: ['string', 'null'] })
    expect(property({ type: ['string', 'number'] })).toEqual({ type: ['string', 'number'] })
  })

  it('leaves `dependencies` alone, and still traverses into it', () => {
    expect(property({ dependencies: { a: ['b'] } })).toEqual({ dependencies: { a: ['b'] } })
    // The object form is descended into: a draft-4 leftover NESTED inside it is
    // still rewritten. Without the traversal entry this would pass through with
    // its boolean exclusive bound intact.
    const nested = property({
      dependencies: { a: { type: 'object', properties: { n: { type: 'number', minimum: 0, exclusiveMinimum: true } } } },
    })
    const inner = (nested['dependencies'] as Record<string, { properties: { n: Record<string, unknown> } }>)['a']
    expect(inner?.properties.n).toEqual({ type: 'number', exclusiveMinimum: 0 })
  })

  it('keeps `additionalItems` where the upstream accepts it', () => {
    // Alongside an object `items` it is meaningless in 2020-12 but ACCEPTED, so
    // it is left alone rather than deleted: untouched bytes keep the prompt
    // prefix stable for caching.
    expect(property({ type: 'array', items: { type: 'string' }, additionalItems: { type: 'number' } }))
      .toEqual({ type: 'array', items: { type: 'string' }, additionalItems: { type: 'number' } })
    expect(property({ type: 'array', additionalItems: { type: 'number' } }))
      .toEqual({ type: 'array', additionalItems: { type: 'number' } })
  })

  it('does carry `additionalItems` across when it IS the tuple tail', () => {
    // This is the one place `additionalItems` has meaning: draft-4 said "the
    // schema for positions past the tuple". 2020-12 spells that as `items`.
    expect(property({ type: 'array', items: [{ type: 'string' }], additionalItems: { type: 'number' } }))
      .toEqual({ type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'number' } })
  })
})

describe('issue #253 — REGRESSION: an empty tuple must not become an empty prefixItems', () => {
  it('rewrites `items: []` to `items: {}`, never to `prefixItems: []`', () => {
    // 5.24.2 sent `prefixItems: []`, which the upstream refuses exactly like the
    // `items: []` it replaced — the fix changed nothing for this input. Draft-4
    // read `items: []` as "any array", which is `items: {}`.
    const out = property({ type: 'array', items: [] })
    expect(out).toEqual({ type: 'array', items: {} })
    expect(out['prefixItems']).toBeUndefined()
  })

  it('preserves a typed empty-tuple tail without emitting prefixItems', () => {
    // Every position follows the empty tuple, so the tail schema applies to
    // every item. Keeping it also makes this independent of the later repair.
    const tail = { type: 'object', properties: { value: { type: 'string' } }, required: 'value' }
    const out = property({ type: 'array', items: [], additionalItems: tail })
    expect(out).toEqual({ type: 'array', items: { ...tail, required: ['value'] } })
    expect(out['additionalItems']).toBeUndefined()
    expect(out['prefixItems']).toBeUndefined()
  })

  it.each([false, true])('preserves the explicit empty-tuple boolean tail %s', tail => {
    expect(property({ type: 'array', items: [], additionalItems: tail }))
      .toEqual({ type: 'array', items: tail })
  })

  it('drops an empty `prefixItems` rather than sending it', () => {
    // Measured refused as sent, in every combination.
    expect(property({ type: 'array', prefixItems: [], items: {} })).toEqual({ type: 'array', items: {} })
  })
})

describe('issue #253 — keyword VALUES with the wrong type are repaired', () => {
  it('drops a string keyword given a non-string', () => {
    expect(property({ type: 'string', title: 1 })).toEqual({ type: 'string' })
    expect(property({ type: 'string', description: 5 })).toEqual({ type: 'string' })
    expect(property({ type: 'string', pattern: 123 })).toEqual({ type: 'string' })
    expect(property({ type: 'string', format: 7 })).toEqual({ type: 'string' })
  })

  it('drops a number keyword given a non-number', () => {
    expect(property({ type: 'number', minimum: '0' })).toEqual({ type: 'number' })
    expect(property({ type: 'string', maxLength: '5' })).toEqual({ type: 'string' })
    expect(property({ type: 'number', multipleOf: '2' })).toEqual({ type: 'number' })
    // A non-finite number is as unusable as a string.
    expect(property({ type: 'number', minimum: Number.NaN })).toEqual({ type: 'number' })
  })

  it('drops a boolean keyword given a non-boolean', () => {
    expect(property({ type: 'array', uniqueItems: 'true' })).toEqual({ type: 'array' })
    expect(property({ type: 'string', readOnly: 'yes' })).toEqual({ type: 'string' })
  })

  it('drops a schema list given a non-array or an EMPTY array', () => {
    // Empty is measured refused, and an absent keyword means the same thing.
    expect(property({ allOf: {} })).toEqual({})
    expect(property({ allOf: [] })).toEqual({})
    expect(property({ anyOf: [] })).toEqual({})
    expect(property({ oneOf: [] })).toEqual({})
    expect(property({ type: 'string', examples: 'str' })).toEqual({ type: 'string' })
  })

  it('drops a schema-valued keyword given a non-schema', () => {
    // `true` / `false` ARE legal schemas and measured accepted, so they stay.
    for (const key of ['not', 'contains', 'if', 'then', 'else', 'propertyNames', 'additionalProperties', 'items']) {
      expect(property({ [key]: 'x' })).toEqual({})
    }
    expect(property({ properties: { a: true, b: false } })).toEqual({ properties: { a: true, b: false } })
  })

  it('repairs `type` by keeping its valid members', () => {
    expect(property({ type: 'thing' })).toEqual({})
    expect(property({ type: [] })).toEqual({})
    expect(property({ type: ['string', 'thing'] })).toEqual({ type: 'string' })
    expect(property({ type: ['string', 'null', 'thing'] })).toEqual({ type: ['string', 'null'] })
  })
})

describe('issue #253 — repair must not damage what the upstream already accepts', () => {
  it('leaves a fully valid schema byte-identical', () => {
    const valid = {
      type: 'object',
      properties: {
        pageId: { type: 'string', minLength: 1 },
        instruction: { type: 'string' },
        schema: {
          type: 'object',
          propertyNames: { type: 'string' },
          additionalProperties: { $ref: '#/$defs/__schema0' },
        },
      },
      required: ['instruction'],
      additionalProperties: false,
      $defs: {
        __schema0: {
          anyOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'null' },
            { type: 'array', items: { $ref: '#/$defs/__schema0' } },
          ],
        },
      },
    }
    expect(normalized(valid)).toEqual(valid)
  })

  it('leaves ordinary metadata and constraints untouched', () => {
    const valid = {
      type: 'object',
      properties: {
        a: { type: 'string', title: 'T', description: 'D', examples: ['x'], enum: ['y'] },
        b: { type: 'number', minimum: 0, maximum: 10, multipleOf: 2 },
      },
      required: [],
    }
    expect(normalized(valid)).toEqual(valid)
  })

  it('still migrates the FIRST round of draft-4 spellings', () => {
    // The 5.24.2 work must not regress while fixing the new class.
    expect(property({ type: 'number', minimum: 0, exclusiveMinimum: true }))
      .toEqual({ type: 'number', exclusiveMinimum: 0 })
    expect(property({ type: 'array', items: [{ type: 'string' }] }))
      .toEqual({ type: 'array', prefixItems: [{ type: 'string' }], items: {} })
    expect(normalized({ type: 'object', properties: { b: { type: 'string' } }, required: 'b' }) as { required: unknown })
      .toMatchObject({ required: ['b'] })
    expect(property({ $ref: 'https://example.com/s.json' })).toEqual({})
  })
})

/**
 * The ADVICE has to name the rewrites that actually exist.
 *
 * Measured defect: for a while after `normalizeMetaSchemaTypes` landed, the
 * `11129` advice still listed only the four draft-4 shapes. A reader who hit a
 * surviving refusal was told the plugin had tried four things when it had tried
 * the whole class — which is the same "confident and unhelpful" reply this
 * function was written to replace. Nothing caught it, because no test asserted
 * on the string at all.
 *
 * These pin the PROPERTY (every rewrite family the module performs is named)
 * rather than the exact wording, so the sentence can be reworded without
 * breaking them while a forgotten family still fails.
 */
describe('issue #253 — the refusal advice must describe what the rewrite really does', () => {
  it('names the type repair, not only the draft-4 migrations', () => {
    const advice = toolSchemaRejectAdvice()
    // The draft-4 shapes (first round).
    expect(advice).toContain('元组式')
    expect(advice).toContain('exclusiveMinimum')
    expect(advice).toContain('$ref')
    // The type repair (second round) — absent before this test existed.
    expect(advice).toContain('值类型')
    expect(advice).toContain('allOf')
    expect(advice).toContain('type: []')
  })

  it('does not claim an account, credit or network problem', () => {
    // The whole reason this function exists: those are the three things the
    // upstream's own tips send the reader to, and none of them can help.
    const advice = toolSchemaRejectAdvice()
    expect(advice).toContain('与账号')
    expect(advice).toContain('都无关')
  })

  it('is honest that a surviving refusal means an UNKNOWN shape', () => {
    // It must not promise the rewrite is exhaustive.
    expect(toolSchemaRejectAdvice()).toContain('仍被拒说明还有别的写法')
  })
})
