/**
 * Issue #199 defect 3: `doctor` must WARN about the states that can lock a user
 * out, not only about the one that exposes their tokens.
 *
 * THE GAP, in the reporter's own framing. `src/windows-acl.ts` defines four read
 * outcomes (`protected` / `exposed` / `unverified` / `not-windows`) plus a `failed`
 * hardening result, and #183 wired exactly ONE of them into `doctor`'s hints:
 * `state === 'exposed'`. So the machine that got locked out — `icacls` exit 0, the
 * DACL replaced by a cage, `Get-Acl` no longer readable because reading a DACL needs
 * the very `READ_CONTROL` that was just removed — got a body line
 * `Credential vault ACL (cn): unverified` and NO hint, while a merely-too-wide
 * folder got a complete actionable sentence. The coverage was exactly inverted:
 * `exposed` means "too open"; `unverified`, `failed`, and a foreign owner are the
 * shapes that mean "possibly SHUT".
 *
 * These tests run the REAL `run(['doctor','--json'])` — the same shape
 * `tests/doctor-device-json.spec.ts` uses, because the promise here is about THE
 * REPORT: a unit test of the branch could keep passing while `--json` quietly
 * dropped the field. Windows is shadowed over (the technique
 * `tests/issue183-credential-acl.spec.ts` documents) and every child process is
 * mocked, so this pins the whole diagnostic chain on any host:
 *
 *   1. `failed` and `unverified` produce hints AND stay in the JSON.
 *   2. The OWNER is read back and reported as foreign (defect 1's forensic fact),
 *      with the takeown advice where something is actually broken.
 *   3. A vault that cannot be LISTED is a `vaultError` field plus a hint saying the
 *      opposite of 「账号已不存在」 (defect 2, on the CLI side).
 *   4. A restricted, readable vault still produces NO vault hint — warning a healthy
 *      machine about its own healthy permissions is how hints become noise.
 *
 * HOW THE VAULT PATH IS CONTROLLED. `doctor` derives it from `$DSH_HOME`
 * (`workbuddyVaultDir()` = `<home>/workbuddy-vault/<region>`), so every case points
 * `DSH_HOME` at a fresh temp directory — the isolation
 * `tests/doctor-device-json.spec.ts` needs for the same reason, one home per case.
 * Windows is shadowed over and `node:child_process` is fully stubbed, so the
 * registry and SDK probes that would otherwise spawn children on a win32 host answer
 * empty, and no `whoami` / `icacls` / `powershell` ever runs for real.
 */
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The current user's SID, as `whoami` would report it on the reporter's machine. */
const USER_SID = 'S-1-5-21-1411259516-1007003351-3697357812-1001'
/** `BUILTIN\Administrators`: the owner that locked the reporter out. */
const ADMIN_SID = 'S-1-5-32-544'

/** Child processes the ACL module spawned, as `[file, argv]`. */
const spawned: { file: string, args: string[] }[] = []
/** Executables that must fail instead of answering. */
const failing = new Set<string>()
/** `Get-Acl` stdout for the case being run. */
let aclStdout = ''
/** `whoami /user` stdout, in the real `<account>,<SID>` shape. */
let whoamiStdout = `DESKTOP-7Q1\\luyuyu,${USER_SID}`
/** Directories `readdir` must refuse, as a lockout does. */
let refuseListingOf: string | undefined

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (
      file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      spawned.push({ file, args: [...args] })
      if (failing.has(file)) {
        callback(Object.assign(new Error(`${file} exited EPERM`), { code: 'EPERM' }), '', '')
        return
      }
      callback(null, file === 'powershell' ? aclStdout : file === 'whoami' ? whoamiStdout : '', '')
    },
    // `at-rest.ts` probes the registry with `execFileSync`. Its own try/catch turns
    // a non-zero `reg` into "absent", so the honest stub answers with stdout rather
    // than throwing ENOENT for an executable that does not exist on this host.
    execFileSync: () => '',
  }
})

