/**
 * Issue #214 — the international card showed prices the upstream had stopped
 * charging, and the "Refresh from WorkBuddy" button changed nothing.
 *
 * TWO DEFECTS, both reproduced here against the real `apply()` and the real
 * status routes:
 *
 *   1. THE STATIC FALLBACK TABLE WAS TREATED AS THE UPSTREAM. `displayModels()`
 *      handed `catalog.current()` to `resolveRoster` for its `live` argument
 *      without asking `hasLiveRoster()`, and `current()` is seeded with the
 *      built-in table by the constructor. Since `overlayLiveCapabilities` lets
 *      the live side own `creditMultiplier`, that table's captured rates
 *      overrode the user's saved ones — the reporter's `glm-5.3` x0.79 (table)
 *      where saved and upstream both said x0.69, and `hy4-preview` x0.00
 *      (table) where the real charge was x0.29. 5.18.0 fixed the same mistake
 *      in `applySelection` but not in this reader, which is why the report
 *      survived the upgrade.
 *
 *   2. `POST /models/refresh` WROTE NOTHING. It answered with the fresh rows
 *      and dropped them, so one press produced two answers on one host and
 *      `cordis.patch.yml` never changed. The button was inert for both the card
 *      and the disk.
 *
 * The account-resolution harness (`LlmRuntime` + a 0.1.7-shaped `Settings`
 * double) is the one issue #12's region tests use; the startup refresh is
 * fire-and-forget, so these tests POLL rather than sleep a fixed time.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import * as WorkBuddy from '../src/index.ts'
import {
  WORKBUDDY_MODELS_REFRESH_PATH,
  WORKBUDDY_USAGE_PATH,
} from '../src/status-paths.ts'
import type { WorkBuddyWebModel } from '../src/status-paths.ts'

/** The config object the mounted plugin reads; reset between tests. */
let liveConfig: Record<string, unknown> = {}
let context: Context | undefined
/** Every settings write the plugin attempted, in order. */
let writes: unknown[] = []
/**
 * When set, every `mutate()` rejects with this message.
 *
 * The real failure this models is a locked or read-only settings file (the
 * `EPERM` case issue #131 reports on Windows). The plugin cannot tell that
 * apart from any other write failure, and it must not pretend the write landed.
 */
let mutateFails: string | undefined = undefined

/**
 * The 0.1.7-shaped settings service, standing in for `SettingsForms`.
 *
 * `describe()` answers the SAME object the plugin was mounted with, so a
 * `mutate()` that lands is visible to the next read — exactly like the real
 * Loader committing a write.
 */
class MemorySettings extends Service {
  constructor(ctx: Context) { super(ctx, 'settings') }
  configure() { return () => {} }
  describe() {
    return [{ ns: WorkBuddy.WORKBUDDY_SETTINGS_NS, autoGenerate: true, revision: 0, applies: 'live', value: liveConfig }]
  }
  async update(_ns: string, patch: Record<string, unknown>): Promise<void> {
    writes.push(structuredClone(patch))
    for (const [key, value] of Object.entries(patch)) liveConfig[key] = structuredClone(value)
    ;(context as unknown as { emit(name: string): void })?.emit('loader/volatile-update')
  }
  async mutate(_ns: string, ops: { op: string, path: string[], value: unknown }[]): Promise<void> {
    if (mutateFails !== undefined) throw new Error(mutateFails)
    for (const op of ops) {
      writes.push(structuredClone(op.value))
      liveConfig[op.path[0] as string] = structuredClone(op.value)
    }
  }
}

afterEach(async () => {
  globalThis.fetch = realFetch
  await context?.fiber.dispose()
  context = undefined
  liveConfig = {}
  writes = []
  mutateFails = undefined
})

/** A global-region account on disk (the reporter's `personal_free_user` case). */
async function globalRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-214-global-'))
  const dir = join(root, 'auth')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'workbuddy-desktop-ai.info'), JSON.stringify({
    account: { uid: 'uid-g', uin: '100000000009', nickname: 'Global', enterpriseId: '' },
    auth: {
      accessToken: 'token-global', refreshToken: 'refresh-global', tokenType: 'Bearer',
      domain: 'www.workbuddy.ai', expiresAt: Date.now() + 86_400_000,
      refreshExpiresAt: Date.now() + 7 * 86_400_000,
    },
  }), 'utf8')
  return join(dir, 'workbuddy-desktop-ai.info')
}

