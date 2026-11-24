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

/**
 * Everything the buffer emitted across a chunk sequence, plus the calls.
 *
 * Module scope, not a describe-local: a later describe feeds the same buffer a
 * name-less invocation and needs the identical reading of an outcome sequence.
 */
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

describe('DsmlStreamBuffer', () => {
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
    expect(buffer.add(head)).toEqual({ text: head, prose: false, withheld: false })
    expect(buffer.add('still arriving').text).toBe('still arriving')
    expect(buffer.flush()).toEqual({ text: '', prose: false, withheld: false })
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

/**
 * A `<invoke>` with no `name` attribute — the session-333b5f2d defect.
 *
 * The model wrote a complete, well-formed invocation that names no tool. Gate 4
 * says a refused block is shown verbatim, which is right for a tool it may not
 * call; for this one it printed a half-sentence of markup as if it were the
 * answer. These cases pin the two halves of the fix: recover it when the schema
 * says which tool it must have meant, otherwise withhold it AND say so — and
 * withhold nothing when there is nobody to tell.
 */
describe('a name-less invocation', () => {
  /** The marker form with no `name` attribute on the invoke. */
  const nameless = (value: string): string =>
    `<${MARK}invoke><${MARK}parameter name="command">${value}</${MARK}parameter></${MARK}invoke>`

  it('is withheld, while the prose around it survives intact', () => {
    // The transcript that produced this: a stray close tag, the answer's prose,
    // then a wrapped block the model forgot to name.
    const seen: string[] = []
    const leak = `</apm='search'/>\n关键发现：小面板不知道谁在用。\n\n<${MARK}tool_calls>${nameless('grep -n x')}</${MARK}tool_calls>`
    // Five characters at a time: the block has to be withheld across a chunk
    // boundary, which is the case the streaming path actually meets.
    const result = run(leak.match(/[\s\S]{1,5}/g) ?? [], gate({ onWithheld: reason => seen.push(reason) }))
    expect(result.text).toContain('关键发现')
    expect(result.text).not.toContain('DSML')
    expect(result.calls).toEqual([])
    expect(seen, 'the removal is reported, not silent').toEqual(['unnamed-invoke'])
  })

  it('is recovered as a call when the schema names exactly one tool', () => {
    // `acceptedParameters` is what makes this possible: every declared tool's
    // parameter names, so a block whose tags fit exactly one of them must have
    // meant that one.
    const result = run([nameless('ls')], {
      declaredNames: new Set(['bash', 'read']),
      requiredParameters: new Map([['read', ['path']]]),
      acceptedParameters: new Map([
        ['bash', new Set(['command'])],
        ['read', new Set(['path'])],
      ]),
      inferFromSchema: true,
    })
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]!.name).toBe('bash')
    expect(result.text).not.toContain('DSML')
  })

  it('keeps gate 4 for a block that DOES name a tool it may not call', () => {
    const result = run([wrapped('read', { p: 'x' })])
    expect(result.text).toContain('invoke name="read"')
  })

  it('is shown verbatim when no listener could report the withhold', () => {
    // The interlock: with no `onWithheld` the block would vanish silently, and a
    // silently deleted answer is worse than the markup it replaced. Shown instead.
    const result = run([nameless('ls')])
    expect(result.text).toContain(`${MARK}invoke>`)
  })
})

/**
 * Issue #152: the model writes a tool name ONE CHARACTER away from a name the
 * request offered.
 *
 * The captured form is `name="pwdsh"` where the request offered `pwsh` — one
 * inserted `d` between `pw` and `sh`. Gate 2 refuses it (correctly: that name
 * was never on offer), so before this the whole block fell back to plain text
 * and the user read a wall of markup.
 *
 * The repair is deliberately narrow, and each of these cases pins one edge of
 * "narrow": it may only ever select a name ALREADY on offer, only when exactly
 * one is in reach, never for a short name, never when the exact name exists,
 * and never a parameter name.
 */
