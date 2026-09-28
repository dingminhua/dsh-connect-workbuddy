/**
 * Model-native multimodality, vendored from vendor documentation.
 *
 * The upstream catalog's `supportsImages` is the PLATFORM's image-input
 * declaration, not the model's native capability: on live data it is `true`
 * for 15/16 CN and 23/23 international models, including text-only ones. Using
 * it as the capability answer is a mistake this project already made once (see
 * `docs/DESIGN.md` 「图片输入」), and the sibling `workbuddy-manager` project hit
 * the same defect and fixed it the same way — a reviewed table keyed by exact
 * model id, with a source and a review date per entry.
 *
 * This snapshot is copied from that project's
 * `server/services/native_modalities.json` (all entries reviewed 2026-09-25).
 * The provenance — per-id source URL and evidence — is kept in
 * `docs/DESIGN.md` rather than here, because the build ships this module's
 * comments verbatim into the browser bundle. Keep the two in sync when either
 * side is updated; this is a maintained snapshot, NOT a live read.
 *
 * Only two states are vendored because only two are ever confirmed: an id is
 * either documented `multimodal` or documented `text`. Everything else —
 * including brand-new models — is `unknown` and MUST stay unclassified rather
 * than inheriting a neighbour's answer or the platform flag.
 *
 * @module dsh-connect-workbuddy/native-modality
 */

/** Documented native input modality for one exact model id. */
export type WorkBuddyNativeModality = 'text' | 'multimodal' | 'router' | 'unknown'

/**
 * Reviewed vendor classifications, keyed by EXACT model id (never a prefix).
 * Ids absent from this record are `unknown` — see {@link nativeModalityOf}.
 */
export const NATIVE_MODALITY_BY_MODEL_ID: Readonly<Record<string, 'text' | 'multimodal'>> = {
  // ── Documented text-only ──
  'deepseek-v4-pro': 'text',
  'glm-5.1': 'text',
  'glm-5.2': 'text',
  'glm-5.3': 'text',
  'hy3': 'text',
  'hy4-preview': 'text',
  // ── Documented native multimodal ──
  'deepseek-v4.1-flash': 'multimodal',
  'glm-5.3-flash': 'multimodal',
  'glm-5v-turbo': 'multimodal',
  'kimi-k2.6': 'multimodal',
  'kimi-k2.7': 'multimodal',
  'kimi-k3-1': 'multimodal',
  'minimax-m3': 'multimodal',
}

/** The `auto` entry is a router that picks a model, not a model itself. */
const ROUTER_MODEL_ID = 'auto'

/**
 * Native modality of one model id. Exact match only: a new model never
 * inherits a classification from its family, its display name, or the
 * platform's image flag.
 */
export function nativeModalityOf(modelId: string): WorkBuddyNativeModality {
  if (modelId === ROUTER_MODEL_ID) return 'router'
  return NATIVE_MODALITY_BY_MODEL_ID[modelId] ?? 'unknown'
}

/**
 * Whether a model refresh should PRE-CHECK this model's image box.
 *
 * Only a documented `multimodal` is pre-checked. `text` is documented as
 * unable to read images, and `unknown` is deliberately left unchecked rather
 * than guessed — the whole reason this table exists is that the platform flag
 * guessed wrong. A platform `supportsImages: false` still vetoes, so a
 * documented-multimodal id can never be pre-checked against the platform's
 * explicit "no".
 *
 * The user can always tick a box by hand; this decides a DEFAULT only, and the
 * effective runtime flag remains the saved `imageModelIds`.
 */
export function imageDefaultFor(info: { id: string; supportsImages?: boolean }): boolean {
  if (info.supportsImages === false) return false
  return NATIVE_MODALITY_BY_MODEL_ID[info.id] === 'multimodal'
}
