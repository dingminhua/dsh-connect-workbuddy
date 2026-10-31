/**
 * 真实设备参数：内置 Turing Shield SDK 的 Windows 取链（P3）。
 *
 * ## 它补的是哪一格
 *
 * 「虚拟值」档的设备对（`X-Machine-ID` / `X-Session-ID`）是算出来的：稳定、按号
 * 隔离，但**任何一台机器都能算出同样的形状**。「真实值」档要的是这台机器上
 * 真的装着的那套东西——由 SDK 向风控服务换回的 `X-Device-Token`。两者互斥，不能
 * 叠加：真 token 内含设备信息，旁边再挂一对伪造 id 等于自证不一致。
 *
 * ## 为什么要子进程
 *
 * SDK 是原生插件（N-API），加载它会绑定宿主进程：一次 ABI/缺 DLL/被替换的失败
 * 就是插件进程的失败，而不是"设备头不可用"；它的 Promise 没有 cancel，一次超时
 * 会把句柄留在进程里。子进程把这两件事都降级成"这一条命令失败"，父进程杀掉它
 * 就是干净的收场。代价是每次冷启动多一次进程创建（本机实测 ~6 ms）。
 *
 * ## 缓存策略
 *
 * token 是分钟级的东西、进程是小时级的，所以**绝不能只取一次**。内存 TTL 10 分钟，
 * 失败时回落到 24 小时内的旧值并标记 `stale`（设备 token 的有效期远长于它的
 * 刷新周期）。**不落盘**：多一份 secret 文件换来的只是省掉一次 100 ms 的取数，
 * 不划算——这与 P2 的文件源是两种东西，那个读的是别人写的文件。
 *
 * ## 从不打印 token
 *
 * 这个模块的任何日志、任何返回给浏览器的状态里都只有掩码与长度。完整值只经
 * {@link TuringTokenSource.reveal} 在用户显式点击时给一次。
 *
 * @module dsh-connect-workbuddy/turing-sdk
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkBuddyDeviceMode } from './device-profile.ts'

/** 允许指向别的 SDK 副本（自建、或桌面端安装目录）。 */
export const TURING_SDK_DIR_ENV = 'WORKBUDDY_TURING_SDK_DIR'

/** 风控 channelId；与桌面端 `product.json` 的 `turingSdk.channelId` 一致。 */
export const TURING_CHANNEL_ID_ENV = 'WORKBUDDY_TURING_CHANNEL_ID'

/** 产品名。 */
export const TURING_PRODUCT_NAME_ENV = 'WORKBUDDY_TURING_PRODUCT_NAME'

/** 产品版本；默认跟 {@link import('./upstream.ts').APP_VERSION} 同源，见 `createTuringSdk` 的 `version`。 */
export const TURING_PRODUCT_VERSION_ENV = 'WORKBUDDY_TURING_PRODUCT_VERSION'

/** 默认 token 有效期（重取周期）。与 SDK 侧风险消息的缓存窗口同一量级。 */
export const TURING_TOKEN_TTL_MS = 10 * 60 * 1000

/** 取不到新 token 时，旧值最多还能用多久。设备 token 本身长期有效。 */
const TURING_TOKEN_STALE_MS = 24 * 60 * 60 * 1000

/** 子进程的总预算。SDK 在本机实测 ~110 ms；给到 20 s 是为了覆盖冷启动与 DNS 慢。 */
const RUN_TIMEOUT_MS = 20_000

/** `probe` 的缓存时长：SDK 在进程生命周期内不会变，但 DLL 可能被外部替换。 */
const PROBE_CACHE_MS = 60_000

/**
 * 取数失败后的退避窗口。
 *
 * 这不是性能优化，是正确性：一次对话会并发打出十几条请求，如果每次失败都重试，
 * 一个 SDK 故障会变成"每轮十几个子进程 + 十几个 20 秒超时"。退避期间直接返回上一枚
 * 可用值（没有就返回 `undefined`），而**手动「重新获取」绕过它**——用户点那个按钮，
 * 就是要求现在再试一次。
 */
