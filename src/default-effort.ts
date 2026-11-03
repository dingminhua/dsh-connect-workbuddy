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
 * with the user's saved choice winning over the upstream's own default — and the
 * last-resort fallback NEVER the model's weakest tier (qoder 518ecbb).
 */

import type { WorkBuddyReasoning } from './upstream.ts'

/** The tiers DSH/pi-ai speak. Mirrors `THINKING_LEVELS` in `./adapter.ts`. */
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * The tier this bundle assumed before issue #179, and the last-resort fallback.
 *
 * Kept alive as the ROUTE-WIDE dispatch fallback in `profileFor` (issue #83's
 * fix — never leave the choice to pi-ai — must survive this feature). It is
 * deliberately NOT part of `defaultEffortFor` any more: it is a single constant
 * for a roster whose vocabularies disagree, so as a per-model default it can
 * name a tier a model does not declare (host: UNSUPPORTED_REASONING_EFFORT), or
 * one that is NOT the tier the upstream declared as that model's default. The
 * per-model answer is resolved by `defaultEffortFor` instead.
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
 *   unsupported, or stale) entry falls through to the upstream default, then to
 *   this model's own MIDDLE tier (never its weakest one).
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
  // Neither the user nor the upstream has an opinion, so fall back to THIS
  // model's own MIDDLE tier — never to `declared[0]`, its weakest one.
  //
  // That last step is qoder 518ecbb's fix, and its own test suite is what caught
  // it: the fallback was the first declared tier, and for the `low/high/max`
  // family `declared[0]` is `low` — i.e. a model that declares thinking tiers
  // would have defaulted to the weakest one, which is indistinguishable from
  // having turned thinking down. Measured in this bundle's own live catalogs:
  // `hy3` declares `['low']` with no default, `default-model` `['low','medium']`,
  // and `hy3-x` `['low','high']` — `declared[0]` answers `low` for all three.
  //
  // Take the UPPER middle (`Math.floor(len / 2)`), not qoder's lower middle
  // (`Math.floor((len-1) / 2)`): with an even-sized vocabulary the lower middle
  // IS the weakest tier (`['low','high']` → `low`), so qoder's own formula still
  // contradicts its rule for exactly those rosters. The upper middle is never
  // index 0 for any vocabulary with two or more tiers, and it keeps `high` for
  // `low/high/max` and `low/high` alike.
  //
  // `WORKBUDDY_DEFAULT_EFFORT` is NOT consulted here on purpose. It is a
  // route-wide constant, and this is a per-model question: the whole point of
  // the saved map is that one constant cannot be right for the roster.
  return declared[Math.floor(declared.length / 2)]
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
