/**
 * The saved model directory (`lastCatalog`) and the LIVE upstream roster.
 *
 * ISSUES #114 AND #115. Both are the SAME defect seen from two sides: the
 * saved directory won over the live roster, and the saved directory is
 * allowed to go stale forever.
 *
 * WHAT THE SAVED DIRECTORY IS. `lastCatalog` is the user's saved selection of
 * models — the list the card edits, and the only thing that survives a
 * restart. It is NOT a capability cache and it is NOT the source of truth
 * about what the upstream currently offers.
 *
 * WHAT WENT WRONG, IN TWO STEPS.
 *
 * 1. `configuredModels()` resolved its roster as "saved directory if it is
 *    non-empty, else the live roster, else the static fallback". A saved
 *    directory therefore SUPPRESSED the live roster permanently: a model the
 *    upstream added (`deepseek-v4.1-flash` on the CN roster) could never reach
 *    the user, and the only thing that changed the saved directory was the
 *    card's explicit save. That is issue #115.
 *
 * 2. The saved directory was ALSO allowed to be seeded with the STATIC
 *    fallback table — a table that carries ids, names and token limits but no
 *    `reasoning` block. A model entry with no `reasoning` declares no thinking
 *    tiers at all, so `workBuddyThinkingLevelMap()` answers `undefined`, the
 *    model is published with `reasoning: false`, and the host offers exactly
 *    `Default` and `Off`. That is issue #114.
 *
 *    Worse, the save was a LOOP: the card wrote back `visibleModels`, which
 *    came from the saved directory, so a stale directory was re-saved as
 *    itself and the upstream's real capabilities could never be learned.
 *
 * THE FIX HAS THREE PARTS, and the third is the reason this is a module
 * rather than a one-line change.
 *
 * - The saved directory is a NAMES list; CAPABILITIES always come from the
 *   live roster ({@link overlayLiveCapabilities}).
 * - The live roster is merged OVER the saved one, not the other way round
 *   ({@link mergeRoster}), so a model the upstream withdrew but the user is
 *   still running stays offered (issue #32's rule), while a model the
 *   upstream ADDED appears.
 * - The saved directory is REPAIRED once the live roster lands
 *   ({@link repairedCatalog}), and a saved directory that is byte-identical
 *   to the static fallback table is recognised as "never really configured"
 *   ({@link isUnconfiguredFallbackSnapshot}).
 *
 * WHY THE OVERLAY LIVES ON READ RATHER THAN IN THE SAVED DIRECTORY. The saved
 * directory CAN carry the capability fields — the settings schema keeps every
 * key the write carries, and `resolveConfig` returns them unchanged (both
 * verified against the host's own `projectForm` / standard validate). But it
 * did not help: what poisoned the directory was not a stripped field, it was
 * the STATIC FALLBACK TABLE being written into it in the first place, and a
 * table that declares no `reasoning` at all. Once that table is the saved
 * directory, the card saves it back unchanged, and the upstream's real
 * capabilities never enter it — the save loop closes on itself.
 *
 * So the capability fields are read from the live roster on EVERY read. That
 * is also where the truth is: the upstream's answer changes over time, and a
 * saved copy is a snapshot of one moment.
 *
 * @module dsh-connect-workbuddy/catalog-sync
 */

import { fallbackModelsFor, withoutRouters } from './catalog.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/**
 * The capability fields a saved directory may carry but must never be trusted
 * for, because the live roster is the authority on all of them.
 *
 * `reasoning` is the one issue #114 is about. `creditMultiplier` and
 * `supportsImages` ride along for the same reason: the upstream publishes
 * them, the saved copy is a snapshot of one moment, and a stale multiplier is
 * a wrong PRICE shown to the user.
 *
 * `promos` is NOT in this list — see {@link overlayLiveCapabilities} for why it
 * needs a different rule (it must be able to CLEAR a saved value, which this
 * loop cannot express).
 */
const LIVE_OWNED_FIELDS = ['reasoning', 'creditMultiplier', 'supportsImages'] as const

