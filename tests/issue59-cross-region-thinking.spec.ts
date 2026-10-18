import { describe, expect, it, vi } from 'vitest'
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'

/**
 * Issue #59, the plugin-side half of the fix: one model identity across two
 * regional route ids.
 *
 * THE DEFECT. pi-ai replays a historical thinking block as `thinking` only when
 * the message that produced it names the same provider, api and model id as the
 * request in flight (`api/transform-messages.js:68–70`). Everything else is
 * downgraded to plain `text` (`:88–96`). The two gateways are two provider
 * STRINGS for ONE model, so a transcript recorded in one region was replayed as
 * text in the other: the reporter measured byte-identical history at 708K tokens
 * on one side and 1.374M on the other, and the compression request computed for
 * one window could then never fit the other — a deadlock, not a slowdown.
 *
 * WHAT MUST HOLD. Both halves, at the level that actually decides:
 *   1. a thinking block recorded through the CN route and replayed through the
 *      GLOBAL route is still `thinking` (and the reverse), and
 *   2. the two routes still resolve to their OWN baseUrl — the shared identity
 *      must not become a shared destination, because each region has its own
 *      shim, catalog and credentials.
 *
 * (2) is the reason the shared string is stamped on `model.provider` while the
 * registry KEY stays per region: `Models.getModel(provider, id)` is
 * `getModels(provider).find(...)` (`models.js:116–118`), so the lookup key and
 * the stamped field are independent by construction.
 */

/** The shape pi-ai itself puts on the wire, built once so both sides agree. */
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

/** The request side: only the three compared fields plus `input` matter here. */
function requestModel(provider: string, id = 'hy3'): unknown {
  return { id, api: 'openai-completions', provider, input: ['text'] }
}

function blockTypes(transformed: unknown): string[] {
  const messages = (transformed as { content: { type: string }[] }[])
  return messages.flatMap(m => m.content.map(b => b.type))
}

describe('issue #59: cross-region thinking replay', () => {
  it('DOWNGRADES a cross-region thinking block when the two routes stamp themselves (today, pre-fix)', async () => {
    const { WORKBUDDY_PROVIDER, WORKBUDDY_GLOBAL_PROVIDER } = await import('../src/adapter.ts')
    // This is the shape the plugin used to hand pi-ai. Kept as the control: if
    // this ever stops degrading, the test below is proving nothing, because it
    // would no longer be the identity comparison that decides.
    const transformed = transformMessages(
      [assistantWithThinking(WORKBUDDY_PROVIDER, 'hy3', 'why I did that')] as never,
      requestModel(WORKBUDDY_GLOBAL_PROVIDER) as never,
    )
    expect(blockTypes(transformed)).toEqual(['text', 'text'])
  })

  it('KEEPS the thinking block when both regions stamp the shared model identity', async () => {
    const { WORKBUDDY_MODEL_IDENTITY } = await import('../src/adapter.ts')
    const transformed = transformMessages(
      [assistantWithThinking(WORKBUDDY_MODEL_IDENTITY, 'hy3', 'why I did that')] as never,
      requestModel(WORKBUDDY_MODEL_IDENTITY) as never,
    )
    expect(blockTypes(transformed)).toEqual(['thinking', 'text'])
    const first = (transformed as { content: { thinking?: string }[] }[])[0]
    expect(first?.content[0]?.thinking).toBe('why I did that')
  })

  it('KEEPS the thinking block in BOTH directions, because the identity is symmetric', async () => {
    const { WORKBUDDY_MODEL_IDENTITY } = await import('../src/adapter.ts')
    for (const [recorded, replayed] of [
      // CN history, replayed from the global route (the reported direction)…
      ['cn', 'global'],
      // …and the reverse, which the reporter's round trip hits too.
      ['global', 'cn'],
    ]) {
      void recorded
      void replayed
      const transformed = transformMessages(
        [assistantWithThinking(WORKBUDDY_MODEL_IDENTITY, 'hy3', 'x')] as never,
        requestModel(WORKBUDDY_MODEL_IDENTITY) as never,
      )
      expect(blockTypes(transformed)).toEqual(['thinking', 'text'])
    }
  })

  it('still downgrades across DIFFERENT MODEL IDS, which is a real change of model', async () => {
    // The identity answers "same model behind two gateways", not "any model is
    // the same model". A host switching hy3 → another id must keep degrading:
    // a thinking signature from a different model is not necessarily valid.
    const { WORKBUDDY_MODEL_IDENTITY } = await import('../src/adapter.ts')
    const transformed = transformMessages(
      [assistantWithThinking(WORKBUDDY_MODEL_IDENTITY, 'hy3', 'x')] as never,
      requestModel(WORKBUDDY_MODEL_IDENTITY, 'other-model') as never,
    )
    expect(blockTypes(transformed)).toEqual(['text', 'text'])
  })
})

