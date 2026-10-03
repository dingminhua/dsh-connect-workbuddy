import { describe, expect, it, vi } from 'vitest'
import { workBuddyDisplayName, workBuddyModelInput, workBuddyThinkingLevelMap } from '../src/adapter.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

/**
 * The stream API is stubbed so the WIRING can be asserted.
 *
 * Without this, every adaptation test passes by calling the pure function
 * directly and stays green even when `withLegacyContext(...)` is removed from
 * the provider — a mutant that restores issue #24 exactly. Recorded contexts
 * prove the wrapper is actually in the path.
 */
const receivedContexts: unknown[] = []
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({
    stream: (_model: unknown, context: unknown) => { receivedContexts.push(context); return emptyStream() },
    streamSimple: (_model: unknown, context: unknown) => { receivedContexts.push(context); return emptyStream() },
  }),
}))

/** A stream that yields nothing; the assertions are about the CONTEXT passed in. */
function emptyStream(): AsyncIterable<never> {
  return { [Symbol.asyncIterator]: async function* () { /* no events */ } }
}

function model(reasoning?: WorkBuddyModelInfo['reasoning'], multimodal?: boolean): WorkBuddyModelInfo {
  return {
    id: 'test',
    name: 'Test',
    contextWindow: 200_000,
    maxTokens: 32_000,
    ...multimodal === undefined ? {} : { multimodal },
    ...reasoning === undefined ? {} : { reasoning },
  }
}

describe('workBuddyModelInput', () => {
  it('offers images only for models the user opted into image input', () => {
    expect(workBuddyModelInput(model(undefined, true))).toEqual(['text', 'image'])
    expect(workBuddyModelInput(model(undefined, false))).toEqual(['text'])
    expect(workBuddyModelInput(model())).toEqual(['text'])
  })
})

describe('workBuddyDisplayName', () => {
  it('spells the credit multiplier the way WorkBuddy own selector does', () => {
    expect(workBuddyDisplayName({ ...model(), creditMultiplier: 0.79 })).toBe('Test · x0.79')
    expect(workBuddyDisplayName({ ...model(), creditMultiplier: 0.05 })).toBe('Test · x0.05')
    expect(workBuddyDisplayName({ ...model(), creditMultiplier: 0 })).toBe('Test · x0.00')
  })

  it('keeps the bare name when no multiplier was parsed', () => {
    expect(workBuddyDisplayName(model())).toBe('Test')
  })
})

describe('workBuddyThinkingLevelMap', () => {
  it('maps only upstream-advertised levels to identical wire values', () => {
    expect(workBuddyThinkingLevelMap(model({
      supportedEfforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'high',
      canDisableThinking: true,
    }))).toEqual({
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: 'xhigh',
      max: null,
    })
  })

  it('does not expose off when WorkBuddy says thinking cannot be disabled', () => {
    expect(workBuddyThinkingLevelMap(model({
      supportedEfforts: ['high'],
      canDisableThinking: false,
    }))).toMatchObject({ off: null, high: 'high' })
  })

  it('does not report reasoning without supported effort levels', () => {
    expect(workBuddyThinkingLevelMap(model())).toBeUndefined()
    expect(workBuddyThinkingLevelMap(model({ canDisableThinking: true }))).toBeUndefined()
  })

  it('drops unknown upstream effort spellings', () => {
    expect(workBuddyThinkingLevelMap(model({ supportedEfforts: ['unknown'] }))).toBeUndefined()
  })

  it('exposes the full ladder and off for singular-effort models (issue #7)', () => {
    // The shape parseReasoning folds `{"effort": "high"}` into: the gateways
    // accept the whole ladder on these models and default to thinking off,
    // so every level maps through and `off` stays available.
    const map = workBuddyThinkingLevelMap(model({
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      canDisableThinking: true,
    }))
    expect(map).toEqual({
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    })
    expect(map?.off).toBeUndefined()
  })
})

