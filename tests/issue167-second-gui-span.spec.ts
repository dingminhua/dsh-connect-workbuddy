/**
 * The Web-GUI paragraph has TWO independently blocked sentences (issue #167).
 *
 * ## What was wrong
 *
 * The 5.13.1 table rewrote four known fingerprints, one of which was the Web
 * GUI OPENING (`You are interacting with the user through the DeepSeek Harness
 * Web GUI`). Its comment recorded a belief about the REST of that paragraph:
 *
 *     The second GUI sentence is not a fingerprint of its own and is left alone.
 *
 * `tests/issue163-sentence-rewrite.spec.ts` asserted that belief. swaggylc
 * (#167) bisected the host system prompt against the live CN gateway by prefix
 * length and measured the opposite:
 *
 *   - the smallest failing prefix is 5,683 chars, whose tail is the SECOND
 *     sentence — not the opening;
 *   - the minimal failing window is `er target, they mean this GUI.` (the tail
 *     of `without naming another target, they mean this GUI.`), and dropping its
 *     first character answers 200;
 *   - the whole prompt with span #1 (`Tokens prefixed with @ …`) fixed still
 *     answered 400; fixing BOTH spans answered 200;
 *   - the same window chopped with U+200B / U+2060 / doubled spaces still
 *     answered 400 — the gateway normalises and then matches words, so only
 *     changing the words works.
 *
 * Note the AGENCY the two reports split between them: #164 measured that this
 * paragraph fails at its first 221 chars (two sentences), #167 measured WHICH
 * of those two is load-bearing at the tail. Both point at the same rule — a
 * row per sentence — which is why the table is sentence-level rather than
 * paragraph-level.
 *
 * ## What this file pins
 *
 * Not the wording of the replacement (a paraphrase is a judgement call and was
 * re-measured as such in #167: an alternative paraphrase also answered 200).
 * What is pinned is the INVARIANT: after the rewrite the paragraph contains
 * neither blocked sentence, still reads as an instruction, and the second
 * sentence is cleared even when it arrives TRUNCATED — the shape a prefix
 * bisection produces and a future host that shortens the paragraph would too.
 * `prepareChatBody` is exercised end to end because that is the path a request
 * actually takes; a table nobody calls is not a fix.
 */
import { describe, expect, it } from 'vitest'
import { prepareChatBody, rewriteChannelFingerprintPhrases } from '../src/upstream.ts'

/** The host's paragraph, verbatim (app.asar, DSH 0.2.1-rc.3). */
const GUI_PARAGRAPH = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime '
  + 'context names. When the user refers to "this page", "this GUI", or "this app" without naming another target, '
  + 'they mean this GUI. The browser provides no implicit DOM, route, or screenshot context.'

/** The two sentences #167 measured as independently blocked. */
const FIRST_SENTENCE = 'You are interacting with the user through the DeepSeek Harness Web GUI'
const SECOND_SENTENCE = 'they mean this GUI.'

const messagesOf = (json: string): { role: string, content: unknown }[] =>
  (JSON.parse(json) as { messages: { role: string, content: unknown }[] }).messages

describe('#167: the second blocked sentence in the Web-GUI paragraph', () => {
  it('clears BOTH sentences of the paragraph', () => {
    const out = rewriteChannelFingerprintPhrases(GUI_PARAGRAPH)
    expect(out).not.toContain(FIRST_SENTENCE)
    expect(out).not.toContain(SECOND_SENTENCE)
    // The sentence BEFORE it carries the same trailing clause, so it must be
    // gone too — otherwise a host that ships only the tail still matches.
    expect(out).not.toContain('without naming another target, they mean this GUI.')
    // Unrelated text in the paragraph survives: this is a rewrite, not a purge.
    expect(out).toContain('The browser provides no implicit DOM, route, or screenshot context.')
  })

  it('clears the TRUNCATED window #167 bisected down to', () => {
    // `er target, they mean this GUI.` — the minimal failing window, and the
    // shape a prefix bisection produces. A row matching only the full sentence
    // would leave it standing.
    const truncated = 'er target, they mean this GUI.'
    const out = rewriteChannelFingerprintPhrases(truncated)
    expect(out).not.toContain(SECOND_SENTENCE)
    expect(out.toLowerCase()).toContain('interface')
  })

  it('keeps the replacement READABLE as an instruction', () => {
    // The point of a paraphrase rather than a deletion: the model still has to
    // understand which interface the user means. A rewrite that reduced the
    // sentence to punctuation would clear the gate and break the prompt.
    const out = rewriteChannelFingerprintPhrases(GUI_PARAGRAPH)
    expect(out).toContain('the interface described here is meant')
    // No control characters or zero-width filler smuggled in as a shortcut.
    expect(out).not.toMatch(/[\u200b-\u200d\u2060\ufeff]/u)
  })

  it('is idempotent: a second pass changes nothing', () => {
    // `prepareChatBody` can run on a body that a previous stage already
    // rewrote, and the rescue ladder re-prepares. An accumulating rewrite would
    // grow the prompt on every attempt.
    const once = rewriteChannelFingerprintPhrases(GUI_PARAGRAPH)
    expect(rewriteChannelFingerprintPhrases(once)).toBe(once)
  })

  it('reaches the wire through prepareChatBody, for system AND assistant history', () => {
    // The gate reads both roles (#98). A row applied to `system` only would
    // leave a refused sentence in the assistant history — which is exactly the
    // "every later turn is refused" shape #98 reported.
    const body = prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: GUI_PARAGRAPH },
        { role: 'assistant', content: [{ type: 'text', text: GUI_PARAGRAPH }] },
        { role: 'user', content: GUI_PARAGRAPH },
      ],
    }))
    const messages = messagesOf(body)
    expect(messages[0]?.content).not.toContain(SECOND_SENTENCE)
    const assistant = messages[1]?.content as { type: string, text: string }[]
    expect(assistant[0]?.text).not.toContain(SECOND_SENTENCE)
    // `user` is deliberately untouched: the gate does not scan it, and rewriting
    // a user's own words would change the conversation for no gate (#163).
    expect(messages[2]?.content).toBe(GUI_PARAGRAPH)
  })

  it('leaves an ordinary system prompt byte-for-byte alone', () => {
    const ordinary = 'An ordinary system prompt with no measured phrase.'
    expect(rewriteChannelFingerprintPhrases(ordinary)).toBe(ordinary)
  })
})
