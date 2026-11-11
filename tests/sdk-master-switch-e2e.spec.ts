/**
 * The SDK master switch must SAVE on the live Desktop host.
 *
 * THE REPORT, IN THE REPORTER'S OWN WORDS: 「sdk 的功能无法选中保存」— the box in
 * the card's SDK section ticks, the request comes back, the box goes back to
 * unticked, and the status row below still reads `disabled`.
 *
 * WHY THAT HAPPENED. `writeDeviceSdkEnabled` passed the DECLARED namespace
 * (`WORKBUDDY_SETTINGS_NS = 'workbuddy'`) to `settings.update`, while the settings
 * service resolves an entry by EXACT Loader id:
 *
 *     const entry = this.ownerContext.configEditor.entries()
 *       .find(row => row.options.id === ns)
 *     if (entry === undefined || schema === undefined)
 *       throw new Error(`No configurable plugin entry "${ns}"`)
 *
 * On the live Desktop profile the entry is `include:dsh-connect-workbuddy`, so
 * every toggle threw, the route answered HTTP 500, and the switch could never be
 * turned on at all. The default is OFF (`deviceSdkEnabled` defaults to `false`),
 * which made it look like the switch simply refused to accept the tick.
 *
 * WHY THIS FILE, AND WHY `fiber.entry`. On a bare `ctx.plugin()` mount the
 * Loader entry is absent and `settingsNamespaceOf` falls back to the constant —
 * so a unit test of `apply()` would pass BOTH before and after the fix, and
 * `tests/settings-integration.spec.ts` (which mounts that way) did exactly that.
 * The defect only exists when the served id DIFFERS from the constant, so the
 * mount below stubs `fiber.entry` the way the Loader does and makes a settings
 * service that — like the real one — refuses writes aimed at a namespace it does
 * not serve. That refusal is the test's whole point: it is what the reporter hit.
 *
 * @module dsh-connect-workbuddy/tests/sdk-master-switch-e2e
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as WorkBuddy from '../src/index.ts'
import { WORKBUDDY_DEVICE_SDK_PATH } from '../src/status-paths.ts'
import { TURING_SDK_DIR_ENV } from '../src/turing-sdk.ts'

/** The id the live Desktop profile patch mounts this plugin under. */
const SERVED_ID = 'include:dsh-connect-workbuddy'

let context: Context | undefined
/** The config object the mounted plugin reads BY REFERENCE, as on 0.1.7. */
let liveConfig: Record<string, unknown> = {}
let routes: { path: string, handler: (req: never, res: never) => Promise<void> | void }[] = []

/** A fake webServer that records routes instead of serving them. */
const FakeWebServer = {
  name: 'webServer',
  inject: [] as const,
  apply(ctx: Context) {
    ctx.provide('webServer', {
      register: (entry: typeof routes[number]) => {
        routes.push(entry)
        return () => {}
      },
    })
  },
}

/**
 * The 0.1.7-shaped settings service, with the ONE behaviour that matters here:
 * a write aimed at a namespace it does not serve THROWS, exactly like the real
 * service's `configEditor.entries().find(...)` lookup missing.
 *
 * Everything else mirrors `tests/issue155-removal-e2e.spec.ts`: `describe()`
 * answers the LIVE config object and `update()` commits into it in place, so the
 * plugin's `current()` sees the write without a restart (a volatile field is a
 * live reference, and the Loader re-announces a volatile-only write).
 */
class ServedNamespaceSettings extends Service {
  readonly writable = true
  constructor(ctx: Context) {
    super(ctx, 'settings')
  }
  configure(): () => void {
    return () => {}
  }
  describe() {
    return [{
      ns: SERVED_ID,
      revision: 0,
      applies: 'live',
      value: liveConfig,
      base: structuredClone(liveConfig),
      user: structuredClone(liveConfig),
    }]
  }
  async update(ns: string, patch: Record<string, unknown>): Promise<void> {
    // THE GUARD THE REAL SERVICE HAS. `workbuddy` is not an entry id here —
    // only `include:dsh-connect-workbuddy` is — so addressing the constant must
    // fail loudly rather than quietly write somewhere else.
    if (ns !== SERVED_ID) throw new Error(`No configurable plugin entry "${ns}"`)
    Object.assign(liveConfig, structuredClone(patch))
    ;(context as unknown as { emit(name: string): void })?.emit('loader/volatile-update')
  }
  async get(): Promise<unknown> {
    return liveConfig
  }
}

/**
 * Mount the plugin with the Loader entry id the Desktop host provides.
 *
 * `ctx.fiber` is a writable own property on a Cordis Context (probed, not
 * assumed), and `entry` is what the real Loader hangs on it — so assigning it
 * here reproduces the deployment rather than inventing a shape.
 */
async function mount(config: Record<string, unknown> = {}): Promise<Context> {
  routes = []
  liveConfig = { ...config }
  const ctx = new Context()
  await ctx.plugin(FakeWebServer)
  await ctx.plugin(ServedNamespaceSettings)
  ;(ctx as unknown as { fiber: { entry?: unknown } }).fiber.entry = { options: { id: SERVED_ID } }
  WorkBuddy.apply(ctx, liveConfig as WorkBuddy.Config)
  await new Promise(resolve => setTimeout(resolve, 0))
  context = ctx
  return ctx
}

