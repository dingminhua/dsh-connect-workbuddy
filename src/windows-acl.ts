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
 * WHY AN EXPLICIT USER SID AND NOT JUST `OWNER RIGHTS` (S-1-3-4). Until issue
 * #199 this module granted the OWNER RIGHTS pseudo-SID alone, reasoning that the
 * process creating a file becomes its owner, so `OWNER RIGHTS` must name the
 * account that reads it back. That assumption is what locked a reporter out. A
 * vault directory can predate this code — or be created or taken over by an
 * ELEVATED process, which is the normal state of a machine whose DSH was started
 * by a `RunLevel=Highest` scheduled task — and then its owner is
 * `BUILTIN\Administrators`, not the daily-use account. Grant `OWNER RIGHTS`,
 * drop inherited ACEs with `/inheritance:r`, and the only principals left are
 * Administrators + SYSTEM: a NON-admin user has no access at all, and `icacls`
 * exits 0 because it never promised otherwise. The lockout is not a failed call;
 * it is a successful call with a wrong premise.
 *
 * So the grant list now carries the current user's SID explicitly, beside the
 * owner rights. Resolving it costs ONE `whoami /user` child per process, memoized
 * on success and on failure alike — a machine without an answer is not going to
 * grow one mid-session. `OWNER RIGHTS` stays: it keeps a directory created by
 * THIS process correct even if a second account later reads it, and it costs
 * nothing to keep.
 *
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
 * Well-known SID for `NT AUTHORITY\INTERACTIVE`.
 *
 * The fallback grant for a machine where `whoami` cannot answer (issue #199's
 * reporter had both a non-admin daily token and an elevated launch task, so the
 * two are not hypothetical). It is WIDER than the user's own SID — every
 * interactive logon of this machine qualifies — which is precisely why it is
 * used only when the precise answer is unavailable, and why the vault still sits
 * under `%USERPROFILE%`.
 */
const INTERACTIVE_SID = 'S-1-5-4'

/**
 * Principals allowed to keep access, as SIDs.
 *
 * Used by {@link inspectCredentialDirectory} to tell "hardened" from "somebody
 * widened it again"; keeping the list beside the grant specs is what stops the
 * two from drifting. The current user's SID joins it at check time from
 * {@link resolveCurrentUserSid} — a read-back that named the user would
 * otherwise be reported as an unexpected principal on every healthy machine.
 */
const ALLOWED_SIDS: ReadonlySet<string> = new Set([OWNER_RIGHTS_SID, SYSTEM_SID, ADMINISTRATORS_SID])

/**
 * Grant specs for a DIRECTORY (issue #199).
 *
 * `(OI)(CI)` object-inherit and container-inherit make the ACE apply to files
 * and subdirectories created later, which is the whole mechanism this module
 * relies on.
 *
 * `principal` is the NON-well-known entry, always present: the current user's own
 * SID when `whoami` answered, `NT AUTHORITY\INTERACTIVE` when it did not. It is
 * the fix for #199 — `OWNER RIGHTS` alone resolves to whatever the directory's
 * OWNER is, and where an elevated process created the vault that is
 * `BUILTIN\Administrators`, so dropping inherited ACEs left the daily-use account
 * with nothing. The owner-rights entry stays for directories this process created
 * itself, where it is exactly right and free.
 */
function directoryGrants(principal: string): readonly string[] {
  return [
    `*${OWNER_RIGHTS_SID}:(OI)(CI)(F)`,
    `*${principal}:(OI)(CI)(F)`,
    `*${SYSTEM_SID}:(OI)(CI)(F)`,
    `*${ADMINISTRATORS_SID}:(OI)(CI)(F)`,
  ]
}

/**
 * Grant specs for a FILE (issue #199), with the same principal as the directory.
 *
 * No `(OI)(CI)`: inheritance flags on a file are meaningless, and passing them
 * is what produced the blanked DACLs measured with `/T`.
 */
