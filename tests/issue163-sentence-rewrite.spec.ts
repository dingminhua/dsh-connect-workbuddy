/**
 * THE REWRITE LAYER FOR #163'S CONTENT FINGERPRINTS.
 *
 * The CN gateway refuses a request whose system/assistant text contains any of
 * the host's agent-identity phrases. Two reporters bisected the live gateway on
 * 2026-10-29 and measured that zero-width characters are normalized away, while
 * a real wording change answers 200. The third fingerprint is an eight-sentence
 * @-path paragraph: each sentence alone passes, the whole paragraph fails, so
 * the table rewrites it sentence by sentence rather than as one literal.
 *
 * The rewrite runs BEFORE `neutralizeChannelFingerprints`, because that pass
 * inserts U+200B inside the identity clause and would make `replaceAll` miss
 * the host's own wording (issue #163, owner's required order).
 *
 * @module dsh-connect-workbuddy/tests/issue163-sentence-rewrite
 */

import { describe, expect, it } from 'vitest'
import { prepareChatBody, rewriteChannelFingerprintPhrases } from '../src/upstream.ts'

const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
const CODING = 'You are a coding agent powered by the qmodel_38max model.'
const GUI = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.'
const AGENT_TEAMS = 'Agent Teams is available in this session.'
const TOKENS = [
  'Tokens prefixed with @ are paths the user explicitly referenced.',
  'Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.',
  'A trailing slash marks a directory: list it when its contents matter.',
  'Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading.',
  '@"..." quotes a path containing spaces.',
].join(' ')

/** A small stand-in for the real DSH system prompt: all three measured sites. */
const DSH_SYSTEM = [
  'You are an AI agent powered by DeepSeek Harness.',
  'You are a coding agent powered by the qmodel_38max model.',
  'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.',
  AGENT_TEAMS,
  TOKENS,
].join('\n\n')

function messagesOf(bodyJson: string): { role: string, content: unknown }[] {
  return (JSON.parse(bodyJson) as { messages: { role: string, content: unknown }[] }).messages
}

/**
 * Text with every zero-width break removed.
 *
 * The replacement wordings are now ALSO in the prefix list and the identity
 * clause (issue #321), so `prepareChatBody` gives them a neutral head and breaks
 * their identity clause at every word boundary — `You \u200bare \u200ban \u200bagent …`.
 * That IS the behaviour these tests want, so they compare the text the MODEL
 * reads rather than the exact bytes on the wire. Asserting the raw string here
 * would pin the pre-#321 defect: a rewritten sentence that got neither
 * protection.
 */
const plain = (text: string): string => text.replace(/\u200b/gu, '')

describe('the sentence-level rewrite table (issue #163)', () => {
  it('removes every measured fingerprint from a DSH-shaped prompt', () => {
    const rewritten = rewriteChannelFingerprintPhrases(DSH_SYSTEM)
    for (const span of [IDENTITY, CODING, GUI, AGENT_TEAMS, TOKENS]) {
      expect(rewritten).not.toContain(span)
    }
    // The rewrites are same-meaning; the model still reads the same rules.
    expect(rewritten).toContain('You are an AI agent running inside the harness.')
    expect(rewritten).toContain('You are a coding agent running on the qmodel_38max model.')
    expect(rewritten).toContain('You are working with the user inside the harness Web GUI')
    expect(rewritten).toContain('Agent Teams is enabled for this session.')
    expect(rewritten).toContain('Paths that begin with @ are the ones the user explicitly referenced.')
    expect(rewritten).toContain('Relative paths are resolved against the workspace root;')
    expect(rewritten).toContain('absolute paths point at files or directories on the host.')
    expect(rewritten).toContain('A trailing slash indicates a directory:')
    expect(rewritten).toContain('list it whenever its contents matter.')
    expect(rewritten).toContain('Everything else is a file:')
    expect(rewritten).toContain('use the read tool whenever you need its contents,')
    expect(rewritten).toContain('and never claim to have inspected it before reading it.')
    expect(rewritten).toContain('A path containing spaces is quoted with @"...".')
  })

  it('leaves an ordinary conversation byte-for-byte alone', () => {
    const ordinary = 'A perfectly ordinary sentence. And one more.'
    expect(rewriteChannelFingerprintPhrases(ordinary)).toBe(ordinary)
  })

  it('is idempotent', () => {
    const once = rewriteChannelFingerprintPhrases(DSH_SYSTEM)
    expect(rewriteChannelFingerprintPhrases(once)).toBe(once)
  })
})

