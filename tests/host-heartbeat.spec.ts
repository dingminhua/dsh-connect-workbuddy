import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  HOST_START_REFERENCE_TOLERANCE_MS,
  LEGACY_REFERENCE_TOLERANCE_MS,
  PROCESS_PROBE_OPTIONS,
  isHeartbeatProcessAlive,
  processStartProbe,
  processStartTimeMs,
  type WorkBuddyHostHeartbeat,
} from '../src/host-heartbeat.ts'

function heartbeat(overrides: Partial<WorkBuddyHostHeartbeat>): WorkBuddyHostHeartbeat {
  return {
    version: 2,
    package: 'dsh-connect-workbuddy',
    pluginVersion: 'test',
    registeredAt: Date.now(),
    pid: process.pid,
    ...overrides,
  }
}

describe('processStartProbe', () => {
  /**
   * Windows-only spawn defects cannot be reproduced on the macOS development
   * machine (docs/WINDOWS.md §0: not "unreproduced" but "impossible to
   * reproduce"), so they are pinned as DATA instead: the platform branch and
   * the spawn options are asserted directly, and both run on any host.
   */
  it('probes Windows through PowerShell and POSIX through ps', () => {
    const win = processStartProbe(4321, 'win32')
    expect(win.file).toBe('powershell')
    expect(win.args).toContain('-NoProfile')
    expect(win.args.join(' ')).toContain('Get-Process -Id 4321')

    const posix = processStartProbe(4321, 'linux')
    expect(posix.file).toBe('ps')
    expect(posix.args).toContain('lstart=')
    expect(processStartProbe(4321, 'darwin').file).toBe('ps')
  })

  it('hides the console window, because the host is a GUI process with none', () => {
    // THE regression guard. On Windows a console-program child gets a NEW,
    // VISIBLE console window whenever its parent has none — and the parent
    // here is the Electron Desktop host (`MainWindowHandle = 0`, verified on
    // the live host). Verified on real Windows 11 by starting a console-less
    // parent through the WMI service and having the child report the console it
    // owns: without `windowsHide` it received `NEW-console hwnd=… visible=True`,
    // with it `no-console`.
    //
    // Without this assertion the defect is INVISIBLE on macOS — `windowsHide`
    // is ignored there — so nothing in the suite would notice its removal.
    expect(PROCESS_PROBE_OPTIONS.windowsHide).toBe(true)

    // The sibling call site in `src/at-rest.ts` sets the same option for the
    // same reason. Keeping the two in step is the point: one of them was fixed
    // and this one was not, which is how the flash survived.
    const atRest = readFileSync(
      fileURLToPath(new URL('../src/at-rest.ts', import.meta.url)),
      'utf8',
    )
    if (!atRest.includes('windowsHide')) {
      throw new Error('src/at-rest.ts lost its windowsHide: the two spawn sites are meant to agree')
    }
  })
})

describe('processStartTimeMs', () => {
  it('resolves the current process start time on the host platform', () => {
    // POSIX reads `ps -o lstart=`; Windows answers via PowerShell
    // Get-Process StartTime. Either must yield a finite epoch-ms value.
    const startedAt = processStartTimeMs(process.pid)
    expect(typeof startedAt).toBe('number')
    expect(Number.isFinite(startedAt as number)).toBe(true)
    expect(startedAt as number).toBeGreaterThan(0)
  })

  it('returns undefined for an unqueryable pid instead of throwing', () => {
    // A pid that cannot exist keeps the caller on the graceful path.
    expect(processStartTimeMs(2_147_483_647)).toBeUndefined()
  })
})