function fileGrants(principal: string): readonly string[] {
  return [
    `*${OWNER_RIGHTS_SID}:(F)`,
    `*${principal}:(F)`,
    `*${SYSTEM_SID}:(F)`,
    `*${ADMINISTRATORS_SID}:(F)`,
  ]
}

/** How long one `icacls` (or PowerShell) child may take before it is abandoned. */
const ACL_COMMAND_TIMEOUT_MS = 10_000

/**
 * How long the ONE `whoami` may take. Deliberately much shorter than `icacls`'s.
 *
 * The reason is a latency budget this module owns: `hardeningPrincipal()` runs on
 * the credential-WRITE path, so its timeout ADDS to the worst case of the first
 * sign-in or import rather than replacing it — sharing the 10 s above would make
 * that 20 s. `whoami /user` answers in tens of milliseconds under normal load
 * (`icacls` measured 19–52 ms at rest on the same class of machine, and `whoami`
 * is a cheaper lookup), and a slow answer is worth less than a fast degradation:
 * past this bound the hardening proceeds with `INTERACTIVE`, which is wider than
 * the user's SID but correct, and `doctor` reports which one was used. The 2 s
 * leaves ~25× headroom over the measured cost, so it only fires when the child is
 * genuinely stuck.
 */
const SID_LOOKUP_TIMEOUT_MS = 2_000

/**
 * The current user's SID, resolved ONCE per process.
 *
 * The memoized value is the PROMISE, not the answer. Caching the answer behind a
 * boolean flag looks equivalent and is not: the flag has to be set BEFORE the await
 * so a second caller does not spawn a second `whoami`, and at that instant the
 * answer is still `undefined` — so every concurrent caller received `undefined` and
 * the hardening silently fell back to `NT AUTHORITY\INTERACTIVE` on a machine where
 * `whoami` answers perfectly well. `inspectCredentialDirectory` asks twice at once
 * (`Promise.all`), and a mutant of this shape was caught by this file's own test:
 * the fix's user SID came back as an UNEXPECTED principal. A promise is what makes
 * "one child, shared by all callers" actually true.
 */
let currentUserSidPromise: Promise<string | undefined> | undefined

/** The one `whoami` behind {@link resolveCurrentUserSid}. */
async function lookupCurrentUserSid(): Promise<string | undefined> {
  try {
    const stdout = await runCommand('whoami', ['/user', '/fo', 'CSV', '/nh'], SID_LOOKUP_TIMEOUT_MS)
    return /(S-1-[0-9-]+)/u.exec(stdout)?.[1]
  } catch {
    return undefined
  }
}

/**
 * The current user's SID, or `undefined` when `whoami` would not answer.
 *
 * `whoami /user /fo CSV /nh` prints `<account>,S-1-5-21-…`. The account NAME is
 * localized in its shape but the `S-1-…` text never is, so the extract is a
 * pattern over the SID, not a CSV column read: on a zh-CN host the first field
 * is `机器\用户` either way, and a `sid.split(',')[1]` would be parsing a name.
 *
 * One child per PROCESS, memoized on success and on failure alike: a machine
 * without `whoami` is not going to grow one mid-session, and a second lookup
 * would cost another ~50 ms on the credential-write path.
 */
async function resolveCurrentUserSid(): Promise<string | undefined> {
  currentUserSidPromise ??= lookupCurrentUserSid()
  return await currentUserSidPromise
}

/**
 * The extra principal one hardening round names, beside the well-known SIDs
 * (issue #199).
 *
 * The current user's SID when `whoami` answered; `INTERACTIVE` when it did not.
 * Either way the grant names SOME principal the writing process can reach, which
 * is the property issue #199's machine lost. One value feeds the grants AND the
 * read-back check, so the two cannot drift: reporting a healthy directory as
 * `exposed` because the fix named its own principal would be its own bug.
 */
async function hardeningPrincipal(): Promise<string> {
  return await resolveCurrentUserSid() ?? INTERACTIVE_SID
}

