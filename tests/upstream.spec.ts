import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyWireIdentity } from '../src/upstream.ts'
import {
  WorkBuddyUpstreamClient,
  WORKBUDDY_FALLBACK_SYSTEM_PROMPT,
  classifyUpstreamError,
  declaredTools,
  parseCreditMultiplier,
  parseReasoning,
  parseUpstreamErrorDetail,
  parseUpstreamModel,
  prepareChatBody,
  regionOf,
  rewriteSessionTitleModel,
  globalBase,
  isUndecodablePolicyBody,
  selectCliModels,
} from '../src/upstream.ts'

const POLICY_REJECT_BODY = JSON.stringify({
  code: 11140,
  msg: 'request illegal',
  requestId: '3498bf50-98a9-4746-962e-c14016b8c578',
  displayMsg: {
    en: 'The content did not pass the safety review. Please adjust and retry.',
    zh: '内容未通过安全审核，请调整后重试。',
  },
  actions: ['SUBMIT_FEEDBACK', 'COPY_ERROR', 'EDIT_INPUT'],
})

/**
 * The wire text with every invisible break removed.
 *
 * `prepareChatBody` now breaks an agent identity clause at each of its internal
 * word boundaries, which is the defence against the gateway's exact-SUBSTRING
 * match (a different gate from the prefix one, and the one issue #125 measured
 * as the real refusal). Every WORD survives in its own order, so these
 * assertions compare the stripped text: that is the contract, and pinning the
 * byte form would freeze the very change the defence is.
 */
function visible(text: string): string {
  return text.replace(/\u200b/gu, '')
}

describe('prepareChatBody', () => {
  it('forces streaming and flattens object tool_choice', () => {
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'glm-5.3',
      stream: false,
      tool_choice: { type: 'function', function: { name: 'read' } },
    }))) as Record<string, unknown>
    expect(prepared['stream']).toBe(true)
    expect(prepared['tool_choice']).toBe('read')
  })

  it('normalizes DSH developer messages to WorkBuddy system messages', () => {
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'developer', content: 'system prompt' },
        { role: 'user', content: 'hello' },
      ],
    }))) as { messages: { role: string; content: string }[] }
    expect(prepared.messages.map(message => message.role)).toEqual(['system', 'user'])
  })

  it('drops tools when tool_choice is none', () => {
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: 'none',
      tools: [{ type: 'function', function: { name: 'read' } }],
    }))) as Record<string, unknown>
    expect(prepared['tool_choice']).toBeUndefined()
    expect(prepared['tools']).toBeUndefined()
  })

  it('prepends the fallback system message when the body opens with a user turn', () => {
    // The international gateway refuses a user-first body with business code
    // 11128, which it surfaces as "blocked by security policy"; the domestic one
    // tolerates it. A system message can vanish before this module ever sees the
    // body (pi-ai emits a prompt only `if (context.systemPrompt)`, and demotes a
    // `system` entry left in `messages` to `user`), so the head is checked here.
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'still here' },
      ],
    }))) as { messages: { role: string; content: unknown }[] }
    expect(prepared.messages.map(message => message.role)).toEqual(['system', 'user', 'user'])
    expect(prepared.messages[0]?.content).toBe(WORKBUDDY_FALLBACK_SYSTEM_PROMPT)
    expect(prepared.messages[1]?.content).toBe('hello')
  })

  it('leaves an already system-first body alone', () => {
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'system', content: 'the real prompt' },
        { role: 'user', content: 'hello' },
      ],
    }))) as { messages: { role: string; content: unknown }[] }
    expect(prepared.messages).toHaveLength(2)
    expect(prepared.messages[0]?.content).toBe('the real prompt')
  })

  it('adds no system message when the body carries no history', () => {
    // Nothing to repair, and inventing a turn for a body with no conversation
    // would change requests this rule is not about.
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({ messages: [] }))) as { messages: unknown[] }
    expect(prepared.messages).toEqual([])
    const noMessages = JSON.parse(prepareChatBody(JSON.stringify({ model: 'glm-5.3' }))) as Record<string, unknown>
    expect(noMessages['messages']).toBeUndefined()
  })

  it('passes non-JSON bodies through untouched', () => {
    expect(prepareChatBody('not json')).toBe('not json')
  })

  it('rewrites a system prompt that opens with a fingerprinted agent head', () => {
    // Measured on the real gateways (2026-10-21): a `system` message beginning
    // with "You are an AI agent powered by DeepSeek Harness" is refused by the
    // domestic gateway with business code 11128 ("unapproved channel").
    // Issue #163 superseded the prepend for this one: the sentence is rewritten,
    // so the gateway sees a different opening and no head is needed.
    const prompt = 'You are an AI agent powered by DeepSeek Harness.\n\nSecond line.'
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: 'hello' },
      ],
    }))) as { messages: { role: string; content: unknown }[] }
    expect(prepared.messages).toHaveLength(2)
    expect(prepared.messages[0]?.content).not.toContain(WORKBUDDY_FALLBACK_SYSTEM_PROMPT)
    expect(visible(prepared.messages[0]?.content as string))
      .toBe('You are an AI agent running inside DeepSeek Harness.\n\nSecond line.')
    expect(prepared.messages[1]?.content).toBe('hello')
  })

  it('matches the fingerprint case-insensitively and after leading whitespace', () => {
    // The gate compares case-insensitively today, and a leading space happens to
    // defeat it; both spellings of the same head must be treated alike so a
    // gateway-side trim or case fold does not silently reopen the failure.
    const prompt = '  you are an AI agent powered by deepseek harness'
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'system', content: prompt }],
    }))) as { messages: { content: string }[] }
    expect(visible(prepared.messages[0]?.content ?? '')).toBe(`${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${prompt}`)
  })

  it('adds NO neutral head for a fingerprint that is not at the start of the prompt', () => {
    // THE PREFIX GATE reads the opening only (measured 2026-10-21), so a
    // mid-text mention earns no head — and prepending one would be a lie about
    // which gate objected.
    //
    // WHAT CHANGED, AND WHY THIS TEST USED TO SAY THE OPPOSITE. It used to
    // assert the whole text stayed byte-for-byte intact, on the reading that a
    // mid-text mention "passes upstream". Issue #125 disproved that reading: the
    // gateway ALSO matches an exact substring ANYWHERE in a scanned message, and
    // three such spans in the live DSH prompt had to be broken before one request
    // answered 200 ("只改任意一两处不够，三处全改才 200"). So the mid-text
    // clause IS now broken — by the substring defence, not by the head. This
    // assertion keeps the half that is still true (no head) and leaves the
    // breaking to the identity-clause suite, which pins it directly.
    const prompt = 'Rules: be nice.\n\nYou are an AI agent powered by DeepSeek Harness.'
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'system', content: prompt }],
    }))) as { messages: { content: string }[] }
    expect(prepared.messages[0]?.content).not.toContain(WORKBUDDY_FALLBACK_SYSTEM_PROMPT)
    // The sentence rewrite still removes the mid-text phrase (issue #163).
    expect(visible(prepared.messages[0]?.content ?? ''))
      .toBe('Rules: be nice.\n\nYou are an AI agent running inside DeepSeek Harness.')
  })

  it('neutralizes every system message, not just the head', () => {
    // DSH can send a second system message (a tool-catalog update arrives as
    // `developer` and is rewritten above), and the gate scans each message: a
    // fingerprint below the head fails the request even when the head is benign.
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'system', content: 'the real prompt' },
        { role: 'developer', content: "You are Claude Code, Anthropic's official CLI for Claude." },
      ],
    }))) as { messages: { content: string }[] }
    expect(prepared.messages[0]?.content).toBe('the real prompt')
    expect(prepared.messages[1]?.content)
      .toBe(`${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\nYou are Claude Code, Anthropic's official CLI for Claude.`)
  })
})

