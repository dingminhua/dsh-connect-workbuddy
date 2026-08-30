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
 *
 * @module dsh-connect-workbuddy/auth
 */

import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyRefreshOutcome } from './upstream.ts'

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
  /** Explicit plugin-owned copy path, defaulting under `$DSH_HOME`. */
  ownPath?: string
  /**
   * Auth directories to scan, overriding the platform defaults. Injectable so
   * the multi-account scan is testable without touching a real machine.
   */
  authDirs?: readonly string[]
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
}

/** One selectable local account, token-free. */
export interface WorkBuddyAccountChoice {
  /** Stable id derived from `uin` (or `uid` when uin is absent). */
  id: string
  accountName: string
  uin?: string
  domain: string
  source: 'desktop' | 'dsh'
  tokenExpiresAtMs: number
  /** The auth file this account was read from; newest is preferred. */
  filePath: string
  selected: boolean
}

/** Basename of the plugin-owned credential copy inside the Harness home. */
export const WORKBUDDY_AUTH_FILENAME = '.workbuddy-auth.json'

/** Env variable that overrides the desktop auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

/** Basename of the live WorkBuddy desktop auth file. */
const WORKBUDDY_LIVE_FILENAME = 'workbuddy-desktop.info'

/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1

interface OwnDocument {
  version: typeof OWN_FORMAT_VERSION
  accountId?: string
  credential: WorkBuddyCredential
}

/** Plugin-owned copy path inside the Harness home. */
export function workbuddyOwnAuthPath(): string {
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

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
export function parseWorkBuddyAuth(
  text: string,
  filePath: string,
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
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') return undefined
  const expiresAtMs = typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0
  const refreshExpiresAtMs = typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  const enterpriseId = optionalString(identity['enterpriseId'])
  const nickname = optionalString(identity['nickname'])
  const uin = optionalString(identity['uin'])
  const credential: WorkBuddyCredential = {
    accessToken,
    refreshToken: typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] : '',
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(auth['domain']) ?? '',
    uid: optionalString(identity['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    ...uin === undefined ? {} : { uin },
    source: 'desktop',
    filePath,
  }
  return credential
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
function parseOwnDocument(text: string): WorkBuddyCredential | undefined {
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
  const credential = parseWorkBuddyAuth(JSON.stringify({ auth: document['credential'] }), workbuddyOwnAuthPath())
  if (credential === undefined) return undefined
  return { ...credential, source: 'dsh' }
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Read one auth file, tolerating absence and unparsable content. */
async function readAuthFile(path: string): Promise<WorkBuddyCredential | undefined> {
  try {
    return parseWorkBuddyAuth(await readFile(path, 'utf8'), path)
  } catch (error: unknown) {
    if (isENOENT(error)) return undefined
    return undefined
  }
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
  private readonly ownPath: string
  private readonly authDirs: readonly string[] | undefined
  private desktopPathOverride: string | undefined
  private accountId: string | undefined
  private inflight: Promise<WorkBuddyCredential> | undefined

  constructor(options: WorkBuddyStoreOptions) {
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.ownPath = options.ownPath ?? workbuddyOwnAuthPath()
    this.authDirs = options.authDirs
    this.desktopPathOverride = options.desktopPath
  }

  /** Repoint the desktop file or directory; applies on the next read. */
  setDesktopPath(path: string | undefined): void {
    this.desktopPathOverride = path
    this.inflight = undefined
  }

  /** Select an account by id; tokens stay outside settings. */
  selectAccount(accountId: string | undefined): void {
    this.accountId = accountId
    this.inflight = undefined
  }

  /** Selected account id, for diagnostics and route assembly. */
  selectedAccountId(): string | undefined {
    return this.accountId
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

  /** The plugin-owned copy path, for diagnostics. */
  ownAuthPath(): string {
    return this.ownPath
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
   */
  private async readAll(): Promise<WorkBuddyCredential[]> {
    const files = await this.candidateFiles()
    const byId = new Map<string, WorkBuddyCredential>()
    for (const file of files) {
      const credential = await readAuthFile(file)
      if (credential === undefined) continue
      const id = workbuddyAccountId(credential)
      const existing = byId.get(id)
      if (existing === undefined) {
        byId.set(id, credential)
        continue
      }
      // The live file outranks backups; between two backups the fresher
      // expiry wins.
      const better = fileRank(credential.filePath) < fileRank(existing.filePath)
        || (fileRank(credential.filePath) === fileRank(existing.filePath)
          && credential.expiresAtMs > existing.expiresAtMs)
      if (better) byId.set(id, credential)
    }
    const own = await this.readOwn()
    if (own !== undefined) {
      const id = workbuddyAccountId(own)
      const existing = byId.get(id)
      // The refreshed copy wins only when it lives longer.
      if (existing === undefined || own.expiresAtMs > existing.expiresAtMs) byId.set(id, own)
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
    return credentials.reduce((best, credential) => {
      if (fileRank(credential.filePath) < fileRank(best.filePath)) return credential
      if (fileRank(credential.filePath) === fileRank(best.filePath)
        && credential.expiresAtMs > best.expiresAtMs) return credential
      return best
    })
  }

  /** Token-free account list for the plugin card. */
  async accounts(): Promise<WorkBuddyAccountChoice[]> {
    const credentials = await this.readAll()
    if (credentials.length === 0) return []
    const selectedExists = this.accountId !== undefined
      && credentials.some(credential => workbuddyAccountId(credential) === this.accountId)
    const defaultSelected = this.preferred(credentials)
    return credentials.map(credential => {
      const id = workbuddyAccountId(credential)
      return {
        id,
        accountName: credential.nickname ?? credential.uin ?? credential.uid,
        ...credential.uin === undefined ? {} : { uin: credential.uin },
        domain: credential.domain,
        source: credential.source,
        tokenExpiresAtMs: credential.expiresAtMs,
        filePath: credential.filePath,
        selected: selectedExists ? id === this.accountId : credential === defaultSelected,
      }
    })
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

  /** Remove the plugin-owned copy; the desktop files are untouched. */
  async logout(): Promise<void> {
    await rm(this.ownPath, { force: true })
    await rm(`${this.ownPath}.lock`, { force: true })
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
    await withFileLock(this.ownPath, async () => {
      await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential, accountId), null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }

  private async readOwn(): Promise<WorkBuddyCredential | undefined> {
    try {
      return parseOwnDocument(await readFile(this.ownPath, 'utf8'))
    } catch {
      return undefined
    }
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
}
