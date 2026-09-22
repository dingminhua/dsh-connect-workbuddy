import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as WorkBuddy from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private storedDocument: Record<string, unknown> = {}
  apply(ctx: Context): void { ctx.settings = this }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.storedDocument)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

let context: Context | undefined
afterEach(async () => { await context?.fiber.dispose(); context = undefined })

/** A CN-only machine: exactly the reporter's environment. */
async function cnOnlyRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-issue12-'))
  const dir = join(root, 'auth')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha', enterpriseId: '' },
    auth: {
      accessToken: 'token-alpha', refreshToken: 'refresh-alpha', tokenType: 'Bearer',
      domain: 'www.workbuddy.cn', expiresAt: Date.now() + 86_400_000,
      refreshExpiresAt: Date.now() + 7 * 86_400_000,
    },
  }), 'utf8')
  return join(dir, 'workbuddy-desktop.info')
}

describe('issue #12: a region with no account must not advertise models', () => {
  it('hides workbuddy-global entirely for a CN-only machine', async () => {
    const authFile = await cnOnlyRoot()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, { authFile })
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
    await ctx.plugin(WorkBuddy, { authFile })
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