/** The `lastCatalog` the reporter had on disk: rates the table disagrees with. */
const SAVED_GLOBAL = [
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000, creditMultiplier: 0.69 },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, maxTokens: 64_000, creditMultiplier: 0.29 },
  { id: 'deepseek-v4.1-flash-sg', name: 'DeepSeek SG', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 0.11 },
]

/** What `/v3/config` answered at 2026-11-04 for the same three models. */
const LIVE_GLOBAL = [
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000, creditMultiplier: 0.69 },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, maxTokens: 64_000, creditMultiplier: 0.29 },
  { id: 'deepseek-v4.1-flash-sg', name: 'DeepSeek SG', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 0.11 },
]

interface CapturedRoute {
  path: string
  handler: (req: never, res: never) => Promise<void> | void
}

/** Every status route the plugin mounted during the last `mount()`. */
let routes: CapturedRoute[] = []

const WebServer = {
  name: 'webServer',
  inject: [] as const,
  apply(ctx: Context) {
    ctx.provide('webServer', {
      register: (entry: CapturedRoute) => { routes.push(entry); return () => {} },
    })
  },
}

interface Answer { status: number, body: Record<string, unknown> }

async function call(path: string, init: { method?: string, region?: string } = {}): Promise<Answer> {
  const route = routes.find(entry => entry.path === path)
  if (route === undefined) throw new Error(`route not mounted: ${path}`)
  const url = init.region === undefined ? path : `${path}?region=${init.region}`
  let status = 0
  let payload = ''
  await route.handler(
    {
      method: init.method ?? 'GET',
      url,
      headers: { host: '127.0.0.1:62283', origin: 'http://127.0.0.1' },
    } as never,
    {
      writeHead: (code: number) => { status = code },
      write: () => {},
      end: (chunk?: string) => { payload = chunk ?? '' },
    } as never,
  )
  return { status, body: JSON.parse(payload === '' ? '{}' : payload) as Record<string, unknown> }
}

/** The rates one `usage` answer reports, keyed by model id. */
async function usageRates(region: string): Promise<Record<string, number | undefined>> {
  const { body } = await call(WORKBUDDY_USAGE_PATH, { region })
  const models = (body['models'] ?? []) as WorkBuddyWebModel[]
  return Object.fromEntries(models.map(model => [model.id, model.creditMultiplier]))
}

/**
 * Mount the plugin with an upstream stub, and leave the stub installed.
 *
 * `upstreamRates` is a live object so a test can change what the gateway
 * answers between two reads — that is how "the price moved while the harness
 * was running" is expressed without a restart. The stub deliberately outlives
 * `mount()`: the startup refresh is fire-and-forget, so it may still be in
 * flight when this returns, and restoring the real `fetch` underneath it would
 * turn a slow test into a mysterious one.
 *
 * `afterEach` owns restoring it.
 */
async function mount(
  config: Record<string, unknown>,
  upstream: { rates: Record<string, number>, reachable?: boolean },
): Promise<Context> {
  routes = []
  liveConfig = config
  installUpstream(upstream)
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(WebServer)
  await ctx.plugin(MemorySettings)
  WorkBuddy.apply(ctx, config as WorkBuddy.Config)
  return ctx
}

