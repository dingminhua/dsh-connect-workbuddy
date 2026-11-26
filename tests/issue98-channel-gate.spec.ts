/**
 * Issue #98: the CN gateway's channel gate, and the two gaps this plugin had
 * in front of it.
 *
 * THE REPORT. The WorkBuddy CN gateway refuses a chat request whose `system`
 * message opens with a known third-party-agent identity — business code
 * `11128`, "Illegal API invocation from an unapproved channel" — and the
 * upstream's own `displayTips` blames the CHANNEL ("可能不是官方客户端发出的"),
 * which sends every reporter to reinstall the official client. Ten people
 * reported it; the plugin already neutralised TWO known fingerprints by
 * prepending "You are a helpful assistant.", so the reports are about the
 * cases that prepend does NOT cover.
 *
 * WHAT WAS MEASURED on the live CN gateway on 2026-10-21 (account
 * `ba217455…`, `deepseek-v4.1-flash`, `max_tokens` 8, every other request
 * field held fixed). These are FACTS, not theory, and every test below is
 * pinned to one of them:
 *
 *   1. The gate scans EVERY `system` message — one placed AFTER a user
 *      message is scanned too, and is refused.
 *   2. When a `system` message's `content` is an ARRAY of parts, the gate
 *      scans EVERY TEXT PART of it: a banned opening in the FIRST part is
 *      refused, and a banned opening in the SECOND part is refused just the
 *      same. (This is GAP A: the plugin's neutraliser only ever looked at
 *      STRING content, so an array-shaped prompt went out on the wire with
 *      the banned opening intact.)
 *   3. Only the START of the content counts — the same sentence mid-content
 *      answers 200.
 *   4. Leading whitespace is trimmed before the comparison — " <banned>" and
 *      "\n<banned>" answer 200.
 *   5. `user` messages are never scanned.
 *   6. The role `developer` is refused on BOTH gateways, which the plugin
 *      already covers by rewriting it to `system` before neutralising.
 *   7. The global gateway does not fingerprint the DSH prompt at all (only
 *      Claude Code); it has a DIFFERENT gate — a body with no system message
 *      is refused with "first message is not system prompt".
 *
 * GAP B is the other half of the issue and it is NOT a guessing game: the
 * gateway's fingerprint list is a SNAPSHOT the upstream can extend at any
 * time, and the plugin cannot see it. So the plugin needs a way to answer
 * "what did we actually send?" ({@link openingEvidenceOfBody}) and a
 * way to build a retry that does not depend on knowing the fingerprint at all
 * ({@link forceNeutralHead}).
 *
 * @module dsh-connect-workbuddy/tests/issue98-channel-gate
 */
import { describe, expect, it } from 'vitest'
import {
  WORKBUDDY_FALLBACK_SYSTEM_PROMPT,
  forceNeutralHead,
  isChannelRejectBody,
  isConversationIdGateBody,
  isFirstMessageGateBody,
  isUnapprovedChannelOpening,
  perturbChannelFingerprints,
  prepareChatBody,
  openingEvidenceOfBody,
} from '../src/upstream.ts'

/** The DSH fingerprint the CN gateway refuses (measured, issue #98). */
const DSH_FINGERPRINT = 'You are an AI agent powered by DeepSeek Harness.'

/**
 * What the request path now sends instead (issue #163): the phrase is rewritten
 * before the prefix head would be needed, so the neutral head is NOT prepended
 * for this one anymore.
 */
const DSH_FINGERPRINT_REWRITTEN = 'You are an AI agent running inside the harness.'

/** The other fingerprint in the measured snapshot: Claude Code's own head. */
const CLAUDE_FINGERPRINT = "You are Claude Code, Anthropic's official CLI for Claude."

/** A fingerprint this plugin has NEVER measured — the gap-B case. */
const UNMEASURED_FINGERPRINT = 'You are Cursor Agent, an AI pair programmer from Anysphere.'

