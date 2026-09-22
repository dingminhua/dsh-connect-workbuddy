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
 *
 * @module dsh-connect-workbuddy/auth
 */

import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
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
 */
export interface WorkBuddyCandidateFailure {
  path: string
  source: 'desktop' | 'dsh'
  reason: 'missing' | 'unreadable' | 'invalid' | 'encrypted'
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
}

/** Legacy single-copy basename (pre-dual-provider); kept as migration source. */
export const WORKBUDDY_AUTH_FILENAME = '.workbuddy-auth.json'

/** Env variable that overrides the desktop auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

/** Basename of the live WorkBuddy desktop auth file. */
const WORKBUDDY_LIVE_FILENAME = 'workbuddy-desktop.info'

/** Prefix of the plugin-owned per-region credential copies. */
const WORKBUDDY_OWN_PREFIX = '.workbuddy-auth'

/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1

interface OwnDocument {
  version: typeof OWN_FORMAT_VERSION
  accountId?: string
  credential: WorkBuddyCredential
}

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

/** The live auth file's platform candidates, in probe order. */
export function defaultDesktopAuthCandidates(): string[] {
  return defaultDesktopAuthDirs().map(dir => join(dir, WORKBUDDY_LIVE_FILENAME))
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
  return authFileName(path) === WORKBUDDY_LIVE_FILENAME ? 0 : 1
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
 * Stable account id. `uin` is the billing identity the upstream keys on and
 * survives across re-login; `uid` is the fallback for documents without one.
 */
export function workbuddyAccountId(
  credential: Pick<WorkBuddyCredential, 'uin' | 'uid' | 'nickname'>,
): string {
  const stable = credential.uin ?? credential.uid ?? credential.nickname ?? 'unknown'
  return createHash('sha256').update(`workbuddy\0${stable}`).digest('hex').slice(0, 24)
}

/** Serialize the plugin-owned copy. */
function ownDocument(credential: WorkBuddyCredential, accountId: string | undefined): OwnDocument {
  return {
    version: OWN_FORMAT_VERSION,
    ...accountId === undefined ? {} : { accountId },
    credential,
  }
}

/** Parse the plugin-owned copy; other versions and shapes are rejected. */
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
  return { ...credential, source: 'dsh' }
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
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
    return {
      failure: {
        reason: isENOENT(error) ? 'missing' : 'unreadable',
        message: error instanceof Error ? error.message : String(error),
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
  private readonly authDirs: readonly string[] | undefined
  private readonly resolveAtRestKey: () => Promise<Buffer | undefined>
  private desktopPathOverride: string | undefined
  private accountId: string | undefined
  private inflight: Promise<WorkBuddyCredential> | undefined

  constructor(options: WorkBuddyStoreOptions) {
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.region = options.region
    this.ownPathExplicit = options.ownPath
    this.legacyOwnPath = options.legacyOwnPath ?? legacyWorkbuddyOwnAuthPath()
    this.legacyOwnPathExplicit = options.legacyOwnPath
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

  /** Repoint the desktop file or directory; applies on the next read. */
  setDesktopPath(path: string | undefined): void {
    this.desktopPathOverride = path
    this.inflight = undefined
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
    return defaultDesktopAuthCandidates()
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
    for (const dir of dirs) {
      const live = join(dir, WORKBUDDY_LIVE_FILENAME)
      files.push(live)
      for (const backup of await this.backupsBeside(live)) files.push(backup)
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
  private async readAll(): Promise<WorkBuddyCredential[]> {
    const files = await this.candidateFiles()
    const byId = new Map<string, WorkBuddyCredential>()
    for (const file of files) {
      const credential = await readAuthFile(file, this.resolveAtRestKey)
      if (credential === undefined || !this.matchesRegion(credential.domain)) continue
      const id = workbuddyAccountId(credential)
      const existing = byId.get(id)
      if (existing === undefined) {
        byId.set(id, credential)
        continue
      }
      // The live file outranks backups; between two backups the freshest
      // issuance time wins (see {@link isFresher}).
      if (isFresher(credential, existing)) byId.set(id, credential)
    }
    for (const own of await this.readOwns()) {
      if (!this.matchesRegion(own.domain)) continue
      const id = workbuddyAccountId(own)
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
    return [...byId.values()]
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
   * So an explicit selection that matches NO local account marks nothing as
   * selected (no silent fallback to a different account — see {@link current}).
   * The implicit default is marked only when nothing was explicitly chosen.
   */
  async accounts(): Promise<WorkBuddyAccountChoice[]> {
    const credentials = await this.readAll()
    if (credentials.length === 0) return []
    const hasExplicitSelection = this.accountId !== undefined
    const selectedExists = hasExplicitSelection
      && credentials.some(credential => workbuddyAccountId(credential) === this.accountId)
    const defaultSelected = this.preferred(credentials)
    return credentials.map(credential => {
      const id = workbuddyAccountId(credential)
      return {
        id,
        // The human name, or '' when the app did not give one. Deliberately NO
        // fallback to `uin`/`uid`: those are opaque identifiers, and showing one
        // as a "name" put a bare number in front of the user where a name
        // belonged. Presentation layers render their own placeholder for ''.
        accountName: credential.nickname ?? '',
        domain: credential.domain,
        source: credential.source,
        tokenExpiresAtMs: credential.expiresAtMs,
        filePath: credential.filePath,
        selected: selectedExists
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
    if (this.accountId === undefined) return this.preferred(credentials)
    // A saved account can disappear when WorkBuddy replaces its login or
    // cleans up backups. Do NOT silently fall back to a different account: that
    // would bill a different account than the one the user selected. Return
    // undefined so the caller surfaces "no signed-in account" and the user can
    // re-select instead of the plugin quietly switching accounts.
    return credentials.find(credential => workbuddyAccountId(credential) === this.accountId)
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
      const candidates = this.resolveDesktopCandidates()
      const desktop = candidates.length > 0 ? candidates.join(' or ') : '(no desktop path on this platform)'
      throw new Error(
        `workbuddy: no signed-in WorkBuddy account found; sign in once in the WorkBuddy desktop app`
        + ` (expected ${desktop} or ${WORKBUDDY_AUTH_FILE_ENV}), or refresh an existing session`,
      )
    }
    if (!this.needsRefresh(credential)) return credential
    this.inflight ??= this.refreshNow(credential)
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
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
      await this.saveOwn(refreshed)
      return refreshed
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        `workbuddy: token refresh failed and the access token is expired (${String(error)});`
        + ' open the WorkBuddy desktop app once to sign in again',
      )
    }
  }

  private async saveOwn(credential: WorkBuddyCredential): Promise<void> {
    const accountId = workbuddyAccountId(credential)
    const path = this.ownAuthPath()
    await withFileLock(path, async () => {
      await writeFileAtomic(path, `${JSON.stringify(ownDocument(credential, accountId), null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
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
    for (const path of await this.candidateFiles()) {
      const probe = await probeAuthFile(path, this.resolveAtRestKey)
      if ('credential' in probe) continue
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
    return { tried: [...await this.candidateFiles(), ...this.ownCandidates()], failures: candidates }
  }
}
