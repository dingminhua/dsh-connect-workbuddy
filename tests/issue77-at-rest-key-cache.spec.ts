/**
 * Issue #77, second round: a page open must not re-run the at-rest key
 * discovery once per credential file.
 *
 * THE REPORT. Version 4.9.3 shipped `detail=fast` (no upstream calls on the
 * first paint) and the reporter still waited 60 s, on 4.9.4 and on 4.10 alike.
 * Their CPU profile showed where the time went: 15.3 s of a 19.1 s request
 * inside `spawnSync`, from ~135 synchronous `reg query` child processes —
 * `findWorkbuddyAppExecutable()` was reached 45 times per request, three
 * uninstall hives each time.
 *
 * WHY. `readAtRestKey()` remembered only a SUCCESS. On a machine whose auth
 * files carry `$wbEncrypted` fields but where the desktop app cannot be found,
 * every probe re-ran the whole discovery. `scanAll()` probes file by file and
 * one page open reads repeatedly, so the cost multiplied by both factors. The
 * shared-scan window (`SCAN_SHARE_WINDOW_MS` in src/auth.ts) was measured from
 * the scan's START time, so a scan slower than the window was already stale
 * when it finished and never served the reads that followed it.
 *
 * HOW THIS IS TESTED WITHOUT A WINDOWS MACHINE. The expensive branch is
 * guarded by `process.platform === 'win32'`, and the module under test reads
 * `process.platform` directly (`readAtRestKey()` takes no parameters, and the
 * store's default resolves to it). The platform is therefore shadowed on
 * `process` for the duration of each test, so the Windows branch runs HERE,
 * with the registry probe mocked. Overriding `process.platform` on the module
 * namespace does NOT work — the namespace is a getter over the real `process`,
 * which is why this file patches the `process` object instead.
 *
 * `execFileSync` is mocked at the module boundary so the registry probe is
 * counted where the production code calls it. There is no `reg` on the
 * machines the suite runs on, and a test must not depend on what the host
 * happens to have registered anyway.
 *
 * WHAT IS PINNED — by counting CALLS, never by timing prose:
 *   1. A failed key lookup is remembered: repeated probes run NO discovery.
 *   2. Every read that follows the first is free of registry probes, for a
 *      usage-shaped sequence over 5 encrypted auth files (`files x reads x 3`
 *      before the fix).
 *   3. A store write still forces a FRESH scan — the finish-time window must
 *      not make the account list lie after a sign-in.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Every `reg.exe` invocation, as its argv. */
const registryCalls: string[][] = []

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: (file: string, args: readonly string[], options?: unknown) => {
      if (file !== 'reg') {
        return (actual.execFileSync as (...a: unknown[]) => unknown)(file, args, options)
      }
      registryCalls.push([...args])
      // `reg` exits non-zero when nothing matches — the expected answer on a
      // machine without a registered WorkBuddy, which is the reported machine.
      throw Object.assign(new Error('reg: no matches'), { status: 1 })
    },
  }
})

const ENCRYPTED_KEY_ID = '9127dea1b44020a7'

/**
 * One encrypted field wrapper.
 *
 * The real shape is `{$wbEncrypted: 1, envelope: <base64>}` — `$wbEncrypted`
 * is the marker and `envelope` is a string, NOT a nested object. (A nested
 * object is silently treated as "not encrypted", which reads as "this file has
 * no token" and sends the whole test down the wrong path.) The envelope never
 * has to OPEN here: the scenario under test is that no key can be obtained.
 */
function sealToken(token: string): object {
  return {
    $wbEncrypted: 1,
    envelope: `${ENCRYPTED_KEY_ID}.${Buffer.from(token, 'utf8').toString('base64')}`,
  }
}