describe('classifyUpstreamError', () => {
  it('maps credit exhaustion from Chinese markers', () => {
    expect(classifyUpstreamError(400, '积分不足')).toBe('hard_credit')
  })

  it('maps dead sessions ahead of generic client errors', () => {
    expect(classifyUpstreamError(400, 'Offline user session not found')).toBe('session_dead')
  })

  it('maps rate limits and server faults', () => {
    expect(classifyUpstreamError(429, '')).toBe('soft_rate')
    expect(classifyUpstreamError(503, '')).toBe('server')
    expect(classifyUpstreamError(404, '')).toBe('not_found')
  })

  it('maps the 11140 policy rejection ahead of generic client errors', () => {
    expect(classifyUpstreamError(403, POLICY_REJECT_BODY)).toBe('policy_reject')
    expect(classifyUpstreamError(403, '{"code":11140,"msg":"request illegal"}')).toBe('policy_reject')
  })

  it('does not classify the 11128 channel gate as a policy rejection (issue #127)', () => {
    // Both bodies reuse `msg: "request illegal"`; only the CODE tells them apart.
    const channel = '{"code":11128,"msg":"request illegal","displayMsg":{"zh":"请求被拦截，请重新发送"}}'
    expect(classifyUpstreamError(400, channel)).toBe('channel_reject')
  })

  it('splits an upstream account restriction from the content-policy family (issue #127)', () => {
    const restricted = '{"code":11140,"msg":"request illegal","displayMsg":{"zh":"账号存在异常行为，已被限制使用"}}'
    const restrictedEn = '{"code":11140,"msg":"request illegal","displayMsg":{"en":"Your account has been restricted due to unusual activity"}}'
    expect(classifyUpstreamError(403, restricted)).toBe('account_restricted')
    expect(classifyUpstreamError(403, restrictedEn)).toBe('account_restricted')
  })

  it('requires the 11140 code before benching an account, whatever else the body says (issue #127)', () => {
    // The restriction verdict is the heaviest in the classifier: it fails over AND
    // benches the account with NO cooldown, so only a re-authorisation returns it.
    // The phrase alone must never reach it. The EXPECTED values below are the
    // v5.7.0 baseline, read off the real classifier rather than from the marker
    // lists: 5.7.0 had no phrase check at all, so each of these fell through to
    // its own verdict, and that is exactly where it must still land. A body that
    // merely MENTIONS the sentence under a credit / auth / busy / generic status is
    // about something else entirely. Before the code half was required, every one
    // of these returned `account_restricted` — one passing 500 that happened to
    // contain the words would have taken an account permanently out of the pool.
    const phrase = '账号存在异常行为，已被限制使用'
    const en = 'restricted due to unusual activity'
    const cases: [string, number, string, string][] = [
      ['11128 + phrase', 400, `{"code":11128,"msg":"unapproved channel","displayMsg":{"zh":"${phrase}"}}`, 'channel_reject'],
      ['402 credit + phrase', 402, `{"code":14018,"msg":"Credits exhausted","displayMsg":{"zh":"${phrase}"}}`, 'hard_credit'],
      ['401 token + phrase', 401, `{"code":401,"msg":"token invalid","displayMsg":{"zh":"${phrase}"}}`, 'client'],
      ['429 busy + phrase', 429, `{"code":14003,"msg":"too many requests","displayMsg":{"zh":"${phrase}"}}`, 'model_busy'],
      ['500 + english phrase', 500, `{"error":"internal","detail":"${en}, retry later"}`, 'server'],
      ['400 + phrase, no code', 400, `{"error":"gateway","detail":"${phrase}"}`, 'client'],
    ]
    for (const [label, status, body, expected] of cases) {
      expect(classifyUpstreamError(status, body), label).toBe(expected)
    }
  })

  it('still benches a 11140 restriction carried on any status', () => {
    // The code half is the requirement, not the HTTP status: the same restriction
    // has been observed on 400 and 403, and a status-keyed rule would miss it.
    const body = '{"code":11140,"msg":"request illegal","displayMsg":{"zh":"账号存在异常行为，已被限制使用"}}'
    for (const status of [400, 401, 403]) {
      expect(classifyUpstreamError(status, body), `status=${status}`).toBe('account_restricted')
    }
  })

  it('flags the one 11140 shape in which a restriction would be silently missed', () => {
    // THE ANOMALY WORTH A LOG. isAccountRestrictedBody needs the code AND a phrase
    // in the display fields. If the upstream ever renames those fields or moves
    // the wording, every restriction degrades to policy_reject with no signal —
    // so a 11140 that decodes to NO display text at all is reported, while the
    // everyday shapes stay silent.
    // Anomalous: code present, nothing decodable from any display field.
    // The nested envelope is the realistic miss — businessCodeOf reads the code
    // through error.data.code, but the verdict text only reads top-level fields.
    expect(isUndecodablePolicyBody('{"code":11140}')).toBe(true)
    expect(isUndecodablePolicyBody('{"error":{"data":{"code":11140,"displayMsg":{"zh":"账号存在异常行为，已被限制使用"}}}}')).toBe(true)
    // Everyday policy refusal: fields present, phrase just not the restriction.
    expect(isUndecodablePolicyBody('{"code":11140,"msg":"request illegal"}')).toBe(false)
    expect(isUndecodablePolicyBody(
      '{"code":11140,"msg":"request illegal","displayMsg":{"zh":"模型无法处理此请求"}}',
    )).toBe(false)
    // A restriction body decodes fine and must NOT be flagged.
    expect(isUndecodablePolicyBody(
      '{"code":11140,"msg":"request illegal","displayMsg":{"zh":"账号存在异常行为，已被限制使用"}}',
    )).toBe(false)
    // Not a 11140 body at all.
    expect(isUndecodablePolicyBody('{"code":11128,"msg":"unapproved channel"}')).toBe(false)
    expect(isUndecodablePolicyBody('not json at all')).toBe(false)
  })

  it('reads the business code from the envelope, not from one JSON spelling (issue #127 review)', async () => {
    // Each of these was measured FAILING after the bare `request illegal` marker
    // was dropped: the policy answer then depended on the compact text
    // `"code":11140`, so a space, a string code or a nested envelope matched
    // nothing, fell through to `client`, and `outcomeOfFailure(403, …)` reported
    // `credential-rejected` — a HEALTHY account marked as signed out. The verdict
    // is read from the parsed field now, so the spelling cannot decide it.
    const bodies = [
      ['compact', '{"code":11140,"msg":"request illegal"}'],
      ['spaced', '{"code": 11140,"msg":"request illegal"}'],
      ['string code', '{"code":"11140","msg":"request illegal"}'],
      ['nested error.data', '{"error":{"data":{"code":11140,"msg":"request illegal"}}}'],
      ['pretty-printed', '{\n  "code": 11140,\n  "msg": "request illegal"\n}'],
    ] as const
    for (const [label, body] of bodies) {
      expect(classifyUpstreamError(403, body), label).toBe('policy_reject')
    }
    // The inverse: the digits must not be found in an UNRELATED field either. A
    // request id is hexadecimal and can contain `11140` by coincidence — the
    // reason the original marker used the quoted-key form at all. Reading the
    // parsed `code` field keeps that protection without depending on spacing.
    expect(classifyUpstreamError(429, '{"code":6004,"requestId":"aabb11140ccdd","msg":"usage exceeds frequency limit"}')).toBe('soft_rate')
    expect(classifyUpstreamError(403, '{"code":6004,"requestId":"11140"}')).not.toBe('policy_reject')

    const { outcomeOfFailure } = await import('../src/probe.ts')
    for (const [label, body] of bodies) {
      expect(outcomeOfFailure(403, body), label).not.toBe('credential-rejected')
    }
  })

  it('matches the restriction sentence through escapes and line breaks (issue #127 review)', () => {
    // A proxy or re-serializer that escapes non-ASCII (Python's json.dumps
    // default) writes 账号… as \u8d26…, which a raw-text scan never matches; a
    // line break inside the English sentence survives as `\n` for the same
    // reason. Both silently downgraded a real restriction to a content refusal.
    const escaped = '{"code":11140,"displayMsg":{"zh":"'
      + '\\u8d26\\u53f7\\u5b58\\u5728\\u5f02\\u5e38\\u884c\\u4e3a\\uff0c\\u5df2\\u88ab\\u9650\\u5236\\u4f7f\\u7528"}}'
    expect(classifyUpstreamError(403, escaped)).toBe('account_restricted')
    const broken = '{"code":11140,"displayMsg":{"en":"restricted due to\\nunusual activity"}}'
    expect(classifyUpstreamError(403, broken)).toBe('account_restricted')
    const zeroWidth = '{"code":11140,"displayMsg":{"zh":"账号存在\\u200b异常行为，已被限制使用"}}'
    expect(classifyUpstreamError(403, zeroWidth)).toBe('account_restricted')
  })

  it('keeps a risk-control throttle with restriction wording OFF the bench (issue #127 review)', () => {
    // 6004 says "temporarily restricted due to unusual activity, retry later":
    // the SAME English sentence as the account bench, on a failure that is
    // explicitly temporary. Text alone would have benched the account for good.
    const throttle = '{"code":6004,"msg":"Your account was temporarily restricted due to unusual activity. Please retry later."}'
    expect(classifyUpstreamError(429, throttle)).toBe('soft_rate')
    expect(classifyUpstreamError(403, '<html>restricted due to unusual activity</html>')).toBe('client')
  })

  it('keeps a benign 403 a generic client error', () => {
    expect(classifyUpstreamError(403, 'forbidden')).toBe('client')
  })
})

