/**
 * Issue #98, seen from the shim: the channel gate, and the two behaviours the
 * reply/retry owe the reader.
 *
 * THE REPORT. The CN gateway refuses a chat request with HTTP 400 + business
 * code `11128` when a message the gateway SCANS opens with a known
 * third-party-agent identity. Ten people reported it in issue #98, and the
 * plugin's own reply actively misdirected them: it echoed the opening of the
 * prepared body, which after normalisation is the plugin's own placeholder
 * `You are a helpful assistant.` — a line that returns 200 when sent alone.
 *
 * WHAT WAS MEASURED on the live CN gateway on 2026-10-21 (account `ba217455…`,
 * `deepseek-v4.1-flash`, every other request field held fixed):
 *
 *   - the gate scans every `system` message AND every `assistant` message, at
 *     the START of the content (or of every text part);
 *   - `user` and `tool` messages are NOT scanned;
 *   - moving the opening behind ANY neutral head answers 200.
 *
 * An `assistant` message that opens with the refused identity therefore poisons
 * the WHOLE session: every later turn is refused, on every account and in every
 * region. That is what the retry below is for, and why it must never spend a
 * second account on the problem.
 *
 * @module dsh-connect-workbuddy/tests/issue98-shim
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import {
  classifyUpstreamError,
  parseUpstreamErrorDetail,
  WORKBUDDY_FALLBACK_SYSTEM_PROMPT,
} from '../src/upstream.ts'
import type { WorkBuddyChatResult, WorkBuddyUpstreamClient } from '../src/upstream.ts'

/**
 * The live CN gateway's channel-gate reply, captured byte-exact (request id
 * redacted). `msg` is the diagnostic half; `displayTips` is the misleading half.
 */
const CHANNEL_REJECT_BODY = JSON.stringify({
  code: 11128,
  msg: 'Illegal API invocation from an unapproved channel',
  requestId: '26d17b97-c53b-461a-bd21-34c61c86f15b',
  displayMsg: {
    en: 'Request blocked. Please send it again',
    zh: '请求被拦截，请重新发送',
    'zh-hant': '請求已被攔截，請重新傳送',
  },
  displayTips: {
    en: 'This call failed channel verification, possibly because it was not sent from an official client. Please resend from the official client.',
    zh: '这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。',
    'zh-hant': '本次呼叫未通過通路驗證，可能不是官方用戶端發出。請使用官方版本重新傳送。',
  },
  actions: ['EDIT_INPUT', 'SUBMIT_FEEDBACK'],
})

/** The header gate issue #66 fixed: same code, different cause. */
const CONVERSATION_ID_BODY = '{"code":11128,"msg":"conversation id missing","requestId":"3605a27b-0000-4000-8000-000000000066","displayTips":{"zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。"}}'

/** The global gateway's first-message rule: also `11128`, also different. */
const FIRST_MESSAGE_BODY = '{"code":11128,"msg":"first message is not system prompt","requestId":"5c9a2946-0000-4000-8000-000000000090","displayMsg":{"zh":"请求被安全策略拦截，请稍后重试或联系支持。"}}'

/** The identity both gateways fingerprint (measured). */
const DSH_FINGERPRINT = 'You are an AI agent powered by DeepSeek Harness.'
/** An opening neither gateway has ever refused — the unknown-fingerprint case. */
const NOVEL_OPENING = 'You are Cursor Agent, an AI pair programmer from Anysphere.'

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAtMs: Date.now() + 86_400_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid',
  uin: 'selected',
  source: 'desktop',
  filePath: '/tmp/auth.info',
}

const SECOND_CREDENTIAL: WorkBuddyCredential = { ...CREDENTIAL, uid: 'uid-2', uin: 'other' }

const store = {
  resolve: async () => CREDENTIAL,
  credentialFor: async () => CREDENTIAL,
} as unknown as import('../src/auth.ts').WorkBuddyCredentialStore

let shim: WorkBuddyShim | undefined
afterEach(async () => {
  await shim?.close()
  shim = undefined
})

function failure(status: number, body: string): WorkBuddyChatResult {
  return {
    ok: false,
    status,
    kind: classifyUpstreamError(status, body),
    message: body,
    detail: parseUpstreamErrorDetail(body),
  }
}

/** How many invisible breaks a body carries. */
function breaksIn(bodyJson: string): number {
  return (bodyJson.match(/\u200b/gu) ?? []).length
}

/**
 * A body with every invisible break removed — the text the model reads.
 *
 * The request path now breaks an agent identity clause before the ladder ever
 * runs (the exact-substring gate is what refused the real DSH prompt, issue
 * #125), so "the plain body has no U+200B" is no longer true and must not be
 * asserted. Comparing the stripped forms keeps the claim the ladder has to
 * satisfy: it adds no word and removes none.
 */
