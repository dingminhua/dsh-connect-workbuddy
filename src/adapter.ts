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
import { ReasoningEffortId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelReasoningInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddyCatalog, WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyShim } from './shim.ts'
import { offRefused } from './off-thinking.ts'
import { defaultEffortFor } from './default-effort.ts'
import { WORKBUDDY_DEFAULT_EFFORT } from './default-effort.ts'
import { WORKBUDDY_FALLBACK_SYSTEM_PROMPT } from './upstream.ts'
import type { WorkBuddyRegion } from './upstream.ts'
import { piAiRuntimeInfo } from './pi-ai-runtime.ts'
import type { PiAiGeneration } from './pi-ai-runtime.ts'
import type { ContextRescue } from './context-rescue.ts'

/**
 * The tier a request gets when it names none — compaction summaries, above all
 * (issue #83). See the `reasoning` field in `profileFor` for why an absent
 * default is not "no opinion" but "whatever pi-ai's level map says", which is
 * how `off` became the silent default for `/compact`.
 *
 * Re-exported from `./default-effort.ts`, which is where issue #179 put the
 * per-model override: this constant is now the route-wide FALLBACK for a model
 * the user has not picked a tier for, not the final answer for the roster. The
 * name and value are unchanged so every existing caller and test still reads.
 */