describe('the rewrite is wired into prepareChatBody in the required order', () => {
  it('rewrites system and assistant text, and leaves user/tool alone', () => {
    const body = prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: DSH_SYSTEM },
        { role: 'user', content: TOKENS },
        { role: 'assistant', content: IDENTITY },
        { role: 'tool', content: TOKENS, tool_call_id: 'call_1' },
      ],
    }))
    const messages = messagesOf(body)
    expect(messages[0]?.content).toContain('Paths that begin with @')
    expect(messages[0]?.content).not.toContain('Tokens prefixed with @')
    expect(plain(String(messages[2]?.content))).toContain('running inside the harness')
    // The user's own words and a tool result are not the gate's business.
    expect(messages[1]?.content).toBe(TOKENS)
    expect(messages[3]?.content).toBe(TOKENS)
  })

  it('rewrites every text part of an array-shaped message', () => {
    const body = prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: GUI },
            { type: 'text', text: TOKENS },
          ],
        },
      ],
    }))
    const content = messagesOf(body)[0]?.content as { type: string, text: string }[]
    expect(plain(content[0]?.text ?? '')).toContain('working with the user inside')
    expect(content[1]?.text).toContain('Paths that begin with @')
    expect(content[1]?.text).not.toContain('Tokens prefixed with @')
  })

  // #164 bisected the live gateway further and reported the MINIMAL span that
  // triggers each paragraph: the @-path paragraph fails at its first 111 chars
  // (two sentences), the Web GUI paragraph at its first 221 (also two). Both
  // spans must be cleared by the table, or a host that ships only a truncated
  // version of the paragraph would still be refused.
  it('clears the minimal triggering spans measured in #164', () => {
    const atParagraphHead = 'Tokens prefixed with @ are paths the user explicitly referenced. '
      + 'Relative paths resolve from the workspace root;'
    const guiHead = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime '
      + 'context names. When the user refers to "this page", this GUI, or this app without naming '
      + 'another target, they mean this GUI.'
    expect(atParagraphHead.length).toBe(112)
    expect(guiHead.length).toBe(217)

    const atRewritten = rewriteChannelFingerprintPhrases(atParagraphHead)
    const guiRewritten = rewriteChannelFingerprintPhrases(guiHead)
    expect(atRewritten).not.toContain('Tokens prefixed with @')
    expect(atRewritten).not.toContain('Relative paths resolve from')
    expect(guiRewritten).not.toContain('You are interacting with the user through')
    // Still readable instructions: the rewrite changes wording, not meaning.
    expect(atRewritten).toContain('Paths that begin with @')
    expect(atRewritten).toContain('Relative paths are resolved against')
    expect(guiRewritten).toContain('working with the user inside')
    // The second GUI sentence USED to be asserted as left alone, on the belief
    // that it was not a fingerprint of its own. #167 disproved that against the
    // live gateway: the minimal failing window is `er target, they mean this
    // GUI.`, and rewriting the first sentence alone still answered 400. This
    // line now pins the CORRECT behaviour — both sentences must be gone.
    expect(guiRewritten).not.toContain('they mean this GUI.')
  })

  it('is a no-op on a body with no measured phrase', () => {
    const body = prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: 'An ordinary system prompt.' },
        { role: 'user', content: 'hi' },
      ],
    }))
    const messages = messagesOf(body)
    expect(messages[0]?.content).toBe('An ordinary system prompt.')
    expect(messages[1]?.content).toBe('hi')
  })
})

/**
 * ISSUE #319 — the rewrite must clear the BRAND, not just the verb.
 *
 * A real 5.31.8 sample: after `prepareChatBody`, a 10,761-char system still
 * carried two `DeepSeek Harness` tokens, and the gateway refused it anyway
 * while the plugin's own trace reported "all known fingerprints cleared".
 *
 * The two rows that leaked kept the product name in their `to` string
 * ("running inside DeepSeek Harness", "working with the user inside the
 * DeepSeek Harness Web GUI"). Neither `IDENTITY_CLAUSE` nor the prefix list
 * covers the REPLACED wording, so those tokens went out with no protection at
 * all — the weakest strings on the wire.
 *
 * These assertions are about the OUTCOME a reporter can verify — no brand left
 * on the wire — rather than about one chosen wording, so the `to` strings stay
 * free to change again without rewriting the test (the same downgrade #167
 * applied to the second GUI span).
 */
describe('issue #319: no product name survives the rewrite', () => {
  it('leaves no brand token when the rewritten rows are the only source of it', () => {
    const raw = JSON.stringify({
      messages: [{
        role: 'system',
        content: `${IDENTITY}\nA middle line.\n${GUI}\nThe runtime context names the DeepSeek Harness implementation checkout.`,
      }],
    })
    const system = (JSON.parse(prepareChatBody(raw)) as { messages: { content: string }[] }).messages[0]?.content ?? ''
    expect(system, 'the brand must not survive the rewrite').not.toContain('DeepSeek Harness')
    // The sentences are still there, and still say the same thing.
    expect(plain(system)).toContain('running inside the harness')
    expect(plain(system)).toContain('inside the harness Web GUI')
  })

  it('clears the brand in BOTH the identity row and the Web GUI row', () => {
    // Each row alone, so a regression in one is attributed to that row.
    for (const opening of [IDENTITY, GUI]) {
      const raw = JSON.stringify({ messages: [{ role: 'system', content: opening }] })
      const system = (JSON.parse(prepareChatBody(raw)) as { messages: { content: string }[] }).messages[0]?.content ?? ''
      expect(system, opening).not.toContain('DeepSeek Harness')
    }
  })
})
