/**
 * Writing the model's saved directory back to the Host's settings document.
 *
 * THE HOST-SIDE HALF OF ISSUES #114/#115. The card's own save path lives in the
 * browser half (`src/client/`), but the repair that heals a STALE saved
 * directory has to happen where the LIVE roster lands — inside the Host
 * process, right after the upstream answered. So this module writes through
 * the Host's own settings service, using the same merge discipline the
 * browser half uses (see `src/web-status.ts`).
 *
 * WHY NOT JUST WRITE THE WHOLE `regions` FIELD. Because the field holds
 * BOTH regions plus each region's account-pool preferences, and a blind write
 * would drop whatever the user changed in the other region (issue #32's
 * lesson, in a new place). So the write is a MERGE: the region's slot is
 * replaced, every other key of the slot is preserved, and the sibling region
 * is untouched.
 *
 * THE VALUE THIS MODULE WRITES IS THE `regions` FIELD, NOT THE SETTINGS
 * SECTION. That distinction is the whole of this bug — reported as
 * "账号池状态重启就失效". `describe()` hands back the resolved SECTION
 * (`{authFile, accounts, regions, cliBridge, …}`), and
 * `mutate(ns, [{ op: 'set', path: ['regions'], … }])` stores whatever it is
 * given AT that path. Handing it the section therefore wrote the section INTO
 * the field: the real region map was pushed down under a nested `regions` key,
 * its own siblings (`accounts`, `cliBridge`) became fake region slots, and the
 * Host's `regionStateOf(config, 'cn')` — which reads exactly one level — then
 * answered "no slot". Every account-pool preference, model selection and
 * directory looked unsaved after the next restart, and each startup added
 * another level (measured on a live profile: five levels, 258 KB).
 *
 * WHY THE HOST SERVICE RATHER THAN THE SCOPE. The plugin's browser half
 * writes through the Host's settings endpoint because the browser-side
 * `scope.set()` replaces the whole field with the browser's own (possibly
 * stale) mirror — that is documented at `src/client/account-selection.ts`.
 * The same reasoning applies here: there is no browser mirror in the Host
 * process, so the Host's own merge is the only safe writer.
 *
 * @module dsh-connect-workbuddy/catalog-write
 */

import {
  nextAccountsSelection,
  regionPinsAccount,
  regionsFieldIsCorrupt,
  regionsMapOf,
  unwrapVolatileDeep,
} from './status-paths.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/**
 * The shape this module needs from the Host's settings service.
 *
 * Narrow on purpose: `describe()` returns the resolved config per namespace
 * (with volatile fields as live references), and `mutate()` applies one
 * operation to a field path. Both are the same calls `src/web-status.ts`
 * makes for the card's save.
 */
export interface HostSettingsService {
  describe(): readonly { ns: string; value?: unknown }[]
  mutate(ns: string, ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[], expectedRevision?: number): Promise<void>
}

/**
 * The `regions` field's writes, serialized.
 *
 * EVERY WRITER OF THIS FIELD IS A READ-MODIFY-WRITE: `describe()` the authoritative
 * value, merge one region into it, `mutate()` the whole field back. Two of them
 * running at once both read the pre-write value, so whichever lands second
 * silently undoes the first — a lost update, with no error anywhere. That window
 * was always there (the startup repair and the account-removal cleanup can
 * overlap), but the scheduled price refresh made it easy to hit: it is armed at
 * `apply` with a zero delay, so its `describe()` lands in the same tick as the
 * startup repair's, on both regions.
 *
 * Chaining is the fix rather than `expectedRevision`: the CAS would need a retry
 * loop around a merge that is already cheap, and these writes are rare (once a
 * boot, once an interval). Serializing them costs nothing and removes the window
 * entirely.
 *
 * Nothing is rejected down the chain: a failed write must not become the next
 * one's failure, so the chain carries a swallowed copy while the real rejection
 * still reaches the caller.
 */
let regionWrites: Promise<unknown> = Promise.resolve()

/**
 * Run one `regions`-field write after every write already queued.
 *
 * @param write The read-modify-write to serialize; its rejection is the caller's.
 */
async function serializeRegionWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = regionWrites.then(write)
  regionWrites = run.catch(() => undefined)
  return await run
}

/**
 * Merge one region's repaired directory into the `regions` FIELD.
 *
 * `current` may be EITHER the resolved settings section (what `describe()`
 * answers, and what {@link writeRegionCatalog} passes) OR the bare `regions`
 * field; `regionsMapOf` narrows both and heals a document the bug above already
 * corrupted. The RETURN value is always the field itself — the exact shape
 * `path: ['regions']` expects — never the section around it.
 *
 * The merge is done on the AUTHORITATIVE value the settings service holds —
 * not on a snapshot the caller brought — because a snapshot can be stale and
 * a stale merge is how the other region disappears.
 */
export function mergeRegionCatalog(
  current: unknown,
  region: WorkBuddyRegion,
  catalog: readonly WorkBuddyModelInfo[],
): Record<string, unknown> {
  const regions = regionsMapOf(current)
  const stored = regions[region]
  const slot = typeof stored === 'object' && stored !== null && !Array.isArray(stored)
    ? stored as Record<string, unknown>
    : {}
  return {
    ...regions,
    [region]: { ...slot, lastCatalog: catalog },
  }
}

/**
 * Write one region's repaired directory.
 *
 * @param service The Host's settings service.
 * @param ns The namespace the Host serves this plugin under.
 * @param region The region whose slot is repaired.
 * @param catalog The repaired directory.
 * @returns whether the write happened.
 */
