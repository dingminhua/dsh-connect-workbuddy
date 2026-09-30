/**
 * End-to-end checks against the ACTUALLY MOUNTED plugin.
 *
 * These exist because the pool's unit tests all inject doubles for the Host's
 * own dependencies — so they verify the code against MY idea of how the Host
 * behaves, not against the Host. Every defect listed below was invisible to
 * those tests for exactly that reason, and each is asserted here against the
 * real `apply()` + real routes + real config object.
 *
 * @module dsh-connect-workbuddy/tests/pool-e2e
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as WorkBuddy from '../src/index.ts'
import { POOL_TICK_MS } from '../src/account-pool.ts'
import { WORKBUDDY_POOL_PATH, WORKBUDDY_USAGE_PATH } from '../src/status-paths.ts'

/** Mounted context; disposed after each test. */
let context: Context | undefined
/** The mutable config the plugin reads (mirrors the Loader's in-place commits). */
let liveConfig: Record<string, unknown> = {}
let stagingConfig: Record<string, unknown> = {}

/** Capture every registered route so a test can call one directly. */
interface Route { path: string, handler: (req: never, res: never) => Promise<void> | void }
let routes: Route[] = []

/** A fake webServer that records routes instead of serving them. */
const FakeWebServer = {
  name: 'webServer',
  inject: [] as const,
  apply(ctx: Context) {
    ctx.provide('webServer', {
      register: (entry: Route) => {
        routes.push(entry)
        return () => {}
      },
    })
  },
}

/**
 * A settings service double that reports a workbuddy row, so the `__save`
 * endpoint can run and the plugin's `configure` call is recorded.
 */
const FakeSettings = {
  name: 'settings',
  inject: [] as const,
  apply(ctx: Context) {
    const state: Record<string, unknown> = {}
    ctx.provide('settings', {
      describe: () => [{
        ns: 'dsh-connect-workbuddy',
        value: { regions: { cn: { ...(state['regions'] as object ?? {}) } }, ...state },
      }],
      mutate: async (_ns: string, ops: { path: string[], value: unknown }[]) => {
        for (const op of ops) state[op.path[0] as string] = op.value
      },
      configure: () => {},
    })
  },
}

/** Write one CN sign-in and return its path, so a region has an account. */
async function writeAuthFixture(root: string): Promise<string> {
  const dir = join(root, 'auth')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'workbuddy-desktop.info')
  await writeFile(path, JSON.stringify({
    account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha', enterpriseId: '' },
    auth: {
      accessToken: 'token-alpha',
      refreshToken: 'refresh-alpha',
      tokenType: 'Bearer',
      domain: 'www.codebuddy.cn',
      expiresAt: Date.now() + 86_400_000,
      refreshExpiresAt: Date.now() + 7 * 86_400_000,
    },
  }), 'utf8')
  return path
}

/**
 * The real account id for a fixture sign-in.
 *
 * Discovered by mounting the plugin once and reading its own account list, so
 * the id is the one the plugin actually computes rather than a guess — tests
 * that need a RESOLVABLE member must not hard-code an id.
 */
async function discoverAccountId(authFile: string): Promise<string> {
  await mount({ authFile, regions: { cn: { enabled: true } } })
  const { body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
  const accounts = (body['accounts'] ?? []) as { id: string }[]
  const id = accounts[0]?.id
  if (id === undefined) throw new Error('fixture produced no account')
  await context?.fiber.dispose()
  context = undefined
  return id
}

/** Mount the plugin with a real `apply()` and the given config. */
async function mount(config: Record<string, unknown> = {}): Promise<Context> {
  routes = []
  liveConfig = { ...stagingConfig, ...config }
  stagingConfig = {}
  const ctx = new Context()
  await ctx.plugin(FakeWebServer)
  await ctx.plugin(FakeSettings)
  WorkBuddy.apply(ctx, liveConfig as WorkBuddy.Config)
  await new Promise(resolve => setTimeout(resolve, 0))
  context = ctx
  return ctx
}

/** Response recorder for a route call. */
function response(): {
  res: { writeHead: (s: number, h?: Record<string, string>) => void, end: (b?: string) => void }
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

/** Call one registered route by path. */
async function call(
  path: string,
  init: { method?: string, url?: string } = {},
): Promise<{ status: number, body: Record<string, unknown> }> {
  const route = routes.find(entry => entry.path === path)
  if (route === undefined) throw new Error(`route not mounted: ${path} (have ${routes.map(r => r.path).join(', ')})`)
  const { res, status, body } = response()
  await route.handler(
    { method: init.method ?? 'GET', url: init.url ?? path, headers: {} } as never,
    res as never,
  )
  return { status: status(), body: body() }
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-pool-e2e-'))
})
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  liveConfig = {}
  stagingConfig = {}
})

