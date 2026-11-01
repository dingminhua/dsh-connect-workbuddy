/**
 * 总开关关着时，请求路径上**一个设备头都不发**——并且**不在磁盘上留下任何东西**。
 *
 * 后半句是这条用例真正的理由。开关的文案说「这一族功能整体停摆」，而 `upstream.ts`
 * 的请求路径原来会在构造时无条件 `ensureDeviceSalt()`：关掉之后第一次聊天仍然会
 * 写出 `$DSH_HOME/.workbuddy-device.json`。那不只是一个多余的文件——那枚盐正是
 * "这台机器是谁"的指纹，用户明确关掉的恰恰是它。所以这里钉住两件事：
 *
 *   1. 关着：发出去的头里没有 `X-Machine-ID` / `X-Session-ID` / `X-Device-Token`，
 *      而且盐文件根本没有被创建；
 *   2. 打开后：下一次请求就能用上（来得及，不用重启）——盐这时才落盘。
 */

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyDeviceProfileLookup } from '../src/device-profile.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

const SALT_FILE = '.workbuddy-device.json'

function credential(): WorkBuddyCredential {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs: 0,
    domain: 'www.workbuddy.cn',
    uid: 'u-1',
    source: 'desktop',
    filePath: '/tmp/workbuddy-desktop.info',
  }
}

/** A lookup whose only interesting field is the master switch. */
function lookup(state: { enabled: boolean }): WorkBuddyDeviceProfileLookup {
  return {
    forUid: async () => undefined,
    mode: async () => 'virtual',
    fallbackToVirtual: async () => true,
    sdkDir: async () => '',
    enabled: async () => state.enabled,
  }
}

describe('the device-identity master switch on the request path', () => {
  let home = ''
  let previous: string | undefined
  let headers: Record<string, string>[] = []

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-device-switch-'))
    previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = home
    headers = []
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      headers.push(init.headers)
      return { ok: true, status: 200, headers: { get: () => null } }
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
    await rm(home, { recursive: true, force: true })
  })

  it('sends no device header and writes no salt while it is off', async () => {
    const state = { enabled: false }
    const client = new WorkBuddyUpstreamClient(undefined, {}, { deviceProfiles: lookup(state) })
    const answer = await client.probeChat(credential(), '{}')
    expect(answer.ok).toBe(true)
    expect(headers).toHaveLength(1)
    for (const name of ['X-Machine-ID', 'X-Session-ID', 'X-Device-Token']) {
      expect(headers[0]?.[name]).toBeUndefined()
    }
    // 关着 ⇒ 不建盐。这一条是这条用例的来由：请求路径曾在构造时无条件建盐。
    await expect(stat(join(home, SALT_FILE))).rejects.toThrow()
  })

  it('starts using the salt on the next request once it is switched on, without a reload', async () => {
    const state = { enabled: false }
    const client = new WorkBuddyUpstreamClient(undefined, {}, { deviceProfiles: lookup(state) })
    await client.probeChat(credential(), '{}')
    await expect(stat(join(home, SALT_FILE))).rejects.toThrow()

    // 用户在卡片上打开开关：同一个 client，下一次请求就该带上派生对。
    state.enabled = true
    await client.probeChat(credential(), '{}')
    expect(headers[1]?.['X-Machine-ID']).toMatch(/^[0-9a-f]{36}$/u)
    expect(headers[1]?.['X-Session-ID']).toMatch(/^[0-9a-f]{36}$/u)
    // 打开之后盐才真正落盘——它是"要用的人才有一枚"的东西。
    expect((await stat(join(home, SALT_FILE))).isFile()).toBe(true)

    // 再关回去：立即恢复"什么都不发"，且不再新增文件。
    state.enabled = false
    await client.probeChat(credential(), '{}')
    expect(headers[2]?.['X-Machine-ID']).toBeUndefined()
  })
})