/**
 * Overlay the live roster's capabilities onto a saved directory entry.
 *
 * The saved entry contributes IDENTITY (the id, the name the user saw, the
 * context budget) and the live entry contributes CAPABILITY. When the live
 * roster does not know the model at all, the saved entry is returned
 * unchanged — it may be a model the upstream withdrew but the user is still
 * running, and issue #32's rule says such a model must stay offered.
 *
 * `reasoning` is replaced rather than merged: a saved `reasoning` block
 * describes one moment's upstream answer, and merging the two would leave
 * `canDisableThinking` from the stale copy attached to a fresh set of
 * efforts. The user's own `off` choice is NOT part of this — it is stamped
 * later by `withEffectiveOff`, from the saved selection, not from here.
 *
 * The `canDisableThinking` in the LIVE block is the upstream's DECLARATION,
 * and the user's effective choice is stamped over it by `withEffectiveOff`
 * afterwards. So the overlay restores the declaration, and the user's tick
 * still wins.
 *
 * `promos` IS LIVE-OWNED TOO, AND IS REPLACED UNCONDITIONALLY. It cannot use
 * the loop above, because that loop only writes a field the live entry HAS —
 * which would keep a saved promotion forever once the upstream withdrew it.
 * Both directions were observed to be wrong before this rule existed:
 *
 *   - saved WITHOUT `promos`, live WITH them → the live promotions were
 *     dropped entirely, so a model on a night discount drew no badge at all;
 *   - saved WITH old `promos`, live with new ones → the saved ones won, so a
 *     promotion whose hours the upstream had since changed kept advertising
 *     the OLD hours.
 *
 * The card persists `promos` into `lastCatalog` (the settings schema keeps
 * unknown keys), so a user who saved the directory once had their badges
 * frozen at that moment — the exact opposite of what `src/promo.ts` promises
 * ("a badge is a function of the clock, not of the fetch"). The upstream's
 * current answer therefore REPLACES the saved one, including when that answer
 * is "no promotions at all": a badge the upstream no longer publishes must
 * stop being drawn, and a standing entry with no schedule has no absolute
 * window to expire it on its own.
 *
 * The key is DELETED rather than set to `undefined` when the live entry has
 * no promotions, for the same reason `resolveRoster` deletes `busyLevel`: an
 * explicit `undefined` survives `structuredClone` and the settings write
 * path's strict JSON codec rejects the whole save.
 */
export function overlayLiveCapabilities(
  saved: WorkBuddyModelInfo,
  live: WorkBuddyModelInfo | undefined,
): WorkBuddyModelInfo {
  if (live === undefined) return saved
  const overlay: Record<string, unknown> = {}
  for (const field of LIVE_OWNED_FIELDS) {
    const value = (live as unknown as Record<string, unknown>)[field]
    if (value !== undefined) overlay[field] = value
  }
  // `busyLevel` is deliberately NOT overlaid: it is a fact about this minute
  // and it never reaches the saved directory anyway (`src/busy.ts`).
  const livePromos = (live as { promos?: readonly unknown[] }).promos
  const savedPromos = (saved as { promos?: readonly unknown[] }).promos
  // Any asymmetry is worth acting on, in BOTH directions: live-with-promos
  // must win, and live-without must clear a saved copy.
  const promosDiffer = livePromos !== savedPromos
    && (livePromos !== undefined || savedPromos !== undefined)
  if (Object.keys(overlay).length === 0 && !promosDiffer) return saved
  if (livePromos !== undefined) {
    overlay['promos'] = livePromos
    return { ...saved, ...overlay } as WorkBuddyModelInfo
  }
  // The live entry has none: drop the saved copy BY KEY.
  const { promos: _stalePromos, ...rest } = saved as WorkBuddyModelInfo & { promos?: readonly unknown[] }
  return { ...rest, ...overlay } as WorkBuddyModelInfo
}

/**
 * The roster the runtime and the card should serve: the live roster, with the
 * saved directory's own models kept when the upstream no longer lists them.
 *
 * ORDER matters for the card (it lists the roster as given) and is
 * preserved from the live roster, with the kept-but-withdrawn models
 * appended. The live roster wins on every shared id.
 *
 * @param saved The saved directory (may be empty).
 * @param live The live upstream roster (may be empty when the upstream is
 *   unreachable — then this answers the saved directory alone).
 */
export function mergeRoster(
  saved: readonly WorkBuddyModelInfo[],
  live: readonly WorkBuddyModelInfo[],
): readonly WorkBuddyModelInfo[] {
  const liveById = new Map(live.map(model => [model.id, model]))
  const savedById = new Map(saved.map(model => [model.id, model]))
  // The live roster first, in ITS order: it is what the upstream currently
  // offers, and the card lists the roster as it stands.
  const merged: WorkBuddyModelInfo[] = []
  const seen = new Set<string>()
  for (const model of live) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    const savedEntry = savedById.get(model.id)
    merged.push(savedEntry === undefined ? model : overlayLiveCapabilities(savedEntry, model))
  }
  // Then the saved models the upstream no longer lists. They stay, because the
  // user may still be running one (issue #32: a refresh must never withdraw a
  // model the user is on), and the live roster cannot supply their
  // capabilities either — the saved entry is all that is left of them.
  for (const model of saved) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    merged.push(model)
  }
  return merged
}

/**
 * A fingerprint of a directory, used to decide whether a repair is worth
 * writing.
 *
 * Only the fields that MATTER are included: the ids in order and the
 * capability fields. A directory whose fingerprint matches the live roster's
 * needs no write, which is what keeps the repair from writing on every
 * refresh (a write per refresh would be a write storm on a profile the user
 * opens often).
 *
 * `busyLevel` is excluded for the same reason it is never persisted: it is a
 * fact about this minute.
 */
export function catalogFingerprint(models: readonly WorkBuddyModelInfo[]): string {
  return JSON.stringify(models.map(model => ({
    id: model.id,
    ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
    ...model.creditMultiplier === undefined ? {} : { creditMultiplier: model.creditMultiplier },
    ...model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages },
  })))
}