function response(): {
  res: { writeHead: (s: number) => void, end: (b?: string) => void }
  status: () => number
  body: () => Record<string, unknown>
} {
  let statusCode = 0
  let payload = ''
  return {
    res: {
      writeHead: (s: number) => { statusCode = s },
      end: (b?: string) => { payload = b ?? '' },
    },
    status: () => statusCode,
    body: () => JSON.parse(payload || '{}') as Record<string, unknown>,
  }
}

async function call(
  path: string,
  init: { method?: string, url?: string } = {},
): Promise<{ status: number, body: Record<string, unknown> }> {
  const route = routes.find(entry => entry.path === path)
  if (route === undefined) throw new Error(`route not mounted: ${path}`)
  const { res, status, body } = response()
  await route.handler(
    // `host` is required, not decoration: the device routes refuse a request
    // without one (the same DNS-rebinding guard every write route uses).
    { method: init.method ?? 'GET', url: init.url ?? path, headers: { host: '127.0.0.1:62283' } } as never,
    res as never,
  )
  return { status: status(), body: body() }
}

const readReport = () => call(WORKBUDDY_DEVICE_SDK_PATH)
const toggle = (on: boolean) => call(WORKBUDDY_DEVICE_SDK_PATH, {
  method: 'POST',
  url: `${WORKBUDDY_DEVICE_SDK_PATH}?action=${on ? 'enable' : 'disable'}`,
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  liveConfig = {}
  vi.unstubAllEnvs()
})

describe('the SDK master switch saves on a host whose entry id differs from the constant', () => {
  it('turns ON through the route and is reported back as on', async () => {
    // The regression, stated as a fact about the deployment: the constant is NOT
    // what the host serves. If this ever became equal the file would stop testing
    // the thing it exists for.
    expect(WorkBuddy.WORKBUDDY_SETTINGS_NS).not.toBe(SERVED_ID)

    await mount({ deviceSdkEnabled: false })
    // Default OFF, so the card's box starts unticked — that is why a save that
    // never lands reads as "the tick does not stick" instead of as an error.
    expect((await readReport()).body['sdkEnabled']).toBe(false)

    const saved = await toggle(true)
    expect(saved.status).toBe(200)
    expect(saved.body['sdkEnabled']).toBe(true)
    // The write really landed in the document, not just in the answer.
    expect(liveConfig['deviceSdkEnabled']).toBe(true)
    // ...and the next read reports the stored value, which is what redraws the box.
    const report = (await readReport()).body
    expect(report['sdkEnabled']).toBe(true)
    // The same snapshot must not still say "disabled": the switch used to be a
    // construction-time boolean while this field read the live config, so on a
    // host that does not remount the plugin the box and the status row disagreed.
    expect((report['sdk'] as { state: string }).state).not.toBe('disabled')
  })

  it('turns OFF again, so the switch is a switch and not a one-way latch', async () => {
    await mount({ deviceSdkEnabled: true })
    expect((await readReport()).body['sdkEnabled']).toBe(true)

    const saved = await toggle(false)
    expect(saved.status).toBe(200)
    expect(liveConfig['deviceSdkEnabled']).toBe(false)
    expect((await readReport()).body['sdkEnabled']).toBe(false)
  })

  /**
   * The prewarm chain must FOLLOW the switch, not be judged once at mount.
   *
   * `deviceSdkEnabled` is volatile, so a tick or untick reaches the plugin as a
   * `loader/volatile-update` and the plugin is NOT remounted. The chain used to
   * be started (or not) exactly once inside `apply()`, so a process that booted
   * with the switch off never got a timer afterwards — the card then sat at
   * "已加载、没取过" until some request happened to fetch a token.
   *
   * WHY `lastAttemptMs` IS THE SIGNAL. It is set by `fetchOnce()` — i.e. only by
   * a real prewarm attempt — and never by `probe()`, which is all the GET route
   * does. So its appearance proves the chain exists, not merely that a snapshot
   * was taken. The SDK directory is pointed at an empty one (`TURING_SDK_DIR_ENV`)
   * so `probe()` fails the binding check and answers `missing` WITHOUT spawning a
   * child process: the claim under test is the timer, not the vendor SDK.
   */
  it('starts the prewarm chain when the switch is turned on after mount', async () => {
    vi.stubEnv(TURING_SDK_DIR_ENV, join(tmpdir(), 'dsh-workbuddy-no-sdk-here'))
    await mount({ deviceSdkEnabled: false })

    const tokenOf = async (): Promise<Record<string, unknown>> =>
      (await readReport()).body['token'] as Record<string, unknown>

    // Booted off: no chain, so nothing has ever tried to fetch a token. The
    // wait is what makes this a fact rather than a race with a timer we are
    // about to prove does not exist.
    await new Promise(resolve => setTimeout(resolve, 150))
    expect((await tokenOf())['lastAttemptMs']).toBeUndefined()

    const saved = await toggle(true)
    expect(saved.status).toBe(200)

    // Turning it on takes effect in place — no remount, no restart.
    await vi.waitFor(async () => {
      expect((await tokenOf())['lastAttemptMs']).toBeTypeOf('number')
    }, { timeout: 10_000 })
  })
})