describe('issue #152: a tool name one edit away from a declared one', () => {
  /** The exact opener the reporter captured: `pwdsh`, and `pwsh` on offer. */
  const captured = (): string => invoke('pwdsh', { command: 'ssh host' })

  it('recovers `pwdsh` as `pwsh` when the caller opted in', () => {
    const g = gate({ declaredNames: new Set(['pwsh', 'read_file']), repairNearMissName: true })
    const calls = parseToolCalls(captured(), g)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('pwsh')
    expect(JSON.parse(calls[0]?.arguments ?? '{}')).toEqual({ command: 'ssh host' })
  })

  it('still refuses it when the caller did NOT opt in — the default stays fail-closed', () => {
    const g = gate({ declaredNames: new Set(['pwsh', 'read_file']) })
    expect(parseToolCalls(captured(), g)).toHaveLength(0)
  })

  it('refuses when TWO declared tools are within one edit — ambiguity is not a repair', () => {
    // `pwdsh` is one insertion from both `pwsh` and `pwdsh`-minus-d variants;
    // make two genuinely reachable candidates instead: `pwsh` and `pwdss`.
    const g = gate({ declaredNames: new Set(['pwsh', 'pwdss']), repairNearMissName: true })
    expect(parseToolCalls(captured(), g)).toHaveLength(0)
  })

  it('refuses a short name, where one edit is not evidence', () => {
    // `cut` and `cat` are one substitution apart, but at three characters that
    // is not evidence — half the three-letter names in any toolbox are one edit
    // from another. The floor is length >= 4 on both sides, so this must refuse.
    const g = gate({ declaredNames: new Set(['cat']), repairNearMissName: true })
    expect(parseToolCalls(invoke('cut', { command: 'x' }), g)).toHaveLength(0)
  })

  it('refuses a short CANDIDATE even when the written name is long enough', () => {
    // The floor applies to both sides: a 4+ written name against a 3-letter
    // offered tool is still a guess, not a repair.
    const g = gate({ declaredNames: new Set(['cat']), repairNearMissName: true })
    expect(parseToolCalls(invoke('cats', { command: 'x' }), g)).toHaveLength(0)
  })

  it('never "repairs" a name that is already declared', () => {
    const g = gate({ declaredNames: new Set(['pwsh']), repairNearMissName: true })
    const calls = parseToolCalls(invoke('pwsh', { command: 'ls' }), g)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('pwsh')
  })

  it('never invents a name that is not on offer, however close', () => {
    // `pwdsh` is close to `pwsh`, but if `pwsh` was not offered there is
    // nothing legitimate to select.
    const g = gate({ declaredNames: new Set(['bash', 'read_file']), repairNearMissName: true })
    expect(parseToolCalls(captured(), g)).toHaveLength(0)
  })

  it('still honours the pin: a pinned request refuses the repaired name', () => {
    const g = gate({
      declaredNames: new Set(['pwsh', 'read_file']),
      repairNearMissName: true,
      pinnedToolName: 'read_file',
    })
    expect(parseToolCalls(captured(), g)).toHaveLength(0)
  })

  it('still honours gate 4: a repaired name missing a required parameter is truncated', () => {
    const g = gate({
      declaredNames: new Set(['pwsh']),
      repairNearMissName: true,
      requiredParameters: new Map([['pwsh', ['command', 'description']]]),
    })
    expect(parseToolCalls(captured(), g)).toHaveLength(0)
  })

  it('never repairs a PARAMETER name — that would change what the call means', () => {
    // `comand` is one edit from `command`; the parameter must keep its written
    // spelling and the call must still be recovered (as `pwsh`) with the
    // parameter exactly as the model wrote it.
    const g = gate({ declaredNames: new Set(['pwsh']), repairNearMissName: true })
    const calls = parseToolCalls(invoke('pwdsh', { comand: 'ls' }), g)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]?.arguments ?? '{}')).toEqual({ comand: 'ls' })
  })
})

/**
 * Bare markup: the model forgot the marker entirely and wrote the call as plain
 * XML into the answer.
 *
 * This is a SECOND, independent defect from the marker cases above, and it is
 * the one that actually reached users: a client that only recovers marked
 * markup forwards `<ask_user_question>` byte for byte, so the reader sees the
 * protocol instead of the question. The shape was captured from a real
 * response, down to the truncated `<questions` key whose `>` never arrived.
 *
 * Every case here is written against a gate with `bareMarkup: true`. With the
 * flag off the old behaviour is required to be bit-for-bit unchanged — that is
 * the first test, and it is what keeps this from becoming a silent rewrite of
 * every answer that happens to contain an angle bracket.
 */
