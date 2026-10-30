/**
 * Which thinking tier a model runs on when the caller names none (issue #179).
 *
 * The user asked for a per-model default so they can pick `low` once and stop
 * re-picking it in the host's model menu on every new conversation. The card
 * already stores that choice (`defaultThinkingEfforts`, see `regionStateConfig`);
 * this module is the one place that turns the stored answer plus the upstream
 * declaration into the SINGLE tier the runtime can defend.
 *
 * WHY THIS IS NOT A ONE-LINER. Three seams have to agree, and each has bitten
 * this bundle already:
 *
 *   1. The host materializes `reasoningEffort` into every request that names
 *      none, from the `defaultEffort` the ADAPTER advertises
 *      (`LlmRuntime.resolveCallWithInfo`). Advertise a tier the model does not
 *      declare and the request dies with `UNSUPPORTED_REASONING_EFFORT` before
 *      any byte reaches the gateway (issue #90).
 *   2. `dsh-llm-pi-ai` resolves the dispatch tier as
 *      `options.reasoningEffort ?? profile.reasoning`, and the profile is
 *      per-ROUTE — one constant for a roster whose vocabularies disagree.
 *   3. Leaving the tier absent is NOT "no opinion": pi-ai then fills in the
 *      level map's `off`, which the upstream answers with 400 / 11133 and which
 *      broke `/compact` for good (issue #83).
 *
 * So the rule is always "name one tier, and only ever one this model declares",
 * with the user's saved choice winning over the upstream's own default.
 */

import type { WorkBuddyReasoning } from './upstream.ts'

/** The tiers DSH/pi-ai speak. Mirrors `THINKING_LEVELS` in `./adapter.ts`. */
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * The tier this bundle assumed before issue #179, and the last-resort fallback.
 *
 * Kept as the final fallback rather than becoming dead: a model that declares
 * `canDisableThinking` only (no tier list) still needs an explicit tier the way
 * it always did, and #83's fix — never leave the choice to pi-ai — must survive
 * this feature.
 */
export const WORKBUDDY_DEFAULT_EFFORT = 'high' as const

/** The subset of a model descriptor this module reads. */
export interface DefaultEffortSource {
  id: string
  reasoning?: WorkBuddyReasoning
}

/**
 * The tiers a model actually declares, in DSH's order, without `off`.
 *
 * `off` is excluded deliberately: it is a DIFFERENT question with its own owner
 * (`offModelIds` / `src/off-thinking.ts`, issue #34), and a "default thinking
 * effort" of `off` would silently re-open the #83 defect for every caller that
 * names no tier.
 */
export function declaredEfforts(reasoning: WorkBuddyReasoning | undefined): string[] {
  const supported = reasoning?.supportedEfforts ?? []
  return THINKING_LEVELS.filter(level => (supported as readonly string[]).includes(level))
}

/**
 * The one tier a model should dispatch at when a caller names none.
 *
 * @param model - the catalog entry, carrying the upstream's own declaration.
 * @param saved - the user's per-model choice, keyed by model id; an absent (or
 *   unsupported, or stale) entry falls through to the upstream default.
 * @returns a tier the model declares, or `undefined` when it declares none — in
 *   which case the adapter's existing `off` normalization (issue #90) is still
 *   the right answer and this module must not invent one.
 */
export function defaultEffortFor(
  model: DefaultEffortSource,
  saved: Readonly<Record<string, string | undefined>> = {},
): string | undefined {
  const declared = declaredEfforts(model.reasoning)
  // No tier vocabulary at all: the model dispatches through the `off`
  // normalization, which is a no-op on the wire. Returning a tier here would
  // resurrect `UNSUPPORTED_REASONING_EFFORT` for exactly these models.
  if (declared.length === 0) return undefined
  const asked = saved[model.id]
  // A saved value that this model does not declare is treated as ABSENT rather
  // than as an error. The catalog changes under the user (a model can lose a
  // tier between refreshes), and failing the request would be a worse answer
  // than falling back — the card re-reads the declaration and shows the real
  // list, so the stale choice is visible where it can be corrected.
  if (typeof asked === 'string' && declared.includes(asked)) return asked
  const upstreamDefault = model.reasoning?.defaultEffort
  if (typeof upstreamDefault === 'string' && declared.includes(upstreamDefault)) return upstreamDefault
  if (declared.includes(WORKBUDDY_DEFAULT_EFFORT)) return WORKBUDDY_DEFAULT_EFFORT
  return declared[0]
}

/**
 * The tier list the card offers for one model.
 *
 * Exactly the model's own declared tiers — no localising, no cross-model
 * unification. The vocabularies genuinely differ (`low/high/max` on deepseek,
 * `high/xhigh` on glm-5.2), so a synthesized ladder would offer rows that fail,
 * and the upstream's names are what the user sees in every other client.
 */
export function selectableEfforts(reasoning: WorkBuddyReasoning | undefined): string[] {
  return declaredEfforts(reasoning)
}
