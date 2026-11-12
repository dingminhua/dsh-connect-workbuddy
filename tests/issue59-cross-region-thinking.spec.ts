import { describe, expect, it, vi } from 'vitest'
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'
import { foreignThinkingAsProse } from './foreign-thinking-helpers.ts'

/**
 * Issue #59, the plugin-side half of the fix: one model identity across two
 * regional route ids.
 *
 * THE DEFECT. pi-ai replays a historical thinking block as `thinking` only when
 * the message that produced it names the same provider, api and model id as the
 * request in flight (`api/transform-messages.js`, `isSameModel`). Everything
 * else stops being reasoning: rewritten to plain `text` up to pi-ai 1.2, and
 * discarded from 1.3 — which of the two is in effect is measured, not assumed
 * (see `tests/foreign-thinking-helpers.ts`). The two gateways are two provider
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
 * `getModels(provider).find(...)` (`models.js:78`), so the lookup key and the
 * stamped field are independent by construction.
 *
 * CORRECTED BY ISSUE #75. That independence is only half the contract. Chat
 * dispatch does not go through `getModel`: it goes through
 * `requireProvider(model)`, which looks the STAMPED field up as a registry key
 * (`models.js:351–355`) and throws `Unknown provider: workbuddy` when the stamp
 * names no registered provider. The global region stamped `workbuddy` while
 * publishing only the key `workbuddy-global`, so it was a total outage. The
 * identity must therefore ALSO be a key each region publishes — an alias onto
 * that region's own provider, never a shared one. The alias assertions below
 * live in `tests/issue75-global-provider-dispatch.spec.ts`; what this file
 * still owns is that the alias did not turn the shared identity into a shared
 * DESTINATION.
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
    // The DOWNGRADE itself is the premise, not the disposition: pi-ai must stop
    // treating this as the same model, and both the block type and the trailing
    // answer text are what it publishes afterwards. Up to 1.2 the reasoning was
    // rewritten into prose; 1.3+ discards it (tests/foreign-thinking-helpers.ts).
    expect(blockTypes(transformed)).toEqual([...foreignThinkingAsProse(), 'text'])
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

  it('KEEPS the thinking block across BOTH regional routes, in the shape the HOST produces', async () => {
    // ISSUE #102 — THE CASE THIS FILE MISSED FOR FOUR RELEASES.
    //
    // The previous version of this case looped `[['cn','global'], ['global','cn']]`
    // and then `void recorded; void replayed` — discarding both loop variables
    // and asserting identity ↔ identity on every iteration. It tested one thing
    // twice and never the thing it was named for, which is why #59 and #75
    // shipped green while global sessions still lost every historical thinking
    // block.
    //
    // The durable message the HOST replays does NOT carry the identity: the
    // agent loop writes `source.provider = request.provider`, i.e. the ROUTE id
    // (`workbuddy-global`), while the stamp the plugin put on the response is
    // the shared identity (`workbuddy`). pi-ai compares `assistantMsg.provider`
    // against `model.provider`, so route-vs-identity is a permanent mismatch and
    // every thinking block is downgraded to text on EVERY turn of a global
    // session — not only when the user switches regions.
    //
    // So the fixture now uses the real shape: a message recorded through a route,
    // replayed under the identity the adapter stamps.
    const { WORKBUDDY_MODEL_IDENTITY, WORKBUDDY_PROVIDERS, alignAssistantIdentities } =
      await import('../src/adapter.ts')
    for (const region of ['cn', 'global'] as const) {
      const route = WORKBUDDY_PROVIDERS[region]
      // The pipeline step under test: the adapter aligns the transcript BEFORE
      // pi-ai sees it, which is what turns a route-stamped history into a
      // replayable one.
      const aligned = alignAssistantIdentities(
        { messages: [assistantWithThinking(route, 'hy3', `thought from ${region}`)] } as never,
        WORKBUDDY_MODEL_IDENTITY,
      )
      const transformed = transformMessages(
        aligned.messages as never,
        // What the request in flight stamps: the shared identity.
        requestModel(WORKBUDDY_MODEL_IDENTITY) as never,
      )
      expect(blockTypes(transformed), `history recorded via ${route}`).toEqual(['thinking', 'text'])
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
    expect(blockTypes(transformed)).toEqual([...foreignThinkingAsProse(), 'text'])
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
  ) {
    const { adapter } = createWorkBuddyAdapter({
      shim: { baseUrl: () => baseUrl, token: async () => 'shared-secret' } as never,
      store: {} as never,
      catalog: catalog as never,
      provider,
    })
    return adapter as unknown as {
      config: { profiles: () => ReadonlyMap<string, { piProvider: { id: string, getModels: () => { id: string, provider: string, baseUrl: string }[] } }> }
    }
  }

  it('gives both regions the same stamped identity but each its own baseUrl', async () => {
    const { createWorkBuddyAdapter, WORKBUDDY_PROVIDER, WORKBUDDY_GLOBAL_PROVIDER, WORKBUDDY_MODEL_IDENTITY } =
      await import('../src/adapter.ts')

    const cn = adapterFor(
      createWorkBuddyAdapter, 'http://127.0.0.1:41000', WORKBUDDY_PROVIDER, await catalogWithOneModel('cn'),
    )
    const global = adapterFor(
      createWorkBuddyAdapter, 'http://127.0.0.1:42000', WORKBUDDY_GLOBAL_PROVIDER, await catalogWithOneModel('global'),
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

    // Each adapter still serves its OWN route, and the route is what the FIRST
    // key is: an adapter whose own route was demoted below the identity alias
    // would make the region look like it serves `workbuddy` first.
    //
    // Deliberately NOT asserted here: that neither map contains the other's
    // route id. The global map DOES contain `workbuddy` — as the issue #75
    // alias onto its OWN provider, never as a second destination. Membership
    // of a key is no longer evidence of a destination; the baseUrl of what a
    // key resolves to is. That is the next test's job.
    expect(cn.config.profiles().has(WORKBUDDY_PROVIDER)).toBe(true)
    expect(global.config.profiles().has(WORKBUDDY_GLOBAL_PROVIDER)).toBe(true)
    expect([...cn.config.profiles().keys()][0]).toBe(WORKBUDDY_PROVIDER)
    expect([...global.config.profiles().keys()][0]).toBe(WORKBUDDY_GLOBAL_PROVIDER)
  })

  it('also publishes the shared IDENTITY as a key, so the stamped field resolves', async () => {
    // Issue #75. The stamp alone was not enough: dispatch looks the STAMPED
    // field up as a registry key (`models.js:351–355`), so a region that
    // stamped the identity but published only its route key threw
    // `Unknown provider: workbuddy` on every request. Both regions must
    // therefore ALSO publish the identity — the CN route already IS the
    // identity, so it has exactly one key to publish.
    const { createWorkBuddyAdapter, WORKBUDDY_PROVIDER, WORKBUDDY_GLOBAL_PROVIDER, WORKBUDDY_MODEL_IDENTITY } =
      await import('../src/adapter.ts')
    const cn = adapterFor(
      createWorkBuddyAdapter, 'http://127.0.0.1:41000', WORKBUDDY_PROVIDER, await catalogWithOneModel('cn'),
    )
    const global = adapterFor(
      createWorkBuddyAdapter, 'http://127.0.0.1:42000', WORKBUDDY_GLOBAL_PROVIDER, await catalogWithOneModel('global'),
    )

    expect(cn.config.profiles().has(WORKBUDDY_MODEL_IDENTITY)).toBe(true)
    expect(global.config.profiles().has(WORKBUDDY_MODEL_IDENTITY)).toBe(true)

    // THE GUARD, restated against the alias itself: the identity entry is an
    // alias onto THAT region's own provider — same baseUrl, same region — and
    // not the other region's. Publishing the identity without this check is how
    // a fix for one outage would cause the other.
    const globalAlias = global.config.profiles().get(WORKBUDDY_MODEL_IDENTITY)
    expect(globalAlias).toBeDefined()
    expect(globalAlias?.piProvider.getModels()[0]?.baseUrl).toBe('http://127.0.0.1:42000/v1')
    expect(globalAlias?.piProvider.getModels()[0]?.baseUrl)
      .not.toBe('http://127.0.0.1:41000/v1')

    const cnAlias = cn.config.profiles().get(WORKBUDDY_MODEL_IDENTITY)
    expect(cnAlias?.piProvider.getModels()[0]?.baseUrl).toBe('http://127.0.0.1:41000/v1')

    // The CN route IS the identity, so CN must not publish the identity twice.
    expect([...cn.config.profiles().keys()]).toEqual([WORKBUDDY_PROVIDER])
  })
})

/**
 * Issue #102, the assertions that keep the fix from over-reaching.
 *
 * The alignment above is a blunt instrument — it rewrites `provider` on EVERY
 * historical assistant message. These cases state exactly how blunt it is
 * allowed to be.
 */
