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
  /**
   * Whether the Host accepted the write. On DSH 0.1.7 the scope resolves
   * `false` — it does NOT reject — when the Host refuses the mutation (stale
   * revision conflict, volatile-path validation, unwritable profile); the
   * scope then reloads Host state on its own. `undefined`/`void` (the 0.1.5
   * scope) counts as accepted: that line has no refusal channel.
   */
  set(field: string, value: unknown): Promise<boolean | void>
}

/**
 * A settings write that did not take effect.
 *
 * Distinct from a rejected `set()`: this is thrown when the write reported
 * success and the value is nonetheless absent from the document.
 */
export class WorkBuddySettingsWriteError extends Error {
  /** The settings field that did not land. */
  readonly field: string

  constructor(field: string, reason?: string) {
    super(`workbuddy: settings field "${field}" was not persisted by the settings write${reason === undefined ? '' : `: ${reason}`}`)
    this.name = 'WorkBuddySettingsWriteError'
    this.field = field
  }
}

/**
 * One field write with exactly one recovery retry.
 *
 * On DSH 0.1.7 a refused write resolves `false` while the scope transparently
 * reloads Host state. A single refusal is the documented stale-writer path
 * (the Host bumps the revision under us), so after that reload the value is
 * re-built from the fresh snapshot and tried once more. A second refusal is
 * deterministic — validation or a read-only profile — and must fail loudly
 * with a message that names the refusal instead of the generic read-back
 * assertion, which cannot distinguish "rejected" from "accepted but lost".
 */
async function setWithRecovery(
  scope: WorkBuddyAccountScope,
  field: 'accounts' | 'regions',
  build: () => unknown,
): Promise<boolean> {
  let accepted = await scope.set(field, build())
  if (accepted !== false) return true
  accepted = await scope.set(field, build())
  return accepted !== false
}

/** Read the per-region account selections out of the settings snapshot. */
export function configuredAccountsOf(configured: unknown): Record<string, string> {
  const accounts = (configured as { accounts?: unknown } | undefined)?.accounts
  return typeof accounts === 'object' && accounts !== null ? accounts as Record<string, string> : {}
}

/**
 * Write one region's account slot, then confirm the value actually landed.
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
 * the value it wrote). Failing loudly matters most on Clear: a false success
 * would flip the card to "following the app's sign-in" while the old selection
 * keeps running — the exact confusion that state line exists to remove.
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
  const accepted = await setWithRecovery(scope, 'accounts', () => {
    const accounts = configuredAccountsOf(scope.getSnapshot().value)
    return { ...accounts, [region]: value }
  })
  if (!accepted) {
    throw new WorkBuddySettingsWriteError('accounts', 'the Host refused the write twice (revision conflict or validation refused the value)')
  }
  const landed = configuredAccountsOf(scope.getSnapshot().value)[region]
  // Note the deliberately exact comparison: `undefined` (slot absent) and `''`
  // (slot cleared) are different states with different meanings, and only the
  // second one is a successful clear. Treating them as equivalent would report
  // success for a write that removed the key instead of setting the sentinel.
  if (landed !== value) throw new WorkBuddySettingsWriteError('accounts')
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
  const accepted = await setWithRecovery(scope, 'regions', () => {
    const configured = (scope.getSnapshot().value as { regions?: Record<string, unknown> } | undefined)?.regions
    const regions = typeof configured === 'object' && configured !== null ? configured : {}
    return { ...regions, [region]: payload }
  })
  if (!accepted) {
    throw new WorkBuddySettingsWriteError('regions', 'the Host refused the write twice (revision conflict or validation refused the value)')
  }

  const landed = (scope.getSnapshot().value as
    | { regions?: Record<string, { lastCatalog?: { id?: string }[] }> }
    | undefined)?.regions?.[region]
  const written = payload.lastCatalog.map(model => model.id)
  const stored = landed?.lastCatalog?.map(model => model.id)
  const ok = stored !== undefined
    && stored.length === written.length
    && stored.every((id, index) => id === written[index])
  if (!ok) throw new WorkBuddySettingsWriteError('regions')
}