describe('bare markup', () => {
  /** The gate a bare-markup caller passes: the flag plus a real tool schema. */
  function bareGate(overrides: Partial<RecoveryGate> = {}): RecoveryGate {
    return {
      declaredNames: new Set(['ask_user_question']),
      acceptedParameters: new Map([['ask_user_question', new Set(['questions'])]]),
      bareMarkup: true,
      ...overrides,
    }
  }

  /** The captured response, verbatim: prose, then the call with a broken key. */
  const LEAK = '<ask_user_question>\n<questions</arg_key><arg_value>[{"header":"A","question":"B"}]</arg_value></tool_call>'
  const PROSE = '好的，我列两个选项：\n'

  it('leaves the leak alone when the flag is off', () => {
    // The default. A client that has not opted in must not have its prose
    // rewritten, and a bare block must not become a call behind its back.
    const g = bareGate({ bareMarkup: false })
    expect(parseToolCalls(LEAK, g)).toHaveLength(0)
    expect(stripMarkup(LEAK, g)).toBe(LEAK)
    expect(hasProse(LEAK, g)).toBe(true)
  })

  it('recovers the captured leak as a call, and the prose survives', () => {
    const calls = parseToolCalls(LEAK, bareGate())
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('ask_user_question')
    expect(args(calls)).toEqual([{ questions: '[{"header":"A","question":"B"}]' }])
    // `stripMarkup` removes TAGS, not the text between them, so the argument
    // value survives it. Removing a whole block is the buffer's job (below),
    // and conflating the two is how "clean text" hides a still-visible leak.
    expect(stripMarkup(PROSE + LEAK, bareGate())).not.toContain('ask_user_question')
    expect(stripMarkup(PROSE + LEAK, bareGate())).not.toContain('</tool_call>')
  })

  it('recovers the same leak when it arrives in fragments (gate 1 + hold)', () => {
    // The shape that actually shipped: `delta.content` never arrives whole. If
    // the buffer commits the opening tag as text the moment it is complete, the
    // block can never be assembled and the leak is already out the door.
    const result = run((PROSE + LEAK).split(''), bareGate())
    expect(args(result.calls)).toEqual([{ questions: '[{"header":"A","question":"B"}]' }])
    expect(result.text).toBe(PROSE)
  })

  it('pairs <arg_key>/<arg_value> into ONE parameter, not two', () => {
    // Reading the pair as ordinary tags put `arg_key` and `arg_value` into the
    // arguments alongside the real parameter.
    const calls = parseToolCalls('<ask_user_question><arg_key>questions</arg_key><arg_value>Q</arg_value></tool_call>', bareGate())
    expect(args(calls)).toEqual([{ questions: 'Q' }])
  })

  it('takes the wrapper name as the tool name', () => {
    const calls = parseToolCalls('<ask_user_question><questions>Q</questions></ask_user_question>', bareGate())
    expect(calls[0]?.name).toBe('ask_user_question')
    expect(args(calls)).toEqual([{ questions: 'Q' }])
  })

  it('refuses a bare wrapper naming a tool the request never declared (gate 2)', () => {
    const block = '<drop_tables><command>rm -rf /</command></drop_tables>'
    expect(parseToolCalls(block, bareGate())).toHaveLength(0)
    // Gate 4: refused means shown, not swallowed.
    expect(run([block], bareGate()).text).toBe(block)
  })

  it('refuses a call that is missing a required parameter (gate 4)', () => {
    const g = bareGate({ requiredParameters: new Map([['ask_user_question', ['questions']]]) })
    const block = '<ask_user_question><header>only a header</header></ask_user_question>'
    expect(parseToolCalls(block, g)).toHaveLength(0)
    expect(run([block], g).text).toBe(block)
  })

  it('does not take a truncated key the schema does not name', () => {
    // The truncated-key rule is a narrow permission, not a general repair: the
    // key must be one the tool accepts, and with a required list it must be the
    // single one still missing.
    const g = bareGate({ requiredParameters: new Map([['ask_user_question', ['questions']]]) })
    expect(parseToolCalls('<ask_user_question><wrong</arg_key><arg_value>v</arg_value></tool_call>', g)).toHaveLength(0)
  })

  it('leaves ordinary HTML and prose untouched', () => {
    const text = 'Use <div> and <b>bold</b>. Compare a < b and x < 5.'
    expect(stripMarkup(text, bareGate())).toBe(text)
    expect(parseToolCalls(text, bareGate())).toHaveLength(0)
    expect(run([text], bareGate()).text).toBe(text)
  })

  it('keeps a marked block working exactly as before', () => {
    // The bare path must not disturb the marker path it was added beside.
    const g = gate({ bareMarkup: true, acceptedParameters: new Map([['bash', new Set(['command'])]]) })
    const result = run([wrapped('bash', { command: 'ls' })], g)
    expect(args(result.calls)).toEqual([{ command: 'ls' }])
    expect(result.text).toBe('')
  })
})
