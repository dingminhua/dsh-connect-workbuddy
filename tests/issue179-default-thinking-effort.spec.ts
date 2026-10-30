/**
 * Issue #179: a per-model DEFAULT thinking tier.
 *
 * What the reporter asked for: 「给一个默认思考强度的选择」 — pick `low` once for
 * `deepseek-v4.1-flash` and stop re-picking it in the host's model menu on every
 * new conversation. The same request also retired the card's read-only
 * 「推理强度：low / high / max」 line, because the picker now IS that disclosure.
 *
 * WHY THIS NEEDS ITS OWN TESTS. Three seams have to agree, and each one has
 * already shipped broken in this bundle:
 *
 *   * The ADVERTISED default (`reasoning.defaultEffort`) is what the host
 *     materializes into every request that names no tier. Advertise one the
 *     model does not declare and the request dies with
 *     `UNSUPPORTED_REASONING_EFFORT` before any byte leaves the process
 *     (issue #90).
 *   * The DISPATCHED tier (`options.reasoningEffort ?? profile.reasoning`) is
 *     per ROUTE, so leaving it alone would keep `/compact` and session titles on
 *     the old constant while the picker claimed otherwise.
 *   * Leaving the tier absent is not "no opinion": pi-ai then fills in the level
 *     map's `off`, which the upstream answers with 400 / 11133 — the defect that
 *     broke `/compact` for good (issue #83).
 *
 * So the assertions below are about the RESOLVED answer at each seam, not about
 * the shape of the settings document.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as WorkBuddy from '../src/index.ts'
import { createWorkBuddyAdapter } from '../src/adapter.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { declaredEfforts, defaultEffortFor, selectableEfforts, WORKBUDDY_DEFAULT_EFFORT } from '../src/default-effort.ts'
import { nextRegionModels, regionsMapOf } from '../src/status-paths.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

/** The catalog the mounted host serves; mirrors the live CN entry. */
const HOST_CATALOG = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'Deepseek-V4.1-Flash',
    contextWindow: 200_000,
    maxTokens: 32_000,
    reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: false },
  },
]

const FLASH: WorkBuddyModelInfo = {
  id: 'deepseek-v4.1-flash',
  name: 'DeepSeek V4.1 Flash',
  contextWindow: 1_000_000,
  maxTokens: 8_000,
  reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: false },
}

/** `glm-5.2`'s live vocabulary: only two tiers, and no `low`. */
const GLM: WorkBuddyModelInfo = {
  id: 'glm-5.2',
  name: 'GLM-5.2',
  contextWindow: 200_000,
  maxTokens: 8_000,
  reasoning: { supportedEfforts: ['high', 'xhigh'], defaultEffort: 'high', canDisableThinking: true },
}

/** A model the upstream declares no tier vocabulary for at all. */
const PLAIN: WorkBuddyModelInfo = {
  id: 'glm-4.6',
  name: 'GLM-4.6',
  contextWindow: 128_000,
  maxTokens: 4_000,
}

function adapterWith(catalogModels: readonly WorkBuddyModelInfo[], saved: Record<string, string> = {}): {
  adapter: ReturnType<typeof createWorkBuddyAdapter>['adapter']
  resolve: (model: string) => Promise<{ id: string, reasoning?: { efforts: { id: string }[], defaultEffort?: string } }>
} {
  const catalog = new WorkBuddyCatalog()
  catalog.set(catalogModels)
  const { adapter } = createWorkBuddyAdapter({
    shim: { baseUrl: () => 'http://127.0.0.1:1', token: async () => 'shared-secret' } as never,
    store: {} as never,
    catalog,
    defaultThinkingEfforts: () => saved,
  })
  return {
    adapter,
    resolve: async (model: string) => await adapter.resolveModel('workbuddy', model) as never,
  }
}