describe('issue #102: alignAssistantIdentities boundaries', () => {
  it('leaves user and toolResult messages completely alone', async () => {
    const { WORKBUDDY_MODEL_IDENTITY, alignAssistantIdentities } = await import('../src/adapter.ts')
    // Only an ASSISTANT message carries the provider that pi-ai compares. A
    // user message has none, and a toolResult's `toolName` is matched by name,
    // not by provider — rewriting those would be noise at best.
    const messages = [
      { role: 'user', content: 'hi', timestamp: 0 },
      { role: 'toolResult', toolCallId: 'x', toolName: 't', content: [], isError: false, timestamp: 0 },
    ]
    const context = { messages } as never
    const out = alignAssistantIdentities(context, WORKBUDDY_MODEL_IDENTITY)
    // Same object back: with no assistant message to rewrite, the aligner must
    // not allocate on the request path.
    expect(out).toBe(context)
    expect(out.messages).toEqual(messages as never)
  })

  it('returns the SAME context object when every assistant message already matches', async () => {
    // The common case, now that the aligner runs on every request: an
    // already-aligned transcript must not allocate a new array per turn.
    const { WORKBUDDY_MODEL_IDENTITY, alignAssistantIdentities } = await import('../src/adapter.ts')
    const context = { messages: [assistantWithThinking(WORKBUDDY_MODEL_IDENTITY, 'hy3', 'x')] } as never
    expect(alignAssistantIdentities(context, WORKBUDDY_MODEL_IDENTITY)).toBe(context)
  })

  it('repairs ONLY the host fallback api — a native api is left byte-identical', async () => {
    const { WORKBUDDY_MODEL_IDENTITY, alignAssistantIdentities } = await import('../src/adapter.ts')
    // `api` is repaired only when it carries the HOST's own fallback marker. A
    // message already in this plugin's real wire shape must come back untouched:
    // rewriting it would claim a shape that message was never built for.
    const original = assistantWithThinking('workbuddy-global', 'hy3', 'x') as Record<string, unknown>
    const out = alignAssistantIdentities({ messages: [original] } as never, WORKBUDDY_MODEL_IDENTITY)
    const rewritten = (out.messages as unknown as Record<string, unknown>[])[0]
    expect(rewritten?.['provider']).toBe(WORKBUDDY_MODEL_IDENTITY)
    expect(rewritten?.['api']).toBe('openai-completions')
    expect(rewritten?.['model']).toBe('hy3')
    // And nothing else moved: the same chunk count, the same text.
    expect(blockTypes(out.messages)).toEqual(['thinking', 'text'])
  })

  it('KEEPS the thinking block for the shape the host actually replays (issue #102, second half)', async () => {
    // THE CASE 5.2.3 STILL MISSED. `dsh-llm-pi-ai` does not hand pi-ai the
    // message's recorded api: `replayedAssistant` rejects a provider mismatch
    // and falls back to `foreignAssistant()`, which stamps `api:'dsh-foreign'`
    // and `provider: source.provider` (the ROUTE id). So a global transcript is
    // not merely provider-mismatched — it also carries an api this plugin never
    // sends, and `isSameModel` fails on BOTH comparisons.
    //
    // Measured on a real 0.2.1-rc.2 global session: aligning `provider` alone
    // still flattened a 1514-character thinking block into 1514 characters of
    // assistant TEXT, which is exactly the reported symptom (working notes in
    // the answer channel, reasoning row collapsed to one character).
    const { WORKBUDDY_MODEL_IDENTITY, alignAssistantIdentities } = await import('../src/adapter.ts')
    const foreign = {
      ...(assistantWithThinking('workbuddy-global', 'hy3', 'why I did that') as Record<string, unknown>),
      api: 'dsh-foreign',
      content: [
        // `foreignAssistant()` builds thinking blocks with NO signature.
        { type: 'thinking', thinking: 'why I did that' },
        { type: 'text', text: 'here is the answer' },
      ],
    }
    const aligned = alignAssistantIdentities({ messages: [foreign] } as never, WORKBUDDY_MODEL_IDENTITY)
    const transformed = transformMessages(
      aligned.messages as never,
      requestModel(WORKBUDDY_MODEL_IDENTITY) as never,
    )
    expect(blockTypes(transformed)).toEqual(['thinking', 'text'])
    const first = (transformed as { content: { thinking?: string }[] }[])[0]
    expect(first?.content[0]?.thinking).toBe('why I did that')
  })

  it('repairs the foreign api even when the provider already matches', async () => {
    // The repair is two independent fields: an already-aligned provider must not
    // short-circuit the api fix, and a foreign api must not drag the provider
    // anywhere on its own.
    const { WORKBUDDY_MODEL_IDENTITY, alignAssistantIdentities } = await import('../src/adapter.ts')
    const context = {
      messages: [{ ...(assistantWithThinking(WORKBUDDY_MODEL_IDENTITY, 'hy3', 'x') as Record<string, unknown>), api: 'dsh-foreign' }],
    } as never
    const out = alignAssistantIdentities(context, WORKBUDDY_MODEL_IDENTITY)
    const rewritten = (out.messages as unknown as Record<string, unknown>[])[0]
    expect(rewritten?.['provider']).toBe(WORKBUDDY_MODEL_IDENTITY)
    expect(rewritten?.['api']).toBe('openai-completions')
    expect(blockTypes(out.messages)).toEqual(['thinking', 'text'])
  })

  it('still lets a DIFFERENT model id degrade, so the fix cannot hide a real switch', async () => {
    const { WORKBUDDY_MODEL_IDENTITY, alignAssistantIdentities } = await import('../src/adapter.ts')
    // #102's fix must not become "#59 reverted the other way": a transcript
    // whose model id genuinely differs is a different model, and its thinking
    // signature is not valid there.
    const aligned = alignAssistantIdentities(
      { messages: [assistantWithThinking('workbuddy-global', 'hy3', 'x')] } as never,
      WORKBUDDY_MODEL_IDENTITY,
    )
    const transformed = transformMessages(
      aligned.messages as never,
      requestModel(WORKBUDDY_MODEL_IDENTITY, 'other-model') as never,
    )
    expect(blockTypes(transformed)).toEqual([...foreignThinkingAsProse(), 'text'])
  })

  it('tolerates a malformed entry instead of throwing mid-request', async () => {
    const { WORKBUDDY_MODEL_IDENTITY, alignAssistantIdentities } = await import('../src/adapter.ts')
    // This runs on the request path; a throw here would cost the whole turn.
    const out = alignAssistantIdentities(
      { messages: [null, 'nonsense', assistantWithThinking('workbuddy-global', 'hy3', 'x')] } as never,
      WORKBUDDY_MODEL_IDENTITY,
    )
    expect((out.messages as unknown[]).length).toBe(3)
    expect(blockTypes([(out.messages as unknown[])[2]])).toEqual(['thinking', 'text'])
  })
})