/**
 * The saved directory REPAIRED against the live roster.
 *
 * This is what gets written back, so the next read starts from a directory
 * that agrees with the upstream: the live roster's models (so a newly added
 * model is present), plus the saved directory's own models that the upstream
 * still lists or that the user is still running.
 *
 * `enabledModelIds` is NOT touched here — the selection lives in its own
 * field, and the repair must not drop a tick whose model merely left the
 * upstream roster.
 */
export function repairedCatalog(
  saved: readonly WorkBuddyModelInfo[],
  live: readonly WorkBuddyModelInfo[],
): readonly WorkBuddyModelInfo[] {
  return mergeRoster(saved, live)
}

/**
 * Whether a saved directory is byte-for-byte the STATIC fallback table.
 *
 * That table is what a cold start used to seed `lastCatalog` with (issue
 * #114's root cause). Such a directory is not a user's selection — it is the
 * plugin's own placeholder that came back as if the user had chosen it. So
 * it is recognised here and treated as "never configured", which lets the
 * live roster take over and lets the directory heal.
 *
 * The comparison is by id list and capability content, not by object
 * identity: the seeded copy is a plain copy of the fallback table.
 */
export function isUnconfiguredFallbackSnapshot(
  saved: readonly WorkBuddyModelInfo[],
  region: WorkBuddyRegion,
): boolean {
  const fallback = fallbackModelsFor(region)
  if (saved.length !== fallback.length) return false
  const fallbackIds = fallback.map(model => model.id)
  const savedIds = saved.map(model => model.id)
  if (!fallbackIds.every((id, index) => id === savedIds[index])) return false
  // The fallback table declares no `reasoning` and no `creditMultiplier` for
  // EITHER roster now (issue #214 took the last captured rates off the global
  // one), so a snapshot that carries those was not seeded from it — it is a
  // real saved directory and must not be thrown away. `creditMultiplier` is
  // checked explicitly, not inferred from `reasoning`: a directory the card
  // saved from a live refresh has prices but may legitimately have no
  // `reasoning` block at all, and calling that "the unconfigured placeholder"
  // would delete every rate the user is depending on.
  return saved.every(model => model.reasoning === undefined && model.creditMultiplier === undefined)
}

/**
 * The roster the runtime serves for a region.
 *
 * THE ORDER OF THE THREE SOURCES is the whole point of issues #114/#115:
 *
 * 1. the LIVE roster, when there is one — it is the truth about what the
 *    upstream offers;
 * 2. the saved directory, merged over it — the user's own models are kept
 *    even when the upstream withdrew them;
 * 3. the static fallback, only when the upstream is unreachable AND nothing
 *    was ever saved.
 *
 * The saved directory is NEVER the primary source: that is what froze the
 * roster at a stale snapshot forever.
 *
 * @param saved The region's saved directory.
 * @param live The region's live roster (empty when the upstream is down).
 * @param region The region, for the static fallback table.
 * @param options.keepLoadLevel Whether a live entry's load level survives
 *   the merge. It is ON for the runtime roster and OFF for the card's
 *   directory — see the note below.
 */
export function resolveRoster(
  saved: readonly WorkBuddyModelInfo[],
  live: readonly WorkBuddyModelInfo[],
  region: WorkBuddyRegion,
  options: { keepLoadLevel?: boolean } = {},
): readonly WorkBuddyModelInfo[] {
  const savedRoster = withoutRouters(saved)
  const liveRoster = withoutRouters(live)
  const source = liveRoster.length > 0 ? liveRoster : savedRoster.length > 0 ? savedRoster : withoutRouters(fallbackModelsFor(region))
  const merged = liveRoster.length > 0
    ? mergeRoster(savedRoster, liveRoster)
    : source
  // THE LOAD LEVEL IS A FACT ABOUT THIS MINUTE, and it does not belong in the
  // card's directory. `src/busy.ts` is explicit that load is never persisted,
  // and the card's model table reads the level from a SEPARATE map for exactly
  // that reason (`liveBusyLevels`). So the directory this function serves for
  // the card must not carry one — otherwise the pool's trimmed catalog would
  // start shipping a `busyLevel` field it never shipped before, and the
  // card would have two sources for the same badge that could disagree.
  //
  // The runtime roster DOES keep it: that is the badge the model picker draws.
  if (options.keepLoadLevel === true) return merged
  // The key is DELETED, not set to `undefined`: an explicit `undefined`
  // property survives `structuredClone` and the settings write path's strict
  // JSON codec rejects the whole save with "found a function at ...". The
  // same rule is why `toPersistedWorkBuddyModel` strips its card-only fields
  // BY KEY rather than assigning `undefined` (see `src/status-paths.ts`).
  return merged.map(model => {
    if (model.busyLevel === undefined) return model
    const { busyLevel: _dropped, ...rest } = model
    return rest as WorkBuddyModelInfo
  })
}
