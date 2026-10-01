import { describe, expect, it } from 'vitest'
import {
  DsmlStreamBuffer,
  FULLWIDTH_BAR,
  hasProse,
  MARKUP_RE,
  MARKUP_TOKEN,
  parseToolCalls,
  stripMarkup,
} from '../src/dsml-recovery.ts'
import type { BufferOutcome, RecoveredToolCall, RecoveryGate } from '../src/dsml-recovery.ts'

/**
 * These tests lock the RECOVERY half of the upstream defect: turning markup the
 * model wrote into the text back into a real tool call — and, far more
 * importantly, NOT turning anything else into one.
 *
 * The gates are the point. Upstream shipped eager recovery and had to roll it
 * back after production accidents: truncated turns became empty-argument calls,
 * prose that merely DISCUSSED the markup was executed, and names the request
 * never offered were promoted to real calls. Every gate below has a test that
 * fails if the gate is removed — the mutation runs are listed in
 * `docs/DSML-RECOVERY-PLAN.md` §8.3, and they are the reason each gate is a
 * separate `describe` block rather than a comment.
 */

/** Single-bar marker: the spelling the captured leak actually used most often. */
const MARK = `${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}`

/** Doubled-bar marker: the reference spelling. */
const MARK2 = MARKUP_TOKEN

/** A gate that declares `bash`, as most of these cases need. */
function gate(overrides: Partial<RecoveryGate> = {}): RecoveryGate {
  return { declaredNames: new Set(['bash']), ...overrides }
}

/** `<invoke name="bash">` in the marker form, with one explicit parameter. */
function invoke(name: string, parameters: Record<string, string>, mark = MARK): string {
  const body = Object.entries(parameters)
    .map(([key, value]) => `<${mark}parameter name="${key}">${value}</${mark}parameter>`)
    .join('')
  return `<${mark}invoke name="${name}">${body}</${mark}invoke>`
}

/** The wrapped form the model uses when it remembers the outer element. */
function wrapped(name: string, parameters: Record<string, string>, mark = MARK): string {
  return `<${mark}tool_calls>${invoke(name, parameters, mark)}</${mark}tool_calls>`
}

/** The shape this project actually captured: the tool name overwrote `invoke name`. */
function capturedBrokenBlock(): string {
  return `<${MARK} validate>\n`
    + `<${MARK} parameter name="spec">{"title":"x"}</${MARK} parameter>\n`
    + `</${MARK} invoke>\n`
    + `</${MARK2} calls>`
}

/** Argument objects of the recovered calls, for readable assertions. */
function args(calls: readonly RecoveredToolCall[]): Record<string, unknown>[] {
  return calls.map(call => JSON.parse(call.arguments) as Record<string, unknown>)
}