describe('prepareChatBody keepPromptLast (issue #132)', () => {
  const injected = (text: string) => ({ role: 'user', content: text })
  const real = (text: string) => ({ role: 'user', content: text })

  /** Parse a prepared body back into its message list. */
  function messagesOf(body: string): { role: string, content: unknown }[] {
    return (JSON.parse(body) as { messages: { role: string, content: unknown }[] }).messages
  }

  it('leaves the order untouched when the option is off (the default)', () => {
    const source = JSON.stringify({
      messages: [
        { role: 'system', content: 'prompt' },
        real('推荐几个菜谱'),
        injected('Current runtime context.\n\nTime sampled while preparing turn 3, step 1'),
      ],
    })
    const prepared = messagesOf(prepareChatBody(source))
    expect(prepared.map(message => message.role)).toEqual(['system', 'user', 'user'])
    expect(String(prepared[1]?.content)).toBe('推荐几个菜谱')
  })

  it('moves the injected blocks above the real prompt so the usage page records what was typed', () => {
    // The upstream fills the usage 请求 column from the LAST user message, so the
    // harness's appended runtime context is what appeared there instead of the
    // user's own sentence.
    const source = JSON.stringify({
      messages: [
        { role: 'system', content: 'prompt' },
        real('推荐几个菜谱'),
        injected('Time sampled while preparing turn 3, step 1: 2026-10-24T02:00:00+08:00'),
        injected('Current runtime context.\n\nWorking directory: /tmp'),
      ],
    })
    const prepared = messagesOf(prepareChatBody(source, { keepPromptLast: true }))
    expect(prepared).toHaveLength(4)
    // The real prompt is now LAST, and it is the only non-injected user message.
    expect(String(prepared.at(-1)?.content)).toBe('推荐几个菜谱')
    // Nothing was dropped or rewritten: the same four messages survive.
    expect(prepared.map(message => String(message.content))).toEqual([
      'prompt',
      'Time sampled while preparing turn 3, step 1: 2026-10-24T02:00:00+08:00',
      'Current runtime context.\n\nWorking directory: /tmp',
      '推荐几个菜谱',
    ])
  })

  it('recognises the system-reminder and acp-prefixed shapes', () => {
    const source = JSON.stringify({
      messages: [
        { role: 'system', content: 'prompt' },
        real('真实输入'),
        injected('<acp x=\"1\">m00012</acp> <system-reminder>\n注意\n</system-reminder>'),
      ],
    })
    const prepared = messagesOf(prepareChatBody(source, { keepPromptLast: true }))
    expect(String(prepared.at(-1)?.content)).toBe('真实输入')
  })

  it('recognises the composite shape the CURRENT harness really sends (live sample, trimmed)', () => {
    // Taken from a live DSH session (truncated, not composed by hand): the time sample and
    // the LDVH verdict arrive in ONE `user` message, the verdict below the time
    // line. Matching this shape is what keeps the option from silently decaying
    // into "matches nothing" when the harness adds a second block per turn.
    const source = JSON.stringify({
      messages: [
        { role: 'system', content: 'prompt' },
        real('继续'),
        injected('Time sampled while preparing turn 12, step 1: 2026-10-24T03:25:18+08:00[Asia/Shanghai]\n'
          + 'Browser time zone for this request: Asia/Shanghai.\n\n'
          + '【LDVH 管辖判定】not_governed —— 本会话不受 LDVH 管辖，LDVH 工具不注册。\n'
          + '原因：session working directory is not inside a registered governed project'),
      ],
    })
    const prepared = messagesOf(prepareChatBody(source, { keepPromptLast: true }))
    expect(String(prepared.at(-1)?.content)).toBe('继续')
    expect(prepared).toHaveLength(3)
  })

  it('does NOT reorder a conversation whose trailing user message is a real turn', () => {
    // This is the risk the option carries, so it is pinned: another client's
    // ordinary conversation must keep its order byte-for-byte.
    const source = JSON.stringify({
      messages: [
        { role: 'system', content: 'prompt' },
        real('first question'),
        { role: 'assistant', content: 'answer' },
        real('follow-up question'),
      ],
    })
    const before = messagesOf(prepareChatBody(source)).map(message => String(message.content))
    const after = messagesOf(prepareChatBody(source, { keepPromptLast: true }))
      .map(message => String(message.content))
    expect(after).toEqual(before)
  })

  it('keeps the leading system message first, which both gateways require', () => {
    const source = JSON.stringify({
      messages: [
        { role: 'system', content: 'prompt' },
        real('hi'),
        injected('Current runtime context.'),
      ],
    })
    const prepared = messagesOf(prepareChatBody(source, { keepPromptLast: true }))
    expect(prepared[0]?.role).toBe('system')
  })

  it('removes the leading per-message marker from the recorded prompt only', () => {
    // Without this the usage column still opens with `<acp …>m00042</acp>`, which
    // is the half of #132's report that ordering alone does not fix.
    const source = JSON.stringify({
      messages: [
        { role: 'system', content: 'prompt' },
        { role: 'user', content: '<acp id="a">m00001</acp>\n上一条真实输入' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: '<acp id="b">m00042</acp>推荐几个菜谱' },
        { role: 'user', content: 'Current runtime context.\n\nWorking directory: /tmp' },
      ],
    })
    const prepared = messagesOf(prepareChatBody(source, { keepPromptLast: true }))
    const last = prepared.at(-1)
    expect(String(last?.content)).toBe('推荐几个菜谱')
    // The EARLIER message keeps its marker: only the recorded one is rewritten.
    const earlier = prepared.find(message => String(message.content).includes('上一条真实输入'))
    expect(String(earlier?.content)).toBe('<acp id="a">m00001</acp>\n上一条真实输入')
    // The assistant turn is untouched too.
    expect(String(prepared.find(message => message.role === 'assistant')?.content)).toBe('answer')
  })

  it('strips the marker from array-shaped prompt content in its first text part', () => {
    const source = JSON.stringify({
      messages: [
        { role: 'system', content: 'prompt' },
        { role: 'user', content: [{ type: 'text', text: '<acp id="b">m00042</acp>真实输入' }] },
        { role: 'user', content: 'Time sampled while preparing turn 2, step 3: now' },
      ],
    })
    const prepared = messagesOf(prepareChatBody(source, { keepPromptLast: true }))
    const content = prepared.at(-1)?.content as { type: string, text: string }[]
    expect(content[0]?.text).toBe('真实输入')
  })

  it('leaves the prompt untouched when there is nothing injected to move', () => {
    // The rewrite is tied to the reorder, not to the option being on: a turn with
    // no injected tail must not lose its marker, or the option would silently
    // delete content from ordinary conversations too.
    const source = JSON.stringify({
      messages: [
        { role: 'system', content: 'prompt' },
        { role: 'user', content: '<acp id="b">m00042</acp>真实输入' },
      ],
    })
    const prepared = messagesOf(prepareChatBody(source, { keepPromptLast: true }))
    expect(String(prepared[1]?.content)).toBe('<acp id="b">m00042</acp>真实输入')
  })

  it('handles array-shaped content without stringifying objects', () => {
    const source = JSON.stringify({
      messages: [
        { role: 'system', content: 'prompt' },
        real('真实输入'),
        { role: 'user', content: [{ type: 'text', text: 'Current runtime context.\nmore' }] },
      ],
    })
    const prepared = messagesOf(prepareChatBody(source, { keepPromptLast: true }))
    expect(String(prepared.at(-1)?.content)).toBe('真实输入')
  })

  it('recognises the two billion-context injection shapes from issue #133', () => {
    // Measured by the #133 reporter: the compression plugin injects its record
    // and its efficiency note as `user` messages, and without these prefixes the
    // usage page recorded them as the prompt.
    for (const injectedText of [
      '[Compressed conversation section]\n(压缩摘要正文)',
      'This is an efficiency nudge to keep responses concise.',
      '<acp id="c">m00077</acp>[Compressed conversation section]\n摘要',
    ]) {
      const source = JSON.stringify({
        messages: [
          { role: 'system', content: 'prompt' },
          real('推荐几个菜谱'),
          injected(injectedText),
        ],
      })
      const prepared = messagesOf(prepareChatBody(source, { keepPromptLast: true }))
      expect(String(prepared.at(-1)?.content)).toBe('推荐几个菜谱')
      expect(prepared).toHaveLength(3)
    }
  })

  it('treats configured extra prefixes as injected context (issue #133)', () => {
    const source = JSON.stringify({
      messages: [
        { role: 'system', content: 'prompt' },
        real('真实输入'),
        injected('SOME-NEW-PLUGIN-CONTEXT:\n未来某插件注入的内容'),
      ],
    })
    const prepared = messagesOf(prepareChatBody(source, {
      keepPromptLast: true,
      extraInjectedPrefixes: ['SOME-NEW-PLUGIN-CONTEXT:'],
    }))
    expect(String(prepared.at(-1)?.content)).toBe('真实输入')
    expect(prepared).toHaveLength(3)
    // A literal prefix is matched literally: regex metacharacters in the config
    // must not widen the match.
    const tricky = messagesOf(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'system', content: 'prompt' },
        real('真实输入'),
        injected('a[b( c) 看起来像正则的注入'),
      ],
    }), { keepPromptLast: true, extraInjectedPrefixes: ['a[b( c)'] }))
    expect(String(tricky.at(-1)?.content)).toBe('真实输入')
  })

  it('ignores empty or non-string extra prefix entries', () => {
    const source = JSON.stringify({
      messages: [
        { role: 'system', content: 'prompt' },
        real('真实输入'),
        injected('Current runtime context.'),
      ],
    })
    const prepared = messagesOf(prepareChatBody(source, {
      keepPromptLast: true,
      extraInjectedPrefixes: ['', 42 as unknown as string],
    }))
    // The built-in prefixes still work, and nothing threw.
    expect(String(prepared.at(-1)?.content)).toBe('真实输入')
  })
})

