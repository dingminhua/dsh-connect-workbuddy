import { describe, expect, it } from 'vitest'
import {
  isHeartbeatProcessAlive,
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