describe('isHeartbeatProcessAlive', () => {
  it('reports a matching current-process heartbeat as alive', () => {
    const startedAt = processStartTimeMs(process.pid) ?? Date.now()
    // Registered at process start (within the 60s skew allowance).
    expect(isHeartbeatProcessAlive(heartbeat({ registeredAt: startedAt }))).toBe(true)
  })

  it('reports an absent pid as dead', () => {
    expect(isHeartbeatProcessAlive(heartbeat({ pid: 2_147_483_647 }))).toBe(false)
  })

  it('rejects a pid that is not a positive integer', () => {
    expect(isHeartbeatProcessAlive(heartbeat({ pid: 0 }))).toBe(false)
    expect(isHeartbeatProcessAlive(heartbeat({ pid: Number.NaN }))).toBe(false)
  })

  /**
   * ISSUE #174: the reference used to be `registeredAt`, the moment the plugin
   * WROTE the heartbeat — and it was compared with a 60-second window against
   * the PROCESS start time. Those are different quantities: the gap is however
   * long the host took to boot and mount the plugin. The reporter measured
   * 684,817 ms on Windows 11 (process 19:47:20, heartbeat 19:58:45) and got
   * `hostBundle: "stale"` from a host that had just written the file.
   *
   * The test that existed was no defence, because it SET `registeredAt` to the
   * process start time — i.e. it asserted the bug's premise. The cases below
   * use the real shape: a process that has been up for an hour and a heartbeat
   * written just now.
   */
  it('reports a long-running host as ALIVE (the #174 regression)', () => {
    const startedAt = processStartTimeMs(process.pid)
    if (startedAt === undefined) return // platform cannot answer; the other paths cover it
    // This process has been up for the duration of the test run and the
    // heartbeat was written a moment ago — the shape the reporter measured, at
    // a smaller scale. `hostStartedAt` is the TRUE start time (so it agrees with
    // `ps`/PowerShell); `registeredAt` is NOW. The old rule compared `ps` with
    // `registeredAt`, so the same values answered FALSE.
    expect(isHeartbeatProcessAlive(heartbeat({
      hostStartedAt: startedAt,
      registeredAt: Date.now(),
    }))).toBe(true)

    // And the shape that specifically reproduced it: a boot-to-mount gap LARGER
    // than the 60-second window the old rule allowed. Simulated by claiming the
    // host started 11 minutes before "now", which is what the reporter measured
    // (19:47:20 → 19:58:45). `processStartTimeMs` is not consulted for this
    // assertion — the point is the REFERENCE, so the heartbeat's own two fields
    // are set to the two extremes and the comparison is against the live start.
    expect(isHeartbeatProcessAlive(heartbeat({
      hostStartedAt: startedAt,
      registeredAt: startedAt + 11 * 60_000,
    }))).toBe(true)
  })

  it('compares hostStartedAt with the process start time, not with registeredAt', () => {
    const startedAt = processStartTimeMs(process.pid)
    if (startedAt === undefined) return
    // `hostStartedAt` agrees; `registeredAt` is wildly different. Alive.
    expect(isHeartbeatProcessAlive(heartbeat({
      hostStartedAt: startedAt,
      registeredAt: startedAt - 86_400_000,
    }))).toBe(true)
    // Now the reverse: `registeredAt` agrees but `hostStartedAt` does not, i.e.
    // the PID was REUSED by a different process. The precise reference must win.
    expect(isHeartbeatProcessAlive(heartbeat({
      hostStartedAt: startedAt - 86_400_000,
      registeredAt: startedAt,
    }))).toBe(false)
  })

  it('keeps reading a version-1 heartbeat, with the wider legacy tolerance', async () => {
    // A heartbeat written by a build before #174 carries no `hostStartedAt`.
    // Refusing to read it would make the first `doctor` after an upgrade report
    // "no heartbeat at all" — a worse diagnosis than the imprecise comparison.
    const startedAt = processStartTimeMs(process.pid)
    if (startedAt === undefined) return
    // Within the legacy window: alive (the old code would have called this dead
    // once the host had been up for more than a minute before the plugin mounted).
    expect(isHeartbeatProcessAlive(heartbeat({
      registeredAt: startedAt + 30 * 60_000,
    }))).toBe(true)
    // Outside it: still recognised as a reused PID.
    expect(isHeartbeatProcessAlive(heartbeat({
      registeredAt: startedAt + LEGACY_REFERENCE_TOLERANCE_MS * 2,
    }))).toBe(false)
  })

  it('uses a tolerance that is not the 60-second window that caused the false stale', () => {
    // Guards the CONSTANT, not just the behaviour: the value is the fix. 60s is
    // smaller than any plausible host boot-to-plugin-mount gap on a real
    // machine, and the reporter measured one at ~11 minutes.
    expect(HOST_START_REFERENCE_TOLERANCE_MS).toBeGreaterThanOrEqual(60_000)
    expect(LEGACY_REFERENCE_TOLERANCE_MS).toBeGreaterThan(HOST_START_REFERENCE_TOLERANCE_MS)
  })
})