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
import { join, posix, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TURING_KEEP_ALIVE_TIMING,
  bundledSdkBundleId,
  createTuringSdk,
  discoverInstalledSdkDir,
  hasTuringSdkBinding,
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
  // probe 前的门检查的是 `build/Release/turing_sdk.node`：没有它连子进程都不起，
  // 所以假目录必须造出这个形状，否则测的就不是"取 token"而是"提前返回"。
  await mkdir(join(sdkDir, 'build', 'Release'), { recursive: true })
  await writeFile(join(sdkDir, 'build', 'Release', 'turing_sdk.node'), '', 'utf8')
  worker = join(root, 'worker.cjs')
  await writeFile(worker, FAKE_WORKER, 'utf8')
  statePath = join(root, 'state.json')
  clock = 1_000_000
  await setState({ token: 'v3:real-token-value' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// `platform`/`arch` 注入与假 worker 的 probe 输出（win32/x64）保持一致：`bundle`
// 在生产路径取真实主机，但断言不能钉住跑测试的机器（RELEASING.md §2.5）。
// 不注入时这条套件在 Linux/macOS CI 上会因为 `darwin-arm64 !== win32-x64` 而红。
const make = (overrides: { ttlMs?: number } = {}) => createTuringSdk({
  dir: sdkDir,
  worker,
  now: () => clock,
  platform: 'win32',
  arch: 'x64',
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

describe('discoverInstalledSdkDir', () => {
  // 平台、家目录、环境、exists 全部注入：这套断言在三种 CI 主机上必须给出
  // 同样的答案（RELEASING.md §2.5），而真实的主机——比如装着 WorkBuddy 的
  // 开发 mac——恰恰是最不该参与的路径。
  const winExe = 'C:\\Users\\dev\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe'
  const winSdk = 'C:\\Users\\dev\\AppData\\Local\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\native\\turing-sdk'
  const macExe = '/Applications/WorkBuddy.app/Contents/MacOS/Electron'
  const macSdk = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/native/turing-sdk'

  const tree = (files: string[]) => (path: string): boolean => files.includes(path)

  it('finds the unpacked SDK next to a Windows install', () => {
    const found = discoverInstalledSdkDir({
      platform: 'win32',
      home: 'C:\\Users\\dev',
      env: { WORKBUDDY_APP_EXECUTABLE: winExe, LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
      exists: tree([winExe, `${winSdk}\\build\\Release\\turing_sdk.node`]),
      readRegistryAppPath: () => undefined,
    })
    expect(found).toBe(winSdk)
  })

  it('falls back to the uninstall registry when the default layout missed', () => {
    // issue #68 的形状：装在非默认盘。没有这一步，装着也等于没装。
    const found = discoverInstalledSdkDir({
      platform: 'win32',
      home: 'C:\\Users\\dev',
      env: { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
      exists: tree(['E:\\Apps\\WorkBuddy\\WorkBuddy.exe',
        'E:\\Apps\\WorkBuddy\\resources\\app.asar.unpacked\\native\\turing-sdk\\build\\Release\\turing_sdk.node']),
      readRegistryAppPath: () => 'E:\\Apps\\WorkBuddy\\WorkBuddy.exe',
    })
    expect(found).toBe('E:\\Apps\\WorkBuddy\\resources\\app.asar.unpacked\\native\\turing-sdk')
  })

  it('never reads the registry on a non-Windows host', () => {
    let registryReads = 0
    const found = discoverInstalledSdkDir({
      platform: 'darwin',
      home: '/Users/dev',
      env: {},
      exists: tree([]),
      readRegistryAppPath: () => { registryReads += 1; return undefined },
    })
    expect(found).toBeUndefined()
    expect(registryReads).toBe(0)
  })

  it('finds the unpacked SDK inside a macOS bundle (exe may be named Electron)', () => {
    // CFBundleExecutable 是 `Electron`（两份真实 bundle 实测如此），推导只能
    // 走 Contents 的层级，不能从 exe 名倒推 bundle 名。
    const found = discoverInstalledSdkDir({
      platform: 'darwin',
      home: '/Users/dev',
      env: { WORKBUDDY_APP_EXECUTABLE: macExe },
      exists: tree([macExe, `${macSdk}/build/Release/turing_sdk.node`]),
    })
    expect(found).toBe(macSdk)
  })

  it('skips an install whose unpacked SDK has no binding', () => {
    // 装了桌面端但解包不完整（或被安全软件动了）：跳过，别拿一个加载不了的目录
    // 去起子进程——那是 `missing` 和 `error` 分家的意义。
    const found = discoverInstalledSdkDir({
      platform: 'win32',
      home: 'C:\\Users\\dev',
      env: { WORKBUDDY_APP_EXECUTABLE: winExe },
      exists: tree([winExe, `${winSdk}\\build\\Release\\TuringShieldSDK.dll`]),
    })
    expect(found).toBeUndefined()
  })

  it('skips a candidate executable that does not exist', () => {
    const found = discoverInstalledSdkDir({
      platform: 'win32',
      home: 'C:\\Users\\dev',
      env: { WORKBUDDY_APP_EXECUTABLE: winExe },
      // binding 在，exe 不在：环境变量指着一条死路，不该信。
      exists: tree([`${winSdk}\\build\\Release\\turing_sdk.node`]),
    })
    expect(found).toBeUndefined()
  })

  it('exposes the binding gate as a platform-aware helper', () => {
    // 数据平台优先（win32 → `\` 拼法），再兜底**另一种**拼法——Windows API 两种
    // 分隔符都吃，而注入 platform 的测试喂的可能是宿主形状的目录。
    const parts = ['build', 'Release', 'turing_sdk.node'] as const
    expect(hasTuringSdkBinding('C:\\x', path => path === win32.join('C:\\x', ...parts), 'win32')).toBe(true)
    expect(hasTuringSdkBinding('C:\\x', path => path === posix.join('C:\\x', ...parts), 'win32')).toBe(true)
    expect(hasTuringSdkBinding('C:\\x', () => false, 'win32')).toBe(false)
    expect(hasTuringSdkBinding('/x', () => true, 'win32')).toBe(true)
  })

  // 两个方向都断言，不是凑数：兜底曾经写成「宿主的 join」而不是「另一种拼法」，
  // 而这两种写法**只在宿主与数据同平台时**才分岔。于是只测 win32 一个方向时，
  // 它在 macOS 上是绿的（宿主 posix ≠ 数据 win32，兜底真跑起来了）、在 Windows 上
  // 却是红的（宿主 win32 = 数据 win32，兜底被短路）。两个方向一起测，这个分岔
  // 在任意宿主上都会红——这正是 RELEASING.md §2.5 要的形态。
  it('answers the same way whichever platform the test host runs on', () => {
    const parts = ['build', 'Release', 'turing_sdk.node'] as const
    // 反向：数据是 POSIX，喂 Windows 形状的目录也必须认。
    expect(hasTuringSdkBinding('/x', path => path === posix.join('/x', ...parts), 'linux')).toBe(true)
    expect(hasTuringSdkBinding('/x', path => path === win32.join('/x', ...parts), 'linux')).toBe(true)
    expect(hasTuringSdkBinding('/x', () => false, 'linux')).toBe(false)
  })

  it('createTuringSdk uses discovery when neither dir nor env named one', () => {
    // 端到端缝：发现链的产物要真的进到 probe 的 spawn 目录里。假 worker 只认
    // state.json，不关心 dir——所以这里看的是 info().path。
    const sdk = createTuringSdk({
      worker,
      now: () => clock,
      platform: 'win32',
      arch: 'x64',
      home: 'C:\\Users\\dev',
      env: { WORKBUDDY_APP_EXECUTABLE: winExe },
      exists: tree([winExe, `${winSdk}\\build\\Release\\turing_sdk.node`]),
    })
    return sdk.info().then(info => {
      expect(info.path).toBe(winSdk)
      expect(info.state).toBe('ready')
    })
  })
})

/**
 * 作者意见 #1：卡片上填的目录必须**下一次观察就生效**，不用重装或重启。
 *
 * 这条缝的全部价值在于"它是函数而不是字符串"——所以每条用例都改一次那个函数
 * 的返回值，再看 `info().path` 有没有跟着走。
 */
describe('createTuringSdk — a directory the user can change (作者意见 #1)', () => {
  const sdkShape = (base: string): string[] => [
    `${base}\\build\\Release\\turing_sdk.node`,
  ]

  it('picks up a newly typed directory without rebuilding the handle', async () => {
    let typed = ''
    const sdk = createTuringSdk({
      worker,
      now: () => clock,
      platform: 'win32',
      arch: 'x64',
      env: {},
      exists: path => sdkShape('D:\\typed').includes(path),
      dirSource: async () => typed,
    })
    // 还没填：发现链在注入的 exists 下什么也找不到 → missing。
    expect((await sdk.info()).state).toBe('missing')

    // 用户填了目录并保存 —— 句柄没变，只是那个函数开始返回新值。
    typed = 'D:\\typed'
    const after = await sdk.info()
    expect(after.state).toBe('ready')
    expect(after.path).toBe('D:\\typed')

    // 又清空了：回到发现链（这里仍然找不到）→ missing，而不是继续用旧目录。
    typed = ''
    expect((await sdk.info()).state).toBe('missing')
  })

  it('does not serve a cached probe result for a different directory', async () => {
    // probe 缓存按**解析结果**判有效，不是按时间：否则填了新目录还要等 10 秒
    // 才看见变化，而用户会以为保存失败了。
    let typed = 'D:\\one'
    const sdk = createTuringSdk({
      worker,
      now: () => clock,
      platform: 'win32',
      arch: 'x64',
      env: {},
      exists: path => [...sdkShape('D:\\one'), ...sdkShape('D:\\two')].includes(path),
      dirSource: async () => typed,
    })
    expect((await sdk.info()).path).toBe('D:\\one')
    typed = 'D:\\two'
    expect((await sdk.info()).path).toBe('D:\\two')
  })

  it('lets WORKBUDDY_TURING_SDK_DIR win over what the card holds', async () => {
    // 环境变量是排障旁路（doctor 只能读它），所以它压过卡片。反过来会让一个
    // 排障时设的变量在下一次点保存后静默失效。
    const sdk = createTuringSdk({
      worker,
      now: () => clock,
      platform: 'win32',
      arch: 'x64',
      env: { WORKBUDDY_TURING_SDK_DIR: 'E:\\from-env' },
      exists: path => [...sdkShape('E:\\from-env'), ...sdkShape('D:\\typed')].includes(path),
      dirSource: async () => 'D:\\typed',
    })
    expect((await sdk.info()).path).toBe('E:\\from-env')
  })

  it('still prefers an explicit dir over the card — that seam is for tests', async () => {
    const sdk = createTuringSdk({
      dir: 'D:\\explicit',
      worker,
      now: () => clock,
      platform: 'win32',
      arch: 'x64',
      env: {},
      exists: path => [...sdkShape('D:\\explicit'), ...sdkShape('D:\\typed')].includes(path),
      dirSource: async () => 'D:\\typed',
    })
    expect((await sdk.info()).path).toBe('D:\\explicit')
  })
})

describe('probe', () => {
  it('reports missing without spawning anything when the bundle is absent', async () => {
    const sdk = createTuringSdk({ dir: join(root, 'nope'), worker, now: () => clock })
    const info = await sdk.info()
    expect(info.state).toBe('missing')
    expect(info.reason).toContain('no installed WorkBuddy desktop SDK detected')
    // 没有 SDK 就**不该**起子进程：那是排障命令里最容易变成"卡三秒"的一段。
    expect(await readCalls()).toBe(0)
  })

  it('reports missing when there is no dir at all (discovery found nothing)', async () => {
    // `env: {}` 不是笔误：不传就会读真实 process.env，而这台机器上**可能**真的
    // 装着桌面端——那条安装链属于发现测试，不属于兜底行为测试。
    const sdk = createTuringSdk({ worker, now: () => clock, env: {}, home: root, platform: 'linux' })
    const info = await sdk.info()
    expect(info.state).toBe('missing')
    expect(info.path).toBe('')
    expect(info.reason).toContain('WORKBUDDY_TURING_SDK_DIR')
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

  it('backs off a ready SDK that keeps failing to produce a token', () => {
    // macOS 的真实形态：probe 永远 ready，token 永远超时（主队列没人排空）。
    // 头几次失败仍按 60 秒重试——可能是偶发抖动；到 strikes 次数就说明撞的是
    // 平台性死墙，降到和"这台机器没有 SDK"一样的 5 分钟节奏。
    expect(nextAutoRefreshDelayMs({
      nowMs: 0, ttlMs, sdkState: 'ready', fetchFailureCount: TURING_KEEP_ALIVE_TIMING.failureStrikes - 1,
    })).toBe(TURING_KEEP_ALIVE_TIMING.retryMs)
    expect(nextAutoRefreshDelayMs({
      nowMs: 0, ttlMs, sdkState: 'ready', fetchFailureCount: TURING_KEEP_ALIVE_TIMING.failureStrikes,
    })).toBe(TURING_KEEP_ALIVE_TIMING.unavailableMs)
    // 有了 token 之后这条分支不再参与：fetchedAtMs 的路径自己管自己。
    expect(nextAutoRefreshDelayMs({
      nowMs: 0, ttlMs, fetchedAtMs: 0, sdkState: 'ready', fetchFailureCount: 99,
    })).toBe(ttlMs - TURING_KEEP_ALIVE_TIMING.leadMs)
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
      /**
       * 等「这一枚真的换了」，而不是等「子进程又起来了」。
       *
       * 假 worker 在**启动时**就把 `calls` 加一，而 `fetchedAtMs` 要等子进程退出、
       * 父进程收下答案才更新——两者之间有几十毫秒的窗口。旧写法先等 `calls` 变大、
       * 再**立刻**比较时间戳，正好落在这个窗口里：约一半的跑法拿到的是上一个值，
       * 于是这条用例间歇性红（在作者的 26be06e 上 4/4 复现）。
       *
       * 把条件改成"时间戳确实前进了"，`vi.waitFor` 就会等到缓存真正更新为止——
       * 断言的仍然是同一件事，只是不再假设两个计数器同步。
       */
      await vi.waitFor(() => {
        expect(sdk.tokens.readout().fetchedAtMs).toBeGreaterThan(first ?? 0)
      }, { timeout: 10_000 })
      // 顺手确认那确实是又跑了一次子进程，而不是把时间戳改了个名字。
      expect(await readCalls()).toBeGreaterThan(callsAtFirst)
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