describe('the mounted plugin: promises the UI makes', () => {
  it('exposes a pool block whose enabled flag follows the SAVED config', async () => {
    const authFile = await writeAuthFixture(root)
    await mount({
      authFile,
      regions: { cn: { enabled: true, pool: { enabled: true, memberAccountIds: ['x'] } } },
    })
    const { status, body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
    expect(status).toBe(200)
    const pool = body['pool'] as { enabled?: boolean } | undefined
    expect(pool?.enabled).toBe(true)
  })

  it('reports the pool as OFF for a config that predates the feature', async () => {
    const authFile = await writeAuthFixture(root)
    await mount({ authFile, regions: { cn: { enabled: true } } })
    const { body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
    const pool = body['pool'] as { enabled?: boolean } | undefined
    expect(pool?.enabled).toBe(false)
  })

  it('refuses a pool batch when the feature is off', async () => {
    const authFile = await writeAuthFixture(root)
    await mount({ authFile, regions: { cn: { enabled: true } } })
    const { status } = await call(WORKBUDDY_POOL_PATH, {
      method: 'POST',
      url: `${WORKBUDDY_POOL_PATH}?region=cn&action=checkin`,
    })
    expect(status).toBe(409)
  })
})

describe('the mounted plugin: defects found by driving the real code (now fixed)', () => {
  /** Read a source file for a structural assertion. */
  const sourceOf = async (name: string): Promise<string> =>
    await import('node:fs/promises').then(fs => fs.readFile(new URL(`../src/${name}`, import.meta.url), 'utf8'))

  it('registers a real scheduler, so the interval setting is consumed', async () => {
    // The defect: `autoTestIntervalMinutes` was stored and never read, so the
    // card promised "test every N minutes" and nothing ever ran.
    const source = await sourceOf('index.ts')
    expect(source).toContain('setInterval')
    // The tick delegates the decision to the pure helper rather than
    // re-deriving "is it due" inline.
    expect(source).toContain('duePoolRegions(')
    // The timer must be owned by an effect so disposal clears it.
    expect(source).toContain('clearInterval(timer)')
  })

  it('arms the schedule from a heartbeat rather than one timer per region', async () => {
    const source = await sourceOf('index.ts')
    expect(source).toContain('POOL_TICK_MS')
    // A single interval registration, not one per region.
    expect((source.match(/setInterval\(/gu) ?? []).length).toBe(1)
  })

  it('never fires a scheduled test before one full interval has passed', async () => {
    // Firing immediately on enable would bill the user at every startup.
    const { poolDueAt } = await import('../src/account-pool.ts')
    const now = 1_800_000_000_000
    expect(poolDueAt({ lastRunMs: undefined, intervalMinutes: 30, nowMs: now })).toBe(false)
    expect(poolDueAt({ lastRunMs: now, intervalMinutes: 30, nowMs: now + 29 * 60_000 })).toBe(false)
    expect(poolDueAt({ lastRunMs: now, intervalMinutes: 30, nowMs: now + 30 * 60_000 })).toBe(true)
  })

  it('clamps a schedule below the schema floor instead of trusting the number', async () => {
    // A hand-edited config must not turn the timer into a spend loop.
    const { poolDueAt } = await import('../src/account-pool.ts')
    const now = 1_800_000_000_000
    expect(poolDueAt({ lastRunMs: now, intervalMinutes: 0, nowMs: now + 60_000 })).toBe(false)
    expect(poolDueAt({ lastRunMs: now, intervalMinutes: -5, nowMs: now + 60_000 })).toBe(false)
    expect(poolDueAt({ lastRunMs: now, intervalMinutes: 5, nowMs: now + 5 * 60_000 })).toBe(true)
  })

  it('gives a pool probe the quota-refresh time, so out-of-credit has a cooldown', async () => {
    // The defect: the pool built its own probe call and omitted the monthly
    // refresh point, so a drained account reported "no time given" in the pool
    // while the model table reported a real reset time for the same account.
    const source = await sourceOf('index.ts')
    const runner = source.slice(source.indexOf('function poolRunnerDeps'))
    const body = runner.slice(0, runner.indexOf('\n  }'))
    expect(body).toContain('quotaRefreshAtMs')
    expect(body).toContain('quotaRefreshOf(')
  })

  it('trims the pool catalog instead of shipping the full roster twice', async () => {
    const authFile = await writeAuthFixture(root)
    await mount({
      authFile,
      regions: {
        cn: {
          enabled: true,
          pool: { enabled: true },
          lastCatalog: [{ id: 'a', name: 'A', contextWindow: 1000, maxTokens: 100 }],
        },
      },
    })
    const { body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
    const pool = body['pool'] as { catalog?: Record<string, unknown>[] } | undefined
    const entry = pool?.catalog?.[0]
    expect(entry).toBeDefined()
    // Exactly the three fields the picker renders, not a full model record.
    expect(Object.keys(entry ?? {}).sort()).toEqual(['id', 'name'])
    const models = (body['models'] as Record<string, unknown>[] | undefined)?.[0] ?? {}
    expect(Object.keys(models).length).toBeGreaterThan(2)
  })

  it('re-ranks the pool when a scheduled test finishes, not only on a manual click', async () => {
    const source = await sourceOf('index.ts')
    // The scheduled pass must persist measurements AND apply rotation, the same
    // order the manual action uses (persist, then rotate, so the ranking sees
    // the results it just produced).
    const at = source.indexOf('async function runScheduledPoolTest')
    const body = source.slice(at, at + 700)
    expect(body).toContain('writePoolProbes')
    expect(body).toContain('applyRotation')
    expect(body.indexOf('writePoolProbes')).toBeLessThan(body.indexOf('applyRotation'))
  })

  it('keeps the batch callback reading only what it declares as a dependency', async () => {
    // The trap an escaped mutant exposed: `runAction` is memoized on
    // `[appendLog, pool, region, t]`, but its body used to read
    // `saved.memberAccountIds` — a binding rebuilt every render and NOT in the
    // list. A click therefore ran with the previous render's `pool`. Nothing
    // failed, because the values agreed at rest; the mutant that swapped in the
    // draft-derived set survived the whole suite for exactly that reason.
    //
    // This is the structural guard: the callback may read the values it
    // declares, and must reach anything else through `pool` (which IS a
    // dependency). Draft-derived bindings are named explicitly because they are
    // the ones that would silently disagree with what the Host runs.
    const source = await sourceOf('client/AccountPool.tsx')
    const at = source.indexOf('const runAction = useCallback')
    expect(at, 'runAction moved — update this guard').toBeGreaterThan(-1)
    // Find the callback's own dependency array structurally rather than by its
    // exact text: hardcoding the list meant that ADDING a dependency (a correct
    // change) failed this guard and looked like a regression.
    const end = source.indexOf('\n  }, [', at)
    expect(end, 'runAction has no dependency array — update this guard').toBeGreaterThan(at)
    const body = source.slice(at, end)
    // Strip comments: the rationale above legitimately NAMES these bindings.
    const code = body.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
    for (const binding of ['saved.', 'saved[', 'active.', 'dirty', 'effectiveMembers', 'ghostMembers']) {
      expect(code, `runAction reads ${binding}, which is not a dependency`).not.toContain(binding)
    }
    // And it must still count through `pool`, or the H-5 fix is gone.
    expect(code).toContain('pool?.effectiveMemberAccountIds')
    expect(code).toContain('pool?.memberAccountIds')
  })
})

describe('the pool scheduler lifecycle', () => {
  it('registers exactly one interval and clears it on dispose', async () => {
    // A leaked interval would keep firing probes after the plugin was
    // withdrawn — spending credits with nothing on screen to explain it.
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    const handles = new Set<unknown>()
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const handle = realSet(fn, ms)
      handles.add(handle)
      return handle
    }) as typeof setInterval
    globalThis.clearInterval = ((handle: unknown) => {
      handles.delete(handle)
      return realClear(handle as never)
    }) as typeof clearInterval
    try {
      const authFile = await writeAuthFixture(root)
      await mount({
        authFile,
        regions: { cn: { enabled: true, pool: { enabled: true, autoTestIntervalMinutes: 5 } } },
      })
      // Exactly one heartbeat for BOTH regions, not one per region.
      expect(handles.size).toBe(1)
      await context?.fiber.dispose()
      context = undefined
      expect(handles.size).toBe(0)
    } finally {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    }
  })

  it('does not probe anything before a full interval has elapsed', async () => {
    // The scheduler must never spend on startup or right after a settings save.
    //
    // A REAL member, and the fake clock installed BEFORE mount. Both matter, and
    // both were missing: with `memberAccountIds: ['x']` (not a local sign-in)
    // the batch resolves to nothing, so a working scheduler and a dead timer
    // produced the SAME zero probes — the assertion could not fail. And the
    // heartbeat is created inside `apply()` (src/index.ts:1317), so installing
    // the fake clock afterwards left the real interval running on real time and
    // the fake one never fired. `toFake` is narrowed to the interval plus `Date`
    // so the mount's own `setTimeout(0)` still settles.
    const authFile = await writeAuthFixture(root)
    const memberId = await discoverAccountId(authFile)
    let probes = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes('/chat/completions')) probes += 1
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      await mount({
        authFile,
        regions: {
          cn: {
            enabled: true,
            lastCatalog: [{
              id: 'free-model', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
            }],
            pool: {
              enabled: true,
              autoTestIntervalMinutes: 5,
              memberAccountIds: [memberId],
            },
          },
        },
      })
      // Nothing at startup, and nothing after one heartbeat (which only ARMS
      // the region's clock). Both flushes are load-bearing: without them a
      // scheduler that DID start a batch here would still read zero probes,
      // because the batch is waiting on real file I/O that fake timers do not
      // advance. Measured with "run on first sight" injected: the assertion
      // passed without the flush and fails with it.
      await flushRealWork()
      expect(probes).toBe(0)
      await vi.advanceTimersByTimeAsync(POOL_TICK_MS)
      await flushRealWork()
      expect(probes).toBe(0)
    } finally {
      vi.useRealTimers()
      globalThis.fetch = realFetch
    }
  })
})

