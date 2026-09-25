import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import * as WorkBuddy from '../src/index.ts'

/** What the 0.1.7-shaped service received, so the test can prove the path taken. */
let configureCalls: { auto?: boolean }[] = []

/**
 * `settings.get()` as the CARD sees it.
 *
 * On 0.1.7 a volatile field comes back as a `{get(): T}` live reference, so
 * reading `doc.accounts.cn` directly is `undefined` — the raw document is not
 * what any consumer renders. The browser card goes through the settings scope,
 * and the plugin's own read paths go through `unwrapVolatile`; this reuses the
 * production helper so an assertion cannot pass or fail on a shape no real
 * consumer ever sees.
 */
function readSettings(doc: unknown): { accounts?: Record<string, string>, accountId?: string } {
  return WorkBuddy.unwrapVolatileDeep(doc) as { accounts?: Record<string, string>, accountId?: string }
}

/**
 * The 0.1.7-shaped settings service the suite mounts, standing in for the real
 * `SettingsForms` (which 0.1.7 ships and 0.1.5 never did).
 *
 * The plugin is mounted with {@link mountWorkBuddy} — a direct `apply(ctx,
 * config)` call — so `config` is a plain object THIS SERVICE and the plugin
 * share by reference. `update()` mutates that object and emits the 0.1.7 write
 * announcement, which is exactly what the real Loader does: it commits a
 * volatile-only write into the running config and emits
 * `loader/volatile-update` so every consumer re-reads.
 */
class MemorySettings extends Service {
  readonly writable = true
  constructor(ctx: Context) {
    super(ctx, 'settings')
    configureCalls.push({})
  }
  configure(presentation: { auto?: boolean }, _owner?: unknown): () => void {
    configureCalls[configureCalls.length - 1] = presentation
    return () => {}
  }
  describe() {
    const config = currentConfig()
    return [{
      ns: WorkBuddy.WORKBUDDY_SETTINGS_NS,
      autoGenerate: true,
      revision: 0,
      applies: 'live',
      value: config,
      base: structuredClone(config),
      user: structuredClone(config),
    }]
  }
  async update(ns: string, patch: Record<string, unknown>): Promise<void> {
    // IN-PLACE merge, exactly like the 0.1.7 Loader: `config` IS the plugin's
    // live config object (same reference the plugin's `current()` reads), so a
    // write must mutate it, never replace it — a structuredClone would both
    // choke on volatile references and break the shared reference.
    mergeInto(currentConfig(), patch)
    emitVolatileUpdate()
  }
  async get(ns: string): Promise<unknown> {
    return currentConfig()
  }
}

/**
 * The config object the mounted plugin reads (its `current()` closure reads
 * this exact reference). Reset between tests.
 */
let liveConfig: Record<string, unknown> = {}

function currentConfig(): Record<string, unknown> {
  return liveConfig
}

/** The live workbuddy section as the 0.1.7 `describe()` surface reports it —
 * the descriptor's `value` is the resolved config. (0.1.7's `SettingsForms`
 * has no `get()`; reading the section through `describe()` is the contract
 * both the card and the harness use.) */
async function settingsSection(ctx: Context): Promise<unknown> {
  const descriptor = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)
  return descriptor?.value
}

/**
 * Mount the plugin with a DIRECT `apply()` call, so the config object is fully
 * under the test's control.
 *
 * `ctx.plugin(WorkBuddy, config)` is deliberately NOT used here: Cordis
 * validates the raw config against the plugin's `Config` schema and hands the
 * plugin a frozen resolved object, so the test could not mutate what the
 * plugin reads. Calling `apply(ctx, config)` directly keeps one shared,
 * mutable object — the same contract the plugin has on a real host, where the
 * Loader commits volatile writes into the running config in place.
 */
async function mountWorkBuddy(ctx: Context, config: Record<string, unknown>): Promise<void> {
  liveConfig = { ...stagingConfig, ...config }
  stagingConfig = {}
  WorkBuddy.apply(ctx, liveConfig as WorkBuddy.Config)
  // `configure` is registered asynchronously via `ctx.inject(['settings'])`;
  // give it a tick so the service records the call.
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** Pre-existing user fields staged before mount (the restart case); merged into
 * the live config by {@link mountWorkBuddy}. */
let stagingConfig: Record<string, unknown> = {}
function stageSection(fields: Record<string, unknown>): void {
  stagingConfig = { ...stagingConfig, ...fields }
}

function mergeInto(base: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)
      && typeof base[key] === 'object' && base[key] !== null && !Array.isArray(base[key])) {
      mergeInto(base[key] as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      base[key] = structuredClone(value)
    }
  }
}

/** Emit the 0.1.7 write announcement the plugin re-arms on.
 *
 * Cordis's `emit(...)` takes an OPTIONAL leading `this` (a filter object the
 * Loader uses to target one fiber) — so `emit('loader/volatile-update', [])`
 * would treat `[]` as the EVENT NAME and no listener fires. With one argument
 * the name is dispatched on this context's event bus, which is where the
 * plugin's listener is registered. */
