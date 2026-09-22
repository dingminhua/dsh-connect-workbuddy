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

/** Read one settings field's current object value from the scope snapshot. */
function fieldSnapshotOf(
  scope: WorkBuddyAccountScope,
  field: 'accounts' | 'regions',
): Record<string, unknown> {
  const value = (scope.getSnapshot().value as Record<string, unknown> | undefined)?.[field]
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/**
 * Fallback write: POST the field to the plugin's own Host endpoint.
 *
 * The endpoint handler runs the settings mutate inside the Host process and
 * reports the raw refusal exception, so a failure here names its cause instead
 * of arriving as a swallowed `ok:false`. It merges the posted region key into
 * the field's live value, preserving the other region.
 */
async function saveViaHostEndpoint(
  field: 'accounts' | 'regions',
  region: WorkBuddyWebRegion,
  value: unknown,
): Promise<void> {
  let response: Response
  try {
    response = await fetch('/plugins/dsh-connect-workbuddy/__save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field, value: { [region]: value } }),
    })
  } catch (error) {
    throw new WorkBuddySettingsWriteError(field, `Host save endpoint unreachable: ${String(error)}`)
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: `HTTP ${String(response.status)}` })) as { errorName?: string, error?: string }
    const reason = `${String(detail.errorName ?? '')} ${String(detail.error ?? '')}`.trim()
    throw new WorkBuddySettingsWriteError(field, `Host save refused: ${reason === '' ? String(detail.error) : reason}`)
  }
}

/**
 * Write one volatile field, then confirm the value actually landed.
 *
 * The bound settings scope is the official path and is tried FIRST: it keeps
 * the browser mirror in sync, and it is the only writer needed on hosts whose
 * ConfigForm is healthy. On the affected DSH 0.1.7 deployment that scope
 * settles without delivering anything — its `set()` resolves `false` while the
 * Host's own mutate is perfectly healthy (proven by a direct in-Host probe) —
 * so a write that does not read back falls through to the plugin's Host
 * endpoint, which performs the mutate inside the Host process.
 *
 * `landed` decides whether a value read back from the scope is the value that
 * was written; it is per-field because `''` (a cleared account slot) and an
 * absent key are different states, and a truncated model catalog must not pass
 * a shallow "is anything there?" check.
 *
 * @throws {WorkBuddySettingsWriteError} when neither path persists the value.
 */
async function writeField(
  scope: WorkBuddyAccountScope,
  field: 'accounts' | 'regions',
  region: WorkBuddyWebRegion,
  value: unknown,
  landed: (readBack: unknown) => boolean,
): Promise<void> {
  let scopeDelivered = false
  try {
    scopeDelivered = (await scope.set(field, { ...fieldSnapshotOf(scope, field), [region]: value })) !== false
  } catch {
    scopeDelivered = false
  }
  if (scopeDelivered && landed(fieldSnapshotOf(scope, field)[region])) return
  await saveViaHostEndpoint(field, region, value)
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
  // Deliberately exact: `undefined` (slot absent) and `''` (slot cleared) are
  // different states with different meanings, and only the second one is a
  // successful clear. Treating them as equivalent would report success for a
  // write that removed the key and silently restored the legacy fallback.
  await writeField(scope, 'accounts', region, value, readBack => readBack === value)
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
  // Compare the round-tripped catalog ids: they are user-visible and cheap to
  // compare, and the selection fields ride in the same object so they cannot
  // land separately. A present-but-truncated slot must not pass this check.
  const written = payload.lastCatalog.map(model => model.id)
  await writeField(scope, 'regions', region, payload, readBack => {
    const stored = (readBack as { lastCatalog?: { id?: string }[] } | undefined)?.lastCatalog?.map(model => model.id)
    return stored !== undefined
      && stored.length === written.length
      && stored.every((id, index) => id === written[index])
  })
}
