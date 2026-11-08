/**
 * Account transfer: the export / import file format shared with sibling
 * credential managers for the same upstream.
 *
 * 参考：通行实现 —— 文件是一个 JSON 数组，每项为一条凭据记录，顶层字段
 *   snake_case（`access_token` / `refresh_token` / `uid` / `nickname` /
 *   `email` / `domain` / `expiresAt`(ms) / `refreshExpiresAt` / `auth_raw`），
 *   导入按 `uid` 去重（同 uid 覆盖），缺 `access_token` 的记录跳过；预览只
 *   回脱敏字段（含 `hasToken` 布尔量），不回明文。解析函数不依赖文件系统，
 *   便于无 UI 环境单测；落库由 Host 侧的 store 完成。
 * 互通：`expiresAt` 一族按契约是**毫秒**（由 auth_raw 的原始认证文档携带）；
 *   本插件的 vault 文档 `expiresAt` 是秒 —— 换算只发生在导出/导入边界。
 *   导出时 `auth_raw` 直接携带本插件 vault 文档的 `{auth, account}` 双键块，
 *   与桌面认证文件同构，供写入桌面认证文件的工具原样消费。
 *
 * @module dsh-connect-workbuddy/transfer
 */

import { workbuddyAccountId } from './auth.ts'
import type { WorkBuddyCredential } from './auth.ts'
import type {
  WorkBuddyTransferPreview,
  WorkBuddyTransferPreviewEntry,
  WorkBuddyTransferRecord,
} from './status-paths.ts'

/**
 * Parse transfer-file text: a JSON array, every element an object.
 *
 * The error strings carry the position (1-based item number) because a file
 * from another tool can be big, and "第 N 项" is what lets the user find the
 * broken record in their editor.
 */
export function parseTransferFile(text: string): WorkBuddyTransferRecord[] {
  if (text.trim() === '') throw new Error('transfer file is empty')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new Error('transfer file is not valid JSON: ' + (error instanceof Error ? error.message : String(error)))
  }
  const records = recordsOf(parsed)
  if (records === undefined) {
    // NAME WHAT WAS FOUND, not only what was wanted (issue #229).
    //
    // The old message said "must be a JSON array" and stopped there, so a file
    // exported by another tool arrived as `{"accounts": [...]}` — already the
    // right records, one wrapper deep — and the user had no way to tell that from
    // a file of the wrong KIND. Reporting the top-level shape turns "导入失败" into
    // something they can act on without guessing.
    throw new Error(
      'transfer file must be a JSON array of account records; '
      + 'this file is ' + describeShape(parsed) + '. '
      + 'Accepted wrappers: {"accounts": [...]}, {"data": [...]}, {"records": [...]}.',
    )
  }
  for (const [index, item] of records.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('transfer file item ' + (index + 1) + ' is not an account object')
    }
  }
  // STRIP THE REDUNDANT SNAPSHOTS (issue #229, second report).
  //
  // Files from sibling tools carry the raw upstream responses they happened to
  // fetch — `quota_raw`, `usage_raw` and friends — which this plugin never reads
  // (`credentialOfTransferRecord` below takes only the contract fields, and
  // `transferRecordOf` never writes them). They are pure ballast: one account
  // measured 108 KiB with them, 8 KiB without, and the size alone was enough to
  // fail the upload before it ever reached the parser.
  //
  // Stripping here rather than rejecting is deliberate: a `*_raw` key is not
  // evidence of a malformed file, it is what these tools emit, so refusing would
  // punish the exact files this importer exists to accept. Only keys ENDING in
  // `_raw` are dropped, and `auth_raw` is exempt — it is the one raw document the
  // importer genuinely uses (see `uinOfRaw`).
  return records.map(item => stripRedundantRaw(item as WorkBuddyTransferRecord))
}

/**
 * Drop `*_raw` snapshots the importer never reads, keeping `auth_raw`.
 *
 * `auth_raw` is exempt because it carries the billing `uin`, which is what makes
 * a re-imported account converge on the same vault id — dropping it would change
 * behaviour, not just size.
 */
function stripRedundantRaw(record: WorkBuddyTransferRecord): WorkBuddyTransferRecord {
  let changed = false
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'auth_raw' && key.endsWith('_raw')) {
      changed = true
      continue
    }
    kept[key] = value
  }
  // Return the original object when there is nothing to drop, so callers that
  // compare identity (tests, and `mergeTransferRecords`' dedupe) are unaffected.
  return changed ? kept as unknown as WorkBuddyTransferRecord : record
}

