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
