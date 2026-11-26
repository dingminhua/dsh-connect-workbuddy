/**
 * ISSUE #298 — the bare-markup recovery must survive the SHIM, not just the buffer.
 *
 * WHY THIS FILE EXISTS. The first version of the feature returned recovered
 * calls from `DsmlStreamBuffer.flush()`, and a bare block has no marker — so
 * `flush()` is the ONLY place such a call can ever be produced. But the two
 * flush consumers in `shim.ts` read only `flushed.text` and ignored
 * `flushed.calls`. Net effect on the real request path:
 *
 *     flush() stripped the protocol bytes  →  the user saw a truncated answer
 *     flush() returned the call            →  nobody read it
 *
 * So the whole feature was inert in production while its 12 unit tests passed:
 * a call was silently destroyed, with no tool execution, no notice and no
 * retry — the exact failure mode the module's own gate 4 forbids ("visible
 * debris beats deleted content").
 *
 * These tests drive the real HTTP surface and assert on the SSE frames, because
 * a unit test cannot see a dropped call. Reviewers asked for precisely this.
 *
 * @module dsh-connect-workbuddy/tests/issue298-bare-shim-e2e
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'

/** The shape captured in the wild: one `delta.content`, no marker anywhere. */
const LEAK = '好的，我列两个选项：\n<ask_user_question>\n<questions</arg_key><arg_value>[{"header":"Pick"}]</arg_value></tool_call>'

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAtMs: Date.now() + 86_400_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid-e2e',
  uin: '100000000001',
  source: 'desktop',
  filePath: '/tmp/auth-e2e.info',
}

let shim: WorkBuddyShim | undefined
afterEach(async () => { await shim?.close(); shim = undefined })

/** An SSE body carrying one content delta, then a stop, then `[DONE]`. */
function sseWithContent(text: string): string {
  const chunk = {
    id: 'c1',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  }
  const stop = { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(stop)}\n\ndata: [DONE]\n\n`
}

async function run(body: string): Promise<string> {
  const result: WorkBuddyChatResult = {
    ok: true,
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  }
  shim = createWorkBuddyShim({
    store: {
      resolve: async () => CREDENTIAL,
      credentialFor: async () => CREDENTIAL,
    } as never,
    catalog: new WorkBuddyCatalog(),
    client: { chatStream: async () => result } as never,
  })
  await shim.ready
  const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
    body: JSON.stringify({
      model: 'hy4flash-free',
      stream: true,
      messages: [{ role: 'user', content: 'ask me something' }],
      tools: [{
        type: 'function',
        function: {
          name: 'ask_user_question',
          parameters: {
            type: 'object',
            properties: { questions: { type: 'string' } },
            required: ['questions'],
          },
        },
      }],
    }),
  })
  return await response.text()
}

describe('issue #298: a bare call reaches the CLIENT, not just the buffer', () => {
  it('emits a tool_calls frame and never leaks the protocol text', async () => {
    const wire = await run(sseWithContent(LEAK))
    // THE decisive assertion: the call must be delivered. Before the fix this
    // frame did not exist at all.
    expect(wire, 'the recovered call must reach the client').toContain('tool_calls')
    expect(wire).toContain('"name":"ask_user_question"')
    expect(wire).toContain('"finish_reason":"tool_calls"')
    // The protocol bytes must NOT be readable as prose.
    expect(wire).not.toContain('arg_key')
    expect(wire).not.toContain('arg_value')
    expect(wire).not.toContain('</tool_call>')
    // The prose before the block survives, exactly.
    const contents = [...wire.matchAll(/"content":"((?:[^"\\]|\\.)*)"/gu)].map(match => match[1] ?? '')
    expect(contents.join('')).toBe('好的，我列两个选项：\\n')
  })

  it('sends the call BEFORE the terminator, so a client that stops at finish_reason gets it', async () => {
    // Ordering that matters: the prose legitimately leaves on the `add()` path
    // (only the BLOCK is held), so prose-then-call is the correct order here.
    // What must never happen is the call arriving after `[DONE]` — a client that
    // stops accumulating at the terminator would lose it entirely.
    const wire = await run(sseWithContent(LEAK))
    const callsAt = wire.indexOf('tool_calls')
    const doneAt = wire.indexOf('[DONE]')
    expect(callsAt).toBeGreaterThanOrEqual(0)
    expect(doneAt).toBeGreaterThanOrEqual(0)
    expect(callsAt, 'the call must precede the terminator').toBeLessThan(doneAt)
  })

  it('still shows prose it cannot recover, rather than deleting it', async () => {
    // Gate 4's promise on the real path: an unrecognisable block is DISPLAYED.
    const wire = await run(sseWithContent('You can write <ask_user_question> to ask.'))
    expect(wire).toContain('You can write')
    expect(wire).toContain('to ask.')
    expect(wire).not.toContain('tool_calls')
  })
})
