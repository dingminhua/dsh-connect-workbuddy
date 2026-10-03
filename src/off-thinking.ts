/**
 * Which models can actually turn thinking OFF.
 *
 * The upstream catalog declares `reasoning.canDisableThinking`, and for ten
 * models that declaration is WRONG: they answer HTTP 400 to
 * `reasoning_effort: "off"` (issue #34). The refusal does not name the
 * parameter (`extError.param` is empty), and because the level is part of the
 * saved per-model selection, the failure repeats on EVERY later request until
 * the user picks another level — so it reads as "this model is broken" rather
 * than "this one setting is invalid".
 *
 * Measured on 3.4.4 across both gateways (`workbuddy.ai` and `codebuddy.cn`):
 * 23 models accept `off`, the nine listed in {@link REFUSES_OFF_MODEL_IDS}
 * answer 400, and every OTHER effort value (`minimal`/`low`/`medium`/`high`/
 * `xhigh`/`max`) plus omitting the field entirely returns HTTP 200 on all of
 * them. `off` is the only level that fails.
 *
 * This is the same shape of defect, and the same remedy, as
 * `src/native-modality.ts`: a reviewed table keyed by EXACT model id, because
 * no declared field separates the two groups. On the accepting side sit
 * GLM/Kimi/MiniMax plus `fast-model`/`balanced-model`/`auto`/`hy3`; on the
 * refusing side sit the DeepSeek-v4/GPT/Gemini frontier models plus
 * `primary-model`; and both sides declare identical capabilities.
 *
 * @module dsh-connect-workbuddy/off-thinking
 */

import type { WorkBuddyReasoning } from './upstream.ts'

/**
 * Ids observed to REFUSE `reasoning_effort: "off"` with HTTP 400 despite
 * declaring `canDisableThinking: true` (issue #34).
 *
 * Keyed by exact model id and deliberately NOT by region: `deepseek-v4.1-flash`
 * refuses on BOTH gateways, and the split tracks the model family rather than
 * the gateway. The cost is asymmetric — offering a level that always fails
 * costs the user every request for that model, while hiding one that would have
 * worked costs a single option — so the table errs towards hiding. A user who
 * knows better can override any entry (see {@link effectiveOff}).
 *
 * `deepseek-v4-pro` was measured on the CN gateway only; it is listed because
 * its sibling does refuse on both, and the same asymmetry argues for hiding.
 */
export const REFUSES_OFF_MODEL_IDS: ReadonlySet<string> = new Set([
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-sg',
  'deepseek-v4-pro',
  'primary-model',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gemini-3.5-flash',
])

/** The two fields this rule needs; both are declared by the model itself. */
export interface WorkBuddyOffCapability {
  id: string
  reasoning?: WorkBuddyReasoning
}

/**
 * Whether `off` should be offered for a model when the user has expressed no
 * opinion: the upstream's declaration, minus the ids known to refuse it.
 *
 * Only an explicit `canDisableThinking: true` enables the level; absence is
 * "unknown" and stays unoffered, matching how the rest of the plugin treats an
 * undeclared capability.
 */
export function offDefaultFor(info: WorkBuddyOffCapability): boolean {
  return info.reasoning?.canDisableThinking === true && !REFUSES_OFF_MODEL_IDS.has(info.id)
}

/**
 * Whether `off` is offered for a model, honouring the user's explicit answer.
 *
 * The saved map is an OVERRIDE, not a replacement: an absent key means "use
 * {@link offDefaultFor}", which is what keeps `off` available for the 23 models
 * that genuinely accept it on a profile that has never saved an opinion (a
 * plain saved LIST could not express that — an empty list is indistinguishable
 * from "the user unchecked everything"). Both directions are honoured, so a
 * model added upstream that refuses `off` can be turned off by the user without
 * a plugin release, and a table entry that turns out to be wrong can be turned
 * back on.
 */
export function effectiveOff(
  info: WorkBuddyOffCapability,
  overrides: Readonly<Record<string, boolean | undefined>> = {},
): boolean {
  const override = overrides[info.id]
  return typeof override === 'boolean' ? override : offDefaultFor(info)
}

/**
 * Stamp the effective answer onto a model list, for the RUNTIME catalog.
 *
 * The runtime model descriptor is built by `workBuddyThinkingLevelMap`, which
 * reads only the model's own declaration — so the corrected answer has to be
 * written onto the model before it reaches the adapter. Doing it here keeps the
 * adapter a pure "declared capability in, level map out" function and keeps the
 * rule next to the table it comes from.
 *
 * This OVERWRITES the declared field rather than adding a sibling, which is
 * safe because the declared value has exactly one consumer (that same level
 * map) and is never persisted where the card can see it: `toWebModel` drops
 * `canDisableThinking`, and the card's `lastCatalog` is written from the raw
 * upstream discovery, never from this stamped list. A model that declares no
 * reasoning is returned untouched — there is no level to correct.
 */
export function withEffectiveOff<T extends WorkBuddyOffCapability>(
  models: readonly T[],
  overrides: Readonly<Record<string, boolean | undefined>> = {},
): T[] {
  return models.map(model => model.reasoning === undefined
    ? model
    : {
        ...model,
        reasoning: { ...model.reasoning, canDisableThinking: effectiveOff(model, overrides) },
      } as T)
}
