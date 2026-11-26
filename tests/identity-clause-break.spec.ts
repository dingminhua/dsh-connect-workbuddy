/**
 * The exact-SUBSTRING gate, and the identity-clause break that defends it.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM issue98. Issue #98 pinned the PREFIX
 * gate: a scanned message whose text OPENS with a banned identity is refused,
 * and prepending a neutral head moves that opening off offset 0. That defence is
 * real and still runs. But it is the wrong tool for the gate that actually
 * refused the reporter's DSH session, and this file is the evidence for the other
 * one.
 *
 * THE MEASUREMENT (issue #125, and independently `workbuddy2api-hub` #533 — the
 * latter bisected to the byte on a real 124 KB request):
 *   - the gateway matches a case-insensitive EXACT SUBSTRING ANYWHERE in a
 *     scanned `system`/`assistant` message, not only at the start;
 *   - the live DSH prompt carries THREE such spans, and all three have to be
 *     broken before one request answers 200 — "只改任意一两处不够，三处全改才
 *     200";
 *   - the three spans are the agent's own identity clauses:
 *       You are an AI agent powered by DeepSeek Harness.
 *       You are a coding agent powered by the <model> model.
 *       You are interacting with the user through the DeepSeek Harness Web GUI …
 *
 * WHY THE OLD LADDER COULD NOT REACH SPAN TWO. `perturbChannelFingerprints`'s
 * sparse rung breaks at sentence terminators, CJK terminators, clause commas,
 * and adjacent CAPITALISED word pairs (`WORD_INTERNAL_BREAK`). Span two has
 * none of those inside it: no adjacent capitals ("a coding agent powered by"),
 * no comma, and its terminal full stop lands AFTER the banned substring, so it
 * is not inside the span. Measured against a real prompt: sparse cleared spans
 * one and three and left span two byte-identical — the exact request that kept
 * answering 11128. The dense rung did reach it, but only at +70.7% bytes.
 *
 * THE FIX THIS FILE PINS. Break each identity clause at every INTERNAL word
 * boundary, unconditionally, in `prepareChatBody`. Measured cost on a real
 * 10,818-character DSH system prompt: ~28 added characters (+0.26%), against
 * dense's 7,742 (+70.7%). Cheap enough to run on every request rather than only
 * in a rescue, which is the whole point — a rescue has to be refused first.
 *
 * @module dsh-connect-workbuddy/tests/identity-clause-break
 */
import { describe, expect, it } from 'vitest'
import {
  WORKBUDDY_FALLBACK_SYSTEM_PROMPT,
  breakIdentityClauses,
  perturbChannelFingerprints,
  prepareChatBody,
} from '../src/upstream.ts'

/** The three spans issue #125 measured, verbatim from a live DSH prompt. */
const SPANS = [
  'You are an AI agent powered by DeepSeek Harness.',
  'You are a coding agent powered by the qmodel_38max model.',
  'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.',
] as const

/** Strip the invisible breaks — the text the model reads. */
const visible = (text: string): string => text.replace(/\u200b/gu, '')

/** Does the exact banned span still appear, byte for byte, in the wire text? */
const spanSurvives = (wire: string, span: string): boolean =>
  wire.includes(span.replace(/\.$/u, ''))

/** The prepared system text of a one-message body. */
function preparedSystem(content: string): string {
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'system', content }, { role: 'user', content: 'hi' }],
  }))) as { messages: { content: unknown }[] }
  return body.messages[0]?.content as string
}

