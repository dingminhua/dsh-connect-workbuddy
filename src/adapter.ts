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

import { createAssistantMessageEventStream, createProvider, isContextOverflow } from '@earendil-works/pi-ai'
import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, AuthContext, Context, CredentialStore, Message, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai'
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
import type { ContextRescue } from './context-rescue.ts'

/** Provider route this bundle owns for the domestic (CN) gateway. */
export const WORKBUDDY_PROVIDER = 'workbuddy'

/** Provider route this bundle owns for the international gateway. */
export const WORKBUDDY_GLOBAL_PROVIDER = 'workbuddy-global'

/** The provider id each region registers as. */
export const WORKBUDDY_PROVIDERS: Readonly<Record<WorkBuddyRegion, string>> = {
  cn: WORKBUDDY_PROVIDER,
  global: WORKBUDDY_GLOBAL_PROVIDER,
}

/**
 * Model identity BOTH regions stamp on their models — the fix for issue #59.
 *
 * pi-ai keeps a historical thinking block as `thinking` only when the message
 * that carried it names the SAME provider, api and model id as the request in
 * flight (`transform-messages.js:68`); every other block is downgraded to plain
 * `text` (`:88–96`) — downgraded, not dropped, which is why no byte count ever
 * explained the 1.94× regional jump. The two gateways are two provider STRINGS
 * for ONE model, so a transcript recorded in one region was replayed as text in
 * the other, and issue #59's reporter measured exactly that: 708K → 1.374M on
 * byte-identical history, and a compression request that could then never fit
 * the window it was computed for.
 *
 * `provider` is also the KEY pi-ai dispatches on (`models.js:410–416`
 * `requireProvider`), so the identity cannot simply be the shared string: the
 * registry has to keep resolving per region. Both halves of that are already
 * satisfied by pi-ai's own lookup shape — `getModel(provider, id)` is
 * `getModels(provider).find(...)` (`models.js:116–118`), i.e. the KEY is the
 * route id while the STAMPED field is whatever the provider put there — so the
 * route stays `workbuddy`/`workbuddy-global` (each with its own shim, catalog
 * and credential store) while every model it serves advertises THIS id. This
 * plugin's provider registers no `fetchModels`, so nothing downstream derives
 * anything from the stamped field; the openai-completions api uses
 * `model.provider` only for provider-specific quirks (none of which match
 * these ids) and as an error-message label.
 *
 * Deliberately NOT the same string as either route: a message is only
 * same-model when provider, api AND model id all match, so the shared id must
 * not be reachable as a route a user could pick — it names one model, not one
 * gateway.
 */
export const WORKBUDDY_MODEL_IDENTITY = 'workbuddy'

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
  /**
   * Model identity stamped on every model this route serves; defaults to
   * {@link WORKBUDDY_MODEL_IDENTITY}. Tests override it to model a transcript
   * recorded by a host that still stamped per-region ids.
   */
  modelIdentity?: string
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Resolve the host-side context-overflow rescue, when this host exposes one.
   * Omitted (or resolving to `undefined`) leaves the adapter exactly as it was:
   * a provider overflow is forwarded and the host's own recovery decides.
   */
  resolveContextRescue?: () => ContextRescue | undefined
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

/**
 * Map only levels advertised by WorkBuddy; undeclared DSH levels stay unavailable.
 *
 * `off` is offered EXACTLY when `canDisableThinking === true` and withheld
 * (mapped to `null`) otherwise. `null` is pi-ai's "this level is not
 * supported": `getSupportedThinkingLevels` filters on `mapped === null`, and
 * `openai-completions` reads `thinkingLevelMap?.off !== null` to decide whether
 * it may send a thinking-disabled request.
 *
 * This condition used to be inverted (`!== true` set the null), which locked
 * `off` OFF for precisely the models that CAN disable thinking while leaving it
 * ON for those that cannot. It stayed invisible because the only test probed
 * the `canDisableThinking: false` half, which the inverted form also passes.
 *
 * The value read here is already the EFFECTIVE one: the runtime catalog is
 * stamped by `withEffectiveOff()` before it reaches the adapter, so this is the
 * user's `off` selection when they made one (and the upstream declaration,
 * minus `REFUSES_OFF_MODEL_IDS`, when they never did). Absence is "unknown" and
 * stays unoffered, matching how the rest of the plugin treats undeclared
 * capability.
 */
