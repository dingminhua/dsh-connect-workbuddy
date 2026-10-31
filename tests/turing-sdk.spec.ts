/**
 * `src/turing-sdk.ts` — 真实设备 token 的取链。
 *
 * ## 为什么用一个假 worker
 *
 * 真实链路要连 SDK、要发网络请求、要等 DNS。这三件事都不该进单元测试。这个模块
 * 的**可测部分**恰好全在"拿到答案之后"：缓存、TTL、宽限期、失败兜底、掩码——它们
 * 才是会悄悄出错的地方（一个每次都重取的实现看起来也"能用"）。
 *
 * 所以 `createTuringSdk({ worker })` 允许换掉子进程脚本，测试用一个只读写 JSON 的
 * 假 worker 精确控制"这次成功 / 这次失败 / 这次给了什么值"。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TURING_KEEP_ALIVE_TIMING,
  bundledSdkBundleId,
  createTuringSdk,
  maskToken,
  nextAutoRefreshDelayMs,
} from '../src/turing-sdk.ts'

/** 假 worker：读同目录的 `state.json`，每次调用把 `calls` 加一。 */
const FAKE_WORKER = `'use strict'
const fs = require('node:fs')
const path = require('node:path')
const file = path.join(__dirname, 'state.json')
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
state.calls = (state.calls || 0) + 1
fs.writeFileSync(file, JSON.stringify(state))
const mode = process.argv[2]
if (mode === 'probe') {
  process.stdout.write(JSON.stringify({ ok: true, supported: state.supported !== false, node: '22.22.2', platform: 'win32', arch: 'x64' }) + '\\n')
} else if (state.ok === false) {
  process.stdout.write(JSON.stringify({ ok: false, reason: 'fetch-failed', message: state.message || 'boom' }) + '\\n')
} else {
  process.stdout.write(JSON.stringify({ ok: true, token: state.token || 'v3:real-token-value' }) + '\\n')
}
`

let root: string
let sdkDir: string
let worker: string
let statePath: string
let clock: number

/** Write the fake worker's control document. */
async function setState(state: Record<string, unknown>): Promise<void> {
  await writeFile(statePath, JSON.stringify(state), 'utf8')
}