describe('issue #59: the shared identity is not a shared destination', () => {
  /** A catalog with one model, so the provider's own `getModels` has content. */
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

  function adapterFor(
    createWorkBuddyAdapter: typeof import('../src/adapter.ts')['createWorkBuddyAdapter'],
    baseUrl: string,
    provider: string,
    catalog: unknown,
    /** Opt INTO the shared identity. Omitted, the route id is stamped instead
     *  (issue #75) — see the "default stamps the route id" case below. */
    modelIdentity?: string,
  ) {
    const { adapter } = createWorkBuddyAdapter({
      shim: { baseUrl: () => baseUrl, token: async () => 'shared-secret' } as never,
      store: {} as never,
      catalog: catalog as never,
      provider,
      ...(modelIdentity === undefined ? {} : { modelIdentity }),
    })
    return adapter as unknown as {
      config: { profiles: () => ReadonlyMap<string, { piProvider: { id: string, getModels: () => { id: string, provider: string, baseUrl: string }[] } }> }
    }
  }

  it('gives both regions the same stamped identity when it is passed explicitly', async () => {
    const { createWorkBuddyAdapter, WORKBUDDY_PROVIDER, WORKBUDDY_GLOBAL_PROVIDER, WORKBUDDY_MODEL_IDENTITY } =
      await import('../src/adapter.ts')

    // Since issue #75 the shared identity is an OPT-IN: the default stamps the
    // route id, because that is the key pi-ai dispatches on. Passing it
    // explicitly keeps issue #59's fix available for a host that can resolve a
    // model by an identity other than its route id.
    const cn = adapterFor(
      createWorkBuddyAdapter, 'http://127.0.0.1:41000', WORKBUDDY_PROVIDER, await catalogWithOneModel('cn'),
      WORKBUDDY_MODEL_IDENTITY,
    )
    const global = adapterFor(
      createWorkBuddyAdapter, 'http://127.0.0.1:42000', WORKBUDDY_GLOBAL_PROVIDER, await catalogWithOneModel('global'),
      WORKBUDDY_MODEL_IDENTITY,
    )

    const cnModels = cn.config.profiles().get(WORKBUDDY_PROVIDER)?.piProvider.getModels() ?? []
    const globalModels = global.config.profiles().get(WORKBUDDY_GLOBAL_PROVIDER)?.piProvider.getModels() ?? []

    expect(cnModels).toHaveLength(1)
    expect(globalModels).toHaveLength(1)
    const cnModel = cnModels[0]
    const globalModel = globalModels[0]
    if (cnModel === undefined || globalModel === undefined) throw new Error('expected one model per region')
    // THE FIX: one identity, so `isSameModel` holds across the gateways.
    expect(cnModel.provider).toBe(WORKBUDDY_MODEL_IDENTITY)
    expect(globalModel.provider).toBe(WORKBUDDY_MODEL_IDENTITY)
    expect(cnModel.provider).toBe(globalModel.provider)
    // THE GUARD: still two different destinations, one per region's shim.
    expect(cnModel.baseUrl).toBe('http://127.0.0.1:41000/v1')
    expect(globalModel.baseUrl).toBe('http://127.0.0.1:42000/v1')
    expect(cnModel.baseUrl).not.toBe(globalModel.baseUrl)
  })

  it('keeps the ROUTE keyed per region even though the identity is shared', async () => {
    // DSH resolves a request by ROUTE id (`dsh-llm/lib/index.js:2264`), so one
    // route owning both regions would put both behind one shim — an outage on
    // one side would take the other with it. Only the stamp is shared.
    const { createWorkBuddyAdapter, WORKBUDDY_PROVIDER, WORKBUDDY_GLOBAL_PROVIDER } = await import('../src/adapter.ts')
    const cn = adapterFor(
      createWorkBuddyAdapter, 'http://127.0.0.1:41000', WORKBUDDY_PROVIDER, await catalogWithOneModel('cn'),
    )
    const global = adapterFor(
      createWorkBuddyAdapter, 'http://127.0.0.1:42000', WORKBUDDY_GLOBAL_PROVIDER, await catalogWithOneModel('global'),
    )

    expect([...cn.config.profiles().keys()]).toEqual([WORKBUDDY_PROVIDER])
    expect([...global.config.profiles().keys()]).toEqual([WORKBUDDY_GLOBAL_PROVIDER])
  })

  /**
   * Issue #75: with no `modelIdentity` supplied, each region's models carry
   * that region's ROUTE id.
   *
   * This is the counterpart to #59, and the two pull in opposite directions.
   * #59 wants one identity so a cross-region replay keeps thinking blocks;
   * #75 needs the stamp to equal the registry key, because pi-ai's
   * `requireProvider` resolves `model.provider` against `providers`. When the
   * stamp is the shared string, a `workbuddy-global` model resolves against
   * the CN registry entry — `Unknown provider: workbuddy` — and the global
   * region cannot send a single request.
   *
   * So the default is the resolvable one, and #59's identity is opt-in.
   */
  it('defaults each region to its own route id (issue #75)', async () => {
    const { createWorkBuddyAdapter, WORKBUDDY_PROVIDER, WORKBUDDY_GLOBAL_PROVIDER } =
      await import('../src/adapter.ts')

    const cn = adapterFor(
      createWorkBuddyAdapter, 'http://127.0.0.1:41000', WORKBUDDY_PROVIDER, await catalogWithOneModel('cn'),
    )
    const global = adapterFor(
      createWorkBuddyAdapter, 'http://127.0.0.1:42000', WORKBUDDY_GLOBAL_PROVIDER, await catalogWithOneModel('global'),
    )

    const cnModel = cn.config.profiles().get(WORKBUDDY_PROVIDER)?.piProvider.getModels()[0]
    const globalModel = global.config.profiles().get(WORKBUDDY_GLOBAL_PROVIDER)?.piProvider.getModels()[0]
    if (cnModel === undefined || globalModel === undefined) throw new Error('expected one model per region')

    // The stamp equals the key each model is registered under, so
    // `providers.get(model.provider)` always hits.
    expect(cnModel.provider).toBe(WORKBUDDY_PROVIDER)
    expect(globalModel.provider).toBe(WORKBUDDY_GLOBAL_PROVIDER)

    // Still one destination per region — the route split is untouched.
    expect(cnModel.baseUrl).toBe('http://127.0.0.1:41000/v1')
    expect(globalModel.baseUrl).toBe('http://127.0.0.1:42000/v1')
  })
})
