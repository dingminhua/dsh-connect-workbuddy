/**
 * ISSUE #323 — a route that fails MIDWAY must not leave the earlier ones mounted.
 *
 * `registerWorkBuddyStatusRoute` registers its routes inside one `ctx.effect`
 * whose body returns a disposer on its LAST line. When register number k throws
 * (a duplicate path during hot reload is the reported case), the body never
 * reached that line, so routes 1..k-1 stayed registered on the host — answering
 * from an unloaded instance (HTTP 200) instead of 404. Re-enabling then collided
 * with the plugin's OWN leftovers and only a host restart recovered.
 *
 * HOW THE FIX WORKS, and what this file therefore asserts. Each route is
 * registered in its OWN `ctx.effect`, which puts its wrapper on the FIBER's
 * disposable list. A throwing body does NOT dispose anything at that instant —
 * the rollback happens when the fiber unloads. Review measured this against real
 * Cordis (4.1.0, `fiber.ts`): the children are disposed on `_unload`, not by the
 * parent effect's catch.
 *
 * So the property worth pinning is "after the fiber is torn down, none of the
 * routes that had registered are still mounted". The first version of this file
 * asserted the presence of a source STRING instead; review showed that stayed
 * green when the body was wrapped in a `try/catch`, which keeps the fiber alive
 * and reproduces the leak exactly. Hence a behavioural test.
 *
 * @module dsh-connect-workbuddy/tests/issue323-route-leak
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { registerWorkBuddyStatusRoute } from '../src/web-status.ts'

/** A webServer whose register fails on the k-th call, recording every mount. */
function failingWebServer(failAt: number): {
  webServer: { register(entry: { path: string }): () => void }
  mounted: Set<string>
} {
  const mounted = new Set<string>()
  let calls = 0
  return {
    mounted,
    webServer: {
      register(entry: { path: string }): () => void {
        calls += 1
        if (calls === failAt) throw new Error('duplicate path')
        mounted.add(entry.path)
        return () => { mounted.delete(entry.path) }
      },
    },
  }
}

describe('issue #323: a partially registered route table is torn down with the plugin', () => {
  it('leaves NO route mounted after the fiber unloads, when register #3 throws', async () => {
    const ctx = new Context()
    const { webServer, mounted } = failingWebServer(3)
    ;(ctx as unknown as { webServer: unknown }).webServer = webServer

    // The throw must reach the caller — that is the precondition the rollback
    // depends on, so it is asserted rather than assumed.
    expect(() => registerWorkBuddyStatusRoute(ctx as never, {} as never)).toThrow('duplicate path')
    expect(mounted.size, 'the earlier routes are still mounted until the fiber unloads').toBe(2)

    await (ctx as unknown as { fiber: { dispose(): Promise<void> } }).fiber.dispose()

    // THE property under test. Before the fix this stayed at 2 for ever.
    expect(mounted.size, 'every route must be unmounted with the fiber').toBe(0)
  })

  it('does not leak when the FIRST register throws either', async () => {
    const ctx = new Context()
    const { webServer, mounted } = failingWebServer(1)
    ;(ctx as unknown as { webServer: unknown }).webServer = webServer
    expect(() => registerWorkBuddyStatusRoute(ctx as never, {} as never)).toThrow('duplicate path')
    expect(mounted.size).toBe(0)
    await (ctx as unknown as { fiber: { dispose(): Promise<void> } }).fiber.dispose()
    expect(mounted.size).toBe(0)
  })

  it('unmounts every route on a clean unload', async () => {
    const ctx = new Context()
    const { webServer, mounted } = failingWebServer(Number.POSITIVE_INFINITY)
    ;(ctx as unknown as { webServer: unknown }).webServer = webServer
    registerWorkBuddyStatusRoute(ctx as never, {} as never)
    expect(mounted.size, 'a healthy mount registers the whole table').toBeGreaterThan(1)
    await (ctx as unknown as { fiber: { dispose(): Promise<void> } }).fiber.dispose()
    expect(mounted.size, 'a clean unload must remove them all').toBe(0)
  })
})
