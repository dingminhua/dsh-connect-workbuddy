/**
 * Issue #274: enabling the REA MCP server made `deepseek-v4.1-flash` answer
 * EVERY message with HTTP 400 / code 11129; disabling it made the same message
 * pass. The reporter pasted all 260 tool schemas. Fed through `prepareChatBody`,
 * all 260 came out BYTE-IDENTICAL — every rewrite from #253 was already clean —
 * so the cause was a shape nobody had looked for.
 *
 * MEASURED, one body at a time on the real CN gateway, `deepseek-v4.1-flash`:
 *
 *   - the two tools carrying `\uD800`-`\uDFFF` in a `pattern` (`close_binary`,
 *     `binary_session`) answer 11129 alone; the other three answer 200;
 *   - removing ONLY that `allOf` member makes the tool pass; removing the NUL
 *     and slash members instead does not. It is the escape, not `allOf`;
 *   - the boundary is exact: `\uD7FF` and `\uE000` answer 200, every escape in
 *     D800–DFFF answers 11129 (upper/lower/mixed hex digits alike);
 *   - the rejection is SPECIFIC TO `pattern`: the same literal in `description`,
 *     `title`, `const`, `enum`, `default`, `format` all answer 200;
 *   - other escapes pass: `\u0000`–`\uFFFF`, `\x00`, `\d`, an ASCII hex range,
 *     even a literal emoji (a real surrogate pair in the JSON). Only the
 *     `\uXXXX` SPELLING of a surrogate code unit is refused.
 *
 * These tests pin the REQUEST BYTES, as the #253 suite does: a rewrite that
 * never reaches the wire proves nothing. The negative cases are pinned just as
 * hard — an over-eager rewrite would silently strip legitimate constraints
 * from third-party tools that work today.
 *
 * The fix drops the offending `pattern` (an annotation; REA still validates
 * canonical inputs server-side), never the tool, and rewrites no escape into a
 * guessed equivalent. Measured: with the fix, both the 5-tool reduced catalog
 * and the full 255-tool catalog answer 200.
 */

import { describe, expect, it } from 'vitest'
import { prepareChatBody, toolSchemaRejectAdvice } from '../src/upstream.ts'

/** Prepare a body and return the parsed `parameters` of its single tool. */
function parametersOf(parameters: unknown): Record<string, unknown> {
  const prepared = JSON.parse(prepareChatBody(JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'tool', description: 'd', parameters } }],
  }))) as { tools: { function: { parameters: Record<string, unknown> } }[] }
  return prepared.tools[0]!.function.parameters
}

/** A property schema under a normal object root, returned after normalization. */
function property(schema: Record<string, unknown>): Record<string, unknown> {
  const out = parametersOf({ type: 'object', properties: { a: schema }, additionalProperties: false })
  return (out['properties'] as Record<string, Record<string, unknown>>)['a']!
}

const SURROGATE_PATTERN = '^[^\\uD800-\\uDFFF]*$'

describe('issue #274 — surrogate escapes in `pattern` are dropped', () => {
  it('drops a pattern carrying a surrogate escape', () => {
    // The exact shape from `close_binary.snapshot_path`: a lone pattern.
    expect(property({ type: 'string', pattern: SURROGATE_PATTERN })).toEqual({ type: 'string' })
  })

  it('drops the offending allOf member, leaving the other members intact', () => {
    // REA's real structure: three allOf members, only the middle one is bad.
    const out = property({
      type: 'string',
      minLength: 1,
      allOf: [
        { pattern: '^[^\\x00]*$' },
        { pattern: SURROGATE_PATTERN },
        { pattern: '^\\/' },
      ],
    })
    expect(out['minLength']).toBe(1)
    expect(out['allOf']).toEqual([{ pattern: '^[^\\x00]*$' }, {}, { pattern: '^\\/' }])
  })

  it('is case-insensitive on the hex digits', () => {
    // Measured: lowercase and mixed-case spellings are refused just like upper.
    expect(property({ type: 'string', pattern: '^[^\\ud800-\\udfff]*$' })).toEqual({ type: 'string' })
    expect(property({ type: 'string', pattern: '^[^\\uDaFf]*$' })).toEqual({ type: 'string' })
  })

  it('drops a surrogate escape outside a character class too', () => {
    // `binary_session` used a class, but a bare escape is refused as well.
    expect(property({ type: 'string', pattern: '\\uD800-\\uDFFF' })).toEqual({ type: 'string' })
  })

  it('works when the pattern sits at the top level of a tool schema', () => {
    // Not only under `properties`: the walk is recursive over every schema node.
    const out = parametersOf({ type: 'object', properties: { a: { type: 'string' } }, pattern: SURROGATE_PATTERN })
    expect(out['pattern']).toBeUndefined()
  })
})

describe('issue #274 — patterns the upstream ACCEPTS are left byte-identical', () => {
  it('keeps escapes just outside the surrogate range', () => {
    // Measured: D7FF and E000 answer 200; the rewrite must not touch them.
    expect(property({ type: 'string', pattern: '^[^\\uD7FF]*$' })['pattern']).toBe('^[^\\uD7FF]*$')
    expect(property({ type: 'string', pattern: '^[^\\uE000]*$' })['pattern']).toBe('^[^\\uE000]*$')
  })

  it('keeps ordinary escapes and the full BMP range', () => {
    expect(property({ type: 'string', pattern: '^[^\\u0000-\\uFFFF]*$' })['pattern']).toBe('^[^\\u0000-\\uFFFF]*$')
    expect(property({ type: 'string', pattern: '^[\\u0041-\\u005A]+$' })['pattern']).toBe('^[\\u0041-\\u005A]+$')
    expect(property({ type: 'string', pattern: '^[^\\x00]*$' })['pattern']).toBe('^[^\\x00]*$')
    expect(property({ type: 'string', pattern: '^\\d+$' })['pattern']).toBe('^\\d+$')
  })

  it('keeps a literal emoji and ordinary patterns', () => {
    // A real surrogate pair in the JSON (not the `\uXXXX` spelling) passes.
    expect(property({ type: 'string', pattern: '^[^😀]*$' })['pattern']).toBe('^[^😀]*$')
    expect(property({ type: 'string', pattern: '^[a-z]+$' })['pattern']).toBe('^[a-z]+$')
  })

  it('does not touch surrogate escapes in OTHER string keywords', () => {
    // Measured: only `pattern` is refused. A surrogate escape in any of these
    // answers 200, so stripping it would corrupt documentation/values for free.
    const out = property({
      type: 'string',
      description: 'x\\uD800-\\uDFFFy',
      title: 'x\\uD800-\\uDFFFy',
      const: '\\uD800-\\uDFFF',
      enum: ['\\uD800-\\uDFFF'],
      default: '\\uD800-\\uDFFF',
      format: 'x\\uD800-\\uDFFFy',
    })
    expect(out['description']).toBe('x\\uD800-\\uDFFFy')
    expect(out['title']).toBe('x\\uD800-\\uDFFFy')
    expect(out['const']).toBe('\\uD800-\\uDFFF')
    expect(out['enum']).toEqual(['\\uD800-\\uDFFF'])
    expect(out['default']).toBe('\\uD800-\\uDFFF')
    expect(out['format']).toBe('x\\uD800-\\uDFFFy')
  })
})

describe('issue #274 — the refusal advice names the new rewrite', () => {
  it('mentions the surrogate pattern rewrite', () => {
    const advice = toolSchemaRejectAdvice()
    expect(advice).toContain('pattern')
    expect(advice).toContain('D800')
  })
})