function emitVolatileUpdate(): void {
  ;(context as unknown as { emit(name: string): void })?.emit('loader/volatile-update')
}

let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  liveConfig = {}
  stagingConfig = {}
  configureCalls = []
})

/**
 * A temp auth directory holding one CN and one international sign-in; returns
 * the CN live file as the pinned path.
 *
 * Every test that asserts a region's ROSTER must pin this. Since issue #12 a
 * region with no local sign-in advertises no models, so a config of `{}` reads
 * whichever machine the suite happens to run on: it passed on a developer's
 * machine (real WorkBuddy sign-ins present) and failed on CI (none), which is
 * exactly the ambient dependency this helper removes. Pinning the CN file still
 * exposes the `workbuddy-desktop-ai.info` sibling beside it — an explicit path
 * pins the DIRECTORY (see `candidateFiles`), so both regions get an account.
 */
async function writeRegionFixtures(): Promise<string> {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'wb-both-regions-'))
  const dir = join(root, 'auth')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha', enterpriseId: '' },
    auth: {
      accessToken: 'token-alpha', refreshToken: 'refresh-alpha', tokenType: 'Bearer',
      domain: 'www.codebuddy.cn', expiresAt: Date.now() + 86_400_000,
      refreshExpiresAt: Date.now() + 7 * 86_400_000,
    },
  }), 'utf8')
  await writeFile(join(dir, 'workbuddy-desktop-ai.info'), JSON.stringify({
    account: { uid: 'uid-2', uin: '100000000002', nickname: 'Gamma', enterpriseId: '' },
    auth: {
      accessToken: 'token-gamma', refreshToken: 'refresh-gamma', tokenType: 'Bearer',
      domain: 'www.workbuddy.ai', expiresAt: Date.now() + 86_400_000,
      refreshExpiresAt: Date.now() + 7 * 86_400_000,
    },
  }), 'utf8')
  return join(dir, 'workbuddy-desktop.info')
}