describe('createWorkBuddyAdapter provider profile', () => {
  /** A shim stub: the adapter only ever asks it for the loopback origin and its secret. */
  function shimStub() {
    return { baseUrl: () => 'http://127.0.0.1:1', token: async () => 'shared-secret' }
  }

  it('carries an empty modelErrors map on the host line that requires it', async () => {
    // `ResolvedPiAiProviderProfile.modelErrors` became required in 0.1.5-rc.1
    // and is read on every request by `PiAiAdapter.modelOf`, which throws
    // INVALID_CONFIG for any model id the map lists. The workbuddy catalog is
    // built from live upstream reads, so the correct value is an EMPTY map:
    // a non-empty one would pre-condemn models the catalog supplies later.
    const { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } = await import('../src/adapter.ts')
    const { WorkBuddyCatalog } = await import('../src/catalog.ts')

    const { adapter } = createWorkBuddyAdapter({
      shim: shimStub() as never,
      store: {} as never,
      catalog: new WorkBuddyCatalog(),
    })

    const profile = (adapter as unknown as { config: { profiles: () => ReadonlyMap<string, { modelErrors: Map<string,string>; provider: string; displayName: string }> } }).config.profiles().get(WORKBUDDY_PROVIDER)
    expect(profile).toBeDefined()
    expect(profile?.modelErrors).toBeInstanceOf(Map)
    expect(profile?.modelErrors.size).toBe(0)
    expect(profile?.provider).toBe(WORKBUDDY_PROVIDER)
    expect(profile?.displayName).toBe('WorkBuddy')
  })
})

/**
 * Issue #24: pi-ai 0.87's `normalizeContext` moves the system prompt into
 * `messages` as `{ role: 'system', content: '<string>' }`. pi-ai 0.85's own
 * `Message` union has no `system` variant, so its `estimateMessageTokens`
 * iterates the CONTENT STRING character by character and `block.name.length`
 * throws `Cannot read properties of undefined (reading 'length')` — before any
 * request is built, so every model fails instantly.
 *
 * Reproduced on this machine against the exact pi-ai copy the plugin resolves
 * (0.85.1): the same context below raised that TypeError, and raising it here
 * would mean the request never leaves the process.
 */