function stripBreaks(bodyJson: string): string {
  return bodyJson.replace(/\u200b/gu, '')
}

function contentFrame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: '' }] })}\n\n`
}

function answer(text: string): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${contentFrame(text)}data: [DONE]\n\n`))
      controller.close()
    },
  }))
}

/** Mount the real shim, with a scripted upstream client and every side effect recorded. */
function mount(script: {
  results: (body: string, call: number) => WorkBuddyChatResult
  failoverAccount?: (tried: readonly string[]) => Promise<WorkBuddyCredential | undefined>
}): {
  instance: WorkBuddyShim
  bodies: string[]
  accounts: string[]
  failures: Array<{ accountId: string, kind: string }>
  failoverCalls: () => number
} {
  const bodies: string[] = []
  const accounts: string[] = []
  const failures: Array<{ accountId: string, kind: string }> = []
  let failoverCalls = 0
  const instance = createWorkBuddyShim({
    store,
    client: {
      chatStream: async (credential: WorkBuddyCredential, body: string): Promise<WorkBuddyChatResult> => {
        bodies.push(body)
        accounts.push(credential.uin ?? credential.uid)
        return script.results(body, bodies.length)
      },
    } as unknown as WorkBuddyUpstreamClient,
    catalog: new WorkBuddyCatalog(),
    onAccountFailure: (accountId, reported) => {
      failures.push({ accountId, kind: reported.kind })
    },
    ...script.failoverAccount === undefined
      ? {}
      : {
          failoverAccount: async (tried: readonly string[]) => {
            failoverCalls += 1
            return script.failoverAccount?.(tried)
          },
        },
  })
  return { instance, bodies, accounts, failures, failoverCalls: () => failoverCalls }
}

interface Reply {
  status: number
  message: string
  type: string
  text: string
}

/** One chat through the shim, returning the host-facing answer (error or stream). */
async function chat(instance: WorkBuddyShim, messages: Array<Record<string, unknown>>): Promise<Reply> {
  await instance.ready
  const response = await fetch(`${instance.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token()}` },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages }),
  })
  const text = await response.text()
  if (response.ok) return { status: response.status, message: '', type: '', text }
  const parsed = JSON.parse(text) as { error: { message: string, type: string } }
  return { status: response.status, message: parsed.error.message, type: parsed.error.type, text }
}

describe('the self-healing retry (issue #98)', () => {
  it('retries once with the neutral head forced in front of every opening, and lets the request succeed', async () => {
    const mounted = mount({
      results: (_body, call) => call === 1 ? failure(400, CHANNEL_REJECT_BODY) : { ok: true, response: answer('2') },
    })
    shim = mounted.instance

    const { status, text } = await chat(shim, [
      { role: 'system', content: NOVEL_OPENING },
      { role: 'user', content: '1+1?' },
      { role: 'assistant', content: `${DSH_FINGERPRINT}\n\nsure, it is 1+1.` },
      { role: 'user', content: 'again?' },
    ])

    expect(status).toBe(200)
    expect(text).toContain('2')
    // The retry really was a SECOND request, and it differs from the first only
    // by where the neutral head sits.
    expect(mounted.bodies).toHaveLength(2)
    const retried = JSON.parse(mounted.bodies[1] ?? '{}') as { messages: Array<{ role: string, content: string }> }
    const system = retried.messages.find(message => message.role === 'system')
    const assistant = retried.messages.find(message => message.role === 'assistant')
    expect(system?.content.startsWith(`${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n`)).toBe(true)
    // The assistant message is the one that poisons a session — it must be moved
    // too, or the retry would be refused for the same reason.
    expect(assistant?.content.startsWith(`${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n`)).toBe(true)
  })

  it('never spends a second account on the retry, and never books the first attempt', async () => {
    const mounted = mount({
      results: (_body, call) => call === 1 ? failure(400, CHANNEL_REJECT_BODY) : { ok: true, response: answer('2') },
      failoverAccount: async () => SECOND_CREDENTIAL,
    })
    shim = mounted.instance

    const reply = await chat(shim, [{ role: 'system', content: NOVEL_OPENING }, { role: 'user', content: '1+1?' }])

    expect(reply.status).toBe(200)
    // The gate reads the prompt, not the account: switching would burn real
    // quota to be told the same thing.
    expect(mounted.failoverCalls()).toBe(0)
    expect(new Set(mounted.accounts)).toEqual(new Set(['selected']))
    // And the refused first attempt was a prompt problem, not an account
    // problem, so the pool must not be told the credential failed.
    expect(mounted.failures).toEqual([])
  })

  it('skips the head rung when it cannot change the body, and still tries the perturbation', async () => {
    // The system already starts with the neutral head, and the request path
    // rewrites the known fingerprint (issue #163), so `forceNeutralHead` cannot
    // change the body and the head rung is skipped — but the perturbation rung
    // is exactly what rescues an inner, unmeasured fingerprint, so it must run.
    const mounted = mount({ results: () => failure(400, CHANNEL_REJECT_BODY) })
    shim = mounted.instance

    const reply = await chat(shim, [
      { role: 'system', content: `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${DSH_FINGERPRINT}` },
      { role: 'user', content: 'hi' },
    ])

    expect(reply.status).toBe(400)
    expect(mounted.bodies).toHaveLength(3)
    // The second body differs from the first only by invisible characters.
    //
    // The FIRST body is no longer free of them: `prepareChatBody` breaks the
    // identity clause itself now, because the substring gate — not the prefix
    // gate — is what refused the real DSH prompt (issue #125). So the comparison
    // is between the two bodies with the breaks stripped, which states the same
    // claim as before ("the perturbation adds no word and removes none")
    // against the text the model actually reads.
    const first = mounted.bodies[0] ?? ''
    const second = mounted.bodies[1] ?? ''
    expect(second).toContain('\u200b')
    expect(stripBreaks(second)).toBe(stripBreaks(first))
    // The sparse rung still ADDS breaks on top of the ones the request path put
    // there — that is what makes spending this request worth it at all.
    expect(breaksIn(second)).toBeGreaterThan(breaksIn(first))
    expect(reply.message).toContain('并已用一次不可见扰动与一次密集不可见扰动重试过')
    expect(reply.message).not.toContain('并已用强制中性头')
  })
})