async function readCalls(): Promise<number> {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as { calls?: number }
  return state.calls ?? 0
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'turing-sdk-'))
  sdkDir = join(root, 'win32-x64')
  // probe 前的存在性检查看的是 `build/Release`：没有它就连子进程都不起，
  // 所以假目录必须造出这个形状，否则测的就不是"取 token"而是"提前返回"。
  await mkdir(join(sdkDir, 'build', 'Release'), { recursive: true })
  worker = join(root, 'worker.cjs')
  await writeFile(worker, FAKE_WORKER, 'utf8')
  statePath = join(root, 'state.json')
  clock = 1_000_000
  await setState({ token: 'v3:real-token-value' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const make = (overrides: { ttlMs?: number } = {}) => createTuringSdk({
  dir: sdkDir,
  worker,
  now: () => clock,
  ...overrides,
})

describe('maskToken', () => {
  it('keeps the scheme prefix and hides every other character', () => {
    expect(maskToken('v3:abcdefghijklmnop')).toBe('v3:****************')
  })

  it('hides the whole value when there is no recognisable prefix', () => {
    expect(maskToken('bare-token')).toBe('****************')
  })

  it('returns empty for an empty token rather than a row of stars', () => {
    // 空值不是"隐藏起来的值"，是"没有值"。两者在界面上要长得不一样。
    expect(maskToken('')).toBe('')
  })
})

describe('bundledSdkBundleId', () => {
  it('names the directory after platform and arch', () => {
    expect(bundledSdkBundleId('win32', 'x64')).toBe('win32-x64')
    expect(bundledSdkBundleId('darwin', 'arm64')).toBe('darwin-arm64')
  })
})

describe('probe', () => {
  it('reports missing without spawning anything when the bundle is absent', async () => {
    const sdk = createTuringSdk({ dir: join(root, 'nope'), worker, now: () => clock })
    const info = await sdk.info()
    expect(info.state).toBe('missing')
    expect(info.reason).toContain('no bundled SDK')
    // 没有 SDK 就**不该**起子进程：那是排障命令里最容易变成"卡三秒"的一段。
    expect(await readCalls()).toBe(0)
  })

  it('reports ready when the SDK loads and claims support', async () => {
    const info = await make().info()
    expect(info.state).toBe('ready')
    expect(info.bundle).toBe('win32-x64')
    expect(info.runtime).toBe('22.22.2')
  })

  it('reports unsupported with the SDK\'s own load error', async () => {
    await setState({ supported: false })
    const info = await make().info()
    expect(info.state).toBe('unsupported')
    expect(info.reason).toBeDefined()
  })

  it('caches the probe so the status route does not spawn per request', async () => {
    const sdk = make()
    await sdk.info()
    await sdk.info()
    expect(await readCalls()).toBe(1)
  })
})

describe('token source', () => {
  it('returns the token and reports it as ok', async () => {
    const sdk = make()
    expect(await sdk.tokens.current()).toBe('v3:real-token-value')
    const readout = sdk.tokens.readout()
    expect(readout.state).toBe('ok')
    expect(readout.length).toBe('v3:real-token-value'.length)
    expect(readout.fetchedAtMs).toBe(clock)
  })

  it('serves the cached token without spawning again inside the TTL', async () => {
    const sdk = make({ ttlMs: 60_000 })
    await sdk.tokens.current()
    clock += 59_000
    await sdk.tokens.current()
    // 一次 probe + 一次 token；第二次命中缓存完全不该起进程。
    expect(await readCalls()).toBe(2)
  })

  it('refetches once the TTL has passed', async () => {
    const sdk = make({ ttlMs: 60_000 })
    await sdk.tokens.current()
    clock += 61_000
    await sdk.tokens.current()
    expect(await readCalls()).toBe(4)
  })

  it('shares one child process between concurrent callers', async () => {
    const sdk = make()
    const [a, b, c] = await Promise.all([sdk.tokens.current(), sdk.tokens.current(), sdk.tokens.current()])
    expect(a).toBe(b)
    expect(b).toBe(c)
    // probe 一次 + token 一次，而不是三份。
    expect(await readCalls()).toBe(2)
  })

  it('never puts the token in the readout', async () => {
    const sdk = make()
    await sdk.tokens.current()
    expect(JSON.stringify(sdk.tokens.readout())).not.toContain('real-token-value')
    expect(sdk.tokens.readout().masked).toBe('v3:****************')
  })

  it('serves the previous token as stale when a refetch fails', async () => {
    const sdk = make({ ttlMs: 60_000 })
    await sdk.tokens.current()
    await setState({ ok: false, message: 'network down' })
    clock += 61_000
    // 过期了但取不到新的：宽限期内仍然返回旧值，否则一次网络抖动就等于"设备消失"。
    expect(await sdk.tokens.current()).toBe('v3:real-token-value')
    expect(sdk.tokens.readout().state).toBe('stale')
    expect(sdk.tokens.readout().reason).toBe('network down')
  })

  it('returns undefined when there has never been a token', async () => {
    await setState({ ok: false, message: 'first fetch failed' })
    const sdk = make()
    expect(await sdk.tokens.current()).toBeUndefined()
    expect(sdk.tokens.readout().state).toBe('idle')
    expect(sdk.tokens.readout().length).toBe(0)
  })

  it('gives up on a token older than the stale window', async () => {
    const sdk = make({ ttlMs: 60_000 })
    await sdk.tokens.current()
    await setState({ ok: false, message: 'gone' })
    clock += 25 * 60 * 60 * 1000
    expect(await sdk.tokens.current()).toBeUndefined()
    expect(sdk.tokens.readout().state).toBe('unavailable')
  })

  it('keeps the old token when an explicit refresh fails', async () => {
    const sdk = make()
    await sdk.tokens.current()
    await setState({ ok: false, message: 'refresh failed' })
    const after = await sdk.tokens.refresh()
    // 用户点「重新获取」是想拿到新的，不是想丢掉手上这枚还能用的。
    expect(after.state).toBe('stale')
    expect(after.length).toBe('v3:real-token-value'.length)
  })

  it('stops spawning for a while after a failure', async () => {
    // 一轮对话会并发打出十几条请求。没有退避，一次 SDK 故障就是十几个子进程加
    // 十几个超时——那不是"取不到 token"，那是把插件拖垮。
    await setState({ ok: false, message: 'boom' })
    const sdk = make()
    await sdk.tokens.current()
    const afterFirst = await readCalls()
    await sdk.tokens.current()
    clock += 1_000
    await Promise.all([sdk.tokens.current(), sdk.tokens.current()])
    expect(await readCalls()).toBe(afterFirst)
  })

  it('lets an explicit refresh bypass the backoff', async () => {
    await setState({ ok: false, message: 'boom' })
    const sdk = make()
    await sdk.tokens.current()
    const afterFirst = await readCalls()
    // 用户点那个按钮，就是要求"现在再试一次"。
    await sdk.tokens.refresh()
    expect(await readCalls()).toBeGreaterThan(afterFirst)
  })
})

/**
 * 自动预热。
 *
 * 这条需求来自使用现场：每次重启后「SDK」分区都显示"已加载、没取过"，因为
 * `current()` 只在**请求要发出去**时才被调用，而一个空闲的进程从来不发请求。
 * 于是"SDK 正常工作"和"SDK 根本没跑"在界面上长得一模一样。
 *
 * 调度本身是纯函数，先把它钉死；再看真实链路是否真的会自己动手。
 */
describe('nextAutoRefreshDelayMs', () => {
  const ttlMs = 600_000

  it('wakes just before the token expires, not on the expiry tick', () => {
    expect(nextAutoRefreshDelayMs({ nowMs: 0, ttlMs, fetchedAtMs: 0 }))
      .toBe(ttlMs - TURING_KEEP_ALIVE_TIMING.leadMs)
  })

  it('never schedules a zero-delay spin', () => {
    const at = ttlMs - 1
    expect(nextAutoRefreshDelayMs({ nowMs: at, ttlMs, fetchedAtMs: 0 }))
      .toBe(TURING_KEEP_ALIVE_TIMING.minDelayMs)
  })

  it('retries a minute later when the last refresh failed', () => {
    // 取到了但随后失败（例如手动刷新失败）：不能等到下次到期才发现。
    expect(nextAutoRefreshDelayMs({ nowMs: 10, ttlMs, fetchedAtMs: 0, lastFailureAtMs: 5 }))
      .toBe(TURING_KEEP_ALIVE_TIMING.retryMs)
  })

  it('does not poll something this machine does not have', () => {
    // SDK 不会在运行期凭空出现；五分钟问一次足够，每分钟问一次只是脏日志。
    expect(nextAutoRefreshDelayMs({ nowMs: 0, ttlMs, sdkState: 'missing' }))
      .toBe(TURING_KEEP_ALIVE_TIMING.unavailableMs)
    expect(nextAutoRefreshDelayMs({ nowMs: 0, ttlMs, sdkState: 'error' }))
      .toBe(TURING_KEEP_ALIVE_TIMING.unavailableMs)
    // 没结论时按"可能取得到"处理：启动那一下必须真的去试。
    expect(nextAutoRefreshDelayMs({ nowMs: 0, ttlMs, sdkState: 'ready' }))
      .toBe(TURING_KEEP_ALIVE_TIMING.retryMs)
    expect(nextAutoRefreshDelayMs({ nowMs: 0, ttlMs }))
      .toBe(TURING_KEEP_ALIVE_TIMING.retryMs)
  })
})

describe('自动预热（auto refresh）', () => {
  it('fetches as soon as it starts — no request needed', async () => {
    const sdk = make()
    // 这就是用户看到的那一格：启动后、任何请求之前，状态必须是 idle。
    expect(sdk.tokens.readout().state).toBe('idle')
    sdk.startAutoRefresh()
    await vi.waitFor(() => {
      expect(sdk.tokens.readout().state).toBe('ok')
    }, { timeout: 10_000 })
    sdk.stopAutoRefresh()
    // probe + token 各一次子进程：证明它是真的去取了，而不是把 idle 改了个名字。
    expect(await readCalls()).toBeGreaterThanOrEqual(2)
  })

  it('refreshes itself when the token expires', async () => {
    // 用真实时钟 + 压缩过的 TTL：这条测的正是"到期后没人问也会换新"。
    const sdk = createTuringSdk({
      dir: sdkDir,
      worker,
      ttlMs: 250,
      keepAliveTiming: { leadMs: 0, minDelayMs: 40, retryMs: 40 },
    })
    sdk.startAutoRefresh()
    try {
      await vi.waitFor(() => {
        expect(sdk.tokens.readout().state).toBe('ok')
      }, { timeout: 10_000 })
      const first = sdk.tokens.readout().fetchedAtMs
      const callsAtFirst = await readCalls()
      await vi.waitFor(async () => {
        expect(await readCalls()).toBeGreaterThan(callsAtFirst)
      }, { timeout: 10_000 })
      // 不只是"又跑了一次"，而是这一枚 token 确实被换成了新的。
      expect(sdk.tokens.readout().fetchedAtMs).toBeGreaterThan(first ?? 0)
    } finally {
      sdk.stopAutoRefresh()
    }
  })

  it('stops when told to', async () => {
    const sdk = createTuringSdk({
      dir: sdkDir,
      worker,
      ttlMs: 200,
      keepAliveTiming: { leadMs: 0, minDelayMs: 30, retryMs: 30 },
    })
    sdk.startAutoRefresh()
    await vi.waitFor(() => {
      expect(sdk.tokens.readout().state).toBe('ok')
    }, { timeout: 10_000 })
    sdk.stopAutoRefresh()
    const calls = await readCalls()
    await new Promise(resolve => setTimeout(resolve, 500))
    // 插件卸载后还留着一条定时链，就是一个永远关不掉的子进程工厂。
    expect(await readCalls()).toBe(calls)
  })

  it('is idempotent: starting twice keeps one chain', async () => {
    const sdk = make()
    sdk.startAutoRefresh()
    sdk.startAutoRefresh()
    await vi.waitFor(() => {
      expect(sdk.tokens.readout().state).toBe('ok')
    }, { timeout: 10_000 })
    const calls = await readCalls()
    await new Promise(resolve => setTimeout(resolve, 300))
    // 第二次 start 不是"再取一次"：它看到同一个 inFlight（或一个还算新鲜的
    // token）就什么都不做。真要出问题的是定时器——两条链会让间隔悄悄减半，
    // 那要跑十分钟才看得出来，所以这里只钉"不会立刻重复取数"。
    expect(await readCalls()).toBe(calls)
    sdk.stopAutoRefresh()
  })
})