describe('the pool scheduler actually runs a due region', () => {
  it('arms on the first tick, then probes and re-ranks once the interval passes', async () => {
    // The wiring test: the pure decision is unit-tested elsewhere, but only
    // this proves the mounted plugin ACTS on it — the gap that let the interval
    // setting sit unconsumed while every unit test still passed.
    //
    // It previously proved nothing. It mounted `memberAccountIds: []`, so the
    // woken scheduler had nothing to test, and both assertions were
    // `expect(probes).toBe(0)` — a dead timer satisfies that exactly as well as
    // a live one. It also mounted on REAL timers and only then called
    // `vi.useFakeTimers()`, while the heartbeat is created inside `apply()`
    // (src/index.ts:1317): the fake clock never owned the interval it was
    // advancing. Driving the real scheduler showed `chatCalls = 0` until the
    // fake clock was installed before mount. So: a REAL member, the fake clock
    // BEFORE mount, and an assertion that FAILS when the scheduler does not run.
    const authFile = await writeAuthFixture(root)
    const memberId = await discoverAccountId(authFile)
    let probes = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      const text = String(url)
      if (text.includes('/chat/completions')) probes += 1
      if (text.includes('get-user-resource')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { packages: [{ packageName: 'p', remain: 100, size: 100, capacityType: 1 }] },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        code: 0,
        data: {
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      }), { status: 200 })
    }) as typeof fetch
    // `Date` is faked too: the scheduler compares `Date.now()` against its own
    // timestamps, so advancing the interval without advancing the clock would
    // leave the region permanently "not due".
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      await mount({
        authFile,
        regions: {
          cn: {
            enabled: true,
            // A zero-multiplier model so the scheduler has a free target; the
            // free-target rule is what stops a timer from billing a paid model.
            lastCatalog: [{
              id: 'free-model', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
            }],
            pool: {
              enabled: true,
              autoTestIntervalMinutes: 5,
              memberAccountIds: [memberId],
            },
          },
        },
      })
      // Tick 1: the region is armed, not run.
      await vi.advanceTimersByTimeAsync(POOL_TICK_MS)
      expect(probes).toBe(0)
      // A full interval later: now it MUST run. This is the assertion with
      // teeth — it fails if the scheduler never fires.
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      // Let the batch's REAL work settle. The run reads the auth file through
      // `fs/promises`, and fake timers do not fake I/O: advancing the clock
      // fires the tick, but the async batch it starts needs real macrotask
      // turns to reach the fetch. Without this flush the assertion below reads
      // zero even though the scheduler fired — measured: `chatCalls = 0` right
      // after advancing, `1` after draining the loop. Drain UNTIL the probe
      // lands rather than for a fixed number of turns: N15 proved a constant
      // count reads zero under CPU contention, and a mutation harness reads
      // that as a kill.
      await flushUntil(() => probes >= 1)
      expect(probes).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
      globalThis.fetch = realFetch
    }
  })

  it('still refreshes measurements when the saved target model is stale (D3)', async () => {
    // The asymmetry the third round's verification proved with a real plugin and
    // a real scheduler: a `rate-limited` member clears by the CLOCK alone
    // (`exclusionOf` consults `retryAtMs`), while an `unavailable` member can
    // only be cleared by a NEW probe. That is fine while probes keep landing —
    // but the pass used to return early whenever `resolveTargetModel` produced
    // no id, which is exactly what a saved model that left the catalog
    // produces. So one stale *display preference* froze the whole region's
    // measurement loop and left every `unavailable` member hanging forever.
    //
    // The scheduler's job is to keep MEASUREMENTS fresh, so it must not be
    // starved by a configuration error it can work around without spending:
    // it falls back to the region's FREE model.
    const catalog = [{
      id: 'free-model', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
    }]
    const probes = await driveScheduledInterval({ targetModelId: 'model-that-left' }, catalog, 'runs')
    expect(probes).toBeGreaterThanOrEqual(1)
  })

  it('does NOT bill a paid model when the target is stale and no free model exists (D3, negative half)', async () => {
    // The other half of the fix, and the reason the fallback goes through
    // `pickFreeModel` rather than "any model in the catalog": the free-target
    // rule is what stops a timer from spending the user's credits. With no
    // zero-multiplier model there is nothing honest to probe, so the pass must
    // skip entirely — a paid probe here would be the exact defect the rule
    // exists to prevent.
    const catalog = [{
      id: 'paid-model', name: 'Paid', contextWindow: 1000, maxTokens: 100, creditMultiplier: 2,
    }]
    const probes = await driveScheduledInterval({ targetModelId: 'model-that-left' }, catalog, 'skips')
    expect(probes).toBe(0)
  })
})

/**
 * Drain real macrotasks while fake timers are installed.
 *
 * Fake timers do not fake I/O, so a batch the scheduler started is still
 * waiting on `fs/promises` when `advanceTimersByTimeAsync` returns. `setImmediate`
 * is NOT faked here (only the interval and `Date` are), so yielding to it lets
 * the real continuation run to completion.
 */
async function flushRealWork(turns = 600): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

/**
 * Drain real macrotasks until `settled()` holds, or the bound is spent.
 *
 * A FIXED turn count cannot express "give the batch as long as it needs": under
 * CPU contention the I/O continuation may not land within any constant number
 * of turns, and the caller's assertion then reads zero **even though the
 * scheduler fired**. Independent verification found exactly that
 * (`docs/audit/I-round4-verification.md` §5, N15: 10/10 serial runs pass, while
 * 4-way parallelism produces `expected 0 to be greater than or equal to 1`).
 * It matters beyond this file: a mutation harness reads such a failure as
 * "the guard caught the mutant" and records a FALSE KILL, which is how a
 * verification campaign reports coverage it does not have.
 *
 * The bound is generous rather than tight, so the assertion still FAILS when
 * the behaviour is genuinely absent — it just no longer fails on timing.
 */
async function flushUntil(settled: () => boolean, turns = 5_000): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    if (settled()) return
    await new Promise(resolve => setImmediate(resolve))
  }
}

/**
 * Source text with comments AND string literals removed.
 *
 * A guard that reads source TEXT is defeated by anything that merely LOOKS like
 * the code it is looking for, and round-4 adversarial verification
 * (`docs/audit/I-round4-verification.md`) found both halves of that seam:
 *
 * - **N9** — stripping comments was not enough. `const shape = 'return
 *   effectiveMembersOf('` satisfies a `toMatch` on the D6 guard while the call
 *   is never made, so the shared rule could stop deciding the result while the
 *   guard reported delegation.
 * - **N17** — the same seam on the D5 half, in the opposite direction: a string
 *   literal merely MENTIONING a derived name counted as a free-variable read,
 *   so legitimate code failed the guard. A guard that fails correct code gets
 *   edited by whoever hits it, and the cheapest edit is the one that silences
 *   the failure while leaving the real staleness class open.
 *
 * Quotes are what make a mention look like a call or a read, so they are
 * replaced with an empty literal before any matching happens. Comments are
 * removed for the same reason (the earlier attack was a bare `//` line).
 */