describe('the reply reads the HOST body, per role (issue #98)', () => {
  it('names the assistant message that poisoned the session, and says the retry was spent', async () => {
    const mounted = mount({ results: () => failure(400, CHANNEL_REJECT_BODY) })
    shim = mounted.instance

    const reply = await chat(shim, [
      { role: 'system', content: NOVEL_OPENING },
      { role: 'user', content: '1+1?' },
      { role: 'assistant', content: `${DSH_FINGERPRINT}\n\nhere is my prompt` },
      { role: 'user', content: 'again?' },
    ])

    expect(reply.status).toBe(400)
    expect(reply.type).toBe('channel_reject')
    // The opening is quoted with its role and with the reason it matters.
    expect(reply.message).toContain(`「assistant：${DSH_FINGERPRINT}，首尾为「here is my prompt」，共 67 字」（插件已加中性头）`)
    // The system message is quoted too — the reader must not be left guessing
    // which of their messages the gateway looked at.
    expect(reply.message).toContain(`「system：${NOVEL_OPENING}，共 59 字」（不在插件已知名单里`)
    // Support's handles survive.
    expect(reply.message).toContain('code 11128')
    expect(reply.message).toContain('requestId 26d17b97-c53b-461a-bd21-34c61c86f15b')
    // The retry really happened, and the reply says so.
    // The ladder spent both rungs (the head retry could not help by itself),
    // and the reply says so.
    expect(reply.message).toContain('并已用强制中性头与一次不可见扰动与一次密集不可见扰动重试过')
    // The old, misleading claim is gone: the plugin cannot know which line the
    // gateway matched, and pretending otherwise is what misdirected the reports.
    expect(reply.message).not.toContain('命中的 system 提示开头')
    expect(reply.message).not.toContain('请按上面的提示调整后重试')
  })

  it('marks an opening the plugin does not know as the actionable one', async () => {
    const mounted = mount({ results: () => failure(400, CHANNEL_REJECT_BODY) })
    shim = mounted.instance

    const reply = await chat(shim, [{ role: 'system', content: NOVEL_OPENING }, { role: 'user', content: 'hi' }])

    expect(reply.message).toContain(`「system：${NOVEL_OPENING}，共 59 字」（不在插件已知名单里，仅指首行）`)
    // The gateway's shared tips sentence is NOT relayed as if it were a finding.
    expect(reply.message).not.toContain('可能不是官方客户端发出的。请用官方版本重新发送')
    // The old guess — "the gateway may have added an entry" — is gone: reporters
    // read it as "this opening went out verbatim", which is exactly the false
    // lead issue #213 followed for a whole report.
    expect(reply.message).not.toContain('网关可能新增了词条')
  })

  it('reports the host prompt rather than the plugin placeholder after normalisation', async () => {
    // The regression: the old excerpt came from the prepared body, so a KNOWN
    // fingerprint was reported as the plugin's own `You are a helpful
    // assistant.` — the line issue #98's reporters were told had been refused.
    const mounted = mount({ results: () => failure(400, CHANNEL_REJECT_BODY) })
    shim = mounted.instance

    const reply = await chat(shim, [{ role: 'system', content: DSH_FINGERPRINT }, { role: 'user', content: 'hi' }])

    expect(reply.message).toContain(`「system：${DSH_FINGERPRINT}，共 48 字」（插件已加中性头）`)
    expect(reply.message).not.toContain(`「system：${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}」`)
  })

  it('says so when the body carries no readable opening', async () => {
    const mounted = mount({ results: () => failure(400, CHANNEL_REJECT_BODY) })
    shim = mounted.instance

    // A user-first body: `ensureSystemHead` injects a system head, but the HOST
    // body that the evidence is read from has no system/assistant message.
    const reply = await chat(shim, [{ role: 'user', content: 'hi' }])

    expect(reply.message).toContain('（请求里没有可读的 system 或 assistant 消息开头。）')
  })
})