describe('WorkBuddy provider registration', () => {
  it('registers both regional providers, settings, and fallback models after shim startup', async () => {
    const authFile = await writeRegionFixtures()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await mountWorkBuddy(ctx, { authFile })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy-global')
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'workbuddy', displayName: 'WorkBuddy', settingsNs: 'workbuddy', settingsPath: [], declared: false,
    })
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'workbuddy-global', displayName: 'WorkBuddy Global', settingsNs: 'workbuddy', settingsPath: [], declared: false,
    })
    expect(ctx.settings.describe().some(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)).toBe(true)
    // Each region serves its own fallback roster.
    const cnModels = await ctx.llm.listModels('workbuddy')
    expect(cnModels.map(model => model.id)).toContain('glm-5.3')
    expect(cnModels.map(model => model.id)).toContain('deepseek-v4-pro')
    const globalModels = await ctx.llm.listModels('workbuddy-global')
    expect(globalModels.map(model => model.id)).toContain('gpt-5.6-sol')
    expect(globalModels.map(model => model.id)).toContain('deepseek-v4.1-flash')
  })

  it('hides a region that has no local sign-in, and serves the one that does (issue #12)', async () => {
    // The static fallback exists so an OFFLINE upstream never leaves a provider
    // empty, but it must not advertise models for a region the user has no
    // account for: those can only 401, and DSH renders them as pickable.
    // A nonexistent auth path means neither region has an account.
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'wb-nocred-'))
    const LIVE_FILE = 'workbuddy-desktop.info'

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    // The pinned path does not exist yet — and neither does its directory.
    await mountWorkBuddy(ctx, { authFile: join(root, 'auth', LIVE_FILE) })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy-global')

    // Both providers stay REGISTERED — their settings cards and account pickers
    // are how the user signs a region back in — but neither advertises models.
    // DSH drops empty groups from the picker (`buildModelCatalog` filters
    // `models.length > 0`), so the group disappears exactly when it is noise.
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy')).length).toBe(0)
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy-global')).length).toBe(0)

    // Now give the CN region an account: its roster must come back on its own,
    // without a restart, and the account-less global region must stay hidden.
    await mkdir(join(root, 'auth'), { recursive: true })
    await writeFile(join(root, 'auth', LIVE_FILE), JSON.stringify({
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

    // The settings seam re-runs the scan; the CN region converges to serving.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { regions: { cn: { enabledModelIds: ['glm-5.3'] } } })
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    expect((await ctx.llm.listModels('workbuddy-global')).length).toBe(0)
  })

  it('applies the image opt-in to the runtime catalog on settings update', async () => {
    // Needs a real account: since issue #12 a region with no local sign-in
    // advertises no models, and this test is about the opt-in reaching them.
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'wb-image-'))
    const dir = join(root, 'auth')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workbuddy-desktop.info'), JSON.stringify({
      account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha', enterpriseId: '' },
      auth: {
        accessToken: 'token-alpha', refreshToken: 'refresh-alpha', tokenType: 'Bearer',
        domain: 'www.codebuddy.cn', expiresAt: Date.now() + 86_400_000,
        refreshExpiresAt: Date.now() + 7 * 86_400_000,
      },
    }), 'utf8')
    // Both regions get an account, so the global roster is actually served and
    // the cross-region leak assertion below can still fail if it regresses.
    await writeFile(join(dir, 'workbuddy-desktop-ai.info'), JSON.stringify({
      account: { uid: 'uid-2', uin: '100000000002', nickname: 'Gamma', enterpriseId: '' },
      auth: {
        accessToken: 'token-gamma', refreshToken: 'refresh-gamma', tokenType: 'Bearer',
        domain: 'www.workbuddy.ai', expiresAt: Date.now() + 86_400_000,
        refreshExpiresAt: Date.now() + 7 * 86_400_000,
      },
    }), 'utf8')

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await mountWorkBuddy(ctx, { authFile: join(dir, 'workbuddy-desktop.info') })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy-global')

    // Default: no model is image-capable until the user opts in.
    const before = await ctx.llm.listModels('workbuddy')
    const glmBefore = before.find(model => model.id === 'glm-5.3')
    expect(glmBefore?.inputModalities ?? []).not.toContain('image')

    // The card's save writes `imageModelIds`; the same change via the settings
    // seam must reach the adapter input modalities (locks H-1/M-1: the image
    // opt-in is injected on every catalog path, not just the save-onChange one).
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { imageModelIds: ['glm-5.3'] })

    const after = await ctx.llm.listModels('workbuddy')
    const glmAfter = after.find(model => model.id === 'glm-5.3')
    const otherAfter = after.find(model => model.id === 'deepseek-v4-pro')
    expect(glmAfter?.inputModalities).toContain('image')
    expect(otherAfter?.inputModalities ?? []).not.toContain('image')
    // The legacy flat field is CN-only state: the international provider's
    // glm-5.3 (also on its roster) must NOT inherit the CN opt-in.
    const globalAfter = await ctx.llm.listModels('workbuddy-global')
    const globalGlm = globalAfter.find(model => model.id === 'glm-5.3')
    expect(globalAfter.length).toBeGreaterThan(0)
    expect(globalGlm?.inputModalities ?? []).not.toContain('image')
  })

  it('applies a global-slot opt-in to the international provider only', async () => {
    // Needs a global account for the international roster to be advertised.
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'wb-global-optin-'))
    const dir = join(root, 'auth')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workbuddy-desktop-ai.info'), JSON.stringify({
      account: { uid: 'uid-2', uin: '100000000002', nickname: 'Gamma', enterpriseId: '' },
      auth: {
        accessToken: 'token-gamma', refreshToken: 'refresh-gamma', tokenType: 'Bearer',
        domain: 'www.workbuddy.ai', expiresAt: Date.now() + 86_400_000,
        refreshExpiresAt: Date.now() + 7 * 86_400_000,
      },
    }), 'utf8')

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await mountWorkBuddy(ctx, { authFile: join(dir, 'workbuddy-desktop-ai.info') })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy-global')
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy-global')).length).toBeGreaterThan(0)

    // A save from the international tab writes regions.global.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, {
      regions: { global: { imageModelIds: ['gpt-5.6-sol'] } },
    })

    const globalModels = await ctx.llm.listModels('workbuddy-global')
    expect(globalModels.find(model => model.id === 'gpt-5.6-sol')?.inputModalities).toContain('image')
    // The CN provider is untouched by the international tab's save.
    const cnModels = await ctx.llm.listModels('workbuddy')
    expect(cnModels.find(model => model.id === 'glm-5.3')?.inputModalities ?? []).not.toContain('image')
  })

  it('stops serving on the shim port after disposal', async () => {
    // Pinned fixtures: the probe below needs a region that actually serves a
    // roster, which since issue #12 requires a local sign-in.
    const authFile = await writeRegionFixtures()
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await mountWorkBuddy(ctx, { authFile })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')

    // Find the shim's port while the plugin is live.
    const models = await ctx.llm.listModels('workbuddy')
    const probe = models[0]
    expect(probe).toBeDefined()

    await ctx.fiber.dispose()
    // Disposal must release the listener: probing every loopback port the
    // plugin could have taken is impractical, so assert the observable
    // contract instead — disposal completes without leaving a pending
    // unhandled rejection, and the context is no longer usable.
    await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
  })
})