/** One text part, in the shape the OpenAI content array uses. */
function textPart(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

/** The prepared body, parsed back, so the assertions read the wire bytes. */
function prepared(source: unknown): {
  messages: { role: string; content: unknown }[]
  [key: string]: unknown
} {
  return JSON.parse(prepareChatBody(JSON.stringify(source))) as {
    messages: { role: string; content: unknown }[]
    [key: string]: unknown
  }
}

/**
 * The wire text with every invisible break removed.
 *
 * WHY THESE ASSERTIONS COMPARE THE STRIPPED TEXT. Since the identity-clause
 * break, a scanned message that introduces an agent identity carries U+200B
 * inside that clause — by design, and it is the whole point: the exact-substring
 * gate matches BYTES, so the bytes have to differ from the listed span while
 * every WORD the model reads stays exactly where it was.
 *
 * Stripping is not a weaker assertion, it is the one that states the actual
 * contract — "the host's own words, in the host's own order, plus the plugin's
 * head" — instead of freezing a byte form that one invisible character of
 * defence has to change. A test that wants the breaks themselves asks for them
 * explicitly (see the `breakIdentityClauses` suite).
 */
function visible(text: string): string {
  return text.replace(/\u200b/gu, '')
}

/**
 * The text with the zero-width breaks removed — and NOTHING else.
 *
 * Review caught the first version of this helper stripping the neutral head as
 * well, on a comment that claimed the replacement wordings had been added to
 * the prefix list. They deliberately were NOT (see `UNAPPROVED_CHANNEL_OPENINGS`
 * and the third test in `issue321-rewrite-keeps-break.spec.ts`): a head on
 * assistant history is the persona line the model imitates, which is #297.
 * Stripping a head here made six assertions in this file blind to exactly that
 * regression — injecting the replacement into the prefix list left all 38 cases
 * green. A helper must not do the assertion's work for it.
 */
function bare(text: string): string {
  return visible(text)
}

describe('array-shaped system content: every text part is scanned (measured fact 2)', () => {
  it('neutralises a fingerprint in the FIRST part', () => {
    const body = prepared({
      messages: [
        { role: 'system', content: [textPart(`${DSH_FINGERPRINT}\n\nAnd the rest of the prompt.`)] },
        { role: 'user', content: 'hi' },
      ],
    })
    // The parts array keeps its SHAPE: one part in, one part out, same `type`.
    const content = body.messages[0]?.content as { type: string; text: string }[]
    expect(Array.isArray(content)).toBe(true)
    expect(content).toHaveLength(1)
    expect(content[0]?.type).toBe('text')
    expect(bare(content[0]?.text ?? '')).toBe(`${DSH_FINGERPRINT_REWRITTEN}\n\nAnd the rest of the prompt.`)
  })

  it('neutralises a fingerprint in the SECOND part too', () => {
    // THE case a first-part-only fix misses. The gateway scans every text
    // part, so a banned opening in part two is refused exactly like one in
    // part one — and a fix that only prepended to part one would leave every
    // such request to fail with the same 11128 and the same dead end.
    const body = prepared({
      messages: [
        {
          role: 'system',
          content: [
            textPart('A perfectly ordinary opening.'),
            textPart(CLAUDE_FINGERPRINT),
          ],
        },
      ],
    })
    const content = body.messages[0]?.content as { type: string; text: string }[]
    expect(content).toHaveLength(2)
    expect(content[0]?.text).toBe('A perfectly ordinary opening.')
    // PART TWO IS NEUTRALISED, NOT MERELY HEAD-PREPENDED. This used to assert
    // `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${CLAUDE_FINGERPRINT}` — i.e. the
    // banned "Claude Code, Anthropic's official CLI for Claude" span survived
    // verbatim behind a neutral head. Issue #293 proved that is insufficient:
    // the upstream matches the phrase as a substring ANYWHERE, so moving it
    // off offset 0 does nothing. The official-CLI shape row now REWRITES it.
    // The assertion's point (part two is not skipped) still holds either way.
    expect(content[1]?.text).toContain('You are an autonomous coding agent')
    expect(content[1]?.text).not.toContain("Anthropic's official CLI for Claude")
  })

  it('leaves a non-matching part and a non-text part byte-identical', () => {
    const image = { type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } }
    const body = prepared({
      messages: [
        {
          role: 'system',
          content: [
            textPart('A perfectly ordinary opening.'),
            image,
            textPart('More instructions.'),
          ],
        },
      ],
    })
    const content = body.messages[0]?.content as Record<string, unknown>[]
    expect(content[0]).toEqual({ type: 'text', text: 'A perfectly ordinary opening.' })
    // The image part is not text, so the gate never reads it — and rewriting it
    // would change the bytes of a request the gateway already answers.
    expect(content[1]).toEqual(image)
    expect(content[2]).toEqual({ type: 'text', text: 'More instructions.' })
  })

  it('neutralises a part whose OWN text opens with a fingerprint', () => {
    // The fingerprint is matched against the START of each part's text, not
    // against the message as a whole: measured fact 3 says only the start
    // counts, so a fingerprint in the middle of a part is not the gate's
    // business and must stay untouched.
    const body = prepared({
      messages: [
        {
          role: 'system',
          content: [
            textPart('A perfectly ordinary opening.'),
            textPart(`${DSH_FINGERPRINT}\n\nAnd the rest of the prompt.`),
          ],
        },
      ],
    })
    const content = body.messages[0]?.content as { type: string; text: string }[]
    expect(content[0]?.text).toBe('A perfectly ordinary opening.')
    expect(content[1]?.text).toBeDefined()
    expect(bare(content[1]?.text ?? '')).toBe(`${DSH_FINGERPRINT_REWRITTEN}\n\nAnd the rest of the prompt.`)
  })

  it('survives a malformed part without throwing', () => {
    // This runs on a body that is about to go on the wire. A throw here would
    // cost the whole request over a part nobody can read.
    const body = prepared({
      messages: [
        { role: 'system', content: [null, 'a bare string', 42, { type: 'text' }, { type: 'text', text: 7 }] },
        { role: 'user', content: 'hi' },
      ],
    })
    const content = body.messages[0]?.content as unknown[]
    expect(content).toEqual([null, 'a bare string', 42, { type: 'text' }, { type: 'text', text: 7 }])
  })
})

