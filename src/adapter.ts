/**
 * The WorkBuddy pi-ai providers: loopback-backed adapters registered
 * into the Harness LLM seam, assembled from public `dsh-llm-pi-ai`
 * extension points. One instance per region — `workbuddy` for the domestic
 * gateway, `workbuddy-global` for the international one — each pointing at
 * its own shim and catalog so the two regions serve simultaneously.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
 *   — pi-ai provider 的装配方式（createProvider + openAICompletionsApi +
 *     inert auth plane + 用 shim 的进程内 secret 作为 apiKey）由该项目实现；
 *   DSH 插件结构与 provider 注册的思路参照
 *     franksong2702/dsh-codex-connect（Apache-2.0），经其转引。
 * 改动：模型描述符补上 upstream 给出的多模态与推理档位信息（若有），
 *   供 DSH 的能力判断使用；工厂参数化 provider id，支持双区域实例。
 *
 * @module dsh-connect-workbuddy/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, Context, CredentialStore, Message, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddyCatalog, WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyShim } from './shim.ts'
import { WORKBUDDY_FALLBACK_SYSTEM_PROMPT } from './upstream.ts'
import type { WorkBuddyRegion } from './upstream.ts'
import { piAiRuntimeInfo } from './pi-ai-runtime.ts'
import type { PiAiGeneration } from './pi-ai-runtime.ts'

/** Provider route this bundle owns for the domestic (CN) gateway. */
export const WORKBUDDY_PROVIDER = 'workbuddy'

/** Provider route this bundle owns for the international gateway. */
export const WORKBUDDY_GLOBAL_PROVIDER = 'workbuddy-global'

/** The provider id each region registers as. */
export const WORKBUDDY_PROVIDERS: Readonly<Record<WorkBuddyRegion, string>> = {
  cn: WORKBUDDY_PROVIDER,
  global: WORKBUDDY_GLOBAL_PROVIDER,
}

/** Region a provider route id belongs to. */
export function regionOfProvider(provider: string): WorkBuddyRegion | undefined {
  for (const [region, id] of Object.entries(WORKBUDDY_PROVIDERS) as [WorkBuddyRegion, string][]) {
    if (id === provider) return region
  }
  return undefined
}

/** Human-readable provider name, shown in the DSH model picker. */
export const WORKBUDDY_PROVIDER_DISPLAY_NAMES: Readonly<Record<WorkBuddyRegion, string>> = {
  cn: 'WorkBuddy',
  global: 'WorkBuddy Global',
}

/** Provider idle ceiling while one stream read is outstanding. */
export const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
 * them required in 0.1.1-rc.2.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * Inert pi-ai auth plane. The workbuddy route authenticates only through the
 * shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
 * credential lifecycle and ambient discovery must never manufacture a
 * credential for it. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
 * every ambient question here answers "nothing stored, nothing set".
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-connect-workbuddy: the workbuddy route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** Constructor dependencies. */
export interface WorkBuddyAdapterOptions {
  shim: WorkBuddyShim
  store: WorkBuddyCredentialStore
  catalog: WorkBuddyCatalog
  /** Provider route id this instance serves; defaults to the CN route. */
  provider?: string
  /** pi-ai provider name and profile display name; defaults to the CN name. */
  displayName?: string
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Override the pi-ai generation gate (see {@link piAiRuntimeInfo}); tests
   * inject both branches because this checkout only ever RESOLVES one of
   * them. Production callers leave it unset.
   */
  piAiGeneration?: PiAiGeneration
}

/** What {@link createWorkBuddyAdapter} hands back. */
export interface WorkBuddyAdapter {
  adapter: PiAiAdapter
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void
}

const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

type WorkBuddyThinkingLevel = typeof THINKING_LEVELS[number]
type WorkBuddyThinkingLevelMap = Partial<Record<'off' | WorkBuddyThinkingLevel, string | null>>

/** pi-ai input modalities: images only when WorkBuddy advertises them. */
export function workBuddyModelInput(info: WorkBuddyModelInfo): ('text' | 'image')[] {
  return info.multimodal === true ? ['text', 'image'] : ['text']
}

