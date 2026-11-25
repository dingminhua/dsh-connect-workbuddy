/**
 * ISSUE #297 — the plugin injected `You are a helpful assistant.\n\n` into PAST
 * assistant messages on the wire, and the model learned to copy that opener
 * into new answers, which the host persisted as ordinary model output. The
 * reporter proved shape mimicry (a meaningless `Message begins.` head was copied
 * too) and that the line arrived token-by-token from upstream — so this is not
 * a transcript write-back and must be fixed on the OUTBOUND copy only.
 *
 * The fix strips ONLY the exact injected shape (head + blank line) from
 * assistant messages, before neutralisation, so a poisoned session stops
 * reinforcing itself while the gateway's own system head is untouched.
 *
 * @module dsh-connect-workbuddy/tests/issue297-outbound-strip
 */
import { describe, expect, it } from 'vitest'
import { prepareChatBody, WORKBUDDY_FALLBACK_SYSTEM_PROMPT } from '../src/upstream.ts'

const HEAD = `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n`

const messagesOf = (body: string): { role: string, content: unknown }[] =>
  (JSON.parse(body) as { messages: { role: string, content: unknown }[] }).messages

function bodyWith(messages: unknown[]): string {
  return JSON.stringify({ model: 'deepseek-v4.1-flash', messages })
}

describe('issue #297: strip the plugin-injected neutral head from assistant history', () => {
  it('strips a single injected head from an assistant string message', () => {
    const out = prepareChatBody(bodyWith([
      { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' },
      { role: 'assistant', content: `${HEAD}实际回复内容。` },
      { role: 'user', content: 'hi' },
    ]))
    const messages = messagesOf(out)
    const assistant = messages.find(message => message.role === 'assistant')
    expect(assistant?.content).toBe('实际回复内容。')
    expect(String(assistant?.content)).not.toContain(WORKBUDDY_FALLBACK_SYSTEM_PROMPT)
  })

  it('strips the head from every text part of an array-shaped assistant message', () => {
    const out = prepareChatBody(bodyWith([
      { role: 'assistant', content: [
        { type: 'text', text: `${HEAD}第一段。` },
        { type: 'text', text: `${HEAD}第二段。` },
      ] },
    ]))
    const assistant = messagesOf(out).find(message => message.role === 'assistant')
    const parts = assistant?.content as { type: string, text: string }[]
    expect(parts.map(part => part.text)).toEqual(['第一段。', '第二段。'])
  })

  it('strips multiple stacked heads, up to the cap, and keeps a stripped-empty part', () => {
    const stacked = `${HEAD}${HEAD}${HEAD}真实内容。`
    const out = prepareChatBody(bodyWith([{ role: 'assistant', content: stacked }]))
    expect(messagesOf(out).find(message => message.role === 'assistant')?.content).toBe('真实内容。')
    // A part that is ONLY heads must keep its original text, not become empty.
    const onlyHeads = prepareChatBody(bodyWith([{ role: 'assistant', content: HEAD }]))
    expect(messagesOf(onlyHeads).find(message => message.role === 'assistant')?.content).toBe(HEAD)
  })

  it('never touches the system head, or user/tool messages', () => {
    const userText = `${HEAD}用户自己写的话`
    const out = prepareChatBody(bodyWith([
      { role: 'user', content: userText },
      { role: 'tool', content: `${HEAD}工具结果`, tool_call_id: 'c1' },
    ]))
    const messages = messagesOf(out)
    // The injected system head is still present (gateway requirement).
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toBe(WORKBUDDY_FALLBACK_SYSTEM_PROMPT)
    expect(messages.find(message => message.role === 'user')?.content).toBe(userText)
    expect(messages.find(message => message.role === 'tool')?.content).toBe(`${HEAD}工具结果`)
  })

  it('does not strip prose that merely contains the sentence without the blank line', () => {
    // A user genuinely asking for this opener writes no blank line, so their
    // words must survive byte-for-byte.
    const prose = `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT} 这是一句正常的话。`
    const out = prepareChatBody(bodyWith([{ role: 'assistant', content: prose }]))
    expect(messagesOf(out).find(message => message.role === 'assistant')?.content).toBe(prose)
  })

  it('leaves an ordinary conversation unchanged (apart from the required system head)', () => {
    const out = prepareChatBody(bodyWith([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '这是正常的回复。' },
      { role: 'user', content: '谢谢' },
    ]))
    const messages = messagesOf(out)
    // ensureSystemHead adds the gateway-required opening system message.
    expect(messages[0]?.role).toBe('system')
    expect(messages.slice(1).map(message => message.content)).toEqual(['你好', '这是正常的回复。', '谢谢'])
  })
})