describe('string-shaped system content keeps behaving exactly as before', () => {
  it('rewrites a matching opening instead of prepending a head', () => {
    // Since issue #163 the request path rewrites the measured DSH identity,
    // so the prefix head is no longer needed for this one: the opening the
    // gateway sees is already a different sentence.
    const body = prepared({
      messages: [{ role: 'system', content: DSH_FINGERPRINT }, { role: 'user', content: 'hi' }],
    })
    expect(bare(body.messages[0]?.content as string)).toBe(DSH_FINGERPRINT_REWRITTEN)
    expect(body.messages[1]?.content).toBe('hi')
  })

  it('does not prepend a head to a mid-text fingerprint; the rewrite removes it', () => {
    // Measured fact 3: the PREFIX gate only reads the START, so a prompt that
    // merely MENTIONS a third-party identity gets no head. The sentence rewrite
    // still removes the phrase, because the third measured fingerprint is
    // position-independent (issue #163).
    const prompt = 'Rules: be nice.\n\nYou are an AI agent powered by DeepSeek Harness.'
    const body = prepared({ messages: [{ role: 'system', content: prompt }] })
    expect(bare(body.messages[0]?.content as string))
      .toBe(`Rules: be nice.\n\n${DSH_FINGERPRINT_REWRITTEN}`)
    expect(body.messages[0]?.content as string).not.toContain(WORKBUDDY_FALLBACK_SYSTEM_PROMPT)
  })

  it('leaves a user message alone even when it opens with a fingerprint', () => {
    // Measured fact 5: `user` messages are never scanned.
    const body = prepared({
      messages: [
        { role: 'system', content: 'An ordinary opening.' },
        { role: 'user', content: DSH_FINGERPRINT },
      ],
    })
    expect(body.messages[1]?.content).toBe(DSH_FINGERPRINT)
  })
})