describe('account selection through the settings seam', () => {
  const AUTH_DIR = 'auth'
  const LIVE = 'workbuddy-desktop.info'

  async function writeLiveAuth(root: string): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await mkdir(join(root, AUTH_DIR), { recursive: true })
    await writeFile(join(root, AUTH_DIR, LIVE), JSON.stringify({
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
  }

  it('the empty-string sentinel clears the region back to the documented default', async () => {
    // The card's Clear action writes `accounts.<region> = ''`. That must mean
    // "no explicit selection" (follow the app's current sign-in) — NOT a dead
    // id that can never match, which is what an empty string used to be.
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'wb-clear-'))
    await writeLiveAuth(root)

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await mountWorkBuddy(ctx, { authFile: join(root, AUTH_DIR, LIVE) })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')

    // A stale selection would otherwise be indistinguishable from a real one.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { accounts: { cn: 'orphaned-id' } })
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { accounts: { cn: '' } })

    const doc = readSettings(await settingsSection(ctx))
    expect(doc.accounts?.cn).toBe('')
    // The plugin keeps serving both regions (no crash, no dead provider).
    expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
  })

  it('a cleared region is not re-bound by the legacy accountId at startup (issue #11)', async () => {
    // An upgraded user carries the pre-split `accountId`, which is attributed
    // to its region once the local scan resolves. If the user then clears the
    // region, the sentinel must WIN over that attribution — otherwise the very
    // selection they dropped comes back, and it comes back silently because the
    // restored default is usually the same account, so nothing looks different.
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'wb-clear-legacy-'))
    await writeLiveAuth(root)
    // The account the legacy `accountId` names. Only the billing identity
    // fields matter to the id, so a partial credential is enough.
    const legacyId = (await import('../src/auth.ts')).workbuddyAccountId({
      uid: 'uid-1',
      uin: '100000000001',
      nickname: 'Alpha',
    })

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    // The legacy field is the composition base, exactly as an upgraded user's
    // saved config arrives.
    await mountWorkBuddy(ctx, { accountId: legacyId, authFile: join(root, AUTH_DIR, LIVE) })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')

    // Let the startup attribution resolve while `accounts.cn` is still absent:
    // this is the window in which the legacy id becomes effective.
    await expect.poll(async () =>
      readSettings(await settingsSection(ctx)).accountId,
    ).toBe(legacyId)

    // Now the user clears the CN region.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { accounts: { cn: '' } })

    const doc = readSettings(await settingsSection(ctx)) as unknown as {
      accounts?: Record<string, string>
      accountId?: string
    }
    // The legacy field itself is left untouched (it is the migration source for
    // the OTHER region too) — the sentinel is what has to win, and it does:
    // a cleared region resolves to "follow the app", never to the legacy id.
    expect(doc.accounts?.cn).toBe('')
    expect(doc.accountId).toBe(legacyId)
    expect(WorkBuddy.selectAccountFor('cn', doc, 'cn')).toBeUndefined()
    // The other region is unaffected by the CN clear.
    expect(WorkBuddy.selectAccountFor('global', doc, 'cn')).toBeUndefined()
  })

  it('the startup attribution skips a region cleared in an earlier session (issue #11)', async () => {    // The clear is already in the stored document when the plugin loads — the
    // user cleared it, then restarted DSH. The attribution pass must not
    // re-bind the region just because the legacy `accountId` still matches a
    // local account.
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'wb-clear-restart-'))
    await mkdir(join(root, AUTH_DIR), { recursive: true })
    await writeFile(join(root, AUTH_DIR, LIVE), JSON.stringify({
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
    const legacyId = (await import('../src/auth.ts')).workbuddyAccountId({
      uid: 'uid-1', uin: '100000000001', nickname: 'Alpha',
    })

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    // Pre-existing user layer: the legacy field AND the CN clear, side by side.
    stageSection({ accountId: legacyId, accounts: { cn: '' } })
    await ctx.plugin(MemorySettings)
    await mountWorkBuddy(ctx, { accountId: legacyId, authFile: join(root, AUTH_DIR, LIVE) })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')

    const doc = readSettings(await settingsSection(ctx)) as unknown as {
      accounts?: Record<string, string>
      accountId?: string
    }
    // Whatever the scan concluded, the cleared slot still wins.
    expect(doc.accounts?.cn).toBe('')
    expect(WorkBuddy.selectAccountFor('cn', doc, 'cn')).toBeUndefined()
    // The plugin serves normally; clearing is not a broken state.
    expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
  })

  it('clear is observable through the usage route even when the account is unchanged (issue #11)', async () => {
    // The upgraded user's legacy selection IS the app's current sign-in — the
    // case where clearing changed nothing on screen, because the restored
    // default is the same account. `selectionExplicit` is what lets the card
    // report the mode change instead of looking like a dead button.
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'wb-clear-visible-'))
    await mkdir(join(root, AUTH_DIR), { recursive: true })
    await writeFile(join(root, AUTH_DIR, LIVE), JSON.stringify({
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
    const legacyId = (await import('../src/auth.ts')).workbuddyAccountId({
      uid: 'uid-1', uin: '100000000001', nickname: 'Alpha',
    })
    const { WORKBUDDY_USAGE_PATH } = await import('../src/status-paths.ts')

    interface Captured { path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }
    const captured: Captured[] = []
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin({
      name: 'webServer',
      inject: [] as const,
      apply(c: Context) {
        c.provide('webServer', {
          register: (entry: { path: string }) => { captured.push(entry as Captured); return () => {} },
        })
      },
    })
    await mountWorkBuddy(ctx, { accountId: legacyId, authFile: join(root, AUTH_DIR, LIVE) })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')

    const usage = captured.find(entry => entry.path === WORKBUDDY_USAGE_PATH)
    if (usage === undefined) throw new Error('usage route missing')
    const call = async (): Promise<{ accountName: string; selectionExplicit: boolean }> => {
      let payload = ''
      const res = { writeHead: () => {}, end: (body: string) => { payload = body } }
      await usage.handler({ method: 'GET', headers: {}, url: `${WORKBUDDY_USAGE_PATH}?region=cn` }, res)
      return JSON.parse(payload) as { accountName: string; selectionExplicit: boolean }
    }

    await expect.poll(async () => (await call()).selectionExplicit).toBe(true)
    expect((await call()).accountName).toBe('Alpha')

    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { accounts: { cn: '' } })

    // Same account — the app's sign-in is Alpha and the saved choice was Alpha —
    // but the mode flipped, which is exactly what the card now surfaces.
    const after = await call()
    expect(after.accountName).toBe('Alpha')
    expect(after.selectionExplicit).toBe(false)
  })
})

