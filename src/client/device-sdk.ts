/**
 * 卡片「SDK」分区的浏览器侧读写。
 *
 * 三个动作对应 Host 的三个入口：读状态（GET）、强制重取与取完整值（POST）。完整值
 * 单独一个动作，是因为它会进剪贴板、会被截图——默认只给掩码，看与复制各要一次
 * 显式操作。
 *
 * 响应形状**不在这里另写一份**：那是同一个协议的两份定义，改一边忘一边就会让浏览器
 * 静默读错字段。类型取自 Host 的实现模块（`import type`，构建时擦除，不会把
 * `node:fs` 带进浏览器包）。
 *
 * 但**校验要留**：`normalize` 不是重复劳动，它是这块面板的兜底。宿主版本对不上、
 * 或响应只到一半时，它把缺字段折成 `undefined` 让面板显示"不可用"，而不是让
 * `report.sdk.state` 抛错、把整个卡片交给错误边界。
 *
 * @module dsh-connect-workbuddy/client/device-sdk
 */

import type { TuringSdkInfo, TuringTokenReadout, WorkBuddyDeviceSdkReport } from '../turing-sdk.ts'

/** `GET /device-sdk` 的答案：Host 快照 + 总开关的当前值。 */
export type DeviceSdkReport = WorkBuddyDeviceSdkReport & {
  /** 缺席 = 这个 Host 没有 settings 服务，卡片据此把开关标成不可用。 */
  sdkEnabled?: boolean
}

/** 校验并折成 Host 的类型；形状不认识时返回 `undefined`，面板据此显示"不可用"。 */
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
  const info: TuringSdkInfo = {
    state: sdkState === 'ready' || sdkState === 'unsupported' || sdkState === 'missing'
      || sdkState === 'error' || sdkState === 'disabled'
      ? sdkState
      : 'error',
    bundle: typeof sdkRecord['bundle'] === 'string' ? sdkRecord['bundle'] : '',
    path: typeof sdkRecord['path'] === 'string' ? sdkRecord['path'] : '',
    platform: typeof sdkRecord['platform'] === 'string' ? sdkRecord['platform'] : '',
    arch: typeof sdkRecord['arch'] === 'string' ? sdkRecord['arch'] : '',
    runtime: typeof sdkRecord['runtime'] === 'string' ? sdkRecord['runtime'] : '',
    ...typeof sdkRecord['reason'] === 'string' ? { reason: sdkRecord['reason'] } : {},
  }
  const readout: TuringTokenReadout = {
    state: tokenState === 'ok' || tokenState === 'stale' || tokenState === 'unavailable' || tokenState === 'idle'
      ? tokenState
      : 'unavailable',
    masked: typeof tokenRecord['masked'] === 'string' ? tokenRecord['masked'] : '',
    length: typeof tokenRecord['length'] === 'number' ? tokenRecord['length'] : 0,
    ...typeof tokenRecord['fetchedAtMs'] === 'number' ? { fetchedAtMs: tokenRecord['fetchedAtMs'] } : {},
    ...typeof tokenRecord['lastAttemptMs'] === 'number' ? { lastAttemptMs: tokenRecord['lastAttemptMs'] } : {},
    ...typeof tokenRecord['reason'] === 'string' ? { reason: tokenRecord['reason'] } : {},
  }
  return {
    tier: record['tier'] === 'real' ? 'real' : 'virtual',
    sdk: info,
    token: readout,
    // 只在宿主真的答了布尔时才带上：没有 settings 服务的宿主不该被画成"关"。
    ...typeof record['sdkEnabled'] === 'boolean' ? { sdkEnabled: record['sdkEnabled'] } : {},
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

/**
 * 写 SDK 总开关（`Config.deviceSdkEnabled`）。
 *
 * 501 = 这个宿主没有 settings 写入路径。抛出去而不是静默吞掉：卡片要把开关置灰，
 * 而那需要知道"做不到"，不是"做失败了"。
 */
export async function setDeviceSdkEnabled(path: string, enabled: boolean): Promise<void> {
  const response = await fetch(`${path}?action=${enabled ? 'enable' : 'disable'}`, {
    method: 'POST',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  })
  if (response.status === 501) throw new Error('this host has no settings write path')
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
}

/** 取完整值。只在用户点「显示」或「复制」时调用。 */
export async function revealDeviceSdk(path: string): Promise<string | undefined> {
  const body = await post(path, 'reveal')
  if (typeof body !== 'object' || body === null) return undefined
  const token = (body as Record<string, unknown>)['token']
  return typeof token === 'string' && token !== '' ? token : undefined
}