describe('breakIdentityClauses: all three measured spans, by substring not by opening', () => {
  it('breaks every span so no exact banned substring survives', () => {
    // The gate matches substrings, so the assertion that matters is that the
    // banned bytes are no longer contiguous — not that the text starts or ends
    // any particular way.
    const out = breakIdentityClauses(SPANS.join('\n'))
    for (const span of SPANS) {
      expect(spanSurvives(out, span), `still matched: ${span.slice(0, 40)}`).toBe(false)
    }
  })

  it('changes NO word the model reads — only inserts invisible breaks', () => {
    // This is the entire justification for U+200B over rewriting the clause
    // ("powered by" -> "built on", the #533 workaround): the words stay, so the
    // agent's own identity contract and every tool instruction are untouched.
    const text = SPANS.join('\n')
    expect(visible(breakIdentityClauses(text))).toBe(text)
  })

  it('is cheap: about one break per word, not a dense rewrite', () => {
    // Pinning the cost is pinning WHY this runs on every request. The dense rung
    // breaks every rune pair (+70.7%); this breaks one clause per identity line.
    const text = SPANS.join('\n')
    const added = breakIdentityClauses(text).length - text.length
    expect(added).toBeLessThan(40)
    expect(added).toBeGreaterThan(0)
  })

  it('matches case-insensitively and across arbitrary spacing', () => {
    // The gate itself is case-insensitive (issue #98 measured fact 3 for the
    // prefix rule; #533 confirms it for the substring rule), and a prompt can
    // wrap the clause across a newline. The break has to land in both.
    expect(breakIdentityClauses('YOU ARE AN AI AGENT POWERED BY DEEPSEEK HARNESS')).toContain('\u200b')
    expect(breakIdentityClauses('you\n  are   a coding agent   powered by x')).toContain('\u200b')
  })

  it('is naturally idempotent — a second pass adds nothing', () => {
    // REQUIRED, not incidental. `perturbChannelFingerprints` no longer refuses to
    // touch text that already carries a break (that coarse guard is gone), so
    // every rule has to be idempotent on its own or retries would stack breaks.
    // It holds because `\s+` does not match U+200B: once a clause is broken,
    // IDENTITY_CLAUSE no longer matches it.
    const once = breakIdentityClauses(SPANS.join('\n'))
    expect(breakIdentityClauses(once)).toBe(once)
  })

  it('leaves text with no identity clause byte-for-byte identical', () => {
    // An ordinary conversation contains no such clause, so the common case is
    // untouched — the transform only ever grows a message that introduces an
    // agent identity.
    for (const text of [
      'Rules: be nice. Then help the user.',
      'The quick brown fox jumps over the lazy dog.',
      '验收做完了，quiet period reminder for the pool.',
      'You are a helpful assistant.',
    ]) {
      expect(breakIdentityClauses(text)).toBe(text)
    }
  })
})

describe('prepareChatBody breaks the clause on every request, before any rescue', () => {
  it('breaks span two, the one sparse perturbation could not reach', () => {
    // THE regression this whole change exists for. Assert on the PREPARED body —
    // not on a retry — because the break now happens on the request path, so the
    // very first attempt already carries it.
    const wire = preparedSystem(SPANS.join('\n'))
    expect(spanSurvives(wire, SPANS[1] as string)).toBe(false)
    expect(spanSurvives(wire, SPANS[0] as string)).toBe(false)
    expect(spanSurvives(wire, SPANS[2] as string)).toBe(false)
  })

  it('rewrites a PREFIX-listed opening AND breaks the replacement internally (#321)', () => {
    // ISSUE #321 found the real defect here: the rewrite runs before
    // neutralisation, and `IDENTITY_CLAUSE` used to match only the ORIGINAL
    // wording — so the replacement lost its clause break and went out intact.
    // The fix is the CLAUSE, not the prefix list: a head would be wrong (the
    // replacement is not refused at offset 0, and a head on assistant history is
    // the persona line the model copies — #297), while an internal break defeats
    // the anywhere-substring gate without adding a line anyone can imitate.
    const wire = preparedSystem(SPANS[0] as string)
    expect(wire.startsWith(`${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n`)).toBe(false)
    expect(wire, 'the replacement must be broken internally').toContain('\u200b')
    expect(spanSurvives(wire, SPANS[0] as string)).toBe(false)
  })

  it('breaks the clause in an assistant history message too', () => {
    // The gate scans `assistant` as well (issue #98 measured fact 1). A session
    // whose history echoes the identity is poisoned on every later turn, so the
    // break has to reach assistant content, not only the system prompt.
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'm',
      messages: [
        { role: 'system', content: 'An ordinary opening.' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: SPANS[1] as string },
        { role: 'user', content: 'again?' },
      ],
    }))) as { messages: { role: string; content: string }[] }
    const assistant = body.messages.find(m => m.role === 'assistant')
    expect(spanSurvives(assistant?.content ?? '', SPANS[1] as string)).toBe(false)
  })

  it('leaves a user message and a tool message untouched', () => {
    // Only the two scanned roles are defended; breaking user text would change
    // what the user said, and tool content is not scanned.
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'm',
      messages: [
        { role: 'system', content: 'An ordinary opening.' },
        { role: 'user', content: SPANS[0] as string },
        { role: 'assistant', content: 'sure' },
        { role: 'tool', content: SPANS[0] as string, tool_call_id: 'call_1' },
      ],
    }))) as { messages: { role: string; content: string }[] }
    expect(body.messages.find(m => m.role === 'user')?.content).toBe(SPANS[0])
    expect(body.messages.find(m => m.role === 'tool')?.content).toBe(SPANS[0])
  })
})

