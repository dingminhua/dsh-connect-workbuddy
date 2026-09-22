/**
 * Verified writes of the per-region account slot.
 *
 * 参考：DSH 自带插件卡片（`@deepseek-ai/dsh-client-ui-settings-plugins`
 *   的 `CardForm.store()`）— 「写入后回读用户层并与写入值比对」这一校验形态，
 *   是本模块 `writeAccountSlot()` 的出发点。
 * 改动：针对账号槽位重写而非照搬 —— 回读的是**解析后的 section**而非 user 层
 *   （Host 的 legacy 归属也读它，两者必须同源），并用精确比较区分 `''`（哨兵清除）
 *   与 `undefined`（键缺失），因为后者会让区域重新回退到旧版 `accountId`。
 *
 * Kept out of `WorkBuddyCard.tsx` — and free of any browser-only import — so
 * the write contract can be unit-tested directly. The card is a `.tsx`
 * component whose module graph pulls DSH's browser packages, which cannot load
 * in the Node test environment; the check below is exactly the part that must
 * not go untested.
 *
 * @module dsh-connect-workbuddy/client/account-selection
 */

import type { WorkBuddyWebRegion } from '../status-paths.ts'

/**
 * The slice of the bound settings scope this module writes through.
 *
 * `value` is the RESOLVED section (schema defaults + composition base + user
 * layer), which is what both the card and this check must read: the card
 * derives the other region's preserved slot from it, so verification has to
 * look at the same source or the two can disagree.
 */
export interface WorkBuddyAccountScope {
  getSnapshot(): { value?: unknown }
  set(field: string, value: unknown): Promise<void>
}

/**
 * A settings write that did not take effect.
 *
 * Distinct from a rejected `set()`: this is thrown when the write reported
 * success and the value is nonetheless absent from the document — the silent
 * failure described on {@link writeVerified}.
 *
 * The message stays short and factual on purpose: the card renders it INSIDE a
 * localized sentence (`row.accountsWriteFailed` / `row.saveError`) that already
 * names the likely holders of the file in the user's own language. Repeating
 * that guidance here would print it twice in one line.
 */
export class WorkBuddySettingsWriteError extends Error {
  /** The settings field that did not land. */
  readonly field: string
  /** How many writes were attempted before giving up. */
  readonly attempts: number

  constructor(field: string, attempts: number) {
    super(
      `workbuddy: settings field "${field}" was not persisted by the settings write`
      + ` (${attempts} attempt${attempts === 1 ? '' : 's'})`,
    )
    this.name = 'WorkBuddySettingsWriteError'
    this.field = field
    this.attempts = attempts
  }
}

/**
 * Delays before each retry of an unpersisted write; its length sets the retry
 * budget (one initial attempt plus one per entry).
 *
 * Chosen to outlast the Host's own retry window rather than duplicate it.
 * `@deepseek-ai/dsh-atomic-write` retries the Windows rename eight times with
 * exponential backoff from 20 ms to 200 ms — roughly a second — and the
 * interference that causes this routinely outlasts that (a scanner finishing
 * with a freshly written file, a sync client taking its turn). A retry that
 * lands adds its full write latency to the success path only when the first
 * attempt genuinely failed, so the cost is confined to the failure case.
 */
export const VERIFIED_WRITE_RETRY_DELAYS_MS: readonly number[] = [200, 600]

/**
 * Run one field write to verified completion, retrying a write the Host did
 * not persist.
 *
 * `settingsScope.set()` resolving is NOT proof that anything was stored. The
 * Host's document is `settings.yaml`, replaced by writing a temp file and
 * renaming it over the target; on Windows an antivirus scanner, a sync client
 * (OneDrive, Dropbox), or an open editor can hold the file briefly.
 * `@deepseek-ai/dsh-atomic-write` retries `EPERM` / `EBUSY` / `EACCES` a
 * bounded number of times and those retries exist only for `win32` — and once
 * they are exhausted the failure reaches the client as an unsuccessful
 * response, which the settings scope handles by reloading Host state and
 * merely RETURNING. The caller's `await` therefore succeeds while the document
 * is unchanged.
 *
 * Reading the field back is the only reliable check, and it is what the
 * official plugin cards do (`CardForm.store()` compares the user layer against
 * the value it wrote). What that check needs to be useful is a second chance:
 * because the failure is reported as a RESOLVED promise, a caller that writes
 * once and verifies once has no way to recover from interference that has
 * already cleared by the time it looks again.
 *
 * `next` is a thunk and `landed` a predicate — not a value and a snapshot —
 * because both must be evaluated against the CURRENT document on every
 * attempt, including the first. That is what keeps a retry from clobbering a
 * concurrent change to the section's other fields.
 *
 * @param scope - the bound settings scope for this plugin's namespace.
 * @param field - the field being written; named in the error.
 * @param next - builds the complete next value of `field` from the live snapshot.
 * @param landed - whether `field` now reads back exactly as written.
 * @throws {WorkBuddySettingsWriteError} when no attempt lands.
 */
