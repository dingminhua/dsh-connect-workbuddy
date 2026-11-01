import { describe, expect, it } from 'vitest'
import { realTierAvailabilityFor } from '../src/index.ts'

/**
 * 「真实值」档在哪能真的工作。
 *
 * 这条判定存在的理由不是"平台差异有美感"，而是 macOS 上那套 SDK 会
 * `dispatch_sync` 到 dispatch 主队列，而纯 libuv 子进程永不排空它（`sample` 栈实测，
 * 见 CHANGELOG 的「macOS 现状如实记录」）。于是 mac 上 probe 答 `ready`、token 却
 * 永远取不到——界面上是一个能点、点了只会降级回虚拟值的选项。
 *
 * 把它抽成纯函数是为了能被测：写死成模块级常量的话，唯一的验证方式是在 macOS 上
 * 跑一遍整个插件。
 */
describe('realTierAvailabilityFor', () => {
  it('marks macOS broken — the SDK cannot hand out a token there', () => {
    expect(realTierAvailabilityFor('darwin')).toEqual({ state: 'broken', platform: 'darwin' })
  })

  it('leaves Windows available — the binding does not use the dispatch main queue', () => {
    expect(realTierAvailabilityFor('win32')).toEqual({ state: 'available', platform: 'win32' })
  })

  it('does not claim breakage it cannot prove — an unknown platform stays available', () => {
    // 判据只有"已知坏掉的 darwin"。默认当成 broken 会让一个从未被验证过的平台被
    // 无端禁掉，那比让用户自己发现取不到更糟：后者至少还能排障。
    expect(realTierAvailabilityFor('linux')).toEqual({ state: 'available', platform: 'linux' })
    expect(realTierAvailabilityFor('freebsd')).toEqual({ state: 'available', platform: 'freebsd' })
  })

  it('carries the platform through so the UI can explain WHICH platform', () => {
    // 「用不了」这条说明必须能指名道姓：只说"本平台不支持"会让人以为是插件的问题。
    expect(realTierAvailabilityFor('darwin').platform).toBe('darwin')
  })
})
