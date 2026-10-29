/**
 * WorkBuddy credential resolution.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
 *   — 桌面端 auth 文件只读、刷新结果写入 $DSH_HOME 自有副本、双凭据取
 *     到期更晚者、按需刷新（5 分钟余量）与单飞去重、刷新失败但 token
 *     未过期则继续沿用旧 token。这些机制已在该项目验证，此处沿用。
 * 改动：原版只解析单个 `workbuddy-desktop.info`。WorkBuddy 桌面端在
 *   同一 auth 目录留下带时间戳的备份文件（`workbuddy-desktop.<stamp>.info`），
 *   实测这些文件各自持有不同账号的可用凭据（本机 6 个文件 → 2 个账号）。
 *   本实现改为扫描整个 auth 目录，按 uin 去重为多个可选账号。跟随 App
 *   当前登录（live 文件）仍是默认行为；用户显式选择的账号被严格绑定，
 *   不因积分多少而切换，失效时也不会静默改选其他账号。
 *   另：store 可按区域（cn | global）限定可见账号 —— 国内版与国际版各持
 *   一个 store，账号、刷新、选择完全隔离；插件自有刷新副本也按区域分
 *   文件（`.workbuddy-auth.<region>.json`），双账号同时在线互不覆盖，
 *   旧的单文件 `.workbuddy-auth.json` 作为迁移源保留读取。
 *   另（issue #15）：`resolve()` 不再把「没登录」与「有登录但凭据读不出来」
 *   合并成同一句话。后者（加密字段 + 取不到密钥）改为抛
 *   `WorkBuddyEncryptedCredentialError`，给出「装 App / 用
 *   WORKBUDDY_APP_EXECUTABLE 指定」这条**可执行**的建议——对已登录的用户说
 *   「请重新登录一次」指向的是唯一无效的动作。判定只在失败路径上跑一次
 *   `diagnose()`，健康路径不付任何代价。
 *
 * @module dsh-connect-workbuddy/auth
 */

import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
// Host-first with a local fallback: a static peer import here is a load-time
// crash in the standalone CLI, because tsdown shares this module with
// `bin.ts`'s chunk. See `src/host-peers.ts` and issue #47.
import { resolveDshHome, withFileLock, writeFileAtomic } from './host-peers.ts'
import { isEncryptedFieldWrapper, openEncryptedField, readAtRestKey, WORKBUDDY_APP_EXECUTABLE_ENV } from './at-rest.ts'
import { regionOf, type WorkBuddyRefreshOutcome, type WorkBuddyRegion } from './upstream.ts'

/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
  /**
   * The account's DISPLAY name, when the app publishes one (issue #124).
   *
   * For an enterprise member `nickname` is the LOGIN ALIAS, not a person's
   * name — a card showing it looks like it is managing somebody else's
   * account. The official client prefers this field, then the enterprise user
   * name, and only then the alias.
   *
   * Read from the desktop auth document when present. It is NOT always there
   * (the app writes only what it has), which is why the read order has three
   * steps rather than two.
   */
  displayName?: string
  /** The enterprise-side user name (`enterpriseUserName`), when published. */
  enterpriseUserName?: string
  uin?: string
  /** Which auth file this came from; refreshes are always `dsh`. */
  source: 'desktop' | 'dsh'
  /** Absolute path of the auth file this credential was read from. */
  filePath: string
  /**
   * Epoch ms the upstream last issued this token (`auth.lastRefreshTime`).
   *
   * This is the ONLY trustworthy freshness signal. `expiresAtMs` cannot be
   * used for ranking: when the upstream revokes a token it leaves the stored
   * `expiresAt` untouched, so a long-dead backup can claim a LATER expiry than
   * the live sign-in (observed on a real machine — a 2026-07-08 backup claimed
   * 2027-07-06 while the live file expired 2026-11-14, and only the live file
   * was accepted). Undefined when the document omits the field.
   */
  lastRefreshAtMs?: number
}

/**
 * Why one probed path did not yield an account.
 *
 * These are safe to surface: they carry paths and cause only, never token
 * material. `encrypted` is the WorkBuddy-specific one — a build whose token
 * fields are encrypted cannot be read at all unless the desktop app itself is
 * present to hand over its at-rest key, so "sign in again" is the wrong advice
 * for it (the user may be perfectly signed in).
 *
 * `wrong-region` is the second WorkBuddy-specific one, and it exists because of
 * a real bug: a region-scoped store filters out every credential that belongs to
 * the other region, so a candidate file holding a perfectly valid sign-in for
 * the other tab was dropped by exactly the same `continue` that drops malformed
 * files. The file then appeared in NO list at all — not an account (filtered by
 * region) and not a failure (it parsed) — so a card could name two paths while
 * its report listed one, and the user's actual, working sign-in was the one
 * made invisible. Reporting it is also the most useful answer we can give: the
 * user is signed in, and merely on the wrong tab.
 */
export interface WorkBuddyCandidateFailure {
  path: string
  source: 'desktop' | 'dsh'
  reason: 'missing' | 'unreadable' | 'invalid' | 'encrypted' | 'wrong-region'
  message?: string
}

/** Read-only sign-in summary for status and doctor output. */
export interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out'
  expiresAtMs?: number
  refreshExpiresAtMs?: number
  nickname?: string
  domain?: string
  source?: 'desktop' | 'dsh'
}

/**
 * Marker for a credential that EXISTS but could not be decrypted.
 *
 * Identified by {@link ENCRYPTED_CREDENTIAL_CODE} rather than `instanceof`, so
 * the check keeps working when the thrower and the caller end up in different
 * module instances (bundled host half vs. a test's source import) — the same
 * convention `WorkBuddyCredentialRejectedError` uses.
 */
export const ENCRYPTED_CREDENTIAL_CODE = 'WORKBUDDY_ENCRYPTED_CREDENTIAL'

/**
 * The user IS signed in, but the credential file cannot be read.
 *
 * This exists because "signed out" and "signed in with an unreadable credential"
 * resolve to the same observable state — zero accounts — and were therefore
 * reported with the same message. That message told a correctly signed-in user
 * to sign in again, which cannot possibly help: from WorkBuddy 5.6.x the desktop
 * app encrypts its token fields, and reading them requires asking the installed
 * app for its key. If that app cannot be located, the fix is to point the plugin
 * at it (`WORKBUDDY_APP_EXECUTABLE`), never to sign in again.
 *
 * No token material is carried: only the paths and the environment variable.
 */
export class WorkBuddyEncryptedCredentialError extends Error {
  readonly code = ENCRYPTED_CREDENTIAL_CODE
  /** Files that hold an encrypted credential, for the user to recognize. */
  readonly paths: readonly string[]

  constructor(paths: readonly string[]) {
    const where = paths.length > 0 ? paths.join(', ') : 'the credential file'
    super(
      `workbuddy: your WorkBuddy sign-in is present but encrypted, so it cannot be read`
      + ` (${where}). The WorkBuddy desktop app must be present to hand over its key;`
      + ` install it, or set ${WORKBUDDY_APP_EXECUTABLE_ENV} to its executable if it lives elsewhere.`
      + ` Signing in again will not change this.`,
    )
    this.name = 'WorkBuddyEncryptedCredentialError'
    this.paths = paths
  }
}

/** Whether an error reports an unreadable (encrypted) credential. */
export function isEncryptedCredentialError(value: unknown): value is WorkBuddyEncryptedCredentialError {
  return typeof value === 'object'
    && value !== null
    && (value as { code?: unknown }).code === ENCRYPTED_CREDENTIAL_CODE
}

/** Constructor options; only {@link refresh} is required. */
export interface WorkBuddyStoreOptions {
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string
  /**
   * Explicit plugin-owned copy path, overriding the per-region default.
   * Injectable so the copy/refresh cycle is testable without a real machine.
   */
  ownPath?: string
  /**
   * Region this store serves. When set, only credentials whose login domain
   * maps to this region are discovered, selected, or refreshed — the two
   * regions' stores run side by side without seeing each other's accounts.
   */
  region?: WorkBuddyRegion
  /**
   * Legacy single-copy path read as a migration source; defaults to the
   * pre-dual-provider location. Injectable for tests.
   */
  legacyOwnPath?: string
  /**
   * The unified credential vault directory for this store. Defaults to the
   * per-region directory under the Harness home; injectable so the vault's
   * merge/scan behaviour is testable without touching a real machine.
   */
  vaultDir?: string
  /**
   * Auth directories to scan, overriding the platform defaults. Injectable so
   * the multi-account scan is testable without touching a real machine.
   */
  authDirs?: readonly string[]
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
  /**
   * Resolves the desktop app's at-rest field key, used to open documents whose
   * token fields are encrypted (Windows builds). Defaults to asking the
   * installed app; injectable so the encrypted path is testable.
   */
  resolveAtRestKey?: () => Promise<Buffer | undefined>
}

/** One selectable local account, token-free. */
/**
 * The name to SHOW for a credential (issue #124).
 *
 * The order matters and is not arbitrary: on an enterprise credential
 * `nickname` is the LOGIN ALIAS, so putting it first made the card look like it
 * was managing a stranger's account. The official client prefers the display
 * name, then the enterprise-side user name, and only then the alias.
 *
 * Blank spellings are skipped rather than preferred: the app writes `"   "` in
 * places, and rendering whitespace where a name belongs is worse than falling
 * through to the alias.
 *
 * Exported because the same order has to hold in the store's account list, the
 * pool rows and the composer panel — three sites that must not drift.
 */
export function preferredAccountName(fields: {
  displayName?: string
  enterpriseUserName?: string
  nickname?: string
}): string {
  for (const candidate of [fields.displayName, fields.enterpriseUserName, fields.nickname]) {
    if (candidate !== undefined && candidate.trim() !== '') return candidate
  }
  return ''
}

/**
 * Carry display names forward across a re-read of the same account.
 *
 * The desktop auth document is the only source for these fields and it does
 * not always publish them: a refresh that rewrites the document can drop
 * `displayName` while keeping the same sign-in. Replacing the whole record
 * would then silently fall back to the alias — the exact symptom #124 reports,
 * coming back on its own. So an absent field yields to the previous value and a
 * PRESENT one wins (it is the newer reading).
 */
export function mergeCredentialDisplayNames<T extends {
  displayName?: string
  enterpriseUserName?: string
  nickname?: string
}>(previous: T | undefined, next: T): T {
  if (previous === undefined) return next
  return {
    ...next,
    ...next.displayName === undefined && previous.displayName !== undefined
      ? { displayName: previous.displayName }
      : {},
    ...next.enterpriseUserName === undefined && previous.enterpriseUserName !== undefined
      ? { enterpriseUserName: previous.enterpriseUserName }
      : {},
    ...next.nickname === undefined && previous.nickname !== undefined
      ? { nickname: previous.nickname }
      : {},
  }
}

export interface WorkBuddyAccountChoice {
  /** Stable id derived from `uin` (or `uid` when uin is absent). */
  id: string
  /**
   * The account's human name, or `''` when the desktop app recorded none.
   *
   * Never an identifier: `uin`/`uid` are opaque numbers and UUIDs, and using one
   * as a display name reads as "the plugin does not know who this is". Callers
   * that render a name choose their own placeholder for the empty case.
   */
  accountName: string
  domain: string
  source: 'desktop' | 'dsh'
  tokenExpiresAtMs: number
  /** The auth file this account was read from; newest is preferred. */
  filePath: string
  selected: boolean
  /**
   * This account belongs to an enterprise (issue #124).
   *
   * Present only when `enterpriseId` is set. The credits come from the
   * enterprise table and the consumer daily check-in does not exist for it, so
   * callers branch on this FACT rather than on `status.active` (which reads
   * `false` for every enterprise member).
   */
  enterprise?: boolean
}

