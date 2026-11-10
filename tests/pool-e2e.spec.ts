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
import { WORKBUDDY_POOL_PATH, WORKBUDDY_USAGE_PATH } from '../src/status-paths.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import { readPoolProbes, writePoolProbes } from '../src/account-pool-store.ts'
import * as Shim from '../src/shim.ts'

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

/**
 * Write a SECOND CN sign-in beside the first, so a test can express "one account
 * is limited, another is available" — the scenario the pool exists for, and the
 * one where "the available account becomes the current one" is observable.
 *
 * Returns the second account's real id, discovered the same way as the first's.
 */
async function writeSecondAuthFixture(root: string): Promise<string> {
  const dir = join(root, 'auth')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'workbuddy-desktop-2.info')
  await writeFile(path, JSON.stringify({
    account: { uid: 'uid-2', uin: '100000000002', nickname: 'Beta', enterpriseId: '' },
    auth: {
      accessToken: 'token-beta',
      refreshToken: 'refresh-beta',
      tokenType: 'Bearer',
      domain: 'www.codebuddy.cn',
      expiresAt: Date.now() + 86_400_000,
      refreshExpiresAt: Date.now() + 7 * 86_400_000,
    },
  }), 'utf8')
  return path
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
/** Both fixture accounts' real ids, in the order the Host lists them. */
async function discoverAccountIds(dir: string): Promise<string[]> {
  await mount({ authFile: dir, regions: { cn: { enabled: true } } })
  const { body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
  const accounts = (body['accounts'] ?? []) as { id: string }[]
  await context?.fiber.dispose()
  context = undefined
  return accounts.map(account => account.id)
}

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
  res: {
    writeHead: (s: number, h?: Record<string, string>) => void
    write: (chunk: string) => void
    end: (b?: string) => void
  }
  status: () => number
  body: () => Record<string, unknown>
  /** Every NDJSON chunk the handler streamed, in order. */
  chunks: () => string[]
} {
  let statusCode = 0
  let payload = ''
  const streamed: string[] = []
  return {
    res: {
      writeHead: (s: number) => { statusCode = s },
      // Streaming is how a long batch reports each row as it finishes, so a
      // handler under test may write instead of (or before) ending with a body.
      // Recorded rather than discarded: the pool's test route is only reachable
      // far enough to stream once every guard passes, which is precisely the
      // part worth asserting on.
      write: (chunk: string) => { streamed.push(chunk) },
      end: (b?: string) => { payload = b ?? '' },
    },
    status: () => statusCode,
    body: () => JSON.parse(payload || '{}') as Record<string, unknown>,
    chunks: () => streamed,
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
    // `host` is required, not decoration: every real request carries one and the
    // routes refuse a missing Host (DNS-rebinding guard).
    { method: init.method ?? 'GET', url: init.url ?? path, headers: { host: '127.0.0.1:62283' } } as never,
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
  describe('request-side credit recovery', () => {
    let previousDshHome: string | undefined
    beforeEach(async () => {
      previousDshHome = process.env['DSH_HOME']
      process.env['DSH_HOME'] = await mkdtemp(join(tmpdir(), 'wb-request-recovery-'))
    })
    afterEach(async () => {
      await context?.fiber.dispose()
      context = undefined
      if (previousDshHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previousDshHome
    })

    it('reconciles depleted members before a request without opening a status card, sharing concurrent reads', async () => {
      const authFile = await writeAuthFixture(root)
      await writeSecondAuthFixture(root)
      const ids = await discoverAccountIds(authFile)
      const accountId = ids[0] as string
      const otherId = ids[1] as string
      const shim = vi.spyOn(Shim, 'createWorkBuddyShim')
      let release: (() => void) | undefined
      const credits = vi.spyOn(WorkBuddyUpstreamClient.prototype, 'fetchCredits').mockImplementation(async () => {
        await new Promise<void>(resolve => { release = resolve })
        return { total: 100, expiringSoon: 0, packages: [] }
      })
      const chat = vi.spyOn(WorkBuddyUpstreamClient.prototype, 'chatStream')
      try {
        await mount({ authFile, regions: { cn: { enabled: true, pool: { enabled: true, memberAccountIds: ids } } } })
        await writePoolProbes('cn', {
          [accountId]: { outcome: 'out-of-credit', atMs: Date.now() - 1000 },
          [otherId]: { outcome: 'rate-limited', atMs: Date.now(), retryAtMs: Date.now() + 60_000 },
        })
        const prepare = shim.mock.calls[0]?.[0].prepareAccount
        expect(prepare).toBeTypeOf('function')
        const requests = Promise.all([prepare?.(), prepare?.()])
        await waitFor(async () => release !== undefined, 'the request balance query')
        expect(credits).toHaveBeenCalledTimes(1)
        release?.()
        await requests
        const probes = await readPoolProbes('cn')
        expect(probes[accountId]).toBeUndefined()
        expect(probes[otherId]?.outcome).toBe('rate-limited')
        expect(chat).not.toHaveBeenCalled()
      } finally {
        release?.()
        shim.mockRestore()
        credits.mockRestore()
        chat.mockRestore()
      }
    })

    it('retains depleted state after zero or failed reads and retries only after the request check interval', async () => {
      const authFile = await writeAuthFixture(root)
      const accountId = await discoverAccountId(authFile)
      const shim = vi.spyOn(Shim, 'createWorkBuddyShim')
      const credits = vi.spyOn(WorkBuddyUpstreamClient.prototype, 'fetchCredits')
        .mockResolvedValueOnce({ total: 0, expiringSoon: 0, packages: [] })
        .mockRejectedValueOnce(new Error('fixture query failure'))
        .mockResolvedValue({ total: 100, expiringSoon: 0, packages: [] })
      const start = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
      try {
        await mount({ authFile, regions: { cn: { enabled: true, pool: { enabled: true, memberAccountIds: [accountId] } } } })
        await writePoolProbes('cn', { [accountId]: { outcome: 'out-of-credit', atMs: start - 1000 } })
        const prepare = shim.mock.calls[0]?.[0].prepareAccount
        expect(prepare).toBeTypeOf('function')
        await prepare?.()
        expect((await readPoolProbes('cn'))[accountId]?.outcome).toBe('out-of-credit')
        await prepare?.()
        expect(credits).toHaveBeenCalledTimes(1)
        clock.mockReturnValue(start + 60_000)
        await prepare?.()
        expect((await readPoolProbes('cn'))[accountId]?.outcome).toBe('out-of-credit')
        expect(credits).toHaveBeenCalledTimes(2)
        clock.mockReturnValue(start + 120_000)
        await prepare?.()
        expect((await readPoolProbes('cn'))[accountId]).toBeUndefined()
        expect(credits).toHaveBeenCalledTimes(3)
      } finally {
        clock.mockRestore()
        credits.mockRestore()
        shim.mockRestore()
      }
    })

  })

  it('releases a depleted account only after a later pool balance query confirms credits', async () => {
    const authFile = await writeAuthFixture(root)
    const accountId = await discoverAccountId(authFile)
    const credits = vi.spyOn(WorkBuddyUpstreamClient.prototype, 'fetchCredits')
      .mockResolvedValue({ total: 0, expiringSoon: 0, packages: [] })
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })) as typeof fetch
    try {
      await mount({ authFile, regions: { cn: { enabled: true, pool: { enabled: true, memberAccountIds: [accountId] } } } })
      await writePoolProbes('cn', {
        [accountId]: { outcome: 'out-of-credit', atMs: Date.now() - 1000, retryAtMs: Date.now() + 21 * 86_400_000 },
      })
      const depleted = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
      const poolOf = (body: Record<string, unknown>) => body['pool'] as { accounts: { accountId: string, excludedBy?: string, probe?: unknown }[] }
      expect(poolOf(depleted.body).accounts.find(row => row.accountId === accountId)?.excludedBy).toBe('out-of-credit')
      credits.mockResolvedValue({ total: 20, expiringSoon: 0, packages: [] })
      const replenished = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
      const recovered = poolOf(replenished.body).accounts.find(row => row.accountId === accountId)
      expect(recovered).toBeDefined()
      expect(recovered?.excludedBy).toBeUndefined()
      expect(recovered?.probe).toBeUndefined()
      expect((await readPoolProbes('cn'))[accountId]).toBeUndefined()
    } finally {
      globalThis.fetch = realFetch
      credits.mockRestore()
    }
  })

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



  /**
   * The claim pill must stay INSIDE the credits column (issue #79).
   *
   * Regression guard for a defect a screenshot showed: the benefit entry painted
   * on top of the probe column beside it. jsdom cannot catch that — it performs
   * no layout, so an overflow assertion there is vacuously true. The cause is
   * structural: the entry is a flex item containing a NOWRAP line and a
   * flex:none pill, so its min-content is the whole line plus the button, and a
   * flex item defaults to min-width:auto, which refuses to shrink below it.
   *
   * The rule is therefore asserted on the source: the entry itself must opt out
   * of the automatic minimum. Measured in headless Chrome against the real
   * rendered row (min-width:0 -> 0 overflowing children; without it -> 3).
   */
  it('lets the benefit entry shrink below its content, so the pill cannot overrun the column', async () => {
    const styles = await sourceOf('client/styles.ts')
    const entry = styles.match(/\.dsm-workbuddy-pool-benefit\{([^}]*)\}/u)?.[1] ?? ''
    expect(entry, 'the benefit entry rule was not found').not.toBe('')
    expect(entry, 'a flex item keeps min-width:auto, so the pill overflows the column')
      .toMatch(/min-width:\s*0/)
    // The tracks were NOT the fix and must not be re-tried as one: the entry
    // overflows its CELL, so widening or narrowing a track changes nothing.
    //
    // The row's grid has since been replaced wholesale (two named lines at every
    // width, see pool-card-render), and it now DOES carry minmax — for an
    // unrelated reason: a zero minimum on the flexible track is what lets a long
    // account name or verdict shrink instead of widening the row. That is not a
    // claim about this overflow, which is why the assertion moved from "no
    // minmax anywhere" to the property that actually matters here: the entry
    // must still be the thing that gives way.
    const row = styles.match(/\.dsm-workbuddy-pool-row\{([^}]*)\}/u)?.[1] ?? ''
    expect(row, 'the pool row grid declaration was not found').not.toBe('')
    expect(entry, 'the entry must remain the shrinking element, not the track')
      .toMatch(/min-width:\s*0/)
  })

  it('keeps the claim pill from shrinking, and the benefit text as the part that gives way', async () => {
    const styles = await sourceOf('client/styles.ts')
    const pill = styles.match(/\.dsm-workbuddy-pool-benefit-btn\{([^}]*)\}/u)?.[1] ?? ''
    expect(pill, 'the claim pill rule was not found').not.toBe('')
    // `nowrap` alone is what made it a two-line blob last time.
    expect(pill, 'the claim pill must not wrap its label').toContain('white-space:nowrap')
    // `flex:none` is what keeps it from being squashed by the shrinking column.
    expect(pill, 'the claim pill must not flex').toContain('flex:none')
    // The pill needs its own compact height: inheriting .dsm-btn padding made it
    // taller than the text line it sits on.
    expect(pill, 'the claim pill must carry its own height').toMatch(/height:\s*\d+px/)
    // The label is centred optically, not just geometrically. A CJK glyph's ink
    // sits below the centre of its line box, so flex centring alone left 领取
    // 1px low (measured: above 3.5 / below 4.5). padding-top on the label is the
    // one nudge that moved the ink UP; transform and padding-bottom both moved
    // it DOWN, because they grow the flex item and re-centre the line box.
    expect(styles, 'the label needs its optical nudge back').toMatch(
      /\.dsm-workbuddy-pool-benefit-btn > span\{[^}]*padding-top:1px/u,
    )
  })

  it('shows the whole benefit label rather than truncating the amount away', async () => {
    const styles = await sourceOf('client/styles.ts')
    const tag = styles.match(/\.dsm-workbuddy-pool-benefit-tag\{([^}]*)\}/u)?.[1] ?? ''
    expect(tag, 'the benefit tag rule was not found').not.toBe('')
    // nowrap + ellipsis cut the label to 「模型服务异常补偿…」, dropping the
    // credit amount — the one fact the user is deciding on.
    expect(tag, 'the benefit label must not be cut off with an ellipsis')
      .not.toContain('text-overflow:ellipsis')
    expect(tag, 'the benefit label must be allowed to wrap').toMatch(/-webkit-line-clamp:\s*2/)
    // The entry wraps so the pill drops below the text instead of squeezing it.
    const entry = styles.match(/\.dsm-workbuddy-pool-benefit\{([^}]*)\}/u)?.[1] ?? ''
    expect(entry, 'the benefit entry rule was not found').not.toBe('')
    expect(entry, 'the entry must wrap the pill onto its own line when text needs room')
      .toContain('flex-wrap:wrap')
  })

  /**
   * A claim on ONE row must not repaint the OTHER rows as claiming.
   *
   * Reported as 「点击一个 全部联动，这是错的」: one click turned every row's pill
   * into 「领取中…」. The claim was never pool-wide — the route takes a mandatory
   * accountId and each button closes over its own row's campaign — but the ROW
   * PROP that fed the pill was `rowBusyAccountId !== undefined`, i.e. "some row
   * is busy", so the label flipped on all of them at once. A per-account write
   * whose feedback spreads to every account reads as a bulk action no matter what
   * the button says, so the label must be gated on THIS row.
   *
   * Asserted on the SOURCE, because the defect is a prop binding rather than a
   * rendered string: both bindings render identically when exactly one row is
   * busy, which is what a jsdom click test would produce.
   */
  it('gates the claim label on its own row, so one claim cannot relabel the table', async () => {
    const source = await sourceOf('client/AccountPool.tsx')
    // The prop handed to each row must be this row's identity, not a global flag.
    expect(source, 'the rows must be told which row is busy by identity')
      .toMatch(/claimBusy:\s*rowBusyAccountId === account\.accountId/u)
    // And the pill's label must consult it. A bare `rowBusyAction === 'claim'`
    // is the exact expression that lit up every row.
    // Start at the opening paren of the h('button', {...}) call, not at the class
    // name: the keyword sits above the class string, so slicing from the class
    // truncates `disabled:` out of view.
    const pill = source.slice(Math.max(0, source.indexOf('dsm-workbuddy-pool-benefit-btn') - 400))
    // The pill's child expression is the ternary that picks 领取 vs 领取中…
    const label = pill.match(/h\('span', null,\s*([\s\S]{0,200}?)\)\),/u)?.[1] ?? ''
    expect(label, 'the claim label expression was not found').not.toBe('')
    expect(label, 'the claim label must be gated on this row, or one click relabels every row')
      .toContain('claimBusy')
    // The button stays DISABLED on any write in flight: that part is a real race
    // guard and must not be loosened to this row alone.
    expect(pill, 'a second write must still be blocked while one is landing')
      .toMatch(/disabled:\s*rowBusy/u)
    // The label itself stays the short 「领取」 the user asked for.
    const locales = await sourceOf('client/locales.ts')
    expect(locales).toMatch(/'row\.poolBenefitClaim':\s*'领取'/u)
  })

  it('awaits the re-read after a claim, so a successful claim cannot look failed', async () => {
    const source = await sourceOf('client/AccountPool.tsx')
    // Locate the claim callback, then its refresh call. A fire-and-forget refresh
    // clears the busy flag while the card still shows the pre-claim snapshot and a
    // live claim pill, so a claim that HAD succeeded looks like it did nothing —
    // inviting a second click the route then refuses as already-claimed.
    const claimAt = source.indexOf('const runRowClaim = useCallback')
    expect(claimAt, 'runRowClaim was not found').toBeGreaterThan(-1)
    const body = source.slice(claimAt, source.indexOf('const runRowRemove = useCallback', claimAt))
    const refresh = body.match(/^[ \t]*(await\s+)?onRefresh\?\.\(\)/mu) ?? []
    expect(refresh.length, 'the claim callback no longer refreshes').toBeGreaterThan(0)
    expect(refresh[0], 'the claim refresh must be awaited, as removal\'s is')
      .toContain('await')
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

  it('sends the probe size the user chose, measured on the real outgoing body', async () => {
    // The setting's whole purpose: a test must ask a question the size of the
    // user's REAL conversations, because the upstream's 6004 limit fires on
    // request SIZE. A wiring that dropped the choice would still exercise every
    // other part of the batch — which a mutant proved: deleting the
    // `resolveProbeInputTokens(...)` call from `poolRunnerDeps` left all 886
    // tests green. So this asserts the WIRE, not the arithmetic, and it reads the
    // request the plugin actually put on the network rather than the setting it
    // was handed.
    const authFile = await writeAuthFixture(root)
    const accountId = await discoverAccountId(authFile)
    await mount({
      authFile,
      regions: {
        cn: {
          enabled: true,
          lastCatalog: [{
            id: 'free', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
          }],
          // 100K is the largest offered size, so an ignored setting shows up as a
          // body about a quarter the size rather than a rounding difference.
          pool: { enabled: true, memberAccountIds: [accountId], probeInputTokens: 100_000 },
        },
      },
    })
    const bodies: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      if (String(url).includes('chat/completions') && typeof init?.body === 'string') {
        bodies.push(init.body)
        return new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    }) as typeof fetch
    try {
      const { status } = await call(WORKBUDDY_POOL_PATH, {
        method: 'POST',
        url: `${WORKBUDDY_POOL_PATH}?region=cn&action=test`,
      })
      expect(status).toBe(200)
      expect(bodies.length, 'the test batch sent no probe request').toBeGreaterThan(0)
      // The filler sits in the user turn: at 100K tokens and the measured ~4.5
      // chars/token that is ~450,000 characters, so the 25K default would land
      // near a quarter of it. A floor rather than an exact count keeps the
      // estimate free to move while still failing loudly if the size is ignored.
      const parsed = JSON.parse(bodies[0] as string) as {
        messages: { role: string, content: string }[]
      }
      const userText = parsed.messages.find(message => message.role === 'user')?.content ?? ''
      expect(userText.length).toBeGreaterThan(400_000)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('defaults the probe size when the setting is absent, so an old profile is unchanged', async () => {
    // The companion case: absence must mean the measured 25k — not zero, not an
    // error. A profile written before this setting existed has no key at all, and
    // it has to keep testing exactly as it did.
    const authFile = await writeAuthFixture(root)
    const accountId = await discoverAccountId(authFile)
    await mount({
      authFile,
      regions: {
        cn: {
          enabled: true,
          lastCatalog: [{
            id: 'free', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
          }],
          pool: { enabled: true, memberAccountIds: [accountId] },
        },
      },
    })
    const bodies: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      if (String(url).includes('chat/completions') && typeof init?.body === 'string') {
        bodies.push(init.body)
        return new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    }) as typeof fetch
    try {
      await call(WORKBUDDY_POOL_PATH, {
        method: 'POST',
        url: `${WORKBUDDY_POOL_PATH}?region=cn&action=test`,
      })
      expect(bodies.length, 'the test batch sent no probe request').toBeGreaterThan(0)
      const parsed = JSON.parse(bodies[0] as string) as {
        messages: { role: string, content: string }[]
      }
      const userText = parsed.messages.find(message => message.role === 'user')?.content ?? ''
      // The measured default is 25k tokens (~112k chars). A zero-length body
      // would mean the absence was read as "send nothing".
      expect(userText.length).toBeGreaterThan(100_000)
      expect(userText.length).toBeLessThan(200_000)
    } finally {
      globalThis.fetch = realFetch
    }
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
    //
    // The reason here is `no-members`, NOT `pool-disabled`: the switch is off by
    // default, but that is no longer a refusal — a manual batch is allowed with
    // the pool off. What IS still refused is a batch over NOTHING, because an
    // empty pool must never degrade into "then do all of them".
    expect(body['reason']).toBe('no-members')
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

/**
 * Poll the route until `done` holds, or fail after a generous budget.
 *
 * The automatic check-in is a TIMER, so there is no call to await: the assertion
 * has to wait for the tick to reach the state under test. Polling the route is
 * the honest way to do that — it is what the card does — and it beats a fixed
 * `setTimeout` because a slow CI box then takes longer instead of failing.
 */
async function waitFor(done: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await done()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('the refresh interval is a real, validated setting', () => {
  const SAVE_PATH = '/plugins/dsh-connect-workbuddy/__save'

  /** POST a save, the way the card's dropdown does. */
  async function save(field: string, value: unknown): Promise<{ status: number, body: Record<string, unknown> }> {
    const route = routes.find(entry => entry.path === SAVE_PATH)
    if (route === undefined) throw new Error('the save route was not registered')
    const { res, status, body } = response()
    await route.handler({
      method: 'POST',
      url: SAVE_PATH,
      headers: { host: '127.0.0.1:62283' },
      // The handler reads the body as a stream; a one-shot `on`-emitting double
      // is enough for the two listeners it installs.
      on(event: string, handler: (chunk?: unknown) => void) {
        if (event === 'data') handler(Buffer.from(JSON.stringify({ field, value })))
        if (event === 'end') handler()
      },
    } as never, res as never)
    return { status: status(), body: body() }
  }

  it('accepts every offered interval and answers with what it stored', async () => {
    // The dropdown can only produce these five values, so every one of them must
    // be writable through the same route the card uses — otherwise the control
    // offers a choice the Host refuses.
    const authFile = await writeAuthFixture(root)
    await mount({ authFile, regions: { cn: { enabled: true } } })
    for (const interval of [60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000]) {
      const { status, body } = await save('pollIntervalMs', interval)
      expect(status, `interval ${String(interval)}`).toBe(200)
      expect((body['value'] as { pollIntervalMs?: number } | undefined)?.pollIntervalMs).toBe(interval)
    }
  })

  it('carries the configured interval on the status document the card polls', async () => {
    // The card arms its timer from THIS document, so a value that is stored but
    // never reported would leave the card polling at the old cadence. Mounted
    // with the value already in the config, because the settings double below
    // keeps its own state — this asserts the READ side, and the save route's
    // write side is the test above.
    const authFile = await writeAuthFixture(root)
    await mount({ authFile, regions: { cn: { enabled: true } }, pollIntervalMs: 30 * 60_000 })
    const { body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
    expect(body['pollIntervalMs']).toBe(30 * 60_000)
  })

  it('coerces an out-of-set configured value to the default, so the card cannot poll faster', async () => {
    // A hand-edited `cordis.patch.yml` can carry any number, and the card arms
    // `setInterval` from this answer: `0` would poll continuously. The Host must
    // therefore coerce on the way OUT, not merely validate on the way in.
    //
    // MUTATION NOTE: this coercion exists TWICE on purpose — `pollIntervalOf`
    // in `src/index.ts` reads the config, and `workBuddyWebStatus` re-checks
    // whatever the dependency answers. Deleting EITHER one alone leaves this
    // test green, which is the point of the duplication (a stale caller or an
    // older Host must not be able to arm a bad cadence); deleting BOTH turns it
    // red with "a 0 interval must never reach the card".
    const authFile = await writeAuthFixture(root)
    await mount({ authFile, regions: { cn: { enabled: true } }, pollIntervalMs: 0 })
    const { body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
    // NOT `toBe(undefined)` and not the raw 0: the coerced default must be what
    // the card arms.
    expect(body['pollIntervalMs'], 'a 0 interval must never reach the card').toBe(5 * 60_000)
  })

  it('reports the 5-minute default before anything was saved', async () => {
    // An upgrade must move the cadence to the new default rather than leave the
    // card on the old hard-coded minute.
    const authFile = await writeAuthFixture(root)
    await mount({ authFile, regions: { cn: { enabled: true } } })
    const { body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
    expect(body['pollIntervalMs']).toBe(5 * 60_000)
  })
})

describe('the automatic check-in: the poll finds an unchecked account and claims it (#191/#232)', () => {
  it('clears depleted state as soon as automatic check-in replenishes credits without a status poll or model test', async () => {
    const previousDshHome = process.env['DSH_HOME']
    process.env['DSH_HOME'] = await mkdtemp(join(tmpdir(), 'wb-checkin-recovery-'))
    const authFile = await writeAuthFixture(root)
    const accountId = await discoverAccountId(authFile)
    let claimed = false
    let modelRequests = 0
    const credits = vi.spyOn(WorkBuddyUpstreamClient.prototype, 'fetchCredits')
      .mockImplementation(async () => ({ total: claimed ? 100 : 0, expiringSoon: 0, packages: [] }))
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      const path = String(url)
      if (path.includes('chat/completions')) modelRequests += 1
      if (path.includes('checkin-activity-status')) return new Response(JSON.stringify({
        code: 0, data: { active: true, today_checked_in: claimed },
      }))
      if (path.includes('daily-checkin')) {
        claimed = true
        return new Response(JSON.stringify({ code: 0, data: { credit: 100 } }))
      }
      return new Response(JSON.stringify({ code: 0, data: {} }))
    }) as typeof fetch
    try {
      await writePoolProbes('cn', { [accountId]: {
        outcome: 'out-of-credit', atMs: Date.now() - 1000, retryAtMs: Date.now() + 21 * 86_400_000,
      } })
      await mount({ authFile, regions: { cn: {
        enabled: true, pool: { enabled: true, autoCheckin: true, memberAccountIds: [accountId] },
      } } })
      await waitFor(async () => claimed && (await readPoolProbes('cn'))[accountId] === undefined,
        'automatic check-in to reconcile the depleted state')
      expect(credits).toHaveBeenCalled()
      expect(modelRequests).toBe(0)
    } finally {
      await context?.fiber.dispose()
      context = undefined
      if (previousDshHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previousDshHome
      globalThis.fetch = realFetch
      credits.mockRestore()
    }
  })

  /**
   * The requirement, stated as a test: with the switch on, a run that DISCOVERS
   * an account not checked in today claims it — no button, and no dependence on
   * firing at midnight. The 30-minute idle heartbeat is fine; what must never
   * happen is discovering the gap and doing nothing.
   */
  it('claims an account the status read reports as not checked in', async () => {
    const authFile = await writeAuthFixture(root)
    const accountId = await discoverAccountId(authFile)
    let claims = 0
    let statusReads = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      const text = String(url)
      if (text.includes('checkin-activity-status')) {
        statusReads += 1
        // Not checked in today: exactly the state the poll is supposed to act on.
        return new Response(JSON.stringify({
          code: 0,
          data: { today_checked_in: false, active: true, streak_days: 0 },
        }), { status: 200 })
      }
      if (text.includes('daily-checkin')) {
        claims += 1
        return new Response(JSON.stringify({
          code: 0,
          data: { credit: 10, streak_days: 1, is_streak_day: false },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    }) as typeof fetch
    try {
      await mount({
        authFile,
        regions: {
          cn: {
            enabled: true,
            lastCatalog: [{
              id: 'free', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
            }],
            pool: { enabled: true, autoCheckin: true, memberAccountIds: [accountId] },
          },
        },
      })
      await waitFor(async () => claims > 0, 'the automatic check-in to claim')
      // The status read came FIRST — the claim is not blind. That ordering is the
      // idempotency guarantee: a blind claim would be a second write path.
      expect(statusReads).toBeGreaterThan(0)
      // And the card is told the day is done, so the work is observable.
      const { body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
      const pool = body['pool'] as { autoCheckinToday?: { done: number, total: number, pending: number } } | undefined
      expect(pool?.autoCheckinToday).toMatchObject({ done: 1, total: 1, pending: 0 })
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('does NOT claim when the status read says the account is already checked in', async () => {
    // The other half of the same rule, and the one that must survive any change
    // to the poll: "found unchecked" is what authorises the write. An account
    // already done today must be reported, never re-claimed.
    const authFile = await writeAuthFixture(root)
    const accountId = await discoverAccountId(authFile)
    let claims = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      const text = String(url)
      if (text.includes('checkin-activity-status')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { today_checked_in: true, active: true },
        }), { status: 200 })
      }
      if (text.includes('daily-checkin')) {
        claims += 1
        return new Response(JSON.stringify({ code: 0, data: { credit: 0 } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    }) as typeof fetch
    try {
      await mount({
        authFile,
        regions: {
          cn: {
            enabled: true,
            lastCatalog: [{
              id: 'free', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
            }],
            pool: { enabled: true, autoCheckin: true, memberAccountIds: [accountId] },
          },
        },
      })
      // Wait for the tick to have RECORDED the day as done — that is when a
      // wrongful claim would have happened.
      await waitFor(async () => {
        const { body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
        const pool = body['pool'] as { autoCheckinToday?: { pending: number } } | undefined
        return pool?.autoCheckinToday?.pending === 0
      }, 'the tick to settle')
      expect(claims).toBe(0)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('the automatic check-in status line does not survive midnight (#232)', () => {
  it('stops reporting yesterday\'s completion as today\'s', async () => {
    // THE REPORT: at 00:08 the card read 「今日：4 个全部已签」 while every row
    // underneath read 未签到. The state had not been rewritten yet — the next
    // idle tick was up to 30 minutes away — so the header asserted a completed
    // day that had not started. The fix is in the READ path, not the timer: the
    // user explicitly did not ask for midnight-precise scheduling.
    const authFile = await writeAuthFixture(root)
    const accountId = await discoverAccountId(authFile)
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      const text = String(url)
      if (text.includes('checkin-activity-status')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { today_checked_in: false, active: true },
        }), { status: 200 })
      }
      if (text.includes('daily-checkin')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { credit: 10, streak_days: 1 },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    }) as typeof fetch
    try {
      await mount({
        authFile,
        regions: {
          cn: {
            enabled: true,
            lastCatalog: [{
              id: 'free', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0,
            }],
            pool: { enabled: true, autoCheckin: true, memberAccountIds: [accountId] },
          },
        },
      })
      await waitFor(async () => {
        const { body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
        const pool = body['pool'] as { autoCheckinToday?: { done: number } } | undefined
        return pool?.autoCheckinToday?.done === 1
      }, 'today to be reported as done')
      // Non-vacuous: the line IS there on the day it describes.
      const today = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
      expect((today.body['pool'] as { autoCheckinToday?: unknown }).autoCheckinToday).toBeDefined()

      // Now stand at 00:08 the next morning, with the idle timer still pending —
      // i.e. exactly the reported situation. Only the clock moves.
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      tomorrow.setHours(0, 8, 0, 0)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(tomorrow)
      try {
        const { body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
        const pool = body['pool'] as { autoCheckin?: boolean, autoCheckinToday?: unknown } | undefined
        // The switch is still ON — only the claim about today must go away.
        expect(pool?.autoCheckin).toBe(true)
        expect(pool?.autoCheckinToday, 'yesterday\'s completion must not be reported as today\'s').toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

/**
 * Strip comments and string literals from a source excerpt.
 *
 * The guards below ask "does this code CALL X", and a source-text search alone
 * is satisfied by a MENTION: a comment, an error message, or the argument of a
 * `typeof` can all contain the name without the call existing. Removing
 * literals and comments first makes the search a search for code.
 *
 * ORDER AND LINE-BOUNDEDNESS MATTER, and this used to get both wrong:
 * `` `http://127.0.0.1:${port}` `` contains `//`, so stripping comments FIRST
 * truncated the template to `` `http: `` — an ODD number of backticks — and the
 * backtick pass then paired that stray tick with one hundreds of lines later,
 * **deleting everything in between**. A guard that searched that span reported a
 * missing call that was plainly present. Listing literals first (keywords like
 * `return` are not literals) and forbidding a literal from spanning a newline
 * removes the whole failure mode: nothing can be swallowed, because nothing can
 * pair with a distant partner.
 */
function stripLiterals(text: string): string {
  return text
    .replace(/'(?:[^'\\\n]|\\.)*'/gu, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/gu, '""')
    .replace(/`(?:[^`\\\n]|\\.)*`/gu, '``')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/[^\n]*/gu, '')
}

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
    // The batch success path calls it once — and so does each PER-ROW action
    // (row test / row remove / row claim): the same rule, one success-path call
    // per action handler. A fifth call anywhere would need the same scrutiny.
    //
    // The claim handler (issue #79) belongs on this list for the same reason as
    // the others: without its re-read the 待领取 line would stay on screen after
    // a successful claim, and moving the call into `finally` would re-read on a
    // FAILED claim and mask the error.
    expect(calls.length, 'onRefresh is called once per action handler').toBe(4)
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

  it('commits the draft after the verified write and reports a stale refresh without blocking save (issue #131)', async () => {
    // The settings write is what saves the user's edits; the upstream usage
    // re-read is a DISPLAY concern and can wait on a billing timeout. The old
    // contract kept `saving` and the draft alive across that re-read, which made
    // a completed save look stuck (issue #131). This guard pins the new one:
    // write -> discard -> await the refresh result -> warn if it was stale.
    const source = await sourceOf('client/AccountPool.tsx')
    const at = source.indexOf('const save = useCallback')
    expect(at, 'save moved — update this guard').toBeGreaterThan(-1)
    const end = source.indexOf('\n  }, [', at)
    const code = source.slice(at, end).replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
    const writeAt = code.indexOf('await writePoolPreferences')
    const discardAt = code.indexOf('discard()')
    const refreshAt = code.indexOf('await onSaved?.()')
    expect(writeAt, 'the verified write is not awaited').toBeGreaterThan(-1)
    expect(discardAt, 'the draft is not committed after the write').toBeGreaterThan(writeAt)
    expect(refreshAt, 'onSaved is not awaited — the stale-refresh notice would never render').toBeGreaterThan(discardAt)
    expect(code, 'a stale refresh is not reported').toContain('if (refreshed === false')
    expect(code, 'the save button stays busy during the usage re-read')
      .toContain('if (mounted.current) setSaving(false)')
    expect(code, 'the committed draft is not gated on the re-read anymore')
      .not.toContain('if (committed) discard()')
    // The parent still hands the promise and its boolean back, so the warning
    // can distinguish a stale refresh from a failed write.
    const card = await sourceOf('client/WorkBuddyCard.tsx')
    expect(card, 'onSaved swallows its promise, so the stale-refresh notice is unreachable')
      .toContain('onSaved={async () => (await refreshUsage(activeRegion)) !== undefined}')
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

  it('wires the failover policy into the shim, gated on the pool switch', async () => {
    // The seam this pins is a CALLBACK INJECTION: the shim owns the retry loop
    // (covered by `tests/shim-failover.spec.ts`) and the Host owns the policy.
    // Drop the option and the shim silently never retries — the feature would be
    // gone with every other test still green, because each half is correct on
    // its own.
    const host = stripLiterals(await sourceOf('index.ts'))

    // Bound to THIS region: each region owns its own store, pool and shim, and a
    // retry that consulted the other region's members would bill an account from
    // a different account pool than the one that failed.
    expect(host, 'the shim is not given a failover policy').toContain('failoverAccount:')
    expect(host, 'the policy is not bound to its region').toContain('failoverAccountFor(region,')

    const policyAt = host.indexOf('const failoverAccountFor =')
    expect(policyAt, 'failoverAccountFor moved — update this guard').toBeGreaterThan(-1)
    // The policy runs to the next top-level `const` of `apply()`.
    const rest = host.slice(policyAt + 1)
    const policy = rest.slice(0, rest.indexOf('\n  const '))

    // Off means OFF: the pool switch is the whole feature's gate, and restoring
    // "follow the account you selected, report failures as-is" is what it promises.
    expect(policy, 'the pool switch does not gate failover')
      .toContain('poolPreferencesOf(current(), region).enabled')
    // Members a measurement already rules out are skipped, so a retry does not
    // spend a round trip re-learning what the pool knows.
    expect(policy, 'excluded members are not skipped').toContain('excludedBy')
    // The account that just failed must not be offered again.
    expect(policy, 'the tried set is not consulted').toContain('tried')
    // Candidates are read WITHOUT touching the selection: `resolve()` would move
    // the user's choice, the one thing failover must never do.
    expect(policy, 'candidates are read through the wrong accessor').toContain('credentialFor(')
    expect(policy, 'the policy resolves the selection instead of borrowing a candidate')
      .not.toContain('resolve()')
  })

  it('lets the pool ranking decide who serves the first attempt', async () => {
    // The switch's whole point: with the pool on, "who serves" is the pool's
    // decision, not the saved selection's. Two halves make that true — the shim
    // must ASK before resolving, and the Host must point the store at the
    // ranking's winner. Either half alone leaves the feature invisible.
    const host = stripLiterals(await sourceOf('index.ts'))
    const shim = stripLiterals(await sourceOf('shim.ts'))

    expect(shim, 'the shim never asks who should serve').toContain('prepareAccount?.(controller.signal)')
    // Asked BEFORE the credential is resolved: that ordering is what keeps token
    // refresh in one place instead of on the routing path.
    expect(
      shim.indexOf('await prepareAccount?.(controller.signal)'),
      'the pool is asked after the credential was already resolved',
    ).toBeLessThan(shim.indexOf('await store.resolve()'))

    expect(host, 'the shim is not given a routing hook').toContain('prepareAccount:')

    const at = host.indexOf('const applyPoolSelection =')
    expect(at, 'applyPoolSelection moved — update this guard').toBeGreaterThan(-1)
    const selection = host.slice(at, host.indexOf('\n  }', at))
    // Off restores the user's own account immediately: leaving a stale override
    // in place keeps billing under a switch that reads as off.
    expect(selection, 'turning the pool off does not clear the override')
      .toContain('setRotatedAccount(undefined)')
    // ...and ON must actually APPLY the winner. Naming `setRotatedAccount(` alone
    // is satisfied by the clearing branch above, so the assertion has to be about
    // the winning id reaching the store — a mutant that computed the ranking and
    // threw it away passed the weaker form.
    expect(selection, 'the ranked winner is computed but never applied')
      .toMatch(/setRotatedAccount\((?!undefined)[^)]*\)/)
    expect(selection, 'the winner is not the ranked account')
      .toContain('winner?.account.id')
    // The request path must not fetch credits per member: that is a network call
    // on the hot path, and one page of chat would become N extra requests.
    expect(selection, 'the request path fetches credits').not.toContain('client.fetchCredits')
    expect(selection, 'routing does not use the local-only member builder')
      .toContain('localPoolMembers')
    // The FAILOVER path is on the request path too — worse, it runs while the
    // user is already waiting on a request that just failed. It used the
    // credits-fetching `poolMembersOf`, so one failed chat turned into N extra
    // upstream calls before the retry left, contradicting its own doc comment
    // ("must not spend further requests"). `applyPoolSelection` alone did not
    // catch this, because the two paths are separate slices of the file.
    const failoverAt = host.indexOf('const failoverAccountFor =')
    expect(failoverAt, 'failoverAccountFor moved — update this guard').toBeGreaterThan(-1)
    const failover = host.slice(failoverAt, host.indexOf('\n  }', failoverAt))
    expect(failover, 'the failover path fetches credits per member')
      .not.toContain('poolMembersOf')
    expect(failover, 'failover does not use the local-only member builder')
      .toContain('localPoolMembers')
    // And the card must report the same decision the router makes, or the panel
    // and the traffic disagree.
    expect(host, 'the card does not share the routing decision')
      .toContain('await applyPoolSelection(region).catch(() => undefined)')
  })

  it('wires the shortfall explanation into the shim', async () => {
    // The seam is the same shape as the failover policy above, and it fails the
    // same silent way: without this option the shim still reports the upstream
    // failure correctly, so every test that only checks the failure stays green
    // while the user is left without the answer to "why was there nowhere else
    // to go?".
    const host = stripLiterals(await sourceOf('index.ts'))

    expect(host, 'the shim is not given a shortfall explainer').toContain('failoverShortfall:')
    expect(host, 'the explainer is not bound to its region').toContain('explainPoolShortfall(region)')

    const at = host.indexOf('const explainPoolShortfall =')
    expect(at, 'explainPoolShortfall moved — update this guard').toBeGreaterThan(-1)
    // Slice to the function's own closing brace rather than to the next comment:
    // a `/**` slice runs past the helper below it and into unrelated code, which
    // is how the first version of this guard picked up `retryAtMs` from a
    // neighbouring function and failed for the wrong reason.
    const explainer = host.slice(at, host.indexOf('\n  }', at))

    // Off means OFF, exactly as for failover: with no pool there is no pool story
    // to tell, and inventing one would describe a feature the user turned off.
    expect(explainer, 'the pool switch does not gate the explanation')
      .toContain('poolPreferencesOf(current(), region).enabled')
    // The explanation must share the ROUTER's verdict, not re-derive one. A
    // second definition of "excluded" would let the reply blame a reason the
    // ranking never used — the card and the traffic disagreeing, but in prose.
    expect(explainer, 'the explanation re-derives the verdict instead of asking the pool')
      .toContain('exclusionOf(')
    expect(explainer, 'the explanation duplicates the cooldown rule')
      .not.toContain('retryAtMs')
    // No network on the failure path: the user is waiting on a request that just
    // failed, and an upstream call to explain it would add a second delay.
    expect(explainer, 'the explanation fetches credits').not.toContain('fetchCredits')
    expect(explainer, 'the explanation uses the expensive member builder')
      .not.toContain('poolMembersOf')
  })

})

describe('a live failure becomes a measurement the next request reads', () => {
  //  is scoped to another describe, so this block needs its own copy.
  const sourceOf = async (name: string): Promise<string> =>
    await import('node:fs/promises').then(fs => fs.readFile(new URL(`../src/${name}`, import.meta.url), 'utf8'))

  it('wires live failures into the pool store, filtered by kind and membership', async () => {
    // The property the user cares about: after a 429, the NEXT request should
    // start from an account that works — not re-discover the same failure. That
    // only holds if the chat path WRITES what it learned, because the ranking
    // reads stored measurements. Before this, only the manual batch test wrote
    // them, so a just-refused account still read as "untested" and kept being
    // picked first.
    const host = stripLiterals(await sourceOf('index.ts'))
    expect(host, 'the shim is not given a failure report callback').toContain('onAccountFailure:')
    expect(host, 'live failures are not recorded').toContain('recordAccountFailure(region, accountId, failure)')

    const at = host.indexOf('const recordAccountFailure =')
    expect(at, 'recordAccountFailure moved — update this guard').toBeGreaterThan(-1)
    const rest = host.slice(at + 1)
    const recorder = rest.slice(0, rest.indexOf('\n  const '))

    // A 400 says the REQUEST was rejected, which is not evidence about the
    // account; recording it would sideline a good account over a bad body.
    //
    // Asserted on the CODE SHAPE, not the literal: `'client'` is a string, and
    // `stripLiterals` deliberately blanks strings — so the surviving text is
    // `failure.kind === ''` (empty-quoted). Searching for the quoted form the
    // source actually contains can never match here, which produced a false
    // failure the first time this guard ran.
    expect(recorder, 'a client-class failure is recorded, which would sideline a good account')
      .toContain(`failure.kind === ''`)
    // Membership is the explicit "spend this account's credits" tick, and a
    // measurement steers routing — so an unchecked account must not be measured.
    //
    // Asserted as the COMPARISON, not as a mention of `memberAccountIds`: the
    // declaration `const members = …memberAccountIds` satisfies a mention-search
    // even after the check itself is deleted, which is precisely how a mutant
    // that removed this guard survived the first version of this test.
    expect(recorder, 'an unchecked account can be measured')
      .toContain('members.includes(accountId)')
    // The measurement has to carry the reset time the upstream stated, or the
    // account returns to rotation immediately instead of waiting out the limit.
    expect(recorder, 'the upstream reset time is not parsed').toContain('cooldownOf(')
    expect(recorder, 'the outcome is not derived from the failure').toContain('outcomeOfFailure(')
    // And the pool switch still gates it: with the pool off nothing routes, so
    // writing measurements would be bookkeeping nobody reads.
    expect(recorder, 'recording ignores the pool switch')
      .toContain('poolPreferencesOf(current(), region).enabled')
    // The quota refresh point MUST reach `cooldownOf` here, exactly as it does on
    // the probe path. Leaving it out gave one `out-of-credit` failure two
    // different answers depending on which door it arrived through: the probe
    // said "the quota refreshes on the 1st" (a time the billing side states
    // outright) while a live chat failure said "30 minutes from now" — a window
    // the account cannot clear, so the pool put it back to be refused again.
    //
    // Asserted as the ARGUMENT NAME reaching the call, because that is the part
    // that was missing; `quotaRefreshOf` alone would also be satisfied by its
    // own declaration further up the file.
    expect(recorder, 'the live path does not look up the quota refresh point')
      .toContain('quotaRefreshOf(')
    expect(recorder, 'the quota refresh point is not passed into cooldownOf')
      .toContain('quotaRefreshAtMs')
    // …and only for the outcome that can have one. `quotaRefreshOf` costs an
    // upstream call, and a rate limit or a transport blip has no refresh point
    // to find — paying for that read would spend a request to learn nothing.
    // (`stripLiterals` blanks the string, hence the empty-quoted form.)
    expect(recorder, 'the refresh point is looked up for outcomes that cannot have one')
      .toContain(`outcome === ''`)
  })
})


describe('a recorded 429 moves the serving account to an available one', () => {
  /** Write the pool's measured facts for a region, exactly as the Host would. */
  async function writeProbes(region: string, probes: Record<string, unknown>): Promise<void> {
    const home = process.env.DSH_HOME
    if (home === undefined) throw new Error('DSH_HOME is not isolated')
    await import('node:fs/promises').then(fs =>
      fs.writeFile(join(home, `.workbuddy-pool.${region}.json`), JSON.stringify({ version: 1, probes }), 'utf8'))
  }

  interface PoolRow { accountId: string, current: boolean, excludedBy?: string }
  async function poolRows(region: string): Promise<PoolRow[]> {
    const { body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=${region}` })
    const pool = (body['pool'] ?? {}) as { accounts?: PoolRow[] }
    return pool.accounts ?? []
  }

  it('serves from the other account once the current one is measured as limited', async () => {
    // The property being confirmed: 429 on the account in use → the pool serves
    // from an available account AND that account becomes the current one.
    //
    // It holds only because a live failure is RECORDED as a measurement — the
    // ranking reads stored measurements, so without that write the limited
    // account keeps reading as "untested" and keeps being picked first. This test
    // writes what the Host writes and then reads the very document the card
    // renders from, so the routing and the display are checked as one answer.
    await writeAuthFixture(root)
    await writeSecondAuthFixture(root)
    // Point at the LIVE file; the second fixture sits beside it and is found the
    // same way the plugin finds the app's own timestamped backups.
    const livePath = join(root, 'auth', 'workbuddy-desktop.info')
    const ids = await discoverAccountIds(livePath)
    expect(ids.length, 'the two fixtures did not produce two accounts').toBe(2)
    const [first, second] = ids as [string, string]

    await mount({
      authFile: livePath,
      regions: {
        cn: {
          enabled: true,
          pool: { enabled: true, memberAccountIds: [first, second] },
          lastCatalog: [{ id: 'free-1', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0 }],
        },
      },
    })

    // Baseline: exactly one of the two is serving, and neither is excluded.
    const before = await poolRows('cn')
    const serving = before.find(row => row.current)
    expect(serving, 'no account is serving').toBeDefined()
    expect(before.every(row => row.excludedBy === undefined)).toBe(true)

    // The account that was serving answers 429 with the upstream's own reset time.
    const limitedId = serving?.accountId as string
    await writeProbes('cn', {
      [limitedId]: { outcome: 'rate-limited', atMs: Date.now(), retryAtMs: Date.now() + 3_600_000 },
    })

    const after = await poolRows('cn')
    const limited = after.find(row => row.accountId === limitedId)
    // It stays LISTED (the user must see it), but out of rotation...
    expect(limited, 'the limited account vanished from the table').toBeDefined()
    expect(limited?.excludedBy, 'the limited account is still a candidate').toBe('rate-limited')
    // ...and no longer the account in use: the pool moved to the other one, which
    // is the "switch to the available account as the current one" the user asked
    // for.
    expect(limited?.current, 'the limited account is still the one in use').toBe(false)
    const nowServing = after.find(row => row.current)
    expect(nowServing, 'nothing is serving after a member was limited').toBeDefined()
    expect(nowServing?.accountId, 'the pool did not move to the available account').not.toBe(limitedId)
  })
})

describe('when every member is limited', () => {
  async function writeProbes(region: string, probes: Record<string, unknown>): Promise<void> {
    const home = process.env.DSH_HOME
    if (home === undefined) throw new Error('DSH_HOME is not isolated')
    await import('node:fs/promises').then(fs =>
      fs.writeFile(join(home, `.workbuddy-pool.${region}.json`), JSON.stringify({ version: 1, probes }), 'utf8'))
  }

  it('reports every member as excluded rather than inventing a healthy one', async () => {
    // There is no "available account" to switch to, so the honest answer is that
    // none is available — the card states it and the request's failure is
    // reported as-is. What must NOT happen is the pool quietly picking a limited
    // account and presenting it as fine: that would hide the very state the user
    // needs to see (and the next request would just hit the same 429).
    await writeAuthFixture(root)
    await writeSecondAuthFixture(root)
    const livePath = join(root, 'auth', 'workbuddy-desktop.info')
    const ids = await discoverAccountIds(livePath)
    expect(ids.length).toBe(2)

    await mount({
      authFile: livePath,
      regions: {
        cn: {
          enabled: true,
          pool: { enabled: true, memberAccountIds: ids },
          lastCatalog: [{ id: 'free-1', name: 'Free', contextWindow: 1000, maxTokens: 100, creditMultiplier: 0 }],
        },
      },
    })

    const reset = Date.now() + 3_600_000
    await writeProbes('cn', Object.fromEntries(
      ids.map(id => [id, { outcome: 'rate-limited', atMs: Date.now(), retryAtMs: reset }]),
    ))

    const { body } = await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
    const pool = (body['pool'] ?? {}) as { accounts?: { accountId: string, current: boolean, excludedBy?: string }[] }
    const rows = pool.accounts ?? []
    expect(rows).toHaveLength(2)
    // Both listed, both excluded, neither claimed as the one in use.
    expect(rows.every(row => row.excludedBy === 'rate-limited')).toBe(true)
    expect(rows.some(row => row.current)).toBe(false)
  })
})

describe('request recovery regression boundaries', () => {
  let previousFetch: typeof fetch
  let previousHome: string | undefined
  beforeEach(async () => {
    previousHome = process.env['DSH_HOME']
    process.env['DSH_HOME'] = await mkdtemp(join(tmpdir(), 'wb-review-audit-'))
    previousFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })) as typeof fetch
  })
  afterEach(async () => {
    await context?.fiber.dispose()
    context = undefined
    if (previousHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previousHome
    globalThis.fetch = previousFetch
  })

  it('healthy account requests do not wait for another exhausted account balance read', async () => {
    const authFile = await writeAuthFixture(root)
    await writeSecondAuthFixture(root)
    const ids = await discoverAccountIds(authFile)
    const shim = vi.spyOn(Shim, 'createWorkBuddyShim')
    let release: (() => void) | undefined
    let completed = false
    let task: Promise<unknown> | undefined
    const credits = vi.spyOn(WorkBuddyUpstreamClient.prototype, 'fetchCredits').mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return { total: 0, expiringSoon: 0, packages: [] }
    })
    try {
      await mount({ authFile, regions: { cn: { enabled: true, pool: { enabled: true, memberAccountIds: ids } } } })
      await writePoolProbes('cn', { [ids[0] as string]: { outcome: 'out-of-credit', atMs: Date.now() - 1000 } })
      const options = shim.mock.calls[0]![0]
      task = options.prepareAccount!().then(() => { completed = true })
      await waitFor(async () => release !== undefined || completed, 'audit balance query starts')
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(completed, 'a healthy pool member exists, but preparation waits for the depleted member').toBe(true)
    } finally {
      release?.()
      await task
      credits.mockRestore()
      shim.mockRestore()
    }
  })

  it('recovered balance participates in routing instead of the cached zero', async () => {
    const authFile = await writeAuthFixture(root)
    await writeSecondAuthFixture(root)
    const ids = await discoverAccountIds(authFile)
    const shim = vi.spyOn(Shim, 'createWorkBuddyShim')
    let recovered = false
    const credits = vi.spyOn(WorkBuddyUpstreamClient.prototype, 'fetchCredits').mockImplementation(async credential => ({
      total: WorkBuddy.workbuddyAccountId(credential) === ids[0] ? (recovered ? 100 : 0) : 50,
      expiringSoon: 0, packages: [],
    }))
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })) as typeof fetch
    try {
      await mount({ authFile, regions: { cn: { enabled: true, pool: { enabled: true, memberAccountIds: ids } } } })
      await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
      await writePoolProbes('cn', { [ids[0] as string]: { outcome: 'out-of-credit', atMs: Date.now() - 1000 } })
      recovered = true
      const options = shim.mock.calls[0]![0]
      await options.prepareAccount!()
      await waitFor(async () => (await readPoolProbes('cn'))[ids[0] as string] === undefined, 'background credit recovery')
      await options.prepareAccount!()
      expect((await readPoolProbes('cn'))[ids[0] as string], 'recovery did clear the exclusion').toBeUndefined()
      const credential = await options.store.current()
      expect(credential).toBeDefined()
      expect(WorkBuddy.workbuddyAccountId(credential!), 'routing should rank restored 100 above the other account with 50').toBe(ids[0])
    } finally {
      globalThis.fetch = realFetch
      credits.mockRestore()
      shim.mockRestore()
    }
  })


  it('releases a cancelled recovery waiter while another request still shares its read', async () => {
    const authFile = await writeAuthFixture(root)
    const accountId = await discoverAccountId(authFile)
    const shim = vi.spyOn(Shim, 'createWorkBuddyShim')
    let release: (() => void) | undefined
    let cancelledDone = false
    let otherDone = false
    let first: Promise<void> | undefined
    let second: Promise<void> | undefined
    const controller = new AbortController()
    const credits = vi.spyOn(WorkBuddyUpstreamClient.prototype, 'fetchCredits').mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return { total: 100, expiringSoon: 0, packages: [] }
    })
    try {
      await mount({ authFile, regions: { cn: { enabled: true, pool: { enabled: true, memberAccountIds: [accountId] } } } })
      await writePoolProbes('cn', { [accountId]: { outcome: 'out-of-credit', atMs: Date.now() - 1000 } })
      const prepare = shim.mock.calls[0]![0].prepareAccount!
      first = prepare(controller.signal).then(() => { cancelledDone = true })
      await waitFor(async () => release !== undefined, 'shared recovery start')
      second = prepare().then(() => { otherDone = true })
      controller.abort()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(cancelledDone, 'disconnect must stop waiting for another account query').toBe(true)
      expect(otherDone, 'the other caller still waits for its shared evidence').toBe(false)
      expect(credits).toHaveBeenCalledTimes(1)
      release?.()
      await Promise.all([first, second])
      expect((await readPoolProbes('cn'))[accountId]).toBeUndefined()
    } finally {
      release?.()
      await Promise.all([first, second])
      credits.mockRestore()
      shim.mockRestore()
    }
  })

  it('keeps a newer whole-pool balance when an older recovery query finishes later', async () => {
    const authFile = await writeAuthFixture(root)
    await writeSecondAuthFixture(root)
    const ids = await discoverAccountIds(authFile)
    const shim = vi.spyOn(Shim, 'createWorkBuddyShim')
    let phase = 'initial'
    let release: (() => void) | undefined
    let pending: Promise<void> | undefined
    const credits = vi.spyOn(WorkBuddyUpstreamClient.prototype, 'fetchCredits').mockImplementation(async credential => {
      if (WorkBuddy.workbuddyAccountId(credential) !== ids[0]) return { total: 50, expiringSoon: 0, packages: [] }
      if (phase === 'recovery') {
        await new Promise<void>(resolve => { release = resolve })
        return { total: 100, expiringSoon: 0, packages: [] }
      }
      return { total: phase === 'newer-ui' ? 20 : 0, expiringSoon: 0, packages: [] }
    })
    try {
      await mount({ authFile, regions: { cn: { enabled: true, pool: { enabled: true, memberAccountIds: ids } } } })
      await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
      await writePoolProbes('cn', {
        [ids[0] as string]: { outcome: 'out-of-credit', atMs: Date.now() - 1000 },
        [ids[1] as string]: { outcome: 'rate-limited', atMs: Date.now(), retryAtMs: Date.now() + 60_000 },
      })
      const options = shim.mock.calls[0]![0]
      phase = 'recovery'
      pending = options.prepareAccount!()
      await waitFor(async () => release !== undefined, 'older recovery read')
      // Ensure the newer reading is temporally distinct, including coarse clocks.
      await new Promise(resolve => setTimeout(resolve, 10))
      phase = 'newer-ui'
      await call(WORKBUDDY_USAGE_PATH, { url: `${WORKBUDDY_USAGE_PATH}?region=cn` })
      release?.()
      await pending
      await writePoolProbes('cn', { [ids[1] as string]: { outcome: 'ok', atMs: Date.now() + 1 } })
      await options.prepareAccount!()
      const credential = await options.store.current()
      expect(WorkBuddy.workbuddyAccountId(credential!), 'newer A=20 must not be overwritten by old A=100; B=50 wins').toBe(ids[1])
    } finally {
      release?.()
      await pending
      credits.mockRestore()
      shim.mockRestore()
    }
  })

})
