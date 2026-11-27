/**
 * ISSUE #328 — a model's `<think…>` reasoning channel must not reach the user.
 *
 * THE REPORT: some upstream models inline their chain of thought directly into
 * `delta.content`, wrapped in a tag carrying a PER-RESPONSE hash suffix. A user
 * saw the whole thing as their answer — the scratch `// plan:` code and a
 * FORGED tool-call draft (`<arg_key:HASH>` / `<arg_value:HASH>`) rendered as
 * prose, which is what made it look like a broken half-recovered call.
 *
 * WHY IT LEAKED RATHER THAN JUST LOOKED ODD. Two mechanisms conspired:
 *   1. nothing in the recovery layer knew what a thinking channel was, so the
 *      inner `arg_key:HASH` pairs read as ordinary text;
 *   2. `scanTag` parses `<think:6124c78e>` as name `think` plus attributes (the
 *      hash is not in `readName`'s character class), so the opener looked like a
 *      MARKED block opener, `openerSeen` became true, and the debris sweep then
 *      took its "a block DID open, keep its text verbatim" branch — actively
 *      PROTECTING the leak.
 *
 * So the channel is removed before any gate sees it. What must never happen in
 * the other direction is losing the ANSWER: the first version of this fix
 * swallowed everything after the channel on a byte-by-byte stream, which is
 * worse than the leak (the user asked a question and got nothing).
 *
 * @module dsh-connect-workbuddy/tests/issue328-think-channel
 */
import { describe, expect, it } from 'vitest'
import { DsmlStreamBuffer } from '../src/dsml-recovery.ts'
import type { RecoveryGate } from '../src/dsml-recovery.ts'

function gate(): RecoveryGate {
  return { declaredNames: new Set(['job_output']), bareMarkup: true }
}

/** Feed chunks one by one and concatenate what the client would have received. */
function run(chunks: readonly string[]): string {
  const buffer = new DsmlStreamBuffer(gate())
  let out = ''
  for (const chunk of chunks) out += buffer.add(chunk).text
  return out + buffer.flush().text
}

/** The captured shape: hash-suffixed channel wrapping a forged call draft. */
const CHANNEL = '<think:6124c78e>\n// plan: poll job\n'
  + '<arg_key:6124c78e>desc</arg_key:6124c78e>'
  + '<arg_value:6124c78e>poll progress</arg_value:6124c78e>'
  + '\n</think:6124c78e>'

describe('issue #328: the reasoning channel is removed', () => {
  it('strips the captured sample entirely', () => {
    const out = run([`${CHANNEL}The scene finished rendering.`])
    expect(out).toBe('The scene finished rendering.')
    expect(out).not.toContain('// plan:')
    expect(out).not.toContain('arg_key')
    expect(out).not.toContain('arg_value')
    expect(out).not.toContain('<think')
    expect(out).not.toContain('6124c78e')
  })

  it('keeps the answer when the channel is split across MANY chunks', () => {
    // The case the first fix broke: one character per chunk.
    const source = `${CHANNEL}Done.`
    expect(run([...source])).toBe('Done.')
  })

  it('keeps the answer when the channel boundary falls mid-tag', () => {
    expect(run(['<thi', 'nk:abc>secret', '</thi', 'nk:abc>visible'])).toBe('visible')
    expect(run(['<think:abc>secret</think', ':abc>visible'])).toBe('visible')
  })

  it('strips consecutive channels and keeps the prose between them', () => {
    const out = run([`<think:a>one</think:a>Between.<think:b>two</think:b>After.`])
    expect(out).toBe('Between.After.')
  })
})

describe('issue #328: a truncated channel leaks nothing', () => {
  it('drops an unterminated channel at end of stream', () => {
    // Half a private thought is still a private thought — and the most likely
    // place for a half-written tool call to sit.
    expect(run(['<think:abc>half a thought'])).toBe('')
    expect(run(['preamble <think:abc>tail'])).toBe('preamble ')
  })
})

describe('issue #328: ordinary prose that only LOOKS like a channel survives', () => {
  // The `(?=[>:\s])` boundary is what earns this: only a real tag boundary
  // starts a channel, so a word that merely begins with "think" is left alone.
  it.each([
    'I <thinks> this is fine.',
    '<thinking> is a word here.',
    'A normal sentence with a < b and c > d.',
    'Nothing tagged at all.',
  ])('leaves %s byte-identical', (prose) => {
    expect(run([prose])).toBe(prose)
  })

  it('leaves a bare <think> pair outside a channel alone when it is not tag-shaped', () => {
    // A literal "<think" with no closing `>` is prose, not markup; the answer
    // must not be truncated on its account.
    expect(run(['compare a <think b'])).toBe('compare a <think b')
  })
})