/**
 * The record array inside whatever the file's top level happens to be.
 *
 * THE FIX FOR ISSUE #229: the export/import loop has to be closed against the
 * files sibling tools actually produce, and several of them wrap the records one
 * level down (`{accounts: [...]}`) — which is also the shape THIS plugin's own
 * export endpoint answers with, so a user who saved that JSON verbatim got a file
 * the importer refused. A bare array stays the primary format; the wrappers are
 * recognized by NAME, never by scanning for the first array anywhere, because a
 * file whose records live under an unrelated key should fail loudly rather than
 * be guessed at.
 *
 * `undefined` means "not a transfer document", which the caller turns into a
 * message naming the shape it actually saw.
 */
function recordsOf(parsed: unknown, depth = 0): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const root = parsed as Record<string, unknown>
  for (const key of ['accounts', 'data', 'records']) {
    const value = root[key]
    if (Array.isArray(value)) return value
  }
  // ONE extra level for the envelope-of-envelope form some tools emit
  // (`{code: 0, data: {accounts: [...]}}`).
  //
  // The `depth` bound is not decoration — without it this walked ALL the way
  // down. The first version of this function recursed unconditionally and its
  // comment claimed it was bounded, which was simply false: measured, a record
  // array wrapped 200 levels deep was ACCEPTED, so a log or a config dump with
  // an array under `data` somewhere would have been read as a credential file.
  // The bound is what makes "bounded on purpose" true instead of aspirational.
  if (depth >= 1) return undefined
  for (const key of ['data', 'result']) {
    const value = root[key]
    if (typeof value !== 'object' || value === null) continue
    const inner = recordsOf(value, depth + 1)
    if (inner !== undefined) return inner
  }
  return undefined
}

/** A short, human-readable description of what the top level actually is. */
function describeShape(parsed: unknown): string {
  if (parsed === null) return 'null'
  if (Array.isArray(parsed)) return 'an array'
  if (typeof parsed !== 'object') return 'a ' + typeof parsed
  const keys = Object.keys(parsed as Record<string, unknown>)
  return keys.length === 0 ? 'an empty object' : 'an object with keys: ' + keys.slice(0, 8).join(', ')
}

/** One string field of a record, tolerating the sibling format's odd shapes. */
function displayString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** Whether a record carries a usable token, envelope-shaped or plain. */
function hasToken(record: WorkBuddyTransferRecord): boolean {
  const token: unknown = record['access_token']
  return typeof token === 'string' && token !== ''
}

/**
 * The transfer file's desensitized preview: display fields only.
 *
 * Fields come from EXTERNAL files, so a display field may hold an object or an
 * array (a sibling tool can store the desktop app's encrypted-wrapper nickname
 * verbatim); every preview field is normalized to a string or emptied rather
 * than letting a non-renderable value reach the card.
 */
export function previewTransferFile(text: string): WorkBuddyTransferPreview {
  const records = parseTransferFile(text)
  const accounts: WorkBuddyTransferPreviewEntry[] = records.map((record, index) => ({
    index,
    uid: displayString(record['uid']),
    nickname: displayString(record['nickname']),
    email: displayString(record['email']),
    hasToken: hasToken(record),
  }))
  return { accounts, total: records.length }
}

/**
 * Project one vault credential into the shared transfer record shape.
 *
 * `expiresAt` is emitted in MILLISECONDS — the transfer contract's unit and
 * the sibling tools' display field — while the vault document stores seconds.
 * `auth_raw` carries the vault's nested `{auth, account}` document so a tool
 * that writes desktop auth files can consume it verbatim.
 */
export function transferRecordOf(
  credential: WorkBuddyCredential,
  vaultDocument: { auth: Record<string, unknown>, account: Record<string, unknown> },
): WorkBuddyTransferRecord {
  const record: WorkBuddyTransferRecord = {
    access_token: credential.accessToken,
    ...credential.refreshToken !== '' ? { refresh_token: credential.refreshToken } : {},
    ...credential.uid !== '' ? { uid: credential.uid } : {},
    ...credential.nickname !== undefined ? { nickname: credential.nickname } : {},
    ...credential.domain !== '' ? { domain: credential.domain } : {},
    ...(credential.expiresAtMs > 0 ? { expiresAt: credential.expiresAtMs } : {}),
    ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAt: credential.refreshExpiresAtMs },
    auth_raw: vaultDocument,
  }
  return record
}

/**
 * Recover `uin` from a record's `auth_raw` document.
 *
 * `uin` is the billing identity the account id derives from
 * (`uin ?? uid ?? nickname`), but it is NOT one of the transfer format's
 * contract fields — sibling exports carry it only inside `auth_raw`
 * (the original auth document, whose `account` object holds it). Restoring it
 * is what makes an exported-and-re-imported account converge on the SAME
 * vault id instead of duplicating under a uid-derived id. Both document
 * shapes are honored: the nested `{auth, account}` block this plugin
 * exports, and a record whose `auth_raw.account` came straight from a
 * desktop file.
 */
