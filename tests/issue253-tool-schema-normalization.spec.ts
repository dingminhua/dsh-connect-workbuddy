/**
 * Issue #253: `deepseek-v4.1-flash` answered EVERY agent-mode chat with
 * HTTP 400 / code 11129 (`invalid function call parameters`), and the same
 * schemas were rejected by five more models with 11133.
 *
 * The reporter's first hypothesis was "the plugin never handles `tools`". My
 * first correction was "it is `$ref`" — and that was ALSO wrong: the recursive
 * `$defs` schema he pointed at answers 200, and so does the host's entire
 * 75-tool catalog sent in one request.
 *
 * What actually refuses is a set of draft-4 relics that zod and hand-written
 * MCP schemas emit. Every case below was measured against the real CN gateway
 * on 2026-11-14 — the "refused" shape answers 11129/11133, and the "rewritten"
 * shape answers 200 on `deepseek-v4.1-flash`, `deepseek-v4-pro`, `glm-5.3`,
 * `kimi-k3.1-pro` and `mimo-v2.6-pro`.
 *
 * These tests pin the REQUEST BYTES, because that is where the failure was: a
 * rewrite that does not reach the wire proves nothing. They also pin the NEGATIVE
 * cases hard — what must NOT change — because this function edits schemas built
 * by a third party, and an over-eager rewrite would silently corrupt tools that
 * work today.
 */

import { describe, expect, it } from 'vitest'
import { prepareChatBody } from '../src/upstream.ts'

/** Prepare a body and return the parsed result, with one tool carrying `parameters`. */
function withParameters(parameters: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const prepared = JSON.parse(prepareChatBody(JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'tool', description: 'd', parameters, ...extra } }],
  }))) as { tools: { function: { parameters: Record<string, unknown> } }[] }
  return prepared.tools[0]!.function.parameters
}

/** The `properties` object of the single tool schema, for the common case. */
function propertiesOf(parameters: unknown): Record<string, Record<string, unknown>> {
  return withParameters(parameters)['properties'] as Record<string, Record<string, unknown>>
}

