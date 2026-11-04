/**
 * Issue #213, seen from the reply: what the evidence block is allowed to imply.
 *
 * THE REPORT. A user switched a long-running session to `workbuddy/hy3-x` and
 * the next turn was refused with `11128`. The refusal named four openings, and
 * three of them were `assistant` messages whose text was the host's own
 * REASONING — the session had steps with no visible answer, so those assistant
 * messages carried the thinking text. The reply labelled them 「不在插件已知
 * 名单里，网关可能新增了词条」, and the reporter read that as "the plugin sent
 * these verbatim", then wrote a whole section proposing that unknown assistant
 * openings be neutralised too.
 *
 * THEY WERE NEUTRALISED. `forceNeutralHead()` (src/upstream.ts) puts the head in
 * front of EVERY scanned opening regardless of the measured list — it has done
 * so since 4.15.1, so the reporter's 5.11.0 ran it too. The refusal they pasted
 * came after all three rungs of the ladder, which their own report says ("插件
 * 已用强制中性头与一次不可见扰动与一次密集不可见扰动重试过").
 *
 * WHAT WAS ACTUALLY WRONG, and what these tests pin: the LABEL. It reported the
 * first attempt's first line and said nothing about (a) which rung had already
 * run, or (b) that the gateway matches an exact substring anywhere in the text,
 * not only at its start. Both are now in the reply, because the reply is the
 * part a reporter quotes back at us. See docs/CHANNEL-FINGERPRINT-RESEARCH.md
 * §5, which had listed the same two misleading points before the report arrived.
 *
 * @module dsh-connect-workbuddy/tests/issue213-channel-evidence
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

/** The live CN gateway's channel-gate reply (request id redacted). */
const CHANNEL_REJECT_BODY = JSON.stringify({
  code: 11128,
  msg: 'Illegal API invocation from an unapproved channel',
  requestId: 'd59f04e3-f8db-4c82-82a1-c5cbfbec969d',
  displayTips: {
    zh: '这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。',
  },
})

/** An opening from neither gateway's measured list — the unknown-fingerprint case. */
const REASONING_OPENING = 'The user shares a GitHub repo URL: https://github.com/example/repo and asks "这个插件不管用了？"'

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

function mount(script: { results: (body: string, call: number) => WorkBuddyChatResult }): {
  instance: WorkBuddyShim
  bodies: string[]
} {
  const bodies: string[] = []
  const instance = createWorkBuddyShim({
    store,
    client: {
      chatStream: async (_credential: WorkBuddyCredential, body: string): Promise<WorkBuddyChatResult> => {
        bodies.push(body)
        return script.results(body, bodies.length)
      },
    } as unknown as WorkBuddyUpstreamClient,
    catalog: new WorkBuddyCatalog(),
    onAccountFailure: () => undefined,
  })
  return { instance, bodies }
}

interface Reply {
  status: number
  message: string
  type: string
}

async function chat(instance: WorkBuddyShim, messages: Array<Record<string, unknown>>): Promise<Reply> {
  await instance.ready
  const response = await fetch(`${instance.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token()}` },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages }),
  })
  const text = await response.text()
  if (response.ok) return { status: response.status, message: '', type: '' }
  const parsed = JSON.parse(text) as { error: { message: string, type: string } }
  return { status: response.status, message: parsed.error.message, type: parsed.error.type }
}

/** The final attempt's assistant texts — the bodies the gateway actually refused. */
function assistantTexts(bodyJson: string): string[] {
  const body = JSON.parse(bodyJson) as { messages: Array<{ role: string, content: unknown }> }
  const texts: string[] = []
  for (const message of body.messages) {
    if (message.role !== 'assistant') continue
    if (typeof message.content === 'string') texts.push(message.content)
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        const record = part as Record<string, unknown>
        if (record?.['type'] === 'text' && typeof record['text'] === 'string') texts.push(record['text'])
      }
    }
  }
  return texts
}

/** The text the model reads: every invisible break removed. */
function stripBreaks(text: string): string {
  return text.replace(/\u200b/gu, '')
}

describe('the evidence block, after issue #213', () => {
  it('quotes every reasoning-shaped assistant opening and names its role', async () => {
    const mounted = mount({ results: () => failure(400, CHANNEL_REJECT_BODY) })
    shim = mounted.instance

    const reply = await chat(shim, [
      { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' },
      { role: 'user', content: '这个插件不管用了？' },
      // The shape issue #213 reported: a step with reasoning but no visible answer.
      { role: 'assistant', content: REASONING_OPENING },
      { role: 'assistant', content: 'Web fetch failed due to DNS resolving to non-public IP (maybe blocked or local).' },
      { role: 'user', content: '再试试' },
    ])

    expect(reply.status).toBe(400)
    expect(reply.type).toBe('channel_reject')
    // The reader can see WHICH messages the gateway scanned, with their role:
    // an `assistant` entry is a history message, i.e. the whole session fails
    // until something changes.
    expect(reply.message).toContain(`「assistant：${REASONING_OPENING}，共 ${REASONING_OPENING.length} 字」`)
    expect(reply.message).toContain('「assistant：Web fetch failed due to DNS resolving to non-public IP')
  })

  it('says the head retry already covered every opening, instead of implying the opening went out verbatim', async () => {
    const mounted = mount({ results: () => failure(400, CHANNEL_REJECT_BODY) })
    shim = mounted.instance

    const reply = await chat(shim, [
      { role: 'system', content: REASONING_OPENING },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: `${REASONING_OPENING}\n\nand then I looked at the README.` },
      { role: 'user', content: 'and?' },
    ])

    // The three rungs really did run — this is the fact the reporter of #213
    // could not see, and their report argued the opposite from our label.
    expect(mounted.bodies.length).toBeGreaterThan(1)
    const finalAttempt = mounted.bodies[mounted.bodies.length - 1] ?? ''
    const forcedAssistantTexts = assistantTexts(finalAttempt)
    expect(forcedAssistantTexts.length).toBeGreaterThan(0)
    for (const text of forcedAssistantTexts) {
      // The perturbation rung inserts an invisible break into the head itself
      // (it ends with `.`, which is exactly where the sparse rule lands), so the
      // claim is about the text the MODEL reads, not about the raw bytes.
      expect(stripBreaks(text).startsWith(`${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n`)).toBe(true)
    }
    // And the reply now states it, next to the openings it applies to.
    expect(reply.message).toContain('这次重试里每一条被扫描消息都已经加了中性头，仍然被拒')
    // The label no longer claims to know more than the first line.
    expect(reply.message).toContain('（不在插件已知名单里，仅指首行）')
    expect(reply.message).toContain('只说明该消息的首行不是已知指纹')
    // The two sentences that produced the false lead are gone.
    expect(reply.message).not.toContain('网关可能新增了词条')
    expect(reply.message).not.toContain('请修改该提示')
  })

  it('does not claim a forced-head retry that never ran', async () => {
    // Every scanned opening already starts with the neutral head, so
    // `forceNeutralHead` cannot change the body and that rung is skipped. The
    // reply must not say it happened — a sentence about a retry that never ran
    // is the same class of error as a label about a prefix nobody checked.
    const mounted = mount({ results: () => failure(400, CHANNEL_REJECT_BODY) })
    shim = mounted.instance

    const reply = await chat(shim, [
      { role: 'system', content: `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\nSummarise the repo.` },
      { role: 'user', content: 'hi' },
    ])

    expect(reply.status).toBe(400)
    expect(reply.message).not.toContain('这次重试里每一条被扫描消息都已经加了中性头')
    expect(reply.message).toContain('并已用一次不可见扰动')
  })
})
