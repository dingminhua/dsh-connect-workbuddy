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

/** What the Host answers on `GET /device-profile`. */
export interface WorkBuddyDeviceSettings {
  mode: WorkBuddyDeviceMode
  accounts: Record<string, WorkBuddyDeviceProfile>
}

/** 取不到设置时的答案：虚拟档、无覆盖。与 Host 的默认值一致。 */
export const EMPTY_DEVICE_SETTINGS: WorkBuddyDeviceSettings = { mode: 'virtual', accounts: {} }

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
  const body = await response.json() as Partial<WorkBuddyDeviceSettings>
  return {
    mode: body.mode === 'real' ? 'real' : 'virtual',
    accounts: typeof body.accounts === 'object' && body.accounts !== null ? body.accounts : {},
  }
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
  const document = await response.json() as Partial<WorkBuddyDeviceSettings>
  return {
    mode: document.mode === 'real' ? 'real' : 'virtual',
    accounts: typeof document.accounts === 'object' && document.accounts !== null ? document.accounts : {},
  }
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
