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
  // `space-bunny` and `minimax-m3.1-flash` are recorded from the upstream
  // catalog's OWN description for those ids on the CN gateway: both read
  // 「支持原生多模态输入」/「原生多模态」 verbatim (measured 2026-10-30 against the
  // live roster this profile carries). They were missing from the reviewed
  // snapshot, so every refresh stamped them text-only and the host refused a
  // pasted image with MODEL_DOES_NOT_SUPPORT_IMAGES — the same shape as #168.
  // A description is weaker evidence than vendor documentation, so it is stated
  // here rather than assumed: an id the catalog describes as native multimodal
  // is multimodal for THIS build.
  'deepseek-v4.1-flash': 'multimodal',
  'glm-5.3-flash': 'multimodal',
  'glm-5v-turbo': 'multimodal',
  'kimi-k2.6': 'multimodal',
  'kimi-k2.7': 'multimodal',
  'kimi-k3-1': 'multimodal',
  'minimax-m3': 'multimodal',
  'minimax-m3.1-flash': 'multimodal',
  'space-bunny': 'multimodal',
}

/**
 * Ids the upstream lists in the model roster that are ROUTERS, not models.
 *
 * Two of them are known, one per region, and they are the SAME concept under
 * two ids:
 *
 * - `auto` (CN gateway) — the gateway resolves it to whichever model it
 *   considers the best fit (measured: CN `auto` → `hy4-preview`), and its own
 *   description says so outright: 「平衡效果与速度。自动为每个任务匹配最优模型，
 *   积分倍率随之浮动」 ("picks the best model per task; the credit multiplier
 *   floats accordingly").
 * - `default-model` (international gateway) — identical role (name "Auto",
 *   `isDefault: true`, the region's default pick), also the ONLY entry in that
 *   roster that declares no `credits` at all.
 *
 * The evidence for treating both as routers is the shared, self-describing
 * shape, not the name: measured 2026-10-22 against both live gateways, these
 * two entries are the ONLY ones whose `credits` field is absent/empty (CN 19
 * of 20 priced, global 27 of 28), and the ones carrying `isDefault: true`.
 * A row the plugin cannot price is a row whose cost it cannot state, and the
 * router duplicates a real row already in the same roster.
 *
 * Kept as an explicit table rather than a heuristic: a router is an upstream
 * concept with no declared flag, and guessing from the name would eventually
 * hide a real model. Add an id here only after the same kind of evidence.
 */
export const ROUTER_MODEL_IDS: ReadonlySet<string> = new Set(['auto', 'default-model'])

/** Whether this id is an upstream router rather than a model. */
export function isRouterModelId(modelId: string): boolean {
  return ROUTER_MODEL_IDS.has(modelId)
}

/**
 * Native modality of one model id. Exact match only: a new model never
 * inherits a classification from its family, its display name, or the
 * platform's image flag.
 */
export function nativeModalityOf(modelId: string): WorkBuddyNativeModality {
  if (isRouterModelId(modelId)) return 'router'
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