describe('rewriteSessionTitleModel (issues #132/#133)', () => {
  /**
   * The wire body the host really sends for a title (measured in the 0.2.1-rc.2
   * app.asar): exactly one user message opening with the title template, the
   * JSON array of `{seq, text}` records below it. `prepareChatBody` runs first
   * because the shim applies the rewrite to the prepared body.
   */
  const titleBody = (): string => prepareChatBody(JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'user', content: 'Generate the session title from this JSON array of human messages:\n'
        + JSON.stringify([{ seq: 0, text: '推荐几个菜谱' }]) },
    ],
  }), { keepPromptLast: true })

  it('leaves every body untouched when the option is off (the default)', () => {
    const source = titleBody()
    expect(rewriteSessionTitleModel(source)).toBe(source)
    expect(rewriteSessionTitleModel(source, { enabled: false })).toBe(source)
  })

  it('re-points a recognized title request at the lightweight model and drops reasoning fields', () => {
    const source = prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      reasoning_effort: 'off',
      reasoning: { effort: 'low' },
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'Generate the session title from this JSON array of human messages:\n'
          + JSON.stringify([{ seq: 3, text: '帮我把这段话翻译成英文' }]) },
      ],
    }))
    const prepared = JSON.parse(rewriteSessionTitleModel(source, { enabled: true })) as Record<string, unknown>
    expect(prepared['model']).toBe('wb-lite')
    expect(prepared).not.toHaveProperty('reasoning_effort')
    expect(prepared).not.toHaveProperty('reasoning')
    // Everything else survives byte-for-byte semantics: stream, cap, messages.
    expect(prepared['max_tokens']).toBe(64)
    expect(Array.isArray(prepared['messages'])).toBe(true)
  })

  it('honours a configured target model', () => {
    const prepared = JSON.parse(rewriteSessionTitleModel(titleBody(), {
      enabled: true,
      model: 'wb-mini',
    })) as Record<string, unknown>
    expect(prepared['model']).toBe('wb-mini')
  })

  it('ignores a blank model and falls back to wb-lite', () => {
    const prepared = JSON.parse(rewriteSessionTitleModel(titleBody(), {
      enabled: true,
      model: '   ',
    })) as Record<string, unknown>
    expect(prepared['model']).toBe('wb-lite')
  })

  it('does NOT rewrite a body with two user messages', () => {
    const source = prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'user', content: 'Generate the session title from this JSON array of human messages:\n[]' },
        { role: 'user', content: '普通提问' },
      ],
    }))
    const prepared = JSON.parse(rewriteSessionTitleModel(source, { enabled: true })) as Record<string, unknown>
    expect(prepared['model']).toBe('deepseek-v4.1-flash')
  })

  it('does NOT rewrite a body containing an assistant or tool message', () => {
    for (const extra of [
      { role: 'assistant', content: '之前的回答' },
      { role: 'tool', content: 'tool result' },
    ]) {
      const source = prepareChatBody(JSON.stringify({
        model: 'deepseek-v4.1-flash',
        messages: [
          { role: 'user', content: 'Generate the session title from this JSON array of human messages:\n[]' },
          extra,
        ],
      }))
      const prepared = JSON.parse(rewriteSessionTitleModel(source, { enabled: true })) as Record<string, unknown>
      expect(prepared['model']).toBe('deepseek-v4.1-flash')
    }
  })

  it('does NOT rewrite a user message that merely resembles the template', () => {
    // The prefix must match from the START of the text (after whitespace);
    // a conversation that quotes the template mid-sentence is a conversation.
    const source = prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'user', content: '请问这个提示是干嘛的：Generate the session title from this JSON array of human messages:' },
      ],
    }))
    const prepared = JSON.parse(rewriteSessionTitleModel(source, { enabled: true })) as Record<string, unknown>
    expect(prepared['model']).toBe('deepseek-v4.1-flash')
  })

  it('still recognizes the title after the system head and keepPromptLast ran', () => {
    // The shim rewrites the PREPARED body: ensureSystemHead has inserted a
    // system message by then, and detection must tolerate it.
    const prepared = JSON.parse(rewriteSessionTitleModel(titleBody(), { enabled: true })) as Record<string, unknown>
    const messages = prepared['messages'] as { role: string }[]
    expect(messages[0]?.role).toBe('system')
    expect(prepared['model']).toBe('wb-lite')
  })

  it('prefilters without false negatives across content shapes and escaping', () => {
    // The prefilter matches the serialized text, where the template newline is
    // escaped: both a bare string and an array first-part must still be found.
    for (const content of [
      'Generate the session title from this JSON array of human messages:\n[]',
      [{ type: 'text', text: 'Generate the session title from this JSON array of human messages:\n[]' }],
    ]) {
      const source = prepareChatBody(JSON.stringify({ model: 'm', messages: [{ role: 'user', content }] }))
      expect(JSON.parse(rewriteSessionTitleModel(source, { enabled: true })).model).toBe('wb-lite')
    }
  })
})

describe('parseUpstreamErrorDetail', () => {
  it('lifts code, requestId, and the Chinese display message out of a 11140 body', () => {
    const detail = parseUpstreamErrorDetail(POLICY_REJECT_BODY)
    expect(detail?.upstreamCode).toBe(11140)
    expect(detail?.requestId).toBe('3498bf50-98a9-4746-962e-c14016b8c578')
    expect(detail?.displayMsg).toBe('内容未通过安全审核，请调整后重试。')
  })

  it('falls back to msg when the body carries no display message', () => {
    const detail = parseUpstreamErrorDetail('{"code":11140,"msg":"request illegal"}')
    expect(detail?.displayMsg).toBe('request illegal')
    expect(detail?.requestId).toBeUndefined()
  })

  it('returns undefined rather than guessing on a non-JSON body', () => {
    expect(parseUpstreamErrorDetail('<html>403</html>')).toBeUndefined()
  })
})

describe('regionOf', () => {
  it('routes workbuddy.ai to global and everything else to cn', () => {
    expect(regionOf('www.workbuddy.ai')).toBe('global')
    expect(regionOf('app.workbuddy.ai')).toBe('global')
    expect(regionOf('www.codebuddy.cn')).toBe('cn')
    expect(regionOf('www.workbuddy.cn')).toBe('cn')
    expect(regionOf('')).toBe('cn')
  })

  it('classifies the codebuddy.ai brand domain as global', () => {
    // The CodeBuddy CLI signs the international account in at codebuddy.ai,
    // a second brand domain for the same product (issue #4). Classifying it as
    // cn sent its token to the CN gateway, which answered an openresty HTML 401.
    expect(regionOf('www.codebuddy.ai')).toBe('global')
    expect(regionOf('codebuddy.ai')).toBe('global')
    expect(regionOf('app.codebuddy.ai')).toBe('global')
    // Case and surrounding whitespace are normalized the same way.
    expect(regionOf('  WWW.CodeBuddy.AI  ')).toBe('global')
    // The CN brand domain must NOT be promoted by a loose suffix match.
    expect(regionOf('www.codebuddy.cn')).toBe('cn')
    expect(regionOf('notcodebuddy.ai')).toBe('cn')
  })
})

describe('globalBase', () => {
  it('follows the credential OWN brand domain', () => {
    // A token issued at codebuddy.ai is rejected by the workbuddy.ai gateway,
    // so the base has to track the credential rather than a fixed host.
    expect(globalBase('www.codebuddy.ai')).toBe('https://www.codebuddy.ai')
    expect(globalBase('codebuddy.ai')).toBe('https://www.codebuddy.ai')
    expect(globalBase('www.workbuddy.ai')).toBe('https://www.workbuddy.ai')
    // Unknown global spellings fall back to the desktop app's gateway.
    expect(globalBase('')).toBe('https://www.workbuddy.ai')
    expect(globalBase('some.other.ai')).toBe('https://www.workbuddy.ai')
  })
})

