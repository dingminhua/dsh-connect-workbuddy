/**
 * Issue #207: two DSML recovery failures that let markup reach the visible text.
 *
 * THE REPORT (verified by the reporter on three published builds and on a bare
 * `tsc` of `src/dsml-recovery.ts` with no host, no cordis and no other plugin —
 * a control strong enough to exclude environment, account and version, because
 * changing ONE WORD flipped the behaviour).
 *
 *   A. An ENVELOPE whose closing tag is abbreviated `</｜DSML｜｜ calls>`. The
 *      closer normalised to `calls`, the opener to `tool_calls`, so the pair
 *      never matched: the block read as never closed (gate 1), was held to end
 *      of stream, and gate 4 then rolled the whole thing back into prose.
 *      `docs/DSML-LEAK-RESEARCH.md` records a REAL capture with exactly that
 *      closer — the document knew, the table did not.
 *
 *   B. A response that opens NOTHING and contains only lone closing tags. The
 *      debris sweep ran only behind `debris()`, i.e. only after a block had been
 *      withheld, so this shape was forwarded raw. The module already disagreed
 *      with itself about it: `hasProse()` classified those bytes as non-prose
 *      while the output path printed them.
 *
 *   C. Once the upstream sent a native `tool_calls` delta, the shim bypassed
 *      the buffer for every later content frame. "Do not recover a second call
 *      channel" (right) silently became "do not clean the text either" (wrong).
 *      The repository's own test asserted the leak as expected behaviour.
 *
 * WHAT IS PINNED HERE. Each fix keeps all four gates and the fail-closed
 * orientation: `calls` is normalised only in a MARKER form (a bare `<calls>` is
 * somebody's HTML or the word "calls"), lone-closer removal refuses to run at
 * all if any marked opener appeared (a gate-4-refused block's opener can carry a
 * forged name and must keep its closer), and scrub mode never produces a call
 * and never marks residue.
 */
import { describe, expect, it } from 'vitest'
import {
  DsmlStreamBuffer,
  FULLWIDTH_BAR,
  MARKUP_TOKEN,
  parseToolCalls,
  stripMarkup,
} from '../src/dsml-recovery.ts'
import type { BufferOutcome, RecoveryGate } from '../src/dsml-recovery.ts'

/** Single-bar marker: what the captured leaks used most often. */
const MARK = `${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}`

function gate(overrides: Partial<RecoveryGate> = {}): RecoveryGate {
  return { declaredNames: new Set(['bash']), ...overrides }
}

/** Drive a buffer over `chunks` and concatenate the text it releases. */
function run(chunks: readonly string[], overrides: Partial<RecoveryGate> = {}): {
  text: string
  outcomes: BufferOutcome[]
} {
  const buffer = new DsmlStreamBuffer(gate(overrides))
  const outcomes: BufferOutcome[] = []
  for (const chunk of chunks) outcomes.push(buffer.add(chunk))
  outcomes.push(buffer.flush())
  return { text: outcomes.map(outcome => outcome.text).join(''), outcomes }
}

/**
 * The captured envelope, with a closing tag the model abbreviated to `calls`.
 *
 * The inner closers stay spelled `invoke`/`parameter` on purpose: the report's
 * table shows only the WRAPPER closer abbreviated, and widening the normaliser
 * beyond what was observed would be guessing.
 */
function envelopeWithCallsCloser(): string {
  return `<${MARK}tool_calls>\n`
    + `<${MARK}invoke name="bash">\n`
    + `<${MARK}parameter name="command">ls -la</${MARK}parameter>\n`
    + `</${MARK}invoke>\n`
    + `</${MARK2_CALLS()}calls>`
}

/** The doubled-bar form of the abbreviated closer, as captured in the wild. */
function MARK2_CALLS(): string {
  return MARKUP_TOKEN
}

/** The shape the issue quotes verbatim: lone closers, no opener anywhere. */
function loneClosers(): string {
  return `</${MARK}parameter>\n</${MARK}invoke>\n</${MARK}calls>`
}

describe('issue #207 A: an envelope closed with the abbreviated `calls` tag', () => {
  it('closes the block, so the call is recovered instead of leaked', () => {
    const calls = parseToolCalls(envelopeWithCallsCloser(), gate())
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('bash')
    expect(JSON.parse(calls[0]?.arguments ?? '{}')).toEqual({ command: 'ls -la' })
  })

  it('leaves no marker in the text when streamed', () => {
    const result = run([envelopeWithCallsCloser()])
    expect(result.text).toBe('')
    expect(result.text).not.toContain(MARK)
  })

  it('is chunk-boundary independent, five characters at a time', () => {
    const result = run(envelopeWithCallsCloser().match(/[\s\S]{1,5}/g) ?? [])
    expect(result.text).not.toContain(MARK)
  })

  it('still refuses a bare `<calls>` — normalisation is marker-only', () => {
    // `calls` is an ordinary English word and a plausible HTML tag. Treating it
    // as protocol without the marker would start deleting user text, so the
    // bare spelling must remain ordinary text that `stripMarkup` leaves alone.
    expect(stripMarkup('<calls>hello</calls>')).toBe('<calls>hello</calls>')
    // The MARKED spelling is markup, in both the single- and doubled-bar forms.
    expect(stripMarkup(`<${MARK}calls>x</${MARK}calls>`)).toBe('')
    expect(stripMarkup(`<${MARKUP_TOKEN}calls>x</${MARKUP_TOKEN}calls>`)).toBe('')
    // `toolcalls` was already marker-only before this change and must stay so.
    expect(stripMarkup('<toolcalls>x</toolcalls>')).toBe('<toolcalls>x</toolcalls>')
  })

  it('still shows a REFUSED block verbatim, including its abbreviated closer', () => {
    // Gate 4 is untouched by the normalisation: an undeclared tool is still
    // shown exactly as written, closer spelling and all.
    const block = envelopeWithCallsCloser().replace('name="bash"', 'name="rm"')
    const result = run([block])
    expect(result.text).toContain('name="rm"')
    expect(result.text).toContain(`</${MARK2_CALLS()}calls>`)
  })
})