export async function writeRegionCatalog(
  service: HostSettingsService | undefined,
  ns: string,
  region: WorkBuddyRegion,
  catalog: readonly WorkBuddyModelInfo[],
): Promise<boolean> {
  if (service === undefined) return false
  return await serializeRegionWrite(async () => {
    const row = service.describe().find(entry => entry.ns === ns)
    if (row === undefined) return false
    const current = unwrapVolatileDeep(row.value ?? {}) as Record<string, unknown>
    const next = mergeRegionCatalog(current, region, catalog)
    await service.mutate(ns, [{ op: 'set', path: ['regions'], value: next }], undefined)
    return true
  })
}

/**
 * Clean a `regions` field an older build corrupted, WITHOUT touching any
 * region's content.
 *
 * WHY THIS IS SEPARATE FROM {@link writeRegionCatalog}. The catalog repair is
 * the writer that produced the wreckage, so it is also a natural place to clean
 * it — but it only runs when the live roster arrived (an enabled region, a
 * reachable upstream, a non-empty answer). A profile would therefore stay dirty
 * for as long as the network is down, and a region the user has switched OFF
 * would never be cleaned at all. This write needs neither: it is one settings
 * round-trip at boot, and it is a no-op for every healthy profile (a single key
 * scan, no mutation).
 *
 * It is a pure shape fix, not a merge: `regionsMapOf` already answers the
 * healed map, and the field is replaced with exactly that. Reads are correct
 * without this write (they narrow through the same helper), so failing to write
 * costs tidiness only — the caller logs and carries on.
 *
 * @returns whether the write happened.
 */
export async function healRegionsField(
  service: HostSettingsService | undefined,
  ns: string,
): Promise<boolean> {
  if (service === undefined) return false
  return await serializeRegionWrite(async () => {
    const row = service.describe().find(entry => entry.ns === ns)
    if (row === undefined) return false
    const section = row.value ?? {}
    // Ask the FIELD, not the section: the section legitimately carries `accounts`
    // and `cliBridge` beside `regions`, so the question would always be "dirty".
    if (!regionsFieldIsCorrupt((section as Record<string, unknown>)['regions'])) return false
    await service.mutate(ns, [{ op: 'set', path: ['regions'], value: regionsMapOf(section) }], undefined)
    return true
  })
}

/**
 * Drop one region's PERSISTED account selection, and only if it pinned this
 * account.
 *
 * THE HOST-SIDE HALF OF ISSUE #155'S SECOND REPORT. A user removed one account
 * and the whole CN tab turned into「已保存的账号在本机已不存在」, with no way back:
 * the card's advice points at a list it does not render in that state, so the
 * reporter escaped by hand-posting `{"field":"accounts","value":{"cn":""}}` to
 * the save endpoint. This is that write, made automatic.
 *
 * WHY A WRITE AT ALL — the store already forgets. `removeAccount` clears the
 * in-memory selection, which is why the region keeps working for the rest of the
 * session. But the settings document still names the dead id, so the next
 * `applySelection` — a restart, or any settings save — re-reads it, re-pins it,
 * and the region falls back into the same dead end. An in-memory forget that is
 * never persisted is not a fix; it is a delay.
 *
 * THE DECISION LIVES HERE, WITH THE WRITE, because the two must never be
 * separated by a caller's guess. Clearing a region that did NOT pin this account
 * would move the user off the account they chose, and「换账号等于换人计费」is the
 * rule every writer in this plugin obeys: this function writes for exactly the
 * region whose persisted pin names the account being removed, and no others.
 *
 * WRITES `''`, NEVER A DELETED KEY. The sentinel means "follow the app's current
 * sign-in" — the plugin's documented default, which is what a fresh install does,
 * so this restores a state rather than inventing one. An absent key means "never
 * configured" and falls through to the legacy flat `accountId` (`selectAccountFor`),
 * which would resurrect whichever account that field names: a silent switch
 * through another door. The sentinel also TERMINATES that lookup, which is why one
 * write settles both spellings — a pre-split profile pinned through the flat
 * field is cleared by this same write.
 *
 * FAIL-SOFT BY CONTRACT: a service that cannot answer, or a region that pinned
 * nothing, costs no write. The caller logs a failed mutation rather than failing
 * the removal, because the credential file is already gone by then and reporting
 * "could not remove" would be the lie.
 *
 * @param service The Host's settings service, or `undefined` to no-op.
 * @param ns The namespace this plugin's settings live under.
 * @param region The region being checked; the sibling is preserved by the merge.
 * @param accountId The account about to be removed.
 * @param legacyAccountId The deprecated flat `accountId`, as persisted.
 * @param legacyRegion Which region the startup scan attributed that field to.
 * @returns whether a write happened.
 */
export async function clearRegionAccountSelection(
  service: HostSettingsService | undefined,
  ns: string,
  region: WorkBuddyRegion,
  accountId: string,
  legacyAccountId?: string,
  legacyRegion?: WorkBuddyRegion,
): Promise<boolean> {
  if (service === undefined) return false
  const row = service.describe().find(entry => entry.ns === ns)
  if (row === undefined) return false
  const section = row.value ?? {}
  // Decide on the AUTHORITATIVE document, not on a snapshot the caller brought:
  // a stale merge base is how a sibling region's settings disappear (issue #32's
  // lesson, restated for this field). `nextAccountsSelection` preserves every key
  // it was not asked to change, so the other region's pin rides through untouched.
  if (!regionPinsAccount(section, region, accountId, legacyAccountId, legacyRegion)) return false
  await service.mutate(
    ns,
    [{ op: 'set', path: ['accounts'], value: nextAccountsSelection(section, region, '') }],
    undefined,
  )
  return true
}
