import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDeviceSettings, isDeviceId, putDeviceMode, randomDeviceId } from '../src/client/device-profile.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * 「一键随机」造出来的值会被原样写进 `X-Machine-ID` / `X-Session-ID`，所以形状
 * 必须与 Host 侧的校验、以及上游看到的那 36 位完全一致——一个 35 位或带大写的
 * 随机值，用户会在保存时才被打回来。
 */
describe('randomDeviceId', () => {
  it('is 36 lowercase hex characters', () => {
    const id = randomDeviceId()
    expect(id).toHaveLength(36)
    expect(id).toMatch(/^[0-9a-f]{36}$/u)
    expect(isDeviceId(id)).toBe(true)
  })

  it('does not repeat itself across draws', () => {
    // 18 bytes of entropy per draw; a repeat inside 200 draws would mean the
    // generator is not reading fresh randomness (e.g. a seeded or cached buffer).
    const draws = new Set(Array.from({ length: 200 }, () => randomDeviceId()))
    expect(draws.size).toBe(200)
  })
})

describe('isDeviceId', () => {
  it('matches the Host rule exactly', () => {
    expect(isDeviceId('0'.repeat(36))).toBe(true)
    expect(isDeviceId('A'.repeat(36))).toBe(false)
    expect(isDeviceId('0'.repeat(35))).toBe(false)
    expect(isDeviceId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe(false)
    expect(isDeviceId('')).toBe(false)
  })
})

/**
 * Host 送来的派生值。
 *
 * 弹窗把这一对 id 直接画在输入框下面，所以形状必须逐条校验：混进一个
 * `undefined` 就会在界面上显示成 "undefined"，比不显示更糟——用户会以为
 * 那真是将要发出去的设备标识。
 */
describe('derived values from the Host', () => {
  const PATH = '/plugins/dsh-connect-workbuddy/device-profile'
  const MACHINE = 'a'.repeat(36)
  const SESSION = 'b'.repeat(36)

  function answer(body: unknown): void {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    }))
  }

  it('keeps a well-formed pair per account', async () => {
    answer({ mode: 'virtual', accounts: {}, derived: { a1: { machineId: MACHINE, sessionId: SESSION } } })
    const settings = await fetchDeviceSettings(PATH)
    expect(settings?.derived?.['a1']).toEqual({ machineId: MACHINE, sessionId: SESSION })
  })

  it('drops an entry that is not two device ids', async () => {
    answer({
      mode: 'virtual',
      accounts: {},
      derived: {
        good: { machineId: MACHINE, sessionId: SESSION },
        short: { machineId: 'abc', sessionId: SESSION },
        empty: { machineId: '', sessionId: '' },
        missing: { machineId: MACHINE },
      },
    })
    const settings = await fetchDeviceSettings(PATH)
    expect(Object.keys(settings?.derived ?? {})).toEqual(['good'])
  })

  it('leaves the block absent when the Host did not compute it', async () => {
    // 老 Host 或本机没有设备盐：`derived` 必须缺席，而不是变成 {}——界面对
    // "没算" 与 "算了但没有" 说不同的话。
    answer({ mode: 'virtual', accounts: {} })
    const settings = await fetchDeviceSettings(PATH)
    expect(settings?.derived).toBeUndefined()
  })

  it('carries derived through a POST answer', async () => {
    answer({ mode: 'real', accounts: {}, derived: { a1: { machineId: MACHINE, sessionId: SESSION } } })
    const settings = await putDeviceMode(PATH, 'real')
    expect(settings.mode).toBe('real')
    expect(settings.derived?.['a1']?.machineId).toBe(MACHINE)
  })
})

/**
 * 「真实值」可用性（`realTier`）：由 Host 判定，界面只照做。
 *
 * 关键取舍是**缺席不能等于禁用**：一个读不到这一项的旧 Host 上，「真实值」可能真的
 * 能用，凭空禁掉它等于替用户取消一个功能。
 */
describe('the Real tier availability', () => {
  const PATH = '/plugins/dsh-connect-workbuddy/device-profile'

  function answer(body: unknown): void {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => body }))
  }

  it('carries the Host verdict through', async () => {
    answer({ mode: 'virtual', accounts: {}, sdkDir: '', sdkFallbackToVirtual: true, realTier: { state: 'broken', platform: 'darwin' } })
    const settings = await fetchDeviceSettings(PATH)
    expect(settings?.realTier).toEqual({ state: 'broken', platform: 'darwin' })
  })

  it('stays absent when the Host does not send it — so an old Host never disables anything', async () => {
    answer({ mode: 'virtual', accounts: {}, sdkDir: '', sdkFallbackToVirtual: true })
    const settings = await fetchDeviceSettings(PATH)
    expect(settings?.realTier).toBeUndefined()
  })

  it('rejects an unknown state rather than guessing one', async () => {
    // 把不认识的字符串猜成 available 会让一个真坏掉的平台看起来能用；猜成 broken
    // 又会凭空禁掉一个能用的。两种都不如"没这一项"。
    answer({ mode: 'virtual', accounts: {}, sdkDir: '', sdkFallbackToVirtual: true, realTier: { state: 'maybe', platform: 'linux' } })
    const settings = await fetchDeviceSettings(PATH)
    expect(settings?.realTier).toBeUndefined()
  })

  it('accepts available on Windows', async () => {
    answer({ mode: 'virtual', accounts: {}, sdkDir: '', sdkFallbackToVirtual: true, realTier: { state: 'available', platform: 'win32' } })
    const settings = await fetchDeviceSettings(PATH)
    expect(settings?.realTier?.state).toBe('available')
  })
})