/** Route every request the plugin makes to the shared `upstream` stub. */
function installUpstream(upstream: { rates: Record<string, number>, reachable?: boolean }): void {
  globalThis.fetch = (async (input: never) => {
    const url = String(input)
    if (url.includes('/v3/config') || url.includes('/v2/enterprises/personal/models')) {
      if (upstream.reachable === false) throw new Error('offline')
      const models = Object.entries(upstream.rates).map(([id, rate]) => ({
        id,
        name: id,
        maxInputTokens: 1_000_000,
        maxOutputTokens: 48_000,
        credits: `x${rate.toFixed(2)} credits`,
      }))
      return new Response(JSON.stringify({
        code: 0,
        data: { models, agents: [{ name: 'cli', models: Object.keys(upstream.rates) }] },
      }), { status: 200 })
    }
    // The load probe 404s on the international gateway; everything else is a
    // billing read these tests do not exercise.
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

/** The real `fetch`, restored after every test. */
const realFetch = globalThis.fetch

describe('issue #214: the card shows the saved price, not the built-in table', () => {
  it('reports the SAVED rate while the upstream has not answered yet', async () => {
    // The reporter's step 1-3: a saved directory whose price disagrees with the
    // static table, and a first `/v3/config` that has not landed.
    const authFile = await globalRoot()
    await mount(
      { authFile, regions: { global: { enabled: true, lastCatalog: SAVED_GLOBAL } } },
      { rates: {}, reachable: false },
    )
    const rates = await usageRates('global')
    // 0.79 is `FALLBACK_WORKBUDDY_MODELS_GLOBAL`'s captured `glm-5.3` rate — the
    // value the reporter saw and the reason they filed this.
    expect(rates['glm-5.3']).toBe(0.69)
    // The table said x0.00 (free) while the upstream charged x0.29. A wrong
    // "free" is worse than a wrong number: it is an invitation to spend.
    expect(rates['hy4-preview']).toBe(0.29)
  })

  it('asserts NO rate at all when nothing was ever saved', async () => {
    // The table carries no price now (issue #214), so a never-configured
    // profile must report "unknown" rather than a rate captured on 2026-09-11.
    // `null`/absent both render as "no rate"; neither may be a number, and in
    // particular none may be 0 — `pickFreeModel` treats 0 as FREE and would
    // then probe a paid model with real credits.
    const authFile = await globalRoot()
    await mount({ authFile, regions: { global: { enabled: true } } }, { rates: {}, reachable: false })
    const rates = await usageRates('global')
    expect(Object.keys(rates).length).toBeGreaterThan(0)
    for (const [id, rate] of Object.entries(rates)) {
      expect(rate, `${id} must carry no rate on an unconfigured profile`).toBeUndefined()
    }
  })

  it('lists the saved directory alone while no live roster exists', async () => {
    // Before the first refresh the card must describe the USER's directory, not
    // the plugin's placeholder. This is the read-side rule that
    // `hasLiveRoster()` enforces in `displayModels`.
    //
    // HONEST NOTE ON WHAT THIS PINS. It does NOT fail if that guard is removed:
    // `isUnconfiguredFallbackSnapshot` already replaces a saved directory that
    // is byte-identical to the table, and the table no longer asserts any
    // live-owned field, so a placeholder entry merged over a saved one is now
    // indistinguishable from it. The test therefore pins the OBSERVABLE
    // CONTRACT — "an unconfigured/offline card shows exactly what was saved" —
    // rather than the mechanism. The mechanism is still worth having: it keeps
    // the overlay from ever consulting a table that is not the upstream, so a
    // future field added to that table cannot silently start overriding a
    // saved one (which is precisely how issue #214 happened).
    const authFile = await globalRoot()
    await mount(
      {
        authFile,
        regions: {
          global: {
            enabled: true,
            lastCatalog: [
              { id: 'my-own-model', name: 'Mine', contextWindow: 1_000_000, maxTokens: 48_000, creditMultiplier: 0.5 },
            ],
          },
        },
      },
      { rates: {}, reachable: false },
    )
    const { body } = await call(WORKBUDDY_USAGE_PATH, { region: 'global' })
    const models = (body['models'] ?? []) as WorkBuddyWebModel[]
    expect(models.map(model => model.id)).toEqual(['my-own-model'])
    expect(models[0]?.creditMultiplier).toBe(0.5)
  })

  it('keeps a saved model the placeholder table does not list', async () => {
    // `mergeRoster` keeps saved-only models, so this passes either way — it is
    // here to pin the OTHER side of the guard: dropping `live` must not drop
    // the user's directory. A fix that "removed the fallback" by ignoring the
    // saved list would be far worse than the bug.
    const authFile = await globalRoot()
    await mount(
      {
        authFile,
        regions: {
          global: {
            enabled: true,
            lastCatalog: [
              { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000, creditMultiplier: 0.69 },
              { id: 'withdrawn-model', name: 'Withdrawn', contextWindow: 1_000_000, maxTokens: 48_000, creditMultiplier: 1.5 },
            ],
          },
        },
      },
      { rates: {}, reachable: false },
    )
    const rates = await usageRates('global')
    expect(rates['withdrawn-model']).toBe(1.5)
  })

  it('follows a rate the upstream changed while the harness was running', async () => {
    // The overlay rule is "the live side owns `creditMultiplier`". That rule is
    // RIGHT — a live price must beat a saved one — so the fix must not be
    // achieved by disabling it. This pins the other direction: once a real
    // upstream answer exists, its rate wins.
    const authFile = await globalRoot()
    const upstream = { rates: { 'glm-5.3': 0.55 } }
    const ctx = await mount(
      { authFile, regions: { global: { enabled: true, lastCatalog: SAVED_GLOBAL } } },
      upstream,
    )
    // Wait for the startup refresh to land: the rate on screen must MOVE to the
    // upstream's, which is proof the roster is now live rather than saved.
    await expect.poll(async () => (await usageRates('global'))['glm-5.3'], { timeout: 15_000 }).toBe(0.55)
    // `hy4-preview` is not in the upstream roster, so it is kept from the saved
    // directory (issue #32: a refresh must never withdraw it) at its saved rate.
    expect((await usageRates('global'))['hy4-preview']).toBe(0.29)
    await ctx.fiber.dispose()
    context = undefined
  })
})

describe('issue #214: models/refresh records what it read', () => {
  it('persists the fresh directory so the next usage read reports it', async () => {
    const authFile = await globalRoot()
    const upstream = { rates: { 'glm-5.3': 0.69, 'hy4-preview': 0.29 } }
    await mount(
      { authFile, regions: { global: { enabled: true, lastCatalog: SAVED_GLOBAL } } },
      upstream,
    )
    // Let the startup refresh settle so the poll below observes the BUTTON.
    await expect.poll(async () => (await usageRates('global'))['glm-5.3'], { timeout: 15_000 }).toBe(0.69)

    // The upstream moves, and nothing else changes on disk.
    upstream.rates['glm-5.3'] = 0.42
    const refreshed = await call(WORKBUDDY_MODELS_REFRESH_PATH, { method: 'POST', region: 'global' })
    expect(refreshed.status).toBe(200)
    const rows = (refreshed.body['models'] ?? []) as WorkBuddyWebModel[]
    expect(rows.find(row => row.id === 'glm-5.3')?.creditMultiplier).toBe(0.42)

    // THE REPORTED DEFECT: this used to stay 0.79/0.69 while the reply said
    // 0.42. The card renders `displayModels()`, so an unpersisted refresh was
    // invisible to the very surface that had a refresh button on it.
    expect((await usageRates('global'))['glm-5.3']).toBe(0.42)
    // And it is on disk, so it survives closing the card.
    const saved = (liveConfig['regions'] as { global?: { lastCatalog?: { id: string, creditMultiplier?: number }[] } })
      ?.global?.lastCatalog ?? []
    expect(saved.find(model => model.id === 'glm-5.3')?.creditMultiplier).toBe(0.42)
  })

  it('reports a failed write instead of a 200 for a directory it could not save', async () => {
    // The whole point of persisting on refresh is that the user can TRUST the
    // new number: close the card, restart, and it is still there. If the write
    // fails (a locked settings file — the `EPERM` case on Windows), a 200 would
    // instead report success for a save that did not happen, and the next read
    // would quietly disagree with the reply the user just saw.
    //
    // So the write is awaited BEFORE the answer, and its error becomes the
    // answer.
    const authFile = await globalRoot()
    const upstream = { rates: { 'glm-5.3': 0.69, 'hy4-preview': 0.29 } }
    await mount(
      { authFile, regions: { global: { enabled: true, lastCatalog: SAVED_GLOBAL } } },
      upstream,
    )
    await expect.poll(async () => (await usageRates('global'))['glm-5.3'], { timeout: 15_000 }).toBe(0.69)

    upstream.rates['glm-5.3'] = 0.42
    mutateFails = 'EPERM: operation not permitted, open cordis.patch.yml'
    const refreshed = await call(WORKBUDDY_MODELS_REFRESH_PATH, { method: 'POST', region: 'global' })
    expect(refreshed.status).toBe(500)
    expect(String(refreshed.body['error'])).toContain('EPERM')
    // And the disk still holds the old rate, so the failure is real rather than
    // merely reported: the two documents never silently disagree.
    const saved = (liveConfig['regions'] as { global?: { lastCatalog?: { id: string, creditMultiplier?: number }[] } })
      ?.global?.lastCatalog ?? []
    expect(saved.find(model => model.id === 'glm-5.3')?.creditMultiplier).toBe(0.69)
  })

  it('leaves the user\'s unsaved selection alone', async () => {
    // Refresh is documented as a DRAFT operation that Save commits (README.md,
    // docs/DESIGN.md). The directory is the plugin's own bookkeeping and may be
    // repaired behind the user's back; the SELECTION is their edit and must not
    // be committed by a refresh.
    const authFile = await globalRoot()
    await mount(
      {
        authFile,
        regions: {
          global: {
            enabled: true,
            lastCatalog: SAVED_GLOBAL,
            // An unsaved-ish selection: only one of the three is ticked.
            enabledModelIds: ['glm-5.3'],
            imageModelIds: ['hy4-preview'],
            contextBudgets: { 'glm-5.3': 200_000 },
          },
        },
      },
      { rates: { 'glm-5.3': 0.69, 'hy4-preview': 0.29 } },
    )
    await expect.poll(async () => (await usageRates('global'))['glm-5.3'], { timeout: 15_000 }).toBe(0.69)
    const before = structuredClone((liveConfig['regions'] as Record<string, unknown>)['global'])
    expect((await call(WORKBUDDY_MODELS_REFRESH_PATH, { method: 'POST', region: 'global' })).status).toBe(200)
    const after = (liveConfig['regions'] as { global: Record<string, unknown> }).global
    expect(after['enabledModelIds']).toEqual((before as Record<string, unknown>)['enabledModelIds'])
    expect(after['imageModelIds']).toEqual((before as Record<string, unknown>)['imageModelIds'])
    expect(after['contextBudgets']).toEqual((before as Record<string, unknown>)['contextBudgets'])
  })

  it('refuses with 503 when the build cannot persist, instead of answering a number it will forget', async () => {
    // A 200 here would paint the card's draft from rows nothing remembers — the
    // exact "the button did nothing" report. The route must say it cannot.
    const { registerWorkBuddyStatusRoute } = await import('../src/web-status.ts')
    const captured: CapturedRoute[] = []
    const ctx = new Context()
    await ctx.plugin({
      name: 'webServer',
      inject: [] as const,
      apply(inner: Context) {
        inner.provide('webServer', {
          register: (entry: CapturedRoute) => { captured.push(entry); return () => {} },
        })
      },
    })
    registerWorkBuddyStatusRoute(ctx, {
      store: () => ({}) as never,
      client: {} as never,
      discoverModels: async () => [
        { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000 },
      ],
      displayModels: () => [],
      enabledModelIds: () => [],
      imageModelIds: () => [],
      offModelIds: () => [],
      contextBudgets: () => ({}),
      regionEnabled: () => true,
    } as never)
    const refresh = captured.find(entry => entry.path === WORKBUDDY_MODELS_REFRESH_PATH)
    if (refresh === undefined) throw new Error('refresh route was not registered')
    let status = 0
    let payload = ''
    await refresh.handler(
      { method: 'POST', url: `${WORKBUDDY_MODELS_REFRESH_PATH}?region=cn`, headers: { host: '127.0.0.1', origin: 'http://127.0.0.1' } } as never,
      { writeHead: (code: number) => { status = code }, write: () => {}, end: (chunk?: string) => { payload = chunk ?? '' } } as never,
    )
    expect(status).toBe(503)
    expect(JSON.parse(payload)).toMatchObject({ error: expect.stringContaining('persist') as unknown as string })
    await ctx.fiber.dispose()
  })
})