describe('WorkBuddyUpstreamClient.fetchModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function credential(domain: string): WorkBuddyCredential {
    return {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAtMs: 0,
      domain,
      uid: 'u',
      source: 'desktop',
      filePath: '/tmp/workbuddy-desktop.info',
    }
  }

  /** Run fetchModels against a stubbed upstream; return the URL it called. */
  async function fetchModelsUrl(domain: string): Promise<string> {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: {
            models: [{ id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 200_000, maxOutputTokens: 48_000 }],
            agents: [{ name: 'cli', models: ['glm-5.3'] }],
          },
        }),
      } as unknown as Response
    })
    const models = await new WorkBuddyUpstreamClient().fetchModels(credential(domain))
    expect(models.map(model => model.id)).toEqual(['glm-5.3'])
    expect(urls).toHaveLength(1)
    const url = urls[0]
    if (url === undefined) throw new Error('fetchModels performed no upstream request')
    return url
  }

  it('auto-routes CN and global accounts by credential domain', async () => {
    // BOTH regions read /v3/config, the document the WorkBuddy app itself
    // consumes, so the card's roster and prices agree with the app's. Both read
    // it as the APP's product identity (its personal-models path returns HTTP
    // 500 on the global gateway, and /v3 under the CLI identity omits
    // chat-usable models there). The user agent is therefore part of the
    // contract, not an incidental header — see the UA assertions below.
    expect(await fetchModelsUrl('www.codebuddy.cn'))
      .toBe('https://copilot.tencent.com/v3/config')
    expect(await fetchModelsUrl('www.workbuddy.cn'))
      .toBe('https://copilot.tencent.com/v3/config')
    expect(await fetchModelsUrl('www.workbuddy.ai'))
      .toBe('https://www.workbuddy.ai/v3/config')
  })

  it('routes a codebuddy.ai credential to its own gateway, not the CN one', async () => {
    // Regression for issue #4: www.codebuddy.ai was classified as cn, so the
    // request went to copilot.tencent.com and came back an openresty HTML 401.
    expect(await fetchModelsUrl('www.codebuddy.ai'))
      .toBe('https://www.codebuddy.ai/v3/config')
    expect(await fetchModelsUrl('codebuddy.ai'))
      .toBe('https://www.codebuddy.ai/v3/config')
  })

  it('sends the app product identity on the global config request', async () => {
    const seen: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      Object.assign(seen, init.headers)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: {
            models: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, credits: 'x0.00' }],
            agents: [{ name: 'cli', models: ['deepseek-v4.1-flash'] }],
          },
        }),
      } as unknown as Response
    })
    const models = await new WorkBuddyUpstreamClient().fetchModels(credential('www.workbuddy.ai'))
    // The CLI user agent returns a 35-model roster without this model; only the
    // app channel's document carries the account's real chat list.
    expect(seen['User-Agent']).toBe('WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0')
    // P1 把这处从 `SaaS` 统一成 `WorkBuddy`：同一个客户端不该在读目录时叫
    // "某种 SaaS 租户"、在聊天时叫 "WorkBuddy"（见 src/upstream.ts 的
    // attributionHeaders）。
    expect(seen['X-Product']).toBe('WorkBuddy')
    expect(models.map(model => model.id)).toEqual(['deepseek-v4.1-flash'])
    expect(models[0]?.creditMultiplier).toBe(0)
  })

  it('sends the app product identity on the CN config request', async () => {
    const seen: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      Object.assign(seen, init.headers)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: {
            models: [{ id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1_000_000, maxOutputTokens: 48_000 }],
            agents: [{ name: 'cli', models: ['glm-5.3'] }],
          },
        }),
      } as unknown as Response
    })
    await new WorkBuddyUpstreamClient().fetchModels(credential('www.codebuddy.cn'))
    // `/v3/config` answers a DIFFERENT product configuration per client
    // channel, and the CLI channel's answer publishes neither
    // `modelPromotions` nor `modelTiers` — which is why the CN card used to
    // show no promotion badge at all while the WorkBuddy app showed one on the
    // same account. The product configuration must therefore be read as the
    // APP does (`WorkBuddy/<app> WorkBuddy/<app> CLI/<cli>`), while CHAT keeps
    // speaking as the CLI agent.
    expect(seen['User-Agent']).toBe('WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0')
  })

  it('attaches the CN promotion feed to the models it names', async () => {
    // The real CN entry, copied from the app channel's `/v3/config` on
    // 2026-10-21: a night discount with a wall-clock window that crosses
    // midnight, in the upstream's own Chinese wording.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        msg: 'OK',
        data: {
          models: [{ id: 'glm-5.2', name: 'GLM-5.2', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, credits: 'x0.79' }],
          agents: [{ name: 'cli', models: ['glm-5.2'] }],
          modelPromotions: [{
            id: 'glm-52-night-discount-202607',
            kind: 'discount',
            enabled: true,
            priority: 100,
            modelIds: ['glm-5.2'],
            badge: { label: '夜间折扣', color: '#009273' },
            discount: { discountedCredits: '0.50x', displayMode: 'strikethrough', factor: 0.5 },
            hover: { textZh: '每晚 23:00—次日 8:00 积分限时立减，错峰用更省' },
            schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] },
          }],
          modelTiers: [{
            id: 'tier-standard-2026q3',
            badge: { label: '订阅优先', color: '#009273' },
            modelIds: ['glm-5.2'],
            priority: 20,
            tier: 'standard',
          }],
        },
      }),
    }) as unknown as Response)
    const models = await new WorkBuddyUpstreamClient().fetchModels(credential('www.codebuddy.cn'))
    // The badge travels with the model, so the card can draw it without a
    // second upstream request.
    expect(models[0]?.promos?.map(promo => promo.id)).toEqual([
      'glm-52-night-discount-202607',
      'tier-standard-2026q3',
    ])
    expect(models[0]?.promos?.[0]?.badge.label).toBe('夜间折扣')
  })

  it('keeps a model the user runs that the upstream roster dropped', async () => {
    // The app channel's `cli` roster dropped `minimax-m2.7` on 2026-10-21 while
    // the SAME document still publishes it at `x0.26` and the chat endpoint
    // still answers for it (measured HTTP 200). The runtime catalog filters the
    // roster by the user's selection, so a refresh that simply followed the
    // upstream roster would silently withdraw a model the user is running —
    // issue #32's failure mode. The user's selection therefore rides along with
    // the roster read.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        msg: 'OK',
        data: {
          models: [
            { id: 'hy3', name: 'Hy3', maxInputTokens: 192_000, maxOutputTokens: 64_000, credits: 'x0.00' },
            { id: 'minimax-m2.7', name: 'MiniMax-M2.7', maxInputTokens: 200_000, maxOutputTokens: 48_000, credits: 'x0.26' },
          ],
          agents: [{ name: 'cli', models: ['hy3'] }],
        },
      }),
    }) as unknown as Response)
    const models = await new WorkBuddyUpstreamClient()
      .fetchModels(credential('www.codebuddy.cn'), undefined, ['minimax-m2.7'])
    expect(models.map(model => model.id)).toEqual(['hy3', 'minimax-m2.7'])
    expect(models[1]?.creditMultiplier).toBe(0.26)
  })

  it('keeps the running model even when the roster now lists only a router', async () => {
    // The roster can shrink to just `auto`. Dropping the router must not empty
    // the catalog out from under a user who is running a real model, so the
    // kept id is what the region is left with.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        msg: 'OK',
        data: {
          models: [
            { id: 'auto', name: 'Auto', maxInputTokens: 256_000, maxOutputTokens: 32_000 },
            { id: 'minimax-m2.7', name: 'MiniMax-M2.7', maxInputTokens: 200_000, maxOutputTokens: 48_000, credits: 'x0.26' },
          ],
          agents: [{ name: 'cli', models: ['auto'] }],
        },
      }),
    }) as unknown as Response)
    const models = await new WorkBuddyUpstreamClient()
      .fetchModels(credential('www.codebuddy.cn'), undefined, ['minimax-m2.7'])
    expect(models.map(model => model.id)).toEqual(['minimax-m2.7'])
  })

  it('does not resurrect a kept model the document no longer publishes', async () => {
    // The keep rule is bounded by the document: an id the upstream dropped
    // entirely is not re-added from thin air.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        msg: 'OK',
        data: {
          models: [{ id: 'hy3', name: 'Hy3', maxInputTokens: 192_000, maxOutputTokens: 64_000 }],
          agents: [{ name: 'cli', models: ['hy3'] }],
        },
      }),
    }) as unknown as Response)
    const models = await new WorkBuddyUpstreamClient()
      .fetchModels(credential('www.codebuddy.cn'), undefined, ['minimax-m2.7'])
    expect(models.map(model => model.id)).toEqual(['hy3'])
  })

  it('never offers the upstream router as a model', async () => {
    // `auto` resolves to a different model per request, so a row for it would
    // advertise terms (price, window, behaviour) that the plugin cannot state —
    // and it duplicates a real row already in the same roster (CN `auto` →
    // `hy4-preview`). It is dropped where the roster is built, so the card, the
    // picker, the probe and the discovery route all agree.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        msg: 'OK',
        data: {
          models: [
            { id: 'auto', name: 'Auto', maxInputTokens: 256_000, maxOutputTokens: 32_000, isDefault: true },
            { id: 'hy4-preview', name: 'Hy4 preview', maxInputTokens: 960_000, maxOutputTokens: 64_000, credits: 'x0.29' },
          ],
          agents: [{ name: 'cli', models: ['auto', 'hy4-preview'] }],
        },
      }),
    }) as unknown as Response)
    const models = await new WorkBuddyUpstreamClient().fetchModels(credential('www.codebuddy.cn'))
    expect(models.map(model => model.id)).toEqual(['hy4-preview'])
    expect(models.some(model => model.id === 'auto')).toBe(false)
  })

  it('falls back to the legacy CN catalog when the app config fails', async () => {
    // The CN branch prefers /v3/config so the card matches the app's roster and
    // prices. A gateway that cannot serve it must degrade to the previous
    // document rather than leaving the region with no models.
    const urls: string[] = []
    const fallbacks: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      if (url.endsWith('/v3/config')) throw new Error('socket hang up')
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: {
            models: [{ id: 'hy4-preview', name: 'Hy4 preview', maxInputTokens: 1_000_000, maxOutputTokens: 64_000 }],
            agents: [{ name: 'cli', models: ['hy4-preview'] }],
          },
        }),
      } as unknown as Response
    })
    const models = await new WorkBuddyUpstreamClient(message => fallbacks.push(message))
      .fetchModels(credential('www.codebuddy.cn'))
    expect(urls).toEqual([
      'https://copilot.tencent.com/v3/config',
      'https://copilot.tencent.com/v2/enterprises/personal/models',
    ])
    expect(models.map(model => model.id)).toEqual(['hy4-preview'])
    // Silently serving a different roster than the app is the bug being fixed,
    // so the degradation has to be reportable.
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toContain('/v3/config')
    expect(fallbacks[0]).toContain('socket hang up')
  })

  it('degrades the MEDIA catalog the same way, instead of failing the tool', async () => {
    // `fetchMediaModels` reads the same `/v3/config` document for its
    // `text-to-image` tags. Chat already degrades to the legacy `/v2` document
    // when `/v3` stops answering; the image tool must do the same, or a /v3
    // outage turns into "生图工具坏了" while chat keeps working.
    const urls: string[] = []
    const fallbacks: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      if (url.endsWith('/v3/config')) throw new Error('socket hang up')
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: {
            models: [{ id: 'hy4-preview', name: 'Hy4 preview', maxInputTokens: 1_000_000, maxOutputTokens: 64_000 }],
            agents: [{ name: 'cli', models: ['hy4-preview'] }],
          },
        }),
      } as unknown as Response
    })
    const media = await new WorkBuddyUpstreamClient(message => fallbacks.push(message))
      .fetchMediaModels(credential('www.codebuddy.cn'))
    expect(urls).toEqual([
      'https://copilot.tencent.com/v3/config',
      'https://copilot.tencent.com/v2/enterprises/personal/models',
    ])
    // The legacy document carries no media tags in practice: the honest answer
    // is "no image model here", not an exception.
    expect(media).toEqual([])
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toContain('/v3/config')
  })

  it('does not degrade the media catalog on the international region', async () => {
    // The global branch has no legacy fallback at all — it must not be handed a
    // CN-shaped document.
    vi.stubGlobal('fetch', async () => {
      throw new Error('socket hang up')
    })
    await expect(new WorkBuddyUpstreamClient().fetchMediaModels(credential('www.workbuddy.ai')))
      .rejects.toThrow(/socket hang up/)
  })

  it('does not touch the legacy CN catalog when the app config answers', async () => {
    const urls: string[] = []
    const fallbacks: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: {
            models: [{ id: 'hy4-preview', name: 'Hy4 preview', maxInputTokens: 960_000, maxOutputTokens: 64_000, credits: 'x0.29' }],
            agents: [{ name: 'cli', models: ['hy4-preview'] }],
          },
        }),
      } as unknown as Response
    })
    const models = await new WorkBuddyUpstreamClient(message => fallbacks.push(message))
      .fetchModels(credential('www.codebuddy.cn'))
    expect(urls).toEqual(['https://copilot.tencent.com/v3/config'])
    // The app's own record: the paid `hy4-preview` at x0.29 (the free Hy4 tier
    // is no longer a separate record — it is the 夜间免费 promotion badge).
    expect(models.map(model => [model.id, model.creditMultiplier])).toEqual([['hy4-preview', 0.29]])
    expect(fallbacks).toEqual([])
  })

  it('falls back when the app config resolves to an empty roster', async () => {
    // `selectCliModels` throws on an empty roster, so a `/v3` that answers 200
    // with no models must degrade to the legacy document rather than leaving
    // the region with nothing to show.
    const urls: string[] = []
    const fallbacks: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      const empty = url.endsWith('/v3/config')
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: empty
            ? { models: [], agents: [{ name: 'cli', models: ['glm-5.3'] }] }
            : {
                models: [{ id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1_000_000, maxOutputTokens: 48_000 }],
                agents: [{ name: 'cli', models: ['glm-5.3'] }],
              },
        }),
      } as unknown as Response
    })
    const models = await new WorkBuddyUpstreamClient(message => fallbacks.push(message))
      .fetchModels(credential('www.codebuddy.cn'))
    expect(urls).toEqual([
      'https://copilot.tencent.com/v3/config',
      'https://copilot.tencent.com/v2/enterprises/personal/models',
    ])
    expect(models.map(model => model.id)).toEqual(['glm-5.3'])
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toContain('empty list')
  })

  it('reports the fallback error even when the legacy catalog also fails', async () => {
    // Both documents are down: the surfaced error must be the legacy one (the
    // request that finally decided the outcome), and the fallback must still be
    // reported so the log shows the two-step attempt.
    const fallbacks: string[] = []
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 502,
      text: async () => '<html><body>Bad Gateway</body></html>',
    }) as unknown as Response)
    const error = await new WorkBuddyUpstreamClient(message => fallbacks.push(message))
      .fetchModels(credential('www.codebuddy.cn'))
      .then(() => undefined, (reason: unknown) => reason as Error)
    expect(error?.message).toContain('non-JSON')
    expect(fallbacks).toHaveLength(1)
  })

  it('explains a gateway HTML 401 instead of echoing the raw page', async () => {
    // The upstream edge (openresty/APISIX) answers an HTML page when it refuses
    // a revoked token. The user needs to know to re-sign in, not to read markup.
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 401,
      text: async () => '<html><head><title>401 Authorization Required</title></head>'
        + '<body><center><h1>401 Authorization Required</h1></center>'
        + '<hr><center>openresty</center></body></html>',
    }) as unknown as Response)
    const error = await new WorkBuddyUpstreamClient()
      .fetchModels(credential('www.codebuddy.cn'))
      .then(() => undefined, (reason: unknown) => reason as Error)
    expect(error?.message).toContain('rejected by the upstream gateway')
    expect(error?.message).toContain('Re-sign in')
    expect(error?.message).not.toContain('<html>')
  })

  it('keeps the generic message for a non-auth non-JSON failure', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 502,
      text: async () => '<html><body>Bad Gateway</body></html>',
    }) as unknown as Response)
    const error = await new WorkBuddyUpstreamClient()
      .fetchModels(credential('www.codebuddy.cn'))
      .then(() => undefined, (reason: unknown) => reason as Error)
    expect(error?.message).toContain('non-JSON')
  })
})