async function writeVerified(
  scope: WorkBuddyAccountScope,
  field: string,
  next: () => unknown,
  landed: () => boolean,
): Promise<void> {
  const attempts = VERIFIED_WRITE_RETRY_DELAYS_MS.length + 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await scope.set(field, next())
    if (landed()) return
    const delay = VERIFIED_WRITE_RETRY_DELAYS_MS[attempt - 1]
    if (delay === undefined) break
    await new Promise<void>(resolve => { setTimeout(resolve, delay) })
  }
  throw new WorkBuddySettingsWriteError(field, attempts)
}

/** Read the per-region account selections out of the settings snapshot. */
export function configuredAccountsOf(configured: unknown): Record<string, string> {
  const accounts = (configured as { accounts?: unknown } | undefined)?.accounts
  return typeof accounts === 'object' && accounts !== null ? accounts as Record<string, string> : {}
}

/**
 * Write one region's account slot, then confirm the value actually landed.
 *
 * Failing loudly matters most on Clear: a false success would flip the card to
 * "following the app's sign-in" while the old selection keeps running — the
 * exact confusion that state line exists to remove.
 *
 * @param scope - the bound settings scope for this plugin's namespace.
 * @param region - the region whose slot is written; the other is preserved.
 * @param value - the account id to save, or `''` to clear the region.
 * @throws {WorkBuddySettingsWriteError} when the value is readable back as
 *   something else — i.e. the write silently did not persist.
 */
export async function writeAccountSlot(
  scope: WorkBuddyAccountScope,
  region: WorkBuddyWebRegion,
  value: string,
): Promise<void> {
  await writeVerified(
    scope,
    'accounts',
    // Re-read per attempt so a retry preserves whatever the OTHER region holds
    // at that moment, which may have moved since the previous attempt.
    () => ({ ...configuredAccountsOf(scope.getSnapshot().value), [region]: value }),
    // Note the deliberately exact comparison: `undefined` (slot absent) and `''`
    // (slot cleared) are different states with different meanings, and only the
    // second one is a successful clear. Treating them as equivalent would report
    // success for a write that removed the key instead of setting the sentinel.
    () => configuredAccountsOf(scope.getSnapshot().value)[region] === value,
  )
}

/**
 * Write one region's saved model state, then confirm it actually landed.
 *
 * The same silent-failure mode as {@link writeAccountSlot} applies to EVERY
 * settings write, not just the account slot. It matters here for a different
 * reason: a successful save discards the user's draft, so a write that did not
 * persist makes the card throw away unsaved edits while claiming they were
 * saved — unrecoverable, since the drafts are the only copy.
 *
 * Verification compares the round-tripped `lastCatalog` ids, which is the part
 * of the payload that is both user-visible and cheap to compare; the selection
 * fields ride along in the same object and cannot land separately.
 *
 * @param scope - the bound settings scope for this plugin's namespace.
 * @param region - the region whose model slot is written.
 * @param payload - the complete next state for that region's slot.
 * @throws {WorkBuddySettingsWriteError} when the catalog does not read back.
 */
export async function writeRegionModels(
  scope: WorkBuddyAccountScope,
  region: WorkBuddyWebRegion,
  payload: { lastCatalog: readonly { id: string }[] } & Record<string, unknown>,
): Promise<void> {
  const written = payload.lastCatalog.map(model => model.id)
  /** This region's slot as it currently reads back, if it is an object. */
  const storedSlot = (): { lastCatalog?: { id?: string }[] } | undefined =>
    (scope.getSnapshot().value as
      | { regions?: Record<string, { lastCatalog?: { id?: string }[] }> }
      | undefined)?.regions?.[region]
  const landed = (): boolean => {
    const stored = storedSlot()?.lastCatalog?.map(model => model.id)
    return stored !== undefined
      && stored.length === written.length
      && stored.every((id, index) => id === written[index])
  }
  await writeVerified(
    scope,
    'regions',
    () => {
      const configured = (scope.getSnapshot().value as { regions?: Record<string, unknown> } | undefined)?.regions
      const regions = typeof configured === 'object' && configured !== null ? configured : {}
      return { ...regions, [region]: payload }
    },
    landed,
  )
}