const realFs = await import('node:fs/promises')

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: async (path: never, ...rest: never[]) => {
      const target = String(path)
      if (refuseListingOf !== undefined && target === refuseListingOf) {
        const error = new Error(`EPERM: operation not permitted, opendir '${target}'`) as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return (actual.readdir as never as (...args: never[]) => unknown)(path, ...rest) as never
    },
  }
})

const { resetWindowsAclStateForTests } = await import('../src/windows-acl.ts')
const { run } = await import('../src/bin.ts')

/** `doctor --json`'s parsed document, from a real run. */
async function doctorJson(): Promise<Record<string, unknown>> {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown) => {
    if (typeof chunk === 'string') chunks.push(chunk)
    return true
  }) as typeof process.stdout.write
  try {
    const exit = await run(['doctor', '--json'])
    // The code is `anySignedIn && desktopPresent`; an isolated home has neither, so
    // 1 is the expected answer — the report is printed before it is returned.
    expect([0, 1]).toContain(exit)
  } finally {
    process.stdout.write = original
  }
  const lines = chunks.join('').split('\n').filter(line => line.trim().startsWith('{'))
  expect(lines.length).toBeGreaterThan(0)
  return JSON.parse(lines[0] as string) as Record<string, unknown>
}

/** One region's `credentialAcl` entry from a parsed report. */
function aclEntry(report: Record<string, unknown>, region: string): Record<string, unknown> {
  const block = report['credentialAcl'] as Record<string, unknown>
  const regions = block['regions'] as Record<string, Record<string, unknown>>
  const entry = regions[region]
  expect(entry).toBeDefined()
  return entry!
}

/** Every hint naming a credential vault, so unrelated hints cannot dilute a case. */
function vaultHints(report: Record<string, unknown>): string {
  return ((report['hints'] as string[]) ?? [])
    .filter(hint => /credential vault/iu.test(hint))
    .join('\n')
}

/** The `Get-Acl` stdout of a directory restricted exactly as this build grants it. */
function restrictedAcl(owner: string, granted: string): string {
  return [`OWNER ${owner}`, 'S-1-3-4', 'S-1-5-18', ADMIN_SID, granted].join('\r\n')
}