describe('parseCreditMultiplier', () => {
  it('parses the observed upstream spellings', () => {
    expect(parseCreditMultiplier('x0.79 credits')).toBe(0.79)
    expect(parseCreditMultiplier('x0.05')).toBe(0.05)
    expect(parseCreditMultiplier('x0.00 credits')).toBe(0)
  })

  it('returns undefined rather than guessing', () => {
    expect(parseCreditMultiplier(undefined)).toBeUndefined()
    expect(parseCreditMultiplier('free')).toBeUndefined()
    expect(parseCreditMultiplier(0.5)).toBeUndefined()
  })
})

describe('parseReasoning', () => {
  it('keeps declared effort levels', () => {
    expect(parseReasoning({ supportedEfforts: ['low', 'high', 'xhigh'], defaultEffort: 'high' })).toEqual({
      supportedEfforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'high',
    })
  })

  it('drops an empty reasoning object instead of reporting a capability', () => {
    expect(parseReasoning({})).toBeUndefined()
    expect(parseReasoning({ unsupported: 1 })).toBeUndefined()
  })

  // The singular `effort` spelling (issue #7): `deepseek-v4.1-flash`,
  // `kimi-k3` and friends declare only a default level. Both gateways accept
  // the whole ladder on these models and think off when no reasoning_effort
  // is sent, so the fold widens supportedEfforts and keeps off available.
  it('folds the singular effort form into the full ladder', () => {
    expect(parseReasoning({ effort: 'high', summary: 'auto' })).toEqual({
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      canDisableThinking: true,
    })
    expect(parseReasoning({ effort: 'medium', summary: 'auto' })).toEqual({
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
      canDisableThinking: true,
    })
  })

  it('passes an unrecognized singular effort through as the lone level', () => {
    expect(parseReasoning({ effort: 'turbo', summary: 'auto' })).toEqual({
      supportedEfforts: ['turbo'],
      defaultEffort: 'turbo',
      canDisableThinking: true,
    })
  })

  it('lets the plural form win when both spellings appear', () => {
    expect(parseReasoning({ effort: 'high', supportedEfforts: ['low', 'high'] })).toEqual({
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'high',
    })
    expect(parseReasoning({ effort: 'high', canDisableThinking: false })).toEqual({
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      canDisableThinking: false,
    })
  })
})

describe('parseUpstreamModel', () => {
  it('carries the fields the plugin card displays', () => {
    const model = parseUpstreamModel({
      id: 'glm-5.3',
      name: 'GLM-5.3',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 48_000,
      credits: 'x0.79',
      supportsImages: true,
      reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' },
      descriptionZh: '能力均衡',
    })
    expect(model).toMatchObject({
      id: 'glm-5.3',
      contextWindow: 1_000_000,
      maxTokens: 48_000,
      creditMultiplier: 0.79,
      descriptionZh: '能力均衡',
      supportsImages: true,
    })
    expect(model?.reasoning?.supportedEfforts).toEqual(['low', 'high'])
  })

  it('registers singular-effort models as reasoning-capable (issue #7)', () => {
    // Live /v3/config shape of `deepseek-v4.1-flash` on the global gateway:
    // only the singular `effort` default is declared, and without this fold
    // the whole reasoning object was dropped (thinking never enabled).
    const model = parseUpstreamModel({
      id: 'deepseek-v4.1-flash',
      name: 'Deepseek-V4.1-Flash',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      reasoning: { effort: 'high', summary: 'auto' },
    })
    expect(model?.reasoning).toEqual({
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      canDisableThinking: true,
    })
  })

  it('never infers multimodal from the upstream image flags', () => {
    // `multimodal` is the RUNTIME capability, stamped from the saved
    // `imageModelIds`; the parser must never set it, or a stale upstream flag
    // would silently re-enable image input the user had switched off.
    expect(parseUpstreamModel({
      id: 'a',
      maxInputTokens: 1,
      maxOutputTokens: 1,
      supportsImages: true,
    })?.multimodal).toBeUndefined()
    expect(parseUpstreamModel({
      id: 'b',
      maxInputTokens: 1,
      maxOutputTokens: 1,
      supportsImages: false,
    })?.multimodal).toBeUndefined()
    expect(parseUpstreamModel({
      id: 'c',
      maxInputTokens: 1,
      maxOutputTokens: 1,
      supportsImages: true,
      disabledMultimodal: true,
    })?.multimodal).toBeUndefined()
    expect(parseUpstreamModel({
      id: 'd',
      maxInputTokens: 1,
      maxOutputTokens: 1,
    })?.multimodal).toBeUndefined()
  })

  it('parses the upstream image default into supportsImages', () => {
    // The value only pre-fills the card's image checkboxes on refresh; the
    // effective capability still comes from the saved selection.
    const parsed = (extra: Record<string, unknown>): boolean | undefined => parseUpstreamModel({
      id: 'x',
      maxInputTokens: 1,
      maxOutputTokens: 1,
      ...extra,
    })?.supportsImages
    expect(parsed({ supportsImages: true })).toBe(true)
    expect(parsed({ supportsImages: false })).toBe(false)
    // `disabledMultimodal: true` is a hard veto even alongside
    // `supportsImages: true`. Live data has never shown that conflict (CN
    // 2026-09-29: 0 of 30 entries), so this is a defensive rule: when upstream
    // does contradict itself, err on the side of NOT sending images.
    expect(parsed({ supportsImages: true, disabledMultimodal: true })).toBe(false)
    expect(parsed({ disabledMultimodal: true })).toBe(false)
    // Absent flags stay unknown rather than becoming an implicit `false`.
    expect(parsed({})).toBeUndefined()
  })

  it('rejects disabled models and models without token limits', () => {
    expect(parseUpstreamModel({ id: 'a', disabled: true, maxInputTokens: 1, maxOutputTokens: 1 })).toBeUndefined()
    expect(parseUpstreamModel({ id: 'b', maxInputTokens: 0, maxOutputTokens: 1 })).toBeUndefined()
    expect(parseUpstreamModel({ id: '', maxInputTokens: 1, maxOutputTokens: 1 })).toBeUndefined()
  })
})