/**
 * DSH-facing display name: the model name plus the upstream credit multiplier,
 * spelled the way WorkBuddy's own selector does (`GLM-5.3 · x0.79`).
 *
 * Display-only by construction: every DSH-side join keys on the model id —
 * the selector's current choice (`provider` + `model`), the durable
 * `model/selection` / `request/header` session events, the agent default-model
 * settings, and the request wire (`model: <id>` reaching the shim). A model
 * without a parsed multiplier keeps its bare name; a zero multiplier shows
 * `x0.00`, matching WorkBuddy's rendering of free models.
 */
export function workBuddyDisplayName(info: WorkBuddyModelInfo): string {
  return info.creditMultiplier === undefined
    ? info.name
    : `${info.name} · x${info.creditMultiplier.toFixed(2)}`
}

/** Map only levels advertised by WorkBuddy; undeclared DSH levels stay unavailable. */
export function workBuddyThinkingLevelMap(info: WorkBuddyModelInfo): WorkBuddyThinkingLevelMap | undefined {
  const supported = info.reasoning?.supportedEfforts?.filter((effort): effort is WorkBuddyThinkingLevel =>
    (THINKING_LEVELS as readonly string[]).includes(effort),
  )
  if (supported === undefined || supported.length === 0) return undefined
  const map: WorkBuddyThinkingLevelMap = Object.fromEntries(
    THINKING_LEVELS.map(level => [level, supported.includes(level) ? level : null]),
  )
  if (info.reasoning?.canDisableThinking !== true) map.off = null
  return map
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info: WorkBuddyModelInfo, baseUrl: string, providerId: string): Model<Api> {
  const thinkingLevelMap = workBuddyThinkingLevelMap(info)
  return {
    id: info.id,
    name: workBuddyDisplayName(info),
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: workBuddyModelInput(info),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    reasoning: thinkingLevelMap !== undefined,
    ...thinkingLevelMap === undefined ? {} : { thinkingLevelMap },
    compat: { supportsReasoningEffort: thinkingLevelMap !== undefined },
  } as unknown as Model<Api>
}

/**
 * Rewrite a pi-ai 0.87-shaped transcript into the 0.85 shape this plugin's
 * pi-ai understands — prompt AND tools.
 *
 * WHY THIS EXISTS (issue #24). pi-ai 0.87's `normalizeContext` moves the system
 * prompt INTO `messages` as `{ role: 'system', content: '<string>' }`. pi-ai
 * 0.85's own `Message` union has no `system` variant
 * (`UserMessage | AssistantMessage | ToolResultMessage`), so its
 * `estimateMessageTokens` has no branch for one: `for (const block of
 * message.content)` iterates the CONTENT STRING character by character, `block`
 * is a single character, and `block.name.length` throws
 * `Cannot read properties of undefined (reading 'length')`.
 *
 * That crash happens inside the library, in `buildBaseOptions ->
 * clampMaxTokensToContext -> estimateContextTokens`, i.e. BEFORE any request is
 * built — so every model fails instantly and no upstream traffic is sent. A
 * host running 0.87 hands us the normalized transcript while our own provider
 * is 0.85, and the plugin cannot patch the library. What it CAN do is not hand
 * a 0.87 transcript to a 0.85 API object.
 *
 * The 0.87 transcript carries MORE than the prompt on that leading system
 * message: `toolsAdded` (and `toolsRemoved`) are the ONLY place the tool
 * declarations live — `normalizeContext` deleted the top-level `tools` field,
 * and 0.85's api reads tools ONLY from `context.tools`. So folding the text
 * without promoting the tool state would trade issue #24's loud crash for
 * issue #26's silent one: models that can never emit a `toolCall` because the
 * request never declared any tools. The fold here promotes both, replaying
 * every system message's `toolsRemoved`/`toolsAdded` in order — exactly the
 * merge pi-ai 0.87's own `getCurrentTools` performs — and leaves an existing
 * top-level `tools` array untouched.
 *
 * Deliberately SHAPE-based within the legacy branch, not version-based: it
 * asks "does this context carry a system message inside `messages`?" rather
 * than "which pi-ai version is loaded?". A version check would be wrong the
 * moment either side moves. Which BRANCH runs at all IS generation-gated —
 * see {@link withLegacyContext}: a modern (0.87+) api consumes this very
 * transcript natively, and folding for it would destroy its only carrier of
 * prompt and tools (issues #25/#26).
 *
 * Returns the SAME object when there is nothing to adapt — in particular when
 * `systemPrompt` is already set (the native 0.85 shape), so the ordinary path
 * is byte-for-byte untouched.
 *
 * Two guards beyond the 0.87 fold, both about a request reaching the upstream
 * with NO system message — which the international gateway refuses outright
 * (business code 11128) while the domestic one tolerates:
 *
 * - an EMPTY `systemPrompt` is treated as absent rather than "already set".
 *   pi-ai emits the prompt under `if (context.systemPrompt)`, so an empty one
 *   produces no system message at all and pi-ai demotes any `system` entry still
 *   in `messages` to `user`. Falling through here lets a real system message
 *   that IS present in `messages` be folded up and preserved.
 * - when nothing supplies a prompt, {@link WORKBUDDY_FALLBACK_SYSTEM_PROMPT} is
 *   used, because a placeholder beats a guaranteed 400. A system message whose
 *   text is empty but which carries `toolsAdded` still folds its TOOLS up; the
 *   placeholder for the missing prompt then comes from `ensureSystemHead` at
 *   the wire (the last of the three layers).
 */
