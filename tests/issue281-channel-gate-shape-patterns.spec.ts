/**
 * Issue #281 — the literal channel-gate rewrite table cannot cover third-party
 * coding CLIs' self-introduction lines, and freezes one wording per row.
 *
 * A third-party CLI writes its own identity into `system` (grok, codex and
 * claude were all captured doing so). The plugin cannot edit their prompts, so
 * the only lever is the outbound rewrite in `rewriteChannelFingerprintPhrases`.
 * With a literal table alone, any version bump, verb swap, product rename or
 * preposition change slips past silently: the scrub returns the input unchanged,
 * the request goes out, and a single `assistant` history message poisons every
 * later turn of the session (400 / 11128, `channel_reject`).
 *
 * The fix adds a SHAPE table that locks the pattern (identity clause + creator
 * verb + known vendor) rather than the exact words. These tests pin three
 * things the reporter insisted on, each with a matrix:
 *   1. versioned / verb-swapped / renamed forms MUST be rewritten (the bug);
 *   2. ordinary prose that merely MENTIONS a vendor MUST pass through (no
 *      over-matching that would mutate a user's words);
 *   3. a rewrite MUST consume the whole sentence — no broken tail such as
 *      `You are an autonomous coding agent's Claude Agent SDK is the runtime.`
 *
 * All phrases below are invented from the reported SHAPES; none is a capture
 * of a real account, device or session.
 *
 * @module dsh-connect-workbuddy/tests/issue281-channel-gate-shape-patterns
 */

import { describe, expect, it } from 'vitest'
import { prepareChatBody, rewriteChannelFingerprintPhrases } from '../src/upstream.ts'

const NEUTRAL = 'You are an autonomous coding agent.'

/** Identities that MUST be neutralised: versioned, verb-swapped, renamed. */
const HIT_MATRIX: readonly string[] = [
  'You are Grok 4.6 released by xAI.',
  'You are Grok 5.0 released by xAI. Claude Agent SDK is the runtime.',
  'You are Grok 6 built by xAI.',
  'You are Grok made by xAI.',
  'You are Grok from xAI',
  'You are an AI assistant created by xAI.',
  'You are the Grok 4.6 model, released by xAI. Extra tail here.',
  'You are Claude 2.1 powered by Anthropic.',
  'You are Claude 2.1.327 built by Anthropic.',
  'You are GPT-5.3-Codex trained by OpenAI.',
  'You are an assistant built on Google DeepMind.',
  'You are a helper made by Mistral.',
  '  You are Claude 4.6 made by Anthropic.',
]

/** Ordinary text that merely mentions a vendor — every byte must survive. */
const PASS_MATRIX: readonly string[] = [
  'The product X released by Y in 2023 was notable.',
  'You are working on a project about Grok.',
  'xAI released Grok 4.6 in 2024.',
  'You are here to help with coding tasks.',
  'Grok was built by xAI.',
  NEUTRAL,
  'As you are an assistant made by Mistral, please continue.',
]

describe('shape-locked channel gate rewrites (issue #281)', () => {
  it('rewrites every vendor identity shape, including version numbers and verb swaps', () => {
    for (const text of HIT_MATRIX) {
      const rewritten = rewriteChannelFingerprintPhrases(text)
      expect(rewritten, `must neutralise: ${text}`).not.toBe(text)
      expect(rewritten, `must use the neutral wording: ${text}`).toContain('You are an autonomous coding agent')
    }
  })

  it('leaves prose that merely mentions a vendor byte-for-byte alone', () => {
    for (const text of PASS_MATRIX) {
      expect(rewriteChannelFingerprintPhrases(text), `must pass through: ${text}`).toBe(text)
    }
  })

  it('consumes the whole sentence and never leaves a broken tail', () => {
    for (const text of HIT_MATRIX) {
      const rewritten = rewriteChannelFingerprintPhrases(text)
      expect(rewritten, `no dangling possessive: ${text}`).not.toMatch(/agent's\b/u)
      // The broken form glued the remainder of the identity sentence onto the
      // replacement as a possessive ("agent's Claude Agent SDK ..."). A clean
      // rewrite either has no tail or starts a fresh sentence after a period.
      expect(rewritten, `no torn tail: ${text}`).not.toMatch(/agent(?:'s|\s+[A-Za-z]+\s+Agent SDK)/u)
    }
  })

  it('keeps the trailing sentence intact after a rewritten opening', () => {
    // The reporter's exact failure: stopping at the vendor name produced
    // `agent's Claude Agent SDK ...`. The whole identity sentence must go, and
    // the following sentence must start clean.
    const input = 'You are Grok 5.0 released by xAI. Claude Agent SDK is the runtime.'
    expect(rewriteChannelFingerprintPhrases(input)).toBe(`${NEUTRAL} Claude Agent SDK is the runtime.`)
  })

  it('is idempotent over the whole hit matrix', () => {
    for (const text of HIT_MATRIX) {
      const once = rewriteChannelFingerprintPhrases(text)
      expect(rewriteChannelFingerprintPhrases(once), `second pass must be a no-op: ${text}`).toBe(once)
    }
  })
})

describe('shape rewrites are wired into prepareChatBody on scanned roles', () => {
  const identity = 'You are Grok 5.0 released by xAI. Claude Agent SDK is the runtime.'

  it('rewrites system and assistant text, but not user or tool text', () => {
    const body = prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: identity },
        { role: 'user', content: identity },
        { role: 'assistant', content: identity },
        { role: 'tool', content: identity, tool_call_id: 'call_1' },
      ],
    }))
    const messages = (JSON.parse(body) as { messages: { content: unknown }[] }).messages
    expect(messages[0]?.content).toContain(NEUTRAL)
    expect(messages[1]?.content).toBe(identity)
    expect(messages[2]?.content).toContain(NEUTRAL)
    expect(messages[3]?.content).toBe(identity)
  })

  it('rewrites each text part of an array-shaped message', () => {
    const body = prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: identity },
            { type: 'text', text: PASS_MATRIX[1] },
          ],
        },
      ],
    }))
    const content = (JSON.parse(body) as { messages: { content: { text: string }[] }[] }).messages[0]?.content
    expect(content?.[0]?.text).toContain(NEUTRAL)
    expect(content?.[1]?.text).toBe(PASS_MATRIX[1])
  })
})