/** Legacy single-copy basename (pre-dual-provider); kept as migration source. */
export const WORKBUDDY_AUTH_FILENAME = '.workbuddy-auth.json'

/** Env variable that overrides the desktop auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

/**
 * Basenames the live WorkBuddy desktop auth file is known to use.
 *
 * ISSUE #174: the constant used to be ONE name, `workbuddy-desktop.info`, and
 * the 5.7.x Windows app writes `workbuddy-desktop-ai.info` instead — the same
 * directory, the same payload, a different filename (measured by the reporter:
 * `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\` held
 * `workbuddy-desktop-ai.info` plus timestamped backups of that same name, and no
 * file carrying the constant's name at all). The consequences were both silent:
 * the "live file always wins" rule in {@link fileRank} never matched, so
 * ordering fell back to `lastRefreshAtMs` (correct by luck, not by rule), and
 * `doctor` reported `desktopAuthFile.present: false` with a hint to set
 * `WORKBUDDY_AUTH_FILE` — on a machine whose credential had just been read
 * successfully from the default directory.
 *
 * Ordered, not a set: {@link WORKBUDDY_LIVE_FILENAME} stays the one this build
 * treats as canonical for writing, and the alternatives are probed after it. The
 * FIRST entry is what {@link defaultDesktopAuthCandidates} reports as the
 * expected path, so keep it there.
 */
const WORKBUDDY_LIVE_FILENAMES: readonly string[] = [
  'workbuddy-desktop.info',
  'workbuddy-desktop-ai.info',
]

/** Basename of the live WorkBuddy desktop auth file (the canonical one). */
const WORKBUDDY_LIVE_FILENAME = WORKBUDDY_LIVE_FILENAMES[0] as string

/**
 * Whether one basename is a LIVE desktop auth file (any of the known names).
 *
 * Every place that asked "is this the live file?" now asks this, so a new
 * spelling is added in one list instead of being chased through the reader, the
 * ranker and `doctor` separately — which is exactly how the three drifted apart.
 */
export function isLiveDesktopAuthFileName(name: string): boolean {
  return WORKBUDDY_LIVE_FILENAMES.includes(name)
}

/** Prefix of the plugin-owned per-region credential copies (legacy, read-only). */
const WORKBUDDY_OWN_PREFIX = '.workbuddy-auth'

/**
 * Directory name (inside the Harness home) of the plugin's unified credential
 * vault: every account the plugin knows — scanned from the desktop app AND
 * added through OAuth sign-in — is persisted there, one file per account.
 */
export const WORKBUDDY_VAULT_DIRNAME = 'workbuddy-vault'

/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1

/**
 * Plugin-owned copy path for one region inside the Harness home. Each
 * region's store refreshes into its own file so two simultaneously signed-in
 * regions never overwrite each other's refreshed token.
 */
export function workbuddyOwnAuthPath(region: WorkBuddyRegion): string {
  return join(resolveDshHome(), `${WORKBUDDY_OWN_PREFIX}.${region}.json`)
}

/**
 * Pre-dual-provider single-copy path. Still read as a migration source (a
 * legacy credential serves the region it belongs to until that region's own
 * first refresh writes the per-region file), and removed by `logout`.
 */
export function legacyWorkbuddyOwnAuthPath(): string {
  return join(resolveDshHome(), WORKBUDDY_AUTH_FILENAME)
}

/**
 * The vault's directory for one region inside the Harness home.
 *
 * The vault is the plugin's UNIFIED credential store: every account the
 * plugin knows lives here, whether it was scanned from the desktop app's
 * auth directory or added through OAuth sign-in. One file per account,
 * named by the account's stable id — so two sources yielding the same
 * account converge on the same file instead of duplicating it.
 */
export function workbuddyVaultDir(region: WorkBuddyRegion): string {
  return join(resolveDshHome(), WORKBUDDY_VAULT_DIRNAME, region)
}

/**
 * Serialize a credential to the vault's on-disk document.
 *
 * The on-disk field names are the DESKTOP document's snake-free shapes
 * (`expiresAt`, `lastRefreshTime`), which is what `parseWorkBuddyAuth`
 * reads back. Serializing the runtime camelCase fields verbatim parsed as
 * `expiresAtMs: 0` on the next read — every restart re-refreshed every
 * account, and a refresh outage could then take down sign-ins that were
 * perfectly healthy on disk.
 */
function vaultDocument(credential: WorkBuddyCredential, accountId: string, refreshedFrom?: string): VaultDocument {
  return {
    version: VAULT_FORMAT_VERSION,
    accountId,
    refreshedAtMs: Date.now(),
    ...refreshedFrom === undefined ? {} : { refreshedFrom: authFileName(refreshedFrom) },
    auth: {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      // 0 means "unknown": a zero expiry must not overwrite a known future
      // one, and `expiryToMs` maps 0 back to 0 on the read side.
      expiresAt: credential.expiresAtMs > 0 ? Math.floor(credential.expiresAtMs / 1000) : 0,
      ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAt: Math.floor(credential.refreshExpiresAtMs / 1000) },
      ...credential.lastRefreshAtMs === undefined ? {} : { lastRefreshTime: Math.floor(credential.lastRefreshAtMs / 1000) },
      domain: credential.domain,
    },
    account: {
      uid: credential.uid,
      ...credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId },
      ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
      ...credential.displayName === undefined ? {} : { displayName: credential.displayName },
      ...credential.enterpriseUserName === undefined ? {} : { enterpriseUserName: credential.enterpriseUserName },
      ...credential.uin === undefined ? {} : { uin: credential.uin },
    },
  }
}

/** Parse the vault document; other versions and shapes are rejected. */
function parseVaultDocument(text: string, filePath: string): WorkBuddyCredential | undefined {
  const parsed = parseVaultDocumentWithWriteTime(text, filePath)
  return parsed === undefined ? undefined : parsed.credential
}

/**
 * Parse a vault document into its credential plus the LOCAL write time.
 *
 * Internal merge plumbing: `refreshedAtMs` is the freshness signal
 * {@link isFresherVaultEntry} needs, but it is not part of
 * {@link WorkBuddyCredential} (the runtime type is shared with OAuth and
 * desktop reads, none of which carry it).
 */
function parseVaultDocumentWithWriteTime(
  text: string,
  filePath: string,
): { credential: WorkBuddyCredential, refreshedAtMs?: number, refreshedFrom?: string } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document['version'] !== VAULT_FORMAT_VERSION) return undefined
  if (typeof document['auth'] !== 'object' || document['auth'] === null) return undefined
  const credential = parseWorkBuddyAuth(JSON.stringify({ auth: document['auth'], account: document['account'] }), filePath)
  if (credential === undefined) return undefined
  const refreshedAtMs = typeof document['refreshedAtMs'] === 'number' && document['refreshedAtMs'] > 0
    ? document['refreshedAtMs']
    : undefined
  const refreshedFrom = typeof document['refreshedFrom'] === 'string' && document['refreshedFrom'] !== ''
    ? document['refreshedFrom']
    : undefined
  return {
    credential: { ...credential, source: 'dsh' },
    ...(refreshedAtMs === undefined ? {} : { refreshedAtMs }),
    ...(refreshedFrom === undefined ? {} : { refreshedFrom }),
  }
}

/**
 * File name of the vault's DISMISSAL list, stored beside the vault entries.
 *
 * It exists because deleting a vault entry is not the same as deleting an
 * account. `syncVault` writes every desktop sign-in it scans back into the
 * vault — that is how a desktop account becomes selectable — so removing the
 * vault file alone was undone by the very next scan: the row came back and the
 * button read as broken (measured: `removeAccount` returns true, `accounts()`
 * still lists it).
 *
 * Dismissal means HIDDEN UNTIL THE USER SCANS AGAIN, not deleted forever. A
 * desktop sign-in is still there in the app, and the manual 「re-scan」 action is
 * the user asking to see what the machine currently has — so
 * {@link WorkBuddyCredentialStore.clearDismissals} empties this list on every
 * manual scan and the accounts return. Without that, a removed account could
 * never be recovered except by reinstalling or re-signing in.
 *
 * The list must survive the automatic refreshes in between: the card polls the
 * usage route every 60 seconds, and an in-memory-only dismissal would let the
 * account reappear a minute after the user removed it. Hence a file.
 *
 * Dismissal is per ACCOUNT, not per source: hiding only the vault copy would
 * leave the same account listed from the desktop file, which is the
 * half-measure that produced the report.
 */
const VAULT_DISMISSED_FILENAME = '.dismissed.json'

/** Current on-disk format of the dismissal list; readers reject others. */
const DISMISSED_FORMAT_VERSION = 1

/**
 * The dismissal list as persisted: account ids the user removed, newest last.
 *
 * An ARRAY, not a map with timestamps: nothing reads when a dismissal happened,
 * and a size cap is enough to keep the file from growing without bound across
 * years of adding and removing accounts.
 */
interface DismissedDocument {
  version: typeof DISMISSED_FORMAT_VERSION
  accountIds: string[]
}

/**
 * Ceiling on remembered dismissals.
 *
 * Generous on purpose: an entry is 24 characters, so a thousand of them is a
 * ~28 KB file, while dropping a REAL dismissal early would resurrect the account
 * and reintroduce the exact bug this list exists to fix. Only the oldest are
 * dropped, and only far beyond any plausible number of removed accounts.
 */
const DISMISSED_LIMIT = 1000
/**
 * How long one scan may be shared across callers, in milliseconds.
 *
 * One page open asks the store for the same account list six times (usage
 * route: accounts, status, resolve; the credits panel: once PER ACCOUNT through
 * `credentialFor`; and both region tabs poll together). Each read re-listed the
 * auth directory, re-parsed every file and re-ran the vault merge — measured at
 * 6 `readdir` and (6N+12) `readFile` for N accounts.
 *
 * Why a WINDOW and not a plain in-flight share: the six reads are SEQUENTIAL
 * (`await` one after another), so by the time the second starts the first has
 * resolved and there is nothing in flight to join. Sharing only concurrent reads
 * optimised nothing at all.
 *
 * Why so short: this is not a cache of the account list, it is an admission that
 * one page open IS one logical read. Anything longer would delay noticing a
 * sign-in the desktop app made on its own — discovery IS polling, so this window
 * is how long such a change may stay unseen. The card polls every 60 s, so 1 s is
 * invisible to the user while collapsing one page open from six scans to one. A
 * write through this store invalidates the window outright, so the actions the
 * user takes here (OAuth add, import, remove, rescan) are never delayed by it.
 */
const SCAN_SHARE_WINDOW_MS = 1000