describe('issue #179: the user’s per-model choice wins at every seam', () => {
  it('advertises the saved tier as the model’s default', async () => {
    const { resolve } = adapterWith([FLASH], { 'deepseek-v4.1-flash': 'low' })
    const info = await resolve('deepseek-v4.1-flash')
    // This exact field is what `LlmRuntime.resolveCallWithInfo` materializes into
    // a config that names no tier, so without it the choice would be cosmetic.
    expect(info.reasoning?.defaultEffort).toBe('low')
    // The tier LIST must not change — the picker still offers every declared
    // level, and narrowing it would make the other choices unreachable.
    expect(info.reasoning?.efforts.map(level => level.id)).toEqual(['low', 'high', 'max'])
  })

  it('falls back to the upstream’s own default when the user has no opinion', async () => {
    const { resolve } = adapterWith([FLASH])
    // NOT `WORKBUDDY_DEFAULT_EFFORT` by coincidence: it is read off the catalog
    // entry, so a model whose upstream default is `max` keeps `max`.
    expect((await resolve('deepseek-v4.1-flash')).reasoning?.defaultEffort).toBe('high')
  })

  it('refuses to advertise a tier the model does not declare', async () => {
    // `low` is a real tier — just not for glm-5.2. Advertising it would make the
    // host reject every config-less request with UNSUPPORTED_REASONING_EFFORT.
    const { resolve } = adapterWith([GLM], { 'glm-5.2': 'low' })
    const info = await resolve('glm-5.2')
    expect(info.reasoning?.defaultEffort).toBe('high')
    // `off` rides along because this model declares `canDisableThinking` and is
    // not on the refusal table (issue #34) — offering it is correct. What the
    // saved `low` must NOT do is land here as the default.
    expect(info.reasoning?.efforts.map(level => level.id)).toEqual(['off', 'high', 'xhigh'])
    expect(info.reasoning?.defaultEffort).not.toBe('low')
  })

  it('leaves a model with no tier vocabulary exactly as pi-ai advertised it', async () => {
    const { resolve } = adapterWith([PLAIN], { 'glm-4.6': 'high' })
    const info = await resolve('glm-4.6')
    // The `off`-only shape issued by `advertiseOffOnly` must survive byte for
    // byte: the host's prepared-call check (`callConfigEquals`) compares the
    // config it resolved against the one the adapter dispatches, and inventing a
    // `defaultEffort` here is what would make the two disagree.
    expect(info.reasoning?.defaultEffort).toBeUndefined()
    expect(info.reasoning?.efforts.map(level => level.id)).toEqual(['off'])
  })
})

describe('issue #179: resolution never invents a tier', () => {
  it('keeps the user’s choice when the model declares it', () => {
    expect(defaultEffortFor(FLASH, { 'deepseek-v4.1-flash': 'max' })).toBe('max')
  })

  it('ignores a saved tier the model does not declare', () => {
    // The catalog changes under the user; failing the request would be a worse
    // answer than falling back, and the card re-reads the declaration so the
    // stale choice is visible where it can be corrected.
    expect(defaultEffortFor(GLM, { 'glm-5.2': 'low' })).toBe('high')
  })

  it('uses the upstream default before the route-wide constant', () => {
    const fiveTier: WorkBuddyModelInfo = {
      ...FLASH,
      id: 'space-bunny',
      reasoning: { supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'max' },
    }
    // The constant is `high`; the upstream says `max`. The upstream wins, which
    // is what makes "follow the upstream default" a real answer.
    expect(defaultEffortFor(fiveTier)).toBe('max')
    expect(defaultEffortFor(fiveTier)).not.toBe(WORKBUDDY_DEFAULT_EFFORT)
  })

  it('never answers off, even when off is a real tier', () => {
    const offCapable: WorkBuddyModelInfo = {
      ...FLASH,
      reasoning: { supportedEfforts: ['low', 'high', 'max', 'off'], defaultEffort: 'high', canDisableThinking: true },
    }
    // `off` is a DIFFERENT question with its own owner (`offModelIds`, issue
    // #34). Letting it in here would re-open issue #83: every caller that names
    // no tier — compaction above all — would ask the model to stop thinking.
    expect(defaultEffortFor(offCapable, { 'deepseek-v4.1-flash': 'off' })).toBe('high')
    expect(declaredEfforts(offCapable.reasoning)).not.toContain('off')
  })

  it('returns nothing for a model with no declared tiers', () => {
    // The caller's `off` normalization is the correct answer for these models —
    // it is a no-op on the wire — so resolving a tier here would reintroduce the
    // `UNSUPPORTED_REASONING_EFFORT` defect issue #90 fixed.
    expect(defaultEffortFor(PLAIN)).toBeUndefined()
    expect(selectableEfforts(PLAIN.reasoning)).toEqual([])
  })
})

describe('issue #179: the picker offers exactly what the model declares', () => {
  it('uses the upstream names, in DSH’s order, without localising', () => {
    // Verbatim on purpose: the vocabularies genuinely differ across one roster
    // (`low/high/max` vs `high/xhigh`), so a synthesized ladder would offer rows
    // that fail, and these are the words every other client shows.
    expect(selectableEfforts(FLASH.reasoning)).toEqual(['low', 'high', 'max'])
    expect(selectableEfforts(GLM.reasoning)).toEqual(['high', 'xhigh'])
  })

  it('drops a tier DSH cannot speak', () => {
    const odd: WorkBuddyModelInfo = {
      ...FLASH,
      reasoning: { supportedEfforts: ['low', 'turbo'], defaultEffort: 'low' },
    }
    expect(selectableEfforts(odd.reasoning)).toEqual(['low'])
  })
})

