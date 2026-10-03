import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as WorkBuddy from '../src/index.ts'

/**
 * The 0.1.7-shaped settings service, standing in for `SettingsForms`. The
 * plugin is mounted with a DIRECT `apply(ctx, config)` call so `config` is a
 * plain object BOTH the service and the plugin share by reference — `update()`
 * mutates it and emits the 0.1.7 write announcement, exactly like the real
 * Loader commits a volatile write and re-arms consumers.
 */
class MemorySettings extends Service {
  constructor(ctx: Context) { super(ctx, 'settings') }
  configure() { return () => {} }
  describe() {
    return [{ ns: WorkBuddy.WORKBUDDY_SETTINGS_NS, autoGenerate: true, revision: 0, applies: 'live', value: liveConfig }]
  }
  async update(ns: string, patch: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)
        && typeof liveConfig[key] === 'object' && liveConfig[key] !== null && !Array.isArray(liveConfig[key])) {
        for (const [k, v] of Object.entries(value)) (liveConfig[key] as Record<string, unknown>)[k] = structuredClone(v)
      } else {
        liveConfig[key] = structuredClone(value)
      }
    }
    ;(context as unknown as { emit(name: string): void })?.emit('loader/volatile-update')
  }
}

/** The config object the mounted plugin reads; reset between tests. */
let liveConfig: Record<string, unknown> = {}

let context: Context | undefined
afterEach(async () => { await context?.fiber.dispose(); context = undefined; liveConfig = {} })

/** A CN-only machine: exactly the reporter's environment. */
async function cnOnlyRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-issue12-'))
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
  return join(dir, 'workbuddy-desktop.info')
}

/** Mount the plugin with a direct `apply()`, sharing one mutable config. */
function mountWorkBuddy(ctx: Context, config: Record<string, unknown>): void {
  liveConfig = config
  WorkBuddy.apply(ctx, config as WorkBuddy.Config)
}

describe('issue #12: a region with no account must not advertise models', () => {
  it('hides workbuddy-global entirely for a CN-only machine', async () => {
    const authFile = await cnOnlyRoot()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    mountWorkBuddy(ctx, { authFile })
    await expect.poll(() => ctx.llm.listProviders().map(p => p.id)).toContain('workbuddy-global')

    // CN: has an account → serves its roster.
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)

    // Global: no account → advertises nothing. This is the reported symptom:
    // 20 fallback models that can only 401.
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy-global')).length).toBe(0)

    // The provider itself must STAY registered: its settings card and account
    // picker are how the user signs the region in. Hiding the group is a
    // catalog-level decision, not a registration one.
    expect(ctx.llm.listProviders().map(p => p.id)).toContain('workbuddy-global')
    expect(ctx.llm.listConfigurableProviders().map(p => p.provider)).toContain('workbuddy-global')
  })

  it('brings the models back when an account appears, without a restart', async () => {
    const authFile = await cnOnlyRoot()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    mountWorkBuddy(ctx, { authFile })
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy-global')).length).toBe(0)

    // The user signs in to the international desktop app.
    const dir = join(authFile, '..')
    await writeFile(join(dir, 'workbuddy-desktop-ai.info'), JSON.stringify({
      account: { uid: 'uid-2', uin: '100000000002', nickname: 'Gamma', enterpriseId: '' },
      auth: {
        accessToken: 'token-gamma', refreshToken: 'refresh-gamma', tokenType: 'Bearer',
        domain: 'www.workbuddy.ai', expiresAt: Date.now() + 86_400_000,
        refreshExpiresAt: Date.now() + 7 * 86_400_000,
      },
    }), 'utf8')

    // Any settings change re-runs the scan (the card's "detect accounts again"
    // also reports usability through its own route).
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { regions: { global: { enabledModelIds: ['gpt-5.6-sol'] } } })
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy-global')).length).toBeGreaterThan(0)
  })
})

describe('issue #32: a saved slot without a directory must not overwrite the live catalog', () => {
  it('keeps serving the LIVE catalog when a partial save creates a directoryless slot', async () => {
    // THE regression, read half. On a profile that never successfully saved
    // (issue #31), `regions` is `{}`. A first save that mentions only
    // `enabledModelIds` used to leave the CN slot with NO `lastCatalog`, so the
    // next `applySelection` fell all the way back to the STATIC 12-model roster
    // and `catalog.set()` committed it over the live 17-model directory. The
    // model the agent was using (upstream-only, absent from the static list)
    // vanished mid-session with no error.
    const authFile = await cnOnlyRoot()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    mountWorkBuddy(ctx, { authFile })

    // Let startup finish: the CN catalog carries its own roster.
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    const before = (await ctx.llm.listModels('workbuddy')).map(model => model.id)
    expect(before.length).toBeGreaterThan(0)

    // A partial save that never mentions `lastCatalog` — exactly the payload the
    // card's pool/preference writes used to send.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, {
      regions: { cn: { enabledModelIds: [before[0] as string] } },
    })

    // Narrowing the selection is expected; GAINING the static roster or LOSING
    // every other id is not. Assert the survivor set is a subset of what was
    // live before, which is what distinguishes "user picked one model" from
    // "the static list replaced the live one".
    await expect.poll(async () => (await ctx.llm.listModels('workbuddy')).map(model => model.id))
      .toEqual([before[0]])
  })

  it('does not report the in-use model as withdrawn after a directoryless save', async () => {
    // The card reads `displayModels` for the picker. It must show the live
    // roster rather than falling back to the static one, or the user sees their
    // working model listed as "已下架" while the runtime is still serving it.
    //
    // This drives a REALLY non-static directory by stubbing the upstream model
    // catalog, because a bare `length > 0` would pass against the static
    // fallback and prove nothing: without a stub the startup roster IS the
    // static list, so the two are indistinguishable by content.
    const authFile = await cnOnlyRoot()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)

    // `space-bunny` exists ONLY upstream — the exact shape of the reporter's
    // in-use default model, which the static list does not carry.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 0,
      data: {
        models: [
          { id: 'space-bunny', name: 'Space Bunny', maxInputTokens: 1_000_000, maxOutputTokens: 48_000 },
          { id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1_000_000, maxOutputTokens: 48_000 },
        ],
        agents: [{ name: 'cli', models: ['space-bunny', 'glm-5.3'] }],
      },
    }), { status: 200 })) as typeof fetch
    try {
      mountWorkBuddy(ctx, { authFile })
      await expect.poll(async () => (await ctx.llm.listModels('workbuddy')).map(model => model.id).sort())
        .toEqual(['glm-5.3', 'space-bunny'])

      // The save lands a slot with no directory at all.
      await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, {
        regions: { cn: { imageModelIds: [] } },
      })

      // The offered set must survive the save unchanged. Under the #32 bug the
      // live catalog was replaced by the static roster, so `space-bunny`
      // disappeared even though the upstream was still answering with it.
      await expect.poll(async () => (await ctx.llm.listModels('workbuddy')).map(model => model.id).sort())
        .toEqual(['glm-5.3', 'space-bunny'])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})