describe('adaptLegacyPiAiContext', () => {
  /** What pi-ai 0.87's normalizeContext produces. */
  const normalized = () => ({
    messages: [
      { role: 'system', content: 'You are helpful.', toolsAdded: [], timestamp: 0 },
      { role: 'user', content: 'hi', timestamp: 0 },
    ],
  })

  it('folds a string system message back into systemPrompt', async () => {
    const { adaptLegacyPiAiContext } = await import('../src/adapter.ts')
    const adapted = adaptLegacyPiAiContext(normalized() as never)
    expect(adapted.systemPrompt).toBe('You are helpful.')
    // The system entry must be GONE from messages: leaving it in is exactly
    // what makes 0.85 iterate the string and throw.
    expect(adapted.messages).toHaveLength(1)
    expect((adapted.messages[0] as { role: string }).role).toBe('user')
  })

  it('joins several system messages rather than dropping the later ones', async () => {
    const { adaptLegacyPiAiContext } = await import('../src/adapter.ts')
    const adapted = adaptLegacyPiAiContext({
      messages: [
        { role: 'system', content: 'First.', timestamp: 0 },
        { role: 'system', content: 'Second.', timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
      ],
    } as never)
    expect(adapted.systemPrompt).toBe('First.\n\nSecond.')
    expect(adapted.messages).toHaveLength(1)
  })

  it('reads text blocks, because 0.87 can emit block content too', async () => {
    const { adaptLegacyPiAiContext } = await import('../src/adapter.ts')
    const adapted = adaptLegacyPiAiContext({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Sys A' }, { type: 'text', text: 'Sys B' }], timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
      ],
    } as never)
    expect(adapted.systemPrompt).toBe('Sys A\n\nSys B')
    expect(adapted.messages).toHaveLength(1)
  })

  it('is an IDENTITY on the native 0.85 shape', async () => {
    // This is the load-bearing property: a host that is still on 0.85 must take
    // a byte-for-byte unchanged path, so the fix cannot regress the setup that
    // works today. Same object, not merely an equal one.
    const { adaptLegacyPiAiContext } = await import('../src/adapter.ts')
    const legacy = { systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [] }
    expect(adaptLegacyPiAiContext(legacy as never)).toBe(legacy)
  })

  it('is an identity when there is no history to repair at all', async () => {
    // The identity property now holds only where nothing needs fixing: with a
    // user-first history the adapter MUST change the context (see below), since
    // the international gateway refuses a request that does not open with a
    // system message.
    const { adaptLegacyPiAiContext } = await import('../src/adapter.ts')
    const empty = { messages: [] }
    expect(adaptLegacyPiAiContext(empty as never)).toBe(empty)
    const noArray = { messages: 'not-an-array' }
    expect(adaptLegacyPiAiContext(noArray as never)).toBe(noArray)
  })

  it('treats an EMPTY systemPrompt as absent, so a real system message survives', async () => {
    // pi-ai emits the prompt under `if (context.systemPrompt)`, so '' emits no
    // system message AND pi-ai demotes the `system` entry still sitting in
    // `messages` to `user` — a wire body that opens with `user`, which the
    // international gateway rejects (11128). Treating '' as "already set" would
    // skip the fold and lose the real prompt; the fold preserves it.
    const { adaptLegacyPiAiContext } = await import('../src/adapter.ts')
    const adapted = adaptLegacyPiAiContext({
      systemPrompt: '',
      messages: [
        { role: 'system', content: 'The real prompt', timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
      ],
    } as never)
    expect(adapted.systemPrompt).toBe('The real prompt')
    expect(adapted.messages).toHaveLength(1)
  })

  it('supplies a fallback system message when nothing else carries one', async () => {
    // A request with no system message at all reaches the gateway as user-first
    // and is refused there; a minimal placeholder is strictly better than a
    // guaranteed 400.
    const { adaptLegacyPiAiContext } = await import('../src/adapter.ts')
    const { WORKBUDDY_FALLBACK_SYSTEM_PROMPT } = await import('../src/upstream.ts')
    const adapted = adaptLegacyPiAiContext({
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    } as never)
    expect(adapted.systemPrompt).toBe(WORKBUDDY_FALLBACK_SYSTEM_PROMPT)
    expect(adapted.messages).toHaveLength(1)
  })

  it('keeps tools and unrelated context fields', async () => {
    // A top-level `tools` array is authoritative for the caller's shape: the
    // fold must never overwrite it with anything harvested from messages.
    const { adaptLegacyPiAiContext } = await import('../src/adapter.ts')
    const adapted = adaptLegacyPiAiContext({
      ...normalized(),
      tools: [{ name: 't' }],
    } as never) as { tools?: unknown[] }
    expect(adapted.tools).toEqual([{ name: 't' }])
  })

  it('promotes toolsAdded from the folded system message into context.tools', async () => {
    // Issue #26: pi-ai 0.87's normalizeContext deletes the top-level `tools`
    // field and carries the declarations ONLY as `toolsAdded` on the leading
    // system message — which 0.85's api never reads (it looks at
    // `context.tools` exclusively). Folding the text without promoting the
    // tools traded #24's loud crash for #26's silent one: requests with no
    // tool declarations, so no model can ever emit a toolCall.
    const { adaptLegacyPiAiContext } = await import('../src/adapter.ts')
    const adapted = adaptLegacyPiAiContext({
      messages: [
        { role: 'system', content: 'You are helpful.', toolsAdded: [{ name: 'pwsh' }], timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
      ],
    } as never) as { systemPrompt?: string, tools?: { name: string }[] }
    expect(adapted.tools).toEqual([{ name: 'pwsh' }])
    expect(adapted.systemPrompt).toBe('You are helpful.')
  })

  it('replays toolsRemoved then toolsAdded across system messages', async () => {
    // The merge mirrors pi-ai 0.87's own getCurrentTools: removals before
    // additions, keyed by name, so a mid-conversation redeclaration replaces
    // the original and a removal drops the earlier declaration.
    const { adaptLegacyPiAiContext } = await import('../src/adapter.ts')
    const adapted = adaptLegacyPiAiContext({
      messages: [
        { role: 'system', content: 'Base.', toolsAdded: [{ name: 'a' }, { name: 'b' }], timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
        { role: 'system', content: '', toolsRemoved: [{ name: 'a' }], toolsAdded: [{ name: 'c' }], timestamp: 1 },
      ],
    } as never) as { tools?: { name: string }[] }
    expect(adapted.tools?.map(tool => tool.name)).toEqual(['b', 'c'])
  })

  it('sets no tools when the folded system messages declared none', async () => {
    const { adaptLegacyPiAiContext } = await import('../src/adapter.ts')
    const adapted = adaptLegacyPiAiContext(normalized() as never) as { tools?: unknown[] }
    expect(adapted.tools).toBeUndefined()
  })

  it('never leaves systemPrompt as an empty string', async () => {
    // A system entry whose content carries no text has nothing to preserve, but
    // it must still leave `messages` (else 0.85 crashes); `systemPrompt` stays
    // ABSENT rather than '' so no provider is handed an empty system message.
    const { adaptLegacyPiAiContext } = await import('../src/adapter.ts')
    const adapted = adaptLegacyPiAiContext({
      messages: [
        { role: 'system', content: [{ type: 'image', data: 'x' }], timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
      ],
    } as never)
    expect(adapted.systemPrompt).toBeUndefined()
    expect(adapted.messages).toHaveLength(1)
  })
})

/**
 * The WIRING, not the helper.
 *
 * Mutating the adapter to call `openAICompletionsApi()` directly — i.e. undoing
 * the fix — must fail something. It did not, until this test existed: every
 * assertion above calls `adaptLegacyPiAiContext` itself, so none of them notice
 * that the wrapper is gone from the provider.
 *
 * The gate has two branches and each is pinned by its own test: the legacy
 * branch must fold (issue #24's crash returns without it), the modern branch
 * must NOT fold (issues #25/#26: folding deletes the only carrier of the
 * prompt and the tool declarations), and the default must follow whatever
 * generation this plugin actually resolves.
 */
describe('the provider stream actually receives an adapted context', () => {
  it('folds the 0.87 system message (and promotes its tools) before the LEGACY api sees it', async () => {
    receivedContexts.length = 0
    const { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } = await import('../src/adapter.ts')
    const { WorkBuddyCatalog } = await import('../src/catalog.ts')

    const { adapter } = createWorkBuddyAdapter({
      shim: { baseUrl: () => 'http://127.0.0.1:1', token: async () => 'shared-secret' } as never,
      store: {} as never,
      catalog: new WorkBuddyCatalog(),
      piAiGeneration: 'legacy',
    })
    const profile = (adapter as unknown as {
      config: { profiles: () => ReadonlyMap<string, { piProvider: { streamSimple: (m: unknown, c: unknown, o: unknown) => unknown } }> }
    }).config.profiles().get(WORKBUDDY_PROVIDER)
    expect(profile).toBeDefined()

    const normalized = {
      messages: [
        { role: 'system', content: 'You are helpful.', toolsAdded: [{ name: 'pwsh' }], timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
      ],
    }
    profile?.piProvider.streamSimple(
      { id: 'hy3', api: 'openai-completions', provider: WORKBUDDY_PROVIDER },
      normalized,
      { apiKey: 'k' },
    )

    expect(receivedContexts).toHaveLength(1)
    const seen = receivedContexts[0] as { systemPrompt?: string, tools?: { name: string }[], messages: { role: string }[] }
    // THE assertion: the api must not be handed the system entry it cannot
    // read — and must be handed BOTH things that entry carried.
    expect(seen.systemPrompt).toBe('You are helpful.')
    expect(seen.tools).toEqual([{ name: 'pwsh' }])
    expect(seen.messages.some(m => m.role === 'system')).toBe(false)
  })

  it('passes the transcript through byte-for-byte on a MODERN pi-ai', async () => {
    // A 0.87+ api consumes the normalized transcript natively: the prompt
    // lives on the leading system message and the tools on its `toolsAdded`.
    // Any fold here would delete the only carrier of both — the reported
    // #26 symptom (models that can never call tools) and #25's 400 on the
    // international gateway. Same object reference, not merely an equal one.
    receivedContexts.length = 0
    const { createWorkBuddyAdapter, WORKBUDDY_GLOBAL_PROVIDER } = await import('../src/adapter.ts')
    const { WorkBuddyCatalog } = await import('../src/catalog.ts')

    const { adapter } = createWorkBuddyAdapter({
      shim: { baseUrl: () => 'http://127.0.0.1:1', token: async () => 'shared-secret' } as never,
      store: {} as never,
      catalog: new WorkBuddyCatalog(),
      provider: WORKBUDDY_GLOBAL_PROVIDER,
      piAiGeneration: 'modern',
    })
    const profile = (adapter as unknown as {
      config: { profiles: () => ReadonlyMap<string, { piProvider: { streamSimple: (m: unknown, c: unknown, o: unknown) => unknown } }> }
    }).config.profiles().get(WORKBUDDY_GLOBAL_PROVIDER)
    expect(profile).toBeDefined()

    const normalized = {
      messages: [
        { role: 'system', content: 'You are helpful.', toolsAdded: [{ name: 'pwsh' }], timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
      ],
    }
    profile?.piProvider.streamSimple(
      { id: 'hy3', api: 'openai-completions', provider: WORKBUDDY_GLOBAL_PROVIDER },
      normalized,
      { apiKey: 'k' },
    )

    expect(receivedContexts).toHaveLength(1)
    expect(receivedContexts[0]).toBe(normalized)
  })

  it('defaults to the generation this plugin actually resolves', async () => {
    // Whatever pi-ai copy this checkout resolves, the default wiring must
    // agree with the feature-detected generation: fold iff legacy.
    receivedContexts.length = 0
    const { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } = await import('../src/adapter.ts')
    const { piAiRuntimeInfo } = await import('../src/pi-ai-runtime.ts')
    const { WorkBuddyCatalog } = await import('../src/catalog.ts')

    const { adapter } = createWorkBuddyAdapter({
      shim: { baseUrl: () => 'http://127.0.0.1:1', token: async () => 'shared-secret' } as never,
      store: {} as never,
      catalog: new WorkBuddyCatalog(),
    })
    const profile = (adapter as unknown as {
      config: { profiles: () => ReadonlyMap<string, { piProvider: { streamSimple: (m: unknown, c: unknown, o: unknown) => unknown } }> }
    }).config.profiles().get(WORKBUDDY_PROVIDER)
    const normalized = {
      messages: [
        { role: 'system', content: 'You are helpful.', toolsAdded: [{ name: 'pwsh' }], timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 0 },
      ],
    }
    profile?.piProvider.streamSimple(
      { id: 'hy3', api: 'openai-completions', provider: WORKBUDDY_PROVIDER },
      normalized,
      { apiKey: 'k' },
    )
    expect(receivedContexts).toHaveLength(1)
    if (piAiRuntimeInfo().generation === 'legacy') {
      const seen = receivedContexts[0] as { systemPrompt?: string }
      expect(seen.systemPrompt).toBe('You are helpful.')
    } else {
      expect(receivedContexts[0]).toBe(normalized)
    }
  })
})
