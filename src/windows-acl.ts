/**
 * Windows ACL hardening for the plugin's credential vault (issue #183).
 *
 * THE REPORT. `<dsh home>/workbuddy-vault/<region>/<accountId>.json` holds the
 * decrypted WorkBuddy `accessToken` / `refreshToken` as plaintext JSON, and the
 * writer asked for `mode: 0o600`. On POSIX that is the whole story. On Windows
 * `mode` is accepted and effectively ignored: a file's permissions come from the
 * DACL it inherits from its parent directory, and nothing in `fs.writeFile` or
 * `fs.rename` consults the mode argument there. The reporter measured the
 * result with `Get-Acl`: the vault files came out readable by
 * `<machine>\CodexSandboxUsers` — the account DSH's own sandbox runs as — so any
 * sandboxed process, sibling plugin or script on that machine could read a
 * usable JWT straight off disk.
 *
 * WHY HARDEN THE DIRECTORY, NOT JUST THE FILE. Two reasons, both measured:
 *
 *   1. The writer commits with an atomic replace (`writeFileAtomic`): a fresh
 *      `<name>.<hex>.tmp` inode is created and renamed over the target. A
 *      per-file ACL applied AFTER the rename leaves a window in which the new
 *      inode carries whatever it inherited, and a crash mid-sequence leaves a
 *      file that was never hardened. Children of a hardened directory inherit
 *      the hardened ACEs at creation, so the replacement is born correct.
 *   2. Windows RE-PROPAGATES inheritable ACEs down an existing tree, so
 *      hardening the directory also repairs the files already sitting in it.
 *      Verified on a real Windows 11 host: a file carrying
 *      `Everyone: FullControl` inherited from `~/.dsh` came out with exactly the
 *      three intended ACEs after only the directory was hardened.
 *
 * WHY NOT `icacls /T`. Measured on the same host: `/T` combined with an
 * `(OI)(CI)` grant spec blanks the DACL of the FILES it walks — they end up with
 * zero ACEs, which reads as "nobody may read this" and would break the plugin's
 * own reads. The two-pass form (directories with `(OI)(CI)`, then files with a
 * plain `(F)` grant) produces the correct result, so `/T` is deliberately not
 * used anywhere here.
 *
 * WHY WINDOWS SIDS AND NOT NAMES. `icacls` prints and accepts localized account
 * names, and this project's hosts are frequently zh-CN (`Everyone` shows up as
 * `Everyone` but `BUILTIN\Administrators` does not). The `*S-1-5-…` form makes
 * every argument locale-independent, so the same argv works on any UI language.
 *
 * WHY `OWNER RIGHTS` (S-1-3-4) RATHER THAN THE CURRENT USER. Resolving the
 * current user's SID costs a child process (`whoami`) on every hardening round,
 * and the answer is already implied: the process that creates a file becomes its
 * owner, so `OWNER RIGHTS` grants exactly the account that will read it back.
 * `SYSTEM` and `Administrators` are kept so backup/AV/service software that
 * legitimately expects to reach user files is not locked out — removing them
 * would make the vault unmanageable on a machine where the user's own session is
 * not the one repairing it.
 *
 * WHAT THIS IS AND IS NOT. This is the issue's suggestion #2 (explicit ACLs
 * after writing), which it calls "the smallest change". It is NOT DPAPI
 * encryption (suggestion #1): the bytes on disk remain plaintext, so an
 * administrator, a SYSTEM service, or an attacker who has already achieved the
 * user's own token can still read them. Closing that gap requires encrypting the
 * document with a key bound to the user profile, which is a format change to the
 * vault and cannot be done without a migration; it is tracked separately. The
 * README says plainly that the file holds plaintext tokens.
 *
 * FAILURE IS NOT FATAL. A credential write is on the sign-in path: refusing to
 * persist a credential because the ACL could not be applied would turn a
 * defence-in-depth measure into an outage. Every function here is therefore
 * best-effort and reports its outcome instead of throwing, and `doctor` surfaces
 * that outcome so a machine where hardening silently failed is visible rather
 * than assumed safe.
 *
 * @module dsh-connect-workbuddy/windows-acl
 */

import { execFile } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Well-known SID for "the owner of this object".
 *
 * Deliberately a SID rather than an account name: it needs no lookup, it works
 * on every UI language, and `icacls` accepts it in the `*S-…` form.
 */
const OWNER_RIGHTS_SID = 'S-1-3-4'

/** Well-known SID for `NT AUTHORITY\SYSTEM`. */
const SYSTEM_SID = 'S-1-5-18'

/** Well-known SID for `BUILTIN\Administrators`. */
const ADMINISTRATORS_SID = 'S-1-5-32-544'

/**
 * Principals allowed to keep access, as SIDs.
 *
 * Used by {@link inspectCredentialDirectory} to tell "hardened" from "somebody
 * widened it again"; keeping the list beside the grant specs is what stops the
 * two from drifting.
 */
