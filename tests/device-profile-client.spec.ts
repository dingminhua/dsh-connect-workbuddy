import { describe, expect, it } from 'vitest'
import { isDeviceId, randomDeviceId } from '../src/client/device-profile.ts'

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
