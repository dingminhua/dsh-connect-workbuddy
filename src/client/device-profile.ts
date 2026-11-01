/**
 * 设备头设置在浏览器侧的读写（「虚拟值 / 真实值」+ 每账号覆盖参数）。
 *
 * 这一层只做三件事：把 Host 的文档取回来、把改动写回去、以及给弹窗的
 * 「一键随机」造一个形状正确的 id。**它不做任何本地持久化**——设置的真源在
 * Host 的 `$DSH_HOME/.workbuddy-device-profiles.json`，浏览器内存里存一份副本
 * 只为了让弹窗有内容可编辑。
 *
 * @module dsh-connect-workbuddy/client/device-profile
 */

/** 设备头档位。「真实值」目前只是占位（P3），不改变出站字节。 */
export type WorkBuddyDeviceMode = 'virtual' | 'real'

/** 一个账号的覆盖值；空字段表示"这一项仍然派生"。 */
export interface WorkBuddyDeviceProfile {
  machineId?: string
  sessionId?: string
}

/** 一个账号留空时真正会发出去的那一对 id（Host 用本机盐 + uid 算好送过来）。 */
export interface WorkBuddyDeviceDerived {
  machineId: string
  sessionId: string
}

/** What the Host answers on `GET /device-profile`. */
export interface WorkBuddyDeviceSettings {
  /**
   * 设备身份总开关（用户意见）。关 = 一个设备头都不发、后台不刷新、`doctor`
   * 不探测；档位与每账号覆盖仍然记着，重新打开时不会丢。
   *
   * 缺字段 = **关**：与 Host 的默认值一致（这是用户自己的机器的对外身份，
   * 默认不发；要用的人打开一次）。
   */
  enabled: boolean
  mode: WorkBuddyDeviceMode
  accounts: Record<string, WorkBuddyDeviceProfile>
  /**
   * accountId → 派生值。缺席 = Host 这次没算（旧版本、或盐不可用），
   * 于是弹窗不能声称"留空会得到某个值"。
   */
  derived?: Record<string, WorkBuddyDeviceDerived>
  /** 手填的 SDK 目录；空串 = 走自动发现链。 */
  sdkDir: string
  /** 真实值档取不到 token 时退回虚拟值（默认开）。 */
  sdkFallbackToVirtual: boolean
}

/** 取不到设置时的答案：**关着**、虚拟档、无覆盖、回退开、无手填目录。与 Host 一致。 */
export const EMPTY_DEVICE_SETTINGS: WorkBuddyDeviceSettings = {
  enabled: false,
  mode: 'virtual',
  accounts: {},
  sdkDir: '',
  sdkFallbackToVirtual: true,
}

/** 与 Host 侧同一条规则：36 个小写十六进制字符。 */
const DEVICE_ID_PATTERN = /^[0-9a-f]{36}$/u

/** Whether `value` is a well-formed device id (as the Host will accept it). */
export function isDeviceId(value: string): boolean {
  return DEVICE_ID_PATTERN.test(value)
}

/**
 * 造一个 36 字符的小写十六进制 id（「一键随机」用的就是它）。
 *
 * 用 `crypto.getRandomValues` 而不是 `Math.random`：随机值会被当成设备身份发出去，
 * 一个可预测的序列不是"随机"，而是"两台机器撞在一起"。18 字节与派生值的熵一致。
 */
export function randomDeviceId(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Normalize one Host answer. Shared by the GET and the POST: two copies of this
 * coercion is how the two answers start disagreeing.
 *
 * 派生值逐条校验形状：它是画在输入框正下方的 36 位串，混进一个 undefined 会
 * 直接渲染成 "undefined"，比不显示更糟。Host 与本页面同源，这里不做安全意义上的
 * 校验，只是不让半截数据变成可见的胡说。
 */
function normalizeSettings(body: Partial<WorkBuddyDeviceSettings>): WorkBuddyDeviceSettings {
  const accounts = typeof body.accounts === 'object' && body.accounts !== null ? body.accounts : {}
  const derived: Record<string, WorkBuddyDeviceDerived> = {}
  if (typeof body.derived === 'object' && body.derived !== null) {
    for (const [accountId, entry] of Object.entries(body.derived)) {
      const machineId = entry?.machineId
      const sessionId = entry?.sessionId
      if (typeof machineId !== 'string' || typeof sessionId !== 'string') continue
      if (!isDeviceId(machineId) || !isDeviceId(sessionId)) continue
      derived[accountId] = { machineId, sessionId }
    }
  }
  return {
    // 只有显式 true 才开：与 Host 一致。缺字段在这里有两种来源——旧 Host（不认识
    // 这一项，那时默认是发设备头的）与"用户没开过"，而这两种都不构成授权。
    enabled: body.enabled === true,
    mode: body.mode === 'real' ? 'real' : 'virtual',
    accounts,
    ...body.derived === undefined ? {} : { derived },
    sdkDir: typeof body.sdkDir === 'string' ? body.sdkDir : '',
    // 缺字段 = 回退开：与 Host 的默认值一致，也与「这个 Host 还不认识这一项」一致。
    sdkFallbackToVirtual: body.sdkFallbackToVirtual !== false,
  }
}

/**
 * GET the current settings.
 *
 * `undefined` means "this Host has no such route" (404/503) — a different answer
 * from "the Host has one and it says virtual/empty". The card uses that to HIDE
 * the toggle and the row gears instead of rendering controls that cannot work;
 * `EMPTY_DEVICE_SETTINGS` is only the initial value before the first read.
 */
export async function fetchDeviceSettings(path: string): Promise<WorkBuddyDeviceSettings | undefined> {
  const response = await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
  if (response.status === 404 || response.status === 503) return undefined
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return normalizeSettings(await response.json() as Partial<WorkBuddyDeviceSettings>)
}

/** POST one mutation and return the settings the Host now holds. */
async function post(path: string, body: unknown): Promise<WorkBuddyDeviceSettings> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return normalizeSettings(await response.json() as Partial<WorkBuddyDeviceSettings>)
}

/**
 * Switch the whole feature on or off (用户意见).
 *
 * 与档位分开写：关掉再打开要回到原来那一档，一个 enum 做不到这件事。
 */
export function putDeviceEnabled(path: string, enabled: boolean): Promise<WorkBuddyDeviceSettings> {
  return post(path, { kind: 'enabled', enabled })
}

/** Switch the tier. 「真实值」is remembered but changes no outbound byte until P3. */
export function putDeviceMode(path: string, mode: WorkBuddyDeviceMode): Promise<WorkBuddyDeviceSettings> {
  return post(path, { kind: 'mode', mode })
}

/**
 * Save one account's overrides.
 *
 * `''` clears a field (back to the derived value) and `undefined` leaves it alone —
 * that distinction is why the dialog sends only the fields the user touched.
 */
export function putDeviceProfile(
  path: string,
  accountId: string,
  values: { machineId?: string, sessionId?: string },
): Promise<WorkBuddyDeviceSettings> {
  return post(path, { kind: 'account', accountId, ...values })
}

/**
 * Save the SDK directory and/or the fallback switch (作者意见 #1 / #2).
 *
 * `undefined` leaves a field alone, exactly like {@link putDeviceProfile}: the
 * panel has two independent controls, and saving one must not write the other
 * back to a stale value. `sdkDir: ''` clears the override and returns to
 * automatic discovery — a different intent from "leave it alone".
 */
export function putDeviceSdk(
  path: string,
  values: { sdkDir?: string, sdkFallbackToVirtual?: boolean },
): Promise<WorkBuddyDeviceSettings> {
  return post(path, { kind: 'sdk', ...values })
}