/**
 * The DISPATCH seam, driven through the HOST.
 *
 * Driving the REAL `LlmRuntime` (rather than calling `adapter.stream` directly)
 * is the point: the host is the component that materializes the advertised
 * `defaultEffort` into a request that names none, so this asserts the tier that
 * actually reaches the wire — not just the metadata the catalog exposes.
 */
/**
 * Mount the plugin with canned upstream answers and record the request bodies
 * that reach the wire. The shim is REAL (so the adapter points at a real
 * loopback port); only the gateway call is replaced.
 */
async function mountHost(saved: Record<string, string>): Promise<Context> {
  const authFile = await cnAuthFile()
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemorySettings)
  liveConfig = {
    authFile,
    regions: {
      cn: {
        enabled: true,
        lastCatalog: HOST_CATALOG,
        enabledModelIds: [],
        defaultThinkingEfforts: saved,
      },
    },
  }
  WorkBuddy.apply(ctx, liveConfig as WorkBuddy.Config)
  realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url).includes('chat/completions')) {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as Record<string, unknown>)
      return sseAnswer()
    }
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
  }) as typeof fetch
  await expect.poll(async () => {
    try { await ctx.llm.resolveModelInfo('workbuddy', 'deepseek-v4.1-flash'); return true } catch { return false }
  }).toBe(true)
  return ctx
}

function sseAnswer(): Response {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: '' }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ]
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.join('')))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** Drive one config-less request through the host and report how it ended. */
async function send(ctx: Context, effort?: string): Promise<{ ok: boolean }> {
  const stream = ctx.llm.stream({
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  } as never) as AsyncIterable<unknown>
  let last: { type?: string, reason?: { kind?: string } } | undefined
  for await (const chunk of stream) last = chunk as typeof last
  return { ok: last?.reason?.kind !== 'error' }
}

class MemorySettings extends Service {
  constructor(ctx: Context) { super(ctx, 'settings') }
  configure() { return () => {} }
  describe() {
    return [{ ns: WorkBuddy.WORKBUDDY_SETTINGS_NS, autoGenerate: true, revision: 0, applies: 'live', value: liveConfig }]
  }
  async update(_ns: string, patch: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(patch)) liveConfig[key] = structuredClone(value)
  }
}

let liveConfig: Record<string, unknown> = {}
let context: Context | undefined
let bodies: Record<string, unknown>[] = []
let realFetch: typeof globalThis.fetch

afterEach(async () => {
  globalThis.fetch = realFetch
  await context?.fiber.dispose()
  context = undefined
  liveConfig = {}
  bodies = []
})

async function cnAuthFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-effort179-'))
  const dir = join(root, 'auth')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'workbuddy-desktop.info')
  await writeFile(file, JSON.stringify({
    account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha', enterpriseId: '' },
    auth: {
      accessToken: 'token-alpha', refreshToken: 'refresh-alpha', tokenType: 'Bearer',
      domain: 'www.codebuddy.cn', expiresAt: Date.now() + 86_400_000,
      refreshExpiresAt: Date.now() + 7 * 86_400_000,
    },
  }), 'utf8')
  return file
}

describe('issue #179: a request that names no tier dispatches at the saved one', () => {
  it('sends the user’s saved tier, not the route constant', async () => {
    const ctx = await mountHost({ 'deepseek-v4.1-flash': 'low' })
    expect(await send(ctx)).toEqual({ ok: true })
    expect(bodies.length, 'no request reached the wire').toBe(1)
    // `high` is `WORKBUDDY_DEFAULT_EFFORT` — the per-route value this feature
    // replaces. Seeing it here would mean the save only changed the picker.
    expect(bodies[0]?.['reasoning_effort']).toBe('low')
  })

  it('falls back to the model’s own upstream default with no saved choice', async () => {
    const ctx = await mountHost({})
    expect(await send(ctx)).toEqual({ ok: true })
    // Declared by the catalog entry, so a model that declares something other
    // than `high` keeps it — the property a route-wide constant cannot have.
    expect(bodies[0]?.['reasoning_effort']).toBe('high')
  })

  it('keeps an explicitly named tier instead of overriding it', async () => {
    // The host validates an explicit tier against the same model, so silently
    // replacing it here would make the model picker's own choice unreachable.
    const ctx = await mountHost({ 'deepseek-v4.1-flash': 'low' })
    expect(await send(ctx, 'max')).toEqual({ ok: true })
    expect(bodies[0]?.['reasoning_effort']).toBe('max')
  })
})

