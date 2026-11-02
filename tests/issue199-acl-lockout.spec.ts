/**
 * Issue #199: the ACL hardening must never lock the user out of their own vault,
 * and an unreadable vault must never read as "the account no longer exists".
 *
 * THE REPORT, in its own words. `<dsh home>/workbuddy-vault` was created on
 * 10/27 by an ELEVATED DSH (that machine had a `RunLevel=Highest` no-UAC launch
 * task), so its owner is `BUILTIN\Administrators`. On 11/2 the plugin — 5.16.0+
 * — hardened it with
 *
 *   icacls <dir> /inheritance:r /grant:r *S-1-3-4:(OI)(CI)(F) *S-1-5-18:… *S-1-5-32-544:…
 *
 * `OWNER RIGHTS` (S-1-3-4) resolves to the object's OWNER, which was
 * Administrators, and `/inheritance:r` then deleted the inherited ACE that was the
 * only thing the daily-use account had. `icacls` exited 0 — it never promised the
 * user access — and the reporter ended up with `stat`/`readdir`/`mkdir`/`write` all
 * `EPERM` on their own credential folder, needing `takeown` to recover.
 *
 * The issue's A/B experiment isolates the variable: identical argv, owner = the
 * user in one case (works), owner = Administrators in the other (locked out). Which
 * makes this a defect of PREMISE, not of execution — and the premise was written
 * down in the source as "the answer is already implied".
 *
 * WHAT IS PINNED HERE:
 *
 *   1. The grant list names the CURRENT USER'S OWN SID, beside the owner rights
 *      (defect 1, the lockout itself).
 *   2. The SID costs ONE child process per process, and a machine where `whoami`
 *      cannot answer still gets a principal the writing process can reach
 *      (`NT AUTHORITY\INTERACTIVE`) rather than owner rights alone.
 *   3. The read-back parses the OWNER — the fact that decides whether a restricted
 *      DACL is usable or a cage — and does not report its own fix as `exposed`.
 *   4. An unreadable vault is a REPORTED state (defect 2). It used to be swallowed,
 *      which turned the lockout's symptom into the WRONG advice: 「已保存的账号在
 *      本机已不存在」 tells a user to re-login when the credential is healthy and
 *      merely cannot be opened.
 *
 * HOW THIS RUNS WITHOUT WINDOWS. `process.platform` is shadowed and
 * `node:child_process` is mocked at the module boundary — both the technique
 * `tests/issue183-credential-acl.spec.ts` documents — plus `node:fs/promises`'s
 * `readdir`, which supplies the lockout's real filesystem answer (`EPERM`, not
 * `ENOENT`) to the credential store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Every child process the module spawned, as `[file, argv]`. */
const spawned: { file: string, args: string[], options?: unknown }[] = []

/** Argv for spawns of one executable, in order. */
function argsOf(file: string): string[][] {
  return spawned.filter(call => call.file === file).map(call => call.args)
}

/** The spawn options passed to one executable, in order. */
function optionsOf(file: string): Record<string, unknown>[] {
  return spawned.filter(call => call.file === file).map(call => call.options as Record<string, unknown>)
}

/** How many children one executable has been paid for. */
function countOf(file: string): number {
  return spawned.filter(call => call.file === file).length
}

/**
 * The `/grant:r` spec arguments of one `icacls` call, in order.
 *
 * Takes the value AFTER each `/grant:r` rather than filtering for a shape, for the
 * reason recorded in `tests/issue183-credential-acl.spec.ts`: a filter keyed on
 * `*S-1-` cannot SEE a malformed grant, and that blind spot let one mutant survive.
 */
function grantArgsOf(args: readonly string[]): string[] {
  const grants: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '/grant:r' && index + 1 < args.length) grants.push(args[index + 1]!)
  }
  return grants
}

/** What `Get-Acl` prints for the inspect tests: one record per line. */
let aclStdout = ''
/**
 * What `whoami /user` prints — `<account>,<SID>`, the real shape.
 *
 * Carrying the account NAME is the point: production extracts the SID from a line
 * whose first field is localized, so a fixture of a bare SID would test a parser
 * that never runs.
 */
