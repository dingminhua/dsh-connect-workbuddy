import { describe, expect, it } from 'vitest'
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'

/**
 * Issue #75: `Unknown provider: workbuddy` — a TOTAL outage of the global region.
 *
 * THE DEFECT, as three facts that only combine into a bug:
 *   1. issue #59's fix stamps ONE model identity (`workbuddy`) on the models of
 *      BOTH regions, so a cross-region thinking block is not downgraded to text
 *      (`api/transform-messages.js`'s `isSameModel` compares
 *      `assistantMsg.provider` against `model.provider`).
 *   2. `Models.setProvider(provider)` registers a provider under `provider.id`
 *      (`models.js:35–38`) — and the host calls it once per published profile
 *      (`dsh-llm-pi-ai/lib/index.js:1762–1763`). The registry key is the
 *      provider OBJECT's id, NOT the profiles-map key the object was published
 *      under.
 *   3. Every chat request dispatches through `models.streamSimple(model, …)`,
 *      whose first frame is `requireProvider(model)` = `providers.get(model.provider)`
 *      — the STAMPED field (`models.js:351–355`).
 *
 * So the CN region (route `workbuddy`, stamp `workbuddy`) matched its own
 * registry and worked, while the global region (route `workbuddy-global`, stamp
 * `workbuddy`) looked up a key it never published: `ModelsError: Unknown
 * provider: workbuddy`, on every single request, in one region only.
 *
 * WHAT MUST HOLD. The shared IDENTITY must be resolvable in EACH region's
 * registry, and each region must still reach its OWN shim:
 *   1. a registry built exactly the way the host builds it resolves a model
 *      stamped `workbuddy` in BOTH regions — no `Unknown provider`, and
 *   2. the route key still resolves, still lists models, and still carries that
 *      region's `baseUrl`, because one shared provider object collapsing both
 *      regions onto one shim would be the same outage wearing a different hat.
 *
 * These tests assert the BUILT REGISTRY, not the shape of the profiles map. The
 * map is an implementation detail whose keys the host then throws away (see
 * fact 2); a map that publishes the same provider object twice is a silent
 * no-op, and only a real registry can tell the difference.
 *
 * Dispatch is exercised without a network: the plugin's provider has no
 * credential in this registry, so `applyAuth` fails one frame AFTER
 * `requireProvider` returned — which is exactly the boundary under test.
 */

/** pi-ai's provider surface, reduced to what this file reads. */
interface PiProviderLite {
  id: string
  getModels: () => { id: string, provider: string, api: string, baseUrl: string }[]
}

interface ProfileLite {
  provider: string
  piProvider: PiProviderLite
}

/** A live adapter: the published profile map plus its rebuild hook. */
interface RegionAdapter {
  region: 'cn' | 'global'
  route: string
  baseUrl: string
  profiles: () => ReadonlyMap<string, ProfileLite>
  invalidate: () => void
}

interface DispatchOutcome {
  errorMessage?: string
}

/** A provider object as the registry hands it back: an id and its models. */
interface ResolvedProvider {
  id: string
  getModels: () => readonly { id: string, provider: string, baseUrl: string }[]
}

/** The throw site itself (`models.js:351–355`), reached the way pi-ai reaches it. */
function requireProvider(registry: unknown, model: unknown): ResolvedProvider {
  return (registry as { requireProvider: (model: unknown) => ResolvedProvider }).requireProvider(model)
}

/** One model in one region's catalog, so `getModels()` has content. */
async function catalogWithOneModel(region: 'cn' | 'global') {
  const { WorkBuddyCatalog } = await import('../src/catalog.ts')
  const catalog = new WorkBuddyCatalog(region)
  catalog.set([{
    id: 'hy3',
    name: 'Hy3',
    contextWindow: 200_000,
    maxTokens: 32_000,
  }])
  return catalog
}

/**
 * Build one region's adapter against a stub shim, exactly as `index.ts` does:
 * one adapter per region, each owning its own route id.
 */
