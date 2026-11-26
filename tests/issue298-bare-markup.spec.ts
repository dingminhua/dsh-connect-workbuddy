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

/**
 * REVIEW FINDING — quoted protocol vocabulary must not license a deletion.
 *
 * The trigger used to be answered by a scanner that did NOT skip fences and code
 * spans, while the BLOCK LOCATOR did. A response whose only `<arg_key>` lived in
 * backticks therefore satisfied "this response speaks the protocol", and the
 * tool-named wrapper in the sentence beside it became the block start — so the
 * rest of the paragraph was cut:
 *
 *     in : You can write <ask_user_question><questions>hi</questions></ask_user_question> to ask.
 *          (The format uses `<arg_key>`.)
 *     out: "You can write "
 *
 * Deleting a model's own explanation is the one outcome this module refuses;
 * showing protocol debris is bad, silently losing content is worse. These stay
 * as permanent negatives, next to the `<bash>` / `<command>` pair that guards the
 * same principle from the other direction.
 */
describe('issue #298: quoted protocol words do not license a deletion', () => {
  /** Feed as one chunk and flush, so a hold cannot hide the outcome. */
  function whole(text: string): { text: string, calls: number } {
    const buffer = new DsmlStreamBuffer(gate())
    const added = buffer.add(text)
    const flushed = buffer.flush()
    return {
      text: added.text + flushed.text,
      calls: (added.calls?.length ?? 0) + (flushed.calls?.length ?? 0),
    }
  }

  it('keeps a sentence whose ONLY protocol word is inside backticks', () => {
    const input = 'You can write <ask_user_question><questions>hi</questions></ask_user_question> to ask.\n(The format uses `<arg_key>`.)'
    const result = whole(input)
    expect(result.text, 'the prose must survive intact').toBe(input)
    expect(result.calls).toBe(0)
  })

  it('keeps a sentence whose only protocol word is inside a fenced block', () => {
    const input = 'The wrapper looks like this:\n```text\n<arg_key>k</arg_key><arg_value>v</arg_value>\n```\nYou can write <ask_user_question> to ask.'
    const result = whole(input)
    expect(result.text, 'the prose must survive intact').toBe(input)
    expect(result.calls).toBe(0)
  })

  it('keeps a sentence whose only protocol word is in a quoted span', () => {
    const input = 'Use `<invoke>` as the wrapper. Then <ask_user_question> is how you ask.'
    const result = whole(input)
    expect(result.text).toBe(input)
    expect(result.calls).toBe(0)
  })

  it('still recovers when the protocol word is REAL, not quoted', () => {
    // The other side: fixing the false positive must not disable the feature.
    const input = '前言\n<ask_user_question><questions>hi</questions>\n<questions</arg_key><arg_value>v</arg_value></tool_call>'
    const result = whole(input)
    expect(result.calls, 'a real bare block must still be recovered').toBe(1)
    expect(result.text).toBe('前言\n')
  })
})

/**
 * REVIEW FINDING — a block that never closed must not become a call.
 *
 * Gate 1 ("a block must close before it is committed") was documented as covering
 * the bare path but was not implemented there: `parseBareBlock` found an opener,
 * parsed whatever `arg_key`/`arg_value` pairs existed, and returned a call. So a
 * stream that was CUT MID-BLOCK — token limit, dropped connection — committed a
 * call whose arguments were a half-written string, and the tool ran on them.
 *
 * Refusing means the bytes are SHOWN. That is the right trade here: a call the
 * model never finished is worse than protocol debris the user can read, because
 * the debris is diagnosable and the wrong execution is not.
 */
describe('issue #298: an unclosed bare block is shown, not committed', () => {
  function whole(text: string): { text: string, calls: readonly { name: string, arguments: string }[] } {
    const buffer = new DsmlStreamBuffer(gate())
    const added = buffer.add(text)
    const flushed = buffer.flush()
    return { text: added.text + flushed.text, calls: [...added.calls ?? [], ...flushed.calls ?? []] }
  }

  it('refuses a block with no closer at all', () => {
    const input = '<ask_user_question>\n<arg_key>questions</arg_key><arg_value>x</arg_value>'
    const result = whole(input)
    expect(result.calls).toHaveLength(0)
    expect(result.text, 'the bytes must be shown instead of executed').toBe(input)
  })

  it('refuses a block whose arg_value closed but whose wrapper did not', () => {
    const input = '<ask_user_question><arg_key>questions</arg_key><arg_value>[{"a":1}]</arg_value>'
    expect(whole(input).calls).toHaveLength(0)
  })

  it('accepts the protocol closer even when it does not match the wrapper name', () => {
    // Real responses alternate: `<ask_user_question>` … `</tool_call>`. Requiring a
    // name-matched closer would reject the captured shape itself.
    const input = '<ask_user_question><arg_key>questions</arg_key><arg_value>v</arg_value></tool_call>'
    expect(whole(input).calls).toHaveLength(1)
  })
})

/**
 * REVIEW FINDING — a parameter must come from ITS OWN block.
 *
 * `parseBareParameters` scanned to the end of the pending text instead of the
 * end of the block, so:
 *
 *     <t>…a=1…</tool_call>\nTo run it, use <b>2</b>.
 *     → {"a":"1","b":"2"}
 *
 * The prose after the block became a parameter of it. This is the worst kind of
 * defect in this file: nothing looks broken — no deletion, no debris — the tool
 * simply receives arguments the model never wrote. For `bash` that is a command
 * nobody asked for.
 */
describe('issue #298: parameters are scoped to their own block', () => {
  function two(name: string, extra: Partial<RecoveryGate> = {}): RecoveryGate {
    return gate({
      declaredNames: new Set([name]),
      acceptedParameters: new Map([[name, new Set(['a', 'b'])]]),
      requiredParameters: new Map([[name, []]]),
      ...extra,
    })
  }

  it('does not absorb prose after the block as a parameter', () => {
    const input = '<t><arg_key>a</arg_key><arg_value>1</arg_value></tool_call>\nTo run it, use <b>2</b>.'
    const buffer = new DsmlStreamBuffer(two('t'))
    const added = buffer.add(input)
    const calls = [...added.calls ?? [], ...buffer.flush().calls ?? []]
    expect(calls).toHaveLength(1)
    expect(calls[0]?.arguments, 'the prose must not become an argument').toBe('{"a":"1"}')
  })

  it('does not merge a second block into the first call', () => {
    const input = '<t><arg_key>a</arg_key><arg_value>1</arg_value></tool_call><t><arg_key>b</arg_key><arg_value>2</arg_value></tool_call>'
    const buffer = new DsmlStreamBuffer(two('t'))
    const added = buffer.add(input)
    const calls = [...added.calls ?? [], ...buffer.flush().calls ?? []]
    // LIMITATION, asserted honestly rather than hidden: `flush()` resolves at
    // most ONE bare block per attempt, so the second block is not recovered here
    // (its bytes are shown instead of being merged into the first call). What
    // must never happen — and did before this fix — is `{"a":"1","b":"2"}`.
    expect(calls.length).toBeLessThanOrEqual(1)
    expect(calls[0]?.arguments).toBe('{"a":"1"}')
  })
})
