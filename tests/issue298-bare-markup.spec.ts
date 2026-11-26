/**
 * ISSUE #298 — a tool call written with NO marker at all.
 *
 * Captured in the wild: `delta.content` carried the whole call with not one
 * marker in it, so every tag read as prose and the user was handed the raw
 * protocol as the answer.
 *
 * THE DESIGN CONSTRAINT THESE TESTS EXIST FOR: the trigger is the protocol's
 * OWN vocabulary (`tool_call` / `arg_key` / `arg_value` / `parameter`), never a
 * tool or parameter name alone. A name-based rule was reproduced deleting real
 * sentences —
 *
 *     You can write <bash>ls -la</bash> to list files.
 *     Set <command> now and later.
 *
 * — so the two `false positive` cases below are the ones that must stay prose
 * for ever. They are not decoration: they are the reason the feature is safe.
 *
 * @module dsh-connect-workbuddy/tests/issue298-bare-markup
 */
import { describe, expect, it } from 'vitest'
import { DsmlStreamBuffer, parseToolCalls } from '../src/dsml-recovery.ts'
import type { RecoveryGate } from '../src/dsml-recovery.ts'

/** The tool the captured leak called, with its real schema shape. */
function gate(overrides: Partial<RecoveryGate> = {}): RecoveryGate {
  return {
    declaredNames: new Set(['ask_user_question']),
    acceptedParameters: new Map<string, ReadonlySet<string>>([['ask_user_question', new Set(['questions'])]]),
    requiredParameters: new Map<string, readonly string[]>([['ask_user_question', ['questions']]]),
    bareMarkup: true,
    ...overrides,
  }
}

/** The shape captured in the wild, verbatim apart from the payload. */
const LEAK = '好的，我列两个选项：\n<ask_user_question>\n<questions</arg_key><arg_value>[{"header":"Pick"}]</arg_value></tool_call>'

describe('issue #298: bare markup is OFF unless the request opts in', () => {
  it('leaves the leak untouched when bareMarkup is absent — byte-identical old behaviour', () => {
    const g = gate()
    delete (g as { bareMarkup?: boolean }).bareMarkup
    expect(parseToolCalls(LEAK, g)).toEqual([])
    expect(new DsmlStreamBuffer(g).add(LEAK).text).toBe(LEAK)
  })
})

describe('issue #298: the captured leak is recovered', () => {
  it('recovers the call from already-complete text, keeping the prose', () => {
    const calls = parseToolCalls(LEAK, gate())
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('ask_user_question')
    expect(JSON.parse(calls[0]?.arguments ?? '{}')).toEqual({ questions: '[{"header":"Pick"}]' })
  })

  it('recovers it through the stream and never prints the protocol bytes', () => {
    const buffer = new DsmlStreamBuffer(gate())
    const first = buffer.add(LEAK)
    expect(first.text, 'the prose before the block survives').toContain('好的，我列两个选项')
    expect(first.text, 'no protocol bytes leak').not.toContain('<ask_user_question')
    expect(first.text).not.toContain('arg_value')
    const end = buffer.flush()
    expect(end.calls).toHaveLength(1)
    expect(`${first.text}${end.text}`).not.toContain('arg_key')
  })

  it('recovers it when the leak arrives in one stream chunk (the captured case)', () => {
    // THE CAPTURED CASE, and the boundary this feature can honestly promise.
    //
    // A bare block has no marker, so the stream can only recognise it from the
    // protocol words INSIDE it. That means the wrapper is already on screen
    // before the proof arrives, and no rule short of "hold every `<`-led name"
    // closes the gap — that rule was tried and it deleted real sentences such
    // as `You can write <bash>ls -la</bash>`.
    //
    // The trade is deliberate: a visible partial wrapper is debris the user can
    // see; a deleted sentence is content the user loses. The leak that opened
    // this issue arrived as one `delta.content`, which is what this pins.
    const buffer = new DsmlStreamBuffer(gate())
    let text = ''
    let calls = 0
    for (const chunk of [LEAK]) {
      const outcome = buffer.add(chunk)
      text += outcome.text
      calls += outcome.calls?.length ?? 0
    }
    const end = buffer.flush()
    text += end.text
    calls += end.calls?.length ?? 0
    expect(calls, 'exactly one call').toBe(1)
    expect(text, 'no parameter tags reach the reader').not.toContain('arg_key')
    expect(text).not.toContain('arg_value')
  })
})

describe('issue #298: the two shapes a name-based rule deletes stay prose', () => {
  it('does not recover a sentence that brackets a tool name', () => {
    // Reproduced against a name-based rule. `bash` is a declared tool and
    // `ls -la` is a plausible argument, so only the protocol-vocabulary gate
    // stands between this sentence and a call the user never asked for.
    const text = 'You can write <bash>ls -la</bash> to list files.'
    const g = gate({ declaredNames: new Set(['bash']), acceptedParameters: new Map<string, ReadonlySet<string>>([['bash', new Set<string>()]]) })
    expect(parseToolCalls(text, g)).toEqual([])
    expect(new DsmlStreamBuffer(g).add(text).text).toBe(text)
  })

  it('does not delete a parameter name used in prose', () => {
    const text = 'Set <command> now and later.'
    const g = gate({ acceptedParameters: new Map<string, ReadonlySet<string>>([['ask_user_question', new Set(['command'])]]) })
    expect(parseToolCalls(text, g)).toEqual([])
    expect(new DsmlStreamBuffer(g).add(text).text).toBe(text)
  })

  it('does not treat ordinary HTML as a block', () => {
    const text = '<div>hello</div> and <b>bold</b>'
    expect(parseToolCalls(text, gate())).toEqual([])
    expect(new DsmlStreamBuffer(gate()).add(text).text).toBe(text)
  })
})

describe('issue #298: the gates still refuse', () => {
  it('refuses a tool the request never declared', () => {
    const text = '<some_other_tool><arg_key>questions</arg_key><arg_value>x</arg_value></tool_call>'
    expect(parseToolCalls(text, gate())).toEqual([])
  })

  it('refuses when the required parameter is missing', () => {
    expect(parseToolCalls('<ask_user_question>\n</tool_call>', gate())).toEqual([])
  })

  it('does not accept a truncated key the schema does not list', () => {
    const text = '<ask_user_question>\n<other</arg_key><arg_value>x</arg_value></tool_call>'
    expect(parseToolCalls(text, gate())).toEqual([])
  })

  it('respects a pinned tool_choice', () => {
    const text = '<ask_user_question><arg_key>questions</arg_key><arg_value>x</arg_value></tool_call>'
    expect(parseToolCalls(text, gate({ pinnedToolName: 'some_other_tool' }))).toEqual([])
  })
})

describe('issue #298: the marked path does not regress', () => {
  it('still recovers a marker-bearing block with bareMarkup on', () => {
    const M = '\uff5c\uff5cDSML\uff5c\uff5c'
    const marked = [
      `<${M} invoke name="ask_user_question">`,
      `<${M} parameter name="questions">x</${M} parameter>`,
      `</${M} invoke>`,
    ].join('\n')
    const calls = parseToolCalls(marked, gate())
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('ask_user_question')
  })
})