export { WORKBUDDY_DEFAULT_EFFORT } from './default-effort.ts'

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
 * The stamp is NOT inert, and reading it as inert is what broke issue #75.
 * `provider` is the KEY pi-ai dispatches on: `requireProvider` resolves
 * `this.providers.get(model.provider)` and throws
 * `Unknown provider: ${model.provider}` when it is absent (`models.js:410–416`
 * on the host's 1.1.0, `:351–357` on the 0.85.1 this repo resolves), and
 * `getAuth` resolves the same key, answering `Provider is not configured`
 * instead (`:334–341` and `:429`; `:275–280` and `:366` on 0.85.1). Both sit on
 * the LIVE chat path: `dsh-llm-pi-ai` streams through
 * `snapshot.models.streamSimple(model, …)` (`lib/index.js:1983`), which calls
 * `requireProvider` before a byte is sent (`models.js:454–459`). Each region
 * builds its OWN registry from its own adapter — `current()` registers
 * `profile.piProvider` per profile (`lib/index.js:1852–1862`) — so the
 * `workbuddy-global` region registered only `workbuddy-global` and could not
 * dispatch a model stamped `workbuddy`: every request failed with
 * `Unknown provider: workbuddy` before reaching the gateway.
 * {@link modelIdentityKeysOf} is the correction: the identity has to be a
 * registry key of its own in every region, or the stamp cannot be shared.
 *
 * Lookup by ROUTE is a separate question and stays intact: `getModel(provider,
 * id)` is `getModels(provider).find(...)` (`models.js:116–118`), i.e. it goes
 * through the map key, while the STAMPED field is whatever the provider put
 * there. So the route stays `workbuddy`/`workbuddy-global` (each with its own
 * shim, catalog and credential store) while every model it serves advertises
 * THIS id. The openai-completions api reads `model.provider` only for
 * provider-specific quirks (none of which match these ids) and as an
 * error-message label.
 *
 * Deliberately NOT the same string as the global route: a message is only
 * same-model when provider, api AND model id all match, so the shared id must
 * not be reachable as a route a user could pick — it names one model, not one
 * gateway. It IS reachable as a pi-ai registry key, which is the point: those
 * are internal and never surface as a route, because `registerAdapter` takes
 * the route list explicitly (`dsh-llm/lib/index.js:1842–1861`,
 * `prepareRoutes` `:1867–1885`) and this plugin passes exactly the two region
 * ids (`src/index.ts:2069–2086`).
 */
export const WORKBUDDY_MODEL_IDENTITY = 'workbuddy'

/**
 * The api string `dsh-llm-pi-ai` stamps on a replayed message it could not
 * rebuild natively (`foreignAssistant()`), i.e. a message that went through the
 * host's fallback path rather than this plugin's own request builder.
 *
 * It is the ONLY api value {@link alignAssistantIdentities} repairs, because it
 * is the only one that proves the field is a host marker instead of a shape this
 * plugin really produced.
 */
export const HOST_FOREIGN_API = 'dsh-foreign'

/**
 * Registry keys an adapter serving `providerId` must publish so that every
 * stamp its models carry resolves inside its own region (issue #75).
 *
 * The route id first, then the model identity, de-duplicated — route-first so
 * `profiles()` opens with the route the adapter actually serves. CN yields one
 * key (`workbuddy` is both its route and the shared identity) and the global
 * region yields two (`workbuddy-global`, `workbuddy`); the two regions
 * therefore publish different key sets, and each must publish the shared one.
 *
 * `identity` is a parameter because {@link WorkBuddyAdapterOptions.modelIdentity}
 * can override the stamp: the keys have to follow the stamp, or a test that
 * stamps a per-region id would get the production keys back.
 */
export function modelIdentityKeysOf(
  providerId: string | undefined,
  identity: string = WORKBUDDY_MODEL_IDENTITY,
): readonly string[] {
  return [...new Set([providerId, identity].filter((key): key is string => key !== undefined))]
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
  /**
   * Model identity stamped on every model this route serves; defaults to
   * {@link WORKBUDDY_MODEL_IDENTITY}. Tests override it to model a transcript
   * recorded by a host that still stamped per-region ids.
   *
   * It also decides the extra registry key this adapter publishes alongside
   * its route (issue #75) — see {@link modelIdentityKeysOf}, which is what
   * keeps an overridden stamp resolvable exactly like the production one.
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
  /**
   * Drop SAME-ROUTE foreign thinking blocks pi-ai would publish as prose
   * (issue #147).
   *
   * CROSS-PROVIDER turns are dropped unconditionally: after a provider switch
   * the host rebuilds the other provider's assistant turns as `dsh-foreign`,
   * their unsigned thinking blocks can never be replayed, and pi-ai would
   * otherwise flatten them into assistant prose that the WorkBuddy gateway
   * refuses with 11128 (issue #163's measured scene). This switch only widens
   * the repair to a model switch INSIDE one of this bundle's own routes.
   *
   * OFF by default for that same-route leg, and read LIVE (a getter, not a
   * boolean) so the switch takes effect on the next request without reloading
   * the plugin: turning it on mid-session is the whole point — the user sees
   * the working-notes turn, flips the switch, and the next turn is answered
   * normally.
   */
  dropForeignThinking?: () => boolean
  /**
   * Told which foreign thinking blocks a request dropped, so the reply can name
   * the condition instead of leaving the user to conclude the model broke
   * (issue #147 asks for at least a visible hint). Called at most once per
   * request; failures are swallowed.
   */
  onForeignThinking?: (blocks: readonly ForeignThinkingBlock[]) => void
  /**
   * The per-model default thinking tier the user saved (issue #179), keyed by
   * model id.
   *
   * A GETTER, not a captured map: the choice is a setting the user can change
   * mid-session, and a captured copy would keep dispatching the old tier until
   * a reload. Production reads the live region slot; tests pass a literal.
   *
   * An absent key means "follow the upstream's own `defaultEffort`" — see
   * `src/default-effort.ts` for how that is resolved against the model's real
   * vocabulary, which is what keeps a stale saved tier from ever reaching the
   * wire as an `UNSUPPORTED_REASONING_EFFORT`.
   */
  defaultThinkingEfforts?: () => Readonly<Record<string, string | undefined>>
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
  const base = info.creditMultiplier === undefined
    ? info.name
    : `${info.name} · x${info.creditMultiplier.toFixed(2)}`
  // Load does NOT ride on this string any more. The host renders the model
  // name verbatim, and the plugin now draws the load badge in the host's own
  // picker through the `conversation.input.model.label` slot
  // (`src/client/WorkBuddyModelLabel.tsx`) — where it can be a COLOURED figure
  // rather than a character whose colour belongs to the emoji font. Leaving
  // the emoji here as well would show the same fact twice, in two visual
  // languages. See `src/busy.ts`.
  return base
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
 * user's `off` selection when they made one — except for the ids on
 * `REFUSES_OFF_MODEL_IDS`, which the stamp forces to `false` no matter what the
 * user asked for (issue #83: this level, once ticked, also became the IMPLICIT
 * default for every request that carries no effort at all, which is how
 * compaction went to 100% failure). The table is re-checked here as well so the
 * wall does not depend on every caller remembering to stamp first.
 *
 * Absence is "unknown" and stays unoffered, matching how the rest of the plugin
 * treats undeclared capability.
 */
export function workBuddyThinkingLevelMap(info: WorkBuddyModelInfo): WorkBuddyThinkingLevelMap | undefined {
  const supported = info.reasoning?.supportedEfforts?.filter((effort): effort is WorkBuddyThinkingLevel =>
    (THINKING_LEVELS as readonly string[]).includes(effort),
  )
  if (supported === undefined || supported.length === 0) return undefined
  const map: WorkBuddyThinkingLevelMap = Object.fromEntries(
    THINKING_LEVELS.map(level => [level, supported.includes(level) ? level : null]),
  )
  if (info.reasoning?.canDisableThinking === true && !offRefused(info.id)) map.off = 'off'
  else map.off = null
  return map
}

/**
 * Build one pi-ai model descriptor pointing at the loopback shim.
 *
 * `identity` — not the route id — is what `provider` carries; see
 * {@link WORKBUDDY_MODEL_IDENTITY} for why the two must differ. The route the
 * model is REACHED by is the registry key the adapter serves, while this
 * stamped field is what pi-ai resolves the provider BY (issue #75) — so every
 * key in {@link modelIdentityKeysOf} must be a key this route registers.
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

/**
 * Rewrite every historical assistant message to the identity this adapter stamps.
 *
 * ISSUE #102. pi-ai replays a thinking block as `thinking` only when the message
 * that produced it names the same `provider` / `api` / `model` as the request in
 * flight (`utils/transform-messages.js`, the `isSameModel` branch); everything
 * else is flattened to `{type:'text', text: thinking}`.
 *
 * The durable transcript the HOST hands back does not carry the identity. The
 * agent loop writes `source.provider = request.provider`, and `request.provider`
 * is the ROUTE id (`workbuddy` / `workbuddy-global`), while this adapter stamps
 * `provider: WORKBUDDY_MODEL_IDENTITY` on the model. So:
 *
 *   - CN sessions survive by COINCIDENCE: its route id happens to equal the
 *     identity (`workbuddy` === `workbuddy`).
 *   - GLOBAL sessions never match (`workbuddy-global` !== `workbuddy`), so every
 *     historical thinking block is downgraded on EVERY turn — not only when the
 *     user switches regions, which is what #59's write-up assumed.
 *
 * The model then sees a context in which all of its own past reasoning was
 * plain assistant text, and writes its new reasoning into `text` to match. That
 * is the reported symptom: reasoning collapses to a character or two while the
 * answer channel fills with working notes.
 *
 * WHY REWRITING IS SAFE. Every message here was produced by THIS plugin, in THIS
 * region — the transcript never contains another provider's assistant turns
 * (`dsh-llm` splits history by provider before the API sees it). The identity is
 * already the field this adapter stamps on the models it serves, and it resolves
 * as a registry key in both regions (issue #75). Nothing about routing, billing
 * or the destination changes: `baseUrl` comes from the model, not from the
 * message.
 *
 * `provider` alone is NOT enough, because the HOST drops the message to
 * `api: 'dsh-foreign'` first. `dsh-llm-pi-ai`'s `replayedAssistant` rejects a
 * replay whose recorded provider differs from `source.provider` and falls back
 * to `foreignAssistant()`, which stamps `api: 'dsh-foreign'` and takes
 * `provider` from `source.provider` — the ROUTE id. That is why the provider
 * mismatch is not merely cosmetic: it also costs the message its native api, and
 * `isSameModel` then fails on the SECOND comparison even after `provider` is
 * repaired. Measured on a real 0.2.1-rc.2 global session, aligning `provider`
 * only still flattened a 1514-character thinking block into 1514 characters of
 * text; aligning both restored `thinking`.
 *
 * So `api` is repaired too, but ONLY from the one value that proves it is a
 * host fallback and not this plugin's own wire format: `dsh-foreign`. Any other
 * api is left exactly as it is.
 *
 * WHY THAT IS NOT FORGING A SIGNATURE. A `foreignAssistant()` message carries
 * thinking blocks with NO `thinkingSignature` (`dsh-llm-pi-ai` builds them as
 * `{type:'thinking', thinking}`), and pi-ai's request builder only emits
 * `reasoning_content` when a signature exists
 * (`api/openai-completions.js`, the `if (signature && isOpenAICompletionsReasoningField(...))`
 * branch). The block is therefore OMITTED from the request, never replayed as
 * signed reasoning — the same thing that happens today, minus the visible text.
 * The message's own `api` field is not read by the request builder at all
 * (grep: only `model.api` is), so this changes no wire shape.
 *
 * A genuinely different model still degrades, because `isSameModel` requires the
 * model id to match and this function deliberately does not rewrite it: the
 * message really was produced by another model. {@link dropForeignThinking}
 * covers that leg separately, through its `requestModelId` argument.
 *
 * Returns the same object when nothing changed, so the common case (an
 * already-normalized transcript) allocates nothing.
 */
export function alignAssistantIdentities(
  context: Context,
  identity: string = WORKBUDDY_MODEL_IDENTITY,
  ownedRoutes: readonly string[] = [WORKBUDDY_PROVIDER, WORKBUDDY_GLOBAL_PROVIDER],
): Context {
  const messages = context.messages
  if (!Array.isArray(messages) || messages.length === 0) return context
  // ISSUE #111: THE MESSAGE MUST BELONG TO THIS PLUGIN FIRST. The docblock
  // above used to claim `dsh-llm` splits history by provider, so a transcript
  // reaching this adapter could only contain this plugin's own turns. That is
  // NOT what the host does: `forAdapter()` (dsh-llm/lib/index.js:2151) only
  // STRIPS `replayState` from a message whose `source.provider` belongs to
  // another adapter — it keeps the message in the list. So a session that
  // switched providers (the user goes from DeepSeek official to WorkBuddy, or
  // back) hands this adapter assistant turns that this plugin never produced,
  // and the old code rewrote THEIR `provider` to `workbuddy` and their `api`
  // to `openai-completions`.
  //
  // That is worse than cosmetic. It relabels a foreign turn as this plugin's
  // own model output, so pi-ai's `isSameModel` compares it against the request
  // and can replay its reasoning as if this model had produced it. It also
  // makes the transcript claim a provenance that is false — the host's own
  // `forAdapter` went out of its way to clear `replayState` precisely so a
  // foreign turn would NOT be replayed, and rewriting the identity handed that
  // turn back through the door `forAdapter` had just closed.
  //
  // So the rewrite is scoped to the routes this bundle owns. A message from any
  // other provider is left EXACTLY as the host built it: its `api` stays
  // `dsh-foreign`, which is the host's honest marker for "not this adapter's
  // wire format", and its `provider` stays whatever that adapter registered.
  const owned = new Set(ownedRoutes)
  let changed = false
  const next = messages.map(message => {
    if (typeof message !== 'object' || message === null) return message
    const record = message as unknown as Record<string, unknown>
    if (record['role'] !== 'assistant') return message
    const provider = record['provider']
    // A foreign turn keeps its own identity. `identity` is accepted here too
    // because the identity IS this plugin's stamp: a message already carrying
    // it is ours by definition (that is the CN case, where route and identity
    // are the same string).
    if (typeof provider !== 'string' || !owned.has(provider) && provider !== identity) return message
    const providerAligned = provider === identity
    // Only the host's own fallback marker is repaired; every other api is the
    // shape this plugin really sends and must be preserved verbatim.
    const apiAligned = record['api'] !== HOST_FOREIGN_API
    if (providerAligned && apiAligned) return message
    changed = true
    const aligned = { ...record }
    if (!providerAligned) aligned['provider'] = identity
    if (!apiAligned) aligned['api'] = 'openai-completions'
    return aligned as unknown as typeof message
  })
  return changed ? { ...context, messages: next } : context
}

/**
 * One foreign thinking block that pi-ai would publish as PROSE, and the reason it
 * would (issue #147).
 *
 * `variant` is not cosmetic: the two are handled by the same repair but they
 * mean different things, and the card explains them differently.
 *
 * - `flattened`: `stopReason` is a normal completion, so `transform-messages`
 *   turns the block into `{type:'text', text: thinking}` — the whole reasoning
 *   body lands in the visible answer.
 * - `dropped`: `stopReason` is `error`/`aborted`, so the entire message is
 *   skipped; nothing reaches the wire and nothing reaches the user. It is
 *   reported anyway, because it still costs context: the model's answer to
 *   "why did my last turn say nothing" is this line, and a caller cannot see it
 *   from the transcript.
 */
export interface ForeignThinkingBlock {
  /** Index of the message in the context's `messages`. */
  messageIndex: number
  /** Index of the block within that message's `content`. */
  blockIndex: number
  /** How many characters of reasoning the block carried. */
  characters: number
  /** Whether pi-ai would flatten it into prose or drop the whole message. */
  variant: 'flattened' | 'dropped'
}

/** Read `content` as a block array without assuming the shape. */
function blocksOf(message: unknown): unknown[] {
  if (typeof message !== 'object' || message === null) return []
  const content = (message as Record<string, unknown>)['content']
  return Array.isArray(content) ? content : []
}

/**
 * Whether this assistant message's identity proves a DIFFERENT model produced it.
 *
 * `requestModelId` closes the THIRD leg of pi-ai's own predicate. `isSameModel`
 * is `provider === … && api === … && model === model.id`
 * (`transform-messages.js:68–70`); this function used to compare only the first
 * two. The consequence was a blind spot the size of one whole route: a session
 * that switches MODELS inside one region — `hy3` → `deepseek-v4.1-flash`, both
 * served by this bundle, both stamped `provider: workbuddy` — keeps the provider
 * and api legs equal, so nothing here noticed, while pi-ai flattened every
 * historical thinking block into the answer channel exactly as in issue #147.
 * The user-visible symptom is #147's, with none of its diagnostics.
 *
 * Passing `undefined` keeps the provider/api-only behaviour, which is what the
 * read-only surfaces and the older call sites expect. Production passes the id
 * of the model the request is actually addressed to.
 */
function isForeignAssistant(
  message: unknown,
  identity: string,
  requestModelId?: string,
): boolean {
  if (typeof message !== 'object' || message === null) return false
  const record = message as Record<string, unknown>
  if (record['role'] !== 'assistant') return false
  // The host's own fallback marker beats everything: `foreignAssistant()` sets
  // it precisely to say "this is not the wire format the current request uses".
  if (record['api'] === HOST_FOREIGN_API) return true
  const provider = record['provider']
  if (typeof provider !== 'string' || provider !== identity
    && provider !== WORKBUDDY_PROVIDER && provider !== WORKBUDDY_GLOBAL_PROVIDER) return true
  // Model leg. A message this bundle produced still degrades when the request
  // names a different model id, because that is what `isSameModel` compares.
  // `undefined` on either side means "cannot compare": stay silent rather than
  // report a block pi-ai would have kept.
  if (requestModelId === undefined) return false
  const model = record['model']
  return typeof model === 'string' && model !== requestModelId
}

/**
 * Whether this assistant turn came from a DIFFERENT PROVIDER/route, rather than
 * from a different model on one of this bundle's own routes.
 *
 * WHY THIS DISTINCTION EXISTS (issue #163's live scene). A session switched
 * from `dsh-opencode-go` to a WorkBuddy route mid-turn. The host rebuilt the
 * other provider's assistant turns as `dsh-foreign`, and pi-ai rewrote their
 * unsigned `thinking` blocks into visible `text` — 14,410 / 4,225 / 5,138
 * characters in the measured scene. WorkBuddy's gateway scans every assistant
 * message and refused the turn with business code 11128; all three in-place
 * rescue rungs and three auto-`继续` attempts failed because the bytes never
 * changed.
 *
 * A cross-provider thinking block is different from a same-route model switch:
 * it carries no `thinkingSignature` (the host builds `foreignAssistant()`
 * without one), so it could never be replayed as reasoning. Its only possible
 * contribution to the wire is the prose pi-ai manufactures from it. Dropping it
 * is therefore a correctness repair, not a preference — and it must happen
 * even when the user never opted into {@link dropForeignThinking}.
 *
 * Same-route model switches (`hy3` → `deepseek-v4.1-flash`) stay behind the
 * explicit switch, because those turns WERE produced by this bundle and their
 * reasoning may be worth keeping in the transcript for the user to read.
 */
function isCrossProviderAssistant(
  message: unknown,
  identity: string,
  ownedRoutes: readonly string[],
): boolean {
  if (typeof message !== 'object' || message === null) return false
  const record = message as Record<string, unknown>
  if (record['role'] !== 'assistant') return false
  // The host's fallback marker is the strongest signal: `foreignAssistant()`
  // sets it for a turn this adapter did not produce. After
  // `alignAssistantIdentities`, a turn this bundle owns has had the marker
  // repaired away, so a remaining marker means genuinely foreign.
  if (record['api'] === HOST_FOREIGN_API) return true
  const provider = record['provider']
  if (typeof provider !== 'string') return true
  return provider !== identity && !ownedRoutes.includes(provider)
}

/**
 * Every foreign thinking block pi-ai would turn into visible prose (issue #147).
 *
 * THE DEFECT. pi-ai keeps a historical `thinking` block only while
 * `isSameModel` holds — provider AND api AND model id all equal to the request
 * (`transform-messages.js:68`). For everything else it does NOT drop the block:
 * `:87–90` rewrites it to `{type:'text', text: thinking}`, which is the answer
 * channel. A session that moved between providers therefore arrives with its
 * other provider's working notes already spelled as prose, and the model reads
 * that shape and copies it.
 *
 * Issue #147 measured the consequence on a real 80-step turn: 56 assistant
 * messages carried an answer while their own `reasoning` was ≤ 1 character,
 * 20 of them held English working notes totalling 58,960 characters, and CJK
 * fell to 1.37% of the visible text where the preceding six turns had been
 * entirely Chinese. That is not a formatting complaint — it also pushed the
 * session from 696,966 to 758,005 total tokens against an 800,000 compression
 * threshold.
 *
 * WHY THIS IS READ-ONLY. Nothing here rewrites the transcript:
 * {@link dropForeignThinking} does, and the split keeps the DIAGNOSIS available
 * to surfaces that must not change bytes (the card, the reply notice).
 *
 * @param context - a pi-ai context, before or after `alignAssistantIdentities`.
 * @param identity - the identity this adapter stamps on its own models.
 * @param requestModelId - model id the request is addressed to, so the model
 *   leg of pi-ai's predicate is covered too (see {@link isForeignAssistant}).
 *   Omitted, only the provider/api legs are judged.
 * @returns one entry per affected block, in transcript order.
 */
export function foreignThinkingOf(
  context: Context,
  identity: string = WORKBUDDY_MODEL_IDENTITY,
  requestModelId?: string,
): ForeignThinkingBlock[] {
  const messages = (context as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return []
  const found: ForeignThinkingBlock[] = []
  for (const [messageIndex, message] of messages.entries()) {
    if (!isForeignAssistant(message, identity, requestModelId)) continue
    const record = message as Record<string, unknown>
    const stopReason = record['stopReason']
    // Mirrors `transform-messages.js`: an errored or aborted turn is skipped
    // wholesale, so its blocks would not have surfaced either way.
    const variant = stopReason === 'error' || stopReason === 'aborted' ? 'dropped' : 'flattened'
    for (const [blockIndex, block] of blocksOf(message).entries()) {
      if (typeof block !== 'object' || block === null) continue
      const fields = block as Record<string, unknown>
      if (fields['type'] !== 'thinking') continue
      // A REDACTED block is never shown as prose: pi-ai returns `[]` for it
      // (`:75–77`), so it is neither a leak nor a context cost worth naming.
      if (fields['redacted'] === true) continue
      const thinking = fields['thinking']
      const characters = typeof thinking === 'string' ? thinking.length : 0
      // Empty reasoning is dropped before any of the branches that matter
      // (`:83–84`), so reporting it would be a false positive.
      if (characters === 0) continue
      found.push({ messageIndex, blockIndex, characters, variant })
    }
  }
  return found
}

/**
 * The subset of {@link foreignThinkingOf} that is safe to repair without asking.
 *
 * This is the predicate the adapter uses when `dropForeignThinking` is OFF: a
 * turn from another provider/route is dropped unconditionally, because its
 * unsigned thinking block can never be replayed and its flattened prose is what
 * the WorkBuddy gateway refuses (issue #163's provider-switch scene). A turn
 * from this bundle under a different model id is NOT included — that one is
 * still the explicit switch's business.
 *
 * Runs after `alignAssistantIdentities`, so a global-region turn this bundle
 * owns has already had its `dsh-foreign` marker repaired away and is not
 * misclassified.
 */
export function crossProviderThinkingOf(
  context: Context,
  identity: string = WORKBUDDY_MODEL_IDENTITY,
  ownedRoutes: readonly string[] = [WORKBUDDY_PROVIDER, WORKBUDDY_GLOBAL_PROVIDER],
): ForeignThinkingBlock[] {
  const messages = (context as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return []
  return foreignThinkingOf(context, identity).filter(block =>
    isCrossProviderAssistant(messages[block.messageIndex], identity, ownedRoutes))
}

/**
 * Remove the foreign thinking blocks {@link foreignThinkingOf} finds.
 *
 * WHY REMOVAL IS THE HONEST REPAIR. The alternatives are both worse:
 *
 *   - LEAVE IT: pi-ai publishes the other provider's private working notes as
 *     this turn's answer (the #147 defect), so the user reads reasoning instead
 *     of a reply and the model imitates that shape forever after.
 *   - KEEP IT AS THINKING: impossible from here. `isSameModel` is pi-ai's own
 *     predicate over fields this plugin does not control (`model.provider` /
 *     `model.api` / `model.id` are compared against the MESSAGE's), and the
 *     only way to satisfy it is to claim the foreign turn as this model's own
 *     output — which is exactly the provenance lie issue #111 removed. These
 *     blocks carry no `thinkingSignature` (the host builds them that way), so
 *     they could not be replayed as signed reasoning even if claimed.
 *
 * Dropping is what the request builder already does with them in every other
 * branch: an unsigned foreign thinking block is never sent as
 * `reasoning_content`, so its only possible contribution to the wire was the
 * flattened prose this function removes. Every other block — text, tool calls —
 * is left exactly where it is, and so is every message's identity.
 *
 * Idempotent: a second pass finds nothing to remove. Returns the SAME context
 * object when nothing changed, so the common case allocates nothing.
 *
 * @param context - a pi-ai context.
 * @param identity - the identity this adapter stamps on its own models.
 * @param requestModelId - model id the request is addressed to (see
 *   {@link isForeignAssistant}); omitted, only the provider/api legs are judged.
 * @returns the repaired context, or the input when no block qualified.
 */
export function dropForeignThinking(
  context: Context,
  identity: string = WORKBUDDY_MODEL_IDENTITY,
  requestModelId?: string,
): Context {
  return dropThinkingBlocks(context, foreignThinkingOf(context, identity, requestModelId))
}

/** Remove exactly the listed blocks; the one place that edits a transcript. */
function dropThinkingBlocks(context: Context, affected: readonly ForeignThinkingBlock[]): Context {
  if (affected.length === 0) return context
  const messages = (context as unknown as { messages: unknown[] }).messages
  // Group by message first: each message is copied at most once, and a message
  // whose content becomes empty is left in place (pi-ai drops it anyway; moving
  // it here would renumber tool-result pairing for no benefit).
  const byMessage = new Map<number, Set<number>>()
  for (const block of affected) {
    const set = byMessage.get(block.messageIndex) ?? new Set<number>()
    set.add(block.blockIndex)
    byMessage.set(block.messageIndex, set)
  }
  const next = messages.map((message, index) => {
    const remove = byMessage.get(index)
    if (remove === undefined) return message
    const record = message as Record<string, unknown>
    const content = blocksOf(message).filter((_, blockIndex) => !remove.has(blockIndex))
    return { ...record, content }
  })
  return { ...context, messages: next } as Context
}

/**
 * How deeply this wrapper repairs the transcript before it reaches pi-ai.
 *
 * Both members are OFF by default, so a config that never mentions them sends
 * byte-for-byte what earlier builds sent (see {@link WorkBuddyAdapterOptions}).
 */
export interface TranscriptRepairOptions {
  /**
   * Drop SAME-ROUTE foreign thinking blocks pi-ai would publish as prose
   * (issue #147). `false` keeps the previous behaviour for a model switch
   * inside one route.
   *
   * Cross-provider turns are repaired regardless of this switch (issue #163's
   * provider-switch scene): their unsigned thinking blocks can never be
   * replayed, and their flattened prose is what the gateway refuses.
   */
  dropForeignThinking?: boolean
  /**
   * Told how many blocks that repair removed and where, so a surface can name
   * the condition the user is actually looking at. Called at most once per
   * request, and only when something was removed.
   */
  onForeignThinking?: (blocks: readonly ForeignThinkingBlock[]) => void
}

function withLegacyContext(
  api: ProviderStreams,
  generation: PiAiGeneration,
  identity: string = WORKBUDDY_MODEL_IDENTITY,
  ownedRoutes: readonly string[] = [WORKBUDDY_PROVIDER, WORKBUDDY_GLOBAL_PROVIDER],
  repair?: TranscriptRepairOptions,
): ProviderStreams {
  /** One place so both branches and both entry points agree on the order. */
  const prepare = (context: Context, requestModelId?: string): Context => {
    const folded = generation === 'modern' ? foldModernContext(context) : adaptLegacyPiAiContext(context)
    const aligned = alignAssistantIdentities(folded, identity, ownedRoutes)
    // ISSUE #147, AFTER alignment on purpose. `foreignThinkingOf` reads the
    // identity to decide what is foreign, so running it first would classify a
    // turn this plugin OWNS (route id still unaligned) as foreign and delete its
    // reasoning — issue #102's regression, from the other direction.
    //
    // ISSUE #163: a CROSS-PROVIDER turn is repaired even when the switch is
    // off. Its thinking block has no signature and can never be replayed, and
    // pi-ai would otherwise flatten it into assistant prose — which is the
    // content the WorkBuddy gateway refused in the measured provider-switch
    // scene. The switch only widens this to a same-route model switch, whose
    // turn this bundle did produce.
    //
    // `requestModelId` is pi-ai's third predicate leg. Without it a switch
    // BETWEEN MODELS inside one region (`hy3` → `deepseek-v4.1-flash`, both on
    // this route) degraded exactly like a cross-provider switch, while this
    // repair saw nothing to do: provider and api both still matched.
    const affected = repair?.dropForeignThinking === true
      ? foreignThinkingOf(aligned, identity, requestModelId)
      : crossProviderThinkingOf(aligned, identity, ownedRoutes)
    if (affected.length === 0) return aligned
    try {
      repair?.onForeignThinking?.(affected)
    } catch {
      // A diagnostic must never fail a chat request.
    }
    return dropThinkingBlocks(aligned, affected)
  }
  if (generation === 'modern') {
    return {
      ...api,
      stream: (model, context, options) =>
        api.stream(model, transcript<Parameters<typeof api.stream>[1]>(prepare(context, model.id)), options),
      streamSimple: (model, context, options) =>
        api.streamSimple(
          model,
          transcript<Parameters<typeof api.streamSimple>[1]>(prepare(context, model.id)),
          options,
        ),
    }
  }
  return {
    ...api,
    stream: (model, context, options) =>
      api.stream(model, transcript<Parameters<typeof api.stream>[1]>(prepare(context, model.id)), options),
    streamSimple: (model, context, options) =>
      api.streamSimple(
        model,
        transcript<Parameters<typeof api.streamSimple>[1]>(prepare(context, model.id)),
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
 * The tier {@link EffortNormalizingAdapter} pins a model to when the model
 * carries no reasoning metadata of its own.
 *
 * `off` is the ONE tier pi-ai offers for such a model (`getSupportedThinkingLevels`
 * returns `['off']` whenever `model.reasoning` is false), and the host's own
 * translation of it is "send no reasoning field at all" (`profileOptions` turns
 * `off` into `enabledReasoning = undefined`). So pinning it neither invents a
 * capability nor changes one byte of the upstream request body.
 */
const NO_REASONING_EFFORT = ReasoningEffortId('off')

/** What the host is told a reasoning-less model supports: exactly that tier. */
const NO_REASONING_EFFORTS: LlmModelReasoningInfo = {
  efforts: [{ id: NO_REASONING_EFFORT, name: 'Off' }],
}

/**
 * pi-ai adapter that keeps a model WITHOUT reasoning metadata dispatchable
 * (issue #90, the `UNSUPPORTED_REASONING_EFFORT` half).
 *
 * THE FAILURE. `profileFor` pins one default tier per ROUTE
 * (`reasoning: WORKBUDDY_DEFAULT_EFFORT`, issue #83), and `dsh-llm-pi-ai`
 * resolves every request as `options.reasoningEffort ?? profile.reasoning`. For
 * a model whose catalog entry carries no `reasoning` block at all — the live CN
 * catalog has six of them (`default`, `glm-5.0`, `glm-4.7`, `glm-4.6`,
 * `hunyuan-chat`, `hunyuan-image-alpha`), the live global one two
 * (`default-model`, `deep-model`), and EVERY entry of both static fallback lists
 * — the inherited `high` is not a tier that model has. (`default-model` is the
 * international `auto` router and is not offered as a row since 5.0.1; the
 * measurement is kept verbatim because the defect it documents was observed
 * against the full roster.) `resolveReasoningLevel`
 * then throws `UNSUPPORTED_REASONING_EFFORT` before the request is even built,
 * so the model is unusable locally: no wire call, no upstream error, nothing to
 * retry. Introduced by v4.11.0, which made the profile default explicit; before
 * it the default was absent and pi-ai clamped instead of throwing.
 *
 * TWO GATES, BOTH CLOSED. The host checks the adapter's own model metadata
 * first: `resolveCallWithInfo` rejects ANY explicitly requested tier on a model
 * whose `reasoning` is absent, and `reasoningInfo` omits the field exactly for
 * models without metadata — so even `off` was refused. Then `PiAiAdapter.streamWithSnapshot`
 * rejects the route default it inherited. A fix at either seam alone still
 * fails at the other.
 *
 * THE FIX. Advertise the one tier pi-ai will actually accept for such a model
 * (`off`) and normalize the request to it at the dispatch seam, so
 * `resolveReasoningLevel` sees a supported tier and `profileOptions` sends no
 * reasoning field. Nothing about the wire body changes — pi-ai never emits
 * `reasoning_effort` for a model whose descriptor has `reasoning: false`.
 *
 * WHAT STAYS STRICT. A tier the caller EXPLICITLY asks for on a model that
 * cannot do it is still rejected, by the host, with an accurate message. That
 * is the pre-v4.11.0 contract too, and it is not this bug: the bug is a request
 * that named no tier being killed by the route's own default.
 */
class EffortNormalizingAdapter extends PiAiAdapter {
  /**
   * Whether one exact model id currently carries reasoning metadata. Read live
   * on every call because the catalog is refreshed behind the adapter
   * (`invalidate`), and a model that gains metadata mid-session must stop being
   * normalized at once.
   */
  private readonly effortCapable: (model: string) => boolean

  /**
   * The tier one exact model should advertise as its default when a caller
   * names none (issue #179).
   *
   * Read LIVE per resolve/prepare call, like {@link effortCapable}: the user can
   * change the choice mid-session, and `applySelection` re-invalidates the
   * catalog on every settings change. A captured value would make the picker
   * show the new default while requests kept the old one.
   *
   * Returns `undefined` for a model with no tier vocabulary — the caller then
   * leaves the advertised `reasoning` block exactly as pi-ai built it, which is
   * the `off`-only shape `advertiseOffOnly` below depends on.
   */
  private readonly defaultEffort: (model: string) => string | undefined

  constructor(
    config: PiAiAdapterOptions,
    effortCapable: (model: string) => boolean,
    defaultEffort: (model: string) => string | undefined = () => undefined,
  ) {
    super(config)
    this.effortCapable = effortCapable
    this.defaultEffort = defaultEffort
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.advertiseDefaultEffort(this.advertiseOffOnly(await super.resolveModel(provider, model, signal)))
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const call = await super.prepareCall(provider, model, signal)
    // Both halves matter: the host validates `model` before it ever calls
    // `stream`, and `stream` is what actually reaches `resolveReasoningLevel`.
    return {
      model: this.advertiseDefaultEffort(this.advertiseOffOnly(call.model)),
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => call.stream(this.pinEffort(options)),
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return super.stream(this.pinEffort(options))
  }

  /**
   * Advertise the per-model default tier (issue #179).
   *
   * The host materializes `reasoningEffort` into EVERY request that names none
   * from this exact field (`LlmRuntime.resolveCallWithInfo`), which is what makes
   * a saved per-model default real rather than a display preference: without
   * `defaultEffort` the host leaves the config field empty and pi-ai falls back
   * to `profile.reasoning` — the one route-wide constant this feature exists to
   * replace.
   *
   * Deliberately a no-op when the model declares no tier: pi-ai's `off`-only
   * block must keep its EXACT advertised shape, or the host's prepared-call
   * config check (`callConfigEquals`) starts disagreeing with callers that omit
   * the field — see `advertiseOffOnly` above.
   */
  private advertiseDefaultEffort(info: LlmResolvedModelInfo): LlmResolvedModelInfo {
    if (info.reasoning === undefined) return info
    const effort = this.defaultEffort(info.id)
    if (effort === undefined) return info
    // Never contradict the tier list: an entry the host would reject is worse
    // than no default at all (issue #90's `UNSUPPORTED_REASONING_EFFORT`).
    if (!info.reasoning.efforts.some(level => level.id === effort)) return info
    if (info.reasoning.defaultEffort === effort) return info
    return {
      ...info,
      reasoning: { ...info.reasoning, defaultEffort: ReasoningEffortId(effort) },
    }
  }

  /**
   * Give a reasoning-less model the one tier it can dispatch at. No
   * `defaultEffort` on purpose: the host materializes one into EVERY request
   * that names no tier, and that would turn the host's own prepared-call config
   * check (`callConfigEquals`) against callers that omit the field.
   */
  private advertiseOffOnly(info: LlmResolvedModelInfo): LlmResolvedModelInfo {
    return info.reasoning === undefined ? { ...info, reasoning: NO_REASONING_EFFORTS } : info
  }

  /** Replace an unusable tier with the one pi-ai accepts for this model. */
  private pinEffort(options: GenerateOptions): GenerateOptions {
    if (this.effortCapable(options.model)) return options
    return options.reasoningEffort === NO_REASONING_EFFORT
      ? options
      : { ...options, reasoningEffort: NO_REASONING_EFFORT }
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
  // The model identity is shared by both regions on purpose — that is the whole
  // of issue #59's fix, and it is NOT inert (issue #75): `requireProvider` and
  // `getAuth` resolve the registry BY the stamped `model.provider`. The route
  // id below is NOT shared: it keys the registry a user selects from, and each
  // region's route resolves to that region's own shim. So the identity is
  // published as an EXTRA registry key of the same route (see
  // `modelIdentityKeysOf`) instead of replacing the route id — the two halves
  // of #59 and #75 that way stay true at once.
  const modelIdentity = options.modelIdentity ?? WORKBUDDY_MODEL_IDENTITY
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
    api: withContextRescue(
      // BOTH of this bundle's routes are owned by this adapter, so a message
      // stamped with either is ours to align (issue #111). Anything else in
      // the transcript belongs to another provider and is left untouched.
      withLegacyContext(openAICompletionsApi(), generation, modelIdentity, undefined, {
        // Both read per request: the switch is meant to be flipped WHILE
        // looking at the bad turn, and a captured boolean would need a reload.
        get dropForeignThinking() { return options.dropForeignThinking?.() === true },
        ...options.onForeignThinking === undefined ? {} : { onForeignThinking: options.onForeignThinking },
      }),
      options.resolveContextRescue,
    ),
  })

  // `getModels` is delegated to a live read (the reuse-catalog pattern from
  // dsh-llm-pi-ai): stream dispatch still runs through the constructed
  // provider, while the catalog answer tracks the upstream refresh.
  const provider: Provider = { ...base, getModels: () => buildModels() }

  // One profile per published registry key. The `piProvider` is what actually
  // lands in the registry, and `Models.setProvider` keys that map on
  // `piProvider.id` (`models.js:37` on 0.85.1, `:49` on 1.1.0) — NOT on the
  // profile's `provider` field — so the identity key needs a provider object
  // that CLAIMS that id. It is the route's own provider under a second id, so
  // the models, baseUrl, api and auth the request runs with stay this region's
  // and nothing about the gateway is duplicated. Sharing the very same object
  // under both keys would register the route id twice and leave the stamped
  // identity unresolved, which is exactly issue #75.
  const profileFor = (key: string): ResolvedPiAiProviderProfile => ({
    provider: key,
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
    /**
     * The ROUTE-WIDE fallback tier, pinned to the SAME value pi-ai's level map
     * would fill in for an absent one (issue #83).
     *
     * `dsh-llm-pi-ai` resolves every request's tier as
     * `options.reasoningEffort ?? profile.reasoning`, so an absent default here
     * means "whatever pi-ai fills in" — and for a model whose map carried
     * `off → "off"`, that was `"off"`, i.e. every compaction summary asked a
     * model like `deepseek-v4.1-flash` to disable thinking, which it answers with
     * 400 / 11133. Nothing structurally prevents a level or a catalog snapshot
     * from disagreeing with the adapter's own map, so the default must never be
     * that.
     *
     * Since issue #179 this is only the LAST resort: `advertiseDefaultEffort`
     * publishes the user's per-MODEL choice as `defaultEffort`, and the host
     * materializes that into every request that names none — so a user who
     * picked `low` for one model gets `low` while every other model keeps its own
     * upstream default. This constant survives for a model whose catalog entry
     * declares no default at all, which is the only case that reaches here.
     */
    reasoning: WORKBUDDY_DEFAULT_EFFORT,
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: key === providerId ? provider : { ...provider, id: key },
  })

  // Single source for BOTH the initial map and `invalidate`: an `invalidate`
  // that rebuilt only the route key would silently re-break the identity key,
  // i.e. issue #75 all over again on the first catalog refresh.
  const buildProfiles = (): Map<string, ResolvedPiAiProviderProfile> =>
    new Map(modelIdentityKeysOf(providerId, modelIdentity)
      .map((key): [string, ResolvedPiAiProviderProfile] => [key, profileFor(key)]))

  // Replacing (not mutating) the map is what `invalidate` uses to force the
  // adapter's next profiles read to rebuild its snapshot.
  let profiles = buildProfiles()

  /**
   * Whether one exact model id currently advertises ANY thinking tier.
   *
   * Same predicate `toPiModel` derives the descriptor's `reasoning` flag from,
   * so the two can never disagree — and it reads the live catalog, so a refresh
   * that adds (or drops) metadata for a model takes effect on the next request
   * without an `invalidate` round trip.
   */
  const effortCapable = (model: string): boolean =>
    catalog.current().some(info => info.id === model && workBuddyThinkingLevelMap(info) !== undefined)

  /**
   * The tier one exact model should run on when a caller names none (#179).
   *
   * Resolved against the LIVE catalog and the user's LIVE saved map, exactly
   * like `effortCapable`: the answer is a function of two things that both
   * change mid-session, and caching either would let the advertised default and
   * the dispatched tier drift apart.
   */
  const resolveDefaultEffort = (model: string): string | undefined => {
    const info = catalog.current().find(entry => entry.id === model)
    if (info === undefined) return undefined
    return defaultEffortFor(info, options.defaultThinkingEfforts?.() ?? {})
  }

  const adapter = new EffortNormalizingAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // Resolve the shim's per-process shared secret as the OpenAI apiKey so
    // pi-ai sends it as `Authorization: Bearer <shared-secret>`. The shim
    // validates this before forwarding and resolves the real WorkBuddy token
    // itself via the store, so the secret never reaches upstream.
    resolveApiKey: async () => shim.token(),
    ...resolveAttachments === undefined ? {} : { resolveAttachments },
  }, effortCapable, resolveDefaultEffort)

  return {
    adapter,
    invalidate: () => {
      profiles = buildProfiles()
    },
  }
}
