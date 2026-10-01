/**
 * The wire contract of DSML recovery: what the CLIENT actually receives.
 *
 * `src/dsml-recovery.ts` is covered as a pure unit; this file pins the part
 * that only exists once it is wired into the response path — frame rewriting,
 * the hold window, and the single retry a markup-only turn is allowed.
 *
 * The regression that matters most here is NOT "does it recover a call" but
 * "does an ordinary answer still arrive unchanged". This path used to be
 * `body.pipe(res)`: a byte-for-byte pass-through that could not corrupt a
 * response even in principle. Everything below the recovery tests exists to
 * show that the ordinary cases still behave exactly as they did.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { FULLWIDTH_BAR, MARKUP_TOKEN } from '../src/dsml-recovery.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'

let shim: WorkBuddyShim | undefined
afterEach(async () => { await shim?.close(); shim = undefined })

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAtMs: Date.now() + 86_400_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid',
  source: 'desktop',
  filePath: '/tmp/auth.info',
}

const store = {
  resolve: async () => CREDENTIAL,
} as unknown as import('../src/auth.ts').WorkBuddyCredentialStore

const MARK = `${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}`

/** A request body that declares `bash`, i.e. recovery is allowed to run. */
function bodyWithTools(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'glm-5.3',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      type: 'function',
      function: { name: 'bash', parameters: { type: 'object', required: ['command'] } },
    }],
    ...extra,
  })
}

/** The markup shape this project actually captured, in one content frame. */
function leakedCall(name = 'bash', command = 'ls'): string {
  return `<${MARK}tool_calls><${MARK}invoke name="${name}">`
    + `<${MARK}parameter name="command">${command}</${MARK}parameter>`
    + `</${MARK}invoke></${MARK}tool_calls>`
}

/**
 * The shape this project captured in the wild: the tool name overwrote the
 * `invoke name="…"` clause, so there is no name to validate and no gate that
 * could ever accept it. This is the shape the retry-rule tests must use —
 * a RECOVERABLE leak never reaches the retry, because recovery handles it.
 */
function unrecoverableBlock(): string {
  return `<${MARK} validate>\n`
    + `<${MARK} parameter name="spec">{"title":"x"}</${MARK} parameter>\n`
    + `</${MARK} invoke>\n`
    + `</${MARKUP_TOKEN} calls>`
}

/** One SSE frame carrying assistant content. */
function contentFrame(content: string, finishReason = ''): string {
  return `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`
}

