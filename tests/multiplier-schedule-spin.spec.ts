/**
 * The scheduled price refresh must not spin when a region is switched off.
 *
 * THE DEFECT THIS PINNS. The tick's "this region is off" branch re-armed itself
 * with `nextMultiplierRefreshDelayMs`, which answers `0` for a never-run state —
 * and a region switched off before its FIRST tick has exactly that state. So the
 * timer woke up, found the region still off, and armed another zero-length timer,
 * forever. `enabled: false` is a documented, persistently saved region state, and
 * the feature is opt-out, so this started on boot and ran until the process
 * exited.
 *
 * WHY THE ASSERTION IS A TIMER COUNT. The spin is not a wrong value anywhere —
 * every individual re-arm looks reasonable, and the state stays consistent. What
 * is wrong is that ticks keep happening at all, so the only honest check is "did
 * another timer appear after the work was done".
 *
 * @module dsh-connect-workbuddy/tests/multiplier-schedule-spin
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as WorkBuddy from '../src/index.ts'

const realFetch = globalThis.fetch
let context: Context | undefined
let liveConfig: Record<string, unknown> = {}

/**
 * The 0.1.7-shaped settings service, copied from the issue #214 harness: it
 * answers the object the plugin was mounted with, so the plugin reads its own
 * config through the same path the real Loader provides.
 */
class MemorySettings extends Service {
  constructor(ctx: Context) { super(ctx, 'settings') }
  configure() { return () => {} }
  describe() {
    return [{ ns: WorkBuddy.WORKBUDDY_SETTINGS_NS, autoGenerate: true, revision: 0, applies: 'live', value: liveConfig }]
  }
  async update(_ns: string, patch: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(patch)) liveConfig[key] = structuredClone(value)
    ;(context as unknown as { emit(name: string): void })?.emit('loader/volatile-update')
  }
  async mutate(_ns: string, ops: { op: string, path: string[], value: unknown }[]): Promise<void> {
    for (const op of ops) liveConfig[op.path[0] as string] = structuredClone(op.value)
  }
}

/** A domestic account on disk, so no region fails for the wrong reason. */
async function cnAuthFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-spin-'))
  const dir = join(root, 'auth')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'workbuddy-desktop-ai.info')
  await writeFile(file, JSON.stringify({
    account: { uid: 'uid-cn', uin: '100000000001', nickname: 'Alpha', enterpriseId: '' },
    auth: {
      accessToken: 'token-cn', refreshToken: 'refresh-cn', tokenType: 'Bearer',
      domain: 'www.codebuddy.cn', expiresAt: Date.now() + 86_400_000,
      refreshExpiresAt: Date.now() + 7 * 86_400_000,
    },
  }), 'utf8')
  return file
}

afterEach(async () => {
  vi.useRealTimers()
  globalThis.fetch = realFetch
  await context?.fiber.dispose()
  context = undefined
  liveConfig = {}
})

/**
 * Mount the plugin with every region switched OFF.
 *
 * Both regions, because the arm is per region: leaving one on would let its
 * (legitimate) startup refresh cover for the other's spin.
 */
async function mountAllRegionsOff(): Promise<{ zeroDelayArms: () => number }> {
  const authFile = await cnAuthFile()
  liveConfig = {
    authFile,
    regions: { cn: { enabled: false }, global: { enabled: false } },
  }
  // Every upstream call fails: this test is about WHEN the timer fires, and a
  // reachable stub would add an await the assertion does not need.
  globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch

  let zeroDelayArms = 0
  vi.useFakeTimers()
  // Capture AFTER `useFakeTimers`, so the count observes every arm while the
  // FAKE clock still owns the scheduling. Capturing before would hand the plugin
  // the real timer, and `advanceTimersByTimeAsync` would then drive nothing —
  // the test would pass on wall-clock luck rather than on the fake timeline it
  // claims to assert.
  const fakeSetTimeout = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: () => void,
    delayMs?: number,
  ) => {
    if (delayMs === 0) zeroDelayArms += 1
    return fakeSetTimeout(handler, delayMs)
  }) as typeof setTimeout)

  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemorySettings)
  WorkBuddy.apply(ctx, liveConfig as WorkBuddy.Config)
  return { zeroDelayArms: () => zeroDelayArms }
}

describe('the scheduled price refresh never spins on a switched-off region', () => {
  it('stops arming zero-delay timers once the disabled regions have been skipped', async () => {
    const arms = await mountAllRegionsOff()

    // The FIRST zero-delay arm per region is the startup refresh `apply` seeds —
    // that one is expected, and it is what makes the feature act immediately.
    // Let those run.
    await vi.advanceTimersByTimeAsync(0)
    const afterStartup = arms.zeroDelayArms()
    expect(afterStartup, 'startup must arm each region once').toBe(2)

    // The tick now returns without re-arming. If it re-armed a zero-delay timer,
    // advancing again re-enters it, and the count grows — that growth IS the
    // spin. A handful of rounds is enough: the real defect looped without end.
    for (let round = 0; round < 3; round += 1) {
      await vi.advanceTimersByTimeAsync(0)
      expect(
        arms.zeroDelayArms(),
        `no zero-delay timer may be armed after the disabled-region skip (round ${String(round)})`,
      ).toBe(afterStartup)
    }

    // And no pending zero-length timer is left behind either: a timer scheduled
    // for "now" that nobody fires is still a spin waiting to happen once the
    // event loop drains.
    expect(vi.getTimerCount()).toBe(0)
  })
})