export function adaptLegacyPiAiContext(context: Context): Context {
  if (context === null || typeof context !== 'object') return context
  // Truthiness, not `!== undefined`: see the empty-prompt guard above.
  if (context.systemPrompt) return context
  const messages = Array.isArray(context.messages) ? context.messages : undefined
  if (messages === undefined) return context

  const systemTexts: string[] = []
  const rest: Message[] = []
  const toolState = new Map<string, NonNullable<Context['tools']>[number]>()
  let sawSystemMessage = false
  for (const message of messages) {
    const role = (message as { role?: unknown } | null)?.role
    if (role !== 'system') {
      rest.push(message)
      continue
    }
    sawSystemMessage = true
    const text = systemTextOf(message)
    if (text !== '') systemTexts.push(text)
    replayToolState(message, toolState)
  }

  const head = rest[0] as { role?: unknown } | undefined
  const needsFallback = !sawSystemMessage
    && head !== undefined
    && head.role !== 'system'
  if (!sawSystemMessage && !needsFallback) return context

  // Dropped from `messages` even when no text could be extracted: leaving it
  // there is precisely what crashes 0.85, and a system entry with no text has
  // nothing to lose. `systemPrompt` stays ABSENT rather than '' so a provider
  // never receives an empty system message.
  const systemPrompt = systemTexts.length > 0
    ? systemTexts.join('\n\n')
    : sawSystemMessage ? undefined : WORKBUDDY_FALLBACK_SYSTEM_PROMPT

  // Only a context with NO top-level tools gets the promoted set: when the
  // caller supplied one, it is authoritative for their shape.
  const tools = Array.isArray(context.tools)
    ? undefined
    : [...toolState.values()]

  return {
    ...context,
    ...systemPrompt === undefined ? {} : { systemPrompt },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    messages: rest,
  }
}

/**
 * Replay one 0.87 system message's tool deltas into `state`, the same merge
 * pi-ai 0.87's `getCurrentTools` performs: removals first, then additions,
 * keyed by name so a mid-conversation redeclaration replaces the original.
 */