describe('issue #207 B: lone closing tags from a response that opened nothing', () => {
  it('removes them instead of forwarding them as prose', () => {
    const result = run([loneClosers()])
    expect(result.text).not.toContain(MARK)
    // Only the line breaks BETWEEN the removed tags survive. That is the same
    // whitespace `stripMarkup` leaves everywhere else, and it is still not
    // prose: `hasProse` trims before answering, so a response made of nothing
    // but these closers still reads as residue.
    expect(result.text.trim()).toBe('')
  })

  it('removes them chunk by chunk, with no dependence on a withhold', () => {
    const result = run(loneClosers().match(/[\s\S]{1,4}/g) ?? [])
    expect(result.text).not.toContain(MARK)
  })

  it('reports the removal rather than deleting silently', () => {
    const seen: string[] = []
    const buffer = new DsmlStreamBuffer(gate({ onWithheld: reason => seen.push(reason) }))
    buffer.add(loneClosers())
    const flushed = buffer.flush()
    expect(flushed.text).toBe('')
    expect(seen, 'a removal the user cannot see must still be reportable').toEqual(['stray-markup'])
  })

  it('keeps the prose around them', () => {
    const result = run([`关键发现：小面板不知道谁在用。\n${loneClosers()}\n结论在上面。`])
    expect(result.text).toContain('关键发现')
    expect(result.text).toContain('结论在上面')
    expect(result.text).not.toContain(MARK)
  })

  it('deletes NOTHING once any marked opener has appeared (the stricter direction)', () => {
    // The captured shape: the tool name overwrote `invoke name="…"`, so the
    // opener wears a forged name (`validate`) that by name never matches its own
    // closer. Depth pairing — the reporter's first two attempts — deleted that
    // closer and broke the verbatim guarantee. Presence keeps it.
    const forged = `<${MARK} validate>\n<${MARK} parameter name="spec">{"title":"x"}</${MARK} parameter>\n</${MARK} invoke>`
    const result = run([forged])
    expect(result.text).toBe(forged)
  })

  it('keeps a lone closer next to a gate-4-refused block, which is shown verbatim', () => {
    const refused = `<${MARK}tool_calls><${MARK}invoke name="rm">`
      + `<${MARK}parameter name="command">x</${MARK}parameter></${MARK}invoke></${MARK}tool_calls>`
    const leaked = `</${MARK}calls>`
    const result = run([refused + leaked])
    expect(result.text).toContain('name="rm"')
    expect(result.text).toContain(leaked)
  })

  it('still keeps marker text inside a fence, where it is being quoted', () => {
    const quoted = `先看这段：\n\`\`\`\n${loneClosers()}\n\`\`\`\n就是这个形态。`
    const result = run([quoted])
    expect(result.text).toContain('parameter')
    expect(result.text).toContain('就是这个形态')
  })
})

describe('issue #207 C: scrub mode after a native call', () => {
  /** A gate plus a buffer already stood down, as the shim leaves it. */
  function scrubbed(): DsmlStreamBuffer {
    const buffer = new DsmlStreamBuffer(gate())
    buffer.standDown()
    return buffer
  }

  it('removes a complete block and produces NO call', () => {
    const buffer = scrubbed()
    const outcomes = [buffer.add(envelopeWithCallsCloser()), buffer.flush()]
    expect(outcomes.flatMap(outcome => outcome.calls ?? [])).toEqual([])
    expect(outcomes.map(outcome => outcome.text).join('')).toBe('')
  })

  it('keeps the prose around the removed block', () => {
    const buffer = scrubbed()
    const text = [buffer.add(`第一句。${envelopeWithCallsCloser()}第二句。`), buffer.flush()]
      .map(outcome => outcome.text).join('')
    expect(text).toBe('第一句。第二句。')
  })

  it('does not report the removal as residue, so the retry cannot re-run the call', () => {
    // `residueSeen` drives the "the turn was markup only" retry, and a retry
    // makes the upstream execute the call a SECOND time. The native channel
    // already answered, so scrub-mode removals must stay silent about residue.
    const seen: string[] = []
    const buffer = new DsmlStreamBuffer(gate({ onWithheld: reason => seen.push(reason) }))
    buffer.standDown()
    const outcomes = [buffer.add(envelopeWithCallsCloser()), buffer.flush()]
    expect(seen).toEqual([])
    expect(outcomes.some(outcome => outcome.withheld)).toBe(false)
  })

  it('scrubs lone closers too, which the old bypass forwarded as prose', () => {
    const buffer = scrubbed()
    const text = [buffer.add(loneClosers()), buffer.flush()].map(outcome => outcome.text).join('')
    expect(text).not.toContain(MARK)
    expect(text.trim()).toBe('')
  })

  it('never recovers a call even when the block is perfectly formed', () => {
    const buffer = scrubbed()
    buffer.add(`<${MARK}tool_calls><${MARK}invoke name="bash">`
      + `<${MARK}parameter name="command">rm -rf /</${MARK}parameter>`
      + `</${MARK}invoke></${MARK}tool_calls>`)
    expect(buffer.flush().calls).toBeUndefined()
  })
})