/** Read the dismissal list; an absent or unreadable file reads as empty. */
async function readDismissed(dir: string): Promise<Set<string>> {
  const dismissed = new Set<string>()
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, VAULT_DISMISSED_FILENAME), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return dismissed
    const document = parsed as Record<string, unknown>
    if (document['version'] !== DISMISSED_FORMAT_VERSION) return dismissed
    const ids = document['accountIds']
    if (!Array.isArray(ids)) return dismissed
    for (const id of ids) {
      if (typeof id === 'string' && VAULT_ACCOUNT_ID_RE.test(id)) dismissed.add(id)
    }
  } catch {
    // Absent (the common case) or unreadable: nothing is dismissed. A broken
    // list must not take account discovery down — the accounts come back,
    // which is the honest failure direction for a file that only REMOVES things.
  }
  return dismissed
}

/** Write the dismissal list atomically under its own lock. */
async function writeDismissed(dir: string, dismissed: ReadonlySet<string>): Promise<void> {
  const path = join(dir, VAULT_DISMISSED_FILENAME)
  // Oldest-first trim: insertion order is preserved by the Set, so the first
  // entries are the oldest dismissals.
  const ids = [...dismissed].slice(-DISMISSED_LIMIT)
  const document: DismissedDocument = { version: DISMISSED_FORMAT_VERSION, accountIds: ids }
  await withFileLock(path, async () => {
    await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  })
}

/**
 * Whether a directory entry is ONE ACCOUNT's vault credential file.
 *
 * The vault directory holds more than credentials: `writeDismissed` puts
 * `.dismissed.json` here, and atomic writes transiently leave
 * `<id>.json.<hex>.tmp` siblings behind. Both used to be swept up by a bare
 * `endsWith('.json')` check, and the DISMISSAL file in particular is
 * well-formed JSON that is not a credential — so `diagnose` reported it at the
 * user as 「not a readable vault credential」 on any machine where an account
 * had been removed, turning a healthy sign-in into an unreadable-looking one.
 *
 * The rule is the account id shape the store itself writes
 * ({@link VAULT_ACCOUNT_ID_RE}), not a naming convention: a file qualifies only
 * when its stem is a real id, which no bookkeeping or temp file can be. A
 * `.tmp` sibling therefore fails on the dot of its extension, and a hidden file
 * fails on its leading dot even before that.
 */
function isVaultCredentialFileName(name: string): boolean {
  if (!name.endsWith('.json')) return false
  return VAULT_ACCOUNT_ID_RE.test(name.slice(0, -'.json'.length))
}

/** Current on-disk format of the vault; readers reject others. */
const VAULT_FORMAT_VERSION = 1

/** The vault document, as persisted. */
interface VaultDocument {
  version: typeof VAULT_FORMAT_VERSION
  accountId: string
  /**
   * Local epoch ms of the write that last produced this entry — the FRESHNESS
   * signal the merge rule compares against a desktop document's
   * `lastRefreshTime`. Not part of the credential: the upstream never stated
   * it, and stuffing it there would make `parseWorkBuddyAuth` read the field
   * as one of its own.
   */
  refreshedAtMs?: number
  /**
   * The file NAME of the desktop candidate this entry was refreshed FROM, when
   * the entry was produced by {@link WorkBuddyCredentialStore.refreshNow} on
   * that very file.
   *
   * This is the third state the two-clock comparison could not express. The
   * serve rule gives the live desktop file absolute priority (see
   * {@link fileRank}), which is correct while the app keeps writing a healthy
   * token — but a token the plugin itself refreshed is strictly newer than the
   * one the app last wrote, and re-reading the live file on every restart
   * resurrects the stale copy, so each restart refreshes again (a loop the
   * merged vault was meant to break). Name equality is exact and cheap: it
   * says "this entry IS a refresh of that file", which no timestamp can.
   *
   * Absent for entries written by a scan (the plugin did not refresh them) and
   * for entries written by OAuth sign-in or an import (nothing was refreshed),
   * so those keep the old precedence untouched.
   */
  refreshedFrom?: string
  /**
   * The credential in the nested desktop document's TWO-key shape: tokens and
   * session fields under `auth`, identity fields under `account`.
   * `parseWorkBuddyAuth` reads identity from the `account` key only, so a
   * document that folds everything into one key parses back with EMPTY
   * identity — the account id then stops matching the file name and the
   * entry is rejected on read.
   */
  auth: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    refreshExpiresAt?: number
    lastRefreshTime?: number
    domain: string
  }
  account: {
    uid: string
    enterpriseId?: string
    nickname?: string
    uin?: string
  }
}

/**
 * Platform-default directories holding the WorkBuddy desktop app's auth file.
 *
 * Windows and Linux prefer the OS-issued env location and fall back to the
 * home-derived convention when it is unset, so a redirected profile (OneDrive
 * folder backup, enterprise policy) still resolves. macOS has no equivalent
 * env variable; the single Application Support path is used as-is.
 *
 * `platform`, `home`, and `env` are injectable so the platform branches are
 * testable on any host without touching a real machine.
 */