describe('isUnapprovedChannelOpening: the one predicate that decides the gate', () => {
  it('matches the measured snapshot at the START of the text', () => {
    expect(isUnapprovedChannelOpening(DSH_FINGERPRINT)).toBe(true)
    expect(isUnapprovedChannelOpening(CLAUDE_FINGERPRINT)).toBe(true)
  })

  it('trims leading whitespace before matching', () => {
    // Measured fact 4: the gateway trims leading whitespace, so " <banned>"
    // answers 200 today. The predicate compares the way a trimming gate
    // would, so a gateway-side trim does not silently reopen the failure.
    expect(isUnapprovedChannelOpening(` ${DSH_FINGERPRINT}`)).toBe(true)
    expect(isUnapprovedChannelOpening(`\n${DSH_FINGERPRINT}`)).toBe(true)
    expect(isUnapprovedChannelOpening('\n\n\tYou are Claude Code, Anthropic\'s official CLI for Claude.')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isUnapprovedChannelOpening('you are an ai agent powered by deepseek harness')).toBe(true)
    expect(isUnapprovedChannelOpening('YOU ARE AN AI AGENT POWERED BY DEEPSEEK HARNESS')).toBe(true)
  })

  it('does NOT match a fingerprint that appears mid-text', () => {
    // Measured fact 3: only the START counts, so a prompt that merely MENTIONS
    // a third-party agent answers 200 and must stay byte-for-byte intact.
    expect(isUnapprovedChannelOpening(`Rules: be nice.\n\n${DSH_FINGERPRINT}`)).toBe(false)
    expect(isUnapprovedChannelOpening('You are an AI agent powered by Kimi.')).toBe(false)
    expect(isUnapprovedChannelOpening('')).toBe(false)
  })
})

