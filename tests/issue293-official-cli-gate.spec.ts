/**
 * ISSUE #293 — Claude Code's own head is a KNOWN blocked phrase with no
 * rewrite row, so every request carrying the full Claude Code system context
 * dies with `400 / 11128 channel_reject` even after the whole rescue ladder.
 *
 * THE EVIDENCE (issue #293 comment, code-level, read-only investigation):
 *
 * - `UNAPPROVED_CHANNEL_OPENINGS` ALREADY contains the exact Claude Code head
 *   (`you are claude code, anthropic's official cli for claude`), measured
 *   400/11128 on BOTH gateways. So it is not an unknown phrase — it is a
 *   measured blacklist entry.
 * - But `CHANNEL_GATE_PATTERNS` (the rewrite table) locked only IDENTITY +
 *   a CREATOR VERB (`released|made|built|created|…`) + vendor. Claude Code's
 *   wording says `Anthropic's official CLI for Claude` — NO creator verb —
 *   so neither pattern row matched. A regex probe on the exact sentence
 *   returned `False` for both.
 * - `forceNeutralHead` cannot help: the gate matches as an EXACT SUBSTRING
 *   ANYWHERE (#125/#533), so moving the opening off offset 0 leaves the banned
 *   span intact one line lower.
 * - Neither perturbation rung reaches the middle: only the two commas carry
 *   a `([,;])\s+` breakpoint, and #167 measured that the upstream normalises
 *   zero-width spaces before the substring match. So dense perturbation is
 *   useless here too.
 *
 * THE FIX: a THIRD shape row locking `X's official CLI for Y`. These tests
 * pin the measured sentence, the shape's variants, pass-through prose, whole
 * sentence consumption, idempotence, and the wiring into `prepareChatBody`
 * on scanned roles.
 *
 * All identity strings below are invented from the reported SHAPES; none is
 * a capture of a real account, device or session.
 *
 * @module dsh-connect-workbuddy/tests/issue293-official-cli-gate
 */
import { describe, expect, it } from 'vitest'
import { prepareChatBody, rewriteChannelFingerprintPhrases } from '../src/upstream.ts'

const NEUTRAL = 'You are an autonomous coding agent.'

/** The measured shape: product, vendor possessive, "official CLI for" product. */
const HIT_MATRIX: readonly string[] = [
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are Grok CLI, xAI's official CLI for xAI, here to help.",
  "  You are GPT CLI, OpenAI's official CLI for Codex.",
]

/** Ordinary prose that merely mentions a vendor — every byte must survive. */
const PASS_MATRIX: readonly string[] = [
  'The product X released by Y in 2023 was notable.',
  'You are working on a project about Grok.',
  'xAI released Grok 4.6 in 2024.',
  NEUTRAL,
  'As you are an assistant made by Mistral, please continue.',
  'You are Claude Code, a helpful coding assistant.',
]

describe('official-CLI shape rewrites (issue #293)', () => {
  it('rewrites the measured Claude Code head and its shape variants', () => {
    for (const text of HIT_MATRIX) {
      const rewritten = rewriteChannelFingerprintPhrases(text)
      expect(rewritten, `must neutralise: ${text}`).not.toBe(text)
      // The banned substring must be GONE, not merely moved behind a head.
      expect(rewritten.toLowerCase(), `banned phrase survived: ${text}`)
        .not.toContain("anthropic's official cli for claude")
      expect(rewritten, `must use the neutral wording: ${text}`).toContain(NEUTRAL)
    }
  })

  it('leaves prose that merely mentions a CLI byte-for-byte alone', () => {
    for (const text of PASS_MATRIX) {
      expect(rewriteChannelFingerprintPhrases(text), `must pass through: ${text}`).toBe(text)
    }
  })

  it('consumes the whole identity sentence, leaving no torn tail', () => {
    // The tail runs to the first full stop, which here is the sentence's own
    // final period — the `running within … SDK.` clause is part of the same
    // sentence (comma-separated), so the whole line is replaced. What matters
    // is no torn `agent's …` fragment and no surviving banned substring.
    const input = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
    const out = rewriteChannelFingerprintPhrases(input)
    expect(out).toBe(NEUTRAL)
    expect(out).not.toMatch(/agent's\b/u)
    expect(out.toLowerCase()).not.toContain('official cli for claude')
  })

  it('is idempotent over the whole hit matrix', () => {
    for (const text of HIT_MATRIX) {
      const once = rewriteChannelFingerprintPhrases(text)
      expect(rewriteChannelFingerprintPhrases(once), `second pass must be a no-op: ${text}`).toBe(once)
    }
  })
})

describe('official-CLI rewrite is wired into prepareChatBody on scanned roles', () => {
  const identity = "You are Claude Code, Anthropic's official CLI for Claude."

  it('rewrites system and assistant text but not user or tool text', () => {
    const body = prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: identity },
        { role: 'assistant', content: identity },
        { role: 'user', content: identity },
        { role: 'tool', content: identity },
      ],
    }))
    const parsed = JSON.parse(body) as { messages: { role: string, content: string }[] }
    expect(parsed.messages[0]?.content).toContain(NEUTRAL)
    expect(parsed.messages[1]?.content).toContain(NEUTRAL)
    expect(parsed.messages[2]?.content).toBe(identity)
    expect(parsed.messages[3]?.content).toBe(identity)
  })
})