/**
 * The principals a hardened directory or file is allowed to name.
 *
 * {@link ALLOWED_SIDS} plus whatever this process just granted. `OWNER RIGHTS`
 * covers the owner itself, so the user is doubly covered when they own the
 * directory — which is the point: the fix must hold whether or not the owner is
 * the current user.
 */
function allowedSidsFor(principal: string): ReadonlySet<string> {
  return new Set([...ALLOWED_SIDS, principal])
}

/**
 * Result of one hardening attempt.
 *
 * `not-windows` is a normal POSIX answer, not a failure: the `mode` argument
 * already conveys the same intent there. Keeping the two apart is what lets
 * `doctor` avoid warning every macOS user about a Windows-only measure.
 *
 * `principal` records WHICH account name the grants carried, so a machine where
 * `whoami` did not answer — and the hardening therefore fell back to `NT
 * AUTHORITY\INTERACTIVE`, a wider principal — is visible in the report instead of
 * looking like a per-user grant.
 */
export type CredentialAclOutcome =
  | { state: 'protected', principal?: string }
  | { state: 'not-windows' }
  | { state: 'failed', reason: string, principal?: string }

/**
 * What {@link inspectCredentialDirectory} found.
 *
 * `unverified` is distinct from `failed`: it means the ACL could not be READ
 * back (PowerShell missing, command timed out), which says nothing about whether
 * the hardening holds. It is also the answer a LOCKED directory gives — reading a
 * DACL needs `READ_CONTROL`, which a locked-out user does not have — so `unverified`
 * must be surfaced, never treated as "probably fine" (issue #199 defect 3).
 */
export interface CredentialAclReport {
  /** The directory inspected. */
  directory: string
  state: 'protected' | 'exposed' | 'not-windows' | 'unverified'
  /** Principals holding access, as SIDs, when the read succeeded. */
  entries?: string[]
  /** The subset of {@link entries} that is neither the owner nor an administrator. */
  weak?: string[]
  /**
   * The directory's owner, as a SID, when the read succeeded.
   *
   * Reported because `OWNER RIGHTS` resolves to WHOEVER THIS IS (issue #199), so
   * without it a reader cannot tell a healthy `protected` from a hardened-and-
   * unusable one.
   */
  owner?: string
  /** Whether {@link owner} is the account running this process. */
  ownerIsCurrentUser?: boolean
  /**
   * The non-well-known principal this build grants (the user's SID, or
   * `NT AUTHORITY\INTERACTIVE` when `whoami` could not answer).
   */
  principal?: string
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
function runCommand(
  file: string,
  args: readonly string[],
  timeoutMs: number = ACL_COMMAND_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs },
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
 *   - CALLS: one per directory, never a walk — plus ONE `whoami` per PROCESS.
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
  const principal = await hardeningPrincipal()
  if (protectedDirectories.has(directory)) return { state: 'protected', principal }
  const pending = inflightProtection.get(directory)
  if (pending !== undefined) return pending
  const attempt = hardenDirectory(directory, principal)
  inflightProtection.set(directory, attempt)
  try {
    return await attempt
  } finally {
    inflightProtection.delete(directory)
  }
}

/**
 * The work behind {@link protectCredentialDirectory}: one `icacls` call.
 *
 * The principal is resolved by the CALLER so that the memoized-hit path and the
 * real attempt report the same value — a doctor hint that appears and disappears
 * with the cache would be a new observability bug on top of the one this fixes.
 */
async function hardenDirectory(directory: string, principal: string): Promise<CredentialAclOutcome> {
  try {
    await mkdir(directory, { recursive: true })
    await applyAcl(directory, directoryGrants(principal))
    protectedDirectories.add(directory)
    return { state: 'protected', principal }
  } catch (error: unknown) {
    return { state: 'failed', reason: error instanceof Error ? error.message : String(error), principal }
  }
}