function replayToolState(message: Message, state: Map<string, NonNullable<Context['tools']>[number]>): void {
  const removed = (message as { toolsRemoved?: unknown }).toolsRemoved
  if (Array.isArray(removed)) {
    for (const tool of removed) {
      const name = (tool as { name?: unknown } | null)?.name
      if (typeof name === 'string') state.delete(name)
    }
  }
  const added = (message as { toolsAdded?: unknown }).toolsAdded
  if (Array.isArray(added)) {
    for (const tool of added) {
      const name = (tool as { name?: unknown } | null)?.name
      if (typeof name === 'string') state.set(name, tool as NonNullable<Context['tools']>[number])
    }
  }
}

/** The text of one system message, whether it is a string or text blocks. */
function systemTextOf(message: Message): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown, text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') texts.push(candidate.text)
  }
  return texts.join('\n\n')
}

/**
 * Wrap one pi-ai API module so both stream entry points receive a context this
 * build can actually consume (see {@link adaptLegacyPiAiContext}) — but only
 * when the module RESOLVED for this plugin is the legacy generation.
 *
 * The gate is the plugin's own module, resolved via {@link piAiRuntimeInfo}
 * (manifest version of the copy this plugin resolves — no pi-ai import): a
 * modern (0.87+) api consumes the normalized
 * transcript natively — its request builder reads the prompt from the leading
 * system message and the tools from that message's `toolsAdded`, and never
 * reads the top-level `systemPrompt`/`tools` fields at all. Folding for it
 * would delete the only carrier of both (issues #25/#26: the international
 * gateway answers the prompt-less body with 400 / 11128, the domestic one
 * accepts it and the model fabricates tool calls it can never actually make).
 * The unwrapped modern api is returned AS-IS — byte-for-byte pass-through.
 *
 * The deferred-fetch entry points take no context and are passed through as-is
 * in both branches.
 */
function withLegacyContext(api: ProviderStreams, generation: PiAiGeneration): ProviderStreams {
  if (generation === 'modern') return api
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, adaptLegacyPiAiContext(context), options),
    streamSimple: (model, context, options) => api.streamSimple(model, adaptLegacyPiAiContext(context), options),
  }
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 */
export function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter {
  const { shim, store, catalog, resolveAttachments } = options
  const providerId = options.provider ?? WORKBUDDY_PROVIDER
  const providerName = options.displayName ?? 'WorkBuddy'
  // The generation gate: what THIS plugin resolves, not what the host runs —
  // a nested 0.85 on disk shadows the host's 0.87 and vice versa, and only
  // the resolved copy decides which context shape the api below can consume.
  const generation = options.piAiGeneration ?? piAiRuntimeInfo().generation
  void store

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL,
    // so the shim's routes line up with the `/v1` prefix in place.
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl, providerId))
  }

  const base = createProvider({
    id: providerId,
    name: providerName,
    auth: {
      apiKey: {
        name: 'WorkBuddy OAuth bearer token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'WorkBuddy' }
        },
      },
    },
    models: buildModels(),
    api: withLegacyContext(openAICompletionsApi(), generation),
  })

  // `getModels` is delegated to a live read (the reuse-catalog pattern from
  // dsh-llm-pi-ai): stream dispatch still runs through the constructed
  // provider, while the catalog answer tracks the upstream refresh.
  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName: providerName,
    streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-workbuddy retryPolicy'),
    configuredMaxTokens: new Map(),
    // Per-model failures gate every request: `modelOf` throws INVALID_CONFIG
    // for any id present here. The workbuddy catalog is built from live reads,
    // so an empty map is the accurate answer — no known-bad model — and the
    // route must never pre-condemn a model that the catalog later supplies.
    // (Required by ResolvedPiAiProviderProfile since 0.1.5-rc.1.)
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  // Replacing (not mutating) the map is what `invalidate` uses to force the
  // adapter's next profiles read to rebuild its snapshot.
  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // Resolve the shim's per-process shared secret as the OpenAI apiKey so
    // pi-ai sends it as `Authorization: Bearer <shared-secret>`. The shim
    // validates this before forwarding and resolves the real WorkBuddy token
    // itself via the store, so the secret never reaches upstream.
    resolveApiKey: async () => shim.token(),
    ...resolveAttachments === undefined ? {} : { resolveAttachments },
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
  }
}