describe('issue #199 defect 3: doctor warns about the lockout-shaped states', () => {
  /**
   * The per-FILE environment, captured at module scope — the setup file and
   * `vitest.config.ts` run before this module is imported, so these ARE their values.
   * Restored after each case: a later file in the same worker must not inherit a home
   * this file created and then deleted.
   */
  const fileEnv = {
    DSH_HOME: process.env['DSH_HOME'],
    HOME: process.env['HOME'],
    USERPROFILE: process.env['USERPROFILE'],
    LOCALAPPDATA: process.env['LOCALAPPDATA'],
    APPDATA: process.env['APPDATA'],
    XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
  }
  let home = ''
  let vault = ''
  /** Each case's home, removed together once every pending write has settled. */
  const homes: string[] = []
  let restorePlatform: (() => void) | undefined

  /**
   * Point EVERY home-derived variable at this case's directory, not just `DSH_HOME`.
   *
   * Pointing all six is the repo's own rule for a test that runs `doctor`:
   * `vitest.config.ts:13-36` exists precisely because a test that reads whichever
   * sign-ins the MACHINE has is an environment-dependent pass, and this file shadows
   * `win32`, so it walks the Windows branch of `defaultDesktopAuthDirs()` — the one
   * that prefers `LOCALAPPDATA` / `APPDATA` over the home-derived convention.
   *
   * Why it matters HERE: `doctor` creates `$DSH_HOME/.workbuddy-device.json` when it
   * finds an account (without a salt it cannot answer "would this pool collapse onto
   * one device", `src/bin.ts:399-413`), and that create is where this file's cleanup
   * once failed — the surviving tree was `.workbuddy-device.json` and its `.lock`,
   * nothing about the vault. `ENOTEMPTY` from `rm -r` is the signature of an entry the
   * enumeration had not yet seen, and the atomic-write library releases its lock with
   * an unlink no caller awaits, so a removal issued in the same tick as `run()`
   * returning can race it.
   *
   * Stated as measured, and only as measured: the failures appeared under the full
   * suite and not in a single-file run; the isolation plus the bounded retries below
   * made them go away. WHICH sibling supplied the account was never pinned down, so the
   * property is asserted instead of narrated — see the case that reads the home after a
   * run. A case whose behaviour depends on which file happened to run before it is not
   * a case.
   */
  function isolateInto(dir: string): void {
    process.env['DSH_HOME'] = dir
    process.env['HOME'] = dir
    process.env['USERPROFILE'] = dir
    process.env['LOCALAPPDATA'] = join(dir, 'AppData', 'Local')
    process.env['APPDATA'] = join(dir, 'AppData', 'Roaming')
    process.env['XDG_CONFIG_HOME'] = join(dir, '.config')
  }

  beforeEach(async () => {
    spawned.length = 0
    failing.clear()
    refuseListingOf = undefined
    aclStdout = ''
    whoamiStdout = `DESKTOP-7Q1\\luyuyu,${USER_SID}`
    // The SID memo and the directory memo are per-process; without this one case's
    // `icacls` failure would be remembered by the next.
    resetWindowsAclStateForTests()
    const { tmpdir } = await import('node:os')
    // One home PER case, still: `readDeviceSettings` caches by PATH for 5 s, so a
    // reused home would read the previous case's document — the same trap
    // `tests/doctor-device-json.spec.ts:26-31` records for the device settings.
    home = await realFs.mkdtemp(join(tmpdir(), 'wb-199-doctor-'))
    vault = join(home, 'workbuddy-vault')
    isolateInto(home)
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    restorePlatform = () => {
      if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor)
    }
  })

  afterEach(async () => {
    restorePlatform?.()
    restorePlatform = undefined
    for (const [key, value] of Object.entries(fileEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    // Handed to `afterAll` rather than deleted here: the device-salt create is not
    // awaited by anything in the run, so a `rm` issued in the same tick as `run()`
    // returning raced it. Four of the seven cases failed that way in the run that
    // surfaced this; the sweep below is the mitigation, and the isolation above is kept
    // because it is the repo's rule for a `doctor` test (`vitest.config.ts:13-36`), not
    // because it was measured to be the cause — see `afterAll`.
    if (home !== '') homes.push(home)
    home = ''
  })

  /**
   * Homes are removed ONCE, at the end of the file — the fix for a real flake, not
   * tidiness.
   *
   * WHAT WAS MEASURED, in order:
   *
   *   - per-case `rm` failed in FOUR of the seven cases under the full suite, and the
   *     same file passed when run alone. The surviving entries were
   *     `.workbuddy-device.json` in two failures and its `.lock` in the other two —
   *     never anything from `workbuddy-vault/`. A leftover `.lock` says the create
   *     sequence was still in flight, which is consistent with the un-awaited
   *     `resolveWireIdentity()` above and with the writer lock's non-awaited unlink.
   *   - `ENOTEMPTY` from `rm -r` means an entry appeared DURING the walk. That is a
   *     race, and a race is not proven by one reproduction: a later full run with the
   *     isolation deliberately BROKEN (only `DSH_HOME` pointed, five variables unset —
   *     the original shape) PASSED all 181 files. So "the ambient credentials made this
   *     fail" was never established, and the isolation is not what fixed the flake.
   *   - since the sweep went in, EVERY full run of this suite has passed — including
   *     two at the #199 commit checked out into a scratch worktree to confirm the
   *     history bisects. Those two read 2988 passed + 2 skipped against 2994 at the tip,
   *     and the 6-test difference is not a loss: 4 cases belong to `context-tiers` and
   *     land in the NEXT commit, and the 2 skips are `host-peers`' `skipIf(!built)` — a
   *     fresh worktree carries no `lib/`. `2994 − 4 − 2 = 2988` is the arithmetic that
   *     says the commit split is clean. Correlation, not proof: the sweep is kept
   *     because deleting a tree WHILE an un-awaited create can still land in it is
   *     structurally unsafe on Windows whatever caused this particular round, and the
   *     bounded retries cover the residual transient-handle class `docs/WINDOWS.md` §1-4
   *     registers for settings writes. A failure stays LOUD: an undeletable tree is the
   *     symptom this round cost time on, and swallowing it would hide it.
   */
  afterAll(async () => {
    for (const dir of homes) {
      await realFs
        .rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        .catch((error: unknown) => {
          console.warn(`[issue199 doctor spec] could not remove ${dir}: ${String(error)}`)
        })
    }
    homes.length = 0
  })

  it('warns when the hardening FAILED, not only when it exposed', async () => {
    // The `failed` branch: `icacls` refused, so the plaintext tokens carry whatever
    // the folder inherited — on the reporter's `~/.dsh`, `Everyone: FullControl`.
    // #183 recorded this in the JSON body and gave the user nothing to act on.
    failing.add('icacls')
    const report = await doctorJson()
    const cn = aclEntry(report, 'cn')
    expect(typeof cn['protectError']).toBe('string')
    expect(vaultHints(report)).toMatch(/could NOT be hardened/iu)
  })

  it('warns when the ACL could not be read back, and never calls it protected', async () => {
    // The state a LOCKED directory answers with: reading a DACL needs `READ_CONTROL`,
    // which the lockout removed. Honest about not knowing — and now also loud.
    failing.add('powershell')
    const report = await doctorJson()
    const cn = aclEntry(report, 'cn')
    expect(cn['state']).toBe('unverified')
    expect(cn['reason']).toBeDefined()
    expect(vaultHints(report)).toMatch(/could not be read back/iu)
  })

  it('reports the owner and says plainly when it is not the running account', async () => {
    // Defect 1's forensic fact, now a field the reporter does not have to derive
    // over four angles: `OWNER RIGHTS` resolves to the owner, so on Administrators
    // the grant set names principals the daily-use account is not a member of.
    aclStdout = restrictedAcl(ADMIN_SID, USER_SID)
    const report = await doctorJson()
    const cn = aclEntry(report, 'cn')
    expect(cn['owner']).toBe(ADMIN_SID)
    expect(cn['ownerIsCurrentUser']).toBe(false)
    expect(cn['principal']).toBe(USER_SID)
    // A foreign owner ALONE raises no vault hint. This build grants the user's own
    // SID beside the owner rights, so that machine WORKS, and the issue documents
    // eight legacy foreign-owned folders under one DSH home — warning on sight would
    // make the hint noise on most real machines. The verdict is still in the JSON.
    expect(vaultHints(report)).toBe('')
  })

  it('pairs takeown advice with a foreign owner once something IS broken', async () => {
    // The combination that locked the reporter out: foreign owner AND a hardening
    // that cannot take. Ownership must be repaired FIRST — re-running the hardening
    // is the command that did the damage — so the ORDER of the two hints is the
    // thing this pins, not merely their presence.
    aclStdout = `OWNER ${ADMIN_SID}`
    failing.add('icacls')
    const report = await doctorJson()
    const cn = aclEntry(report, 'cn')
    expect(cn['owner']).toBe(ADMIN_SID)
    expect(cn['ownerIsCurrentUser']).toBe(false)
    const text = vaultHints(report)
    expect(text).toMatch(/OWNED BY/iu)
    expect(text).toMatch(/takeown/iu)
    expect(text.indexOf('OWNED BY')).toBeLessThan(text.indexOf('could NOT be hardened'))
  })

  it('records an unlistable vault as vaultError and corrects the wrong advice', async () => {
    // Defect 2 on the CLI side. The runtime SWALLOWS this error so account discovery
    // survives, which is right for a chat turn and left `doctor` as the only place
    // the fact could be said at all.
    // The REGION directory, which is what `doctor` lists — the vault ROOT is what it
    // hardens, and a root that cannot be LISTED while the region reads fine is a
    // different (and impossible) pair. Naming the exact path here is also what keeps
    // the global region's hint out of this case: only `cn` is refused.
    refuseListingOf = join(vault, 'cn')
    const report = await doctorJson()
    const cn = aclEntry(report, 'cn')
    expect(String(cn['vaultError'])).toMatch(/EPERM/u)
    const text = vaultHints(report)
    expect(text).toMatch(/could not be LISTED/iu)
    expect(text).toMatch(/no longer exists/iu)
  })

  it('keeps the exposed warning and spells the user grant in its fix command', async () => {
    // The #183 branch must still fire — widening the allow-list must not quietly stop
    // catching the ACE that issue was filed about — and the hand-fix it prints has to
    // be the command THIS build considers correct: owner rights AND the current user.
    aclStdout = [`OWNER ${USER_SID}`, 'S-1-3-4', 'S-1-5-18', ADMIN_SID, 'S-1-1-0', USER_SID].join('\r\n')
    const report = await doctorJson()
    const cn = aclEntry(report, 'cn')
    expect(cn['state']).toBe('exposed')
    expect(cn['unexpected']).toEqual(['S-1-1-0'])
    const text = vaultHints(report)
    expect(text).toMatch(/do not restrict them/iu)
    expect(text).toContain(`*${USER_SID}:(OI)(CI)(F)`)
  })

  it('hardens exactly the two region directories and nothing else in the vault', async () => {
    // The deterministic shape `doctor` produces on a machine with no account: the vault
    // tree it was asked to harden, and no credential it had no business writing.
    //
    // NOT asserted here, deliberately, is what else the home contains. This case's first
    // draft said "nothing besides the vault tree" and went red at once, because the run
    // DOES create `$DSH_HOME/.workbuddy-device.json` even with zero accounts:
    // `doctor` constructs two `WorkBuddyUpstreamClient`s before its salt branch runs,
    // and the constructor starts `resolveWireIdentity()` as a promise NOBODY AWAITED
    // (`src/upstream.ts:4076`), which takes `ensureDeviceSalt()` — a CREATE. Measured
    // with only a client constructed in an empty home: absent at 0 ms, present by
    // ~800 ms. Three `doctor` runs each reported `salt.state: 'ok'`, and `'ok'` is only
    // reachable by reading a file that is already there (`absent` is the ENOENT answer),
    // so in those runs the create did precede doctor's own read. Whether it can ALSO
    // land after that read — report `absent`, file appears moments later — was not
    // measured; instrumenting it needs the fs module itself. So this pins only the
    // observed half: an unattended machine gains a device-identity file from a
    // diagnostic command. Registered, not fixed, in the CHANGELOG, and NOT asserted
    // here: pinning "the file exists" would go red when someone fixes it, and pinning
    // `salt.state` would write the winner of a race into a test.
    //
    // What the create IS relied on for is the cleanup: the `.lock` file that survived in
    // two of the four original failures is the measurement that its unlink is still in
    // flight after `run()` returns — which is what broke a per-case `rm`. See `afterAll`.
    aclStdout = restrictedAcl(USER_SID, USER_SID)
    const report = await doctorJson()
    expect(aclEntry(report, 'cn')['state']).toBe('protected')
    expect(await realFs.readdir(join(home, 'workbuddy-vault'))).toEqual(['cn', 'global'])
    // And the vault really is empty of credentials: an unattended machine must not gain
    // account files from a diagnostic run, whatever else it writes.
    expect(await realFs.readdir(join(home, 'workbuddy-vault', 'cn'))).toEqual([])
  })

  it('raises no vault hint for a directory that is restricted and readable', async () => {
    // The regression guard on everything above: a healthy Windows machine gets silence
    // about its ACL, because four new always-on hints would train users to ignore
    // hints — including the one that will save them.
    aclStdout = restrictedAcl(USER_SID, USER_SID)
    const report = await doctorJson()
    const cn = aclEntry(report, 'cn')
    expect(cn['state']).toBe('protected')
    expect(cn['ownerIsCurrentUser']).toBe(true)
    expect(cn['vaultError']).toBeUndefined()
    expect(cn['protectError']).toBeUndefined()
    expect(vaultHints(report)).toBe('')
  })
})