/**
 * Harden ONE credential file so that only its owner, the current user, SYSTEM and
 * Administrators may read it (issue #183, widened by issue #199).
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
  const principal = await hardeningPrincipal()
  try {
    await applyAcl(path, fileGrants(principal))
    return { state: 'protected', principal }
  } catch (error: unknown) {
    return { state: 'failed', reason: error instanceof Error ? error.message : String(error), principal }
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
 *
 * WHY `unverified` COULD NOT BE LEFT UNVERIFIED (issue #199). A LOCKED directory
 * reports nothing here: reading a DACL needs `READ_CONTROL`, which is exactly the
 * right the lockout removed. So the one machine that most needs a diagnosis was
 * the one the old code answered with a shrug. `unverified` and `failed` now reach
 * `doctor`'s hints — see `src/bin.ts`.
 *
 * The OWNER is read in the same pass because `OWNER RIGHTS` resolves to whoever
 * that is: without it, "restricted and usable" and "restricted and unusable" have
 * identical ACE lists, and only the owner distinguishes them.
 */
export async function inspectCredentialDirectory(directory: string): Promise<CredentialAclReport> {
  if (!isWindows()) return { directory, state: 'not-windows' }
  const [userSid, principal] = await Promise.all([resolveCurrentUserSid(), hardeningPrincipal()])
  /**
   * Deliberately a single quoted expression with no interpolation of `directory`
   * beyond the literal path: `-LiteralPath` keeps a path containing `[` or `$`
   * from being treated as a wildcard or a subexpression.
   *
   * The owner line carries an `OWNER ` prefix so ONE stdout stream answers two
   * questions without a parser guessing which line is which. `Get-Acl` hands the
   * owner back as an account NAME, and a name belonging to a deleted or
   * unresolvable account makes the translation THROW — so the catch prints the
   * raw name rather than losing the whole report for want of one lookup.
   */
  const script = [
    `$a = Get-Acl -LiteralPath '${directory.replace(/'/gu, "''")}'`,
    'try { "OWNER " + $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value } catch { "OWNER " + $a.Owner }',
    '$a.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }',
  ].join('; ')
  let stdout: string
  try {
    stdout = await runCommand('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
  } catch (error: unknown) {
    return {
      directory,
      state: 'unverified',
      principal,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  const lines = stdout
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '')
  const ownerLine = lines.find(line => line.startsWith('OWNER '))
  const owner = ownerLine === undefined ? undefined : ownerLine.slice('OWNER '.length).trim()
  // The `OWNER` line cannot survive this filter anyway — it starts with `OWNER `,
  // not with a SID — but dropping it by identity rather than by accident is what
  // keeps the two answers from silently merging if the prefix ever changes.
  const entries = lines
    .filter(line => line !== ownerLine)
    .filter(line => /^S-1-/u.test(line))
  /**
   * `ownerIsCurrentUser` appears ONLY when `whoami` answered: an absent field
   * reads as "we cannot say", which is the honest answer on a machine where the
   * SID lookup failed, and is not the same fact as "the owner is somebody else".
   */
  const ownerFacts = {
    ...owner === undefined ? {} : { owner },
    ...userSid === undefined || owner === undefined ? {} : { ownerIsCurrentUser: owner === userSid },
    principal,
  }
  if (entries.length === 0) {
    return { directory, state: 'unverified', ...ownerFacts, reason: 'Get-Acl returned no principals' }
  }
  const weak = entries.filter(sid => !allowedSidsFor(principal).has(sid))
  return { directory, state: weak.length === 0 ? 'protected' : 'exposed', entries, weak, ...ownerFacts }
}

/**
 * Drop this module's memoized answers.
 *
 * A TEST SEAM, and the only one in this module. The `whoami` result and the
 * directory memo are both per-PROCESS state, so without a reset one test's answer
 * leaks into the next and the two branches of issue #199's fix — the user's own
 * SID when `whoami` answers, `INTERACTIVE` when it does not — cannot both be
 * pinned in one file. Production never calls this.
 */
export function resetWindowsAclStateForTests(): void {
  protectedDirectories.clear()
  inflightProtection.clear()
  currentUserSidPromise = undefined
}