describe('parseToolCalls', () => {
  it('recovers a declared call written into the text', () => {
    const calls = parseToolCalls(wrapped('bash', { command: 'ls -la' }), gate())
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('bash')
    expect(args(calls)).toEqual([{ command: 'ls -la' }])
  })

  it('recovers a bare invoke block with no outer element', () => {
    // The upstream root cause is a MISSING wrapper, so requiring one would
    // recover nothing in exactly the case that matters.
    const calls = parseToolCalls(invoke('bash', { command: 'pwd' }), gate())
    expect(args(calls)).toEqual([{ command: 'pwd' }])
  })

  it('accepts both bar spellings, and a block that mixes them', () => {
    expect(parseToolCalls(wrapped('bash', { command: 'a' }, MARK), gate())).toHaveLength(1)
    expect(parseToolCalls(wrapped('bash', { command: 'a' }, MARK2), gate())).toHaveLength(1)
    // One captured emission spelled the openers with single bars and the closer
    // with doubled ones; a matcher keyed on either spelling alone misses it.
    const mixed = `<${MARK}invoke name="bash"><${MARK}parameter name="command">a</${MARK}parameter></${MARK2}invoke>`
    expect(parseToolCalls(mixed, gate())).toHaveLength(1)
  })

  it('recovers the Claude-style wrapper and plain parameter tags', () => {
    const text = '<tool_call><invoke name="bash"><cmd>ls</cmd></invoke></tool_call>'
    expect(args(parseToolCalls(text, gate()))).toEqual([{ cmd: 'ls' }])
  })

  it('recovers every block in a response, not just the first', () => {
    const text = `before ${wrapped('bash', { command: 'a' })} middle ${wrapped('bash', { command: 'b' })} after`
    expect(args(parseToolCalls(text, gate()))).toEqual([{ command: 'a' }, { command: 'b' }])
  })

  it('produces one call shape only: {id, name, arguments}', () => {
    // The reference's streaming path read `tc["name"]`/`tc["input"]` while its
    // parser returned `{id, type, function}` — the two never agreed, and the
    // streaming branch would have raised. One shape here makes that impossible.
    const call = parseToolCalls(wrapped('bash', { command: 'a' }), gate())[0]
    expect(call).toBeDefined()
    expect(Object.keys(call ?? {}).sort()).toEqual(['arguments', 'id', 'name'])
    expect(call?.id).toMatch(/^call_[0-9a-f]{24}$/)
    expect(typeof call?.arguments).toBe('string')
  })

  it('requires the close tag before committing (gate 1)', () => {
    const truncated = `<${MARK}invoke name="bash"><${MARK}parameter name="command">ls`
    expect(parseToolCalls(truncated, gate())).toEqual([])
  })

  it('refuses a name the request never declared (gate 2)', () => {
    expect(parseToolCalls(wrapped('rm', { path: '/' }), gate())).toEqual([])
  })

  it('honours a tool_choice pinned to one function (gate 2, pinned)', () => {
    // Both tools are declared: pinning narrows an already-legal set, it does
    // not widen it (a pin can never make an undeclared name recoverable).
    const pinned = gate({ declaredNames: new Set(['bash', 'read_file']), pinnedToolName: 'read_file' })
    expect(parseToolCalls(wrapped('bash', { command: 'ls' }), pinned)).toEqual([])
    expect(parseToolCalls(wrapped('read_file', { path: 'a' }), pinned)).toHaveLength(1)

    // A pin at a name the request never declared recovers nothing either.
    const dangling = gate({ pinnedToolName: 'read_file' })
    expect(parseToolCalls(wrapped('read_file', { path: 'a' }), dangling)).toEqual([])
  })

  it('does nothing at all when the request declared no tools (gate 3)', () => {
    const none = gate({ declaredNames: new Set<string>() })
    expect(parseToolCalls(wrapped('bash', { command: 'ls' }), none)).toEqual([])
  })

  it('refuses a call whose required parameter is missing (gate 4)', () => {
    const strict = gate({ requiredParameters: new Map([['bash', ['command']]]) })
    expect(parseToolCalls(wrapped('bash', { other: 'x' }), strict)).toEqual([])
    expect(parseToolCalls(wrapped('bash', { command: 'ls' }), strict)).toHaveLength(1)
  })

  it('never recovers markup that is only being quoted (anti-hijack)', () => {
    // The failure this prevents is expensive: prose ABOUT the markup being
    // executed as a call that really runs and really spends quota.
    expect(parseToolCalls('```\n' + wrapped('bash', { command: 'rm -rf /' }) + '\n```', gate())).toEqual([])
    expect(parseToolCalls('the model writes `' + wrapped('bash', { command: 'x' }) + '` sometimes', gate())).toEqual([])
    expect(parseToolCalls('<![CDATA[' + wrapped('bash', { command: 'x' }) + ']]>', gate())).toEqual([])
    expect(parseToolCalls('<!-- ' + wrapped('bash', { command: 'x' }) + ' -->', gate())).toEqual([])
  })

  it('stops at a broken block instead of trusting what follows it', () => {
    const text = `<${MARK}invoke name="bash">` + wrapped('bash', { command: 'ls' })
    expect(parseToolCalls(text, gate())).toEqual([])
  })
})

describe('hasProse', () => {
  it('reads the captured broken shape as markup, not as an answer', () => {
    // This is the whole reason the retry rule can fire at all: the captured
    // leak invents a tag name (`validate`), and a keyword-only rule would have
    // called it prose and disabled the rule for the one leak it exists for.
    expect(hasProse(capturedBrokenBlock())).toBe(false)
    expect(stripMarkup(capturedBrokenBlock()).trim()).toBe('')
  })

  it('reads an ordinary answer as prose', () => {
    expect(hasProse('这里是三行普通的回答。')).toBe(true)
  })

  it('reads a fenced or quoted mention as prose', () => {
    expect(hasProse('它会写成 ```' + wrapped('bash', { command: 'ls' }) + '``` 这样')).toBe(true)
    expect(hasProse('它写的是 `' + `<${MARK} invoke name="bash">` + '` 这种')).toBe(true)
  })

  it('ignores a marker with prose around it', () => {
    expect(hasProse('先看这段：\n' + capturedBrokenBlock() + '\n结论如下。')).toBe(true)
  })
})

describe('MARKUP_RE', () => {
  it('matches both bar spellings', () => {
    MARKUP_RE.lastIndex = 0
    expect(MARKUP_RE.test(MARK)).toBe(true)
    MARKUP_RE.lastIndex = 0
    expect(MARKUP_RE.test(MARK2)).toBe(true)
  })
})

