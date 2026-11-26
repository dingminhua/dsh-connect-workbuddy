/**
 * ISSUE #311 — zero-privacy diagnostic for middle-of-prompt channel gates.
 *
 * A 259k-character system prompt has tens of thousands of candidate lines;
 * "first line + byte count" cannot localise the matched span. The trace reports
 * ONLY counts and line numbers of a fixed identity/brand vocabulary plus a
 * rewrite self-check — never a byte of message text — so it is safe to paste
 * into a public issue.
 *
 * @module dsh-connect-workbuddy/tests/issue311-fingerprint-trace
 */
import { describe, expect, it, afterEach } from 'vitest'
import { channelFingerprintTrace, prepareChatBody } from '../src/upstream.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'

describe('issue #311: zero-privacy fingerprint trace', () => {
  it('counts brand words by line number, without returning any message text', () => {
    const raw = JSON.stringify({
      messages: [
        { role: 'system', content: 'First line.\nYou are an AI agent powered by DeepSeek Harness.\nMid.\nYou are working inside DeepSeek Harness Web GUI.\nEnd.' },
        { role: 'user', content: 'DeepSeek Harness in a user message is not scanned.' },
      ],
    })
    const trace = channelFingerprintTrace(raw, raw)
    const system = trace.occurrences.get(0)
    expect(system).toBeDefined()
    // Two lines carry "DeepSeek Harness": line 2 and line 4.
    expect(system?.get('DeepSeek Harness')).toEqual([2, 4])
    // The user message is not scanned — no occurrence for index 1.
    expect(trace.occurrences.has(1)).toBe(false)
    // No text is returned anywhere in the structure.
    expect(JSON.stringify(trace)).not.toContain('First line')
    expect(JSON.stringify(trace)).not.toContain('Mid.')
  })

  it('reports which known rewrite rows are still present in the prepared body', () => {
    const raw = JSON.stringify({
      messages: [{ role: 'system', content: 'You are an AI agent powered by DeepSeek Harness. Do work.' }],
    })
    // A body that was never rewritten still carries the row-1 `from`.
    const unrewritten = channelFingerprintTrace(raw, raw).unrewrittenRows
    expect(unrewritten).toContain(1)
    // The actual prepared body has that phrase rewritten, so row 1 is gone.
    const prepared = prepareChatBody(raw, {})
    const clean = channelFingerprintTrace(raw, prepared).unrewrittenRows
    expect(clean).not.toContain(1)
  })

  it('is empty and safe on unparseable bodies', () => {
    expect(channelFingerprintTrace('not json', 'not json')).toEqual({ occurrences: new Map(), unrewrittenRows: [] })
    expect(channelFingerprintTrace('[]', '[]').occurrences.size).toBe(0)
  })
})

describe('issue #311: the trace reaches the refusal text, with no message body', () => {
  let shim: ReturnType<typeof createWorkBuddyShim> | undefined
  afterEach(async () => { await shim?.close(); shim = undefined })

  it('appends zero-privacy clues to a channel-reject answer without echoing message text', async () => {
    const SECRET = 'SECRET-PAYLOAD-DO-NOT-LEAK- Shelley'
    const client = {
      chatStream: async (): Promise<WorkBuddyChatResult> => ({
        ok: false,
        status: 400,
        kind: 'channel_reject',
        message: '被网关的渠道校验拦截（code 11128）',
      }),
    } as unknown as import('../src/upstream.ts').WorkBuddyUpstreamClient
    shim = createWorkBuddyShim({
      store: {
        resolve: async () => ({
          accessToken: 'token', refreshToken: 'refresh', domain: 'www.codebuddy.cn',
          uid: 'uid', expiresAt: Date.now() + 86_400_000, refreshExpiresAt: Date.now() + 7 * 86_400_000,
          filePath: '/tmp/auth.info', source: 'desktop',
        }),
        credentialFor: async () => undefined,
      } as unknown as import('../src/auth.ts').WorkBuddyCredentialStore,
      client,
      catalog: new WorkBuddyCatalog(),
    })
    await shim.ready
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        // The canary sits in the MIDDLE: the first/last-line evidence may echo
        // the opening and closing, but a middle-only secret must never appear.
        messages: [{ role: 'system', content: `You are an AI agent powered by DeepSeek Harness.\n${SECRET}\nA plain closing line.` }],
      }),
    })
    const text = await response.text()
    expect(response.status).toBe(400)
    expect(text).toContain('零正文指纹线索')
    expect(text).toContain('改词自检')
    // The trace echoes only counts + line numbers: a middle-only canary —
    // which the first/last-line evidence cannot reach — must never appear.
    expect(text).not.toContain(SECRET)
  })
})

describe('issue #319: reasoning_content is part of the trace', () => {
  it('counts brand words in reasoning_content and marks them as such', () => {
    // The gateway scans the whole request text, and replayed thinking is a
    // STRING FIELD on the assistant message (not a content part). It used to be
    // invisible to this trace, so a refusal caused by thinking looked the same
    // as one caused by nothing.
    const raw = JSON.stringify({
      messages: [
        { role: 'system', content: 'A clean system prompt.' },
        { role: 'assistant', content: 'A clean answer.', reasoning_content: 'first line\nI am DeepSeek Harness here' },
      ],
    })
    const trace = channelFingerprintTrace(raw, raw)
    const assistant = trace.occurrences.get(1)
    expect(assistant, 'the reasoning field must be traced').toBeDefined()
    // Marked with its field name, so a hit there cannot be read as a content hit.
    expect(assistant?.get('DeepSeek Harness（reasoning_content）')).toEqual([2])
    // …and no plain content entry was invented.
    expect(assistant?.get('DeepSeek Harness')).toBeUndefined()
    // Still no text anywhere in the structure.
    expect(JSON.stringify(trace)).not.toContain('I am')
  })
})

describe('issue #322: tool_calls arguments are counted too', () => {
  it('reports brand hits inside tool_calls arguments, marked with the field', () => {
    // Agentic sessions carry the brand mostly in TOOL PARAMETERS — one reported
    // sample had 45 hits there and none in content. Counting them is what makes
    // the trace honest about a body the plugin deliberately does not rewrite:
    // altering `arguments` would change what the call MEANS (a write call's file
    // content), so the fix is to report, not to edit.
    const raw = JSON.stringify({
      messages: [
        { role: 'system', content: 'An ordinary prompt.' },
        {
          role: 'assistant',
          content: 'I will read it.',
          tool_calls: [{
            id: 'c1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"/work/DeepSeek Harness/src/a.ts"}' },
          }],
        },
      ],
    })
    const trace = channelFingerprintTrace(raw, raw)
    const assistant = trace.occurrences.get(1)
    expect(assistant?.get('DeepSeek Harness（tool_calls[0].arguments）')).toEqual([1])
    // No text leaks into the structure — counts and line numbers only.
    expect(JSON.stringify(trace)).not.toContain('/work/')
  })

  it('does not flag an ordinary tool call', () => {
    const raw = JSON.stringify({
      messages: [{
        role: 'assistant',
        content: 'ok',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"/tmp/a.ts"}' } }],
      }],
    })
    expect(channelFingerprintTrace(raw, raw).occurrences.has(0)).toBe(false)
  })
})
