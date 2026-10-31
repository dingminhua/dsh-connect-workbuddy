import { describe, expect, it } from 'vitest'
import { describeDeviceState } from '../src/device-state.ts'
import type { DeviceSaltReadout } from '../src/device-salt.ts'
import type { DeviceTokenReadout } from '../src/device-token.ts'
import type { TuringSdkInfo, TuringTokenReadout } from '../src/turing-sdk.ts'
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

describe('describeDeviceState — the external token (P2)', () => {
  const tokenOk = (): DeviceTokenReadout => ({
    path: '/tmp/device-token',
    state: 'ok',
    token: 'v3:abc',
    ageMs: 42_000,
  })

  it('reports the token header when the file resolved', () => {
    const report = describeDeviceState([credentialOf('u-1')], saltOk(), tokenOk())
    expect(report.onWire).toContain('X-Device-Token')
    expect(report.token?.state).toBe('ok')
    expect(report.token?.ageMs).toBe(42_000)
  })

  it('separates "not inspected" from "configured but unreadable"', () => {
    // `doctor` cannot see the plugin config, so an unset env var means "not
    // inspected" — a different answer from "I looked and it was broken".
    const notInspected = describeDeviceState([credentialOf('u-1')], saltOk())
    expect(notInspected.token).toBeUndefined()

    const broken = describeDeviceState([credentialOf('u-1')], saltOk(), {
      path: '/tmp/device-token',
      state: 'too-large',
      reason: '9000 bytes exceeds the 4096-byte limit',
    })
    expect(broken.token?.state).toBe('too-large')
    expect(broken.token?.reason).toContain('4096')
    expect(broken.onWire).not.toContain('X-Device-Token')
  })

  it('never puts the token itself in the report', () => {
    const report = describeDeviceState([credentialOf('u-1')], saltOk(), tokenOk())
    expect(JSON.stringify(report)).not.toContain('v3:abc')
  })
})

describe('describeDeviceState — the real tier (P3)', () => {
  const sdkInfo = (): TuringSdkInfo => ({
    state: 'ready',
    bundle: 'win32-x64',
    path: '/app/native/turing-sdk/win32-x64',
    platform: 'win32',
    arch: 'x64',
    runtime: '22.22.2',
  })
  const tokenOk = (): TuringTokenReadout => ({
    state: 'ok',
    masked: 'v3:****************',
    length: 1174,
    fetchedAtMs: Date.now() - 5_000,
  })

  it('reports the tier so one header has one explanation', () => {
    expect(describeDeviceState([credentialOf('u-1')], saltOk()).tier).toBe('virtual')
    const real = describeDeviceState([credentialOf('u-1')], saltOk(), undefined, {
      tier: 'real', sdk: sdkInfo(), token: tokenOk(), value: 'v3:real',
    })
    expect(real.tier).toBe('real')
    expect(real.onWire).toEqual(['X-Device-Token'])
  })

  it('drops derived devices entirely — there is nothing per account to derive', () => {
    // A derived count here would read as "3 accounts → 3 devices", which is the
    // opposite of what this tier does.
    const real = describeDeviceState(['u-1', 'u-2'].map(credentialOf), saltOk(), undefined, {
      tier: 'real', sdk: sdkInfo(), token: tokenOk(), value: 'v3:real',
    })
    expect(real.derived).toBeUndefined()
  })

  it('reports no device header when the SDK has no token', () => {
    const real = describeDeviceState([credentialOf('u-1')], saltOk(), undefined, {
      tier: 'real', sdk: sdkInfo(), token: { state: 'idle', masked: '', length: 0 },
    })
    expect(real.onWire).toEqual([])
  })

  it('never puts the real token in the report', () => {
    const real = describeDeviceState([credentialOf('u-1')], saltOk(), undefined, {
      tier: 'real', sdk: sdkInfo(), token: tokenOk(), value: 'v3:real',
    })
    expect(JSON.stringify(real)).not.toContain('v3:real')
    expect(real.sdk?.token.length).toBe(1174)
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
