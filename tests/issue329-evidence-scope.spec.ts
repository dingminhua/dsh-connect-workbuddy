/**
 * ISSUE #329 — the failure text must say WHICH two numbers it is showing.
 *
 * The reply lists a few "message openings the gateway scanned" and then says
 * "另有 N 条未列出". A reporter read that as "this request carries 8 scanned
 * messages" while his session held 759 `assistant/message` records, so he could
 * not tell a COMPLETE list from a WINDOW onto a long conversation — and that
 * distinction decides whether the list can be used as a coordinate for locating
 * a mid-text hit at all. (It was a window: excerpt capped at 8 by the
 * collector, then rendered at 4.)
 *
 * The cap stays — a wall of excerpts buries the one that matters — but the total
 * now travels with it.
 *
 * @module dsh-connect-workbuddy/tests/issue329-evidence-scope
 */
import { describe, expect, it } from 'vitest'
import { scannedMessageCount } from '../src/upstream.ts'

describe('issue #329: the scanned-message total is counted', () => {
  it('counts system, assistant and developer messages only', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' },
        { role: 'tool', content: 't', tool_call_id: 'c1' },
        { role: 'developer', content: 'd' },
      ],
    })
    // `developer` counts because prepareChatBody rewrites it to `system`.
    expect(scannedMessageCount(body)).toBe(3)
  })

  it('counts a long session in full, past the excerpt cap', () => {
    // The reporter's case: hundreds of assistant records, 8 in the excerpt.
    const messages: { role: string, content: string }[] = [{ role: 'system', content: 'sys' }]
    for (let index = 0; index < 200; index++) messages.push({ role: 'assistant', content: `m${index}` })
    expect(scannedMessageCount(JSON.stringify({ messages }))).toBe(201)
  })

  it('does not count messages whose role is absent or unreadable', () => {
    const body = JSON.stringify({ messages: [{ content: 'no role' }, { role: 42, content: 'bad' }, { role: 'system', content: 'ok' }] })
    expect(scannedMessageCount(body)).toBe(1)
  })

  it('tolowercases and trims the role, so casing does not hide a message', () => {
    // The classification must agree with the scan: ` SYSTEM ` and `System` are
    // both scanned by the gateway, so both must be counted.
    expect(scannedMessageCount(JSON.stringify({ messages: [{ role: ' SYSTEM ', content: 'a' }, { role: 'System', content: 'b' }] }))).toBe(2)
  })

  it('returns 0 for a body it cannot read instead of throwing', () => {
    // This runs while composing an ERROR message: a throw here would replace the
    // real failure with a parse exception.
    expect(scannedMessageCount('not json')).toBe(0)
    expect(scannedMessageCount('{}')).toBe(0)
    expect(scannedMessageCount('[1,2]')).toBe(0)
    expect(scannedMessageCount(JSON.stringify({ messages: 'nope' }))).toBe(0)
  })
})