const ALLOWED_SIDS: ReadonlySet<string> = new Set([OWNER_RIGHTS_SID, SYSTEM_SID, ADMINISTRATORS_SID])

/**
 * Grant specs for a DIRECTORY: `(OI)` object-inherit and `(CI)` container-inherit
 * make the ACE apply to files and subdirectories created later, which is the
 * whole mechanism this module relies on.
 */
const DIRECTORY_GRANTS: readonly string[] = [
  `*${OWNER_RIGHTS_SID}:(OI)(CI)(F)`,
  `*${SYSTEM_SID}:(OI)(CI)(F)`,
  `*${ADMINISTRATORS_SID}:(OI)(CI)(F)`,
]

/**
 * Grant specs for a FILE.
 *
 * No `(OI)(CI)`: inheritance flags on a file are meaningless, and passing them
 * is what produced the blanked DACLs measured with `/T`.
 */
const FILE_GRANTS: readonly string[] = [
  `*${OWNER_RIGHTS_SID}:(F)`,
  `*${SYSTEM_SID}:(F)`,
  `*${ADMINISTRATORS_SID}:(F)`,
]

/** How long one `icacls` (or PowerShell) child may take before it is abandoned. */
const ACL_COMMAND_TIMEOUT_MS = 10_000

/**
 * Result of one hardening attempt.
 *
 * `not-windows` is a normal POSIX answer, not a failure: the `mode` argument
 * already conveys the same intent there. Keeping the two apart is what lets
 * `doctor` avoid warning every macOS user about a Windows-only measure.
 */
export type CredentialAclOutcome =
  | { state: 'protected' }
  | { state: 'not-windows' }
  | { state: 'failed', reason: string }

/**
 * What {@link inspectCredentialDirectory} found.
 *
 * `unverified` is distinct from `failed`: it means the ACL could not be READ
 * back (PowerShell missing, command timed out), which says nothing about whether
 * the hardening holds.
 */
export interface CredentialAclReport {
  /** The directory inspected. */
  directory: string
  state: 'protected' | 'exposed' | 'not-windows' | 'unverified'
  /** Principals holding access, as SIDs, when the read succeeded. */
  entries?: string[]
  /** The subset of {@link entries} that is neither the owner nor an administrator. */
  weak?: string[]
  /** Why the state is `unverified`, or the first unexpected arg worth recording. */
  reason?: string
}

/** Paths already hardened by THIS process, so repeat writes cost nothing. */
const protectedDirectories = new Set<string>()

/** Hardening attempts in flight, keyed by path: a burst joins one child. */
const inflightProtection = new Map<string, Promise<CredentialAclOutcome>>()

/** Whether this process is running on Windows; a seam for tests. */
function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * Run one child process, resolving to its stdout.
 *
 * `windowsHide` is mandatory for the same reason recorded in `at-rest.ts` and
 * `docs/WINDOWS.md` §1-5: the DSH Desktop host is an Electron GUI process with
 * no console, so spawning a console program without it flashes a visible black
 * window. `icacls` here runs on the credential-write path, which a user can
 * trigger repeatedly from the card — an un-hidden spawn would blink at them on
 * every account switch.
 *
 * Sets `windowsVerbatimArguments: false` implicitly (the default) so each argv
 * element is quoted by Node rather than concatenated: the grant specs contain
 * parentheses, which a raw command-line join would hand to `cmd` for parsing.
 * This is why the arguments go through `execFile` as an ARRAY and never as a
 * single shell string.
 */
function runCommand(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', windowsHide: true, timeout: ACL_COMMAND_TIMEOUT_MS },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(`${file} exited ${String((error as NodeJS.ErrnoException).code ?? error.message)}`))
          return
        }
        resolve(stdout)
      },
    )
  })
}

/**
 * Apply one ownership set to `path` with `icacls`.
 *
 * `/inheritance:r` drops the inherited ACEs (that is what removes the
 * `Everyone: FullControl` arriving from `~/.dsh`) and `/grant:r` replaces the
 * ACE for each named principal rather than adding a duplicate, so the call is
 * idempotent — measured: running it twice on the same file leaves the same three
 * ACEs.
 */
async function applyAcl(path: string, grants: readonly string[]): Promise<void> {
  const args = [path, '/inheritance:r']
  for (const grant of grants) {
    args.push('/grant:r', grant)
  }
  await runCommand('icacls', args)
}