async function regionAdapter(
  region: 'cn' | 'global',
  route: string,
  shimOrigin: string,
): Promise<RegionAdapter> {
  const { createWorkBuddyAdapter } = await import('../src/adapter.ts')
  const built = createWorkBuddyAdapter({
    shim: { baseUrl: () => shimOrigin, token: async () => 'shared-secret' } as never,
    store: {} as never,
    catalog: await catalogWithOneModel(region),
    provider: route,
  })
  return {
    region,
    route,
    baseUrl: `${shimOrigin}/v1`,
    profiles: () => (built.adapter as unknown as {
      config: { profiles: () => ReadonlyMap<string, ProfileLite> }
    }).config.profiles(),
    invalidate: built.invalidate,
  }
}

/**
 * The host's registry, verbatim: `createModels(...)` then `setProvider` once per
 * published profile (`dsh-llm-pi-ai/lib/index.js:1762–1763`).
 */
async function hostRegistry(profiles: ReadonlyMap<string, ProfileLite>) {
  const { createModels } = await import('@earendil-works/pi-ai')
  const models = createModels()
  for (const profile of profiles.values()) models.setProvider(profile.piProvider as never)
  return models
}

/**
 * Dispatch one model through the registry and report how the attempt ended.
 *
 * `requireProvider` runs first, so an `Unknown provider` failure surfaces here
 * as the terminal `errorMessage` — the same surface the host logs.
 */
/** The one method the chat path needs, narrowed to what this test reads. */
interface StreamableRegistry {
  streamSimple: (model: unknown, context: unknown, options: unknown) => { result: () => Promise<DispatchOutcome> }
}

async function dispatch(registry: unknown, model: unknown): Promise<DispatchOutcome> {
  // Invoked as a member, never destructured off first: `streamSimple` reaches
  // `this.providers`, and an unbound call fails for a different reason.
  return await (registry as StreamableRegistry).streamSimple(model, { messages: [] }, {}).result()
}

/** Every model the registry serves under one provider key. */
function modelsUnder(registry: unknown, key: string): readonly { id: string, provider: string, baseUrl: string }[] {
  return (registry as { getModels: (key: string) => readonly { id: string, provider: string, baseUrl: string }[] })
    .getModels(key)
}

/** The wire shape pi-ai itself replays, built once so both sides agree. */
function assistantWithThinking(provider: string, model: string, thinking: string): unknown {
  return {
    role: 'assistant',
    api: 'openai-completions',
    provider,
    model,
    content: [
      { type: 'thinking', thinking, thinkingSignature: 'sig' },
      { type: 'text', text: 'here is the answer' },
    ],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
  }
}

/** The request side: only the compared fields plus `input` matter here. */
function requestModel(provider: string, id = 'hy3'): unknown {
  return { id, api: 'openai-completions', provider, input: ['text'] }
}

function blockTypes(transformed: unknown): string[] {
  const messages = (transformed as { content: { type: string }[] }[])
  return messages.flatMap(m => m.content.map(b => b.type))
}

const CN_ORIGIN = 'http://127.0.0.1:41000'
const GLOBAL_ORIGIN = 'http://127.0.0.1:42000'

/** Both regions wired the way `index.ts` wires them. */
async function bothRegions() {
  const { WORKBUDDY_PROVIDER, WORKBUDDY_GLOBAL_PROVIDER } = await import('../src/adapter.ts')
  return {
    cn: await regionAdapter('cn', WORKBUDDY_PROVIDER, CN_ORIGIN),
    global: await regionAdapter('global', WORKBUDDY_GLOBAL_PROVIDER, GLOBAL_ORIGIN),
  }
}