const RETRY_BACKOFF_MS = 30_000

/** 内置副本的目录名，按 `platform-arch` 分。目前只有 Windows。 */
export function bundledSdkBundleId(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`
}

/**
 * 内置 SDK 的根目录。
 *
 * `import.meta.url` 指向 `lib/index.js`（构建产物）或 `src/turing-sdk.ts`（开发与
 * 测试），两者都在包根下一层，所以 `../native/...` 在两种形态下都成立——这是
 * 不用 `process.cwd()` 的原因：cwd 是调用者的，不是插件的。
 */
export function bundledSdkRoot(): string {
  return fileURLToPath(new URL('../native/turing-sdk', import.meta.url))
}

/** 子进程脚本；与 `index.cjs` 分开放，这样每个平台的副本都保持原样不动。 */
function workerPath(): string {
  return join(bundledSdkRoot(), 'worker.cjs')
}

/** What one `probe` established about the SDK on THIS machine. */
export interface TuringSdkInfo {
  /** `ready` = 能加载且自称支持；`unsupported` = 平台不支持；`missing` = 没有内置副本；`error` = 加载失败。 */
  state: 'ready' | 'unsupported' | 'missing' | 'error'
  /** `win32-x64` 之类；空字符串表示这个平台没有内置副本。 */
  bundle: string
  /** 内置副本（或被 `WORKBUDDY_TURING_SDK_DIR` 指向的目录）的绝对路径。 */
  path: string
  platform: string
  arch: string
  /** 子进程用的运行时版本，例如 `22.22.2` 或 `electron 30.0.0`。 */
  runtime: string
  /** 仅在非 `ready` 时出现；面向排障，不含任何 secret。 */
  reason?: string
}

/** The token as the card sees it: never the value itself. */
export interface TuringTokenReadout {
  /** `ok` = 新鲜；`stale` = 取不到新的、还在宽限期内；`unavailable` = 没有可用的值。 */
  state: 'ok' | 'stale' | 'unavailable' | 'idle'
  /** 掩码，可以直接进 UI。 */
  masked: string
  /** token 的字符数（0 表示没有）。长度本身不是秘密，且是判断"拿对了没有"的唯一线索。 */
  length: number
  /** 这一枚 token 是什么时候取到的。 */
  fetchedAtMs?: number
  /** 上一次**尝试**的时间，成功失败都记——"刚试过但失败了"与"还没试过"必须能分开。 */
  lastAttemptMs?: number
  /** `stale` / `unavailable` 的原因，结构化短语，不含 secret。 */
  reason?: string
}

/** 掩码：保住 scheme 前缀，其余一律星号。`v3:` 是 SDK 的格式标记，不是内容。 */
export function maskToken(token: string): string {
  if (token === '') return ''
  const colon = token.indexOf(':')
  const prefix = colon > 0 && colon <= 8 ? token.slice(0, colon + 1) : ''
  return `${prefix}${'*'.repeat(16)}`
}

/** One parsed worker answer. */
interface WorkerAnswer {
  ok?: boolean
  reason?: string
  message?: string
  token?: string
  supported?: boolean
  node?: string
  platform?: string
  arch?: string
  sdkDir?: string
  loadError?: string | null
  ms?: number
}

/**
 * Run the worker once.
 *
 * `env` 只带 SDK 需要的白名单，不整份继承：父进程环境里有插件的凭据与用户配置，
 * 一个只需要网络和系统 DLL 的子进程没有理由看到它们。
 */
function runWorker(mode: 'probe' | 'token', options: {
  dir: string
  worker: string
  channelId: string
  productName: string
  productVersion: string
  timeoutMs?: number
}): Promise<WorkerAnswer> {
  return new Promise<WorkerAnswer>((resolve) => {
    const runtime = process.execPath
    const env: NodeJS.ProcessEnv = {
      TURING_SDK_DIR: options.dir,
      TURING_CHANNEL_ID: options.channelId,
      TURING_PRODUCT_NAME: options.productName,
      TURING_PRODUCT_VERSION: options.productVersion,
      TURING_TIMEOUT_MS: String(options.timeoutMs ?? RUN_TIMEOUT_MS - 2000),
    }
    for (const name of [
      'PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'HOME',
      'LOCALAPPDATA', 'APPDATA', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
      'LANG', 'LC_ALL',
    ]) {
      const value = process.env[name]
      if (value !== undefined) env[name] = value
    }
    // Electron 的 `process.execPath` 是 App 本体，直接跑会把参数当 URL 打开；
    // 这个开关让它退化成普通的 Node。普通 Node 下设置它无害。
    if (process.versions.electron !== undefined) env['ELECTRON_RUN_AS_NODE'] = '1'

    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (answer: WorkerAnswer): void => {
      if (settled) return
      settled = true
      clearTimeout(killer)
      resolve(answer)
    }
    const child = spawn(runtime, [options.worker, mode], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const killer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ ok: false, reason: 'timeout', message: `worker did not answer within ${options.timeoutMs ?? RUN_TIMEOUT_MS}ms` })
    }, options.timeoutMs ?? RUN_TIMEOUT_MS)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      // 只留最后几行：SDK 可能刷初始化日志，而我们要的是错误摘要。
      stderr = `${stderr}${chunk}`.split('\n').slice(-4).join('\n')
    })
    child.on('error', error => {
      settle({ ok: false, reason: 'spawn-failed', message: error.message })
    })
    child.on('close', (code: number | null) => {
      const line = stdout.trim().split('\n').filter(Boolean).at(-1)
      if (line === undefined) {
        settle({ ok: false, reason: 'no-output', message: stderr.trim() || `worker exited with code ${String(code)}` })
        return
      }
      try {
        settle(JSON.parse(line) as WorkerAnswer)
      } catch {
        settle({ ok: false, reason: 'bad-output', message: stderr.trim() || 'worker printed no JSON' })
      }
    })
  })
}

/** The token source the request path and the card share. */
export interface TuringTokenSource {
  /** 当前可用的 token；取不到就是 `undefined`（**不会**退回派生值，那是另一档）。 */
  current(): Promise<string | undefined>
  /** Force a refetch; returns the readout afterwards. */
  refresh(): Promise<TuringTokenReadout>
  /** The masked snapshot, safe to render and to log. */
  readout(): TuringTokenReadout
  /** 用户显式点击后才给的一次完整值。 */
  reveal(): Promise<string | undefined>
}

/** What `doctors`-style callers get without touching a token. */
export interface TuringSdk {
  info(): Promise<TuringSdkInfo>
  tokens: TuringTokenSource
}

/**
 * 卡片「SDK」分区读到的那一份快照。
 *
 * `tier` 与 `token` 必须在同一份对象里：分开取会让界面出现"档位已切换、状态还是
 * 上一档"的中间态，而这两个值恰好是用户用来判断"我现在到底发的是什么"的。
 */
export interface WorkBuddyDeviceSdkReport {
  tier: WorkBuddyDeviceMode
  sdk: TuringSdkInfo
  token: TuringTokenReadout
}

/** Host → 卡片路由的端口。 */
export interface WorkBuddyDeviceSdkPort {
  read(): Promise<WorkBuddyDeviceSdkReport>
  refresh(): Promise<WorkBuddyDeviceSdkReport>
  /** 完整 token；没有可用值时为 `undefined`。只在显式点击后调用。 */
  reveal(): Promise<string | undefined>
}

/**
 * Wire a {@link TuringSdk} into the card.
 *
 * `mode` 从设备设置读，不缓存：用户刚切换的那一下必须立刻反映到面板上。
 */
export function createDeviceSdkPort(options: {
  sdk: TuringSdk
  mode: () => Promise<WorkBuddyDeviceMode>
}): WorkBuddyDeviceSdkPort {
  const snap = async (): Promise<WorkBuddyDeviceSdkReport> => ({
    tier: await options.mode(),
    sdk: await options.sdk.info(),
    token: options.sdk.tokens.readout(),
  })
  return {
    read: snap,
    async refresh(): Promise<WorkBuddyDeviceSdkReport> {
      await options.sdk.tokens.refresh()
      return snap()
    },
    reveal: () => options.sdk.tokens.reveal(),
  }
}

/**
 * Build the SDK handle.
 *
 * `version` 默认取插件自称的应用版本（与 `User-Agent` 同源），因为它就是这台机器
 * 上那个客户端报给上游的版本；`channelId` 与产品名跟桌面端 `product.json` 一致。
 */
export function createTuringSdk(options: {
  dir?: string
  channelId?: string
  productName?: string
  productVersion?: string
  ttlMs?: number
  now?: () => number
  /**
   * 子进程脚本的路径。**只为测试存在**：真实调用永远用内置的那个，而这个参数
   * 让"缓存 / 重取 / 宽限期"这三条逻辑可以在不连 SDK、不发网络请求的前提下被
   * 逐条验证——否则它们只能靠线上观察。
   */
  worker?: string
} = {}): TuringSdk {
  const now = options.now ?? (() => Date.now())
  const worker = options.worker ?? workerPath()
  const ttlMs = options.ttlMs ?? TURING_TOKEN_TTL_MS
  const bundle = bundledSdkBundleId()
  const configuredDir = options.dir ?? process.env[TURING_SDK_DIR_ENV]
  const dir = configuredDir !== undefined && configuredDir.trim() !== ''
    ? configuredDir.trim()
    : join(bundledSdkRoot(), bundle)
  const channelId = options.channelId ?? process.env[TURING_CHANNEL_ID_ENV] ?? '109144'
  const productName = options.productName ?? process.env[TURING_PRODUCT_NAME_ENV] ?? 'WorkBuddy'
  const productVersion = options.productVersion ?? process.env[TURING_PRODUCT_VERSION_ENV] ?? '5.8.3'

  let probeCache: { at: number, info: TuringSdkInfo } | undefined
  let cached: { token: string, fetchedAtMs: number } | undefined
  let lastAttemptMs: number | undefined
  let lastFailure: string | undefined
  /** 最近一次失败的时刻；退避窗口由它算。 */
  let lastFailureAtMs: number | undefined
  let inFlight: Promise<string | undefined> | undefined

  const runtimeLabel = process.versions.electron === undefined
    ? process.version.replace(/^v/u, '')
    : `electron ${process.versions.electron}`

  const missingInfo = (path: string): TuringSdkInfo => {
    const present = existsSync(path)
    return {
      state: present ? 'error' : 'missing',
      bundle,
      path,
      platform: process.platform,
      arch: process.arch,
      runtime: runtimeLabel,
      reason: present
        ? 'SDK directory exists but the native binding was not found'
        : `no bundled SDK for ${bundle}`,
    }
  }

  async function probe(): Promise<TuringSdkInfo> {
    const at = now()
    if (probeCache !== undefined && at - probeCache.at < PROBE_CACHE_MS) return probeCache.info
    let info: TuringSdkInfo
    if (!existsSync(join(dir, 'build', 'Release'))) {
      // 目录都不在：不值得起一个进程。`missing` 与 `error` 分开，是因为前者是
      // "这个平台我们没有内置副本"（用户无能为力），后者是"有但坏了"（可修）。
      info = missingInfo(dir)
    } else {
      const answer = await runWorker('probe', { dir, worker, channelId, productName, productVersion, timeoutMs: 15_000 })
      const supported = answer.ok === true && answer.supported === true
      info = {
        state: supported ? 'ready' : answer.ok === true ? 'unsupported' : 'error',
        bundle,
        path: dir,
        platform: process.platform,
        arch: process.arch,
        runtime: answer.node ?? runtimeLabel,
        ...supported ? {} : { reason: answer.loadError ?? answer.message ?? answer.reason ?? 'sdk reported unsupported' },
      }
    }
    probeCache = { at, info }
    return info
  }

  function readout(): TuringTokenReadout {
    const at = now()
    if (cached === undefined) {
      return {
        state: 'idle',
        masked: '',
        length: 0,
        ...lastAttemptMs === undefined ? {} : { lastAttemptMs },
        ...lastFailure === undefined ? {} : { reason: lastFailure },
      }
    }
    const ageMs = at - cached.fetchedAtMs
    const expired = ageMs > ttlMs
    const tooOld = ageMs > TURING_TOKEN_STALE_MS
    // 「上一枚还新鲜」不等于「一切正常」：如果最近一次尝试（晚于这枚 token 的取数
    // 时间）失败了，用户刚点过重取却没成功——那必须显示成 stale，而不是一个和平
    // 时无异的 ok。
    const failedSinceFetch = lastFailure !== undefined
      && lastAttemptMs !== undefined
      && lastAttemptMs >= cached.fetchedAtMs
    return {
      state: tooOld ? 'unavailable' : expired || failedSinceFetch ? 'stale' : 'ok',
      masked: maskToken(cached.token),
      length: cached.token.length,
      fetchedAtMs: cached.fetchedAtMs,
      ...lastAttemptMs === undefined ? {} : { lastAttemptMs },
      ...expired || failedSinceFetch ? { reason: lastFailure ?? `older than ${Math.round(ttlMs / 60_000)}m` } : {},
    }
  }

  async function fetchOnce(): Promise<string | undefined> {
    lastAttemptMs = now()
    const info = await probe()
    if (info.state !== 'ready') {
      lastFailure = info.reason ?? `sdk is ${info.state}`
      lastFailureAtMs = lastAttemptMs
      return undefined
    }
    const answer = await runWorker('token', { dir, worker, channelId, productName, productVersion })
    const token = typeof answer.token === 'string' ? answer.token.trim() : ''
    if (answer.ok !== true || token === '') {
      lastFailure = answer.message ?? answer.reason ?? 'sdk returned no token'
      lastFailureAtMs = lastAttemptMs
      return undefined
    }
    cached = { token, fetchedAtMs: now() }
    lastFailure = undefined
    lastFailureAtMs = undefined
    return token
  }

  async function current(): Promise<string | undefined> {
    const at = now()
    if (cached !== undefined && at - cached.fetchedAtMs <= ttlMs) return cached.token
    // 退避：刚失败过就先别再造一个子进程。一轮对话十几条请求同时到，没有这一步，
    // 一次 SDK 故障会变成十几个子进程 + 十几个超时。
    if (lastFailureAtMs !== undefined && at - lastFailureAtMs < RETRY_BACKOFF_MS) {
      return cached !== undefined && at - cached.fetchedAtMs <= TURING_TOKEN_STALE_MS ? cached.token : undefined
    }
    // 单飞：12 个构头调用点可能同时到，一次冷启动只需要一个子进程。
    if (inFlight !== undefined) return inFlight
    inFlight = fetchOnce().finally(() => { inFlight = undefined })
    const token = await inFlight
    if (token !== undefined) return token
    // 失败兜底：宽限期内的旧值仍然可用（设备 token 长期有效），但状态会变 stale，
    // 界面能看出"这是旧的"。
    if (cached !== undefined && now() - cached.fetchedAtMs <= TURING_TOKEN_STALE_MS) return cached.token
    return undefined
  }

  return {
    info: probe,
    tokens: {
      current,
      readout,
      reveal: current,
      /**
       * Force a refetch — but **keep** whatever is cached until the new value
       * arrives. 清空再取会让"手动刷新失败"顺手抹掉一枚还在宽限期内可用的
       * token，那正好是用户点刷新想避免的结果。
       */
      async refresh(): Promise<TuringTokenReadout> {
        if (inFlight !== undefined) return inFlight.then(() => readout())
        inFlight = fetchOnce().finally(() => { inFlight = undefined })
        await inFlight
        return readout()
      },
    },
  }
}
