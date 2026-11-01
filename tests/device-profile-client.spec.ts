import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchDeviceSettings,
  isDeviceId,
  putDeviceMode,
  randomDeviceId,
  realTierAvailable,
} from '../src/client/device-profile.ts'

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
 * 平台不是设置：它只是让卡片能在挑档位的地方说「macOS 上真实值档取不到
 * token」。一个 Host 没带这个字段（旧版本）时，卡片必须退化成不解释，而
 * 不是把 undefined 渲染成平台名。
 */
describe('platform passthrough', () => {
  const stubAnswer = (body: unknown): void => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
  }

  it('keeps the platform the Host reports', async () => {
    stubAnswer({ enabled: true, mode: 'real', accounts: {}, sdkDir: '', sdkFallbackToVirtual: true, platform: 'darwin' })
    const settings = await fetchDeviceSettings('/device-profile')
    expect(settings?.platform).toBe('darwin')
  })

  it('leaves platform undefined when the Host does not send one', async () => {
    stubAnswer({ enabled: true, mode: 'virtual', accounts: {}, sdkDir: '', sdkFallbackToVirtual: true })
    const settings = await fetchDeviceSettings('/device-profile')
    expect(settings?.platform).toBeUndefined()
  })
})

/**
 * 卡片与 Host 必须对"这台机器有没有真实值档"给出同一个答案：Host 决定发不发，
 * 卡片决定画不画那个选项。两处一旦分叉，用户就会看到一个能点、点了却没效果的档。
 */
describe('realTierAvailable', () => {
  it('agrees with the Host rule: only win32', () => {
    expect(realTierAvailable('win32')).toBe(true)
    expect(realTierAvailable('darwin')).toBe(false)
    expect(realTierAvailable('linux')).toBe(false)
  })

  it('treats a Host that does not report a platform as capable', () => {
    // 旧 Host 不送 platform：宁可在它上面多画一个档，也不要把功能藏掉。
    expect(realTierAvailable(undefined)).toBe(true)
  })
})