describe('issue #75: the shared identity must resolve in the GLOBAL registry', () => {
  it('resolves a model stamped `workbuddy` in a global registry built the way the host builds it', async () => {
    const { WORKBUDDY_GLOBAL_PROVIDER, WORKBUDDY_MODEL_IDENTITY } = await import('../src/adapter.ts')
    const global = await regionAdapter('global', WORKBUDDY_GLOBAL_PROVIDER, GLOBAL_ORIGIN)
    const registry = await hostRegistry(global.profiles())

    // The global region's own models carry the shared identity — that is the
    // stamp the reporter's failing request carried.
    const routeProfile = global.profiles().get(WORKBUDDY_GLOBAL_PROVIDER)
    expect(routeProfile).toBeDefined()
    const served = routeProfile?.piProvider.getModels() ?? []
    expect(served).toHaveLength(1)
    expect(served[0]?.provider).toBe(WORKBUDDY_MODEL_IDENTITY)

    // THE FIX, observed where it counts. `requireProvider` is the exact frame
    // that raised the report's error, and it is fed the REAL model the region
    // serves — so a regression fails here with the outage itself, not with a
    // missing field: pre-fix this throws `Unknown provider: workbuddy`.
    const model = served[0]
    if (model === undefined) throw new Error('expected the global region to serve its model')
    // Resolution is BY the stamp, so it answers with whichever provider object
    // is registered under the identity — the global region's alias. What makes
    // that "the global one" is the destination it carries, not its id.
    const resolved = requireProvider(registry, model)
    expect(resolved.id).toBe(WORKBUDDY_MODEL_IDENTITY)
    expect(resolved.getModels()[0]?.baseUrl).toBe(`${GLOBAL_ORIGIN}/v1`)

    // The identity is therefore a resolvable key in the global registry.
    expect(registry.getModel(WORKBUDDY_MODEL_IDENTITY, 'hy3')).toBeDefined()

    // Dispatch enters the provider instead of throwing at the lookup. It fails
    // LATER — this registry holds no credential for the shim — which is the
    // proof that the lookup itself passed rather than the call never happening.
    const outcome = await dispatch(registry, model)
    expect(outcome.errorMessage).toBeDefined()
    expect(outcome.errorMessage ?? '').not.toMatch(/Unknown provider/)
  })

  it('still resolves in the CN registry, so the global alias did not come at CN\'s expense', async () => {
    const { WORKBUDDY_PROVIDER, WORKBUDDY_MODEL_IDENTITY } = await import('../src/adapter.ts')
    const cn = await regionAdapter('cn', WORKBUDDY_PROVIDER, CN_ORIGIN)
    const registry = await hostRegistry(cn.profiles())

    const model = registry.getModel(WORKBUDDY_MODEL_IDENTITY, 'hy3')
    expect(model).toBeDefined()
    expect(requireProvider(registry, model).id).toBe(WORKBUDDY_PROVIDER)

    const outcome = await dispatch(registry, model)
    expect(outcome.errorMessage ?? '').not.toMatch(/Unknown provider/)
  })

  it('CONTROL: a registry publishing ONLY the global route still fails with `Unknown provider: workbuddy`', async () => {
    // Without this, the two tests above could pass vacuously — e.g. if the
    // assertion were really about "no exception at all" or if `getModel` stopped
    // being key-scoped. This rebuilds the PRE-FIX registry by hand and pins the
    // exact reported failure, so the regression tests above cannot go green for
    // the wrong reason.
    const { WORKBUDDY_GLOBAL_PROVIDER, WORKBUDDY_MODEL_IDENTITY } = await import('../src/adapter.ts')
    const global = await regionAdapter('global', WORKBUDDY_GLOBAL_PROVIDER, GLOBAL_ORIGIN)
    const { createModels } = await import('@earendil-works/pi-ai')

    const routeOnly = global.profiles().get(WORKBUDDY_GLOBAL_PROVIDER)
    expect(routeOnly).toBeDefined()
    const models = createModels()
    models.setProvider(routeOnly?.piProvider as never)

    // The route key is there; the identity the models carry is NOT.
    expect(modelsUnder(models, WORKBUDDY_GLOBAL_PROVIDER)).toHaveLength(1)
    expect(modelsUnder(models, WORKBUDDY_MODEL_IDENTITY)).toHaveLength(0)

    const stamped = { id: 'hy3', api: 'openai-completions', provider: WORKBUDDY_MODEL_IDENTITY, baseUrl: global.baseUrl }
    expect(() => requireProvider(models, stamped)).toThrow(`Unknown provider: ${WORKBUDDY_MODEL_IDENTITY}`)

    // The same failure through the real dispatch path the host uses.
    //
    // `streamSimple` does NOT throw: it wraps setup in `lazyStream`
    // (`api/lazy.js:36–45`), which catches the rejection and terminates the
    // stream with `errorMessage = error.message` (`api/lazy.js:18`). So the
    // outage reaches the host — and the user — as this error STRING, not as a
    // thrown exception. Asserting a throw here would have passed on any
    // TypeError instead (e.g. a missing registry method) and pinned nothing;
    // asserting the exact string is what makes the control real.
    const outcome = await dispatch(models, stamped)
    expect(outcome.errorMessage).toBe(`Unknown provider: ${WORKBUDDY_MODEL_IDENTITY}`)
  })
})