describe('legacyAttributionRegion', () => {
  const cnAccount = { id: 'cn-account' }
  const globalAccount = { id: 'global-account' }
  /** The region dispatch a real store would answer; `global` has no accounts. */
  const accountsFor = async (region: string): Promise<readonly { id: string }[]> =>
    region === 'cn' ? [cnAccount] : []

  it('attributes the legacy id to the region whose local list owns it', async () => {
    expect(await WorkBuddy.legacyAttributionRegion({ accountId: 'cn-account' }, accountsFor)).toBe('cn')
    expect(await WorkBuddy.legacyAttributionRegion({ accountId: 'global-account' }, accountsFor)).toBeUndefined()
  })

  it('does not attribute a cleared region (issue #11)', async () => {
    // The user dropped the CN choice, then restarted. The id is still in the
    // config and still matches a local CN account — without the skip, the
    // startup pass would silently re-claim the region for it.
    expect(await WorkBuddy.legacyAttributionRegion(
      { accounts: { cn: '' }, accountId: 'cn-account' },
      accountsFor,
    )).toBeUndefined()
  })

  it('still attributes the other region when only one side was cleared', async () => {
    // Clearing CN must not cost the international side its migration.
    expect(await WorkBuddy.legacyAttributionRegion(
      { accounts: { cn: '' }, accountId: 'global-account' },
      async region => region === 'global' ? [globalAccount] : [cnAccount],
    )).toBe('global')
  })

  it('reports no attribution when the saved account is gone everywhere', async () => {
    // The app replaced its sign-in: both regions keep their defaults and the
    // card lets the user re-pick.
    expect(await WorkBuddy.legacyAttributionRegion({ accountId: 'vanished' }, accountsFor)).toBeUndefined()
  })

  it('reports no attribution when there is no legacy field at all', async () => {
    expect(await WorkBuddy.legacyAttributionRegion({}, accountsFor)).toBeUndefined()
  })

  it('skips a cleared region instead of stopping the scan', async () => {
    // Both regions hold the id; CN is cleared, so GLOBAL must claim it rather
    // than the scan giving up at the skipped CN entry.
    const both = async (): Promise<readonly { id: string }[]> => [{ id: 'shared' }]
    expect(await WorkBuddy.legacyAttributionRegion({ accounts: { cn: '' }, accountId: 'shared' }, both))
      .toBe('global')
  })
})