export function workBuddyThinkingLevelMap(info: WorkBuddyModelInfo): WorkBuddyThinkingLevelMap | undefined {
  const supported = info.reasoning?.supportedEfforts?.filter((effort): effort is WorkBuddyThinkingLevel =>
    (THINKING_LEVELS as readonly string[]).includes(effort),
  )
  if (supported === undefined || supported.length === 0) return undefined
  const map: WorkBuddyThinkingLevelMap = Object.fromEntries(
    THINKING_LEVELS.map(level => [level, supported.includes(level) ? level : null]),
  )
  if (info.reasoning?.canDisableThinking === true) map.off = 'off'
  else map.off = null
  return map
}

/**
 * Build one pi-ai model descriptor pointing at the loopback shim.
 *
 * `identity` — not the route id — is what `provider` carries; see
 * {@link WORKBUDDY_MODEL_IDENTITY} for why the two must differ. The route the
 * model is REACHED by is the registry key the adapter serves, not this field.
 */
function toPiModel(
  info: WorkBuddyModelInfo,
  baseUrl: string,
  identity: string = WORKBUDDY_MODEL_IDENTITY,
): Model<Api> {
  const thinkingLevelMap = workBuddyThinkingLevelMap(info)
  return {
    id: info.id,
    name: workBuddyDisplayName(info),
    api: 'openai-completions',
    provider: identity,
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
 *
 * LEGACY-ONLY. This is the inverse direction from {@link foldModernContext}:
 * it produces the FLAT `{systemPrompt, tools, messages}` shape that ONLY
 * pi-ai 0.85 reads. Never hand its result to a 1.x api — 1.x reads tools from
 * `messages[].toolsAdded` and would see none (issues #25/#26). Type note: the
 * parameter is the 0.85 `Context`; pi-ai 1.1.0 types the api's second parameter
 * as `TranscriptContext`, so this function cannot be called with 1.x typings —
 * that is intentional, and it is why the modern branch below does not touch it.
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
 * Fold a RAW context into the normalized transcript the modern generation
 * consumes: a leading `system` message carrying the prompt AND the tool
 * declarations in its `toolsAdded` field.
 *
 * WHY THIS IS NEEDED AT ALL (the 0.2.1-rc.1 regression). This used to be
 * unnecessary: the modern branch returned pi-ai's api UNWRAPPED, on the belief
 * that the modern generation normalized for itself. It does not.
 * `dsh-llm-pi-ai` — both the 0.1.7 and the 0.2.1 lines — hands every provider a
 * RAW envelope (`piContext()` builds `{systemPrompt, messages, tools}` and
 * never calls `normalizeContext`), while:
 *
 *   - pi-ai 0.85.x READS that raw shape (its request builder consults
 *     `context.systemPrompt` / `context.tools` directly), and
 *   - pi-ai 1.x READS ONLY `context.messages` (it resolves the transcript and
 *     collapses system messages; the top-level fields are consulted nowhere).
 *
 * On pi-ai 1.x a pass-through request therefore went upstream with NO system
 * prompt and NO tool declarations, silently: the model stopped calling tools,
 * and the domestic gateway tolerated the prompt-less body. Same failure class
 * as issues #24/#25/#26, reached from the opposite side — 4.4.2 fixed "1.x
 * misjudged as legacy and folded"; this fixes "1.x judged modern and NOT
 * folded, though nothing had normalized".
 *
 * Built inline rather than by importing pi-ai's `normalizeContext`, which does
 * not exist in 0.85.x: a static import would be `undefined` there, and this
 * module deliberately never imports pi-ai statically (see `pi-ai-runtime.ts` —
 * that doctrine is what lets the standalone `bin` run in a profile where the
 * peer is never installed). The folded shape matches what `normalizeContext`
 * produces for the same input: `{role:'system', content, toolsAdded, timestamp:0}`.
 *
 * The top-level `systemPrompt`/`tools` fields are DROPPED, exactly as
 * `normalizeContext` drops them, so a raw transcript and an already-normalized
 * one converge on the same object.
 */
function foldModernContext(context: Context): Context {
  const prompt = context.systemPrompt
  const tools = context.tools
  const hasPrompt = prompt !== undefined && prompt !== ''
  const hasTools = Array.isArray(tools) && tools.length > 0
  // Nothing to fold: an already-normalized transcript (its system message is in
  // `messages` already). Folding again would prepend a SECOND, empty one.
  if (!hasPrompt && !hasTools) return context
  const system = {
    role: 'system',
    content: prompt ?? '',
    ...(hasTools ? { toolsAdded: tools } : {}),
    timestamp: 0,
  } as unknown as Message
  const { systemPrompt: _prompt, tools: _tools, ...rest } = context as Context & {
    systemPrompt?: string
    tools?: Context['tools']
  }
  return { ...rest, messages: [system, ...context.messages] } as Context
}

/**
 * Wrap one pi-ai API module so both stream entry points receive a context this
 * generation can actually consume.
 *
 * The gate is the plugin's own module, resolved via {@link piAiRuntimeInfo}
 * (manifest version of the copy this plugin resolves — no pi-ai import):
 *
 * - `legacy` (0.85) wants the flat `{systemPrompt, tools, messages}` shape, so
 *   a normalized transcript is UN-folded by {@link adaptLegacyPiAiContext}.
 * - `modern` (0.87+, incl. 1.x) wants the normalized transcript, so a raw
 *   envelope is FOLDED by {@link foldModernContext}. Passing it through
 *   unnormalized is what silently deleted the prompt and the tools on pi-ai
 *   1.x — the regression this branch now prevents.
 *
 * Both branches are idempotent, so a future seam that starts normalizing on its
 * own side changes nothing here.
 *
 * The deferred-fetch entry points take no context and are passed through as-is
 * in both branches.
 */
/**
 * Present an adapted context as the type the api's parameter currently expects.
 *
 * pi-ai 1.x BRANDS its provider-facing context (`TranscriptContext`, a
 * `unique symbol` field) precisely so a raw `Context` cannot reach provider
 * code by accident; the brand's stated sole producer is `normalizeContext()`.
 * On a 1.x typings surface BOTH branches below receive that branded type, so
 * merely returning a plain `Context` fails `tsc` with TS2345 — an error that
 * only appears when the peer TYPES are 1.x, which is why the 0.85 checkout
 * never saw it.
 *
 * The cast is a deliberate, documented assertion of exactly what the brand
 * protects, and it is true after the call site has done the work:
 *
 * - modern: {@link foldModernContext} has already performed
 *   `normalizeContext`'s job — prompt and tools live on the leading system
 *   message, top-level fields gone;
 * - legacy: {@link adaptLegacyPiAiContext} produced the FLAT 0.85 shape, which
 *   is only ever observed on a 0.85 checkout, where this type is a plain
 *   `Context` and the cast is an upcast.
 *
 * Do NOT "fix" this by importing `normalizeContext`: it does not exist in
 * 0.85, so that import would be `undefined` at runtime on the very hosts this
 * code must keep working — the same reason `pi-ai-runtime.ts` documents why
 * this module never imports pi-ai statically.
 */
function transcript<T>(context: Context): T {
  return context as unknown as T
}

function withLegacyContext(api: ProviderStreams, generation: PiAiGeneration): ProviderStreams {
  if (generation === 'modern') {
    return {
      ...api,
      stream: (model, context, options) =>
        api.stream(model, transcript<Parameters<typeof api.stream>[1]>(foldModernContext(context)), options),
      streamSimple: (model, context, options) =>
        api.streamSimple(
          model,
          transcript<Parameters<typeof api.streamSimple>[1]>(foldModernContext(context)),
          options,
        ),
    }
  }
  return {
    ...api,
    stream: (model, context, options) =>
      api.stream(model, transcript<Parameters<typeof api.stream>[1]>(adaptLegacyPiAiContext(context)), options),
    streamSimple: (model, context, options) =>
      api.streamSimple(
        model,
        transcript<Parameters<typeof api.streamSimple>[1]>(adaptLegacyPiAiContext(context)),
        options,
      ),
  }
}

/**
 * Layer the host-side context-overflow rescue onto a provider's streams.
 *
 * pi-ai reports a provider failure as an `error` event rather than a throw, so
 * the rescue runs while the failing assistant message is still in hand: history
 * is folded before the event continues on its way, and the host's retry then
 * rebuilds its request against a smaller surface. Nothing is swallowed — the
 * error event is forwarded unchanged, because deciding whether to retry is the
 * host's policy, not this transport's.
 *
 * Both gates are deliberate. Without `sessionId` there is no session to fold,
 * and without a declared `contextWindow` there is no budget to fold against;
 * either absence leaves the stream untouched.
 */
function withContextRescue(
  api: ProviderStreams,
  resolve: (() => ContextRescue | undefined) | undefined,
): ProviderStreams {
  if (resolve === undefined) return api

  // Both parameters stay generic so this wrapper serves whichever pi-ai
  // generation is installed: 1.x replaced the flat `Context` with a branded
  // `TranscriptContext`, and naming either type here would pin the wrapper to
  // one generation and break the other's typecheck.
  const wrap = <ContextShape, Options>(
    inner: (model: Model<Api>, context: ContextShape, options?: Options) => AssistantMessageEventStream,
  ) =>
    (model: Model<Api>, context: ContextShape, options?: Options): AssistantMessageEventStream => {
      const source = inner(model, context, options)
      const rescue = resolve()
      // 0.85 and 1.x both carry the session id here under the same name; the
      // structural read keeps the wrapper independent of the options type.
      const sessionId = (options as { sessionId?: string } | undefined)?.sessionId
      const window = model.contextWindow
      if (rescue === undefined || sessionId === undefined || window === undefined) return source

      const out = createAssistantMessageEventStream()
      let final: AssistantMessage | undefined
      void (async () => {
        try {
          for await (const event of source) {
            if (event.type === 'done') final = event.message
            if (event.type === 'error') final = event.error
            // Fold before the consumer settles: the error still reaches it, but
            // the surface is already smaller when the host retries.
            if (event.type === 'error' && isContextOverflow(event.error)) {
              await rescue.rescue(sessionId, window)
            }
            out.push(event)
          }
          out.end(final)
        } catch {
          // Unreachable in practice: pi-ai converts every provider failure into
          // an `error` event. Close the stream rather than leave a consumer
          // waiting on an iterator that will never advance.
          out.end(final)
        }
      })()
      return out
    }

  return { ...api, stream: wrap(api.stream), streamSimple: wrap(api.streamSimple) }
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
  // The model identity defaults to the ROUTE id, not to the shared
  // `WORKBUDDY_MODEL_IDENTITY` constant. issue #59's fix wants the two regions
  // to share one identity so a cross-region replay keeps its thinking blocks —
  // but that identity is also the key pi-ai dispatches on (`requireProvider` in
  // `models.js`), so a `workbuddy-global` model stamped `workbuddy` resolves
  // against the CN registry entry and throws `Unknown provider: workbuddy`.
  //
  // Defaulting to `providerId` keeps every model resolvable (its `provider`
  // always names the route that serves it). Callers that need the shared
  // identity for a different reason can still pass `modelIdentity` explicitly.
  const modelIdentity = options.modelIdentity ?? providerId
  // The generation gate: what THIS plugin resolves, not what the host runs —
  // a nested 0.85 on disk shadows the host's 0.87 and vice versa, and only
  // the resolved copy decides which context shape the api below can consume.
  const generation = options.piAiGeneration ?? piAiRuntimeInfo().generation
  void store

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL,
    // so the shim's routes line up with the `/v1` prefix in place.
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl, modelIdentity))
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
    api: withContextRescue(withLegacyContext(openAICompletionsApi(), generation), options.resolveContextRescue),
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
