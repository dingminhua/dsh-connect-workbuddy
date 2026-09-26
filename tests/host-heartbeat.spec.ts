import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PROCESS_PROBE_OPTIONS,
  isHeartbeatProcessAlive,
  processStartProbe,
  processStartTimeMs,
  type WorkBuddyHostHeartbeat,
} from '../src/host-heartbeat.ts'

function heartbeat(overrides: Partial<WorkBuddyHostHeartbeat>): WorkBuddyHostHeartbeat {
  return {
    version: 1,
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
})