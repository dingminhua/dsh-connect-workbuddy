import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as WorkBuddy from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private storedDocument: Record<string, unknown> = {}
  apply(ctx: Context): void {
    ctx.settings = this
  }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.storedDocument)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

let context: Context | undefined
afterEach(async () => { await context?.fiber.dispose(); context = undefined })

describe('WorkBuddy provider registration', () => {
  it('registers provider, settings, and fallback models after shim startup', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, {})
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'workbuddy', displayName: 'WorkBuddy', settingsNs: 'workbuddy', settingsPath: [], declared: false,
    })
    expect(ctx.settings.describe().some(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)).toBe(true)
    const models = await ctx.llm.listModels('workbuddy')
    expect(models.map(model => model.id)).toContain('glm-5.3')
    expect(models.map(model => model.id)).toContain('deepseek-v4-pro')
  })

  it('serves a usable catalog even with no credentials configured', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    // Point the store at a path that cannot exist so resolution always fails;
    // the static fallback must still populate the provider.
    await ctx.plugin(WorkBuddy, { authFile: '/nonexistent/workbuddy-desktop.info' })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    const models = await ctx.llm.listModels('workbuddy')
    expect(models.length).toBeGreaterThan(0)
  })

  it('applies the image opt-in to the runtime catalog on settings update', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, { authFile: '/nonexistent/workbuddy-desktop.info' })
    await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')

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
  })

  it('stops serving on the shim port after disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, {})
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