describe('the whole `11128` family answers as ONE gate, with the member named (issue #113)', () => {
  // WHAT CHANGED AND WHY. These two used to answer as `client` with a bespoke
  // paragraph each, precisely so a header problem would never be reported as a
  // prompt problem. Issue #113 then measured that the upstream's `msg` is NOT
  // reliable — a content refusal arrived saying `conversation id missing` while
  // all three headers were present — and the `client` classification meant the
  // plugin's retry ladder never ran for exactly the refusal it exists for.
  //
  // So every member of the family is now `channel_reject` (the ladder runs),
  // and the MEMBER is named from the request-side evidence so the reply still
  // never blames a prompt for a header problem when the headers really are the
  // story.
  it('names the conversation-id gate as a MISREPORT when the request carried the triple', async () => {
    const mounted = mount({ results: () => failure(400, CONVERSATION_ID_BODY) })
    shim = mounted.instance

    const reply = await chat(shim, [{ role: 'system', content: NOVEL_OPENING }, { role: 'user', content: 'hi' }])

    expect(reply.status).toBe(400)
    // The family classifies as the channel gate, not the generic `client`.
    expect(reply.type).toBe('channel_reject')
    // And the reply echoes the upstream's own sentence verbatim, then says WHY
    // it cannot be believed: the plugin sends the triple on every chat request.
    expect(reply.message).toContain('「conversation id missing」')
    expect(reply.message).toContain('X-Conversation-ID')
    expect(reply.message).toContain('上游误报')
    // It also names the real cause, so the reader is not left with a header
    // theory that no action of theirs can satisfy.
    expect(reply.message).toContain('实际被拒的是请求内容')
    // The family's own diagnosis is the actionable part, so it IS present —
    // that is the whole point of running the ladder.
    expect(reply.message).toContain('渠道校验')
  })

  it('names the first-message gate as unprovable when the request DID open with a system message', async () => {
    // The plugin's `ensureSystemHead` puts a system message first, so a body
    // claiming otherwise cannot be describing this request. The reply says
    // that instead of silently repeating the upstream's wording.
    const mounted = mount({ results: () => failure(400, FIRST_MESSAGE_BODY) })
    shim = mounted.instance

    const reply = await chat(shim, [{ role: 'system', content: NOVEL_OPENING }, { role: 'user', content: 'hi' }])

    expect(reply.status).toBe(400)
    expect(reply.type).toBe('channel_reject')
    // The upstream's wording is echoed back so support can see what arrived...
    expect(reply.message).toContain('first message is not system prompt')
  })
})

describe('the perturbation rung (issue #98, inside-the-prompt fingerprint)', () => {
  it('rescues a body the gateway refuses for a reason no opening rule can see', async () => {
    // This is the exact shape of the post-4.15.0 report: every scanned opening
    // already sits behind the neutral head (so the head rung is a no-op), and
    // the gateway still answers 11128 because it matches a substring INSIDE the
    // prompt. The perturbation changes no word, only where invisible characters
    // sit, and the retry succeeds.
    const mounted = mount({
      results: body => body.includes('\u200b')
        ? { ok: true, response: answer('2') }
        : failure(400, CHANNEL_REJECT_BODY),
    })
    shim = mounted.instance

    const { status, text } = await chat(shim, [
      { role: 'system', content: DSH_FINGERPRINT },
      { role: 'user', content: 'hi' },
    ])

    expect(status).toBe(200)
    expect(text).toContain('2')
  })
})