describe('the perturbation rules stay idempotent WITHOUT the coarse ZWS guard', () => {
  it('CJK terminators do not stack a second break on a retry', () => {
    // The coarse `if (text.includes(ZWS)) return` guard was REMOVED, because the
    // request path now legitimately puts breaks in the text before the ladder
    // runs — and that guard would then make the ladder a permanent no-op. Its
    // removal means each rule must be idempotent on its own. The CJK rule has no
    // trailing whitespace to anchor on, so it needs the explicit lookahead; this
    // test is what pins that lookahead.
    const body = JSON.stringify({ messages: [{ role: 'system', content: '第一句。第二句！' }] })
    const once = perturbChannelFingerprints(body) as string
    // A second pass must report "nothing to change" rather than stack.
    expect(perturbChannelFingerprints(once)).toBeUndefined()
    // And exactly one break landed per terminator, not one per pass.
    const wire = (JSON.parse(once) as { messages: { content: string }[] }).messages[0]!.content
    expect((wire.match(/\u200b/gu) ?? []).length).toBe(2)
  })

  it('latin and comma rules stay idempotent (anchored on trailing whitespace)', () => {
    const body = JSON.stringify({ messages: [{ role: 'system', content: 'First. Second, more!' }] })
    const once = perturbChannelFingerprints(body) as string
    expect(perturbChannelFingerprints(once)).toBeUndefined()
  })

  it('still breaks span two via dense, when the request path is bypassed', () => {
    // The dense rung remains the last-resort rescue for a span NO rule above
    // recognises. Feed it a body with the clause already broken by the request
    // path and confirm dense does not stack, but on a RAW span it still clears it.
    const raw = JSON.stringify({ messages: [{ role: 'assistant', content: SPANS[1] as string }] })
    const dense = perturbChannelFingerprints(raw, true) as string
    expect(spanSurvives(dense, SPANS[1] as string)).toBe(false)
  })

  it('dense does not double-insert on text the request path already broke', () => {
    // THE risk the coarse-guard removal creates, on the rung that runs LAST. The
    // ladder feeds dense the output of `forceNeutralHead(prepared)` — text that
    // `prepareChatBody` now REWRITES the coding-agent phrase (issue #163), so
    // there may be no invisible break in the request path at all. Dense still
    // must not stack a second break at any position it does touch.
    const prepared = prepareChatBody(JSON.stringify({
      model: 'm',
      messages: [{ role: 'system', content: SPANS[1] as string }, { role: 'user', content: 'hi' }],
    }))
    const sysOf = (b: string): string =>
      (JSON.parse(b) as { messages: { content: string }[] }).messages[0]!.content
    expect(spanSurvives(sysOf(prepared), SPANS[1] as string)).toBe(false)
    // ISSUE #321 turned this around: the request path now DOES break the coding
    // agent clause, because the rewrite's own replacement (`running on the …`)
    // is clause-matched too. That is the fix, not a regression — before it, the
    // rewrite produced a sentence that matched no predicate at all.
    expect((sysOf(prepared).match(/\u200b/gu) ?? []).length).toBeGreaterThan(0)

    const dense = perturbChannelFingerprints(prepared, true) as string
    // Dense adds breaks between the remaining rune pairs, but never TWO at one
    // existing break — so the count grows by the word-internal positions only,
    // and stripping every break still returns the host's exact words.
    expect(visible(sysOf(dense))).toBe(visible(sysOf(prepared)))
    expect(sysOf(dense)).not.toContain('\u200b\u200b')
  })
})