let whoamiStdout = `DESKTOP-7Q1\\luyuyu,${'S-1-5-21-1411259516-1007003351-3697357812-1001'}`
/** When set, spawns of THIS executable fail while the rest succeed. */
let failFor: string | undefined
/** When set, `icacls` (and everything else) fails, as in the #183 file. */
let failWith: string | undefined
/** When set, `readdir` of exactly this directory refuses, as a lockout does. */
let refuseReaddirOf: string | undefined

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (
      file: string,
      args: readonly string[],
      options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      spawned.push({ file, args: [...args], options })
      if (failWith !== undefined || failFor === file) {
        callback(Object.assign(new Error(`${file} exited EPERM`), { code: 'EPERM' }), '', '')
        return
      }
      // Per-executable on purpose: `whoami` joined this module's children in #199,
      // and a mock that answers nothing for it would silently test only the
      // fallback branch on every case in this file.
      callback(null, file === 'powershell' ? aclStdout : file === 'whoami' ? whoamiStdout : '', '')
    },
  }
})

const realFs = await import('node:fs/promises')

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: async (path: never, ...rest: never[]) => {
      const target = String(path)
      if (refuseReaddirOf !== undefined && target === refuseReaddirOf) {
        // The message shape the reporter measured: a DENIAL, not an ENOENT. The
        // distinction IS the defect — ENOENT means "empty vault", which is normal;
        // this means "there are accounts in there and you cannot see them".
        const error = new Error(`EPERM: operation not permitted, opendir '${target}'`) as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return (actual.readdir as never as (...args: never[]) => unknown)(path, ...rest) as never
    },
  }
})

const {
  inspectCredentialDirectory,
  protectCredentialDirectory,
  protectCredentialFile,
  resetWindowsAclStateForTests,
} = await import('../src/windows-acl.ts')

const { WorkBuddyCredentialStore } = await import('../src/auth.ts')

const { signedOutNotice, signedOutText } = await import('../src/client/searched-paths.ts')

const USER_SID = 'S-1-5-21-1411259516-1007003351-3697357812-1001'
const ADMINISTRATORS_SID = 'S-1-5-32-544'
const INTERACTIVE_SID = 'S-1-5-4'