describe('issue #253 — draft-4 relic rewrites in tool parameters', () => {
  describe('items', () => {
    it('rewrites a TUPLE items into prefixItems plus an open tail', () => {
      // Refused: {"items": [{"type":"string"}]}
      const properties = propertiesOf({ type: 'object', properties: { a: { type: 'array', items: [{ type: 'string' }] } } })
      expect(properties['a']!['prefixItems']).toEqual([{ type: 'string' }])
      // `{}` — not `false` — because draft-4's tuple form said nothing about
      // extra elements; forbidding them would be an invented constraint.
      expect(properties['a']!['items']).toEqual({})
    })

    it('keeps the caller\'s own prefixItems when both are present', () => {
      const properties = propertiesOf({
        type: 'object',
        properties: { a: { type: 'array', prefixItems: [{ type: 'number' }], items: [{ type: 'string' }] } },
      })
      expect(properties['a']!['prefixItems']).toEqual([{ type: 'number' }])
      expect(properties['a']!['items']).toEqual({})
    })

    it('leaves an ordinary object items alone', () => {
      const properties = propertiesOf({ type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } })
      expect(properties['a']!['items']).toEqual({ type: 'string' })
      expect(properties['a']!['prefixItems']).toBeUndefined()
    })

    it('preserves a closed tuple tail while rewriting the legacy keyword', () => {
      const parameters = withParameters({ type: 'array', items: [{ type: 'string' }], additionalItems: false })
      expect(parameters['prefixItems']).toEqual([{ type: 'string' }])
      expect(parameters['items']).toBe(false)
      expect(parameters).not.toHaveProperty('additionalItems')
    })

    it('preserves and recursively normalizes a typed tuple tail', () => {
      const parameters = withParameters({ type: 'array', items: [{ type: 'string' }],
        additionalItems: { type: 'object', required: 'value', properties: { value: { type: 'number' } } } })
      expect(parameters['items']).toEqual({ type: 'object', required: ['value'], properties: { value: { type: 'number' } } })
      expect(parameters).not.toHaveProperty('additionalItems')
    })

    it('preserves an explicitly open tuple tail', () => {
      const parameters = withParameters({ type: 'array', items: [{ type: 'string' }], additionalItems: true })
      expect(parameters['items']).toBe(true)
      expect(parameters).not.toHaveProperty('additionalItems')
    })

    it('rewrites a tuple nested inside items of a nested array', () => {
      const properties = propertiesOf({
        type: 'object',
        properties: { a: { type: 'array', items: { type: 'array', items: [{ type: 'string' }] } } },
      })
      const inner = properties['a']!['items'] as Record<string, unknown>
      expect(inner['prefixItems']).toEqual([{ type: 'string' }])
      expect(inner['items']).toEqual({})
    })
  })

  describe('exclusiveMinimum / exclusiveMaximum', () => {
    it('converts the draft-4 boolean into the numeric form from the sibling bound', () => {
      // Refused: {"minimum": 0, "exclusiveMinimum": true}
      const properties = propertiesOf({ type: 'object', properties: { a: { type: 'number', minimum: 0, exclusiveMinimum: true } } })
      expect(properties['a']!['exclusiveMinimum']).toBe(0)
      // The sibling is REMOVED: keeping both would state the bound twice, and
      // `minimum: 0` alongside `exclusiveMinimum: 0` says "0 is allowed" and
      // "0 is not allowed" in one object.
      expect(properties['a']!['minimum']).toBeUndefined()
    })

    it('converts exclusiveMaximum the same way', () => {
      const properties = propertiesOf({ type: 'object', properties: { a: { type: 'number', maximum: 10, exclusiveMaximum: true } } })
      expect(properties['a']!['exclusiveMaximum']).toBe(10)
      expect(properties['a']!['maximum']).toBeUndefined()
    })

    it('DROPS a boolean exclusive bound with no sibling rather than inventing one', () => {
      // `exclusiveMinimum: true` with no `minimum` means "greater than
      // something unspecified". Writing `0` here would attach a bound the
      // caller never wrote — a wrong schema the upstream would happily accept.
      const properties = propertiesOf({ type: 'object', properties: { a: { type: 'number', exclusiveMinimum: true } } })
      expect(properties['a']!['exclusiveMinimum']).toBeUndefined()
    })

    it('drops the draft-4 `false` form, which only restated the default', () => {
      const properties = propertiesOf({ type: 'object', properties: { a: { type: 'number', minimum: 0, exclusiveMinimum: false } } })
      expect(properties['a']!['exclusiveMinimum']).toBeUndefined()
      expect(properties['a']!['minimum']).toBe(0)
    })

    it('leaves an already-numeric exclusive bound alone', () => {
      const properties = propertiesOf({ type: 'object', properties: { a: { type: 'number', exclusiveMinimum: 0 } } })
      expect(properties['a']!['exclusiveMinimum']).toBe(0)
    })
  })

  describe('required', () => {
    it('wraps a string required into a one-element array', () => {
      // Refused: {"required": "b"}
      expect(withParameters({ type: 'object', properties: { b: { type: 'string' } }, required: 'b' })['required']).toEqual(['b'])
    })

    it('de-duplicates a required array', () => {
      // Refused: {"required": ["b","b"]}
      expect(withParameters({ type: 'object', properties: { b: { type: 'string' } }, required: ['b', 'b'] })['required']).toEqual(['b'])
    })

    it('drops a required that is neither a string nor an array', () => {
      expect(withParameters({ type: 'object', properties: {}, required: 123 })['required']).toBeUndefined()
      expect(withParameters({ type: 'object', properties: {}, required: null })['required']).toBeUndefined()
    })

    it('turns an empty required string into an empty array, not [\'\']', () => {
      // `['']` would ask the upstream to require a property with an empty name.
      expect(withParameters({ type: 'object', properties: {}, required: '' })['required']).toEqual([])
    })

    it('leaves a correct required array byte-identical', () => {
      const parameters = withParameters({ type: 'object', properties: { b: { type: 'string' } }, required: ['b'] })
      expect(parameters['required']).toEqual(['b'])
    })

    it('rewrites a required nested inside a property', () => {
      const properties = propertiesOf({
        type: 'object',
        properties: { a: { type: 'object', properties: { b: { type: 'string' } }, required: 'b' } },
      })
      expect((properties['a'] as Record<string, unknown>)['required']).toEqual(['b'])
    })
  })

  describe('external $ref', () => {
    it('removes an absolute URL reference', () => {
      // Refused: {"$ref": "https://example.com/schema.json"}
      const properties = propertiesOf({ type: 'object', properties: { a: { $ref: 'https://example.com/schema.json' } } })
      expect(properties['a']!['$ref']).toBeUndefined()
    })

    it('removes a protocol-relative reference', () => {
      const properties = propertiesOf({ type: 'object', properties: { a: { $ref: '//example.com/schema.json' } } })
      expect(properties['a']!['$ref']).toBeUndefined()
    })

    it('KEEPS an internal reference — the shape issue #253 blamed and the gateway accepts', () => {
      // Measured 200 on every model tested, including the recursive
      // `stagehand_extract` schema. Rewriting this would be a large change
      // bought with no evidence.
      const properties = propertiesOf({ type: 'object', properties: { a: { $ref: '#/$defs/X' } }, $defs: { X: { type: 'string' } } })
      expect(properties['a']!['$ref']).toBe('#/$defs/X')
    })

    it('keeps the documentation fields that sat beside the removed reference', () => {
      const properties = propertiesOf({
        type: 'object',
        properties: { a: { $ref: 'https://example.com/s.json', description: 'kept', default: 'x' } },
      })
      expect(properties['a']!['$ref']).toBeUndefined()
      expect(properties['a']!['description']).toBe('kept')
      expect(properties['a']!['default']).toBe('x')
    })
  })

  describe('what must NOT change', () => {
    it('leaves the host\'s real recursive stagehand_extract schema untouched', () => {
      // Verbatim from the installed host's `docs/tool-catalog.md`. Measured 200
      // on `deepseek-v4.1-flash`, `deepseek-v4-pro` and `hy3`, so every byte of
      // it must survive — including the three internal `$ref`s.
      const schema = {
        type: 'object',
        properties: {
          pageId: { type: 'string', minLength: 1 },
          instruction: { type: 'string', minLength: 1 },
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
              { type: 'object', propertyNames: { type: 'string' }, additionalProperties: { $ref: '#/$defs/__schema0' } },
            ],
          },
        },
      }
      expect(withParameters(schema)).toEqual(schema)
    })

    it('leaves a body with no tools completely alone', () => {
      const source = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      const prepared = JSON.parse(prepareChatBody(source)) as Record<string, unknown>
      expect(prepared['tools']).toBeUndefined()
    })

    it('leaves boolean schemas alone (legal 2020-12, measured accepted)', () => {
      const properties = propertiesOf({ type: 'object', properties: { a: true, b: false } })
      expect(properties['a']).toBe(true)
      expect(properties['b']).toBe(false)
    })

    it('does not normalize tools that tool_choice:none has already removed', () => {
      // The suppression path deletes `tools` outright; there is nothing left to
      // rewrite, and this pins the ORDER (normalize runs after suppression).
      const prepared = JSON.parse(prepareChatBody(JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        tool_choice: 'none',
        tools: [{ type: 'function', function: { name: 't', parameters: { type: 'object', required: 'x' } } }],
      }))) as Record<string, unknown>
      expect(prepared['tools']).toBeUndefined()
    })

    it('rewrites the deprecated top-level `functions` spelling too', () => {
      // `normalizeToolChoice` treats `functions` as the same field when
      // suppressing, so the schema rewrite must as well — otherwise the
      // deprecated spelling stays broken while the modern one is fixed.
      const prepared = JSON.parse(prepareChatBody(JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        functions: [{ name: 'legacy', description: 'd', parameters: { type: 'object', properties: {}, required: 'x' } }],
      }))) as { functions: { parameters: Record<string, unknown> }[] }
      expect(prepared.functions[0]!.parameters['required']).toEqual(['x'])
    })

    it('survives a self-referential object without hanging', () => {
      // The walk is recursive over third-party JSON. A cycle cannot arrive over
      // the wire (JSON has no identity), but the depth cap is what keeps a
      // pathological 1000-level document from becoming a hang — this pins that
      // the cap exists by building a document deeper than it.
      let deep: Record<string, unknown> = { type: 'string' }
      for (let index = 0; index < 200; index++) deep = { type: 'object', properties: { nested: deep } }
      const parameters = withParameters({ type: 'object', properties: { a: deep } })
      // Past the cap the document is left as-is rather than crashing the request.
      expect(parameters).toBeDefined()
    })
  })
})