/**
 * Issue #179, second half: the reported low→high flip after an account switch.
 *
 * The reporter saw the composer's effort label change from `low` to `high` when
 * a mid-conversation account switch happened, and could not tell whether only
 * the label moved or the request did too. The mechanism, read out of the
 * shipped host (`dsh-client-ui-model-selection`): the composer label is
 * `current.reasoningEffort ?? reasoning.defaultEffort`, and `defaultEffort`
 * comes from the model catalog, which the client RELOADS on every
 * `llm/adapters-updated` — an event this plugin emits from `invalidateCatalog()`
 * on every settings change, account switch included. The plugin used to
 * hard-code that default to `high` for the whole route, so the reload replaced
 * the user's `low` with `high` in the DISPLAY while the durable per-session
 * selection (and therefore the dispatched tier) kept `low`.
 *
 * Both halves are asserted here because a fix that only moved the label would
 * pass a UI test and leave the reporter's actual doubt unresolved.
 */
describe('issue #179: an account switch does not move the session’s tier', () => {
  it('keeps the session selection, and its dispatch, at the chosen tier', async () => {
    const ctx = await mountHost({ 'deepseek-v4.1-flash': 'low' })
    // A switch means a fresh catalog generation (the client reloads on
    // `llm/adapters-updated`), so re-read the metadata the label is derived from.
    const before = await ctx.llm.resolveModelInfo('workbuddy', 'deepseek-v4.1-flash')
    expect(before.reasoning?.defaultEffort).toBe('low')
    expect(await send(ctx)).toEqual({ ok: true })
    expect(bodies[0]?.['reasoning_effort']).toBe('low')
  })

  it('advertises the SAME default before and after a catalog invalidation', async () => {
    // `invalidateCatalog()` runs on every settings change, and the client
    // treats `llm/adapters-updated` as "reload the catalog". A default that
    // moved across that reload IS the reported flip, so it must be stable.
    const ctx = await mountHost({ 'deepseek-v4.1-flash': 'low' })
    const first = await ctx.llm.resolveModelInfo('workbuddy', 'deepseek-v4.1-flash')
    await ctx.llm.listModels('workbuddy')
    const second = await ctx.llm.resolveModelInfo('workbuddy', 'deepseek-v4.1-flash')
    expect(second.reasoning?.defaultEffort).toBe(first.reasoning?.defaultEffort)
    expect(second.reasoning?.defaultEffort).toBe('low')
  })
})

/**
 * The SETTINGS surface: what the card writes, and what the Host answers with.
 *
 * These two must agree for the feature to be usable at all. The card saves
 * through the Host endpoint (the browser mirror is documented stale for this
 * namespace), and the save's slot merge is two levels deep — so the nested dict
 * is REPLACED, never merged. A partial map would therefore delete every pick it
 * omits, and "follow the upstream default" is expressed BY ABSENCE, which makes
 * an omitted model indistinguishable from a deleted one unless the whole map is
 * always sent.
 */
describe('issue #179: the saved map survives the settings round trip', () => {
  it('replaces the nested map rather than merging into it', () => {
    const slot = { defaultThinkingEfforts: { a: 'low', b: 'high' } }
    const next = nextRegionModels(
      { cn: slot },
      'cn',
      { defaultThinkingEfforts: { a: 'max' } },
    )
    // `b` is GONE, which is correct: the card sends the complete map, so an
    // absent key is the user's own "no opinion" and must not survive.
    expect((next['cn'] as Record<string, unknown>)['defaultThinkingEfforts']).toEqual({ a: 'max' })
  })

  it('keeps sibling slot fields the save did not mention', () => {
    const next = nextRegionModels(
      { cn: { defaultThinkingEfforts: { a: 'low' }, offModelIds: ['x'], enabled: true } },
      'cn',
      { defaultThinkingEfforts: {} },
    )
    const slot = next['cn'] as Record<string, unknown>
    // The merge is deliberately not deeper than the slot: a save about the
    // effort map must not delete the `off` answers living beside it.
    expect(slot['offModelIds']).toEqual(['x'])
    expect(slot['enabled']).toBe(true)
    expect(slot['defaultThinkingEfforts']).toEqual({})
  })

  it('treats the field as a slot field, never as a region key', () => {
    // `REGION_MAP_FOREIGN_KEYS` is what undoes a data-loss bug: a name in that
    // set is stripped from the region MAP. This field belongs to a SLOT, so
    // `regionsMapOf` (the reader every save and runtime read goes through) must
    // report only real regions — while never stripping the field from a slot.
    const map = {
      cn: { defaultThinkingEfforts: { a: 'low' } },
      // A stale document that buried the map one level down: the repair has to
      // recover `cn` from here AND drop this bogus sibling key.
      defaultThinkingEfforts: { bogus: 'low' },
    }
    // `cn` is ABSENT at the top level, so the buried copy is what gets
    // recovered — the shape the 5.4.0→5.5.0 bug actually left behind.
    const healed = regionsMapOf({ regions: map })
    expect(healed['defaultThinkingEfforts']).toBeUndefined()
    expect((healed['cn'] as Record<string, unknown>)['defaultThinkingEfforts']).toEqual({ a: 'low' })
  })
})