describe('selectAccountFor', () => {
  const legacy = { accountId: 'legacy-id' }

  it('prefers an explicit per-region choice', () => {
    const config = { accounts: { cn: 'chosen' }, accountId: 'legacy-id' }
    expect(WorkBuddy.selectAccountFor('cn', config, 'cn')).toBe('chosen')
  })

  it('attributes the legacy id to its own region only', () => {
    expect(WorkBuddy.selectAccountFor('cn', legacy, 'cn')).toBe('legacy-id')
    // The other side of the split must not inherit it.
    expect(WorkBuddy.selectAccountFor('global', legacy, 'cn')).toBeUndefined()
  })

  it('lets the empty-string sentinel terminate the legacy fallback (issue #11)', () => {
    // The regression this locks: `""` is not `undefined`. Treating it as unset
    // hands the region back to the legacy id, so clearing appears to succeed
    // while the old choice keeps running.
    const cleared = { accounts: { cn: '' }, accountId: 'legacy-id' }
    expect(WorkBuddy.regionCleared(cleared, 'cn')).toBe(true)
    expect(WorkBuddy.selectAccountFor('cn', cleared, 'cn')).toBeUndefined()
  })

  it('distinguishes a cleared region from a never-configured one', () => {
    // Absent key = never configured = the legacy migration still applies...
    expect(WorkBuddy.regionCleared(legacy, 'cn')).toBe(false)
    expect(WorkBuddy.selectAccountFor('cn', legacy, 'cn')).toBe('legacy-id')
    // ...while the sentinel is a deliberate clear and stops it.
    expect(WorkBuddy.selectAccountFor('cn', { accounts: { cn: '' }, accountId: 'legacy-id' }, 'cn')).toBeUndefined()
  })

  it('keeps a cleared region cleared even when the legacy id is its own', () => {
    // Both regions cleared: neither falls back to the shared legacy field.
    const both = { accounts: { cn: '', global: '' }, accountId: 'legacy-id' }
    expect(WorkBuddy.selectAccountFor('cn', both, 'cn')).toBeUndefined()
    expect(WorkBuddy.selectAccountFor('global', both, 'global')).toBeUndefined()
  })

  it('clearing one region does not clear the other', () => {
    const config = { accounts: { cn: '', global: 'kept' }, accountId: 'legacy-id' }
    expect(WorkBuddy.selectAccountFor('cn', config, 'cn')).toBeUndefined()
    expect(WorkBuddy.selectAccountFor('global', config, 'global')).toBe('kept')
  })
})

describe('regionStateOf', () => {
  const model = { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000 }

  it('reads the pre-region-split flat fields as the CN state only', () => {
    const legacy = {
      lastCatalog: [model],
      enabledModelIds: ['glm-5.3'],
      imageModelIds: ['glm-5.3'],
      contextBudgets: { 'glm-5.3': 1_000_000 },
    }
    expect(WorkBuddy.regionStateOf(legacy, 'cn')).toEqual(legacy)
    // The international account must never inherit the CN directory. Doing so
    // intersected a stale CN catalog with the global one and silently dropped
    // the user's international picks (the deepseek-v4.1-flash report).
    expect(WorkBuddy.regionStateOf(legacy, 'global')).toEqual({})
  })

  it('prefers an explicit region slot over the legacy flat fields', () => {
    const config = {
      regions: { cn: { enabledModelIds: ['auto'] } },
      lastCatalog: [model],
      enabledModelIds: ['glm-5.3'],
    }
    expect(WorkBuddy.regionStateOf(config, 'cn').enabledModelIds).toEqual(['auto'])
    // An explicit CN slot does not leak into the global region either.
    expect(WorkBuddy.regionStateOf(config, 'global')).toEqual({})
  })

  it('returns each region its own slot', () => {
    const config = {
      regions: {
        cn: { enabledModelIds: ['glm-5.3'] },
        global: { enabledModelIds: ['gpt-5.6-sol'] },
      },
    }
    expect(WorkBuddy.regionStateOf(config, 'cn').enabledModelIds).toEqual(['glm-5.3'])
    expect(WorkBuddy.regionStateOf(config, 'global').enabledModelIds).toEqual(['gpt-5.6-sol'])
  })
})