export function defaultDesktopAuthDirs(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  if (platform === 'win32') {
    const local = nonEmptyEnv(env['LOCALAPPDATA']) ?? join(home, 'AppData', 'Local')
    const roaming = nonEmptyEnv(env['APPDATA']) ?? join(home, 'AppData', 'Roaming')
    return [
      join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ]
  }
  if (platform === 'linux') {
    const config = nonEmptyEnv(env['XDG_CONFIG_HOME']) ?? join(home, '.config')
    return [join(config, 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  return []
}

/** A non-empty, trimmed env value, or undefined when unset/blank. */
function nonEmptyEnv(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * The live auth file's platform candidates, in probe order.
 *
 * Every known basename for every platform directory: a machine can hold the old
 * and the new spelling side by side during an app upgrade, and probing only the
 * canonical one is the defect issue #174 reports.
 */
export function defaultDesktopAuthCandidates(): string[] {
  const candidates: string[] = []
  for (const dir of defaultDesktopAuthDirs()) {
    for (const name of WORKBUDDY_LIVE_FILENAMES) candidates.push(join(dir, name))
  }
  return candidates
}

/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
export function defaultDesktopAuthPath(): string | undefined {
  return defaultDesktopAuthCandidates()[0]
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
export function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

/**
 * Resolve one string field, transparently opening the desktop app's
 * encrypted-field wrapper when present.
 *
 * Windows builds of the WorkBuddy desktop app store `accessToken` and
 * `refreshToken` as `{$wbEncrypted:1,envelope}` instead of plain strings; a
 * reader that only accepts strings sees no credential at all and reports the
 * account as signed out. The SAME treatment applies to `nickname`: it is
 * encrypted in those builds too, so a strings-only reader silently degrades the
 * account's display name to its uin (a bare number) even after tokens start
 * working — which reads as "the plugin does not know who this is".
 *
 * `key` is undefined when the at-rest key could not be obtained, in which case
 * an encrypted field resolves to undefined rather than to a fabricated value.
 */
function credentialField(
  value: unknown,
  key: Buffer | undefined,
): string | undefined {
  if (typeof value === 'string') return value
  if (!isEncryptedFieldWrapper(value)) return undefined
  if (key === undefined) return undefined
  return openEncryptedField(value, key)
}

/**
 * An optional field that may legitimately be absent: an absent value, a
 * non-string that is not a wrapper, and an unopenable wrapper all mean
 * "unknown", which must not fail the whole document. Only the REQUIRED token
 * fields treat an unopenable wrapper as fatal (see {@link parseWorkBuddyAuth}).
 *
 * `account.phoneNumber` is deliberately never read: it is encrypted in these
 * builds, and the card's privacy contract admits nickname, masked uin, expiry
 * and credits only — a phone number is none of the plugin's business.
 */
function optionalCredentialField(value: unknown, key: Buffer | undefined): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (!isEncryptedFieldWrapper(value)) return undefined
  if (key === undefined) return undefined
  try {
    return openEncryptedField(value, key)
  } catch {
    return undefined
  }
}

/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 *
 * `atRestKey` is required to read documents whose fields are encrypted
 * (see {@link credentialField}); pass the key obtained from
 * `readAtRestKey()` when the plain read reports no token.
 */
export function parseWorkBuddyAuth(
  text: string,
  filePath: string,
  atRestKey?: Buffer,
): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    identity = typeof document['account'] === 'object' && document['account'] !== null
      ? document['account'] as Record<string, unknown>
      : {}
  } else {
    auth = document
    identity = document
  }
  let accessToken: string | undefined
  let refreshToken: string | undefined
  try {
    accessToken = credentialField(auth['accessToken'], atRestKey)
    refreshToken = credentialField(auth['refreshToken'], atRestKey)
  } catch {
    // A malformed envelope, a key mismatch, or a failed authentication tag is
    // "this document is not readable", exactly like an absent token — it must
    // never surface as a half-decrypted credential.
    return undefined
  }
  if (accessToken === undefined || accessToken === '') return undefined
  const expiresAtMs = typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0
  const refreshExpiresAtMs = typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  const lastRefreshAtMs = typeof auth['lastRefreshTime'] === 'number' ? expiryToMs(auth['lastRefreshTime']) : undefined
  const enterpriseId = optionalCredentialField(identity['enterpriseId'], atRestKey)
  const nickname = optionalCredentialField(identity['nickname'], atRestKey)
  const displayName = optionalCredentialField(identity['displayName'], atRestKey)
  const enterpriseUserName = optionalCredentialField(identity['enterpriseUserName'], atRestKey)
  const uin = optionalCredentialField(identity['uin'], atRestKey)
  const credential: WorkBuddyCredential = {
    accessToken,
    refreshToken: refreshToken ?? '',
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalCredentialField(auth['domain'], atRestKey) ?? '',
    uid: optionalCredentialField(identity['uid'], atRestKey) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    ...displayName === undefined ? {} : { displayName },
    ...enterpriseUserName === undefined ? {} : { enterpriseUserName },
    ...uin === undefined ? {} : { uin },
    ...lastRefreshAtMs === undefined ? {} : { lastRefreshAtMs },
    source: 'desktop',
    filePath,
  }
  return credential
}

/**
 * Whether a document carries any field the reader must decrypt — the token
 * fields or the identity fields — i.e. whether reading it needs the at-rest key
 * at all.
 *
 * Deciding this BEFORE asking the app for its key keeps the plain case (macOS
 * and older Windows builds, and every plugin-owned copy) from paying for a
 * child process on every credential read. Identity fields are included because
 * a future build could encrypt the display name while leaving tokens plain;
 * gating on tokens alone would then silently drop the name again.
 */
export function hasEncryptedCredentialFields(text: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const document = parsed as Record<string, unknown>
  const auth = typeof document['auth'] === 'object' && document['auth'] !== null
    ? document['auth'] as Record<string, unknown>
    : document
  const identity = typeof document['account'] === 'object' && document['account'] !== null
    ? document['account'] as Record<string, unknown>
    : document
  return isEncryptedFieldWrapper(auth['accessToken'])
    || isEncryptedFieldWrapper(auth['refreshToken'])
    || isEncryptedFieldWrapper(identity['nickname'])
    || isEncryptedFieldWrapper(identity['uin'])
    || isEncryptedFieldWrapper(identity['uid'])
    || isEncryptedFieldWrapper(identity['enterpriseId'])
    || isEncryptedFieldWrapper(auth['domain'])
}

/**
 * Rank two candidate files for the same account.
 *
 * The live `workbuddy-desktop.info` always wins: it is the app's current
 * sign-in, and the upstream revokes the tokens in the timestamped backups
 * even though their stored `expiresAt` is still in the future (observed on a
 * real machine — every backup claimed a 2027 expiry while only the live
 * file's token was accepted). Expiry is therefore only a tie-breaker among
 * backups, never the primary ordering.
 */
function fileRank(path: string): number {
  return isLiveDesktopAuthFileName(authFileName(path)) ? 0 : 1
}

/**
 * Whether `candidate` is a better pick than `incumbent` for the same account.
 *
 * Ordering, strongest signal first:
 *
 * 1. the live `workbuddy-desktop.info` (the app's current sign-in);
 * 2. the most recent `lastRefreshAtMs` — the upstream's own issuance time;
 * 3. `expiresAtMs`, only as a fallback for documents that omit the field.
 *
 * Step 2 is what makes this correct. `expiresAt` describes how long the token
 * was VALID FOR at issue time, not whether it is still accepted: a revoked
 * backup keeps a far-future `expiresAt` (2027 in the observed case) and would
 * otherwise outrank the working live credential, which is exactly how a
 * signed-in account turned into an upstream HTML 401.
 */
function isFresher(
  candidate: WorkBuddyCredential,
  incumbent: WorkBuddyCredential,
): boolean {
  const rankDiff = fileRank(candidate.filePath) - fileRank(incumbent.filePath)
  if (rankDiff !== 0) return rankDiff < 0
  const candidateRefresh = candidate.lastRefreshAtMs
  const incumbentRefresh = incumbent.lastRefreshAtMs
  if (candidateRefresh !== undefined && incumbentRefresh !== undefined) {
    if (candidateRefresh !== incumbentRefresh) return candidateRefresh > incumbentRefresh
  } else if (candidateRefresh !== undefined) {
    // A file that records its issuance time outranks one that does not; the
    // field is always present in desktop documents, so this only decides
    // against synthetic or truncated input.
    return true
  } else if (incumbentRefresh !== undefined) {
    return false
  }
  return candidate.expiresAtMs > incumbent.expiresAtMs
}

/**
 * Filename of a path regardless of the host separator: Windows paths use `\`
 * and this helper must keep working when a Windows path is compared on a
 * POSIX host (e.g. tests injecting a Windows-style auth dir).
 */
export function authFileName(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separator === -1 ? path : path.slice(separator + 1)
}

/**
 * The exact shape of an account id — sha256 hex sliced to 24 characters, which
 * is what {@link workbuddyAccountId} emits and therefore the only string a
 * vault file name can legitimately have.
 *
 * An id becomes a path segment, so this is also the traversal guard: an
 * attacker-supplied `../..` is rejected before it can address anything outside
 * the vault directory. Exported so the HTTP route can reject a bad id with a
 * 400 instead of a thrown error.
 */
export const VAULT_ACCOUNT_ID_RE = /^[0-9a-f]{24}$/

/** Whether a string is a well-formed account id. */
export function isVaultAccountId(value: unknown): value is string {
  return typeof value === 'string' && VAULT_ACCOUNT_ID_RE.test(value)
}

/**
 * Stable account id. `uin` is the billing identity the upstream keys on and
 * survives across re-login; `uid` is the fallback for documents without one.
 */
export function workbuddyAccountId(
  credential: Pick<WorkBuddyCredential, 'uin' | 'uid' | 'nickname'>,
): string {
  const stable = credential.uin ?? credential.uid ?? credential.nickname ?? 'unknown'
  return createHash('sha256').update(`workbuddy\0${stable}`).digest('hex').slice(0, 24)
}

/**
 * Parse the plugin-owned copy; other versions and shapes are rejected.
 *
 * Pre-vault copies serialized the RUNTIME credential verbatim, whose expiry
 * field is `expiresAtMs` (ms) rather than the desktop document's
 * `expiresAt` (s) that `parseWorkBuddyAuth` reads — the round trip used to
 * lose the expiry and force a refresh after every restart. The runtime field
 * is read back here as the fallback.
 */
function parseOwnDocument(text: string, filePath: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document['version'] !== OWN_FORMAT_VERSION) return undefined
  if (typeof document['credential'] !== 'object' || document['credential'] === null) return undefined
  const credential = parseWorkBuddyAuth(JSON.stringify({ auth: document['credential'] }), filePath)
  if (credential === undefined) return undefined
  const runtime = document['credential'] as Record<string, unknown>
  const legacyExpiry = typeof runtime['expiresAtMs'] === 'number' ? expiryToMs(runtime['expiresAtMs']) : 0
  return {
    ...credential,
    ...credential.expiresAtMs === 0 && legacyExpiry > 0 ? { expiresAtMs: legacyExpiry } : {},
    source: 'dsh',
  }
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Whether a freshly scanned credential should REPLACE a vault entry of the
 * same account.
 *
 * The vault is a CACHE of credentials the machine already holds, not a
 * competing source. Two clocks decide, compared like against like:
 *
 * - The scan's clock is the DESKTOP document's `lastRefreshTime` (the
 *   upstream's own issuance time) — and the live file ranks above every
 *   backup regardless of time, per {@link fileRank}.
 * - The vault entry's clock is `refreshedAtMs`, the local write time of the
 *   plugin refresh (or OAuth login) that produced it. A wall clock is not
 *   comparable to an issuance time, so the two are NOT mixed: the entry is
 *   replaced only when the scan's read is the live sign-in AND either the
 *   entry predates the scan read's issuance, or the entry was written before
 *   the plugin refreshed into it — approximated by requiring the live file's
 *   issuance to be NEWER than the entry's write time.
 *
 * The rule's purpose is breaking the refresh loop: without it, a scan keeps
 * reinstating the (older, soon-to-expire) desktop token over the refreshed
 * vault copy, so every restart re-refreshes every account. With it, the
 * desktop token wins only while it is genuinely newer than what the plugin
 * last wrote — after that the refreshed copy is the operative credential,
 * exactly like the pre-vault per-region copies behaved.
 */
function shouldReplaceVaultEntry(
  candidate: WorkBuddyCredential,
  incumbent: VaultEntry,
): boolean {
  if (fileRank(candidate.filePath) !== 0) return false
  const writeMs = incumbent.refreshedAtMs
  if (writeMs === undefined) return true
  const issuanceMs = candidate.lastRefreshAtMs
  if (issuanceMs === undefined) return candidate.expiresAtMs > incumbent.credential.expiresAtMs
  return issuanceMs > writeMs
}

/**
 * Read every vault entry for one region directory.
 *
 * The map is keyed by account id, which the FILE NAME already carries: the
 * id inside the document is checked against it and a mismatched file is
 * skipped — a file copied between accounts (or a half-written rename) must
 * not silently answer for the wrong account.
 */
async function readVaultEntries(dir: string): Promise<Map<string, VaultEntry>> {
  const entries = new Map<string, VaultEntry>()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error: unknown) {
    // Absent vault = empty vault, not an error; anything else propagates so
    // the caller can skip its write pass too.
    if (isENOENT(error)) return entries
    throw error
  }
  for (const name of names) {
    // Credential files only: `.dismissed.json` and `.tmp` siblings live in this
    // directory too, and parsing them here would either add a bogus entry or
    // (the real defect) surface as an unreadable credential to the user. See
    // {@link isVaultCredentialFileName}.
    if (!isVaultCredentialFileName(name)) continue
    const path = join(dir, name)
    try {
      const parsed = parseVaultDocumentWithWriteTime(await readFile(path, 'utf8'), path)
      if (parsed === undefined) continue
      const id = name.slice(0, -'.json'.length)
      if (workbuddyAccountId(parsed.credential) !== id) continue
      entries.set(id, parsed)
    } catch {
      // absent or unreadable between readdir and open — skip, don't fail
    }
  }
  return entries
}

/**
 * One vault entry as read from disk: the credential plus the two bookkeeping
 * fields the merge rules read alongside it.
 */
interface VaultEntry {
  credential: WorkBuddyCredential
  /** Local write time of the file; compared against a desktop issuance time. */
  refreshedAtMs?: number
  /** Desktop file this entry was refreshed FROM; see {@link VaultDocument}. */
  refreshedFrom?: string
}

/** Write one vault entry atomically under the file lock. */
async function writeVaultEntry(
  dir: string,
  accountId: string,
  credential: WorkBuddyCredential,
  refreshedFrom?: string,
): Promise<void> {
  const path = join(dir, `${accountId}.json`)
  await withFileLock(path, async () => {
    await writeFileAtomic(path, `${JSON.stringify(vaultDocument(credential, accountId, refreshedFrom), null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  })
}

/**
 * One candidate file's probe result: the credential it yielded, or the reason
 * it yielded none.
 *
 * `encrypted` is deliberately its own reason rather than folding into
 * `invalid`. A document whose token fields are encrypted is *unreadable without
 * the desktop app*, not malformed — reporting it as invalid would send a
 * correctly signed-in user off to sign in again, which cannot possibly help.
 */
type AuthFileProbe =
  | { credential: WorkBuddyCredential }
  | { failure: Omit<WorkBuddyCandidateFailure, 'path' | 'source'> }

/**
 * Probe one auth file, reporting WHY it yielded no credential.
 *
 * The desktop app encrypts its token fields on Windows builds. The plain read
 * is tried first and the app is only asked for its at-rest key when the
 * document actually carries encrypted wrappers, so the common case costs no
 * child process. `resolveAtRestKey` is injectable so the encrypted path is
 * testable without a real desktop install.
 */
async function probeAuthFile(
  path: string,
  resolveAtRestKey: () => Promise<Buffer | undefined>,
): Promise<AuthFileProbe> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    const missing = isENOENT(error)
    return {
      failure: {
        reason: missing ? 'missing' : 'unreadable',
        // An ENOENT message is the path spelled out again ("ENOENT: no such
        // file or directory, open '<path>'"), and the card already prints that
        // path on its own line — carrying it here rendered the same string
        // twice in a row. A genuine read error (EACCES, EISDIR) says something
        // the reason alone does not, so only that one is kept.
        ...missing ? {} : { message: error instanceof Error ? error.message : String(error) },
      },
    }
  }
  const plain = parseWorkBuddyAuth(text, path)
  if (plain !== undefined) return { credential: plain }
  // Not plain-readable. Distinguish "the app encrypted this and we could not
  // open it" from "this document is simply not a credential": only the former
  // deserves the encrypted-specific advice.
  const encrypted = hasEncryptedCredentialFields(text)
  if (!encrypted) {
    return isParseableJson(text)
      ? { failure: { reason: 'invalid', message: 'no access token in the document' } }
      : { failure: { reason: 'invalid', message: 'the file is not valid JSON' } }
  }
  let key: Buffer | undefined
  try {
    key = await resolveAtRestKey()
  } catch (error: unknown) {
    // The app did not hand over its key (not installed, older or newer build).
    return {
      failure: {
        reason: 'encrypted',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
  if (key === undefined) {
    return {
      failure: {
        reason: 'encrypted',
        message: `the credential fields are encrypted and no key was available; the WorkBuddy desktop app must be present (or set ${WORKBUDDY_APP_EXECUTABLE_ENV})`,
      },
    }
  }
  const decrypted = parseWorkBuddyAuth(text, path, key)
  // A key WAS obtained and the document still did not yield a token: the
  // envelope is malformed, the key belongs to another build, or the auth tag
  // failed. That is a genuine format problem, not a missing app.
  return decrypted === undefined
    ? { failure: { reason: 'invalid', message: 'the encrypted credential fields could not be opened with the desktop app\'s key' } }
    : { credential: decrypted }
}

/** Whether text parses as JSON at all; distinguishes "wrong shape" from "not JSON". */
function isParseableJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Read one auth file, tolerating absence and unparsable content. Kept as the
 * credential-only view for callers that do not need the failure reason.
 */
async function readAuthFile(
  path: string,
  resolveAtRestKey: () => Promise<Buffer | undefined>,
): Promise<WorkBuddyCredential | undefined> {
  const probe = await probeAuthFile(path, resolveAtRestKey)
  return 'credential' in probe ? probe.credential : undefined
}

/**
 * Read-only credential store with demand-driven refresh and multi-account
 * discovery.
 *
 * Refresh policy: refresh only when the access token is inside the margin
 * (or already expired), keep the refreshed credential in the plugin-owned
 * copy, and never write the desktop app's files. A failed refresh still
 * returns a not-yet-expired token so an unreachable refresh endpoint does
 * not take down a working session.
 */
export class WorkBuddyCredentialStore {
  private readonly refresh: WorkBuddyStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private readonly region: WorkBuddyRegion | undefined
  private readonly ownPathExplicit: string | undefined
  private readonly legacyOwnPath: string
  private readonly legacyOwnPathExplicit: string | undefined
  private readonly vaultDirExplicit: string | undefined
  /** The vault directory, resolved ONCE at construction. */
  private readonly vaultDirResolved: string
  private readonly authDirs: readonly string[] | undefined
  private readonly resolveAtRestKey: () => Promise<Buffer | undefined>
  private desktopPathOverride: string | undefined
  private accountId: string | undefined
  private inflight: Promise<WorkBuddyCredential> | undefined
  /**
   * In-flight/completed scan for the CURRENT `readAll` generation.
   *
   * One page open calls `readAll` six times: the usage route asks for the
   * account list, the sign-in state and the resolved credential, then the
   * per-account credits panel asks once PER ACCOUNT (`credentialFor`), and both
   * region tabs poll on the same timer. Each call re-read every auth file,
   * re-parsed it, and re-ran the vault merge — measured at 6 `readdir` + (6N+12)
   * `readFile` for N accounts, i.e. the cost grew with the account count on a
   * path whose answer cannot change within one tick.
   *
   * This is deliberately NOT a time-based cache: a TTL would make the card show
   * a stale account list after an OAuth add or an import, which is the very
   * class of bug this card keeps chasing. Instead the promise is shared while it
   * is in flight, and every WRITE clears it (see `invalidateScan`) — so a read
   * after a write always scans again, and a read during a scan joins it.
   *
   * Undefined means "no scan in flight and nothing cached".
   */
  private scanInflight: Promise<readonly WorkBuddyCredential[]> | undefined
  /**
   * When the cached scan FINISHED, epoch ms; 0 means "not finished yet".
   *
   * Deliberately the finish time, not the start time (issue #77). The window
   * used to be measured from the START, so a scan that took longer than the
   * window was already outside it the moment it landed: the very next `readAll`
   * started a fresh scan, and the sharing this cache exists for never happened.
   * On the machine in that report one scan took 1.4–2.1 s against a 1000 ms
   * window, so every one of a page open's ~6 reads re-scanned the filesystem.
   */
  private scanFinishedAtMs = 0

  /**
   * A RUNTIME account override from the pool's rotation, or undefined.
   *
   * Deliberately separate from {@link accountId}, which is the user's persisted
   * choice. Rotation decides who serves *now*; it must never rewrite what the
   * user picked, or "turn rotation off" could not restore their selection and
   * the plugin would be unable to tell the two apart afterwards. Nothing here
   * is ever written to settings.
   */
  private rotatedAccountId: string | undefined

  constructor(options: WorkBuddyStoreOptions) {
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.region = options.region
    this.ownPathExplicit = options.ownPath
    this.legacyOwnPath = options.legacyOwnPath ?? legacyWorkbuddyOwnAuthPath()
    this.legacyOwnPathExplicit = options.legacyOwnPath
    this.vaultDirExplicit = options.vaultDir
    // Resolved once, at construction: the vault must not follow a later
    // $DSH_HOME change (tests swap it per test; a backgrounded scan that
    // resumes after the swap must keep writing to the store's OWN directory,
    // not the next user's).
    this.vaultDirResolved = options.vaultDir ?? (options.region !== undefined ? workbuddyVaultDir(options.region) : join(resolveDshHome(), WORKBUDDY_VAULT_DIRNAME))
    this.authDirs = options.authDirs
    this.desktopPathOverride = options.desktopPath
    this.resolveAtRestKey = options.resolveAtRestKey ?? readAtRestKey
  }

  /** Whether a credential's login domain belongs to this store's region. */
  private matchesRegion(domain: string): boolean {
    return this.region === undefined || regionOf(domain) === this.region
  }

  /**
   * The path this store refreshes into: the per-region file for a
   * region-scoped store, the legacy single file otherwise, or an explicitly
   * injected path in tests.
   */
  ownAuthPath(): string {
    if (this.ownPathExplicit !== undefined) return this.ownPathExplicit
    return this.region !== undefined ? workbuddyOwnAuthPath(this.region) : this.legacyOwnPath
  }

  /**
   * Every plugin-owned copy to read, most preferred first. A region-scoped
   * store reads the legacy single copy as its migration source (readAll's
   * region filter drops it when it carries the other region's credential); an
   * unscoped store reads everything so diagnostics see both regions.
   *
   * With an explicitly injected own path the legacy source is read ONLY when
   * it was injected too — a test that pins one file must not accidentally see
   * the real machine's legacy copy.
   */
  private ownCandidates(): string[] {
    if (this.ownPathExplicit !== undefined) {
      return this.legacyOwnPathExplicit !== undefined
        ? [this.ownPathExplicit, this.legacyOwnPathExplicit]
        : [this.ownPathExplicit]
    }
    if (this.region !== undefined) {
      return [workbuddyOwnAuthPath(this.region), this.legacyOwnPath]
    }
    return [this.legacyOwnPath, workbuddyOwnAuthPath('cn'), workbuddyOwnAuthPath('global')]
  }

  /** The vault directory this store reads and writes (fixed at construction). */
  private vaultDir(): string {
    return this.vaultDirResolved
  }

  /** Repoint the desktop file or directory; applies on the next read. */
  setDesktopPath(path: string | undefined): void {
    this.desktopPathOverride = path
    this.inflight = undefined
    this.invalidateScan()
  }

  /**
   * Select an account by id; tokens stay outside settings.
   *
   * The empty string is the settings-level sentinel for "no explicit
   * selection" (the card's Clear action writes it), so it is normalized here
   * rather than being kept as an id that can never match an account. Every
   * caller therefore gets the documented default — follow the app's current
   * sign-in — instead of a dead selection.
   */
  selectAccount(accountId: string | undefined): void {
    this.accountId = accountId === '' ? undefined : accountId
    this.inflight = undefined
    this.invalidateScan()
  }

  /** Selected account id, for diagnostics and route assembly. */
  selectedAccountId(): string | undefined {
    return this.accountId
  }

  /**
   * Whether the region runs a SAVED choice rather than the documented default.
   *
   * `false` means "follow the app's current sign-in", which is also what the
   * card's Clear action restores. The two states can resolve to the very same
   * account — an upgraded user whose pre-split `accountId` happens to be the
   * app's current sign-in clears the choice and sees no change at all — so the
   * card cannot infer this from the account list alone. It reports the state
   * here so clearing is observable instead of looking like a dead button.
   */
  hasExplicitSelection(): boolean {
    return this.accountId !== undefined
  }

  /** The auth-file path candidates, in probe order. */
  private resolveDesktopCandidates(): string[] {
    const fromEnv = process.env[WORKBUDDY_AUTH_FILE_ENV]
    const explicit = this.desktopPathOverride
      ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    if (explicit !== undefined) return [explicit]
    // THE CONFIGURED DIRECTORIES, not the platform defaults (issue #174). This
    // used to answer `defaultDesktopAuthCandidates()` unconditionally while
    // {@link candidateFiles} honoured `this.authDirs`, so the two disagreed
    // whenever the directories were overridden: the READER found the credential
    // in the configured directory while `desktopAuthPath()` / `desktopFilePresent()`
    // — what `doctor` reports as `present` and what the "set WORKBUDDY_AUTH_FILE"
    // hint is gated on — described a path the reader never touched. That is the
    // same shape the reporter saw from the filename side: a healthy credential on
    // the default path, and `present: false` beside it.
    return (this.authDirs ?? defaultDesktopAuthDirs())
      .flatMap(dir => WORKBUDDY_LIVE_FILENAMES.map(name => join(dir, name)))
  }

  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined {
    return this.resolveDesktopCandidates()[0]
  }

  /**
   * Every auth file to scan: the live file plus the timestamped backups
   * WorkBuddy leaves beside it.
   *
   * An explicitly configured path pins the *directory*: its siblings are
   * still scanned, because a user who points the plugin at their auth file
   * expects account switching to work the same way it does on the default
   * path. Only the file ordering changes.
   *
   * A corrupt or signed-out file must never hide the others, so each read is
   * independent and failures are skipped rather than propagated.
   */
  private async candidateFiles(): Promise<string[]> {
    const explicitPath = this.desktopPathOverride
      ?? ((process.env[WORKBUDDY_AUTH_FILE_ENV] ?? '').trim() !== ''
        ? (process.env[WORKBUDDY_AUTH_FILE_ENV] as string)
        : undefined)

    const files: string[] = []
    if (explicitPath !== undefined) {
      files.push(explicitPath)
      for (const backup of await this.backupsBeside(explicitPath)) files.push(backup)
      return files
    }

    const dirs = this.authDirs ?? defaultDesktopAuthDirs()
    const seen = new Set<string>()
    for (const dir of dirs) {
      // EVERY known live basename, not just the canonical one (issue #174): the
      // 5.7.x app writes `workbuddy-desktop-ai.info`, so probing only
      // `workbuddy-desktop.info` found the backups but never the live file.
      //
      // `backupsBeside` answers "the other .info files in this directory", so
      // running it once per live name would return the OTHER live file as a
      // backup — each file would then be scanned twice, and the second read
      // would overwrite the first's rank. The set collapses that, and the live
      // names are pushed first so their rank is decided by `fileRank`, not by
      // which branch happened to reach them.
      for (const name of WORKBUDDY_LIVE_FILENAMES) {
        const live = join(dir, name)
        if (!seen.has(live)) { seen.add(live); files.push(live) }
      }
      for (const name of WORKBUDDY_LIVE_FILENAMES) {
        for (const backup of await this.backupsBeside(join(dir, name))) {
          if (seen.has(backup)) continue
          seen.add(backup)
          files.push(backup)
        }
      }
    }
    return files
  }

  /** Timestamped siblings of one auth file, newest first by filename. */
  private async backupsBeside(path: string): Promise<string[]> {
    const dir = dirname(path)
    const base = path.slice(dir.length + 1)
    try {
      const entries = await readdir(dir)
      return entries
        .filter(name => name !== base && name.endsWith('.info'))
        .sort()
        .reverse()
        .map(name => join(dir, name))
    } catch {
      // Directory absent or unreadable: the live file alone is still probed.
      return []
    }
  }

  /**
   * Read every local credential, deduplicated by account id. Files are
   * probed newest-first, so the first entry for an account is its freshest.
   *
   * A region-scoped store sees only its own region's credentials: the other
   * region's accounts are invisible to selection, refresh, and status alike,
   * which is what keeps the two regions' providers from cross-billing.
   */
  /**
   * The account list, sharing one scan across concurrent and repeated reads.
   *
   * See {@link scanInflight}: the whole performance fix lives in these lines.
   * Every caller keeps its OWN semantics (`current`, `accounts`, `status`,
   * `selectionLost`), because this returns the same array they used to build
   * themselves — only the filesystem work is shared.
   *
   * The window runs from the FINISH time ({@link scanFinishedAtMs}), so a scan
   * slower than the window still serves the reads that follow it. A scan in
   * flight is always joined, however long it has been running.
   *
   * A failed scan is NOT cached: the rejection clears the slot so the next read
   * retries, rather than pinning every later caller to one transient failure.
   */
  private async readAll(): Promise<readonly WorkBuddyCredential[]> {
    if (this.scanInflight !== undefined) {
      // In flight: join it. Finished: share it only inside the window, counted
      // from when it FINISHED — see {@link scanFinishedAtMs}.
      if (this.scanFinishedAtMs === 0 || Date.now() - this.scanFinishedAtMs < SCAN_SHARE_WINDOW_MS) {
        return this.scanInflight
      }
    }
    this.scanFinishedAtMs = 0
    const scan = this.scanAll().then((credentials) => {
      this.scanFinishedAtMs = Date.now()
      return credentials
    }, (error: unknown) => {
      // A failed scan is not cached: the next read retries instead of every
      // later caller inheriting one transient failure.
      if (this.scanInflight === scan) this.scanInflight = undefined
      this.scanFinishedAtMs = 0
      throw error
    })
    this.scanInflight = scan
    return scan
  }

  /** Drop the shared scan so the next read re-reads the filesystem. */
  private invalidateScan(): void {
    this.scanInflight = undefined
    this.scanFinishedAtMs = 0
  }

  /** The one real scan: read every candidate file, then merge the vault. */
  private async scanAll(): Promise<readonly WorkBuddyCredential[]> {
    const files = await this.candidateFiles()
    // Dismissed accounts are filtered at BOTH ends of the merge. Here, before
    // the desktop scan joins the map: without this the account is rebuilt into
    // the vault by `syncVault` on every scan, so a removal never sticks (the
    // reported "cannot delete a desktop-scanned account").
    const dismissed = await readDismissed(this.vaultDir())
    const byId = new Map<string, WorkBuddyCredential>()
    for (const file of files) {
      const credential = await readAuthFile(file, this.resolveAtRestKey)
      if (credential === undefined || !this.matchesRegion(credential.domain)) continue
      const id = workbuddyAccountId(credential)
      if (dismissed.has(id)) continue
      const existing = byId.get(id)
      if (existing === undefined) {
        byId.set(id, credential)
        continue
      }
      // The live file outranks backups; between two backups the freshest
      // issuance time wins (see {@link isFresher}).
      //
      // Display names are carried forward from whichever copy is discarded: the
      // app does not always re-write `displayName` / `enterpriseUserName`, and
      // dropping them here would silently fall back to the login alias — the
      // exact symptom issue #124 reports, returning on its own.
      if (isFresher(credential, existing)) byId.set(id, mergeCredentialDisplayNames(existing, credential))
      else byId.set(id, mergeCredentialDisplayNames(credential, existing))
    }
    for (const own of await this.readOwns()) {
      if (!this.matchesRegion(own.domain)) continue
      const id = workbuddyAccountId(own)
      if (dismissed.has(id)) continue
      const existing = byId.get(id)
      // The plugin's refreshed copy carries no `lastRefreshTime` of its own, so
      // it cannot be ranked by issuance time. It supersedes a desktop file only
      // when it actually lives longer — and never displaces the live sign-in,
      // which the app keeps up to date and which the upstream always accepts.
      if (existing === undefined) {
        byId.set(id, own)
      } else if (fileRank(existing.filePath) !== 0 && own.expiresAtMs > existing.expiresAtMs) {
        byId.set(id, own)
      }
    }
    // The unified vault: scanned sign-ins are merged INTO it (incremental,
    // deduplicated, write-only-on-change), and its entries join the readable
    // set — that is how an OAuth-added account (which no desktop scan will
    // ever re-find) stays selectable across restarts.
    await this.syncVault(byId, dismissed)
    // FROZEN because this exact array is now handed to several callers (see
    // {@link scanInflight}). They all treat it as read-only today — find, some,
    // map — but a future `sort()` or `splice()` on it would silently reorder
    // every other reader's view for the rest of the window. Freezing turns that
    // into an immediate TypeError instead of a wrong account list.
    return Object.freeze([...byId.values()])
  }

  /**
   * Merge the scan's credentials into the vault and read the vault back.
   *
   * Incremental by contract: a scan that finds nothing new writes nothing.
   * Per account, the vault entry is written only when the scan's read is
   * fresher by {@link isFresherVaultEntry} — so a steady-state scan is
   * mtime-stable and every sync is O(accounts) reads with at most one write
   * per CHANGED account.
   */
  private async syncVault(scan: Map<string, WorkBuddyCredential>, dismissed: ReadonlySet<string>): Promise<void> {
    const dir = this.vaultDir()
    let entries: Map<string, VaultEntry>
    try {
      entries = await readVaultEntries(dir)
    } catch {
      // An unreadable vault must not take account discovery down: the scan's
      // own results are still valid. Writing is skipped this round, so a
      // broken directory cannot be made worse by this call.
      return
    }
    let dirReady = false
    for (const [id, credential] of scan) {
      // The write-back half of the same filter: this loop is what recreated a
      // deleted desktop account, so a dismissal must stop it here too.
      if (dismissed.has(id)) continue
      const incumbent = entries.get(id)
      if (incumbent !== undefined && !shouldReplaceVaultEntry(credential, incumbent)) continue
      if (!dirReady) {
        try {
          await mkdir(dir, { recursive: true })
          dirReady = true
        } catch {
          // No writable vault: discovery still returns the scan's accounts.
          return
        }
      }
      await writeVaultEntry(dir, id, credential)
      entries.set(id, { credential: { ...credential, source: 'dsh' }, refreshedAtMs: Date.now() })
    }
    for (const [id, entry] of entries) {
      if (!this.matchesRegion(entry.credential.domain)) continue
      const existing = scan.get(id)
      // A dismissed account must not re-enter through the vault loop either:
      // its vault file is gone, but a stale entry can outlive the delete when
      // the write and the delete interleave.
      if (dismissed.has(id)) continue
      // A vault entry the scan did not re-find is exactly the OAuth case (no
      // desktop file backs it), so it joins unconditionally.
      //
      // When the scan DID re-find the account the live sign-in keeps priority,
      // per {@link fileRank}: the app holds a current token and the upstream
      // rejects the ones in its timestamped backups. There is exactly one
      // exception — the entry records, in `refreshedFrom`, that the plugin
      // itself refreshed THAT file. The plugin's token was issued in answer to
      // it and is strictly newer than the copy the app last wrote, so serving
      // the app's older token here would resurrect it on every restart and
      // refresh again each time. This is the case that closes that loop; a
      // merely "longer-lived" vault copy still does not displace a live read.
      if (existing === undefined) {
        scan.set(id, entry.credential)
      } else if (entry.refreshedFrom !== undefined && entry.refreshedFrom === authFileName(existing.filePath)) {
        scan.set(id, entry.credential)
      } else if (fileRank(existing.filePath) !== 0 && entry.credential.expiresAtMs > existing.expiresAtMs) {
        scan.set(id, entry.credential)
      }
    }
  }

  /**
   * Default when no account is explicitly selected: the live sign-in, else the
   * freshest credential. Following the app's current sign-in is the documented
   * default behaviour; the backups exist so the user can switch explicitly.
   * This is NOT credit-seeking — it never reorders accounts to find one with
   * remaining credit.
   */
  private preferred(credentials: readonly WorkBuddyCredential[]): WorkBuddyCredential | undefined {
    if (credentials.length === 0) return undefined
    return credentials.reduce((best, credential) => isFresher(credential, best) ? credential : best)
  }

  /**
   * Token-free account list for the plugin card.
   *
   * `selected` answers one question only: which row is the account the plugin
   * is actually going to use? That is exactly what {@link current} decides, so
   * the two must never disagree — the card renders this list while the shim
   * bills through `current()`, and a row marked "selected" that `current()`
   * refuses to use is what made the dropdown look healthy while every request
   * failed with 401.
   *
   * THE POOL'S RUNTIME OVERRIDE IS PART OF `current()`, SO IT IS PART OF THIS.
   * `current()` consults `rotatedAccountId` FIRST; this method used to ignore it
   * and answer from `accountId` alone. With the pool on, the two therefore
   * disagreed on every rotation: the shim billed account B while the card marked
   * account A — the reporter's screenshot showed 「当前选用」 on a rate-limited
   * account while the pill's total belonged to the one actually serving. Worse,
   * the usage document takes its `credential` from `current()` and its
   * `account.accountId` from this list, so one document could name two accounts.
   *
   * So an explicit selection that matches NO local account marks nothing as
   * selected (no silent fallback to a different account — see {@link current}).
   * The implicit default is marked only when nothing was explicitly chosen.
   * A live rotation marker wins over both, mirroring `current()`'s precedence,
   * and only while it still names a local account — `current()` falls through in
   * that case, and so does this.
   */
  async accounts(): Promise<WorkBuddyAccountChoice[]> {
    const credentials = await this.readAll()
    if (credentials.length === 0) return []
    const hasExplicitSelection = this.accountId !== undefined
    const selectedExists = hasExplicitSelection
      && credentials.some(credential => workbuddyAccountId(credential) === this.accountId)
    const defaultSelected = this.preferred(credentials)
    // The SAME precedence `current()` uses, resolved to an id once. Mirroring it
    // here (rather than calling `current()`) keeps this list a single read of
    // the credential directory; the fall-through rules are identical: a rotated
    // id that names no local account is ignored, and an explicit choice that
    // matches nothing marks nothing.
    const rotatedId = this.rotatedAccountId !== undefined
      && credentials.some(credential => workbuddyAccountId(credential) === this.rotatedAccountId)
      ? this.rotatedAccountId
      : undefined
    return credentials.map(credential => {
      const id = workbuddyAccountId(credential)
      return {
        id,
        // The human name, or '' when the app did not give one. Deliberately NO
        // fallback to `uin`/`uid`: those are opaque identifiers, and showing one
        // as a "name" put a bare number in front of the user where a name
        // belonged. Presentation layers render their own placeholder for ''.
        // Preferred order (issue #124): a real display name, then the
        // enterprise-side name, then the login alias. For an enterprise member
        // the ALIAS is not a person's name, and showing it made the card look
        // like it was managing somebody else's account.
        accountName: preferredAccountName(credential),
        domain: credential.domain,
        ...credential.enterpriseId === undefined || credential.enterpriseId === ''
          ? {}
          : { enterprise: true },
        source: credential.source,
        tokenExpiresAtMs: credential.expiresAtMs,
        filePath: credential.filePath,
        // A live rotation is what `current()` returns, so it is what the card
        // must mark; without it the row and the billed account drifted apart on
        // every pool rotation.
        selected: rotatedId !== undefined
          ? id === rotatedId
          : selectedExists
            ? id === this.accountId
            // The default is the account in effect only while the user has not
            // chosen one; a vanished explicit choice leaves nobody in effect.
            : !hasExplicitSelection && credential === defaultSelected,
      }
    })
  }

  /**
   * Whether a persisted selection exists that matches no local account, while
   * other local sign-ins ARE available to choose from.
   *
   * The card uses this to explain the state honestly (the account is signed in,
   * but the SAVED choice is gone) instead of showing the generic "sign in
   * again" hint, which misdirects: the token is usually perfectly healthy and
   * signing in again does not repair an orphaned id. When no local sign-in is
   * available at all, that hint IS accurate and this returns false.
   */
  async selectionLost(): Promise<boolean> {
    if (this.accountId === undefined) return false
    const credentials = await this.readAll()
    if (credentials.length === 0) return false
    return !credentials.some(credential => workbuddyAccountId(credential) === this.accountId)
  }

  /** The freshest stored credential for the current selection, no refresh. */
  async current(): Promise<WorkBuddyCredential | undefined> {
    const credentials = await this.readAll()
    // The pool's rotation wins WHILE IT IS SET, and only while it names an
    // account that still exists locally. It is consulted FIRST because it
    // exists precisely to override the default choice at runtime — but it is
    // never allowed to silently fall back either: a rotated id whose account
    // disappeared falls through to the normal selection, since a vanished
    // account cannot be billed whatever the reason.
    if (this.rotatedAccountId !== undefined) {
      const rotated = credentials.find(
        credential => workbuddyAccountId(credential) === this.rotatedAccountId,
      )
      if (rotated !== undefined) return rotated
    }
    if (this.accountId === undefined) return this.preferred(credentials)
    // A saved account can disappear when WorkBuddy replaces its login or
    // cleans up backups. Do NOT silently fall back to a different account: that
    // would bill a different account than the one the user selected. Return
    // undefined so the caller surfaces "no signed-in account" and the user can
    // re-select instead of the plugin quietly switching accounts.
    return credentials.find(credential => workbuddyAccountId(credential) === this.accountId)
  }

  /**
   * Set (or clear) the pool's RUNTIME account override.
   *
   * Never persists and never touches {@link accountId}: the user's saved choice
   * is what `clear` restores, which is the whole reason this lives in its own
   * field. Rotation is off when this is called with `undefined`.
   */
  setRotatedAccount(accountId: string | undefined): void {
    this.rotatedAccountId = accountId
  }

  /** The account the pool is currently rotating to, if any. */
  rotatedAccount(): string | undefined {
    return this.rotatedAccountId
  }

  /**
   * One account's stored credential by id, WITHOUT consulting or changing the
   * current selection.
   *
   * Exists so a recovery probe can test whether some OTHER local account is
   * still accepted upstream while a rejected one stays selected: mutating the
   * live selection to find that out would be exactly the silent account switch
   * this store refuses to perform (it would bill the wrong account mid-probe).
   */
  async credentialFor(accountId: string): Promise<WorkBuddyCredential | undefined> {
    const credentials = await this.readAll()
    return credentials.find(credential => workbuddyAccountId(credential) === accountId)
  }

  /** The credential to send upstream: {@link current}, refreshed on demand. */
  async resolve(): Promise<WorkBuddyCredential> {
    const credential = await this.current()
    if (credential === undefined) {
      throw await this.describeMissingCredential()
    }
    if (!this.needsRefresh(credential)) return credential
    this.inflight ??= this.refreshNow(credential)
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /**
   * WHY no credential resolved, as the error to throw.
   *
   * `resolve()` seeing zero accounts has two very different causes, and the
   * generic "sign in once" message is only correct for one of them. When a
   * probe finds a credential file whose fields are encrypted and the key could
   * not be obtained, the user is signed in and re-authenticating cannot help —
   * so that case gets {@link WorkBuddyEncryptedCredentialError} instead, naming
   * the file and the environment variable that actually fixes it.
   *
   * The probe is only run on the failure path, so the healthy case pays nothing.
   * A probe that itself throws must not replace the real error, hence the
   * fallback to the generic message.
   */
  private async describeMissingCredential(): Promise<Error> {
    let failures: readonly WorkBuddyCandidateFailure[] = []
    try {
      failures = (await this.diagnose()).failures
    } catch {
      // Diagnostics are best-effort: never let them mask the sign-out error.
    }
    // `encrypted` is a DESKTOP-only reason by construction: `probeAuthFile` is
    // what assigns it, and the plugin-owned copies never go through it (they
    // are parsed as the plugin's own document shape, and a damaged one reports
    // `invalid` / `unreadable`). So no source filter is needed here — and the
    // one this replaced was unreachable, which made it read like a guard while
    // guarding nothing.
    const encrypted = failures
      .filter(failure => failure.reason === 'encrypted')
      .map(failure => failure.path)
    if (encrypted.length > 0) return new WorkBuddyEncryptedCredentialError(encrypted)

    const candidates = this.resolveDesktopCandidates()
    const desktop = candidates.length > 0 ? candidates.join(' or ') : '(no desktop path on this platform)'
    return new Error(
      `workbuddy: no signed-in WorkBuddy account found; sign in once in the WorkBuddy desktop app`
      + ` (expected ${desktop} or ${WORKBUDDY_AUTH_FILE_ENV}), or refresh an existing session`,
    )
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async status(): Promise<WorkBuddyAuthStatus> {
    try {
      const credential = await this.current()
      if (credential === undefined) return { state: 'signed-out' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        ...credential.domain === '' ? {} : { domain: credential.domain },
        source: credential.source,
      }
    } catch {
      return { state: 'signed-out' }
    }
  }

  /**
   * Persist one OAuth sign-in into the unified vault.
   *
   * The credential is written with `source: 'dsh'` (it never came from a
   * desktop file) and joins the readable set on the next scan — the vault is
   * read by `readAll()` like any other source, so no separate discovery path
   * exists. The write is idempotent per account id: re-adding an account
   * replaces its entry, which is exactly what re-issuing a login means.
   *
   * Returns the account id so the card can offer to select it right away.
   */
  async addOAuthAccount(credential: Omit<WorkBuddyCredential, 'source' | 'filePath'>): Promise<string> {
    const id = workbuddyAccountId(credential)
    const dir = this.vaultDir()
    await mkdir(dir, { recursive: true })
    await writeVaultEntry(dir, id, {
      ...credential,
      source: 'dsh',
      filePath: join(dir, `${id}.json`),
    })
    // Adding an account clears any dismissal of it. Otherwise a user who removed
    // an account and later signed into it again would watch it stay invisible:
    // the dismissal would filter out the credential they just created, with no
    // action left that could bring it back.
    await this.forgetDismissal(dir, id)
    this.inflight = undefined
    this.invalidateScan()
    return id
  }

  /**
   * Drop one id from the dismissal list, if present.
   *
   * Silent by design: called on the ADD paths, where a list that cannot be
   * updated must not fail the action the user asked for. The consequence is the
   * same as before the fix — the account stays hidden until the list is
   * repaired — while throwing here would report a failed sign-in that succeeded.
   */
  private async forgetDismissal(dir: string, accountId: string): Promise<void> {
    try {
      const dismissed = await readDismissed(dir)
      if (!dismissed.has(accountId)) return
      dismissed.delete(accountId)
      await writeDismissed(dir, dismissed)
    } catch {
      // See above: best-effort, never fatal.
    }
  }
  /**
   * Forget EVERY dismissal, so the next read lists the accounts again.
   *
   * Called by the manual 「re-scan」 action. Dismissal is "hide until I ask to
   * scan again", and this is that ask: the user is requesting what the machine
   * currently has, which includes accounts they hid earlier. Leaving the list
   * intact would make a removed desktop account unrecoverable from the UI — the
   * opposite of what the button promises.
   *
   * PREFERS deleting the file over writing an empty list: an absent file is the
   * normal state and keeps the vault directory free of a file that says nothing.
   * The unlink is not the only way, though, because on Windows removing a file
   * another process holds open fails with `EPERM`/`EBUSY`/`EACCES` — an antivirus
   * scanner, OneDrive, or an editor with it open, the same contention the card's
   * `isFileContentionWriteError` classifies for profile writes and the reason
   * `docs/WINDOWS.md` keeps a register. POSIX unlinks open files happily, so
   * without this the promise 「点重新检测账号即可找回」 would be false, silently,
   * on exactly the platform it matters most on.
   *
   * So the unlink falls back to OVERWRITING the list with an empty one through
   * the same locked atomic write `writeDismissed` uses. For every reader the two
   * outcomes are identical (`readDismissed` yields no ids either way), so the
   * user's ask is honoured even when the file itself cannot be removed.
   *
   * Returns whether the dismissals are now genuinely gone, VERIFIED by reading
   * the list back rather than by trusting the write: the caller renders this, so
   * "it worked" has to mean it. A `false` is the honest answer for a vault that
   * could neither be unlinked nor rewritten, and the rescan still runs — the
   * accounts simply stay hidden, which the UI can now say out loud instead of
   * showing a button that appears to have done nothing.
   */
  async clearDismissals(): Promise<boolean> {
    this.inflight = undefined
    this.invalidateScan()
    const dir = this.vaultDir()
    const path = join(dir, VAULT_DISMISSED_FILENAME)
    try {
      await rm(path, { force: true })
    } catch {
      // Windows-shaped contention. Fall through to the overwrite.
      try {
        await writeDismissed(dir, new Set())
      } catch {
        // Neither path worked; report it rather than pretending.
        return (await readDismissed(dir)).size === 0
      }
    }
    return (await readDismissed(dir)).size === 0
  }

  /**
   * Remove ONE account from this region's list, by id.
   *
   * The account is DISMISSED, not merely deleted. Deleting the vault entry alone
   * was undone by the next scan: `syncVault` writes every desktop sign-in it
   * finds back into the vault (that is how a desktop account becomes selectable)
   * and `readAll` merges the vault in afterwards, so a removed desktop account
   * returned on the very next read while `removeAccount` had reported `true`.
   * Measured before the fix: remove → `true`, then `accounts()` still lists it.
   *
   * The desktop app's auth files stay read-only: dismissing hides the account
   * from this plugin without signing the app out, and that is exactly what the
   * card says. Re-adding it (a fresh OAuth sign-in or an import) clears the
   * dismissal, so the account is not lost to a future login.
   *
   * Returns whether a stored vault entry was also removed, so the caller can
   * still tell "removed" from "only a desktop sign-in" — the dismissal happens
   * either way, because only the user gets to decide an account is dismissed.
   */
  async removeAccount(accountId: string): Promise<boolean> {
    // The id arrives straight from a query parameter and is about to become a
    // path segment; `join` normalizes `..`, so an unchecked value can address
    // a file OUTSIDE the vault. Only the shape this store actually writes is
    // accepted — `workbuddyAccountId` is sha256 hex sliced to 24.
    if (!VAULT_ACCOUNT_ID_RE.test(accountId)) {
      throw new Error(`workbuddy: refusing to remove '${accountId}': not a vault account id`)
    }
    const path = join(this.vaultDir(), `${accountId}.json`)
    // The delete runs UNDER the lock every write takes. Removing a lock file
    // that a concurrent `writeVaultEntry` is holding would let two writers
    // into the critical section at once, so the lock is taken, not deleted.
    const removed = await withFileLock(path, async () => {
      let existed = true
      try {
        await rm(path, { force: false })
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
        existed = false
      }
      // `force: true` would be wrong here: while THIS holds the lock, a
      // concurrent writer's own lock file is the same path, and removing it
      // is what the bug was. A leftover from a crashed writer may go, and a
      // failure to remove one must not fail the delete.
      await rm(`${path}.lock`, { force: false }).catch(() => {})
      return existed
    })
    // A rotated override pointing at the removed account would fall through to
    // the normal selection anyway (a vanished account cannot be billed), but
    // clearing it here keeps the runtime state immediately truthful.
    if (this.rotatedAccountId === accountId) this.rotatedAccountId = undefined
    if (this.accountId === accountId) {
      // The user's saved choice is gone with its credential: drop the dead
      // selection rather than reporting it as lost until the next restart.
      this.accountId = undefined
    }
    // Recorded even when no vault entry was found: a desktop-only sign-in has
    // no vault file to delete, yet it is exactly the case the user reported
    // (the account reappeared on the next scan). The dismissal is what makes
    // the row stay gone — see {@link VAULT_DISMISSED_FILENAME}.
    const dir = this.vaultDir()
    try {
      await mkdir(dir, { recursive: true })
      const dismissed = await readDismissed(dir)
      if (!dismissed.has(accountId)) {
        dismissed.add(accountId)
        await writeDismissed(dir, dismissed)
      }
    } catch {
      // A vault that cannot be written leaves the account listed after the next
      // scan. That is the pre-fix behaviour rather than a new failure mode, and
      // the caller still learns what happened from `removed`; failing the whole
      // delete here would be worse, since the vault entry is already gone.
    }
    this.inflight = undefined
    this.invalidateScan()
    return removed
  }

  /**
   * Remove every plugin-owned copy this store could read (per-region file,
   * legacy single file, and their lock siblings); the desktop files are
   * untouched. A region store's logout therefore also clears the legacy
   * migration source — deliberate: `logout` is the user's "forget what the
   * plugin stored" action, not a per-account toggle.
   */
  async logout(): Promise<void> {
    for (const path of this.ownCandidates()) {
      await rm(path, { force: true })
      await rm(`${path}.lock`, { force: true })
    }
    // The vault's directory for this store's region goes too: logout is the
    // user's "forget what the plugin stored" action, and the vault is plugin
    // storage. The sibling region's directory is untouched.
    await rm(this.vaultDir(), { recursive: true, force: true })
    // The account list this store hands out is now empty.
    this.invalidateScan()
  }

  private needsRefresh(credential: WorkBuddyCredential): boolean {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  private async refreshNow(credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('workbuddy: access token expired and no refresh token is stored; sign in again in the WorkBuddy desktop app')
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed: WorkBuddyCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresInSec !== undefined
          ? Date.now() + outcome.expiresInSec * 1000
          : credential.expiresAtMs,
        ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
        source: 'dsh',
      }
      // The refreshed token lands in the unified vault (one file per
      // account). The legacy per-region copy files stay READ-ONLY now: they
      // remain migration sources for pre-vault installs.
      // `refreshedFrom` records WHICH desktop file this refresh replaced: a
      // token the plugin issued for that very file is newer than whatever the
      // app last wrote, and the serve rule uses this to keep it (see
      // {@link VaultDocument.refreshedFrom}). OAuth/import writes omit it —
      // nothing was refreshed there, so their precedence is unchanged.
      // The refreshed token is now IN the vault, so the shared scan is stale.
      this.invalidateScan()
      await writeVaultEntry(
        this.vaultDir(),
        workbuddyAccountId(credential),
        refreshed,
        credential.filePath,
      ).catch(() => {
        // A vault write failure must not fail the request that just got its
        // fresh token: the in-memory credential still serves this call, and
        // the next successful scan or refresh retries the write.
      })
      return refreshed
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        `workbuddy: token refresh failed and the access token is expired (${String(error)});`
        + ' open the WorkBuddy desktop app once to sign in again',
      )
    }
  }

  /**
   * Every readable plugin-owned copy, in candidate order; absent or corrupt
   * files are skipped rather than propagated.
   */
  private async readOwns(): Promise<WorkBuddyCredential[]> {
    const copies: WorkBuddyCredential[] = []
    for (const path of this.ownCandidates()) {
      try {
        const parsed = parseOwnDocument(await readFile(path, 'utf8'), path)
        if (parsed !== undefined) copies.push(parsed)
      } catch {
        // absent or unreadable — the next candidate is tried
      }
    }
    return copies
  }

  /** Whether any candidate file exists as a regular file; diagnostics only. */
  async desktopFilePresent(): Promise<boolean> {
    for (const path of this.resolveDesktopCandidates()) {
      try {
        if ((await stat(path)).isFile()) return true
      } catch {
        // absent or not a regular file — try the next candidate
      }
    }
    return false
  }

  /**
   * Which paths were probed and why each one yielded no credential.
   *
   * Read-only and token-free: it exists so a signed-out card can explain
   * itself. A bare "not signed in" is undiagnosable on a machine whose layout
   * differs from the ones this plugin was written against — and on Windows it
   * is actively misleading, because encrypted token fields need the desktop app
   * present to be read at all. Only paths this store actually consults are
   * reported, and only files that failed: one healthy sibling would make the
   * whole list noise.
   */
  async diagnose(): Promise<{
    tried: string[]
    failures: WorkBuddyCandidateFailure[]
  }> {
    const candidates: WorkBuddyCandidateFailure[] = []
    // `tried` is the DESKTOP paths this store actually consults — the resolved
    // live candidates plus the timestamped backups found beside them. Report it
    // from the same `candidateFiles()` the loop below walks (issue #174): the
    // list used to be derived separately, so it could name paths the loop never
    // opened, and add the SECOND known live basename this build now probes.
    // Timestamped backups are excluded on purpose: `doctor` calls them by their
    // directory, and enumerating them here would make the card's two-path line
    // grow a line per app upgrade.
    const desktopTried = this.resolveDesktopCandidates()
    // Read every candidate ONCE, then decide what to report (issue #174): the
    // rules below are about the SET (was anything readable in this directory?),
    // which a single streaming pass cannot answer.
    const probed: { path: string, probe: Awaited<ReturnType<typeof probeAuthFile>> }[] = []
    for (const path of await this.candidateFiles()) {
      probed.push({ path, probe: await probeAuthFile(path, this.resolveAtRestKey) })
    }
    /**
     * Directories that need no `missing` complaint (issue #174).
     *
     * A directory is "accounted for" when it either yielded a readable
     * credential OR produced some other, more specific complaint. The first case
     * is the healthy machine whose app writes only one of the two known
     * spellings; the second is a machine holding a broken file — and telling
     * that user "no auth file at the expected path" would be both false and
     * less useful than the `invalid` line they already have.
     */
    const accountedDirs = new Set<string>()
    for (const entry of probed) {
      if ('credential' in entry.probe) {
        accountedDirs.add(dirname(entry.path))
        continue
      }
      if (entry.probe.failure.reason !== 'missing') accountedDirs.add(dirname(entry.path))
    }
    /** Directories whose `missing` complaint has already been made. */
    const missingReported = new Set<string>()
    for (const { path, probe } of probed) {
      if ('credential' in probe) {
        // Reads fine, but belongs to the other region's tab: this store's
        // `readAll()` filters it out, so the account list will not show it.
        // Dropping it here too is what made a working sign-in invisible to the
        // diagnostics — reported as neither account nor failure, it vanished,
        // and a two-path card could truthfully claim to have checked one. Say
        // whose sign-in this is instead: the fix is the other tab, not a
        // re-login.
        if (!this.matchesRegion(probe.credential.domain)) {
          candidates.push({
            path,
            source: 'desktop',
            reason: 'wrong-region',
            message: `holds a ${regionOf(probe.credential.domain)} sign-in, but this tab reads the ${this.region} region`,
          })
        }
        continue
      }
      // `missing` is reported ONCE PER DIRECTORY, and only when NOTHING in that
      // directory could be read (issue #174). Two rules, one reason each:
      //
      //   - a directory holding a readable credential must not also be
      //     complained about: a machine whose app writes only
      //     `workbuddy-desktop-ai.info` misses the `workbuddy-desktop.info`
      //     probe by design, and reporting it would put "missing" on the card
      //     for a machine whose account list is already populated.
      //   - two `missing` lines for two known spellings in the same directory say
      //     the same thing twice, and the user cannot act on the difference.
      if (probe.failure.reason === 'missing') {
        const dir = dirname(path)
        if (accountedDirs.has(dir) || missingReported.has(dir)) continue
        missingReported.add(dir)
      }
      candidates.push({ path, source: 'desktop', ...probe.failure })
    }
    // Plugin-owned copies are reported separately: they are the plugin's own
    // storage, and their absence is normal rather than a problem to explain.
    for (const path of this.ownCandidates()) {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error: unknown) {
        if (isENOENT(error)) continue
        candidates.push({
          path,
          source: 'dsh',
          reason: 'unreadable',
          message: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      const parsed = parseOwnDocument(text, path)
      if (parsed === undefined || !this.matchesRegion(parsed.domain)) {
        candidates.push({ path, source: 'dsh', reason: 'invalid', message: 'not a readable plugin-owned credential' })
        continue
      }
      // Readable and region-matching, yet no account was found: that is a
      // region mismatch or an unreadable sibling, not a credential problem.
      continue
    }
    // Vault entries count as tried paths too: an OAuth-added account lives
    // only here, so a signed-out card must be able to say whether the file
    // was present but unparsable rather than silently absent.
    const tried = [...await this.candidateFiles(), ...this.ownCandidates()]
    try {
      const names = await readdir(this.vaultDir())
      // Credential files only — this loop REPORTS what it cannot parse, so
      // every non-credential file it admits becomes a failure line at the user.
      // `.dismissed.json` is well-formed JSON but not a credential, and it made
      // a healthy machine look broken the moment an account was removed. See
      // {@link isVaultCredentialFileName}.
      for (const name of names.filter(isVaultCredentialFileName)) {
        const path = join(this.vaultDir(), name)
        tried.push(path)
        let text: string
        try {
          text = await readFile(path, 'utf8')
        } catch (error: unknown) {
          if (!isENOENT(error)) {
            candidates.push({
              path,
              source: 'dsh',
              reason: 'unreadable',
              message: error instanceof Error ? error.message : String(error),
            })
          }
          continue
        }
        const parsed = parseVaultDocument(text, path)
        if (parsed === undefined) {
          candidates.push({ path, source: 'dsh', reason: 'invalid', message: 'not a readable vault credential' })
        }
      }
    } catch {
      // Absent/unreadable vault directory: absence is normal (nothing added
      // yet), and a read error is already reported through the own copies'
      // diagnostics pass above.
    }
    return { tried: [...desktopTried, ...this.ownCandidates()], failures: candidates }
  }
}