/**
 * Harden one credential directory tree so that the files inside are readable
 * only by their owner, SYSTEM and Administrators.
 *
 * ONE `icacls` CALL, NOT A WALK. Measured on a real Windows 11 host: hardening
 * the parent directory makes Windows RE-PROPAGATE the new inheritable ACEs down
 * the tree, repairing existing subdirectories AND existing files in the same
 * step — a file carrying `Everyone: FullControl` inherited from `~/.dsh` came out
 * with exactly the three intended ACEs (`weak=0`) after only its parent was
 * hardened. Walking the children would spawn one child process per directory to
 * re-derive a guarantee this single call already delivers.
 *
 * WHY THAT COST MATTERS HERE. This runs on the credential-write path, which the
 * card can trigger per account switch. `icacls` measured 19–52 ms at rest and
 * **up to 1242 ms under parallel load** — enough to blow the 1 s polling budget
 * of `tests/issue12-region-hiding.spec.ts` when the whole suite ran
 * concurrently. The shape below is therefore deliberate on two axes:
 *
 *   - CALLS: one, never a walk.
 *   - CONCURRENCY: an attempt already in flight for the same path is JOINED
 *     rather than repeated, so a burst of writes queues one child for one
 *     directory instead of one per write.
 *
 * Staying ON the write path is not negotiable: the atomic commit creates a fresh
 * temp inode and renames it over the target, so a file-level pass AFTERwards
 * would leave the pre-rename window open and would be undone by the next
 * replace. Hardening before the write is what makes the replacement inode
 * inherit the restricted ACEs.
 *
 * Memoized per process on SUCCESS only: a failed attempt must be retried by the
 * next write, or one transient lock on the directory would leave the machine
 * unhardened for the rest of the session.
 */
export async function protectCredentialDirectory(directory: string): Promise<CredentialAclOutcome> {
  if (!isWindows()) return { state: 'not-windows' }
  if (protectedDirectories.has(directory)) return { state: 'protected' }
  const pending = inflightProtection.get(directory)
  if (pending !== undefined) return pending
  const attempt = hardenDirectory(directory)
  inflightProtection.set(directory, attempt)
  try {
    return await attempt
  } finally {
    inflightProtection.delete(directory)
  }
}

/** The work behind {@link protectCredentialDirectory}: one `icacls` call. */
async function hardenDirectory(directory: string): Promise<CredentialAclOutcome> {
  try {
    await mkdir(directory, { recursive: true })
    await applyAcl(directory, DIRECTORY_GRANTS)
    protectedDirectories.add(directory)
    return { state: 'protected' }
  } catch (error: unknown) {
    return { state: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Harden ONE credential file so that only its owner, SYSTEM and Administrators
 * may read it (issue #183).
 *
 * Exported for callers that hold a single file rather than a directory. The
 * WRITE PATH does NOT call it per write: the atomic replace creates a new inode
 * that inherits the directory's hardened ACEs, so a per-write call would spend a
 * child process to buy nothing — see {@link protectCredentialDirectory}.
 *
 * Files are NOT memoized, unlike directories: `writeFileAtomic` produces a new
 * inode on every commit, so "already hardened" is not a property a path keeps
 * across writes.
 *
 * Best-effort: returns the outcome and never throws.
 */
export async function protectCredentialFile(path: string): Promise<CredentialAclOutcome> {
  if (!isWindows()) return { state: 'not-windows' }
  try {
    await applyAcl(path, FILE_GRANTS)
    return { state: 'protected' }
  } catch (error: unknown) {
    return { state: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Read back the ACL of one credential directory as SIDs, for diagnostics.
 *
 * PowerShell rather than `icacls` because the answer has to be COMPARABLE:
 * `icacls` prints localized account names, so testing "is `Everyone` absent"
 * against its output would silently pass on a zh-CN host where the name is
 * spelled differently. `Get-Acl` + `SecurityIdentifier.Value` yields the
 * language-independent form.
 *
 * Read-only and token-free: it never opens the JSON, only the ACL. A failure to
 * read is reported as `unverified` rather than being folded into `exposed` — the
 * two need different user actions, and claiming exposure that was not measured
 * would be its own kind of lie.
 */
export async function inspectCredentialDirectory(directory: string): Promise<CredentialAclReport> {
  if (!isWindows()) return { directory, state: 'not-windows' }
  /**
   * Deliberately a single quoted expression with no interpolation of `directory`
   * beyond the literal path: `-LiteralPath` keeps a path containing `[` or `$`
   * from being treated as a wildcard or a subexpression.
   */
  const script = [
    `$a = Get-Acl -LiteralPath '${directory.replace(/'/gu, "''")}'`,
    '$a.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }',
  ].join('; ')
  let stdout: string
  try {
    stdout = await runCommand('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
  } catch (error: unknown) {
    return { directory, state: 'unverified', reason: error instanceof Error ? error.message : String(error) }
  }
  const entries = stdout
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '' && /^S-1-/u.test(line))
  if (entries.length === 0) {
    return { directory, state: 'unverified', reason: 'Get-Acl returned no principals' }
  }
  const weak = entries.filter(sid => !ALLOWED_SIDS.has(sid))
  return { directory, state: weak.length === 0 ? 'protected' : 'exposed', entries, weak }
}