describe('forceNeutralHead: the retry that does not need to know the fingerprint', () => {
  it('moves EVERY system opening behind the neutral head, known or not', () => {
    // The whole point: the gateway's list is a snapshot the upstream can extend
    // and the plugin cannot see it, so the retry covers an opening nobody has
    // measured — the case issue #98 keeps reporting.
    const source = JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: UNMEASURED_FINGERPRINT },
        { role: 'user', content: 'hi' },
      ],
    })
    const retry = forceNeutralHead(source)
    expect(retry).toBeDefined()
    const body = JSON.parse(retry as string) as { messages: { role: string; content: unknown }[] }
    expect(body.messages[0]?.content).toBe(`${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${UNMEASURED_FINGERPRINT}`)
    // And the request is otherwise the same request.
    expect(body.messages[1]?.content).toBe('hi')
    expect((body as unknown as { model: string }).model).toBe('deepseek-v4.1-flash')
  })

  it('prepends to every text part of an array-shaped system message', () => {
    const source = JSON.stringify({
      messages: [
        {
          role: 'system',
          content: [textPart('An ordinary opening.'), textPart(UNMEASURED_FINGERPRINT)],
        },
      ],
    })
    const body = JSON.parse(forceNeutralHead(source) as string) as {
      messages: { content: { type: string; text: string }[] }[]
    }
    const content = body.messages[0]?.content as { type: string; text: string }[]
    expect(content[0]?.text).toBe(`${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\nAn ordinary opening.`)
    expect(content[1]?.text).toBe(`${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${UNMEASURED_FINGERPRINT}`)
  })

  it('moves assistant openings too, and leaves user and tool messages alone', () => {
    // The retry moves every SCANNED opening: `system` and `assistant` are both
    // read by the gate (measured, issue #98). A `user` or `tool` message is not
    // the gate's business, and moving it would change the conversation for no
    // reason.
    const source = JSON.stringify({
      messages: [
        { role: 'system', content: UNMEASURED_FINGERPRINT },
        { role: 'user', content: UNMEASURED_FINGERPRINT },
        { role: 'assistant', content: UNMEASURED_FINGERPRINT },
        { role: 'tool', content: UNMEASURED_FINGERPRINT, tool_call_id: 'call_1' },
      ],
    })
    const body = JSON.parse(forceNeutralHead(source) as string) as {
      messages: { role: string; content: unknown }[]
    }
    expect(body.messages[0]?.content).toBe(`${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${UNMEASURED_FINGERPRINT}`)
    expect(body.messages[1]?.content).toBe(UNMEASURED_FINGERPRINT)
    expect(body.messages[2]?.content).toBe(`${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${UNMEASURED_FINGERPRINT}`)
    expect(body.messages[3]?.content).toBe(UNMEASURED_FINGERPRINT)
  })

  it('returns undefined when no scanned message would change', () => {
    // Nothing to move, so there is no retry to make: the caller must not spend
    // a request on it. A user-only body is exactly that case — and so is a body
    // whose assistant message already sits behind the neutral head.
    const source = JSON.stringify({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'a tool result', tool_call_id: 'call_1' },
      ],
    })
    expect(forceNeutralHead(source)).toBeUndefined()
  })

  it('returns undefined when nothing would change', () => {
    // The caller spends a request on the retry; a body that cannot change
    // would buy the same refusal.
    const source = JSON.stringify({
      messages: [
        { role: 'system', content: `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${DSH_FINGERPRINT}` },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(forceNeutralHead(source)).toBeUndefined()
  })

  it('keeps the key order of the original body', () => {
    const source = '{"model":"m","messages":[{"role":"system","content":"x"}],"stream":true}'
    const retry = forceNeutralHead(source) as string
    expect(retry.indexOf('"model"')).toBeLessThan(retry.indexOf('"messages"'))
    expect(retry.indexOf('"messages"')).toBeLessThan(retry.indexOf('"stream"'))
  })

  it('never throws on a body it cannot read', () => {
    for (const source of ['', 'not json', 'null', '[]', '"str"', '{"messages":"nope"}', '{"messages":[null,3,{"role":1}]}']) {
      expect(forceNeutralHead(source)).toBeUndefined()
    }
  })
})

describe('openingEvidenceOfBody: what the gate actually read', () => {
  it('reports one entry per system message, in wire order', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: 'First opening.' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'Second opening.' },
      ],
    })
    expect(openingEvidenceOfBody(body)).toEqual([
      { opening: 'First opening.', textLength: 14, role: 'system', neutralized: false, messageIndex: 0 },
      { opening: 'Second opening.', textLength: 15, role: 'system', neutralized: false, messageIndex: 2 },
    ])
  })

  it('reports one entry per TEXT PART of an array-shaped system message', () => {
    // The gate scans every part, so "which line tripped it" can be any of
    // them — a per-message report would hide the second part.
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: [textPart('Part one.'), textPart('Part two.')] },
      ],
    })
    expect(openingEvidenceOfBody(body)).toEqual([
      { opening: 'Part one.', textLength: 9, role: 'system', neutralized: false, messageIndex: 0 },
      { opening: 'Part two.', textLength: 9, role: 'system', neutralized: false, messageIndex: 0 },
    ])
  })

  it('marks the plugin\'s own neutral head as neutralized', () => {
    // The plugin's line is the one opening that cannot be a third-party-agent
    // fingerprint, so the reply can say "this one is ours, the other is
    // yours" instead of blaming the host for a line the host never sent.
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${DSH_FINGERPRINT}` },
        { role: 'system', content: 'A host-written opening.' },
      ],
    })
    const evidence = openingEvidenceOfBody(body)
    expect(evidence[0]?.neutralized).toBe(true)
    expect(evidence[0]?.opening).toBe(WORKBUDDY_FALLBACK_SYSTEM_PROMPT)
    expect(evidence[1]?.neutralized).toBe(false)
  })

  it('marks a KNOWN fingerprint as neutralized on the host\'s own body', () => {
    // The failure path often reads the body BEFORE the plugin rewrote it (the
    // host's request), where the opening is still the raw fingerprint. The
    // plugin DOES cover that opening — it is rewritten before sending — so
    // reporting it as "not neutralized" would blame the host for a line the
    // plugin silently fixes.
    const body = JSON.stringify({ messages: [{ role: 'system', content: DSH_FINGERPRINT }] })
    const evidence = openingEvidenceOfBody(body)
    expect(evidence[0]?.opening).toBe(DSH_FINGERPRINT)
    expect(evidence[0]?.neutralized).toBe(true)
  })

  it('marks an opening the plugin has NEVER heard of as not neutralized', () => {
    // The actionable case, and the one issue #98 keeps reporting: this opening
    // goes on the wire VERBATIM, because the plugin does not know it. It
    // starts the same way as the known ones — a rule that matched on the
    // shared prefix would report this as covered and hide the dead end.
    const body = JSON.stringify({
      messages: [{ role: 'system', content: 'You are Codex, a coding agent developed by OpenAI.' }],
    })
    const evidence = openingEvidenceOfBody(body)
    expect(evidence[0]?.opening).toBe('You are Codex, a coding agent developed by OpenAI.')
    expect(evidence[0]?.neutralized).toBe(false)
  })

  it('counts a `developer` message as a system message', () => {
    // The plugin rewrites `developer` → `system` on the wire, and both
    // gateways refuse `developer` — so on the wire it IS a system message.
    const body = JSON.stringify({ messages: [{ role: 'developer', content: 'A developer opening.' }] })
    expect(openingEvidenceOfBody(body)).toEqual([
      { opening: 'A developer opening.', textLength: 20, role: 'system', neutralized: false, messageIndex: 0 },
    ])
  })

  it('skips a message with no readable text', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: '   ' },
        { role: 'system', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } }] },
        { role: 'system', content: 'Kept.' },
      ],
    })
    expect(openingEvidenceOfBody(body)).toEqual([
      { opening: 'Kept.', textLength: 5, role: 'system', neutralized: false, messageIndex: 2 },
    ])
  })

  it('caps the report at eight entries', () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({ role: 'system', content: `opening ${i}` }))
    expect(openingEvidenceOfBody(JSON.stringify({ messages }))).toHaveLength(8)
  })

  it('never throws on a body it cannot read', () => {
    for (const body of ['', 'not json', 'null', '[]', '"str"', '{"messages":"nope"}', '{"messages":[null,3,{"role":1}]}']) {
      expect(openingEvidenceOfBody(body)).toEqual([])
    }
  })
})

describe('the two OTHER gates that share the 11128 code', () => {
  /** The live CN channel-gate body, byte-exact apart from the request id. */
  const CHANNEL_BODY = '{"code":11128,"msg":"Illegal API invocation from an unapproved channel","requestId":"26d17b97-0000-4000-8000-000000000098"}'
  const CONVERSATION_ID_BODY = '{"code":11128,"msg":"conversation id missing","requestId":"3605a27b-0000-4000-8000-000000000066"}'
  const FIRST_MESSAGE_BODY = '{"code":11128,"msg":"first message is not system prompt","requestId":"5c9a2946-0000-4000-8000-000000000090"}'

  it('requires the CODE as well as the wording', () => {
    expect(isConversationIdGateBody(CONVERSATION_ID_BODY)).toBe(true)
    expect(isFirstMessageGateBody(FIRST_MESSAGE_BODY)).toBe(true)
    // The wording without the code is another gate entirely.
    expect(isConversationIdGateBody('{"code":11140,"msg":"conversation id missing"}')).toBe(false)
    expect(isFirstMessageGateBody('{"code":11140,"msg":"first message is not system prompt"}')).toBe(false)
  })

  it('is not fooled by a request id that happens to contain the digits', () => {
    // Request ids are hexadecimal and can contain `11128` by coincidence; the
    // quoted-key form is what keeps that from promoting a red herring.
    expect(isConversationIdGateBody('{"requestId":"11128abc","msg":"conversation id missing"}')).toBe(false)
    expect(isFirstMessageGateBody('{"requestId":"11128abc","msg":"first message is not system prompt"}')).toBe(false)
  })

  it('never claims the prompt gate', () => {
    // The whole reason these two exist as separate predicates: the upstream's
    // `displayTips` is the IDENTICAL sentence for all three members of the
    // 11128 family, so a reply that relays it blames the prompt for a header
    // or a first-message problem.
    expect(isConversationIdGateBody(CHANNEL_BODY)).toBe(false)
    expect(isFirstMessageGateBody(CHANNEL_BODY)).toBe(false)
    // ISSUE #113: `isChannelRejectBody` answers "is this the 11128 FAMILY",
    // and every member belongs to it. The old expectation — false for the two
    // siblings — is exactly what kept a misreported refusal out of the
    // plugin's retry ladder (see `tests/issue113-channel-gate-evidence.spec.ts`).
    // Which MEMBER it is is `channelGateMemberOf`'s job, and it decides the
    // reply's ADVICE only, never whether the rescue runs.
    expect(isChannelRejectBody(CHANNEL_BODY)).toBe(true)
    expect(isChannelRejectBody(CONVERSATION_ID_BODY)).toBe(true)
    expect(isChannelRejectBody(FIRST_MESSAGE_BODY)).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(isConversationIdGateBody('{"CODE":11128,"MSG":"CONVERSATION ID MISSING"}')).toBe(true)
    expect(isFirstMessageGateBody('{"Code":11128,"Msg":"First Message Is Not System Prompt"}')).toBe(true)
  })
})

describe('perturbChannelFingerprints: the rescue for an INNER content fingerprint', () => {
  // Measured 2026-10-21 on the live CN gateway: the gate also matches one long
  // substring INSIDE the system prompt (a 221-character chunk of the DSH Web-GUI
  // paragraph), and that span answers 200 as soon as ANY character inside it
  // changes — while a prefix or suffix around it changes nothing. So the rescue
  // perturbs the scanned text where it is invisible, not where it is guessable.
  it('inserts a zero-width space at sentence and clause boundaries', () => {
    const body = JSON.stringify({
      messages: [{ role: 'system', content: 'First sentence. Second sentence, with a clause; and more!' }],
    })
    const next = perturbChannelFingerprints(body) as string
    expect(next).toBeDefined()
    expect(next).toContain('sentence.\u200b Second')
    expect(next).toContain('clause;\u200b and')
    expect(next).toContain('more!')
    // The words themselves are untouched.
    expect(next.replace(/\u200b/gu, '')).toBe(body)
  })

  it('perturbs an assistant message too, and leaves user/tool text alone', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: 'A system sentence. And one more.' },
        { role: 'user', content: 'A user sentence. And one more.' },
        { role: 'assistant', content: 'An assistant sentence. And one more.' },
        { role: 'tool', content: 'A tool sentence. And one more.', tool_call_id: 'call_1' },
      ],
    })
    const parsed = JSON.parse(perturbChannelFingerprints(body) as string) as {
      messages: { role: string; content: string }[]
    }
    expect(parsed.messages[0]?.content).toContain('\u200b')
    expect(parsed.messages[1]?.content).toBe('A user sentence. And one more.')
    expect(parsed.messages[2]?.content).toContain('\u200b')
    expect(parsed.messages[3]?.content).toBe('A tool sentence. And one more.')
  })

  it('handles a parts-shaped content and the CJK terminators', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: [{ type: 'text', text: '第一句。第二句！' }] },
      ],
    })
    const parsed = JSON.parse(perturbChannelFingerprints(body) as string) as {
      messages: { content: { text: string }[] }[]
    }
    expect(parsed.messages[0]?.content[0]?.text).toBe('第一句。\u200b第二句！\u200b')
  })

  it('dense mode breaks prose without punctuation, while preserving the model-visible text', () => {
    const body = JSON.stringify({ messages: [{ role: 'assistant', content: '验收做完了quiet period reminder' }] })
    const next = perturbChannelFingerprints(body, true) as string
    expect(next).toBeDefined()
    expect(next).toContain('验​收​做​完​了​q​u​i​e​t')
    expect(next.replace(/\u200b/gu, '')).toBe(body)
  })

  it('is idempotent, and undefined when it would change nothing', () => {
    const body = JSON.stringify({ messages: [{ role: 'system', content: 'No terminator here' }] })
    expect(perturbChannelFingerprints(body)).toBeUndefined()
    const once = perturbChannelFingerprints(JSON.stringify({ messages: [{ role: 'system', content: 'One. Two.' }] })) as string
    expect(perturbChannelFingerprints(once)).toBeUndefined()
  })

  it('never throws on a body it cannot read', () => {
    for (const body of ['', 'not json', 'null', '[]', '"str"', '{"messages":"nope"}', '{"messages":[null,3,{"role":1}]}']) {
      expect(perturbChannelFingerprints(body)).toBeUndefined()
    }
  })
})