/** One SSE frame carrying a native, structured call. */
function nativeCallFrame(): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`
}

/** A response whose body is delivered as the given chunks, in order. */
function streamOf(chunks: readonly string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }))
}

/**
 * A response whose body fails after the given prefix.
 *
 * The error is raised on the SECOND pull rather than after `enqueue` in
 * `start`: `controller.error()` discards anything still queued, so erroring
 * immediately delivers nothing at all and the test would pass for the wrong
 * reason (it would assert on a stream that carried no bytes to lose).
 */
function brokenStreamOf(prefix: string): Response {
  const encoder = new TextEncoder()
  let pulled = 0
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      pulled += 1
      if (pulled === 1) {
        controller.enqueue(encoder.encode(prefix))
        return
      }
      // A tick of separation: without it the reader can observe the error
      // before it ever sees the queued prefix, and the test would assert on a
      // stream that never carried the bytes it means to lose.
      await new Promise(resolve => setTimeout(resolve, 10))
      controller.error(new Error('upstream died'))
    },
  }))
}

function makeShim(chatStream: (body: string, call: number) => WorkBuddyChatResult): WorkBuddyShim {
  let calls = 0
  return createWorkBuddyShim({
    store,
    client: {
      chatStream: async (_credential: WorkBuddyCredential, body: string): Promise<WorkBuddyChatResult> => {
        calls += 1
        return chatStream(body, calls)
      },
    } as unknown as import('../src/upstream.ts').WorkBuddyUpstreamClient,
    catalog: new WorkBuddyCatalog(),
  })
}

async function post(target: WorkBuddyShim, body: string): Promise<string> {
  const response = await fetch(`${target.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${target.token()}`, 'content-type': 'application/json' },
    body,
  })
  expect(response.status).toBe(200)
  return await response.text()
}

/** The parsed `data:` payloads of an SSE body, `[DONE]` included. */
function frames(body: string): Record<string, unknown>[] {
  return body.split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trim())
    .filter(payload => payload !== '[DONE]')
    .flatMap(payload => {
      try {
        return [JSON.parse(payload) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}

/** Every assistant text delta in an SSE body, concatenated. */
function visibleText(body: string): string {
  return frames(body).flatMap(frame => {
    const choices = frame['choices'] as { delta?: { content?: string } }[] | undefined
    const content = choices?.[0]?.delta?.content
    return typeof content === 'string' ? [content] : []
  }).join('')
}

/** Every recovered call in an SSE body. */
function callsIn(body: string): { name: string, arguments: string }[] {
  return frames(body).flatMap(frame => {
    const choices = frame['choices'] as
      | { delta?: { tool_calls?: { function?: { name?: string, arguments?: string } }[] } }[]
      | undefined
    return (choices?.[0]?.delta?.tool_calls ?? []).flatMap(call => [{
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '',
    }])
  })
}

describe('shim DSML recovery', () => {
  it('turns markup written into the text into a real tool call', async () => {
    shim = makeShim(() => ({ ok: true, response: streamOf([
      contentFrame(''),
      contentFrame(leakedCall()),
      contentFrame('', 'stop'),
      'data: [DONE]\n\n',
    ]) }))
    await shim.ready

    const body = await post(shim, bodyWithTools())
    expect(callsIn(body)).toEqual([{ name: 'bash', arguments: '{"command":"ls"}' }])
    expect(body).toContain('"finish_reason":"tool_calls"')
    // The markup itself must not survive as prose: that is the whole defect.
    expect(visibleText(body)).not.toContain(MARKUP_TOKEN)
    expect(visibleText(body)).not.toContain(MARK)
  })

  it('leaves an ordinary answer byte-for-byte unchanged', async () => {
    const chunks = [contentFrame('第一句。'), contentFrame('第二句。', 'stop'), 'data: [DONE]\n\n']
    shim = makeShim(() => ({ ok: true, response: streamOf(chunks) }))
    await shim.ready

    const body = await post(shim, bodyWithTools())
    expect(visibleText(body)).toBe('第一句。第二句。')
    expect(callsIn(body)).toEqual([])
    // Nothing invented: the frames the client sees carry the same content.
    expect(body).toContain('第一句。')
  })

  it('recovers every block when one response carries two', async () => {
    shim = makeShim(() => ({ ok: true, response: streamOf([
      contentFrame(leakedCall('bash', 'a') + leakedCall('bash', 'b')),
      contentFrame('', 'stop'),
      'data: [DONE]\n\n',
    ]) }))
    await shim.ready

    const body = await post(shim, bodyWithTools())
    expect(callsIn(body).map(call => call.arguments)).toEqual(['{"command":"a"}', '{"command":"b"}'])
  })

  it('forwards a request that declares no tools untouched (gate 3)', async () => {
    const chunks = [contentFrame(leakedCall()), contentFrame('', 'stop'), 'data: [DONE]\n\n']
    shim = makeShim(() => ({ ok: true, response: streamOf(chunks) }))
    await shim.ready

    const body = await post(shim, JSON.stringify({ model: 'glm-5.3', messages: [] }))
    expect(callsIn(body)).toEqual([])
    expect(body).toBe(chunks.join(''))
  })

  it('forwards tool_choice:none untouched', async () => {
    const chunks = [contentFrame(leakedCall()), contentFrame('', 'stop'), 'data: [DONE]\n\n']
    shim = makeShim(() => ({ ok: true, response: streamOf(chunks) }))
    await shim.ready

    // `prepareChatBody` deletes `tools` for this spelling, which is exactly why
    // gate 3 can read "nothing declared" from the prepared body.
    const body = await post(shim, bodyWithTools({ tool_choice: 'none' }))
    expect(callsIn(body)).toEqual([])
    expect(body).toBe(chunks.join(''))
  })

  it('stops recovering once the upstream sends a native call', async () => {
    shim = makeShim(() => ({ ok: true, response: streamOf([
      nativeCallFrame(),
      contentFrame(leakedCall()),
      contentFrame('', 'stop'),
      'data: [DONE]\n\n',
    ]) }))
    await shim.ready

    const body = await post(shim, bodyWithTools())
    // One call channel only: the native one. The later markup is left as the
    // text it is, rather than becoming a second, competing call.
    expect(callsIn(body)).toEqual([{ name: 'bash', arguments: '{"command":"pwd"}' }])
    expect(visibleText(body)).toContain(leakedCall())
  })

  it('shows an unclosed block as text and still terminates the stream', async () => {
    const truncated = leakedCall().slice(0, leakedCall().length - `</${MARK}invoke></${MARK}tool_calls>`.length)
    shim = makeShim(() => ({ ok: true, response: streamOf([contentFrame(truncated), contentFrame('', 'stop')]) }))
    await shim.ready

    const body = await post(shim, bodyWithTools())
    expect(callsIn(body)).toEqual([])
    expect(visibleText(body)).toContain(truncated)
    // The upstream never sent one, so the shim must end the stream itself.
    expect(body).toContain('data: [DONE]')
  })

  it('flushes text the buffer still held BEFORE a finish_reason frame', async () => {
    // The stream ends mid-marker (`<｜DSM`), so the buffer is still holding it,
    // and the upstream's finish frame has already arrived. Emitting the tail
    // after `finish_reason` would put the answer behind its own terminator: a
    // client that stops accumulating there loses the text silently.
    shim = makeShim(() => ({ ok: true, response: streamOf([
      contentFrame('先说话 <'),
      contentFrame(`${FULLWIDTH_BAR}DSM`),
      contentFrame('', 'stop'),
      'data: [DONE]\n\n',
    ]) }))
    await shim.ready

    const body = await post(shim, bodyWithTools())
    expect(callsIn(body)).toEqual([])
    expect(visibleText(body)).toBe(`先说话 <${FULLWIDTH_BAR}DSM`)

    const lines = body.split('\n').filter(line => line.startsWith('data:'))
    const lastContent = lines.findLastIndex(line => line.includes('"content"') && !line.includes('"content":""'))
    const finishAt = lines.findIndex(line => line.includes('"finish_reason":"stop"'))
    expect(finishAt).toBeGreaterThan(-1)
    expect(lastContent).toBeLessThan(finishAt)
  })

  it('synthesizes a terminator when the stream dies mid-flight', async () => {
    shim = makeShim(() => ({ ok: true, response: brokenStreamOf(contentFrame('半句话')) }))
    await shim.ready

    const body = await post(shim, bodyWithTools())
    expect(visibleText(body)).toBe('半句话')
    expect(body).toContain('data: [DONE]')
  })

  it('keeps frame order when a frame is split across writes', async () => {
    const whole = contentFrame('甲') + contentFrame('乙', 'stop') + 'data: [DONE]\n\n'
    shim = makeShim(() => ({ ok: true, response: streamOf([whole]) }))
    await shim.ready
    const oneShot = await post(shim, bodyWithTools())

    await shim.close()
    shim = makeShim(() => ({ ok: true, response: streamOf([...whole]) }))
    await shim.ready
    const byteWise = await post(shim, bodyWithTools())

    expect(visibleText(byteWise)).toBe(visibleText(oneShot))
    expect(callsIn(byteWise)).toEqual(callsIn(oneShot))
  })

  it('retries once when the whole turn was markup and nothing else', async () => {
    shim = makeShim((_body, call) => call === 1
      // Attempt 1: the turn wrote markup and no answer at all.
      ? { ok: true, response: streamOf([contentFrame(unrecoverableBlock()), contentFrame('', 'stop'), 'data: [DONE]\n\n']) }
      // Attempt 2: an ordinary answer.
      : { ok: true, response: streamOf([contentFrame('答完了。'), contentFrame('', 'stop'), 'data: [DONE]\n\n']) })
    await shim.ready

    const body = await post(shim, bodyWithTools())
    expect(visibleText(body)).toBe('答完了。')
    // The discarded attempt's bytes must not survive alongside the retry.
    expect(body).not.toContain(MARK)
  })

  it('does not retry once real prose has arrived', async () => {
    let seen = 0
    shim = makeShim(() => {
      seen += 1
      return { ok: true, response: streamOf([
        contentFrame('先说明一句。'),
        contentFrame(unrecoverableBlock()),
        contentFrame('', 'stop'),
        'data: [DONE]\n\n',
      ]) }
    })
    await shim.ready

    const body = await post(shim, bodyWithTools())
    expect(seen).toBe(1)
    // The prose closed the window, so the markup that followed is shown as text
    // rather than costing a second generation.
    expect(visibleText(body)).toContain(unrecoverableBlock())
  })

  it('shows the original text when the retry cannot start', async () => {
    shim = makeShim((_body, call) => call === 1
      ? { ok: true, response: streamOf([contentFrame(unrecoverableBlock()), contentFrame('', 'stop'), 'data: [DONE]\n\n']) }
      : { ok: false, status: 429, kind: 'soft_rate', message: 'rate limited' })
    await shim.ready

    const body = await post(shim, bodyWithTools())
    // Nothing usable arrived, so the honest outcome is to show what did.
    expect(visibleText(body)).toContain(MARK)
    expect(body).toContain('data: [DONE]')
  })
})
