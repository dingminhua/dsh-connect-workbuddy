/**
 * 卡片「SDK」分区的浏览器侧读写。
 *
 * 三个动作对应 Host 的三个入口：读状态（GET）、强制重取与取完整值（POST）。完整值
 * 单独一个动作，是因为它会进剪贴板、会被截图——默认只给掩码，看与复制各要一次
 * 显式操作。
 *
 * @module dsh-connect-workbuddy/client/device-sdk
 */

/** 设备头档位。 */
export type DeviceSdkTier = 'virtual' | 'real'

/** SDK 自身的加载状态（`probe` 的结论，不需要网络）。 */
export interface DeviceSdkInfo {
  state: 'ready' | 'unsupported' | 'missing' | 'error'
  /** `win32-x64` 之类。 */
  bundle: string
  path: string
  platform: string
  arch: string
  /** 子进程运行时。 */
  runtime: string
  reason?: string
}

/** 当前这枚 token 的状态。**不含值**，只有掩码与长度。 */
export interface DeviceSdkToken {
  state: 'ok' | 'stale' | 'unavailable' | 'idle'
  masked: string
  length: number
  fetchedAtMs?: number
  lastAttemptMs?: number
  reason?: string
}

/** What `GET /device-sdk` answers. */
export interface DeviceSdkReport {
  tier: DeviceSdkTier
  sdk: DeviceSdkInfo
  token: DeviceSdkToken
}

function normalize(body: unknown): DeviceSdkReport | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  const sdk = record['sdk']
  const token = record['token']
  if (typeof sdk !== 'object' || sdk === null || typeof token !== 'object' || token === null) return undefined
  const sdkRecord = sdk as Record<string, unknown>
  const tokenRecord = token as Record<string, unknown>
  const sdkState = sdkRecord['state']
  const tokenState = tokenRecord['state']
  return {
    tier: record['tier'] === 'real' ? 'real' : 'virtual',
    sdk: {
      state: sdkState === 'ready' || sdkState === 'unsupported' || sdkState === 'missing' || sdkState === 'error'
        ? sdkState
        : 'error',
      bundle: typeof sdkRecord['bundle'] === 'string' ? sdkRecord['bundle'] : '',
      path: typeof sdkRecord['path'] === 'string' ? sdkRecord['path'] : '',
      platform: typeof sdkRecord['platform'] === 'string' ? sdkRecord['platform'] : '',
      arch: typeof sdkRecord['arch'] === 'string' ? sdkRecord['arch'] : '',
      runtime: typeof sdkRecord['runtime'] === 'string' ? sdkRecord['runtime'] : '',
      ...typeof sdkRecord['reason'] === 'string' ? { reason: sdkRecord['reason'] } : {},
    },
    token: {
      state: tokenState === 'ok' || tokenState === 'stale' || tokenState === 'unavailable' || tokenState === 'idle'
        ? tokenState
        : 'unavailable',
      masked: typeof tokenRecord['masked'] === 'string' ? tokenRecord['masked'] : '',
      length: typeof tokenRecord['length'] === 'number' ? tokenRecord['length'] : 0,
      ...typeof tokenRecord['fetchedAtMs'] === 'number' ? { fetchedAtMs: tokenRecord['fetchedAtMs'] } : {},
      ...typeof tokenRecord['lastAttemptMs'] === 'number' ? { lastAttemptMs: tokenRecord['lastAttemptMs'] } : {},
      ...typeof tokenRecord['reason'] === 'string' ? { reason: tokenRecord['reason'] } : {},
    },
  }
}

/** 读状态。`undefined` = 这个 Host 没有这条路由（404/503），面板该整块隐藏。 */
export async function fetchDeviceSdk(path: string): Promise<DeviceSdkReport | undefined> {
  const response = await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
  if (response.status === 404 || response.status === 503) return undefined
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return normalize(await response.json())
}

async function post(path: string, action: 'refresh' | 'reveal'): Promise<unknown> {
  const response = await fetch(`${path}?action=${action}`, {
    method: 'POST',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  })
  // 409 是"现在没有可用 token"，不是故障：面板要显示"还没取到"而不是一条错误。
  if (response.status === 409) return undefined
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** 强制重取一次（会真的跑一次 SDK）。 */
export async function refreshDeviceSdk(path: string): Promise<DeviceSdkReport | undefined> {
  return normalize(await post(path, 'refresh'))
}

/** 取完整值。只在用户点「显示」或「复制」时调用。 */
export async function revealDeviceSdk(path: string): Promise<string | undefined> {
  const body = await post(path, 'reveal')
  if (typeof body !== 'object' || body === null) return undefined
  const token = (body as Record<string, unknown>)['token']
  return typeof token === 'string' && token !== '' ? token : undefined
}