describe('issue #75: the alias must not collapse the regions onto one shim', () => {
  it('keeps each region\'s route key, each region\'s models, and each region\'s baseUrl', async () => {
    const { WORKBUDDY_PROVIDER, WORKBUDDY_GLOBAL_PROVIDER } = await import('../src/adapter.ts')
    const { cn, global } = await bothRegions()

    // The ROUTE key is how DSH resolves and lists a request, so it must survive.
    expect(cn.profiles().has(WORKBUDDY_PROVIDER)).toBe(true)
    expect(global.profiles().has(WORKBUDDY_GLOBAL_PROVIDER)).toBe(true)

    // Each route's own provider object, pointed at that region's own shim.
    const cnModel = cn.profiles().get(WORKBUDDY_PROVIDER)?.piProvider.getModels()[0]
    const globalModel = global.profiles().get(WORKBUDDY_GLOBAL_PROVIDER)?.piProvider.getModels()[0]
    expect(cnModel?.baseUrl).toBe(`${CN_ORIGIN}/v1`)
    expect(globalModel?.baseUrl).toBe(`${GLOBAL_ORIGIN}/v1`)
    expect(cnModel?.baseUrl).not.toBe(globalModel?.baseUrl)
  })

  it('resolves the shared identity to the GLOBAL provider object, never the CN one', async () => {
    // One shared provider object would make "resolve the identity" trivially
    // true while silently routing every global request into the CN shim — the
    // same outage, one hop further out. Each region publishes its OWN provider;
    // only the id it answers under is shared.
    const { WORKBUDDY_MODEL_IDENTITY } = await import('../src/adapter.ts')
    const { cn, global } = await bothRegions()
    const registry = await hostRegistry(global.profiles())

    // Through the registry: the identity key must answer with the GLOBAL
    // provider, on the REAL model this region serves.
    const served = global.profiles().get('workbuddy-global')?.piProvider.getModels()[0]
    if (served === undefined) throw new Error('expected the global region to serve its model')
    const resolved = requireProvider(registry, served)
    expect(resolved.id).toBe(WORKBUDDY_MODEL_IDENTITY)
    expect(resolved.getModels()[0]?.baseUrl).toBe(`${GLOBAL_ORIGIN}/v1`)
    expect(registry.getModel(WORKBUDDY_MODEL_IDENTITY, 'hy3')?.baseUrl).toBe(`${GLOBAL_ORIGIN}/v1`)

    // And the alias entry must be a DISTINCT object from CN's provider: one
    // shared provider would make every lookup resolve while sending both
    // regions' traffic to the same shim.
    const identityKey = global.profiles().get(WORKBUDDY_MODEL_IDENTITY)
    expect(identityKey).toBeDefined()
    expect(identityKey?.piProvider.getModels()[0]?.baseUrl).toBe(`${GLOBAL_ORIGIN}/v1`)
    expect(identityKey?.piProvider).not.toBe(cn.profiles().get('workbuddy')?.piProvider)
  })

  it('registers exactly the keys each region needs, with the identity alias appearing once', async () => {
    // `setProvider` keys on the provider OBJECT's id, so the alias only exists
    // in the registry if a provider object answers under the identity id. The
    // CN route IS the identity, so CN must contribute no second provider —
    // one region, one provider, no duplicate publication.
    const { WORKBUDDY_PROVIDER, WORKBUDDY_MODEL_IDENTITY } = await import('../src/adapter.ts')
    const { cn, global } = await bothRegions()

    const cnRegistry = await hostRegistry(cn.profiles())
    const cnIds = cnRegistry.getProviders().map(provider => provider.id)
    expect([...new Set(cnIds)]).toEqual([WORKBUDDY_PROVIDER])
    expect(cnRegistry.getProviders()).toHaveLength(1)

    const globalRegistry = await hostRegistry(global.profiles())
    const globalIds = globalRegistry.getProviders().map(provider => provider.id)
    expect([...new Set(globalIds)].sort()).toEqual([WORKBUDDY_MODEL_IDENTITY, 'workbuddy-global'].sort())
    // One provider object per key: the alias is a second id, not a second copy
    // of the same entry.
    expect(new Set(globalIds).size).toBe(globalIds.length)
  })
})