/**
 * The input to DSML recovery: which tool names THIS request offered.
 *
 * Getting this wrong is the difference between a recovery that can never fire
 * (names unrecognised, so every block is refused) and one that fires on a name
 * the caller never authorised — the production accident the gates exist for.
 * The `tool_choice: "none"` case is the important one: `prepareChatBody` deletes
 * `tools` for it, so gate 3 comes out of the same prepared JSON rather than
 * from a second rule someone has to remember to keep in sync.
 */
describe('declaredTools', () => {
  it('reads names and required parameters from a prepared body', () => {
    const prepared = prepareChatBody(JSON.stringify({
      tools: [
        { type: 'function', function: { name: 'bash', parameters: { type: 'object', required: ['command'] } } },
        { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
      ],
    }))
    const declared = declaredTools(prepared)
    expect(declared?.names).toEqual(new Set(['bash', 'read_file']))
    expect(declared?.requiredParameters.get('bash')).toEqual(['command'])
    // A tool with no `required` list contributes no entry rather than an empty
    // one: an empty list would read as "checked and nothing is required", which
    // is the same answer but hides the difference between the two.
    expect(declared?.requiredParameters.has('read_file')).toBe(false)
    expect(declared?.pinnedToolName).toBeUndefined()
  })

  it('reports nothing when the prepared body declares no tools (gate 3)', () => {
    expect(declaredTools(prepareChatBody(JSON.stringify({ messages: [] })))).toBeUndefined()
    expect(declaredTools(prepareChatBody(JSON.stringify({
      tool_choice: 'none',
      tools: [{ type: 'function', function: { name: 'bash' } }],
    })))).toBeUndefined()
    expect(declaredTools(prepareChatBody(JSON.stringify({ tools: [] })))).toBeUndefined()
  })

  it('reports a pinned tool_choice as a bare name', () => {
    const prepared = prepareChatBody(JSON.stringify({
      tools: [{ type: 'function', function: { name: 'read' } }],
      tool_choice: { type: 'function', function: { name: 'read' } },
    }))
    expect(declaredTools(prepared)?.pinnedToolName).toBe('read')
  })

  it('does not treat auto or required as a pin', () => {
    for (const choice of ['auto', 'required']) {
      const prepared = prepareChatBody(JSON.stringify({
        tools: [{ type: 'function', function: { name: 'read' } }],
        tool_choice: choice,
      }))
      expect(declaredTools(prepared)?.pinnedToolName).toBeUndefined()
    }
  })

  it('returns nothing for an unparsable or malformed body', () => {
    expect(declaredTools('not json')).toBeUndefined()
    expect(declaredTools('[]')).toBeUndefined()
    expect(declaredTools(JSON.stringify({ tools: [{ type: 'function' }, { function: { name: 7 } }, null] })))
      .toBeUndefined()
  })
})

describe('WorkBuddyUpstreamClient.probeChat', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function credential(): WorkBuddyCredential {
    return {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAtMs: 0,
      domain: 'www.codebuddy.cn',
      uid: 'u',
      source: 'desktop',
      filePath: '/tmp/workbuddy-desktop.info',
    }
  }

  it('gives up on an endpoint that never answers, instead of hanging the batch', async () => {
    // The pool's batch is SERIAL, so one endpoint that accepts the connection and
    // never replies blocks every account behind it — that is the "dead button"
    // making the response streamed alone would NOT have fixed.
    //
    // Ten seconds: comfortably above a working gateway's first byte, far below a
    // user's patience.
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(new Error('no response within 10000ms'))
      })
    })))
    const answer = new WorkBuddyUpstreamClient().probeChat(credential(), '{}')
    await vi.advanceTimersByTimeAsync(9_999)
    await vi.advanceTimersByTimeAsync(1)
    // status 0 is the transport-failure convention the shim already maps to
    // `server`, so this reads as "the upstream is unreachable" — not as a
    // statement about the account.
    await expect(answer).resolves.toMatchObject({ ok: false, status: 0 })
  })

  it('stops counting time once a response arrives, so a slow body is not cut off', async () => {
    // The Discriminating Case: a naive `AbortSignal.timeout` keeps running while
    // the body drains, which would put a healthy but slow model on the same clock
    // as a dead endpoint. The ceiling answers "did the upstream answer AT ALL",
    // so it is cleared the moment headers land.
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: [DONE]\n\n', { status: 200 })))
    const client = new WorkBuddyUpstreamClient()
    const answer = await client.probeChat(credential(), '{}')
    expect(answer.ok).toBe(true)
    // Well past the ceiling — if the timer were still armed, this read would
    // throw and a working account would be reported unreachable.
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(answer.response?.text()).resolves.toContain('[DONE]')
  })
})

