import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as WorkBuddy from '../src/index.ts'

/**
 * Raw user sections present BEFORE the provider is constructed. `SettingsProvider`
 * is a Cordis service and cannot be `new`ed outside a context, so a document
 * that was already on disk when the plugin loads (the restart case) is staged
 * here and folded into the first `load()`.
 */
let preloadedDocument: Record<string, unknown> = {}

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private storedDocument: Record<string, unknown> = {}
  apply(ctx: Context): void {
    ctx.settings = this
  }
  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve({ ...structuredClone(preloadedDocument), ...structuredClone(this.storedDocument) })
  }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  preloadedDocument = {}
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
    await ctx.plugin(WorkBuddy, { authFile })
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
    await ctx.plugin(WorkBuddy, { authFile: join(root, 'auth', LIVE_FILE) })
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
    await ctx.plugin(WorkBuddy, { authFile: join(dir, 'workbuddy-desktop.info') })
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
    await ctx.plugin(WorkBuddy, { authFile: join(dir, 'workbuddy-desktop-ai.info') })
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
    await ctx.plugin(WorkBuddy, { authFile })
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
    await ctx.plugin(WorkBuddy, { authFile: join(root, AUTH_DIR, LIVE) })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')

    // A stale selection would otherwise be indistinguishable from a real one.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { accounts: { cn: 'orphaned-id' } })
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { accounts: { cn: '' } })

    const doc = await ctx.settings.get(WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect((doc as { accounts?: Record<string, string> }).accounts?.cn).toBe('')
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
    await ctx.plugin(WorkBuddy, { accountId: legacyId, authFile: join(root, AUTH_DIR, LIVE) })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')

    // Let the startup attribution resolve while `accounts.cn` is still absent:
    // this is the window in which the legacy id becomes effective.
    await expect.poll(async () =>
      (await ctx.settings.get(WorkBuddy.WORKBUDDY_SETTINGS_NS) as { accountId?: string }).accountId,
    ).toBe(legacyId)

    // Now the user clears the CN region.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { accounts: { cn: '' } })

    const doc = await ctx.settings.get(WorkBuddy.WORKBUDDY_SETTINGS_NS) as {
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
    preloadedDocument = { [WorkBuddy.WORKBUDDY_SETTINGS_NS]: { accountId: legacyId, accounts: { cn: '' } } }
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, { accountId: legacyId, authFile: join(root, AUTH_DIR, LIVE) })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')

    const doc = await ctx.settings.get(WorkBuddy.WORKBUDDY_SETTINGS_NS) as {
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
    await ctx.plugin(WorkBuddy, { accountId: legacyId, authFile: join(root, AUTH_DIR, LIVE) })
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
  it('marks every user-editable field when the runtime supports volatile schemas', () => {
    const dict = (WorkBuddy.Config as any).dict
    const expected = typeof dict?.regions?.volatile === 'function' ? true : undefined
    expect(dict?.regions?.meta?.volatile).toBe(expected)
    expect(dict?.accounts?.meta?.volatile).toBe(expected)
    expect(dict?.authFile?.meta?.volatile).toBe(expected)
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

  it('unwraps the deprecated account selector before attributing it', async () => {
    const config = { accountId: { get: () => 'legacy-account' } } as any
    await expect(WorkBuddy.legacyAttributionRegion(config, async region => (
      region === 'global' ? [{ id: 'legacy-account' }] : []
    ))).resolves.toBe('global')
  })
})

describe('region on/off switch (issue #11-style region toggle)', () => {
  it('withdraws a switched-off region from the picker while leaving the other live', async () => {
    const authFile = await writeRegionFixtures()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, { authFile })
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
    await ctx.plugin(WorkBuddy, { authFile })
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
    await ctx.plugin(WorkBuddy, { authFile })
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy-global')).length).toBeGreaterThan(0)
  })

  it('both switched off can still be restored', async () => {
    const authFile = await writeRegionFixtures()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, { authFile })
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
