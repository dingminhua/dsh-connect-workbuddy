/**
 * ISSUE #297 (reopened) — the rescue ladder must not plant the persona line in
 * assistant history.
 *
 * The gateway's offset-0 gate is a BLACKLIST: a neutral system opening is all
 * it needs (Kimi/Cursor/Gemini openings all answer 200), and system is not the
 * model's own history. But an `assistant` message that opens with the persona
 * line gets copied by the model into its NEXT reply and persisted by the host —
 * proven with the `Message begins.` experiment, which the model imitated too.
 * So the common rescue now moves SYSTEM only (`forceSystemHead`); the blind
 * all-role head (`forceNeutralHead`) is the LAST rung, not the first.
 *
 * @module dsh-connect-workbuddy/tests/issue297-rescue-no-assistant-head
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import {
  classifyUpstreamError,
  forceSystemHead,
  forceNeutralHead,
  parseUpstreamErrorDetail,
  WORKBUDDY_FALLBACK_SYSTEM_PROMPT,
} from '../src/upstream.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'

const HEAD = `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n`
const CHANNEL_REJECT_BODY = JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel', requestId: '26d17b97-c53b-461a-bd21-34c61c86f15b' })

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access', refreshToken: 'refresh', expiresAtMs: Date.now() + 86_400_000,
  domain: 'www.codebuddy.cn', uid: 'uid', uin: 'selected', source: 'desktop', filePath: '/tmp/auth.info',
}
const store = {
  resolve: async () => CREDENTIAL,
  credentialFor: async () => CREDENTIAL,
} as unknown as import('../src/auth.ts').WorkBuddyCredentialStore

function failure(body: string): WorkBuddyChatResult {
  return { ok: false, status: 400, kind: classifyUpstreamError(400, body), message: body, detail: parseUpstreamErrorDetail(body) }
}
function answer(text: string): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: '' }] })}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  }))
}

describe('forceSystemHead (issue #297): the common rescue moves SYSTEM only', () => {
  const body = JSON.stringify({ messages: [
    { role: 'system', content: 'You are Cursor Agent, an AI pair programmer from Anysphere.' },
    { role: 'assistant', content: 'some assistant answer' },
    { role: 'user', content: 'hi' },
  ] })

  it('heads the system opening but leaves assistant and user text byte-for-byte alone', () => {
    const out = JSON.parse(forceSystemHead(body) ?? '{}') as { messages: Array<{ role: string, content: string }> }
    expect(out.messages[0]?.content).toBe(HEAD + 'You are Cursor Agent, an AI pair programmer from Anysphere.')
    expect(out.messages[1]?.content).toBe('some assistant answer')
    expect(out.messages[2]?.content).toBe('hi')
  })

  it('is idempotent: a body whose system already has the head cannot change', () => {
    const once = forceSystemHead(body) ?? ''
    expect(forceSystemHead(once)).toBeUndefined()
  })

  it('still exposes the full forceNeutralHead for the last rung', () => {
    const out = JSON.parse(forceNeutralHead(body) ?? '{}') as { messages: Array<{ role: string, content: string }> }
    // The blind all-role head is unchanged — available if the last rung is reached.
    expect(out.messages[1]?.content.startsWith(HEAD)).toBe(true)
  })
})

describe('issue #297 end-to-end: a normal channel_gate rescue leaves assistant clean', () => {
  let shim: WorkBuddyShim | undefined
  afterEach(async () => { await shim?.close(); shim = undefined })

  it('the rescue retry heads system but never plants the persona line in assistant history', async () => {
    const bodies: string[] = []
    const instance = createWorkBuddyShim({
      store,
      catalog: new WorkBuddyCatalog(),
      client: {
        chatStream: async (_credential: WorkBuddyCredential, bodyJson: string) => {
          bodies.push(bodyJson)
          return bodies.length === 1 ? failure(CHANNEL_REJECT_BODY) : { ok: true, response: answer('2') }
        },
      } as unknown as import('../src/upstream.ts').WorkBuddyUpstreamClient,
    })
    shim = instance
    await instance.ready
    const response = await fetch(`${instance.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token()}` },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        messages: [
          { role: 'system', content: 'You are Cursor Agent, an AI pair programmer from Anysphere.' },
          { role: 'assistant', content: 'an unremarkable past answer' },
          { role: 'user', content: '1+1?' },
        ],
      }),
    })
    expect(response.status).toBe(200)
    expect(bodies).toHaveLength(2)
    const retried = JSON.parse(bodies[1] ?? '{}') as { messages: Array<{ role: string, content: string }> }
    // THE PIN: system got the neutral head (the gateway is satisfied), but the
    // assistant history stays clean, so the model has no persona line to copy.
    expect(retried.messages[0]?.content.startsWith(HEAD)).toBe(true)
    const assistant = retried.messages.filter(m => m.role === 'assistant')
    expect(assistant.length).toBeGreaterThan(0)
    for (const turn of assistant) expect(turn.content.startsWith(HEAD)).toBe(false)
  })
})