function uinOfRaw(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const root = raw as Record<string, unknown>
  const account = typeof root['account'] === 'object' && root['account'] !== null
    ? root['account'] as Record<string, unknown>
    : root
  const uin = displayString(account['uin'])
  return uin === '' ? undefined : uin
}

/**
 * Project one transfer record into a vault credential, or undefined when the
 * record carries no token (the importer's skip rule).
 *
 * `uid` empty is tolerated at THIS layer because a token-only record still
 * describes a usable credential; the Host's region gate and the store's
 * account id (`uin ?? uid ?? nickname`) decide whether it is representable.
 * An unopenable `auth_raw` is ignored — the flat fields above are the
 * contract, `auth_raw` is extra fidelity for the write-back path.
 */
export function credentialOfTransferRecord(record: WorkBuddyTransferRecord): Omit<WorkBuddyCredential, 'source' | 'filePath'> | undefined {
  const accessToken = record['access_token']
  if (typeof accessToken !== 'string' || accessToken === '') return undefined
  const refreshToken = typeof record['refresh_token'] === 'string' ? record['refresh_token'] : ''
  // The transfer format's expiry is epoch ms (sibling contract); the vault's
  // runtime field is ms too, so 0/absent maps to the "unknown" zero.
  const expiresAtMs = typeof record['expiresAt'] === 'number' && Number.isFinite(record['expiresAt']) && record['expiresAt'] > 0
    ? record['expiresAt']
    : 0
  const refreshExpiresAtMs = typeof record['refreshExpiresAt'] === 'number' && Number.isFinite(record['refreshExpiresAt']) && record['refreshExpiresAt'] > 0
    ? record['refreshExpiresAt']
    : undefined
  const uin = uinOfRaw(record['auth_raw'])
  return {
    accessToken,
    refreshToken,
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: typeof record['domain'] === 'string' ? record['domain'] : '',
    uid: displayString(record['uid']),
    ...record['nickname'] !== undefined ? { nickname: displayString(record['nickname']) } : {},
    ...uin === undefined ? {} : { uin },
  }
}

/**
 * Pure merge: fold selected records into a CHANGES map keyed by account id.
 *
 * Mirrors the sibling merger's contract: a record with the same account id
 * OVERWRITES the stored entry (the imported tokens replace what is stored —
 * re-importing a re-login must refresh it; the write layer stores the record
 * atomically, so "overwrite" needs no knowledge of the incumbent), and a
 * record without a token is skipped. The region gate lives HERE rather than
 * in the route so it is testable without a Host: a record whose login domain
 * maps to the other region's tab is skipped, because the two regions'
 * providers are parallel stacks and a cross-region import would cross-bill.
 *
 * The caller writes one vault file per map entry, so a selection that is
 * already stored rewrites those files with identical content — idempotent,
 * and the steady state of importing the same file twice.
 */
export function mergeTransferRecords(
  records: readonly WorkBuddyTransferRecord[],
  indexes: readonly number[],
  region: 'cn' | 'global',
  knownRegionOfDomain: (domain: string) => 'cn' | 'global' | undefined,
): { changes: Map<string, Omit<WorkBuddyCredential, 'source' | 'filePath'>>, imported: number, skipped: number } {
  const changes = new Map<string, Omit<WorkBuddyCredential, 'source' | 'filePath'>>()
  let imported = 0
  let skipped = 0
  for (const index of indexes) {
    const record = records[index]
    if (record === undefined) {
      skipped += 1
      continue
    }
    const credential = credentialOfTransferRecord(record)
    if (credential === undefined) {
      skipped += 1
      continue
    }
    // Region gate: the credential's OWN domain decides, and the decision must
    // be a POSITIVE match. `regionOf` classifies anything unrecognised as CN,
    // which is right when the domain came from the upstream but wrong for an
    // IMPORTED file, where `domain` is whatever the file's author wrote: a
    // spoofed or misspelled value would otherwise be admitted into the CN
    // vault. A record is kept only when its domain is positively known to
    // belong to the target region; an empty, unrecognised, or provably other
    // region's domain is skipped, so a rejected import reports `skipped`
    // instead of pretending to have stored a foreign credential.
    if (knownRegionOfDomain(credential.domain) !== region) {
      skipped += 1
      continue
    }
    const id = workbuddyAccountId(credential)
    changes.set(id, credential)
    imported += 1
  }
  return { changes, imported, skipped }
}