function stripLiterals(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/[^\n]*/gu, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/gu, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/gu, '""')
    .replace(/`(?:[^`\\]|\\.)*`/gu, '``')
}

/**
 * Mount the plugin with fake timers installed BEFORE `apply()`, advance one
 * full interval, and report how many probe calls reached `/chat/completions`.
 *
 * The fake clock must own the heartbeat, and the heartbeat is created inside
 * `apply()` (`src/index.ts`), so installing the fake clock afterwards leaves the
 * real interval running while the fake one never fires — the harness bug that
 * made the first version of this test prove nothing (D4). `toFake` is narrowed
 * to the interval plus `Date` so the mount's own `setTimeout(0)` still settles.
 *
 * `expected` decides how to drain: a run that MUST happen is drained until the
 * probe lands, so a slow I/O continuation cannot be read as "did not run"
 * (N15); a run that must NOT happen is drained generously, so a run that merely
 * had not finished yet cannot be read as "skipped".
 */
async function driveScheduledInterval(
  pool: Record<string, unknown>,
  catalog: readonly Record<string, unknown>[],
  expected: 'runs' | 'skips',
): Promise<number> {
  const authFile = await writeAuthFixture(root)
  const memberId = await discoverAccountId(authFile)
  let probes = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    const text = String(url)
    if (text.includes('/chat/completions')) probes += 1
    if (text.includes('get-user-resource')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { packages: [{ packageName: 'p', remain: 100, size: 100, capacityType: 1 }] },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({
      code: 0,
      data: {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    }), { status: 200 })
  }) as typeof fetch
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  try {
    await mount({
      authFile,
      regions: {
        cn: {
          enabled: true,
          lastCatalog: catalog,
          pool: {
            enabled: true,
            autoTestIntervalMinutes: 5,
            memberAccountIds: [memberId],
            ...pool,
          },
        },
      },
    })
    // Tick 1 ARMS the region's clock ("first sight"); it does not run it.
    await vi.advanceTimersByTimeAsync(POOL_TICK_MS)
    expect(probes).toBe(0)
    // A full interval later the pass is due.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    if (expected === 'runs') await flushUntil(() => probes >= 1)
    else await flushRealWork()
    return probes
  } finally {
    vi.useRealTimers()
    globalThis.fetch = realFetch
  }
}

describe('the pool: regression guards for the audited defects', () => {
  it('H-5: reports EFFECTIVE membership so the card cannot overcount', async () => {
    // The defect: the card counted the raw saved list, so a ghost id made it
    // claim "1 of 1 selected" and enable both buttons while the Host ran on
    // ZERO accounts and reported success.
    const authFile = await writeAuthFixture(root)
    await mount({
      authFile,
      regions: {
        cn: {
          enabled: true,
          lastCatalog: [{
            id: 'free', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
          }],
          pool: { enabled: true, memberAccountIds: ['ghost-account-id'] },
        },
      },
    })
    const { body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
    const pool = body['pool'] as {
      memberAccountIds?: string[]
      effectiveMemberAccountIds?: string[]
    } | undefined
    // The SAVED list is preserved verbatim (a login can come back)...
    expect(pool?.memberAccountIds).toEqual(['ghost-account-id'])
    // ...while the EFFECTIVE list is what a batch would really run on.
    expect(pool?.effectiveMemberAccountIds).toEqual([])
  })

  it('H-5: a ghost-only pool is refused, so the card cannot announce a batch', async () => {
    // This replaces a TAUTOLOGICAL test: the old version asserted "zero upstream
    // requests", which was already true before the fix because a ghost id
    // resolves to no credential — so it passed on a build with the defect and
    // gave false confidence. The discriminating assertion is the ROUTE ANSWER:
    // the guard must classify the pool as empty, which is what stops the card
    // from logging a test that never ran.

    const authFile = await writeAuthFixture(root)
    await mount({
      authFile,
      regions: {
        cn: {
          enabled: true,
          lastCatalog: [{
            id: 'free', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
          }],
          pool: { enabled: true, memberAccountIds: ['ghost-account-id'] },
        },
      },
    })
    let upstream = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      // Count only the endpoints a CHECK-IN batch would use. The usage route's
      // own check-in panel reads the same endpoint for the SELECTED account, so
      // counting every request would measure that panel instead of the batch.
      const text = String(url)
      if (text.includes('daily-checkin') || text.includes('checkin-activity-status')) upstream += 1
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    }) as typeof fetch
    try {
      const { status, body } = await call(WORKBUDDY_POOL_PATH, {
        method: 'POST',
        url: `${WORKBUDDY_POOL_PATH}?region=cn&action=checkin`,
      })
      // The SAVED list is non-empty, yet nothing resolves — the route must
      // answer a 409 rather than 200 with an empty row set. A 200 is exactly
      // what let the card print "check-in finished" over zero work.
      expect(status).toBe(409)
      // ...and it must be the GHOST cause specifically. Both empty-pool causes
      // were folded into `no-members`, which made the Host's distinction dead
      // code (the card localizes from `reason` and never reads `error`) and told
      // this user to "check at least one account" when one IS checked.
      expect(body['reason']).toBe('no-live-members')
      expect(upstream).toBe(0)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('H-5: an UNCHECKED pool answers no-members, a distinct reason from the ghost case', async () => {
    // The companion to the case above. Both empty-pool states used to answer
    // `no-members`, which made the Host's own distinction dead code: the card
    // localizes from `reason` and never reads `error`, so a user whose checked
    // accounts had all lost their sign-in was told to "check at least one
    // account". The two causes need opposite advice (check one vs sign in
    // again), so they must stay distinguishable end to end.
    const authFile = await writeAuthFixture(root)
    await mount({
      authFile,
      regions: {
        cn: {
          enabled: true,
          lastCatalog: [{
            id: 'free', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
          }],
          pool: { enabled: true, memberAccountIds: [] },
        },
      },
    })
    const { status, body } = await call(WORKBUDDY_POOL_PATH, {
      method: 'POST',
      url: `${WORKBUDDY_POOL_PATH}?region=cn&action=checkin`,
    })
    expect(status).toBe(409)
    // Truly empty saved list: this is the "you never checked anything" cause.
    expect(body['reason']).toBe('no-members')
  })

  it('H-6: refuses a test whose saved target model left the catalog', async () => {
    const authFile = await writeAuthFixture(root)
    // A REAL member is required, or the empty-pool guard answers first and this
    // test would never reach the stale-target check it exists to exercise.
    const realId = await discoverAccountId(authFile)
    await mount({
      authFile,
      regions: {
        cn: {
          enabled: true,
          lastCatalog: [{
            id: 'free', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
          }],
          pool: {
            enabled: true,
            memberAccountIds: [realId],
            targetModelId: 'model-that-left',
          },
        },
      },
    })
    const usage = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
    const pool = usage.body['pool'] as {
      targetModelSource?: string
      targetModelId?: string
      staleTargetModelId?: string
      effectiveMemberAccountIds?: string[]
    } | undefined
    // The member resolves, so this is NOT the empty-pool case.
    expect(pool?.effectiveMemberAccountIds).toEqual([realId])
    expect(pool?.targetModelSource).toBe('stale')
    expect(pool?.staleTargetModelId).toBe('model-that-left')
    // No id is offered, so an unguarded caller fails safe too.
    expect(pool?.targetModelId).toBeUndefined()

    const run = await call(WORKBUDDY_POOL_PATH, {
      method: 'POST',
      url: `${WORKBUDDY_POOL_PATH}?region=cn&action=test`,
    })
    expect(run.status).toBe(409)
    expect(run.body['reason']).toBe('target-model-stale')
  })

  it('M-3: names the failure cause structurally, not only in prose', async () => {
    const authFile = await writeAuthFixture(root)
    await mount({ authFile, regions: { cn: { enabled: true } } })
    const { status, body } = await call(WORKBUDDY_POOL_PATH, {
      method: 'POST',
      url: `${WORKBUDDY_POOL_PATH}?region=cn&action=checkin`,
    })
    expect(status).toBe(409)
    // The card localizes `reason`; the English `error` stays as the fallback.
    expect(body['reason']).toBe('pool-disabled')
  })

  it('M-5: does not read check-in state while the pool is off', async () => {
    const authFile = await writeAuthFixture(root)
    await mount({
      authFile,
      regions: {
        cn: {
          enabled: true,
          lastCatalog: [{
            id: 'free', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
          }],
          pool: { enabled: false },
        },
      },
    })
    let checkinReads = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes('checkin-activity-status')) checkinReads += 1
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    }) as typeof fetch
    try {
      await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
      // With the pool OFF the document still carries its own check-in panel,
      // which reads the SELECTED account once — that call predates this feature
      // and is not what M-5 is about. The defect was the POOL reading every
      // account, so the bound here is "no per-account fan-out": with one local
      // account the panel's single read is all that may appear.
      expect(checkinReads).toBeLessThanOrEqual(1)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('M-5: caches check-in state across polls when the pool is on', async () => {
    const authFile = await writeAuthFixture(root)
    await mount({
      authFile,
      regions: {
        cn: {
          enabled: true,
          lastCatalog: [{
            id: 'free', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
          }],
          pool: { enabled: true, memberAccountIds: ['x'] },
        },
      },
    })
    let checkinReads = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes('checkin-activity-status')) checkinReads += 1
      return new Response(JSON.stringify({
        code: 0,
        data: { today_checked_in: true, active: true },
      }), { status: 200 })
    }) as typeof fetch
    try {
      await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
      const afterFirst = checkinReads
      await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
      const afterSecond = checkinReads
      // The POOL's per-account reads are cached, so a second poll adds only the
      // usage document's own single panel read — NOT one per pooled account.
      // (Without the cache a 1-account pool would add 2 per poll: panel + pool.)
      expect(afterSecond - afterFirst).toBeLessThanOrEqual(1)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('the rotation override is applied and cleared correctly (H-3)', () => {
  /** Two CN sign-ins, so rotation has a choice of account. */
  async function writeTwoAuthFixtures(root: string): Promise<string> {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const dir = join(root, 'auth')
    await mkdir(dir, { recursive: true })
    const doc = (uin: string, nick: string): string => JSON.stringify({
      account: { uid: `uid-${uin}`, uin, nickname: nick, enterpriseId: '' },
      auth: {
        accessToken: `token-${uin}`,
        refreshToken: `refresh-${uin}`,
        tokenType: 'Bearer',
        domain: 'www.codebuddy.cn',
        expiresAt: Date.now() + 86_400_000,
        refreshExpiresAt: Date.now() + 7 * 86_400_000,
      },
    })
    const live = join(dir, 'workbuddy-desktop.info')
    await writeFile(live, doc('100000000001', 'Alpha'), 'utf8')
    await writeFile(join(dir, 'workbuddy-desktop.2026-07-01T00-00-00-000Z.info'), doc('100000000002', 'Beta'), 'utf8')
    return live
  }

  it('sets an override when rotation is on, and CLEARS it when the pool is switched off', async () => {
    // The H-3 defect: rotation was only re-applied on a test run, so switching
    // the pool off left the runtime override in place and `current()` kept
    // preferring the rotated account — contradicting the card's promise that
    // switching the pool off restores the user's own selection.
    const authFile = await writeTwoAuthFixtures(root)
    const config: Record<string, unknown> = {
      authFile,
      regions: {
        cn: {
          enabled: true,
          lastCatalog: [{
            id: 'free', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
          }],
          pool: {
            enabled: true,
            rotateByCredits: true,
            autoTestIntervalMinutes: 30,
            memberAccountIds: [],
          },
        },
      },
    }
    const ctx = await mount(config)
    // Establish membership with the real account ids.
    const { body: usageBody } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
    const ids = ((usageBody['accounts'] ?? []) as { id: string }[]).map(account => account.id)
    const pool = (config['regions'] as Record<string, Record<string, unknown>>)['cn']?.['pool'] as Record<string, unknown>
    pool['memberAccountIds'] = [...ids]
    // The startup path already ran with the OLD (empty) membership; re-apply.
    ;(ctx as unknown as { emit(name: string): void }).emit('loader/volatile-update')
    await new Promise(resolve => setTimeout(resolve, 120))

    const { body: rotated } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
    const rotatedPool = rotated['pool'] as { rotatedToAccountId?: string } | undefined
    expect(rotatedPool?.rotatedToAccountId).toBeDefined()

    // Now switch the pool OFF and announce the commit, as the Loader does.
    pool['enabled'] = false
    pool['rotateByCredits'] = false
    ;(ctx as unknown as { emit(name: string): void }).emit('loader/volatile-update')
    await new Promise(resolve => setTimeout(resolve, 120))

    const { body: after } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
    const afterPool = after['pool'] as { rotatedToAccountId?: string } | undefined
    // Cleared: the card must not still be redirecting billing.
    expect(afterPool?.rotatedToAccountId).toBeUndefined()
  })

  it('lets only the NEWEST call write, so a slow ON cannot resurrect the override', async () => {
    // The race the verifier found (a defect I introduced): `applyRotation`
    // awaits per-member credits, so a call that read "ON" could resume AFTER a
    // newer call cleared the override for "OFF" and write the account back —
    // the card showing the pool off while a rotated account is still billed.
    //
    // Driven by delaying the credits response so the ON call is still in flight
    // when OFF commits.
    const authFile = await writeTwoAuthFixtures(root)
    const config: Record<string, unknown> = {
      authFile,
      regions: {
        cn: {
          enabled: true,
          lastCatalog: [{
            id: 'free', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
          }],
          pool: {
            enabled: true,
            rotateByCredits: true,
            autoTestIntervalMinutes: 30,
            memberAccountIds: [],
          },
        },
      },
    }
    const ctx = await mount(config)
    const { body: usageBody } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
    const ids = ((usageBody['accounts'] ?? []) as { id: string }[]).map(account => account.id)
    const pool = (config['regions'] as Record<string, Record<string, unknown>>)['cn']?.['pool'] as Record<string, unknown>
    pool['memberAccountIds'] = [...ids]

    // Make the credits read slow, so the ON re-rank is still awaiting when OFF
    // is committed and cleared.
    const realFetch = globalThis.fetch
    let releaseSlow: (() => void) | undefined
    const slow = new Promise<void>(resolve => { releaseSlow = resolve })
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('get-user-resource')) await slow
      return realFetch(url as never, init as never)
    }) as typeof fetch
    try {
      // ON: starts, reads preferences, then parks on the slow credits read.
      ;(ctx as unknown as { emit(name: string): void }).emit('loader/volatile-update')
      await new Promise(resolve => setTimeout(resolve, 30))
      // OFF: commits and clears the override while the ON call is parked.
      pool['enabled'] = false
      pool['rotateByCredits'] = false
      ;(ctx as unknown as { emit(name: string): void }).emit('loader/volatile-update')
      await new Promise(resolve => setTimeout(resolve, 30))
      // Let the parked ON call finish. It must NOT write.
      releaseSlow?.()
      await new Promise(resolve => setTimeout(resolve, 120))

      const { body: after } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
      const afterPool = after['pool'] as { rotatedToAccountId?: string } | undefined
      // Without the generation token the stale ON call wrote an account here.
      expect(afterPool?.rotatedToAccountId).toBeUndefined()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('the generation token itself (H-3, isolated)', () => {
  it('stops an OLDER still-ON call from overwriting a NEWER decision', async () => {
    // The previous test removes BOTH defences to fail, so it cannot show the
    // token does anything — the post-await re-read alone would rescue it. This
    // one isolates the token by keeping the preferences ON throughout, so the
    // re-read always agrees and only the token can prevent the stale write.
    //
    // Two overlapping ON calls whose credit data disagree must resolve to the
    // NEWER call's pick. Without the token the older call resumes last and
    // writes its own (stale) account.
    const { mkdir, writeFile } = await import('node:fs/promises')
    const dir = join(root, 'auth')
    await mkdir(dir, { recursive: true })
    const doc = (uin: string, nick: string): string => JSON.stringify({
      account: { uid: `uid-${uin}`, uin, nickname: nick, enterpriseId: '' },
      auth: {
        accessToken: `token-${uin}`,
        refreshToken: `refresh-${uin}`,
        tokenType: 'Bearer',
        domain: 'www.codebuddy.cn',
        expiresAt: Date.now() + 86_400_000,
        refreshExpiresAt: Date.now() + 7 * 86_400_000,
      },
    })
    const authFile = join(dir, 'workbuddy-desktop.info')
    await writeFile(authFile, doc('100000000001', 'Alpha'), 'utf8')
    await writeFile(join(dir, 'workbuddy-desktop.2026-07-01T00-00-00-000Z.info'), doc('100000000002', 'Beta'), 'utf8')

    const config: Record<string, unknown> = {
      authFile,
      regions: {
        cn: {
          enabled: true,
          lastCatalog: [{
            id: 'free', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
          }],
          pool: {
            enabled: true,
            rotateByCredits: true,
            autoTestIntervalMinutes: 30,
            memberAccountIds: [],
          },
        },
      },
    }
    const ctx = await mount(config)
    const { body: usageBody } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
    const ids = ((usageBody['accounts'] ?? []) as { id: string }[]).map(account => account.id)
    const pool = (config['regions'] as Record<string, Record<string, unknown>>)['cn']?.['pool'] as Record<string, unknown>
    pool['memberAccountIds'] = [...ids]
    expect(ids.length).toBe(2)

    // Credits per ROUND, by the order accounts are read. Round 1 makes the
    // SECOND-read account richest; round 2 makes the FIRST-read one richest —
    // so the two calls must pick different accounts.
    const realFetch = globalThis.fetch
    let round = 0
    let readsThisRound = 0
    let releaseFirstRound: (() => void) | undefined
    const firstRoundGate = new Promise<void>(resolve => { releaseFirstRound = resolve })
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      const text = String(url)
      if (text.includes('get-user-resource')) {
        readsThisRound += 1
        const position = readsThisRound
        const isFirstRound = round === 0
        // Park the FIRST round so the second call can overtake it.
        if (isFirstRound) await firstRoundGate
        // Round 1: second account richest. Round 2: first account richest.
        const remain = isFirstRound
          ? (position === 1 ? 10 : 900)
          : (position === 1 ? 900 : 10)
        return new Response(JSON.stringify({
          code: 0,
          data: { packages: [{ packageName: 'p', remain, size: 1000, capacityType: 1 }] },
        }), { status: 200 })
      }
      return realFetch(url as never, init as never)
    }) as typeof fetch

    try {
      // Call #1 (older): parks inside its credits read.
      round = 0
      readsThisRound = 0
      ;(ctx as unknown as { emit(name: string): void }).emit('loader/volatile-update')
      await new Promise(resolve => setTimeout(resolve, 40))

      // Call #2 (newer): runs to completion with its own data and writes a pick.
      round = 1
      readsThisRound = 0
      ;(ctx as unknown as { emit(name: string): void }).emit('loader/volatile-update')
      await new Promise(resolve => setTimeout(resolve, 120))
      const { body: afterNewer } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
      const newerPick = (afterNewer['pool'] as { rotatedToAccountId?: string } | undefined)?.rotatedToAccountId
      expect(newerPick).toBeDefined()

      // Now let the OLDER call finish. It must not overwrite the newer decision.
      releaseFirstRound?.()
      await new Promise(resolve => setTimeout(resolve, 150))
      const { body: afterStale } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
      const finalPick = (afterStale['pool'] as { rotatedToAccountId?: string } | undefined)?.rotatedToAccountId
      expect(finalPick).toBe(newerPick)
    } finally {
      releaseFirstRound?.()
      globalThis.fetch = realFetch
    }
  })
})

describe('the pool section and the card share one refresh path (M-4 / L-5)', () => {
  const sourceOf = async (name: string): Promise<string> =>
    await import('node:fs/promises').then(fs => fs.readFile(new URL(`../src/${name}`, import.meta.url), 'utf8'))

  it('re-reads usage after a batch action, not only after a save (M-4)', async () => {
    // The defect: a check-in claims credits and a test writes probe results, but
    // the panel's numbers come from the usage route. Nothing re-read it after a
    // batch, so the card showed PRE-check-in credits until the next 60s poll.
    const card = await sourceOf('client/WorkBuddyCard.tsx')
    expect(card, 'AccountPool is not given a refresh hook').toContain('onRefresh={')
    const pool = await sourceOf('client/AccountPool.tsx')
    // The hook must be declared and actually called on the batch success path.
    expect(pool).toContain('onRefresh?: () => void')
    const callAt = pool.indexOf('onRefresh')
    expect(callAt, 'onRefresh is never mentioned').toBeGreaterThan(-1)
    // Count calls to the IDENTIFIER, not one spelling of the call. The first
    // version of this guard used `indexOf` (so a second call elsewhere was
    // invisible); the second counted the literal `onRefresh?.()`, which N10
    // defeated with `onRefresh?.call(undefined)` inside `finally` — the exact
    // thing this test forbids (a failed batch would re-read and mask the
    // error) while the count stayed at 1.
    const callRe = /onRefresh\s*\??\.\s*(?:\(|call\b|apply\b)/gu
    const calls = [...pool.matchAll(callRe)]
    expect(calls.length, 'onRefresh is never called').toBeGreaterThan(0)
    expect(calls.length, 'onRefresh is not called exactly once').toBe(1)
    const callIndex = calls[0]?.index ?? -1
    // It must run AFTER the completion log inside the same try, i.e. only on a
    // successful batch — not in `finally`/`catch`, where a failed batch would
    // also trigger a re-read and mask the error.
    const doneAt = pool.lastIndexOf("appendLog(t('row.poolLogTestDone')", callIndex)
    expect(doneAt, 'onRefresh is not on the success path').toBeGreaterThan(-1)
    // Bounded by BOTH the catch and the finally, so any position outside the
    // success path is caught rather than only the `finally` one.
    const catchAt = pool.indexOf('} catch', callIndex)
    const finallyAt = pool.indexOf('} finally {', callIndex)
    expect(catchAt, 'onRefresh is not inside the try block').toBeGreaterThan(callIndex)
    expect(callIndex, 'onRefresh is in finally, so it fires on failure too').toBeLessThan(finallyAt)
  })

  it('guards the usage fetch with a PER-REGION latest-wins token (L-5)', async () => {
    // The defect: two overlapping refreshes (poll + save + batch) are plain
    // fetches with no ordering guarantee, so the slower response wins and a
    // pre-check-in snapshot can overwrite a newer one.
    const card = await sourceOf('client/WorkBuddyCard.tsx')
    const at = card.indexOf('const refreshUsage = useCallback')
    expect(at, 'refreshUsage moved — update this guard').toBeGreaterThan(-1)
    const end = card.indexOf('}, [t])', at)
    const body = card.slice(at, end)
    const code = body.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
    // The token is claimed before the fetch and checked before every write.
    expect(code).toContain('usageGuard.current.begin(region)')
    // The POLARITY, not the spelling. `begin()` returns a probe that reports
    // STALE — see `createLatestWins` in `src/account-pool.ts` and the pinned
    // unit tests in `tests/account-pool.spec.ts`. This guard used to require
    // exactly `if (!fresh()) return undefined`, so it ENFORCED an inverted
    // guard that discarded every non-superseded response and left the card
    // rendering its placeholder forever. The rendered tests in
    // `tests/pool-card-render.spec.tsx` own this behaviour now; this source
    // assertion only checks that both write paths are behind a bail-out.
    const guardRe = /if \(stale\(\)\) return undefined/gu
    expect((code.match(guardRe) ?? []).length, 'both write paths must be guarded').toBe(2)
    // What `stale` IS, not merely where it is called (N7). The positional checks
    // below verify the call sites of a predicate this guard never evaluates, so
    // `const stale = () => usageGuard.current.begin(region)()` satisfied all of
    // them while beginning a NEW generation on every call — which makes it
    // report "fresh" always, i.e. a slow stale response wins again. Pin the
    // binding to the RESULT of `begin`, and forbid the function form.
    expect(code, 'the freshness probe is not the RESULT of begin()')
      .toMatch(/const stale = usageGuard\.current\.begin\(region\)/u)
    expect(code, 'the probe re-begins on every call, so it always reports fresh')
      .not.toMatch(/const stale = \(\)/u)
    // WHICH path each guard sits on, not merely how many there are. The first
    // version counted occurrences, so MOVING the success guard down onto the
    // error path (keeping the count at 2) left the suite green while a stale
    // success could again clobber a newer snapshot.
    const guards = [...code.matchAll(guardRe)].map(match => match.index ?? -1)
    // The success write is the FIRST `setStatusByRegion` (the usage snapshot);
    // the error write is the second (the error banner).
    const writes = [...code.matchAll(/setStatusByRegion\(/gu)].map(match => match.index ?? -1)
    expect(writes.length, 'the two write paths moved — update this guard').toBe(2)
    expect(
      guards[0] as number,
      'the SUCCESS write is not behind a freshness check',
    ).toBeLessThan(writes[0] as number)
    expect(
      guards[1] as number,
      'the ERROR write is not behind a freshness check',
    ).toBeLessThan(writes[1] as number)
    // Each guard must belong to its own path: the success guard must not sit
    // after the catch (which would guard the error write instead).
    const catchAt = code.indexOf('} catch')
    expect(guards[0] as number, 'the first guard is on the error path, not the success path')
      .toBeLessThan(catchAt)
    expect(guards[1] as number, 'the second guard is not on the error path')
      .toBeGreaterThan(catchAt)
    // Keyed by region: the card fetches both regions at once, so a global
    // counter would make the two calls cancel each other.
    expect(card).toContain('createLatestWins<WorkBuddyWebRegion>()')
    expect(code, 'the guard is not per region').toContain('begin(region)')
  })

  it('derives "effective members" in ONE place, not five (D6)', async () => {
    // The predicate was written five times: the status document, the batch
    // route's guard, the Host dependency the card reads, `poolMemberAccounts`
    // and the browser helper. Five copies of one rule is this project's most
    // productive bug shape, so the rule has one definition and every site must
    // DELEGATE to it. This guard fails if any site re-inlines the filter.
    const sites = [
      ['web-status.ts', 'the status document'],
      ['index.ts', 'the Host dependency and poolMemberAccounts'],
      ['client/pool-state.ts', 'the browser helper'],
    ] as const
    // COMMENTS *AND* STRING LITERALS STRIPPED before every check. The first
    // version matched raw source, so a bare `// effectiveMembersOf` comment
    // satisfied it — the independent verification proved that by replacing the
    // delegation at `poolMemberAccounts` with exactly such a comment and keeping
    // 651 green. Comments alone were still not enough: N9 defeated it with a
    // STRING holding the asserted text plus a renamed inline filter, so a guard
    // that a mention can satisfy guards nothing. See `stripLiterals`.
    const strip = (text: string): string => stripLiterals(text)
    for (const [file, what] of sites) {
      const source = strip(await sourceOf(file))
      // The CALL, not the name: a mention in a string or a stray identifier
      // must not count as delegation.
      expect(source, `${what} does not CALL the shared rule`).toMatch(/\beffectiveMembersOf\s*\(/u)
    }
    // The route guard reads it through the dependency, so it is covered by
    // `index.ts` — but assert the call site exists so a refactor cannot quietly
    // drop it.
    expect(strip(await sourceOf('web-status.ts'))).toContain('pool.effectiveMemberAccountIds?.(region)')
    // And the shape that WAS duplicated must be gone: an inline
    // `.includes(account.accountId)` / `wanted.has(account.id)` filter.
    const webStatus = strip(await sourceOf('web-status.ts'))
    expect(webStatus, 'the status document re-inlined the filter')
      .not.toContain('memberAccountIds.includes(account.accountId)')
    // Scoped to poolMemberAccounts: `otherAccounts` legitimately filters the
    // COMPLEMENT (`.filter(account => !wanted.has(account.id))`), which is a
    // different predicate and must not be caught by this guard.
    const index = strip(await sourceOf('index.ts'))
    const at = index.indexOf('async function poolMemberAccounts')
    expect(at, 'poolMemberAccounts moved — update this guard').toBeGreaterThan(-1)
    const end = index.indexOf('\n  }', at)
    const body = index.slice(at, end)
    // The SHAPE, not the variable name. The negative check used to name
    // `wanted`; renaming the set to `keep` walked straight past it (N9), while
    // the predicate it describes was re-inlined verbatim.
    expect(body, 'poolMemberAccounts re-inlined the filter')
      .not.toMatch(/accounts\.filter\(account => \w+\.has\(account\.id\)\)/u)
    // The delegation must be what DECIDES the result, not a no-op beside it.
    // The first version asserted `const live = new Set(effectiveMembersOf(...))`
    // and that shape was itself the defect: `accounts.filter(id ∈ set)` collapses
    // to `accounts ∩ saved` for ANY membership rule, so the rule's body could be
    // replaced with `[]` and the suite stayed green (N3, proven by the
    // independent verification). Now the rule's own output must be what is
    // returned, so its answer is observable in the result.
    expect(body, 'poolMemberAccounts does not return the shared rule\'s answer')
      .toMatch(/return effectiveMembersOf\s*\(/u)
    expect(body, 'poolMemberAccounts re-inlined the membership test')
      .not.toMatch(/\.filter\(account => \w+\.has\(/u)
  })

  it('awaits the re-read before discarding the draft, and only after a verified write (A-8)', async () => {
    // The window: `discard()` makes `active` fall back to the `saved` prop, which
    // arrives from the usage route. Discarding first and refreshing afterwards
    // showed the OLD values (with live controls) until the re-read landed. The
    // fix is to await the refresh FIRST and discard after, inside the same try.
    const source = await sourceOf('client/AccountPool.tsx')
    const at = source.indexOf('const save = useCallback')
    expect(at, 'save moved — update this guard').toBeGreaterThan(-1)
    const end = source.indexOf('\n  }, [', at)
    const code = source.slice(at, end).replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
    const refreshAt = code.indexOf('await onSaved?.()')
    expect(refreshAt, 'onSaved is not awaited — A-8 stays open').toBeGreaterThan(-1)
    // `committed` must START false. The first version of this guard never read
    // the initialiser, so `let committed = true` — which discards the draft after
    // a FAILED write, destroying the user's only copy — left the suite green.
    const initAt = code.indexOf('let committed =')
    expect(initAt, '`committed` moved — update this guard').toBeGreaterThan(-1)
    expect(
      code.slice(initAt, code.indexOf('\n', initAt)).trim(),
      'committed starts true, so a failed write discards the user\'s edits',
    ).toBe('let committed = false')
    // The re-read's RESULT must be checked: `refreshUsage` reports a failed
    // fetch by RESOLVING undefined, so "it did not throw" is not "the fresh
    // props arrived" (N1). Without this, a failed re-read still discarded the
    // draft against a stale `saved` prop — the very window A-8 closes.
    const resultAt = code.indexOf('const refreshed = await onSaved?.()')
    expect(resultAt, 'the re-read result is discarded (N1 stays open)').toBeGreaterThan(-1)
    expect(code, 'a failed re-read still commits (N1)').toContain('if (refreshed === false)')
    // The N1 bail-out must come BEFORE `committed = true`.
    const commitAt = code.indexOf('committed = true')
    const bailAt = code.indexOf('if (refreshed === false)')
    expect(bailAt, 'the N1 bail-out does not precede the commit').toBeLessThan(commitAt)
    // `discard()` must come AFTER the awaited refresh, and must be guarded by
    // `committed` so a failed write never throws the only copy away.
    const discardAt = code.indexOf('if (committed) discard()')
    expect(discardAt, 'discard() is not gated on a committed write').toBeGreaterThan(refreshAt)
    expect(code, 'a bare discard() would fire after a failed write').not.toMatch(/(?<!committed\) )discard\(\)/u)
    // `committed = true` must be written EXACTLY ONCE, and never on the error
    // path. The initialiser and the precedence were read above, but the `catch`
    // block was not: adding `committed = true` as the handler's first statement
    // restored the original A-8 defect — a failed WRITE discards the draft,
    // which is the user's only copy of their edits — with this guard fully
    // satisfied (N8, proven by the independent verification).
    const commitWrites = [...code.matchAll(/committed = true/gu)].map(match => match.index ?? -1)
    expect(commitWrites.length, 'committed is set more than once').toBe(1)
    const handlerAt = code.indexOf('} catch')
    expect(handlerAt, 'the catch handler moved — update this guard').toBeGreaterThan(-1)
    expect(
      commitWrites[0] as number,
      'committed is set on the ERROR path, so a failed write discards the draft',
    ).toBeLessThan(handlerAt)
    // The parent must hand back the promise AND its outcome; `void` made the
    // await a no-op, and a bare `refreshUsage(...)` still resolved to undefined
    // on failure, which the section could not tell from success.
    const card = await sourceOf('client/WorkBuddyCard.tsx')
    expect(card, 'onSaved swallows its promise, so the await resolves immediately')
      .toContain('onSaved={async () => (await refreshUsage(activeRegion)) !== undefined}')
    expect(card).not.toContain('onSaved={() => { void refreshUsage(activeRegion) }}')
    expect(card).not.toContain('onSaved={() => refreshUsage(activeRegion)}')
  })

  it('declares every prop callback its useCallbacks read (D5, generalised)', async () => {
    // D5 was ONE instance of a shape: a memoized callback whose body reads a
    // value missing from its dependency array, so the click handler closes over
    // a stale render. `saved`/`active` were fixed by reading through `pool`;
    // this generalises the check to EVERY destructured prop, not a hardcoded
    // list of four callback names. The earlier version watched only
    // `onSaved`/`onRefresh`/`onRotationChange`/`onBusyChange`, so a callback
    // reading the `pool` PROP without declaring it stayed green.
    const source = await sourceOf('client/AccountPool.tsx')
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
    // The component's own prop names, read from its destructuring — so a prop
    // added later is covered automatically.
    const destructure = code.match(/const \{([^}]*)\} = props/u)
    expect(destructure, 'the props destructuring moved — update this guard').not.toBeNull()
    const props = (destructure?.[1] ?? '')
      .split(',')
      .map(name => name.trim().split(':')[0]?.trim() ?? '')
      .filter(name => name !== '')
    expect(props.length, 'no props found in the destructuring').toBeGreaterThan(3)
    const callbacks = [...code.matchAll(/const (\w+) = useCallback\(/gu)]
    expect(callbacks.length, 'no useCallback found — update this guard').toBeGreaterThan(0)
    for (const match of callbacks) {
      const name = match[1]
      const start = match.index ?? 0
      const depsAt = code.indexOf('\n  }, [', start)
      if (depsAt === -1) continue
      // String literals removed first (N17): a mention of a binding inside a
      // string is not a read of it. The rule used to match one, so correct code
      // failed the guard — and a guard that fails correct code gets neutered by
      // whoever hits it.
      const body = stripLiterals(code.slice(start, depsAt))
      const deps = code.slice(depsAt, code.indexOf(']', depsAt))
      for (const prop of props) {
        // Word-boundary match so `pool` does not match `poolBusy`.
        if (!new RegExp(`\\b${prop}\\b`, 'u').test(body)) continue
        expect(deps, `${name ?? '?'} reads the ${prop} prop but does not declare it`).toContain(prop)
      }
    }
    // The SAME staleness class, second half: a callback that closes over a
    // render-scoped DERIVED value (`saved`, `active`, `dirty`, …) rather than a
    // prop. That was literally H-1 — `editDraft` read `saved.memberAccountIds`
    // while its deps omitted it, so a member toggle silently reverted. Watching
    // only props would miss its return. These bindings are rebuilt on every
    // render, so either the callback declares them or it must read through a
    // dependency instead (`pool`, a ref) — which is what the current code does.
    const derived = [
      'saved', 'active', 'dirty', 'listedIds', 'savedEffective', 'effectiveMembers',
      'ghostMembers', 'usable', 'usableMemberSet', 'current',
    ]
    for (const match of callbacks) {
      const name = match[1]
      const start = match.index ?? 0
      const depsAt = code.indexOf('\n  }, [', start)
      if (depsAt === -1) continue
      // String literals removed first (N17): a mention of a binding inside a
      // string is not a read of it. The rule used to match one, so correct code
      // failed the guard — and a guard that fails correct code gets neutered by
      // whoever hits it.
      const body = stripLiterals(code.slice(start, depsAt))
      const deps = code.slice(depsAt, code.indexOf(']', depsAt))
      for (const binding of derived) {
        // `current` is also a lambda parameter inside `editDraft`-style updaters
        // (`(current) => …`) and a PROPERTY name on refs/rows (`mounted.current`,
        // `account.current`), so require the name to be read as a free variable:
        // skip it when the body declares it as a parameter or reads it off an
        // object.
        if (new RegExp(`\\(\\s*${binding}\\b`, 'u').test(body)) continue
        if (!new RegExp(`(^|[^.\\w])${binding}\\b`, 'u').test(body)) continue
        // Object-literal KEYS (`announcedBatchCount({ savedEffective: … })`) and
        // property shorthand are names in a shape, not reads of the binding.
        if (new RegExp(`(^|[^.\\w])${binding}\\s*:`, 'u').test(body)) continue
        expect(
          deps,
          `${name ?? '?'} reads the render-scoped ${binding} but does not declare it (H-1 shape)`,
        ).toContain(binding)
      }
    }
  })

  it('imports the tested latest-wins rule instead of re-implementing it', async () => {
    // One definition, one set of tests. A second inline counter would drift.
    const card = await sourceOf('client/WorkBuddyCard.tsx')
    expect(card).toContain("import { createLatestWins } from '../account-pool.ts'")
  })

  it('wires the interval field through the tested keystroke rule (M-2 wiring)', async () => {
    // The verification reverted the CARD's wiring — displaying a re-serialized
    // clamped number instead of the raw entry — and the whole suite stayed green,
    // because only the pure helper was pinned. `parseIntervalInput` alone cannot
    // express "show what was typed"; the card must go through
    // `intervalEditOnInput`, whose `text` is the raw keystroke.
    const pool = await sourceOf('client/AccountPool.tsx')
    const code = pool.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
    const at = code.indexOf('const onIntervalInput = useCallback')
    expect(at, 'onIntervalInput moved — update this guard').toBeGreaterThan(-1)
    const body = code.slice(at, code.indexOf('\n  }, [editDraft])', at))
    expect(body, 'the card no longer uses the shared keystroke rule').toContain('intervalEditOnInput(raw)')
    // The displayed text must come from that rule's `text` (the raw entry), never
    // from re-serializing a parsed number — that is the `120` → `520` defect.
    expect(body, 'the field re-serializes a parsed number into the display')
      .not.toMatch(/setIntervalText\(\s*String\(/u)
    // POSITIVE form (N6). The negative above is anchored on the first token after
    // `setIntervalText(`, so a ternary wrapper walks past it:
    // `setIntervalText(commit === undefined ? text : String(commit))` restores the
    // defect while still containing `String(`. A guard that names what MUST happen
    // is strictly stronger than one that names what must not, so name the use:
    // the rule's own `text` is what reaches the field.
    expect(body, 'the shared rule\'s `text` never reaches the field')
      .toContain('setIntervalText(text)')
    // And the clamp must not be re-derived by hand beside the rule it ignores.
    expect(body, 'the clamp is re-derived by hand instead of used')
      .not.toMatch(/String\(/u)
    // And the input handler must not call the bare parser for its display.
    expect(body).toContain('const { text, commit } = intervalEditOnInput(raw)')
    // The controlled value must fall back to the committed number, so the field
    // is never blank when no edit is in progress.
    expect(pool).toContain('value: intervalText ?? String(active.autoTestIntervalMinutes)')
  })
})
