/**
 * ISSUE #321 — the rewrite must not REMOVE protection from the sentence it fixes.
 *
 * THE DEFECT, measured against the published 5.31.8 build. `prepareChatBody`
 * runs the phrase rewrite FIRST, then neutralisation. Both neutralisation
 * predicates recognised only the ORIGINAL wording, so:
 *
 *     You are an AI agent powered by DeepSeek Harness.
 *     → rewritten to "You are an AI agent running inside the harness."
 *     → matched NEITHER `isUnapprovedChannelOpening` NOR `IDENTITY_CLAUSE`
 *     → no clause break, no protection at all on the sentence that ships.
 *
 * One rewrite silently disabled the layer it was meant to work with: a sentence
 * that WOULD have been broken went out intact.
 *
 * THE FIX IS THE CLAUSE, NOT THE PREFIX LIST. Listing the replacement as a
 * refused OPENING would be circular — the rewrite exists to produce a sentence
 * the gateway accepts — and the remedy it triggers is a neutral HEAD, which on
 * assistant history is the persona line the model imitates (#297, measured).
 * `IDENTITY_CLAUSE` breaks the clause internally, which defeats the
 * anywhere-substring gate without adding a line anyone can copy.
 *
 * @module dsh-connect-workbuddy/tests/issue321-rewrite-keeps-break
 */
import { describe, expect, it } from 'vitest'
import { prepareChatBody } from '../src/upstream.ts'

const HEAD = 'You are a helpful assistant.'
const ZWSP = '\u200b'

function systemOf(messages: unknown[]): string {
  const body = JSON.parse(prepareChatBody(JSON.stringify({ messages }))) as { messages: { role: string, content: string }[] }
  return body.messages.find(message => message.role === 'system')?.content ?? ''
}

function assistantOf(messages: unknown[]): string {
  const body = JSON.parse(prepareChatBody(JSON.stringify({ messages }))) as { messages: { role: string, content: string }[] }
  return body.messages.find(message => message.role === 'assistant')?.content ?? ''
}

describe('issue #321: a rewritten identity clause keeps its internal break', () => {
  it('breaks the REPLACED wording in system, not only the original', () => {
    const system = systemOf([{ role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' }])
    // The replacement is broken, so no exact substring survives…
    expect(system, 'the replacement must carry the zero-width break').toContain(ZWSP)
    // …and the sentence the model reads is the rewrite, unchanged in meaning.
    expect(system.replace(/\u200b/gu, '')).toContain('You are an AI agent running inside the harness.')
  })

  it('breaks the replaced Web GUI wording too', () => {
    const system = systemOf([{ role: 'system', content: 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL is x.' }])
    expect(system).toContain(ZWSP)
    expect(system).not.toContain('You are working with the user inside the harness Web GUI')
  })

  it('does NOT give the replacement a neutral head — that is the #297 line', () => {
    // The decisive check: the fix must not have been implemented by adding the
    // replacement to the prefix list. A head here would mean the plugin now
    // declares its own output refused, and on an assistant turn it would plant
    // the persona line the model copies into its next reply.
    const system = systemOf([{ role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' }])
    expect(system.startsWith(HEAD)).toBe(false)
    const assistant = assistantOf([
      { role: 'system', content: 'ordinary' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'You are an AI agent powered by DeepSeek Harness.\n\nmy answer' },
    ])
    expect(assistant.startsWith(HEAD), 'assistant history must stay head-free (#297)').toBe(false)
    expect(assistant, 'but it must still be broken').toContain(ZWSP)
    expect(assistant).toContain('my answer')
  })
})

/**
 * The clause must match the sentences this plugin WRITES, and nothing else.
 *
 * Widening it to "any sentence containing `the harness`" was the first attempt
 * and it was wrong: `the harness` is ordinary English, so a model writing
 * "You are an agent running inside the harness of the test suite." would have
 * had its own words broken with zero-width characters. These are the measured
 * false positives from that attempt, kept as permanent negatives.
 */
describe('issue #321: the widened clause does not swallow ordinary prose', () => {
  const PROSE = [
    'You are an agent running inside the harness of the test suite.',
    'You are an agent running inside the harness directory.',
    'You are interacting with the user through the harness API.',
    'You are working with the user inside the harness room.',
    'The harness is documented in the README.',
  ]

  it.each(PROSE)('leaves %s untouched', (prose) => {
    const system = systemOf([{ role: 'system', content: prose }])
    expect(system, 'ordinary prose must not be broken').not.toContain(ZWSP)
    expect(system).toBe(prose)
  })

  it('still breaks the exact sentence the plugin writes', () => {
    // The other side of the same coin: tightening must not have disabled the fix.
    const system = systemOf([{ role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' }])
    expect(system).toContain(ZWSP)
  })
})

/**
 * TABLE-DRIVEN, so a future row cannot be half-covered the way row 2 was.
 *
 * The first version of this fix covered two of the three identity rows and
 * missed `You are a coding agent running on the …` — so the very failure mode
 * #321 describes (a rewrite that removes the protection it should work with)
 * survived on the row that `kimi-k3.1-pro` requests produce. Hard-coding the
 * rows covered would let that happen again, so this walks the table itself:
 * every `to` value that names an agent must carry a break.
 *
 * Rows whose replacement names no identity at all (the @-path paragraphs, the
 * `Agent Teams` line) are skipped BY SHAPE, not by index, so adding rows does
 * not silently weaken this test.
 */
describe('issue #321: every identity replacement carries a break', () => {
  it('breaks the row-2 replacement (the one a gemini/kimi request produces)', () => {
    // The specific miss: row 3's wording was covered, row 2's was not.
    const system = systemOf([{ role: 'system', content: 'You are a coding agent powered by the kimi-k3.1-pro model.' }])
    expect(system, 'row 2 must be broken like the others').toContain(ZWSP)
    expect(system.replace(/\u200b/gu, '')).toContain('running on the kimi-k3.1-pro model')
  })

  it.each([
    ['row 1 (identity)', 'You are an AI agent powered by DeepSeek Harness.'],
    ['row 2 (coding agent)', 'You are a coding agent powered by the qmodel_38max model.'],
    ['row 3 (Web GUI)', 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL is x.'],
  ])('%s is rewritten AND broken', (_label, original) => {
    const system = systemOf([{ role: 'system', content: original }])
    expect(system, 'the original must be gone').not.toContain(original)
    expect(system, 'the replacement must be broken').toContain(ZWSP)
    // And no head — the invariant #297 depends on.
    expect(system.startsWith(HEAD)).toBe(false)
  })
})