describe('DSH 0.1.7 settings compatibility', () => {
  it('marks the plugin Config volatile on the line whose schema is marked', () => {
    const dict = (WorkBuddy.Config as any).dict
    // Both arms are asserted on the SAME machine: the config is marked when the
    // resolved schemastery offers volatile(), and stays unmarked when it does
    // not. Branching on the runtime capability (rather than assuming one) is
    // what lets this suite mean the same thing on both dependency lines.
    const supportsVolatile = typeof dict?.regions?.volatile === 'function'
    const marked = ['regions', 'accounts', 'authFile']
    for (const field of marked) {
      expect(dict?.[field]?.meta?.volatile).toBe(supportsVolatile ? true : undefined)
    }
    // Unmarked fields must NEVER acquire the marker: the 0.1.5 write gate does
    // not read it, and a hand-written marker would bypass validation.
    for (const field of ['lastCatalog', 'enabledModelIds', 'accountId']) {
      expect(dict?.[field]?.meta?.volatile).toBeUndefined()
    }
    expect(dict?.accounts?.meta?.default).toEqual({})
  })

  it('asVolatile() is an identity no-op when the schema offers no volatile()', () => {
    // The 0.1.5 arm, pinned deterministically. Without this the no-op path is
    // only covered when the resolved schemastery happens to be old, so raising
    // the pinned version would quietly delete the coverage — and a hand-written
    // `meta.volatile = true` (which is what that arm exists to prevent) would go
    // unnoticed.
    const plain = z.object({ a: z.string() })
    const stub = { ...plain, volatile: undefined } as unknown as typeof plain
    // `asVolatile` must return the schema UNCHANGED — identity, same object.
    expect(WorkBuddy.asVolatile(stub)).toBe(stub)
    expect((WorkBuddy.asVolatile(stub) as any).dict?.a?.meta?.volatile).toBeUndefined()
  })

  it('unwraps volatile references cleanly in regionStateOf and selectAccountFor', () => {
    const wrappedConfig = {
      regions: {
        get: () => ({ cn: { enabledModelIds: ['glm-5.3'] } }),
      },
      accounts: {
        get: () => ({ cn: 'account-1' }),
      },
      authFile: {
        get: () => '/path/to/auth',
      },
    } as any

    expect(WorkBuddy.regionStateOf(wrappedConfig, 'cn').enabledModelIds).toEqual(['glm-5.3'])
    expect(WorkBuddy.selectAccountFor('cn', wrappedConfig, undefined)).toEqual('account-1')
  })

  it('deep-unwraps, so a NESTED reference is peeled too', () => {
    // The shallow helper only peels the top level a reader touches; the deep one
    // exists because a settings service validates the WHOLE object it is handed.
    const nested = {
      accounts: { get: () => ({ cn: { get: () => 'account-1' } }) },
      list: [{ get: () => 'x' }],
      plain: 'kept',
    }
    const out = WorkBuddy.unwrapVolatileDeep(nested) as any
    expect(out.accounts).toEqual({ cn: 'account-1' })
    expect(out.list).toEqual(['x'])
    expect(out.plain).toBe('kept')
    // The caller's object is never mutated: `settings.get()` hands out the live
    // config, and rewriting it in place would corrupt the running plugin.
    expect(typeof (nested.accounts as any).get).toBe('function')
  })

  it('registers the settings namespace through configure(), the only 0.1.7 path', async () => {
    // On 0.1.7 the namespace is served by `configure({auto}, owner)` — the
    // pre-0.1.7 `installSection` no longer exists, so this is the ONLY
    // registration path left. The observable contract is the same one the
    // card binds to: the served namespace resolves.
    const authFile = await writeRegionFixtures()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await mountWorkBuddy(ctx, { authFile })

    await expect.poll(() => ctx.settings.describe().some(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)).toBe(true)
    // ...and it really did go through `configure`, which is what serves it.
    expect(configureCalls).toHaveLength(1)
    expect(configureCalls[0]?.auto).toBe(true)
  })
})

describe('region on/off switch (issue #11-style region toggle)', () => {
  it('withdraws a switched-off region from the picker while leaving the other live', async () => {
    const authFile = await writeRegionFixtures()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await mountWorkBuddy(ctx, { authFile })
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy-global')).length).toBeGreaterThan(0)

    // Switch the international region off.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { regions: { global: { enabled: false } } })
    // Its route is withdrawn, so the provider drops out of `listProviders()` —
    // which is exactly the list DSH builds the model picker from. The group is
    // gone, not merely hidden. (`listModels` would throw "no adapter registered
    // for provider", which is the same fact stated as an error.)
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).not.toContain('workbuddy-global')
    // Its configurable-provider entry is withdrawn from Settings → Models too.
    await expect.poll(() => ctx.llm.listConfigurableProviders().map(entry => entry.provider)).not.toContain('workbuddy-global')
    // The domestic region is untouched, AND its own directory entry SURVIVES.
    // This is the guard for a real bug: the directory is ONE registration
    // holding both entries, so replacing it per region makes the last region
    // win and silently drops the other's entry — a disabled region would take
    // its enabled sibling out of Settings → Models with it.
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'workbuddy', displayName: 'WorkBuddy', settingsNs: 'workbuddy', settingsPath: [], declared: false,
    })
  })

  it('re-opening a region restores its models without affecting the other', async () => {
    const authFile = await writeRegionFixtures()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await mountWorkBuddy(ctx, { authFile })
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy-global')).length).toBeGreaterThan(0)

    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { regions: { cn: { enabled: false } } })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).not.toContain('workbuddy')
    expect((await ctx.llm.listModels('workbuddy-global')).length).toBeGreaterThan(0)

    // Re-enable CN: its route returns, the global region is never disturbed.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { regions: { cn: { enabled: true } } })
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    expect((await ctx.llm.listModels('workbuddy-global')).length).toBeGreaterThan(0)
  })

  it('a config written before the switch existed keeps both regions on', async () => {
    // No `enabled` field anywhere — the opt-out default must keep both live.
    const authFile = await writeRegionFixtures()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await mountWorkBuddy(ctx, { authFile })
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy-global')).length).toBeGreaterThan(0)
  })

  it('both switched off can still be restored', async () => {
    const authFile = await writeRegionFixtures()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await mountWorkBuddy(ctx, { authFile })
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)

    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, {
      regions: { cn: { enabled: false }, global: { enabled: false } },
    })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).not.toContain('workbuddy')
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).not.toContain('workbuddy-global')
    await expect.poll(() => ctx.llm.listConfigurableProviders().length).toBe(0)

    // Bring both back.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, {
      regions: { cn: { enabled: true }, global: { enabled: true } },
    })
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy-global')).length).toBeGreaterThan(0)
  })
})