describe('DsmlStreamBuffer', () => {
  /** Everything the buffer emitted across a chunk sequence, plus the calls. */
  function run(chunks: readonly string[], recoveryGate = gate()): {
    text: string
    calls: RecoveredToolCall[]
    outcomes: BufferOutcome[]
  } {
    const buffer = new DsmlStreamBuffer(recoveryGate)
    const outcomes = chunks.map(chunk => buffer.add(chunk))
    outcomes.push(buffer.flush())
    return {
      text: outcomes.map(outcome => outcome.text).join(''),
      calls: outcomes.flatMap(outcome => outcome.calls ?? []),
      outcomes,
    }
  }

  it('holds a half-arrived block and commits it when the close lands (gate 1)', () => {
    const head = `<${MARK}invoke name="bash"><${MARK}parameter name="command">ls`
    const tail = `</${MARK}parameter></${MARK}invoke>`
    const first = new DsmlStreamBuffer(gate()).add(head)
    expect(first.text).toBe('')
    expect(first.calls).toBeUndefined()

    const buffer = new DsmlStreamBuffer(gate())
    buffer.add(head)
    const second = buffer.add(tail)
    expect(args(second.calls ?? [])).toEqual([{ command: 'ls' }])
    expect(second.text).toBe('')
  })

  it('emits a refused block verbatim rather than dropping it (gate 4)', () => {
    const block = wrapped('rm', { path: '/' })
    const result = run([block])
    expect(result.calls).toEqual([])
    expect(result.text).toBe(block)
    expect(result.outcomes.every(outcome => outcome.prose === false)).toBe(true)
  })

  it('forwards bytes untouched when the request declared no tools (gate 3)', () => {
    const block = wrapped('bash', { command: 'ls' })
    const none = gate({ declaredNames: new Set<string>() })

    const whole = run([block], none)
    expect(whole.calls).toEqual([])
    expect(whole.text).toBe(block)

    // The half-arrived case is what distinguishes gate 3 from gate 2. Gate 2
    // alone would still refuse the NAME, but only after the block completes —
    // so a buffer without its own gate-3 early return would HOLD the first half
    // waiting for a close. With no tools declared there is nothing to wait for,
    // and the bytes must go straight through.
    const head = `<${MARK}invoke name="bash">`
    const buffer = new DsmlStreamBuffer(none)
    expect(buffer.add(head)).toEqual({ text: head, prose: false })
    expect(buffer.add('still arriving').text).toBe('still arriving')
    expect(buffer.flush()).toEqual({ text: '', prose: false })
  })

  it('is chunk-boundary independent (byte-by-byte equals one shot)', () => {
    const head = '先说一句。'
    const block = wrapped('bash', { command: 'ls' })
    const tail = '然后继续。'
    const whole = head + block + tail

    const oneShot = run([whole])
    const byteWise = run([...whole])
    expect(byteWise.text).toBe(oneShot.text)
    expect(byteWise.calls).toHaveLength(oneShot.calls.length)
    expect(args(byteWise.calls)).toEqual(args(oneShot.calls))
    expect(byteWise.text).toBe(head + tail)
  })

  it('recovers two blocks that arrive in one response', () => {
    const result = run([wrapped('bash', { command: 'a' }) + 'x' + wrapped('bash', { command: 'b' })])
    expect(args(result.calls)).toEqual([{ command: 'a' }, { command: 'b' }])
    expect(result.text).toBe('x')
  })

  it('does not starve prose that merely contains a stray "<"', () => {
    // The reference's own comment records why this matters: an architecture
    // document that shows markup as an example must not hold back (and then
    // lose) the rest of the response.
    const result = run(['if a < b and c <50% then 继续写下去'])
    expect(result.text).toBe('if a < b and c <50% then 继续写下去')
  })

  it('does not hold a complete tag that cannot open a block', () => {
    // `<｜DSML｜ validate>` is the captured shape: it is ordinary text as far as
    // this layer knows, so it must stream out immediately instead of waiting
    // for a close that will never come.
    const broken = `<${MARK} validate>`
    const result = run([broken + '继续'])
    expect(result.text).toBe(broken + '继续')
  })

  it('hands a still-unclosed block back on flush, losing nothing', () => {
    const head = '前置说明' + `<${MARK}invoke name="bash"><${MARK}parameter name="command">ls`
    const result = run([head])
    expect(result.calls).toEqual([])
    expect(result.text).toBe(head)
  })

  it('marks residue as non-prose and real prose as prose', () => {
    const buffer = new DsmlStreamBuffer(gate())
    expect(buffer.add('回答如下。').prose).toBe(true)
    const residue = new DsmlStreamBuffer(gate())
    expect(residue.add(`<${MARK} invoke>`).prose).toBe(false)
  })
})
