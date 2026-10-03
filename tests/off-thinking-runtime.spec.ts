import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as WorkBuddy from '../src/index.ts'

/**
 * Issue #34, end to end through the real DSH seam.
 *
 * `tests/off-thinking.spec.ts` proves the RULE; `tests/adapter.spec.ts` proves
 * the level MAP. Neither proves the two are connected — that the plugin
 * actually stamps the corrected answer onto the runtime catalog before the
 * adapter reads it. That wiring is what the user experiences, so it is asserted
 * here through `ctx.llm.resolveModel`, the same surface DSH's model picker
 * reads to decide which thinking levels to offer.
 */

/** The 0.1.7-shaped settings service; see `issue12-region-hiding.spec.ts`. */
class MemorySettings extends Service {
  constructor(ctx: Context) { super(ctx, 'settings') }
  configure() { return () => {} }
  describe() {
    return [{ ns: WorkBuddy.WORKBUDDY_SETTINGS_NS, autoGenerate: true, revision: 0, applies: 'live', value: liveConfig }]
  }
  async update(ns: string, patch: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(patch)) {
      liveConfig[key] = structuredClone(value)
    }
    ;(context as unknown as { emit(name: string): void })?.emit('loader/volatile-update')
  }
}

let liveConfig: Record<string, unknown> = {}
let context: Context | undefined
afterEach(async () => { await context?.fiber.dispose(); context = undefined; liveConfig = {} })

/** A CN desktop sign-in, which is all the harness needs to serve a catalog. */
async function cnAuthFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-off34-'))
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

/**
 * The directory the runtime derives from, written straight into `lastCatalog`.
 *
 * Every entry declares `canDisableThinking: true` — which is exactly the trap
 * in issue #34: the declaration is identical across all three, and only the
 * model id separates the ones that answer 400 from the ones that answer 200.
 * Kept at three entries because the assertion is about ids, not the roster.
 */
const CATALOG = [
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200_000, maxTokens: 32_000, reasoning: { supportedEfforts: ['low', 'medium', 'high'], canDisableThinking: true } },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 200_000, maxTokens: 32_000, reasoning: { supportedEfforts: ['low', 'medium', 'high'], canDisableThinking: true } },
  { id: 'grok-4.7', name: 'Grok 4.7', contextWindow: 200_000, maxTokens: 32_000, reasoning: { supportedEfforts: ['low', 'medium', 'high'], canDisableThinking: true } },
]

/** Mount the plugin and mount a catalog of reasoning-bearing models. */
async function mount(regionState: Record<string, unknown> = {}): Promise<Context> {
  const authFile = await cnAuthFile()
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemorySettings)
  liveConfig = {
    authFile,
    regions: { cn: { enabled: true, lastCatalog: CATALOG, enabledModelIds: [], ...regionState } },
  }
  WorkBuddy.apply(ctx, liveConfig as WorkBuddy.Config)
  return ctx
}

/**
 * The effort ids DSH would offer for one model, in adapter order.
 *
 * Polled rather than awaited once: the route and its adapter are registered
 * from inside the plugin's async loopback startup, so a direct read can land
 * before the adapter exists ("no adapter registered for provider").
 */
async function effortsOf(ctx: Context, modelId: string): Promise<string[]> {
  let efforts: string[] = []
  await expect.poll(async () => {
    try {
      const resolved = await ctx.llm.resolveModelInfo('workbuddy', modelId)
      efforts = (resolved.reasoning?.efforts ?? []).map(effort => String(effort.id))
      return true
    } catch {
      return false
    }
  }).toBe(true)
  return efforts
}

describe('issue #34: the runtime catalog withdraws off for models that refuse it', () => {
  it('keeps off for a model that accepts it, without needing an override', async () => {
    // The regression guard: an over-broad rule would hide the level here, which
    // is a functional loss for the majority of the roster.
    const ctx = await mount()
    expect(await effortsOf(ctx, 'glm-5.3')).toContain('off')
  })

  it('withdraws off for the models measured as refusing it', async () => {
    const ctx = await mount()
    const efforts = await effortsOf(ctx, 'deepseek-v4.1-flash')
    expect(efforts).not.toContain('off')
    // Only `off` is withdrawn: the other levels answer 200 and must survive, or
    // the fix would be a bigger regression than the bug.
    expect(efforts).toEqual(expect.arrayContaining(['low', 'medium', 'high']))
  })

  it('leaves an unlisted model decided by its own declaration', async () => {
    // A brand-new id must not inherit the correction from a family prefix.
    const ctx = await mount()
    expect(await effortsOf(ctx, 'grok-4.7')).toContain('off')
  })
})

describe('issue #34: the saved selection wins over the built-in seed', () => {
  it('honours a saved selection that offers off for a refused model', async () => {
    // The user ticked it back on — the checkbox is the truth, so the level
    // comes back even though the built-in rule withdraws it.
    const ctx = await mount({ offModelIds: ['deepseek-v4.1-flash'] })
    expect(await effortsOf(ctx, 'deepseek-v4.1-flash')).toContain('off')
  })

  it('honours a saved selection that withdraws off for an accepted model', async () => {
    // A model the table has not learned about yet is silenced by the user.
    const ctx = await mount({ offModelIds: [] })
    expect(await effortsOf(ctx, 'grok-4.7')).not.toContain('off')
    // ...and the selection is per model, not a global switch.
    expect(await effortsOf(ctx, 'glm-5.3')).not.toContain('off')
  })
})