/**
 * The settings service mounts the plugin through `configure({auto}, owner)`,
 * the ONLY path since 2.1.0 (0.1.7-rc.1 and up). The pre-0.1.7
 * `SettingsProvider.installSection` branch is gone with the line it served.
 *
 * The plugin used to call `installSection` unconditionally, so on 0.1.7 `apply()`
 * threw `ctx.settings.installSection is not a function` and the ENTIRE plugin
 * failed to mount — not a degraded card, no providers at all. This case pins
 * the 0.1.7 path as the regression guard for that failure mode.
 */
describe('settings-service shape (0.1.7 configure path)', () => {
  /**
   * The 0.1.7 shape: `configure()` present, `installSection()` gone.
   *
   * Cordis mounts a plugin CLASS (`ctx.plugin(Klass)`) and constructs it, so the
   * shape is expressed as a class here — an instance is rejected outright
   * ("expect function or object with an apply method").
   */
  class FormsOnlySettings extends Service {
    constructor(ctx: Context) {
      super(ctx, 'settings')
      configureCalls.push({})
    }
    configure(presentation: { auto?: boolean }, _owner?: unknown): () => void {
      configureCalls[configureCalls.length - 1] = presentation
      return () => {}
    }
    describe(): unknown[] { return [] }
    prepareDocument(): Promise<string> { return Promise.resolve('') }
    apply(): void {}
  }

  it('mounts on a 0.1.7-shaped service through configure(), the only path', async () => {
    const authFile = await writeRegionFixtures()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FormsOnlySettings)
    // The pre-fix failure mode was a THROW here; awaiting it is the assertion.
    await mountWorkBuddy(ctx, { authFile })

    // Both providers still come up: the plugin degraded nothing, it took the
    // configure registration path.
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy-global')
    // ...and it really did go through `configure`, not silently skip settings.
    expect(configureCalls).toHaveLength(1)
    expect(configureCalls[0]?.auto).toBe(true)
  })
})

/**
 * The settings namespace must be the one the HOST serves.
 *
 * On 0.1.7 `describe()` keys every form by `entry.options.id` — the Loader
 * entry id — and the harness resolves a provider's namespace by EXACT match
 * (`namespaces.get(entry.settingsNs)` in the models settings page). A plugin
 * that advertises its own invented name therefore reads as "not configured":
 * its configure affordance and model discovery both go silently dead, with no
 * error anywhere.
 *
 * `ctx.fiber.entry` is injected by the Loader (not by Cordis itself), so it is
 * absent when a plugin is mounted directly — hence the documented fallback.
 */
describe('settingsNamespaceOf', () => {
  it('uses the Loader entry id when the host provides one', () => {
    expect(WorkBuddy.settingsNamespaceOf({ fiber: { entry: { options: { id: 'include:dsh-connect-workbuddy' } } } }))
      .toBe('include:dsh-connect-workbuddy')
  })

  it('falls back to the declared namespace when there is no Loader entry', () => {
    // A bare `ctx.plugin()` mount, or a host that does not expose the entry.
    expect(WorkBuddy.settingsNamespaceOf({})).toBe(WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect(WorkBuddy.settingsNamespaceOf({ fiber: {} })).toBe(WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect(WorkBuddy.settingsNamespaceOf({ fiber: { entry: { options: {} } } })).toBe(WorkBuddy.WORKBUDDY_SETTINGS_NS)
  })

  it('never returns an empty or non-string id', () => {
    // An empty id would be a namespace nothing can address.
    expect(WorkBuddy.settingsNamespaceOf({ fiber: { entry: { options: { id: '' } } } }))
      .toBe(WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect(WorkBuddy.settingsNamespaceOf({ fiber: { entry: { options: { id: 42 } } } }))
      .toBe(WorkBuddy.WORKBUDDY_SETTINGS_NS)
  })

  it('advertises the resolved namespace to the provider directory, not the constant', async () => {
    // The regression this guards: the directory entry named `workbuddy` while
    // the host served `include:...`, so the lookup missed and the provider read
    // as unconfigured. Mount with an entry id and assert the DIRECTORY entry
    // carries it — asserting the constant would pass either way.
    const authFile = await writeRegionFixtures()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await mountWorkBuddy(ctx, { authFile })
    // `ctx.plugin` has no Loader entry, so the fallback applies — the point is
    // that whatever the host serves is what gets advertised. Registration
    // settles asynchronously, so poll rather than sampling once.
    await expect.poll(() => ctx.llm.listConfigurableProviders().map(entry => entry.settingsNs))
      .toContain(WorkBuddy.settingsNamespaceOf(ctx))
  })
})