describe('the conversation-identity triple (issue #66)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function credential(domain = 'www.codebuddy.cn'): WorkBuddyCredential {
    return {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAtMs: 0,
      domain,
      uid: 'u',
      source: 'desktop',
      filePath: '/tmp/workbuddy-desktop.info',
    }
  }

  /** Capture the headers one chat request actually went out with. */
  async function headersOf(
    domain: string,
    identity?: WorkBuddyWireIdentity,
  ): Promise<Record<string, string>> {
    const seen: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      Object.assign(seen, init.headers)
      return new Response('data: [DONE]\n\n', { status: 200 })
    })
    await new WorkBuddyUpstreamClient(undefined, identity).chatStream(credential(domain), '{}')
    return seen
  }

  const TRIPLE = ['X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Conversation-Message-ID']

  it('sends all three on the international gateway, which refuses the request without them', async () => {
    // The reported defect: workbuddy-global answers EVERY step with 400 /
    // business code 11128 ("conversation id missing"), on every model. The
    // gateway's own display tips blame the client identity, which is why this
    // reads as something other than a missing header.
    const seen = await headersOf('www.workbuddy.ai')
    for (const name of TRIPLE) expect(seen[name]).toBeTruthy()
  })

  it('sends them on the CN gateway too, so only one side can never be the whole story', async () => {
    // The CN gateway tolerates their absence, so sending them there is harmless.
    // Deliberate: a header that is only ever sent on one side is how the 3.1.0
    // system-head rule became an international-only defect that no CN-side test
    // could see. This asserts the one-code-path decision, not a CN requirement.
    const seen = await headersOf('www.codebuddy.cn')
    for (const name of TRIPLE) expect(seen[name]).toBeTruthy()
  })

  it('gives the three headers three DIFFERENT values', async () => {
    // Bisecting the official bundle's header set showed X-Conversation-ID alone is
    // still refused: all three must be present. Three copies of one id would
    // satisfy a naive presence check while forging a conversation identity that
    // does not exist — one session announced three times under a single id.
    const seen = await headersOf('www.workbuddy.ai')
    expect(new Set(TRIPLE.map(name => seen[name])).size).toBe(3)
  })

  it('sends the shape it always sent, with the alignment off (issue #132)', async () => {
    // The default is the shape every account has been answering since #66. #132's
    // reporter measured the official-shaped one at HTTP 200, but that is a
    // reporter's account and a 5.3.1 build, so it does not become the default here
    // until this plugin has measured it itself.
    const seen = await headersOf('www.workbuddy.ai')
    const hyphenated = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    for (const name of TRIPLE) expect(seen[name]).toMatch(hyphenated)
    expect(seen['X-Request-ID']).toBeUndefined()
    // P1 之后 `usageIdentity` 只剩"id 格式"这一半职责：客户端身份
    // （X-IDE-*）由 wireProfile 的 balanced 档统一发出，不再跟这条开关走。
    expect(seen['X-IDE-Name']).toBe('WorkBuddy')
  })

  it('restores the 5.16.0 header set under the conservative profile', async () => {
    // 回退档的契约是"逐字节等于 5.16.0"，不是"少发几个新头"：连改名前的
    // `X-Product: SaaS` 都要还原，否则回退出来的是第三个从未上线过的形状。
    const seen = await headersOf('www.workbuddy.ai', { profile: 'conservative' })
    expect(seen['X-Product']).toBe('SaaS')
    expect(seen['X-IDE-Name']).toBeUndefined()
    expect(seen['X-IDE-Type']).toBeUndefined()
    expect(seen['X-Agent-Purpose']).toBeUndefined()
    expect(seen['X-CodeBuddy-Request']).toBeUndefined()
    expect(seen['Accept-Language']).toBeUndefined()
  })

  it('adopts the official usage identity on the chat path when asked (issue #132)', async () => {
    // The gateway echoes `X-Conversation-Message-ID` as the SSE id and the usage
    // page shows that value as the request id, so a hyphenated v4 made one
    // account's rows look like two different clients.
    const seen = await headersOf('www.workbuddy.ai', { usageIdentity: true })
    const v7 = /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/
    for (const name of TRIPLE) expect(seen[name]).toMatch(v7)
    expect(seen['X-IDE-Name']).toBe('WorkBuddy')
    // P1 起 Name 与 Type 同源。5.16.0 刻意混搭（Name=WorkBuddy / Type=CLI）是
    // "最小身份声明"时期的取舍；统一客户端身份之后，混搭本身成了会被比对的矛盾。
    expect(seen['X-IDE-Type']).toBe('WorkBuddy')
    // The version must agree with the UA the plugin already claims, not a second
    // hardcoded number.
    expect(seen['X-IDE-Version']).toMatch(/^\d+\.\d+\.\d+/)
    expect(seen['X-Request-ID']).toBe(seen['X-Conversation-Message-ID'])
    // The channel identity behind the billing is NOT part of the alignment.
    expect(seen['User-Agent']).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
  })

  it('generates fresh values per request rather than reusing one identity', async () => {
    // The official client calls randomUUID() per request. Reusing a value across
    // requests is what would make the upstream correlate two different steps as
    // one message — the assertion below fails if the triple is hoisted to a
    // module-level constant, which is the natural "optimisation" here.
    const first = await headersOf('www.workbuddy.ai')
    const second = await headersOf('www.workbuddy.ai')
    for (const name of TRIPLE) expect(second[name]).not.toBe(first[name])
  })

  it('carries them on the probe path, which shares the chat endpoint', async () => {
    // The probe is a real chat request, so the same gate applies — and it is how
    // the reporter's own account test surfaced 11128 (one account "ok", another
    // refused, in the same batch). A fix applied only to chatStream would leave
    // the pool testing accounts against an endpoint whose rules are not met.
    const seen: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      Object.assign(seen, init.headers)
      return new Response('data: [DONE]\n\n', { status: 200 })
    })
    await new WorkBuddyUpstreamClient().probeChat(credential('www.workbuddy.ai'), '{}')
    for (const name of TRIPLE) expect(seen[name]).toBeTruthy()
  })

  it('keeps the IMAGE path on the id shape it was measured with, not the chat one (issue #132)', async () => {
    // Deliberate split: #132's reporter measured CHAT (HTTP 200, 32-hex UUIDv7
    // echoed as the SSE id), and the image endpoint was measured on 2026-10-21
    // with hyphenated v4 ids at BOTH entrances. The id format is not what the
    // image gate asks about, so a display-fidelity change must not sweep that
    // path into bytes nobody tested it with.
    const seen: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      Object.assign(seen, init.headers)
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    })
    await new WorkBuddyUpstreamClient(undefined, { usageIdentity: true })
      .generateImage(credential('www.codebuddy.cn'), { model: 'hunyuan-image-alpha', prompt: 'p' })
      // The stubbed envelope carries no image, so the parse is expected to fail —
      // the headers had already gone out, which is the whole subject here.
      .catch(() => undefined)
    const hyphenated = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    for (const name of TRIPLE) expect(seen[name]).toMatch(hyphenated)
    // `X-Request-ID` is the chat usage-page alignment; the image path never had it.
    expect(seen['X-Request-ID']).toBeUndefined()
  })

  it('does not carry them on the billing endpoint, which is not chat', async () => {
    // The triple is a CHAT-endpoint requirement. The reporter's matrix was taken
    // on the chat endpoint only, so sending it on the billing calls the official
    // client also makes without it would be inventing protocol nobody tested.
    //
    // Asserted BEHAVIOURALLY: an earlier draft of this test grepped the source
    // text, and a mutation that added the triple to `billingHeaders` slipped past
    // it because the text slice it compared had simply failed to match. Driving
    // the real method is what makes the guard measure the request instead.
    const seen: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      Object.assign(seen, init.headers)
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    })
    await new WorkBuddyUpstreamClient().fetchCredits(credential('www.workbuddy.ai'))
    for (const name of TRIPLE) expect(seen[name]).toBeUndefined()
  })
})

describe('WorkBuddyUpstreamClient.chatStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function credential(): WorkBuddyCredential {
    return {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAtMs: 0,
      domain: 'www.codebuddy.cn',
      uid: 'u',
      source: 'desktop',
      filePath: '/tmp/workbuddy-desktop.info',
    }
  }

  it('does NOT impose a first-byte ceiling of its own', async () => {
    // The Discriminating Case, and it is a NEGATIVE assertion: a chat answer has
    // to prefill the whole prompt before its first byte, and that varies by an
    // order of magnitude with context size. A bound tight enough to matter would
    // eventually cut a real answer short — and cutting a real answer is worse than
    // waiting for a slow one.
    //
    // Liveness is the probe's job (see `PROBE_TIMEOUT_MS`), not the real request's.
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      // Rejects only if a timer is armed; a bare caller signal still aborts.
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })))
    const answer = new WorkBuddyUpstreamClient().chatStream(credential(), '{}')
    // Far past any plausible ceiling — if this path grew one, this is where it
    // would fire and turn a slow-but-working request into "unreachable".
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(answer).toBeInstanceOf(Promise)
    // Still pending: nothing on this path is allowed to time out on its own.
    await expect(Promise.race([answer, Promise.resolve('pending')])).resolves.toBe('pending')
  })

  it('still honours the caller\'s cancellation', async () => {
    // What DOES bound a real request: the caller hanging up. The shim's controller
    // aborts on client disconnect, and that must win immediately — aborting is
    // what turns "the user closed the panel" into a stop rather than a completed
    // upstream call.
    vi.useFakeTimers()
    const caller = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })))
    const answer = new WorkBuddyUpstreamClient().chatStream(credential(), '{}', caller.signal)
    await vi.advanceTimersByTimeAsync(1_000)
    caller.abort()
    await expect(answer).resolves.toMatchObject({ ok: false, status: 0, kind: 'server' })
  })

  it('warns through the injected logger when a 11140 body decodes to nothing', async () => {
    // The predicate is only half of the observability: the transport must
    // actually forward it. The onFallback channel is how this module reports
    // anomalies without holding a logger.
    const warning: string[] = []
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"error":{"data":{"code":11140,"displayMsg":{"zh":"账号存在异常行为，已被限制使用"}}}}',
      { status: 403 },
    )))
    const answer = await new WorkBuddyUpstreamClient(
      message => warning.push(message),
    ).chatStream(credential(), '{}')
    if (answer.ok) throw new Error('expected a failure result')
    expect(answer.kind).toBe('policy_reject')
    expect(warning).toHaveLength(1)
    expect(warning[0]).toContain('11140')
    expect(warning[0]).toContain('displayMsg/displayTips/msg')
  })

  it('does not warn for an ordinary content refusal', async () => {
    const warning: string[] = []
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"code":11140,"msg":"request illegal","displayMsg":{"zh":"模型无法处理此请求"}}',
      { status: 403 },
    )))
    const answer = await new WorkBuddyUpstreamClient(
      message => warning.push(message),
    ).chatStream(credential(), '{}')
    if (answer.ok) throw new Error('expected a failure result')
    expect(answer.kind).toBe('policy_reject')
    expect(warning).toHaveLength(0)
  })
})

describe('selectCliModels drops the regional routers, and keeps doing it', () => {
  /** A minimal entry `parseUpstreamModel` accepts (both token counts positive). */
  const entry = (id: string, name: string) => ({ id, name, maxInputTokens: 176_000, maxOutputTokens: 24_000 })

  it('drops CN `auto` from the roster', () => {
    const roster = selectCliModels(
      [entry('auto', 'Auto'), entry('hy3', 'Hy3')],
      [{ name: 'cli', models: ['auto', 'hy3'] }],
    )
    expect(roster.map(model => model.id)).toEqual(['hy3'])
  })

  it('drops the international `default-model`, the same router under another id', () => {
    const roster = selectCliModels(
      [entry('default-model', 'Auto'), entry('fast-model', 'Fast')],
      [{ name: 'cli', models: ['default-model', 'fast-model'] }],
    )
    expect(roster.map(model => model.id)).toEqual(['fast-model'])
  })

  it('does not resurrect a router the SAVED SELECTION still names', () => {
    // The case that made the `keepIds` filter necessary rather than decorative:
    // a profile saved before routers were dropped still carries `auto` in
    // `enabledModelIds`, and `keepIds` exists so a refresh never withdraws a
    // model the user is running. Without the filter, that stored id comes back
    // through the kept branch — and does so on EVERY refresh, so the row would
    // be impossible to get rid of by unchecking it.
    const roster = selectCliModels(
      [entry('auto', 'Auto'), entry('default-model', 'Auto'), entry('hy3', 'Hy3')],
      [{ name: 'cli', models: ['hy3'] }],
      ['auto', 'default-model'],
    )
    expect(roster.map(model => model.id)).toEqual(['hy3'])
  })

  it('still keeps a real model the upstream roster dropped', () => {
    // The other half of the same branch: filtering routers must not break the
    // issue #32 guarantee that a user's running model survives a refresh.
    const roster = selectCliModels(
      [entry('auto', 'Auto'), entry('hy3', 'Hy3'), entry('retired-model', 'Retired')],
      [{ name: 'cli', models: ['hy3'] }],
      ['retired-model'],
    )
    expect(roster.map(model => model.id)).toEqual(['hy3', 'retired-model'])
  })
})
