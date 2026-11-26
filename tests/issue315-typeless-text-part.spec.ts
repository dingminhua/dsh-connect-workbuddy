/**
 * ISSUE #315 — a text part with no `type` must be protected like any other.
 *
 * The reporter's column showed 「改词自检：5 条已知指纹仍留在发出的 body 里」 —
 * a self-check that says the rewrite failed. It was telling the truth about a
 * real gap, not about a broken table.
 *
 * Three passes read a part's `type` and they disagreed: the phrase rewrite, the
 * injected-head strip and the neutraliser all required exactly `'text'`, while
 * the fingerprint TRACE also accepted a MISSING type. So a part shaped
 * `{ text: '…' }` — which the trace itself treats as text — escaped both the
 * rewrite and neutralisation, kept the banned sentence, and then made the
 * self-check accuse the rewrite table of not doing its job.
 *
 * Accepting the unspecified type everywhere is the safe direction: a part with
 * `text` and no `type` has exactly one sensible reading, and the alternative
 * leaves it unprotected on the wire.
 *
 * @module dsh-connect-workbuddy/tests/issue315-typeless-text-part
 */
import { describe, expect, it } from 'vitest'
import { channelFingerprintTrace, prepareChatBody } from '../src/upstream.ts'

const PHRASE = 'You are an AI agent powered by DeepSeek Harness.'

describe('issue #315: a text part without a `type` is rewritten too', () => {
  it('rewrites a typeless part and leaves no known fingerprint behind', () => {
    const raw = JSON.stringify({
      messages: [{ role: 'system', content: [{ text: `${PHRASE}\nrest of the prompt` }] }],
    })
    const prepared = prepareChatBody(raw)
    const part = (JSON.parse(prepared) as { messages: { content: { text: string }[] }[] })
      .messages[0]?.content[0]
    expect(part?.text, 'the typeless part must be rewritten').not.toContain(PHRASE)
    // And the self-check now agrees with what actually shipped.
    expect(channelFingerprintTrace(raw, prepared).unrewrittenRows).toEqual([])
  })

  it('still reports the location in the RAW body, which is what the trace is for', () => {
    // The trace answers "where in the HOST's body does the brand sit", so it
    // reads the raw side. Reporting a hit there is correct even when the
    // prepared side is clean — that is how a reader locates the sentence.
    const raw = JSON.stringify({
      messages: [{ role: 'system', content: [{ text: `${PHRASE}\nrest` }] }],
    })
    const trace = channelFingerprintTrace(raw, prepareChatBody(raw))
    expect(trace.occurrences.size).toBe(1)
    expect([...trace.occurrences.values()][0]?.has('DeepSeek Harness')).toBe(true)
  })

  it('does not treat a non-text part as text', () => {
    // The relaxation is about an ABSENT type only. An explicit other type —
    // an image part, say — must keep being skipped, or the passes would start
    // reading fields that are not text at all.
    const raw = JSON.stringify({
      messages: [{
        role: 'system',
        content: [{ type: 'image_url', text: PHRASE, image_url: { url: 'x' } }],
      }],
    })
    const part = (JSON.parse(prepareChatBody(raw)) as { messages: { content: { text: string }[] }[] })
      .messages[0]?.content[0]
    expect(part?.text).toBe(PHRASE)
  })
})