describe('issue #75: issue #59\'s identity stamp is not regressed', () => {
  it('stamps ONE identity on the models of BOTH regions', async () => {
    const { WORKBUDDY_MODEL_IDENTITY } = await import('../src/adapter.ts')
    const { cn, global } = await bothRegions()

    const cnModel = cn.profiles().get('workbuddy')?.piProvider.getModels()[0]
    const globalModel = global.profiles().get('workbuddy-global')?.piProvider.getModels()[0]
    expect(cnModel?.provider).toBe(WORKBUDDY_MODEL_IDENTITY)
    expect(globalModel?.provider).toBe(WORKBUDDY_MODEL_IDENTITY)
    expect(cnModel?.provider).toBe(globalModel?.provider)
  })

  it('keeps a cross-region thinking block as `thinking`, in BOTH directions, using the real stamps', async () => {
    // Read the stamps off the live adapters rather than the constant: an alias
    // that quietly re-stamped a region's models with its route id would pass a
    // constant-based check and fail here.
    const { cn, global } = await bothRegions()
    const cnStamp = cn.profiles().get('workbuddy')?.piProvider.getModels()[0]?.provider
    const globalStamp = global.profiles().get('workbuddy-global')?.piProvider.getModels()[0]?.provider
    if (cnStamp === undefined || globalStamp === undefined) throw new Error('expected one model per region')
    const crossRegion: [string, string][] = [[cnStamp, globalStamp], [globalStamp, cnStamp]]

    for (const [recorded, replayed] of crossRegion) {
      const transformed = transformMessages(
        [assistantWithThinking(recorded, 'hy3', 'why I did that')] as never,
        requestModel(replayed) as never,
      )
      expect(blockTypes(transformed)).toEqual(['thinking', 'text'])
    }
  })
})

describe('issue #75: invalidate() must not undo the alias', () => {
  it('keeps the identity resolvable and the destinations separate after a catalog refresh', async () => {
    // `invalidate` rebuilds the published map. The pre-fix code rebuilt it from
    // the route key alone, so a refresh silently removed the alias and put the
    // region straight back into the outage — a regression that only shows up
    // after the user's first catalog update.
    const { WORKBUDDY_PROVIDER, WORKBUDDY_GLOBAL_PROVIDER, WORKBUDDY_MODEL_IDENTITY } =
      await import('../src/adapter.ts')
    const { cn, global } = await bothRegions()

    cn.invalidate()
    global.invalidate()

    for (const [region, route, origin] of [
      ['cn', WORKBUDDY_PROVIDER, CN_ORIGIN],
      ['global', WORKBUDDY_GLOBAL_PROVIDER, GLOBAL_ORIGIN],
    ] as const) {
      const adapter = region === 'cn' ? cn : global
      const registry = await hostRegistry(adapter.profiles())

      // (1) the identity still resolves, fed the REAL model this region
      // serves — pre-fix this is the frame that throws `Unknown provider`.
      const served = adapter.profiles().get(route)?.piProvider.getModels()[0]
      if (served === undefined) throw new Error(`expected ${String(region)} to serve its model`)
      const resolved = requireProvider(registry, served)
      expect(resolved.getModels()[0]?.baseUrl).toBe(`${origin}/v1`)
      expect(registry.getModel(WORKBUDDY_MODEL_IDENTITY, 'hy3')).toBeDefined()
      expect((await dispatch(registry, served)).errorMessage ?? '').not.toMatch(/Unknown provider/)

      // (3) and the region is still its own destination, on BOTH keys.
      expect(adapter.profiles().has(route)).toBe(true)
      expect(registry.getModels(route)[0]?.baseUrl).toBe(`${origin}/v1`)
      expect(registry.getModel(WORKBUDDY_MODEL_IDENTITY, 'hy3')?.baseUrl).toBe(`${origin}/v1`)
    }
  })
})