describe('issue #199: the hardening names the current user, not only the owner', () => {
  let root: string
  let restorePlatform: (() => void) | undefined

  beforeEach(async () => {
    spawned.length = 0
    aclStdout = ''
    whoamiStdout = `DESKTOP-7Q1\\luyuyu,${USER_SID}`
    failWith = undefined
    failFor = undefined
    refuseReaddirOf = undefined
    // The SID lookup and the directory memo are per-PROCESS state, so without this
    // one test's `whoami` answer would decide the next test's grant list.
    resetWindowsAclStateForTests()
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    root = await mkdtemp(join(tmpdir(), 'wb-199-'))
  })

  afterEach(async () => {
    restorePlatform?.()
    restorePlatform = undefined
    vi.useRealTimers()
    await realFs.rm(root, { recursive: true, force: true })
  })

  /** Run the rest of the test as Windows, on any host. */
  function actAsWindows(): void {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    restorePlatform = () => {
      if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor)
    }
  }

  // -------------------------------------------------------------------------
  // 1. Defect 1: the grant list must name the account that will read it back
  // -------------------------------------------------------------------------

  it('grants the current user SID on the directory, beside the owner rights', async () => {
    actAsWindows()
    await protectCredentialDirectory(`${root}/vault`)
    const grants = grantArgsOf(argsOf('icacls')[0]!)
    // The owner-rights entry STAYS: where this process created the directory it is
    // exactly right and costs nothing. The user's own SID is what makes the grant
    // hold when the owner is somebody else — the #199 case, where owner rights
    // resolved to Administrators and left the daily-use account with nothing.
    expect(grants).toContain(`*${USER_SID}:(OI)(CI)(F)`)
    expect(grants).toContain('*S-1-3-4:(OI)(CI)(F)')
    expect(grants).toContain(`*${ADMINISTRATORS_SID}:(OI)(CI)(F)`)
    expect(grants).toHaveLength(4)
  })

  it('grants the current user SID on a file too, without inheritance flags', async () => {
    actAsWindows()
    await protectCredentialFile(`${root}/vault/cn/entry.json`)
    const grants = grantArgsOf(argsOf('icacls')[0]!)
    expect(grants).toContain(`*${USER_SID}:(F)`)
    for (const grant of grants) {
      expect(grant).not.toContain('(OI)')
      expect(grant).not.toContain('(CI)')
    }
  })

  it('extracts the SID from a whoami line whose account part is localized', async () => {
    // The zh-CN host this module exists for: `whoami /user /fo CSV` prints
    // `工作站\用户,S-1-5-21-…`, so the parse must key on the SID TEXT rather than on
    // a CSV column — `split(',')[1]` would be parsing a name that the report says
    // is spelled differently per locale.
    actAsWindows()
    whoamiStdout = `工作站\\刘雨瑜,${USER_SID}\r\n`
    await protectCredentialDirectory(`${root}/vault`)
    expect(grantArgsOf(argsOf('icacls')[0]!)).toContain(`*${USER_SID}:(OI)(CI)(F)`)
  })

  // -------------------------------------------------------------------------
  // 2. The cost model: ONE lookup per process, and a usable answer when it fails
  // -------------------------------------------------------------------------

  it('asks whoami once per process, no matter how many paths it hardens', async () => {
    // The per-write budget is why this module refuses to walk directories at all
    // (`icacls` measured up to 1242 ms under parallel load, which blew a polling
    // budget in `tests/issue12-region-hiding.spec.ts`). A lookup per call would put
    // a second child on the credential-write path — the cost this module's own
    // comment exists to avoid.
    actAsWindows()
    await protectCredentialDirectory(`${root}/vault`)
    await protectCredentialDirectory(`${root}/vault2`)
    await protectCredentialFile(`${root}/vault/cn/a.json`)
    await inspectCredentialDirectory(`${root}/vault/cn`)
    expect(countOf('whoami')).toBe(1)
  })

  it('hides the whoami window and gives it the shorter timeout budget', async () => {
    // Two properties this NEW child has to carry, each pinned because it is easy to
    // lose by reusing a helper:
    //
    //   - `windowsHide`. `docs/WINDOWS.md` §1-5 records the defect class: the DSH
    //     host is a console-less GUI process, so every un-hidden console child
    //     FLASHES A BLACK WINDOW on screen. `whoami` is a console program, and it
    //     now runs on the credential-write path — the same path the user triggers
    //     from the card. A grant that fixed the ACL and started blinking would be
    //     a regression of the issue this file's §1-5 sibling was filed for.
    //
    //   - a timeout SHORTER than `icacls`'s. `hardeningPrincipal()` is AWAITED
    //     before the hardening starts, so its bound ADDS to the first credential
    //     write's worst case rather than hiding inside it: sharing the 10 s would
    //     double the worst case of a sign-in. Past its own bound the lookup yields
    //     `undefined` and the hardening proceeds with `INTERACTIVE` — degraded,
    //     usable, and reported as such.
    actAsWindows()
    await protectCredentialDirectory(`${root}/vault`)
    const whoami = optionsOf('whoami')[0] as { windowsHide?: boolean, timeout?: number }
    const icacls = optionsOf('icacls')[0] as { windowsHide?: boolean, timeout?: number }
    expect(whoami.windowsHide).toBe(true)
    expect(icacls.windowsHide).toBe(true)
    expect(typeof whoami.timeout).toBe('number')
    expect(whoami.timeout!).toBeLessThan(icacls.timeout!)
  })

  it('grants INTERACTIVE rather than owner rights alone when whoami cannot answer', async () => {
    // The honest degraded case, and it must degrade to something USABLE. Owner
    // rights alone is exactly the configuration that locked the reporter out; the
    // interactive logon is a wider-but-real principal that still lets this process
    // read its own vault, and the vault still sits under %USERPROFILE%.
    actAsWindows()
    failFor = 'whoami'
    const outcome = await protectCredentialDirectory(`${root}/vault-nolookup`)
    expect(outcome.state).toBe('protected')
    const grants = grantArgsOf(argsOf('icacls').find(args => args[0] === `${root}/vault-nolookup`)!)
    expect(grants).toContain(`*${INTERACTIVE_SID}:(OI)(CI)(F)`)
    // And the outcome SAYS which principal it used, so `doctor` cannot present a
    // wider grant as a per-user one.
    expect(outcome).toEqual({ state: 'protected', principal: INTERACTIVE_SID })
  })

  it('reports the principal a successful hardening named', async () => {
    actAsWindows()
    const outcome = await protectCredentialDirectory(`${root}/vault`)
    expect(outcome).toEqual({ state: 'protected', principal: USER_SID })
  })

  // -------------------------------------------------------------------------
  // 3. The read-back knows the owner, and does not report its own fix as exposure
  // -------------------------------------------------------------------------

  it('does not report the user SID it granted as an unexpected principal', async () => {
    // Without this, the FIX would raise a false `exposed` alarm on every healthy
    // Windows machine — the exact opposite of what #183's read-back is for. This
    // case is the whole reason the allow-list is derived from the same value the
    // grants use rather than written twice.
    actAsWindows()
    aclStdout = `OWNER ${USER_SID}\r\nS-1-3-4\r\nS-1-5-18\r\n${ADMINISTRATORS_SID}\r\n${USER_SID}`
    const report = await inspectCredentialDirectory(`${root}/vault/cn`)
    expect(report.state).toBe('protected')
    expect(report.weak).toEqual([])
  })

  it('still reports Everyone as exposure beside the new principal', async () => {
    // The other half of the same allow-list change: widening what is allowed must
    // not quietly stop catching the ACE #183 was filed about.
    actAsWindows()
    aclStdout = `OWNER ${USER_SID}\r\nS-1-3-4\r\nS-1-5-18\r\n${ADMINISTRATORS_SID}\r\n${USER_SID}\r\nS-1-1-0`
    const report = await inspectCredentialDirectory(`${root}/vault/cn`)
    expect(report.state).toBe('exposed')
    expect(report.weak).toEqual(['S-1-1-0'])
  })

  it('reads the owner back and says whether it is this account', async () => {
    actAsWindows()
    aclStdout = `OWNER ${USER_SID}\r\nS-1-3-4\r\nS-1-5-18\r\n${ADMINISTRATORS_SID}\r\n${USER_SID}`
    const mine = await inspectCredentialDirectory(`${root}/vault/cn`)
    expect(mine.owner).toBe(USER_SID)
    expect(mine.ownerIsCurrentUser).toBe(true)

    // The forensic fact the reporter had to derive over four angles (a full
    // `~/.dsh` scan, an npm-packed 5.16.0 tarball, a timeline, and an A/B
    // experiment). It is now one field, and it is the field that separates a
    // usable `protected` from a cage with the same ACE list.
    aclStdout = `OWNER ${ADMINISTRATORS_SID}\r\nS-1-3-4\r\nS-1-5-18\r\n${ADMINISTRATORS_SID}`
    const theirs = await inspectCredentialDirectory(`${root}/vault/cn`)
    expect(theirs.owner).toBe(ADMINISTRATORS_SID)
    expect(theirs.ownerIsCurrentUser).toBe(false)
  })

  it('omits the owner verdict when whoami could not answer, rather than guessing', async () => {
    // Absent means "we cannot say", which is NOT the same fact as "the owner is
    // somebody else" — the second is the one that triggers a takeown hint.
    actAsWindows()
    failFor = 'whoami'
    aclStdout = `OWNER ${ADMINISTRATORS_SID}\r\nS-1-3-4\r\nS-1-5-18\r\n${ADMINISTRATORS_SID}\r\n${INTERACTIVE_SID}`
    const report = await inspectCredentialDirectory(`${root}/vault/cn`)
    expect(report.owner).toBe(ADMINISTRATORS_SID)
    expect(report.ownerIsCurrentUser).toBeUndefined()
    expect(report.state).toBe('protected')
  })

  it('keeps asking PowerShell for SIDs and adds a locale-independent owner read', async () => {
    actAsWindows()
    aclStdout = 'S-1-3-4'
    await inspectCredentialDirectory(`${root}/vault/cn`)
    const script = spawned.find(entry => entry.file === 'powershell')!.args.join(' ')
    expect(script).toContain('Get-Acl')
    expect(script).toContain('SecurityIdentifier')
    expect(script).toContain('.Value')
    // The owner read, asserted as the WHOLE call rather than as `toContain('GetOwner')`.
    // Measured, not stylistic: renaming the method to `GetOwnerBroken` left a
    // `toContain('GetOwner')` assertion green, because the broken name still
    // CONTAINS the searched one — the same trap this repository's own mutation notes
    // describe for grant-spec filters. The type argument is part of the guarantee:
    // `GetOwner([SecurityIdentifier])` is what answers in SID form (a bare `.Owner`
    // returns a localized NAME, which is exactly what #199 cannot be compared on),
    // with a raw-name fallback for an account that no longer resolves — losing the
    // whole report for want of one identity lookup would be worse.
    expect(script).toContain('GetOwner([System.Security.Principal.SecurityIdentifier])')
    expect(script).toContain('OWNER ')
  })

  // -------------------------------------------------------------------------
  // 4. Defect 2: an unreadable vault is a REPORTED state, not an empty one
  // -------------------------------------------------------------------------

  /**
   * A store pointed at a vault directory that may or may not be openable.
   *
   * `authDirs` / `desktopPath` / `ownPath` all name a directory that holds nothing,
   * so the ONLY sign-in source in play is the vault — which is exactly the
   * reporter's shape: an OAuth-added account lives in the vault and nowhere else.
   */
  function storeOn(regionDir: string): InstanceType<typeof WorkBuddyCredentialStore> {
    return new WorkBuddyCredentialStore({
      refresh: async () => { throw new Error('unused') },
      region: 'cn',
      vaultDir: regionDir,
      authDirs: [`${regionDir}/no-desktop-auth`],
      desktopPath: `${regionDir}/no-desktop-auth/workbuddy-desktop.info`,
      ownPath: `${regionDir}/.workbuddy-auth.cn.json`,
      resolveAtRestKey: async () => undefined,
    })
  }

  it('records the vault read failure instead of answering "no accounts"', async () => {
    actAsWindows()
    const regionDir = `${root}/workbuddy-vault/cn`
    refuseReaddirOf = regionDir
    const store = storeOn(regionDir)

    // Discovery survives — that half of the old behaviour was right and stays: a
    // chat turn must not die because one folder is shut.
    expect(await store.accounts()).toEqual([])
    // …and the reason is now KNOWABLE, which it was not. `syncVault` used to
    // `catch { return }` keeping nothing, so no surface could tell "the vault is
    // empty" from "the vault is shut", and the card filled the gap with the wrong
    // advice.
    expect(store.vaultError()).toMatch(/EPERM/u)
  })

  it('reports the locked directory in diagnose(), not only through vaultError', async () => {
    // The second consumer of the same fact, and the one that reaches the user's
    // EYES rather than a route field: `diagnose()` feeds the card's probed-path
    // list. Its old `catch` comment claimed a vault read error "is already
    // reported through the own copies' diagnostics pass above" — it is not: that
    // pass opens FILES, and a directory nobody can OPEN yields no file-level error
    // at all. On #199's machine `diagnose()` therefore answered "nothing wrong"
    // for the single thing that was wrong.
    actAsWindows()
    const regionDir = `${root}/workbuddy-vault/cn`
    refuseReaddirOf = regionDir
    const store = storeOn(regionDir)
    const { failures } = await store.diagnose()
    const entry = failures.find(failure => failure.path === regionDir)
    expect(entry).toBeDefined()
    // `unreadable`, NOT `missing`: the list's default view hides `missing` behind a
    // toggle (`INTERESTING_REASONS`), and a lockout hidden behind a toggle is the
    // same silence this defect is about, one click deeper.
    expect(entry?.reason).toBe('unreadable')
    expect(entry?.message).toMatch(/EPERM/u)
  })

  it('clears the vault failure once the directory becomes readable again', async () => {
    actAsWindows()
    const regionDir = `${root}/workbuddy-vault/cn`
    const store = storeOn(regionDir)
    refuseReaddirOf = regionDir
    await store.accounts()
    expect(store.vaultError()).toBeDefined()

    refuseReaddirOf = undefined
    // The scan answer is SHARED for a 1 s window, so this second read has to be
    // pushed past it — otherwise the test would assert on the first scan's cache
    // rather than on a fresh read. The clock stays fake for the second read on
    // purpose: restoring real timers would set it BACKWARDS relative to the
    // finish time the scan recorded, and the window test would pass again.
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(1_001)
    await store.accounts()
    vi.useRealTimers()
    // A machine that recovers must stop complaining: a stale failure would itself
    // become a misleading diagnosis.
    expect(store.vaultError()).toBeUndefined()
  })

  it('outranks selectionLost with the unreadable-vault copy', () => {
    // THE direction-wrong message this issue is about. `selectionLost` is a
    // conclusion drawn FROM the account list, and an unreadable vault makes that
    // list INCOMPLETE — so the conclusion cannot stand next to its own cause.
    const notice = signedOutNotice({
      selectionLost: true,
      message: 'no signed-in WorkBuddy account found',
      searched: [],
      vaultError: `EPERM: operation not permitted, opendir '${root}/workbuddy-vault/cn'`,
    })
    expect(notice.key).toBe('row.vaultUnreadableMessage')
    const text = signedOutText(notice, (key, params) => `${key}:${String(params?.['error'] ?? '')}`)
    expect(text).toContain('EPERM')
    // With a readable vault, the old priority is untouched.
    expect(signedOutNotice({ selectionLost: true, message: undefined, searched: [] }).key)
      .toBe('row.selectionLostMessage')
  })

  it('never claims a protected vault when the ACL could not be read', async () => {
    actAsWindows()
    failWith = 'powershell exited EPERM'
    const report = await inspectCredentialDirectory(`${root}/vault/cn`)
    // #199's own machine lands HERE: a locked directory cannot report its own DACL,
    // because reading one needs `READ_CONTROL` — the right the lockout removed. The
    // state must stay honest about not knowing, and `doctor` turns it into a hint.
    expect(report.state).toBe('unverified')
    expect(report.reason).toBeDefined()
    expect(report.principal).toBeDefined()
  })
})
