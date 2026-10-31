import { describe, expect, it } from 'vitest'
import { describeDeviceState } from '../src/device-state.ts'
import type { DeviceSaltReadout } from '../src/device-salt.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

/**
 * `describeDeviceState` is a pure composition: the salt readout is injected, so
 * these tests touch no filesystem and cannot be affected by another test's
 * `$DSH_HOME`.
 */

const SALT = 'a'.repeat(64)

const saltOk = (): DeviceSaltReadout => ({ path: '/tmp/.workbuddy-device.json', state: 'ok', salt: SALT })
const saltAbsent = (): DeviceSaltReadout => ({ path: '/tmp/.workbuddy-device.json', state: 'absent' })
const saltUnreadable = (): DeviceSaltReadout => ({
  path: '/tmp/.workbuddy-device.json',
  state: 'unreadable',
  reason: 'version 99 is not readable by this build',
})

/** Only `uid` participates in derivation; the rest is realistic filler. */
function credentialOf(uid: string): WorkBuddyCredential {
  return {
    accessToken: 'access-token-fixture',
    refreshToken: 'refresh-token-fixture',
    expiresAtMs: 0,
    domain: 'www.codebuddy.cn',
    uid,
    source: 'desktop',
    filePath: `/tmp/${uid}.info`,
  }
}

describe('describeDeviceState — what is on the wire', () => {
  it('reports the derived pair once a salt exists (P1)', () => {
    // Before P1 this was an empty array: the plugin attached no device identity
    // at all. It is computed by running the real header builders, so it flips
    // with the code rather than with a written-down expectation.
    const report = describeDeviceState([credentialOf('u-1')], saltOk())
    expect(report.onWire).toEqual(['X-Machine-ID', 'X-Session-ID'])
  })

  it('reports nothing when the salt is absent or unreadable', () => {
    expect(describeDeviceState([credentialOf('u-1')], saltAbsent()).onWire).toEqual([])
    expect(describeDeviceState([credentialOf('u-1')], saltUnreadable()).onWire).toEqual([])
  })

  it('never reports a device token — that is the P2/P3 tier', () => {
    expect(describeDeviceState([credentialOf('u-1')], saltOk()).onWire).not.toContain('X-Device-Token')
  })
})

describe('describeDeviceState — the derived tier', () => {
  it('gives every account its own virtual device', () => {
    // The audit's §5.4 question: does a pool collapse into ONE device?
    const report = describeDeviceState(['u-1', 'u-2', 'u-3'].map(credentialOf), saltOk())
    expect(report.derived?.accounts).toBe(3)
    expect(report.derived?.distinct).toBe(3)
  })

  it('counts duplicate uid once — two credential files are still one account', () => {
    const report = describeDeviceState(['u-1', 'u-1'].map(credentialOf), saltOk())
    expect(report.derived?.accounts).toBe(1)
    expect(report.derived?.distinct).toBe(1)
  })

  it('is stable across calls — the id must survive a restart', () => {
    const first = describeDeviceState([credentialOf('u-1')], saltOk())
    const second = describeDeviceState([credentialOf('u-1')], saltOk())
    expect(second.derived?.sample).toEqual(first.derived?.sample)
  })

  it('never puts the salt in the report', () => {
    const report = describeDeviceState([credentialOf('u-1')], saltOk())
    expect(JSON.stringify(report)).not.toContain(SALT)
  })
})

describe('describeDeviceState — the states it must keep distinct', () => {
  it('reports no accounts without pretending the salt is the problem', () => {
    const report = describeDeviceState([], saltOk())
    expect(report.derived).toBeUndefined()
    expect(report.salt.state).toBe('ok')
    expect(report.onWire).toEqual([])
  })

  it('carries the salt reason through, so a broken file is diagnosable', () => {
    const report = describeDeviceState([credentialOf('u-1')], saltUnreadable())
    expect(report.salt.state).toBe('unreadable')
    expect(report.salt.reason).toContain('version 99')
    expect(report.derived).toBeUndefined()
  })

  it('shows the absent state as absent, not as an empty salt', () => {
    const report = describeDeviceState([credentialOf('u-1')], saltAbsent())
    expect(report.salt.state).toBe('absent')
    expect('reason' in report.salt).toBe(false)
  })
})
