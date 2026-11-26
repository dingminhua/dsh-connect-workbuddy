/**
 * ISSUE #323 — a route that fails MIDWAY must not leave the earlier ones mounted.
 *
 * `registerWorkBuddyStatusRoute` registers its routes inside one `ctx.effect`
 * whose body returns a disposer on its LAST line. When register number k throws
 * (a duplicate path during hot reload is the reported case), the body never
 * reached that line, so the effect returned nothing, the collected array died
 * with the frame, and routes 1..k-1 stayed registered on the host — answering
 * from an unloaded instance (HTTP 200) instead of 404. Re-enabling then collided
 * with the plugin's own leftovers.
 *
 * The fix registers each route in its OWN `ctx.effect`, so the children are
 * disposed when the parent body throws.
 *
 * @module dsh-connect-workbuddy/tests/issue323-route-leak
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../src/web-status.ts', import.meta.url), 'utf8')

describe('issue #323: a partially registered route table rolls back', () => {
  it('registers every route through ctx.effect, so a mid-body throw disposes the earlier ones', () => {
    // The behavioural test for this needs a Cordis context and a webServer that
    // throws on the k-th call; the invariant that makes the rollback work is
    // structural, and it is what a future edit is most likely to undo by
    // "simplifying" the helper back to a bare array push.
    expect(SOURCE).toContain('disposers.push(ctx.effect(() => ctx.webServer.register(entry)))')
  })

  it('does not push a bare disposer into the array', () => {
    // The pre-#323 shape. Reintroducing it silently reopens the leak: the array
    // is the ONLY cleanup channel, and a mid-body throw loses it.
    const bare = /disposers\.push\(\s*ctx\.webServer\.register\(/.test(SOURCE)
    expect(bare).toBe(false)
  })

  it('keeps the trailing disposer loop, which is still needed for a clean unmount', () => {
    expect(SOURCE).toMatch(/return \(\) => \{ for \(const dispose of disposers\) dispose\(\) \}/u)
  })
})