describe('issue #77: the at-rest key lookup is not repeated per file', () => {
  let root: string
  let authDir: string
  let vaultDir: string
  let restorePlatform: (() => void) | undefined
  let realNow: (() => number) | undefined

  /**
   * Run as Windows for the rest of the test: the registry fallback is the
   * branch the report measured, and it is the only one that shells out.
   * `LOCALAPPDATA` points at an absent directory so no candidate is found on
   * the host, whatever the host is.
   */
  function actAsWindows(): void {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    restorePlatform = () => {
      if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor)
    }
  }

  /**
   * Move the clock past a TTL without leaving fake timers armed: `Date.now` is
   * patched for the length of one call, so real awaits and fs work keep
   * behaving normally.
   */
  async function later<T>(offsetMs: number, run: () => Promise<T>): Promise<T> {
    realNow ??= Date.now
    const current = realNow()
    Date.now = () => current + offsetMs
    try {
      return await run()
    } finally {
      Date.now = realNow
    }
  }

  beforeEach(async () => {
    registryCalls.length = 0
    root = await mkdtemp(join(tmpdir(), 'wb-issue77-'))
    authDir = join(root, 'auth')
    vaultDir = join(root, 'vault')
    await mkdir(authDir, { recursive: true })
    await mkdir(vaultDir, { recursive: true })
  })

  afterEach(async () => {
    restorePlatform?.()
    restorePlatform = undefined
    if (realNow !== undefined) Date.now = realNow
    realNow = undefined
    await rm(root, { recursive: true, force: true })
  })

  /**
   * One desktop auth file whose token fields are encrypted.
   *
   * The names matter: the scan probes the LIVE file (`workbuddy-desktop.info`)
   * and then its `.info` siblings, so a set of same-prefixed names without the
   * live one would be read as candidates but never as the live copy.
   */
  async function writeEncrypted(uid: string): Promise<void> {
    const name = uid === 'A' ? 'workbuddy-desktop.info' : `workbuddy-desktop-${uid}.info`
    await writeFile(join(authDir, name), JSON.stringify({
      auth: {
        accessToken: sealToken(`tok-${uid}`),
        refreshToken: sealToken(`ref-${uid}`),
        expiresAt: Date.now() + 3_600_000,
        domain: 'www.codebuddy.cn',
      },
      account: { uid, uin: `100${uid}`, nickname: `User ${uid}` },
    }))
  }

  /** A desktop auth file the plugin can read WITHOUT any key. */
  async function writePlain(uid: string): Promise<void> {
    const name = uid === 'A' ? 'workbuddy-desktop.info' : `workbuddy-desktop-${uid}.info`
    await writeFile(join(authDir, name), JSON.stringify({
      auth: {
        accessToken: `tok-${uid}`,
        refreshToken: `ref-${uid}`,
        expiresAt: Date.now() + 3_600_000,
        domain: 'www.codebuddy.cn',
      },
      account: { uid, uin: `100${uid}`, nickname: `User ${uid}` },
    }))
  }

  it('remembers a failed lookup instead of re-running the discovery per probe', async () => {
    actAsWindows()
    const { clearAtRestKeyCache, readAtRestKey } = await import('../src/at-rest.ts')
    clearAtRestKeyCache()
    registryCalls.length = 0
    // No desktop app anywhere: the discovery falls through to the registry,
    // which has nothing to match. This is the reported machine's state.
    const first = await readAtRestKey()
    // THE PRECONDITION, ASSERTED RATHER THAN ASSUMED.
    //
    // This used to be `if (first !== undefined) return` — a silent early exit
    // for a host that has WorkBuddy installed. It read as "not applicable
    // here", but the reporter shows up as a PASS, so a machine where the
    // precondition failed reported success while running NONE of the
    // assertions below. That is how a test stops being evidence without
    // anybody noticing.
    //
    // It is now a real assertion: `vitest.config.ts`'s `isolatedEnv` pins
    // `ProgramFiles` / `ProgramFiles(x86)` / `WORKBUDDY_APP_EXECUTABLE` into
    // the synthetic home, so every exact-path candidate the win32 branch
    // generates points at a directory that cannot exist, and the mocked `reg`
    // below throws for every query. A REAL key here therefore means one of
    // those seams broke, and the test says so instead of quietly skipping.
    //
    // WHAT THIS DOES **NOT** PROVE, measured rather than assumed: CI cannot
    // show that the isolation is what makes it pass. GitHub's `windows-latest`
    // image has no WorkBuddy installed (`C:\Program Files` is real there, but
    // none of the probed subdirectories exist), so the exact-path candidates
    // miss with or without the pin — deleting those five lines leaves this
    // suite green. The pin's value is that a DEVELOPER machine which does have
    // the app now reports a failure instead of a false pass; on CI the two
    // configurations are indistinguishable. Anyone re-checking this should
    // verify it on a machine with WorkBuddy installed, not on a runner.
    expect(first, 'the at-rest key lookup must find nothing under the isolated env').toBeUndefined()
    const afterFirst = registryCalls.length
    // One discovery = one pass over the three uninstall hives, and no more.
    expect(afterFirst).toBe(3)

    // Repeated probes, as `scanAll()` makes for every encrypted file. Before
    // the fix each one paid the full pass again (5 files = 15 spawns per scan).
    expect(await readAtRestKey()).toBeUndefined()
    expect(await readAtRestKey()).toBeUndefined()
    expect(registryCalls.length).toBe(afterFirst)

    // The negative cache EXPIRES rather than pinning the process forever: a
    // user who installs the app must not have to restart to be seen.
    await later(61_000, async () => {
      expect(await readAtRestKey()).toBeUndefined()
    })
    expect(registryCalls.length).toBeGreaterThan(afterFirst)
  })

  it('costs one discovery for a usage-shaped read cycle over 5 encrypted files', async () => {
    actAsWindows()
    const { clearAtRestKeyCache } = await import('../src/at-rest.ts')
    const { WorkBuddyCredentialStore } = await import('../src/auth.ts')
    clearAtRestKeyCache()
    for (const uid of ['A', 'B', 'C', 'D', 'E']) await writeEncrypted(uid)
    registryCalls.length = 0

    // No `resolveAtRestKey` override: this is the store's REAL default, which
    // is the code path that was slow.
    const store = new WorkBuddyCredentialStore({
      refresh: async credential => credential,
      region: 'cn',
      authDirs: [authDir],
      vaultDir,
    })
    await store.accounts()
    // The scan RAN — it did not come back from a cached failure.
    expect(registryCalls.length).toBe(3)
    // The account list, the sign-in state and the current credential — what
    // the card's first paint asks. Before the fix the encrypted files each
    // re-ran the discovery, so this was `5 x 3 = 15` per scan and dozens per
    // page open (135 spawns measured in the report).
    await store.status()
    await store.current()
    await store.accounts()
    expect(registryCalls.length).toBe(3)
  })

  it('keeps a write-then-read cycle honest: the next scan is fresh', async () => {
    const { clearAtRestKeyCache } = await import('../src/at-rest.ts')
    const { WorkBuddyCredentialStore } = await import('../src/auth.ts')
    clearAtRestKeyCache()
    await writePlain('A')
    const store = new WorkBuddyCredentialStore({
      refresh: async credential => credential,
      region: 'cn',
      authDirs: [authDir],
      vaultDir,
    })
    expect((await store.accounts()).map(a => a.accountName)).toEqual(['User A'])
    // A sign-in that lands behind the plugin's back is picked up by an explicit
    // re-detection: the finish-time window is a sharing window, never a TTL
    // that could show a stale list (see `invalidateScan`).
    await writePlain('B')
    await store.clearDismissals()
    const names = (await store.accounts()).map(a => a.accountName).sort()
    expect(names).toEqual(['User A', 'User B'])
  })
})
