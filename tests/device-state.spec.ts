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

  // 作者意见 #2：取不到真 token 时退回虚拟值。报告必须答**实际发出的**那一档，
  // 否则 `tier` 说 real、`onWire` 说派生对，两个字段互相打脸。
  describe('falling back to the virtual device', () => {
    const noToken = (): TuringTokenReadout => ({ state: 'unavailable', masked: '', length: 0, reason: 'sdk load-failed' })

    it('sends the derived pair and says so when the switch is on', () => {
      const report = describeDeviceState([credentialOf('u-1')], saltOk(), undefined, {
        tier: 'real', sdk: sdkInfo(), token: noToken(), fallbackToVirtual: true,
      })
      // 用户的意愿仍是 real……
      expect(report.tier).toBe('real')
      // ……但实际发的是虚拟值，且报告把这件事写出来。
      expect(report.tierSent).toBe('virtual')
      expect(report.fallbackToVirtual).toBe(true)
      expect(report.onWire).toEqual(['X-Machine-ID', 'X-Session-ID'])
      // 派生块必须出现：那一档实际发的是派生对。
      expect(report.derived?.accounts).toBe(1)
    })

    it('sends nothing when the switch is off, and keeps the report honest', () => {
      const report = describeDeviceState([credentialOf('u-1')], saltOk(), undefined, {
        tier: 'real', sdk: sdkInfo(), token: noToken(), fallbackToVirtual: false,
      })
      expect(report.onWire).toEqual([])
      expect(report.tierSent).toBeUndefined()
      expect(report.fallbackToVirtual).toBeUndefined()
      expect(report.derived).toBeUndefined()
    })

    it('does not fall back while a real token is available', () => {
      // 开关开着但 token 好好的：不该退回。退回只在"取不到"时发生。
      const report = describeDeviceState([credentialOf('u-1')], saltOk(), undefined, {
        tier: 'real', sdk: sdkInfo(), token: tokenOk(), value: 'v3:real', fallbackToVirtual: true,
      })
      expect(report.tierSent).toBeUndefined()
      expect(report.onWire).toEqual(['X-Device-Token'])
    })

    it('is unreachable in the virtual tier — that tier has nothing to fall back from', () => {
      const report = describeDeviceState([credentialOf('u-1')], saltOk(), undefined, {
        tier: 'virtual', sdk: sdkInfo(), token: noToken(), fallbackToVirtual: true,
      })
      expect(report.tierSent).toBeUndefined()
      expect(report.fallbackToVirtual).toBeUndefined()
      expect(report.onWire).toEqual(['X-Machine-ID', 'X-Session-ID'])
    })
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

/**
 * 总开关（用户意见）：这个功能整体要能关掉。
 *
 * 关着时报告只多做一件事——把「为什么线上什么都没有」说清楚。`onWire: []`
 * 在旧版本里只可能是"盐坏了"或"真实值档取不到 token"，这里出现第三种原因，
 * 所以必须有 `enabled: false` 把它区分出来。
 */
describe('describeDeviceState — the master switch (用户意见)', () => {
  const sdkInfo = (): TuringSdkInfo => ({
    state: 'ready',
    bundle: 'darwin-arm64',
    path: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/native/turing-sdk',
    platform: 'darwin',
    arch: 'arm64',
    runtime: '22.22.2',
  })
  const tokenOk = (): TuringTokenReadout => ({ state: 'ok', masked: 'v3:****', length: 1174, fetchedAtMs: 1_000 })

  it('sends nothing and says so, in the virtual tier', () => {
    const report = describeDeviceState([credentialOf('u-1')], saltOk(), undefined, {
      tier: 'virtual', enabled: false,
    })
    expect(report.enabled).toBe(false)
    expect(report.onWire).toEqual([])
    // 派生块也一起消失：那一对 id 根本不会上线，列出来只会让人以为它在发。
    expect(report.derived).toBeUndefined()
    // 盐的状态仍然照实报：它是"重新打开之后还要不要重新识别这台机器"的前提。
    expect(report.salt.state).toBe('ok')
  })

  it('sends nothing in the real tier either, and reports no SDK block (off = not probed)', () => {
    // doctor 关着时连 probe 都不起，于是传给这里的只有档位与开关本身。
    const report = describeDeviceState([credentialOf('u-1')], saltOk(), undefined, {
      tier: 'real', enabled: false,
    })
    expect(report.enabled).toBe(false)
    expect(report.onWire).toEqual([])
    expect(report.sdk).toBeUndefined()
    expect(report.derived).toBeUndefined()
  })

  it('still reports a token readout it was given — the data, not the probe, is what is missing', () => {
    // 读数是可选的（关着时没有），但给了就该照实显示：报告的责任是说出它知道
    // 的事实，而不是替调用方猜"这一步该不该看"。
    const report = describeDeviceState([credentialOf('u-1')], saltOk(), undefined, {
      tier: 'real', enabled: false, sdk: sdkInfo(), token: tokenOk(),
    })
    expect(report.sdk?.state).toBe('ready')
    expect(report.sdk?.token.length).toBe(1174)
    expect(report.onWire).toEqual([])
  })

  it('omits the field entirely when the switch is on — only the off state is worth a field', () => {
    const report = describeDeviceState([credentialOf('u-1')], saltOk())
    expect(report.enabled).toBeUndefined()
    expect(report.onWire).toEqual(['X-Machine-ID', 'X-Session-ID'])
  })
})
