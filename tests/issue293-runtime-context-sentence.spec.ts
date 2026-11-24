/**
 * ISSUE #293 / #295 — one first-party system sentence was not in the rewrite
 * table, and the gateway matches fixed spans ANYWHERE in a scanned message.
 *
 * The host's `dsh-harness-dev-context` ships HARNESS_SOURCE_PROMPT:
 *
 *   The runtime context names the DeepSeek Harness implementation checkout. …
 *
 * It sits in the MIDDLE of a 5,700+ char system message, right before the Web
 * GUI paragraph (#167's two sentences were already covered). A reporter on the
 * live CN gateway isolated this sentence: rewriting it at source cleared a
 * refusal that the whole rescue ladder (neutral head + sparse + dense
 * perturbation) could not. The plugin only ever sees the wire body, so the fix
 * belongs in the rewrite table.
 *
 * All text here is the first-party prompt wording, not a captured account,
 * device or session.
 *
 * @module dsh-connect-workbuddy/tests/issue293-runtime-context-sentence
 */
import { describe, expect, it } from 'vitest'
import { prepareChatBody, rewriteChannelFingerprintPhrases } from '../src/upstream.ts'

const SENTENCE = 'The runtime context names the DeepSeek Harness implementation checkout.'
const NEUTRAL = 'The runtime context names the local implementation checkout.'

/** The host's section, with the following sentences that must survive. */
const RUNTIME_CONTEXT = SENTENCE
  + ' The checkout location and current working directory are separate values and may differ; '
  + 'never infer the working directory from the checkout path.'

describe('the runtime-context sentence is rewritten (issue #293 / #295)', () => {
  it('clears the sentence while leaving the rest of the section intact', () => {
    const out = rewriteChannelFingerprintPhrases(RUNTIME_CONTEXT)
    expect(out).not.toContain(SENTENCE)
    expect(out).toContain(NEUTRAL)
    expect(out).toContain('never infer the working directory from the checkout path.')
  })

  it('is idempotent', () => {
    const once = rewriteChannelFingerprintPhrases(RUNTIME_CONTEXT)
    expect(rewriteChannelFingerprintPhrases(once)).toBe(once)
  })

  it('does not inject zero-width filler as a shortcut', () => {
    // A rewrite must stay READABLE as an instruction; only real words change.
    const out = rewriteChannelFingerprintPhrases(RUNTIME_CONTEXT)
    expect(out).not.toMatch(/[\u200b-\u200d\u2060\ufeff]/u)
  })

  it('reaches the wire through prepareChatBody on a system message', () => {
    const body = prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'system', content: `Preamble. ${SENTENCE} Tail.` }],
    }))
    const parsed = JSON.parse(body) as { messages: { role: string, content: string }[] }
    expect(parsed.messages[0]?.content).toContain(NEUTRAL)
    expect(parsed.messages[0]?.content).not.toContain(SENTENCE)
    expect(parsed.messages[0]?.content).toContain('Tail.')
  })
})
